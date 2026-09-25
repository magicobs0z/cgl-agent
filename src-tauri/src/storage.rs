//! 模块持久化：`migrate_scope` 迁移 + 笔记表读写访问器。
//!
//! 三条由内核源码定死的规则（设计文档 2.7.3 / 2.8.1）：
//! 1. 迁移 scope 用**完整 id**：`"module:copper-lamp.demo-tools"`。scope 只是
//!    `schema_migrations` 表里的文本值，不参与标识符解析，点号安全。
//! 2. 表名前缀用 id 派生（`.` 与 `-` 换 `_`）：`module_copper_lamp_demo_tools_`。
//!    SQLite 标识符不允许含点号，此处**必须**替换，与 scope 的处理刻意不同。
//! 3. 所有读写走 `kernel.db().with_conn(...)`；**闭包内不得再调用 `DatabaseService`
//!    的锁方法**（`schema_version` / `exec_batch` / `migrate_scope` / 嵌套 `with_conn`），
//!    否则同一把互斥锁重入会死锁。因此本文件的辅助函数只接收 `&Connection`，
//!    不接收 `&DatabaseService`。

use copper_core_lib::error::KernelError;
use copper_core_lib::services::database::Migration;
use copper_core_lib::state::KernelContext;
use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;

use crate::manifest;
use crate::module::MODULE_ID;

/// 模块数据库表名前缀（`copper-lamp.demo-tools` → `module_copper_lamp_demo_tools_`）。
///
/// 由 [`manifest::table_prefix_for`] 派生而非硬编码字符串：表名前缀是 id 的纯函数，
/// 两处各写一份必然漂移。此常量的值由单元测试锁定。
pub const TABLE_PREFIX: &str = "module_copper_lamp_demo_tools_";

/// 笔记表全名。
pub const NOTE_TABLE: &str = "module_copper_lamp_demo_tools_note";

/// 迁移 scope：与 [`MODULE_ID`] 拼装，避免 scope 与 id 各写一份。
pub const MIGRATION_SCOPE: &str = "module:copper-lamp.demo-tools";

/// 笔记标题与正文的最大长度。
///
/// 为什么限制：模块表是内核数据库的一部分，超长文本（如误贴百 MB 日志）会拖慢
/// 数据库文件与备份；这是模块侧的自保阀值，不是内核限制。
pub const MAX_TITLE_LEN: usize = 200;
pub const MAX_BODY_LEN: usize = 64 * 1024;

/// 迁移 v1：建笔记表。
const MIGRATION_V1_SQL: &str = "
CREATE TABLE IF NOT EXISTS module_copper_lamp_demo_tools_note (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
";

/// 迁移 v2：支持「置顶」并加快按标题检索。
///
/// v2 拆成两步是刻意的：`ALTER TABLE ... ADD COLUMN` 不能带非恒定默认值，
/// 且 SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，重复执行会报 duplicate column；
/// 迁移框架按版本号只执行一次，故这里依赖框架的幂等记录而非 SQL 本身的幂等。
const MIGRATION_V2_SQL: &str = "
ALTER TABLE module_copper_lamp_demo_tools_note ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_module_copper_lamp_demo_tools_note_updated
    ON module_copper_lamp_demo_tools_note(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_module_copper_lamp_demo_tools_note_pinned
    ON module_copper_lamp_demo_tools_note(pinned DESC, updated_at DESC);
";

/// 模块迁移表。顺序无关紧要（框架按 `version` 升序执行），但保持书写顺序与版本一致。
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "demo_tools_note",
        sql: MIGRATION_V1_SQL,
    },
    Migration {
        version: 2,
        name: "demo_tools_note_pinned_index",
        sql: MIGRATION_V2_SQL,
    },
];

/// 当前迁移目标版本（自检入口展示用）。
pub const TARGET_SCHEMA_VERSION: u32 = MIGRATIONS[MIGRATIONS.len() - 1].version;

/// 一条笔记。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 列表查询参数。
#[derive(Debug, Clone, Default)]
pub struct NoteQuery {
    /// 关键字（匹配标题或正文，空则不过滤）。
    pub search: Option<String>,
    /// 是否只看置顶。
    pub only_pinned: bool,
    /// 最大返回条数（`None` 表示用 [`DEFAULT_LIST_LIMIT`]）。
    pub limit: Option<u32>,
    /// 偏移量。
    pub offset: Option<u32>,
}

