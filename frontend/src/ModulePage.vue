<script setup lang="ts">
// 模块主列表页：概览 / 笔记增删 / 探活 / 意图 / 最近活动。
//
// 页面职责：只做展示与用户意图转发；数据与事件订阅由 `useModuleState` 单例承载，
// 页面挂载时 attach、卸载时 detach，避免重复请求与监听泄漏。
//
// 文案零硬编码：全部经 `t("module.demo-tools.*")`（三段键，i18n_namespace 为单段）。
// 图标只用 @lucide/vue；样式只消费 var(--copper-*) 令牌。

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  Activity,
  AlertTriangle,
  Info,
  Loader2,
  Pencil,
  Plus,
  PlugZap,
  RefreshCw,
  Send,
  StickyNote,
  Trash2,
} from "@lucide/vue";

import { useI18n } from "../../../CopperCore/frontend/src/i18n";
import { isDemoApiError, MODULE_ID, MODULE_I18N_NAMESPACE, type DemoNote } from "./api";
import { useModuleState } from "./composables/useModuleState";
import ModuleEmptyState from "./components/ModuleEmptyState.vue";
import ModuleListRow from "./components/ModuleListRow.vue";

const { t } = useI18n();
const router = useRouter();

const state = useModuleState();

// —— 笔记编辑表单 ——

const editingId = ref<number | null>(null);
const formTitle = ref("");
const formBody = ref("");
const formError = ref<string | null>(null);
const saving = ref(false);

// —— 操作反馈 ——

const pinging = ref(false);
const exposing = ref(false);
const deletingId = ref<number | null>(null);
/** 最近一次操作结果：`{ text, tone }`，tone 决定配色语义。 */
const feedback = ref<{ text: string; tone: "default" | "success" | "danger" } | null>(null);

/** 命令是否已确认不可用（未注册 / IPC 未就绪）。 */
const capabilityUnavailable = computed(() => state.capability.value === "unavailable");
/** 命令是否已确认可用。 */
const capabilityAvailable = computed(() => state.capability.value === "available");

/** 概览字段列表（未取到时用占位，避免空白）。 */
const overviewFields = computed(() => {
  const o = state.overview.value;
  const unknown = t("module.demo-tools.overview_unknown");
  return [
    { key: "overview_module_id", value: o?.id ?? MODULE_ID },
    { key: "overview_namespace", value: o?.i18nNamespace ?? MODULE_I18N_NAMESPACE },
    { key: "overview_version", value: o?.version ?? unknown },
    {
      key: "overview_loaded_modules",
      value: o ? String(o.loadedModules) : unknown,
    },
  ];
});

/** 概览中的意图清单。 */
const intents = computed(() => state.overview.value?.intents ?? []);

onMounted(async () => {
  await state.attachListeners();
  await state.refresh();
});

onUnmounted(() => {
  state.detachListeners();
});

/** 把异常转成可读文案（区分未注册 / IPC 不可用 / 后端业务错误）。 */
function describeError(e: unknown): string {
  if (isDemoApiError(e)) {
    if (e.kind === "not_registered") return t("module.demo-tools.error_not_registered");
    if (e.kind === "invoke_unavailable") return t("module.demo-tools.error_invoke_unavailable");
  }
  return e instanceof Error ? e.message : String(e);
}

/** 显示一条操作反馈。 */
function showFeedback(text: string, tone: "default" | "success" | "danger" = "default"): void {
  feedback.value = { text, tone };
}

/** 表单校验：标题非空且不超过 120 字符。 */
function validateForm(): boolean {
  const title = formTitle.value.trim();
  if (title.length === 0 || title.length > 120) {
    formError.value = t("module.demo-tools.notes_form_hint");
    return false;
  }
  formError.value = null;
  return true;
}

/** 新增或保存笔记。 */
async function submitNote(): Promise<void> {
  if (saving.value || !validateForm()) return;
  saving.value = true;
  try {
    const id = editingId.value ?? undefined;
    await state.upsertNote(formTitle.value.trim(), formBody.value.trim(), id);
    resetForm();
    showFeedback(t("module.demo-tools.result_note_saved"), "success");
  } catch (e) {
    showFeedback(t("module.demo-tools.result_failed", { message: describeError(e) }), "danger");
  } finally {
    saving.value = false;
  }
}

