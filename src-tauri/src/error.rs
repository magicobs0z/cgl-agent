//! 模块侧错误类型。
//!
//! 为什么不用内核的 `KernelError`：插件运行在**独立进程**里，不再链接内核 crate；
//! 而跨进程可见的错误信息只有"宿主返回的状态码"。因此这里定义模块自己的错误类型，
//! 并在边界处（[`crate::host`]）把宿主状态码如实翻译过来——**不把失败伪装成成功**。

use serde_json::Value;

/// 模块命令与能力调用的统一错误。
#[derive(Debug, thiserror::Error)]
pub enum ModuleError {
    /// 宿主明确表示"没有这个能力"（`ABI_STATUS_NOT_SUPPORTED`）。
    ///
    /// 与 [`ModuleError::CapabilityFailed`] 分开：前者是"这份内核不提供该能力"，
    /// 调用方据此降级是合理的；后者是"能力存在但这次调用失败"，不该当作可降级。
    #[error("宿主未提供能力 `{capability}`")]
    CapabilityUnsupported { capability: String },

    /// 能力调用返回错误状态码。
    ///
    /// `status` 是宿主回传的原始状态码：插件无法得知更细的原因（宿主只回状态码），
    /// 因此这里如实透出状态码而不是编造原因。
    #[error("能力 `{capability}` 调用失败（宿主状态码 {status}）")]
    CapabilityFailed { capability: String, status: i32 },

    /// 参数不合法（命令层对前端的统一失败语义）。
    #[error("参数不合法: {0}")]
    InvalidArgument(String),

    /// 插件尚未 `start`，命令不可用。
    #[error("模块尚未启动（宿主未调用 start）")]
    NotStarted,

    /// 未知命令：如实列出本模块支持的命令。
    #[error("未知命令 `{command}`；本模块支持: {supported}")]
    UnknownCommand { command: String, supported: String },

    /// 序列化 / 反序列化失败。
    #[error("JSON 处理失败: {0}")]
    Json(#[from] serde_json::Error),
}

impl ModuleError {
    /// 人类可读的短消息（跨 ABI 只传文本，故统一走这里）。
    pub fn friendly(&self) -> String {
        self.to_string()
    }

    /// 命令层统一返回给前端的失败结构。
    ///
    /// 形状与内核命令层的 `CommandError` 对齐（`kind` + `message`），前端无需为
    /// 附加模块准备第二套错误渲染。
    pub fn to_payload(&self) -> Value {
        serde_json::json!({
            "kind": self.kind(),
            "message": self.friendly(),
        })
    }

    /// 稳定的错误分类（前端据此决定提示语气）。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::CapabilityUnsupported { .. } => "capability_unsupported",
            Self::CapabilityFailed { .. } => "capability_failed",
            Self::InvalidArgument(_) => "invalid_argument",
            Self::NotStarted => "not_started",
            Self::UnknownCommand { .. } => "unknown_command",
            Self::Json(_) => "serde",
        }
    }
}
