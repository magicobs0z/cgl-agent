// 模块事件订阅：内核事件总线的事件同名桥接到前端，事件名中的 `.` 转为 `-`。
//
// - 模块自有事件：后端 `publish("demo-tools.activity", payload)`，
//   前端监听名 `demo-tools-activity`（见 docs/cgl-models.md 2.7.4）。
// - 内核事件：`download.status` → `download-status`（用于演示跨模块事件消费）。
//
// 所有订阅函数返回 `Unlisten`，调用方必须在卸载时调用，避免监听泄漏。

import { listen } from "@tauri-apps/api/event";

import type { DemoActivity } from "./api";

/** 订阅取消函数。 */
export type Unlisten = () => void;

/** 模块自有事件在前端的事件名（点号已转连字符）。 */
export const DEMO_ACTIVITY_EVENT = "demo-tools-activity";

/** 内核下载状态事件在前端的事件名。 */
export const KERNEL_DOWNLOAD_STATUS_EVENT = "download-status";

/** 内核 `download.status` 负载（与内核 `DownloadTaskView` 同构，snake_case）。 */
export interface KernelDownloadStatusPayload {
  id: number;
  filename: string | null;
  url: string;
  dest: string;
  total_bytes: number;
  downloaded_bytes: number;
  speed_bytes_per_sec: number;
  status: string;
  error: string | null;
  retry_count: number;
}

/** 订阅模块活动事件（后端 `demo-tools.activity`）。 */
export function onDemoActivity(handler: (activity: DemoActivity) => void): Promise<Unlisten> {
  return listen<DemoActivity>(DEMO_ACTIVITY_EVENT, (e) => handler(e.payload));
}

/** 订阅内核下载状态事件（后端 `download.status`）。 */
export function onKernelDownloadStatus(
  handler: (task: KernelDownloadStatusPayload) => void,
): Promise<Unlisten> {
  return listen<KernelDownloadStatusPayload>(KERNEL_DOWNLOAD_STATUS_EVENT, (e) =>
    handler(e.payload),
  );
}
