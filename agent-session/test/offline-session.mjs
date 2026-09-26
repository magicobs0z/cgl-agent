#!/usr/bin/env node
/**
 * 离线端到端验证（真实子进程 + 真实 stdio 管道）。
 *
 * 覆盖的目标是「统一协议 copper-addon.ndjson v2 与传输在真实进程上成立」：
 * - 首帧必须是 hello；未协商就发业务帧 = 协议错误，会话以 fatal 终止
 * - hello 信封逐字段对齐 Rust 侧 golden frame；版本/协议标识不符一律 fatal
 * - 凭证 -> 模型 -> 会话种子 -> prompt 的前置顺序被强制
 * - 流式多段 delta、权威落库快照（assistant_message）、run_end 用量、seq 无空洞
 * - 流式中途取消 -> stopReason "aborted"，且事件 seq 无空洞
 * - 方法级错误（未知方法、参数非法、状态不允许）回带同 id 的 response.error，
 *   会话继续；协议级错误（坏 JSON、方向错误、超限）以 fatal 终止且退出码非 0
 * - stdout 只出现协议帧，stderr 不出现协议帧
 *
 * 用真实子进程而不是进程内调用：stdio 的字节边界、EOF、退出码这些恰恰是最
 * 容易出问题、又最不容易被进程内测试发现的部分。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, ".build", "pi-session.test.mjs");

if (!existsSync(bundlePath)) {
	console.error(`找不到离线验证产物：${bundlePath}\n请先执行：npm run build:runtime`);
	process.exit(1);
}

// 与 src/protocol.ts 保持一致。这些字面量正是跨语言契约本身，改一处必须同时改另一端。
const WIRE_PROTOCOL_ID = "copper-addon.ndjson";
const PROTOCOL_VERSION = 2;
const AGENT_RUN_EVENT = "agent.run";
const RUNTIME_NAME = "cgl-agent-pi-session-test";
const METHODS = {
	credentialsSet: "agent.credentials.set",
	credentialsClear: "agent.credentials.clear",
	modelSet: "agent.model.set",
	sessionLoad: "agent.session.load",
	prompt: "agent.prompt",
	cancel: "agent.cancel",
	ping: "agent.ping",
	shutdown: "agent.shutdown",
};

const TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 5_000;
const failures = [];
let stepIndex = 0;

async function step(name, fn) {
	stepIndex += 1;
	try {
		await fn();
		console.log(`  ok ${stepIndex}. ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.error(`  FAIL ${stepIndex}. ${name}\n       ${error instanceof Error ? error.message : error}`);
	}
}

/** 子进程客户端：NDJSON 收发 + 断言友好的等待。 */
class RuntimeClient {
	constructor() {
		this.child = spawn(process.execPath, [bundlePath], { stdio: ["pipe", "pipe", "pipe"] });
		this.frames = [];
		this.rawLines = [];
		this.eventsByRun = new Map();
		this.stderrChunks = [];
		this.protocolViolations = [];
		this.pending = "";
		this.cursor = 0;
		this.waiters = [];
		this.exited = new Promise((resolve) => {
			this.child.on("exit", (code, signal) => resolve({ code, signal }));
		});

		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => this.stderrChunks.push(chunk));
	}

	#onStdout(chunk) {
		this.pending += chunk;
		let newlineIndex = this.pending.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.pending.slice(0, newlineIndex);
			this.pending = this.pending.slice(newlineIndex + 1);
			if (line.trim().length > 0) this.#onLine(line);
			newlineIndex = this.pending.indexOf("\n");
		}
	}

	#onLine(line) {
		this.rawLines.push(line);
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			this.protocolViolations.push(`stdout 出现非 JSON 行：${line.slice(0, 200)}`);
			return;
		}
		this.frames.push(frame);
		if (frame.kind === "event" && frame.event === AGENT_RUN_EVENT && typeof frame.payload?.runId === "string") {
			const bucket = this.eventsByRun.get(frame.payload.runId) ?? [];
			bucket.push(frame);
			this.eventsByRun.set(frame.payload.runId, bucket);
		}
		for (const waiter of [...this.waiters]) {
			if (waiter.predicate(frame)) {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				clearTimeout(waiter.timer);
				waiter.resolve(frame);
			}
		}
	}

	send(frame) {
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	/** 发送一行原始文本（用于构造非法帧 / 超长帧）。 */
	sendRaw(text) {
		this.child.stdin.write(text);
	}

	hello(overrides = {}) {
		this.send({
			kind: "hello",
			version: PROTOCOL_VERSION,
			protocol: WIRE_PROTOCOL_ID,
			supported_versions: [PROTOCOL_VERSION],
			runtime: "copper-test",
			capabilities: [],
			...overrides,
		});
	}

	request(id, method, params = {}) {
		this.send({ kind: "request", version: PROTOCOL_VERSION, id, method, params });
	}

	responseOf(id) {
		return this.waitFor((frame) => frame.kind === "response" && frame.id === id, `response(${id})`);
	}

	/** 从当前游标起等待首个匹配帧；匹配帧会被消费。 */
	async waitFor(predicate, label, timeoutMs = TIMEOUT_MS) {
		const existingIndex = this.frames.findIndex((frame, index) => index >= this.cursor && predicate(frame));
		if (existingIndex !== -1) {
			this.cursor = existingIndex + 1;
			return this.frames[existingIndex];
		}
		const waited = await this.#wait(predicate, label, timeoutMs);
		const index = this.frames.lastIndexOf(waited);
		this.cursor = index + 1;
		return waited;
	}

	/** 等待 fatal 帧、断言错误码与退出码，用于「协议错误必须终止会话」的用例。 */
	async expectFatal(expectedCode) {
		const frame = await this.waitFor((candidate) => candidate.kind === "fatal", `fatal(${expectedCode})`);
		assert.deepEqual(
			Object.keys(frame).sort(),
			["error", "kind", "version"],
			`fatal 帧字段必须恰为 kind/version/error，实际 ${JSON.stringify(frame)}`,
		);
		assert.equal(frame.version, PROTOCOL_VERSION);
		assert.equal(frame.error.code, expectedCode, `fatal 错误码不符：${JSON.stringify(frame.error)}`);
		assert.equal(typeof frame.error.message, "string");
		const exit = await this.exitWithin(EXIT_TIMEOUT_MS);
		assert.notEqual(exit.code, 0, "fatal 之后进程必须以非 0 退出码结束");
	}

	async exitWithin(timeoutMs) {
		return Promise.race([
			this.exited,
			new Promise((_, reject) => setTimeout(() => reject(new Error("进程未在限时内退出")), timeoutMs)),
		]);
	}

	#wait(predicate, label, timeoutMs) {
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				timer: setTimeout(() => {
					this.waiters.splice(this.waiters.indexOf(waiter), 1);
					reject(
						new Error(
							`等待「${label}」超时。已收到的帧：${JSON.stringify(
								this.frames.slice(-12).map((frame) => summarize(frame)),
							)}`,
						),
					);
				}, timeoutMs),
			};
			this.waiters.push(waiter);
		});
	}

	stderr() {
		return this.stderrChunks.join("");
	}

	async stop() {
		if (this.child.exitCode === null) this.child.kill();
		await this.exited;
	}
}

