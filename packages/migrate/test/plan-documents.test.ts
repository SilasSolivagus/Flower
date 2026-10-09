import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyUuid } from '../src/ids';
import { buildImportPlan } from '../src/plan';
import { checkImage, resolveUpload } from '../src/plan-documents';
import type { ImportOptions } from '../src/plan-types';
import { renderReport } from '../src/report';
import { INLINE_PNG, LEGACY_FILE, reviewedMapping, withPrdPages } from './fixtures';

/** 临时的 prd_uploads 导出目录（虚构文件）。 */
function uploadsWith(files: Record<string, Buffer | string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prd-uploads-'));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, name), bytes);
  return dir;
}

const OPTS: ImportOptions = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null, uploadsDir: uploadsWith({ [LEGACY_FILE]: Buffer.from(INLINE_PNG, 'base64') }) };

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
    expect(report.documents).toMatchObject({ pages: 2, revisions: 4, attachments: 1, inlineImages: 1, comments: 2, linkedRequirements: 1, missingFiles: 0, unmatchedLinks: [], droppedImages: [] });
    expect(report.skipped).toEqual(
      expect.arrayContaining([{ what: 'prd 已删除的页面（连同其修订 1 条、附件 1 个、评论 1 条）', count: 1, reason: '页面已在 prd 系统中删除' }]),
    );
    expect(report.deferred.map((d) => d.what)).not.toContain('PRD 页面');
    const md = renderReport(report);
    expect(md).toContain('## PRD 文档（prd 系统）');
    expect(md).toContain('| 附件文件缺失 | 0 |');
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
    const p = buildImportPlan(d, reviewedMapping(d), { ...OPTS, uploadsDir: undefined });
    expect(p.report.documents.missingFiles).toBeNull();
  });

  it('内嵌图片按内容嗅探：SVG 不抽出，从正文删去并列入报告；声明类型与内容不符时按嗅探出的类型保存', () => {
    const d = withPrdPages();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
    d.prd.pages[1]!.markdown = `## 背景\n\n![图一](data:image/svg+xml;base64,${svg})\n\n![图二](data:image/jpeg;base64,${INLINE_PNG})\n\n正文`;
    const p = buildImportPlan(d, reviewedMapping(d), OPTS);
    expect(p.report.problems).toEqual([]);
    const doc2 = p.rows.documents.find((x) => x.legacyKey === 'prd:pg2')!;
    const current = p.rows.documentRevisions.find((r) => r.id === doc2.currentRevisionId)!.snapshot.markdown;
    const atts = p.rows.attachments.filter((a) => a.targetId === doc2.id);
    expect(atts.map((a) => [a.mime, a.storageKey.endsWith('.png')])).toEqual([['image/png', true]]);
    expect(current).toBe(`## 背景\n\n[图片未迁移]\n\n![图二](/api/v1/orgs/pan123/attachments/${atts[0]!.id})\n\n正文`);
    expect(p.report.documents.droppedImages).toEqual([{ document: 'PAN-PRD-2', reason: '内嵌图片：不是支持的图片格式（只支持 PNG、JPEG、GIF、WebP）' }]);
    expect(renderReport(p.report)).toContain('| 图片未迁移（正文与修订中换成「[图片未迁移]」） | 1 |');
  });

  describe('给了导出目录时，旧附件文件缺失、内容不合格或键无效的不导入：不建附件，正文与修订里的引用换成占位文字，列入报告', () => {
    const run = (uploads: Record<string, Buffer | string>, storageKey = LEGACY_FILE) => {
      const d = withPrdPages();
      d.prd.attachments[0]!.storage_key = storageKey;
      d.prd.pages[0]!.markdown = `## 背景\n\n![截图](/api/files/${storageKey})\n\n当前正文`;
      d.prd.pageVersions[1]!.markdown = `## 背景\n\n![截图](/api/files/${storageKey})\n\n第三版`;
      const p = buildImportPlan(d, reviewedMapping(d), { ...OPTS, uploadsDir: uploadsWith(uploads) });
      const doc1 = p.rows.documents.find((x) => x.legacyKey === 'prd:pg1')!;
      const revs = p.rows.documentRevisions.filter((r) => r.documentId === doc1.id).sort((a, b) => a.version - b.version);
      expect(p.report.problems).toEqual([]);
      expect(p.rows.attachments.filter((a) => a.targetId === doc1.id)).toEqual([]);
      expect(p.files).toEqual([]);
      expect(revs.map((r) => r.snapshot.markdown)).toEqual(['## 背景\n\n第一版', '## 背景\n\n[图片未迁移]\n\n第三版', '## 背景\n\n[图片未迁移]\n\n当前正文']);
      return p.report.documents;
    };

    it('文件缺失', () => {
      expect(run({})).toMatchObject({ attachments: 0, missingFiles: 1, droppedImages: [{ document: 'PAN-PRD-1', reason: '旧附件：导出目录中没有这个文件' }] });
    });
    it('内容不是支持的图片', () => {
      expect(run({ [LEGACY_FILE]: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })).toMatchObject({
        attachments: 0,
        missingFiles: 0,
        droppedImages: [{ document: 'PAN-PRD-1', reason: '旧附件：不是支持的图片格式（只支持 PNG、JPEG、GIF、WebP）' }],
      });
    });
    it('键跳出导出目录（不读取目录外的文件）', () => {
      expect(run({}, '../outside.png')).toMatchObject({
        attachments: 0,
        invalidFileKeys: 1,
        droppedImages: [{ document: 'PAN-PRD-1', reason: '旧附件：键无效（绝对路径或跳出导出目录），未读取' }],
      });
    });
  });

  it('旧附件登记的类型与文件内容不符时按嗅探出的类型保存', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const d = withPrdPages();
    const p = buildImportPlan(d, reviewedMapping(d), { ...OPTS, uploadsDir: uploadsWith({ [LEGACY_FILE]: jpeg }) });
    const att = p.rows.attachments.find((a) => a.filename === '截图.png')!;
    expect(att).toMatchObject({ mime: 'image/jpeg', sizeBytes: jpeg.byteLength });
    expect(att.storageKey.endsWith('.jpg')).toBe(true);
  });

  it('图片校验：超过 10 MB 拒绝；导出目录里的键不能是绝对路径或跳出目录', () => {
    const png = Buffer.from(INLINE_PNG, 'base64');
    expect(checkImage(png)).toEqual({ mime: 'image/png' });
    expect(checkImage(Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]))).toEqual({ reason: '超过 10 MB' });
    expect(resolveUpload('/data/uploads', LEGACY_FILE)).toBe(`/data/uploads/${LEGACY_FILE}`);
    for (const bad of ['../x.png', '/etc/passwd', 'a/../../x.png', '', '.']) expect(resolveUpload('/data/uploads', bad)).toBeNull();
  });
});
