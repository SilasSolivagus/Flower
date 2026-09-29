import type { CHECK_STATES } from '../definitions/workflow-schema';

export type CheckState = (typeof CHECK_STATES)[number];

export const CHECK_STATE_LABELS: Record<CheckState, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  passed: '通过',
  rejected: '驳回',
  not_needed: '不需要',
};
