/**
 * 统一附加进程线协议 `copper-addon.ndjson`（主版本 2）在 cgl-agent 侧的实现。
 *
 * 与通用 helper 共用同一套传输与信封规则（见 CopperCore `copper-module-abi::ipc`）：
 * - 传输是 stdin/stdout 上的 NDJSON：一行一帧，UTF-8，无 BOM。
 * - 每帧形如 `{ kind, version, ... }`，`kind ∈ hello|request|response|notification|event|fatal`。
 * - stdout **只**承载协议帧；任何诊断/堆栈/第三方库输出都必须改道 stderr，
 *   由 transport.ts 覆写 console.* 保证。
 * - 首帧必须是 `hello`；协商成功后会话固定到该版本。业务方法由 `request`/`response`
 *   按唯一 `id` 关联；Agent 的流式输出使用 `event` 帧。
 * - 协议级错误（坏 JSON、版本不符、帧方向或形状错误、超限、首帧非 hello）不可继续，
 *   一律以 `fatal` 帧报告并终止会话；方法级错误（未知方法、参数非法、状态不允许）
 *   回带同 `id` 的 `response.error`，会话继续。
 *
 * 与 helper 的差异仅在业务层：Agent 的方法命名空间是 `agent.*`，事件载荷带
 * `runId` 与单调递增 `sequence`。信封、握手、帧上限、错误 DTO 完全相同。
 *
 * 版本演进：协议版本独立于模块版本。Host 在 `hello` 中给出它支持的版本集合，
 * 运行时不支持即拒绝启动，避免出现「双方都以为自己兼容」的静默错配。
 */

export const WIRE_PROTOCOL_ID = "copper-addon.ndjson";

export const PROTOCOL_VERSION = 2;

/** 本运行时实现的版本集合（Host 的 `hello.supported_versions` 需与之相交）。 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

export const LIMITS = {
	/** 单帧入站上限。它是统一协议的更严格实现（协议硬上限为 8 MiB）。 */
	maxInboundFrameBytes: 1024 * 1024,
	/** 单帧出站上限。超限的出站事件会被替换为 `outbound_too_large` 错误事件。 */
	maxOutboundFrameBytes: 256 * 1024,
	/** stderr 单行保留上限，超出截断（stderr 只用于诊断）。 */
	maxStderrLineBytes: 2048,
	/** 单次 prompt 的字符上限。 */
	maxPromptChars: 100_000,
	/** 会话种子消息条数上限。 */
	maxSeedMessages: 2000,
	/** 工具参数/结果摘要的字符上限。 */
	maxDigestChars: 512,
} as const;

/** 错误码：固定枚举，Host 依赖它做分支，新增只追加不改义。 */
export const ERROR_CODES = [
	/** 帧不是合法 JSON、或字段类型/必填项不符。 */
	"bad_frame",
	/** 帧类别未知或方向错误（本方向不接受该 kind）。 */
	"unknown_type",
	/** 方法名未在本运行时注册。 */
	"method_not_found",
	/** 帧超过入站上限。 */
	"too_large",
	/** 出站帧超过上限（发生在事件帧上）。 */
	"outbound_too_large",
	/** 协议版本不相交。 */
	"unsupported_version",
	/** 尚未完成 `hello` 握手就发业务帧。 */
	"not_initialized",
	/** 重复握手。 */
	"already_initialized",
	/** 有运行中的 run，命令需等待（prompt/model.set/session.load）。 */
	"busy",
	/** 尚未通过 `model.set` 选定模型。 */
	"no_model",
	/** 参数不合法（空 prompt、超长 prompt、provider 与凭证不匹配等）。 */
	"bad_request",
	/** 模型调用失败（网络、鉴权、限流、服务端错误）。 */
	"model_error",
	/** 运行时内部错误。 */
	"internal",
	/** 收到 shutdown。 */
	"shutting_down",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
	return typeof value === "string" && ERROR_CODE_SET.has(value);
}

