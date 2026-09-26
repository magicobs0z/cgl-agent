#!/usr/bin/env node
/**
 * 离线端到端验证（真实子进程 + 真实 stdio 管道）。
 *
 * 覆盖的目标是「协议与传输在真实进程上成立」，不是单元测试：
 * - 握手前拒绝命令、握手成功后 ready/ok 成对
 * - 凭证 -> 模型 -> 会话种子 -> prompt 的前置顺序被强制
 * - 流式多段 delta、权威落库快照（assistant_message）、run_end 用量
 * - 流式中途取消 -> stopReason "aborted"，且事件 seq 无空洞
 * - 坏 JSON / 未知类型 / 超长帧被拒后会话仍可继续服务（硬性要求：不能因
 *   一帧非法输入就丢掉整条会话，否则内核要频繁重启子进程）
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

const TIMEOUT_MS = 20_000;
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
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			this.protocolViolations.push(`stdout 出现非 JSON 行：${line.slice(0, 200)}`);
			return;
		}
		this.frames.push(frame);
		if (frame.type === "event" && typeof frame.runId === "string") {
			const bucket = this.eventsByRun.get(frame.runId) ?? [];
			bucket.push(frame);
			this.eventsByRun.set(frame.runId, bucket);
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
	if (frame.type === "event") return `${frame.type}:${frame.runId}#${frame.seq}:${frame.event.type}`;
	return frame.type;
}

function eventOf(runId, eventType) {
	return (frame) =>
		frame.type === "event" && frame.runId === runId && frame.event && frame.event.type === eventType;
}

function assertSeqIsDense(client, runId) {
	const bucket = client.eventsByRun.get(runId) ?? [];
	assert.ok(bucket.length > 0, `run ${runId} 没有任何事件帧`);
	const seqs = bucket.map((frame) => frame.seq);
	assert.deepEqual(
		seqs,
		seqs.map((_, index) => index),
		`run ${runId} 的事件 seq 不连续：${seqs.join(",")}`,
	);
	assert.equal(bucket[bucket.length - 1].event.type, "run_end", `run ${runId} 的最后一个事件不是 run_end`);
}

async function main() {
	console.log("离线端到端验证：受监管 Node 会话");
	const client = new RuntimeClient();

	try {
		await step("握手前拒绝命令（not_initialized）", async () => {
			client.send({ type: "ping", id: "pre-ping" });
			const frame = await client.waitFor((f) => f.type === "error" && f.id === "pre-ping", "not_initialized");
			assert.equal(frame.code, "not_initialized");
		});

		await step("握手成功：ready 帧与 ok 帧成对", async () => {
			client.send({
				type: "hello",
				id: "hello-1",
				protocolVersions: [1],
				host: { name: "copper-test", version: "0.0.0" },
			});
			const ready = await client.waitFor((f) => f.type === "ready", "ready");
			assert.equal(ready.protocolVersion, 1);
			assert.equal(typeof ready.runtime.version, "string");
			const ok = await client.waitFor((f) => f.type === "ok" && f.id === "hello-1", "hello ok");
			assert.ok(ok);
		});

		await step("重复握手被拒（already_initialized）", async () => {
			client.send({
				type: "hello",
				id: "hello-2",
				protocolVersions: [1],
				host: { name: "copper-test", version: "0.0.0" },
			});
			const frame = await client.waitFor((f) => f.type === "error" && f.id === "hello-2", "already_initialized");
			assert.equal(frame.code, "already_initialized");
		});

		await step("下发凭证", async () => {
			client.send({
				type: "credentials.set",
				id: "cred-1",
				credentialId: "cred-1",
				provider: "faux-local",
				apiKey: "test-key-not-a-real-secret",
			});
			const frame = await client.waitFor((f) => f.type === "ok" && f.id === "cred-1", "cred ok");
			assert.ok(frame);
		});

		await step("缺少凭证时拒绝选模型（bad_request）", async () => {
			client.send({
				type: "model.set",
				id: "model-bad",
				model: {
					provider: "faux-other",
					api: "faux",
					baseUrl: "http://localhost:0",
					model: { id: "faux-1", contextWindow: 128000, maxTokens: 4096 },
				},
			});
			const frame = await client.waitFor((f) => f.type === "error" && f.id === "model-bad", "bad_request");
			assert.equal(frame.code, "bad_request");
		});

		await step("拒绝运行时不支持的模型 API", async () => {
			client.send({
				type: "model.set",
				id: "model-unsupported-api",
				model: {
					provider: "faux-local",
					api: "unsupported-api",
					baseUrl: "http://localhost:0",
					model: { id: "faux-1", contextWindow: 128000, maxTokens: 4096 },
				},
			});
			const frame = await client.waitFor(
				(f) => f.type === "error" && f.id === "model-unsupported-api",
				"unsupported model api",
			);
			assert.equal(frame.code, "bad_request");
		});

		await step("选定模型", async () => {
			client.send({
				type: "model.set",
				id: "model-1",
				model: {
					provider: "faux-local",
					api: "faux",
					baseUrl: "http://localhost:0",
					model: { id: "faux-1", name: "Faux", contextWindow: 128000, maxTokens: 4096 },
				},
			});
			const frame = await client.waitFor((f) => f.type === "ok" && f.id === "model-1", "model ok");
			assert.ok(frame);
		});

		await step("加载会话种子", async () => {
			client.send({
				type: "session.load",
				id: "load-1",
				sessionId: "session-1",
				messages: [
					{ role: "user", text: "先前的问题", timestamp: Date.now() - 2000 },
					{ role: "assistant", text: "先前的回答", timestamp: Date.now() - 1000 },
				],
			});
			const frame = await client.waitFor((f) => f.type === "ok" && f.id === "load-1", "load ok");
			assert.equal(frame.result.sessionId, "session-1");
			assert.equal(frame.result.messageCount, 2);
		});

		await step("prompt：run_start -> 多段 text_delta -> assistant_message -> run_end(stop)", async () => {
			client.send({ type: "prompt", id: "run-1", text: "第一个问题" });
			const ack = await client.waitFor((f) => f.type === "ok" && f.id === "run-1", "prompt ok");
			assert.ok(ack);
			await client.waitFor(eventOf("run-1", "run_start"), "run_start");

			await client.waitFor(eventOf("run-1", "text_delta"), "first text_delta");
			await client.waitFor(eventOf("run-1", "text_delta"), "second text_delta");

			const snapshot = await client.waitFor(eventOf("run-1", "assistant_message"), "assistant_message");
			const message = snapshot.event.message;
			assert.equal(message.role, "assistant");
			assert.equal(message.stopReason, "stop");
			assert.match(
				message.content.map((block) => block.text ?? "").join(""),
				/^reply-0 /,
				"落库快照应包含模型完整回答",
			);
			assert.ok(message.usage.totalTokens > 0, "usage 应被真实累计");

			const end = await client.waitFor(eventOf("run-1", "run_end"), "run_end");
			assert.equal(end.event.stopReason, "stop");
			assert.equal(end.event.usage.totalTokens, message.usage.totalTokens);
			assertSeqIsDense(client, "run-1");
		});

		await step("流式中途取消：run_end(aborted) 且 seq 仍连续", async () => {
			client.send({ type: "prompt", id: "run-2", text: "第二个问题，将被取消" });
			await client.waitFor((f) => f.type === "ok" && f.id === "run-2", "prompt ok");
			await client.waitFor(eventOf("run-2", "text_delta"), "run-2 首个 delta");

			client.send({ type: "cancel", id: "cancel-2", targetId: "run-2" });
			const cancelled = await client.waitFor((f) => f.type === "ok" && f.id === "cancel-2", "cancel ok");
			assert.equal(cancelled.result.cancelled, true);

			const end = await client.waitFor(eventOf("run-2", "run_end"), "run-2 run_end");
			assert.equal(end.event.stopReason, "aborted");
			assertSeqIsDense(client, "run-2");
		});

		await step("取消不存在的 run 返回 cancelled=false", async () => {
			client.send({ type: "cancel", id: "cancel-3", targetId: "no-such-run" });
			const frame = await client.waitFor((f) => f.type === "ok" && f.id === "cancel-3", "cancel noop");
			assert.equal(frame.result.cancelled, false);
		});

		await step("未知帧类型被拒（unknown_type）", async () => {
			client.send({ type: "not-a-frame", id: "weird-1" });
			const frame = await client.waitFor((f) => f.type === "error" && f.id === "weird-1", "unknown_type");
			assert.equal(frame.code, "unknown_type");
		});

		await step("坏 JSON 被拒（bad_frame）", async () => {
			client.sendRaw("{ this is not json }\n");
			const frame = await client.waitFor((f) => f.type === "error" && f.code === "bad_frame", "bad_frame");
			assert.ok(frame);
		});

		await step("超长帧被拒（too_large）且会话存活", async () => {
			// 必须超过 LIMITS.maxInboundFrameBytes（1 MiB）才会走「丢行」路径。
			client.sendRaw(`${JSON.stringify({ type: "prompt", id: "huge", text: "a".repeat(1_200_000) })}\n`);
			const frame = await client.waitFor((f) => f.type === "error" && f.code === "too_large", "too_large");
			assert.ok(frame);

			client.send({ type: "ping", id: "after-huge" });
			const pong = await client.waitFor((f) => f.type === "pong" && f.id === "after-huge", "pong");
			assert.ok(pong);
		});

		await step("超长 prompt 文本被拒（bad_request）", async () => {
			const oversizedText = "a".repeat(100_001);
			client.sendRaw(`${JSON.stringify({ type: "prompt", id: "long-prompt", text: oversizedText })}\n`);
			const frame = await client.waitFor((f) => f.type === "error" && f.id === "long-prompt", "bad_request");
			assert.equal(frame.code, "bad_request");
		});

		await step("shutdown 后进程以 0 退出", async () => {
			client.send({ type: "shutdown", id: "bye" });
			await client.waitFor((f) => f.type === "ok" && f.id === "bye", "shutdown ok");
			const { code } = await client.exited;
			assert.equal(code, 0, `期望退出码 0，实际 ${code}`);
		});

		await step("stdout 只有协议帧，stderr 没有协议帧", async () => {
			assert.deepEqual(client.protocolViolations, []);
			const stderr = client.stderr();
			assert.ok(!stderr.includes('"type":"event"'), "stderr 不应出现协议帧");
			assert.ok(!stderr.includes("fatal"), `stderr 不应出现 fatal：${stderr.slice(0, 300)}`);
		});
	} finally {
		await client.stop();
	}

	if (failures.length > 0) {
		console.error(`\n离线端到端验证失败：${failures.length} 项`);
		process.exit(1);
	}
	console.log("\n离线端到端验证通过");
}

await main();