# Flower P0-B 管理界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P0-A 的 API 之上交付 P0 的全部管理界面（15 个页面），并补齐界面所需的后端能力，使管理员可以在浏览器里完成"安装 → 建组织 → 邀请团队 → 配置流程与字典 → 签发 Agent Token"的完整路线。

**Architecture:** 页面全部是 Next.js App Router 下的客户端组件，通过同源的 `/api/v1` 取数（TanStack Query），不在页面里直接调用 `@flower/core`；类型用 `import type` 从 core 引入，并用 `Jsonify<T>` 把 `Date` 转成字符串。纯逻辑（导航、配置清单、成员筛选、流程编辑模型）放在 `src/features/**/model.ts`，用 Vitest 单测；页面行为用 Playwright 端到端测试验证，每个 spec 先重置一个独立的 `flower_e2e` 数据库。

**Tech Stack:** Next.js 16、React 19、Tailwind CSS v4、shadcn/ui（new-york，CSS 变量）、lucide-react、next-themes、@tanstack/react-query、@xyflow/react（React Flow）、@dnd-kit、sonner、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§2、§3、§6.5）。页面清单、视觉方向和交互决定见本计划"设计决定"一节（来自 2026-09-28/29 与用户的逐项确认）；视觉样稿：https://claude.ai/artifact/DgxTagCVRUGsKbvZSm9XPL（最上面一行"定稿"）。

## Global Constraints

- 默认浅色主题；next-themes 提供"浅色 / 深色 / 跟随系统"，`defaultTheme="light"`。
- 视觉：A 方向配色 + C 方向密度。颜色 token（浅色）：背景 `#F3F4F1`、卡片与侧栏 `#FFFFFF`、正文 `#1B1F1C`、次要文字 `#5F665F`、分隔线 `#E3E5E0`、主色 `#1F6F54`、主色上的文字 `#FFFFFF`、浅主色底 `#E2EFE8`、浅主色上的文字 `#17573F`、危险色 `#B42318`。
- 字体：IBM Plex Sans + Noto Sans SC；编号、邮箱、版本号、key 用 IBM Plex Mono。
- 密度：表格行高 40px 并隔行底色 `#F7F8F5`；卡片圆角 6px；按钮与输入框圆角 4px；页面标题 20px。
- 未完成模块（需求 P1、迭代 P1、文档 P2）在导航中置灰并显示阶段标签，不可点击。
- 实例默认邀请制；开放注册时登录页才显示"注册"入口。
- 流程流转规则用"从 × 到"矩阵编辑，条件在侧边抽屉编辑；状态图预览用 React Flow。
- 没有权限的入口不显示；直接访问无权限的网址显示"无权访问"。
- 面向用户的文案用中文。
- 页面不直接 import `@flower/core` 的运行时代码（会把数据库驱动打进浏览器包）；只允许 `import type`，以及纯前端安全的子路径 `@flower/core/workflow-schema`。
- 每个 commit message 末尾加一行：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## 设计决定（已与用户确认）

| 项 | 决定 |
|---|---|
| 框架 | 左侧导航 + 顶部栏；顶部栏左侧组织切换器（含"新建组织"），右侧个人菜单（个人设置、主题、退出） |
| 导航 | 概览；需求 P1、迭代 P1、文档 P2 置灰；"组织设置"分组仅组织管理员可见：成员、职能标签、产品、流程模板、字段字典、Agent 与 Token、组织信息 |
| 组织概览 | 管理员看到"组织配置清单"（6 项，按实际数据自动勾选）；普通成员看到产品卡片与自己的角色 |
| 表单 | 受控组件 + 服务端返回的中文错误；不引入 react-hook-form（P0 表单字段少，服务端已校验）|
| 流程编辑 | 状态表格（拖动排序）、流转矩阵（含"任意状态"一行）、检查项、动作门禁；本地草稿 + 实时校验（复用 core 的 `validateWorkflowBody`）；发布生成新版本 |

## 与 P0-A 暂缓项的对应

本计划 Task 1–3 处理 P0-A 最终审查暂缓的后端项：成员离开时清理产品角色并吊销 Token、登录限流、过期会话清理、修改密码放进同一事务。仍然暂缓（不在本计划）：生产环境强制 `FLOWER_PUBLIC_URL`、实例级操作的审计记录、迁移改为一次性 compose 服务。

## 文件结构

```
packages/core/
  src/tenancy/orgs.ts                 # 保留组织标识（Task 1）
  src/definitions/workflows.ts        # updateWorkflowDefinition（Task 1）
  src/tenancy/members.ts              # 离开时清理（Task 2）
  src/auth/throttle.ts                # 登录限流（Task 3）
  src/auth/sessions.ts / accounts.ts  # 过期会话清理、修改密码事务（Task 3）
  migrations/0004_*.sql               # auth_throttle 表、sessions 过期索引（Task 3）
apps/web/
  components.json
  playwright.config.ts
  e2e/                                # db.ts、helpers.ts、*.spec.ts
  src/app/
    layout.tsx / providers.tsx / globals.css
    (auth)/setup | login | register     # 未登录页面
    invite/[token]/page.tsx
    (app)/layout.tsx                    # AuthGate
    (app)/page.tsx                      # 首页（我的组织）
    (app)/settings/page.tsx             # 个人设置
    (app)/admin/page.tsx                # 实例设置
    (app)/[org]/layout.tsx              # OrgShell
    (app)/[org]/page.tsx                # 组织概览
    (app)/[org]/settings/{members,tags,products,products/[productId],workflows,workflows/[id],fields,agents,general}/page.tsx
  src/components/ui/                  # shadcn 生成
  src/components/                     # app 级组件：shell、page-header、empty-state 等
  src/lib/                            # api.ts、types.ts、queries.ts、utils.ts、labels.ts
  src/features/                       # 各页面的纯逻辑 model.ts + 测试
```

---

### Task 1: 保留组织标识、流程模板改名与归档、前端可用的流程校验入口

**Files:**
- Modify: `packages/core/src/tenancy/orgs.ts`（`assertOrgInput`）
- Modify: `packages/core/src/definitions/workflows.ts`（新增 `updateWorkflowDefinition`，抽出 `assertWorkflowName`）
- Modify: `packages/core/src/tenancy/products.ts`（`createProduct` 拒绝已归档模板）
- Modify: `packages/core/package.json`（exports 增加 `./workflow-schema`）
- Modify: `apps/web/src/server/routes/definitions.ts`（`PATCH /orgs/:org/workflows/:id`）
- Test: `packages/core/test/orgs.test.ts`, `packages/core/test/workflows.test.ts`, `apps/web/test/api/definitions.test.ts`

**Interfaces:**
- Produces:
  - `RESERVED_SLUGS: readonly string[]` = `['api','admin','settings','setup','login','register','invite']`（从 `@flower/core` 导出）
  - `updateWorkflowDefinition(db: Db, actor: Actor, definitionId: string, input: { name?: string; archived?: boolean }): Promise<WorkflowDefinitionView>`
  - HTTP：`PATCH /api/v1/orgs/:org/workflows/:id`，体 `{ name?: string; archived?: boolean }`，返回 `{ workflow: WorkflowDefinitionView }`
  - 包导出：`@flower/core/workflow-schema` → `src/definitions/workflow-schema.ts`（只依赖 zod，可在浏览器使用）

- [ ] **Step 1: 写失败的测试**

在 `packages/core/test/orgs.test.ts` 的 `describe('组织', …)` 内追加：

```ts
  it('系统保留的标识不能用作组织标识', async () => {
    const admin = await createAccount(t.db, { email: 'rsv@example.com', name: 'Rsv', password: 'password123', isInstanceAdmin: true });
    for (const slug of ['settings', 'admin', 'login', 'api', 'setup', 'register', 'invite']) {
      await expect(createOrganization(t.db, admin, { name: '保留', slug })).rejects.toMatchObject({ code: 'invalid', message: '该标识为系统保留，请换一个' });
    }
  });
```

在 `packages/core/test/workflows.test.ts` 顶部 import 中加入 `updateWorkflowDefinition`，并在 `describe('流程定义', …)` 内追加：

```ts
  it('模板改名与归档；最后一个启用中的模板不能归档；已归档模板不能用于新产品', async () => {
    const { definition } = await createWorkflowTemplate(t.db, owner, { name: '待归档', body: DEFAULT_WORKFLOW_BODY });
    const renamed = await updateWorkflowDefinition(t.db, owner, definition.id, { name: '旧流程' });
    expect(renamed.name).toBe('旧流程');
    const archived = await updateWorkflowDefinition(t.db, owner, definition.id, { archived: true });
    expect(archived.archivedAt).toBeTruthy();
    await expect(
      createProduct(t.db, owner, { name: '用归档', key: 'ARC', workflowVersionId: archived.currentVersionId! }),
    ).rejects.toMatchObject({ code: 'invalid', message: '该流程模板已归档' });
    const restored = await updateWorkflowDefinition(t.db, owner, definition.id, { archived: false });
    expect(restored.archivedAt).toBeNull();

    const active = (await listWorkflowTemplates(t.db, owner)).filter((d) => !d.archivedAt);
    for (const d of active.slice(1)) await updateWorkflowDefinition(t.db, owner, d.id, { archived: true });
    await expect(updateWorkflowDefinition(t.db, owner, active[0]!.id, { archived: true })).rejects.toMatchObject({
      code: 'invalid',
      message: '至少需要保留一个启用中的流程模板',
    });
  });

  it('产品覆盖的流程不能归档，名称校验与创建一致', async () => {
    const pw = await getProductWorkflow(t.db, owner, productId);
    const fork = await forkWorkflowForProduct(t.db, owner, productId, { fromVersionId: pw.version.id });
    await expect(updateWorkflowDefinition(t.db, owner, fork.definition.id, { archived: true })).rejects.toMatchObject({
      code: 'invalid',
      message: '只有组织流程模板可以归档',
    });
    await expect(updateWorkflowDefinition(t.db, owner, fork.definition.id, { name: ' ' })).rejects.toMatchObject({ code: 'invalid' });
  });
```

在 `apps/web/test/api/definitions.test.ts` 的 `describe('流程', …)` 内追加：

```ts
  it('模板改名', async () => {
    const list = await call(app, 'GET', '/orgs/acme/workflows', { session });
    const id = list.body.workflows[0].id;
    const r = await call(app, 'PATCH', `/orgs/acme/workflows/${id}`, { session, body: { name: '网盘需求流程' } });
    expect(r.status).toBe(200);
    expect(r.body.workflow.name).toBe('网盘需求流程');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test orgs workflows && pnpm --filter @flower/web test definitions`
Expected: FAIL（`updateWorkflowDefinition` 未导出；保留标识未拦截；PATCH 返回 404）。

- [ ] **Step 3: 实现**

`packages/core/src/tenancy/orgs.ts`：在 `SLUG_RE` 下方加入，并在 `assertOrgInput` 的格式校验之后检查：

```ts
export const RESERVED_SLUGS: readonly string[] = ['api', 'admin', 'settings', 'setup', 'login', 'register', 'invite'];
```

```ts
  if (RESERVED_SLUGS.includes(slug)) throw new AppError('invalid', '该标识为系统保留，请换一个');
```

`packages/core/src/definitions/workflows.ts`：

1. 把 `createWorkflowTemplate` 里的名称校验抽成函数，并让 `createWorkflowTemplate` 调用它：

```ts
function assertWorkflowName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 30) throw new AppError('invalid', '流程名称不能为空，且不超过 30 个字符');
  return n;
}
```

2. 新增：

```ts
export async function updateWorkflowDefinition(
  db: Db,
  actor: Actor,
  definitionId: string,
  input: { name?: string; archived?: boolean },
): Promise<WorkflowDefinitionView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const d = await loadDefinition(tx, definitionId);
    await requireManage(tx, actor, d);
    if (input.archived !== undefined && d.productId !== null) {
      throw new AppError('invalid', '只有组织流程模板可以归档');
    }
    const name = input.name === undefined ? d.name : assertWorkflowName(input.name);
    let archivedAt = d.archivedAt;
    if (input.archived === true && !d.archivedAt) {
      const others = await tx
        .select({ id: workflowDefinitions.id })
        .from(workflowDefinitions)
        .where(and(isNull(workflowDefinitions.productId), isNull(workflowDefinitions.archivedAt)));
      if (others.filter((o) => o.id !== d.id).length === 0) {
        throw new AppError('invalid', '至少需要保留一个启用中的流程模板');
      }
      archivedAt = new Date();
    }
    if (input.archived === false) archivedAt = null;
    const [row] = await tx
      .update(workflowDefinitions)
      .set({ name, archivedAt })
      .where(eq(workflowDefinitions.id, definitionId))
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: d.productId,
      type: 'workflow.updated',
      subjectType: 'workflow_definition',
      subjectId: definitionId,
      actor,
      payload: {
        changes: [
          { field: 'name', old: d.name, new: name },
          { field: 'archivedAt', old: d.archivedAt?.toISOString() ?? null, new: archivedAt?.toISOString() ?? null },
        ].filter((c) => c.old !== c.new),
      },
    });
    return definitionView(tx, row!);
  });
}
```

（`and`、`isNull` 若未导入，从 `drizzle-orm` 补上。）

`packages/core/src/tenancy/products.ts` 的 `createProduct`：查询显式版本时一并取出 `archivedAt`，并在 `definitionProductId` 校验之后拒绝已归档模板：

```ts
        .select({ definitionProductId: workflowDefinitions.productId, archivedAt: workflowDefinitions.archivedAt })
```

```ts
      if (row.archivedAt) throw new AppError('invalid', '该流程模板已归档');
```

`packages/core/package.json` 的 `exports` 增加一项：

```json
    "./workflow-schema": "./src/definitions/workflow-schema.ts",
```

`apps/web/src/server/routes/definitions.ts`：从 `@flower/core` 导入 `updateWorkflowDefinition`，在 `app.get('/orgs/:org/workflows/:id', …)` 之后加入：

```ts
  app.patch('/orgs/:org/workflows/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), archived: z.boolean().optional() }));
    return c.json({ workflow: await updateWorkflowDefinition(deps.db, c.get('actor'), c.req.param('id'), body) });
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/core apps/web/src/server apps/web/test
git commit -m "feat(core): 保留组织标识、流程模板改名与归档"
```

---

### Task 2: 成员离开时清理产品角色并吊销 Token

**Files:**
- Modify: `packages/core/src/tenancy/members.ts`（`updateMember`）
- Test: `packages/core/test/members.test.ts`

**Interfaces:**
- Consumes: `apiTokens`、`productMembers`（schema）；`issueToken`、`authenticateToken`、`createProduct`、`setProductRole`、`createAgentMember`
- Produces: `updateMember` 在状态由 `active` 变为 `left` 时：删除该成员全部 `product_members`、把其未吊销的 `api_tokens` 设为已吊销；事件 payload 增加 `removedProductRoles`（已有字段，合并）与 `revokedTokenIds: string[]`。成员重新变为 `active` 时不恢复任何产品角色或 Token。

- [ ] **Step 1: 写失败的测试**

在 `packages/core/test/members.test.ts` 顶部加入 import：

```ts
import { authenticateToken, issueToken } from '../src/access/tokens';
import { createProduct, setProductRole } from '../src/tenancy/products';
```

在 `describe('成员', …)` 内追加：

```ts
  it('成员离开时清掉产品角色并吊销 Token，重新启用后不恢复', async () => {
    const product = await createProduct(t.db, owner, { name: '离开测试', key: 'LVE' });
    const agent = await createAgentMember(t.db, owner, { displayName: '离开的助手' });
    await setProductRole(t.db, owner, product.id, agent.id, 'viewer');
    const { token } = await issueToken(t.db, owner, { memberId: agent.id, name: 't', scope: { products: 'all', access: 'read' } });
    expect(await authenticateToken(t.db, token)).not.toBeNull();

    const left = await updateMember(t.db, owner, agent.id, { status: 'left' });
    expect(left.productRoles).toEqual([]);
    expect(await authenticateToken(t.db, token)).toBeNull();

    const back = await updateMember(t.db, owner, agent.id, { status: 'active' });
    expect(back.productRoles).toEqual([]);
    expect(await authenticateToken(t.db, token)).toBeNull();
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test members`
Expected: FAIL（离开后 `productRoles` 仍有 viewer；Token 仍可认证）。

- [ ] **Step 3: 实现**

`packages/core/src/tenancy/members.ts`：从 schema 导入 `apiTokens`，从 `drizzle-orm` 导入 `isNull`。把 `updateMember` 中删除 `productMembers` 的那段替换为：

```ts
    const leaving = cur.status === 'active' && nextStatus === 'left';
    let removedProductRoles: Array<{ productId: string; role: ProductRole }> = [];
    if (nextRole === 'owner' || nextRole === 'admin' || leaving) {
      removedProductRoles = await tx
        .delete(productMembers)
        .where(eq(productMembers.memberId, memberId))
        .returning({ productId: productMembers.productId, role: productMembers.role });
    }
    let revokedTokenIds: string[] = [];
    if (leaving) {
      const revoked = await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.memberId, memberId), isNull(apiTokens.revokedAt)))
        .returning({ id: apiTokens.id });
      revokedTokenIds = revoked.map((r) => r.id);
    }
```

并在 `recordEvent` 的 payload 中，`removedProductRoles` 那一行之后加入：

```ts
        ...(revokedTokenIds.length > 0 ? { revokedTokenIds } : {}),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test && pnpm --filter @flower/core typecheck`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 成员离开时清理产品角色并吊销 Token"
```

---

### Task 3: 登录限流、过期会话清理、修改密码放进同一事务

**Files:**
- Modify: `packages/core/src/db/schema.ts`（新表 `auth_throttle`；`sessions.expires_at` 索引）
- Create: `packages/core/migrations/0004_*.sql`（drizzle-kit 生成）
- Create: `packages/core/src/auth/throttle.ts`
- Modify: `packages/core/src/auth/sessions.ts`（`login`、新增 `purgeExpiredSessions`）
- Modify: `packages/core/src/auth/accounts.ts`（`changePassword` 改为事务）
- Modify: `packages/core/src/errors.ts`（`ErrorCode` 增加 `rate_limited`）、`packages/core/src/index.ts`
- Modify: `apps/web/src/server/http.ts`（`rate_limited` → 429）
- Test: `packages/core/test/throttle.test.ts`, `apps/web/test/api/auth.test.ts`

**Interfaces:**
- Produces:
  - `ErrorCode` 增加 `'rate_limited'`；HTTP 429
  - `LOGIN_LIMITS = { email: { max: 5, windowMs: 900000, lockMs: 900000 }, ip: { max: 20, windowMs: 900000, lockMs: 900000 } }`
  - `throttleKeys(email: string, ip?: string | null): Array<{ key: string; rule: ThrottleRule }>`（第一个总是 `email:<规范化邮箱>`）
  - `assertNotThrottled(q: Queryable, keys: Array<{ key: string }>, now?: Date): Promise<void>`
  - `recordLoginFailure(q: Queryable, keys: Array<{ key: string; rule: ThrottleRule }>, now?: Date): Promise<void>`
  - `clearLoginFailures(q: Queryable, key: string): Promise<void>`
  - `purgeExpiredSessions(q: Queryable, now?: Date): Promise<number>`
  - `changePassword(db: Db, accountId, input)`（第一个参数由 `Queryable` 改为 `Db`，内部开事务）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/throttle.test.ts`：

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount } from '../src/auth/accounts';
import { createSession, login, purgeExpiredSessions, resolveSession } from '../src/auth/sessions';
import { throttleKeys } from '../src/auth/throttle';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await createAccount(t.db, { email: 'th@example.com', name: 'Th', password: 'password123' });
});
afterAll(() => t.cleanup());

