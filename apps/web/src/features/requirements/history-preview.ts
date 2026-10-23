/** 右栏状态历史默认露出的条数（新到旧）。 */
export const HISTORY_PREVIEW_COUNT = 3;

/** 历史按时间正序存放。预览翻成新到旧，未展开时只留最近几条。 */
export function previewHistory<T>(entries: readonly T[], expanded: boolean): { visible: T[]; hiddenCount: number } {
  const newestFirst = [...entries].reverse();
  if (expanded || newestFirst.length <= HISTORY_PREVIEW_COUNT) {
    return { visible: newestFirst, hiddenCount: 0 };
  }
  return {
    visible: newestFirst.slice(0, HISTORY_PREVIEW_COUNT),
    hiddenCount: newestFirst.length - HISTORY_PREVIEW_COUNT,
  };
}
