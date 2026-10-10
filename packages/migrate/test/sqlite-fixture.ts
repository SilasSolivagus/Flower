import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PLANE_DDL = `
create table users (id text, email text, name text, nickname text, role text, avatar_url text, password text, created_at text);
create table requirements (id text, title text, description text, status text, phase text, priority text, business_domain text, platform text, requester text, owner text, version_id text, source text, estimated_effort text, prd_link text, notes text, created_at text, updated_at text, evaluated_at text, designed_at text, developed_at text, tested_at text, launched_at text, prd_status text, feasibility_status text, iteration_status text, acceptance_status text, iteration_id text);
create table iterations (id text, status text, pre_launch_date text, kickoff_date text, dev_start text, dev_end text, interim_release_date text, release_date text, notes text, created_at text, updated_at text);
create table versions (id text, platform text, status text, planned_release_date text, released_at text, description text, release_content text, created_at text, updated_at text);
create table requirement_versions (requirement_id text, platform text, version_id text);
create table requirement_developers (id text, requirement_id text, platform text, developer text, created_at text);
create table subtasks (id text, requirement_id text, title text, status text, assignee text, created_at text, updated_at text);
create table comments (id text, requirement_id text, user_email text, user_name text, content text, created_at text);
create table comment_reads (user_email text, requirement_id text, last_read_at text);
create table activity_log (id text, requirement_id text, user_email text, action text, old_value text, new_value text, details text, created_at text);
create table blockers (id text, requirement_id text, description text, status text, created_at text, created_by text, resolved_at text, resolved_by text);
create table requirement_updates (id text, requirement_id text, content text, created_by text, created_at text);
create table iteration_logs (id text, iteration_id text, type text, content text, requirement_id text, created_by text, created_at text);
create table requirement_briefs (requirement_id text, title text, html text, created_by text, created_at text, updated_at text);
create table settings (key text, value text);
create table notification_queue (id text);
create table sync_inbox (id text);
create table sync_outbox (id text);
create table role_permissions (id text);
create table user_permission_overrides (id text);
`;

const PUSH_DDL = `
create table requirements (id integer, title text, alias text, requester text, owner text, line text, priority text, platforms text, developers text, brief text, prd_url text, priority_set_at text, status text, source text, source_ref integer, version_id text, created_at text, last_edited_by text, last_edited_at text, plane_id text, merged_into integer);
create table versions (id text, name text, start_date text, release_date text, status text, created_at text);
create table gantt_tasks (id integer, requirement_id integer, version_id text, title text, assignee text, phase text, plan_start text, plan_days integer, delay_days integer, actual_status text, note text, flag text, created_at text, alias text, starred integer, ov_assignee text, ov_status text, ov_progress integer, manual integer);
create table prd_reviews (requirement_id integer, e1_state text, e1_by text, e1_at text, e1_note text, e2_state text, e2_by text, e2_at text, e2_note text, e3_state text, e3_by text, e3_at text, e3_note text, created_at text, submitted_by text);
create table design_signoffs (id integer, requirement_id integer, role text, state text, by text, opinion text, at text);
create table change_log (id integer, entity_type text, entity_id text, field text, old_value text, new_value text, edited_by text, edited_at text);
create table prd_auto_reviews (id integer, requirement_id integer, doc_url text, round integer, issue_count integer, blocking_count integer, issues text, reviewed_by text, reviewed_at text);
create table groups (id integer primary key, name text, webhook_url text, enabled integer, created_at text);
create table tasks (id integer primary key, name text, enabled integer, trigger_type text, cron_expr text, timezone text, source_type text, source_config text, format text, priority integer, next_run text, last_run text, last_success text, alert_state text, consecutive_failures integer, fail_threshold integer, cooldown_sec integer, last_alert_at text, created_at text);
create table task_targets (task_id integer, group_id integer);
create table push_logs (id integer primary key, task_id integer, group_id integer, content text, status text, error text, sent_at text);
create table settings (key text, value text);
create table review_objections (id integer);
`;

export function makeSqliteFixtures(): { planePath: string; pushPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'flower-migrate-'));
  const planePath = path.join(dir, 'plane.db');
  const pushPath = path.join(dir, 'push.db');
  const plane = new DatabaseSync(planePath);
  plane.exec(PLANE_DDL);
  plane.exec(`
    insert into users values ('u1','zhangsan@example.com','张三','三哥','admin',null,'secret-hash','2026-03-01 00:00:00');
    insert into requirements (id,title,status,priority,platform,requester,owner,created_at,prd_status,feasibility_status) values ('X001','批量下载','开发中','P1','PC客户端,Web端','客户甲','张三','2026-03-01T08:00:00+00:00','approved','approved');
    insert into iterations (id,status,kickoff_date,release_date) values ('V1','已完成','2026-03-02','2026-03-16');
    insert into comments values ('c1','X001','zhangsan@example.com','张三','请确认范围','2026-03-03T00:00:00Z');
    insert into settings values ('ai_daily_prompt','must-not-be-read'), ('wecom_digest_schedule','[]'), ('smtp_pass','fixture-pass');
  `);
  plane.close();
  const push = new DatabaseSync(pushPath);
  push.exec(PUSH_DDL);
  push.exec(`
    insert into requirements (id,title,status,platforms,plane_id,merged_into,created_at) values (1,'批量下载','已进版本','["pc"]','X001',null,'2026-03-02 00:00:00');
    insert into versions values ('it0316',null,'2026-03-02','2026-03-16','已发版','2026-03-01 00:00:00');
    insert into groups values (3, '示例群', 'https://qyapi.example.com/cgi-bin/webhook/send?key=fixture-0003', 1, '2026-08-01 00:00:00');
    insert into tasks (id, name, enabled, trigger_type, cron_expr, timezone, source_type, source_config, format, consecutive_failures, fail_threshold) values (4, '示例日报', 1, 'cron', '0 19 * * 1-5', 'Asia/Shanghai', 'overview', '{}', 'template_card', 0, 1);
    insert into task_targets values (4, 3);
    insert into push_logs (id, task_id, group_id, content, status, sent_at) values (1, 4, 3, '示例', 'ok', '2026-09-28 11:00:01'), (2, 4, 3, '示例', 'ok', '2026-09-28 11:00:02');
  `);
  push.close();
  return { planePath, pushPath };
}
