//! 铜傀儡模块模板 · 示例模块后端（`copper-lamp.demo-tools`）。
//!
//! 本 crate 是**独立 crate**，不是 `CopperCore` 的 workspace 成员：内核仓库未声明
//! `[workspace]`，本目录也不声明，二者经 `path` 依赖单向引用（设计文档 2.9 阶段一）。
//!
//! ## 阶段一接入方式（当前可行）
//!
//! 本模板**不注册命令到内核的静态命令表**——`tauri::generate_handler!` 是内核源码里的
//! 固定列表，模块侧无法扩展（设计文档 2.2 / 2.7.7 与 4.4 的缺口说明）。因此在阶段一：
//!
//! 1. 在 `CopperCore/src-tauri/Cargo.toml` 增加依赖：
//!    `copper-module-demo = { path = "../../CopperModles/src-tauri" }`
//! 2. 在 `CopperCore/src-tauri/src/lib.rs` 的 `setup` 中、`pool.boot(&kernel)` 之前调用：
//!
//!    ```ignore
//!    copper_module_demo::register(kernel.modules())?;
//!    ```
//!
//!    （`register` 内部以 `ModuleOrigin::Addon` 登记，使模块来源如实标注为附加模块。）
//! 3. 模块命令当前**不会自动出现在前端的 `invoke` 命令表**中；前端的 `api.ts` 会把
//!    「命令未注册」归一化为可读状态并展示为「命令不可用」，而不是假装成功
//!    （见本仓库 `AGENTS.md` 第二节与设计文档 4.4）。
//!
//! ## 阶段二（内核待实现）
//!
//! 内核支持附加模块动态加载后，本 crate 编译为动态库，由内核装载并注册命令；
//! 命令契约（`commands.rs` 中的命令名与参数形状）保持不变，前端无需改动。

pub mod commands;
pub mod intents;
pub mod manifest;
pub mod module;
pub mod service;
pub mod storage;

use copper_core_lib::registry::modules::{ModuleOrigin, ModuleRegistry};
use copper_core_lib::error::KernelError;

pub use manifest::{Manifest, ManifestError};
pub use module::{DemoModule, I18N_NAMESPACE, MANIFEST_JSON, MODULE_ID};

/// 向内核模块注册表登记本模块（来源标记为附加模块）。
///
/// 为什么用 `register_with_origin(.., Addon)` 而不是 `register(..)`：后者默认按内置处理，
/// 会让模块绕过沙箱管辖，属于安全相关的默认值错误（内核源码 `registry/modules.rs` 的注释
/// 明确要求附加模块显式声明来源）。
///
/// 返回 `Result<(), ManifestError>`：清单无效时应当在装载前就失败，
/// 而不是把一个 id / 命名空间都不可信的模块塞进注册表。
pub fn register(registry: &ModuleRegistry) -> Result<(), ManifestError> {
    // 先自证清单可用：清单是模块一切契约（id / 命名空间 / 迁移 scope / 表前缀）的来源。
    let manifest = module::manifest_result()?;

    let instance = std::sync::Arc::new(DemoModule::new());
    registry.register_with_origin(instance, ModuleOrigin::Addon);

    log::info!(
        "[demo-tools] 已注册到内核（来源=附加模块）: {}",
        manifest.summary()
    );
    Ok(())
}

/// 模块的命令分发入口（阶段二内核装载后由命令框架调用；当前供内核侧手工接线与测试使用）。
///
/// 参数 `name` / `args` 的形状与前端 `call(cmd, args)` 完全一致，
/// 便于内核侧以最小改动把枚举挂到命令宏上。
pub fn dispatch_command(
    kernel: &copper_core_lib::state::KernelContext,
    name: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, KernelError> {
    let cmd = commands::DemoCommand::parse(name, args)?;
    commands::dispatch(kernel, cmd)
}

/// 模块自检入口（仅调试构建提供）。
///
/// 用途：阶段一没有前端包装配链路，模块开发时需要一个「不依赖 Tauri 界面」的验证入口，
/// 打印清单摘要、迁移版本、表名前缀、意图与事件契约，便于对照本仓库文档逐条核对。
/// **不引入 tauri**，因此可以在 `cargo test` / 独立可执行中直接调用。
#[cfg(debug_assertions)]
pub fn run_self_check() {
    match module::manifest_result() {
        Ok(m) => {
            println!("[自检] 清单: {}", m.summary());
            println!(
                "[自检] 契约: i18n_namespace={} | 迁移 scope={} | 表前缀={}",
                m.i18n_namespace,
                m.migration_scope(),
                m.table_prefix()
            );
            println!(
                "[自检] 数据库迁移: 目标版本={}，已定义 {} 项（{}）",
                storage::TARGET_SCHEMA_VERSION,
                storage::MIGRATIONS.len(),
                storage::MIGRATIONS
                    .iter()
                    .map(|m| format!("v{}:{}", m.version, m.name))
                    .collect::<Vec<_>>()
                    .join(" / ")
            );
            println!(
                "[自检] 意图: 声明 {:?}；发起 {}（未声明时返回可读降级）",
                intents::declared_intents(),
                intents::INTENT_EXPOSE_VERSION
            );
            println!(
                "[自检] 事件: 订阅 {} | 发布 {}",
                module::SUBSCRIBED_EVENT,
                module::ACTIVITY_EVENT
            );
        }
        Err(e) => println!("[自检] 清单无效: {}", e.friendly()),
    }

    println!(
        "[自检] 命令契约（与前端 api.ts 逐字一致，共 {} 条）: {}",
        commands::ALL_COMMANDS.len(),
        commands::ALL_COMMANDS.join(" / ")
    );

    match module::is_instance_running() {
        true => println!("[自检] 模块实例: 已构造并存活"),
        false => println!("[自检] 模块实例: 未构造（尚未调用 register）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 命令名常量与前端契约的最终防线：本测试跨文件复述一次契约字符串，
    /// 使「两侧各自改名」这种单侧改动无法静默通过。
    #[test]
    fn command_contract_is_frozen() {
        let expected = [
            "demo_tools_overview",
            "demo_tools_notes_list",
            "demo_tools_note_upsert",
            "demo_tools_note_delete",
            "demo_tools_ping",
            "demo_tools_expose_version",
            "demo_tools_activity_recent",
        ];
        assert_eq!(commands::ALL_COMMANDS, &expected);
    }

    #[test]
    fn manifest_embedded_at_compile_time_matches_module_id() {
        assert!(MANIFEST_JSON.contains("\"copper-lamp.demo-tools\""));
        let m = Manifest::parse_and_validate(MANIFEST_JSON).unwrap();
        assert_eq!(m.id, MODULE_ID);
        assert_eq!(m.i18n_namespace, I18N_NAMESPACE);
    }

    #[test]
    fn dispatch_command_rejects_unknown_command() {
        // 无 KernelContext 时也应先做参数层校验：未知命令立刻失败，不触碰内核。
        let err = commands::DemoCommand::parse("nope", serde_json::Value::Null).unwrap_err();
        assert!(err.friendly().contains("nope"));
    }
}
