import { describe, expect, it } from 'vitest';
import { legacyUuid } from '../src/ids';
import { buildImportPlan } from '../src/plan';
import type { ImportOptions } from '../src/plan-types';
import { renderReport } from '../src/report';
import { INLINE_PNG, LEGACY_FILE, reviewedMapping, withPrdPages } from './fixtures';

const OPTS: ImportOptions = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null, availableUploads: new Set() };

describe('导入计划：prd 页面', () => {
  const data = withPrdPages();
  const { rows, report, files } = buildImportPlan(data, reviewedMapping(data), OPTS);
  const doc1 = rows.documents.find((d) => d.legacyKey === 'prd:pg1')!;
  const member = (name: string) => rows.members.find((m) => m.displayName === name)!.id;

  it('页面按创建时间编号；状态映射；负责人取 prd_meta.ownerUserId；预置模板一并导入', () => {
    expect(report.problems).toEqual([]);
    expect(rows.documents.map((d) => [d.number, d.legacyKey, d.status, d.source])).toEqual([
      [1, 'prd:pg1', 'launched', 'native'],
      [2, 'prd:pg2', 'approved', 'native'],
    ]);
    expect(doc1.ownerMemberId).toBe(member('李四'));
    expect(rows.products[0]!.documentSeq).toBe(2);
    expect(rows.documentTemplates.map((t) => t.name)).toEqual(['变更 PRD（预置）']);
  });

  it('修订按旧版本号升序重新编号；当前正文与最后一版不同时追加一版；图片引用改为附件网址，内嵌图片抽成附件', () => {
    const revs = rows.documentRevisions.filter((r) => r.documentId === doc1.id).sort((a, b) => a.version - b.version);
    expect(revs.map((r) => [r.version, r.summary])).toEqual([
      [1, null],
      [2, '补图'],
      [3, '迁移时的当前内容'],
    ]);
    expect(doc1).toMatchObject({ version: 3, currentRevisionId: revs[2]!.id });
    const legacyAtt = legacyUuid('pan123/attachment', 'prd:att1');
    const current = revs[2]!.snapshot.markdown;
    expect(current).toContain(`/api/v1/orgs/pan123/attachments/${legacyAtt}`);
    expect(current).not.toContain('data:');
    expect(current).not.toContain('/api/files/');
    expect(revs[1]!.snapshot.markdown).not.toContain('data:');
    expect(rows.attachments.map((a) => [a.filename, a.mime, a.targetId])).toEqual([
      ['截图.png', 'image/png', doc1.id],
      [expect.stringMatching(/^inline-[0-9a-f]{8}\.png$/), 'image/png', doc1.id],
    ]);
    expect(files).toEqual([
      { storageKey: rows.attachments[0]!.storageKey, from: { legacyKey: LEGACY_FILE } },
      { storageKey: rows.attachments[1]!.storageKey, from: { base64: INLINE_PNG } },
    ]);
  });

  it('评论导入为未定位，保留回复与解决状态；需求关联写入 change_document_id', () => {
    const cs = rows.comments.filter((c) => c.targetType === 'document');
    expect(cs.map((c) => [c.body, c.anchorState, c.anchor])).toEqual([
      ['这里要确认', 'unanchored', null],
      ['已确认', 'unanchored', null],
    ]);
    expect(cs[1]!.parentId).toBe(cs[0]!.id);
    expect(cs[1]!.resolvedBy).toBe(member('张三'));
    expect(rows.requirements.find((r) => r.legacyKey === 'X001')!.changeDocumentId).toBe(doc1.id);
  });

  it('对账报告：数量、缺失的附件文件、已删除页面计入跳过', () => {
    expect(report.documents).toMatchObject({ pages: 2, revisions: 4, attachments: 1, inlineImages: 1, comments: 2, linkedRequirements: 1, missingFiles: 1, unmatchedLinks: [] });
    expect(report.skipped).toEqual(
      expect.arrayContaining([{ what: 'prd 已删除的页面（连同其修订 1 条、附件 1 个、评论 1 条）', count: 1, reason: '页面已在 prd 系统中删除' }]),
    );
    expect(report.deferred.map((d) => d.what)).not.toContain('PRD 页面');
    const md = renderReport(report);
    expect(md).toContain('## PRD 文档（prd 系统）');
    expect(md).toContain('| 附件文件缺失 | 1 |');
  });

  it('关联的需求不在导入范围内时不算问题，列入未匹配的需求关联', () => {
    const d = withPrdPages();
    d.prd.pages[0]!.linked_requirement_id = 'X404';
    const p = buildImportPlan(d, reviewedMapping(d), OPTS);
    expect(p.report.problems).toEqual([]);
    expect(p.report.documents.linkedRequirements).toBe(0);
    expect(p.report.documents.unmatchedLinks).toEqual([{ document: 'PAN-PRD-1', requirement: 'X404' }]);
    expect(p.report.skipped).toEqual(expect.arrayContaining([{ what: 'prd 页面关联的需求在 123plane 与 push 中都不存在', count: 1, reason: '关联对象已不存在，PRD 照常导入、不挂需求' }]));
    expect(p.rows.requirements.every((r) => !r.changeDocumentId)).toBe(true);
    expect(renderReport(p.report)).toContain('| PAN-PRD-1 | X404 |');
  });

  it('没给导出目录时不统计缺失文件', () => {
    const d = withPrdPages();
    const p = buildImportPlan(d, reviewedMapping(d), { ...OPTS, availableUploads: undefined });
    expect(p.report.documents.missingFiles).toBeNull();
  });
});
