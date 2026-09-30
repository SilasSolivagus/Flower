import { CHECK_STATE_LABEL } from '@/lib/labels';
import type { CheckState, ReviewFilterState, ReviewQueue, ReviewState } from '@/lib/types';

export type ReviewFilter = { state: ReviewFilterState; itemKey: string; itemState: CheckState; mine: boolean };
export const DEFAULT_REVIEW_FILTER: ReviewFilter = { state: 'open', itemKey: '', itemState: 'not_started', mine: false };
export const REVIEW_STATES: ReviewState[] = ['not_started', 'in_progress', 'rejected', 'passed'];
export const REVIEW_STATE_LABEL: Record<ReviewState, string> = { not_started: '未开始', in_progress: '评审中', rejected: '有驳回', passed: '已通过' };
export const REVIEW_FILTER_OPTIONS: Array<{ value: ReviewFilterState; label: string }> = [
  { value: 'open', label: '待评审（未全部通过）' },
  { value: 'not_started', label: '未开始' },
  { value: 'in_progress', label: '评审中' },
  { value: 'rejected', label: '有驳回' },
  { value: 'passed', label: '已通过' },
  { value: 'all', label: '全部' },
];

export function reviewQuery(f: ReviewFilter): string {
  const p = new URLSearchParams({ state: f.state });
  if (f.itemKey) {
    p.set('item', f.itemKey);
    p.set('itemState', f.itemState);
  }
  if (f.mine) p.set('mine', '1');
  return p.toString();
}

type Row = ReviewQueue['rows'][number];

/** 单元格文字：普通检查项只显示状态，会签检查项加上「通过数/规则数」。 */
export function cellText(cell: Row['cells'][string]): string {
  const label = CHECK_STATE_LABEL[cell.state];
  return cell.total === null ? label : `${label} ${cell.passed}/${cell.total}`;
}

/** 行尾的待签标记：有本人的规则为「待我签」，只有可代签的规则时为「可代签」。 */
export function waitingText(waiting: Row['waiting']): string | null {
  if (waiting.some((w) => !w.onBehalf)) return '待我签';
  return waiting.length > 0 ? '可代签' : null;
}
