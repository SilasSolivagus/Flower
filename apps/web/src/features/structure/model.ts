import type { StructureNode } from '@/lib/types';

/** 按树的先序排列：同级按 sort，再按名称。 */
export function flattenTree(nodes: StructureNode[]): StructureNode[] {
  const children = new Map<string | null, StructureNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-CN'));
  const out: StructureNode[] = [];
  const visit = (parentId: string | null) => {
    for (const node of children.get(parentId) ?? []) {
      out.push(node);
      visit(node.id);
    }
  };
  visit(null);
  return out;
}

/** 需求详情的节点下拉：隐藏已停用节点及其下级；当前选中的节点保留。 */
export function nodeOptions(nodes: StructureNode[], currentId: string | null): Array<{ id: string; name: string; depth: number; deprecated: boolean }> {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const hidden = (node: StructureNode): boolean => {
    if (node.status === 'deprecated') return true;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    return parent ? hidden(parent) : false;
  };
  return flattenTree(nodes)
    .filter((x) => x.id === currentId || !hidden(x))
    .map((x) => ({ id: x.id, name: x.name, depth: x.depth, deprecated: x.status === 'deprecated' }));
}

/** 把 id 在同级列表中上移（-1）或下移（1）一位；已在边界时原样返回。 */
export function moveSibling(ids: string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const next = [...ids];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function levelLabel(names: string[], depth: number): string {
  return names[depth - 1] ?? `第 ${depth} 层`;
}
