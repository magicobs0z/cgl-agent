/**
 * 离线链路验证入口（仅测试用，不进发布包）。
 *
 * 与生产入口共用 protocol / transport / session，**唯一**差别是 provider 工厂：
 * 换成 Pi 自带的 faux provider，并预置确定性应答。这样可以在不联网、不需要密钥
 * 的前提下验证「握手 -> 下发模型 -> 流式事件 -> 取消 -> 落库快照」整条链路，
 * 而生产代码里不必留任何测试开关。
 */

import "../src/console-redirect.ts";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import type { Provider } from "@earendil-works/pi-ai";
import { createSession, type AgentSession, type SessionProviderInput } from "../src/session.ts";
import { createTransport } from "../src/transport.ts";

declare const __CGL_RUNTIME_VERSION__: string;

/** 预置应答条数：足够多次 prompt 使用。 */
const SCRIPTED_RESPONSES = 32;
/** 每条应答的正文长度（字符），足以被切成多段 delta。 */
const RESPONSE_BODY_CHARS = 120;
/** 出字速率：故意压慢，使「流式中途取消」可被稳定触发。 */
const TOKENS_PER_SECOND = 30;

let faux: FauxProviderHandle | undefined;

function createProvider(input: SessionProviderInput): Provider {
	const handle = fauxProvider({
		api: input.descriptor.api,
		provider: input.descriptor.provider,
		models: [
			{
				id: input.descriptor.model.id,
				name: input.descriptor.model.name ?? input.descriptor.model.id,
				reasoning: input.descriptor.model.reasoning ?? false,
				contextWindow: input.descriptor.model.contextWindow,
				maxTokens: input.descriptor.model.maxTokens,
			},
		],
		tokensPerSecond: TOKENS_PER_SECOND,
	});
	const steps = [];
	for (let index = 0; index < SCRIPTED_RESPONSES; index++) {
		steps.push(fauxAssistantMessage(`reply-${index} ${"铜".repeat(RESPONSE_BODY_CHARS)}`));
	}
	handle.setResponses(steps);
	faux = handle;
	return handle.provider;
}

let session: AgentSession | undefined;
let exitCode = 0;

function finish(code = 0): void {
	if (code > exitCode) exitCode = code;
	setImmediate(() => process.exit(exitCode));
}

const transport = createTransport({
	onFrame: async (line) => {
		await session?.handleFrame(line);
		if (!session?.isShuttingDown()) return;
		// 与生产入口同构：干净停机退出 0，fatal 退出非 0。
		finish(session.fatalError() ? 1 : 0);
	},
	onFatal: (code, message) => {
		transport.writer.log("error", `fatal ${code}: ${message}`);
		finish(1);
	},
	getSecrets: () => session?.listSecrets() ?? [],
});

session = createSession({
	emit: (frame) => transport.writer.write(frame),
	createProvider,
	supportedApis: ["faux"],
	env: process.env,
	runtime: {
		name: "cgl-agent-pi-session-test",
		version: __CGL_RUNTIME_VERSION__,
		node: process.version,
	},
	// 测试不关心系统提示，缩短以减小噪声。
	systemPrompt: "离线验证用系统提示。",
});

// 让 faux 句柄可被外部（调试）观察；生产入口没有这一项。
Object.defineProperty(globalThis, "__cglFauxState", { get: () => faux?.state, configurable: true });