// ---------------------------------------------------------------------------
// 线信封
// ---------------------------------------------------------------------------

/** 统一错误 DTO：稳定机器可读 `code` + 安全诊断 `message`。 */
export interface WireError {
	code: ErrorCode;
	message: string;
}

/** 首帧协商：携带协议标识、支持版本、runtime 身份与能力集合。无 `id`。 */
export interface WireHello {
	kind: "hello";
	version: number;
	protocol: string;
	supported_versions: number[];
	runtime: string;
	capabilities: string[];
}

/** 双向请求：会话内唯一 `id` + 方法名 + JSON 参数。 */
export interface WireRequest {
	kind: "request";
	version: number;
	id: string;
	method: string;
	params: unknown;
}

/** 请求响应：必须回带同一 `id`，且恰含 `result` 或 `error` 之一。 */
export interface WireResponse {
	kind: "response";
	version: number;
	id: string;
	result?: unknown;
	error?: WireError;
}

/** 业务事件：不带请求关联 `id`。Agent 用它承载带 `runId`/`sequence` 的运行事件。 */
export interface WireEvent {
	kind: "event";
	version: number;
	event: string;
	payload: unknown;
}

/** 致命错误：会话无法继续，收到即终止。 */
export interface WireFatal {
	kind: "fatal";
	version: number;
	error: WireError;
}

/** 运行时写向 Host 的帧。 */
export type RuntimeFrame = WireHello | WireResponse | WireEvent | WireFatal;

/** 运行时接受的入站帧。`notification`/`event`/`response` 在本方向属协议错误。 */
export type HostFrame = WireHello | WireRequest;

// ---------------------------------------------------------------------------
// Host -> Runtime：方法命名空间与参数 DTO
// ---------------------------------------------------------------------------

export const AGENT_METHODS = {
	credentialsSet: "agent.credentials.set",
	credentialsClear: "agent.credentials.clear",
	modelSet: "agent.model.set",
	sessionLoad: "agent.session.load",
	prompt: "agent.prompt",
	cancel: "agent.cancel",
	ping: "agent.ping",
	shutdown: "agent.shutdown",
} as const;

export type AgentMethod = (typeof AGENT_METHODS)[keyof typeof AGENT_METHODS];

/** Agent 事件帧的固定事件名：载荷里再区分具体 RunEvent。 */
export const AGENT_RUN_EVENT = "agent.run";

/** 单个模型描述。模型清单由内核（用户配置）持有，本层不硬编码任何 provider 目录。 */
export interface HostModelDescriptor {
	/** provider id，与凭证的 provider 对应。 */
	provider: string;
	/** API 线协议。当前运行时只实现 `openai-completions`。 */
	api: string;
	baseUrl: string;
	model: {
		id: string;
		name?: string;
		contextWindow: number;
		maxTokens: number;
		reasoning?: boolean;
		input?: ("text" | "image")[];
	};
}

/** 会话种子的历史消息。只有文本：模块数据库才是会话的唯一真相源。 */
export interface HostSeedMessage {
	role: "user" | "assistant";
	text: string;
	timestamp: number;
}

export interface CredentialsSetParams {
	/** 不透明标识，仅用于回带与日志关联；密钥本体只在 Node 进程内存中。 */
	credentialId: string;
	provider: string;
	apiKey: string;
}

export interface CredentialsClearParams {
	provider: string;
}

export interface ModelSetParams {
	model: HostModelDescriptor;
}

export interface SessionLoadParams {
	sessionId: string;
	messages: HostSeedMessage[];
}

export interface PromptParams {
	text: string;
}

export interface CancelParams {
	/** 要取消的 run 的帧 id（即触发它的 `agent.prompt` 请求 id）。 */
	targetId: string;
}

export interface PingParams {}

export interface ShutdownParams {}

