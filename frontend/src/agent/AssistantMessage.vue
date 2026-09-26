<script setup lang="ts">
// 助手消息：通栏渲染，不使用气泡与卡片（见设计文档「对话流」）。
//
// 两种形态：
// - 生成中：顶部进行中状态行（当前动作 + 已完成步数），时间线实时展开。
// - 完成后：时间线折叠为一行摘要「任务过程 · 耗时」，下方完整展示最终回答。
// 失败、取消与受限状态在此如实呈现，并提供重试或前往设置。

import { computed } from "vue";
import {
  CircleAlert,
  Copy,
  LoaderCircle,
  RotateCcw,
  Share2,
  TriangleAlert,
} from "@lucide/vue";

import { formatDuration } from "./format";
import { useI18n } from "./i18n";
import { renderMarkdown } from "./markdown";
import { useAgentChat } from "./useAgentChat";
import TaskTimeline from "./TaskTimeline.vue";
import type { AssistantMessage } from "./types";

const props = defineProps<{ message: AssistantMessage }>();

const KB = "module.demo-tools";
const { t } = useI18n();
const { isTaskExpanded, toggleTask, resend, pushNotice, settingsOpen } = useAgentChat();

/** 失败/受限原因的文案键后缀：`not-connected` → `not_connected`。 */
const failureSlug = computed(() => props.message.failure?.kind.replace(/-/g, "_") ?? "");

const durationText = computed(() => {
  const { startedAt, endedAt } = props.message;
  if (!endedAt) return "";
  return formatDuration(endedAt - startedAt, t, `${KB}.agent_duration`);
});

const answerHtml = computed(() => renderMarkdown(props.message.answer));

async function copyAnswer(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.message.answer);
    pushNotice("agent_notice_copied");
  } catch (e) {
    pushNotice("agent_notice_copy_failed", e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <article class="agent-msg" :class="{ 'agent-msg--running': message.status === 'running' }">
    <!-- 生成中：进行中状态行 -->
    <p v-if="message.status === 'running'" class="agent-msg__progress" role="status">
      <LoaderCircle :size="14" class="agent-spin" />
      <span>{{ t(`${KB}.agent_task_running`) }}</span>
      <span v-if="message.progress" class="agent-msg__progress-action">
        {{ t(`${KB}.${message.progress.actionKey}`, { tool: message.progress.actionParam ?? "" }) }}
      </span>
      <span v-if="message.progress" class="agent-msg__progress-steps">
        {{ t(`${KB}.agent_task_steps`, { count: message.progress.doneSteps }) }}
      </span>
    </p>

    <!-- 完成后：折叠摘要行（整行点击折叠 / 展开） -->
    <button
      v-else-if="message.blocks.length > 0"
      type="button"
      class="agent-msg__summary"
      :aria-expanded="isTaskExpanded(message)"
      @click="toggleTask(message)"
    >
      <span>{{ t(`${KB}.agent_task_summary`) }}</span>
      <span v-if="durationText" class="agent-msg__summary-sep">·</span>
      <span v-if="durationText">{{ durationText }}</span>
      <span class="agent-msg__summary-toggle">
        {{ isTaskExpanded(message) ? t(`${KB}.agent_collapse`) : t(`${KB}.agent_expand`) }}
      </span>
    </button>

    <TaskTimeline
      v-if="message.blocks.length > 0 && (message.status === 'running' || isTaskExpanded(message))"
      :blocks="message.blocks"
    />

    <p v-if="message.status === 'cancelled'" class="agent-msg__cancelled">
      {{ t(`${KB}.agent_cancelled`) }}
    </p>

    <!-- 失败与受限状态 -->
    <div v-if="message.failure" class="agent-msg__failure" role="alert">
      <TriangleAlert :size="15" class="agent-msg__failure-icon" />
      <div class="agent-msg__failure-body">
        <p class="agent-msg__failure-title">
          {{ t(`${KB}.agent_state_${failureSlug}_title`) }}
        </p>
        <p class="agent-msg__failure-desc">{{ t(`${KB}.agent_state_${failureSlug}_desc`) }}</p>
        <p v-if="message.failure.detail" class="agent-msg__failure-detail">
          {{ message.failure.detail }}
        </p>
        <div class="agent-msg__failure-actions">
          <button type="button" class="agent-msg__btn" @click="resend(message)">
            <RotateCcw :size="13" />
            <span>{{ t(`${KB}.agent_retry`) }}</span>
          </button>
          <button
            v-if="message.failure.kind === 'no-api-key' || message.failure.kind === 'credential-unsupported'"
            type="button"
            class="agent-msg__btn"
            @click="settingsOpen = true"
          >
            <CircleAlert :size="13" />
            <span>{{ t(`${KB}.agent_open_settings`) }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 最终回答 -->
    <div v-if="message.answer" class="agent-msg__answer agent-markdown" v-html="answerHtml" />

    <!-- 回答完成后才出现的三个操作 -->
    <div v-if="message.status === 'done' && message.answer" class="agent-msg__actions">
      <button
        type="button"
        class="agent-msg__action"
        :aria-label="t(`${KB}.agent_copy`)"
        :title="t(`${KB}.agent_copy`)"
        @click="copyAnswer()"
      >
        <Copy :size="14" />
      </button>
      <button
        type="button"
        class="agent-msg__action"
        :aria-label="t(`${KB}.agent_share`)"
        :title="t(`${KB}.agent_share_soon`)"
        @click="pushNotice('agent_notice_share_soon')"
      >
        <Share2 :size="14" />
      </button>
      <button
        type="button"
        class="agent-msg__action"
        :aria-label="t(`${KB}.agent_resend`)"
        :title="t(`${KB}.agent_resend`)"
        @click="resend(message)"
      >
        <RotateCcw :size="14" />
      </button>
    </div>
  </article>
</template>