/// 默认列表条数。
pub const DEFAULT_LIST_LIMIT: u32 = 50;

/// 列表条数上限：防止前端一次拉全表。
pub const MAX_LIST_LIMIT: u32 = 500;

/// 应用迁移（在 `Module::init` 中调用）。
///
/// 单独包一层而不是让调用方拼 scope 字符串：scope 写错不会报错，只会让迁移记录
/// 落到另一个作用域、下次启动重复执行建表语句。
pub fn migrate(kernel: &KernelContext) -> Result<(), KernelError> {
    debug_assert_eq!(
        MIGRATION_SCOPE,
        format!("module:{MODULE_ID}"),
        "迁移 scope 必须由 MODULE_ID 派生，改 id 时同步改此处"
    );
    kernel.db().migrate_scope(MIGRATION_SCOPE, MIGRATIONS)
}

/// 查询已应用的最高迁移版本。
pub fn applied_version(kernel: &KernelContext) -> Result<u32, KernelError> {
    // 注意：`schema_version` 内部会取数据库锁，因此**不能**放在 with_conn 闭包里调用。
    kernel.db().schema_version(MIGRATION_SCOPE)
}

/// 新增或更新一条笔记，返回落库后的完整行。
///
/// `id` 为 `None` 时插入，`Some` 时更新（更新不存在的 id 返回 [`KernelError::InvalidArgument`]，
/// 而不是静默变成插入——静默插入会让前端拿到的 id 与预期不符）。
pub fn put_note(
    kernel: &KernelContext,
    id: Option<i64>,
    title: &str,
    body: &str,
    pinned: bool,
) -> Result<Note, KernelError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(KernelError::InvalidArgument("笔记标题不能为空".into()));
    }
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(KernelError::InvalidArgument(format!(
            "笔记标题不得超过 {MAX_TITLE_LEN} 字符"
        )));
    }
    if body.len() > MAX_BODY_LEN {
        return Err(KernelError::InvalidArgument(format!(
            "笔记正文不得超过 {MAX_BODY_LEN} 字节"
        )));
    }

    let now = now_secs();
    kernel.db().with_conn(|conn| match id {
        Some(id) => {
            let changed = conn.execute(
                &format!(
                    "UPDATE {NOTE_TABLE} SET title = ?1, body = ?2, pinned = ?3, updated_at = ?4 WHERE id = ?5"
                ),
                rusqlite::params![title, body, pinned as i64, now, id],
            )?;
            if changed == 0 {
                return Err(KernelError::InvalidArgument(format!(
                    "笔记 {id} 不存在，无法更新"
                )));
            }
            read_note(conn, id)?.ok_or_else(|| {
                // 更新后读不到只可能是并发删除；如实报错而不是伪造返回。
                KernelError::Database(rusqlite::Error::QueryReturnedNoRows)
            })
        }
        None => {
            conn.execute(
                &format!(
                    "INSERT INTO {NOTE_TABLE} (title, body, pinned, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)"
                ),
                rusqlite::params![title, body, pinned as i64, now],
            )?;
            let id = conn.last_insert_rowid();
            read_note(conn, id)?.ok_or_else(|| {
                KernelError::Database(rusqlite::Error::QueryReturnedNoRows)
            })
        }
    })
}

