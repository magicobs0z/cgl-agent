<script setup lang="ts">
// 助手设置面板：provider / 模型 / API 地址 / API Key。
//
// 安全约定（见设计文档「运行时与进程模型」）：
// - API Key 只存内核安全存储，由内核下发给它监管的 Node 会话；
// - 面板**不回显**已保存明文，只显示「已配置」状态，并提供替换与删除；
// - 提交后立即清空输入缓冲：Key 不进入模块存储、普通设置、前端持久化或日志；
// - 当前平台不支持安全凭证存储时，Key 相关操作禁用并如实说明。

import { computed, ref } from "vue";
import { KeyRound, Save, ShieldAlert, Trash2, X } from "@lucide/vue";

import { useI18n } from "./i18n";
import { useAgentChat } from "./useAgentChat";

const KB = "module.demo-tools";
const { t } = useI18n();
const { settingsOpen, capabilities, model, saveSettings, clearApiKey } = useAgentChat();

const provider = ref(model.value?.provider ?? "");
const modelName = ref(model.value?.name ?? "");
const apiBase = ref("");
const apiKey = ref("");
const submitting = ref(false);

const credentialLocked = computed(() => capabilities.value.credentialStorageUnsupported);

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await saveSettings({
      provider: provider.value.trim(),
      model: modelName.value.trim(),
      apiBase: apiBase.value.trim(),
      apiKey: apiKey.value,
    });
  } finally {
    // 无论成功与否都不保留 Key 明文。
    apiKey.value = "";
    submitting.value = false;
  }
}

async function removeKey(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await clearApiKey();
  } finally {
    apiKey.value = "";
    submitting.value = false;
  }
}
</script>

<template>
  <aside class="agent-settings" role="dialog" :aria-label="t(`${KB}.agent_settings`)">
    <header class="agent-settings__head">
      <h3 class="agent-settings__title">{{ t(`${KB}.agent_settings_title`) }}</h3>
      <button
        type="button"
        class="agent-settings__close"
        :aria-label="t(`${KB}.agent_close`)"
        :title="t(`${KB}.agent_close`)"
        @click="settingsOpen = false"
      >
        <X :size="16" />
      </button>
    </header>

    <p v-if="credentialLocked" class="agent-settings__warn">
      <ShieldAlert :size="14" />
      <span>{{ t(`${KB}.agent_state_credential_unsupported_title`) }}</span>
    </p>

    <label class="agent-settings__field">
      <span class="agent-settings__label">{{ t(`${KB}.agent_settings_provider`) }}</span>
      <input v-model="provider" type="text" class="agent-settings__input" autocomplete="off" />
    </label>

    <label class="agent-settings__field">
      <span class="agent-settings__label">{{ t(`${KB}.agent_settings_model`) }}</span>
      <input v-model="modelName" type="text" class="agent-settings__input" autocomplete="off" />
    </label>

    <label class="agent-settings__field">
      <span class="agent-settings__label">{{ t(`${KB}.agent_settings_api_base`) }}</span>
      <input
        v-model="apiBase"
        type="text"
        class="agent-settings__input"
        autocomplete="off"
        placeholder="https://"
      />
    </label>

    <div class="agent-settings__field">
      <span class="agent-settings__label">{{ t(`${KB}.agent_settings_api_key`) }}</span>
      <div class="agent-settings__key-row">
        <KeyRound :size="14" class="agent-settings__key-icon" />
        <input
          v-model="apiKey"
          type="password"
          class="agent-settings__input agent-settings__input--key"
          autocomplete="new-password"
          :disabled="credentialLocked"
          :placeholder="
            capabilities.apiKeyConfigured
              ? t(`${KB}.agent_settings_api_key_replace_placeholder`)
              : t(`${KB}.agent_settings_api_key_placeholder`)
          "
        />
      </div>
      <p class="agent-settings__status">
        {{
          capabilities.apiKeyConfigured
            ? t(`${KB}.agent_settings_api_key_configured`)
            : t(`${KB}.agent_settings_api_key_absent`)
        }}
      </p>
    </div>

    <div class="agent-settings__actions">
      <button
        type="button"
        class="agent-settings__btn agent-settings__btn--primary"
        :disabled="submitting"
        @click="submit()"
      >
        <Save :size="14" />
        <span>
          {{
            capabilities.apiKeyConfigured
              ? t(`${KB}.agent_settings_replace`)
              : t(`${KB}.agent_settings_save`)
          }}
        </span>
      </button>
      <button
        type="button"
        class="agent-settings__btn"
        :disabled="submitting || credentialLocked"
        @click="removeKey()"
      >
        <Trash2 :size="14" />
        <span>{{ t(`${KB}.agent_settings_delete`) }}</span>
      </button>
    </div>
  </aside>
</template>
