// 模块前端注册入口：向内核模块注册表登记左导航入口与内容区路由。
//
// 本文件是 `module.json` 的 `frontend.register`（register.js）所指的构建入口，
// 由内核 Shell 与 dev 预览宿主页（frontend/index.html）共同引用。
//
// 硬契约（冻结，不得改动，见 docs/cgl-models.md 2.2 / 2.8 / 2.8.1）：
// - 模块 id 为两段式 `copper-lamp.demo-tools`，仅用于唯一标识 / 目录名 / DB scope，
//   **绝不进入 i18n 键**；
// - i18n 命名空间为单段 `demo-tools`，`t()` 键一律 `module.demo-tools.<扁平键>`。
//
// 阶段一说明：内核当前只能静态编译内置模块，本包以「源码依赖」形态分发，
// 经相对路径直接引用内核注册表（模板仓库与 CopperCore 同级于 CopperGolem 下）。

import { Puzzle } from "@lucide/vue";

import { registerModule } from "../../../CopperCore/frontend/src/modules/registry";

import "./styles/module.css";

registerModule({
  // 完整 id：唯一标识（不是 i18n 命名空间）。
  id: "copper-lamp.demo-tools",
  nav: {
    id: "copper-lamp.demo-tools",
    path: "/demo-tools",
    // 键前缀用 i18n_namespace（demo-tools），不是完整 id。
    titleKey: "module.demo-tools.navTitle",
    icon: Puzzle,
  },
  routes: [
    {
      path: "/demo-tools",
      name: "demo-tools",
      component: () => import("./ModulePage.vue"),
      meta: { titleKey: "module.demo-tools.title" },
    },
    {
      path: "/demo-tools/detail/:id",
      name: "demo-tools-detail",
      component: () => import("./ModuleDetail.vue"),
      meta: { titleKey: "module.demo-tools.detail", backPath: "/demo-tools" },
    },
  ],
});
