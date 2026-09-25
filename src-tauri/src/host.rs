//! 宿主能力客户端：把插件 ABI 的 `call_capability` 包成"调用能力 → 拿回 JSON"。
//!
//! # 为什么要包一层
//!
//! ABI 层面的一次能力调用要处理三件琐事，散落在业务代码里必然有人写漏：
//! 1. **输出缓冲扩容**：宿主先给一块初始缓冲，不够时返回
//!    `ABI_STATUS_BUFFER_TOO_SMALL` 并在 `output.len` 给出所需长度，调用方要扩容重试；
//! 2. **状态码翻译**：`NOT_SUPPORTED`（能力不存在）与 `ERROR`（能力失败）语义不同，
//!    前者可降级、后者不可；
//! 3. **身份与生命周期**：`call_capability` 必须带 `user_data`（宿主绑定的上下文），
//!    插件自己编不出这个值，只能从 `init` 拿到的 `HostApi` 里取。
//!
//! # 诊断能力的诚实说明
//!
//! 宿主在拒绝或失败时只回**状态码**，不回错误正文（helper 的实现决定）。因此这里
//! 只能透出状态码，不能编造原因。需要细节时请查内核日志（helper 的 stderr 会被带上）。

use serde_json::Value;

use copper_module_abi::plugin_abi::{
    AbiBuffer, AbiBytes, HostApi, ABI_STATUS_BUFFER_TOO_SMALL, ABI_STATUS_NOT_SUPPORTED,
    ABI_STATUS_OK, MAX_ABI_BUFFER_BYTES,
};

use crate::error::ModuleError;

/// 首次交给宿主的能力参数缓冲容量；不足时按宿主上报的需求扩容。
const INITIAL_CAPACITY: usize = 1024;
/// 扩容重试上限：防止"每次都报告需要更大缓冲"导致无限循环。
const MAX_ATTEMPTS: usize = 8;

/// 宿主能力客户端。
///
/// 只持有 `HostApi` 的**指针**：该结构由宿主持有，生命周期覆盖整个插件实例
/// （ABI 文档明确保证它在 `destroy` 之前有效），因此这里无需（也无法）负责释放。
pub struct HostClient {
    host: *const HostApi,
}

impl HostClient {
    /// 从 `init` 收到的宿主 API 构造客户端。
    ///
    /// 调用方必须已确认 `host` 非空且通过校验（见 [`crate::lib`] 的 `init`）。
    ///
    /// # Safety
    ///
    /// `host` 必须是宿主传入、且在插件实例析构前始终有效的那一个指针。
    pub unsafe fn new(host: *const HostApi) -> Self {
        Self { host }
    }

    /// 调用一项宿主能力，返回其 JSON 结果。
    pub fn call(&self, capability: &str, params: &Value) -> Result<Value, ModuleError> {
        let host = unsafe { self.host.as_ref() }.ok_or(ModuleError::CapabilityFailed {
            capability: capability.to_owned(),
            status: -1,
        })?;
        let callback = host.call_capability.ok_or(ModuleError::CapabilityUnsupported {
            capability: capability.to_owned(),
        })?;

        let capability_bytes = bytes_of(capability.as_bytes());
        let encoded = serde_json::to_vec(params)?;
        let input = bytes_of(&encoded);

        let mut capacity = INITIAL_CAPACITY;
        for _ in 0..MAX_ATTEMPTS {
            let mut buffer = vec![0_u8; capacity];
            let mut output = AbiBuffer {
                ptr: buffer.as_mut_ptr(),
                capacity: buffer.len() as u64,
                len: 0,
            };

            let status = unsafe {
                callback(
                    host.user_data,
                    capability_bytes,
                    input,
                    &mut output as *mut AbiBuffer,
                )
            };

            match status {
                ABI_STATUS_OK => {
                    let len = usize::try_from(output.len).unwrap_or(usize::MAX);
                    if len > capacity {
                        // 宿主报告的长度超过它给的容量：契约被违反，不能按越界长度读。
                        return Err(ModuleError::CapabilityFailed {
                            capability: capability.to_owned(),
                            status,
                        });
                    }
                    buffer.truncate(len);
                    return serde_json::from_slice(&buffer).map_err(ModuleError::from);
                }
                ABI_STATUS_BUFFER_TOO_SMALL => {
                    let required = usize::try_from(output.len).unwrap_or(usize::MAX);
                    // 要求"更大但不超上限"才是合法的扩容请求；否则重试必然失败。
                    if required <= capacity || required > MAX_ABI_BUFFER_BYTES {
                        return Err(ModuleError::CapabilityFailed {
                            capability: capability.to_owned(),
                            status,
                        });
                    }
                    capacity = required;
                }
                ABI_STATUS_NOT_SUPPORTED => {
                    return Err(ModuleError::CapabilityUnsupported {
                        capability: capability.to_owned(),
                    })
                }
                other => {
                    return Err(ModuleError::CapabilityFailed {
                        capability: capability.to_owned(),
                        status: other,
                    })
                }
            }
        }

        Err(ModuleError::CapabilityFailed {
            capability: capability.to_owned(),
            status: ABI_STATUS_BUFFER_TOO_SMALL,
        })
    }
}

