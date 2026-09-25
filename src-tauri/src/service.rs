//! 模块业务逻辑层：命令层与存储层的中间层，便于脱离命令框架单测。
//!
//! 分层理由：命令层（[`crate::commands`]）只负责「参数形状 → 调用 → 结果形状」，
//! 不含业务判断；本层持有全部规则（长度上限、排序、兼容区间、意图可用性），
//! 其中纯函数部分不依赖 `KernelContext`，可直接单测。

use copper_core_lib::error::KernelError;
use copper_core_lib::state::KernelContext;
use serde::Serialize;
use serde_json::{json, Value};

use crate::intents;
use crate::manifest::Manifest;
use crate::module::{self, ActivityRecord, I18N_NAMESPACE, MODULE_ID};
use crate::storage::{self, Note, NoteQuery};

/// 模块概览（前端首页首屏数据）。
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
    /// 内核已装载模块总数（含本模块）。
    pub loaded_modules: usize,
    /// 内核已声明意图清单：`(声明模块, 意图名)`。
    pub declared_intents: Vec<IntentEntry>,
    /// 本模块自有意图清单。
    pub module_intents: Vec<String>,
    /// 笔记总数（模块表的真实数据量，用于概览卡片）。
    pub note_count: i64,
    /// 数据库迁移：已应用版本 / 目标版本。
    pub applied_schema_version: u32,
    pub target_schema_version: u32,
    /// 模块数据库表前缀与迁移 scope（契约自证，前端「契约」区块直接展示）。
    pub table_prefix: String,
    pub migration_scope: String,
    /// 已订阅的内核事件名与模块自有事件名。
    pub subscribed_events: Vec<String>,
    pub published_events: Vec<String>,
    /// 最近事件条数。
    pub activity_count: usize,
    /// 是否运行中（已 start）。
    pub running: bool,
}

/// 意图条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentEntry {
    pub module: String,
    pub intent: String,
}

/// 组装模块概览。
///
/// 概览刻意把「契约自证」字段（table_prefix / migration_scope / i18n_namespace）也返回：
/// 这些值写错不会报错、只表现为「没反应」或「文案回退键名」，让前端能一眼核对，
/// 比翻日志快得多。
pub fn overview(kernel: &KernelContext) -> Result<Overview, KernelError> {
    let m = manifest_or_err()?;
    let modules = kernel.modules().list(kernel);
    let mut declared: Vec<IntentEntry> = kernel
        .intents()
        .declared()
        .into_iter()
        .map(|(module, intent)| IntentEntry { module, intent })
        .collect();
    // 意图注册表内部是 HashMap，顺序不稳定；排序后前端每次渲染顺序一致。
    declared.sort_by(|a, b| a.intent.cmp(&b.intent).then_with(|| a.module.cmp(&b.module)));

    let applied = storage::applied_version(kernel)?;
    let note_count = storage::note_count(kernel)?;
    let recent = recent_activity(kernel);

    Ok(Overview {
        id: m.id.clone(),
        i18n_namespace: m.i18n_namespace.clone(),
        version: m.version.clone(),
        schema_version: m.schema_version.clone(),
        api_version: m.api_version,
        platforms: m.platforms.clone(),
        permissions: m.permissions.clone(),
        display_name: m.display_name.clone(),
        description: m.description.clone(),
        loaded_modules: modules.len(),
        declared_intents: declared,
        module_intents: intents::declared_intents(),
        note_count,
        applied_schema_version: applied,
        target_schema_version: storage::TARGET_SCHEMA_VERSION,
        table_prefix: storage::TABLE_PREFIX.to_string(),
        migration_scope: storage::MIGRATION_SCOPE.to_string(),
        subscribed_events: vec![module::SUBSCRIBED_EVENT.to_string()],
        published_events: vec![module::ACTIVITY_EVENT.to_string()],
        activity_count: recent.len(),
        running: module::is_instance_running(),
    })
}

/// 新增或更新笔记。
pub fn upsert_note(
    kernel: &KernelContext,
    id: Option<i64>,
    title: &str,
    body: &str,
    pinned: bool,
) -> Result<Note, KernelError> {
    storage::put_note(kernel, id, title, body, pinned)
}

/// 列出笔记。
pub fn list_notes(kernel: &KernelContext, query: &NoteQuery) -> Result<Vec<Note>, KernelError> {
    storage::list_notes(kernel, query)
}

/// 删除笔记；返回是否确实删除（前端据此提示「已删除」还是「记录不存在」）。
pub fn delete_note(kernel: &KernelContext, id: i64) -> Result<bool, KernelError> {
    storage::delete_note(kernel, id)
}

