// 宿主桥声明与访问器。
//
// 运行期由内核 `addonRuntime.ts` 注入 `window.__COPPER_HOST__`，模块经它登记导航与路由。
// 这里本地声明桥的形状而不 import 内核类型：模块产物不应在类型层绑定内核源码路径，
// 宿主才是运行期唯一注入方。形状须与内核 `CopperHostBridge` 保持一致。
//
// 安全约定：`invoke` 只调用**本模块自身**的命令，模块 id 由宿主绑定。

import type { Component } from "vue";
import type { RouteRecordRaw } from "vue-router";

/** 模块提交给宿主的登记内容（模块 id 由宿主绑定，模块无权声明）。 */
export interface AddonModuleRegistration {
  nav: {
    path: string;
    titleKey: string;
    icon: Component;
  };
  routes: RouteRecordRaw[];
}

/** 宿主桥。 */
export interface CopperHostBridge {
  registerModule(registration: AddonModuleRegistration): void;
  invoke(command: string, args?: unknown): Promise<unknown>;
}

interface HostWindow {
  __COPPER_HOST__?: CopperHostBridge;
}

/** 取当前注入的宿主桥；不在内核宿主内时为 undefined（例如纯浏览器调试）。 */
export function getHostBridge(): CopperHostBridge | undefined {
  return (window as unknown as HostWindow).__COPPER_HOST__;
}

/** 安装宿主桥。仅 dev 预览宿主使用；正式运行期由内核注入。 */
export function installHostBridge(bridge: CopperHostBridge): void {
  (window as unknown as HostWindow).__COPPER_HOST__ = bridge;
}

// 内核在动态导入模块入口后会**立即清空**全局桥，避免后续模块冒充前一模块身份
// （见 addonRuntime.ts 的 finally）。因此模块必须在入口求值时把桥抓在手里，
// 否则界面渲染后再调用命令必然拿不到桥。
let captured: CopperHostBridge | undefined;

/** 在模块入口求值阶段抓取宿主桥。 */
export function captureHostBridge(): CopperHostBridge | undefined {
  captured = getHostBridge();
  return captured;
}

/** 取已抓取的宿主桥；不在内核宿主内时为 undefined。 */
export function hostBridge(): CopperHostBridge | undefined {
  return captured;
}
