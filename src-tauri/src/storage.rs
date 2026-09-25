//! 笔记持久化：走宿主的**模块私有存储**能力（KV），不再直接访问数据库。
//!
//! # 为什么不是 SQL
//!
//! 附加模块跑在独立进程里，内核不再把数据库连接交给模块——模块只能经 `storage.*`
//! 操作自己的命名空间（命名空间由**会话身份**决定，模块无法访问别人的数据）。
//! 代价是失去查询能力：过滤与排序都在模块侧做。换来的是"模块碰不到别人的数据"
//! 这一确定性，以及模块崩溃不再可能损坏内核库。
//!
//! # 键布局
//!
//! - `note.<id>`：单条笔记的 JSON；
//! - `meta.next-id`：下一个可用 id（单调递增）。
//!
//! 用键前缀而不是"整个列表存一个键"：单条读写不会互相覆盖，也就不会出现
//! "两个操作并发时后写的把前一条抹掉"。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ModuleError;
use crate::host::HostClient;

/// 笔记键前缀。
pub const KEY_PREFIX: &str = "note.";
/// 自增 id 的存储键。
pub const KEY_NEXT_ID: &str = "meta.next-id";

/// 笔记标题与正文的最大长度。
///
/// 为什么限制：模块存储有配额，超长文本（如误贴百 MB 日志）会先撞配额再报错；
/// 这里给出可读的拒绝原因，而不是让用户看到底层配额错误。
pub const MAX_TITLE_LEN: usize = 200;
pub const MAX_BODY_LEN: usize = 64 * 1024;

/// 默认列表条数。
pub const DEFAULT_LIST_LIMIT: u32 = 50;
/// 列表条数上限：防止前端一次拉全表。
pub const MAX_LIST_LIMIT: u32 = 500;

/// 一条笔记。
///
/// 字段与序列化形态（camelCase）是**前端契约**：与旧版同进程实现逐字一致，
/// 迁移不改前端可见形状。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

/// 新增或更新一条笔记，返回落库后的完整行。
///
/// `id` 为 `None` 时插入，`Some` 时更新（更新不存在的 id 返回参数错误，
/// 而不是静默变成插入——静默插入会让前端拿到的 id 与预期不符）。
pub fn put_note(
    host: &HostClient,
    id: Option<i64>,
    title: &str,
    body: &str,
    pinned: bool,
) -> Result<Note, ModuleError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(ModuleError::InvalidArgument("笔记标题不能为空".into()));
    }
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(ModuleError::InvalidArgument(format!(
            "笔记标题不得超过 {MAX_TITLE_LEN} 字符"
        )));
    }
    if body.len() > MAX_BODY_LEN {
        return Err(ModuleError::InvalidArgument(format!(
            "笔记正文不得超过 {MAX_BODY_LEN} 字节"
        )));
    }

    let now = now_secs();
    let note = match id {
        Some(id) => {
            let existing = read_note(host, id)?.ok_or_else(|| {
                ModuleError::InvalidArgument(format!("笔记 {id} 不存在，无法更新"))
            })?;
            Note {
                id,
                title: title.to_owned(),
                body: body.to_owned(),
                pinned,
                created_at: existing.created_at,
                updated_at: now,
            }
        }
        None => Note {
            id: allocate_id(host)?,
            title: title.to_owned(),
            body: body.to_owned(),
            pinned,
            created_at: now,
            updated_at: now,
        },
    };

    write_note(host, &note)?;
    Ok(note)
}

/// 按条件列出笔记（置顶优先，其次按更新时间倒序）。
pub fn list_notes(host: &HostClient, query: &NoteQuery) -> Result<Vec<Note>, ModuleError> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .min(MAX_LIST_LIMIT) as usize;
    let offset = query.offset.unwrap_or(0) as usize;
    let keyword = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);

    let mut notes = load_all(host)?;

    if query.only_pinned {
        notes.retain(|note| note.pinned);
    }
    if let Some(keyword) = keyword {
        // 注意：KV 没有 LIKE，匹配在模块侧做。这里用 Unicode 小写比较，
        // 因此中文与大小写混排的标题都能命中（旧版 SQLite 的 LIKE 只对 ASCII 忽略大小写）。
        notes.retain(|note| {
            note.title.to_lowercase().contains(&keyword)
                || note.body.to_lowercase().contains(&keyword)
        });
    }

    notes.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.updated_at.cmp(&a.updated_at))
            .then(b.id.cmp(&a.id))
    });

    Ok(notes.into_iter().skip(offset).take(limit).collect())
}

/// 删除一条笔记，返回是否确实删除。
pub fn delete_note(host: &HostClient, id: i64) -> Result<bool, ModuleError> {
    let response = host.call("storage.remove", &json!({ "key": note_key(id) }))?;
    Ok(response["removed"].as_bool().unwrap_or(false))
}

