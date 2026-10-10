import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import { renderReport } from '../src/report';
import { makeLegacyData, messyLegacyData, reviewedMapping } from './fixtures';

describe('对账报告', () => {
  it('包含数量对照、匹配结果、冲突、迭代、跳过与延后项', () => {
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null });
    const md = renderReport(plan.report);
    for (const heading of ['# 迁移对账报告', '## 结论', '## 来源数量', '## 写入数量', '## 需求匹配', '## 字段冲突', '## 迭代', '## 人员', '## 跳过的数据', '## 推送（迁移来的通道一律停用）', '## 延后迁移']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('| 按 plane_id 匹配 | 1 |');
    expect(md).toContain('| PAN-1 | priority | P1 | P0 |');
    expect(md).toContain('可以写入');
  });
  it('人员表带类型；列出人员拆分、合并与代签写法', () => {
    const data = messyLegacyData();
    const plan = buildImportPlan(data, reviewedMapping(data), { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null });
    const md = renderReport(plan.report);
    for (const heading of ['### 人员拆分（一个字段写了多人）', '### 人员合并（一个成员的其他写法）', '### 代签写法（按实际操作人导入）']) expect(md).toContain(heading);
    expect(md).toContain('| key | 名称 | 类型 | 邮箱 | 组织角色 | 关联账号 | 出现次数 |');
    expect(md).toContain('| p_lisi | 李四 | 人 | lisi@example.com |');
    expect(md).toMatch(/\| model-v4-flash \| Agent \|/);
    expect(md).toContain('| 王五、赵六 | 王五、赵六 | 0 | 1 |');
    expect(md).toMatch(/\| p_lisi \| 李四 \| [^\n]*产品经理-李四\(小李\)[^\n]*\|/);
    expect(md).toContain('| 代饶总 by 张三 | 1 |');
    expect(md).toContain('会签栏的代签按被代签人签字、实际操作人记为代签人导入，不列入本节。');
  });
});
