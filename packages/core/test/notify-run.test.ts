import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, notificationDeliveries, notificationDigestItems, notificationSchedules } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addFieldOption, listFields } from '../src/definitions/fields';
import { createDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { createChannel } from '../src/notifications/channels';
import { createRule } from '../src/notifications/rules';
import { generateScheduleRunTx, runScheduleNow } from '../src/notifications/run';
import { createSchedule, updateSchedule } from '../src/notifications/schedules';
import { CARD_LIMITS, clip, eventMessageDataTx, eventTone, orgContextTx, releaseText } from '../src/notifications/sources';
import { createRequirement, setRequirementField } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createTask } from '../src/tasks/tasks';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let wecomId: string;
let emailId: string;
const NOW = new Date('2026-10-10T03:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  wecomId = (await wecomChannel(t.db, owner, '研发群')).id;
  emailId = (
    await createChannel(
      t.db,
      owner,
      { kind: 'email', name: '邮件', config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
      TEST_DEPS,
    )
  ).id;
});
afterAll(() => t.cleanup());

const scheduleRow = async (id: string) => (await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)))[0]!;
const generate = (id: string, now: Date) => withOrg(t.db, owner.orgId, async (tx) => generateScheduleRunTx(tx, (await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)))[0]!, TEST_DEPS, now));
const deliveriesOf = (scheduleId: string) => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.scheduleId, scheduleId));

describe('事件消息的数据', () => {
  it('状态换成中文名称；主体带编号、标题与链接；操作人与时间', async () => {
    const productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
    const req = await createRequirement(t.db, owner, productId, { title: '批量下载' });
    await transitionRequirement(t.db, owner, req.id, { to: 'doing' });
    const [ev] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, req.id), eq(domainEvents.type, 'requirement.state_changed')));
    const data = await withOrg(t.db, owner.orgId, async (tx) => eventMessageDataTx(tx, ev!.id, await orgContextTx(tx, owner.orgId, TEST_DEPS.publicUrl)));
    expect(data).toMatchObject({
      product: { key: 'PAN', name: '网盘' },
      event: { type: 'requirement.state_changed', label: '需求状态变化', actor: 'Owner' },
      subject: { key: 'PAN-1', title: '批量下载', url: 'http://flower.example.com/acme/requirements/PAN-1' },
      changes: [{ label: '状态', old: '待处理', new: '进行中' }],
      summary: '状态 待处理 → 进行中',
    });
    expect(data.event.time).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(data.event.tone).toBe('info');
    expect(data.changes[0]!.tone).toBe('info');
  });

  it('着色：新建与推进为 info；退回、移出迭代（延期）、优先级升到 P0/P1 为 warning；加入迭代、取消、其余字段为 comment', async () => {
    const productId = (await createProduct(t.db, owner, { name: '着色', key: 'TON' })).id;
    const priority = (await listFields(t.db, owner, { productId })).find((f) => f.key === 'priority')!;
    const opt = (k: string) => priority.options.find((o) => o.key === k)!.id;
    const req = await createRequirement(t.db, owner, productId, { title: '着色需求', fields: { priority: [opt('p2')] } });
    await transitionRequirement(t.db, owner, req.id, { to: 'doing' });
    await transitionRequirement(t.db, owner, req.id, { to: 'todo' });
    await transitionRequirement(t.db, owner, req.id, { to: 'canceled' });
    await setRequirementField(t.db, owner, req.id, 'priority', [opt('p1')]);
    await setRequirementField(t.db, owner, req.id, 'priority', [opt('p0')]);
    await setRequirementField(t.db, owner, req.id, 'priority', [opt('p2')]);
    const i1 = await createIteration(t.db, owner, { type: 'regular', productId, name: '迭代A', startDate: '2026-10-01', endDate: '2026-10-16' });
    const i2 = await createIteration(t.db, owner, { type: 'regular', productId, name: '迭代B', startDate: '2026-10-19', endDate: '2026-10-30' });
    await setRequirementIteration(t.db, owner, req.id, { iterationId: i1.id });
    await setRequirementIteration(t.db, owner, req.id, { iterationId: i2.id });
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, req.id)).orderBy(domainEvents.occurredAt);
    const tones: string[] = [];
    for (const ev of events.filter((e) => e.type !== 'requirement.field_changed' || (e.payload.changes as Array<{ field: string }>)[0]?.field === 'priority')) {
      const d = await withOrg(t.db, owner.orgId, async (tx) => eventMessageDataTx(tx, ev.id, await orgContextTx(tx, owner.orgId, TEST_DEPS.publicUrl)));
      tones.push(`${d.event.label}${d.changes.map((c) => ` ${c.old}→${c.new}`).join('')}:${d.event.tone}`);
    }
    expect(tones).toEqual([
      '新建需求:info',
      '需求状态变化 待处理→进行中:info',
      '需求状态变化 进行中→待开始:warning',
      '需求状态变化 待开始→已取消:comment',
      '需求字段变化 P2→P1:warning',
      '需求字段变化 P1→P0:warning',
      '需求字段变化 P0→P2:comment',
      '需求所属迭代变化 空→迭代A:comment',
      '需求所属迭代变化 迭代A→迭代B:warning',
    ]);
    expect(eventTone('check_item.signed', [])).toBe('info');
    expect(eventTone('requirement.assignment_added', [{ tone: 'comment' }])).toBe('comment');
    expect(eventTone('release.released', [{ tone: 'info' }, { tone: 'warning' }])).toBe('warning');
  });
});

