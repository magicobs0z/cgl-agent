# Pi 依赖裁剪副本（vendor）

本目录是 [earendil-works/pi](https://github.com/earendil-works/pi) 的**裁剪副本**，只用于给 `cgl-agent`
构建 Node 侧运行时。它不是可发布的 npm 包，也不接受手工改动上游代码。

## 来源与锁定

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/earendil-works/pi` |
| 稳定 tag | `v0.87.1` |
| 对应 commit | `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` |
| 上游许可 | MIT（见本目录 `LICENSE`） |
| Node 下限 | `>=22.19.0`（四个保留包与上游根 `engines` 一致） |

## 为什么裁剪

上游是含 CLI/TUI 的 npm monorepo。本模块只用它的 Agent 循环、模型调用与会话数据结构，
不打包完整 Pi Coding Agent。裁剪按**依赖图**进行，而不是「只复制两个目录」：

| 保留 | 理由 |
|---|---|
| `packages/agent`（`@earendil-works/pi-agent-core`） | Agent 循环、工具执行、事件流 |
| `packages/ai`（`@earendil-works/pi-ai`） | 模型抽象、provider 与 api 实现 |
| `packages/telemetry`（`@earendil-works/pi-telemetry`） | 上面两者的直接依赖；默认 NOOP，无出网行为 |
| `packages/chord`（`@earendil-works/chord`） | `pi-agent-core` 的直接依赖；只用 `chord/context` 与 `chord/delta` |

已删除：`coding-agent`、`tui`、`client`、`server`、`protocol`、`durable`、`evals`、
`session-backends/*`、上游自己的 `scripts/`、`.github/`、`.husky/`、`.pi/`，
以及各包内的 `test/`、`benchmark/`、`docs/`、`scripts/`、`vitest*` 配置。
这些都只是开发期资产，不在运行依赖图里。

## 不使用上游内置 provider 目录

`packages/ai/src/providers/*.models.ts` 会静态 import 一个由上游 `scripts/generate-models.ts`
生成、且被 `.gitignore` 忽略的 `src/providers/data/*.json`。本副本不含该数据，也不会去生成它。

因此**禁止** import `@earendil-works/pi-ai/providers/all`（或任何 `*.models.ts`、`compat`）。
运行时只 import：
- 包根 `@earendil-works/pi-ai`（核心类型与 `createModels`/`createProvider` 等，不含 provider 目录）；
- 单个需要的 `@earendil-works/pi-ai/api/*`（如 `openai-completions`）；
- `@earendil-works/pi-agent-core` 包根。

provider 与模型条目由 `cgl-agent` 自己声明（见模块 `agent-session/` 内的 provider 目录），
模型元数据（baseUrl、模型 id、上下文窗口等）由本模块维护。

## 依赖安装

第三方依赖由本目录自己的 `package.json` workspace 解析，`node_modules/` 与 lock 均不提交。
在仓库根执行 `npm run vendor:install`（等价于 `npm install --prefix vendor/pi`）后即可构建运行时。

## 升级流程

1. 检出上游新 tag 到临时目录，确认 commit。
2. 按上表重新裁剪（**逐包比对依赖图**，不要凭记忆增删）。
3. 更新本文件与 `THIRD_PARTY_NOTICES.md` 的版本、commit、许可信息。
4. 重新生成 lock，跑 `npm run build:runtime`，确认 `runtime/pi-session.mjs` 能加载并通过离线验收。
5. 审查上游 CHANGELOG 中的 breaking change，逐条确认模块适配层仍成立。