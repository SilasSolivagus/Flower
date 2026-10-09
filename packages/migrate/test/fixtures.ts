import type { Mapping } from '../src/mapping';
import { suggestMapping } from '../src/suggest';
import type { LegacyData, PlaneRequirement, PushRequirement } from '../src/legacy-types';

export const planeReq = (r: Partial<PlaneRequirement> & { id: string; title: string }): PlaneRequirement => ({
  description: null, status: '收集', phase: null, priority: 'P2', business_domain: '', platform: '', requester: null, owner: null,
  version_id: null, source: null, estimated_effort: null, prd_link: null, notes: null, created_at: '2026-03-01T00:00:00Z',
  updated_at: null, prd_status: 'not-started', feasibility_status: 'not-assessed', iteration_status: 'active',
  acceptance_status: 'not-started', iteration_id: '', ...r,
});

const pushReq = (r: Partial<PushRequirement> & { id: number; title: string }): PushRequirement => ({
  alias: null, requester: null, owner: null, line: '功能', priority: 'P2', platforms: '[]', developers: '[]', brief: null,
  status: '待排期', source: '原创', version_id: '', created_at: '2026-03-02 00:00:00', last_edited_by: null, last_edited_at: null,
  plane_id: '', prd_url: null, merged_into: null, ...r,
});

