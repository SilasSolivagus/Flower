import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentAffectedNodes, domainEvents } from '../src/db/schema';
import { addAffectedNode, listAffectedNodes, removeAffectedNode, updateAffectedNode } from '../src/documents/affected';
import { createDocument, type DocumentDetail, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import { createModuleDocument } from '../src/documents/module-docs';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createStructureNode } from '../src/structure/nodes';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;
let other: string;
let upload: StructureNodeView;
let chunk: StructureNodeView;
let instant: StructureNodeView;
let offline: StructureNodeView;
let foreign: StructureNodeView;
let prd: DocumentDetail;

const PRD_BODY = '## 背景\n\n现状\n\n## 需求说明\n\n上传改为分片\n\n### 细节\n\n断点续传';

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  other = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  const storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  instant = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '秒传' });
  const download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
  offline = await createStructureNode(t.db, owner, pan, { parentId: download.id, name: '离线下载' });
  const album = await createStructureNode(t.db, owner, other, { name: '相册' });
  const share = await createStructureNode(t.db, owner, other, { parentId: album.id, name: '分享' });
  foreign = await createStructureNode(t.db, owner, other, { parentId: share.id, name: '分享链接' });
  prd = await createDocument(t.db, owner, pan, { title: '上传改版' });
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: prd.version, markdown: PRD_BODY });
});
afterAll(() => t.cleanup());

describe('影响声明', () => {
  it('新增、修改、移除；按结构树顺序列出，带路径、所属模块与来源小节；记录事件', async () => {
    await addAffectedNode(t.db, editor, prd.id, { nodeId: instant.id, changeType: 'modified', sourceSections: ['需求说明 / 细节'] });
    const added = await addAffectedNode(t.db, editor, prd.id, { nodeId: chunk.id, changeType: 'added', sourceSections: ['需求说明', '背景', '需求说明'] });
    expect(added).toMatchObject({ editable: true, locked: false, sections: ['背景', '需求说明', '需求说明 / 细节'] });
    expect(added.items.map((i) => [i.path, i.module?.name, i.changeType, i.sourceSections, i.mergeStatus])).toEqual([
      ['存储/上传/分片上传', '上传', 'added', [{ key: '需求说明', stale: false }, { key: '背景', stale: false }], 'pending'],
      ['存储/上传/秒传', '上传', 'modified', [{ key: '需求说明 / 细节', stale: false }], 'pending'],
    ]);
    const updated = await updateAffectedNode(t.db, editor, prd.id, chunk.id, { changeType: 'modified', sourceSections: ['背景'] });
    expect(updated.items[0]).toMatchObject({ changeType: 'modified', sourceSections: [{ key: '背景', stale: false }] });
    const removed = await removeAffectedNode(t.db, editor, prd.id, instant.id);
    expect(removed.items.map((i) => i.name)).toEqual(['分片上传']);
    const seen = await listAffectedNodes(t.db, viewer, prd.id);
    expect(seen).toMatchObject({ editable: false, locked: false });
    expect(seen.items).toHaveLength(1);
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'document.affected_nodes_changed')).orderBy(asc(domainEvents.occurredAt));
    expect(events.map((e) => (e.payload as { changes: Array<{ field: string }> }).changes.map((c) => c.field))).toEqual([['affectedNode'], ['affectedNode'], ['changeType', 'sourceSections'], ['affectedNode']]);
    expect((events[3]!.payload as { changes: unknown }).changes).toEqual([{ field: 'affectedNode', old: { path: '存储/上传/秒传', changeType: 'modified', sourceSections: ['需求说明 / 细节'] }, new: null }]);
  });

  it('校验：重复、不是本产品的功能点、来源小节不存在、外部 PRD 选来源', async () => {
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: chunk.id, changeType: 'added' })).rejects.toMatchObject({ code: 'conflict', message: '该功能点已声明' });
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: upload.id, changeType: 'added' })).rejects.toThrow('只能声明本产品结构树第三层的功能点');
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: foreign.id, changeType: 'added' })).rejects.toThrow('只能声明本产品结构树第三层的功能点');
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: offline.id, changeType: 'added', sourceSections: ['不存在'] })).rejects.toThrow('PRD 中没有这些小节：不存在');
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: offline.id, changeType: 'bogus' as 'added' })).rejects.toThrow('变更类型无效');
    const ext = await createDocument(t.db, owner, pan, { title: '外部', externalUrl: 'https://docs.qq.com/doc/affected' });
    await expect(addAffectedNode(t.db, owner, ext.id, { nodeId: offline.id, changeType: 'added', sourceSections: ['背景'] })).rejects.toThrow('外部 PRD 没有正文，不能选择来源小节');
    expect((await addAffectedNode(t.db, owner, ext.id, { nodeId: offline.id, changeType: 'added' })).sections).toEqual([]);
    const mod = await createModuleDocument(t.db, owner, upload.id);
    await expect(listAffectedNodes(t.db, owner, mod.id)).rejects.toThrow('模块文档没有影响声明');
  });

  it('PRD 小节改名后来源显示已失效；修改声明时已存的失效来源可以保留', async () => {
    const cur = await listAffectedNodes(t.db, owner, prd.id);
    expect(cur.items[0]!.sourceSections).toEqual([{ key: '背景', stale: false }]);
    const d = await saveDocumentContent(t.db, editor, prd.id, { baseVersion: 2, markdown: PRD_BODY.replace('## 背景', '## 现状分析') });
    expect(d.version).toBe(3);
    const after = await listAffectedNodes(t.db, owner, prd.id);
    expect(after.items[0]!.sourceSections).toEqual([{ key: '背景', stale: true }]);
    const kept = await updateAffectedNode(t.db, owner, prd.id, chunk.id, { changeType: 'added', sourceSections: ['背景', '现状分析'] });
    expect(kept.items[0]!.sourceSections).toEqual([{ key: '背景', stale: true }, { key: '现状分析', stale: false }]);
  });

  it('权限与锁定：只读成员与只读 Token 不能改；已废弃不能改；有一条已处理后全部锁定', async () => {
    await expect(addAffectedNode(t.db, viewer, prd.id, { nodeId: offline.id, changeType: 'added' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addAffectedNode(t.db, readOnlyToken(owner), prd.id, { nodeId: offline.id, changeType: 'added' })).rejects.toMatchObject({ code: 'forbidden' });
    const dropped = await createDocument(t.db, owner, pan, { title: '将废弃' });
    await transitionDocument(t.db, owner, dropped.id, { to: 'discarded' });
    await expect(addAffectedNode(t.db, owner, dropped.id, { nodeId: offline.id, changeType: 'added' })).rejects.toThrow('「已废弃」的 PRD 不能修改影响声明');

    await t.adminDb.update(documentAffectedNodes).set({ mergeStatus: 'skipped' }).where(and(eq(documentAffectedNodes.documentId, prd.id), eq(documentAffectedNodes.nodeId, chunk.id)));
    const locked = await listAffectedNodes(t.db, owner, prd.id);
    expect(locked).toMatchObject({ editable: false, locked: true });
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: offline.id, changeType: 'added' })).rejects.toThrow('已开始合入，影响声明不能再修改');
    await expect(updateAffectedNode(t.db, owner, prd.id, chunk.id, { changeType: 'removed' })).rejects.toThrow('已开始合入');
    await expect(removeAffectedNode(t.db, owner, prd.id, chunk.id)).rejects.toThrow('已开始合入');
  });
});
