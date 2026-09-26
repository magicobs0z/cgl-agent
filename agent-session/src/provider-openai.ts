/**
 * OpenAI 兼容（`openai-completions`）provider 工厂。
 *
 * 这里的 provider **不携带任何模型清单**：id / baseUrl / 上下文窗口 / 最大输出
 * 全部来自内核下发的 `model.set` 帧。这是刻意的——模型目录属于用户配置，
 * 内核才是它的存放处，把目录搬到 Node 层会让「用户改了配置但会话用的是旧
 * 目录」这类错配无从排查。
 *
 * 凭证通过闭包读取（`getApiKey`），而不是在建 provider 时取一次值：这样
 * `credentials.set` 之后无需重建 provider，密钥也不会被复制进 provider 对象里
 * 长期留存。
 */

import { createProvider, type Provider } from "@earendil-works/pi-ai";
import {
	stream as openaiStream,
	streamSimple as openaiStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import type { HostModelDescriptor } from "./protocol.ts";

/** 本运行时实现（并允许）的 API 线协议。 */
export const SUPPORTED_APIS: readonly string[] = ["openai-completions"];

export interface ProviderFactoryInput {
	descriptor: HostModelDescriptor;
	getApiKey: () => string | undefined;
}

/**
 * 参数逆变使 `Model<"openai-completions">` 无法直接赋给 `Model<Api>` 形参，
 * 因此这里显式断言；对应关系由 `SUPPORTED_APIS` 在入口处校验，是受控的。
 */
const streams = {
	stream: openaiStream as unknown as Provider["stream"],
	streamSimple: openaiStreamSimple as unknown as Provider["streamSimple"],
};

export function createOpenAIProvider(input: ProviderFactoryInput): Provider {
	const { descriptor, getApiKey } = input;
	const model = {
		id: descriptor.model.id,
		name: descriptor.model.name ?? descriptor.model.id,
		api: descriptor.api,
		provider: descriptor.provider,
		baseUrl: descriptor.baseUrl,
		reasoning: descriptor.model.reasoning ?? false,
		input: descriptor.model.input ?? (["text"] as ("text" | "image")[]),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: descriptor.model.contextWindow,
		maxTokens: descriptor.model.maxTokens,
	};

	return createProvider({
		id: descriptor.provider,
		baseUrl: descriptor.baseUrl,
		models: [model],
		auth: {
			apiKey: {
				name: `${descriptor.provider} API key`,
				// 未下发凭证时返回 undefined，`Models` 会以「provider not configured」
				// 拒绝请求，而不是发出一次无鉴权的调用。
				resolve: async () => {
					const apiKey = getApiKey();
					return apiKey === undefined ? undefined : { auth: { apiKey } };
				},
			},
		},
		api: streams,
	});
}