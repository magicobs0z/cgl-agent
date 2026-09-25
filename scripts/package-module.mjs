#!/usr/bin/env node
// 模块打包器：收集前端 dist + 后端产物 + 图标 + 许可 -> `<id>-<version>-<platform>.cglm` -> sha256。
//
// 为什么自研而不是用 zip 命令行工具：发布包内部结构是**冻结契约**
// （见 docs/cgl-models.md 2.9），且必须逐文件生成 `manifest.sha256` 供内核安装时逐项比对。
// 依赖外部 zip 工具会让结构随平台漂移，无法在 CI 与本地复现同一份产物。
//
// 容器格式：`.cglm` 就是 zip（文件名承担类型标识作用），内部为下列布局：
//   module.json            清单（与仓库根同名文件一致）
//   manifest.sha256        包内逐文件校验清单
//   icon.svg               图标（从 manifest.icon 复制到包根，便于列表预览快速读取）
//   backend/<产物>         后端产物（阶段一为源码构建产物）
//   frontend/**            前端构建产物
//   LICENSE                许可文件（合规要求，随包分发）
//
// 用法：
//   node scripts/package-module.mjs --platform windows-x86_64 --backend target/release/copper_module_demo.dll
//   node scripts/package-module.mjs --platform windows-x86_64 --backend <path> --out dist-package
//   node scripts/package-module.mjs --platform windows-x86_64 --backend <path> --frontend <dist 目录>
//   node scripts/package-module.mjs --plan-only          # 只打印计划，不产物（CI 干跑）
//
// `--backend` / `--frontend` 是显式覆盖用的可测性入口（默认取 module.json 的
// artifact_glob 与 frontend.dist），不会改变发布包的结构契约。

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, posix, resolve, sep } from "node:path";

import {
  BACKEND_EXT_BY_PLATFORM,
  MANIFEST_FILE,
  PACKAGE_EXT,
  PLATFORMS,
  REPO_ROOT,
  checksumFileName,
  checksumLine,
  displayPath,
  expectedArtifactName,
  fail,
  info,
  isNonEmptyDir,
  listFilesRecursive,
  packageFileName,
  parseArgs,
  readManifest,
  sha256File,
  sha256Hex,
} from "./lib/paths.mjs";

const args = parseArgs(process.argv.slice(2));
const planOnly = args.has("plan-only");

// ---------------------------------------------------------------- zip 写入

/**
 * 极简 zip writer（store 模式，不压缩）。
 *
 * 选择 store 而非 deflate 的理由：模块包的下载体积远小于游戏安装包，
 * 而 store 让打包逻辑不依赖 zlib 流式 API，产物体积与内容完全可预测、可逐字节复现
 * （CI 与本地构建得到同一份 sha256）。压缩交给 Release 传输层即可。
 */
class ZipWriter {
  constructor() {
    this.chunks = [];
    this.central = [];
    this.offset = 0;
  }

  /** 追加一个文件条目。 */
  addFile(name, data) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6); // 通用位标记：文件名为 UTF-8
    local.writeUInt16LE(0, 8); // 压缩方法：0 = store
    local.writeUInt16LE(0, 10); // 修改时间（固定值，保证可复现）
    local.writeUInt16LE(0x21, 12); // 修改日期（固定值 1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度

    this.chunks.push(local, nameBytes, data);
    this.central.push({ nameBytes, crc, size, offset: this.offset });
    this.offset += local.length + nameBytes.length + size;
  }

  /** 收尾：写入中央目录并返回完整 zip 字节。 */
  finish() {
    const centralStart = this.offset;
    let centralSize = 0;
    for (const e of this.central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
      head.writeUInt16LE(20, 4); // 创建版本
      head.writeUInt16LE(20, 6); // 解压所需版本
      head.writeUInt16LE(0x0800, 8); // UTF-8 文件名
      head.writeUInt16LE(0, 10); // store
      head.writeUInt16LE(0, 12);
      head.writeUInt16LE(0x21, 14);
      head.writeUInt32LE(e.crc, 16);
      head.writeUInt32LE(e.size, 20);
      head.writeUInt32LE(e.size, 24);
      head.writeUInt16LE(e.nameBytes.length, 28);
      head.writeUInt16LE(0, 30); // 扩展字段
      head.writeUInt16LE(0, 32); // 注释
      head.writeUInt16LE(0, 34); // 起始磁盘
      head.writeUInt16LE(0, 36); // 内部属性
      // 外部属性：普通文件 0644。`<<` 在 JS 里是有符号 32 位运算，结果可能为负，
      // 必须 `>>> 0` 转回无符号，否则 writeUInt32LE 会抛 ERR_OUT_OF_RANGE。
      head.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      head.writeUInt32LE(e.offset, 42);
      this.chunks.push(head, e.nameBytes);
      centralSize += head.length + e.nameBytes.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20); // 注释长度
    this.chunks.push(end);

    return Buffer.concat(this.chunks);
  }
}

