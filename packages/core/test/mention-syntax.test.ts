import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_PREFS, MEMBER_NOTIFICATION_KINDS, MEMBER_NOTIFICATION_RANK, WECOM_USERID_RE } from '../src/notifications/constants';
import { cleanMentionName, mentionedMemberIds, mentionMarkup, newMentionIds, parseMentions, plainMentions, splitRichText } from '../src/links/syntax';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';

describe('@ 成员的写法', () => {
  it('解析姓名与成员 ID；围栏代码块、行内代码与反斜杠转义的不算', () => {
    const text = [
      `请 ${mentionMarkup(A, '张三')} 看一下`,
      `\`[@李四](member:${B})\``,
      '```',
      `[@李四](member:${B})`,
      '```',
      `\\[@李四](member:${B})`,
    ].join('\n');
    expect(parseMentions(text).map((m) => [m.memberId, m.name])).toEqual([[A, '张三']]);
  });

  it('成员 ID 统一小写；同一人出现多次只算一次', () => {
    const text = `[@张三](member:${A.toUpperCase()}) 和 [@张三](member:${A}) 以及 [@李四](member:${B})`;
    expect(mentionedMemberIds(text)).toEqual([A, B]);
  });

  it('新增比对：只返回上一版没有的成员，按首次出现顺序', () => {
    const before = `先请 ${mentionMarkup(A, '张三')}`;
    const after = `${mentionMarkup(B, '李四')} 也来；${mentionMarkup(A, '张三')} 还在`;
    expect(newMentionIds(before, after)).toEqual([B]);
    expect(newMentionIds(after, before)).toEqual([]);
    expect(newMentionIds('', after)).toEqual([B, A]);
  });

  it('写法：姓名里的方括号与换行替换为空格，最多 50 字；空姓名用「成员」', () => {
    expect(cleanMentionName('王[五]\n六')).toBe('王 五 六');
    expect(mentionMarkup(A, '  ')).toBe(`[@成员](member:${A})`);
    expect(cleanMentionName('长'.repeat(60))).toHaveLength(50);
    expect(parseMentions(mentionMarkup(A, '王[五]'))[0]!.name).toBe('王 五');
  });

  it('纯文字与混合片段：@ 与 [[ ]] 交替出现时按位置切分', () => {
    const text = `请 ${mentionMarkup(A, '张三')} 看 [[PAN-1]]，谢谢`;
    expect(plainMentions(text)).toBe('请 @张三 看 [[PAN-1]]，谢谢');
    expect(splitRichText(text).map((s) => s.kind)).toEqual(['text', 'mention', 'text', 'link', 'text']);
  });
});

describe('通知取值', () => {
  it('五类通知；排名 被@ > 被指派 > 等我签字 > 关注对象变化', () => {
    expect(MEMBER_NOTIFICATION_KINDS).toEqual(['mentioned', 'assigned', 'followed_change', 'signoff_due', 'system_alert']);
    const order = [...MEMBER_NOTIFICATION_KINDS].filter((k) => k !== 'system_alert').sort((a, b) => MEMBER_NOTIFICATION_RANK[b] - MEMBER_NOTIFICATION_RANK[a]);
    expect(order).toEqual(['mentioned', 'assigned', 'signoff_due', 'followed_change']);
  });

  it('默认偏好：站内全开；企微只开被 @、被指派、等我签字；邮件全关', () => {
    for (const k of MEMBER_NOTIFICATION_KINDS) {
      expect(DEFAULT_NOTIFICATION_PREFS[k].inApp).toBe(true);
      expect(DEFAULT_NOTIFICATION_PREFS[k].email).toBe(false);
    }
    expect(MEMBER_NOTIFICATION_KINDS.filter((k) => DEFAULT_NOTIFICATION_PREFS[k].wecom)).toEqual(['mentioned', 'assigned', 'signoff_due']);
  });

  it('企业微信账号格式', () => {
    expect(WECOM_USERID_RE.test('zhang.san@corp-1_x')).toBe(true);
    expect(WECOM_USERID_RE.test('张三')).toBe(false);
    expect(WECOM_USERID_RE.test('a b')).toBe(false);
    expect(WECOM_USERID_RE.test('x'.repeat(65))).toBe(false);
  });
});
