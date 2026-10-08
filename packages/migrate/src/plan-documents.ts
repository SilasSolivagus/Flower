import { createHash } from 'node:crypto';
import { type CheckState, type DocumentStatus, PRESET_TEMPLATE, prdCheckState } from '@flower/core';
import type { PrdPage } from './legacy-types';
import type { PlanContext } from './plan-types';

/** prd 系统的 prd_meta.status → 变更 PRD 状态（设计 §6）。 */
export const PRD_PAGE_STATUS: Record<string, DocumentStatus> = { draft: 'draft', review: 'review', approved: 'approved', in_dev: 'approved', launched: 'launched' };
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const FILE_REF = /\/api\/files\/([0-9a-f-]{36}\.[a-z]+)/g;
const DATA_IMAGE = /data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)/g;
const REMOTE_IMAGE = /!\[[^\]]*\]\(https?:\/\//g;
const RELATIVE_IMAGE = /!\[[^\]]*\]\((?!https?:\/\/|\/|data:)[^)]+\)/g;

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
    const inline = new Map<string, string>();
    const rewrite = (markdown: string): string =>
      markdown
        .replace(FILE_REF, (all, key: string) => {
          const att = legacyAttachmentId.get(key);
          return att ? attachmentUrl(ctx, att) : all;
        })
        .replace(DATA_IMAGE, (_all, mime: string, base64: string) => {
          const sha = createHash('sha1').update(base64).digest('hex');
          let attId = inline.get(sha);
          if (!attId) {
            attId = ctx.id('attachment', `inline:${p.id}:${sha}`);
            inline.set(sha, attId);
            const storageKey = `${orgId}/${attId}.${IMAGE_EXT[mime]}`;
            rows.attachments.push({
              id: attId,
              orgId,
              targetType: 'document',
              targetId: id,
              storageKey,
              filename: `inline-${sha.slice(0, 8)}.${IMAGE_EXT[mime]}`,
              mime,
              sizeBytes: Buffer.from(base64, 'base64').byteLength,
              width: null,
              height: null,
              uploaderMemberId: member(p.created_by),
              createdAt: ctx.time(p.created_at),
            });
            ctx.files.push({ storageKey, from: { base64 } });
            docs.inlineImages += 1;
          }
          return attachmentUrl(ctx, attId);
        });

    // 旧附件：先于内嵌图片登记，报告与文件列表里顺序稳定
    for (const a of prd.attachments.filter((x) => x.page_id === p.id)) {
      const attId = legacyAttachmentId.get(a.storage_key)!;
      const ext = IMAGE_EXT[a.mime];
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
      if (ctx.opts.availableUploads && !ctx.opts.availableUploads.has(a.storage_key)) docs.missingFiles = (docs.missingFiles ?? 0) + 1;
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
