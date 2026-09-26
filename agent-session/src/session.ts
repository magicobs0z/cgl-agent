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
	AGENT_METHODS,
	AGENT_RUN_EVENT,
	LIMITS,
	PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	WIRE_PROTOCOL_ID,
	parseAgentRequest,
	parseHostFrame,
	redact,
	type AgentRequest,
	type ErrorCode,
	type HostModelDescriptor,
	type HostSeedMessage,
	type PersistedAssistantMessage,
	type PersistedContentBlock,
	type PersistedUsage,
	type RunEvent,
	type RuntimeFrame,
	type WireError,
	type WireHello,
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
	/** 传入 provider 的代理环境变量（由内核注入）。 */
	env: ProxyEnv;
	/**
	 * 运行时自述。
	 *
	 * `name` 出现在 hello 帧的 `runtime` 字段里；`version`/`node` 只用于诊断
	 * 记录（模块版本以内核 manifest 为准，不靠运行时自报）。
	 */
	runtime: { name: string; version: string; node: string };
	/** 覆盖默认系统提示（离线测试用）。 */
	systemPrompt?: string;
}

export interface AgentSession {
	/** 处理一帧入站数据（已按字节边界切好行）。 */
	handleFrame(line: string): Promise<void>;
	/** 当前需要脱敏的密钥清单。 */
	listSecrets(): readonly string[];
	/** 会话是否应结束（收到 shutdown，或已发出 fatal）。 */
	isShuttingDown(): boolean;
	/**
	 * 已发出的 fatal 错误；没有则为 `undefined`。
	 *
	 * 入口据此区分退出码：干净的 `agent.shutdown` 退出 0，协议/runtime 致命错误
	 * 退出非 0，便于内核 supervisor 判断是否属于「可重试的异常退出」。
	 */
	fatalError(): WireError | undefined;
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
	let fatalFailure: WireError | undefined;
	let sessionId: string | undefined;
	let descriptor: HostModelDescriptor | undefined;
	let transcript: Message[] = [];
	let agent: Agent | undefined;
	let active: ActiveRun | undefined;

	// ---- 出站工具 ----

	function fail(id: string, code: ErrorCode, message: string): void {
		deps.emit({ kind: "response", version: PROTOCOL_VERSION, id, error: { code, message } });
	}

	function ok(id: string, result?: unknown): void {
		deps.emit(
			result === undefined
				? { kind: "response", version: PROTOCOL_VERSION, id, result: {} }
				: { kind: "response", version: PROTOCOL_VERSION, id, result },
		);
	}

	/** 协议级错误：会话不可继续，发出 `fatal` 后由入口终止进程。 */
	function fatal(code: ErrorCode, message: string): void {
		shuttingDown = true;
		const error: WireError = { code, message: redact(message, sessionSecrets()).slice(0, 512) };
		fatalFailure ??= error;
		deps.emit({ kind: "fatal", version: PROTOCOL_VERSION, error });
	}

