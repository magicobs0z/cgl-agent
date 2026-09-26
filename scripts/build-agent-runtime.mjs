#!/usr/bin/env node
/**
 * 构建受监管 Node 运行时的单文件产物。
 *
 * 关键决定：**直接对 vendored 上游源码打包**。
 * 上游四个包的 `exports` 只映射到 `dist/*`，而仓库里从未构建过 dist，所以既不能
 * 依赖 npm dist，也不该为它跑一遍上游的 TS 构建（那会把整棵 devDependency 树拉
 * 进来）。这里用一个 onResolve 插件把 `@earendil-works/*` 映射到 vendor 源码，
 * 产物是自包含的单个 .mjs：发布包里不需要带 node_modules。
 *
 * 产物分两处：
 * - `runtime/pi-session.mjs`           生产产物，随模块打包（module.json 的 runtime.entry）
 * - `agent-session/test/.build/*.mjs`  离线验证产物，仅本地存在（已 gitignore）
 *
 * 构建后做一次硬校验：产物不得引用 node:child_process —— 模块不得持有拉起进程的
 * 能力，这是「进程只能由内核派生并监管」在构建期的机械保证，不是一句约定。
 */

import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, "..");
const vendorPackages = path.join(moduleRoot, "vendor", "pi", "packages");

/** vendored 包名 -> vendor 目录名。 */
const VENDORED_PACKAGES = {
	"pi-ai": "ai",
	"pi-agent-core": "agent",
	"pi-telemetry": "telemetry",
	chord: "chord",
};

/**
 * 把 `@earendil-works/<pkg>[/<sub>]` 解析到 vendor 源码。
 *
 * 子路径规则（上游 exports 的 `./utils/*`、`./api/*`、`./providers/*` 形态）：
 * 先试 `<sub>.ts`，再试 `<sub>/index.ts`，包根取 `src/index.ts`。
 */
const vendoredPiPlugin = {
	name: "vendored-pi",
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^@earendil-works\// }, (args) => {
			const rest = args.path.slice("@earendil-works/".length);
			const slash = rest.indexOf("/");
			const packageName = slash === -1 ? rest : rest.slice(0, slash);
			const subPath = slash === -1 ? "" : rest.slice(slash + 1);

			const directory = VENDORED_PACKAGES[packageName];
			if (!directory) {
				return { errors: [{ text: `未知的 vendored 包：${args.path}` }] };
			}
			const sourceRoot = path.join(vendorPackages, directory, "src");
			if (subPath === "") {
				return { path: path.join(sourceRoot, "index.ts") };
			}
			const direct = path.join(sourceRoot, `${subPath}.ts`);
			if (existsSync(direct)) return { path: direct };
			const indexed = path.join(sourceRoot, subPath, "index.ts");
			if (existsSync(indexed)) return { path: indexed };
			return { errors: [{ text: `vendor 源码中找不到 ${args.path}` }] };
		});
	},
};

function readVersion() {
	const moduleJsonPath = path.join(moduleRoot, "module.json");
	const source = existsSync(moduleJsonPath) ? moduleJsonPath : path.join(moduleRoot, "package.json");
	const parsed = JSON.parse(readFileSync(source, "utf8"));
	return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

/** 与 package.json 的 build:runtime 保持同一份配置，避免两处漂移。 */
function configFor(entryPoint, outfile, version) {
	return {
		entryPoints: [entryPoint],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		splitting: false,
		sourcemap: false,
		minify: false,
		treeShaking: true,
		legalComments: "inline",
		// 仅 Node 内建模块外置：第三方依赖全部打进产物，发布包无需 node_modules。
		external: ["node:*"],
		// 第三方依赖（openai / typebox / partial-json / *-proxy-agent ...）只存在于
		// vendor/pi 的 node_modules 中，本仓库根部的 node_modules 是前端依赖，不含它们。
		nodePaths: [path.join(moduleRoot, "vendor", "pi", "node_modules")],
		define: { __CGL_RUNTIME_VERSION__: JSON.stringify(version) },
		// 打进产物的第三方依赖里仍有 CJS 包会在运行时 `require()` Node 内建模块
		// （例如 yaml 会 require("process")）。ESM 产物里没有 require，esbuild 生成的
		// 兜底会直接抛错，所以按上游 README 的建议补一个基于 createRequire 的 shim。
		// 它只服务于「被打进来的 CJS 依赖」；本项目自己的代码一律用 ESM import。
		banner: {
			js: [
				'import { createRequire as __cglCreateRequire } from "node:module";',
				"const require = __cglCreateRequire(import.meta.url);",
			].join("\n"),
		},
		plugins: [vendoredPiPlugin],
		logLevel: "warning",
	};
}

/** 模块不得持有拉起进程的能力。 */
const FORBIDDEN_IN_OUTPUT = [
	{ pattern: /node:child_process/, label: "node:child_process" },
	{ pattern: /require\(["']child_process["']\)/, label: "require('child_process')" },
];

function verifyNoForbiddenImports(outfile) {
	const code = readFileSync(outfile, "utf8");
	const hits = FORBIDDEN_IN_OUTPUT.filter(({ pattern }) => pattern.test(code));
	if (hits.length > 0) {
		throw new Error(
			`构建产物 ${path.relative(moduleRoot, outfile)} 引用了 ${hits
				.map(({ label }) => label)
				.join(", ")}：模块不得持有拉起进程的能力，请收敛入口的 import 图。`,
		);
	}
}

async function main() {
	const version = readVersion();

	const productionOutfile = path.join(moduleRoot, "runtime", "pi-session.mjs");
	mkdirSync(path.dirname(productionOutfile), { recursive: true });
	await build(
		configFor(path.join(moduleRoot, "agent-session", "src", "main.ts"), productionOutfile, version),
	);
	verifyNoForbiddenImports(productionOutfile);

	const testOutfile = path.join(moduleRoot, "agent-session", "test", ".build", "pi-session.test.mjs");
	mkdirSync(path.dirname(testOutfile), { recursive: true });
	await build(
		configFor(path.join(moduleRoot, "agent-session", "test", "offline-entry.ts"), testOutfile, version),
	);
	verifyNoForbiddenImports(testOutfile);

	for (const outfile of [productionOutfile, testOutfile]) {
		const kib = (statSync(outfile).size / 1024).toFixed(1);
		console.log(`${path.relative(moduleRoot, outfile).replaceAll("\\", "/")}  ${kib} KiB`);
	}
	console.log(`runtime 版本：${version}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});