# Flower P1-B1 迭代、发布版本、阻塞项与关联、结构树维护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让迭代、发布版本、阻塞项、需求关联和结构树可以在界面上新建和维护：迭代有列表与详情（状态操作、里程碑、需求、承诺范围对比、发布版本），需求按流程准入条件加入迭代（产品管理员可带原因强制），补上 P0-B 留下的产品管理员缺口，最后用生产数据副本验证性能并交给用户验收。

**Architecture:** 不新增表、不新增迁移：P1-A 已建好 `iterations`、`iteration_scope_snapshots`、`releases`、`requirement_releases`、`blockers`、`requirement_relations`、`structure_nodes`，并在 `0006_p1a_rls.sql` 中开启 RLS 和迭代排他约束。新服务放在 `packages/core/src/{iterations,releases,structure}/` 与 `packages/core/src/requirements/{blockers,relations}.ts`，签名 `(db, actor, input)`，在 `withOrg` 事务里读写并在同一事务调用 `recordEvent`。HTTP 层新增 `iterations.ts`、`releases.ts`、`structure.ts` 三个路由文件并扩展 `requirements.ts`、`products.ts`，只做 zod 校验和调用。页面沿用 P1-A 写法（客户端组件 + TanStack Query + `/api/v1`）。

**Tech Stack:** Postgres 17（`btree_gist` 排他约束，错误码 23P01）、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui（Radix）、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§2.2 权限与强制流转、§3.1 `actionGates`、§3.3 层级叫法、§4.1 结构树、§4.2 附属表、§4.3 迭代与发布版本、§6.6 指标数据来源、§7.2 迭代与发布版本迁移）。范围由用户在 2026-09-29 确认（P1-B 拆为 B1 / B2，本计划只做 B1），逐条决定见下方「设计决定」。

## Global Constraints

- 生产数据副本、对照表、对账报告只放在 `.local-data/`（已在 `.git/info/exclude` 忽略），任何含员工姓名或邮箱的文件不得提交。测试夹具、端到端用例、文档示例只用虚构姓名和 `@example.com` 邮箱。
- 本计划不新增表，不新增迁移。执行中如发现必须改表结构，停下来报告；若确需新表，按 `CLAUDE.md` 执行 `pnpm --filter @flower/core db:generate`，新租户表带 `org_id` 并在新的自定义迁移里开启 RLS（参照 `0002_rls.sql`）。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`，一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写；写操作同事务调用 `recordEvent`，修改类事件 payload 带 `changes: [{field, old, new}]`。
- 权限：产品内写操作用 `requireProductRole(tx, actor, productId, 'editor' | 'admin')`，组织级操作用 `requireOrgAdmin(actor)`。只读 Token 在 `capByScope` 中被降为 viewer、在 `isOrgAdmin` 中返回 false，因此两者都会拒绝只读 Token 的写操作；不另写 Token 判断。
- 面向用户的文案与错误信息用中文，错误通过 `AppError(code, message, details?)` 抛出。
- `apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`（以及浏览器安全的 `@flower/core/workflow-schema`）。纯逻辑放 `apps/web/src/features/**/model.ts`（或同目录的纯函数文件）并写 Vitest 单测。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`。用渲染期间调整：记住上次同步的来源值（初值为空 / `undefined`），来源变了就在渲染时同时更新同步值和表单状态。参照 `apps/web/src/app/(app)/[org]/settings/general/page.tsx`。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框和内联表单用 `silentError: true` + `<FormError error={mutation.error} />`。
- 页面加载失败：404 / 403 显示 `NoAccess`，其他错误显示「重试」按钮，与需求详情页一致。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0`（CI 已加入，零错误零警告）。
- 视觉沿用 P0-B：表格行高 40px、隔行底色 `even:bg-zebra`、编号与日期用等宽字体（`font-mono`）、卡片圆角 6px、按钮与输入框圆角 4px、页面标题 20px。
- 端到端测试：每个 spec 自己在 `beforeEach` 或用例开头调用 `resetDatabase()`；不为迁就定位器修改应用或共享组件代码；Radix 弹出内容用 `page` 定位；`role="alert"` 用 `.filter({ hasText })` 限定。端到端占用 3100 端口，不要与 `pnpm dev` 同时运行。
- `pnpm test` 和端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；之后要跑 `pnpm dev` 或性能测量，先执行 `pnpm db:migrate`。
- 每个 commit message 末尾加一行 `Co-Authored-By: <实际编写该提交的模型> <noreply@anthropic.com>`。

## 设计决定

| 项 | 决定 | 依据 |
|---|---|---|
| 范围 | P1-B 拆为 B1（本计划）与 B2；甘特进度用 push 的工作日算法、工作台作为登录后默认页、按检查项配置的批量评审表都在 B2 | 用户 2026-09-29 决定 |
| 迭代管理权限 | 常规迭代由产品编辑及以上（含组织管理员）新建、修改、改状态、删除；专项只有组织管理员可以 | spec §2.2（editor 可增删改迭代）；spec §4.3 常规属于产品、专项属于组织 |
| 迭代字段 | 名称（1–50 字）、开始 / 结束日期（开始 ≤ 结束）、里程碑 `[{label, date}]`（≤ 20 个，名称 1–20 字，按日期排序保存） | spec §4.3 |
| 迭代重叠 | 依赖数据库排他约束 `iterations_regular_no_overlap`，把错误码 23P01 映射为 `AppError('conflict', '与已有迭代时间重叠')`；结束日与下一迭代开始日相同不算重叠 | spec §4.3；P1-A 设计决定 |
| 迭代状态 | 只允许 planning→active、active→done、planning/active→canceled；每次写 `iteration.status_changed` 事件 | 简报 |
| 承诺快照 | planning→active 同一事务内设置 `baseline_end_date = end_date`，并为当时迭代内的全部需求写 `committed` 快照；该迭代已有 committed 行（迁移数据）时不重复写 | spec §4.3、§6.6 |
| 删除迭代 | 软删除；只允许规划中且没有需求的迭代 | 简报 |
| 加入 / 移出迭代 | `setRequirementIteration(db, actor, requirementId, {iterationId \| null, force?, reason?})`，需编辑及以上；加入时按流程 `actionGates` 中 `join_iteration` 的条件，用现有 `unmetConditions` 判断，不满足抛 `precondition_failed`，`details.unmet` 为原因列表；产品管理员可带原因强制，`forced`、`reason` 写入事件 payload；移出总是允许 | 简报；spec §2.2 强制流转 |
| 加入迭代的目标 | 只能加入规划中或进行中的迭代；常规迭代必须同产品；专项可接收任何产品的需求；一条需求最多在一个迭代（直接改到另一个迭代视为移入新迭代，同样检查准入条件） | 简报；spec §4.2 |
| 发布版本 | 编辑及以上可以新建、修改、标记发布、关联 / 解除需求；平台选项必须属于本产品当前生效的「平台」字段；迭代必须同产品或为专项；创建时 `baseline_date = planned_date`，之后改计划日期不动基线 | 简报；spec §6.6 按期达成率 |
| 字段覆盖遗留问题 | `forkFieldForProduct` 同一事务内按选项 key 把本产品 `releases.platform_option_id` 与 `requirement_assignments.platform_option_id` 改指向产品级选项，数量计入事件的 `movedValues` | P1-A 遗留项 |
| 阻塞项 | 编辑及以上可以新建（描述、可选负责人）与解除（写 `status = resolved`、`resolved_at`） | 简报 |
| 需求关联 | 类型取 `RELATION_TYPES`；不能关联自身；跨组织由 RLS 隔离，表现为「需求不存在」；跨产品要求操作者能看到对方产品；唯一索引冲突映射为 `conflict`；`blocks` / `duplicate_of` / `merged_into` / `derived_from` 按方向显示；「合并重复需求」只记 `merged_into`，不自动流转 | 简报 |
| 结构树维护 | 产品管理员可新建（深度 = 上级 + 1，≤ 3）、改名、改说明、停用 / 恢复、移动（子树整体平移深度，仍需 ≤ 3）、同级整数排序 | 简报；spec §4.1 |
| 层级叫法 | P0-B 已实现（`setProductLevelNames`、产品设置「字段与层级」页签），本计划不改，只在结构树页签显示 | 代码现状 |
| 新错误码 | `ErrorCode` 增加 `precondition_failed`，HTTP 412。需求状态流转的「条件未满足」仍返回 `invalid`（400），不改 | 简报要求加入迭代用 `precondition_failed`；流转接口已有调用方和测试，改码属于无关改动 |
| 发布版本的界面位置 | 迭代详情「发布版本」页签（列表、新建、编辑、标记发布）+ 需求详情「发布版本」区块（关联 / 解除）；不做单独的 `/releases` 页面 | push 的版本按迭代组织，日常操作都从迭代进入；没有迭代的发布版本（迁移数据）仍能在需求详情里关联；按产品的版本总览与 B2 的甘特 / 版本视图一起做，避免现在做一个很快被替换的页面 |
| 创建发布版本 | 计划发布日期必填 | 基线来自计划日期；不填则按期达成率无法计算（spec §7.3 已说明迁移数据没有计划日期） |
| 专项的可见性 | 能看到至少一个产品的成员可以看到专项；专项里的需求、数量、范围对比只计入操作者能看到的产品 | 专项跨产品；访客只应看到被授权产品的需求 |
| 修改迭代 | 规划中、进行中可以改名称、日期、里程碑；已完成、已取消不能改；改结束日期不影响基线 | 基线只在开始时锁定 |
| 删除迭代的附加条件 | 挂有发布版本时也不能删除 | 否则发布版本指向已删除的迭代 |
| 范围对比没有快照 | 迭代没有 committed 快照（迁移的历史迭代，或开始时迭代为空）时返回 `hasSnapshot = false`，当前需求全部放在 `addedLater`；界面给出提示，只列「当前范围」，不划分四类 | P1-A 未迁移历史快照；硬分四类会把全部需求算成「中途加入」 |
| 范围对比的适用状态 | 规划中的迭代返回 `invalid`；进行中、已完成、已取消可以查看 | 快照在开始时生成 |
| 删除关联的权限 | 能看到两端需求，且在任一端产品上是编辑及以上 | 关联在两端都显示，任一端的负责人都应能纠正 |
| 发布版本关联需求 | 只能关联同产品需求；重复关联、重复解除都不报错，只有实际变化时才记事件 | 界面重复点击不应报错 |
| 结构节点停用 | 停用不级联；需求详情的节点下拉隐藏已停用节点及其下级，当前选中的节点保留并标注「已停用」 | 恢复时不必逐个恢复子节点 |
| 结构树界面 | 页签提供新增、改名、停用 / 恢复、上移 / 下移；「移动到其他上级」和「编辑说明」只提供接口，不做界面 | 简报列出的界面范围；这两项使用频率低 |
| 需求详情节点字段 | 行名由「业务域」改为「结构节点」，可选任意层级，按树顺序缩进显示 | spec §4.2：需求可挂在任意一层 |
| 产品管理员入口 | 概览页的产品卡片对不是组织管理员的产品管理员显示「产品设置」链接（组织管理员已有设置导航）；产品设置页面包屑对非组织管理员显示为「概览 / 产品设置 / 产品名」 | 非组织管理员没有设置导航；原面包屑指向组织级产品列表，点击后无权访问 |
| 角色页签数据来源 | 新增 `listProductMemberRoles`（产品管理员可调用，返回在职成员及其本产品角色），角色页签改用它 | 访客调用 `listMembers` 会被 `requireNonGuest` 拒绝，这是访客产品管理员看到空页签的原因 |
| 覆盖字段的选项编辑 | 把字段字典页的 `FieldCard` 移到 `components/field-card.tsx`，产品「字段与层级」页签对已覆盖字段直接渲染可编辑卡片 | 选项接口已按产品管理员授权，只缺界面 |
| 迭代查询键 | `qk.iterations`（按产品的迭代下拉）改为 `['org', o, 'iterations', 'product', id]`，与新列表、详情共用 `iterationKeys(o)` 前缀 | 迭代变化后一次失效所有迭代相关查询 |
| 阻塞项、关联的位置 | 从右侧栏移到详情页主栏（检查项之后），右侧栏保留开发分配、任务、发布版本 | 两个区块都有输入框和搜索结果，320px 侧栏放不下 |
| 留给 P1-B2 | 任务 CRUD 与甘特（push 工作日算法）、人员负载热力图、工作台（登录后默认页）、按检查项配置的批量评审表、日常操作新旧对比、用户试用、按产品的发布版本总览页、结构树的拖拽与「移动」界面；产品设置页遇到 5xx 时显示重试而不是「无权访问」（归入 P0-B 暂缓的统一错误状态）；通知仍在 P3 | 用户 2026-09-29 拆分 |

## 文件结构

```
packages/core/
  src/errors.ts                              # 新错误码 precondition_failed（Task 1）
  src/dates.ts                               # assertIsoDate（Task 1）
  src/access/permissions.ts                  # visibleProductIds（Task 1）
  src/iterations/iterations.ts               # 迭代列表、详情、新建、修改、状态、删除、范围对比（Task 1）
  src/iterations/membership.ts               # 加入 / 移出迭代、准入条件（Task 2）
  src/requirements/detail.ts                 # joinIterationUnmet（Task 2）、relations[].id（Task 4）
  src/releases/releases.ts                   # 发布版本（Task 3）
  src/definitions/fields.ts                  # 覆盖字段时改写平台选项引用（Task 3）
  src/requirements/blockers.ts               # 阻塞项（Task 4）
  src/requirements/relations.ts              # 需求关联（Task 4）
  src/structure/nodes.ts                     # 结构树维护（Task 5）
  src/requirements/lookups.ts                # StructureNodeView 增加 description（Task 5）
  src/tenancy/products.ts                    # listProductMemberRoles（Task 5）
  src/index.ts                               # 导出（Task 1–5）
  test/iterations.test.ts  test/iteration-membership.test.ts  test/releases.test.ts
  test/blockers-relations.test.ts  test/structure.test.ts  test/product-member-roles.test.ts
apps/web/
  src/server/http.ts                         # 412（Task 1）
  src/server/routes/iterations.ts  releases.ts  structure.ts   # 新路由（Task 6）
  src/server/routes/requirements.ts  products.ts  src/server/api.ts   # 扩展与注册（Task 6）
  test/api/iterations.test.ts  test/api/maintenance.test.ts            # 接口测试（Task 6）
  src/lib/types.ts  src/lib/queries.ts  src/lib/api.ts  src/lib/labels.ts
  src/features/shell/nav.ts                  # 启用「迭代」（Task 7）
  src/features/iterations/model.ts           # 分组、里程碑、表单校验、状态操作、完成率（Task 7、8）
  src/features/structure/model.ts            # 树排序、节点下拉、同级移动、层级叫法（Task 10、12）
  src/features/requirements/relations.ts     # 关联读法、编号解析（Task 11）
  src/components/form-error.tsx              # 显示 details.unmet（Task 8）
  src/components/force-join-dialog.tsx       # 强制加入迭代对话框（Task 8）
  src/components/field-card.tsx              # 从字段字典页移出（Task 13）
  src/app/(app)/[org]/iterations/page.tsx  iteration-dialog.tsx         # 列表（Task 7）
  src/app/(app)/[org]/iterations/[id]/page.tsx  requirements-tab.tsx  scope-tab.tsx   # 详情（Task 8）
  src/app/(app)/[org]/iterations/[id]/releases-tab.tsx  release-dialog.tsx            # 发布版本（Task 9）
  src/app/(app)/[org]/requirements/[key]/releases.tsx  iteration-field.tsx  blockers.tsx  relations.tsx
  src/app/(app)/[org]/settings/products/[productId]/structure-tab.tsx   # 结构树（Task 12）
  e2e/iterations.spec.ts  e2e/requirement-maintenance.spec.ts  e2e/structure.spec.ts  e2e/product-admin.spec.ts
packages/migrate/src/perf.ts  test/perf.test.ts   # 新增性能用例（Task 14）
docs/p1b-validation.md  docs/handoff.md  docs/agent-log.md   # 验证记录与交接（Task 14）
```

---
### Task 1: 迭代服务：列表、详情、新建、修改、状态流转与承诺快照、删除、范围对比

**Files:**
- Modify: `packages/core/src/errors.ts`（`ErrorCode` 增加 `precondition_failed`）
- Modify: `apps/web/src/server/http.ts`（`STATUS` 增加 `precondition_failed: 412`，否则类型检查不过）
- Create: `packages/core/src/dates.ts`
- Modify: `packages/core/src/access/permissions.ts`（增加 `visibleProductIds`）
- Create: `packages/core/src/iterations/iterations.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/iterations.test.ts`

**Interfaces:**
- Consumes: `productRoleOf`、`requireProductRole`、`requireOrgAdmin`、`isOrgAdmin`、`atLeast`（`access/permissions.ts`）；`productWorkflowBody`、`memberNames`（`requirements/context.ts`）；`displayKey`、`MemberRef`（`requirements/requirements.ts`）；`IterationMilestone`、`iterations`、`iterationScopeSnapshots`、`requirements`、`blockers`、`releases`、`products`（`db/schema.ts`）
- Produces（`errors.ts`）：`ErrorCode` 新增 `'precondition_failed'`
- Produces（`dates.ts`）：`assertIsoDate(value: string, label: string): string`（非 `YYYY-MM-DD` 或不存在的日期抛 `invalid`「{label}格式应为 YYYY-MM-DD」）
- Produces（`permissions.ts`）：`visibleProductIds(tx: Tx, actor: Actor): Promise<Set<string>>`（未删除且 `productRoleOf` 非空的产品）
- Produces（`iterations/iterations.ts`）：
  - `type IterationStatus = 'planning' | 'active' | 'done' | 'canceled'`；`ITERATION_STATUS_LABELS: Record<IterationStatus, string>`
  - `type StateInfo = { label: string; color: string; category: string }`
  - `type IterationView = { id: string; type: 'regular' | 'special'; product: { id: string; key: string; name: string } | null; name: string; startDate: string; endDate: string; baselineEndDate: string | null; status: IterationStatus; milestones: IterationMilestone[]; requirementCount: number; doneCount: number; canManage: boolean }`
  - `type IterationRequirement = { id: string; productId: string; displayKey: string; title: string; stateKey: string; state: StateInfo; owner: MemberRef | null; activeBlockers: number; canEdit: boolean }`
  - `type IterationDetail = IterationView & { requirements: IterationRequirement[] }`
  - `type IterationScopeItem = { id: string; displayKey: string; title: string; state: StateInfo; currentIteration: { id: string; name: string } | null }`
  - `type IterationScope = { hasSnapshot: boolean; snapshotAt: Date | null; committedDone: IterationScopeItem[]; committedOpen: IterationScopeItem[]; addedLater: IterationScopeItem[]; removed: IterationScopeItem[] }`
  - `listIterations(db, actor, input?: { productId?: string }): Promise<IterationView[]>`（开始日期倒序；指定产品时含该产品常规迭代与全部专项）
  - `getIteration(db, actor, id: string): Promise<IterationDetail>`
  - `createIteration(db, actor, input: { type: 'regular' | 'special'; productId?: string | null; name: string; startDate: string; endDate: string; milestones?: IterationMilestone[] }): Promise<IterationView>`
  - `updateIteration(db, actor, id: string, input: { name?: string; startDate?: string; endDate?: string; milestones?: IterationMilestone[] }): Promise<IterationView>`
  - `setIterationStatus(db, actor, id: string, to: IterationStatus): Promise<IterationView>`
  - `deleteIteration(db, actor, id: string): Promise<void>`
  - `getIterationScope(db, actor, id: string): Promise<IterationScope>`
- 事件：`iteration.created`（`name`、`type`、`startDate`、`endDate`）、`iteration.updated`（`changes`）、`iteration.status_changed`（`changes`、`snapshotCount`）、`iteration.deleted`（`name`）；`subjectType = 'iteration'`，`productId` 为迭代所属产品（专项为空）
- 错误：重叠 `conflict`「与已有迭代时间重叠」；无权看到 `not_found`「迭代不存在」；非法状态变化 `invalid`「不能从「X」变为「Y」」

- [ ] **Step 1: 写失败的测试**

`packages/core/test/iterations.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockers, domainEvents, iterationScopeSnapshots, releases, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import {
  createIteration,
  deleteIteration,
  getIteration,
  getIterationScope,
  listIterations,
  setIterationStatus,
  updateIteration,
} from '../src/iterations/iterations';
import { createRequirement } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pm: Actor;
let editor: Actor;
let viewer: Actor;
let readToken: Actor;
let pan: string;
let doc: string;

async function asMember(name: string, orgRole: Actor['orgRole'] = 'member'): Promise<Actor> {
  const m = await createPlaceholderMember(t.db, owner, { displayName: name });
  return { ...owner, memberId: m.id, orgRole, accountId: null };
}
const putInIteration = (requirementId: string, iterationId: string | null) =>
  withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ iterationId }).where(eq(requirements.id, requirementId)));
const setState = (requirementId: string, stateKey: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ stateKey }).where(eq(requirements.id, requirementId)));
const eventsOf = (subjectId: string) => withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(eq(domainEvents.subjectId, subjectId)));
const snapshotsOf = (iterationId: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.select().from(iterationScopeSnapshots).where(eq(iterationScopeSnapshots.iterationId, iterationId)));
const regular = (productId: string, name: string, startDate: string, endDate: string) =>
  ({ type: 'regular' as const, productId, name, startDate, endDate });

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  pm = await asMember('产品经理甲');
  await setProductRole(t.db, owner, pan, pm.memberId, 'admin');
  editor = await asMember('开发乙');
  viewer = await asMember('只读丙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
});
afterAll(() => t.cleanup());

