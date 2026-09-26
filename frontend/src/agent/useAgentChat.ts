// Agent 聊天页的状态与交互。
//
// 边界（重要）：
// - 页面只做展示与用户意图转发；Agent 循环、会话持久化、Pi 命令发现都在内核监管的
//   Node 会话里，前端不自行实现，也不硬编码命令表与审批语义。
// - 所有后端动作都真实发出（见 backend.ts）。内核能力未接入时，请求被**丢弃**并如实
//   说明，绝不本地伪造回答、不伪造保存成功。
// - 前端不持久化 API Key：Key 只存在于设置面板的输入缓冲，提交后立即清空。

import { computed, reactive, ref, shallowRef } from "vue";

import { AGENT_COMMANDS, invokeAgent } from "./backend";
import {
  PREVIEW_CAPABILITIES,
  PREVIEW_CURRENT_SESSION_ID,
  PREVIEW_MODEL,
  PREVIEW_SESSIONS,
  previewMessagesCopy,
} from "./previewData";
import type {
  ApprovalMode,
  AssistantMessage,
  CapabilityLimits,
  Message,
  ModelInfo,
  SessionMeta,
} from "./types";

/** 设置面板表单值。`apiKey` 仅存在于内存，提交后清空。 */
export interface SettingsForm {
  provider: string;
  model: string;
  apiBase: string;
  apiKey: string;
}

/** 一次被丢弃/失败的动作提示，用于告知用户请求未被执行。 */
interface Notice {
  id: number;
  key: string;
  /** 失败原因（后端原文），可为空。 */
  detail?: string;
}

const capabilities = ref<CapabilityLimits>({ ...PREVIEW_CAPABILITIES });
const sessions = ref<SessionMeta[]>([...PREVIEW_SESSIONS]);
const currentSessionId = ref<string>(PREVIEW_CURRENT_SESSION_ID);
const model = ref<ModelInfo | null>(PREVIEW_MODEL);
const approvalMode = ref<ApprovalMode>("manual");

const messagesBySession = reactive<Record<string, Message[]>>({
  [PREVIEW_CURRENT_SESSION_ID]: previewMessagesCopy(PREVIEW_CURRENT_SESSION_ID),
});
for (const session of PREVIEW_SESSIONS) {
  if (!messagesBySession[session.id]) messagesBySession[session.id] = previewMessagesCopy(session.id);
}

/** 折叠态覆盖：`会话 id → 块/消息 id → 是否展开`，切换会话不串。 */
const expandedOverrides = reactive<Record<string, Record<string, boolean>>>({});

/** 面板与浮层可见性。 */
const historyOpen = ref(false);
const settingsOpen = ref(false);
const commandsOpen = ref(false);

const notices = shallowRef<Notice[]>([]);
let noticeSeq = 0;

/** 当前会话的消息序列。 */
const currentMessages = computed<Message[]>(() => messagesBySession[currentSessionId.value] ?? []);

/** 当前会话元信息（标题、时间）。 */
const currentSession = computed<SessionMeta | undefined>(() =>
  sessions.value.find((s) => s.id === currentSessionId.value),
);

/** 会话是否正在生成（用于新建会话前先停止、发送按钮变停止）。 */
const running = computed(() =>
  currentMessages.value.some((m) => m.role === "assistant" && m.status === "running"),
);

/** 推送一条动作未执行的提示（自动消失）。 */
function pushNotice(key: string, detail?: string): void {
  const id = ++noticeSeq;
  notices.value = [...notices.value, { id, key, detail }];
  window.setTimeout(() => {
    notices.value = notices.value.filter((n) => n.id !== id);
  }, 5000);
}

function dismissNotice(id: number): void {
  notices.value = notices.value.filter((n) => n.id !== id);
}

// ---------------------------------------------------------------- 折叠态

function overrideOf(sessionId: string, id: string): boolean | undefined {
  return expandedOverrides[sessionId]?.[id];
}

function setOverride(sessionId: string, id: string, expanded: boolean): void {
  expandedOverrides[sessionId] = { ...(expandedOverrides[sessionId] ?? {}), [id]: expanded };
}

/** 任务时间线是否展开：默认生成中展开、完成后折叠，用户手动切换优先。 */
function isTaskExpanded(message: AssistantMessage): boolean {
  const manual = overrideOf(currentSessionId.value, message.id);
  if (manual !== undefined) return manual;
  return message.status === "running";
}

