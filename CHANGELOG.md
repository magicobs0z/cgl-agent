# 变更记录

本文件记录 `copper-lamp.demo-tools` 模块模板的版本变更，采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格。

版本号规则：`x.x.x`，第一位保持 `0`，第二位为大版本，第三位为小版本。**版本号由维护者下达指令后变更**，规则见 [docs/发布流程.md](docs/发布流程.md)。

每个已发布版本的标题必须与 git tag（`v<version>`）、`module.json` 的 `version` 三者严格一致。

## [Unreleased]

### Added

- 待定：暂无。

### Changed

- 待定：暂无。

### Fixed

- 待定：暂无。

## [0.1.0] - 2026-09-06

> 日期说明：`2026-09-06` 为占位日期，须在打 tag 时与 tag 指向的提交日期核对一致。版本标题中的日期、git tag（`v0.1.0`）与 `module.json` 的 `version`（`0.1.0`）三者必须严格一致，不一致会被 CI 拒绝。

首个版本。这是模块模板的初始发布，交付的是一个可 clone、可校验、可打包、可提审的附加模块骨架。**后端接入内核编译当前受内核侧阻塞**，见下方「阶段一接入的已知阻塞」。

### Added

相对「上一版本」的可见变化：**本版本为首次发布，无上一版本可比。** 以下为初始交付内容。

- **模块清单**：`module.json` 声明模块身份与元信息。
  - `id` 为 `copper-lamp.demo-tools`（两段式，全局唯一）。
  - `i18n_namespace` 为 `demo-tools`（单段，`t()` 键前缀取此值）。
  - `display_name` 为「示例工具」，`description` 为一句话简介；`i18n` 提供 `en-US` 覆盖。
  - `license` 为 `MIT`，`version` 为 `0.1.0`，`category` 为 `utility`。
- **清单 Schema**：`module.schema.json`，编辑器实时校验与 CI 校验共用同一份 schema。
- **后端骨架**：`src-tauri/` 下的 Rust crate，实现内核 `Module` trait 的 `id` / `init` / `start` / `stop`。
  - `module.rs`：生命周期唯一落点，含 `i18n` 语言包注册、事件订阅、意图声明。
  - `commands.rs`：模块 Tauri 命令（薄封装，参数校验 + 调 service）。
  - `service.rs`：业务逻辑，与命令层解耦，便于单测。
  - `storage.rs`：`migrate_scope` 数据库迁移与读写访问器。
  - `intents.rs`：意图声明与处理。
  - `manifest.rs`：`module.json` 的反序列化结构（与 schema 对齐）。
  - `build.rs`：构建期把 `module.json` 注入为编译期常量。
- **前端骨架**：`frontend/` 下的 Vue 3 + TypeScript + Vite 包。
  - `register.ts`：唯一注册入口，调用 `registerModule({ id, nav, routes })`，注册导航项与两条路由。
  - `api.ts`：命令类型化封装，经内核 `call` 调用，禁止裸调 `invoke`；含「命令未注册」的归一化处理。
  - `events.ts`：内核事件类型化封装（`download.status` → `download-status`）。
  - `ModulePage.vue` / `ModuleDetail.vue`：列表页与详情页。
  - `components/`：列表行与空状态组件，图标取自 `@lucide/vue`。
  - `composables/useModuleState.ts`：模块级状态单例，含 in-flight 合并、事件节流刷新、监听引用计数。
  - `locales/zh-CN.json` / `locales/en-US.json`：扁平键语言包，键集一致。
  - `styles/module.css`：仅消费 `var(--copper-*)` 主题令牌。
- **脚本**：
  - `scripts/validate-manifest.mjs`：schema 校验 + 语言包键集一致性检查。
  - `scripts/package-module.mjs`：打包为 `.cglm`（zip 容器）+ 同名 `.sha256`，含包内逐文件 `manifest.sha256`。
  - `scripts/import-dev-module.mjs`：把本地构建结果同步进内核的附加模块目录并写 `dev.json`。
- **文档**：`README.md`、`AGENTS.md`、`THIRD_PARTY_NOTICES.md`，以及 `docs/` 下的开发指南、模块契约、发布流程、设计。

### 元信息

| 项 | 值 | 变更说明 |
|---|---|---|
| `api_version` | `1` | 初始版本，对齐内核 `Module` trait 契约版本 `1`。未变更。 |
| `schema_version` | `"1"` | 清单格式版本初始值。未变更。 |
| `launcher.min` | `0.1.0` | 最低内核版本。本版本未提高。 |
| `launcher.max` | `null` | 无上限。未变更。 |
| `platforms` | `["windows-x86_64"]` | 初始平台承诺。 |

