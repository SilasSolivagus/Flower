import { canonicalWikiText } from '@flower/core/links';
import type { LinkCard } from '@/lib/types';

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
