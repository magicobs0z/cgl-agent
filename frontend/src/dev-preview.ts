// dev 独立预览入口：把模块页面挂到一个最小 Vue 宿主上。
//
// 为什么需要它：`register.ts` 只做「向内核注册表登记」，登记完并不渲染任何东西——
// 真正把 nav / routes 变成界面的是内核 Shell（SideNav + Router）。
// 只加载 `register.ts` 的预览页会是一片空白，故本文件补上那层最小 Shell。
//
// 使用范围：仅 `npm run dev`。它不进 `vite build` 的模块产物
// （构建入口是 `register.ts`，见 vite.config.ts 的 lib.entry），因此不会把
// vue-router 实例带进发布包，也不会与内核 Shell 的路由分叉。
//
// 已知差异：预览宿主没有内核 Shell 的组件与标题栏锚点，也没有模块 IPC，
// 页面里所有依赖内核的入口在预览下都不可用，属预期行为。

import { createApp, defineComponent, h } from "vue";
import { createRouter, createWebHashHistory, RouterView } from "vue-router";

import { getModuleRoutes } from "../../../CopperCore/frontend/src/modules/registry";
import { initI18n, useI18n } from "../../../CopperCore/frontend/src/i18n";

// 必须先于 ./register：本模块以副作用形式装好宿主桥与 i18n 桩。
import "./dev-preview-kernel";
// 再执行模块注册（副作用：把路由写进内核注册表），随后据注册结果建 Router。
import "./register";
// 模块私有样式在内核里由宿主按清单注入；预览下需自行引入。
import "./styles/module.css";
// 预览宿主自身的布局样式（不进发布包，因为构建入口是 register.ts）。
import "./styles/dev-preview.css";

// 内核里由 Shell 在启动时初始化 i18n；预览下少了这一步，页面会显示原始键名。
// 目录是响应式的，加载完成后界面自动刷新，无需等待。
void initI18n();

/** 预览宿主：渲染一个最小标题条 + 路由出口。 */
const DevPreviewShell = defineComponent({
  name: "DevPreviewShell",
  setup() {
    const { t } = useI18n();
    return () =>
      h("div", { class: "dev-preview" }, [
        h("header", { class: "dev-preview__bar" }, [
          h("span", { class: "dev-preview__brand" }, t("module.demo-tools.navTitle")),
          h("span", { class: "dev-preview__hint" }, t("module.demo-tools.pageSubtitle")),
        ]),
        h("main", { class: "dev-preview__body" }, [h(RouterView)]),
      ]);
  },
});

const router = createRouter({
  // hash 历史：vite 预览下无需服务端回退配置即可直达子路由。
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/agent" },
    // 路由直接取自内核注册表 —— 预览验证的就是真实注册结果，而非另抄一份路由表。
    ...getModuleRoutes(),
  ],
});

createApp(DevPreviewShell).use(router).mount("#app");
