// 附加模块前端入口：经宿主桥登记左导航入口与内容区路由。
//
// 运行期由内核 `loadAddonFrontends` 注入 `window.__COPPER_HOST__` 后动态导入本文件；
// 模块 id 由宿主绑定，模块无权声明。切勿改回静态导入内核注册表 —— 那会绕过宿主沙箱，
// 也会让模块在非内核环境下拿到内核内部对象。
//
// 样式：内核下由宿主按清单 `style_urls` 注入 <link>；dev 独立预览自行引入。

import { Sparkles } from "@lucide/vue";

import { captureHostBridge } from "./host";
import "./styles/module.css";

// 必须在入口求值阶段抓住桥：内核在动态导入本模块后会立即清空全局桥，
// 界面渲染后再调用命令就取不到了。
const host = captureHostBridge();

host?.registerModule({
  nav: {
    path: "/agent",
    titleKey: "module.demo-tools.navTitle",
    icon: Sparkles,
  },
  routes: [
    {
      path: "/agent",
      name: "agent",
      component: () => import("./ModulePage.vue"),
      meta: { titleKey: "module.demo-tools.title" },
    },
  ],
});