function toggleTask(message: AssistantMessage): void {
  setOverride(currentSessionId.value, message.id, !isTaskExpanded(message));
}

/** 章节行是否展开：默认展开，用户手动切换优先。 */
function isSectionExpanded(blockId: string): boolean {
  return overrideOf(currentSessionId.value, blockId) ?? true;
}

function toggleSection(blockId: string): void {
  setOverride(currentSessionId.value, blockId, !isSectionExpanded(blockId));
}

// ---------------------------------------------------------------- 会话

function selectSession(sessionId: string): void {
  if (sessionId === currentSessionId.value) {
    historyOpen.value = false;
    return;
  }
  currentSessionId.value = sessionId;
  if (!messagesBySession[sessionId]) messagesBySession[sessionId] = previewMessagesCopy(sessionId);
  historyOpen.value = false;
}

/** 新建会话：若存在生成中任务先停止，再开启空会话。 */
async function newSession(): Promise<void> {
  if (running.value) await cancel();
  const id = `session-local-${Date.now()}`;
  sessions.value = [{ id, title: "", updatedAt: Date.now() }, ...sessions.value];
  messagesBySession[id] = [];
  currentSessionId.value = id;
  historyOpen.value = false;
}

/** 删除历史会话：删除是后端持久化动作，后端未接入时不本地删掉假称成功。 */
async function deleteSession(sessionId: string): Promise<void> {
  const result = await invokeAgent(AGENT_COMMANDS.sessionDelete, { sessionId });
  if (!result.ok) {
    pushNotice("agent_notice_delete_dropped", result.failure.detail);
    return;
  }
  sessions.value = sessions.value.filter((s) => s.id !== sessionId);
  delete messagesBySession[sessionId];
  delete expandedOverrides[sessionId];
  if (currentSessionId.value === sessionId) {
    currentSessionId.value = sessions.value[0]?.id ?? "";
    if (currentSessionId.value && !messagesBySession[currentSessionId.value]) {
      messagesBySession[currentSessionId.value] = previewMessagesCopy(currentSessionId.value);
    }
  }
}

// ---------------------------------------------------------------- 生成

/** 追加一条助手消息并返回其引用，便于后续就地更新（流式）。 */
function appendAssistant(fields: Partial<AssistantMessage>): AssistantMessage {
  const message: AssistantMessage = {
    id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    status: "running",
    blocks: [],
    answer: "",
    startedAt: Date.now(),
    ...fields,
  };
  const list = messagesBySession[currentSessionId.value];
  if (list) list.push(message);
  return message;
}

/** 发送一轮提示词。 */
async function send(text: string): Promise<void> {
  const prompt = text.trim();
  if (!prompt || running.value) return;

  const list = messagesBySession[currentSessionId.value];
  if (!list) return;
  list.push({ id: `u-${Date.now()}`, role: "user", text: prompt, at: Date.now() });
  const session = sessions.value.find((s) => s.id === currentSessionId.value);
  if (session) {
    if (!session.title) session.title = prompt.split("\n")[0].slice(0, 40);
    session.updatedAt = Date.now();
  }

  // 未配置 API Key / 平台不支持凭证存储时，请求不会到达模型，直接如实说明。
  if (!capabilities.value.apiKeyConfigured) {
    appendAssistant({ status: "failed", failure: { kind: "no-api-key" }, endedAt: Date.now() });
    return;
  }

  const result = await invokeAgent(AGENT_COMMANDS.prompt, { sessionId: currentSessionId.value, text: prompt });
  if (!result.ok) {
    appendAssistant({ status: "failed", failure: result.failure, endedAt: Date.now() });
    return;
  }
  // 请求已送达内核：后续增量由会话事件驱动（流式事件的订阅随内核能力一并接入）。
  appendAssistant({ progress: { actionKey: "agent_progress_waiting", doneSteps: 0 } });
}

/** 停止生成：取消信号发往内核；无论内核是否响应，界面都冻结时间线并追加「已取消」。 */
async function cancel(): Promise<void> {
  const targets = currentMessages.value.filter(
    (m): m is AssistantMessage => m.role === "assistant" && m.status === "running",
  );
  if (targets.length === 0) return;
  const result = await invokeAgent(AGENT_COMMANDS.cancel, { sessionId: currentSessionId.value });
  for (const message of targets) {
    message.status = "cancelled";
    message.endedAt = Date.now();
    message.progress = undefined;
  }
  if (!result.ok) pushNotice("agent_notice_cancel_dropped", result.failure.detail);
}

