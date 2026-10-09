import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { type DocumentDetail, getDocument, listRevisions, saveDocumentContent } from '../src/documents/documents';
import { createModuleDocument } from '../src/documents/module-docs';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createStructureNode, updateStructureNode } from '../src/structure/nodes';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let storage: StructureNodeView;
let upload: StructureNodeView;
let chunk: StructureNodeView;
let doc: DocumentDetail;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '秒传' });
  doc = await createModuleDocument(t.db, owner, upload.id);
  await saveDocumentContent(t.db, owner, doc.id, { baseVersion: doc.version, markdown: '总述\n\n## 1. 分片上传\n\n说明\n\n## 秒传\n\n秒传说明\n' });
});
afterAll(() => t.cleanup());

describe('功能点改名', () => {
  it('同步模块文档里该小节的标题（保留编号），生成一版并记录事件', async () => {
    const before = await getDocument(t.db, owner, doc.id);
    await updateStructureNode(t.db, owner, chunk.id, { name: '断点续传' });
    const after = await getDocument(t.db, owner, doc.id);
    expect(after.markdown).toBe('总述\n\n## 1. 断点续传\n\n说明\n\n## 秒传\n\n秒传说明\n');
    expect(after.version).toBe(before.version + 1);
    expect((await listRevisions(t.db, owner, doc.id))[0]).toMatchObject({ number: before.revisionNumber! + 1, summary: '功能点改名：分片上传 → 断点续传' });
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'document.section_renamed'));
    expect(events.map((e) => [e.subjectId, (e.payload as { changes: unknown }).changes])).toEqual([[doc.id, [{ field: 'section', old: '分片上传', new: '断点续传' }]]]);
  });

  it('找不到小节、模块或业务域改名、只改说明时不动模块文档；没有模块文档的模块下改名照常', async () => {
    const v = (await getDocument(t.db, owner, doc.id)).version;
    const extra = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '离线上传' });
    await updateStructureNode(t.db, owner, extra.id, { name: '离线' });
    await updateStructureNode(t.db, owner, upload.id, { name: '上传中心' });
    await updateStructureNode(t.db, owner, storage.id, { name: '存储服务' });
    await updateStructureNode(t.db, owner, chunk.id, { description: '只改说明' });
    expect((await getDocument(t.db, owner, doc.id)).version).toBe(v);
    const download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
    const offline = await createStructureNode(t.db, owner, pan, { parentId: download.id, name: '离线下载' });
    expect((await updateStructureNode(t.db, owner, offline.id, { name: '后台下载' })).name).toBe('后台下载');
  });
});