export function makeLegacyData(): LegacyData {
  return {
    plane: {
      users: [
        { id: 'u1', email: 'zhangsan@example.com', name: '张三', nickname: null, role: 'admin', created_at: '2026-03-01 00:00:00' },
        { id: 'u2', email: 'lisi@example.com', name: '李四', nickname: null, role: 'member', created_at: '2026-03-01 00:00:00' },
        { id: 'u3', email: 'laoban@example.com', name: '王老板', nickname: null, role: 'viewer', created_at: '2026-03-01 00:00:00' },
      ],
      requirements: [
        planeReq({ id: 'X001', title: '批量下载', status: '开发中', priority: 'P1', business_domain: '会员', platform: 'PC客户端,web', requester: '客户甲', owner: '张三', iteration_id: 'V1', prd_status: 'approved', feasibility_status: 'approved', created_at: '2026-03-01T08:00:00+00:00', updated_at: '2026-03-10T08:00:00Z' }),
        planeReq({ id: 'X002', title: '相册归类', status: '收集', priority: '绿色通道', business_domain: '会员与支付', platform: '全端', requester: '客户乙', owner: '李四、张三', created_at: '2026-03-02T08:00:00Z' }),
        planeReq({ id: 'X003', title: '分享密码', status: '已上线', priority: 'P0', requester: '客户甲', owner: '张三', iteration_id: 'V2', acceptance_status: 'accepted', created_at: '2026-03-03T08:00:00Z' }),
      ],
      iterations: [
        { id: 'V1', status: '已完成', pre_launch_date: '2026-03-01', kickoff_date: '2026-03-02', dev_start: '2026-03-02', dev_end: '2026-03-13', interim_release_date: null, release_date: '2026-03-16', notes: null, created_at: null },
        { id: 'V1dup', status: '已完成', pre_launch_date: '2026-03-01', kickoff_date: '2026-03-02', dev_start: '2026-03-02', dev_end: '2026-03-13', interim_release_date: null, release_date: '2026-03-16', notes: null, created_at: null },
        { id: 'V2', status: '进行中', pre_launch_date: null, kickoff_date: '2026-03-17', dev_start: '2026-03-17', dev_end: '2026-03-27', interim_release_date: null, release_date: '2026-03-30', notes: null, created_at: null },
      ],
      versions: [{ id: 'pc-1.0.0', platform: 'PC客户端', status: 'released', planned_release_date: '', released_at: '2026-03-20T10:00:00Z', description: '首个版本', release_content: null, created_at: null }],
      requirementVersions: [{ requirement_id: 'X003', platform: 'PC客户端', version_id: 'pc-1.0.0' }],
      requirementDevelopers: [
        { id: 'd1', requirement_id: 'X001', platform: 'PC客户端', developer: '王五', created_at: null },
        { id: 'd2', requirement_id: 'X001', platform: 'Web端', developer: '王五', created_at: null },
      ],
      subtasks: [{ id: 's1', requirement_id: 'X001', title: '接口联调', status: 'todo', assignee: '王五', created_at: '2026-03-04T00:00:00Z', updated_at: null }],
      comments: [
        { id: 'c1', requirement_id: 'X001', user_email: 'lisi@example.com', user_name: '李四', content: '请确认范围', created_at: '2026-03-03T00:00:00Z' },
        { id: 'c2', requirement_id: 'X999', user_email: 'lisi@example.com', user_name: '李四', content: '已删除需求上的评论', created_at: '2026-03-03T00:00:00Z' },
      ],
      commentReads: [{ user_email: 'zhangsan@example.com', requirement_id: 'X001', last_read_at: '2026-03-04T00:00:00Z' }],
      activityLog: [
        { id: 'a1', requirement_id: 'X001', user_email: 'zhangsan@example.com', action: 'status_change', old_value: '收集', new_value: '开发中', details: '{}', created_at: '2026-03-05T00:00:00Z' },
        { id: 'a2', requirement_id: 'X999', user_email: 'zhangsan@example.com', action: 'deleted', old_value: null, new_value: null, details: '{"id":"X999","title":"被删掉的需求"}', created_at: '2026-03-06T00:00:00Z' },
        { id: 'a3', requirement_id: 'X002', user_email: 'lisi@example.com', action: 'created', old_value: null, new_value: null, details: '{}', created_at: '2026-03-02T08:00:00Z' },
      ],
      blockers: [{ id: 'b1', requirement_id: 'X001', description: '等待支付接口', status: 'active', created_at: '2026-03-05T00:00:00Z', created_by: '张三', resolved_at: null, resolved_by: null }],
      requirementUpdates: [{ id: 'up1', requirement_id: 'X001', content: '联调中', created_by: '张三', created_at: '2026-03-06T00:00:00Z' }],
      iterationLogs: [{ id: 'l1', iteration_id: 'V2', type: 'risk', content: '人手紧张', requirement_id: null, created_by: '张三', created_at: '2026-03-18T00:00:00Z' }],
      counts: { briefs: 1, settings: 5, notificationQueue: 2, syncInbox: 0, syncOutbox: 0, rolePermissions: 3, userPermissionOverrides: 1, prdLinks: 1 },
    },
    push: {
      requirements: [
        pushReq({ id: 1, title: '批量下载（PC/Web）', plane_id: 'X001', priority: 'P0', status: '已进版本', version_id: 'it0316', owner: '张三', requester: '客户甲', platforms: '["pc"]', developers: '["前端"]' }),
        pushReq({ id: 2, title: '相册 归类！', status: '评审中', owner: '李四', requester: '客户乙' }),
        pushReq({ id: 3, title: '离线下载', status: '待排期', owner: '赵六', requester: '客户丙', platforms: '["鸿蒙"]', version_id: 'it0330', line: '商业', source: '线上问题', brief: '支持离线下载' }),
        pushReq({ id: 4, title: '离线下载（重复）', merged_into: 3 }),
        pushReq({ id: 5, title: '已搁置需求', status: '已搁置', owner: '赵六' }),
      ],
      versions: [
        { id: 'it0316', name: null, start_date: '2026-03-02', release_date: '2026-03-16', status: '已发版', created_at: null },
        { id: 'sp1', name: '专项', start_date: '2026-03-05', release_date: '2026-03-25', status: '已发版', created_at: null },
        { id: 'it0330', name: null, start_date: '2026-03-17', release_date: '2026-03-31', status: '已发版', created_at: null },
      ],
      ganttTasks: [
        { id: 1, requirement_id: 1, version_id: 'it0316', title: '前端开发', assignee: '王五', phase: '开发中', plan_start: '2026-03-02', plan_days: 5, delay_days: 0, actual_status: '', note: '', flag: '正常', created_at: null, alias: null, starred: 0, ov_assignee: null, ov_status: null, ov_progress: null, manual: 0 },
        { id: 2, requirement_id: null, version_id: 'sp1', title: '专项设计', assignee: '赵六', phase: '设计中', plan_start: '2026-09-20', plan_days: 30, delay_days: 0, actual_status: '', note: '', flag: '关注', created_at: null, alias: null, starred: 1, ov_assignee: null, ov_status: null, ov_progress: null, manual: 0 },
      ],
      prdReviews: [
        { requirement_id: 1, e1_state: '通过', e1_by: '张三', e1_at: '2026-03-03 00:00:00', e1_note: '背景清楚', e2_state: '通过', e2_by: '张三', e2_at: '2026-03-03 00:00:00', e2_note: null, e3_state: '待办', e3_by: null, e3_at: null, e3_note: null, created_at: null, submitted_by: '李四' },
      ],
      designSignoffs: [
        { id: 1, requirement_id: 1, role: 'UI', state: '通过', by: '李四', opinion: null, at: '2026-03-04 00:00:00' },
        { id: 2, requirement_id: 1, role: '线条负责人', state: '通过', by: '张三', opinion: null, at: '2026-03-04 00:00:00' },
        { id: 3, requirement_id: 1, role: '产品负责人', state: '未审', by: null, opinion: null, at: null },
        { id: 4, requirement_id: 1, role: '饶总', state: '通过', by: '代饶总 by 张三', opinion: '同意', at: '2026-03-05 00:00:00' },
      ],
      changeLog: [{ id: 1, entity_type: 'requirement', entity_id: '1', field: 'priority', old_value: 'P1', new_value: 'P0', edited_by: '张三', edited_at: '2026-03-04 00:00:00' }],
      autoReviews: [
        { id: 1, requirement_id: 1, round: 1, issue_count: 5, blocking_count: 2, issues: '[{"level":"blocking","text":"缺少异常流程"}]', reviewed_by: '李四', reviewed_at: '2026-03-03 00:00:00' },
        { id: 2, requirement_id: 1, round: 2, issue_count: 1, blocking_count: 0, issues: '[]', reviewed_by: '李四', reviewed_at: '2026-03-04 00:00:00' },
      ],
      counts: { groups: 2, tasks: 3, taskTargets: 3, pushLogs: 7, settings: 4, reviewObjections: 0, prdUrls: 1 },
    },
    prd: {
      domains: [
        { name: '会员与支付', type: '产品域', group: '增长组', status: 'active', display_order: 1 },
        { name: '跨盘迁移', type: '产品域', group: '基础组', status: 'active', display_order: 2 },
      ],
      users: [{ id: 'pu1', email: 'zhangsan@example.com', name: '张三' }],
      pages: [],
      pageVersions: [],
      attachments: [],
      comments: [],
      counts: { pages: 0, pageVersions: 0, attachments: 0, comments: 0 },
    },
  };
}

