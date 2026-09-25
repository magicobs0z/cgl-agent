//! 模块命令的类型化契约层（不依赖 tauri）。
//!
//! 为什么不做成 `#[tauri::command]`：模板**不注册命令到内核的 `generate_handler!`**
//! （那是内核静态列表，模块侧无法扩展，见设计文档 2.2 / 2.7.7 与 4.4 的缺口说明）。
//! 若在此引入 tauri，本 crate 就得多一份与内核完全一致的 tauri 依赖与特性集，
//! 编译成本与版本漂移风险都不值得。因此把命令定义成「枚举 + 分发函数」：
//! 阶段二内核支持附加模块命令注册后，只需在此枚举上套一层命令宏，前端契约不变。
//!
//! **命令名与前端 `api.ts` 的字符串逐字一致**，改动必须两侧同步。

use copper_core_lib::error::KernelError;
use copper_core_lib::state::KernelContext;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::service;
use crate::storage::{Note, NoteQuery, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT};

/// 命令名：模块概览。
pub const CMD_OVERVIEW: &str = "demo_tools_overview";
/// 命令名：笔记列表。
pub const CMD_NOTES_LIST: &str = "demo_tools_notes_list";
/// 命令名：笔记新增 / 更新。
pub const CMD_NOTE_UPSERT: &str = "demo_tools_note_upsert";
/// 命令名：笔记删除。
pub const CMD_NOTE_DELETE: &str = "demo_tools_note_delete";
/// 命令名：意图 ping。
pub const CMD_PING: &str = "demo_tools_ping";
/// 命令名：发起内核意图 `expose.version`。
pub const CMD_EXPOSE_VERSION: &str = "demo_tools_expose_version";
/// 命令名：最近事件。
pub const CMD_ACTIVITY_RECENT: &str = "demo_tools_activity_recent";

/// 全部命令名（前端契约自检与调试入口使用）。
pub const ALL_COMMANDS: &[&str] = &[
    CMD_OVERVIEW,
    CMD_NOTES_LIST,
    CMD_NOTE_UPSERT,
    CMD_NOTE_DELETE,
    CMD_PING,
    CMD_EXPOSE_VERSION,
    CMD_ACTIVITY_RECENT,
];

/// 笔记列表参数（camelCase，与前端 TS 接口一致）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesListArgs {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub only_pinned: bool,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

/// 笔记新增 / 更新参数。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpsertArgs {
    /// 缺省表示新增；给出时表示更新该 id。
    #[serde(default)]
    pub id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub pinned: bool,
}

/// 笔记删除参数。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteArgs {
    pub id: i64,
}

/// 意图发起参数（任意 JSON 负载，原样透传给处理者）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentArgs {
    #[serde(default)]
    pub payload: Value,
}

/// 最近事件参数。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityArgs {
    #[serde(default)]
    pub limit: Option<u32>,
}

/// 模块命令枚举：每个变体对应一条前端可调用的命令。
///
/// 变体名不参与序列化（命令名以 `CMD_*` 常量显式给出），
/// 保证前端契约字符串只有一处来源，不依赖 Rust 命名风格转换。
#[derive(Debug, Clone)]
pub enum DemoCommand {
    Overview,
    NotesList(NotesListArgs),
    NoteUpsert(NoteUpsertArgs),
    NoteDelete(NoteDeleteArgs),
    Ping(IntentArgs),
    ExposeVersion(IntentArgs),
    ActivityRecent(ActivityArgs),
}

impl DemoCommand {
    /// 命令名（与前端 `api.ts` 逐字一致）。
    pub fn name(&self) -> &'static str {
        match self {
            DemoCommand::Overview => CMD_OVERVIEW,
            DemoCommand::NotesList(_) => CMD_NOTES_LIST,
            DemoCommand::NoteUpsert(_) => CMD_NOTE_UPSERT,
            DemoCommand::NoteDelete(_) => CMD_NOTE_DELETE,
            DemoCommand::Ping(_) => CMD_PING,
            DemoCommand::ExposeVersion(_) => CMD_EXPOSE_VERSION,
            DemoCommand::ActivityRecent(_) => CMD_ACTIVITY_RECENT,
        }
    }

    /// 按命令名与参数 JSON 构造命令（模拟前端 `call(cmd, args)` 的入参链路）。
    ///
    /// 参数解析失败返回 [`KernelError::InvalidArgument`] 而不是 serde 错误：
    /// 命令层对前端的失败语义统一为「参数不合法」，便于前端分类提示。
    pub fn parse(name: &str, args: Value) -> Result<DemoCommand, KernelError> {
        // 前端可能传 null 或省略参数：统一归一化为空对象，避免各分支重复处理。
        let args = if args.is_null() { json!({}) } else { args };
        match name {
            CMD_OVERVIEW => Ok(DemoCommand::Overview),
            CMD_NOTES_LIST => Ok(DemoCommand::NotesList(parse_args::<NotesListArgs>(name, args)?)),
            CMD_NOTE_UPSERT => Ok(DemoCommand::NoteUpsert(parse_args::<NoteUpsertArgs>(name, args)?)),
            CMD_NOTE_DELETE => Ok(DemoCommand::NoteDelete(parse_args::<NoteDeleteArgs>(name, args)?)),
            CMD_PING => Ok(DemoCommand::Ping(parse_args::<IntentArgs>(name, args)?)),
            CMD_EXPOSE_VERSION => Ok(DemoCommand::ExposeVersion(parse_args::<IntentArgs>(name, args)?)),
            CMD_ACTIVITY_RECENT => {
                Ok(DemoCommand::ActivityRecent(parse_args::<ActivityArgs>(name, args)?))
            }
            other => Err(KernelError::InvalidArgument(format!(
                "未知模块命令 `{other}`；本模块支持: {}",
                ALL_COMMANDS.join(" / ")
            ))),
        }
    }
}

