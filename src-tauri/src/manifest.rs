//! `module.json` 的反序列化结构与校验。
//!
//! 本文件是 `module.schema.json` 在 Rust 侧的镜像。字段名全部按清单原样（snake_case），
//! **不做 rename**，因为清单是跨仓库契约：`cgl-libs` 提审 bot、CI 校验脚本、编辑器
//! 插件都按原字段名读写，Rust 侧改名只会制造第二套命名。
//!
//! 校验分成两层，刻意不合并：
//! - 反序列化层（serde）：类型与必需字段，保证「读得出来」；
//! - [`Manifest::validate`]：语义规则（正则、枚举、区间），给出**可读的中文原因**。
//!
//! 为什么要分：serde 的错误信息以字段路径为主（`missing field 'i18n_namespace'`），
//! 对模块作者来说不够直接；而语义错误（如 `platforms` 写了 `windows-x64`）只有
//! 自己判才能说清「合法取值有哪些」。

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// 清单格式版本：与 `module.schema.json` 的 `schema_version.enum` 一致。
pub const SUPPORTED_SCHEMA_VERSION: &str = "1";

/// 当前内核支持的模块 API 版本下界。
pub const MIN_API_VERSION: u32 = 1;

/// `platforms` 权威枚举（与设计文档 2.3 / cgl-libs 2.3.6 逐字一致）。
pub const SUPPORTED_PLATFORMS: &[&str] = &[
    "windows-x86_64",
    "windows-aarch64",
    "android-arm64",
    "linux-x86_64",
];

/// `permissions` 权威枚举（9 项，与 `module.schema.json` 一致）。
pub const SUPPORTED_PERMISSIONS: &[&str] = &[
    "filesystem:read",
    "filesystem:write",
    "filesystem:game-dir",
    "network",
    "process:spawn",
    "download:enqueue",
    "settings:write",
    "intents:request",
    "account:read",
];

/// `category` 权威枚举。
pub const SUPPORTED_CATEGORIES: &[&str] = &[
    "utility",
    "automation",
    "content",
    "integration",
    "appearance",
];

// ------------------------------------------------------------------ 结构

/// 模块清单（`module.json` 的唯一 Rust 表达）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    /// 清单格式版本，当前恒为 `"1"`。
    pub schema_version: String,
    /// 全局唯一模块标识（两段式 `author.module`）。
    pub id: String,
    /// i18n 命名空间（单段）。语言包与 `t()` 键一律用它，**不用 `id`**。
    pub i18n_namespace: String,
    /// 默认展示名（无本地化条目时兜底）。
    pub display_name: String,
    /// 默认简介。
    pub description: String,
    /// 本地化覆盖：`locale -> { display_name, description }`。
    #[serde(default)]
    pub i18n: BTreeMap<String, LocalizedText>,
    pub author: Author,
    /// SPDX 许可标识。
    pub license: String,
    /// 模块版本（semver）。
    pub version: String,
    /// 适配平台（权威枚举）。
    pub platforms: Vec<String>,
    /// 内核兼容区间。
    pub launcher: LauncherRange,
    /// 模块 API 版本。
    pub api_version: u32,
    /// 后端产物声明。
    pub backend: BackendSpec,
    /// 前端产物声明。
    pub frontend: FrontendSpec,
    /// 权限声明（授权上界，可为空数组）。
    #[serde(default)]
    pub permissions: Vec<String>,
    /// 图标相对路径（`assets/` 下，禁止外链）。
    pub icon: String,
    /// 分类枚举。
    pub category: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub donation: Option<String>,
    #[serde(default)]
    pub changelog: Option<String>,
}

/// 单个 locale 的本地化文案。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalizedText {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// 作者信息。提审链路要求 `url` / `email` 至少其一。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Author {
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// 内核兼容区间。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LauncherRange {
    pub min: String,
    #[serde(default)]
    pub max: Option<String>,
}

/// 后端声明。
///
/// 序列化/反序列化由 [`backend_serde`] 子模块手写实现（字段名 `crate` 是 Rust 关键字，
/// 无法用 `rename` 直接处理），故这里**不** derive `Serialize`/`Deserialize`，
/// 否则会与手写实现冲突（E0119）。
#[derive(Debug, Clone, PartialEq)]
pub struct BackendSpec {
    /// Rust crate 名，须与 `src-tauri/Cargo.toml` 的 `name` 一致。
    pub crate_name: String,
    /// 模块类型全路径（如 `copper_module_demo::DemoModule`）。
    pub entry: String,
    /// 打包时匹配后端产物的 glob。
    pub artifact_glob: String,
}

