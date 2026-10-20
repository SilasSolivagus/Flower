import { describe, expect, it } from 'vitest';
import type { DocumentComment, StructureNode } from '@/lib/types';
import { base64ToBytes, briefFilterSummary, briefFilterToApiQuery, briefFilterToSearch, briefsHref, CHANGE_TYPE_LABEL, clipContext, convertMessage, countRemoteImages, DOCUMENT_STATUS_COLOR, documentFilterToApiQuery, documentFilterToSearch, documentHref, documentView, domainOptions, editorAnchors, featureOptions, findDataImages, findSectionIndex, gateBreakdown, gateLabel, groupThreads, importSummary, invalidRequirementKeys, locateAnchorRange, MERGE_STATUS_LABEL, moduleDocsHref, moduleOptions, parseBriefFilter, parseDocumentFilter, parseRelatedInput, parseRequirementKeys, pendingQuestionLine, relatedLinkHref, replaceImageSources, saveStateLabel, sectionsFromBody, sourceLabel } from './model';

describe('PRD 列表筛选', () => {
  it('地址栏 ↔ 筛选；无效的状态与来源被忽略', () => {
    const f = parseDocumentFilter(new URLSearchParams('product=PAN&status=review&source=external&owner=m1&q=支付'));
    expect(f).toEqual({ product: 'PAN', status: 'review', owner: 'm1', source: 'external', q: '支付' });
    expect(parseDocumentFilter(new URLSearchParams('status=bogus&source=x'))).toEqual({ product: '', status: '', owner: '', source: '', q: '' });
    expect(documentFilterToSearch(f)).toBe('product=PAN&status=review&owner=m1&source=external&q=%E6%94%AF%E4%BB%98');
    expect(documentFilterToApiQuery(f)).toBe('status=review&owner=m1&source=external&q=%E6%94%AF%E4%BB%98');
    expect(documentFilterToApiQuery({ product: 'PAN', status: '', owner: '', source: '', q: '' })).toBe('');
    expect(parseDocumentFilter(new URLSearchParams('status=merged')).status).toBe('merged');
    expect(parseDocumentFilter(new URLSearchParams('status=archived')).status).toBe('');
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
    expect(invalidRequirementKeys(' pan-1，PAN12、x-y ')).toEqual(['PAN12', 'x-y']);
    expect(invalidRequirementKeys('PAN-1, PAN-2')).toEqual([]);
    expect(invalidRequirementKeys('  ')).toEqual([]);
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

describe('小节跳转', () => {
  it('按归一化标题找第一个匹配的标题', () => {
    expect(findSectionIndex(['1. 背景', '2. 需求 说明', '3. 需求说明'], '需求说明')).toBe(1);
    expect(findSectionIndex(['1. 背景'], '方案')).toBe(-1);
  });
});

describe('评论锚点在编辑器中的位置', () => {
  const segs = [
    { text: '上传大文件时', pos: 1 },
    { text: '经常超时', pos: 8 },
    { text: '。下载也经常超时', pos: 20 },
  ];

  it('跨文本节点、忽略空白；多处出现时按前后文取', () => {
    expect(locateAnchorRange(segs, { quote: '经常超时', prefix: '上传大文件时', suffix: '。' })).toEqual({ from: 8, to: 12 });
    expect(locateAnchorRange(segs, { quote: '经常超时', prefix: '下载也', suffix: '' })).toEqual({ from: 24, to: 28 });
    expect(locateAnchorRange(segs, { quote: '大 文件', prefix: '', suffix: '' })).toEqual({ from: 3, to: 6 });
    expect(locateAnchorRange(segs, { quote: '不存在', prefix: '', suffix: '' })).toBeNull();
  });

  it('只高亮顶层、定位正常、未解决的划词评论', () => {
    const base = { parentId: null, author: null, body: 'x', resolvedAt: null, resolvedBy: null, createdAt: '2026-10-09T00:00:00.000Z', links: [] };
    const anchor = { quote: '经常超时', prefix: 'p', suffix: 's', sectionHeading: null };
    const list = [
      { ...base, id: 'a', anchor, anchorState: 'ok' as const },
      { ...base, id: 'b', anchor, anchorState: 'stale' as const },
      { ...base, id: 'c', anchor, anchorState: 'ok' as const, resolvedAt: '2026-10-09T01:00:00.000Z' },
      { ...base, id: 'd', anchor: null, anchorState: null },
      { ...base, id: 'e', anchor, anchorState: 'ok' as const, parentId: 'a' },
    ];
    expect(editorAnchors(list)).toEqual([{ id: 'a', quote: '经常超时', prefix: 'p', suffix: 's' }]);
  });
});

describe('模块文档页签', () => {
  it('页签只由地址栏的 view 决定；模块文档页签的地址带产品与要定位的模块', () => {
    expect(documentView(new URLSearchParams('product=PAN&view=modules'))).toBe('modules');
    expect(documentView(new URLSearchParams('product=PAN'))).toBe('change');
    expect(documentView(new URLSearchParams('view=bogus'))).toBe('change');
    expect(moduleDocsHref('acme', 'PAN')).toBe('/acme/documents?product=PAN&view=modules');
    expect(moduleDocsHref('acme', 'PAN', 'n1')).toBe('/acme/documents?product=PAN&view=modules&node=n1');
  });

  it('变更类型与合入状态的文字', () => {
    expect(CHANGE_TYPE_LABEL).toEqual({ added: '新增', modified: '修改', removed: '删除' });
    expect(MERGE_STATUS_LABEL).toEqual({ pending: '待合入', applied: '已应用', skipped: '已跳过' });
  });
});

describe('声明影响的选项', () => {
  const N = (id: string, parentId: string | null, depth: number, name: string, sort: number, status: 'active' | 'deprecated' = 'active'): StructureNode => ({
    id,
    parentId,
    depth,
    name,
    description: null,
    status,
    sort,
  });
  const NODES = [
    N('d1', null, 1, '存储', 0),
    N('m1', 'd1', 2, '上传', 0),
    N('f1', 'm1', 3, '分片上传', 0),
    N('f2', 'm1', 3, '秒传', 1),
    N('m2', 'd1', 2, '旧模块', 1, 'deprecated'),
    N('f3', 'm2', 3, '旧功能', 0),
    N('d2', null, 1, '会员', 1),
  ];

  it('功能点：第三层、本身与上级都没停用、未声明，按路径搜索，按树的顺序', () => {
    expect(featureOptions(NODES, '', new Set())).toEqual([
      { id: 'f1', path: '存储/上传/分片上传' },
      { id: 'f2', path: '存储/上传/秒传' },
    ]);
    expect(featureOptions(NODES, ' 秒 ', new Set())).toEqual([{ id: 'f2', path: '存储/上传/秒传' }]);
    expect(featureOptions(NODES, '上传', new Set(['f1']))).toEqual([{ id: 'f2', path: '存储/上传/秒传' }]);
    expect(featureOptions(NODES, '旧功能', new Set())).toEqual([]);
  });

  it('模块与业务域：没停用的', () => {
    expect(moduleOptions(NODES)).toEqual([{ id: 'm1', path: '存储/上传' }]);
    expect(domainOptions(NODES)).toEqual([
      { id: 'd1', path: '存储' },
      { id: 'd2', path: '会员' },
    ]);
  });
});

describe('简报列表与链接', () => {
  it('页签由地址栏决定；地址栏 ↔ 筛选；无效状态被忽略；接口查询带产品 id', () => {
    expect(documentView(new URLSearchParams('view=briefs'))).toBe('briefs');
    expect(documentView(new URLSearchParams('view=bogus'))).toBe('change');
    expect(briefsHref('acme', 'PAN')).toBe('/acme/documents?product=PAN&view=briefs');
    const f = parseBriefFilter(new URLSearchParams('product=PAN&view=briefs&status=ready&decider=m1'));
    expect(f).toEqual({ product: 'PAN', status: 'ready', decider: 'm1' });
    expect(parseBriefFilter(new URLSearchParams('status=draft')).status).toBe('');
    expect(briefFilterToSearch(f)).toBe('product=PAN&view=briefs&status=ready&decider=m1');
    expect(briefFilterToSearch({ product: 'PAN', status: '', decider: '' })).toBe('product=PAN&view=briefs');
    expect(briefFilterToApiQuery(f, 'p1')).toBe('product=p1&status=ready&decider=m1');
    expect(briefFilterToApiQuery({ product: '', status: '', decider: '' }, 'p1')).toBe('product=p1');
  });

  it('检查进度、生成 PRD 的结果提示；简报状态有颜色', () => {
    expect(gateLabel({ passed: 7, total: 11 })).toBe('7/11');
    expect(gateLabel({ passed: 11, total: 11 })).toBe('11/11');
    expect(gateBreakdown([{ auto: true, passed: true }, { auto: true, passed: false }, { auto: false, passed: true }])).toBe('系统 1 · 人工 1');
    expect(briefFilterSummary({ product: 'PAN', status: 'ready', decider: 'm1' }, '林澄')).toBe('可以写 PRD、确认人 林澄');
    expect(briefFilterSummary({ product: 'PAN', status: '', decider: '' }, null)).toBe('');
    expect(convertMessage({ document: { displayKey: 'PAN-PRD-5' }, skipped: [] })).toBe('已生成 PAN-PRD-5');
    expect(
      convertMessage({
        document: { displayKey: 'PAN-PRD-5' },
        skipped: [
          { displayKey: 'PAN-2', documentKey: 'PAN-PRD-1' },
          { displayKey: 'PAN-7', documentKey: 'PAN-PRD-3' },
        ],
      }),
    ).toBe('已生成 PAN-PRD-5；以下需求已挂在其他 PRD 上，未关联到新 PRD：PAN-2（PAN-PRD-1）、PAN-7（PAN-PRD-3）');
    for (const s of ['discussing', 'ready', 'converted'] as const) expect(DOCUMENT_STATUS_COLOR[s]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('确认人任务条取出第 16 节第一条待定问题', () => {
    const md = ['## 16. 待定问题', '', '| # | 问题 | 选项 | 建议 | 待谁定 | 是否阻塞 PRD |', '| --- | --- | --- | --- | --- | --- |', '| 1 | 重试间隔 | 1 秒 / 3 秒 | 3 秒 | 后端 | 否 |', '| 2 | 开关名 | | | | 是 |'].join('\n');
    expect(pendingQuestionLine(md)).toBe('请确认第 16 节：重试间隔（选项 1 秒 / 3 秒，建议 3 秒，待 后端 定）。还有 1 个。');
    expect(pendingQuestionLine('## 1. 问题与目标\n\n没有待定问题')).toBe('请确认问题、规则、指标与上线策略。');
  });

  it('关联文档：输入解析与站内地址', () => {
    expect(parseRelatedInput(' https://doc.example.com/x ', ' 群聊 ')).toEqual({ kind: 'url', url: 'https://doc.example.com/x', note: '群聊' });
    expect(parseRelatedInput('[[pan-prd-3]]', '')).toEqual({ kind: 'wiki', target: 'pan-prd-3', note: '' });
    expect(parseRelatedInput('PAN-12', '原需求')).toEqual({ kind: 'wiki', target: 'PAN-12', note: '原需求' });
    expect(parseRelatedInput('  ', '')).toBeNull();
    expect(parseRelatedInput('[[ ]]', '')).toBeNull();
    expect(relatedLinkHref('acme', 'pan-prd-3')).toBe('/acme/documents/PAN-PRD-3');
    expect(relatedLinkHref('acme', 'PAN-B-2#数据依据')).toBe('/acme/documents/PAN-B-2');
    expect(relatedLinkHref('acme', 'PAN-12')).toBe('/acme/requirements/PAN-12');
    expect(relatedLinkHref('acme', 'PAN-T-4')).toBe('/acme/tasks/PAN-T-4');
    expect(relatedLinkHref('acme', '上传/分片')).toBeNull();
  });
});
