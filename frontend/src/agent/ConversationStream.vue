<script setup lang="ts">
// 对话流：消息列表 + 吸底跟随 + 空态。
//
// 交互规则（见设计文档「交互与状态」）：生成中自动吸底；用户上滚时暂停跟随并浮出
// 「回到最新」，滚回底部自动恢复。用 `following` 标记用户意图，避免被程序滚动误判。

import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ArrowDown, Settings, Sparkles } from "@lucide/vue";

import { useI18n } from "./i18n";
import { useAgentChat } from "./useAgentChat";
import AssistantMessage from "./AssistantMessage.vue";
import ModuleEmptyState from "../components/ModuleEmptyState.vue";
import UserMessage from "./UserMessage.vue";

const KB = "module.demo-tools";
const { t } = useI18n();
const { currentMessages, currentSessionId, capabilities, settingsOpen } = useAgentChat();

const scroller = ref<HTMLElement | null>(null);
const following = ref(true);

/** 触发吸底的进度信号：消息条数 + 最后一条的内容长度（流式追加时变化）。 */
const contentSignal = computed(() => {
  const list = currentMessages.value;
  const last = list[list.length - 1];
  if (!last) return "0";
  if (last.role === "user") return `${list.length}:${last.text.length}`;
  return `${list.length}:${last.answer.length}:${last.blocks.length}`;
});

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(contentSignal, () => {
  if (following.value) void scrollToBottom();
});

watch(currentSessionId, () => {
  following.value = true;
  void scrollToBottom();
});

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  following.value = distance < 80;
}

function jumpToLatest(): void {
  following.value = true;
  void scrollToBottom();
}

onMounted(() => {
  void scrollToBottom();
});
</script>

<template>
  <section class="agent-stream">
    <div ref="scroller" class="agent-stream__scroller" @scroll.passive="onScroll">
      <div class="agent-stream__inner">
        <template v-for="message in currentMessages" :key="message.id">
          <UserMessage v-if="message.role === 'user'" :message="message" />
          <AssistantMessage v-else :message="message" />
        </template>

        <!-- 首次使用：尚未配置 API Key -->
        <ModuleEmptyState
          v-if="currentMessages.length === 0 && !capabilities.apiKeyConfigured"
          :icon="Settings"
          :title="t(`${KB}.agent_state_no_api_key_title`)"
          :description="t(`${KB}.agent_state_no_api_key_desc`)"
        >
          <button type="button" class="agent-msg__btn" @click="settingsOpen = true">
            {{ t(`${KB}.agent_open_settings`) }}
          </button>
        </ModuleEmptyState>

        <ModuleEmptyState
          v-else-if="currentMessages.length === 0"
          :icon="Sparkles"
          :title="t(`${KB}.agent_empty_title`)"
          :description="t(`${KB}.agent_empty_desc`)"
        />
      </div>
    </div>

    <button v-if="!following" type="button" class="agent-stream__jump" @click="jumpToLatest()">
      <ArrowDown :size="14" />
      <span>{{ t(`${KB}.agent_back_to_latest`) }}</span>
    </button>
  </section>
</template>