describe('登录限流', () => {
  it('同一邮箱连续失败 5 次后锁定，正确密码也被拒绝；锁定过期后恢复并清零', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(login(t.db, { email: 'th@example.com', password: 'wrong-pass' }, { ip: '10.0.0.1' })).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    await expect(login(t.db, { email: 'TH@example.com', password: 'password123' }, { ip: '10.0.0.2' })).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await t.db.execute(sql`update auth_throttle set locked_until = now() - interval '1 second'`);
    const ok = await login(t.db, { email: 'th@example.com', password: 'password123' }, { ip: '10.0.0.2' });
    expect(ok.account.email).toBe('th@example.com');
    const rows = await t.db.execute(sql`select key from auth_throttle where key = ${throttleKeys('th@example.com')[0]!.key}`);
    expect(rows).toHaveLength(0);
  });

  it('同一 IP 失败 20 次后锁定该 IP', async () => {
    for (let i = 0; i < 20; i++) {
      await expect(login(t.db, { email: `nobody${i}@example.com`, password: 'x' }, { ip: '10.9.9.9' })).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    await expect(login(t.db, { email: 'th@example.com', password: 'password123' }, { ip: '10.9.9.9' })).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('过期会话清理', () => {
  it('删除已过期的会话，保留有效会话', async () => {
    const acc = await createAccount(t.db, { email: 'purge@example.com', name: 'P', password: 'password123' });
    const old = await createSession(t.db, acc.id, {}, new Date(Date.now() - 1000));
    const fresh = await createSession(t.db, acc.id);
    expect(await purgeExpiredSessions(t.db)).toBeGreaterThanOrEqual(1);
    expect(await resolveSession(t.db, old.token)).toBeNull();
    expect(await resolveSession(t.db, fresh.token)).not.toBeNull();
  });
});
```

在 `apps/web/test/api/auth.test.ts` 的 `describe` 末尾追加：

```ts
  it('登录被限流时返回 429', async () => {
    for (let i = 0; i < 5; i++) {
      await call(app, 'POST', '/auth/login', { body: { email: 'owner@example.com', password: 'bad-password' } });
    }
    const r = await call(app, 'POST', '/auth/login', { body: { email: 'owner@example.com', password: 'password456' } });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
  });
```

（该用例放在文件最后，因为它会锁定 owner 邮箱。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core test throttle && pnpm --filter @flower/web test auth`
Expected: FAIL（`../src/auth/throttle` 不存在；限流未生效）。

- [ ] **Step 3: 改 schema 并生成迁移**

`packages/core/src/db/schema.ts`：给 `sessions` 加第三个参数，并在全局表区域新增 `authThrottle`：

```ts
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_expires_at').on(t.expiresAt)],
);

export const authThrottle = pgTable('auth_throttle', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStart: ts('window_start').notNull().defaultNow(),
  lockedUntil: ts('locked_until'),
});
```

```bash
cd packages/core && pnpm drizzle-kit generate --name=auth_throttle && cd ../..
```

Expected: 生成 `migrations/0004_auth_throttle.sql`，内容为 `CREATE TABLE "auth_throttle"` 与 `CREATE INDEX "sessions_expires_at"`。该表是全局表，不需要 RLS；`0000_roles.sql` 的默认权限会自动授予 `flower_app`。

- [ ] **Step 4: 实现限流与会话清理**

`packages/core/src/auth/throttle.ts`：

```ts
import { eq, inArray } from 'drizzle-orm';
import { authThrottle } from '../db/schema';
import type { Queryable } from '../db/tx';
import { AppError } from '../errors';
import { normalizeEmail } from './accounts';

export type ThrottleRule = { max: number; windowMs: number; lockMs: number };

export const LOGIN_LIMITS = {
  email: { max: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  ip: { max: 20, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
} as const satisfies Record<string, ThrottleRule>;

export function throttleKeys(email: string, ip?: string | null): Array<{ key: string; rule: ThrottleRule }> {
  const keys: Array<{ key: string; rule: ThrottleRule }> = [{ key: `email:${normalizeEmail(email)}`, rule: LOGIN_LIMITS.email }];
  if (ip) keys.push({ key: `ip:${ip}`, rule: LOGIN_LIMITS.ip });
  return keys;
}

export async function assertNotThrottled(q: Queryable, keys: Array<{ key: string }>, now: Date = new Date()): Promise<void> {
  const rows = await q.select().from(authThrottle).where(inArray(authThrottle.key, keys.map((k) => k.key)));
  const lockedUntil = rows
    .map((r) => r.lockedUntil)
    .filter((d): d is Date => d !== null && d.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (lockedUntil) {
    const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
    throw new AppError('rate_limited', `登录失败次数过多，请在 ${minutes} 分钟后再试`);
  }
}

export async function recordLoginFailure(
  q: Queryable,
  keys: Array<{ key: string; rule: ThrottleRule }>,
  now: Date = new Date(),
): Promise<void> {
  for (const { key, rule } of keys) {
    const [row] = await q.select().from(authThrottle).where(eq(authThrottle.key, key));
    const windowExpired = !row || row.windowStart.getTime() + rule.windowMs <= now.getTime();
    const failures = windowExpired ? 1 : row.failures + 1;
    const lockedUntil = failures >= rule.max ? new Date(now.getTime() + rule.lockMs) : null;
    const values = { failures, windowStart: windowExpired ? now : row.windowStart, lockedUntil };
    if (row) await q.update(authThrottle).set(values).where(eq(authThrottle.key, key));
    else await q.insert(authThrottle).values({ key, ...values });
  }
}

export async function clearLoginFailures(q: Queryable, key: string): Promise<void> {
  await q.delete(authThrottle).where(eq(authThrottle.key, key));
}
```

`packages/core/src/auth/sessions.ts`：导入 `lt`（drizzle-orm）与 `assertNotThrottled, clearLoginFailures, recordLoginFailure, throttleKeys`（`./throttle`），新增 `purgeExpiredSessions`，并把 `login` 改为：

```ts
export async function purgeExpiredSessions(q: Queryable, now: Date = new Date()): Promise<number> {
  const rows = await q.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id });
  return rows.length;
}

export async function login(
  q: Queryable,
  input: { email: string; password: string },
  meta: SessionMeta = {},
): Promise<{ token: string; expiresAt: Date; account: AccountView }> {
  const keys = throttleKeys(input.email, meta.ip);
  await assertNotThrottled(q, keys);
  const [row] = await q.select().from(accounts).where(eq(accounts.email, normalizeEmail(input.email)));
  const passwordHash = row?.passwordHash ?? (await getDummyPasswordHash());
  const passwordValid = await verifyPassword(passwordHash, input.password);
  if (!row || !passwordValid) {
    await recordLoginFailure(q, keys);
    throw new AppError('unauthenticated', '邮箱或密码错误');
  }
  await clearLoginFailures(q, keys[0]!.key);
  await purgeExpiredSessions(q);
  await q.update(accounts).set({ lastLoginAt: new Date() }).where(eq(accounts.id, row.id));
  const session = await createSession(q, row.id, meta);
  return { ...session, account: toAccountView(row) };
}
```

`packages/core/src/auth/accounts.ts` 的 `changePassword` 改为（导入 `type Db`）：

```ts
export async function changePassword(
  db: Db,
  accountId: string,
  input: { currentPassword: string; newPassword: string; keepSessionToken?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
    if (!row) throw new AppError('not_found', '账号不存在');
    if (!(await verifyPassword(row.passwordHash, input.currentPassword))) {
      throw new AppError('invalid', '当前密码不正确');
    }
    assertPasswordPolicy(input.newPassword);
    await tx.update(accounts).set({ passwordHash: await hashPassword(input.newPassword) }).where(eq(accounts.id, accountId));
    const keepHash = input.keepSessionToken ? sha256(input.keepSessionToken) : null;
    await tx
      .delete(sessions)
      .where(keepHash ? and(eq(sessions.accountId, accountId), ne(sessions.tokenHash, keepHash)) : eq(sessions.accountId, accountId));
  });
}
```

`packages/core/src/errors.ts`：`ErrorCode` 联合类型增加 `| 'rate_limited'`。

`packages/core/src/index.ts` 追加 `export * from './auth/throttle';`

`apps/web/src/server/http.ts` 的 `STATUS` 增加 `rate_limited: 429,`。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add packages/core apps/web/src/server apps/web/test
git commit -m "feat(core): 登录限流、过期会话清理与修改密码事务"
```

---

### Task 4: 前端基础：依赖、shadcn、设计 token、字体、全局 Provider、API 客户端

**Files:**
- Modify: `apps/web/package.json`、`apps/web/vitest.config.ts`
- Create: `apps/web/components.json`、`apps/web/src/lib/utils.ts`、`apps/web/src/lib/api.ts`、`apps/web/src/lib/types.ts`、`apps/web/src/lib/labels.ts`、`apps/web/src/lib/queries.ts`
- Create: `apps/web/src/app/providers.tsx`
- Modify: `apps/web/src/app/layout.tsx`、`apps/web/src/app/globals.css`
- Delete: `apps/web/src/app/page.tsx`（`/` 由 Task 5 的 `(app)/page.tsx` 接管）
- Create: `apps/web/src/components/ui/*`（shadcn CLI 生成）
- Test: `apps/web/src/lib/api.test.ts`

**Interfaces:**
- Produces:
  - `cn(...inputs: ClassValue[]): string`
  - `class ApiError extends Error { status: number; code: string; details: unknown }`，`api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>`（`path` 不含 `/api/v1` 前缀；204 返回 `undefined`）
  - 类型：`Jsonify<T>`，`Account, InstanceStatus, MyOrg, Org, OrgMe, Member, FunctionTag, Invitation, InvitationPreview, Token, TokenScope, Product, WorkflowDefinition, WorkflowVersion, WorkflowBody, Field, FieldOption, LevelNames, OrgRole, ProductRole`
  - 文案常量：`ORG_ROLE_LABEL, PRODUCT_ROLE_LABEL, MEMBER_KIND_LABEL, CATEGORY_LABEL, CATEGORY_COLOR, CHECK_STATE_LABEL, SWATCHES`
  - 查询：`qk`（query key 工厂），`useSetupStatus, useMe, useOrg, useMembers, useInvitations, useFunctionTags, useProducts, useProduct, useProductRoles, useProductWorkflow, useWorkflows, useWorkflow, useFields, useLevelNames, useTokens, useInstanceSettings`，`useApiMutation`

- [ ] **Step 1: 安装依赖**

```bash
pnpm --filter @flower/web add @tanstack/react-query next-themes lucide-react @xyflow/react @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities clsx tailwind-merge class-variance-authority sonner tw-animate-css @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono @fontsource/noto-sans-sc
pnpm --filter @flower/web add -D @playwright/test postgres
```

字体用 @fontsource 从 npm 自带，不在构建时访问 Google Fonts，自托管环境没有外网也能构建。

- [ ] **Step 2: 写设计 token 与 shadcn 配置**

`apps/web/src/app/globals.css`（整体替换）：

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 6px;
  --background: #f3f4f1;
  --foreground: #1b1f1c;
  --card: #ffffff;
  --card-foreground: #1b1f1c;
  --popover: #ffffff;
  --popover-foreground: #1b1f1c;
  --primary: #1f6f54;
  --primary-foreground: #ffffff;
  --secondary: #ffffff;
  --secondary-foreground: #1b1f1c;
  --muted: #f3f4f1;
  --muted-foreground: #5f665f;
  --accent: #e2efe8;
  --accent-foreground: #17573f;
  --destructive: #b42318;
  --border: #e3e5e0;
  --input: #e3e5e0;
  --ring: #1f6f54;
  --sidebar: #ffffff;
  --zebra: #f7f8f5;
}

.dark {
  --background: #111512;
  --foreground: #e6eae6;
  --card: #181d19;
  --card-foreground: #e6eae6;
  --popover: #181d19;
  --popover-foreground: #e6eae6;
  --primary: #4fb38d;
  --primary-foreground: #0b1f16;
  --secondary: #1e2420;
  --secondary-foreground: #e6eae6;
  --muted: #1e2420;
  --muted-foreground: #9ba39b;
  --accent: #1d3a2e;
  --accent-foreground: #bfe6d3;
  --destructive: #f97066;
  --border: #2a312c;
  --input: #2a312c;
  --ring: #4fb38d;
  --sidebar: #151a16;
  --zebra: #1a1f1b;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-zebra: var(--zebra);
  --radius-sm: 3px;
  --radius-md: 4px;
  --radius-lg: var(--radius);
  --radius-xl: var(--radius);
  --font-sans: "IBM Plex Sans", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground font-sans antialiased;
    font-size: 14px;
  }
}
```

`apps/web/components.json`：

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

`apps/web/src/lib/utils.ts`：

```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

生成 shadcn 组件：

```bash
cd apps/web
pnpm dlx shadcn@latest add button input label badge card dialog sheet dropdown-menu select tabs table checkbox switch separator tooltip skeleton alert-dialog textarea sonner --yes
git diff --stat src/app/globals.css
cd ../..
```

Expected: `src/components/ui/` 下生成 18 个组件文件。若 CLI 改动了 `globals.css`（`git diff` 有输出），用上面的内容覆盖回去——token 以本计划为准。

- [ ] **Step 3: 写 API 客户端的失败测试**

`apps/web/vitest.config.ts` 的 `test.include` 改为：

```ts
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
```

`apps/web/src/lib/api.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('api', () => {
  it('GET 返回 JSON，路径加上 /api/v1 前缀', async () => {
    const f = mockFetch(200, { ok: true });
    await expect(api('/me')).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledWith('/api/v1/me', expect.objectContaining({ method: 'GET' }));
  });

  it('带 body 时发送 JSON 与 content-type', async () => {
    const f = mockFetch(201, { id: 1 });
    await api('/orgs', { method: 'POST', body: { name: 'x' } });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"name":"x"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('204 返回 undefined', async () => {
    mockFetch(204, undefined);
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('错误响应抛出 ApiError，保留 code、message、details', async () => {
    mockFetch(400, { error: { code: 'invalid', message: '请求参数有误', details: [{ path: 'a', message: 'b' }] } });
    const e = await api('/x').catch((err) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: 'invalid', message: '请求参数有误', details: [{ path: 'a', message: 'b' }] });
  });

  it('非 JSON 的错误响应也有中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 502 })));
    await expect(api('/x')).rejects.toMatchObject({ status: 502, code: 'internal', message: '服务暂时不可用，请稍后重试' });
  });
});
```

Run: `pnpm --filter @flower/web test api.test`
Expected: FAIL（`./api` 不存在）。

- [ ] **Step 4: 实现 API 客户端、类型、文案、查询**

`apps/web/src/lib/api.ts`：

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: hasBody ? { 'content-type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? '服务暂时不可用，请稍后重试', e?.details ?? null);
  }
  return data as T;
}
```

`apps/web/src/lib/types.ts`：

```ts
import type {
  AccountView,
  FieldOptionView,
  FieldView,
  FunctionTagView,
  InstanceStatus as CoreInstanceStatus,
  InvitationPreview as CoreInvitationPreview,
  InvitationView,
  MemberView,
  MyOrg as CoreMyOrg,
  OrgRole as CoreOrgRole,
  OrgView,
  ProductRole as CoreProductRole,
  ProductView,
  TokenScope as CoreTokenScope,
  TokenView,
  WorkflowBody as CoreWorkflowBody,
  WorkflowDefinitionView,
  WorkflowVersionView,
} from '@flower/core';

/** 接口返回的 JSON 中 Date 已序列化为字符串。 */
export type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

export type OrgRole = CoreOrgRole;
export type ProductRole = CoreProductRole;
export type TokenScope = CoreTokenScope;
export type WorkflowBody = CoreWorkflowBody;
export type Account = Jsonify<AccountView>;
export type InstanceStatus = CoreInstanceStatus;
export type MyOrg = CoreMyOrg;
export type Org = Jsonify<OrgView>;
export type OrgMe = { memberId: string; orgRole: OrgRole };
export type Member = Jsonify<MemberView>;
export type FunctionTag = FunctionTagView;
export type Invitation = Jsonify<InvitationView>;
export type InvitationPreview = CoreInvitationPreview;
export type Token = Jsonify<TokenView>;
export type Product = Jsonify<ProductView>;
export type WorkflowDefinition = Jsonify<WorkflowDefinitionView>;
export type WorkflowVersion = Jsonify<WorkflowVersionView>;
export type Field = Jsonify<FieldView>;
export type FieldOption = Jsonify<FieldOptionView>;
export type LevelNames = { names: string[]; source: 'default' | 'org' | 'product' };
```

`apps/web/src/lib/labels.ts`：

```ts
import type { OrgRole, ProductRole } from './types';

export const ORG_ROLE_LABEL: Record<OrgRole, string> = { owner: '所有者', admin: '管理员', member: '成员', guest: '访客' };
export const PRODUCT_ROLE_LABEL: Record<ProductRole, string> = { admin: '管理员', editor: '编辑', viewer: '只读' };
export const MEMBER_KIND_LABEL = { account: '账号', none: '无账号', agent: 'Agent' } as const;
export const CATEGORY_LABEL = {
  backlog: '未排期',
  unstarted: '未开始',
  started: '进行中',
  completed: '已完成',
  canceled: '已取消',
} as const;
export const CATEGORY_COLOR = {
  backlog: '#8a9199',
  unstarted: '#2f6fd6',
  started: '#b7791f',
  completed: '#1e8a5a',
  canceled: '#5c6570',
} as const;
export const CHECK_STATE_LABEL = {
  not_started: '未开始',
  in_progress: '进行中',
  passed: '通过',
  rejected: '驳回',
  not_needed: '不需要',
} as const;
export const SWATCHES = ['#1f6f54', '#0f766e', '#2f6fd6', '#7c3aed', '#db2777', '#b42318', '#b7791f', '#1e8a5a', '#5c6570', '#8a9199'];
```

`apps/web/src/lib/queries.ts`：

```ts
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, api } from './api';
import type {
  Account,
  Field,
  FunctionTag,
  InstanceStatus,
  Invitation,
  LevelNames,
  Member,
  MyOrg,
  Org,
  OrgMe,
  Product,
  ProductRole,
  Token,
  WorkflowDefinition,
  WorkflowVersion,
} from './types';

export const qk = {
  setup: ['setup'] as const,
  me: ['me'] as const,
  instance: ['instance'] as const,
  org: (o: string) => ['org', o] as const,
  members: (o: string) => ['org', o, 'members'] as const,
  invitations: (o: string) => ['org', o, 'invitations'] as const,
  tags: (o: string) => ['org', o, 'tags'] as const,
  products: (o: string) => ['org', o, 'products'] as const,
  product: (o: string, id: string) => ['org', o, 'product', id] as const,
  productRoles: (o: string, id: string) => ['org', o, 'product', id, 'roles'] as const,
  productWorkflow: (o: string, id: string) => ['org', o, 'product', id, 'workflow'] as const,
  workflows: (o: string) => ['org', o, 'workflows'] as const,
  workflow: (o: string, id: string) => ['org', o, 'workflow', id] as const,
  fields: (o: string, productId?: string) => ['org', o, 'fields', productId ?? 'org'] as const,
  levels: (o: string, productId?: string) => ['org', o, 'levels', productId ?? 'org'] as const,
  tokens: (o: string) => ['org', o, 'tokens'] as const,
};

export const useSetupStatus = () => useQuery({ queryKey: qk.setup, queryFn: () => api<InstanceStatus>('/setup/status') });
export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => api<{ account: Account; orgs: MyOrg[] }>('/me') });
export const useInstanceSettings = () => useQuery({ queryKey: qk.instance, queryFn: () => api<InstanceStatus>('/instance/settings') });
export const useOrg = (o: string) =>
  useQuery({ queryKey: qk.org(o), queryFn: () => api<{ org: Org; me: OrgMe }>(`/orgs/${o}`) });
export const useMembers = (o: string) =>
  useQuery({ queryKey: qk.members(o), queryFn: () => api<{ members: Member[] }>(`/orgs/${o}/members`), select: (d) => d.members });
export const useInvitations = (o: string, enabled = true) =>
  useQuery({
    queryKey: qk.invitations(o),
    queryFn: () => api<{ invitations: Invitation[] }>(`/orgs/${o}/invitations`),
    select: (d) => d.invitations,
    enabled,
  });
export const useFunctionTags = (o: string) =>
  useQuery({ queryKey: qk.tags(o), queryFn: () => api<{ tags: FunctionTag[] }>(`/orgs/${o}/function-tags`), select: (d) => d.tags });
export const useProducts = (o: string) =>
  useQuery({ queryKey: qk.products(o), queryFn: () => api<{ products: Product[] }>(`/orgs/${o}/products`), select: (d) => d.products });
export const useProduct = (o: string, id: string) =>
  useQuery({ queryKey: qk.product(o, id), queryFn: () => api<{ product: Product }>(`/orgs/${o}/products/${id}`), select: (d) => d.product });
export const useProductRoles = (o: string, id: string, enabled = true) =>
  useQuery({
    queryKey: qk.productRoles(o, id),
    queryFn: () => api<{ roles: Array<{ memberId: string; role: ProductRole }> }>(`/orgs/${o}/products/${id}/roles`),
    select: (d) => d.roles,
    enabled,
  });
export const useProductWorkflow = (o: string, id: string) =>
  useQuery({
    queryKey: qk.productWorkflow(o, id),
    queryFn: () => api<{ definition: WorkflowDefinition; version: WorkflowVersion }>(`/orgs/${o}/products/${id}/workflow`),
  });
export const useWorkflows = (o: string, enabled = true) =>
  useQuery({
    queryKey: qk.workflows(o),
    queryFn: () => api<{ workflows: WorkflowDefinition[] }>(`/orgs/${o}/workflows`),
    select: (d) => d.workflows,
    enabled,
  });
export const useWorkflow = (o: string, id: string) =>
  useQuery({
    queryKey: qk.workflow(o, id),
    queryFn: () => api<{ definition: WorkflowDefinition; versions: WorkflowVersion[] }>(`/orgs/${o}/workflows/${id}`),
  });
export const useFields = (o: string, productId?: string) =>
  useQuery({
    queryKey: qk.fields(o, productId),
    queryFn: () => api<{ fields: Field[] }>(`/orgs/${o}/fields${productId ? `?product=${productId}` : ''}`),
    select: (d) => d.fields,
  });
export const useLevelNames = (o: string, productId?: string) =>
  useQuery({
    queryKey: qk.levels(o, productId),
    queryFn: () => api<LevelNames>(productId ? `/orgs/${o}/products/${productId}/level-names` : `/orgs/${o}/level-names`),
  });
export const useTokens = (o: string) =>
  useQuery({ queryKey: qk.tokens(o), queryFn: () => api<{ tokens: Token[] }>(`/orgs/${o}/tokens`), select: (d) => d.tokens });

type MutationOptions<TData, TVars> = {
  invalidate?: ReadonlyArray<readonly unknown[]>;
  success?: string;
  /** 为 true 时不弹出错误提示，由表单自己展示 mutation.error。 */
  silentError?: boolean;
  onSuccess?: (data: TData, vars: TVars) => void;
};

export function useApiMutation<TVars, TData = unknown>(fn: (vars: TVars) => Promise<TData>, opts: MutationOptions<TData, TVars> = {}) {
  const qc = useQueryClient();
  return useMutation<TData, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: async (data, vars) => {
      await Promise.all((opts.invalidate ?? []).map((queryKey) => qc.invalidateQueries({ queryKey })));
      if (opts.success) toast.success(opts.success);
      opts.onSuccess?.(data, vars);
    },
    onError: (e) => {
      if (!opts.silentError) toast.error(e.message || '操作失败，请稍后重试');
    },
  });
}
```

`apps/web/src/app/providers.tsx`：

```tsx
'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { type ReactNode, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/api';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          {children}
          <Toaster position="top-center" richColors />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

`apps/web/src/app/layout.tsx`（整体替换）：

```tsx
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/700.css';
import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Flower',
  description: '产品研发管理平台',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

删除 `apps/web/src/app/page.tsx`。

- [ ] **Step 5: 运行测试与构建**

Run: `pnpm --filter @flower/web test api.test && pnpm --filter @flower/web typecheck && pnpm --filter @flower/web build`
Expected: 5 个用例通过；typecheck 无错误；构建成功（此时 `/` 暂无页面，构建仍应成功）。

- [ ] **Step 6: 提交**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): 前端基础：设计 token、shadcn、Provider 与 API 客户端"
```

---

### Task 5: 应用框架：登录守卫、组织侧栏、顶部栏、页面标题

**Files:**
- Create: `apps/web/src/features/shell/nav.ts`、`apps/web/src/features/shell/nav.test.ts`
- Create: `apps/web/src/features/orgs/slug.ts`、`apps/web/src/features/orgs/slug.test.ts`
- Create: `apps/web/src/components/auth-gate.tsx`、`org-shell.tsx`、`user-menu.tsx`、`org-switcher.tsx`、`create-org-dialog.tsx`、`page-header.tsx`、`no-access.tsx`、`require-org-admin.tsx`、`logo.tsx`、`form-error.tsx`
- Create: `apps/web/src/app/(app)/layout.tsx`、`apps/web/src/app/(app)/[org]/layout.tsx`、`apps/web/src/app/(app)/[org]/page.tsx`

**Interfaces:**
- Consumes: Task 4 的 `api`、`ApiError`、`useMe`、`useOrg`、`useSetupStatus`、`useApiMutation`、`qk`、`ORG_ROLE_LABEL`、`cn`
- Produces:
  - `type NavItem = { key: string; label: string; href?: string; icon: NavIcon; phase?: 'P1' | 'P2' }`，`type NavIcon = 'home' | 'list' | 'cycle' | 'doc' | 'users' | 'tag' | 'box' | 'flow' | 'sliders' | 'bot' | 'building'`
  - `buildNav(org: string, orgRole: OrgRole): { main: NavItem[]; settings: NavItem[] }`（非 owner/admin 时 `settings` 为空数组）
  - `activeNavKey(pathname: string, org: string): string`
  - `suggestSlug(name: string): string`
  - `isOrgAdminRole(role: OrgRole): boolean`
  - 组件：`<AuthGate>`、`<OrgShell>`、`<PageHeader crumbs title description actions>`、`<RequireOrgAdmin>`、`<NoAccess>`、`<CreateOrgDialog open onOpenChange>`、`<Logo>`、`<FormError error>`
  - 路由：`(app)/layout.tsx` 包 AuthGate；`(app)/[org]/layout.tsx` 包 OrgShell；`(app)/[org]/page.tsx` 概览页（Task 7 补全内容）

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/shell/nav.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { activeNavKey, buildNav, isOrgAdminRole } from './nav';

describe('buildNav', () => {
  it('管理员看到设置分组，未完成模块带阶段标签且没有链接', () => {
    const nav = buildNav('acme', 'admin');
    expect(nav.main.map((i) => [i.label, i.phase ?? null, i.href ?? null])).toEqual([
      ['概览', null, '/acme'],
      ['需求', 'P1', null],
      ['迭代', 'P1', null],
      ['文档', 'P2', null],
    ]);
    expect(nav.settings.map((i) => i.href)).toEqual([
      '/acme/settings/members',
      '/acme/settings/tags',
      '/acme/settings/products',
      '/acme/settings/workflows',
      '/acme/settings/fields',
      '/acme/settings/agents',
      '/acme/settings/general',
    ]);
  });

  it('成员与访客看不到设置分组', () => {
    expect(buildNav('acme', 'member').settings).toEqual([]);
    expect(buildNav('acme', 'guest').settings).toEqual([]);
    expect(isOrgAdminRole('owner')).toBe(true);
    expect(isOrgAdminRole('member')).toBe(false);
  });

  it('根据路径判断当前导航项', () => {
    expect(activeNavKey('/acme', 'acme')).toBe('home');
    expect(activeNavKey('/acme/settings/members', 'acme')).toBe('members');
    expect(activeNavKey('/acme/settings/workflows/abc', 'acme')).toBe('workflows');
    expect(activeNavKey('/acme/settings/products/1', 'acme')).toBe('products');
  });
});
```

`apps/web/src/features/orgs/slug.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { suggestSlug } from './slug';

describe('suggestSlug', () => {
  it('英文名转小写连字符', () => {
    expect(suggestSlug('Acme Cloud  Inc.')).toBe('acme-cloud-inc');
  });
  it('保留数字，去掉首尾连字符，截断到 40 位', () => {
    expect(suggestSlug('--123 Pan--')).toBe('123-pan');
    expect(suggestSlug('a'.repeat(60))).toHaveLength(40);
  });
  it('没有可用字符时返回空字符串，由用户手动填写', () => {
    expect(suggestSlug('云盘')).toBe('');
  });
});
```

Run: `pnpm --filter @flower/web test nav slug`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现纯逻辑**

`apps/web/src/features/shell/nav.ts`：

```ts
import type { OrgRole } from '@/lib/types';

export type NavIcon = 'home' | 'list' | 'cycle' | 'doc' | 'users' | 'tag' | 'box' | 'flow' | 'sliders' | 'bot' | 'building';
export type NavItem = { key: string; label: string; href?: string; icon: NavIcon; phase?: 'P1' | 'P2' };

export const isOrgAdminRole = (role: OrgRole): boolean => role === 'owner' || role === 'admin';

const SETTINGS: Array<[string, string, NavIcon]> = [
  ['members', '成员', 'users'],
  ['tags', '职能标签', 'tag'],
  ['products', '产品', 'box'],
  ['workflows', '流程模板', 'flow'],
  ['fields', '字段字典', 'sliders'],
  ['agents', 'Agent 与 Token', 'bot'],
  ['general', '组织信息', 'building'],
];

export function buildNav(org: string, orgRole: OrgRole): { main: NavItem[]; settings: NavItem[] } {
  return {
    main: [
      { key: 'home', label: '概览', href: `/${org}`, icon: 'home' },
      { key: 'requirements', label: '需求', icon: 'list', phase: 'P1' },
      { key: 'iterations', label: '迭代', icon: 'cycle', phase: 'P1' },
      { key: 'documents', label: '文档', icon: 'doc', phase: 'P2' },
    ],
    settings: isOrgAdminRole(orgRole)
      ? SETTINGS.map(([key, label, icon]) => ({ key, label, icon, href: `/${org}/settings/${key}` }))
      : [],
  };
}

export function activeNavKey(pathname: string, org: string): string {
  const rest = pathname.replace(new RegExp(`^/${org}`), '');
  const m = /^\/settings\/([^/]+)/.exec(rest);
  return m ? m[1]! : 'home';
}
```

`apps/web/src/features/orgs/slug.ts`：

```ts
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}
```

Run: `pnpm --filter @flower/web test nav slug`
Expected: PASS（6 个用例）。

- [ ] **Step 3: 实现组件**

`apps/web/src/components/logo.tsx`：

```tsx
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="text-primary">
      <g fill="currentColor">
        <circle cx="12" cy="6" r="4" opacity=".9" />
        <circle cx="17.7" cy="10.1" r="4" opacity=".75" />
        <circle cx="15.5" cy="16.8" r="4" opacity=".6" />
        <circle cx="8.5" cy="16.8" r="4" opacity=".75" />
        <circle cx="6.3" cy="10.1" r="4" opacity=".9" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="var(--card)" />
    </svg>
  );
}
```

`apps/web/src/components/form-error.tsx`：

```tsx
import type { ApiError } from '@/lib/api';

