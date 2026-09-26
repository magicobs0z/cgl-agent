/**
 * cgl-agent 受监管 Node 会话与铜内核之间的私有 IPC 协议。
 *
 * 边界约定（与 docs/设计.md「运行时与进程模型」、docs/安全设计.md 一致）：
 * - 传输是 stdin/stdout 上的 NDJSON：一行一帧，UTF-8，无 BOM。
 * - stdout **只**承载协议帧；任何诊断/堆栈/第三方库输出都必须改道 stderr，
 *   由 transport.ts 覆写 console.* 保证。
 * - 方向：Host -> Runtime 是命令帧（每帧带 `id`），Runtime -> Host 是
 *   响应帧（`ok`/`error`，回带同一 `id`）与事件帧（`event`，带 `runId`/`seq`）。
 * - 本层只做「会话与模型调用」。工具执行、文件读取、联网等能力由内核另行
 *   设计（见 docs/MCP工具设计.md）；协议里预留了工具事件的线格式，但本层
 *   不提供任何绕过内核的通道。
 *
 * 版本演进：协议版本独立于模块版本。Host 在 `hello` 中给出它支持的版本集合，
 * 运行时不支持即拒绝启动，避免出现「双方都以为自己兼容」的静默错配。
 */

export const PROTOCOL_VERSION = 1;

/** 本运行时实现的版本集合（Host 的 `hello.protocolVersions` 需与之相交）。 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

export const LIMITS = {
	/** 单帧入站上限。超限的行被丢弃并回报 `too_large`，不终止会话。 */
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
	/** 帧类型未知。 */
	"unknown_type",
	/** 帧超过入站上限。 */
	"too_large",
	/** 出站帧超过上限（发生在事件帧上）。 */
	"outbound_too_large",
	/** 协议版本不相交。 */
	"unsupported_version",
	/** 尚未完成 `hello` 握手就发命令。 */
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
// Host -> Runtime
// ---------------------------------------------------------------------------

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

export interface HelloFrame {
	type: "hello";
	id: string;
	protocolVersions: number[];
	host: { name: string; version: string };
}

export interface CredentialsSetFrame {
	type: "credentials.set";
	id: string;
	/** 不透明标识，仅用于回带与日志关联；密钥本体只在 Node 进程内存中。 */
	credentialId: string;
	provider: string;
	apiKey: string;
}

export interface CredentialsClearFrame {
	type: "credentials.clear";
	id: string;
	provider: string;
}

export interface ModelSetFrame {
	type: "model.set";
	id: string;
	model: HostModelDescriptor;
}

export interface SessionLoadFrame {
	type: "session.load";
	id: string;
	sessionId: string;
	messages: HostSeedMessage[];
}

export interface PromptFrame {
	type: "prompt";
	id: string;
	text: string;
}

export interface CancelFrame {
	type: "cancel";
	id: string;
	/** 要取消的 run 的帧 id（即触发它的 prompt 帧 id）。 */
	targetId: string;
}

export interface PingFrame {
	type: "ping";
	id: string;
}

export interface ShutdownFrame {
	type: "shutdown";
	id: string;
}

export type HostFrame =
	| HelloFrame
	| CredentialsSetFrame
	| CredentialsClearFrame
	| ModelSetFrame
	| SessionLoadFrame
	| PromptFrame
	| CancelFrame
	| PingFrame
	| ShutdownFrame;

export const HOST_FRAME_TYPES: readonly HostFrame["type"][] = [
	"hello",
	"credentials.set",
	"credentials.clear",
	"model.set",
	"session.load",
	"prompt",
	"cancel",
	"ping",
	"shutdown",
];

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

// ---------------------------------------------------------------------------
// Runtime -> Host：帧
// ---------------------------------------------------------------------------

export interface ReadyFrame {
	type: "ready";
	protocolVersion: number;
	runtime: { name: string; version: string; node: string };
}

export interface OkFrame {
	type: "ok";
	id: string;
	result?: unknown;
}

/** `id` 可缺省：帧本身无法解析时（如超长/坏 JSON）Host 无从得知 id。 */
export interface ErrorFrame {
	type: "error";
	id?: string;
	code: ErrorCode;
	message: string;
}

