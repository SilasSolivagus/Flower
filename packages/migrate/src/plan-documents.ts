import { createHash } from 'node:crypto';
import path from 'node:path';
import { type CheckState, type DocumentStatus, IMAGE_MAX_BYTES, IMAGE_TYPES, type ImageMime, PRESET_TEMPLATE, prdCheckState, sniffImage } from '@flower/core';
import type { PrdPage } from './legacy-types';
import type { PlanContext } from './plan-types';

/** prd 系统的 prd_meta.status → 变更 PRD 状态（设计 §6）。 */
export const PRD_PAGE_STATUS: Record<string, DocumentStatus> = { draft: 'draft', review: 'review', approved: 'approved', in_dev: 'approved', launched: 'launched' };
const FILE_REF = /\/api\/files\/([0-9a-f-]{36}\.[a-z]+)/g;
/** 内嵌图片：带不带 `![…](…)` 外壳都匹配，不能抽出时连外壳一起换成占位文字。 */
const DATA_IMAGE = /(!\[[^\]]*\]\()?data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)(\))?/g;
export const DROPPED_IMAGE = '[图片未迁移]';
const REMOTE_IMAGE = /!\[[^\]]*\]\(https?:\/\//g;
const RELATIVE_IMAGE = /!\[[^\]]*\]\((?!https?:\/\/|\/|data:)[^)]+\)/g;

/** 判断图片字节能否作为附件导入（与应用上传的约束一致）：按内容嗅探类型，需与声明的类型相同，且不超过 10 MB。 */
export function checkImage(bytes: Uint8Array, declared: string): string | null {
  const sniffed = sniffImage(bytes);
  if (!sniffed) return '不是支持的图片格式（只支持 PNG、JPEG、GIF、WebP）';
  if (sniffed !== declared) return `声明的类型 ${declared} 与内容（${sniffed}）不符`;
  if (bytes.byteLength > IMAGE_MAX_BYTES) return '超过 10 MB';
  return null;
}

/** 旧附件文件在导出目录里的路径；键为绝对路径或会跳出导出目录时返回 null，不读取。 */
export function resolveUpload(dir: string, key: string): string | null {
  if (!key || path.isAbsolute(key)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, key);
  const rel = path.relative(root, full);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? full : null;
}

export const attachmentUrl = (ctx: PlanContext, id: string): string => `/api/v1/orgs/${ctx.opts.orgSlug}/attachments/${id}`;

