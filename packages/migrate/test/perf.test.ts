import { listProducts, resolveActor } from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { seedInstance } from '@flower/core/testing/factories';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPerfCases, measure } from '../src/perf';
import { buildImportPlan } from '../src/plan';
import { writeImport } from '../src/write';
import { makeLegacyData, reviewedMapping } from './fixtures';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

describe('性能测量', () => {
  it('measure 给出每个用例的 p50、p95 和最大值', async () => {
    let calls = 0;
    const result = await measure([{ name: '空操作', run: async () => void calls++ }], 5);
    expect(calls).toBe(6);
    expect(result).toEqual([{ name: '空操作', p50: expect.any(Number), p95: expect.any(Number), max: expect.any(Number) }]);
  });

  it('根据导入的数据生成用例，并且都能执行', async () => {
    const { account } = await seedInstance(t.db);
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), {
      orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29',
      owner: { accountId: account.id, email: account.email, name: account.name },
    });
    await writeImport(t.adminDb, plan, { replace: false });
    const actor = (await resolveActor(t.db, account.id, 'pan123'))!;
    const [product] = await listProducts(t.db, actor);
    const cases = await buildPerfCases(t.db, actor, product!.id);
    expect(cases.map((c) => c.name)).toEqual([
      '列表：默认第 1 页',
      '列表：第 5 页',
      '列表：按最多的状态',
      '列表：按负责人',
      '列表：按优先级',
      '列表：标题关键词',
      '列表：按编号',
      '详情：轮流打开',
      '评论：轮流读取',
      '迭代：列表',
      '迭代：范围对比（需求最多的迭代）',
      '甘特：任务最多的迭代',
      '人员负载：任务最多的人（含已结束迭代）',
      '评审队列：默认',
      '评审队列：等我签字',
      '工作台',
      '看板：产品，近 90 天',
      '看板：产品，近 180 天',
      '看板：产品，按迭代（最近开始的迭代）',
      '看板：组织汇总，近 90 天',
    ]);
    const result = await measure(cases, 2);
    expect(result).toHaveLength(20);
  });
});
