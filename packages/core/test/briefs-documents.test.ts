import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, entityLinks, notificationDeliveries } from '../src/db/schema';
import { BRIEF_TEMPLATE } from '../src/documents/brief-template';
import { createBrief } from '../src/documents/briefs';
import { createDocument, getDocumentByKey, listDocuments, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { listBacklinks } from '../src/links/backlinks';
import { listDocumentLinkCards } from '../src/links/cards';
import { createRule } from '../src/notifications/rules';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guest: Actor;
let pan: string;
let prd: Awaited<ReturnType<typeof createDocument>>;

const eventsOf = (subjectId: string) => t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, subjectId));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '访客丙', 'guest');
});
afterAll(() => t.cleanup());

describe('新建简报', () => {
  it('按预置模板生成正文；编号 PAN-B-n 与 PRD 编号各自从 1 开始；讨论中；作者为创建人；只记 brief.created', async () => {
    prd = await createDocument(t.db, editor, pan, { title: '已有 PRD' });
    expect(prd.displayKey).toBe('PAN-PRD-1');
    const b = await createBrief(t.db, editor, pan, { title: '上传提速' });
    expect(b).toMatchObject({
      displayKey: 'PAN-B-1',
      kind: 'brief',
      status: 'discussing',
      source: 'native',
      revisionNumber: 1,
      transitions: ['ready', 'discarded'],
      requirements: [],
      checkItems: [],
      sourceBrief: null,
      templateGuidance: BRIEF_TEMPLATE.guidance,
    });
    expect(b.markdown).toBe(BRIEF_TEMPLATE.body);
    expect(b.brief).toEqual({
      version: 'v0.1',
      requester: null,
      decider: null,
      author: { id: editor.memberId, displayName: '编辑甲' },
      participantTags: [],
      relatedLinks: [],
      convertedDocument: null,
    });
    expect(prd.brief).toBeNull();
    expect((await createBrief(t.db, editor, pan, { title: '下载限速' })).displayKey).toBe('PAN-B-2');
    expect((await createDocument(t.db, editor, pan, { title: '第二份 PRD' })).displayKey).toBe('PAN-PRD-2');
    expect((await eventsOf(b.id)).map((e) => e.type)).toEqual(['brief.created']);
  });

  it('只读成员与只读 Token 不能新建；看不到产品时按不存在处理；标题不能为空', async () => {
    await expect(createBrief(t.db, viewer, pan, { title: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createBrief(t.db, readOnlyToken(owner), pan, { title: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createBrief(t.db, guest, pan, { title: '访客' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createBrief(t.db, editor, pan, { title: ' ' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('简报与 PRD 同号互不串号', () => {
  it('按编号打开：PAN-B-1 是简报，PAN-PRD-1 是 PRD；PRD 列表不含简报；不存在的简报编号返回「简报不存在」', async () => {
    expect((await getDocumentByKey(t.db, viewer, 'PAN-B-1')).kind).toBe('brief');
    expect((await getDocumentByKey(t.db, viewer, 'PAN-PRD-1')).kind).toBe('change');
    await expect(getDocumentByKey(t.db, viewer, 'PAN-B-9')).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
    await expect(getDocumentByKey(t.db, guest, 'PAN-B-1')).rejects.toMatchObject({ code: 'not_found' });
    expect((await listDocuments(t.db, viewer, pan)).map((d) => d.displayKey).sort()).toEqual(['PAN-PRD-1', 'PAN-PRD-2']);
  });

  it('[[ ]]：PAN-B-n（含小节）解析为简报，PAN-PRD-n 为 PRD；后建的简报接上悬空链接；被引用里显示 PRD 编号', async () => {
    await saveDocumentContent(t.db, editor, prd.id, { baseVersion: prd.version, markdown: '见 [[PAN-B-1]]、[[PAN-B-1#2. 数据依据]]、[[PAN-PRD-2]] 与 [[PAN-B-3]]。\n' });
    const cards = async () => Object.fromEntries((await listDocumentLinkCards(t.db, editor, prd.id)).map((c) => [c.text, [c.displayKey, c.state, c.href]]));
    expect(await cards()).toEqual({
      'PAN-B-1': ['PAN-B-1', 'ok', 'documents/PAN-B-1'],
      'PAN-B-1#2. 数据依据': ['PAN-B-1#2. 数据依据', 'ok', `documents/PAN-B-1?section=${encodeURIComponent('2. 数据依据')}`],
      'PAN-PRD-2': ['PAN-PRD-2', 'ok', 'documents/PAN-PRD-2'],
      'PAN-B-3': ['PAN-B-3', 'missing', null],
    });
    await createBrief(t.db, editor, pan, { title: '分享有效期' });
    expect((await cards())['PAN-B-3']).toEqual(['PAN-B-3', 'ok', 'documents/PAN-B-3']);
    const b1 = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    expect((await listBacklinks(t.db, editor, { type: 'document', id: b1.id })).map((g) => [g.displayKey, g.href])).toEqual([['PAN-PRD-1', 'documents/PAN-PRD-1']]);
  });

  it('[[ ]]：同号的 PAN-B-n 与 PAN-PRD-n 分别指向简报与 PRD', async () => {
    const b3 = await getDocumentByKey(t.db, editor, 'PAN-B-3');
    await saveDocumentContent(t.db, editor, b3.id, { baseVersion: b3.version, markdown: '[[PAN-B-1]] [[PAN-PRD-1]] [[PAN-B-2]] [[PAN-PRD-2]]\n' });
    const ids = Object.fromEntries(
      await Promise.all(['PAN-B-1', 'PAN-PRD-1', 'PAN-B-2', 'PAN-PRD-2'].map(async (k) => [k, (await getDocumentByKey(t.db, editor, k)).id] as const)),
    );
    const rows = await t.adminDb.select().from(entityLinks).where(eq(entityLinks.sourceId, b3.id));
    expect(Object.fromEntries(rows.map((r) => [r.targetText, r.targetId]))).toEqual(ids);
    expect(new Set(Object.values(ids)).size).toBe(4);
  });
});

describe('简报的状态流转与推送', () => {
  it('讨论中 → 可写 PRD；不能改为 PRD 的状态，也不能直接改为已转 PRD；只读不能改；事件带 kind', async () => {
    const b = await getDocumentByKey(t.db, editor, 'PAN-B-2');
    const r = await transitionDocument(t.db, editor, b.id, { to: 'ready' });
    expect([r.status, r.transitions]).toEqual(['ready', ['discussing', 'discarded']]);
    await expect(transitionDocument(t.db, editor, b.id, { to: 'draft' })).rejects.toThrow('不能从「可以写 PRD」改为「草稿」');
    await expect(transitionDocument(t.db, editor, b.id, { to: 'converted' })).rejects.toThrow('不能从「可以写 PRD」改为「已生成 PRD」');
    await expect(transitionDocument(t.db, viewer, b.id, { to: 'discussing' })).rejects.toMatchObject({ code: 'forbidden' });
    const [ev] = (await eventsOf(b.id)).filter((e) => e.type === 'document.status_changed');
    expect(ev!.payload).toMatchObject({ kind: 'brief', changes: [{ field: 'status', old: 'discussing', new: 'ready' }] });
  });

  it('订阅「PRD 状态变化」的事件规则不因简报改状态产生发送记录，PRD 改状态照常', async () => {
    const channel = await wecomChannel(t.db, owner, '研发群');
    const rule = await createRule(t.db, owner, pan, { name: 'PRD 状态', eventTypes: ['document.status_changed'], channelIds: [channel.id] });
    const deliveries = () => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, rule.id));
    const b = await getDocumentByKey(t.db, editor, 'PAN-B-2');
    await transitionDocument(t.db, editor, b.id, { to: 'discussing' });
    expect(await deliveries()).toHaveLength(0);
    await transitionDocument(t.db, editor, prd.id, { to: 'review' });
    expect(await deliveries()).toHaveLength(1);
  });
});
