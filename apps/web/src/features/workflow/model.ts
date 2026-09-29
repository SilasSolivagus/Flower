import { CATEGORY_COLOR } from '@/lib/labels';
import type { WorkflowBody } from '@/lib/types';

export type State = WorkflowBody['states'][number];
export type Transition = WorkflowBody['transitions'][number];
export type CheckItem = WorkflowBody['checkItems'][number];
export type Condition = Transition['conditions'][number];
export type GraphNode = { id: string; label: string; category: State['category'] | 'any'; x: number; y: number };
export type GraphEdge = { id: string; source: string; target: string; from: string; to: string; conditional: boolean; selected: boolean };

export const ANY = '*';
const ANY_NODE = '__any';

export function newKey(prefix: 's' | 'c', existing: string[]): string {
  let i = 1;
  while (existing.includes(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

const same = (t: Transition, from: string, to: string) => t.from === from && t.to === to;

export function transitionMode(body: WorkflowBody, from: string, to: string): 'explicit' | 'implied' | 'none' {
  if (from === to) return 'none';
  if (body.transitions.some((t) => same(t, from, to))) return 'explicit';
  if (from !== ANY && body.transitions.some((t) => same(t, ANY, to))) return 'implied';
  return 'none';
}

export function toggleTransition(body: WorkflowBody, from: string, to: string): WorkflowBody {
  if (from === to) return body;
  const exists = body.transitions.some((t) => same(t, from, to));
  return {
    ...body,
    transitions: exists ? body.transitions.filter((t) => !same(t, from, to)) : [...body.transitions, { from, to, conditions: [] }],
  };
}

export function getConditions(body: WorkflowBody, from: string, to: string): Condition[] {
  return body.transitions.find((t) => same(t, from, to))?.conditions ?? [];
}

export function setConditions(body: WorkflowBody, from: string, to: string, conditions: Condition[]): WorkflowBody {
  return { ...body, transitions: body.transitions.map((t) => (same(t, from, to) ? { ...t, conditions } : t)) };
}

export function addState(body: WorkflowBody, input: { label: string; category: State['category']; group: string }): WorkflowBody {
  const key = newKey('s', body.states.map((s) => s.key));
  const order = Math.max(0, ...body.states.map((s) => s.order)) + 1;
  return { ...body, states: [...body.states, { key, label: input.label, category: input.category, group: input.group, color: CATEGORY_COLOR[input.category], order }] };
}

export function updateState(body: WorkflowBody, key: string, patch: Partial<Omit<State, 'key'>>): WorkflowBody {
  return { ...body, states: body.states.map((s) => (s.key === key ? { ...s, ...patch } : s)) };
}

export function removeState(body: WorkflowBody, key: string): WorkflowBody {
  const states = body.states.filter((s) => s.key !== key);
  return {
    ...body,
    states,
    transitions: body.transitions.filter((t) => t.from !== key && t.to !== key),
    initial: body.initial === key ? (states[0]?.key ?? '') : body.initial,
  };
}

export function reorderStates(body: WorkflowBody, keys: string[]): WorkflowBody {
  const byKey = new Map(body.states.map((s) => [s.key, s]));
  const states = keys.flatMap((k, i) => {
    const s = byKey.get(k);
    return s ? [{ ...s, order: i + 1 }] : [];
  });
  return { ...body, states };
}

export function setInitial(body: WorkflowBody, key: string): WorkflowBody {
  return { ...body, initial: key };
}

export function addCheckItem(body: WorkflowBody, input: Omit<CheckItem, 'key' | 'defaultState'>): WorkflowBody {
  const key = newKey('c', body.checkItems.map((c) => c.key));
  return { ...body, checkItems: [...body.checkItems, { key, ...input, defaultState: 'not_started' }] };
}

export function updateCheckItem(body: WorkflowBody, key: string, patch: Partial<Omit<CheckItem, 'key'>>): WorkflowBody {
  return { ...body, checkItems: body.checkItems.map((c) => (c.key === key ? { ...c, ...patch } : c)) };
}

export function removeCheckItem(body: WorkflowBody, key: string): WorkflowBody {
  const keep = (c: Condition) => !(c.type === 'check_item' && c.item === key);
  return {
    ...body,
    checkItems: body.checkItems.filter((c) => c.key !== key),
    transitions: body.transitions.map((t) => ({ ...t, conditions: t.conditions.filter(keep) })),
    actionGates: body.actionGates
      .map((g) => ({ ...g, conditions: g.conditions.filter(keep) }))
      .filter((g) => g.conditions.length > 0),
  };
}

export function getGateConditions(body: WorkflowBody): Condition[] {
  return body.actionGates.find((g) => g.action === 'join_iteration')?.conditions ?? [];
}

export function setGateConditions(body: WorkflowBody, conditions: Condition[]): WorkflowBody {
  const others = body.actionGates.filter((g) => g.action !== 'join_iteration');
  return { ...body, actionGates: conditions.length > 0 ? [...others, { action: 'join_iteration', conditions }] : others };
}

export function layoutGraph(body: WorkflowBody, selected?: { from: string; to: string }): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const states = [...body.states].sort((a, b) => a.order - b.order);
  const groups: string[] = [];
  for (const s of states) if (!groups.includes(s.group)) groups.push(s.group);
  const colInGroup = new Map<string, number>();
  const nodes: GraphNode[] = [];
  const hasAny = body.transitions.some((t) => t.from === ANY);
  if (hasAny) nodes.push({ id: ANY_NODE, label: '任意状态', category: 'any', x: 0, y: 0 });
  for (const s of states) {
    const row = groups.indexOf(s.group);
    const col = colInGroup.get(s.group) ?? 0;
    colInGroup.set(s.group, col + 1);
    nodes.push({ id: s.key, label: s.label, category: s.category, x: 200 + col * 170, y: row * 130 });
  }
  const edges: GraphEdge[] = body.transitions.map((t) => ({
    id: `${t.from}->${t.to}`,
    source: t.from === ANY ? ANY_NODE : t.from,
    target: t.to,
    from: t.from,
    to: t.to,
    conditional: t.conditions.length > 0,
    selected: Boolean(selected && selected.from === t.from && selected.to === t.to),
  }));
  return { nodes, edges };
}