describe('新建与修改迭代', () => {
  it('产品管理员可以新建常规迭代；编辑、只读成员、只读 Token 不行', async () => {
    const created = await createIteration(t.db, pm, {
      ...regular(pan, '迭代0701', '2026-07-01', '2026-07-15'),
      milestones: [
        { label: '发布', date: '2026-07-15' },
        { label: '开发开始', date: '2026-07-03' },
      ],
    });
    expect(created).toMatchObject({ type: 'regular', product: { key: 'PAN' }, status: 'planning', baselineEndDate: null, requirementCount: 0, canManage: true });
    expect(created.milestones.map((m) => m.label)).toEqual(['开发开始', '发布']);
    const input = regular(pan, '越权迭代', '2026-12-01', '2026-12-10');
    await expect(createIteration(t.db, editor, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createIteration(t.db, viewer, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createIteration(t.db, readToken, input)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await eventsOf(created.id)).map((e) => e.type)).toEqual(['iteration.created']);
  });

  it('同一产品的常规迭代不能重叠；结束日与下一迭代开始日相同可以；其他产品不受影响', async () => {
    await expect(createIteration(t.db, owner, regular(pan, '重叠迭代', '2026-07-10', '2026-07-20'))).rejects.toMatchObject({
      code: 'conflict',
      message: '与已有迭代时间重叠',
    });
    await createIteration(t.db, owner, regular(pan, '迭代0715', '2026-07-15', '2026-07-29'));
    await createIteration(t.db, owner, regular(doc, '文档迭代', '2026-07-10', '2026-07-20'));
  });

  it('专项只有组织管理员可以新建，可以和常规迭代重叠', async () => {
    const sp = await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-07-01', endDate: '2026-09-30' });
    expect(sp).toMatchObject({ type: 'special', product: null, canManage: true });
    await expect(createIteration(t.db, pm, { type: 'special', name: '越权专项', startDate: '2026-07-01', endDate: '2026-07-02' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('校验名称、日期与归属', async () => {
    await expect(createIteration(t.db, owner, regular(pan, '倒序', '2026-08-10', '2026-08-01'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createIteration(t.db, owner, regular(pan, '不存在的日期', '2026-02-30', '2026-03-01'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createIteration(t.db, owner, regular(pan, '   ', '2026-08-01', '2026-08-02'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createIteration(t.db, owner, { type: 'regular', name: '缺产品', startDate: '2026-08-01', endDate: '2026-08-02' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      createIteration(t.db, owner, { type: 'special', productId: pan, name: '专项带产品', startDate: '2026-08-01', endDate: '2026-08-02' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('修改名称与里程碑并记录变更；改到重叠日期被拒绝；只读成员不能改', async () => {
    const target = (await listIterations(t.db, owner, { productId: pan })).find((i) => i.name === '迭代0701')!;
    const updated = await updateIteration(t.db, pm, target.id, { name: '迭代0701（改）', milestones: [] });
    expect(updated).toMatchObject({ name: '迭代0701（改）', milestones: [] });
    const ev = (await eventsOf(target.id)).find((e) => e.type === 'iteration.updated')!;
    expect(ev.payload).toMatchObject({ changes: [{ field: 'name', old: '迭代0701', new: '迭代0701（改）' }, { field: 'milestones' }] });
    await expect(updateIteration(t.db, pm, target.id, { endDate: '2026-07-20' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(updateIteration(t.db, viewer, target.id, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateIteration(t.db, readToken, target.id, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('状态流转与承诺快照', () => {
  it('开始时锁定基线并记录承诺范围；之后改结束日期不动基线；结束后不能再改', async () => {
    const it2 = await createIteration(t.db, owner, regular(pan, '迭代0801', '2026-08-01', '2026-08-14'));
    const a = await createRequirement(t.db, owner, pan, { title: '批量重命名' });
    const b = await createRequirement(t.db, owner, pan, { title: '回收站搜索' });
    await putInIteration(a.id, it2.id);
    await putInIteration(b.id, it2.id);
    await expect(setIterationStatus(t.db, owner, it2.id, 'done')).rejects.toMatchObject({ code: 'invalid' });
    await expect(setIterationStatus(t.db, editor, it2.id, 'active')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setIterationStatus(t.db, readToken, it2.id, 'active')).rejects.toMatchObject({ code: 'forbidden' });

    const active = await setIterationStatus(t.db, pm, it2.id, 'active');
    expect(active).toMatchObject({ status: 'active', baselineEndDate: '2026-08-14', requirementCount: 2 });
    expect((await snapshotsOf(it2.id)).map((s) => s.requirementId).sort()).toEqual([a.id, b.id].sort());
    const ev = (await eventsOf(it2.id)).find((e) => e.type === 'iteration.status_changed')!;
    expect(ev.payload).toMatchObject({ changes: [{ field: 'status', old: 'planning', new: 'active' }], snapshotCount: 2 });

    expect((await updateIteration(t.db, pm, it2.id, { endDate: '2026-08-15' })).baselineEndDate).toBe('2026-08-14');
    await expect(setIterationStatus(t.db, pm, it2.id, 'planning')).rejects.toMatchObject({ code: 'invalid' });
    expect((await setIterationStatus(t.db, pm, it2.id, 'done')).status).toBe('done');
    await expect(setIterationStatus(t.db, pm, it2.id, 'canceled')).rejects.toMatchObject({ code: 'invalid' });
    await expect(updateIteration(t.db, pm, it2.id, { name: '已结束还想改' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await snapshotsOf(it2.id)).toHaveLength(2);
  });

  it('已有承诺快照（迁移数据）时开始迭代不重复写入', async () => {
    const it3 = await createIteration(t.db, owner, regular(pan, '迭代0901', '2026-09-01', '2026-09-14'));
    const c = await createRequirement(t.db, owner, pan, { title: '迁移来的需求' });
    await putInIteration(c.id, it3.id);
    await withOrg(t.db, owner.orgId, (tx) =>
      tx.insert(iterationScopeSnapshots).values({ orgId: owner.orgId, iterationId: it3.id, requirementId: c.id, snapshotKind: 'committed' }),
    );
    const d = await createRequirement(t.db, owner, pan, { title: '开始前加入的需求' });
    await putInIteration(d.id, it3.id);
    await setIterationStatus(t.db, owner, it3.id, 'active');
    expect((await snapshotsOf(it3.id)).map((s) => s.requirementId)).toEqual([c.id]);
    const ev = (await eventsOf(it3.id)).find((e) => e.type === 'iteration.status_changed')!;
    expect(ev.payload).toMatchObject({ snapshotCount: 0 });
  });

  it('规划中和进行中的迭代都可以取消', async () => {
    const x = await createIteration(t.db, owner, regular(pan, '迭代0915', '2026-09-15', '2026-09-20'));
    expect((await setIterationStatus(t.db, owner, x.id, 'canceled')).status).toBe('canceled');
  });
});

describe('列表、详情与范围对比', () => {
  it('列表给出需求数与已完成数；详情列出需求、负责人与未解除的阻塞项数', async () => {
    const it4 = await createIteration(t.db, owner, regular(pan, '迭代1001', '2026-10-01', '2026-10-14'));
    const e = await createRequirement(t.db, owner, pan, { title: '上传限速', ownerMemberId: editor.memberId });
    const f = await createRequirement(t.db, owner, pan, { title: '下载限速' });
    await putInIteration(e.id, it4.id);
    await putInIteration(f.id, it4.id);
    await setState(f.id, 'done');
    await withOrg(t.db, owner.orgId, (tx) =>
      tx.insert(blockers).values([
        { orgId: owner.orgId, requirementId: e.id, description: '等待存储接口' },
        { orgId: owner.orgId, requirementId: e.id, description: '已解决的阻塞', status: 'resolved' },
      ]),
    );
    const view = (await listIterations(t.db, owner, { productId: pan })).find((i) => i.id === it4.id)!;
    expect(view).toMatchObject({ requirementCount: 2, doneCount: 1 });
    const detail = await getIteration(t.db, viewer, it4.id);
    expect(detail.canManage).toBe(false);
    expect(detail.requirements.map((r) => [r.displayKey, r.title, r.state.category, r.activeBlockers, r.canEdit])).toEqual([
      [e.displayKey, '上传限速', 'backlog', 1, false],
      [f.displayKey, '下载限速', 'completed', 0, false],
    ]);
    expect(detail.requirements[0]!.owner).toEqual({ id: editor.memberId, displayName: '开发乙' });
    expect((await getIteration(t.db, editor, it4.id)).requirements[0]!.canEdit).toBe(true);
  });

  it('专项中的需求只列出操作者能看到的产品；看不到任何产品的访客看不到专项', async () => {
    const sp = (await listIterations(t.db, owner)).find((i) => i.name === '专业空间优化')!;
    const g = await createRequirement(t.db, owner, pan, { title: '空间容量提醒' });
    const h = await createRequirement(t.db, owner, doc, { title: '文档空间统计' });
    await putInIteration(g.id, sp.id);
    await putInIteration(h.id, sp.id);
    expect((await getIteration(t.db, owner, sp.id)).requirements.map((r) => r.title).sort()).toEqual(['文档空间统计', '空间容量提醒'].sort());
    const guest = await asMember('访客丁', 'guest');
    await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
    const seen = await getIteration(t.db, guest, sp.id);
    expect(seen.requirements.map((r) => r.title)).toEqual(['空间容量提醒']);
    expect(seen.requirementCount).toBe(1);
    await expect(listIterations(t.db, guest, { productId: doc })).rejects.toMatchObject({ code: 'not_found' });
    const outsider = await asMember('访客戊', 'guest');
    expect(await listIterations(t.db, outsider)).toEqual([]);
    await expect(getIteration(t.db, outsider, sp.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('范围对比：承诺内已完成、承诺内未完成、中途加入、中途移出', async () => {
    const it5 = await createIteration(t.db, owner, regular(pan, '迭代1101', '2026-11-01', '2026-11-14'));
    const done = await createRequirement(t.db, owner, pan, { title: '承诺完成' });
    const open = await createRequirement(t.db, owner, pan, { title: '承诺未完成' });
    const moved = await createRequirement(t.db, owner, pan, { title: '将被移出' });
    for (const r of [done, open, moved]) await putInIteration(r.id, it5.id);
    await expect(getIterationScope(t.db, owner, it5.id)).rejects.toMatchObject({ code: 'invalid' });
    await setIterationStatus(t.db, owner, it5.id, 'active');
    await setState(done.id, 'done');
    const next = await createIteration(t.db, owner, regular(pan, '迭代1115', '2026-11-15', '2026-11-28'));
    await putInIteration(moved.id, next.id);
    const late = await createRequirement(t.db, owner, pan, { title: '中途加入的需求' });
    await putInIteration(late.id, it5.id);

    const scope = await getIterationScope(t.db, viewer, it5.id);
    expect(scope.hasSnapshot).toBe(true);
    expect(scope.snapshotAt).toBeInstanceOf(Date);
    expect(scope.committedDone.map((x) => x.title)).toEqual(['承诺完成']);
    expect(scope.committedOpen.map((x) => x.title)).toEqual(['承诺未完成']);
    expect(scope.addedLater.map((x) => x.title)).toEqual(['中途加入的需求']);
    expect(scope.removed).toEqual([expect.objectContaining({ title: '将被移出', currentIteration: { id: next.id, name: '迭代1115' } })]);
  });

  it('没有承诺快照时 hasSnapshot 为 false，当前需求都放在 addedLater', async () => {
    const it6 = await createIteration(t.db, owner, regular(pan, '迭代1201', '2026-12-01', '2026-12-14'));
    await setIterationStatus(t.db, owner, it6.id, 'active');
    const x = await createRequirement(t.db, owner, pan, { title: '开始后才加入' });
    await putInIteration(x.id, it6.id);
    const scope = await getIterationScope(t.db, owner, it6.id);
    expect(scope).toMatchObject({ hasSnapshot: false, snapshotAt: null, committedDone: [], committedOpen: [], removed: [] });
    expect(scope.addedLater.map((i) => i.title)).toEqual(['开始后才加入']);
  });
});

describe('删除迭代', () => {
  it('只能删除规划中、没有需求、没有发布版本的迭代；删除后同一时间段可以重新建', async () => {
    const empty = await createIteration(t.db, owner, regular(pan, '空迭代', '2027-01-01', '2027-01-10'));
    const withReq = await createIteration(t.db, owner, regular(pan, '有需求的迭代', '2027-01-10', '2027-01-20'));
    const r = await createRequirement(t.db, owner, pan, { title: '占位需求' });
    await putInIteration(r.id, withReq.id);
    await expect(deleteIteration(t.db, pm, withReq.id)).rejects.toMatchObject({ code: 'invalid', message: '迭代中还有需求，请先移出' });
    await expect(deleteIteration(t.db, editor, empty.id)).rejects.toMatchObject({ code: 'forbidden' });

    await deleteIteration(t.db, pm, empty.id);
    expect((await listIterations(t.db, owner, { productId: pan })).some((i) => i.id === empty.id)).toBe(false);
    await expect(getIteration(t.db, owner, empty.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await eventsOf(empty.id)).map((e) => e.type)).toContain('iteration.deleted');
    await createIteration(t.db, owner, regular(pan, '重建的迭代', '2027-01-01', '2027-01-10'));

    const withRelease = await createIteration(t.db, owner, regular(pan, '有版本的迭代', '2027-02-01', '2027-02-10'));
    await withOrg(t.db, owner.orgId, (tx) => tx.insert(releases).values({ orgId: owner.orgId, productId: pan, versionName: '9.0.0', iterationId: withRelease.id }));
    await expect(deleteIteration(t.db, owner, withRelease.id)).rejects.toMatchObject({ code: 'invalid', message: '迭代下还有发布版本，请先改到其他迭代' });

    const finished = (await listIterations(t.db, owner, { productId: pan })).find((i) => i.name === '迭代0801')!;
    await expect(deleteIteration(t.db, owner, finished.id)).rejects.toMatchObject({ code: 'invalid', message: '只能删除规划中的迭代' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/iterations.test.ts`
Expected: FAIL，找不到模块 `../src/iterations/iterations`。

- [ ] **Step 3: 错误码与日期校验**

`packages/core/src/errors.ts` 的 `ErrorCode` 改为：

```ts
export type ErrorCode =
  | 'invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'already_initialized'
  | 'rate_limited';
```

`apps/web/src/server/http.ts` 的 `STATUS` 改为：

```ts
const STATUS = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  already_initialized: 409,
  rate_limited: 429,
} as const;
```

`packages/core/src/dates.ts`：

```ts
import { AppError } from './errors';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验 YYYY-MM-DD，且是真实存在的日期（2026-02-30 不通过）。 */
export function assertIsoDate(value: string, label: string): string {
  const d = new Date(`${value}T00:00:00Z`);
  if (!DATE_RE.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new AppError('invalid', `${label}格式应为 YYYY-MM-DD`);
  }
  return value;
}
```

`packages/core/src/access/permissions.ts` 末尾追加（`products`、`isNull`、`Tx`、`Actor` 已在文件中导入）：

```ts
/** 操作者能看到的产品：未删除，且按组织角色、产品角色与 Token 范围算出的角色不为空。 */
export async function visibleProductIds(tx: Tx, actor: Actor): Promise<Set<string>> {
  const rows = await tx.select({ id: products.id }).from(products).where(isNull(products.deletedAt));
  const out = new Set<string>();
  for (const p of rows) if (await productRoleOf(tx, actor, p.id)) out.add(p.id);
  return out;
}
```

- [ ] **Step 4: 实现 `iterations.ts`**

`packages/core/src/iterations/iterations.ts`：

```ts
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { atLeast, isOrgAdmin, productRoleOf, requireOrgAdmin, requireProductRole, visibleProductIds } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { blockers, type IterationMilestone, iterationScopeSnapshots, iterations, products, releases, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError, pgErrorCode } from '../errors';
import { recordEvent } from '../events';
import { memberNames, productWorkflowBody } from '../requirements/context';
import { displayKey, type MemberRef } from '../requirements/requirements';

export type IterationStatus = 'planning' | 'active' | 'done' | 'canceled';
export const ITERATION_STATUS_LABELS: Record<IterationStatus, string> = { planning: '规划中', active: '进行中', done: '已完成', canceled: '已取消' };
const NEXT_STATUS: Record<IterationStatus, IterationStatus[]> = { planning: ['active', 'canceled'], active: ['done', 'canceled'], done: [], canceled: [] };

export type StateInfo = { label: string; color: string; category: string };
export type IterationView = {
  id: string;
  type: 'regular' | 'special';
  product: { id: string; key: string; name: string } | null;
  name: string;
  startDate: string;
  endDate: string;
  baselineEndDate: string | null;
  status: IterationStatus;
  milestones: IterationMilestone[];
  requirementCount: number;
  doneCount: number;
  canManage: boolean;
};
export type IterationRequirement = {
  id: string;
  productId: string;
  displayKey: string;
  title: string;
  stateKey: string;
  state: StateInfo;
  owner: MemberRef | null;
  activeBlockers: number;
  canEdit: boolean;
};
export type IterationDetail = IterationView & { requirements: IterationRequirement[] };
export type IterationScopeItem = { id: string; displayKey: string; title: string; state: StateInfo; currentIteration: { id: string; name: string } | null };
export type IterationScope = {
  hasSnapshot: boolean;
  snapshotAt: Date | null;
  committedDone: IterationScopeItem[];
  committedOpen: IterationScopeItem[];
  addedLater: IterationScopeItem[];
  removed: IterationScopeItem[];
};

type IterRow = typeof iterations.$inferSelect;
type ReqRow = typeof requirements.$inferSelect;
type Change = { field: string; old: unknown; new: unknown };

function assertName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '迭代名称不能为空，且不超过 50 个字符');
  return n;
}

function assertMilestones(list: IterationMilestone[]): IterationMilestone[] {
  if (list.length > 20) throw new AppError('invalid', '里程碑不超过 20 个');
  return list
    .map((m) => {
      const label = m.label.trim();
      if (!label || label.length > 20) throw new AppError('invalid', '里程碑名称不能为空，且不超过 20 个字符');
      return { label, date: assertIsoDate(m.date, '里程碑日期') };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function overlapToConflict(e: unknown): never {
  if (pgErrorCode(e) === '23P01') throw new AppError('conflict', '与已有迭代时间重叠');
  throw e;
}

async function stateInfoByProduct(tx: Tx, productIds: Iterable<string>): Promise<Map<string, Map<string, StateInfo>>> {
  const out = new Map<string, Map<string, StateInfo>>();
  for (const pid of new Set(productIds)) {
    const body = await productWorkflowBody(tx, pid);
    out.set(pid, new Map(body.states.map((s) => [s.key, { label: s.label, color: s.color, category: s.category }])));
  }
  return out;
}

function stateOf(info: Map<string, Map<string, StateInfo>>, productId: string, key: string): StateInfo {
  return info.get(productId)?.get(key) ?? { label: key, color: '#8a9199', category: 'backlog' };
}

function isVisible(row: IterRow, visible: Set<string>): boolean {
  return row.type === 'special' ? visible.size > 0 : visible.has(row.productId!);
}

async function loadIteration(tx: Tx, id: string, lock = false): Promise<IterRow> {
  const where = and(eq(iterations.id, id), isNull(iterations.deletedAt));
  const [row] = lock ? await tx.select().from(iterations).where(where).for('update') : await tx.select().from(iterations).where(where);
  if (!row) throw new AppError('not_found', '迭代不存在');
  return row;
}

/** 读取并确认操作者能看到该迭代；看不到时与不存在一样返回 404。 */
async function loadVisibleIteration(tx: Tx, id: string, visible: Set<string>, lock = false): Promise<IterRow> {
  const row = await loadIteration(tx, id, lock);
  if (!isVisible(row, visible)) throw new AppError('not_found', '迭代不存在');
  return row;
}

async function requireManage(tx: Tx, actor: Actor, row: IterRow): Promise<void> {
  if (row.type === 'special') requireOrgAdmin(actor);
  else await requireProductRole(tx, actor, row.productId!, 'admin');
}

async function buildViews(tx: Tx, actor: Actor, rows: IterRow[], visible: Set<string>): Promise<IterationView[]> {
  if (rows.length === 0) return [];
  const reqs =
    visible.size > 0
      ? await tx
          .select({ iterationId: requirements.iterationId, productId: requirements.productId, stateKey: requirements.stateKey })
          .from(requirements)
          .where(and(inArray(requirements.iterationId, rows.map((r) => r.id)), isNull(requirements.deletedAt), inArray(requirements.productId, [...visible])))
      : [];
  const info = await stateInfoByProduct(tx, reqs.map((r) => r.productId));
  const productIds = [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))];
  const prods = productIds.length
    ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(inArray(products.id, productIds))
    : [];
  const manage = new Map<string, boolean>();
  const canManage = async (r: IterRow): Promise<boolean> => {
    if (r.type === 'special') return isOrgAdmin(actor);
    if (!manage.has(r.productId!)) manage.set(r.productId!, (await productRoleOf(tx, actor, r.productId!)) === 'admin');
    return manage.get(r.productId!)!;
  };
  const out: IterationView[] = [];
  for (const r of rows) {
    const mine = reqs.filter((x) => x.iterationId === r.id);
    out.push({
      id: r.id,
      type: r.type,
      product: r.productId ? (prods.find((p) => p.id === r.productId) ?? null) : null,
      name: r.name,
      startDate: r.startDate,
      endDate: r.endDate,
      baselineEndDate: r.baselineEndDate,
      status: r.status,
      milestones: r.milestones,
      requirementCount: mine.length,
      doneCount: mine.filter((x) => stateOf(info, x.productId, x.stateKey).category === 'completed').length,
      canManage: await canManage(r),
    });
  }
  return out;
}

async function productKeys(tx: Tx, productIds: string[]): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const rows = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, productIds));
  return new Map(rows.map((p) => [p.id, p.key]));
}

async function iterationRequirements(tx: Tx, actor: Actor, rows: ReqRow[]): Promise<IterationRequirement[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const keys = await productKeys(tx, productIds);
  const info = await stateInfoByProduct(tx, productIds);
  const names = await memberNames(tx, rows.map((r) => r.ownerMemberId));
  const counts = await tx
    .select({ requirementId: blockers.requirementId, n: sql<number>`count(*)::int` })
    .from(blockers)
    .where(and(inArray(blockers.requirementId, ids), eq(blockers.status, 'active')))
    .groupBy(blockers.requirementId);
  const roles = new Map<string, ProductRole | null>();
  for (const pid of productIds) roles.set(pid, await productRoleOf(tx, actor, pid));
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    displayKey: displayKey(keys.get(r.productId)!, r.number),
    title: r.title,
    stateKey: r.stateKey,
    state: stateOf(info, r.productId, r.stateKey),
    owner: r.ownerMemberId ? { id: r.ownerMemberId, displayName: names.get(r.ownerMemberId) ?? '已删除的成员' } : null,
    activeBlockers: counts.find((c) => c.requirementId === r.id)?.n ?? 0,
    canEdit: atLeast(roles.get(r.productId) ?? null, 'editor'),
  }));
}

export async function listIterations(db: Db, actor: Actor, input: { productId?: string } = {}): Promise<IterationView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    if (input.productId && !visible.has(input.productId)) throw new AppError('not_found', '产品不存在');
    if (visible.size === 0) return [];
    const scope = input.productId
      ? or(eq(iterations.productId, input.productId), eq(iterations.type, 'special'))
      : or(inArray(iterations.productId, [...visible]), eq(iterations.type, 'special'));
    const rows = await tx
      .select()
      .from(iterations)
      .where(and(isNull(iterations.deletedAt), scope))
      .orderBy(desc(iterations.startDate), asc(iterations.name));
    return buildViews(tx, actor, rows, visible);
  });
}

export async function getIteration(db: Db, actor: Actor, id: string): Promise<IterationDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const row = await loadVisibleIteration(tx, id, visible);
    const [view] = await buildViews(tx, actor, [row], visible);
    const reqRows = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.iterationId, id), isNull(requirements.deletedAt), inArray(requirements.productId, [...visible])))
      .orderBy(asc(requirements.productId), asc(requirements.number));
    return { ...view!, requirements: await iterationRequirements(tx, actor, reqRows) };
  });
}

export async function createIteration(
  db: Db,
  actor: Actor,
  input: { type: 'regular' | 'special'; productId?: string | null; name: string; startDate: string; endDate: string; milestones?: IterationMilestone[] },
): Promise<IterationView> {
  const name = assertName(input.name);
  const startDate = assertIsoDate(input.startDate, '开始日期');
  const endDate = assertIsoDate(input.endDate, '结束日期');
  if (startDate > endDate) throw new AppError('invalid', '结束日期不能早于开始日期');
  const milestones = assertMilestones(input.milestones ?? []);
  if (input.type === 'regular' && !input.productId) throw new AppError('invalid', '常规迭代必须属于一个产品');
  if (input.type === 'special' && input.productId) throw new AppError('invalid', '专项属于组织，不能指定产品');
  return withOrg(db, actor.orgId, async (tx) => {
    if (input.type === 'special') requireOrgAdmin(actor);
    else await requireProductRole(tx, actor, input.productId!, 'admin');
    let row: IterRow;
    try {
      [row] = (await tx
        .insert(iterations)
        .values({ orgId: actor.orgId, productId: input.type === 'regular' ? input.productId! : null, type: input.type, name, startDate, endDate, milestones })
        .returning()) as [IterRow];
    } catch (e) {
      overlapToConflict(e);
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: row.productId,
      type: 'iteration.created',
      subjectType: 'iteration',
      subjectId: row.id,
      actor,
      payload: { name, type: row.type, startDate, endDate },
    });
    const [view] = await buildViews(tx, actor, [row], await visibleProductIds(tx, actor));
    return view!;
  });
}

export async function updateIteration(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: string; startDate?: string; endDate?: string; milestones?: IterationMilestone[] },
): Promise<IterationView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const cur = await loadVisibleIteration(tx, id, visible, true);
    await requireManage(tx, actor, cur);
    if (cur.status === 'done' || cur.status === 'canceled') throw new AppError('invalid', '已完成或已取消的迭代不能修改');
    const next = {
      name: input.name === undefined ? cur.name : assertName(input.name),
      startDate: input.startDate === undefined ? cur.startDate : assertIsoDate(input.startDate, '开始日期'),
      endDate: input.endDate === undefined ? cur.endDate : assertIsoDate(input.endDate, '结束日期'),
      milestones: input.milestones === undefined ? cur.milestones : assertMilestones(input.milestones),
    };
    if (next.startDate > next.endDate) throw new AppError('invalid', '结束日期不能早于开始日期');
    const changes: Change[] = (['name', 'startDate', 'endDate'] as const)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    if (JSON.stringify(cur.milestones) !== JSON.stringify(next.milestones)) changes.push({ field: 'milestones', old: cur.milestones, new: next.milestones });
    let row: IterRow;
    try {
      [row] = (await tx.update(iterations).set(next).where(eq(iterations.id, id)).returning()) as [IterRow];
    } catch (e) {
      overlapToConflict(e);
    }
    if (changes.length > 0) {
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'iteration.updated', subjectType: 'iteration', subjectId: id, actor, payload: { changes } });
    }
    const [view] = await buildViews(tx, actor, [row], visible);
    return view!;
  });
}

export async function setIterationStatus(db: Db, actor: Actor, id: string, to: IterationStatus): Promise<IterationView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const cur = await loadVisibleIteration(tx, id, visible, true);
    await requireManage(tx, actor, cur);
    if (!NEXT_STATUS[cur.status].includes(to)) {
      throw new AppError('invalid', `不能从「${ITERATION_STATUS_LABELS[cur.status]}」变为「${ITERATION_STATUS_LABELS[to] ?? to}」`);
    }
    const now = new Date();
    let snapshotCount = 0;
    const set: Partial<typeof iterations.$inferInsert> = { status: to };
    if (to === 'active') {
      set.baselineEndDate = cur.endDate;
      const [existing] = await tx
        .select({ id: iterationScopeSnapshots.id })
        .from(iterationScopeSnapshots)
        .where(and(eq(iterationScopeSnapshots.iterationId, id), eq(iterationScopeSnapshots.snapshotKind, 'committed')))
        .limit(1);
      if (!existing) {
        const inScope = await tx.select({ id: requirements.id }).from(requirements).where(and(eq(requirements.iterationId, id), isNull(requirements.deletedAt)));
        if (inScope.length > 0) {
          await tx
            .insert(iterationScopeSnapshots)
            .values(inScope.map((r) => ({ orgId: actor.orgId, iterationId: id, requirementId: r.id, snapshotKind: 'committed' as const, at: now })));
        }
        snapshotCount = inScope.length;
      }
    }
    const [row] = await tx.update(iterations).set(set).where(eq(iterations.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'iteration.status_changed',
      subjectType: 'iteration',
      subjectId: id,
      actor,
      payload: { changes: [{ field: 'status', old: cur.status, new: to }], snapshotCount },
    });
    const [view] = await buildViews(tx, actor, [row!], visible);
    return view!;
  });
}

export async function deleteIteration(db: Db, actor: Actor, id: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const cur = await loadVisibleIteration(tx, id, visible, true);
    await requireManage(tx, actor, cur);
    if (cur.status !== 'planning') throw new AppError('invalid', '只能删除规划中的迭代');
    const [reqCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(requirements)
      .where(and(eq(requirements.iterationId, id), isNull(requirements.deletedAt)));
    if (reqCount!.n > 0) throw new AppError('invalid', '迭代中还有需求，请先移出');
    const [relCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(releases).where(eq(releases.iterationId, id));
    if (relCount!.n > 0) throw new AppError('invalid', '迭代下还有发布版本，请先改到其他迭代');
    await tx.update(iterations).set({ deletedAt: new Date() }).where(eq(iterations.id, id));
    await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'iteration.deleted', subjectType: 'iteration', subjectId: id, actor, payload: { name: cur.name } });
  });
}

export async function getIterationScope(db: Db, actor: Actor, id: string): Promise<IterationScope> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const row = await loadVisibleIteration(tx, id, visible);
    if (row.status === 'planning') throw new AppError('invalid', '迭代开始后才有范围对比');
    const snaps = await tx
      .select({ requirementId: iterationScopeSnapshots.requirementId, at: iterationScopeSnapshots.at })
      .from(iterationScopeSnapshots)
      .where(and(eq(iterationScopeSnapshots.iterationId, id), eq(iterationScopeSnapshots.snapshotKind, 'committed')));
    const committed = new Set(snaps.map((s) => s.requirementId));
    const current = await tx.select().from(requirements).where(and(eq(requirements.iterationId, id), isNull(requirements.deletedAt)));
    const currentIds = new Set(current.map((r) => r.id));
    const removedIds = [...committed].filter((x) => !currentIds.has(x));
    const removedRows = removedIds.length
      ? await tx.select().from(requirements).where(and(inArray(requirements.id, removedIds), isNull(requirements.deletedAt)))
      : [];
    const shownCurrent = current.filter((r) => visible.has(r.productId));
    const shownRemoved = removedRows.filter((r) => visible.has(r.productId));
    const productIds = [...new Set([...shownCurrent, ...shownRemoved].map((r) => r.productId))];
    const keys = await productKeys(tx, productIds);
    const info = await stateInfoByProduct(tx, productIds);
    const otherIds = [...new Set(shownRemoved.map((r) => r.iterationId).filter((x): x is string => !!x))];
    const others = otherIds.length ? await tx.select({ id: iterations.id, name: iterations.name }).from(iterations).where(inArray(iterations.id, otherIds)) : [];
    const item = (r: ReqRow): IterationScopeItem => ({
      id: r.id,
      displayKey: displayKey(keys.get(r.productId)!, r.number),
      title: r.title,
      state: stateOf(info, r.productId, r.stateKey),
      currentIteration: r.iterationId === null ? null : r.iterationId === id ? { id, name: row.name } : (others.find((o) => o.id === r.iterationId) ?? null),
    });
    const byKey = (a: IterationScopeItem, b: IterationScopeItem) => a.displayKey.localeCompare(b.displayKey, 'zh-CN', { numeric: true });
    const inCommitment = shownCurrent.filter((r) => committed.has(r.id));
    const isDone = (r: ReqRow) => stateOf(info, r.productId, r.stateKey).category === 'completed';
    return {
      hasSnapshot: snaps.length > 0,
      snapshotAt: snaps.length > 0 ? snaps.reduce((min, s) => (s.at < min ? s.at : min), snaps[0]!.at) : null,
      committedDone: inCommitment.filter(isDone).map(item).sort(byKey),
      committedOpen: inCommitment.filter((r) => !isDone(r)).map(item).sort(byKey),
      addedLater: shownCurrent.filter((r) => !committed.has(r.id)).map(item).sort(byKey),
      removed: shownRemoved.map(item).sort(byKey),
    };
  });
}
```

`packages/core/src/index.ts` 在 `export * from './errors';` 之后加 `export * from './dates';`，并在文件末尾追加：

```ts
export * from './iterations/iterations';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/iterations.test.ts`
Expected: PASS。再跑 `pnpm --filter @flower/core test` 与 `pnpm typecheck`，全部通过。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/errors.ts packages/core/src/dates.ts packages/core/src/access/permissions.ts packages/core/src/iterations packages/core/src/index.ts packages/core/test/iterations.test.ts apps/web/src/server/http.ts
git commit -m "feat(core): 迭代服务：新建、修改、状态流转与承诺快照、删除、范围对比"
```

---
### Task 2: 加入 / 移出迭代：准入条件、强制加入，需求详情给出准入原因

**Files:**
- Create: `packages/core/src/iterations/membership.ts`
- Modify: `packages/core/src/requirements/detail.ts`（`RequirementDetail` 增加 `joinIterationUnmet`）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/iteration-membership.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createIteration`、`setIterationStatus`、`getIteration`、`getIterationScope`；`loadRequirementForUpdate`、`effectiveFields`、`productWorkflowBody`（`requirements/context.ts`）；`checkStatesFor`、`unmetConditions`、`UnmetCondition`（`requirements/workflow-runtime.ts`）
- Produces（`membership.ts`）：
  - `joinIterationUnmet(tx: Tx, body: WorkflowBody, req: typeof requirements.$inferSelect): Promise<UnmetCondition[]>`（流程未配置 `join_iteration` 时返回空数组）
  - `setRequirementIteration(db, actor, requirementId: string, input: { iterationId: string | null; force?: boolean; reason?: string }): Promise<{ iteration: { id: string; name: string } | null }>`
- Produces（`detail.ts`）：`RequirementDetail.joinIterationUnmet: UnmetCondition[]`
- 事件：`requirement.iteration_changed`（`changes: [{ field: 'iterationId', old, new }]`、`iterationName`、`forced`、`reason`）
- 错误：条件不满足 `AppError('precondition_failed', '加入迭代的条件未满足', { unmet: string[] })`；非产品管理员强制 `forbidden`；强制缺原因 `invalid`；目标迭代已完成 / 已取消 `invalid`「只能加入规划中或进行中的迭代」；其他产品的常规迭代 `invalid`「不能加入其他产品的迭代」

- [ ] **Step 1: 写失败的测试**

`packages/core/test/iteration-membership.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { createIteration, getIteration, getIterationScope, type IterationView, setIterationStatus } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { setCheckItemState } from '../src/requirements/transitions';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pm: Actor;
let editor: Actor;
let viewer: Actor;
let readToken: Actor;
let pan: string;
let doc: string;
let planning: IterationView;
let active: IterationView;
let finished: IterationView;
let docIteration: IterationView;
let special: IterationView;
let base: RequirementListItem;
let r: RequirementListItem;

const UNMET = '「可行性」需为通过（当前：未开始）';
async function asMember(name: string): Promise<Actor> {
  const m = await createPlaceholderMember(t.db, owner, { displayName: name });
  return { ...owner, memberId: m.id, orgRole: 'member', accountId: null };
}
const iterationEvents = (requirementId: string) =>
  withOrg(t.db, owner.orgId, (tx) =>
    tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, requirementId), eq(domainEvents.type, 'requirement.iteration_changed'))),
  );

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  pm = await asMember('产品经理甲');
  await setProductRole(t.db, owner, pan, pm.memberId, 'admin');
  editor = await asMember('开发乙');
  viewer = await asMember('只读丙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
  const { version } = await createWorkflowTemplate(t.db, owner, {
    name: '准入流程',
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
      actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] }],
      checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
    },
  });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  const regular = (productId: string, name: string, startDate: string, endDate: string) => ({ type: 'regular' as const, productId, name, startDate, endDate });
  planning = await createIteration(t.db, owner, regular(pan, '迭代0701', '2026-07-01', '2026-07-14'));
  active = await createIteration(t.db, owner, regular(pan, '迭代0715', '2026-07-15', '2026-07-28'));
  finished = await createIteration(t.db, owner, regular(pan, '迭代0601', '2026-06-01', '2026-06-14'));
  docIteration = await createIteration(t.db, owner, regular(doc, '文档迭代', '2026-07-01', '2026-07-14'));
  special = await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-07-01', endDate: '2026-09-30' });
  base = await createRequirement(t.db, owner, pan, { title: '开始前已承诺的需求' });
  await setRequirementIteration(t.db, owner, base.id, { iterationId: active.id, force: true, reason: '测试准备' });
  await setIterationStatus(t.db, owner, active.id, 'active');
  await setIterationStatus(t.db, owner, finished.id, 'active');
  await setIterationStatus(t.db, owner, finished.id, 'done');
  r = await createRequirement(t.db, owner, pan, { title: '分享链接有效期' });
});
afterAll(() => t.cleanup());

describe('加入迭代的准入条件', () => {
  it('条件不满足时拒绝加入并给出原因；需求详情给出同样的原因', async () => {
    await expect(setRequirementIteration(t.db, editor, r.id, { iterationId: planning.id })).rejects.toMatchObject({
      code: 'precondition_failed',
      message: '加入迭代的条件未满足',
      details: { unmet: [UNMET] },
    });
    const d = await getRequirementByKey(t.db, editor, r.displayKey);
    expect(d.joinIterationUnmet.map((u) => u.message)).toEqual([UNMET]);
    expect(d.iteration).toBeNull();
  });

  it('条件满足后可以加入，并记录事件；再次加入同一迭代没有变化', async () => {
    await setCheckItemState(t.db, editor, r.id, 'feasibility', { state: 'passed' });
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).joinIterationUnmet).toEqual([]);
    expect(await setRequirementIteration(t.db, editor, r.id, { iterationId: planning.id })).toEqual({ iteration: { id: planning.id, name: '迭代0701' } });
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).iteration).toEqual({ id: planning.id, name: '迭代0701' });
    expect(await setRequirementIteration(t.db, editor, r.id, { iterationId: planning.id })).toEqual({ iteration: { id: planning.id, name: '迭代0701' } });
    const events = await iterationEvents(r.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ changes: [{ field: 'iterationId', old: null, new: planning.id }], iterationName: '迭代0701', forced: false, reason: null });
  });

  it('只读成员和只读 Token 不能加入或移出', async () => {
    await expect(setRequirementIteration(t.db, viewer, r.id, { iterationId: null })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setRequirementIteration(t.db, readToken, r.id, { iterationId: null })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setRequirementIteration(t.db, readToken, r.id, { iterationId: active.id })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('强制加入只允许产品管理员，必须填写原因，原因记入事件', async () => {
    const s = await createRequirement(t.db, owner, pan, { title: '未评估的紧急需求' });
    await expect(setRequirementIteration(t.db, editor, s.id, { iterationId: active.id, force: true, reason: '线上问题' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setRequirementIteration(t.db, pm, s.id, { iterationId: active.id, force: true, reason: '   ' })).rejects.toMatchObject({ code: 'invalid' });
    await setRequirementIteration(t.db, pm, s.id, { iterationId: active.id, force: true, reason: '线上问题必须本迭代修复' });
    const [ev] = await iterationEvents(s.id);
    expect(ev!.payload).toMatchObject({ forced: true, reason: '线上问题必须本迭代修复' });
    const scope = await getIterationScope(t.db, owner, active.id);
    expect(scope.committedOpen.map((x) => x.title)).toEqual(['开始前已承诺的需求']);
    expect(scope.addedLater.map((x) => x.title)).toEqual(['未评估的紧急需求']);
  });
});

describe('加入迭代的目标限制', () => {
  it('已完成的迭代不能加入；其他产品的常规迭代不能加入；专项可以接收不同产品的需求', async () => {
    await expect(setRequirementIteration(t.db, owner, r.id, { iterationId: finished.id })).rejects.toMatchObject({
      code: 'invalid',
      message: '只能加入规划中或进行中的迭代',
    });
    await expect(setRequirementIteration(t.db, owner, r.id, { iterationId: docIteration.id })).rejects.toMatchObject({
      code: 'invalid',
      message: '不能加入其他产品的迭代',
    });
    await expect(setRequirementIteration(t.db, owner, r.id, { iterationId: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await setRequirementIteration(t.db, owner, r.id, { iterationId: special.id })).iteration?.id).toBe(special.id);
    const docReq = await createRequirement(t.db, owner, doc, { title: '文档协作' });
    await setRequirementIteration(t.db, owner, docReq.id, { iterationId: special.id });
    expect((await getIteration(t.db, owner, special.id)).requirements.map((x) => x.title).sort()).toEqual(['分享链接有效期', '文档协作'].sort());
    expect((await iterationEvents(r.id)).at(-1)!.payload).toMatchObject({ changes: [{ field: 'iterationId', old: planning.id, new: special.id }] });
  });

  it('移出迭代总是允许，重复移出没有变化', async () => {
    const before = (await iterationEvents(r.id)).length;
    expect(await setRequirementIteration(t.db, editor, r.id, { iterationId: null })).toEqual({ iteration: null });
    expect(await setRequirementIteration(t.db, editor, r.id, { iterationId: null })).toEqual({ iteration: null });
    const events = await iterationEvents(r.id);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)!.payload).toMatchObject({ changes: [{ field: 'iterationId', old: special.id, new: null }], forced: false });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/iteration-membership.test.ts`
Expected: FAIL，找不到模块 `../src/iterations/membership`。

- [ ] **Step 3: 实现 `membership.ts`**

`packages/core/src/iterations/membership.ts`：

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, fieldDefinitions, fieldValues, iterations, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { effectiveFields, loadRequirementForUpdate, productWorkflowBody } from '../requirements/context';
import { checkStatesFor, type UnmetCondition, unmetConditions } from '../requirements/workflow-runtime';

type ReqRow = typeof requirements.$inferSelect;

/** 流程 actionGates 中 join_iteration 未满足的条件；流程没有配置时返回空数组。 */
export async function joinIterationUnmet(tx: Tx, body: WorkflowBody, req: ReqRow): Promise<UnmetCondition[]> {
  const gate = body.actionGates.find((g) => g.action === 'join_iteration');
  if (!gate || gate.conditions.length === 0) return [];
  const results = await tx
    .select({ itemKey: checkItemResults.itemKey, state: checkItemResults.state })
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, req.id)));
  const fields = await effectiveFields(tx, req.productId);
  const filled = await tx
    .selectDistinct({ key: fieldDefinitions.key })
    .from(fieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .where(eq(fieldValues.entityId, req.id));
  return unmetConditions(
    gate.conditions,
    {
      checks: checkStatesFor(body, results),
      filledFields: new Set(filled.map((f) => f.key)),
      hasIteration: req.iterationId !== null,
      hasChangeDocument: req.changeDocumentId !== null,
    },
    { checkItem: (k) => body.checkItems.find((c) => c.key === k)?.label ?? k, field: (k) => fields.get(k)?.label ?? k },
  );
}

export async function setRequirementIteration(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { iterationId: string | null; force?: boolean; reason?: string },
): Promise<{ iteration: { id: string; name: string } | null }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    const role = await requireProductRole(tx, actor, cur.productId, 'editor');
    const record = async (next: { id: string; name: string } | null, forced: boolean, reason: string | null) => {
      await tx.update(requirements).set({ iterationId: next?.id ?? null, updatedAt: new Date() }).where(eq(requirements.id, requirementId));
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: cur.productId,
        type: 'requirement.iteration_changed',
        subjectType: 'requirement',
        subjectId: requirementId,
        actor,
        payload: { changes: [{ field: 'iterationId', old: cur.iterationId, new: next?.id ?? null }], iterationName: next?.name ?? null, forced, reason },
      });
    };

    if (input.iterationId === null) {
      if (cur.iterationId !== null) await record(null, false, null);
      return { iteration: null };
    }

    // 与开始迭代（FOR UPDATE）互斥，保证承诺快照与加入操作的先后一致
    const [it] = await tx
      .select()
      .from(iterations)
      .where(and(eq(iterations.id, input.iterationId), isNull(iterations.deletedAt)))
      .for('share');
    if (!it) throw new AppError('not_found', '迭代不存在');
    if (it.type === 'regular' && it.productId !== cur.productId) throw new AppError('invalid', '不能加入其他产品的迭代');
    if (it.status !== 'planning' && it.status !== 'active') throw new AppError('invalid', '只能加入规划中或进行中的迭代');
    const target = { id: it.id, name: it.name };
    if (cur.iterationId === it.id) return { iteration: target };

    const reason = input.reason?.trim() || null;
    if (input.force) {
      if (role !== 'admin') throw new AppError('forbidden', '只有产品管理员可以强制加入迭代');
      if (!reason || reason.length > 500) throw new AppError('invalid', '强制加入迭代必须填写原因（不超过 500 个字符）');
    } else {
      const unmet = await joinIterationUnmet(tx, await productWorkflowBody(tx, cur.productId), cur);
      if (unmet.length > 0) throw new AppError('precondition_failed', '加入迭代的条件未满足', { unmet: unmet.map((u) => u.message) });
    }
    await record(target, !!input.force, input.force ? reason : null);
    return { iteration: target };
  });
}
```

- [ ] **Step 4: 需求详情给出准入原因**

`packages/core/src/requirements/detail.ts`：

1. import 改为从 `./workflow-runtime` 同时导入 `unmetConditions` 与类型 `UnmetCondition`：

```ts
import {
  availableTransitions,
  checkStatesFor,
  matchingSignerRules,
  type TransitionOption,
  type UnmetCondition,
  unmetConditions,
} from './workflow-runtime';
```

2. `RequirementDetail` 类型在 `transitions: TransitionOption[];` 之后加一行：

```ts
  joinIterationUnmet: UnmetCondition[];
```

3. 返回值中 `transitions: availableTransitions(body, row.stateKey, ctx, lookup),` 之后加一行：

```ts
      joinIterationUnmet: unmetConditions(body.actionGates.find((g) => g.action === 'join_iteration')?.conditions ?? [], ctx, lookup),
```

`packages/core/src/index.ts` 末尾追加：

```ts
export * from './iterations/membership';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/iteration-membership.test.ts`
Expected: PASS。再跑 `pnpm --filter @flower/core test` 与 `pnpm typecheck`，全部通过（`requirement-workflow.test.ts` 中对详情的断言用 `toMatchObject`，新增字段不影响）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/iterations/membership.ts packages/core/src/requirements/detail.ts packages/core/src/index.ts packages/core/test/iteration-membership.test.ts
git commit -m "feat(core): 需求加入与移出迭代：按流程准入条件判断，产品管理员可强制"
```

---
### Task 3: 发布版本服务；字段覆盖时改写平台选项引用

**Files:**
- Create: `packages/core/src/releases/releases.ts`
- Modify: `packages/core/src/definitions/fields.ts`（`forkFieldForProduct`）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/releases.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `assertIsoDate`、`visibleProductIds`、`createIteration`；`effectiveFields`、`loadRequirement`（`requirements/context.ts`）；`OptionRef`（`requirements/requirements.ts`）
- Produces（`releases.ts`）：
  - `type ReleaseView = { id: string; productId: string; productKey: string; versionName: string; platform: OptionRef | null; iteration: { id: string; name: string } | null; status: 'planned' | 'released'; plannedDate: string | null; baselineDate: string | null; releasedAt: Date | null; notes: string | null; requirementCount: number; canEdit: boolean }`
  - `listReleases(db, actor, input: { productId?: string; iterationId?: string }): Promise<ReleaseView[]>`（至少给一个条件；计划日期倒序，空值在后）
  - `createRelease(db, actor, input: { productId: string; versionName: string; platformOptionId?: string | null; iterationId?: string | null; plannedDate: string; notes?: string | null }): Promise<ReleaseView>`
  - `updateRelease(db, actor, id: string, input: { versionName?: string; platformOptionId?: string | null; iterationId?: string | null; plannedDate?: string | null; notes?: string | null }): Promise<ReleaseView>`
  - `markReleaseReleased(db, actor, id: string): Promise<ReleaseView>`
  - `linkRequirementRelease(db, actor, releaseId: string, requirementId: string): Promise<void>`
  - `unlinkRequirementRelease(db, actor, releaseId: string, requirementId: string): Promise<void>`
- Produces（`fields.ts`）：`forkFieldForProduct` 事件 payload 的 `movedValues` = 迁移的字段值 + 发布版本 + 开发分配行数
- 事件：`release.created`（`versionName`、`plannedDate`）、`release.updated`（`changes`）、`release.released`（`changes`）、`requirement.release_linked` / `requirement.release_unlinked`（subject 为需求，payload `releaseId`、`versionName`）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/releases.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, requirementAssignments } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addFieldOption, forkFieldForProduct, listFields } from '../src/definitions/fields';
import type { Actor } from '../src/domain-types';
import { createIteration } from '../src/iterations/iterations';
import {
  createRelease,
  linkRequirementRelease,
  listReleases,
  markReleaseReleased,
  unlinkRequirementRelease,
  updateRelease,
} from '../src/releases/releases';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let readToken: Actor;
let pan: string;
let doc: string;
let platformFieldId: string;
let pc: string;
let priorityP0: string;
let panIteration: string;
let docIteration: string;
let special: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  const e = await createPlaceholderMember(t.db, owner, { displayName: '开发乙' });
  editor = { ...owner, memberId: e.id, orgRole: 'member', accountId: null };
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读丙' });
  await setProductRole(t.db, owner, pan, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
  const fields = await listFields(t.db, owner);
  platformFieldId = fields.find((f) => f.key === 'platform')!.id;
  pc = (await addFieldOption(t.db, owner, platformFieldId, { label: 'PC客户端', key: 'pc' })).id;
  priorityP0 = fields.find((f) => f.key === 'priority')!.options.find((o) => o.key === 'p0')!.id;
  panIteration = (await createIteration(t.db, owner, { type: 'regular', productId: pan, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' })).id;
  docIteration = (await createIteration(t.db, owner, { type: 'regular', productId: doc, name: '文档迭代', startDate: '2026-08-01', endDate: '2026-08-14' })).id;
  special = (await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-08-01', endDate: '2026-09-30' })).id;
});
afterAll(() => t.cleanup());

describe('发布版本', () => {
  let releaseId: string;

  it('编辑可以新建：基线日期等于计划日期；平台与迭代正确回显', async () => {
    const rel = await createRelease(t.db, editor, { productId: pan, versionName: ' 3.2.0 ', platformOptionId: pc, iterationId: panIteration, plannedDate: '2026-08-14', notes: '分享与回收站' });
    releaseId = rel.id;
    expect(rel).toMatchObject({
      productKey: 'PAN',
      versionName: '3.2.0',
      platform: { id: pc, label: 'PC客户端' },
      iteration: { id: panIteration, name: '迭代0801' },
      status: 'planned',
      plannedDate: '2026-08-14',
      baselineDate: '2026-08-14',
      releasedAt: null,
      requirementCount: 0,
      canEdit: true,
    });
  });

  it('只读成员与只读 Token 不能新建或修改', async () => {
    const input = { productId: pan, versionName: '越权', plannedDate: '2026-08-20' };
    await expect(createRelease(t.db, viewer, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createRelease(t.db, readToken, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateRelease(t.db, viewer, releaseId, { versionName: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(markReleaseReleased(t.db, readToken, releaseId)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('平台选项必须属于本产品的「平台」字段；迭代必须同产品或为专项；计划日期必填且合法', async () => {
    await expect(createRelease(t.db, owner, { productId: pan, versionName: 'x', platformOptionId: priorityP0, plannedDate: '2026-08-20' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(createRelease(t.db, owner, { productId: pan, versionName: 'x', iterationId: docIteration, plannedDate: '2026-08-20' })).rejects.toMatchObject({
      code: 'invalid',
      message: '不能关联其他产品的迭代',
    });
    await expect(createRelease(t.db, owner, { productId: pan, versionName: 'x', plannedDate: '2026-13-01' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createRelease(t.db, owner, { productId: pan, versionName: '  ', plannedDate: '2026-08-20' })).rejects.toMatchObject({ code: 'invalid' });
    const sp = await createRelease(t.db, owner, { productId: doc, versionName: 'D-1.0', iterationId: special, plannedDate: '2026-09-01' });
    expect(sp.iteration).toEqual({ id: special, name: '专业空间优化' });
  });

  it('修改计划日期不改变基线；记录变更', async () => {
    const rel = await updateRelease(t.db, editor, releaseId, { plannedDate: '2026-08-20', notes: null });
    expect(rel).toMatchObject({ plannedDate: '2026-08-20', baselineDate: '2026-08-14', notes: null });
    const [ev] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, releaseId), eq(domainEvents.type, 'release.updated'))),
    );
    expect(ev!.payload).toMatchObject({ changes: [{ field: 'plannedDate', old: '2026-08-14', new: '2026-08-20' }, { field: 'notes', old: '分享与回收站', new: null }] });
  });

  it('按产品或按迭代列出；关联需求后计数变化；只能关联同产品需求；重复关联与解除不报错', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '分享链接加密码' });
    const docReq = await createRequirement(t.db, owner, doc, { title: '文档导出' });
    await linkRequirementRelease(t.db, editor, releaseId, req.id);
    await linkRequirementRelease(t.db, editor, releaseId, req.id);
    await expect(linkRequirementRelease(t.db, owner, releaseId, docReq.id)).rejects.toMatchObject({ code: 'invalid', message: '只能关联本产品的需求' });
    await expect(linkRequirementRelease(t.db, viewer, releaseId, req.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await listReleases(t.db, viewer, { productId: pan })).map((r) => [r.versionName, r.requirementCount, r.canEdit])).toEqual([['3.2.0', 1, false]]);
    expect((await listReleases(t.db, owner, { iterationId: special })).map((r) => r.versionName)).toEqual(['D-1.0']);
    expect((await getRequirementByKey(t.db, owner, req.displayKey)).releases.map((r) => r.versionName)).toEqual(['3.2.0']);
    const linked = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, req.id), eq(domainEvents.type, 'requirement.release_linked'))),
    );
    expect(linked).toHaveLength(1);
    await unlinkRequirementRelease(t.db, editor, releaseId, req.id);
    await unlinkRequirementRelease(t.db, editor, releaseId, req.id);
    expect((await getRequirementByKey(t.db, owner, req.displayKey)).releases).toEqual([]);
    await expect(listReleases(t.db, owner, {})).rejects.toMatchObject({ code: 'invalid' });
  });

  it('标记发布写入发布时间；已发布的不能再标记', async () => {
    const rel = await markReleaseReleased(t.db, editor, releaseId);
    expect(rel.status).toBe('released');
    expect(rel.releasedAt).toBeInstanceOf(Date);
    await expect(markReleaseReleased(t.db, editor, releaseId)).rejects.toMatchObject({ code: 'invalid', message: '该版本已发布' });
  });
});

describe('平台字段按产品覆盖', () => {
  it('本产品发布版本与开发分配上的平台选项改指向产品级选项，计入 movedValues；其他产品不受影响', async () => {
    const pid = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
    const req = await createRequirement(t.db, owner, pid, { title: '相册备份', fields: { platform: [pc] } });
    await createRelease(t.db, owner, { productId: pid, versionName: '2.0.0', platformOptionId: pc, plannedDate: '2026-10-01' });
    await withOrg(t.db, owner.orgId, (tx) =>
      tx.insert(requirementAssignments).values({ orgId: owner.orgId, requirementId: req.id, memberId: owner.memberId, platformOptionId: pc }),
    );
    const forked = await forkFieldForProduct(t.db, owner, pid, platformFieldId);
    const newPc = forked.options.find((o) => o.key === 'pc')!.id;

    const [picRelease] = await listReleases(t.db, owner, { productId: pid });
    expect(picRelease!.platform).toMatchObject({ id: newPc, label: 'PC客户端' });
    const assignments = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select({ platformOptionId: requirementAssignments.platformOptionId }).from(requirementAssignments).where(eq(requirementAssignments.requirementId, req.id)),
    );
    expect(assignments).toEqual([{ platformOptionId: newPc }]);
    const [panRelease] = await listReleases(t.db, owner, { productId: pan });
    expect(panRelease!.platform!.id).toBe(pc);
    const [ev] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, forked.id), eq(domainEvents.type, 'field.forked'))),
    );
    expect(ev!.payload).toMatchObject({ movedValues: 3 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/releases.test.ts`
Expected: FAIL，找不到模块 `../src/releases/releases`。

- [ ] **Step 3: 实现 `releases.ts`**

`packages/core/src/releases/releases.ts`：

```ts
import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole, visibleProductIds } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { fieldOptions, iterations, products, releases, requirementReleases, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { effectiveFields, loadRequirement } from '../requirements/context';
import type { OptionRef } from '../requirements/requirements';

export type ReleaseView = {
  id: string;
  productId: string;
  productKey: string;
  versionName: string;
  platform: OptionRef | null;
  iteration: { id: string; name: string } | null;
  status: 'planned' | 'released';
  plannedDate: string | null;
  baselineDate: string | null;
  releasedAt: Date | null;
  notes: string | null;
  requirementCount: number;
  canEdit: boolean;
};

type ReleaseRow = typeof releases.$inferSelect;

function assertVersionName(v: string): string {
  const n = v.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '版本号不能为空，且不超过 50 个字符');
  return n;
}

function assertNotes(v: string | null | undefined): string | null {
  const n = v?.trim() || null;
  if (n && n.length > 2000) throw new AppError('invalid', '说明不超过 2000 个字符');
  return n;
}

async function assertPlatformOption(tx: Tx, productId: string, optionId: string, previous: string | null): Promise<void> {
  const platform = (await effectiveFields(tx, productId)).get('platform');
  const opt = platform?.options.find((o) => o.id === optionId);
  if (!opt) throw new AppError('invalid', '平台选项不属于本产品的「平台」字段');
  if (!opt.active && optionId !== previous) throw new AppError('invalid', `选项「${opt.label}」已停用`);
}

async function assertReleaseIteration(tx: Tx, productId: string, iterationId: string): Promise<void> {
  const [it] = await tx.select().from(iterations).where(and(eq(iterations.id, iterationId), isNull(iterations.deletedAt)));
  if (!it) throw new AppError('not_found', '迭代不存在');
  if (it.type === 'regular' && it.productId !== productId) throw new AppError('invalid', '不能关联其他产品的迭代');
}

async function loadRelease(tx: Tx, id: string): Promise<ReleaseRow> {
  const [row] = await tx.select().from(releases).where(eq(releases.id, id));
  if (!row) throw new AppError('not_found', '发布版本不存在');
  return row;
}

async function views(tx: Tx, actor: Actor, rows: ReleaseRow[]): Promise<ReleaseView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const prods = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, productIds));
  const optionIds = [...new Set(rows.map((r) => r.platformOptionId).filter((x): x is string => !!x))];
  const opts = optionIds.length ? await tx.select().from(fieldOptions).where(inArray(fieldOptions.id, optionIds)) : [];
  const iterIds = [...new Set(rows.map((r) => r.iterationId).filter((x): x is string => !!x))];
  const iters = iterIds.length ? await tx.select({ id: iterations.id, name: iterations.name }).from(iterations).where(inArray(iterations.id, iterIds)) : [];
  const counts = await tx
    .select({ releaseId: requirementReleases.releaseId, n: sql<number>`count(*)::int` })
    .from(requirementReleases)
    .innerJoin(requirements, eq(requirements.id, requirementReleases.requirementId))
    .where(and(inArray(requirementReleases.releaseId, ids), isNull(requirements.deletedAt)))
    .groupBy(requirementReleases.releaseId);
  const roles = new Map<string, ProductRole | null>();
  for (const pid of productIds) roles.set(pid, await productRoleOf(tx, actor, pid));
  return rows.map((r) => {
    const o = opts.find((x) => x.id === r.platformOptionId);
    return {
      id: r.id,
      productId: r.productId,
      productKey: prods.find((p) => p.id === r.productId)?.key ?? '',
      versionName: r.versionName,
      platform: o ? { id: o.id, key: o.key, label: o.label, color: o.color } : null,
      iteration: r.iterationId ? (iters.find((i) => i.id === r.iterationId) ?? null) : null,
      status: r.status,
      plannedDate: r.plannedDate,
      baselineDate: r.baselineDate,
      releasedAt: r.releasedAt,
      notes: r.notes,
      requirementCount: counts.find((c) => c.releaseId === r.id)?.n ?? 0,
      canEdit: atLeast(roles.get(r.productId) ?? null, 'editor'),
    };
  });
}

export async function listReleases(db: Db, actor: Actor, input: { productId?: string; iterationId?: string }): Promise<ReleaseView[]> {
  if (!input.productId && !input.iterationId) throw new AppError('invalid', '需要指定产品或迭代');
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    if (input.productId && !visible.has(input.productId)) throw new AppError('not_found', '产品不存在');
    if (visible.size === 0) return [];
    const conds: SQL[] = [inArray(releases.productId, [...visible])];
    if (input.productId) conds.push(eq(releases.productId, input.productId));
    if (input.iterationId) conds.push(eq(releases.iterationId, input.iterationId));
    const rows = await tx
      .select()
      .from(releases)
      .where(and(...conds))
      .orderBy(sql`${releases.plannedDate} desc nulls last`, desc(releases.createdAt));
    return views(tx, actor, rows);
  });
}

export async function createRelease(
  db: Db,
  actor: Actor,
  input: { productId: string; versionName: string; platformOptionId?: string | null; iterationId?: string | null; plannedDate: string; notes?: string | null },
): Promise<ReleaseView> {
  const versionName = assertVersionName(input.versionName);
  const plannedDate = assertIsoDate(input.plannedDate, '计划发布日期');
  const notes = assertNotes(input.notes);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, input.productId, 'editor');
    if (input.platformOptionId) await assertPlatformOption(tx, input.productId, input.platformOptionId, null);
    if (input.iterationId) await assertReleaseIteration(tx, input.productId, input.iterationId);
    const [row] = await tx
      .insert(releases)
      .values({
        orgId: actor.orgId,
        productId: input.productId,
        versionName,
        platformOptionId: input.platformOptionId ?? null,
        iterationId: input.iterationId ?? null,
        plannedDate,
        baselineDate: plannedDate,
        notes,
      })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: input.productId,
      type: 'release.created',
      subjectType: 'release',
      subjectId: row!.id,
      actor,
      payload: { versionName, plannedDate },
    });
    const [view] = await views(tx, actor, [row!]);
    return view!;
  });
}

export async function updateRelease(
  db: Db,
  actor: Actor,
  id: string,
  input: { versionName?: string; platformOptionId?: string | null; iterationId?: string | null; plannedDate?: string | null; notes?: string | null },
): Promise<ReleaseView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRelease(tx, id);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const next = {
      versionName: input.versionName === undefined ? cur.versionName : assertVersionName(input.versionName),
      platformOptionId: input.platformOptionId === undefined ? cur.platformOptionId : input.platformOptionId,
      iterationId: input.iterationId === undefined ? cur.iterationId : input.iterationId,
      plannedDate: input.plannedDate === undefined ? cur.plannedDate : input.plannedDate === null ? null : assertIsoDate(input.plannedDate, '计划发布日期'),
      notes: input.notes === undefined ? cur.notes : assertNotes(input.notes),
    };
    if (next.platformOptionId && next.platformOptionId !== cur.platformOptionId) await assertPlatformOption(tx, cur.productId, next.platformOptionId, cur.platformOptionId);
    if (next.iterationId && next.iterationId !== cur.iterationId) await assertReleaseIteration(tx, cur.productId, next.iterationId);
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    const [row] = await tx.update(releases).set(next).where(eq(releases.id, id)).returning();
    if (changes.length > 0) {
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'release.updated', subjectType: 'release', subjectId: id, actor, payload: { changes } });
    }
    const [view] = await views(tx, actor, [row!]);
    return view!;
  });
}

export async function markReleaseReleased(db: Db, actor: Actor, id: string): Promise<ReleaseView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRelease(tx, id);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    if (cur.status === 'released') throw new AppError('invalid', '该版本已发布');
    const now = new Date();
    const [row] = await tx.update(releases).set({ status: 'released', releasedAt: now }).where(eq(releases.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'release.released',
      subjectType: 'release',
      subjectId: id,
      actor,
      payload: { changes: [{ field: 'status', old: cur.status, new: 'released' }] },
    });
    const [view] = await views(tx, actor, [row!]);
    return view!;
  });
}

async function loadPair(tx: Tx, actor: Actor, releaseId: string, requirementId: string) {
  const rel = await loadRelease(tx, releaseId);
  await requireProductRole(tx, actor, rel.productId, 'editor');
  const req = await loadRequirement(tx, requirementId);
  if (req.productId !== rel.productId) throw new AppError('invalid', '只能关联本产品的需求');
  return { rel, req };
}

export async function linkRequirementRelease(db: Db, actor: Actor, releaseId: string, requirementId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { rel, req } = await loadPair(tx, actor, releaseId, requirementId);
    const inserted = await tx
      .insert(requirementReleases)
      .values({ orgId: actor.orgId, requirementId: req.id, releaseId: rel.id })
      .onConflictDoNothing()
      .returning({ releaseId: requirementReleases.releaseId });
    if (inserted.length === 0) return;
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rel.productId,
      type: 'requirement.release_linked',
      subjectType: 'requirement',
      subjectId: req.id,
      actor,
      payload: { releaseId: rel.id, versionName: rel.versionName },
    });
  });
}

export async function unlinkRequirementRelease(db: Db, actor: Actor, releaseId: string, requirementId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { rel, req } = await loadPair(tx, actor, releaseId, requirementId);
    const deleted = await tx
      .delete(requirementReleases)
      .where(and(eq(requirementReleases.releaseId, rel.id), eq(requirementReleases.requirementId, req.id)))
      .returning({ releaseId: requirementReleases.releaseId });
    if (deleted.length === 0) return;
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rel.productId,
      type: 'requirement.release_unlinked',
      subjectType: 'requirement',
      subjectId: req.id,
      actor,
      payload: { releaseId: rel.id, versionName: rel.versionName },
    });
  });
}
```

- [ ] **Step 4: `forkFieldForProduct` 同时改写平台选项引用**

`packages/core/src/definitions/fields.ts`：

1. schema import 改为：

```ts
import { fieldDefinitions, fieldOptions, fieldValues, releases, requirementAssignments, requirements } from '../db/schema';
```

2. 把原来的注释和 `for (const o of opts) { … }` 循环替换为：

```ts
    // 本产品需求上已有的字段值，以及本产品发布版本、开发分配上的平台选项，按选项 key 改指向产品级选项，否则产品级字段看不到旧值
    const copyIdByKey = new Map(copies.map((o) => [o.key, o.id]));
    const productRequirements = tx.select({ id: requirements.id }).from(requirements).where(eq(requirements.productId, productId));
    let movedValues = 0;
    for (const o of opts) {
      const target = copyIdByKey.get(o.key)!;
      const moved = await tx
        .update(fieldValues)
        .set({ fieldId: copy.id, optionId: target })
        .where(and(eq(fieldValues.fieldId, src.id), eq(fieldValues.optionId, o.id), inArray(fieldValues.entityId, productRequirements)))
        .returning({ id: fieldValues.id });
      const movedReleases = await tx
        .update(releases)
        .set({ platformOptionId: target })
        .where(and(eq(releases.productId, productId), eq(releases.platformOptionId, o.id)))
        .returning({ id: releases.id });
      const movedAssignments = await tx
        .update(requirementAssignments)
        .set({ platformOptionId: target })
        .where(and(eq(requirementAssignments.platformOptionId, o.id), inArray(requirementAssignments.requirementId, productRequirements)))
        .returning({ id: requirementAssignments.id });
      movedValues += moved.length + movedReleases.length + movedAssignments.length;
    }
```

`packages/core/src/index.ts` 末尾追加：

```ts
export * from './releases/releases';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/releases.test.ts test/requirements.test.ts test/fields.test.ts`
Expected: PASS（`requirements.test.ts` 中原有的 `movedValues: 1` 断言不受影响：该产品没有发布版本和开发分配）。再跑 `pnpm --filter @flower/core test` 与 `pnpm typecheck`。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/releases packages/core/src/definitions/fields.ts packages/core/src/index.ts packages/core/test/releases.test.ts
git commit -m "feat(core): 发布版本服务；字段按产品覆盖时一并改写发布版本与开发分配的平台选项"
```

---
### Task 4: 阻塞项与需求关联服务

**Files:**
- Create: `packages/core/src/requirements/blockers.ts`
- Create: `packages/core/src/requirements/relations.ts`
- Modify: `packages/core/src/requirements/detail.ts`（`relations[]` 增加 `id`）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/blockers-relations.test.ts`

**Interfaces:**
- Consumes: `loadRequirement`、`assertMemberInOrg`、`memberNames`（`requirements/context.ts`）；`productRoleOf`、`requireProductRole`、`atLeast`；`RELATION_TYPES`、`blockers`、`requirementRelations`（schema）
- Produces（`blockers.ts`）：
  - `type BlockerView = { id: string; description: string; status: 'active' | 'resolved'; owner: MemberRef | null; createdAt: Date; resolvedAt: Date | null }`
  - `createBlocker(db, actor, requirementId: string, input: { description: string; ownerMemberId?: string | null }): Promise<BlockerView>`
  - `resolveBlocker(db, actor, blockerId: string): Promise<BlockerView>`
- Produces（`relations.ts`）：
  - `type RelationType = (typeof RELATION_TYPES)[number]`
  - `createRelation(db, actor, input: { fromId: string; toId: string; type: RelationType }): Promise<{ id: string }>`
  - `deleteRelation(db, actor, relationId: string): Promise<void>`
- Produces（`detail.ts`）：`RequirementDetail.relations` 元素改为 `{ id: string; type: string; direction: 'out' | 'in'; other: { id: string; displayKey: string; title: string } }`
- 事件：`blocker.created`（`blockerId`、`description`）、`blocker.resolved`（`blockerId`、`changes`）、`requirement.relation_added` / `requirement.relation_removed`（subject 为 `fromId`，payload `relationId`、`toId`、`type`）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/blockers-relations.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createBlocker, resolveBlocker } from '../src/requirements/blockers';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRelation, deleteRelation } from '../src/requirements/relations';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createOrganization, resolveActor } from '../src/tenancy/orgs';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guestEditor: Actor;
let readToken: Actor;
let a: RequirementListItem;
let b: RequirementListItem;
let d: RequirementListItem;
let foreignId: string;

const eventTypes = (subjectId: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.select({ type: domainEvents.type, payload: domainEvents.payload }).from(domainEvents).where(eq(domainEvents.subjectId, subjectId)));

beforeAll(async () => {
  t = await createTestDb();
  const seeded = await seedInstance(t.db);
  owner = seeded.owner;
  const pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  const e = await createPlaceholderMember(t.db, owner, { displayName: '开发乙' });
  editor = { ...owner, memberId: e.id, orgRole: 'member', accountId: null };
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读丙' });
  await setProductRole(t.db, owner, pan, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
  const g = await createPlaceholderMember(t.db, owner, { displayName: '外部编辑丁' });
  await setProductRole(t.db, owner, pan, g.id, 'editor');
  guestEditor = { ...owner, memberId: g.id, orgRole: 'guest', accountId: null };
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
  a = await createRequirement(t.db, owner, pan, { title: '上传断点续传' });
  b = await createRequirement(t.db, owner, pan, { title: '下载断点续传' });
  d = await createRequirement(t.db, owner, doc, { title: '文档导出' });
  const other = await createOrganization(t.db, seeded.account, { name: '其他组织', slug: 'other' });
  const otherOwner = (await resolveActor(t.db, seeded.account.id, other.org.slug))!;
  const otherProduct = (await createProduct(t.db, otherOwner, { name: '外部', key: 'EXT' })).id;
  foreignId = (await createRequirement(t.db, otherOwner, otherProduct, { title: '其他组织的需求' })).id;
});
afterAll(() => t.cleanup());

describe('阻塞项', () => {
  let blockerId: string;

  it('编辑可以新建阻塞项并指定负责人；详情中显示为未解除', async () => {
    const created = await createBlocker(t.db, editor, a.id, { description: ' 等待存储接口 ', ownerMemberId: editor.memberId });
    blockerId = created.id;
    expect(created).toMatchObject({ description: '等待存储接口', status: 'active', owner: { id: editor.memberId, displayName: '开发乙' }, resolvedAt: null });
    expect((await getRequirementByKey(t.db, owner, a.displayKey)).blockers).toMatchObject([{ id: created.id, status: 'active' }]);
    expect((await eventTypes(a.id)).map((e) => e.type)).toContain('blocker.created');
  });

  it('只读成员、只读 Token 不能新建或解除；描述不能为空', async () => {
    await expect(createBlocker(t.db, viewer, a.id, { description: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createBlocker(t.db, readToken, a.id, { description: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolveBlocker(t.db, viewer, blockerId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolveBlocker(t.db, readToken, blockerId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createBlocker(t.db, editor, a.id, { description: '   ' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('解除后记录解除时间；不能重复解除', async () => {
    const resolved = await resolveBlocker(t.db, editor, blockerId);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    await expect(resolveBlocker(t.db, editor, blockerId)).rejects.toMatchObject({ code: 'invalid', message: '该阻塞项已解除' });
    const ev = (await eventTypes(a.id)).find((e) => e.type === 'blocker.resolved')!;
    expect(ev.payload).toMatchObject({ blockerId, changes: [{ field: 'status', old: 'active', new: 'resolved' }] });
  });
});

describe('需求关联', () => {
  let relationId: string;

  it('新建有方向的关联：两端详情分别显示 out 与 in，并带关联 id', async () => {
    relationId = (await createRelation(t.db, editor, { fromId: a.id, toId: b.id, type: 'blocks' })).id;
    const fromSide = await getRequirementByKey(t.db, owner, a.displayKey);
    expect(fromSide.relations).toEqual([{ id: relationId, type: 'blocks', direction: 'out', other: { id: b.id, displayKey: b.displayKey, title: '下载断点续传' } }]);
    const toSide = await getRequirementByKey(t.db, owner, b.displayKey);
    expect(toSide.relations).toEqual([{ id: relationId, type: 'blocks', direction: 'in', other: { id: a.id, displayKey: a.displayKey, title: '上传断点续传' } }]);
    expect((await eventTypes(a.id)).find((e) => e.type === 'requirement.relation_added')!.payload).toMatchObject({ relationId, toId: b.id, type: 'blocks' });
  });

  it('不能关联自身；重复关联返回冲突；同一对需求不同类型可以并存；类型必须有效', async () => {
    await expect(createRelation(t.db, editor, { fromId: a.id, toId: a.id, type: 'related' })).rejects.toMatchObject({ code: 'invalid', message: '不能关联需求自身' });
    await expect(createRelation(t.db, editor, { fromId: a.id, toId: b.id, type: 'blocks' })).rejects.toMatchObject({ code: 'conflict', message: '已存在相同的关联' });
    await createRelation(t.db, editor, { fromId: a.id, toId: b.id, type: 'related' });
    await expect(createRelation(t.db, editor, { fromId: a.id, toId: b.id, type: 'copy_of' as never })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('跨产品：能看到对方产品时可以关联；看不到时与不存在一样；跨组织的需求不存在', async () => {
    await createRelation(t.db, editor, { fromId: a.id, toId: d.id, type: 'merged_into' });
    expect((await getRequirementByKey(t.db, owner, d.displayKey)).relations).toMatchObject([{ type: 'merged_into', direction: 'in', other: { id: a.id } }]);
    await expect(createRelation(t.db, guestEditor, { fromId: b.id, toId: d.id, type: 'related' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createRelation(t.db, owner, { fromId: a.id, toId: foreignId, type: 'related' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('只读成员、只读 Token 不能新建或删除关联；编辑可以删除', async () => {
    await expect(createRelation(t.db, viewer, { fromId: b.id, toId: a.id, type: 'related' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createRelation(t.db, readToken, { fromId: b.id, toId: a.id, type: 'related' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteRelation(t.db, viewer, relationId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteRelation(t.db, readToken, relationId)).rejects.toMatchObject({ code: 'forbidden' });
    await deleteRelation(t.db, editor, relationId);
    expect((await getRequirementByKey(t.db, owner, b.displayKey)).relations.map((r) => r.type)).toEqual(['related']);
    await expect(deleteRelation(t.db, editor, relationId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await eventTypes(a.id)).map((e) => e.type)).toContain('requirement.relation_removed');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/blockers-relations.test.ts`
Expected: FAIL，找不到模块 `../src/requirements/blockers`。

- [ ] **Step 3: 实现 `blockers.ts`**

`packages/core/src/requirements/blockers.ts`：

```ts
import { eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { blockers, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertMemberInOrg, loadRequirement, memberNames } from './context';
import type { MemberRef } from './requirements';

export type BlockerView = {
  id: string;
  description: string;
  status: 'active' | 'resolved';
  owner: MemberRef | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

type BlockerRow = typeof blockers.$inferSelect;

function assertDescription(v: string): string {
  const d = v.trim();
  if (!d || d.length > 500) throw new AppError('invalid', '阻塞描述不能为空，且不超过 500 个字符');
  return d;
}

async function toView(tx: Tx, row: BlockerRow): Promise<BlockerView> {
  const names = await memberNames(tx, [row.ownerMemberId]);
  return {
    id: row.id,
    description: row.description,
    status: row.status,
    owner: row.ownerMemberId ? { id: row.ownerMemberId, displayName: names.get(row.ownerMemberId) ?? '已删除的成员' } : null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export async function createBlocker(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { description: string; ownerMemberId?: string | null },
): Promise<BlockerView> {
  const description = assertDescription(input.description);
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'editor');
    if (input.ownerMemberId) await assertMemberInOrg(tx, input.ownerMemberId);
    const [row] = await tx
      .insert(blockers)
      .values({ orgId: actor.orgId, requirementId, description, ownerMemberId: input.ownerMemberId ?? null })
      .returning();
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: req.productId,
      type: 'blocker.created',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { blockerId: row!.id, description },
    });
    return toView(tx, row!);
  });
}

export async function resolveBlocker(db: Db, actor: Actor, blockerId: string): Promise<BlockerView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(blockers).where(eq(blockers.id, blockerId)).for('update');
    if (!cur) throw new AppError('not_found', '阻塞项不存在');
    const req = await loadRequirement(tx, cur.requirementId);
    await requireProductRole(tx, actor, req.productId, 'editor');
    if (cur.status === 'resolved') throw new AppError('invalid', '该阻塞项已解除');
    const now = new Date();
    const [row] = await tx.update(blockers).set({ status: 'resolved', resolvedAt: now }).where(eq(blockers.id, blockerId)).returning();
    await tx.update(requirements).set({ updatedAt: now }).where(eq(requirements.id, req.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: req.productId,
      type: 'blocker.resolved',
      subjectType: 'requirement',
      subjectId: req.id,
      actor,
      payload: { blockerId, changes: [{ field: 'status', old: 'active', new: 'resolved' }] },
    });
    return toView(tx, row!);
  });
}
```

- [ ] **Step 4: 实现 `relations.ts`**

`packages/core/src/requirements/relations.ts`：

```ts
import { eq } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { RELATION_TYPES, requirementRelations } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { loadRequirement } from './context';

export type RelationType = (typeof RELATION_TYPES)[number];

export async function createRelation(db: Db, actor: Actor, input: { fromId: string; toId: string; type: RelationType }): Promise<{ id: string }> {
  if (!(RELATION_TYPES as readonly string[]).includes(input.type)) throw new AppError('invalid', '关联类型无效');
  if (input.fromId === input.toId) throw new AppError('invalid', '不能关联需求自身');
  return withOrg(db, actor.orgId, async (tx) => {
    const from = await loadRequirement(tx, input.fromId);
    await requireProductRole(tx, actor, from.productId, 'editor');
    // 其他组织的需求被 RLS 过滤，这里同样得到「需求不存在」
    const to = await loadRequirement(tx, input.toId);
    if (to.productId !== from.productId && !(await productRoleOf(tx, actor, to.productId))) throw new AppError('not_found', '需求不存在');
    let id: string;
    try {
      const [row] = await tx
        .insert(requirementRelations)
        .values({ orgId: actor.orgId, fromId: from.id, toId: to.id, type: input.type })
        .returning({ id: requirementRelations.id });
      id = row!.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已存在相同的关联');
      throw e;
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: from.productId,
      type: 'requirement.relation_added',
      subjectType: 'requirement',
      subjectId: from.id,
      actor,
      payload: { relationId: id, toId: to.id, type: input.type },
    });
    return { id };
  });
}

export async function deleteRelation(db: Db, actor: Actor, relationId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [rel] = await tx.select().from(requirementRelations).where(eq(requirementRelations.id, relationId));
    if (!rel) throw new AppError('not_found', '关联不存在');
    const from = await loadRequirement(tx, rel.fromId);
    const to = await loadRequirement(tx, rel.toId);
    const fromRole = await productRoleOf(tx, actor, from.productId);
    const toRole = await productRoleOf(tx, actor, to.productId);
    if (!fromRole || !toRole) throw new AppError('not_found', '关联不存在');
    if (!atLeast(fromRole, 'editor') && !atLeast(toRole, 'editor')) throw new AppError('forbidden', '权限不足');
    await tx.delete(requirementRelations).where(eq(requirementRelations.id, relationId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: from.productId,
      type: 'requirement.relation_removed',
      subjectType: 'requirement',
      subjectId: from.id,
      actor,
      payload: { relationId, toId: to.id, type: rel.type },
    });
  });
}
```

- [ ] **Step 5: 详情中的关联带上 id**

`packages/core/src/requirements/detail.ts`：

1. `RequirementDetail` 中 `relations` 的类型改为：

```ts
  relations: Array<{ id: string; type: string; direction: 'out' | 'in'; other: { id: string; displayKey: string; title: string } }>;
```

2. 返回值中构造关联的那一行改为：

```ts
          return { id: r.id, type: r.type, direction: r.fromId === row.id ? ('out' as const) : ('in' as const), other: { id: otherId, displayKey: displayKey(o.productKey, o.number), title: o.title } };
```

`packages/core/src/index.ts` 末尾追加：

```ts
export * from './requirements/blockers';
export * from './requirements/relations';
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/blockers-relations.test.ts`
Expected: PASS。再跑 `pnpm --filter @flower/core test` 与 `pnpm typecheck`。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/requirements/blockers.ts packages/core/src/requirements/relations.ts packages/core/src/requirements/detail.ts packages/core/src/index.ts packages/core/test/blockers-relations.test.ts
git commit -m "feat(core): 阻塞项新建与解除、需求关联新建与删除"
```

---
### Task 5: 结构树维护服务；产品成员角色列表（修复访客产品管理员的角色页签）

**Files:**
- Create: `packages/core/src/structure/nodes.ts`
- Modify: `packages/core/src/requirements/lookups.ts`（`StructureNodeView` 增加 `description`）
- Modify: `packages/core/src/tenancy/products.ts`（增加 `listProductMemberRoles`）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/structure.test.ts`、`packages/core/test/product-member-roles.test.ts`

**Interfaces:**
- Consumes: `requireProductRole`；`structureNodes`、`members`、`productMembers`（schema）；`listStructureNodes`（`requirements/lookups.ts`）
- Produces（`lookups.ts`）：`StructureNodeView = { id: string; parentId: string | null; depth: number; name: string; description: string | null; status: 'active' | 'deprecated'; sort: number }`
- Produces（`structure/nodes.ts`）：
  - `MAX_STRUCTURE_DEPTH = 3`
  - `createStructureNode(db, actor, productId: string, input: { parentId?: string | null; name: string; description?: string | null }): Promise<StructureNodeView>`
  - `updateStructureNode(db, actor, nodeId: string, input: { name?: string; description?: string | null; status?: 'active' | 'deprecated' }): Promise<StructureNodeView>`
  - `moveStructureNode(db, actor, nodeId: string, input: { parentId: string | null }): Promise<StructureNodeView>`
  - `reorderStructureNodes(db, actor, productId: string, input: { parentId: string | null; nodeIds: string[] }): Promise<StructureNodeView[]>`
- Produces（`tenancy/products.ts`）：
  - `type ProductMemberRole = { memberId: string; displayName: string; kind: 'human' | 'agent'; orgRole: OrgRole; role: ProductRole | null }`
  - `listProductMemberRoles(db, actor, productId: string): Promise<ProductMemberRole[]>`（产品管理员可调用；只含在职成员）
- 事件：`structure_node.created`、`structure_node.updated`（`changes`）、`structure_node.moved`（`changes`：`parentId`、`depth`）、`structure_node.reordered`（subject 为产品，payload `parentId`、`nodeIds`）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/structure.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { listStructureNodes } from '../src/requirements/lookups';
import { createStructureNode, moveStructureNode, reorderStructureNodes, updateStructureNode } from '../src/structure/nodes';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pm: Actor;
let editor: Actor;
let readToken: Actor;
let pan: string;
let doc: string;

const names = async () => (await listStructureNodes(t.db, owner, pan)).map((n) => [n.name, n.depth, n.parentId === null ? null : 'child', n.sort]);

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  const p = await createPlaceholderMember(t.db, owner, { displayName: '产品经理甲' });
  await setProductRole(t.db, owner, pan, p.id, 'admin');
  pm = { ...owner, memberId: p.id, orgRole: 'guest', accountId: null };
  const e = await createPlaceholderMember(t.db, owner, { displayName: '开发乙' });
  editor = { ...owner, memberId: e.id, orgRole: 'member', accountId: null };
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
});
afterAll(() => t.cleanup());

describe('结构树维护', () => {
  let member: string;
  let renew: string;
  let storage: string;

  it('产品管理员新建三层节点，同级按顺序编号；第四层被拒绝', async () => {
    member = (await createStructureNode(t.db, pm, pan, { name: '会员与支付', description: '会员、续费与支付' })).id;
    storage = (await createStructureNode(t.db, pm, pan, { name: '存储' })).id;
    renew = (await createStructureNode(t.db, pm, pan, { parentId: member, name: '续费' })).id;
    const leaf = await createStructureNode(t.db, pm, pan, { parentId: renew, name: '自动续费' });
    expect(leaf).toMatchObject({ depth: 3, sort: 0, status: 'active' });
    await expect(createStructureNode(t.db, pm, pan, { parentId: leaf.id, name: '第四层' })).rejects.toMatchObject({ code: 'invalid', message: '结构树最多 3 层' });
    expect(await names()).toEqual([
      ['会员与支付', 1, null, 0],
      ['存储', 1, null, 1],
      ['续费', 2, 'child', 0],
      ['自动续费', 3, 'child', 0],
    ]);
    expect((await listStructureNodes(t.db, owner, pan))[0]!.description).toBe('会员、续费与支付');
  });

  it('编辑、只读 Token 不能维护；同一上级下不能重名；上级必须属于同一产品', async () => {
    await expect(createStructureNode(t.db, editor, pan, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createStructureNode(t.db, readToken, pan, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateStructureNode(t.db, editor, member, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createStructureNode(t.db, pm, pan, { name: '存储' })).rejects.toMatchObject({ code: 'conflict', message: '同一上级下已有同名节点' });
    await expect(createStructureNode(t.db, owner, doc, { parentId: member, name: '跨产品' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createStructureNode(t.db, pm, pan, { name: '  ' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('改名、改说明、停用与恢复，记录变更；停用的节点下不能新增', async () => {
    const renamed = await updateStructureNode(t.db, pm, renew, { name: '续费管理', description: '续费相关功能' });
    expect(renamed).toMatchObject({ name: '续费管理', description: '续费相关功能' });
    await updateStructureNode(t.db, pm, storage, { status: 'deprecated' });
    await expect(createStructureNode(t.db, pm, pan, { parentId: storage, name: '空间' })).rejects.toMatchObject({ code: 'invalid' });
    expect((await updateStructureNode(t.db, pm, storage, { status: 'active' })).status).toBe('active');
    const events = await withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(eq(domainEvents.subjectId, renew)));
    expect(events.find((e) => e.type === 'structure_node.updated')!.payload).toMatchObject({
      changes: [{ field: 'name', old: '续费', new: '续费管理' }, { field: 'description', old: null, new: '续费相关功能' }],
    });
    await expect(updateStructureNode(t.db, pm, renew, { status: 'gone' as never })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('移动节点时子树整体平移深度；超过 3 层、移到自身下级都被拒绝', async () => {
    await expect(moveStructureNode(t.db, pm, member, { parentId: renew })).rejects.toMatchObject({ code: 'invalid', message: '不能移动到自身或下级节点之下' });
    await expect(moveStructureNode(t.db, pm, renew, { parentId: storage })).resolves.toMatchObject({ depth: 2 });
    await expect(moveStructureNode(t.db, pm, storage, { parentId: member })).rejects.toMatchObject({ code: 'invalid', message: '移动后层级超过 3 层' });
    const moved = await moveStructureNode(t.db, pm, renew, { parentId: null });
    expect(moved).toMatchObject({ depth: 1, parentId: null, sort: 2 });
    const all = await listStructureNodes(t.db, owner, pan);
    expect(all.find((n) => n.name === '自动续费')).toMatchObject({ depth: 2, parentId: renew });
  });

  it('同级排序必须包含全部同级节点', async () => {
    const roots = (await listStructureNodes(t.db, owner, pan)).filter((n) => n.parentId === null);
    const reversed = roots.map((n) => n.id).reverse();
    const result = await reorderStructureNodes(t.db, pm, pan, { parentId: null, nodeIds: reversed });
    expect(result.map((n) => n.id)).toEqual(reversed);
    expect(result.map((n) => n.sort)).toEqual([0, 1, 2]);
    await expect(reorderStructureNodes(t.db, pm, pan, { parentId: null, nodeIds: reversed.slice(1) })).rejects.toMatchObject({ code: 'invalid' });
    await expect(reorderStructureNodes(t.db, editor, pan, { parentId: null, nodeIds: reversed })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

`packages/core/test/product-member-roles.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { createPlaceholderMember, listMembers } from '../src/tenancy/members';
import { createProduct, listProductMemberRoles, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let guestAdmin: Actor;
let viewer: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const g = await createPlaceholderMember(t.db, owner, { displayName: '外部顾问' });
  await setProductRole(t.db, owner, pan, g.id, 'admin');
  guestAdmin = { ...owner, memberId: g.id, orgRole: 'guest', accountId: null };
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读丙' });
  await setProductRole(t.db, owner, pan, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
});
afterAll(() => t.cleanup());

describe('产品成员角色列表', () => {
  it('访客产品管理员不能列组织成员，但能列本产品的成员角色', async () => {
    await expect(listMembers(t.db, guestAdmin)).rejects.toMatchObject({ code: 'forbidden' });
    const rows = await listProductMemberRoles(t.db, guestAdmin, pan);
    expect(rows.map((r) => [r.displayName, r.role])).toEqual([
      ['Owner', null],
      ['外部顾问', 'admin'],
      ['只读丙', 'viewer'],
    ]);
    expect(rows[0]).toMatchObject({ orgRole: 'owner', kind: 'human' });
  });

  it('非产品管理员和只读 Token 不能调用', async () => {
    await expect(listProductMemberRoles(t.db, viewer, pan)).rejects.toMatchObject({ code: 'forbidden' });
    const readToken: Actor = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
    await expect(listProductMemberRoles(t.db, readToken, pan)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/structure.test.ts test/product-member-roles.test.ts`
Expected: FAIL，找不到模块 `../src/structure/nodes`，且 `listProductMemberRoles` 未导出。

- [ ] **Step 3: `StructureNodeView` 增加说明**

`packages/core/src/requirements/lookups.ts`：

```ts
export type StructureNodeView = {
  id: string;
  parentId: string | null;
  depth: number;
  name: string;
  description: string | null;
  status: 'active' | 'deprecated';
  sort: number;
};
```

`listStructureNodes` 的返回映射改为：

```ts
    return rows.map((n) => ({ id: n.id, parentId: n.parentId, depth: n.depth, name: n.name, description: n.description, status: n.status, sort: n.sort }));
```

- [ ] **Step 4: 实现 `structure/nodes.ts`**

`packages/core/src/structure/nodes.ts`：

```ts
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import type { StructureNodeView } from '../requirements/lookups';

export const MAX_STRUCTURE_DEPTH = 3;

type NodeRow = typeof structureNodes.$inferSelect;

const view = (n: NodeRow): StructureNodeView => ({
  id: n.id,
  parentId: n.parentId,
  depth: n.depth,
  name: n.name,
  description: n.description,
  status: n.status,
  sort: n.sort,
});

function assertName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '节点名称不能为空，且不超过 50 个字符');
  return n;
}

function assertDescription(d: string | null | undefined): string | null {
  const v = d?.trim() || null;
  if (v && v.length > 2000) throw new AppError('invalid', '节点说明不超过 2000 个字符');
  return v;
}

function duplicateName(e: unknown): never {
  if (isUniqueViolation(e)) throw new AppError('conflict', '同一上级下已有同名节点');
  throw e;
}

const siblingsOf = (productId: string, parentId: string | null) =>
  and(eq(structureNodes.productId, productId), parentId === null ? isNull(structureNodes.parentId) : eq(structureNodes.parentId, parentId));

async function loadNode(tx: Tx, id: string): Promise<NodeRow> {
  const [n] = await tx.select().from(structureNodes).where(eq(structureNodes.id, id));
  if (!n) throw new AppError('not_found', '节点不存在');
  return n;
}

async function nextSort(tx: Tx, productId: string, parentId: string | null): Promise<number> {
  const [row] = await tx.select({ max: sql<number | null>`max(${structureNodes.sort})` }).from(structureNodes).where(siblingsOf(productId, parentId));
  return (row?.max ?? -1) + 1;
}

function subtreeIds(all: Array<{ id: string; parentId: string | null }>, rootId: string): Set<string> {
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) {
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

export async function createStructureNode(
  db: Db,
  actor: Actor,
  productId: string,
  input: { parentId?: string | null; name: string; description?: string | null },
): Promise<StructureNodeView> {
  const name = assertName(input.name);
  const description = assertDescription(input.description);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const parentId = input.parentId ?? null;
    let depth = 1;
    if (parentId) {
      const parent = await loadNode(tx, parentId);
      if (parent.productId !== productId) throw new AppError('invalid', '上级节点不属于该产品');
      if (parent.status === 'deprecated') throw new AppError('invalid', '不能在已停用的节点下新增');
      depth = parent.depth + 1;
      if (depth > MAX_STRUCTURE_DEPTH) throw new AppError('invalid', `结构树最多 ${MAX_STRUCTURE_DEPTH} 层`);
    }
    const sort = await nextSort(tx, productId, parentId);
    let row: NodeRow;
    try {
      [row] = (await tx.insert(structureNodes).values({ orgId: actor.orgId, productId, parentId, depth, name, description, sort }).returning()) as [NodeRow];
    } catch (e) {
      duplicateName(e);
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'structure_node.created',
      subjectType: 'structure_node',
      subjectId: row.id,
      actor,
      payload: { name, parentId, depth },
    });
    return view(row);
  });
}

export async function updateStructureNode(
  db: Db,
  actor: Actor,
  nodeId: string,
  input: { name?: string; description?: string | null; status?: 'active' | 'deprecated' },
): Promise<StructureNodeView> {
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'deprecated') throw new AppError('invalid', '节点状态无效');
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadNode(tx, nodeId);
    await requireProductRole(tx, actor, cur.productId, 'admin');
    const next = {
      name: input.name === undefined ? cur.name : assertName(input.name),
      description: input.description === undefined ? cur.description : assertDescription(input.description),
      status: input.status ?? cur.status,
    };
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    let row: NodeRow;
    try {
      [row] = (await tx.update(structureNodes).set(next).where(eq(structureNodes.id, nodeId)).returning()) as [NodeRow];
    } catch (e) {
      duplicateName(e);
    }
    if (changes.length > 0) {
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'structure_node.updated', subjectType: 'structure_node', subjectId: nodeId, actor, payload: { changes } });
    }
    return view(row);
  });
}

export async function moveStructureNode(db: Db, actor: Actor, nodeId: string, input: { parentId: string | null }): Promise<StructureNodeView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const node = await loadNode(tx, nodeId);
    await requireProductRole(tx, actor, node.productId, 'admin');
    if (input.parentId === node.parentId) return view(node);
    const all = await tx
      .select({ id: structureNodes.id, parentId: structureNodes.parentId, depth: structureNodes.depth, status: structureNodes.status })
      .from(structureNodes)
      .where(eq(structureNodes.productId, node.productId));
    const subtree = subtreeIds(all, node.id);
    let depth = 1;
    if (input.parentId) {
      const parent = all.find((n) => n.id === input.parentId);
      if (!parent) throw new AppError('invalid', '上级节点不属于该产品');
      if (subtree.has(parent.id)) throw new AppError('invalid', '不能移动到自身或下级节点之下');
      if (parent.status === 'deprecated') throw new AppError('invalid', '不能移动到已停用的节点下');
      depth = parent.depth + 1;
    }
    const delta = depth - node.depth;
    const deepest = Math.max(...all.filter((n) => subtree.has(n.id)).map((n) => n.depth)) + delta;
    if (deepest > MAX_STRUCTURE_DEPTH) throw new AppError('invalid', '移动后层级超过 3 层');
    const sort = await nextSort(tx, node.productId, input.parentId);
    let row: NodeRow;
    try {
      [row] = (await tx.update(structureNodes).set({ parentId: input.parentId, depth, sort }).where(eq(structureNodes.id, nodeId)).returning()) as [NodeRow];
    } catch (e) {
      duplicateName(e);
    }
    const descendants = [...subtree].filter((id) => id !== node.id);
    if (delta !== 0 && descendants.length > 0) {
      await tx
        .update(structureNodes)
        .set({ depth: sql`${structureNodes.depth} + ${delta}` })
        .where(inArray(structureNodes.id, descendants));
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: node.productId,
      type: 'structure_node.moved',
      subjectType: 'structure_node',
      subjectId: nodeId,
      actor,
      payload: { changes: [{ field: 'parentId', old: node.parentId, new: input.parentId }, { field: 'depth', old: node.depth, new: depth }] },
    });
    return view(row);
  });
}

export async function reorderStructureNodes(
  db: Db,
  actor: Actor,
  productId: string,
  input: { parentId: string | null; nodeIds: string[] },
): Promise<StructureNodeView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const siblings = await tx.select({ id: structureNodes.id }).from(structureNodes).where(siblingsOf(productId, input.parentId));
    const same = siblings.length === input.nodeIds.length && new Set(input.nodeIds).size === input.nodeIds.length && siblings.every((s) => input.nodeIds.includes(s.id));
    if (!same) throw new AppError('invalid', '排序必须包含同一上级下的全部节点');
    for (const [i, id] of input.nodeIds.entries()) {
      await tx.update(structureNodes).set({ sort: i }).where(eq(structureNodes.id, id));
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'structure_node.reordered',
      subjectType: 'product',
      subjectId: productId,
      actor,
      payload: { parentId: input.parentId, nodeIds: input.nodeIds },
    });
    const rows = await tx.select().from(structureNodes).where(siblingsOf(productId, input.parentId)).orderBy(asc(structureNodes.sort));
    return rows.map(view);
  });
}
```

- [ ] **Step 5: 实现 `listProductMemberRoles`**

`packages/core/src/tenancy/products.ts`：

1. `import type { Actor, ProductRole } from '../domain-types';` 改为 `import type { Actor, OrgRole, ProductRole } from '../domain-types';`
2. 在 `listProductRoles` 之后加入：

```ts
export type ProductMemberRole = { memberId: string; displayName: string; kind: 'human' | 'agent'; orgRole: OrgRole; role: ProductRole | null };

/** 产品设置「成员角色」页签的数据：产品管理员（含访客产品管理员）可调用，不依赖组织成员列表权限。 */
export async function listProductMemberRoles(db: Db, actor: Actor, productId: string): Promise<ProductMemberRole[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const rows = await tx.select().from(members).where(eq(members.status, 'active')).orderBy(asc(members.createdAt));
    const overrides = await tx
      .select({ memberId: productMembers.memberId, role: productMembers.role })
      .from(productMembers)
      .where(eq(productMembers.productId, productId));
    const byId = new Map(overrides.map((o) => [o.memberId, o.role]));
    return rows.map((m) => ({ memberId: m.id, displayName: m.displayName, kind: m.kind, orgRole: m.orgRole, role: byId.get(m.id) ?? null }));
  });
}
```

`packages/core/src/index.ts` 末尾追加：

```ts
export * from './structure/nodes';
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/structure.test.ts test/product-member-roles.test.ts test/requirements.test.ts`
Expected: PASS。再跑 `pnpm --filter @flower/core test` 与 `pnpm typecheck`。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/structure packages/core/src/requirements/lookups.ts packages/core/src/tenancy/products.ts packages/core/src/index.ts packages/core/test/structure.test.ts packages/core/test/product-member-roles.test.ts
git commit -m "feat(core): 结构树维护服务；产品管理员可读取本产品成员角色"
```

---
### Task 6: HTTP 接口：迭代、加入迭代、发布版本、阻塞项、关联、结构树、产品成员角色

**Files:**
- Create: `apps/web/src/server/routes/iterations.ts`
- Create: `apps/web/src/server/routes/releases.ts`
- Create: `apps/web/src/server/routes/structure.ts`
- Modify: `apps/web/src/server/routes/requirements.ts`（阻塞项、关联）
- Modify: `apps/web/src/server/routes/products.ts`（产品成员角色）
- Modify: `apps/web/src/server/api.ts`（注册）
- Test: `apps/web/test/api/iterations.test.ts`、`apps/web/test/api/maintenance.test.ts`

**Interfaces:**
- Consumes: Task 1–5 的全部服务函数；`RELATION_TYPES`（`@flower/core`）
- Produces（HTTP，前缀 `/api/v1`）：

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /orgs/:org/iterations` | 查询参数 `product`（可选，产品 id） | `{ iterations: IterationView[] }` |
| `POST /orgs/:org/iterations` | `{ type, productId?, name, startDate, endDate, milestones? }` | `201 { iteration: IterationView }` |
| `GET /orgs/:org/iterations/:id` | — | `{ iteration: IterationDetail }` |
| `PATCH /orgs/:org/iterations/:id` | `{ name?, startDate?, endDate?, milestones? }` | `{ iteration: IterationView }` |
| `POST /orgs/:org/iterations/:id/status` | `{ to: 'planning' \| 'active' \| 'done' \| 'canceled' }` | `{ iteration: IterationView }` |
| `DELETE /orgs/:org/iterations/:id` | — | `204` |
| `GET /orgs/:org/iterations/:id/scope` | — | `{ scope: IterationScope }` |
| `PUT /orgs/:org/requirements/:id/iteration` | `{ iterationId: string \| null, force?, reason? }` | `{ iteration: { id, name } \| null }`；条件未满足 `412` |
| `GET /orgs/:org/releases` | 查询参数 `product`、`iteration`（至少一个） | `{ releases: ReleaseView[] }` |
| `POST /orgs/:org/releases` | `{ productId, versionName, platformOptionId?, iterationId?, plannedDate, notes? }` | `201 { release: ReleaseView }` |
| `PATCH /orgs/:org/releases/:id` | `{ versionName?, platformOptionId?, iterationId?, plannedDate?, notes? }` | `{ release: ReleaseView }` |
| `POST /orgs/:org/releases/:id/released` | 无请求体 | `{ release: ReleaseView }` |
| `PUT /orgs/:org/releases/:id/requirements/:requirementId` | 无请求体 | `204` |
| `DELETE /orgs/:org/releases/:id/requirements/:requirementId` | — | `204` |
| `POST /orgs/:org/requirements/:id/blockers` | `{ description, ownerMemberId? }` | `201 { blocker: BlockerView }` |
| `POST /orgs/:org/blockers/:id/resolve` | 无请求体 | `{ blocker: BlockerView }` |
| `POST /orgs/:org/requirements/:id/relations` | `{ toId, type }` | `201 { relation: { id } }` |
| `DELETE /orgs/:org/relations/:id` | — | `204` |
| `POST /orgs/:org/products/:id/nodes` | `{ parentId?, name, description? }` | `201 { node: StructureNodeView }` |
| `PUT /orgs/:org/products/:id/nodes/order` | `{ parentId, nodeIds }` | `{ nodes: StructureNodeView[] }` |
| `PATCH /orgs/:org/nodes/:id` | `{ name?, description?, status? }` | `{ node: StructureNodeView }` |
| `POST /orgs/:org/nodes/:id/move` | `{ parentId }` | `{ node: StructureNodeView }` |
| `GET /orgs/:org/products/:id/members` | — | `{ members: ProductMemberRole[] }` |

- [ ] **Step 1: 写失败的测试**

`apps/web/test/api/iterations.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let readToken: string;

const GATED_WORKFLOW = {
  name: '准入流程',
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
    actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] }],
    checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
  },
};

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me;
  readToken = (
    await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me.memberId, name: '只读', scope: { products: 'all', access: 'read' } } })
  ).body.token;
});
afterAll(() => cleanup());

describe('迭代接口', () => {
  it('新建、重叠返回 409、列表、详情、修改、开始、范围对比', async () => {
    const created = await call(app, 'POST', '/orgs/acme/iterations', {
      session,
      body: { type: 'regular', productId, name: '迭代0701', startDate: '2026-07-01', endDate: '2026-07-15', milestones: [{ label: '发布', date: '2026-07-15' }] },
    });
    expect(created.status).toBe(201);
    const id = created.body.iteration.id as string;
    const overlap = await call(app, 'POST', '/orgs/acme/iterations', {
      session,
      body: { type: 'regular', productId, name: '重叠', startDate: '2026-07-10', endDate: '2026-07-20' },
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.message).toBe('与已有迭代时间重叠');

    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '批量下载' } })).body.requirement;
    const joined = await call(app, 'PUT', `/orgs/acme/requirements/${req.id}/iteration`, { session, body: { iterationId: id } });
    expect(joined.body).toEqual({ iteration: { id, name: '迭代0701' } });

    const list = await call(app, 'GET', `/orgs/acme/iterations?product=${productId}`, { session });
    expect(list.body.iterations).toMatchObject([{ id, requirementCount: 1, milestones: [{ label: '发布', date: '2026-07-15' }] }]);
    const detail = await call(app, 'GET', `/orgs/acme/iterations/${id}`, { session });
    expect(detail.body.iteration.requirements).toMatchObject([{ displayKey: 'PAN-1', title: '批量下载' }]);
    const patched = await call(app, 'PATCH', `/orgs/acme/iterations/${id}`, { session, body: { name: '迭代0701A' } });
    expect(patched.body.iteration.name).toBe('迭代0701A');

    expect((await call(app, 'GET', `/orgs/acme/iterations/${id}/scope`, { session })).status).toBe(400);
    const started = await call(app, 'POST', `/orgs/acme/iterations/${id}/status`, { session, body: { to: 'active' } });
    expect(started.body.iteration).toMatchObject({ status: 'active', baselineEndDate: '2026-07-15' });
    const scope = await call(app, 'GET', `/orgs/acme/iterations/${id}/scope`, { session });
    expect(scope.body.scope).toMatchObject({ hasSnapshot: true, committedOpen: [{ displayKey: 'PAN-1' }], addedLater: [], removed: [] });
    expect((await call(app, 'POST', `/orgs/acme/iterations/${id}/status`, { session, body: { to: 'bogus' } })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/iterations/00000000-0000-0000-0000-000000000000', { session })).status).toBe(404);
  });

  it('加入迭代的条件未满足返回 412 和原因；管理员带原因可以强制加入', async () => {
    const wf = await call(app, 'POST', '/orgs/acme/workflows', { session, body: GATED_WORKFLOW });
    expect(wf.status).toBe(201);
    await call(app, 'PUT', `/orgs/acme/products/${productId}/workflow`, { session, body: { versionId: wf.body.version.id } });
    const it2 = (
      await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' } })
    ).body.iteration.id;
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '回收站搜索' } })).body.requirement;
    const blocked = await call(app, 'PUT', `/orgs/acme/requirements/${req.id}/iteration`, { session, body: { iterationId: it2 } });
    expect(blocked.status).toBe(412);
    expect(blocked.body.error).toEqual({ code: 'precondition_failed', message: '加入迭代的条件未满足', details: { unmet: ['「可行性」需为通过（当前：未开始）'] } });
    const detail = await call(app, 'GET', `/orgs/acme/requirements/${req.displayKey}`, { session });
    expect(detail.body.requirement.joinIterationUnmet).toMatchObject([{ message: '「可行性」需为通过（当前：未开始）' }]);
    const forced = await call(app, 'PUT', `/orgs/acme/requirements/${req.id}/iteration`, { session, body: { iterationId: it2, force: true, reason: '线上问题' } });
    expect(forced.status).toBe(200);
    expect(forced.body.iteration.id).toBe(it2);
  });

  it('只读 Token 可以读取，不能新建迭代或加入迭代', async () => {
    expect((await call(app, 'GET', '/orgs/acme/iterations', { token: readToken })).status).toBe(200);
    const denied = await call(app, 'POST', '/orgs/acme/iterations', {
      token: readToken,
      body: { type: 'regular', productId, name: '越权', startDate: '2026-12-01', endDate: '2026-12-10' },
    });
    expect(denied.status).toBe(403);
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '只读测试' } })).body.requirement;
    expect((await call(app, 'PUT', `/orgs/acme/requirements/${req.id}/iteration`, { token: readToken, body: { iterationId: null } })).status).toBe(403);
  });

  it('删除规划中的空迭代返回 204，之后查不到', async () => {
    const id = (
      await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '临时迭代', startDate: '2027-01-01', endDate: '2027-01-10' } })
    ).body.iteration.id;
    expect((await call(app, 'DELETE', `/orgs/acme/iterations/${id}`, { session })).status).toBe(204);
    expect((await call(app, 'GET', `/orgs/acme/iterations/${id}`, { session })).status).toBe(404);
  });
});

