// module.json 字段与 schema 一致性用例。
//
// 用 Node 内置测试运行器（`node --test`），不引入测试框架：模板应保持
// clone 后即可校验，不被依赖安装问题挡住。
//
// 覆盖点（对齐 docs/cgl-models.md 2.3 / 2.4 / 2.8.1）：
// - schema 必填字段齐备、枚举取值合法；
// - id 两段式、i18n_namespace 单段且不等同 id；
// - 后端 crate 名与产物名自洽；
// - 权限取值在权威 9 项枚举内（示例模块声明 intents:request 以演示意图发起）；
// - 语言包扁平键且 zh-CN / en-US 键集完全一致。

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CATEGORIES,
  PERMISSIONS,
  PLATFORMS,
  REPO_ROOT,
  readManifest,
  readSchema,
  tablePrefixOfId,
} from "../scripts/lib/paths.mjs";

const manifest = readManifest();
const schema = readSchema();

test("module.json 满足 schema 的必填字段", () => {
  for (const key of schema.required) {
    assert.ok(key in manifest, `缺少必填字段 ${key}`);
  }
});

test("module.json 不含 schema 未声明的字段", () => {
  for (const key of Object.keys(manifest)) {
    assert.ok(key in schema.properties, `schema 未声明字段 ${key}（additionalProperties: false）`);
  }
});

test("id 是两段式 author.module", () => {
  const pattern = new RegExp(schema.properties.id.pattern);
  assert.match(manifest.id, pattern);
  assert.ok(manifest.id.split(".").length >= 2, "id 至少两段");
});

test("i18n_namespace 单段、不含点号、且不等于 id", () => {
  assert.match(manifest.i18n_namespace, new RegExp(schema.properties.i18n_namespace.pattern));
  assert.ok(!manifest.i18n_namespace.includes("."), "i18n_namespace 含点号会被 t() 拆段");
  assert.notEqual(manifest.i18n_namespace, manifest.id);
  assert.equal(manifest.i18n_namespace, manifest.id.split(".").pop(), "约定取 id 第二段");
});

test("平台枚举取权威值", () => {
  assert.ok(Array.isArray(manifest.platforms) && manifest.platforms.length > 0);
  for (const p of manifest.platforms) {
    assert.ok(PLATFORMS.includes(p), `未知平台 ${p}`);
  }
});

test("权限取值在权威枚举内（示例模块为演示意图发起声明 intents:request）", () => {
  assert.ok(Array.isArray(manifest.permissions), "permissions 必须是数组");
  for (const p of manifest.permissions) {
    assert.ok(PERMISSIONS.includes(p), `未知权限 ${p}`);
  }
});

test("分类枚举合法", () => {
  assert.ok(CATEGORIES.includes(manifest.category), `未知分类 ${manifest.category}`);
});

test("后端 crate 名与产物名自洽", () => {
  const stem = manifest.backend.crate.replace(/-/g, "_");
  assert.ok(
    manifest.backend.artifact_glob.includes(stem),
    `artifact_glob 应含 ${stem}，实际 ${manifest.backend.artifact_glob}`,
  );
  assert.match(manifest.backend.crate, new RegExp(schema.properties.backend.properties.crate.pattern));
});

test("DB 表名前缀由 id 派生且不含点号与连字符", () => {
  const prefix = `module_${tablePrefixOfId(manifest.id)}_`;
  assert.equal(prefix, "module_copper_lamp_demo_tools_");
  assert.ok(!prefix.includes("."), "SQLite 标识符不允许点号");
  assert.ok(!prefix.includes("-"));
});

test("图标为仓库内相对路径且存在", () => {
  assert.ok(!/^[a-z]+:\/\//i.test(manifest.icon), "禁止外链图标");
  assert.ok(existsSync(join(REPO_ROOT, manifest.icon)), `图标不存在：${manifest.icon}`);
});

test("launcher 区间与 version 均为 semver", () => {
  const semver = /^\d+\.\d+\.\d+$/;
  assert.match(manifest.version, semver);
  assert.match(manifest.launcher.min, semver);
  assert.ok(manifest.launcher.max === null || semver.test(manifest.launcher.max));
});

test("api_version 为正整数", () => {
  assert.ok(Number.isInteger(manifest.api_version) && manifest.api_version >= 1);
});

test("language pack 为扁平键且 zh-CN / en-US 键集一致", () => {
  const dir = join(REPO_ROOT, "frontend", "src", "locales");
  const packs = {};
  for (const locale of ["zh-CN", "en-US"]) {
    const file = join(dir, `${locale}.json`);
    assert.ok(existsSync(file), `缺少语言包 ${locale}.json`);
    packs[locale] = JSON.parse(readFileSync(file, "utf8"));
  }
  for (const [locale, pack] of Object.entries(packs)) {
    for (const [key, value] of Object.entries(pack)) {
      assert.ok(!key.includes("."), `${locale}.json 的键 "${key}" 含点号（须为扁平键）`);
      assert.equal(typeof value, "string", `${locale}.json 的 "${key}" 不是字符串（禁止嵌套）`);
    }
  }
  assert.deepEqual(
    Object.keys(packs["zh-CN"]).sort(),
    Object.keys(packs["en-US"]).sort(),
    "zh-CN 与 en-US 键集必须完全一致",
  );
  for (const required of ["navTitle", "title"]) {
    assert.ok(required in packs["zh-CN"], `zh-CN.json 缺少必需键 ${required}`);
  }
});

test("license 在 LICENSE 与 README 中一致", () => {
  assert.ok(existsSync(join(REPO_ROOT, "LICENSE")), "缺少 LICENSE 文件");
  assert.ok(
    readFileSync(join(REPO_ROOT, "README.md"), "utf8").includes(manifest.license),
    `README.md 未声明许可 ${manifest.license}`,
  );
});
