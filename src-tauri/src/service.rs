//! 模块业务逻辑层：命令层与存储 / 意图之间的中间层，便于脱离命令框架单测。
//!
//! 分层理由：命令层（[`crate::commands`]）只负责「参数形状 → 调用 → 结果形状」，
//! 不含业务判断；本层持有全部规则（长度上限、排序、意图可用性、概览组装）。
//!
//! 与旧版（同进程）的区别：本层不再接收 `KernelContext`，只接收 [`HostClient`]。
//! 模块拿不到内核注册表 / 数据库 / 事件总线对象，只能经能力通道取用——这正是隔离
//! 生效后的真实约束，模板必须按这个约束写，否则迁移到子进程时会立刻编不过。

use serde::Serialize;
use serde_json::Value;

use crate::contract::{
    ACTIVITY_EVENT, I18N_NAMESPACE, MANIFEST_JSON, MODULE_ID, SUBSCRIBED_EVENT,
};
use crate::error::ModuleError;
use crate::host::HostClient;
use crate::storage::{self, Note, NoteQuery};

/// 模块概览（前端首页首屏数据）。
///
/// 只保留**插件确实能知道**的字段。旧版还有 `loaded_modules` / `declared_intents`
/// （需要枚举内核注册表）与 `applied_schema_version` / `target_schema_version`
/// （需要数据库），子进程插件拿不到这些，故一并移除——宁可少给，也不编造。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// 模块完整 id。
    pub id: String,
    /// i18n 命名空间（前端拼 `module.<namespace>.*` 键用）。
    pub i18n_namespace: String,
    /// 模块版本。
    pub version: String,
    /// 清单格式版本。
    pub schema_version: String,
    /// 模块 API 版本。
    pub api_version: u32,
    /// 兼容平台列表。
    pub platforms: Vec<String>,
    /// 声明的权限（授权上界）。
    pub permissions: Vec<String>,
    /// 清单声明的展示名与简介（默认语言）。
    pub display_name: String,
    pub description: String,
    /// 本模块声明的意图清单。
    pub module_intents: Vec<String>,
    /// 笔记总数（模块存储里的真实数据量）。
    pub note_count: i64,
    /// 模块存储的键前缀与命名空间。
    ///
    /// 与旧版 `table_prefix` / `migration_scope` 对应：模块不再有表，取而代之的是
    /// 自己的 KV 命名空间。字段名如实反映现在的东西。
    pub storage_key_prefix: String,
    pub storage_scope: String,
    /// 订阅的内核事件名与模块自有事件名。
    pub subscribed_events: Vec<String>,
    pub published_events: Vec<String>,
    /// 最近事件条数。
    pub activity_count: usize,
    /// 是否已 start。
    pub running: bool,
}

/// 组装模块概览。
///
/// 概览刻意把「契约自证」字段（`storage_key_prefix` / `storage_scope` /
/// `i18n_namespace`）也返回：这些值写错不会报错、只表现为「没反应」或「文案回退键名」，
/// 让前端能一眼核对，比翻日志快得多。
pub fn overview(
    host: &HostClient,
    activity_count: usize,
    running: bool,
) -> Result<Overview, ModuleError> {
    let manifest = manifest()?;
    let note_count = storage::note_count(host)?;

    Ok(Overview {
        id: MODULE_ID.to_owned(),
        i18n_namespace: I18N_NAMESPACE.to_owned(),
        version: str_field(&manifest, "version"),
        schema_version: str_field(&manifest, "schema_version"),
        api_version: manifest["api_version"].as_u64().unwrap_or(1) as u32,
        platforms: str_array(&manifest, "platforms"),
        permissions: str_array(&manifest, "permissions"),
        display_name: str_field(&manifest, "display_name"),
        description: str_field(&manifest, "description"),
        module_intents: crate::intents::declared_intents(),
        note_count,
        storage_key_prefix: storage::KEY_PREFIX.to_owned(),
        storage_scope: MODULE_ID.to_owned(),
        subscribed_events: vec![SUBSCRIBED_EVENT.to_owned()],
        published_events: vec![ACTIVITY_EVENT.to_owned()],
        activity_count,
        running,
    })
}