/** CRC-32（zip 必需；不引入依赖，保持模板零运行时依赖）。
 *
 * 全程按**无符号 32 位**运算：JS 的 `^` 与 `<<` 是有符号 32 位，
 * 中间结果会变成负数并被后续位移符号扩展，最终 CRC 与规范值不符
 * （表现为产物能生成但解压时报校验错）。故每次运算后统一 `>>> 0`，
 * 表也用 Uint32Array 而非 Int32Array。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1) >>> 0;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- 打包

/** 递归收集待入包文件：返回 [{ zipPath, absPath }]。 */
function collectEntries({ manifest, backendPath, platform, frontendDist }) {
  const entries = [];

  // 1. 清单本体：与仓库根同名文件一致，随包分发。
  entries.push({ zipPath: MANIFEST_FILE, absPath: join(REPO_ROOT, MANIFEST_FILE), required: true });

  // 2. 图标：从 manifest.icon 复制到包根，供列表页快速读取。
  const iconAbs = join(REPO_ROOT, manifest.icon);
  entries.push({
    zipPath: basename(manifest.icon),
    absPath: iconAbs,
    required: true,
  });

  // 3. 许可文件：合规要求（module.json.license 必须随包可见）。
  entries.push({ zipPath: "LICENSE", absPath: join(REPO_ROOT, "LICENSE"), required: true });

  // 4. 后端产物。
  entries.push({
    zipPath: posix.join("backend", basename(backendPath)),
    absPath: backendPath,
    required: true,
    platform,
  });

  // 5. 前端产物：整目录搬进 frontend/，register 入口名须与 manifest 一致。
  if (!isNonEmptyDir(frontendDist)) {
    fail(
      `前端产物目录为空或不存在：${displayPath(frontendDist)}（请先执行 npm run build:frontend）`,
    );
  }
  for (const rel of listFilesRecursive(frontendDist)) {
    entries.push({
      zipPath: posix.join("frontend", rel),
      absPath: join(frontendDist, rel.replace(/\//g, sep)),
      required: true,
    });
  }

  return entries;
}

/** 校验待打包条目齐全且命名自洽。返回可读问题列表。 */
function verifyEntries(entries, manifest, platform) {
  const problems = [];
  for (const e of entries) {
    if (e.required && !existsSync(e.absPath)) {
      problems.push(`缺少必需文件：${displayPath(e.absPath)}（包内位置 ${e.zipPath}）`);
    }
  }

  // 后端产物扩展名必须与该平台约定一致，否则内核装载时会找不到入口。
  const expectedExt = BACKEND_EXT_BY_PLATFORM[platform];
  const backendEntry = entries.find((e) => e.zipPath.startsWith("backend/"));
  if (backendEntry && expectedExt && !backendEntry.zipPath.endsWith(expectedExt)) {
    problems.push(
      `后端产物扩展名与平台 ${platform} 不符：期望 ${expectedExt}，实际 ${backendEntry.zipPath}`,
    );
  }

  // 前端注册入口必须存在（内核按 manifest.frontend.register 定位它）。
  const registerName = manifest.frontend.register;
  if (!entries.some((e) => e.zipPath === posix.join("frontend", registerName))) {
    problems.push(
      `前端产物缺少注册入口 frontend/${registerName}（module.json.frontend.register）`,
    );
  }

  return problems;
}

/** 生成包内 `manifest.sha256`：逐文件 sha256，格式 `<hex>  <包内相对路径>`。 */
function buildInnerManifest(contents) {
  const lines = [];
  for (const [zipPath, data] of [...contents.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // manifest.sha256 不包含自身（自引用无法收敛）。
    if (zipPath === "manifest.sha256") continue;
    lines.push(`${sha256Hex(data)}  ${zipPath}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  let manifest;
  try {
    manifest = readManifest();
  } catch (e) {
    fail(e.message);
  }

  const platform = args.get("platform");
  if (!platform) {
    fail(`必须指定 --platform，可选值：${PLATFORMS.join(" / ")}`);
  }
  if (!PLATFORMS.includes(platform)) {
    fail(`未知平台 "${platform}"，权威枚举为：${PLATFORMS.join(" / ")}`);
  }
  if (!(manifest.platforms ?? []).includes(platform)) {
    fail(
      `平台 "${platform}" 不在 module.json 的 platforms 里（${(manifest.platforms ?? []).join(", ")}）。` +
        `platforms 是承诺而非描述：声明了就要有产物，产物也不应超出声明。`,
    );
  }

  const backendArg = args.get("backend");
  if (!backendArg) {
    fail(
      `必须指定 --backend <产物路径>（可用 module.json.backend.artifact_glob 推导，期望文件名 ${expectedArtifactName(manifest, platform)}）`,
    );
  }
  const backendPath = resolve(REPO_ROOT, backendArg);
  // `--frontend` 覆盖前端产物目录，默认取 module.json 的 frontend.dist。
  // 存在的意义是可测性：结构门禁用例需要在不依赖真实构建产物的情况下无条件执行。
  // 与 `--backend` 同为显式覆盖，**不改变**默认链路与发布包结构契约。
  const frontendArg = args.get("frontend");
  const frontendDist = frontendArg
    ? resolve(REPO_ROOT, frontendArg)
    : resolve(REPO_ROOT, manifest.frontend.dist);
  const outDir = resolve(REPO_ROOT, args.get("out", "dist-package"));

  const assetName = packageFileName(manifest, platform);
  const entries = collectEntries({ manifest, backendPath, platform, frontendDist });
  const problems = verifyEntries(entries, manifest, platform);

  info(`模块：${manifest.id}@${manifest.version}  平台：${platform}`);
  info(`产物：${assetName}`);
  info(`输出目录：${displayPath(outDir)}`);
  info(`待入包文件 ${entries.length} 项：`);
  for (const e of entries) {
    process.stdout.write(`  - ${e.zipPath}\n`);
  }

  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`  [打包阻断] ${p}\n`);
    fail(`共 ${problems.length} 项阻断，未生成半成品产物`);
  }

  if (planOnly) {
    info("干跑模式：未写出任何文件（--plan-only）");
    return;
  }

  // 读取全部内容到内存：模块包体积可控，且这样能一次性算出逐文件校验值。
  const contents = new Map();
  for (const e of entries) {
    contents.set(e.zipPath, await readFile(e.absPath));
  }
  // 包内校验清单最后写入，避免自引用。
  contents.set("manifest.sha256", Buffer.from(buildInnerManifest(contents), "utf8"));

  const zip = new ZipWriter();
  for (const [zipPath, data] of [...contents.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    zip.addFile(zipPath, data);
  }
  const bytes = zip.finish();

  mkdirSync(outDir, { recursive: true });
  const assetPath = join(outDir, assetName);
  await writeFile(assetPath, bytes);

  // 同名 `.sha256`：单行小写十六进制 + 两空格 + 文件名（对齐内核更新系统既有习惯）。
  const digest = sha256File(assetPath);
  const checksumPath = join(outDir, checksumFileName(assetName));
  await writeFile(checksumPath, checksumLine(digest, assetName), "utf8");

  info(`已生成 ${displayPath(assetPath)}（${bytes.length} 字节，包内 ${contents.size} 个条目）`);
  info(`已生成 ${displayPath(checksumPath)}：${digest}`);
  info(`包内校验清单 manifest.sha256 已写入（逐文件 sha256，供内核安装时逐项比对）`);
}

await main();
