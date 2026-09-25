//! 铜傀儡模块模板 · 示例模块后端插件（`copper-lamp.demo-tools`）。
//!
//! # 运行形态
//!
//! 本 crate 编译为 **cdylib**，由内核的 helper 进程（`copper-module-helper`）用
//! `libloading` 加载进**独立进程**，经版本化插件 ABI 与内核对话。因此这里：
//!
//! - **不链接内核 crate**：拿不到 `KernelContext`、数据库、事件总线对象；
//!   一切宿主能力经 [`host::HostClient`] 走能力通道（`storage.*` / `events.publish` /
//!   `intent.request` / `module.info`）；
//! - **不使用线程**：helper 主循环一次只处理一帧消息，插件回调串行发生在同一线程
//!   （见 [`state`] 的线程模型说明），状态用 `&mut` 独占即可；
//! - **不直接读写文件**：需要持久化就用 `storage.*`，需要用宿主能力就发能力请求。
//!
//! # 三个方向的"命令"
//!
//! helper 通过同一入口 `invoke` 把三件事都送达本插件，靠**保留前缀**区分
//! （见 `copper_module_abi::ipc`）：
//!
//! | 前缀 | 来源 | 返回值语义 |
//! |---|---|---|
//! | `event.<事件名>` | 宿主推送的内核事件 | 宿主忽略返回值 |
//! | `intent.<意图名>` | 宿主转发的他人意图请求 | 返回值即意图响应，回给请求方 |
//! | 其它 | 前端经 `module_invoke` 调用的模块命令 | 返回值即命令结果 |
//!
//! `event.` 与 `intent.` 是宿主保留前缀，模块**不得**注册同名命令。

mod commands;
mod contract;
mod error;
mod host;
mod intents;
mod service;
mod state;
mod storage;

use std::ffi::c_void;
use std::path::PathBuf;

use copper_module_abi::plugin_abi::{
    AbiBuffer, AbiBytes, HostApi, ABI_STATUS_BUFFER_TOO_SMALL, ABI_STATUS_ERROR, ABI_STATUS_OK,
};
use serde::Deserialize;
use serde_json::Value;

use copper_module_abi::ipc::{
    PLUGIN_COMMAND_EVENT_PREFIX, PLUGIN_COMMAND_INTENT_PREFIX,
};

use crate::commands::DemoCommand;
use crate::contract::MODULE_ID;
use crate::state::{identity_summary, PluginState};

/// 宿主在 `init` 时下发的配置（由内核的 `AddonProxyModule` 组装）。
#[derive(Debug, Default, Deserialize)]
struct InitConfig {
    /// 模块安装目录（只用于日志与自检）。
    #[serde(default)]
    module_dir: String,
    /// 模块版本（与清单一致，由宿主下发）。
    #[serde(default)]
    module_version: String,
}

/// 插件初始化：校验宿主 API → 读宿主配置 → 建立实例状态。
///
/// 任何一步失败都返回错误状态：让内核把该模块标记为装载失败并给出原因，
/// 好过带着半初始化状态继续跑（那种问题表现为"运行起来没反应"，最难查）。
unsafe extern "C" fn init(
    host: *const HostApi,
    config: AbiBytes,
    state_out: *mut *mut c_void,
) -> i32 {
    if host.is_null() || state_out.is_null() {
        return ABI_STATUS_ERROR;
    }
    let host_ref = unsafe { &*host };
    // 结构与版本校验交给 ABI 自己：宿主与插件各持一份定义，只有这里能发现漂移。
    if host_ref.validate().is_err() {
        return ABI_STATUS_ERROR;
    }

    let Some(config) = (unsafe { abi_bytes_to_vec(config) }) else {
        return ABI_STATUS_ERROR;
    };
    let parsed: InitConfig = match serde_json::from_slice(&config) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("[demo-tools] 无法解析宿主配置: {error}");
            return ABI_STATUS_ERROR;
        }
    };

    let state = Box::new(unsafe {
        PluginState::new(
            host,
            PathBuf::from(&parsed.module_dir),
            parsed.module_version.clone(),
        )
    });
    log::info!(
        "[demo-tools] 插件已初始化：{}",
        identity_summary(state.module_dir(), state.module_version())
    );

    unsafe { *state_out = Box::into_raw(state) as *mut c_void };
    ABI_STATUS_OK
}

/// 插件启动：登记启动活动（会作为模块自有事件发布给前端）。
unsafe extern "C" fn start(state: *mut c_void) -> i32 {
    let Some(state) = (unsafe { (state as *mut PluginState).as_mut() }) else {
        return ABI_STATUS_ERROR;
    };
    state.mark_started();
    state.record_activity("module.start", format!("{MODULE_ID} 已启动"));
    ABI_STATUS_OK
}

