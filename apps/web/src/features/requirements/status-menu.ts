export type StatusTransition = {
  to: string;
  label: string;
  allowed: boolean;
  unmet: ReadonlyArray<{ message: string }>;
};

/** 菜单项副文案。未满足条件只出现在这里，不在按钮下再挂一条列表。 */
export function transitionDisabledReason(transition: StatusTransition, canEdit: boolean): string | undefined {
  if (!canEdit) return '只有编辑可以改状态';
  if (transition.allowed) return undefined;
  const text = transition.unmet.map((item) => item.message).join('；');
  return text || '现在不能改到这个状态';
}

/** 主按钮最多一个：当前人能改，且该目标确实允许流转。 */
export function primaryStatusAction<T extends { to: string; allowed: boolean }>(canEdit: boolean, primaryTo: string | null, transitions: readonly T[]): T | null {
  if (!canEdit || !primaryTo) return null;
  return transitions.find((transition) => transition.to === primaryTo && transition.allowed) ?? null;
}