describe('发布版本接口', () => {
  it('新建、修改、标记发布、按迭代列出、关联与解除需求', async () => {
    const fields = (await call(app, 'GET', '/orgs/acme/fields', { session })).body.fields;
    const platform = fields.find((f: { key: string }) => f.key === 'platform');
    const pc = (await call(app, 'POST', `/orgs/acme/fields/${platform.id}/options`, { session, body: { label: 'PC客户端' } })).body.option.id;
    const iterationId = (
      await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '迭代0901', startDate: '2026-09-01', endDate: '2026-09-14' } })
    ).body.iteration.id;
    const created = await call(app, 'POST', '/orgs/acme/releases', {
      session,
      body: { productId, versionName: '3.2.0', platformOptionId: pc, iterationId, plannedDate: '2026-09-14' },
    });
    expect(created.status).toBe(201);
    const id = created.body.release.id;
    expect(created.body.release).toMatchObject({ baselineDate: '2026-09-14', platform: { label: 'PC客户端' } });
    const patched = await call(app, 'PATCH', `/orgs/acme/releases/${id}`, { session, body: { plannedDate: '2026-09-20' } });
    expect(patched.body.release).toMatchObject({ plannedDate: '2026-09-20', baselineDate: '2026-09-14' });
    expect((await call(app, 'GET', '/orgs/acme/releases', { session })).status).toBe(400);
    expect((await call(app, 'GET', `/orgs/acme/releases?iteration=${iterationId}`, { session })).body.releases).toMatchObject([{ id }]);

    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '分享统计' } })).body.requirement;
    expect((await call(app, 'PUT', `/orgs/acme/releases/${id}/requirements/${req.id}`, { session })).status).toBe(204);
    expect((await call(app, 'GET', `/orgs/acme/releases?product=${productId}`, { session })).body.releases[0].requirementCount).toBe(1);
    expect((await call(app, 'DELETE', `/orgs/acme/releases/${id}/requirements/${req.id}`, { session })).status).toBe(204);

    const released = await call(app, 'POST', `/orgs/acme/releases/${id}/released`, { session });
    expect(released.body.release.status).toBe('released');
    expect((await call(app, 'POST', `/orgs/acme/releases/${id}/released`, { session })).status).toBe(400);
    expect((await call(app, 'POST', '/orgs/acme/releases', { token: readToken, body: { productId, versionName: 'x', plannedDate: '2026-09-30' } })).status).toBe(403);
  });
});
```

`apps/web/test/api/maintenance.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let readToken: string;

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me;
  readToken = (
    await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me.memberId, name: '只读', scope: { products: 'all', access: 'read' } } })
  ).body.token;
});
afterAll(() => cleanup());

