import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { addAffectedNode, createNodeForDocument } from '../src/documents/affected';
import { createDocument, type DocumentDetail, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createStructureNode, updateStructureNode } from '../src/structure/nodes';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let readToken: Actor;
let pan: string;
let storage: StructureNodeView;
let prd: DocumentDetail;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
  storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  prd = await createDocument(t.db, owner, pan, { title: '上传改版' });
});
afterAll(() => t.cleanup());

describe('当场新建节点', () => {
  it('产品编辑可以在业务域下新建模块、在模块下新建功能点，然后声明；结构树服务本身仍要求产品管理员', async () => {
    await expect(createStructureNode(t.db, editor, pan, { parentId: storage.id, name: '直接新建' })).rejects.toMatchObject({ code: 'forbidden' });
    const mod = await createNodeForDocument(t.db, editor, prd.id, { parentId: storage.id, name: '上传' });
    expect(mod).toMatchObject({ parentId: storage.id, depth: 2, name: '上传', status: 'active' });
    const feature = await createNodeForDocument(t.db, editor, prd.id, { parentId: mod.id, name: ' 分片上传 ' });
    expect(feature).toMatchObject({ parentId: mod.id, depth: 3, name: '分片上传' });
    const declared = await addAffectedNode(t.db, editor, prd.id, { nodeId: feature.id, changeType: 'added' });
    expect(declared.items.map((i) => i.path)).toEqual(['存储/上传/分片上传']);
    const created = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'structure_node.created')).orderBy(asc(domainEvents.occurredAt));
    expect(created.filter((e) => e.actorMemberId === editor.memberId).map((e) => (e.payload as { name: string }).name)).toEqual(['上传', '分片上传']);
  });

  it('同名、在功能点下新建、在已停用的节点下新建都被拒绝', async () => {
    await expect(createNodeForDocument(t.db, editor, prd.id, { parentId: storage.id, name: '上传' })).rejects.toMatchObject({ code: 'conflict', message: '同一上级下已有同名节点' });
    const download = await createNodeForDocument(t.db, editor, prd.id, { parentId: storage.id, name: '下载中心' });
    const offline = await createNodeForDocument(t.db, editor, prd.id, { parentId: download.id, name: '离线下载' });
    await expect(createNodeForDocument(t.db, editor, prd.id, { parentId: offline.id, name: '更深一层' })).rejects.toThrow('只能在业务域下新建模块，或在模块下新建功能点');
    await updateStructureNode(t.db, owner, download.id, { status: 'deprecated' });
    await expect(createNodeForDocument(t.db, editor, prd.id, { parentId: download.id, name: '新功能' })).rejects.toThrow('不能在已停用的节点下新增');
  });

  it('只读成员不能新建；声明不能修改时（已废弃）也不能新建', async () => {
    await expect(createNodeForDocument(t.db, viewer, prd.id, { parentId: storage.id, name: '只读新建' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createNodeForDocument(t.db, readToken, prd.id, { parentId: storage.id, name: '只读 token 新建' })).rejects.toMatchObject({ code: 'forbidden' });
    const dropped = await createDocument(t.db, owner, pan, { title: '将废弃' });
    await transitionDocument(t.db, owner, dropped.id, { to: 'discarded' });
    await expect(createNodeForDocument(t.db, owner, dropped.id, { parentId: storage.id, name: '废弃后新建' })).rejects.toThrow('「已废弃」的 PRD 不能修改影响声明');
  });
});