function summarize(frame) {
	if (frame.kind === "event") return `${frame.kind}:${frame.event}:${frame.payload?.runId}#${frame.payload?.sequence}`;
	if (frame.kind === "response") return `${frame.kind}:${frame.id}`;
	return frame.kind;
}

function eventOf(runId, eventType) {
	return (frame) =>
		frame.kind === "event" &&
		frame.event === AGENT_RUN_EVENT &&
		frame.payload?.runId === runId &&
		frame.payload?.event?.type === eventType;
}

function assertSeqIsDense(client, runId) {
	const bucket = client.eventsByRun.get(runId) ?? [];
	assert.ok(bucket.length > 0, `run ${runId} 没有任何事件帧`);
	const seqs = bucket.map((frame) => frame.payload.sequence);
	assert.deepEqual(
		seqs,
		seqs.map((_, index) => index),
		`run ${runId} 的事件 sequence 不连续：${seqs.join(",")}`,
	);
	assert.equal(
		bucket[bucket.length - 1].payload.event.type,
		"run_end",
		`run ${runId} 的最后一个事件不是 run_end`,
	);
}

/** 每个 fatal 用例都独占一个进程：协议错误意味着会话不可继续。 */
async function fatalCase(name, prepare, expectedCode) {
	await step(name, async () => {
		const client = new RuntimeClient();
		try {
			await prepare(client);
			await client.expectFatal(expectedCode);
		} finally {
			await client.stop();
		}
	});
}

