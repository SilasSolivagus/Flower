import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createModuleDocument } from '../src/documents/module-docs';
import { listStructureNodes } from '../src/requirements/lookups';
import { createStructureNode, moveStructureNode, reorderStructureNodes, updateStructureNode } from '../src/structure/nodes';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pm: Actor;
let editor: Actor;
let readToken: Actor;
let pan: string;
let doc: string;

const names = async () => (await listStructureNodes(t.db, owner, pan)).map((n) => [n.name, n.depth, n.parentId === null ? null : 'child', n.sort]);

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  const p = await createPlaceholderMember(t.db, owner, { displayName: '产品经理甲' });
  await setProductRole(t.db, owner, pan, p.id, 'admin');
  pm = { ...owner, memberId: p.id, orgRole: 'guest', accountId: null };
  const e = await createPlaceholderMember(t.db, owner, { displayName: '开发乙' });
  editor = { ...owner, memberId: e.id, orgRole: 'member', accountId: null };
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
});
afterAll(() => t.cleanup());

describe('结构树维护', () => {
  let member: string;
  let renew: string;
  let storage: string;

  it('产品管理员新建三层节点，同级按顺序编号；第四层被拒绝', async () => {
    member = (await createStructureNode(t.db, pm, pan, { name: '会员与支付', description: '会员、续费与支付' })).id;
    storage = (await createStructureNode(t.db, pm, pan, { name: '存储' })).id;
    renew = (await createStructureNode(t.db, pm, pan, { parentId: member, name: '续费' })).id;
    const leaf = await createStructureNode(t.db, pm, pan, { parentId: renew, name: '自动续费' });
    expect(leaf).toMatchObject({ depth: 3, sort: 0, status: 'active' });
    await expect(createStructureNode(t.db, pm, pan, { parentId: leaf.id, name: '第四层' })).rejects.toMatchObject({ code: 'invalid', message: '结构树最多 3 层' });
    expect(await names()).toEqual([
      ['会员与支付', 1, null, 0],
      ['存储', 1, null, 1],
      ['续费', 2, 'child', 0],
      ['自动续费', 3, 'child', 0],
    ]);
    expect((await listStructureNodes(t.db, owner, pan))[0]!.description).toBe('会员、续费与支付');
  });

  it('编辑、只读 Token 不能维护；同一上级下不能重名；上级必须属于同一产品', async () => {
    await expect(createStructureNode(t.db, editor, pan, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createStructureNode(t.db, readToken, pan, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateStructureNode(t.db, editor, member, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createStructureNode(t.db, pm, pan, { name: '存储' })).rejects.toMatchObject({ code: 'conflict', message: '同一上级下已有同名节点' });
    await expect(createStructureNode(t.db, owner, doc, { parentId: member, name: '跨产品' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createStructureNode(t.db, pm, pan, { name: '  ' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('改名、改说明、停用与恢复，记录变更；停用的节点下不能新增', async () => {
    const renamed = await updateStructureNode(t.db, pm, renew, { name: '续费管理', description: '续费相关功能' });
    expect(renamed).toMatchObject({ name: '续费管理', description: '续费相关功能' });
    await updateStructureNode(t.db, pm, storage, { status: 'deprecated' });
    await expect(createStructureNode(t.db, pm, pan, { parentId: storage, name: '空间' })).rejects.toMatchObject({ code: 'invalid' });
    expect((await updateStructureNode(t.db, pm, storage, { status: 'active' })).status).toBe('active');
    const events = await withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(eq(domainEvents.subjectId, renew)));
    expect(events.find((e) => e.type === 'structure_node.updated')!.payload).toMatchObject({
      changes: [{ field: 'name', old: '续费', new: '续费管理' }, { field: 'description', old: null, new: '续费相关功能' }],
    });
    await expect(updateStructureNode(t.db, pm, renew, { status: 'gone' as never })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('移动节点时子树整体平移深度；超过 3 层、移到自身下级都被拒绝', async () => {
    await expect(moveStructureNode(t.db, pm, member, { parentId: renew })).rejects.toMatchObject({ code: 'invalid', message: '不能移动到自身或下级节点之下' });
    await expect(moveStructureNode(t.db, pm, renew, { parentId: storage })).resolves.toMatchObject({ depth: 2 });
    await expect(moveStructureNode(t.db, pm, storage, { parentId: member })).rejects.toMatchObject({ code: 'invalid', message: '移动后层级超过 3 层' });
    const moved = await moveStructureNode(t.db, pm, renew, { parentId: null });
    expect(moved).toMatchObject({ depth: 1, parentId: null, sort: 2 });
    const all = await listStructureNodes(t.db, owner, pan);
    expect(all.find((n) => n.name === '自动续费')).toMatchObject({ depth: 2, parentId: renew });
  });

  it('同级排序必须包含全部同级节点，并记录每个节点的排序变更', async () => {
    const roots = (await listStructureNodes(t.db, owner, pan)).filter((n) => n.parentId === null);
    const reversed = roots.map((n) => n.id).reverse();
    const result = await reorderStructureNodes(t.db, pm, pan, { parentId: null, nodeIds: reversed });
    expect(result.map((n) => n.id)).toEqual(reversed);
    expect(result.map((n) => n.sort)).toEqual([0, 1, 2]);
    const events = await withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(eq(domainEvents.subjectId, pan)));
    const reordered = events.filter((e) => e.type === 'structure_node.reordered');
    expect(reordered.at(-1)!.payload).toMatchObject({
      parentId: null,
      nodeIds: reversed,
      changes: reversed.map((id, i) => ({ nodeId: id, field: 'sort', old: roots.length - 1 - i, new: i })).filter((c) => c.old !== c.new),
    });
    await expect(reorderStructureNodes(t.db, pm, pan, { parentId: null, nodeIds: reversed.slice(1) })).rejects.toMatchObject({ code: 'invalid' });
    await expect(reorderStructureNodes(t.db, editor, pan, { parentId: null, nodeIds: reversed })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('移动已有模块文档的模块：改变层级被拒绝，移到另一个业务域下（层级不变）仍允许', async () => {
    const d1 = (await createStructureNode(t.db, owner, doc, { name: '域一' })).id;
    const d2 = (await createStructureNode(t.db, owner, doc, { name: '域二' })).id;
    const mod = await createStructureNode(t.db, owner, doc, { parentId: d1, name: '模块甲' });
    await createModuleDocument(t.db, owner, mod.id);
    await expect(moveStructureNode(t.db, owner, mod.id, { parentId: null })).rejects.toMatchObject({ code: 'invalid', message: '该模块已有模块文档，不能改变层级' });
    await expect(moveStructureNode(t.db, owner, mod.id, { parentId: d2 })).resolves.toMatchObject({ depth: 2, parentId: d2 });
  });
});
