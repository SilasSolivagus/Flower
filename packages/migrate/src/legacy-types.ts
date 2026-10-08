export type S = string | null;

export type PlaneRequirement = {
  id: string; title: string; description: S; status: S; phase: S; priority: S; business_domain: S; platform: S;
  requester: S; owner: S; version_id: S; source: S; estimated_effort: S; prd_link: S; notes: S; created_at: S; updated_at: S;
  prd_status: S; feasibility_status: S; iteration_status: S; acceptance_status: S; iteration_id: S;
};
export type PlaneIteration = {
  id: string; status: S; pre_launch_date: S; kickoff_date: S; dev_start: S; dev_end: S; interim_release_date: S; release_date: S; notes: S; created_at: S;
};
export type PlaneData = {
  users: Array<{ id: string; email: string; name: string; nickname: S; role: string; created_at: S }>;
  requirements: PlaneRequirement[];
  iterations: PlaneIteration[];
  versions: Array<{ id: string; platform: S; status: S; planned_release_date: S; released_at: S; description: S; release_content: S; created_at: S }>;
  requirementVersions: Array<{ requirement_id: string; platform: S; version_id: string }>;
  requirementDevelopers: Array<{ id: string; requirement_id: string; platform: S; developer: string; created_at: S }>;
  subtasks: Array<{ id: string; requirement_id: string; title: string; status: S; assignee: S; created_at: S; updated_at: S }>;
  comments: Array<{ id: string; requirement_id: string; user_email: S; user_name: S; content: string; created_at: S }>;
  commentReads: Array<{ user_email: string; requirement_id: string; last_read_at: S }>;
  activityLog: Array<{ id: string; requirement_id: S; user_email: S; action: string; old_value: S; new_value: S; details: S; created_at: S }>;
  blockers: Array<{ id: string; requirement_id: string; description: string; status: S; created_at: S; created_by: S; resolved_at: S; resolved_by: S }>;
  requirementUpdates: Array<{ id: string; requirement_id: string; content: string; created_by: S; created_at: S }>;
  iterationLogs: Array<{ id: string; iteration_id: S; type: S; content: string; requirement_id: S; created_by: S; created_at: S }>;
  counts: { briefs: number; settings: number; notificationQueue: number; syncInbox: number; syncOutbox: number; rolePermissions: number; userPermissionOverrides: number; prdLinks: number };
};
export type PushRequirement = {
  id: number; title: string; alias: S; requester: S; owner: S; line: S; priority: S; platforms: S; developers: S; brief: S;
  status: S; source: S; version_id: S; created_at: S; last_edited_by: S; last_edited_at: S; plane_id: S; prd_url: S; merged_into: number | null;
};
export type PushData = {
  requirements: PushRequirement[];
  versions: Array<{ id: string; name: S; start_date: S; release_date: S; status: S; created_at: S }>;
  ganttTasks: Array<{
    id: number; requirement_id: number | null; version_id: S; title: string; assignee: S; phase: S; plan_start: S; plan_days: number | null;
    delay_days: number | null; actual_status: S; note: S; flag: S; created_at: S; alias: S; starred: number | null; ov_assignee: S;
    ov_status: S; ov_progress: number | null; manual: number | null;
  }>;
  prdReviews: Array<{
    requirement_id: number; e1_state: S; e1_by: S; e1_at: S; e1_note: S; e2_state: S; e2_by: S; e2_at: S; e2_note: S;
    e3_state: S; e3_by: S; e3_at: S; e3_note: S; created_at: S; submitted_by: S;
  }>;
  designSignoffs: Array<{ id: number; requirement_id: number; role: string; state: S; by: S; opinion: S; at: S }>;
  changeLog: Array<{ id: number; entity_type: S; entity_id: S; field: S; old_value: S; new_value: S; edited_by: S; edited_at: S }>;
  autoReviews: Array<{ id: number; requirement_id: number; round: number; issue_count: number; blocking_count: number; issues: S; reviewed_by: S; reviewed_at: S }>;
  counts: { groups: number; tasks: number; taskTargets: number; pushLogs: number; settings: number; reviewObjections: number; prdUrls: number };
};
export type PrdUser = { id: string; email: string; name: S };
export type PrdPage = {
  id: string; title: string; markdown: string; version: number; status: S; owner_user_id: S; created_by: string; updated_by: string;
  created_at: string; updated_at: string; linked_requirement_id: S;
};
export type PrdPageVersion = { page_id: string; version: number; title: string; markdown: string; diff_summary: S; author_id: string; created_at: string };
export type PrdAttachment = {
  id: string; page_id: string; uploader_id: string; storage_key: string; filename: string; mime: string; size_bytes: number;
  width: number | null; height: number | null; created_at: string;
};
export type PrdComment = {
  id: string; page_id: string; parent_comment_id: S; body_markdown: string; resolved_at: S; resolved_by: S; author_id: string; created_at: string;
};
export type PrdData = {
  domains: Array<{ name: string; type: S; group: S; status: string; display_order: number }>;
  users: PrdUser[];
  /** 未删除的页面及其下的修订、附件、评论。 */
  pages: PrdPage[];
  pageVersions: PrdPageVersion[];
  attachments: PrdAttachment[];
  comments: PrdComment[];
  /** 含已删除页面在内的总数，用于对账报告的「跳过」。 */
  counts: { pages: number; pageVersions: number; attachments: number; comments: number };
};
export type LegacyData = { plane: PlaneData; push: PushData; prd: PrdData };