describe('阻塞项与关联接口', () => {
  it('新建与解除阻塞项；新建、重复、删除关联', async () => {
    const a = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '上传断点续传' } })).body.requirement;
    const b = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '下载断点续传' } })).body.requirement;

    const blocker = await call(app, 'POST', `/orgs/acme/requirements/${a.id}/blockers`, { session, body: { description: '等待存储接口' } });
    expect(blocker.status).toBe(201);
    expect(blocker.body.blocker).toMatchObject({ description: '等待存储接口', status: 'active' });
    expect((await call(app, 'POST', `/orgs/acme/requirements/${a.id}/blockers`, { token: readToken, body: { description: 'x' } })).status).toBe(403);
    const resolved = await call(app, 'POST', `/orgs/acme/blockers/${blocker.body.blocker.id}/resolve`, { session });
    expect(resolved.body.blocker.status).toBe('resolved');

    const rel = await call(app, 'POST', `/orgs/acme/requirements/${a.id}/relations`, { session, body: { toId: b.id, type: 'blocks' } });
    expect(rel.status).toBe(201);
    const dup = await call(app, 'POST', `/orgs/acme/requirements/${a.id}/relations`, { session, body: { toId: b.id, type: 'blocks' } });
    expect(dup.status).toBe(409);
    expect((await call(app, 'POST', `/orgs/acme/requirements/${a.id}/relations`, { session, body: { toId: b.id, type: 'copy_of' } })).status).toBe(400);
    const detail = await call(app, 'GET', `/orgs/acme/requirements/${b.displayKey}`, { session });
    expect(detail.body.requirement.relations).toMatchObject([{ id: rel.body.relation.id, type: 'blocks', direction: 'in' }]);
    expect((await call(app, 'DELETE', `/orgs/acme/relations/${rel.body.relation.id}`, { session })).status).toBe(204);
  });
});

