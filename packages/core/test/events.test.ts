import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, organizations } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { recordEvent } from '../src/events';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgId = newId();
const actor: Actor = { accountId: null, memberId: newId(), orgId, orgRole: 'owner', tokenId: newId(), tokenScope: null };

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values({ id: orgId, slug: 'ev', name: '事件' });
});
afterAll(() => t.cleanup());

describe('recordEvent', () => {
  it('写入事件并附带 schemaVersion 与操作者', async () => {
    const subjectId = newId();
    await withOrg(t.db, orgId, (tx) =>
      recordEvent(tx, { orgId, type: 'test.happened', subjectType: 'test', subjectId, actor, payload: { a: 1 } }),
    );
    const rows = await withOrg(t.db, orgId, (tx) => tx.select().from(domainEvents));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'test.happened',
      subjectId,
      actorMemberId: actor.memberId,
      actorTokenId: actor.tokenId,
      payload: { schemaVersion: 1, a: 1 },
    });
  });

  it('业务事务回滚时事件一并回滚', async () => {
    await expect(
      withOrg(t.db, orgId, async (tx) => {
        await recordEvent(tx, { orgId, type: 'test.rolled_back', subjectType: 'test', subjectId: newId(), actor });
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');
    const rows = await withOrg(t.db, orgId, (tx) => tx.select().from(domainEvents));
    expect(rows.some((r) => r.type === 'test.rolled_back')).toBe(false);
  });
});