/** 重新发送某轮用户提示词：停止进行中的生成，并在末尾追加新一轮。 */
async function resend(message: AssistantMessage): Promise<void> {
  const list = messagesBySession[currentSessionId.value];
  if (!list) return;
  const index = list.findIndex((m) => m.id === message.id);
  let prompt: string | undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = list[i];
    if (candidate.role === "user") {
      prompt = candidate.text;
      break;
    }
  }
  if (!prompt) return;
  if (running.value) await cancel();
  await send(prompt);
}

/** 审批响应：允许 / 拒绝。语义以 Pi 权限能力为准，此处只转发并如实反馈。 */
async function respondApproval(blockId: string, allowed: boolean): Promise<void> {
  const list = messagesBySession[currentSessionId.value];
  if (!list) return;
  const result = await invokeAgent(AGENT_COMMANDS.approval, {
    sessionId: currentSessionId.value,
    approvalId: blockId,
    allowed,
  });
  const message = list.find(
    (m): m is AssistantMessage =>
      m.role === "assistant" && m.blocks.some((b) => b.id === blockId),
  );
  const block = message?.blocks.find((b) => b.id === blockId);
  if (block?.kind !== "approval") return;
  if (!result.ok) {
    pushNotice("agent_notice_approval_dropped", result.failure.detail);
    return;
  }
  block.state = allowed ? "allowed" : "denied";
  if (!allowed) {
    // 拒绝后该工具不再执行：把同一工具的运行中调用标记为已拒绝。
    for (const b of message?.blocks ?? []) {
      if (b.kind === "tool" && b.call.name === block.tool && b.call.status === "awaiting-approval") {
        b.call.status = "denied";
      }
      if (b.kind === "toolGroup") {
        for (const call of b.calls) {
          if (call.name === block.tool && call.status === "awaiting-approval") call.status = "denied";
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 命令与设置

/** `/` 命令列表：取自 Pi 实际暴露的命令，后端未接入时不硬编码。 */
async function loadCommands(): Promise<{ ok: true; commands: { name: string; description: string }[] } | { ok: false; detail?: string }> {
  const result = await invokeAgent<{ name: string; description: string }[]>(AGENT_COMMANDS.commands, {
    sessionId: currentSessionId.value,
  });
  if (!result.ok) return { ok: false, detail: result.failure.detail };
  return { ok: true, commands: result.data ?? [] };
}

/** 保存设置。API Key 提交后立即从内存清空，不写入任何前端持久化状态。 */
async function saveSettings(form: SettingsForm): Promise<void> {
  const payload = {
    provider: form.provider,
    model: form.model,
    apiBase: form.apiBase,
    // 只在提交瞬间读取，函数返回后由调用方清空输入框。
    apiKey: form.apiKey,
  };
  const result = await invokeAgent(AGENT_COMMANDS.settingsSave, payload);
  if (!result.ok) {
    pushNotice("agent_notice_settings_dropped", result.failure.detail);
    return;
  }
  model.value = form.model ? { provider: form.provider, name: form.model } : null;
  pushNotice("agent_notice_settings_saved");
}

/** 清除已保存的 API Key（内核安全存储）。 */
async function clearApiKey(): Promise<void> {
  const result = await invokeAgent(AGENT_COMMANDS.credentialClear);
  if (!result.ok) {
    pushNotice("agent_notice_credential_clear_dropped", result.failure.detail);
    return;
  }
  capabilities.value = { ...capabilities.value, apiKeyConfigured: false };
}

export function useAgentChat() {
  return {
    // 状态
    capabilities,
    sessions,
    currentSessionId,
    currentSession,
    currentMessages,
    model,
    approvalMode,
    running,
    historyOpen,
    settingsOpen,
    commandsOpen,
    notices,
    // 会话
    selectSession,
    newSession,
    deleteSession,
    // 折叠态
    isTaskExpanded,
    toggleTask,
    isSectionExpanded,
    toggleSection,
    // 生成
    send,
    cancel,
    resend,
    respondApproval,
    // 命令与设置
    loadCommands,
    saveSettings,
    clearApiKey,
    // 提示
    pushNotice,
    dismissNotice,
  };
}
