/**
 * 会话核心：provider 无关。
 *
 * 职责边界：
 * - 持有唯一的 `Agent` 实例与内存会话历史；Pi 的 sqlite 会话后端**不启用**，
 *   会话的唯一真相源是模块数据库，Node 侧只按 `session.load` 重建上下文种子。
 * - 把 Pi 的 `AgentEvent` 映射成协议里的 `RunEvent`，并在 `message_end` 时下发
 *   权威的助手消息快照供 Host 落库。
 * - 校验命令的前置条件（握手、模型、凭证、单 run 互斥），把失败变成协议错误帧。
 *
 * 不负责：进程与 IPC 的字节传输（transport.ts）、代理（proxy-fetch.ts）、
 * provider 的具体线协议（provider-openai.ts）。provider 由依赖注入传入，
 * 因此离线测试可以把工厂换成 faux provider，而生产代码里不留任何测试开关。
 */

import { createHash } from "node:crypto";
// 刻意按「上游模块」而不是「包根」导入：包根 index.ts 会把整个 agent harness
// （skills / compaction / session 存储 / shell 工具 / 联网搜索 / 代理）一并拉进
// 产物，而其中一部分正是本模块不允许持有的能力（拉起进程、裸文件读写）。
// 只取 Agent 与它的事件类型，产物里就只有我们需要的那几个模块。
import { Agent } from "@earendil-works/pi-agent-core/agent";
import type { AgentEvent } from "@earendil-works/pi-agent-core/types";
import {
	createModels,
	type AssistantMessage,
	type Context,
	type Message,
	type Models,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamFn,
	type Usage,
} from "@earendil-works/pi-ai";
import { createProxyFetch, type ProxyEnv } from "./proxy-fetch.ts";
import {
	LIMITS,
	PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	parseHostFrame,
	redact,
	type ErrorCode,
	type HostFrame,
	type HostModelDescriptor,
	type HostSeedMessage,
	type PersistedAssistantMessage,
	type PersistedContentBlock,
	type PersistedUsage,
	type RunEvent,
	type RuntimeFrame,
} from "./protocol.ts";

/**
 * 内容预算：单条助手消息落库前的内容裁剪上限。
 *
 * 存在理由是「出站帧有界」——一条超长回答不应把单帧顶到上限而让整条消息
 * 无法落库。命中裁剪时 `truncated` 会置位，Host 据此告警，而不是静默接受
 * 一份不完整的历史。
 */
const CONTENT_BUDGETS = { textChars: 32_000, thinkingChars: 8_000 } as const;

/** 面向模型的系统提示。非 i18n 文案：它不展示给用户，只约束模型行为。 */
const SYSTEM_PROMPT = [
	"你是铜傀儡（CopperGolem）启动器内置的助手。铜傀儡是 Minecraft 基岩版的模块化启动器。",
	"",
	"行为准则：",
	"- 用与用户相同的语言回答。",
	"- 只依据你确实知道的信息回答；不确定就直说不确定，不要编造版本号、文件路径或接口名。",
	"- 回答力求简短直接，先给结论再给必要的说明。",
	"- 当前你没有任何工具可用（不能读写文件、不能联网、不能执行命令）。若用户的请求需要这些能力，"
		+ "直接说明你做不到，并给出用户可自行执行的步骤，不要假装已执行。",
].join("\n");

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface SessionProviderInput {
	descriptor: HostModelDescriptor;
	getApiKey: () => string | undefined;
}

export interface SessionDeps {
	/** 写一帧出站数据。实现方保证「超限即抛错」，本层负责降级。 */
	emit: (frame: RuntimeFrame) => void;
	/** 建 provider。生产为 openai-completions 工厂，离线测试为 faux。 */
	createProvider: (input: SessionProviderInput) => Provider;
	supportedApis?: readonly string[];
	/** 传给 provider 的代理环境变量（由内核注入）。 */
	env: ProxyEnv;
	/** 运行时自述，出现在 `ready` 帧里。 */
	runtime: { name: string; version: string; node: string };
	/** 覆盖默认系统提示（离线测试用）。 */
	systemPrompt?: string;
}

export interface AgentSession {
	/** 处理一帧入站数据（已按字节边界切好行）。 */
	handleFrame(line: string): Promise<void>;
	/** 当前需要脱敏的密钥清单。 */
	listSecrets(): readonly string[];
	/** 是否已收到 shutdown，或握手失败而应终止进程。 */
	isShuttingDown(): boolean;
}

