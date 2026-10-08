import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom, upload } from './helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let viewerSession: string;
let readToken: string;
let productId: string;

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'viewer@example.com', orgRole: 'member' } });
  const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '只读乙', password: 'password123' } });
  viewerSession = sessionFrom(accept.res);
  const viewerId = (await call(app, 'GET', '/orgs/acme', { session: viewerSession })).body.me.memberId;
  await call(app, 'PUT', `/orgs/acme/products/${productId}/roles/${viewerId}`, { session, body: { role: 'viewer' } });
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me.memberId, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
});
afterAll(() => cleanup());

describe('PRD 接口', () => {
  it('新建、按编号读取、保存、冲突、修订、对比、恢复、流转', async () => {
    const preset = (await call(app, 'GET', `/orgs/acme/templates?product=${productId}&usable=1`, { session })).body.templates[0];
    const created = await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '上传 PRD', templateId: preset.id } });
    expect(created.status).toBe(201);
    const doc = created.body.document;
    expect(doc).toMatchObject({ displayKey: 'PAN-PRD-1', source: 'native', version: 1 });
    expect((await call(app, 'GET', '/orgs/acme/documents/PAN-PRD-1', { session: viewerSession })).body.document.myRole).toBe('viewer');

    const saved = await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { session, body: { baseVersion: 1, markdown: '## 背景\n\n第一稿' } });
    expect(saved.body).toEqual({ version: 2, revisionNumber: 1, merged: true });
    const stale = await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { session, body: { baseVersion: 1, markdown: 'x' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ message: '文档已被其他人修改，请重新加载后再编辑', details: { version: 2 } });

    const revisions = await call(app, 'GET', `/orgs/acme/documents/${doc.id}/revisions`, { session: viewerSession });
    expect(revisions.body.revisions.map((r: { number: number }) => r.number)).toEqual([1]);
    expect((await call(app, 'GET', `/orgs/acme/documents/${doc.id}/revisions/1`, { session })).body.revision.markdown).toBe('## 背景\n\n第一稿');
    expect((await call(app, 'GET', `/orgs/acme/documents/${doc.id}/diff?from=1&to=1`, { session })).body.diff).toEqual({ title: null, sections: [] });
    expect((await call(app, 'GET', `/orgs/acme/documents/${doc.id}/diff?from=0&to=1`, { session })).status).toBe(400);
    const restored = await call(app, 'POST', `/orgs/acme/documents/${doc.id}/restore`, { session, body: { number: 1, baseVersion: 2 } });
    expect(restored.body).toMatchObject({ version: 3, revisionNumber: 2 });

    const moved = await call(app, 'POST', `/orgs/acme/documents/${doc.id}/transitions`, { session, body: { to: 'discarded' } });
    expect(moved.body.document.status).toBe('discarded');
    expect((await call(app, 'POST', `/orgs/acme/documents/${doc.id}/transitions`, { session, body: { to: 'bogus' } })).status).toBe(400);
  });

  it('外部 PRD：列表筛选、重复网址 409、覆盖需求、转换', async () => {
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '分片上传' } })).body.requirement;
    const ext = await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, {
      session,
      body: { title: '外部方案', externalUrl: 'https://doc.weixin.qq.com/doc/x?scode=1', requirementIds: [req.id] },
    });
    expect(ext.body.document).toMatchObject({ source: 'external', externalProvider: 'wecom', requirements: [{ id: req.id }] });
    const dup = await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '重复', externalUrl: 'https://doc.weixin.qq.com/doc/x?scode=2' } });
    expect(dup.status).toBe(409);
    const list = await call(app, 'GET', `/orgs/acme/products/${productId}/documents?source=external&status=draft`, { session });
    expect(list.body.documents.map((d: { title: string }) => d.title)).toEqual(['外部方案']);
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/documents?status=bogus`, { session })).status).toBe(400);
    expect((await call(app, 'DELETE', `/orgs/acme/documents/${ext.body.document.id}/requirements/${req.id}`, { session })).status).toBe(204);
    expect((await call(app, 'POST', `/orgs/acme/documents/${ext.body.document.id}/requirements`, { session, body: { requirementIds: [req.id] } })).body).toEqual({ linked: 1 });
    const converted = await call(app, 'POST', `/orgs/acme/documents/${ext.body.document.id}/convert`, { session, body: { baseVersion: 1, markdown: '## 背景\n\n粘贴的内容' } });
    expect(converted.body).toMatchObject({ revisionNumber: 1 });
  });

  it('图片上传与读取：只读成员能读不能传；SVG 被拒绝；返回头带 nosniff', async () => {
    const doc = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '带图' } })).body.document;
    const up = await upload(app, `/orgs/acme/documents/${doc.id}/attachments`, { session, file: new Blob([PNG], { type: 'image/png' }), filename: '截图.png' });
    expect(up.status).toBe(201);
    expect(up.body.attachment).toMatchObject({ filename: '截图.png', mime: 'image/png', url: `/api/v1/orgs/acme/attachments/${up.body.attachment.id}` });
    const res = await app.request(up.body.attachment.url, { headers: { cookie: `flower_session=${viewerSession}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect((await upload(app, `/orgs/acme/documents/${doc.id}/attachments`, { session: viewerSession, file: new Blob([PNG]), filename: 'a.png' })).status).toBe(403);
    expect((await upload(app, `/orgs/acme/documents/${doc.id}/attachments`, { token: readToken, file: new Blob([PNG]), filename: 'a.png' })).status).toBe(403);
    const svg = await upload(app, `/orgs/acme/documents/${doc.id}/attachments`, { session, file: new Blob(['<svg/>'], { type: 'image/svg+xml' }), filename: 'x.svg' });
    expect(svg.status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/documents/${doc.id}/attachments`, { session, body: {} })).status).toBe(400);
  });

  it('上传拒绝跨站请求与缺少 Content-Length 的请求', async () => {
    const doc = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '上传校验' } })).body.document;
    const url = `/orgs/acme/documents/${doc.id}/attachments`;
    const file = new Blob([PNG], { type: 'image/png' });
    const crossSite = await upload(app, url, { session, file, filename: 'a.png', headers: { 'sec-fetch-site': 'same-site' } });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.error.message).toBe('不接受来自其他站点的上传请求');
    expect((await upload(app, url, { session, file, filename: 'a.png', headers: { origin: 'http://evil.example.com' } })).status).toBe(403);
    expect((await upload(app, url, { session, file, filename: 'a.png', headers: { 'sec-fetch-site': 'same-origin', origin: 'http://localhost' } })).status).toBe(201);
    expect((await upload(app, url, { session, file, filename: 'a.png', headers: { origin: 'http://localhost' } })).status).toBe(201);
    const noLength = await upload(app, url, { session, file, filename: 'a.png', headers: { 'content-length': null } });
    expect(noLength.status).toBe(400);
    expect(noLength.body.error.message).toBe('上传请求缺少 Content-Length');
  });

  it('权限矩阵：只读成员能评论不能写；只读 Token 只能读；模板只有组织管理员能建', async () => {
    const doc = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '权限' } })).body.document;
    expect((await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { session: viewerSession, body: { baseVersion: 1, markdown: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/documents/${doc.id}/transitions`, { session: viewerSession, body: { to: 'review' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session: viewerSession, body: { title: 'x' } })).status).toBe(403);
    const comment = await call(app, 'POST', `/orgs/acme/documents/${doc.id}/comments`, { session: viewerSession, body: { body: '整体同意' } });
    expect(comment.status).toBe(201);
    expect((await call(app, 'POST', `/orgs/acme/document-comments/${comment.body.comment.id}/resolve`, { session: viewerSession, body: { resolved: true } })).status).toBe(200);
    expect((await call(app, 'GET', `/orgs/acme/documents/${doc.id}/comments`, { token: readToken })).body.comments).toHaveLength(1);
    expect((await call(app, 'GET', '/orgs/acme/documents/PAN-PRD-1', { token: readToken })).status).toBe(200);
    expect((await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { token: readToken, body: { baseVersion: 1, markdown: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/documents/${doc.id}/comments`, { token: readToken, body: { body: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { token: readToken, body: { title: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/templates', { session: viewerSession, body: { name: 'x', body: '', sections: [] } })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/templates', { session, body: { name: '轻量', body: '## 背景\n', sections: [{ heading: '背景', required: true }] } })).status).toBe(201);
    expect((await call(app, 'POST', '/orgs/acme/templates/preset', { session })).status).toBe(409);
    expect((await call(app, 'GET', '/orgs/acme/templates', { session: viewerSession })).body.templates.map((x: { name: string }) => x.name)).toEqual(['变更 PRD（预置）', '轻量']);
  });
});
