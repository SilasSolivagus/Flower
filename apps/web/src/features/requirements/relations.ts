export const RELATION_TYPE_OPTIONS = [
  { type: 'related', label: '相关' },
  { type: 'blocks', label: '阻塞' },
  { type: 'duplicate_of', label: '重复于' },
  { type: 'merged_into', label: '合并到' },
  { type: 'derived_from', label: '派生自' },
] as const;

export type RelationKind = (typeof RELATION_TYPE_OPTIONS)[number]['type'];

const PHRASES: Record<string, { out: [string, string]; in: [string, string] }> = {
  blocks: { out: ['阻塞了', ''], in: ['被', '阻塞'] },
  duplicate_of: { out: ['重复于', ''], in: ['', '与本需求重复'] },
  merged_into: { out: ['已合并到', ''], in: ['', '已合并到本需求'] },
  derived_from: { out: ['派生自', ''], in: ['', '由本需求派生'] },
  related: { out: ['相关', ''], in: ['相关', ''] },
};

/** 关联在当前需求上的读法：before + 对方编号 + after。 */
export function relationPhrase(type: string, direction: 'out' | 'in'): { before: string; after: string } {
  const p = PHRASES[type];
  if (!p) return { before: type, after: '' };
  const [before, after] = p[direction];
  return { before, after };
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,9}$/;

/** 输入是完整编号（如 doc-12）时返回大写编号，否则返回 null。 */
export function parseRequirementKey(text: string): string | null {
  const t = text.trim();
  return KEY_RE.test(t) ? t.toUpperCase() : null;
}
