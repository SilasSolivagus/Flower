import { mentionMarkup } from '@flower/core/links';
import type { MentionMember } from '@/lib/types';

export type MentionQuery = { start: number; query: string };

const MAX_QUERY = 20;
/** @ 前面允许的字符：行首、空白与常见标点。字母数字之后的 @（如邮箱）不触发补全。 */
const BEFORE_AT = /[\s(（,，.。:：;；!！?？、"'“‘]/;

export const MENTION_NO_ACCESS = '看不到这个产品';

/** 光标前正在输入的 @：@ 到光标之间不含空白与 []()，最多 20 字。 */
export function activeMentionQuery(value: string, caret: number): MentionQuery | null {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start === -1) return null;
  const prev = before[start - 1];
  if (prev !== undefined && !BEFORE_AT.test(prev)) return null;
  const query = before.slice(start + 1);
  if (query.length > MAX_QUERY || /[\s[\]()（）]/.test(query)) return null;
  return { start, query };
}

/** 补全候选：只列在职成员；按姓名或邮箱包含匹配（忽略大小写），姓名开头的排前；最多 limit 个。 */
export function filterMentionMembers(list: MentionMember[], query: string, limit = 8): MentionMember[] {
  const q = query.trim().toLowerCase();
  const active = list.filter((m) => m.status === 'active');
  const matched = q ? active.filter((m) => m.displayName.toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q)) : active;
  const starts = (m: MentionMember) => !!q && m.displayName.toLowerCase().startsWith(q);
  return [...matched.filter(starts), ...matched.filter((m) => !starts(m))].slice(0, limit);
}

/** 选中一个成员：把 @ 到光标的文字换成 @ 写法并加一个空格。 */
export function applyMention(value: string, q: MentionQuery, caret: number, member: Pick<MentionMember, 'id' | 'displayName'>): { value: string; caret: number } {
  const head = value.slice(0, q.start);
  const inserted = `${mentionMarkup(member.id, member.displayName)} `;
  return { value: head + inserted + value.slice(caret), caret: head.length + inserted.length };
}

/** 成员标签的悬停说明：undefined 为还在加载，null 为查不到（已不在组织中）。 */
export function mentionTitle(member: MentionMember | null | undefined): string {
  if (member === undefined) return '';
  if (member === null) return '成员已不在组织中';
  return [member.email ?? '没有邮箱', member.wecomBound ? '已绑定企业微信' : '未绑定企业微信', member.status === 'left' ? '已离开组织' : null].filter(Boolean).join(' · ');
}
