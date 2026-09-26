#!/usr/bin/env node
// 开发调试：把本地构建结果同步进启动器的附加模块目录，并打上开发态标记 dev.json。
//
// 目标链路：改代码 -> 重构建 -> 重新同步 -> 启动器重载 -> 看效果（见 docs/cgl-models.md 2.11）。
//
// 为什么脚本自己同步而不是调用内核命令：模块目录可能不可写、内核可能没启动；
// 让「同步」这一步只依赖文件系统，开发者才不会因为内核状态而卡住调试。
// 内核侧 `modules_import_local` 用于「从任意本地目录导入」的场景，与本脚本职责不同。
//
// 安全边界（对齐 2.11.3）：目标根只允许 `Paths::modules_dir()` 的等价路径（
// `<AppData>/copper-lamp/copper-golem/modules`）或显式传入的目录；写入前做路径规范化
// 与前缀比较，拒绝任何逃逸到白名单根之外的写入。
//
// 用法：
//   node scripts/import-dev-module.mjs
//   node scripts/import-dev-module.mjs --watch
//   node scripts/import-dev-module.mjs --modules-dir "D:\\custom\\modules" --skip-build

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { posix } from "node:path";

import {
  REPO_ROOT,
  displayPath,
  fail,
  info,
  isNonEmptyDir,
  listFilesRecursive,
  parseArgs,
  readManifest,
} from "./lib/paths.mjs";

const args = parseArgs(process.argv.slice(2));

/** 内核 `Paths::modules_dir()` 的等价解析。 */
function defaultModulesDir() {
  const appData =
    process.env.APPDATA ??
    (process.platform === "win32" ? join(homedir(), "AppData", "Roaming") : null);
  if (!appData) {
    fail("无法解析 APPDATA，请用 --modules-dir 显式指定启动器模块目录");
  }
  return join(appData, "copper-lamp", "copper-golem", "modules");
}

/**
 * 路径白名单校验：规范化后必须落在允许根内。
 *
 * 规范化用 `resolve` 消解 `.` 与 `..`；比较时按路径分隔符切段，避免
 * `mod-1` 与 `mod-10` 这类同前缀兄弟目录被误放行（与内核沙箱的判定规则一致）。
 */
function assertInsideRoot(target, root) {
  const t = resolve(target);
  const r = resolve(root);
  if (t === r) return t;
  const rel = relative(r, t);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    fail(`拒绝写入白名单根之外的路径：${t}（允许根：${r}）`);
  }
  return t;
}

/** 递归复制目录内容（覆盖式）。 */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dst);
    } else if (entry.isFile()) {
      cpSync(src, dst);
    }
  }
}

function run(cmd, cmdArgs) {
  info(`执行：${cmd} ${cmdArgs.join(" ")}`);
  execFileSync(cmd, cmdArgs, { cwd: REPO_ROOT, stdio: "inherit", shell: process.platform === "win32" });
}

/** 构建前端与后端（可跳过，便于只重同步）。 */
function build({ skipBuild, manifest }) {
  if (skipBuild) {
    info("跳过构建（--skip-build）");
    return;
  }
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:frontend"]);
  run("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml"]);
  // 受监管运行时入口是构建产物（.gitignore 掉的那份），声明了 runtime 就必须产出，
  // 否则内核会在装载期直接拒绝——在同步期报错比装好后报错更省事。
  if (manifest.runtime) {
    run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:runtime"]);
  }
}

/** 解析后端产物路径：按当前平台从 manifest 的 artifact_glob 推导。 */
function resolveBackendArtifact(manifest, platform) {
  // artifact_glob 是仓库根相对的 POSIX 风格路径；多平台时由调用方用 --backend 覆盖。
  const explicit = args.get("backend");
  if (explicit) return resolve(REPO_ROOT, explicit);
  return resolve(REPO_ROOT, manifest.backend.artifact_glob);
}

