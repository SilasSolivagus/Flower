import { validateWorkflowBody } from '@flower/core';
import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import type { ImportOptions } from '../src/plan-types';
import { makeLegacyData, reviewedMapping } from './fixtures';

const OPTS: ImportOptions = {
  orgSlug: 'pan123',
  orgName: '123云盘',
  productKey: 'PAN',
  productName: '123云盘',
  asOf: '2026-09-29',
  owner: { accountId: '0192f000-0000-7000-8000-000000000001', email: 'zhangsan@example.com', name: '张三' },
};

describe('导入计划：基础部分', () => {
  const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), OPTS);
  const { rows } = plan;

  it('建立组织与产品，产品使用迁移生成的流程 v1', () => {
    expect(rows.organizations).toMatchObject([{ slug: 'pan123', name: '123云盘' }]);
    expect(rows.products).toMatchObject([{ key: 'PAN', name: '123云盘', workflowVersionId: rows.workflowVersions[0]!.id }]);
    expect(rows.workflowDefinitions).toMatchObject([{ name: '123云盘流程', productId: null }]);
    const r = validateWorkflowBody(rows.workflowVersions[0]!.body, { fieldKeys: ['priority', 'platform', 'source', 'line'] });
    expect(r.ok).toBe(true);
  });

  it('成员来自人员对照表；与当前账号邮箱相同的人成为所有者', () => {
    const zs = rows.members.find((m) => m.displayName === '张三')!;
    expect(zs).toMatchObject({ orgRole: 'owner', accountId: OPTS.owner!.accountId });
    expect(rows.members.filter((m) => m.accountId)).toHaveLength(1);
    const boss = rows.members.find((m) => m.displayName === '王老板')!;
    expect(rows.productMembers).toEqual([expect.objectContaining({ memberId: boss.id, role: 'viewer' })]);
  });

  it('设计签字的第 4 条规则指向对照表中的会签角色成员', () => {
    const body = rows.workflowVersions[0]!.body as { checkItems: Array<{ key: string; signers?: Array<{ by: string; ref: string }> }> };
    const design = body.checkItems.find((c) => c.key === 'design_signoff')!;
    expect(design.signers).toHaveLength(4);
    expect(design.signers![3]).toEqual({ by: 'member', ref: rows.members.find((m) => m.displayName === '王老板')!.id });
    const tagNames = rows.functionTags.map((t) => t.name);
    expect(tagNames).toEqual(expect.arrayContaining(['产品经理', '设计', '开发', '测试', '线条负责人', '产品负责人']));
  });

  it('字段：优先级含"绿色通道"，平台含对照表里新增的选项', () => {
    const opt = (fieldKey: string) => rows.fieldOptions.filter((o) => o.fieldId === rows.fieldDefinitions.find((f) => f.key === fieldKey)!.id).map((o) => o.label);
    expect(opt('priority')).toEqual(['P0', 'P1', 'P2', 'P3', '绿色通道']);
    expect(opt('platform')).toEqual(expect.arrayContaining(['PC客户端', '移动端', 'Web端', '小程序', '鸿蒙']));
    expect(opt('line')).toEqual(['功能', '商业']);
  });

  it('结构树第一层来自业务域对照表', () => {
    expect(rows.structureNodes.map((n) => [n.name, n.depth])).toEqual([
      ['会员与支付', 1],
      ['跨盘迁移', 1],
    ]);
  });

  it('迭代：合并后的日期、状态和专项', () => {
    const byName = (n: string) => rows.iterations.find((i) => i.name === n)!;
    expect(byName('it0316')).toMatchObject({ type: 'regular', startDate: '2026-03-02', endDate: '2026-03-16', status: 'done', legacyKey: 'V1|V1dup|it0316' });
    expect(byName('it0330')).toMatchObject({ startDate: '2026-03-17', endDate: '2026-03-31', status: 'done' });
    expect(byName('专项')).toMatchObject({ type: 'special', productId: null });
    expect(byName('it0316').milestones).toEqual(expect.arrayContaining([{ label: '发布', date: '2026-03-16' }]));
  });

  it('发布版本：拆出版本号和平台，没有计划日期', () => {
    expect(rows.releases).toMatchObject([{ versionName: '1.0.0', status: 'released', plannedDate: null, legacyKey: 'pc-1.0.0' }]);
    expect(rows.releases[0]!.platformOptionId).toBe(rows.fieldOptions.find((o) => o.label === 'PC客户端')!.id);
  });

  it('同样的输入得到同样的计划', () => {
    expect(buildImportPlan(makeLegacyData(), reviewedMapping(), OPTS)).toEqual(plan);
  });
});

describe('导入计划：阻止写入的问题', () => {
  it('会签角色没有对应成员', () => {
    const m = reviewedMapping();
    delete m.people.signoffRoles['饶总'];
    expect(buildImportPlan(makeLegacyData(), m, OPTS).report.problems).toContain('会签角色「饶总」没有对应成员（people.json 的 signoffRoles）');
  });

  it('常规迭代时间重叠', () => {
    const m = reviewedMapping();
    m.iterations.iterations.find((i) => i.name === '专项')!.type = 'regular';
    expect(buildImportPlan(makeLegacyData(), m, OPTS).report.problems.join('\n')).toMatch(/常规迭代「.+」与「.+」时间重叠/);
  });

  it('迭代开始日期晚于结束日期：记录问题且跳过该行', () => {
    const data = makeLegacyData();
    const v2 = data.plane.iterations.find((i) => i.id === 'V2')!;
    v2.kickoff_date = '2026-04-01';
    const plan = buildImportPlan(data, reviewedMapping(), OPTS);
    expect(plan.report.problems.join('\n')).toMatch(/迭代「it0330」开始日期晚于结束日期/);
    expect(plan.rows.iterations.find((i) => i.name === 'it0330')).toBeUndefined();
  });

  it('对照表中多个人共享所有者邮箱：只有第一个绑定账号，其余记为问题', () => {
    const m = reviewedMapping();
    const zs = m.people.people.find((p) => p.displayName === '张三')!;
    m.people.people.push({ ...zs, key: 'p_zhangsan_dup', displayName: '张三（重复）' });
    const plan = buildImportPlan(makeLegacyData(), m, OPTS);
    expect(plan.rows.members.filter((mm) => mm.accountId)).toHaveLength(1);
    expect(plan.report.problems).toContain(`人员对照表中有多个人使用所有者邮箱 ${OPTS.owner!.email.toLowerCase()}`);
  });
});
