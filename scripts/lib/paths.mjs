// 路径解析与文件系统公共工具：模板内全部开发脚本共享。
//
// 动机：schema 校验、打包、提审、导入调试四条链路都要回答同一组问题——
// 「仓库根在哪」「module.json 说什么」「产物在哪」「输出写哪」。
// 若各脚本各写一份，字段语义很快会漂移，而这几条链路共用同一份契约（module.json），
// 漂移的后果是打包能过、提审却失败。故收敛到本文件。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录（本文件位于 <root>/scripts/lib/ 下，故上溯两级）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 清单文件名：模块的唯一声明数据源。 */
export const MANIFEST_FILE = "module.json";

/** 模块包扩展名：`.cglm` 就是 zip 容器，文件名即模块包的类型标识。 */
export const PACKAGE_EXT = ".cglm";

/** 平台枚举（权威，与 docs/cgl-models.md 2.3 / cgl-libs 2.3.6 逐字一致）。 */
export const PLATFORMS = [
  "windows-x86_64",
  "windows-aarch64",
  "android-arm64",
  "linux-x86_64",
];

/** 后端产物在各平台上的扩展名。 */
export const BACKEND_EXT_BY_PLATFORM = {
  "windows-x86_64": ".dll",
  "windows-aarch64": ".dll",
  "android-arm64": ".so",
  "linux-x86_64": ".so",
};

/** 权限枚举（权威，共 9 项）。 */
export const PERMISSIONS = [
  "filesystem:read",
  "filesystem:write",
  "filesystem:game-dir",
  "network",
  "process:spawn",
  "download:enqueue",
  "settings:write",
  "intents:request",
  "account:read",
];

/** 分类枚举。 */
export const CATEGORIES = ["utility", "automation", "content", "integration", "appearance"];

/**
 * 细粒度权限 -> 用户可见三布尔摘要的唯一映射规则。
 *
 * 该摘要是 cgl-libs CI 的派生结果，模块侧只声明细粒度枚举。此处实现同一份规则，
 * 供 `--dry-run` 预览与提审脚本本地核对，避免本地预览与线上派生态不一致。
 */
export function derivePermissionSummary(permissions) {
  const set = new Set(permissions);
  return {
    network: set.has("network"),
    spawn_process: set.has("process:spawn"),
    write_outside_module_dir: set.has("filesystem:game-dir") || set.has("settings:write"),
  };
}

/** 把模块 id 转换为安全的表名前缀（`.` 与 `-` 换 `_`；SQLite 标识符不允许点号）。 */
export function tablePrefixOfId(id) {
  return id.replace(/[.-]/g, "_");
}

/** 读取并解析仓库根的 module.json。 */
export function readManifest(root = REPO_ROOT) {
  const path = join(root, MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new Error(`找不到清单文件：${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`解析 ${MANIFEST_FILE} 失败：${e.message}`);
  }
}

/** 读取 module.schema.json。 */
export function readSchema(root = REPO_ROOT) {
  const path = join(root, "module.schema.json");
  if (!existsSync(path)) {
    throw new Error(`找不到 schema 文件：${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 发布包文件名：`<id>-<version>-<platform>.cglm`。 */
export function packageFileName(manifest, platform) {
  return `${manifest.id}-${manifest.version}-${platform}${PACKAGE_EXT}`;
}

/** 校验文件的固定名：`<资产名>.sha256`（对齐内核更新系统的既有习惯）。 */
export function checksumFileName(assetName) {
  return `${assetName}.sha256`;
}

/** 计算 Buffer / 字符串的 sha256 小写十六进制。 */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** 计算文件 sha256 小写十六进制。 */
export function sha256File(path) {
  return sha256Hex(readFileSync(path));
}

/** 校验文件的单行内容：`<小写十六进制><两空格><文件名>`。 */
export function checksumLine(hex, fileName) {
  return `${hex}  ${fileName}\n`;
}

/** 解析校验文件内容，返回 { hex, fileName }；格式非法返回 null。 */
export function parseChecksumLine(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return null;
  const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
  if (!m) return null;
  return { hex: m[1], fileName: m[2] };
}

/** 递归列出目录下全部文件（返回相对路径，使用 `/` 分隔，已排序）。 */
export function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join(posix.sep));
    }
  }
  return out;
}

/** 目录是否存在且非空。 */
export function isNonEmptyDir(path) {
  return existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length > 0;
}

/**
 * 把 `module.json` 的 `artifact_glob` 中的占位段替换为具体平台产物名。
 *
 * 模板的 glob 形如 `target/release/copper_module_demo.dll`；多平台矩阵下由调用方
 * 用 `--backend <实际路径>` 覆盖。这里只负责「glob 是否与 crate 名自洽」的自检。
 */
export function expectedArtifactName(manifest, platform) {
  const cratePath = manifest.backend.crate.replace(/-/g, "_");
  return `${cratePath}${BACKEND_EXT_BY_PLATFORM[platform] ?? ""}`;
}

/** 把绝对路径转成相对仓库根的展示路径（越界时原样返回）。 */
export function displayPath(path, root = REPO_ROOT) {
  const rel = relative(root, path);
  return rel.startsWith("..") || isAbsolute(rel) ? path : rel.split(sep).join(posix.sep);
}

/**
 * 解析 Node 24 的 `--env-file` 之外的自定义参数：`--key value` 与 `--flag`。
 *
 * 不用第三方参数解析库：模板应保持零运行时依赖，避免开发者 clone 后先被
 * 依赖安装问题挡住。
 */
export function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(key);
    } else {
      values.set(key, next);
      i += 1;
    }
  }
  return {
    has: (k) => flags.has(k),
    get: (k, fallback = undefined) => values.get(k) ?? fallback,
  };
}

/** 统一的脚本崩溃出口：输出可读原因并以非零码退出（CI 据此 fail）。 */
export function fail(message) {
  process.stderr.write(`[cgl-models] 失败：${message}\n`);
  process.exit(1);
}

/** 统一的成功日志出口。 */
export function info(message) {
  process.stdout.write(`[cgl-models] ${message}\n`);
}
