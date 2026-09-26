/**
 * 生产入口：铜内核派生本会话后，stdio 即协议通道。
 *
 * 只做「装配」：把 transport（字节层）与 session（语义层）接起来，并把 fatal
 * 收敛为进程退出。任何业务逻辑都不应写在这里。
 */

import "./console-redirect.ts";
import { createOpenAIProvider, SUPPORTED_APIS } from "./provider-openai.ts";
import { createSession, type AgentSession } from "./session.ts";
import { createTransport } from "./transport.ts";

/** 由构建脚本注入（值取自 module.json 的版本号）。 */
declare const __CGL_RUNTIME_VERSION__: string;

const RUNTIME_NAME = "cgl-agent-pi-session";

let session: AgentSession | undefined;
let exitCode = 0;

/**
 * 结束进程。
 *
 * 用 `setImmediate` 让已写入 stdout 的帧先落到管道：直接 `process.exit` 有可能
 * 丢掉最后一帧（对端会看到「成功响应缺失」，进而误判为崩溃）。
 */
function finish(code = 0): void {
	if (code > exitCode) exitCode = code;
	setImmediate(() => process.exit(exitCode));
}

const transport = createTransport({
	onFrame: async (line) => {
		await session?.handleFrame(line);
		if (!session?.isShuttingDown()) return;
		// 干净的 `agent.shutdown` 退出 0；协议/runtime 致命错误退出非 0，
		// 让内核 supervisor 能区分「正常停机」与「异常退出」。
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
	createProvider: createOpenAIProvider,
	supportedApis: SUPPORTED_APIS,
	// 内核已把系统代理设置注入本进程环境，这里原样交给代理 fetch 逐请求判定
	// （no_proxy 允许按主机名绕过，所以不能在这里做一次性的「有/无代理」判断）。
	env: process.env,
	runtime: {
		name: RUNTIME_NAME,
		version: __CGL_RUNTIME_VERSION__,
		node: process.version,
	},
});