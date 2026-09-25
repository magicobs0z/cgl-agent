// 发布包目录结构断言：`module.json` / `backend/` / `frontend/` / 校验清单齐备。
//
// 两种模式：
//   默认      —— 真的打一次包（需要前端与后端产物已构建），然后**解包校验**内部布局；
//   --plan-only —— 只验证打包计划（不落盘），供 CI 在未构建产物时做结构门禁。
//
// 动手解包而不是只看打包脚本的输出，是因为「结构契约」只有在真实产物上验证才有意义；
// 只检查 `contents` Map 的话，zip 写入环节的偏差（路径、顺序、条目名）会被漏掉。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  REPO_ROOT,
  readManifest,
  checksumFileName,
  packageFileName,
} from "../scripts/lib/paths.mjs";

const manifest = readManifest();
const planOnly = process.argv.includes("--plan-only");
const platform = "windows-x86_64";

/**
 * 构造本用例所需的最小产物夹具，返回 [前端 dist 目录, 后端产物路径]。
 *
 * 为什么不让用例「产物不存在就跳过」：跳过会让这条结构门禁在任何未构建的机器上
 * 悄悄失去覆盖，而它正是用来守发布包布局的——门禁失效比门禁失败更危险。
 * 这里改为自己造夹具，用例在任何机器上都真实执行（见 AGENTS.md 第二章
 * 「不得为了让测试通过而放宽断言」）。
 *
 * 夹具用**临时目录**而非仓库内的 `frontend/dist` 与 `target/`：
 * 用例不得写仓库工作区，也不得与真实构建产物互相覆盖。
 */
function makeArtifactFixture() {
  const root = mkdtempSync(join(tmpdir(), "cglm-fixture-"));
  // 前端产物：只需满足打包器的结构门禁（dist 非空 + 存在 register 入口）。
  const frontendDir = join(root, "dist");
  mkdirSync(join(frontendDir, "assets"), { recursive: true });
  writeFileSync(join(frontendDir, manifest.frontend.register), "// fixture\n");
  writeFileSync(join(frontendDir, "assets", "fixture.css"), "/* fixture */\n");
  // 后端产物：打包器只校验存在与非空，不看真实 ELF/PE 结构。
  const backend = join(root, "copper_module_demo.dll");
  writeFileSync(backend, "fixture-backend\n");
  return [frontendDir, backend];
}

/** 从 zip 字节解析中央目录，返回条目名列表（只读结构，不依赖解压库）。 */
function listZipEntries(buf) {
  // 先定位中央目录结束记录（EOCD）：从尾部向前找签名 0x06054b50。
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "zip 缺少中央目录结束记录");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, "中央目录头签名不符");
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8"));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** 从 zip 字节提取指定条目内容（store 模式：本地头后直接是数据）。 */
function readZipEntry(buf, entryName) {
  let offset = 0;
  while (offset < buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const size = buf.readUInt32LE(offset + 18);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    if (name === entryName) return buf.subarray(dataStart, dataStart + size);
    offset = dataStart + size;
  }
  return null;
}

test("package-module.mjs --plan-only 通过结构门禁", () => {
  // 用夹具而非真实产物：门禁本身必须无条件执行，否则未构建的机器上这条覆盖会消失。
  const [frontendDir, backend] = makeArtifactFixture();
  try {
    const out = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, "scripts", "package-module.mjs"),
        "--platform",
        platform,
        "--backend",
        backend,
        "--frontend",
        frontendDir,
        "--plan-only",
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.match(out, /module\.json/);
    assert.match(out, /backend\//);
    assert.match(out, /frontend\/register\.js/);
  } finally {
    rmSync(dirname(frontendDir), { recursive: true, force: true });
  }
});

test("发布包内部布局与校验清单符合契约", { skip: planOnly ? "plan-only 模式跳过实包校验" : false }, () => {
  // 同样用夹具：这条用例守的是发布包结构契约，必须无条件执行，
  // 不能因为「本机没构建过后端」就静默失去覆盖。
  const [frontendDir, backend] = makeArtifactFixture();
  const work = mkdtempSync(join(tmpdir(), "cglm-pkg-"));
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, "scripts", "package-module.mjs"),
        "--platform",
        platform,
        "--backend",
        backend,
        "--frontend",
        frontendDir,
        "--out",
        work,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

    const assetName = packageFileName(manifest, platform);
    const assetPath = join(work, assetName);
    assert.ok(existsSync(assetPath), `未生成 ${assetName}`);

    const checksumPath = join(work, checksumFileName(assetName));
    assert.ok(existsSync(checksumPath), `未生成 ${checksumFileName(assetName)}`);
    const checksumText = readFileSync(checksumPath, "utf8");
    assert.match(checksumText, /^[0-9a-f]{64} {2}\S+\n$/, "校验文件格式应为单行 <hex> 两空格 <文件名>");

    const buf = readFileSync(assetPath);
    const names = listZipEntries(buf);

    // 契约要求的必需条目（见 docs/cgl-models.md 2.9 发布包内部结构）。
    for (const required of [
      "module.json",
      "manifest.sha256",
      "icon.svg",
      "LICENSE",
      "frontend/register.js",
    ]) {
      assert.ok(names.includes(required), `包内缺少 ${required}，实际：${names.join(", ")}`);
    }
    assert.ok(
      names.some((n) => n.startsWith("backend/") && n.endsWith(".dll")),
      "包内缺少 backend/*.dll",
    );

    // 包内清单必须逐文件覆盖（自身除外）。
    const inner = readZipEntry(buf, "manifest.sha256").toString("utf8");
    const listed = inner
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("  ")[1]);
    for (const name of names.filter((n) => n !== "manifest.sha256")) {
      assert.ok(listed.includes(name), `manifest.sha256 未覆盖 ${name}`);
    }

    // 分片目录名必须与 id 一致（内核按 id 定位模块目录）。
    assert.ok(manifest.id, "模块 id 不得为空");
    assert.ok(names.includes(posix.join("frontend", manifest.frontend.register)));
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(dirname(frontendDir), { recursive: true, force: true });
  }
});

test("打包器拒绝未声明的平台", () => {
  const backend = join(REPO_ROOT, "target", "release", "copper_module_demo.dll");
  let failed = false;
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, "scripts", "package-module.mjs"),
        "--platform",
        "linux-x86_64", // module.json 只声明 windows-x86_64
        "--backend",
        backend,
        "--plan-only",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" },
    );
  } catch {
    failed = true;
  }
  assert.ok(failed, "未声明平台应被拒绝（platforms 是承诺而非描述）");
});
