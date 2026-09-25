#!/usr/bin/env node
// module.json 校验器：编辑器内 schema 校验之外的**命令行同一份规则**。
//
// 为什么需要它：内核读 module.json 做装载与展示，CI 读它做打包与提审，
// 两侧若各写一套判断，错误只会表现为「运行起来没反应」。故本脚本以
// `module.schema.json` 为唯一依据，并叠加 schema 表达不了、但链路强依赖的语义检查。
//
// 用法：
//   node scripts/validate-manifest.mjs                     # schema + 语义校验
//   node scripts/validate-manifest.mjs --check-locales     # 额外校验 zh-CN / en-US 键集一致
//   node scripts/validate-manifest.mjs --expect-version 0.1.0   # 校验版本与 tag 一致
//   node scripts/validate-manifest.mjs --json              # 机器可读输出

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CATEGORIES,
  MANIFEST_FILE,
  PERMISSIONS,
  PLATFORMS,
  REPO_ROOT,
  displayPath,
  fail,
  info,
  parseArgs,
  readManifest,
  readSchema,
  tablePrefixOfId,
} from "./lib/paths.mjs";

const args = parseArgs(process.argv.slice(2));
const asJson = args.has("json");
const problems = [];

function report(code, message) {
  problems.push({ code, message });
}

/**
 * 用 Ajv 按 module.schema.json 校验。
 *
 * Ajv 是 devDependency：模板作者可能不装 node_modules 就跑脚本，此时退化为
 * 「内置语义校验」并在结果里明确标注 schema 校验被跳过，而不是静默通过。
 */
