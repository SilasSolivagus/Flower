import { BUILTIN_FIELDS, DEFAULT_FUNCTION_TAGS, type IterationMilestone, validateWorkflowBody } from '@flower/core';
import { parseLegacyDate, parseLegacyTime } from './normalize';
import type { PlanContext } from './plan-types';
import { iterationWindow } from './suggest';
import {
  ALL_FUNCTION_TAG_NAMES,
  BOSS_ROLE,
  buildWorkflowV1Body,
  LINE_OPTIONS,
  PLANE_ITERATION_STATUS,
  PRIORITY_OPTIONS,
  PUSH_VERSION_STATUS,
  SOURCE_OPTIONS,
} from './workflow-v1';

const EXTRA_TAG_COLORS = ['#b7791f', '#db2777', '#5c6570', '#1e8a5a', '#0f766e'];

export function buildBase(ctx: PlanContext): void {
  const { rows, opts, mapping, data, orgId, productId } = ctx;
  const createdAt = ctx.asOfTime;
  rows.organizations.push({ id: orgId, slug: opts.orgSlug, name: opts.orgName, settings: {}, createdAt });

  // 职能标签
  const tagNames = [...ALL_FUNCTION_TAG_NAMES];
  for (const p of mapping.people.people) for (const t of p.functionTags) if (!tagNames.includes(t)) tagNames.push(t);
  tagNames.forEach((name, i) => {
    const color = DEFAULT_FUNCTION_TAGS.find((t) => t.name === name)?.color ?? EXTRA_TAG_COLORS[i % EXTRA_TAG_COLORS.length]!;
    const id = ctx.id('tag', name);
    ctx.tagIdByName.set(name, id);
    rows.functionTags.push({ id, orgId, name, color, sort: i });
  });

  // 成员
  const ownerEmail = opts.owner?.email.trim().toLowerCase();
  let ownerLinked = false;
  for (const p of mapping.people.people) {
    const id = ctx.id('member', p.key);
    ctx.memberIdByKey.set(p.key, id);
    const isOwner = !!ownerEmail && p.email?.toLowerCase() === ownerEmail;
    ownerLinked ||= isOwner;
    rows.members.push({
      id,
      orgId,
      accountId: isOwner ? opts.owner!.accountId : null,
      kind: 'human',
      displayName: p.displayName,
      email: p.email,
      orgRole: isOwner ? 'owner' : p.orgRole,
      status: 'active',
      createdAt,
    });
    for (const t of p.functionTags) rows.memberFunctionTags.push({ orgId, memberId: id, tagId: ctx.tagIdByName.get(t)! });
    if (p.productRole && !isOwner && p.orgRole !== 'admin') rows.productMembers.push({ orgId, productId, memberId: id, role: p.productRole });
    ctx.report.people.push({ key: p.key, displayName: p.displayName, email: p.email, orgRole: isOwner ? 'owner' : p.orgRole, hasAccount: isOwner, mentions: p.mentions });
  }
  if (opts.owner && !ownerLinked) {
    rows.members.push({ id: ctx.id('member', '__owner'), orgId, accountId: opts.owner.accountId, kind: 'human', displayName: opts.owner.name, email: ownerEmail ?? null, orgRole: 'owner', status: 'active', createdAt });
  }

  // 字段与选项
  const optionSets: Record<string, Array<{ key: string; label: string; color?: string | null }>> = {
    priority: PRIORITY_OPTIONS,
    platform: mapping.platforms.options,
    source: SOURCE_OPTIONS,
    line: LINE_OPTIONS,
  };
  for (const f of BUILTIN_FIELDS) {
    const fieldId = ctx.id('field', f.key);
    ctx.fieldId.set(f.key, fieldId);
    rows.fieldDefinitions.push({ id: fieldId, orgId, productId: null, key: f.key, label: f.label, cardinality: f.cardinality, builtin: true, createdAt });
    (optionSets[f.key] ?? []).forEach((o, i) =>
      rows.fieldOptions.push({ id: ctx.id('option', `${f.key}:${o.key}`), orgId, fieldId, key: o.key, label: o.label, color: o.color ?? null, sort: i, active: true }),
    );
  }

  // 流程 v1
  const boss = ctx.resolver.signoffRole(BOSS_ROLE);
  if (!boss) ctx.problem(`会签角色「${BOSS_ROLE}」没有对应成员（people.json 的 signoffRoles）`);
  const bossId = boss ? ctx.memberIdByKey.get(boss.key)! : ctx.id('member', '__missing_boss');
  ctx.workflow = buildWorkflowV1Body(ctx.tagIdByName, bossId);
  const valid = validateWorkflowBody(ctx.workflow, { fieldKeys: BUILTIN_FIELDS.map((f) => f.key) });
  if (!valid.ok) ctx.problem(`流程 v1 校验失败：${valid.issues.map((i) => `${i.path} ${i.message}`).join('；')}`);
  const definitionId = ctx.id('workflow', 'v1');
  const versionId = ctx.id('workflow-version', 'v1');
  rows.workflowDefinitions.push({ id: definitionId, orgId, productId: null, name: '123云盘流程', currentVersionId: versionId, createdAt });
  rows.workflowVersions.push({ id: versionId, orgId, definitionId, version: 1, body: ctx.workflow, note: '由旧系统迁移生成', createdBy: null, createdAt });
  rows.products.push({ id: productId, orgId, key: opts.productKey, name: opts.productName, status: 'active', workflowVersionId: versionId, requirementSeq: 0, createdAt });

  // 结构树第一层
  mapping.domains.nodes.forEach((n, i) => {
    const id = ctx.id('node', n.name);
    ctx.nodeIdByName.set(n.name, id);
    rows.structureNodes.push({ id, orgId, productId, parentId: null, depth: 1, name: n.name, description: n.description, status: 'active', sort: i, legacyKey: n.aliases.join('|'), createdAt });
  });

  // 迭代
  for (const e of mapping.iterations.iterations) {
    const w = iterationWindow(e, data);
    if (!w) {
      ctx.problem(`迭代「${e.name}」缺少开始或发布日期`);
      continue;
    }
    if (w.start > w.end) ctx.problem(`迭代「${e.name}」开始日期晚于结束日期`);
    const plane = data.plane.iterations.find((i) => e.planeIds.includes(i.id));
    const push = data.push.versions.find((v) => e.pushIds.includes(v.id));
    let status = (plane?.status && PLANE_ITERATION_STATUS[plane.status]) || (push?.status && PUSH_VERSION_STATUS[push.status]) || 'planning';
    if (w.end < ctx.opts.asOf) status = 'done';
    const milestones: IterationMilestone[] = plane
      ? ([
          ['预发布', plane.pre_launch_date],
          ['启动', plane.kickoff_date],
          ['开发开始', plane.dev_start],
          ['开发结束', plane.dev_end],
          ['中间发布', plane.interim_release_date],
          ['发布', push?.release_date ?? plane.release_date],
        ] as const)
          .map(([label, d]) => ({ label, date: parseLegacyDate(d) ?? '' }))
          .filter((m) => m.date)
      : [
          { label: '开始', date: w.start },
          { label: '发布', date: w.end },
        ];
    const id = ctx.id('iteration', e.key);
    ctx.iterationIdByKey.set(e.key, id);
    rows.iterations.push({
      id,
      orgId,
      productId: e.type === 'regular' ? productId : null,
      type: e.type,
      name: e.name,
      legacyKey: [...e.planeIds, ...e.pushIds].join('|'),
      startDate: w.start,
      endDate: w.end,
      baselineEndDate: status === 'planning' ? null : w.end,
      status,
      milestones,
      createdAt,
    });
  }
  const regular = rows.iterations.filter((i) => i.type === 'regular').sort((a, b) => a.startDate.localeCompare(b.startDate));
  for (let i = 1; i < regular.length; i++) {
    const prev = regular[i - 1]!;
    const cur = regular[i]!;
    if (cur.startDate < prev.endDate) ctx.problem(`常规迭代「${prev.name}」与「${cur.name}」时间重叠（结束日可以等于下一迭代的开始日）`);
  }

  // 发布版本
  for (const v of data.plane.versions) {
    const platformKey = v.platform ? ctx.resolver.platforms(v.platform)[0] : undefined;
    const id = ctx.id('release', v.id);
    ctx.releaseIdByPlaneId.set(v.id, id);
    rows.releases.push({
      id,
      orgId,
      productId,
      platformOptionId: platformKey ? ctx.optionId('platform', platformKey) : null,
      versionName: v.id.includes('-') ? v.id.slice(v.id.indexOf('-') + 1) : v.id,
      iterationId: null,
      status: v.status === 'released' ? 'released' : 'planned',
      plannedDate: parseLegacyDate(v.planned_release_date),
      baselineDate: parseLegacyDate(v.planned_release_date),
      releasedAt: parseLegacyTime(v.released_at),
      notes: [v.description, v.release_content].filter((x) => x?.trim()).join('\n\n') || null,
      legacyKey: v.id,
      createdAt,
    });
  }
}
