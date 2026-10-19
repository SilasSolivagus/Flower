import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documents, domainEvents, requirements } from '../src/db/schema';
import { createBrief, getBriefGate, listBriefs, setBriefGateCheck, updateBrief } from '../src/documents/briefs';
import { linkDocumentRequirements, linkRequirementsTx, unlinkDocumentRequirement } from '../src/documents/coverage';
import { createDocument, getDocumentByKey, saveDocumentContent, transitionDocument, updateDocument } from '../src/documents/documents';
import { addAffectedNode } from '../src/documents/affected';
import { setDocumentCheckItemState, signDocumentCheckItem } from '../src/documents/checks';
import { getMergePlan } from '../src/documents/merge';
import type { Actor } from '../src/domain-types';
import { withOrg } from '../src/db/tx';
import { mentionMarkup } from '../src/links/syntax';
import { createRequirement } from '../src/requirements/requirements';
import { createFunctionTag, deleteFunctionTag, listFunctionTags } from '../src/tenancy/function-tags';
import { createAgentMember, updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guest: Actor;
let pan: string;
let docProduct: string;
let prdId: string;
const RANDOM = '00000000-0000-4000-8000-000000000001';

const eventsOf = (subjectId: string, type?: string) =>
  t.adminDb
    .select()
    .from(domainEvents)
    .where(type ? and(eq(domainEvents.subjectId, subjectId), eq(domainEvents.type, type)) : eq(domainEvents.subjectId, subjectId))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));
const brief1 = () => getDocumentByKey(t.db, editor, 'PAN-B-1');

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  docProduct = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '访客丙', 'guest');
  await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('覆盖需求', () => {
  it('新建时可直接覆盖；按文档接口关联与移出；一条需求只能挂一份简报，可以同时挂 PRD；已废弃的简报不能再关联；记事件', async () => {
    const r1 = await createRequirement(t.db, editor, pan, { title: '需求一' });
    const r2 = await createRequirement(t.db, editor, pan, { title: '需求二' });
    const r3 = await createRequirement(t.db, editor, docProduct, { title: '别的产品的需求' });
    const b1 = await createBrief(t.db, editor, pan, { title: '简报一', requirementIds: [r1.id] });
    expect([b1.requirements.map((r) => r.displayKey), b1.requirementCount]).toEqual([['PAN-1'], 1]);
    await linkDocumentRequirements(t.db, editor, b1.id, { requirementIds: [r2.id] });
    const prd = await createDocument(t.db, editor, pan, { title: 'PRD', requirementIds: [r2.id] });
    prdId = prd.id;
    const [row] = await t.adminDb.select().from(requirements).where(eq(requirements.id, r2.id));
    expect([row!.briefDocumentId, row!.changeDocumentId]).toEqual([b1.id, prd.id]);

    const b2 = await createBrief(t.db, editor, pan, { title: '简报二' });
    await expect(linkDocumentRequirements(t.db, editor, b2.id, { requirementIds: [r1.id] })).rejects.toThrow('PAN-1 已挂在 PAN-B-1 上，请先从那份简报移出');
    await expect(linkDocumentRequirements(t.db, editor, b2.id, { requirementIds: [r3.id] })).rejects.toThrow('DOC-1 不属于这份简报所在的产品');
    await expect(linkDocumentRequirements(t.db, viewer, b1.id, { requirementIds: [r2.id] })).rejects.toMatchObject({ code: 'forbidden' });

    await unlinkDocumentRequirement(t.db, editor, b1.id, r2.id);
    await expect(unlinkDocumentRequirement(t.db, editor, b1.id, r2.id)).rejects.toThrow('该需求没有挂在这份简报上');
    expect((await brief1()).requirements.map((r) => r.displayKey)).toEqual(['PAN-1']);
    expect((await getDocumentByKey(t.db, editor, prd.displayKey)).requirements.map((r) => r.displayKey)).toEqual(['PAN-2']);
    expect((await eventsOf(b1.id)).map((e) => e.type)).toEqual(['brief.created', 'document.requirements_linked', 'document.requirements_linked', 'document.requirement_unlinked']);
    const [ev] = await eventsOf(r1.id, 'requirement.updated');
    expect(ev!.payload).toMatchObject({ changes: [{ field: 'briefDocumentId', old: null, new: b1.id }], brief: 'PAN-B-1' });

    await transitionDocument(t.db, editor, b2.id, { to: 'discarded' });
    await expect(linkDocumentRequirements(t.db, editor, b2.id, { requirementIds: [r2.id] })).rejects.toThrow('已废弃的简报不能再关联需求');
  });
});

