import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { addDocumentComment } from '../src/documents/comments';
import { createDocument, saveDocumentContent } from '../src/documents/documents';
import { mentionMarkup } from '../src/links/syntax';
import { addRequirementComment } from '../src/requirements/comments';
import { createRequirement, updateRequirement } from '../src/requirements/requirements';
import { createTask } from '../src/tasks/tasks';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let b: Actor;
let productId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  a = await asMember(t.db, owner, '张三');
  b = await asMember(t.db, owner, '李四');
});
afterAll(() => t.cleanup());

async function payloadOf(type: string, subjectId: string): Promise<Record<string, unknown>> {
  const [row] = await t.adminDb
    .select({ payload: domainEvents.payload })
    .from(domainEvents)
    .where(and(eq(domainEvents.type, type), eq(domainEvents.subjectId, subjectId)))
    .orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id))
    .limit(1);
  return row!.payload;
}

describe('事件里的被 @ 成员与负责人', () => {
  it('新建需求：带负责人与描述里的被 @ 成员', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '登录页改版', ownerMemberId: a.memberId, description: `请 ${mentionMarkup(b.memberId, '李四')} 评估` });
    expect(await payloadOf('requirement.created', r.id)).toMatchObject({ ownerMemberId: a.memberId, mentionedMemberIds: [b.memberId] });
  });

  it('修改描述只记新增的被 @；只改标题时没有这个键', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '分享页', description: `先请 ${mentionMarkup(a.memberId, '张三')}` });
    await updateRequirement(t.db, owner, r.id, { description: `先请 ${mentionMarkup(a.memberId, '张三')}，再请 ${mentionMarkup(b.memberId, '李四')}` });
    expect(await payloadOf('requirement.updated', r.id)).toMatchObject({ mentionedMemberIds: [b.memberId] });
    await updateRequirement(t.db, owner, r.id, { title: '分享页 v2' });
    expect(await payloadOf('requirement.updated', r.id)).not.toHaveProperty('mentionedMemberIds');
  });

  it('需求评论与 PRD 评论：带评论里的被 @', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '下载' });
    await addRequirementComment(t.db, owner, r.id, { body: `${mentionMarkup(a.memberId, '张三')} 看下` });
    expect(await payloadOf('comment.created', r.id)).toMatchObject({ mentionedMemberIds: [a.memberId] });
    const doc = await createDocument(t.db, owner, productId, { title: '下载 PRD' });
    await addDocumentComment(t.db, owner, doc.id, { body: `${mentionMarkup(b.memberId, '李四')} 请确认` });
    expect(await payloadOf('comment.created', doc.id)).toMatchObject({ mentionedMemberIds: [b.memberId] });
  });

  it('PRD 正文保存：相对保存前的正文新增；新建 PRD 带负责人', async () => {
    const doc = await createDocument(t.db, owner, productId, { title: '上传 PRD', ownerMemberId: a.memberId });
    expect(await payloadOf('document.created', doc.id)).toMatchObject({ ownerMemberId: a.memberId });
    const first = await saveDocumentContent(t.db, owner, doc.id, { baseVersion: doc.version, markdown: `# 背景\n\n${mentionMarkup(a.memberId, '张三')} 负责` });
    expect(await payloadOf('document.saved', doc.id)).toMatchObject({ mentionedMemberIds: [a.memberId] });
    await saveDocumentContent(t.db, owner, doc.id, { baseVersion: first.version, markdown: `# 背景\n\n${mentionMarkup(a.memberId, '张三')} 负责，${mentionMarkup(b.memberId, '李四')} 配合` });
    expect(await payloadOf('document.saved', doc.id)).toMatchObject({ mentionedMemberIds: [b.memberId] });
  });

  it('新建任务：带被指派人', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '回收站' });
    const task = await createTask(t.db, owner, { requirementId: r.id, title: '接口', assigneeMemberId: b.memberId });
    expect(await payloadOf('task.created', task.id)).toMatchObject({ assigneeMemberId: b.memberId });
  });
});
