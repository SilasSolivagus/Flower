import { describe, expect, it } from 'vitest';
import type { LinkCard } from '@/lib/types';
import { activeWikiQuery, applyCompletion, backlinkViaLabel, cardFor, cardHref, cardLabel, isGrey } from './model';

describe('「被引用」的来源说明', () => {
  it('需求描述、PRD 小节（无小节时为正文）、评论', () => {
    expect(backlinkViaLabel({ via: 'description', section: null })).toBe('需求描述');
    expect(backlinkViaLabel({ via: 'body', section: '1. 方案' })).toBe('小节「1. 方案」');
    expect(backlinkViaLabel({ via: 'body', section: null })).toBe('正文');
    expect(backlinkViaLabel({ via: 'comment', section: null })).toBe('评论');
  });
});

describe('链接卡', () => {
  const card = (over: Partial<LinkCard>): LinkCard => ({
    text: 'PAN-1',
    targetType: 'requirement',
    state: 'ok',
    displayKey: 'PAN-1',
    title: '登录改版',
    status: { label: '待处理', color: '#94a3b8' },
    href: 'requirements/PAN-1',
    ...over,
  });

  it('按来源产品算出规范写法找到对应的卡', () => {
    const cards = [card({}), card({ text: 'PAN/迭代:0316', targetType: 'iteration', displayKey: '迭代:0316', title: null, href: 'iterations/i1' })];
    expect(cardFor(cards, 'pan-1', 'PAN')).toBe(cards[0]);
    expect(cardFor(cards, '迭代：0316', 'PAN')).toBe(cards[1]);
    expect(cardFor(cards, '迭代:0316', 'DOC')).toBeNull();
  });

  it('地址、灰色与无障碍名称', () => {
    expect(cardHref('acme', card({}))).toBe('/acme/requirements/PAN-1');
    expect(cardHref('acme', card({ state: 'hidden', href: null }))).toBeNull();
    expect(isGrey(card({}))).toBe(false);
    expect(isGrey(card({ state: 'hidden' }))).toBe(false);
    expect(isGrey(card({ state: 'section_missing' }))).toBe(true);
    expect(isGrey(null)).toBe(true);
    expect(cardLabel(card({}), 'PAN-1')).toBe('PAN-1 登录改版 待处理');
    expect(cardLabel(card({}), 'PAN-1', '登录')).toBe('PAN-1 登录 待处理');
    expect(
      cardLabel(card({ state: 'section_missing', displayKey: 'PAN-PRD-1#方案', title: '登录 PRD', status: { label: '草稿', color: null } }), 'PAN-PRD-1#方案'),
    ).toBe('PAN-PRD-1#方案 登录 PRD 草稿 小节已失效');
    expect(cardLabel(card({ state: 'hidden', displayKey: 'DOC-1', title: null, status: null, href: null }), 'DOC-1')).toBe('DOC-1');
    expect(cardLabel(null, 'PAN-9')).toBe('PAN-9 未解析');
  });
});

describe('[[ 补全', () => {
  it('光标前未闭合、未转义、不跨行的 [[ 才算正在补全', () => {
    expect(activeWikiQuery('见 [[登录', 6)).toEqual({ start: 2, query: '登录' });
    expect(activeWikiQuery('见 [[', 4)).toEqual({ start: 2, query: '' });
    expect(activeWikiQuery('见 [[PAN-1]] 和', 12)).toBeNull();
    expect(activeWikiQuery('[[登\n录', 5)).toBeNull();
    expect(activeWikiQuery('\\[[登录', 5)).toBeNull();
    expect(activeWikiQuery('见 [[登录', 3)).toBeNull();
  });

  it('选中后闭合；选 PRD 时改为 [[KEY#，光标落在插入内容之后', () => {
    const q = activeWikiQuery('见 [[登录 吧', 6)!;
    expect(applyCompletion('见 [[登录 吧', q, 6, { insert: 'PAN-1', next: 'insert' })).toEqual({ value: '见 [[PAN-1]] 吧', caret: 11 });
    expect(applyCompletion('见 [[登录 吧', q, 6, { insert: 'PAN-PRD-1', next: 'sections' })).toEqual({ value: '见 [[PAN-PRD-1# 吧', caret: 14 });
  });
});
