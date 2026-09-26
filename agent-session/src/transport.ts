/**
 * stdin/stdout 上的有界 NDJSON 传输层。
 *
 * 三条不变量：
 * 1. **stdout 只承载协议帧**。第三方库或本层代码的任何 `console.*` 输出都被
 *    改道到 stderr，否则一行日志就会毁掉整条协议流。
 * 2. **入站有界**。超长行不会撑爆内存：一旦缓冲超过上限就进入「丢弃到换行」
 *    状态，只回报一帧 `too_large` 错误，然后继续同步（不终止会话，因为主机
 *    的写入位置仍在行边界上）。
 * 3. **出站有界且检查**。超限的出站帧不写入 stdout，而是抛出，由 session
 *    层降级为一帧可容纳的错误事件。
 *
 * stderr 输出逐行限长并脱敏；它只用于诊断，永远不参与协议。
 */

import { LIMITS, redact, type ErrorCode, type RuntimeFrame } from "./protocol.ts";

/** 传输层向外暴露的写入接口。 */
export interface TransportWriter {
	/**
	 * 写一帧。
	 *
	 * @throws 帧序列化后超过 `LIMITS.maxOutboundFrameBytes` 时抛出
	 * `FrameTooLargeError`，调用方须自行降级（不得静默丢弃）。
	 */
	write(frame: RuntimeFrame): void;
	/** 写一行诊断到 stderr（限长 + 脱敏）。 */
	log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export class FrameTooLargeError extends Error {
	public readonly code: ErrorCode = "outbound_too_large";

	constructor(public readonly bytes: number) {
		super(`出站帧 ${bytes} 字节，超过 ${LIMITS.maxOutboundFrameBytes} 字节上限`);
		this.name = "FrameTooLargeError";
	}
}

export interface TransportOptions {
	/** 逐行交付解析后的入站帧；返回的 Promise 会被串行等待（保证帧按序处理）。 */
	onFrame: (line: string, writer: TransportWriter) => Promise<void> | void;
	/** 致命错误（无法继续时）回调；返回后传输层不再交付新帧。 */
	onFatal: (code: ErrorCode, message: string) => void;
	/** 当前需要在 stderr 中遮蔽的密钥清单（由 session 提供）。 */
	getSecrets: () => readonly string[];
}

/**
 * 覆写 `console.*`，把一切输出改道 stderr。
 *
 * 必须由入口在加载任何可能打日志的模块之前显式调用：这是把「stdout 专用于
 * 协议」从约定变成机制的唯一手段（例如 provider SDK 打的一行 debug 日志）。
 */
export function installConsoleRedirect(): void {
	const toStderr = (level: string) => (...args: unknown[]) => {
		process.stderr.write(`${formatConsoleLine(level, args)}\n`);
	};

	console.log = toStderr("log");
	console.info = toStderr("info");
	console.debug = toStderr("debug");
	console.warn = toStderr("warn");
	console.error = toStderr("error");
}

function formatConsoleLine(level: string, args: readonly unknown[]): string {
	const parts = args.map((value) => {
		if (typeof value === "string") return value;
		if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
		try {
			return JSON.stringify(value) ?? String(value);
		} catch {
			return String(value);
		}
	});
	return `[runtime:${level}] ${parts.join(" ")}`;
}

/** 按字节上限截断字符串，且不切断 UTF-8 码点。 */
function truncateToBytes(text: string, maxBytes: number, suffix = "…[truncated]"): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const keep = Math.max(0, maxBytes - suffixBytes);
	// 从 keep 处向前退到合法的 UTF-8 边界，避免产生替换字符。
	let end = keep;
	while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end--;
	return buffer.subarray(0, end).toString("utf8") + suffix;
}