describe('概览卡片', () => {
  it('取进行中的迭代；整体进度同甘特口径；企微为完整的文本通知卡片，邮件列出卡片内容', async () => {
    const productId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
    const it = await createIteration(t.db, owner, { type: 'regular', productId, name: '迭代1016', startDate: '2026-10-01', endDate: '2026-10-16' });
    await setIterationStatus(t.db, owner, it.id, 'active');
    const ops = await createPlaceholderMember(t.db, owner, { displayName: '周岚' });
    await createTask(t.db, owner, { productId, iterationId: it.id, title: '前端开发', status: 'done' });
    await createTask(t.db, owner, { productId, iterationId: it.id, title: '接口联调', progress: 50 });
    await createTask(t.db, owner, { productId, iterationId: it.id, title: '灰度发布', progress: 20, flag: 'attention', note: '等运维排期', assigneeMemberId: ops.id });
    const s = await createSchedule(t.db, owner, { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [wecomId, emailId] }, { now: NOW });
    const result = await generate(s.id, NOW);
    expect(result).toMatchObject({ deliveries: 2, skipped: null });
    const rows = await deliveriesOf(s.id);
    expect(new Set(rows.map((r) => r.runId))).toEqual(new Set([result.runId]));
    // 10-10（周六）：理论进度 6/11 个工作日 = 55%；计入的两行 100% 与 50%，整体 75%，不落后；50% 那行低于理论进度，记为落后 1 项
    const gantt = `http://flower.example.com/acme/iterations/${it.id}?tab=gantt`;
    const card = {
      card_type: 'text_notice',
      source: { desc: 'Flower · 研发日报', desc_color: 3 },
      main_title: { title: '相册 研发日报 · 2026-10-10', desc: '迭代1016 · 10/16 发版 · 还剩 5 个工作日' },
      emphasis_content: { title: '75%', desc: '整体进度（理论 55%）' },
      horizontal_content_list: [
        { keyname: '需求', value: '3 项' },
        { keyname: '落后', value: '1 项' },
        { keyname: '遗留下期', value: '1 项' },
      ],
      quote_area: { type: 0, title: '需要关注', quote_text: '灰度发布 · 周岚 · 等运维排期' },
      jump_list: [
        { type: 1, title: '查看甘特', url: gantt },
        { type: 1, title: '需求列表', url: `http://flower.example.com/acme/requirements?product=PIC&iteration=${it.id}` },
      ],
      card_action: { type: 1, url: gantt },
    };
    expect(rows.find((r) => r.channelId === wecomId)!.payload).toEqual({ type: 'json', body: { msgtype: 'template_card', template_card: card } });
    expect(rows.find((r) => r.channelId === emailId)!.payload).toEqual({
      type: 'email',
      subject: '相册 研发日报 · 2026-10-10',
      text: [
        '迭代1016 · 10/16 发版 · 还剩 5 个工作日',
        '整体进度（理论 55%）：75%',
        '需求：3 项',
        '落后：1 项',
        '遗留下期：1 项',
        '需要关注',
        '灰度发布 · 周岚 · 等运维排期',
        `查看甘特：${gantt}`,
        `需求列表：http://flower.example.com/acme/requirements?product=PIC&iteration=${it.id}`,
      ].join('\n'),
    });
    expect((await scheduleRow(s.id)).lastRunAt!.toISOString()).toBe(NOW.toISOString());

    // 10-15：理论进度 91%，整体落后，来源行为红色；没有需要关注时（去掉关注与说明）不带引用区
    const later = await generate(s.id, new Date('2026-10-15T03:00:00Z'));
    const [laterRow] = (await deliveriesOf(s.id)).filter((r) => r.runId === later.runId && r.channelId === wecomId);
    const laterCard = (laterRow!.payload as unknown as { body: { template_card: Record<string, unknown> } }).body.template_card;
    expect(laterCard).toMatchObject({ source: { desc_color: 2 }, main_title: { desc: '迭代1016 · 10/16 发版 · 还剩 1 个工作日' }, emphasis_content: { title: '75%', desc: '整体进度（理论 91%）' } });
  });

  it('卡片长度：标题、辅助信息按企微建议长度截断；没有需要关注时去掉引用区', async () => {
    const productId = (await createProduct(t.db, owner, { name: '长名产品', key: 'LNG' })).id;
    const it = await createIteration(t.db, owner, { type: 'regular', productId, name: '二零二六年十月第二个双周迭代（会员体系改版）', startDate: '2026-10-01', endDate: '2026-10-16' });
    await setIterationStatus(t.db, owner, it.id, 'active');
    await createTask(t.db, owner, { productId, iterationId: it.id, title: '前端开发', status: 'done' });
    const s = await createSchedule(
      t.db,
      owner,
      { productId, name: '长日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [wecomId], sourceConfig: { titlePrefix: '一个非常非常非常非常长的自定义日报标题前缀' } },
      { now: NOW },
    );
    await generate(s.id, NOW);
    const [row] = await deliveriesOf(s.id);
    const card = (row!.payload as unknown as { body: { template_card: Record<string, Record<string, string>> } }).body.template_card;
    const len = (x: string) => [...x].length;
    expect(card.main_title!.title).toBe('一个非常非常非常非常长的… · 2026-10-10');
    expect(len(card.main_title!.title!)).toBeLessThanOrEqual(CARD_LIMITS.title);
    expect(card.main_title!.desc).toBe('二零二六年十… · 10/16 发版 · 还剩 5 个工作日');
    expect(len(card.main_title!.desc!)).toBe(CARD_LIMITS.desc);
    expect(len(card.emphasis_content!.title!)).toBeLessThanOrEqual(CARD_LIMITS.emphasisTitle);
    expect(len(card.emphasis_content!.desc!)).toBeLessThanOrEqual(CARD_LIMITS.emphasisDesc);
    expect(card).not.toHaveProperty('quote_area');
    for (const kv of card.horizontal_content_list as unknown as Array<{ keyname: string }>) expect(len(kv.keyname)).toBeLessThanOrEqual(5);
  });

  it('发版信息：之后为日期与剩余工作日，当天为「今天发版」，之后为「已过发版日」', () => {
    expect(releaseText('2026-10-16', '2026-10-08')).toBe('10/16 发版 · 还剩 6 个工作日');
    expect(releaseText('2026-10-16', '2026-10-16')).toBe('今天发版');
    expect(releaseText('2026-10-16', '2026-10-19')).toBe('已过发版日');
    expect(clip('一二三四五', 5)).toBe('一二三四五');
    expect(clip('一二三四五六', 5)).toBe('一二三四…');
  });

  it('没有迭代时指向迭代列表；没有可用通道时跳过并记 last_error', async () => {
    const productId = (await createProduct(t.db, owner, { name: '空产品', key: 'EMP' })).id;
    const s = await createSchedule(t.db, owner, { productId, name: '空日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [wecomId], sourceConfig: { titlePrefix: '空日报' } }, { now: NOW });
    await generate(s.id, NOW);
    const [row] = await deliveriesOf(s.id);
    expect(row!.payload).toMatchObject({
      body: {
        template_card: {
          source: { desc: 'Flower · 研发日报', desc_color: 0 },
          main_title: { title: '空日报 · 2026-10-10', desc: '当前没有迭代 · 点开查看迭代列表' },
          jump_list: [{ type: 1, title: '查看迭代列表', url: 'http://flower.example.com/acme/iterations' }],
          card_action: { type: 1, url: 'http://flower.example.com/acme/iterations' },
        },
      },
    });
    expect(Object.keys((row!.payload as unknown as { body: { template_card: object } }).body.template_card).sort()).toEqual(['card_action', 'card_type', 'jump_list', 'main_title', 'source']);
    await t.adminDb.update(notificationSchedules).set({ channelIds: [] }).where(eq(notificationSchedules.id, s.id));
    expect(await generate(s.id, NOW)).toMatchObject({ deliveries: 0, skipped: '没有可用的通道（通道已停用、已删除或不允许本产品使用）' });
    expect((await scheduleRow(s.id)).lastError).toBe('没有可用的通道（通道已停用、已删除或不允许本产品使用）');
  });
});

describe('新需求', () => {
  it('窗口内的需求按 push 版式列出；线上转需求单独分组；PRD 链接；没有新需求时跳过或发提示', async () => {
    const productId = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
    const fields = await listFields(t.db, owner, { productId });
    const priority = fields.find((f) => f.key === 'priority')!;
    const source = fields.find((f) => f.key === 'source')!;
    const online = await addFieldOption(t.db, owner, source.id, { label: '线上问题', key: 'online_issue' });
    const requester = await createPlaceholderMember(t.db, owner, { displayName: '客户甲' });
    const a = await createRequirement(t.db, owner, productId, {
      title: '协同编辑',
      description: '## 背景\n\n多人同时编辑同一文档',
      requesterMemberId: requester.id,
      fields: { priority: [priority.options.find((o) => o.key === 'p0')!.id] },
    });
    await createDocument(t.db, owner, productId, { title: '协同 PRD', externalUrl: 'https://docs.example.com/prd-a', requirementIds: [a.id] });
    const b = await createRequirement(t.db, owner, productId, { title: '导出失败', fields: { priority: [priority.options.find((o) => o.key === 'p2')!.id], source: [online.id] } });
    const s = await createSchedule(
      t.db,
      owner,
      { productId, name: '新需求', cron: '30 9 * * *', source: 'new_requirements', channelIds: [wecomId], sourceConfig: { onlineSourceKeys: ['online_issue'] } },
      { now: NOW },
    );
    const now = new Date(Date.now() + 1000);
    await generate(s.id, now);
    const [row] = await deliveriesOf(s.id);
    const content = (row!.payload as unknown as { body: { markdown: { content: string } } }).body.markdown.content;
    expect(content).toMatch(
      /^# 📋 文档 新增需求 · \d{2}-\d{2} 周[日一二三四五六]\n> 新增 <font color="warning">1<\/font> 条 · 线上转需求 <font color="warning">1<\/font> 条 · P0\/P1 <font color="warning">1<\/font> 条\n\n\*\*🆕 新增需求\*\*\n\n/,
    );
    expect(content).toContain(
      `**1.** [${a.displayKey} 协同编辑](http://flower.example.com/acme/requirements/${a.displayKey}) <font color="warning">P0</font>\n<font color="comment">客户甲 · —</font> · [PRD](https://docs.example.com/prd-a)\n\n`,
    );
    expect(content).toContain(`**🔧 线上转需求**\n\n**2.** [${b.displayKey} 导出失败](http://flower.example.com/acme/requirements/${b.displayKey}) <font color="comment">P2</font>\n<font color="comment">— · —</font>\n\n`);
    expect(content).toContain('> 👉 [到 Flower 认领 / 分配 ↗](http://flower.example.com/acme/requirements?product=DOC)');

    await t.adminDb.update(notificationSchedules).set({ lastSuccessAt: now }).where(eq(notificationSchedules.id, s.id));
    expect(await generate(s.id, new Date(now.getTime() + 1000))).toMatchObject({ deliveries: 0, skipped: '没有新需求' });
    expect((await scheduleRow(s.id)).lastError).toBeNull();
    await updateSchedule(t.db, owner, s.id, { sourceConfig: { emptyBehavior: 'notice', onlineSourceKeys: ['online_issue'] } });
    await generate(s.id, new Date(now.getTime() + 2000));
    const notice = (await deliveriesOf(s.id)).find((r) => (r.payload as unknown as { body: { msgtype: string } }).body.msgtype === 'text');
    expect((notice!.payload as unknown as { body: { text: { content: string } } }).body.text.content).toMatch(/^文档 \d{1,2}\/\d{1,2} 没有新需求$/);
  });
});

describe('变更摘要', () => {
  it('取未消费的条目按对象分组，写上 run_id；再次执行时没有新条目则跳过', async () => {
    const productId = (await createProduct(t.db, owner, { name: '会员', key: 'VIP' })).id;
    const s = await createSchedule(t.db, owner, { productId, name: '变更摘要', cron: '0 18 * * *', source: 'digest', channelIds: [wecomId] }, { now: NOW });
    await createRule(t.db, owner, productId, { name: '状态并入摘要', eventTypes: ['requirement.state_changed'], mode: 'digest', digestScheduleId: s.id });
    const r1 = await createRequirement(t.db, owner, productId, { title: '续费提醒' });
    const r2 = await createRequirement(t.db, owner, productId, { title: '发票' });
    await transitionRequirement(t.db, owner, r1.id, { to: 'todo' });
    await transitionRequirement(t.db, owner, r1.id, { to: 'doing' });
    await transitionRequirement(t.db, owner, r2.id, { to: 'done' });
    const result = await generate(s.id, new Date(Date.now() + 1000));
    expect(result.deliveries).toBe(1);
    const items = await t.adminDb.select().from(notificationDigestItems).where(eq(notificationDigestItems.scheduleId, s.id));
    expect(items.every((i) => i.runId === result.runId && i.consumedAt === null)).toBe(true);
    const [row] = await deliveriesOf(s.id);
    const content = (row!.payload as unknown as { body: { markdown: { content: string } } }).body.markdown.content;
    expect(content).toMatch(/^# 会员 变更摘要 · \d{2}:\d{2}\n> \d{2}-\d{2} \d{2}:\d{2} – \d{2}-\d{2} \d{2}:\d{2} · 3 项变化 · 2 个对象\n\n/);
    expect(content).toContain(`**[${r1.displayKey} 续费提醒](http://flower.example.com/acme/requirements/${r1.displayKey})**`);
    expect(content).toMatch(/> 状态　<font color="comment">待开始<\/font> → <font color="info">进行中<\/font>　<font color="comment">Owner \d{2}-\d{2} \d{2}:\d{2}<\/font>/);
    expect(await generate(s.id, new Date(Date.now() + 2000))).toMatchObject({ deliveries: 0, skipped: '没有待合并的变化' });
  });
});

describe('立即执行', () => {
  it('产品管理员可以；编辑与只读 Token 不能；记事件', async () => {
    const productId = (await createProduct(t.db, owner, { name: '传输', key: 'TRS' })).id;
    const pa = await asMember(t.db, owner, '产品管理员戊');
    await setProductRole(t.db, owner, productId, pa.memberId, 'admin');
    const s = await createSchedule(t.db, pa, { productId, name: '传输日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [wecomId] }, { now: NOW });
    const editor = await asMember(t.db, owner, '编辑戊');
    await expect(runScheduleNow(t.db, editor, s.id, TEST_DEPS)).rejects.toThrow('权限不足');
    await expect(runScheduleNow(t.db, readOnlyToken(owner), s.id, TEST_DEPS)).rejects.toThrow('权限不足');
    expect(await runScheduleNow(t.db, pa, s.id, TEST_DEPS, { now: NOW })).toMatchObject({ deliveries: 1, skipped: null });
    const events = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, s.id), eq(domainEvents.type, 'notification_schedule.run')));
    expect(events[0]!.payload).toMatchObject({ manual: true, deliveries: 1, skipped: null });
    expect((await scheduleRow(s.id)).nextRunAt!.toISOString()).toBe('2026-10-12T11:00:00.000Z');
  });
});
