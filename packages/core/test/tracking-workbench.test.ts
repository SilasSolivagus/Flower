import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../src/auth/accounts';
import type { Actor } from '../src/domain-types';
import { createRequirement } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createProduct } from '../src/tenancy/products';
import { createProgress } from '../src/tracking/progress';
import { createWorkItem, deleteWorkItem, setWorkItemStatus } from '../src/tracking/work-items';
import { getWorkbench } from '../src/workbench/workbench';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let account: AccountView;
let owner: Actor;
let peer: Actor;
let pan: string;

const move = (id: string, to: string) => transitionRequirement(t.db, owner, id, { to });

beforeAll(async () => {
  t = await createTestDb();
  ({ account, owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  peer = await asMember(t.db, owner, '同事乙');
});
afterAll(() => t.cleanup());

describe('工作台', () => {
  it('我负责的需求与工作项：列出进行中的工作项；已完成、已删除的不列', async () => {
    await createRequirement(t.db, owner, pan, { title: '我的需求', ownerMemberId: owner.memberId });
    await createWorkItem(t.db, owner, { title: '我的工作项', ownerMemberId: owner.memberId });
    const done = await createWorkItem(t.db, owner, { title: '完成的工作项', ownerMemberId: owner.memberId });
    await setWorkItemStatus(t.db, owner, done.id, 'done');
    const removed = await createWorkItem(t.db, owner, { title: '删除的工作项', ownerMemberId: owner.memberId });
    await deleteWorkItem(t.db, owner, removed.id);
    const wb = await getWorkbench(t.db, account.id);
    expect(wb.owned.items.map((x) => [x.kind, x.displayKey, x.title, x.state.label]).sort()).toEqual(
      [
        ['requirement', 'PAN-1', '我的需求', '收集'],
        ['work_item', 'W-1', '我的工作项', '进行中'],
      ].sort(),
    );
  });

  it('等我跟进：我是最新一条进展的跟进人且仍在跟进中；被后来的进展换掉、已上线、已完成的不列', async () => {
    const r1 = await createRequirement(t.db, owner, pan, { title: '等我跟进的需求' });
    await move(r1.id, 'dev');
    await createProgress(t.db, peer, { type: 'requirement', id: r1.id }, { body: '方案初稿', nextStep: '请确认方案', followerMemberId: owner.memberId });
    const r2 = await createRequirement(t.db, owner, pan, { title: '被换掉的需求' });
    await move(r2.id, 'dev');
    await createProgress(t.db, peer, { type: 'requirement', id: r2.id }, { body: '先给你', followerMemberId: owner.memberId });
    await createProgress(t.db, peer, { type: 'requirement', id: r2.id }, { body: '改由我跟进', followerMemberId: peer.memberId });
    const r3 = await createRequirement(t.db, owner, pan, { title: '已上线的需求' });
    await move(r3.id, 'dev');
    await createProgress(t.db, peer, { type: 'requirement', id: r3.id }, { body: '上线前确认', followerMemberId: owner.memberId });
    await move(r3.id, 'done');
    const w1 = await createWorkItem(t.db, peer, { title: '等我跟进的工作项' });
    await createProgress(t.db, peer, { type: 'work_item', id: w1.id }, { body: '对方已回复', nextStep: '回复对方', followerMemberId: owner.memberId });
    const w2 = await createWorkItem(t.db, peer, { title: '已完成的工作项' });
    await createProgress(t.db, peer, { type: 'work_item', id: w2.id }, { body: '收尾', followerMemberId: owner.memberId });
    await setWorkItemStatus(t.db, peer, w2.id, 'done');
    const wb = await getWorkbench(t.db, account.id);
    expect(wb.following.total).toBe(2);
    expect(wb.following.items.map((x) => [x.kind, x.displayKey, x.title, x.nextStep])).toEqual([
      ['requirement', r1.displayKey, '等我跟进的需求', '请确认方案'],
      ['work_item', w1.displayKey, '等我跟进的工作项', '回复对方'],
    ]);
    expect(wb.following.items[0]!.org).toMatchObject({ slug: 'acme' });
  });
});
