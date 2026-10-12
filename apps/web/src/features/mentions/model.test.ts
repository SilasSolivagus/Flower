import { describe, expect, it } from 'vitest';
import type { MentionMember } from '@/lib/types';
import { parseMentions } from '@flower/core/links';
import { activeMentionQuery, applyMention, canOpenMentionAfter, encodeMentionsForEditor, filterMentionMembers, mentionEditorHref, mentionTitle, restoreMentionMarkup } from './model';

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

describe('@ 的打开条件与 PRD 编辑器里的写法转换', () => {
  it('@ 前是行首、空白或标点才打开补全；字母数字之后（邮箱）不打开', () => {
    for (const prev of [undefined, ' ', '\n', '（', '，', '。', '(', '"']) expect(canOpenMentionAfter(prev)).toBe(true);
    for (const prev of ['a', 'Z', '3', '张', '_']) expect(canOpenMentionAfter(prev)).toBe(false);
  });

  it('含 Markdown 特殊字符的姓名：读入前换成带姓名编码的链接，导出后换回，写法逐字节不变；服务端仍识别出成员', () => {
    const name = 'A & B <c> *x_y* \\_ (1)! #2 ~`q\\';
    const upper = A.toUpperCase();
    const md = `负责人 [@${name}](member:${upper}) 和 [@ 李四 ](member:${A}) 尾\n\n代码 \`[@x_y](member:${A})\``;
    const encoded = encodeMentionsForEditor(md);
    expect(encoded).toBe(`负责人 [@](${mentionEditorHref(upper, name)}) 和 [@](${mentionEditorHref(A, ' 李四 ')}) 尾\n\n代码 \`[@x_y](member:${A})\``);
    expect(mentionEditorHref(A, name)).toMatch(/^member:[0-9a-f-]{36}\?n=[0-9A-Za-z%._~-]*$/);
    // BlockNote 导出时链接文字可能被转义：只按链接里的编码换回
    const exported = encoded.replace('[@](', `[@A \\& B \\<c> \\*x\\_y\\* \\\\_ (1)! #2 ~\`q\\](`);
    expect(restoreMentionMarkup(exported)).toBe(md);
    expect(parseMentions(restoreMentionMarkup(exported)).map((m) => [m.memberId, m.name])).toEqual([
      [A, name],
      [A, '李四'],
    ]);
  });

  it('前面有反斜杠的（正文里的普通文字）与不带姓名编码的链接不换', () => {
    const href = mentionEditorHref(A, 'x');
    expect(restoreMentionMarkup(`\\[@x](${href})`)).toBe(`\\[@x](${href})`);
    expect(restoreMentionMarkup(`C:\\\\\\[@x](${href})`)).toBe(`C:\\\\\\[@x](${href})`);
    expect(restoreMentionMarkup(`[@x](member:${A})`)).toBe(`[@x](member:${A})`);
    expect(encodeMentionsForEditor('没有 @')).toBe('没有 @');
  });

  it('前面是偶数个反斜杠（反斜杠本身，如路径 C:\\）的 @ 照常换回；读入再保存写法不变，服务端识别出成员', () => {
    const href = mentionEditorHref(A, '张三');
    expect(restoreMentionMarkup(`C:\\\\[@](${href})`)).toBe(`C:\\\\[@张三](member:${A})`);
    expect(restoreMentionMarkup(`\\\\\\\\[@](${href}) 行首`)).toBe(`\\\\\\\\[@张三](member:${A}) 行首`);
    const md = `路径 C:\\\\[@张三](member:${A}) 尾`;
    const encoded = encodeMentionsForEditor(md);
    expect(encoded).toBe(`路径 C:\\\\[@](${href}) 尾`);
    expect(restoreMentionMarkup(encoded)).toBe(md);
    expect(parseMentions(restoreMentionMarkup(encoded)).map((m) => m.memberId)).toEqual([A]);
  });
});
