import { decryptConfig } from '@flower/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildImportPlan } from '../src/plan';
import { digestCrons, planeDigestTimes } from '../src/plan-notify';
import type { ImportOptions } from '../src/plan-types';
import { renderReport } from '../src/report';
import { makeLegacyData, reviewedMapping, withPushConfig } from './fixtures';

const KEY = 'migrate-test-secret-migrate-test-secret-01';
const OPTS: ImportOptions = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null, secretKey: KEY };
const SECRETS = ['group-0003', 'group-0004', 'plane-req-01', 'plane-daily-1', 'demo-smtp-pass'];

describe('推送配置迁移', () => {
  const plan = buildImportPlan(withPushConfig(), reviewedMapping(), OPTS);
  const { notificationChannels: channels, notificationSchedules: schedules, notificationDeliveries: deliveries } = plan.rows;

  it('通道：push 群与 123plane 地址、SMTP，全部停用，配置加密，只留脱敏提示', () => {
    expect(channels.map((c) => [c.name, c.kind, c.groupLabel, c.enabled])).toEqual([
      ['产品群', 'wecom_robot', '产品群', false],
      ['研发群', 'wecom_robot', '研发群', false],
      ['123plane 需求通知', 'wecom_robot', '123plane', false],
      ['123plane 日报', 'wecom_robot', '123plane', false],
      ['123plane 邮件', 'email', '123plane', false],
    ]);
    expect(channels.every((c) => c.config.startsWith('v1:') && c.rateLimitPerMin === (c.kind === 'email' ? 60 : 20))).toBe(true);
    expect(decryptConfig(channels[0]!.config, KEY)).toEqual({ url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=group-0003' });
    expect(channels[0]!.configHint).toBe('…/send?key=****0003');
    expect(decryptConfig(channels[4]!.config, KEY)).toEqual({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'robot@example.com',
      pass: 'demo-smtp-pass',
      from: 'robot@example.com',
      to: ['pm@example.com', 'dev@example.com'],
    });
  });

  it('定时推送：push 计划按来源映射、保留启用与执行记录、不排期；123plane 空摘要时间表为停用的摘要推送', () => {
    expect(schedules.map((s) => [s.name, s.source, s.cron, s.enabled, s.channelIds!.length, s.nextRunAt])).toEqual([
      ['晚间日报', 'overview_card', '0 19 * * 1-5', true, 2, null],
      ['早间日报', 'overview_card', '0 10 * * 1-5', false, 0, null],
      ['每日新需求', 'new_requirements', '30 9 * * *', true, 1, null],
      ['123plane 变更摘要', 'digest', '0 18 * * *', false, 1, null],
    ]);
    expect(schedules[0]!.lastSuccessAt).toEqual(new Date('2026-09-28T11:00:01.000Z'));
    expect(schedules[2]!.sourceConfig).toEqual({ emptyBehavior: 'skip', onlineSourceKeys: ['online_issue'] });
    expect(schedules[3]!.channelIds).toEqual([channels[2]!.id]);
    expect(schedules.every((s) => s.productId === plan.rows.products[0]!.id)).toBe(true);
    expect(plan.report.notifications.skipped).toEqual(
      expect.arrayContaining([
        { what: 'push 推送计划「外部数据」', reason: '不支持的内容来源或触发方式（http / cron）' },
        { what: 'push 推送日志 1 条', reason: '对应的推送计划或群没有迁移' },
      ]),
    );
  });

  it('发送记录：push 日志为已发送的迁移记录，原文存为 legacy', () => {
    expect(deliveries.map((d) => [d.legacyKey, d.status, d.kind, d.attempts])).toEqual([
      ['push_logs:300', 'sent', 'schedule', 1],
      ['push_logs:301', 'sent', 'schedule', 1],
    ]);
    expect(deliveries[0]).toMatchObject({ payload: { type: 'legacy', content: expect.stringContaining('示例日报') }, sentAt: new Date('2026-09-28T11:00:01Z'), createdAt: new Date('2026-09-28T11:00:01Z') });
    expect(plan.report.notifications.deliveries).toBe(2);
  });

  it('同样输入得到同样的 id；报告有「推送」一节，不含网址密钥与密码；不再把推送列为延后迁移', () => {
    const again = buildImportPlan(withPushConfig(), reviewedMapping(), OPTS);
    expect(again.rows.notificationChannels.map((c) => c.id)).toEqual(channels.map((c) => c.id));
    expect(again.rows.notificationSchedules.map((s) => s.id)).toEqual(schedules.map((s) => s.id));
    const md = renderReport(plan.report);
    expect(md).toContain('## 推送（迁移来的通道一律停用）');
    expect(md).toContain('| push | 产品群 | wecom_robot | 否 |');
    for (const s of SECRETS) {
      expect(md).not.toContain(s);
      expect(JSON.stringify(plan.report)).not.toContain(s);
    }
    expect(plan.report.deferred.map((d) => d.what)).not.toEqual(expect.arrayContaining(['push 推送群']));
  });

  it('缺少 FLOWER_SECRET_KEY 时报问题、拒绝写入；没有推送配置时不需要密钥', () => {
    expect(buildImportPlan(withPushConfig(), reviewedMapping(), { ...OPTS, secretKey: undefined }).report.problems).toContain('缺少 FLOWER_SECRET_KEY，无法加密推送通道配置');
    expect(buildImportPlan(makeLegacyData(), reviewedMapping(), { ...OPTS, secretKey: undefined }).report.problems).toEqual([]);
  });

  it('123plane 摘要时间表：没有保存用默认时间；空数组停用；同一分钟合成一条 cron', () => {
    expect(planeDigestTimes(undefined)).toEqual(['09:00', '12:00', '18:00']);
    expect(planeDigestTimes('[]')).toEqual([]);
    expect(planeDigestTimes('不是 JSON')).toEqual(['09:00', '12:00', '18:00']);
    expect(digestCrons(['09:00', '12:00', '18:00'])).toEqual(['0 9,12,18 * * *']);
    expect(digestCrons(['09:00', '12:30'])).toEqual(['0 9 * * *', '30 12 * * *']);
  });
});

describe('推送配置迁移：内网或本机地址', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('地址指向内网或本机的通道不导入、不中断，指向它的推送对象、日志与摘要一并跳过；原因里没有地址', () => {
    vi.stubEnv('FLOWER_NOTIFY_ALLOW_PRIVATE', '');
    const data = withPushConfig();
    data.push.groups[0]!.webhook_url = 'http://10.1.2.3/cgi-bin/webhook/send?key=intranet-0003';
    data.plane.notifySettings.wecom_requirement_webhook_url = 'http://localhost:8080/hook?key=local-req-01';
    data.plane.notifySettings.smtp_host = '192.168.10.20';
    const plan = buildImportPlan(data, reviewedMapping(), OPTS);
    expect(plan.report.problems).toEqual([]);
    expect(plan.rows.notificationChannels.map((c) => c.name)).toEqual(['研发群', '123plane 日报']);
    const evening = plan.rows.notificationSchedules.find((s) => s.name === '晚间日报')!;
    expect(evening.channelIds).toEqual([plan.rows.notificationChannels[0]!.id]);
    expect(plan.rows.notificationSchedules.map((s) => s.name)).not.toContain('123plane 变更摘要');
    expect(plan.rows.notificationDeliveries.map((d) => d.legacyKey)).toEqual(['push_logs:301']);
    expect(plan.report.notifications.skipped).toEqual(
      expect.arrayContaining([
        { what: 'push 通道「产品群」', reason: '地址指向内网或本机，未导入' },
        { what: '123plane 通道「123plane 需求通知」', reason: '地址指向内网或本机，未导入' },
        { what: '123plane 通道「123plane 邮件」', reason: '地址指向内网或本机，未导入' },
        { what: '123plane 变更摘要时间表', reason: '需求通知通道没有导入，无法确定发到哪里' },
        { what: 'push 推送日志 2 条', reason: '对应的推送计划或群没有迁移' },
      ]),
    );
    const json = JSON.stringify(plan.report) + renderReport(plan.report);
    for (const s of ['intranet-0003', '10.1.2.3', 'local-req-01', 'localhost', '192.168.10.20', 'demo-smtp-pass']) expect(json).not.toContain(s);
  });
});
