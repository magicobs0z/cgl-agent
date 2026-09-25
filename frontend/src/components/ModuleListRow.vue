<script setup lang="ts">
// 通用列表行：左侧标题 + 副标题，右侧操作插槽。
// 供笔记列表与活动列表复用；样式只消费主题令牌。

import type { Component } from "vue";

withDefaults(
  defineProps<{
    /** 行主标题（已翻译或数据本身）。 */
    title: string;
    /** 行副标题（可选）。 */
    subtitle?: string;
    /** 行首图标（可选）。 */
    icon?: Component | null;
    /** 行尾标签文本（可选，如状态徽标）。 */
    badge?: string;
    /** 徽标语义色。 */
    badgeTone?: "default" | "success" | "warning" | "danger" | "info";
    /** 是否可点击（有 click 监听时生效）。 */
    clickable?: boolean;
  }>(),
  { subtitle: "", icon: null, badge: "", badgeTone: "default", clickable: false },
);

const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <div
    :class="['module-row', { 'module-row--clickable': clickable }]"
    :role="clickable ? 'button' : undefined"
    :tabindex="clickable ? 0 : undefined"
    @click="clickable && emit('select')"
    @keydown.enter="clickable && emit('select')"
    @keydown.space.prevent="clickable && emit('select')"
  >
    <component
      :is="icon"
      v-if="icon"
      class="module-row__icon"
      :size="16"
      :stroke-width="1.75"
      aria-hidden="true"
    />

    <div class="module-row__body">
      <div class="module-row__head">
        <span class="module-row__title">{{ title }}</span>
        <span v-if="badge" :class="['module-row__badge', `module-row__badge--${badgeTone}`]">
          {{ badge }}
        </span>
      </div>
      <p v-if="subtitle" class="module-row__subtitle">{{ subtitle }}</p>
    </div>

    <div v-if="$slots.actions" class="module-row__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.module-row {
  display: flex;
  align-items: flex-start;
  gap: var(--copper-space-3);
  padding: var(--copper-space-3);
  border: 1px solid var(--copper-border);
  border-radius: var(--copper-radius-md);
  background: var(--copper-surface-2);
  transition:
    background-color var(--copper-duration-fast) var(--copper-easing),
    border-color var(--copper-duration-fast) var(--copper-easing);
}

.module-row--clickable {
  cursor: pointer;
}

.module-row--clickable:hover {
  background: var(--copper-surface-3);
  border-color: color-mix(in srgb, var(--copper-accent) 35%, var(--copper-border));
}

.module-row--clickable:focus-visible {
  outline: 2px solid var(--copper-accent);
  outline-offset: 1px;
}

.module-row__icon {
  color: var(--copper-text-secondary);
  flex-shrink: 0;
  margin-top: 1px;
}

.module-row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--copper-space-1);
}

.module-row__head {
  display: flex;
  align-items: center;
  gap: var(--copper-space-2);
  min-width: 0;
}

.module-row__title {
  color: var(--copper-text);
  font-size: var(--copper-font-size-md);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-row__badge {
  flex-shrink: 0;
  padding: 1px var(--copper-space-2);
  border-radius: var(--copper-radius-full);
  font-size: var(--copper-font-size-xs);
  border: 1px solid var(--copper-border);
  color: var(--copper-text-secondary);
}

.module-row__badge--success {
  color: var(--copper-success);
  border-color: color-mix(in srgb, var(--copper-success) 45%, transparent);
  background: color-mix(in srgb, var(--copper-success) 12%, transparent);
}

.module-row__badge--warning {
  color: var(--copper-warning);
  border-color: color-mix(in srgb, var(--copper-warning) 45%, transparent);
  background: color-mix(in srgb, var(--copper-warning) 12%, transparent);
}

.module-row__badge--danger {
  color: var(--copper-danger);
  border-color: color-mix(in srgb, var(--copper-danger) 45%, transparent);
  background: color-mix(in srgb, var(--copper-danger) 12%, transparent);
}

.module-row__badge--info {
  color: var(--copper-info);
  border-color: color-mix(in srgb, var(--copper-info) 45%, transparent);
  background: color-mix(in srgb, var(--copper-info) 12%, transparent);
}

.module-row__subtitle {
  color: var(--copper-text-secondary);
  font-size: var(--copper-font-size-sm);
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.module-row__actions {
  display: flex;
  align-items: center;
  gap: var(--copper-space-1);
  flex-shrink: 0;
}
</style>
