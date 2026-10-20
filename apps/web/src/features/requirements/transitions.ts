type StateRef = { key: string; order: number; category?: string };
type TransitionRef = { to: string; allowed: boolean };

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
