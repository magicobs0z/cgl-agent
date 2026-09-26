// 时间与耗时的展示格式化。
//
// 耗时文案需要 i18n，因此把翻译函数作为参数传入，避免此处硬编码中文/英文。

/** 翻译函数形状（与内核 i18n 的 `t` 一致）。 */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 本地化的日期时间（历史会话列表用）。 */
export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 把毫秒格式化为「<分>分<秒>秒」/「<秒>秒」，由语言包决定词序。 */
export function formatDuration(milliseconds: number, t: Translate, baseKey: string): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return t(`${baseKey}_sec`, { seconds: totalSeconds });
  return t(`${baseKey}_min_sec`, {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  });
}
