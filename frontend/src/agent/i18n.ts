// 模块内统一的 i18n 入口。
//
// 把内核的四层相对路径收敛到一处：否则每个组件都要重复写
// `../../../../CopperCore/frontend/src/i18n`，路径一旦调整需要改满仓。
//
// 文案键前缀为 `module.demo-tools.*`（i18n_namespace 决定），模板里用 `agent_` 前缀分组。

export { useI18n } from "../../../../CopperCore/frontend/src/i18n";