describe('结构树与产品成员角色接口', () => {
  it('新建、改名、移动、排序节点；读取产品成员角色', async () => {
    const root = await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { session, body: { name: '会员与支付' } });
    expect(root.status).toBe(201);
    const second = (await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { session, body: { name: '存储' } })).body.node;
    const child = (await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { session, body: { parentId: root.body.node.id, name: '续费' } })).body.node;
    expect(child.depth).toBe(2);
    const renamed = await call(app, 'PATCH', `/orgs/acme/nodes/${child.id}`, { session, body: { name: '续费管理', status: 'deprecated' } });
    expect(renamed.body.node).toMatchObject({ name: '续费管理', status: 'deprecated' });
    const moved = await call(app, 'POST', `/orgs/acme/nodes/${child.id}/move`, { session, body: { parentId: second.id } });
    expect(moved.body.node).toMatchObject({ parentId: second.id, depth: 2 });
    const ordered = await call(app, 'PUT', `/orgs/acme/products/${productId}/nodes/order`, { session, body: { parentId: null, nodeIds: [second.id, root.body.node.id] } });
    expect(ordered.body.nodes.map((n: { name: string }) => n.name)).toEqual(['存储', '会员与支付']);
    expect((await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { token: readToken, body: { name: '越权' } })).status).toBe(403);
    const nodes = await call(app, 'GET', `/orgs/acme/products/${productId}/nodes`, { session });
    expect(nodes.body.nodes.find((n: { name: string }) => n.name === '续费管理')).toMatchObject({ description: null, status: 'deprecated' });

    const members = await call(app, 'GET', `/orgs/acme/products/${productId}/members`, { session });
    expect(members.body.members).toMatchObject([{ displayName: 'Owner', orgRole: 'owner', role: null }]);
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/members`, { token: readToken })).status).toBe(403);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run test/api/iterations.test.ts test/api/maintenance.test.ts`
Expected: FAIL，接口返回 404「接口不存在」。

- [ ] **Step 3: 实现路由**

`apps/web/src/server/routes/iterations.ts`：

```ts
import {
  createIteration,
  deleteIteration,
  getIteration,
  getIterationScope,
  listIterations,
  setIterationStatus,
  setRequirementIteration,
  updateIteration,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const milestones = z.array(z.object({ label: z.string(), date: z.string() })).max(50);

export function registerIterationRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/iterations', async (c) =>
    c.json({ iterations: await listIterations(deps.db, c.get('actor'), { productId: c.req.query('product') || undefined }) }),
  );

  app.post('/orgs/:org/iterations', async (c) => {
    const body = await readJson(
      c,
      z.object({
        type: z.enum(['regular', 'special']),
        productId: z.string().nullable().optional(),
        name: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        milestones: milestones.optional(),
      }),
    );
    return c.json({ iteration: await createIteration(deps.db, c.get('actor'), body) }, 201);
  });

  app.get('/orgs/:org/iterations/:id', async (c) => c.json({ iteration: await getIteration(deps.db, c.get('actor'), c.req.param('id')) }));

  app.patch('/orgs/:org/iterations/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({ name: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional(), milestones: milestones.optional() }),
    );
    return c.json({ iteration: await updateIteration(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.post('/orgs/:org/iterations/:id/status', async (c) => {
    const body = await readJson(c, z.object({ to: z.enum(['planning', 'active', 'done', 'canceled']) }));
    return c.json({ iteration: await setIterationStatus(deps.db, c.get('actor'), c.req.param('id'), body.to) });
  });

  app.delete('/orgs/:org/iterations/:id', async (c) => {
    await deleteIteration(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get('/orgs/:org/iterations/:id/scope', async (c) => c.json({ scope: await getIterationScope(deps.db, c.get('actor'), c.req.param('id')) }));

  app.put('/orgs/:org/requirements/:id/iteration', async (c) => {
    const body = await readJson(c, z.object({ iterationId: z.string().nullable(), force: z.boolean().optional(), reason: z.string().max(500).optional() }));
    return c.json(await setRequirementIteration(deps.db, c.get('actor'), c.req.param('id'), body));
  });
}
```

`apps/web/src/server/routes/releases.ts`：

```ts
import { createRelease, linkRequirementRelease, listReleases, markReleaseReleased, unlinkRequirementRelease, updateRelease } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerReleaseRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/releases', async (c) =>
    c.json({
      releases: await listReleases(deps.db, c.get('actor'), { productId: c.req.query('product') || undefined, iterationId: c.req.query('iteration') || undefined }),
    }),
  );

  app.post('/orgs/:org/releases', async (c) => {
    const body = await readJson(
      c,
      z.object({
        productId: z.string(),
        versionName: z.string(),
        platformOptionId: z.string().nullable().optional(),
        iterationId: z.string().nullable().optional(),
        plannedDate: z.string(),
        notes: z.string().nullable().optional(),
      }),
    );
    return c.json({ release: await createRelease(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/releases/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({
        versionName: z.string().optional(),
        platformOptionId: z.string().nullable().optional(),
        iterationId: z.string().nullable().optional(),
        plannedDate: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    );
    return c.json({ release: await updateRelease(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.post('/orgs/:org/releases/:id/released', async (c) => c.json({ release: await markReleaseReleased(deps.db, c.get('actor'), c.req.param('id')) }));

  app.put('/orgs/:org/releases/:id/requirements/:requirementId', async (c) => {
    await linkRequirementRelease(deps.db, c.get('actor'), c.req.param('id'), c.req.param('requirementId'));
    return c.body(null, 204);
  });

  app.delete('/orgs/:org/releases/:id/requirements/:requirementId', async (c) => {
    await unlinkRequirementRelease(deps.db, c.get('actor'), c.req.param('id'), c.req.param('requirementId'));
    return c.body(null, 204);
  });
}
```

`apps/web/src/server/routes/structure.ts`：

```ts
import { createStructureNode, moveStructureNode, reorderStructureNodes, updateStructureNode } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

export function registerStructureRoutes(app: App, deps: ApiDeps): void {
  app.post('/orgs/:org/products/:id/nodes', async (c) => {
    const body = await readJson(c, z.object({ parentId: z.string().nullable().optional(), name: z.string(), description: z.string().nullable().optional() }));
    return c.json({ node: await createStructureNode(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.put('/orgs/:org/products/:id/nodes/order', async (c) => {
    const body = await readJson(c, z.object({ parentId: z.string().nullable(), nodeIds: z.array(z.string()) }));
    return c.json({ nodes: await reorderStructureNodes(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.patch('/orgs/:org/nodes/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({ name: z.string().optional(), description: z.string().nullable().optional(), status: z.enum(['active', 'deprecated']).optional() }),
    );
    return c.json({ node: await updateStructureNode(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.post('/orgs/:org/nodes/:id/move', async (c) => {
    const body = await readJson(c, z.object({ parentId: z.string().nullable() }));
    return c.json({ node: await moveStructureNode(deps.db, c.get('actor'), c.req.param('id'), body) });
  });
}
```

`apps/web/src/server/routes/requirements.ts`：

1. `@flower/core` 的 import 列表加入 `createBlocker`、`createRelation`、`deleteRelation`、`RELATION_TYPES`、`resolveBlocker`（按字母序放入现有列表）。
2. 在 `registerRequirementRoutes` 末尾（`comments/read` 路由之后）追加：

```ts
  app.post('/orgs/:org/requirements/:id/blockers', async (c) => {
    const body = await readJson(c, z.object({ description: z.string().max(500), ownerMemberId: z.string().nullable().optional() }));
    return c.json({ blocker: await createBlocker(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.post('/orgs/:org/blockers/:id/resolve', async (c) => c.json({ blocker: await resolveBlocker(deps.db, c.get('actor'), c.req.param('id')) }));

  app.post('/orgs/:org/requirements/:id/relations', async (c) => {
    const body = await readJson(c, z.object({ toId: z.string(), type: z.enum(RELATION_TYPES) }));
    return c.json({ relation: await createRelation(deps.db, c.get('actor'), { fromId: c.req.param('id'), toId: body.toId, type: body.type }) }, 201);
  });

  app.delete('/orgs/:org/relations/:id', async (c) => {
    await deleteRelation(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });
```

`apps/web/src/server/routes/products.ts`：

1. `@flower/core` 的 import 列表加入 `listProductMemberRoles`。
2. 在 `GET /orgs/:org/products/:id/roles` 路由之后加入：

```ts
  app.get('/orgs/:org/products/:id/members', async (c) =>
    c.json({ members: await listProductMemberRoles(deps.db, c.get('actor'), c.req.param('id')) }),
  );
```

`apps/web/src/server/api.ts`：import 区加入

```ts
import { registerIterationRoutes } from './routes/iterations';
import { registerReleaseRoutes } from './routes/releases';
import { registerStructureRoutes } from './routes/structure';
```

并在 `registerRequirementRoutes(app, deps);` 之后加入：

```ts
  registerIterationRoutes(app, deps);
  registerReleaseRoutes(app, deps);
  registerStructureRoutes(app, deps);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run test/api/iterations.test.ts test/api/maintenance.test.ts`
Expected: PASS。再跑 `pnpm --filter @flower/web test`、`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/server apps/web/test/api/iterations.test.ts apps/web/test/api/maintenance.test.ts
git commit -m "feat(web): 迭代、发布版本、阻塞项、关联、结构树与产品成员角色接口"
```

---
### Task 7: 迭代列表页：按产品与专项分组、新建与编辑对话框，启用「迭代」导航

**Files:**
- Modify: `apps/web/src/features/shell/nav.ts`、`nav.test.ts`
- Create: `apps/web/src/features/iterations/model.ts`、`model.test.ts`
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`
- Create: `apps/web/src/app/(app)/[org]/iterations/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/iterations/iteration-dialog.tsx`
- Create: `apps/web/e2e/iterations.spec.ts`

**Interfaces:**
- Consumes: Task 6 的 `GET/POST /orgs/:org/iterations`、`PATCH /orgs/:org/iterations/:id`；`IterationView`、`IterationMilestone`（`import type`）
- Produces（`lib/types.ts`）：`Iteration = Jsonify<IterationView>`、`IterationMilestone`
- Produces（`lib/queries.ts`）：
  - `iterationKeys(o) = ['org', o, 'iterations']`；`qk.iterations(o, productId)` 改为 `['org', o, 'iterations', 'product', productId]`；`qk.iterationList(o) = ['org', o, 'iterations', 'list']`
  - `useIterations(o: string)` → `Iteration[]`
- Produces（`features/iterations/model.ts`）：
  - `type IterationGroup = { key: string; title: string; iterations: Iteration[] }`；`groupIterations(list: Iteration[]): IterationGroup[]`（产品按编号前缀排序，专项在最后）
  - `localToday(now?: Date): string`（本地时区 `YYYY-MM-DD`）
  - `milestoneTimeline(milestones: IterationMilestone[], today: string): Array<IterationMilestone & { past: boolean }>`
  - `type IterationForm = { name: string; startDate: string; endDate: string; milestones: IterationMilestone[] }`；`iterationFormError(f: IterationForm): string | null`
- Produces（页面）：`/[org]/iterations`；`IterationDialog({ org, open, iteration, products, allowSpecial, onOpenChange })`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/iterations/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { Iteration } from '@/lib/types';
import { groupIterations, iterationFormError, localToday, milestoneTimeline } from './model';

const it0 = (over: Partial<Iteration>): Iteration => ({
  id: 'i',
  type: 'regular',
  product: null,
  name: '迭代',
  startDate: '2026-07-01',
  endDate: '2026-07-14',
  baselineEndDate: null,
  status: 'planning',
  milestones: [],
  requirementCount: 0,
  doneCount: 0,
  canManage: false,
  ...over,
});

describe('迭代列表模型', () => {
  it('按产品分组，产品按编号前缀排序，专项放最后，组内保持原顺序', () => {
    const doc = { id: 'p2', key: 'DOC', name: '文档' };
    const pan = { id: 'p1', key: 'PAN', name: '网盘' };
    const groups = groupIterations([
      it0({ id: 'a', type: 'special', name: '专项一' }),
      it0({ id: 'b', product: pan, name: '迭代0801' }),
      it0({ id: 'c', product: doc, name: '文档迭代' }),
      it0({ id: 'd', product: pan, name: '迭代0701' }),
    ]);
    expect(groups.map((g) => [g.title, g.iterations.map((i) => i.id)])).toEqual([
      ['文档', ['c']],
      ['网盘', ['b', 'd']],
      ['专项', ['a']],
    ]);
  });

  it('里程碑按日期排序并标记是否已过', () => {
    expect(
      milestoneTimeline(
        [
          { label: '发布', date: '2026-07-15' },
          { label: '开发开始', date: '2026-07-03' },
        ],
        '2026-07-10',
      ),
    ).toEqual([
      { label: '开发开始', date: '2026-07-03', past: true },
      { label: '发布', date: '2026-07-15', past: false },
    ]);
  });

  it('本地日期格式', () => {
    expect(localToday(new Date(2026, 6, 5, 23, 30))).toBe('2026-07-05');
  });

  it('表单校验给出第一条错误', () => {
    const ok = { name: '迭代0701', startDate: '2026-07-01', endDate: '2026-07-14', milestones: [] };
    expect(iterationFormError(ok)).toBeNull();
    expect(iterationFormError({ ...ok, name: ' ' })).toBe('请填写迭代名称');
    expect(iterationFormError({ ...ok, endDate: '' })).toBe('请填写开始和结束日期');
    expect(iterationFormError({ ...ok, endDate: '2026-06-30' })).toBe('结束日期不能早于开始日期');
    expect(iterationFormError({ ...ok, milestones: [{ label: '发布', date: '' }] })).toBe('里程碑需要填写名称和日期');
  });
});
```

`apps/web/src/features/shell/nav.test.ts` 中第一个用例的期望改为：

```ts
    expect(nav.main.map((i) => [i.label, i.phase ?? null, i.href ?? null])).toEqual([
      ['概览', null, '/acme'],
      ['需求', null, '/acme/requirements'],
      ['迭代', null, '/acme/iterations'],
      ['文档', 'P2', null],
    ]);
```

第三个用例末尾追加：

```ts
    expect(activeNavKey('/acme/iterations', 'acme')).toBe('iterations');
    expect(activeNavKey('/acme/iterations/abc', 'acme')).toBe('iterations');
```

Run: `pnpm --filter @flower/web exec vitest run src/features/iterations/model.test.ts src/features/shell/nav.test.ts`
Expected: FAIL，模块不存在，且导航断言不符。

- [ ] **Step 2: 启用导航**

`apps/web/src/features/shell/nav.ts`：

```ts
      { key: 'iterations', label: '迭代', href: `/${org}/iterations`, icon: 'cycle' },
```

替换原来带 `phase: 'P1'` 的那一行；`activeNavKey` 在 `requirements` 判断之后加一行：

```ts
  if (/^\/iterations(\/|$)/.test(rest)) return 'iterations';
```

- [ ] **Step 3: 实现 `features/iterations/model.ts`**

```ts
import type { Iteration, IterationMilestone } from '@/lib/types';

export type IterationGroup = { key: string; title: string; iterations: Iteration[] };

/** 按产品分组（产品按编号前缀排序），专项放最后；组内保持接口顺序（开始日期倒序）。 */
export function groupIterations(list: Iteration[]): IterationGroup[] {
  const groups = new Map<string, IterationGroup & { sortKey: string }>();
  for (const it of list) {
    const key = it.product?.id ?? 'special';
    if (!groups.has(key)) groups.set(key, { key, title: it.product?.name ?? '专项', iterations: [], sortKey: it.product?.key ?? '' });
    groups.get(key)!.iterations.push(it);
  }
  return [...groups.values()]
    .sort((a, b) => (a.key === 'special' ? 1 : b.key === 'special' ? -1 : a.sortKey.localeCompare(b.sortKey)))
    .map(({ key, title, iterations }) => ({ key, title, iterations }));
}

export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function milestoneTimeline(milestones: IterationMilestone[], today: string): Array<IterationMilestone & { past: boolean }> {
  return [...milestones].sort((a, b) => a.date.localeCompare(b.date)).map((m) => ({ ...m, past: m.date < today }));
}

export type IterationForm = { name: string; startDate: string; endDate: string; milestones: IterationMilestone[] };

/** 前端预校验，返回第一条错误；服务端仍会完整校验。 */
export function iterationFormError(f: IterationForm): string | null {
  if (!f.name.trim()) return '请填写迭代名称';
  if (!f.startDate || !f.endDate) return '请填写开始和结束日期';
  if (f.startDate > f.endDate) return '结束日期不能早于开始日期';
  if (f.milestones.some((m) => !m.label.trim() || !m.date)) return '里程碑需要填写名称和日期';
  return null;
}
```

- [ ] **Step 4: 类型与查询**

`apps/web/src/lib/types.ts`：`@flower/core` 的 type import 列表加入 `IterationMilestone as CoreIterationMilestone`、`IterationView`，文件末尾追加：

```ts
export type Iteration = Jsonify<IterationView>;
export type IterationMilestone = CoreIterationMilestone;
```

`apps/web/src/lib/queries.ts`：

1. types import 加入 `Iteration`。
2. `qk` 中 `iterations` 一项改为下面两行，并加入 `iterationList`：

```ts
  iterations: (o: string, productId: string) => ['org', o, 'iterations', 'product', productId] as const,
  iterationList: (o: string) => ['org', o, 'iterations', 'list'] as const,
```

3. 在 `requirementKeys` 之后加入：

```ts
/** 迭代相关查询的公共前缀：迭代或需求所属迭代变化后统一失效。 */
export const iterationKeys = (o: string) => ['org', o, 'iterations'] as const;

export const useIterations = (o: string) =>
  useQuery({ queryKey: qk.iterationList(o), queryFn: () => api<{ iterations: Iteration[] }>(`/orgs/${o}/iterations`), select: (d) => d.iterations });
```

- [ ] **Step 5: 新建 / 编辑对话框**

`apps/web/src/app/(app)/[org]/iterations/iteration-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type IterationForm, iterationFormError } from '@/features/iterations/model';
import { api } from '@/lib/api';
import { iterationKeys, useApiMutation } from '@/lib/queries';
import type { Iteration, IterationMilestone, Product } from '@/lib/types';

const SPECIAL = '__special';
const EMPTY: IterationForm = { name: '', startDate: '', endDate: '', milestones: [] };

export function IterationDialog({
  org,
  open,
  iteration,
  products,
  allowSpecial,
  onOpenChange,
}: {
  org: string;
  open: boolean;
  iteration: Iteration | null;
  products: Product[];
  allowSpecial: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<IterationForm>(EMPTY);
  const [scope, setScope] = useState('');
  // 打开对话框（或换了要编辑的迭代）时用来源数据填表；在渲染期间调整，不用 effect
  const source = open ? iteration : undefined;
  const [synced, setSynced] = useState<Iteration | null | undefined>(undefined);
  if (source !== synced) {
    setSynced(source);
    if (source !== undefined) {
      setForm(source ? { name: source.name, startDate: source.startDate, endDate: source.endDate, milestones: source.milestones } : EMPTY);
      setScope(source ? (source.product?.id ?? SPECIAL) : (products[0]?.id ?? (allowSpecial ? SPECIAL : '')));
    }
  }
  const save = useApiMutation(
    () => {
      const body = { name: form.name, startDate: form.startDate, endDate: form.endDate, milestones: form.milestones };
      if (iteration) return api(`/orgs/${org}/iterations/${iteration.id}`, { method: 'PATCH', body });
      return api(`/orgs/${org}/iterations`, {
        method: 'POST',
        body: scope === SPECIAL ? { ...body, type: 'special' } : { ...body, type: 'regular', productId: scope },
      });
    },
    { invalidate: [iterationKeys(org)], silentError: true, success: iteration ? '已保存' : '已创建迭代', onSuccess: () => onOpenChange(false) },
  );
  const close = () => {
    save.reset();
    onOpenChange(false);
  };
  const setMilestone = (i: number, patch: Partial<IterationMilestone>) =>
    setForm((f) => ({ ...f, milestones: f.milestones.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const localError = iterationFormError(form);
  const touched = !!(form.name || form.startDate || form.endDate);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{iteration ? `编辑「${iteration.name}」` : '新建迭代'}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {!iteration && (
            <div className="flex flex-col gap-1.5">
              <Label>所属</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger aria-label="所属">
                  <SelectValue placeholder="选择产品" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}（常规迭代）
                    </SelectItem>
                  ))}
                  {allowSpecial && <SelectItem value={SPECIAL}>专项（跨产品）</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="it-name">名称</Label>
            <Input id="it-name" value={form.name} maxLength={50} autoFocus onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="flex gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="it-start">开始日期</Label>
              <Input id="it-start" type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="it-end">结束日期</Label>
              <Input id="it-end" type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
            </div>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">里程碑</legend>
            {form.milestones.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label={`里程碑 ${i + 1} 名称`} className="h-8 w-40" maxLength={20} value={m.label} onChange={(e) => setMilestone(i, { label: e.target.value })} />
                <Input aria-label={`里程碑 ${i + 1} 日期`} type="date" className="h-8 w-40" value={m.date} onChange={(e) => setMilestone(i, { date: e.target.value })} />
                <Button type="button" variant="ghost" size="sm" onClick={() => setForm((f) => ({ ...f, milestones: f.milestones.filter((_, j) => j !== i) }))}>
                  删除
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setForm((f) => ({ ...f, milestones: [...f.milestones, { label: '', date: '' }] }))}
            >
              添加里程碑
            </Button>
          </fieldset>
          {touched && localError && <p className="text-xs text-muted-foreground">{localError}</p>}
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              取消
            </Button>
            <Button type="submit" disabled={!!localError || (!iteration && !scope) || save.isPending}>
              {iteration ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: 列表页**

`apps/web/src/app/(app)/[org]/iterations/page.tsx`：

```tsx
'use client';

import { CalendarRange } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { groupIterations } from '@/features/iterations/model';
import { isOrgAdminRole } from '@/features/shell/nav';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import { useIterations, useOrg, useProducts } from '@/lib/queries';
import type { Iteration } from '@/lib/types';
import { IterationDialog } from './iteration-dialog';

export default function IterationsPage() {
  const { org } = useParams<{ org: string }>();
  const orgQ = useOrg(org);
  const products = useProducts(org);
  const q = useIterations(org);
  const [dialog, setDialog] = useState<{ open: boolean; iteration: Iteration | null }>({ open: false, iteration: null });
  const orgAdmin = !!orgQ.data && isOrgAdminRole(orgQ.data.me.orgRole);
  const adminProducts = (products.data ?? []).filter((p) => p.myRole === 'admin');
  const canCreate = orgAdmin || adminProducts.length > 0;

  if (q.isError) {
    return (
      <>
        <PageHeader title="迭代" />
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <p className="text-muted-foreground">加载迭代失败，请重试。</p>
          <Button variant="outline" onClick={() => q.refetch()}>
            重试
          </Button>
        </div>
      </>
    );
  }

  const groups = groupIterations(q.data ?? []);
  return (
    <>
      <PageHeader
        title="迭代"
        description="常规迭代属于产品，同一产品内时间不重叠；专项属于组织，可以跨产品。"
        actions={canCreate && <Button onClick={() => setDialog({ open: true, iteration: null })}>新建迭代</Button>}
      />
      {!q.data ? (
        <Skeleton className="h-40" />
      ) : groups.length === 0 ? (
        <EmptyState icon={CalendarRange} title="还没有迭代" description={canCreate ? '点击「新建迭代」创建第一个迭代。' : '产品管理员创建迭代后会显示在这里。'} />
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-label={g.title} className="flex flex-col gap-2">
            <h2 className="font-semibold">{g.title}</h2>
            <div className="overflow-hidden rounded-md border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead className="w-56">日期</TableHead>
                    <TableHead className="w-24">状态</TableHead>
                    <TableHead className="w-20 text-right">需求</TableHead>
                    <TableHead className="w-20 text-right">已完成</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.iterations.map((it) => (
                    <TableRow key={it.id} className="h-10 even:bg-zebra">
                      <TableCell>
                        <Link className="font-medium hover:underline" href={`/${org}/iterations/${it.id}`}>
                          {it.name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-[13px]">
                        {it.startDate} ~ {it.endDate}
                      </TableCell>
                      <TableCell className="text-[13px]">{ITERATION_STATUS_LABEL[it.status]}</TableCell>
                      <TableCell className="text-right font-mono">{it.requirementCount}</TableCell>
                      <TableCell className="text-right font-mono">{it.doneCount}</TableCell>
                      <TableCell className="text-right">
                        {it.canManage && (it.status === 'planning' || it.status === 'active') && (
                          <Button variant="ghost" size="sm" aria-label={`编辑 ${it.name}`} onClick={() => setDialog({ open: true, iteration: it })}>
                            编辑
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        ))
      )}
      <IterationDialog
        org={org}
        open={dialog.open}
        iteration={dialog.iteration}
        products={adminProducts}
        allowSpecial={orgAdmin}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
      />
    </>
  );
}
```

- [ ] **Step 7: 端到端测试**

`apps/web/e2e/iterations.spec.ts`：

```ts
import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function ok(pending: Promise<APIResponse>): Promise<APIResponse> {
  const res = await pending;
  expect(res.ok(), `${res.url()} → ${res.status()}`).toBeTruthy();
  return res;
}

async function createProduct(request: APIRequestContext): Promise<string> {
  const res = await ok(request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } }));
  return (await res.json()).product.id as string;
}

test('迭代列表：新建常规迭代与专项，时间重叠时提示，编辑名称', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  await page.getByRole('link', { name: '迭代', exact: true }).click();
  await expect(page).toHaveURL(/\/acme\/iterations$/);
  await expect(page.getByText('还没有迭代')).toBeVisible();

  await page.getByRole('button', { name: '新建迭代' }).click();
  await page.getByLabel('名称', { exact: true }).fill('迭代0701');
  await page.getByLabel('开始日期').fill('2026-07-01');
  await page.getByLabel('结束日期').fill('2026-07-15');
  await page.getByRole('button', { name: '添加里程碑' }).click();
  await page.getByLabel('里程碑 1 名称').fill('发布');
  await page.getByLabel('里程碑 1 日期').fill('2026-07-15');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建迭代')).toBeVisible();
  const pan = page.getByRole('region', { name: '网盘' });
  await expect(pan.getByRole('link', { name: '迭代0701' })).toBeVisible();

  await page.getByRole('button', { name: '新建迭代' }).click();
  await page.getByLabel('名称', { exact: true }).fill('重叠的迭代');
  await page.getByLabel('开始日期').fill('2026-07-10');
  await page.getByLabel('结束日期').fill('2026-07-20');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '与已有迭代时间重叠' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();

  await page.getByRole('button', { name: '新建迭代' }).click();
  await page.getByRole('combobox', { name: '所属' }).click();
  await page.getByRole('option', { name: '专项（跨产品）' }).click();
  await page.getByLabel('名称', { exact: true }).fill('专业空间优化');
  await page.getByLabel('开始日期').fill('2026-07-01');
  await page.getByLabel('结束日期').fill('2026-09-30');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('region', { name: '专项' }).getByRole('link', { name: '专业空间优化' })).toBeVisible();

  await pan.getByRole('button', { name: '编辑 迭代0701' }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('迭代0701');
  await expect(page.getByLabel('里程碑 1 名称')).toHaveValue('发布');
  await page.getByLabel('名称', { exact: true }).fill('迭代0701-改');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(pan.getByRole('link', { name: '迭代0701-改' })).toBeVisible();
});

test('迭代列表：加载失败显示重试', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.route('**/api/v1/orgs/acme/iterations', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '服务器错误' } }) }),
  );
  await page.goto('/acme/iterations');
  await expect(page.getByText('加载迭代失败，请重试。')).toBeVisible();
  await page.unroute('**/api/v1/orgs/acme/iterations');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('还没有迭代')).toBeVisible();
});
```

- [ ] **Step 8: 运行测试与检查**

Run:
- `pnpm --filter @flower/web exec vitest run src/features/iterations/model.test.ts src/features/shell/nav.test.ts`
- `pnpm --filter @flower/web test`
- `pnpm typecheck`
- `pnpm --filter @flower/web lint --max-warnings 0`
- `pnpm --filter @flower/web e2e iterations.spec.ts requirements.spec.ts`（后台运行并写日志；3100 端口，不要同时运行 `pnpm dev`）

Expected: 全部通过，lint 零错误零警告。需求列表页的迭代筛选仍可用（`requirements.spec.ts` 通过）。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/features/shell apps/web/src/features/iterations apps/web/src/lib/types.ts apps/web/src/lib/queries.ts "apps/web/src/app/(app)/[org]/iterations" apps/web/e2e/iterations.spec.ts
git commit -m "feat(web): 迭代列表页、新建与编辑迭代，启用迭代导航"
```

---
### Task 8: 迭代详情页：状态操作、里程碑、需求页签（添加需求与强制加入）、范围对比

**Files:**
- Modify: `apps/web/src/features/iterations/model.ts`、`model.test.ts`（`STATUS_ACTIONS`、`commitmentRate`）
- Modify: `apps/web/src/lib/api.ts`、`api.test.ts`（`unmetFrom`）
- Modify: `apps/web/src/components/form-error.tsx`（显示 `details.unmet`）
- Create: `apps/web/src/components/force-join-dialog.tsx`
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`
- Create: `apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/iterations/[id]/requirements-tab.tsx`
- Create: `apps/web/src/app/(app)/[org]/iterations/[id]/scope-tab.tsx`
- Modify: `apps/web/e2e/iterations.spec.ts`

**Interfaces:**
- Consumes: Task 6 的 `GET /orgs/:org/iterations/:id`、`POST …/status`、`DELETE …`、`GET …/scope`、`PUT /orgs/:org/requirements/:id/iteration`；Task 7 的 `iterationKeys`、`qk.iterationList`、`localToday`、`milestoneTimeline`；`useRequirements`、`useProducts`、`requirementKeys`
- Produces（`lib/api.ts`）：`unmetFrom(details: unknown): string[]`
- Produces（`features/iterations/model.ts`）：
  - `STATUS_ACTIONS: Record<Iteration['status'], Array<{ to: Iteration['status']; label: string; confirm: string }>>`
  - `commitmentRate(scope: { committedDone: unknown[]; committedOpen: unknown[]; removed: unknown[] }): number | null`（百分比取整；承诺范围为空时返回 `null`）
- Produces（`components/force-join-dialog.tsx`）：`type ForceJoinTarget = { requirementId: string; requirementLabel: string; iterationId: string; iterationName: string; unmet: string[] }`；`ForceJoinDialog({ org, target, onClose })`
- Produces（`lib/types.ts`）：`IterationDetail = Jsonify<CoreIterationDetail>`、`IterationScope = Jsonify<CoreIterationScope>`
- Produces（`lib/queries.ts`）：`qk.iteration(o, id)`、`qk.iterationScope(o, id)`、`useIteration(o, id)`、`useIterationScope(o, id)`
- Produces（页面）：`/[org]/iterations/[id]`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/iterations/model.test.ts` 的 import 改为 `import { commitmentRate, groupIterations, iterationFormError, localToday, milestoneTimeline, STATUS_ACTIONS } from './model';`，文件末尾追加：

```ts
describe('迭代状态操作与承诺完成率', () => {
  it('只有规划中和进行中有状态操作', () => {
    expect(STATUS_ACTIONS.planning.map((a) => [a.to, a.label])).toEqual([
      ['active', '开始迭代'],
      ['canceled', '取消迭代'],
    ]);
    expect(STATUS_ACTIONS.active.map((a) => a.to)).toEqual(['done', 'canceled']);
    expect(STATUS_ACTIONS.done).toEqual([]);
    expect(STATUS_ACTIONS.canceled).toEqual([]);
  });

  it('承诺完成率 = 承诺内已完成 / 承诺总数（含中途移出）', () => {
    expect(commitmentRate({ committedDone: [1, 2], committedOpen: [3], removed: [4] })).toBe(50);
    expect(commitmentRate({ committedDone: [1], committedOpen: [2, 3], removed: [] })).toBe(33);
    expect(commitmentRate({ committedDone: [], committedOpen: [], removed: [] })).toBeNull();
  });
});
```

