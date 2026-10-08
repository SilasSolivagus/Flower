import { and, eq, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { attachments, documents } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { newId } from '../ids';
import type { FileStorage } from '../storage';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as const;
export type ImageMime = keyof typeof IMAGE_TYPES;
export type AttachmentView = { id: string; filename: string; mime: string; sizeBytes: number };

/** 按文件头字节判断图片类型，不信任客户端声明的类型；SVG 等可携带脚本的格式一律返回 null。 */
export function sniffImage(b: Uint8Array): ImageMime | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

export async function uploadDocumentImage(
  db: Db,
  actor: Actor,
  input: { documentId: string; filename: string; bytes: Uint8Array; storage: FileStorage },
): Promise<AttachmentView> {
  if (input.bytes.byteLength > IMAGE_MAX_BYTES) throw new AppError('invalid', '图片不能超过 10 MB');
  const mime = sniffImage(input.bytes);
  if (!mime) throw new AppError('invalid', '只支持 PNG、JPEG、GIF、WebP 图片');
  const filename = (input.filename.trim() || 'image').slice(0, 200);
  return withOrg(db, actor.orgId, async (tx) => {
    const [doc] = await tx
      .select({ id: documents.id, productId: documents.productId })
      .from(documents)
      .where(and(eq(documents.id, input.documentId), isNull(documents.deletedAt)));
    if (!doc) throw new AppError('not_found', 'PRD 不存在');
    await requireProductRole(tx, actor, doc.productId, 'editor');
    const id = newId();
    const storageKey = `${actor.orgId}/${id}.${IMAGE_TYPES[mime]}`;
    // 先写文件再入库：事务回滚时只留下一个没有引用的文件，不会出现有记录没文件
    await input.storage.put(storageKey, input.bytes);
    await tx.insert(attachments).values({ id, orgId: actor.orgId, targetType: 'document', targetId: doc.id, storageKey, filename, mime, sizeBytes: input.bytes.byteLength, uploaderMemberId: actor.memberId });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'attachment.uploaded',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { attachmentId: id, filename, mime, sizeBytes: input.bytes.byteLength, changes: [{ field: 'attachment', old: null, new: filename }] },
    });
    return { id, filename, mime, sizeBytes: input.bytes.byteLength };
  });
}

export async function readAttachment(db: Db, actor: Actor, input: { attachmentId: string; storage: FileStorage }): Promise<{ mime: string; filename: string; bytes: Uint8Array }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [att] = await tx.select().from(attachments).where(eq(attachments.id, input.attachmentId));
    if (!att) throw new AppError('not_found', '附件不存在');
    const [doc] = await tx.select({ productId: documents.productId }).from(documents).where(eq(documents.id, att.targetId));
    if (!doc) throw new AppError('not_found', '附件不存在');
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const bytes = await input.storage.get(att.storageKey);
    if (!bytes) throw new AppError('not_found', '附件文件不存在');
    return { mime: att.mime, filename: att.filename, bytes };
  });
}
