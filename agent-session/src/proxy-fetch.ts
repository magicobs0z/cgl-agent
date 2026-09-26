/**
 * 走系统代理的 `fetch` 实现。
 *
 * 为什么必须自己实现：Pi 的 `openai-completions` 适配器自己**不**解析代理
 * （仓库内只有 bedrock 与 codex 两个适配器调用 `resolveHttpProxyUrlForTarget`），
 * 它把 HTTP 交给 `openai` SDK，SDK 用全局 `fetch`。所以代理只能在「注入的
 * `fetch`」这一层承担 —— 这也是内核把系统代理设置注入 Node 会话后，唯一
 * 真正生效的位置。
 *
 * 复用上游的代理判定逻辑（`no_proxy`、协议端口默认值、SOCKS/PAC 拒绝）而不
 * 重写它，避免两套判定规则漂移。传输本身用 `node:http`/`node:https` 加
 * `http-proxy-agent`/`https-proxy-agent`：这两个包已在 vendor 依赖里，且
 * vendor 里没有 `undici`/`proxy-agent`，不为代理再引一棵新依赖树。
 *
 * 明确不支持流式请求体：模型请求体是 JSON 字符串，不需要流式；遇到流式体
 * 直接抛错，而不是悄悄退化成全局 fetch（那会绕过代理，正是要避免的）。
 */

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";

/** 代理相关环境变量（内核注入）；大小写皆可，与上游判定保持一致。 */
export type ProxyEnv = Record<string, string | undefined>;

type FetchLike = typeof globalThis.fetch;

function targetUrlOf(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function pickAgent(target: URL, proxy: URL): http.Agent {
	if (target.protocol === "http:" && proxy.protocol === "http:") {
		return new HttpProxyAgent(proxy);
	}
	// 其余组合（https 目标，或 https 代理）都走 CONNECT 隧道。
	return new HttpsProxyAgent(proxy);
}

function toHeaderRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

function responseHeadersOf(raw: http.IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			// `set-cookie` 需要逐条添加，其余数组合并即可（SSE 只关心 content-type）。
			if (key.toLowerCase() === "set-cookie") {
				for (const entry of value) headers.append(key, entry);
			} else {
				headers.set(key, value.join(", "));
			}
			continue;
		}
		headers.set(key, value);
	}
	return headers;
}

function isStreamLikeBody(body: unknown): boolean {
	if (body === null || body === undefined) return false;
	if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return true;
	return typeof (body as { pipe?: unknown }).pipe === "function";
}

function bodyToBuffer(body: unknown): Buffer | undefined {
	if (body === null || body === undefined) return undefined;
	if (typeof body === "string") return Buffer.from(body, "utf8");
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof Uint8Array) return Buffer.from(body);
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	throw new Error(`不支持的请求体类型：${Object.prototype.toString.call(body)}`);
}

/**
 * 构造一个 `fetch`：目标命中代理时经代理转发，否则委托全局 `fetch`。
 *
 * 判定是**逐请求**进行的（`no_proxy` 允许按主机名绕过），所以这里返回的
 * 永远是一个函数，而不是「有/无代理」的二选一。
 */
export function createProxyFetch(env: ProxyEnv): FetchLike {
	const proxyFetch: FetchLike = async (input, init) => {
		const targetHref = targetUrlOf(input);
		const proxyUrl = resolveHttpProxyUrlForTarget(targetHref, env as Record<string, string>);
		if (!proxyUrl) {
			return globalThis.fetch(input, init);
		}

		if (isStreamLikeBody(init?.body)) {
			throw new Error("代理传输不支持流式请求体");
		}

		const target = new URL(targetHref);
		const body = bodyToBuffer(init?.body);
		const headers = new Headers(init?.headers);
		if (body && !headers.has("content-length")) {
			headers.set("content-length", String(body.byteLength));
		}
		if (!headers.has("accept-encoding")) {
			// 不让代理链路引入压缩：SSE 解析在上游按明文处理。
			headers.set("accept-encoding", "identity");
		}

		const transport = target.protocol === "https:" ? https : http;
		const agent = pickAgent(target, proxyUrl);

		return await new Promise<Response>((resolve, reject) => {
			const request = transport.request(
				{
					protocol: target.protocol,
					hostname: target.hostname,
					port: target.port || (target.protocol === "https:" ? 443 : 80),
					path: `${target.pathname}${target.search}`,
					method: init?.method ?? (body ? "POST" : "GET"),
					headers: toHeaderRecord(headers),
					agent,
					signal: init?.signal ?? undefined,
				},
				(response) => {
					const status = response.statusCode ?? 0;
					// 204/304 无实体，构造带 null 体的 Response 才是合法状态。
					if (status === 204 || status === 304) {
						response.resume();
						resolve(
							new Response(null, {
								status,
								statusText: response.statusMessage ?? "",
								headers: responseHeadersOf(response.headers),
							}),
						);
						return;
					}
					const stream = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
					resolve(
						new Response(stream, {
							status,
							statusText: response.statusMessage ?? "",
							headers: responseHeadersOf(response.headers),
						}),
					);
				},
			);

			request.on("error", reject);
			if (body) request.write(body);
			request.end();
		});
	};

	return proxyFetch;
}