import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addAffectedNode } from '../src/documents/affected';
import { createDocument, type DocumentDetail, listRevisions, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import { applyMerge, listMergeRecords } from '../src/documents/merge';
import type { Actor } from '../src/domain-types';
import type { LinkCard } from '../src/links/cards';
import { getRequirementByKey } from '../src/requirements/detail';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createRequirement } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let pan: string;
let storage: StructureNodeView;
let upload: StructureNodeView;
let download: StructureNodeView;
let chunk: StructureNodeView;
let prd: DocumentDetail;
let moduleId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  editor = await asMember(t.db, owner, '编辑甲');
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  await createStructureNode(t.db, owner, pan, { parentId: download.id, name: '离线下载' });
  prd = await createDocument(t.db, owner, pan, { title: '上传改版' }); // PAN-PRD-1
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: prd.version, markdown: '## 需求说明\n\n上传改为分片' });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: chunk.id, changeType: 'added', sourceSections: ['需求说明'] });
  for (const to of ['review', 'approved', 'launched'] as const) await transitionDocument(t.db, owner, prd.id, { to });
  moduleId = (await applyMerge(t.db, editor, prd.id, chunk.id, { baseVersion: null, body: '上传改为分片' })).moduleDocument!.id; // PAN-PRD-2
});
afterAll(() => t.cleanup());

describe('合入历史', () => {
  it('修订列表带合入来源；合入记录列出功能点、变更类型、来源 PRD 与处理人', async () => {
    const revs = await listRevisions(t.db, owner, moduleId);
    expect(revs.map((r) => [r.number, r.summary, r.mergedFrom])).toEqual([
      [2, '合入 PAN-PRD-1：分片上传', { id: prd.id, displayKey: 'PAN-PRD-1', title: '上传改版' }],
      [1, null, null],
    ]);
    const records = await listMergeRecords(t.db, owner, moduleId);
    expect(records).toMatchObject([
      { revisionNumber: 2, changeType: 'added', feature: { id: chunk.id, name: '分片上传' }, changeDocument: { id: prd.id, displayKey: 'PAN-PRD-1', title: '上传改版' }, by: { displayName: '编辑甲' } },
    ]);
    expect(records[0]!.mergedAt).toBeInstanceOf(Date);
    expect(await listMergeRecords(t.db, owner, prd.id)).toEqual([]);
    expect((await listRevisions(t.db, owner, prd.id)).every((r) => r.mergedFrom === null)).toBe(true);
  });

  it('节点链接卡：模块与功能点指向模块文档（功能点带小节）；模块还没有文档时指向模块文档页签；业务域仍指向需求列表', async () => {
    const src = await createRequirement(t.db, owner, pan, {
      title: '引用方',
      description: '[[存储]] [[存储/上传]] [[存储/上传/分片上传]] [[存储/下载]] [[存储/下载/离线下载]]',
    });
    const cards = Object.fromEntries((await getRequirementByKey(t.db, owner, src.displayKey)).links.map((c: LinkCard) => [c.text, c.href]));
    expect(cards).toEqual({
      'PAN/存储': `requirements?product=PAN&node=${storage.id}`,
      'PAN/存储/上传': 'documents/PAN-PRD-2',
      'PAN/存储/上传/分片上传': `documents/PAN-PRD-2?section=${encodeURIComponent('分片上传')}`,
      'PAN/存储/下载': `documents?product=PAN&view=modules&node=${download.id}`,
      'PAN/存储/下载/离线下载': `documents?product=PAN&view=modules&node=${download.id}`,
    });
  });
});