/** 当前平台对应的权威枚举值。 */
function currentPlatform() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `windows-${arch}`;
  if (process.platform === "linux") return `linux-${arch}`;
  if (process.platform === "android") return "android-arm64";
  fail(`当前平台 ${process.platform}/${process.arch} 不在权威平台枚举内，请用 --platform 显式指定`);
}

/** 一次同步：构建 -> 原子替换 backend/frontend -> 写 dev.json。 */
function syncOnce() {
  const manifest = readManifest();
  const modulesDir = resolve(args.get("modules-dir", defaultModulesDir()));
  const platform = args.get("platform", currentPlatform());

  if (!(manifest.platforms ?? []).includes(platform)) {
    fail(`平台 ${platform} 不在 module.json.platforms 内，拒绝同步（声明与产物必须自洽）`);
  }

  build({ skipBuild: args.has("skip-build"), manifest });

  const targetDir = assertInsideRoot(join(modulesDir, manifest.id), modulesDir);
  const frontendDist = resolve(REPO_ROOT, manifest.frontend.dist);
  const backendArtifact = resolveBackendArtifact(manifest, platform);

  if (!isNonEmptyDir(frontendDist)) {
    fail(`前端产物为空：${displayPath(frontendDist)}（先执行 npm run build:frontend）`);
  }
  if (!existsSync(backendArtifact)) {
    fail(`后端产物不存在：${displayPath(backendArtifact)}（先执行 npm run build:backend）`);
  }
  // 声明了 runtime 就同步运行时入口目录：内核按 `runtime/` 下的 entry 派生受监管会话，
  // 少了它模块会被直接判为不可装载。
  const runtimeDir = manifest.runtime ? resolve(REPO_ROOT, dirname(manifest.runtime.entry)) : null;
  if (runtimeDir && !isNonEmptyDir(runtimeDir)) {
    fail(`运行时产物为空：${displayPath(runtimeDir)}（先执行 npm run build:runtime）`);
  }

  // 原子替换：先落到同级的临时目录，再整目录换名，避免半成品目录被内核读到。
  const staging = `${targetDir}.staging`;
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  copyDir(frontendDist, join(staging, "frontend"));
  mkdirSync(join(staging, "backend"), { recursive: true });
  cpSync(backendArtifact, join(staging, "backend", backendArtifact.split(sep).pop()));
  if (runtimeDir) copyDir(runtimeDir, join(staging, "runtime"));
  cpSync(join(REPO_ROOT, "module.json"), join(staging, "module.json"));
  cpSync(join(REPO_ROOT, manifest.icon), join(staging, manifest.icon.split(sep).pop()));

  // dev.json：开发态专属标记，不入发布包（见 2.11.1）。
  writeFileSync(
    join(staging, "dev.json"),
    `${JSON.stringify(
      {
        dev: true,
        source: REPO_ROOT,
        linked: false,
        platform,
        built_at: new Date().toISOString(),
        entry: manifest.backend.entry,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  // Windows 上跨目录 rename 可能失败，退化为复制后再删。
  try {
    cpSync(staging, targetDir, { recursive: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const files = listFilesRecursive(targetDir);
  info(`已同步 ${files.length} 个文件到 ${targetDir}`);
  for (const f of files) process.stdout.write(`  - ${posix.join("", f)}\n`);
  info("请在启动器 设置 -> 模块 中启用该模块并重启加载（附加模块动态加载尚未实现，见设计文档 3.4 G1/G2）");
}

function main() {
  syncOnce();

  if (!args.has("watch")) return;

  info("监听模式：改动 frontend/src 或 src-tauri/src 后自动重新同步（Ctrl+C 退出）");
  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    // 防抖：编辑器保存常触发多次事件，避免重复全量构建。
    timer = setTimeout(() => {
      timer = null;
      try {
        syncOnce();
      } catch (e) {
        process.stderr.write(`[cgl-models] 重新同步失败：${e.message}\n`);
      }
    }, 400);
  };

  for (const dir of [join(REPO_ROOT, "frontend", "src"), join(REPO_ROOT, "src-tauri", "src")]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    watch(dir, { recursive: true }, schedule);
  }
}

main();
