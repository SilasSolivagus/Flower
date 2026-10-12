import { describe, expect, it } from 'vitest';
import { loadPlane, loadPush } from '../src/load';
import { makeSqliteFixtures } from './sqlite-fixture';

describe('读取 SQLite 副本', () => {
  it('读取 123plane 的业务表；settings 只读推送需要的键', () => {
    const { planePath } = makeSqliteFixtures();
    const plane = loadPlane(planePath);
    expect(plane.users).toEqual([{ id: 'u1', email: 'zhangsan@example.com', name: '张三', nickname: '三哥', role: 'admin', created_at: '2026-03-01 00:00:00' }]);
    expect(plane.requirements[0]).toMatchObject({ id: 'X001', title: '批量下载', platform: 'PC客户端,Web端' });
    expect(plane.iterations[0]).toMatchObject({ id: 'V1', release_date: '2026-03-16' });
    expect(plane.comments).toHaveLength(1);
    expect(plane.counts).toMatchObject({ settings: 3, briefs: 0, notificationQueue: 0 });
    expect(plane.notifySettings).toEqual({ wecom_digest_schedule: '[]', smtp_pass: 'fixture-pass' });
    expect(JSON.stringify(plane)).not.toContain('must-not-be-read');
    expect(JSON.stringify(plane)).not.toContain('secret-hash');
  });

  it('读取 push 的业务表并统计不迁移的表', () => {
    const { pushPath } = makeSqliteFixtures();
    const push = loadPush(pushPath);
    expect(push.requirements[0]).toMatchObject({ id: 1, plane_id: 'X001', merged_into: null });
    expect(push.versions[0]).toMatchObject({ id: 'it0316', release_date: '2026-03-16' });
    expect(push.counts).toMatchObject({ pushLogs: 2, groups: 1 });
    expect(push.groups).toEqual([{ id: 3, name: '示例群', webhook_url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=fixture-0003', enabled: 1, created_at: '2026-08-01 00:00:00' }]);
    expect(push.tasks[0]).toMatchObject({ id: 4, cron_expr: '0 19 * * 1-5', source_type: 'overview', fail_threshold: 1 });
    expect(push.taskTargets).toEqual([{ task_id: 4, group_id: 3 }]);
    expect(push.pushLogs.map((l) => [l.id, l.task_id, l.group_id, l.status, l.sent_at])).toEqual([
      [1, 4, 3, 'ok', '2026-09-28 11:00:01'],
      [2, 4, 3, 'ok', '2026-09-28 11:00:02'],
    ]);
  });
});
