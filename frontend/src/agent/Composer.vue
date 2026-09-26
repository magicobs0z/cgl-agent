<script setup lang="ts">
// 底部输入栏：多行输入 + `/` 命令入口 + 权限模式 + 模型 + 发送/停止。
//
// 规则（见设计文档「底部输入栏」）：Enter 发送、Shift+Enter 换行；宽度居中并设最大宽度；
// 生成中发送按钮切换为停止。命令清单取自 Pi 实际暴露的命令，加载不到时如实显示未接入，
// 不硬编码命令表；权限模式切换自动执行 / 手动审批，具体粒度以 Pi 权限能力为准。

import { computed, nextTick, ref } from "vue";
import { ChevronDown, Send, Settings, ShieldCheck, Slash, Square, Zap } from "@lucide/vue";

import { useI18n } from "./i18n";
import { useAgentChat } from "./useAgentChat";
import CommandPalette, { type PiCommandItem } from "./CommandPalette.vue";

const KB = "module.demo-tools";
const { t } = useI18n();
const {
  model,
  running,
  approvalMode,
  capabilities,
  settingsOpen,
  loadCommands,
  send,
  cancel,
} = useAgentChat();

const text = ref("");
const input = ref<HTMLTextAreaElement | null>(null);

const paletteOpen = ref(false);
const paletteState = ref<"loading" | "ready" | "unavailable">("loading");
const paletteDetail = ref<string | undefined>(undefined);
const commands = ref<PiCommandItem[]>([]);
const highlighted = ref(0);

/** `/` 之后的查询串。 */
const query = computed(() => (text.value.startsWith("/") ? text.value.slice(1) : ""));

const filtered = computed<PiCommandItem[]>(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return commands.value;
  return commands.value.filter(
    (c) => c.name.toLowerCase().includes(keyword) || c.description.toLowerCase().includes(keyword),
  );
});

const paletteEmpty = computed(
  () => paletteState.value === "ready" && filtered.value.length === 0,
);

async function openPalette(): Promise<void> {
  paletteOpen.value = true;
  highlighted.value = 0;
  if (paletteState.value === "ready") return;
  paletteState.value = "loading";
  const result = await loadCommands();
  if (result.ok) {
    commands.value = result.commands;
    paletteState.value = "ready";
  } else {
    commands.value = [];
    paletteState.value = "unavailable";
    paletteDetail.value = result.detail;
  }
}

function closePalette(): void {
  paletteOpen.value = false;
}

function focusInput(): void {
  void nextTick(() => input.value?.focus());
}

function selectCommand(index: number): void {
  const command = filtered.value[index];
  if (!command) return;
  text.value = `/${command.name} `;
  closePalette();
  focusInput();
}

/** 输入变化：以 `/` 开头即展开命令列表，否则收起。 */
function onInput(): void {
  if (text.value.startsWith("/")) {
    if (!paletteOpen.value) void openPalette();
  } else if (paletteOpen.value) {
    closePalette();
  }
}

async function submit(): Promise<void> {
  const prompt = text.value.trim();
  if (!prompt || running.value) return;
  text.value = "";
  closePalette();
  await send(prompt);
}

function onKeydown(event: KeyboardEvent): void {
  if (paletteOpen.value) {
    const count = filtered.value.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlighted.value = count === 0 ? 0 : (highlighted.value + 1) % count;
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      highlighted.value = count === 0 ? 0 : (highlighted.value - 1 + count) % count;
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (count > 0) selectCommand(highlighted.value);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
}

/** 左下角 `/` 入口：无内容时填入 `/` 以触发列表。 */
function triggerCommands(): void {
  if (!text.value.startsWith("/")) text.value = `/${query.value}`;
  void openPalette();
  focusInput();
}

function toggleApprovalMode(): void {
  approvalMode.value = approvalMode.value === "manual" ? "auto" : "manual";
}
</script>

<template>
  <footer class="agent-composer">
    <div class="agent-composer__card">
      <CommandPalette
        v-if="paletteOpen"
        :state="paletteState"
        :empty="paletteEmpty"
        :items="filtered"
        :highlighted="highlighted"
        :detail="paletteDetail"
        @select="selectCommand"
        @close="closePalette"
      />

      <textarea
        ref="input"
        v-model="text"
        class="agent-composer__input"
        rows="3"
        :placeholder="t(`${KB}.agent_input_placeholder`)"
        :aria-label="t(`${KB}.agent_input_placeholder`)"
        @input="onInput"
        @keydown="onKeydown"
      />

      <div class="agent-composer__row">
        <button
          type="button"
          class="agent-composer__chip"
          :aria-label="t(`${KB}.agent_command`)"
          :title="t(`${KB}.agent_command_hint`)"
          @click="triggerCommands()"
        >
          <Slash :size="14" />
        </button>

        <button
          type="button"
          class="agent-composer__chip agent-composer__chip--wide"
          :title="t(`${KB}.agent_approval_title`)"
          @click="toggleApprovalMode()"
        >
          <component :is="approvalMode === 'manual' ? ShieldCheck : Zap" :size="14" />
          <span>
            {{
              approvalMode === "manual"
                ? t(`${KB}.agent_approval_manual`)
                : t(`${KB}.agent_approval_auto`)
            }}
          </span>
        </button>

        <button
          type="button"
          class="agent-composer__chip agent-composer__chip--model"
          :class="{ 'agent-composer__chip--warn': !model }"
          :title="model ? t(`${KB}.agent_model`) : t(`${KB}.agent_model_unconfigured`)"
          @click="settingsOpen = true"
        >
          <span v-if="model">{{ model.name }}</span>
          <span v-else>{{ t(`${KB}.agent_model_go_settings`) }}</span>
          <ChevronDown :size="12" />
        </button>

        <button
          v-if="running"
          type="button"
          class="agent-composer__send agent-composer__send--stop"
          :aria-label="t(`${KB}.agent_stop`)"
          :title="t(`${KB}.agent_stop`)"
          @click="cancel()"
        >
          <Square :size="15" />
        </button>
        <button
          v-else
          type="button"
          class="agent-composer__send"
          :disabled="!text.trim()"
          :aria-label="t(`${KB}.agent_send`)"
          :title="t(`${KB}.agent_send`)"
          @click="submit()"
        >
          <Send :size="15" />
        </button>
      </div>

      <p v-if="!capabilities.apiKeyConfigured" class="agent-composer__hint agent-composer__hint--warn">
        <Settings :size="12" />
        <span>{{ t(`${KB}.agent_state_no_api_key_title`) }}</span>
        <button type="button" class="agent-composer__hint-link" @click="settingsOpen = true">
          {{ t(`${KB}.agent_open_settings`) }}
        </button>
      </p>
      <p v-else class="agent-composer__hint">{{ t(`${KB}.agent_press_enter`) }}</p>
    </div>
  </footer>
</template>
