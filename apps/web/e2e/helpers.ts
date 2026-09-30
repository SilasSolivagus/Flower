import { type APIRequestContext, type APIResponse, expect, type Page } from '@playwright/test';

export const OWNER = { email: 'owner@example.com', password: 'password123', name: '林澄' };

export async function ok(pending: Promise<APIResponse>): Promise<APIResponse> {
  const res = await pending;
  expect(res.ok(), `${res.url()} → ${res.status()}`).toBeTruthy();
  return res;
}

export async function json<T>(pending: Promise<APIResponse>): Promise<T> {
  return (await (await ok(pending)).json()) as T;
}

export async function createProduct(request: APIRequestContext, name = '网盘', key = 'PAN'): Promise<string> {
  const res = await ok(request.post('/api/v1/orgs/acme/products', { data: { name, key } }));
  return (await res.json()).product.id as string;
}

export async function createRequirement(request: APIRequestContext, productId: string, title: string): Promise<{ id: string; displayKey: string }> {
  return (await json<{ requirement: { id: string; displayKey: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title } })))
    .requirement;
}

export async function setupInstance(request: APIRequestContext, org = { name: '测试组织', slug: 'acme' }): Promise<void> {
  const res = await request.post('/api/v1/setup', {
    data: { admin: { email: OWNER.email, name: OWNER.name, password: OWNER.password }, org },
  });
  expect(res.status()).toBe(201);
}

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** 登记一个无账号成员，返回其 memberId。 */
export async function createMember(request: APIRequestContext, displayName: string): Promise<string> {
  return (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName } }))).member.id;
}

/**
 * 发邀请、用 page 打开邀请链接并接受，返回新账号的 memberId。
 * `beforeSubmit` 在邀请页打开后、填写表单前调用，供调用方检查邀请页本身的内容。
 */
export async function acceptInvite(
  page: Page,
  request: APIRequestContext,
  opts: { email: string; orgRole: 'admin' | 'member' | 'guest'; name: string; password?: string; beforeSubmit?: () => Promise<void> },
): Promise<string> {
  const { token } = await json<{ token: string }>(request.post('/api/v1/orgs/acme/invitations', { data: { email: opts.email, orgRole: opts.orgRole } }));
  await page.goto(`/invite/${token}`);
  await opts.beforeSubmit?.();
  await page.getByLabel('你的姓名').fill(opts.name);
  await page.getByLabel('设置密码').fill(opts.password ?? 'password123');
  await page.getByRole('button', { name: '接受邀请' }).click();
  await page.waitForURL('**/acme');
  const members = (await json<{ members: Array<{ id: string; email: string | null }> }>(request.get('/api/v1/orgs/acme/members'))).members;
  return members.find((m) => m.email === opts.email)!.id;
}

/** 模拟服务端 5xx 的响应，配合 page.route(...).fulfill 使用。 */
export const FAIL_500 = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '服务器错误' } }) };

export async function createIteration(request: APIRequestContext, productId: string, name: string, startDate: string, endDate: string): Promise<string> {
  return (await json<{ iteration: { id: string } }>(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name, startDate, endDate } })))
    .iteration.id;
}

export async function createTask(request: APIRequestContext, data: Record<string, unknown>): Promise<string> {
  return (await json<{ task: { id: string } }>(request.post('/api/v1/orgs/acme/tasks', { data }))).task.id;
}

/** 给产品换上带「可行性」「设计签字」的流程；设计签字由产品管理员和一位指定成员会签。 */
export async function applyReviewWorkflow(request: APIRequestContext, productId: string, bossMemberId: string): Promise<void> {
  const wf = await json<{ version: { id: string } }>(
    request.post('/api/v1/orgs/acme/workflows', {
      data: {
        name: '评审流程',
        body: {
          states: [
            { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
            { key: 'done', label: '已上线', color: '#10b981', order: 2, group: '', category: 'completed' },
          ],
          initial: 'backlog',
          transitions: [
            { from: '*', to: 'backlog', conditions: [] },
            { from: '*', to: 'done', conditions: [] },
          ],
          checkItems: [
            { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' },
            {
              key: 'design',
              label: '设计签字',
              scope: 'requirement',
              type: 'signoff',
              signers: [
                { by: 'product_role', ref: 'admin' },
                { by: 'member', ref: bossMemberId },
              ],
              signoffRule: 'all',
            },
          ],
        },
      },
    }),
  );
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId: wf.version.id } }));
}
