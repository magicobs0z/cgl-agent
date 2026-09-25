<!--
  模块仓库自身的 PR 模板。
  注意：这与「向 cgl-libs 提审」的 PR 模板**不是一回事**——后者由提审 bot
  通过 scripts/build-libs-entry.mjs 自动生成 pr-body.md，不走本文件。勿混用。
-->

## 变更内容

<!-- 一句话说明这个 PR 做了什么。头英文、内容中文。 -->

## 变更类型

- [ ] 新功能（Added）
- [ ] 行为变更（Changed）
- [ ] 缺陷修复（Fixed）
- [ ] 安全相关（Security）
- [ ] 重构 / 文档（无行为变化）

## 契约影响（务必逐项确认）

- [ ] 未改动 `module.json` 的 `id` / `i18n_namespace`
- [ ] 未改动已有事件名 / 意图名（改了属破坏性变更，须升 `api_version`）
- [ ] 未新增权限（新增权限必须在下方说明申请理由）
- [ ] 数据库迁移为**追加式**（已有迁移文件不改内容，只新增更高 version）
- [ ] 语言包 zh-CN / en-US 键集仍完全一致
- [ ] 前端仅使用 `var(--copper-*)` 主题令牌，图标仅用 `@lucide/vue`

## 权限新增说明

<!-- 若无新增权限，写「无」。有则逐项说明：权限、用途、为何必须、能否降级。 -->

无

## 自检

- [ ] `node scripts/validate-manifest.mjs --check-locales` 通过
- [ ] `node --test tests/` 通过
- [ ] `npm run build:frontend` 通过
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 通过

## 备注

<!-- 已知限制、后续待办、需要审核者特别关注的点。禁止把未实现写成已实现。 -->