`apps/web/src/lib/api.test.ts` 的 import 改为 `import { ApiError, api, unmetFrom } from './api';`，文件末尾追加：

```ts
describe('unmetFrom', () => {
  it('从错误详情中取出未满足的条件，其他形状返回空数组', () => {
    expect(unmetFrom({ unmet: ['「可行性」需为通过（当前：未开始）', 1] })).toEqual(['「可行性」需为通过（当前：未开始）']);
    expect(unmetFrom([{ path: 'x', message: 'y' }])).toEqual([]);
    expect(unmetFrom(null)).toEqual([]);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/iterations/model.test.ts src/lib/api.test.ts`
Expected: FAIL，`STATUS_ACTIONS`、`commitmentRate`、`unmetFrom` 未导出。

- [ ] **Step 2: 实现模型与工具函数**

`apps/web/src/features/iterations/model.ts` 末尾追加：

```ts
const CANCEL_CONFIRM = '取消后不能恢复，也不能再加入需求。';

export const STATUS_ACTIONS: Record<Iteration['status'], Array<{ to: Iteration['status']; label: string; confirm: string }>> = {
  planning: [
    { to: 'active', label: '开始迭代', confirm: '开始后会锁定基线结束日期，并把当前迭代中的需求记为承诺范围。' },
    { to: 'canceled', label: '取消迭代', confirm: CANCEL_CONFIRM },
  ],
  active: [
    { to: 'done', label: '完成迭代', confirm: '完成后不能再修改迭代，也不能再加入需求。' },
    { to: 'canceled', label: '取消迭代', confirm: CANCEL_CONFIRM },
  ],
  done: [],
  canceled: [],
};

/** 承诺完成率（%）：承诺内已完成 ÷ 承诺总数；中途移出的也算在承诺总数里。 */
export function commitmentRate(scope: { committedDone: unknown[]; committedOpen: unknown[]; removed: unknown[] }): number | null {
  const total = scope.committedDone.length + scope.committedOpen.length + scope.removed.length;
  return total === 0 ? null : Math.round((scope.committedDone.length / total) * 100);
}
```

`apps/web/src/lib/api.ts` 末尾追加：

```ts
/** 「条件未满足」类错误的 details.unmet；其他形状返回空数组。 */
export function unmetFrom(details: unknown): string[] {
  const list = (details as { unmet?: unknown } | null)?.unmet;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}
```

`apps/web/src/components/form-error.tsx` 改为：

```tsx
import { type ApiError, unmetFrom } from '@/lib/api';

export function FormError({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null;
  const details = Array.isArray(error.details) ? (error.details as Array<{ path?: string; message?: string }>) : [];
  const unmet = unmetFrom(error.details);
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
      {unmet.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {unmet.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 类型与查询**

`apps/web/src/lib/types.ts`：type import 加入 `IterationDetail as CoreIterationDetail`、`IterationScope as CoreIterationScope`，末尾追加：

```ts
export type IterationDetail = Jsonify<CoreIterationDetail>;
export type IterationScope = Jsonify<CoreIterationScope>;
```

`apps/web/src/lib/queries.ts`：types import 加入 `IterationDetail`、`IterationScope`；`qk` 加入：

```ts
  iteration: (o: string, id: string) => ['org', o, 'iterations', 'detail', id] as const,
  iterationScope: (o: string, id: string) => ['org', o, 'iterations', 'scope', id] as const,
```

在 `useIterations` 之后加入：

```ts
export const useIteration = (o: string, id: string) =>
  useQuery({ queryKey: qk.iteration(o, id), queryFn: () => api<{ iteration: IterationDetail }>(`/orgs/${o}/iterations/${id}`), select: (d) => d.iteration });
export const useIterationScope = (o: string, id: string) =>
  useQuery({ queryKey: qk.iterationScope(o, id), queryFn: () => api<{ scope: IterationScope }>(`/orgs/${o}/iterations/${id}/scope`), select: (d) => d.scope });
```

- [ ] **Step 4: 强制加入对话框**

`apps/web/src/components/force-join-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { iterationKeys, requirementKeys, useApiMutation } from '@/lib/queries';

export type ForceJoinTarget = { requirementId: string; requirementLabel: string; iterationId: string; iterationName: string; unmet: string[] };

/** 产品管理员跳过加入迭代的准入条件；原因写入审计事件。 */
export function ForceJoinDialog({ org, target, onClose }: { org: string; target: ForceJoinTarget | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const force = useApiMutation(
    (t: ForceJoinTarget) => api(`/orgs/${org}/requirements/${t.requirementId}/iteration`, { method: 'PUT', body: { iterationId: t.iterationId, force: true, reason } }),
    {
      invalidate: [iterationKeys(org), requirementKeys(org)],
      silentError: true,
      success: '已强制加入迭代',
      onSuccess: () => {
        setReason('');
        onClose();
      },
    },
  );
  const close = () => {
    setReason('');
    force.reset();
    onClose();
  };
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>强制加入「{target?.iterationName}」</DialogTitle>
        </DialogHeader>
        <p className="text-[13px] text-muted-foreground">{target?.requirementLabel} 未满足加入迭代的条件：</p>
        <ul className="pl-1 text-[13px] text-muted-foreground">
          {target?.unmet.map((m, i) => (
            <li key={i}>· {m}</li>
          ))}
        </ul>
        <p className="text-[13px] text-muted-foreground">强制加入会跳过这些条件，原因会记入审计记录。</p>
        <Textarea aria-label="原因" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        <FormError error={force.error} />
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <Button disabled={!reason.trim() || force.isPending} onClick={() => target && force.mutate(target)}>
            确认加入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: 需求页签**

`apps/web/src/app/(app)/[org]/iterations/[id]/requirements-tab.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { ForceJoinDialog } from '@/components/force-join-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, unmetFrom } from '@/lib/api';
import { iterationKeys, requirementKeys, useApiMutation, useProducts, useRequirements } from '@/lib/queries';
import type { IterationDetail, RequirementListItem } from '@/lib/types';

export function RequirementsTab({ org, iteration: it }: { org: string; iteration: IterationDetail }) {
  const products = useProducts(org);
  const editable = (products.data ?? []).filter((p) => p.myRole !== 'viewer' && (!it.product || p.id === it.product.id));
  const joinable = it.status === 'planning' || it.status === 'active';
  const [productId, setProductId] = useState('');
  const picked = editable.find((p) => p.id === productId) ?? editable[0];
  const [q, setQ] = useState('');
  const term = q.trim();
  const search = useRequirements(org, joinable && term ? picked?.id : undefined, `q=${encodeURIComponent(term)}&pageSize=8&sort=updated`);
  const [forcing, setForcing] = useState<RequirementListItem | null>(null);
  const invalidate = [iterationKeys(org), requirementKeys(org)];
  const join = useApiMutation(
    (r: RequirementListItem) => api(`/orgs/${org}/requirements/${r.id}/iteration`, { method: 'PUT', body: { iterationId: it.id } }),
    { invalidate, silentError: true, success: '已加入迭代', onSuccess: () => setQ('') },
  );
  const leave = useApiMutation((requirementId: string) => api(`/orgs/${org}/requirements/${requirementId}/iteration`, { method: 'PUT', body: { iterationId: null } }), {
    invalidate,
    success: '已移出迭代',
  });
  const failed = join.error?.code === 'precondition_failed' ? join.variables : undefined;
  const canForce = !!failed && (products.data ?? []).some((p) => p.id === failed.productId && p.myRole === 'admin');
  const listHref = it.product ? `/${org}/requirements?product=${it.product.key}&iteration=${it.id}` : null;

  return (
    <div className="flex flex-col gap-3">
      {joinable && editable.length > 0 && (
        <section aria-label="添加需求" className="flex flex-col gap-2 rounded-md border bg-card p-3">
          <div className="flex items-center gap-2">
            {!it.product && editable.length > 1 && (
              <Select value={picked?.id} onValueChange={setProductId}>
                <SelectTrigger className="h-8 w-36" aria-label="从产品添加">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {editable.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input aria-label="添加需求" placeholder="输入编号或标题搜索需求" className="h-8 max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {term && (
            <ul className="flex flex-col text-[13px]">
              {(search.data?.items ?? []).map((r) => (
                <li key={r.id} className="flex h-8 items-center gap-2">
                  <span className="font-mono text-muted-foreground">{r.displayKey}</span>
                  <span className="flex-1 truncate">{r.title}</span>
                  {r.iteration?.id === it.id ? (
                    <span className="text-muted-foreground">已在本迭代</span>
                  ) : (
                    <Button size="sm" variant="outline" aria-label={`加入 ${r.displayKey}`} disabled={join.isPending} onClick={() => join.mutate(r)}>
                      {r.iteration ? `从「${r.iteration.name}」移入` : '加入'}
                    </Button>
                  )}
                </li>
              ))}
              {search.data && search.data.items.length === 0 && <li className="text-muted-foreground">没有找到需求</li>}
            </ul>
          )}
          <FormError error={join.error} />
          {failed && canForce && (
            <Button size="sm" variant="outline" className="self-start" onClick={() => setForcing(failed)}>
              强制加入 {failed.displayKey}
            </Button>
          )}
        </section>
      )}
      <ForceJoinDialog
        org={org}
        target={
          forcing && { requirementId: forcing.id, requirementLabel: forcing.displayKey, iterationId: it.id, iterationName: it.name, unmet: unmetFrom(join.error?.details) }
        }
        onClose={() => {
          setForcing(null);
          join.reset();
        }}
      />
      {it.requirements.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">迭代中还没有需求</p>
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">编号</TableHead>
                <TableHead>标题</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-28">负责人</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {it.requirements.map((r) => (
                <TableRow key={r.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono text-[13px]">{r.displayKey}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Link className="truncate hover:underline" href={`/${org}/requirements/${r.displayKey}`}>
                        {r.title}
                      </Link>
                      {r.activeBlockers > 0 && (
                        <span data-testid="blocker-badge" title="未解除的阻塞项" className="inline-flex items-center gap-1 text-xs text-destructive">
                          <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
                          {r.activeBlockers}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-[13px]">
                      <span className="size-2 rounded-full" style={{ background: r.state.color }} aria-hidden="true" />
                      {r.state.label}
                    </span>
                  </TableCell>
                  <TableCell className="text-[13px]">{r.owner?.displayName ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    {r.canEdit && (
                      <Button variant="ghost" size="sm" aria-label={`移出 ${r.displayKey}`} disabled={leave.isPending} onClick={() => leave.mutate(r.id)}>
                        移出
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {listHref && (
        <Link className="self-start text-[13px] text-primary hover:underline" href={listHref}>
          在需求列表中筛选本迭代
        </Link>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 范围对比页签**

`apps/web/src/app/(app)/[org]/iterations/[id]/scope-tab.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { commitmentRate } from '@/features/iterations/model';
import { formatDate } from '@/features/requirements/format';
import { useIterationScope } from '@/lib/queries';
import type { IterationScope } from '@/lib/types';

type Item = IterationScope['addedLater'][number];

function Bucket({ org, title, items, note }: { org: string; title: string; items: Item[]; note?: (i: Item) => string }) {
  return (
    <section aria-label={title} className="rounded-md border bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold">
        {title}
        <span className="ml-2 font-mono text-muted-foreground">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">无</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-2">
              <Link className="font-mono hover:underline" href={`/${org}/requirements/${i.displayKey}`}>
                {i.displayKey}
              </Link>
              <span className="min-w-0 flex-1 truncate">{i.title}</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: i.state.color }} aria-hidden="true" />
                {i.state.label}
              </span>
              {note && <span className="text-muted-foreground">{note(i)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ScopeTab({ org, iterationId }: { org: string; iterationId: string }) {
  const q = useIterationScope(org, iterationId);
  if (q.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-muted-foreground">加载范围对比失败，请重试。</p>
        <Button variant="outline" onClick={() => q.refetch()}>
          重试
        </Button>
      </div>
    );
  }
  if (!q.data) return <Skeleton className="h-40" />;
  const s = q.data;
  if (!s.hasSnapshot) {
    return (
      <div className="flex flex-col gap-3">
        <p role="note" className="rounded-md border bg-muted px-3 py-2 text-[13px]">
          该迭代没有承诺范围记录（开始时迭代为空，或为迁移的历史数据），无法区分承诺内与中途加入。以下为当前范围。
        </p>
        <Bucket org={org} title="当前范围" items={s.addedLater} />
      </div>
    );
  }
  const rate = commitmentRate(s);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">
        承诺范围记录于 {s.snapshotAt ? formatDate(s.snapshotAt) : '—'}，承诺完成率 {rate === null ? '—' : `${rate}%`}。
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Bucket org={org} title="承诺内已完成" items={s.committedDone} />
        <Bucket org={org} title="承诺内未完成" items={s.committedOpen} />
        <Bucket org={org} title="中途加入" items={s.addedLater} />
        <Bucket org={org} title="中途移出" items={s.removed} note={(i) => (i.currentIteration ? `现在在「${i.currentIteration.name}」` : '未排期')} />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: 详情页**

`apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`：

```tsx
'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { localToday, milestoneTimeline, STATUS_ACTIONS } from '@/features/iterations/model';
import { ApiError, api } from '@/lib/api';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import { iterationKeys, qk, useApiMutation, useIteration } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { RequirementsTab } from './requirements-tab';
import { ScopeTab } from './scope-tab';

export default function IterationPage() {
  const { org, id } = useParams<{ org: string; id: string }>();
  const router = useRouter();
  const q = useIteration(org, id);
  const [today] = useState(localToday);
  const setStatus = useApiMutation((to: string) => api(`/orgs/${org}/iterations/${id}/status`, { method: 'POST', body: { to } }), {
    invalidate: [iterationKeys(org)],
    success: '已更新迭代状态',
  });
  const remove = useApiMutation(() => api(`/orgs/${org}/iterations/${id}`, { method: 'DELETE' }), {
    invalidate: [qk.iterationList(org)],
    success: '已删除迭代',
    onSuccess: () => router.push(`/${org}/iterations`),
  });

  if (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403)) return <NoAccess message="迭代不存在，或你没有查看它的权限。" />;
  if (q.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-muted-foreground">加载迭代失败，请重试。</p>
        <Button variant="outline" onClick={() => q.refetch()}>
          重试
        </Button>
      </div>
    );
  }
  if (!q.data) return <Skeleton className="h-64" />;
  const it = q.data;
  const timeline = milestoneTimeline(it.milestones, today);
  const started = it.status !== 'planning';

  return (
    <>
      <PageHeader
        crumbs={[{ label: '迭代', href: `/${org}/iterations` }, { label: it.name }]}
        title={it.name}
        description={
          <>
            {it.product ? it.product.name : '专项'} · <span className="font-mono">{it.startDate} ~ {it.endDate}</span>
            {it.baselineEndDate && it.baselineEndDate !== it.endDate && (
              <>
                {' '}
                · 基线结束 <span className="font-mono">{it.baselineEndDate}</span>
              </>
            )}{' '}
            · <span data-testid="iteration-status">{ITERATION_STATUS_LABEL[it.status]}</span>
          </>
        }
        actions={
          it.canManage && (
            <>
              {STATUS_ACTIONS[it.status].map((a) => (
                <ConfirmAction
                  key={a.to}
                  trigger={
                    <Button variant={a.to === 'canceled' ? 'outline' : 'default'} disabled={setStatus.isPending}>
                      {a.label}
                    </Button>
                  }
                  title={`${a.label}「${it.name}」？`}
                  description={a.confirm}
                  confirmLabel={a.label}
                  destructive={a.to === 'canceled'}
                  onConfirm={() => setStatus.mutate(a.to)}
                />
              ))}
              {it.status === 'planning' && it.requirementCount === 0 && (
                <ConfirmAction
                  trigger={<Button variant="ghost">删除</Button>}
                  title={`删除「${it.name}」？`}
                  description="只有规划中、没有需求和发布版本的迭代可以删除。"
                  confirmLabel="删除"
                  destructive
                  onConfirm={() => remove.mutate(undefined)}
                />
              )}
            </>
          )
        }
      />
      {timeline.length > 0 && (
        <ol aria-label="里程碑" className="flex flex-wrap gap-2">
          {timeline.map((m, i) => (
            <li key={i} className={cn('flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px]', m.past ? 'bg-muted text-muted-foreground' : 'bg-card')}>
              <span className={cn('size-2 rounded-full', m.past ? 'bg-muted-foreground/50' : 'bg-primary')} aria-hidden="true" />
              <span>{m.label}</span>
              <span className="font-mono">{m.date}</span>
              <span className="text-xs">{m.past ? '已过' : '未到'}</span>
            </li>
          ))}
        </ol>
      )}
      <Tabs defaultValue="requirements">
        <TabsList>
          <TabsTrigger value="requirements">需求（{it.requirementCount}）</TabsTrigger>
          {started && <TabsTrigger value="scope">范围对比</TabsTrigger>}
        </TabsList>
        <TabsContent value="requirements">
          <RequirementsTab org={org} iteration={it} />
        </TabsContent>
        {started && (
          <TabsContent value="scope">
            <ScopeTab org={org} iterationId={it.id} />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
```

- [ ] **Step 8: 端到端测试**

`apps/web/e2e/iterations.spec.ts` 末尾追加：

```ts
const GATED_WORKFLOW = {
  name: '准入流程',
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
    actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] }],
    checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
  },
};

/** 产品使用带「加入迭代需可行性通过」准入条件的流程；返回产品 id。 */
async function gatedProduct(request: APIRequestContext): Promise<string> {
  const productId = await createProduct(request);
  const wf = await ok(request.post('/api/v1/orgs/acme/workflows', { data: GATED_WORKFLOW }));
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId: (await wf.json()).version.id } }));
  return productId;
}

async function createRequirement(request: APIRequestContext, productId: string, title: string, feasible: boolean) {
  const r = (await (await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title } }))).json()).requirement;
  if (feasible) await ok(request.put(`/api/v1/orgs/acme/requirements/${r.id}/checks/feasibility`, { data: { state: 'passed' } }));
  return r as { id: string; displayKey: string };
}

test('迭代详情：添加需求、准入条件不满足时强制加入、开始迭代、移出、范围对比', async ({ page, request }) => {
  const productId = await gatedProduct(request);
  await createRequirement(request, productId, '文件夹加密', true);
  await createRequirement(request, productId, '回收站自动清理', false);
  await createRequirement(request, productId, '分享统计', true);
  const iteration = (
    await (
      await ok(
        request.post('/api/v1/orgs/acme/iterations', {
          data: {
            type: 'regular',
            productId,
            name: '迭代0801',
            startDate: '2026-08-01',
            endDate: '2026-08-14',
            milestones: [
              { label: '开发开始', date: '2020-01-01' },
              { label: '发布', date: '2099-12-31' },
            ],
          },
        }),
      )
    ).json()
  ).iteration;

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iteration.id}`);
  await expect(page.getByRole('heading', { name: '迭代0801' })).toBeVisible();
  const milestones = page.getByRole('list', { name: '里程碑' });
  await expect(milestones.getByRole('listitem').filter({ hasText: '开发开始' })).toContainText('已过');
  await expect(milestones.getByRole('listitem').filter({ hasText: '发布' })).toContainText('未到');

  const add = page.getByRole('textbox', { name: '添加需求' });
  await add.fill('PAN-1');
  await page.getByRole('button', { name: '加入 PAN-1' }).click();
  await expect(page.getByText('已加入迭代')).toBeVisible();
  await expect(page.getByRole('link', { name: '文件夹加密' })).toBeVisible();

  await add.fill('PAN-2');
  await page.getByRole('button', { name: '加入 PAN-2' }).click();
  const alert = page.getByRole('alert').filter({ hasText: '加入迭代的条件未满足' });
  await expect(alert).toContainText('「可行性」需为通过（当前：未开始）');
  await page.getByRole('button', { name: '强制加入 PAN-2' }).click();
  await page.getByLabel('原因').fill('线上问题必须本迭代处理');
  await page.getByRole('button', { name: '确认加入' }).click();
  await expect(page.getByText('已强制加入迭代')).toBeVisible();
  await expect(page.getByRole('link', { name: '回收站自动清理' })).toBeVisible();

  await page.getByRole('button', { name: '开始迭代' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '开始迭代' }).click();
  await expect(page.getByTestId('iteration-status')).toHaveText('进行中');

  await page.getByRole('button', { name: '移出 PAN-2' }).click();
  await expect(page.getByText('已移出迭代')).toBeVisible();
  await add.fill('PAN-3');
  await page.getByRole('button', { name: '加入 PAN-3' }).click();
  await expect(page.getByRole('link', { name: '分享统计' })).toBeVisible();

  await page.getByRole('tab', { name: '范围对比' }).click();
  await expect(page.getByRole('region', { name: '承诺内未完成' })).toContainText('文件夹加密');
  await expect(page.getByRole('region', { name: '中途加入' })).toContainText('分享统计');
  const removed = page.getByRole('region', { name: '中途移出' });
  await expect(removed).toContainText('回收站自动清理');
  await expect(removed).toContainText('未排期');
});

test('迭代详情：不存在时显示无权访问；加载失败（非 404）显示重试', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iteration = (
    await (await ok(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name: '迭代0901', startDate: '2026-09-01', endDate: '2026-09-14' } }))).json()
  ).iteration;
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/iterations/00000000-0000-0000-0000-000000000000');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();

  await page.route(`**/api/v1/orgs/acme/iterations/${iteration.id}`, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '服务器错误' } }) }),
  );
  await page.goto(`/acme/iterations/${iteration.id}`);
  await expect(page.getByText('加载迭代失败，请重试。')).toBeVisible();
  await page.unroute(`**/api/v1/orgs/acme/iterations/${iteration.id}`);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('heading', { name: '迭代0901' })).toBeVisible();
});
```

- [ ] **Step 9: 运行测试与检查**

Run:
- `pnpm --filter @flower/web exec vitest run src/features/iterations/model.test.ts src/lib/api.test.ts`
- `pnpm --filter @flower/web test`
- `pnpm typecheck`
- `pnpm --filter @flower/web lint --max-warnings 0`
- `pnpm --filter @flower/web e2e iterations.spec.ts requirements.spec.ts`（后台运行并写日志）

Expected: 全部通过。

- [ ] **Step 10: 提交**

```bash
git add apps/web/src/features/iterations apps/web/src/lib apps/web/src/components/form-error.tsx apps/web/src/components/force-join-dialog.tsx "apps/web/src/app/(app)/[org]/iterations/[id]" apps/web/e2e/iterations.spec.ts
git commit -m "feat(web): 迭代详情页：状态操作、里程碑、需求添加与强制加入、范围对比"
```

---
### Task 9: 发布版本界面：迭代详情「发布版本」页签，需求详情关联与解除

**Files:**
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`
- Create: `apps/web/src/app/(app)/[org]/iterations/[id]/release-dialog.tsx`
- Create: `apps/web/src/app/(app)/[org]/iterations/[id]/releases-tab.tsx`
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`（增加页签）
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/releases.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/side-lists.tsx`（移除只读的发布版本区块）
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`（右侧栏加入 `Releases`）
- Modify: `apps/web/e2e/iterations.spec.ts`

**Interfaces:**
- Consumes: Task 6 的发布版本接口；Task 8 的 `IterationDetail`、`iterationKeys`；`useFields`、`useProducts`、`requirementKeys`、`formatDate`
- Produces（`lib/types.ts`）：`Release = Jsonify<ReleaseView>`
- Produces（`lib/queries.ts`）：`releaseKeys(o) = ['org', o, 'releases']`；`qk.releases(o, query)`；`useReleases(o: string, query: string, enabled?: boolean)` → `Release[]`（`query` 为 `product=…` 或 `iteration=…`）
- Produces：`ReleaseDialog({ org, open, onOpenChange, iteration, release, products })`、`ReleasesTab({ org, iteration })`、`Releases({ org, requirement })`

- [ ] **Step 1: 写失败的端到端测试**

`apps/web/e2e/iterations.spec.ts` 末尾追加：

```ts
test('发布版本：在迭代详情新建、改计划日期（基线不变）、标记发布；在需求详情关联与解除', async ({ page, request }) => {
  const productId = await createProduct(request);
  const fields = (await (await ok(request.get('/api/v1/orgs/acme/fields'))).json()).fields;
  const platform = fields.find((f: { key: string }) => f.key === 'platform');
  await ok(request.post(`/api/v1/orgs/acme/fields/${platform.id}/options`, { data: { label: 'PC客户端' } }));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '分享链接加密码' } }));
  const iteration = (
    await (await ok(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' } }))).json()
  ).iteration;

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iteration.id}`);
  await page.getByRole('tab', { name: '发布版本' }).click();
  await page.getByRole('button', { name: '新建发布版本' }).click();
  await page.getByLabel('版本号').fill('3.2.0');
  await page.getByRole('combobox', { name: '平台' }).click();
  await page.getByRole('option', { name: 'PC客户端' }).click();
  await page.getByLabel('计划发布日期').fill('2026-08-14');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建发布版本')).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: '3.2.0' });
  await expect(row).toContainText('计划中');

  await row.getByRole('button', { name: '编辑 3.2.0' }).click();
  await page.getByLabel('计划发布日期').fill('2026-08-20');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(row).toContainText('2026-08-20');
  await expect(row).toContainText('2026-08-14');

  await row.getByRole('button', { name: '标记发布 3.2.0' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '标记发布' }).click();
  await expect(row).toContainText('已发布');

  await page.goto('/acme/requirements/PAN-1');
  const releases = page.getByRole('region', { name: '发布版本' });
  await expect(releases).toContainText('未关联');
  await releases.getByRole('combobox', { name: '关联发布版本' }).click();
  await page.getByRole('option', { name: /3\.2\.0/ }).click();
  await expect(page.getByText('已关联版本')).toBeVisible();
  await expect(releases).toContainText('3.2.0');
  await releases.getByRole('button', { name: '解除 3.2.0' }).click();
  await expect(releases).toContainText('未关联');
});
```

Run: `pnpm --filter @flower/web e2e iterations.spec.ts`（后台运行并写日志）
Expected: 新用例 FAIL，找不到「发布版本」页签。

- [ ] **Step 2: 类型与查询**

`apps/web/src/lib/types.ts`：type import 加入 `ReleaseView`，末尾追加：

```ts
export type Release = Jsonify<ReleaseView>;
```

`apps/web/src/lib/queries.ts`：types import 加入 `Release`；`qk` 加入：

```ts
  releases: (o: string, query: string) => ['org', o, 'releases', query] as const,
```

在 `useIterationScope` 之后加入：

```ts
/** 发布版本查询的公共前缀。 */
export const releaseKeys = (o: string) => ['org', o, 'releases'] as const;

export const useReleases = (o: string, query: string, enabled = true) =>
  useQuery({ queryKey: qk.releases(o, query), queryFn: () => api<{ releases: Release[] }>(`/orgs/${o}/releases?${query}`), select: (d) => d.releases, enabled });
```

- [ ] **Step 3: 发布版本对话框**

`apps/web/src/app/(app)/[org]/iterations/[id]/release-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { releaseKeys, requirementKeys, useApiMutation, useFields } from '@/lib/queries';
import type { IterationDetail, Product, Release } from '@/lib/types';

const NONE = '__none';
type Form = { productId: string; versionName: string; platformOptionId: string; plannedDate: string; notes: string };

export function ReleaseDialog({
  org,
  open,
  onOpenChange,
  iteration,
  release,
  products,
}: {
  org: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  iteration: IterationDetail;
  release: Release | null;
  products: Product[];
}) {
  const [form, setForm] = useState<Form>({ productId: '', versionName: '', platformOptionId: NONE, plannedDate: '', notes: '' });
  // 打开对话框（或换了要编辑的版本）时填表；在渲染期间调整，不用 effect
  const source = open ? release : undefined;
  const [synced, setSynced] = useState<Release | null | undefined>(undefined);
  if (source !== synced) {
    setSynced(source);
    if (source !== undefined) {
      setForm(
        source
          ? { productId: source.productId, versionName: source.versionName, platformOptionId: source.platform?.id ?? NONE, plannedDate: source.plannedDate ?? '', notes: source.notes ?? '' }
          : { productId: iteration.product?.id ?? products[0]?.id ?? '', versionName: '', platformOptionId: NONE, plannedDate: iteration.endDate, notes: '' },
      );
    }
  }
  const fields = useFields(org, form.productId || undefined);
  const platformOptions = (fields.data?.find((f) => f.key === 'platform')?.options ?? []).filter((o) => o.active || o.id === form.platformOptionId);
  const save = useApiMutation(
    () => {
      const body = {
        versionName: form.versionName,
        platformOptionId: form.platformOptionId === NONE ? null : form.platformOptionId,
        plannedDate: form.plannedDate,
        notes: form.notes.trim() || null,
      };
      if (release) return api(`/orgs/${org}/releases/${release.id}`, { method: 'PATCH', body });
      return api(`/orgs/${org}/releases`, { method: 'POST', body: { ...body, productId: form.productId, iterationId: iteration.id } });
    },
    {
      invalidate: [releaseKeys(org), requirementKeys(org)],
      silentError: true,
      success: release ? '已保存' : '已创建发布版本',
      onSuccess: () => onOpenChange(false),
    },
  );
  const close = () => {
    save.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{release ? `编辑「${release.versionName}」` : '新建发布版本'}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {!release && !iteration.product && (
            <div className="flex flex-col gap-1.5">
              <Label>产品</Label>
              <Select value={form.productId} onValueChange={(v) => setForm((f) => ({ ...f, productId: v, platformOptionId: NONE }))}>
                <SelectTrigger aria-label="产品">
                  <SelectValue placeholder="选择产品" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="rel-version">版本号</Label>
              <Input id="rel-version" className="font-mono" value={form.versionName} maxLength={50} autoFocus onChange={(e) => setForm((f) => ({ ...f, versionName: e.target.value }))} />
            </div>
            <div className="flex w-40 flex-col gap-1.5">
              <Label>平台</Label>
              <Select value={form.platformOptionId} onValueChange={(v) => setForm((f) => ({ ...f, platformOptionId: v }))}>
                <SelectTrigger aria-label="平台">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不区分平台</SelectItem>
                  {platformOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rel-date">计划发布日期</Label>
            <Input id="rel-date" type="date" className="w-44" value={form.plannedDate} onChange={(e) => setForm((f) => ({ ...f, plannedDate: e.target.value }))} />
            {release?.baselineDate && <span className="text-xs text-muted-foreground">基线日期 {release.baselineDate}，修改计划日期不会改变基线。</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rel-notes">说明</Label>
            <Textarea id="rel-notes" value={form.notes} maxLength={2000} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              取消
            </Button>
            <Button type="submit" disabled={!form.versionName.trim() || !form.plannedDate || !form.productId || save.isPending}>
              {release ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 发布版本页签**

`apps/web/src/app/(app)/[org]/iterations/[id]/releases-tab.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { releaseKeys, requirementKeys, useApiMutation, useProducts, useReleases } from '@/lib/queries';
import type { IterationDetail, Release } from '@/lib/types';
import { ReleaseDialog } from './release-dialog';

export function ReleasesTab({ org, iteration: it }: { org: string; iteration: IterationDetail }) {
  const products = useProducts(org);
  const editable = (products.data ?? []).filter((p) => p.myRole !== 'viewer' && (!it.product || p.id === it.product.id));
  const q = useReleases(org, `iteration=${it.id}`);
  const [dialog, setDialog] = useState<{ open: boolean; release: Release | null }>({ open: false, release: null });
  const markReleased = useApiMutation((id: string) => api(`/orgs/${org}/releases/${id}/released`, { method: 'POST' }), {
    invalidate: [releaseKeys(org), requirementKeys(org)],
    success: '已标记为已发布',
  });

  if (q.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-muted-foreground">加载发布版本失败，请重试。</p>
        <Button variant="outline" onClick={() => q.refetch()}>
          重试
        </Button>
      </div>
    );
  }
  if (!q.data) return <Skeleton className="h-32" />;
  return (
    <div className="flex flex-col gap-3">
      {editable.length > 0 && (
        <Button className="self-start" onClick={() => setDialog({ open: true, release: null })}>
          新建发布版本
        </Button>
      )}
      {q.data.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">还没有发布版本</p>
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>版本号</TableHead>
                {!it.product && <TableHead className="w-20">产品</TableHead>}
                <TableHead className="w-28">平台</TableHead>
                <TableHead className="w-28">计划日期</TableHead>
                <TableHead className="w-28">基线日期</TableHead>
                <TableHead className="w-32">状态</TableHead>
                <TableHead className="w-16 text-right">需求</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((r) => (
                <TableRow key={r.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono">{r.versionName}</TableCell>
                  {!it.product && <TableCell className="font-mono text-[13px]">{r.productKey}</TableCell>}
                  <TableCell className="text-[13px]">{r.platform?.label ?? '—'}</TableCell>
                  <TableCell className="font-mono text-[13px]">{r.plannedDate ?? '—'}</TableCell>
                  <TableCell className="font-mono text-[13px]">{r.baselineDate ?? '—'}</TableCell>
                  <TableCell className="text-[13px]">{r.status === 'released' ? `已发布 ${r.releasedAt ? formatDate(r.releasedAt) : ''}` : '计划中'}</TableCell>
                  <TableCell className="text-right font-mono">{r.requirementCount}</TableCell>
                  <TableCell className="text-right">
                    {r.canEdit && (
                      <>
                        <Button variant="ghost" size="sm" aria-label={`编辑 ${r.versionName}`} onClick={() => setDialog({ open: true, release: r })}>
                          编辑
                        </Button>
                        {r.status === 'planned' && (
                          <ConfirmAction
                            trigger={
                              <Button variant="ghost" size="sm" aria-label={`标记发布 ${r.versionName}`} disabled={markReleased.isPending}>
                                标记发布
                              </Button>
                            }
                            title={`标记「${r.versionName}」为已发布？`}
                            description="发布时间记为现在，之后不能撤回。"
                            confirmLabel="标记发布"
                            onConfirm={() => markReleased.mutate(r.id)}
                          />
                        )}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ReleaseDialog
        org={org}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        iteration={it}
        release={dialog.release}
        products={editable}
      />
    </div>
  );
}
```

`apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`：

1. import 加入 `import { ReleasesTab } from './releases-tab';`
2. `TabsList` 中 `范围对比` 之后加入 `<TabsTrigger value="releases">发布版本</TabsTrigger>`
3. `Tabs` 末尾（范围对比内容之后）加入：

```tsx
        <TabsContent value="releases">
          <ReleasesTab org={org} iteration={it} />
        </TabsContent>
```

- [ ] **Step 5: 需求详情的发布版本区块**

`apps/web/src/app/(app)/[org]/requirements/[key]/releases.tsx`：

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDate } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { releaseKeys, requirementKeys, useApiMutation, useReleases } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

export function Releases({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const all = useReleases(org, `product=${r.productId}`, canEdit);
  const invalidate = [requirementKeys(org), releaseKeys(org)];
  const link = useApiMutation((releaseId: string) => api(`/orgs/${org}/releases/${releaseId}/requirements/${r.id}`, { method: 'PUT' }), {
    invalidate,
    success: '已关联版本',
  });
  const unlink = useApiMutation((releaseId: string) => api(`/orgs/${org}/releases/${releaseId}/requirements/${r.id}`, { method: 'DELETE' }), {
    invalidate,
    success: '已解除关联',
  });
  if (!canEdit && r.releases.length === 0) return null;
  const candidates = (all.data ?? []).filter((x) => !r.releases.some((y) => y.id === x.id));
  return (
    <section className="rounded-md border bg-card p-4" aria-label="发布版本">
      <h2 className="mb-2 text-sm font-semibold">发布版本</h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {r.releases.map((x) => (
          <li key={x.id} className="flex items-center gap-1">
            <span className="min-w-0 flex-1">
              {x.platform?.label} <span className="font-mono">{x.versionName}</span>
              <span className="text-muted-foreground"> · {x.status === 'released' ? `已发布 ${x.releasedAt ? formatDate(x.releasedAt) : ''}` : '计划中'}</span>
            </span>
            {canEdit && (
              <Button variant="ghost" size="sm" aria-label={`解除 ${x.versionName}`} disabled={unlink.isPending} onClick={() => unlink.mutate(x.id)}>
                解除
              </Button>
            )}
          </li>
        ))}
        {r.releases.length === 0 && <li className="text-muted-foreground">未关联</li>}
      </ul>
      {canEdit && candidates.length > 0 && (
        <Select value="" onValueChange={(id) => link.mutate(id)}>
          <SelectTrigger className="mt-2 h-8" aria-label="关联发布版本">
            <SelectValue placeholder="关联发布版本…" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {[x.platform?.label, x.versionName, x.iteration && `（${x.iteration.name}）`].filter(Boolean).join(' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/requirements/[key]/side-lists.tsx`：删除 `{r.releases.length > 0 && ( <Block title="发布版本"> … </Block> )}` 整段，并删除因此不再使用的 `formatDate` import。

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：import 加入 `import { Releases } from './releases';`，右侧栏在 `<SideLists org={org} requirement={r} />` 之后加入 `<Releases org={org} requirement={r} />`。

- [ ] **Step 6: 运行测试与检查**

Run:
- `pnpm --filter @flower/web test`
- `pnpm typecheck`
- `pnpm --filter @flower/web lint --max-warnings 0`
- `pnpm --filter @flower/web e2e iterations.spec.ts requirements.spec.ts`（后台运行并写日志）

Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/lib "apps/web/src/app/(app)/[org]/iterations/[id]" "apps/web/src/app/(app)/[org]/requirements/[key]" apps/web/e2e/iterations.spec.ts
git commit -m "feat(web): 迭代详情发布版本页签；需求详情关联与解除发布版本"
```

---
### Task 10: 需求详情：迭代选择（准入原因、管理员强制加入），结构节点可选任意层级

**Files:**
- Create: `apps/web/src/features/structure/model.ts`、`model.test.ts`（`flattenTree`、`nodeOptions`）
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/iteration-field.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/fields-panel.tsx`
- Create: `apps/web/e2e/requirement-maintenance.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `RequirementDetail.joinIterationUnmet`；Task 6 的 `PUT /orgs/:org/requirements/:id/iteration`、`POST /orgs/:org/products/:id/nodes`、`PATCH /orgs/:org/nodes/:id`；Task 8 的 `ForceJoinDialog`、`ForceJoinTarget`、`unmetFrom`；Task 7 的 `iterationKeys`；`useProductIterations`、`useNodes`
- Produces（`features/structure/model.ts`）：
  - `flattenTree(nodes: StructureNode[]): StructureNode[]`（先序：同级按 `sort`、再按名称）
  - `nodeOptions(nodes: StructureNode[], currentId: string | null): Array<{ id: string; name: string; depth: number; deprecated: boolean }>`（隐藏已停用节点及其下级；当前选中的保留）
- Produces：`IterationField({ org, requirement })`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/structure/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { StructureNode } from '@/lib/types';
import { flattenTree, nodeOptions } from './model';

const n = (id: string, parentId: string | null, depth: number, sort: number, status: 'active' | 'deprecated' = 'active'): StructureNode => ({
  id,
  parentId,
  depth,
  name: id,
  description: null,
  status,
  sort,
});

const nodes = [n('存储', null, 1, 1), n('会员', null, 1, 0), n('续费', '会员', 2, 1), n('开通', '会员', 2, 0), n('自动续费', '续费', 3, 0)];

describe('结构树模型', () => {
  it('先序展开：同级按 sort 排序', () => {
    expect(flattenTree(nodes).map((x) => x.id)).toEqual(['会员', '开通', '续费', '自动续费', '存储']);
  });

  it('节点下拉隐藏已停用节点及其下级，当前选中的保留', () => {
    const withDeprecated = nodes.map((x) => (x.id === '续费' ? { ...x, status: 'deprecated' as const } : x));
    expect(nodeOptions(withDeprecated, null).map((x) => x.id)).toEqual(['会员', '开通', '存储']);
    expect(nodeOptions(withDeprecated, '自动续费').map((x) => [x.id, x.depth])).toEqual([
      ['会员', 1],
      ['开通', 2],
      ['自动续费', 3],
      ['存储', 1],
    ]);
    expect(nodeOptions(withDeprecated, '续费').find((x) => x.id === '续费')).toMatchObject({ deprecated: true });
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/structure/model.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现 `features/structure/model.ts`**

```ts
import type { StructureNode } from '@/lib/types';

/** 按树的先序排列：同级按 sort，再按名称。 */
export function flattenTree(nodes: StructureNode[]): StructureNode[] {
  const children = new Map<string | null, StructureNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-CN'));
  const out: StructureNode[] = [];
  const visit = (parentId: string | null) => {
    for (const node of children.get(parentId) ?? []) {
      out.push(node);
      visit(node.id);
    }
  };
  visit(null);
  return out;
}

/** 需求详情的节点下拉：隐藏已停用节点及其下级；当前选中的节点保留。 */
export function nodeOptions(nodes: StructureNode[], currentId: string | null): Array<{ id: string; name: string; depth: number; deprecated: boolean }> {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const hidden = (node: StructureNode): boolean => {
    if (node.status === 'deprecated') return true;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    return parent ? hidden(parent) : false;
  };
  return flattenTree(nodes)
    .filter((x) => x.id === currentId || !hidden(x))
    .map((x) => ({ id: x.id, name: x.name, depth: x.depth, deprecated: x.status === 'deprecated' }));
}
```

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/requirement-maintenance.spec.ts`：

```ts
import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function ok(pending: Promise<APIResponse>): Promise<APIResponse> {
  const res = await pending;
  expect(res.ok(), `${res.url()} → ${res.status()}`).toBeTruthy();
  return res;
}

async function json<T>(pending: Promise<APIResponse>): Promise<T> {
  return (await (await ok(pending)).json()) as T;
}

async function createProduct(request: APIRequestContext, name = '网盘', key = 'PAN'): Promise<string> {
  return (await json<{ product: { id: string } }>(request.post('/api/v1/orgs/acme/products', { data: { name, key } }))).product.id;
}

async function createRequirement(request: APIRequestContext, productId: string, title: string) {
  return (await json<{ requirement: { id: string; displayKey: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title } })))
    .requirement;
}

test('需求详情：加入迭代的条件未满足时显示原因，管理员强制加入；结构节点可选任意层级', async ({ page, request }) => {
  const productId = await createProduct(request);
  const wf = await json<{ version: { id: string } }>(
    request.post('/api/v1/orgs/acme/workflows', {
      data: {
        name: '准入流程',
        body: {
          states: [{ key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' }],
          initial: 'backlog',
          transitions: [{ from: '*', to: 'backlog', conditions: [] }],
          actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] }],
          checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
        },
      },
    }),
  );
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId: wf.version.id } }));
  await createRequirement(request, productId, '分享链接有效期');
  await ok(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' } }));
  const root = (await json<{ node: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/nodes`, { data: { name: '会员与支付' } }))).node;
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/nodes`, { data: { parentId: root.id, name: '续费' } }));
  const old = (await json<{ node: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/nodes`, { data: { name: '旧业务' } }))).node;
  await ok(request.patch(`/api/v1/orgs/acme/nodes/${old.id}`, { data: { status: 'deprecated' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-1');
  await expect(page.getByRole('list', { name: '加入迭代的条件' })).toContainText('「可行性」需为通过（当前：未开始）');

  await page.getByRole('combobox', { name: '迭代' }).click();
  await page.getByRole('option', { name: '迭代0801' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '加入迭代的条件未满足' })).toBeVisible();
  await page.getByRole('button', { name: '强制加入' }).click();
  await page.getByLabel('原因').fill('客户合同要求本迭代交付');
  await page.getByRole('button', { name: '确认加入' }).click();
  await expect(page.getByText('已强制加入迭代')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '迭代' })).toHaveText('迭代0801');

  await page.getByRole('combobox', { name: '结构节点' }).click();
  await expect(page.getByRole('option', { name: '旧业务' })).toHaveCount(0);
  await page.getByRole('option', { name: '续费' }).click();
  await expect(page.getByRole('combobox', { name: '结构节点' })).toHaveText('续费');

  await page.getByRole('combobox', { name: '迭代' }).click();
  await page.getByRole('option', { name: '未排期' }).click();
  await expect(page.getByRole('combobox', { name: '迭代' })).toHaveText('未排期');
});
```

Run: `pnpm --filter @flower/web e2e requirement-maintenance.spec.ts`（后台运行并写日志）
Expected: FAIL，找不到「加入迭代的条件」列表。

- [ ] **Step 4: 迭代字段组件**

`apps/web/src/app/(app)/[org]/requirements/[key]/iteration-field.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { type ForceJoinTarget, ForceJoinDialog } from '@/components/force-join-dialog';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, unmetFrom } from '@/lib/api';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import { iterationKeys, requirementKeys, useApiMutation, useProductIterations } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

