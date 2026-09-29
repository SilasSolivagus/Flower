import { DEFAULT_WORKFLOW_BODY } from '@flower/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
});
afterAll(() => cleanup());

describe('流程', () => {
  it('列出模板、发布非法版本返回问题清单、发布合法版本', async () => {
    const list = await call(app, 'GET', '/orgs/acme/workflows', { session });
    const id = list.body.workflows[0].id;
    const bad = await call(app, 'POST', `/orgs/acme/workflows/${id}/versions`, {
      session, body: { body: { ...DEFAULT_WORKFLOW_BODY, initial: 'ghost' } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ path: 'initial', message: '初始状态「ghost」不存在' }]);
    const ok = await call(app, 'POST', `/orgs/acme/workflows/${id}/versions`, { session, body: { body: DEFAULT_WORKFLOW_BODY, note: '重新发布' } });
    expect(ok.status).toBe(201);
    expect(ok.body.version.version).toBe(2);
    const detail = await call(app, 'GET', `/orgs/acme/workflows/${id}`, { session });
    expect(detail.body.versions).toHaveLength(2);
  });

  it('产品复制流程并切换', async () => {
    const pw = await call(app, 'GET', `/orgs/acme/products/${productId}/workflow`, { session });
    const fork = await call(app, 'POST', `/orgs/acme/products/${productId}/workflow/fork`, {
      session, body: { fromVersionId: pw.body.version.id },
    });
    expect(fork.status).toBe(201);
    const after = await call(app, 'GET', `/orgs/acme/products/${productId}/workflow`, { session });
    expect(after.body.definition.productId).toBe(productId);
    const back = await call(app, 'PUT', `/orgs/acme/products/${productId}/workflow`, { session, body: { versionId: pw.body.version.id } });
    expect(back.status).toBe(204);
  });

  it('模板改名', async () => {
    const list = await call(app, 'GET', '/orgs/acme/workflows', { session });
    const id = list.body.workflows[0].id;
    const r = await call(app, 'PATCH', `/orgs/acme/workflows/${id}`, { session, body: { name: '网盘需求流程' } });
    expect(r.status).toBe(200);
    expect(r.body.workflow.name).toBe('网盘需求流程');
  });
});

describe('字段与层级', () => {
  it('给平台字段加选项，产品覆盖优先级', async () => {
    const fields = await call(app, 'GET', '/orgs/acme/fields', { session });
    const platform = fields.body.fields.find((f: { key: string }) => f.key === 'platform');
    const opt = await call(app, 'POST', `/orgs/acme/fields/${platform.id}/options`, { session, body: { label: 'PC客户端' } });
    expect(opt.status).toBe(201);
    const upd = await call(app, 'PATCH', `/orgs/acme/field-options/${opt.body.option.id}`, { session, body: { active: false } });
    expect(upd.body.option.active).toBe(false);

    const priority = fields.body.fields.find((f: { key: string }) => f.key === 'priority');
    const fork = await call(app, 'POST', `/orgs/acme/products/${productId}/fields/${priority.id}/fork`, { session });
    expect(fork.status).toBe(201);
    const effective = await call(app, 'GET', `/orgs/acme/fields?product=${productId}`, { session });
    expect(effective.body.fields.find((f: { key: string }) => f.key === 'priority').productId).toBe(productId);
  });

  it('层级叫法', async () => {
    const put = await call(app, 'PUT', '/orgs/acme/level-names', { session, body: { names: ['产品线', '能力'] } });
    expect(put.body.names).toEqual(['产品线', '能力']);
    await call(app, 'PUT', `/orgs/acme/products/${productId}/level-names`, { session, body: { names: ['模块'] } });
    const get = await call(app, 'GET', `/orgs/acme/products/${productId}/level-names`, { session });
    expect(get.body).toEqual({ names: ['模块'], source: 'product' });
    const bad = await call(app, 'PUT', '/orgs/acme/level-names', { session, body: { names: [] } });
    expect(bad.status).toBe(400);
  });
});