/** 带人员问题的旧数据（全部为虚构姓名）：一个字段写了多人、头衔与昵称写法、两字短名、邮箱前缀、代签写法、工具账号。 */
export function messyLegacyData(): LegacyData {
  const data = makeLegacyData();
  data.plane.users.push({ id: 'u4', email: 'zhouxiaoyu@example.com', name: '周小雨', nickname: null, role: 'member', created_at: '2026-03-01 00:00:00' });
  data.plane.requirements[0]!.requester = '客户甲、客户乙';
  data.plane.requirements.push(
    planeReq({ id: 'X004', title: '头衔写法', requester: '产品经理-李四(小李)', owner: '张三', created_at: '2026-03-04T08:00:00Z' }),
    planeReq({ id: 'X005', title: '昵称写法', requester: '小李', owner: '张三', created_at: '2026-03-05T08:00:00Z' }),
    planeReq({ id: 'X006', title: '只有头衔写法', requester: '运营-孙八', owner: '张三', created_at: '2026-03-06T08:00:00Z' }),
  );
  data.plane.requirementDevelopers.push({ id: 'd3', requirement_id: 'X002', platform: null, developer: '王五、赵六', created_at: null });
  data.plane.subtasks.push({ id: 's2', requirement_id: 'X001', title: '短名写法', status: 'todo', assignee: '小雨', created_at: '2026-03-04T00:00:00Z', updated_at: null });
  data.push.ganttTasks.push({ ...data.push.ganttTasks[0]!, id: 3, title: '多人任务', assignee: '', ov_assignee: '王五、赵六 钱七' });
  data.push.designSignoffs[2] = { ...data.push.designSignoffs[2]!, state: '通过', by: '张三、李四', at: '2026-03-04 00:00:00' };
  data.push.changeLog.push(
    { id: 2, entity_type: 'requirement', entity_id: '1', field: 'status', old_value: '评审中', new_value: '已通过', edited_by: '代饶总 by 张三', edited_at: '2026-03-05 00:00:00' },
    { id: 3, entity_type: 'requirement', entity_id: '1', field: 'prd_url', old_value: null, new_value: 'https://example.com/prd', edited_by: 'data-sync', edited_at: '2026-03-05 00:00:00' },
    { id: 4, entity_type: 'requirement', entity_id: '1', field: 'priority', old_value: 'P0', new_value: 'P1', edited_by: 'lisi', edited_at: '2026-03-06 00:00:00' },
  );
  data.push.autoReviews[0]!.reviewed_by = 'model-v4-flash';
  return data;
}

