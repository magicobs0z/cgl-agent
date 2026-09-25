#!/usr/bin/env node
// 提审条目生成器：把 module.json + Release 资产折叠成 cgl-libs 的收录条目与 PR 正文。
//
// 权威映射规则见 docs/cgl-models.md 2.10.1（与 docs/cgl-libs.md 2.3.6 为同一份表）。
// 本脚本是那份表的**唯一可执行实现**：字段映射一旦在此改动，必须同步改两侧文档。
//
// 责任边界（硬性）：
// - 本脚本只填 id / i18n_namespace / display_name / summary / author.name / author.contact /
//   repo / license / version / min_launcher / max_launcher / api_version / platforms /
//   assets / permissions / changelog / published_at。
// - channel / status / yanked / yank_reason / author.verified / icon.* / permissions_derived
//   一律不由本脚本确定（分别属于 cgl-libs CI、审核流程或维护者）。
// - 任何无法从 manifest 与 Release 唯一确定的字段一律**失败**，不猜默认值。
//
// 用法：
//   node scripts/build-libs-entry.mjs --dry-run                       # 本地预览（不联网）
//   node scripts/build-libs-entry.mjs --dry-run --dir dist-package    # 用本地资产
//   node scripts/build-libs-entry.mjs --tag v0.1.0 --assets-json <gh-release.json> --out .submit
//   node scripts/build-libs-entry.mjs --check-idempotent --existing cgl-libs/modules/<range>.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** 分片归属：按 i18n_namespace 首字符判定（见 docs/cgl-models.md 2.10）。 */
function shardOf(namespace) {
  const first = namespace[0];
  if (/[0-9]/.test(first)) return "modules/0-9.json";
  if (/[a-z]/.test(first)) {
    // 字母范围段：与 cgl-libs 2.1 的切分一致（每两字母一段，a-b / c-d / ...）。
    const index = first.charCodeAt(0) - 97;
    const lo = String.fromCharCode(97 + Math.floor(index / 2) * 2);
    const hi = String.fromCharCode(97 + Math.floor(index / 2) * 2 + 1);
    return `modules/${lo}-${hi}.json`;
  }
  return "modules/_other.json";
}

/** author.contact：优先 url，缺失取 email；二者皆缺即提审失败（审核红线第 5 条）。 */
function authorContact(author) {
  if (author.url && author.url.trim()) return { value: author.url.trim(), from: "author.url" };
  if (author.email && author.email.trim()) return { value: author.email.trim(), from: "author.email" };
  fail("author 既无 url 也无 email：无法确定收录条目的 author.contact，提审不允许猜默认值");
}

/** summary locale map：zh-CN / en-US 必含，各自缺失时回退 description。 */
function buildSummary(manifest) {
  const i18n = manifest.i18n ?? {};
  return {
    "zh-CN": i18n["zh-CN"]?.description ?? manifest.description,
    "en-US": i18n["en-US"]?.description ?? manifest.description,
  };
}

/** 本地资产信息（dry-run 时用于填 size / sha256 / url 占位）。 */
function localAssetInfo(platform, dir) {
  if (!dir) return null;
  const abs = resolve(REPO_ROOT, dir);
  const name = packageFileName(readManifest(), platform);
  const assetPath = join(abs, name);
  const checksumPath = join(abs, checksumFileName(name));
  if (!existsSync(assetPath) || !existsSync(checksumPath)) return null;
  const parsed = parseChecksumLine(readFileSync(checksumPath, "utf8"));
  if (!parsed) fail(`校验文件格式非法：${displayPath(checksumPath)}`);
  const actual = sha256File(assetPath);
  if (actual !== parsed.hex) {
    fail(`${name} 的校验值与校验文件不一致（实际 ${actual}，声明 ${parsed.hex}）`);
  }
  return { size: readFileSync(assetPath).length, sha256: parsed.hex };
}

/** 读取 Release 资产清单（gh release view --json assets 的输出）。 */
function readReleaseAssets() {
  const path = args.get("assets-json");
  if (!path) return null;
  const abs = resolve(REPO_ROOT, path);
  if (!existsSync(abs)) fail(`找不到 Release 资产清单：${displayPath(abs)}`);
  const parsed = JSON.parse(readFileSync(abs, "utf8"));
  const list = Array.isArray(parsed) ? parsed : (parsed.assets ?? []);
  return list.map((a) => ({
    name: a.name ?? a.fileName,
    url: a.url ?? a.downloadUrl ?? a.browserDownloadUrl,
    size: a.size ?? a.sizeBytes,
    publishedAt: a.publishedAt ?? parsed.published_at ?? parsed.publishedAt,
  }));
}

