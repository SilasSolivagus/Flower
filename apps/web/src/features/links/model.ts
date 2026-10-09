import { canonicalWikiText } from '@flower/core/links';
import type { LinkCard, LinkSuggestion } from '@/lib/types';

/** 「被引用」每一条的来源说明：需求描述 / PRD 的小节 / 评论。 */
export function backlinkViaLabel(item: { via: 'description' | 'body' | 'comment'; section: string | null }): string {
  if (item.via === 'description') return '需求描述';
  if (item.via === 'comment') return '评论';
  return item.section ? `小节「${item.section}」` : '正文';
}

/** 链接卡的说明文字；为 null 时不显示说明、也不显示为灰色。 */
export const LINK_STATE_NOTE: Record<LinkCard['state'], string | null> = {
  ok: null,
  hidden: null,
  missing: '目标不存在',
  deleted: '已删除',
  canceled: '已取消',
  section_missing: '小节已失效',
};

/** 正文中一个 [[ ]] 对应的链接卡：按来源产品算出规范写法后查找。 */
export function cardFor(cards: LinkCard[], target: string, productKey: string): LinkCard | null {
  const text = canonicalWikiText(target, productKey);
  return cards.find((c) => c.text === text) ?? null;
}

export const cardHref = (org: string, card: LinkCard): string | null => (card.href ? `/${org}/${card.href}` : null);

/** 不存在、已删除、已取消、小节失效、未解析时显示为灰色。 */
export const isGrey = (card: LinkCard | null): boolean => !card || LINK_STATE_NOTE[card.state] !== null;

/** 链接卡的无障碍名称：编号、标题（有显示文字时用显示文字）、状态、说明。 */
export function cardLabel(card: LinkCard | null, target: string, label: string | null = null): string {
  if (!card) return `${target} 未解析`;
  return [card.displayKey, label ?? card.title, card.status?.label, LINK_STATE_NOTE[card.state]].filter(Boolean).join(' ');
}

export type WikiQuery = { start: number; query: string };

const MAX_QUERY = 60;

/** 光标前正在输入的 [[ 补全：最近一个未转义的 [[ 到光标之间的文字，不含 [、]、换行，最多 60 字。 */
export function activeWikiQuery(value: string, caret: number): WikiQuery | null {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf('[[');
  if (start === -1 || before[start - 1] === '\\') return null;
  const query = before.slice(start + 2);
  if (query.length > MAX_QUERY || /[[\]\n]/.test(query)) return null;
  return { start, query };
}

/** 选中补全项：闭合为 [[insert]]；选的是 PRD（next 为 sections）时改为 [[insert#，继续选小节。 */
export function applyCompletion(value: string, q: WikiQuery, caret: number, s: Pick<LinkSuggestion, 'insert' | 'next'>): { value: string; caret: number } {
  const head = value.slice(0, q.start);
  const inserted = s.next === 'sections' ? `[[${s.insert}#` : `[[${s.insert}]]`;
  return { value: head + inserted + value.slice(caret), caret: head.length + inserted.length };
}

export const SUGGESTION_KIND_LABEL: Record<LinkSuggestion['kind'], string> = {
  requirement: '需求',
  document: 'PRD',
  section: '小节',
  task: '任务',
  iteration: '迭代',
  structure_node: '结构树',
};