/// 插件调用入口：三件事（事件 / 意图 / 命令）共用，靠保留前缀区分。
unsafe extern "C" fn invoke(
    state: *mut c_void,
    operation: AbiBytes,
    input: AbiBytes,
    output: *mut AbiBuffer,
) -> i32 {
    let Some(state) = (unsafe { (state as *mut PluginState).as_mut() }) else {
        return ABI_STATUS_ERROR;
    };
    if output.is_null() {
        return ABI_STATUS_ERROR;
    }
    let output = unsafe { &mut *output };

    let Some(operation) = (unsafe { abi_bytes_to_string(operation) }) else {
        return ABI_STATUS_ERROR;
    };
    let args = match unsafe { abi_bytes_to_vec(input) } {
        Some(bytes) if bytes.is_empty() => Value::Null,
        Some(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        None => return ABI_STATUS_ERROR,
    };

    // 内核事件：宿主忽略返回值，出错如实上报即可（没有"回给谁"的问题）。
    if let Some(event) = operation.strip_prefix(PLUGIN_COMMAND_EVENT_PREFIX) {
        return match state.on_kernel_event(event, args) {
            Ok(_) => write_json(output, &Value::Object(Default::default())),
            Err(error) => {
                eprintln!("[demo-tools] 处理内核事件 `{event}` 失败: {error}");
                ABI_STATUS_ERROR
            }
        };
    }

    // 意图转发：返回值会被宿主回给**请求方**，因此必须返回意图本身的响应形状，
    // 不能套命令信封（信封是给前端命令用的，见 `commands` 的文件说明）。
    if let Some(intent) = operation.strip_prefix(PLUGIN_COMMAND_INTENT_PREFIX) {
        return match intents::handle(intent, args) {
            Ok(value) => write_json(output, &value),
            Err(error) => {
                eprintln!("[demo-tools] 意图 `{intent}` 处理失败: {error}");
                ABI_STATUS_ERROR
            }
        };
    }

    // 前端命令：插件 ABI 没有结构化错误通道，故始终返回 OK，把失败装进响应信封。
    let result = DemoCommand::parse(&operation, args)
        .and_then(|command| commands::dispatch(state, command));
    write_json(output, &commands::envelope(result))
}

/// 插件停止：清空运行期状态（命令随即不可用，见 `commands::dispatch`）。
unsafe extern "C" fn stop(state: *mut c_void) -> i32 {
    let Some(state) = (unsafe { (state as *mut PluginState).as_mut() }) else {
        return ABI_STATUS_ERROR;
    };
    state.mark_stopped();
    log::info!("[demo-tools] 插件已停止");
    ABI_STATUS_OK
}

/// 归还插件实例状态。
///
/// 宿主保证 `destroy` 最多被调用一次（`PluginInstance` 自己做了幂等），
/// 这里按"交出所有权"处理：`Box::from_raw` 后立即 drop。
unsafe extern "C" fn destroy(state: *mut c_void) {
    if state.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(state as *mut PluginState) });
}

/// 把 JSON 写入宿主提供的输出缓冲；容量不足时按 ABI 协议上报需求长度。
fn write_json(output: &mut AbiBuffer, value: &Value) -> i32 {
    match serde_json::to_vec(value) {
        Ok(encoded) => write_output(output, &encoded),
        Err(error) => {
            eprintln!("[demo-tools] 响应序列化失败: {error}");
            ABI_STATUS_ERROR
        }
    }
}

/// 把字节写入宿主提供的输出缓冲。
///
/// 容量不足时**必须**写回所需长度再返回 `BUFFER_TOO_SMALL`：宿主据此扩容重试
/// （这是 ABI 约定的唯一"我要更大缓冲"的表达方式）。
fn write_output(output: &mut AbiBuffer, bytes: &[u8]) -> i32 {
    let required = bytes.len() as u64;
    if output.ptr.is_null() || output.capacity < required {
        output.len = required;
        return ABI_STATUS_BUFFER_TOO_SMALL;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), output.ptr, bytes.len());
    }
    output.len = required;
    ABI_STATUS_OK
}

/// 读取宿主/自身提供的字节块。拷贝而非借用：跨 ABI 的裸指针无法携带生命周期。
unsafe fn abi_bytes_to_vec(bytes: AbiBytes) -> Option<Vec<u8>> {
    if bytes.len == 0 {
        return Some(Vec::new());
    }
    if bytes.ptr.is_null() {
        return None;
    }
    let len = usize::try_from(bytes.len).ok()?;
    Some(unsafe { std::slice::from_raw_parts(bytes.ptr, len) }.to_vec())
}

unsafe fn abi_bytes_to_string(bytes: AbiBytes) -> Option<String> {
    String::from_utf8(unsafe { abi_bytes_to_vec(bytes) }?).ok()
}

copper_module_abi::copper_module_plugin! {
    id = "copper-lamp.demo-tools",
    init = init,
    start = start,
    invoke = invoke,
    stop = stop,
    destroy = destroy,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_id_matches_the_manifest_constant() {
        // 宏参数与常量必须一致：宏里的 id 决定宿主校验用的函数表身份，
        // 常量决定能力调用时使用的身份，两者漂移会让插件被内核拒绝装载。
        assert_eq!(MODULE_ID, "copper-lamp.demo-tools");
        assert!(contract::MANIFEST_JSON.contains(MODULE_ID));
    }

    #[test]
    fn output_writer_reports_required_capacity_when_too_small() {
        let mut small = [0_u8; 2];
        let mut output = AbiBuffer {
            ptr: small.as_mut_ptr(),
            capacity: small.len() as u64,
            len: 0,
        };

        let status = write_output(&mut output, b"{\"ok\":true}");

        assert_eq!(status, ABI_STATUS_BUFFER_TOO_SMALL);
        assert_eq!(output.len, 11, "必须写回所需长度，宿主才会扩容重试");
    }

    #[test]
    fn output_writer_copies_when_it_fits() {
        let mut buffer = [0_u8; 32];
        let mut output = AbiBuffer {
            ptr: buffer.as_mut_ptr(),
            capacity: buffer.len() as u64,
            len: 0,
        };

        let status = write_output(&mut output, b"{\"ok\":true}");

        assert_eq!(status, ABI_STATUS_OK);
        assert_eq!(&buffer[..output.len as usize], b"{\"ok\":true}");
    }

    #[test]
    fn init_config_defaults_are_permissive() {
        // 宿主可能不下发某些字段（例如测试夹具）；缺字段应能初始化而不是直接失败。
        let config: InitConfig = serde_json::from_slice(b"{}").unwrap();
        assert!(config.module_dir.is_empty());
        assert!(config.module_version.is_empty());
    }
}
