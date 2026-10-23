type StateRef = { key: string; order: number; category?: string };
type TransitionRef = { to: string; allowed: boolean };

type MenuTransition = {
  to: string;
  label: string;
  allowed: boolean;
  unmet: ReadonlyArray<{ message: string }>;
};

export type StatusMenuEntry = {
  to: string;
  label: string;
  enabled: boolean;
  reason?: string;
};

/**
 * 「变更状态」菜单里的下一态。工作流给出的每一条都保留：
 * 条件满足且可编辑的可以点；非法的停用并带上短因，不在页面上排成按钮列。
 */
export function statusMenuEntries(transitions: ReadonlyArray<MenuTransition>, canEdit: boolean): StatusMenuEntry[] {
  return transitions.map((t) => {
    if (!t.allowed) {
      const reason = t.unmet.map((u) => u.message).filter(Boolean).join('；');
      return { to: t.to, label: t.label, enabled: false, reason: reason || '现在不能改到这个状态' };
    }
    if (!canEdit) return { to: t.to, label: t.label, enabled: false, reason: '只有编辑可以改状态' };
    return { to: t.to, label: t.label, enabled: true };
  });
}

/**
 * 主推荐：当前状态之后、顺序最近、且允许流转的目标。
 * 已取消不算主推荐。没有这样的目标时，不标实心主按钮。
 */
export function primaryTransitionTo(currentKey: string, states: ReadonlyArray<StateRef>, transitions: ReadonlyArray<TransitionRef>): string | null {
  const byKey = new Map(states.map((s) => [s.key, s]));
  const current = byKey.get(currentKey);
  if (!current) return null;
  const forward = transitions
    .filter((t) => {
      const state = byKey.get(t.to);
      if (!t.allowed || !state || state.category === 'canceled') return false;
      return state.order > current.order;
    })
    .sort((a, b) => byKey.get(a.to)!.order - byKey.get(b.to)!.order);
  return forward[0]?.to ?? null;
}
