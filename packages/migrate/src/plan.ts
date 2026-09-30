import type { LegacyData } from './legacy-types';
import type { Mapping } from './mapping';
import { buildBase } from './plan-base';
import { buildRequirements } from './plan-requirements';
import { type ImportOptions, type ImportPlan, INSERT_ORDER, PlanContext } from './plan-types';

export function buildImportPlan(data: LegacyData, mapping: Mapping, opts: ImportOptions): ImportPlan {
  const ctx = new PlanContext(data, mapping, opts);
  buildBase(ctx);
  buildRequirements(ctx);
  const { report, rows, resolver } = ctx;
  const unmapped: Array<[string, Set<string>]> = [
    ['人员对照表缺少', resolver.unmapped.people],
    ['平台对照表缺少', resolver.unmapped.platforms],
    ['业务域对照表缺少', resolver.unmapped.domains],
    ['迭代对照表缺少', resolver.unmapped.iterations],
  ];
  for (const [label, set] of unmapped) for (const v of [...set].sort()) ctx.problem(`${label}：${v}`);
  report.proxies = [...resolver.proxies].sort((a, b) => a[0].localeCompare(b[0], 'zh')).map(([raw, refs]) => ({ raw, refs }));

  const { plane, push, prd } = data;
  report.sourceCounts = {
    'plane.users': plane.users.length,
    'plane.requirements': plane.requirements.length,
    'plane.iterations': plane.iterations.length,
    'plane.versions': plane.versions.length,
    'plane.requirementVersions': plane.requirementVersions.length,
    'plane.requirementDevelopers': plane.requirementDevelopers.length,
    'plane.subtasks': plane.subtasks.length,
    'plane.comments': plane.comments.length,
    'plane.commentReads': plane.commentReads.length,
    'plane.activityLog': plane.activityLog.length,
    'plane.blockers': plane.blockers.length,
    'plane.requirementUpdates': plane.requirementUpdates.length,
    'plane.iterationLogs': plane.iterationLogs.length,
    'push.requirements': push.requirements.length,
    'push.versions': push.versions.length,
    'push.ganttTasks': push.ganttTasks.length,
    'push.prdReviews': push.prdReviews.length,
    'push.designSignoffs': push.designSignoffs.length,
    'push.changeLog': push.changeLog.length,
    'push.autoReviews': push.autoReviews.length,
    'prd.domains': prd.domains.length,
    'prd.users': prd.users.length,
  };
  report.targetCounts = Object.fromEntries(INSERT_ORDER.map((k) => [k, rows[k].length]));
  report.deferred.push(
    { what: '123plane 需求简报（HTML）', count: plane.counts.briefs, phase: 'P2 文档附件' },
    { what: 'PRD 页面', count: prd.counts.pages, phase: 'P2 文档' },
    { what: 'PRD 页面修订', count: prd.counts.pageVersions, phase: 'P2 文档' },
    { what: 'PRD 附件', count: prd.counts.attachments, phase: 'P2 文档' },
    { what: 'PRD 评论', count: prd.counts.comments, phase: 'P2 文档' },
    { what: 'push 推送群', count: push.counts.groups, phase: 'P3 通知' },
    { what: 'push 推送计划', count: push.counts.tasks, phase: 'P3 通知' },
    { what: 'push 推送日志', count: push.counts.pushLogs, phase: 'P3 通知' },
    { what: 'push 任务对象（task_targets）', count: push.counts.taskTargets, phase: 'P3 通知' },
    { what: '123plane 系统设置（旧系统配置，按 P3 通知重新配置）', count: plane.counts.settings, phase: 'P3 通知' },
    { what: 'push 系统设置（旧系统配置，按 P3 通知重新配置）', count: push.counts.settings, phase: 'P3 通知' },
  );
  report.skipped.push(
    { what: '123plane 外部 PRD 链接', count: plane.counts.prdLinks, reason: 'spec §7.2：外部 PRD 链接不迁移' },
    { what: 'push 外部 PRD 链接', count: push.counts.prdUrls, reason: 'spec §7.2：外部 PRD 链接不迁移' },
    { what: '123plane 权限配置（role_permissions / user_permission_overrides）', count: plane.counts.rolePermissions + plane.counts.userPermissionOverrides, reason: 'spec §7.2：从未生效，不迁移' },
    { what: '123plane 通知队列与同步收发件箱', count: plane.counts.notificationQueue + plane.counts.syncInbox + plane.counts.syncOutbox, reason: 'spec §7.2：不迁移' },
    { what: 'push 中已标记合并的需求', count: report.matching.pushMergedSkipped, reason: 'push 内已合并进其他需求' },
    { what: 'push 评审异议（review_objections）', count: push.counts.reviewObjections, reason: '无数据/不迁移' },
  );
  report.skipped = report.skipped.filter((s) => s.count > 0);
  report.deferred = report.deferred.filter((d) => d.count > 0);
  return { rows, report };
}