/** 清空表单并退出编辑态。 */
function resetForm(): void {
  editingId.value = null;
  formTitle.value = "";
  formBody.value = "";
  formError.value = null;
}

/** 载入某条笔记进入编辑态。 */
function startEdit(note: DemoNote): void {
  editingId.value = note.id;
  formTitle.value = note.title;
  formBody.value = note.body;
  formError.value = null;
}

/** 删除笔记（二次确认）。 */
async function deleteNote(note: DemoNote): Promise<void> {
  if (deletingId.value !== null) return;
  if (!window.confirm(t("module.demo-tools.notes_delete_confirm"))) return;
  deletingId.value = note.id;
  try {
    await state.removeNote(note.id);
    if (editingId.value === note.id) resetForm();
    showFeedback(t("module.demo-tools.result_note_deleted"), "success");
  } catch (e) {
    showFeedback(t("module.demo-tools.result_failed", { message: describeError(e) }), "danger");
  } finally {
    deletingId.value = null;
  }
}

/** 探活。 */
async function runPing(): Promise<void> {
  if (pinging.value) return;
  pinging.value = true;
  try {
    const echo = await state.ping();
    showFeedback(t("module.demo-tools.result_ping", { echo }), "success");
  } catch (e) {
    showFeedback(t("module.demo-tools.result_failed", { message: describeError(e) }), "danger");
  } finally {
    pinging.value = false;
  }
}

/** 发起 expose.version 意图。 */
async function runExposeVersion(): Promise<void> {
  if (exposing.value) return;
  exposing.value = true;
  try {
    const version = await state.requestExposeVersion();
    showFeedback(t("module.demo-tools.result_expose", { version }), "success");
  } catch (e) {
    showFeedback(t("module.demo-tools.result_failed", { message: describeError(e) }), "danger");
  } finally {
    exposing.value = false;
  }
}

/** 手动刷新（忽略 in-flight 合并）。 */
async function retry(): Promise<void> {
  feedback.value = null;
  await state.reload();
}

/** 打开笔记详情。 */
function openDetail(note: DemoNote): void {
  void router.push(`/demo-tools/detail/${note.id}`);
}

/** 时间格式化：非法时间原样返回，避免显示 Invalid Date。 */
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** 活动类型 → 徽标语义色。 */
function activityTone(kind: string): "default" | "success" | "warning" | "danger" | "info" {
  if (kind.includes("delete")) return "warning";
  if (kind.includes("ping")) return "info";
  if (kind.includes("upsert") || kind.includes("expose")) return "success";
  return "default";
}
</script>

