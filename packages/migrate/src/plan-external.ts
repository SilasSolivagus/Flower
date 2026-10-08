import { documentDisplayKey, type DocumentStatus, type ExternalProvider, normalizeExternalUrl } from '@flower/core';
import type { PlaneRequirement } from './legacy-types';
import { coverRequirement } from './plan-documents';
import type { PlanContext } from './plan-types';

/** 123plane prd_status → 外部 PRD 状态的候选；not-needed 不参与推导（设计决定「外部 PRD 迁移的状态推导」）。 */
export const PLANE_PRD_STATUS_TO_DOCUMENT: Record<string, 'draft' | 'review' | 'approved' | null> = {
  approved: 'approved',
  submitted: 'review',
  'in-progress': 'draft',
  'not-started': 'draft',
  'not-needed': null,
};
const RANK = { draft: 1, review: 2, approved: 3 } as const;

export function deriveExternalStatus(uses: Array<{ prdStatus: string | null; stateKey: string }>): DocumentStatus {
  let best = 0;
  for (const u of uses) {
    const s = u.prdStatus ? PLANE_PRD_STATUS_TO_DOCUMENT[u.prdStatus] : null;
    if (s) best = Math.max(best, RANK[s]);
  }
  const status: DocumentStatus = best === 3 ? 'approved' : best === 2 ? 'review' : 'draft';
  return status === 'approved' && uses.every((u) => u.stateKey === 'launched') ? 'launched' : status;
}

type Use = { requirementId: string; number: number; plane: PlaneRequirement | null; url: string; provider: ExternalProvider };

/**
 * 123plane prd_link 与 push prd_url → 外部 PRD：按规范化网址去重，每个网址一份，挂到所有用到它的需求上。
 * 一条需求两边都有时以 123plane 为准；已挂 prd 系统页面的需求不再挂外部 PRD。编号接在 prd 页面的最大编号之后。
 */
export function buildExternalDocuments(ctx: PlanContext): void {
  const { rows, orgId, productId, data } = ctx;
  const ext = ctx.report.documents.external;
  const groups = new Map<string, Use[]>();
  for (const src of ctx.requirementSources) {
    const displayKey = `${ctx.opts.productKey}-${src.number}`;
    const rawPlane = src.plane?.prd_link?.trim() || null;
    const rawPush = src.push?.prd_url?.trim() || null;
    const plane = rawPlane ? normalizeExternalUrl(rawPlane) : null;
    const push = rawPush ? normalizeExternalUrl(rawPush) : null;
    if (rawPlane && !plane) ext.nonUrl.push({ displayKey, source: '123plane', value: rawPlane });
    if (rawPush && !push) ext.nonUrl.push({ displayKey, source: 'push', value: rawPush });
    if (plane && push && plane.key !== push.key) ext.mismatches.push({ displayKey, plane: plane.url, push: push.url });
    const chosen = plane ?? push;
    if (!chosen) continue;
    const prdStatus = src.plane?.prd_status ?? null;
    if (prdStatus && !(prdStatus in PLANE_PRD_STATUS_TO_DOCUMENT)) ctx.problem(`123plane PRD 状态「${prdStatus}」没有对应的外部 PRD 状态`);
    const req = rows.requirements.find((r) => r.id === src.id)!;
    if (req.changeDocumentId) {
      ext.skippedNative.push({ displayKey, url: chosen.url });
      continue;
    }
    const list = groups.get(chosen.key) ?? [];
    list.push({ requirementId: src.id, number: src.number, plane: src.plane, url: chosen.url, provider: chosen.provider });
    groups.set(chosen.key, list);
  }
  for (const p of data.push.requirements) {
    if (p.merged_into === null || !p.prd_url?.trim()) continue;
    const n = normalizeExternalUrl(p.prd_url);
    if (n && !groups.has(n.key)) ext.mergedOnly += 1;
  }

  let number = Math.max(0, ...rows.documents.map((d) => d.number));
  const ordered = [...groups.entries()].sort(([, a], [, b]) => Math.min(...a.map((u) => u.number)) - Math.min(...b.map((u) => u.number)));
  for (const [key, uses] of ordered) {
    uses.sort((a, b) => a.number - b.number);
    const reqs = uses.map((u) => rows.requirements.find((r) => r.id === u.requirementId)!);
    const first = reqs[0]!;
    const status = deriveExternalStatus(uses.map((u, i) => ({ prdStatus: u.plane?.prd_status ?? null, stateKey: reqs[i]!.stateKey })));
    number += 1;
    const id = ctx.id('document', `ext:${key}`);
    const createdAt = reqs.map((r) => r.createdAt ?? ctx.asOfTime).reduce((a, b) => (a < b ? a : b));
    rows.documents.push({
      id,
      orgId,
      productId,
      number,
      kind: 'change',
      source: 'external',
      title: first.title,
      ownerMemberId: first.ownerMemberId ?? null,
      templateId: null,
      status,
      currentRevisionId: null,
      externalUrl: uses[0]!.url,
      externalUrlKey: key,
      externalProvider: uses[0]!.provider,
      version: 1,
      legacyKey: `ext:${key}`,
      createdBy: null,
      createdAt,
      updatedAt: ctx.asOfTime,
    });
    const documentKey = documentDisplayKey(ctx.opts.productKey, number);
    for (const u of uses) coverRequirement(ctx, u.requirementId, id, status, documentKey);
    ext.docs += 1;
    ext.requirements += uses.length;
    if (uses.length > 1) ext.shared += 1;
    ext.statusCounts[status] = (ext.statusCounts[status] ?? 0) + 1;
  }
  rows.products[0]!.documentSeq = number;
}
