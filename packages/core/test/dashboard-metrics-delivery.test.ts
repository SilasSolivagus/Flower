import { describe, expect, it } from 'vitest';
import {
  iterationCommitment,
  type ReleaseFact,
  releaseSummary,
  type ReviewEventFact,
  reviewSummary,
  specialCompletion,
} from '../src/dashboard/delivery-metrics';
import { prepareFlow } from '../src/dashboard/metrics';
import { categoryOf, req, SH } from './dashboard-fixtures';

const rel = (id: string, patch: Partial<ReleaseFact>): ReleaseFact => ({
  id,
  versionName: id,
  status: 'released',
  plannedDate: null,
  baselineDate: null,
  releasedAt: null,
  iterationEndDate: null,
  ...patch,
});

describe('版本按期达成率', () => {
  it('基线日期优先，没有时用所属迭代结束日；未发布的按计划日判断是否已逾期；两者都没有的不进分母', () => {
    const list = [
      rel('v1', { baselineDate: '2026-09-25', plannedDate: '2026-09-25', releasedAt: new Date('2026-09-24T02:00:00Z') }),
      rel('v2', { iterationEndDate: '2026-09-27', releasedAt: new Date('2026-09-28T17:00:00Z') }),
      rel('v3', { baselineDate: '2026-09-01', releasedAt: new Date('2026-09-10T00:00:00Z') }),
      rel('v4', { releasedAt: new Date('2026-09-20T02:00:00Z') }),
      rel('v5', { status: 'planned', plannedDate: '2026-10-10', baselineDate: '2026-10-10' }),
      rel('v6', { status: 'planned', iterationEndDate: '2026-10-20' }),
      rel('v7', { status: 'planned' }),
      rel('v8', { baselineDate: '2026-09-25' }),
    ];
    const s = releaseSummary(list, '2026-09-15', '2026-10-13', '2026-10-13', SH);
    expect(s).toMatchObject({ released: 3, evaluated: 2, onTime: 1, onTimeRate: 0.5 });
    expect(s.rows.map((r) => [r.id, r.dueDate, r.dueSource, r.releasedOn, r.onTime, r.overdueDays])).toEqual([
      ['v5', '2026-10-10', 'planned', null, null, 3],
      ['v6', '2026-10-20', 'iteration', null, null, 0],
      ['v7', null, null, null, null, null],
      ['v2', '2026-09-27', 'iteration', '2026-09-29', false, 2],
      ['v1', '2026-09-25', 'baseline', '2026-09-24', true, 0],
      ['v4', null, null, '2026-09-20', null, null],
    ]);
  });

  it('发布日按组织时区；没有可判断的已发布版本时按期率为 null', () => {
    const late = [rel('v', { baselineDate: '2026-09-28', releasedAt: new Date('2026-09-28T17:00:00Z') })];
    expect(releaseSummary(late, '2026-09-01', '2026-09-30', '2026-10-13', SH).rows[0]).toMatchObject({ releasedOn: '2026-09-29', onTime: false, overdueDays: 1 });
    expect(releaseSummary(late, '2026-09-01', '2026-09-30', '2026-10-13', 'UTC').rows[0]).toMatchObject({ releasedOn: '2026-09-28', onTime: true, overdueDays: 0 });
    expect(releaseSummary([rel('v4', { releasedAt: new Date('2026-09-20T02:00:00Z') })], '2026-09-01', '2026-09-30', '2026-10-13', SH).onTimeRate).toBeNull();
  });
});

describe('迭代承诺完成率', () => {
  const flow = prepareFlow(
    [
      req('c1', '2026-08-25T10:00:00+08:00', [
        ['doing', '2026-09-05T10:00:00+08:00'],
        ['done', '2026-09-20T10:00:00+08:00'],
      ]),
      req('c2', '2026-08-25T10:00:00+08:00', [['doing', '2026-09-05T10:00:00+08:00']]),
      req('c3', '2026-08-25T10:00:00+08:00', [['canceled', '2026-09-25T10:00:00+08:00']]),
      req('c4', '2026-08-25T10:00:00+08:00', [
        ['doing', '2026-09-10T10:00:00+08:00'],
        ['done', '2026-10-05T10:00:00+08:00'],
      ]),
      req('a1', '2026-09-10T10:00:00+08:00', [['done', '2026-09-28T10:00:00+08:00']]),
    ],
    SH,
  );
  const byId = new Map(flow.map((r) => [r.id, r]));
  // gone 是已删除的需求（读取时已排除，不在 byId 里）
  const base = { id: 'it1', name: '第 1 轮', startDate: '2026-09-01', endDate: '2026-09-30', snapshotTaken: true, committedIds: ['c1', 'c2', 'c3', 'c4', 'gone'], currentIds: ['c1', 'c3', 'c4', 'a1'] };

  it('快照内需求在结束日结束时完成的比例；已取消不进分母；已删除的不计；列出中途加入与移出', () => {
    expect(iterationCommitment({ ...base, status: 'done' }, byId, categoryOf, '2026-10-13')).toEqual({
      id: 'it1',
      name: '第 1 轮',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      status: 'done',
      cutoff: '2026-09-30',
      hasSnapshot: true,
      reason: null,
      committed: 4,
      completed: 1,
      canceled: 1,
      rate: 0.3333,
      added: 1,
      removed: 1,
    });
  });

  it('进行中的迭代计到今天；没有快照的迭代承诺完成率为 null', () => {
    expect(iterationCommitment({ ...base, status: 'active' }, byId, categoryOf, '2026-10-13')).toMatchObject({ cutoff: '2026-10-13', completed: 2, rate: 0.6667 });
    expect(iterationCommitment({ ...base, status: 'done', snapshotTaken: false, committedIds: [] }, byId, categoryOf, '2026-10-13')).toMatchObject({
      hasSnapshot: false,
      reason: '没有承诺范围快照',
      committed: 0,
      completed: 0,
      rate: null,
      added: null,
      removed: null,
    });
  });

  it('在 Flower 里开始、但承诺范围为空的迭代与没有快照的迭代区分开：有快照，原因为「承诺范围为空」', () => {
    expect(iterationCommitment({ ...base, status: 'active', snapshotTaken: true, committedIds: [] }, byId, categoryOf, '2026-10-13')).toMatchObject({
      hasSnapshot: true,
      reason: '承诺范围为空',
      committed: 0,
      rate: null,
      added: 4,
      removed: 0,
    });
    // 快照里的需求全部已删除，同样是承诺范围为空
    expect(iterationCommitment({ ...base, status: 'done', snapshotTaken: true, committedIds: ['gone'] }, byId, categoryOf, '2026-10-13')).toMatchObject({ hasSnapshot: true, reason: '承诺范围为空', rate: null });
  });
});

