import { describe, expect, it } from 'vitest';
import { requirementHref, showOrgBadge, signatureHref, taskHref } from './model';

describe('工作台链接', () => {
  const org = { id: 'o1', slug: 'acme', name: '测试组织' };
  const base = { org, id: 't1', title: '联调', status: 'todo' as const, planStart: null, progress: 0 };

  it('需求行链接到详情；任务行优先链接到需求，没有需求时到迭代的甘特页签', () => {
    expect(requirementHref(org, 'PAN-1')).toBe('/acme/requirements/PAN-1');
    expect(taskHref({ ...base, requirement: { displayKey: 'PAN-2', title: '分享统计' }, iteration: { id: 'i1', name: '迭代0105' } })).toBe('/acme/requirements/PAN-2');
    expect(taskHref({ ...base, requirement: null, iteration: { id: 'i1', name: '迭代0105' } })).toBe('/acme/iterations/i1?tab=gantt');
  });

  it('加入多个组织时才在每行标出组织名', () => {
    expect(showOrgBadge([org])).toBe(false);
    expect(showOrgBadge([org, { id: 'o2', slug: 'other', name: '第二组织' }])).toBe(true);
  });

  it('签字行：需求链接到需求详情，PRD 链接到 PRD 详情', () => {
    const s = { org, itemKey: 'k', itemLabel: '评审', ruleIndex: 0, onBehalfOf: null, title: 't' };
    expect(signatureHref({ ...s, requirementId: 'r1', documentId: null, displayKey: 'PAN-1' })).toBe('/acme/requirements/PAN-1');
    expect(signatureHref({ ...s, requirementId: null, documentId: 'd1', displayKey: 'PAN-PRD-1' })).toBe('/acme/documents/PAN-PRD-1');
  });
});
