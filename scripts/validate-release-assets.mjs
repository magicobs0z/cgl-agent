#!/usr/bin/env node
// Release 资产门禁：提审前确认「声明了平台的都已经发布，且每个 .cglm 都有配对校验文件」。
//
// 为什么先于提审跑：`platforms` 字段是**承诺而非描述**（见 docs/cgl-models.md 3.2）——
// 声明了但产物缺失的平台，必须在提审失败而不是生成一条带死链的收录条目。
// 提审 bot 不得自行构建产物，故这里是唯一能把关的位置。
//
// 用法：
//   node scripts/validate-release-assets.mjs --tag v0.1.0 --dir dist-package
//   node scripts/validate-release-assets.mjs --assets "<a.cglm>,<a.cglm.sha256>"   # 已下载的资产清单
//   node scripts/validate-release-assets.mjs --tag v0.1.0 --gh-json release-assets.json

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";



import {
  PACKAGE_EXT,
  REPO_ROOT,
  checksumFileName,
  displayPath,
  fail,
  info,
  packageFileName,
  parseArgs,
  parseChecksumLine,
  readManifest,
  sha256File,
} from "./lib/paths.mjs";

const args = parseArgs(process.argv.slice(2));
const problems = [];

function report(message) {
  problems.push(message);
}

/** 从目录或逗号分隔清单收集资产文件名。 */
function collectAssetNames() {
  const listed = args.get("assets");
  if (listed) {
    return listed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const dir = args.get("dir");
  if (dir) {
    const abs = resolve(REPO_ROOT, dir);
    if (!existsSync(abs)) {
      fail(`资产目录不存在：${displayPath(abs)}（请先执行 npm run package）`);
    }
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  }
  const ghJson = args.get("gh-json");
  if (ghJson) {
    const abs = resolve(REPO_ROOT, ghJson);
    if (!existsSync(abs)) fail(`找不到 Release 资产清单：${displayPath(abs)}`);
    const parsed = JSON.parse(readFileSync(abs, "utf8"));
    const list = Array.isArray(parsed) ? parsed : (parsed.assets ?? []);
    return list.map((a) => a.name ?? a.fileName).filter(Boolean);
  }
  fail("必须提供 --dir <目录>、--assets <逗号分隔清单> 或 --gh-json <文件> 之一");
}

function main() {
  const manifest = (() => {
    try {
      return readManifest();
    } catch (e) {
      fail(e.message);
    }
  })();

  // 版本与 tag 一致性：三者（module.json / tag / CHANGELOG）严格一致是发布门槛。
  const tag = args.get("tag");
  if (tag !== undefined) {
    const expected = tag.replace(/^v/, "");
    if (expected !== manifest.version) {
      report(`tag("${tag}")与 module.json.version("${manifest.version}")不一致`);
    }
  }

  const names = collectAssetNames();
  const assetDir = args.get("dir") ? resolve(REPO_ROOT, args.get("dir")) : null;

  info(`Release 资产共 ${names.length} 项`);
  if (names.length === 0) {
    report("Release 中没有任何资产");
  }

  for (const platform of manifest.platforms ?? []) {
    const assetName = packageFileName(manifest, platform);
    const checksumName = checksumFileName(assetName);

    if (!names.includes(assetName)) {
      report(`平台 ${platform} 的产物缺失：${assetName}（platforms 是承诺，产物缺失即提审失败）`);
      continue;
    }
    if (!names.includes(checksumName)) {
      report(`平台 ${platform} 缺少配对校验文件：${checksumName}`);
      continue;
    }

    // 有本地目录时顺带核对校验值本身（线上由 bot 用 Release 的 sha256 直接生成条目）。
    if (assetDir) {
      const assetPath = join(assetDir, assetName);
      const checksumPath = join(assetDir, checksumName);
      if (existsSync(assetPath) && existsSync(checksumPath)) {
        const parsed = parseChecksumLine(readFileSync(checksumPath, "utf8"));
        if (!parsed) {
          report(`校验文件格式非法（应为「64 位小写十六进制 + 两空格 + 文件名」）：${checksumName}`);
        } else {
          if (parsed.fileName !== assetName) {
            report(`校验文件里的文件名("${parsed.fileName}")与资产名("${assetName}")不一致`);
          }
          const actual = sha256File(assetPath);
          if (actual !== parsed.hex) {
            report(`校验值不匹配：${assetName} 实际 ${actual}，校验文件声明 ${parsed.hex}`);
          }
        }
      }
    }
  }

  // 反向检查：不应存在未在 platforms 里声明却发布了产物的平台。
  for (const name of names.filter((n) => n.endsWith(PACKAGE_EXT))) {
    const matched = (manifest.platforms ?? []).some(
      (p) => name === packageFileName(manifest, p),
    );
    if (!matched) {
      report(`资产 "${name}" 无法对应 module.json.platforms 中的任何平台（命名或平台矩阵不一致）`);
    }
  }

  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`  [资产门禁] ${p}\n`);
    fail(`共 ${problems.length} 项问题，未通过提审前置校验`);
  }
  info("Release 资产齐全且校验值一致");
}

main();