export function FormError({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null;
  const details = Array.isArray(error.details) ? (error.details as Array<{ path?: string; message?: string }>) : [];
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <p>{error.message}</p>
      {details.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {details.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`apps/web/src/components/page-header.tsx`：

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';

export type Crumb = { label: string; href?: string };

export function PageHeader({
  crumbs = [],
  title,
  description,
  actions,
}: {
  crumbs?: Crumb[];
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      {crumbs.length > 0 && (
        <nav aria-label="面包屑" className="text-[13px] text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="mx-1.5">/</span>}
              {c.href ? (
                <Link href={c.href} className="hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                c.label
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-xl font-semibold">{title}</h1>
          {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
```

`apps/web/src/components/no-access.tsx`：

```tsx
import { ShieldOff } from 'lucide-react';

export function NoAccess({ message = '你没有访问这个页面的权限。如需开通，请联系组织管理员。' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <ShieldOff className="size-8 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-lg font-semibold">无权访问</h1>
      <p className="max-w-sm text-muted-foreground">{message}</p>
    </div>
  );
}
```

`apps/web/src/components/require-org-admin.tsx`：

```tsx
'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { isOrgAdminRole } from '@/features/shell/nav';
import { useOrg } from '@/lib/queries';
import { NoAccess } from './no-access';

export function RequireOrgAdmin({ children }: { children: ReactNode }) {
  const { org } = useParams<{ org: string }>();
  const q = useOrg(org);
  if (!q.data) return null;
  return isOrgAdminRole(q.data.me.orgRole) ? <>{children}</> : <NoAccess />;
}
```

`apps/web/src/components/auth-gate.tsx`：

```tsx
'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { useMe, useSetupStatus } from '@/lib/queries';

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const setup = useSetupStatus();
  const me = useMe();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    if (setup.data && !setup.data.initialized) router.replace('/setup');
    else if (unauthenticated) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [setup.data, unauthenticated, pathname, router]);

  if (!me.data) {
    return (
      <div className="flex h-screen items-center justify-center" aria-busy="true">
        <Skeleton className="h-6 w-40" />
      </div>
    );
  }
  return <>{children}</>;
}
```

`apps/web/src/components/create-org-dialog.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { suggestSlug } from '@/features/orgs/slug';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Org } from '@/lib/types';
import { FormError } from './form-error';

export function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const m = useApiMutation((v: { name: string; slug: string }) => api<{ org: Org }>('/orgs', { method: 'POST', body: v }), {
    invalidate: [qk.me],
    success: '组织已创建',
    silentError: true,
    onSuccess: (d) => {
      onOpenChange(false);
      router.push(`/${d.org.slug}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate({ name, slug });
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>新建组织</DialogTitle>
            <DialogDescription>组织标识会出现在网址中，创建后不能修改。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-org-name">组织名称</Label>
            <Input
              id="new-org-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(suggestSlug(e.target.value));
              }}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-org-slug">组织标识</Label>
            <Input
              id="new-org-slug"
              className="font-mono"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="例如 pan"
              required
            />
          </div>
          <FormError error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={m.isPending}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/components/org-switcher.tsx`：

```tsx
'use client';

import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ORG_ROLE_LABEL } from '@/lib/labels';
import { useMe, useSetupStatus } from '@/lib/queries';
import { CreateOrgDialog } from './create-org-dialog';

export function OrgSwitcher({ current }: { current: string }) {
  const router = useRouter();
  const me = useMe();
  const setup = useSetupStatus();
  const [creating, setCreating] = useState(false);
  const orgs = me.data?.orgs ?? [];
  const active = orgs.find((o) => o.slug === current);
  const canCreate = Boolean(me.data?.account.isInstanceAdmin || setup.data?.allowOrgCreation);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            {(active?.name ?? current).slice(0, 1)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-semibold">{active?.name ?? current}</span>
            <span className="text-xs text-muted-foreground">{active ? ORG_ROLE_LABEL[active.role] : ''}</span>
          </span>
          <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>我加入的组织</DropdownMenuLabel>
          {orgs.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => router.push(`/${o.slug}`)}>
              <span className="flex-1 truncate">{o.name}</span>
              {o.slug === current && <Check className="size-4" aria-hidden="true" />}
            </DropdownMenuItem>
          ))}
          {canCreate && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreating(true)}>
                <Plus className="size-4" aria-hidden="true" />
                新建组织
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
```

`apps/web/src/components/user-menu.tsx`：

```tsx
'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, Moon, Server, Settings, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { useMe } from '@/lib/queries';

export function UserMenu() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const { theme, setTheme } = useTheme();
  const account = me.data?.account;
  if (!account) return null;
  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    router.replace('/login');
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="个人菜单"
        className="flex items-center gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground">
          {account.name.slice(0, 1)}
        </span>
        <span className="text-[13px] font-medium">{account.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="font-medium">{account.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{account.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/settings')}>
          <Settings className="size-4" aria-hidden="true" />
          个人设置
        </DropdownMenuItem>
        {account.isInstanceAdmin && (
          <DropdownMenuItem onSelect={() => router.push('/admin')}>
            <Server className="size-4" aria-hidden="true" />
            实例设置
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">主题</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? 'light'} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4" aria-hidden="true" />
            浅色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4" aria-hidden="true" />
            深色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-4" aria-hidden="true" />
            跟随系统
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>
          <LogOut className="size-4" aria-hidden="true" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

`apps/web/src/components/org-shell.tsx`：

```tsx
'use client';

import {
  Blocks,
  Bot,
  Box,
  Building2,
  FileText,
  Home,
  List,
  RefreshCw,
  SlidersHorizontal,
  Tag,
  Users,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { activeNavKey, buildNav, type NavIcon, type NavItem } from '@/features/shell/nav';
import { ApiError } from '@/lib/api';
import { useOrg } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import { NoAccess } from './no-access';
import { OrgSwitcher } from './org-switcher';
import { UserMenu } from './user-menu';

const ICONS: Record<NavIcon, typeof Home> = {
  home: Home,
  list: List,
  cycle: RefreshCw,
  doc: FileText,
  users: Users,
  tag: Tag,
  box: Box,
  flow: Workflow,
  sliders: SlidersHorizontal,
  bot: Bot,
  building: Building2,
};

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = ICONS[item.icon] ?? Blocks;
  const cls = 'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm';
  if (!item.href) {
    return (
      <span aria-disabled="true" className={cn(cls, 'cursor-not-allowed text-muted-foreground opacity-60')}>
        <Icon className="size-4" aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
        <span className="rounded-sm border px-1.5 font-mono text-[10px]">{item.phase}</span>
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(cls, active ? 'bg-accent font-semibold text-accent-foreground' : 'text-foreground hover:bg-muted')}
    >
      <Icon className="size-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}

export function OrgShell({ children }: { children: ReactNode }) {
  const { org } = useParams<{ org: string }>();
  const pathname = usePathname();
  const q = useOrg(org);
  if (q.error instanceof ApiError && q.error.status === 404) {
    return <NoAccess message="组织不存在，或者你还不是这个组织的成员。" />;
  }
  if (!q.data) return null;
  const nav = buildNav(org, q.data.me.orgRole);
  const active = activeNavKey(pathname, org);
  return (
    <div className="flex min-h-screen">
      <nav aria-label="主导航" className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-4 border-r bg-sidebar px-3 py-4">
        <Link href="/" className="flex items-center gap-2 px-2 font-bold">
          <Logo />
          Flower
        </Link>
        <OrgSwitcher current={org} />
        <div className="flex flex-col gap-0.5">
          {nav.main.map((i) => (
            <NavLink key={i.key} item={i} active={i.key === active} />
          ))}
        </div>
        {nav.settings.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 text-[11px] tracking-widest text-muted-foreground">组织设置</div>
            {nav.settings.map((i) => (
              <NavLink key={i.key} item={i} active={i.key === active} />
            ))}
          </div>
        )}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center justify-end border-b bg-card px-6">
          <UserMenu />
        </div>
        <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-5 px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
```

`apps/web/src/app/(app)/layout.tsx`：

```tsx
import type { ReactNode } from 'react';
import { AuthGate } from '@/components/auth-gate';

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
```

`apps/web/src/app/(app)/[org]/layout.tsx`：

```tsx
import type { ReactNode } from 'react';
import { OrgShell } from '@/components/org-shell';

export default function OrgLayout({ children }: { children: ReactNode }) {
  return <OrgShell>{children}</OrgShell>;
}
```

`apps/web/src/app/(app)/[org]/page.tsx`（Task 7 会替换为完整概览）：

```tsx
'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { useOrg } from '@/lib/queries';

export default function OrgOverviewPage() {
  const { org } = useParams<{ org: string }>();
  const q = useOrg(org);
  return <PageHeader title={q.data?.org.name ?? ''} description="组织概览" />;
}
```

- [ ] **Step 4: 运行测试与构建**

Run: `pnpm --filter @flower/web test nav slug && pnpm --filter @flower/web typecheck && pnpm --filter @flower/web build`
Expected: 测试通过；typecheck 无错误；构建成功。

- [ ] **Step 5: 提交**

```bash
git add apps/web
git commit -m "feat(web): 应用框架：登录守卫、组织侧栏与顶部栏"
```

---

### Task 6: 初始化向导、登录、注册、接受邀请，以及端到端测试框架

**Files:**
- Create: `apps/web/src/app/(auth)/layout.tsx`、`(auth)/setup/page.tsx`、`(auth)/login/page.tsx`、`(auth)/register/page.tsx`
- Create: `apps/web/src/app/invite/[token]/page.tsx`
- Create: `apps/web/playwright.config.ts`、`apps/web/e2e/db.ts`、`apps/web/e2e/global-setup.ts`、`apps/web/e2e/helpers.ts`、`apps/web/e2e/auth.spec.ts`
- Modify: `apps/web/package.json`（script `e2e`）、`.gitignore`（`test-results/`、`playwright-report/`）

**Interfaces:**
- Consumes: Task 4、5 的全部导出
- Produces:
  - e2e：`resetDatabase(): Promise<void>`（重建 `flower_e2e` 并迁移）；`OWNER = { email: 'owner@example.com', password: 'password123', name: '林澄' }`；`setupInstance(request: APIRequestContext, org?: { name: string; slug: string }): Promise<void>`（默认组织"测试组织 / acme"）；`login(page: Page, email: string, password: string): Promise<void>`
  - 页面：`/setup`、`/login?next=`、`/register`、`/invite/[token]`

- [ ] **Step 1: 搭建端到端测试框架**

```bash
pnpm --filter @flower/web exec playwright install chromium
```

`apps/web/playwright.config.ts`：

```ts
import { defineConfig, devices } from '@playwright/test';
import { E2E_APP_URL } from './e2e/db';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:3100', locale: 'zh-CN', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'pnpm exec next dev --port 3100',
    port: 3100,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: E2E_APP_URL,
      FLOWER_SECRET_KEY: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
      FLOWER_PUBLIC_URL: 'http://localhost:3100',
    },
  },
});
```

`apps/web/e2e/db.ts`：

```ts
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';

const ADMIN = 'postgres://flower_admin:flower_admin@localhost:54329';
export const E2E_DB = 'flower_e2e';
export const E2E_APP_PASSWORD = 'flower_app_test';
export const E2E_APP_URL = `postgres://flower_app:${E2E_APP_PASSWORD}@localhost:54329/${E2E_DB}`;
const REPO = path.resolve(__dirname, '../../..');

/** 删除并重建 flower_e2e，再用 core 的迁移 CLI 迁移。服务端连接池会在下次查询时自动重连。 */
export async function resetDatabase(): Promise<void> {
  const sql = postgres(`${ADMIN}/postgres`, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${E2E_DB}`);
  } finally {
    await sql.end();
  }
  execFileSync('node', ['packages/core/dist/migrate.mjs'], {
    cwd: REPO,
    stdio: 'pipe',
    env: {
      ...process.env,
      DATABASE_URL: E2E_APP_URL,
      DATABASE_ADMIN_URL: `${ADMIN}/${E2E_DB}`,
      FLOWER_APP_DB_PASSWORD: E2E_APP_PASSWORD,
      FLOWER_SECRET_KEY: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
      FLOWER_MIGRATIONS_DIR: 'packages/core/migrations',
    },
  });
}
```

`apps/web/e2e/global-setup.ts`：

```ts
import { execSync } from 'node:child_process';
import path from 'node:path';
import { resetDatabase } from './db';

export default async function globalSetup() {
  execSync('pnpm --filter @flower/core build:migrate', { cwd: path.resolve(__dirname, '../../..'), stdio: 'pipe' });
  await resetDatabase();
}
```

`apps/web/e2e/helpers.ts`：

```ts
import { type APIRequestContext, expect, type Page } from '@playwright/test';

export const OWNER = { email: 'owner@example.com', password: 'password123', name: '林澄' };

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
```

`apps/web/package.json` 的 `scripts` 加入 `"e2e": "playwright test"`；根 `.gitignore` 追加：

```
test-results/
playwright-report/
```

- [ ] **Step 2: 写失败的端到端测试**

`apps/web/e2e/auth.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.describe('初始化与登录', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('未初始化时访问首页进入向导，完成三步后进入组织', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL('**/setup');
    await page.getByLabel('你的姓名').fill(OWNER.name);
    await page.getByLabel('邮箱').fill(OWNER.email);
    await page.getByLabel('密码', { exact: true }).fill(OWNER.password);
    await page.getByLabel('确认密码').fill(OWNER.password);
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('组织名称').fill('Acme Cloud');
    await expect(page.getByLabel('组织标识')).toHaveValue('acme-cloud');
    await page.getByRole('button', { name: '完成初始化' }).click();
    await expect(page.getByRole('heading', { name: '初始化完成' })).toBeVisible();
    await page.getByRole('link', { name: '进入组织' }).click();
    await page.waitForURL('**/acme-cloud');
    await expect(page.getByRole('navigation', { name: '主导航' }).getByText('成员')).toBeVisible();
    await expect(page.getByText('P1').first()).toBeVisible();
  });

  test('登录失败提示、登录成功、退出登录', async ({ page, request }) => {
    await setupInstance(request);
    await page.goto('/login');
    await page.getByLabel('邮箱').fill(OWNER.email);
    await page.getByLabel('密码').fill('wrong-password');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('alert')).toContainText('邮箱或密码错误');
    await login(page, OWNER.email, OWNER.password);
    await page.waitForURL('**/acme');
    await page.getByRole('button', { name: '个人菜单' }).click();
    await page.getByRole('menuitem', { name: '退出登录' }).click();
    await page.waitForURL('**/login');
    await expect(page.getByRole('link', { name: '注册' })).toHaveCount(0);
  });

  test('新用户通过邀请链接注册加入，普通成员看不到组织设置', async ({ page, request, browser }) => {
    await setupInstance(request);
    const inv = await request.post('/api/v1/orgs/acme/invitations', { data: { email: 'new@example.com', orgRole: 'member' } });
    const { token } = (await inv.json()) as { token: string };

    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    await guest.goto(`/invite/${token}`);
    await expect(guest.getByText('测试组织 邀请你加入')).toBeVisible();
    await guest.getByLabel('你的姓名').fill('新人');
    await guest.getByLabel('设置密码').fill('password123');
    await guest.getByRole('button', { name: '接受邀请' }).click();
    await guest.waitForURL('**/acme');
    await expect(guest.getByText('组织设置')).toHaveCount(0);
    await guest.goto('/acme/settings/members');
    await expect(guest.getByRole('heading', { name: '无权访问' })).toBeVisible();
    await ctx.close();
    await page.close();
  });
});
```

说明：`request` 夹具与 `page` 共享 cookie 存储，`setupInstance` 之后 `request` 已登录为 owner，所以能直接创建邀请。第三个用例在 Task 8 实现成员页之前，访问 `/acme/settings/members` 会得到 404；该断言在 Task 8 之后才会通过——本任务只需前两个用例通过，第三个用例先用 `test.fixme` 标记，Task 8 去掉标记。

把第三个用例的 `test(` 改为 `test.fixme(`。

Run: `pnpm --filter @flower/web e2e auth.spec.ts`
Expected: FAIL（`/setup`、`/login` 页面不存在）。

- [ ] **Step 3: 实现页面**

`apps/web/src/app/(auth)/layout.tsx`：

```tsx
import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <div className="flex items-center gap-2 text-lg font-bold">
        <Logo size={26} />
        Flower
      </div>
      <div className="w-full max-w-[420px] rounded-lg border bg-card p-6 shadow-sm">{children}</div>
    </div>
  );
}
```

`apps/web/src/app/(auth)/setup/page.tsx`：

```tsx
'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { suggestSlug } from '@/features/orgs/slug';
import { ApiError, api } from '@/lib/api';
import { qk, useApiMutation, useSetupStatus } from '@/lib/queries';

export default function SetupPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const status = useSetupStatus();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [admin, setAdmin] = useState({ name: '', email: '', password: '', confirm: '' });
  const [org, setOrg] = useState({ name: '', slug: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const m = useApiMutation(
    () => api<{ org: { slug: string } }>('/setup', { method: 'POST', body: { admin: { name: admin.name, email: admin.email, password: admin.password }, org } }),
    {
      silentError: true,
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: qk.setup });
        qc.invalidateQueries({ queryKey: qk.me });
        setStep(3);
      },
    },
  );

  useEffect(() => {
    if (status.data?.initialized && step !== 3) router.replace('/login');
  }, [status.data, step, router]);

  if (step === 3) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">初始化完成</h1>
        <p className="text-muted-foreground">
          你已成为实例管理员，组织「{org.name}」已创建。接下来可以邀请团队成员，或先去配置流程与字典。
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/${org.slug}/settings/members`}>邀请成员</Link>
          </Button>
          <Button asChild>
            <Link href={`/${org.slug}`}>进入组织</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (step === 1) {
          if (admin.password !== admin.confirm) return setLocalError('两次输入的密码不一致');
          setLocalError(null);
          return setStep(2);
        }
        m.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted-foreground">步骤 {step} / 3</span>
        <h1 className="text-xl font-semibold">{step === 1 ? '创建管理员账号' : '创建第一个组织'}</h1>
        <p className="text-[13px] text-muted-foreground">
          {step === 1 ? '这个账号将成为实例管理员，负责实例设置和第一个组织。' : '组织标识会出现在网址中，创建后不能修改。'}
        </p>
      </div>
      {step === 1 ? (
        <>
          <Field id="s-name" label="你的姓名" value={admin.name} onChange={(v) => setAdmin({ ...admin, name: v })} />
          <Field id="s-email" label="邮箱" type="email" value={admin.email} onChange={(v) => setAdmin({ ...admin, email: v })} />
          <Field id="s-pw" label="密码" type="password" value={admin.password} onChange={(v) => setAdmin({ ...admin, password: v })} hint="至少 8 位" />
          <Field id="s-pw2" label="确认密码" type="password" value={admin.confirm} onChange={(v) => setAdmin({ ...admin, confirm: v })} />
        </>
      ) : (
        <>
          <Field
            id="s-org"
            label="组织名称"
            value={org.name}
            onChange={(v) => setOrg({ name: v, slug: slugTouched ? org.slug : suggestSlug(v) })}
          />
          <Field
            id="s-slug"
            label="组织标识"
            mono
            value={org.slug}
            onChange={(v) => {
              setSlugTouched(true);
              setOrg({ ...org, slug: v });
            }}
            hint="小写字母、数字和连字符"
          />
        </>
      )}
      {localError && (
        <p role="alert" className="text-sm text-destructive">
          {localError}
        </p>
      )}
      <FormError error={m.error instanceof ApiError ? m.error : null} />
      <div className="flex justify-between">
        {step === 2 ? (
          <Button type="button" variant="ghost" onClick={() => setStep(1)}>
            上一步
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={m.isPending}>
          {step === 1 ? '下一步' : '完成初始化'}
        </Button>
      </div>
    </form>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type={props.type ?? 'text'}
        required
        className={props.mono ? 'font-mono' : undefined}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span className="text-xs text-muted-foreground">{props.hint}</span>}
    </div>
  );
}
```

`apps/web/src/app/(auth)/login/page.tsx`：

```tsx
'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { qk, useApiMutation, useSetupStatus } from '@/lib/queries';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const status = useSetupStatus();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const next = params.get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const m = useApiMutation(() => api('/auth/login', { method: 'POST', body: { email, password } }), {
    silentError: true,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.me });
      router.replace(target);
    },
  });

  useEffect(() => {
    if (status.data && !status.data.initialized) router.replace('/setup');
  }, [status.data, router]);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate(undefined);
      }}
    >
      <h1 className="text-xl font-semibold">登录</h1>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="l-email">邮箱</Label>
        <Input id="l-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="l-pw">密码</Label>
        <Input
          id="l-pw"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <FormError error={m.error} />
      <Button type="submit" disabled={m.isPending}>
        登录
      </Button>
      {status.data?.allowSignup && (
        <p className="text-center text-[13px] text-muted-foreground">
          还没有账号？
          <Link href="/register" className="text-primary hover:underline">
            注册
          </Link>
        </p>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
```

`apps/web/src/app/(auth)/register/page.tsx`：

```tsx
'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { qk, useApiMutation, useSetupStatus } from '@/lib/queries';

export default function RegisterPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const status = useSetupStatus();
  const [v, setV] = useState({ name: '', email: '', password: '' });
  const m = useApiMutation(() => api('/auth/register', { method: 'POST', body: v }), {
    silentError: true,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.me });
      router.replace('/');
    },
  });
  if (status.data && !status.data.allowSignup) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">暂不开放注册</h1>
        <p className="text-muted-foreground">当前实例仅支持邀请加入。请向组织管理员索取邀请链接。</p>
        <Link href="/login" className="text-primary hover:underline">
          返回登录
        </Link>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate(undefined);
      }}
    >
      <h1 className="text-xl font-semibold">注册</h1>
      {(['name', 'email', 'password'] as const).map((k) => (
        <div key={k} className="flex flex-col gap-1.5">
          <Label htmlFor={`r-${k}`}>{{ name: '姓名', email: '邮箱', password: '密码' }[k]}</Label>
          <Input
            id={`r-${k}`}
            type={k === 'password' ? 'password' : k === 'email' ? 'email' : 'text'}
            required
            value={v[k]}
            onChange={(e) => setV({ ...v, [k]: e.target.value })}
          />
        </div>
      ))}
      <FormError error={m.error} />
      <Button type="submit" disabled={m.isPending}>
        注册
      </Button>
    </form>
  );
}
```

`apps/web/src/app/invite/[token]/page.tsx`：

```tsx
'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { qk, useApiMutation, useMe } from '@/lib/queries';
import type { InvitationPreview } from '@/lib/types';

const STATUS_TEXT = { expired: '邀请已过期，请联系管理员重新发送。', accepted: '这个邀请已经被接受。', revoked: '邀请已被撤销。' } as const;

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => api<InvitationPreview>(`/invitations/${token}`) });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const accept = useApiMutation(
    (body: { name?: string; password?: string }) => api<{ orgSlug: string }>(`/invitations/${token}/accept`, { method: 'POST', body }),
    {
      silentError: true,
      onSuccess: async (d) => {
        await qc.invalidateQueries({ queryKey: qk.me });
        router.replace(`/${d.orgSlug}`);
      },
    },
  );
  const p = preview.data;
  let body: React.ReactNode = null;
  if (preview.isError) body = <p className="text-muted-foreground">邀请不存在，请确认链接是否完整。</p>;
  else if (p && p.status !== 'pending') body = <p className="text-muted-foreground">{STATUS_TEXT[p.status]}</p>;
  else if (p && me.data) {
    body =
      me.data.account.email === p.email ? (
        <Button onClick={() => accept.mutate({})} disabled={accept.isPending}>
          以 {me.data.account.name} 的身份加入
        </Button>
      ) : (
        <p className="text-muted-foreground">
          这个邀请发给了 <span className="font-mono">{p.email}</span>，而你当前登录的是 <span className="font-mono">{me.data.account.email}</span>。请退出后用受邀邮箱登录。
        </p>
      );
  } else if (p && p.accountExists) {
    body = (
      <Button asChild>
        <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>登录后加入</Link>
      </Button>
    );
  } else if (p) {
    body = (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          accept.mutate({ name, password });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label>邮箱</Label>
          <Input value={p.email} readOnly className="font-mono" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="i-name">你的姓名</Label>
          <Input id="i-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="i-pw">设置密码</Label>
          <Input id="i-pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Button type="submit" disabled={accept.isPending}>
          接受邀请
        </Button>
      </form>
    );
  }
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <div className="flex items-center gap-2 text-lg font-bold">
        <Logo size={26} />
        Flower
      </div>
      <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-lg border bg-card p-6 shadow-sm">
        {p && <h1 className="text-xl font-semibold">{p.orgName} 邀请你加入</h1>}
        {body}
        <FormError error={accept.error} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/web e2e auth.spec.ts && pnpm --filter @flower/web typecheck`
Expected: 2 passed、1 fixme（跳过）；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add apps/web .gitignore pnpm-lock.yaml
git commit -m "feat(web): 初始化向导、登录注册、接受邀请与端到端测试框架"
```

---

### Task 7: 首页与组织概览（组织配置清单）

**Files:**
- Create: `apps/web/src/features/overview/checklist.ts`、`checklist.test.ts`
- Create: `apps/web/src/app/(app)/page.tsx`
- Modify: `apps/web/src/app/(app)/[org]/page.tsx`
- Test: `apps/web/e2e/overview.spec.ts`

**Interfaces:**
- Consumes: `useMe`、`useOrg`、`useMembers`、`useInvitations`、`useProducts`、`useWorkflows`、`useFields`、`useTokens`、`PageHeader`、`CreateOrgDialog`、`isOrgAdminRole`、`PRODUCT_ROLE_LABEL`
- Produces: `type ChecklistItem = { key: string; label: string; description: string; done: boolean; href: string }`；`computeChecklist(org: string, d: { members: Member[]; invitations: Invitation[]; products: Product[]; workflows: WorkflowDefinition[]; fields: Field[]; tokens: Token[] }): ChecklistItem[]`

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/overview/checklist.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { computeChecklist } from './checklist';

const base = { members: [], invitations: [], products: [], workflows: [], fields: [], tokens: [] };
const member = (over: Record<string, unknown>) =>
  ({ id: 'm', kind: 'human', displayName: 'x', email: null, department: null, orgRole: 'member', status: 'active', hasAccount: true, functionTagIds: [], productRoles: [], ...over }) as never;

describe('computeChecklist', () => {
  it('新组织全部未完成，且顺序固定', () => {
    const items = computeChecklist('acme', base);
    expect(items.map((i) => [i.key, i.done])).toEqual([
      ['invite', false],
      ['tags', false],
      ['product', false],
      ['workflow', false],
      ['fields', false],
      ['agent', false],
    ]);
    expect(items[0]!.href).toBe('/acme/settings/members');
  });

  it('按实际数据判断完成', () => {
    const items = computeChecklist('acme', {
      members: [member({ id: '1' }), member({ id: '2', functionTagIds: ['t'] }), member({ id: '3', kind: 'agent', hasAccount: false })],
      invitations: [],
      products: [{ id: 'p' }] as never,
      workflows: [{ id: 'w', currentVersion: 2, productId: null }] as never,
      fields: [{ key: 'platform', options: [{ id: 'o' }] }] as never,
      tokens: [{ id: 't', memberId: '3', revokedAt: null }] as never,
    });
    expect(items.every((i) => i.done)).toBe(true);
  });

  it('只有待接受的邀请也算完成"邀请成员"', () => {
    const items = computeChecklist('acme', { ...base, invitations: [{ id: 'i', acceptedAt: null, revokedAt: null }] as never });
    expect(items.find((i) => i.key === 'invite')!.done).toBe(true);
  });
});
```

Run: `pnpm --filter @flower/web test checklist`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现清单逻辑**

`apps/web/src/features/overview/checklist.ts`：

```ts
import type { Field, Invitation, Member, Product, Token, WorkflowDefinition } from '@/lib/types';

export type ChecklistItem = { key: string; label: string; description: string; done: boolean; href: string };

export function computeChecklist(
  org: string,
  d: { members: Member[]; invitations: Invitation[]; products: Product[]; workflows: WorkflowDefinition[]; fields: Field[]; tokens: Token[] },
): ChecklistItem[] {
  const humansWithAccount = d.members.filter((m) => m.kind === 'human' && m.hasAccount && m.status === 'active');
  const agents = new Set(d.members.filter((m) => m.kind === 'agent').map((m) => m.id));
  const s = (p: string) => `/${org}/settings/${p}`;
  return [
    {
      key: 'invite',
      label: '邀请成员',
      description: '邀请团队加入，或先登记没有账号的业务提出人。',
      done: humansWithAccount.length > 1 || d.invitations.some((i) => !i.acceptedAt && !i.revokedAt),
      href: s('members'),
    },
    {
      key: 'tags',
      label: '配置职能标签',
      description: '给成员打上产品经理、设计、开发等标签，用于指定签字人。',
      done: d.members.some((m) => m.functionTagIds.length > 0),
      href: s('tags'),
    },
    { key: 'product', label: '创建产品', description: '设定产品名称和编号前缀，例如 PAN。', done: d.products.length > 0, href: s('products') },
    {
      key: 'workflow',
      label: '配置需求流程',
      description: '按团队的实际流程编辑状态、流转和检查项。',
      done: d.workflows.some((w) => (w.currentVersion ?? 0) > 1) || d.workflows.filter((w) => w.productId === null).length > 1,
      href: s('workflows'),
    },
    {
      key: 'fields',
      label: '补充字段字典',
      description: '为平台、来源、业务线等字段添加选项。',
      done: d.fields.some((f) => f.key === 'platform' && f.options.length > 0),
      href: s('fields'),
    },
    {
      key: 'agent',
      label: '接入 Agent',
      description: '创建 Agent 成员并签发有范围限制的 Token。',
      done: d.tokens.some((t) => agents.has(t.memberId) && !t.revokedAt),
      href: s('agents'),
    },
  ];
}
```

Run: `pnpm --filter @flower/web test checklist`
Expected: PASS（3 个用例）。

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/overview.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

test('只有一个组织时首页直接进入该组织；管理员看到配置清单', async ({ page, request }) => {
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await expect(page.getByRole('heading', { name: '测试组织' })).toBeVisible();
  const list = page.getByRole('list', { name: '组织配置清单' });
  await expect(list.getByRole('listitem')).toHaveCount(6);
  await expect(page.getByText('已完成 0 / 6')).toBeVisible();
  await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  await page.reload();
  await expect(page.getByText('已完成 1 / 6')).toBeVisible();
  await expect(page.getByRole('link', { name: /网盘/ })).toBeVisible();
});
```

Run: `pnpm --filter @flower/web e2e overview.spec.ts`
Expected: FAIL（首页不存在；概览没有清单）。

- [ ] **Step 4: 实现页面**

`apps/web/src/app/(app)/page.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CreateOrgDialog } from '@/components/create-org-dialog';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { UserMenu } from '@/components/user-menu';
import { ORG_ROLE_LABEL, PRODUCT_ROLE_LABEL } from '@/lib/labels';
import { useMe, useSetupStatus } from '@/lib/queries';

export default function HomePage() {
  const router = useRouter();
  const me = useMe();
  const setup = useSetupStatus();
  const [creating, setCreating] = useState(false);
  const orgs = me.data?.orgs ?? [];
  const canCreate = Boolean(me.data?.account.isInstanceAdmin || setup.data?.allowOrgCreation);

  useEffect(() => {
    if (orgs.length === 1) router.replace(`/${orgs[0]!.slug}`);
  }, [orgs, router]);

  return (
    <div className="min-h-screen">
      <div className="flex h-12 items-center justify-between border-b bg-card px-6">
        <span className="flex items-center gap-2 font-bold">
          <Logo />
          Flower
        </span>
        <UserMenu />
      </div>
      <main className="mx-auto flex max-w-[960px] flex-col gap-5 px-8 py-8">
        <div className="flex items-end justify-between">
          <h1 className="text-xl font-semibold">我的组织</h1>
          {canCreate && <Button onClick={() => setCreating(true)}>新建组织</Button>}
        </div>
        {orgs.length === 0 ? (
          <p className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
            你还没有加入任何组织。{canCreate ? '可以新建一个组织，或' : ''}请向组织管理员索取邀请链接。
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-4">
            {orgs.map((o) => (
              <li key={o.id}>
                <Link href={`/${o.slug}`} className="flex flex-col gap-3 rounded-lg border bg-card p-4 hover:border-primary">
                  <span className="flex items-center justify-between">
                    <span className="font-semibold">{o.name}</span>
                    <span className="text-xs text-muted-foreground">{ORG_ROLE_LABEL[o.role]}</span>
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {o.products.map((p) => (
                      <span key={p.id} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                        <span className="font-mono">{p.key}</span> {p.name} · {PRODUCT_ROLE_LABEL[p.role]}
                      </span>
                    ))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
```

`apps/web/src/app/(app)/[org]/page.tsx`（整体替换）：

