//! 意图：声明方向（宿主转发进来）与发起方向（能力调用）。
//!
//! # 两个方向的落点不同
//!
//! - **声明方向**：清单 `intents: ["demo-tools.ping"]` 是**声明的上界**，宿主在模块
//!   `start` 成功后按它登记转发处理器；别的模块请求该意图时，宿主转成一次插件调用
//!   `intent.demo-tools.ping`（见 [`crate::lib`] 的分发），本文件的 [`handle`] 就是
//!   那个处理器。插件侧**没有**运行期注册入口——多一个注册源就多一个和清单漂移的机会。
//! - **发起方向**：走能力 `intent.request`，且清单 `permissions` 必须含 `intents:request`。
//!
//! # 命名边界
//!
//! 本模块只声明自有前缀 `demo-tools.*` 的意图，**不声明也不占用**内核已有意图
//! （`expose.version` / `launch.game`，由内置 `home` 模块声明）。重复声明内核意图会让
//! 本模块装载失败，且可能影响其它模块，故这里用常量把边界写死并加测试锁住。

use serde_json::{json, Value};

use crate::contract::{I18N_NAMESPACE, INTENT_PING, MODULE_ID};
use crate::error::ModuleError;
use crate::host::HostClient;

/// 宿主能力名：发起一次意图请求。
const CAPABILITY_INTENT_REQUEST: &str = "intent.request";

/// 处理宿主转发进来的意图请求。
///
/// 返回值即该意图的响应，会原样被宿主回给请求方。
pub fn handle(intent: &str, payload: Value) -> Result<Value, ModuleError> {
    match intent {
        INTENT_PING => Ok(json!({
            "pong": true,
            "module": MODULE_ID,
            "namespace": I18N_NAMESPACE,
            // 负载原样回显在 `echo`：演示"请求 - 响应"链路，同时让调用方确认参数
            // 确实抵达了处理者（而不是被某层吞掉）。
            "echo": payload,
            "at": crate::storage::now_secs(),
        })),
        other => Err(ModuleError::UnknownCommand {
            command: format!("intent.{other}"),
            supported: INTENT_PING.to_string(),
        }),
    }
}

/// 发起本模块自有意图 `demo-tools.ping`（演示"声明与发起"闭环）。
pub fn request_ping(host: &HostClient, payload: Value) -> Result<Value, ModuleError> {
    request(host, INTENT_PING, payload)
}

/// 发起内核已有意图 `expose.version`。
///
/// 未装载声明方时宿主会回错误状态码，此处把它转成**可读的业务提示**：调用方（前端）
/// 需要知道"该能力当前不可用、原因是什么"，而不是一条内部错误。其它失败（例如权限
/// 被收紧、处理者内部出错）如实上报，不伪装成"能力不可用"。
///
/// 诚实说明：宿主只回状态码，不回错误正文（见 [`crate::host`]），因此这里只能区分
/// "记录型"的降级（`NOT_SUPPORTED`，即该内核不提供 `intent.request`）与"调用失败"；
/// 更细的原因需查内核日志。
pub fn request_expose_version(host: &HostClient, payload: Value) -> Result<Value, ModuleError> {
    let version = crate::contract::INTENT_EXPOSE_VERSION;
    match request(host, version, payload) {
        Ok(value) => Ok(json!({ "available": true, "result": value })),
        Err(ModuleError::CapabilityUnsupported { .. }) => Ok(json!({
            "available": false,
            "reason": "宿主未提供 `intent.request` 能力",
            "hint": format!("意图 `{version}` 由内置模块声明；该内核构建无法发起意图"),
        })),
        Err(other) => Err(other),
    }
}

/// 发起一次意图请求（统一走能力 `intent.request`）。
pub fn request(host: &HostClient, intent: &str, payload: Value) -> Result<Value, ModuleError> {
    let response = host.call(
        CAPABILITY_INTENT_REQUEST,
        &json!({ "intent": intent, "payload": payload }),
    )?;
    Ok(response["result"].clone())
}

/// 本模块已声明的意图清单（概览展示用）。
pub fn declared_intents() -> Vec<String> {
    vec![INTENT_PING.to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::INTENT_EXPOSE_VERSION;

    #[test]
    fn ping_handler_echoes_payload_and_identity() {
        let response = handle(INTENT_PING, json!({ "n": 1 })).unwrap();
        assert_eq!(response["pong"], json!(true));
        assert_eq!(response["module"], json!(MODULE_ID));
        assert_eq!(response["namespace"], json!(I18N_NAMESPACE));
        assert_eq!(response["echo"]["n"], json!(1));
    }

    #[test]
    fn unknown_intent_is_refused_with_the_supported_list() {
        // 宿主只会转发清单里声明过的意图；真收到别的名字说明契约不一致，
        // 必须如实报错而不是回一个空结果。
        let error = handle("demo-tools.nope", json!({})).unwrap_err();
        assert_eq!(error.kind(), "unknown_command");
        assert!(error.friendly().contains(INTENT_PING));
    }

    #[test]
    fn module_declares_only_its_own_namespace() {
        let declared = declared_intents();
        assert_eq!(declared, vec![INTENT_PING.to_string()]);
        // 内核已有意图只能发起、不能声明（重复声明会让本模块装载失败）。
        assert!(!declared.iter().any(|i| i == INTENT_EXPOSE_VERSION));
    }

    #[test]
    fn unavailable_capability_degrades_into_a_readable_result() {
        // 空指针宿主 → 能力调用必然失败（NOT_SUPPORTED 之外的路径由 host.rs 单测覆盖），
        // 这里只确认"降级只在可降级的分支发生"，不会把失败说成可用。
        let host = unsafe { HostClient::new(std::ptr::null()) };
        let result = request_expose_version(&host, json!({}));
        assert!(result.is_err(), "非可降级失败必须如实上报");
    }
}
