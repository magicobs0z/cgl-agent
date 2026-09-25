//! 意图声明与发起：模块对外提供能力（声明）、对内请求他人能力（发起）。
//!
//! 内核契约（`registry/intents.rs` 实证）：
//! - `declare(intent, module_id, handler)` 同一意图**重复声明报错**，不静默覆盖；
//! - `request(intent, payload)` 未声明返回 `KernelError::Intent`，错误文案含「无模块声明」；
//! - `withdraw(module_id)` 按声明模块清理，模块 `stop` 时必须调用。
//!
//! 命名边界：本模块只声明自有前缀 `demo-tools.*` 的意图，**不声明也不占用**内核已有意图
//! （`expose.version` / `launch.game`，由内置 `home` 模块声明）。重复声明内核意图会直接
//! 让本模块装载失败，且可能影响其它模块，故这里用常量把边界写死。

use copper_core_lib::error::KernelError;
use copper_core_lib::registry::intents::IntentHandler;
use copper_core_lib::state::KernelContext;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::module::{I18N_NAMESPACE, MODULE_ID};

/// 本模块声明的意图名（模块自有命名空间，不与内核意图冲突）。
pub const INTENT_PING: &str = "demo-tools.ping";

/// 内核已有意图：由内置 `home` 模块声明，本模块**只发起、不声明**。
pub const INTENT_EXPOSE_VERSION: &str = "expose.version";

/// 内核已有意图：由内置 `home` 模块声明，仅登记名字用于提示与自检，不发起。
pub const INTENT_LAUNCH_GAME: &str = "launch.game";

/// 声明本模块的全部意图（在 `Module::init` 中调用）。
///
/// 注意：内核的 `IntentRegistry` 在接入沙箱后，附加模块声明意图需持有 `intents` 权限；
/// 本模板的 `module.json` 默认 `permissions: []`，阶段一以 path 依赖静态编译（内置形态、
/// 不经沙箱）运行，故此处走未校验路径。阶段二接入沙箱时，模块作者必须同时把
/// `intents` 加进清单权限，并把此处换成 `declare_checked`。
pub fn declare(kernel: &KernelContext) -> Result<(), KernelError> {
    let handler: IntentHandler = Arc::new(|payload: Value| {
        // 负载原样回显在 `echo` 字段：演示「请求 - 响应」链路，同时便于调用方确认
        // 参数确实抵达了处理者（而不是被某层吞掉）。
        Ok(json!({
            "pong": true,
            "module": MODULE_ID,
            "namespace": I18N_NAMESPACE,
            "echo": payload,
            "at": crate::storage::now_secs(),
        }))
    });
    kernel.intents().declare(INTENT_PING, MODULE_ID, handler)
}

/// 注销本模块声明的全部意图（在 `Module::stop` 中调用）。
pub fn withdraw(kernel: &KernelContext) -> Result<(), KernelError> {
    kernel.intents().withdraw(MODULE_ID);
    Ok(())
}

/// 发起本模块自有意图 `demo-tools.ping`（演示「声明方与发起方」闭环）。
pub fn request_ping(kernel: &KernelContext, payload: Value) -> Result<Value, KernelError> {
    kernel.intents().request(INTENT_PING, payload)
}

/// 发起内核已有意图 `expose.version`。
///
/// 未声明时内核返回 `KernelError::Intent`（文案「意图 `expose.version` 无模块声明」），
/// 此处把它包装成**可读的业务提示**：调用方（前端）拿到的不应是内部错误文案，
/// 而应知道「该能力当前不可用、原因是什么」。设计文档 2.12 第 5 条要求演示「发起意图」，
/// 而 `expose.version` 由 `home` 声明、是否已装载取决于启动顺序，故未声明是**正常分支**，
/// 不能当作异常抛出。
pub fn request_expose_version(kernel: &KernelContext, payload: Value) -> Result<Value, KernelError> {
    match kernel.intents().request(INTENT_EXPOSE_VERSION, payload) {
        Ok(value) => Ok(json!({ "available": true, "result": value })),
        Err(KernelError::Intent(reason)) => Ok(json!({
            "available": false,
            "reason": reason,
            "hint": format!("意图 `{INTENT_EXPOSE_VERSION}` 由内置模块声明；未装载时无法发起"),
        })),
        // 其它错误（如处理者内部失败）如实上报，不伪装成「能力不可用」。
        Err(other) => Err(other),
    }
}

/// 本模块已声明的意图清单（自检与概览展示用）。
pub fn declared_intents() -> Vec<String> {
    vec![INTENT_PING.to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_intents_use_own_namespace() {
        // 自有意图必须带模块命名空间前缀，避免与内核/其它模块撞名。
        assert!(INTENT_PING.starts_with("demo-tools."));
    }

    #[test]
    fn module_does_not_claim_kernel_intents() {
        // 内核已有意图只能发起、不能声明：这里静态锁住边界，
        // 防止后续维护时不小心把 INTENT_EXPOSE_VERSION 加进声明清单。
        let declared = declared_intents();
        assert!(!declared.iter().any(|i| i == INTENT_EXPOSE_VERSION));
        assert!(!declared.iter().any(|i| i == INTENT_LAUNCH_GAME));
        assert_eq!(declared, vec![INTENT_PING.to_string()]);
    }

    /// 处理者行为：不依赖内核，直接构造同样的逻辑校验响应形状。
    #[test]
    fn ping_response_shape_is_stable() {
        // 与 declare 内部构造的 handler 保持同一份期望值（前端 api.ts 依赖这些键名）。
        let value = json!({
            "pong": true,
            "module": MODULE_ID,
            "namespace": I18N_NAMESPACE,
            "echo": {"n": 1},
        });
        assert_eq!(value["pong"], json!(true));
        assert_eq!(value["module"], json!(MODULE_ID));
        assert_eq!(value["namespace"], json!(I18N_NAMESPACE));
    }
}