/** 已按方法校验并通过的入站请求：携带关联 `id` 与类型化参数。 */
export type AgentRequest = { id: string } & (
	| { method: typeof AGENT_METHODS.credentialsSet; params: CredentialsSetParams }
	| { method: typeof AGENT_METHODS.credentialsClear; params: CredentialsClearParams }
	| { method: typeof AGENT_METHODS.modelSet; params: ModelSetParams }
	| { method: typeof AGENT_METHODS.sessionLoad; params: SessionLoadParams }
	| { method: typeof AGENT_METHODS.prompt; params: PromptParams }
	| { method: typeof AGENT_METHODS.cancel; params: CancelParams }
	| { method: typeof AGENT_METHODS.ping; params: PingParams }
	| { method: typeof AGENT_METHODS.shutdown; params: ShutdownParams }
);

// ---------------------------------------------------------------------------
// Runtime -> Host：事件
// ---------------------------------------------------------------------------

/** 落库用的文本块。 */
export interface PersistedTextBlock {
	type: "text";
	text: string;
}

/** 落库用的思考块（部分兼容服务会返回）。 */
export interface PersistedThinkingBlock {
	type: "thinking";
	thinking: string;
}

/** 落库用的工具调用块。本层不注册任何工具，仅为协议完整性保留。 */
export interface PersistedToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type PersistedContentBlock = PersistedTextBlock | PersistedThinkingBlock | PersistedToolCallBlock;

export interface PersistedCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface PersistedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: PersistedCost;
}

/**
 * 权威的助手消息快照，供 Host 落库。
 *
 * 它是内核侧会话历史的唯一来源：流式事件可能丢帧或被截断，只有这条在
 * `message_end` 时发出，且 `stopReason` 会如实反映 `error`/`aborted`。
 * `usage` 为本次 run 内该条消息的原生计数，不做估算。
 */
export interface PersistedAssistantMessage {
	role: "assistant";
	content: PersistedContentBlock[];
	api: string;
	provider: string;
	model: string;
	usage: PersistedUsage;
	stopReason: string;
	timestamp: number;
	errorMessage?: string;
	/**
	 * 该消息的内容因超出单帧上限而被裁剪。
	 *
	 * 真实触发条件是「模型输出超过 content 预算」：文本块按 32000 字符、
	 * 思考块按 8000 字符裁剪。命中时 Host 应记录一条告警——落库内容会短于
	 * 模型实际输出，不应被当成完整回答。
	 */
	truncated?: boolean;
}

export interface RunStartEvent {
	type: "run_start";
}

export interface TextDeltaEvent {
	type: "text_delta";
	delta: string;
}

export interface ThinkingDeltaEvent {
	type: "thinking_delta";
	delta: string;
}

export interface ToolStartEvent {
	type: "tool_start";
	toolCallId: string;
	toolName: string;
	/** 参数摘要（长度+指纹），不下发原文，避免把工具载荷混进对话流。 */
	argsDigest: string;
}

export interface ToolEndEvent {
	type: "tool_end";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	resultDigest: string;
}

export interface AssistantMessageEvent {
	type: "assistant_message";
	message: PersistedAssistantMessage;
}

export interface RunEndEvent {
	type: "run_end";
	/** 末条助手消息的 stopReason；没有任何助手消息时为 "error"。 */
	stopReason: string;
	/** 整个 run 的用量累计（多轮工具循环时逐轮相加）。 */
	usage: PersistedUsage;
}

export interface ErrorEvent {
	type: "error";
	code: ErrorCode;
	message: string;
}

export type RunEvent =
	| RunStartEvent
	| TextDeltaEvent
	| ThinkingDeltaEvent
	| ToolStartEvent
	| ToolEndEvent
	| AssistantMessageEvent
	| RunEndEvent
	| ErrorEvent;

