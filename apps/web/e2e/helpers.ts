import { type APIRequestContext, type APIResponse, expect, type Locator, type Page, request as playwrightRequest } from '@playwright/test';

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

/** 既有列表用例要看产品内全量。须在进入需求列表之前调用。 */
export async function preferAllRequirements(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('flower.req.relatedScope', 'all');
  });
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

/** 页面本身不出现横向滚动：内容超宽时只能在自己的容器里滚动。 */
export async function expectNoPageOverflow(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, `页面宽 ${scroll}px，超出视口 ${client}px`).toBeLessThanOrEqual(client);
}

/** 输入框里的文字能否完整显示：按计算后的字体量宽度，数字输入框另留 16px 给上下箭头。 */
export async function textFits(input: Locator): Promise<boolean> {
  return input.evaluate((el: HTMLInputElement) => {
    const cs = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return ctx.measureText(el.value).width + (el.type === 'number' ? 16 : 0) <= inner;
  });
}

export async function createDocument(
  request: APIRequestContext,
  productId: string,
  data: { title: string; templateId?: string; externalUrl?: string; requirementIds?: string[] },
): Promise<{ id: string; displayKey: string; version: number }> {
  return (await json<{ document: { id: string; displayKey: string; version: number } }>(request.post(`/api/v1/orgs/acme/products/${productId}/documents`, { data }))).document;
}

export async function createBrief(
  request: APIRequestContext,
  productId: string,
  data: { title: string; requirementIds?: string[] },
): Promise<{ id: string; displayKey: string; version: number }> {
  return (await json<{ document: { id: string; displayKey: string; version: number } }>(request.post(`/api/v1/orgs/acme/products/${productId}/briefs`, { data }))).document;
}

/** 1×1 像素的 PNG（base64），图片上传与导入用例共用。 */
export const PNG_1PX_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function presetTemplateId(request: APIRequestContext, productId: string): Promise<string> {
  return (await json<{ templates: Array<{ id: string }> }>(request.get(`/api/v1/orgs/acme/templates?product=${productId}&usable=1`))).templates[0]!.id;
}

/** 以所有者身份签发一个只读、全部产品的 Token。 */
export async function readToken(request: APIRequestContext): Promise<string> {
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  return (await json<{ token: string }>(request.post('/api/v1/orgs/acme/tokens', { data: { memberId: me, name: '只读', scope: { products: 'all', access: 'read' } } }))).token;
}

/** 给产品换上带 PRD 联动的流程：「PRD」跟随 PRD 状态；「PRD 评审」挂在 PRD 上，由产品管理员会签；进入「开发中」需要 PRD 评审通过。 */
export async function applyPrdWorkflow(request: APIRequestContext, productId: string): Promise<void> {
  const wf = await json<{ version: { id: string } }>(
    request.post('/api/v1/orgs/acme/workflows', {
      data: {
        name: 'PRD 流程',
        body: {
          states: [
            { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
            { key: 'doing', label: '开发中', color: '#f59e0b', order: 2, group: '', category: 'started' },
          ],
          initial: 'backlog',
          transitions: [
            { from: '*', to: 'backlog', conditions: [] },
            { from: '*', to: 'doing', conditions: [{ type: 'check_item', item: 'prd_review', in: ['passed'] }] },
          ],
          checkItems: [
            { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status' },
            { key: 'prd_review', label: 'PRD 评审', scope: 'document', type: 'signoff', signers: [{ by: 'product_role', ref: 'admin' }], signoffRule: 'all' },
          ],
        },
      },
    }),
  );
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId: wf.version.id } }));
}

/** 新建结构树节点（以所有者身份，产品管理员权限），返回节点 id。 */
export async function createNode(request: APIRequestContext, productId: string, parentId: string | null, name: string): Promise<string> {
  return (await json<{ node: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/nodes`, { data: { parentId, name } }))).node.id;
}

/** 把 PRD 从草稿依次改为评审中、已通过、已上线。 */
export async function launchDocument(request: APIRequestContext, documentId: string): Promise<void> {
  for (const to of ['review', 'approved', 'launched']) await ok(request.post(`/api/v1/orgs/acme/documents/${documentId}/transitions`, { data: { to } }));
}

type TickSummary = { orgs: number; schedulesRun: number; events: number; notified: number; sent: number; failed: number; dead: number; rateLimited: number };

/** 驱动一轮后台循环（端到端服务端设置了 FLOWER_NOTIFY_WORKER=off、FLOWER_NOTIFY_TICK_API=1）：生成站内通知、执行定时推送、发送；now 用来模拟时间。 */
export async function tick(request: APIRequestContext, now?: Date): Promise<TickSummary> {
  return (await json<{ summary: TickSummary }>(request.post('/api/v1/instance/notifications/tick', { data: now ? { now: now.toISOString() } : {} }))).summary;
}

/** 登记企微通道（地址为本机假接收端），返回通道 id。 */
export async function createWecomChannel(request: APIRequestContext, name: string, url: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await json<{ channel: { id: string } }>(request.post('/api/v1/orgs/acme/notification-channels', { data: { kind: 'wecom_robot', name, config: { url }, ...extra } }))).channel.id;
}

/**
 * 以新成员的身份调用接口：发邀请，用独立的请求上下文接受（不影响 page 与 request 原来的登录状态），
 * 返回该上下文与成员 id。用完调用 ctx.dispose()。
 */
export async function memberRequest(
  request: APIRequestContext,
  opts: { email: string; name: string; orgRole?: 'admin' | 'member' | 'guest'; password?: string },
): Promise<{ ctx: APIRequestContext; memberId: string }> {
  const { token } = await json<{ token: string }>(request.post('/api/v1/orgs/acme/invitations', { data: { email: opts.email, orgRole: opts.orgRole ?? 'member' } }));
  const ctx = await playwrightRequest.newContext({ baseURL: 'http://localhost:3100' });
  await ok(ctx.post(`/api/v1/invitations/${token}/accept`, { data: { name: opts.name, password: opts.password ?? 'password123' } }));
  const memberId = (await json<{ me: { memberId: string } }>(ctx.get('/api/v1/orgs/acme'))).me.memberId;
  return { ctx, memberId };
}
