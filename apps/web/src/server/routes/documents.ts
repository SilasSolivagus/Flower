import {
  addDocumentComment,
  AppError,
  CHECK_STATES,
  convertExternalDocument,
  createDocument,
  diffRevisions,
  DOCUMENT_STATUSES,
  getDocumentByKey,
  getRevision,
  IMAGE_MAX_BYTES,
  linkDocumentRequirements,
  listDocumentComments,
  listDocumentReviewQueue,
  listDocuments,
  listRevisions,
  readAttachment,
  restoreRevision,
  saveDocumentContent,
  setDocumentCheckItemState,
  setDocumentCommentResolved,
  signDocumentCheckItem,
  transitionDocument,
  unlinkDocumentRequirement,
  updateDocument,
  uploadDocumentImage,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { csvParam as csv, readJson, readUpload } from '../http';

const positiveInt = (v: string | undefined, message: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new AppError('invalid', message);
  return n;
};

const listQuery = z.object({
  statuses: z.array(z.enum(DOCUMENT_STATUSES)).optional(),
  source: z.enum(['native', 'external']).optional(),
});

const anchorSchema = z.object({ quote: z.string().max(500), prefix: z.string().max(200).optional(), suffix: z.string().max(200).optional() });

export function registerDocumentRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/documents', async (c) => {
    const q = listQuery.safeParse({ statuses: csv(c.req.query('status')), source: c.req.query('source') || undefined });
    if (!q.success) throw new AppError('invalid', '筛选条件无效');
    const documents = await listDocuments(deps.db, c.get('actor'), c.req.param('id'), {
      statuses: q.data.statuses,
      source: q.data.source,
      ownerIds: csv(c.req.query('owner')),
      q: c.req.query('q') || undefined,
    });
    return c.json({ documents });
  });

  app.post('/orgs/:org/products/:id/documents', async (c) => {
    const body = await readJson(
      c,
      z.object({
        title: z.string(),
        ownerMemberId: z.string().nullable().optional(),
        templateId: z.string().nullable().optional(),
        externalUrl: z.string().max(2000).nullable().optional(),
        requirementIds: z.array(z.string()).max(200).optional(),
      }),
    );
    return c.json({ document: await createDocument(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.get('/orgs/:org/documents/:key', async (c) => c.json({ document: await getDocumentByKey(deps.db, c.get('actor'), c.req.param('key')) }));

  app.patch('/orgs/:org/documents/:id', async (c) => {
    const body = await readJson(c, z.object({ title: z.string().optional(), ownerMemberId: z.string().nullable().optional(), externalUrl: z.string().max(2000).optional() }));
    return c.json({ document: await updateDocument(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.put('/orgs/:org/documents/:id/content', async (c) => {
    const body = await readJson(c, z.object({ baseVersion: z.number().int(), markdown: z.string(), title: z.string().optional() }));
    return c.json(await saveDocumentContent(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.post('/orgs/:org/documents/:id/convert', async (c) => {
    const body = await readJson(c, z.object({ baseVersion: z.number().int(), markdown: z.string() }));
    return c.json(await convertExternalDocument(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.post('/orgs/:org/documents/:id/transitions', async (c) => {
    const body = await readJson(c, z.object({ to: z.enum(DOCUMENT_STATUSES) }));
    return c.json({ document: await transitionDocument(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.get('/orgs/:org/documents/:id/revisions', async (c) => c.json({ revisions: await listRevisions(deps.db, c.get('actor'), c.req.param('id')) }));

  app.get('/orgs/:org/documents/:id/revisions/:number', async (c) =>
    c.json({ revision: await getRevision(deps.db, c.get('actor'), c.req.param('id'), positiveInt(c.req.param('number'), '版本号无效')) }),
  );

  app.get('/orgs/:org/documents/:id/diff', async (c) => {
    const from = positiveInt(c.req.query('from'), '版本号无效');
    const to = positiveInt(c.req.query('to'), '版本号无效');
    return c.json({ diff: await diffRevisions(deps.db, c.get('actor'), c.req.param('id'), { from, to }) });
  });

  app.post('/orgs/:org/documents/:id/restore', async (c) => {
    const body = await readJson(c, z.object({ number: z.number().int().min(1), baseVersion: z.number().int() }));
    return c.json(await restoreRevision(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.post('/orgs/:org/documents/:id/requirements', async (c) => {
    const body = await readJson(c, z.object({ requirementIds: z.array(z.string()).min(1).max(200) }));
    return c.json(await linkDocumentRequirements(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.delete('/orgs/:org/documents/:id/requirements/:requirementId', async (c) => {
    await unlinkDocumentRequirement(deps.db, c.get('actor'), c.req.param('id'), c.req.param('requirementId'));
    return c.body(null, 204);
  });

  app.get('/orgs/:org/documents/:id/comments', async (c) => c.json({ comments: await listDocumentComments(deps.db, c.get('actor'), c.req.param('id')) }));

  app.post('/orgs/:org/documents/:id/comments', async (c) => {
    const body = await readJson(c, z.object({ body: z.string().max(10_000), parentId: z.string().nullable().optional(), anchor: anchorSchema.nullable().optional() }));
    return c.json({ comment: await addDocumentComment(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.post('/orgs/:org/document-comments/:id/resolve', async (c) => {
    const body = await readJson(c, z.object({ resolved: z.boolean() }));
    return c.json({ comment: await setDocumentCommentResolved(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.put('/orgs/:org/documents/:id/checks/:itemKey', async (c) => {
    const body = await readJson(c, z.object({ state: z.enum(CHECK_STATES), note: z.string().max(2000).nullable().optional() }));
    return c.json(await setDocumentCheckItemState(deps.db, c.get('actor'), c.req.param('id'), c.req.param('itemKey'), body));
  });

  app.post('/orgs/:org/documents/:id/checks/:itemKey/signoffs', async (c) => {
    const body = await readJson(
      c,
      z.object({
        decision: z.enum(['passed', 'rejected']),
        note: z.string().max(2000).nullable().optional(),
        ruleIndex: z.number().int().min(0).optional(),
        onBehalf: z.boolean().optional(),
      }),
    );
    return c.json(await signDocumentCheckItem(deps.db, c.get('actor'), c.req.param('id'), c.req.param('itemKey'), body), 201);
  });

  app.get('/orgs/:org/products/:id/document-reviews', async (c) => c.json({ queue: await listDocumentReviewQueue(deps.db, c.get('actor'), c.req.param('id')) }));

  app.post('/orgs/:org/documents/:id/attachments', async (c) => {
    const file = await readUpload(c, IMAGE_MAX_BYTES, '图片不能超过 10 MB');
    const attachment = await uploadDocumentImage(deps.db, c.get('actor'), { documentId: c.req.param('id'), ...file, storage: deps.storage });
    return c.json({ attachment: { ...attachment, url: `/api/v1/orgs/${c.req.param('org')}/attachments/${attachment.id}` } }, 201);
  });

  app.get('/orgs/:org/attachments/:id', async (c) => {
    const f = await readAttachment(deps.db, c.get('actor'), { attachmentId: c.req.param('id'), storage: deps.storage });
    return c.body(new Uint8Array(f.bytes), 200, {
      'content-type': f.mime,
      'content-length': String(f.bytes.byteLength),
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    });
  });
}
