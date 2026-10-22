import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documents, memberNotifications } from '../src/db/schema';
import { DELETED_DOCUMENT_MESSAGE, getDocumentByKey } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createDocument } from '../src/documents/documents';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let outsider: Actor;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  outsider = await asMember(t.db, owner, '外人', 'guest');
});
afterAll(() => t.cleanup());

describe('已删除文档', () => {
  it('看得到产品的人得到失效说明，看不到产品的人仍是不存在', async () => {
    const pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
    await setProductRole(t.db, owner, pan, outsider.memberId, null);
    const doc = await createDocument(t.db, owner, pan, { title: '将被删除' });
    await t.adminDb.insert(memberNotifications).values({
      orgId: owner.orgId,
      memberId: owner.memberId,
      kind: 'system_alert',
      subjectType: 'document',
      subjectId: doc.id,
      title: `${doc.displayKey} 将被删除`,
      body: '文档已删除',
      url: `/acme/documents/${doc.displayKey}`,
    });
    await t.adminDb.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, doc.id));
    await expect(getDocumentByKey(t.db, owner, doc.displayKey)).rejects.toMatchObject({ code: 'not_found', message: DELETED_DOCUMENT_MESSAGE });
    await expect(getDocumentByKey(t.db, outsider, doc.displayKey)).rejects.toMatchObject({ code: 'not_found', message: 'PRD 不存在' });
  });
});
