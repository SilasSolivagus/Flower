import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import type { ImportOptions } from '../src/plan-types';
import { makeLegacyData, planeReq, reviewedMapping } from './fixtures';

const OPTS: ImportOptions = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null };

describe('导入计划：需求', () => {
  const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), OPTS);
  const { rows, report } = plan;
  const req = (n: number) => rows.requirements.find((r) => r.number === n)!;
  const member = (name: string) => rows.members.find((m) => m.displayName === name)!.id;
  const option = (label: string) => rows.fieldOptions.find((o) => o.label === label)!.id;
  const valuesOf = (reqId: string) => rows.fieldValues.filter((v) => v.entityId === reqId).map((v) => rows.fieldOptions.find((o) => o.id === v.optionId)!.label).sort();
  const checks = (reqId: string) => Object.fromEntries(rows.checkItemResults.filter((c) => c.targetId === reqId).map((c) => [c.itemKey, c.state]));

  it('合并结果与编号', () => {
    expect(report.problems).toEqual([]);
    expect(report.matching).toMatchObject({ planeTotal: 3, pushTotal: 5, pushMergedSkipped: 1, byPlaneId: 1, byTitle: 1, pushOnly: 2 });
    expect(report.matching.titleMatches).toEqual([{ displayKey: 'PAN-2', planeTitle: '相册归类', pushTitle: '相册 归类！' }]);
    expect(rows.requirements.map((r) => [r.number, r.title, r.legacyKey])).toEqual([
      [1, '批量下载', 'X001'],
      [2, '相册归类', 'X002'],
      [3, '分享密码', 'X003'],
      [4, '离线下载', 'push-3'],
      [5, '已搁置需求', 'push-5'],
    ]);
    expect(rows.products[0]!.requirementSeq).toBe(5);
    expect(rows.entityAliases.map((a) => a.alias).sort()).toEqual(['X001', 'X002', 'X003', 'push-1', 'push-2', 'push-3', 'push-5']);
  });

  it('字段冲突以 123plane 为准并列入报告', () => {
    expect(report.conflicts).toEqual(
      expect.arrayContaining([
        { displayKey: 'PAN-1', field: 'priority', plane: 'P1', push: 'P0' },
        { displayKey: 'PAN-1', field: 'title', plane: '批量下载', push: '批量下载（PC/Web）' },
      ]),
    );
    expect(valuesOf(req(1).id!)).toEqual(['P1', 'PC客户端', 'Web端', '功能', '原创'].sort());
  });

  it('PAN-1：迭代以 push 为准，评审与会签来自 push，PRD 来自 123plane', () => {
    const r = req(1);
    expect(r).toMatchObject({ stateKey: 'developing', ownerMemberId: member('张三'), iterationId: rows.iterations.find((i) => i.name === 'it0316')!.id });
    expect(checks(r.id!)).toEqual({ background: 'passed', feasibility: 'passed', industry: 'in_progress', prd: 'passed', design_signoff: 'in_progress', ai_review: 'passed' });
    const design = rows.checkItemResults.find((c) => c.targetId === r.id && c.itemKey === 'design_signoff')!;
    const signoffs = rows.checkItemSignoffs.filter((s) => s.resultId === design.id);
    expect(signoffs.map((s) => [s.signerRuleIndex, s.decision])).toEqual([
      [0, 'passed'],
      [1, 'passed'],
      [3, 'passed'],
    ]);
    expect(signoffs.find((s) => s.signerRuleIndex === 3)).toMatchObject({ signerMemberId: member('王老板'), actedByMemberId: member('张三'), note: '同意' });
    const ai = rows.checkItemResults.find((c) => c.targetId === r.id && c.itemKey === 'ai_review')!;
    expect((ai.meta as { rounds: unknown[] }).rounds).toHaveLength(2);
    expect(rows.checkItemResults.find((c) => c.targetId === r.id && c.itemKey === 'background')).toMatchObject({ note: '背景清楚', updatedBy: member('张三') });
    expect(r.legacyMeta).toMatchObject({ plane: { id: 'X001' }, push: { id: 1, developers: ['前端'] } });
  });

  it('PAN-2：多负责人、绿色通道、全端，push 评审中的检查项为进行中', () => {
    const r = req(2);
    expect(r).toMatchObject({ stateKey: 'collect', ownerMemberId: member('李四'), nodeId: rows.structureNodes.find((n) => n.name === '会员与支付')!.id });
    expect(r.legacyMeta).toMatchObject({ plane: { coOwners: ['张三'] } });
    expect(valuesOf(r.id!)).toEqual(['PC客户端', 'Web端', '小程序', '移动端', '绿色通道', '功能', '原创'].sort());
    expect(checks(r.id!)).toEqual({ background: 'in_progress', feasibility: 'in_progress', industry: 'in_progress' });
  });

  it('push 独有需求', () => {
    expect(req(4)).toMatchObject({ stateKey: 'to_evaluate', description: '支持离线下载', ownerMemberId: member('赵六'), nodeId: null });
    expect(valuesOf(req(4).id!)).toEqual(['P2', '商业', '线上问题', '鸿蒙'].sort());
    expect(req(5).stateKey).toBe('shelved');
  });

  it('开发分配、发布版本关联、阻塞项', () => {
    expect(rows.requirementAssignments.filter((a) => a.requirementId === req(1).id).map((a) => a.platformOptionId).sort()).toEqual([option('PC客户端'), option('Web端')].sort());
    expect(rows.requirementReleases).toEqual([expect.objectContaining({ requirementId: req(3).id })]);
    expect(rows.blockers).toMatchObject([{ requirementId: req(1).id, description: '等待支付接口', status: 'active' }]);
  });

  it('流转历史：补一条创建，再按日志追加', () => {
    const history = rows.stateTransitions.filter((s) => s.requirementId === req(1).id).map((s) => [s.fromState, s.toState]);
    expect(history).toEqual([
      [null, 'collect'],
      ['collect', 'developing'],
    ]);
    expect(req(1).stateChangedAt).toEqual(new Date('2026-03-05T00:00:00Z'));
    expect(rows.stateTransitions.filter((s) => s.requirementId === req(3).id).map((s) => [s.fromState, s.toState])).toEqual([[null, 'launched']]);
  });

  it('评论、进展、迭代日志与已读', () => {
    const bodies = rows.comments.map((c) => [c.targetType, c.kind, c.body]);
    expect(bodies).toEqual(
      expect.arrayContaining([
        ['requirement', 'comment', '请确认范围'],
        ['requirement', 'update', '联调中'],
        ['iteration', 'update', '【风险】人手紧张'],
      ]),
    );
    expect(rows.comments).toHaveLength(3);
    expect(rows.commentReads).toEqual([expect.objectContaining({ memberId: member('张三') })]);
    expect(report.skipped).toEqual(expect.arrayContaining([{ what: '已删除需求上的评论', count: 1, reason: '需求已在 123plane 中物理删除' }]));
  });

  it('任务：子任务与甘特任务，状态按日期计算', () => {
    const byTitle = (t: string) => rows.tasks.find((x) => x.title === t)!;
    expect(byTitle('接口联调')).toMatchObject({ requirementId: req(1).id, status: 'todo', assigneeMemberId: member('王五') });
    expect(byTitle('前端开发')).toMatchObject({ requirementId: req(1).id, status: 'done', planStart: '2026-03-02', planDays: 5 });
    expect(byTitle('专项设计')).toMatchObject({ requirementId: null, status: 'doing', starred: true, flag: '关注' });
  });

  it('审计事件：123plane 动态与 push 变更记录', () => {
    expect(rows.domainEvents.map((e) => e.type).sort()).toEqual(['legacy.123plane.created', 'legacy.123plane.deleted', 'legacy.123plane.status_change', 'legacy.push.change']);
    const deleted = rows.domainEvents.find((e) => e.type === 'legacy.123plane.deleted')!;
    expect(rows.requirements.some((r) => r.id === deleted.subjectId)).toBe(false);
    expect(deleted.occurredAt).toEqual(new Date('2026-03-06T00:00:00Z'));
  });

  it('对账数量与延后项', () => {
    expect(report.targetCounts).toMatchObject({ requirements: 5, comments: 3, tasks: 3, domainEvents: 4 });
    expect(report.sourceCounts).toMatchObject({ 'plane.requirements': 3, 'push.requirements': 5, 'push.ganttTasks': 2 });
    expect(report.deferred).toEqual(expect.arrayContaining([{ what: '123plane 需求简报（HTML）', count: 1, phase: 'P2 文档附件' }]));
    expect(report.iterations.find((i) => i.name === 'it0316')).toMatchObject({ requirements: 1 });
  });

  it('未解析的原始值与未知状态会阻止写入', () => {
    const data = makeLegacyData();
    data.plane.requirements[0]!.status = '神秘状态';
    data.plane.requirements[1]!.requester = '新面孔';
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    expect(p.report.problems).toEqual(expect.arrayContaining(['123plane 状态「神秘状态」没有对应的流程状态', '人员对照表缺少：新面孔']));
  });

  it('同样的输入得到同样的计划', () => {
    expect(buildImportPlan(makeLegacyData(), reviewedMapping(), OPTS)).toEqual(plan);
  });
});