export interface EventFrame {
	type: "event";
	runId: string;
	/** 同一 run 内从 0 单调递增，无空洞。 */
	seq: number;
	event: RunEvent;
}

export interface FatalFrame {
	type: "fatal";
	code: ErrorCode;
	message: string;
}

export interface PongFrame {
	type: "pong";
	id: string;
}

export type RuntimeFrame = ReadyFrame | OkFrame | ErrorFrame | EventFrame | FatalFrame | PongFrame;

export const RUNTIME_FRAME_TYPES: readonly RuntimeFrame["type"][] = [
	"ready",
	"ok",
	"error",
	"event",
	"fatal",
	"pong",
];

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export type ParseResult = { ok: true; frame: HostFrame } | { ok: false; id?: string; code: ErrorCode; message: string };

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

/** 从任意对象里尽力提取回带用的 `id`；提取不到就不回带。 */
function extractId(record: Record<string, unknown>): string | undefined {
	const id = record["id"];
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function bad(code: ErrorCode, message: string, id?: string): ParseResult {
	return id === undefined ? { ok: false, code, message } : { ok: false, code, message, id };
}

type FailedParse = { ok: false; id?: string; code: ErrorCode; message: string };

function parseModelDescriptor(value: unknown, id?: string): { ok: true; model: HostModelDescriptor } | FailedParse {
	if (!isRecord(value)) return bad("bad_frame", "model.set.model 必须是对象", id);
	const { provider, api, baseUrl, model } = value;
	if (!nonEmptyString(provider)) return bad("bad_frame", "model.set.model.provider 必须是非空字符串", id);
	if (!nonEmptyString(api)) return bad("bad_frame", "model.set.model.api 必须是非空字符串", id);
	if (!nonEmptyString(baseUrl)) return bad("bad_frame", "model.set.model.baseUrl 必须是非空字符串", id);
	if (!isRecord(model)) return bad("bad_frame", "model.set.model.model 必须是对象", id);
	if (!nonEmptyString(model["id"])) return bad("bad_frame", "model.set.model.model.id 必须是非空字符串", id);
	if (!isPositiveInt(model["contextWindow"]))
		return bad("bad_frame", "model.set.model.model.contextWindow 必须是正整数", id);
	if (!isPositiveInt(model["maxTokens"])) return bad("bad_frame", "model.set.model.model.maxTokens 必须是正整数", id);

	const name = model["name"];
	if (name !== undefined && typeof name !== "string") return bad("bad_frame", "model.set.model.model.name 必须是字符串", id);
	const reasoning = model["reasoning"];
	if (reasoning !== undefined && typeof reasoning !== "boolean")
		return bad("bad_frame", "model.set.model.model.reasoning 必须是布尔值", id);

	const rawInput = model["input"];
	let input: ("text" | "image")[] | undefined;
	if (rawInput !== undefined) {
		if (!Array.isArray(rawInput) || rawInput.some((entry) => entry !== "text" && entry !== "image"))
			return bad("bad_frame", 'model.set.model.model.input 只能是 "text"/"image" 数组', id);
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
 * 解析一帧入站数据。
 *
 * 只做「结构与类型」校验，不做业务校验（例如 provider 是否已配凭证），
 * 业务校验由 session.ts 负责，以便区分 `bad_frame` 与 `bad_request`。
 */
export function parseHostFrame(line: string): ParseResult {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return bad("bad_frame", "帧不是合法 JSON");
	}

	if (!isRecord(value)) return bad("bad_frame", "帧必须是 JSON 对象");

	const id = extractId(value);
	const type = value["type"];
	if (typeof type !== "string") return bad("bad_frame", "帧缺少字符串字段 type", id);

	switch (type) {
		case "hello": {
			const versions = value["protocolVersions"];
			if (!Array.isArray(versions) || versions.some((entry) => !isFiniteNumber(entry) || !Number.isInteger(entry)))
				return bad("bad_frame", "hello.protocolVersions 必须是整数数组", id);
			const host = value["host"];
			if (!isRecord(host) || !nonEmptyString(host["name"]) || !nonEmptyString(host["version"]))
				return bad("bad_frame", "hello.host 必须含 name/version", id);
			return {
				ok: true,
				frame: {
					type: "hello",
					id: id ?? "",
					protocolVersions: versions as number[],
					host: { name: host["name"], version: host["version"] },
				},
			};
		}

		case "credentials.set": {
			if (id === undefined) return bad("bad_frame", "credentials.set 缺少 id");
			if (!nonEmptyString(value["credentialId"]))
				return bad("bad_frame", "credentials.set.credentialId 必须是非空字符串", id);
			if (!nonEmptyString(value["provider"])) return bad("bad_frame", "credentials.set.provider 必须是非空字符串", id);
			if (!nonEmptyString(value["apiKey"])) return bad("bad_frame", "credentials.set.apiKey 必须是非空字符串", id);
			return {
				ok: true,
				frame: {
					type: "credentials.set",
					id,
					credentialId: value["credentialId"],
					provider: value["provider"],
					apiKey: value["apiKey"],
				},
			};
		}

		case "credentials.clear": {
			if (id === undefined) return bad("bad_frame", "credentials.clear 缺少 id");
			if (!nonEmptyString(value["provider"])) return bad("bad_frame", "credentials.clear.provider 必须是非空字符串", id);
			return { ok: true, frame: { type: "credentials.clear", id, provider: value["provider"] } };
		}

		case "model.set": {
			if (id === undefined) return bad("bad_frame", "model.set 缺少 id");
			const parsed = parseModelDescriptor(value["model"], id);
			if (!parsed.ok) return parsed;
			return { ok: true, frame: { type: "model.set", id, model: parsed.model } };
		}

		case "session.load": {
			if (id === undefined) return bad("bad_frame", "session.load 缺少 id");
			if (!nonEmptyString(value["sessionId"])) return bad("bad_frame", "session.load.sessionId 必须是非空字符串", id);
			const rawMessages = value["messages"];
			if (!Array.isArray(rawMessages)) return bad("bad_frame", "session.load.messages 必须是数组", id);
			if (rawMessages.length > LIMITS.maxSeedMessages)
				return bad("bad_request", `session.load.messages 超过 ${LIMITS.maxSeedMessages} 条上限`, id);

			const messages: HostSeedMessage[] = [];
			for (let index = 0; index < rawMessages.length; index++) {
				const entry = rawMessages[index];
				if (!isRecord(entry)) return bad("bad_frame", `session.load.messages[${index}] 必须是对象`, id);
				const role = entry["role"];
				if (role !== "user" && role !== "assistant")
					return bad("bad_frame", `session.load.messages[${index}].role 只能是 user/assistant`, id);
				if (typeof entry["text"] !== "string")
					return bad("bad_frame", `session.load.messages[${index}].text 必须是字符串`, id);
				if (!isFiniteNumber(entry["timestamp"]))
					return bad("bad_frame", `session.load.messages[${index}].timestamp 必须是数字`, id);
				messages.push({ role, text: entry["text"], timestamp: entry["timestamp"] });
			}
			return { ok: true, frame: { type: "session.load", id, sessionId: value["sessionId"], messages } };
		}

		case "prompt": {
			if (id === undefined) return bad("bad_frame", "prompt 缺少 id");
			if (typeof value["text"] !== "string") return bad("bad_frame", "prompt.text 必须是字符串", id);
			if (value["text"].trim().length === 0) return bad("bad_request", "prompt.text 不能为空", id);
			if (value["text"].length > LIMITS.maxPromptChars)
				return bad("bad_request", `prompt.text 超过 ${LIMITS.maxPromptChars} 字符上限`, id);
			return { ok: true, frame: { type: "prompt", id, text: value["text"] } };
		}

		case "cancel": {
			if (id === undefined) return bad("bad_frame", "cancel 缺少 id");
			if (!nonEmptyString(value["targetId"])) return bad("bad_frame", "cancel.targetId 必须是非空字符串", id);
			return { ok: true, frame: { type: "cancel", id, targetId: value["targetId"] } };
		}

		case "ping": {
			if (id === undefined) return bad("bad_frame", "ping 缺少 id");
			return { ok: true, frame: { type: "ping", id } };
		}

		case "shutdown": {
			if (id === undefined) return bad("bad_frame", "shutdown 缺少 id");
			return { ok: true, frame: { type: "shutdown", id } };
		}

		default:
			return bad("unknown_type", `未知的帧类型：${type}`, id);
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