import { mentionMarkup, parseMentions } from '@flower/core/links';
import type { MentionMember } from '@/lib/types';

export type MentionQuery = { start: number; query: string };

const MAX_QUERY = 20;
/** @ 前面允许的字符：行首、空白与常见标点。字母数字之后的 @（如邮箱）不触发补全。 */
const BEFORE_AT = /[\s(（,，.。:：;；!！?？、"'“‘]/;

export const MENTION_NO_ACCESS = '看不到这个产品';

/** @ 前一个字符（undefined 为行首）是否允许打开补全。评论输入框与 PRD 编辑器共用。 */
export const canOpenMentionAfter = (prev: string | undefined): boolean => prev === undefined || BEFORE_AT.test(prev);

/** 光标前正在输入的 @：@ 到光标之间不含空白与 []()，最多 20 字。 */
export function activeMentionQuery(value: string, caret: number): MentionQuery | null {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start === -1) return null;
  if (!canOpenMentionAfter(before[start - 1])) return null;
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

/** 编辑器链接里的姓名只含字母数字、`-_.~` 与 %XX，BlockNote 的 Markdown 解析与导出都不会转义或改写它。 */
const encodeName = (name: string) => encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** PRD 编辑器里 @ 对应的链接：`member:ID?n=姓名编码`。读入与导出都经过它，姓名不受 Markdown 转义影响。 */
export const mentionEditorHref = (memberId: string, name: string): string => `member:${memberId}?n=${encodeName(name)}`;

/**
 * 交给 BlockNote 解析前，把 `[@姓名](member:ID)` 换成 `[@](member:ID?n=姓名编码)`：BlockNote 的 Markdown 解析
 * 只认部分反斜杠转义，姓名里的 `*重要*`、`<c>` 会变成强调或被当成 HTML。代码里的写法不是 @，不处理。
 */
export function encodeMentionsForEditor(markdown: string): string {
  let out = '';
  let at = 0;
  for (const m of parseMentions(markdown)) {
    // 用原文里的姓名与 ID（parseMentions 会去掉姓名首尾空白、把 ID 转小写），保存时写法不变
    const nameEnd = m.raw.indexOf('](member:');
    out += `${markdown.slice(at, m.start)}[@](${mentionEditorHref(m.raw.slice(nameEnd + 9, -1), m.raw.slice(2, nameEnd))})`;
    at = m.end;
  }
  return out + markdown.slice(at);
}

const EDITOR_MENTION = /(?<!\\)\[@[^[\n]*\]\(member:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\?n=([0-9A-Za-z%._~-]*)\)/g;

/**
 * BlockNote 导出的 Markdown 里，@ 是带姓名编码的链接，链接文字还可能被转义。这里按编码换回 `[@姓名](member:ID)`，
 * 读入再保存时写法逐字节不变。姓名不含方括号（cleanMentionName），所以链接文字到最近的 `[@` 为止。
 */
export function restoreMentionMarkup(markdown: string): string {
  return markdown.replace(EDITOR_MENTION, (raw, id: string, n: string) => {
    try {
      return `[@${decodeURIComponent(n)}](member:${id})`;
    } catch {
      return raw;
    }
  });
}
