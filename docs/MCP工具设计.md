# MCP 工具设计

## 需求

AI 助手要让模型能真实排查用户问题，而不是只靠常识作答，因此需要一组由本模块提供给模型的工具。工具的目标是让模型**只读地**取到启动器的真实状态与日志，并在需要时联网检索。

需要覆盖的用户场景：

- 游戏装不上、打不开：安装状态、整包缓存、下载任务与失败原因、上次启动情况。
- 模组装不上或报错：模组目录扫描结果、启用状态、内容安装失败原因、日志。
- 想找模组：按关键词检索可下载内容，查看详情与说明。
- MC 通用问题：模型自身知识不足时联网检索。

设计约束：

- 首期工具全部**只读**。诊断不等于修复；安装、重试、删除、修复等写操作不在首期。
- 复用 Pi Agent Core 的工具调用能力，不另建 Agent 工具框架。
- 工具数据只能来自内核公开命令或内核新增的受控能力，不得直接读取内核私有状态，不得伪造数据。
- 权限最小化：只读本地信息不申请权限；读日志申请文件读取；联网申请网络。
- 输出必须结构化、可截断、可脱敏，不把密钥、令牌或完整账号信息交给模型。

本文只定义工具契约与数据来源。工具在模块内的运行时承载见[设计](设计.md)，模块通用接入见[开发指南](开发指南.md)与[模块契约](模块契约.md)。

## 架构

### 契约优先

每个工具用同一份定义声明：`name`、面向模型的 `description`、`inputSchema`、`output`、所需权限、是否只读。这份定义是唯一来源，用于生成 Pi Agent 工具注册与可能的 MCP 工具描述，避免两处漂移。

传输方式与契约解耦：Pi Agent Core 不是 MCP 客户端，需要一个薄适配层把工具契约注册为 Pi 可调用的工具。实现落在模块 JavaScript 侧（Pi SDK 是 TypeScript 包，且模块前端可经内核命令层取数）；是否再包一层 MCP server 传输属于后续选择，不改变工具契约。

### 统一返回信封

所有工具返回同一结构，便于模型稳定解析：

```text
{
  ok: boolean,
  data: object | array | null,
  truncated: boolean,        // 是否因上限被截断
  truncated_reason: string | null,
  error: { kind: string, message: string } | null
}
```

- 失败不抛原始异常，统一归一化为 `error.kind` + 可读 `message`，语义对齐内核 `CommandError.kind`。
- 任何被截断的结果必须显式标记，不能静默少返回数据。
- 输出尺寸设上限，超出即截断并提示模型缩小查询范围。

### 工具清单：本地只读（当前可实现）

这些工具的数据来自内核已注册命令，模块前端经 `call()` 调用即可。

| 工具 | 用途 | 数据来源（命令） | 权限 |
| --- | --- | --- | --- |
| `cgl_launcher_info` | 启动器与内核版本、平台、路径快照、已加载模块及其失败文本 | `kernel_info`、`paths_snapshot`、`modules_list`、`modules_installed_addons` | 无 |
| `cgl_versions` | 已安装版本清单：名称、游戏版本、类型、是否注册、目录 | `home_versions_list` | 无 |
| `cgl_version_detail` | 单版本详情，可选附带目录内模组 / 资源包 / 行为包 / 世界及启用状态 | `home_version_get`、`home_mods_list`、`home_content_list` | 无 |
| `cgl_game_install_status` | 清单中各版本的安装状态、整包缓存状态、任务状态与错误 | `game_download_manifest`、`game_download_detail`、`game_download_status` | 无 |
| `cgl_downloads` | 内核下载队列：任务、进度、失败原因 | `download_tasks`、`download_task` | 无 |
| `cgl_settings_snapshot` | 白名单范围内的诊断设置（游戏目录、默认版本、下载镜像、通道等） | `settings_all` | 无 |
| `cgl_mod_search` | 按关键词检索可下载内容 | `content_download_list` | 无 |
| `cgl_mod_detail` | 内容详情与 README | `content_download_detail`、`content_download_readme` | 无 |
| `cgl_launch_status` | 游戏进程当前是否运行、本次会话是否启动过 | 进程检测（`home_launch` 内部）、`game.launched` 事件 | 无 |

### 工具清单：需要内核补能力（当前不可实现）

| 工具 | 用途 | 缺失能力 |
| --- | --- | --- |
| `cgl_logs` | 读取与检索内核日志（tail 与关键词搜索、上下文行、显式截断） | 内核无日志读取命令；附加模块后端无文件能力 |
| `cgl_web_search` | 联网检索报错信息、模组资料、MC 问题 | 内核无面向模块的通用 HTTP 命令；`network` 能力未实现 |
| `cgl_web_fetch` | 抓取指定 URL 正文 | 同上 |