/// 笔记总数。
pub fn note_count(host: &HostClient) -> Result<i64, ModuleError> {
    Ok(list_keys(host, KEY_PREFIX)?.len() as i64)
}

/// 当前 Unix 秒。用不上 chrono：模块只需要单调递增的排序键，
/// 时间格式化交给前端按 locale 处理。
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------------ 内部

fn note_key(id: i64) -> String {
    format!("{KEY_PREFIX}{id}")
}

/// 读出全部笔记（损坏的单条会被跳过并告警，而不是让整次列表失败）。
fn load_all(host: &HostClient) -> Result<Vec<Note>, ModuleError> {
    let mut notes = Vec::new();
    for key in list_keys(host, KEY_PREFIX)? {
        match read_note_by_key(host, &key) {
            Ok(Some(note)) => notes.push(note),
            // 单条损坏不该让整个列表不可用：留痕后跳过，用户仍能看到其余笔记。
            Ok(None) => log::warn!("[demo-tools] 存储键 `{key}` 无值，已跳过"),
            Err(error) => log::warn!("[demo-tools] 存储键 `{key}` 解析失败，已跳过: {error}"),
        }
    }
    Ok(notes)
}

fn read_note(host: &HostClient, id: i64) -> Result<Option<Note>, ModuleError> {
    read_note_by_key(host, &note_key(id))
}

fn read_note_by_key(host: &HostClient, key: &str) -> Result<Option<Note>, ModuleError> {
    let response = host.call("storage.get", &json!({ "key": key }))?;
    let value = &response["value"];
    if value.is_null() {
        return Ok(None);
    }
    // 反序列化失败必须上报：静默当成"没有这条"会让损坏数据永远不可见。
    Ok(Some(serde_json::from_value(value.clone())?))
}

fn write_note(host: &HostClient, note: &Note) -> Result<(), ModuleError> {
    let value = serde_json::to_value(note)?;
    host.call(
        "storage.set",
        &json!({ "key": note_key(note.id), "value": value }),
    )?;
    Ok(())
}

fn list_keys(host: &HostClient, prefix: &str) -> Result<Vec<String>, ModuleError> {
    let response = host.call("storage.list", &json!({ "prefix": prefix }))?;
    Ok(response["keys"]
        .as_array()
        .map(|keys| {
            keys.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default())
}

/// 分配下一个 id。
///
/// 计数器与笔记数据同在模块自己的命名空间里：内核不提供自增，模块也不该依赖
/// 时间戳做 id（同一秒内的连续新增会撞号）。
fn allocate_id(host: &HostClient) -> Result<i64, ModuleError> {
    let response = host.call("storage.get", &json!({ "key": KEY_NEXT_ID }))?;
    let last = response["value"].as_i64().unwrap_or(0);
    let next = last + 1;
    host.call(
        "storage.set",
        &json!({ "key": KEY_NEXT_ID, "value": next }),
    )?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_keys_are_namespaced_and_stable() {
        assert_eq!(note_key(7), "note.7");
        assert!(note_key(7).starts_with(KEY_PREFIX));
        // id 键与元数据键不得互相前缀包含，否则前缀列举会多出/漏掉条目。
        assert!(!KEY_PREFIX.starts_with(KEY_NEXT_ID));
        assert!(!KEY_NEXT_ID.starts_with(KEY_PREFIX));
    }

    #[test]
    fn empty_title_is_rejected_before_any_capability_call() {
        // 无宿主客户端时也必须先做参数校验：非法输入不该走到能力调用。
        // 这里用 `None` 指针构造客户端，若发生能力调用会立刻失败而不是 panic。
        let client = unsafe { HostClient::new(std::ptr::null()) };
        let error = put_note(&client, None, "   ", "body", false).unwrap_err();
        assert_eq!(error.kind(), "invalid_argument");
        assert!(error.friendly().contains("标题"));
    }

    #[test]
    fn oversized_title_and_body_are_rejected() {
        let client = unsafe { HostClient::new(std::ptr::null()) };

        let long_title = "t".repeat(MAX_TITLE_LEN + 1);
        assert!(put_note(&client, None, &long_title, "", false).is_err());

        let long_body = "b".repeat(MAX_BODY_LEN + 1);
        assert!(put_note(&client, None, "ok", &long_body, false).is_err());
    }

    #[test]
    fn note_serializes_with_camel_case_for_the_frontend() {
        let note = Note {
            id: 1,
            title: "t".into(),
            body: "b".into(),
            pinned: true,
            created_at: 10,
            updated_at: 20,
        };
        let value = serde_json::to_value(&note).unwrap();
        assert_eq!(value["createdAt"], json!(10));
        assert_eq!(value["updatedAt"], json!(20));
        // 回读同一形状（KV 里存的就是这个形态）。
        let back: Note = serde_json::from_value(value).unwrap();
        assert_eq!(back, note);
    }
}