describe('专项完成率', () => {
  it('完成数 ÷（总数 − 已取消数）；全部取消时为 null', () => {
    const s = { id: 's', name: '专项甲', startDate: '2026-09-01', endDate: '2026-12-31', status: 'active' as const };
    expect(specialCompletion({ ...s, stateKeys: ['done', 'doing', 'canceled', 'accepted'] }, categoryOf)).toEqual({ ...s, total: 4, completed: 2, canceled: 1, rate: 0.6667 });
    expect(specialCompletion({ ...s, stateKeys: ['canceled'] }, categoryOf).rate).toBeNull();
  });
});

describe('评审效率与驳回率', () => {
  const ev = (
    subjectId: string,
    itemKey: string,
    type: 'check_item.updated' | 'check_item.signed',
    newState: string | null,
    at: string,
    decision: string | null = null,
    subjectType = 'requirement',
  ): ReviewEventFact => ({ subjectType, subjectId, itemKey, type, newState, decision, at: new Date(at) });
  const events = [
    // r1 可行性：09-10 开始评审，09-16 驳回，09-20 通过（先驳回后通过，计为驳回过）
    ev('r1', 'feasibility', 'check_item.updated', 'in_progress', '2026-09-10T10:00:00+08:00'),
    ev('r1', 'feasibility', 'check_item.updated', 'rejected', '2026-09-16T10:00:00+08:00'),
    ev('r1', 'feasibility', 'check_item.updated', 'passed', '2026-09-20T10:00:00+08:00'),
    // r2 可行性：直接通过，评审 0 天
    ev('r2', 'feasibility', 'check_item.updated', 'passed', '2026-09-18T10:00:00+08:00'),
    // r3 设计签字：09-01 被驳回（时间段外），09-17 另一人签通过但结论不变，09-22 改签后通过
    ev('r3', 'design', 'check_item.signed', 'rejected', '2026-09-01T10:00:00+08:00', 'rejected'),
    ev('r3', 'design', 'check_item.signed', null, '2026-09-17T10:00:00+08:00', 'passed'),
    ev('r3', 'design', 'check_item.signed', 'passed', '2026-09-22T10:00:00+08:00', 'passed'),
    // PRD 上的检查项：驳回
    ev('d1', 'prd_review', 'check_item.signed', 'rejected', '2026-10-01T10:00:00+08:00', 'rejected', 'document'),
    // 只开始、没有结论
    ev('r4', 'feasibility', 'check_item.updated', 'in_progress', '2026-10-02T10:00:00+08:00'),
  ];

  it('按检查项列出评审天数中位数与驳回率；统计起点为最早一条事件的日期', () => {
    expect(reviewSummary(events, '2026-09-15', '2026-10-13', SH)).toEqual({
      since: '2026-09-01',
      concluded: 4,
      rejected: 2,
      rejectionRate: 0.5,
      items: [
        { itemKey: 'design', passed: 1, medianDays: 21, concluded: 1, rejected: 0, rejectionRate: 0 },
        { itemKey: 'feasibility', passed: 2, medianDays: 5, concluded: 2, rejected: 1, rejectionRate: 0.5 },
        { itemKey: 'prd_review', passed: 0, medianDays: null, concluded: 1, rejected: 1, rejectionRate: 1 },
      ],
    });
  });

  it('时间段按组织时区划分；先驳回后通过的计为驳回过', () => {
    const edge = [ev('d1', 'prd_review', 'check_item.signed', 'rejected', '2026-09-30T16:30:00Z', 'rejected', 'document')];
    expect(reviewSummary(edge, '2026-09-15', '2026-09-30', SH).concluded).toBe(0);
    expect(reviewSummary(edge, '2026-09-15', '2026-09-30', 'UTC').concluded).toBe(1);
    expect(reviewSummary(events.slice(0, 3), '2026-09-15', '2026-10-13', SH).items).toEqual([
      { itemKey: 'feasibility', passed: 1, medianDays: 10, concluded: 1, rejected: 1, rejectionRate: 1 },
    ]);
  });

  it('没有评审事件时统计起点与比例为 null', () => {
    expect(reviewSummary([], '2026-09-15', '2026-10-13', SH)).toEqual({ since: null, concluded: 0, rejected: 0, rejectionRate: null, items: [] });
  });
});
