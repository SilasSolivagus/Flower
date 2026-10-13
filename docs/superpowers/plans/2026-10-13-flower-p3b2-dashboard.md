# Flower P3-B2 基础数据看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产品看板（需求流速、前置时间、流动时间、在制品、版本按期达成率、迭代承诺完成率、专项完成率、评审效率与驳回率）与组织汇总页（组织管理员按产品对比关键数字），以及对应的只读接口；打开时实时计算，不建快照表。

**Architecture:** 指标计算全部是 `packages/core/src/dashboard/` 下的纯函数（`metrics.ts` 管日期、分位数与流动指标，`delivery-metrics.ts` 管版本、迭代、专项与评审），输入由三个读取模块从数据库取出（`flow.ts` 读需求与流转、`delivery.ts` 读版本迭代专项、`review.ts` 读检查项领域事件），`dashboard.ts` 在 `withOrg` 中校验权限、解析时间段并组装产品看板与组织汇总。接口 `GET /api/v1/orgs/:org/products/:id/dashboard` 与 `GET /api/v1/orgs/:org/dashboard` 只做参数校验。前端新页面 `/{org}/dashboard?product=…` 与 `/{org}/settings/dashboard`，图表用纯 SVG 与 CSS，TanStack Query 缓存 5 分钟。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui（Radix Tooltip、Select、Table）、lucide-react、Vitest、Playwright。不新增依赖：`apps/web/package.json` 里没有图表库，图表用内联 SVG。

**Spec:** `docs/superpowers/specs/2026-10-13-flower-p3b2-dashboard-design.md`（用户 2026-10-13 确认；本计划只实现 §1–§6，§7「产品工作情况表」不在范围内）；上位文档 `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§6.6 管理员数据看板）。与设计、代码或数据不一致之处见文末「与设计、代码或数据的冲突」。

## Global Constraints

- **今天是 2026-10-13。** 计划、验证记录、协作日志里的日期以此为准。
- **不新增租户表，不新增迁移，不改 `packages/core/src/db/schema.ts`。** 执行中如发现必须改表结构，停下来报告。
- **不新增依赖。** 图表只用内联 SVG 与 Tailwind 类；不引入任何图表库。
- **实时计算（设计 §2 方案 A）**：打开看板时按当前数据计算，前端缓存 5 分钟（`staleTime`）；不建每日快照表、物化视图，不做导出与订阅推送。
- **指标口径以设计 §3 为准**，本计划的细化见下方「设计决定」：状态按产品当前流程的状态类别归类（未知状态按 `backlog`）；「进入某类」以 `state_transitions` 为准；已删除的需求不计；「已取消」不算完成，也不进入分母；时间段与周按组织时区划分（未设置或无效时为 `Asia/Shanghai`），周从周一开始。
- **权限（设计 §5）**：产品看板对能看到该产品的成员开放（含编辑、只读成员；访客仅限被授权的产品；只读 API Token 可调用），看不到的产品返回 404「产品不存在」。组织汇总仅组织管理员（所有者、管理员；Token 须为全部产品范围，只读或读写均可），其他人 403「需要组织管理员权限」。所有查询在 `withOrg(db, actor.orgId, …)` 中，并按当前用户可见的产品过滤；看不到的产品的数据不出现在任何响应里（专项只统计本产品的需求）。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, productId, input)` / `(db, actor, input)`（实体 id 作为第三个参数的现有写法照旧），一律 `async`。看板是只读服务，不写数据，不记领域事件。
- 面向用户的文案与错误信息用中文，通过 `AppError(code, message)` 抛出。`apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`；本计划不新增浏览器安全子路径（看板的计算全在服务端，前端只做格式化）。纯逻辑放 `apps/web/src/features/dashboard/model.ts` 并写 Vitest 单测。
- 渲染期间不直接调用 `new Date()` / `Date.now()`（`react-hooks/purity`）：「今天」由接口返回的 `window.today` 提供。
- 复用已有的共享件：`PageHeader`、`EmptyState`、`QueryError`、`LoadError`、`NoAccess`、`RequireOrgAdmin`、`Table` 系列、`Select` 系列、`Tooltip` 系列；e2e `helpers.ts` 的 `ok`、`json`、`setupInstance`、`login`、`createProduct`、`createRequirement`、`createIteration`、`acceptInvite`、`expectNoPageOverflow`。
- 视觉沿用 P0-B：表格行高 40px（`h-10`）、隔行底色 `even:bg-zebra`、编号与数字用 `font-mono`、卡片圆角 6px（`rounded-md`）。升为好时用 `text-primary`，变差用 `text-destructive`。
- 布局：页面本身不出现横向滚动；表格在自己的容器里滚动；产品看板与组织汇总在 1440 与 760 两个宽度下有 Playwright 断言（`expectNoPageOverflow`）。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0` 与 `pnpm typecheck`。
- 测试需要先 `pnpm db:up`（core 的 Vitest globalSetup 会建模板库，纯函数测试也经过它）。`pnpm test` 和端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；之后要对开发库做任何操作，先执行 `pnpm db:migrate`。
- 端到端测试：每个 spec 在 `beforeEach` 调用 `resetDatabase()`；不为迁就定位器修改共享组件；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染。
- **执行代理不运行 `pnpm dev`，不读取 `.local-data/`。** 界面检查一律写成 Playwright 用例；真实数据上的界面复验、性能测量与 SQL 核对由控制方在 Task 14 完成。本地开发库只做只读查询与 `pnpm db:migrate`。验证记录只写数量与结构，不写真实姓名、需求标题。
- 提交信息用中文，每条末尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）；实际执行提交的若不是 Claude Opus 5.5，把这一行换成实际模型的名字。完成后按 `CLAUDE.md` 在 `docs/agent-log.md` 最上面追加一条（Task 14）。

## Review Focus

设计没有逐条写、各任务正常路径的测试也不一定覆盖、但最可能让使用者碰到问题的五类输入。每一条的测试已加在负责的任务里：

1. **需求反复进出「已完成」、或在两个完成类状态之间流转（如「已上线」→「已验收」），以及完成后又被重新打开。** 期望：吞吐量与前置时间按最后一次从非完成类进入完成类计，完成类之间的流转不算新的完成；当前不在完成类的需求不计入吞吐量。测试：Task 1「完成记录」。
2. **流转记录时间相同或缺失。** 迁移数据里创建记录与第一次流转可能是同一时刻；也可能有需求没有任何流转。期望：同一时刻时创建记录排在前面，不会把需求「倒回」初始状态；没有流转的需求按创建时进入当前状态处理，不报错。测试：Task 1「流转整理」。
3. **组织时区没有设置、设置无效，或时刻落在午夜前后。** 期望：未设置或无效时按 `Asia/Shanghai`，不报错；凌晨 0:30（北京时间）的流转、发布与评审按组织时区记在当天，不落到 UTC 的前一天。测试：Task 1「在制品跨时区」、Task 2「发布日与评审跨时区」、Task 3「组织时区」。
4. **自定义时间段与按迭代的不合法输入。** 只给一个日期、开始晚于结束、结束晚于今天、超过 366 天、日期不存在（2026-02-30）、别的产品的迭代、还没开始的迭代、组织汇总带迭代参数。期望：接口返回 400 / 404 与中文原因，页面显示原因并能一键恢复默认时间段，不出现无限重试。测试：Task 6「时间段参数」、Task 7「参数」、Task 8「自定义时间段校验」。
5. **新产品或数据很少的产品。** 没有需求、没有流转、没有版本、没有迭代、没有检查项事件。期望：每个区块显示「暂无数据」与原因，周趋势为 0，不报错、不出现 `NaN`；上一个同长度时间段早于数据起点时卡片显示「上期暂无数据」，而不是和 0 比较。测试：Task 6「空产品」、Task 12「组织汇总与空产品」。

## 设计决定

数量为 2026-10-13 写计划时对本地开发库的只读查询（`docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select …"`），只取数量。

| 项 | 决定 | 依据 |
|---|---|---|
| 现状数据 | pan123：产品 1 个；需求 766 条（未删除 766）；状态流转 3311 条（2026-03-12 起）；发布版本 14 个（已发布 10、计划中 4），`planned_date`、`baseline_date`、`iteration_id` 全部为空；常规迭代 11 个（全部已完成）、专项 2 个（已完成 1、规划中 1）；迭代承诺范围快照 0 条；`check_item.*` 领域事件 0 条；组织未设置时区 | 只读核对 |
| 完成记录 | 只对**当前**处于完成类的需求计算；取最后一次「从非完成类（或创建）进入完成类」的流转作为完成时刻；完成类之间的流转不算新的完成 | 设计 §3「按最后一次进入计」，见冲突表 |
| 前置时间 / 流动时间 | 前置：`requirements.created_at` 到完成时刻；流动：第一次进入进行中类到完成时刻，没有经过进行中的需求不计入流动时间。单位为天（保留 1 位小数）；中位数与 85 分位用线性插值（与 Postgres `percentile_cont` 相同） | 设计 §3 |
| 吞吐量卡片 | 时间段内完成的需求数 × 7 ÷ 时间段天数（「周均」，保留 1 位小数）；周趋势为每周（周一至周日，最后一周到时间段最后一天）完成数 | 设计 §3、§4.1 |
| 在制品 | 某天结束时（组织时区）处于进行中类的需求数，由流转记录推算；卡片取时间段最后一天，周趋势取每周日（最后一周取时间段最后一天）；「卡在哪儿」按当前时刻，按具体状态统计数量与平均停留天数（自最后一次流转起），停留最久的前 10 条 | 设计 §3、§4.1 |
| 上期对比 | 上一个同长度时间段：`[from − 天数, from − 1]`。上期早于产品数据起点（最早一条流转的日期）时，流动类卡片的上期为空，显示「上期暂无数据」 | 设计 §4.1 第 2 步，见冲突表 |
| 时间段 | 近 30 / 90 / 180 天（默认 90，结束日为今天）；自定义（两个日期都要，开始不晚于结束，结束不晚于今天，最多 366 天）；按迭代：本产品未删除的常规迭代，时间段为开始日到 `min(结束日, 今天)`，迭代还没开始时报错。组织汇总不支持按迭代 | 设计 §2，见冲突表 |
| 版本按期 | 时间段内（按发布日的组织时区日期）已发布的版本：到期日 = 基线日期，没有时取所属迭代的 `end_date`（标「按迭代结束日计」），两者都没有时不进分母（「无法判断」）；逾期天数 = 发布日 − 到期日。计划中的版本全部列出：到期日 = 计划日期，没有时取所属迭代结束日，已过到期日时显示已逾期天数。`status = released` 但 `released_at` 为空的版本跳过 | 设计 §3，见冲突表 |
| 迭代承诺 | 时间段内（开始日不晚于时间段结束、结束日不早于时间段开始）状态为进行中或已完成的本产品常规迭代；只有有 `committed` 快照的才有承诺完成率。截止日：已完成的迭代为结束日，进行中的为今天；快照内（未删除）需求在截止日结束时处于完成类的比例，已取消的不进分母；中途加入 = 当前在迭代里但不在快照里；移出 = 在快照里、未删除、当前不在迭代里 | 设计 §3；`getIterationScope` 的口径 |
| 专项 | 时间段内的专项（`type = special`，与时间段有交集），只统计**本产品**未删除的需求；不含本产品需求的专项不显示 | 设计 §3、§5，见冲突表 |
| 评审事件 | 只读 `check_item.updated` 与 `check_item.signed`（含 PRD 上的检查项），按（对象、检查项）分组；状态新值取 `payload.changes` 里 `field = state` 的 `new`。开始评审 = 第一条离开「未开始」或第一次签字的事件；评审天数 = 开始到最后一次进入「通过」（最终状态须为通过），按通过日落在时间段内统计，取中位数。有结论 = 时间段内有变为通过或驳回、或签字结论为驳回的事件；驳回过 = 其中出现过驳回。已删除的需求与 PRD 上的事件不计。统计起点 = 本产品最早一条检查项事件的日期 | 设计 §3，见冲突表 |
| 组织汇总 | 每个可见产品一行（按编号前缀排序），列出 §4.1 第 2 步的六个关键数字与上期对比；点击产品名进入同一时间段的产品看板 | 设计 §4.2 |
| 导航 | 主导航「概览」后加「看板」（键 `product-dashboard`，`/{org}/dashboard`）；组织设置「推送」后加「看板」（键 `dashboard`，`/{org}/settings/dashboard`） | 设计 §4.1、§4.2，见冲突表 |
| 图表 | 纯 SVG：每周吞吐量柱状图、在制品周趋势折线、前置与流动时间 85 分位折线；每张图带一张只给读屏器的数据表（`sr-only`），端到端测试也用它定位 | 设计 §4.3「沿用项目现有样式」 |
| 性能 | 在现有 `perf` 命令里加四个看板用例（产品近 90 天、近 180 天、按迭代、组织汇总），在 pan123 上 p95 应低于 300 毫秒 | 设计 §6 |

## 文件结构

**packages/core（新建 `src/dashboard/`）**

- `src/dashboard/metrics.ts`：日期与周（`zonedDate`、`addDays`、`daysBetween`、`mondayOf`、`weeksBetween`）、`quantile`、`round1`、`ratio`、`elapsedDays`；流转整理 `prepareFlow`、`stateAtEndOf`、`wipAt`、完成记录 `completionOf` / `completionsOf`、`flowSummary`、`weeklySeries`、`stuckNow`。纯函数，只导入 `../tasks/schedule`。
- `src/dashboard/delivery-metrics.ts`：`releaseSummary`、`iterationCommitment`、`specialCompletion`、`reviewSummary`。纯函数，只导入 `./metrics`。
- `src/dashboard/flow.ts`：`orgTimeZone`、`loadProductFlow`（产品流程的状态与检查项、未删除需求与其流转）。
- `src/dashboard/delivery.ts`：`loadReleaseFacts`、`loadIterationFacts`、`loadSpecialFacts`、`loadIterationOptions`。
- `src/dashboard/review.ts`：`stateChangeOf`、`loadReviewEvents`。
- `src/dashboard/dashboard.ts`：类型 `DashboardRange`、`DashboardWindow`、`DashboardCards`、`ProductDashboard`、`OrgDashboard`；`canViewOrgDashboard`、`getProductDashboard`、`getOrgDashboard`。
- `src/index.ts`：只加 `export * from './dashboard/dashboard';`（纯函数模块不从包入口导出，避免与已有名字冲突）。
- 测试：`test/dashboard-fixtures.ts`（纯函数测试的构造器）、`test/dashboard-helpers.ts`（用管理员连接改写流转历史）、`test/dashboard-metrics-flow.test.ts`、`test/dashboard-metrics-delivery.test.ts`、`test/dashboard-flow.test.ts`、`test/dashboard-delivery.test.ts`、`test/dashboard-review.test.ts`、`test/dashboard.test.ts`。

**apps/web**

- `src/server/routes/dashboard.ts`（新建）与 `src/server/api.ts`（注册）；测试 `test/api/dashboard.test.ts`。
- `src/lib/types.ts`、`src/lib/queries.ts`：看板类型与两个查询。
- `src/features/dashboard/model.ts` + `model.test.ts`：筛选与地址、格式化、升降、空数据原因、口径文案、图表坐标、版本结论。
- `src/features/dashboard/components/`：`metric-help.tsx`（「?」口径）、`metric-cards.tsx`（关键数字卡片）、`filter-bar.tsx`（时间段与按迭代）、`invalid-filter.tsx`（参数不合法时的提示）。
- `src/app/(app)/[org]/dashboard/`：`page.tsx`、`trends.tsx`、`stuck.tsx`、`delivery.tsx`、`specials.tsx`、`review.tsx`。
- `src/app/(app)/[org]/settings/dashboard/page.tsx`：组织汇总。
- `src/features/shell/nav.ts`、`nav.test.ts`、`src/components/org-shell.tsx`：导航与图标。
- `e2e/db.ts`（加 `adminSql`）、`e2e/dashboard.spec.ts`。

**packages/migrate**：`src/perf.ts`、`test/perf.test.ts`。

**docs**：`docs/p3b2-validation.md`（新建）、`docs/handoff.md`、`docs/agent-log.md`。

---

### Task 1: 流动指标的纯函数（日期与周、分位数、完成记录、吞吐量、在制品、停留）

**Files:**
- Create: `packages/core/src/dashboard/metrics.ts`
- Create: `packages/core/test/dashboard-fixtures.ts`
- Test: `packages/core/test/dashboard-metrics-flow.test.ts`

**Interfaces:**
- Consumes: `dayNumber(date: string): number`、`dateOfDay(n: number): string`（`packages/core/src/tasks/schedule.ts`）
- Produces（`packages/core/src/dashboard/metrics.ts`）:
  - `type StateCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'`；`type CategoryOf = (stateKey: string) => StateCategory`
  - `zonedDate(at: Date, timeZone: string): string`；`addDays(date: string, n: number): string`；`daysBetween(from: string, to: string): number`；`mondayOf(date: string): string`；`weeksBetween(from: string, to: string): string[]`
  - `quantile(values: number[], q: number): number | null`；`roundTo1(n: number): number`；`round1(n: number | null): number | null`；`ratio(n: number, d: number): number | null`（4 位小数）；`elapsedDays(from: Date, to: Date): number`（不小于 0）
  - `type RawTransition = { fromState: string | null; toState: string; at: Date }`；`type RawRequirement = { id: string; createdAt: Date; stateKey: string; transitions: RawTransition[] }`；`type FlowTransition = RawTransition & { date: string }`；`type FlowRequirement = { id: string; createdAt: Date; stateKey: string; transitions: FlowTransition[] }`
  - `prepareFlow(list: RawRequirement[], timeZone: string): FlowRequirement[]`；`stateAtEndOf(r: FlowRequirement, date: string): string | null`；`wipAt(reqs: FlowRequirement[], categoryOf: CategoryOf, date: string): number`
  - `type Completion = { requirementId: string; date: string; leadDays: number; flowDays: number | null }`；`completionOf(r, categoryOf): Completion | null`；`completionsOf(reqs, categoryOf): Completion[]`
  - `type FlowSummary = { completed: number; throughputPerWeek: number; leadMedian: number | null; leadP85: number | null; flowMedian: number | null; flowP85: number | null; wip: number }`；`flowSummary(reqs, completions, categoryOf, from, to): FlowSummary`
  - `type WeekPoint = { week: string; throughput: number; wip: number; leadP85: number | null; flowP85: number | null }`；`weeklySeries(reqs, completions, categoryOf, from, to): WeekPoint[]`
  - `type StuckState = { key: string; count: number; avgDays: number }`；`type StuckItem = { id: string; stateKey: string; days: number }`；`stuckNow(reqs, categoryOf, now: Date, limit = 10): { states: StuckState[]; oldest: StuckItem[] }`
  - 测试构造器（`packages/core/test/dashboard-fixtures.ts`）：`SH = 'Asia/Shanghai'`、`categoryOf: CategoryOf`（`backlog`、`todo` 未开始、`doing` / `testing` 进行中、`done` / `accepted` 已完成、`canceled` 已取消）、`req(id, created, steps): RawRequirement`

- [ ] **Step 1: 写测试构造器**

`packages/core/test/dashboard-fixtures.ts`：

```ts
import type { CategoryOf, RawRequirement, RawTransition, StateCategory } from '../src/dashboard/metrics';

export const SH = 'Asia/Shanghai';

const CATEGORY: Record<string, StateCategory> = {
  backlog: 'backlog',
  todo: 'unstarted',
  doing: 'started',
  testing: 'started',
  done: 'completed',
  accepted: 'completed',
  canceled: 'canceled',
};

/** 测试用的状态类别：两个进行中类（doing、testing）、两个完成类（done、accepted）。 */
export const categoryOf: CategoryOf = (key) => CATEGORY[key] ?? 'backlog';

/** 构造需求：created 为创建时刻，steps 为依次进入的状态与时刻（ISO，带时区）；当前状态为最后一步。 */
export function req(id: string, created: string, steps: Array<[string, string]>): RawRequirement {
  const transitions: RawTransition[] = [{ fromState: null, toState: 'backlog', at: new Date(created) }];
  let prev = 'backlog';
  for (const [to, when] of steps) {
    transitions.push({ fromState: prev, toState: to, at: new Date(when) });
    prev = to;
  }
  return { id, createdAt: new Date(created), stateKey: prev, transitions };
}
```

- [ ] **Step 2: 写失败的测试**

`packages/core/test/dashboard-metrics-flow.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  addDays,
  completionOf,
  completionsOf,
  flowSummary,
  mondayOf,
  prepareFlow,
  quantile,
  stateAtEndOf,
  stuckNow,
  weeklySeries,
  weeksBetween,
  wipAt,
  zonedDate,
} from '../src/dashboard/metrics';
import { categoryOf, req, SH } from './dashboard-fixtures';

describe('日期与周', () => {
  it('周从周一开始；跨月、跨年正确', () => {
    expect(mondayOf('2026-10-13')).toBe('2026-10-12');
    expect(mondayOf('2026-10-12')).toBe('2026-10-12');
    expect(mondayOf('2026-10-18')).toBe('2026-10-12');
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
    expect(weeksBetween('2026-09-30', '2026-10-13')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('时刻按组织时区换算日期', () => {
    expect(zonedDate(new Date('2026-10-11T17:30:00Z'), SH)).toBe('2026-10-12');
    expect(zonedDate(new Date('2026-10-11T17:30:00Z'), 'UTC')).toBe('2026-10-11');
  });
});

describe('分位数', () => {
  it('线性插值；没有数据为 null', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([5], 0.85)).toBe(5);
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.85)).toBeCloseTo(3.55);
  });
});

describe('流转整理', () => {
  it('同一时刻时创建记录在前；没有流转的需求补一条创建记录', () => {
    const same = new Date('2026-10-01T02:00:00Z');
    const [a, b] = prepareFlow(
      [
        {
          id: 'a',
          createdAt: same,
          stateKey: 'doing',
          transitions: [
            { fromState: 'backlog', toState: 'doing', at: same },
            { fromState: null, toState: 'backlog', at: same },
          ],
        },
        { id: 'b', createdAt: same, stateKey: 'doing', transitions: [] },
      ],
      SH,
    );
    expect(a!.transitions.map((t) => t.toState)).toEqual(['backlog', 'doing']);
    expect(stateAtEndOf(a!, '2026-10-01')).toBe('doing');
    expect(b!.transitions).toEqual([{ fromState: null, toState: 'doing', at: same, date: '2026-10-01' }]);
    expect(stateAtEndOf(b!, '2026-09-30')).toBeNull();
  });
});

describe('完成记录', () => {
  const list = prepareFlow(
    [
      // 完成后重新打开、再次完成：按最后一次进入完成类计；流动时间从第一次进入进行中算起
      req('r1', '2026-09-01T10:00:00+08:00', [
        ['doing', '2026-09-02T10:00:00+08:00'],
        ['done', '2026-09-05T10:00:00+08:00'],
        ['doing', '2026-09-08T10:00:00+08:00'],
        ['done', '2026-09-10T10:00:00+08:00'],
      ]),
      // 完成类之间的流转（已完成 → 已验收）不算新的完成
      req('r2', '2026-09-01T10:00:00+08:00', [
        ['doing', '2026-09-03T10:00:00+08:00'],
        ['done', '2026-09-06T10:00:00+08:00'],
        ['accepted', '2026-09-09T10:00:00+08:00'],
      ]),
      // 完成后重新打开且当前未完成：不计
      req('r3', '2026-09-01T10:00:00+08:00', [
        ['done', '2026-09-05T10:00:00+08:00'],
        ['doing', '2026-09-08T10:00:00+08:00'],
      ]),
      // 已取消：不算完成
      req('r4', '2026-09-01T10:00:00+08:00', [
        ['doing', '2026-09-02T10:00:00+08:00'],
        ['canceled', '2026-09-04T10:00:00+08:00'],
      ]),
      // 没有经过进行中：前置时间照算，流动时间为 null
      req('r5', '2026-09-01T10:00:00+08:00', [['done', '2026-09-04T10:00:00+08:00']]),
    ],
    SH,
  );

  it('按最后一次从非完成类进入完成类计；重新打开或取消的不计', () => {
    expect(completionOf(list[0]!, categoryOf)).toEqual({ requirementId: 'r1', date: '2026-09-10', leadDays: 9, flowDays: 8 });
    expect(completionOf(list[1]!, categoryOf)).toEqual({ requirementId: 'r2', date: '2026-09-06', leadDays: 5, flowDays: 3 });
    expect(completionOf(list[2]!, categoryOf)).toBeNull();
    expect(completionOf(list[3]!, categoryOf)).toBeNull();
    expect(completionOf(list[4]!, categoryOf)).toEqual({ requirementId: 'r5', date: '2026-09-04', leadDays: 3, flowDays: null });
    expect(completionsOf(list, categoryOf).map((c) => c.requirementId)).toEqual(['r1', 'r2', 'r5']);
  });
});

describe('在制品、周趋势与时间段汇总', () => {
  const raw = [
    req('A', '2026-09-28T10:00:00+08:00', [
      ['doing', '2026-09-29T10:00:00+08:00'],
      ['done', '2026-10-07T10:00:00+08:00'],
    ]),
    // 北京时间周一 00:30 进入进行中，UTC 仍是周日
    req('B', '2026-09-28T10:00:00+08:00', [['doing', '2026-10-05T00:30:00+08:00']]),
    req('C', '2026-10-06T10:00:00+08:00', [
      ['doing', '2026-10-06T11:00:00+08:00'],
      ['canceled', '2026-10-09T10:00:00+08:00'],
    ]),
    req('D', '2026-10-12T10:00:00+08:00', []),
  ];

  it('在制品按某天结束时的状态推算；跨时区边界按组织时区', () => {
    const sh = prepareFlow(raw, SH);
    expect(wipAt(sh, categoryOf, '2026-09-27')).toBe(0);
    expect(wipAt(sh, categoryOf, '2026-10-04')).toBe(1);
    expect(wipAt(sh, categoryOf, '2026-10-06')).toBe(3);
    expect(wipAt(sh, categoryOf, '2026-10-11')).toBe(1);
    expect(wipAt(prepareFlow(raw, 'UTC'), categoryOf, '2026-10-04')).toBe(2);
  });

  it('周趋势：每周吞吐量、周末在制品、当周完成需求的 85 分位；最后一周算到时间段最后一天', () => {
    const sh = prepareFlow(raw, SH);
    expect(weeklySeries(sh, completionsOf(sh, categoryOf), categoryOf, '2026-09-30', '2026-10-13')).toEqual([
      { week: '2026-09-28', throughput: 0, wip: 1, leadP85: null, flowP85: null },
      { week: '2026-10-05', throughput: 1, wip: 1, leadP85: 9, flowP85: 8 },
      { week: '2026-10-12', throughput: 0, wip: 1, leadP85: null, flowP85: null },
    ]);
  });

  it('时间段汇总：周均吞吐量、中位数与 85 分位、最后一天的在制品', () => {
    const sh = prepareFlow(raw, SH);
    const done = completionsOf(sh, categoryOf);
    expect(flowSummary(sh, done, categoryOf, '2026-09-30', '2026-10-13')).toEqual({
      completed: 1,
      throughputPerWeek: 0.5,
      leadMedian: 9,
      leadP85: 9,
      flowMedian: 8,
      flowP85: 8,
      wip: 1,
    });
    expect(flowSummary(sh, done, categoryOf, '2026-09-16', '2026-09-29')).toEqual({
      completed: 0,
      throughputPerWeek: 0,
      leadMedian: null,
      leadP85: null,
      flowMedian: null,
      flowP85: null,
      wip: 1,
    });
  });

  it('卡在哪儿：当前进行中类的需求按状态统计平均停留，停留最久的按天数倒序取前 N 条', () => {
    const list = prepareFlow(
      [
        ...raw,
        req('E', '2026-10-01T10:00:00+08:00', [
          ['doing', '2026-10-02T10:00:00+08:00'],
          ['testing', '2026-10-10T10:00:00+08:00'],
        ]),
        req('F', '2026-10-11T10:00:00+08:00', [['doing', '2026-10-12T10:00:00+08:00']]),
      ],
      SH,
    );
    const s = stuckNow(list, categoryOf, new Date('2026-10-13T10:00:00+08:00'), 2);
    expect(s.states).toEqual([
      { key: 'doing', count: 2, avgDays: 4.7 },
      { key: 'testing', count: 1, avgDays: 3 },
    ]);
    expect(s.oldest).toEqual([
      { id: 'B', stateKey: 'doing', days: 8.4 },
      { id: 'E', stateKey: 'testing', days: 3 },
    ]);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-metrics-flow.test.ts`
Expected: FAIL，`Cannot find module '../src/dashboard/metrics'`

- [ ] **Step 4: 写实现**

`packages/core/src/dashboard/metrics.ts`：

