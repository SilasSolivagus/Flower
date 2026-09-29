# Flower P1-A 需求数据模型、迁移与需求界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立需求、结构树、迭代、发布版本、任务、评论、检查项与会签的数据模型和服务，把 123plane / push / PRD 三个生产库副本迁移进 Flower，并提供需求列表与需求详情界面，用真实数据验证迁移是否完整、界面是否撑得住。

**Architecture:** 新表全部是租户表（`org_id` + RLS）。业务逻辑在 `packages/core/src/requirements/`，服务签名 `(db, actor, input)`，写操作同事务记 `domain_events`。流程运行时（条件判断、可流转目标、会签结果）是纯函数，放在 `workflow-runtime.ts`。迁移放在新包 `packages/migrate`：读取（SQLite 用 `node:sqlite`，PRD 用 postgres）→ 纯函数生成导入计划（确定性 ID）→ 以 `flower_admin` 一次事务写入 → 输出对账报告。平台、业务域、人员、迭代配对由脚本生成建议对照表，用户修改后重跑。界面沿用 P0-B 的写法（客户端组件 + TanStack Query + `/api/v1`）。

**Tech Stack:** Postgres 17（btree_gist 排他约束）、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui、Vitest、Playwright、Node 22 `node:sqlite`、esbuild。

**Spec:** `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§3.1 流程、§4 需求迭代任务、§7.2 映射、§7.3 按生产数据核实后的补充）。旧数据画像报告：`.local-data/legacy-profile.md`（仅本地，含员工姓名，不进仓库）。

## Global Constraints

- 生产数据副本、对照表、对账报告只放在 `.local-data/`（已在 `.git/info/exclude` 忽略），任何含员工姓名或邮箱的文件不得提交。测试夹具只用虚构姓名。
- 迁移只读取副本，不连接生产服务器。
- 迁移可重复执行：同样的输入和对照表得到同样的 ID 和数据（ID 由来源键经 SHA-1 派生，时间取自旧数据或 `--as-of`）。
- 新租户表必须带 `org_id` 并在自定义迁移里开启 RLS（参照 `0002_rls.sql`）。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`，一律 `async`，写操作同事务调用 `recordEvent`，修改类事件 payload 带 `changes: [{field, old, new}]`。
- 面向用户的文案与错误信息用中文，错误通过 `AppError(code, message, details?)` 抛出。
- 页面不直接 import `@flower/core` 的运行时代码；只允许 `import type` 和 `@flower/core/workflow-schema`。
- 视觉沿用 P0-B：表格行高 40px、隔行底色 `#F7F8F5`、编号用 IBM Plex Mono、卡片圆角 6px、按钮与输入框圆角 4px、页面标题 20px。
- 端到端测试不为迁就定位器修改应用或共享组件代码；Radix 弹出内容用 `page` 定位；`role="alert"` 用 `.filter({ hasText })` 限定。
- 每个 commit message 末尾加一行 `Co-Authored-By: <实际编写该提交的模型> <noreply@anthropic.com>`。

## 设计决定

| 项 | 决定 | 依据 |
|---|---|---|
| 迭代不重叠 | 排他约束用 `daterange(start_date, end_date, '[)')`：结束日与下一迭代开始日相同不算重叠 | 生产数据中发布日即下一迭代开始日（如 0804 结束 08-04，0818 开始 08-04）；Task 1 同步修改 spec §4.3 |
| 结构树排序 | `sort integer`，不用 fractional index | 与字段选项、职能标签一致；P1 无高频并发拖动 |
| 需求编号 | `products.requirement_seq` 自增（`update … returning` 行锁） | 简单、无竞态 |
| 流转规则 | 某个目标状态若有"从当前状态出发"的显式规则，就只看它；否则看 `*` 规则；都没有则不可流转 | 与 P0-B 流转矩阵"显式 / 由任意状态推出"一致 |
| 强制流转 | 仅产品管理员，必须填原因，记 `forced = true` | spec §4.2 state_transitions |
| 代签 | 仅产品管理员可代签，且只针对"指定成员"类签字规则；记 `acted_by_member_id` | spec §7.3 |
| 评论权限 | 产品只读成员也可评论 | 提出人多为只读或访客，需要能跟进 |
| 需求描述 | P1-A 以纯文本（保留换行）展示与编辑 | 旧数据为简单 markdown；渲染器放到 P2 文档模块 |
| 流程 v1 流转 | 各状态由 `*` 可达；进入"待设计""待开发"需"可行性"为通过或不需要 | spec 未规定条件；提供一个"卡在哪"的真实例子，管理员可在流程编辑器调整 |
| 延后 | 简报 12 条（附件，P2）；通知通道、推送计划、推送日志、webhook 设置（P3）；PRD 页面（P2）；迭代承诺快照（无历史数据）；123plane 验收状态存入 legacy 元数据 | 分阶段范围 |
| 留给 P1-B | 结构树维护界面；阻塞项、需求关联（查重合并）的新建与编辑；加入迭代（含准入条件）；登记发布版本；甘特与按人负载；工作台；迭代承诺快照的生成 | P1-A 只建表、迁移数据并在详情页只读展示 |

## 文件结构

```
packages/core/
  src/db/schema.ts                        # 新表（Task 1）
  migrations/0005_*.sql                   # drizzle 生成（Task 1）
  migrations/0006_p1a_rls.sql             # RLS、btree_gist、迭代排他约束（Task 1）
  src/requirements/labels.ts              # 检查状态中文名（Task 2）
  src/requirements/workflow-runtime.ts    # 条件、可流转目标、会签结果（Task 2）
  src/requirements/context.ts             # 产品流程、有效字段等查询（Task 3）
  src/requirements/requirements.ts        # 创建、列表、修改、字段值（Task 3）
  src/requirements/lookups.ts             # 结构树节点、迭代列表（Task 3）
  src/requirements/detail.ts              # 详情聚合（Task 4）
  src/requirements/transitions.ts         # 流转、检查项、会签（Task 4）
  src/requirements/comments.ts            # 评论与已读（Task 5）
apps/web/src/server/routes/requirements.ts  # 接口（Task 6）
packages/migrate/                         # 新包 @flower/migrate（Task 7–11, 14）
  src/legacy-types.ts  src/load.ts  src/ids.ts  src/normalize.ts
  src/mapping.ts  src/suggest.ts
  src/workflow-v1.ts  src/plan-base.ts  src/plan-requirements.ts  src/plan.ts
  src/write.ts  src/report.ts  src/cli.ts  src/perf.ts
  test/fixtures.ts  test/*.test.ts
apps/web/src/
  lib/types.ts  lib/queries.ts  lib/labels.ts        # 扩展（Task 12）
  features/shell/nav.ts                              # 启用"需求"（Task 12）
  features/requirements/filter.ts                    # URL ⇄ 筛选条件（Task 12）
  components/option-multi-select.tsx                 # 多选下拉（Task 12）
  app/(app)/[org]/requirements/page.tsx              # 列表（Task 12）
  app/(app)/[org]/requirements/create-dialog.tsx     # 快速新建（Task 12）
  app/(app)/[org]/requirements/[key]/page.tsx        # 详情（Task 13）
  app/(app)/[org]/requirements/[key]/*.tsx          # 详情子组件（Task 13）
  e2e/requirements.spec.ts                           # 端到端（Task 12、13）
docs/p1a-validation.md                               # 真实数据验证记录（Task 14，只含数量，不含姓名）
```

---
### Task 1: 数据模型：需求、结构树、迭代、发布版本、任务、评论、检查项

**Files:**
- Modify: `packages/core/src/db/schema.ts`（新表；`products` 增加 `requirement_seq`）
- Create: `packages/core/migrations/0005_*.sql`（`pnpm --filter @flower/core db:generate` 生成）
- Create: `packages/core/migrations/0006_p1a_rls.sql`（`drizzle-kit generate --custom` 生成空文件后填写）
- Modify: `docs/superpowers/specs/2026-09-28-flower-data-model-design.md` §4.3（排他约束改为 `'[)'`）
- Test: `packages/core/test/p1a-schema.test.ts`

**Interfaces:**
- Produces（drizzle 表对象，从 `@flower/core` 导出）：`structureNodes, iterations, iterationScopeSnapshots, releases, requirements, requirementReleases, fieldValues, requirementAssignments, requirementRelations, stateTransitions, blockers, checkItemResults, checkItemSignoffs, tasks, comments, commentReads, entityAliases`；`products.requirementSeq`
- 类型：`IterationMilestone = { label: string; date: string }`；`RELATION_TYPES = ['duplicate_of','merged_into','derived_from','blocks','related'] as const`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/p1a-schema.test.ts`：

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkItemResults,
  checkItemSignoffs,
  iterations,
  members,
  organizations,
  products,
  requirements,
} from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const memberA = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
  await t.adminDb.insert(members).values({ id: memberA, orgId: orgA, displayName: '甲', orgRole: 'member' });
});
afterAll(() => t.cleanup());

describe('P1-A 数据模型', () => {
  it('需求受行级安全约束', async () => {
    await withOrg(t.db, orgA, (tx) =>
      tx.insert(requirements).values({ orgId: orgA, productId: productA, number: 1, title: '甲需求', stateKey: 'backlog' }),
    );
    expect(await withOrg(t.db, orgA, (tx) => tx.select().from(requirements))).toHaveLength(1);
    expect(await withOrg(t.db, orgB, (tx) => tx.select().from(requirements))).toHaveLength(0);
  });

  it('同一产品内需求编号唯一', async () => {
    await expect(
      withOrg(t.db, orgA, (tx) =>
        tx.insert(requirements).values({ orgId: orgA, productId: productA, number: 1, title: '重复编号', stateKey: 'backlog' }),
      ),
    ).rejects.toThrow();
  });

  it('常规迭代时间不能重叠，首尾相接可以', async () => {
    const base = { orgId: orgA, productId: productA, type: 'regular' as const, status: 'planning' as const };
    await withOrg(t.db, orgA, (tx) =>
      tx.insert(iterations).values([
        { ...base, name: '一', startDate: '2026-07-08', endDate: '2026-07-21' },
        { ...base, name: '二', startDate: '2026-07-21', endDate: '2026-08-04' },
      ]),
    );
    await expect(
      withOrg(t.db, orgA, (tx) => tx.insert(iterations).values({ ...base, name: '三', startDate: '2026-07-10', endDate: '2026-07-15' })),
    ).rejects.toThrow();
  });

  it('组织级专项不受重叠限制，且不属于产品', async () => {
    await withOrg(t.db, orgA, (tx) =>
      tx.insert(iterations).values([
        { orgId: orgA, productId: null, type: 'special', status: 'active', name: '专项一', startDate: '2026-07-10', endDate: '2026-07-30' },
        { orgId: orgA, productId: null, type: 'special', status: 'active', name: '专项二', startDate: '2026-07-10', endDate: '2026-07-30' },
      ]),
    );
    await expect(
      withOrg(t.db, orgA, (tx) =>
        tx.insert(iterations).values({ orgId: orgA, productId: productA, type: 'special', status: 'active', name: '错', startDate: '2026-01-01', endDate: '2026-01-02' }),
      ),
    ).rejects.toThrow();
  });

  it('会签记录可以记录代签的实际操作人', async () => {
    const [req] = await withOrg(t.db, orgA, (tx) => tx.select().from(requirements));
    const [result] = await withOrg(t.db, orgA, (tx) =>
      tx
        .insert(checkItemResults)
        .values({ orgId: orgA, targetType: 'requirement', targetId: req!.id, itemKey: 'design', state: 'in_progress' })
        .returning(),
    );
    const [s] = await withOrg(t.db, orgA, (tx) =>
      tx
        .insert(checkItemSignoffs)
        .values({ orgId: orgA, resultId: result!.id, signerMemberId: memberA, actedByMemberId: memberA, signerRuleIndex: 0, decision: 'passed' })
        .returning(),
    );
    expect(s!.actedByMemberId).toBe(memberA);
  });

  it('新表全部开启了行级安全', async () => {
    const rows = await t.adminDb.execute(sql`
      select relname from pg_class
      where relname in ('structure_nodes','iterations','iteration_scope_snapshots','releases','requirements',
        'requirement_releases','field_values','requirement_assignments','requirement_relations','state_transitions',
        'blockers','check_item_results','check_item_signoffs','tasks','comments','comment_reads','entity_aliases')
        and relrowsecurity`);
    expect(rows).toHaveLength(17);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/p1a-schema.test.ts`
Expected: FAIL，`requirements` 等未从 schema 导出。

- [ ] **Step 3: 在 `schema.ts` 中增加新表**

在 `schema.ts` 顶部 import 中加入 `date`、`unique`（来自 `drizzle-orm/pg-core`）。`products` 表增加一列：

```ts
    requirementSeq: integer('requirement_seq').notNull().default(0),
```

在文件末尾（`domainEvents` 之后）追加：

```ts
// ---------- P1-A：需求、迭代、任务 ----------

export type IterationMilestone = { label: string; date: string };
export const RELATION_TYPES = ['duplicate_of', 'merged_into', 'derived_from', 'blocks', 'related'] as const;
const CHECK_STATE_ENUM = ['not_started', 'in_progress', 'passed', 'rejected', 'not_needed'] as const;
const productRef = () => uuid('product_id').notNull().references(() => products.id);
const memberRef = (name: string) => uuid(name).references(() => members.id);

export const structureNodes = pgTable(
  'structure_nodes',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    parentId: uuid('parent_id').references((): AnyPgColumn => structureNodes.id),
    depth: smallint('depth').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: ['active', 'deprecated'] }).notNull().default('active'),
    sort: integer('sort').notNull().default(0),
    legacyKey: text('legacy_key'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('structure_nodes_parent_name').on(t.productId, t.parentId, t.name).nullsNotDistinct(),
    check('structure_nodes_depth', sql`${t.depth} between 1 and 3`),
  ],
);

export const iterations = pgTable(
  'iterations',
  {
    id: id(),
    orgId: orgRef(),
    productId: uuid('product_id').references(() => products.id),
    type: text('type', { enum: ['regular', 'special'] }).notNull(),
    name: text('name').notNull(),
    legacyKey: text('legacy_key'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    baselineEndDate: date('baseline_end_date', { mode: 'string' }),
    status: text('status', { enum: ['planning', 'active', 'done', 'canceled'] }).notNull().default('planning'),
    milestones: jsonb('milestones').$type<IterationMilestone[]>().notNull().default([]),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('iterations_type_product', sql`(${t.type} = 'regular') = (${t.productId} is not null)`),
    check('iterations_dates', sql`${t.startDate} <= ${t.endDate}`),
    index('iterations_product').on(t.productId),
  ],
);

export const releases = pgTable(
  'releases',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    platformOptionId: uuid('platform_option_id').references(() => fieldOptions.id),
    versionName: text('version_name').notNull(),
    iterationId: uuid('iteration_id').references(() => iterations.id),
    status: text('status', { enum: ['planned', 'released'] }).notNull().default('planned'),
    plannedDate: date('planned_date', { mode: 'string' }),
    baselineDate: date('baseline_date', { mode: 'string' }),
    releasedAt: ts('released_at'),
    notes: text('notes'),
    legacyKey: text('legacy_key'),
    createdAt: createdAt(),
  },
  (t) => [index('releases_product').on(t.productId)],
);

export const requirements = pgTable(
  'requirements',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    number: integer('number').notNull(),
    legacyKey: text('legacy_key'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    stateKey: text('state_key').notNull(),
    stateChangedAt: ts('state_changed_at').notNull().defaultNow(),
    ownerMemberId: memberRef('owner_member_id'),
    requesterMemberId: memberRef('requester_member_id'),
    nodeId: uuid('node_id').references(() => structureNodes.id),
    iterationId: uuid('iteration_id').references(() => iterations.id),
    changeDocumentId: uuid('change_document_id'),
    legacyMeta: jsonb('legacy_meta').$type<Record<string, unknown>>(),
    createdBy: memberRef('created_by'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('requirements_product_number').on(t.productId, t.number),
    index('requirements_product_state').on(t.productId, t.stateKey),
    index('requirements_product_updated').on(t.productId, t.updatedAt.desc()),
    index('requirements_owner').on(t.ownerMemberId),
    index('requirements_iteration').on(t.iterationId),
  ],
);

export const iterationScopeSnapshots = pgTable('iteration_scope_snapshots', {
  id: id(),
  orgId: orgRef(),
  iterationId: uuid('iteration_id').notNull().references(() => iterations.id),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
  snapshotKind: text('snapshot_kind', { enum: ['committed'] }).notNull(),
  at: ts('at').notNull().defaultNow(),
});

export const requirementReleases = pgTable(
  'requirement_releases',
  {
    orgId: orgRef(),
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
    releaseId: uuid('release_id').notNull().references(() => releases.id),
  },
  (t) => [primaryKey({ columns: [t.requirementId, t.releaseId] })],
);

export const fieldValues = pgTable(
  'field_values',
  {
    id: id(),
    orgId: orgRef(),
    entityType: text('entity_type', { enum: ['requirement'] }).notNull(),
    entityId: uuid('entity_id').notNull(),
    fieldId: uuid('field_id').notNull().references(() => fieldDefinitions.id),
    optionId: uuid('option_id').notNull().references(() => fieldOptions.id),
  },
  (t) => [
    uniqueIndex('field_values_entity_option').on(t.entityId, t.fieldId, t.optionId),
    index('field_values_option').on(t.optionId),
  ],
);

export const requirementAssignments = pgTable(
  'requirement_assignments',
  {
    id: id(),
    orgId: orgRef(),
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
    memberId: uuid('member_id').notNull().references(() => members.id),
    functionTagId: uuid('function_tag_id').references(() => functionTags.id),
    platformOptionId: uuid('platform_option_id').references(() => fieldOptions.id),
  },
  (t) => [index('requirement_assignments_requirement').on(t.requirementId), index('requirement_assignments_member').on(t.memberId)],
);

export const requirementRelations = pgTable(
  'requirement_relations',
  {
    id: id(),
    orgId: orgRef(),
    fromId: uuid('from_id').notNull().references(() => requirements.id),
    toId: uuid('to_id').notNull().references(() => requirements.id),
    type: text('type', { enum: RELATION_TYPES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('requirement_relations_unique').on(t.fromId, t.toId, t.type)],
);

export const stateTransitions = pgTable(
  'state_transitions',
  {
    id: id(),
    orgId: orgRef(),
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actorMemberId: memberRef('actor_member_id'),
    tokenId: uuid('token_id'),
    forced: boolean('forced').notNull().default(false),
    reason: text('reason'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('state_transitions_requirement').on(t.requirementId, t.at)],
);

export const blockers = pgTable(
  'blockers',
  {
    id: id(),
    orgId: orgRef(),
    requirementId: uuid('requirement_id').notNull().references(() => requirements.id),
    description: text('description').notNull(),
    status: text('status', { enum: ['active', 'resolved'] }).notNull().default('active'),
    ownerMemberId: memberRef('owner_member_id'),
    createdAt: createdAt(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [index('blockers_requirement').on(t.requirementId)],
);

export const checkItemResults = pgTable(
  'check_item_results',
  {
    id: id(),
    orgId: orgRef(),
    targetType: text('target_type', { enum: ['requirement', 'document'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    itemKey: text('item_key').notNull(),
    state: text('state', { enum: CHECK_STATE_ENUM }).notNull(),
    note: text('note'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: memberRef('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('check_item_results_target_item').on(t.targetType, t.targetId, t.itemKey)],
);

export const checkItemSignoffs = pgTable(
  'check_item_signoffs',
  {
    id: id(),
    orgId: orgRef(),
    resultId: uuid('result_id')
      .notNull()
      .references(() => checkItemResults.id, { onDelete: 'cascade' }),
    signerMemberId: uuid('signer_member_id').notNull().references(() => members.id),
    actedByMemberId: memberRef('acted_by_member_id'),
    signerRuleIndex: integer('signer_rule_index').notNull(),
    decision: text('decision', { enum: ['passed', 'rejected'] }).notNull(),
    note: text('note'),
    evidenceLinkId: uuid('evidence_link_id'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('check_item_signoffs_result').on(t.resultId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    requirementId: uuid('requirement_id').references(() => requirements.id),
    iterationId: uuid('iteration_id').references(() => iterations.id),
    title: text('title').notNull(),
    alias: text('alias'),
    assigneeMemberId: memberRef('assignee_member_id'),
    status: text('status', { enum: ['todo', 'doing', 'done'] }).notNull().default('todo'),
    planStart: date('plan_start', { mode: 'string' }),
    planDays: integer('plan_days'),
    delayDays: integer('delay_days'),
    phase: text('phase'),
    flag: text('flag'),
    starred: boolean('starred'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    legacyKey: text('legacy_key'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('tasks_requirement').on(t.requirementId), index('tasks_assignee').on(t.assigneeMemberId), index('tasks_iteration').on(t.iterationId)],
);

export const comments = pgTable(
  'comments',
  {
    id: id(),
    orgId: orgRef(),
    targetType: text('target_type', { enum: ['requirement', 'document', 'iteration'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id),
    authorMemberId: memberRef('author_member_id'),
    body: text('body').notNull(),
    kind: text('kind', { enum: ['comment', 'update'] }).notNull().default('comment'),
    anchor: jsonb('anchor').$type<Record<string, unknown>>(),
    anchorState: text('anchor_state', { enum: ['ok', 'stale', 'unanchored'] }),
    resolvedAt: ts('resolved_at'),
    resolvedBy: memberRef('resolved_by'),
    createdAt: createdAt(),
  },
  (t) => [index('comments_target').on(t.targetType, t.targetId, t.createdAt)],
);

export const commentReads = pgTable(
  'comment_reads',
  {
    orgId: orgRef(),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull().references(() => members.id),
    readAt: ts('read_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.memberId] })],
);

export const entityAliases = pgTable(
  'entity_aliases',
  {
    id: id(),
    orgId: orgRef(),
    entityType: text('entity_type', { enum: ['requirement'] }).notNull(),
    entityId: uuid('entity_id').notNull(),
    alias: text('alias').notNull(),
  },
  (t) => [uniqueIndex('entity_aliases_org_alias').on(t.orgId, t.alias)],
);
```

- [ ] **Step 4: 生成迁移**

Run: `pnpm --filter @flower/core db:generate`
Expected: 生成 `packages/core/migrations/0005_<随机名>.sql`，包含 17 张新表和 `products.requirement_seq`。打开文件核对没有 DROP 语句。

Run: `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p1a_rls`
Expected: 生成空的 `packages/core/migrations/0006_p1a_rls.sql`。写入：

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'structure_nodes', 'iterations', 'iteration_scope_snapshots', 'releases', 'requirements',
    'requirement_releases', 'field_values', 'requirement_assignments', 'requirement_relations',
    'state_transitions', 'blockers', 'check_item_results', 'check_item_signoffs', 'tasks',
    'comments', 'comment_reads', 'entity_aliases'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY tenant_isolation ON %I
        USING (current_setting('app.scope', true) = 'system'
               OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)
        WITH CHECK (current_setting('app.scope', true) = 'system'
               OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$,
      t);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE iterations ADD CONSTRAINT iterations_regular_no_overlap
  EXCLUDE USING gist (product_id WITH =, daterange(start_date, end_date, '[)') WITH &&)
  WHERE (type = 'regular' AND deleted_at IS NULL);
```

- [ ] **Step 5: 修改 spec §4.3**

把 `docs/superpowers/specs/2026-09-28-flower-data-model-design.md` 中排他约束的 `daterange(start_date, end_date, '[]')` 改为 `daterange(start_date, end_date, '[)')`，并在该句后补一句：`结束日与下一迭代的开始日可以是同一天（生产数据中发布日即下一迭代开始日）。`

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/core test`
Expected: 全部通过（测试会用新迁移重建模板库）；`pnpm typecheck` 无错误。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/db/schema.ts packages/core/migrations packages/core/test/p1a-schema.test.ts docs/superpowers/specs/2026-09-28-flower-data-model-design.md
git commit -m "feat(core): 需求、结构树、迭代、发布版本、任务、评论与检查项的数据模型"
```

---
### Task 2: 流程运行时（纯函数）：条件判断、可流转目标、会签结果

**Files:**
- Create: `packages/core/src/requirements/labels.ts`
- Create: `packages/core/src/requirements/workflow-runtime.ts`
- Modify: `packages/core/src/index.ts`（导出上面两个模块）
- Test: `packages/core/test/workflow-runtime.test.ts`

**Interfaces:**
- Consumes: `WorkflowBody`、`Condition`、`CHECK_STATES`（`definitions/workflow-schema.ts`）
- Produces:
  - `type CheckState = (typeof CHECK_STATES)[number]`
  - `CHECK_STATE_LABELS: Record<CheckState, string>` = `{ not_started: '未开始', in_progress: '进行中', passed: '通过', rejected: '驳回', not_needed: '不需要' }`
  - `type ConditionContext = { checks: Record<string, CheckState>; filledFields: Set<string>; hasIteration: boolean; hasChangeDocument: boolean }`
  - `type NameLookup = { checkItem: (key: string) => string; field: (key: string) => string }`
  - `type UnmetCondition = { condition: Condition; message: string }`
  - `unmetConditions(conds: Condition[], ctx: ConditionContext, names: NameLookup): UnmetCondition[]`
  - `type TransitionOption = { to: string; label: string; allowed: boolean; unmet: UnmetCondition[] }`
  - `availableTransitions(body: WorkflowBody, from: string, ctx: ConditionContext, names: NameLookup): TransitionOption[]`
  - `findTransitionRule(body: WorkflowBody, from: string, to: string): WorkflowBody['transitions'][number] | null`
  - `checkStatesFor(body: WorkflowBody, results: Array<{ itemKey: string; state: CheckState }>): Record<string, CheckState>`（缺失的检查项取 `defaultState`）
  - `type SignerIdentity = { memberId: string; functionTagIds: string[]; productRole: 'admin' | 'editor' | 'viewer' | null }`
  - `matchingSignerRules(item: CheckItem, who: SignerIdentity): number[]`
  - `signoffResultState(item: CheckItem, signoffs: Array<{ signerRuleIndex: number; decision: 'passed' | 'rejected'; at: Date }>): CheckState`
  - `type CheckItem = WorkflowBody['checkItems'][number]`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/workflow-runtime.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { WorkflowBody } from '../src/definitions/workflow-schema';
import {
  availableTransitions,
  checkStatesFor,
  type ConditionContext,
  findTransitionRule,
  matchingSignerRules,
  signoffResultState,
  unmetConditions,
} from '../src/requirements/workflow-runtime';

const names = { checkItem: (k: string) => ({ feasibility: '可行性', design: '设计签字' })[k] ?? k, field: (k: string) => ({ priority: '优先级' })[k] ?? k };

const body: WorkflowBody = {
  states: [
    { key: 'collect', label: '收集', color: '#94a3b8', order: 1, group: '分析', category: 'backlog' },
    { key: 'to_design', label: '待设计', color: '#60a5fa', order: 2, group: '开发', category: 'unstarted' },
    { key: 'developing', label: '开发中', color: '#f97316', order: 3, group: '开发', category: 'started' },
    { key: 'shelved', label: '已搁置', color: '#6b7280', order: 4, group: '', category: 'canceled' },
  ],
  initial: 'collect',
  transitions: [
    { from: '*', to: 'to_design', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed', 'not_needed'] }] },
    { from: 'collect', to: 'to_design', label: '直接进入设计', conditions: [{ type: 'field_set', field: 'priority' }] },
    { from: '*', to: 'developing', conditions: [{ type: 'has_iteration' }] },
    { from: '*', to: 'shelved', conditions: [] },
  ],
  actionGates: [],
  checkItems: [
    { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
    {
      key: 'design',
      label: '设计签字',
      scope: 'requirement',
      type: 'signoff',
      signers: [
        { by: 'function_tag', ref: 'tag-ui' },
        { by: 'member', ref: 'm-boss' },
      ],
      signoffRule: 'all',
      defaultState: 'not_started',
    },
  ],
};

const ctx = (over: Partial<ConditionContext> = {}): ConditionContext => ({
  checks: { feasibility: 'not_started', design: 'not_started' },
  filledFields: new Set(),
  hasIteration: false,
  hasChangeDocument: false,
  ...over,
});

describe('unmetConditions', () => {
  it('逐条给出未满足的原因', () => {
    const unmet = unmetConditions(
      [
        { type: 'check_item', item: 'feasibility', in: ['passed', 'not_needed'] },
        { type: 'field_set', field: 'priority' },
        { type: 'has_iteration' },
        { type: 'has_change_document' },
      ],
      ctx(),
      names,
    );
    expect(unmet.map((u) => u.message)).toEqual([
      '「可行性」需为通过或不需要（当前：未开始）',
      '需要填写「优先级」',
      '需要先加入迭代',
      '需要先关联变更 PRD',
    ]);
  });

  it('条件都满足时返回空数组', () => {
    const c = ctx({ checks: { feasibility: 'passed' }, filledFields: new Set(['priority']), hasIteration: true, hasChangeDocument: true });
    expect(
      unmetConditions([{ type: 'check_item', item: 'feasibility', in: ['passed'] }, { type: 'field_set', field: 'priority' }, { type: 'has_iteration' }], c, names),
    ).toEqual([]);
  });
});

describe('availableTransitions', () => {
  it('显式规则优先于任意状态规则，排除当前状态，按状态顺序排列', () => {
    const opts = availableTransitions(body, 'collect', ctx(), names);
    expect(opts.map((o) => o.to)).toEqual(['to_design', 'developing', 'shelved']);
    const toDesign = opts[0]!;
    expect(toDesign.label).toBe('直接进入设计');
    expect(toDesign.allowed).toBe(false);
    expect(toDesign.unmet.map((u) => u.message)).toEqual(['需要填写「优先级」']);
  });

  it('没有显式规则时使用任意状态规则', () => {
    const opts = availableTransitions(body, 'developing', ctx({ checks: { feasibility: 'passed' } }), names);
    expect(opts.find((o) => o.to === 'to_design')).toMatchObject({ label: '待设计', allowed: true, unmet: [] });
  });

  it('没有任何规则的目标不出现', () => {
    const noShelve = { ...body, transitions: body.transitions.filter((t) => t.to !== 'shelved') };
    expect(availableTransitions(noShelve, 'collect', ctx(), names).map((o) => o.to)).not.toContain('shelved');
  });

  it('findTransitionRule 返回生效的规则', () => {
    expect(findTransitionRule(body, 'collect', 'to_design')?.label).toBe('直接进入设计');
    expect(findTransitionRule(body, 'developing', 'to_design')?.from).toBe('*');
    expect(findTransitionRule(body, 'collect', 'collect')).toBeNull();
  });
});

describe('checkStatesFor', () => {
  it('没有结果的检查项取默认状态', () => {
    expect(checkStatesFor(body, [{ itemKey: 'feasibility', state: 'passed' }])).toEqual({ feasibility: 'passed', design: 'not_started' });
  });
});

describe('会签', () => {
  const design = body.checkItems[1]!;

  it('按职能标签、指定成员、产品角色匹配签字规则', () => {
    expect(matchingSignerRules(design, { memberId: 'm-1', functionTagIds: ['tag-ui'], productRole: 'editor' })).toEqual([0]);
    expect(matchingSignerRules(design, { memberId: 'm-boss', functionTagIds: [], productRole: 'viewer' })).toEqual([1]);
    expect(matchingSignerRules(design, { memberId: 'm-2', functionTagIds: [], productRole: 'admin' })).toEqual([]);
    const byRole = { ...design, signers: [{ by: 'product_role' as const, ref: 'admin' }] };
    expect(matchingSignerRules(byRole, { memberId: 'm-2', functionTagIds: [], productRole: 'admin' })).toEqual([0]);
  });

  it('all 规则：全部签字规则最新一次都通过才算通过', () => {
    const t1 = new Date('2026-07-01T00:00:00Z');
    const t2 = new Date('2026-07-02T00:00:00Z');
    expect(signoffResultState(design, [])).toBe('not_started');
    expect(signoffResultState(design, [{ signerRuleIndex: 0, decision: 'passed', at: t1 }])).toBe('in_progress');
    expect(
      signoffResultState(design, [
        { signerRuleIndex: 0, decision: 'passed', at: t1 },
        { signerRuleIndex: 1, decision: 'passed', at: t1 },
      ]),
    ).toBe('passed');
    expect(
      signoffResultState(design, [
        { signerRuleIndex: 0, decision: 'rejected', at: t1 },
        { signerRuleIndex: 0, decision: 'passed', at: t2 },
        { signerRuleIndex: 1, decision: 'passed', at: t1 },
      ]),
    ).toBe('passed');
    expect(signoffResultState(design, [{ signerRuleIndex: 1, decision: 'rejected', at: t1 }])).toBe('rejected');
  });

  it('any 规则：任一签字规则通过即通过', () => {
    const any = { ...design, signoffRule: 'any' as const };
    expect(signoffResultState(any, [{ signerRuleIndex: 1, decision: 'passed', at: new Date() }])).toBe('passed');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/workflow-runtime.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`packages/core/src/requirements/labels.ts`：

```ts
import type { CHECK_STATES } from '../definitions/workflow-schema';

export type CheckState = (typeof CHECK_STATES)[number];

export const CHECK_STATE_LABELS: Record<CheckState, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  passed: '通过',
  rejected: '驳回',
  not_needed: '不需要',
};
```

`packages/core/src/requirements/workflow-runtime.ts`：

```ts
import type { Condition, WorkflowBody } from '../definitions/workflow-schema';
import { CHECK_STATE_LABELS, type CheckState } from './labels';

export type CheckItem = WorkflowBody['checkItems'][number];
export type ConditionContext = {
  checks: Record<string, CheckState>;
  filledFields: Set<string>;
  hasIteration: boolean;
  hasChangeDocument: boolean;
};
export type NameLookup = { checkItem: (key: string) => string; field: (key: string) => string };
export type UnmetCondition = { condition: Condition; message: string };
export type TransitionOption = { to: string; label: string; allowed: boolean; unmet: UnmetCondition[] };
export type SignerIdentity = { memberId: string; functionTagIds: string[]; productRole: 'admin' | 'editor' | 'viewer' | null };

export function unmetConditions(conds: Condition[], ctx: ConditionContext, names: NameLookup): UnmetCondition[] {
  const unmet: UnmetCondition[] = [];
  for (const c of conds) {
    if (c.type === 'check_item') {
      const current = ctx.checks[c.item] ?? 'not_started';
      if (!c.in.includes(current)) {
        const want = c.in.map((s) => CHECK_STATE_LABELS[s]).join('或');
        unmet.push({ condition: c, message: `「${names.checkItem(c.item)}」需为${want}（当前：${CHECK_STATE_LABELS[current]}）` });
      }
    } else if (c.type === 'field_set') {
      if (!ctx.filledFields.has(c.field)) unmet.push({ condition: c, message: `需要填写「${names.field(c.field)}」` });
    } else if (c.type === 'has_iteration') {
      if (!ctx.hasIteration) unmet.push({ condition: c, message: '需要先加入迭代' });
    } else if (c.type === 'has_change_document') {
      if (!ctx.hasChangeDocument) unmet.push({ condition: c, message: '需要先关联变更 PRD' });
    }
  }
  return unmet;
}

export function findTransitionRule(body: WorkflowBody, from: string, to: string): WorkflowBody['transitions'][number] | null {
  if (from === to) return null;
  return body.transitions.find((t) => t.from === from && t.to === to) ?? body.transitions.find((t) => t.from === '*' && t.to === to) ?? null;
}

export function availableTransitions(body: WorkflowBody, from: string, ctx: ConditionContext, names: NameLookup): TransitionOption[] {
  const out: TransitionOption[] = [];
  for (const s of [...body.states].sort((a, b) => a.order - b.order)) {
    const rule = findTransitionRule(body, from, s.key);
    if (!rule) continue;
    const unmet = unmetConditions(rule.conditions, ctx, names);
    out.push({ to: s.key, label: rule.label || s.label, allowed: unmet.length === 0, unmet });
  }
  return out;
}

export function checkStatesFor(body: WorkflowBody, results: Array<{ itemKey: string; state: CheckState }>): Record<string, CheckState> {
  const byKey = new Map(results.map((r) => [r.itemKey, r.state]));
  return Object.fromEntries(body.checkItems.map((c) => [c.key, byKey.get(c.key) ?? c.defaultState]));
}

export function matchingSignerRules(item: CheckItem, who: SignerIdentity): number[] {
  const out: number[] = [];
  (item.signers ?? []).forEach((s, i) => {
    const ok =
      (s.by === 'member' && s.ref === who.memberId) ||
      (s.by === 'function_tag' && who.functionTagIds.includes(s.ref)) ||
      (s.by === 'product_role' && who.productRole === s.ref);
    if (ok) out.push(i);
  });
  return out;
}

export function signoffResultState(
  item: CheckItem,
  signoffs: Array<{ signerRuleIndex: number; decision: 'passed' | 'rejected'; at: Date }>,
): CheckState {
  if (signoffs.length === 0) return 'not_started';
  const latest = new Map<number, 'passed' | 'rejected'>();
  for (const s of [...signoffs].sort((a, b) => a.at.getTime() - b.at.getTime())) latest.set(s.signerRuleIndex, s.decision);
  const decisions = [...latest.values()];
  if (decisions.includes('rejected')) return 'rejected';
  if (item.signoffRule === 'any') return 'passed';
  const need = item.signers?.length ?? 0;
  return latest.size >= need ? 'passed' : 'in_progress';
}
```

在 `packages/core/src/index.ts` 末尾追加：

```ts
export * from './requirements/labels';
export * from './requirements/workflow-runtime';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/workflow-runtime.test.ts`
Expected: PASS（10 个用例）。再跑 `pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/requirements packages/core/src/index.ts packages/core/test/workflow-runtime.test.ts
git commit -m "feat(core): 流程运行时：条件判断、可流转目标与会签结果"
```

---
### Task 3: 需求服务：创建、列表与筛选、修改、字段值，结构树节点与迭代查询

**Files:**
- Create: `packages/core/src/requirements/context.ts`
- Create: `packages/core/src/requirements/requirements.ts`
- Create: `packages/core/src/requirements/lookups.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/requirements.test.ts`

**Interfaces:**
- Consumes: Task 1 的表；`requireProductRole`；`recordEvent`；`WorkflowBody`
- Produces（`context.ts`）：
  - `type EffectiveField = { id: string; key: string; label: string; cardinality: 'single' | 'multi'; options: Array<{ id: string; key: string; label: string; color: string | null; active: boolean }> }`
  - `productWorkflowBody(tx: Tx, productId: string): Promise<WorkflowBody>`
  - `effectiveFields(tx: Tx, productId: string): Promise<Map<string, EffectiveField>>`（产品覆盖优先于组织字段）
  - `loadRequirement(tx: Tx, id: string): Promise<typeof requirements.$inferSelect>`
  - `memberNames(tx: Tx, ids: Array<string | null>): Promise<Map<string, string>>`
  - `assertMemberInOrg(tx: Tx, id: string): Promise<void>`
- Produces（`requirements.ts`）：
  - `type OptionRef = { id: string; key: string; label: string; color: string | null }`
  - `type MemberRef = { id: string; displayName: string }`
  - `type RequirementListItem = { id: string; productId: string; number: number; displayKey: string; legacyKey: string | null; title: string; stateKey: string; owner: MemberRef | null; requester: MemberRef | null; priority: OptionRef | null; platforms: OptionRef[]; node: { id: string; name: string } | null; iteration: { id: string; name: string } | null; updatedAt: Date }`
  - `type RequirementFilter = { states?: string[]; nodeIds?: string[]; priorityOptionIds?: string[]; platformOptionIds?: string[]; ownerIds?: string[]; requesterIds?: string[]; iterationIds?: string[]; noIteration?: boolean; q?: string; sort?: 'updated' | 'number' | 'created'; page?: number; pageSize?: number }`
  - `type RequirementList = { items: RequirementListItem[]; total: number; page: number; pageSize: number; stateCounts: Record<string, number> }`
  - `displayKey(productKey: string, number: number): string` → `PAN-12`
  - `listRequirements(db, actor, productId, filter?: RequirementFilter): Promise<RequirementList>`
  - `createRequirement(db, actor, productId, input: { title: string; description?: string; ownerMemberId?: string | null; requesterMemberId?: string | null; nodeId?: string | null; fields?: Record<string, string[]> }): Promise<RequirementListItem>`
  - `updateRequirement(db, actor, requirementId, input: { title?: string; description?: string; ownerMemberId?: string | null; requesterMemberId?: string | null; nodeId?: string | null }): Promise<RequirementListItem>`
  - `setRequirementField(db, actor, requirementId, fieldKey: string, optionIds: string[]): Promise<OptionRef[]>`
  - `hydrateList(tx: Tx, productKey: string, rows: Array<typeof requirements.$inferSelect>): Promise<RequirementListItem[]>`（Task 4 复用）
- Produces（`lookups.ts`）：
  - `type StructureNodeView = { id: string; parentId: string | null; depth: number; name: string; status: 'active' | 'deprecated'; sort: number }`
  - `listStructureNodes(db, actor, productId): Promise<StructureNodeView[]>`
  - `type IterationBrief = { id: string; name: string; type: 'regular' | 'special'; status: 'planning' | 'active' | 'done' | 'canceled'; startDate: string; endDate: string }`
  - `listProductIterations(db, actor, productId): Promise<IterationBrief[]>`（本产品常规迭代 + 组织级专项，按开始日期倒序）
- 事件：`requirement.created`、`requirement.updated`（`changes`）、`requirement.field_changed`（`changes`）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/requirements.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFieldOption, listFields } from '../src/definitions/fields';
import { domainEvents, stateTransitions, structureNodes } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { AppError } from '../src/errors';
import { listProductIterations, listStructureNodes } from '../src/requirements/lookups';
import { createRequirement, listRequirements, setRequirementField, updateRequirement } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let productId: string;
let requesterId: string;
let p0: string;
let p1: string;
let web: string;
let app: string;
let nodeId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  requesterId = (await createPlaceholderMember(t.db, owner, { displayName: '提出人甲' })).id;
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读乙' });
  await setProductRole(t.db, owner, productId, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
  const fields = await listFields(t.db, owner);
  const priority = fields.find((f) => f.key === 'priority')!;
  p0 = priority.options.find((o) => o.key === 'p0')!.id;
  p1 = priority.options.find((o) => o.key === 'p1')!.id;
  const platform = fields.find((f) => f.key === 'platform')!;
  web = (await addFieldOption(t.db, owner, platform.id, { label: 'Web端', key: 'web' })).id;
  app = (await addFieldOption(t.db, owner, platform.id, { label: '移动端', key: 'mobile' })).id;
  [{ id: nodeId }] = (await withOrg(t.db, owner.orgId, (tx) =>
    tx.insert(structureNodes).values({ orgId: owner.orgId, productId, depth: 1, name: '会员与支付' }).returning(),
  )) as [{ id: string }];
});
afterAll(() => t.cleanup());

describe('创建需求', () => {
  it('按产品顺序编号，初始状态取流程的初始状态，并记录流转与事件', async () => {
    const a = await createRequirement(t.db, owner, productId, {
      title: '支持批量下载',
      requesterMemberId: requesterId,
      fields: { priority: [p1], platform: [web, app] },
    });
    const b = await createRequirement(t.db, owner, productId, { title: '会员续费提醒', nodeId, fields: { priority: [p0] } });
    expect(a).toMatchObject({ number: 1, displayKey: 'PAN-1', stateKey: 'backlog', requester: { displayName: '提出人甲' } });
    expect(a.priority?.label).toBe('P1');
    expect(a.platforms.map((o) => o.label).sort()).toEqual(['Web端', '移动端']);
    expect(b).toMatchObject({ number: 2, node: { name: '会员与支付' } });
    const transitions = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(stateTransitions).where(eq(stateTransitions.requirementId, a.id)),
    );
    expect(transitions).toMatchObject([{ fromState: null, toState: 'backlog' }]);
    const events = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, a.id), eq(domainEvents.type, 'requirement.created'))),
    );
    expect(events).toHaveLength(1);
  });

  it('单选字段不能选两个值，选项必须属于该字段', async () => {
    await expect(createRequirement(t.db, owner, productId, { title: 'x', fields: { priority: [p0, p1] } })).rejects.toThrow(AppError);
    await expect(createRequirement(t.db, owner, productId, { title: 'x', fields: { priority: [web] } })).rejects.toThrow(AppError);
    await expect(createRequirement(t.db, owner, productId, { title: '   ' })).rejects.toThrow(AppError);
  });

  it('只读成员不能创建', async () => {
    await expect(createRequirement(t.db, viewer, productId, { title: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('需求列表', () => {
  it('支持按优先级、平台、业务域、提出人筛选，并给出各状态数量', async () => {
    const all = await listRequirements(t.db, viewer, productId);
    expect(all.total).toBe(2);
    expect(all.stateCounts).toEqual({ backlog: 2 });
    expect((await listRequirements(t.db, owner, productId, { priorityOptionIds: [p0] })).items.map((r) => r.title)).toEqual(['会员续费提醒']);
    expect((await listRequirements(t.db, owner, productId, { platformOptionIds: [web] })).items.map((r) => r.title)).toEqual(['支持批量下载']);
    expect((await listRequirements(t.db, owner, productId, { nodeIds: [nodeId] })).total).toBe(1);
    expect((await listRequirements(t.db, owner, productId, { requesterIds: [requesterId] })).total).toBe(1);
    expect((await listRequirements(t.db, owner, productId, { states: ['todo'] })).total).toBe(0);
    expect((await listRequirements(t.db, owner, productId, { states: ['todo'] })).stateCounts).toEqual({ backlog: 2 });
  });

  it('关键词可以匹配标题、编号或旧编号', async () => {
    expect((await listRequirements(t.db, owner, productId, { q: '批量' })).total).toBe(1);
    expect((await listRequirements(t.db, owner, productId, { q: 'PAN-2' })).items[0]?.title).toBe('会员续费提醒');
    expect((await listRequirements(t.db, owner, productId, { q: '2' })).items[0]?.number).toBe(2);
    expect((await listRequirements(t.db, owner, productId, { q: '100%' })).total).toBe(0);
  });

  it('分页与排序', async () => {
    const page1 = await listRequirements(t.db, owner, productId, { sort: 'number', pageSize: 1, page: 1 });
    const page2 = await listRequirements(t.db, owner, productId, { sort: 'number', pageSize: 1, page: 2 });
    expect([page1.items[0]?.number, page2.items[0]?.number]).toEqual([2, 1]);
    expect(page1.total).toBe(2);
  });
});

describe('修改需求', () => {
  it('修改标题与负责人并记录变更', async () => {
    const [r] = (await listRequirements(t.db, owner, productId, { q: 'PAN-1' })).items;
    const updated = await updateRequirement(t.db, owner, r!.id, { title: '支持批量下载与打包', ownerMemberId: requesterId });
    expect(updated).toMatchObject({ title: '支持批量下载与打包', owner: { displayName: '提出人甲' } });
    const [e] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, r!.id), eq(domainEvents.type, 'requirement.updated'))),
    );
    expect(e!.payload).toMatchObject({ changes: expect.arrayContaining([{ field: 'title', old: '支持批量下载', new: '支持批量下载与打包' }]) });
  });

  it('设置字段值会整体替换，并校验基数', async () => {
    const [r] = (await listRequirements(t.db, owner, productId, { q: 'PAN-1' })).items;
    expect((await setRequirementField(t.db, owner, r!.id, 'platform', [app])).map((o) => o.label)).toEqual(['移动端']);
    expect(await setRequirementField(t.db, owner, r!.id, 'platform', [])).toEqual([]);
    await expect(setRequirementField(t.db, owner, r!.id, 'priority', [p0, p1])).rejects.toThrow(AppError);
    await expect(setRequirementField(t.db, owner, r!.id, 'nope', [])).rejects.toMatchObject({ code: 'not_found' });
    await expect(setRequirementField(t.db, viewer, r!.id, 'platform', [web])).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('查询结构树节点与迭代', () => {
  it('列出本产品的节点和迭代', async () => {
    expect((await listStructureNodes(t.db, viewer, productId)).map((n) => n.name)).toEqual(['会员与支付']);
    expect(await listProductIterations(t.db, viewer, productId)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/requirements.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `context.ts`**

```ts
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { fieldDefinitions, fieldOptions, members, products, requirements, workflowVersions } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import { AppError } from '../errors';

export type EffectiveField = {
  id: string;
  key: string;
  label: string;
  cardinality: 'single' | 'multi';
  options: Array<{ id: string; key: string; label: string; color: string | null; active: boolean }>;
};

export async function productWorkflowBody(tx: Tx, productId: string): Promise<WorkflowBody> {
  const [row] = await tx
    .select({ body: workflowVersions.body })
    .from(products)
    .innerJoin(workflowVersions, eq(workflowVersions.id, products.workflowVersionId))
    .where(eq(products.id, productId));
  if (!row) throw new AppError('invalid', '该产品尚未指定流程');
  return row.body as WorkflowBody;
}

export async function effectiveFields(tx: Tx, productId: string): Promise<Map<string, EffectiveField>> {
  const defs = await tx
    .select()
    .from(fieldDefinitions)
    .where(or(isNull(fieldDefinitions.productId), eq(fieldDefinitions.productId, productId)));
  const chosen = new Map<string, (typeof defs)[number]>();
  for (const d of defs) {
    const cur = chosen.get(d.key);
    if (!cur || (cur.productId === null && d.productId !== null)) chosen.set(d.key, d);
  }
  const ids = [...chosen.values()].map((d) => d.id);
  const opts = ids.length ? await tx.select().from(fieldOptions).where(inArray(fieldOptions.fieldId, ids)).orderBy(asc(fieldOptions.sort)) : [];
  return new Map(
    [...chosen.values()].map((d) => [
      d.key,
      {
        id: d.id,
        key: d.key,
        label: d.label,
        cardinality: d.cardinality,
        options: opts
          .filter((o) => o.fieldId === d.id)
          .map((o) => ({ id: o.id, key: o.key, label: o.label, color: o.color, active: o.active })),
      },
    ]),
  );
}

export async function loadRequirement(tx: Tx, id: string): Promise<typeof requirements.$inferSelect> {
  const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, id), isNull(requirements.deletedAt)));
  if (!r) throw new AppError('not_found', '需求不存在');
  return r;
}

export async function memberNames(tx: Tx, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await tx.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function assertMemberInOrg(tx: Tx, id: string): Promise<void> {
  const [m] = await tx.select({ id: members.id }).from(members).where(eq(members.id, id));
  if (!m) throw new AppError('not_found', '成员不存在');
}
```

- [ ] **Step 4: 实现 `requirements.ts`**

```ts
import { and, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import {
  fieldDefinitions,
  fieldOptions,
  fieldValues,
  iterations,
  products,
  requirements,
  stateTransitions,
  structureNodes,
} from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertMemberInOrg, type EffectiveField, effectiveFields, loadRequirement, memberNames, productWorkflowBody } from './context';

export type OptionRef = { id: string; key: string; label: string; color: string | null };
export type MemberRef = { id: string; displayName: string };
export type RequirementListItem = {
  id: string;
  productId: string;
  number: number;
  displayKey: string;
  legacyKey: string | null;
  title: string;
  stateKey: string;
  owner: MemberRef | null;
  requester: MemberRef | null;
  priority: OptionRef | null;
  platforms: OptionRef[];
  node: { id: string; name: string } | null;
  iteration: { id: string; name: string } | null;
  updatedAt: Date;
};
export type RequirementFilter = {
  states?: string[];
  nodeIds?: string[];
  priorityOptionIds?: string[];
  platformOptionIds?: string[];
  ownerIds?: string[];
  requesterIds?: string[];
  iterationIds?: string[];
  noIteration?: boolean;
  q?: string;
  sort?: 'updated' | 'number' | 'created';
  page?: number;
  pageSize?: number;
};
export type RequirementList = { items: RequirementListItem[]; total: number; page: number; pageSize: number; stateCounts: Record<string, number> };

type ReqRow = typeof requirements.$inferSelect;

export const displayKey = (productKey: string, number: number): string => `${productKey}-${number}`;

function assertTitle(title: string): string {
  const t = title.trim();
  if (!t || t.length > 200) throw new AppError('invalid', '标题不能为空，且不超过 200 个字符');
  return t;
}

function assertDescription(d: string): string {
  if (d.length > 50_000) throw new AppError('invalid', '描述不超过 50000 个字符');
  return d;
}

async function productKeyOf(tx: Tx, productId: string): Promise<string> {
  const [p] = await tx.select({ key: products.key }).from(products).where(eq(products.id, productId));
  if (!p) throw new AppError('not_found', '产品不存在');
  return p.key;
}

async function assertNode(tx: Tx, productId: string, nodeId: string): Promise<void> {
  const [n] = await tx.select({ productId: structureNodes.productId }).from(structureNodes).where(eq(structureNodes.id, nodeId));
  if (!n || n.productId !== productId) throw new AppError('invalid', '结构树节点不属于该产品');
}

function descendantIds(nodes: Array<{ id: string; parentId: string | null }>, roots: string[]): string[] {
  const out = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return [...out];
}

async function filterConditions(tx: Tx, productId: string, f: RequirementFilter): Promise<SQL[]> {
  const conds: SQL[] = [eq(requirements.productId, productId), isNull(requirements.deletedAt)];
  if (f.nodeIds?.length) {
    const nodes = await tx.select({ id: structureNodes.id, parentId: structureNodes.parentId }).from(structureNodes).where(eq(structureNodes.productId, productId));
    conds.push(inArray(requirements.nodeId, descendantIds(nodes, f.nodeIds)));
  }
  if (f.ownerIds?.length) conds.push(inArray(requirements.ownerMemberId, f.ownerIds));
  if (f.requesterIds?.length) conds.push(inArray(requirements.requesterMemberId, f.requesterIds));
  if (f.noIteration) conds.push(isNull(requirements.iterationId));
  else if (f.iterationIds?.length) conds.push(inArray(requirements.iterationId, f.iterationIds));
  for (const ids of [f.priorityOptionIds, f.platformOptionIds]) {
    if (ids?.length) {
      conds.push(sql`exists (select 1 from ${fieldValues} where ${fieldValues.entityId} = ${requirements.id} and ${inArray(fieldValues.optionId, ids)})`);
    }
  }
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const num = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d{1,9})$/.exec(q);
    const parts = [ilike(requirements.title, like), ilike(requirements.legacyKey, like)];
    if (num) parts.push(eq(requirements.number, Number(num[1])));
    conds.push(or(...parts)!);
  }
  return conds;
}

export async function hydrateList(tx: Tx, productKey: string, rows: ReqRow[]): Promise<RequirementListItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const names = await memberNames(tx, rows.flatMap((r) => [r.ownerMemberId, r.requesterMemberId]));
  const nodeIds = [...new Set(rows.map((r) => r.nodeId).filter((x): x is string => !!x))];
  const iterIds = [...new Set(rows.map((r) => r.iterationId).filter((x): x is string => !!x))];
  const nodes = nodeIds.length ? await tx.select({ id: structureNodes.id, name: structureNodes.name }).from(structureNodes).where(inArray(structureNodes.id, nodeIds)) : [];
  const iters = iterIds.length ? await tx.select({ id: iterations.id, name: iterations.name }).from(iterations).where(inArray(iterations.id, iterIds)) : [];
  const values = await tx
    .select({
      entityId: fieldValues.entityId,
      fieldKey: fieldDefinitions.key,
      id: fieldOptions.id,
      key: fieldOptions.key,
      label: fieldOptions.label,
      color: fieldOptions.color,
      sort: fieldOptions.sort,
    })
    .from(fieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
    .where(inArray(fieldValues.entityId, ids));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const iterMap = new Map(iters.map((i) => [i.id, i]));
  const ref = (id: string | null): MemberRef | null => (id && names.has(id) ? { id, displayName: names.get(id)! } : null);
  const opt = (v: (typeof values)[number]): OptionRef => ({ id: v.id, key: v.key, label: v.label, color: v.color });
  return rows.map((r) => {
    const mine = values.filter((v) => v.entityId === r.id).sort((a, b) => a.sort - b.sort);
    const priority = mine.find((v) => v.fieldKey === 'priority');
    return {
      id: r.id,
      productId: r.productId,
      number: r.number,
      displayKey: displayKey(productKey, r.number),
      legacyKey: r.legacyKey,
      title: r.title,
      stateKey: r.stateKey,
      owner: ref(r.ownerMemberId),
      requester: ref(r.requesterMemberId),
      priority: priority ? opt(priority) : null,
      platforms: mine.filter((v) => v.fieldKey === 'platform').map(opt),
      node: r.nodeId ? (nodeMap.get(r.nodeId) ?? null) : null,
      iteration: r.iterationId ? (iterMap.get(r.iterationId) ?? null) : null,
      updatedAt: r.updatedAt,
    };
  });
}

export async function listRequirements(db: Db, actor: Actor, productId: string, filter: RequirementFilter = {}): Promise<RequirementList> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const key = await productKeyOf(tx, productId);
    const base = await filterConditions(tx, productId, filter);
    const where = filter.states?.length ? and(...base, inArray(requirements.stateKey, filter.states)) : and(...base);
    const [{ total }] = (await tx.select({ total: sql<number>`count(*)::int` }).from(requirements).where(where)) as [{ total: number }];
    const counts = await tx
      .select({ state: requirements.stateKey, n: sql<number>`count(*)::int` })
      .from(requirements)
      .where(and(...base))
      .groupBy(requirements.stateKey);
    const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 200);
    const page = Math.max(filter.page ?? 1, 1);
    const order =
      filter.sort === 'number'
        ? [desc(requirements.number)]
        : filter.sort === 'created'
          ? [desc(requirements.createdAt), desc(requirements.number)]
          : [desc(requirements.updatedAt), desc(requirements.number)];
    const rows = await tx.select().from(requirements).where(where).orderBy(...order).limit(pageSize).offset((page - 1) * pageSize);
    return { items: await hydrateList(tx, key, rows), total, page, pageSize, stateCounts: Object.fromEntries(counts.map((c) => [c.state, c.n])) };
  });
}

function resolveOptions(field: EffectiveField, optionIds: string[], previous: string[] = []): string[] {
  const unique = [...new Set(optionIds)];
  if (field.cardinality === 'single' && unique.length > 1) throw new AppError('invalid', `「${field.label}」只能选择一个值`);
  for (const id of unique) {
    const o = field.options.find((x) => x.id === id);
    if (!o) throw new AppError('invalid', `选项不属于「${field.label}」`);
    if (!o.active && !previous.includes(id)) throw new AppError('invalid', `选项「${o.label}」已停用`);
  }
  return unique;
}

async function replaceFieldValues(tx: Tx, orgId: string, requirementId: string, field: EffectiveField, optionIds: string[]): Promise<void> {
  await tx.delete(fieldValues).where(and(eq(fieldValues.entityId, requirementId), eq(fieldValues.fieldId, field.id)));
  if (optionIds.length > 0) {
    await tx.insert(fieldValues).values(optionIds.map((optionId) => ({ orgId, entityType: 'requirement' as const, entityId: requirementId, fieldId: field.id, optionId })));
  }
}

export async function createRequirement(
  db: Db,
  actor: Actor,
  productId: string,
  input: { title: string; description?: string; ownerMemberId?: string | null; requesterMemberId?: string | null; nodeId?: string | null; fields?: Record<string, string[]> },
): Promise<RequirementListItem> {
  const title = assertTitle(input.title);
  const description = assertDescription(input.description ?? '');
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'editor');
    if (input.ownerMemberId) await assertMemberInOrg(tx, input.ownerMemberId);
    if (input.requesterMemberId) await assertMemberInOrg(tx, input.requesterMemberId);
    if (input.nodeId) await assertNode(tx, productId, input.nodeId);
    const fields = await effectiveFields(tx, productId);
    const values: Array<[EffectiveField, string[]]> = [];
    for (const [key, ids] of Object.entries(input.fields ?? {})) {
      const field = fields.get(key);
      if (!field) throw new AppError('not_found', `字段「${key}」不存在`);
      values.push([field, resolveOptions(field, ids)]);
    }
    const body = await productWorkflowBody(tx, productId);
    const [seq] = await tx
      .update(products)
      .set({ requirementSeq: sql`${products.requirementSeq} + 1` })
      .where(eq(products.id, productId))
      .returning({ n: products.requirementSeq, key: products.key });
    const [row] = await tx
      .insert(requirements)
      .values({
        orgId: actor.orgId,
        productId,
        number: seq!.n,
        title,
        description,
        stateKey: body.initial,
        ownerMemberId: input.ownerMemberId ?? null,
        requesterMemberId: input.requesterMemberId ?? null,
        nodeId: input.nodeId ?? null,
        createdBy: actor.memberId,
      })
      .returning();
    await tx.insert(stateTransitions).values({ orgId: actor.orgId, requirementId: row!.id, fromState: null, toState: body.initial, actorMemberId: actor.memberId, tokenId: actor.tokenId });
    for (const [field, ids] of values) await replaceFieldValues(tx, actor.orgId, row!.id, field, ids);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'requirement.created',
      subjectType: 'requirement',
      subjectId: row!.id,
      actor,
      payload: { number: row!.number, title },
    });
    const [item] = await hydrateList(tx, seq!.key, [row!]);
    return item!;
  });
}

export async function updateRequirement(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { title?: string; description?: string; ownerMemberId?: string | null; requesterMemberId?: string | null; nodeId?: string | null },
): Promise<RequirementListItem> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const next = {
      title: input.title === undefined ? cur.title : assertTitle(input.title),
      description: input.description === undefined ? cur.description : assertDescription(input.description),
      ownerMemberId: input.ownerMemberId === undefined ? cur.ownerMemberId : input.ownerMemberId,
      requesterMemberId: input.requesterMemberId === undefined ? cur.requesterMemberId : input.requesterMemberId,
      nodeId: input.nodeId === undefined ? cur.nodeId : input.nodeId,
    };
    if (next.ownerMemberId && next.ownerMemberId !== cur.ownerMemberId) await assertMemberInOrg(tx, next.ownerMemberId);
    if (next.requesterMemberId && next.requesterMemberId !== cur.requesterMemberId) await assertMemberInOrg(tx, next.requesterMemberId);
    if (next.nodeId && next.nodeId !== cur.nodeId) await assertNode(tx, cur.productId, next.nodeId);
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    const [row] = await tx
      .update(requirements)
      .set({ ...next, updatedAt: changes.length ? new Date() : cur.updatedAt })
      .where(eq(requirements.id, requirementId))
      .returning();
    if (changes.length) {
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: cur.productId,
        type: 'requirement.updated',
        subjectType: 'requirement',
        subjectId: requirementId,
        actor,
        payload: { changes },
      });
    }
    const [item] = await hydrateList(tx, await productKeyOf(tx, cur.productId), [row!]);
    return item!;
  });
}

export async function setRequirementField(db: Db, actor: Actor, requirementId: string, fieldKey: string, optionIds: string[]): Promise<OptionRef[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const field = (await effectiveFields(tx, cur.productId)).get(fieldKey);
    if (!field) throw new AppError('not_found', `字段「${fieldKey}」不存在`);
    const before = await tx
      .select({ optionId: fieldValues.optionId })
      .from(fieldValues)
      .where(and(eq(fieldValues.entityId, requirementId), eq(fieldValues.fieldId, field.id)));
    const previous = before.map((b) => b.optionId);
    const ids = resolveOptions(field, optionIds, previous);
    await replaceFieldValues(tx, actor.orgId, requirementId, field, ids);
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    const label = (id: string) => field.options.find((o) => o.id === id)?.label ?? id;
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.field_changed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { changes: [{ field: fieldKey, old: previous.map(label), new: ids.map(label) }] },
    });
    return ids.map((id) => {
      const o = field.options.find((x) => x.id === id)!;
      return { id: o.id, key: o.key, label: o.label, color: o.color };
    });
  });
}
```

- [ ] **Step 5: 实现 `lookups.ts`**

```ts
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { iterations, structureNodes } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';

export type StructureNodeView = { id: string; parentId: string | null; depth: number; name: string; status: 'active' | 'deprecated'; sort: number };
export type IterationBrief = {
  id: string;
  name: string;
  type: 'regular' | 'special';
  status: 'planning' | 'active' | 'done' | 'canceled';
  startDate: string;
  endDate: string;
};

export async function listStructureNodes(db: Db, actor: Actor, productId: string): Promise<StructureNodeView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const rows = await tx.select().from(structureNodes).where(eq(structureNodes.productId, productId)).orderBy(asc(structureNodes.depth), asc(structureNodes.sort), asc(structureNodes.name));
    return rows.map((n) => ({ id: n.id, parentId: n.parentId, depth: n.depth, name: n.name, status: n.status, sort: n.sort }));
  });
}

export async function listProductIterations(db: Db, actor: Actor, productId: string): Promise<IterationBrief[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const rows = await tx
      .select()
      .from(iterations)
      .where(and(isNull(iterations.deletedAt), or(eq(iterations.productId, productId), eq(iterations.type, 'special'))))
      .orderBy(desc(iterations.startDate), asc(iterations.name));
    return rows.map((i) => ({ id: i.id, name: i.name, type: i.type, status: i.status, startDate: i.startDate, endDate: i.endDate }));
  });
}
```

在 `packages/core/src/index.ts` 追加：

```ts
export * from './requirements/context';
export * from './requirements/requirements';
export * from './requirements/lookups';
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/requirements.test.ts`
Expected: PASS。再跑 `pnpm --filter @flower/core test` 与 `pnpm typecheck`。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/requirements packages/core/src/index.ts packages/core/test/requirements.test.ts
git commit -m "feat(core): 需求创建、列表筛选、修改与字段值"
```

---
### Task 4: 需求详情、状态流转（含强制流转）、检查项与会签

**Files:**
- Create: `packages/core/src/requirements/detail.ts`
- Create: `packages/core/src/requirements/transitions.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/requirement-workflow.test.ts`

**Interfaces:**
- Consumes: Task 2 全部导出；Task 3 的 `hydrateList`、`loadRequirement`、`effectiveFields`、`productWorkflowBody`、`memberNames`、`OptionRef`、`MemberRef`、`RequirementListItem`、`displayKey`
- Produces（`detail.ts`）：
  - `type CheckItemView = { key: string; label: string; type: 'single' | 'signoff'; state: CheckState; note: string | null; meta: Record<string, unknown>; updatedAt: Date | null; updatedBy: MemberRef | null; signers: Array<{ index: number; by: 'function_tag' | 'member' | 'product_role'; ref: string; label: string }>; signoffRule: 'all' | 'any' | null; signoffs: Array<{ id: string; signer: MemberRef; actedBy: MemberRef | null; ruleIndex: number; decision: 'passed' | 'rejected'; note: string | null; at: Date }>; canSign: number[]; canSignOnBehalf: number[] }`
  - `type RequirementDetail = RequirementListItem & { productKey: string; description: string; createdAt: Date; stateChangedAt: Date; myRole: ProductRole; canForce: boolean; workflow: { states: Array<{ key: string; label: string; color: string; category: string; group: string; order: number }> }; fields: Array<{ key: string; label: string; cardinality: 'single' | 'multi'; options: OptionRef[] }>; checkItems: CheckItemView[]; transitions: TransitionOption[]; history: Array<{ from: string | null; to: string; actor: MemberRef | null; forced: boolean; reason: string | null; at: Date }>; assignments: Array<{ member: MemberRef; functionTag: { id: string; name: string } | null; platform: OptionRef | null }>; blockers: Array<{ id: string; description: string; status: 'active' | 'resolved'; owner: MemberRef | null; createdAt: Date; resolvedAt: Date | null }>; relations: Array<{ type: string; direction: 'out' | 'in'; other: { id: string; displayKey: string; title: string } }>; releases: Array<{ id: string; versionName: string; platform: OptionRef | null; status: 'planned' | 'released'; releasedAt: Date | null }>; tasks: Array<{ id: string; title: string; assignee: MemberRef | null; status: 'todo' | 'doing' | 'done'; planStart: string | null; planDays: number | null }>; aliases: string[] }`
  - `getRequirementByKey(db, actor, key: string): Promise<RequirementDetail>`（`key` 为 `PAN-12` 或旧编号别名）
- Produces（`transitions.ts`）：
  - `transitionRequirement(db, actor, requirementId, input: { to: string; force?: boolean; reason?: string }): Promise<{ stateKey: string }>`
  - `setCheckItemState(db, actor, requirementId, itemKey: string, input: { state: CheckState; note?: string | null }): Promise<{ state: CheckState }>`
  - `signCheckItem(db, actor, requirementId, itemKey: string, input: { decision: 'passed' | 'rejected'; note?: string | null; ruleIndex?: number; onBehalf?: boolean }): Promise<{ state: CheckState }>`
- 事件：`requirement.state_changed`（`changes`、`forced`、`reason`）、`check_item.updated`（`changes`）、`check_item.signed`（`ruleIndex`、`decision`、`onBehalf`、`changes`）
- 错误：条件不满足时 `AppError('invalid', '流转条件未满足', { unmet: string[] })`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/requirement-workflow.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkItemSignoffs, entityAliases, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { setCheckItemState, signCheckItem, transitionRequirement } from '../src/requirements/transitions';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createPlaceholderMember, setMemberFunctionTags } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let boss: Actor;
let editor: Actor;
let reqId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  const productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  await setMemberFunctionTags(t.db, owner, owner.memberId, [designTag]);
  const bossMember = await createPlaceholderMember(t.db, owner, { displayName: '老板' });
  await setProductRole(t.db, owner, productId, bossMember.id, 'viewer');
  boss = { ...owner, memberId: bossMember.id, orgRole: 'member', accountId: null };
  const ed = await createPlaceholderMember(t.db, owner, { displayName: '编辑丙' });
  editor = { ...owner, memberId: ed.id, orgRole: 'member', accountId: null };
  const { version } = await createWorkflowTemplate(t.db, owner, {
    name: '评审流程',
    body: {
      states: [
        { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
        { key: 'todo', label: '待开发', color: '#60a5fa', order: 2, group: '', category: 'unstarted' },
        { key: 'doing', label: '开发中', color: '#f59e0b', order: 3, group: '', category: 'started' },
      ],
      initial: 'backlog',
      transitions: [
        { from: '*', to: 'todo', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed', 'not_needed'] }] },
        { from: '*', to: 'doing', conditions: [{ type: 'has_iteration' }] },
        { from: '*', to: 'backlog', conditions: [] },
      ],
      checkItems: [
        { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' },
        {
          key: 'design',
          label: '设计签字',
          scope: 'requirement',
          type: 'signoff',
          signers: [
            { by: 'function_tag', ref: designTag },
            { by: 'member', ref: bossMember.id },
          ],
          signoffRule: 'all',
        },
      ],
    },
  });
  await setProductWorkflowVersion(t.db, owner, productId, version.id);
  reqId = (await createRequirement(t.db, owner, productId, { title: '分享链接加密码' })).id;
  await withOrg(t.db, owner.orgId, (tx) =>
    tx.insert(entityAliases).values({ orgId: owner.orgId, entityType: 'requirement', entityId: reqId, alias: 'X20260312012' }),
  );
});
afterAll(() => t.cleanup());

describe('需求详情', () => {
  it('按编号或旧编号打开，给出可流转目标和卡住的原因', async () => {
    const d = await getRequirementByKey(t.db, owner, 'PAN-1');
    expect(d).toMatchObject({ displayKey: 'PAN-1', productKey: 'PAN', stateKey: 'backlog', myRole: 'admin', canForce: true, aliases: ['X20260312012'] });
    expect(d.transitions).toEqual([
      { to: 'todo', label: '待开发', allowed: false, unmet: [expect.objectContaining({ message: '「可行性」需为通过或不需要（当前：未开始）' })] },
      { to: 'doing', label: '开发中', allowed: false, unmet: [expect.objectContaining({ message: '需要先加入迭代' })] },
    ]);
    expect(d.checkItems.map((c) => [c.key, c.state])).toEqual([
      ['feasibility', 'not_started'],
      ['design', 'not_started'],
    ]);
    expect(d.checkItems[1]).toMatchObject({ canSign: [0], canSignOnBehalf: [1], signers: [{ label: '设计' }, { label: '老板' }] });
    expect(d.history).toMatchObject([{ from: null, to: 'backlog' }]);
    expect((await getRequirementByKey(t.db, owner, 'X20260312012')).id).toBe(reqId);
    await expect(getRequirementByKey(t.db, owner, 'PAN-99')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('状态流转', () => {
  it('条件不满足时拒绝，并返回原因', async () => {
    await expect(transitionRequirement(t.db, owner, reqId, { to: 'todo' })).rejects.toMatchObject({
      code: 'invalid',
      details: { unmet: ['「可行性」需为通过或不需要（当前：未开始）'] },
    });
  });

  it('检查项满足后可以流转，历史记录新增一条', async () => {
    await setCheckItemState(t.db, owner, reqId, 'feasibility', { state: 'passed', note: '评估通过' });
    expect(await transitionRequirement(t.db, owner, reqId, { to: 'todo' })).toEqual({ stateKey: 'todo' });
    const d = await getRequirementByKey(t.db, owner, 'PAN-1');
    expect(d.history.map((h) => h.to)).toEqual(['backlog', 'todo']);
    expect(d.checkItems[0]).toMatchObject({ state: 'passed', note: '评估通过' });
  });

  it('强制流转仅产品管理员可用，且必须填写原因', async () => {
    await expect(transitionRequirement(t.db, boss, reqId, { to: 'doing', force: true, reason: '上线' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(transitionRequirement(t.db, owner, reqId, { to: 'doing', force: true, reason: ' ' })).rejects.toMatchObject({ code: 'invalid' });
    await transitionRequirement(t.db, owner, reqId, { to: 'doing', force: true, reason: '线上紧急修复' });
    const d = await getRequirementByKey(t.db, owner, 'PAN-1');
    expect(d.history.at(-1)).toMatchObject({ to: 'doing', forced: true, reason: '线上紧急修复' });
  });

  it('不能流转到当前状态或不存在的状态', async () => {
    await expect(transitionRequirement(t.db, owner, reqId, { to: 'doing' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(transitionRequirement(t.db, owner, reqId, { to: 'nope' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('检查项与会签', () => {
  it('会签检查项不能直接设置状态', async () => {
    await expect(setCheckItemState(t.db, owner, reqId, 'design', { state: 'passed' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('按签字规则逐一签字，全部通过后检查项通过', async () => {
    expect(await signCheckItem(t.db, owner, reqId, 'design', { decision: 'passed' })).toEqual({ state: 'in_progress' });
    await expect(signCheckItem(t.db, editor, reqId, 'design', { decision: 'passed' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await signCheckItem(t.db, boss, reqId, 'design', { decision: 'passed' })).toEqual({ state: 'passed' });
  });

  it('产品管理员可以代签"指定成员"规则，并记录实际操作人', async () => {
    expect(await signCheckItem(t.db, owner, reqId, 'design', { decision: 'rejected', ruleIndex: 1, onBehalf: true, note: '老板电话驳回' })).toEqual({
      state: 'rejected',
    });
    const d = await getRequirementByKey(t.db, owner, 'PAN-1');
    const last = d.checkItems[1]!.signoffs.at(-1)!;
    expect(last).toMatchObject({ signer: { displayName: '老板' }, actedBy: { id: owner.memberId }, ruleIndex: 1, decision: 'rejected' });
    await expect(signCheckItem(t.db, owner, reqId, 'design', { decision: 'passed', ruleIndex: 0, onBehalf: true })).rejects.toMatchObject({ code: 'invalid' });
    await expect(signCheckItem(t.db, boss, reqId, 'design', { decision: 'passed', ruleIndex: 1, onBehalf: true })).rejects.toMatchObject({ code: 'forbidden' });
    const rows = await withOrg(t.db, owner.orgId, (tx) => tx.select().from(checkItemSignoffs));
    expect(rows.filter((r) => r.actedByMemberId === owner.memberId)).toHaveLength(1);
  });

  it('流转后需求的更新时间和状态时间都会刷新', async () => {
    const [r] = await withOrg(t.db, owner.orgId, (tx) => tx.select().from(requirements).where(and(eq(requirements.id, reqId))));
    expect(r!.stateChangedAt.getTime()).toBeGreaterThan(r!.createdAt.getTime());
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/requirement-workflow.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `detail.ts`**

```ts
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { productRoleOf } from '../access/permissions';
import type { Db } from '../db/client';
import {
  blockers,
  checkItemResults,
  checkItemSignoffs,
  entityAliases,
  fieldDefinitions,
  fieldOptions,
  fieldValues,
  functionTags,
  memberFunctionTags,
  products,
  releases,
  requirementAssignments,
  requirementRelations,
  requirementReleases,
  requirements,
  stateTransitions,
  tasks,
} from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { effectiveFields, memberNames, productWorkflowBody } from './context';
import type { CheckState } from './labels';
import { displayKey, hydrateList, type MemberRef, type OptionRef, type RequirementListItem } from './requirements';
import { availableTransitions, checkStatesFor, matchingSignerRules, type TransitionOption } from './workflow-runtime';

export type CheckItemView = {
  key: string;
  label: string;
  type: 'single' | 'signoff';
  state: CheckState;
  note: string | null;
  meta: Record<string, unknown>;
  updatedAt: Date | null;
  updatedBy: MemberRef | null;
  signers: Array<{ index: number; by: 'function_tag' | 'member' | 'product_role'; ref: string; label: string }>;
  signoffRule: 'all' | 'any' | null;
  signoffs: Array<{ id: string; signer: MemberRef; actedBy: MemberRef | null; ruleIndex: number; decision: 'passed' | 'rejected'; note: string | null; at: Date }>;
  canSign: number[];
  canSignOnBehalf: number[];
};

export type RequirementDetail = RequirementListItem & {
  productKey: string;
  description: string;
  createdAt: Date;
  stateChangedAt: Date;
  myRole: ProductRole;
  canForce: boolean;
  workflow: { states: Array<{ key: string; label: string; color: string; category: string; group: string; order: number }> };
  fields: Array<{ key: string; label: string; cardinality: 'single' | 'multi'; options: OptionRef[] }>;
  checkItems: CheckItemView[];
  transitions: TransitionOption[];
  history: Array<{ from: string | null; to: string; actor: MemberRef | null; forced: boolean; reason: string | null; at: Date }>;
  assignments: Array<{ member: MemberRef; functionTag: { id: string; name: string } | null; platform: OptionRef | null }>;
  blockers: Array<{ id: string; description: string; status: 'active' | 'resolved'; owner: MemberRef | null; createdAt: Date; resolvedAt: Date | null }>;
  relations: Array<{ type: string; direction: 'out' | 'in'; other: { id: string; displayKey: string; title: string } }>;
  releases: Array<{ id: string; versionName: string; platform: OptionRef | null; status: 'planned' | 'released'; releasedAt: Date | null }>;
  tasks: Array<{ id: string; title: string; assignee: MemberRef | null; status: 'todo' | 'doing' | 'done'; planStart: string | null; planDays: number | null }>;
  aliases: string[];
};

const PRODUCT_ROLE_SIGNER_LABEL: Record<string, string> = { admin: '产品管理员', editor: '产品编辑', viewer: '产品只读成员' };

async function resolveKey(tx: Tx, key: string): Promise<typeof requirements.$inferSelect> {
  const m = /^([A-Z][A-Z0-9]{1,9})-(\d{1,9})$/.exec(key.trim());
  let row: typeof requirements.$inferSelect | undefined;
  if (m) {
    [row] = await tx
      .select({ r: requirements })
      .from(requirements)
      .innerJoin(products, eq(products.id, requirements.productId))
      .where(and(eq(products.key, m[1]!), eq(requirements.number, Number(m[2])), isNull(requirements.deletedAt), isNull(products.deletedAt)))
      .then((rows) => rows.map((x) => x.r));
  }
  if (!row) {
    const [alias] = await tx.select().from(entityAliases).where(and(eq(entityAliases.alias, key.trim()), eq(entityAliases.entityType, 'requirement')));
    if (alias) [row] = await tx.select().from(requirements).where(and(eq(requirements.id, alias.entityId), isNull(requirements.deletedAt)));
  }
  if (!row) throw new AppError('not_found', '需求不存在');
  return row;
}

async function signerIdentity(tx: Tx, actor: Actor, role: ProductRole) {
  const tags = await tx.select({ tagId: memberFunctionTags.tagId }).from(memberFunctionTags).where(eq(memberFunctionTags.memberId, actor.memberId));
  return { memberId: actor.memberId, functionTagIds: tags.map((x) => x.tagId), productRole: role };
}

export async function getRequirementByKey(db: Db, actor: Actor, key: string): Promise<RequirementDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const row = await resolveKey(tx, key);
    const role = await productRoleOf(tx, actor, row.productId);
    if (!role) throw new AppError('not_found', '需求不存在');
    const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.id, row.productId));
    const [base] = await hydrateList(tx, product!.key, [row]);
    const body = await productWorkflowBody(tx, row.productId);
    const fields = await effectiveFields(tx, row.productId);

    const values = await tx
      .select({ fieldId: fieldValues.fieldId, fieldKey: fieldDefinitions.key, id: fieldOptions.id, key: fieldOptions.key, label: fieldOptions.label, color: fieldOptions.color, sort: fieldOptions.sort })
      .from(fieldValues)
      .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
      .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
      .where(eq(fieldValues.entityId, row.id));
    const fieldList = [...fields.values()].map((f) => ({
      key: f.key,
      label: f.label,
      cardinality: f.cardinality,
      options: values
        .filter((v) => v.fieldKey === f.key)
        .sort((a, b) => a.sort - b.sort)
        .map((v) => ({ id: v.id, key: v.key, label: v.label, color: v.color })),
    }));

    const results = await tx.select().from(checkItemResults).where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, row.id)));
    const signoffs = results.length
      ? await tx.select().from(checkItemSignoffs).where(inArray(checkItemSignoffs.resultId, results.map((r) => r.id))).orderBy(asc(checkItemSignoffs.at), asc(checkItemSignoffs.id))
      : [];
    const history = await tx.select().from(stateTransitions).where(eq(stateTransitions.requirementId, row.id)).orderBy(asc(stateTransitions.at));
    const assignments = await tx.select().from(requirementAssignments).where(eq(requirementAssignments.requirementId, row.id));
    const blockerRows = await tx.select().from(blockers).where(eq(blockers.requirementId, row.id)).orderBy(asc(blockers.createdAt));
    const relationRows = await tx
      .select()
      .from(requirementRelations)
      .where(or(eq(requirementRelations.fromId, row.id), eq(requirementRelations.toId, row.id)));
    const releaseRows = await tx
      .select({ r: releases })
      .from(requirementReleases)
      .innerJoin(releases, eq(releases.id, requirementReleases.releaseId))
      .where(eq(requirementReleases.requirementId, row.id));
    const taskRows = await tx.select().from(tasks).where(eq(tasks.requirementId, row.id)).orderBy(asc(tasks.planStart), asc(tasks.createdAt));
    const aliasRows = await tx.select({ alias: entityAliases.alias }).from(entityAliases).where(eq(entityAliases.entityId, row.id));

    const signerMemberIds = body.checkItems.flatMap((c) => c.signers ?? []).filter((s) => s.by === 'member').map((s) => s.ref);
    const names = await memberNames(tx, [
      ...signoffs.flatMap((s) => [s.signerMemberId, s.actedByMemberId]),
      ...results.map((r) => r.updatedBy),
      ...history.map((h) => h.actorMemberId),
      ...assignments.map((a) => a.memberId),
      ...blockerRows.map((b) => b.ownerMemberId),
      ...taskRows.map((x) => x.assigneeMemberId),
      ...signerMemberIds,
    ]);
    const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
    const tagIds = [
      ...new Set([
        ...assignments.map((a) => a.functionTagId).filter((x): x is string => !!x),
        ...body.checkItems.flatMap((c) => c.signers ?? []).filter((s) => s.by === 'function_tag').map((s) => s.ref),
      ]),
    ];
    const tagRows = tagIds.length ? await tx.select({ id: functionTags.id, name: functionTags.name }).from(functionTags).where(inArray(functionTags.id, tagIds)) : [];
    const tagName = new Map(tagRows.map((x) => [x.id, x.name]));
    const optionIds = [
      ...new Set([...assignments.map((a) => a.platformOptionId), ...releaseRows.map((x) => x.r.platformOptionId)].filter((x): x is string => !!x)),
    ];
    const optionRows = optionIds.length ? await tx.select().from(fieldOptions).where(inArray(fieldOptions.id, optionIds)) : [];
    const optionRef = (id: string | null): OptionRef | null => {
      const o = id ? optionRows.find((x) => x.id === id) : undefined;
      return o ? { id: o.id, key: o.key, label: o.label, color: o.color } : null;
    };
    const otherIds = relationRows.map((r) => (r.fromId === row.id ? r.toId : r.fromId));
    const others = otherIds.length ? await tx.select().from(requirements).where(inArray(requirements.id, otherIds)) : [];

    const identity = await signerIdentity(tx, actor, role);
    const states = checkStatesFor(body, results.map((r) => ({ itemKey: r.itemKey, state: r.state })));
    const checkItems: CheckItemView[] = body.checkItems
      .filter((c) => c.scope === 'requirement')
      .map((c) => {
        const result = results.find((r) => r.itemKey === c.key);
        const signers = (c.signers ?? []).map((s, index) => ({
          index,
          by: s.by,
          ref: s.ref,
          label: s.by === 'function_tag' ? (tagName.get(s.ref) ?? '已删除的标签') : s.by === 'member' ? (names.get(s.ref) ?? '已删除的成员') : (PRODUCT_ROLE_SIGNER_LABEL[s.ref] ?? s.ref),
        }));
        return {
          key: c.key,
          label: c.label,
          type: c.type,
          state: states[c.key]!,
          note: result?.note ?? null,
          meta: result?.meta ?? {},
          updatedAt: result?.updatedAt ?? null,
          updatedBy: ref(result?.updatedBy ?? null),
          signers,
          signoffRule: c.signoffRule ?? null,
          signoffs: signoffs
            .filter((s) => s.resultId === result?.id)
            .map((s) => ({ id: s.id, signer: ref(s.signerMemberId)!, actedBy: ref(s.actedByMemberId), ruleIndex: s.signerRuleIndex, decision: s.decision, note: s.note, at: s.at })),
          canSign: c.type === 'signoff' ? matchingSignerRules(c, identity) : [],
          canSignOnBehalf: c.type === 'signoff' && role === 'admin' ? signers.filter((s) => s.by === 'member' && s.ref !== actor.memberId).map((s) => s.index) : [],
        };
      });

    const ctx = {
      checks: states,
      filledFields: new Set(fieldList.filter((f) => f.options.length > 0).map((f) => f.key)),
      hasIteration: row.iterationId !== null,
      hasChangeDocument: row.changeDocumentId !== null,
    };
    const lookup = { checkItem: (k: string) => body.checkItems.find((c) => c.key === k)?.label ?? k, field: (k: string) => fields.get(k)?.label ?? k };

    return {
      ...base!,
      productKey: product!.key,
      description: row.description,
      createdAt: row.createdAt,
      stateChangedAt: row.stateChangedAt,
      myRole: role,
      canForce: role === 'admin',
      workflow: { states: [...body.states].sort((a, b) => a.order - b.order).map((s) => ({ key: s.key, label: s.label, color: s.color, category: s.category, group: s.group, order: s.order })) },
      fields: fieldList,
      checkItems,
      transitions: availableTransitions(body, row.stateKey, ctx, lookup),
      history: history.map((h) => ({ from: h.fromState, to: h.toState, actor: ref(h.actorMemberId), forced: h.forced, reason: h.reason, at: h.at })),
      assignments: assignments.map((a) => ({
        member: ref(a.memberId)!,
        functionTag: a.functionTagId ? { id: a.functionTagId, name: tagName.get(a.functionTagId) ?? '' } : null,
        platform: optionRef(a.platformOptionId),
      })),
      blockers: blockerRows.map((b) => ({ id: b.id, description: b.description, status: b.status, owner: ref(b.ownerMemberId), createdAt: b.createdAt, resolvedAt: b.resolvedAt })),
      relations: relationRows.map((r) => {
        const otherId = r.fromId === row.id ? r.toId : r.fromId;
        const o = others.find((x) => x.id === otherId);
        return { type: r.type, direction: r.fromId === row.id ? ('out' as const) : ('in' as const), other: { id: otherId, displayKey: o ? displayKey(product!.key, o.number) : '', title: o?.title ?? '' } };
      }),
      releases: releaseRows.map(({ r }) => ({ id: r.id, versionName: r.versionName, platform: optionRef(r.platformOptionId), status: r.status, releasedAt: r.releasedAt })),
      tasks: taskRows.map((x) => ({ id: x.id, title: x.title, assignee: ref(x.assigneeMemberId), status: x.status, planStart: x.planStart, planDays: x.planDays })),
      aliases: aliasRows.map((a) => a.alias).sort(),
    };
  });
}
```

- [ ] **Step 4: 实现 `transitions.ts`**

```ts
import { and, asc, eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, checkItemSignoffs, fieldDefinitions, fieldValues, memberFunctionTags, requirements, stateTransitions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { CHECK_STATES } from '../definitions/workflow-schema';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { effectiveFields, loadRequirement, productWorkflowBody } from './context';
import type { CheckState } from './labels';
import { checkStatesFor, findTransitionRule, matchingSignerRules, signoffResultState, unmetConditions } from './workflow-runtime';

async function ensureResult(tx: Tx, orgId: string, requirementId: string, itemKey: string, defaultState: CheckState) {
  const [existing] = await tx
    .select()
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, requirementId), eq(checkItemResults.itemKey, itemKey)));
  if (existing) return existing;
  const [row] = await tx.insert(checkItemResults).values({ orgId, targetType: 'requirement', targetId: requirementId, itemKey, state: defaultState }).returning();
  return row!;
}

export async function transitionRequirement(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { to: string; force?: boolean; reason?: string },
): Promise<{ stateKey: string }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirement(tx, requirementId);
    const role = await requireProductRole(tx, actor, cur.productId, 'editor');
    const body = await productWorkflowBody(tx, cur.productId);
    const target = body.states.find((s) => s.key === input.to);
    if (!target) throw new AppError('invalid', '目标状态不存在');
    if (input.to === cur.stateKey) throw new AppError('invalid', '需求已处于该状态');
    const reason = input.reason?.trim() || null;
    if (input.force) {
      if (role !== 'admin') throw new AppError('forbidden', '只有产品管理员可以强制流转');
      if (!reason || reason.length > 500) throw new AppError('invalid', '强制流转必须填写原因（不超过 500 个字符）');
    } else {
      const from = body.states.find((s) => s.key === cur.stateKey)?.label ?? cur.stateKey;
      const rule = findTransitionRule(body, cur.stateKey, input.to);
      if (!rule) throw new AppError('invalid', `不能从「${from}」流转到「${target.label}」`);
      const results = await tx
        .select({ itemKey: checkItemResults.itemKey, state: checkItemResults.state })
        .from(checkItemResults)
        .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, requirementId)));
      const fields = await effectiveFields(tx, cur.productId);
      const filled = await tx
        .selectDistinct({ key: fieldDefinitions.key })
        .from(fieldValues)
        .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
        .where(eq(fieldValues.entityId, requirementId));
      const unmet = unmetConditions(
        rule.conditions,
        {
          checks: checkStatesFor(body, results),
          filledFields: new Set(filled.map((f) => f.key)),
          hasIteration: cur.iterationId !== null,
          hasChangeDocument: cur.changeDocumentId !== null,
        },
        { checkItem: (k) => body.checkItems.find((c) => c.key === k)?.label ?? k, field: (k) => fields.get(k)?.label ?? k },
      );
      if (unmet.length > 0) throw new AppError('invalid', '流转条件未满足', { unmet: unmet.map((u) => u.message) });
    }
    const now = new Date();
    await tx.update(requirements).set({ stateKey: input.to, stateChangedAt: now, updatedAt: now }).where(eq(requirements.id, requirementId));
    await tx.insert(stateTransitions).values({
      orgId: actor.orgId,
      requirementId,
      fromState: cur.stateKey,
      toState: input.to,
      actorMemberId: actor.memberId,
      tokenId: actor.tokenId,
      forced: !!input.force,
      reason: input.force ? reason : null,
      at: now,
    });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.state_changed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { changes: [{ field: 'stateKey', old: cur.stateKey, new: input.to }], forced: !!input.force, reason: input.force ? reason : null },
    });
    return { stateKey: input.to };
  });
}

export async function setCheckItemState(
  db: Db,
  actor: Actor,
  requirementId: string,
  itemKey: string,
  input: { state: CheckState; note?: string | null },
): Promise<{ state: CheckState }> {
  if (!(CHECK_STATES as readonly string[]).includes(input.state)) throw new AppError('invalid', '检查状态无效');
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const body = await productWorkflowBody(tx, cur.productId);
    const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'requirement');
    if (!item) throw new AppError('not_found', '检查项不存在');
    if (item.type === 'signoff') throw new AppError('invalid', '会签检查项的状态由签字结果决定');
    const result = await ensureResult(tx, actor.orgId, requirementId, itemKey, item.defaultState);
    const note = input.note === undefined ? result.note : input.note?.trim() || null;
    const now = new Date();
    await tx.update(checkItemResults).set({ state: input.state, note, updatedBy: actor.memberId, updatedAt: now }).where(eq(checkItemResults.id, result.id));
    await tx.update(requirements).set({ updatedAt: now }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'check_item.updated',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { itemKey, changes: [{ field: 'state', old: result.state, new: input.state }, { field: 'note', old: result.note, new: note }].filter((c) => c.old !== c.new) },
    });
    return { state: input.state };
  });
}

export async function signCheckItem(
  db: Db,
  actor: Actor,
  requirementId: string,
  itemKey: string,
  input: { decision: 'passed' | 'rejected'; note?: string | null; ruleIndex?: number; onBehalf?: boolean },
): Promise<{ state: CheckState }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirement(tx, requirementId);
    const role = await requireProductRole(tx, actor, cur.productId, 'viewer');
    const body = await productWorkflowBody(tx, cur.productId);
    const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'requirement');
    if (!item) throw new AppError('not_found', '检查项不存在');
    if (item.type !== 'signoff') throw new AppError('invalid', '该检查项不需要会签');
    let signer = actor.memberId;
    let actedBy: string | null = null;
    let ruleIndex: number;
    if (input.onBehalf) {
      if (role !== 'admin') throw new AppError('forbidden', '只有产品管理员可以代签');
      const rule = input.ruleIndex === undefined ? undefined : item.signers?.[input.ruleIndex];
      if (!rule || rule.by !== 'member') throw new AppError('invalid', '只能代签"指定成员"类的签字规则');
      ruleIndex = input.ruleIndex!;
      signer = rule.ref;
      actedBy = actor.memberId;
    } else {
      const tags = await tx.select({ tagId: memberFunctionTags.tagId }).from(memberFunctionTags).where(eq(memberFunctionTags.memberId, actor.memberId));
      const matches = matchingSignerRules(item, { memberId: actor.memberId, functionTagIds: tags.map((x) => x.tagId), productRole: role });
      if (matches.length === 0) throw new AppError('forbidden', '你不在该检查项的签字人中');
      if (input.ruleIndex !== undefined && !matches.includes(input.ruleIndex)) throw new AppError('forbidden', '你不能代表这条签字规则签字');
      ruleIndex = input.ruleIndex ?? matches[0]!;
    }
    const result = await ensureResult(tx, actor.orgId, requirementId, itemKey, item.defaultState);
    const now = new Date();
    await tx.insert(checkItemSignoffs).values({
      orgId: actor.orgId,
      resultId: result.id,
      signerMemberId: signer,
      actedByMemberId: actedBy,
      signerRuleIndex: ruleIndex,
      decision: input.decision,
      note: input.note?.trim() || null,
      at: now,
    });
    const all = await tx.select().from(checkItemSignoffs).where(eq(checkItemSignoffs.resultId, result.id)).orderBy(asc(checkItemSignoffs.at), asc(checkItemSignoffs.id));
    const state = signoffResultState(item, all.map((s) => ({ signerRuleIndex: s.signerRuleIndex, decision: s.decision, at: s.at })));
    await tx.update(checkItemResults).set({ state, updatedBy: actor.memberId, updatedAt: now }).where(eq(checkItemResults.id, result.id));
    await tx.update(requirements).set({ updatedAt: now }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'check_item.signed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { itemKey, ruleIndex, decision: input.decision, onBehalf: !!input.onBehalf, changes: result.state === state ? [] : [{ field: 'state', old: result.state, new: state }] },
    });
    return { state };
  });
}
```

签字记录一律按 `(at, id)` 排序：UUIDv7 随时间递增，同一时刻的多次签字按插入顺序计算最新结论。

在 `packages/core/src/index.ts` 追加：

```ts
export * from './requirements/detail';
export * from './requirements/transitions';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/requirement-workflow.test.ts`
Expected: PASS。再跑 `pnpm --filter @flower/core test` 与 `pnpm typecheck`。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/requirements packages/core/src/index.ts packages/core/test/requirement-workflow.test.ts
git commit -m "feat(core): 需求详情、状态流转、检查项与会签"
```

---
### Task 5: 评论与已读

**Files:**
- Create: `packages/core/src/requirements/comments.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/comments.test.ts`

**Interfaces:**
- Consumes: `loadRequirement`、`memberNames`、`requireProductRole`、`MemberRef`
- Produces:
  - `type CommentView = { id: string; parentId: string | null; author: MemberRef | null; body: string; kind: 'comment' | 'update'; createdAt: Date; read: boolean }`
  - `listRequirementComments(db, actor, requirementId): Promise<CommentView[]>`（按时间正序；`read` 表示当前成员已读）
  - `addRequirementComment(db, actor, requirementId, input: { body: string; kind?: 'comment' | 'update'; parentId?: string | null }): Promise<CommentView>`（作者自动视为已读）
  - `markRequirementCommentsRead(db, actor, requirementId): Promise<number>`（返回新标记的条数）
- 事件：`comment.created`（`subjectType: 'requirement'`，payload `{ commentId, kind }`）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/comments.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { addRequirementComment, listRequirementComments, markRequirementCommentsRead } from '../src/requirements/comments';
import { createRequirement } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let outsider: Actor;
let reqId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  const productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读乙' });
  await setProductRole(t.db, owner, productId, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
  const g = await createPlaceholderMember(t.db, owner, { displayName: '访客丁' });
  outsider = { ...owner, memberId: g.id, orgRole: 'guest', accountId: null };
  reqId = (await createRequirement(t.db, owner, productId, { title: '回收站保留 30 天' })).id;
});
afterAll(() => t.cleanup());

describe('需求评论', () => {
  it('只读成员也能评论，作者自己的评论视为已读', async () => {
    const c = await addRequirementComment(t.db, viewer, reqId, { body: '能否延长到 60 天？' });
    expect(c).toMatchObject({ author: { displayName: '只读乙' }, kind: 'comment', read: true });
    await addRequirementComment(t.db, owner, reqId, { body: '本周排期评估', kind: 'update' });
    const forViewer = await listRequirementComments(t.db, viewer, reqId);
    expect(forViewer.map((x) => [x.body, x.read])).toEqual([
      ['能否延长到 60 天？', true],
      ['本周排期评估', false],
    ]);
  });

  it('标记已读只记录未读的评论', async () => {
    expect(await markRequirementCommentsRead(t.db, viewer, reqId)).toBe(1);
    expect(await markRequirementCommentsRead(t.db, viewer, reqId)).toBe(0);
    expect((await listRequirementComments(t.db, viewer, reqId)).every((x) => x.read)).toBe(true);
  });

  it('空评论和无权访问的成员被拒绝', async () => {
    await expect(addRequirementComment(t.db, owner, reqId, { body: '  ' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(listRequirementComments(t.db, outsider, reqId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('回复必须指向同一需求下的评论', async () => {
    const [first] = await listRequirementComments(t.db, owner, reqId);
    const reply = await addRequirementComment(t.db, owner, reqId, { body: '可以', parentId: first!.id });
    expect(reply.parentId).toBe(first!.id);
    await expect(addRequirementComment(t.db, owner, reqId, { body: 'x', parentId: reqId })).rejects.toMatchObject({ code: 'invalid' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/comments.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `comments.ts`**

```ts
import { and, asc, eq, notInArray } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { commentReads, comments } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { loadRequirement, memberNames } from './context';
import type { MemberRef } from './requirements';

export type CommentView = {
  id: string;
  parentId: string | null;
  author: MemberRef | null;
  body: string;
  kind: 'comment' | 'update';
  createdAt: Date;
  read: boolean;
};

const onRequirement = (requirementId: string) => and(eq(comments.targetType, 'requirement'), eq(comments.targetId, requirementId));

export async function listRequirementComments(db: Db, actor: Actor, requirementId: string): Promise<CommentView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'viewer');
    const rows = await tx.select().from(comments).where(onRequirement(requirementId)).orderBy(asc(comments.createdAt), asc(comments.id));
    const reads = await tx
      .select({ commentId: commentReads.commentId })
      .from(commentReads)
      .innerJoin(comments, eq(comments.id, commentReads.commentId))
      .where(and(onRequirement(requirementId), eq(commentReads.memberId, actor.memberId)));
    const readSet = new Set(reads.map((r) => r.commentId));
    const names = await memberNames(tx, rows.map((r) => r.authorMemberId));
    return rows.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      author: c.authorMemberId ? { id: c.authorMemberId, displayName: names.get(c.authorMemberId) ?? '已删除的成员' } : null,
      body: c.body,
      kind: c.kind,
      createdAt: c.createdAt,
      read: readSet.has(c.id),
    }));
  });
}

export async function addRequirementComment(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { body: string; kind?: 'comment' | 'update'; parentId?: string | null },
): Promise<CommentView> {
  const body = input.body.trim();
  if (!body || body.length > 10_000) throw new AppError('invalid', '评论不能为空，且不超过 10000 个字符');
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'viewer');
    if (input.parentId) {
      const [parent] = await tx.select().from(comments).where(and(eq(comments.id, input.parentId), onRequirement(requirementId)));
      if (!parent) throw new AppError('invalid', '回复的评论不存在');
    }
    const [row] = await tx
      .insert(comments)
      .values({ orgId: actor.orgId, targetType: 'requirement', targetId: requirementId, parentId: input.parentId ?? null, authorMemberId: actor.memberId, body, kind: input.kind ?? 'comment' })
      .returning();
    await tx.insert(commentReads).values({ orgId: actor.orgId, commentId: row!.id, memberId: actor.memberId });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: req.productId,
      type: 'comment.created',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { commentId: row!.id, kind: row!.kind },
    });
    const names = await memberNames(tx, [actor.memberId]);
    return {
      id: row!.id,
      parentId: row!.parentId,
      author: { id: actor.memberId, displayName: names.get(actor.memberId) ?? '' },
      body: row!.body,
      kind: row!.kind,
      createdAt: row!.createdAt,
      read: true,
    };
  });
}

export async function markRequirementCommentsRead(db: Db, actor: Actor, requirementId: string): Promise<number> {
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'viewer');
    const already = tx.select({ id: commentReads.commentId }).from(commentReads).where(eq(commentReads.memberId, actor.memberId));
    const unread = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(and(onRequirement(requirementId), notInArray(comments.id, already)));
    if (unread.length === 0) return 0;
    await tx
      .insert(commentReads)
      .values(unread.map((c) => ({ orgId: actor.orgId, commentId: c.id, memberId: actor.memberId })))
      .onConflictDoNothing();
    return unread.length;
  });
}
```

在 `packages/core/src/index.ts` 追加：`export * from './requirements/comments';`

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/comments.test.ts`
Expected: PASS。再跑 `pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/requirements/comments.ts packages/core/src/index.ts packages/core/test/comments.test.ts
git commit -m "feat(core): 需求评论与已读"
```

---
### Task 6: 需求相关 HTTP 接口

**Files:**
- Create: `apps/web/src/server/routes/requirements.ts`
- Modify: `apps/web/src/server/api.ts`（注册路由）
- Test: `apps/web/test/api/requirements.test.ts`

**Interfaces:**
- Consumes: Task 3–5 的全部服务函数
- Produces（HTTP，前缀 `/api/v1`）：

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /orgs/:org/products/:id/requirements` | 查询参数：`state`、`node`、`priority`、`platform`、`owner`、`requester`、`iteration`（均为逗号分隔的 id 或 key 列表）、`noIteration=1`、`q`、`sort`（`updated`/`number`/`created`）、`page`、`pageSize` | `RequirementList` |
| `POST /orgs/:org/products/:id/requirements` | `{ title, description?, ownerMemberId?, requesterMemberId?, nodeId?, fields?: Record<string, string[]> }` | `201 { requirement: RequirementListItem }` |
| `GET /orgs/:org/products/:id/nodes` | — | `{ nodes: StructureNodeView[] }` |
| `GET /orgs/:org/products/:id/iterations` | — | `{ iterations: IterationBrief[] }` |
| `GET /orgs/:org/requirements/:key` | `key` 为 `PAN-12` 或旧编号 | `{ requirement: RequirementDetail }` |
| `PATCH /orgs/:org/requirements/:id` | `{ title?, description?, ownerMemberId?, requesterMemberId?, nodeId? }`（后三个可为 `null`） | `{ requirement: RequirementListItem }` |
| `PUT /orgs/:org/requirements/:id/fields/:fieldKey` | `{ optionIds: string[] }` | `{ options: OptionRef[] }` |
| `POST /orgs/:org/requirements/:id/transitions` | `{ to, force?, reason? }` | `{ stateKey }` |
| `PUT /orgs/:org/requirements/:id/checks/:itemKey` | `{ state, note? }` | `{ state }` |
| `POST /orgs/:org/requirements/:id/checks/:itemKey/signoffs` | `{ decision, note?, ruleIndex?, onBehalf? }` | `201 { state }` |
| `GET /orgs/:org/requirements/:id/comments` | — | `{ comments: CommentView[] }` |
| `POST /orgs/:org/requirements/:id/comments` | `{ body, kind?, parentId? }` | `201 { comment: CommentView }` |
| `POST /orgs/:org/requirements/:id/comments/read` | —（无请求体） | `{ marked: number }` |

- [ ] **Step 1: 写失败的测试**

`apps/web/test/api/requirements.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let p1: string;
beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const fields = (await call(app, 'GET', '/orgs/acme/fields', { session })).body.fields;
  p1 = fields.find((f: { key: string }) => f.key === 'priority').options.find((o: { key: string }) => o.key === 'p1').id;
});
afterAll(() => cleanup());

describe('需求接口', () => {
  it('创建、列表筛选与按编号查看详情', async () => {
    const created = await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, {
      session,
      body: { title: '离线下载支持磁力链接', fields: { priority: [p1] } },
    });
    expect(created.status).toBe(201);
    expect(created.body.requirement).toMatchObject({ displayKey: 'PAN-1', priority: { label: 'P1' } });
    await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '相册按地点归类' } });

    const list = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements?priority=${p1}&sort=number`, { session });
    expect(list.status).toBe(200);
    expect(list.body.items.map((r: { title: string }) => r.title)).toEqual(['离线下载支持磁力链接']);
    expect(list.body.stateCounts).toEqual({ backlog: 2 });
    const byQ = await call(app, 'GET', `/orgs/acme/products/${productId}/requirements?q=${encodeURIComponent('相册')}`, { session });
    expect(byQ.body.total).toBe(1);

    const detail = await call(app, 'GET', '/orgs/acme/requirements/PAN-1', { session });
    expect(detail.status).toBe(200);
    expect(detail.body.requirement).toMatchObject({ title: '离线下载支持磁力链接', stateKey: 'backlog', myRole: 'admin' });
    expect(detail.body.requirement.transitions.map((x: { to: string }) => x.to)).toContain('todo');
  });

  it('修改、设置字段、流转和评论', async () => {
    const d = (await call(app, 'GET', '/orgs/acme/requirements/PAN-2', { session })).body.requirement;
    const patched = await call(app, 'PATCH', `/orgs/acme/requirements/${d.id}`, { session, body: { title: '相册按地点和时间归类' } });
    expect(patched.body.requirement.title).toBe('相册按地点和时间归类');
    const f = await call(app, 'PUT', `/orgs/acme/requirements/${d.id}/fields/priority`, { session, body: { optionIds: [p1] } });
    expect(f.body.options.map((o: { label: string }) => o.label)).toEqual(['P1']);
    const tr = await call(app, 'POST', `/orgs/acme/requirements/${d.id}/transitions`, { session, body: { to: 'todo' } });
    expect(tr.body).toEqual({ stateKey: 'todo' });
    const bad = await call(app, 'POST', `/orgs/acme/requirements/${d.id}/transitions`, { session, body: { to: 'todo' } });
    expect(bad.status).toBe(400);
    const c = await call(app, 'POST', `/orgs/acme/requirements/${d.id}/comments`, { session, body: { body: '需要和相册团队确认' } });
    expect(c.status).toBe(201);
    const list = await call(app, 'GET', `/orgs/acme/requirements/${d.id}/comments`, { session });
    expect(list.body.comments).toHaveLength(1);
    const read = await call(app, 'POST', `/orgs/acme/requirements/${d.id}/comments/read`, { session });
    expect(read.body).toEqual({ marked: 0 });
  });

  it('节点与迭代列表、不存在的需求返回 404', async () => {
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/nodes`, { session })).body).toEqual({ nodes: [] });
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/iterations`, { session })).body).toEqual({ iterations: [] });
    expect((await call(app, 'GET', '/orgs/acme/requirements/PAN-404', { session })).status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run test/api/requirements.test.ts`
Expected: FAIL，接口返回 404。

- [ ] **Step 3: 实现路由**

`apps/web/src/server/routes/requirements.ts`：

```ts
import {
  addRequirementComment,
  CHECK_STATES,
  createRequirement,
  getRequirementByKey,
  listProductIterations,
  listRequirementComments,
  listRequirements,
  listStructureNodes,
  markRequirementCommentsRead,
  type RequirementFilter,
  setCheckItemState,
  setRequirementField,
  signCheckItem,
  transitionRequirement,
  updateRequirement,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, ApiEnv, App } from '../api';
import { readJson } from '../http';

const csv = (v: string | undefined): string[] | undefined => {
  const list = v?.split(',').map((s) => s.trim()).filter(Boolean);
  return list?.length ? list : undefined;
};

function filterFrom(c: Context<ApiEnv>): RequirementFilter {
  const q = (k: string) => c.req.query(k);
  const sort = q('sort');
  const num = (k: string) => {
    const n = Number.parseInt(q(k) ?? '', 10);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    states: csv(q('state')),
    nodeIds: csv(q('node')),
    priorityOptionIds: csv(q('priority')),
    platformOptionIds: csv(q('platform')),
    ownerIds: csv(q('owner')),
    requesterIds: csv(q('requester')),
    iterationIds: csv(q('iteration')),
    noIteration: q('noIteration') === '1',
    q: q('q') || undefined,
    sort: sort === 'number' || sort === 'created' ? sort : 'updated',
    page: num('page'),
    pageSize: num('pageSize'),
  };
}

export function registerRequirementRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/requirements', async (c) =>
    c.json(await listRequirements(deps.db, c.get('actor'), c.req.param('id'), filterFrom(c))),
  );

  app.post('/orgs/:org/products/:id/requirements', async (c) => {
    const body = await readJson(
      c,
      z.object({
        title: z.string(),
        description: z.string().optional(),
        ownerMemberId: z.string().nullable().optional(),
        requesterMemberId: z.string().nullable().optional(),
        nodeId: z.string().nullable().optional(),
        fields: z.record(z.string(), z.array(z.string())).optional(),
      }),
    );
    return c.json({ requirement: await createRequirement(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.get('/orgs/:org/products/:id/nodes', async (c) => c.json({ nodes: await listStructureNodes(deps.db, c.get('actor'), c.req.param('id')) }));

  app.get('/orgs/:org/products/:id/iterations', async (c) =>
    c.json({ iterations: await listProductIterations(deps.db, c.get('actor'), c.req.param('id')) }),
  );

  app.get('/orgs/:org/requirements/:key', async (c) =>
    c.json({ requirement: await getRequirementByKey(deps.db, c.get('actor'), c.req.param('key')) }),
  );

  app.patch('/orgs/:org/requirements/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        ownerMemberId: z.string().nullable().optional(),
        requesterMemberId: z.string().nullable().optional(),
        nodeId: z.string().nullable().optional(),
      }),
    );
    return c.json({ requirement: await updateRequirement(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.put('/orgs/:org/requirements/:id/fields/:fieldKey', async (c) => {
    const body = await readJson(c, z.object({ optionIds: z.array(z.string()) }));
    return c.json({ options: await setRequirementField(deps.db, c.get('actor'), c.req.param('id'), c.req.param('fieldKey'), body.optionIds) });
  });

  app.post('/orgs/:org/requirements/:id/transitions', async (c) => {
    const body = await readJson(c, z.object({ to: z.string(), force: z.boolean().optional(), reason: z.string().max(500).optional() }));
    return c.json(await transitionRequirement(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.put('/orgs/:org/requirements/:id/checks/:itemKey', async (c) => {
    const body = await readJson(c, z.object({ state: z.enum(CHECK_STATES), note: z.string().max(2000).nullable().optional() }));
    return c.json(await setCheckItemState(deps.db, c.get('actor'), c.req.param('id'), c.req.param('itemKey'), body));
  });

  app.post('/orgs/:org/requirements/:id/checks/:itemKey/signoffs', async (c) => {
    const body = await readJson(
      c,
      z.object({
        decision: z.enum(['passed', 'rejected']),
        note: z.string().max(2000).nullable().optional(),
        ruleIndex: z.number().int().min(0).optional(),
        onBehalf: z.boolean().optional(),
      }),
    );
    return c.json(await signCheckItem(deps.db, c.get('actor'), c.req.param('id'), c.req.param('itemKey'), body), 201);
  });

  app.get('/orgs/:org/requirements/:id/comments', async (c) =>
    c.json({ comments: await listRequirementComments(deps.db, c.get('actor'), c.req.param('id')) }),
  );

  app.post('/orgs/:org/requirements/:id/comments', async (c) => {
    const body = await readJson(
      c,
      z.object({ body: z.string().max(10_000), kind: z.enum(['comment', 'update']).optional(), parentId: z.string().nullable().optional() }),
    );
    return c.json({ comment: await addRequirementComment(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.post('/orgs/:org/requirements/:id/comments/read', async (c) =>
    c.json({ marked: await markRequirementCommentsRead(deps.db, c.get('actor'), c.req.param('id')) }),
  );
}
```

`apps/web/src/server/api.ts`：增加 `import { registerRequirementRoutes } from './routes/requirements';`，并在 `registerDefinitionRoutes(app, deps);` 之后调用 `registerRequirementRoutes(app, deps);`。

`POST …/comments/read` 不读请求体，与现有的 `POST /auth/logout` 一样；JSON 内容类型检查只在 `readJson` 中进行。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run test/api/requirements.test.ts`
Expected: PASS。再跑 `pnpm --filter @flower/web test` 与 `pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/server apps/web/test/api/requirements.test.ts
git commit -m "feat(web): 需求相关接口"
```

---
### Task 7: 迁移包骨架：旧数据类型、读取、确定性 ID、归一化

**Files:**
- Create: `packages/migrate/package.json`、`packages/migrate/tsconfig.json`、`packages/migrate/vitest.config.ts`
- Create: `packages/migrate/src/legacy-types.ts`、`src/load.ts`、`src/ids.ts`、`src/normalize.ts`
- Test: `packages/migrate/test/sqlite-fixture.ts`、`test/load.test.ts`、`test/normalize.test.ts`

**Interfaces:**
- Produces:
  - `type S = string | null`
  - `type PlaneRequirement = { id: string; title: string; description: S; status: S; phase: S; priority: S; business_domain: S; platform: S; requester: S; owner: S; version_id: S; source: S; estimated_effort: S; prd_link: S; notes: S; created_at: S; updated_at: S; prd_status: S; feasibility_status: S; iteration_status: S; acceptance_status: S; iteration_id: S }`
  - `type PlaneIteration = { id: string; status: S; pre_launch_date: S; kickoff_date: S; dev_start: S; dev_end: S; interim_release_date: S; release_date: S; notes: S; created_at: S }`
  - `type PlaneData`、`PushData`、`PrdData`、`LegacyData = { plane: PlaneData; push: PushData; prd: PrdData }`（字段见 Step 3 代码）
  - `loadPlane(path: string): PlaneData`、`loadPush(path: string): PushData`、`loadPrd(url: string): Promise<PrdData>`
  - `legacyUuid(namespace: string, key: string): string`
  - `normTitle(s: string): string`、`splitNames(s: S | undefined): string[]`、`splitPlatforms(s: S | undefined): string[]`、`parseJsonArray(s: S | undefined): string[]`、`parseLegacyTime(s: S | undefined): Date | null`、`parseLegacyDate(s: S | undefined): string | null`、`addDays(date: string, days: number): string`、`aliasKey(s: string): string`

- [ ] **Step 1: 建包**

`packages/migrate/package.json`：

```json
{
  "name": "@flower/migrate",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "NODE_OPTIONS=--disable-warning=ExperimentalWarning vitest run",
    "typecheck": "tsc --noEmit",
    "build": "esbuild src/cli.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/cli.mjs --external:node:sqlite --banner:js=\"import{createRequire}from'module';const require=createRequire(import.meta.url);\"",
    "legacy": "pnpm build && node --disable-warning=ExperimentalWarning --env-file=../../apps/web/.env.local dist/cli.mjs"
  },
  "dependencies": {
    "@flower/core": "workspace:*",
    "drizzle-orm": "^0.45.3",
    "postgres": "^3.4.9"
  },
  "devDependencies": {
    "@types/node": "^26.6.3",
    "esbuild": "^0.28.2",
    "typescript": "^7.0.2",
    "vitest": "^5.0.2"
  }
}
```

`packages/migrate/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/migrate/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../core/test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
```

在仓库根目录运行 `pnpm install`，并把 `packages/migrate/dist/` 加入根 `.gitignore`（`dist/` 已在 `.gitignore` 中则跳过）。

- [ ] **Step 2: 写失败的测试**

`packages/migrate/test/sqlite-fixture.ts`（生成与生产库同结构的小型 SQLite 文件，姓名全部虚构）：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PLANE_DDL = `
create table users (id text, email text, name text, nickname text, role text, avatar_url text, password text, created_at text);
create table requirements (id text, title text, description text, status text, phase text, priority text, business_domain text, platform text, requester text, owner text, version_id text, source text, estimated_effort text, prd_link text, notes text, created_at text, updated_at text, evaluated_at text, designed_at text, developed_at text, tested_at text, launched_at text, prd_status text, feasibility_status text, iteration_status text, acceptance_status text, iteration_id text);
create table iterations (id text, status text, pre_launch_date text, kickoff_date text, dev_start text, dev_end text, interim_release_date text, release_date text, notes text, created_at text, updated_at text);
create table versions (id text, platform text, status text, planned_release_date text, released_at text, description text, release_content text, created_at text, updated_at text);
create table requirement_versions (requirement_id text, platform text, version_id text);
create table requirement_developers (id text, requirement_id text, platform text, developer text, created_at text);
create table subtasks (id text, requirement_id text, title text, status text, assignee text, created_at text, updated_at text);
create table comments (id text, requirement_id text, user_email text, user_name text, content text, created_at text);
create table comment_reads (user_email text, requirement_id text, last_read_at text);
create table activity_log (id text, requirement_id text, user_email text, action text, old_value text, new_value text, details text, created_at text);
create table blockers (id text, requirement_id text, description text, status text, created_at text, created_by text, resolved_at text, resolved_by text);
create table requirement_updates (id text, requirement_id text, content text, created_by text, created_at text);
create table iteration_logs (id text, iteration_id text, type text, content text, requirement_id text, created_by text, created_at text);
create table requirement_briefs (requirement_id text, title text, html text, created_by text, created_at text, updated_at text);
create table settings (key text, value text);
create table notification_queue (id text);
create table sync_inbox (id text);
create table sync_outbox (id text);
create table role_permissions (id text);
create table user_permission_overrides (id text);
`;

const PUSH_DDL = `
create table requirements (id integer, title text, alias text, requester text, owner text, line text, priority text, platforms text, developers text, brief text, prd_url text, priority_set_at text, status text, source text, source_ref integer, version_id text, created_at text, last_edited_by text, last_edited_at text, plane_id text, merged_into integer);
create table versions (id text, name text, start_date text, release_date text, status text, created_at text);
create table gantt_tasks (id integer, requirement_id integer, version_id text, title text, assignee text, phase text, plan_start text, plan_days integer, delay_days integer, actual_status text, note text, flag text, created_at text, alias text, starred integer, ov_assignee text, ov_status text, ov_progress integer, manual integer);
create table prd_reviews (requirement_id integer, e1_state text, e1_by text, e1_at text, e1_note text, e2_state text, e2_by text, e2_at text, e2_note text, e3_state text, e3_by text, e3_at text, e3_note text, created_at text, submitted_by text);
create table design_signoffs (id integer, requirement_id integer, role text, state text, by text, opinion text, at text);
create table change_log (id integer, entity_type text, entity_id text, field text, old_value text, new_value text, edited_by text, edited_at text);
create table prd_auto_reviews (id integer, requirement_id integer, doc_url text, round integer, issue_count integer, blocking_count integer, issues text, reviewed_by text, reviewed_at text);
create table groups (id integer);
create table tasks (id integer);
create table task_targets (id integer);
create table push_logs (id integer);
create table settings (key text, value text);
create table review_objections (id integer);
`;

export function makeSqliteFixtures(): { planePath: string; pushPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'flower-migrate-'));
  const planePath = path.join(dir, 'plane.db');
  const pushPath = path.join(dir, 'push.db');
  const plane = new DatabaseSync(planePath);
  plane.exec(PLANE_DDL);
  plane.exec(`
    insert into users values ('u1','zhangsan@example.com','张三','三哥','admin',null,'secret-hash','2026-03-01 00:00:00');
    insert into requirements (id,title,status,priority,platform,requester,owner,created_at,prd_status,feasibility_status) values ('X001','批量下载','开发中','P1','PC客户端,Web端','客户甲','张三','2026-03-01T08:00:00+00:00','approved','approved');
    insert into iterations (id,status,kickoff_date,release_date) values ('V1','已完成','2026-03-02','2026-03-16');
    insert into comments values ('c1','X001','zhangsan@example.com','张三','请确认范围','2026-03-03T00:00:00Z');
    insert into settings values ('smtp_pass','must-not-be-read');
  `);
  plane.close();
  const push = new DatabaseSync(pushPath);
  push.exec(PUSH_DDL);
  push.exec(`
    insert into requirements (id,title,status,platforms,plane_id,merged_into,created_at) values (1,'批量下载','已进版本','["pc"]','X001',null,'2026-03-02 00:00:00');
    insert into versions values ('it0316',null,'2026-03-02','2026-03-16','已发版','2026-03-01 00:00:00');
    insert into push_logs values (1),(2);
  `);
  push.close();
  return { planePath, pushPath };
}
```

`packages/migrate/test/load.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { loadPlane, loadPush } from '../src/load';
import { makeSqliteFixtures } from './sqlite-fixture';

describe('读取 SQLite 副本', () => {
  it('读取 123plane 的业务表，不读取 settings', () => {
    const { planePath } = makeSqliteFixtures();
    const plane = loadPlane(planePath);
    expect(plane.users).toEqual([{ id: 'u1', email: 'zhangsan@example.com', name: '张三', nickname: '三哥', role: 'admin', created_at: '2026-03-01 00:00:00' }]);
    expect(plane.requirements[0]).toMatchObject({ id: 'X001', title: '批量下载', platform: 'PC客户端,Web端' });
    expect(plane.iterations[0]).toMatchObject({ id: 'V1', release_date: '2026-03-16' });
    expect(plane.comments).toHaveLength(1);
    expect(plane.counts).toMatchObject({ settings: 1, briefs: 0, notificationQueue: 0 });
    expect(JSON.stringify(plane)).not.toContain('must-not-be-read');
    expect(JSON.stringify(plane)).not.toContain('secret-hash');
  });

  it('读取 push 的业务表并统计不迁移的表', () => {
    const { pushPath } = makeSqliteFixtures();
    const push = loadPush(pushPath);
    expect(push.requirements[0]).toMatchObject({ id: 1, plane_id: 'X001', merged_into: null });
    expect(push.versions[0]).toMatchObject({ id: 'it0316', release_date: '2026-03-16' });
    expect(push.counts).toMatchObject({ pushLogs: 2, groups: 0 });
  });
});
```

`packages/migrate/test/normalize.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { legacyUuid } from '../src/ids';
import { addDays, aliasKey, normTitle, parseJsonArray, parseLegacyDate, parseLegacyTime, splitNames, splitPlatforms } from '../src/normalize';

describe('确定性 ID', () => {
  it('同样的输入得到同样的 UUID，格式合法', () => {
    const a = legacyUuid('pan123/req', 'plane:X001');
    expect(a).toBe(legacyUuid('pan123/req', 'plane:X001'));
    expect(a).not.toBe(legacyUuid('other/req', 'plane:X001'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('归一化', () => {
  it('标题去掉空白和中英文标点后比较', () => {
    expect(normTitle(' 相册 归类！')).toBe(normTitle('相册归类'));
    expect(normTitle('Web（PC）端')).toBe('webpc端');
  });

  it('拆分多人与多平台写法', () => {
    expect(splitNames('王五、张三,李四 / 赵六')).toEqual(['王五', '张三', '李四', '赵六']);
    expect(splitNames(null)).toEqual([]);
    expect(splitPlatforms('PC客户端, Web端，小程序')).toEqual(['PC客户端', 'Web端', '小程序']);
    expect(parseJsonArray('["pc"," web ",""]')).toEqual(['pc', 'web']);
    expect(parseJsonArray('not json')).toEqual([]);
    expect(aliasKey(' Web 端 ')).toBe('web端');
  });

  it('解析旧系统的时间与日期写法（无时区的按 UTC）', () => {
    expect(parseLegacyTime('2026-03-30 06:00:56')?.toISOString()).toBe('2026-03-30T06:00:56.000Z');
    expect(parseLegacyTime('2026-03-12T07:32:56.636567+00:00')?.toISOString()).toBe('2026-03-12T07:32:56.636Z');
    expect(parseLegacyTime('2026-06-09T03:17:10.073Z')?.toISOString()).toBe('2026-06-09T03:17:10.073Z');
    expect(parseLegacyTime('2026-04-14')?.toISOString()).toBe('2026-04-14T00:00:00.000Z');
    expect(parseLegacyTime('')).toBeNull();
    expect(parseLegacyTime('坏数据')).toBeNull();
    expect(parseLegacyDate('2026-04-14T10:00:00Z')).toBe('2026-04-14');
    expect(parseLegacyDate('')).toBeNull();
    expect(addDays('2026-03-30', 3)).toBe('2026-04-02');
  });
});
```

Run: `pnpm --filter @flower/migrate test`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`packages/migrate/src/legacy-types.ts`：

```ts
export type S = string | null;

export type PlaneRequirement = {
  id: string; title: string; description: S; status: S; phase: S; priority: S; business_domain: S; platform: S;
  requester: S; owner: S; version_id: S; source: S; estimated_effort: S; prd_link: S; notes: S; created_at: S; updated_at: S;
  prd_status: S; feasibility_status: S; iteration_status: S; acceptance_status: S; iteration_id: S;
};
export type PlaneIteration = {
  id: string; status: S; pre_launch_date: S; kickoff_date: S; dev_start: S; dev_end: S; interim_release_date: S; release_date: S; notes: S; created_at: S;
};
export type PlaneData = {
  users: Array<{ id: string; email: string; name: string; nickname: S; role: string; created_at: S }>;
  requirements: PlaneRequirement[];
  iterations: PlaneIteration[];
  versions: Array<{ id: string; platform: S; status: S; planned_release_date: S; released_at: S; description: S; release_content: S; created_at: S }>;
  requirementVersions: Array<{ requirement_id: string; platform: S; version_id: string }>;
  requirementDevelopers: Array<{ id: string; requirement_id: string; platform: S; developer: string; created_at: S }>;
  subtasks: Array<{ id: string; requirement_id: string; title: string; status: S; assignee: S; created_at: S; updated_at: S }>;
  comments: Array<{ id: string; requirement_id: string; user_email: S; user_name: S; content: string; created_at: S }>;
  commentReads: Array<{ user_email: string; requirement_id: string; last_read_at: S }>;
  activityLog: Array<{ id: string; requirement_id: S; user_email: S; action: string; old_value: S; new_value: S; details: S; created_at: S }>;
  blockers: Array<{ id: string; requirement_id: string; description: string; status: S; created_at: S; created_by: S; resolved_at: S; resolved_by: S }>;
  requirementUpdates: Array<{ id: string; requirement_id: string; content: string; created_by: S; created_at: S }>;
  iterationLogs: Array<{ id: string; iteration_id: S; type: S; content: string; requirement_id: S; created_by: S; created_at: S }>;
  counts: { briefs: number; settings: number; notificationQueue: number; syncInbox: number; syncOutbox: number; rolePermissions: number; userPermissionOverrides: number; prdLinks: number };
};
export type PushRequirement = {
  id: number; title: string; alias: S; requester: S; owner: S; line: S; priority: S; platforms: S; developers: S; brief: S;
  status: S; source: S; version_id: S; created_at: S; last_edited_by: S; last_edited_at: S; plane_id: S; merged_into: number | null;
};
export type PushData = {
  requirements: PushRequirement[];
  versions: Array<{ id: string; name: S; start_date: S; release_date: S; status: S; created_at: S }>;
  ganttTasks: Array<{
    id: number; requirement_id: number | null; version_id: S; title: string; assignee: S; phase: S; plan_start: S; plan_days: number | null;
    delay_days: number | null; actual_status: S; note: S; flag: S; created_at: S; alias: S; starred: number | null; ov_assignee: S;
    ov_status: S; ov_progress: number | null; manual: number | null;
  }>;
  prdReviews: Array<{
    requirement_id: number; e1_state: S; e1_by: S; e1_at: S; e1_note: S; e2_state: S; e2_by: S; e2_at: S; e2_note: S;
    e3_state: S; e3_by: S; e3_at: S; e3_note: S; created_at: S; submitted_by: S;
  }>;
  designSignoffs: Array<{ id: number; requirement_id: number; role: string; state: S; by: S; opinion: S; at: S }>;
  changeLog: Array<{ id: number; entity_type: S; entity_id: S; field: S; old_value: S; new_value: S; edited_by: S; edited_at: S }>;
  autoReviews: Array<{ id: number; requirement_id: number; round: number; issue_count: number; blocking_count: number; issues: S; reviewed_by: S; reviewed_at: S }>;
  counts: { groups: number; tasks: number; taskTargets: number; pushLogs: number; settings: number; reviewObjections: number; prdUrls: number };
};
export type PrdData = {
  domains: Array<{ name: string; type: S; group: S; status: string; display_order: number }>;
  users: Array<{ email: string; name: string }>;
  counts: { pages: number; pageVersions: number; attachments: number; comments: number };
};
export type LegacyData = { plane: PlaneData; push: PushData; prd: PrdData };
```

`packages/migrate/src/load.ts`：

```ts
import { DatabaseSync } from 'node:sqlite';
import postgres from 'postgres';
import type { PlaneData, PrdData, PushData } from './legacy-types';

const all = <T>(db: DatabaseSync, sql: string): T[] => db.prepare(sql).all() as T[];
const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

function open(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/** 只读取迁移需要的列；users.password、avatar_url 和 settings 表（含 SMTP 密码等）一律不读。 */
export function loadPlane(path: string): PlaneData {
  const db = open(path);
  try {
    return {
      users: all(db, 'select id, email, name, nickname, role, created_at from users order by id'),
      requirements: all(
        db,
        `select id, title, description, status, phase, priority, business_domain, platform, requester, owner, version_id, source,
          estimated_effort, prd_link, notes, created_at, updated_at, prd_status, feasibility_status, iteration_status,
          acceptance_status, iteration_id from requirements order by created_at, id`,
      ),
      iterations: all(
        db,
        'select id, status, pre_launch_date, kickoff_date, dev_start, dev_end, interim_release_date, release_date, notes, created_at from iterations order by id',
      ),
      versions: all(db, 'select id, platform, status, planned_release_date, released_at, description, release_content, created_at from versions order by id'),
      requirementVersions: all(db, 'select requirement_id, platform, version_id from requirement_versions order by requirement_id, version_id'),
      requirementDevelopers: all(db, 'select id, requirement_id, platform, developer, created_at from requirement_developers order by id'),
      subtasks: all(db, 'select id, requirement_id, title, status, assignee, created_at, updated_at from subtasks order by id'),
      comments: all(db, 'select id, requirement_id, user_email, user_name, content, created_at from comments order by created_at, id'),
      commentReads: all(db, 'select user_email, requirement_id, last_read_at from comment_reads order by user_email, requirement_id'),
      activityLog: all(db, 'select id, requirement_id, user_email, action, old_value, new_value, details, created_at from activity_log order by created_at, id'),
      blockers: all(db, 'select id, requirement_id, description, status, created_at, created_by, resolved_at, resolved_by from blockers order by id'),
      requirementUpdates: all(db, 'select id, requirement_id, content, created_by, created_at from requirement_updates order by created_at, id'),
      iterationLogs: all(db, 'select id, iteration_id, type, content, requirement_id, created_by, created_at from iteration_logs order by created_at, id'),
      counts: {
        briefs: count(db, 'select count(*) as n from requirement_briefs'),
        settings: count(db, 'select count(*) as n from settings'),
        notificationQueue: count(db, 'select count(*) as n from notification_queue'),
        syncInbox: count(db, 'select count(*) as n from sync_inbox'),
        syncOutbox: count(db, 'select count(*) as n from sync_outbox'),
        rolePermissions: count(db, 'select count(*) as n from role_permissions'),
        userPermissionOverrides: count(db, 'select count(*) as n from user_permission_overrides'),
        prdLinks: count(db, "select count(*) as n from requirements where coalesce(prd_link, '') <> ''"),
      },
    };
  } finally {
    db.close();
  }
}

export function loadPush(path: string): PushData {
  const db = open(path);
  try {
    return {
      requirements: all(
        db,
        `select id, title, alias, requester, owner, line, priority, platforms, developers, brief, status, source, version_id, created_at,
          last_edited_by, last_edited_at, plane_id, merged_into from requirements order by created_at, id`,
      ),
      versions: all(db, 'select id, name, start_date, release_date, status, created_at from versions order by release_date, id'),
      ganttTasks: all(
        db,
        `select id, requirement_id, version_id, title, assignee, phase, plan_start, plan_days, delay_days, actual_status, note, flag, created_at,
          alias, starred, ov_assignee, ov_status, ov_progress, manual from gantt_tasks order by id`,
      ),
      prdReviews: all(db, 'select * from prd_reviews order by requirement_id'),
      designSignoffs: all(db, 'select id, requirement_id, role, state, by, opinion, at from design_signoffs order by id'),
      changeLog: all(db, 'select id, entity_type, entity_id, field, old_value, new_value, edited_by, edited_at from change_log order by id'),
      autoReviews: all(db, 'select id, requirement_id, round, issue_count, blocking_count, issues, reviewed_by, reviewed_at from prd_auto_reviews order by requirement_id, round, id'),
      counts: {
        groups: count(db, 'select count(*) as n from groups'),
        tasks: count(db, 'select count(*) as n from tasks'),
        taskTargets: count(db, 'select count(*) as n from task_targets'),
        pushLogs: count(db, 'select count(*) as n from push_logs'),
        settings: count(db, 'select count(*) as n from settings'),
        reviewObjections: count(db, 'select count(*) as n from review_objections'),
        prdUrls: count(db, "select count(*) as n from requirements where coalesce(prd_url, '') <> ''"),
      },
    };
  } finally {
    db.close();
  }
}

export async function loadPrd(url: string): Promise<PrdData> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const domains = await sql<PrdData['domains']>`select name, type, "group", status, display_order from prd_domains order by display_order, name`;
    const users = await sql<PrdData['users']>`select email, name from users order by email`;
    const [c] = await sql<Array<PrdData['counts']>>`
      select (select count(*)::int from pages where deleted_at is null) as pages,
             (select count(*)::int from page_versions) as "pageVersions",
             (select count(*)::int from attachments) as attachments,
             (select count(*)::int from comments) as comments`;
    return { domains: [...domains], users: [...users], counts: c! };
  } finally {
    await sql.end();
  }
}
```

`packages/migrate/src/ids.ts`：

```ts
import { createHash } from 'node:crypto';

/** 由来源键派生确定性 UUID（位布局同 UUID v5）。同样的 namespace 与 key 永远得到同一个 ID。 */
export function legacyUuid(namespace: string, key: string): string {
  const h = createHash('sha1').update(`flower-legacy:${namespace}:${key}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
```

`packages/migrate/src/normalize.ts`：

```ts
import type { S } from './legacy-types';

export const normTitle = (s: string): string => s.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

export const aliasKey = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

export const splitNames = (s: S | undefined): string[] =>
  (s ?? '').split(/[、,，/;；]+/).map((x) => x.trim()).filter(Boolean);

export const splitPlatforms = (s: S | undefined): string[] =>
  (s ?? '').split(/[,，、]+/).map((x) => x.trim()).filter(Boolean);

export function parseJsonArray(s: S | undefined): string[] {
  try {
    const v: unknown = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 旧系统的时间有三种写法：`YYYY-MM-DD`、`YYYY-MM-DD HH:MM:SS`（SQLite，UTC）、ISO 8601。 */
export function parseLegacyTime(s: S | undefined): Date | null {
  const t = s?.trim();
  if (!t) return null;
  let iso = t;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) iso = `${t}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) iso = `${t.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseLegacyDate(s: S | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s?.trim() ?? '');
  return m ? m[1]! : null;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate test` 与 `pnpm --filter @flower/migrate typecheck`
Expected: 全部通过，输出中没有 ExperimentalWarning（测试脚本已用 `NODE_OPTIONS=--disable-warning=ExperimentalWarning` 关闭 `node:sqlite` 的实验特性提示）。

- [ ] **Step 5: 提交**

```bash
git add packages/migrate pnpm-lock.yaml .gitignore
git commit -m "feat(migrate): 迁移包骨架：读取旧库、确定性 ID 与归一化"
```

---
### Task 8: 对照表：结构、读写、建议生成与解析

**Files:**
- Create: `packages/migrate/src/mapping.ts`、`packages/migrate/src/suggest.ts`、`packages/migrate/src/workflow-v1.ts`
- Create: `packages/migrate/test/fixtures.ts`（虚构的完整旧数据，Task 9–11 共用）
- Test: `packages/migrate/test/mapping.test.ts`

**Interfaces:**
- Consumes: Task 7 的类型与归一化函数
- Produces（`mapping.ts`）：
  - `type PersonEntry = { key: string; displayName: string; email: string | null; orgRole: 'admin' | 'member' | 'guest'; productRole: 'admin' | 'editor' | 'viewer' | null; functionTags: string[]; aliases: string[]; mentions: number }`
  - `type Mapping = { people: { people: PersonEntry[]; signoffRoles: Record<string, string> }; platforms: { options: Array<{ key: string; label: string }>; aliases: Record<string, string[]> }; domains: { nodes: Array<{ name: string; description: string | null; aliases: string[] }> }; iterations: { iterations: IterationEntry[] } }`
  - `type IterationEntry = { key: string; name: string; type: 'regular' | 'special'; planeIds: string[]; pushIds: string[] }`
  - `MAPPING_FILES = { people: 'people.json', platforms: 'platforms.json', domains: 'domains.json', iterations: 'iterations.json' }`
  - `readMapping(dir: string): Mapping | null`、`writeMapping(dir: string, m: Mapping): void`
  - `class Resolver`：`constructor(m: Mapping)`；`person(raw: string | null | undefined): PersonEntry | null`；`platforms(raw: string): string[]`；`domain(raw: string | null | undefined): string | null`；`iteration(source: 'plane' | 'push', id: string | null | undefined): IterationEntry | null`；`signoffRole(role: string): PersonEntry | null`；`unmapped: { people: Set<string>; platforms: Set<string>; domains: Set<string>; iterations: Set<string> }`（未能解析的原始值，Task 10 据此阻止写入）
- Produces（`suggest.ts`）：`suggestMapping(data: LegacyData, existing: Mapping | null): Mapping`（保留已有条目，只补充新出现的值）；`collectPersonMentions(data: LegacyData): Array<{ raw: string; email: string | null; role: 'owner' | 'developer' | 'requester' | 'signer' | 'other'; signoffRole?: string }>`
- Produces（`workflow-v1.ts`）：`V1_STATES`、`PLANE_STATUS_TO_STATE`、`SIGNOFF_ROLES = ['UI', '线条负责人', '产品负责人', '饶总']`、`SIGNOFF_ROLE_TAG`、`BOSS_ROLE = '饶总'`、`buildWorkflowV1Body(tagIdByName: Map<string, string>, bossMemberId: string): WorkflowBody`、`PRD_STATUS_TO_CHECK`、`FEASIBILITY_TO_CHECK`、`PUSH_REVIEW_TO_CHECK`、`PUSH_STATUS_TO_CHECK`、`PRIORITY_KEYS`、`PRIORITY_OPTIONS`、`LINE_OPTIONS`、`SOURCE_OPTIONS`、`PLANE_ITERATION_STATUS`、`PUSH_VERSION_STATUS`、`ITERATION_LOG_LABEL`、`SUBTASK_STATUS`、`DEFAULT_PLATFORM_OPTIONS`、`KNOWN_PLATFORM_ALIASES`、`parseProxySigner(by: string): { onBehalfOf: string; actor: string } | null`

- [ ] **Step 1: 写测试夹具**

`packages/migrate/test/fixtures.ts`（虚构姓名；覆盖按 plane_id 匹配、按标题匹配、push 独有、push 已合并、已删除需求的评论与日志、代签、AI 预审、跨迭代配对、专项）：

```ts
import type { LegacyData, PlaneRequirement, PushRequirement } from '../src/legacy-types';

const planeReq = (r: Partial<PlaneRequirement> & { id: string; title: string }): PlaneRequirement => ({
  description: null, status: '收集', phase: null, priority: 'P2', business_domain: '', platform: '', requester: null, owner: null,
  version_id: null, source: null, estimated_effort: null, prd_link: null, notes: null, created_at: '2026-03-01T00:00:00Z',
  updated_at: null, prd_status: 'not-started', feasibility_status: 'not-assessed', iteration_status: 'active',
  acceptance_status: 'not-started', iteration_id: '', ...r,
});

const pushReq = (r: Partial<PushRequirement> & { id: number; title: string }): PushRequirement => ({
  alias: null, requester: null, owner: null, line: '功能', priority: 'P2', platforms: '[]', developers: '[]', brief: null,
  status: '待排期', source: '原创', version_id: '', created_at: '2026-03-02 00:00:00', last_edited_by: null, last_edited_at: null,
  plane_id: '', merged_into: null, ...r,
});

export function makeLegacyData(): LegacyData {
  return {
    plane: {
      users: [
        { id: 'u1', email: 'zhangsan@example.com', name: '张三', nickname: null, role: 'admin', created_at: '2026-03-01 00:00:00' },
        { id: 'u2', email: 'lisi@example.com', name: '李四', nickname: null, role: 'member', created_at: '2026-03-01 00:00:00' },
        { id: 'u3', email: 'laoban@example.com', name: '王老板', nickname: null, role: 'viewer', created_at: '2026-03-01 00:00:00' },
      ],
      requirements: [
        planeReq({ id: 'X001', title: '批量下载', status: '开发中', priority: 'P1', business_domain: '会员', platform: 'PC客户端,web', requester: '客户甲', owner: '张三', iteration_id: 'V1', prd_status: 'approved', feasibility_status: 'approved', created_at: '2026-03-01T08:00:00+00:00', updated_at: '2026-03-10T08:00:00Z' }),
        planeReq({ id: 'X002', title: '相册归类', status: '收集', priority: '绿色通道', business_domain: '会员与支付', platform: '全端', requester: '客户乙', owner: '李四、张三', created_at: '2026-03-02T08:00:00Z' }),
        planeReq({ id: 'X003', title: '分享密码', status: '已上线', priority: 'P0', requester: '客户甲', owner: '张三', iteration_id: 'V2', acceptance_status: 'accepted', created_at: '2026-03-03T08:00:00Z' }),
      ],
      iterations: [
        { id: 'V1', status: '已完成', pre_launch_date: '2026-03-01', kickoff_date: '2026-03-02', dev_start: '2026-03-02', dev_end: '2026-03-13', interim_release_date: null, release_date: '2026-03-16', notes: null, created_at: null },
        { id: 'V1dup', status: '已完成', pre_launch_date: '2026-03-01', kickoff_date: '2026-03-02', dev_start: '2026-03-02', dev_end: '2026-03-13', interim_release_date: null, release_date: '2026-03-16', notes: null, created_at: null },
        { id: 'V2', status: '进行中', pre_launch_date: null, kickoff_date: '2026-03-17', dev_start: '2026-03-17', dev_end: '2026-03-27', interim_release_date: null, release_date: '2026-03-30', notes: null, created_at: null },
      ],
      versions: [{ id: 'pc-1.0.0', platform: 'PC客户端', status: 'released', planned_release_date: '', released_at: '2026-03-20T10:00:00Z', description: '首个版本', release_content: null, created_at: null }],
      requirementVersions: [{ requirement_id: 'X003', platform: 'PC客户端', version_id: 'pc-1.0.0' }],
      requirementDevelopers: [
        { id: 'd1', requirement_id: 'X001', platform: 'PC客户端', developer: '王五', created_at: null },
        { id: 'd2', requirement_id: 'X001', platform: 'Web端', developer: '王五', created_at: null },
      ],
      subtasks: [{ id: 's1', requirement_id: 'X001', title: '接口联调', status: 'todo', assignee: '王五', created_at: '2026-03-04T00:00:00Z', updated_at: null }],
      comments: [
        { id: 'c1', requirement_id: 'X001', user_email: 'lisi@example.com', user_name: '李四', content: '请确认范围', created_at: '2026-03-03T00:00:00Z' },
        { id: 'c2', requirement_id: 'X999', user_email: 'lisi@example.com', user_name: '李四', content: '已删除需求上的评论', created_at: '2026-03-03T00:00:00Z' },
      ],
      commentReads: [{ user_email: 'zhangsan@example.com', requirement_id: 'X001', last_read_at: '2026-03-04T00:00:00Z' }],
      activityLog: [
        { id: 'a1', requirement_id: 'X001', user_email: 'zhangsan@example.com', action: 'status_change', old_value: '收集', new_value: '开发中', details: '{}', created_at: '2026-03-05T00:00:00Z' },
        { id: 'a2', requirement_id: 'X999', user_email: 'zhangsan@example.com', action: 'deleted', old_value: null, new_value: null, details: '{"id":"X999","title":"被删掉的需求"}', created_at: '2026-03-06T00:00:00Z' },
        { id: 'a3', requirement_id: 'X002', user_email: 'lisi@example.com', action: 'created', old_value: null, new_value: null, details: '{}', created_at: '2026-03-02T08:00:00Z' },
      ],
      blockers: [{ id: 'b1', requirement_id: 'X001', description: '等待支付接口', status: 'active', created_at: '2026-03-05T00:00:00Z', created_by: '张三', resolved_at: null, resolved_by: null }],
      requirementUpdates: [{ id: 'up1', requirement_id: 'X001', content: '联调中', created_by: '张三', created_at: '2026-03-06T00:00:00Z' }],
      iterationLogs: [{ id: 'l1', iteration_id: 'V2', type: 'risk', content: '人手紧张', requirement_id: null, created_by: '张三', created_at: '2026-03-18T00:00:00Z' }],
      counts: { briefs: 1, settings: 5, notificationQueue: 2, syncInbox: 0, syncOutbox: 0, rolePermissions: 3, userPermissionOverrides: 1, prdLinks: 1 },
    },
    push: {
      requirements: [
        pushReq({ id: 1, title: '批量下载（PC/Web）', plane_id: 'X001', priority: 'P0', status: '已进版本', version_id: 'it0316', owner: '张三', requester: '客户甲', platforms: '["pc"]', developers: '["前端"]' }),
        pushReq({ id: 2, title: '相册 归类！', status: '评审中', owner: '李四', requester: '客户乙' }),
        pushReq({ id: 3, title: '离线下载', status: '待排期', owner: '赵六', requester: '客户丙', platforms: '["鸿蒙"]', version_id: 'it0330', line: '商业', source: '线上问题', brief: '支持离线下载' }),
        pushReq({ id: 4, title: '离线下载（重复）', merged_into: 3 }),
        pushReq({ id: 5, title: '已搁置需求', status: '已搁置', owner: '赵六' }),
      ],
      versions: [
        { id: 'it0316', name: null, start_date: '2026-03-02', release_date: '2026-03-16', status: '已发版', created_at: null },
        { id: 'sp1', name: '专项', start_date: '2026-03-05', release_date: '2026-03-25', status: '已发版', created_at: null },
        { id: 'it0330', name: null, start_date: '2026-03-17', release_date: '2026-03-31', status: '已发版', created_at: null },
      ],
      ganttTasks: [
        { id: 1, requirement_id: 1, version_id: 'it0316', title: '前端开发', assignee: '王五', phase: '开发中', plan_start: '2026-03-02', plan_days: 5, delay_days: 0, actual_status: '', note: '', flag: '正常', created_at: null, alias: null, starred: 0, ov_assignee: null, ov_status: null, ov_progress: null, manual: 0 },
        { id: 2, requirement_id: null, version_id: 'sp1', title: '专项设计', assignee: '赵六', phase: '设计中', plan_start: '2026-09-20', plan_days: 30, delay_days: 0, actual_status: '', note: '', flag: '关注', created_at: null, alias: null, starred: 1, ov_assignee: null, ov_status: null, ov_progress: null, manual: 0 },
      ],
      prdReviews: [
        { requirement_id: 1, e1_state: '通过', e1_by: '张三', e1_at: '2026-03-03 00:00:00', e1_note: '背景清楚', e2_state: '通过', e2_by: '张三', e2_at: '2026-03-03 00:00:00', e2_note: null, e3_state: '待办', e3_by: null, e3_at: null, e3_note: null, created_at: null, submitted_by: '李四' },
      ],
      designSignoffs: [
        { id: 1, requirement_id: 1, role: 'UI', state: '通过', by: '李四', opinion: null, at: '2026-03-04 00:00:00' },
        { id: 2, requirement_id: 1, role: '线条负责人', state: '通过', by: '张三', opinion: null, at: '2026-03-04 00:00:00' },
        { id: 3, requirement_id: 1, role: '产品负责人', state: '未审', by: null, opinion: null, at: null },
        { id: 4, requirement_id: 1, role: '饶总', state: '通过', by: '代饶总 by 张三', opinion: '同意', at: '2026-03-05 00:00:00' },
      ],
      changeLog: [{ id: 1, entity_type: 'requirement', entity_id: '1', field: 'priority', old_value: 'P1', new_value: 'P0', edited_by: '张三', edited_at: '2026-03-04 00:00:00' }],
      autoReviews: [
        { id: 1, requirement_id: 1, round: 1, issue_count: 5, blocking_count: 2, issues: '[{"level":"blocking","text":"缺少异常流程"}]', reviewed_by: '李四', reviewed_at: '2026-03-03 00:00:00' },
        { id: 2, requirement_id: 1, round: 2, issue_count: 1, blocking_count: 0, issues: '[]', reviewed_by: '李四', reviewed_at: '2026-03-04 00:00:00' },
      ],
      counts: { groups: 2, tasks: 3, taskTargets: 3, pushLogs: 7, settings: 4, reviewObjections: 0, prdUrls: 1 },
    },
    prd: {
      domains: [
        { name: '会员与支付', type: '产品域', group: '增长组', status: 'active', display_order: 1 },
        { name: '跨盘迁移', type: '产品域', group: '基础组', status: 'active', display_order: 2 },
      ],
      users: [{ email: 'zhangsan@example.com', name: '张三' }],
      counts: { pages: 2, pageVersions: 5, attachments: 3, comments: 1 },
    },
  };
}
```

- [ ] **Step 2: 写失败的测试**

`packages/migrate/test/mapping.test.ts`：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMapping, Resolver, writeMapping } from '../src/mapping';
import { suggestMapping } from '../src/suggest';
import { makeLegacyData } from './fixtures';

describe('建议对照表', () => {
  const m = suggestMapping(makeLegacyData(), null);
  const r = new Resolver(m);

  it('有账号的人按邮箱合并，名字与邮箱都能解析到同一人', () => {
    const zs = r.person('张三');
    expect(zs).toMatchObject({ email: 'zhangsan@example.com', orgRole: 'admin' });
    expect(r.person('zhangsan@example.com')?.key).toBe(zs!.key);
    expect(r.person('王老板')).toMatchObject({ orgRole: 'member', productRole: 'viewer' });
  });

  it('没有账号的人按名字建为成员，并按出现位置建议职能标签', () => {
    expect(r.person('王五')).toMatchObject({ email: null, functionTags: ['开发'] });
    expect(r.person('客户丙')).toMatchObject({ email: null, functionTags: [] });
    expect(r.person('李四')?.functionTags).toEqual(expect.arrayContaining(['产品经理', '设计']));
  });

  it('代签写法拆成会签角色和实际操作人，会签角色先建为占位成员', () => {
    expect(m.people.signoffRoles['饶总']).toBeDefined();
    expect(r.signoffRole('饶总')?.displayName).toBe('饶总');
  });

  it('平台按已知写法归并，未知写法建议为新选项，"全端"展开为全部平台', () => {
    expect(r.platforms('web')).toEqual(['web']);
    expect(r.platforms('PC客户端')).toEqual(['pc']);
    expect(r.platforms('全端')).toEqual(['pc', 'mobile', 'web', 'mini']);
    const harmony = r.platforms('鸿蒙');
    expect(harmony).toHaveLength(1);
    expect(m.platforms.options.find((o) => o.key === harmony[0])?.label).toBe('鸿蒙');
  });

  it('业务域：PRD 的业务域在前，每个原始写法先各自成为一个节点', () => {
    expect(m.domains.nodes.map((n) => n.name)).toEqual(['会员与支付', '跨盘迁移', '会员']);
    expect(m.domains.nodes[0]!.description).toBe('产品域 · 增长组');
    expect(r.domain('会员')).toBe('会员');
  });

  it('迭代：日期完全相同的合并，发布日相差不超过一天的与 push 迭代配对，与常规迭代重叠的 push 迭代建议为专项', () => {
    const its = m.iterations.iterations;
    expect(its).toHaveLength(3);
    expect(its.find((i) => i.planeIds.includes('V1'))).toMatchObject({ name: 'it0316', planeIds: ['V1', 'V1dup'], pushIds: ['it0316'], type: 'regular' });
    expect(its.find((i) => i.planeIds.includes('V2'))).toMatchObject({ pushIds: ['it0330'], type: 'regular' });
    expect(its.find((i) => i.pushIds.includes('sp1'))).toMatchObject({ name: '专项', type: 'special', planeIds: [] });
    expect(r.iteration('plane', 'V1dup')?.name).toBe('it0316');
  });

  it('解析不到的原始值会被记下', () => {
    expect(r.person('查无此人')).toBeNull();
    expect(r.platforms('火星端')).toEqual([]);
    expect(r.iteration('push', 'nope')).toBeNull();
    expect([...r.unmapped.people]).toContain('查无此人');
    expect([...r.unmapped.platforms]).toContain('火星端');
    expect([...r.unmapped.iterations]).toContain('push:nope');
  });
});

describe('对照表文件', () => {
  it('写入后读回；已有条目在重新生成时保留用户的修改', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flower-mapping-'));
    expect(readMapping(dir)).toBeNull();
    const m = suggestMapping(makeLegacyData(), null);
    m.people.people.find((p) => p.displayName === '王五')!.displayName = '王五（后端）';
    m.domains.nodes = [{ name: '会员与支付', description: null, aliases: ['会员与支付', '会员'] }, { name: '跨盘迁移', description: null, aliases: ['跨盘迁移'] }];
    writeMapping(dir, m);
    const again = suggestMapping(makeLegacyData(), readMapping(dir));
    expect(again.people.people.find((p) => p.aliases.includes('王五'))?.displayName).toBe('王五（后端）');
    expect(again.domains.nodes.map((n) => n.name)).toEqual(['会员与支付', '跨盘迁移']);
    expect(new Resolver(again).domain('会员')).toBe('会员与支付');
  });
});
```

Run: `pnpm --filter @flower/migrate exec vitest run test/mapping.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `workflow-v1.ts`**

```ts
import { type CheckState, DEFAULT_FUNCTION_TAGS, type WorkflowBody } from '@flower/core';

export const V1_STATES: WorkflowBody['states'] = [
  { key: 'collect', label: '收集', color: '#94a3b8', order: 1, group: '分析', category: 'backlog' },
  { key: 'to_evaluate', label: '待评估', color: '#a78bfa', order: 2, group: '分析', category: 'backlog' },
  { key: 'evaluated', label: '已评估', color: '#818cf8', order: 3, group: '分析', category: 'backlog' },
  { key: 'to_design', label: '待设计', color: '#60a5fa', order: 4, group: '开发', category: 'unstarted' },
  { key: 'to_develop', label: '待开发', color: '#38bdf8', order: 5, group: '开发', category: 'unstarted' },
  { key: 'designing', label: '设计中', color: '#f59e0b', order: 6, group: '开发', category: 'started' },
  { key: 'developing', label: '开发中', color: '#f97316', order: 7, group: '开发', category: 'started' },
  { key: 'testing', label: '测试中', color: '#eab308', order: 8, group: '开发', category: 'started' },
  { key: 'launched', label: '已上线', color: '#10b981', order: 9, group: '开发', category: 'completed' },
  { key: 'rejected', label: '已拒绝', color: '#9ca3af', order: 10, group: '', category: 'canceled' },
  { key: 'shelved', label: '已搁置', color: '#6b7280', order: 11, group: '', category: 'canceled' },
];

export const PLANE_STATUS_TO_STATE: Record<string, string> = Object.fromEntries(V1_STATES.map((s) => [s.label, s.key]));

export const SIGNOFF_ROLES = ['UI', '线条负责人', '产品负责人', '饶总'] as const;
export const BOSS_ROLE = '饶总';
export const SIGNOFF_ROLE_TAG: Record<string, string> = { UI: '设计', 线条负责人: '线条负责人', 产品负责人: '产品负责人' };
export const EXTRA_FUNCTION_TAGS = ['线条负责人', '产品负责人'];
export const ALL_FUNCTION_TAG_NAMES = [...DEFAULT_FUNCTION_TAGS.map((t) => t.name), ...EXTRA_FUNCTION_TAGS];

export function buildWorkflowV1Body(tagIdByName: Map<string, string>, bossMemberId: string): WorkflowBody {
  const tag = (name: string) => {
    const id = tagIdByName.get(name);
    if (!id) throw new Error(`缺少职能标签「${name}」`);
    return id;
  };
  const feasible = [{ type: 'check_item' as const, item: 'feasibility', in: ['passed', 'not_needed'] as CheckState[] }];
  return {
    states: V1_STATES,
    initial: 'collect',
    transitions: V1_STATES.map((s) => ({ from: '*', to: s.key, conditions: s.key === 'to_design' || s.key === 'to_develop' ? feasible : [] })),
    actionGates: [],
    checkItems: [
      { key: 'background', label: '背景', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      { key: 'industry', label: '行业', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      {
        key: 'design_signoff',
        label: '设计签字',
        scope: 'requirement',
        type: 'signoff',
        signers: [
          { by: 'function_tag', ref: tag(SIGNOFF_ROLE_TAG.UI!) },
          { by: 'function_tag', ref: tag(SIGNOFF_ROLE_TAG['线条负责人']!) },
          { by: 'function_tag', ref: tag(SIGNOFF_ROLE_TAG['产品负责人']!) },
          { by: 'member', ref: bossMemberId },
        ],
        signoffRule: 'all',
        defaultState: 'not_started',
      },
      { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      { key: 'ai_review', label: 'AI 预审', scope: 'requirement', type: 'single', defaultState: 'not_started' },
    ],
  };
}

export const PRD_STATUS_TO_CHECK: Record<string, CheckState> = {
  'not-started': 'not_started', approved: 'passed', submitted: 'in_progress', 'in-progress': 'in_progress', 'not-needed': 'not_needed',
};
export const FEASIBILITY_TO_CHECK: Record<string, CheckState> = {
  'not-assessed': 'not_started', approved: 'passed', 'in-progress': 'in_progress', rejected: 'rejected',
};
export const PUSH_REVIEW_TO_CHECK: Record<string, CheckState> = { 待办: 'in_progress', 通过: 'passed', 打回: 'rejected' };
/** push 主状态对背景 / 可行性 / 行业三个检查项的含义；"已搁置"不影响检查项。 */
export const PUSH_STATUS_TO_CHECK: Record<string, CheckState | null> = {
  待排期: 'not_started', 评审中: 'in_progress', 待修订: 'rejected', 已通过: 'passed', 已进版本: 'passed',
  开发中: 'passed', 待验收: 'passed', 合格: 'passed', 已上线: 'passed', 已搁置: null,
};
export const SIGNOFF_DECISION: Record<string, 'passed' | 'rejected' | null> = { 通过: 'passed', 驳回: 'rejected', 打回: 'rejected', 未审: null };
export const PRIORITY_KEYS: Record<string, string> = { P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3', 绿色通道: 'green' };
export const PRIORITY_OPTIONS = [
  { key: 'p0', label: 'P0', color: '#dc2626' },
  { key: 'p1', label: 'P1', color: '#ea580c' },
  { key: 'p2', label: 'P2', color: '#ca8a04' },
  { key: 'p3', label: 'P3', color: '#64748b' },
  { key: 'green', label: '绿色通道', color: '#16a34a' },
];
export const LINE_OPTIONS = [
  { key: 'feature', label: '功能' },
  { key: 'business', label: '商业' },
];
export const SOURCE_OPTIONS = [
  { key: 'original', label: '原创' },
  { key: 'online_issue', label: '线上问题' },
];
export const PLANE_ITERATION_STATUS: Record<string, 'planning' | 'active' | 'done'> = { 未开始: 'planning', 进行中: 'active', 已完成: 'done' };
export const PUSH_VERSION_STATUS: Record<string, 'planning' | 'active' | 'done'> = { 规划中: 'planning', 进行中: 'active', 已发版: 'done' };
export const ITERATION_LOG_LABEL: Record<string, string> = { note: '备注', risk: '风险', change: '变更', removed: '移出' };
export const SUBTASK_STATUS: Record<string, 'todo' | 'doing' | 'done'> = { todo: 'todo', doing: 'doing', 'in-progress': 'doing', done: 'done' };
export const BLOCKER_STATUS: Record<string, 'active' | 'resolved'> = { active: 'active', resolved: 'resolved' };

export const DEFAULT_PLATFORM_OPTIONS = [
  { key: 'pc', label: 'PC客户端' },
  { key: 'mobile', label: '移动端' },
  { key: 'web', label: 'Web端' },
  { key: 'mini', label: '小程序' },
];
/** 已知写法（按 aliasKey 归一化后）→ 平台选项 key。 */
export const KNOWN_PLATFORM_ALIASES: Record<string, string[]> = {
  pc: ['pc'], pc客户端: ['pc'], 客户端: ['pc'],
  web: ['web'], web端: ['web'],
  app: ['mobile'], 移动端: ['mobile'], ios: ['mobile'], android: ['mobile'], 安卓: ['mobile'],
  小程序: ['mini'], mini: ['mini'],
  all: ['pc', 'mobile', 'web', 'mini'], 全端: ['pc', 'mobile', 'web', 'mini'], 全平台: ['pc', 'mobile', 'web', 'mini'],
  待确认: [],
};

export function parseProxySigner(by: string): { onBehalfOf: string; actor: string } | null {
  const m = /^代(.+?)\s*by\s*(.+)$/.exec(by.trim());
  return m ? { onBehalfOf: m[1]!.trim(), actor: m[2]!.trim() } : null;
}
```

`@flower/core` 需要导出 `DEFAULT_FUNCTION_TAGS` 与 `CheckState`（前者已由 `definitions/defaults.ts` 导出，后者由 Task 2 导出）。

- [ ] **Step 4: 实现 `mapping.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aliasKey } from './normalize';

export type PersonEntry = {
  key: string;
  displayName: string;
  email: string | null;
  orgRole: 'admin' | 'member' | 'guest';
  productRole: 'admin' | 'editor' | 'viewer' | null;
  functionTags: string[];
  aliases: string[];
  mentions: number;
};
export type IterationEntry = { key: string; name: string; type: 'regular' | 'special'; planeIds: string[]; pushIds: string[] };
export type Mapping = {
  people: { people: PersonEntry[]; signoffRoles: Record<string, string> };
  platforms: { options: Array<{ key: string; label: string }>; aliases: Record<string, string[]> };
  domains: { nodes: Array<{ name: string; description: string | null; aliases: string[] }> };
  iterations: { iterations: IterationEntry[] };
};

export const MAPPING_FILES = { people: 'people.json', platforms: 'platforms.json', domains: 'domains.json', iterations: 'iterations.json' } as const;

export function readMapping(dir: string): Mapping | null {
  const files = Object.entries(MAPPING_FILES).map(([k, f]) => [k, path.join(dir, f)] as const);
  if (!files.every(([, p]) => existsSync(p))) return null;
  return Object.fromEntries(files.map(([k, p]) => [k, JSON.parse(readFileSync(p, 'utf8'))])) as Mapping;
}

export function writeMapping(dir: string, m: Mapping): void {
  mkdirSync(dir, { recursive: true });
  for (const [k, f] of Object.entries(MAPPING_FILES)) {
    writeFileSync(path.join(dir, f), `${JSON.stringify(m[k as keyof Mapping], null, 2)}\n`);
  }
}

export class Resolver {
  readonly unmapped = { people: new Set<string>(), platforms: new Set<string>(), domains: new Set<string>(), iterations: new Set<string>() };
  private readonly personByAlias = new Map<string, PersonEntry>();
  private readonly personByKey = new Map<string, PersonEntry>();
  private readonly domainByAlias = new Map<string, string>();
  private readonly iterationBySource = new Map<string, IterationEntry>();

  constructor(readonly mapping: Mapping) {
    for (const p of mapping.people.people) {
      this.personByKey.set(p.key, p);
      for (const a of [...p.aliases, p.displayName, ...(p.email ? [p.email] : [])]) this.personByAlias.set(aliasKey(a), p);
    }
    for (const n of mapping.domains.nodes) for (const a of [n.name, ...n.aliases]) this.domainByAlias.set(aliasKey(a), n.name);
    for (const it of mapping.iterations.iterations) {
      for (const id of it.planeIds) this.iterationBySource.set(`plane:${id}`, it);
      for (const id of it.pushIds) this.iterationBySource.set(`push:${id}`, it);
    }
  }

  person(raw: string | null | undefined): PersonEntry | null {
    const t = raw?.trim();
    if (!t) return null;
    const p = this.personByAlias.get(aliasKey(t));
    if (!p) this.unmapped.people.add(t);
    return p ?? null;
  }

  personByMappingKey(key: string): PersonEntry | null {
    return this.personByKey.get(key) ?? null;
  }

  signoffRole(role: string): PersonEntry | null {
    const key = this.mapping.people.signoffRoles[role];
    const p = key ? this.personByKey.get(key) : undefined;
    if (!p) this.unmapped.people.add(`会签角色:${role}`);
    return p ?? null;
  }

  platforms(raw: string): string[] {
    const keys = this.mapping.platforms.aliases[aliasKey(raw)];
    if (!keys) {
      this.unmapped.platforms.add(raw);
      return [];
    }
    return keys;
  }

  domain(raw: string | null | undefined): string | null {
    const t = raw?.trim();
    if (!t) return null;
    const name = this.domainByAlias.get(aliasKey(t));
    if (!name) this.unmapped.domains.add(t);
    return name ?? null;
  }

  iteration(source: 'plane' | 'push', id: string | null | undefined): IterationEntry | null {
    const t = id?.trim();
    if (!t) return null;
    const it = this.iterationBySource.get(`${source}:${t}`);
    if (!it) this.unmapped.iterations.add(`${source}:${t}`);
    return it ?? null;
  }
}
```

- [ ] **Step 5: 实现 `suggest.ts`**

```ts
import { legacyUuid } from './ids';
import type { LegacyData } from './legacy-types';
import type { IterationEntry, Mapping, PersonEntry } from './mapping';
import { aliasKey, parseJsonArray, parseLegacyDate, splitNames, splitPlatforms } from './normalize';
import { BOSS_ROLE, DEFAULT_PLATFORM_OPTIONS, KNOWN_PLATFORM_ALIASES, parseProxySigner, SIGNOFF_ROLE_TAG } from './workflow-v1';

type Mention = { raw: string; email: string | null; role: 'owner' | 'developer' | 'requester' | 'signer' | 'other'; signoffRole?: string };

export function collectPersonMentions(data: LegacyData): Mention[] {
  const out: Mention[] = [];
  const add = (raw: string | null | undefined, role: Mention['role'], email: string | null = null, signoffRole?: string) => {
    const t = raw?.trim();
    if (t) out.push({ raw: t, email, role, signoffRole });
  };
  const { plane, push, prd } = data;
  for (const u of plane.users) add(u.name, 'other', u.email.trim().toLowerCase());
  for (const u of prd.users) add(u.name, 'other', u.email.trim().toLowerCase());
  for (const r of plane.requirements) {
    splitNames(r.requester).forEach((n) => add(n, 'requester'));
    splitNames(r.owner).forEach((n) => add(n, 'owner'));
  }
  for (const d of plane.requirementDevelopers) add(d.developer, 'developer');
  for (const s of plane.subtasks) add(s.assignee, 'developer');
  for (const c of plane.comments) add(c.user_name, 'other', c.user_email?.trim().toLowerCase() ?? null);
  for (const c of plane.commentReads) add(c.user_email, 'other', c.user_email.trim().toLowerCase());
  for (const a of plane.activityLog) add(a.user_email, 'other', a.user_email?.includes('@') ? a.user_email.trim().toLowerCase() : null);
  for (const b of plane.blockers) {
    add(b.created_by, 'other');
    add(b.resolved_by, 'other');
  }
  for (const u of plane.requirementUpdates) add(u.created_by, 'other');
  for (const l of plane.iterationLogs) add(l.created_by, 'other');
  for (const r of push.requirements) {
    splitNames(r.requester).forEach((n) => add(n, 'requester'));
    splitNames(r.owner).forEach((n) => add(n, 'owner'));
    add(r.last_edited_by, 'other');
  }
  for (const g of push.ganttTasks) {
    add(g.assignee, 'developer');
    add(g.ov_assignee, 'developer');
  }
  for (const s of push.designSignoffs) {
    if (!s.by) continue;
    const proxy = parseProxySigner(s.by);
    if (proxy) {
      add(proxy.onBehalfOf, 'signer', null, proxy.onBehalfOf);
      add(proxy.actor, 'signer', null, s.role);
    } else add(s.by, 'signer', null, s.role);
  }
  for (const r of push.prdReviews) for (const by of [r.e1_by, r.e2_by, r.e3_by, r.submitted_by]) add(by, 'other');
  for (const c of push.changeLog) add(c.edited_by, 'other');
  for (const a of push.autoReviews) add(a.reviewed_by, 'other');
  return out;
}

const localPart = (email: string) => email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9_]/g, '_');

function suggestPeople(data: LegacyData, existing: Mapping['people'] | null): Mapping['people'] {
  const people: PersonEntry[] = existing ? existing.people.map((p) => ({ ...p })) : [];
  const byAlias = new Map<string, PersonEntry>();
  const index = (p: PersonEntry) => {
    for (const a of [...p.aliases, p.displayName, ...(p.email ? [p.email] : [])]) byAlias.set(aliasKey(a), p);
  };
  people.forEach(index);
  const nameToEmail = new Map<string, string>();
  for (const u of [...data.plane.users, ...data.prd.users]) nameToEmail.set(aliasKey(u.name), u.email.trim().toLowerCase());
  const planeUser = new Map(data.plane.users.map((u) => [u.email.trim().toLowerCase(), u]));
  const usedKeys = new Set(people.map((p) => p.key));
  const uniqueKey = (base: string) => {
    let k = base;
    for (let i = 2; usedKeys.has(k); i++) k = `${base}_${i}`;
    usedKeys.add(k);
    return k;
  };
  const fresh = new Set<PersonEntry>();
  const signoffRoles: Record<string, string> = { ...(existing?.signoffRoles ?? {}) };

  for (const m of collectPersonMentions(data)) {
    if (m.signoffRole === BOSS_ROLE && m.raw === BOSS_ROLE) {
      if (!signoffRoles[BOSS_ROLE]) {
        const p = byAlias.get(aliasKey(BOSS_ROLE)) ?? addPerson(BOSS_ROLE, null);
        signoffRoles[BOSS_ROLE] = p.key;
      }
      continue;
    }
    const email = m.email ?? nameToEmail.get(aliasKey(m.raw)) ?? null;
    let p = byAlias.get(aliasKey(m.raw)) ?? (email ? byAlias.get(aliasKey(email)) : undefined);
    if (!p) p = addPerson(m.raw.includes('@') ? m.raw.split('@')[0]! : m.raw, email);
    if (!p.aliases.some((a) => aliasKey(a) === aliasKey(m.raw))) {
      p.aliases.push(m.raw);
      index(p);
    }
    if (fresh.has(p)) {
      p.mentions += 1;
      const tag =
        m.role === 'owner' ? '产品经理' : m.role === 'developer' ? '开发' : m.role === 'signer' && m.signoffRole ? SIGNOFF_ROLE_TAG[m.signoffRole] : undefined;
      if (tag && !p.functionTags.includes(tag)) p.functionTags.push(tag);
    }
  }

  function addPerson(name: string, email: string | null): PersonEntry {
    const user = email ? planeUser.get(email) : undefined;
    const p: PersonEntry = {
      key: uniqueKey(email ? `p_${localPart(email)}` : `p_${legacyUuid('person', name).slice(0, 8)}`),
      displayName: user?.name ?? name,
      email,
      orgRole: user?.role === 'admin' ? 'admin' : 'member',
      productRole: user?.role === 'viewer' ? 'viewer' : null,
      functionTags: [],
      aliases: [name, ...(user?.nickname ? [user.nickname] : [])],
      mentions: 0,
    };
    people.push(p);
    fresh.add(p);
    index(p);
    return p;
  }

  for (const p of fresh) p.functionTags.sort();
  return { people, signoffRoles };
}

function suggestPlatforms(data: LegacyData, existing: Mapping['platforms'] | null): Mapping['platforms'] {
  const options = existing ? [...existing.options] : [...DEFAULT_PLATFORM_OPTIONS];
  const aliases: Record<string, string[]> = { ...(existing?.aliases ?? {}) };
  const raws = [
    ...data.plane.requirements.flatMap((r) => splitPlatforms(r.platform)),
    ...data.plane.requirementDevelopers.map((d) => d.platform ?? ''),
    ...data.plane.versions.map((v) => v.platform ?? ''),
    ...data.push.requirements.flatMap((r) => parseJsonArray(r.platforms)),
  ].filter(Boolean);
  for (const raw of raws) {
    const k = aliasKey(raw);
    if (aliases[k]) continue;
    const known = KNOWN_PLATFORM_ALIASES[k];
    if (known) {
      aliases[k] = known;
      continue;
    }
    const key = `x_${legacyUuid('platform', k).replace(/-/g, '').slice(0, 6)}`;
    if (!options.some((o) => o.key === key)) options.push({ key, label: raw.trim() });
    aliases[k] = [key];
  }
  return { options, aliases };
}

function suggestDomains(data: LegacyData, existing: Mapping['domains'] | null): Mapping['domains'] {
  const nodes = existing ? existing.nodes.map((n) => ({ ...n, aliases: [...n.aliases] })) : [];
  const known = new Set(nodes.flatMap((n) => [n.name, ...n.aliases]).map(aliasKey));
  const push = (name: string, description: string | null) => {
    const t = name.trim();
    if (!t || known.has(aliasKey(t))) return;
    known.add(aliasKey(t));
    nodes.push({ name: t, description, aliases: [t] });
  };
  for (const d of data.prd.domains) push(d.name, [d.type, d.group].filter(Boolean).join(' · ') || null);
  const freq = new Map<string, number>();
  for (const r of data.plane.requirements) {
    const t = r.business_domain?.trim();
    if (t) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  for (const [name] of [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))) push(name, null);
  return { nodes };
}

export function iterationWindow(entry: Pick<IterationEntry, 'planeIds' | 'pushIds'>, data: LegacyData): { start: string; end: string } | null {
  const plane = data.plane.iterations.find((i) => entry.planeIds.includes(i.id));
  const push = data.push.versions.find((v) => entry.pushIds.includes(v.id));
  const start = parseLegacyDate(plane?.kickoff_date) ?? parseLegacyDate(plane?.dev_start) ?? parseLegacyDate(push?.start_date);
  const end = parseLegacyDate(push?.release_date) ?? parseLegacyDate(plane?.release_date);
  return start && end ? { start, end } : null;
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

function suggestIterations(data: LegacyData, existing: Mapping['iterations'] | null): Mapping['iterations'] {
  const entries: IterationEntry[] = existing ? existing.iterations.map((e) => ({ ...e })) : [];
  const usedPlane = new Set(entries.flatMap((e) => e.planeIds));
  const usedPush = new Set(entries.flatMap((e) => e.pushIds));
  const fresh: IterationEntry[] = [];
  const groups = new Map<string, string[]>();
  for (const it of data.plane.iterations) {
    if (usedPlane.has(it.id)) continue;
    const sig = [it.kickoff_date, it.dev_start, it.dev_end, it.release_date].join('|');
    groups.set(sig, [...(groups.get(sig) ?? []), it.id]);
  }
  for (const ids of groups.values()) {
    const plane = data.plane.iterations.find((i) => i.id === ids[0])!;
    const release = parseLegacyDate(plane.release_date);
    const pushMatch = data.push.versions.find(
      (v) => !usedPush.has(v.id) && release && parseLegacyDate(v.release_date) && daysBetween(release, parseLegacyDate(v.release_date)!) <= 1,
    );
    if (pushMatch) usedPush.add(pushMatch.id);
    fresh.push({ key: `it_${legacyUuid('iteration', ids.join('|')).slice(0, 8)}`, name: pushMatch?.id ?? ids[0]!, type: 'regular', planeIds: ids, pushIds: pushMatch ? [pushMatch.id] : [] });
  }
  for (const v of data.push.versions) {
    if (usedPush.has(v.id)) continue;
    fresh.push({ key: `it_${legacyUuid('iteration', `push:${v.id}`).slice(0, 8)}`, name: v.name?.trim() || v.id, type: 'regular', planeIds: [], pushIds: [v.id] });
  }
  const windows = new Map(fresh.map((e) => [e.key, iterationWindow(e, data)]));
  for (const e of fresh.filter((x) => x.planeIds.length === 0)) {
    const w = windows.get(e.key);
    const overlaps = [...entries, ...fresh].some((o) => {
      if (o === e || o.type !== 'regular' || o.planeIds.length === 0) return false;
      const ow = windows.get(o.key) ?? iterationWindow(o, data);
      return !!w && !!ow && w.start < ow.end && ow.start < w.end;
    });
    if (overlaps) e.type = 'special';
  }
  return { iterations: [...entries, ...fresh] };
}

export function suggestMapping(data: LegacyData, existing: Mapping | null): Mapping {
  return {
    people: suggestPeople(data, existing?.people ?? null),
    platforms: suggestPlatforms(data, existing?.platforms ?? null),
    domains: suggestDomains(data, existing?.domains ?? null),
    iterations: suggestIterations(data, existing?.iterations ?? null),
  };
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate exec vitest run test/mapping.test.ts`
Expected: PASS。若某条断言与实现不符，以测试描述的行为为准修改实现（测试描述即需求）。再跑 `pnpm --filter @flower/migrate typecheck`。

- [ ] **Step 7: 提交**

```bash
git add packages/migrate
git commit -m "feat(migrate): 对照表结构、建议生成与解析"
```

---
### Task 9: 导入计划（一）：组织、成员、职能标签、流程 v1、字段、结构树、迭代、发布版本

**Files:**
- Create: `packages/migrate/src/plan-types.ts`、`packages/migrate/src/plan-base.ts`、`packages/migrate/src/plan.ts`
- Modify: `packages/migrate/test/fixtures.ts`（增加 `reviewedMapping()`：模拟用户审阅后的对照表，Task 10、11 共用）
- Test: `packages/migrate/test/plan-base.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `Mapping`、`Resolver`、`iterationWindow`、`workflow-v1.ts` 常量；`@flower/core` 的表对象、`BUILTIN_FIELDS`、`DEFAULT_FUNCTION_TAGS`、`validateWorkflowBody`
- Produces（`plan-types.ts`）：
  - `type ImportOptions = { orgSlug: string; orgName: string; productKey: string; productName: string; asOf: string; owner: { accountId: string; email: string; name: string } | null }`
  - `type ImportRows`：键为 `organizations, members, functionTags, memberFunctionTags, workflowDefinitions, workflowVersions, products, productMembers, fieldDefinitions, fieldOptions, structureNodes, iterations, releases, requirements, fieldValues, requirementAssignments, requirementRelations, stateTransitions, blockers, checkItemResults, checkItemSignoffs, requirementReleases, tasks, comments, commentReads, entityAliases, domainEvents`，值为对应表的 `$inferInsert[]`
  - `INSERT_ORDER: Array<keyof ImportRows>`（即上面的顺序，写入时照此执行）
  - `type ReconReport = { orgSlug: string; asOf: string; sourceCounts: Record<string, number>; targetCounts: Record<string, number>; people: Array<{ key: string; displayName: string; email: string | null; orgRole: string; hasAccount: boolean; mentions: number }>; matching: { planeTotal: number; pushTotal: number; pushMergedSkipped: number; byPlaneId: number; byTitle: number; pushOnly: number; titleMatches: Array<{ displayKey: string; planeTitle: string; pushTitle: string }> }; conflicts: Array<{ displayKey: string; field: string; plane: string; push: string }>; iterations: Array<{ name: string; type: string; planeIds: string[]; pushIds: string[]; startDate: string; endDate: string; status: string; requirements: number }>; skipped: Array<{ what: string; count: number; reason: string }>; deferred: Array<{ what: string; count: number; phase: string }>; problems: string[] }`
  - `type ImportPlan = { rows: ImportRows; report: ReconReport }`
  - `class PlanContext`：`data`、`mapping`、`opts`、`resolver`、`rows`、`report`、`orgId`、`productId`、`asOfTime: Date`；`id(ns, key)`；`memberId(raw)`；`problem(msg)`；查找表 `memberIdByKey`、`tagIdByName`、`fieldId: Map<string, string>`、`optionId(fieldKey, optionKey): string | null`、`nodeIdByName`、`iterationIdByKey`、`releaseIdByPlaneId`、`workflow: WorkflowBody`
- Produces（`plan-base.ts`）：`buildBase(ctx: PlanContext): void`
- Produces（`plan.ts`）：`buildImportPlan(data: LegacyData, mapping: Mapping, opts: ImportOptions): ImportPlan`（本任务只调用 `buildBase`；Task 10 追加需求部分）

- [ ] **Step 1: 写失败的测试**

在 `packages/migrate/test/fixtures.ts` 顶部加入 `import type { Mapping } from '../src/mapping';` 与 `import { suggestMapping } from '../src/suggest';`，末尾追加：

```ts
/** 模拟用户审阅后的对照表：会签角色"饶总"指向王老板，业务域"会员"并入"会员与支付"。 */
export function reviewedMapping(): Mapping {
  const data = makeLegacyData();
  const m = suggestMapping(data, null);
  const boss = m.people.people.find((p) => p.displayName === '王老板')!;
  m.people.signoffRoles['饶总'] = boss.key;
  m.people.people = m.people.people.filter((p) => p.displayName !== '饶总');
  m.domains.nodes = [
    { name: '会员与支付', description: '产品域 · 增长组', aliases: ['会员与支付', '会员'] },
    { name: '跨盘迁移', description: '产品域 · 基础组', aliases: ['跨盘迁移'] },
  ];
  return m;
}
```

`packages/migrate/test/plan-base.test.ts`：

```ts
import { validateWorkflowBody } from '@flower/core';
import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import type { ImportOptions } from '../src/plan-types';
import { makeLegacyData, reviewedMapping } from './fixtures';

const OPTS: ImportOptions = {
  orgSlug: 'pan123',
  orgName: '123云盘',
  productKey: 'PAN',
  productName: '123云盘',
  asOf: '2026-09-29',
  owner: { accountId: '0192f000-0000-7000-8000-000000000001', email: 'zhangsan@example.com', name: '张三' },
};

describe('导入计划：基础部分', () => {
  const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), OPTS);
  const { rows } = plan;

  it('建立组织与产品，产品使用迁移生成的流程 v1', () => {
    expect(rows.organizations).toMatchObject([{ slug: 'pan123', name: '123云盘' }]);
    expect(rows.products).toMatchObject([{ key: 'PAN', name: '123云盘', workflowVersionId: rows.workflowVersions[0]!.id }]);
    expect(rows.workflowDefinitions).toMatchObject([{ name: '123云盘流程', productId: null }]);
    const r = validateWorkflowBody(rows.workflowVersions[0]!.body, { fieldKeys: ['priority', 'platform', 'source', 'line'] });
    expect(r.ok).toBe(true);
  });

  it('成员来自人员对照表；与当前账号邮箱相同的人成为所有者', () => {
    const zs = rows.members.find((m) => m.displayName === '张三')!;
    expect(zs).toMatchObject({ orgRole: 'owner', accountId: OPTS.owner!.accountId });
    expect(rows.members.filter((m) => m.accountId)).toHaveLength(1);
    const boss = rows.members.find((m) => m.displayName === '王老板')!;
    expect(rows.productMembers).toEqual([expect.objectContaining({ memberId: boss.id, role: 'viewer' })]);
  });

  it('设计签字的第 4 条规则指向对照表中的会签角色成员', () => {
    const body = rows.workflowVersions[0]!.body as { checkItems: Array<{ key: string; signers?: Array<{ by: string; ref: string }> }> };
    const design = body.checkItems.find((c) => c.key === 'design_signoff')!;
    expect(design.signers).toHaveLength(4);
    expect(design.signers![3]).toEqual({ by: 'member', ref: rows.members.find((m) => m.displayName === '王老板')!.id });
    const tagNames = rows.functionTags.map((t) => t.name);
    expect(tagNames).toEqual(expect.arrayContaining(['产品经理', '设计', '开发', '测试', '线条负责人', '产品负责人']));
  });

  it('字段：优先级含"绿色通道"，平台含对照表里新增的选项', () => {
    const opt = (fieldKey: string) => rows.fieldOptions.filter((o) => o.fieldId === rows.fieldDefinitions.find((f) => f.key === fieldKey)!.id).map((o) => o.label);
    expect(opt('priority')).toEqual(['P0', 'P1', 'P2', 'P3', '绿色通道']);
    expect(opt('platform')).toEqual(expect.arrayContaining(['PC客户端', '移动端', 'Web端', '小程序', '鸿蒙']));
    expect(opt('line')).toEqual(['功能', '商业']);
  });

  it('结构树第一层来自业务域对照表', () => {
    expect(rows.structureNodes.map((n) => [n.name, n.depth])).toEqual([
      ['会员与支付', 1],
      ['跨盘迁移', 1],
    ]);
  });

  it('迭代：合并后的日期、状态和专项', () => {
    const byName = (n: string) => rows.iterations.find((i) => i.name === n)!;
    expect(byName('it0316')).toMatchObject({ type: 'regular', startDate: '2026-03-02', endDate: '2026-03-16', status: 'done', legacyKey: 'V1|V1dup|it0316' });
    expect(byName('it0330')).toMatchObject({ startDate: '2026-03-17', endDate: '2026-03-31', status: 'done' });
    expect(byName('专项')).toMatchObject({ type: 'special', productId: null });
    expect(byName('it0316').milestones).toEqual(expect.arrayContaining([{ label: '发布', date: '2026-03-16' }]));
  });

  it('发布版本：拆出版本号和平台，没有计划日期', () => {
    expect(rows.releases).toMatchObject([{ versionName: '1.0.0', status: 'released', plannedDate: null, legacyKey: 'pc-1.0.0' }]);
    expect(rows.releases[0]!.platformOptionId).toBe(rows.fieldOptions.find((o) => o.label === 'PC客户端')!.id);
  });

  it('同样的输入得到同样的计划', () => {
    expect(buildImportPlan(makeLegacyData(), reviewedMapping(), OPTS)).toEqual(plan);
  });
});

describe('导入计划：阻止写入的问题', () => {
  it('会签角色没有对应成员', () => {
    const m = reviewedMapping();
    delete m.people.signoffRoles['饶总'];
    expect(buildImportPlan(makeLegacyData(), m, OPTS).report.problems).toContain('会签角色「饶总」没有对应成员（people.json 的 signoffRoles）');
  });

  it('常规迭代时间重叠', () => {
    const m = reviewedMapping();
    m.iterations.iterations.find((i) => i.name === '专项')!.type = 'regular';
    expect(buildImportPlan(makeLegacyData(), m, OPTS).report.problems.join('\n')).toMatch(/常规迭代「.+」与「.+」时间重叠/);
  });
});
```

Run: `pnpm --filter @flower/migrate exec vitest run test/plan-base.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现 `plan-types.ts`**

```ts
import type * as core from '@flower/core';
import { legacyUuid } from './ids';
import type { LegacyData } from './legacy-types';
import { type Mapping, Resolver } from './mapping';
import { parseLegacyTime } from './normalize';

export type ImportOptions = {
  orgSlug: string;
  orgName: string;
  productKey: string;
  productName: string;
  asOf: string;
  owner: { accountId: string; email: string; name: string } | null;
};

type Ins<T extends { $inferInsert: unknown }> = Array<T['$inferInsert']>;
export type ImportRows = {
  organizations: Ins<typeof core.organizations>;
  members: Ins<typeof core.members>;
  functionTags: Ins<typeof core.functionTags>;
  memberFunctionTags: Ins<typeof core.memberFunctionTags>;
  workflowDefinitions: Ins<typeof core.workflowDefinitions>;
  workflowVersions: Ins<typeof core.workflowVersions>;
  products: Ins<typeof core.products>;
  productMembers: Ins<typeof core.productMembers>;
  fieldDefinitions: Ins<typeof core.fieldDefinitions>;
  fieldOptions: Ins<typeof core.fieldOptions>;
  structureNodes: Ins<typeof core.structureNodes>;
  iterations: Ins<typeof core.iterations>;
  releases: Ins<typeof core.releases>;
  requirements: Ins<typeof core.requirements>;
  fieldValues: Ins<typeof core.fieldValues>;
  requirementAssignments: Ins<typeof core.requirementAssignments>;
  requirementRelations: Ins<typeof core.requirementRelations>;
  stateTransitions: Ins<typeof core.stateTransitions>;
  blockers: Ins<typeof core.blockers>;
  checkItemResults: Ins<typeof core.checkItemResults>;
  checkItemSignoffs: Ins<typeof core.checkItemSignoffs>;
  requirementReleases: Ins<typeof core.requirementReleases>;
  tasks: Ins<typeof core.tasks>;
  comments: Ins<typeof core.comments>;
  commentReads: Ins<typeof core.commentReads>;
  entityAliases: Ins<typeof core.entityAliases>;
  domainEvents: Ins<typeof core.domainEvents>;
};

export const INSERT_ORDER: Array<keyof ImportRows> = [
  'organizations', 'members', 'functionTags', 'memberFunctionTags', 'workflowDefinitions', 'workflowVersions', 'products',
  'productMembers', 'fieldDefinitions', 'fieldOptions', 'structureNodes', 'iterations', 'releases', 'requirements', 'fieldValues',
  'requirementAssignments', 'requirementRelations', 'stateTransitions', 'blockers', 'checkItemResults', 'checkItemSignoffs',
  'requirementReleases', 'tasks', 'comments', 'commentReads', 'entityAliases', 'domainEvents',
];

export type ReconReport = {
  orgSlug: string;
  asOf: string;
  sourceCounts: Record<string, number>;
  targetCounts: Record<string, number>;
  people: Array<{ key: string; displayName: string; email: string | null; orgRole: string; hasAccount: boolean; mentions: number }>;
  matching: {
    planeTotal: number;
    pushTotal: number;
    pushMergedSkipped: number;
    byPlaneId: number;
    byTitle: number;
    pushOnly: number;
    titleMatches: Array<{ displayKey: string; planeTitle: string; pushTitle: string }>;
  };
  conflicts: Array<{ displayKey: string; field: string; plane: string; push: string }>;
  iterations: Array<{ name: string; type: string; planeIds: string[]; pushIds: string[]; startDate: string; endDate: string; status: string; requirements: number }>;
  skipped: Array<{ what: string; count: number; reason: string }>;
  deferred: Array<{ what: string; count: number; phase: string }>;
  problems: string[];
};

export type ImportPlan = { rows: ImportRows; report: ReconReport };

export const emptyRows = (): ImportRows => Object.fromEntries(INSERT_ORDER.map((k) => [k, []])) as unknown as ImportRows;

export class PlanContext {
  readonly resolver: Resolver;
  readonly rows: ImportRows = emptyRows();
  readonly report: ReconReport;
  readonly orgId: string;
  readonly productId: string;
  readonly asOfTime: Date;
  readonly memberIdByKey = new Map<string, string>();
  readonly tagIdByName = new Map<string, string>();
  readonly fieldId = new Map<string, string>();
  readonly nodeIdByName = new Map<string, string>();
  readonly iterationIdByKey = new Map<string, string>();
  readonly releaseIdByPlaneId = new Map<string, string>();
  workflow!: core.WorkflowBody;

  constructor(
    readonly data: LegacyData,
    readonly mapping: Mapping,
    readonly opts: ImportOptions,
  ) {
    this.resolver = new Resolver(mapping);
    this.orgId = this.id('org', opts.orgSlug);
    this.productId = this.id('product', opts.productKey);
    this.asOfTime = new Date(`${opts.asOf}T00:00:00Z`);
    this.report = {
      orgSlug: opts.orgSlug,
      asOf: opts.asOf,
      sourceCounts: {},
      targetCounts: {},
      people: [],
      matching: { planeTotal: 0, pushTotal: 0, pushMergedSkipped: 0, byPlaneId: 0, byTitle: 0, pushOnly: 0, titleMatches: [] },
      conflicts: [],
      iterations: [],
      skipped: [],
      deferred: [],
      problems: [],
    };
  }

  id(ns: string, key: string): string {
    return legacyUuid(`${this.opts.orgSlug}/${ns}`, key);
  }

  memberId(raw: string | null | undefined): string | null {
    const p = this.resolver.person(raw);
    return p ? (this.memberIdByKey.get(p.key) ?? null) : null;
  }

  optionId(fieldKey: string, optionKey: string): string | null {
    const fieldId = this.fieldId.get(fieldKey);
    return this.rows.fieldOptions.find((o) => o.fieldId === fieldId && o.key === optionKey)?.id ?? null;
  }

  time(s: string | null | undefined, fallback?: Date): Date {
    return parseLegacyTime(s) ?? fallback ?? this.asOfTime;
  }

  problem(msg: string): void {
    if (!this.report.problems.includes(msg)) this.report.problems.push(msg);
  }
}
```

- [ ] **Step 3: 实现 `plan-base.ts`**

```ts
import { BUILTIN_FIELDS, DEFAULT_FUNCTION_TAGS, type IterationMilestone, validateWorkflowBody } from '@flower/core';
import { parseLegacyDate, parseLegacyTime } from './normalize';
import type { PlanContext } from './plan-types';
import { iterationWindow } from './suggest';
import {
  ALL_FUNCTION_TAG_NAMES,
  BOSS_ROLE,
  buildWorkflowV1Body,
  LINE_OPTIONS,
  PLANE_ITERATION_STATUS,
  PRIORITY_OPTIONS,
  PUSH_VERSION_STATUS,
  SOURCE_OPTIONS,
} from './workflow-v1';

const EXTRA_TAG_COLORS = ['#b7791f', '#db2777', '#5c6570', '#1e8a5a', '#0f766e'];

export function buildBase(ctx: PlanContext): void {
  const { rows, opts, mapping, data, orgId, productId } = ctx;
  const createdAt = ctx.asOfTime;
  rows.organizations.push({ id: orgId, slug: opts.orgSlug, name: opts.orgName, settings: {}, createdAt });

  // 职能标签
  const tagNames = [...ALL_FUNCTION_TAG_NAMES];
  for (const p of mapping.people.people) for (const t of p.functionTags) if (!tagNames.includes(t)) tagNames.push(t);
  tagNames.forEach((name, i) => {
    const color = DEFAULT_FUNCTION_TAGS.find((t) => t.name === name)?.color ?? EXTRA_TAG_COLORS[i % EXTRA_TAG_COLORS.length]!;
    const id = ctx.id('tag', name);
    ctx.tagIdByName.set(name, id);
    rows.functionTags.push({ id, orgId, name, color, sort: i });
  });

  // 成员
  const ownerEmail = opts.owner?.email.trim().toLowerCase();
  let ownerLinked = false;
  for (const p of mapping.people.people) {
    const id = ctx.id('member', p.key);
    ctx.memberIdByKey.set(p.key, id);
    const isOwner = !!ownerEmail && p.email?.toLowerCase() === ownerEmail;
    ownerLinked ||= isOwner;
    rows.members.push({
      id,
      orgId,
      accountId: isOwner ? opts.owner!.accountId : null,
      kind: 'human',
      displayName: p.displayName,
      email: p.email,
      orgRole: isOwner ? 'owner' : p.orgRole,
      status: 'active',
      createdAt,
    });
    for (const t of p.functionTags) rows.memberFunctionTags.push({ orgId, memberId: id, tagId: ctx.tagIdByName.get(t)! });
    if (p.productRole && !isOwner && p.orgRole !== 'admin') rows.productMembers.push({ orgId, productId, memberId: id, role: p.productRole });
    ctx.report.people.push({ key: p.key, displayName: p.displayName, email: p.email, orgRole: isOwner ? 'owner' : p.orgRole, hasAccount: isOwner, mentions: p.mentions });
  }
  if (opts.owner && !ownerLinked) {
    rows.members.push({ id: ctx.id('member', '__owner'), orgId, accountId: opts.owner.accountId, kind: 'human', displayName: opts.owner.name, email: ownerEmail ?? null, orgRole: 'owner', status: 'active', createdAt });
  }

  // 字段与选项
  const optionSets: Record<string, Array<{ key: string; label: string; color?: string | null }>> = {
    priority: PRIORITY_OPTIONS,
    platform: mapping.platforms.options,
    source: SOURCE_OPTIONS,
    line: LINE_OPTIONS,
  };
  for (const f of BUILTIN_FIELDS) {
    const fieldId = ctx.id('field', f.key);
    ctx.fieldId.set(f.key, fieldId);
    rows.fieldDefinitions.push({ id: fieldId, orgId, productId: null, key: f.key, label: f.label, cardinality: f.cardinality, builtin: true, createdAt });
    (optionSets[f.key] ?? []).forEach((o, i) =>
      rows.fieldOptions.push({ id: ctx.id('option', `${f.key}:${o.key}`), orgId, fieldId, key: o.key, label: o.label, color: o.color ?? null, sort: i, active: true }),
    );
  }

  // 流程 v1
  const boss = ctx.resolver.signoffRole(BOSS_ROLE);
  if (!boss) ctx.problem(`会签角色「${BOSS_ROLE}」没有对应成员（people.json 的 signoffRoles）`);
  const bossId = boss ? ctx.memberIdByKey.get(boss.key)! : ctx.id('member', '__missing_boss');
  ctx.workflow = buildWorkflowV1Body(ctx.tagIdByName, bossId);
  const valid = validateWorkflowBody(ctx.workflow, { fieldKeys: BUILTIN_FIELDS.map((f) => f.key) });
  if (!valid.ok) ctx.problem(`流程 v1 校验失败：${valid.issues.map((i) => `${i.path} ${i.message}`).join('；')}`);
  const definitionId = ctx.id('workflow', 'v1');
  const versionId = ctx.id('workflow-version', 'v1');
  rows.workflowDefinitions.push({ id: definitionId, orgId, productId: null, name: '123云盘流程', currentVersionId: versionId, createdAt });
  rows.workflowVersions.push({ id: versionId, orgId, definitionId, version: 1, body: ctx.workflow, note: '由旧系统迁移生成', createdBy: null, createdAt });
  rows.products.push({ id: productId, orgId, key: opts.productKey, name: opts.productName, status: 'active', workflowVersionId: versionId, requirementSeq: 0, createdAt });

  // 结构树第一层
  mapping.domains.nodes.forEach((n, i) => {
    const id = ctx.id('node', n.name);
    ctx.nodeIdByName.set(n.name, id);
    rows.structureNodes.push({ id, orgId, productId, parentId: null, depth: 1, name: n.name, description: n.description, status: 'active', sort: i, legacyKey: n.aliases.join('|'), createdAt });
  });

  // 迭代
  for (const e of mapping.iterations.iterations) {
    const w = iterationWindow(e, data);
    if (!w) {
      ctx.problem(`迭代「${e.name}」缺少开始或发布日期`);
      continue;
    }
    if (w.start > w.end) ctx.problem(`迭代「${e.name}」开始日期晚于结束日期`);
    const plane = data.plane.iterations.find((i) => e.planeIds.includes(i.id));
    const push = data.push.versions.find((v) => e.pushIds.includes(v.id));
    let status = (plane?.status && PLANE_ITERATION_STATUS[plane.status]) || (push?.status && PUSH_VERSION_STATUS[push.status]) || 'planning';
    if (w.end < ctx.opts.asOf) status = 'done';
    const milestones: IterationMilestone[] = plane
      ? ([
          ['预发布', plane.pre_launch_date],
          ['启动', plane.kickoff_date],
          ['开发开始', plane.dev_start],
          ['开发结束', plane.dev_end],
          ['中间发布', plane.interim_release_date],
          ['发布', push?.release_date ?? plane.release_date],
        ] as const)
          .map(([label, d]) => ({ label, date: parseLegacyDate(d) ?? '' }))
          .filter((m) => m.date)
      : [
          { label: '开始', date: w.start },
          { label: '发布', date: w.end },
        ];
    const id = ctx.id('iteration', e.key);
    ctx.iterationIdByKey.set(e.key, id);
    rows.iterations.push({
      id,
      orgId,
      productId: e.type === 'regular' ? productId : null,
      type: e.type,
      name: e.name,
      legacyKey: [...e.planeIds, ...e.pushIds].join('|'),
      startDate: w.start,
      endDate: w.end,
      baselineEndDate: status === 'planning' ? null : w.end,
      status,
      milestones,
      createdAt,
    });
  }
  const regular = rows.iterations.filter((i) => i.type === 'regular').sort((a, b) => a.startDate.localeCompare(b.startDate));
  for (let i = 1; i < regular.length; i++) {
    const prev = regular[i - 1]!;
    const cur = regular[i]!;
    if (cur.startDate < prev.endDate) ctx.problem(`常规迭代「${prev.name}」与「${cur.name}」时间重叠（结束日可以等于下一迭代的开始日）`);
  }

  // 发布版本
  for (const v of data.plane.versions) {
    const platformKey = v.platform ? ctx.resolver.platforms(v.platform)[0] : undefined;
    const id = ctx.id('release', v.id);
    ctx.releaseIdByPlaneId.set(v.id, id);
    rows.releases.push({
      id,
      orgId,
      productId,
      platformOptionId: platformKey ? ctx.optionId('platform', platformKey) : null,
      versionName: v.id.includes('-') ? v.id.slice(v.id.indexOf('-') + 1) : v.id,
      iterationId: null,
      status: v.status === 'released' ? 'released' : 'planned',
      plannedDate: parseLegacyDate(v.planned_release_date),
      baselineDate: parseLegacyDate(v.planned_release_date),
      releasedAt: parseLegacyTime(v.released_at),
      notes: [v.description, v.release_content].filter((x) => x?.trim()).join('\n\n') || null,
      legacyKey: v.id,
      createdAt,
    });
  }
}
```

`packages/migrate/src/plan.ts`：

```ts
import type { LegacyData } from './legacy-types';
import type { Mapping } from './mapping';
import { buildBase } from './plan-base';
import { type ImportOptions, type ImportPlan, PlanContext } from './plan-types';

export function buildImportPlan(data: LegacyData, mapping: Mapping, opts: ImportOptions): ImportPlan {
  const ctx = new PlanContext(data, mapping, opts);
  buildBase(ctx);
  return { rows: ctx.rows, report: ctx.report };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate exec vitest run test/plan-base.test.ts`
Expected: PASS。再跑 `pnpm --filter @flower/migrate typecheck`。

- [ ] **Step 5: 提交**

```bash
git add packages/migrate
git commit -m "feat(migrate): 导入计划的组织、成员、流程、字段、结构树、迭代与发布版本部分"
```

---
### Task 10: 导入计划（二）：需求合并及其附属数据、审计事件、对账统计

**Files:**
- Create: `packages/migrate/src/plan-requirements.ts`
- Modify: `packages/migrate/src/plan.ts`（调用 `buildRequirements`，汇总未解析值与数量）
- Test: `packages/migrate/test/plan-requirements.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `PlanContext`（`buildBase` 执行后的查找表）、`workflow-v1.ts` 常量、`@flower/core` 的 `signoffResultState`、`CheckState`
- Produces：`buildRequirements(ctx: PlanContext): void`；`buildImportPlan` 返回完整计划，`report.problems` 非空时 CLI 拒绝写库
- 规则（spec §7.2、§7.3）：
  - 以 123plane 为主体；push 中 `merged_into` 非空的跳过；其余先按 `plane_id` 匹配，再按归一化标题唯一匹配，剩下的作为 push 独有需求
  - 编号：123plane 需求按 `(created_at, id)` 排序编为 1…n，push 独有需求按同样规则接着编
  - 标题、描述、优先级、负责人、提出人以 123plane 为准；迭代以 push 为准（push 未进迭代时用 123plane 的）；评审（背景、可行性、行业、设计签字、AI 预审）以 push 为准
  - 负责人字段写了多人时，第一人作为负责人，其余写入 `legacyMeta.plane.coOwners` / `legacyMeta.push.coOwners`
  - 123plane 的 `source` 自由文本、`phase`、`acceptance_status`、`iteration_status`、`estimated_effort`、`notes` 写入 `legacyMeta.plane`；push 的 `alias`、`developers`、`last_edited_by` 写入 `legacyMeta.push`；PRD 链接不迁移
  - 主状态：123plane 需求按状态中文名映射；push 独有需求为"待评估"，push 状态"已搁置"的为"已搁置"
  - 检查项：只为非"未开始"或带备注 / 元数据的检查项写结果行
  - 甘特任务状态按 `--as-of` 计算：`plan_start + plan_days + delay_days` 不晚于该日为已完成，已开始为进行中，否则待开始
  - 历史流转：每条需求先补一条"创建"（`from = null`，`to` 为第一条流转的起点或当前状态，时间为创建时间），再按 activity_log 的 `status_change` 依次追加
  - 审计：activity_log 全部写成 `legacy.123plane.<action>`，push change_log 写成 `legacy.push.change`；主体是已删除需求时用确定性的占位 ID

- [ ] **Step 1: 写失败的测试**

`packages/migrate/test/plan-requirements.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import type { ImportOptions } from '../src/plan-types';
import { makeLegacyData, reviewedMapping } from './fixtures';

const OPTS: ImportOptions = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null };

describe('导入计划：需求', () => {
  const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), OPTS);
  const { rows, report } = plan;
  const req = (n: number) => rows.requirements.find((r) => r.number === n)!;
  const member = (name: string) => rows.members.find((m) => m.displayName === name)!.id;
  const option = (label: string) => rows.fieldOptions.find((o) => o.label === label)!.id;
  const valuesOf = (reqId: string) => rows.fieldValues.filter((v) => v.entityId === reqId).map((v) => rows.fieldOptions.find((o) => o.id === v.optionId)!.label).sort();
  const checks = (reqId: string) => Object.fromEntries(rows.checkItemResults.filter((c) => c.targetId === reqId).map((c) => [c.itemKey, c.state]));

  it('合并结果与编号', () => {
    expect(report.problems).toEqual([]);
    expect(report.matching).toMatchObject({ planeTotal: 3, pushTotal: 5, pushMergedSkipped: 1, byPlaneId: 1, byTitle: 1, pushOnly: 2 });
    expect(report.matching.titleMatches).toEqual([{ displayKey: 'PAN-2', planeTitle: '相册归类', pushTitle: '相册 归类！' }]);
    expect(rows.requirements.map((r) => [r.number, r.title, r.legacyKey])).toEqual([
      [1, '批量下载', 'X001'],
      [2, '相册归类', 'X002'],
      [3, '分享密码', 'X003'],
      [4, '离线下载', 'push-3'],
      [5, '已搁置需求', 'push-5'],
    ]);
    expect(rows.products[0]!.requirementSeq).toBe(5);
    expect(rows.entityAliases.map((a) => a.alias).sort()).toEqual(['X001', 'X002', 'X003', 'push-1', 'push-2', 'push-3', 'push-5']);
  });

  it('字段冲突以 123plane 为准并列入报告', () => {
    expect(report.conflicts).toEqual(
      expect.arrayContaining([
        { displayKey: 'PAN-1', field: 'priority', plane: 'P1', push: 'P0' },
        { displayKey: 'PAN-1', field: 'title', plane: '批量下载', push: '批量下载（PC/Web）' },
      ]),
    );
    expect(valuesOf(req(1).id!)).toEqual(['P1', 'PC客户端', 'Web端', '功能', '原创'].sort());
  });

  it('PAN-1：迭代以 push 为准，评审与会签来自 push，PRD 来自 123plane', () => {
    const r = req(1);
    expect(r).toMatchObject({ stateKey: 'developing', ownerMemberId: member('张三'), iterationId: rows.iterations.find((i) => i.name === 'it0316')!.id });
    expect(checks(r.id!)).toEqual({ background: 'passed', feasibility: 'passed', industry: 'in_progress', prd: 'passed', design_signoff: 'in_progress', ai_review: 'passed' });
    const design = rows.checkItemResults.find((c) => c.targetId === r.id && c.itemKey === 'design_signoff')!;
    const signoffs = rows.checkItemSignoffs.filter((s) => s.resultId === design.id);
    expect(signoffs.map((s) => [s.signerRuleIndex, s.decision])).toEqual([
      [0, 'passed'],
      [1, 'passed'],
      [3, 'passed'],
    ]);
    expect(signoffs.find((s) => s.signerRuleIndex === 3)).toMatchObject({ signerMemberId: member('王老板'), actedByMemberId: member('张三'), note: '同意' });
    const ai = rows.checkItemResults.find((c) => c.targetId === r.id && c.itemKey === 'ai_review')!;
    expect((ai.meta as { rounds: unknown[] }).rounds).toHaveLength(2);
    expect(rows.checkItemResults.find((c) => c.targetId === r.id && c.itemKey === 'background')).toMatchObject({ note: '背景清楚', updatedBy: member('张三') });
    expect(r.legacyMeta).toMatchObject({ plane: { id: 'X001' }, push: { id: 1, developers: ['前端'] } });
  });

  it('PAN-2：多负责人、绿色通道、全端，push 评审中的检查项为进行中', () => {
    const r = req(2);
    expect(r).toMatchObject({ stateKey: 'collect', ownerMemberId: member('李四'), nodeId: rows.structureNodes.find((n) => n.name === '会员与支付')!.id });
    expect(r.legacyMeta).toMatchObject({ plane: { coOwners: ['张三'] } });
    expect(valuesOf(r.id!)).toEqual(['PC客户端', 'Web端', '小程序', '移动端', '绿色通道', '功能', '原创'].sort());
    expect(checks(r.id!)).toEqual({ background: 'in_progress', feasibility: 'in_progress', industry: 'in_progress' });
  });

  it('push 独有需求', () => {
    expect(req(4)).toMatchObject({ stateKey: 'to_evaluate', description: '支持离线下载', ownerMemberId: member('赵六'), nodeId: null });
    expect(valuesOf(req(4).id!)).toEqual(['P2', '商业', '线上问题', '鸿蒙'].sort());
    expect(req(5).stateKey).toBe('shelved');
  });

  it('开发分配、发布版本关联、阻塞项', () => {
    expect(rows.requirementAssignments.filter((a) => a.requirementId === req(1).id).map((a) => a.platformOptionId).sort()).toEqual([option('PC客户端'), option('Web端')].sort());
    expect(rows.requirementReleases).toEqual([expect.objectContaining({ requirementId: req(3).id })]);
    expect(rows.blockers).toMatchObject([{ requirementId: req(1).id, description: '等待支付接口', status: 'active' }]);
  });

  it('流转历史：补一条创建，再按日志追加', () => {
    const history = rows.stateTransitions.filter((s) => s.requirementId === req(1).id).map((s) => [s.fromState, s.toState]);
    expect(history).toEqual([
      [null, 'collect'],
      ['collect', 'developing'],
    ]);
    expect(req(1).stateChangedAt).toEqual(new Date('2026-03-05T00:00:00Z'));
    expect(rows.stateTransitions.filter((s) => s.requirementId === req(3).id).map((s) => [s.fromState, s.toState])).toEqual([[null, 'launched']]);
  });

  it('评论、进展、迭代日志与已读', () => {
    const bodies = rows.comments.map((c) => [c.targetType, c.kind, c.body]);
    expect(bodies).toEqual(
      expect.arrayContaining([
        ['requirement', 'comment', '请确认范围'],
        ['requirement', 'update', '联调中'],
        ['iteration', 'update', '【风险】人手紧张'],
      ]),
    );
    expect(rows.comments).toHaveLength(3);
    expect(rows.commentReads).toEqual([expect.objectContaining({ memberId: member('张三') })]);
    expect(report.skipped).toEqual(expect.arrayContaining([{ what: '已删除需求上的评论', count: 1, reason: '需求已在 123plane 中物理删除' }]));
  });

  it('任务：子任务与甘特任务，状态按日期计算', () => {
    const byTitle = (t: string) => rows.tasks.find((x) => x.title === t)!;
    expect(byTitle('接口联调')).toMatchObject({ requirementId: req(1).id, status: 'todo', assigneeMemberId: member('王五') });
    expect(byTitle('前端开发')).toMatchObject({ requirementId: req(1).id, status: 'done', planStart: '2026-03-02', planDays: 5 });
    expect(byTitle('专项设计')).toMatchObject({ requirementId: null, status: 'doing', starred: true, flag: '关注' });
  });

  it('审计事件：123plane 动态与 push 变更记录', () => {
    expect(rows.domainEvents.map((e) => e.type).sort()).toEqual(['legacy.123plane.created', 'legacy.123plane.deleted', 'legacy.123plane.status_change', 'legacy.push.change']);
    const deleted = rows.domainEvents.find((e) => e.type === 'legacy.123plane.deleted')!;
    expect(rows.requirements.some((r) => r.id === deleted.subjectId)).toBe(false);
    expect(deleted.occurredAt).toEqual(new Date('2026-03-06T00:00:00Z'));
  });

  it('对账数量与延后项', () => {
    expect(report.targetCounts).toMatchObject({ requirements: 5, comments: 3, tasks: 3, domainEvents: 4 });
    expect(report.sourceCounts).toMatchObject({ 'plane.requirements': 3, 'push.requirements': 5, 'push.ganttTasks': 2 });
    expect(report.deferred).toEqual(expect.arrayContaining([{ what: '123plane 需求简报（HTML）', count: 1, phase: 'P2 文档附件' }]));
    expect(report.iterations.find((i) => i.name === 'it0316')).toMatchObject({ requirements: 1 });
  });

  it('未解析的原始值与未知状态会阻止写入', () => {
    const data = makeLegacyData();
    data.plane.requirements[0]!.status = '神秘状态';
    data.plane.requirements[1]!.requester = '新面孔';
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    expect(p.report.problems).toEqual(expect.arrayContaining(['123plane 状态「神秘状态」没有对应的流程状态', '人员对照表缺少：新面孔']));
  });

  it('同样的输入得到同样的计划', () => {
    expect(buildImportPlan(makeLegacyData(), reviewedMapping(), OPTS)).toEqual(plan);
  });
});
```

Run: `pnpm --filter @flower/migrate exec vitest run test/plan-requirements.test.ts`
Expected: FAIL，`buildRequirements` 不存在、需求为空。

- [ ] **Step 2: 实现 `plan-requirements.ts`**

```ts
import { type CheckState, signoffResultState } from '@flower/core';
import type { PlaneRequirement, PushRequirement } from './legacy-types';
import { addDays, normTitle, parseJsonArray, parseLegacyDate, splitNames, splitPlatforms } from './normalize';
import type { PlanContext } from './plan-types';
import {
  BLOCKER_STATUS,
  FEASIBILITY_TO_CHECK,
  ITERATION_LOG_LABEL,
  LINE_OPTIONS,
  PLANE_STATUS_TO_STATE,
  PRD_STATUS_TO_CHECK,
  PRIORITY_KEYS,
  PUSH_REVIEW_TO_CHECK,
  PUSH_STATUS_TO_CHECK,
  parseProxySigner,
  SIGNOFF_DECISION,
  SIGNOFF_ROLES,
  SOURCE_OPTIONS,
  SUBTASK_STATUS,
} from './workflow-v1';

type Pair = { plane: PlaneRequirement | null; push: PushRequirement | null };
type CheckRow = { state: CheckState; note?: string | null; meta?: Record<string, unknown>; updatedBy?: string | null; updatedAt?: Date };

const byCreated = <T extends { created_at: string | null; id: string | number }>(a: T, b: T) =>
  (a.created_at ?? '').localeCompare(b.created_at ?? '') || String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

export function buildRequirements(ctx: PlanContext): void {
  const { data, rows, report, orgId, productId, resolver } = ctx;
  const planeReqs = [...data.plane.requirements].sort(byCreated);
  const pushAll = [...data.push.requirements].sort(byCreated);
  const pushActive = pushAll.filter((p) => p.merged_into === null);
  const planeById = new Map(planeReqs.map((r) => [r.id, r]));

  // 1. 匹配
  const pushForPlane = new Map<string, PushRequirement>();
  const matchedBy = new Map<number, 'plane_id' | 'title'>();
  for (const p of pushActive) {
    const pid = p.plane_id?.trim();
    if (pid && planeById.has(pid) && !pushForPlane.has(pid)) {
      pushForPlane.set(pid, p);
      matchedBy.set(p.id, 'plane_id');
    }
  }
  for (const p of pushActive) {
    if (matchedBy.has(p.id)) continue;
    const t = normTitle(p.title);
    const candidates = planeReqs.filter((r) => !pushForPlane.has(r.id) && normTitle(r.title) === t);
    if (candidates.length === 1) {
      pushForPlane.set(candidates[0]!.id, p);
      matchedBy.set(p.id, 'title');
    }
  }
  const pushOnly = pushActive.filter((p) => !matchedBy.has(p.id));
  const pairs: Pair[] = [...planeReqs.map((r) => ({ plane: r, push: pushForPlane.get(r.id) ?? null })), ...pushOnly.map((p) => ({ plane: null, push: p }))];

  const reqIdOfPlane = new Map<string, string>();
  const reqIdOfPush = new Map<number, string>();
  pairs.forEach((pair) => {
    const id = pair.plane ? ctx.id('req', `plane:${pair.plane.id}`) : ctx.id('req', `push:${pair.push!.id}`);
    if (pair.plane) reqIdOfPlane.set(pair.plane.id, id);
    if (pair.push) reqIdOfPush.set(pair.push.id, id);
  });
  const displayKey = (n: number) => `${ctx.opts.productKey}-${n}`;
  Object.assign(report.matching, {
    planeTotal: planeReqs.length,
    pushTotal: pushAll.length,
    pushMergedSkipped: pushAll.length - pushActive.length,
    byPlaneId: [...matchedBy.values()].filter((x) => x === 'plane_id').length,
    byTitle: [...matchedBy.values()].filter((x) => x === 'title').length,
    pushOnly: pushOnly.length,
  });

  // 2. 逐条需求
  const iterationOf = new Map<string, string | null>();
  pairs.forEach((pair, index) => {
    const number = index + 1;
    const { plane, push } = pair;
    const id = plane ? reqIdOfPlane.get(plane.id)! : reqIdOfPush.get(push!.id)!;
    const ownerNames = splitNames(plane ? plane.owner : push!.owner);
    const requesterNames = splitNames(plane ? plane.requester : push!.requester);
    const createdAt = ctx.time(plane ? plane.created_at : push!.created_at);
    const updatedAt = ctx.time(plane?.updated_at ?? push?.last_edited_at, createdAt);

    let stateKey: string;
    if (plane) {
      stateKey = PLANE_STATUS_TO_STATE[plane.status ?? ''] ?? 'collect';
      if (!PLANE_STATUS_TO_STATE[plane.status ?? '']) ctx.problem(`123plane 状态「${plane.status}」没有对应的流程状态`);
    } else {
      stateKey = push!.status === '已搁置' ? 'shelved' : 'to_evaluate';
    }

    const pushIteration = push?.version_id?.trim() ? resolver.iteration('push', push.version_id) : null;
    const planeIteration = !pushIteration && plane?.iteration_id?.trim() ? resolver.iteration('plane', plane.iteration_id) : null;
    const iterationEntry = pushIteration ?? planeIteration;
    const iterationId = iterationEntry ? ctx.iterationIdByKey.get(iterationEntry.key) ?? null : null;
    iterationOf.set(id, iterationId);

    const nodeName = plane ? resolver.domain(plane.business_domain) : null;
    if (plane && pushForPlane.get(plane.id) && matchedBy.get(push!.id) === 'title') {
      report.matching.titleMatches.push({ displayKey: displayKey(number), planeTitle: plane.title, pushTitle: push!.title });
    }
    if (plane && push) {
      const cmp: Array<[string, string, string]> = [
        ['title', plane.title.trim(), push.title.trim()],
        ['priority', plane.priority ?? '', push.priority ?? ''],
        ['owner', splitNames(plane.owner)[0] ?? '', splitNames(push.owner)[0] ?? ''],
        ['requester', splitNames(plane.requester)[0] ?? '', splitNames(push.requester)[0] ?? ''],
      ];
      for (const [field, a, b] of cmp) if (a && b && a !== b) report.conflicts.push({ displayKey: displayKey(number), field, plane: a, push: b });
    }

    rows.requirements.push({
      id,
      orgId,
      productId,
      number,
      legacyKey: plane ? plane.id : `push-${push!.id}`,
      title: (plane ? plane.title : push!.title).trim(),
      description: plane ? (plane.description ?? '') : (push!.brief ?? ''),
      stateKey,
      stateChangedAt: createdAt,
      ownerMemberId: ctx.memberId(ownerNames[0]),
      requesterMemberId: ctx.memberId(requesterNames[0]),
      nodeId: nodeName ? ctx.nodeIdByName.get(nodeName) ?? null : null,
      iterationId,
      legacyMeta: {
        ...(plane && {
          plane: {
            id: plane.id,
            phase: plane.phase,
            acceptanceStatus: plane.acceptance_status,
            iterationStatus: plane.iteration_status,
            estimatedEffort: plane.estimated_effort,
            sourceNote: plane.source,
            notes: plane.notes,
            coOwners: splitNames(plane.owner).slice(1),
          },
        }),
        ...(push && {
          push: { id: push.id, alias: push.alias, developers: parseJsonArray(push.developers), lastEditedBy: push.last_edited_by, coOwners: splitNames(push.owner).slice(1) },
        }),
      },
      createdBy: null,
      createdAt,
      updatedAt,
    });
    rows.entityAliases.push(...[plane?.id, push ? `push-${push.id}` : null].filter((a): a is string => !!a).map((alias) => ({ id: ctx.id('alias', alias), orgId, entityType: 'requirement' as const, entityId: id, alias })));

    // 字段值
    const addValue = (fieldKey: string, optionKey: string | undefined) => {
      if (!optionKey) return;
      const optionId = ctx.optionId(fieldKey, optionKey);
      if (!optionId) return ctx.problem(`字段「${fieldKey}」缺少选项「${optionKey}」`);
      if (rows.fieldValues.some((v) => v.entityId === id && v.optionId === optionId)) return;
      rows.fieldValues.push({ id: ctx.id('field-value', `${id}:${optionId}`), orgId, entityType: 'requirement', entityId: id, fieldId: ctx.fieldId.get(fieldKey)!, optionId });
    };
    const priority = (plane?.priority ?? push?.priority ?? '').trim();
    if (priority) {
      if (!PRIORITY_KEYS[priority]) ctx.problem(`优先级「${priority}」没有对应选项`);
      addValue('priority', PRIORITY_KEYS[priority]);
    }
    const platformRaws = plane && splitPlatforms(plane.platform).length ? splitPlatforms(plane.platform) : parseJsonArray(push?.platforms);
    for (const raw of platformRaws) for (const k of resolver.platforms(raw)) addValue('platform', k);
    if (push?.line) addValue('line', LINE_OPTIONS.find((o) => o.label === push.line?.trim())?.key ?? (ctx.problem(`业务线「${push.line}」没有对应选项`), undefined));
    if (push?.source) addValue('source', SOURCE_OPTIONS.find((o) => o.label === push.source?.trim())?.key ?? (ctx.problem(`来源「${push.source}」没有对应选项`), undefined));

    // 检查项
    const results = new Map<string, CheckRow>();
    const review = push ? data.push.prdReviews.find((r) => r.requirement_id === push.id) : undefined;
    const statusCheck = push ? PUSH_STATUS_TO_CHECK[push.status ?? ''] : undefined;
    if (push && statusCheck === undefined) ctx.problem(`push 状态「${push.status}」没有对应规则`);
    const fromReview = (state: string | null, by: string | null, at: string | null, note: string | null): CheckRow | null => {
      if (!state) return null;
      const s = PUSH_REVIEW_TO_CHECK[state];
      if (!s) {
        ctx.problem(`push 评审状态「${state}」没有对应的检查状态`);
        return null;
      }
      return { state: s, note, updatedBy: ctx.memberId(by), updatedAt: ctx.time(at, createdAt) };
    };
    (['background', 'feasibility', 'industry'] as const).forEach((key, i) => {
      const e = (['e1', 'e2', 'e3'] as const)[i]!;
      const r = review ? fromReview(review[`${e}_state`], review[`${e}_by`], review[`${e}_at`], review[`${e}_note`]) : null;
      if (r) results.set(key, r);
      else if (statusCheck) results.set(key, { state: statusCheck });
    });
    if (plane && !results.has('feasibility')) {
      const s = FEASIBILITY_TO_CHECK[plane.feasibility_status ?? 'not-assessed'];
      if (!s) ctx.problem(`123plane 可行性状态「${plane.feasibility_status}」没有对应的检查状态`);
      else results.set('feasibility', { state: s });
    }
    if (plane) {
      const s = PRD_STATUS_TO_CHECK[plane.prd_status ?? 'not-started'];
      if (!s) ctx.problem(`123plane PRD 状态「${plane.prd_status}」没有对应的检查状态`);
      else results.set('prd', { state: s });
    }
    const autoReviews = push ? data.push.autoReviews.filter((a) => a.requirement_id === push.id).sort((a, b) => a.round - b.round) : [];
    if (autoReviews.length) {
      const last = autoReviews.at(-1)!;
      results.set('ai_review', {
        state: last.blocking_count > 0 ? 'rejected' : 'passed',
        meta: {
          rounds: autoReviews.map((a) => ({
            round: a.round,
            issueCount: a.issue_count,
            blockingCount: a.blocking_count,
            reviewedBy: a.reviewed_by,
            reviewedAt: a.reviewed_at,
            issues: (() => {
              try {
                return JSON.parse(a.issues ?? '[]') as unknown;
              } catch {
                return a.issues;
              }
            })(),
          })),
        },
        updatedBy: ctx.memberId(last.reviewed_by),
        updatedAt: ctx.time(last.reviewed_at, createdAt),
      });
    }
    const designItem = ctx.workflow.checkItems.find((c) => c.key === 'design_signoff')!;
    const signoffRows = push ? data.push.designSignoffs.filter((s) => s.requirement_id === push.id) : [];
    const designResultId = ctx.id('check', `${id}:design_signoff`);
    const signoffs: Array<{ signerRuleIndex: number; decision: 'passed' | 'rejected'; at: Date }> = [];
    let mismatched = 0;
    for (const s of signoffRows) {
      const decision = SIGNOFF_DECISION[s.state ?? '未审'];
      if (decision === undefined) ctx.problem(`push 会签状态「${s.state}」没有对应规则`);
      if (!decision || !s.by) continue;
      const ruleIndex = (SIGNOFF_ROLES as readonly string[]).indexOf(s.role);
      if (ruleIndex < 0) {
        ctx.problem(`push 会签角色「${s.role}」没有对应的签字规则`);
        continue;
      }
      const proxy = parseProxySigner(s.by);
      const signer = proxy ? resolver.signoffRole(proxy.onBehalfOf) : resolver.person(s.by);
      const signerId = signer ? ctx.memberIdByKey.get(signer.key)! : null;
      if (!signerId) continue;
      const at = ctx.time(s.at, createdAt);
      const rule = designItem.signers![ruleIndex]!;
      if (rule.by === 'member' && rule.ref !== signerId) mismatched += 1;
      rows.checkItemSignoffs.push({
        id: ctx.id('signoff', `push:${s.id}`),
        orgId,
        resultId: designResultId,
        signerMemberId: signerId,
        actedByMemberId: proxy ? ctx.memberId(proxy.actor) : null,
        signerRuleIndex: ruleIndex,
        decision,
        note: s.opinion?.trim() || null,
        at,
      });
      signoffs.push({ signerRuleIndex: ruleIndex, decision, at });
    }
    if (mismatched) report.skipped.push({ what: '签字人与"指定成员"规则不一致的会签（已按原样导入）', count: mismatched, reason: '旧系统允许其他人在该栏签字' });
    if (signoffs.length) results.set('design_signoff', { state: signoffResultState(designItem, signoffs) });

    for (const [itemKey, r] of results) {
      if (r.state === 'not_started' && !r.note && !r.meta) continue;
      rows.checkItemResults.push({
        id: itemKey === 'design_signoff' ? designResultId : ctx.id('check', `${id}:${itemKey}`),
        orgId,
        targetType: 'requirement',
        targetId: id,
        itemKey,
        state: r.state,
        note: r.note ?? null,
        meta: r.meta ?? {},
        updatedBy: r.updatedBy ?? null,
        updatedAt: r.updatedAt ?? updatedAt,
      });
    }

    // 开发分配
    if (plane) {
      for (const d of data.plane.requirementDevelopers.filter((x) => x.requirement_id === plane.id)) {
        const memberId = ctx.memberId(d.developer);
        if (!memberId) continue;
        const platformKey = d.platform ? resolver.platforms(d.platform)[0] : undefined;
        const platformOptionId = platformKey ? ctx.optionId('platform', platformKey) : null;
        if (rows.requirementAssignments.some((a) => a.requirementId === id && a.memberId === memberId && a.platformOptionId === platformOptionId)) continue;
        rows.requirementAssignments.push({ id: ctx.id('assignment', `plane:${d.id}`), orgId, requirementId: id, memberId, functionTagId: ctx.tagIdByName.get('开发') ?? null, platformOptionId });
      }
    }

    // 流转历史
    const logs = plane ? data.plane.activityLog.filter((a) => a.requirement_id === plane.id && a.action === 'status_change') : [];
    const mapState = (label: string | null) => {
      const k = PLANE_STATUS_TO_STATE[label ?? ''];
      if (!k) ctx.problem(`123plane 状态「${label}」没有对应的流程状态`);
      return k ?? 'collect';
    };
    const firstFrom = logs.length ? mapState(logs[0]!.old_value) : stateKey;
    rows.stateTransitions.push({ id: ctx.id('transition', `${id}:created`), orgId, requirementId: id, fromState: null, toState: firstFrom, actorMemberId: null, forced: false, reason: null, at: createdAt });
    for (const a of logs) {
      rows.stateTransitions.push({
        id: ctx.id('transition', `plane:${a.id}`),
        orgId,
        requirementId: id,
        fromState: mapState(a.old_value),
        toState: mapState(a.new_value),
        actorMemberId: ctx.memberId(a.user_email),
        forced: false,
        reason: null,
        at: ctx.time(a.created_at, createdAt),
      });
    }
    const last = rows.requirements.at(-1)!;
    last.stateChangedAt = logs.length ? ctx.time(logs.at(-1)!.created_at, createdAt) : createdAt;
  });
  rows.products[0]!.requirementSeq = pairs.length;

  // 3. 评论、进展、迭代日志、已读
  let orphanComments = 0;
  for (const c of data.plane.comments) {
    const target = reqIdOfPlane.get(c.requirement_id);
    if (!target) {
      orphanComments += 1;
      continue;
    }
    rows.comments.push({
      id: ctx.id('comment', `plane:${c.id}`),
      orgId,
      targetType: 'requirement',
      targetId: target,
      authorMemberId: ctx.memberId(c.user_email) ?? ctx.memberId(c.user_name),
      body: c.content,
      kind: 'comment',
      createdAt: ctx.time(c.created_at),
    });
  }
  for (const u of data.plane.requirementUpdates) {
    const target = reqIdOfPlane.get(u.requirement_id);
    if (!target) {
      orphanComments += 1;
      continue;
    }
    rows.comments.push({ id: ctx.id('comment', `update:${u.id}`), orgId, targetType: 'requirement', targetId: target, authorMemberId: ctx.memberId(u.created_by), body: u.content, kind: 'update', createdAt: ctx.time(u.created_at) });
  }
  for (const l of data.plane.iterationLogs) {
    const reqTarget = l.requirement_id ? reqIdOfPlane.get(l.requirement_id) : undefined;
    const it = resolver.iteration('plane', l.iteration_id);
    const iterTarget = it ? ctx.iterationIdByKey.get(it.key) : undefined;
    const targetId = reqTarget ?? iterTarget;
    if (!targetId) {
      orphanComments += 1;
      continue;
    }
    rows.comments.push({
      id: ctx.id('comment', `iteration-log:${l.id}`),
      orgId,
      targetType: reqTarget ? 'requirement' : 'iteration',
      targetId,
      authorMemberId: ctx.memberId(l.created_by),
      body: `【${ITERATION_LOG_LABEL[l.type ?? ''] ?? l.type ?? '记录'}】${l.content}`,
      kind: 'update',
      createdAt: ctx.time(l.created_at),
    });
  }
  if (orphanComments) report.skipped.push({ what: '已删除需求上的评论', count: orphanComments, reason: '需求已在 123plane 中物理删除' });
  for (const r of data.plane.commentReads) {
    const target = reqIdOfPlane.get(r.requirement_id);
    const memberId = ctx.memberId(r.user_email);
    const readAt = ctx.time(r.last_read_at);
    if (!target || !memberId) continue;
    for (const c of rows.comments.filter((x) => x.targetId === target && x.createdAt!.getTime() <= readAt.getTime())) {
      if (rows.commentReads.some((x) => x.commentId === c.id && x.memberId === memberId)) continue;
      rows.commentReads.push({ orgId, commentId: c.id!, memberId, readAt });
    }
  }

  // 4. 阻塞项
  for (const b of data.plane.blockers) {
    const target = reqIdOfPlane.get(b.requirement_id);
    if (!target) continue;
    const status = BLOCKER_STATUS[b.status ?? 'active'];
    if (!status) ctx.problem(`阻塞项状态「${b.status}」没有对应规则`);
    rows.blockers.push({ id: ctx.id('blocker', b.id), orgId, requirementId: target, description: b.description, status: status ?? 'active', ownerMemberId: null, createdAt: ctx.time(b.created_at), resolvedAt: b.resolved_at ? ctx.time(b.resolved_at) : null });
  }

  // 5. 任务
  for (const s of data.plane.subtasks) {
    const target = reqIdOfPlane.get(s.requirement_id);
    if (!target) continue;
    const status = SUBTASK_STATUS[s.status ?? 'todo'];
    if (!status) ctx.problem(`子任务状态「${s.status}」没有对应规则`);
    const createdAt = ctx.time(s.created_at);
    rows.tasks.push({ id: ctx.id('task', `plane:${s.id}`), orgId, productId, requirementId: target, iterationId: iterationOf.get(target) ?? null, title: s.title, assigneeMemberId: ctx.memberId(s.assignee), status: status ?? 'todo', meta: {}, legacyKey: `plane:${s.id}`, createdAt, updatedAt: ctx.time(s.updated_at, createdAt) });
  }
  for (const g of data.push.ganttTasks) {
    const it = g.version_id?.trim() ? resolver.iteration('push', g.version_id) : null;
    const start = parseLegacyDate(g.plan_start);
    const end = start ? addDays(start, (g.plan_days ?? 0) + (g.delay_days ?? 0)) : null;
    const status = !start ? 'todo' : end! <= ctx.opts.asOf ? 'done' : start <= ctx.opts.asOf ? 'doing' : 'todo';
    const createdAt = ctx.time(g.created_at);
    rows.tasks.push({
      id: ctx.id('task', `push:${g.id}`),
      orgId,
      productId,
      requirementId: g.requirement_id === null ? null : (reqIdOfPush.get(g.requirement_id) ?? null),
      iterationId: it ? ctx.iterationIdByKey.get(it.key) ?? null : null,
      title: g.title,
      alias: g.alias,
      assigneeMemberId: ctx.memberId(g.ov_assignee || g.assignee),
      status,
      planStart: start,
      planDays: g.plan_days,
      delayDays: g.delay_days,
      phase: g.phase,
      flag: g.flag,
      starred: g.starred === null ? null : g.starred === 1,
      meta: { note: g.note, actualStatus: g.actual_status, manual: g.manual, ovAssignee: g.ov_assignee, ovStatus: g.ov_status, ovProgress: g.ov_progress },
      legacyKey: `push:${g.id}`,
      createdAt,
      updatedAt: createdAt,
    });
  }

  // 6. 发布版本关联
  for (const rv of data.plane.requirementVersions) {
    const requirementId = reqIdOfPlane.get(rv.requirement_id);
    const releaseId = ctx.releaseIdByPlaneId.get(rv.version_id);
    if (!requirementId || !releaseId) continue;
    if (rows.requirementReleases.some((x) => x.requirementId === requirementId && x.releaseId === releaseId)) continue;
    rows.requirementReleases.push({ orgId, requirementId, releaseId });
  }

  // 7. 审计事件
  for (const a of data.plane.activityLog) {
    const subject = a.requirement_id ? (reqIdOfPlane.get(a.requirement_id) ?? ctx.id('deleted-requirement', `plane:${a.requirement_id}`)) : ctx.id('deleted-requirement', 'plane:unknown');
    let details: unknown = a.details;
    try {
      details = a.details ? JSON.parse(a.details) : null;
    } catch {
      // 保留原始字符串
    }
    rows.domainEvents.push({
      id: ctx.id('event', `plane:${a.id}`),
      orgId,
      productId,
      type: `legacy.123plane.${a.action}`,
      subjectType: 'requirement',
      subjectId: subject,
      actorMemberId: ctx.memberId(a.user_email),
      actorTokenId: null,
      payload: { schemaVersion: 1, source: '123plane', requirementId: a.requirement_id, action: a.action, oldValue: a.old_value, newValue: a.new_value, details },
      occurredAt: ctx.time(a.created_at),
    });
  }
  for (const c of data.push.changeLog) {
    const pushId = Number(c.entity_id);
    const subject = reqIdOfPush.get(pushId) ?? ctx.id('deleted-requirement', `push:${c.entity_id}`);
    rows.domainEvents.push({
      id: ctx.id('event', `push:${c.id}`),
      orgId,
      productId,
      type: 'legacy.push.change',
      subjectType: 'requirement',
      subjectId: subject,
      actorMemberId: ctx.memberId(c.edited_by),
      actorTokenId: null,
      payload: { schemaVersion: 1, source: 'push', entityType: c.entity_type, entityId: c.entity_id, field: c.field, oldValue: c.old_value, newValue: c.new_value },
      occurredAt: ctx.time(c.edited_at),
    });
  }

  // 8. 迭代统计
  for (const e of ctx.mapping.iterations.iterations) {
    const itId = ctx.iterationIdByKey.get(e.key);
    const row = rows.iterations.find((i) => i.id === itId);
    if (!row) continue;
    report.iterations.push({
      name: e.name,
      type: e.type,
      planeIds: e.planeIds,
      pushIds: e.pushIds,
      startDate: row.startDate,
      endDate: row.endDate,
      status: row.status ?? 'planning',
      requirements: rows.requirements.filter((r) => r.iterationId === itId).length,
    });
  }
}
```

- [ ] **Step 3: 在 `plan.ts` 中接入并汇总**

`packages/migrate/src/plan.ts` 整体替换为：

```ts
import type { LegacyData } from './legacy-types';
import type { Mapping } from './mapping';
import { buildBase } from './plan-base';
import { buildRequirements } from './plan-requirements';
import { type ImportOptions, type ImportPlan, INSERT_ORDER, PlanContext } from './plan-types';

export function buildImportPlan(data: LegacyData, mapping: Mapping, opts: ImportOptions): ImportPlan {
  const ctx = new PlanContext(data, mapping, opts);
  buildBase(ctx);
  buildRequirements(ctx);
  const { report, rows, resolver } = ctx;
  const unmapped: Array<[string, Set<string>]> = [
    ['人员对照表缺少', resolver.unmapped.people],
    ['平台对照表缺少', resolver.unmapped.platforms],
    ['业务域对照表缺少', resolver.unmapped.domains],
    ['迭代对照表缺少', resolver.unmapped.iterations],
  ];
  for (const [label, set] of unmapped) for (const v of [...set].sort()) ctx.problem(`${label}：${v}`);

  const { plane, push, prd } = data;
  report.sourceCounts = {
    'plane.users': plane.users.length,
    'plane.requirements': plane.requirements.length,
    'plane.iterations': plane.iterations.length,
    'plane.versions': plane.versions.length,
    'plane.requirementVersions': plane.requirementVersions.length,
    'plane.requirementDevelopers': plane.requirementDevelopers.length,
    'plane.subtasks': plane.subtasks.length,
    'plane.comments': plane.comments.length,
    'plane.commentReads': plane.commentReads.length,
    'plane.activityLog': plane.activityLog.length,
    'plane.blockers': plane.blockers.length,
    'plane.requirementUpdates': plane.requirementUpdates.length,
    'plane.iterationLogs': plane.iterationLogs.length,
    'push.requirements': push.requirements.length,
    'push.versions': push.versions.length,
    'push.ganttTasks': push.ganttTasks.length,
    'push.prdReviews': push.prdReviews.length,
    'push.designSignoffs': push.designSignoffs.length,
    'push.changeLog': push.changeLog.length,
    'push.autoReviews': push.autoReviews.length,
    'prd.domains': prd.domains.length,
    'prd.users': prd.users.length,
  };
  report.targetCounts = Object.fromEntries(INSERT_ORDER.map((k) => [k, rows[k].length]));
  report.deferred.push(
    { what: '123plane 需求简报（HTML）', count: plane.counts.briefs, phase: 'P2 文档附件' },
    { what: 'PRD 页面', count: prd.counts.pages, phase: 'P2 文档' },
    { what: 'PRD 页面修订', count: prd.counts.pageVersions, phase: 'P2 文档' },
    { what: 'PRD 附件', count: prd.counts.attachments, phase: 'P2 文档' },
    { what: 'PRD 评论', count: prd.counts.comments, phase: 'P2 文档' },
    { what: 'push 推送群', count: push.counts.groups, phase: 'P3 通知' },
    { what: 'push 推送计划', count: push.counts.tasks, phase: 'P3 通知' },
    { what: 'push 推送日志', count: push.counts.pushLogs, phase: 'P3 通知' },
  );
  report.skipped.push(
    { what: '123plane 外部 PRD 链接', count: plane.counts.prdLinks, reason: 'spec §7.2：外部 PRD 链接不迁移' },
    { what: 'push 外部 PRD 链接', count: push.counts.prdUrls, reason: 'spec §7.2：外部 PRD 链接不迁移' },
    { what: '123plane 权限配置（role_permissions / user_permission_overrides）', count: plane.counts.rolePermissions + plane.counts.userPermissionOverrides, reason: 'spec §7.2：从未生效，不迁移' },
    { what: '123plane 通知队列与同步收发件箱', count: plane.counts.notificationQueue + plane.counts.syncInbox + plane.counts.syncOutbox, reason: 'spec §7.2：不迁移' },
    { what: 'push 中已标记合并的需求', count: report.matching.pushMergedSkipped, reason: 'push 内已合并进其他需求' },
  );
  report.skipped = report.skipped.filter((s) => s.count > 0);
  report.deferred = report.deferred.filter((d) => d.count > 0);
  return { rows, report };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate test` 与 `pnpm --filter @flower/migrate typecheck`
Expected: 全部通过。若断言与实现不符，以测试描述和上面列出的规则为准修改实现。

- [ ] **Step 5: 提交**

```bash
git add packages/migrate
git commit -m "feat(migrate): 导入计划的需求合并、检查项与会签、评论、任务和审计事件"
```

---
### Task 11: 写入数据库、对账报告、命令行，以及用生产数据副本试跑

**Files:**
- Create: `packages/migrate/src/write.ts`、`packages/migrate/src/report.ts`、`packages/migrate/src/cli.ts`
- Test: `packages/migrate/test/write.test.ts`、`packages/migrate/test/report.test.ts`
- Modify: `CLAUDE.md`（迁移命令与注意事项）

**Interfaces:**
- Consumes: Task 9–10 的 `ImportPlan`、`INSERT_ORDER`；`@flower/core` 的表对象、`createDb`、`accounts`
- Produces：
  - `writeImport(adminDb: Db, plan: ImportPlan, opts: { replace: boolean }): Promise<void>`（单个事务；计划有问题时拒绝；组织已存在且未加 `replace` 时拒绝；`replace` 时先删除该组织的全部数据）
  - `deleteOrgData(tx, orgId: string): Promise<void>`
  - `renderReport(report: ReconReport): string`（中文 markdown）
  - 命令行：`node dist/cli.mjs suggest …` 与 `node dist/cli.mjs import …`（参数见 Step 4）

- [ ] **Step 1: 写失败的测试**

`packages/migrate/test/write.test.ts`：

```ts
import { createRequirement, getRequirementByKey, listProducts, listRequirements, resolveActor } from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { seedInstance } from '@flower/core/testing/factories';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import type { ImportOptions } from '../src/plan-types';
import { writeImport } from '../src/write';
import { makeLegacyData, reviewedMapping } from './fixtures';

let t: Awaited<ReturnType<typeof createTestDb>>;
let opts: ImportOptions;
beforeAll(async () => {
  t = await createTestDb();
  const { account } = await seedInstance(t.db);
  opts = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: { accountId: account.id, email: account.email, name: account.name } };
});
afterAll(() => t.cleanup());

describe('写入数据库', () => {
  it('导入后可以用正常的服务函数读写', async () => {
    await writeImport(t.adminDb, buildImportPlan(makeLegacyData(), reviewedMapping(), opts), { replace: false });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    expect(actor.orgRole).toBe('owner');
    const [product] = await listProducts(t.db, actor);
    const list = await listRequirements(t.db, actor, product!.id, { sort: 'number' });
    expect(list.total).toBe(5);
    expect(list.items[4]).toMatchObject({ displayKey: 'PAN-1', title: '批量下载', stateKey: 'developing', iteration: { name: 'it0316' } });
    const d = await getRequirementByKey(t.db, actor, 'X001');
    expect(d.displayKey).toBe('PAN-1');
    expect(d.checkItems.find((c) => c.key === 'design_signoff')).toMatchObject({ state: 'in_progress', signoffs: expect.arrayContaining([expect.objectContaining({ ruleIndex: 3, signer: { displayName: '王老板' } })]) });
    expect(d.transitions.find((x) => x.to === 'to_design')).toMatchObject({ allowed: true });
    const created = await createRequirement(t.db, actor, product!.id, { title: '迁移后新建的需求' });
    expect(created.number).toBe(6);
  });

  it('组织已存在时必须加 replace；覆盖后回到导入时的数据', async () => {
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), opts);
    await expect(writeImport(t.adminDb, plan, { replace: false })).rejects.toThrow('已存在');
    await writeImport(t.adminDb, plan, { replace: true });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    const [product] = await listProducts(t.db, actor);
    expect((await listRequirements(t.db, actor, product!.id)).total).toBe(5);
  });

  it('计划中有问题时拒绝写入', async () => {
    const data = makeLegacyData();
    data.plane.requirements[0]!.requester = '新面孔';
    await expect(writeImport(t.adminDb, buildImportPlan(data, reviewedMapping(), { ...opts, orgSlug: 'other' }), { replace: false })).rejects.toThrow('拒绝写入');
  });
});
```

`packages/migrate/test/report.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import { renderReport } from '../src/report';
import { makeLegacyData, reviewedMapping } from './fixtures';

describe('对账报告', () => {
  it('包含数量对照、匹配结果、冲突、迭代、跳过与延后项', () => {
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null });
    const md = renderReport(plan.report);
    for (const heading of ['# 迁移对账报告', '## 结论', '## 来源数量', '## 写入数量', '## 需求匹配', '## 字段冲突', '## 迭代', '## 人员', '## 跳过的数据', '## 延后迁移']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('| 按 plane_id 匹配 | 1 |');
    expect(md).toContain('| PAN-1 | priority | P1 | P0 |');
    expect(md).toContain('可以写入');
  });
});
```

Run: `pnpm --filter @flower/migrate exec vitest run test/write.test.ts test/report.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现 `write.ts`**

```ts
import * as core from '@flower/core';
import type { Db, Tx } from '@flower/core';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { type ImportPlan, type ImportRows, INSERT_ORDER } from './plan-types';

const TABLES: Record<keyof ImportRows, PgTable> = {
  organizations: core.organizations,
  members: core.members,
  functionTags: core.functionTags,
  memberFunctionTags: core.memberFunctionTags,
  workflowDefinitions: core.workflowDefinitions,
  workflowVersions: core.workflowVersions,
  products: core.products,
  productMembers: core.productMembers,
  fieldDefinitions: core.fieldDefinitions,
  fieldOptions: core.fieldOptions,
  structureNodes: core.structureNodes,
  iterations: core.iterations,
  releases: core.releases,
  requirements: core.requirements,
  fieldValues: core.fieldValues,
  requirementAssignments: core.requirementAssignments,
  requirementRelations: core.requirementRelations,
  stateTransitions: core.stateTransitions,
  blockers: core.blockers,
  checkItemResults: core.checkItemResults,
  checkItemSignoffs: core.checkItemSignoffs,
  requirementReleases: core.requirementReleases,
  tasks: core.tasks,
  comments: core.comments,
  commentReads: core.commentReads,
  entityAliases: core.entityAliases,
  domainEvents: core.domainEvents,
};
const CHUNK = 500;

/** 删除一个组织的全部租户数据（以 flower_admin 执行，不受 RLS 与 domain_events 只追加的限制）。 */
export async function deleteOrgData(tx: Tx, orgId: string): Promise<void> {
  await tx.update(core.products).set({ workflowVersionId: null }).where(eq(core.products.orgId, orgId));
  await tx.update(core.workflowDefinitions).set({ currentVersionId: null, forkedFromVersionId: null }).where(eq(core.workflowDefinitions.orgId, orgId));
  const tenantTables = [...INSERT_ORDER].reverse().filter((k) => k !== 'organizations').map((k) => TABLES[k]);
  for (const table of [...tenantTables.slice(0, -1), core.invitations, core.apiTokens, tenantTables.at(-1)!]) {
    await tx.execute(sql`delete from ${table} where org_id = ${orgId}`);
  }
  await tx.delete(core.organizations).where(eq(core.organizations.id, orgId));
}

export async function writeImport(adminDb: Db, plan: ImportPlan, opts: { replace: boolean }): Promise<void> {
  if (plan.report.problems.length > 0) throw new Error(`导入计划有 ${plan.report.problems.length} 个问题，拒绝写入。请先处理对账报告中的问题。`);
  const org = plan.rows.organizations[0]!;
  await adminDb.transaction(async (tx) => {
    const [existing] = await tx.select({ id: core.organizations.id }).from(core.organizations).where(eq(core.organizations.slug, org.slug));
    if (existing) {
      if (!opts.replace) throw new Error(`组织「${org.slug}」已存在；确认要用本次导入覆盖时加 --replace`);
      await deleteOrgData(tx, existing.id);
    }
    for (const key of INSERT_ORDER) {
      const rows = (key === 'workflowDefinitions' ? plan.rows.workflowDefinitions.map((d) => ({ ...d, currentVersionId: null })) : plan.rows[key]) as unknown[];
      for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(TABLES[key]).values(rows.slice(i, i + CHUNK) as never);
      if (key === 'workflowVersions') {
        for (const d of plan.rows.workflowDefinitions) {
          await tx.update(core.workflowDefinitions).set({ currentVersionId: d.currentVersionId }).where(eq(core.workflowDefinitions.id, d.id!));
        }
      }
    }
  });
}
```

`deleteOrgData` 的删除顺序：按 `INSERT_ORDER` 的逆序删除计划涉及的租户表（`domainEvents` 最先、`members` 最后），`invitations` 与 `apiTokens` 在 `members` 之前删除。

- [ ] **Step 3: 实现 `report.ts`**

```ts
import type { ReconReport } from './plan-types';

const table = (head: string[], rows: Array<Array<string | number>>): string =>
  rows.length === 0
    ? '（无）\n'
    : [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n') + '\n';

export function renderReport(r: ReconReport): string {
  const m = r.matching;
  return [
    `# 迁移对账报告：${r.orgSlug}（截至 ${r.asOf}）`,
    '',
    '## 结论',
    '',
    r.problems.length === 0 ? '没有阻止写入的问题，可以写入。' : `有 ${r.problems.length} 个问题，处理前不会写入：\n\n${r.problems.map((p) => `- ${p}`).join('\n')}`,
    '',
    '## 来源数量',
    '',
    table(['来源表', '行数'], Object.entries(r.sourceCounts)),
    '## 写入数量',
    '',
    table(['目标表', '行数'], Object.entries(r.targetCounts)),
    '## 需求匹配',
    '',
    table(
      ['项', '数量'],
      [
        ['123plane 需求', m.planeTotal],
        ['push 需求', m.pushTotal],
        ['push 中已标记合并（跳过）', m.pushMergedSkipped],
        ['按 plane_id 匹配', m.byPlaneId],
        ['按标题匹配', m.byTitle],
        ['push 独有（作为新需求导入）', m.pushOnly],
      ],
    ),
    '### 按标题匹配的需求（请抽查）',
    '',
    table(['编号', '123plane 标题', 'push 标题'], m.titleMatches.map((x) => [x.displayKey, x.planeTitle, x.pushTitle])),
    '## 字段冲突（已按 123plane 为准）',
    '',
    table(['编号', '字段', '123plane', 'push'], r.conflicts.map((c) => [c.displayKey, c.field, c.plane, c.push])),
    '## 迭代',
    '',
    table(['名称', '类型', '123plane', 'push', '开始', '结束', '状态', '需求数'], r.iterations.map((i) => [i.name, i.type === 'regular' ? '常规' : '专项', i.planeIds.join('、'), i.pushIds.join('、'), i.startDate, i.endDate, i.status, i.requirements])),
    '## 人员',
    '',
    table(['key', '名称', '邮箱', '组织角色', '关联账号', '出现次数'], r.people.map((p) => [p.key, p.displayName, p.email ?? '', p.orgRole, p.hasAccount ? '是' : '', p.mentions])),
    '## 跳过的数据',
    '',
    table(['内容', '数量', '原因'], r.skipped.map((s) => [s.what, s.count, s.reason])),
    '## 延后迁移',
    '',
    table(['内容', '数量', '阶段'], r.deferred.map((d) => [d.what, d.count, d.phase])),
  ].join('\n');
}
```

- [ ] **Step 4: 实现 `cli.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { accounts, createDb } from '@flower/core';
import { eq } from 'drizzle-orm';
import type { LegacyData } from './legacy-types';
import { loadPlane, loadPrd, loadPush } from './load';
import { readMapping, writeMapping } from './mapping';
import { buildImportPlan } from './plan';
import { renderReport } from './report';
import { suggestMapping } from './suggest';
import { writeImport } from './write';

const USAGE = `用法：
  suggest --plane <123plane.db> --push <push.db> --prd-url <postgres url> --mapping <目录>
  import  --plane … --push … --prd-url … --mapping <目录> --out <报告目录> [--org-slug pan123] [--org-name 123云盘]
          [--product-key PAN] [--product-name 123云盘] [--as-of YYYY-MM-DD] [--owner-email 邮箱] [--replace] [--dry-run]
import 写库时读取环境变量 DATABASE_ADMIN_URL。`;

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const { values: v } = parseArgs({
    args,
    options: {
      plane: { type: 'string' },
      push: { type: 'string' },
      'prd-url': { type: 'string' },
      mapping: { type: 'string' },
      out: { type: 'string' },
      'org-slug': { type: 'string', default: 'pan123' },
      'org-name': { type: 'string', default: '123云盘' },
      'product-key': { type: 'string', default: 'PAN' },
      'product-name': { type: 'string', default: '123云盘' },
      'as-of': { type: 'string', default: new Date().toISOString().slice(0, 10) },
      'owner-email': { type: 'string' },
      replace: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const need = (k: 'plane' | 'push' | 'prd-url' | 'mapping' | 'out') => v[k] ?? fail(`缺少参数 --${k}`);
  const data: LegacyData = { plane: loadPlane(need('plane')), push: loadPush(need('push')), prd: await loadPrd(need('prd-url')) };
  const mappingDir = need('mapping');

  if (cmd === 'suggest') {
    const m = suggestMapping(data, readMapping(mappingDir));
    writeMapping(mappingDir, m);
    console.log(
      `已写入对照表 ${mappingDir}：人员 ${m.people.people.length}、平台选项 ${m.platforms.options.length}、业务域 ${m.domains.nodes.length}、迭代 ${m.iterations.iterations.length}。请审阅后运行 import。`,
    );
    return;
  }
  if (cmd !== 'import') fail(`未知命令：${cmd ?? '（空）'}`);

  const mapping = readMapping(mappingDir) ?? fail(`对照表目录 ${mappingDir} 不完整，先运行 suggest`);
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  let owner: { accountId: string; email: string; name: string } | null = null;
  if (v['owner-email']) {
    if (!adminUrl) fail('指定 --owner-email 时需要 DATABASE_ADMIN_URL 来查找账号');
    const { db, close } = createDb(adminUrl, { max: 1 });
    try {
      const [a] = await db.select().from(accounts).where(eq(accounts.email, v['owner-email'].trim().toLowerCase()));
      if (!a) fail(`找不到账号 ${v['owner-email']}`);
      owner = { accountId: a.id, email: a.email, name: a.name };
    } finally {
      await close();
    }
  }
  const plan = buildImportPlan(data, mapping, {
    orgSlug: v['org-slug']!,
    orgName: v['org-name']!,
    productKey: v['product-key']!,
    productName: v['product-name']!,
    asOf: v['as-of']!,
    owner,
  });
  const out = need('out');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'migration-report.md'), renderReport(plan.report));
  writeFileSync(path.join(out, 'migration-report.json'), `${JSON.stringify(plan.report, null, 2)}\n`);
  console.log(`对账报告：${path.join(out, 'migration-report.md')}`);
  if (plan.report.problems.length > 0) {
    console.error(`有 ${plan.report.problems.length} 个问题，未写入数据库。`);
    process.exitCode = 1;
    return;
  }
  if (v['dry-run']) {
    console.log('试跑完成，未写入数据库。');
    return;
  }
  if (!adminUrl) fail('写入数据库需要 DATABASE_ADMIN_URL');
  const { db, close } = createDb(adminUrl, { max: 2 });
  try {
    await writeImport(db, plan, { replace: v.replace! });
  } finally {
    await close();
  }
  console.log(`已写入组织 ${plan.rows.organizations[0]!.slug}：需求 ${plan.rows.requirements.length} 条。`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate test` 与 `pnpm --filter @flower/migrate typecheck`
Expected: 全部通过。

- [ ] **Step 6: 用生产数据副本生成对照表并试跑（不写库）**

前提：`.local-data/123plane.db`、`.local-data/push.db` 存在，PRD 副本已恢复为本地库 `prd_src`（`docker exec flower-postgres-1 psql -U flower_admin -d prd_src -c 'select 1'` 能执行）。

```bash
pnpm --filter @flower/migrate legacy suggest --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping"
```

按用户已确认的决定修改对照表（spec §7.3）：
- `.local-data/mapping/people.json`：`signoffRoles["饶总"]` 改为显示名为"饶阳明"的那个人的 `key`，并删除自动生成的"饶总"占位人。
- `.local-data/mapping/iterations.json`：确认"迭代0624"条目的 `planeIds` 含 `V2026.06.2`；"专业空间版本发布"和"专业空间优化"两条的 `type` 都是 `special`。

然后试跑：

```bash
pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --as-of 2026-09-29 --dry-run
```

Expected：命令结束，生成 `.local-data/reports/migration-report.md`。在任务报告里写明：需求匹配数量、写入数量、`problems` 条数与内容摘要、跳过与延后项。**不要**自行决定业务域同义词合并、平台新选项、人员合并等需要用户确认的事项，也不要把报告或对照表加入 git。

- [ ] **Step 7: 更新 `CLAUDE.md`**

在"命令"表格末尾追加两行：

```
| 生成旧数据对照表（只读副本放在 .local-data/） | `pnpm --filter @flower/migrate legacy suggest --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping"` |
| 迁移旧数据（先加 --dry-run 看对账报告） | `pnpm --filter @flower/migrate legacy import …同上参数… --out "$PWD/.local-data/reports" --owner-email <你的账号邮箱> [--replace] [--dry-run]` |
```

并在"约定"末尾追加：

```
- `.local-data/` 存放生产数据副本、对照表和对账报告，含员工个人信息，只在本地，不提交。迁移写入需要 `DATABASE_ADMIN_URL`；同一组织再次导入必须加 `--replace`，会先删除该组织的全部数据。
```

- [ ] **Step 8: 提交**

```bash
git add packages/migrate CLAUDE.md
git commit -m "feat(migrate): 写入数据库、对账报告与命令行"
```

---
### Task 12: 需求列表页：状态分栏、筛选、搜索、分页、快速新建

**Files:**
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`（新增需求查询；`useMembers` 增加 `enabled` 参数）、`apps/web/src/lib/labels.ts`
- Modify: `apps/web/src/features/shell/nav.ts`、`apps/web/src/features/shell/nav.test.ts`（启用"需求"）
- Modify: `apps/web/src/app/(app)/[org]/page.tsx`（概览中的产品卡片链接到该产品的需求列表）
- Create: `apps/web/src/features/requirements/filter.ts`、`filter.test.ts`
- Create: `apps/web/src/components/option-multi-select.tsx`
- Create: `apps/web/src/app/(app)/[org]/requirements/page.tsx`、`create-dialog.tsx`
- Test: `apps/web/e2e/requirements.spec.ts`（本任务写列表部分，Task 13 追加详情部分）

**Interfaces:**
- Consumes: Task 6 的接口；P0-B 的 `PageHeader`、`EmptyState`、`FormError`、`useApiMutation`、`useProducts`、`useProductWorkflow`、`useFields`、`useMembers`、`useOrg`
- Produces：
  - 类型：`RequirementListItem`、`RequirementList`、`RequirementDetail`、`RequirementComment`、`StructureNode`、`IterationBrief`、`CheckState`（均为 core 对应类型的 `Jsonify`）
  - 查询：`qk.requirements(o, productId, query)`、`qk.requirement(o, key)`、`qk.requirementComments(o, id)`、`qk.nodes(o, productId)`、`qk.iterations(o, productId)`；`useRequirements(o, productId, query)`、`useRequirement(o, key)`、`useRequirementComments(o, id)`、`useNodes(o, productId)`、`useProductIterations(o, productId)`；`requirementKeys(o)`（需求相关查询的公共前缀 `['org', o, 'requirements']`，修改后统一失效）
  - `type ListFilter = { product: string | null; states: string[]; node: string | null; priority: string[]; platform: string[]; owner: string | null; iteration: string | null; q: string; sort: 'updated' | 'number' | 'created'; page: number }`
  - `EMPTY_FILTER: ListFilter`、`parseFilter(sp: URLSearchParams): ListFilter`、`filterToSearch(f: ListFilter): string`、`filterToApiQuery(f: ListFilter, pageSize?: number): string`、`patchFilter(f: ListFilter, patch: Partial<ListFilter>): ListFilter`（除非修改的就是 `page`，否则页码回到 1）
  - `<OptionMultiSelect label options value onChange>`：`options: Array<{ id: string; label: string; color?: string | null }>`
  - 页面：`/[org]/requirements?product=PAN&state=…&priority=…&platform=…&node=…&owner=…&iteration=…|none&q=…&sort=…&page=…`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/requirements/filter.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, filterToApiQuery, filterToSearch, parseFilter, patchFilter } from './filter';

describe('需求筛选条件', () => {
  it('从网址读取，缺省值不写回网址，写回的顺序固定', () => {
    const f = parseFilter(new URLSearchParams('product=PAN&state=collect,developing&priority=p1&q=%E4%B8%8B%E8%BD%BD&page=3'));
    expect(f).toEqual({ ...EMPTY_FILTER, product: 'PAN', states: ['collect', 'developing'], priority: ['p1'], q: '下载', page: 3 });
    expect(filterToSearch(f)).toBe('product=PAN&state=collect%2Cdeveloping&priority=p1&q=%E4%B8%8B%E8%BD%BD&page=3');
    expect(filterToSearch(EMPTY_FILTER)).toBe('');
    expect(parseFilter(new URLSearchParams('page=abc&sort=bogus'))).toEqual(EMPTY_FILTER);
  });

  it('转成接口查询参数：未排期用 noIteration，固定每页 50 条', () => {
    const q = filterToApiQuery({ ...EMPTY_FILTER, states: ['collect'], iteration: 'none', owner: 'm1', q: ' PAN-3 ' });
    expect(q).toBe('state=collect&owner=m1&noIteration=1&q=PAN-3&sort=updated&page=1&pageSize=50');
    expect(filterToApiQuery({ ...EMPTY_FILTER, iteration: 'it1', node: 'n1', platform: ['a', 'b'] })).toBe(
      'node=n1&platform=a%2Cb&iteration=it1&sort=updated&page=1&pageSize=50',
    );
  });

  it('改变筛选条件时页码回到第一页', () => {
    const f = { ...EMPTY_FILTER, page: 4 };
    expect(patchFilter(f, { priority: ['p0'] }).page).toBe(1);
    expect(patchFilter(f, { page: 5 }).page).toBe(5);
  });
});
```

在 `apps/web/src/features/shell/nav.test.ts` 中把第一个用例的期望改为：

```ts
    expect(nav.main.map((i) => [i.label, i.phase ?? null, i.href ?? null])).toEqual([
      ['概览', null, '/acme'],
      ['需求', null, '/acme/requirements'],
      ['迭代', 'P1', null],
      ['文档', 'P2', null],
    ]);
```

并在"根据路径判断当前导航项"用例中追加：

```ts
    expect(activeNavKey('/acme/requirements', 'acme')).toBe('requirements');
    expect(activeNavKey('/acme/requirements/PAN-12', 'acme')).toBe('requirements');
```

Run: `pnpm --filter @flower/web exec vitest run src/features/requirements src/features/shell`
Expected: FAIL。

- [ ] **Step 2: 实现筛选模型与导航**

`apps/web/src/features/requirements/filter.ts`：

```ts
export type ListFilter = {
  product: string | null;
  states: string[];
  node: string | null;
  priority: string[];
  platform: string[];
  owner: string | null;
  iteration: string | null;
  q: string;
  sort: 'updated' | 'number' | 'created';
  page: number;
};

export const EMPTY_FILTER: ListFilter = { product: null, states: [], node: null, priority: [], platform: [], owner: null, iteration: null, q: '', sort: 'updated', page: 1 };

const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function parseFilter(sp: URLSearchParams): ListFilter {
  const sort = sp.get('sort');
  const page = Number.parseInt(sp.get('page') ?? '', 10);
  return {
    product: sp.get('product') || null,
    states: list(sp.get('state')),
    node: sp.get('node') || null,
    priority: list(sp.get('priority')),
    platform: list(sp.get('platform')),
    owner: sp.get('owner') || null,
    iteration: sp.get('iteration') || null,
    q: sp.get('q') ?? '',
    sort: sort === 'number' || sort === 'created' ? sort : 'updated',
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

export function filterToSearch(f: ListFilter): string {
  const sp = new URLSearchParams();
  if (f.product) sp.set('product', f.product);
  if (f.states.length) sp.set('state', f.states.join(','));
  if (f.node) sp.set('node', f.node);
  if (f.priority.length) sp.set('priority', f.priority.join(','));
  if (f.platform.length) sp.set('platform', f.platform.join(','));
  if (f.owner) sp.set('owner', f.owner);
  if (f.iteration) sp.set('iteration', f.iteration);
  if (f.q) sp.set('q', f.q);
  if (f.sort !== 'updated') sp.set('sort', f.sort);
  if (f.page > 1) sp.set('page', String(f.page));
  return sp.toString();
}

export function filterToApiQuery(f: ListFilter, pageSize = 50): string {
  const sp = new URLSearchParams();
  if (f.states.length) sp.set('state', f.states.join(','));
  if (f.node) sp.set('node', f.node);
  if (f.priority.length) sp.set('priority', f.priority.join(','));
  if (f.platform.length) sp.set('platform', f.platform.join(','));
  if (f.owner) sp.set('owner', f.owner);
  if (f.iteration === 'none') sp.set('noIteration', '1');
  else if (f.iteration) sp.set('iteration', f.iteration);
  if (f.q.trim()) sp.set('q', f.q.trim());
  sp.set('sort', f.sort);
  sp.set('page', String(f.page));
  sp.set('pageSize', String(pageSize));
  return sp.toString();
}

export function patchFilter(f: ListFilter, patch: Partial<ListFilter>): ListFilter {
  return { ...f, ...patch, page: patch.page ?? 1 };
}
```

`apps/web/src/features/shell/nav.ts`：`main` 中"需求"一项改为 `{ key: 'requirements', label: '需求', href: \`/${org}/requirements\`, icon: 'list' }`（去掉 `phase`）；`activeNavKey` 改为：

```ts
export function activeNavKey(pathname: string, org: string): string {
  const rest = pathname.replace(new RegExp(`^/${org}`), '');
  if (/^\/requirements(\/|$)/.test(rest)) return 'requirements';
  const m = /^\/settings\/([^/]+)/.exec(rest);
  return m ? m[1]! : 'home';
}
```

- [ ] **Step 3: 类型、查询与文案**

`apps/web/src/lib/types.ts`：在 import 列表中加入 `CheckState as CoreCheckState, CommentView, IterationBrief as CoreIterationBrief, RequirementDetail as CoreRequirementDetail, RequirementList as CoreRequirementList, RequirementListItem as CoreRequirementListItem, StructureNodeView`，文件末尾追加：

```ts
export type RequirementListItem = Jsonify<CoreRequirementListItem>;
export type RequirementList = Jsonify<CoreRequirementList>;
export type RequirementDetail = Jsonify<CoreRequirementDetail>;
export type RequirementComment = Jsonify<CommentView>;
export type StructureNode = StructureNodeView;
export type IterationBrief = CoreIterationBrief;
export type CheckState = CoreCheckState;
```

`apps/web/src/lib/queries.ts`：import 中加入 `keepPreviousData`（来自 `@tanstack/react-query`）以及上面的新类型；`qk` 中追加：

```ts
  requirements: (o: string, productId: string, query: string) => ['org', o, 'requirements', 'list', productId, query] as const,
  requirement: (o: string, key: string) => ['org', o, 'requirements', 'detail', key] as const,
  requirementComments: (o: string, id: string) => ['org', o, 'requirements', 'comments', id] as const,
  nodes: (o: string, productId: string) => ['org', o, 'product', productId, 'nodes'] as const,
  iterations: (o: string, productId: string) => ['org', o, 'product', productId, 'iterations'] as const,
```

并在 hooks 区追加：

```ts
/** 需求相关查询的公共前缀：任何需求修改后统一失效。 */
export const requirementKeys = (o: string) => ['org', o, 'requirements'] as const;

export const useRequirements = (o: string, productId: string | undefined, query: string) =>
  useQuery({
    queryKey: qk.requirements(o, productId ?? '', query),
    queryFn: () => api<RequirementList>(`/orgs/${o}/products/${productId}/requirements?${query}`),
    enabled: !!productId,
    placeholderData: keepPreviousData,
  });
export const useRequirement = (o: string, key: string) =>
  useQuery({
    queryKey: qk.requirement(o, key),
    queryFn: () => api<{ requirement: RequirementDetail }>(`/orgs/${o}/requirements/${encodeURIComponent(key)}`),
    select: (d) => d.requirement,
  });
export const useRequirementComments = (o: string, id: string | undefined) =>
  useQuery({
    queryKey: qk.requirementComments(o, id ?? ''),
    queryFn: () => api<{ comments: RequirementComment[] }>(`/orgs/${o}/requirements/${id}/comments`),
    select: (d) => d.comments,
    enabled: !!id,
  });
export const useNodes = (o: string, productId: string | undefined) =>
  useQuery({
    queryKey: qk.nodes(o, productId ?? ''),
    queryFn: () => api<{ nodes: StructureNode[] }>(`/orgs/${o}/products/${productId}/nodes`),
    select: (d) => d.nodes,
    enabled: !!productId,
  });
export const useProductIterations = (o: string, productId: string | undefined) =>
  useQuery({
    queryKey: qk.iterations(o, productId ?? ''),
    queryFn: () => api<{ iterations: IterationBrief[] }>(`/orgs/${o}/products/${productId}/iterations`),
    select: (d) => d.iterations,
    enabled: !!productId,
  });
```

`apps/web/src/lib/labels.ts` 末尾追加：

```ts
export const ITERATION_STATUS_LABEL = { planning: '规划中', active: '进行中', done: '已完成', canceled: '已取消' } as const;
export const TASK_STATUS_LABEL = { todo: '待开始', doing: '进行中', done: '已完成' } as const;
export const RELATION_LABEL: Record<string, string> = { duplicate_of: '重复于', merged_into: '合并到', derived_from: '派生自', blocks: '阻塞', related: '相关' };
export const SORT_LABEL = { updated: '最近更新', number: '编号', created: '创建时间' } as const;
```

- [ ] **Step 4: 多选组件**

`apps/web/src/components/option-multi-select.tsx`：

```tsx
'use client';

import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type MultiOption = { id: string; label: string; color?: string | null };

export function OptionMultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: MultiOption[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn('h-8 gap-1', value.length > 0 && 'border-primary text-primary')}>
          {label}
          {value.length > 0 && <span className="font-mono text-xs">· {value.length}</span>}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <ul aria-label={label} className="max-h-72 overflow-y-auto">
          {options.map((o) => (
            <li key={o.id}>
              <label className="flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-[13px] hover:bg-accent">
                <Checkbox checked={value.includes(o.id)} onCheckedChange={() => toggle(o.id)} aria-label={o.label} />
                {o.color && <span className="size-2 rounded-full" style={{ background: o.color }} aria-hidden="true" />}
                <span className="truncate">{o.label}</span>
              </label>
            </li>
          ))}
        </ul>
        {value.length > 0 && (
          <Button variant="ghost" size="sm" className="mt-1 h-7 w-full" onClick={() => onChange([])}>
            清除
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 5: 列表页与快速新建**

`apps/web/src/app/(app)/[org]/requirements/page.tsx`：

```tsx
'use client';

import { ListTodo, Search } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { OptionMultiSelect } from '@/components/option-multi-select';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { filterToApiQuery, filterToSearch, type ListFilter, parseFilter, patchFilter } from '@/features/requirements/filter';
import { SORT_LABEL } from '@/lib/labels';
import { useFields, useMembers, useNodes, useOrg, useProductIterations, useProducts, useProductWorkflow, useRequirements } from '@/lib/queries';
import type { RequirementListItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CreateRequirementDialog } from './create-dialog';

const ALL = '__all';

function StateBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

function RequirementsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = useMemo(() => parseFilter(new URLSearchParams(searchParams.toString())), [searchParams]);
  const orgQ = useOrg(org);
  const products = useProducts(org);
  const product = products.data?.find((p) => p.key === filter.product) ?? products.data?.[0];
  const workflow = useProductWorkflow(org, product?.id ?? '');
  const fields = useFields(org, product?.id);
  const canListMembers = !!orgQ.data && orgQ.data.me.orgRole !== 'guest';
  const members = useMembers(org, canListMembers);
  const nodes = useNodes(org, product?.id);
  const iterations = useProductIterations(org, product?.id);
  const data = useRequirements(org, product?.id, filterToApiQuery(filter));
  const [q, setQ] = useState(filter.q);
  const [creating, setCreating] = useState(false);

  const setFilter = (patch: Partial<ListFilter>) => {
    const next = patchFilter({ ...filter, product: product?.key ?? filter.product }, patch);
    const qs = filterToSearch(next);
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  };

  useEffect(() => setQ(filter.q), [filter.q]);
  useEffect(() => {
    if (q === filter.q) return;
    const t = setTimeout(() => setFilter({ q }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  if (products.data && products.data.length === 0) {
    return (
      <>
        <PageHeader title="需求" />
        <EmptyState icon={ListTodo} title="还没有产品" description="需求挂在产品下。请组织管理员先在「组织设置 / 产品」中创建产品。" />
      </>
    );
  }

  const states = workflow.data ? [...workflow.data.version.body.states].sort((a, b) => a.order - b.order) : [];
  const stateOf = new Map(states.map((s) => [s.key, s]));
  const counts = data.data?.stateCounts ?? {};
  const allCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const priority = fields.data?.find((f) => f.key === 'priority');
  const platform = fields.data?.find((f) => f.key === 'platform');
  const topNodes = (nodes.data ?? []).filter((n) => n.depth === 1);
  const total = data.data?.total ?? 0;
  const pageSize = data.data?.pageSize ?? 50;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const canCreate = product && product.myRole !== 'viewer';

  return (
    <>
      <PageHeader
        title="需求"
        description={product ? `${product.name} · 共 ${allCount} 条` : undefined}
        actions={
          <>
            {products.data && products.data.length > 1 && (
              <Select value={product?.key} onValueChange={(key) => router.replace(`?${filterToSearch({ ...filter, product: key, page: 1 })}`)}>
                <SelectTrigger className="h-8 w-40" aria-label="产品">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {products.data.map((p) => (
                    <SelectItem key={p.id} value={p.key}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {canCreate && <Button onClick={() => setCreating(true)}>新建需求</Button>}
          </>
        }
      />

      <div role="tablist" aria-label="状态" className="flex flex-wrap gap-1 border-b">
        {[{ key: ALL, label: '全部', color: '' }, ...states].map((s) => {
          const active = s.key === ALL ? filter.states.length === 0 : filter.states.length === 1 && filter.states[0] === s.key;
          const n = s.key === ALL ? allCount : (counts[s.key] ?? 0);
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter({ states: s.key === ALL ? [] : [s.key] })}
              className={cn('-mb-px flex h-9 items-center gap-1.5 border-b-2 px-3 text-[13px]', active ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {s.label}
              <span className="font-mono text-xs">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-2 size-4 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="搜索需求" placeholder="标题、编号或旧编号" className="h-8 w-60 pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {priority && (
          <OptionMultiSelect label="优先级" options={priority.options.map((o) => ({ id: o.id, label: o.label, color: o.color }))} value={filter.priority} onChange={(v) => setFilter({ priority: v })} />
        )}
        {platform && platform.options.length > 0 && (
          <OptionMultiSelect label="平台" options={platform.options.map((o) => ({ id: o.id, label: o.label, color: o.color }))} value={filter.platform} onChange={(v) => setFilter({ platform: v })} />
        )}
        {topNodes.length > 0 && (
          <Select value={filter.node ?? ALL} onValueChange={(v) => setFilter({ node: v === ALL ? null : v })}>
            <SelectTrigger className="h-8 w-36" aria-label="业务域">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部业务域</SelectItem>
              {topNodes.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {canListMembers && members.data && (
          <Select value={filter.owner ?? ALL} onValueChange={(v) => setFilter({ owner: v === ALL ? null : v })}>
            <SelectTrigger className="h-8 w-32" aria-label="负责人">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部负责人</SelectItem>
              {members.data
                .filter((m) => m.status === 'active' && m.kind === 'human')
                .map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        )}
        <Select value={filter.iteration ?? ALL} onValueChange={(v) => setFilter({ iteration: v === ALL ? null : v })}>
          <SelectTrigger className="h-8 w-36" aria-label="迭代">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部迭代</SelectItem>
            <SelectItem value="none">未排期</SelectItem>
            {(iterations.data ?? []).map((i) => (
              <SelectItem key={i.id} value={i.id}>
                {i.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.sort} onValueChange={(v) => setFilter({ sort: v as ListFilter['sort'] })}>
          <SelectTrigger className="ml-auto h-8 w-32" aria-label="排序">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABEL) as Array<keyof typeof SORT_LABEL>).map((k) => (
              <SelectItem key={k} value={k}>
                {SORT_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">编号</TableHead>
              <TableHead>标题</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-20">优先级</TableHead>
              <TableHead className="w-40">平台</TableHead>
              <TableHead className="w-28">业务域</TableHead>
              <TableHead className="w-20">负责人</TableHead>
              <TableHead className="w-20">提出人</TableHead>
              <TableHead className="w-28">迭代</TableHead>
              <TableHead className="w-24">更新</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data.data?.items ?? []).map((r: RequirementListItem) => {
              const s = stateOf.get(r.stateKey);
              return (
                <TableRow key={r.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono text-xs">
                    {r.displayKey}
                    {r.legacyKey && <div className="text-[11px] text-muted-foreground">{r.legacyKey}</div>}
                  </TableCell>
                  <TableCell className="max-w-0">
                    <Link href={`/${org}/requirements/${r.displayKey}`} className="block truncate hover:underline">
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell>{s ? <StateBadge label={s.label} color={s.color} /> : r.stateKey}</TableCell>
                  <TableCell>
                    {r.priority && (
                      <Badge variant="outline" style={{ borderColor: r.priority.color ?? undefined, color: r.priority.color ?? undefined }}>
                        {r.priority.label}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="truncate text-[13px] text-muted-foreground">{r.platforms.map((p) => p.label).join('、')}</TableCell>
                  <TableCell className="truncate text-[13px]">{r.node?.name}</TableCell>
                  <TableCell className="truncate text-[13px]">{r.owner?.displayName}</TableCell>
                  <TableCell className="truncate text-[13px] text-muted-foreground">{r.requester?.displayName}</TableCell>
                  <TableCell className="truncate text-[13px]">{r.iteration?.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{new Date(r.updatedAt).toLocaleDateString('zh-CN')}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {data.data && data.data.items.length === 0 && <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">没有符合条件的需求</p>}
      </div>

      <div className="flex items-center justify-end gap-2 text-[13px] text-muted-foreground">
        <span>
          共 {total} 条 · 第 {filter.page} / {pages} 页
        </span>
        <Button variant="outline" size="sm" disabled={filter.page <= 1} onClick={() => setFilter({ page: filter.page - 1 })}>
          上一页
        </Button>
        <Button variant="outline" size="sm" disabled={filter.page >= pages} onClick={() => setFilter({ page: filter.page + 1 })}>
          下一页
        </Button>
      </div>

      {product && <CreateRequirementDialog org={org} productId={product.id} open={creating} onOpenChange={setCreating} />}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <RequirementsPage />
    </Suspense>
  );
}
```

`apps/web/src/app/(app)/[org]/requirements/create-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { OptionMultiSelect } from '@/components/option-multi-select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { requirementKeys, useApiMutation, useFields, useMembers, useOrg } from '@/lib/queries';
import type { RequirementListItem } from '@/lib/types';

const NONE = '__none';

export function CreateRequirementDialog({ org, productId, open, onOpenChange }: { org: string; productId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const fields = useFields(org, productId);
  const orgQ = useOrg(org);
  const canListMembers = !!orgQ.data && orgQ.data.me.orgRole !== 'guest';
  const members = useMembers(org, canListMembers);
  const [title, setTitle] = useState('');
  const [requester, setRequester] = useState(NONE);
  const [priority, setPriority] = useState(NONE);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const reset = () => {
    setTitle('');
    setRequester(NONE);
    setPriority(NONE);
    setPlatforms([]);
  };
  const create = useApiMutation(
    () =>
      api<{ requirement: RequirementListItem }>(`/orgs/${org}/products/${productId}/requirements`, {
        method: 'POST',
        body: {
          title,
          requesterMemberId: requester === NONE ? null : requester,
          fields: { ...(priority !== NONE && { priority: [priority] }), ...(platforms.length > 0 && { platform: platforms }) },
        },
      }),
    {
      invalidate: [requirementKeys(org)],
      silentError: true,
      onSuccess: (d) => {
        toast.success(`已创建 ${d.requirement.displayKey}`);
        reset();
        onOpenChange(false);
      },
    },
  );
  const priorityField = fields.data?.find((f) => f.key === 'priority');
  const platformField = fields.data?.find((f) => f.key === 'platform');
  const people = (members.data ?? []).filter((m) => m.status === 'active' && m.kind === 'human');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建需求</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="req-title">标题</Label>
            <Input id="req-title" value={title} maxLength={200} autoFocus onChange={(e) => setTitle(e.target.value)} />
          </div>
          {people.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>提出人</Label>
              <Select value={requester} onValueChange={setRequester}>
                <SelectTrigger aria-label="提出人">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不填</SelectItem>
                  {people.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex gap-4">
            {priorityField && (
              <div className="flex flex-col gap-1.5">
                <Label>优先级</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger className="w-32" aria-label="优先级">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>不填</SelectItem>
                    {priorityField.options
                      .filter((o) => o.active)
                      .map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {platformField && platformField.options.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>平台</Label>
                <OptionMultiSelect label="选择平台" options={platformField.options.filter((o) => o.active).map((o) => ({ id: o.id, label: o.label }))} value={platforms} onChange={setPlatforms} />
              </div>
            )}
          </div>
          <FormError error={create.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={!title.trim() || create.isPending}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

`useApiMutation` 的第一个参数签名是 `(vars) => Promise<T>`，这里不需要变量，调用时传 `undefined`。

`useProductWorkflow` 增加 `enabled: !!id`（列表页在产品加载前会传空字符串，现有调用方总是传有效 id，不受影响）。

成员列表接口对访客返回 403，所以给 `useMembers` 增加第二个参数 `enabled`（默认 `true`），列表页与对话框在访客时传 `false`：

```ts
export const useMembers = (o: string, enabled = true) =>
  useQuery({ queryKey: qk.members(o), queryFn: () => api<{ members: Member[] }>(`/orgs/${o}/members`), select: (d) => d.members, enabled });
```

概览页 `apps/web/src/app/(app)/[org]/page.tsx`：产品卡片的链接由 `/${org}` 改为 `` `/${org}/requirements?product=${p.key}` ``。

- [ ] **Step 6: 端到端测试（列表部分）**

`apps/web/e2e/requirements.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function createProduct(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  return (await res.json()).product.id as string;
}

test('需求列表：新建、按状态和优先级筛选、搜索编号', async ({ page, request }) => {
  const productId = await createProduct(request);
  const fields = (await (await request.get('/api/v1/orgs/acme/fields')).json()).fields;
  const p0 = fields.find((f: { key: string }) => f.key === 'priority').options.find((o: { key: string }) => o.key === 'p0').id;
  await request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '回收站保留 30 天', fields: { priority: [p0] } } });

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements');
  await expect(page.getByRole('heading', { name: '需求' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /全部/ })).toContainText('1');

  await page.getByRole('button', { name: '新建需求' }).click();
  await page.getByLabel('标题').fill('分享链接支持设置密码');
  await page.getByRole('combobox', { name: '优先级' }).click();
  await page.getByRole('option', { name: 'P1' }).click();
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建 PAN-2')).toBeVisible();
  await expect(page.getByRole('link', { name: '分享链接支持设置密码' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /全部/ })).toContainText('2');

  await page.getByRole('button', { name: /^优先级/ }).click();
  await page.getByRole('checkbox', { name: 'P0' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: '回收站保留 30 天' })).toBeVisible();
  await expect(page.getByRole('link', { name: '分享链接支持设置密码' })).toHaveCount(0);
  await expect(page).toHaveURL(/priority=/);

  await page.goto('/acme/requirements');
  await page.getByLabel('搜索需求').fill('PAN-2');
  await expect(page.getByRole('link', { name: '分享链接支持设置密码' })).toBeVisible();
  await expect(page.getByRole('link', { name: '回收站保留 30 天' })).toHaveCount(0);

  await page.goto('/acme/requirements');
  await page.getByRole('tab', { name: /待开始/ }).click();
  await expect(page.getByText('没有符合条件的需求')).toBeVisible();
});

test('导航中的"需求"可以点击', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  await page.getByRole('link', { name: '需求' }).click();
  await expect(page).toHaveURL(/\/acme\/requirements/);
});
```

- [ ] **Step 7: 运行测试**

Run: `pnpm --filter @flower/web test`、`pnpm typecheck`、完整端到端（后台运行并写日志，端口 3100，不要同时运行 `pnpm dev`）、`pnpm --filter @flower/web build`
Expected: 全部通过；构建成功。

- [ ] **Step 8: 提交**

```bash
git add apps/web
git commit -m "feat(web): 需求列表页：状态分栏、筛选、搜索、分页与快速新建"
```

---
### Task 13: 需求详情页：状态与流转、字段、检查项与会签、评论、历史

**Files:**
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/status-panel.tsx`、`fields-panel.tsx`、`check-items.tsx`、`comments.tsx`、`history.tsx`、`side-lists.tsx`
- Create: `apps/web/src/features/requirements/format.ts`、`format.test.ts`
- Modify: `apps/web/e2e/requirements.spec.ts`（追加详情部分）

**Interfaces:**
- Consumes: Task 12 的类型、查询、`requirementKeys`；Task 6 的接口；`CHECK_STATE_LABEL`、`TASK_STATUS_LABEL`、`RELATION_LABEL`
- Produces：
  - `formatDateTime(iso: string): string`（`YYYY-MM-DD HH:mm`，本地时区）、`formatDate(iso: string): string`（`YYYY-MM-DD`，本地时区）、`stateLabel(states, key): string`
  - 页面 `/[org]/requirements/[key]`（`key` 为 `PAN-12` 或旧编号；旧编号打开后地址替换为新编号）
  - 每个修改成功后失效 `requirementKeys(org)`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/requirements/format.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, stateLabel } from './format';

describe('详情页格式化', () => {
  it('日期按本地时区输出', () => {
    const iso = new Date(2026, 2, 5, 9, 7).toISOString();
    expect(formatDateTime(iso)).toBe('2026-03-05 09:07');
    expect(formatDate(iso)).toBe('2026-03-05');
  });

  it('状态名找不到时显示 key', () => {
    const states = [{ key: 'collect', label: '收集' }];
    expect(stateLabel(states, 'collect')).toBe('收集');
    expect(stateLabel(states, 'gone')).toBe('gone');
    expect(stateLabel(states, null)).toBe('（创建）');
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/requirements/format.test.ts`
Expected: FAIL。

- [ ] **Step 2: 实现 `format.ts`**

```ts
const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function stateLabel(states: Array<{ key: string; label: string }>, key: string | null): string {
  if (key === null) return '（创建）';
  return states.find((s) => s.key === key)?.label ?? key;
}
```

- [ ] **Step 3: 页面骨架**

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：

```tsx
'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, api } from '@/lib/api';
import { requirementKeys, useApiMutation, useRequirement } from '@/lib/queries';
import { CheckItems } from './check-items';
import { Comments } from './comments';
import { FieldsPanel } from './fields-panel';
import { History } from './history';
import { SideLists } from './side-lists';
import { StatusPanel } from './status-panel';

export default function RequirementPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const decodedKey = decodeURIComponent(key);
  const router = useRouter();
  const q = useRequirement(org, decodedKey);
  const r = q.data;
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState('');
  const patch = useApiMutation((body: { title?: string; description?: string }) => api(`/orgs/${org}/requirements/${r!.id}`, { method: 'PATCH', body }), {
    invalidate: [requirementKeys(org)],
    success: '已保存',
  });

  useEffect(() => {
    if (r && r.displayKey !== decodedKey) router.replace(`/${org}/requirements/${r.displayKey}`);
  }, [r, decodedKey, org, router]);

  if (q.error instanceof ApiError && q.error.status === 404) return <NoAccess message="需求不存在，或你没有查看它所在产品的权限。" />;
  if (!r) return <Skeleton className="h-64" />;
  const canEdit = r.myRole !== 'viewer';

  return (
    <>
      <PageHeader
        crumbs={[{ label: '需求', href: `/${org}/requirements?product=${r.productKey}` }, { label: r.displayKey }]}
        title={
          editingTitle ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                patch.mutate({ title }, { onSuccess: () => setEditingTitle(false) });
              }}
            >
              <Input aria-label="标题" className="h-9 text-xl font-semibold" value={title} autoFocus maxLength={200} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditingTitle(false)} />
            </form>
          ) : (
            <button
              type="button"
              disabled={!canEdit}
              className="text-left disabled:cursor-default"
              onClick={() => {
                setTitle(r.title);
                setEditingTitle(true);
              }}
            >
              <span className="mr-2 font-mono text-base text-muted-foreground">{r.displayKey}</span>
              {r.title}
            </button>
          )
        }
        description={r.aliases.length > 0 ? `旧编号：${r.aliases.join('、')}` : undefined}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-md border bg-card p-4" aria-labelledby="desc-title">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="desc-title" className="text-sm font-semibold">
                描述
              </h2>
              {canEdit && !editingDesc && (
                <button
                  type="button"
                  className="text-[13px] text-primary"
                  onClick={() => {
                    setDescription(r.description);
                    setEditingDesc(true);
                  }}
                >
                  编辑
                </button>
              )}
            </div>
            {editingDesc ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  patch.mutate({ description }, { onSuccess: () => setEditingDesc(false) });
                }}
              >
                <textarea aria-label="描述" className="min-h-48 rounded border bg-background p-2 text-[13px]" value={description} onChange={(e) => setDescription(e.target.value)} />
                <div className="flex justify-end gap-2">
                  <button type="button" className="text-[13px]" onClick={() => setEditingDesc(false)}>
                    取消
                  </button>
                  <button type="submit" className="rounded bg-primary px-3 py-1 text-[13px] text-primary-foreground">
                    保存
                  </button>
                </div>
              </form>
            ) : (
              <p className="whitespace-pre-wrap text-[13px] leading-6">{r.description || <span className="text-muted-foreground">暂无描述</span>}</p>
            )}
          </section>
          <CheckItems org={org} requirement={r} />
          <Comments org={org} requirementId={r.id} />
          <History requirement={r} />
        </div>
        <div className="flex flex-col gap-4">
          <StatusPanel org={org} requirement={r} />
          <FieldsPanel org={org} requirement={r} />
          <SideLists org={org} requirement={r} />
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: 状态与流转**

`status-panel.tsx`：展示当前状态；把 `requirement.transitions` 逐条列出——可流转的是按钮，点击即流转；不满足条件的显示为不可点的按钮，并在下方列出 `unmet[].message`（这就是"下一步卡在哪"）；`canForce` 为真时，不满足条件的条目旁边显示"强制流转"，打开对话框要求填写原因（必填，最多 500 字）。只读成员（`myRole === 'viewer'`）看得到列表但按钮不可点。

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { requirementKeys, useApiMutation } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

export function StatusPanel({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const [forcing, setForcing] = useState<{ to: string; label: string } | null>(null);
  const [reason, setReason] = useState('');
  const state = r.workflow.states.find((s) => s.key === r.stateKey);
  const move = useApiMutation((vars: { to: string; force?: boolean; reason?: string }) => api(`/orgs/${org}/requirements/${r.id}/transitions`, { method: 'POST', body: vars }), {
    invalidate: [requirementKeys(org)],
    success: '已流转',
  });
  const force = useApiMutation((vars: { to: string; reason: string }) => api(`/orgs/${org}/requirements/${r.id}/transitions`, { method: 'POST', body: { ...vars, force: true } }), {
    invalidate: [requirementKeys(org)],
    silentError: true,
    success: '已强制流转',
    onSuccess: () => {
      setForcing(null);
      setReason('');
    },
  });
  const canEdit = r.myRole !== 'viewer';

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="status-title">
      <h2 id="status-title" className="mb-3 text-sm font-semibold">
        状态
      </h2>
      <p className="mb-3 flex items-center gap-2 text-base font-medium" data-testid="current-state">
        <span className="size-2.5 rounded-full" style={{ background: state?.color }} aria-hidden="true" />
        {state?.label ?? r.stateKey}
      </p>
      <ul className="flex flex-col gap-2" aria-label="可流转到">
        {r.transitions.map((t) => (
          <li key={t.to} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Button size="sm" variant={t.allowed ? 'default' : 'outline'} disabled={!t.allowed || !canEdit || move.isPending} onClick={() => move.mutate({ to: t.to })}>
                {t.label}
              </Button>
              {!t.allowed && r.canForce && (
                <button type="button" className="text-[12px] text-muted-foreground underline" onClick={() => setForcing({ to: t.to, label: t.label })}>
                  强制流转
                </button>
              )}
            </div>
            {t.unmet.length > 0 && (
              <ul className="pl-1 text-[12px] text-muted-foreground">
                {t.unmet.map((u) => (
                  <li key={u.message}>· {u.message}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <Dialog open={!!forcing} onOpenChange={(o) => !o && setForcing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>强制流转到「{forcing?.label}」</DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">会跳过流转条件，并在历史中记录原因。</p>
          <Textarea aria-label="原因" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <FormError error={force.error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setForcing(null)}>
              取消
            </Button>
            <Button disabled={!reason.trim() || force.isPending} onClick={() => force.mutate({ to: forcing!.to, reason })}>
              确认流转
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
```

- [ ] **Step 5: 字段面板**

`fields-panel.tsx`：负责人、提出人（成员下拉，含"不填"）、业务域（结构树第一层下拉）、每个字段（单选用下拉，多选用 `OptionMultiSelect`），迭代只读显示名称（加入迭代在 P1-B 实现）。只读成员全部只读显示。访客不加载成员列表（`useMembers(org, enabled)`）。

```tsx
'use client';

import { OptionMultiSelect } from '@/components/option-multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { requirementKeys, useApiMutation, useFields, useMembers, useNodes, useOrg } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

const NONE = '__none';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function FieldsPanel({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const orgQ = useOrg(org);
  const canListMembers = !!orgQ.data && orgQ.data.me.orgRole !== 'guest';
  const members = useMembers(org, canListMembers);
  const nodes = useNodes(org, r.productId);
  const fields = useFields(org, r.productId);
  const canEdit = r.myRole !== 'viewer';
  const patch = useApiMutation((body: Record<string, string | null>) => api(`/orgs/${org}/requirements/${r.id}`, { method: 'PATCH', body }), { invalidate: [requirementKeys(org)] });
  const setField = useApiMutation((v: { key: string; optionIds: string[] }) => api(`/orgs/${org}/requirements/${r.id}/fields/${v.key}`, { method: 'PUT', body: { optionIds: v.optionIds } }), {
    invalidate: [requirementKeys(org)],
  });
  const people = (members.data ?? []).filter((m) => m.status === 'active' && m.kind === 'human');

  const memberSelect = (label: string, field: 'ownerMemberId' | 'requesterMemberId', current: { id: string; displayName: string } | null) => (
    <Row label={label}>
      {canEdit && canListMembers ? (
        <Select value={current?.id ?? NONE} onValueChange={(v) => patch.mutate({ [field]: v === NONE ? null : v })}>
          <SelectTrigger className="h-8" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不填</SelectItem>
            {current && !people.some((p) => p.id === current.id) && <SelectItem value={current.id}>{current.displayName}</SelectItem>}
            {people.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        (current?.displayName ?? '—')
      )}
    </Row>
  );

  const topNodes = (nodes.data ?? []).filter((n) => n.depth === 1);
  return (
    <section className="flex flex-col gap-2.5 rounded-md border bg-card p-4" aria-label="属性">
      {memberSelect('负责人', 'ownerMemberId', r.owner)}
      {memberSelect('提出人', 'requesterMemberId', r.requester)}
      <Row label="业务域">
        {canEdit && topNodes.length > 0 ? (
          <Select value={r.node?.id ?? NONE} onValueChange={(v) => patch.mutate({ nodeId: v === NONE ? null : v })}>
            <SelectTrigger className="h-8" aria-label="业务域">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不填</SelectItem>
              {topNodes.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          (r.node?.name ?? '—')
        )}
      </Row>
      {r.fields.map((f) => {
        const def = fields.data?.find((x) => x.key === f.key);
        const opts = (def?.options ?? []).filter((o) => o.active || f.options.some((v) => v.id === o.id));
        return (
          <Row key={f.key} label={f.label}>
            {!canEdit || !def ? (
              f.options.map((o) => o.label).join('、') || '—'
            ) : f.cardinality === 'single' ? (
              <Select value={f.options[0]?.id ?? NONE} onValueChange={(v) => setField.mutate({ key: f.key, optionIds: v === NONE ? [] : [v] })}>
                <SelectTrigger className="h-8" aria-label={f.label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不填</SelectItem>
                  {opts.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <OptionMultiSelect
                label={f.options.map((o) => o.label).join('、') || '选择'}
                options={opts.map((o) => ({ id: o.id, label: o.label, color: o.color }))}
                value={f.options.map((o) => o.id)}
                onChange={(ids) => setField.mutate({ key: f.key, optionIds: ids })}
              />
            )}
          </Row>
        );
      })}
      <Row label="迭代">{r.iteration?.name ?? '未排期'}</Row>
    </section>
  );
}
```

- [ ] **Step 6: 检查项与会签**

`check-items.tsx`：每个检查项一行，显示名称与状态；普通检查项在可编辑时是状态下拉（5 个状态，文案用 `CHECK_STATE_LABEL`），并显示备注；会签检查项显示每条签字规则（`signers[].label`）及其最新结论与签字人（有代签时显示"由 ××× 代签"），当前成员可签的规则（`canSign`）显示"通过 / 驳回"按钮，产品管理员对 `canSignOnBehalf` 的规则显示"代签"按钮（打开对话框选择通过或驳回并填写备注，提交 `{ decision, ruleIndex, onBehalf: true, note }`）。AI 预审等带 `meta.rounds` 的检查项显示"共 N 轮，最后一轮阻塞问题 M 个"。

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { CHECK_STATE_LABEL } from '@/lib/labels';
import { requirementKeys, useApiMutation } from '@/lib/queries';
import type { CheckState, RequirementDetail } from '@/lib/types';

type Item = RequirementDetail['checkItems'][number];
const STATE_STYLE: Record<CheckState, string> = {
  not_started: 'text-muted-foreground',
  in_progress: 'text-amber-700 dark:text-amber-400',
  passed: 'text-primary',
  rejected: 'text-destructive',
  not_needed: 'text-muted-foreground',
};

function Rounds({ meta }: { meta: Record<string, unknown> }) {
  const rounds = Array.isArray(meta.rounds) ? (meta.rounds as Array<{ blockingCount?: number }>) : null;
  if (!rounds?.length) return null;
  return (
    <p className="text-[12px] text-muted-foreground">
      共 {rounds.length} 轮，最后一轮阻塞问题 {rounds.at(-1)?.blockingCount ?? 0} 个
    </p>
  );
}

export function CheckItems({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const [proxy, setProxy] = useState<{ item: Item; ruleIndex: number } | null>(null);
  const [decision, setDecision] = useState<'passed' | 'rejected'>('passed');
  const [note, setNote] = useState('');
  const canEdit = r.myRole !== 'viewer';
  const setState = useApiMutation((v: { key: string; state: CheckState }) => api(`/orgs/${org}/requirements/${r.id}/checks/${v.key}`, { method: 'PUT', body: { state: v.state } }), {
    invalidate: [requirementKeys(org)],
  });
  const sign = useApiMutation(
    (v: { key: string; decision: 'passed' | 'rejected'; ruleIndex?: number; onBehalf?: boolean; note?: string }) =>
      api(`/orgs/${org}/requirements/${r.id}/checks/${v.key}/signoffs`, { method: 'POST', body: { decision: v.decision, ruleIndex: v.ruleIndex, onBehalf: v.onBehalf, note: v.note } }),
    {
      invalidate: [requirementKeys(org)],
      success: '已签字',
      onSuccess: () => {
        setProxy(null);
        setNote('');
      },
    },
  );
  if (r.checkItems.length === 0) return null;

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="checks-title">
      <h2 id="checks-title" className="mb-3 text-sm font-semibold">
        检查项
      </h2>
      <ul className="flex flex-col divide-y">
        {r.checkItems.map((c) => (
          <li key={c.key} className="flex flex-col gap-1.5 py-2.5" aria-label={c.label}>
            <div className="flex items-center gap-3">
              <span className="w-24 text-[13px] font-medium">{c.label}</span>
              {c.type === 'single' && canEdit ? (
                <Select value={c.state} onValueChange={(v) => setState.mutate({ key: c.key, state: v as CheckState })}>
                  <SelectTrigger className="h-8 w-28" aria-label={`${c.label}状态`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CHECK_STATE_LABEL) as CheckState[]).map((s) => (
                      <SelectItem key={s} value={s}>
                        {CHECK_STATE_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className={`text-[13px] ${STATE_STYLE[c.state]}`}>{CHECK_STATE_LABEL[c.state]}</span>
              )}
              {c.note && <span className="truncate text-[12px] text-muted-foreground">{c.note}</span>}
            </div>
            <Rounds meta={c.meta} />
            {c.type === 'signoff' && (
              <ul className="ml-24 flex flex-col gap-1">
                {c.signers.map((s) => {
                  const latest = [...c.signoffs].reverse().find((x) => x.ruleIndex === s.index);
                  return (
                    <li key={s.index} className="flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="w-24 text-muted-foreground">{s.label}</span>
                      {latest ? (
                        <span className={latest.decision === 'passed' ? 'text-primary' : 'text-destructive'}>
                          {latest.decision === 'passed' ? '通过' : '驳回'} · {latest.signer.displayName}
                          {latest.actedBy && `（由 ${latest.actedBy.displayName} 代签）`} · {formatDateTime(latest.at)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">未签</span>
                      )}
                      {c.canSign.includes(s.index) && (
                        <>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[12px]" onClick={() => sign.mutate({ key: c.key, decision: 'passed', ruleIndex: s.index })}>
                            通过
                          </Button>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[12px]" onClick={() => sign.mutate({ key: c.key, decision: 'rejected', ruleIndex: s.index })}>
                            驳回
                          </Button>
                        </>
                      )}
                      {c.canSignOnBehalf.includes(s.index) && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" onClick={() => setProxy({ item: c, ruleIndex: s.index })}>
                          代签
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <Dialog open={!!proxy} onOpenChange={(o) => !o && setProxy(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>代「{proxy ? proxy.item.signers[proxy.ruleIndex]?.label : ''}」签字</DialogTitle>
          </DialogHeader>
          <Select value={decision} onValueChange={(v) => setDecision(v as 'passed' | 'rejected')}>
            <SelectTrigger aria-label="结论">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="passed">通过</SelectItem>
              <SelectItem value="rejected">驳回</SelectItem>
            </SelectContent>
          </Select>
          <Textarea aria-label="备注" placeholder="例如：电话确认" value={note} onChange={(e) => setNote(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setProxy(null)}>
              取消
            </Button>
            <Button onClick={() => proxy && sign.mutate({ key: proxy.item.key, decision, ruleIndex: proxy.ruleIndex, onBehalf: true, note })}>确认代签</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
```

- [ ] **Step 7: 评论、历史、附属列表**

`comments.tsx`：列出评论（作者、时间、"进展"标记、正文保留换行），底部输入框与"发表"按钮；组件挂载后调用一次 `POST …/comments/read`（成功后失效评论查询）。

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { qk, useApiMutation, useRequirementComments } from '@/lib/queries';

export function Comments({ org, requirementId }: { org: string; requirementId: string }) {
  const comments = useRequirementComments(org, requirementId);
  const [body, setBody] = useState('');
  const add = useApiMutation(() => api(`/orgs/${org}/requirements/${requirementId}/comments`, { method: 'POST', body: { body } }), {
    invalidate: [qk.requirementComments(org, requirementId)],
    onSuccess: () => setBody(''),
  });
  const read = useApiMutation(() => api(`/orgs/${org}/requirements/${requirementId}/comments/read`, { method: 'POST' }), {
    invalidate: [qk.requirementComments(org, requirementId)],
    silentError: true,
  });
  const readMutate = read.mutate;
  useEffect(() => {
    readMutate(undefined);
  }, [requirementId, readMutate]);

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="comments-title">
      <h2 id="comments-title" className="mb-3 text-sm font-semibold">
        评论 <span className="font-mono text-xs text-muted-foreground">{comments.data?.length ?? 0}</span>
      </h2>
      <ul className="flex flex-col gap-3">
        {(comments.data ?? []).map((c) => (
          <li key={c.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">{c.author?.displayName ?? '未知成员'}</span>
              <span>{formatDateTime(c.createdAt)}</span>
              {c.kind === 'update' && <Badge variant="outline">进展</Badge>}
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-6">{c.body}</p>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(undefined);
        }}
      >
        <Textarea aria-label="写评论" placeholder="写评论…" value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!body.trim() || add.isPending}>
            发表
          </Button>
        </div>
      </form>
    </section>
  );
}
```

`history.tsx`：按时间列出 `requirement.history`（"从 A 到 B · 操作人 · 时间"，强制流转显示"强制"标记与原因），时间倒序：

```tsx
import { Badge } from '@/components/ui/badge';
import { formatDateTime, stateLabel } from '@/features/requirements/format';
import type { RequirementDetail } from '@/lib/types';

export function History({ requirement: r }: { requirement: RequirementDetail }) {
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="history-title">
      <h2 id="history-title" className="mb-3 text-sm font-semibold">
        状态历史
      </h2>
      <ol className="flex flex-col gap-2">
        {[...r.history].reverse().map((h, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-mono text-xs text-muted-foreground">{formatDateTime(h.at)}</span>
            <span>
              {h.from === null ? `创建为「${stateLabel(r.workflow.states, h.to)}」` : `「${stateLabel(r.workflow.states, h.from)}」→「${stateLabel(r.workflow.states, h.to)}」`}
            </span>
            {h.actor && <span className="text-muted-foreground">{h.actor.displayName}</span>}
            {h.forced && <Badge variant="destructive">强制</Badge>}
            {h.reason && <span className="text-muted-foreground">原因：{h.reason}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
```

`side-lists.tsx`：依次显示"开发分配"（成员 · 职能 · 平台）、"阻塞项"（进行中的在前，已解决的置灰）、"任务"（标题 · 负责人 · 状态 · 计划开始 · 天数）、"发布版本"（平台 · 版本号 · 状态 · 发布日期）、"关联需求"（关系名 · 编号链接 · 标题）；某一类为空时不显示该块。

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatDate } from '@/features/requirements/format';
import { RELATION_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';
import type { RequirementDetail } from '@/lib/types';

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border bg-card p-4" aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">{children}</ul>
    </section>
  );
}

export function SideLists({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  return (
    <>
      {r.assignments.length > 0 && (
        <Block title="开发分配">
          {r.assignments.map((a, i) => (
            <li key={i}>
              {a.member.displayName}
              <span className="text-muted-foreground">{[a.functionTag?.name, a.platform?.label].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
            </li>
          ))}
        </Block>
      )}
      {r.blockers.length > 0 && (
        <Block title="阻塞项">
          {[...r.blockers]
            .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1))
            .map((b) => (
              <li key={b.id} className={b.status === 'resolved' ? 'text-muted-foreground line-through' : ''}>
                {b.description}
              </li>
            ))}
        </Block>
      )}
      {r.tasks.length > 0 && (
        <Block title="任务">
          {r.tasks.map((t) => (
            <li key={t.id} className="flex flex-col">
              <span>{t.title}</span>
              <span className="text-[12px] text-muted-foreground">
                {[t.assignee?.displayName, TASK_STATUS_LABEL[t.status], t.planStart && `${t.planStart} 起`, t.planDays && `${t.planDays} 天`].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </Block>
      )}
      {r.releases.length > 0 && (
        <Block title="发布版本">
          {r.releases.map((x) => (
            <li key={x.id}>
              {x.platform?.label} <span className="font-mono">{x.versionName}</span>
              <span className="text-muted-foreground"> · {x.status === 'released' ? `已发布 ${x.releasedAt ? formatDate(x.releasedAt) : ''}` : '计划中'}</span>
            </li>
          ))}
        </Block>
      )}
      {r.relations.length > 0 && (
        <Block title="关联需求">
          {r.relations.map((x) => (
            <li key={`${x.type}-${x.other.id}`}>
              <span className="text-muted-foreground">{RELATION_LABEL[x.type] ?? x.type} </span>
              <Link className="font-mono hover:underline" href={`/${org}/requirements/${x.other.displayKey}`}>
                {x.other.displayKey}
              </Link>{' '}
              {x.other.title}
            </li>
          ))}
        </Block>
      )}
    </>
  );
}
```

- [ ] **Step 8: 端到端测试（详情部分）**

在 `apps/web/e2e/requirements.spec.ts` 末尾追加：

```ts
test('需求详情：看到卡在哪、设置检查项后流转、强制流转、评论', async ({ page, request }) => {
  const productId = await createProduct(request);
  const wf = await request.post('/api/v1/orgs/acme/workflows', {
    data: {
      name: '评审流程',
      body: {
        states: [
          { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
          { key: 'todo', label: '待开发', color: '#60a5fa', order: 2, group: '', category: 'unstarted' },
          { key: 'doing', label: '开发中', color: '#f59e0b', order: 3, group: '', category: 'started' },
        ],
        initial: 'backlog',
        transitions: [
          { from: '*', to: 'todo', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] },
          { from: '*', to: 'doing', conditions: [{ type: 'has_iteration' }] },
          { from: '*', to: 'backlog', conditions: [] },
        ],
        checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
      },
    },
  });
  const versionId = (await wf.json()).version.id;
  await request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId } });
  await request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '文件夹支持拖拽排序' } });

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-1');
  await expect(page.getByTestId('current-state')).toHaveText('收集');
  await expect(page.getByRole('button', { name: '待开发' })).toBeDisabled();
  await expect(page.getByText('「可行性」需为通过（当前：未开始）')).toBeVisible();

  await page.getByRole('combobox', { name: '可行性状态' }).click();
  await page.getByRole('option', { name: '通过' }).click();
  await expect(page.getByRole('button', { name: '待开发' })).toBeEnabled();
  await page.getByRole('button', { name: '待开发' }).click();
  await expect(page.getByTestId('current-state')).toHaveText('待开发');

  await expect(page.getByText('需要先加入迭代')).toBeVisible();
  await page.getByRole('button', { name: '强制流转' }).click();
  await page.getByLabel('原因').fill('线上问题紧急修复');
  await page.getByRole('button', { name: '确认流转' }).click();
  await expect(page.getByTestId('current-state')).toHaveText('开发中');
  const history = page.getByRole('region', { name: '状态历史' });
  await expect(history.getByText('强制')).toBeVisible();
  await expect(history.getByText('原因：线上问题紧急修复')).toBeVisible();

  await page.getByLabel('写评论').fill('已和设计确认交互');
  await page.getByRole('button', { name: '发表' }).click();
  await expect(page.getByRole('region', { name: /评论/ }).getByText('已和设计确认交互')).toBeVisible();
});
```

- [ ] **Step 9: 运行测试**

Run: `pnpm --filter @flower/web test`、`pnpm typecheck`、完整端到端（后台运行并写日志）、`pnpm --filter @flower/web build`
Expected: 全部通过。

- [ ] **Step 10: 提交**

```bash
git add apps/web
git commit -m "feat(web): 需求详情页：流转与卡点、字段、检查项与会签、评论、历史"
```

---
### Task 14: 用生产数据副本加载到开发环境，测量性能，记录验证结果

**Files:**
- Create: `packages/migrate/src/perf.ts`
- Modify: `packages/migrate/src/cli.ts`（增加 `perf` 子命令）
- Test: `packages/migrate/test/perf.test.ts`
- Create: `docs/p1a-validation.md`（只写数量与耗时，不写任何姓名、邮箱或需求标题）
- Modify: `CLAUDE.md`（性能测量命令）

**Interfaces:**
- Consumes: `listRequirements`、`getRequirementByKey`、`listRequirementComments`、`listProducts`、`resolveActor`（`@flower/core`）
- Produces：
  - `type PerfCase = { name: string; run: () => Promise<unknown> }`
  - `measure(cases: PerfCase[], runs: number): Promise<Array<{ name: string; p50: number; p95: number; max: number }>>`（每个用例先预热一次；毫秒，保留一位小数）
  - `buildPerfCases(db: Db, actor: Actor, productId: string): Promise<PerfCase[]>`（参数从数据中选取：数量最多的状态、需求最多的负责人、一个优先级选项、一个标题中的两个字、第 5 页、20 条需求轮流打开详情与评论）
  - 命令行：`perf --org-slug pan123 --owner-email <邮箱> [--runs 20]`，读取 `DATABASE_URL`（运行时角色，受 RLS 约束，与线上请求路径一致）

- [ ] **Step 1: 写失败的测试**

`packages/migrate/test/perf.test.ts`：

```ts
import { listProducts, resolveActor } from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { seedInstance } from '@flower/core/testing/factories';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPerfCases, measure } from '../src/perf';
import { buildImportPlan } from '../src/plan';
import { writeImport } from '../src/write';
import { makeLegacyData, reviewedMapping } from './fixtures';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

describe('性能测量', () => {
  it('measure 给出每个用例的 p50、p95 和最大值', async () => {
    let calls = 0;
    const result = await measure([{ name: '空操作', run: async () => void calls++ }], 5);
    expect(calls).toBe(6);
    expect(result).toEqual([{ name: '空操作', p50: expect.any(Number), p95: expect.any(Number), max: expect.any(Number) }]);
  });

  it('根据导入的数据生成用例，并且都能执行', async () => {
    const { account } = await seedInstance(t.db);
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), {
      orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29',
      owner: { accountId: account.id, email: account.email, name: account.name },
    });
    await writeImport(t.adminDb, plan, { replace: false });
    const actor = (await resolveActor(t.db, account.id, 'pan123'))!;
    const [product] = await listProducts(t.db, actor);
    const cases = await buildPerfCases(t.db, actor, product!.id);
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
    ]);
    const result = await measure(cases, 2);
    expect(result).toHaveLength(9);
  });
});
```

Run: `pnpm --filter @flower/migrate exec vitest run test/perf.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现 `perf.ts`**

```ts
import { type Actor, type Db, getRequirementByKey, listRequirementComments, listRequirements } from '@flower/core';

export type PerfCase = { name: string; run: () => Promise<unknown> };

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function measure(cases: PerfCase[], runs: number): Promise<Array<{ name: string; p50: number; p95: number; max: number }>> {
  const out: Array<{ name: string; p50: number; p95: number; max: number }> = [];
  for (const c of cases) {
    await c.run();
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await c.run();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const pick = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!;
    out.push({ name: c.name, p50: round1(pick(0.5)), p95: round1(pick(0.95)), max: round1(times.at(-1)!) });
  }
  return out;
}

export async function buildPerfCases(db: Db, actor: Actor, productId: string): Promise<PerfCase[]> {
  const sample = await listRequirements(db, actor, productId, { pageSize: 200 });
  const topState = Object.entries(sample.stateCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const ownerCount = new Map<string, number>();
  for (const r of sample.items) if (r.owner) ownerCount.set(r.owner.id, (ownerCount.get(r.owner.id) ?? 0) + 1);
  const topOwner = [...ownerCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const priorityId = sample.items.find((r) => r.priority)?.priority?.id;
  const keyword = sample.items.find((r) => r.title.length >= 2)?.title.slice(0, 2) ?? '需求';
  const keys = sample.items.slice(0, 20).map((r) => r.displayKey);
  const ids = sample.items.slice(0, 20).map((r) => r.id);
  let i = 0;
  let j = 0;
  return [
    { name: '列表：默认第 1 页', run: () => listRequirements(db, actor, productId, {}) },
    { name: '列表：第 5 页', run: () => listRequirements(db, actor, productId, { page: 5 }) },
    { name: '列表：按最多的状态', run: () => listRequirements(db, actor, productId, { states: topState ? [topState] : [] }) },
    { name: '列表：按负责人', run: () => listRequirements(db, actor, productId, { ownerIds: topOwner ? [topOwner] : [] }) },
    { name: '列表：按优先级', run: () => listRequirements(db, actor, productId, { priorityOptionIds: priorityId ? [priorityId] : [] }) },
    { name: '列表：标题关键词', run: () => listRequirements(db, actor, productId, { q: keyword }) },
    { name: '列表：按编号', run: () => listRequirements(db, actor, productId, { q: keys[0] ?? '1' }) },
    { name: '详情：轮流打开', run: () => getRequirementByKey(db, actor, keys[i++ % Math.max(keys.length, 1)] ?? 'PAN-1') },
    { name: '评论：轮流读取', run: () => listRequirementComments(db, actor, ids[j++ % Math.max(ids.length, 1)]!) },
  ];
}
```

- [ ] **Step 3: 命令行 `perf` 子命令**

在 `cli.ts` 的 `parseArgs` 选项中加入 `runs: { type: 'string', default: '20' }`；在加载旧数据**之前**处理 `perf`（它不需要 `--plane` 等参数）：

```ts
  if (cmd === 'perf') {
    const url = process.env.DATABASE_URL ?? fail('perf 需要 DATABASE_URL（运行时角色）');
    const email = v['owner-email'] ?? fail('缺少参数 --owner-email');
    const { db, close } = createDb(url, { max: 2 });
    try {
      const [a] = await db.select().from(accounts).where(eq(accounts.email, email.trim().toLowerCase()));
      if (!a) fail(`找不到账号 ${email}`);
      const actor = (await resolveActor(db, a.id, v['org-slug']!)) ?? fail(`账号 ${email} 不是组织 ${v['org-slug']} 的成员`);
      const products = await listProducts(db, actor);
      const product = products.find((p) => p.key === v['product-key']) ?? fail(`找不到产品 ${v['product-key']}`);
      const result = await measure(await buildPerfCases(db, actor, product.id), Number(v.runs));
      console.log('| 用例 | p50 (ms) | p95 (ms) | 最大 (ms) |\n|---|---|---|---|');
      for (const r of result) console.log(`| ${r.name} | ${r.p50} | ${r.p95} | ${r.max} |`);
    } finally {
      await close();
    }
    return;
  }
```

`cli.ts` 的 import 增加 `listProducts, resolveActor`（来自 `@flower/core`）与 `buildPerfCases, measure`（来自 `./perf`）；`USAGE` 增加一行 `perf --org-slug pan123 --owner-email 邮箱 [--product-key PAN] [--runs 20]（读取 DATABASE_URL）`。把现有的 `const data: LegacyData = …` 移到 `perf` 分支之后。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @flower/migrate test` 与 `pnpm typecheck`
Expected: 全部通过。提交：

```bash
git add packages/migrate
git commit -m "feat(migrate): 真实数据性能测量"
```

- [ ] **Step 5: 加载生产数据副本到开发数据库**

前提（由控制方在派发本任务时确认并提供）：
- 用户已审阅 `.local-data/mapping/` 并完成业务域、平台、人员的合并决定；
- `import --dry-run` 生成的对账报告中 `problems` 为 0；
- 开发环境中用户自己的账号邮箱（记为 `<OWNER_EMAIL>`）。

```bash
pnpm db:migrate
pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --as-of 2026-09-29 --owner-email <OWNER_EMAIL>
```

Expected：输出"已写入组织 pan123：需求 N 条"。若组织已存在（重复执行），先确认是本任务之前的导入，再加 `--replace`。

- [ ] **Step 6: 测量性能**

```bash
pnpm --filter @flower/migrate build
node --disable-warning=ExperimentalWarning --env-file=apps/web/.env.local packages/migrate/dist/cli.mjs perf --org-slug pan123 --owner-email <OWNER_EMAIL> --runs 20
```

Expected：输出 9 个用例的 p50 / p95 / 最大值。目标：每个用例 p95 ≤ 300 ms。超过的用例不要自行优化，在任务报告中列出数字，状态报 DONE_WITH_CONCERNS。

说明：`pnpm test` 与端到端测试会把 `flower_app` 的密码改为测试值，测量前如跑过测试，先执行 `pnpm db:migrate`。

- [ ] **Step 7: 写验证记录**

`docs/p1a-validation.md`（只写数量与耗时；对账报告全文留在 `.local-data/reports/`，不进仓库）：

```markdown
# P1-A 真实数据验证记录

数据：2026-09-29 从生产服务器只读导出的 123plane、push、PRD 副本，保存在本地 `.local-data/`（不进仓库）。
迁移命令与对照表见 `CLAUDE.md`；对账报告全文：`.local-data/reports/migration-report.md`。

## 1. 迁移完整性

| 项 | 数量 |
|---|---|
| 123plane 需求 | （填写报告中的数字） |
| push 需求（含已合并） | |
| 按 plane_id 匹配 | |
| 按标题匹配 | |
| push 独有，作为新需求导入 | |
| 迁移后需求总数 | |
| 字段冲突（已按 123plane 为准） | |
| 迭代（常规 / 专项） | |
| 成员（有账号 / 无账号） | |
| 评论 + 进展 + 迭代日志 | |
| 任务（子任务 + 甘特任务） | |
| 审计事件 | |
| 跳过的数据 | （逐项写数量与原因） |
| 延后迁移 | （逐项写数量与阶段） |
| 阻止写入的问题 | 0 |

## 2. 真实数据量下的性能

测量方式：`cli.mjs perf`，运行时角色直连开发数据库（受行级安全约束），每个用例预热 1 次后执行 20 次。

| 用例 | p50 (ms) | p95 (ms) | 最大 (ms) |
|---|---|---|---|
| （粘贴 perf 输出） | | | |

## 3. 界面检查

由用户在浏览器中完成，记录结论：需求列表首屏、状态分栏数量、筛选与搜索、详情页的检查项与会签（含代签记录）、历史流转、评论。

## 4. 日常操作对比、用户试用

P1-B 完成迭代、甘特、工作台与评审会签界面后进行，结果追加在本文件。
```

把"（填写…）"与"（粘贴…）"替换为实际数字后提交。第 3 节保留为用户验收时填写。

- [ ] **Step 8: 更新 `CLAUDE.md` 并提交**

在"命令"表格追加：

```
| 真实数据性能测量（需先导入 pan123） | `pnpm --filter @flower/migrate build && node --disable-warning=ExperimentalWarning --env-file=apps/web/.env.local packages/migrate/dist/cli.mjs perf --org-slug pan123 --owner-email <邮箱>` |
```

```bash
git add docs/p1a-validation.md CLAUDE.md
git commit -m "docs: P1-A 真实数据验证记录"
```

---

## P1-A 完成标准

- `pnpm typecheck`、`pnpm test`（core、web、migrate）、完整端到端测试、`./scripts/smoke.sh` 全部通过。
- 生产数据副本的对账报告没有阻止写入的问题；`docs/p1a-validation.md` 第 1、2 节填好。
- 用户在浏览器里打开 `/pan123/requirements`，能按状态、业务域、优先级、平台、负责人、迭代筛选约 764 条需求，能打开详情看到检查项、会签（含代签）、历史和评论。