/** 模拟用户审阅后的对照表：会签角色"饶总"指向王老板，业务域"会员"并入"会员与支付"。 */
export function reviewedMapping(data: LegacyData = makeLegacyData()): Mapping {
  const m = suggestMapping(data, null);
  const boss = m.people.people.find((p) => p.displayName === '王老板')!;
  m.people.signoffRoles['饶总'] = boss.key;
  m.people.people = m.people.people.filter((p) => p.displayName !== '饶总');
  m.domains.nodes = [
    { name: '会员与支付', description: '产品域 · 增长组', aliases: ['会员与支付', '会员'] },
    { name: '跨盘迁移', description: '产品域 · 基础组', aliases: ['跨盘迁移'] },
  ];
  return m;
}

export const LEGACY_FILE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png';
export const INLINE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 两份 prd 页面（全部为虚构内容）：一份已上线、挂在 X001 上，正文引用旧附件并内嵌一张图片；一份开发中。另有已删除页面的计数。 */
export function withPrdPages(data: LegacyData = makeLegacyData()): LegacyData {
  data.prd.users.push({ id: 'pu2', email: 'lisi@example.com', name: '李四' });
  const title = '[会员] 批量下载 - 2026-03-01';
  data.prd.pages = [
    {
      id: 'pg1', title, markdown: `## 背景\n\n![](/api/files/${LEGACY_FILE})\n\n![](data:image/png;base64,${INLINE_PNG})\n\n当前正文`, version: 3, status: 'launched',
      owner_user_id: 'pu2', created_by: 'pu1', updated_by: 'pu1', created_at: '2026-03-01T00:00:00.000Z', updated_at: '2026-03-05T00:00:00.000Z', linked_requirement_id: 'X001',
    },
    {
      id: 'pg2', title: '草稿页', markdown: '## 背景\n\n草稿', version: 1, status: 'in_dev', owner_user_id: null, created_by: 'pu2', updated_by: 'pu2',
      created_at: '2026-03-02T00:00:00.000Z', updated_at: '2026-03-02T00:00:00.000Z', linked_requirement_id: null,
    },
  ];
  data.prd.pageVersions = [
    { page_id: 'pg1', version: 1, title, markdown: '## 背景\n\n第一版', diff_summary: null, author_id: 'pu1', created_at: '2026-03-01T00:00:00.000Z' },
    { page_id: 'pg1', version: 3, title, markdown: `## 背景\n\n![](data:image/png;base64,${INLINE_PNG})\n\n第三版`, diff_summary: '补图', author_id: 'pu2', created_at: '2026-03-03T00:00:00.000Z' },
    { page_id: 'pg2', version: 1, title: '草稿页', markdown: '## 背景\n\n草稿', diff_summary: null, author_id: 'pu2', created_at: '2026-03-02T00:00:00.000Z' },
  ];
  data.prd.attachments = [
    { id: 'att1', page_id: 'pg1', uploader_id: 'pu1', storage_key: LEGACY_FILE, filename: '截图.png', mime: 'image/png', size_bytes: 1234, width: null, height: null, created_at: '2026-03-01T00:00:00.000Z' },
  ];
  data.prd.comments = [
    { id: 'c1', page_id: 'pg1', parent_comment_id: null, body_markdown: '这里要确认', resolved_at: null, resolved_by: null, author_id: 'pu2', created_at: '2026-03-02T00:00:00.000Z' },
    { id: 'c2', page_id: 'pg1', parent_comment_id: 'c1', body_markdown: '已确认', resolved_at: '2026-03-03T00:00:00.000Z', resolved_by: 'pu1', author_id: 'pu1', created_at: '2026-03-03T00:00:00.000Z' },
  ];
  data.prd.counts = { pages: 3, pageVersions: 4, attachments: 2, comments: 3 };
  return data;
}
