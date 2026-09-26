<script setup lang="ts">
// `/` 命令列表浮层（纯展示）。
//
// 命令清单必须来自 Pi 实际暴露的命令，因此列表由调用方（输入栏）经后端加载后传入；
// 本组件不硬编码任何命令，也不编造审批语义。加载不到时显示未接入态。

import { LoaderCircle, Search, Slash } from "@lucide/vue";

import { useI18n } from "./i18n";

/** 一条 Pi 命令。 */
export interface PiCommandItem {
  name: string;
  description: string;
}

const props = defineProps<{
  state: "loading" | "ready" | "unavailable";
  /** 是否已在输入 `/` 但无匹配结果。 */
  empty: boolean;
  items: PiCommandItem[];
  highlighted: number;
  detail?: string;
}>();

defineEmits<{ select: [index: number]; close: [] }>();

const KB = "module.demo-tools";
const { t } = useI18n();
</script>

<template>
  <div class="agent-palette" role="listbox" :aria-label="t(`${KB}.agent_command`)">
    <p v-if="props.state === 'loading'" class="agent-palette__state">
      <LoaderCircle :size="14" class="agent-spin" />
      <span>{{ t(`${KB}.agent_loading`) }}</span>
    </p>

    <div v-else-if="props.state === 'unavailable'" class="agent-palette__state agent-palette__state--block">
      <Slash :size="14" />
      <div>
        <p class="agent-palette__state-title">{{ t(`${KB}.agent_command_unavailable_title`) }}</p>
        <p class="agent-palette__state-desc">{{ t(`${KB}.agent_command_unavailable_desc`) }}</p>
        <p v-if="props.detail" class="agent-palette__state-detail">{{ props.detail }}</p>
      </div>
    </div>

    <div v-else-if="props.empty" class="agent-palette__state">
      <Search :size="14" />
      <span>{{ t(`${KB}.agent_command_no_match`) }}</span>
    </div>

    <ul v-else class="agent-palette__list">
      <li v-for="(item, index) in props.items" :key="item.name">
        <button
          type="button"
          class="agent-palette__item"
          :class="{ 'agent-palette__item--active': index === props.highlighted }"
          role="option"
          :aria-selected="index === props.highlighted"
          @click="$emit('select', index)"
        >
          <span class="agent-palette__name">/{{ item.name }}</span>
          <span class="agent-palette__desc">{{ item.description }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