async function validateWithSchema(manifest) {
  let Ajv;
  let addFormats;
  try {
    ({ default: Ajv } = await import("ajv/dist/2020.js"));
  } catch {
    report(
      "schema.skipped",
      "未安装 ajv，已跳过 JSON Schema 校验（请执行 npm install 后重跑）；下方语义校验仍已执行",
    );
    return;
  }
  try {
    ({ default: addFormats } = await import("ajv-formats"));
  } catch {
    addFormats = null;
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  if (addFormats) addFormats(ajv);
  const validate = ajv.compile(readSchema());
  if (!validate(manifest)) {
    for (const err of validate.errors ?? []) {
      const where = err.instancePath || "(根)";
      report("schema.invalid", `schema 校验失败 ${where}: ${err.message}`);
    }
  }
}

/** schema 之外的语义检查：链路强依赖、但 JSON Schema 表达不了的规则。 */
function validateSemantics(manifest) {
  // 1. i18n_namespace 必须是单段且不能等于 id —— 含点号会被 t() 拆段，必然回退键名（设计文档 2.8.1）。
  if (typeof manifest.i18n_namespace === "string" && manifest.i18n_namespace.includes(".")) {
    report("i18n.namespace_has_dot", "i18n_namespace 含点号：t() 会按点拆段，语言包必然查不到");
  }
  if (manifest.i18n_namespace === manifest.id) {
    report("i18n.namespace_equals_id", "i18n_namespace 不得等于 id（id 含点号，必拆段）");
  }

  // 2. 默认命名空间约定：取 id 第二段。约定可以不同，但必须显式声明且可解释。
  const idTail = typeof manifest.id === "string" ? manifest.id.split(".").pop() : undefined;
  if (idTail && manifest.i18n_namespace && idTail !== manifest.i18n_namespace) {
    report(
      "i18n.namespace_not_from_id",
      `i18n_namespace("${manifest.i18n_namespace}")与 id 第二段("${idTail}")不一致（约定取 id 第二段；确需例外请在提审说明中写清理由）`,
    );
  }

  // 3. 后端产物名必须与 crate 名自洽，否则打包矩阵会找不到产物。
  const crate = manifest.backend?.crate;
  if (typeof crate === "string") {
    const expectedStem = crate.replace(/-/g, "_");
    const glob = manifest.backend?.artifact_glob ?? "";
    const okExt = /\.(dll|so)$/.test(glob);
    if (!glob.includes(expectedStem)) {
      report(
        "backend.artifact_glob_mismatch",
        `backend.artifact_glob("${glob}")不含 crate 名派生的产物名("${expectedStem}")`,
      );
    }
    if (!okExt) {
      report("backend.artifact_glob_ext", `backend.artifact_glob("${glob}")未以 .dll / .so 结尾`);
    }
  }

  // 4. 权限枚举必须逐项合法（schema 已限制，这里给出可读的越权名提示）。
  for (const p of manifest.permissions ?? []) {
    if (!PERMISSIONS.includes(p)) {
      report("permissions.unknown", `permissions 含未知名 "${p}"，权威枚举共 ${PERMISSIONS.length} 项`);
    }
  }

  // 5. 图标必须落在仓库内且真实存在（禁止外链）。
  const icon = manifest.icon;
  if (typeof icon === "string") {
    if (/^[a-z]+:\/\//i.test(icon)) {
      report("icon.remote", "icon 禁止外链，必须是 module.json 同级的相对路径");
    } else if (!existsSync(join(REPO_ROOT, icon))) {
      report("icon.missing", `icon 指向的文件不存在：${icon}`);
    }
  }

  // 6. license 一致性：module.json / LICENSE / README 四处必须一致（此处查前三处）。
  const licenseFile = join(REPO_ROOT, "LICENSE");
  if (!existsSync(licenseFile)) {
    report("license.missing_file", "缺少 LICENSE 文件（module.json.license 须与仓库 LICENSE 一致）");
  }
  const readme = join(REPO_ROOT, "README.md");
  if (existsSync(readme) && typeof manifest.license === "string") {
    const text = readFileSync(readme, "utf8");
    if (!text.includes(manifest.license)) {
      report("license.readme_mismatch", `README.md 未出现 license "${manifest.license}"`);
    }
  }

  // 7. changelog 路径必须存在（提审 bot 要读取其内容）。
  if (typeof manifest.changelog === "string" && !existsSync(join(REPO_ROOT, manifest.changelog))) {
    report("changelog.missing", `changelog 指向的文件不存在：${manifest.changelog}`);
  }

  // 8. 平台与后端产物扩展名必须自洽（Windows 用 .dll，*nix 用 .so）。
  const glob = manifest.backend?.artifact_glob ?? "";
  const onlyWindows = (manifest.platforms ?? []).every((p) => p.startsWith("windows-"));
  if (onlyWindows && !glob.endsWith(".dll")) {
    report("backend.platform_ext", `platforms 仅含 Windows，但 artifact_glob 不是 .dll：${glob}`);
  }
}

/** 语言包键集一致性：zh-CN 与 en-US 必须完全一致（缺键会回退成另一语言或键名）。 */
function validateLocales(manifest) {
  const dir = join(REPO_ROOT, "frontend", "src", "locales");
  const locales = ["zh-CN", "en-US"];
  const packs = {};
  for (const locale of locales) {
    const file = join(dir, `${locale}.json`);
    if (!existsSync(file)) {
      report("locales.missing", `缺少语言包：${displayPath(file)}`);
      continue;
    }
    try {
      packs[locale] = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      report("locales.parse", `解析 ${displayPath(file)} 失败：${e.message}`);
    }
  }
  if (Object.keys(packs).length !== locales.length) return;

  for (const locale of locales) {
    const pack = packs[locale];
    if (pack === null || typeof pack !== "object" || Array.isArray(pack)) {
      report("locales.not_flat", `${locale}.json 必须是扁平键对象（禁止再套一层 id 对象）`);
      continue;
    }
    for (const [key, value] of Object.entries(pack)) {
      if (key.includes(".")) {
        report(
          "locales.dotted_key",
          `${locale}.json 的键 "${key}" 含点号：语言包为扁平键，命名空间由内核按 i18n_namespace 挂载`,
        );
      }
      if (typeof value !== "string") {
        report("locales.nested", `${locale}.json 的键 "${key}" 不是字符串（语言包必须是扁平键 -> 字符串）`);
      }
    }
  }

  const zhKeys = Object.keys(packs["zh-CN"]).sort();
  const enKeys = Object.keys(packs["en-US"]).sort();
  const onlyZh = zhKeys.filter((k) => !enKeys.includes(k));
  const onlyEn = enKeys.filter((k) => !zhKeys.includes(k));
  if (onlyZh.length > 0) {
    report("locales.key_mismatch", `zh-CN 独有键（en-US 缺失，en-US 是回退基准，必须补齐）：${onlyZh.join(", ")}`);
  }
  if (onlyEn.length > 0) {
    report("locales.key_mismatch", `en-US 独有键（zh-CN 缺失）：${onlyEn.join(", ")}`);
  }

  // 语言包必须覆盖 register/routes 用到的键前缀，避免「注册了但显示键名」。
  for (const locale of locales) {
    for (const required of ["navTitle", "title"]) {
      if (!(required in packs[locale])) {
        report("locales.required_key", `${locale}.json 缺少必需键 "${required}"`);
      }
    }
  }
}

/** 版本与 tag 一致性（发布链路的前置门禁）。 */
function validateVersion(manifest, expected) {
  if (expected === undefined) return;
  if (manifest.version !== expected) {
    report(
      "version.tag_mismatch",
      `module.json.version("${manifest.version}")与 tag("${expected}")不一致`,
    );
  }
}

async function main() {
  const expectedVersion = args.get("expect-version");
  let manifest;
  try {
    manifest = readManifest();
  } catch (e) {
    fail(e.message);
  }

  await validateWithSchema(manifest);
  validateSemantics(manifest);
  if (args.has("check-locales")) validateLocales(manifest);
  validateVersion(manifest, expectedVersion);

  // 平台数量与后端产物扩展名是打包矩阵的输入，单独回显便于排查。
  const summary = {
    id: manifest.id,
    i18n_namespace: manifest.i18n_namespace,
    version: manifest.version,
    api_version: manifest.api_version,
    platforms: manifest.platforms,
    permissions: manifest.permissions ?? [],
    db_table_prefix: `module_${tablePrefixOfId(manifest.id)}_`,
    category: manifest.category,
    categories_ok: CATEGORIES.includes(manifest.category),
    platforms_ok: (manifest.platforms ?? []).every((p) => PLATFORMS.includes(p)),
  };

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: problems.length === 0, summary, problems }, null, 2)}\n`,
    );
  } else {
    info(`${MANIFEST_FILE} 摘要：${JSON.stringify(summary)}`);
    for (const p of problems) {
      process.stderr.write(`  [${p.code}] ${p.message}\n`);
    }
  }

  if (problems.length > 0) {
    if (!asJson) {
      process.stderr.write(`[cgl-models] 失败：共 ${problems.length} 项问题\n`);
    }
    process.exit(1);
  }
  if (!asJson) info("校验通过");
}

await main();