/// 依目标类型解析 JSON 参数。
///
/// 独立成**泛型函数**而非闭包：闭包无法带泛型参数，其返回类型 `Result<_, KernelError>`
/// 只能锚定到第一个调用点，后续分支复用同一闭包就会报 `?` 类型不兼容（E0308）。
fn parse_args<T: serde::de::DeserializeOwned>(name: &str, args: Value) -> Result<T, KernelError> {
    serde_json::from_value(args).map_err(|e| {
        KernelError::InvalidArgument(format!("命令 `{name}` 参数不合法: {e}"))
    })
}

/// 分发命令：参数校验 + 调 service，返回可直接序列化给前端的 JSON。
///
/// 返回 `Result<Value, KernelError>` 而非 `CommandResult`：`CommandError` 的转换由
/// 命令框架层（内核）负责，模块侧只产出内核错误，避免模块依赖命令框架的错误类型。
pub fn dispatch(kernel: &KernelContext, cmd: DemoCommand) -> Result<Value, KernelError> {
    match cmd {
        DemoCommand::Overview => {
            let overview = service::overview(kernel)?;
            to_value(overview)
        }
        DemoCommand::NotesList(args) => {
            let limit = service::normalize_limit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
            let query = NoteQuery {
                search: args.search,
                only_pinned: args.only_pinned,
                limit: Some(limit),
                offset: args.offset,
            };
            let offset = query.offset.unwrap_or(0);
            let notes: Vec<Note> = service::list_notes(kernel, &query)?;
            let total = crate::storage::note_count(kernel)?;
            to_value(json!({
                "notes": notes,
                "total": total,
                "limit": limit,
                "offset": offset,
            }))
        }
        DemoCommand::NoteUpsert(args) => {
            let note = service::upsert_note(kernel, args.id, &args.title, &args.body, args.pinned)?;
            to_value(note)
        }
        DemoCommand::NoteDelete(args) => {
            let deleted = service::delete_note(kernel, args.id)?;
            to_value(json!({ "deleted": deleted, "id": args.id }))
        }
        DemoCommand::Ping(args) => service::ping(kernel, args.payload),
        DemoCommand::ExposeVersion(args) => service::expose_version(kernel, args.payload),
        DemoCommand::ActivityRecent(args) => {
            let limit = service::normalize_limit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT) as usize;
            let records = service::recent_activity_limited(kernel, limit);
            to_value(json!({ "records": records, "limit": limit }))
        }
    }
}

/// service 层返回结构必须是可序列化的：失败时如实报错，不返回空对象掩盖问题。
fn to_value<T: Serialize>(value: T) -> Result<Value, KernelError> {
    serde_json::to_value(value).map_err(KernelError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_names_match_frontend_contract() {
        // 与 frontend/src/api.ts 的字符串逐字一致：改任一侧都会让这里失败。
        assert_eq!(CMD_OVERVIEW, "demo_tools_overview");
        assert_eq!(CMD_NOTES_LIST, "demo_tools_notes_list");
        assert_eq!(CMD_NOTE_UPSERT, "demo_tools_note_upsert");
        assert_eq!(CMD_NOTE_DELETE, "demo_tools_note_delete");
        assert_eq!(CMD_PING, "demo_tools_ping");
        assert_eq!(CMD_EXPOSE_VERSION, "demo_tools_expose_version");
        assert_eq!(CMD_ACTIVITY_RECENT, "demo_tools_activity_recent");
        assert_eq!(ALL_COMMANDS.len(), 7);
    }

    #[test]
    fn parse_accepts_null_and_empty_args() {
        assert!(matches!(
            DemoCommand::parse(CMD_OVERVIEW, Value::Null).unwrap(),
            DemoCommand::Overview
        ));
        assert!(matches!(
            DemoCommand::parse(CMD_NOTES_LIST, json!({})).unwrap(),
            DemoCommand::NotesList(_)
        ));
    }

    #[test]
    fn parse_rejects_unknown_command_with_readable_hint() {
        let err = DemoCommand::parse("demo_tools_nope", json!({})).unwrap_err();
        let text = err.friendly();
        assert!(text.contains("demo_tools_nope"), "{text}");
        assert!(text.contains(CMD_OVERVIEW), "应列出可用命令: {text}");
    }

    #[test]
    fn parse_reports_missing_required_field() {
        // NoteUpsertArgs.title 是必需字段：缺失应报「参数不合法」而不是 panic。
        let err = DemoCommand::parse(CMD_NOTE_UPSERT, json!({"body":"x"})).unwrap_err();
        assert!(err.friendly().contains("参数不合法"), "{}", err.friendly());
    }

    #[test]
    fn note_upsert_args_deserialize_camel_case() {
        let args: NoteUpsertArgs =
            serde_json::from_value(json!({"id": 3, "title": "t", "body": "b", "pinned": true}))
                .unwrap();
        assert_eq!(args.id, Some(3));
        assert!(args.pinned);
    }

    #[test]
    fn notes_list_args_defaults_are_safe() {
        let args: NotesListArgs = serde_json::from_value(json!({})).unwrap();
        assert_eq!(args.limit, None);
        assert!(!args.only_pinned);
        let limit = service::normalize_limit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        assert_eq!(limit, DEFAULT_LIST_LIMIT);
    }

    #[test]
    fn command_name_returns_contract_string() {
        let cmd = DemoCommand::NoteDelete(NoteDeleteArgs { id: 1 });
        assert_eq!(cmd.name(), CMD_NOTE_DELETE);
    }
}