```tsx
'use client';

import { CheckCircle2, Circle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { computeChecklist } from '@/features/overview/checklist';
import { isOrgAdminRole } from '@/features/shell/nav';
import { PRODUCT_ROLE_LABEL } from '@/lib/labels';
import { useFields, useInvitations, useMembers, useOrg, useProducts, useTokens, useWorkflows } from '@/lib/queries';
import { cn } from '@/lib/utils';

function Checklist({ org }: { org: string }) {
  const members = useMembers(org);
  const invitations = useInvitations(org);
  const products = useProducts(org);
  const workflows = useWorkflows(org);
  const fields = useFields(org);
  const tokens = useTokens(org);
  const all = [members, invitations, products, workflows, fields, tokens];
  if (all.some((q) => !q.data)) return null;
  const items = computeChecklist(org, {
    members: members.data!,
    invitations: invitations.data!,
    products: products.data!,
    workflows: workflows.data!,
    fields: fields.data!,
    tokens: tokens.data!,
  });
  const done = items.filter((i) => i.done).length;
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-semibold">组织配置清单</h2>
        <span className="font-mono text-xs text-muted-foreground">
          已完成 {done} / {items.length}
        </span>
      </div>
      <ul aria-label="组织配置清单" className="divide-y">
        {items.map((i) => (
          <li key={i.key}>
            <Link href={i.href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted">
              {i.done ? (
                <CheckCircle2 className="size-4 text-primary" aria-label="已完成" />
              ) : (
                <Circle className="size-4 text-muted-foreground" aria-label="未完成" />
              )}
              <span className={cn('w-32 font-medium', i.done && 'text-muted-foreground line-through')}>{i.label}</span>
              <span className="text-[13px] text-muted-foreground">{i.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function OrgOverviewPage() {
  const { org } = useParams<{ org: string }>();
  const q = useOrg(org);
  const products = useProducts(org);
  if (!q.data) return null;
  const admin = isOrgAdminRole(q.data.me.orgRole);
  return (
    <>
      <PageHeader title={q.data.org.name} description={admin ? '按清单完成组织配置后，团队就可以开始使用。' : '你可以访问的产品'} />
      {admin && <Checklist org={org} />}
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">产品</h2>
        {products.data && products.data.length === 0 ? (
          <p className="text-muted-foreground">还没有产品。</p>
        ) : (
          <ul className="grid grid-cols-3 gap-3">
            {products.data?.map((p) => (
              <li key={p.id}>
                <Link
                  href={p.myRole === 'admin' ? `/${org}/settings/products/${p.id}` : `/${org}`}
                  className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 hover:border-primary"
                >
                  <span>
                    <span className="mr-2 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">{p.key}</span>
                    {p.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{PRODUCT_ROLE_LABEL[p.myRole]}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/web test && pnpm --filter @flower/web e2e overview.spec.ts auth.spec.ts && pnpm --filter @flower/web typecheck`
Expected: 全部通过（auth 第三个用例仍为 fixme）。

- [ ] **Step 6: 提交**

```bash
git add apps/web
git commit -m "feat(web): 首页与组织概览配置清单"
```

---

### Task 8: 成员管理（列表、筛选、邀请、登记无账号成员、详情抽屉、待接受邀请）

**Files:**
- Create: `apps/web/src/features/members/model.ts`、`model.test.ts`
- Create: `apps/web/src/components/empty-state.tsx`、`confirm-action.tsx`、`copy-field.tsx`
- Create: `apps/web/src/app/(app)/[org]/settings/members/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/settings/members/member-drawer.tsx`、`invite-dialog.tsx`、`placeholder-dialog.tsx`、`invitations-tab.tsx`
- Modify: `apps/web/e2e/auth.spec.ts`（去掉第三个用例的 `fixme`）
- Test: `apps/web/e2e/members.spec.ts`

**Interfaces:**
- Consumes: `useMembers`、`useInvitations`、`useFunctionTags`、`useProducts`、`useProductRoles`、`useApiMutation`、`qk`、`api`、`PageHeader`、`RequireOrgAdmin`、`FormError`、`ORG_ROLE_LABEL`、`PRODUCT_ROLE_LABEL`
- Produces:
  - `type MemberFilter = { query: string; kind: 'all' | 'account' | 'none' | 'agent'; role: 'all' | OrgRole; includeLeft: boolean }`
  - `memberKind(m: Member): 'account' | 'none' | 'agent'`；`filterMembers(members: Member[], f: MemberFilter): Member[]`；`invitationState(i: Invitation, now?: Date): 'pending' | 'expired' | 'accepted' | 'revoked'`
  - 组件：`<EmptyState icon title description action?>`、`<ConfirmAction title description confirmLabel destructive? onConfirm trigger>`、`<CopyField value label>`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/members/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { Invitation, Member } from '@/lib/types';
import { filterMembers, invitationState, memberKind } from './model';

const m = (over: Partial<Member>): Member => ({
  id: 'x', kind: 'human', displayName: '成员', email: null, department: null, orgRole: 'member', status: 'active',
  hasAccount: true, functionTagIds: [], productRoles: [], ...over,
});
const all = [
  m({ id: '1', displayName: '林澄', email: 'lin@example.com', orgRole: 'owner' }),
  m({ id: '2', displayName: '王总', hasAccount: false, department: '商务部' }),
  m({ id: '3', displayName: 'PRD 助手', kind: 'agent', hasAccount: false }),
  m({ id: '4', displayName: '沈知', hasAccount: false, orgRole: 'guest', status: 'left' }),
];
const f = { query: '', kind: 'all' as const, role: 'all' as const, includeLeft: false };