/** `agent.run` 事件帧的载荷：`sequence` 在同一 `runId` 内从 0 单调递增、无空洞。 */
export interface AgentRunEventPayload {
	runId: string;
	sequence: number;
	event: RunEvent;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 信封解析结果。
 *
 * - `fatal`：协议级错误，会话不可继续，须以 `fatal` 帧报告并终止。
 * - `refusal`：方法级错误（本层只产出「方法未知/参数不合法」），回带同 `id` 的
 *   `response.error`，会话继续。
 */
export type ParseOutcome =
	| { ok: true; frame: HostFrame }
	| { ok: false; kind: "fatal"; error: WireError }
	| { ok: false; kind: "refusal"; id: string; error: WireError };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInt(value: unknown): value is number {
	return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function fatal(code: ErrorCode, message: string): ParseOutcome {
	return { ok: false, kind: "fatal", error: { code, message } };
}

/**
 * 解析一帧入站数据：只做**信封**校验。
 *
 * 方法参数不在这里校验——信封合法但参数不合法属「可关联的方法级错误」，
 * 由 `parseAgentRequest` 返回 `refusal`，不能让整条会话因此终止。
 * 信封本身不合法则说明字节流已错位，继续解析只会放大错误，故一律 `fatal`。
 */
export function parseHostFrame(line: string): ParseOutcome {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return fatal("bad_frame", "帧不是合法 JSON");
	}
	if (!isRecord(value)) return fatal("bad_frame", "帧必须是 JSON 对象");

	const version = value["version"];
	if (!isFiniteNumber(version) || !Number.isInteger(version)) return fatal("bad_frame", "帧缺少整数字段 version");
	if (version !== PROTOCOL_VERSION) {
		return fatal(
			"unsupported_version",
			`协议版本不相交：收到 v${version}，本运行时支持 [${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}]`,
		);
	}

	const kind = value["kind"];
	if (typeof kind !== "string") return fatal("bad_frame", "帧缺少字符串字段 kind");

	if (kind === "hello") {
		const protocol = value["protocol"];
		if (protocol !== WIRE_PROTOCOL_ID) return fatal("bad_frame", `hello.protocol 必须是 ${WIRE_PROTOCOL_ID}`);
		const versions = value["supported_versions"];
		if (!Array.isArray(versions) || versions.some((entry) => !isFiniteNumber(entry) || !Number.isInteger(entry)))
			return fatal("bad_frame", "hello.supported_versions 必须是整数数组");
		if (!nonEmptyString(value["runtime"])) return fatal("bad_frame", "hello.runtime 必须是非空字符串");
		const capabilities = value["capabilities"];
		if (!Array.isArray(capabilities) || capabilities.some((entry) => typeof entry !== "string"))
			return fatal("bad_frame", "hello.capabilities 必须是字符串数组");
		return {
			ok: true,
			frame: {
				kind: "hello",
				version,
				protocol,
				supported_versions: versions as number[],
				runtime: value["runtime"],
				capabilities: capabilities as string[],
			},
		};
	}

	if (kind === "request") {
		const id = value["id"];
		if (!nonEmptyString(id)) return fatal("bad_frame", "request.id 必须是非空字符串");
		const method = value["method"];
		if (!nonEmptyString(method)) return fatal("bad_frame", "request.method 必须是非空字符串");
		if (!("params" in value)) return fatal("bad_frame", "request 缺少 params 字段");
		return { ok: true, frame: { kind: "request", version, id, method, params: value["params"] } };
	}

	// 本方向只接受 hello 与 request：response/event/notification 属方向错误，
	// 未知 kind 属形状错误。两者都说明对端状态与本地不一致，不可继续。
	if (kind === "response" || kind === "event" || kind === "notification" || kind === "fatal") {
		return fatal("unknown_type", `本方向不接受 ${kind} 帧`);
	}
	return fatal("unknown_type", `未知帧类别：${kind}`);
}

function parseModelDescriptor(value: unknown): { ok: true; model: HostModelDescriptor } | { ok: false; error: WireError } {
	const invalid = (message: string) => ({ ok: false as const, error: { code: "bad_frame" as ErrorCode, message } });
	if (!isRecord(value)) return invalid("model.set.model 必须是对象");
	const { provider, api, baseUrl, model } = value;
	if (!nonEmptyString(provider)) return invalid("model.set.model.provider 必须是非空字符串");
	if (!nonEmptyString(api)) return invalid("model.set.model.api 必须是非空字符串");
	if (!nonEmptyString(baseUrl)) return invalid("model.set.model.baseUrl 必须是非空字符串");
	if (!isRecord(model)) return invalid("model.set.model.model 必须是对象");
	if (!nonEmptyString(model["id"])) return invalid("model.set.model.model.id 必须是非空字符串");
	if (!isPositiveInt(model["contextWindow"])) return invalid("model.set.model.model.contextWindow 必须是正整数");
	if (!isPositiveInt(model["maxTokens"])) return invalid("model.set.model.model.maxTokens 必须是正整数");

	const name = model["name"];
	if (name !== undefined && typeof name !== "string") return invalid("model.set.model.model.name 必须是字符串");
	const reasoning = model["reasoning"];
	if (reasoning !== undefined && typeof reasoning !== "boolean")
		return invalid("model.set.model.model.reasoning 必须是布尔值");

	const rawInput = model["input"];
	let input: ("text" | "image")[] | undefined;
	if (rawInput !== undefined) {
		if (!Array.isArray(rawInput) || rawInput.some((entry) => entry !== "text" && entry !== "image"))
			return invalid('model.set.model.model.input 只能是 "text"/"image" 数组');
		input = rawInput as ("text" | "image")[];
	}

	return {
		ok: true,
		model: {
			provider,
			api,
			baseUrl,
			model: {
				id: model["id"],
				...(typeof name === "string" ? { name } : {}),
				contextWindow: model["contextWindow"],
				maxTokens: model["maxTokens"],
				...(typeof reasoning === "boolean" ? { reasoning } : {}),
				...(input ? { input } : {}),
			},
		},
	};
}

/**
 * 校验请求的方法名与参数。
 *
 * 只做「结构与类型」校验，不做业务校验（例如 provider 是否已配凭证），
 * 业务校验由 session.ts 负责，以便区分 `bad_frame` 与 `bad_request`。
 */
export function parseAgentRequest(
	frame: WireRequest,
): { ok: true; request: AgentRequest } | { ok: false; error: WireError } {
	const params = frame.params;
	const id = frame.id;
	const invalid = (code: ErrorCode, message: string) => ({ ok: false as const, error: { code, message } });

	switch (frame.method) {
		case AGENT_METHODS.credentialsSet: {
			if (!isRecord(params)) return invalid("bad_frame", "credentials.set 参数必须是对象");
			if (!nonEmptyString(params["credentialId"]))
				return invalid("bad_frame", "credentials.set.credentialId 必须是非空字符串");
			if (!nonEmptyString(params["provider"])) return invalid("bad_frame", "credentials.set.provider 必须是非空字符串");
			if (!nonEmptyString(params["apiKey"])) return invalid("bad_frame", "credentials.set.apiKey 必须是非空字符串");
			return {
				ok: true,
				request: {
					id,
					method: AGENT_METHODS.credentialsSet,
					params: {
						credentialId: params["credentialId"],
						provider: params["provider"],
						apiKey: params["apiKey"],
					},
				},
			};
		}

		case AGENT_METHODS.credentialsClear: {
			if (!isRecord(params)) return invalid("bad_frame", "credentials.clear 参数必须是对象");
			if (!nonEmptyString(params["provider"])) return invalid("bad_frame", "credentials.clear.provider 必须是非空字符串");
			return { ok: true, request: { id, method: AGENT_METHODS.credentialsClear, params: { provider: params["provider"] } } };
		}

		case AGENT_METHODS.modelSet: {
			if (!isRecord(params)) return invalid("bad_frame", "model.set 参数必须是对象");
			const parsed = parseModelDescriptor(params["model"]);
			if (!parsed.ok) return { ok: false, error: parsed.error };
			return { ok: true, request: { id, method: AGENT_METHODS.modelSet, params: { model: parsed.model } } };
		}

		case AGENT_METHODS.sessionLoad: {
			if (!isRecord(params)) return invalid("bad_frame", "session.load 参数必须是对象");
			if (!nonEmptyString(params["sessionId"])) return invalid("bad_frame", "session.load.sessionId 必须是非空字符串");
			const rawMessages = params["messages"];
			if (!Array.isArray(rawMessages)) return invalid("bad_frame", "session.load.messages 必须是数组");
			if (rawMessages.length > LIMITS.maxSeedMessages)
				return invalid("bad_request", `session.load.messages 超过 ${LIMITS.maxSeedMessages} 条上限`);

			const messages: HostSeedMessage[] = [];
			for (let index = 0; index < rawMessages.length; index++) {
				const entry = rawMessages[index];
				if (!isRecord(entry)) return invalid("bad_frame", `session.load.messages[${index}] 必须是对象`);
				const role = entry["role"];
				if (role !== "user" && role !== "assistant")
					return invalid("bad_frame", `session.load.messages[${index}].role 只能是 user/assistant`);
				if (typeof entry["text"] !== "string")
					return invalid("bad_frame", `session.load.messages[${index}].text 必须是字符串`);
				if (!isFiniteNumber(entry["timestamp"]))
					return invalid("bad_frame", `session.load.messages[${index}].timestamp 必须是数字`);
				messages.push({ role, text: entry["text"], timestamp: entry["timestamp"] });
			}
			return {
				ok: true,
				request: { id, method: AGENT_METHODS.sessionLoad, params: { sessionId: params["sessionId"], messages } },
			};
		}

		case AGENT_METHODS.prompt: {
			if (!isRecord(params)) return invalid("bad_frame", "prompt 参数必须是对象");
			if (typeof params["text"] !== "string") return invalid("bad_frame", "prompt.text 必须是字符串");
			if (params["text"].trim().length === 0) return invalid("bad_request", "prompt.text 不能为空");
			if (params["text"].length > LIMITS.maxPromptChars)
				return invalid("bad_request", `prompt.text 超过 ${LIMITS.maxPromptChars} 字符上限`);
			return { ok: true, request: { id, method: AGENT_METHODS.prompt, params: { text: params["text"] } } };
		}

		case AGENT_METHODS.cancel: {
			if (!isRecord(params)) return invalid("bad_frame", "cancel 参数必须是对象");
			if (!nonEmptyString(params["targetId"])) return invalid("bad_frame", "cancel.targetId 必须是非空字符串");
			return { ok: true, request: { id, method: AGENT_METHODS.cancel, params: { targetId: params["targetId"] } } };
		}

		case AGENT_METHODS.ping:
			return { ok: true, request: { id, method: AGENT_METHODS.ping, params: {} } };

		case AGENT_METHODS.shutdown:
			return { ok: true, request: { id, method: AGENT_METHODS.shutdown, params: {} } };

		default:
			return { ok: false, error: { code: "method_not_found", message: `未知方法：${frame.method}` } };
	}
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/** 认证头/令牌的通用形态，用于兜底遮蔽（即使具体密钥不在已知清单里）。 */
const SECRET_PATTERNS: readonly RegExp[] = [
	/(authorization\s*["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi,
	/\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
	/\b(sk-[A-Za-z0-9._-]{8,})/g,
	/\b(api[-_]?key\s*["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi,
];

export const REDACTED = "[redacted]";

/**
 * 遮蔽文本中的密钥。
 *
 * 注意定位：stdout 上**不应**出现密钥，脱敏只是防止 provider 的错误信息
 * 或第三方库的日志把密钥带进日志与错误提示的第二道防线，不能当作唯一防线。
 */
export function redact(text: string, secrets: readonly string[] = []): string {
	let output = text;
	for (const secret of secrets) {
		if (secret.length < 6) continue;
		output = output.split(secret).join(REDACTED);
	}
	for (const pattern of SECRET_PATTERNS) {
		output = output.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
	}
	return output;
}
