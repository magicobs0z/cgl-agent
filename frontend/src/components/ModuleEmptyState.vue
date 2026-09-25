<script setup lang="ts">
// 通用空状态：图标 + 主文案 + 可选说明 + 可选操作插槽。
// 文案一律经 i18n 键传入（调用方 t()），组件内部零硬编码文案。

import type { Component } from "vue";

withDefaults(
  defineProps<{
    icon: Component;
    /** 主文案（已翻译）。 */
    title: string;
    /** 说明文案（已翻译，可选）。 */
    description?: string;
    /** 紧凑模式：用于卡片内的小块空态。 */
    compact?: boolean;
  }>(),
  { description: "", compact: false },
);
</script>

<template>
  <div :class="['module-empty', { 'module-empty--compact': compact }]" role="status">
    <component :is="icon" class="module-empty__icon" :size="compact ? 24 : 36" :stroke-width="1.5" />
    <p class="module-empty__title">{{ title }}</p>
    <p v-if="description" class="module-empty__description">{{ description }}</p>
    <div v-if="$slots.default" class="module-empty__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.module-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--copper-space-2);
  padding: var(--copper-space-6) var(--copper-space-4);
  text-align: center;
}

.module-empty--compact {
  gap: var(--copper-space-1);
  padding: var(--copper-space-4) var(--copper-space-3);
}

.module-empty__icon {
  color: var(--copper-text-disabled);
  margin-bottom: var(--copper-space-1);
}

.module-empty__title {
  color: var(--copper-text-secondary);
  font-size: var(--copper-font-size-md);
  font-weight: 500;
}

.module-empty__description {
  color: var(--copper-text-disabled);
  font-size: var(--copper-font-size-sm);
  max-width: 42ch;
  line-height: 1.5;
}

.module-empty__actions {
  display: flex;
  align-items: center;
  gap: var(--copper-space-2);
  margin-top: var(--copper-space-2);
}
</style>
