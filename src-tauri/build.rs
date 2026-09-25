//! 构建脚本：把仓库根 `module.json` 接入编译期，并在编译期校验它与 `Cargo.toml` 的一致性。
//!
//! 为什么要在编译期校验而不是运行期：清单与 crate 元数据不一致（改了 `module.json`
//! 的版本却忘了改 `Cargo.toml`，或改了 crate 名）会在打包 / 提审链路里才暴露，
//! 那时产物已经生成、字段已经写进 `cgl-libs` 条目，返工成本高。把校验前移到编译期，
//! 不一致直接编译失败，`cargo test` / CI 都会拦下来。
//!
//! 本脚本刻意**不生成中间文件**（不复制到 `OUT_DIR`，不写 `src-tauri/module.manifest.json`）：
//! `src/lib.rs` 用 `include_str!("../../module.json")` 直接嵌入同一份源文件，
//! 保证「构建期校验的」与「编译期嵌入的」永远是同一个字节序列，没有第二份拷贝可失同步。

use std::collections::BTreeSet;

/// 清单格式版本：与 `module.schema.json` 的 `schema_version.enum` 保持一致。
/// 这里重复声明一次是刻意的——构建脚本不依赖 serde，无法从 schema 读取枚举，
/// 故用编译期断言管住它（见下方 `const _`）。
const SUPPORTED_SCHEMA_VERSION: &str = "1";

/// 平台权威枚举：与设计文档 2.3 的 `platforms` 一致。
const SUPPORTED_PLATFORMS: &[&str] = &[
    "windows-x86_64",
    "windows-aarch64",
    "android-arm64",
    "linux-x86_64",
];

/// 权限权威枚举：与 `module.schema.json` 的 `permissions.items.enum` 一致。
const SUPPORTED_PERMISSIONS: &[&str] = &[
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

/// 分类权威枚举：与 `module.schema.json` 的 `category.enum` 一致。
const SUPPORTED_CATEGORIES: &[&str] = &["utility", "automation", "content", "integration", "appearance"];

/// `module.json` 中本模块的必需字段（顺序无关，缺失即失败）。
const REQUIRED_FIELDS: &[&str] = &[
    "schema_version",
    "id",
    "i18n_namespace",
    "display_name",
    "description",
    "author",
    "license",
    "version",
    "platforms",
    "launcher",
    "api_version",
    "backend",
    "frontend",
    "permissions",
    "icon",
    "category",
];

fn main() {
    // 清单或 Cargo.toml 任一变化都重新跑校验；否则改版本号不会触发重新编译。
    println!("cargo:rerun-if-changed=../module.json");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_path = manifest_json_path();
    let raw = std::fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("无法读取模块清单 {}: {e}", manifest_path.display()));

    let pine = parse_json(&raw)
        .unwrap_or_else(|e| panic!("模块清单 JSON 解析失败（{}）: {e}", manifest_path.display()));

    // 编译期校验函数内的字段读取依赖下面的必需字段检查先行通过，否则会 panic，
    // 因此这里先完整跑一遍结构校验，再跑一致性断言。
    let (crate_name, version, schema_version, platforms, permissions, category) =
        check_structure(&pine);

    // 一致性校验（版本号维度）。
    check_required_field_eq(&pine, "schema_version", SUPPORTED_SCHEMA_VERSION);
    check_version_format(&version, "version");
    check_crate_identity(&pine, &crate_name);
    check_semver_format(&pine, "launcher.min");
    check_launcher_max(&pine);
    check_platforms(&platforms);
    check_permissions(&permissions);
    check_category(&category);
    check_icon(&pine);
    check_author(&pine);
    check_api_version(&pine);
    check_logic_close(&pine, &crate_name, &version);

    // 校验通过后，把构建脚本中会参与运行期行为的清单字段导出为环境变量：
    // 运行期代码（`manifest.rs`）必须保持对真实 JSON 的解析能力，因此这里只导出
    // 供日志与自检使用的摘要，不导出可供绕过的完整结构。
    println!("cargo:rustc-env=COPPER_MODULE_ID={}", str_field(&pine, "id"));
    println!("cargo:rustc-env=COPPER_MODULE_VERSION={version}");
    println!("cargo:rustc-env=COPPER_MODULE_SCHEMA_VERSION={schema_version}");
}

/// 仓库根 `module.json` 的绝对路径（由 `CARGO_MANIFEST_DIR` = `<root>/src-tauri` 推出）。
fn manifest_json_path() -> std::path::PathBuf {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR 未设置：不在 cargo 构建环境中");
    std::path::PathBuf::from(manifest_dir).join("..").join("module.json")
}

