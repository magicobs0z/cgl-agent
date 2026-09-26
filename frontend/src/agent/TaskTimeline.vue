<script setup lang="ts">
// 任务时间线：按真实时序交错渲染章节行、推理文本、工具行与审批行。
//
// 层级用字色与缩进表达，不使用气泡与卡片堆叠；工具区左侧一条细线贯穿并承载图标
// （见设计文档「对话流」）。折叠态按会话隔离存放于 useAgentChat，切换会话不串。

import { computed, ref } from "vue";
import {
  ArrowDown,
  Ban,
  Brain,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Compass,
  Cpu,
  FileText,
  Info,
  LoaderCircle,
  Search,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from "@lucide/vue";

import { useI18n } from "./i18n";
import { useAgentChat } from "./useAgentChat";
import type { TimelineBlock, ToolCall } from "./types";

const props = defineProps<{ blocks: TimelineBlock[] }>();

const KB = "module.demo-tools";
const { t } = useI18n();
const { isSectionExpanded, toggleSection, respondApproval } = useAgentChat();

/** 折叠的章节会隐藏其后续内容，直到下一个章节行。 */
const visibleBlocks = computed<TimelineBlock[]>(() => {
  const out: TimelineBlock[] = [];
  let hidden = false;
  for (const block of props.blocks) {
    if (block.kind === "section") {
      hidden = !isSectionExpanded(block.id);
      out.push(block);
      continue;
    }
    if (!hidden) out.push(block);
  }
  return out;
});

/** 聚合行默认折叠为数量摘要，展开后逐个显示子项。 */
const expandedGroups = ref<Record<string, boolean>>({});
/** 失败项的错误详情默认折叠。 */
const expandedErrors = ref<Record<string, boolean>>({});

function toggleGroup(id: string): void {
  expandedGroups.value = { ...expandedGroups.value, [id]: !expandedGroups.value[id] };
}

function toggleError(id: string): void {
  expandedErrors.value = { ...expandedErrors.value, [id]: !expandedErrors.value[id] };
}

/** 工具名 → 图标；未收录的工具用通用扳手图标。 */
const TOOL_ICONS: Record<string, unknown> = {
  cgl_launcher_info: Info,
  cgl_versions: FileText,
  cgl_version_detail: FileText,
  cgl_game_install_status: ClipboardCheck,
  cgl_downloads: ArrowDown,
  cgl_settings_snapshot: Settings2,
  cgl_mod_search: Search,
  cgl_mod_detail: FileText,
  cgl_launch_status: Cpu,
  cgl_logs: FileText,
  cgl_web_search: Search,
  cgl_web_fetch: Search,
};

function toolIcon(name: string): unknown {
  return TOOL_ICONS[name] ?? Wrench;
}

/** 动作描述取语言包中的工具条目；未收录时退回工具名，不编造描述。 */
function toolLabel(call: ToolCall): string {
  const key = `${KB}.tool_${call.name}`;
  const text = t(key, { target: call.target ?? "" });
  return text === key ? call.name : text;
}

function statusLabel(status: ToolCall["status"]): string | null {
  if (status === "failed") return t(`${KB}.agent_tool_failed`);
  if (status === "denied") return t(`${KB}.agent_tool_denied`);
  if (status === "awaiting-approval") return t(`${KB}.agent_tool_awaiting`);
  return null;
}
</script>

<template>
  <div class="agent-timeline">
    <template v-for="block in visibleBlocks" :key="block.id">
      <!-- 章节行 -->
      <div v-if="block.kind === 'section'" class="agent-timeline__section">
        <button type="button" class="agent-timeline__section-btn" @click="toggleSection(block.id)">
          <component
            :is="isSectionExpanded(block.id) ? ChevronDown : ChevronRight"
            :size="13"
            class="agent-timeline__section-caret"
          />
          <component :is="block.section === 'thinking' ? Brain : Compass" :size="13" />
          <span>
            {{
              block.section === "thinking"
                ? t(`${KB}.agent_section_thinking`)
                : t(`${KB}.agent_section_references`)
            }}
          </span>
        </button>
      </div>

      <!-- 推理文本：通栏纯文本，无图标无气泡 -->
      <p v-else-if="block.kind === 'reasoning'" class="agent-timeline__reasoning">
        {{ block.text }}
      </p>

      <!-- 工具聚合行 -->
      <div v-else-if="block.kind === 'toolGroup'" class="agent-timeline__node">
        <span class="agent-timeline__rail-icon"><Wrench :size="13" /></span>
        <button type="button" class="agent-timeline__group" @click="toggleGroup(block.id)">
          <component
            :is="expandedGroups[block.id] ? ChevronDown : ChevronRight"
            :size="13"
            class="agent-timeline__section-caret"
          />
          <span>{{ t(`${KB}.agent_tool_group`, { count: block.calls.length }) }}</span>
        </button>
        <ul v-if="expandedGroups[block.id]" class="agent-timeline__sublist">
          <li v-for="call in block.calls" :key="call.id" class="agent-timeline__item">
            <div class="agent-timeline__line" :title="call.params">
              <component :is="toolIcon(call.name)" :size="13" class="agent-timeline__icon" />
              <span class="agent-timeline__label">{{ toolLabel(call) }}</span>
              <span v-if="statusLabel(call.status)" class="agent-timeline__status">
                {{ statusLabel(call.status) }}
              </span>
            </div>
            <p v-if="call.status === 'failed' && call.error" class="agent-timeline__error">
              <button type="button" class="agent-timeline__error-toggle" @click="toggleError(call.id)">
                <TriangleAlert :size="12" />
                <span>{{ t(`${KB}.agent_tool_error_detail`) }}</span>
              </button>
              <span v-if="expandedErrors[call.id]" class="agent-timeline__error-text">
                {{ call.error }}
              </span>
            </p>
            <p v-else-if="call.status === 'done'" class="agent-timeline__result">
              {{ call.result || t(`${KB}.agent_tool_no_result`) }}
            </p>
          </li>
        </ul>
      </div>

      <!-- 工具单项行 -->
      <div v-else-if="block.kind === 'tool'" class="agent-timeline__node">
        <span class="agent-timeline__rail-icon">
          <LoaderCircle v-if="block.call.status === 'running'" :size="13" class="agent-spin" />
          <component :is="toolIcon(block.call.name)" v-else :size="13" />
        </span>
        <div class="agent-timeline__item">
          <div class="agent-timeline__line" :title="block.call.params">
            <span class="agent-timeline__label">{{ toolLabel(block.call) }}</span>
            <span v-if="statusLabel(block.call.status)" class="agent-timeline__status">
              {{ statusLabel(block.call.status) }}
            </span>
          </div>
          <p v-if="block.call.status === 'failed' && block.call.error" class="agent-timeline__error">
            <button
              type="button"
              class="agent-timeline__error-toggle"
              @click="toggleError(block.call.id)"
            >
              <TriangleAlert :size="12" />
              <span>{{ t(`${KB}.agent_tool_error_detail`) }}</span>
            </button>
            <span v-if="expandedErrors[block.call.id]" class="agent-timeline__error-text">
              {{ block.call.error }}
            </span>
          </p>
          <p v-else-if="block.call.status === 'done'" class="agent-timeline__result">
            {{ block.call.result || t(`${KB}.agent_tool_no_result`) }}
          </p>
        </div>
      </div>

      <!-- 审批行 -->
      <div v-else-if="block.kind === 'approval'" class="agent-timeline__node">
        <span class="agent-timeline__rail-icon">
          <Ban v-if="block.state === 'denied'" :size="13" />
          <ShieldCheck v-else :size="13" />
        </span>
        <div class="agent-timeline__approval">
          <span class="agent-timeline__label">
            {{
              block.state === "pending"
                ? t(`${KB}.agent_approval_pending`, { tool: block.tool })
                : block.state === "allowed"
                  ? t(`${KB}.agent_approval_allowed`)
                  : t(`${KB}.agent_approval_denied`)
            }}
          </span>
          <span v-if="block.state === 'pending'" class="agent-timeline__approval-actions">
            <button
              type="button"
              class="agent-timeline__approve"
              @click="respondApproval(block.id, true)"
            >
              {{ t(`${KB}.agent_approval_allow`) }}
            </button>
            <button
              type="button"
              class="agent-timeline__deny"
              @click="respondApproval(block.id, false)"
            >
              {{ t(`${KB}.agent_approval_deny`) }}
            </button>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