这三个工具是“只靠模型知识答不准”时的主要依赖，其中 `cgl_logs` 是用户明确要求的核心能力。在对应内核能力落地前，工具不注册、不对模型可见，界面须如实说明该能力未启用。

### 关键工具定义

**`cgl_logs`**

```text
输入:
  source: "kernel" | "kernel_prev"    默认 kernel
  mode:   "tail" | "search"           默认 tail
  query:  string                      仅 search 模式
  level:  "error" | "warn" | "info"   可选过滤
  limit:  number                      默认 200 行，上限 2000 行
  context_lines: number               search 模式的上下文行，默认 3
  cursor: string                      可选，向后翻页

输出: { lines[], level_counts, file_size, mtime, matched, truncated, ... }
```

要点：

- 日志文件为 `<data>/logs/kernel.log`，历史只有一代 `kernel.log.prev`。
- 返回前做脱敏：用户主目录路径中的用户名、令牌类字段。
- 日志行自身只有相对秒数、无绝对时间戳，且级别被硬编码为 Info，因此工具必须同时返回文件 `mtime` 供对齐时间，并在说明中告知模型 Debug 级内容不会落盘。
- 默认返回尾部内容；命中过多时优先返回最近的条目并标记截断。

**`cgl_launch_status` 的边界**

内核不记录上次启动结果、游戏退出码与崩溃信息。该工具只能回答“当前是否运行中 / 本次会话是否启动过”，不能回答“为什么上次启动失败”。工具描述必须写明这一限制，避免模型编造原因。

**`cgl_mod_search`**

内核元数据客户端本身没有关键词检索，只支持通道过滤；但内容下载模块的 `content_download_list` 自带 `query` 参数，因此模组检索经它实现，返回结果附带内容类型与游戏版本，供模型继续调用 `cgl_mod_detail`。

### 权限模型

- 无权限：全部本地只读工具。
- 文件读取：`cgl_logs` 需要 `filesystem:read`。
- 网络：`cgl_web_search`、`cgl_web_fetch` 需要 `network`。

权限在 `module.json.permissions` 中按收录侧细粒度枚举声明，由用户在内核模块权限界面显式授权，内核沙箱据此拦截。未获授权的工具不出现在模型可用工具列表中，并在界面提示授权入口。能力分级、工作区边界、路径校验、脱敏与提示词注入防护的完整约束见[安全设计](安全设计.md)，工具实现必须同时满足该文件的要求。

### 输出与安全规范

- 设置快照只返回白名单键，不返回完整设置表。
- 日志与内容 README 等自由文本需限制长度并脱敏。
- 工具调用记录只记录工具名、状态与耗时，不记录日志正文、令牌或完整诊断数据。
- 工具参数必须按 schema 校验（类型、长度、枚举、ID 存在性），拒绝未知字段，不接受可拼接出任意路径或命令的自由字符串。

### 阻塞项（需内核侧处理，不在本模块范围内）

1. **日志读取**：内核没有读取日志的命令，日志仅写入 `<data>/logs/kernel.log`。需新增受控读取接口，建议形态：

   ```text
   logs_read(source, mode, query, level, limit, context_lines, cursor)
     -> { lines[], truncated, file_size, mtime }
   ```

   同时建议内核为日志补绝对时间戳，并在返回前统一脱敏。

2. **联网**：需内核提供面向模块的受控 HTTP 命令（推荐，可审计、可加权限），或确认依赖模型 provider 自带联网能力（须逐 provider 验证，不得假定）。

3. **内容安装失败原因缺失**：内容下载模块的失败原因回写语句引用了建表时不存在的列且错误被丢弃，也没有查询通道。即使日志工具就绪，“模组装不上”也拿不到有效错误。需内核修复该列并补查询命令。

在上述阻塞项解决前，`cgl_logs`、`cgl_web_search`、`cgl_web_fetch` 保持未实现状态。

## 备注

- 本地只读工具依赖的是内容下载、开始页、游戏下载、内核等模块公开的前端命令。这属于跨模块调用内核命令层，是当前唯一可用的取数路径；长期应改为声明的意图契约，但该改造属内核/主仓库范围，本模块不自行推动。
- 附加模块后端（helper 子进程）当前能力表只实现 `module.info` 与模块私有 `storage.*`，无法触达文件、网络、设置、事件、意图与数据库。因此工具实现落在模块前端 JS 侧，而不是模块 Rust 后端。若后续内核为附加模块开放更多受控能力，可再评估迁移。
- 首期严格只读。后续若增加写操作工具（安装、重试、删除、修复），必须逐项定义用户确认、可取消性与失败回滚语义，并单独走权限与审核流程。
- 工具清单需与 README、`module.json` 的权限声明保持一致；任何新增工具都要同时更新本文、权限声明与面向模型的描述。