describe('成员筛选', () => {
  it('区分账号、无账号、Agent', () => {
    expect(all.map(memberKind)).toEqual(['account', 'none', 'agent', 'none']);
  });
  it('默认隐藏已离开的成员', () => {
    expect(filterMembers(all, f).map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(filterMembers(all, { ...f, includeLeft: true })).toHaveLength(4);
  });
  it('按姓名、邮箱、部门搜索，不区分大小写', () => {
    expect(filterMembers(all, { ...f, query: 'LIN' }).map((x) => x.id)).toEqual(['1']);
    expect(filterMembers(all, { ...f, query: '商务' }).map((x) => x.id)).toEqual(['2']);
  });
  it('按类型与角色筛选', () => {
    expect(filterMembers(all, { ...f, kind: 'agent' }).map((x) => x.id)).toEqual(['3']);
    expect(filterMembers(all, { ...f, role: 'owner' }).map((x) => x.id)).toEqual(['1']);
  });
});

describe('邀请状态', () => {
  const inv = (over: Partial<Invitation>): Invitation => ({
    id: 'i', email: 'a@b.c', orgRole: 'member', memberId: null, expiresAt: '2099-01-01T00:00:00.000Z',
    acceptedAt: null, revokedAt: null, createdAt: '2026-01-01T00:00:00.000Z', ...over,
  });
  it('按接受、撤销、过期、待接受的优先级判断', () => {
    expect(invitationState(inv({ acceptedAt: '2026-01-02T00:00:00.000Z' }))).toBe('accepted');
    expect(invitationState(inv({ revokedAt: '2026-01-02T00:00:00.000Z' }))).toBe('revoked');
    expect(invitationState(inv({ expiresAt: '2020-01-01T00:00:00.000Z' }))).toBe('expired');
    expect(invitationState(inv({}))).toBe('pending');
  });
});
```

Run: `pnpm --filter @flower/web test members/model`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现筛选逻辑**

`apps/web/src/features/members/model.ts`：

```ts
import type { Invitation, Member, OrgRole } from '@/lib/types';

export type MemberFilter = { query: string; kind: 'all' | 'account' | 'none' | 'agent'; role: 'all' | OrgRole; includeLeft: boolean };

export function memberKind(m: Member): 'account' | 'none' | 'agent' {
  if (m.kind === 'agent') return 'agent';
  return m.hasAccount ? 'account' : 'none';
}

export function filterMembers(members: Member[], f: MemberFilter): Member[] {
  const q = f.query.trim().toLowerCase();
  return members.filter((m) => {
    if (!f.includeLeft && m.status === 'left') return false;
    if (f.kind !== 'all' && memberKind(m) !== f.kind) return false;
    if (f.role !== 'all' && m.orgRole !== f.role) return false;
    if (!q) return true;
    return [m.displayName, m.email ?? '', m.department ?? ''].some((s) => s.toLowerCase().includes(q));
  });
}

export function invitationState(i: Invitation, now: Date = new Date()): 'pending' | 'expired' | 'accepted' | 'revoked' {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (new Date(i.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}
```

Run: `pnpm --filter @flower/web test members/model`
Expected: PASS（6 个用例）。

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/members.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/members');
});

test('登记无账号成员，在抽屉中设置部门、职能标签与产品角色', async ({ page }) => {
  await page.getByRole('button', { name: '登记无账号成员' }).click();
  await page.getByLabel('显示名称').fill('王总');
  await page.getByLabel('部门').fill('商务部');
  await page.getByRole('button', { name: '登记' }).click();
  const row = page.getByRole('row', { name: /王总/ });
  await expect(row.getByText('无账号')).toBeVisible();

  await row.getByRole('button', { name: '查看王总' }).click();
  const drawer = page.getByRole('dialog', { name: '王总' });
  await drawer.getByRole('checkbox', { name: '产品经理' }).check();
  await drawer.getByLabel('网盘 的产品角色').click();
  await page.getByRole('option', { name: '只读' }).click();
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(row.getByText('产品经理')).toBeVisible();
});

test('邀请成员后在"待接受邀请"里复制链接与撤销；搜索与筛选', async ({ page }) => {
  await page.getByRole('button', { name: '邀请成员' }).click();
  await page.getByLabel('邮箱').fill('dev@example.com');
  await page.getByRole('button', { name: '发送邀请' }).click();
  await expect(page.getByLabel('邀请链接')).toHaveValue(/\/invite\//);
  await page.getByRole('button', { name: '完成' }).click();

  await page.getByRole('tab', { name: /待接受邀请/ }).click();
  const inv = page.getByRole('row', { name: /dev@example.com/ });
  await expect(inv.getByText('待接受')).toBeVisible();
  await inv.getByRole('button', { name: '撤销' }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(inv.getByText('已撤销')).toBeVisible();

  await page.getByRole('tab', { name: /^成员/ }).click();
  await page.getByPlaceholder('搜索姓名、邮箱或部门').fill('owner');
  await expect(page.getByRole('row')).toHaveCount(2);
});
```

去掉 `apps/web/e2e/auth.spec.ts` 第三个用例的 `.fixme`。

Run: `pnpm --filter @flower/web e2e members.spec.ts`
Expected: FAIL（成员页不存在）。

- [ ] **Step 4: 实现通用组件**

`apps/web/src/components/empty-state.tsx`：

```tsx
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-card px-6 py-12 text-center">
      <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
```

`apps/web/src/components/confirm-action.tsx`：

```tsx
'use client';

import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

export function ConfirmAction(props: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{props.trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={props.onConfirm}
            className={cn(props.destructive && 'bg-destructive text-white hover:bg-destructive/90')}
          >
            {props.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

`apps/web/src/components/copy-field.tsx`：

```tsx
'use client';

import { Check, Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function CopyField({ label, value }: { label: string; value: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
            } catch {
              (document.getElementById(id) as HTMLInputElement | null)?.select();
            }
          }}
        >
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 实现成员页**

`apps/web/src/app/(app)/[org]/settings/members/invite-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { CopyField } from '@/components/copy-field';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Member } from '@/lib/types';

type Role = 'admin' | 'member' | 'guest';

export function InviteDialog({
  org,
  open,
  onOpenChange,
  bindTo,
}: {
  org: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bindTo?: Member | null;
}) {
  const [email, setEmail] = useState(bindTo?.email ?? '');
  const [role, setRole] = useState<Role>('member');
  const [link, setLink] = useState<string | null>(null);
  const m = useApiMutation(
    () =>
      api<{ link: string }>(`/orgs/${org}/invitations`, {
        method: 'POST',
        body: { email, orgRole: role, ...(bindTo ? { memberId: bindTo.id } : {}) },
      }),
    { invalidate: [qk.invitations(org)], silentError: true, onSuccess: (d) => setLink(d.link) },
  );
  function close(v: boolean) {
    if (!v) {
      setLink(null);
      setEmail('');
      m.reset();
    }
    onOpenChange(v);
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bindTo ? `邀请 ${bindTo.displayName} 关联账号` : '邀请成员'}</DialogTitle>
          <DialogDescription>邀请链接 7 天内有效。系统暂不发送邮件，请把链接发给对方。</DialogDescription>
        </DialogHeader>
        {link ? (
          <>
            <CopyField label="邀请链接" value={link} />
            <DialogFooter>
              <Button onClick={() => close(false)}>完成</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate(undefined);
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-email">邮箱</Label>
              <Input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-role">组织角色</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                <SelectTrigger id="inv-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">成员（默认可编辑所有产品）</SelectItem>
                  <SelectItem value="admin">管理员</SelectItem>
                  <SelectItem value="guest">访客（只能访问被授权的产品）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FormError error={m.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                取消
              </Button>
              <Button type="submit" disabled={m.isPending}>
                发送邀请
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/members/placeholder-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';

export function PlaceholderDialog({ org, open, onOpenChange }: { org: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [v, setV] = useState({ displayName: '', department: '', email: '' });
  const m = useApiMutation(
    () =>
      api(`/orgs/${org}/members`, {
        method: 'POST',
        body: { displayName: v.displayName, ...(v.department ? { department: v.department } : {}), ...(v.email ? { email: v.email } : {}) },
      }),
    {
      invalidate: [qk.members(org)],
      success: '已登记',
      silentError: true,
      onSuccess: () => {
        setV({ displayName: '', department: '', email: '' });
        onOpenChange(false);
      },
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>登记无账号成员</DialogTitle>
            <DialogDescription>适合不登录系统的业务提出人。以后发送邀请即可关联账号，历史记录保持不变。</DialogDescription>
          </DialogHeader>
          {(
            [
              ['displayName', '显示名称', true],
              ['department', '部门', false],
              ['email', '邮箱（可选，用于以后邀请）', false],
            ] as const
          ).map(([k, label, required]) => (
            <div key={k} className="flex flex-col gap-1.5">
              <Label htmlFor={`ph-${k}`}>{label}</Label>
              <Input id={`ph-${k}`} required={required} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
            </div>
          ))}
          <FormError error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={m.isPending}>
              登记
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/members/member-drawer.tsx`：

```tsx
'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { memberKind } from '@/features/members/model';
import { ApiError, api } from '@/lib/api';
import { ORG_ROLE_LABEL, PRODUCT_ROLE_LABEL } from '@/lib/labels';
import { qk, useFunctionTags, useProducts } from '@/lib/queries';
import type { Member, OrgMe, OrgRole, ProductRole } from '@/lib/types';
import { toast } from 'sonner';

const DEFAULT_ROLE = 'default';

export function MemberDrawer({
  org,
  me,
  member,
  onOpenChange,
  onInvite,
}: {
  org: string;
  me: OrgMe;
  member: Member | null;
  onOpenChange: (v: boolean) => void;
  onInvite: (m: Member) => void;
}) {
  const qc = useQueryClient();
  const tags = useFunctionTags(org);
  const products = useProducts(org);
  const [form, setForm] = useState({ displayName: '', department: '', orgRole: 'member' as OrgRole, status: 'active' as Member['status'] });
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!member) return;
    setForm({ displayName: member.displayName, department: member.department ?? '', orgRole: member.orgRole, status: member.status });
    setTagIds(member.functionTagIds);
    setRoles(Object.fromEntries(member.productRoles.map((r) => [r.productId, r.role])));
    setError(null);
  }, [member]);

  if (!member) return <Sheet open={false} onOpenChange={onOpenChange} />;
  const kind = memberKind(member);
  const isAdminRole = form.orgRole === 'owner' || form.orgRole === 'admin';
  const roleOptions: OrgRole[] = kind === 'agent' ? ['member', 'guest'] : me.orgRole === 'owner' ? ['owner', 'admin', 'member', 'guest'] : ['admin', 'member', 'guest'];

  async function save() {
    if (!member) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/orgs/${org}/members/${member.id}`, {
        method: 'PATCH',
        body: { displayName: form.displayName, department: form.department || null, orgRole: form.orgRole, status: form.status },
      });
      await api(`/orgs/${org}/members/${member.id}/function-tags`, { method: 'PUT', body: { tagIds } });
      if (!isAdminRole && form.status === 'active') {
        for (const p of products.data ?? []) {
          const before = member.productRoles.find((r) => r.productId === p.id)?.role ?? DEFAULT_ROLE;
          const after = roles[p.id] ?? DEFAULT_ROLE;
          if (before !== after) {
            await api(`/orgs/${org}/products/${p.id}/roles/${member.id}`, {
              method: 'PUT',
              body: { role: after === DEFAULT_ROLE ? null : (after as ProductRole) },
            });
          }
        }
      }
      await qc.invalidateQueries({ queryKey: qk.members(org) });
      toast.success('已保存');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'internal', '保存失败，请稍后重试', null));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="flex w-[420px] flex-col gap-5 overflow-y-auto sm:max-w-[420px]" aria-describedby="member-drawer-desc">
        <SheetHeader>
          <SheetTitle>{member.displayName}</SheetTitle>
          <SheetDescription id="member-drawer-desc">
            {kind === 'account' ? <span className="font-mono">{member.email}</span> : kind === 'agent' ? 'Agent 成员' : '无账号成员'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-4">
          {kind === 'none' && (
            <div className="flex flex-col gap-3 rounded-md bg-amber-50 p-3 text-[13px] text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              <p>还没有关联登录账号。发送邀请后，对方注册即可接管这个成员身份，历史记录保持不变。</p>
              <Button variant="outline" size="sm" className="self-start" onClick={() => onInvite(member)}>
                <Link2 className="size-4" aria-hidden="true" />
                发送邀请以关联账号
              </Button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="md-name">显示名称</Label>
              <Input id="md-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="md-dept">部门</Label>
              <Input id="md-dept" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="md-role">组织角色</Label>
              <Select value={form.orgRole} onValueChange={(v) => setForm({ ...form, orgRole: v as OrgRole })} disabled={member.orgRole === 'owner' && me.orgRole !== 'owner'}>
                <SelectTrigger id="md-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ORG_ROLE_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="md-status">状态</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as Member['status'] })}>
                <SelectTrigger id="md-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">在职</SelectItem>
                  <SelectItem value="left">已离开</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.status === 'left' && member.status === 'active' && (
            <p className="text-[13px] text-muted-foreground">设为已离开后，会清除该成员的产品角色，并吊销其全部 API Token。</p>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">职能标签</legend>
            <div className="flex flex-wrap gap-3">
              {tags.data?.map((t) => (
                <label key={t.id} className="flex items-center gap-1.5 text-[13px]">
                  <Checkbox
                    aria-label={t.name}
                    checked={tagIds.includes(t.id)}
                    onCheckedChange={(v) => setTagIds(v ? [...tagIds, t.id] : tagIds.filter((x) => x !== t.id))}
                  />
                  <span className="size-2 rounded-full" style={{ background: t.color }} />
                  {t.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col">
            <legend className="mb-1 text-sm font-medium">产品角色</legend>
            <p className="mb-2 text-xs text-muted-foreground">
              {isAdminRole ? '组织管理员在所有产品上都是管理员。' : form.orgRole === 'member' ? '成员默认在所有产品上可编辑，可以按产品调整。' : '访客只能访问被单独授权的产品。'}
            </p>
            {!isAdminRole &&
              products.data?.map((p) => (
                <div key={p.id} className="flex items-center gap-3 border-t py-2">
                  <span className="rounded-sm bg-muted px-1.5 font-mono text-[11px]">{p.key}</span>
                  <span className="flex-1">{p.name}</span>
                  <Select value={roles[p.id] ?? DEFAULT_ROLE} onValueChange={(v) => setRoles({ ...roles, [p.id]: v })}>
                    <SelectTrigger className="h-8 w-28" aria-label={`${p.name} 的产品角色`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_ROLE}>{form.orgRole === 'member' ? '默认（编辑）' : '无权限'}</SelectItem>
                      {(['admin', 'editor', 'viewer'] as const).map((r) => (
                        <SelectItem key={r} value={r}>
                          {PRODUCT_ROLE_LABEL[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
          </fieldset>
          <FormError error={error} />
        </div>
        <SheetFooter className="mt-auto flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={saving}>
            保存
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/members/invitations-tab.tsx`：

```tsx
'use client';

import { MailPlus } from 'lucide-react';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { invitationState } from '@/features/members/model';
import { api } from '@/lib/api';
import { ORG_ROLE_LABEL } from '@/lib/labels';
import { qk, useApiMutation, useInvitations } from '@/lib/queries';

const STATE = { pending: '待接受', expired: '已过期', accepted: '已接受', revoked: '已撤销' } as const;

export function InvitationsTab({ org }: { org: string }) {
  const q = useInvitations(org);
  const revoke = useApiMutation((id: string) => api(`/orgs/${org}/invitations/${id}`, { method: 'DELETE' }), {
    invalidate: [qk.invitations(org)],
    success: '邀请已撤销',
  });
  if (!q.data) return null;
  if (q.data.length === 0) return <EmptyState icon={MailPlus} title="还没有发出邀请" />;
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>邮箱</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>有效期至</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.data.map((i) => {
            const s = invitationState(i);
            return (
              <TableRow key={i.id} className="h-10 even:bg-zebra">
                <TableCell className="font-mono text-xs">{i.email}</TableCell>
                <TableCell>{ORG_ROLE_LABEL[i.orgRole]}</TableCell>
                <TableCell>{STATE[s]}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{i.expiresAt.slice(0, 10)}</TableCell>
                <TableCell className="text-right">
                  {s === 'pending' && (
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm">
                          撤销
                        </Button>
                      }
                      title="撤销邀请？"
                      description={`撤销后，发给 ${i.email} 的链接将失效。`}
                      confirmLabel="确认撤销"
                      destructive
                      onConfirm={() => revoke.mutate(i.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/members/page.tsx`：

```tsx
'use client';

import { Search, Users } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { filterMembers, invitationState, type MemberFilter, memberKind } from '@/features/members/model';
import { MEMBER_KIND_LABEL, ORG_ROLE_LABEL } from '@/lib/labels';
import { useFunctionTags, useInvitations, useMembers, useOrg } from '@/lib/queries';
import type { Member } from '@/lib/types';
import { InvitationsTab } from './invitations-tab';
import { InviteDialog } from './invite-dialog';
import { MemberDrawer } from './member-drawer';
import { PlaceholderDialog } from './placeholder-dialog';

const KIND_STYLE = {
  account: 'bg-accent text-accent-foreground',
  none: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  agent: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-100',
} as const;

function MembersPage() {
  const { org } = useParams<{ org: string }>();
  const orgQ = useOrg(org);
  const members = useMembers(org);
  const tags = useFunctionTags(org);
  const invitations = useInvitations(org);
  const [filter, setFilter] = useState<MemberFilter>({ query: '', kind: 'all', role: 'all', includeLeft: false });
  const [selected, setSelected] = useState<Member | null>(null);
  const [inviting, setInviting] = useState<{ open: boolean; bindTo: Member | null }>({ open: false, bindTo: null });
  const [placeholder, setPlaceholder] = useState(false);
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const rows = filterMembers(members.data ?? [], filter);
  const pending = (invitations.data ?? []).filter((i) => invitationState(i) === 'pending').length;

  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '成员' }]}
        title="成员"
        description="无账号成员也可以被指派为提出人或负责人，之后发送邀请即可关联账号。"
        actions={
          <>
            <Button variant="outline" onClick={() => setPlaceholder(true)}>
              登记无账号成员
            </Button>
            <Button onClick={() => setInviting({ open: true, bindTo: null })}>邀请成员</Button>
          </>
        }
      />
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">成员 {members.data?.filter((m) => m.status === 'active').length ?? ''}</TabsTrigger>
          <TabsTrigger value="invitations">待接受邀请 {pending}</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label className="flex h-9 w-72 items-center gap-2 rounded-md border bg-card px-3 text-muted-foreground">
              <Search className="size-4" aria-hidden="true" />
              <Input
                className="h-8 border-0 p-0 shadow-none focus-visible:ring-0"
                placeholder="搜索姓名、邮箱或部门"
                value={filter.query}
                onChange={(e) => setFilter({ ...filter, query: e.target.value })}
              />
            </label>
            <Select value={filter.kind} onValueChange={(v) => setFilter({ ...filter, kind: v as MemberFilter['kind'] })}>
              <SelectTrigger className="w-32" aria-label="按类型筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="account">账号</SelectItem>
                <SelectItem value="none">无账号</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filter.role} onValueChange={(v) => setFilter({ ...filter, role: v as MemberFilter['role'] })}>
              <SelectTrigger className="w-32" aria-label="按角色筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部角色</SelectItem>
                {(['owner', 'admin', 'member', 'guest'] as const).map((r) => (
                  <SelectItem key={r} value={r}>
                    {ORG_ROLE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1.5 text-[13px]">
              <Checkbox checked={filter.includeLeft} onCheckedChange={(v) => setFilter({ ...filter, includeLeft: v === true })} />
              含已离开
            </label>
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={Users} title="没有符合条件的成员" />
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>成员</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>组织角色</TableHead>
                    <TableHead>职能</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((m) => {
                    const kind = memberKind(m);
                    return (
                      <TableRow key={m.id} className="h-10 even:bg-zebra">
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{m.displayName}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {m.email ?? (m.department ? `${m.department} · 未关联账号` : kind === 'agent' ? 'API 调用身份' : '—')}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`border-0 ${KIND_STYLE[kind]}`}>
                            {MEMBER_KIND_LABEL[kind]}
                          </Badge>
                        </TableCell>
                        <TableCell>{ORG_ROLE_LABEL[m.orgRole]}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {m.functionTagIds.map((id) => {
                              const t = tagById.get(id);
                              return t ? (
                                <span key={id} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                                  <span className="size-1.5 rounded-full" style={{ background: t.color }} />
                                  {t.name}
                                </span>
                              ) : null;
                            })}
                          </div>
                        </TableCell>
                        <TableCell className={m.status === 'left' ? 'text-muted-foreground' : 'text-emerald-700 dark:text-emerald-400'}>
                          {m.status === 'left' ? '已离开' : '在职'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" aria-label={`查看${m.displayName}`} onClick={() => setSelected(m)}>
                            详情
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
        <TabsContent value="invitations">
          <InvitationsTab org={org} />
        </TabsContent>
      </Tabs>
      {orgQ.data && (
        <MemberDrawer
          org={org}
          me={orgQ.data.me}
          member={selected}
          onOpenChange={(v) => !v && setSelected(null)}
          onInvite={(m) => {
            setSelected(null);
            setInviting({ open: true, bindTo: m });
          }}
        />
      )}
      <InviteDialog
        key={inviting.bindTo?.id ?? 'new'}
        org={org}
        open={inviting.open}
        bindTo={inviting.bindTo}
        onOpenChange={(v) => setInviting({ open: v, bindTo: v ? inviting.bindTo : null })}
      />
      <PlaceholderDialog org={org} open={placeholder} onOpenChange={setPlaceholder} />
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <MembersPage />
    </RequireOrgAdmin>
  );
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/web test && pnpm --filter @flower/web e2e members.spec.ts auth.spec.ts && pnpm --filter @flower/web typecheck`
Expected: 全部通过（auth 的第三个用例现在通过）。

- [ ] **Step 7: 提交**

```bash
git add apps/web
git commit -m "feat(web): 成员管理：列表筛选、邀请、无账号成员与详情抽屉"
```

---

### Task 9: 职能标签

**Files:**
- Create: `apps/web/src/components/color-swatches.tsx`、`apps/web/src/components/sortable-list.tsx`
- Create: `apps/web/src/features/tags/model.ts`、`model.test.ts`
- Create: `apps/web/src/app/(app)/[org]/settings/tags/page.tsx`
- Test: `apps/web/e2e/tags.spec.ts`

**Interfaces:**
- Consumes: `useFunctionTags`、`useApiMutation`、`api`、`qk`、`SWATCHES`、`ConfirmAction`、`EmptyState`、`PageHeader`、`RequireOrgAdmin`
- Produces:
  - `<ColorSwatches value onChange label>`（单选色板，`role="radiogroup"`）
  - `<SortableList items getId onReorder renderItem>`（dnd-kit 纵向拖动排序；每行有"拖动排序"把手按钮，支持键盘）
  - `moveItem<T>(list: T[], from: number, to: number): T[]`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/tags/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { moveItem } from './model';

describe('moveItem', () => {
  it('把元素从一个位置移到另一个位置，不改原数组', () => {
    const src = ['a', 'b', 'c', 'd'];
    expect(moveItem(src, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(src, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(src).toEqual(['a', 'b', 'c', 'd']);
  });
  it('越界时原样返回', () => {
    expect(moveItem(['a'], 0, 5)).toEqual(['a']);
  });
});
```

Run: `pnpm --filter @flower/web test tags/model`
Expected: FAIL。

- [ ] **Step 2: 实现 `moveItem` 与通用组件**

`apps/web/src/features/tags/model.ts`：

```ts
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list.slice();
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
```

`apps/web/src/components/color-swatches.tsx`：

```tsx
'use client';

import { Check } from 'lucide-react';
import { SWATCHES } from '@/lib/labels';
import { cn } from '@/lib/utils';

export function ColorSwatches({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn('flex size-6 items-center justify-center rounded-sm ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring', value.toLowerCase() === c && 'ring-2 ring-foreground/60')}
          style={{ background: c }}
        >
          {value.toLowerCase() === c && <Check className="size-3.5 text-white" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
```

`apps/web/src/components/sortable-list.tsx`：

```tsx
'use client';

import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import type { ReactNode } from 'react';
import { moveItem } from '@/features/tags/model';

function Row({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'relative z-10 bg-card shadow-md' : undefined}
    >
      <div className="flex items-center gap-2">
        <button type="button" aria-label="拖动排序" className="cursor-grab text-muted-foreground" {...attributes} {...listeners}>
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

export function SortableList<T>({
  items,
  getId,
  onReorder,
  renderItem,
}: {
  items: T[];
  getId: (item: T) => string;
  onReorder: (next: T[]) => void;
  renderItem: (item: T, index: number) => ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const ids = items.map(getId);
  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    onReorder(moveItem(items, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {items.map((item, i) => (
          <Row key={ids[i]} id={ids[i]!}>
            {renderItem(item, i)}
          </Row>
        ))}
      </SortableContext>
    </DndContext>
  );
}
```

Run: `pnpm --filter @flower/web test tags/model`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/tags.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test('新增、改名、改色、删除职能标签', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/tags');
  await expect(page.getByRole('textbox', { name: '标签名称' })).toHaveCount(4);

  await page.getByRole('button', { name: '新增标签' }).click();
  await page.getByLabel('新标签名称').fill('线条负责人');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByRole('textbox', { name: '标签名称' })).toHaveCount(5);

  const last = page.getByRole('textbox', { name: '标签名称' }).last();
  await last.fill('业务线负责人');
  await last.blur();
  await expect(page.getByText('已保存')).toBeVisible();

  await page.getByRole('button', { name: '删除业务线负责人' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('textbox', { name: '标签名称' })).toHaveCount(4);
});
```

Run: `pnpm --filter @flower/web e2e tags.spec.ts`
Expected: FAIL。

- [ ] **Step 4: 实现页面**

`apps/web/src/app/(app)/[org]/settings/tags/page.tsx`：

```tsx
'use client';

import { Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ColorSwatches } from '@/components/color-swatches';
import { ConfirmAction } from '@/components/confirm-action';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { SortableList } from '@/components/sortable-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import { SWATCHES } from '@/lib/labels';
import { qk, useApiMutation, useFunctionTags } from '@/lib/queries';
import type { FunctionTag } from '@/lib/types';

function TagsPage() {
  const { org } = useParams<{ org: string }>();
  const tags = useFunctionTags(org);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(SWATCHES[0]!);
  const inv = { invalidate: [qk.tags(org), qk.members(org)] };
  const create = useApiMutation(() => api(`/orgs/${org}/function-tags`, { method: 'POST', body: { name: newName, color: newColor } }), {
    ...inv,
    success: '已添加',
    onSuccess: () => {
      setNewName('');
      setAdding(false);
    },
  });
  const update = useApiMutation(
    (v: { id: string; name?: string; color?: string; sort?: number }) =>
      api(`/orgs/${org}/function-tags/${v.id}`, { method: 'PATCH', body: { name: v.name, color: v.color, sort: v.sort } }),
    { ...inv, success: '已保存' },
  );
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/function-tags/${id}`, { method: 'DELETE' }), { ...inv, success: '已删除' });

  async function reorder(next: FunctionTag[]) {
    for (const [i, t] of next.entries()) {
      if (t.sort !== i) await update.mutateAsync({ id: t.id, sort: i });
    }
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '职能标签' }]}
        title="职能标签"
        description="职能标签描述成员的岗位，用于指定检查项的签字人和按人筛选，不影响权限。"
        actions={<Button onClick={() => setAdding(true)}>新增标签</Button>}
      />
      {adding && (
        <form
          className="flex items-end gap-3 rounded-lg border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-tag">新标签名称</Label>
            <Input id="new-tag" required value={newName} onChange={(e) => setNewName(e.target.value)} className="w-56" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">颜色</span>
            <ColorSwatches label="新标签颜色" value={newColor} onChange={setNewColor} />
          </div>
          <Button type="submit" disabled={create.isPending}>
            添加
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
            取消
          </Button>
        </form>
      )}
      <div className="rounded-lg border bg-card p-2">
        <SortableList
          items={tags.data ?? []}
          getId={(t) => t.id}
          onReorder={reorder}
          renderItem={(t) => (
            <div className="flex h-10 items-center gap-3 border-b last:border-b-0">
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" aria-label={`修改${t.name}的颜色`} className="size-5 rounded-sm" style={{ background: t.color }} />
                </PopoverTrigger>
                <PopoverContent className="w-auto">
                  <ColorSwatches label={`${t.name}的颜色`} value={t.color} onChange={(color) => update.mutate({ id: t.id, color })} />
                </PopoverContent>
              </Popover>
              <Input
                aria-label="标签名称"
                defaultValue={t.name}
                className="h-8 w-64"
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== t.name) update.mutate({ id: t.id, name });
                }}
              />
              <span className="flex-1" />
              <ConfirmAction
                trigger={
                  <Button variant="ghost" size="icon" aria-label={`删除${t.name}`}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                }
                title={`删除「${t.name}」？`}
                description="成员身上的这个标签会一并移除。引用它的检查项签字规则需要重新指定。"
                confirmLabel="确认删除"
                destructive
                onConfirm={() => remove.mutate(t.id)}
              />
            </div>
          )}
        />
      </div>
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <TagsPage />
    </RequireOrgAdmin>
  );
}
```

本页用到 shadcn 的 `popover`，补装：

```bash
cd apps/web && pnpm dlx shadcn@latest add popover --yes && cd ../..
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/web test && pnpm --filter @flower/web e2e tags.spec.ts && pnpm --filter @flower/web typecheck`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/web
git commit -m "feat(web): 职能标签管理"
```

---

### Task 10: 产品列表与产品详情（概况、成员角色、流程、字段与层级叫法）

**Files:**
- Create: `apps/web/src/app/(app)/[org]/settings/products/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/settings/products/[productId]/roles-tab.tsx`、`workflow-tab.tsx`、`fields-tab.tsx`
- Create: `apps/web/src/components/level-names-editor.tsx`
- Test: `apps/web/e2e/products.spec.ts`

**Interfaces:**
- Consumes: `useProducts`、`useProduct`、`useMembers`、`useProductRoles`、`useProductWorkflow`、`useWorkflows`、`useFields`、`useLevelNames`、`useApiMutation`、`qk`、`api`、`PageHeader`、`FormError`、`ConfirmAction`、`EmptyState`、`PRODUCT_ROLE_LABEL`、`ORG_ROLE_LABEL`
- Produces: `<LevelNamesEditor value: string[] onSave(names: string[]) onClear?: () => void saving: boolean>`（Task 13 复用）

- [ ] **Step 1: 写失败的端到端测试**

`apps/web/e2e/products.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
});

test('新建产品，编号前缀自动转大写且创建后只读', async ({ page }) => {
  await page.goto('/acme/settings/products');
  await page.getByRole('button', { name: '新建产品' }).click();
  await page.getByLabel('产品名称').fill('网盘');
  await page.getByLabel('编号前缀').fill('pan');
  await page.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/settings/products/*');
  await expect(page.getByRole('heading', { name: '网盘' })).toBeVisible();
  await expect(page.getByText('PAN', { exact: true })).toBeVisible();
});

test('产品详情：复制流程为产品覆盖、覆盖字段、设置层级叫法、调整成员角色', async ({ page, request }) => {
  const p = await (await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } })).json();
  await request.post('/api/v1/orgs/acme/members', { data: { displayName: '外部顾问' } });
  await page.goto(`/acme/settings/products/${p.product.id}`);

  await page.getByRole('tab', { name: '流程' }).click();
  await expect(page.getByText('默认流程')).toBeVisible();
  await page.getByRole('button', { name: '复制为本产品的流程' }).click();
  await page.getByRole('button', { name: '确认复制' }).click();
  await expect(page.getByText('本产品专用')).toBeVisible();

  await page.getByRole('tab', { name: '字段与层级' }).click();
  await page.getByRole('button', { name: '覆盖 优先级' }).click();
  await expect(page.getByText('产品覆盖')).toBeVisible();
  await page.getByLabel('第 1 层').fill('模块');
  await page.getByRole('button', { name: '保存层级叫法' }).click();
  await expect(page.getByText('已保存')).toBeVisible();

  await page.getByRole('tab', { name: '成员角色' }).click();
  await page.getByLabel('外部顾问 的产品角色').click();
  await page.getByRole('option', { name: '只读' }).click();
  await expect(page.getByText('已更新')).toBeVisible();
});
```

Run: `pnpm --filter @flower/web e2e products.spec.ts`
Expected: FAIL。

- [ ] **Step 2: 实现层级叫法编辑器**

`apps/web/src/components/level-names-editor.tsx`：

```tsx
'use client';

import { Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LevelNamesEditor({
  value,
  onSave,
  onClear,
  saving,
}: {
  value: string[];
  onSave: (names: string[]) => void;
  onClear?: () => void;
  saving: boolean;
}) {
  const [names, setNames] = useState(value);
  useEffect(() => setNames(value), [value]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        {names.map((n, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Label htmlFor={`lvl-${i}`}>第 {i + 1} 层</Label>
            <Input id={`lvl-${i}`} className="w-32" value={n} onChange={(e) => setNames(names.map((x, j) => (j === i ? e.target.value : x)))} />
          </div>
        ))}
        <Button type="button" variant="outline" size="icon" aria-label="增加一层" disabled={names.length >= 3} onClick={() => setNames([...names, ''])}>
          <Plus className="size-4" aria-hidden="true" />
        </Button>
        <Button type="button" variant="outline" size="icon" aria-label="减少一层" disabled={names.length <= 1} onClick={() => setNames(names.slice(0, -1))}>
          <Minus className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">最多 3 层，每层名称不超过 10 个字。需求可以挂在任意一层。</p>
      <div className="flex gap-2">
        <Button type="button" onClick={() => onSave(names)} disabled={saving}>
          保存层级叫法
        </Button>
        {onClear && (
          <Button type="button" variant="ghost" onClick={onClear} disabled={saving}>
            恢复使用组织设置
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 实现产品列表页**

`apps/web/src/app/(app)/[org]/settings/products/page.tsx`：

```tsx
'use client';

import { Box } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { qk, useApiMutation, useProducts } from '@/lib/queries';
import type { Product } from '@/lib/types';

function ProductsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const products = useProducts(org);
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ name: '', key: '' });
  const create = useApiMutation(() => api<{ product: Product }>(`/orgs/${org}/products`, { method: 'POST', body: v }), {
    invalidate: [qk.products(org), qk.me],
    silentError: true,
    onSuccess: (d) => router.push(`/${org}/settings/products/${d.product.id}`),
  });
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '产品' }]}
        title="产品"
        description="每个产品有自己的需求编号前缀、流程和字段配置。"
        actions={<Button onClick={() => setOpen(true)}>新建产品</Button>}
      />
      {products.data?.length === 0 ? (
        <EmptyState icon={Box} title="还没有产品" description="例如「网盘」，编号前缀 PAN，需求编号会显示为 PAN-123。" />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">前缀</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.data?.map((p) => (
                <TableRow key={p.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono">{p.key}</TableCell>
                  <TableCell>
                    <Link href={`/${org}/settings/products/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.status === 'active' ? '启用' : '已归档'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined);
            }}
          >
            <DialogHeader>
              <DialogTitle>新建产品</DialogTitle>
              <DialogDescription>编号前缀创建后不能修改。新产品默认使用组织的第一个流程模板。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-name">产品名称</Label>
              <Input id="p-name" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-key">编号前缀</Label>
              <Input id="p-key" required className="font-mono uppercase" value={v.key} onChange={(e) => setV({ ...v, key: e.target.value.toUpperCase() })} />
              <span className="text-xs text-muted-foreground">以字母开头，2–10 位大写字母或数字</span>
            </div>
            <FormError error={create.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={create.isPending}>
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <ProductsPage />
    </RequireOrgAdmin>
  );
}
```

- [ ] **Step 4: 实现产品详情的三个标签页**

`apps/web/src/app/(app)/[org]/settings/products/[productId]/roles-tab.tsx`：

```tsx
'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ORG_ROLE_LABEL, PRODUCT_ROLE_LABEL } from '@/lib/labels';
import { qk, useApiMutation, useMembers, useProductRoles } from '@/lib/queries';
import type { ProductRole } from '@/lib/types';

const DEFAULT = 'default';

export function RolesTab({ org, productId }: { org: string; productId: string }) {
  const members = useMembers(org);
  const roles = useProductRoles(org, productId);
  const set = useApiMutation(
    (v: { memberId: string; role: ProductRole | null }) =>
      api(`/orgs/${org}/products/${productId}/roles/${v.memberId}`, { method: 'PUT', body: { role: v.role } }),
    { invalidate: [qk.productRoles(org, productId), qk.members(org)], success: '已更新' },
  );
  const override = new Map((roles.data ?? []).map((r) => [r.memberId, r.role]));
  const list = (members.data ?? []).filter((m) => m.status === 'active');
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>成员</TableHead>
            <TableHead>组织角色</TableHead>
            <TableHead className="w-48">本产品角色</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((m) => {
            const admin = m.orgRole === 'owner' || m.orgRole === 'admin';
            return (
              <TableRow key={m.id} className="h-10 even:bg-zebra">
                <TableCell className="font-medium">{m.displayName}</TableCell>
                <TableCell>{ORG_ROLE_LABEL[m.orgRole]}</TableCell>
                <TableCell>
                  {admin ? (
                    <span className="text-muted-foreground">管理员（组织管理员）</span>
                  ) : (
                    <Select
                      value={override.get(m.id) ?? DEFAULT}
                      onValueChange={(v) => set.mutate({ memberId: m.id, role: v === DEFAULT ? null : (v as ProductRole) })}
                    >
                      <SelectTrigger className="h-8" aria-label={`${m.displayName} 的产品角色`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT}>{m.orgRole === 'member' ? '默认（编辑）' : '无权限'}</SelectItem>
                        {(['admin', 'editor', 'viewer'] as const).map((r) => (
                          <SelectItem key={r} value={r}>
                            {PRODUCT_ROLE_LABEL[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/products/[productId]/workflow-tab.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { ConfirmAction } from '@/components/confirm-action';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { CATEGORY_COLOR } from '@/lib/labels';
import { qk, useApiMutation, useProductWorkflow, useWorkflows } from '@/lib/queries';

export function WorkflowTab({ org, productId, isOrgAdmin }: { org: string; productId: string; isOrgAdmin: boolean }) {
  const pw = useProductWorkflow(org, productId);
  const templates = useWorkflows(org, isOrgAdmin);
  const inv = { invalidate: [qk.productWorkflow(org, productId), qk.workflows(org)] };
  const use = useApiMutation((versionId: string) => api(`/orgs/${org}/products/${productId}/workflow`, { method: 'PUT', body: { versionId } }), {
    ...inv,
    success: '已切换流程',
  });
  const fork = useApiMutation(
    () => api(`/orgs/${org}/products/${productId}/workflow/fork`, { method: 'POST', body: { fromVersionId: pw.data!.version.id } }),
    { ...inv, success: '已复制为本产品的流程' },
  );
  if (!pw.data) return null;
  const { definition, version } = pw.data;
  const own = definition.productId === productId;
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{definition.name}</span>
          <span className="rounded-sm bg-muted px-1.5 font-mono text-xs">v{version.version}</span>
          <span className="text-xs text-muted-foreground">{own ? '本产品专用' : '组织流程模板'}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {version.body.states.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs">
              <span className="size-2 rounded-[2px]" style={{ background: CATEGORY_COLOR[s.category] }} />
              {s.label}
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          {own && (
            <Button asChild variant="outline">
              <Link href={`/${org}/settings/workflows/${definition.id}`}>编辑本产品的流程</Link>
            </Button>
          )}
          {!own && (
            <ConfirmAction
              trigger={<Button variant="outline">复制为本产品的流程</Button>}
              title="复制为本产品的流程？"
              description="复制后，本产品使用自己的流程副本，组织模板的后续修改不再影响本产品。"
              confirmLabel="确认复制"
              onConfirm={() => fork.mutate(undefined)}
            />
          )}
        </div>
      </section>
      {isOrgAdmin && templates.data && (
        <section className="flex items-center gap-3 rounded-lg border bg-card p-4">
          <span className="text-sm">改用组织模板</span>
          <Select onValueChange={(v) => use.mutate(v)}>
            <SelectTrigger className="w-72" aria-label="改用组织模板">
              <SelectValue placeholder="选择模板的当前版本" />
            </SelectTrigger>
            <SelectContent>
              {templates.data
                .filter((t) => t.productId === null && !t.archivedAt && t.currentVersionId)
                .map((t) => (
                  <SelectItem key={t.id} value={t.currentVersionId!}>
                    {t.name} · v{t.currentVersion}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </section>
      )}
    </div>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/products/[productId]/fields-tab.tsx`：

```tsx
'use client';

import { LevelNamesEditor } from '@/components/level-names-editor';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFields, useLevelNames } from '@/lib/queries';

export function FieldsTab({ org, productId }: { org: string; productId: string }) {
  const fields = useFields(org, productId);
  const levels = useLevelNames(org, productId);
  const inv = [qk.fields(org, productId)];
  const fork = useApiMutation((fieldId: string) => api(`/orgs/${org}/products/${productId}/fields/${fieldId}/fork`, { method: 'POST' }), {
    invalidate: inv,
    success: '已为本产品覆盖该字段',
  });
  const saveLevels = useApiMutation(
    (names: string[] | null) => api(`/orgs/${org}/products/${productId}/level-names`, { method: 'PUT', body: { names } }),
    { invalidate: [qk.levels(org, productId)], success: '已保存' },
  );
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border bg-card">
        <h2 className="border-b px-4 py-3 font-semibold">字段</h2>
        <ul className="divide-y">
          {fields.data?.map((f) => (
            <li key={f.id} className="flex h-10 items-center gap-3 px-4">
              <span className="w-24 font-medium">{f.label}</span>
              <span className="flex-1 truncate text-[13px] text-muted-foreground">
                {f.options.filter((o) => o.active).map((o) => o.label).join('、') || '暂无选项'}
              </span>
              {f.productId ? (
                <span className="text-xs text-primary">产品覆盖</span>
              ) : (
                <Button variant="ghost" size="sm" aria-label={`覆盖 ${f.label}`} onClick={() => fork.mutate(f.id)}>
                  为本产品覆盖
                </Button>
              )}
            </li>
          ))}
        </ul>
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">覆盖后，本产品的选项在「字段字典」页面单独维护，与组织字段互不影响。</p>
      </section>
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <h2 className="font-semibold">结构树层级叫法</h2>
        {levels.data && (
          <LevelNamesEditor
            value={levels.data.names}
            saving={saveLevels.isPending}
            onSave={(names) => saveLevels.mutate(names)}
            onClear={levels.data.source === 'product' ? () => saveLevels.mutate(null) : undefined}
          />
        )}
      </section>
    </div>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`：

```tsx
'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isOrgAdminRole } from '@/features/shell/nav';
import { api } from '@/lib/api';
import { qk, useApiMutation, useOrg, useProduct } from '@/lib/queries';
import { FieldsTab } from './fields-tab';
import { RolesTab } from './roles-tab';
import { WorkflowTab } from './workflow-tab';

export default function ProductDetailPage() {
  const { org, productId } = useParams<{ org: string; productId: string }>();
  const orgQ = useOrg(org);
  const product = useProduct(org, productId);
  const [name, setName] = useState('');
  useEffect(() => setName(product.data?.name ?? ''), [product.data?.name]);
  const update = useApiMutation(
    (body: { name?: string; status?: 'active' | 'archived' }) => api(`/orgs/${org}/products/${productId}`, { method: 'PATCH', body }),
    { invalidate: [qk.product(org, productId), qk.products(org), qk.me], success: '已保存' },
  );
  if (product.isError) return <NoAccess message="产品不存在，或者你没有访问权限。" />;
  if (!product.data || !orgQ.data) return null;
  if (product.data.myRole !== 'admin') return <NoAccess message="只有产品管理员可以修改产品设置。" />;
  const p = product.data;
  const orgAdmin = isOrgAdminRole(orgQ.data.me.orgRole);
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '产品', href: `/${org}/settings/products` }, { label: p.name }]}
        title={p.name}
        description={
          <>
            编号前缀 <span className="font-mono">{p.key}</span>
            {p.status === 'archived' && ' · 已归档'}
          </>
        }
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">概况</TabsTrigger>
          <TabsTrigger value="roles">成员角色</TabsTrigger>
          <TabsTrigger value="workflow">流程</TabsTrigger>
          <TabsTrigger value="fields">字段与层级</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <section className="flex max-w-lg flex-col gap-4 rounded-lg border bg-card p-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pd-name">产品名称</Label>
              <div className="flex gap-2">
                <Input id="pd-name" value={name} onChange={(e) => setName(e.target.value)} />
                <Button onClick={() => update.mutate({ name })} disabled={update.isPending || name === p.name}>
                  保存
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between border-t pt-4">
              <span className="text-[13px] text-muted-foreground">归档后产品不再出现在日常视图中，数据保留。</span>
              <Button variant="outline" onClick={() => update.mutate({ status: p.status === 'active' ? 'archived' : 'active' })}>
                {p.status === 'active' ? '归档产品' : '取消归档'}
              </Button>
            </div>
          </section>
        </TabsContent>
        <TabsContent value="roles">
          <RolesTab org={org} productId={productId} />
        </TabsContent>
        <TabsContent value="workflow">
          <WorkflowTab org={org} productId={productId} isOrgAdmin={orgAdmin} />
        </TabsContent>
        <TabsContent value="fields">
          <FieldsTab org={org} productId={productId} />
        </TabsContent>
      </Tabs>
    </>
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/web e2e products.spec.ts && pnpm --filter @flower/web typecheck`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/web
git commit -m "feat(web): 产品列表与产品详情"
```

---

### Task 11: 流程编辑模型（纯逻辑）

**Files:**
- Create: `apps/web/src/features/workflow/model.ts`、`apps/web/src/features/workflow/model.test.ts`

**Interfaces:**
- Consumes: `WorkflowBody`（`@/lib/types`）
- Produces（全部返回新对象，不修改入参）：
  - 类型 `State`、`Transition`、`CheckItem`、`Condition`（取自 `WorkflowBody`），常量 `ANY = '*'`
  - `newKey(prefix: 's' | 'c', existing: string[]): string`
  - `transitionMode(body, from: string, to: string): 'explicit' | 'implied' | 'none'`
  - `toggleTransition(body, from, to): WorkflowBody`（显式存在则删除，否则新增一条显式流转）
  - `getConditions(body, from, to): Condition[]`；`setConditions(body, from, to, conditions): WorkflowBody`
  - `addState(body, input: { label: string; category: State['category']; group: string }): WorkflowBody`
  - `updateState(body, key, patch: Partial<Omit<State, 'key'>>): WorkflowBody`
  - `removeState(body, key): WorkflowBody`（同时删除相关流转；若删的是初始状态，初始状态改为剩下的第一个）
  - `reorderStates(body, keys: string[]): WorkflowBody`；`setInitial(body, key): WorkflowBody`
  - `addCheckItem(body, input: Omit<CheckItem, 'key' | 'defaultState'>): WorkflowBody`；`updateCheckItem(body, key, patch)`；`removeCheckItem(body, key)`（同时删除引用它的条件）
  - `getGateConditions(body): Condition[]`；`setGateConditions(body, conditions): WorkflowBody`（为空时移除门禁）
  - `layoutGraph(body, selected?: { from: string; to: string }): { nodes: GraphNode[]; edges: GraphEdge[] }`，`GraphNode = { id: string; label: string; category: State['category'] | 'any'; x: number; y: number }`，`GraphEdge = { id: string; source: string; target: string; conditional: boolean; selected: boolean; from: string; to: string }`

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/workflow/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { WorkflowBody } from '@/lib/types';
import {
  ANY,
  addCheckItem,
  addState,
  getConditions,
  getGateConditions,
  layoutGraph,
  newKey,
  removeCheckItem,
  removeState,
  reorderStates,
  setConditions,
  setGateConditions,
  toggleTransition,
  transitionMode,
} from './model';

const body: WorkflowBody = {
  states: [
    { key: 'todo', label: '待开始', color: '#2f6fd6', order: 1, group: '执行', category: 'unstarted' },
    { key: 'doing', label: '进行中', color: '#b7791f', order: 2, group: '执行', category: 'started' },
    { key: 'done', label: '已完成', color: '#1e8a5a', order: 3, group: '执行', category: 'completed' },
    { key: 'hold', label: '已搁置', color: '#5c6570', order: 4, group: '收尾', category: 'canceled' },
  ],
  initial: 'todo',
  transitions: [
    { from: 'todo', to: 'doing', conditions: [] },
    { from: ANY, to: 'hold', conditions: [] },
  ],
  actionGates: [],
  checkItems: [{ key: 'design', label: '设计签字', scope: 'document', type: 'single', defaultState: 'not_started' }],
};

describe('流转', () => {
  it('区分显式、由"任意状态"推出、不允许', () => {
    expect(transitionMode(body, 'todo', 'doing')).toBe('explicit');
    expect(transitionMode(body, 'doing', 'hold')).toBe('implied');
    expect(transitionMode(body, ANY, 'hold')).toBe('explicit');
    expect(transitionMode(body, 'doing', 'todo')).toBe('none');
    expect(transitionMode(body, 'todo', 'todo')).toBe('none');
  });

  it('切换显式流转，不修改原对象', () => {
    const b1 = toggleTransition(body, 'doing', 'done');
    expect(transitionMode(b1, 'doing', 'done')).toBe('explicit');
    expect(transitionMode(body, 'doing', 'done')).toBe('none');
    expect(transitionMode(toggleTransition(b1, 'doing', 'done'), 'doing', 'done')).toBe('none');
  });

  it('读写流转条件', () => {
    const b = setConditions(body, 'todo', 'doing', [{ type: 'check_item', item: 'design', in: ['passed'] }]);
    expect(getConditions(b, 'todo', 'doing')).toEqual([{ type: 'check_item', item: 'design', in: ['passed'] }]);
    expect(getConditions(body, 'todo', 'doing')).toEqual([]);
  });
});

describe('状态', () => {
  it('新增状态生成不冲突的 key 与递增的顺序', () => {
    expect(newKey('s', ['s_1', 's_2'])).toBe('s_3');
    expect(newKey('s', ['s_2'])).toBe('s_1');
    const b = addState(body, { label: '测试中', category: 'started', group: '执行' });
    const added = b.states.at(-1)!;
    expect(added).toMatchObject({ key: 's_1', label: '测试中', order: 5, color: '#b7791f' });
  });

  it('删除状态时删掉相关流转，删掉初始状态时改用第一个剩下的状态', () => {
    const b = removeState(body, 'todo');
    expect(b.states.map((s) => s.key)).toEqual(['doing', 'done', 'hold']);
    expect(b.transitions).toEqual([{ from: ANY, to: 'hold', conditions: [] }]);
    expect(b.initial).toBe('doing');
  });

  it('重新排序时同时更新 order', () => {
    const b = reorderStates(body, ['done', 'todo', 'doing', 'hold']);
    expect(b.states.map((s) => [s.key, s.order])).toEqual([
      ['done', 1],
      ['todo', 2],
      ['doing', 3],
      ['hold', 4],
    ]);
  });
});

describe('检查项与门禁', () => {
  it('删除检查项时删掉引用它的条件', () => {
    let b = setConditions(body, 'todo', 'doing', [{ type: 'check_item', item: 'design', in: ['passed'] }, { type: 'has_iteration' }]);
    b = setGateConditions(b, [{ type: 'check_item', item: 'design', in: ['passed'] }]);
    b = removeCheckItem(b, 'design');
    expect(getConditions(b, 'todo', 'doing')).toEqual([{ type: 'has_iteration' }]);
    expect(getGateConditions(b)).toEqual([]);
    expect(b.actionGates).toEqual([]);
  });

  it('新增检查项带默认状态', () => {
    const b = addCheckItem(body, { label: '可行性', scope: 'requirement', type: 'single' });
    expect(b.checkItems.at(-1)).toEqual({ key: 'c_1', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' });
  });
});

describe('状态图布局', () => {
  it('按分组分行，"任意状态"单独一个节点，条件与选中状态体现在边上', () => {
    const b = setConditions(body, 'todo', 'doing', [{ type: 'has_iteration' }]);
    const g = layoutGraph(b, { from: 'todo', to: 'doing' });
    expect(g.nodes.map((n) => n.id)).toEqual(['__any', 'todo', 'doing', 'done', 'hold']);
    const todo = g.nodes.find((n) => n.id === 'todo')!;
    const hold = g.nodes.find((n) => n.id === 'hold')!;
    expect(hold.y).toBeGreaterThan(todo.y);
    expect(g.edges).toEqual([
      { id: 'todo->doing', source: 'todo', target: 'doing', from: 'todo', to: 'doing', conditional: true, selected: true },
      { id: '*->hold', source: '__any', target: 'hold', from: '*', to: 'hold', conditional: false, selected: false },
    ]);
  });
});
```

Run: `pnpm --filter @flower/web test workflow/model`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现**

`apps/web/src/features/workflow/model.ts`：

```ts
import { CATEGORY_COLOR } from '@/lib/labels';
import type { WorkflowBody } from '@/lib/types';

export type State = WorkflowBody['states'][number];
export type Transition = WorkflowBody['transitions'][number];
export type CheckItem = WorkflowBody['checkItems'][number];
export type Condition = Transition['conditions'][number];
export type GraphNode = { id: string; label: string; category: State['category'] | 'any'; x: number; y: number };
export type GraphEdge = { id: string; source: string; target: string; from: string; to: string; conditional: boolean; selected: boolean };

export const ANY = '*';
const ANY_NODE = '__any';

export function newKey(prefix: 's' | 'c', existing: string[]): string {
  let i = 1;
  while (existing.includes(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

const same = (t: Transition, from: string, to: string) => t.from === from && t.to === to;

export function transitionMode(body: WorkflowBody, from: string, to: string): 'explicit' | 'implied' | 'none' {
  if (from === to) return 'none';
  if (body.transitions.some((t) => same(t, from, to))) return 'explicit';
  if (from !== ANY && body.transitions.some((t) => same(t, ANY, to))) return 'implied';
  return 'none';
}

export function toggleTransition(body: WorkflowBody, from: string, to: string): WorkflowBody {
  if (from === to) return body;
  const exists = body.transitions.some((t) => same(t, from, to));
  return {
    ...body,
    transitions: exists ? body.transitions.filter((t) => !same(t, from, to)) : [...body.transitions, { from, to, conditions: [] }],
  };
}

export function getConditions(body: WorkflowBody, from: string, to: string): Condition[] {
  return body.transitions.find((t) => same(t, from, to))?.conditions ?? [];
}

export function setConditions(body: WorkflowBody, from: string, to: string, conditions: Condition[]): WorkflowBody {
  return { ...body, transitions: body.transitions.map((t) => (same(t, from, to) ? { ...t, conditions } : t)) };
}

export function addState(body: WorkflowBody, input: { label: string; category: State['category']; group: string }): WorkflowBody {
  const key = newKey('s', body.states.map((s) => s.key));
  const order = Math.max(0, ...body.states.map((s) => s.order)) + 1;
  return { ...body, states: [...body.states, { key, label: input.label, category: input.category, group: input.group, color: CATEGORY_COLOR[input.category], order }] };
}

export function updateState(body: WorkflowBody, key: string, patch: Partial<Omit<State, 'key'>>): WorkflowBody {
  return { ...body, states: body.states.map((s) => (s.key === key ? { ...s, ...patch } : s)) };
}

export function removeState(body: WorkflowBody, key: string): WorkflowBody {
  const states = body.states.filter((s) => s.key !== key);
  return {
    ...body,
    states,
    transitions: body.transitions.filter((t) => t.from !== key && t.to !== key),
    initial: body.initial === key ? (states[0]?.key ?? '') : body.initial,
  };
}

export function reorderStates(body: WorkflowBody, keys: string[]): WorkflowBody {
  const byKey = new Map(body.states.map((s) => [s.key, s]));
  const states = keys.flatMap((k, i) => {
    const s = byKey.get(k);
    return s ? [{ ...s, order: i + 1 }] : [];
  });
  return { ...body, states };
}

export function setInitial(body: WorkflowBody, key: string): WorkflowBody {
  return { ...body, initial: key };
}

export function addCheckItem(body: WorkflowBody, input: Omit<CheckItem, 'key' | 'defaultState'>): WorkflowBody {
  const key = newKey('c', body.checkItems.map((c) => c.key));
  return { ...body, checkItems: [...body.checkItems, { key, ...input, defaultState: 'not_started' }] };
}

export function updateCheckItem(body: WorkflowBody, key: string, patch: Partial<Omit<CheckItem, 'key'>>): WorkflowBody {
  return { ...body, checkItems: body.checkItems.map((c) => (c.key === key ? { ...c, ...patch } : c)) };
}

export function removeCheckItem(body: WorkflowBody, key: string): WorkflowBody {
  const keep = (c: Condition) => !(c.type === 'check_item' && c.item === key);
  return {
    ...body,
    checkItems: body.checkItems.filter((c) => c.key !== key),
    transitions: body.transitions.map((t) => ({ ...t, conditions: t.conditions.filter(keep) })),
    actionGates: body.actionGates
      .map((g) => ({ ...g, conditions: g.conditions.filter(keep) }))
      .filter((g) => g.conditions.length > 0),
  };
}

export function getGateConditions(body: WorkflowBody): Condition[] {
  return body.actionGates.find((g) => g.action === 'join_iteration')?.conditions ?? [];
}

export function setGateConditions(body: WorkflowBody, conditions: Condition[]): WorkflowBody {
  const others = body.actionGates.filter((g) => g.action !== 'join_iteration');
  return { ...body, actionGates: conditions.length > 0 ? [...others, { action: 'join_iteration', conditions }] : others };
}

export function layoutGraph(body: WorkflowBody, selected?: { from: string; to: string }): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const states = [...body.states].sort((a, b) => a.order - b.order);
  const groups: string[] = [];
  for (const s of states) if (!groups.includes(s.group)) groups.push(s.group);
  const colInGroup = new Map<string, number>();
  const nodes: GraphNode[] = [];
  const hasAny = body.transitions.some((t) => t.from === ANY);
  if (hasAny) nodes.push({ id: ANY_NODE, label: '任意状态', category: 'any', x: 0, y: 0 });
  for (const s of states) {
    const row = groups.indexOf(s.group);
    const col = colInGroup.get(s.group) ?? 0;
    colInGroup.set(s.group, col + 1);
    nodes.push({ id: s.key, label: s.label, category: s.category, x: 200 + col * 170, y: row * 130 });
  }
  const edges: GraphEdge[] = body.transitions.map((t) => ({
    id: `${t.from}->${t.to}`,
    source: t.from === ANY ? ANY_NODE : t.from,
    target: t.to,
    from: t.from,
    to: t.to,
    conditional: t.conditions.length > 0,
    selected: Boolean(selected && selected.from === t.from && selected.to === t.to),
  }));
  return { nodes, edges };
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm --filter @flower/web test workflow/model`
Expected: PASS（10 个用例）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/features/workflow
git commit -m "feat(web): 流程编辑模型"
```

---

### Task 12: 流程模板列表与流程编辑器（矩阵、条件抽屉、检查项、门禁、React Flow 预览、发布）

**Files:**
- Create: `apps/web/src/app/(app)/[org]/settings/workflows/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/settings/workflows/[id]/page.tsx`
- Create: `apps/web/src/features/workflow/components/states-table.tsx`、`transition-matrix.tsx`、`condition-editor.tsx`、`condition-sheet.tsx`、`check-items.tsx`、`action-gate.tsx`、`flow-preview.tsx`、`publish-dialog.tsx`、`version-history.tsx`、`validation-panel.tsx`
- Test: `apps/web/e2e/workflows.spec.ts`

**Interfaces:**
- Consumes: Task 11 全部导出；`validateWorkflowBody`（`@flower/core/workflow-schema`）；`useWorkflows`、`useWorkflow`、`useFields`、`useFunctionTags`、`useMembers`、`useOrg`、`useApiMutation`、`qk`、`api`、`CATEGORY_LABEL`、`CATEGORY_COLOR`、`CHECK_STATE_LABEL`、`SortableList`、`ConfirmAction`、`PageHeader`、`FormError`、`NoAccess`
- Produces: 组件 `ConditionEditor`（Task 12 内部复用于条件抽屉和动作门禁）

- [ ] **Step 1: 写失败的端到端测试**

`apps/web/e2e/workflows.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/workflows');
});

test('编辑默认流程：加状态、加检查项、给流转加条件、发布新版本', async ({ page }) => {
  await page.getByRole('link', { name: '默认流程' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(6);

  await page.getByRole('tab', { name: /状态/ }).click();
  await page.getByRole('button', { name: '新增状态' }).click();
  await page.getByRole('textbox', { name: '状态名称' }).last().fill('测试中');
  await expect(page.locator('.react-flow__node')).toHaveCount(7);

  await page.getByRole('tab', { name: /检查项/ }).click();
  await page.getByRole('button', { name: '新增检查项' }).click();
  await page.getByLabel('检查项名称').fill('可行性评估');
  await page.getByRole('button', { name: '添加检查项' }).click();

  await page.getByRole('tab', { name: /流转/ }).click();
  await page.getByRole('button', { name: '待开始 到 进行中：由任意状态规则允许' }).click();
  await page.getByRole('button', { name: '待开始 到 进行中：允许' }).click();
  const sheet = page.getByRole('dialog', { name: '待开始 → 进行中' });
  await sheet.getByRole('button', { name: '添加条件' }).click();
  await sheet.getByRole('menuitem', { name: '检查项处于指定状态' }).click();
  await sheet.getByLabel('检查项').click();
  await page.getByRole('option', { name: '可行性评估' }).click();
  await sheet.getByRole('checkbox', { name: '通过' }).check();
  await sheet.getByRole('button', { name: '完成' }).click();
  await expect(page.getByRole('button', { name: '待开始 到 进行中：允许，有条件' })).toBeVisible();

  await expect(page.getByText('校验通过')).toBeVisible();
  await page.getByRole('button', { name: '发布为 v2' }).click();
  await page.getByLabel('版本说明').fill('加可行性评估');
  await page.getByRole('button', { name: '确认发布' }).click();
  await expect(page.getByText('已发布 v2')).toBeVisible();
  await page.getByRole('button', { name: '版本历史' }).click();
  await expect(page.getByText('加可行性评估')).toBeVisible();
});

test('校验失败时显示问题并禁止发布；模板可以复制、改名和归档', async ({ page }) => {
  await page.getByRole('link', { name: '默认流程' }).click();
  await page.getByRole('tab', { name: /状态/ }).click();
  await page.getByRole('textbox', { name: '状态名称' }).first().fill('');
  await expect(page.getByText('名称不能为空')).toBeVisible();
  await expect(page.getByRole('button', { name: '发布为 v2' })).toBeDisabled();

  await page.goto('/acme/settings/workflows');
  await page.getByRole('button', { name: '新建模板' }).click();
  await page.getByLabel('模板名称').fill('网盘需求流程');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('link', { name: '网盘需求流程' })).toBeVisible();
  await page.getByRole('button', { name: '更多操作：网盘需求流程' }).click();
  await page.getByRole('menuitem', { name: '归档' }).click();
  await expect(page.getByRole('row', { name: /网盘需求流程/ }).getByText('已归档')).toBeVisible();
});
```

Run: `pnpm --filter @flower/web e2e workflows.spec.ts`
Expected: FAIL。

- [ ] **Step 2: 实现模板列表页**

`apps/web/src/app/(app)/[org]/settings/workflows/page.tsx`：

```tsx
'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { qk, useApiMutation, useWorkflows } from '@/lib/queries';
import type { WorkflowDefinition, WorkflowVersion } from '@/lib/types';

function WorkflowsPage() {
  const { org } = useParams<{ org: string }>();
  const list = useWorkflows(org);
  const templates = (list.data ?? []).filter((w) => w.productId === null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<WorkflowDefinition | null>(null);
  const [name, setName] = useState('');
  const [base, setBase] = useState<string>('');
  const inv = { invalidate: [qk.workflows(org)] };
  const create = useApiMutation(
    async () => {
      const from = base || templates[0]!.id;
      const d = await api<{ definition: WorkflowDefinition; versions: WorkflowVersion[] }>(`/orgs/${org}/workflows/${from}`);
      return api(`/orgs/${org}/workflows`, {
        method: 'POST',
        body: { name, body: d.versions[0]!.body, note: `复制自「${d.definition.name}」v${d.versions[0]!.version}` },
      });
    },
    { ...inv, success: '模板已创建', silentError: true, onSuccess: () => setCreating(false) },
  );
  const update = useApiMutation(
    (v: { id: string; name?: string; archived?: boolean }) =>
      api(`/orgs/${org}/workflows/${v.id}`, { method: 'PATCH', body: { name: v.name, archived: v.archived } }),
    { ...inv, success: '已保存', onSuccess: () => setRenaming(null) },
  );
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '流程模板' }]}
        title="流程模板"
        description="产品从模板中选用一个版本。发布新版本不会影响已在用的产品，产品管理员可以自行切换。"
        actions={
          <Button
            onClick={() => {
              setName('');
              setBase('');
              setCreating(true);
            }}
          >
            新建模板
          </Button>
        }
      />
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead className="w-32">当前版本</TableHead>
              <TableHead className="w-32">状态</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((w) => (
              <TableRow key={w.id} className="h-10 even:bg-zebra">
                <TableCell>
                  <Link href={`/${org}/settings/workflows/${w.id}`} className="font-medium hover:underline">
                    {w.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">v{w.currentVersion}</TableCell>
                <TableCell className="text-muted-foreground">{w.archivedAt ? '已归档' : '启用'}</TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`更多操作：${w.name}`}>
                        <MoreHorizontal className="size-4" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setName(w.name);
                          setRenaming(w);
                        }}
                      >
                        重命名
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => update.mutate({ id: w.id, archived: !w.archivedAt })}>
                        {w.archivedAt ? '取消归档' : '归档'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined);
            }}
          >
            <DialogHeader>
              <DialogTitle>新建模板</DialogTitle>
              <DialogDescription>从现有模板的当前版本复制，创建后再编辑。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-name">模板名称</Label>
              <Input id="wf-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-base">复制自</Label>
              <Select value={base || templates[0]?.id} onValueChange={setBase}>
                <SelectTrigger id="wf-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · v{t.currentVersion}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FormError error={create.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                取消
              </Button>
              <Button type="submit" disabled={create.isPending}>
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(renaming)} onOpenChange={(v) => !v && setRenaming(null)}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (renaming) update.mutate({ id: renaming.id, name });
            }}
          >
            <DialogHeader>
              <DialogTitle>重命名模板</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-rename">模板名称</Label>
              <Input id="wf-rename" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={update.isPending}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <WorkflowsPage />
    </RequireOrgAdmin>
  );
}
```

- [ ] **Step 3: 实现编辑器组件**

`apps/web/src/features/workflow/components/condition-editor.tsx`：

```tsx
'use client';

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CHECK_STATE_LABEL } from '@/lib/labels';
import type { Field, WorkflowBody } from '@/lib/types';
import type { Condition } from '../model';

const STATES = Object.keys(CHECK_STATE_LABEL) as Array<keyof typeof CHECK_STATE_LABEL>;

export function ConditionEditor({
  body,
  fields,
  value,
  onChange,
}: {
  body: WorkflowBody;
  fields: Field[];
  value: Condition[];
  onChange: (next: Condition[]) => void;
}) {
  const set = (i: number, c: Condition) => onChange(value.map((x, j) => (j === i ? c : x)));
  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 && <p className="text-[13px] text-muted-foreground">没有条件，随时可以流转。</p>}
      {value.map((c, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[13px] font-medium">
              {c.type === 'check_item' && '检查项处于指定状态'}
              {c.type === 'field_set' && '字段已填写'}
              {c.type === 'has_iteration' && '已加入迭代'}
              {c.type === 'has_change_document' && '已关联 PRD'}
            </span>
            <Button variant="ghost" size="icon" aria-label="删除条件" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {c.type === 'check_item' && (
            <>
              <Select value={c.item} onValueChange={(item) => set(i, { ...c, item })}>
                <SelectTrigger aria-label="检查项">
                  <SelectValue placeholder="选择检查项" />
                </SelectTrigger>
                <SelectContent>
                  {body.checkItems.map((ci) => (
                    <SelectItem key={ci.key} value={ci.key}>
                      {ci.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-3">
                {STATES.map((s) => (
                  <label key={s} className="flex items-center gap-1.5 text-[13px]">
                    <Checkbox
                      aria-label={CHECK_STATE_LABEL[s]}
                      checked={c.in.includes(s)}
                      onCheckedChange={(v) => set(i, { ...c, in: v ? [...c.in, s] : c.in.filter((x) => x !== s) })}
                    />
                    {CHECK_STATE_LABEL[s]}
                  </label>
                ))}
              </div>
            </>
          )}
          {c.type === 'field_set' && (
            <Select value={c.field} onValueChange={(field) => set(i, { ...c, field })}>
              <SelectTrigger aria-label="字段">
                <SelectValue placeholder="选择字段" />
              </SelectTrigger>
              <SelectContent>
                {fields.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="self-start">
            <Plus className="size-4" aria-hidden="true" />
            添加条件
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            disabled={body.checkItems.length === 0}
            onSelect={() => onChange([...value, { type: 'check_item', item: body.checkItems[0]?.key ?? '', in: [] }])}
          >
            检查项处于指定状态
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onChange([...value, { type: 'field_set', field: fields[0]?.key ?? '' }])}>字段已填写</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onChange([...value, { type: 'has_iteration' }])}>已加入迭代</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onChange([...value, { type: 'has_change_document' }])}>已关联 PRD</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

`apps/web/src/features/workflow/components/condition-sheet.tsx`：

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Field, WorkflowBody } from '@/lib/types';
import { ANY, getConditions, setConditions, toggleTransition } from '../model';
import { ConditionEditor } from './condition-editor';

export function ConditionSheet({
  body,
  fields,
  selected,
  onChange,
  onClose,
}: {
  body: WorkflowBody;
  fields: Field[];
  selected: { from: string; to: string } | null;
  onChange: (b: WorkflowBody) => void;
  onClose: () => void;
}) {
  if (!selected) return null;
  const label = (k: string) => (k === ANY ? '任意状态' : (body.states.find((s) => s.key === k)?.label ?? k));
  const title = `${label(selected.from)} → ${label(selected.to)}`;
  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="flex w-[420px] flex-col gap-4 sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>满足全部条件才能流转。</SheetDescription>
        </SheetHeader>
        <div className="px-4">
          <ConditionEditor
            body={body}
            fields={fields}
            value={getConditions(body, selected.from, selected.to)}
            onChange={(c) => onChange(setConditions(body, selected.from, selected.to, c))}
          />
        </div>
        <SheetFooter className="mt-auto flex-row justify-between">
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => {
              onChange(toggleTransition(body, selected.from, selected.to));
              onClose();
            }}
          >
            删除这条流转
          </Button>
          <Button onClick={onClose}>完成</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
```

`apps/web/src/features/workflow/components/transition-matrix.tsx`：

```tsx
'use client';

import { Check } from 'lucide-react';
import type { WorkflowBody } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ANY, getConditions, transitionMode } from '../model';

export function TransitionMatrix({
  body,
  selected,
  onCell,
}: {
  body: WorkflowBody;
  selected: { from: string; to: string } | null;
  onCell: (from: string, to: string) => void;
}) {
  const states = [...body.states].sort((a, b) => a.order - b.order);
  const rows = [{ key: ANY, label: '任意状态' }, ...states.map((s) => ({ key: s.key, label: s.label }))];
  return (
    <div className="overflow-x-auto">
      <div className="mb-3 flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-accent" />
          允许
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm border border-dashed border-primary/60" />
          由"任意状态"规则允许
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-amber-600" />
          有条件
        </span>
        <span>点击空格新增流转，点击已允许的格子编辑条件</span>
      </div>
      <table className="border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="w-24 text-left align-bottom text-[11px] font-normal text-muted-foreground">从 ↓ 到 →</th>
            {states.map((s) => (
              <th key={s.key} className="h-16 w-8 align-bottom text-xs font-normal text-muted-foreground [writing-mode:vertical-rl]">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className={cn('pr-2 text-left text-[13px] font-normal', r.key === ANY && 'text-muted-foreground')}>
                {r.label}
              </th>
              {states.map((c) => {
                if (r.key === c.key) return <td key={c.key} className="size-8 rounded-sm bg-[repeating-linear-gradient(135deg,var(--border)_0_1px,transparent_1px_6px)]" />;
                const mode = transitionMode(body, r.key, c.key);
                const cond = mode === 'explicit' && getConditions(body, r.key, c.key).length > 0;
                const sel = selected?.from === r.key && selected.to === c.key;
                const name =
                  mode === 'explicit' ? `${r.label} 到 ${c.label}：允许${cond ? '，有条件' : ''}` : mode === 'implied' ? `${r.label} 到 ${c.label}：由任意状态规则允许` : `${r.label} 到 ${c.label}：不允许`;
                return (
                  <td key={c.key}>
                    <button
                      type="button"
                      aria-label={name}
                      onClick={() => onCell(r.key, c.key)}
                      className={cn(
                        'relative flex size-8 items-center justify-center rounded-sm border',
                        mode === 'explicit' && 'border-transparent bg-accent text-primary',
                        mode === 'implied' && 'border-dashed border-primary/60',
                        mode === 'none' && 'bg-card',
                        sel && 'bg-primary text-primary-foreground ring-2 ring-primary ring-offset-2',
                      )}
                    >
                      {mode !== 'none' && <Check className="size-3.5" aria-hidden="true" />}
                      {cond && <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-600" />}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`apps/web/src/features/workflow/components/states-table.tsx`：

```tsx
'use client';

import { Trash2 } from 'lucide-react';
import { ConfirmAction } from '@/components/confirm-action';
import { SortableList } from '@/components/sortable-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CATEGORY_COLOR, CATEGORY_LABEL } from '@/lib/labels';
import type { WorkflowBody } from '@/lib/types';
import { addState, removeState, reorderStates, setInitial, type State, updateState } from '../model';

const CATS = Object.keys(CATEGORY_LABEL) as State['category'][];

export function StatesTable({ body, onChange }: { body: WorkflowBody; onChange: (b: WorkflowBody) => void }) {
  const states = [...body.states].sort((a, b) => a.order - b.order);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[24px_minmax(0,1fr)_140px_140px_90px_72px_40px] gap-2 px-1 text-xs text-muted-foreground">
        <span />
        <span>名称</span>
        <span>类别</span>
        <span>分组</span>
        <span>key</span>
        <span>初始</span>
        <span />
      </div>
      <SortableList
        items={states}
        getId={(s) => s.key}
        onReorder={(next) => onChange(reorderStates(body, next.map((s) => s.key)))}
        renderItem={(s) => (
          <div className="grid grid-cols-[minmax(0,1fr)_140px_140px_90px_72px_40px] items-center gap-2 border-b py-1.5">
            <div className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: CATEGORY_COLOR[s.category] }} />
              <Input aria-label="状态名称" className="h-8" value={s.label} onChange={(e) => onChange(updateState(body, s.key, { label: e.target.value }))} />
            </div>
            <Select value={s.category} onValueChange={(v) => onChange(updateState(body, s.key, { category: v as State['category'], color: CATEGORY_COLOR[v as State['category']] }))}>
              <SelectTrigger className="h-8" aria-label={`${s.label} 的类别`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input aria-label={`${s.label} 的分组`} className="h-8" value={s.group} onChange={(e) => onChange(updateState(body, s.key, { group: e.target.value }))} />
            <span className="font-mono text-xs text-muted-foreground">{s.key}</span>
            <input
              type="radio"
              name="initial-state"
              aria-label={`以 ${s.label} 为初始状态`}
              checked={body.initial === s.key}
              onChange={() => onChange(setInitial(body, s.key))}
              className="size-4 accent-[var(--primary)]"
            />
            <ConfirmAction
              trigger={
                <Button variant="ghost" size="icon" aria-label={`删除 ${s.label}`} disabled={body.states.length <= 1}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              }
              title={`删除状态「${s.label}」？`}
              description="与它相关的流转会一并删除。已发布的版本不受影响。"
              confirmLabel="确认删除"
              destructive
              onConfirm={() => onChange(removeState(body, s.key))}
            />
          </div>
        )}
      />
      <Button variant="outline" size="sm" className="self-start" onClick={() => onChange(addState(body, { label: '新状态', category: 'started', group: states.at(-1)?.group ?? '' }))}>
        新增状态
      </Button>
      <p className="text-xs text-muted-foreground">类别是固定的五种，用于跨产品统计；分组用于看板分泳道。</p>
    </div>
  );
}
```

`apps/web/src/features/workflow/components/check-items.tsx`：

```tsx
'use client';

import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PRODUCT_ROLE_LABEL } from '@/lib/labels';
import type { FunctionTag, Member, WorkflowBody } from '@/lib/types';
import { addCheckItem, type CheckItem, removeCheckItem } from '../model';

type Signer = NonNullable<CheckItem['signers']>[number];

export function CheckItems({
  body,
  tags,
  members,
  onChange,
}: {
  body: WorkflowBody;
  tags: FunctionTag[];
  members: Member[];
  onChange: (b: WorkflowBody) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Omit<CheckItem, 'key' | 'defaultState'>>({ label: '', scope: 'requirement', type: 'single' });
  const [signer, setSigner] = useState<Signer>({ by: 'function_tag', ref: '' });
  const signerLabel = (s: Signer) =>
    s.by === 'function_tag'
      ? `职能：${tags.find((t) => t.id === s.ref)?.name ?? '已删除的标签'}`
      : s.by === 'member'
        ? `成员：${members.find((m) => m.id === s.ref)?.displayName ?? '已删除的成员'}`
        : `产品角色：${PRODUCT_ROLE_LABEL[s.ref as keyof typeof PRODUCT_ROLE_LABEL] ?? s.ref}`;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y rounded-md border">
        {body.checkItems.length === 0 && <li className="px-3 py-4 text-[13px] text-muted-foreground">还没有检查项。</li>}
        {body.checkItems.map((c) => (
          <li key={c.key} className="flex items-center gap-3 px-3 py-2">
            <span className="font-medium">{c.label}</span>
            <span className="font-mono text-xs text-muted-foreground">{c.key}</span>
            <span className="text-xs text-muted-foreground">
              {c.scope === 'document' ? '作用于 PRD' : '作用于需求'} · {c.type === 'signoff' ? `会签（${c.signoffRule === 'all' ? '全部通过' : '任一通过'}）` : '普通'}
              {c.auto === 'prd_status' && ' · 自动同步 PRD 状态'}
            </span>
            <span className="flex-1 truncate text-xs text-muted-foreground">{c.signers?.map(signerLabel).join('、')}</span>
            <ConfirmAction
              trigger={
                <Button variant="ghost" size="icon" aria-label={`删除 ${c.label}`}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              }
              title={`删除检查项「${c.label}」？`}
              description="引用它的流转条件和门禁条件会一并删除。"
              confirmLabel="确认删除"
              destructive
              onConfirm={() => onChange(removeCheckItem(body, c.key))}
            />
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          setDraft({ label: '', scope: 'requirement', type: 'single' });
          setOpen(true);
        }}
      >
        新增检查项
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              onChange(addCheckItem(body, draft));
              setOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>新增检查项</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ci-label">检查项名称</Label>
              <Input id="ci-label" required value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ci-scope">作用范围</Label>
                <Select value={draft.scope} onValueChange={(v) => setDraft({ ...draft, scope: v as CheckItem['scope'], auto: undefined })}>
                  <SelectTrigger id="ci-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="requirement">需求</SelectItem>
                    <SelectItem value="document">PRD（覆盖的需求共享结果）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ci-type">类型</Label>
                <Select
                  value={draft.type}
                  onValueChange={(v) =>
                    setDraft(v === 'signoff' ? { ...draft, type: 'signoff', signers: [], signoffRule: 'all' } : { ...draft, type: 'single', signers: undefined, signoffRule: undefined })
                  }
                >
                  <SelectTrigger id="ci-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">普通</SelectItem>
                    <SelectItem value="signoff">会签</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {draft.scope === 'document' && (
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={draft.auto === 'prd_status'} onCheckedChange={(v) => setDraft({ ...draft, auto: v ? 'prd_status' : undefined })} />
                由 PRD 模块自动同步状态（不可手动修改）
              </label>
            )}
            {draft.type === 'signoff' && (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <span className="text-sm font-medium">签字人</span>
                <ul className="flex flex-wrap gap-1.5">
                  {draft.signers?.map((s, i) => (
                    <li key={i} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                      {signerLabel(s)}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Select value={signer.by} onValueChange={(v) => setSigner({ by: v as Signer['by'], ref: '' })}>
                    <SelectTrigger className="w-28" aria-label="签字人类型">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="function_tag">职能</SelectItem>
                      <SelectItem value="member">成员</SelectItem>
                      <SelectItem value="product_role">产品角色</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={signer.ref} onValueChange={(ref) => setSigner({ ...signer, ref })}>
                    <SelectTrigger className="flex-1" aria-label="签字人">
                      <SelectValue placeholder="选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {signer.by === 'function_tag' &&
                        tags.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      {signer.by === 'member' &&
                        members
                          .filter((m) => m.status === 'active')
                          .map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.displayName}
                            </SelectItem>
                          ))}
                      {signer.by === 'product_role' &&
                        (['admin', 'editor', 'viewer'] as const).map((r) => (
                          <SelectItem key={r} value={r}>
                            {PRODUCT_ROLE_LABEL[r]}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!signer.ref}
                    onClick={() => setDraft({ ...draft, signers: [...(draft.signers ?? []), signer] })}
                  >
                    加入
                  </Button>
                </div>
                <Select value={draft.signoffRule} onValueChange={(v) => setDraft({ ...draft, signoffRule: v as 'all' | 'any' })}>
                  <SelectTrigger aria-label="会签规则">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部签字人通过</SelectItem>
                    <SelectItem value="any">任一签字人通过</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit">添加检查项</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

`apps/web/src/features/workflow/components/action-gate.tsx`：

```tsx
'use client';

import type { Field, WorkflowBody } from '@/lib/types';
import { getGateConditions, setGateConditions } from '../model';
import { ConditionEditor } from './condition-editor';

export function ActionGate({ body, fields, onChange }: { body: WorkflowBody; fields: Field[]; onChange: (b: WorkflowBody) => void }) {
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <div>
        <h3 className="font-medium">加入迭代</h3>
        <p className="text-[13px] text-muted-foreground">需求加入迭代前必须满足以下全部条件，例如"PRD 评审通过"。</p>
      </div>
      <ConditionEditor body={body} fields={fields} value={getGateConditions(body)} onChange={(c) => onChange(setGateConditions(body, c))} />
    </div>
  );
}
```

`apps/web/src/features/workflow/components/flow-preview.tsx`：

```tsx
'use client';

import '@xyflow/react/dist/style.css';
import { Background, Controls, type Edge, MarkerType, MiniMap, type Node, ReactFlow } from '@xyflow/react';
import { useMemo } from 'react';
import { CATEGORY_COLOR, CATEGORY_LABEL } from '@/lib/labels';
import type { WorkflowBody } from '@/lib/types';
import { layoutGraph } from '../model';

export function FlowPreview({
  body,
  selected,
  onSelect,
}: {
  body: WorkflowBody;
  selected: { from: string; to: string } | null;
  onSelect: (s: { from: string; to: string }) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const g = layoutGraph(body, selected ?? undefined);
    const nodes: Node[] = g.nodes.map((n) => {
      const color = n.category === 'any' ? 'var(--muted-foreground)' : CATEGORY_COLOR[n.category];
      return {
        id: n.id,
        position: { x: n.x, y: n.y },
        data: { label: n.label },
        draggable: false,
        style: {
          width: 120,
          fontSize: 13,
          padding: '6px 10px',
          borderRadius: 4,
          border: `1.5px ${n.category === 'any' ? 'dashed' : 'solid'} ${color}`,
          background: 'var(--card)',
          color: 'var(--foreground)',
        },
      };
    });
    const edges: Edge[] = g.edges.map((e) => {
      const stroke = e.selected ? 'var(--primary)' : 'var(--muted-foreground)';
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        data: { from: e.from, to: e.to },
        label: e.conditional ? '有条件' : undefined,
        animated: e.selected,
        style: { stroke, strokeWidth: e.selected ? 2.2 : 1.2, strokeDasharray: e.from === '*' ? '4 4' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      };
    });
    return { nodes, edges };
  }, [body, selected]);
  return (
    <div className="flex h-full min-h-[480px] flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <span className="font-semibold">状态图</span>
        <span className="text-xs text-muted-foreground">随编辑实时更新 · 点击连线编辑条件</span>
        <span className="ml-auto flex gap-3 text-xs text-muted-foreground">
          {(Object.keys(CATEGORY_LABEL) as Array<keyof typeof CATEGORY_LABEL>).map((c) => (
            <span key={c} className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px]" style={{ background: CATEGORY_COLOR[c] }} />
              {CATEGORY_LABEL[c]}
            </span>
          ))}
        </span>
      </div>
      <div className="flex-1" aria-label="流程状态图">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesConnectable={false}
          onEdgeClick={(_, e) => onSelect(e.data as { from: string; to: string })}
        >
          <Background gap={16} size={1.2} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}
```

`apps/web/src/features/workflow/components/validation-panel.tsx`：

```tsx
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ValidationIssue } from '@flower/core/workflow-schema';

export function ValidationPanel({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) {
    return (
      <span className="flex items-center gap-1.5 text-[13px] text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="size-4" aria-hidden="true" />
        校验通过
      </span>
    );
  }
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="size-4" aria-hidden="true" />有 {issues.length} 个问题需要修正后才能发布
      </p>
      <ul className="mt-1 list-disc pl-6">
        {issues.slice(0, 6).map((i, n) => (
          <li key={n}>{i.message}</li>
        ))}
      </ul>
    </div>
  );
}
```

`apps/web/src/features/workflow/components/publish-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ApiError } from '@/lib/api';

export function PublishDialog({
  nextVersion,
  disabled,
  pending,
  error,
  onPublish,
}: {
  nextVersion: number;
  disabled: boolean;
  pending: boolean;
  error: ApiError | null;
  onPublish: (note: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>发布为 v{nextVersion}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>发布 v{nextVersion}</DialogTitle>
          <DialogDescription>发布后版本不可修改。已在用旧版本的产品不受影响。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pub-note">版本说明</Label>
          <Textarea id="pub-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：增加可行性评估检查项" />
        </div>
        <FormError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            disabled={pending}
            onClick={async () => {
              await onPublish(note);
              setOpen(false);
              setNote('');
            }}
          >
            确认发布
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/features/workflow/components/version-history.tsx`：

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import type { WorkflowVersion } from '@/lib/types';

export function VersionHistory({ versions }: { versions: WorkflowVersion[] }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">版本历史</Button>
      </SheetTrigger>
      <SheetContent className="w-[380px] sm:max-w-[380px]">
        <SheetHeader>
          <SheetTitle>版本历史</SheetTitle>
          <SheetDescription>每个版本发布后不可修改。</SheetDescription>
        </SheetHeader>
        <ol className="flex flex-col divide-y px-4">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-col gap-1 py-3">
              <span className="flex items-center gap-2">
                <span className="rounded-sm bg-muted px-1.5 font-mono text-xs">v{v.version}</span>
                <span className="font-mono text-xs text-muted-foreground">{v.createdAt.slice(0, 16).replace('T', ' ')}</span>
              </span>
              <span className="text-[13px]">{v.note || '—'}</span>
            </li>
          ))}
        </ol>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 4: 实现编辑器页面**

`apps/web/src/app/(app)/[org]/settings/workflows/[id]/page.tsx`：

```tsx
'use client';

import { validateWorkflowBody } from '@flower/core/workflow-schema';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ActionGate } from '@/features/workflow/components/action-gate';
import { CheckItems } from '@/features/workflow/components/check-items';
import { ConditionSheet } from '@/features/workflow/components/condition-sheet';
import { FlowPreview } from '@/features/workflow/components/flow-preview';
import { PublishDialog } from '@/features/workflow/components/publish-dialog';
import { StatesTable } from '@/features/workflow/components/states-table';
import { TransitionMatrix } from '@/features/workflow/components/transition-matrix';
import { ValidationPanel } from '@/features/workflow/components/validation-panel';
import { VersionHistory } from '@/features/workflow/components/version-history';
import { toggleTransition, transitionMode } from '@/features/workflow/model';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFields, useFunctionTags, useMembers, useWorkflow } from '@/lib/queries';
import type { WorkflowBody, WorkflowVersion } from '@/lib/types';

export default function WorkflowEditorPage() {
  const { org, id } = useParams<{ org: string; id: string }>();
  const wf = useWorkflow(org, id);
  const productId = wf.data?.definition.productId ?? undefined;
  const fields = useFields(org, productId);
  const tags = useFunctionTags(org);
  const members = useMembers(org);
  const [draft, setDraft] = useState<WorkflowBody | null>(null);
  const [selected, setSelected] = useState<{ from: string; to: string } | null>(null);
  const current = wf.data?.versions[0];

  useEffect(() => {
    if (current && !draft) setDraft(current.body);
  }, [current, draft]);

  const issues = useMemo(() => {
    if (!draft || !fields.data) return [];
    const r = validateWorkflowBody(draft, { fieldKeys: fields.data.map((f) => f.key) });
    return r.ok ? [] : r.issues;
  }, [draft, fields.data]);

  const publish = useApiMutation(
    (note: string) => api<{ version: WorkflowVersion }>(`/orgs/${org}/workflows/${id}/versions`, { method: 'POST', body: { body: draft, note } }),
    {
      invalidate: [qk.workflow(org, id), qk.workflows(org)],
      silentError: true,
      onSuccess: (d) => {
        toast.success(`已发布 v${d.version.version}`);
        setDraft(d.version.body);
      },
    },
  );

  if (wf.isError) return <NoAccess message="流程不存在，或者你没有编辑权限。" />;
  if (!wf.data || !draft || !current) return null;
  const def = wf.data.definition;
  const dirty = JSON.stringify(draft) !== JSON.stringify(current.body);

  function onCell(from: string, to: string) {
    if (!draft) return;
    if (transitionMode(draft, from, to) === 'explicit') setSelected({ from, to });
    else {
      setDraft(toggleTransition(draft, from, to));
      setSelected(null);
    }
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '流程模板', href: `/${org}/settings/workflows` }, { label: def.name }]}
        title={
          <span className="flex items-center gap-2">
            {def.name}
            <span className="rounded-sm bg-muted px-1.5 font-mono text-xs font-normal text-muted-foreground">
              v{current.version}
              {dirty && ' → 草稿'}
            </span>
          </span>
        }
        description={def.productId ? '这是某个产品专用的流程。' : '组织流程模板。发布新版本不会影响已在用旧版本的产品。'}
        actions={
          <>
            <VersionHistory versions={wf.data.versions} />
            <PublishDialog
              nextVersion={current.version + 1}
              disabled={!dirty || issues.length > 0}
              pending={publish.isPending}
              error={publish.error}
              onPublish={(note) => publish.mutateAsync(note)}
            />
          </>
        }
      />
      <ValidationPanel issues={issues} />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
        <Tabs defaultValue="transitions" className="min-w-0">
          <TabsList>
            <TabsTrigger value="states">状态 {draft.states.length}</TabsTrigger>
            <TabsTrigger value="transitions">流转 {draft.transitions.length}</TabsTrigger>
            <TabsTrigger value="checks">检查项 {draft.checkItems.length}</TabsTrigger>
            <TabsTrigger value="gates">动作门禁 {draft.actionGates.length}</TabsTrigger>
          </TabsList>
          <div className="mt-3 rounded-lg border bg-card p-4">
            <TabsContent value="states">
              <StatesTable body={draft} onChange={setDraft} />
            </TabsContent>
            <TabsContent value="transitions">
              <TransitionMatrix body={draft} selected={selected} onCell={onCell} />
            </TabsContent>
            <TabsContent value="checks">
              <CheckItems body={draft} tags={tags.data ?? []} members={members.data ?? []} onChange={setDraft} />
            </TabsContent>
            <TabsContent value="gates">
              <ActionGate body={draft} fields={fields.data ?? []} onChange={setDraft} />
            </TabsContent>
          </div>
        </Tabs>
        <FlowPreview body={draft} selected={selected} onSelect={setSelected} />
      </div>
      <ConditionSheet body={draft} fields={fields.data ?? []} selected={selected} onChange={setDraft} onClose={() => setSelected(null)} />
    </>
  );
}
```

注意：`useMembers` 需要组织管理员以外的成员身份也能调用（`listMembers` 允许非访客），产品管理员编辑产品专用流程时可正常加载签字人列表。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/web test && pnpm --filter @flower/web e2e workflows.spec.ts && pnpm --filter @flower/web typecheck && pnpm --filter @flower/web build`
Expected: 全部通过；构建成功（确认 `@flower/core/workflow-schema` 没有把服务端代码打进浏览器包：构建输出中没有 `postgres`、`@node-rs/argon2` 相关的客户端打包警告）。

- [ ] **Step 6: 提交**

```bash
git add apps/web
git commit -m "feat(web): 流程模板与流程编辑器（矩阵、条件、检查项、React Flow 预览）"
```

---

### Task 13: 字段字典与组织层级叫法

**Files:**
- Create: `apps/web/src/app/(app)/[org]/settings/fields/page.tsx`
- Test: `apps/web/e2e/fields.spec.ts`

**Interfaces:**
- Consumes: `useFields`、`useProducts`、`useLevelNames`、`useApiMutation`、`qk`、`api`、`SortableList`、`ColorSwatches`、`LevelNamesEditor`、`PageHeader`、`RequireOrgAdmin`
- Produces: 页面 `/[org]/settings/fields`；顶部"查看"下拉可选"组织字段"或某个产品（只显示产品覆盖后的字段为可编辑）

- [ ] **Step 1: 写失败的端到端测试**

`apps/web/e2e/fields.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test('给平台字段加选项、停用选项、设置组织层级叫法', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/fields');

  const platform = page.getByRole('region', { name: '平台' });
  await platform.getByLabel('新选项').fill('PC客户端');
  await platform.getByRole('button', { name: '添加' }).click();
  await platform.getByLabel('新选项').fill('Web端');
  await platform.getByRole('button', { name: '添加' }).click();
  await expect(platform.getByRole('textbox', { name: '选项名称' })).toHaveCount(2);

  await platform.getByRole('switch', { name: 'Web端 启用' }).click();
  await expect(platform.getByRole('switch', { name: 'Web端 启用' })).not.toBeChecked();

  await page.getByLabel('第 1 层').fill('产品线');
  await page.getByRole('button', { name: '保存层级叫法' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('第 1 层')).toHaveValue('产品线');
});
```

Run: `pnpm --filter @flower/web e2e fields.spec.ts`
Expected: FAIL。

- [ ] **Step 2: 实现页面**

`apps/web/src/app/(app)/[org]/settings/fields/page.tsx`：

```tsx
'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ColorSwatches } from '@/components/color-swatches';
import { LevelNamesEditor } from '@/components/level-names-editor';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { SortableList } from '@/components/sortable-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFields, useLevelNames, useProducts } from '@/lib/queries';
import type { Field } from '@/lib/types';

function FieldCard({ org, field, editable, productId }: { org: string; field: Field; editable: boolean; productId?: string }) {
  const [label, setLabel] = useState('');
  const inv = { invalidate: [qk.fields(org, productId), qk.fields(org)] };
  const add = useApiMutation(() => api(`/orgs/${org}/fields/${field.id}/options`, { method: 'POST', body: { label } }), {
    ...inv,
    onSuccess: () => setLabel(''),
  });
  const update = useApiMutation(
    (v: { id: string; label?: string; color?: string | null; active?: boolean }) =>
      api(`/orgs/${org}/field-options/${v.id}`, { method: 'PATCH', body: { label: v.label, color: v.color, active: v.active } }),
    inv,
  );
  const reorder = useApiMutation((ids: string[]) => api(`/orgs/${org}/fields/${field.id}/options/order`, { method: 'PUT', body: { optionIds: ids } }), inv);
  return (
    <section aria-label={field.label} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">{field.label}</h2>
        <span className="font-mono text-xs text-muted-foreground">{field.key}</span>
        <span className="text-xs text-muted-foreground">{field.cardinality === 'multi' ? '多选' : '单选'}</span>
        {field.productId && <span className="text-xs text-primary">产品覆盖</span>}
      </div>
      {!editable ? (
        <p className="text-[13px] text-muted-foreground">
          {field.options.map((o) => o.label).join('、') || '暂无选项'}（在产品详情中覆盖后可单独编辑）
        </p>
      ) : (
        <>
          <SortableList
            items={field.options}
            getId={(o) => o.id}
            onReorder={(next) => reorder.mutate(next.map((o) => o.id))}
            renderItem={(o) => (
              <div className="flex h-9 items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <button type="button" aria-label={`修改${o.label}的颜色`} className="size-4 rounded-sm border" style={{ background: o.color ?? 'transparent' }} />
                  </PopoverTrigger>
                  <PopoverContent className="w-auto">
                    <ColorSwatches label={`${o.label}的颜色`} value={o.color ?? ''} onChange={(color) => update.mutate({ id: o.id, color })} />
                  </PopoverContent>
                </Popover>
                <Input
                  aria-label="选项名称"
                  defaultValue={o.label}
                  className="h-8 w-56"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== o.label) update.mutate({ id: o.id, label: v });
                  }}
                />
                <span className="font-mono text-xs text-muted-foreground">{o.key}</span>
                <span className="flex-1" />
                <Switch aria-label={`${o.label} 启用`} checked={o.active} onCheckedChange={(active) => update.mutate({ id: o.id, active })} />
              </div>
            )}
          />
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (label.trim()) add.mutate(undefined);
            }}
          >
            <Input aria-label="新选项" placeholder="新选项名称" className="h-8 w-56" value={label} onChange={(e) => setLabel(e.target.value)} />
            <Button type="submit" size="sm" variant="outline" disabled={add.isPending}>
              添加
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">选项只能停用，不能删除，已使用的历史数据仍能正常显示。</p>
        </>
      )}
    </section>
  );
}

function FieldsPage() {
  const { org } = useParams<{ org: string }>();
  const products = useProducts(org);
  const [scope, setScope] = useState<string>('org');
  const productId = scope === 'org' ? undefined : scope;
  const fields = useFields(org, productId);
  const levels = useLevelNames(org);
  const saveLevels = useApiMutation((names: string[]) => api(`/orgs/${org}/level-names`, { method: 'PUT', body: { names } }), {
    invalidate: [qk.levels(org)],
    success: '已保存',
  });
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '字段字典' }]}
        title="字段字典"
        description="字典实时生效。产品可以覆盖某个字段，之后独立维护自己的选项。"
        actions={
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="w-48" aria-label="查看范围">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="org">组织字段</SelectItem>
              {products.data?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  产品：{p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="grid grid-cols-2 gap-4">
        {fields.data?.map((f) => (
          <FieldCard key={f.id} org={org} field={f} productId={productId} editable={scope === 'org' ? f.productId === null : f.productId !== null} />
        ))}
      </div>
      {scope === 'org' && (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h2 className="font-semibold">结构树层级叫法</h2>
          {levels.data && <LevelNamesEditor value={levels.data.names} saving={saveLevels.isPending} onSave={(names) => saveLevels.mutate(names)} />}
        </section>
      )}
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <FieldsPage />
    </RequireOrgAdmin>
  );
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm --filter @flower/web e2e fields.spec.ts && pnpm --filter @flower/web typecheck`
Expected: 全部通过。

- [ ] **Step 4: 提交**

```bash
git add apps/web
git commit -m "feat(web): 字段字典与层级叫法"
```

---

### Task 14: Agent 与 Token

**Files:**
- Create: `apps/web/src/features/tokens/model.ts`、`model.test.ts`
- Create: `apps/web/src/components/issue-token-dialog.tsx`
- Create: `apps/web/src/app/(app)/[org]/settings/agents/page.tsx`
- Test: `apps/web/e2e/agents.spec.ts`

**Interfaces:**
- Consumes: `useMembers`、`useTokens`、`useProducts`、`useApiMutation`、`qk`、`api`、`CopyField`、`ConfirmAction`、`EmptyState`、`FormError`、`PageHeader`、`RequireOrgAdmin`
- Produces:
  - `describeScope(scope: TokenScope, products: Product[]): string`；`tokenStatus(t: Token, now?: Date): 'active' | 'revoked' | 'expired'`；`expiryFromChoice(choice: '30d' | '90d' | '365d' | 'never', now?: Date): string | null`
  - `<IssueTokenDialog org open onOpenChange memberId? agents?: Member[]>`：`memberId` 固定时签发个人 Token（Task 15 复用），否则在 `agents` 中选择

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/tokens/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { Product, Token } from '@/lib/types';
import { describeScope, expiryFromChoice, tokenStatus } from './model';

const products = [{ id: 'p1', key: 'PAN', name: '网盘' }, { id: 'p2', key: 'VIP', name: '会员' }] as Product[];

describe('Token 展示', () => {
  it('描述范围', () => {
    expect(describeScope({ products: 'all', access: 'write' }, products)).toBe('全部产品 · 读写');
    expect(describeScope({ products: ['p1'], access: 'read' }, products)).toBe('PAN · 只读');
    expect(describeScope({ products: ['p1', 'gone'], access: 'read' }, products)).toBe('PAN、已删除的产品 · 只读');
  });
  it('状态', () => {
    const t = { revokedAt: null, expiresAt: null } as Token;
    expect(tokenStatus(t)).toBe('active');
    expect(tokenStatus({ ...t, revokedAt: '2026-01-01T00:00:00Z' })).toBe('revoked');
    expect(tokenStatus({ ...t, expiresAt: '2020-01-01T00:00:00Z' })).toBe('expired');
  });
  it('有效期选项', () => {
    const now = new Date('2026-09-29T00:00:00Z');
    expect(expiryFromChoice('30d', now)).toBe('2026-10-29T00:00:00.000Z');
    expect(expiryFromChoice('never', now)).toBeNull();
  });
});
```

Run: `pnpm --filter @flower/web test tokens/model`
Expected: FAIL。

- [ ] **Step 2: 实现**

`apps/web/src/features/tokens/model.ts`：

```ts
import type { Product, Token, TokenScope } from '@/lib/types';

export function describeScope(scope: TokenScope, products: Product[]): string {
  const target =
    scope.products === 'all' ? '全部产品' : scope.products.map((id) => products.find((p) => p.id === id)?.key ?? '已删除的产品').join('、');
  return `${target} · ${scope.access === 'read' ? '只读' : '读写'}`;
}

export function tokenStatus(t: Token, now: Date = new Date()): 'active' | 'revoked' | 'expired' {
  if (t.revokedAt) return 'revoked';
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

const DAYS = { '30d': 30, '90d': 90, '365d': 365 } as const;

export function expiryFromChoice(choice: '30d' | '90d' | '365d' | 'never', now: Date = new Date()): string | null {
  if (choice === 'never') return null;
  return new Date(now.getTime() + DAYS[choice] * 86_400_000).toISOString();
}
```

Run: `pnpm --filter @flower/web test tokens/model`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/agents.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test('创建 Agent，签发只读 Token；Token 只能读指定产品，撤销后失效', async ({ page, request, playwright }) => {
  await resetDatabase();
  await setupInstance(request);
  await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  await request.post('/api/v1/orgs/acme/products', { data: { name: '会员', key: 'VIP' } });
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/agents');

  await page.getByRole('button', { name: '创建 Agent' }).click();
  await page.getByLabel('Agent 名称').fill('PRD 助手');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('row', { name: /PRD 助手/ })).toBeVisible();

  await page.getByRole('button', { name: '签发 Token' }).click();
  await page.getByLabel('Token 名称').fill('Claude Code');
  await page.getByRole('radio', { name: '指定产品' }).click();
  await page.getByRole('checkbox', { name: 'PAN 网盘' }).check();
  await page.getByRole('radio', { name: '只读' }).click();
  await page.getByRole('button', { name: '签发' }).click();
  const token = await page.getByLabel('Token（只显示一次）').inputValue();
  expect(token).toMatch(/^flw_/);
  await page.getByRole('button', { name: '我已保存' }).click();
  await expect(page.getByRole('row', { name: /Claude Code/ }).getByText('PAN · 只读')).toBeVisible();

  const api = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  const list = await (await api.get('/api/v1/orgs/acme/products')).json();
  expect(list.products.map((p: { key: string }) => p.key)).toEqual(['PAN']);
  expect((await api.post('/api/v1/orgs/acme/products', { data: { name: 'x', key: 'XX' } })).status()).toBe(403);

  await page.getByRole('row', { name: /Claude Code/ }).getByRole('button', { name: '撤销' }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByRole('row', { name: /Claude Code/ }).getByText('已撤销')).toBeVisible();
  expect((await api.get('/api/v1/orgs/acme/products')).status()).toBe(401);
  await api.dispose();
});
```

Run: `pnpm --filter @flower/web e2e agents.spec.ts`
Expected: FAIL。

- [ ] **Step 4: 实现签发对话框与页面**

`apps/web/src/components/issue-token-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { expiryFromChoice } from '@/features/tokens/model';
import { api } from '@/lib/api';
import { qk, useApiMutation, useProducts } from '@/lib/queries';
import type { Member, TokenScope } from '@/lib/types';
import { CopyField } from './copy-field';
import { FormError } from './form-error';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

type Expiry = '30d' | '90d' | '365d' | 'never';

export function IssueTokenDialog({
  org,
  open,
  onOpenChange,
  memberId,
  agents = [],
}: {
  org: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  memberId?: string;
  agents?: Member[];
}) {
  const products = useProducts(org);
  const [target, setTarget] = useState(memberId ?? agents[0]?.id ?? '');
  const [name, setName] = useState('');
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [access, setAccess] = useState<TokenScope['access']>('read');
  const [expiry, setExpiry] = useState<Expiry>('90d');
  const [token, setToken] = useState<string | null>(null);
  const m = useApiMutation(
    () =>
      api<{ token: string }>(`/orgs/${org}/tokens`, {
        method: 'POST',
        body: { memberId: memberId ?? target, name, scope: { products: all ? 'all' : picked, access }, expiresAt: expiryFromChoice(expiry) },
      }),
    { invalidate: [qk.tokens(org)], silentError: true, onSuccess: (d) => setToken(d.token) },
  );
  function close(v: boolean) {
    if (!v) {
      setToken(null);
      setName('');
      setPicked([]);
      m.reset();
    }
    onOpenChange(v);
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>签发 Token</DialogTitle>
          <DialogDescription>实际权限 = 持有者当前的权限 ∩ Token 的范围。持有者权限被下调时，Token 随之收窄。</DialogDescription>
        </DialogHeader>
        {token ? (
          <>
            <CopyField label="Token（只显示一次）" value={token} />
            <p className="text-[13px] text-muted-foreground">关闭后无法再次查看。请立即保存到 Agent 的配置中。</p>
            <DialogFooter>
              <Button onClick={() => close(false)}>我已保存</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate(undefined);
            }}
          >
            {!memberId && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tk-agent">Agent</Label>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger id="tk-agent">
                    <SelectValue placeholder="选择 Agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tk-name">Token 名称</Label>
              <Input id="tk-name" required placeholder="例如 Claude Code" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">产品范围</legend>
              <div role="radiogroup" className="flex gap-4 text-[13px]">
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="tk-scope" checked={all} onChange={() => setAll(true)} className="accent-[var(--primary)]" />
                  全部产品
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="tk-scope" checked={!all} onChange={() => setAll(false)} className="accent-[var(--primary)]" />
                  指定产品
                </label>
              </div>
              {!all && (
                <div className="flex flex-wrap gap-3 rounded-md border p-3">
                  {products.data?.map((p) => (
                    <label key={p.id} className="flex items-center gap-1.5 text-[13px]">
                      <Checkbox
                        aria-label={`${p.key} ${p.name}`}
                        checked={picked.includes(p.id)}
                        onCheckedChange={(v) => setPicked(v ? [...picked, p.id] : picked.filter((x) => x !== p.id))}
                      />
                      <span className="font-mono text-xs">{p.key}</span> {p.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">访问方式</legend>
              <div role="radiogroup" className="flex gap-4 text-[13px]">
                {(['read', 'write'] as const).map((a) => (
                  <label key={a} className="flex items-center gap-1.5">
                    <input type="radio" name="tk-access" checked={access === a} onChange={() => setAccess(a)} className="accent-[var(--primary)]" />
                    {a === 'read' ? '只读' : '读写'}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tk-exp">有效期</Label>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as Expiry)}>
                <SelectTrigger id="tk-exp">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30d">30 天</SelectItem>
                  <SelectItem value="90d">90 天</SelectItem>
                  <SelectItem value="365d">1 年</SelectItem>
                  <SelectItem value="never">永不过期</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FormError error={m.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                取消
              </Button>
              <Button type="submit" disabled={m.isPending}>
                签发
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/agents/page.tsx`：

```tsx
'use client';

import { Bot } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { FormError } from '@/components/form-error';
import { IssueTokenDialog } from '@/components/issue-token-dialog';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describeScope, tokenStatus } from '@/features/tokens/model';
import { api } from '@/lib/api';
import { ORG_ROLE_LABEL } from '@/lib/labels';
import { qk, useApiMutation, useMembers, useProducts, useTokens } from '@/lib/queries';

const STATUS = { active: '有效', revoked: '已撤销', expired: '已过期' } as const;
const day = (s: string | null) => (s ? s.slice(0, 10) : '—');

function AgentsPage() {
  const { org } = useParams<{ org: string }>();
  const members = useMembers(org);
  const tokens = useTokens(org);
  const products = useProducts(org);
  const [creating, setCreating] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [name, setName] = useState('');
  const agents = (members.data ?? []).filter((m) => m.kind === 'agent' && m.status === 'active');
  const memberName = new Map((members.data ?? []).map((m) => [m.id, m.displayName]));
  const create = useApiMutation(() => api(`/orgs/${org}/agents`, { method: 'POST', body: { displayName: name } }), {
    invalidate: [qk.members(org)],
    success: 'Agent 已创建',
    silentError: true,
    onSuccess: () => {
      setName('');
      setCreating(false);
    },
  });
  const revoke = useApiMutation((id: string) => api(`/orgs/${org}/tokens/${id}`, { method: 'DELETE' }), {
    invalidate: [qk.tokens(org)],
    success: 'Token 已撤销',
  });
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: 'Agent 与 Token' }]}
        title="Agent 与 Token"
        description="Agent 是一种成员，权限用组织角色和产品角色配置；外部 Agent 使用 Token 调用 API。"
        actions={
          <>
            <Button variant="outline" onClick={() => setCreating(true)}>
              创建 Agent
            </Button>
            <Button onClick={() => setIssuing(true)} disabled={agents.length === 0}>
              签发 Token
            </Button>
          </>
        }
      />
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Agent</h2>
        {agents.length === 0 ? (
          <EmptyState icon={Bot} title="还没有 Agent" description="例如「PRD 助手」。创建后可以在成员页调整它的产品角色。" />
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>组织角色</TableHead>
                  <TableHead>有效 Token</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((a) => (
                  <TableRow key={a.id} className="h-10 even:bg-zebra">
                    <TableCell className="font-medium">{a.displayName}</TableCell>
                    <TableCell>{ORG_ROLE_LABEL[a.orgRole]}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {(tokens.data ?? []).filter((t) => t.memberId === a.id && tokenStatus(t) === 'active').length}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Token</h2>
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>持有者</TableHead>
                <TableHead>前缀</TableHead>
                <TableHead>范围</TableHead>
                <TableHead>最近使用</TableHead>
                <TableHead>过期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.data?.map((t) => {
                const s = tokenStatus(t);
                return (
                  <TableRow key={t.id} className="h-10 even:bg-zebra">
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>{memberName.get(t.memberId) ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">flw_{t.prefix}_…</TableCell>
                    <TableCell className="text-[13px]">{describeScope(t.scope, products.data ?? [])}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{day(t.lastUsedAt)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{day(t.expiresAt)}</TableCell>
                    <TableCell>{STATUS[s]}</TableCell>
                    <TableCell className="text-right">
                      {s === 'active' && (
                        <ConfirmAction
                          trigger={
                            <Button variant="ghost" size="sm">
                              撤销
                            </Button>
                          }
                          title={`撤销「${t.name}」？`}
                          description="撤销后使用这个 Token 的调用会立即失败，且不能恢复。"
                          confirmLabel="确认撤销"
                          destructive
                          onConfirm={() => revoke.mutate(t.id)}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined);
            }}
          >
            <DialogHeader>
              <DialogTitle>创建 Agent</DialogTitle>
              <DialogDescription>Agent 默认是组织成员（在所有产品上可编辑），可以在成员页调整。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ag-name">Agent 名称</Label>
              <Input id="ag-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <FormError error={create.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                取消
              </Button>
              <Button type="submit" disabled={create.isPending}>
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <IssueTokenDialog key={agents.length} org={org} open={issuing} onOpenChange={setIssuing} agents={agents} />
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <AgentsPage />
    </RequireOrgAdmin>
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/web test && pnpm --filter @flower/web e2e agents.spec.ts && pnpm --filter @flower/web typecheck`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/web
git commit -m "feat(web): Agent 与 Token 管理"
```

---

### Task 15: 组织信息、个人设置、实例设置

**Files:**
- Create: `apps/web/src/components/plain-shell.tsx`
- Modify: `apps/web/src/app/(app)/page.tsx`（改用 `PlainShell`）
- Create: `apps/web/src/app/(app)/[org]/settings/general/page.tsx`
- Create: `apps/web/src/app/(app)/settings/page.tsx`
- Create: `apps/web/src/app/(app)/admin/page.tsx`
- Test: `apps/web/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `useMe`、`useOrg`、`useTokens`、`useInstanceSettings`、`useApiMutation`、`qk`、`api`、`IssueTokenDialog`、`ConfirmAction`、`FormError`、`PageHeader`、`RequireOrgAdmin`、`NoAccess`、`describeScope`、`tokenStatus`
- Produces: `<PlainShell>`（没有组织侧栏的页面框架：顶部栏 + 居中内容，用于首页、个人设置、实例设置）

- [ ] **Step 1: 写失败的端到端测试**

`apps/web/e2e/settings.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
});

test('修改组织名称后侧栏同步更新', async ({ page }) => {
  await page.goto('/acme/settings/general');
  await page.getByLabel('组织名称').fill('123云盘');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' }).getByText('123云盘')).toBeVisible();
});

test('个人设置：改名、修改密码后用新密码登录', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('姓名').fill('林澄 Lin');
  await page.getByRole('button', { name: '保存资料' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await page.getByLabel('当前密码').fill(OWNER.password);
  await page.getByLabel('新密码', { exact: true }).fill('password456');
  await page.getByLabel('确认新密码').fill('password456');
  await page.getByRole('button', { name: '修改密码' }).click();
  await expect(page.getByText('密码已修改')).toBeVisible();
  await page.getByRole('button', { name: '个人菜单' }).click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await login(page, OWNER.email, 'password456');
});

test('实例设置：开放注册后登录页出现注册入口', async ({ page, browser }) => {
  await page.goto('/admin');
  await page.getByRole('switch', { name: '开放注册' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  const ctx = await browser.newContext();
  const anon = await ctx.newPage();
  await anon.goto('/login');
  await expect(anon.getByRole('link', { name: '注册' })).toBeVisible();
  await ctx.close();
});
```

Run: `pnpm --filter @flower/web e2e settings.spec.ts`
Expected: FAIL。

- [ ] **Step 2: 实现 `PlainShell` 并让首页使用它**

`apps/web/src/components/plain-shell.tsx`：

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from './logo';
import { UserMenu } from './user-menu';

export function PlainShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <div className="flex h-12 items-center justify-between border-b bg-card px-6">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <Logo />
          Flower
        </Link>
        <UserMenu />
      </div>
      <main className="mx-auto flex max-w-[960px] flex-col gap-5 px-8 py-8">{children}</main>
    </div>
  );
}
```

`apps/web/src/app/(app)/page.tsx`：把最外层的 `<div className="min-h-screen">…顶部栏…<main …>` 结构替换为 `<PlainShell>…</PlainShell>`（内容不变：标题行、组织列表、`CreateOrgDialog`），并删除不再使用的 `Logo`、`UserMenu` 导入。

- [ ] **Step 3: 实现组织信息页**

`apps/web/src/app/(app)/[org]/settings/general/page.tsx`：

```tsx
'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { qk, useApiMutation, useOrg } from '@/lib/queries';

const TIMEZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC'];

function GeneralPage() {
  const { org } = useParams<{ org: string }>();
  const q = useOrg(org);
  const [name, setName] = useState('');
  const [tz, setTz] = useState('Asia/Shanghai');
  useEffect(() => {
    if (q.data) {
      setName(q.data.org.name);
      setTz(q.data.org.settings.timezone ?? 'Asia/Shanghai');
    }
  }, [q.data]);
  const save = useApiMutation(() => api(`/orgs/${org}`, { method: 'PATCH', body: { name, timezone: tz } }), {
    invalidate: [qk.org(org), qk.me],
    success: '已保存',
  });
  if (!q.data) return null;
  return (
    <>
      <PageHeader crumbs={[{ label: '组织设置' }, { label: '组织信息' }]} title="组织信息" />
      <form
        className="flex max-w-lg flex-col gap-4 rounded-lg border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-name">组织名称</Label>
          <Input id="g-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>组织标识</Label>
          <Input value={q.data.org.slug} readOnly className="font-mono" />
          <span className="text-xs text-muted-foreground">标识出现在网址中，创建后不能修改。</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-tz">时区</Label>
          <Select value={tz} onValueChange={setTz}>
            <SelectTrigger id="g-tz">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from(new Set([tz, ...TIMEZONES])).map((z) => (
                <SelectItem key={z} value={z}>
                  {z}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" className="self-start" disabled={save.isPending}>
          保存
        </Button>
      </form>
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <GeneralPage />
    </RequireOrgAdmin>
  );
}
```

- [ ] **Step 4: 实现个人设置页**

`apps/web/src/app/(app)/settings/page.tsx`：

```tsx
'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { FormError } from '@/components/form-error';
import { IssueTokenDialog } from '@/components/issue-token-dialog';
import { PlainShell } from '@/components/plain-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describeScope, tokenStatus } from '@/features/tokens/model';
import { api } from '@/lib/api';
import { qk, useApiMutation, useMe, useOrg, useProducts, useTokens } from '@/lib/queries';

function PersonalTokens({ org }: { org: string }) {
  const orgQ = useOrg(org);
  const tokens = useTokens(org);
  const products = useProducts(org);
  const [issuing, setIssuing] = useState(false);
  const revoke = useApiMutation((id: string) => api(`/orgs/${org}/tokens/${id}`, { method: 'DELETE' }), { invalidate: [qk.tokens(org)], success: 'Token 已撤销' });
  const memberId = orgQ.data?.me.memberId;
  const mine = (tokens.data ?? []).filter((t) => t.memberId === memberId);
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>范围</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {mine.map((t) => (
              <TableRow key={t.id} className="h-10 even:bg-zebra">
                <TableCell>{t.name}</TableCell>
                <TableCell className="text-[13px]">{describeScope(t.scope, products.data ?? [])}</TableCell>
                <TableCell>{{ active: '有效', revoked: '已撤销', expired: '已过期' }[tokenStatus(t)]}</TableCell>
                <TableCell className="text-right">
                  {tokenStatus(t) === 'active' && (
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm">
                          撤销
                        </Button>
                      }
                      title={`撤销「${t.name}」？`}
                      description="撤销后使用这个 Token 的调用会立即失败。"
                      confirmLabel="确认撤销"
                      destructive
                      onConfirm={() => revoke.mutate(t.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {memberId && (
        <>
          <Button variant="outline" className="self-start" onClick={() => setIssuing(true)}>
            签发个人 Token
          </Button>
          <IssueTokenDialog org={org} open={issuing} onOpenChange={setIssuing} memberId={memberId} />
        </>
      )}
    </div>
  );
}

export default function PersonalSettingsPage() {
  const me = useMe();
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [org, setOrg] = useState<string>('');
  useEffect(() => {
    if (me.data) {
      setName(me.data.account.name);
      setOrg((o) => o || me.data!.orgs[0]?.slug || '');
    }
  }, [me.data]);
  const profile = useApiMutation((body: { name?: string; preferences?: { theme: 'light' | 'dark' | 'system' } }) => api('/me', { method: 'PATCH', body }), {
    invalidate: [qk.me],
    success: '已保存',
  });
  const password = useApiMutation(() => api('/me/password', { method: 'POST', body: { currentPassword: pw.current, newPassword: pw.next } }), {
    silentError: true,
    success: '密码已修改，其他设备上的登录已退出',
    onSuccess: () => setPw({ current: '', next: '', confirm: '' }),
  });
  if (!me.data) return null;
  return (
    <PlainShell>
      <h1 className="text-xl font-semibold">个人设置</h1>
      <section className="flex flex-col gap-4 rounded-lg border bg-card p-4">
        <h2 className="font-semibold">资料</h2>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="me-name">姓名</Label>
          <Input id="me-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label>邮箱</Label>
          <Input value={me.data.account.email} readOnly className="font-mono" />
        </div>
        <Button className="self-start" onClick={() => profile.mutate({ name })} disabled={profile.isPending}>
          保存资料
        </Button>
      </section>
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <h2 className="font-semibold">主题</h2>
        <Select
          value={theme ?? 'light'}
          onValueChange={(v) => {
            setTheme(v);
            profile.mutate({ preferences: { theme: v as 'light' | 'dark' | 'system' } });
          }}
        >
          <SelectTrigger className="w-40" aria-label="主题">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">浅色</SelectItem>
            <SelectItem value="dark">深色</SelectItem>
            <SelectItem value="system">跟随系统</SelectItem>
          </SelectContent>
        </Select>
      </section>
      <form
        className="flex flex-col gap-4 rounded-lg border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw.next !== pw.confirm) return setPwError('两次输入的新密码不一致');
          setPwError(null);
          password.mutate(undefined);
        }}
      >
        <h2 className="font-semibold">修改密码</h2>
        {(
          [
            ['current', '当前密码'],
            ['next', '新密码'],
            ['confirm', '确认新密码'],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="flex max-w-md flex-col gap-1.5">
            <Label htmlFor={`pw-${k}`}>{label}</Label>
            <Input id={`pw-${k}`} type="password" required value={pw[k]} onChange={(e) => setPw({ ...pw, [k]: e.target.value })} />
          </div>
        ))}
        {pwError && (
          <p role="alert" className="text-sm text-destructive">
            {pwError}
          </p>
        )}
        <FormError error={password.error} />
        <p className="text-xs text-muted-foreground">修改后，其他设备上的登录会被退出。</p>
        <Button type="submit" className="self-start" disabled={password.isPending}>
          修改密码
        </Button>
      </form>
      {me.data.orgs.length > 0 && (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <h2 className="flex-1 font-semibold">个人 Token</h2>
            <Select value={org} onValueChange={setOrg}>
              <SelectTrigger className="w-48" aria-label="Token 所属组织">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {me.data.orgs.map((o) => (
                  <SelectItem key={o.id} value={o.slug}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-[13px] text-muted-foreground">个人 Token 以你的身份调用 API，权限不超过你本人。每个 Token 只属于一个组织。</p>
          {org && <PersonalTokens key={org} org={org} />}
        </section>
      )}
    </PlainShell>
  );
}
```

- [ ] **Step 5: 实现实例设置页**

`apps/web/src/app/(app)/admin/page.tsx`：

```tsx
'use client';

import { NoAccess } from '@/components/no-access';
import { PlainShell } from '@/components/plain-shell';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { qk, useApiMutation, useInstanceSettings, useMe } from '@/lib/queries';

function Settings() {
  const q = useInstanceSettings();
  const save = useApiMutation((body: { allowSignup?: boolean; allowOrgCreation?: boolean }) => api('/instance/settings', { method: 'PATCH', body }), {
    invalidate: [qk.instance, qk.setup],
    success: '已保存',
  });
  if (!q.data) return null;
  const rows = [
    { key: 'allowSignup', label: '开放注册', hint: '关闭时只能通过邀请加入（默认）。', value: q.data.allowSignup },
    { key: 'allowOrgCreation', label: '允许用户自建组织', hint: '关闭时只有实例管理员可以创建组织。', value: q.data.allowOrgCreation },
  ] as const;
  return (
    <section className="flex flex-col divide-y rounded-lg border bg-card">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-4 px-4 py-3">
          <div className="flex flex-1 flex-col">
            <span className="font-medium">{r.label}</span>
            <span className="text-[13px] text-muted-foreground">{r.hint}</span>
          </div>
          <Switch aria-label={r.label} checked={r.value} onCheckedChange={(v) => save.mutate({ [r.key]: v })} />
        </div>
      ))}
    </section>
  );
}

export default function AdminPage() {
  const me = useMe();
  if (!me.data) return null;
  return (
    <PlainShell>
      <h1 className="text-xl font-semibold">实例设置</h1>
      {me.data.account.isInstanceAdmin ? <Settings /> : <NoAccess message="只有实例管理员可以修改实例设置。" />}
    </PlainShell>
  );
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/web e2e settings.spec.ts overview.spec.ts && pnpm --filter @flower/web typecheck`
Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add apps/web
git commit -m "feat(web): 组织信息、个人设置与实例设置"
```

---

### Task 16: P0 验收路线、冒烟测试与文档

**Files:**
- Create: `apps/web/e2e/acceptance.spec.ts`
- Create: `docs/p0-demo.md`
- Modify: `scripts/smoke.sh`（增加页面检查）
- Modify: `CLAUDE.md`（端到端测试命令与注意事项）

**Interfaces:**
- Consumes: 前面所有页面
- Produces: 一条覆盖 P0 全部用户价值的端到端验收用例；人工演示脚本

- [ ] **Step 1: 写验收用例**

`apps/web/e2e/acceptance.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { OWNER } from './helpers';

test('P0 验收：从初始化到签发 Agent Token 的完整路线', async ({ page, browser, playwright }) => {
  test.setTimeout(180_000);
  await resetDatabase();

  // 1. 初始化向导
  await page.goto('/');
  await page.waitForURL('**/setup');
  await page.getByLabel('你的姓名').fill(OWNER.name);
  await page.getByLabel('邮箱').fill(OWNER.email);
  await page.getByLabel('密码', { exact: true }).fill(OWNER.password);
  await page.getByLabel('确认密码').fill(OWNER.password);
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByLabel('组织名称').fill('123云盘');
  await page.getByLabel('组织标识').fill('pan');
  await page.getByRole('button', { name: '完成初始化' }).click();
  await page.getByRole('link', { name: '进入组织' }).click();
  await expect(page.getByText('已完成 0 / 6')).toBeVisible();

  // 2. 邀请成员 + 登记无账号成员
  await page.goto('/pan/settings/members');
  await page.getByRole('button', { name: '邀请成员' }).click();
  await page.getByLabel('邮箱').fill('pm@example.com');
  await page.getByRole('button', { name: '发送邀请' }).click();
  const link = await page.getByLabel('邀请链接').inputValue();
  await page.getByRole('button', { name: '完成' }).click();
  await page.getByRole('button', { name: '登记无账号成员' }).click();
  await page.getByLabel('显示名称').fill('王总');
  await page.getByRole('button', { name: '登记' }).click();

  // 3. 职能标签分配
  await page.getByRole('button', { name: '查看林澄' }).click();
  await page.getByRole('dialog', { name: '林澄' }).getByRole('checkbox', { name: '产品经理' }).check();
  await page.getByRole('dialog', { name: '林澄' }).getByRole('button', { name: '保存' }).click();

  // 4. 建产品
  await page.goto('/pan/settings/products');
  await page.getByRole('button', { name: '新建产品' }).click();
  await page.getByLabel('产品名称').fill('网盘');
  await page.getByLabel('编号前缀').fill('PAN');
  await page.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/settings/products/*');

  // 5. 编辑流程并发布
  await page.goto('/pan/settings/workflows');
  await page.getByRole('link', { name: '默认流程' }).click();
  await page.getByRole('tab', { name: /检查项/ }).click();
  await page.getByRole('button', { name: '新增检查项' }).click();
  await page.getByLabel('检查项名称').fill('PRD 评审');
  await page.getByRole('button', { name: '添加检查项' }).click();
  await page.getByRole('button', { name: '发布为 v2' }).click();
  await page.getByLabel('版本说明').fill('增加 PRD 评审');
  await page.getByRole('button', { name: '确认发布' }).click();
  await expect(page.getByText('已发布 v2')).toBeVisible();

  // 6. 字典
  await page.goto('/pan/settings/fields');
  const platform = page.getByRole('region', { name: '平台' });
  await platform.getByLabel('新选项').fill('PC客户端');
  await platform.getByRole('button', { name: '添加' }).click();
  await expect(platform.getByRole('textbox', { name: '选项名称' })).toHaveCount(1);

  // 7. Agent 与只读 Token
  await page.goto('/pan/settings/agents');
  await page.getByRole('button', { name: '创建 Agent' }).click();
  await page.getByLabel('Agent 名称').fill('PRD 助手');
  await page.getByRole('button', { name: '创建' }).click();
  await page.getByRole('button', { name: '签发 Token' }).click();
  await page.getByLabel('Token 名称').fill('Claude Code');
  await page.getByRole('radio', { name: '只读' }).click();
  await page.getByRole('button', { name: '签发' }).click();
  const token = await page.getByLabel('Token（只显示一次）').inputValue();
  await page.getByRole('button', { name: '我已保存' }).click();

  // 8. 配置清单全部完成
  await page.goto('/pan');
  await expect(page.getByText('已完成 6 / 6')).toBeVisible();

  // 9. 受邀成员加入后看不到设置入口
  const ctx = await browser.newContext();
  const pm = await ctx.newPage();
  await pm.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await pm.getByLabel('你的姓名').fill('周屿');
  await pm.getByLabel('设置密码').fill('password123');
  await pm.getByRole('button', { name: '接受邀请' }).click();
  await pm.waitForURL('**/pan');
  await expect(pm.getByText('组织设置')).toHaveCount(0);
  await ctx.close();

  // 10. Token 只读
  const api = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  expect((await api.get('/api/v1/orgs/pan/products')).status()).toBe(200);
  expect((await api.post('/api/v1/orgs/pan/products', { data: { name: 'x', key: 'XX' } })).status()).toBe(403);
  await api.dispose();
});
```

说明：邀请链接的主机来自 `FLOWER_PUBLIC_URL`（e2e 中为 `http://localhost:3100`），用例只取路径部分访问。

- [ ] **Step 2: 运行全部端到端测试**

Run: `pnpm --filter @flower/web e2e`
Expected: 全部 spec 通过（auth、overview、members、tags、products、workflows、fields、agents、settings、acceptance）。

- [ ] **Step 3: 冒烟测试增加页面检查**

在 `scripts/smoke.sh` 的第 5 步之前加入：

```bash
echo "4b. 页面可以访问"
curl -fs -o /dev/null -w '%{http_code}' http://localhost:3900/login | grep -q '200'
curl -fs http://localhost:3900/login | grep -q '<title>Flower</title>'
```

Run: `./scripts/smoke.sh > /tmp/flower-smoke.log 2>&1; echo EXIT=$? >> /tmp/flower-smoke.log`（后台运行，镜像构建较慢），完成后 `tail -12 /tmp/flower-smoke.log`
Expected: 各步骤通过，以"冒烟测试通过"结束，`EXIT=0`。

- [ ] **Step 4: 写演示脚本与更新 CLAUDE.md**

`docs/p0-demo.md`：

```markdown
# P0 验收演示

面向：实例管理员与组织管理员。普通成员在 P0 阶段只能看到组织概览和自己有权限的产品。

## 准备

`cp .env.selfhost.example .env`，填好三项密钥后 `docker compose up -d`，打开 http://localhost:3000 。

## 路线

1. **初始化向导**：创建管理员账号 → 创建组织（例如"123云盘"，标识 `pan`）→ 进入组织。概览页出现"组织配置清单"，已完成 0 / 6。
2. **成员**：邀请一位同事（复制邀请链接）；登记无账号成员"王总"（商务部）；打开自己的详情，勾选"产品经理"职能。
3. **产品**：新建"网盘"，编号前缀 `PAN`。在产品详情中查看流程、字段、成员角色。
4. **流程模板**：打开"默认流程"，在"状态"里按 123云盘 的实际流程增改状态；在"检查项"里加"PRD 评审"；在"流转"矩阵里给"待开始 → 进行中"加条件"PRD 评审 = 通过"；右侧状态图实时变化；发布为 v2，查看版本历史。
5. **字段字典**：给"平台"添加 PC客户端、移动端、Web端、小程序；设置层级叫法。
6. **Agent 与 Token**：创建"PRD 助手"，签发只读 Token（限定"网盘"）。用 `curl -H "Authorization: Bearer <token>" http://localhost:3000/api/v1/orgs/pan/products` 验证只能读、不能写。
7. **回到概览**：配置清单 6 / 6 全部完成。
8. **成员视角**：用另一个浏览器打开邀请链接注册，确认看不到"组织设置"，直接访问设置页显示"无权访问"。
9. **实例设置**：个人菜单 → 实例设置，演示注册开关。
```

在 `CLAUDE.md` 的命令表中增加一行，并在"约定"末尾追加两条：

```markdown
| 端到端测试（需要 db:up；会占用 3100 端口，不要与 pnpm dev 同时运行） | `pnpm --filter @flower/web e2e` |
```

```markdown
- 页面是客户端组件，通过 `/api/v1` 取数；只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`。
- 纯逻辑放在 `apps/web/src/features/**/model.ts` 并写 Vitest 单测；页面行为用 Playwright 覆盖，每个 spec 自己调用 `resetDatabase()`。
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/e2e docs/p0-demo.md scripts/smoke.sh CLAUDE.md
git commit -m "test: P0 验收用例、冒烟测试页面检查与演示脚本"
```

---

## P0-B 完成标准

- `pnpm test && pnpm typecheck` 通过。
- `pnpm --filter @flower/web e2e` 全部通过（含 `acceptance.spec.ts`）。
- `./scripts/smoke.sh` 通过。
- 按 `docs/p0-demo.md` 走一遍，界面与样稿"定稿"方向一致。
