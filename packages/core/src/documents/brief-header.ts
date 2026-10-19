import { and, eq, inArray, isNull } from 'drizzle-orm';
import { documentBriefs, documents, functionTags, products } from '../db/schema';
import type { Tx } from '../db/tx';
import { memberNames } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import type { BriefRelatedLink, DocumentStatus } from './constants';
import { documentKeyOf } from './markdown';

export type BriefRow = typeof documentBriefs.$inferSelect;
export type BriefHeader = {
  version: string;
  requester: MemberRef | null;
  decider: MemberRef | null;
  author: MemberRef | null;
  /** 已删除的职能标签不再显示。 */
  participantTags: Array<{ id: string; name: string; color: string }>;
  relatedLinks: BriefRelatedLink[];
  /** 最近一次转出的变更 PRD（已删除时为空）。 */
  convertedDocument: { id: string; displayKey: string; title: string; status: DocumentStatus } | null;
};

/** 简报头部信息的显示形式：成员取当前姓名，标签取当前名称与颜色。 */
export async function briefHeaderTx(tx: Tx, h: BriefRow): Promise<BriefHeader> {
  const names = await memberNames(tx, [h.requesterMemberId, h.deciderMemberId, h.authorMemberId]);
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  const tags = h.participantTagIds.length > 0 ? await tx.select().from(functionTags).where(inArray(functionTags.id, h.participantTagIds)) : [];
  const tagOf = new Map(tags.map((x) => [x.id, x]));
  const [conv] = h.convertedDocumentId
    ? await tx
        .select({ d: documents, key: products.key })
        .from(documents)
        .innerJoin(products, eq(products.id, documents.productId))
        .where(and(eq(documents.id, h.convertedDocumentId), isNull(documents.deletedAt)))
    : [];
  return {
    version: h.version,
    requester: ref(h.requesterMemberId),
    decider: ref(h.deciderMemberId),
    author: ref(h.authorMemberId),
    participantTags: h.participantTagIds.flatMap((id) => {
      const x = tagOf.get(id);
      return x ? [{ id: x.id, name: x.name, color: x.color }] : [];
    }),
    relatedLinks: h.relatedLinks,
    convertedDocument: conv ? { id: conv.d.id, displayKey: documentKeyOf(conv.d.kind, conv.key, conv.d.number), title: conv.d.title, status: conv.d.status } : null,
  };
}
