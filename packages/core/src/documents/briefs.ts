import { and, eq, isNull } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentBriefs, documents } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { memberNames } from '../requirements/context';
import { assertTitle } from '../requirements/requirements';
import { orgToday } from '../tasks/tasks';
import type { BriefRow } from './brief-header';
import { type DocumentDetail, documentDetailInTx, type DocumentRow, insertNativeDocumentTx } from './documents';
import { fillTemplate } from './markdown';
import { effectiveTemplates, loadUsableTemplate } from './templates';

/** 取简报文档与头部（lock 时两行都 FOR UPDATE）；不是简报、已删除或没有头部时按「简报不存在」处理。 */
export async function loadBriefTx(tx: Tx, id: string, opts: { lock?: boolean } = {}): Promise<{ doc: DocumentRow; header: BriefRow }> {
  const dq = tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.kind, 'brief'), isNull(documents.deletedAt)));
  const [doc] = opts.lock ? await dq.for('update') : await dq;
  if (!doc) throw new AppError('not_found', '简报不存在');
  const hq = tx.select().from(documentBriefs).where(eq(documentBriefs.documentId, id));
  const [header] = opts.lock ? await hq.for('update') : await hq;
  if (!header) throw new AppError('not_found', '简报不存在');
  return { doc, header };
}

/** 简报所在产品的角色：看不到时按「简报不存在」处理，不够时 forbidden。 */
export async function briefRoleTx(tx: Tx, actor: Actor, doc: DocumentRow, need: ProductRole): Promise<ProductRole> {
  const role = await productRoleOf(tx, actor, doc.productId);
  if (!role) throw new AppError('not_found', '简报不存在');
  if (!atLeast(role, need)) throw new AppError('forbidden', '权限不足');
  return role;
}

/**
 * 新建简报：产品编辑及以上。没有指定模板时用产品可用的第一份简报模板（没有时为空白正文）；作者为创建人；状态讨论中。
 */
export async function createBrief(db: Db, actor: Actor, productId: string, input: { title: string; templateId?: string | null }): Promise<DocumentDetail> {
  const title = assertTitle(input.title);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'editor');
    const tpl = input.templateId ? await loadUsableTemplate(tx, productId, input.templateId, 'brief') : ((await effectiveTemplates(tx, productId, 'brief'))[0] ?? null);
    const names = await memberNames(tx, [actor.memberId]);
    const markdown = tpl ? fillTemplate(tpl.body, { date: await orgToday(tx, actor.orgId), author: names.get(actor.memberId) ?? '' }) : '';
    const doc = await insertNativeDocumentTx(tx, actor, { productId, kind: 'brief', title, status: 'discussing', ownerMemberId: null, templateId: tpl?.id ?? null, markdown, summary: null });
    await tx.insert(documentBriefs).values({ documentId: doc.id, orgId: actor.orgId, authorMemberId: actor.memberId });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'brief.created',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { number: doc.number, title, templateId: doc.templateId, authorMemberId: actor.memberId },
    });
    return documentDetailInTx(tx, actor, doc.id);
  });
}