<template>
  <div class="mod-demo">
    <!-- 页面级操作注入内核标题栏操作区 -->
    <Teleport to="#copper-titlebar-actions">
      <button
        class="mod-demo__input mod-demo__header-btn"
        type="button"
        :disabled="state.loading.value"
        @click="retry"
      >
        <RefreshCw :size="14" :class="{ 'mod-demo__spinner': state.loading.value }" />
        <span>{{ t('module.demo-tools.action_refresh') }}</span>
      </button>
    </Teleport>

    <header class="mod-demo__page-head">
      <div>
        <h1 class="mod-demo__page-title">{{ t('module.demo-tools.title') }}</h1>
        <p class="mod-demo__page-desc">{{ t('module.demo-tools.pageSubtitle') }}</p>
      </div>
    </header>

    <!-- 命令能力状态：如实展示，不假装可用 -->
    <section
      v-if="capabilityUnavailable"
      class="mod-demo__capability"
      aria-live="polite"
    >
      <AlertTriangle class="mod-demo__capability-icon" :size="18" />
      <div class="mod-demo__capability-text">
        <span class="mod-demo__capability-title">{{ t('module.demo-tools.capability_title') }}</span>
        <span class="mod-demo__capability-desc">{{ t('module.demo-tools.capability_desc') }}</span>
      </div>
    </section>

    <section v-else-if="capabilityAvailable" class="mod-demo__result mod-demo__result--success">
      <Info :size="16" />
      <span>{{ t('module.demo-tools.capability_available_desc') }}</span>
    </section>

    <section v-else class="mod-demo__result">
      <Info :size="16" />
      <span>{{ t('module.demo-tools.capability_unknown_desc') }}</span>
    </section>

    <!-- 错误态：失败原因可见 + 重试 -->
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

    <div class="mod-demo__grid">
      <!-- 概览 -->
      <section class="mod-demo__card">
        <div class="mod-demo__card-head">
          <h2 class="mod-demo__card-title">
            <Info class="mod-demo__card-title-icon" :size="16" />
            <span>{{ t('module.demo-tools.overview_title') }}</span>
          </h2>
        </div>

        <div v-if="state.loading.value && !state.overview.value" class="mod-demo__skeleton">
          <div class="mod-demo__skeleton-line" />
          <div class="mod-demo__skeleton-line mod-demo__skeleton-line--short" />
          <div class="mod-demo__skeleton-line" />
        </div>

        <dl v-else class="mod-demo__fields">
          <template v-for="field in overviewFields" :key="field.key">
            <dt class="mod-demo__field-label">{{ t(`module.demo-tools.${field.key}`) }}</dt>
            <dd class="mod-demo__field-value mod-demo__mono">{{ field.value }}</dd>
          </template>
        </dl>

        <div>
          <p class="mod-demo__field-label">{{ t('module.demo-tools.overview_intents') }}</p>
          <div v-if="intents.length > 0" class="mod-demo__chips">
            <span v-for="intent in intents" :key="intent" class="mod-demo__chip">{{ intent }}</span>
          </div>
          <p v-else class="mod-demo__editor-hint">
            {{ t('module.demo-tools.overview_intents_empty') }}
          </p>
        </div>

        <div class="mod-demo__editor-actions">
          <button
            class="mod-demo__input mod-demo__header-btn"
            type="button"
            :disabled="pinging"
            @click="runPing"
          >
            <Loader2 v-if="pinging" class="mod-demo__spinner" :size="14" />
            <PlugZap v-else :size="14" />
            <span>{{ pinging ? t('module.demo-tools.busy_ping') : t('module.demo-tools.action_ping') }}</span>
          </button>
          <button
            class="mod-demo__input mod-demo__header-btn"
            type="button"
            :disabled="exposing"
            @click="runExposeVersion"
          >
            <Loader2 v-if="exposing" class="mod-demo__spinner" :size="14" />
            <Send v-else :size="14" />
            <span>{{
              exposing ? t('module.demo-tools.busy_expose') : t('module.demo-tools.action_expose_version')
            }}</span>
          </button>
        </div>

        <p v-if="feedback" :class="['mod-demo__result', `mod-demo__result--${feedback.tone}`]">
          {{ feedback.text }}
        </p>

        <p class="mod-demo__footer-note">{{ t('module.demo-tools.footer_note') }}</p>
      </section>

      <!-- 笔记列表 -->
      <section class="mod-demo__card">
        <div class="mod-demo__card-head">
          <h2 class="mod-demo__card-title">
            <StickyNote class="mod-demo__card-title-icon" :size="16" />
            <span>{{ t('module.demo-tools.notes_title') }}</span>
          </h2>
          <span class="mod-demo__chip mod-demo__chip--muted">
            {{ t('module.demo-tools.notes_count', { count: state.noteCount.value }) }}
          </span>
        </div>

        <div class="mod-demo__editor">
          <p v-if="editingId !== null" class="mod-demo__editor-hint">
            {{ t('module.demo-tools.notes_editing', { id: editingId }) }}
          </p>
          <input
            v-model="formTitle"
            class="mod-demo__input"
            type="text"
            maxlength="120"
            :placeholder="t('module.demo-tools.notes_form_title_placeholder')"
          />
          <textarea
            v-model="formBody"
            class="mod-demo__textarea"
            :placeholder="t('module.demo-tools.notes_form_body_placeholder')"
          />
          <p v-if="formError" class="mod-demo__result mod-demo__result--danger">{{ formError }}</p>
          <div class="mod-demo__editor-actions">
            <button
              class="mod-demo__input mod-demo__header-btn"
              type="button"
              :disabled="saving"
              @click="submitNote"
            >
              <Loader2 v-if="saving" class="mod-demo__spinner" :size="14" />
              <Plus v-else-if="editingId === null" :size="14" />
              <Pencil v-else :size="14" />
              <span>{{
                saving
                  ? t('module.demo-tools.busy_saving')
                  : editingId === null
                    ? t('module.demo-tools.action_create_note')
                    : t('module.demo-tools.action_save_note')
              }}</span>
            </button>
            <button
              v-if="editingId !== null"
              class="mod-demo__input mod-demo__header-btn"
              type="button"
              @click="resetForm"
            >
              <span>{{ t('module.demo-tools.action_cancel') }}</span>
            </button>
          </div>
          <p class="mod-demo__editor-hint">{{ t('module.demo-tools.notes_form_hint') }}</p>
        </div>

        <div v-if="state.loading.value && state.notes.value.length === 0" class="mod-demo__skeleton">
          <div class="mod-demo__skeleton-line" />
          <div class="mod-demo__skeleton-line mod-demo__skeleton-line--short" />
        </div>

        <ModuleEmptyState
          v-else-if="state.notes.value.length === 0"
          :icon="StickyNote"
          :title="t('module.demo-tools.notes_empty_title')"
          :description="t('module.demo-tools.notes_empty_desc')"
          compact
        />

        <ul v-else class="mod-demo__list mod-demo__list-scroll">
          <li v-for="note in state.notes.value" :key="note.id">
            <ModuleListRow
              :title="note.title"
              :subtitle="note.body || t('module.demo-tools.detail_body_empty')"
              :icon="StickyNote"
              clickable
              @select="openDetail(note)"
            >
              <template #actions>
                <button
                  class="mod-demo__input mod-demo__header-btn"
                  type="button"
                  :title="t('module.demo-tools.action_edit_note')"
                  @click.stop="startEdit(note)"
                >
                  <Pencil :size="14" />
                </button>
                <button
                  class="mod-demo__input mod-demo__header-btn"
                  type="button"
                  :disabled="deletingId === note.id"
                  :title="t('module.demo-tools.action_delete_note')"
                  @click.stop="deleteNote(note)"
                >
                  <Loader2 v-if="deletingId === note.id" class="mod-demo__spinner" :size="14" />
                  <Trash2 v-else :size="14" />
                </button>
              </template>
            </ModuleListRow>
          </li>
        </ul>
      </section>

      <!-- 最近活动 -->
      <section class="mod-demo__card">
        <div class="mod-demo__card-head">
          <h2 class="mod-demo__card-title">
            <Activity class="mod-demo__card-title-icon" :size="16" />
            <span>{{ t('module.demo-tools.activity_title') }}</span>
          </h2>
        </div>
        <p class="mod-demo__editor-hint">{{ t('module.demo-tools.activity_live_hint') }}</p>

        <ModuleEmptyState
          v-if="state.activities.value.length === 0"
          :icon="Activity"
          :title="t('module.demo-tools.activity_empty_title')"
          :description="t('module.demo-tools.activity_empty_desc')"
          compact
        />

        <ul v-else class="mod-demo__list mod-demo__list-scroll">
          <li v-for="(item, index) in state.activities.value" :key="`${item.at}-${index}`">
            <ModuleListRow
              :title="item.message"
              :subtitle="item.kind"
              :icon="Activity"
              :badge="item.kind"
              :badge-tone="activityTone(item.kind)"
            >
              <template #actions>
                <span class="mod-demo__activity-time">{{ formatTime(item.at) }}</span>
              </template>
            </ModuleListRow>
          </li>
        </ul>

        <div>
          <p class="mod-demo__field-label">{{ t('module.demo-tools.kernel_event_title') }}</p>
          <p class="mod-demo__editor-hint">
            {{
              state.lastDownloadStatus.value ?? t('module.demo-tools.kernel_event_empty')
            }}
          </p>
          <p class="mod-demo__editor-hint">{{ t('module.demo-tools.kernel_event_hint') }}</p>
        </div>
      </section>
    </div>
  </div>
</template>
