import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messageTemplates, notificationSchedules } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { BUILTIN_TEMPLATES } from '../src/notifications/builtin';
import { createMessageTemplate, deleteMessageTemplate, listMessageTemplates, resolveTemplateTx, updateMessageTemplate } from '../src/notifications/message-templates';
import { renderMessage } from '../src/notifications/template';
import { createProduct } from '../src/tenancy/products';
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
  it('事件推送', () => {
    const { format, body } = BUILTIN_TEMPLATES.event;
    const msg = renderMessage(format, body, {
      product: { key: 'PAN', name: '网盘' },
      event: { label: '需求状态变化', actor: '林澄', time: '10-09 14:20' },
      subject: { key: 'PAN-12', title: '批量下载', url: 'http://flower.example.com/acme/requirements/PAN-12' },
      changes: [{ label: '状态', old: '待开始', new: '进行中' }],
    });
    expect(msg).toEqual({
      format: 'markdown',
      text: '**网盘 · 需求状态变化**\n[PAN-12 批量下载](http://flower.example.com/acme/requirements/PAN-12)\n> 状态：待开始 → 进行中\n<font color="comment">林澄 · 10-09 14:20</font>',
    });
  });

  it('新需求：与 push 相同的结构（标题、引用行、分组、每条三到四行、末行链接）', () => {
    const { format, body } = BUILTIN_TEMPLATES.new_requirements;
    const msg = renderMessage(format, body, {
      date: '10/9',
      newCount: 1,
      onlineCount: 1,
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
        '# 📋 10/9 新增需求',
        '> 🆕 新增 1 条 · 🔧 线上转需求 1 条',
        '',
        '**🆕 新增需求**',
        '',
        '**1. [PAN-1 离线下载](u1)** <font color="warning">P0</font>',
        '<font color="comment">客户甲 · 功能 · PC/Web</font>',
        '<font color="comment">支持离线</font>',
        '[PRD ↗](https://docs.example.com/prd-1)',
        '',
        '**🔧 线上转需求**',
        '',
        '**2. [PAN-2 上传失败](u2)** <font color="comment">P2</font>',
        '<font color="comment">客户乙 · 功能</font>',
        '',
        '> 👉 [到 Flower 认领 / 分配 ↗](http://flower.example.com/acme/requirements?product=PAN)',
      ].join('\n'),
    });
  });

  it('变更摘要与概览卡片', () => {
    const digest = renderMessage(BUILTIN_TEMPLATES.digest.format, BUILTIN_TEMPLATES.digest.body, {
      product: { name: '网盘' },
      period: '10-09 09:00 – 10-09 18:00',
      eventCount: 2,
      subjectCount: 1,
      groups: [{ key: 'PAN-12', title: '批量下载', url: 'u', lines: [{ text: '10-09 10:00 林澄：需求状态变化：状态 待开始 → 进行中' }, { text: '10-09 11:00 林澄：需求字段变化：优先级 P1 → P0' }] }],
    });
    expect(digest).toEqual({
      format: 'markdown',
      text: '# 📋 网盘 变更摘要\n> 10-09 09:00 – 10-09 18:00 · 共 2 项变化，涉及 1 个对象\n\n**[PAN-12 批量下载](u)**\n> 10-09 10:00 林澄：需求状态变化：状态 待开始 → 进行中\n> 10-09 11:00 林澄：需求字段变化：优先级 P1 → P0',
    });
    const card = renderMessage(BUILTIN_TEMPLATES.overview_card.format, BUILTIN_TEMPLATES.overview_card.body, {
      title: '网盘 研发日报 · 2026-10-09',
      desc: '1016 发版 · 整体进度 75% · 点开查看需求与甘特',
      button: { title: '查看完整明细', url: 'http://flower.example.com/acme/iterations/i1' },
    });
    expect(card).toEqual({
      format: 'template_card',
      card: {
        card_type: 'text_notice',
        main_title: { title: '网盘 研发日报 · 2026-10-09', desc: '1016 发版 · 整体进度 75% · 点开查看需求与甘特' },
        jump_list: [{ type: 1, title: '查看完整明细', url: 'http://flower.example.com/acme/iterations/i1' }],
        card_action: { type: 1, url: 'http://flower.example.com/acme/iterations/i1' },
      },
    });
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
