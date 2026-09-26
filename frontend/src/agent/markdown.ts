// 助手回答的 Markdown 渲染。
//
// 回答来自模型输出，属于不可信文本，必须走 marked 转换 + DOMPurify 白名单净化后再插入
// DOM，否则模型（或提示词注入）产出的 `<script>` / `onerror` 会直接执行。
// 白名单与内核内容模块的 readme 渲染保持一致，避免同一产物内两套安全口径。

import DOMPurify from "dompurify";
import { marked } from "marked";

/** 仅保留文档类标签，剔除表单 / 嵌入 / 样式等可执行或影响布局的节点。 */
const ALLOWED_TAGS = [
  "a", "b", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt",
  "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "kbd", "li",
  "ol", "p", "picture", "pre", "s", "samp", "source", "span", "strong", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "var",
];

const ALLOWED_ATTR = [
  "align", "alt", "checked", "class", "colspan", "disabled", "height", "href",
  "rowspan", "src", "srcset", "start", "title", "type", "width",
];

/** 渲染 Markdown 为可安全插入的 HTML。空输入返回空串。 */
export function renderMarkdown(raw: string): string {
  if (!raw.trim()) return "";
  const html = marked.parse(raw, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // 禁止 data: / javascript: 等可执行或内嵌载荷的 URL。
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|#|\/(?!\/)|\.\/|\.\.\/)/i,
  }) as string;
}
