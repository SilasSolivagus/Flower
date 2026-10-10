import { DatabaseSync } from 'node:sqlite';
import postgres from 'postgres';
import { type PlaneData, type PlaneNotifyKey, PLANE_NOTIFY_KEYS, type PrdData, type PushData } from './legacy-types';

const all = <T>(db: DatabaseSync, sql: string): T[] => db.prepare(sql).all() as T[];
const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

function open(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/** 只读取迁移需要的列；users.password、avatar_url 不读；settings 表只读推送需要的 8 个键（PLANE_NOTIFY_KEYS，含 SMTP 密码，迁移时加密写入）。 */
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
      notifySettings: Object.fromEntries(
        all<{ key: PlaneNotifyKey; value: string }>(db, `select key, value from settings where key in (${PLANE_NOTIFY_KEYS.map((k) => `'${k}'`).join(', ')})`).map((r) => [r.key, r.value]),
      ),
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
          last_edited_by, last_edited_at, plane_id, prd_url, merged_into from requirements order by created_at, id`,
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
      groups: all(db, 'select id, name, webhook_url, enabled, created_at from groups order by id'),
      tasks: all(
        db,
        `select id, name, enabled, trigger_type, cron_expr, timezone, source_type, source_config, format, next_run, last_run, last_success,
          alert_state, consecutive_failures, fail_threshold from tasks order by id`,
      ),
      taskTargets: all(db, 'select task_id, group_id from task_targets order by task_id, group_id'),
      pushLogs: all(db, 'select id, task_id, group_id, content, status, error, sent_at from push_logs order by id'),
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

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function loadPrd(url: string): Promise<PrdData> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const domains = await sql<PrdData['domains']>`select name, type, "group", status, display_order from prd_domains order by display_order, name`;
    const users = await sql<PrdData['users']>`select id, email, name from users order by email`;
    const pages = await sql<Array<Omit<PrdData['pages'][number], 'created_at' | 'updated_at'> & { created_at: Date; updated_at: Date }>>`
      select id::text, title, markdown, version, prd_meta->>'status' as status, prd_meta->>'ownerUserId' as owner_user_id,
             created_by, updated_by, created_at, updated_at, linked_requirement_id
      from pages where deleted_at is null order by created_at, id`;
    const live = sql`(select id from pages where deleted_at is null)`;
    const versions = await sql<Array<Omit<PrdData['pageVersions'][number], 'created_at'> & { created_at: Date }>>`
      select page_id::text, version, title, markdown, diff_summary, author_id, created_at
      from page_versions where page_id in ${live} order by page_id, version`;
    const attachments = await sql<Array<Omit<PrdData['attachments'][number], 'created_at' | 'size_bytes'> & { created_at: Date; size_bytes: string }>>`
      select id::text, page_id::text, uploader_id, storage_key, filename, mime, size_bytes, width, height, created_at
      from attachments where page_id in ${live} order by created_at, id`;
    const comments = await sql<Array<Omit<PrdData['comments'][number], 'created_at' | 'resolved_at'> & { created_at: Date; resolved_at: Date | null }>>`
      select id::text, page_id::text, parent_comment_id::text, body_markdown, resolved_at, resolved_by, author_id, created_at
      from comments where page_id in ${live} order by created_at, id`;
    const [c] = await sql<Array<PrdData['counts']>>`
      select (select count(*)::int from pages) as pages,
             (select count(*)::int from page_versions) as "pageVersions",
             (select count(*)::int from attachments) as attachments,
             (select count(*)::int from comments) as comments`;
    return {
      domains: [...domains],
      users: [...users],
      pages: pages.map((p) => ({ ...p, created_at: iso(p.created_at)!, updated_at: iso(p.updated_at)! })),
      pageVersions: versions.map((v) => ({ ...v, created_at: iso(v.created_at)! })),
      attachments: attachments.map((a) => ({ ...a, size_bytes: Number(a.size_bytes), created_at: iso(a.created_at)! })),
      comments: comments.map((x) => ({ ...x, resolved_at: iso(x.resolved_at), created_at: iso(x.created_at)! })),
      counts: c!,
    };
  } finally {
    await sql.end();
  }
}
