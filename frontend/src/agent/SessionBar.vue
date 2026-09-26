<script setup lang="ts">
// 顶部会话栏：历史入口 + 当前会话名 + 新建 / 设置。
//
// 历史会话经此处的图标按钮展开浮层，页面不设常驻侧栏（见设计文档「顶部会话栏」）。

import { Menu, Settings, SquarePen } from "@lucide/vue";

import { useI18n } from "./i18n";
import { useAgentChat } from "./useAgentChat";

const KB = "module.demo-tools";
const { t } = useI18n();
const { historyOpen, settingsOpen, currentSession, newSession } = useAgentChat();
</script>

<template>
  <header class="agent-bar">
    <button
      type="button"
      class="agent-bar__icon"
      :class="{ 'agent-bar__icon--active': historyOpen }"
      :aria-expanded="historyOpen"
      :aria-label="t(`${KB}.agent_history`)"
      :title="t(`${KB}.agent_history`)"
      @click="historyOpen = !historyOpen"
    >
      <Menu :size="18" />
    </button>

    <h2
      class="agent-bar__session"
      :title="currentSession?.title || t(`${KB}.agent_session_default`)"
    >
      {{ currentSession?.title || t(`${KB}.agent_session_default`) }}
    </h2>

    <div class="agent-bar__actions">
      <button
        type="button"
        class="agent-bar__icon"
        :aria-label="t(`${KB}.agent_new_session`)"
        :title="t(`${KB}.agent_new_session`)"
        @click="newSession()"
      >
        <SquarePen :size="18" />
      </button>
      <button
        type="button"
        class="agent-bar__icon"
        :class="{ 'agent-bar__icon--active': settingsOpen }"
        :aria-pressed="settingsOpen"
        :aria-label="t(`${KB}.agent_settings`)"
        :title="t(`${KB}.agent_settings`)"
        @click="settingsOpen = !settingsOpen"
      >
        <Settings :size="18" />
      </button>
    </div>
  </header>
</template>
