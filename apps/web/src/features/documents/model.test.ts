import { describe, expect, it } from 'vitest';
import type { DocumentComment } from '@/lib/types';
import { base64ToBytes, clipContext, countRemoteImages, documentFilterToApiQuery, documentFilterToSearch, documentHref, findDataImages, groupThreads, importSummary, parseDocumentFilter, parseRequirementKeys, replaceImageSources, saveStateLabel, sectionsFromBody, sourceLabel } from './model';

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

describe('评论', () => {
  it('划词的前后文各取 32 个字符', () => {
    const before = '甲'.repeat(40) + '前文';
    expect(clipContext(before, '后文' + '乙'.repeat(40))).toEqual({ prefix: before.slice(-32), suffix: ('后文' + '乙'.repeat(40)).slice(0, 32) });
    expect(clipContext('', '')).toEqual({ prefix: '', suffix: '' });
  });

  it('按顶层评论分组，回复挂在所属评论下，找不到上级的回复当作顶层', () => {
    const c = (id: string, parentId: string | null) =>
      ({ id, parentId, author: null, body: id, anchor: null, anchorState: null, resolvedAt: null, resolvedBy: null, createdAt: '2026-10-08T00:00:00Z', links: [] as DocumentComment['links'] }) as const;
    expect(groupThreads([c('a', null), c('b', null), c('a1', 'a'), c('x1', 'gone')]).map((t) => [t.comment.id, t.replies.map((r) => r.id)])).toEqual([
      ['a', ['a1']],
      ['b', []],
      ['x1', []],
    ]);
  });
});

describe('导入与图片', () => {
  const md = '## 背景\n\n![a](data:image/png;base64,iVBORw0K)\n\n![b](data:image/png;base64,iVBORw0K)\n\n![c](https://wdcdn.qpic.cn/x.png)\n\n![d](data:image/svg+xml;base64,PHN2Zz4=)\n\n## 需求\n\n- 分片';

  it('找出可上传的 data: 图片（去重，SVG 不算），统计外部图片', () => {
    expect(findDataImages(md)).toEqual([{ src: 'data:image/png;base64,iVBORw0K', mime: 'image/png', base64: 'iVBORw0K' }]);
    expect(countRemoteImages(md)).toBe(1);
    expect(importSummary(md)).toEqual({ chars: md.length, sections: 2, images: 1, remoteImages: 1 });
  });

  it('按映射替换图片网址，其余不变', () => {
    const out = replaceImageSources(md, new Map([['data:image/png;base64,iVBORw0K', '/api/v1/orgs/acme/attachments/1']]));
    expect(out.match(/\/api\/v1\/orgs\/acme\/attachments\/1/g)).toHaveLength(2);
    expect(out).toContain('![c](https://wdcdn.qpic.cn/x.png)');
  });

  it('base64 → 字节', () => {
    expect([...base64ToBytes('iVBORw==')]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('模板', () => {
  it('从正文提取二级标题作为小节，默认选填', () => {
    expect(sectionsFromBody('# 标题\n\n## 1. 背景\n\n### 1.1 细节\n\n## 2. 方案\n')).toEqual([
      { heading: '1. 背景', required: false },
      { heading: '2. 方案', required: false },
    ]);
  });
});