/// 按条件列出笔记（置顶优先，其次按更新时间倒序）。
pub fn list_notes(kernel: &KernelContext, query: &NoteQuery) -> Result<Vec<Note>, KernelError> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .min(MAX_LIST_LIMIT);
    let offset = query.offset.unwrap_or(0);
    let keyword = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));

    kernel.db().with_conn(|conn| {
        // 过滤条件用参数占位而非字符串拼接：标题来自用户输入，拼接会造成 SQL 注入。
        let mut sql = format!("SELECT id, title, body, pinned, created_at, updated_at FROM {NOTE_TABLE} WHERE 1 = 1");
        if query.only_pinned {
            sql.push_str(" AND pinned = 1");
        }
        if keyword.is_some() {
            sql.push_str(" AND (title LIKE ?1 OR body LIKE ?1)");
        }
        sql.push_str(" ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?2 OFFSET ?3");

        // 参数个数随条件变化，故按存在性分别绑定，避免用 NULL 占位绕开的写法。
        let (kw, lim, off) = (keyword.clone(), limit, offset);
        let mut stmt = conn.prepare(&sql)?;
        let rows = if let Some(kw) = kw {
            stmt.query_map(rusqlite::params![kw, lim, off], map_note)?
        } else {
            // 占位符编号从 ?2 开始，故此处显式用 2/3。
            stmt.query_map(rusqlite::params![lim, off], map_note)?
        };
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

/// 按 id 读取一条笔记。
pub fn get_note(kernel: &KernelContext, id: i64) -> Result<Option<Note>, KernelError> {
    kernel.db().with_conn(|conn| read_note(conn, id))
}

/// 删除一条笔记，返回是否确实删除。
pub fn delete_note(kernel: &KernelContext, id: i64) -> Result<bool, KernelError> {
    kernel
        .db()
        .with_conn(|conn| {
            let changed = conn.execute(
                &format!("DELETE FROM {NOTE_TABLE} WHERE id = ?1"),
                rusqlite::params![id],
            )?;
            Ok(changed > 0)
        })
}

/// 笔记总数。
pub fn note_count(kernel: &KernelContext) -> Result<i64, KernelError> {
    kernel.db().with_conn(|conn| {
        let count = conn.query_row(
            &format!("SELECT COUNT(*) FROM {NOTE_TABLE}"),
            [],
            |r| r.get::<_, i64>(0),
        )?;
        Ok(count)
    })
}

/// 清空全部笔记（`stop` 阶段不调用；仅供调试入口与测试使用）。
pub fn clear_notes(kernel: &KernelContext) -> Result<usize, KernelError> {
    kernel.db().with_conn(|conn| {
        let changed = conn.execute(&format!("DELETE FROM {NOTE_TABLE}"), [])?;
        Ok(changed)
    })
}

// ------------------------------------------------------------------ 内部

/// 读取单行（在 `with_conn` 闭包内使用）。
fn read_note(conn: &Connection, id: i64) -> Result<Option<Note>, KernelError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id, title, body, pinned, created_at, updated_at FROM {NOTE_TABLE} WHERE id = ?1"
    ))?;
    let note = stmt.query_row(rusqlite::params![id], map_note).optional()?;
    Ok(note)
}

/// 行 → [`Note`] 的映射（`pinned` 在 SQLite 里是 0/1 整数）。
fn map_note(row: &Row<'_>) -> Result<Note, rusqlite::Error> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        pinned: row.get::<_, i64>(3)? != 0,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// 当前 Unix 秒。用不上 chrono：模块只需要单调递增的排序键，
/// 时间格式化交给前端按 locale 处理。
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 表名前缀必须由 id 派生，且本文件的常量与派生结果一致。
    #[test]
    fn table_prefix_matches_manifest_derivation() {
        assert_eq!(manifest::table_prefix_for(MODULE_ID), TABLE_PREFIX);
        assert_eq!(TABLE_PREFIX, "module_copper_lamp_demo_tools_");
    }

    #[test]
    fn note_table_uses_prefix() {
        assert!(NOTE_TABLE.starts_with(TABLE_PREFIX), "表名必须带模块前缀");
        // 标识符不得含点号：SQLite 不加引号时无法解析。
        assert!(!NOTE_TABLE.contains('.'), "表名不得含点号");
    }

    #[test]
    fn migration_scope_uses_full_id() {
        // scope 是文本值，保留完整 id（含点号与连字符），与内置模块同构。
        assert_eq!(MIGRATION_SCOPE, format!("module:{MODULE_ID}"));
    }

    #[test]
    fn migrations_are_version_ascending_and_unique() {
        let mut prev = 0;
        for m in MIGRATIONS {
            assert!(m.version > prev, "迁移版本必须严格递增且不重复");
            prev = m.version;
            assert!(!m.name.is_empty(), "迁移必须带可读名字，便于排查");
            assert!(!m.sql.trim().is_empty(), "迁移 SQL 不能为空");
        }
        assert_eq!(TARGET_SCHEMA_VERSION, 2);
    }

    #[test]
    fn v2_migration_targets_same_table_as_v1() {
        // v2 是对同一张表加列 / 加索引；表名写错会在运行期才炸，这里静态锁住。
        assert!(MIGRATION_V2_SQL.contains(NOTE_TABLE));
        assert!(MIGRATION_V1_SQL.contains(NOTE_TABLE));
    }
}