async function main() {
	console.log("离线端到端验证：受监管 Node 会话（copper-addon.ndjson v2）");

	const client = new RuntimeClient();
	try {
		await step("hello 信封对齐 golden frame（kind/version/protocol/supported_versions/runtime/capabilities）", async () => {
			client.hello();
			const frame = await client.waitFor((candidate) => candidate.kind === "hello", "runtime hello");
			assert.equal(frame.version, PROTOCOL_VERSION);
			assert.equal(frame.protocol, WIRE_PROTOCOL_ID);
			assert.deepEqual(frame.supported_versions, [PROTOCOL_VERSION]);
			assert.equal(frame.runtime, RUNTIME_NAME);
			assert.deepEqual(frame.capabilities, Object.values(METHODS));

			// 逐字节钉住字段顺序：Rust `ipc.rs` 的 golden line 必须与它一致。
			const helloLine = client.rawLines.find((line) => line.includes('"kind":"hello"'));
			assert.ok(helloLine, "stdout 上应出现 hello 帧");
			assert.ok(
				helloLine.startsWith(
					'{"kind":"hello","version":2,"protocol":"copper-addon.ndjson","supported_versions":[2],"runtime":"'
						+ `${RUNTIME_NAME}","capabilities":[`,
				),
				`hello 线格式与契约不符：${helloLine.slice(0, 200)}`,
			);
		});

		await step("下发凭证", async () => {
			client.request("cred-1", METHODS.credentialsSet, {
				credentialId: "cred-1",
				provider: "faux-local",
				apiKey: "test-key-not-a-real-secret",
			});
			const frame = await client.responseOf("cred-1");
			assert.equal(frame.error, undefined, JSON.stringify(frame));
		});

		await step("缺少凭证时拒绝选模型（bad_request）", async () => {
			client.request("model-bad", METHODS.modelSet, {
				model: {
					provider: "faux-other",
					api: "faux",
					baseUrl: "http://localhost:0",
					model: { id: "faux-1", contextWindow: 128000, maxTokens: 4096 },
				},
			});
			const frame = await client.responseOf("model-bad");
			assert.equal(frame.error?.code, "bad_request");
		});

		await step("拒绝运行时不支持的模型 API", async () => {
			client.request("model-unsupported-api", METHODS.modelSet, {
				model: {
					provider: "faux-local",
					api: "unsupported-api",
					baseUrl: "http://localhost:0",
					model: { id: "faux-1", contextWindow: 128000, maxTokens: 4096 },
				},
			});
			const frame = await client.responseOf("model-unsupported-api");
			assert.equal(frame.error?.code, "bad_request");
		});

		await step("选定模型", async () => {
			client.request("model-1", METHODS.modelSet, {
				model: {
					provider: "faux-local",
					api: "faux",
					baseUrl: "http://localhost:0",
					model: { id: "faux-1", name: "Faux", contextWindow: 128000, maxTokens: 4096 },
				},
			});
			const frame = await client.responseOf("model-1");
			assert.equal(frame.error, undefined, JSON.stringify(frame));
		});

		await step("加载会话种子", async () => {
			client.request("load-1", METHODS.sessionLoad, {
				sessionId: "session-1",
				messages: [
					{ role: "user", text: "先前的问题", timestamp: Date.now() - 2000 },
					{ role: "assistant", text: "先前的回答", timestamp: Date.now() - 1000 },
				],
			});
			const frame = await client.responseOf("load-1");
			assert.equal(frame.result.sessionId, "session-1");
			assert.equal(frame.result.messageCount, 2);
		});

		await step("未知方法回带同 id 的 method_not_found，会话继续", async () => {
			client.request("weird-1", "agent.not-a-method", {});
			const frame = await client.responseOf("weird-1");
			assert.equal(frame.error?.code, "method_not_found");
			client.request("ping-1", METHODS.ping);
			const pong = await client.responseOf("ping-1");
			assert.equal(pong.result.pong, true);
		});

		await step("参数类型不符回带 bad_frame，会话继续", async () => {
			client.request("bad-params", METHODS.prompt, { text: 123 });
			const frame = await client.responseOf("bad-params");
			assert.equal(frame.error?.code, "bad_frame");
		});

		await step("空 prompt 与超长 prompt 被拒（bad_request），会话继续", async () => {
			client.request("empty-prompt", METHODS.prompt, { text: "   " });
			assert.equal((await client.responseOf("empty-prompt")).error?.code, "bad_request");

			client.request("long-prompt", METHODS.prompt, { text: "a".repeat(100_001) });
			assert.equal((await client.responseOf("long-prompt")).error?.code, "bad_request");

			client.request("ping-2", METHODS.ping);
			assert.equal((await client.responseOf("ping-2")).result.pong, true);
		});

		await step("prompt：run_start -> 多段 text_delta -> assistant_message -> run_end(stop)", async () => {
			client.request("run-1", METHODS.prompt, { text: "第一个问题" });
			const ack = await client.responseOf("run-1");
			assert.equal(ack.error, undefined, JSON.stringify(ack));

			await client.waitFor(eventOf("run-1", "run_start"), "run_start");
			await client.waitFor(eventOf("run-1", "text_delta"), "first text_delta");
			await client.waitFor(eventOf("run-1", "text_delta"), "second text_delta");

			const snapshot = await client.waitFor(eventOf("run-1", "assistant_message"), "assistant_message");
			const message = snapshot.payload.event.message;
			assert.equal(message.role, "assistant");
			assert.equal(message.stopReason, "stop");
			assert.match(
				message.content.map((block) => block.text ?? "").join(""),
				/^reply-0 /,
				"落库快照应包含模型完整回答",
			);
			assert.ok(message.usage.totalTokens > 0, "usage 应被真实累计");

			const end = await client.waitFor(eventOf("run-1", "run_end"), "run_end");
			assert.equal(end.payload.event.stopReason, "stop");
			assert.equal(end.payload.event.usage.totalTokens, message.usage.totalTokens);
			assertSeqIsDense(client, "run-1");
		});

		await step("流式中途取消：run_end(aborted) 且 seq 仍连续", async () => {
			client.request("run-2", METHODS.prompt, { text: "第二个问题，将被取消" });
			await client.responseOf("run-2");
			await client.waitFor(eventOf("run-2", "text_delta"), "run-2 首个 delta");

			client.request("cancel-2", METHODS.cancel, { targetId: "run-2" });
			const cancelled = await client.responseOf("cancel-2");
			assert.equal(cancelled.result.cancelled, true);

			const end = await client.waitFor(eventOf("run-2", "run_end"), "run-2 run_end");
			assert.equal(end.payload.event.stopReason, "aborted");
			assertSeqIsDense(client, "run-2");
		});

		await step("取消不存在的 run 返回 cancelled=false", async () => {
			client.request("cancel-3", METHODS.cancel, { targetId: "no-such-run" });
			const frame = await client.responseOf("cancel-3");
			assert.equal(frame.result.cancelled, false);
		});

		await step("shutdown 后进程以 0 退出", async () => {
			client.request("bye", METHODS.shutdown);
			const frame = await client.responseOf("bye");
			assert.equal(frame.error, undefined, JSON.stringify(frame));
			const exit = await client.exitWithin(EXIT_TIMEOUT_MS);
			assert.equal(exit.code, 0, `期望退出码 0，实际 ${exit.code}`);
		});

		await step("stdout 只有协议帧，stderr 没有协议帧", async () => {
			assert.deepEqual(client.protocolViolations, []);
			const stderr = client.stderr();
			assert.ok(!stderr.includes('"kind":"event"'), "stderr 不应出现协议帧");
			assert.ok(!stderr.includes("fatal"), `stderr 不应出现 fatal：${stderr.slice(0, 300)}`);
		});
	} finally {
		await client.stop();
	}

	// ---- 协议级错误：每例独占一个进程，断言 fatal + 非 0 退出码 ----
	await fatalCase("首帧是业务帧 -> fatal(not_initialized)", (c) => c.request("pre-ping", METHODS.ping), "not_initialized");

	await fatalCase(
		"重复 hello -> fatal(already_initialized)",
		async (c) => {
			c.hello();
			await c.waitFor((frame) => frame.kind === "hello", "runtime hello");
			c.hello();
		},
		"already_initialized",
	);

	await fatalCase("版本不交会 -> fatal(unsupported_version)", (c) => c.hello({ supported_versions: [1] }), "unsupported_version");

	await fatalCase(
		"帧版本不是 2 -> fatal(unsupported_version)",
		(c) => c.send({ kind: "hello", version: 1, protocol: WIRE_PROTOCOL_ID, supported_versions: [1], runtime: "x", capabilities: [] }),
		"unsupported_version",
	);

	await fatalCase(
		"协议标识不符 -> fatal(bad_frame)",
		(c) => c.hello({ protocol: "copper-addon.legacy" }),
		"bad_frame",
	);

	await fatalCase("坏 JSON -> fatal(bad_frame)", (c) => c.sendRaw("{ this is not json }\n"), "bad_frame");

	await fatalCase(
		"未知帧类别 -> fatal(unknown_type)",
		(c) => c.send({ kind: "not-a-frame", version: PROTOCOL_VERSION, id: "weird-2" }),
		"unknown_type",
	);

	await fatalCase(
		"反方向帧（runtime->host 的 event） -> fatal(unknown_type)",
		(c) => c.send({ kind: "event", version: PROTOCOL_VERSION, event: AGENT_RUN_EVENT, payload: {} }),
		"unknown_type",
	);

	await fatalCase(
		"超长帧（>1 MiB） -> fatal(too_large)",
		(c) => c.sendRaw(`${JSON.stringify({ kind: "request", version: PROTOCOL_VERSION, id: "huge", method: METHODS.prompt, params: { text: "a".repeat(1_200_000) } })}\n`),
		"too_large",
	);

	if (failures.length > 0) {
		console.error(`\n离线端到端验证失败：${failures.length} 项`);
		process.exit(1);
	}
	console.log("\n离线端到端验证通过");
}

await main();