/// 前端声明。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FrontendSpec {
    /// 构建产物目录。
    pub dist: String,
    /// 注册入口的编译后模块名。
    pub register: String,
}

/// 手写 `BackendSpec` 的映射：清单字段名是 `crate`（Rust 关键字），
/// serde 的 `rename` 只能改序列化名而无法改标识符，故显式实现以免误用 `r#crate`。
impl BackendSpec {
    /// 从清单字段读取。
    pub fn new(crate_name: String, entry: String, artifact_glob: String) -> Self {
        Self {
            crate_name,
            entry,
            artifact_glob,
        }
    }
}

// ------------------------------------------------------------------ 错误

/// 清单错误：解析失败与校验失败都归到这里，带可读中文原因。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ManifestError {
    /// JSON 语法 / 结构错误。
    #[error("模块清单解析失败: {0}")]
    Parse(String),

    /// 语义校验失败。
    #[error("模块清单校验失败: {0}")]
    Validate(String),
}

impl ManifestError {
    /// 构造一个解析错误。
    pub fn parse(reason: impl Into<String>) -> Self {
        Self::Parse(reason.into())
    }

    /// 构造一个校验错误。
    pub fn validate(reason: impl Into<String>) -> Self {
        Self::Validate(reason.into())
    }

    /// 人类可读的短消息。
    pub fn friendly(&self) -> String {
        self.to_string()
    }

    /// 是否为校验类错误（供上层区分「文件读坏了」与「字段写错了」）。
    pub fn is_validate(&self) -> bool {
        matches!(self, ManifestError::Validate(_))
    }
}

// ------------------------------------------------------------------ 解析与校验

/// `BackendSpec` 的 serde 字段名映射。
///
/// 单独抽出而不是就地 `#[serde(rename)]`，是为了让「清单字段名 = 契约」这件事
/// 只在本模块里显式出现一次，改动时不易漏。
mod backend_serde {
    use super::{BackendSpec, ManifestError};
    use serde::de::Error as _;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[derive(Serialize, Deserialize)]
    struct Raw {
        #[serde(rename = "crate")]
        crate_name: String,
        entry: String,
        artifact_glob: String,
    }

    impl Serialize for BackendSpec {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            Raw {
                crate_name: self.crate_name.clone(),
                entry: self.entry.clone(),
                artifact_glob: self.artifact_glob.clone(),
            }
            .serialize(serializer)
        }
    }

    impl<'de> Deserialize<'de> for BackendSpec {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let raw = Raw::deserialize(deserializer)?;
            if raw.crate_name.trim().is_empty() {
                return Err(D::Error::custom(ManifestError::parse(
                    "backend.crate 不能为空",
                )));
            }
            Ok(BackendSpec {
                crate_name: raw.crate_name,
                entry: raw.entry,
                artifact_glob: raw.artifact_glob,
            })
        }
    }
}

impl Manifest {
    /// 解析清单文本（仅反序列化，不做语义校验）。
    ///
    /// 需要完整校验时用 [`Manifest::parse_and_validate`]。
    pub fn parse(raw: &str) -> Result<Manifest, ManifestError> {
        serde_json::from_str(raw).map_err(|e| {
            // serde_json 的错误已带行列号，直接透传比重新包装更利于定位。
            ManifestError::parse(format!("第 {} 行第 {} 列: {e}", e.line(), e.column()))
        })
    }

