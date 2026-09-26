<script setup lang="ts">
// 用户消息：头像 + 无描边圆角气泡，靠右显示（见设计文档「对话流」）。
//
// 用户输入按纯文本呈现并保留换行：展示原文，不做 Markdown 渲染，避免把用户写的
// 标记符号吃掉或误解析成结构。

import { User } from "@lucide/vue";

import { useI18n } from "./i18n";
import type { UserMessage } from "./types";

defineProps<{ message: UserMessage }>();

const { t } = useI18n();
</script>

<template>
  <div class="agent-user">
    <div class="agent-user__bubble">{{ message.text }}</div>
    <div class="agent-user__avatar" :title="t('module.demo-tools.agent_you')" aria-hidden="true">
      <User :size="16" />
    </div>
  </div>
</template>
