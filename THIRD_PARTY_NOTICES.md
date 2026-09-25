# 第三方组件与许可声明

本文件登记 `copper-lamp.demo-tools` 模块模板用到的全部第三方组件、授权来源，并声明本模板的二进制分发边界。

> 合规要求（对齐主仓库 `docs/cgl-models.md` 3.3）：随模块分发的任何二进制（DLL / 字体 / 图标 / 预编译库）都必须登记在本文，写明来源、版本与授权依据。
> 许可一致性：`module.json` 的 `license`、仓库 `LICENSE` 文件、`README.md` 的许可声明、`cgl-libs` 收录条目的 `license` 四处必须一致。

---

## 一、重要声明：本模板未分发任何第三方二进制

**本模板不分发任何第三方二进制文件。** 具体而言：

| 二进制类型 | 本模板是否分发 | 说明 |
|---|---|---|
| 第三方 DLL | **否** | 仓库内不含任何 `.dll`。发布包 `backend/` 下只有本模块自身编译产物 |
| 第三方 `.so` / `.dylib` | **否** | 同上 |
| 字体文件（`.ttf` / `.otf` / `.woff` / `.woff2`） | **否** | 前端不使用自定义字体文件，字体族由宿主启动器提供 |
| 图标文件（`.png` / `.ico` / `.svg` 二进制资源） | **否** | 模块图标 `assets/icon.svg` 为本模板自绘的矢量文件，非第三方资源；界面图标是 `@lucide/vue` 的**源码组件**（编译进前端 JS 产物），不是字体或图片二进制 |
| 预编译库 / 静态库（`.lib` / `.a`） | **否** | 仓库内不含任何预编译库 |
| 游戏本体或其反编译产物 | **否** | 本模板不含、不下载、不分发 Minecraft / MCBE 游戏本体的任何部分 |

需要特别注意的一点：**发布包中的 `backend/<产物>`（如 `copper_module_demo.dll`）是本模块自身的编译产物，不是第三方二进制。** 它是从本仓库 `src-tauri/` 的源码在 CI 中编译得到的。CI 构建方式见 `module-package.yml`。

若模块作者后续引入任何第三方二进制，**必须在本文补登**，写明来源、版本与授权依据。**不得分发授权不明的二进制。**

---

## 二、Rust 侧依赖（`src-tauri/Cargo.toml`）

| 组件 | 用途 | 许可 | 来源 |
|---|---|---|---|
| `tauri` | 模块对内核暴露 Tauri 命令所需的宿主框架绑定 | MIT 或 Apache-2.0（双许可） | https://github.com/tauri-apps/tauri |
| `serde` / `serde_json` | `module.json` 反序列化与事件 / 意图负载的 JSON 处理 | MIT 或 Apache-2.0（双许可） | https://github.com/serde-rs/serde |
| `log` | 模块日志输出（内核经 `tauri-plugin-log` 统一写出） | MIT 或 Apache-2.0（双许可） | https://github.com/rust-lang/log |
| `copper-downloader` | 内核提供的下载引擎 crate（经 `CopperCore` 依赖链引入） | 见 `CopperCore` 仓库许可（GPL-3.0） | 本工作区 `CopperCore/` |

说明：

- Rust 依赖的实际版本以 `src-tauri/Cargo.lock` 为准；本表只登记直接依赖与用途。
- 传递依赖（transitive dependencies）的许可清单可由 `cargo metadata` 或 `cargo-license` 生成，随依赖变更更新。
- 本模块后端 crate 以 **path 依赖**形态接入内核，随内核一起编译（阶段一），因此其依赖树与内核依赖树合并。

**GPL 传染性提示**：内核 `CopperCore` 采用 GPL-3.0 许可。若模块以源码依赖形态与内核一起编译、或链接到 GPL 许可的 crate（如 `copper-downloader`），模块整体许可须与 GPL 兼容。模板自身的 `MIT` 许可在**独立分发骨架源码**的场景下成立；模块作者在接入内核编译前须自行确认许可兼容性。此类模块需在提审时显式说明，由维护者单独评估（主仓库 `docs/cgl-models.md` 3.3）。

---

## 三、npm 侧依赖（`package.json`）

### 运行时依赖

| 包 | 用途 | 许可 | 来源 |
|---|---|---|---|
| `vue` | 前端框架（Vue 3） | MIT | https://github.com/vuejs/core |
| `vue-router` | 模块路由 | MIT | https://github.com/vuejs/router |
| `@tauri-apps/api` | 内核命令调用与事件监听的官方 JS 绑定 | MIT 或 Apache-2.0（双许可） | https://github.com/tauri-apps/tauri |
| `@lucide/vue` | **图标库**：界面全部图标 | **ISC** | https://github.com/lucide-icons/lucide |

### 开发依赖

| 包 | 用途 | 许可 | 来源 |
|---|---|---|---|
| `vite` | 前端构建工具 | MIT | https://github.com/vitejs/vite |
| `@vitejs/plugin-vue` | Vite 的 Vue 单文件组件支持 | MIT | https://github.com/vitejs/vite-plugin-vue |
| `vue-tsc` | Vue 单文件组件的 TypeScript 类型检查 | MIT | https://github.com/vuejs/language-tools |
| `typescript` | TypeScript 编译器 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| `ajv` | `module.json` 的 JSON Schema 校验（脚本使用） | MIT | https://github.com/ajv-validator/ajv |

