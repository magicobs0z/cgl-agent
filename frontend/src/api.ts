// 模块命令封装：全部经内核 `call` 调用，禁止裸调 invoke。
//
// 命令名与 Rust 侧 `src-tauri/src/commands.rs` 逐字一致；参数与返回类型用 camelCase
// （后端 serde 已按 camelCase 重命名）。
//
// 重要现状（见 docs/cgl-models.md 2.7.7 / 3.4 G6）：
// 内核的 `tauri::generate_handler![...]` 是**静态列表**，当前只注册了内核自身命令。
// 附加模块声明的 `demo_tools_*` 命令尚未进入该列表，因此在阶段一被调用时，
// Tauri 会以「命令未找到」失败。本文件把这类失败**归一化成可读的能力状态**，
// 供页面如实展示「命令不可用」，绝不假装命令可用。

import { KernelApiError, isKernelApiError, call } from "../../../CopperCore/frontend/src/api/core";

/** 模块 id（完整两段式，仅用于展示与唯一标识）。 */
export const MODULE_ID = "copper-lamp.demo-tools";

/** i18n 命名空间（单段，`t()` 键前缀取此值）。 */
export const MODULE_I18N_NAMESPACE = "demo-tools";

/** 本模块声明的全部后端命令名（与 Rust 侧逐字一致）。 */
export const DEMO_COMMANDS = {
  overview: "demo_tools_overview",
  notesList: "demo_tools_notes_list",
  noteUpsert: "demo_tools_note_upsert",
  noteDelete: "demo_tools_note_delete",
  ping: "demo_tools_ping",
  exposeVersion: "demo_tools_expose_version",
  activityRecent: "demo_tools_activity_recent",
} as const;

/** 命令可用性状态。 */
export type CommandAvailability = "unknown" | "available" | "unavailable";

/** 归一化后的模块 API 错误类型。 */
export type DemoApiErrorKind = "not_registered" | "invoke_unavailable" | "backend" | "unknown";

/** 归一化后的模块 API 错误的**数据结构**。
 *
 * 与下面的 `DemoApiError` 类分开命名：若接口与类同名，TypeScript 会把两者合并成
 * 一个声明空间，`kind` / `rawKind` / `command` 出现「同一属性两种修饰符」的冲突，
 * 且类实例的 `name` 会被接口签名判为缺失。故结构体用 `...Info` 后缀命名。 */
export interface DemoApiErrorInfo {
  /** 失败归类。`not_registered` 表示命令未进入内核 generate_handler。 */
  kind: DemoApiErrorKind;
  /** 原始错误种类（如 `invalid_argument` / `database` / `invoke`）。 */
  rawKind: string;
  /** 面向开发者的原始信息（用于错误态展示，不直接当文案用）。 */
  message: string;
  /** 命令名。 */
  command: string;
}

/** 模块 API 调用失败（携带归一化信息，便于页面做可读展示）。 */
export class DemoApiError extends Error {
  readonly kind: DemoApiErrorKind;
  readonly rawKind: string;
  readonly command: string;

  constructor(info: DemoApiErrorInfo) {
    super(info.message);
    this.name = "DemoApiError";
    this.kind = info.kind;
    this.rawKind = info.rawKind;
    this.command = info.command;
  }
}

/** 判断是否为模块 API 错误。 */
export function isDemoApiError(e: unknown): e is DemoApiError {
  return e instanceof DemoApiError;
}

// 「命令未注册」在 Tauri 2 下的表现随平台 / 版本而异，这里覆盖已知的全部措辞，
// 统一归一化为 `not_registered`，避免页面把「没这命令」误报成后端故障。
const NOT_REGISTERED_PATTERNS = [
  /command\s+.+?\s+not\s+found/i,
  /unknown\s+command/i,
  /not\s+registered/i,
  /no\s+such\s+command/i,
  /not\s+found:\s*command/i,
];

/** 判定原始错误文本是否表示「命令未注册」。 */
export function looksLikeNotRegistered(message: string): boolean {
  return NOT_REGISTERED_PATTERNS.some((re) => re.test(message));
}