    /// 解析并校验。
    pub fn parse_and_validate(raw: &str) -> Result<Manifest, ManifestError> {
        let manifest = Manifest::parse(raw)?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// 语义校验：正则、枚举、区间、跨字段一致性。
    ///
    /// 每条规则都给出「字段 + 实际值 + 期望」，因为模块作者拿到的是启动日志里的一行文本，
    /// 说不出「哪个字段、错在哪」就等于没报错。
    pub fn validate(&self) -> Result<(), ManifestError> {
        // schema_version：格式演进时内核按此判定兼容，不认识的版本必须拒绝而不是猜。
        if self.schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(ManifestError::validate(format!(
                "schema_version 必须为 `{SUPPORTED_SCHEMA_VERSION}`（当前内核支持的清单格式），实际为 `{}`",
                self.schema_version
            )));
        }

        // id：两段式 author.module。含点号是刻意的（唯一标识），
        // 但它不能用于 i18n 键，故另有 i18n_namespace 字段。
        if !is_module_id(&self.id) {
            return Err(ManifestError::validate(format!(
                "id `{}` 不合规：必须是两段式 `author.module`，两段均只含小写字母、数字与连字符（如 `copper-lamp.demo-tools`）",
                self.id
            )));
        }

        // i18n_namespace：单段、不含点号。含点号会被 t() 的 split('.') 拆段而查不到文案。
        if !is_i18n_namespace(&self.i18n_namespace) {
            return Err(ManifestError::validate(format!(
                "i18n_namespace `{}` 不合规：必须是单段、以字母开头、仅含小写字母/数字/连字符、长度 3~32 且不含点号",
                self.i18n_namespace
            )));
        }

        // 两段式 id 的第二段与命名空间一致：这是设计文档 2.3 的约定，
        // 一旦漂移，前端拼键与后端注册会指向两个命名空间，表现为文案整体回退键名。
        if let Some((_, tail)) = self.id.rsplit_once('.') {
            if tail != self.i18n_namespace {
                return Err(ManifestError::validate(format!(
                    "id 的第二段（`{tail}`）必须与 i18n_namespace（`{}`）一致，否则前后端语言包命名空间会分裂",
                    self.i18n_namespace
                )));
            }
        }

        if self.display_name.trim().is_empty() {
            return Err(ManifestError::validate("display_name 不能为空"));
        }
        if self.display_name.chars().count() > 40 {
            return Err(ManifestError::validate(format!(
                "display_name 不得超过 40 字符，实际 {} 字符",
                self.display_name.chars().count()
            )));
        }
        if self.description.trim().is_empty() {
            return Err(ManifestError::validate("description 不能为空"));
        }
        if self.description.chars().count() > 400 {
            return Err(ManifestError::validate(format!(
                "description 不得超过 400 字符，实际 {} 字符",
                self.description.chars().count()
            )));
        }

        // i18n：locale 键形如 zh-CN，取值为带 display_name / description 的对象。
        for locale in self.i18n.keys() {
            if !is_locale_tag(locale) {
                return Err(ManifestError::validate(format!(
                    "i18n 的键 `{locale}` 不是合法 locale 标签（形如 `zh-CN`）"
                )));
            }
        }

        if self.author.name.trim().is_empty() {
            return Err(ManifestError::validate("author.name 不能为空"));
        }
        // 提审链路要求能推出联系方式，缺了会在提审阶段才失败，这里提前拦。
        if !has_contact(&self.author) {
            return Err(ManifestError::validate(
                "author 必须至少提供 url 或 email（提审链路需要联系方式）",
            ));
        }

        if !is_spdx_like(&self.license) {
            return Err(ManifestError::validate(format!(
                "license `{}` 不合规：应为 SPDX 标识（仅含字母、数字、`.`、`+`、`-`，如 `MIT`）",
                self.license
            )));
        }

        if !is_semver(&self.version) {
            return Err(ManifestError::validate(format!(
                "version `{}` 不是 MAJOR.MINOR.PATCH 形式的 semver",
                self.version
            )));
        }

        if self.platforms.is_empty() {
            return Err(ManifestError::validate("platforms 至少声明一个平台"));
        }
        for p in &self.platforms {
            if !SUPPORTED_PLATFORMS.contains(&p.as_str()) {
                return Err(ManifestError::validate(format!(
                    "platforms 含不受支持的平台 `{p}`，合法取值: {}",
                    SUPPORTED_PLATFORMS.join(" / ")
                )));
            }
        }
        if has_duplicates(&self.platforms) {
            return Err(ManifestError::validate("platforms 含重复项"));
        }

        if !is_semver(&self.launcher.min) {
            return Err(ManifestError::validate(format!(
                "launcher.min `{}` 不是 semver",
                self.launcher.min
            )));
        }
        if let Some(max) = &self.launcher.max {
            if !is_semver(max) {
                return Err(ManifestError::validate(format!(
                    "launcher.max `{max}` 不是 semver（不限请写 null）"
                )));
            }
            if compare_semver(max, &self.launcher.min) == std::cmp::Ordering::Less {
                return Err(ManifestError::validate(format!(
                    "launcher.max（{max}）不得小于 launcher.min（{}）",
                    self.launcher.min
                )));
            }
        }

        if self.api_version < MIN_API_VERSION {
            return Err(ManifestError::validate(format!(
                "api_version 必须 >= {MIN_API_VERSION}，实际 {}",
                self.api_version
            )));
        }

        for p in &self.permissions {
            if !SUPPORTED_PERMISSIONS.contains(&p.as_str()) {
                return Err(ManifestError::validate(format!(
                    "permissions 含未知权限 `{p}`，合法取值: {}",
                    SUPPORTED_PERMISSIONS.join(" / ")
                )));
            }
        }
        if has_duplicates(&self.permissions) {
            return Err(ManifestError::validate("permissions 含重复项"));
        }

        // icon 必须在 assets/ 下且不外链：外链图标会在无网环境下丢失，
        // 且审核无法核对内容。
        if !self.icon.starts_with("assets/") {
            return Err(ManifestError::validate(format!(
                "icon `{}` 必须是 `assets/` 下的相对路径",
                self.icon
            )));
        }
        if self.icon.contains("://") {
            return Err(ManifestError::validate(format!(
                "icon `{}` 禁止使用外链",
                self.icon
            )));
        }

        if !SUPPORTED_CATEGORIES.contains(&self.category.as_str()) {
            return Err(ManifestError::validate(format!(
                "category `{}` 不在合法枚举内: {}",
                self.category,
                SUPPORTED_CATEGORIES.join(" / ")
            )));
        }

        if self.keywords.len() > 10 {
            return Err(ManifestError::validate(format!(
                "keywords 最多 10 项，实际 {} 项",
                self.keywords.len()
            )));
        }

        if !is_crate_name(&self.backend.crate_name) {
            return Err(ManifestError::validate(format!(
                "backend.crate `{}` 不是合法 crate 名（小写字母开头，仅含小写字母、数字与连字符）",
                self.backend.crate_name
            )));
        }
        if self.backend.entry.trim().is_empty() {
            return Err(ManifestError::validate("backend.entry 不能为空"));
        }
        if !self.backend.artifact_glob.contains(&self.backend.crate_name.replace('-', "_")) {
            return Err(ManifestError::validate(format!(
                "backend.artifact_glob（`{}`）必须包含 lib target 名（`{}`），否则打包匹配不到产物",
                self.backend.artifact_glob,
                self.backend.crate_name.replace('-', "_")
            )));
        }
        if self.frontend.dist.trim().is_empty() {
            return Err(ManifestError::validate("frontend.dist 不能为空"));
        }
        if self.frontend.register.trim().is_empty() {
            return Err(ManifestError::validate("frontend.register 不能为空"));
        }

        // 语言包在 init 阶段注册，locale 必须与清单声明的本地化覆盖对齐（缺失只警告不失败：
        // 未列出的 locale 允许后续补齐，硬失败会让「加一个语言」变成破坏性改动）。
        if let Some(zh) = self.i18n.get("zh-CN") {
            if zh.display_name.is_none() && zh.description.is_none() {
                return Err(ManifestError::validate(
                    "i18n.zh-CN 必须至少提供 display_name 或 description",
                ));
            }
        }

        Ok(())
    }