function main() {
  let manifest;
  try {
    manifest = readManifest();
  } catch (e) {
    fail(e.message);
  }

  const tag = args.get("tag", `v${manifest.version}`);
  const expectedVersion = tag.replace(/^v/, "");
  if (expectedVersion !== manifest.version) {
    fail(`tag("${tag}")与 module.json.version("${manifest.version}")不一致，拒绝生成条目`);
  }

  const contact = authorContact(manifest.author);
  const releaseAssets = readReleaseAssets();
  const localDir = args.get("dir");
  const publishedAt =
    args.get("published-at") ??
    releaseAssets?.find((a) => a.publishedAt)?.publishedAt ??
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // 逐平台组装 assets：声明了平台但 Release 缺产物 -> 失败（platforms 是承诺）。
  const assets = [];
  for (const platform of manifest.platforms ?? []) {
    const assetName = packageFileName(manifest, platform);
    let url;
    let size;
    let sha256;

    const remote = releaseAssets?.find((a) => a.name === assetName);
    if (remote) {
      url = remote.url;
      size = remote.size;
      const remoteChecksum = releaseAssets.find(
        (a) => a.name === checksumFileName(assetName),
      );
      if (!remoteChecksum?.url) {
        fail(`Release 中缺少 ${assetName} 的配对校验文件，无法确定 sha256`);
      }
      sha256 = args.get("sha256-" + platform) ?? null;
      if (!sha256) {
        // 线上由 bot 下载校验文件；dry-run 且无网络时退化为本地校验文件。
        const local = localAssetInfo(platform, localDir);
        if (!local) {
          fail(
            `无法确定 ${assetName} 的 sha256：请传 --sha256-${platform} <hex> 或提供 --dir <本地产物目录>`,
          );
        }
        sha256 = local.sha256;
        size = size ?? local.size;
      }
    } else {
      const local = localAssetInfo(platform, localDir);
      if (!local) {
        fail(
          `平台 ${platform} 在 Release 中缺少产物 ${assetName}，且本地目录（--dir）也没有；` +
            `platforms 是承诺：产物缺失即提审失败（不允许生成半成品条目）`,
        );
      }
      url = `https://github.com/${repoSlug(manifest)}/releases/download/${tag}/${assetName}`;
      size = local.size;
      sha256 = local.sha256;
    }

    assets.push({ platform, url, mirrors: [], size, sha256 });
  }

  const entry = {
    id: manifest.id,
    i18n_namespace: manifest.i18n_namespace,
    display_name: manifest.display_name,
    summary: buildSummary(manifest),
    author: { name: manifest.author.name, contact: contact.value, verified: false },
    repo: manifest.homepage,
    license: manifest.license,
    // channel 由 cgl-libs CI 依 Release 是否预发布与审核结论判定，bot 不得指定；
    // 此处写 stable 仅作为**提案值**，cgl-libs CI 会覆盖。
    channel: "stable",
    version: manifest.version,
    published_at: publishedAt,
    platforms: manifest.platforms,
    min_launcher: manifest.launcher.min,
    max_launcher: manifest.launcher.max ?? null,
    api_version: manifest.api_version,
    icon: {
      path: `assets/icons/${manifest.id}.png`,
      sha256: null,
      size: null,
    },
    assets,
    permissions: manifest.permissions ?? [],
    permissions_derived: deriveSummary(manifest.permissions ?? []),
    changelog: buildChangelog(manifest),
    status: "pending",
    yanked: false,
    yank_reason: null,
  };

  const shard = shardOf(manifest.i18n_namespace);
  const prBody = buildPrBody(manifest, entry, contact.from, shard);

  if (args.has("dry-run") || !args.get("out")) {
    info("干跑模式：以下内容不会写盘（加 --out <目录> 可落盘供 workflow 消费）");
    process.stdout.write(`${JSON.stringify({ shard, entry }, null, 2)}\n`);
    process.stdout.write(`\n----- pr-body.md -----\n${prBody}\n`);
    return;
  }

  const outDir = resolve(REPO_ROOT, args.get("out"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "entry.json"), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "pr-body.md"), prBody, "utf8");
  writeFileSync(
    join(outDir, "shard.txt"),
    `${shard}\n`,
    "utf8",
  );
  info(`已生成 ${displayPath(join(outDir, "entry.json"))}（目标分片 ${shard}）`);
  info(`已生成 ${displayPath(join(outDir, "pr-body.md"))}`);
}

