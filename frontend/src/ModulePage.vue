<script setup lang="ts">
// Agent 聊天页：顶部会话栏 + 中部对话流 + 底部输入栏，设置与历史以浮层进入。
//
// 页面只做展示与意图转发：Agent 循环、会话持久化、Pi 命令与审批语义都在内核监管的
// Node 会话里。内核能力未接入时页面如实标注并丢弃无效请求（见 useAgentChat 的边界说明），
// 不伪造回答、不伪造保存成功；前端不持有也不持久化 API Key。

import SessionBar from "./agent/SessionBar.vue";
import SessionHistoryPanel from "./agent/SessionHistoryPanel.vue";
import ConversationStream from "./agent/ConversationStream.vue";
import Composer from "./agent/Composer.vue";
import SettingsPanel from "./agent/SettingsPanel.vue";

import { useI18n } from "./agent/i18n";
import { useAgentChat } from "./agent/useAgentChat";

const KB = "module.demo-tools";
const { t } = useI18n();
const { historyOpen, settingsOpen, capabilities, notices, dismissNotice } = useAgentChat();
</script>

<template>
  <div class="agent-page">
    <SessionBar />

    <p v-if="!capabilities.sessionBackendAvailable" class="agent-page__banner" role="status">
      <span>{{ t(`${KB}.agent_backend_banner`) }}</span>
    </p>

    <SessionHistoryPanel v-if="historyOpen" />

    <ul v-if="notices.length > 0" class="agent-notices" aria-live="polite">
      <li v-for="notice in notices" :key="notice.id" class="agent-notices__item">
        <span>{{ t(`${KB}.${notice.key}`) }}</span>
        <span v-if="notice.detail" class="agent-notices__detail">{{ notice.detail }}</span>
        <button
          type="button"
          class="agent-notices__close"
          :aria-label="t(`${KB}.agent_close`)"
          @click="dismissNotice(notice.id)"
        >
          ×
        </button>
      </li>
    </ul>

    <ConversationStream />

    <p v-if="capabilities.persistenceUnavailable" class="agent-page__persistence">
      {{ t(`${KB}.agent_persistence_off`) }}
    </p>

    <Composer />

    <SettingsPanel v-if="settingsOpen" />
  </div>
</template>