export function createTransport(options: TransportOptions): { writer: TransportWriter; close(): void } {
	let closed = false;
	/** 串行化帧处理，保证 prompt/cancel 的顺序语义与到达顺序一致。 */
	let queue: Promise<void> = Promise.resolve();
	let fatalReported = false;

	const writeStderrLine = (line: string): void => {
		const redacted = redact(line, options.getSecrets());
		const bounded = truncateToBytes(redacted, LIMITS.maxStderrLineBytes);
		process.stderr.write(`${bounded}\n`);
	};

	const writer: TransportWriter = {
		write(frame: RuntimeFrame): void {
			if (closed) return;
			const line = `${JSON.stringify(frame)}\n`;
			const bytes = Buffer.byteLength(line, "utf8");
			if (bytes > LIMITS.maxOutboundFrameBytes) throw new FrameTooLargeError(bytes);
			process.stdout.write(line);
		},
		log(level, message): void {
			writeStderrLine(`[runtime:${level}] ${message}`);
		},
	};

	const reportFatal = (code: ErrorCode, message: string): void => {
		if (fatalReported) return;
		fatalReported = true;
		try {
			writer.write({ type: "fatal", code, message: truncateToBytes(redact(message, options.getSecrets()), 512) });
		} catch {
			// stdout 已不可用（例如对端关闭）：stderr 仍留一份诊断。
			writeStderrLine(`[runtime:fatal] ${code}: ${message}`);
		}
		options.onFatal(code, message);
	};

	// ---- 入站：按字节缓冲切行，超限即丢弃到换行 ----
	const pending: Buffer[] = [];
	let pendingBytes = 0;
	let discarding = false;

	const handleLine = (line: string): void => {
		queue = queue
			.then(async () => {
				if (closed) return;
				await options.onFrame(line, writer);
			})
			.catch((error: unknown) => {
				// 单帧处理异常不应终止会话：回报内部错误并继续。
				const message = error instanceof Error ? error.message : String(error);
				writeStderrLine(`[runtime:error] 帧处理失败：${message}`);
				try {
					writer.write({ type: "error", code: "internal", message: "帧处理失败" });
				} catch {
					// 忽略：出站不可用时会话即将结束。
				}
			});
	};

	process.stdin.on("data", (chunk: Buffer) => {
		if (closed) return;
		let start = 0;
		while (start < chunk.length) {
			const newlineIndex = chunk.indexOf(0x0a, start);
			const end = newlineIndex === -1 ? chunk.length : newlineIndex;
			const slice = chunk.subarray(start, end);

			if (discarding) {
				// 仍在丢弃超长行，直到换行为止。
				if (newlineIndex !== -1) discarding = false;
			} else if (pendingBytes + slice.length > LIMITS.maxInboundFrameBytes) {
				pending.length = 0;
				pendingBytes = 0;
				discarding = newlineIndex === -1;
				try {
					writer.write({
						type: "error",
						code: "too_large",
						message: `入站帧超过 ${LIMITS.maxInboundFrameBytes} 字节上限，已丢弃`,
					});
				} catch {
					// 出站不可用：继续丢弃以保持流同步。
				}
			} else if (slice.length > 0) {
				pending.push(slice);
				pendingBytes += slice.length;
			}

			if (newlineIndex !== -1 && !discarding && pendingBytes > 0) {
				const line = Buffer.concat(pending).toString("utf8").replace(/\r$/, "");
				pending.length = 0;
				pendingBytes = 0;
				if (line.trim().length > 0) handleLine(line);
			}

			if (newlineIndex === -1) break;
			start = newlineIndex + 1;
		}
	});

	process.stdin.on("end", () => {
		// 主机关闭 stdin：等价于会话终止，交给上层 onFatal 做统一收尾。
		reportFatal("shutting_down", "stdin 已关闭");
	});

	process.stdin.on("error", (error: Error) => {
		reportFatal("internal", `stdin 读取失败：${error.message}`);
	});

	const onUncaught = (error: unknown): void => {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		writeStderrLine(`[runtime:fatal] ${message}`);
		reportFatal("internal", "运行时未捕获异常");
	};

	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", (reason: unknown) => onUncaught(reason));

	process.stdin.resume();

	return {
		writer,
		close(): void {
			closed = true;
			process.removeListener("uncaughtException", onUncaught);
		},
	};
}