```ts
/**
 * 看板的流动指标（P3-B2）：日期与周的换算、分位数、需求完成记录、吞吐量、前置时间、流动时间、在制品与停留。
 * 纯函数，输入由 dashboard/flow.ts 从数据库读出，单测直接构造。日期一律为组织时区下的 YYYY-MM-DD，时刻为 Date。
 * 已删除的需求由调用方排除；「已取消」不算完成。
 */
import { dateOfDay, dayNumber } from '../tasks/schedule';

export type StateCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
export type CategoryOf = (stateKey: string) => StateCategory;

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** 时刻在某个时区里的日期（YYYY-MM-DD）。格式化器按时区缓存，避免逐条新建。 */
export function zonedDate(at: Date, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f.format(at);
}

export const addDays = (date: string, n: number): string => dateOfDay(dayNumber(date) + n);

/** to 减 from 的天数（同一天为 0）。 */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** 所在周的周一。dayNumber 为 0 的 1970-01-01 是周四，(n + 3) % 7 为以周一为 0 的星期序号。 */
export function mondayOf(date: string): string {
  const n = dayNumber(date);
  return dateOfDay(n - ((((n + 3) % 7) + 7) % 7));
}

/** from 到 to（都含）覆盖的每一周的周一，升序。 */
export function weeksBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const last = dayNumber(to);
  for (let d = dayNumber(mondayOf(from)); d <= last; d += 7) out.push(dateOfDay(d));
  return out;
}

/** 分位数，线性插值（与 Postgres 的 percentile_cont 相同）；没有数据时为 null。 */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const roundTo1 = (n: number): number => Math.round(n * 10) / 10;
export const round1 = (n: number | null): number | null => (n === null ? null : roundTo1(n));

/** 比例，保留 4 位小数；分母为 0 时为 null。 */
export const ratio = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10000) / 10000 : null);

/** 两个时刻之间的天数（可带小数），不小于 0。 */
export const elapsedDays = (from: Date, to: Date): number => Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);

export type RawTransition = { fromState: string | null; toState: string; at: Date };
export type RawRequirement = { id: string; createdAt: Date; stateKey: string; transitions: RawTransition[] };
export type FlowTransition = RawTransition & { date: string };
export type FlowRequirement = { id: string; createdAt: Date; stateKey: string; transitions: FlowTransition[] };

/**
 * 流转按时间升序排好并换算本地日期；同一时刻时创建记录（fromState 为空）在前。
 * 没有任何流转记录的需求补一条「创建时进入当前状态」，保证每条需求至少有一条。
 */
export function prepareFlow(list: RawRequirement[], timeZone: string): FlowRequirement[] {
  return list.map((r) => {
    const raw: RawTransition[] = r.transitions.length > 0 ? r.transitions : [{ fromState: null, toState: r.stateKey, at: r.createdAt }];
    const sorted = [...raw].sort((a, b) => a.at.getTime() - b.at.getTime() || Number(b.fromState === null) - Number(a.fromState === null));
    return { id: r.id, createdAt: r.createdAt, stateKey: r.stateKey, transitions: sorted.map((t) => ({ ...t, date: zonedDate(t.at, timeZone) })) };
  });
}

/** 某天结束时（组织时区）需求所处的状态；那天结束时还没有创建的为 null。 */
export function stateAtEndOf(r: FlowRequirement, date: string): string | null {
  let state: string | null = null;
  for (const t of r.transitions) {
    if (t.date > date) break;
    state = t.toState;
  }
  return state;
}

/** 某天结束时处于进行中类状态的需求数。 */
export function wipAt(reqs: FlowRequirement[], categoryOf: CategoryOf, date: string): number {
  let n = 0;
  for (const r of reqs) {
    const s = stateAtEndOf(r, date);
    if (s !== null && categoryOf(s) === 'started') n++;
  }
  return n;
}

export type Completion = { requirementId: string; date: string; leadDays: number; flowDays: number | null };

/**
 * 需求的完成记录：只对当前处于完成类的需求，取最后一次从非完成类（或创建）进入完成类的流转。
 * 前置时间从创建算起；流动时间从第一次进入进行中类算起，没有经过进行中的为 null。
 */
export function completionOf(r: FlowRequirement, categoryOf: CategoryOf): Completion | null {
  if (categoryOf(r.stateKey) !== 'completed') return null;
  let entry: FlowTransition | null = null;
  let firstStarted: Date | null = null;
  for (const t of r.transitions) {
    const to = categoryOf(t.toState);
    if (to === 'started' && firstStarted === null) firstStarted = t.at;
    if (to === 'completed' && (t.fromState === null || categoryOf(t.fromState) !== 'completed')) entry = t;
  }
  if (!entry) return null;
  return {
    requirementId: r.id,
    date: entry.date,
    leadDays: elapsedDays(r.createdAt, entry.at),
    flowDays: firstStarted && firstStarted.getTime() <= entry.at.getTime() ? elapsedDays(firstStarted, entry.at) : null,
  };
}

export function completionsOf(reqs: FlowRequirement[], categoryOf: CategoryOf): Completion[] {
  const out: Completion[] = [];
  for (const r of reqs) {
    const c = completionOf(r, categoryOf);
    if (c) out.push(c);
  }
  return out;
}

const inRange = (c: Completion, from: string, to: string) => c.date >= from && c.date <= to;
const flowDaysOf = (list: Completion[]): number[] => list.flatMap((c) => (c.flowDays === null ? [] : [c.flowDays]));

export type FlowSummary = {
  completed: number;
  throughputPerWeek: number;
  leadMedian: number | null;
  leadP85: number | null;
  flowMedian: number | null;
  flowP85: number | null;
  wip: number;
};

/** 时间段汇总：完成数、周均吞吐量（完成数 × 7 ÷ 天数）、前置与流动时间的中位数和 85 分位、最后一天结束时的在制品。 */
export function flowSummary(reqs: FlowRequirement[], completions: Completion[], categoryOf: CategoryOf, from: string, to: string): FlowSummary {
  const done = completions.filter((c) => inRange(c, from, to));
  const lead = done.map((c) => c.leadDays);
  const flow = flowDaysOf(done);
  const days = daysBetween(from, to) + 1;
  return {
    completed: done.length,
    throughputPerWeek: roundTo1((done.length * 7) / days),
    leadMedian: round1(quantile(lead, 0.5)),
    leadP85: round1(quantile(lead, 0.85)),
    flowMedian: round1(quantile(flow, 0.5)),
    flowP85: round1(quantile(flow, 0.85)),
    wip: wipAt(reqs, categoryOf, to),
  };
}

export type WeekPoint = { week: string; throughput: number; wip: number; leadP85: number | null; flowP85: number | null };

/** 周趋势：每周（周一开始）的完成数、周日结束时的在制品（最后一周取时间段最后一天）、当周完成需求的 85 分位。 */
export function weeklySeries(reqs: FlowRequirement[], completions: Completion[], categoryOf: CategoryOf, from: string, to: string): WeekPoint[] {
  const byWeek = new Map<string, Completion[]>();
  for (const c of completions) {
    if (!inRange(c, from, to)) continue;
    const w = mondayOf(c.date);
    byWeek.set(w, [...(byWeek.get(w) ?? []), c]);
  }
  return weeksBetween(from, to).map((week) => {
    const sunday = addDays(week, 6);
    const mine = byWeek.get(week) ?? [];
    return {
      week,
      throughput: mine.length,
      wip: wipAt(reqs, categoryOf, sunday < to ? sunday : to),
      leadP85: round1(quantile(mine.map((c) => c.leadDays), 0.85)),
      flowP85: round1(quantile(flowDaysOf(mine), 0.85)),
    };
  });
}

export type StuckState = { key: string; count: number; avgDays: number };
export type StuckItem = { id: string; stateKey: string; days: number };

/** 当前处于进行中类状态的需求：按具体状态统计数量与平均停留天数（自最后一次流转起，降序），以及停留最久的前 limit 条。 */
export function stuckNow(reqs: FlowRequirement[], categoryOf: CategoryOf, now: Date, limit = 10): { states: StuckState[]; oldest: StuckItem[] } {
  const items: Array<{ id: string; stateKey: string; raw: number }> = [];
  for (const r of reqs) {
    if (categoryOf(r.stateKey) !== 'started') continue;
    const last = r.transitions.at(-1);
    items.push({ id: r.id, stateKey: r.stateKey, raw: elapsedDays(last ? last.at : r.createdAt, now) });
  }
  const groups = new Map<string, number[]>();
  for (const i of items) groups.set(i.stateKey, [...(groups.get(i.stateKey) ?? []), i.raw]);
  const states = [...groups.entries()]
    .map(([key, days]) => ({ key, count: days.length, avgDays: roundTo1(days.reduce((a, b) => a + b, 0) / days.length) }))
    .sort((a, b) => b.avgDays - a.avgDays || a.key.localeCompare(b.key));
  const oldest = [...items]
    .sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((i) => ({ id: i.id, stateKey: i.stateKey, days: roundTo1(i.raw) }));
  return { states, oldest };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-metrics-flow.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 6: 类型检查并提交**

Run: `pnpm --filter @flower/core typecheck`
Expected: 无错误

```bash
git add packages/core/src/dashboard/metrics.ts packages/core/test/dashboard-fixtures.ts packages/core/test/dashboard-metrics-flow.test.ts
git commit -m "feat(core): 看板流动指标的纯函数（周与时区、分位数、完成记录、吞吐量、在制品、停留）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 交付与评审指标的纯函数（版本按期、迭代承诺、专项、评审效率与驳回率）

**Files:**
- Create: `packages/core/src/dashboard/delivery-metrics.ts`
- Test: `packages/core/test/dashboard-metrics-delivery.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CategoryOf`、`FlowRequirement`、`daysBetween`、`elapsedDays`、`quantile`、`ratio`、`round1`、`stateAtEndOf`、`zonedDate`、`prepareFlow`；测试构造器 `categoryOf`、`req`、`SH`
- Produces（`packages/core/src/dashboard/delivery-metrics.ts`）:
  - `type ReleaseFact = { id: string; versionName: string; status: 'planned' | 'released'; plannedDate: string | null; baselineDate: string | null; releasedAt: Date | null; iterationEndDate: string | null }`
  - `type DueSource = 'baseline' | 'planned' | 'iteration'`；`type ReleaseRow = { id; versionName; status; plannedDate; dueDate: string | null; dueSource: DueSource | null; releasedOn: string | null; onTime: boolean | null; overdueDays: number | null }`；`type ReleaseSummary = { released: number; evaluated: number; onTime: number; onTimeRate: number | null; rows: ReleaseRow[] }`；`releaseSummary(list, from, to, today, timeZone): ReleaseSummary`
  - `type IterationFact = { id; name; startDate; endDate; status: 'active' | 'done'; committedIds: string[]; currentIds: string[] }`；`type IterationRow = { id; name; startDate; endDate; status: 'active' | 'done'; cutoff: string; hasSnapshot: boolean; committed: number; completed: number; canceled: number; rate: number | null; added: number; removed: number }`；`iterationCommitment(it, byId: Map<string, FlowRequirement>, categoryOf, today): IterationRow`
  - `type SpecialStatus = 'planning' | 'active' | 'done' | 'canceled'`；`type SpecialFact = { id; name; startDate; endDate; status: SpecialStatus; stateKeys: string[] }`；`type SpecialRow = { id; name; startDate; endDate; status; total; completed; canceled; rate: number | null }`；`specialCompletion(s, categoryOf): SpecialRow`
  - `type ReviewEventFact = { subjectType: string; subjectId: string; itemKey: string; type: string; newState: string | null; decision: string | null; at: Date }`；`type ReviewItemRow = { itemKey; passed: number; medianDays: number | null; concluded: number; rejected: number; rejectionRate: number | null }`；`type ReviewSummary = { since: string | null; concluded; rejected; rejectionRate: number | null; items: ReviewItemRow[] }`；`reviewSummary(events, from, to, timeZone): ReviewSummary`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/dashboard-metrics-delivery.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  iterationCommitment,
  type ReleaseFact,
  releaseSummary,
  type ReviewEventFact,
  reviewSummary,
  specialCompletion,
} from '../src/dashboard/delivery-metrics';
import { prepareFlow } from '../src/dashboard/metrics';
import { categoryOf, req, SH } from './dashboard-fixtures';

const rel = (id: string, patch: Partial<ReleaseFact>): ReleaseFact => ({
  id,
  versionName: id,
  status: 'released',
  plannedDate: null,
  baselineDate: null,
  releasedAt: null,
  iterationEndDate: null,
  ...patch,
});

describe('版本按期达成率', () => {
  it('基线日期优先，没有时用所属迭代结束日；未发布的按计划日判断是否已逾期；两者都没有的不进分母', () => {
    const list = [
      rel('v1', { baselineDate: '2026-09-25', plannedDate: '2026-09-25', releasedAt: new Date('2026-09-24T02:00:00Z') }),
      rel('v2', { iterationEndDate: '2026-09-27', releasedAt: new Date('2026-09-28T17:00:00Z') }),
      rel('v3', { baselineDate: '2026-09-01', releasedAt: new Date('2026-09-10T00:00:00Z') }),
      rel('v4', { releasedAt: new Date('2026-09-20T02:00:00Z') }),
      rel('v5', { status: 'planned', plannedDate: '2026-10-10', baselineDate: '2026-10-10' }),
      rel('v6', { status: 'planned', iterationEndDate: '2026-10-20' }),
      rel('v7', { status: 'planned' }),
      rel('v8', { baselineDate: '2026-09-25' }),
    ];
    const s = releaseSummary(list, '2026-09-15', '2026-10-13', '2026-10-13', SH);
    expect(s).toMatchObject({ released: 3, evaluated: 2, onTime: 1, onTimeRate: 0.5 });
    expect(s.rows.map((r) => [r.id, r.dueDate, r.dueSource, r.releasedOn, r.onTime, r.overdueDays])).toEqual([
      ['v5', '2026-10-10', 'planned', null, null, 3],
      ['v6', '2026-10-20', 'iteration', null, null, 0],
      ['v7', null, null, null, null, null],
      ['v2', '2026-09-27', 'iteration', '2026-09-29', false, 2],
      ['v1', '2026-09-25', 'baseline', '2026-09-24', true, 0],
      ['v4', null, null, '2026-09-20', null, null],
    ]);
  });

  it('发布日按组织时区；没有可判断的已发布版本时按期率为 null', () => {
    const late = [rel('v', { baselineDate: '2026-09-28', releasedAt: new Date('2026-09-28T17:00:00Z') })];
    expect(releaseSummary(late, '2026-09-01', '2026-09-30', '2026-10-13', SH).rows[0]).toMatchObject({ releasedOn: '2026-09-29', onTime: false, overdueDays: 1 });
    expect(releaseSummary(late, '2026-09-01', '2026-09-30', '2026-10-13', 'UTC').rows[0]).toMatchObject({ releasedOn: '2026-09-28', onTime: true, overdueDays: 0 });
    expect(releaseSummary([rel('v4', { releasedAt: new Date('2026-09-20T02:00:00Z') })], '2026-09-01', '2026-09-30', '2026-10-13', SH).onTimeRate).toBeNull();
  });
});

describe('迭代承诺完成率', () => {
  const flow = prepareFlow(
    [
      req('c1', '2026-08-25T10:00:00+08:00', [
        ['doing', '2026-09-05T10:00:00+08:00'],
        ['done', '2026-09-20T10:00:00+08:00'],
      ]),
      req('c2', '2026-08-25T10:00:00+08:00', [['doing', '2026-09-05T10:00:00+08:00']]),
      req('c3', '2026-08-25T10:00:00+08:00', [['canceled', '2026-09-25T10:00:00+08:00']]),
      req('c4', '2026-08-25T10:00:00+08:00', [
        ['doing', '2026-09-10T10:00:00+08:00'],
        ['done', '2026-10-05T10:00:00+08:00'],
      ]),
      req('a1', '2026-09-10T10:00:00+08:00', [['done', '2026-09-28T10:00:00+08:00']]),
    ],
    SH,
  );
  const byId = new Map(flow.map((r) => [r.id, r]));
  // gone 是已删除的需求（读取时已排除，不在 byId 里）
  const base = { id: 'it1', name: '第 1 轮', startDate: '2026-09-01', endDate: '2026-09-30', committedIds: ['c1', 'c2', 'c3', 'c4', 'gone'], currentIds: ['c1', 'c3', 'c4', 'a1'] };

  it('快照内需求在结束日结束时完成的比例；已取消不进分母；已删除的不计；列出中途加入与移出', () => {
    expect(iterationCommitment({ ...base, status: 'done' }, byId, categoryOf, '2026-10-13')).toEqual({
      id: 'it1',
      name: '第 1 轮',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      status: 'done',
      cutoff: '2026-09-30',
      hasSnapshot: true,
      committed: 4,
      completed: 1,
      canceled: 1,
      rate: 0.3333,
      added: 1,
      removed: 1,
    });
  });

  it('进行中的迭代计到今天；没有快照的迭代承诺完成率为 null', () => {
    expect(iterationCommitment({ ...base, status: 'active' }, byId, categoryOf, '2026-10-13')).toMatchObject({ cutoff: '2026-10-13', completed: 2, rate: 0.6667 });
    expect(iterationCommitment({ ...base, status: 'done', committedIds: [] }, byId, categoryOf, '2026-10-13')).toMatchObject({
      hasSnapshot: false,
      committed: 0,
      completed: 0,
      rate: null,
      added: 4,
      removed: 0,
    });
  });
});

describe('专项完成率', () => {
  it('完成数 ÷（总数 − 已取消数）；全部取消时为 null', () => {
    const s = { id: 's', name: '专项甲', startDate: '2026-09-01', endDate: '2026-12-31', status: 'active' as const };
    expect(specialCompletion({ ...s, stateKeys: ['done', 'doing', 'canceled', 'accepted'] }, categoryOf)).toEqual({ ...s, total: 4, completed: 2, canceled: 1, rate: 0.6667 });
    expect(specialCompletion({ ...s, stateKeys: ['canceled'] }, categoryOf).rate).toBeNull();
  });
});