	/** 写事件帧；超限时降级为一帧错误事件，保证该 run 的事件序列不被静默截断。 */
	function emitEvent(run: ActiveRun, event: RunEvent): void {
		const frame = (payload: RunEvent): RuntimeFrame => ({
			kind: "event",
			version: PROTOCOL_VERSION,
			event: AGENT_RUN_EVENT,
			payload: { runId: run.frameId, sequence: run.seq, event: payload },
		});
		try {
			deps.emit(frame(event));
			run.seq += 1;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			deps.emit(frame({ type: "error", code: "outbound_too_large", message: `事件帧无法下发：${detail}` }));
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

	async function runPrompt(params: { text: string }, runId: string): Promise<void> {
		const run: ActiveRun = {
			frameId: runId,
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
			await current.prompt(params.text);
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

	function handleHello(frame: WireHello): void {
		if (initialized) {
			// hello 无 `id`，无法回带关联错误；而「会话已固定到协商版本」后重复握手
			// 说明对端状态与本地不一致，按协议级错误终止。
			fatal("already_initialized", "会话已握手，拒绝重复 hello");
			return;
		}
		const common = frame.supported_versions.filter((version) => SUPPORTED_PROTOCOL_VERSIONS.includes(version));
		if (common.length === 0) {
			// 版本不交会就没有继续对话的意义：fatal 之后由入口终止进程。
			fatal(
				"unsupported_version",
				`协议版本不相交：Host 支持 [${frame.supported_versions.join(", ")}]，`
					+ `运行时支持 [${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}]`,
			);
			return;
		}
		initialized = true;
		// 回以本端 hello：runtime 身份 + 本端能响应的方法集合。
		deps.emit({
			kind: "hello",
			version: PROTOCOL_VERSION,
			protocol: WIRE_PROTOCOL_ID,
			supported_versions: [...SUPPORTED_PROTOCOL_VERSIONS],
			runtime: deps.runtime.name,
			capabilities: Object.values(AGENT_METHODS),
		});
	}

	function handleModelSet(id: string, params: { model: HostModelDescriptor }): void {
		if (active) {
			fail(id, "busy", "有正在进行的 run，无法切换模型");
			return;
		}
		if (deps.supportedApis && !deps.supportedApis.includes(params.model.api)) {
			fail(id, "bad_request", `API ${params.model.api} 不受此运行时支持`);
			return;
		}
		if (!credentials.has(params.model.provider)) {
			fail(id, "bad_request", `provider ${params.model.provider} 尚未下发凭证，请先发送 agent.credentials.set`);
			return;
		}
		descriptor = params.model;
		models.setProvider(
			deps.createProvider({
				descriptor: params.model,
				getApiKey: () => credentials.get(params.model.provider)?.apiKey,
			}),
		);
		rebuildAgent();
		ok(id);
	}

	function handleSessionLoad(id: string, params: { sessionId: string; messages: HostSeedMessage[] }): void {
		if (active) {
			fail(id, "busy", "有正在进行的 run，无法重建会话");
			return;
		}
		sessionId = params.sessionId;
		transcript = params.messages.map(seedToMessage);
		rebuildAgent();
		ok(id, { sessionId, messageCount: transcript.length });
	}

	function handlePrompt(id: string, params: { text: string }): void {
		if (active) {
			fail(id, "busy", "已有 run 在进行，请先等待结束或发送 agent.cancel");
			return;
		}
		if (!agent) {
			fail(id, "no_model", "尚未通过 agent.model.set 选定模型");
			return;
		}
		ok(id);
		// 刻意不 await：run 期间传输层必须继续处理 cancel 等命令。
		void runPrompt(params, id);
	}

	function handleCancel(id: string, params: { targetId: string }): void {
		if (!active || active.frameId !== params.targetId) {
			ok(id, { cancelled: false });
			return;
		}
		agent?.abort();
		ok(id, { cancelled: true });
	}

	function sessionSecrets(): readonly string[] {
		return [...credentials.values()].map((entry) => entry.apiKey);
	}

	function dispatch(request: AgentRequest): void {
		switch (request.method) {
			case AGENT_METHODS.credentialsSet:
				credentials.set(request.params.provider, {
					credentialId: request.params.credentialId,
					apiKey: request.params.apiKey,
				});
				ok(request.id);
				return;
			case AGENT_METHODS.credentialsClear:
				credentials.delete(request.params.provider);
				ok(request.id);
				return;
			case AGENT_METHODS.modelSet:
				handleModelSet(request.id, request.params);
				return;
			case AGENT_METHODS.sessionLoad:
				handleSessionLoad(request.id, request.params);
				return;
			case AGENT_METHODS.prompt:
				handlePrompt(request.id, request.params);
				return;
			case AGENT_METHODS.cancel:
				handleCancel(request.id, request.params);
				return;
			case AGENT_METHODS.ping:
				ok(request.id, { pong: true });
				return;
			case AGENT_METHODS.shutdown:
				shuttingDown = true;
				agent?.abort();
				ok(request.id);
				return;
		}
	}

	return {
		listSecrets: sessionSecrets,
		isShuttingDown: () => shuttingDown,
		fatalError: () => fatalFailure,

		async handleFrame(line: string): Promise<void> {
			const outcome = parseHostFrame(line);
			if (!outcome.ok) {
				if (outcome.kind === "fatal") {
					fatal(outcome.error.code, outcome.error.message);
					return;
				}
				fail(outcome.id, outcome.error.code, outcome.error.message);
				return;
			}

			// 首帧必须是 hello：未协商就发业务帧说明对端状态与本地不一致。
			// （信封层已保证这里只可能是 hello 或 request。）
			if (!initialized && outcome.frame.kind !== "hello") {
				fatal("not_initialized", "首帧必须是 hello");
				return;
			}
			if (outcome.frame.kind === "hello") {
				handleHello(outcome.frame);
				return;
			}

			const parsed = parseAgentRequest(outcome.frame);
			if (!parsed.ok) {
				// 方法级错误：可关联、可恢复，回带同 id 的 response.error，会话继续。
				fail(outcome.frame.id, parsed.error.code, parsed.error.message);
				return;
			}
			dispatch(parsed.request);
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