const NONE = '__none';

export function IterationField({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const iterations = useProductIterations(org, r.productId);
  const [forcing, setForcing] = useState<ForceJoinTarget | null>(null);
  const set = useApiMutation(
    (iterationId: string | null) => api(`/orgs/${org}/requirements/${r.id}/iteration`, { method: 'PUT', body: { iterationId } }),
    { invalidate: [requirementKeys(org), iterationKeys(org)], silentError: true, success: '已更新迭代' },
  );
  if (r.myRole === 'viewer') return <>{r.iteration?.name ?? '未排期'}</>;
  const choices = (iterations.data ?? []).filter((i) => i.status === 'planning' || i.status === 'active' || i.id === r.iteration?.id);
  const failed = set.error?.code === 'precondition_failed' ? choices.find((i) => i.id === set.variables) : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Select value={r.iteration?.id ?? NONE} onValueChange={(v) => set.mutate(v === NONE ? null : v)}>
        <SelectTrigger className="h-8" aria-label="迭代">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>未排期</SelectItem>
          {choices.map((i) => (
            <SelectItem key={i.id} value={i.id}>
              {i.type === 'special' ? `专项：${i.name}` : i.name}
              {i.status !== 'planning' && i.status !== 'active' ? `（${ITERATION_STATUS_LABEL[i.status]}）` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!r.iteration && r.joinIterationUnmet.length > 0 && (
        <ul aria-label="加入迭代的条件" className="text-[12px] text-muted-foreground">
          {r.joinIterationUnmet.map((u, i) => (
            <li key={i}>· {u.message}</li>
          ))}
        </ul>
      )}
      <FormError error={set.error} />
      {failed && r.canForce && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => setForcing({ requirementId: r.id, requirementLabel: r.displayKey, iterationId: failed.id, iterationName: failed.name, unmet: unmetFrom(set.error?.details) })}
        >
          强制加入
        </Button>
      )}
      <ForceJoinDialog
        org={org}
        target={forcing}
        onClose={() => {
          setForcing(null);
          set.reset();
        }}
      />
    </div>
  );
}
```

- [ ] **Step 5: 属性面板改用新组件与任意层级节点**

`apps/web/src/app/(app)/[org]/requirements/[key]/fields-panel.tsx`：

1. import 加入：

```ts
import { nodeOptions } from '@/features/structure/model';
import { IterationField } from './iteration-field';
```

2. 删除 `const topNodes = (nodes.data ?? []).filter((n) => n.depth === 1);`，在同一位置写：

```ts
  const options = nodeOptions(nodes.data ?? [], r.node?.id ?? null);
```

3. 「业务域」整行替换为：

```tsx
      <Row label="结构节点">
        {canEdit && options.length > 0 ? (
          <Select value={r.node?.id ?? NONE} onValueChange={(v) => patch.mutate({ nodeId: v === NONE ? null : v })}>
            <SelectTrigger className="h-8" aria-label="结构节点">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不填</SelectItem>
              {options.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  <span style={{ paddingLeft: `${(n.depth - 1) * 12}px` }}>
                    {n.name}
                    {n.deprecated ? '（已停用）' : ''}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          (r.node?.name ?? '—')
        )}
      </Row>
```

4. 最后一行 `<Row label="迭代">{r.iteration?.name ?? '未排期'}</Row>` 替换为：

```tsx
      <Row label="迭代">
        <IterationField org={org} requirement={r} />
      </Row>
```

- [ ] **Step 6: 运行测试与检查**

Run:
- `pnpm --filter @flower/web exec vitest run src/features/structure/model.test.ts`
- `pnpm --filter @flower/web test`
- `pnpm typecheck`
- `pnpm --filter @flower/web lint --max-warnings 0`
- `pnpm --filter @flower/web e2e requirement-maintenance.spec.ts requirements.spec.ts`（后台运行并写日志）

Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/structure "apps/web/src/app/(app)/[org]/requirements/[key]" apps/web/e2e/requirement-maintenance.spec.ts
git commit -m "feat(web): 需求详情可选择迭代（显示准入原因、管理员强制加入），结构节点可选任意层级"
```

---
### Task 11: 需求详情：阻塞项新增与解除、关联需求搜索添加与删除；迭代需求页签标记阻塞

**Files:**
- Create: `apps/web/src/features/requirements/relations.ts`、`relations.test.ts`
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/blockers.tsx`
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/relations.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/side-lists.tsx`（移除只读的阻塞项、关联区块）
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`（主栏加入两个区块）
- Modify: `apps/web/src/lib/queries.ts`（`useRequirement` 增加 `enabled` 参数）
- Modify: `apps/web/src/lib/labels.ts`（删除不再使用的 `RELATION_LABEL`）
- Modify: `apps/web/e2e/requirement-maintenance.spec.ts`

**Interfaces:**
- Consumes: Task 4 的 `RequirementDetail.relations[].id`；Task 6 的阻塞项与关联接口；Task 7 的 `iterationKeys`；`useRequirements`、`useMembers`、`useOrg`、`formatDate`
- Produces（`features/requirements/relations.ts`）：
  - `RELATION_TYPE_OPTIONS: ReadonlyArray<{ type: RelationKind; label: string }>`；`type RelationKind = 'blocks' | 'duplicate_of' | 'merged_into' | 'derived_from' | 'related'`
  - `relationPhrase(type: string, direction: 'out' | 'in'): { before: string; after: string }`（读作 `before + 对方编号 + after`）
  - `parseRequirementKey(text: string): string | null`（完整编号返回大写形式）
- Produces（`lib/queries.ts`）：`useRequirement(o: string, key: string, enabled = true)`
- Produces：`Blockers({ org, requirement })`、`Relations({ org, requirement })`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/requirements/relations.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseRequirementKey, relationPhrase } from './relations';

describe('需求关联的读法', () => {
  it('有方向的关联在两端读法不同', () => {
    expect(relationPhrase('blocks', 'out')).toEqual({ before: '阻塞了', after: '' });
    expect(relationPhrase('blocks', 'in')).toEqual({ before: '被', after: '阻塞' });
    expect(relationPhrase('merged_into', 'out')).toEqual({ before: '已合并到', after: '' });
    expect(relationPhrase('merged_into', 'in')).toEqual({ before: '', after: '已合并到本需求' });
    expect(relationPhrase('duplicate_of', 'in')).toEqual({ before: '', after: '与本需求重复' });
    expect(relationPhrase('related', 'in')).toEqual({ before: '相关', after: '' });
    expect(relationPhrase('unknown', 'out')).toEqual({ before: 'unknown', after: '' });
  });

  it('完整编号识别为跨产品查找，其他输入按关键词搜索', () => {
    expect(parseRequirementKey(' doc-12 ')).toBe('DOC-12');
    expect(parseRequirementKey('PAN-3')).toBe('PAN-3');
    expect(parseRequirementKey('断点续传')).toBeNull();
    expect(parseRequirementKey('12')).toBeNull();
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/requirements/relations.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现 `features/requirements/relations.ts`**

```ts
export const RELATION_TYPE_OPTIONS = [
  { type: 'related', label: '相关' },
  { type: 'blocks', label: '阻塞' },
  { type: 'duplicate_of', label: '重复于' },
  { type: 'merged_into', label: '合并到' },
  { type: 'derived_from', label: '派生自' },
] as const;

export type RelationKind = (typeof RELATION_TYPE_OPTIONS)[number]['type'];

const PHRASES: Record<string, { out: [string, string]; in: [string, string] }> = {
  blocks: { out: ['阻塞了', ''], in: ['被', '阻塞'] },
  duplicate_of: { out: ['重复于', ''], in: ['', '与本需求重复'] },
  merged_into: { out: ['已合并到', ''], in: ['', '已合并到本需求'] },
  derived_from: { out: ['派生自', ''], in: ['', '由本需求派生'] },
  related: { out: ['相关', ''], in: ['相关', ''] },
};

/** 关联在当前需求上的读法：before + 对方编号 + after。 */
export function relationPhrase(type: string, direction: 'out' | 'in'): { before: string; after: string } {
  const p = PHRASES[type];
  if (!p) return { before: type, after: '' };
  const [before, after] = p[direction];
  return { before, after };
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,9}$/;

/** 输入是完整编号（如 doc-12）时返回大写编号，否则返回 null。 */
export function parseRequirementKey(text: string): string | null {
  const t = text.trim();
  return KEY_RE.test(t) ? t.toUpperCase() : null;
}
```

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/requirement-maintenance.spec.ts` 末尾追加：

```ts
test('需求详情：新增与解除阻塞项；迭代需求页签显示阻塞标记', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传断点续传');
  const iteration = (
    await json<{ iteration: { id: string } }>(
      request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' } }),
    )
  ).iteration;
  await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/iteration`, { data: { iterationId: iteration.id } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-1');
  const blockers = page.getByRole('region', { name: '阻塞项' });
  await blockers.getByLabel('新阻塞项').fill('等待存储接口');
  await blockers.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('已添加阻塞项')).toBeVisible();
  await expect(blockers).toContainText('等待存储接口');

  await page.goto(`/acme/iterations/${iteration.id}`);
  await expect(page.getByRole('row').filter({ hasText: '上传断点续传' }).getByTestId('blocker-badge')).toHaveText('1');

  await page.goto('/acme/requirements/PAN-1');
  await blockers.getByRole('button', { name: '解除：等待存储接口' }).click();
  await expect(page.getByText('已解除', { exact: true })).toBeVisible();
  await expect(blockers).toContainText('没有未解除的阻塞项');
  await expect(blockers.getByText('已解除 1 条')).toBeVisible();
});

test('需求详情：按编号或标题添加关联（含其他产品），显示方向，重复时提示，删除', async ({ page, request }) => {
  const pan = await createProduct(request);
  await createRequirement(request, pan, '上传断点续传');
  await createRequirement(request, pan, '下载断点续传');
  const doc = await createProduct(request, '文档', 'DOC');
  await createRequirement(request, doc, '文档导出');

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-1');
  const relations = page.getByRole('region', { name: '关联需求' });
  await relations.getByRole('combobox', { name: '关联类型' }).click();
  await page.getByRole('option', { name: '阻塞' }).click();
  await relations.getByLabel('搜索要关联的需求').fill('下载');
  await relations.getByRole('button', { name: '关联 PAN-2' }).click();
  await expect(page.getByText('已添加关联')).toBeVisible();
  await expect(relations).toContainText('阻塞了 PAN-2');

  await relations.getByRole('combobox', { name: '关联类型' }).click();
  await page.getByRole('option', { name: '相关' }).click();
  await relations.getByLabel('搜索要关联的需求').fill('doc-1');
  await relations.getByRole('button', { name: '关联 DOC-1' }).click();
  await expect(relations).toContainText('DOC-1');

  await relations.getByLabel('搜索要关联的需求').fill('DOC-1');
  await relations.getByRole('button', { name: '关联 DOC-1' }).click();
  await expect(relations.getByRole('alert').filter({ hasText: '已存在相同的关联' })).toBeVisible();

  await page.goto('/acme/requirements/PAN-2');
  await expect(page.getByRole('region', { name: '关联需求' })).toContainText('被 PAN-1 阻塞');

  await page.goto('/acme/requirements/PAN-1');
  await relations.getByRole('button', { name: '删除与 PAN-2 的关联' }).click();
  await expect(page.getByText('已删除关联')).toBeVisible();
  await expect(relations).not.toContainText('PAN-2');
});
```

Run: `pnpm --filter @flower/web e2e requirement-maintenance.spec.ts`（后台运行并写日志）
Expected: 新用例 FAIL，找不到「新阻塞项」输入框。

- [ ] **Step 4: `useRequirement` 支持按需启用**

`apps/web/src/lib/queries.ts` 中 `useRequirement` 改为：

```ts
export const useRequirement = (o: string, key: string, enabled = true) =>
  useQuery({
    queryKey: qk.requirement(o, key),
    queryFn: () => api<{ requirement: RequirementDetail }>(`/orgs/${o}/requirements/${encodeURIComponent(key)}`),
    select: (d) => d.requirement,
    enabled,
  });
```

- [ ] **Step 5: 阻塞项区块**

`apps/web/src/app/(app)/[org]/requirements/[key]/blockers.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDate } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { iterationKeys, requirementKeys, useApiMutation, useMembers, useOrg } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

const NONE = '__none';

export function Blockers({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const orgQ = useOrg(org);
  const canListMembers = !!orgQ.data && orgQ.data.me.orgRole !== 'guest';
  const members = useMembers(org, canEdit && canListMembers);
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState(NONE);
  const invalidate = [requirementKeys(org), iterationKeys(org)];
  const add = useApiMutation(
    () => api(`/orgs/${org}/requirements/${r.id}/blockers`, { method: 'POST', body: { description, ownerMemberId: owner === NONE ? null : owner } }),
    {
      invalidate,
      silentError: true,
      success: '已添加阻塞项',
      onSuccess: () => {
        setDescription('');
        setOwner(NONE);
      },
    },
  );
  const resolve = useApiMutation((id: string) => api(`/orgs/${org}/blockers/${id}/resolve`, { method: 'POST' }), { invalidate, success: '已解除' });
  if (!canEdit && r.blockers.length === 0) return null;
  const active = r.blockers.filter((b) => b.status === 'active');
  const resolved = r.blockers.filter((b) => b.status === 'resolved');
  const people = (members.data ?? []).filter((m) => m.status === 'active' && m.kind === 'human');

  return (
    <section className="rounded-md border bg-card p-4" aria-label="阻塞项">
      <h2 className="mb-2 text-sm font-semibold">
        阻塞项
        {active.length > 0 && <span className="ml-2 font-mono text-destructive">{active.length}</span>}
      </h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {active.map((b) => (
          <li key={b.id} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {b.description}
              <span className="text-muted-foreground">
                {b.owner && ` · ${b.owner.displayName}`} · {formatDate(b.createdAt)}
              </span>
            </span>
            {canEdit && (
              <Button variant="ghost" size="sm" aria-label={`解除：${b.description}`} disabled={resolve.isPending} onClick={() => resolve.mutate(b.id)}>
                解除
              </Button>
            )}
          </li>
        ))}
        {active.length === 0 && <li className="text-muted-foreground">没有未解除的阻塞项</li>}
      </ul>
      {resolved.length > 0 && (
        <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer text-muted-foreground">已解除 {resolved.length} 条</summary>
          <ul className="mt-1 flex flex-col gap-1 pl-4 text-muted-foreground">
            {resolved.map((b) => (
              <li key={b.id}>
                <span className="line-through">{b.description}</span>
                {b.resolvedAt && ` · ${formatDate(b.resolvedAt)} 解除`}
              </li>
            ))}
          </ul>
        </details>
      )}
      {canEdit && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined);
          }}
        >
          <Input aria-label="新阻塞项" placeholder="描述阻塞原因" className="h-8" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
          {people.length > 0 && (
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger className="h-8 w-32" aria-label="阻塞项负责人">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>无负责人</SelectItem>
                {people.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button type="submit" size="sm" variant="outline" disabled={!description.trim() || add.isPending}>
            添加
          </Button>
        </form>
      )}
      <FormError error={add.error} />
    </section>
  );
}
```

- [ ] **Step 6: 关联需求区块**

`apps/web/src/app/(app)/[org]/requirements/[key]/relations.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { parseRequirementKey, RELATION_TYPE_OPTIONS, type RelationKind, relationPhrase } from '@/features/requirements/relations';
import { api } from '@/lib/api';
import { requirementKeys, useApiMutation, useRequirement, useRequirements } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

