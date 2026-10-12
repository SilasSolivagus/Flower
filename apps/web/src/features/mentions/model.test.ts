import { describe, expect, it } from 'vitest';
import type { MentionMember } from '@/lib/types';
import { activeMentionQuery, applyMention, filterMentionMembers, mentionTitle } from './model';

const A = '0192a000-0000-7000-8000-00000000000a';
const m = (over: Partial<MentionMember>): MentionMember => ({ id: A, displayName: '张三', email: 'zhang@example.com', status: 'active', wecomBound: false, canSeeProduct: true, ...over });

describe('@ 补全', () => {
  it('光标前正在输入的 @：行首或空白、标点之后才算；邮箱里的 @、带空白或括号的不算', () => {
    expect(activeMentionQuery('请 @张', 4)).toEqual({ start: 2, query: '张' });
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeMentionQuery('（@李', 3)).toEqual({ start: 1, query: '李' });
    expect(activeMentionQuery('mail a@b.com', 12)).toBeNull();
    expect(activeMentionQuery('@张 三', 4)).toBeNull();
    expect(activeMentionQuery(`[@张三](member:${A})`, 3)).toBeNull();
    const long = `@${'张'.repeat(21)}`;
    expect(activeMentionQuery(long, long.length)).toBeNull();
  });

  it('只列在职成员，按姓名或邮箱包含匹配，姓名开头的排前，最多 8 个', () => {
    const list = [
      m({ id: '1', displayName: '小张', email: 'x@example.com' }),
      m({ id: '2', displayName: '张三' }),
      m({ id: '3', displayName: '张四', status: 'left' }),
      m({ id: '4', displayName: '李四', email: 'zhangli@example.com' }),
    ];
    expect(filterMentionMembers(list, '张').map((x) => x.id)).toEqual(['2', '1']);
    expect(filterMentionMembers(list, 'ZHANG').map((x) => x.id)).toEqual(['2', '4']);
    expect(filterMentionMembers(list, '').map((x) => x.id)).toEqual(['1', '2', '4']);
    expect(filterMentionMembers(Array.from({ length: 12 }, (_, i) => m({ id: String(i) })), '')).toHaveLength(8);
  });

  it('选中后写入 @ 写法并加一个空格，光标停在空格后', () => {
    const r = applyMention('请 @张 看下', { start: 2, query: '张' }, 4, m({}));
    expect(r.value).toBe(`请 [@张三](member:${A})  看下`);
    expect(r.caret).toBe(`请 [@张三](member:${A}) `.length);
  });

  it('悬停说明：邮箱与是否绑定企业微信；已离开与查不到的成员', () => {
    expect(mentionTitle(m({ wecomBound: true }))).toBe('zhang@example.com · 已绑定企业微信');
    expect(mentionTitle(m({ email: null, status: 'left' }))).toBe('没有邮箱 · 未绑定企业微信 · 已离开组织');
    expect(mentionTitle(null)).toBe('成员已不在组织中');
    expect(mentionTitle(undefined)).toBe('');
  });
});
