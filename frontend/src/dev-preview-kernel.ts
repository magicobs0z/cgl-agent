// dev 预览的内核桩：仅 `npm run dev` 使用，不进发布产物（构建入口是 register.ts）。
//
// 预览宿主没有内核，这里补两样最小替身，让页面走与内核一致的真实调用路径，
// 而不是让页面为预览单独开分支：
// - `window.__COPPER_HOST__`：宿主桥，`register.ts` 经它登记导航与路由；
// - `window.__TAURI_INTERNALS__.invoke`：只应答 i18n 两个只读命令，其余一律拒绝。
//   内核里模块语言包由后端按模块清单下发，预览下没有后端，故由本文件直接提供，
//   否则页面只能显示原始键名。
//
// 本文件必须在 `register.ts` 之前求值：ES 模块的副作用导入按源码顺序执行，
// 若把装桥写成普通语句会被 import 提升挤到后面，导致路由登记时桥还不存在。

import { registerModule } from "../../../CopperCore/frontend/src/modules/registry";
import { installHostBridge } from "./host";
import zhCN from "./locales/zh-CN.json";

/** 与 module.json 保持一致；改名时两处需同步。 */
const MODULE_ID = "copper-lamp.demo-tools";
const I18N_NAMESPACE = "demo-tools";
const PREVIEW_LOCALE = "zh-CN";

interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

installHostBridge({
  registerModule(registration) {
    registerModule({
      id: MODULE_ID,
      nav: {
        id: MODULE_ID,
        path: registration.nav.path,
        titleKey: registration.nav.titleKey,
        icon: registration.nav.icon,
      },
      routes: registration.routes,
    });
  },
  invoke() {
    return Promise.reject(new Error("dev preview has no module IPC"));
  },
});

(window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ = {
  invoke(command) {
    if (command === "i18n_current_locale") return Promise.resolve(PREVIEW_LOCALE);
    if (command === "i18n_catalog") {
      return Promise.resolve({ module: { [I18N_NAMESPACE]: zhCN } });
    }
    return Promise.reject(new Error(`dev preview does not implement command ${command}`));
  },
};