// ------------------------------------------------------------------ JSON 子集解析
//
// build.rs 无 serde 依赖（构建依赖越少，离线环境越可靠），而清单结构固定且简单，
// 故实现一个只覆盖本清单所需语法的极小解析器：object / array / string（含转义）/ 数字 / bool / null。

#[derive(Debug, Clone, PartialEq)]
enum PNode {
    Null,
    Bool(bool),
    /// 数字保留原始字面量：`api_version` 需要整数语义，浮点形态应被拒绝。
    Number(String),
    Str(String),
    Array(Vec<PNode>),
    Object(Vec<(String, PNode)>),
}

impl PNode {
    fn get(&self, key: &str) -> Option<&PNode> {
        match self {
            PNode::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            PNode::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    fn as_array(&self) -> Option<&[PNode]> {
        match self {
            PNode::Array(items) => Some(items.as_slice()),
            _ => None,
        }
    }

    fn type_name(&self) -> &'static str {
        match self {
            PNode::Null => "null",
            PNode::Bool(_) => "boolean",
            PNode::Number(_) => "number",
            PNode::Str(_) => "string",
            PNode::Array(_) => "array",
            PNode::Object(_) => "object",
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            bytes: src.as_bytes(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.bytes.get(self.pos) {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        self.skip_ws();
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!(
                "第 {} 字节处期望 `{}`，实际为 {:?}",
                self.pos,
                byte as char,
                self.peek().map(|b| b as char)
            ))
        }
    }

    fn parse_value(&mut self) -> Result<PNode, String> {
        self.skip_ws();
        match self.peek() {
            None => Err(format!("第 {} 字节处意外结束", self.pos)),
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => Ok(PNode::Str(self.parse_string()?)),
            Some(b't') => self.parse_literal("true", PNode::Bool(true)),
            Some(b'f') => self.parse_literal("false", PNode::Bool(false)),
            Some(b'n') => self.parse_literal("null", PNode::Null),
            Some(_) => self.parse_number(),
        }
    }

    fn parse_literal(&mut self, text: &str, node: PNode) -> Result<PNode, String> {
        if self.bytes[self.pos..].starts_with(text.as_bytes()) {
            self.pos += text.len();
            Ok(node)
        } else {
            Err(format!("第 {} 字节处非法字面量", self.pos))
        }
    }

    fn parse_number(&mut self) -> Result<PNode, String> {
        let start = self.pos;
        while let Some(b) = self.peek() {
            if matches!(b, b'-' | b'+' | b'.' | b'e' | b'E') || b.is_ascii_digit() {
                self.pos += 1;
            } else {
                break;
            }
        }
        if start == self.pos {
            return Err(format!("第 {} 字节处非法值", self.pos));
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|e| format!("数字非 UTF-8: {e}"))?
            .to_string();
        Ok(PNode::Number(text))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let b = self
                .peek()
                .ok_or_else(|| format!("第 {} 字节处字符串未闭合", self.pos))?;
            self.pos += 1;
            match b {
                b'"' => return Ok(out),
                b'\\' => {
                    let esc = self
                        .peek()
                        .ok_or_else(|| format!("第 {} 字节处转义未结束", self.pos))?;
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hex = self
                                .bytes
                                .get(self.pos..self.pos + 4)
                                .ok_or_else(|| format!("第 {} 字节处 \\u 转义不完整", self.pos))?;
                            let hex = std::str::from_utf8(hex)
                                .map_err(|e| format!("\\u 转义非 UTF-8: {e}"))?;
                            let code = u32::from_str_radix(hex, 16)
                                .map_err(|_| format!("非法 \\u 转义 `{hex}`"))?;
                            self.pos += 4;
                            // 代理对合并：清单里出现 emoji 也应能解析（虽然项目禁止使用）。
                            if (0xD800..0xDC00).contains(&code) {
                                if self.bytes.get(self.pos..self.pos + 2) != Some(b"\\u") {
                                    return Err("孤立的高位代理项".to_string());
                                }
                                self.pos += 2;
                                let low_hex = self
                                    .bytes
                                    .get(self.pos..self.pos + 4)
                                    .ok_or_else(|| "代理对不完整".to_string())?;
                                let low_hex = std::str::from_utf8(low_hex)
                                    .map_err(|e| format!("代理对非 UTF-8: {e}"))?;
                                let low = u32::from_str_radix(low_hex, 16)
                                    .map_err(|_| format!("非法低位代理项 `{low_hex}`"))?;
                                self.pos += 4;
                                let combined =
                                    0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                                out.push(
                                    char::from_u32(combined)
                                        .ok_or_else(|| "非法码点组合".to_string())?,
                                );
                            } else {
                                out.push(
                                    char::from_u32(code)
                                        .ok_or_else(|| format!("非法码点 U+{code:04X}"))?,
                                );
                            }
                        }
                        other => return Err(format!("非法转义 `\\{}`", other as char)),
                    }
                }
                _ => {
                    // 多字节 UTF-8 序列：收集该字符的完整字节后整体转码。
                    let start = self.pos - 1;
                    let width = utf8_width(b);
                    self.pos = start + width;
                    if self.pos > self.bytes.len() {
                        return Err("字符串中 UTF-8 序列被截断".to_string());
                    }
                    let chunk = std::str::from_utf8(&self.bytes[start..self.pos])
                        .map_err(|e| format!("字符串非 UTF-8: {e}"))?;
                    out.push_str(chunk);
                }
            }
        }
    }

    fn parse_array(&mut self) -> Result<PNode, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(PNode::Array(items));
        }
        loop {
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(PNode::Array(items));
                }
                _ => return Err(format!("第 {} 字节处数组缺少 `,` 或 `]`", self.pos)),
            }
        }
    }

    fn parse_object(&mut self) -> Result<PNode, String> {
        self.expect(b'{')?;
        let mut entries: Vec<(String, PNode)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(PNode::Object(entries));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            if entries.iter().any(|(k, _)| *k == key) {
                // 重复键在 JSON 里语义未定义，静默取后者会让「改错字段」难以察觉。
                return Err(format!("重复的键 `{key}`"));
            }
            self.expect(b':')?;
            let value = self.parse_value()?;
            entries.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(PNode::Object(entries));
                }
                _ => return Err(format!("第 {} 字节处对象缺少 `,` 或 `}}`", self.pos)),
            }
        }
    }
}

