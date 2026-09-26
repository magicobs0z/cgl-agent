// 预览用示例数据（仅用于在没有内核 Agent 会话能力时展示界面）。
//
// 定位说明：
// - 这些数据**不是**后端返回，也不会落库、不会写模块存储；内核会话能力接入后此文件
//   整体不再使用，界面改为消费真实会话（见 backend.ts 的命令契约）。
// - 覆盖设计文档「需覆盖状态」：未配置 API Key、等待回答/流式回答/取消中、
//   模型连接失败、网络错误、限流、工具运行/完成/被拒绝/失败、平台不支持安全凭证存储、
//   会话不持久化提示、历史为空、`/` 无匹配结果。
// - 会话正文是示例内容，不参与 i18n；界面文案一律走 `t()`。
//
// 示例会话放在历史浮层里，可切换查看：当前会话对齐设计稿的「已完成一轮」形态，
// 其余两个会话分别覆盖「生成中 / 待批准」与「各类失败与受限」。

import type { AssistantMessage, CapabilityLimits, Message, ModelInfo, SessionMeta } from "./types";

/** 相对当前时间的分钟数，避免硬编码时间戳导致界面显示成很久以前。 */
function minutesAgo(minutes: number): number {
  return Date.now() - minutes * 60_000;
}

const CURRENT_SESSION = "session-gdk";

/** 会话列表（历史浮层）。 */
export const PREVIEW_SESSIONS: SessionMeta[] = [
  { id: CURRENT_SESSION, title: "GDK 安装问题咨询", updatedAt: minutesAgo(2) },
  { id: "session-states", title: "页面状态自检", updatedAt: minutesAgo(46) },
  { id: "session-diag", title: "启动器下载失败排查", updatedAt: minutesAgo(133), busy: true },
];

/** 默认打开的会话。 */
export const PREVIEW_CURRENT_SESSION_ID = CURRENT_SESSION;

/** 页面级能力限制：内核会话能力未接入；会话暂不持久化需如实告知用户。 */
export const PREVIEW_CAPABILITIES: CapabilityLimits = {
  apiKeyConfigured: true,
  credentialStorageUnsupported: false,
  persistenceUnavailable: true,
  sessionBackendAvailable: false,
};

/** 模型信息；未配置时为 null（届时输入栏提示前往设置）。 */
export const PREVIEW_MODEL: ModelInfo | null = { provider: "openai-compatible", name: "gpt-6-sol" };

