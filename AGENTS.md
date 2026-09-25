# AGENTS.md 

---

## 项目性质

- 本仓库是**附加模块**仓库，**不是内核仓库**。模块代码不定义内核行为，只消费内核契约。
- 内核契约以 `https://github.com/copper-lamp/CopperGolemLauncher.git` 源码为准。**不得在模块内臆造内核接口**——不确定时去读 `/src-tauri/src/` 与 `/frontend/src/` 的真实源码，而不是猜。
- 契约对不上的表现通常是「运行起来没反应」（界面无变化、无报错），不是编译错误。排查表见 [docs/开发指南.md](docs/开发指南.md) 第六章。
- 项目是生产级项目，要投入市场。

## 禁止假实现

- 禁止假实现，禁止简化实现重要业务逻辑。
- 禁止用「看起来能跑」的桩代码冒充完成的功能。
- 执行不适用的能力时**必须如实暴露失败**，不得静默吞掉。示例：本仓库 `frontend/src/api.ts` 把「命令未注册」归一化为可读状态，页面显示「命令不可用」，而不是假装成功。
- 测试必须真实断言行为，不得为了让测试通过而放宽断言。

## 命名

- **文件名写该文件的作用，不与该文件的执行顺序挂钩。**
- 反面示例：`step1_init.rs`、`01_build.yml`、`phase2_loader.rs`。
- 正面示例：`module.rs`（生命周期）、`storage.rs`（持久化）、`manifest.rs`（清单反序列化）、`module-package.yml`（打包）。


## 前端

- **主题令牌**：只用 `var(--copper-*)`（颜色 / 圆角 / 间距 / 尺寸 / 动效），**禁止颜色字面量**。铜内核设计有主题系统，硬编码颜色会造成风格割裂。
- **图标**：只用 `@lucide/vue` 的图标组件（如 `Puzzle`、`House`），**禁止 emoji**。
- **通信**：**禁止裸调 `invoke`**，一律经内核 `frontend/src/api/core.ts` 的 `call` 或模块自己的 `api.ts` 封装。
- **文案零硬编码**：所有用户可见文案走 i18n 键。
- **事件名**：内核桥接到前端时把 `.` 替换为 `-`（Tauri 事件名不允许点号）。后端 `download.status` → 前端 `listen("download-status")`。
- **性能**：长列表虚拟滚动；进度类事件节流，避免高频重渲染。
- **页面级操作按钮**：经 `#copper-titlebar-actions` Teleport 锚点注入标题栏。

## i18n

- `zh-CN` 与 `en-US` 两份语言包的**键集必须完全一致**（CI 校验，`npm run schema:check`）。
- **语言包命名空间用 `i18n_namespace`（单段），不是 `id`（两段式含点号）。**
- **键为扁平结构**（如 `"navTitle": "示例工具"`），不再套一层对象。
- **后端 `register_module_pack` 与前端 `t()` 必须使用同一个 `i18n_namespace`**，不得一处用 `id`、一处用命名空间。

## 数据

- **表名前缀为 `module_<id>_`**，把 `id` 中的 `.` 与 `-` 替换为 `_`：`copper-lamp.demo-tools` → `module_copper_lamp_demo_tools_`。
- **迁移用 `migrate_scope("module:<id>", &MIGRATIONS)`**，`scope` 文本保留原始完整 id（`"module:copper-lamp.demo-tools"`）。scope 只是 `schema_migrations` 表里的一个文本值，不参与 SQL 标识符解析。
- **不得绕过迁移直接建表。** 所有 schema 变更都走版本迁移（`Migration { version, name, sql }`），按版本升序执行未应用项，事务内提交、失败回滚。
- `with_conn(|conn| ...)` 的闭包内**不得再调用数据库服务的锁方法**，否则死锁。
- 需要长期保存的状态放数据库，不放进程内内存。

## 八、权限

- **权限最小化**：`module.json` 的 `permissions` 默认空数组 `[]`。
- **不得为了省事添加权限。** 每新增一项必须在 `README.md` 的权限说明小节写明申请理由，并在 `CHANGELOG.md` 中记录。
- 权限枚举为 9 项细粒度字符串，逐字取自权威清单：`filesystem:read` / `filesystem:write` / `filesystem:game-dir` / `network` / `process:spawn` / `download:enqueue` / `settings:write` / `intents:request` / `account:read`。
- 申请 `account:read` 必须在 README 说明数据用途与是否外传；**禁止把用户令牌用作模块自身鉴权**。
- 权限声明与代码行为必须一致——不一致是收录审核红线。

## 隔离（子进程）

- 模块运行在受管控的**子进程**中，`permissions` 由宿主强制执行；`module.json` 的 `permissions` 是**授权上界**，宿主实际授予集必然是它的子集。
- **禁止假设自己与内核同进程**；禁止依赖共享内存；禁止直接访问内核内部结构。
- **现状诚实标注**：权限判定侧（内核沙箱）**已落地**——9 项权限枚举、声明即授权上界、文件路径穿越拦截（拒绝相对路径 / 规范化后比较 / 按路径组件比较）、越权留痕与超限强制停用、用户只能收紧不能提权。
- **受管控子进程托管与 IPC 传输尚未实现**，即「附加模块跑在独立进程」这一物理隔离尚未生效。因此现阶段不得把「已隔离」当作前提来设计模块行为，例如不得依赖跨进程消息边界来做数据一致性假设。
- 跨进程请求经沙箱 `enforce` 判定；未登记的模块被视为内核内置、不经沙箱。**模块无法自我声明豁免。**

## 参考

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 快速上手：功能、平台、安装、权限、开发、许可 |
| [docs/开发指南.md](docs/开发指南.md) | 从零到提审的完整流程与排查表 |
| [docs/模块契约.md](docs/模块契约.md) | 内核硬契约摘录，逐条标注出处路径 |
| [docs/发布流程.md](docs/发布流程.md) | 版本号、tag、Release、提审 bot、幂等与回滚 |