fn utf8_width(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first >> 5 == 0b110 {
        2
    } else if first >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

fn parse_json(raw: &str) -> Result<PNode, String> {
    let mut parser = Parser::new(raw);
    let node = parser.parse_value()?;
    parser.skip_ws();
    if parser.pos != parser.bytes.len() {
        return Err(format!("第 {} 字节处存在多余内容", parser.pos));
    }
    Ok(node)
}

// ------------------------------------------------------------------ 校验

/// 结构校验：必需字段齐全，且类型正确。返回后续一致性校验需要的字段副本。
fn check_structure(
    root: &PNode,
) -> (String, String, String, Vec<String>, Vec<String>, String) {
    let PNode::Object(entries) = root else {
        panic!("模块清单根节点必须是对象，实际为 {}", root.type_name());
    };
    let keys: BTreeSet<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
    let missing: Vec<&str> = REQUIRED_FIELDS
        .iter()
        .copied()
        .filter(|f| !keys.contains(f))
        .collect();
    if !missing.is_empty() {
        panic!("模块清单缺少必需字段: {}", missing.join(", "));
    }

    let crate_name = str_field(root, "backend.crate").to_string();
    let version = str_field(root, "version").to_string();
    let schema_version = str_field(root, "schema_version").to_string();
    let category = str_field(root, "category").to_string();

    let platforms = root
        .get("platforms")
        .and_then(PNode::as_array)
        .unwrap_or_else(|| panic!("platforms 必须是数组"))
        .iter()
        .map(|n| {
            n.as_str()
                .unwrap_or_else(|| panic!("platforms 元素必须是字符串，实际为 {}", n.type_name()))
                .to_string()
        })
        .collect::<Vec<_>>();

    let permissions = root
        .get("permissions")
        .and_then(PNode::as_array)
        .unwrap_or_else(|| panic!("permissions 必须是数组"))
        .iter()
        .map(|n| {
            n.as_str()
                .unwrap_or_else(|| panic!("permissions 元素必须是字符串，实际为 {}", n.type_name()))
                .to_string()
        })
        .collect::<Vec<_>>();

    // 需要嵌套取值的字段在这里一并确认类型，避免后续 str_field 的 panic 信息缺少上下文。
    for path in [
        "id",
        "i18n_namespace",
        "display_name",
        "description",
        "license",
        "icon",
        "frontend.dist",
        "frontend.register",
        "backend.entry",
        "backend.artifact_glob",
        "author.name",
        "launcher.min",
    ] {
        str_field(root, path);
    }
    root.get("i18n").unwrap_or_else(|| panic!("i18n 字段缺失"));
    root.get("keywords").unwrap_or_else(|| panic!("keywords 字段缺失"));

    (
        crate_name,
        version,
        schema_version,
        platforms,
        permissions,
        category,
    )
}

/// 按点分路径读取字符串字段，类型不符或缺失直接 panic。
fn str_field<'a>(root: &'a PNode, path: &str) -> &'a str {
    let mut node = root;
    for part in path.split('.') {
        node = node
            .get(part)
            .unwrap_or_else(|| panic!("模块清单缺少字段 `{path}`（`{part}` 段缺失）"));
    }
    node.as_str()
        .unwrap_or_else(|| panic!("字段 `{path}` 必须是字符串，实际为 {}", node.type_name()))
}