describe('评审效率与驳回率', () => {
  const ev = (
    subjectId: string,
    itemKey: string,
    type: 'check_item.updated' | 'check_item.signed',
    newState: string | null,
    at: string,
    decision: string | null = null,
    subjectType = 'requirement',
  ): ReviewEventFact => ({ subjectType, subjectId, itemKey, type, newState, decision, at: new Date(at) });
  const events = [
    // r1 可行性：09-10 开始评审，09-16 驳回，09-20 通过（先驳回后通过，计为驳回过）
    ev('r1', 'feasibility', 'check_item.updated', 'in_progress', '2026-09-10T10:00:00+08:00'),
    ev('r1', 'feasibility', 'check_item.updated', 'rejected', '2026-09-16T10:00:00+08:00'),
    ev('r1', 'feasibility', 'check_item.updated', 'passed', '2026-09-20T10:00:00+08:00'),
    // r2 可行性：直接通过，评审 0 天
    ev('r2', 'feasibility', 'check_item.updated', 'passed', '2026-09-18T10:00:00+08:00'),
    // r3 设计签字：09-01 被驳回（时间段外），09-17 另一人签通过但结论不变，09-22 改签后通过
    ev('r3', 'design', 'check_item.signed', 'rejected', '2026-09-01T10:00:00+08:00', 'rejected'),
    ev('r3', 'design', 'check_item.signed', null, '2026-09-17T10:00:00+08:00', 'passed'),
    ev('r3', 'design', 'check_item.signed', 'passed', '2026-09-22T10:00:00+08:00', 'passed'),
    // PRD 上的检查项：驳回
    ev('d1', 'prd_review', 'check_item.signed', 'rejected', '2026-10-01T10:00:00+08:00', 'rejected', 'document'),
    // 只开始、没有结论
    ev('r4', 'feasibility', 'check_item.updated', 'in_progress', '2026-10-02T10:00:00+08:00'),
  ];

  it('按检查项列出评审天数中位数与驳回率；统计起点为最早一条事件的日期', () => {
    expect(reviewSummary(events, '2026-09-15', '2026-10-13', SH)).toEqual({
      since: '2026-09-01',
      concluded: 4,
      rejected: 2,
      rejectionRate: 0.5,
      items: [
        { itemKey: 'design', passed: 1, medianDays: 21, concluded: 1, rejected: 0, rejectionRate: 0 },
        { itemKey: 'feasibility', passed: 2, medianDays: 5, concluded: 2, rejected: 1, rejectionRate: 0.5 },
        { itemKey: 'prd_review', passed: 0, medianDays: null, concluded: 1, rejected: 1, rejectionRate: 1 },
      ],
    });
  });

  it('时间段按组织时区划分；先驳回后通过的计为驳回过', () => {
    const edge = [ev('d1', 'prd_review', 'check_item.signed', 'rejected', '2026-09-30T16:30:00Z', 'rejected', 'document')];
    expect(reviewSummary(edge, '2026-09-15', '2026-09-30', SH).concluded).toBe(0);
    expect(reviewSummary(edge, '2026-09-15', '2026-09-30', 'UTC').concluded).toBe(1);
    expect(reviewSummary(events.slice(0, 3), '2026-09-15', '2026-10-13', SH).items).toEqual([
      { itemKey: 'feasibility', passed: 1, medianDays: 10, concluded: 1, rejected: 1, rejectionRate: 1 },
    ]);
  });

  it('没有评审事件时统计起点与比例为 null', () => {
    expect(reviewSummary([], '2026-09-15', '2026-10-13', SH)).toEqual({ since: null, concluded: 0, rejected: 0, rejectionRate: null, items: [] });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-metrics-delivery.test.ts`
Expected: FAIL，`Cannot find module '../src/dashboard/delivery-metrics'`

- [ ] **Step 3: 写实现**

`packages/core/src/dashboard/delivery-metrics.ts`：

```ts
/**
 * 看板的交付与评审指标（P3-B2）：版本按期达成、迭代承诺完成、专项完成、评审效率与驳回率。
 * 纯函数，输入由 dashboard/delivery.ts 与 dashboard/review.ts 从数据库读出，单测直接构造。
 */
import { type CategoryOf, daysBetween, elapsedDays, type FlowRequirement, quantile, ratio, round1, stateAtEndOf, zonedDate } from './metrics';

export type ReleaseFact = {
  id: string;
  versionName: string;
  status: 'planned' | 'released';
  plannedDate: string | null;
  baselineDate: string | null;
  releasedAt: Date | null;
  /** 所属迭代（未删除）的结束日；没有所属迭代时为 null。 */
  iterationEndDate: string | null;
};
export type DueSource = 'baseline' | 'planned' | 'iteration';
export type ReleaseRow = {
  id: string;
  versionName: string;
  status: 'planned' | 'released';
  plannedDate: string | null;
  dueDate: string | null;
  dueSource: DueSource | null;
  releasedOn: string | null;
  onTime: boolean | null;
  overdueDays: number | null;
};
export type ReleaseSummary = { released: number; evaluated: number; onTime: number; onTimeRate: number | null; rows: ReleaseRow[] };

function dueOf(primary: string | null, source: DueSource, iterationEnd: string | null): { dueDate: string | null; dueSource: DueSource | null } {
  if (primary) return { dueDate: primary, dueSource: source };
  if (iterationEnd) return { dueDate: iterationEnd, dueSource: 'iteration' };
  return { dueDate: null, dueSource: null };
}

/**
 * 版本按期：时间段内（发布日按组织时区）已发布的版本，到期日为基线日期，没有时用所属迭代结束日；
 * 两者都没有的不进分母。计划中的版本全部列出，到期日为计划日期（没有时用所属迭代结束日），逾期天数算到今天。
 * 行顺序：计划中的按到期日升序在前，已发布的按发布日倒序在后。
 */
export function releaseSummary(list: ReleaseFact[], from: string, to: string, today: string, timeZone: string): ReleaseSummary {
  const released: ReleaseRow[] = [];
  const pending: ReleaseRow[] = [];
  for (const r of list) {
    const base = { id: r.id, versionName: r.versionName, status: r.status, plannedDate: r.plannedDate };
    if (r.status === 'released') {
      if (!r.releasedAt) continue;
      const releasedOn = zonedDate(r.releasedAt, timeZone);
      if (releasedOn < from || releasedOn > to) continue;
      const due = dueOf(r.baselineDate, 'baseline', r.iterationEndDate);
      released.push({
        ...base,
        ...due,
        releasedOn,
        onTime: due.dueDate === null ? null : releasedOn <= due.dueDate,
        overdueDays: due.dueDate === null ? null : Math.max(0, daysBetween(due.dueDate, releasedOn)),
      });
    } else {
      const due = dueOf(r.plannedDate, 'planned', r.iterationEndDate);
      pending.push({ ...base, ...due, releasedOn: null, onTime: null, overdueDays: due.dueDate === null ? null : Math.max(0, daysBetween(due.dueDate, today)) });
    }
  }
  pending.sort((a, b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || a.versionName.localeCompare(b.versionName));
  released.sort((a, b) => b.releasedOn!.localeCompare(a.releasedOn!) || a.versionName.localeCompare(b.versionName));
  const evaluated = released.filter((r) => r.onTime !== null);
  const onTime = evaluated.filter((r) => r.onTime).length;
  return { released: released.length, evaluated: evaluated.length, onTime, onTimeRate: ratio(onTime, evaluated.length), rows: [...pending, ...released] };
}

export type IterationFact = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'done';
  /** 承诺范围快照里的需求（可能含已删除的）。 */
  committedIds: string[];
  /** 当前在迭代里的未删除需求。 */
  currentIds: string[];
};
export type IterationRow = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'done';
  cutoff: string;
  hasSnapshot: boolean;
  committed: number;
  completed: number;
  canceled: number;
  rate: number | null;
  added: number;
  removed: number;
};

/**
 * 迭代承诺完成率：快照内未删除的需求在截止日（已完成的迭代为结束日，进行中的为今天）结束时处于完成类的比例，
 * 已取消的不进分母；没有快照时为 null。中途加入 = 当前在迭代里但不在快照里；移出 = 在快照里、当前不在迭代里。
 */
export function iterationCommitment(it: IterationFact, byId: Map<string, FlowRequirement>, categoryOf: CategoryOf, today: string): IterationRow {
  const cutoff = it.status === 'active' ? today : it.endDate;
  const committedSet = new Set(it.committedIds);
  const current = new Set(it.currentIds);
  const committed = it.committedIds.map((id) => byId.get(id)).filter((r): r is FlowRequirement => r !== undefined);
  let completed = 0;
  let canceled = 0;
  for (const r of committed) {
    const s = stateAtEndOf(r, cutoff);
    const c = s === null ? null : categoryOf(s);
    if (c === 'completed') completed++;
    else if (c === 'canceled') canceled++;
  }
  const hasSnapshot = it.committedIds.length > 0;
  return {
    id: it.id,
    name: it.name,
    startDate: it.startDate,
    endDate: it.endDate,
    status: it.status,
    cutoff,
    hasSnapshot,
    committed: committed.length,
    completed,
    canceled,
    rate: hasSnapshot ? ratio(completed, committed.length - canceled) : null,
    added: it.currentIds.filter((id) => !committedSet.has(id)).length,
    removed: committed.filter((r) => !current.has(r.id)).length,
  };
}

export type SpecialStatus = 'planning' | 'active' | 'done' | 'canceled';
export type SpecialFact = { id: string; name: string; startDate: string; endDate: string; status: SpecialStatus; stateKeys: string[] };
export type SpecialRow = { id: string; name: string; startDate: string; endDate: string; status: SpecialStatus; total: number; completed: number; canceled: number; rate: number | null };

/** 专项完成率：完成数 ÷（总数 − 已取消数）；stateKeys 只含本产品未删除的需求。 */
export function specialCompletion(s: SpecialFact, categoryOf: CategoryOf): SpecialRow {
  const cats = s.stateKeys.map(categoryOf);
  const completed = cats.filter((c) => c === 'completed').length;
  const canceled = cats.filter((c) => c === 'canceled').length;
  return { id: s.id, name: s.name, startDate: s.startDate, endDate: s.endDate, status: s.status, total: cats.length, completed, canceled, rate: ratio(completed, cats.length - canceled) };
}

export type ReviewEventFact = {
  subjectType: string;
  subjectId: string;
  itemKey: string;
  type: string;
  /** 本次事件把检查项状态改成的值；没有改变状态时为 null。 */
  newState: string | null;
  /** 签字事件的结论（passed / rejected）；普通检查项为 null。 */
  decision: string | null;
  at: Date;
};
export type ReviewItemRow = { itemKey: string; passed: number; medianDays: number | null; concluded: number; rejected: number; rejectionRate: number | null };
export type ReviewSummary = { since: string | null; concluded: number; rejected: number; rejectionRate: number | null; items: ReviewItemRow[] };

/**
 * 评审效率与驳回率，按（对象、检查项）分组计算，再按检查项汇总：
 * - 开始评审：第一条离开「未开始」或第一次签字的事件；评审天数：开始到最后一次变为「通过」（最终状态须为通过），按通过日落在时间段内统计；
 * - 有结论：时间段内有变为通过或驳回、或签字结论为驳回的事件；驳回过：其中出现过驳回（先驳回后通过的也算）。
 * 统计起点为最早一条事件的日期。
 */
export function reviewSummary(events: ReviewEventFact[], from: string, to: string, timeZone: string): ReviewSummary {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const groups = new Map<string, ReviewEventFact[]>();
  for (const e of sorted) {
    const key = `${e.subjectType}:${e.subjectId}:${e.itemKey}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const inWindow = (at: Date) => {
    const d = zonedDate(at, timeZone);
    return d >= from && d <= to;
  };
  const acc = new Map<string, { days: number[]; concluded: number; rejected: number }>();
  for (const list of groups.values()) {
    let start: Date | null = null;
    let passedAt: Date | null = null;
    let finalState: string | null = null;
    let concluded = false;
    let rejected = false;
    for (const e of list) {
      if (start === null && (e.type === 'check_item.signed' || (e.newState !== null && e.newState !== 'not_started'))) start = e.at;
      if (e.newState !== null) {
        finalState = e.newState;
        if (e.newState === 'passed') passedAt = e.at;
      }
      const rejectedHere = e.newState === 'rejected' || e.decision === 'rejected';
      if (inWindow(e.at) && (rejectedHere || e.newState === 'passed')) {
        concluded = true;
        if (rejectedHere) rejected = true;
      }
    }
    const itemKey = list[0]!.itemKey;
    const a = acc.get(itemKey) ?? { days: [], concluded: 0, rejected: 0 };
    if (finalState === 'passed' && passedAt && start && inWindow(passedAt)) a.days.push(elapsedDays(start, passedAt));
    if (concluded) a.concluded++;
    if (rejected) a.rejected++;
    if (a.days.length > 0 || a.concluded > 0) acc.set(itemKey, a);
  }
  const items = [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([itemKey, a]) => ({
      itemKey,
      passed: a.days.length,
      medianDays: round1(quantile(a.days, 0.5)),
      concluded: a.concluded,
      rejected: a.rejected,
      rejectionRate: ratio(a.rejected, a.concluded),
    }));
  const concluded = items.reduce((n, i) => n + i.concluded, 0);
  const rejected = items.reduce((n, i) => n + i.rejected, 0);
  return { since: sorted.length > 0 ? zonedDate(sorted[0]!.at, timeZone) : null, concluded, rejected, rejectionRate: ratio(rejected, concluded), items };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-metrics-delivery.test.ts test/dashboard-metrics-flow.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查并提交**

Run: `pnpm --filter @flower/core typecheck`
Expected: 无错误

```bash
git add packages/core/src/dashboard/delivery-metrics.ts packages/core/test/dashboard-metrics-delivery.test.ts
git commit -m "feat(core): 看板交付与评审指标的纯函数（版本按期、迭代承诺、专项、评审效率与驳回率）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: 读取需求与流转（组织时区、产品流程的状态类别）

**Files:**
- Create: `packages/core/src/dashboard/flow.ts`
- Create: `packages/core/test/dashboard-helpers.ts`
- Test: `packages/core/test/dashboard-flow.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `prepareFlow`、`CategoryOf`、`FlowRequirement`、`RawTransition`、`StateCategory`；`DEFAULT_TIMEZONE`（`packages/core/src/tasks/tasks.ts`，值为 `'Asia/Shanghai'`）；表 `organizations`、`products`、`workflowVersions`、`requirements`、`stateTransitions`
- Produces（`packages/core/src/dashboard/flow.ts`）:
  - `orgTimeZone(tx: Tx, orgId: string): Promise<string>`：组织时区，未设置或无效时为 `'Asia/Shanghai'`
  - `type StateMeta = { key: string; label: string; color: string; category: StateCategory }`
  - `type RequirementMeta = { id: string; number: number; title: string; stateKey: string; iterationId: string | null }`
  - `type ProductFlow = { productKey: string; states: StateMeta[]; categoryOf: CategoryOf; checkItems: Array<{ key: string; label: string }>; requirements: FlowRequirement[]; meta: Map<string, RequirementMeta> }`
  - `loadProductFlow(tx: Tx, productId: string, timeZone: string): Promise<ProductFlow>`：只含未删除的需求；产品没有流程时 `states` 为空、所有状态按 `backlog`
  - 测试辅助（`packages/core/test/dashboard-helpers.ts`）：`rewriteHistory(adminDb: Db, orgId: string, requirementId: string, created: string, steps: Array<[string, string]>): Promise<void>`——用管理员连接删掉需求原有流转，按 `created` 与 `steps` 重写，并同步需求的 `state_key`、`created_at`、`state_changed_at`

- [ ] **Step 1: 写测试辅助**

`packages/core/test/dashboard-helpers.ts`：

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { requirements, stateTransitions } from '../src/db/schema';

/**
 * 用管理员连接改写需求的流转历史：先删除原有流转，再写入「created 时创建于 backlog」与 steps 里依次进入的状态，
 * 并把需求的当前状态、创建时间、状态变更时间同步为最后一步。时刻用 ISO 字符串（带时区）。
 */
export async function rewriteHistory(adminDb: Db, orgId: string, requirementId: string, created: string, steps: Array<[string, string]>): Promise<void> {
  const rows: Array<{ fromState: string | null; toState: string; at: Date }> = [{ fromState: null, toState: 'backlog', at: new Date(created) }];
  let prev = 'backlog';
  for (const [to, when] of steps) {
    rows.push({ fromState: prev, toState: to, at: new Date(when) });
    prev = to;
  }
  await adminDb.delete(stateTransitions).where(eq(stateTransitions.requirementId, requirementId));
  await adminDb.insert(stateTransitions).values(rows.map((r) => ({ orgId, requirementId, ...r })));
  await adminDb
    .update(requirements)
    .set({ stateKey: prev, createdAt: new Date(created), stateChangedAt: rows.at(-1)!.at })
    .where(eq(requirements.id, requirementId));
}
```

- [ ] **Step 2: 写失败的测试**

`packages/core/test/dashboard-flow.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProductFlow, orgTimeZone } from '../src/dashboard/flow';
import { organizations, products, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { rewriteHistory } from './dashboard-helpers';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let bare: string;
let r1: string;
let r2: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  bare = (await createProduct(t.db, owner, { name: '无流程', key: 'BARE' })).id;
  await t.adminDb.update(products).set({ workflowVersionId: null }).where(eq(products.id, bare));
  r1 = (await createRequirement(t.db, owner, pan, { title: '需求一' })).id;
  r2 = (await createRequirement(t.db, owner, pan, { title: '需求二' })).id;
  const r3 = (await createRequirement(t.db, owner, pan, { title: '已删除的需求' })).id;
  // 北京时间 09-03 00:30 进入进行中，UTC 仍是 09-02
  await rewriteHistory(t.adminDb, owner.orgId, r1, '2026-09-01T10:00:00+08:00', [
    ['doing', '2026-09-03T00:30:00+08:00'],
    ['done', '2026-09-05T10:00:00+08:00'],
  ]);
  await t.adminDb.update(requirements).set({ deletedAt: new Date() }).where(eq(requirements.id, r3));
});
afterAll(() => t.cleanup());

describe('读取需求与流转', () => {
  it('只读出本产品未删除的需求与其流转；状态类别按产品流程，未知状态按 backlog', async () => {
    const flow = await withOrg(t.db, owner.orgId, (tx) => loadProductFlow(tx, pan, 'Asia/Shanghai'));
    expect(flow.productKey).toBe('PAN');
    expect(flow.states.map((s) => [s.key, s.category])).toEqual([
      ['backlog', 'backlog'],
      ['todo', 'unstarted'],
      ['doing', 'started'],
      ['done', 'completed'],
      ['canceled', 'canceled'],
    ]);
    expect(flow.categoryOf('doing')).toBe('started');
    expect(flow.categoryOf('missing')).toBe('backlog');
    expect(flow.requirements.map((r) => r.id).sort()).toEqual([r1, r2].sort());
    const one = flow.requirements.find((r) => r.id === r1)!;
    expect(one.stateKey).toBe('done');
    expect(one.transitions.map((x) => [x.toState, x.date])).toEqual([
      ['backlog', '2026-09-01'],
      ['doing', '2026-09-03'],
      ['done', '2026-09-05'],
    ]);
    expect(flow.requirements.find((r) => r.id === r2)!.transitions.map((x) => x.toState)).toEqual(['backlog']);
    expect(flow.meta.get(r1)).toEqual({ id: r1, number: 1, title: '需求一', stateKey: 'done', iterationId: null });
    expect(flow.checkItems).toEqual([]);
  });

  it('日期按传入的时区换算', async () => {
    const flow = await withOrg(t.db, owner.orgId, (tx) => loadProductFlow(tx, pan, 'UTC'));
    expect(flow.requirements.find((r) => r.id === r1)!.transitions[1]!.date).toBe('2026-09-02');
  });

  it('产品没有流程时状态为空，所有状态按 backlog', async () => {
    const flow = await withOrg(t.db, owner.orgId, (tx) => loadProductFlow(tx, bare, 'Asia/Shanghai'));
    expect(flow.states).toEqual([]);
    expect(flow.categoryOf('done')).toBe('backlog');
    expect(flow.requirements).toEqual([]);
  });

  it('组织时区：未设置或无效时为 Asia/Shanghai，设置后按设置', async () => {
    const tz = () => withOrg(t.db, owner.orgId, (tx) => orgTimeZone(tx, owner.orgId));
    expect(await tz()).toBe('Asia/Shanghai');
    await t.adminDb.update(organizations).set({ settings: { timezone: 'America/New_York' } }).where(eq(organizations.id, owner.orgId));
    expect(await tz()).toBe('America/New_York');
    await t.adminDb.update(organizations).set({ settings: { timezone: 'Mars/Base' } }).where(eq(organizations.id, owner.orgId));
    expect(await tz()).toBe('Asia/Shanghai');
    await t.adminDb.update(organizations).set({ settings: {} }).where(eq(organizations.id, owner.orgId));
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-flow.test.ts`
Expected: FAIL，`Cannot find module '../src/dashboard/flow'`

- [ ] **Step 4: 写实现**

`packages/core/src/dashboard/flow.ts`：

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { organizations, products, requirements, stateTransitions, workflowVersions } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import { DEFAULT_TIMEZONE } from '../tasks/tasks';
import { type CategoryOf, type FlowRequirement, prepareFlow, type RawTransition, type StateCategory } from './metrics';

export type StateMeta = { key: string; label: string; color: string; category: StateCategory };
export type RequirementMeta = { id: string; number: number; title: string; stateKey: string; iterationId: string | null };
export type ProductFlow = {
  productKey: string;
  states: StateMeta[];
  categoryOf: CategoryOf;
  checkItems: Array<{ key: string; label: string }>;
  requirements: FlowRequirement[];
  meta: Map<string, RequirementMeta>;
};

/** 组织时区；没有设置或设置无效（Intl 不认识）时用默认时区 Asia/Shanghai，不让看板因此报错。 */
export async function orgTimeZone(tx: Tx, orgId: string): Promise<string> {
  const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const tz = org?.settings.timezone;
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * 读取产品的看板基础数据：当前流程的状态（类别）与检查项、未删除的需求及其全部流转（换算为组织时区的日期）。
 * 产品没有流程时状态为空，所有状态按 backlog 计。调用方已确认操作者能看到该产品。
 */
export async function loadProductFlow(tx: Tx, productId: string, timeZone: string): Promise<ProductFlow> {
  const [product] = await tx
    .select({ key: products.key, body: workflowVersions.body })
    .from(products)
    .leftJoin(workflowVersions, eq(workflowVersions.id, products.workflowVersionId))
    .where(eq(products.id, productId));
  const body = (product?.body ?? null) as WorkflowBody | null;
  const states: StateMeta[] = (body?.states ?? []).map((s) => ({ key: s.key, label: s.label, color: s.color, category: s.category }));
  const categoryByKey = new Map(states.map((s) => [s.key, s.category]));
  const categoryOf: CategoryOf = (key) => categoryByKey.get(key) ?? 'backlog';

  const live = and(eq(requirements.productId, productId), isNull(requirements.deletedAt));
  const rows = await tx
    .select({
      id: requirements.id,
      number: requirements.number,
      title: requirements.title,
      stateKey: requirements.stateKey,
      iterationId: requirements.iterationId,
      createdAt: requirements.createdAt,
    })
    .from(requirements)
    .where(live);
  const transitions =
    rows.length > 0
      ? await tx
          .select({ requirementId: stateTransitions.requirementId, fromState: stateTransitions.fromState, toState: stateTransitions.toState, at: stateTransitions.at })
          .from(stateTransitions)
          .innerJoin(requirements, eq(requirements.id, stateTransitions.requirementId))
          .where(live)
      : [];
  const byRequirement = new Map<string, RawTransition[]>();
  for (const t of transitions) {
    const list = byRequirement.get(t.requirementId);
    const item = { fromState: t.fromState, toState: t.toState, at: t.at };
    if (list) list.push(item);
    else byRequirement.set(t.requirementId, [item]);
  }
  return {
    productKey: product?.key ?? '',
    states,
    categoryOf,
    checkItems: (body?.checkItems ?? []).map((c) => ({ key: c.key, label: c.label })),
    requirements: prepareFlow(
      rows.map((r) => ({ id: r.id, createdAt: r.createdAt, stateKey: r.stateKey, transitions: byRequirement.get(r.id) ?? [] })),
      timeZone,
    ),
    meta: new Map(rows.map((r) => [r.id, { id: r.id, number: r.number, title: r.title, stateKey: r.stateKey, iterationId: r.iterationId }])),
  };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-flow.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 6: 类型检查并提交**

Run: `pnpm --filter @flower/core typecheck`
Expected: 无错误

```bash
git add packages/core/src/dashboard/flow.ts packages/core/test/dashboard-helpers.ts packages/core/test/dashboard-flow.test.ts
git commit -m "feat(core): 看板读取产品需求与流转、组织时区

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 读取版本、迭代、专项与可选迭代

**Files:**
- Create: `packages/core/src/dashboard/delivery.ts`
- Test: `packages/core/test/dashboard-delivery.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ReleaseFact`、`IterationFact`、`SpecialFact`；Task 3 的 `ProductFlow`、`loadProductFlow`；`IterationStatus`（`packages/core/src/iterations/iterations.ts`）；表 `releases`、`iterations`、`iterationScopeSnapshots`
- Produces（`packages/core/src/dashboard/delivery.ts`）:
  - `type IterationOption = { id: string; name: string; startDate: string; endDate: string; status: IterationStatus }`
  - `loadReleaseFacts(tx: Tx, productId: string): Promise<ReleaseFact[]>`：本产品全部版本，带所属迭代（未删除）的结束日
  - `loadIterationFacts(tx: Tx, productId: string, flow: ProductFlow, from: string, to: string): Promise<IterationFact[]>`：本产品与时间段有交集、状态为进行中或已完成的常规迭代，开始日倒序；带 `committed` 快照与当前范围（取自 `flow.meta`）
  - `loadSpecialFacts(tx: Tx, flow: ProductFlow, from: string, to: string): Promise<SpecialFact[]>`：与时间段有交集的专项，只带本产品未删除需求的状态，不含本产品需求的专项不返回
  - `loadIterationOptions(tx: Tx, productId: string, today: string): Promise<IterationOption[]>`：本产品已开始（开始日不晚于今天）、未取消、未删除的常规迭代，开始日倒序

- [ ] **Step 1: 写失败的测试**

`packages/core/test/dashboard-delivery.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadIterationFacts, loadIterationOptions, loadReleaseFacts, loadSpecialFacts } from '../src/dashboard/delivery';
import { loadProductFlow } from '../src/dashboard/flow';
import { iterations } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { createRelease } from '../src/releases/releases';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { regularIteration, seedInstance } from './factories';

const SH = 'Asia/Shanghai';
let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let r1: string;
let r2: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  r1 = (await createRequirement(t.db, owner, pan, { title: '需求一' })).id;
  r2 = (await createRequirement(t.db, owner, pan, { title: '需求二' })).id;
  const r3 = (await createRequirement(t.db, owner, pan, { title: '专项里的需求' })).id;
  const x = (await createRequirement(t.db, owner, doc, { title: '文档需求甲' })).id;
  const y = (await createRequirement(t.db, owner, doc, { title: '文档需求乙' })).id;

  // 第 0 轮：开始时为空，没有承诺范围快照
  const it0 = (await createIteration(t.db, owner, regularIteration(pan, '第 0 轮', '2026-08-01', '2026-08-20'))).id;
  await setIterationStatus(t.db, owner, it0, 'active');
  await setIterationStatus(t.db, owner, it0, 'done');
  // 第 1 轮：r1、r2 在开始前加入（进入快照），结束后 r2 被移出
  const it1 = (await createIteration(t.db, owner, regularIteration(pan, '第 1 轮', '2026-09-01', '2026-09-30'))).id;
  await setRequirementIteration(t.db, owner, r1, { iterationId: it1 });
  await setRequirementIteration(t.db, owner, r2, { iterationId: it1 });
  await setIterationStatus(t.db, owner, it1, 'active');
  await setIterationStatus(t.db, owner, it1, 'done');
  await setRequirementIteration(t.db, owner, r2, { iterationId: null });
  // 第 2 轮：规划中（已到开始日）；已取消的一轮；别的产品的一轮
  await createIteration(t.db, owner, regularIteration(pan, '第 2 轮', '2026-10-01', '2026-10-20'));
  const canceled = (await createIteration(t.db, owner, regularIteration(pan, '已取消', '2026-06-01', '2026-06-10'))).id;
  await setIterationStatus(t.db, owner, canceled, 'canceled');
  const docIt = (await createIteration(t.db, owner, regularIteration(doc, '文档 1 轮', '2026-09-01', '2026-09-30'))).id;
  await setIterationStatus(t.db, owner, docIt, 'active');
  // 专项甲含 PAN 的 r3 与 DOC 的 x；专项乙只含 DOC 的 y
  const sp = (await createIteration(t.db, owner, { type: 'special', name: '专项甲', startDate: '2026-09-01', endDate: '2026-12-31' })).id;
  await setRequirementIteration(t.db, owner, r3, { iterationId: sp });
  await setRequirementIteration(t.db, owner, x, { iterationId: sp });
  const sp2 = (await createIteration(t.db, owner, { type: 'special', name: '专项乙', startDate: '2026-09-01', endDate: '2026-12-31' })).id;
  await setRequirementIteration(t.db, owner, y, { iterationId: sp2 });

  // 版本：v1 不属于迭代；v2 属于第 1 轮；v3 属于一个之后被删除的迭代
  await createRelease(t.db, owner, { productId: pan, versionName: 'v1', plannedDate: '2026-09-25' });
  await createRelease(t.db, owner, { productId: pan, versionName: 'v2', iterationId: it1, plannedDate: '2026-09-30' });
  const temp = (await createIteration(t.db, owner, regularIteration(pan, '临时', '2026-07-01', '2026-07-10'))).id;
  await createRelease(t.db, owner, { productId: pan, versionName: 'v3', iterationId: temp, plannedDate: '2026-07-10' });
  await t.adminDb.update(iterations).set({ deletedAt: new Date() }).where(eq(iterations.id, temp));
});
afterAll(() => t.cleanup());

describe('读取版本、迭代与专项', () => {
  it('版本：带出所属迭代的结束日；迭代已删除或没有迭代时为空', async () => {
    const facts = await withOrg(t.db, owner.orgId, (tx) => loadReleaseFacts(tx, pan));
    expect(facts.map((f) => [f.versionName, f.status, f.plannedDate, f.baselineDate, f.releasedAt, f.iterationEndDate]).sort()).toEqual([
      ['v1', 'planned', '2026-09-25', '2026-09-25', null, null],
      ['v2', 'planned', '2026-09-30', '2026-09-30', null, '2026-09-30'],
      ['v3', 'planned', '2026-07-10', '2026-07-10', null, null],
    ]);
  });

  it('迭代：只取本产品与时间段有交集、已开始（进行中或已完成）的常规迭代，带承诺范围与当前范围', async () => {
    const facts = await withOrg(t.db, owner.orgId, async (tx) => loadIterationFacts(tx, pan, await loadProductFlow(tx, pan, SH), '2026-07-16', '2026-10-13'));
    expect(facts.map((f) => ({ name: f.name, status: f.status, committed: [...f.committedIds].sort(), current: f.currentIds }))).toEqual([
      { name: '第 1 轮', status: 'done', committed: [r1, r2].sort(), current: [r1] },
      { name: '第 0 轮', status: 'done', committed: [], current: [] },
    ]);
  });

  it('专项：只取含本产品需求的专项，只带本产品需求的状态', async () => {
    const facts = await withOrg(t.db, owner.orgId, async (tx) => loadSpecialFacts(tx, await loadProductFlow(tx, pan, SH), '2026-07-16', '2026-10-13'));
    expect(facts.map((s) => [s.name, s.status, s.stateKeys])).toEqual([['专项甲', 'planning', ['backlog']]]);
  });

  it('可选迭代：本产品已到开始日、未取消、未删除的常规迭代，开始日倒序', async () => {
    const options = await withOrg(t.db, owner.orgId, (tx) => loadIterationOptions(tx, pan, '2026-10-13'));
    expect(options.map((o) => [o.name, o.status])).toEqual([
      ['第 2 轮', 'planning'],
      ['第 1 轮', 'done'],
      ['第 0 轮', 'done'],
    ]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-delivery.test.ts`
Expected: FAIL，`Cannot find module '../src/dashboard/delivery'`

- [ ] **Step 3: 写实现**

`packages/core/src/dashboard/delivery.ts`：

```ts
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import { iterationScopeSnapshots, iterations, releases } from '../db/schema';
import type { Tx } from '../db/tx';
import type { IterationStatus } from '../iterations/iterations';
import type { IterationFact, ReleaseFact, SpecialFact } from './delivery-metrics';
import type { ProductFlow } from './flow';

export type IterationOption = { id: string; name: string; startDate: string; endDate: string; status: IterationStatus };

const iterationColumns = { id: iterations.id, name: iterations.name, startDate: iterations.startDate, endDate: iterations.endDate, status: iterations.status };

/** 本产品的全部发布版本；所属迭代未删除时带出它的结束日（版本没有基线日期时用它判断是否按期）。 */
export async function loadReleaseFacts(tx: Tx, productId: string): Promise<ReleaseFact[]> {
  return tx
    .select({
      id: releases.id,
      versionName: releases.versionName,
      status: releases.status,
      plannedDate: releases.plannedDate,
      baselineDate: releases.baselineDate,
      releasedAt: releases.releasedAt,
      iterationEndDate: iterations.endDate,
    })
    .from(releases)
    .leftJoin(iterations, and(eq(iterations.id, releases.iterationId), isNull(iterations.deletedAt)))
    .where(eq(releases.productId, productId));
}

/** 本产品与时间段有交集、已开始（进行中或已完成）的常规迭代，开始日倒序；带承诺范围快照与当前范围。 */
export async function loadIterationFacts(tx: Tx, productId: string, flow: ProductFlow, from: string, to: string): Promise<IterationFact[]> {
  const rows = await tx
    .select(iterationColumns)
    .from(iterations)
    .where(
      and(
        eq(iterations.productId, productId),
        eq(iterations.type, 'regular'),
        isNull(iterations.deletedAt),
        inArray(iterations.status, ['active', 'done']),
        lte(iterations.startDate, to),
        gte(iterations.endDate, from),
      ),
    )
    .orderBy(desc(iterations.startDate));
  if (rows.length === 0) return [];
  const snaps = await tx
    .select({ iterationId: iterationScopeSnapshots.iterationId, requirementId: iterationScopeSnapshots.requirementId })
    .from(iterationScopeSnapshots)
    .where(and(inArray(iterationScopeSnapshots.iterationId, rows.map((r) => r.id)), eq(iterationScopeSnapshots.snapshotKind, 'committed')));
  const metas = [...flow.meta.values()];
  return rows.map((r) => ({
    ...r,
    status: r.status as 'active' | 'done',
    committedIds: snaps.filter((s) => s.iterationId === r.id).map((s) => s.requirementId),
    currentIds: metas.filter((m) => m.iterationId === r.id).map((m) => m.id),
  }));
}

/** 与时间段有交集的专项（专项属于组织）；只带本产品未删除需求的状态，不含本产品需求的专项不返回。 */
export async function loadSpecialFacts(tx: Tx, flow: ProductFlow, from: string, to: string): Promise<SpecialFact[]> {
  const rows = await tx
    .select(iterationColumns)
    .from(iterations)
    .where(and(eq(iterations.type, 'special'), isNull(iterations.deletedAt), lte(iterations.startDate, to), gte(iterations.endDate, from)))
    .orderBy(desc(iterations.startDate), asc(iterations.name));
  const metas = [...flow.meta.values()];
  return rows
    .map((r) => ({ ...r, stateKeys: metas.filter((m) => m.iterationId === r.id).map((m) => m.stateKey) }))
    .filter((s) => s.stateKeys.length > 0);
}

/** 「按迭代」可选的迭代：本产品已到开始日、未取消、未删除的常规迭代，开始日倒序。 */
export async function loadIterationOptions(tx: Tx, productId: string, today: string): Promise<IterationOption[]> {
  return tx
    .select(iterationColumns)
    .from(iterations)
    .where(
      and(
        eq(iterations.productId, productId),
        eq(iterations.type, 'regular'),
        isNull(iterations.deletedAt),
        ne(iterations.status, 'canceled'),
        lte(iterations.startDate, today),
      ),
    )
    .orderBy(desc(iterations.startDate));
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-delivery.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 类型检查并提交**

Run: `pnpm --filter @flower/core typecheck`
Expected: 无错误

```bash
git add packages/core/src/dashboard/delivery.ts packages/core/test/dashboard-delivery.test.ts
git commit -m "feat(core): 看板读取版本、迭代承诺范围、专项与可选迭代

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 读取检查项领域事件

**Files:**
- Create: `packages/core/src/dashboard/review.ts`
- Test: `packages/core/test/dashboard-review.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ReviewEventFact`；Task 3 的 `loadProductFlow`；表 `domainEvents`、`documents`；事件 `check_item.updated`（payload `{ itemKey, changes: [{ field, old, new }], auto?, documentId? }`）与 `check_item.signed`（payload `{ itemKey, ruleIndex, decision, onBehalf, changes }`，`changes` 在结论不变时为空），见 `packages/core/src/requirements/transitions.ts`、`packages/core/src/documents/checks.ts`、`packages/core/src/documents/coverage.ts`
- Produces（`packages/core/src/dashboard/review.ts`）:
  - `stateChangeOf(payload: Record<string, unknown>): string | null`
  - `loadReviewEvents(tx: Tx, productId: string, requirementIds: Set<string>): Promise<ReviewEventFact[]>`：本产品的检查项事件，按时间升序；对象为已删除的需求或 PRD 的不返回

- [ ] **Step 1: 写失败的测试**

`packages/core/test/dashboard-review.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProductFlow } from '../src/dashboard/flow';
import { loadReviewEvents, stateChangeOf } from '../src/dashboard/review';
import { requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { createRequirement } from '../src/requirements/requirements';
import { setCheckItemState, signCheckItem } from '../src/requirements/transitions';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { setMemberFunctionTags } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, reviewWorkflow, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let q1: string;
let q2: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  const designer = await asMember(t.db, owner, '设计师甲');
  await setMemberFunctionTags(t.db, owner, designer.memberId, [designTag]);
  const boss = await asMember(t.db, owner, '老板乙');
  const { version } = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  await setProductWorkflowVersion(t.db, owner, doc, version.id);
  q1 = (await createRequirement(t.db, owner, pan, { title: '需求一' })).id;
  q2 = (await createRequirement(t.db, owner, pan, { title: '需求二' })).id;
  const q3 = (await createRequirement(t.db, owner, pan, { title: '之后删除的需求' })).id;
  const o1 = (await createRequirement(t.db, owner, doc, { title: '文档需求' })).id;
  await setCheckItemState(t.db, owner, q1, 'feasibility', { state: 'rejected' });
  await setCheckItemState(t.db, owner, q1, 'feasibility', { state: 'passed', note: '补充了数据' });
  // 两条签字规则只签了一条：状态从未开始变为评审中
  await signCheckItem(t.db, designer, q1, 'design', { decision: 'passed' });
  await setCheckItemState(t.db, owner, q2, 'prd', { state: 'not_needed' });
  await setCheckItemState(t.db, owner, q3, 'feasibility', { state: 'passed' });
  await setCheckItemState(t.db, owner, o1, 'feasibility', { state: 'passed' });
  await t.adminDb.update(requirements).set({ deletedAt: new Date() }).where(eq(requirements.id, q3));
});
afterAll(() => t.cleanup());

describe('读取检查项事件', () => {
  it('只读本产品、对象未删除的检查项事件，按时间升序，带出状态新值与签字结论', async () => {
    const events = await withOrg(t.db, owner.orgId, async (tx) => loadReviewEvents(tx, pan, new Set((await loadProductFlow(tx, pan, 'Asia/Shanghai')).meta.keys())));
    const name = (id: string) => (id === q1 ? 'q1' : id === q2 ? 'q2' : id);
    expect(events.map((e) => [name(e.subjectId), e.subjectType, e.itemKey, e.type, e.newState, e.decision])).toEqual([
      ['q1', 'requirement', 'feasibility', 'check_item.updated', 'rejected', null],
      ['q1', 'requirement', 'feasibility', 'check_item.updated', 'passed', null],
      ['q1', 'requirement', 'design', 'check_item.signed', 'in_progress', 'passed'],
      ['q2', 'requirement', 'prd', 'check_item.updated', 'not_needed', null],
    ]);
  });

  it('状态新值只取 field 为 state 的变化', () => {
    expect(stateChangeOf({ changes: [{ field: 'state', old: 'not_started', new: 'passed' }] })).toBe('passed');
    expect(stateChangeOf({ changes: [{ field: 'note', old: null, new: '说明' }] })).toBeNull();
    expect(stateChangeOf({ changes: [] })).toBeNull();
    expect(stateChangeOf({})).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-review.test.ts`
Expected: FAIL，`Cannot find module '../src/dashboard/review'`

- [ ] **Step 3: 写实现**

`packages/core/src/dashboard/review.ts`：

```ts
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { documents, domainEvents } from '../db/schema';
import type { Tx } from '../db/tx';
import type { ReviewEventFact } from './delivery-metrics';

const REVIEW_EVENT_TYPES = ['check_item.updated', 'check_item.signed'];

/** 事件 payload 里检查项状态的新值（changes 中 field 为 state 的 new）；没有改变状态的事件为 null。 */
export function stateChangeOf(payload: Record<string, unknown>): string | null {
  const changes = Array.isArray(payload.changes) ? (payload.changes as unknown[]) : [];
  for (const c of changes) {
    if (c && typeof c === 'object' && (c as { field?: unknown }).field === 'state') {
      const value = (c as { new?: unknown }).new;
      return typeof value === 'string' ? value : null;
    }
  }
  return null;
}

/**
 * 本产品的检查项事件（需求与 PRD 上的，含跟随 PRD 状态的自动更新），按发生时间升序。
 * 只保留对象仍存在的：需求须在 requirementIds（本产品未删除的需求）里，PRD 须未删除。
 * 迁移来的旧事件类型为 legacy.*，不在这里统计。
 */
export async function loadReviewEvents(tx: Tx, productId: string, requirementIds: Set<string>): Promise<ReviewEventFact[]> {
  const rows = await tx
    .select({ type: domainEvents.type, subjectType: domainEvents.subjectType, subjectId: domainEvents.subjectId, payload: domainEvents.payload, occurredAt: domainEvents.occurredAt })
    .from(domainEvents)
    .where(and(eq(domainEvents.productId, productId), inArray(domainEvents.type, REVIEW_EVENT_TYPES)))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));
  if (rows.length === 0) return [];
  const docs = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.productId, productId), isNull(documents.deletedAt)));
  const liveDocuments = new Set(docs.map((d) => d.id));
  const out: ReviewEventFact[] = [];
  for (const e of rows) {
    const live = e.subjectType === 'requirement' ? requirementIds.has(e.subjectId) : e.subjectType === 'document' && liveDocuments.has(e.subjectId);
    const itemKey = typeof e.payload.itemKey === 'string' ? e.payload.itemKey : null;
    if (!live || !itemKey) continue;
    out.push({
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      itemKey,
      type: e.type,
      newState: stateChangeOf(e.payload),
      decision: typeof e.payload.decision === 'string' ? e.payload.decision : null,
      at: e.occurredAt,
    });
  }
  return out;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard-review.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 类型检查并提交**

Run: `pnpm --filter @flower/core typecheck`
Expected: 无错误

```bash
git add packages/core/src/dashboard/review.ts packages/core/test/dashboard-review.test.ts
git commit -m "feat(core): 看板读取检查项领域事件

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 看板服务（时间段解析、产品看板、组织汇总、可见性）

**Files:**
- Create: `packages/core/src/dashboard/dashboard.ts`
- Modify: `packages/core/src/index.ts`（在 `export * from './workbench/workbench';` 之后加一行）
- Test: `packages/core/test/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 1–5 的全部导出；`requireProductRole`、`visibleProductIds`（`access/permissions.ts`）；`assertIsoDate`（`dates.ts`）；`displayKey`（`requirements/requirements.ts`）；`IterationStatus`（`iterations/iterations.ts`）
- Produces（`packages/core/src/dashboard/dashboard.ts`，从 `@flower/core` 导出）:
  - `DASHBOARD_RANGE_DAYS = [30, 90, 180] as const`；`DASHBOARD_MAX_DAYS = 366`
  - `type DashboardRange = { kind: 'days'; days: 30 | 90 | 180 } | { kind: 'custom'; from: string; to: string } | { kind: 'iteration'; iterationId: string }`
  - `type DashboardWindow = { from: string; to: string; days: number; previousFrom: string; previousTo: string; today: string; timeZone: string; iteration: { id: string; name: string } | null }`
  - `type MetricPair = { value: number | null; previous: number | null }`
  - `type DashboardCards = { throughputPerWeek: MetricPair; leadTimeMedian: MetricPair; flowTimeMedian: MetricPair; wip: MetricPair; releaseOnTimeRate: MetricPair; rejectionRate: MetricPair }`
  - `type StateView = { key: string; label: string; color: string }`
  - `type ProductDashboard = { product: { id: string; key: string; name: string }; window: DashboardWindow; iterationOptions: IterationOption[]; cards: DashboardCards; completedCount: number; weeks: WeekPoint[]; stuck: { states: Array<StateView & { count: number; avgDays: number }>; oldest: Array<{ id: string; displayKey: string; title: string; state: StateView; days: number }> }; iterations: IterationRow[]; releases: ReleaseSummary; specials: SpecialRow[]; review: { since: string | null; concluded: number; rejected: number; rejectionRate: number | null; items: Array<ReviewItemRow & { label: string }> } }`
  - `type OrgDashboard = { window: DashboardWindow; products: Array<{ id: string; key: string; name: string; cards: DashboardCards; completedCount: number }> }`
  - `canViewOrgDashboard(actor: Actor): boolean`
  - `getProductDashboard(db: Db, actor: Actor, productId: string, input: { range: DashboardRange; now?: Date }): Promise<ProductDashboard>`
  - `getOrgDashboard(db: Db, actor: Actor, input: { range: DashboardRange; now?: Date }): Promise<OrgDashboard>`
  - 错误：`invalid`「时间段只能是近 30、90 或 180 天」「开始日期格式应为 YYYY-MM-DD」「结束日期格式应为 YYYY-MM-DD」「结束日期不能早于开始日期」「结束日期不能晚于今天」「自定义时间段不超过 366 天」「迭代还没有开始」「组织汇总不支持按迭代查看」；`not_found`「产品不存在」「迭代不存在」；`forbidden`「需要组织管理员权限」

- [ ] **Step 1: 写失败的测试**

`packages/core/test/dashboard.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canViewOrgDashboard, type DashboardRange, getOrgDashboard, getProductDashboard } from '../src/dashboard/dashboard';
import { releases } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { createRelease, markReleaseReleased } from '../src/releases/releases';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { rewriteHistory } from './dashboard-helpers';
import { createTestDb } from './db';
import { asMember, readOnlyToken, regularIteration, seedInstance } from './factories';

/** 组织时区 Asia/Shanghai 的 2026-10-13 12:00。 */
const NOW = new Date('2026-10-13T04:00:00Z');
const R90: DashboardRange = { kind: 'days', days: 90 };
const d = (local: string) => `${local}T10:00:00+08:00`;

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let doc: string;
let empty: string;
let it1: string;
let it2: string;
let docIteration: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  empty = (await createProduct(t.db, owner, { name: '空产品', key: 'EMP' })).id;
  const ids: string[] = [];
  for (const title of ['已完成一', '已完成二', '进行中', '上期完成', '已取消']) ids.push((await createRequirement(t.db, owner, pan, { title })).id);
  const [a, b, c, prev, canceled] = ids as [string, string, string, string, string];
  const x = (await createRequirement(t.db, owner, doc, { title: '文档需求' })).id;

  // 第 1 轮：a、b 在开始前加入并进入承诺范围，之后结束
  it1 = (await createIteration(t.db, owner, regularIteration(pan, '第 1 轮', '2026-09-01', '2026-09-30'))).id;
  await setRequirementIteration(t.db, owner, a, { iterationId: it1 });
  await setRequirementIteration(t.db, owner, b, { iterationId: it1 });
  await setIterationStatus(t.db, owner, it1, 'active');
  await setIterationStatus(t.db, owner, it1, 'done');
  it2 = (await createIteration(t.db, owner, regularIteration(pan, '第 2 轮', '2026-11-01', '2026-11-30'))).id;
  docIteration = (await createIteration(t.db, owner, regularIteration(doc, '文档 1 轮', '2026-09-01', '2026-09-30'))).id;
  // 专项：PAN 的 c 与 DOC 的 x
  const sp = (await createIteration(t.db, owner, { type: 'special', name: '专项甲', startDate: '2026-09-01', endDate: '2026-12-31' })).id;
  await setRequirementIteration(t.db, owner, c, { iterationId: sp });
  await setRequirementIteration(t.db, owner, x, { iterationId: sp });

  await rewriteHistory(t.adminDb, owner.orgId, a, d('2026-09-01'), [['doing', d('2026-09-10')], ['done', d('2026-09-20')]]);
  await rewriteHistory(t.adminDb, owner.orgId, b, d('2026-09-20'), [['doing', d('2026-09-25')], ['done', d('2026-10-05')]]);
  await rewriteHistory(t.adminDb, owner.orgId, c, d('2026-08-01'), [['doing', d('2026-08-10')]]);
  await rewriteHistory(t.adminDb, owner.orgId, prev, d('2026-06-01'), [['doing', d('2026-06-05')], ['done', d('2026-06-20')]]);
  await rewriteHistory(t.adminDb, owner.orgId, canceled, d('2026-09-01'), [['canceled', d('2026-09-03')]]);
  await rewriteHistory(t.adminDb, owner.orgId, x, d('2026-09-01'), [['done', d('2026-09-02')]]);

  // 版本：v1 按基线日期（09-25）按期；v2 没有基线日期，按第 1 轮结束日（09-30）计，10-02 发布，逾期 2 天
  const v1 = (await createRelease(t.db, owner, { productId: pan, versionName: 'v1', plannedDate: '2026-09-25' })).id;
  const v2 = (await createRelease(t.db, owner, { productId: pan, versionName: 'v2', iterationId: it1, plannedDate: '2026-09-30' })).id;
  await markReleaseReleased(t.db, owner, v1);
  await markReleaseReleased(t.db, owner, v2);
  await t.adminDb.update(releases).set({ releasedAt: new Date('2026-09-24T02:00:00Z') }).where(eq(releases.id, v1));
  await t.adminDb.update(releases).set({ releasedAt: new Date(d('2026-10-02')), baselineDate: null }).where(eq(releases.id, v2));
});
afterAll(() => t.cleanup());

describe('产品看板', () => {
  it('近 90 天：时间段与上期、关键数字、周趋势、卡在哪儿、迭代、版本、专项、评审', async () => {
    const dash = await getProductDashboard(t.db, owner, pan, { range: R90, now: NOW });
    expect(dash.product).toEqual({ id: pan, key: 'PAN', name: '网盘' });
    expect(dash.window).toEqual({
      from: '2026-07-16',
      to: '2026-10-13',
      days: 90,
      previousFrom: '2026-04-17',
      previousTo: '2026-07-15',
      today: '2026-10-13',
      timeZone: 'Asia/Shanghai',
      iteration: null,
    });
    expect(dash.cards).toEqual({
      throughputPerWeek: { value: 0.2, previous: 0.1 },
      leadTimeMedian: { value: 17, previous: 19 },
      flowTimeMedian: { value: 10, previous: 15 },
      wip: { value: 1, previous: 0 },
      releaseOnTimeRate: { value: 0.5, previous: null },
      rejectionRate: { value: null, previous: null },
    });
    expect(dash.completedCount).toBe(2);
    expect(dash.weeks).toHaveLength(14);
    expect(dash.weeks[0]!.week).toBe('2026-07-13');
    expect(dash.weeks.reduce((n, w) => n + w.throughput, 0)).toBe(2);
    expect(dash.weeks.at(-1)).toMatchObject({ week: '2026-10-12', wip: 1 });
    expect(dash.stuck.states).toEqual([{ key: 'doing', label: '进行中', color: '#f59e0b', count: 1, avgDays: 64.1 }]);
    expect(dash.stuck.oldest).toMatchObject([{ displayKey: 'PAN-3', title: '进行中', state: { key: 'doing', label: '进行中' }, days: 64.1 }]);
    expect(dash.iterations).toMatchObject([{ id: it1, name: '第 1 轮', hasSnapshot: true, committed: 2, completed: 1, canceled: 0, rate: 0.5, added: 0, removed: 0 }]);
    expect(dash.releases).toMatchObject({ released: 2, evaluated: 2, onTime: 1, onTimeRate: 0.5 });
    expect(dash.releases.rows.map((r) => [r.versionName, r.dueSource, r.releasedOn, r.onTime, r.overdueDays])).toEqual([
      ['v2', 'iteration', '2026-10-02', false, 2],
      ['v1', 'baseline', '2026-09-24', true, 0],
    ]);
    expect(dash.specials).toMatchObject([{ name: '专项甲', total: 1, completed: 0, canceled: 0, rate: 0 }]);
    expect(dash.review).toEqual({ since: null, concluded: 0, rejected: 0, rejectionRate: null, items: [] });
    expect(dash.iterationOptions.map((o) => o.name)).toEqual(['第 1 轮']);
    expect(JSON.stringify(dash)).not.toContain('文档需求');
  });

  it('按迭代：时间段为迭代的开始日到结束日（不晚于今天），上期为之前同长度的时间段', async () => {
    const dash = await getProductDashboard(t.db, owner, pan, { range: { kind: 'iteration', iterationId: it1 }, now: NOW });
    expect(dash.window).toMatchObject({ from: '2026-09-01', to: '2026-09-30', days: 30, previousFrom: '2026-08-02', previousTo: '2026-08-31', iteration: { id: it1, name: '第 1 轮' } });
    expect(dash.cards.throughputPerWeek).toEqual({ value: 0.2, previous: 0 });
  });

  it('自定义时间段', async () => {
    const dash = await getProductDashboard(t.db, owner, pan, { range: { kind: 'custom', from: '2026-10-01', to: '2026-10-13' }, now: NOW });
    expect(dash.window).toMatchObject({ from: '2026-10-01', to: '2026-10-13', days: 13 });
    expect(dash.cards.throughputPerWeek.value).toBe(0.5);
  });

  it('时间段参数不合法时给出中文原因', async () => {
    const bad = (range: DashboardRange) => getProductDashboard(t.db, owner, pan, { range, now: NOW });
    await expect(bad({ kind: 'days', days: 45 } as unknown as DashboardRange)).rejects.toMatchObject({ code: 'invalid', message: '时间段只能是近 30、90 或 180 天' });
    await expect(bad({ kind: 'custom', from: '2026-02-30', to: '2026-10-13' })).rejects.toMatchObject({ code: 'invalid', message: '开始日期格式应为 YYYY-MM-DD' });
    await expect(bad({ kind: 'custom', from: '2026-10-05', to: '2026-10-01' })).rejects.toMatchObject({ code: 'invalid', message: '结束日期不能早于开始日期' });
    await expect(bad({ kind: 'custom', from: '2026-10-01', to: '2026-10-14' })).rejects.toMatchObject({ code: 'invalid', message: '结束日期不能晚于今天' });
    await expect(bad({ kind: 'custom', from: '2025-01-01', to: '2026-10-13' })).rejects.toMatchObject({ code: 'invalid', message: '自定义时间段不超过 366 天' });
    await expect(bad({ kind: 'iteration', iterationId: it2 })).rejects.toMatchObject({ code: 'invalid', message: '迭代还没有开始' });
    await expect(bad({ kind: 'iteration', iterationId: docIteration })).rejects.toMatchObject({ code: 'not_found', message: '迭代不存在' });
  });

  it('空产品：各区块为空，没有数据的卡片与上期为 null，周趋势为 0', async () => {
    const dash = await getProductDashboard(t.db, owner, empty, { range: R90, now: NOW });
    expect(dash.cards).toEqual({
      throughputPerWeek: { value: null, previous: null },
      leadTimeMedian: { value: null, previous: null },
      flowTimeMedian: { value: null, previous: null },
      wip: { value: null, previous: null },
      releaseOnTimeRate: { value: null, previous: null },
      rejectionRate: { value: null, previous: null },
    });
    expect(dash.weeks.every((w) => w.throughput === 0 && w.wip === 0 && w.leadP85 === null)).toBe(true);
    expect(dash.stuck).toEqual({ states: [], oldest: [] });
    expect(dash.iterations).toEqual([]);
    expect(dash.releases.rows).toEqual([]);
    expect(dash.specials).toEqual([]);
    expect(dash.iterationOptions).toEqual([]);
  });

  it('能看到产品的成员都可以查看：访客只能看被授权的产品，只读 Token 可以调用', async () => {
    const guest = await asMember(t.db, owner, '访客甲', 'guest');
    await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
    expect((await getProductDashboard(t.db, guest, pan, { range: R90, now: NOW })).product.key).toBe('PAN');
    await expect(getProductDashboard(t.db, guest, doc, { range: R90, now: NOW })).rejects.toMatchObject({ code: 'not_found', message: '产品不存在' });
    expect((await getProductDashboard(t.db, readOnlyToken(owner), pan, { range: R90, now: NOW })).cards.wip.value).toBe(1);
  });
});

describe('组织汇总', () => {
  it('每个产品一行（按编号前缀排序），关键数字与产品看板一致', async () => {
    const org = await getOrgDashboard(t.db, owner, { range: R90, now: NOW });
    expect(org.window).toMatchObject({ from: '2026-07-16', to: '2026-10-13' });
    expect(org.products.map((p) => p.key)).toEqual(['DOC', 'EMP', 'PAN']);
    const panDash = await getProductDashboard(t.db, owner, pan, { range: R90, now: NOW });
    expect(org.products.find((p) => p.key === 'PAN')).toEqual({ id: pan, key: 'PAN', name: '网盘', cards: panDash.cards, completedCount: 2 });
  });

  it('仅组织管理员：全部产品范围的只读 Token 可以；成员、访客、限定产品的 Token 不可以；不支持按迭代', async () => {
    const member = await asMember(t.db, owner, '成员乙');
    const guest = await asMember(t.db, owner, '访客丙', 'guest');
    const scoped: Actor = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f2', tokenScope: { products: [pan], access: 'read' } };
    expect((await getOrgDashboard(t.db, readOnlyToken(owner), { range: R90, now: NOW })).products).toHaveLength(3);
    for (const who of [member, guest, scoped]) {
      expect(canViewOrgDashboard(who)).toBe(false);
      await expect(getOrgDashboard(t.db, who, { range: R90, now: NOW })).rejects.toMatchObject({ code: 'forbidden', message: '需要组织管理员权限' });
    }
    await expect(getOrgDashboard(t.db, owner, { range: { kind: 'iteration', iterationId: it1 }, now: NOW })).rejects.toMatchObject({
      code: 'invalid',
      message: '组织汇总不支持按迭代查看',
    });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard.test.ts`
Expected: FAIL，`Cannot find module '../src/dashboard/dashboard'`

- [ ] **Step 3: 写实现**

`packages/core/src/dashboard/dashboard.ts`：

```ts
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { requireProductRole, visibleProductIds } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { iterations, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { displayKey } from '../requirements/requirements';
import { type IterationOption, loadIterationFacts, loadIterationOptions, loadReleaseFacts, loadSpecialFacts } from './delivery';
import {
  type IterationRow,
  iterationCommitment,
  type ReleaseFact,
  type ReleaseSummary,
  releaseSummary,
  type ReviewEventFact,
  type ReviewItemRow,
  reviewSummary,
  specialCompletion,
  type SpecialRow,
} from './delivery-metrics';
import { loadProductFlow, orgTimeZone, type ProductFlow } from './flow';
import { addDays, type Completion, completionsOf, daysBetween, flowSummary, stuckNow, type WeekPoint, weeklySeries, zonedDate } from './metrics';
import { loadReviewEvents } from './review';

export const DASHBOARD_RANGE_DAYS = [30, 90, 180] as const;
export const DASHBOARD_MAX_DAYS = 366;

export type DashboardRange =
  | { kind: 'days'; days: (typeof DASHBOARD_RANGE_DAYS)[number] }
  | { kind: 'custom'; from: string; to: string }
  | { kind: 'iteration'; iterationId: string };
export type DashboardWindow = {
  from: string;
  to: string;
  days: number;
  previousFrom: string;
  previousTo: string;
  today: string;
  timeZone: string;
  iteration: { id: string; name: string } | null;
};
export type MetricPair = { value: number | null; previous: number | null };
export type DashboardCards = {
  throughputPerWeek: MetricPair;
  leadTimeMedian: MetricPair;
  flowTimeMedian: MetricPair;
  wip: MetricPair;
  releaseOnTimeRate: MetricPair;
  rejectionRate: MetricPair;
};
export type StateView = { key: string; label: string; color: string };
export type ProductDashboard = {
  product: { id: string; key: string; name: string };
  window: DashboardWindow;
  iterationOptions: IterationOption[];
  cards: DashboardCards;
  completedCount: number;
  weeks: WeekPoint[];
  stuck: {
    states: Array<StateView & { count: number; avgDays: number }>;
    oldest: Array<{ id: string; displayKey: string; title: string; state: StateView; days: number }>;
  };
  iterations: IterationRow[];
  releases: ReleaseSummary;
  specials: SpecialRow[];
  review: { since: string | null; concluded: number; rejected: number; rejectionRate: number | null; items: Array<ReviewItemRow & { label: string }> };
};
export type OrgDashboard = {
  window: DashboardWindow;
  products: Array<{ id: string; key: string; name: string; cards: DashboardCards; completedCount: number }>;
};

/** 组织汇总的查看权限：所有者或管理员；用 Token 时须为全部产品范围（只读、读写均可）。 */
export function canViewOrgDashboard(actor: Actor): boolean {
  if (actor.orgRole !== 'owner' && actor.orgRole !== 'admin') return false;
  return !actor.tokenScope || actor.tokenScope.products === 'all';
}

function windowOf(from: string, to: string, today: string, timeZone: string, iteration: DashboardWindow['iteration']): DashboardWindow {
  const days = daysBetween(from, to) + 1;
  const previousTo = addDays(from, -1);
  return { from, to, days, previousFrom: addDays(previousTo, -(days - 1)), previousTo, today, timeZone, iteration };
}

/** 解析时间段：近 N 天（结束日为今天）、自定义（最多 366 天，不晚于今天）、按迭代（本产品已开始的常规迭代，结束日不晚于今天）。 */
async function resolveWindow(tx: Tx, productId: string | null, range: DashboardRange, today: string, timeZone: string): Promise<DashboardWindow> {
  if (range.kind === 'days') {
    if (!(DASHBOARD_RANGE_DAYS as readonly number[]).includes(range.days)) throw new AppError('invalid', '时间段只能是近 30、90 或 180 天');
    return windowOf(addDays(today, -(range.days - 1)), today, today, timeZone, null);
  }
  if (range.kind === 'custom') {
    const from = assertIsoDate(range.from, '开始日期');
    const to = assertIsoDate(range.to, '结束日期');
    if (from > to) throw new AppError('invalid', '结束日期不能早于开始日期');
    if (to > today) throw new AppError('invalid', '结束日期不能晚于今天');
    if (daysBetween(from, to) + 1 > DASHBOARD_MAX_DAYS) throw new AppError('invalid', '自定义时间段不超过 366 天');
    return windowOf(from, to, today, timeZone, null);
  }
  if (!productId) throw new AppError('invalid', '组织汇总不支持按迭代查看');
  const [it] = await tx
    .select({ id: iterations.id, name: iterations.name, startDate: iterations.startDate, endDate: iterations.endDate })
    .from(iterations)
    .where(and(eq(iterations.id, range.iterationId), eq(iterations.productId, productId), eq(iterations.type, 'regular'), isNull(iterations.deletedAt)));
  if (!it) throw new AppError('not_found', '迭代不存在');
  if (it.startDate > today) throw new AppError('invalid', '迭代还没有开始');
  return windowOf(it.startDate, it.endDate < today ? it.endDate : today, today, timeZone, { id: it.id, name: it.name });
}

type Facts = { flow: ProductFlow; completions: Completion[]; releases: ReleaseFact[]; review: ReviewEventFact[]; dataStart: string | null };

async function loadFacts(tx: Tx, productId: string, timeZone: string): Promise<Facts> {
  const flow = await loadProductFlow(tx, productId, timeZone);
  let dataStart: string | null = null;
  for (const r of flow.requirements) {
    const first = r.transitions[0]!.date;
    if (dataStart === null || first < dataStart) dataStart = first;
  }
  return {
    flow,
    completions: completionsOf(flow.requirements, flow.categoryOf),
    releases: await loadReleaseFacts(tx, productId),
    review: await loadReviewEvents(tx, productId, new Set(flow.meta.keys())),
    dataStart,
  };
}

/**
 * 六个关键数字与上一个同长度时间段。产品在时间段结束时还没有任何需求时，吞吐量与在制品为 null；
 * 上期早于产品数据起点时，流动类指标的上期为 null（不和 0 比较）。
 */
function cardsOf(f: Facts, w: DashboardWindow): { cards: DashboardCards; completedCount: number } {
  const { requirements: reqs, categoryOf } = f.flow;
  const cur = flowSummary(reqs, f.completions, categoryOf, w.from, w.to);
  const hasCurrent = f.dataStart !== null && f.dataStart <= w.to;
  const prev = f.dataStart !== null && f.dataStart <= w.previousTo ? flowSummary(reqs, f.completions, categoryOf, w.previousFrom, w.previousTo) : null;
  const onTime = (from: string, to: string) => releaseSummary(f.releases, from, to, w.today, w.timeZone).onTimeRate;
  const rejection = (from: string, to: string) => reviewSummary(f.review, from, to, w.timeZone).rejectionRate;
  return {
    completedCount: cur.completed,
    cards: {
      throughputPerWeek: { value: hasCurrent ? cur.throughputPerWeek : null, previous: prev?.throughputPerWeek ?? null },
      leadTimeMedian: { value: cur.leadMedian, previous: prev?.leadMedian ?? null },
      flowTimeMedian: { value: cur.flowMedian, previous: prev?.flowMedian ?? null },
      wip: { value: hasCurrent ? cur.wip : null, previous: prev?.wip ?? null },
      releaseOnTimeRate: { value: onTime(w.from, w.to), previous: onTime(w.previousFrom, w.previousTo) },
      rejectionRate: { value: rejection(w.from, w.to), previous: rejection(w.previousFrom, w.previousTo) },
    },
  };
}

/** 产品看板：能看到该产品的成员都可以查看（含访客被授权的产品、只读 Token）；看不到时与不存在一样返回 404。 */
export async function getProductDashboard(db: Db, actor: Actor, productId: string, input: { range: DashboardRange; now?: Date }): Promise<ProductDashboard> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const now = input.now ?? new Date();
    const timeZone = await orgTimeZone(tx, actor.orgId);
    const today = zonedDate(now, timeZone);
    const window = await resolveWindow(tx, productId, input.range, today, timeZone);
    const [product] = await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(eq(products.id, productId));
    const facts = await loadFacts(tx, productId, timeZone);
    const { flow } = facts;
    const stateMeta = new Map(flow.states.map((s) => [s.key, s]));
    const stateView = (key: string): StateView => ({ key, label: stateMeta.get(key)?.label ?? key, color: stateMeta.get(key)?.color ?? '#8a9199' });
    const stuck = stuckNow(flow.requirements, flow.categoryOf, now);
    const byId = new Map(flow.requirements.map((r) => [r.id, r]));
    const review = reviewSummary(facts.review, window.from, window.to, timeZone);
    const itemOrder = new Map(flow.checkItems.map((c, i) => [c.key, i]));
    const itemLabel = new Map(flow.checkItems.map((c) => [c.key, c.label]));
    return {
      product: product!,
      window,
      iterationOptions: await loadIterationOptions(tx, productId, today),
      ...cardsOf(facts, window),
      weeks: weeklySeries(flow.requirements, facts.completions, flow.categoryOf, window.from, window.to),
      stuck: {
        states: stuck.states.map((s) => ({ ...stateView(s.key), count: s.count, avgDays: s.avgDays })),
        oldest: stuck.oldest.map((o) => {
          const m = flow.meta.get(o.id)!;
          return { id: o.id, displayKey: displayKey(flow.productKey, m.number), title: m.title, state: stateView(o.stateKey), days: o.days };
        }),
      },
      iterations: (await loadIterationFacts(tx, productId, flow, window.from, window.to)).map((it) => iterationCommitment(it, byId, flow.categoryOf, today)),
      releases: releaseSummary(facts.releases, window.from, window.to, today, timeZone),
      specials: (await loadSpecialFacts(tx, flow, window.from, window.to)).map((s) => specialCompletion(s, flow.categoryOf)),
      review: {
        ...review,
        items: review.items
          .map((i) => ({ ...i, label: itemLabel.get(i.itemKey) ?? i.itemKey }))
          .sort((a, b) => (itemOrder.get(a.itemKey) ?? Number.MAX_SAFE_INTEGER) - (itemOrder.get(b.itemKey) ?? Number.MAX_SAFE_INTEGER) || a.itemKey.localeCompare(b.itemKey)),
      },
    };
  });
}

/** 组织汇总：仅组织管理员；每个可见产品一行（按编号前缀排序），列出六个关键数字与上期对比。不支持按迭代。 */
export async function getOrgDashboard(db: Db, actor: Actor, input: { range: DashboardRange; now?: Date }): Promise<OrgDashboard> {
  if (!canViewOrgDashboard(actor)) throw new AppError('forbidden', '需要组织管理员权限');
  if (input.range.kind === 'iteration') throw new AppError('invalid', '组织汇总不支持按迭代查看');
  return withOrg(db, actor.orgId, async (tx) => {
    const timeZone = await orgTimeZone(tx, actor.orgId);
    const today = zonedDate(input.now ?? new Date(), timeZone);
    const window = await resolveWindow(tx, null, input.range, today, timeZone);
    const visible = await visibleProductIds(tx, actor);
    const rows =
      visible.size > 0
        ? await tx
            .select({ id: products.id, key: products.key, name: products.name })
            .from(products)
            .where(and(inArray(products.id, [...visible]), isNull(products.deletedAt)))
            .orderBy(asc(products.key))
        : [];
    const out: OrgDashboard['products'] = [];
    for (const p of rows) out.push({ ...p, ...cardsOf(await loadFacts(tx, p.id, timeZone), window) });
    return { window, products: out };
  });
}
```

在 `packages/core/src/index.ts` 的 `export * from './workbench/workbench';` 之后加：

```ts
export * from './dashboard/dashboard';
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 跑 core 全部看板测试与类型检查**

Run: `pnpm --filter @flower/core exec vitest run test/dashboard` 然后 `pnpm --filter @flower/core typecheck`
Expected: 6 个测试文件全部通过；类型检查无错误（`DashboardRange` 等名字与已有导出不冲突）

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/dashboard/dashboard.ts packages/core/src/index.ts packages/core/test/dashboard.test.ts
git commit -m "feat(core): 产品看板与组织汇总服务（时间段解析、上期对比、按可见产品过滤）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 看板接口与权限测试

**Files:**
- Create: `apps/web/src/server/routes/dashboard.ts`
- Modify: `apps/web/src/server/api.ts`（导入并注册）
- Test: `apps/web/test/api/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `getProductDashboard`、`getOrgDashboard`、`DashboardRange`；`idParam(c, name, message)`（`apps/web/src/server/routes/notifications.ts` 已导出）；测试辅助 `makeApp`、`call`、`initAndLogin`、`sessionFrom`（`apps/web/test/api/helpers.ts`）
- Produces:
  - `GET /api/v1/orgs/:org/products/:id/dashboard?range=30|90|180 | from=YYYY-MM-DD&to=YYYY-MM-DD | iteration=<uuid>` → `{ dashboard: ProductDashboard }`
  - `GET /api/v1/orgs/:org/dashboard?range=… | from&to` → `{ dashboard: OrgDashboard }`
  - 参数规则：有 `iteration` 时按迭代；有 `from` 或 `to` 时两者都要（「自定义时间段需要开始和结束日期」）；否则按 `range`（默认 90）。`range` 不是 30/90/180、`iteration` 不是 UUID 时 400「时间段参数无效」；产品 id 不是 UUID 时 400「产品无效」
  - `registerDashboardRoutes(app: App, deps: ApiDeps): void`

- [ ] **Step 1: 写失败的测试**

`apps/web/test/api/dashboard.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

type As = { session?: string; token?: string };

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let pan: string;
let doc: string;
const who: Record<string, As> = {};

/** 邀请一个新账号加入组织，返回其会话与成员 id。 */
async function join(email: string, orgRole: 'member' | 'guest', name: string): Promise<{ session: string; memberId: string }> {
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email, orgRole } });
  const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name, password: 'password123' } });
  const s = sessionFrom(accept.res);
  return { session: s, memberId: (await call(app, 'GET', '/orgs/acme', { session: s })).body.me.memberId };
}

const dash = (productId: string, as: As, query = '') => call(app, 'GET', `/orgs/acme/products/${productId}/dashboard${query}`, as);
const summary = (as: As, query = '') => call(app, 'GET', `/orgs/acme/dashboard${query}`, as);

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  pan = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  doc = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '文档', key: 'DOC' } })).body.product.id;
  const panReq = (await call(app, 'POST', `/orgs/acme/products/${pan}/requirements`, { session, body: { title: '网盘需求' } })).body.requirement;
  const docReq = (await call(app, 'POST', `/orgs/acme/products/${doc}/requirements`, { session, body: { title: '文档需求' } })).body.requirement;
  const special = (await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'special', name: '专项甲', startDate: '2020-01-01', endDate: '2099-12-31' } })).body
    .iteration.id;
  await call(app, 'PUT', `/orgs/acme/requirements/${panReq.id}/iteration`, { session, body: { iterationId: special } });
  await call(app, 'PUT', `/orgs/acme/requirements/${docReq.id}/iteration`, { session, body: { iterationId: special } });

  const ownerId = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  const setRole = (memberId: string, role: 'admin' | 'viewer') => call(app, 'PUT', `/orgs/acme/products/${pan}/roles/${memberId}`, { session, body: { role } });
  const productAdmin = await join('padmin@example.com', 'member', '产品管理员');
  await setRole(productAdmin.memberId, 'admin');
  const editor = await join('editor@example.com', 'member', '编辑成员');
  const viewer = await join('viewer@example.com', 'member', '只读成员');
  await setRole(viewer.memberId, 'viewer');
  const guest = await join('guest@example.com', 'guest', '访客');
  await setRole(guest.memberId, 'viewer');
  const token = async (scope: unknown) => (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: ownerId, name: '看板', scope } })).body.token as string;
  Object.assign(who, {
    owner: { session },
    productAdmin: { session: productAdmin.session },
    editor: { session: editor.session },
    viewer: { session: viewer.session },
    guest: { session: guest.session },
    readToken: { token: await token({ products: 'all', access: 'read' }) },
    panToken: { token: await token({ products: [pan], access: 'read' }) },
  });
});
afterAll(() => cleanup());

describe('产品看板接口', () => {
  it('能看到该产品的成员都可以查看（组织管理员、产品管理员、编辑、只读、访客、只读 Token）', async () => {
    for (const k of ['owner', 'productAdmin', 'editor', 'viewer', 'guest', 'readToken', 'panToken']) {
      const r = await dash(pan, who[k]!);
      expect(r.status, k).toBe(200);
      expect(r.body.dashboard.product.key, k).toBe('PAN');
    }
  });

  it('看不到的产品返回 404；其他人能看到另一个产品', async () => {
    for (const k of ['owner', 'productAdmin', 'editor', 'viewer', 'readToken']) expect((await dash(doc, who[k]!)).status, k).toBe(200);
    for (const k of ['guest', 'panToken']) {
      const r = await dash(doc, who[k]!);
      expect(r.status, k).toBe(404);
      expect(r.body.error.message).toBe('产品不存在');
    }
  });

  it('看不到的产品的数据不出现在响应里：专项只统计本产品的需求', async () => {
    const body = (await dash(pan, who.guest!)).body;
    expect(body.dashboard.specials).toEqual([expect.objectContaining({ name: '专项甲', total: 1 })]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('文档需求');
    expect(text).not.toContain(doc);
  });

  it('时间段参数：默认近 90 天、近 30 天、自定义；不合法时 400 / 404 与中文原因', async () => {
    expect((await dash(pan, who.owner!)).body.dashboard.window.days).toBe(90);
    expect((await dash(pan, who.owner!, '?range=30')).body.dashboard.window.days).toBe(30);
    expect((await dash(pan, who.owner!, '?from=2026-01-01&to=2026-01-31')).body.dashboard.window).toMatchObject({ from: '2026-01-01', to: '2026-01-31', days: 31 });
    const bad = async (query: string, status: number, message: string) => {
      const r = await dash(pan, who.owner!, query);
      expect(r.status, query).toBe(status);
      expect(r.body.error.message, query).toBe(message);
    };
    await bad('?range=7', 400, '时间段参数无效');
    await bad('?iteration=abc', 400, '时间段参数无效');
    await bad('?from=2026-01-01', 400, '自定义时间段需要开始和结束日期');
    await bad('?from=2026-02-01&to=2026-01-01', 400, '结束日期不能早于开始日期');
    await bad('?iteration=0190a0b0-0000-7000-8000-000000000001', 404, '迭代不存在');
    const badId = await call(app, 'GET', '/orgs/acme/products/abc/dashboard', who.owner!);
    expect(badId.status).toBe(400);
    expect(badId.body.error.message).toBe('产品无效');
  });
});

describe('组织汇总接口', () => {
  it('组织管理员与全部产品范围的只读 Token 可以查看，每个产品一行', async () => {
    for (const k of ['owner', 'readToken']) {
      const r = await summary(who[k]!);
      expect(r.status, k).toBe(200);
      expect(r.body.dashboard.products.map((p: { key: string }) => p.key), k).toEqual(['DOC', 'PAN']);
    }
  });

  it('产品管理员、编辑、只读、访客、限定产品的 Token 返回 403，响应里没有任何产品数据', async () => {
    for (const k of ['productAdmin', 'editor', 'viewer', 'guest', 'panToken']) {
      const r = await summary(who[k]!);
      expect(r.status, k).toBe(403);
      expect(r.body.error.message).toBe('需要组织管理员权限');
      expect(JSON.stringify(r.body)).not.toContain('PAN');
    }
  });

  it('不支持按迭代查看', async () => {
    const r = await summary(who.owner!, '?iteration=0190a0b0-0000-7000-8000-000000000001');
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe('组织汇总不支持按迭代查看');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @flower/web exec vitest run test/api/dashboard.test.ts`
Expected: FAIL，各请求返回 404「接口不存在」

- [ ] **Step 3: 写路由并注册**

`apps/web/src/server/routes/dashboard.ts`：

```ts
import { AppError, type DashboardRange, getOrgDashboard, getProductDashboard } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { idParam } from './notifications';

const rangeQuery = z.object({
  range: z.enum(['30', '90', '180']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  iteration: z.string().uuid().optional(),
});

/** 查询参数 → 时间段：有 iteration 时按迭代；有 from 或 to 时为自定义（两者都要）；否则近 N 天（默认 90）。日期本身由服务校验。 */
function parseRange(raw: Record<string, string>): DashboardRange {
  const q = rangeQuery.safeParse(raw);
  if (!q.success) throw new AppError('invalid', '时间段参数无效');
  const { range, from, to, iteration } = q.data;
  if (iteration) return { kind: 'iteration', iterationId: iteration };
  if (from !== undefined || to !== undefined) {
    if (!from || !to) throw new AppError('invalid', '自定义时间段需要开始和结束日期');
    return { kind: 'custom', from, to };
  }
  return { kind: 'days', days: range === '30' ? 30 : range === '180' ? 180 : 90 };
}

export function registerDashboardRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/dashboard', async (c) =>
    c.json({ dashboard: await getProductDashboard(deps.db, c.get('actor'), idParam(c, 'id', '产品无效'), { range: parseRange(c.req.query()) }) }),
  );

  app.get('/orgs/:org/dashboard', async (c) => c.json({ dashboard: await getOrgDashboard(deps.db, c.get('actor'), { range: parseRange(c.req.query()) }) }));
}
```

`apps/web/src/server/api.ts`：在 `import { registerDefinitionRoutes } from './routes/definitions';` 之前加一行导入，在 `registerReviewRoutes(app, deps);` 之后加一行注册：

```ts
import { registerDashboardRoutes } from './routes/dashboard';
```

```ts
  registerDashboardRoutes(app, deps);
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @flower/web exec vitest run test/api/dashboard.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: lint、类型检查并提交**

Run: `pnpm --filter @flower/web lint --max-warnings 0` 与 `pnpm typecheck`
Expected: 0 错误 0 警告；类型检查无错误

```bash
git add apps/web/src/server/routes/dashboard.ts apps/web/src/server/api.ts apps/web/test/api/dashboard.test.ts
git commit -m "feat(web): 产品看板与组织汇总接口，权限与参数测试

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 前端数据层与看板纯逻辑

**Files:**
- Modify: `apps/web/src/lib/types.ts`（导入与三个类型）
- Modify: `apps/web/src/lib/queries.ts`（类型导入、`qk` 两个键、两个查询）
- Create: `apps/web/src/features/dashboard/model.ts`
- Test: `apps/web/src/features/dashboard/model.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `ProductDashboard`、`OrgDashboard`（`import type`）；Task 7 的两个接口
- Produces:
  - `apps/web/src/lib/types.ts`：`type ProductDashboard = Jsonify<CoreProductDashboard>`、`type OrgDashboard = Jsonify<CoreOrgDashboard>`、`type DashboardCards = ProductDashboard['cards']`
  - `apps/web/src/lib/queries.ts`：`qk.productDashboard(o, productId, query)`、`qk.orgDashboard(o, query)`；`useProductDashboard(o: string, productId: string | undefined, query: string)`、`useOrgDashboard(o: string, query: string)`（`staleTime` 5 分钟、`placeholderData: keepPreviousData`）
  - `apps/web/src/features/dashboard/model.ts`：
    - `type DashboardFilter = { kind: 'days'; days: 30 | 90 | 180 } | { kind: 'custom'; from: string; to: string } | { kind: 'iteration'; iterationId: string }`；`DEFAULT_FILTER`；`RANGE_OPTIONS`
    - `filterFromParams(p: { get(name: string): string | null }, allowIteration = true): DashboardFilter`；`filterQuery(f): string`；`rangeValue(f): string`；`dashboardHref(org, productId, f = DEFAULT_FILTER): string`；`orgDashboardHref(org, f): string`；`customRangeError(from, to, today): string | null`
    - `type WindowView = { from; to; days; previousFrom; previousTo; iteration: { id; name } | null }`；`windowText(w: WindowView): string`
    - `METRIC_HELP`（口径文案）；`type MetricUnit = 'perWeek' | 'days' | 'count' | 'rate'`；`type CardKey = keyof DashboardCards`；`type CardSpec = { key: CardKey; label: string; unit: MetricUnit; better: 'up' | 'down'; help: keyof typeof METRIC_HELP }`；`CARD_SPECS: CardSpec[]`
    - `formatMetric(value: number | null, unit: MetricUnit): string`；`formatDays(n: number | null): string`；`formatRate(n: number | null): string`；`emptyReason(key: CardKey, completedCount: number): string`
    - `type Tone = 'good' | 'bad' | 'neutral'`；`TONE_CLASS: Record<Tone, string>`；`type Delta = { direction: 'up' | 'down' | 'flat'; tone: Tone; text: string }`；`cardDelta(pair: { value: number | null; previous: number | null }, unit: MetricUnit, better: 'up' | 'down'): Delta | null`
    - `weekLabel(monday: string): string`；`niceMax(values: Array<number | null>): number`；`linePoints(values: Array<number | null>, width: number, height: number, max: number): Array<Array<{ x: number; y: number }>>`
    - `releaseVerdict(r: { status: 'planned' | 'released'; dueDate: string | null; onTime: boolean | null; overdueDays: number | null }): { text: string; tone: Tone }`

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/dashboard/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  cardDelta,
  customRangeError,
  dashboardHref,
  DEFAULT_FILTER,
  emptyReason,
  filterFromParams,
  filterQuery,
  formatDays,
  formatMetric,
  formatRate,
  linePoints,
  niceMax,
  orgDashboardHref,
  rangeValue,
  releaseVerdict,
  weekLabel,
  windowText,
} from './model';

const p = (s: string) => new URLSearchParams(s);
const ITERATION_ID = '0190a0b0-0000-7000-8000-000000000001';

describe('筛选与地址', () => {
  it('地址栏参数转成筛选；不认识的值回到近 90 天', () => {
    expect(filterFromParams(p(''))).toEqual(DEFAULT_FILTER);
    expect(filterFromParams(p('range=30'))).toEqual({ kind: 'days', days: 30 });
    expect(filterFromParams(p('range=180'))).toEqual({ kind: 'days', days: 180 });
    expect(filterFromParams(p('range=7'))).toEqual(DEFAULT_FILTER);
    expect(filterFromParams(p('from=2026-09-01&to=2026-09-30'))).toEqual({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' });
    expect(filterFromParams(p('from=2026-09-01'))).toEqual(DEFAULT_FILTER);
    expect(filterFromParams(p(`iteration=${ITERATION_ID}&range=30`))).toEqual({ kind: 'iteration', iterationId: ITERATION_ID });
    expect(filterFromParams(p('iteration=abc'))).toEqual(DEFAULT_FILTER);
    expect(filterFromParams(p(`iteration=${ITERATION_ID}&range=30`), false)).toEqual({ kind: 'days', days: 30 });
  });

  it('筛选转成查询串与页面地址；默认值不写进地址', () => {
    expect(filterQuery(DEFAULT_FILTER)).toBe('');
    expect(filterQuery({ kind: 'days', days: 180 })).toBe('range=180');
    expect(filterQuery({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' })).toBe('from=2026-09-01&to=2026-09-30');
    expect(filterQuery({ kind: 'iteration', iterationId: ITERATION_ID })).toBe(`iteration=${ITERATION_ID}`);
    expect(rangeValue({ kind: 'days', days: 30 })).toBe('30');
    expect(rangeValue({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' })).toBe('custom');
    expect(dashboardHref('acme', 'p1')).toBe('/acme/dashboard?product=p1');
    expect(dashboardHref('acme', 'p1', { kind: 'days', days: 30 })).toBe('/acme/dashboard?product=p1&range=30');
    expect(orgDashboardHref('acme', DEFAULT_FILTER)).toBe('/acme/settings/dashboard');
    expect(orgDashboardHref('acme', { kind: 'days', days: 180 })).toBe('/acme/settings/dashboard?range=180');
  });

  it('自定义时间段的前端校验', () => {
    expect(customRangeError('', '2026-10-01', '2026-10-13')).toBe('请选择开始和结束日期');
    expect(customRangeError('2026-10-05', '2026-10-01', '2026-10-13')).toBe('结束日期不能早于开始日期');
    expect(customRangeError('2026-10-01', '2026-10-14', '2026-10-13')).toBe('结束日期不能晚于今天');
    expect(customRangeError('2025-01-01', '2026-10-13', '2026-10-13')).toBe('自定义时间段不超过 366 天');
    expect(customRangeError('2026-10-01', '2026-10-13', '2026-10-13')).toBeNull();
  });

  it('时间段说明', () => {
    const base = { from: '2026-07-16', to: '2026-10-13', days: 90, previousFrom: '2026-04-17', previousTo: '2026-07-15', iteration: null };
    expect(windowText(base)).toBe('2026-07-16 至 2026-10-13（90 天），与上期 2026-04-17 至 2026-07-15 比较');
    expect(windowText({ from: '2026-09-01', to: '2026-09-30', days: 30, previousFrom: '2026-08-02', previousTo: '2026-08-31', iteration: { id: 'i', name: '第 1 轮' } })).toBe(
      '迭代「第 1 轮」：2026-09-01 至 2026-09-30（30 天），与上期 2026-08-02 至 2026-08-31 比较',
    );
  });
});

describe('数字、升降与空数据原因', () => {
  it('按单位格式化；没有数据显示「暂无数据」', () => {
    expect(formatMetric(null, 'rate')).toBe('暂无数据');
    expect(formatMetric(0.5, 'rate')).toBe('50%');
    expect(formatMetric(17, 'days')).toBe('17.0 天');
    expect(formatMetric(0.2, 'perWeek')).toBe('0.2 条/周');
    expect(formatMetric(3, 'count')).toBe('3');
    expect(formatDays(null)).toBe('暂无数据');
    expect(formatDays(64.1)).toBe('64.1 天');
    expect(formatRate(0.3333)).toBe('33%');
  });

  it('与上期比较：方向、好坏与文字；任一侧没有数据时不显示', () => {
    expect(cardDelta({ value: 0.2, previous: 0.1 }, 'perWeek', 'up')).toEqual({ direction: 'up', tone: 'good', text: '比上期升 0.1 条/周' });
    expect(cardDelta({ value: 17, previous: 19 }, 'days', 'down')).toEqual({ direction: 'down', tone: 'good', text: '比上期降 2.0 天' });
    expect(cardDelta({ value: 0.5, previous: 0.3 }, 'rate', 'down')).toEqual({ direction: 'up', tone: 'bad', text: '比上期升 20 个百分点' });
    expect(cardDelta({ value: 3, previous: 1 }, 'count', 'down')).toEqual({ direction: 'up', tone: 'bad', text: '比上期升 2' });
    expect(cardDelta({ value: 2, previous: 2 }, 'count', 'down')).toEqual({ direction: 'flat', tone: 'neutral', text: '与上期持平' });
    expect(cardDelta({ value: 1, previous: null }, 'count', 'down')).toBeNull();
    expect(cardDelta({ value: null, previous: 1 }, 'count', 'down')).toBeNull();
  });

  it('空数据原因：流动时间区分「没有完成的需求」与「完成的需求没有经过进行中」', () => {
    expect(emptyReason('throughputPerWeek', 0)).toBe('时间段内还没有需求');
    expect(emptyReason('leadTimeMedian', 0)).toBe('时间段内没有完成的需求');
    expect(emptyReason('flowTimeMedian', 0)).toBe('时间段内没有完成的需求');
    expect(emptyReason('flowTimeMedian', 2)).toBe('时间段内完成的需求都没有经过进行中状态');
    expect(emptyReason('releaseOnTimeRate', 0)).toBe('时间段内没有能判断是否按期的已发布版本');
    expect(emptyReason('rejectionRate', 0)).toBe('时间段内没有有结论的检查项');
  });
});

describe('图表与版本结论', () => {
  it('纵轴上限取 1、2、5 的整数倍；没有数据时为 1', () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0])).toBe(1);
    expect(niceMax([3])).toBe(5);
    expect(niceMax([7, null])).toBe(10);
    expect(niceMax([12])).toBe(20);
    expect(niceMax([0.85])).toBe(1);
  });

  it('折线坐标：null 处断开；只有一个点时居中', () => {
    expect(linePoints([1, null, 2, 4], 300, 100, 4)).toEqual([[{ x: 0, y: 75 }], [{ x: 200, y: 50 }, { x: 300, y: 0 }]]);
    expect(linePoints([2], 300, 100, 4)).toEqual([[{ x: 150, y: 50 }]]);
    expect(linePoints([null, null], 300, 100, 4)).toEqual([]);
    expect(weekLabel('2026-10-05')).toBe('10/5');
  });

  it('版本结论：已发布的按期、逾期或无法判断；未发布的是否已过计划日', () => {
    expect(releaseVerdict({ status: 'released', dueDate: '2026-09-25', onTime: true, overdueDays: 0 })).toEqual({ text: '按期', tone: 'good' });
    expect(releaseVerdict({ status: 'released', dueDate: '2026-09-30', onTime: false, overdueDays: 2 })).toEqual({ text: '逾期 2 天', tone: 'bad' });
    expect(releaseVerdict({ status: 'released', dueDate: null, onTime: null, overdueDays: null })).toEqual({ text: '无法判断：没有计划日期', tone: 'neutral' });
    expect(releaseVerdict({ status: 'planned', dueDate: '2026-10-10', onTime: null, overdueDays: 3 })).toEqual({ text: '未发布，已过计划日 3 天', tone: 'bad' });
    expect(releaseVerdict({ status: 'planned', dueDate: '2026-10-20', onTime: null, overdueDays: 0 })).toEqual({ text: '未发布', tone: 'neutral' });
    expect(releaseVerdict({ status: 'planned', dueDate: null, onTime: null, overdueDays: null })).toEqual({ text: '未发布，没有计划日期', tone: 'neutral' });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @flower/web exec vitest run src/features/dashboard/model.test.ts`
Expected: FAIL，`Cannot find module './model'`

- [ ] **Step 3: 写类型与查询**

`apps/web/src/lib/types.ts`：在 `import type { … } from '@flower/core';` 的列表里按字母顺序加入两项：

```ts
  OrgDashboard as CoreOrgDashboard,
```

（放在 `NotificationSettings as CoreNotificationSettings,` 之后）和

```ts
  ProductDashboard as CoreProductDashboard,
```

（放在 `PersonalChannelSetting as CorePersonalChannelSetting,` 之后）。在文件末尾加：

```ts

export type ProductDashboard = Jsonify<CoreProductDashboard>;
export type OrgDashboard = Jsonify<CoreOrgDashboard>;
export type DashboardCards = ProductDashboard['cards'];
```

`apps/web/src/lib/queries.ts`：

1. 在 `import type { … } from './types';` 的列表里加入 `OrgDashboard,`（放在 `Org,` 之后）与 `ProductDashboard,`（放在 `Product,` 之后）。
2. 在 `qk` 对象里 `reviews: …` 一行之后加：

```ts
  productDashboard: (o: string, productId: string, query: string) => ['org', o, 'dashboard', 'product', productId, query] as const,
  orgDashboard: (o: string, query: string) => ['org', o, 'dashboard', 'org', query] as const,
```

3. 在 `useReviewQueue` 定义之后加：

```ts
/** 看板打开时实时计算，前端缓存 5 分钟；切换筛选时保留上一次结果，避免闪烁。 */
const DASHBOARD_STALE_MS = 5 * 60_000;

export const useProductDashboard = (o: string, productId: string | undefined, query: string) =>
  useQuery({
    queryKey: qk.productDashboard(o, productId ?? '', query),
    queryFn: () => api<{ dashboard: ProductDashboard }>(`/orgs/${o}/products/${productId}/dashboard${query ? `?${query}` : ''}`),
    select: (d) => d.dashboard,
    enabled: !!productId,
    staleTime: DASHBOARD_STALE_MS,
    placeholderData: keepPreviousData,
  });

export const useOrgDashboard = (o: string, query: string) =>
  useQuery({
    queryKey: qk.orgDashboard(o, query),
    queryFn: () => api<{ dashboard: OrgDashboard }>(`/orgs/${o}/dashboard${query ? `?${query}` : ''}`),
    select: (d) => d.dashboard,
    staleTime: DASHBOARD_STALE_MS,
    placeholderData: keepPreviousData,
  });
```

- [ ] **Step 4: 写纯逻辑**

`apps/web/src/features/dashboard/model.ts`：

```ts
import type { DashboardCards } from '@/lib/types';

export type DashboardFilter = { kind: 'days'; days: 30 | 90 | 180 } | { kind: 'custom'; from: string; to: string } | { kind: 'iteration'; iterationId: string };

export const DEFAULT_FILTER: DashboardFilter = { kind: 'days', days: 90 };

export const RANGE_OPTIONS = [
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
  { value: '180', label: '近 180 天' },
  { value: 'custom', label: '自定义' },
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** 地址栏参数 → 筛选。iteration 优先，其次 from + to，再次 range；不认识的值回到默认（近 90 天）。组织汇总不接受 iteration。 */
export function filterFromParams(p: { get(name: string): string | null }, allowIteration = true): DashboardFilter {
  const iteration = p.get('iteration');
  if (allowIteration && iteration && UUID_RE.test(iteration)) return { kind: 'iteration', iterationId: iteration };
  const from = p.get('from');
  const to = p.get('to');
  if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) return { kind: 'custom', from, to };
  const range = p.get('range');
  if (range === '30') return { kind: 'days', days: 30 };
  if (range === '180') return { kind: 'days', days: 180 };
  return DEFAULT_FILTER;
}

/** 筛选 → 查询串（接口与地址栏共用，不含 product）；默认值为空串。 */
export function filterQuery(f: DashboardFilter): string {
  if (f.kind === 'iteration') return `iteration=${encodeURIComponent(f.iterationId)}`;
  if (f.kind === 'custom') return `from=${f.from}&to=${f.to}`;
  return f.days === 90 ? '' : `range=${f.days}`;
}

/** 时间段下拉框的值：近 N 天为天数，自定义为 custom。 */
export const rangeValue = (f: DashboardFilter): string => (f.kind === 'days' ? String(f.days) : 'custom');

export function dashboardHref(org: string, productId: string, f: DashboardFilter = DEFAULT_FILTER): string {
  const q = filterQuery(f);
  return `/${org}/dashboard?product=${productId}${q ? `&${q}` : ''}`;
}

export function orgDashboardHref(org: string, f: DashboardFilter): string {
  const q = filterQuery(f);
  return `/${org}/settings/dashboard${q ? `?${q}` : ''}`;
}

/** 自定义时间段的前端预校验，与服务端规则一致；服务端仍会完整校验。 */
export function customRangeError(from: string, to: string, today: string): string | null {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return '请选择开始和结束日期';
  if (from > to) return '结束日期不能早于开始日期';
  if (to > today) return '结束日期不能晚于今天';
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > 366) return '自定义时间段不超过 366 天';
  return null;
}

export type WindowView = { from: string; to: string; days: number; previousFrom: string; previousTo: string; iteration: { id: string; name: string } | null };

export function windowText(w: WindowView): string {
  const prefix = w.iteration ? `迭代「${w.iteration.name}」：` : '';
  return `${prefix}${w.from} 至 ${w.to}（${w.days} 天），与上期 ${w.previousFrom} 至 ${w.previousTo} 比较`;
}

/** 各指标的口径（设计 §3），悬停「?」时显示。 */
export const METRIC_HELP = {
  throughput: '时间段内每周进入「已完成」类状态的需求数；同一需求反复进出时按最后一次进入计，目前不在已完成类的需求不计。卡片为周均值。周从周一开始，按组织时区划分；已删除的需求不计，已取消不算完成。',
  leadTime: '需求创建到最后一次进入「已完成」类状态的天数，按完成日落在时间段内的需求计算；显示中位数与 85 分位。',
  flowTime: '需求第一次进入「进行中」类状态到最后一次进入「已完成」类状态的天数；没有经过进行中的需求不计。显示中位数与 85 分位。',
  wip: '处于「进行中」类状态的需求数，由状态流转记录推算。卡片为时间段最后一天结束时的数量，趋势为每周日结束时的数量。',
  releaseOnTime: '时间段内已发布的版本中，发布日不晚于基线日期的比例；没有基线日期的版本用所属迭代的结束日代替并标「按迭代结束日计」，两者都没有的版本不计入。',
  commitment: '只统计在 Flower 里开始、有承诺范围快照的迭代：快照内的需求在迭代结束时（进行中的迭代计到现在）处于「已完成」类的比例，已取消的不进入分母；同时列出中途加入、移出的需求数。',
  special: '每个专项内本产品需求的已完成数 ÷（总数 − 已取消数）。专项属于组织，这里只统计本产品的需求。',
  reviewDays: '检查项从开始评审（第一次离开「未开始」或第一次签字）到最终通过的天数中位数，按通过日落在时间段内的检查项计算。',
  rejection: '时间段内出现过「驳回」的检查项 ÷ 时间段内有结论（通过或驳回）的检查项；先驳回后通过的计为驳回过。只统计在 Flower 里记录的检查项变化。',
  stuck: '当前处于「进行中」类状态的需求，按具体状态统计数量与平均停留天数（自进入当前状态起），不受时间段影响。',
} as const;

export type MetricUnit = 'perWeek' | 'days' | 'count' | 'rate';
export type CardKey = keyof DashboardCards;
export type CardSpec = { key: CardKey; label: string; unit: MetricUnit; better: 'up' | 'down'; help: keyof typeof METRIC_HELP };

export const CARD_SPECS: CardSpec[] = [
  { key: 'throughputPerWeek', label: '吞吐量（周均）', unit: 'perWeek', better: 'up', help: 'throughput' },
  { key: 'leadTimeMedian', label: '前置时间中位数', unit: 'days', better: 'down', help: 'leadTime' },
  { key: 'flowTimeMedian', label: '流动时间中位数', unit: 'days', better: 'down', help: 'flowTime' },
  { key: 'wip', label: '当前在制品', unit: 'count', better: 'down', help: 'wip' },
  { key: 'releaseOnTimeRate', label: '版本按期达成率', unit: 'rate', better: 'up', help: 'releaseOnTime' },
  { key: 'rejectionRate', label: '驳回率', unit: 'rate', better: 'down', help: 'rejection' },
];

export const formatDays = (n: number | null): string => (n === null ? '暂无数据' : `${n.toFixed(1)} 天`);
export const formatRate = (n: number | null): string => (n === null ? '暂无数据' : `${Math.round(n * 100)}%`);

export function formatMetric(value: number | null, unit: MetricUnit): string {
  if (value === null) return '暂无数据';
  if (unit === 'rate') return formatRate(value);
  if (unit === 'days') return formatDays(value);
  if (unit === 'perWeek') return `${value.toFixed(1)} 条/周`;
  return String(value);
}

/** 卡片「暂无数据」时的原因。 */
export function emptyReason(key: CardKey, completedCount: number): string {
  switch (key) {
    case 'throughputPerWeek':
    case 'wip':
      return '时间段内还没有需求';
    case 'leadTimeMedian':
      return '时间段内没有完成的需求';
    case 'flowTimeMedian':
      return completedCount === 0 ? '时间段内没有完成的需求' : '时间段内完成的需求都没有经过进行中状态';
    case 'releaseOnTimeRate':
      return '时间段内没有能判断是否按期的已发布版本';
    case 'rejectionRate':
      return '时间段内没有有结论的检查项';
  }
}

export type Tone = 'good' | 'bad' | 'neutral';
export const TONE_CLASS: Record<Tone, string> = { good: 'text-primary', bad: 'text-destructive', neutral: 'text-muted-foreground' };
export type Delta = { direction: 'up' | 'down' | 'flat'; tone: Tone; text: string };

function amountText(diff: number, unit: MetricUnit): string {
  if (unit === 'rate') return `${Math.round(diff * 100)} 个百分点`;
  if (unit === 'days') return `${diff.toFixed(1)} 天`;
  if (unit === 'perWeek') return `${diff.toFixed(1)} 条/周`;
  return String(diff);
}

/** 与上一个同长度时间段相比；任一侧没有数据时不显示。比例差不足 0.5 个百分点、其他差不足 0.05 视为持平。 */
export function cardDelta(pair: { value: number | null; previous: number | null }, unit: MetricUnit, better: 'up' | 'down'): Delta | null {
  if (pair.value === null || pair.previous === null) return null;
  const diff = pair.value - pair.previous;
  if (Math.abs(diff) < (unit === 'rate' ? 0.005 : 0.05)) return { direction: 'flat', tone: 'neutral', text: '与上期持平' };
  const direction = diff > 0 ? 'up' : 'down';
  return { direction, tone: direction === better ? 'good' : 'bad', text: `比上期${direction === 'up' ? '升' : '降'} ${amountText(Math.abs(diff), unit)}` };
}

/** 周一日期 → 「月/日」。 */
export const weekLabel = (monday: string): string => `${Number(monday.slice(5, 7))}/${Number(monday.slice(8, 10))}`;

/** 纵轴上限：不小于最大值的 1、2、5 × 10^k；没有正数时为 1。 */
export function niceMax(values: Array<number | null>): number {
  const m = Math.max(0, ...values.filter((v): v is number => v !== null));
  if (m <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(m));
  for (const k of [1, 2, 5]) if (k * p >= m) return k * p;
  return 10 * p;
}

/** 折线坐标（保留 1 位小数）：值为 null 的周断开成多段；只有一个点时放在中间。 */
export function linePoints(values: Array<number | null>, width: number, height: number, max: number): Array<Array<{ x: number; y: number }>> {
  const n = values.length;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let cur: Array<{ x: number; y: number }> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 0) segments.push(cur);
      cur = [];
      return;
    }
    const x = n === 1 ? width / 2 : (i * width) / (n - 1);
    cur.push({ x: r1(x), y: r1(height - (Math.min(v, max) / max) * height) });
  });
  if (cur.length > 0) segments.push(cur);
  return segments;
}

/** 版本一行的结论：已发布的按期、逾期 N 天或无法判断；未发布的是否已过计划日。 */
export function releaseVerdict(r: { status: 'planned' | 'released'; dueDate: string | null; onTime: boolean | null; overdueDays: number | null }): { text: string; tone: Tone } {
  if (r.status === 'released') {
    if (r.onTime === null) return { text: '无法判断：没有计划日期', tone: 'neutral' };
    return r.onTime ? { text: '按期', tone: 'good' } : { text: `逾期 ${r.overdueDays} 天`, tone: 'bad' };
  }
  if (r.dueDate === null) return { text: '未发布，没有计划日期', tone: 'neutral' };
  return (r.overdueDays ?? 0) > 0 ? { text: `未发布，已过计划日 ${r.overdueDays} 天`, tone: 'bad' } : { text: '未发布', tone: 'neutral' };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @flower/web exec vitest run src/features/dashboard/model.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 6: lint、类型检查并提交**

Run: `pnpm --filter @flower/web lint --max-warnings 0` 与 `pnpm typecheck`
Expected: 0 错误 0 警告；类型检查无错误

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/features/dashboard/model.ts apps/web/src/features/dashboard/model.test.ts
git commit -m "feat(web): 看板数据层与纯逻辑（筛选与地址、格式化、上期对比、口径文案、图表坐标）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 产品看板页：筛选栏、关键数字、趋势与主导航「看板」

**Files:**
- Create: `apps/web/src/features/dashboard/components/metric-help.tsx`
- Create: `apps/web/src/features/dashboard/components/metric-cards.tsx`
- Create: `apps/web/src/features/dashboard/components/filter-bar.tsx`
- Create: `apps/web/src/features/dashboard/components/invalid-filter.tsx`
- Create: `apps/web/src/app/(app)/[org]/dashboard/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/dashboard/trends.tsx`
- Modify: `apps/web/src/features/shell/nav.ts`、`apps/web/src/features/shell/nav.test.ts`、`apps/web/src/components/org-shell.tsx`

**Interfaces:**
- Consumes: Task 8 的 `useProducts`、`useProductDashboard`、`DashboardFilter`、`DEFAULT_FILTER`、`RANGE_OPTIONS`、`filterFromParams`、`filterQuery`、`rangeValue`、`dashboardHref`、`customRangeError`、`windowText`、`METRIC_HELP`、`CARD_SPECS`、`formatMetric`、`formatDays`、`cardDelta`、`emptyReason`、`TONE_CLASS`、`weekLabel`、`niceMax`、`linePoints`；类型 `ProductDashboard`、`DashboardCards`
- Produces:
  - `MetricHelp({ label, text }: { label: string; text: string })`：按钮的无障碍名称为 `{label}的口径`，悬停或聚焦显示 `text`
  - `MetricCards({ cards, completedCount }: { cards: DashboardCards; completedCount: number })`：六张卡片，每张是 `section aria-label={标签}`
  - `FilterBar({ filter, window, iterations?, onChange })`：`window: ProductDashboard['window']`；`iterations` 不传时不显示「按迭代」（组织汇总用）；时间段下拉框名为「时间段」，迭代下拉框名为「迭代」，自定义日期框名为「开始日期」「结束日期」，按钮「应用」「按迭代」，时间段说明 `aria-label="统计时间段"`
  - `InvalidFilter({ message, onReset }: { message: string; onReset: () => void })`
  - `Trends({ weeks }: { weeks: ProductDashboard['weeks'] })`：三张图，每张带 `sr-only` 数据表，表名分别为「每周吞吐量」「在制品周趋势」「前置时间与流动时间（85 分位）」
  - 页面 `/[org]/dashboard`：`Sections({ org, data })` 组件，Task 10 往里加区块
  - 导航：`NavIcon` 增加 `'chart'`；主导航第三项 `{ key: 'product-dashboard', label: '看板', href: '/{org}/dashboard', icon: 'chart' }`；`activeNavKey` 对 `/{org}/dashboard` 返回 `'product-dashboard'`

- [ ] **Step 1: 改导航测试（先失败）**

`apps/web/src/features/shell/nav.test.ts`：把第一个用例里主导航的期望改为：

```ts
    expect(nav.main.map((i) => [i.label, i.href ?? null])).toEqual([
      ['工作台', '/acme'],
      ['概览', '/acme/overview'],
      ['看板', '/acme/dashboard'],
      ['需求', '/acme/requirements'],
      ['迭代', '/acme/iterations'],
      ['评审', '/acme/reviews'],
      ['文档', '/acme/documents'],
    ]);
```

在「根据路径判断当前导航项」用例末尾加：

```ts
    expect(activeNavKey('/acme/dashboard', 'acme')).toBe('product-dashboard');
```

Run: `pnpm --filter @flower/web exec vitest run src/features/shell/nav.test.ts`
Expected: FAIL（主导航少了「看板」；`/acme/dashboard` 返回 `home`）

- [ ] **Step 2: 改导航与图标**

`apps/web/src/features/shell/nav.ts`：

1. `NavIcon` 联合类型末尾加 `| 'chart'`：

```ts
export type NavIcon = 'home' | 'grid' | 'list' | 'cycle' | 'review' | 'doc' | 'users' | 'tag' | 'box' | 'flow' | 'sliders' | 'bot' | 'building' | 'bell' | 'chart';
```

2. `main` 数组里「概览」之后加：

```ts
      { key: 'product-dashboard', label: '看板', href: `/${org}/dashboard`, icon: 'chart' },
```

3. `activeNavKey` 里 `if (/^\/overview(\/|$)/.test(rest)) return 'overview';` 之后加：

```ts
  // 主导航「看板」与组织设置「看板」（键 dashboard）同名，主导航用另一个键，避免两项同时高亮
  if (/^\/dashboard(\/|$)/.test(rest)) return 'product-dashboard';
```

`apps/web/src/components/org-shell.tsx`：`lucide-react` 的导入里加 `ChartColumn,`（放在 `Building2,` 之后），`ICONS` 里加一行：

```ts
  chart: ChartColumn,
```

Run: `pnpm --filter @flower/web exec vitest run src/features/shell/nav.test.ts`
Expected: PASS

- [ ] **Step 3: 写共享组件**

`apps/web/src/features/dashboard/components/metric-help.tsx`：

```tsx
'use client';

import { CircleHelp } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** 指标旁的「?」：悬停或键盘聚焦时显示口径。 */
export function MetricHelp({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`${label}的口径`} className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground">
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{text}</TooltipContent>
    </Tooltip>
  );
}
```

`apps/web/src/features/dashboard/components/metric-cards.tsx`：

```tsx
'use client';

import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { CARD_SPECS, cardDelta, emptyReason, formatMetric, METRIC_HELP, TONE_CLASS } from '@/features/dashboard/model';
import type { DashboardCards } from '@/lib/types';
import { cn } from '@/lib/utils';
import { MetricHelp } from './metric-help';

/** 六个关键数字：数值、口径说明，以及与上一个同长度时间段相比的升降；没有数据时显示原因。 */
export function MetricCards({ cards, completedCount }: { cards: DashboardCards; completedCount: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {CARD_SPECS.map((s) => {
        const pair = cards[s.key];
        const delta = cardDelta(pair, s.unit, s.better);
        const Icon = delta?.direction === 'up' ? TrendingUp : delta?.direction === 'down' ? TrendingDown : Minus;
        return (
          <section key={s.key} aria-label={s.label} className="flex min-w-0 flex-col gap-1 rounded-md border bg-card p-3">
            <div className="flex items-center gap-1 text-[13px] text-muted-foreground">
              <span className="truncate">{s.label}</span>
              <MetricHelp label={s.label} text={METRIC_HELP[s.help]} />
            </div>
            <div className={cn('font-mono text-xl font-semibold', pair.value === null && 'text-base font-normal text-muted-foreground')}>{formatMetric(pair.value, s.unit)}</div>
            {pair.value === null ? (
              <p className="text-xs text-muted-foreground">{emptyReason(s.key, completedCount)}</p>
            ) : delta ? (
              <p className={cn('flex items-center gap-1 text-xs', TONE_CLASS[delta.tone])}>
                <Icon className="size-3.5" aria-hidden="true" />
                {delta.text}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">上期暂无数据</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
```

`apps/web/src/features/dashboard/components/filter-bar.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { customRangeError, type DashboardFilter, DEFAULT_FILTER, RANGE_OPTIONS, rangeValue, windowText } from '@/features/dashboard/model';
import type { ProductDashboard } from '@/lib/types';

type WindowData = ProductDashboard['window'];
type IterationOption = ProductDashboard['iterationOptions'][number];

/** 自定义时间段：填好两个日期后点「应用」才生效；不合法时显示原因并禁用「应用」。 */
function CustomRange({ initial, today, onApply }: { initial: { from: string; to: string }; today: string; onApply: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const error = customRangeError(from, to, today);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input type="date" aria-label="开始日期" className="h-8 w-40" max={today} value={from} onChange={(e) => setFrom(e.target.value)} />
      <span className="text-[13px] text-muted-foreground">至</span>
      <Input type="date" aria-label="结束日期" className="h-8 w-40" max={today} value={to} onChange={(e) => setTo(e.target.value)} />
      <Button size="sm" variant="outline" disabled={error !== null} onClick={() => onApply(from, to)}>
        应用
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

/**
 * 筛选栏：近 30 / 90 / 180 天、自定义，与「按迭代」切换（只在传入 iterations 时显示）。
 * 筛选写在地址栏，由调用方通过 onChange 改写；调用方用 key 在筛选变化时重新挂载本组件。
 */
export function FilterBar({
  filter,
  window,
  iterations,
  onChange,
}: {
  filter: DashboardFilter;
  window: WindowData;
  iterations?: IterationOption[];
  onChange: (f: DashboardFilter) => void;
}) {
  const [customOpen, setCustomOpen] = useState(filter.kind === 'custom');
  const byIteration = filter.kind === 'iteration';
  const showCustom = !byIteration && customOpen;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {iterations && (
          <Button
            size="sm"
            variant={byIteration ? 'secondary' : 'outline'}
            aria-pressed={byIteration}
            disabled={!byIteration && iterations.length === 0}
            title={iterations.length === 0 ? '还没有已开始的迭代' : undefined}
            onClick={() => onChange(byIteration ? DEFAULT_FILTER : { kind: 'iteration', iterationId: iterations[0]!.id })}
          >
            按迭代
          </Button>
        )}
        {byIteration ? (
          <Select value={filter.iterationId} onValueChange={(v) => onChange({ kind: 'iteration', iterationId: v })}>
            <SelectTrigger className="h-8 w-72 max-w-full" aria-label="迭代">
              <SelectValue placeholder="选择迭代" />
            </SelectTrigger>
            <SelectContent>
              {(iterations ?? []).map((it) => (
                <SelectItem key={it.id} value={it.id}>
                  {it.name}（{it.startDate} 至 {it.endDate}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Select
            value={showCustom ? 'custom' : rangeValue(filter)}
            onValueChange={(v) => {
              if (v === 'custom') {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              onChange({ kind: 'days', days: v === '30' ? 30 : v === '180' ? 180 : 90 });
            }}
          >
            <SelectTrigger className="h-8 w-32" aria-label="时间段">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {showCustom && <CustomRange initial={{ from: window.from, to: window.to }} today={window.today} onApply={(from, to) => onChange({ kind: 'custom', from, to })} />}
      </div>
      <p aria-label="统计时间段" className="text-[13px] text-muted-foreground">
        {windowText(window)}
      </p>
    </div>
  );
}
```

`apps/web/src/features/dashboard/components/invalid-filter.tsx`：

```tsx
import { Button } from '@/components/ui/button';

/** 地址栏里的时间段参数不合法（接口返回 400）：显示原因，一键恢复默认时间段，而不是反复重试。 */
export function InvalidFilter({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onReset}>
        恢复默认时间段
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: 写趋势图**

`apps/web/src/app/(app)/[org]/dashboard/trends.tsx`：

```tsx
'use client';

import type { ReactNode } from 'react';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatDays, linePoints, METRIC_HELP, niceMax, weekLabel } from '@/features/dashboard/model';
import type { ProductDashboard } from '@/lib/types';

type Week = ProductDashboard['weeks'][number];
type Row = { key: string; label: string; value: string };
type Series = { label: string; values: Array<number | null>; stroke: string; swatch: string };

const W = 600;
const H = 160;

/** 图表外框：标题与口径、纵轴上限、周标签（最多约 6 个）、图例，以及给读屏器的数据表。 */
function Frame({ title, help, max, weeks, rows, legend, children }: { title: string; help: string; max: number; weeks: Week[]; rows: Row[]; legend?: ReactNode; children: ReactNode }) {
  const step = Math.max(1, Math.ceil(weeks.length / 6));
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-md border bg-card p-3">
      <div className="flex items-center gap-1">
        <h3 className="truncate text-sm font-semibold">{title}</h3>
        <MetricHelp label={title} text={help} />
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">纵轴 0–{max}</span>
      </div>
      {children}
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground" aria-hidden="true">
        {weeks.map((w, i) => (
          <span key={w.week}>{i % step === 0 || i === weeks.length - 1 ? weekLabel(w.week) : ''}</span>
        ))}
      </div>
      {legend}
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BarChart({ title, help, weeks, values }: { title: string; help: string; weeks: Week[]; values: number[] }) {
  const max = niceMax(values);
  const slot = W / Math.max(1, values.length);
  return (
    <Frame title={title} help={help} max={max} weeks={weeks} rows={weeks.map((w, i) => ({ key: w.week, label: `${weekLabel(w.week)} 起一周`, value: String(values[i]) }))}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" className="h-40 w-full">
        <line x1={0} y1={H} x2={W} y2={H} className="stroke-border" vectorEffect="non-scaling-stroke" />
        {values.map((v, i) => {
          const h = (v / max) * H;
          return <rect key={weeks[i]!.week} x={i * slot + slot * 0.15} y={H - h} width={slot * 0.7} height={h} className="fill-primary" />;
        })}
      </svg>
    </Frame>
  );
}

function LineChart({ title, help, weeks, series, format }: { title: string; help: string; weeks: Week[]; series: Series[]; format: (v: number | null) => string }) {
  const max = niceMax(series.flatMap((s) => s.values));
  const rows = weeks.map((w, i) => ({ key: w.week, label: `${weekLabel(w.week)} 起一周`, value: series.map((s) => `${s.label} ${format(s.values[i] ?? null)}`).join('，') }));
  const legend = (
    <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
      {series.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1">
          <span className={`inline-block h-0.5 w-3 ${s.swatch}`} aria-hidden="true" />
          {s.label}
        </span>
      ))}
    </div>
  );
  return (
    <Frame title={title} help={help} max={max} weeks={weeks} rows={rows} legend={legend}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" className="h-40 w-full">
        <line x1={0} y1={H} x2={W} y2={H} className="stroke-border" vectorEffect="non-scaling-stroke" />
        {series.map((s) =>
          linePoints(s.values, W, H, max).map((seg, k) => {
            // 前后都断开的单独一周画成一小段横线
            const pts = seg.length === 1 ? [{ x: seg[0]!.x - 4, y: seg[0]!.y }, { x: seg[0]!.x + 4, y: seg[0]!.y }] : seg;
            return (
              <polyline
                key={`${s.label}-${k}`}
                points={pts.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                fill="none"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                className={s.stroke}
              />
            );
          }),
        )}
      </svg>
    </Frame>
  );
}

/** 趋势：每周吞吐量、在制品周趋势、前置时间与流动时间的 85 分位走势。 */
export function Trends({ weeks }: { weeks: Week[] }) {
  return (
    <section aria-label="趋势" className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">趋势</h2>
      <div className="grid gap-3 lg:grid-cols-3">
        <BarChart title="每周吞吐量" help={METRIC_HELP.throughput} weeks={weeks} values={weeks.map((w) => w.throughput)} />
        <LineChart
          title="在制品周趋势"
          help={METRIC_HELP.wip}
          weeks={weeks}
          format={(v) => (v === null ? '—' : String(v))}
          series={[{ label: '在制品', values: weeks.map((w) => w.wip), stroke: 'stroke-amber-600', swatch: 'bg-amber-600' }]}
        />
        <LineChart
          title="前置时间与流动时间（85 分位）"
          help={`${METRIC_HELP.leadTime}${METRIC_HELP.flowTime}每周取当周完成的需求计算 85 分位。`}
          weeks={weeks}
          format={formatDays}
          series={[
            { label: '前置时间', values: weeks.map((w) => w.leadP85), stroke: 'stroke-primary', swatch: 'bg-primary' },
            { label: '流动时间', values: weeks.map((w) => w.flowP85), stroke: 'stroke-amber-600', swatch: 'bg-amber-600' },
          ]}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 5: 写页面**

`apps/web/src/app/(app)/[org]/dashboard/page.tsx`：

```tsx
'use client';

import { ChartColumn } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { FilterBar } from '@/features/dashboard/components/filter-bar';
import { InvalidFilter } from '@/features/dashboard/components/invalid-filter';
import { MetricCards } from '@/features/dashboard/components/metric-cards';
import { type DashboardFilter, DEFAULT_FILTER, dashboardHref, filterFromParams, filterQuery } from '@/features/dashboard/model';
import { ApiError } from '@/lib/api';
import { useProductDashboard, useProducts } from '@/lib/queries';
import type { ProductDashboard } from '@/lib/types';
import { Trends } from './trends';

/** 筛选栏之下的各区块，自上而下与设计 §4.1 一致。 */
function Sections({ data }: { org: string; data: ProductDashboard }) {
  return (
    <>
      <MetricCards cards={data.cards} completedCount={data.completedCount} />
      <Trends weeks={data.weeks} />
    </>
  );
}

function DashboardPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const products = useProducts(org);
  const product = (products.data ?? []).find((p) => p.id === params.get('product')) ?? products.data?.[0];
  const filter = filterFromParams(params);
  const query = filterQuery(filter);
  const q = useProductDashboard(org, product?.id, query);
  const go = (productId: string, f: DashboardFilter) => router.replace(dashboardHref(org, productId, f), { scroll: false });

  let body: ReactNode;
  if (!products.data && products.isError) {
    body = <QueryError error={products.error} noAccessMessage="组织不存在，或者你没有查看权限。" retryMessage="加载产品列表失败，请重试。" onRetry={() => products.refetch()} />;
  } else if (products.data && products.data.length === 0) {
    body = <EmptyState icon={ChartColumn} title="还没有产品" description="组织管理员新建产品后，这里显示产品的需求流速、版本与评审数据。" />;
  } else if (!q.data) {
    if (q.error instanceof ApiError && q.error.status === 400 && product) {
      body = <InvalidFilter message={q.error.message} onReset={() => go(product.id, DEFAULT_FILTER)} />;
    } else if (q.isError) {
      body = <QueryError error={q.error} noAccessMessage="产品不存在，或你没有查看权限。" retryMessage="加载看板失败，请重试。" onRetry={() => q.refetch()} />;
    } else {
      body = <Skeleton className="h-64" />;
    }
  } else {
    const data = q.data;
    body = (
      <>
        <FilterBar key={`${data.product.id}:${query}`} filter={filter} window={data.window} iterations={data.iterationOptions} onChange={(f) => go(data.product.id, f)} />
        <Sections org={org} data={data} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="看板"
        description="打开时按当前数据计算；时间段与周按组织时区划分，周从周一开始；已删除的需求不计。"
        actions={
          (products.data?.length ?? 0) > 1 &&
          product && (
            <Select value={product.id} onValueChange={(v) => go(v, DEFAULT_FILTER)}>
              <SelectTrigger className="h-8 w-40" aria-label="产品">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {products.data!.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        }
      />
      {body}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <DashboardPage />
    </Suspense>
  );
}
```

说明：`Sections` 的 `org` 参数在本任务里还没用到（Task 10 的「停留最久的需求」用它拼链接），解构时只取 `data`，避免未使用变量的 lint 警告。

- [ ] **Step 6: lint、类型检查与单测**

Run: `pnpm --filter @flower/web lint --max-warnings 0`、`pnpm typecheck`、`pnpm --filter @flower/web exec vitest run src/features`
Expected: 0 错误 0 警告；类型检查无错误；单测通过

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/dashboard/components apps/web/src/app/\(app\)/\[org\]/dashboard apps/web/src/features/shell/nav.ts apps/web/src/features/shell/nav.test.ts apps/web/src/components/org-shell.tsx
git commit -m "feat(web): 产品看板页（筛选栏、关键数字与口径、周趋势图）与主导航「看板」

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 产品看板页：卡在哪儿、迭代与版本、专项、评审

**Files:**
- Create: `apps/web/src/app/(app)/[org]/dashboard/stuck.tsx`
- Create: `apps/web/src/app/(app)/[org]/dashboard/delivery.tsx`
- Create: `apps/web/src/app/(app)/[org]/dashboard/specials.tsx`
- Create: `apps/web/src/app/(app)/[org]/dashboard/review.tsx`
- Modify: `apps/web/src/app/(app)/[org]/dashboard/page.tsx`（`Sections` 加四个区块）

**Interfaces:**
- Consumes: Task 8 的 `METRIC_HELP`、`formatDays`、`formatRate`、`releaseVerdict`、`TONE_CLASS`；Task 9 的 `MetricHelp`、`Sections`；`ITERATION_STATUS_LABEL`（`apps/web/src/lib/labels.ts`）；类型 `ProductDashboard`
- Produces:
  - `StuckSection({ org, stuck })`：`section aria-label="卡在哪儿"`；表「各状态停留」「停留最久的需求」（编号与标题链接到 `/{org}/requirements/{编号}`）
  - `DeliverySection({ iterations, releases })`：`section aria-label="迭代承诺"`（表「迭代承诺」）与 `section aria-label="版本"`（表「版本」）
  - `SpecialsSection({ specials })`：`section aria-label="专项"`，每个专项一个 `role="progressbar"`，名称为专项名
  - `ReviewSection({ review })`：`section aria-label="评审"`，表「各检查项评审」
  - 空数据文案：「暂无数据：当前没有处于进行中类状态的需求」「暂无数据：时间段内还没有在 Flower 里开始的迭代」「还没有在 Flower 里开始的迭代：…」「暂无数据：没有已发布或计划中的版本」「暂无数据：时间段内没有包含本产品需求的专项」「暂无数据：还没有在 Flower 里评审过的检查项」「暂无数据：时间段内没有有结论的检查项」

- [ ] **Step 1: 写「卡在哪儿」**

`apps/web/src/app/(app)/[org]/dashboard/stuck.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatDays, METRIC_HELP } from '@/features/dashboard/model';
import type { ProductDashboard } from '@/lib/types';

function StateDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

/** 卡在哪儿：当前各进行中状态的需求数与平均停留（停留降序），以及停留最久的前 10 条需求。 */
export function StuckSection({ org, stuck }: { org: string; stuck: ProductDashboard['stuck'] }) {
  return (
    <section aria-label="卡在哪儿" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <h2 className="text-base font-semibold">卡在哪儿</h2>
        <MetricHelp label="卡在哪儿" text={METRIC_HELP.stuck} />
        <span className="text-xs text-muted-foreground">按当前数据，不受时间段影响</span>
      </div>
      {stuck.states.length === 0 ? (
        <p className="rounded-md border bg-card px-3 py-6 text-center text-[13px] text-muted-foreground">暂无数据：当前没有处于进行中类状态的需求</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="min-w-0 rounded-md border bg-card">
            <Table aria-label="各状态停留">
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead className="w-20 text-right">需求数</TableHead>
                  <TableHead className="w-28 text-right">平均停留</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stuck.states.map((s) => (
                  <TableRow key={s.key} className="h-10 even:bg-zebra">
                    <TableCell className="text-[13px]">
                      <StateDot color={s.color} label={s.label} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{s.count}</TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{formatDays(s.avgDays)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="min-w-0 rounded-md border bg-card">
            <Table aria-label="停留最久的需求">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">编号</TableHead>
                  <TableHead>标题</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-24 text-right">停留</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stuck.oldest.map((r) => (
                  <TableRow key={r.id} className="h-10 even:bg-zebra">
                    <TableCell className="font-mono text-[13px]">
                      <Link href={`/${org}/requirements/${r.displayKey}`} className="hover:underline">
                        {r.displayKey}
                      </Link>
                    </TableCell>
                    <TableCell className="text-[13px]">
                      <Link href={`/${org}/requirements/${r.displayKey}`} className="block max-w-64 truncate hover:underline" title={r.title}>
                        {r.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-[13px]">
                      <StateDot color={r.state.color} label={r.state.label} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{formatDays(r.days)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 写「迭代与版本」**

`apps/web/src/app/(app)/[org]/dashboard/delivery.tsx`：

```tsx
'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatRate, METRIC_HELP, releaseVerdict, TONE_CLASS } from '@/features/dashboard/model';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import type { ProductDashboard } from '@/lib/types';
import { cn } from '@/lib/utils';

function Empty({ text }: { text: string }) {
  return <p className="rounded-md border bg-card px-3 py-6 text-center text-[13px] text-muted-foreground">{text}</p>;
}

function IterationTable({ rows }: { rows: ProductDashboard['iterations'] }) {
  return (
    <section aria-label="迭代承诺" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-semibold">迭代承诺完成率</h3>
        <MetricHelp label="迭代承诺完成率" text={METRIC_HELP.commitment} />
      </div>
      {rows.length === 0 ? (
        <Empty text="暂无数据：时间段内还没有在 Flower 里开始的迭代" />
      ) : (
        <>
          {rows.every((r) => !r.hasSnapshot) && (
            <p role="note" className="rounded-md border bg-muted px-3 py-2 text-[13px]">
              还没有在 Flower 里开始的迭代：以下迭代没有承诺范围快照（如迁移来的历史迭代），承诺完成率显示「暂无数据」。
            </p>
          )}
          <div className="min-w-0 rounded-md border bg-card">
            <Table aria-label="迭代承诺">
              <TableHeader>
                <TableRow>
                  <TableHead>迭代</TableHead>
                  <TableHead className="w-48">时间</TableHead>
                  <TableHead className="w-20">状态</TableHead>
                  <TableHead className="w-28 text-right">承诺完成率</TableHead>
                  <TableHead className="w-24 text-right">完成 / 承诺</TableHead>
                  <TableHead className="w-20 text-right">中途加入</TableHead>
                  <TableHead className="w-16 text-right">移出</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="h-10 even:bg-zebra">
                    <TableCell className="text-[13px]">{r.name}</TableCell>
                    <TableCell className="font-mono text-[12px]">
                      {r.startDate} 至 {r.endDate}
                    </TableCell>
                    <TableCell className="text-[13px]">{ITERATION_STATUS_LABEL[r.status]}</TableCell>
                    <TableCell className={cn('text-right font-mono text-[13px]', r.rate === null && 'text-muted-foreground')} title={r.hasSnapshot ? undefined : '没有承诺范围快照'}>
                      {formatRate(r.rate)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{r.hasSnapshot ? `${r.completed} / ${r.committed - r.canceled}` : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{r.added}</TableCell>
                    <TableCell className="text-right font-mono text-[13px]">{r.hasSnapshot ? r.removed : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  );
}

function ReleaseTable({ releases }: { releases: ProductDashboard['releases'] }) {
  return (
    <section aria-label="版本" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        <h3 className="text-sm font-semibold">版本</h3>
        <MetricHelp label="版本按期达成率" text={METRIC_HELP.releaseOnTime} />
        <span className="ml-2 text-[13px] text-muted-foreground">
          按期达成率 <span className="font-mono text-foreground">{formatRate(releases.onTimeRate)}</span>（可判断 {releases.evaluated} 个，按期 {releases.onTime} 个）
        </span>
      </div>
      {releases.rows.length === 0 ? (
        <Empty text="暂无数据：没有已发布或计划中的版本" />
      ) : (
        <div className="min-w-0 rounded-md border bg-card">
          <Table aria-label="版本">
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead className="w-48">计划日</TableHead>
                <TableHead className="w-28">实际发布日</TableHead>
                <TableHead className="w-48">是否按期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {releases.rows.map((r) => {
                const verdict = releaseVerdict(r);
                return (
                  <TableRow key={r.id} className="h-10 even:bg-zebra">
                    <TableCell className="font-mono text-[13px]">{r.versionName}</TableCell>
                    <TableCell className="text-[13px]">
                      <span className="font-mono">{r.dueDate ?? '—'}</span>
                      {r.dueSource === 'iteration' && <span className="ml-1.5 rounded-sm bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">按迭代结束日计</span>}
                    </TableCell>
                    <TableCell className="font-mono text-[13px]">{r.releasedOn ?? '未发布'}</TableCell>
                    <TableCell className={cn('text-[13px]', TONE_CLASS[verdict.tone])}>{verdict.text}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

/** 迭代与版本：每个迭代一行（承诺完成率、中途加入与移出）；每个版本一行（计划日、实际发布日、是否按期）。 */
export function DeliverySection({ iterations, releases }: { iterations: ProductDashboard['iterations']; releases: ProductDashboard['releases'] }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">迭代与版本</h2>
      <IterationTable rows={iterations} />
      <ReleaseTable releases={releases} />
    </div>
  );
}
```

- [ ] **Step 3: 写「专项」与「评审」**

`apps/web/src/app/(app)/[org]/dashboard/specials.tsx`：

```tsx
'use client';

import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatRate, METRIC_HELP } from '@/features/dashboard/model';
import { ITERATION_STATUS_LABEL } from '@/lib/labels';
import type { ProductDashboard } from '@/lib/types';

/** 专项：每个专项的完成率进度条（只统计本产品的需求）。 */
export function SpecialsSection({ specials }: { specials: ProductDashboard['specials'] }) {
  return (
    <section aria-label="专项" className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <h2 className="text-base font-semibold">专项</h2>
        <MetricHelp label="专项完成率" text={METRIC_HELP.special} />
      </div>
      {specials.length === 0 ? (
        <p className="rounded-md border bg-card px-3 py-6 text-center text-[13px] text-muted-foreground">暂无数据：时间段内没有包含本产品需求的专项</p>
      ) : (
        <ul className="flex flex-col gap-3 rounded-md border bg-card p-3">
          {specials.map((s) => {
            const pct = Math.round((s.rate ?? 0) * 100);
            return (
              <li key={s.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-muted-foreground">
                    {ITERATION_STATUS_LABEL[s.status]} · {s.startDate} 至 {s.endDate}
                  </span>
                  <span className="ml-auto font-mono">
                    {formatRate(s.rate)}（{s.completed} / {s.total - s.canceled}）
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label={s.name}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={s.rate === null ? undefined : pct}
                  className="h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/dashboard/review.tsx`：

```tsx
'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatDays, formatRate, METRIC_HELP } from '@/features/dashboard/model';
import type { ProductDashboard } from '@/lib/types';

/** 评审：各检查项的评审天数中位数与驳回率；注明统计起点（迁移来的历史评审不计入）。 */
export function ReviewSection({ review }: { review: ProductDashboard['review'] }) {
  return (
    <section aria-label="评审" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <h2 className="text-base font-semibold">评审</h2>
        <MetricHelp label="评审效率与驳回率" text={`${METRIC_HELP.reviewDays}${METRIC_HELP.rejection}`} />
        {review.since && <span className="text-xs text-muted-foreground">统计起点 {review.since}：只统计在 Flower 里记录的检查项变化，迁移来的历史评审不计入</span>}
      </div>
      {review.items.length === 0 ? (
        <p className="rounded-md border bg-card px-3 py-6 text-center text-[13px] text-muted-foreground">
          {review.since ? '暂无数据：时间段内没有有结论的检查项' : '暂无数据：还没有在 Flower 里评审过的检查项'}
        </p>
      ) : (
        <div className="min-w-0 rounded-md border bg-card">
          <Table aria-label="各检查项评审">
            <TableHeader>
              <TableRow>
                <TableHead>检查项</TableHead>
                <TableHead className="w-20 text-right">通过数</TableHead>
                <TableHead className="w-32 text-right">评审天数中位数</TableHead>
                <TableHead className="w-20 text-right">有结论</TableHead>
                <TableHead className="w-20 text-right">驳回过</TableHead>
                <TableHead className="w-20 text-right">驳回率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {review.items.map((i) => (
                <TableRow key={i.itemKey} className="h-10 even:bg-zebra">
                  <TableCell className="text-[13px]">{i.label}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{i.passed}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{formatDays(i.medianDays)}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{i.concluded}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{i.rejected}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{formatRate(i.rejectionRate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: 把四个区块接入页面**

`apps/web/src/app/(app)/[org]/dashboard/page.tsx`：

1. 在 `import { Trends } from './trends';` 之前加：

```tsx
import { DeliverySection } from './delivery';
import { ReviewSection } from './review';
import { SpecialsSection } from './specials';
import { StuckSection } from './stuck';
```

2. 把 `Sections` 整个替换为：

```tsx
/** 筛选栏之下的各区块，自上而下与设计 §4.1 一致。 */
function Sections({ org, data }: { org: string; data: ProductDashboard }) {
  return (
    <>
      <MetricCards cards={data.cards} completedCount={data.completedCount} />
      <Trends weeks={data.weeks} />
      <StuckSection org={org} stuck={data.stuck} />
      <DeliverySection iterations={data.iterations} releases={data.releases} />
      <SpecialsSection specials={data.specials} />
      <ReviewSection review={data.review} />
    </>
  );
}
```

- [ ] **Step 5: lint 与类型检查**

Run: `pnpm --filter @flower/web lint --max-warnings 0` 与 `pnpm typecheck`
Expected: 0 错误 0 警告；类型检查无错误

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/app/\(app\)/\[org\]/dashboard
git commit -m "feat(web): 产品看板的卡在哪儿、迭代与版本、专项、评审区块

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 组织汇总页与组织设置「看板」

**Files:**
- Create: `apps/web/src/app/(app)/[org]/settings/dashboard/page.tsx`
- Modify: `apps/web/src/features/shell/nav.ts`、`apps/web/src/features/shell/nav.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `useOrgDashboard`、`filterFromParams(params, false)`、`filterQuery`、`orgDashboardHref`、`dashboardHref`、`CARD_SPECS`、`cardDelta`、`formatMetric`、`emptyReason`、`METRIC_HELP`、`TONE_CLASS`；Task 9 的 `FilterBar`（不传 `iterations`）、`InvalidFilter`、`MetricHelp`；`RequireOrgAdmin`
- Produces:
  - 页面 `/[org]/settings/dashboard`：表「各产品关键数字」，每个产品一行，产品名链接到同一时间段的产品看板
  - 导航：组织设置「推送」之后加 `['dashboard', '看板', 'chart']`（`/{org}/settings/dashboard`，键 `dashboard`）

- [ ] **Step 1: 改导航测试（先失败）**

`apps/web/src/features/shell/nav.test.ts`：把第一个用例里设置分组的期望改为：

```ts
    expect(nav.settings.map((i) => i.href)).toEqual([
      '/acme/settings/members',
      '/acme/settings/tags',
      '/acme/settings/products',
      '/acme/settings/workflows',
      '/acme/settings/fields',
      '/acme/settings/templates',
      '/acme/settings/agents',
      '/acme/settings/notifications',
      '/acme/settings/dashboard',
      '/acme/settings/general',
    ]);
```

在「根据路径判断当前导航项」用例末尾加：

```ts
    expect(activeNavKey('/acme/settings/dashboard', 'acme')).toBe('dashboard');
```

Run: `pnpm --filter @flower/web exec vitest run src/features/shell/nav.test.ts`
Expected: FAIL（设置分组少了「看板」）

- [ ] **Step 2: 改导航**

`apps/web/src/features/shell/nav.ts` 的 `SETTINGS` 数组里，`['notifications', '推送', 'bell'],` 之后加：

```ts
  ['dashboard', '看板', 'chart'],
```

Run: `pnpm --filter @flower/web exec vitest run src/features/shell/nav.test.ts`
Expected: PASS

- [ ] **Step 3: 写组织汇总页**

`apps/web/src/app/(app)/[org]/settings/dashboard/page.tsx`：

```tsx
'use client';

import { ChartColumn } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FilterBar } from '@/features/dashboard/components/filter-bar';
import { InvalidFilter } from '@/features/dashboard/components/invalid-filter';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import {
  CARD_SPECS,
  cardDelta,
  type DashboardFilter,
  DEFAULT_FILTER,
  dashboardHref,
  emptyReason,
  filterFromParams,
  filterQuery,
  formatMetric,
  METRIC_HELP,
  orgDashboardHref,
  TONE_CLASS,
} from '@/features/dashboard/model';
import { ApiError } from '@/lib/api';
import { useOrgDashboard } from '@/lib/queries';
import type { OrgDashboard } from '@/lib/types';
import { cn } from '@/lib/utils';

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;

/** 每个产品一行，列出六个关键数字；箭头表示与上期相比的升降，颜色表示变好或变差。 */
function SummaryTable({ org, data, filter }: { org: string; data: OrgDashboard; filter: DashboardFilter }) {
  return (
    <div className="min-w-0 rounded-md border bg-card">
      <Table aria-label="各产品关键数字">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 min-w-36 bg-card">产品</TableHead>
            {CARD_SPECS.map((s) => (
              <TableHead key={s.key} className="min-w-32">
                <span className="inline-flex items-center gap-1">
                  {s.label}
                  <MetricHelp label={s.label} text={METRIC_HELP[s.help]} />
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.products.map((p) => (
            <TableRow key={p.id} className="group h-10 even:bg-zebra">
              <TableCell className="sticky left-0 z-10 bg-card group-even:bg-zebra">
                <Link href={dashboardHref(org, p.id, filter)} className="hover:underline">
                  {p.name}
                </Link>
                <span className="ml-1.5 font-mono text-xs text-muted-foreground">{p.key}</span>
              </TableCell>
              {CARD_SPECS.map((s) => {
                const pair = p.cards[s.key];
                const delta = cardDelta(pair, s.unit, s.better);
                return (
                  <TableCell
                    key={s.key}
                    className={cn('font-mono text-[13px]', pair.value === null && 'text-muted-foreground')}
                    title={pair.value === null ? emptyReason(s.key, p.completedCount) : undefined}
                  >
                    {formatMetric(pair.value, s.unit)}
                    {delta && (
                      <span className={cn('ml-1 text-xs', TONE_CLASS[delta.tone])} title={delta.text}>
                        {ARROW[delta.direction]}
                        <span className="sr-only">{delta.text}</span>
                      </span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function OrgDashboardPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const filter = filterFromParams(params, false);
  const query = filterQuery(filter);
  const q = useOrgDashboard(org, query);
  const go = (f: DashboardFilter) => router.replace(orgDashboardHref(org, f), { scroll: false });

  let body: ReactNode;
  if (!q.data) {
    if (q.error instanceof ApiError && q.error.status === 400) body = <InvalidFilter message={q.error.message} onReset={() => go(DEFAULT_FILTER)} />;
    else if (q.isError) body = <QueryError error={q.error} noAccessMessage="你没有查看组织汇总的权限。" retryMessage="加载组织汇总失败，请重试。" onRetry={() => q.refetch()} />;
    else body = <Skeleton className="h-40" />;
  } else {
    body = (
      <>
        <FilterBar key={query} filter={filter} window={q.data.window} onChange={go} />
        {q.data.products.length === 0 ? <EmptyState icon={ChartColumn} title="还没有产品" /> : <SummaryTable org={org} data={q.data} filter={filter} />}
      </>
    );
  }
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '看板' }]}
        title="看板"
        description="按产品对比关键数字；点击产品名称进入该产品的看板。箭头表示与上一个同长度时间段相比的升降。"
      />
      {body}
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <Suspense>
        <OrgDashboardPage />
      </Suspense>
    </RequireOrgAdmin>
  );
}
```

- [ ] **Step 4: lint、类型检查与单测**

Run: `pnpm --filter @flower/web lint --max-warnings 0`、`pnpm typecheck`、`pnpm --filter @flower/web exec vitest run src/features`
Expected: 0 错误 0 警告；类型检查无错误；单测通过

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/app/\(app\)/\[org\]/settings/dashboard apps/web/src/features/shell/nav.ts apps/web/src/features/shell/nav.test.ts
git commit -m "feat(web): 组织汇总页与组织设置「看板」

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 端到端测试（产品看板、组织汇总，1440 与 760）

**Files:**
- Modify: `apps/web/e2e/db.ts`（加 `adminSql`）
- Create: `apps/web/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: Task 9–11 的页面与无障碍名称（卡片 `region`「吞吐量（周均）」等、按钮「前置时间中位数的口径」、表「每周吞吐量」「各状态停留」「停留最久的需求」「迭代承诺」「版本」「各检查项评审」「各产品关键数字」、`progressbar`「专项甲」、下拉框「时间段」、按钮「按迭代」「应用」、日期框「开始日期」「结束日期」、`aria-label="统计时间段"`）；e2e `helpers.ts` 的 `setupInstance`、`login`、`createProduct`、`createRequirement`、`createIteration`、`acceptInvite`、`json`、`ok`、`expectNoPageOverflow`、`OWNER`
- Produces: `adminSql<T>(statement: string, params?: unknown[]): Promise<T[]>`（`apps/web/e2e/db.ts`，以 admin 角色执行一条带参数的语句，只用于把测试数据改到过去）

- [ ] **Step 1: 加 `adminSql`**

`apps/web/e2e/db.ts` 末尾加：

```ts
/** 以 admin 角色在 flower_e2e 上执行一条带参数的语句并返回结果行；只用于把测试数据的时间改到过去（流转历史、发布日等）。 */
export async function adminSql<T extends Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T[]> {
  const sql = postgres(`${ADMIN}/${E2E_DB}`, { max: 1, onnotice: () => {} });
  try {
    return (await sql.unsafe(statement, params as never[])) as unknown as T[];
  } finally {
    await sql.end();
  }
}
```

- [ ] **Step 2: 写端到端用例**

`apps/web/e2e/dashboard.spec.ts`：

```ts
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { adminSql, resetDatabase } from './db';
import { acceptInvite, createIteration, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

const STATES = [
  { key: 'backlog', label: '待处理', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
  { key: 'todo', label: '待开始', color: '#60a5fa', order: 2, group: '', category: 'unstarted' },
  { key: 'doing', label: '进行中', color: '#f59e0b', order: 3, group: '', category: 'started' },
  { key: 'done', label: '已完成', color: '#10b981', order: 4, group: '', category: 'completed' },
  { key: 'canceled', label: '已取消', color: '#9ca3af', order: 5, group: '', category: 'canceled' },
];

/** 组织时区（默认 Asia/Shanghai）下今天加 offset 天的日期。 */
async function day(offset: number): Promise<string> {
  const [row] = await adminSql<{ d: string }>(`select to_char((now() at time zone 'Asia/Shanghai')::date + $1::int, 'YYYY-MM-DD') as d`, [offset]);
  return row!.d;
}

/** 改写需求的流转历史：createdAgo 天前创建于「待处理」，steps 为依次进入的状态与「几天前」。 */
async function history(id: string, createdAgo: number, steps: Array<[string, number]>): Promise<void> {
  const rows: Array<[string | null, string, number]> = [[null, 'backlog', createdAgo]];
  let prev = 'backlog';
  for (const [to, ago] of steps) {
    rows.push([prev, to, ago]);
    prev = to;
  }
  await adminSql('delete from state_transitions where requirement_id = $1', [id]);
  for (const [from, to, ago] of rows) {
    await adminSql(
      `insert into state_transitions (id, org_id, requirement_id, from_state, to_state, at)
       select gen_random_uuid(), org_id, id, $2::text, $3::text, now() - make_interval(days => $4::int) from requirements where id = $1`,
      [id, from, to, ago],
    );
  }
  await adminSql(
    `update requirements set state_key = $2, created_at = now() - make_interval(days => $3::int), state_changed_at = now() - make_interval(days => $4::int) where id = $1`,
    [id, prev, createdAgo, rows.at(-1)![2]],
  );
}

/**
 * 网盘产品：五条需求（两条已完成、两条进行中、一条已取消）；Sprint 0（无承诺范围）与 Sprint 1（承诺范围含需求二）；
 * 版本 v1.0（按期）与 v1.1（无基线日期，按 Sprint 1 结束日计，逾期 1 天）；专项甲（需求一、三）；需求一先驳回后通过、需求二通过。
 */
async function seed(request: APIRequestContext): Promise<void> {
  await setupInstance(request);
  const pan = await createProduct(request);
  const wf = await json<{ version: { id: string } }>(
    request.post('/api/v1/orgs/acme/workflows', {
      data: {
        name: '看板流程',
        body: {
          states: STATES,
          initial: 'backlog',
          transitions: STATES.map((s) => ({ from: '*', to: s.key, conditions: [] })),
          checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
        },
      },
    }),
  );
  await ok(request.put(`/api/v1/orgs/acme/products/${pan}/workflow`, { data: { versionId: wf.version.id } }));
  const r1 = await createRequirement(request, pan, '已完成的需求一');
  const r2 = await createRequirement(request, pan, '已完成的需求二');
  const r3 = await createRequirement(request, pan, '卡住的需求');
  const r4 = await createRequirement(request, pan, '刚开始的需求');
  const r5 = await createRequirement(request, pan, '取消的需求');
  const sprint0 = await createIteration(request, pan, 'Sprint 0', await day(-60), await day(-31));
  const sprint1 = await createIteration(request, pan, 'Sprint 1', await day(-30), await day(-1));
  await ok(request.put(`/api/v1/orgs/acme/requirements/${r2.id}/iteration`, { data: { iterationId: sprint1 } }));
  for (const it of [sprint0, sprint1]) {
    for (const to of ['active', 'done']) await ok(request.post(`/api/v1/orgs/acme/iterations/${it}/status`, { data: { to } }));
  }
  const special = (
    await json<{ iteration: { id: string } }>(
      request.post('/api/v1/orgs/acme/iterations', { data: { type: 'special', name: '专项甲', startDate: await day(-30), endDate: await day(30) } }),
    )
  ).iteration.id;
  for (const r of [r1, r3]) await ok(request.put(`/api/v1/orgs/acme/requirements/${r.id}/iteration`, { data: { iterationId: special } }));
  await history(r1.id, 40, [['doing', 30], ['done', 20]]);
  await history(r2.id, 25, [['doing', 15], ['done', 5]]);
  await history(r3.id, 50, [['doing', 45]]);
  await history(r4.id, 3, [['doing', 2]]);
  await history(r5.id, 10, [['canceled', 8]]);
  const release = async (data: Record<string, unknown>) => (await json<{ release: { id: string } }>(request.post('/api/v1/orgs/acme/releases', { data }))).release.id;
  const v10 = await release({ productId: pan, versionName: 'v1.0', plannedDate: await day(30) });
  const v11 = await release({ productId: pan, versionName: 'v1.1', iterationId: sprint1, plannedDate: await day(30) });
  await adminSql('update releases set baseline_date = null where id = $1', [v11]);
  for (const id of [v10, v11]) await ok(request.post(`/api/v1/orgs/acme/releases/${id}/released`));
  await ok(request.put(`/api/v1/orgs/acme/requirements/${r1.id}/checks/feasibility`, { data: { state: 'rejected' } }));
  await ok(request.put(`/api/v1/orgs/acme/requirements/${r1.id}/checks/feasibility`, { data: { state: 'passed' } }));
  await ok(request.put(`/api/v1/orgs/acme/requirements/${r2.id}/checks/feasibility`, { data: { state: 'passed' } }));
}

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('产品看板：关键数字与口径、趋势、卡在哪儿、迭代与版本、专项、评审；切换时间段、按迭代与自定义；1440 与 760 不横向滚动', async ({ page, request }) => {
  await seed(request);
  await login(page, OWNER.email, OWNER.password);
  await page.locator('nav[aria-label="主导航"] a[href="/acme/dashboard"]').click();
  await expect(page.getByRole('heading', { name: '看板', level: 1 })).toBeVisible();

  // 关键数字：近 90 天完成 2 条（2 × 7 ÷ 90 ≈ 0.2 条/周）；前置时间都是 20 天、流动时间都是 10 天；进行中 2 条；
  // 版本 1 按期 1 逾期；可行性 2 个有结论、1 个驳回过。上期早于数据起点，显示「上期暂无数据」
  await expect(card(page, '吞吐量（周均）')).toContainText('0.2 条/周');
  await expect(card(page, '吞吐量（周均）')).toContainText('上期暂无数据');
  await expect(card(page, '前置时间中位数')).toContainText('20.0 天');
  await expect(card(page, '流动时间中位数')).toContainText('10.0 天');
  await expect(card(page, '当前在制品')).toContainText('2');
  await expect(card(page, '版本按期达成率')).toContainText('50%');
  await expect(card(page, '驳回率')).toContainText('50%');
  await page.getByRole('button', { name: '前置时间中位数的口径' }).hover();
  await expect(page.getByRole('tooltip')).toContainText('需求创建到最后一次进入');

  await expect(page.getByRole('table', { name: '每周吞吐量' })).toBeAttached();
  await expect(page.getByRole('table', { name: '在制品周趋势' })).toBeAttached();
  await expect(page.getByRole('table', { name: '各状态停留' }).getByRole('row', { name: /进行中/ })).toContainText('23.5 天');
  const oldest = page.getByRole('table', { name: '停留最久的需求' });
  await expect(oldest.getByRole('row').nth(1)).toContainText('PAN-3');
  await expect(oldest.getByRole('row').nth(1)).toContainText('45.0 天');

  const iterations = page.getByRole('table', { name: '迭代承诺' });
  await expect(iterations.getByRole('row', { name: /Sprint 1/ })).toContainText('100%');
  await expect(iterations.getByRole('row', { name: /Sprint 0/ })).toContainText('暂无数据');
  const releases = page.getByRole('table', { name: '版本', exact: true });
  await expect(releases.getByRole('row', { name: /v1\.1/ })).toContainText('按迭代结束日计');
  await expect(releases.getByRole('row', { name: /v1\.1/ })).toContainText('逾期 1 天');
  await expect(releases.getByRole('row', { name: /v1\.0/ })).toContainText('按期');
  await expect(page.getByRole('progressbar', { name: '专项甲' })).toHaveAttribute('aria-valuenow', '50');
  await expect(page.getByRole('table', { name: '各检查项评审' }).getByRole('row', { name: /可行性/ })).toContainText('50%');
  await expectNoPageOverflow(page);

  // 从停留最久的需求进入详情
  await oldest.getByRole('link', { name: 'PAN-3' }).click();
  await page.waitForURL('**/acme/requirements/PAN-3');
  await page.goBack();
  await expect(card(page, '吞吐量（周均）')).toContainText('0.2 条/周');

  // 近 30 天：同样 2 条完成，2 × 7 ÷ 30 ≈ 0.5 条/周
  await page.getByRole('combobox', { name: '时间段' }).click();
  await page.getByRole('option', { name: '近 30 天' }).click();
  await expect(page).toHaveURL(/range=30/);
  await expect(card(page, '吞吐量（周均）')).toContainText('0.5 条/周');

  // 按迭代：默认选最近开始的 Sprint 1
  await page.getByRole('button', { name: '按迭代' }).click();
  await expect(page).toHaveURL(/iteration=/);
  await expect(page.getByLabel('统计时间段')).toContainText('迭代「Sprint 1」');
  await page.getByRole('button', { name: '按迭代' }).click();
  await expect(page).not.toHaveURL(/iteration=/);

  // 自定义：近 11 天只完成需求二，1 × 7 ÷ 11 ≈ 0.6 条/周
  await page.getByRole('combobox', { name: '时间段' }).click();
  await page.getByRole('option', { name: '自定义' }).click();
  await page.getByLabel('开始日期').fill(await day(-10));
  await page.getByLabel('结束日期').fill(await day(0));
  await page.getByRole('button', { name: '应用' }).click();
  await expect(page).toHaveURL(/from=.*&to=/);
  await expect(card(page, '吞吐量（周均）')).toContainText('0.6 条/周');

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(card(page, '吞吐量（周均）')).toBeVisible();
  await expectNoPageOverflow(page);
});

test('组织汇总：组织管理员按产品对比并进入产品看板；空产品显示暂无数据与原因；普通成员无权访问汇总；1440 与 760 不横向滚动', async ({ page, request, browser }) => {
  await setupInstance(request);
  await createProduct(request, '网盘', 'PAN');
  await createProduct(request, '文档', 'DOC');
  await login(page, OWNER.email, OWNER.password);
  await page.locator('nav[aria-label="主导航"] a[href="/acme/settings/dashboard"]').click();
  await expect(page.getByRole('heading', { name: '看板', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: '各产品关键数字' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row', { name: /网盘/ })).toContainText('暂无数据');
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 760, height: 900 });
  await expectNoPageOverflow(page);

  await table.getByRole('link', { name: '网盘' }).click();
  await expect(page).toHaveURL(/\/acme\/dashboard\?product=/);
  await expect(card(page, '吞吐量（周均）')).toContainText('时间段内还没有需求');
  await expect(card(page, '前置时间中位数')).toContainText('时间段内没有完成的需求');
  await expect(card(page, '迭代承诺')).toContainText('还没有在 Flower 里开始的迭代');
  await expect(card(page, '专项')).toContainText('时间段内没有包含本产品需求的专项');
  await expect(card(page, '评审')).toContainText('还没有在 Flower 里评审过的检查项');
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoPageOverflow(page);

  const ctx = await browser.newContext();
  const member = await ctx.newPage();
  await acceptInvite(member, request, { email: 'member@example.com', orgRole: 'member', name: '成员乙' });
  await member.goto('/acme/settings/dashboard');
  await expect(member.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await member.goto('/acme/dashboard');
  await expect(card(member, '吞吐量（周均）')).toBeVisible();
  await ctx.close();
});
```

- [ ] **Step 3: 运行端到端测试**

Run: `pnpm --filter @flower/web e2e dashboard.spec.ts`
Expected: 2 passed。如果「按迭代」后地址栏还在、或卡片数值不符，先用 `--trace on` 查看是数据（`history` 时间）还是页面问题，不要放宽断言。

- [ ] **Step 4: lint 与类型检查**

Run: `pnpm --filter @flower/web lint --max-warnings 0` 与 `pnpm typecheck`
Expected: 0 错误 0 警告；类型检查无错误

- [ ] **Step 5: 提交**

```bash
git add apps/web/e2e/db.ts apps/web/e2e/dashboard.spec.ts
git commit -m "test(web): 看板端到端测试（产品看板与组织汇总，1440 与 760）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 性能测量命令加入看板接口

**Files:**
- Modify: `packages/migrate/src/perf.ts`
- Test: `packages/migrate/test/perf.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `getProductDashboard`、`getOrgDashboard`；`todayInZone`（`@flower/core`）；已有的 `buildPerfCases`、`measure`、`listIterations`
- Produces: `buildPerfCases` 返回的用例末尾多四个：`看板：产品，近 90 天`、`看板：产品，近 180 天`、`看板：产品，按迭代（最近开始的迭代）`、`看板：组织汇总，近 90 天`（共 20 个）

- [ ] **Step 1: 改测试（先失败）**

`packages/migrate/test/perf.test.ts` 第二个用例里，期望的用例名列表在 `'工作台',` 之后加四项，长度改为 20：

```ts
      '工作台',
      '看板：产品，近 90 天',
      '看板：产品，近 180 天',
      '看板：产品，按迭代（最近开始的迭代）',
      '看板：组织汇总，近 90 天',
    ]);
    const result = await measure(cases, 2);
    expect(result).toHaveLength(20);
```

Run: `pnpm --filter @flower/migrate exec vitest run test/perf.test.ts`
Expected: FAIL（用例名列表少四项）

- [ ] **Step 2: 加用例**

`packages/migrate/src/perf.ts`：

1. 导入改为：

```ts
import {
  type Actor,
  type Db,
  getIterationGantt,
  getIterationScope,
  getOrgDashboard,
  getProductDashboard,
  getRequirementByKey,
  getWorkbench,
  listIterations,
  listMemberTasks,
  listRequirementComments,
  listRequirements,
  listReviewQueue,
  todayInZone,
} from '@flower/core';
```

2. 在 `const topAssignee = …` 一行之后加：

```ts
  // 看板按迭代：本产品最近开始、已开始且未取消的常规迭代（开始日不晚于今天，组织时区默认 Asia/Shanghai）
  const today = todayInZone('Asia/Shanghai');
  const recent = iterationList
    .filter((it) => it.type === 'regular' && it.product?.id === productId && it.status !== 'planning' && it.status !== 'canceled' && it.startDate <= today)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
```

3. 在返回数组的 `{ name: '工作台', run: () => getWorkbench(db, actor.accountId!) },` 之后加：

```ts
    { name: '看板：产品，近 90 天', run: () => getProductDashboard(db, actor, productId, { range: { kind: 'days', days: 90 } }) },
    { name: '看板：产品，近 180 天', run: () => getProductDashboard(db, actor, productId, { range: { kind: 'days', days: 180 } }) },
    {
      name: '看板：产品，按迭代（最近开始的迭代）',
      run: () => (recent ? getProductDashboard(db, actor, productId, { range: { kind: 'iteration', iterationId: recent.id } }) : Promise.resolve(null)),
    },
    { name: '看板：组织汇总，近 90 天', run: () => getOrgDashboard(db, actor, { range: { kind: 'days', days: 90 } }) },
```

- [ ] **Step 3: 运行测试，确认通过**

Run: `pnpm --filter @flower/migrate exec vitest run test/perf.test.ts`
Expected: PASS

- [ ] **Step 4: 类型检查并提交**

Run: `pnpm typecheck`
Expected: 无错误

```bash
git add packages/migrate/src/perf.ts packages/migrate/test/perf.test.ts
git commit -m "feat(migrate): 性能测量加入产品看板与组织汇总

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 全量验证、pan123 复验与 SQL 核对（控制方）、验证记录与交接

**Files:**
- Create: `docs/p3b2-validation.md`
- Modify: `docs/handoff.md`、`docs/agent-log.md`

**Interfaces:**
- Consumes: 全部任务

- [ ] **Step 1: 全量自动化验证**

```bash
pnpm test
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web e2e
./scripts/smoke.sh
pnpm db:migrate
```

Expected: 全部通过（`editor-perf.spec.ts` 在未设置 `EDITOR_BENCH` 时跳过）；记下 core、web、migrate 单测数与 e2e 用例数。最后一条把 `flower_app` 密码改回开发值。本计划没有迁移，`pnpm db:migrate` 只改回密码，不应有新迁移执行。

- [ ] **Step 2: STOP——控制方在 pan123 上测量性能**

执行代理在这里停下。控制方执行（读 `apps/web/.env.local`，只读）：

```bash
pnpm --filter @flower/migrate build && node --disable-warning=ExperimentalWarning --env-file=apps/web/.env.local packages/migrate/dist/cli.mjs perf --org-slug pan123 --owner-email <你的账号邮箱>
```

记录四个看板用例的 p50 / p95 / 最大值。验收：p95 低于 300 毫秒（设计 §6）。超过时停下来报告慢在哪一步（可在本地临时给 `getProductDashboard` 各阶段计时，不提交），不在本计划内加快照表或物化视图。

- [ ] **Step 3: STOP——控制方用 SQL 手工核对三项**

控制方在本地开发库上只读执行（`docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "…"`），与浏览器里 `GET /api/v1/orgs/pan123/products/{PAN 的 id}/dashboard?range=180` 的结果（登录后在地址栏打开即可看到 JSON）对照，验证记录里只写数量与是否一致：

1. **某周吞吐量**：下面的 SQL 列出最近 8 周每周的完成数，任选一周与接口 `weeks` 里同一个 `week` 的 `throughput` 对照。

```sql
with p as (
  select pr.id, pr.workflow_version_id from products pr join organizations o on o.id = pr.org_id
  where o.slug = 'pan123' and pr.key = 'PAN'
),
st as (
  select s->>'key' as key, s->>'category' as category
  from workflow_versions v, jsonb_array_elements(v.body->'states') s
  where v.id = (select workflow_version_id from p)
),
r as (select id, state_key from requirements where product_id = (select id from p) and deleted_at is null),
entry as (
  select tr.requirement_id, tr.at,
         row_number() over (partition by tr.requirement_id order by tr.at desc, (tr.from_state is null) asc) as rn
  from state_transitions tr
  join r on r.id = tr.requirement_id
  join st sto on sto.key = tr.to_state and sto.category = 'completed'
  left join st sfrom on sfrom.key = tr.from_state
  where tr.from_state is null or coalesce(sfrom.category, 'backlog') <> 'completed'
)
select date_trunc('week', e.at at time zone 'Asia/Shanghai')::date as week, count(*)
from entry e join r on r.id = e.requirement_id join st on st.key = r.state_key and st.category = 'completed'
where e.rn = 1
group by 1 order by 1 desc limit 8;
```

2. **某个版本是否按期**：pan123 的版本没有基线日期、计划日期，也没有所属迭代，接口应把每个已发布版本判为「无法判断」，按期达成率为「暂无数据」。下面的 SQL 应返回 `released|10|0`（已发布、总数、可判断数），与接口 `releases.evaluated` 为 0、`onTimeRate` 为 null 对照；任选一个版本，核对接口里的 `releasedOn` 与 SQL 的发布日期一致。

```sql
select r.status, count(*),
       count(*) filter (where r.baseline_date is not null or (i.id is not null and i.deleted_at is null))
from releases r join organizations o on o.id = r.org_id
left join iterations i on i.id = r.iteration_id
where o.slug = 'pan123' group by r.status;

select r.version_name, (r.released_at at time zone 'Asia/Shanghai')::date
from releases r join organizations o on o.id = r.org_id
where o.slug = 'pan123' and r.status = 'released' order by r.released_at desc limit 3;
```

3. **某个专项完成率**：与接口 `specials` 对照（只统计 PAN 的需求；接口只列与时间段有交集的专项，必要时用 `from`/`to` 把时间段放到覆盖该专项）。

```sql
with p as (
  select pr.id, pr.workflow_version_id from products pr join organizations o on o.id = pr.org_id
  where o.slug = 'pan123' and pr.key = 'PAN'
),
st as (
  select s->>'key' as key, s->>'category' as category
  from workflow_versions v, jsonb_array_elements(v.body->'states') s
  where v.id = (select workflow_version_id from p)
)
select i.start_date, i.end_date, i.status, count(*) as total,
       count(*) filter (where st.category = 'completed') as completed,
       count(*) filter (where st.category = 'canceled') as canceled
from iterations i
join requirements r on r.iteration_id = i.id and r.deleted_at is null and r.product_id = (select id from p)
left join st on st.key = r.state_key
where i.type = 'special' and i.deleted_at is null
group by i.id order by i.start_date;
```

三项任一不一致时停下来报告，先查口径（时区、最后一次进入、已删除）再改代码。

- [ ] **Step 4: STOP——控制方在 pan123 上复验界面**

控制方在本地开发库（pan123）上启动开发服务器，以 1440px 与 760px 两种宽度逐项检查，确认页面本身不横向滚动，把结论（只写现象与数量，不写姓名、标题）交回：

1. 主导航「看板」：默认近 90 天；六张卡片；版本按期达成率与驳回率显示「暂无数据」与原因（pan123 版本没有计划日期、没有检查项事件）；悬停「?」显示口径。
2. 趋势三张图形状合理（在制品自 2026-03 起有数），切换近 30 / 180 天、自定义（含不合法输入的提示）、按迭代（11 个已完成迭代可选）都正常，地址栏随之变化，刷新后保持。
3. 卡在哪儿：各状态停留与前 10 条需求，点击进入需求详情。
4. 迭代与版本：迭代行全部「暂无数据」并有「还没有在 Flower 里开始的迭代」说明；版本行「无法判断：没有计划日期」，计划中的 4 个版本「未发布，没有计划日期」。
5. 专项：与时间段有交集的专项显示进度条（与 Step 3 第 3 项一致）。
6. 评审：「暂无数据：还没有在 Flower 里评审过的检查项」。
7. 组织设置 → 看板：一行 PAN，数字与产品看板一致，点击产品名进入同一时间段的产品看板。

- [ ] **Step 5: 写验证记录**

新建 `docs/p3b2-validation.md`，结构与 `docs/p3b1-validation.md` 一致，包含：

1. 自动化测试数量（Step 1）。
2. 性能（Step 2）：四个看板用例的 p50 / p95 / 最大值与是否达标。
3. 真实数据核对（Step 3）：三项各一行（所选的周、版本、专项用日期或序号表示，不写名称），接口值与 SQL 值、是否一致。
4. 界面复验（Step 4）：每项「通过 / 问题与处理 / 未验证」。
5. 已知的数据限制：pan123 版本没有计划日期与所属迭代，按期达成率暂无数据；迁移的评审记录不是 `check_item.*` 事件，评审效率与驳回率从上线后开始统计；迭代没有承诺范围快照。各自的补救办法（为版本补计划日期或关联迭代；之后在 Flower 里开始的迭代会有快照）由用户决定。
6. 人工验收清单（供用户试用）：产品看板各区块、时间段与按迭代、口径说明、组织汇总、从停留最久的需求进入详情。

- [ ] **Step 6: 更新交接文档与协作日志**

`docs/handoff.md`：

1. 「关键文档」表加三行：`docs/superpowers/specs/2026-10-13-flower-p3b2-dashboard-design.md`（P3-B2 设计，已确认；§7 产品工作情况表待讨论）、`docs/superpowers/plans/2026-10-13-flower-p3b2-dashboard.md`（P3-B2 计划）、`docs/p3b2-validation.md`（P3-B2 真实数据核对、性能与人工验收清单）。
2. 「当前进度」加一条「P3-B2 基础数据看板：已完成，待合并」，写清：产品看板（关键数字、趋势、卡在哪儿、迭代与版本、专项、评审）、组织汇总、只读接口、实时计算无快照表、性能结果、SQL 核对结论、已知数据限制。
3. 「下一步」改为：合并 P3-B2；用户按 `docs/p3b2-validation.md` 验收；讨论设计 §7「产品工作情况表」。

`docs/agent-log.md`「记录」最上面加一条：

```
### 2026-10-XX · 本地 · P3-B2 基础数据看板
- 分支 / PR：`feat/p3b2-dashboard`
- 做了什么：
  - core `src/dashboard/`：纯函数（周与组织时区、分位数、完成记录、吞吐量、前置与流动时间、在制品与停留、版本按期、迭代承诺、专项、评审效率与驳回率）与读取模块；`getProductDashboard`、`getOrgDashboard`（按可见产品过滤，组织汇总仅组织管理员，含全部产品范围的只读 Token）。无新表、无迁移、无新依赖。
  - 接口 `GET /orgs/:org/products/:id/dashboard`、`GET /orgs/:org/dashboard`（近 30/90/180 天、自定义、按迭代）。
  - 页面：主导航「看板」（产品看板，纯 SVG 图表，口径说明，暂无数据原因）、组织设置「看板」（组织汇总）。
  - perf 命令加四个看板用例。
- 怎么验证的：（Step 1 的测试数；Step 2 的性能；Step 3 的 SQL 核对；Step 4 的复验结论）
- 留给对方：pan123 版本按期达成率与评审指标因数据缺口显示暂无数据（见 `docs/p3b2-validation.md` 第 5 节）；设计 §7 产品工作情况表待讨论。
```

- [ ] **Step 7: 提交**

```bash
git add docs/p3b2-validation.md docs/handoff.md docs/agent-log.md
git commit -m "docs: P3-B2 验证记录、真实数据核对、交接进度与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 与设计、代码或数据的冲突

写计划时对照设计、代码与只读数据发现的不一致，以及本计划的处理：

| 设计说法或现状 | 实际情况 | 本计划的处理 |
|---|---|---|
| 设计 §2、§3：没有基线日期的版本用所属迭代的结束日代替 | pan123 的 14 个版本 `planned_date`、`baseline_date`、`iteration_id` 全部为空；即使按所关联需求的迭代推断，也只有 2 个已发布版本能找到迭代 | 按设计实现「基线日期 → 所属迭代结束日」，两者都没有的版本不进分母、行内显示「无法判断：没有计划日期」，卡片显示「暂无数据」与原因；不按关联需求推断迭代（设计没有这条，且只能覆盖 2 个）。pan123 上按期达成率因此为「暂无数据」，写入验证记录第 5 节由用户决定是否为历史版本补日期 |
| 设计 §3：评审效率与驳回率取自领域事件，「迁移来的旧事件只覆盖部分检查项变化」 | pan123 没有一条 `check_item.*` 事件；迁移来的事件类型是 `legacy.123plane.*` 与 `legacy.push.change`，payload 结构不同；检查项结果 795 条、签字 287 条在 `check_item_results` / `check_item_signoffs` 里，不是事件 | 只统计 `check_item.updated` 与 `check_item.signed`（含 PRD 上的检查项），统计起点为本产品最早一条这类事件的日期；pan123 上评审区块显示「暂无数据：还没有在 Flower 里评审过的检查项」。不解析 `legacy.*`，也不改用签字表（设计明确取自领域事件） |
| 设计 §5：组织汇总仅组织管理员；接口只读，只读 API Token 可调用 | 现有 `isOrgAdmin` 要求 Token 为读写且全部产品范围，只读 Token 会被当作非管理员 | 新增 `canViewOrgDashboard`：所有者或管理员，用 Token 时须为全部产品范围，只读、读写均可；限定产品的 Token 返回 403（汇总会缺产品，且设计把它定位为全组织视图）。不改 `isOrgAdmin`，避免影响写操作的权限 |
| 设计 §2：时间段「按迭代」 | 设计没有定义按迭代时统计哪段时间、与谁比较、组织汇总是否适用 | 按迭代 = 本产品常规迭代的开始日到 `min(结束日, 今天)`，统计口径与按时间段相同；只列已到开始日、未取消的迭代；上期为之前同长度的时间段；组织汇总不支持（返回 400「组织汇总不支持按迭代查看」） |
| 设计 §3：吞吐量「同一需求反复进出时按最后一次进入计」 | 没有说完成后又被重新打开、目前不在完成类的需求怎么算；也没有说「已上线 → 已验收」这类完成类之间的流转 | 只统计当前处于完成类的需求，完成时刻取最后一次「从非完成类进入完成类」；完成类之间的流转不算新的完成。前置时间与流动时间用同一个完成时刻 |
| 设计 §4.1：卡片「当前在制品」并与上一个同长度时间段比较；第 4 步「卡在哪儿」看当前 | 时间段可以是过去（自定义、已结束的迭代），「当前」与时间段不一致 | 卡片取时间段最后一天结束时的在制品（结束日为今天时就是当前），上期取上期最后一天；「卡在哪儿」始终按当前时刻，页面注明「不受时间段影响」 |
| 设计 §4.1：每张卡片标出与上一个同长度时间段相比的升降 | pan123 的流转从 2026-03 开始；新产品更短。上期早于数据起点时上期为 0，比较没有意义 | 上期最后一天早于产品最早一条流转的日期时，流动类卡片的上期为 null，显示「上期暂无数据」；版本与评审的上期本来就会是 null |
| 设计 §3：评审效率为「从开始评审到通过的天数」 | 事件里没有「开始评审」这一类型 | 开始 = 该检查项第一条离开「未开始」或第一次签字的事件；通过 = 最后一次变为「通过」且最终状态为通过；按通过日落在时间段内统计。与工作台「评审已开始」的判断（离开默认状态）一致 |
| 设计 §3：专项完成率「每个专项内」；§5 看不到的产品的数据不出现在响应里 | 专项属于组织（`product_id` 为空），包含多个产品的需求 | 产品看板里每个专项只统计本产品未删除的需求，不含本产品需求的专项不显示；不返回其他产品的数量。接口测试检查访客的响应里没有其他产品的需求标题与 id |
| 设计 §3：「所属迭代的结束日」 | 迭代有 `end_date` 与开始时记下的 `baseline_end_date` | 用 `end_date`（设计原文）；迁移来的迭代 `baseline_end_date` 多为空 |
| 设计 §3：「已过计划日期仍未发布的版本」 | 计划中的版本也可能没有计划日期，只有所属迭代 | 计划中的版本到期日 = 计划日期，没有时用所属迭代结束日；都没有时显示「未发布，没有计划日期」 |
| 设计 §4.1、§4.2：主导航「看板」与组织设置「看板」 | 导航高亮按键匹配，组织设置项的键取自路径（`dashboard`），两项同名同键会同时高亮 | 主导航项用键 `product-dashboard`（路径仍为 `/{org}/dashboard`），组织设置项用键 `dashboard` |
| 设计 §6：每个接口在 300 毫秒内返回 | 现有 `perf` 命令在服务层测量（不经 HTTP），与之前各阶段的性能记录口径一致 | 在 `perf` 命令里加四个看板用例，以服务层 p95 低于 300 毫秒为准；超过时报告，不在本计划内加快照表 |
| 数据现状：`status = released` 的版本 | 代码允许 `released_at` 为空的已发布版本存在（迁移或手工修改） | 这类版本无法放入时间段，跳过；pan123 的 10 个已发布版本都有 `released_at` |

## P3-B2 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm --filter @flower/web e2e`、`./scripts/smoke.sh` 全部通过。
- 设计 §6 的验证都有对应测试：反复进出 completed、已取消与已删除的需求、跨周与跨时区边界、在制品周趋势推算（Task 1、3）；版本缺基线日期时用迭代结束日、无快照迭代显示「暂无数据」、先驳回后通过计为驳回过（Task 2、6）；接口权限（组织管理员、产品管理员、编辑、只读、访客、只读 Token）与看不到的产品不出现在任何响应里（Task 6、7）；端到端的显示、筛选与按迭代切换、「暂无数据」与口径说明、从停留最久的需求进入详情、1440 与 760（Task 12）；性能（Task 13、14）；真实数据 SQL 核对（Task 14）。
- 没有新表、迁移与依赖；验证记录、交接文档与协作日志已更新（Task 14）。

## 自查

写完后对照设计逐条核对的结果：

| 设计条目 | 对应任务 |
|---|---|
| §1 产品看板八类指标、组织汇总、只读接口；不含快照表、物化视图、导出与订阅、§7 | Task 1–11（没有新表、导出、订阅、§7 的代码） |
| §2 产品视角为主另加组织汇总；历史缺数（迭代结束日代替、无快照显示暂无数据）；时间段（近 30/90/180、自定义、按周趋势）与按迭代；方案 A 实时计算 + 前端缓存 | Task 2、6（口径与时间段）、Task 8（`staleTime` 5 分钟）、Task 9–11（页面） |
| §3 指标口径九行与通用规则（类别归类、以流转为准、已删除不计、已取消不算完成也不进分母、组织时区、周一开始） | Task 1、2（纯函数）、Task 3–5（读取时排除已删除、按组织时区） |
| §4.1 导航「看板」与 `?product=`、七个区块的顺序与内容 | Task 9（筛选、卡片、趋势、导航）、Task 10（卡在哪儿、迭代与版本、专项、评审） |
| §4.2 组织设置「看板」，每个产品一行，点击进入产品看板 | Task 11 |
| §4.3 「?」口径、「暂无数据」与原因、沿用现有样式、1440 与 760 不横向滚动 | Task 8（文案）、Task 9–11（组件）、Task 12（断言） |
| §5 权限、`/api/v1` 只读、只读 Token、`withOrg` 与可见产品过滤、不新增表与迁移 | Task 6、7 |
| §6 单元、接口、端到端、性能、真实数据核对 | Task 1–7、12、13、14 |

- 占位检查：计划中没有「待定」「以后实现」或只描述不给代码的步骤。`2026-10-XX` 是协作日志条目的日期，`<你的账号邮箱>` 与 PAN 的产品 id 是控制方在 Task 14 执行时才能确定的输入。
- 名称一致性：`zonedDate`、`addDays`、`daysBetween`、`mondayOf`、`weeksBetween`、`quantile`、`roundTo1`、`round1`、`ratio`、`elapsedDays`、`prepareFlow`、`stateAtEndOf`、`wipAt`、`completionOf`、`completionsOf`、`flowSummary`、`weeklySeries`、`stuckNow`、`releaseSummary`、`iterationCommitment`、`specialCompletion`、`reviewSummary`、`orgTimeZone`、`loadProductFlow`、`loadReleaseFacts`、`loadIterationFacts`、`loadSpecialFacts`、`loadIterationOptions`、`stateChangeOf`、`loadReviewEvents`、`canViewOrgDashboard`、`getProductDashboard`、`getOrgDashboard`、`DashboardRange`、`DashboardWindow`、`DashboardCards`、`ProductDashboard`、`OrgDashboard`、`IterationOption`、`registerDashboardRoutes`、`useProductDashboard`、`useOrgDashboard`、`filterFromParams`、`filterQuery`、`rangeValue`、`dashboardHref`、`orgDashboardHref`、`customRangeError`、`windowText`、`METRIC_HELP`、`CARD_SPECS`、`formatMetric`、`formatDays`、`formatRate`、`emptyReason`、`TONE_CLASS`、`cardDelta`、`weekLabel`、`niceMax`、`linePoints`、`releaseVerdict`、`MetricHelp`、`MetricCards`、`FilterBar`、`InvalidFilter`、`Trends`、`StuckSection`、`DeliverySection`、`SpecialsSection`、`ReviewSection`、`rewriteHistory`、`adminSql` 在定义与使用处一致。
- 依赖顺序：Task 2 用 Task 1；Task 3–5 用 Task 1、2；Task 6 用 Task 1–5；Task 7 用 Task 6；Task 8 用 Task 6、7 的类型与接口；Task 9 用 Task 8；Task 10 修改 Task 9 的页面；Task 11 用 Task 8、9；Task 12 用 Task 9–11；Task 13 用 Task 6；Task 14 收尾。
- 包入口只导出 `dashboard/dashboard.ts`：纯函数与读取模块里的 `ReleaseRow`、`StateMeta` 等名字不进入 `@flower/core`，不与现有导出（如 `notifications/dashboard-image.ts` 的 `DashboardRow`）冲突；`ProductDashboard` 引用的类型由 TypeScript 结构化解析，前端 `Jsonify<…>` 不需要这些名字被导出。
