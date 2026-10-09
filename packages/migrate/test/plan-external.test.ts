import { describe, expect, it } from 'vitest';
import type { LegacyData } from '../src/legacy-types';
import { buildImportPlan } from '../src/plan';
import { deriveExternalStatus } from '../src/plan-external';
import { renderReport } from '../src/report';
import type { ImportOptions } from '../src/plan-types';
import { makeLegacyData, reviewedMapping, withPrdPages } from './fixtures';

const OPTS: ImportOptions = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null };

/** X001、X002 共用一份企业微信文档（分享码不同）；X001 在 push 里写了另一个网址；push 独有的离线下载有链接；已搁置需求的链接其实是一段文字；被合并的 push 需求有一个只有它用的链接。 */
function withLinks(data: LegacyData = makeLegacyData()): LegacyData {
  const plane = (id: string) => data.plane.requirements.find((r) => r.id === id)!;
  const push = (id: number) => data.push.requirements.find((r) => r.id === id)!;
  plane('X001').prd_link = 'https://doc.weixin.qq.com/doc/w3_A?scode=one';
  plane('X002').prd_link = ' https://doc.weixin.qq.com/doc/w3_A?scode=two ';
  push(1).prd_url = 'https://docs.qq.com/doc/B';
  push(3).prd_url = 'https://docs.qq.com/doc/C/';
  push(5).prd_url = '需求仅设计了流程图';
  push(4).prd_url = 'https://docs.qq.com/doc/D';
  return data;
}

describe('外部 PRD 的状态推导', () => {
  it('取最靠后的 prd_status；都不参与时为草稿；已通过且全部已上线时为已上线', () => {
    expect(deriveExternalStatus([{ prdStatus: 'approved', stateKey: 'developing' }, { prdStatus: 'not-started', stateKey: 'collect' }])).toBe('approved');
    expect(deriveExternalStatus([{ prdStatus: 'submitted', stateKey: 'collect' }, { prdStatus: 'in-progress', stateKey: 'collect' }])).toBe('review');
    expect(deriveExternalStatus([{ prdStatus: 'not-needed', stateKey: 'launched' }, { prdStatus: null, stateKey: 'launched' }])).toBe('draft');
    expect(deriveExternalStatus([{ prdStatus: 'approved', stateKey: 'launched' }, { prdStatus: null, stateKey: 'launched' }])).toBe('launched');
  });
});

describe('导入计划：外部 PRD', () => {
  it('按规范化网址去重，每个网址一份外部 PRD；123plane 优先；不是网址、两边不一致、只被合并需求用到的写入报告', () => {
    const data = withLinks();
    const { rows, report } = buildImportPlan(data, reviewedMapping(data), OPTS);
    expect(report.problems).toEqual([]);
    const ext = rows.documents.filter((d) => d.source === 'external');
    expect(ext.map((d) => [d.number, d.title, d.externalUrl, d.externalUrlKey, d.externalProvider, d.status])).toEqual([
      [1, '批量下载', 'https://doc.weixin.qq.com/doc/w3_A?scode=one', 'https://doc.weixin.qq.com/doc/w3_A', 'wecom', 'approved'],
      [2, '离线下载', 'https://docs.qq.com/doc/C/', 'https://docs.qq.com/doc/C', 'tencent_docs', 'draft'],
    ]);
    const byKey = (legacyKey: string) => rows.requirements.find((r) => r.legacyKey === legacyKey)!;
    expect(byKey('X001').changeDocumentId).toBe(ext[0]!.id);
    expect(byKey('X002').changeDocumentId).toBe(ext[0]!.id);
    expect(byKey('push-3').changeDocumentId).toBe(ext[1]!.id);
    expect(byKey('push-5').changeDocumentId ?? null).toBeNull();
    expect(rows.products[0]!.documentSeq).toBe(2);
    expect(report.documents.external).toMatchObject({
      docs: 2,
      requirements: 3,
      shared: 1,
      statusCounts: { approved: 1, draft: 1 },
      nonUrl: [{ displayKey: 'PAN-5', source: 'push', value: '需求仅设计了流程图' }],
      mismatches: [{ displayKey: 'PAN-1', plane: 'https://doc.weixin.qq.com/doc/w3_A?scode=one', push: 'https://docs.qq.com/doc/B' }],
      mergedOnly: 1,
    });
    expect(report.documents.prdCheckChanges).toEqual([
      { displayKey: 'PAN-2', document: 'PAN-PRD-1', from: 'not_started', to: 'passed' },
      { displayKey: 'PAN-4', document: 'PAN-PRD-2', from: 'not_started', to: 'in_progress' },
    ]);
    expect(report.skipped.map((s) => s.what)).not.toContain('123plane 外部 PRD 链接');
    const md = renderReport(report);
    expect(md).toContain('| 外部 PRD | 2 |');
    expect(md).toContain('| PAN-1 | https://doc.weixin.qq.com/doc/w3_A?scode=one | https://docs.qq.com/doc/B |');
    expect(md).toContain('| PAN-4 | PAN-PRD-2 | not_started | in_progress |');
    expect(rows.workflowVersions[0]!.body).toMatchObject({ checkItems: expect.arrayContaining([expect.objectContaining({ key: 'prd', auto: 'prd_status' })]) });
  });

  it('已挂 prd 系统页面的需求不再挂外部 PRD，写入报告；外部 PRD 编号排在 prd 页面之后', () => {
    const data = withLinks(withPrdPages());
    const { rows, report } = buildImportPlan(data, reviewedMapping(data), OPTS);
    expect(report.problems).toEqual([]);
    expect(rows.documents.map((d) => [d.number, d.source])).toEqual([
      [1, 'native'],
      [2, 'native'],
      [3, 'external'],
      [4, 'external'],
    ]);
    expect(report.documents.external.skippedNative).toEqual([{ displayKey: 'PAN-1', url: 'https://doc.weixin.qq.com/doc/w3_A?scode=one' }]);
    const shared = rows.documents.find((d) => d.externalUrlKey === 'https://doc.weixin.qq.com/doc/w3_A')!;
    expect(shared).toMatchObject({ title: '相册归类', externalUrl: 'https://doc.weixin.qq.com/doc/w3_A?scode=two', status: 'draft' });
    expect(rows.products[0]!.documentSeq).toBe(4);
  });

  it('prd 页面编号不连续时，外部 PRD 编号接在最大编号之后，不与之重复', () => {
    const data = withLinks(withPrdPages());
    data.prd.pages[0]!.status = 'archived';
    const { rows } = buildImportPlan(data, reviewedMapping(data), OPTS);
    expect(rows.documents.map((d) => [d.number, d.source])).toEqual([
      [2, 'native'],
      [3, 'external'],
      [4, 'external'],
    ]);
    expect(rows.products[0]!.documentSeq).toBe(4);
  });
});