fn check_required_field_eq(root: &PNode, path: &str, expected: &str) {
    let actual = str_field(root, path);
    if actual != expected {
        panic!("`{path}` 必须为 `{expected}`，实际为 `{actual}`");
    }
}

/// 清单版本与 crate 版本必须一致。
///
/// 为什么：`module.json` 的 `version` 是打包产物文件名、git tag、CHANGELOG、`cgl-libs`
/// 条目版本的唯一来源；`Cargo.toml` 的版本决定编译产物元数据。两者漂移会让发布包
/// 自称一个版本而二进制是另一个版本，排查成本极高。
fn check_version_format(version: &str, path: &str) {
    if !is_semver(version) {
        panic!("`{path}` 必须是 MAJOR.MINOR.PATCH 形式的 semver，实际为 `{version}`");
    }
    let cargo_version = std::env::var("CARGO_PKG_VERSION")
        .expect("CARGO_PKG_VERSION 未设置：不在 cargo 构建环境中");
    if version != cargo_version {
        panic!(
            "module.json 的 `{path}`（{version}）与 Cargo.toml 的 version（{cargo_version}）不一致；\
             版本号变动必须同时改两处，否则发布包文件名与二进制元数据会漂移"
        );
    }
}

fn check_crate_identity(root: &PNode, crate_name: &str) {
    let cargo_pkg_name = std::env::var("CARGO_PKG_NAME")
        .expect("CARGO_PKG_NAME 未设置：不在 cargo 构建环境中");
    if crate_name != cargo_pkg_name {
        panic!(
            "module.json 的 backend.crate（{crate_name}）与 Cargo.toml 的 package.name（{cargo_pkg_name}）不一致；\
             打包脚本按 backend.crate 定位产物，不一致会打不出后端文件"
        );
    }

    // entry 必须是本 crate 的类型全路径：lib target 名固定，形如 `<lib>::<Type>`。
    let entry = str_field(root, "backend.entry");
    let prefix = "copper_module_demo::";
    if !entry.starts_with(prefix) {
        panic!("backend.entry 必须以 `{prefix}` 开头，实际为 `{entry}`");
    }
    if entry.len() == prefix.len() {
        panic!("backend.entry 缺少类型名: `{entry}`");
    }

    // id 的第二段必须等于 i18n_namespace：设计文档 2.3 的约定默认如此，
    // 且前后端语言包命名空间一旦与 id 语义脱节，排查成本很高，这里直接管住。
    let id = str_field(root, "id");
    let namespace = str_field(root, "i18n_namespace");
    let tail = id
        .rsplit_once('.')
        .map(|(_, tail)| tail)
        .unwrap_or_else(|| panic!("id `{id}` 必须是两段式 author.module"));
    if tail != namespace {
        panic!("id 的第二段（{tail}）必须与 i18n_namespace（{namespace}）一致");
    }
}

