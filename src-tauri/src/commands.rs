//! 模块命令：参数形状与分发（不含业务规则，规则在 [`crate::service`]）。
//!
//! # 命令名与前端 `api.ts` 逐字一致
//!
//! `demo_tools_*` 这组名字是**冻结契约**，迁移不改变它们：前端调用路径是
//! `kernel 的 module_invoke(module_id, command, args)`，内核把命令原样转给插件，
//! 因此插件收到的 `operation` 就是这里的命令名。
//!
//! # 响应信封
//!
//! 插件 ABI 的 `invoke` 只有状态码，**没有结构化错误通道**（返回非 OK 时宿主只能报
//! "调用失败"，细节丢失）。所以命令结果统一包一层信封：
//!
//! - 成功：`{ "ok": true, "data": <命令结果> }`
//! - 失败：`{ "ok": false, "error": { "kind", "message" } }`
//!
//! 前端的 `api.ts` 负责拆信封（把 `ok:false` 还原成可读错误），否则"标题不能为空"
//! 这类正常校验失败会退化成不可读的后端错误。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ModuleError;
use crate::service;
use crate::state::PluginState;
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

/// 全部命令名（前端契约自检用）。
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
    /// 按命令名与参数 JSON 构造命令（模拟前端 `call(cmd, args)` 的入参链路）。
    ///
    /// 参数解析失败返回 [`ModuleError::InvalidArgument`] 而不是 serde 错误：
    /// 命令层对前端的失败语义统一为「参数不合法」，便于前端分类提示。
    pub fn parse(name: &str, args: Value) -> Result<Self, ModuleError> {
        // 前端可能传 null 或省略参数：统一归一化为空对象，避免各分支重复处理。
        let args = if args.is_null() { json!({}) } else { args };
        match name {
            CMD_OVERVIEW => Ok(Self::Overview),
            CMD_NOTES_LIST => Ok(Self::NotesList(parse_args(name, args)?)),
            CMD_NOTE_UPSERT => Ok(Self::NoteUpsert(parse_args(name, args)?)),
            CMD_NOTE_DELETE => Ok(Self::NoteDelete(parse_args(name, args)?)),
            CMD_PING => Ok(Self::Ping(parse_args(name, args)?)),
            CMD_EXPOSE_VERSION => Ok(Self::ExposeVersion(parse_args(name, args)?)),
            CMD_ACTIVITY_RECENT => Ok(Self::ActivityRecent(parse_args(name, args)?)),
            other => Err(ModuleError::UnknownCommand {
                command: other.to_owned(),
                supported: ALL_COMMANDS.join(" / "),
            }),
        }
    }
}

/// 依目标类型解析 JSON 参数。
///
/// 独立成**泛型函数**而非闭包：闭包无法带泛型参数，其返回类型 `Result<_, ModuleError>`
/// 只能锚定到第一个调用点，后续分支复用同一闭包就会报 `?` 类型不兼容（E0308）。
fn parse_args<T: serde::de::DeserializeOwned>(name: &str, args: Value) -> Result<T, ModuleError> {
    serde_json::from_value(args)
        .map_err(|e| ModuleError::InvalidArgument(format!("命令 `{name}` 参数不合法: {e}")))
}

/// 分发命令：参数校验 + 调 service，返回可直接序列化给前端的 JSON。
///
/// 未 `start` 时一律拒绝：命令属于运行期能力，宿主在 `stop` 之后仍可能收到前端的
/// 迟到调用（界面未刷新、点击已排队），此时如实报"模块尚未启动"比返回陈旧数据好。
pub fn dispatch(state: &mut PluginState, cmd: DemoCommand) -> Result<Value, ModuleError> {
    if !state.started() {
        return Err(ModuleError::NotStarted);
    }

    match cmd {
        DemoCommand::Overview => {
            let overview = service::overview(state.host(), state.activity().len(), true)?;
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
            let notes: Vec<Note> = service::list_notes(state.host(), &query)?;
            let total = crate::storage::note_count(state.host())?;
            to_value(json!({
                "notes": notes,
                "total": total,
                "limit": limit,
                "offset": offset,
            }))
        }
        DemoCommand::NoteUpsert(args) => {
            let note = service::upsert_note(
                state.host(),
                args.id,
                &args.title,
                &args.body,
                args.pinned,
            )?;
            state.record_activity(
                "note.upsert",
                format!(
                    "{}笔记 #{}：{}",
                    if args.id.is_some() { "更新" } else { "新增" },
                    note.id,
                    note.title
                ),
            );
            to_value(note)
        }
        DemoCommand::NoteDelete(args) => {
            let deleted = service::delete_note(state.host(), args.id)?;
            state.record_activity(
                "note.delete",
                format!(
                    "{}笔记 #{}",
                    if deleted { "已删除" } else { "未找到" },
                    args.id
                ),
            );
            to_value(json!({ "deleted": deleted, "id": args.id }))
        }
        DemoCommand::Ping(args) => {
            let result = service::ping(state.host(), args.payload)?;
            state.record_activity("module.ping", "已发起意图 demo-tools.ping 并收到响应");
            Ok(result)
        }
        DemoCommand::ExposeVersion(args) => service::expose_version(state.host(), args.payload),
        DemoCommand::ActivityRecent(args) => {
            let limit =
                service::normalize_limit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT) as usize;
            let records = service::recent_activity_limited(state.activity(), limit);
            to_value(json!({ "records": records, "limit": limit }))
        }
    }
}

/// service 层返回结构必须是可序列化的：失败时如实报错，不返回空对象掩盖问题。
fn to_value<T: Serialize>(value: T) -> Result<Value, ModuleError> {
    Ok(serde_json::to_value(value)?)
}

/// 把命令结果包成响应信封（见文件头说明）。
pub fn envelope(result: Result<Value, ModuleError>) -> Value {
    match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": error.to_payload() }),
    }
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
        let error = DemoCommand::parse("demo_tools_nope", json!({})).unwrap_err();
        assert_eq!(error.kind(), "unknown_command");
        let text = error.friendly();
        assert!(text.contains("demo_tools_nope"), "{text}");
        assert!(text.contains(CMD_OVERVIEW), "应列出可用命令: {text}");
    }

    #[test]
    fn parse_reports_missing_required_field() {
        // NoteUpsertArgs.title 是必需字段：缺失应报「参数不合法」而不是 panic。
        let error = DemoCommand::parse(CMD_NOTE_UPSERT, json!({"body":"x"})).unwrap_err();
        assert_eq!(error.kind(), "invalid_argument");
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
    fn envelope_separates_success_from_failure() {
        let ok = envelope(Ok(json!({ "n": 1 })));
        assert_eq!(ok["ok"], json!(true));
        assert_eq!(ok["data"]["n"], json!(1));

        let failed = envelope(Err(ModuleError::InvalidArgument("标题不能为空".into())));
        assert_eq!(failed["ok"], json!(false));
        assert_eq!(failed["error"]["kind"], json!("invalid_argument"));
        // 文案带错误类型前缀（`参数不合法: ...`），断言关键内容即可，避免把前缀也钉死。
        assert!(
            failed["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("标题不能为空"),
            "got: {}",
            failed["error"]["message"]
        );
        // 失败信封里不得混入 data，避免前端把错误当成功读。
        assert!(failed.get("data").is_none());
    }
}