/** 当前会话：一轮已完成的问答，对齐设计稿形态。 */
const currentSessionMessages: Message[] = [
  {
    id: "m-1",
    role: "user",
    at: minutesAgo(15),
    text: [
      "### 必须覆盖的页面状态",
      "- 首次使用、尚未配置 API Key",
      "- 等待回答、流式回答、取消中",
      "- 模型连接失败、网络错误、限流",
      "- 诊断工具运行、完成、被拒绝或失败",
      "- 当前平台不支持安全凭证存储",
      "- 会话暂不持久化时，清晰说明关闭页面后对话不会保留",
    ].join("\n"),
  },
  {
    id: "m-2",
    role: "assistant",
    status: "done",
    startedAt: minutesAgo(15),
    endedAt: minutesAgo(2),
    blocks: [
      { kind: "section", id: "b-1", section: "references" },
      {
        kind: "toolGroup",
        id: "b-2",
        calls: [
          {
            id: "t-1",
            name: "cgl_launcher_info",
            params: '{ "include": ["modules", "paths"] }',
            status: "done",
            durationMs: 412,
            result: "内核 0.1.0 · win-x86_64 · 已加载 4 个模块，0 个失败",
          },
          {
            id: "t-2",
            name: "cgl_versions",
            params: "{}",
            status: "done",
            durationMs: 268,
            result: "找到 3 个已安装版本，其中 1 个未注册",
          },
        ],
      },
      {
        kind: "tool",
        id: "b-3",
        call: {
          id: "t-3",
          name: "cgl_logs",
          target: "GDK",
          params: '{ "query": "GDK", "context": 3, "limit": 200 }',
          status: "failed",
          durationMs: 37,
          error: "内核未提供日志读取命令，该工具未注册（见 MCP 工具设计·阻塞项）。",
        },
      },
      {
        kind: "reasoning",
        id: "b-4",
        text: "版本列表本身能读到，说明不是数据库或路径问题；GDK 相关报错只出现在日志里，而日志工具当前不可用，因此只能给出不依赖日志的判断与自查步骤。",
      },
      {
        kind: "tool",
        id: "b-5",
        call: {
          id: "t-4",
          name: "cgl_game_install_status",
          params: "{}",
          status: "done",
          durationMs: 611,
          result: "整包缓存命中 2 项，1 项解包失败后已清理",
        },
      },
      { kind: "approval", id: "b-6", tool: "cgl_mod_search", state: "allowed" },
      {
        kind: "tool",
        id: "b-7",
        call: {
          id: "t-5",
          name: "cgl_mod_search",
          target: "GDK",
          params: '{ "query": "GDK", "limit": 10 }',
          status: "done",
          durationMs: 903,
          result: "",
        },
      },
    ],
    answer: [
      "## 结论",
      "",
      "从可读到的信息看，你的 GDK 安装问题**不在启动器自身**：版本清单与安装状态都正常，异常只发生在解包环节，且失败后缓存已被清理。",
      "",
      "## 已验证的部分",
      "",
      "1. 内核与模块加载正常，没有失败模块。",
      "2. 3 个版本中 1 个未注册，需要重新注册后才能启动。",
      "3. 整包缓存命中 2 项，说明下载链路可用。",
      "",
      "## 还缺什么",
      "",
      "定位 GDK 的具体报错需要读取内核日志，而日志读取能力在**当前版本尚未启用**（`cgl_logs` 未注册）。在你补充以下信息前，我不对根因下结论：",
      "",
      "- 报错出现的时间点（大致即可）",
      "- 报错文本或截图",
      "- 是否使用了自定义游戏目录",
      "",
      "> 说明：以上判断基于当前可读到的启动器状态，不包含日志内容，因此不作为最终根因结论。",
    ].join("\n"),
  },
];

/** 「页面状态自检」会话：逐条覆盖失败与受限状态。 */
const stateSessionMessages: Message[] = [
  {
    id: "s-0",
    role: "user",
    at: minutesAgo(52),
    text: "把需要覆盖的失败与受限状态各展示一遍。",
  },
  {
    id: "s-1",
    role: "assistant",
    status: "failed",
    startedAt: minutesAgo(52),
    endedAt: minutesAgo(52),
    blocks: [],
    answer: "",
    failure: { kind: "no-api-key" },
  },
  {
    id: "s-2",
    role: "assistant",
    status: "failed",
    startedAt: minutesAgo(51),
    endedAt: minutesAgo(51),
    blocks: [],
    answer: "",
    failure: { kind: "model-unavailable", detail: "provider 返回 404：模型 gpt-6-sol 不存在" },
  },
  {
    id: "s-3",
    role: "assistant",
    status: "failed",
    startedAt: minutesAgo(50),
    endedAt: minutesAgo(50),
    blocks: [],
    answer: "",
    failure: { kind: "network", detail: "connect ETIMEDOUT 104.18.32.7:443" },
  },
  {
    id: "s-4",
    role: "assistant",
    status: "failed",
    startedAt: minutesAgo(49),
    endedAt: minutesAgo(49),
    blocks: [],
    answer: "",
    failure: { kind: "rate-limit", detail: "429 Too Many Requests，retry-after: 20s" },
  },
  {
    id: "s-5",
    role: "assistant",
    status: "failed",
    startedAt: minutesAgo(48),
    endedAt: minutesAgo(48),
    blocks: [],
    answer: "",
    failure: { kind: "credential-unsupported" },
  },
  {
    id: "s-6",
    role: "assistant",
    status: "cancelled",
    startedAt: minutesAgo(47),
    endedAt: minutesAgo(46),
    blocks: [
      { kind: "section", id: "sb-1", section: "references" },
      {
        kind: "tool",
        id: "sb-2",
        call: {
          id: "st-1",
          name: "cgl_downloads",
          params: "{}",
          status: "done",
          durationMs: 288,
          result: "队列为空",
        },
      },
      { kind: "approval", id: "sb-3", tool: "cgl_mod_detail", state: "denied" },
    ],
    answer: "",
  },
];