/// 新增或更新笔记。
pub fn upsert_note(
    host: &HostClient,
    id: Option<i64>,
    title: &str,
    body: &str,
    pinned: bool,
) -> Result<Note, ModuleError> {
    storage::put_note(host, id, title, body, pinned)
}

/// 列出笔记。
pub fn list_notes(host: &HostClient, query: &NoteQuery) -> Result<Vec<Note>, ModuleError> {
    storage::list_notes(host, query)
}

/// 删除笔记；返回是否确实删除（前端据此提示「已删除」还是「记录不存在」）。
pub fn delete_note(host: &HostClient, id: i64) -> Result<bool, ModuleError> {
    storage::delete_note(host, id)
}

/// 意图 ping：验证「本模块声明 → 本模块发起」闭环。
pub fn ping(host: &HostClient, payload: Value) -> Result<Value, ModuleError> {
    crate::intents::request_ping(host, payload)
}

/// 发起内核已有意图 `expose.version`。
pub fn expose_version(host: &HostClient, payload: Value) -> Result<Value, ModuleError> {
    crate::intents::request_expose_version(host, payload)
}

// ------------------------------------------------------------------ 纯函数（可单测）

/// 把外部传入的 `limit` 规整到 `[1, max]`。
///
/// 抽成纯函数：命令层会收到任意 u32（含 0 与极大值），规整规则属于业务语义，
/// 必须可单测而不是散落在命令分支里。
pub fn normalize_limit(requested: Option<u32>, default: u32, max: u32) -> u32 {
    match requested {
        None => default.min(max).max(1),
        Some(0) => default.min(max).max(1),
        Some(v) => v.clamp(1, max),
    }
}

/// 最近事件（截取最新的 `limit` 条，仍保持时间升序）。
///
/// `limit == 0` 明确表示「不要」，而不是「全部」。
pub fn recent_activity_limited(
    records: &[crate::state::ActivityRecord],
    limit: usize,
) -> Vec<crate::state::ActivityRecord> {
    if limit == 0 {
        return Vec::new();
    }
    let start = records.len().saturating_sub(limit);
    records[start..].to_vec()
}

// ------------------------------------------------------------------ 内部

/// 解析编译期嵌入的清单原文（静态展示字段的来源，与打包产物同源）。
///
/// 只读不校验：清单的字段与语义由内核装载器与 `build.rs` 负责，插件侧不再抄一份校验。
fn manifest() -> Result<Value, ModuleError> {
    Ok(serde_json::from_str(MANIFEST_JSON)?)
}

fn str_field(manifest: &Value, key: &str) -> String {
    manifest[key].as_str().unwrap_or_default().to_owned()
}

fn str_array(manifest: &Value, key: &str) -> Vec<String> {
    manifest[key]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_is_valid_and_matches_constants() {
        let manifest = manifest().expect("仓库根 module.json 必须是合法 JSON");
        assert_eq!(str_field(&manifest, "id"), MODULE_ID);
        assert_eq!(str_field(&manifest, "i18n_namespace"), I18N_NAMESPACE);
        assert_eq!(str_field(&manifest, "version"), env!("CARGO_PKG_VERSION"));
        assert!(!str_array(&manifest, "platforms").is_empty());
        // 概览直接展示这两项，缺失会显示空白而不是报错，故在此锁住。
        assert!(!str_field(&manifest, "display_name").is_empty());
        assert!(!str_field(&manifest, "description").is_empty());
    }

    #[test]
    fn normalize_limit_clamps_into_range() {
        assert_eq!(normalize_limit(None, 50, 500), 50);
        assert_eq!(normalize_limit(Some(0), 50, 500), 50);
        assert_eq!(normalize_limit(Some(10), 50, 500), 10);
        assert_eq!(normalize_limit(Some(9999), 50, 500), 500);
        assert_eq!(normalize_limit(Some(1), 50, 500), 1);
    }

    #[test]
    fn recent_activity_keeps_the_newest_entries_in_order() {
        let records: Vec<crate::state::ActivityRecord> = (0..5)
            .map(|i| crate::state::ActivityRecord::new("download.status", format!("seq={i}")))
            .collect();

        let limited = recent_activity_limited(&records, 2);
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].message, "seq=3");
        assert_eq!(limited[1].message, "seq=4");
        // 0 表示"不要"，不是"全部"。
        assert!(recent_activity_limited(&records, 0).is_empty());
    }
}