/** 细粒度权限 -> 三布尔摘要（与 cgl-libs CI 的派生规则逐条一致）。 */
function deriveSummary(permissions) {
  const set = new Set(permissions);
  return {
    network: set.has("network"),
    spawn_process: set.has("process:spawn"),
    write_outside_module_dir: set.has("filesystem:game-dir") || set.has("settings:write"),
  };
}

/** changelog locale map：从 CHANGELOG.md 当前版本段提取，缺失时失败（不猜）。 */
function buildChangelog(manifest) {
  const path = manifest.changelog ?? "CHANGELOG.md";
  const abs = join(REPO_ROOT, path);
  if (!existsSync(abs)) {
    fail(`找不到 changelog 文件：${path}（收录条目的 changelog 取自该文件，缺失即提审失败）`);
  }
  const text = readFileSync(abs, "utf8");
  const section = extractVersionSection(text, manifest.version);
  if (!section) {
    fail(`${path} 中找不到版本段 [${manifest.version}]；CHANGELOG 必须含该版本段`);
  }
  return { "zh-CN": section, "en-US": section };
}

/** 提取 `## [x.y.z]` 到下一个同级标题之间的正文。 */
function extractVersionSection(text, version) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+\[/.test(lines[i]) && lines[i].includes(`[${version}]`)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+\[/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

function repoSlug(manifest) {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(manifest.homepage ?? "");
  return m ? `${m[1]}/${m[2]}` : "copper-lamp/cgl-models";
}

/** PR 正文：审核者需要一眼看全的信息 + 勾选框式检查项。 */
function buildPrBody(manifest, entry, contactFrom, shard) {
  const rows = entry.assets
    .map(
      (a) =>
        `| ${a.platform} | ${a.url.split("/").pop()} | ${a.size} | \`${a.sha256}\` |`,
    )
    .join("\n");
  const perms =
    entry.permissions.length > 0
      ? entry.permissions.map((p) => `- \`${p}\``).join("\n")
      : "- 本模块不申请任何权限";
  const derived = Object.entries(entry.permissions_derived)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  return `## 模块提审：${manifest.display_name} ${manifest.version}

| 项 | 值 |
|---|---|
| 模块 id | \`${entry.id}\` |
| i18n 命名空间 | \`${entry.i18n_namespace}\` |
| 版本 | ${entry.version} |
| api_version | ${entry.api_version} |
| 内核兼容区间 | >= ${entry.min_launcher}${entry.max_launcher ? `, <= ${entry.max_launcher}` : "（无上限）"} |
| 许可 | ${entry.license} |
| 源码仓库 | ${entry.repo} |
| 目标分片 | \`${shard}\` |
| 作者联系方式来源 | ${contactFrom} |
| 发布时间 | ${entry.published_at} |

### 平台与产物

| 平台 | 资产 | 字节数 | sha256 |
|---|---|---|---|
${rows}

### 权限声明

${perms}

派生的只读摘要（由 cgl-libs CI 计算，人工不得填写）：

${derived}

### 审核检查项

- [ ] \`module.json\` 通过 \`module.schema.json\` 校验
- [ ] 版本与 git tag、CHANGELOG 三者一致
- [ ] \`i18n_namespace\` 全仓库唯一，且语言包为扁平键
- [ ] 语言包 zh-CN / en-US 键集完全一致
- [ ] 权限清单已逐项核对申请理由，且与模块实际能力相符
- [ ] 许可与仓库 LICENSE 一致，第三方组件已登记 \`THIRD_PARTY_NOTICES.md\`
- [ ] 产物由 CI 构建（非本地手工上传），校验值与 Release 资产一致
- [ ] 未内置、未分发游戏本体或其反编译产物

### 备注

- 本 PR 由模块仓库的提审 bot 生成，bot 只读取 Release 已上传资产与校验值，不重新构建产物。
- \`channel\` / \`status\` / \`yanked\` / \`yank_reason\` / \`author.verified\` / \`icon.*\` / \`permissions_derived\`
  由 cgl-libs 侧流程确定，bot 已按契约留出待填状态。
`;
}

main();
