import { type CheckState, signoffResultState } from '@flower/core';
import type { PlaneRequirement, PushRequirement } from './legacy-types';
import { addDays, normTitle, parseJsonArray, parseLegacyDate, splitNames, splitPlatforms } from './normalize';
import type { PlanContext } from './plan-types';
import {
  BLOCKER_STATUS,
  FEASIBILITY_TO_CHECK,
  ITERATION_LOG_LABEL,
  LINE_OPTIONS,
  PLANE_STATUS_TO_STATE,
  PRD_STATUS_TO_CHECK,
  PRIORITY_KEYS,
  PUSH_REVIEW_TO_CHECK,
  PUSH_STATUS_TO_CHECK,
  parseProxySigner,
  SIGNOFF_DECISION,
  SIGNOFF_ROLES,
  SOURCE_OPTIONS,
  SUBTASK_STATUS,
} from './workflow-v1';

type Pair = { plane: PlaneRequirement | null; push: PushRequirement | null };
type CheckRow = { state: CheckState; note?: string | null; meta?: Record<string, unknown>; updatedBy?: string | null; updatedAt?: Date };

const byCreated = <T extends { created_at: string | null; id: string | number }>(a: T, b: T) =>
  (a.created_at ?? '').localeCompare(b.created_at ?? '') || String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