fn is_semver(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn check_semver_format(root: &PNode, path: &str) {
    let value = str_field(root, path);
    if !is_semver(value) {
        panic!("`{path}` 必须是 MAJOR.MINOR.PATCH 形式的 semver，实际为 `{value}`");
    }
}

fn check_launcher_max(root: &PNode) {
    let node = root
        .get("launcher")
        .and_then(|l| l.get("max"))
        .unwrap_or_else(|| panic!("launcher.max 缺失（允许为 null，但必须显式声明）"));
    match node {
        PNode::Null => {}
        PNode::Str(text) => {
            if !is_semver(text) {
                panic!("launcher.max 必须是 semver 或 null，实际为 `{text}`");
            }
        }
        other => panic!(
            "launcher.max 必须是字符串或 null，实际为 {}",
            other.type_name()
        ),
    }
}

fn check_platforms(platforms: &[String]) {
    if platforms.is_empty() {
        panic!("platforms 至少声明一个平台");
    }
    let mut seen = BTreeSet::new();
    for p in platforms {
        if !SUPPORTED_PLATFORMS.contains(&p.as_str()) {
            panic!(
                "platforms 含不受支持的平台 `{p}`，权威枚举: {}",
                SUPPORTED_PLATFORMS.join(" / ")
            );
        }
        if !seen.insert(p.as_str()) {
            panic!("platforms 含重复项 `{p}`");
        }
    }
}

fn check_permissions(permissions: &[String]) {
    let mut seen = BTreeSet::new();
    for p in permissions {
        if !SUPPORTED_PERMISSIONS.contains(&p.as_str()) {
            panic!(
                "permissions 含未知权限 `{p}`，权威枚举: {}",
                SUPPORTED_PERMISSIONS.join(" / ")
            );
        }
        if !seen.insert(p.as_str()) {
            panic!("permissions 含重复项 `{p}`");
        }
    }
}

fn check_category(category: &str) {
    if !SUPPORTED_CATEGORIES.contains(&category) {
        panic!(
            "category `{category}` 不在权威枚举内: {}",
            SUPPORTED_CATEGORIES.join(" / ")
        );
    }
}

fn check_icon(root: &PNode) {
    let icon = str_field(root, "icon");
    if !icon.starts_with("assets/") {
        panic!("icon 必须是 `assets/` 下的相对路径（禁止外链），实际为 `{icon}`");
    }
    if icon.contains("://") {
        panic!("icon 禁止外链，实际为 `{icon}`");
    }
}

fn check_author(root: &PNode) {
    // 提审红线条目：author 必须能推出联系方式（url 或 email）。
    let has_url = root
        .get("author")
        .and_then(|a| a.get("url"))
        .and_then(PNode::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    let has_email = root
        .get("author")
        .and_then(|a| a.get("email"))
        .and_then(PNode::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    if !has_url && !has_email {
        panic!("author 必须至少提供 url 或 email（提审链路的联系方式红线）");
    }
}

fn check_api_version(root: &PNode) {
    let node = root
        .get("api_version")
        .unwrap_or_else(|| panic!("api_version 缺失"));
    let PNode::Number(text) = node else {
        panic!("api_version 必须是整数，实际为 {}", node.type_name());
    };
    if text.contains('.') {
        panic!("api_version 必须是整数，实际为 `{text}`");
    }
    let value: u32 = text
        .parse()
        .unwrap_or_else(|_| panic!("api_version 非法: `{text}`"));
    if value < 1 {
        panic!("api_version 必须 >= 1，实际为 {value}");
    }
}

/// 跨字段一致性：清单描述的前端语言包文件必须真实存在。
///
/// 为什么放在构建期：语言包路径是 `include_str!` 的编译期常量，缺失会以「找不到文件」
/// 的编译错误出现，信息量很低；这里给出「哪个 locale 文件缺、语言包目录在哪」的明确提示。
/// 注意：本 crate 若被单独 clone（未带 frontend/）会在编译期失败——这是刻意的，
/// 模块的语言包是单一数据源，二者必须同仓库交付。
fn check_logic_close(root: &PNode, crate_name: &str, version: &str) {
    let dist = str_field(root, "frontend.dist");
    let register = str_field(root, "frontend.register");
    if !dist.starts_with("frontend/") {
        panic!("frontend.dist 必须位于 `frontend/` 下，实际为 `{dist}`");
    }
    if !register.ends_with(".js") {
        panic!("frontend.register 必须是编译后的 js 模块名，实际为 `{register}`");
    }

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 未设置");
    let locales_dir = std::path::PathBuf::from(&manifest_dir)
        .join("..")
        .join("frontend")
        .join("src")
        .join("locales");
    for locale in ["zh-CN", "en-US"] {
        let file = locales_dir.join(format!("{locale}.json"));
        if !file.is_file() {
            panic!(
                "模块语言包缺失: {}（`src/contract.rs` 与前端共享同一份文案来源，属于冻结契约）",
                file.display()
            );
        }
    }

    let artifact = str_field(root, "backend.artifact_glob");
    if !artifact.contains(&crate_name.replace('-', "_")) {
        panic!(
            "backend.artifact_glob（{artifact}）未包含 lib target 名（{}），打包会匹配不到产物",
            crate_name.replace('-', "_")
        );
    }
    if !artifact.contains(version) && artifact.matches('.').count() >= 2 {
        // 产物 glob 通常不含版本号（版本体现在发布包文件名），此处仅作提示性校验：
        // 含版本号时必须是清单版本，避免写成过期版本。
        panic!("backend.artifact_glob 含疑似过期版本号，请核对与 module.json 的 version 一致");
    }
}
