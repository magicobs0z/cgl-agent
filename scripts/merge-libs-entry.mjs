#!/usr/bin/env node
// 把收录条目并入 cgl-libs 的目标分片文件，实现提审的幂等写入。
//
// 为什么单独一个脚本：分片写入是**唯一会改动 cgl-libs 仓库内容**的动作，
// 也是最容易出错的地方。它的三条硬约束必须集中实现并可单独核对：
//   1. 按 `id` 在分片 `modules[]` 中定位条目：存在则**整体替换**该对象，不存在则追加；
//   2. 只改目标分片文件，**绝不**碰 `modules/_index.json` / `modules/by-id.json` /
//      `index.json`（这三个由 cgl-libs CI 重新生成，手工改会被覆盖并扰乱收录）；
//   3. 内容无差异时不写盘（让 create-pull-request 判定为无变更，从而不产生空提交）。
//
// 用法：
//   node scripts/merge-libs-entry.mjs --entry .submit/entry.json --shard-file .submit/shard.txt --libs cgl-libs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { displayPath, fail, info, parseArgs } from "./lib/paths.mjs";

const args = parseArgs(process.argv.slice(2));

/** cgl-libs 中由 CI 生成、禁止手工改动的文件。 */
const CI_OWNED = new Set([
  "index.json",
  "modules/_index.json",
  "modules/by-id.json",
]);

function main() {
  const entryPath = args.get("entry");
  const shardFile = args.get("shard-file");
  const libsRoot = args.get("libs");

  if (!entryPath || !shardFile || !libsRoot) {
    fail("必须提供 --entry <条目文件>、--shard-file <分片路径文件>、--libs <cgl-libs 目录>");
  }

  const entryAbs = resolve(entryPath);
  const shardAbs = resolve(shardFile);
  const libsAbs = resolve(libsRoot);

  if (!existsSync(entryAbs)) fail(`找不到条目文件：${entryAbs}`);
  if (!existsSync(shardAbs)) fail(`找不到分片路径文件：${shardAbs}`);
  if (!existsSync(libsAbs)) fail(`找不到 cgl-libs 检出目录：${libsAbs}`);

  const entry = JSON.parse(readFileSync(entryAbs, "utf8"));
  if (!entry?.id) fail("条目缺少 id，无法定位写入位置");

  const shardRel = readFileSync(shardAbs, "utf8").trim().replace(/\\/g, "/");
  if (!shardRel) fail("分片路径文件为空");
  if (CI_OWNED.has(shardRel)) {
    fail(`目标分片 ${shardRel} 由 cgl-libs CI 生成，禁止手工写入`);
  }
  if (!shardRel.startsWith("modules/") || !shardRel.endsWith(".json")) {
    fail(`分片路径不符合契约（应为 modules/<range>.json）：${shardRel}`);
  }

  const shardPath = join(libsAbs, shardRel);
  // 分片文件可能尚不存在（该字母段首次收录），此时创建空分片骨架。
  const shard = existsSync(shardPath)
    ? JSON.parse(readFileSync(shardPath, "utf8"))
    : { schema_version: "1", modules: [] };

  if (!Array.isArray(shard.modules)) {
    fail(`${shardRel} 的 modules 字段不是数组，拒绝写入以免破坏 cgl-libs 结构`);
  }

  const index = shard.modules.findIndex((m) => m?.id === entry.id);
  const before = JSON.stringify(shard, null, 2);
  if (index >= 0) {
    // 整体替换：不做字段级合并，避免上一版残留字段（例如已删除的权限）留在条目里。
    shard.modules[index] = entry;
    info(`已替换 ${shardRel} 中 id=${entry.id} 的既有条目（索引 ${index}）`);
  } else {
    shard.modules.push(entry);
    info(`已在 ${shardRel} 中追加 id=${entry.id} 的新条目`);
  }
  shard.modules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const after = JSON.stringify(shard, null, 2);
  if (before === after) {
    info("内容无差异，未写盘（create-pull-request 将判定为无变更，不产生空提交）");
    return;
  }

  mkdirSync(dirname(shardPath), { recursive: true });
  writeFileSync(shardPath, `${after}\n`, "utf8");
  info(`已写入 ${displayPath(shardPath, libsAbs)}（共 ${shard.modules.length} 个条目）`);
  info("提示：不要手工改动 index.json / modules/_index.json / modules/by-id.json，它们由 cgl-libs CI 生成");
}

main();
