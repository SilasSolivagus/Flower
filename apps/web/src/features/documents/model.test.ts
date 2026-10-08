import { describe, expect, it } from 'vitest';
import { documentFilterToApiQuery, documentFilterToSearch, documentHref, parseDocumentFilter, parseRequirementKeys, saveStateLabel, sourceLabel } from './model';

describe('PRD 列表筛选', () => {
  it('地址栏 ↔ 筛选；无效的状态与来源被忽略', () => {
    const f = parseDocumentFilter(new URLSearchParams('product=PAN&status=review&source=external&owner=m1&q=支付'));
    expect(f).toEqual({ product: 'PAN', status: 'review', owner: 'm1', source: 'external', q: '支付' });
    expect(parseDocumentFilter(new URLSearchParams('status=bogus&source=x'))).toEqual({ product: '', status: '', owner: '', source: '', q: '' });
    expect(documentFilterToSearch(f)).toBe('product=PAN&status=review&owner=m1&source=external&q=%E6%94%AF%E4%BB%98');
    expect(documentFilterToApiQuery(f)).toBe('status=review&owner=m1&source=external&q=%E6%94%AF%E4%BB%98');
    expect(documentFilterToApiQuery({ product: 'PAN', status: '', owner: '', source: '', q: '' })).toBe('');
  });

  it('链接与来源文字', () => {
    expect(documentHref('acme', 'PAN-PRD-3')).toBe('/acme/documents/PAN-PRD-3');
    expect(sourceLabel({ source: 'native', externalProvider: 'wecom' })).toBe('Flower 文档');
    expect(sourceLabel({ source: 'external', externalProvider: 'wecom' })).toBe('企业微信文档');
    expect(sourceLabel({ source: 'external', externalProvider: null })).toBe('外部链接');
  });
});

describe('详情页辅助', () => {
  it('需求编号：逗号、顿号、空白分隔，转大写、去重，丢弃不合法的写法', () => {
    expect(parseRequirementKeys(' pan-1，PAN-2、PAN-1  x-y PAN-03 ')).toEqual(['PAN-1', 'PAN-2', 'PAN-03']);
    expect(parseRequirementKeys('')).toEqual([]);
  });

  it('保存状态文字', () => {
    expect(saveStateLabel('saved', true)).toBe('已保存');
    expect(saveStateLabel('dirty', true)).toBe('未保存');
    expect(saveStateLabel('saving', true)).toBe('保存中…');
    expect(saveStateLabel('saved', false)).toBe('只读');
  });
});