const byCreated = <T extends { created_at: string; id: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

export function buildDocumentTemplates(ctx: PlanContext): void {
  ctx.rows.documentTemplates.push({
    id: ctx.id('template', 'preset'),
    orgId: ctx.orgId,
    productId: null,
    kind: 'change',
    name: PRESET_TEMPLATE.name,
    body: PRESET_TEMPLATE.body,
    sections: PRESET_TEMPLATE.sections,
    active: true,
    createdAt: ctx.asOfTime,
    updatedAt: ctx.asOfTime,
  });
}

/** 需求挂到 PRD 上，「PRD」检查项按 PRD 状态改写（设计 §3 映射）；改写前后不同的记入对账报告。 */
export function coverRequirement(ctx: PlanContext, requirementId: string, documentId: string, status: DocumentStatus, documentKey: string): void {
  const req = ctx.rows.requirements.find((r) => r.id === requirementId)!;
  req.changeDocumentId = documentId;
  const state: CheckState = prdCheckState(status);
  const existing = ctx.rows.checkItemResults.find((c) => c.targetType === 'requirement' && c.targetId === requirementId && c.itemKey === 'prd');
  const old = existing?.state ?? 'not_started';
  if (existing) existing.state = state;
  else {
    ctx.rows.checkItemResults.push({
      id: ctx.id('check', `${requirementId}:prd`),
      orgId: ctx.orgId,
      targetType: 'requirement',
      targetId: requirementId,
      itemKey: 'prd',
      state,
      note: null,
      meta: {},
      updatedBy: null,
      updatedAt: ctx.asOfTime,
    });
  }
  if (old !== state) ctx.report.documents.prdCheckChanges.push({ displayKey: `${ctx.opts.productKey}-${req.number}`, document: documentKey, from: old, to: state });
}

/** prd 系统未删除的页面 → Flower 内的变更 PRD，连同修订、附件（含内嵌图片）、评论与需求关联。 */
export function buildPrdDocuments(ctx: PlanContext): void {
  const { data, rows, orgId, productId, report } = ctx;
  const prd = data.prd;
  const userById = new Map(prd.users.map((u) => [u.id, u]));
  const member = (userId: string | null): string | null => {
    if (!userId) return null;
    const u = userById.get(userId);
    if (!u) {
      ctx.problem(`prd 用户 ${userId} 不在 users 表中`);
      return null;
    }
    return ctx.resolver.personPeek(u.email) ? ctx.memberId(u.email) : ctx.memberId(u.name ?? u.email);
  };
  const legacyAttachmentId = new Map(prd.attachments.map((a) => [a.storage_key, ctx.id('attachment', `prd:${a.id}`)]));
  const pages = [...prd.pages].sort(byCreated);
  const docs = report.documents;

  pages.forEach((p: PrdPage, index) => {
    const number = index + 1;
    const id = ctx.id('document', `prd:${p.id}`);
    const documentKey = `${ctx.opts.productKey}-PRD-${number}`;
    const status = PRD_PAGE_STATUS[p.status ?? ''];
    if (!status) {
      ctx.problem(`prd 页面状态「${p.status}」没有对应的 PRD 状态`);
      return;
    }
    const inline = new Map<string, { dropped: true } | { dropped: false; attId: string }>();
    const rewrite = (markdown: string): string =>
      markdown
        .replace(FILE_REF, (all, key: string) => {
          const att = legacyAttachmentId.get(key);
          return att ? attachmentUrl(ctx, att) : all;
        })
        .replace(DATA_IMAGE, (_all, open: string | undefined, mime: string, base64: string, close: string | undefined) => {
          const sha = createHash('sha1').update(base64).digest('hex');
          let result = inline.get(sha);
          if (!result) {
            const bytes = Buffer.from(base64, 'base64');
            const reason = checkImage(bytes, mime);
            if (reason) {
              result = { dropped: true };
              docs.droppedImages.push({ document: documentKey, reason });
            } else {
              const attId = ctx.id('attachment', `inline:${p.id}:${sha}`);
              result = { dropped: false, attId };
              const storageKey = `${orgId}/${attId}.${IMAGE_TYPES[mime as ImageMime]}`;
              rows.attachments.push({
                id: attId,
                orgId,
                targetType: 'document',
                targetId: id,
                storageKey,
                filename: `inline-${sha.slice(0, 8)}.${IMAGE_TYPES[mime as ImageMime]}`,
                mime,
                sizeBytes: bytes.byteLength,
                width: null,
                height: null,
                uploaderMemberId: member(p.created_by),
                createdAt: ctx.time(p.created_at),
              });
              ctx.files.push({ storageKey, from: { base64 } });
              docs.inlineImages += 1;
            }
            inline.set(sha, result);
          }
          if (result.dropped) return open && close ? DROPPED_IMAGE : `${open ?? ''}${DROPPED_IMAGE}${close ?? ''}`;
          return `${open ?? ''}${attachmentUrl(ctx, result.attId)}${close ?? ''}`;
        });

    // 旧附件：先于内嵌图片登记，报告与文件列表里顺序稳定
    for (const a of prd.attachments.filter((x) => x.page_id === p.id)) {
      const attId = legacyAttachmentId.get(a.storage_key)!;
      const ext = a.mime in IMAGE_TYPES ? IMAGE_TYPES[a.mime as ImageMime] : null;
      if (!ext) {
        ctx.problem(`prd 附件类型「${a.mime}」不是支持的图片类型`);
        continue;
      }
      const storageKey = `${orgId}/${attId}.${ext}`;
      rows.attachments.push({
        id: attId,
        orgId,
        targetType: 'document',
        targetId: id,
        storageKey,
        filename: a.filename,
        mime: a.mime,
        sizeBytes: a.size_bytes,
        width: a.width,
        height: a.height,
        uploaderMemberId: member(a.uploader_id),
        createdAt: ctx.time(a.created_at),
      });
      ctx.files.push({ storageKey, from: { legacyKey: a.storage_key } });
      docs.attachments += 1;
      if (!resolveUpload('/uploads', a.storage_key)) docs.invalidFileKeys += 1;
      else if (ctx.opts.availableUploads && !ctx.opts.availableUploads.has(a.storage_key)) docs.missingFiles = (docs.missingFiles ?? 0) + 1;
    }

    const snaps = prd.pageVersions
      .filter((v) => v.page_id === p.id)
      .sort((a, b) => a.version - b.version)
      .map((v) => ({ title: v.title, markdown: rewrite(v.markdown), summary: v.diff_summary?.trim() || null, author: member(v.author_id), at: ctx.time(v.created_at) }));
    const current = { title: p.title, markdown: rewrite(p.markdown) };
    const last = snaps.at(-1);
    if (!last || last.title !== current.title || last.markdown !== current.markdown) {
      snaps.push({ ...current, summary: '迁移时的当前内容', author: member(p.updated_by), at: ctx.time(p.updated_at) });
    }
    snaps.forEach((s, j) =>
      rows.documentRevisions.push({
        id: ctx.id('revision', `prd:${p.id}:${j + 1}`),
        orgId,
        documentId: id,
        version: j + 1,
        snapshot: { title: s.title, markdown: s.markdown },
        summary: s.summary,
        authorMemberId: s.author,
        createdAt: s.at,
        updatedAt: s.at,
      }),
    );
    docs.revisions += snaps.length;
    docs.externalImages += [...current.markdown.matchAll(REMOTE_IMAGE)].length;
    docs.brokenImageRefs += [...current.markdown.matchAll(RELATIVE_IMAGE)].length;

    rows.documents.push({
      id,
      orgId,
      productId,
      number,
      kind: 'change',
      source: 'native',
      title: p.title.trim() || '（无标题）',
      ownerMemberId: member(p.owner_user_id ?? p.created_by),
      templateId: null,
      status,
      currentRevisionId: ctx.id('revision', `prd:${p.id}:${snaps.length}`),
      externalUrl: null,
      externalUrlKey: null,
      externalProvider: null,
      version: snaps.length,
      legacyKey: `prd:${p.id}`,
      createdBy: member(p.created_by),
      createdAt: ctx.time(p.created_at),
      updatedAt: ctx.time(p.updated_at),
    });
    docs.pages += 1;

    const pageComments = prd.comments.filter((c) => c.page_id === p.id).sort(byCreated);
    const commentIds = new Set(pageComments.map((c) => c.id));
    for (const c of pageComments) {
      if (c.parent_comment_id && !commentIds.has(c.parent_comment_id)) ctx.problem(`prd 评论 ${c.id} 的上级评论不在同一页面`);
      rows.comments.push({
        id: ctx.id('comment', `prd:${c.id}`),
        orgId,
        targetType: 'document',
        targetId: id,
        parentId: c.parent_comment_id ? ctx.id('comment', `prd:${c.parent_comment_id}`) : null,
        authorMemberId: member(c.author_id),
        body: c.body_markdown,
        kind: 'comment',
        anchor: null,
        anchorState: 'unanchored',
        resolvedAt: c.resolved_at ? ctx.time(c.resolved_at) : null,
        resolvedBy: member(c.resolved_by),
        createdAt: ctx.time(c.created_at),
      });
      docs.comments += 1;
    }

    const linked = p.linked_requirement_id?.trim();
    if (linked) {
      const requirementId = ctx.id('req', `plane:${linked}`);
      if (!rows.requirements.some((r) => r.id === requirementId)) docs.unmatchedLinks.push({ document: documentKey, requirement: linked });
      else {
        coverRequirement(ctx, requirementId, id, status, documentKey);
        docs.linkedRequirements += 1;
      }
    }
  });
  rows.products[0]!.documentSeq = Math.max(0, ...rows.documents.map((d) => d.number));
}
