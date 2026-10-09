import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDocumentCheckItemState } from '../src/documents/checks';
import { addDocumentComment } from '../src/documents/comments';
import { linkDocumentRequirements } from '../src/documents/coverage';
import { createDocument, getDocumentByKey, listDocuments, restoreRevision, saveDocumentContent, transitionDocument, updateDocument } from '../src/documents/documents';
import { createModuleDocument, listModuleDocuments } from '../src/documents/module-docs';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createRequirement } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;
let storage: StructureNodeView;
let upload: StructureNodeView;
let download: StructureNodeView;
let chunk: StructureNodeView;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  await createDocument(t.db, owner, pan, { title: '变更一' }); // PAN-PRD-1
});
afterAll(() => t.cleanup());

describe('模块文档', () => {
  it('第一次打开模块时新建：编号沿用产品文档编号，标题为模块名称，概述为空；再次打开返回同一份', async () => {
    const d = await createModuleDocument(t.db, editor, upload.id);
    expect(d).toMatchObject({
      displayKey: 'PAN-PRD-2',
      kind: 'module',
      source: 'native',
      title: '上传',
      status: 'active',
      owner: null,
      markdown: '',
      revisionNumber: 1,
      version: 1,
      transitions: ['archived'],
      checkItems: [],
      requirements: [],
      node: { id: upload.id, name: '上传', status: 'active', domain: { id: storage.id, name: '存储' } },
    });
    expect((await createModuleDocument(t.db, owner, upload.id)).id).toBe(d.id);
    expect((await getDocumentByKey(t.db, viewer, 'PAN-PRD-2')).kind).toBe('module');
    expect((await listDocuments(t.db, owner, pan)).map((x) => [x.displayKey, x.kind])).toEqual([['PAN-PRD-1', 'change']]);
  });

  it('只有模块节点可以有模块文档；只读成员与只读 Token 不能新建', async () => {
    await expect(createModuleDocument(t.db, owner, storage.id)).rejects.toThrow('只有模块节点可以有模块文档');
    await expect(createModuleDocument(t.db, owner, chunk.id)).rejects.toThrow('只有模块节点可以有模块文档');
    await expect(createModuleDocument(t.db, viewer, download.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createModuleDocument(t.db, readOnlyToken(owner), download.id)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('模块文档列表：按业务域 → 模块列出，是否已有文档、功能点数、最近合入时间', async () => {
    const tree = await listModuleDocuments(t.db, viewer, pan);
    expect(tree.productKey).toBe('PAN');
    expect(tree.groups.map((g) => g.domain)).toEqual([{ id: storage.id, name: '存储', status: 'active' }]);
    expect(tree.groups[0]!.modules.map((m) => [m.node.name, m.featureCount, m.document?.displayKey ?? null, m.document?.status ?? null, m.lastMergedAt])).toEqual([
      ['上传', 1, 'PAN-PRD-2', 'active', null],
      ['下载', 0, null, null, null],
    ]);
  });

  it('与变更 PRD 相同的正文编辑与评论；不关联需求、没有检查项', async () => {
    const d = await createModuleDocument(t.db, owner, upload.id);
    const saved = await saveDocumentContent(t.db, owner, d.id, { baseVersion: d.version, markdown: '上传模块总述\n\n## 分片上传\n\n见 [[PAN-PRD-1]]' });
    expect(saved).toMatchObject({ version: d.version + 1, revisionNumber: 2, merged: false });
    expect((await addDocumentComment(t.db, viewer, d.id, { body: '模块文档也能评论' })).body).toBe('模块文档也能评论');
    const req = await createRequirement(t.db, owner, pan, { title: '一条需求' });
    await expect(linkDocumentRequirements(t.db, owner, d.id, { requirementIds: [req.id] })).rejects.toThrow('模块文档不关联需求');
    await expect(setDocumentCheckItemState(t.db, owner, d.id, 'prd_review', { state: 'passed' })).rejects.toThrow('模块文档没有检查项');
  });

  it('归档后只读：不能改正文、标题、恢复版本；评论照常；可以恢复为使用中', async () => {
    const d = await createModuleDocument(t.db, owner, download.id);
    const archived = await transitionDocument(t.db, editor, d.id, { to: 'archived' });
    expect(archived).toMatchObject({ status: 'archived', transitions: ['active'] });
    await expect(saveDocumentContent(t.db, owner, d.id, { baseVersion: archived.version, markdown: 'x' })).rejects.toThrow('模块文档已归档，恢复为使用中后才能修改');
    await expect(updateDocument(t.db, owner, d.id, { title: '新标题' })).rejects.toThrow('模块文档已归档');
    await expect(restoreRevision(t.db, owner, d.id, { number: 1, baseVersion: archived.version })).rejects.toThrow('模块文档已归档');
    await addDocumentComment(t.db, viewer, d.id, { body: '归档后也能评论' });
    await expect(transitionDocument(t.db, owner, d.id, { to: 'draft' })).rejects.toThrow('不能从「已归档」改为「草稿」');
    expect((await transitionDocument(t.db, owner, d.id, { to: 'active' })).status).toBe('active');
  });
});