    /// 按 locale 取展示名（缺失时回退默认 `display_name`）。
    pub fn display_name_for(&self, locale: &str) -> &str {
        self.i18n
            .get(locale)
            .and_then(|t| t.display_name.as_deref())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&self.display_name)
    }

    /// 按 locale 取简介（缺失时回退默认 `description`）。
    pub fn description_for(&self, locale: &str) -> &str {
        self.i18n
            .get(locale)
            .and_then(|t| t.description.as_deref())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&self.description)
    }

    /// 数据库迁移 scope：`"module:<id>"`。
    ///
    /// 用完整 id 而非命名空间：scope 只是 `schema_migrations` 表里的一个文本值，
    /// 不参与 SQL 标识符解析，点号安全，且与内置模块（`module:content-download`）同构。
    pub fn migration_scope(&self) -> String {
        format!("module:{}", self.id)
    }

    /// 模块数据库表名前缀：`module_<id 的 . 与 - 换 _>_`。
    ///
    /// SQLite 标识符不允许含点号（除非加引号），故这里必须做替换；
    /// 而 scope 字符串不需要替换（见 [`Manifest::migration_scope`]）。
    pub fn table_prefix(&self) -> String {
        table_prefix_for(&self.id)
    }

    /// 一行的清单摘要（调试入口与日志用）。
    pub fn summary(&self) -> String {
        format!(
            "{} {} (i18n_namespace={}, platforms={}, api_version={})",
            self.id,
            self.version,
            self.i18n_namespace,
            self.platforms.join(","),
            self.api_version
        )
    }
}