export function buildRequirements(ctx: PlanContext): void {
  const { data, rows, report, orgId, productId, resolver } = ctx;
  const planeReqs = [...data.plane.requirements].sort(byCreated);
  const pushAll = [...data.push.requirements].sort(byCreated);
  const pushActive = pushAll.filter((p) => p.merged_into === null);
  const planeById = new Map(planeReqs.map((r) => [r.id, r]));

  // 1. 匹配
  const pushForPlane = new Map<string, PushRequirement>();
  const matchedBy = new Map<number, 'plane_id' | 'title'>();
  for (const p of pushActive) {
    const pid = p.plane_id?.trim();
    if (pid && planeById.has(pid) && !pushForPlane.has(pid)) {
      pushForPlane.set(pid, p);
      matchedBy.set(p.id, 'plane_id');
    }
  }
  for (const p of pushActive) {
    if (matchedBy.has(p.id)) continue;
    const t = normTitle(p.title);
    const candidates = planeReqs.filter((r) => !pushForPlane.has(r.id) && normTitle(r.title) === t);
    if (candidates.length === 1) {
      pushForPlane.set(candidates[0]!.id, p);
      matchedBy.set(p.id, 'title');
    }
  }
  const pushOnly = pushActive.filter((p) => !matchedBy.has(p.id));
  const pairs: Pair[] = [...planeReqs.map((r) => ({ plane: r, push: pushForPlane.get(r.id) ?? null })), ...pushOnly.map((p) => ({ plane: null, push: p }))];

  const reqIdOfPlane = new Map<string, string>();
  const reqIdOfPush = new Map<number, string>();
  pairs.forEach((pair) => {
    const id = pair.plane ? ctx.id('req', `plane:${pair.plane.id}`) : ctx.id('req', `push:${pair.push!.id}`);
    if (pair.plane) reqIdOfPlane.set(pair.plane.id, id);
    if (pair.push) reqIdOfPush.set(pair.push.id, id);
  });
  const displayKey = (n: number) => `${ctx.opts.productKey}-${n}`;
  Object.assign(report.matching, {
    planeTotal: planeReqs.length,
    pushTotal: pushAll.length,
    pushMergedSkipped: pushAll.length - pushActive.length,
    byPlaneId: [...matchedBy.values()].filter((x) => x === 'plane_id').length,
    byTitle: [...matchedBy.values()].filter((x) => x === 'title').length,
    pushOnly: pushOnly.length,
  });

  // 2. 逐条需求
  const iterationOf = new Map<string, string | null>();
  pairs.forEach((pair, index) => {
    const number = index + 1;
    const { plane, push } = pair;
    const id = plane ? reqIdOfPlane.get(plane.id)! : reqIdOfPush.get(push!.id)!;
    const ownerNames = splitNames(plane ? plane.owner : push!.owner);
    const requesterNames = splitNames(plane ? plane.requester : push!.requester);
    const createdAt = ctx.time(plane ? plane.created_at : push!.created_at);
    const updatedAt = ctx.time(plane?.updated_at ?? push?.last_edited_at, createdAt);

    let stateKey: string;
    if (plane) {
      stateKey = PLANE_STATUS_TO_STATE[plane.status ?? ''] ?? 'collect';
      if (!PLANE_STATUS_TO_STATE[plane.status ?? '']) ctx.problem(`123plane 状态「${plane.status}」没有对应的流程状态`);
    } else {
      stateKey = push!.status === '已搁置' ? 'shelved' : 'to_evaluate';
    }

    const pushIteration = push?.version_id?.trim() ? resolver.iteration('push', push.version_id) : null;
    const planeIteration = !pushIteration && plane?.iteration_id?.trim() ? resolver.iteration('plane', plane.iteration_id) : null;
    const iterationEntry = pushIteration ?? planeIteration;
    const iterationId = iterationEntry ? ctx.iterationIdByKey.get(iterationEntry.key) ?? null : null;
    iterationOf.set(id, iterationId);

    const nodeName = plane ? resolver.domain(plane.business_domain) : null;
    if (plane && pushForPlane.get(plane.id) && matchedBy.get(push!.id) === 'title') {
      report.matching.titleMatches.push({ displayKey: displayKey(number), planeTitle: plane.title, pushTitle: push!.title });
    }
    if (plane && push) {
      const cmp: Array<[string, string, string]> = [
        ['title', plane.title.trim(), push.title.trim()],
        ['priority', plane.priority ?? '', push.priority ?? ''],
        ['owner', splitNames(plane.owner)[0] ?? '', splitNames(push.owner)[0] ?? ''],
        ['requester', splitNames(plane.requester)[0] ?? '', splitNames(push.requester)[0] ?? ''],
      ];
      for (const [field, a, b] of cmp) if (a && b && a !== b) report.conflicts.push({ displayKey: displayKey(number), field, plane: a, push: b });
    }

    rows.requirements.push({
      id,
      orgId,
      productId,
      number,
      legacyKey: plane ? plane.id : `push-${push!.id}`,
      title: (plane ? plane.title : push!.title).trim(),
      description: plane ? (plane.description ?? '') : (push!.brief ?? ''),
      stateKey,
      stateChangedAt: createdAt,
      ownerMemberId: ctx.memberId(ownerNames[0]),
      requesterMemberId: ctx.memberId(requesterNames[0]),
      nodeId: nodeName ? ctx.nodeIdByName.get(nodeName) ?? null : null,
      iterationId,
      legacyMeta: {
        ...(plane && {
          plane: {
            id: plane.id,
            phase: plane.phase,
            acceptanceStatus: plane.acceptance_status,
            iterationStatus: plane.iteration_status,
            estimatedEffort: plane.estimated_effort,
            sourceNote: plane.source,
            notes: plane.notes,
            coOwners: splitNames(plane.owner).slice(1),
          },
        }),
        ...(push && {
          push: { id: push.id, alias: push.alias, developers: parseJsonArray(push.developers), lastEditedBy: push.last_edited_by, coOwners: splitNames(push.owner).slice(1) },
        }),
      },
      createdBy: null,
      createdAt,
      updatedAt,
    });
    rows.entityAliases.push(...[plane?.id, push ? `push-${push.id}` : null].filter((a): a is string => !!a).map((alias) => ({ id: ctx.id('alias', alias), orgId, entityType: 'requirement' as const, entityId: id, alias })));

    // 字段值
    const addValue = (fieldKey: string, optionKey: string | undefined) => {
      if (!optionKey) return;
      const optionId = ctx.optionId(fieldKey, optionKey);
      if (!optionId) return ctx.problem(`字段「${fieldKey}」缺少选项「${optionKey}」`);
      if (rows.fieldValues.some((v) => v.entityId === id && v.optionId === optionId)) return;
      rows.fieldValues.push({ id: ctx.id('field-value', `${id}:${optionId}`), orgId, entityType: 'requirement', entityId: id, fieldId: ctx.fieldId.get(fieldKey)!, optionId });
    };
    const priority = (plane?.priority ?? push?.priority ?? '').trim();
    if (priority) {
      if (!PRIORITY_KEYS[priority]) ctx.problem(`优先级「${priority}」没有对应选项`);
      addValue('priority', PRIORITY_KEYS[priority]);
    }
    const platformRaws = plane && splitPlatforms(plane.platform).length ? splitPlatforms(plane.platform) : parseJsonArray(push?.platforms);
    for (const raw of platformRaws) for (const k of resolver.platforms(raw)) addValue('platform', k);
    if (push?.line) addValue('line', LINE_OPTIONS.find((o) => o.label === push.line?.trim())?.key ?? (ctx.problem(`业务线「${push.line}」没有对应选项`), undefined));
    if (push?.source) addValue('source', SOURCE_OPTIONS.find((o) => o.label === push.source?.trim())?.key ?? (ctx.problem(`来源「${push.source}」没有对应选项`), undefined));

    // 检查项
    const results = new Map<string, CheckRow>();
    const review = push ? data.push.prdReviews.find((r) => r.requirement_id === push.id) : undefined;
    const statusCheck = push ? PUSH_STATUS_TO_CHECK[push.status ?? ''] : undefined;
    if (push && statusCheck === undefined) ctx.problem(`push 状态「${push.status}」没有对应规则`);
    const fromReview = (state: string | null, by: string | null, at: string | null, note: string | null): CheckRow | null => {
      if (!state) return null;
      const s = PUSH_REVIEW_TO_CHECK[state];
      if (!s) {
        ctx.problem(`push 评审状态「${state}」没有对应的检查状态`);
        return null;
      }
      return { state: s, note, updatedBy: ctx.memberId(by), updatedAt: ctx.time(at, createdAt) };
    };
    (['background', 'feasibility', 'industry'] as const).forEach((key, i) => {
      const e = (['e1', 'e2', 'e3'] as const)[i]!;
      const r = review ? fromReview(review[`${e}_state`], review[`${e}_by`], review[`${e}_at`], review[`${e}_note`]) : null;
      if (r) results.set(key, r);
      else if (statusCheck) results.set(key, { state: statusCheck });
    });
    if (plane && !results.has('feasibility')) {
      const s = FEASIBILITY_TO_CHECK[plane.feasibility_status ?? 'not-assessed'];
      if (!s) ctx.problem(`123plane 可行性状态「${plane.feasibility_status}」没有对应的检查状态`);
      else results.set('feasibility', { state: s });
    }
    if (plane) {
      const s = PRD_STATUS_TO_CHECK[plane.prd_status ?? 'not-started'];
      if (!s) ctx.problem(`123plane PRD 状态「${plane.prd_status}」没有对应的检查状态`);
      else results.set('prd', { state: s });
    }
    const autoReviews = push ? data.push.autoReviews.filter((a) => a.requirement_id === push.id).sort((a, b) => a.round - b.round) : [];
    if (autoReviews.length) {
      const last = autoReviews.at(-1)!;
      results.set('ai_review', {
        state: last.blocking_count > 0 ? 'rejected' : 'passed',
        meta: {
          rounds: autoReviews.map((a) => ({
            round: a.round,
            issueCount: a.issue_count,
            blockingCount: a.blocking_count,
            reviewedBy: a.reviewed_by,
            reviewedAt: a.reviewed_at,
            issues: (() => {
              try {
                return JSON.parse(a.issues ?? '[]') as unknown;
              } catch {
                return a.issues;
              }
            })(),
          })),
        },
        updatedBy: ctx.memberId(last.reviewed_by),
        updatedAt: ctx.time(last.reviewed_at, createdAt),
      });
    }
    const designItem = ctx.workflow.checkItems.find((c) => c.key === 'design_signoff')!;
    const signoffRows = push ? data.push.designSignoffs.filter((s) => s.requirement_id === push.id) : [];
    const designResultId = ctx.id('check', `${id}:design_signoff`);
    const signoffs: Array<{ signerRuleIndex: number; decision: 'passed' | 'rejected'; at: Date }> = [];
    let mismatched = 0;
    for (const s of signoffRows) {
      const decision = SIGNOFF_DECISION[s.state ?? '未审'];
      if (decision === undefined) ctx.problem(`push 会签状态「${s.state}」没有对应规则`);
      if (!decision || !s.by) continue;
      const ruleIndex = (SIGNOFF_ROLES as readonly string[]).indexOf(s.role);
      if (ruleIndex < 0) {
        ctx.problem(`push 会签角色「${s.role}」没有对应的签字规则`);
        continue;
      }
      const proxy = parseProxySigner(s.by);
      const signer = proxy ? resolver.signoffRole(proxy.onBehalfOf) : resolver.person(s.by);
      const signerId = signer ? ctx.memberIdByKey.get(signer.key)! : null;
      if (!signerId) continue;
      const at = ctx.time(s.at, createdAt);
      const rule = designItem.signers![ruleIndex]!;
      if (rule.by === 'member' && rule.ref !== signerId) mismatched += 1;
      rows.checkItemSignoffs.push({
        id: ctx.id('signoff', `push:${s.id}`),
        orgId,
        resultId: designResultId,
        signerMemberId: signerId,
        actedByMemberId: proxy ? ctx.memberId(proxy.actor) : null,
        signerRuleIndex: ruleIndex,
        decision,
        note: s.opinion?.trim() || null,
        at,
      });
      signoffs.push({ signerRuleIndex: ruleIndex, decision, at });
    }
    if (mismatched) report.skipped.push({ what: '签字人与"指定成员"规则不一致的会签（已按原样导入）', count: mismatched, reason: '旧系统允许其他人在该栏签字' });
    if (signoffs.length) results.set('design_signoff', { state: signoffResultState(designItem, signoffs) });

    for (const [itemKey, r] of results) {
      if (r.state === 'not_started' && !r.note && !r.meta) continue;
      rows.checkItemResults.push({
        id: itemKey === 'design_signoff' ? designResultId : ctx.id('check', `${id}:${itemKey}`),
        orgId,
        targetType: 'requirement',
        targetId: id,
        itemKey,
        state: r.state,
        note: r.note ?? null,
        meta: r.meta ?? {},
        updatedBy: r.updatedBy ?? null,
        updatedAt: r.updatedAt ?? updatedAt,
      });
    }

    // 开发分配
    if (plane) {
      for (const d of data.plane.requirementDevelopers.filter((x) => x.requirement_id === plane.id)) {
        const memberId = ctx.memberId(d.developer);
        if (!memberId) continue;
        const platformKey = d.platform ? resolver.platforms(d.platform)[0] : undefined;
        const platformOptionId = platformKey ? ctx.optionId('platform', platformKey) : null;
        if (rows.requirementAssignments.some((a) => a.requirementId === id && a.memberId === memberId && a.platformOptionId === platformOptionId)) continue;
        rows.requirementAssignments.push({ id: ctx.id('assignment', `plane:${d.id}`), orgId, requirementId: id, memberId, functionTagId: ctx.tagIdByName.get('开发') ?? null, platformOptionId });
      }
    }

    // 流转历史
    const logs = plane ? data.plane.activityLog.filter((a) => a.requirement_id === plane.id && a.action === 'status_change') : [];
    const mapState = (label: string | null) => {
      const k = PLANE_STATUS_TO_STATE[label ?? ''];
      if (!k) ctx.problem(`123plane 状态「${label}」没有对应的流程状态`);
      return k ?? 'collect';
    };
    const firstFrom = logs.length ? mapState(logs[0]!.old_value) : stateKey;
    rows.stateTransitions.push({ id: ctx.id('transition', `${id}:created`), orgId, requirementId: id, fromState: null, toState: firstFrom, actorMemberId: null, forced: false, reason: null, at: createdAt });
    for (const a of logs) {
      rows.stateTransitions.push({
        id: ctx.id('transition', `plane:${a.id}`),
        orgId,
        requirementId: id,
        fromState: mapState(a.old_value),
        toState: mapState(a.new_value),
        actorMemberId: ctx.memberId(a.user_email),
        forced: false,
        reason: null,
        at: ctx.time(a.created_at, createdAt),
      });
    }
    const last = rows.requirements.at(-1)!;
    last.stateChangedAt = logs.length ? ctx.time(logs.at(-1)!.created_at, createdAt) : createdAt;
  });
  rows.products[0]!.requirementSeq = pairs.length;

  // 3. 评论、进展、迭代日志、已读
  let orphanComments = 0;
  for (const c of data.plane.comments) {
    const target = reqIdOfPlane.get(c.requirement_id);
    if (!target) {
      orphanComments += 1;
      continue;
    }
    rows.comments.push({
      id: ctx.id('comment', `plane:${c.id}`),
      orgId,
      targetType: 'requirement',
      targetId: target,
      authorMemberId: ctx.memberId(c.user_email) ?? ctx.memberId(c.user_name),
      body: c.content,
      kind: 'comment',
      createdAt: ctx.time(c.created_at),
    });
  }
  for (const u of data.plane.requirementUpdates) {
    const target = reqIdOfPlane.get(u.requirement_id);
    if (!target) {
      orphanComments += 1;
      continue;
    }
    rows.comments.push({ id: ctx.id('comment', `update:${u.id}`), orgId, targetType: 'requirement', targetId: target, authorMemberId: ctx.memberId(u.created_by), body: u.content, kind: 'update', createdAt: ctx.time(u.created_at) });
  }
  for (const l of data.plane.iterationLogs) {
    const reqTarget = l.requirement_id ? reqIdOfPlane.get(l.requirement_id) : undefined;
    const it = resolver.iteration('plane', l.iteration_id);
    const iterTarget = it ? ctx.iterationIdByKey.get(it.key) : undefined;
    const targetId = reqTarget ?? iterTarget;
    if (!targetId) {
      orphanComments += 1;
      continue;
    }
    rows.comments.push({
      id: ctx.id('comment', `iteration-log:${l.id}`),
      orgId,
      targetType: reqTarget ? 'requirement' : 'iteration',
      targetId,
      authorMemberId: ctx.memberId(l.created_by),
      body: `【${ITERATION_LOG_LABEL[l.type ?? ''] ?? l.type ?? '记录'}】${l.content}`,
      kind: 'update',
      createdAt: ctx.time(l.created_at),
    });
  }
  if (orphanComments) report.skipped.push({ what: '已删除需求上的评论', count: orphanComments, reason: '需求已在 123plane 中物理删除' });
  for (const r of data.plane.commentReads) {
    const target = reqIdOfPlane.get(r.requirement_id);
    const memberId = ctx.memberId(r.user_email);
    const readAt = ctx.time(r.last_read_at);
    if (!target || !memberId) continue;
    for (const c of rows.comments.filter((x) => x.targetId === target && x.createdAt!.getTime() <= readAt.getTime())) {
      if (rows.commentReads.some((x) => x.commentId === c.id && x.memberId === memberId)) continue;
      rows.commentReads.push({ orgId, commentId: c.id!, memberId, readAt });
    }
  }

  // 4. 阻塞项
  for (const b of data.plane.blockers) {
    const target = reqIdOfPlane.get(b.requirement_id);
    if (!target) continue;
    const status = BLOCKER_STATUS[b.status ?? 'active'];
    if (!status) ctx.problem(`阻塞项状态「${b.status}」没有对应规则`);
    rows.blockers.push({ id: ctx.id('blocker', b.id), orgId, requirementId: target, description: b.description, status: status ?? 'active', ownerMemberId: null, createdAt: ctx.time(b.created_at), resolvedAt: b.resolved_at ? ctx.time(b.resolved_at) : null });
  }

  // 5. 任务
  for (const s of data.plane.subtasks) {
    const target = reqIdOfPlane.get(s.requirement_id);
    if (!target) continue;
    const status = SUBTASK_STATUS[s.status ?? 'todo'];
    if (!status) ctx.problem(`子任务状态「${s.status}」没有对应规则`);
    const createdAt = ctx.time(s.created_at);
    rows.tasks.push({ id: ctx.id('task', `plane:${s.id}`), orgId, productId, requirementId: target, iterationId: iterationOf.get(target) ?? null, title: s.title, assigneeMemberId: ctx.memberId(s.assignee), status: status ?? 'todo', meta: {}, legacyKey: `plane:${s.id}`, createdAt, updatedAt: ctx.time(s.updated_at, createdAt) });
  }
  for (const g of data.push.ganttTasks) {
    const it = g.version_id?.trim() ? resolver.iteration('push', g.version_id) : null;
    const start = parseLegacyDate(g.plan_start);
    const end = start ? addDays(start, (g.plan_days ?? 0) + (g.delay_days ?? 0)) : null;
    const status = !start ? 'todo' : end! <= ctx.opts.asOf ? 'done' : start <= ctx.opts.asOf ? 'doing' : 'todo';
    const createdAt = ctx.time(g.created_at);
    rows.tasks.push({
      id: ctx.id('task', `push:${g.id}`),
      orgId,
      productId,
      requirementId: g.requirement_id === null ? null : (reqIdOfPush.get(g.requirement_id) ?? null),
      iterationId: it ? ctx.iterationIdByKey.get(it.key) ?? null : null,
      title: g.title,
      alias: g.alias,
      assigneeMemberId: ctx.memberId(g.ov_assignee || g.assignee),
      status,
      planStart: start,
      planDays: g.plan_days,
      delayDays: g.delay_days,
      phase: g.phase,
      flag: g.flag,
      starred: g.starred === null ? null : g.starred === 1,
      meta: { note: g.note, actualStatus: g.actual_status, manual: g.manual, ovAssignee: g.ov_assignee, ovStatus: g.ov_status, ovProgress: g.ov_progress },
      legacyKey: `push:${g.id}`,
      createdAt,
      updatedAt: createdAt,
    });
  }

  // 6. 发布版本关联
  for (const rv of data.plane.requirementVersions) {
    const requirementId = reqIdOfPlane.get(rv.requirement_id);
    const releaseId = ctx.releaseIdByPlaneId.get(rv.version_id);
    if (!requirementId || !releaseId) continue;
    if (rows.requirementReleases.some((x) => x.requirementId === requirementId && x.releaseId === releaseId)) continue;
    rows.requirementReleases.push({ orgId, requirementId, releaseId });
  }

  // 7. 审计事件
  for (const a of data.plane.activityLog) {
    const subject = a.requirement_id ? (reqIdOfPlane.get(a.requirement_id) ?? ctx.id('deleted-requirement', `plane:${a.requirement_id}`)) : ctx.id('deleted-requirement', 'plane:unknown');
    let details: unknown = a.details;
    try {
      details = a.details ? JSON.parse(a.details) : null;
    } catch {
      // 保留原始字符串
    }
    rows.domainEvents.push({
      id: ctx.id('event', `plane:${a.id}`),
      orgId,
      productId,
      type: `legacy.123plane.${a.action}`,
      subjectType: 'requirement',
      subjectId: subject,
      actorMemberId: ctx.memberId(a.user_email),
      actorTokenId: null,
      payload: { schemaVersion: 1, source: '123plane', requirementId: a.requirement_id, action: a.action, oldValue: a.old_value, newValue: a.new_value, details },
      occurredAt: ctx.time(a.created_at),
    });
  }
  for (const c of data.push.changeLog) {
    const pushId = Number(c.entity_id);
    const subject = reqIdOfPush.get(pushId) ?? ctx.id('deleted-requirement', `push:${c.entity_id}`);
    rows.domainEvents.push({
      id: ctx.id('event', `push:${c.id}`),
      orgId,
      productId,
      type: 'legacy.push.change',
      subjectType: 'requirement',
      subjectId: subject,
      actorMemberId: ctx.memberId(c.edited_by),
      actorTokenId: null,
      payload: { schemaVersion: 1, source: 'push', entityType: c.entity_type, entityId: c.entity_id, field: c.field, oldValue: c.old_value, newValue: c.new_value },
      occurredAt: ctx.time(c.edited_at),
    });
  }

  // 8. 迭代统计
  for (const e of ctx.mapping.iterations.iterations) {
    const itId = ctx.iterationIdByKey.get(e.key);
    const row = rows.iterations.find((i) => i.id === itId);
    if (!row) continue;
    report.iterations.push({
      name: e.name,
      type: e.type,
      planeIds: e.planeIds,
      pushIds: e.pushIds,
      startDate: row.startDate,
      endDate: row.endDate,
      status: row.status ?? 'planning',
      requirements: rows.requirements.filter((r) => r.iterationId === itId).length,
    });
  }
}
