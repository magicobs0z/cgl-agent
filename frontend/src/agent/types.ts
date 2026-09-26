// Agent 会话的前端数据模型。
//
// 与设计文档「持久化模型」对齐：助手消息保存的是**结构化块序列**，而不是拼接后的纯文本，
// 否则重开历史无法还原任务时间线。因此 UI 直接消费块序列，不再从字符串反解结构。

/** 助手一轮生成的运行状态。 */
export type RunStatus = "running" | "done" | "cancelled" | "failed";

/** 工具调用状态。 */
export type ToolStatus = "running" | "done" | "failed" | "awaiting-approval" | "denied";

/** 时间线中的章节类型；Pi 未提供推理内容时不应出现 `thinking`。 */
export type SectionKind = "references" | "thinking";

/** 一次工具调用。 */
export interface ToolCall {
  id: string;
  /** 工具名（如 `cgl_logs`）；UI 据此取本地化动作描述与图标。 */
  name: string;
  /** 动作对象（文件名、关键词等），用于动作描述插值。 */
  target?: string;
  /** 完整参数文本，悬浮展示。 */
  params: string;
  status: ToolStatus;
  durationMs?: number;
  /** 结果摘要；空字符串表示「未找到结果」。 */
  result?: string;
  /** 失败原因，可展开查看。 */
  error?: string;
}

/** 时间线块。工具区左侧以细线贯穿，故块顺序即真实时序。 */
export type TimelineBlock =
  | { kind: "section"; id: string; section: SectionKind }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "toolGroup"; id: string; calls: ToolCall[] }
  | { kind: "approval"; id: string; tool: string; state: "pending" | "allowed" | "denied" };

/** 需要 UI 明确说明的失败/受限原因。 */
export type FailureKind =
  | "not-connected"
  | "no-api-key"
  | "model-unavailable"
  | "network"
  | "rate-limit"
  | "credential-unsupported";

export interface Failure {
  kind: FailureKind;
  /** 兜底详情（后端返回的原文），可为空。 */
  detail?: string;
}

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  at: number;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  status: RunStatus;
  /** 任务时间线（真实时序）。 */
  blocks: TimelineBlock[];
  /** 最终回答 Markdown 正文；生成中为空。 */
  answer: string;
  startedAt: number;
  endedAt?: number;
  /** 生成中的状态行内容。 */
  progress?: { actionKey: string; actionParam?: string; doneSteps: number };
  failure?: Failure;
}

export type Message = UserMessage | AssistantMessage;

/** 会话列表项（历史浮层数据）。 */
export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** 当前是否有生成中的任务。 */
  busy?: boolean;
}

/** 权限模式：自动执行 / 手动审批，语义以 Pi 权限能力为准。 */
export type ApprovalMode = "auto" | "manual";

/** 模型信息；未配置时为 null。 */
export interface ModelInfo {
  provider: string;
  name: string;
}

/** 页面级受限提示：由内核/平台能力决定，与单轮失败无关。 */
export interface CapabilityLimits {
  /** API Key 已有安全存储且已配置。 */
  apiKeyConfigured: boolean;
  /** 当前平台不支持安全凭证存储。 */
  credentialStorageUnsupported: boolean;
  /** 会话暂不持久化（关闭页面后对话不保留）。 */
  persistenceUnavailable: boolean;
  /** 内核侧 Agent 会话能力是否已接入。 */
  sessionBackendAvailable: boolean;
}
