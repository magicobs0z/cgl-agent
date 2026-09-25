// 模块前端构建配置。
//
// 产物落点必须与 `module.json` 的 `frontend.dist` 逐字一致（当前为 `frontend/dist`）：
// 打包脚本 `scripts/package-module.mjs` 按该字段定位前端产物并整目录搬进发布包
// 的 `frontend/` 内。落点写在这里**且只写在这里**——若在 npm script 里再传
// `--outDir`，命令行会覆盖本配置，而 `--outDir` 是相对 Vite `root` 解析的，
// 两处一旦不同就会产出「构建成功但打包找不到产物」的错位。
//
// 阶段一说明：内核当前只能静态编译内置模块，本 dist 用于「源码依赖形态」的分发与
// 独立预览，不进入面向终端用户的一键安装链路（见 docs/cgl-models.md 2.9）。

import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./frontend", import.meta.url));

export default defineConfig(() => ({
  root,
  plugins: [vue()],

  // 不要让 Vite 覆盖 Rust 的报错输出。
  clearScreen: false,

  build: {
    // 与 module.json 的 frontend.dist 逐字一致（frontend/dist）。
    outDir: fileURLToPath(new URL("./frontend/dist", import.meta.url)),
    emptyOutDir: true,
    // 模块前端由内核 Shell 提供宿主页，产物按 library 方式产出，
    // register 入口名与 module.json 的 frontend.register 对齐（register.js）。
    lib: {
      entry: fileURLToPath(new URL("./frontend/src/register.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "register.js",
    },
    rollupOptions: {
      // vue / vue-router / @tauri-apps/api 由宿主 Shell 提供，不重复打包进模块产物，
      // 否则同一份运行时被加载两次会导致响应式与路由实例分叉。
      external: ["vue", "vue-router", "@tauri-apps/api", "@tauri-apps/api/core", "@tauri-apps/api/event"],
      output: {
        assetFileNames: "assets/[name][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },

  server: {
    port: 1520,
    strictPort: true,
    watch: {
      // 后端改动不由 Vite 处理。
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
}));