export function Relations({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const [type, setType] = useState<RelationKind>('related');
  const [text, setText] = useState('');
  const term = text.trim();
  const key = parseRequirementKey(term);
  const crossKey = key && !key.startsWith(`${r.productKey}-`) ? key : null;
  const sameProduct = useRequirements(org, canEdit && term && !crossKey ? r.productId : undefined, `q=${encodeURIComponent(term)}&pageSize=8&sort=updated`);
  const other = useRequirement(org, crossKey ?? '', canEdit && !!crossKey);
  const invalidate = [requirementKeys(org)];
  const add = useApiMutation((toId: string) => api(`/orgs/${org}/requirements/${r.id}/relations`, { method: 'POST', body: { toId, type } }), {
    invalidate,
    silentError: true,
    success: '已添加关联',
    onSuccess: () => setText(''),
  });
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/relations/${id}`, { method: 'DELETE' }), { invalidate, success: '已删除关联' });
  if (!canEdit && r.relations.length === 0) return null;
  const candidates = (
    crossKey
      ? other.data
        ? [{ id: other.data.id, displayKey: other.data.displayKey, title: other.data.title }]
        : []
      : (sameProduct.data?.items ?? []).map((x) => ({ id: x.id, displayKey: x.displayKey, title: x.title }))
  ).filter((c) => c.id !== r.id);

  return (
    <section className="rounded-md border bg-card p-4" aria-label="关联需求">
      <h2 className="mb-2 text-sm font-semibold">关联需求</h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {r.relations.map((x) => {
          const p = relationPhrase(x.type, x.direction);
          return (
            <li key={x.id} className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate">
                {p.before && <span className="text-muted-foreground">{p.before} </span>}
                <Link className="font-mono hover:underline" href={`/${org}/requirements/${x.other.displayKey}`}>
                  {x.other.displayKey}
                </Link>
                {p.after && <span className="text-muted-foreground"> {p.after}</span>} {x.other.title}
              </span>
              {canEdit && (
                <Button variant="ghost" size="sm" aria-label={`删除与 ${x.other.displayKey} 的关联`} disabled={remove.isPending} onClick={() => remove.mutate(x.id)}>
                  删除
                </Button>
              )}
            </li>
          );
        })}
        {r.relations.length === 0 && <li className="text-muted-foreground">暂无</li>}
      </ul>
      {canEdit && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <Select value={type} onValueChange={(v) => setType(v as RelationKind)}>
              <SelectTrigger className="h-8 w-28" aria-label="关联类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RELATION_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.type} value={o.type}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="搜索要关联的需求"
              placeholder="本产品输入编号或标题；其他产品输入完整编号"
              className="h-8"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {term && (
            <ul className="flex flex-col text-[13px]">
              {candidates.map((c) => (
                <li key={c.id} className="flex h-8 items-center gap-2">
                  <span className="font-mono text-muted-foreground">{c.displayKey}</span>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <Button size="sm" variant="outline" aria-label={`关联 ${c.displayKey}`} disabled={add.isPending} onClick={() => add.mutate(c.id)}>
                    关联
                  </Button>
                </li>
              ))}
              {crossKey && other.isError && <li className="text-muted-foreground">找不到 {crossKey}，或你没有查看它的权限</li>}
              {!crossKey && sameProduct.data && candidates.length === 0 && <li className="text-muted-foreground">没有找到需求</li>}
            </ul>
          )}
          <FormError error={add.error} />
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 7: 放进详情页，移除只读区块**

`apps/web/src/app/(app)/[org]/requirements/[key]/side-lists.tsx`：删除 `{r.blockers.length > 0 && ( <Block title="阻塞项"> … </Block> )}` 与 `{r.relations.length > 0 && ( <Block title="关联需求"> … </Block> )}` 两段，删除因此不再使用的 `Link`、`RELATION_LABEL` import；组件不再需要 `org`，签名改为：

```tsx
export function SideLists({ requirement: r }: { requirement: RequirementDetail }) {
```

`apps/web/src/lib/labels.ts`：删除 `RELATION_LABEL` 一行（已无引用，读法改由 `features/requirements/relations.ts` 提供）。

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：

1. import 加入：

```ts
import { Blockers } from './blockers';
import { Relations } from './relations';
```

2. 主栏 `<CheckItems org={org} requirement={r} />` 之后加入：

```tsx
          <Blockers org={org} requirement={r} />
          <Relations org={org} requirement={r} />
```

3. 右侧栏 `<SideLists org={org} requirement={r} />` 改为 `<SideLists requirement={r} />`。

- [ ] **Step 8: 运行测试与检查**

Run:
- `pnpm --filter @flower/web exec vitest run src/features/requirements/relations.test.ts`
- `pnpm --filter @flower/web test`
- `pnpm typecheck`
- `pnpm --filter @flower/web lint --max-warnings 0`
- `pnpm --filter @flower/web e2e requirement-maintenance.spec.ts requirements.spec.ts iterations.spec.ts`（后台运行并写日志）

Expected: 全部通过。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/features/requirements apps/web/src/lib/queries.ts apps/web/src/lib/labels.ts "apps/web/src/app/(app)/[org]/requirements/[key]" apps/web/e2e/requirement-maintenance.spec.ts
git commit -m "feat(web): 需求详情维护阻塞项与关联需求，迭代需求页签显示阻塞标记"
```

---
### Task 12: 产品设置「结构树」页签：缩进树、新增、改名、停用 / 恢复、上移 / 下移

**Files:**
- Modify: `apps/web/src/features/structure/model.ts`、`model.test.ts`（`moveSibling`、`levelLabel`）
- Create: `apps/web/src/app/(app)/[org]/settings/products/[productId]/structure-tab.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`（增加页签）
- Create: `apps/web/e2e/structure.spec.ts`

**Interfaces:**
- Consumes: Task 6 的 `POST /orgs/:org/products/:id/nodes`、`PATCH /orgs/:org/nodes/:id`、`PUT /orgs/:org/products/:id/nodes/order`；Task 10 的 `flattenTree`；`useNodes`、`useLevelNames`、`qk.nodes`、`requirementKeys`
- Produces（`features/structure/model.ts`）：
  - `moveSibling(ids: string[], id: string, dir: -1 | 1): string[]`（越界时原样返回）
  - `levelLabel(names: string[], depth: number): string`（没有叫法时为「第 N 层」）
- Produces：`StructureTab({ org, productId })`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/structure/model.test.ts` 的 import 改为 `import { flattenTree, levelLabel, moveSibling, nodeOptions } from './model';`，文件末尾追加：

```ts
describe('结构树维护', () => {
  it('同级上移、下移，越界时不变', () => {
    expect(moveSibling(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveSibling(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveSibling(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveSibling(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });

  it('层级叫法按深度取，没有时显示第 N 层', () => {
    expect(levelLabel(['业务域', '模块', '功能点'], 2)).toBe('模块');
    expect(levelLabel(['模块'], 3)).toBe('第 3 层');
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/structure/model.test.ts`
Expected: FAIL，`moveSibling`、`levelLabel` 未导出。

- [ ] **Step 2: 实现**

`apps/web/src/features/structure/model.ts` 末尾追加：

```ts
/** 把 id 在同级列表中上移（-1）或下移（1）一位；已在边界时原样返回。 */
export function moveSibling(ids: string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const next = [...ids];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function levelLabel(names: string[], depth: number): string {
  return names[depth - 1] ?? `第 ${depth} 层`;
}
```

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/structure.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('产品设置：维护结构树，停用的节点不出现在需求详情的节点下拉中', async ({ page, request }) => {
  const res = await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  expect(res.ok()).toBeTruthy();
  const productId = (await res.json()).product.id as string;
  expect((await request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '自动续费提醒' } })).ok()).toBeTruthy();

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '结构树' }).click();
  const tree = page.getByRole('region', { name: '结构树' });
  await expect(tree).toContainText('还没有节点');

  await tree.getByRole('button', { name: '新增业务域' }).click();
  await tree.getByLabel('新业务域名称').fill('会员与支付');
  await tree.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('已新增节点')).toBeVisible();
  await tree.getByRole('button', { name: '在 会员与支付 下新增' }).click();
  await tree.getByLabel('新模块名称').fill('续费');
  await tree.getByRole('button', { name: '添加' }).click();
  await expect(tree).toContainText('续费');
  await tree.getByRole('button', { name: '新增业务域' }).click();
  await tree.getByLabel('新业务域名称').fill('存储');
  await tree.getByRole('button', { name: '添加' }).click();
  await expect(tree).toContainText('存储');

  await tree.getByRole('button', { name: '上移 存储' }).click();
  await expect(tree.getByRole('listitem').first()).toContainText('存储');

  await tree.getByRole('button', { name: '重命名 续费' }).click();
  await tree.getByLabel('节点名称').fill('自动续费');
  await tree.getByRole('button', { name: '保存' }).click();
  await expect(tree).toContainText('自动续费');

  await tree.getByRole('button', { name: '停用 自动续费' }).click();
  await expect(tree).toContainText('自动续费（已停用）');

  await page.goto('/acme/requirements/PAN-1');
  await page.getByRole('combobox', { name: '结构节点' }).click();
  await expect(page.getByRole('option', { name: '会员与支付' })).toBeVisible();
  await expect(page.getByRole('option', { name: '自动续费' })).toHaveCount(0);
});
```

Run: `pnpm --filter @flower/web e2e structure.spec.ts`（后台运行并写日志）
Expected: FAIL，找不到「结构树」页签。

- [ ] **Step 4: 结构树页签**

`apps/web/src/app/(app)/[org]/settings/products/[productId]/structure-tab.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { flattenTree, levelLabel, moveSibling } from '@/features/structure/model';
import { api } from '@/lib/api';
import { qk, requirementKeys, useApiMutation, useLevelNames, useNodes } from '@/lib/queries';
import { cn } from '@/lib/utils';

const indent = (depth: number) => ({ paddingLeft: `${(depth - 1) * 24 + 16}px` });

export function StructureTab({ org, productId }: { org: string; productId: string }) {
  const nodes = useNodes(org, productId);
  const levels = useLevelNames(org, productId);
  const [adding, setAdding] = useState<{ parentId: string | null; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const invalidate = [qk.nodes(org, productId), requirementKeys(org)];
  const create = useApiMutation((v: { parentId: string | null; name: string }) => api(`/orgs/${org}/products/${productId}/nodes`, { method: 'POST', body: v }), {
    invalidate,
    success: '已新增节点',
    onSuccess: () => setAdding(null),
  });
  const update = useApiMutation(
    (v: { id: string; name?: string; status?: 'active' | 'deprecated' }) => api(`/orgs/${org}/nodes/${v.id}`, { method: 'PATCH', body: { name: v.name, status: v.status } }),
    { invalidate, success: '已保存', onSuccess: () => setRenaming(null) },
  );
  const reorder = useApiMutation(
    (v: { parentId: string | null; nodeIds: string[] }) => api(`/orgs/${org}/products/${productId}/nodes/order`, { method: 'PUT', body: v }),
    { invalidate },
  );

  if (nodes.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-muted-foreground">加载结构树失败，请重试。</p>
        <Button variant="outline" onClick={() => nodes.refetch()}>
          重试
        </Button>
      </div>
    );
  }
  const list = flattenTree(nodes.data ?? []);
  const names = levels.data?.names ?? [];
  const siblingIds = (parentId: string | null) => list.filter((x) => x.parentId === parentId).map((x) => x.id);
  const addForm = (parentId: string | null, depth: number) =>
    adding && adding.parentId === parentId ? (
      <form
        className="flex h-10 items-center gap-2 border-b pr-4"
        style={indent(depth)}
        onSubmit={(e) => {
          e.preventDefault();
          if (adding.name.trim()) create.mutate({ parentId, name: adding.name });
        }}
      >
        <Input
          aria-label={`新${levelLabel(names, depth)}名称`}
          className="h-8 w-56"
          autoFocus
          maxLength={50}
          value={adding.name}
          onChange={(e) => setAdding({ parentId, name: e.target.value })}
        />
        <Button type="submit" size="sm" disabled={create.isPending}>
          添加
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
          取消
        </Button>
      </form>
    ) : null;

  return (
    <section className="rounded-lg border bg-card" aria-label="结构树">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-semibold">结构树</h2>
        <span className="text-xs text-muted-foreground">层级：{names.join(' / ')}（在「字段与层级」中修改叫法）</span>
      </div>
      <ul>
        {list.map((n) => {
          const siblings = siblingIds(n.parentId);
          const i = siblings.indexOf(n.id);
          const deprecated = n.status === 'deprecated';
          return (
            <li key={n.id}>
              <div className={cn('flex h-10 items-center gap-2 border-b pr-4', deprecated && 'text-muted-foreground')} style={indent(n.depth)}>
                <span className="w-14 shrink-0 text-xs text-muted-foreground">{levelLabel(names, n.depth)}</span>
                {renaming?.id === n.id ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      update.mutate({ id: n.id, name: renaming.name });
                    }}
                  >
                    <Input aria-label="节点名称" className="h-8 w-56" autoFocus maxLength={50} value={renaming.name} onChange={(e) => setRenaming({ id: n.id, name: e.target.value })} />
                    <Button type="submit" size="sm" disabled={update.isPending}>
                      保存
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                      取消
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className={cn('min-w-0 flex-1 truncate', deprecated && 'line-through')}>
                      {n.name}
                      {deprecated && '（已停用）'}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`上移 ${n.name}`}
                      disabled={i === 0 || reorder.isPending}
                      onClick={() => reorder.mutate({ parentId: n.parentId, nodeIds: moveSibling(siblings, n.id, -1) })}
                    >
                      上移
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`下移 ${n.name}`}
                      disabled={i === siblings.length - 1 || reorder.isPending}
                      onClick={() => reorder.mutate({ parentId: n.parentId, nodeIds: moveSibling(siblings, n.id, 1) })}
                    >
                      下移
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`重命名 ${n.name}`} onClick={() => setRenaming({ id: n.id, name: n.name })}>
                      重命名
                    </Button>
                    {n.depth < 3 && !deprecated && (
                      <Button variant="ghost" size="sm" aria-label={`在 ${n.name} 下新增`} onClick={() => setAdding({ parentId: n.id, name: '' })}>
                        新增{levelLabel(names, n.depth + 1)}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${deprecated ? '恢复' : '停用'} ${n.name}`}
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: n.id, status: deprecated ? 'active' : 'deprecated' })}
                    >
                      {deprecated ? '恢复' : '停用'}
                    </Button>
                  </>
                )}
              </div>
              {addForm(n.id, n.depth + 1)}
            </li>
          );
        })}
      </ul>
      {list.length === 0 && !adding && <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">还没有节点</p>}
      {addForm(null, 1)}
      {!adding && (
        <div className="px-4 py-3">
          <Button variant="outline" size="sm" onClick={() => setAdding({ parentId: null, name: '' })}>
            新增{levelLabel(names, 1)}
          </Button>
        </div>
      )}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`：

1. import 加入 `import { StructureTab } from './structure-tab';`
2. `TabsList` 中「字段与层级」之后加入 `<TabsTrigger value="structure">结构树</TabsTrigger>`
3. `Tabs` 末尾加入：

```tsx
        <TabsContent value="structure">
          <StructureTab org={org} productId={productId} />
        </TabsContent>
```

- [ ] **Step 5: 运行测试与检查**

Run:
- `pnpm --filter @flower/web exec vitest run src/features/structure/model.test.ts`
- `pnpm --filter @flower/web test`
- `pnpm typecheck`
- `pnpm --filter @flower/web lint --max-warnings 0`
- `pnpm --filter @flower/web e2e structure.spec.ts products.spec.ts`（后台运行并写日志）

Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/features/structure "apps/web/src/app/(app)/[org]/settings/products/[productId]" apps/web/e2e/structure.spec.ts
git commit -m "feat(web): 产品设置增加结构树页签：新增、改名、停用与恢复、同级排序"
```

---
### Task 13: 产品管理员缺口：面包屑与入口、覆盖字段的选项编辑、访客产品管理员的角色页签

**Files:**
- Create: `apps/web/src/components/field-card.tsx`（从字段字典页移出 `FieldCard`，内容不变）
- Modify: `apps/web/src/app/(app)/[org]/settings/fields/page.tsx`（改为引用共享组件）
- Modify: `apps/web/src/app/(app)/[org]/settings/products/[productId]/fields-tab.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/products/[productId]/roles-tab.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`（面包屑）
- Modify: `apps/web/src/app/(app)/[org]/page.tsx`（产品卡片的「产品设置」入口）
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`（`useProductMembers`；删除已无引用的 `useProductRoles`、`qk.productRoles`）
- Create: `apps/web/e2e/product-admin.spec.ts`

**Interfaces:**
- Consumes: Task 5 的 `ProductMemberRole`（`import type`）；Task 6 的 `GET /orgs/:org/products/:id/members`；现有 `PUT /orgs/:org/products/:id/roles/:memberId`、字段选项接口
- Produces（`lib/types.ts`）：`ProductMemberRole`
- Produces（`lib/queries.ts`）：`qk.productMembers(o, id) = ['org', o, 'product', id, 'members']`；`useProductMembers(o: string, id: string)` → `ProductMemberRole[]`
- Produces（`components/field-card.tsx`）：`FieldCard({ org, field, editable, productId? })`

- [ ] **Step 1: 写失败的端到端测试**

`apps/web/e2e/product-admin.spec.ts`：

```ts
import { type APIResponse, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function json<T>(pending: Promise<APIResponse>): Promise<T> {
  const res = await pending;
  expect(res.ok(), `${res.url()} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

test('访客产品管理员：从概览进入产品设置，角色页签列出成员，能编辑已覆盖字段的选项，面包屑不指向无权页面', async ({ browser, request }) => {
  const productId = (await json<{ product: { id: string } }>(request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } }))).product.id;
  await json(request.post('/api/v1/orgs/acme/members', { data: { displayName: '外部顾问' } }));
  const { token } = await json<{ token: string }>(request.post('/api/v1/orgs/acme/invitations', { data: { email: 'guest-pm@example.com', orgRole: 'guest' } }));

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/invite/${token}`);
  await page.getByLabel('你的姓名').fill('访客管理员');
  await page.getByLabel('设置密码').fill('password123');
  await page.getByRole('button', { name: '接受邀请' }).click();
  await page.waitForURL('**/acme');

  const members = (await json<{ members: Array<{ id: string; displayName: string }> }>(request.get('/api/v1/orgs/acme/members'))).members;
  const guestId = members.find((m) => m.displayName === '访客管理员')!.id;
  const res = await request.put(`/api/v1/orgs/acme/products/${productId}/roles/${guestId}`, { data: { role: 'admin' } });
  expect(res.status()).toBe(204);

  await page.reload();
  await page.getByRole('link', { name: '网盘 产品设置' }).click();
  await expect(page.getByRole('heading', { name: '网盘' })).toBeVisible();

  await page.getByRole('tab', { name: '成员角色' }).click();
  await expect(page.getByRole('combobox', { name: '外部顾问 的产品角色' })).toBeVisible();

  await page.getByRole('tab', { name: '字段与层级' }).click();
  await page.getByRole('button', { name: '覆盖 优先级' }).click();
  const priority = page.getByRole('region', { name: '优先级' });
  await priority.getByLabel('新选项').fill('绿色通道');
  await priority.getByRole('button', { name: '添加' }).click();
  await expect(priority.getByRole('textbox', { name: '选项名称' })).toHaveCount(5);

  await page.getByRole('navigation', { name: '面包屑' }).getByRole('link', { name: '概览' }).click();
  await expect(page).toHaveURL(/\/acme$/);
  await expect(page.getByRole('heading', { name: '无权访问' })).toHaveCount(0);
  await ctx.close();
});
```

Run: `pnpm --filter @flower/web e2e product-admin.spec.ts`（后台运行并写日志）
Expected: FAIL，找不到「网盘 产品设置」链接。

- [ ] **Step 2: 查询与类型**

`apps/web/src/lib/types.ts`：type import 加入 `ProductMemberRole as CoreProductMemberRole`，末尾追加：

```ts
export type ProductMemberRole = CoreProductMemberRole;
```

`apps/web/src/lib/queries.ts`：

1. types import 加入 `ProductMemberRole`，删除 `ProductRole`（它只被 `useProductRoles` 使用）。
2. `qk` 中删除 `productRoles` 一行，加入：

```ts
  productMembers: (o: string, id: string) => ['org', o, 'product', id, 'members'] as const,
```

3. 删除 `useProductRoles`，在原位置加入：

```ts
export const useProductMembers = (o: string, id: string) =>
  useQuery({
    queryKey: qk.productMembers(o, id),
    queryFn: () => api<{ members: ProductMemberRole[] }>(`/orgs/${o}/products/${id}/members`),
    select: (d) => d.members,
  });
```

- [ ] **Step 3: 角色页签改用产品成员角色**

`apps/web/src/app/(app)/[org]/settings/products/[productId]/roles-tab.tsx`：

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ORG_ROLE_LABEL, PRODUCT_ROLE_LABEL } from '@/lib/labels';
import { qk, useApiMutation, useProductMembers } from '@/lib/queries';
import type { ProductRole } from '@/lib/types';

const DEFAULT = 'default';

export function RolesTab({ org, productId }: { org: string; productId: string }) {
  const q = useProductMembers(org, productId);
  const set = useApiMutation(
    (v: { memberId: string; role: ProductRole | null }) =>
      api(`/orgs/${org}/products/${productId}/roles/${v.memberId}`, { method: 'PUT', body: { role: v.role } }),
    { invalidate: [qk.productMembers(org, productId), qk.members(org)], success: '已更新' },
  );
  if (q.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-muted-foreground">加载成员失败，请重试。</p>
        <Button variant="outline" onClick={() => q.refetch()}>
          重试
        </Button>
      </div>
    );
  }
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
          {(q.data ?? []).map((m) => {
            const admin = m.orgRole === 'owner' || m.orgRole === 'admin';
            return (
              <TableRow key={m.memberId} className="h-10 even:bg-zebra">
                <TableCell className="font-medium">{m.displayName}</TableCell>
                <TableCell>{ORG_ROLE_LABEL[m.orgRole]}</TableCell>
                <TableCell>
                  {admin ? (
                    <span className="text-muted-foreground">管理员（组织管理员）</span>
                  ) : (
                    <Select
                      value={m.role ?? DEFAULT}
                      onValueChange={(v) => set.mutate({ memberId: m.memberId, role: v === DEFAULT ? null : (v as ProductRole) })}
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

- [ ] **Step 4: 把 `FieldCard` 移到共享组件**

`apps/web/src/components/field-card.tsx`（函数体与原字段字典页中的 `FieldCard` 相同，只是加上 `export` 和 import）：

```tsx
'use client';

import { useState } from 'react';
import { ColorSwatches } from '@/components/color-swatches';
import { SortableList } from '@/components/sortable-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { Field } from '@/lib/types';

export function FieldCard({ org, field, editable, productId }: { org: string; field: Field; editable: boolean; productId?: string }) {
  const [label, setLabel] = useState('');
  const inv = { invalidate: [qk.fields(org, productId), qk.fields(org)] };
  const add = useApiMutation((v: string) => api(`/orgs/${org}/fields/${field.id}/options`, { method: 'POST', body: { label: v } }), inv);
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
              const v = label.trim();
              if (!v) return;
              setLabel('');
              add.mutate(v, { onError: () => setLabel(v) });
            }}
          >
            <Input
              aria-label="新选项"
              placeholder="新选项名称"
              className="h-8 w-56"
              maxLength={20}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
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
```

`apps/web/src/app/(app)/[org]/settings/fields/page.tsx`：删除文件内的 `FieldCard` 函数；import 区改为：

```tsx
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FieldCard } from '@/components/field-card';
import { LevelNamesEditor } from '@/components/level-names-editor';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFields, useLevelNames, useProducts } from '@/lib/queries';
```

`FieldsPage` 与默认导出不变。

- [ ] **Step 5: 产品「字段与层级」页签直接编辑已覆盖字段**

`apps/web/src/app/(app)/[org]/settings/products/[productId]/fields-tab.tsx`：

```tsx
'use client';

import { FieldCard } from '@/components/field-card';
import { LevelNamesEditor } from '@/components/level-names-editor';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { qk, useApiMutation, useFields, useLevelNames } from '@/lib/queries';

export function FieldsTab({ org, productId }: { org: string; productId: string }) {
  const fields = useFields(org, productId);
  const levels = useLevelNames(org, productId);
  const fork = useApiMutation((fieldId: string) => api(`/orgs/${org}/products/${productId}/fields/${fieldId}/fork`, { method: 'POST' }), {
    invalidate: [qk.fields(org, productId)],
    success: '已为本产品覆盖该字段',
  });
  const saveLevels = useApiMutation(
    (names: string[] | null) => api(`/orgs/${org}/products/${productId}/level-names`, { method: 'PUT', body: { names } }),
    { invalidate: [qk.levels(org, productId)], success: '已保存' },
  );
  const orgFields = (fields.data ?? []).filter((f) => !f.productId);
  const forked = (fields.data ?? []).filter((f) => f.productId);
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border bg-card">
        <h2 className="border-b px-4 py-3 font-semibold">组织字段</h2>
        {orgFields.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">所有字段都已按本产品覆盖。</p>
        ) : (
          <ul className="divide-y">
            {orgFields.map((f) => (
              <li key={f.id} className="flex h-10 items-center gap-3 px-4">
                <span className="w-24 font-medium">{f.label}</span>
                <span className="flex-1 truncate text-[13px] text-muted-foreground">
                  {f.options.filter((o) => o.active).map((o) => o.label).join('、') || '暂无选项'}
                </span>
                <Button variant="ghost" size="sm" aria-label={`覆盖 ${f.label}`} onClick={() => fork.mutate(f.id)}>
                  为本产品覆盖
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">覆盖后，本产品的选项在下方单独维护，与组织字段互不影响。</p>
      </section>
      {forked.map((f) => (
        <FieldCard key={f.id} org={org} field={f} productId={productId} editable />
      ))}
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

- [ ] **Step 6: 面包屑与入口**

`apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx` 的 `PageHeader` 的 `crumbs` 改为：

```tsx
        crumbs={
          orgAdmin
            ? [{ label: '组织设置' }, { label: '产品', href: `/${org}/settings/products` }, { label: p.name }]
            : [{ label: '概览', href: `/${org}` }, { label: '产品设置' }, { label: p.name }]
        }
```

（`orgAdmin` 已在 `return` 之前计算，无需移动。）

`apps/web/src/app/(app)/[org]/page.tsx` 产品卡片的 `<li>` 改为（`admin` 是页面里已有的 `isOrgAdminRole(q.data.me.orgRole)`；只对非组织管理员显示入口，`overview.spec.ts` 中 owner 的 `link /网盘/` 断言不受影响）：

```tsx
              <li key={p.id} className="flex flex-col gap-1">
                <Link
                  href={`/${org}/requirements?product=${p.key}`}
                  className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 hover:border-primary"
                >
                  <span>
                    <span className="mr-2 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">{p.key}</span>
                    {p.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{PRODUCT_ROLE_LABEL[p.myRole]}</span>
                </Link>
                {p.myRole === 'admin' && !admin && (
                  <Link href={`/${org}/settings/products/${p.id}`} aria-label={`${p.name} 产品设置`} className="self-end text-xs text-primary hover:underline">
                    产品设置
                  </Link>
                )}
              </li>
```

- [ ] **Step 7: 运行测试与检查**

Run:
- `pnpm --filter @flower/web test`
- `pnpm typecheck`
- `pnpm --filter @flower/web lint --max-warnings 0`
- `pnpm --filter @flower/web e2e product-admin.spec.ts products.spec.ts fields.spec.ts overview.spec.ts`（后台运行并写日志）

Expected: 全部通过（`products.spec.ts` 中「覆盖字段」后断言的「产品覆盖」文字由 `FieldCard` 渲染）。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/components/field-card.tsx "apps/web/src/app/(app)/[org]/settings" "apps/web/src/app/(app)/[org]/page.tsx" apps/web/src/lib apps/web/e2e/product-admin.spec.ts
git commit -m "fix(web): 产品管理员可从概览进入产品设置、编辑覆盖字段的选项；访客产品管理员的角色页签不再为空"
```

---
### Task 14: 真实数据验证：重导 pan123、性能测量、验证记录与人工验收清单、交接文档

**Files:**
- Modify: `packages/migrate/src/perf.ts`（新增两个用例）
- Modify: `packages/migrate/test/perf.test.ts`
- Create: `docs/p1b-validation.md`（只写数量与耗时，不写任何姓名、邮箱或需求标题）
- Modify: `docs/handoff.md`
- Modify: `docs/agent-log.md`（在「记录」最上面加一条）

**Interfaces:**
- Consumes: `listIterations`、`getIterationScope`（`@flower/core`）；现有 `measure`、`buildPerfCases`
- Produces：`buildPerfCases` 返回 11 个用例，新增「迭代：列表」「迭代：范围对比（需求最多的迭代）」

- [ ] **Step 1: 写失败的测试**

`packages/migrate/test/perf.test.ts` 中用例名断言改为：

```ts
    expect(cases.map((c) => c.name)).toEqual([
      '列表：默认第 1 页',
      '列表：第 5 页',
      '列表：按最多的状态',
      '列表：按负责人',
      '列表：按优先级',
      '列表：标题关键词',
      '列表：按编号',
      '详情：轮流打开',
      '评论：轮流读取',
      '迭代：列表',
      '迭代：范围对比（需求最多的迭代）',
    ]);
    const result = await measure(cases, 2);
    expect(result).toHaveLength(11);
```

Run: `pnpm --filter @flower/migrate exec vitest run test/perf.test.ts`
Expected: FAIL，只有 9 个用例。

- [ ] **Step 2: 实现**

`packages/migrate/src/perf.ts`：

1. import 改为：

```ts
import { type Actor, type Db, getIterationScope, getRequirementByKey, listIterations, listRequirementComments, listRequirements } from '@flower/core';
```

2. `buildPerfCases` 中 `let i = 0;` 之前加入：

```ts
  // 范围对比只对已开始的迭代有意义；取其中需求最多的一个
  const largest = (await listIterations(db, actor))
    .filter((it) => it.status !== 'planning')
    .sort((a, b) => b.requirementCount - a.requirementCount)[0];
```

3. 返回数组末尾追加两项：

```ts
    { name: '迭代：列表', run: () => listIterations(db, actor) },
    { name: '迭代：范围对比（需求最多的迭代）', run: () => (largest ? getIterationScope(db, actor, largest.id) : Promise.resolve(null)) },
```

- [ ] **Step 3: 运行测试并提交**

Run: `pnpm --filter @flower/migrate test` 与 `pnpm typecheck`
Expected: 全部通过。

```bash
git add packages/migrate/src/perf.ts packages/migrate/test/perf.test.ts
git commit -m "feat(migrate): 性能测量增加迭代列表与范围对比"
```

- [ ] **Step 4: 确认开发库数据**

开发库的 pan123 已于 2026-09-29 在「甘特任务半天」修复之后用 `--as-of 2026-09-29 --replace` 重导，本任务不重导。`<OWNER_EMAIL>` 由控制方在派发时提供。若之前跑过 `pnpm test` 或端到端测试，先执行 `pnpm db:migrate` 把 `flower_app` 的密码改回。

```bash
pnpm db:migrate
```

- [ ] **Step 5: 测量性能**

```bash
pnpm --filter @flower/migrate build
node --disable-warning=ExperimentalWarning --env-file=apps/web/.env.local packages/migrate/dist/cli.mjs perf --org-slug pan123 --owner-email <OWNER_EMAIL> --runs 40
```

Expected：输出 11 个用例的 p50 / p95 / 最大值。目标：每个用例 p95 ≤ 300 ms。超过的用例不要自行优化，在任务报告中列出数字，状态报 DONE_WITH_CONCERNS。

- [ ] **Step 6: 写验证记录**

`docs/p1b-validation.md`（第 2 节的表格用 Step 5 的输出替换；其余内容照写；只写数量与耗时）：

```markdown
# P1-B 真实数据验证记录

## P1-B1：迭代、发布版本、阻塞项与关联、结构树

数据：2026-09-29 的生产只读副本，本地开发库组织 pan123（2026-09-29 在「甘特任务半天」修复后以 `--as-of 2026-09-29 --replace` 重导）。迁移命令见 `CLAUDE.md`，对账报告全文在 `.local-data/reports/`（不进仓库）。

### 1. 数据状态

| 项 | 结果 |
|---|---|
| 导入对账（2026-09-29 重导） | 0 个阻止写入的问题 |
| 需求总数 | 与 `docs/p1a-validation.md` 第 1 节一致 |
| 迭代（常规 / 专项） | 与 `docs/p1a-validation.md` 第 1 节一致 |
| 迭代承诺快照 | 0（迁移不生成历史快照；范围对比对历史迭代显示「没有承诺范围记录」） |

### 2. 真实数据量下的性能

测量方式：`cli.mjs perf`，运行时角色直连开发数据库（受行级安全约束），每个用例预热 1 次后执行 40 次。

| 用例 | p50 (ms) | p95 (ms) | 最大 (ms) |
|---|---|---|---|
| 列表：默认第 1 页 | | | |
| 列表：第 5 页 | | | |
| 列表：按最多的状态 | | | |
| 列表：按负责人 | | | |
| 列表：按优先级 | | | |
| 列表：标题关键词 | | | |
| 列表：按编号 | | | |
| 详情：轮流打开 | | | |
| 评论：轮流读取 | | | |
| 迭代：列表 | | | |
| 迭代：范围对比（需求最多的迭代） | | | |

### 3. 人工验收清单（由用户在本地 pan123 上执行）

用自己的账号登录 `pnpm dev` 启动的开发环境，逐项打勾；发现问题记在本节末尾。验收中新建的测试数据用「验收-」开头命名，结束后取消或删除。

迭代
- [ ] 侧边栏「迭代」可进入；列表按产品分组，另有「专项」组；常规与专项的数量与第 1 节一致。
- [ ] 已过结束日期的历史迭代状态为「已完成」；需求数、已完成数与需求列表按该迭代筛选的结果一致。
- [ ] 打开需求最多的已完成迭代：「需求」页签列出需求、状态、负责人；有未解除阻塞项的需求带红点和数量。
- [ ] 该迭代的「范围对比」显示「没有承诺范围记录」提示，并列出当前范围。
- [ ] 新建常规迭代「验收-迭代」，日期与已有迭代重叠时提示「与已有迭代时间重叠」；换成不重叠的日期后创建成功，并加两个里程碑。
- [ ] 在「验收-迭代」里按编号和标题各添加一条需求；点「开始迭代」后，「范围对比」的「承诺内未完成」列出这两条。
- [ ] 开始后再添加一条需求，出现在「中途加入」；移出一条，出现在「中途移出」。
- [ ] 在流程编辑器里给本产品流程的「加入迭代」配置一个准入条件（例如「可行性」为通过），对不满足的需求加入迭代时提示原因；管理员填写原因后可以强制加入。验收后把流程改回。
- [ ] 取消「验收-迭代」。

发布版本
- [ ] 迁移来的发布版本在对应需求详情的「发布版本」区块中可见。
- [ ] 在某个迭代的「发布版本」页签新建「验收-1.0.0」，改计划日期后基线日期不变；标记发布后显示发布日期。
- [ ] 在需求详情关联、解除「验收-1.0.0」。

阻塞项与关联
- [ ] 需求详情新增阻塞项并解除；已解除的记录折叠在「已解除 N 条」中。
- [ ] 关联同产品需求（按标题搜索）并选「阻塞」，对方需求详情显示「被 … 阻塞」；删除关联。
- [ ] 重复添加同一关联时提示「已存在相同的关联」。

结构树
- [ ] 产品设置「结构树」页签显示迁移来的业务域；新增「验收-模块」到某个业务域下，改名、上移 / 下移、停用、恢复。
- [ ] 需求详情「结构节点」下拉按层级缩进，停用的节点不出现；把一条需求挂到第二层节点后，需求列表按其上级业务域筛选仍能找到它。

产品管理员
- [ ] （可选）邀请一个访客账号并设为本产品管理员：概览卡片有「产品设置」入口，面包屑「概览」可点击，「成员角色」页签列出成员，已覆盖字段的选项可以编辑。

问题记录：

### 4. 留给 P1-B2

甘特与任务、人员负载、工作台、批量评审表、日常操作新旧对比、用户试用，完成后在本文件追加「P1-B2」一节。
```

- [ ] **Step 7: 更新交接文档与协作日志**

`docs/handoff.md`：

1. 「关键文档」表格中 P1-A 计划那一行之后加入：

```markdown
| `docs/superpowers/plans/2026-09-30-flower-p1b1-iterations.md` | P1-B1 计划：迭代、发布版本、阻塞项与关联、结构树维护、产品管理员缺口（已完成） |
| `docs/p1b-validation.md` | P1-B 真实数据验证记录与人工验收清单 |
```

2. 「当前进度」列表末尾加入：

```markdown
- **P1-B1 迭代、发布版本、阻塞项与关联、结构树维护：已完成**（分支见协作日志）。
  - 迭代列表与详情（状态、里程碑、需求、承诺范围对比、发布版本），需求按流程准入条件加入迭代，产品管理员可强制。
  - 字段按产品覆盖时，发布版本与开发分配上的平台选项一并迁移（P1-A 遗留项已处理）。
  - 人工验收清单见 `docs/p1b-validation.md` 第 3 节，待用户执行。
```

3. 「下一步」整节替换为：

```markdown
## 下一步

1. 用户按 `docs/p1b-validation.md` 第 3 节在本地 pan123 上验收 P1-B1，问题记在该节末尾。
2. 写 P1-B2 计划：任务与甘特（push 的工作日算法）、人员负载、工作台（登录后默认页）、按检查项配置的批量评审表，以及日常操作新旧对比和用户试用。
3. P1-B2 计划要纳入 P1-B1 计划「设计决定」表「留给 P1-B2」一行，以及 P0-B 暂缓的界面打磨项（统一的加载与错误状态、网络错误的中文提示等）。
```

`docs/agent-log.md`：在「## 记录」下面、现有第一条之前加入（分支名按实际填写）：

```markdown
### 2026-09-30 · 本地 · P1-B1：迭代、发布版本、阻塞项与关联、结构树维护
- 分支 / PR：`feat/p1b1-iterations`
- 做了什么：
  - core：迭代（新建、修改、状态流转、开始时写承诺快照、删除、范围对比）、加入 / 移出迭代（流程准入条件、产品管理员强制）、发布版本、阻塞项、需求关联、结构树维护、产品成员角色列表；新增错误码 `precondition_failed`（HTTP 412）。
  - 字段按产品覆盖时同时迁移发布版本与开发分配的平台选项（已处理 2026-09-29 P1-A 待办）。
  - web：迭代列表与详情、需求详情的迭代选择 / 阻塞项 / 关联 / 发布版本、产品设置结构树页签；修复产品管理员的面包屑、选项编辑与访客角色页签。
- 怎么验证的：`pnpm typecheck`、`pnpm test`（core / web / migrate）、`pnpm --filter @flower/web lint --max-warnings 0`、完整端到端测试全部通过；真实数据性能见 `docs/p1b-validation.md` 第 2 节。
- 留给对方：人工验收清单（`docs/p1b-validation.md` 第 3 节）由用户执行；P1-B2 范围见 P1-B1 计划「留给 P1-B2」。
```

- [ ] **Step 8: 完整验证**

Run（按顺序；端到端在后台运行并写日志，不要与 `pnpm dev` 同时运行）：

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm test
pnpm --filter @flower/web e2e
./scripts/smoke.sh
pnpm db:migrate
```

Expected：全部通过；最后一步把 `flower_app` 的密码改回 `apps/web/.env.local` 中的值，之后 `pnpm dev` 可以正常连接 pan123。

- [ ] **Step 9: 提交**

```bash
git add docs/p1b-validation.md docs/handoff.md docs/agent-log.md
git commit -m "docs: P1-B1 真实数据验证记录、人工验收清单与交接"
```

---

## P1-B1 完成标准

- `pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm test`（core、web、migrate）、完整端到端测试、`./scripts/smoke.sh` 全部通过。
- 权限失败均有测试覆盖：只读成员写入 → forbidden；只读 Token 写入 → forbidden；加入迭代条件不满足 → precondition_failed（HTTP 412）；产品管理员带原因强制加入；常规迭代重叠 → conflict；开始迭代时承诺快照只写一次（已有快照不重复写）；字段覆盖时 `platform_option_id` 按选项 key 改写。
- 本地 pan123 已重导；`docs/p1b-validation.md` 第 1、2 节已填，第 3 节交给用户验收。
