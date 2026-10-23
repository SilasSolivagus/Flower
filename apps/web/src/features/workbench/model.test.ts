import { describe, expect, it } from 'vitest';
import {
  confirmationHref,
  emptySectionHref,
  formatIterationRange,
  iterationGanttHref,
  iterationHref,
  iterationsHref,
  nowIterationEmptyKind,
  nowIterationSubtitle,
  nowIterationTaskHref,
  openNowIterationId,
  requirementHref,
  showOrgBadge,
  signatureHref,
  subjectHref,
  taskHref,
  unreadHref,
  workbenchIsEmpty,
} from './model';

describe('工作台链接', () => {
  const org = { id: 'o1', slug: 'acme', name: '测试组织' };
  const base = { org, id: 't1', displayKey: 'PAN-T-1', title: '联调', status: 'todo' as const, planStart: null, progress: 0 };

  it('需求行链接到详情；任务行优先链接到需求，没有需求时到迭代的甘特页签', () => {
    expect(requirementHref(org, 'PAN-1')).toBe('/acme/requirements/PAN-1');
    expect(taskHref({ ...base, requirement: { displayKey: 'PAN-2', title: '分享统计' }, iteration: { id: 'i1', name: '迭代0105' } })).toBe('/acme/requirements/PAN-2');
    expect(taskHref({ ...base, requirement: null, iteration: { id: 'i1', name: '迭代0105' } })).toBe('/acme/iterations/i1?tab=gantt');
  });

  it('加入多个组织时才在每行标出组织名', () => {
    expect(showOrgBadge([org])).toBe(false);
    expect(showOrgBadge([org, { id: 'o2', slug: 'other', name: '第二组织' }])).toBe(true);
  });

  it('确认检查项：需求链接到需求详情，PRD 链接到 PRD 详情', () => {
    const s = { org, itemKey: 'k', itemLabel: '评审', ruleIndex: 0, onBehalfOf: null, title: 't' };
    expect(signatureHref({ ...s, requirementId: 'r1', documentId: null, displayKey: 'PAN-1' })).toBe('/acme/requirements/PAN-1');
    expect(signatureHref({ ...s, requirementId: null, documentId: 'd1', displayKey: 'PAN-PRD-1' })).toBe('/acme/documents/PAN-PRD-1');
  });

  it('等我确认的简报链接到简报详情', () => {
    expect(confirmationHref({ org, documentId: 'd1', displayKey: 'PAN-B-1', title: '上传提速', status: 'discussing', updatedAt: '2026-10-09T00:00:00.000Z' })).toBe(
      '/acme/documents/PAN-B-1',
    );
  });

  it('未读评论：需求去需求详情，PRD 去 PRD 详情', () => {
    const u = { org, title: 't', unread: 1, lastAt: '2026-10-09T00:00:00.000Z' };
    expect(unreadHref({ ...u, requirementId: 'r1', documentId: null, displayKey: 'PAN-1' })).toBe('/acme/requirements/PAN-1');
    expect(unreadHref({ ...u, requirementId: null, documentId: 'd1', displayKey: 'PAN-PRD-1' })).toBe('/acme/documents/PAN-PRD-1');
  });

  it('六块总数都是 0 才算全空；任一块有数就保持分块', () => {
    const empty = { owned: { total: 0 }, following: { total: 0 }, tasks: { total: 0 }, signatures: { total: 0 }, confirmations: { total: 0 }, unread: { total: 0 } };
    expect(workbenchIsEmpty(empty)).toBe(true);
    expect(workbenchIsEmpty({ ...empty, tasks: { total: 1 } })).toBe(false);
    expect(workbenchIsEmpty({ ...empty, unread: { total: 2 } })).toBe(false);
  });

  it('空栏链到当前组织的现有列表', () => {
    expect(emptySectionHref('acme', 'owned')).toBe('/acme/requirements');
    expect(emptySectionHref('acme', 'following')).toBe('/acme/tracking');
    expect(emptySectionHref('acme', 'tasks')).toBe('/acme/iterations');
    expect(emptySectionHref('acme', 'signatures')).toBe('/acme/reviews');
    expect(emptySectionHref('acme', 'confirmations')).toBe('/acme/documents?view=briefs');
    expect(emptySectionHref('acme', 'unread')).toBe('/acme/notifications');
  });

  it('我负责的与等我跟进：需求去需求详情，工作项去工作项详情', () => {
    expect(subjectHref({ org, kind: 'requirement', displayKey: 'PAN-3' })).toBe('/acme/requirements/PAN-3');
    expect(subjectHref({ org, kind: 'work_item', displayKey: 'W-2' })).toBe('/acme/work-items/W-2');
  });

  it('此刻迭代：详情与甘特链接，任务行跟 taskHref 同一规则', () => {
    expect(iterationsHref('acme')).toBe('/acme/iterations');
    expect(iterationHref('acme', 'i1')).toBe('/acme/iterations/i1');
    expect(iterationGanttHref('acme', 'i1')).toBe('/acme/iterations/i1?tab=gantt');
    expect(nowIterationTaskHref('acme', 'i1', { requirement: { displayKey: 'PAN-2' } })).toBe('/acme/requirements/PAN-2');
    expect(nowIterationTaskHref('acme', 'i1', { requirement: null })).toBe('/acme/iterations/i1?tab=gantt');
  });

  it('此刻迭代默认展开第一条；收起后保持收起；条目消失时回到第一条', () => {
    expect(openNowIterationId(undefined, ['a', 'b'])).toBe('a');
    expect(openNowIterationId(undefined, [])).toBeNull();
    expect(openNowIterationId(null, ['a', 'b'])).toBeNull();
    expect(openNowIterationId('b', ['a', 'b'])).toBe('b');
    expect(openNowIterationId('gone', ['a', 'b'])).toBe('a');
  });

  it('此刻迭代空态：没有可见迭代，和有迭代但不是此刻，分开', () => {
    expect(nowIterationEmptyKind('present')).toBeNull();
    expect(nowIterationEmptyKind('none')).toBe('none');
    expect(nowIterationEmptyKind('no_now')).toBe('no_now');
    expect(nowIterationEmptyKind('unscoped')).toBe('no_now');
    expect(formatIterationRange('2026-10-23', '2026-10-23')).toBe('2026-10-23');
    expect(formatIterationRange('2026-10-20', '2026-10-30')).toBe('2026-10-20 至 2026-10-30');
    expect(nowIterationSubtitle({ product: { name: '网盘' }, startDate: '2026-10-20', endDate: '2026-10-30' }, '进行中')).toBe('网盘 · 2026-10-20 至 2026-10-30 · 进行中');
    expect(nowIterationSubtitle({ product: null, startDate: '2026-10-23', endDate: '2026-10-23' }, '进行中')).toBe('专项 · 2026-10-23 · 进行中');
  });
});
