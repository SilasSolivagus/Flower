import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { addRequirementComment, listRequirementComments, markRequirementCommentsRead } from '../src/requirements/comments';
import { createRequirement } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let outsider: Actor;
let reqId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  const productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读乙' });
  await setProductRole(t.db, owner, productId, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
  const g = await createPlaceholderMember(t.db, owner, { displayName: '访客丁' });
  outsider = { ...owner, memberId: g.id, orgRole: 'guest', accountId: null };
  reqId = (await createRequirement(t.db, owner, productId, { title: '回收站保留 30 天' })).id;
});
afterAll(() => t.cleanup());

describe('需求评论', () => {
  it('只读成员也能评论，作者自己的评论视为已读', async () => {
    const c = await addRequirementComment(t.db, viewer, reqId, { body: '能否延长到 60 天？' });
    expect(c).toMatchObject({ author: { displayName: '只读乙' }, kind: 'comment', read: true });
    await addRequirementComment(t.db, owner, reqId, { body: '本周排期评估', kind: 'update' });
    const forViewer = await listRequirementComments(t.db, viewer, reqId);
    expect(forViewer.map((x) => [x.body, x.read])).toEqual([
      ['能否延长到 60 天？', true],
      ['本周排期评估', false],
    ]);
  });

  it('标记已读只记录未读的评论', async () => {
    expect(await markRequirementCommentsRead(t.db, viewer, reqId)).toBe(1);
    expect(await markRequirementCommentsRead(t.db, viewer, reqId)).toBe(0);
    expect((await listRequirementComments(t.db, viewer, reqId)).every((x) => x.read)).toBe(true);
  });

  it('空评论和无权访问的成员被拒绝', async () => {
    await expect(addRequirementComment(t.db, owner, reqId, { body: '  ' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(listRequirementComments(t.db, outsider, reqId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('回复必须指向同一需求下的评论', async () => {
    const [first] = await listRequirementComments(t.db, owner, reqId);
    const reply = await addRequirementComment(t.db, owner, reqId, { body: '可以', parentId: first!.id });
    expect(reply.parentId).toBe(first!.id);
    await expect(addRequirementComment(t.db, owner, reqId, { body: 'x', parentId: reqId })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('只读 Token 不能评论或标记已读，但可以列表', async () => {
    const readToken = { ...owner, tokenId: 'x', tokenScope: { products: 'all' as const, access: 'read' as const } };
    await expect(addRequirementComment(t.db, readToken, reqId, { body: '评论' })).rejects.toMatchObject({ code: 'forbidden', message: '只读 Token 不能评论' });
    await expect(markRequirementCommentsRead(t.db, readToken, reqId)).rejects.toMatchObject({ code: 'forbidden', message: '只读 Token 不能标记已读' });
    const comments = await listRequirementComments(t.db, readToken, reqId);
    expect(comments).toBeDefined();
    expect(comments.length).toBeGreaterThan(0);
  });
});
