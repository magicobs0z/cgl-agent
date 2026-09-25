// 模块前端状态单例：概览 / 笔记 / 活动 + 事件驱动刷新。
//
// 动机：附件模块的列表页与详情页都要读同一份数据，若各自请求会出现
// 「一页数据新、一页数据旧」与重复 IPC。这里用模块级单例（模块作用域，
// 非响应式全局）承载数据，页面只负责挂 / 摘事件监听与触发刷新。
//
// 并发策略：
// - `refresh()` 做 in-flight 合并，同一次刷新期间重复调用复用同一 Promise；
// - 活动事件到达时只做**节流刷新**，避免后端高频 publish 引发重渲染风暴
//   （对齐 docs/cgl-models.md 2.8 的「进度类事件节流」要求）。

import { computed, readonly, ref } from "vue";

import {
  demoActivityRecent,
  demoNoteDelete,
  demoNoteUpsert,
  demoNotesList,
  demoOverview,
  demoPing,
  demoExposeVersion,
  isDemoApiError,
  type DemoActivity,
  type DemoNote,
  type DemoOverview,
} from "../api";
import { onDemoActivity, onKernelDownloadStatus, type Unlisten } from "../events";

/** 命令能力探测结果：`unknown` 表示尚未调用过。 */
export type CapabilityState = "unknown" | "available" | "unavailable";

/** 活动列表上限（内存中保留的最大条数）。 */
const ACTIVITY_LIMIT = 50;

/** 活动事件触发的刷新节流窗口（毫秒）。 */
const ACTIVITY_THROTTLE_MS = 400;

// —— 单例状态 ——

const overview = ref<DemoOverview | null>(null);
const notes = ref<DemoNote[]>([]);
const activities = ref<DemoActivity[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
/** 命令能力状态：真实调用失败并归类为「未注册 / IPC 不可用」时置为 unavailable。 */
const capability = ref<CapabilityState>("unknown");
/** 内核下载事件最近一条，用于演示跨模块事件消费。 */
const lastDownloadStatus = ref<string | null>(null);

let inFlight: Promise<void> | null = null;
let listeners: Unlisten[] = [];
let listenerCount = 0;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivityRefresh = 0;
let muted = false;

/** 记录一次能力探测结果（成功即视为可用）。 */
function markAvailable(): void {
  capability.value = "available";
}

/** 记录一次失败并归一化能力状态。 */
function markFailure(e: unknown): void {
  const err = isDemoApiError(e) ? e : null;
  if (err && (err.kind === "not_registered" || err.kind === "invoke_unavailable")) {
    capability.value = "unavailable";
  } else if (capability.value === "unknown") {
    // 后端业务错误说明命令本身可达，能力判定为可用。
    capability.value = "available";
  }
}

/** 从事件负载去重合并进活动列表（同一 kind+at 视为同一条）。 */
function pushActivity(activity: DemoActivity): void {
  if (muted) return;
  const exists = activities.value.some(
    (a) => a.at === activity.at && a.kind === activity.kind && a.message === activity.message,
  );
  if (exists) return;
  activities.value = [activity, ...activities.value].slice(0, ACTIVITY_LIMIT);
}

/** 节流触发一次完整刷新（活动事件可能高频到达）。 */
function scheduleRefresh(): void {
  if (muted) return;
  const now = Date.now();
  const elapsed = now - lastActivityRefresh;
  if (elapsed >= ACTIVITY_THROTTLE_MS) {
    lastActivityRefresh = now;
    void refresh();
    return;
  }
  if (throttleTimer !== null) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    lastActivityRefresh = Date.now();
    void refresh();
  }, ACTIVITY_THROTTLE_MS - elapsed);
}

/** 加载概览 / 笔记 / 活动。并发调用合并为一次实际请求。 */
export function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  loading.value = true;
  inFlight = (async () => {
    try {
      // 概览是可选项：命令未注册时仍要能展示已有数据与错误原因。
      const overviewResult = await demoOverview();
      overview.value = overviewResult;
      markAvailable();
      loadError.value = null;
    } catch (e) {
      markFailure(e);
      loadError.value = e instanceof Error ? e.message : String(e);
    }

    try {
      notes.value = await demoNotesList();
      markAvailable();
    } catch (e) {
      markFailure(e);
      if (loadError.value === null) {
        loadError.value = e instanceof Error ? e.message : String(e);
      }
    }

    try {
      const recent = await demoActivityRecent();
      // 历史活动与实时活动合并去重，保持时间倒序。
      const merged = [...recent];
      for (const a of activities.value) {
        if (!merged.some((m) => m.at === a.at && m.kind === a.kind && m.message === a.message)) {
          merged.push(a);
        }
      }
      activities.value = merged.slice(0, ACTIVITY_LIMIT);
      markAvailable();
    } catch (e) {
      markFailure(e);
    }
  })().finally(() => {
    loading.value = false;
    inFlight = null;
  });
  return inFlight;
}

/** 强制刷新（忽略 in-flight 合并），用于用户主动重试。 */
export async function reload(): Promise<void> {
  inFlight = null;
  await refresh();
}

/** 新增或更新笔记，成功后刷新列表。 */
export async function upsertNote(title: string, body: string, id?: number): Promise<DemoNote> {
  const saved = await demoNoteUpsert(id === undefined ? { title, body } : { id, title, body });
  markAvailable();
  await refresh();
  return saved;
}

/** 删除笔记，成功后刷新列表。 */
export async function removeNote(id: number): Promise<void> {
  await demoNoteDelete(id);
  markAvailable();
  await refresh();
}

/** 探活，返回后端回显文本。 */
export async function ping(): Promise<string> {
  const echo = await demoPing();
  markAvailable();
  return echo;
}

/** 发起 `expose.version` 意图，返回版本串。 */
export async function requestExposeVersion(): Promise<string> {
  const version = await demoExposeVersion();
  markAvailable();
  return version;
}

/** 挂载事件监听（引用计数，多个页面共存时只订阅一次）。 */
export async function attachListeners(): Promise<void> {
  listenerCount += 1;
  if (listenerCount > 1 || listeners.length > 0) return;
  muted = false;
  listeners = [
    await onDemoActivity((activity) => {
      pushActivity(activity);
      scheduleRefresh();
    }),
    await onKernelDownloadStatus((task) => {
      // 跨模块事件示例：只保留最近一条状态用于展示，不参与列表刷新。
      lastDownloadStatus.value = `${task.filename ?? task.url}: ${task.status}`;
    }),
  ];
}

/** 摘除事件监听（引用计数归零时真正退订，避免泄漏）。 */
export function detachListeners(): void {
  listenerCount = Math.max(0, listenerCount - 1);
  if (listenerCount > 0) return;
  listeners.forEach((u) => u());
  listeners = [];
  if (throttleTimer !== null) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
}

/** 页面卸载期间暂停接收事件（详情页与列表页切换时避免抖动）。 */
export function setMuted(value: boolean): void {
  muted = value;
}

/** 对外暴露的只读状态。 */
export function useModuleState() {
  return {
    overview: readonly(overview),
    notes: readonly(notes),
    activities: readonly(activities),
    loading: readonly(loading),
    loadError: readonly(loadError),
    capability: readonly(capability),
    lastDownloadStatus: readonly(lastDownloadStatus),
    noteCount: computed(() => notes.value.length),
    refresh,
    reload,
    upsertNote,
    removeNote,
    ping,
    requestExposeVersion,
    attachListeners,
    detachListeners,
  };
}
