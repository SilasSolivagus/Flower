import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberNotifications } from '../src/db/schema';
import { createBrief, updateBrief } from '../src/documents/briefs';
import { unlinkDocumentRequirement } from '../src/documents/coverage';
import { getDocumentByKey, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { mentionMarkup } from '../src/links/syntax';
import { generateMemberNotifications } from '../src/member-notifications/generate';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { updateMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let decider: Actor;
let member: Actor;
let outsider: Actor;
let pan: string;

const generate = () => generateMemberNotifications(t.db, owner.orgId, { publicUrl: 'http://flower.example.com' }, new Date());
const inbox = (memberId: string) =>
  t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.memberId, memberId)).orderBy(asc(memberNotifications.createdAt), asc(memberNotifications.id));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  decider = await asMember(t.db, owner, '决策人乙');
  member = await asMember(t.db, owner, '成员丙');
  outsider = await asMember(t.db, owner, '访客丁');
  await updateMember(t.db, owner, outsider.memberId, { orgRole: 'guest' });
});
afterAll(() => t.cleanup());

describe('简报的站内通知', () => {
  it('被设为决策人时收到「被指派」；自己设自己不通知；看不到该产品的访客不通知', async () => {
    const brief = await createBrief(t.db, editor, pan, { title: '上传提速' });
    await updateBrief(t.db, editor, brief.id, { deciderMemberId: editor.memberId });
    await updateBrief(t.db, editor, brief.id, { deciderMemberId: decider.memberId });
    await updateBrief(t.db, editor, brief.id, { deciderMemberId: outsider.memberId });
    await generate();
    expect((await inbox(decider.memberId)).map((n) => [n.kind, n.title, n.body, n.url])).toEqual([
      ['assigned', 'PAN-B-1 上传提速', '把你设为这份简报的确认人，请确认问题、规则、指标与上线策略', '/acme/documents/PAN-B-1'],
    ]);
    expect((await inbox(editor.memberId)).filter((n) => n.body.startsWith('把你设为这份简报的确认人'))).toEqual([]);
    expect(await inbox(outsider.memberId)).toEqual([]);
  });

  it('正文 @ 与状态变化的文案写「简报」，标题与链接用简报编号；决策人已自动关注', async () => {
    const brief = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    await saveDocumentContent(t.db, editor, brief.id, { baseVersion: brief.version, markdown: `请 ${mentionMarkup(member.memberId, '成员丙')} 补充数据\n` });
    await transitionDocument(t.db, editor, brief.id, { to: 'ready' });
    await generate();
    const mentioned = (await inbox(member.memberId)).find((n) => n.body === '在简报正文中 @ 了你');
    expect([mentioned?.title, mentioned?.url]).toEqual(['PAN-B-1 上传提速', '/acme/documents/PAN-B-1']);
    const changed = (await inbox(decider.memberId)).find((n) => n.body === '把简报状态从「讨论中」改为「可以写 PRD」');
    expect([changed?.title, changed?.url]).toEqual(['PAN-B-1 上传提速', '/acme/documents/PAN-B-1']);
  });
});

describe('需求详情里的简报', () => {
  it('显示所挂简报的编号、标题、状态与闸口进度；没挂或移出后为空', async () => {
    const r = await createRequirement(t.db, editor, pan, { title: '挂简报的需求' });
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).brief).toBeNull();
    const brief = await createBrief(t.db, editor, pan, { title: '第二份简报', requirementIds: [r.id] });
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).brief).toEqual({
      id: brief.id,
      displayKey: 'PAN-B-2',
      title: '第二份简报',
      status: 'discussing',
      gate: { passed: 2, total: 11 },
    });
    await unlinkDocumentRequirement(t.db, editor, brief.id, r.id);
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).brief).toBeNull();
  });
});