/// 意图 ping：验证「本模块声明 → 本模块发起」闭环。
pub fn ping(kernel: &KernelContext, payload: Value) -> Result<Value, KernelError> {
    intents::request_ping(kernel, payload)
}

/// 发起内核已有意图 `expose.version`。
pub fn expose_version(kernel: &KernelContext, payload: Value) -> Result<Value, KernelError> {
    intents::request_expose_version(kernel, payload)
}

/// 最近事件（最新在尾部）。
///
/// 实现说明：内存态由模块实例经 `Arc<Mutex<Vec<ActivityRecord>>>` 持有，事件回调
/// 只往该缓冲写入；命令层没有（也不应有）实例引用，故经模块侧登记的 `Weak`
/// 观察点读取。实例不存在（未 register 或已 stop）时返回空列表，这是合法语义。
pub fn recent_activity(kernel: &KernelContext) -> Vec<ActivityRecord> {
    let _ = kernel; // 保留参数以统一服务层签名
    crate::module::activity_snapshot()
}

/// 最近事件（截取最新的 `limit` 条，仍保持时间升序）。
pub fn recent_activity_limited(kernel: &KernelContext, limit: usize) -> Vec<ActivityRecord> {
    let mut all = recent_activity(kernel);
    if limit == 0 {
        // 明确语义：0 表示「不要」，而不是「全部」。
        return Vec::new();
    }
    if all.len() > limit {
        all.drain(0..all.len() - limit);
    }
    all
}

/// 取清单，失败时转成 `KernelError::Module`。
fn manifest_or_err() -> Result<&'static Manifest, KernelError> {
    module::manifest_result()
        .map_err(|e| KernelError::Module(format!("模块清单无效: {}", e.friendly())))
}

/// 构造 ping 的默认负载（无参调用时使用）。
pub fn empty_payload() -> Value {
    json!({})
}

// ------------------------------------------------------------------ 纯函数（可单测）

/// 把外部传入的 `limit` 规整到 `[1, max]`。
///
/// 抽成纯函数：命令层会收到任意 usize（含 0 与极大值），
/// 规整规则属于业务语义，必须可单测而不是散落在命令分支里。
pub fn normalize_limit(requested: Option<u32>, default: u32, max: u32) -> u32 {
    match requested {
        None => default.min(max).max(1),
        Some(0) => default.min(max).max(1),
        Some(v) => v.clamp(1, max),
    }
}

/// 概览的一行文本摘要（调试入口与日志用）。
pub fn overview_summary(overview: &Overview) -> String {
    format!(
        "{} {} | 命名空间={} | 装载模块={} | 意图={} | 笔记={} | 迁移={}/{}",
        overview.id,
        overview.version,
        overview.i18n_namespace,
        overview.loaded_modules,
        overview.declared_intents.len(),
        overview.note_count,
        overview.applied_schema_version,
        overview.target_schema_version
    )
}

/// i18n 键前缀（前端与文档共用同一份规则：`module.<i18n_namespace>.`）。
pub fn i18n_key_prefix() -> String {
    format!("module.{I18N_NAMESPACE}.")
}

/// 由扁平键拼 i18n 键。
pub fn i18n_key(flat_key: &str) -> String {
    format!("{}{flat_key}", i18n_key_prefix())
}

/// 校验一个 i18n 键是否属于本模块命名空间（越界键直接拒绝，避免「改了命名空间却仍能查表」）。
pub fn is_own_i18n_key(key: &str) -> bool {
    key.starts_with(&i18n_key_prefix())
}

