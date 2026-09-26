// 模块后端的调用边界。
//
// 内核侧的 Agent 会话能力（受监管 Node 会话、会话持久化、Pi 命令发现、审批、凭证下发）
// 目前尚未实现；本文件把「前端要调什么」与「现在拿不到结果」两件事分开：
// - 命令名与参数形状在这里单点声明，作为模块 Rust 后端待实现契约的落点；
// - 所有调用都真实发出（`host.invoke` 只作用于本模块自身命令），失败统一归一化为
//   `Failure`，绝不吞掉错误、绝不伪造成功。
//
// 归一化后 UI 才能如实告诉用户「未接入」而不是显示一个假的回答。

import type { Failure } from "./types";
import { hostBridge } from "../host";

/** 模块自身命令名（待模块 Rust 后端与内核 Agent 能力落地后实现）。 */
export const AGENT_COMMANDS = {
  prompt: "agent_session_prompt",
  cancel: "agent_session_cancel",
  sessions: "agent_sessions_list",
  sessionLoad: "agent_session_load",
  sessionDelete: "agent_session_delete",
  commands: "agent_commands_list",
  approval: "agent_approval_respond",
  settingsSave: "agent_settings_save",
  credentialClear: "agent_credential_clear",
} as const;

/** 调用结果：要么拿到数据，要么拿到一个可展示的失败。 */
export type AgentResult<T> = { ok: true; data: T } | { ok: false; failure: Failure };

/** 内核模块调用信封（见模块契约）。 */
interface Envelope {
  ok?: boolean;
  data?: unknown;
  error?: { kind?: string; message?: string };
}

/** 把任意错误归一化为可展示的失败。 */
function toFailure(e: unknown): Failure {
  if (typeof e === "object" && e !== null && "kind" in e) {
    const kind = String((e as { kind: unknown }).kind);
    const message = "message" in e ? String((e as { message: unknown }).message) : "";
    // 内核/模块尚未提供该命令，或不在宿主内：都属于「未接入」，而不是业务失败。
    if (kind === "not_registered" || kind === "invoke_unavailable" || kind === "invoke") {
      return { kind: "not-connected", detail: message };
    }
    const known: Record<string, Failure["kind"]> = {
      no_api_key: "no-api-key",
      model_unavailable: "model-unavailable",
      network: "network",
      rate_limit: "rate-limit",
      credential_unsupported: "credential-unsupported",
    };
    return { kind: known[kind] ?? "not-connected", detail: message };
  }
  return { kind: "not-connected", detail: e instanceof Error ? e.message : String(e) };
}

/** 调用本模块命令；桥不存在、命令未注册、后端报错都返回 `ok: false`。 */
export async function invokeAgent<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<AgentResult<T>> {
  const bridge = hostBridge();
  if (!bridge) return { ok: false, failure: { kind: "not-connected" } };
  try {
    const raw = (await bridge.invoke(command, args ?? null)) as Envelope | undefined;
    if (raw && typeof raw === "object" && "ok" in raw) {
      if (raw.ok) return { ok: true, data: raw.data as T };
      return { ok: false, failure: toFailure(raw.error) };
    }
    // 未按信封返回的载荷按原样接受，避免把已成功的调用误判为失败。
    return { ok: true, data: raw as T };
  } catch (e) {
    return { ok: false, failure: toFailure(e) };
  }
}