/** 把任意异常归一化为 `DemoApiErrorInfo`。 */
export function normalizeApiError(e: unknown, command: string): DemoApiErrorInfo {
  const rawKind = isKernelApiError(e) ? e.kind : "unknown";
  const message = e instanceof Error ? e.message : String(e);

  let kind: DemoApiErrorKind = "unknown";
  if (looksLikeNotRegistered(message)) {
    kind = "not_registered";
  } else if (rawKind === "invoke") {
    // `invoke` 兜底类错误：Tauri 未就绪、命令表未注册、IPC 不可用等。
    kind = "invoke_unavailable";
  } else if (isKernelApiError(e)) {
    kind = "backend";
  }

  return { kind, rawKind, message, command };
}

/** 调用模块命令并归一化错误。 */
async function callModule<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await call<T>(cmd, args);
  } catch (e) {
    throw new DemoApiError(normalizeApiError(e, cmd));
  }
}

/** 命令是否已在内核侧注册（探测型）。 */
export function isCommandNotRegistered(e: unknown): boolean {
  return isDemoApiError(e) ? e.kind === "not_registered" : false;
}

/** 命令不可用的原因是否属于「环境未就绪」（IPC 不可用 / 未在 Tauri 中运行）。 */
export function isCommandUnavailable(e: unknown): boolean {
  if (!isDemoApiError(e)) return false;
  return e.kind === "not_registered" || e.kind === "invoke_unavailable";
}

/** 模块概览（与 Rust `DemoOverview` 同构，camelCase）。 */
export interface DemoOverview {
  /** 模块完整 id。 */
  id: string;
  /** i18n 命名空间（单段）。 */
  i18nNamespace: string;
  /** 模块版本（取自 module.json）。 */
  version: string;
  /** 内核已装载模块数量。 */
  loadedModules: number;
  /** 本模块已声明的意图清单。 */
  intents: string[];
}

/** 一条笔记（与 Rust `DemoNote` 同构，camelCase）。 */
export interface DemoNote {
  /** 自增主键。 */
  id: number;
  /** 笔记标题。 */
  title: string;
  /** 笔记正文。 */
  body: string;
  /** 创建时间（RFC3339）。 */
  createdAt: string;
  /** 最近更新时间（RFC3339）。 */
  updatedAt: string;
}

/** 一条模块活动记录（与 Rust `DemoActivity` 同构，camelCase）。 */
export interface DemoActivity {
  /** 活动类型（如 `note.upsert` / `module.ping`）。 */
  kind: string;
  /** 活动描述。 */
  message: string;
  /** 发生时间（RFC3339）。 */
  at: string;
}

/** 新增 / 更新笔记的参数。 */
export interface DemoNoteUpsertArgs {
  /** 传入 id 表示更新，省略表示新增。 */
  id?: number;
  title: string;
  body: string;
}

/** 模块概览（id / namespace / version / 已装载模块数 / 意图清单）。 */
export function demoOverview(): Promise<DemoOverview> {
  return callModule<DemoOverview>(DEMO_COMMANDS.overview);
}

/** 笔记列表（按更新时间倒序）。 */
export function demoNotesList(): Promise<DemoNote[]> {
  return callModule<DemoNote[]>(DEMO_COMMANDS.notesList);
}

/** 新增或更新一条笔记，返回落库后的记录。 */
export function demoNoteUpsert(args: DemoNoteUpsertArgs): Promise<DemoNote> {
  return callModule<DemoNote>(DEMO_COMMANDS.noteUpsert, { ...args });
}

/** 删除一条笔记。 */
export function demoNoteDelete(id: number): Promise<void> {
  return callModule<void>(DEMO_COMMANDS.noteDelete, { id });
}

/** 探活：返回后端回显文本。 */
export function demoPing(): Promise<string> {
  return callModule<string>(DEMO_COMMANDS.ping);
}

/** 发起一次 `expose.version` 意图并返回结果负载。 */
export function demoExposeVersion(): Promise<string> {
  return callModule<string>(DEMO_COMMANDS.exposeVersion);
}

/** 最近活动列表（后端重放缓冲的只读快照）。 */
export function demoActivityRecent(): Promise<DemoActivity[]> {
  return callModule<DemoActivity[]>(DEMO_COMMANDS.activityRecent);
}

/** 内核事件 `download-status` 的负载子集（仅取本模块展示需要的字段）。 */
export interface KernelDownloadStatus {
  id: number;
  status: string;
  downloadedBytes: number;
  totalBytes: number;
}

export { KernelApiError };
