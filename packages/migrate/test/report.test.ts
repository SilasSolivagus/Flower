import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import { renderReport } from '../src/report';
import { makeLegacyData, reviewedMapping } from './fixtures';

describe('对账报告', () => {
  it('包含数量对照、匹配结果、冲突、迭代、跳过与延后项', () => {
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null });
    const md = renderReport(plan.report);
    for (const heading of ['# 迁移对账报告', '## 结论', '## 来源数量', '## 写入数量', '## 需求匹配', '## 字段冲突', '## 迭代', '## 人员', '## 跳过的数据', '## 延后迁移']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('| 按 plane_id 匹配 | 1 |');
    expect(md).toContain('| PAN-1 | priority | P1 | P0 |');
    expect(md).toContain('可以写入');
  });
});
