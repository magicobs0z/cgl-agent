<script setup lang="ts">
// 笔记详情页（路由 /demo-tools/detail/:id，meta 由 register.ts 声明）。
//
// 数据取自 `useModuleState` 单例：优先用已加载的列表命中，未命中时主动刷新一次，
// 仍无结果则展示空状态（笔记可能已被删除）。

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, StickyNote } from "@lucide/vue";

import { useI18n } from "../../../CopperCore/frontend/src/i18n";
import { isDemoApiError } from "./api";
import { useModuleState } from "./composables/useModuleState";
import ModuleEmptyState from "./components/ModuleEmptyState.vue";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const state = useModuleState();

const refreshing = ref(false);
/** 是否已完成至少一次「针对该 id」的加载尝试。 */
const resolved = ref(false);

/** 路由参数中的笔记 id。 */
const noteId = computed(() => {
  const raw = route.params.id;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
});

/** 命中的笔记；id 非法或未命中时为 null。 */
const note = computed(() => {
  if (noteId.value === null) return null;
  return state.notes.value.find((n) => n.id === noteId.value) ?? null;
});

onMounted(async () => {
  await state.attachListeners();
  if (state.notes.value.length === 0) {
    await state.refresh();
  }
  resolved.value = true;
});

onUnmounted(() => {
  state.detachListeners();
});

/** 手动刷新当前笔记。 */
async function retry(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await state.reload();
    resolved.value = true;
  } finally {
    refreshing.value = false;
  }
}

/** 返回列表页。 */
function goBack(): void {
  void router.push("/demo-tools");
}

/** 把异常转成可读文案。 */
function describeError(e: unknown): string {
  if (isDemoApiError(e)) {
    if (e.kind === "not_registered") return t("module.demo-tools.error_not_registered");
    if (e.kind === "invoke_unavailable") return t("module.demo-tools.error_invoke_unavailable");
  }
  return e instanceof Error ? e.message : String(e);
}

/** 时间格式化。 */
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
</script>

<template>
  <div class="mod-demo">
    <Teleport to="#copper-titlebar-actions">
      <button
        class="mod-demo__input mod-demo__header-btn"
        type="button"
        :disabled="refreshing"
        @click="retry"
      >
        <Loader2 v-if="refreshing" class="mod-demo__spinner" :size="14" />
        <RefreshCw v-else :size="14" />
        <span>{{ t('module.demo-tools.action_refresh') }}</span>
      </button>
    </Teleport>

    <div class="mod-demo__detail">
      <button class="mod-demo__input mod-demo__header-btn mod-demo__detail-back" type="button" @click="goBack">
        <ArrowLeft :size="14" />
        <span>{{ t('module.demo-tools.action_back') }}</span>
      </button>

      <header class="mod-demo__page-head">
        <div>
          <h1 class="mod-demo__page-title">{{ t('module.demo-tools.detail') }}</h1>
          <p class="mod-demo__page-desc">
            {{ t('module.demo-tools.overview_module_id') }}：{{ noteId ?? t('module.demo-tools.overview_unknown') }}
          </p>
        </div>
      </header>

      <!-- 错误态 -->
      <section v-if="state.loadError.value" class="mod-demo__error" aria-live="assertive">
        <AlertTriangle class="mod-demo__error-icon" :size="18" />
        <div class="mod-demo__error-body">
          <span class="mod-demo__error-title">{{ t('module.demo-tools.error_title') }}</span>
          <span class="mod-demo__error-detail">{{ describeError(state.loadError.value) }}</span>
        </div>
        <button class="mod-demo__input mod-demo__header-btn" type="button" @click="retry">
          <RefreshCw :size="14" />
          <span>{{ t('module.demo-tools.action_retry') }}</span>
        </button>
      </section>

      <!-- 加载态 -->
      <section v-if="!resolved || (state.loading.value && !note)" class="mod-demo__card">
        <div class="mod-demo__skeleton">
          <div class="mod-demo__skeleton-line mod-demo__skeleton-line--short" />
          <div class="mod-demo__skeleton-line" />
          <div class="mod-demo__skeleton-line" />
        </div>
      </section>

      <!-- 空状态：未命中 -->
      <section v-else-if="!note" class="mod-demo__card">
        <ModuleEmptyState
          :icon="StickyNote"
          :title="t('module.demo-tools.detail_missing_title')"
          :description="t('module.demo-tools.detail_missing_desc')"
        >
          <button class="mod-demo__input mod-demo__header-btn" type="button" @click="goBack">
            <ArrowLeft :size="14" />
            <span>{{ t('module.demo-tools.action_back') }}</span>
          </button>
        </ModuleEmptyState>
      </section>

      <!-- 详情 -->
      <section v-else class="mod-demo__card">
        <div class="mod-demo__card-head">
          <h2 class="mod-demo__card-title">
            <StickyNote class="mod-demo__card-title-icon" :size="16" />
            <span>{{ note.title }}</span>
          </h2>
          <span class="mod-demo__chip mod-demo__chip--muted mod-demo__mono">#{{ note.id }}</span>
        </div>

        <dl class="mod-demo__fields">
          <dt class="mod-demo__field-label">{{ t('module.demo-tools.detail_id') }}</dt>
          <dd class="mod-demo__field-value mod-demo__mono">{{ note.id }}</dd>

          <dt class="mod-demo__field-label">{{ t('module.demo-tools.detail_title_label') }}</dt>
          <dd class="mod-demo__field-value">{{ note.title }}</dd>

          <dt class="mod-demo__field-label">{{ t('module.demo-tools.detail_body_label') }}</dt>
          <dd class="mod-demo__field-value">
            {{ note.body || t('module.demo-tools.detail_body_empty') }}
          </dd>

          <dt class="mod-demo__field-label">{{ t('module.demo-tools.detail_created_at') }}</dt>
          <dd class="mod-demo__field-value mod-demo__mono">{{ formatTime(note.createdAt) }}</dd>

          <dt class="mod-demo__field-label">{{ t('module.demo-tools.detail_updated_at') }}</dt>
          <dd class="mod-demo__field-value mod-demo__mono">{{ formatTime(note.updatedAt) }}</dd>
        </dl>

        <p class="mod-demo__field-label">{{ t('module.demo-tools.detail_fields_title') }}</p>
        <p class="mod-demo__footer-note">{{ t('module.demo-tools.footer_note') }}</p>
      </section>
    </div>
  </div>
</template>