describe('导入计划：需求（修复回归）', () => {
  it('已删除需求上的阻塞项、子任务、发布版本关联与评论已读记录会计入 skipped', () => {
    const data = makeLegacyData();
    data.plane.blockers.push({ id: 'b2', requirement_id: 'X999', description: '孤儿阻塞', status: 'active', created_at: '2026-03-06T00:00:00Z', created_by: '张三', resolved_at: null, resolved_by: null });
    data.plane.subtasks.push({ id: 's2', requirement_id: 'X999', title: '孤儿任务', status: 'todo', assignee: null, created_at: '2026-03-06T00:00:00Z', updated_at: null });
    data.plane.requirementVersions.push({ requirement_id: 'X999', platform: 'PC客户端', version_id: 'pc-1.0.0' });
    data.plane.commentReads.push({ user_email: 'zhangsan@example.com', requirement_id: 'X999', last_read_at: '2026-03-06T00:00:00Z' });
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    expect(p.report.skipped).toEqual(
      expect.arrayContaining([
        { what: '已删除需求上的阻塞项', count: 1, reason: '需求已在 123plane 中物理删除' },
        { what: '已删除需求上的子任务', count: 1, reason: '需求已在 123plane 中物理删除' },
        { what: '已删除需求上的发布版本关联', count: 1, reason: '需求已在 123plane 中物理删除' },
        { what: '已删除需求上的评论已读记录', count: 1, reason: '需求已在 123plane 中物理删除' },
      ]),
    );
  });

  it('push 合并需求：甘特任务与变更记录跟随 merged_into 链接到合并目标', () => {
    const data = makeLegacyData();
    // push id 4 已 merged_into 3；push id 3 是独有需求（对应 PAN-4）
    data.push.ganttTasks.push({
      id: 3, requirement_id: 4, version_id: null, title: '重复任务甘特', assignee: null, phase: null, plan_start: null,
      plan_days: null, delay_days: null, actual_status: '', note: '', flag: '', created_at: null, alias: null,
      starred: null, ov_assignee: null, ov_status: null, ov_progress: null, manual: null,
    });
    data.push.changeLog.push({ id: 2, entity_type: 'requirement', entity_id: '4', field: 'status', old_value: '待排期', new_value: '已搁置', edited_by: '赵六', edited_at: '2026-03-06 00:00:00' });
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    const target = p.rows.requirements.find((r) => r.number === 4)!;
    expect(target.legacyKey).toBe('push-3');
    expect(p.rows.tasks.find((t) => t.title === '重复任务甘特')).toMatchObject({ requirementId: target.id });
    const event = p.rows.domainEvents.find((e) => e.type === 'legacy.push.change' && (e.payload as { entityId: string }).entityId === '4')!;
    expect(event.subjectId).toBe(target.id);
  });

  it('需求排序按解析后的时间而非原始字符串比较', () => {
    const data = makeLegacyData();
    data.plane.requirements.push(
      planeReq({ id: 'X010', title: '需求A', created_at: '2026-03-05T08:00:00Z' }),
      planeReq({ id: 'X011', title: '需求B', created_at: '2026-03-05 09:00:00' }),
    );
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    const a = p.rows.requirements.find((r) => r.legacyKey === 'X010')!;
    const b = p.rows.requirements.find((r) => r.legacyKey === 'X011')!;
    expect(a.number).toBeLessThan(b.number);
  });

  it('优先级：123plane 为空字符串时取 push 的值', () => {
    const data = makeLegacyData();
    data.plane.requirements[0]!.priority = '';
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    const target = p.rows.requirements.find((r) => r.number === 1)!;
    const values = p.rows.fieldValues.filter((v) => v.entityId === target.id).map((v) => p.rows.fieldOptions.find((o) => o.id === v.optionId)!.label);
    expect(values).toContain('P0');
    expect(values).not.toContain('P1');
  });

  it('评论作者：邮箱未匹配但姓名匹配时不应记为未知人员', () => {
    const data = makeLegacyData();
    data.plane.comments.push({ id: 'c3', requirement_id: 'X001', user_email: 'ghost@example.com', user_name: '张三', content: '姓名回退', created_at: '2026-03-07T00:00:00Z' });
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    const zs = p.rows.members.find((m) => m.displayName === '张三')!;
    const c = p.rows.comments.find((x) => x.body === '姓名回退')!;
    expect(c.authorMemberId).toBe(zs.id);
    expect(p.report.problems).not.toEqual(expect.arrayContaining(['人员对照表缺少：ghost@example.com']));
  });

  it('报告补全：settings / taskTargets / reviewObjections', () => {
    const data = makeLegacyData();
    data.plane.counts.settings = 5;
    data.push.counts.settings = 4;
    data.push.counts.taskTargets = 3;
    data.push.counts.reviewObjections = 2;
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    expect(p.report.deferred).toEqual(
      expect.arrayContaining([
        { what: 'push 任务对象（task_targets）', count: 3, phase: 'P3 通知' },
        { what: '123plane 系统设置（旧系统配置，按 P3 通知重新配置）', count: 5, phase: 'P3 通知' },
        { what: 'push 系统设置（旧系统配置，按 P3 通知重新配置）', count: 4, phase: 'P3 通知' },
      ]),
    );
    expect(p.report.skipped).toEqual(expect.arrayContaining([{ what: 'push 评审异议（review_objections）', count: 2, reason: '无数据/不迁移' }]));
  });
});