describe('头部信息', () => {
  it('改版本、提出人、决策人、参与方、关联文档；只记变化的字段；没有变化时不记事件', async () => {
    const b = await brief1();
    const [dev, qa] = (await listFunctionTags(t.db, owner)).filter((x) => ['开发', '测试'].includes(x.name));
    const r = await updateBrief(t.db, editor, b.id, {
      version: ' v0.2 ',
      deciderMemberId: viewer.memberId,
      requesterMemberId: owner.memberId,
      participantTagIds: [dev!.id, qa!.id, dev!.id],
      relatedLinks: [
        { kind: 'wiki', target: '[[PAN-PRD-1]]', note: ' 旧方案 ' },
        { kind: 'url', url: ' https://doc.example.com/x ', note: '群聊记录' },
      ],
    });
    expect(r.brief).toMatchObject({
      version: 'v0.2',
      decider: { id: viewer.memberId, displayName: '只读乙' },
      requester: { id: owner.memberId },
      author: { id: editor.memberId },
      participantTags: [
        { id: dev!.id, name: '开发' },
        { id: qa!.id, name: '测试' },
      ],
      relatedLinks: [
        { kind: 'wiki', target: 'PAN-PRD-1', note: '旧方案' },
        { kind: 'url', url: 'https://doc.example.com/x', note: '群聊记录' },
      ],
    });
    const updated = await eventsOf(b.id, 'brief.updated');
    expect(updated).toHaveLength(1);
    expect((updated[0]!.payload.changes as Array<{ field: string }>).map((c) => c.field).sort()).toEqual(['deciderMemberId', 'participantTagIds', 'relatedLinks', 'requesterMemberId', 'version']);
    await updateBrief(t.db, editor, b.id, { version: 'v0.2' });
    expect(await eventsOf(b.id, 'brief.updated')).toHaveLength(1);
  });

  it('校验：Agent 与已离开的成员不能被选；标签必须存在；网址与引用格式；条数与长度；只读不能改', async () => {
    const b = await brief1();
    const agent = await createAgentMember(t.db, owner, { displayName: '机器人' });
    await expect(updateBrief(t.db, editor, b.id, { deciderMemberId: agent.id })).rejects.toThrow('不能选择 Agent 成员');
    const left = await asMember(t.db, owner, '已离开丁');
    await updateMember(t.db, owner, left.memberId, { status: 'left' });
    await expect(updateBrief(t.db, editor, b.id, { authorMemberId: left.memberId })).rejects.toThrow('该成员已离开组织，不能选择');
    await expect(updateBrief(t.db, editor, b.id, { participantTagIds: [RANDOM] })).rejects.toThrow('参与角色不存在');
    await expect(updateBrief(t.db, editor, b.id, { relatedLinks: [{ kind: 'url', url: 'ftp://x', note: '' }] })).rejects.toThrow('关联文档的网址无效');
    await expect(updateBrief(t.db, editor, b.id, { relatedLinks: [{ kind: 'wiki', target: '[[ ]]', note: '' }] })).rejects.toThrow('引用写法无效');
    const many = Array.from({ length: 21 }, (_, i) => ({ kind: 'url' as const, url: `https://doc.example.com/${i}`, note: '' }));
    await expect(updateBrief(t.db, editor, b.id, { relatedLinks: many })).rejects.toThrow('关联文档不超过 20 条');
    await expect(updateBrief(t.db, editor, b.id, { version: ' ' })).rejects.toThrow('版本不能为空，且不超过 30 个字符');
    await expect(updateBrief(t.db, viewer, b.id, { version: 'v1' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateBrief(t.db, readOnlyToken(owner), b.id, { version: 'v1' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateBrief(t.db, editor, prdId, { version: 'v1' })).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
  });

  it('删掉的职能标签不再显示在参与方里', async () => {
    const b = await brief1();
    const legal = await createFunctionTag(t.db, owner, { name: '法务', color: '#64748b' });
    await updateBrief(t.db, editor, b.id, { participantTagIds: [legal.id] });
    await deleteFunctionTag(t.db, owner, legal.id);
    expect((await brief1()).brief!.participantTags).toEqual([]);
  });
});

describe('闸口', () => {
  it('只读可读；编辑勾选与取消人工项并记录勾选人与时间；重复勾选不记事件；自动项与不存在的项不能勾选；只读 Token 不能勾选', async () => {
    const b = await brief1();
    const g0 = await getBriefGate(t.db, viewer, b.id);
    expect([g0.passed, g0.total]).toEqual([2, 11]);
    const g1 = await setBriefGateCheck(t.db, editor, b.id, 2, { checked: true });
    expect(g1.passed).toBe(3);
    expect(g1.items.find((i) => i.no === 2)).toMatchObject({ passed: true, checkedBy: { id: editor.memberId, displayName: '编辑甲' } });
    expect(g1.items.find((i) => i.no === 2)!.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await setBriefGateCheck(t.db, editor, b.id, 2, { checked: true })).passed).toBe(3);
    expect((await setBriefGateCheck(t.db, editor, b.id, 2, { checked: false })).passed).toBe(2);
    await expect(setBriefGateCheck(t.db, editor, b.id, 1, { checked: true })).rejects.toThrow('这一项由系统检查，不能手动勾选');
    await expect(setBriefGateCheck(t.db, editor, b.id, 12, { checked: true })).rejects.toThrow('检查项不存在');
    await expect(setBriefGateCheck(t.db, viewer, b.id, 3, { checked: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setBriefGateCheck(t.db, readOnlyToken(owner), b.id, 3, { checked: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getBriefGate(t.db, editor, prdId)).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
    expect((await eventsOf(b.id, 'brief.gate_checked')).map((e) => e.payload)).toMatchObject([
      { item: 2, checked: true, changes: [{ field: 'gate.2', old: false, new: true }] },
      { item: 2, checked: false },
    ]);
  });
});

describe('简报列表', () => {
  it('按可见产品过滤；按产品、状态、决策人筛选；带覆盖需求数、闸口进度与决策人；按更新时间倒序', async () => {
    const other = await createBrief(t.db, owner, docProduct, { title: '别的产品的简报' });
    expect(other.displayKey).toBe('DOC-B-1');
    const at = (key: string, ms: number) => t.adminDb.update(documents).set({ updatedAt: new Date(ms) }).where(eq(documents.id, key));
    const idOf = async (k: string) => (await getDocumentByKey(t.db, owner, k)).id;
    await at(other.id, 3000);
    await at(await idOf('PAN-B-1'), 2000);
    await at(await idOf('PAN-B-2'), 1000);
    const all = await listBriefs(t.db, owner);
    expect(all.map((x) => x.displayKey)).toEqual(['DOC-B-1', 'PAN-B-1', 'PAN-B-2']);
    expect(all.find((x) => x.displayKey === 'PAN-B-1')).toMatchObject({
      title: '简报一',
      status: 'discussing',
      requirementCount: 1,
      gate: { passed: 2, total: 11 },
      decider: { id: viewer.memberId, displayName: '只读乙' },
    });
    expect((await listBriefs(t.db, owner, { productId: pan })).map((x) => x.displayKey)).toEqual(['PAN-B-1', 'PAN-B-2']);
    expect((await listBriefs(t.db, owner, { statuses: ['discarded'] })).map((x) => x.displayKey)).toEqual(['PAN-B-2']);
    expect((await listBriefs(t.db, owner, { deciderId: viewer.memberId })).map((x) => x.displayKey)).toEqual(['PAN-B-1']);
    expect((await listBriefs(t.db, guest)).map((x) => x.displayKey)).toEqual(['PAN-B-1', 'PAN-B-2']);
    expect(await listBriefs(t.db, guest, { productId: docProduct })).toEqual([]);
    expect(await listBriefs(t.db, owner, { productId: RANDOM })).toEqual([]);
  });
});

describe('简报走文档入口时的分流与拒绝', () => {
  it('关联需求只写 brief_document_id，不碰 change_document_id、「PRD」检查项；按 PRD 方式关联简报会被拒绝', async () => {
    const r = await createRequirement(t.db, editor, pan, { title: '分流需求' });
    const b = await createBrief(t.db, editor, pan, { title: '分流简报' });
    await linkDocumentRequirements(t.db, editor, b.id, { requirementIds: [r.id] });
    const [row] = await t.adminDb.select().from(requirements).where(eq(requirements.id, r.id));
    expect([row!.briefDocumentId, row!.changeDocumentId]).toEqual([b.id, null]);
    expect(await eventsOf(r.id, 'check_item.updated')).toEqual([]);
    await expect(withOrg(t.db, editor.orgId, (tx) => linkRequirementsTx(tx, editor, b.id, [r.id]))).rejects.toThrow('简报的需求不能按 PRD 的方式关联');
    await unlinkDocumentRequirement(t.db, editor, b.id, r.id);
    const [after] = await t.adminDb.select().from(requirements).where(eq(requirements.id, r.id));
    expect([after!.briefDocumentId, after!.changeDocumentId]).toEqual([null, null]);
    expect(await eventsOf(r.id, 'check_item.updated')).toEqual([]);
  });

  it('PRD 的覆盖仍写 change_document_id，且已挂 PRD 的需求不受简报影响', async () => {
    const r = await createRequirement(t.db, editor, pan, { title: '双挂需求' });
    const prd = await createDocument(t.db, editor, pan, { title: '双挂 PRD', requirementIds: [r.id] });
    const b = await createBrief(t.db, editor, pan, { title: '双挂简报', requirementIds: [r.id] });
    const [row] = await t.adminDb.select().from(requirements).where(eq(requirements.id, r.id));
    expect([row!.briefDocumentId, row!.changeDocumentId]).toEqual([b.id, prd.id]);
    await expect(unlinkDocumentRequirement(t.db, editor, prd.id, r.id)).resolves.toBeUndefined();
    const [after] = await t.adminDb.select().from(requirements).where(eq(requirements.id, r.id));
    expect([after!.briefDocumentId, after!.changeDocumentId]).toEqual([b.id, null]);
  });

  it('不接受简报：影响声明、合入、PRD 检查项与签字、改负责人；正文保存与 @ 照常', async () => {
    const b = await brief1();
    await expect(addAffectedNode(t.db, editor, b.id, { nodeId: RANDOM, changeType: 'modified' })).rejects.toMatchObject({ code: 'invalid', message: '简报没有影响声明' });
    await expect(getMergePlan(t.db, editor, b.id)).rejects.toMatchObject({ code: 'invalid', message: '简报没有影响声明' });
    await expect(setDocumentCheckItemState(t.db, editor, b.id, 'prd_review', { state: 'passed' })).rejects.toMatchObject({ code: 'invalid', message: '简报没有检查项' });
    await expect(signDocumentCheckItem(t.db, editor, b.id, 'prd_review', { decision: 'passed' })).rejects.toMatchObject({ code: 'invalid', message: '简报没有检查项' });
    await expect(updateDocument(t.db, editor, b.id, { ownerMemberId: editor.memberId })).rejects.toMatchObject({
      code: 'invalid',
      message: '简报没有负责人，请改基本信息里的提出人、确认人或作者',
    });
    expect((await updateDocument(t.db, editor, b.id, { title: '简报一（改名）', ownerMemberId: null })).title).toBe('简报一（改名）');

    const saved = await saveDocumentContent(t.db, editor, b.id, { baseVersion: (await brief1()).version, markdown: `# 背景\n\n${mentionMarkup(viewer.memberId, '只读乙')} 请看` });
    expect(saved.version).toBeGreaterThan(b.version);
    const ev = await eventsOf(b.id, 'document.saved');
    expect(ev[ev.length - 1]!.payload).toMatchObject({ mentionedMemberIds: [viewer.memberId] });
  });

  it('再次提交内容相同的关联文档：不记 brief.updated（jsonb 键序不影响比较）', async () => {
    const b = await createBrief(t.db, editor, pan, { title: '键序简报' });
    const links = [{ kind: 'url' as const, url: 'https://doc.example.com/k', note: '说明' }, { kind: 'wiki' as const, target: 'PAN-PRD-9', note: '' }];
    await updateBrief(t.db, editor, b.id, { relatedLinks: links });
    await updateBrief(t.db, editor, b.id, { relatedLinks: links });
    await updateBrief(t.db, editor, b.id, { relatedLinks: [
        { note: '说明', url: 'https://doc.example.com/k', kind: 'url' as const },
        { note: '', target: 'PAN-PRD-9', kind: 'wiki' as const },
      ] });
    expect(await eventsOf(b.id, 'brief.updated')).toHaveLength(1);
  });
});
