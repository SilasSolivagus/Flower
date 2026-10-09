import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, products, tasks } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createIteration, type IterationView } from '../src/iterations/iterations';
import { createRequirement } from '../src/requirements/requirements';
import { createTask, deleteTask } from '../src/tasks/tasks';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { regularIteration, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let doc: string;
let sprint: IterationView;
let docReqId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0928', '2026-09-28', '2026-10-09'));
  docReqId = (await createRequirement(t.db, owner, doc, { title: '文档需求' })).id;
});
afterAll(() => t.cleanup());

const numberOf = async (id: string): Promise<number> =>
  (await withOrg(t.db, owner.orgId, (tx) => tx.select({ n: tasks.number }).from(tasks).where(eq(tasks.id, id))))[0]!.n;

describe('任务编号', () => {
  it('新建时按产品递增分配，删除的编号不复用；产品的 task_seq 随之增加；事件记录编号', async () => {
    const a = await createTask(t.db, owner, { iterationId: sprint.id, title: '前端开发' });
    const b = await createTask(t.db, owner, { iterationId: sprint.id, title: '后端开发' });
    const c = await createTask(t.db, owner, { requirementId: docReqId, title: '文档任务' });
    expect([await numberOf(a.id), await numberOf(b.id), await numberOf(c.id)]).toEqual([1, 2, 1]);
    await deleteTask(t.db, owner, b.id);
    const d = await createTask(t.db, owner, { iterationId: sprint.id, title: '联调' });
    expect(await numberOf(d.id)).toBe(3);
    const [p] = await withOrg(t.db, owner.orgId, (tx) => tx.select({ seq: products.taskSeq }).from(products).where(eq(products.id, pan)));
    expect(p!.seq).toBe(3);
    const [ev] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, d.id), eq(domainEvents.type, 'task.created'))),
    );
    expect(ev!.payload).toMatchObject({ number: 3, title: '联调' });
  });
});