说明：

- 具体版本以 `package-lock.json` 为准。
- 开发依赖不随发布包分发，仅在构建期使用。

---

## 四、图标来源

界面图标全部来自 **`@lucide/vue`**，许可为 **ISC**。

| 项 | 内容 |
|---|---|
| 图标库 | `@lucide/vue` |
| 许可 | ISC（宽松许可，允许商业使用、修改与再分发，要求保留版权与许可声明） |
| 上游项目 | Lucide（https://github.com/lucide-icons/lucide） |
| 使用方式 | 作为 Vue 组件 `import` 后传给 `registerModule` 的 `nav.icon`，或在模板中直接使用 |

本模板使用的图标（均以组件名引用，不使用 emoji）：

| 位置 | 图标组件名 | 用途 |
|---|---|---|
| `frontend/src/register.ts` 的 `nav.icon` | `Puzzle` | 左导航入口图标 |
| `frontend/src/ModulePage.vue` | `Loader2` / `Pencil` / `Plus` / `PlugZap` / `RefreshCw` / `Send` / `StickyNote` / `Trash2` | 列表页操作按钮与区块标题 |
| `frontend/src/ModuleDetail.vue` | `AlertTriangle` / `ArrowLeft` / `Loader2` / `RefreshCw` / `StickyNote` | 详情页返回、加载与错误态 |
| `frontend/src/components/ModuleEmptyState.vue` | 由调用方传入 `@lucide/vue` 图标组件 | 无数据时的引导图标 |

**纪律要求**：界面中禁止使用 emoji 充当图标，一律使用 `@lucide/vue` 图标组件。这不是风格偏好——emoji 在不同平台渲染不一致，且无法跟随主题令牌变色。

ISC 许可的合规要点：再分发时保留版权声明与许可文本。由于图标是以**源码形式编译进前端 JS 产物**（不是独立二进制文件），许可声明以本文的登记为准。

---

## 五、字体

**本模板不分发任何字体文件。**

- 前端样式不声明 `@font-face`，不引入 `woff` / `woff2` / `ttf` / `otf` 资源。
- 字体族由宿主启动器（`CopperCore`）提供，模块侧继承宿主样式。
- 若模块作者需要引入自定义字体，必须：确认该字体的许可允许再分发；把字体文件登记到本文；并注意字体二进制会随发布包分发，从而触发本文第一章的登记义务。

---

## 六、许可清单与 `module.json.license` 的一致性

`module.json` 的 `license` 字段为 **`MIT`**。四处必须一致：

| 位置 | 值 | 状态 |
|---|---|---|
| `module.json` 的 `license` | `MIT` | 一致 |
| 仓库 `LICENSE` 文件 | MIT 全文 | 一致 |
| `README.md` 的许可声明 | MIT | 一致 |
| `cgl-libs` 收录条目的 `license` | 由提审 bot 从 manifest 直取（`MIT`） | 一致（bot 直取，不转换） |

一致性校验规则：

- `license` 缺失或为空 → 不予收录。
- `license` 为闭源标识时须显式标注 `proprietary`，且只能在 `channel: "beta"` 或 `"dev"` 出现，不允许 `stable`。
- 四处不一致 → 不予收录。缺失或冲突都不接受。

**本模板的第三方组件许可与 MIT 的兼容性说明**：

- 主要第三方组件（Vue、Vite、TypeScript、Tauri、serde、ajv）使用 MIT 或 Apache-2.0 许可，与 MIT 兼容。
- 图标库 `@lucide/vue` 使用 ISC 许可，与 MIT 兼容，要求保留版权与许可声明（本文已登记）。
- 唯一的兼容性注意点见第二章的 **GPL 传染性提示**：内核 `CopperCore` 为 GPL-3.0，本模块以源码依赖形态接入内核编译时须自行确认兼容性。本模板作为独立分发的骨架，`MIT` 声明成立。

---

## 七、合规红线（模块作者必读）

以下任一条被违反，模块不予收录：

1. **不得分发授权不明的二进制。** 任何随包分发的二进制都必须在本文登记来源、版本与授权依据。
2. **不得内置、下载或分发 Minecraft / MCBE 游戏本体或其反编译产物。**
3. **许可四处必须一致**：`module.json.license`、仓库 `LICENSE`、README 声明、`cgl-libs` 条目。
4. **链接 GPL 组件时模块整体许可必须兼容**；此类模块需在提审时显式说明。
5. **展示第三方内容须标注来源**，不得绕过平台的 API 使用条款。

---

## 八、维护约定

- 新增任何依赖或二进制资源时，**同一提交内**更新本文。
- 移除依赖时，从本文删除对应条目。
- 依赖版本升级后复核许可是否变化。
- 本文件的变更属于对用户的可见变更，需在 [CHANGELOG.md](CHANGELOG.md) 中记录。
