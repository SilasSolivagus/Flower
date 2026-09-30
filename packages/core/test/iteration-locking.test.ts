import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

const day = (n: number) => new Date(Date.UTC(2030, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
const moveTo = (requirementId: string, iterationId: string | null) =>
  setRequirementIteration(t.db, owner, requirementId, iterationId ? { iterationId, force: true, reason: '并发测试' } : { iterationId: null });

describe('加入迭代与开始迭代的加锁顺序', () => {
  it('两个迭代同时开始、需求在两者之间互换时不死锁', async () => {
    const failures: string[] = [];
    for (let round = 0; round < 30; round++) {
      const a = await createIteration(t.db, owner, { type: 'regular', productId: pan, name: `A${round}`, startDate: day(round * 4), endDate: day(round * 4 + 1) });
      const b = await createIteration(t.db, owner, { type: 'regular', productId: pan, name: `B${round}`, startDate: day(round * 4 + 2), endDate: day(round * 4 + 3) });
      const make = async (iterationId: string | null) => {
        const r = await createRequirement(t.db, owner, pan, { title: `第 ${round} 轮` });
        if (iterationId) await moveTo(r.id, iterationId);
        return r.id;
      };
      const [inA, inB, leaving, joining] = [await make(a.id), await make(b.id), await make(a.id), await make(null)];
      const ops = [
        () => setIterationStatus(t.db, owner, a.id, 'active'),
        () => setIterationStatus(t.db, owner, b.id, 'active'),
        () => moveTo(inA, b.id),
        () => moveTo(inB, a.id),
        () => moveTo(leaving, null),
        () => moveTo(joining, a.id),
      ].sort(() => Math.random() - 0.5);
      for (const r of await Promise.allSettled(ops.map((op) => op()))) {
        if (r.status === 'rejected') failures.push(String((r.reason as { cause?: { code?: string } }).cause?.code ?? r.reason));
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