/** 「下载失败排查」会话：生成中 / 待批准 / 推理文本与工具交错。 */
const diagSessionMessages: Message[] = [
  {
    id: "d-0",
    role: "user",
    at: minutesAgo(140),
    text: "我下载整合包时进度卡在 87% 就不再变化了，帮我看看。",
  },
  {
    id: "d-1",
    role: "assistant",
    status: "done",
    startedAt: minutesAgo(140),
    endedAt: minutesAgo(133),
    blocks: [
      { kind: "section", id: "db-1", section: "references" },
      {
        kind: "tool",
        id: "db-2",
        call: {
          id: "dt-1",
          name: "cgl_downloads",
          params: "{}",
          status: "done",
          durationMs: 254,
          result: "1 个任务：integr.87%，无失败原因",
        },
      },
      {
        kind: "reasoning",
        id: "db-3",
        text: "任务没有失败原因，说明不是写盘或校验失败，而更像卡在单个分片的传输上。需要看设置里的下载镜像与代理是否生效。",
      },
      {
        kind: "tool",
        id: "db-4",
        call: {
          id: "dt-2",
          name: "cgl_settings_snapshot",
          params: "{}",
          status: "done",
          durationMs: 191,
          result: "镜像 gitcode；代理跟随系统",
        },
      },
    ],
    answer: "任务没有失败原因，通常意味着卡在分片传输而不是写盘。建议先切换下载镜像后重试该任务。",
  },
  {
    id: "d-2",
    role: "user",
    at: minutesAgo(4),
    text: "那换镜像重试，顺便确认下这个整合包的依赖有没有问题。",
  },
  {
    id: "d-3",
    role: "assistant",
    status: "running",
    startedAt: minutesAgo(1),
    progress: { actionKey: "agent_progress_tool", actionParam: "cgl_mod_search", doneSteps: 2 },
    blocks: [
      { kind: "section", id: "rb-1", section: "references" },
      {
        kind: "tool",
        id: "rb-2",
        call: {
          id: "rt-1",
          name: "cgl_launcher_info",
          params: '{ "include": ["paths"] }',
          status: "done",
          durationMs: 208,
          result: "游戏目录：D:/MC/CopperGolem",
        },
      },
      {
        kind: "tool",
        id: "rb-3",
        call: {
          id: "rt-2",
          name: "cgl_mod_search",
          target: "整合包依赖",
          params: '{ "query": "整合包依赖", "limit": 10 }',
          status: "running",
        },
      },
      { kind: "approval", id: "rb-4", tool: "cgl_mod_detail", state: "pending" },
      {
        kind: "reasoning",
        id: "rb-5",
        text: "先拿到内容详情才能判断依赖缺失；详情读取需要你批准。",
      },
    ],
    answer: "",
  },
];

const MESSAGES_BY_SESSION: Record<string, Message[]> = {
  [CURRENT_SESSION]: currentSessionMessages,
  "session-states": stateSessionMessages,
  "session-diag": diagSessionMessages,
};

/** 取某会话的消息；未知会话返回空表（历史为空态）。 */
export function previewMessages(sessionId: string): Message[] {
  return MESSAGES_BY_SESSION[sessionId] ?? [];
}

/** 供 `structuredClone` 前的深拷贝：避免预览交互（取消/重发）污染模块级常量。 */
export function previewMessagesCopy(sessionId: string): Message[] {
  const copy = (m: Message): AssistantMessage | Message =>
    m.role === "assistant"
      ? ({ ...m, blocks: m.blocks.map((b) => (b.kind === "toolGroup" ? { ...b, calls: b.calls.map((c) => ({ ...c })) } : b.kind === "tool" ? { ...b, call: { ...b.call } } : { ...b })) } as AssistantMessage)
      : { ...m };
  return previewMessages(sessionId).map(copy);
}
