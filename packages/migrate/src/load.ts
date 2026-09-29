import { DatabaseSync } from 'node:sqlite';
import postgres from 'postgres';
import type { PlaneData, PrdData, PushData } from './legacy-types';

const all = <T>(db: DatabaseSync, sql: string): T[] => db.prepare(sql).all() as T[];
const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

function open(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/** 只读取迁移需要的列；users.password、avatar_url 和 settings 表（含 SMTP 密码等）一律不读。 */
export function loadPlane(path: string): PlaneData {
  const db = open(path);
  try {
    return {
      users: all(db, 'select id, email, name, nickname, role, created_at from users order by id'),
      requirements: all(
        db,
        `select id, title, description, status, phase, priority, business_domain, platform, requester, owner, version_id, source,
          estimated_effort, prd_link, notes, created_at, updated_at, prd_status, feasibility_status, iteration_status,
          acceptance_status, iteration_id from requirements order by created_at, id`,
      ),
      iterations: all(
        db,
        'select id, status, pre_launch_date, kickoff_date, dev_start, dev_end, interim_release_date, release_date, notes, created_at from iterations order by id',
      ),
      versions: all(db, 'select id, platform, status, planned_release_date, released_at, description, release_content, created_at from versions order by id'),
      requirementVersions: all(db, 'select requirement_id, platform, version_id from requirement_versions order by requirement_id, version_id'),
      requirementDevelopers: all(db, 'select id, requirement_id, platform, developer, created_at from requirement_developers order by id'),
      subtasks: all(db, 'select id, requirement_id, title, status, assignee, created_at, updated_at from subtasks order by id'),
      comments: all(db, 'select id, requirement_id, user_email, user_name, content, created_at from comments order by created_at, id'),
      commentReads: all(db, 'select user_email, requirement_id, last_read_at from comment_reads order by user_email, requirement_id'),
      activityLog: all(db, 'select id, requirement_id, user_email, action, old_value, new_value, details, created_at from activity_log order by created_at, id'),
      blockers: all(db, 'select id, requirement_id, description, status, created_at, created_by, resolved_at, resolved_by from blockers order by id'),
      requirementUpdates: all(db, 'select id, requirement_id, content, created_by, created_at from requirement_updates order by created_at, id'),
      iterationLogs: all(db, 'select id, iteration_id, type, content, requirement_id, created_by, created_at from iteration_logs order by created_at, id'),
      counts: {
        briefs: count(db, 'select count(*) as n from requirement_briefs'),
        settings: count(db, 'select count(*) as n from settings'),
        notificationQueue: count(db, 'select count(*) as n from notification_queue'),
        syncInbox: count(db, 'select count(*) as n from sync_inbox'),
        syncOutbox: count(db, 'select count(*) as n from sync_outbox'),
        rolePermissions: count(db, 'select count(*) as n from role_permissions'),
        userPermissionOverrides: count(db, 'select count(*) as n from user_permission_overrides'),
        prdLinks: count(db, "select count(*) as n from requirements where coalesce(prd_link, '') <> ''"),
      },
    };
  } finally {
    db.close();
  }
}

export function loadPush(path: string): PushData {
  const db = open(path);
  try {
    return {
      requirements: all(
        db,
        `select id, title, alias, requester, owner, line, priority, platforms, developers, brief, status, source, version_id, created_at,
          last_edited_by, last_edited_at, plane_id, merged_into from requirements order by created_at, id`,
      ),
      versions: all(db, 'select id, name, start_date, release_date, status, created_at from versions order by release_date, id'),
      ganttTasks: all(
        db,
        `select id, requirement_id, version_id, title, assignee, phase, plan_start, plan_days, delay_days, actual_status, note, flag, created_at,
          alias, starred, ov_assignee, ov_status, ov_progress, manual from gantt_tasks order by id`,
      ),
      prdReviews: all(db, 'select * from prd_reviews order by requirement_id'),
      designSignoffs: all(db, 'select id, requirement_id, role, state, by, opinion, at from design_signoffs order by id'),
      changeLog: all(db, 'select id, entity_type, entity_id, field, old_value, new_value, edited_by, edited_at from change_log order by id'),
      autoReviews: all(db, 'select id, requirement_id, round, issue_count, blocking_count, issues, reviewed_by, reviewed_at from prd_auto_reviews order by requirement_id, round, id'),
      counts: {
        groups: count(db, 'select count(*) as n from groups'),
        tasks: count(db, 'select count(*) as n from tasks'),
        taskTargets: count(db, 'select count(*) as n from task_targets'),
        pushLogs: count(db, 'select count(*) as n from push_logs'),
        settings: count(db, 'select count(*) as n from settings'),
        reviewObjections: count(db, 'select count(*) as n from review_objections'),
        prdUrls: count(db, "select count(*) as n from requirements where coalesce(prd_url, '') <> ''"),
      },
    };
  } finally {
    db.close();
  }
}

export async function loadPrd(url: string): Promise<PrdData> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const domains = await sql<PrdData['domains']>`select name, type, "group", status, display_order from prd_domains order by display_order, name`;
    const users = await sql<PrdData['users']>`select email, name from users order by email`;
    const [c] = await sql<Array<PrdData['counts']>>`
      select (select count(*)::int from pages where deleted_at is null) as pages,
             (select count(*)::int from page_versions) as "pageVersions",
             (select count(*)::int from attachments) as attachments,
             (select count(*)::int from comments) as comments`;
    return { domains: [...domains], users: [...users], counts: c! };
  } finally {
    await sql.end();
  }
}
