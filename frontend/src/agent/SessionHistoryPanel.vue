<script setup lang="ts">
// 历史会话浮层：搜索、切换、删除、空态。
//
// 历史数据来自持久化会话库；内核未接入时用预览数据填充（见 previewData.ts），
// 且删除动作不会被伪装成功 —— 请求发不出去就如实提示。

import { computed, ref } from "vue";
import { Info, Search, Trash2, X } from "@lucide/vue";

import { formatClock } from "./format";
import { useI18n } from "./i18n";
import { useAgentChat } from "./useAgentChat";
import ModuleEmptyState from "../components/ModuleEmptyState.vue";

const KB = "module.demo-tools";
const { t } = useI18n();
const { sessions, currentSessionId, historyOpen, capabilities, selectSession, deleteSession } =
  useAgentChat();

const query = ref("");

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return sessions.value;
  return sessions.value.filter((s) => s.title.toLowerCase().includes(keyword));
});
</script>

<template>
  <aside class="agent-history" role="region" :aria-label="t(`${KB}.agent_history`)">
    <div class="agent-history__head">
      <label class="agent-history__search">
        <Search :size="14" class="agent-history__search-icon" />
        <input
          v-model="query"
          type="search"
          class="agent-history__search-input"
          :placeholder="t(`${KB}.agent_history_search`)"
          :aria-label="t(`${KB}.agent_history_search`)"
        />
      </label>
      <button
        type="button"
        class="agent-history__close"
        :aria-label="t(`${KB}.agent_close`)"
        :title="t(`${KB}.agent_close`)"
        @click="historyOpen = false"
      >
        <X :size="16" />
      </button>
    </div>

    <p v-if="capabilities.persistenceUnavailable" class="agent-history__notice">
      <Info :size="14" class="agent-history__notice-icon" />
      <span>{{ t(`${KB}.agent_persistence_off`) }}</span>
    </p>

    <p v-if="sessions.length === 0" class="agent-history__hint">
      {{ t(`${KB}.agent_history_empty`) }}
    </p>

    <ModuleEmptyState
      v-else-if="filtered.length === 0"
      :icon="Search"
      :title="t(`${KB}.agent_history_no_match`)"
      :description="t(`${KB}.agent_history_no_match_desc`)"
      compact
    />

    <ul v-else class="agent-history__list">
      <li v-for="session in filtered" :key="session.id">
        <div
          class="agent-history__row"
          :class="{ 'agent-history__row--current': session.id === currentSessionId }"
        >
          <button type="button" class="agent-history__item" @click="selectSession(session.id)">
            <span class="agent-history__title">
              {{ session.title || t(`${KB}.agent_session_default`) }}
            </span>
            <span class="agent-history__time">{{ formatClock(session.updatedAt) }}</span>
          </button>
          <button
            type="button"
            class="agent-history__delete"
            :aria-label="t(`${KB}.agent_history_delete`)"
            :title="t(`${KB}.agent_history_delete`)"
            @click="deleteSession(session.id)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </li>
    </ul>
  </aside>
</template>