/// 把字节切片包成 ABI 字节块。空切片用空指针，符合 ABI 的校验规则。
fn bytes_of(bytes: &[u8]) -> AbiBytes {
    if bytes.is_empty() {
        AbiBytes {
            ptr: std::ptr::null(),
            len: 0,
        }
    } else {
        AbiBytes {
            ptr: bytes.as_ptr(),
            len: bytes.len() as u64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use copper_module_abi::plugin_abi::{ABI_STATUS_ERROR, ABI_VERSION};
    use std::cell::{Cell, RefCell};
    use std::ffi::c_void;

    /// 记录调用并按固定脚本应答的假宿主。
    struct FakeHost {
        calls: RefCell<Vec<String>>,
        payload: Vec<u8>,
        /// 为真时先要求扩容（返回 `BUFFER_TOO_SMALL`），下次再真正应答。
        grow_first: Cell<bool>,
        status: i32,
    }

    unsafe extern "C" fn fake_call(
        user_data: *mut c_void,
        capability: AbiBytes,
        _input: AbiBytes,
        output: *mut AbiBuffer,
    ) -> i32 {
        let fake = unsafe { &*(user_data as *const FakeHost) };
        let name = unsafe {
            std::str::from_utf8(std::slice::from_raw_parts(
                capability.ptr,
                capability.len as usize,
            ))
            .unwrap_or("<bad utf8>")
        };
        fake.calls.borrow_mut().push(name.to_owned());

        let output = unsafe { &mut *output };
        if fake.grow_first.get() {
            fake.grow_first.set(false);
            // 要求一个明显大于初始容量的缓冲。
            output.len = (fake.payload.len() as u64).max(4096);
            return ABI_STATUS_BUFFER_TOO_SMALL;
        }
        if fake.status != ABI_STATUS_OK {
            return fake.status;
        }
        if output.ptr.is_null() || output.capacity < fake.payload.len() as u64 {
            output.len = fake.payload.len() as u64;
            return ABI_STATUS_BUFFER_TOO_SMALL;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(fake.payload.as_ptr(), output.ptr, fake.payload.len());
        }
        output.len = fake.payload.len() as u64;
        ABI_STATUS_OK
    }

    /// 假宿主 + 指向它的 `HostApi`。
    ///
    /// 字段顺序即释放顺序：`host` 先于 `fake` 释放，避免 `HostApi` 的 `user_data`
    /// 短暂悬垂（虽然本例不 deref，但顺序正确才经得起后续改动）。
    struct Fixture {
        host: Box<HostApi>,
        fake: Box<FakeHost>,
    }

    impl Fixture {
        fn new(payload: &str, grow_first: bool, status: i32) -> Self {
            let fake = Box::new(FakeHost {
                calls: RefCell::new(Vec::new()),
                payload: payload.as_bytes().to_vec(),
                grow_first: Cell::new(grow_first),
                status,
            });
            let host = Box::new(HostApi {
                struct_size: std::mem::size_of::<HostApi>() as u32,
                abi_version: ABI_VERSION,
                // 指向堆上内容：`Box` 本身移动不影响该地址。
                user_data: (&*fake) as *const FakeHost as *mut c_void,
                call_capability: Some(fake_call),
            });
            Self { host, fake }
        }

        fn client(&self) -> HostClient {
            unsafe { HostClient::new(self.host.as_ref()) }
        }
    }

    #[test]
    fn call_returns_the_host_payload() {
        let fixture = Fixture::new(r#"{"value":7}"#, false, ABI_STATUS_OK);
        let client = fixture.client();

        let result = client.call("storage.get", &serde_json::json!({ "key": "a" })).unwrap();

        assert_eq!(result["value"], serde_json::json!(7));
    }

    #[test]
    fn call_grows_the_buffer_and_retries() {
        let fixture = Fixture::new(r#"{"big":"x"}"#, true, ABI_STATUS_OK);
        let client = fixture.client();

        let result = client.call("storage.list", &serde_json::json!({})).unwrap();

        assert_eq!(result["big"], serde_json::json!("x"));
        // 一次扩容请求 + 一次成功返回：扩容重试必须真的发生，否则大响应会静默截断。
        let calls = fixture.fake.calls.borrow();
        assert_eq!(calls.len(), 2, "应当先要求扩容再重试，实际调用：{calls:?}");
    }

    #[test]
    fn not_supported_is_distinguishable_from_failure() {
        let unsupported = Fixture::new("", false, ABI_STATUS_NOT_SUPPORTED);
        assert!(matches!(
            unsupported.client().call("events.publish", &serde_json::json!({})),
            Err(ModuleError::CapabilityUnsupported { .. })
        ));

        let failed = Fixture::new("", false, ABI_STATUS_ERROR);
        assert!(matches!(
            failed.client().call("events.publish", &serde_json::json!({})),
            Err(ModuleError::CapabilityFailed { .. })
        ));
    }

    #[test]
    fn error_kinds_are_stable_for_the_frontend() {
        let error = ModuleError::CapabilityUnsupported {
            capability: "events.publish".to_owned(),
        };
        assert_eq!(error.kind(), "capability_unsupported");
        assert_eq!(error.to_payload()["kind"], serde_json::json!("capability_unsupported"));

        let error = ModuleError::InvalidArgument("x".to_owned());
        assert_eq!(error.kind(), "invalid_argument");
    }
}
