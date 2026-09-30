import type { ReconReport } from './plan-types';

const table = (head: string[], rows: Array<Array<string | number>>): string =>
  rows.length === 0
    ? '（无）\n'
    : [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n') + '\n';

export function renderReport(r: ReconReport): string {
  const m = r.matching;
  return [
    `# 迁移对账报告：${r.orgSlug}（截至 ${r.asOf}）`,
    '',
    '## 结论',
    '',
    r.problems.length === 0 ? '没有阻止写入的问题，可以写入。' : `有 ${r.problems.length} 个问题，处理前不会写入：\n\n${r.problems.map((p) => `- ${p}`).join('\n')}`,
    '',
    '## 来源数量',
    '',
    table(['来源表', '行数'], Object.entries(r.sourceCounts)),
    '## 写入数量',
    '',
    table(['目标表', '行数'], Object.entries(r.targetCounts)),
    '## 需求匹配',
    '',
    table(
      ['项', '数量'],
      [
        ['123plane 需求', m.planeTotal],
        ['push 需求', m.pushTotal],
        ['push 中已标记合并（跳过）', m.pushMergedSkipped],
        ['按 plane_id 匹配', m.byPlaneId],
        ['按标题匹配', m.byTitle],
        ['push 独有（作为新需求导入）', m.pushOnly],
      ],
    ),
    '### 按标题匹配的需求（请抽查）',
    '',
    table(['编号', '123plane 标题', 'push 标题'], m.titleMatches.map((x) => [x.displayKey, x.planeTitle, x.pushTitle])),
    '## 字段冲突（已按 123plane 为准）',
    '',
    table(['编号', '字段', '123plane', 'push'], r.conflicts.map((c) => [c.displayKey, c.field, c.plane, c.push])),
    '## 迭代',
    '',
    table(['名称', '类型', '123plane', 'push', '开始', '结束', '状态', '需求数'], r.iterations.map((i) => [i.name, i.type === 'regular' ? '常规' : '专项', i.planeIds.join('、'), i.pushIds.join('、'), i.startDate, i.endDate, i.status, i.requirements])),
    '## 人员',
    '',
    table(
      ['key', '名称', '类型', '邮箱', '组织角色', '关联账号', '出现次数'],
      r.people.map((p) => [p.key, p.displayName, p.kind === 'agent' ? 'Agent' : '人', p.email ?? '', p.orgRole, p.hasAccount ? '是' : '', p.mentions]),
    ),
    '### 人员拆分（一个字段写了多人）',
    '',
    '单值字段（需求负责人、提出人、任务负责人、事件操作人）取第一人；多值字段（开发分配、会签签字）每人一条。',
    '',
    table(['原写法', '拆成', '单值引用', '多值引用'], r.personSplits.map((s) => [s.raw, s.people.join('、'), s.singleRefs, s.multiRefs])),
    '### 人员合并（一个成员的其他写法）',
    '',
    table(['key', '名称', '其他写法'], r.personMerges.map((x) => [x.key, x.displayName, x.variants.join('、')])),
    '### 代签写法（按实际操作人导入）',
    '',
    table(['原写法', '次数'], r.proxies.map((x) => [x.raw, x.refs])),
    '## 跳过的数据',
    '',
    table(['内容', '数量', '原因'], r.skipped.map((s) => [s.what, s.count, s.reason])),
    '## 延后迁移',
    '',
    table(['内容', '数量', '阶段'], r.deferred.map((d) => [d.what, d.count, d.phase])),
  ].join('\n');
}