interface ActiveRun {
	/** 触发本 run 的 prompt 帧 id，也是 `cancel.targetId` 与事件帧的 `runId`。 */
	frameId: string;
	seq: number;
	usage: PersistedUsage;
	lastStopReason: string | undefined;
	/** 本 run 是否已下发过失败信号，避免重复报错。 */
	errorReported: boolean;
}

export function createSession(deps: SessionDeps): AgentSession {
	const credentials = new Map<string, { credentialId: string; apiKey: string }>();
	const models: Models = createModels();
	const proxyFetch = createProxyFetch(deps.env);

	let initialized = false;
	let shuttingDown = false;
	let sessionId: string | undefined;
	let descriptor: HostModelDescriptor | undefined;
	let transcript: Message[] = [];
	let agent: Agent | undefined;
	let active: ActiveRun | undefined;

	// ---- 出站工具 ----

	function fail(id: string | undefined, code: ErrorCode, message: string): void {
		deps.emit(id === undefined ? { type: "error", code, message } : { type: "error", id, code, message });
	}

	function ok(id: string, result?: unknown): void {
		deps.emit(result === undefined ? { type: "ok", id } : { type: "ok", id, result });
	}

	/** 写事件帧；超限时降级为一帧错误事件，保证该 run 的事件序列不被静默截断。 */
	function emitEvent(run: ActiveRun, event: RunEvent): void {
		try {
			deps.emit({ type: "event", runId: run.frameId, seq: run.seq, event });
			run.seq += 1;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			deps.emit({
				type: "event",
				runId: run.frameId,
				seq: run.seq,
				event: { type: "error", code: "outbound_too_large", message: `事件帧无法下发：${detail}` },
			});
			run.seq += 1;
		}
	}

	// ---- 历史与 Agent 构造 ----

	/**
	 * 历史里的助手消息需要补齐 provider 元数据（`Message` 的必填字段），
	 * 使重建的上下文与真实响应同形。系统提示由 Agent 自行维护，不在历史里。
	 */
	function normalizeTranscript(): Message[] {
		if (!descriptor) return transcript;
		const { api, provider, model } = { api: descriptor.api, provider: descriptor.provider, model: descriptor.model.id };
		return transcript.map((message) =>
			message.role === "assistant" ? { ...message, api, provider, model } : message,
		);
	}

	function rebuildAgent(): void {
		if (!descriptor) {
			agent = undefined;
			return;
		}
		const model: Model | undefined = models.getModel(descriptor.provider, descriptor.model.id);
		if (!model) {
			agent = undefined;
			return;
		}
		agent = new Agent({
			initialState: {
				systemPrompt: deps.systemPrompt ?? SYSTEM_PROMPT,
				model,
				messages: normalizeTranscript(),
			},
			streamFn: createStreamFn(models, proxyFetch),
		});
	}

	// ---- 事件映射 ----

	function onAgentEvent(run: ActiveRun, event: AgentEvent): void {
		switch (event.type) {
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") emitEvent(run, { type: "text_delta", delta: inner.delta });
				else if (inner.type === "thinking_delta") emitEvent(run, { type: "thinking_delta", delta: inner.delta });
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message.role !== "assistant") break;
				accumulateUsage(run, message.usage);
				run.lastStopReason = message.stopReason;
				emitEvent(run, { type: "assistant_message", message: toPersistedMessage(message) });
				break;
			}
			case "tool_execution_start":
				emitEvent(run, {
					type: "tool_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					argsDigest: digest(event.args),
				});
				break;
			case "tool_execution_end":
				emitEvent(run, {
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					resultDigest: digest(event.result),
				});
				break;
			default:
				// agent_start / turn_start / turn_end 等是 Pi 的内部生命周期，协议不转发。
				break;
		}
	}

	function accumulateUsage(run: ActiveRun, usage: Usage): void {
		run.usage.input += usage.input;
		run.usage.output += usage.output;
		run.usage.cacheRead += usage.cacheRead;
		run.usage.cacheWrite += usage.cacheWrite;
		run.usage.totalTokens += usage.totalTokens;
		run.usage.cost.input += usage.cost.input;
		run.usage.cost.output += usage.cost.output;
		run.usage.cost.cacheRead += usage.cost.cacheRead;
		run.usage.cost.cacheWrite += usage.cost.cacheWrite;
		run.usage.cost.total += usage.cost.total;
	}

	// ---- run 执行 ----

	async function runPrompt(frame: Extract<HostFrame, { type: "prompt" }>): Promise<void> {
		const run: ActiveRun = {
			frameId: frame.id,
			seq: 0,
			usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
			lastStopReason: undefined,
			errorReported: false,
		};
		active = run;
		emitEvent(run, { type: "run_start" });

		const current = agent;
		if (!current) {
			emitEvent(run, { type: "error", code: "no_model", message: "尚未选定可用模型" });
			run.errorReported = true;
			finishRun(run, "error");
			return;
		}

		const unsubscribe = current.subscribe((event) => onAgentEvent(run, event));
		try {
			await current.prompt(frame.text);
		} catch (error) {
			emitEvent(run, { type: "error", code: "internal", message: errorText(error) });
			run.errorReported = true;
		} finally {
			unsubscribe();
		}

		const stopReason = run.lastStopReason ?? "error";
		if (stopReason === "error" && !run.errorReported) {
			const last = lastAssistantMessage(current);
			emitEvent(run, {
				type: "error",
				code: "model_error",
				message: redact(last?.errorMessage ?? "模型调用失败", sessionSecrets()),
			});
			run.errorReported = true;
		}

		// 后续上下文与落库都以 Agent 的实际历史为准，而不是我们拼装的事件流。
		transcript = current.state.messages.filter((message) => message.role !== "system");
		finishRun(run, stopReason);
	}

	function finishRun(run: ActiveRun, stopReason: string): void {
		emitEvent(run, { type: "run_end", stopReason, usage: run.usage });
		active = undefined;
	}

	function lastAssistantMessage(current: Agent): AssistantMessage | undefined {
		const messages = current.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message.role === "assistant") return message;
		}
		return undefined;
	}

	// ---- 命令处理 ----

	function handleHello(frame: Extract<HostFrame, { type: "hello" }>): void {
		if (initialized) {
			fail(frame.id, "already_initialized", "会话已握手");
			return;
		}
		const common = frame.protocolVersions.filter((version) => SUPPORTED_PROTOCOL_VERSIONS.includes(version));
		if (common.length === 0) {
			fail(
				frame.id,
				"unsupported_version",
				`协议版本不相交：Host 支持 [${frame.protocolVersions.join(", ")}]，`
					+ `运行时支持 [${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}]`,
			);
			// 版本不交会就没有继续对话的意义：置位后由入口终止进程。
			shuttingDown = true;
			return;
		}
		initialized = true;
		deps.emit({ type: "ready", protocolVersion: PROTOCOL_VERSION, runtime: deps.runtime });
		ok(frame.id);
	}

	function handleModelSet(frame: Extract<HostFrame, { type: "model.set" }>): void {
		if (active) {
			fail(frame.id, "busy", "有正在进行的 run，无法切换模型");
			return;
		}
		if (deps.supportedApis && !deps.supportedApis.includes(frame.model.api)) {
			fail(frame.id, "bad_request", `API ${frame.model.api} 不受此运行时支持`);
			return;
		}
		if (!credentials.has(frame.model.provider)) {
			fail(frame.id, "bad_request", `provider ${frame.model.provider} 尚未下发凭证，请先发送 credentials.set`);
			return;
		}
		descriptor = frame.model;
		models.setProvider(
			deps.createProvider({
				descriptor: frame.model,
				getApiKey: () => credentials.get(frame.model.provider)?.apiKey,
			}),
		);
		rebuildAgent();
		ok(frame.id);
	}

	function handleSessionLoad(frame: Extract<HostFrame, { type: "session.load" }>): void {
		if (active) {
			fail(frame.id, "busy", "有正在进行的 run，无法重建会话");
			return;
		}
		sessionId = frame.sessionId;
		transcript = frame.messages.map(seedToMessage);
		rebuildAgent();
		ok(frame.id, { sessionId, messageCount: transcript.length });
	}

	function handlePrompt(frame: Extract<HostFrame, { type: "prompt" }>): void {
		if (active) {
			fail(frame.id, "busy", "已有 run 在进行，请先等待结束或发送 cancel");
			return;
		}
		if (!agent) {
			fail(frame.id, "no_model", "尚未通过 model.set 选定模型");
			return;
		}
		ok(frame.id);
		// 刻意不 await：run 期间传输层必须继续处理 cancel 等命令。
		void runPrompt(frame);
	}

	function handleCancel(frame: Extract<HostFrame, { type: "cancel" }>): void {
		if (!active || active.frameId !== frame.targetId) {
			ok(frame.id, { cancelled: false });
			return;
		}
		agent?.abort();
		ok(frame.id, { cancelled: true });
	}

	function sessionSecrets(): readonly string[] {
		return [...credentials.values()].map((entry) => entry.apiKey);
	}

	return {
		listSecrets: sessionSecrets,
		isShuttingDown: () => shuttingDown,

		async handleFrame(line: string): Promise<void> {
			const parsed = parseHostFrame(line);
			if (!parsed.ok) {
				fail(parsed.id, parsed.code, parsed.message);
				return;
			}
			const frame = parsed.frame;

			if (!initialized && frame.type !== "hello") {
				fail(frame.id, "not_initialized", "尚未握手，请先发送 hello");
				return;
			}

			switch (frame.type) {
				case "hello":
					handleHello(frame);
					return;
				case "credentials.set":
					credentials.set(frame.provider, { credentialId: frame.credentialId, apiKey: frame.apiKey });
					ok(frame.id);
					return;
				case "credentials.clear":
					credentials.delete(frame.provider);
					ok(frame.id);
					return;
				case "model.set":
					handleModelSet(frame);
					return;
				case "session.load":
					handleSessionLoad(frame);
					return;
				case "prompt":
					handlePrompt(frame);
					return;
				case "cancel":
					handleCancel(frame);
					return;
				case "ping":
					deps.emit({ type: "pong", id: frame.id });
					return;
				case "shutdown":
					shuttingDown = true;
					agent?.abort();
					ok(frame.id);
					return;
				default: {
					const exhaustive: never = frame;
					fail(
						(exhaustive as { id?: string }).id,
						"unknown_type",
						`未知帧类型：${(exhaustive as { type: string }).type}`,
					);
					return;
				}
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function seedToMessage(seed: HostSeedMessage): Message {
	if (seed.role === "user") {
		return { role: "user", content: [{ type: "text", text: seed.text }], timestamp: seed.timestamp };
	}
	return {
		role: "assistant",
		content: [{ type: "text", text: seed.text }],
		// 真实值在 normalizeTranscript() 里按当前模型描述补齐。
		api: "" as AssistantMessage["api"],
		provider: "",
		model: "",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: seed.timestamp,
	};
}

function toPersistedMessage(message: AssistantMessage): PersistedAssistantMessage {
	let truncated = false;
	const content: PersistedContentBlock[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			const text = clampText(block.text, CONTENT_BUDGETS.textChars);
			if (text !== block.text) truncated = true;
			content.push({ type: "text", text });
			continue;
		}
		if (block.type === "thinking") {
			const thinking = clampText(block.thinking, CONTENT_BUDGETS.thinkingChars);
			if (thinking !== block.thinking) truncated = true;
			content.push({ type: "thinking", thinking });
			continue;
		}
		content.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments });
	}

	return {
		role: "assistant",
		content,
		api: message.api,
		provider: message.provider,
		model: message.model,
		usage: message.usage,
		stopReason: message.stopReason,
		timestamp: message.timestamp,
		...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		...(truncated ? { truncated } : {}),
	};
}

function clampText(text: string, budget: number): string {
	return text.length <= budget ? text : text.slice(0, budget);
}

/** 参数/结果的定长摘要：对话流只需要「调用了什么、成没成」，不需要载荷原文。 */
function digest(value: unknown): string {
	let serialized: string;
	try {
		serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		serialized = String(value);
	}
	const hash = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
	return `${hash} ${Buffer.byteLength(serialized, "utf8")}B`.slice(0, LIMITS.maxDigestChars);
}

function errorText(error: unknown): string {
	const raw = error instanceof Error ? error.message || error.name : String(error);
	return raw.length > 512 ? `${raw.slice(0, 512)}…` : raw;
}

/**
 * 会话的 `streamFn`：`Models.streamSimple` 恰好满足 `StreamFn` 的形状
 * （`normalizeContext` 对已规范化的 transcript 幂等，可安全二次传入）。
 * 代理 `fetch` 在这里注入——Pi 的 openai-completions 适配器自己不解析代理。
 */
function createStreamFn(models: Models, proxyFetch: typeof globalThis.fetch): StreamFn {
	return (model, context, options) =>
		models.streamSimple(model, context as unknown as Context, {
			...(options ?? {}),
			fetch: proxyFetch,
		} as SimpleStreamOptions);
}