### 权限

**本版本权限为空数组 `[]`**——模块不申请任何权限。

- 未新增权限，故无需用户增量同意。
- 未使用 `filesystem:read` / `filesystem:write` / `filesystem:game-dir` / `network` / `process:spawn` / `download:enqueue` / `settings:write` / `intents:request` / `account:read` 中的任何一项。
- 说明：模块示例代码中演示了对内核事件 `download.status` 的**订阅**。订阅事件在内核当前实现中不经过沙箱权限判定（沙箱的强制路径是意图声明 / 发起），因此不构成 `events` 相关权限申请。若后续内核为事件通道加上权限强制，本模块需重新评估权限声明。

### 数据库迁移

- 迁移 scope：`module:copper-lamp.demo-tools`（用完整 id，点号保留；scope 只是 `schema_migrations` 表里的文本值，不参与标识符解析）。
- 表前缀：`module_copper_lamp_demo_tools_`（`.` 与 `-` 换 `_`；SQLite 标识符不允许含点号）。
- 迁移版本：
  - `1` — `demo_tools_note`：建立笔记记录表（含标题、正文、时间戳）。
  - `2` — `demo_tools_note_pinned_index`：新增 `pinned` 列并建立排序索引。
- 目标 schema 版本：`2`（模块 `init` 阶段经 `kernel.db().migrate_scope(...)` 执行，幂等、按版本升序、事务内提交、失败回滚）。
- **本版本无破坏性数据库变更**（首次建立，无既有数据需要迁移）。

### 破坏性变更

无。本版本为首次发布。

### 已知限制与未实现项（诚实标注）

以下能力**尚未实现**，本版本不承诺、不提供。均属内核侧阶段二工作：

- **附加模块动态加载**：内核 `ModuleRegistry` 无磁盘装载路径，本模块当前只能以**源码依赖**形态接入内核一起编译。
- **子进程托管与 IPC**：内核沙箱的权限判定语义已落地，但受管控子进程的拉起与 IPC 传输未实现，物理隔离尚未生效。
- **运行期前端包装配**：附加模块前端无法在运行期注册，需内核静态 `import` 本模块的 `register.ts`。
- **命令动态注册**：内核命令表 `generate_handler![...]` 为静态列表，本模块命令需人工加入内核后才能调用；未加入时前端如实显示「命令不可用」。
- **签名与来源校验**：内核无签名校验代码。
- **手动导入命令**：`modules_import_local` / `modules_import_archive` / `modules_dev_reload` / `modules_dev_log` / `modules_import_list` 均未实现，`npm run import:dev` 只能直接写文件系统。

因此，面向终端用户的「模块列表一键安装」在本版本**不可用**。发布包当前用于开发期分发（源码包 + 校验值）。详见 [docs/设计.md](docs/设计.md) 2.4。

### 阶段一接入的已知阻塞（诚实标注）

本版本声称的「源码依赖形态接入内核」**当前无法编译通过**，受阻于两处内核侧 / 环境侧问题（均非本模块代码问题）：

- **G14 内核 crate 未开放模块可见性**：`CopperCore/src-tauri/src/lib.rs` 的 `mod commands; mod error; mod modules; mod registry; mod services; mod state;` 全部私有、无 `pub mod` / `pub use`。本模块 `src-tauri/` 以 path 依赖引入后无法命名 `KernelContext` / `Module` / `KernelError`，编译失败。修复需内核侧改为 `pub mod`。
- **G15 内核依赖链需要 OpenSSL**：内核 `Cargo.toml` 直接依赖 `openssl = "0.10"`（在 `services/native_install.rs`、`services/store_rst.rs`、`services/store_rst_transport.rs`、`modules/game_download/msixvc.rs` 四处实际使用，不可删）。缺 OpenSSL 开发环境的机器无法完成链接。

**本版本实测通过的范围**（前端链路与工具链）：`npm run schema:check`、`npm test`（17/17）、`npm run build:frontend`（`vue-tsc` 0 错误 + `vite build`）、`npm run dev`、`npm run package`（真实产出 `.cglm` + `.sha256`，经解压工具逐文件校验一致）、`npm run submit`（dry-run）。

**本版本未实测通过的范围**：后端编译与 `cargo test`，受阻于 G14 与 G15。

[Unreleased]: https://github.com/copper-lamp/cgl-models/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/copper-lamp/cgl-models/releases/tag/v0.1.0
