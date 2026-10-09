import { describe, expect, it } from 'vitest';
import { normalizeHeading } from '../src/documents/markdown';
import {
  canonicalWikiText,
  classifyTarget,
  linkContext,
  parseTaskKey,
  parseWikilinks,
  splitWikiText,
  taskDisplayKey,
  wikiRangesInBlock,
} from '../src/links/syntax';

describe('双链语法', () => {
  it('各种写法与显示文字', () => {
    const text = '见 [[PAN-12]]、[[pan-prd-3#需求说明|说明]] 和 [[PAN-T-7]]，迭代 [[迭代:0316]]、[[DOC/迭代：一期]]，节点 [[会员/支付]]、[[DOC/会员/支付]]。';
    expect(parseWikilinks(text).map((l) => [l.target, l.label])).toEqual([
      ['PAN-12', null],
      ['pan-prd-3#需求说明', '说明'],
      ['PAN-T-7', null],
      ['迭代:0316', null],
      ['DOC/迭代：一期', null],
      ['会员/支付', null],
      ['DOC/会员/支付', null],
    ]);
    expect(classifyTarget('pan-prd-3#需求说明')).toEqual({ kind: 'document', productKey: 'PAN', number: 3, section: '需求说明' });
    expect(classifyTarget('PAN-PRD-3')).toEqual({ kind: 'document', productKey: 'PAN', number: 3, section: null });
    expect(classifyTarget('pan-t-7')).toEqual({ kind: 'task', productKey: 'PAN', number: 7 });
    expect(classifyTarget('Pan-12')).toEqual({ kind: 'requirement', productKey: 'PAN', number: 12 });
    expect(classifyTarget('DOC/迭代：一期')).toEqual({ kind: 'iteration', productKey: 'DOC', name: '一期' });
    expect(classifyTarget('迭代:0316')).toEqual({ kind: 'iteration', productKey: null, name: '0316' });
    expect(classifyTarget(' 会员 / 支付 ')).toEqual({ kind: 'path', segments: ['会员', '支付'] });
  });

  it('代码块、行内代码与转义中的 [[ ]] 不解析；目标为空的忽略', () => {
    const text = ['```', '[[PAN-1]]', '```', '行内 `[[PAN-2]]` 与 \\[[PAN-3]] 都不算，[[PAN-4]] 算，[[ |只有文字]] 不算', '~~~', '[[PAN-5]]'].join('\n');
    expect(parseWikilinks(text).map((l) => l.target)).toEqual(['PAN-4']);
  });

  it('规范写法：编号转大写，迭代与节点补上来源产品前缀', () => {
    expect(canonicalWikiText('pan-12', 'DOC')).toBe('PAN-12');
    expect(canonicalWikiText('pan-prd-3#需求说明', 'DOC')).toBe('PAN-PRD-3#需求说明');
    expect(canonicalWikiText('pan-t-7', 'DOC')).toBe('PAN-T-7');
    expect(canonicalWikiText('迭代：0316', 'pan')).toBe('PAN/迭代:0316');
    expect(canonicalWikiText('doc/迭代:一期', 'PAN')).toBe('DOC/迭代:一期');
    expect(canonicalWikiText('会员/支付', 'PAN')).toBe('PAN/会员/支付');
    expect(canonicalWikiText('DOC/会员/支付', 'PAN')).toBe('DOC/会员/支付');
    expect(canonicalWikiText('X20260312012', 'PAN')).toBe('PAN/X20260312012');
  });

  it('上下文：引用所在的一句；超过 120 字时截取链接附近', () => {
    const text = '第一句。这一句提到 [[PAN-1]] 的上传！第三句';
    const [l] = parseWikilinks(text);
    expect(linkContext(text, l!.start, l!.end)).toBe('这一句提到 [[PAN-1]] 的上传！');
    const long = `${'甲'.repeat(200)}[[PAN-2]]${'乙'.repeat(200)}`;
    const [m] = parseWikilinks(long);
    const ctx = linkContext(long, m!.start, m!.end);
    expect(ctx.startsWith('…') && ctx.endsWith('…')).toBe(true);
    expect(ctx).toContain('[[PAN-2]]');
    expect(ctx).toHaveLength(122);
  });

  it('拆分为显示片段', () => {
    expect(splitWikiText('看 [[PAN-1|登录]] 吧')).toEqual([
      { kind: 'text', text: '看 ' },
      { kind: 'link', link: { raw: '[[PAN-1|登录]]', target: 'PAN-1', label: '登录', start: 2, end: 14 } },
      { kind: 'text', text: ' 吧' },
    ]);
    expect(splitWikiText('没有链接')).toEqual([{ kind: 'text', text: '没有链接' }]);
  });

  it('编辑器文本块中的位置：跨文本节点；带代码样式的部分不解析', () => {
    const parts = [
      { text: '见 [[PAN', pos: 10, code: false },
      { text: '-1]] 和 ', pos: 17, code: false },
      { text: '[[PAN-2]]', pos: 24, code: true },
    ];
    expect(wikiRangesInBlock(parts)).toEqual([{ from: 12, to: 21, target: 'PAN-1' }]);
  });

  it('任务编号与小节标题归一化', () => {
    expect(taskDisplayKey('PAN', 12)).toBe('PAN-T-12');
    expect(parseTaskKey('pan-t-12')).toEqual({ productKey: 'PAN', number: 12 });
    expect(parseTaskKey('PAN-12')).toBeNull();
    expect(normalizeHeading('3. 需求 说明')).toBe('需求说明');
    expect(normalizeHeading('1.1 业务背景')).toBe('业务背景');
  });
});