impl fmt::Display for Manifest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.summary())
    }
}

/// 由模块 id 派生数据库表名前缀（`copper-lamp.demo-tools` → `module_copper_lamp_demo_tools_`）。
///
/// 抽成自由函数是为了让 `storage.rs` 的迁移常量与 `Manifest` 实例解耦：
/// 迁移常量在编译期就要写好表名，不能等到运行期解析清单再拼。
pub fn table_prefix_for(id: &str) -> String {
    let sanitized: String = id
        .chars()
        .map(|c| match c {
            '.' | '-' => '_',
            c => c,
        })
        .collect();
    format!("module_{sanitized}_")
}

// ------------------------------------------------------------------ 规则实现
//
// 逐条手写而不引 regex 依赖：规则少且固定，正则引擎会额外拉一个依赖树，
// 而手写循环的错误信息更好（能指出具体是哪个字符不合规）。

/// 模块 id：两段及以上，段内 `[a-z0-9]` 且以 `-` 连接。
fn is_module_id(id: &str) -> bool {
    let segments: Vec<&str> = id.split('.').collect();
    if segments.len() < 2 {
        return false;
    }
    segments.iter().all(|seg| is_dash_joined_lower(seg, false))
}

/// i18n 命名空间：单段，首字符为字母，长度 3~32，仅小写字母 / 数字 / 连字符。
pub fn is_i18n_namespace(ns: &str) -> bool {
    let len = ns.chars().count();
    if !(3..=32).contains(&len) {
        return false;
    }
    let mut chars = ns.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// crate 名：小写字母开头，仅含小写字母、数字与连字符。
fn is_crate_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `[a-z0-9]+(-[a-z0-9]+)*` 形态；`allow_underscore` 为真时额外接受下划线（暂未使用，保留语义清晰）。
fn is_dash_joined_lower(segment: &str, allow_underscore: bool) -> bool {
    if segment.is_empty() {
        return false;
    }
    let mut prev_dash = true; // 首字符不允许是连字符
    for c in segment.chars() {
        let ok = c.is_ascii_lowercase()
            || c.is_ascii_digit()
            || (c == '-' && !prev_dash)
            || (allow_underscore && c == '_');
        if !ok {
            return false;
        }
        prev_dash = c == '-';
    }
    !prev_dash // 末字符不允许是连字符
}

/// semver：严格 `MAJOR.MINOR.PATCH`（本模板不使用预发布 / 构建元数据后缀）。
pub fn is_semver(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// 按数值比较两个已通过 [`is_semver`] 的版本。
pub fn compare_semver(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |s: &str| -> (u64, u64, u64) {
        let mut it = s.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        (
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
        )
    };
    parse(a).cmp(&parse(b))
}

/// 判断内核版本是否落在 `[min, max]` 区间内（`max` 为 `None` 表示不限）。
///
/// 这是模块侧唯一需要判断兼容性的地方：内核装载前若不做判断，
/// 版本不匹配会表现为难以定位的运行期错误。
pub fn launcher_accepts(range: &LauncherRange, kernel_version: &str) -> bool {
    if !is_semver(kernel_version) {
        // 内核版本无法解析时保守拒绝：宁可不装载，也不要带病运行。
        return false;
    }
    if compare_semver(kernel_version, &range.min) == std::cmp::Ordering::Less {
        return false;
    }
    match &range.max {
        Some(max) => compare_semver(kernel_version, max) != std::cmp::Ordering::Greater,
        None => true,
    }
}

/// SPDX 标识形态：仅字母、数字、`.`、`+`、`-`。
fn is_spdx_like(license: &str) -> bool {
    !license.is_empty()
        && license
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
}

/// locale 标签形态：`xx-YY`。
fn is_locale_tag(tag: &str) -> bool {
    let Some((lang, region)) = tag.split_once('-') else {
        return false;
    };
    lang.len() == 2
        && lang.chars().all(|c| c.is_ascii_lowercase())
        && region.len() == 2
        && region.chars().all(|c| c.is_ascii_uppercase())
}

fn has_contact(author: &Author) -> bool {
    [author.url.as_deref(), author.email.as_deref()]
        .into_iter()
        .flatten()
        .any(|s| !s.trim().is_empty())
}

fn has_duplicates(items: &[String]) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    !items.iter().all(|i| seen.insert(i.as_str()))
}