/// 模块 id 的第二段（`copper-lamp.demo-tools` → `demo-tools`）。
pub fn id_namespace_segment(id: &str) -> Option<&str> {
    id.rsplit_once('.').map(|(_, tail)| tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{Manifest, ManifestError};

    fn real_manifest() -> Manifest {
        Manifest::parse_and_validate(module::MANIFEST_JSON).expect("仓库根的 module.json 必须合法")
    }

    #[test]
    fn manifest_from_repo_root_is_valid() {
        let m = real_manifest();
        assert_eq!(m.id, MODULE_ID);
        assert_eq!(m.i18n_namespace, I18N_NAMESPACE);
        assert_eq!(m.backend.crate_name, env!("CARGO_PKG_NAME"));
        assert_eq!(m.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn manifest_id_and_namespace_follow_schema_rules() {
        let m = real_manifest();
        assert!(crate::manifest::is_semver(&m.version));
        assert!(m.platforms.iter().all(|p| crate::manifest::SUPPORTED_PLATFORMS.contains(&p.as_str())));
        assert!(m.permissions.iter().all(|p| crate::manifest::SUPPORTED_PERMISSIONS.contains(&p.as_str())));
        assert!(m.icon.starts_with("assets/"));
        assert_eq!(id_namespace_segment(&m.id), Some(m.i18n_namespace.as_str()));
    }

    #[test]
    fn invalid_manifest_reports_readable_reason() {
        // 少一个必需字段：错误文案必须指出字段名，而不是泛泛的「解析失败」。
        let raw = r#"{"schema_version":"1","id":"copper-lamp.demo-tools"}"#;
        let err = Manifest::parse(raw).unwrap_err();
        let text = err.friendly();
        assert!(text.contains("i18n_namespace"), "错误应指出缺失字段: {text}");
        assert!(err.is_validate() == false);
    }

    #[test]
    fn manifest_semantic_errors_are_specific() {
        let mut m = real_manifest();

        m.platforms = vec!["windows-x64".to_string()];
        let err = m.validate().unwrap_err();
        assert!(err.friendly().contains("platforms"), "{err}");

        let mut m = real_manifest();
        m.permissions = vec!["fs:read".to_string()];
        let err = m.validate().unwrap_err();
        assert!(err.friendly().contains("permissions"), "{err}");

        let mut m = real_manifest();
        m.api_version = 0;
        let err = m.validate().unwrap_err();
        assert!(err.friendly().contains("api_version"), "{err}");

        let mut m = real_manifest();
        m.icon = "https://example.com/icon.svg".to_string();
        let err = m.validate().unwrap_err();
        assert!(err.friendly().contains("icon"), "{err}");

        let mut m = real_manifest();
        m.version = "0.1".to_string();
        let err = m.validate().unwrap_err();
        assert!(err.friendly().contains("version"), "{err}");

        let mut m = real_manifest();
        m.i18n_namespace = "demo.tools".to_string();
        let err = m.validate().unwrap_err();
        assert!(err.friendly().contains("i18n_namespace"), "{err}");
    }

    #[test]
    fn i18n_key_uses_namespace_not_full_id() {
        assert_eq!(i18n_key_prefix(), "module.demo-tools.");
        assert_eq!(i18n_key("navTitle"), "module.demo-tools.navTitle");
        assert!(is_own_i18n_key("module.demo-tools.title"));
        // 用完整 id 拼键会拆成四段而查不到：必须被规则拒绝。
        assert!(!is_own_i18n_key("module.copper-lamp.demo-tools.title"));
    }

    #[test]
    fn table_prefix_derives_from_module_id() {
        let m = real_manifest();
        assert_eq!(m.table_prefix(), "module_copper_lamp_demo_tools_");
        assert_eq!(m.table_prefix(), storage::TABLE_PREFIX);
        assert_eq!(m.migration_scope(), "module:copper-lamp.demo-tools");
        assert_eq!(m.migration_scope(), storage::MIGRATION_SCOPE);
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
    fn launcher_range_is_respected() {
        let mut m = real_manifest();
        m.launcher.min = "0.1.0".to_string();
        m.launcher.max = Some("2.0.0".to_string());
        assert!(crate::manifest::launcher_accepts(&m.launcher, "1.0.0"));
        assert!(crate::manifest::launcher_accepts(&m.launcher, "2.0.0"));
        assert!(!crate::manifest::launcher_accepts(&m.launcher, "0.0.9"));
        assert!(!crate::manifest::launcher_accepts(&m.launcher, "2.0.1"));
        // 无法解析的内核版本保守拒绝。
        assert!(!crate::manifest::launcher_accepts(&m.launcher, "unknown"));
    }

    #[test]
    fn manifest_error_kinds_are_distinguishable() {
        let parse_err = ManifestError::parse("坏的 JSON");
        assert!(!parse_err.is_validate());
        let validate_err = ManifestError::validate("坏的字段");
        assert!(validate_err.is_validate());
    }

    #[test]
    fn overview_summary_includes_contract_fields() {
        let summary = overview_summary(&Overview {
            id: MODULE_ID.to_string(),
            i18n_namespace: I18N_NAMESPACE.to_string(),
            version: "0.1.0".to_string(),
            schema_version: "1".to_string(),
            api_version: 1,
            platforms: vec!["windows-x86_64".to_string()],
            permissions: vec![],
            display_name: "示例工具".to_string(),
            description: "d".to_string(),
            loaded_modules: 4,
            declared_intents: vec![],
            module_intents: vec![],
            note_count: 3,
            applied_schema_version: 2,
            target_schema_version: 2,
            table_prefix: storage::TABLE_PREFIX.to_string(),
            migration_scope: storage::MIGRATION_SCOPE.to_string(),
            subscribed_events: vec![],
            published_events: vec![],
            activity_count: 0,
            running: true,
        });
        assert!(summary.contains("demo-tools"));
        assert!(summary.contains("2/2"));
    }
}
