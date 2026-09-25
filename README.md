# cgl-models 模块模板

> 铜傀儡附加模块模板：clone 即可得到可校验、可打包、可提审的模块骨架。**后端接入内核编译当前受内核侧阻塞，见「适配平台与内核版本要求」。**

![构建状态](https://img.shields.io/badge/build-module--check-4c8bf5?style=flat-square)
![最新版本](https://img.shields.io/badge/version-0.1.0-4c8bf5?style=flat-square)
![许可](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

本仓库是铜傀儡（CopperGolem）的**第三方附加模块模板仓库**。模块 `copper-lamp.demo-tools`（i18n 命名空间 `demo-tools`）是模板自带的示例，演示命令、事件、意图、数据库与语言包的最小闭环； fork 本仓库后替换其中的示例内容即可开始开发。


## 功能列表

示例模块提供以下最小闭环，每一项都对应一处内核契约：

- **概览**：展示模块 id、i18n 命名空间、版本、内核已装载模块数与已声明意图清单。
- **笔记增删改查**：演示 `migrate_scope` 数据库迁移与命令层 / service 分层。
- **探活**：演示最简命令链路与前端能力探测。
- **意图发起**：发起内核既有意图 `expose.version`，演示跨模块能力获取。
- **事件订阅**：订阅内核事件 `download.status`，演示跨模块事件消费与「至少一次」语义下的去重处理。
- **活动流**：展示模块自有事件与最近活动，演示节流刷新与监听引用计数。
- **命令能力诚实展示**：命令未进入内核静态命令表时，页面如实显示「命令不可用」，不假装可用。

界面图标一律取自 `@lucide/vue`——导航入口用 `Puzzle`，列表页用 `Plus` / `Pencil` / `Trash2` / `PlugZap` / `Send` / `RefreshCw` / `StickyNote` / `Loader2`，详情页用 `ArrowLeft` / `AlertTriangle` / `RefreshCw` / `Loader2` / `StickyNote`。不使用 emoji。

## 适配平台与内核版本要求

| 项 | 值 | 来源 |
|---|---|---|
| 平台 | `windows-x86_64` | `module.json` 的 `platforms` |
| 最低内核版本 | `0.1.0` | `module.json` 的 `launcher.min` |
| 最高内核版本 | 不限 | `module.json` 的 `launcher.max` 为 `null` |
| 模块 API 版本 | `1` | `module.json` 的 `api_version` |

平台枚举是**权威枚举**，与 `cgl-libs` 逐字一致：`windows-x86_64` / `windows-aarch64` / `android-arm64` / `linux-x86_64`。`platforms` 是承诺而非描述——声明了但缺该平台产物的模块，提审直接失败。


## 安装方式

### 启动器模块列表一键安装（当前不可用）

该方式依赖内核的附加模块动态加载能力，**该能力尚未实现**。在此之前，模块列表不会出现本模块，安装按钮也不会生效。

### 手动导入（当前使用）

**方式一：源码依赖接入（阶段一；设计意图可行，但当前被 G14 阻塞，尚不能编译通过）**

1. 把本仓库 clone 到与 `CopperCore` 同级的位置。
2. 在 `CopperCore/src-tauri/Cargo.toml` 中把本模块的 `src-tauri` 加为 path 依赖，并在内核启动流程中按 `ModuleOrigin` 注册本模块。
3. 在 `CopperCore/frontend/src/modules/index.ts` 中静态 `import` 本模块的 `register.ts`。
4. 在 `CopperCore/src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]` 中加入本模块的命令。
5. 编译并启动内核。

**前置条件**：第 5 步之前，内核侧必须先开放 crate 模块可见性（G14，把 `lib.rs` 的私有 `mod` 改为 `pub mod`），并提供 OpenSSL 环境（G15）。在此之前，第 2 步加上的 path 依赖会直接编译失败。

第 2–4 步是阶段一的**已知手工接入步骤**。缺少任一步的表现都是「界面没有变化」而非报错，排查见 [docs/开发指南.md](docs/开发指南.md) 第六章。

**方式二：同步进内核模块目录（开发调试）**

```
npm run import:dev
```

把本地构建结果同步进内核的附加模块目录（`<AppData>/copper-lamp/copper-golem/modules/<id>/`）并写入开发态标记 `dev.json`。该脚本直接写文件系统，不调用内核命令——内核侧的 `modules_import_local` 等导入命令**尚未实现**。

内核侧的模块列表入口位于设置页的「模块」Tab。

## 权限说明

**本模块不申请任何权限。**

`module.json` 的 `permissions` 为空数组 `[]`。模板遵循权限最小化原则：默认不放开任何权限，模块作者按真实需要逐项添加，并在本小节逐项写明申请理由。

可申请的权限为 9 项细粒度枚举（权威定义见 [cgl-libs 契约](https://github.com/copper-lamp/cgl-libs) 与主仓库 `docs/cgl-models.md` 2.4）：

| 权限值 | 含义 | 风险 |
|---|---|---|
| `filesystem:read` | 读取应用数据目录 | 低 |
| `filesystem:write` | 写入应用数据目录 | 中 |
| `filesystem:game-dir` | 读写游戏版本目录 | 高（可篡改游戏文件） |
| `network` | 发起出站网络请求 | 中 |
| `process:spawn` | 启动子进程（如 lip、游戏） | 高 |
| `download:enqueue` | 投递内核下载队列 | 低 |
| `settings:write` | 写入内核设置（`modules.<i18n_namespace>.*` 之外） | 中 |
| `intents:request` | 发起其他模块的意图 | 中 |
| `account:read` | 读取账户信息 | 高（隐私） |

注意事项：

- 声明新增权限属于**对用户的可见变更**，必须在 [CHANGELOG.md](CHANGELOG.md) 中说明。
- 声明 `account:read` 的模块必须在本小节说明数据用途与是否外传；禁止把用户令牌用作模块自身鉴权。
- 权限声明与代码行为不一致是收录审核红线，会被拒绝合并。
- 隔离能力当前**只落地了权限判定侧**（内核沙箱：授权上界、路径穿越拦截、越权留痕与超限强制停用）；**受管控子进程托管与 IPC 传输尚未实现**，即「模块跑在独立进程」这一物理隔离尚未生效。因此权限声明目前是**声明式的授权上界**，而非运行期已经被强制到位的隔离边界。

## 开发

### 环境

| 组件 | 版本 |
|---|---|
| Node.js | 24 |
| Rust | stable |

### 跑起来

```
npm install
npm run dev
```

前端独立预览入口为 `frontend/index.html`（端口 1520）。后端构建与测试：

```
npm run build:backend
cargo test --manifest-path src-tauri/Cargo.toml
```

### 校验

```
npm run schema:check
```

校验 `module.json` 与 `module.schema.json` 一致，并检查 `zh-CN` / `en-US` 语言包键集完全一致。

### 打包

```
npm run package -- --platform windows-x86_64 --backend target/release/copper_module_demo.dll
```

产出 `<id>-<version>-<platform>.cglm` 与同名 `.sha256`。版本号取自 `module.json`，无需手工指定。

### 提审

```
npm run submit
```

以 `--dry-run` 预览将要写入 `cgl-libs` 的收录条目，不产生任何副作用。正式提审由 Release 发布后的 bot workflow 触发。

### 文档

- [开发指南](docs/开发指南.md)：环境、跑起来、改哪几个文件、契约速查、联动范例、调试排查、打包、提审、版本与 CHANGELOG。
- [模块契约](docs/模块契约.md)：内核硬契约摘录，逐条标注出处文件路径。
- [发布流程](docs/发布流程.md)：版本号规则、tag、Release、提审 bot、幂等与回滚。

## 许可与第三方组件

本模板骨架采用 [MIT](LICENSE) 许可，与 `module.json` 的 `license` 字段一致。

第三方组件清单、授权来源与「未分发任何第三方二进制」的声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。图标取自 `@lucide/vue`（ISC 许可）。
