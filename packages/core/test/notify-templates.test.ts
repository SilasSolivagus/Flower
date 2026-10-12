import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messageTemplates, notificationSchedules } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { BUILTIN_TEMPLATES, currentBuiltinBody, PREVIOUS_BUILTIN_BODIES } from '../src/notifications/builtin';
import { BUILTIN_TEMPLATE_KEYS, type BuiltinTemplateKey } from '../src/notifications/constants';
import { createMessageTemplate, deleteMessageTemplate, listMessageTemplates, resolveTemplateTx, updateMessageTemplate } from '../src/notifications/message-templates';
import { renderMessage, splitMarkdown } from '../src/notifications/template';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

describe('预置模板的渲染结果', () => {
  it('事件推送：首行事件名称按颜色、产品名灰色；对象链接加粗；改动为「字段　旧（灰）→ 新（着色）」；末行操作人与时间', () => {
    const { format, body } = BUILTIN_TEMPLATES.event;
    const msg = renderMessage(format, body, {
      product: { key: 'PAN', name: '网盘' },
      event: { label: '需求状态变化', tone: 'warning', actor: '林澄', time: '10-09 14:20' },
      subject: { key: 'PAN-12', title: '批量下载', url: 'http://flower.example.com/acme/requirements/PAN-12' },
      changes: [
        { label: '状态', old: '测试中', new: '开发中', tone: 'warning' },
        { label: '备注', old: '空', new: '回归失败', tone: 'comment' },
      ],
    });
    expect(msg).toEqual({
      format: 'markdown',
      text: [
        '<font color="warning">需求状态变化</font><font color="comment"> · 网盘</font>',
        '**[PAN-12 批量下载](http://flower.example.com/acme/requirements/PAN-12)**',
        '> 状态　<font color="comment">测试中</font> → <font color="warning">开发中</font>',
        '> 备注　<font color="comment">空</font> → <font color="comment">回归失败</font>',
        '<font color="comment">林澄 · 10-09 14:20</font>',
      ].join('\n'),
    });
  });

  it('新需求：标题带产品与星期；摘要行数字大于 0 时橙红；每条两行（编号、标题链接、优先级；提出人 · 业务线 · 平台 · PRD）；末行认领入口', () => {
    const { format, body } = BUILTIN_TEMPLATES.new_requirements;
    const msg = renderMessage(format, body, {
      product: { key: 'PAN', name: '网盘' },
      dateLabel: '10-09 周五',
      newCount: 1,
      onlineCount: 1,
      urgentCount: 1,
      colors: { newCount: 'warning', onlineCount: 'warning', urgentCount: 'warning' },
      sections: [
        {
          title: '🆕 新增需求',
          items: [{ index: 1, key: 'PAN-1', title: '离线下载', url: 'u1', priority: 'P0', priorityColor: 'warning', meta: '客户甲 · 功能 · PC/Web', brief: '支持离线', prdUrl: 'https://docs.example.com/prd-1' }],
        },
        { title: '🔧 线上转需求', items: [{ index: 2, key: 'PAN-2', title: '上传失败', url: 'u2', priority: 'P2', priorityColor: 'comment', meta: '客户乙 · 功能', brief: '', prdUrl: '' }] },
      ],
      listUrl: 'http://flower.example.com/acme/requirements?product=PAN',
    });
    expect(msg).toEqual({
      format: 'markdown',
      text: [
        '# 📋 网盘 新增需求 · 10-09 周五',
        '> 新增 <font color="warning">1</font> 条 · 线上转需求 <font color="warning">1</font> 条 · P0/P1 <font color="warning">1</font> 条',
        '',
        '**🆕 新增需求**',
        '',
        '**1.** [PAN-1 离线下载](u1) <font color="warning">P0</font>',
        '<font color="comment">客户甲 · 功能 · PC/Web</font> · [PRD](https://docs.example.com/prd-1)',
        '',
        '**🔧 线上转需求**',
        '',
        '**2.** [PAN-2 上传失败](u2) <font color="comment">P2</font>',
        '<font color="comment">客户乙 · 功能</font>',
        '',
        '> 👉 [到 Flower 认领 / 分配 ↗](http://flower.example.com/acme/requirements?product=PAN)',
      ].join('\n'),
    });
  });

  it('新需求条目多时按 4096 字节拆成多条，每条不超过上限，续条带标题，条目不被拆开', () => {
    const { format, body } = BUILTIN_TEMPLATES.new_requirements;
    const items = Array.from({ length: 40 }, (_, i) => ({
      index: i + 1,
      key: `PAN-${i + 1}`,
      title: '支持按文件夹批量下载并保留目录结构',
      url: `http://flower.example.com/acme/requirements/PAN-${i + 1}`,
      priority: 'P2',
      priorityColor: 'comment',
      meta: '客户甲 · 功能 · PC/Web',
      prdUrl: `https://docs.example.com/prd-${i + 1}`,
    }));
    const msg = renderMessage(format, body, { product: { name: '网盘' }, dateLabel: '10-09 周五', colors: {}, sections: [{ title: '🆕 新增需求', items }], listUrl: 'u' });
    const parts = splitMarkdown((msg as { text: string }).text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(4096);
    expect(parts[1]!.startsWith('# 📋 网盘 新增需求 · 10-09 周五（续2）\n\n**')).toBe(true);
    for (const it of items) expect(parts.some((p) => p.includes(`**${it.index}.** [${it.key} `) && p.includes(`[PRD](${it.prdUrl})`))).toBe(true);
  });

  it('变更摘要：标题带时间；引用行为时间段、变化数、对象数；按对象分组，改动着色同事件推送，没有改动的事件列名称', () => {
    const digest = renderMessage(BUILTIN_TEMPLATES.digest.format, BUILTIN_TEMPLATES.digest.body, {
      product: { name: '网盘' },
      time: '18:00',
      period: '10-09 09:00 – 10-09 17:30',
      eventCount: 3,
      subjectCount: 2,
      groups: [
        {
          key: 'PAN-12',
          title: '批量下载',
          url: 'u12',
          lines: [
            { label: '需求状态变化', tone: 'info', actor: '林澄', time: '10-09 10:00', changes: [{ label: '状态', old: '待开始', new: '进行中', tone: 'info' }] },
            { label: '需求字段变化', tone: 'warning', actor: '林澄', time: '10-09 11:00', changes: [{ label: '优先级', old: 'P2', new: 'P0', tone: 'warning' }] },
          ],
        },
        { key: 'PAN-13', title: '回收站', url: 'u13', lines: [{ label: '新建需求', tone: 'info', actor: '周岚', time: '10-09 17:30', changes: [] }] },
      ],
    });
    expect(digest).toEqual({
      format: 'markdown',
      text: [
        '# 网盘 变更摘要 · 18:00',
        '> 10-09 09:00 – 10-09 17:30 · 3 项变化 · 2 个对象',
        '',
        '**[PAN-12 批量下载](u12)**',
        '> 状态　<font color="comment">待开始</font> → <font color="info">进行中</font>　<font color="comment">林澄 10-09 10:00</font>',
        '> 优先级　<font color="comment">P2</font> → <font color="warning">P0</font>　<font color="comment">林澄 10-09 11:00</font>',
        '',
        '**[PAN-13 回收站](u13)**',
        '> <font color="info">新建需求</font>　<font color="comment">周岚 10-09 17:30</font>',
      ].join('\n'),
    });
  });

  const cardData = {
    title: '网盘 研发日报 · 2026-10-09',
    desc: '迭代1016 · 10/16 发版 · 还剩 5 个工作日',
    button: { title: '查看甘特', url: 'http://flower.example.com/acme/iterations/i1?tab=gantt' },
    source: { desc: 'Flower · 研发日报', desc_color: 2 },
    emphasis: { title: '62%', desc: '整体进度（理论 70%）' },
    stats: [
      { keyname: '需求', value: '12 项' },
      { keyname: '落后', value: '3 项' },
      { keyname: '遗留下期', value: '1 项' },
    ],
    quote: { type: 0, title: '需要关注', quote_text: 'PAN-12 批量下载 · 林澄 · 接口延期\nPAN-15 分享链接 · 周岚' },
    jumps: [
      { type: 1, title: '查看甘特', url: 'http://flower.example.com/acme/iterations/i1?tab=gantt' },
      { type: 1, title: '需求列表', url: 'http://flower.example.com/acme/requirements?product=PAN&iteration=i1' },
    ],
  };

  it('概览卡片：来源行、主标题、关键数据、名称 + 值、需要关注、两个跳转，整卡点击到甘特页；没有需要关注时去掉引用区', () => {
    const { format, body } = BUILTIN_TEMPLATES.overview_card;
    const card = renderMessage(format, body, cardData);
    expect(card).toEqual({
      format: 'template_card',
      card: {
        card_type: 'text_notice',
        source: { desc: 'Flower · 研发日报', desc_color: 2 },
        main_title: { title: '网盘 研发日报 · 2026-10-09', desc: '迭代1016 · 10/16 发版 · 还剩 5 个工作日' },
        emphasis_content: { title: '62%', desc: '整体进度（理论 70%）' },
        horizontal_content_list: cardData.stats,
        quote_area: cardData.quote,
        jump_list: cardData.jumps,
        card_action: { type: 1, url: 'http://flower.example.com/acme/iterations/i1?tab=gantt' },
      },
    });
    const noQuote = renderMessage(format, body, { ...cardData, quote: null });
    expect(noQuote.format === 'template_card' && Object.keys(noQuote.card)).toEqual(['card_type', 'source', 'main_title', 'emphasis_content', 'horizontal_content_list', 'jump_list', 'card_action']);
  });
});

describe('预置模板的升级', () => {
  it('以前的默认内容换成当前默认内容；修改过的不变', () => {
    for (const k of BUILTIN_TEMPLATE_KEYS) {
      for (const old of PREVIOUS_BUILTIN_BODIES[k]) {
        expect(old).not.toBe(BUILTIN_TEMPLATES[k].body);
        expect(currentBuiltinBody(k, old)).toBe(BUILTIN_TEMPLATES[k].body);
      }
      expect(currentBuiltinBody(k, BUILTIN_TEMPLATES[k].body)).toBe(BUILTIN_TEMPLATES[k].body);
      expect(currentBuiltinBody(k, `${PREVIOUS_BUILTIN_BODIES[k][0]}\n改过`)).toBe(`${PREVIOUS_BUILTIN_BODIES[k][0]}\n改过`);
    }
  });

  it('读取列表时，仍是旧默认内容的预置行换成新内容，改过的行不动；渲染时旧默认内容按新内容渲染', async () => {
    const o = owner;
    await listMessageTemplates(t.db, o);
    const setBody = (k: BuiltinTemplateKey, body: string) =>
      t.adminDb
        .update(messageTemplates)
        .set({ body })
        .where(and(eq(messageTemplates.orgId, o.orgId), eq(messageTemplates.builtinKey, k)));
    await setBody('event', PREVIOUS_BUILTIN_BODIES.event[0]!);
    await setBody('digest', '改过的摘要 {{period}}');
    await withOrg(t.db, o.orgId, async (tx) => {
      expect((await resolveTemplateTx(tx, null, 'event')).body).toBe(BUILTIN_TEMPLATES.event.body);
      expect((await resolveTemplateTx(tx, null, 'digest')).body).toBe('改过的摘要 {{period}}');
    });
    const list = await listMessageTemplates(t.db, o);
    expect(list.find((x) => x.builtinKey === 'event')!.body).toBe(BUILTIN_TEMPLATES.event.body);
    expect(list.find((x) => x.builtinKey === 'digest')!.body).toBe('改过的摘要 {{period}}');
    const [row] = await t.adminDb.select().from(messageTemplates).where(and(eq(messageTemplates.orgId, o.orgId), eq(messageTemplates.builtinKey, 'event')));
    expect(row!.body).toBe(BUILTIN_TEMPLATES.event.body);
  });
});

describe('消息模板', () => {
  it('列表补齐四个预置模板，重复读取不重复插入', async () => {
    const first = await listMessageTemplates(t.db, owner);
    expect(first.filter((x) => x.builtin).map((x) => x.builtinKey).sort()).toEqual(['digest', 'event', 'new_requirements', 'overview_card']);
    await listMessageTemplates(t.db, owner);
    expect(await t.adminDb.select().from(messageTemplates).where(eq(messageTemplates.builtin, true))).toHaveLength(4);
  });

  it('预置模板只能改内容，不能改名、改格式、删除', async () => {
    const ev = (await listMessageTemplates(t.db, owner)).find((x) => x.builtinKey === 'event')!;
    await expect(updateMessageTemplate(t.db, owner, ev.id, { name: '改名' })).rejects.toThrow('预置模板只能修改内容');
    await expect(updateMessageTemplate(t.db, owner, ev.id, { format: 'text' })).rejects.toThrow('预置模板只能修改内容');
    const edited = await updateMessageTemplate(t.db, owner, ev.id, { body: '{{subject.key}} {{event.label}}' });
    expect(edited.body).toBe('{{subject.key}} {{event.label}}');
    await expect(deleteMessageTemplate(t.db, owner, ev.id)).rejects.toThrow('预置模板不能删除');
  });

  it('新建：校验语法与卡片 JSON；名称唯一；成员只能看不能建；访客不能看', async () => {
    await expect(createMessageTemplate(t.db, owner, { name: '坏模板', format: 'markdown', body: '{{#a}}' })).rejects.toThrow('模板语法错误');
    expect((await createMessageTemplate(t.db, owner, { name: '表格模板', format: 'markdown_v2', body: '| a |\n|---|\n| {{x}} |' })).format).toBe('markdown_v2');
    await expect(createMessageTemplate(t.db, owner, { name: '坏卡片', format: 'template_card', body: 'not json' })).rejects.toThrow('JSON 对象');
    const tpl = await createMessageTemplate(t.db, owner, { name: '简版', format: 'text', body: '{{subject.key}} {{summary}}' });
    expect(tpl).toMatchObject({ builtin: false, builtinKey: null, usage: { rules: 0, schedules: 0 } });
    await expect(createMessageTemplate(t.db, owner, { name: '简版', format: 'text', body: 'x' })).rejects.toThrow('模板名称已存在');
    const member = await asMember(t.db, owner, '成员乙');
    expect((await listMessageTemplates(t.db, member)).some((x) => x.name === '简版')).toBe(true);
    await expect(createMessageTemplate(t.db, member, { name: '成员建', format: 'text', body: 'x' })).rejects.toThrow('需要组织管理员权限');
    const guest = await asMember(t.db, owner, '访客乙', 'guest');
    await expect(listMessageTemplates(t.db, guest)).rejects.toThrow('访客');
  });

  it('访客是某个产品的管理员时可以查看模板（规则与定时推送的表单要用），仍不能新建；只是成员的访客不能看', async () => {
    const guestAdmin = await asMember(t.db, owner, '访客产品管理员', 'guest');
    await setProductRole(t.db, owner, productId, guestAdmin.memberId, 'admin');
    const list = await listMessageTemplates(t.db, guestAdmin);
    expect(list.filter((x) => x.builtin)).toHaveLength(4);
    await expect(createMessageTemplate(t.db, guestAdmin, { name: '访客建', format: 'text', body: 'x' })).rejects.toThrow('需要组织管理员权限');
    const guestEditor = await asMember(t.db, owner, '访客编辑', 'guest');
    await setProductRole(t.db, owner, productId, guestEditor.memberId, 'editor');
    await expect(listMessageTemplates(t.db, guestEditor)).rejects.toThrow('访客');
  });

  it('解析模板：指定的模板 → 预置行（含修改）→ 代码默认值；被引用的模板不能删除', async () => {
    const tpl = await createMessageTemplate(t.db, owner, { name: '被引用', format: 'markdown', body: '**{{title}}**' });
    await withOrg(t.db, owner.orgId, async (tx) => {
      expect(await resolveTemplateTx(tx, tpl.id, 'overview_card')).toEqual({ format: 'markdown', body: '**{{title}}**' });
      expect(await resolveTemplateTx(tx, null, 'event')).toEqual({ format: 'markdown', body: '{{subject.key}} {{event.label}}' });
    });
    await t.adminDb.delete(messageTemplates).where(and(eq(messageTemplates.orgId, owner.orgId), eq(messageTemplates.builtinKey, 'digest')));
    await withOrg(t.db, owner.orgId, async (tx) => {
      expect(await resolveTemplateTx(tx, null, 'digest')).toEqual({ format: BUILTIN_TEMPLATES.digest.format, body: BUILTIN_TEMPLATES.digest.body });
    });
    await t.adminDb.insert(notificationSchedules).values({ orgId: owner.orgId, productId, name: '用模板', cron: '0 9 * * *', source: 'overview_card', templateId: tpl.id });
    await expect(deleteMessageTemplate(t.db, owner, tpl.id)).rejects.toThrow('模板正在被规则或定时推送使用');
    const free = await createMessageTemplate(t.db, owner, { name: '可删', format: 'text', body: 'x' });
    await deleteMessageTemplate(t.db, owner, free.id);
    expect((await listMessageTemplates(t.db, owner)).some((x) => x.id === free.id)).toBe(false);
  });
});
