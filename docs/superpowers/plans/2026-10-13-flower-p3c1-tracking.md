# Flower P3-C1 工作跟进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Flower 替代「产品工作情况表」：需求自动或手动加入跟进，记录类型、预计上线日期、暂停与进展记录（进展、下一步、跟进人）；技术支持、协调对接等非需求工作建为工作项（`W-n`）；主导航「跟进」提供全部在手、任务老化、按阶段看板、按产品经理四个页签；工作台显示我负责的工作项与「等我跟进」；组织设置「跟进」维护老化阈值。

**Architecture:** 方案 A：跟进字段放在所属对象上（`requirements` 加五列，新表 `work_items`），进展记录（`progress_updates`）与阻塞项（`blockers` 增加 `work_item_id`）由需求和工作项共用，二者恰有一个非空。业务逻辑在 `packages/core/src/tracking/`：`aging.ts` 是停留、暂停区间、老化与无进展的纯函数；`access.ts` 统一工作项权限；`requirement-tracking.ts`、`work-items.ts`、`progress.ts` 是写操作（同事务记领域事件）；`tracking.ts` 在 `withOrg` 中按可见产品读出全部在手条目并算好停留、在制、老化与无进展，四个页签由前端从同一份结果派生。暂停与恢复记为领域事件，停留天数按组织时区的自然日扣除暂停区间。通知复用 P3-B1：工作项负责人「被指派」并自动关注，进展记录的跟进人「被指派」（「你是下一步跟进人」），关注者收到「关注对象变化」。页面：`/{org}/tracking`、`/{org}/work-items/W-n`、需求详情「跟进」区块与「进展记录」页签、工作台两个区块、组织设置「跟进」。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui（Tabs、Table、Dialog、Select）、lucide-react、Vitest、Playwright。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-13-flower-p3c1-tracking-design.md`（用户 2026-10-13 确认，本计划的约束来源）；上位文档 `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`；P3-B1 设计与计划（通知、关注、@）；P3-B2 计划（`dashboard/metrics.ts` 的 `zonedDate`、`daysBetween`，`dashboard/flow.ts` 的 `orgTimeZone`，`perf` 命令）。逐条决定见下方「设计决定」，与设计、代码或数据不一致之处见文末「与设计、代码或数据的冲突」。

## Global Constraints

- **今天是 2026-10-13。** 计划、验证记录、协作日志里的日期以此为准。
- **执行代理不运行 `pnpm dev`，不读取 `.local-data/`，除 `pnpm db:migrate` 外不写本地开发库。** 本地开发库只做只读查询（`docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select …"`，只取数量与结构）。界面检查一律写成 Playwright 用例；真实数据上的迁移核对、性能测量与界面复验由控制方在 Task 18 完成。
- `pnpm test` 与端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；跑完之后、对开发库做任何操作之前，先执行一次 `pnpm db:migrate`。
- 计划、验证记录、提交信息、测试数据只写数量与结构，不写真实姓名、职务、邮箱、需求标题。测试只用虚构内容与 `@example.com` 邮箱。
- **不新增依赖。** 看板列、表格、对话框都用现有 shadcn/ui 组件与 Tailwind 类。
- 迁移：`0019_*.sql` 由 `pnpm --filter @flower/core db:generate` 生成（列、表、约束、索引）；`0020_p3c1_tracking.sql` 用 `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p3c1_tracking` 生成后填写：为 `work_items`、`progress_updates` 开启 RLS（参照 `0002_rls.sql`、`0018_p3b1_rls.sql`），回填 `tracked_since`，补齐内置字段「类型」「工作类型」。执行中如发现还要改表结构，停下来报告。
- 新租户表必须带 `org_id` 并开启 RLS；业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`（实体 id 作为第三个参数的现有写法照旧），一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写。
- **每个写操作在同一事务内调用 `recordEvent`**（修改类 payload 带 `changes: [{field, old, new}]`）。本计划新增的事件：`requirement.tracking_joined`（`auto`）、`requirement.tracking_left`、`requirement.expected_date_changed`、`requirement.paused`、`requirement.resumed`；`work_item.created`、`work_item.updated`、`work_item.status_changed`、`work_item.paused`、`work_item.resumed`、`work_item.deleted`；`progress.created`、`progress.updated`、`progress.deleted`；`organization.tracking_settings_changed`；阻塞项沿用 `blocker.created`、`blocker.resolved`（`subjectType` 为 `work_item` 时挂在工作项上）。后台与系统写入不记事件：迁移回填、迁移工具导入后的回填、通知生成时的自动关注。
- 面向用户的文案与错误信息用中文，通过 `AppError(code, message, details?)` 抛出。`apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`、`@flower/core/markdown`、`@flower/core/links`、`@flower/core/notifications`。本计划不新增子路径：`workItemDisplayKey` 放进 `links/syntax.ts`（仍不导入任何模块）。纯逻辑放 `apps/web/src/features/tracking/model.ts` 并写 Vitest 单测。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`；对话框用 `key` 重新挂载取初值，或渲染期间同步（参照 `apps/web/src/app/(app)/[org]/settings/general/page.tsx` 的 `synced`）。渲染期间不直接调用 `new Date()` / `Date.now()`（`react-hooks/purity`）：「今天」由接口返回的 `today` 提供。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框用 `silentError: true` + `<FormError error={mutation.error} />`。页面加载失败用 `QueryError`。
- 复用已有的共享件：`PageHeader`、`EmptyState`、`QueryError`、`FormError`、`ConfirmAction`、`MemberPicker`、`FollowButton`、`WikiText`、`WikilinkTextarea`、`RequireOrgAdmin`、`Table` 系列、`Select` 系列、`Tabs` 系列、`Dialog` 系列；`features/members/model.ts` 的 `activePeople`、`canListMembers`、`pickerOptions`；`features/requirements/format.ts` 的 `formatDate`、`formatDateTime`；e2e `helpers.ts` 的 `ok`、`json`、`setupInstance`、`login`、`createProduct`、`createRequirement`、`memberRequest`、`tick`、`expectNoPageOverflow`，`db.ts` 的 `resetDatabase`、`adminSql`。
- 视觉沿用 P0-B：表格行高 40px（`h-10`）、隔行底色 `even:bg-zebra`、编号与天数用 `font-mono`、卡片圆角 6px（`rounded-md`）。老化标黄用 `bg-amber-100 text-amber-800`（暗色 `dark:bg-amber-950 dark:text-amber-300`），标红用 `bg-destructive/10 text-destructive`。
- 布局：1440 与 760 两个宽度下页面本身不横向滚动；表格在自己的容器里横向滚动，标题列 `sticky left-0`；新页面都有 Playwright 断言（`expectNoPageOverflow`）。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0` 与 `pnpm typecheck`。
- 端到端测试：每个 spec 在 `beforeEach` 或用例开头调用 `resetDatabase()`；不为迁就定位器修改共享组件；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染。
- 提交信息用中文，每条末尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）；实际执行提交的若不是 Claude Opus 5.5，把这一行换成实际模型的名字。完成后按 `CLAUDE.md` 在 `docs/agent-log.md` 最上面追加一条（Task 18）。

## Review Focus

设计没有逐条写、各任务正常路径的测试也不一定覆盖、但最可能让使用者碰到问题的五类输入。每一条的测试已加在负责的任务里：

1. **跟进中的需求被重新打开或退回。** 已上线后又改回「开发中」，或从「设计中」退回「收集」。期望：`tracked_since` 保留，不重复记加入事件；退回收集与重新打开的需求仍算在手（显示在全部在手里），停留从新的状态重新计算。测试：Task 4「重新打开或退回收集」、Task 7「退回收集与重新打开仍在手」。
2. **跟进人、负责人在被选中之后离开组织、被改为访客，或本来就是看不到该产品的人。** 期望：新选择时拒绝已离开的成员与 Agent；已保存的进展仍显示原名；后台处理时不给已离开、看不到该产品（不关联产品时为访客）的人写通知。测试：Task 6「跟进人校验」、Task 8「跟进人离开或看不到对象」。
3. **工作项在产品之间移动，或从关联产品改为不关联产品。** 期望：目标位置也要有修改权限（产品编辑不能把别人的工作项移成不关联产品；对目标产品没有角色的成员不能移过去）；移动后看不到新产品的人在列表里看不到它。测试：Task 5「改关联产品的权限」、Task 7「移到看不到的产品后不再出现」。
4. **重复或不合时宜的操作。** 重复暂停、没有暂停时恢复、已在跟进时再加入、已完成时加入、对已删除的工作项写进展、状态改成当前状态。期望：中文 `invalid` / `not_found` 错误，不写重复的暂停、恢复事件（否则暂停区间配对出错，停留天数算错）。测试：Task 4「暂停与恢复」、Task 5「状态与暂停」、Task 6「已删除对象」。
5. **地址栏里过期或手工改坏的筛选。** 产品已删除或看不到、负责人已离开、类型选项不存在、参数不是 UUID、页签名不认识。期望：接口对合法 UUID 但看不到或不存在的值返回空结果（不报错、不暴露该产品是否存在），对格式错误返回 400「筛选参数无效」；页面把无法识别的页签当作「全部在手」，显示「没有符合条件的条目」与「清除筛选」。测试：Task 7「看不到或不存在的筛选值」、Task 10「筛选参数格式」、Task 11「地址栏解析」、Task 16「过期筛选」。

## 设计决定

数量为 2026-10-13 写计划时对本地开发库的只读查询，只取数量。

| 项 | 决定 | 依据 |
|---|---|---|
| 现状数据 | 组织 2 个（有产品的 1 个）；pan123 产品 1 个；未删除需求 766 条，按类别：backlog 304、unstarted 41、started 40、completed 247、canceled 134；状态流转 3311 条；`state_changed_at` 与每条需求最后一次流转时间全部一致；阻塞项 9 条（进行中 4）；评论 279 条（其中 `kind = update`「进展」76 条）；在职真人成员 84 人；领域事件 4448 条；迁移已到 0018（drizzle 记录 19 条） | 只读核对 |
| 回填 `tracked_since` | 当前处于 unstarted、started 类别、未删除、`tracked_since` 为空且未手动移出的需求，取最近一次「从这两类之外（或创建）进入这两类」的流转时间，没有时取 `state_changed_at`。pan123 预期 81 条，全部有对应流转（0 条走兜底），最早 2026-03-12、最晚 2026-09-29 | 设计 §3.6，见冲突表 |
| 自动加入 | `transitionRequirement` 与 `createRequirement`（初始状态属于 unstarted、started 时）在同一事务调用 `autoTrackTx`：已有 `tracked_since` 或 `tracking_opted_out` 为真时不变；加入记 `requirement.tracking_joined`（`auto: true`）。只有这两个入口会改变需求状态 | 设计 §3.1；代码只有这两处写 `state_key` |
| 跟进中与在手 | 需求：`tracked_since` 非空、未删除、当前状态类别不是 completed / canceled（退回 backlog 也算在手）。工作项：`status = active`、未删除。 | 设计 §3.1「跟进中」定义 |
| 手动加入与移出 | 加入：状态不在 completed / canceled 时允许（含收集阶段），置 `tracked_since = now`、`tracking_opted_out = false`；移出：清空 `tracked_since`、置 `tracking_opted_out = true`；都要求产品编辑及以上 | 设计 §3.1、§5 |
| 暂停 | 只有跟进中的需求、进行中的工作项可以暂停，原因 1–200 字；恢复只要求正在暂停。暂停与恢复各记一条事件；移出跟进、改状态都不自动恢复（暂停标记与事件始终一致） | 设计 §2「状态保持不变」、§3.7 |
| 停留与在制 | 天数为组织时区下的自然日之差（整数）。需求本阶段停留：`state_changed_at` 到今天；工作项：`started_on`（没有时取创建日期）到今天；在制：需求从 `tracked_since`、工作项从启动日期到今天或完成那天。两者都扣除与范围相交的暂停区间（区间来自 `*.paused` / `*.resumed` 事件的 `occurred_at`，正在暂停的区间延伸到今天）。老化：超过 `warnDays` 黄、超过 `alertDays` 红，暂停中不标色；无进展：最新一条进展（没有时取加入跟进时间，工作项取创建时间）距今超过 `staleUpdateDays` 天，暂停中不计 | 设计 §3.7 |
| 阈值 | `organizations.settings.tracking`，缺省或无效项取默认 14 / 30 / 7；修改时每项为 1–365 的整数，且标黄天数小于标红天数；组织管理员（Token 须为读写、全部产品范围） | 设计 §3.5、§4.5 |
| 工作项权限 | 关联产品：查看 = 能看到该产品；修改、写进展、挂阻塞项 = 产品编辑及以上；管理（删除别人的进展）= 产品管理员。不关联产品：查看 = 非访客成员（Token 须为全部产品范围）；修改（字段、状态、暂停、删除）= 负责人、创建人或组织管理员（读写 Token）；写进展、挂阻塞项 = 任何能查看且非只读的成员；管理 = 组织管理员。改关联产品时目标位置也要有修改权限 | 设计 §5，见冲突表 |
| 进展记录 | 进展 1–2000 字，下一步 0–500 字，跟进人须为在职真人成员；写进展时可同时修改预计日期（需求为预计上线、工作项为预计完成；工作项需要修改权限）。作者本人（且仍能写进展）可修改、删除；产品管理员（不关联产品时为组织管理员）可删除。删除为软删除 | 设计 §3.3、§4.1、§5 |
| 编号 | 工作项按组织 `organizations.work_item_seq` 连续编号，显示 `W-n`（`links/syntax.ts` 的 `workItemDisplayKey`）；详情地址 `/{org}/work-items/W-n` | 设计 §3.2 |
| 内置字段 | `field_definitions.applies_to`（已有列，从未使用）开始生效：`type`（需求）、`work_type`（工作项）为组织级内置单选字段，预置选项 key：`feature` 新功能、`improvement` 体验优化、`incident` 线上问题；`support` 技术支持、`coordination` 协调对接。`effectiveFields`、产品范围的 `listFields`、流程条件可用的字段都只取作用于需求的字段；工作项字段不能被产品覆盖 | 设计 §3.1、§3.2，见冲突表 |
| 跟进列表接口 | `GET /orgs/:org/tracking?product&owner&type&paused=1&blocked=1&done=1` 返回在手条目（`done=1` 时加最近 30 天完成的）、可见产品与其流程状态、阈值、今天与时区；四个页签由前端派生（老化排序、无进展、看板分列、按人分组），所有数据已在服务端按可见产品过滤 | 设计 §4.1、§5，见冲突表 |
| 按阶段看板 | 选定产品：该产品流程中非 completed / canceled 的状态各一列（按 order），加一列「工作项」；全部产品：按类别「收集」（有条目时才显示）、「未开始」「进行中」分列，加「工作项」。只读 | 设计 §4.1 第 3 条，见冲突表 |
| 通知 | 新处理的事件：`work_item.created`（负责人「把工作项指派给你」、描述里的 @）、`work_item.updated`（负责人变更、新增的 @）、`progress.created`（跟进人「你是下一步跟进人：下一步」；关注者「写了进展：前 60 字」）、`progress.updated`（跟进人变更时通知新的跟进人）。工作项可以关注；工作项负责人与被 @ 者自动关注。不关联产品的对象，收件人排除访客 | 设计 §3.8 |
| 导航 | 主导航「需求」后加「跟进」（键 `work-tracking`，`/{org}/tracking`，`/{org}/work-items/*` 也高亮它）；组织设置「看板」后加「跟进」（键 `tracking`，`/{org}/settings/tracking`）；图标 `ListChecks` | 设计 §4.1、§4.5，见冲突表 |
| 需求详情 | 侧栏「状态」之后加「跟进」区块；正文的「评论」改为页签「评论」「进展记录」（默认评论）。工作台「我负责的需求」改名「我负责的需求与工作项」并列出进行中的工作项；新增「等我跟进」 | 设计 §4.2、§4.4，见冲突表 |
| 性能 | `perf` 加四个跟进用例（全部在手、含最近完成、按产品、按负责人），pan123 上 p95 低于 300 毫秒 | 设计 §6 |
| 依赖顺序 | Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12–15（依赖 11）→ 16 → 17 → 18 | — |

## 文件结构

```
packages/core/
  src/db/schema.ts                         # OrgSettings.tracking（Task 1）；requirements 五列、work_items、progress_updates、blockers.work_item_id、organizations.work_item_seq、field_values / applies_to 取值（Task 2）
  migrations/0019_*.sql  0020_p3c1_tracking.sql  meta/   # Task 2
  src/tracking/aging.ts                    # 纯函数：阈值、暂停区间、停留天数、老化、无进展（Task 1）
  src/tracking/backfill.ts                 # 按组织回填 tracked_since（Task 2，迁移工具用）
  src/definitions/defaults.ts  fields.ts  workflows.ts   src/requirements/context.ts   # 内置字段与 applies_to（Task 3）
  src/tracking/access.ts                   # 工作项权限（Task 4）
  src/tracking/requirement-tracking.ts     # 加入 / 移出、预计日期、暂停 / 恢复、自动加入（Task 4）
  src/requirements/transitions.ts  requirements.ts  detail.ts                          # 自动加入、详情带跟进信息（Task 4）
  src/links/syntax.ts                      # workItemDisplayKey（Task 5）
  src/tracking/work-items.ts               # 工作项增删改查、状态、暂停（Task 5）
  src/requirements/blockers.ts             # 工作项阻塞项（Task 5）
  src/tracking/progress.ts                 # 进展记录（Task 6）
  src/tracking/tracking.ts  settings.ts    # 跟进列表与阈值（Task 7）
  src/notifications/constants.ts  src/member-notifications/content.ts  recipients.ts  generate.ts  subscriptions.ts  src/wecom/accounts.ts   # 通知（Task 8）
  src/workbench/workbench.ts               # 工作台（Task 9）
  src/index.ts                             # 各任务
  test/factories.ts                        # trackingWorkflow（Task 4）
  test/tracking-aging.test.ts  p3c1-schema.test.ts  tracking-fields.test.ts  tracking-requirements.test.ts
  test/tracking-work-items.test.ts  tracking-progress.test.ts  tracking-list.test.ts  tracking-notify.test.ts  tracking-workbench.test.ts
  test/orgs.test.ts                        # 预置字段断言（Task 3）
packages/migrate/
  src/write.ts  test/write.test.ts         # 清理新表、导入后回填（Task 2）
  src/plan-base.ts  test/plan-base.test.ts # 新内置字段（Task 3）
  src/perf.ts  test/perf.test.ts           # 跟进用例（Task 17）
apps/web/
  src/server/routes/tracking.ts  src/server/api.ts  src/server/routes/member-notifications.ts   # Task 10
  test/api/tracking.test.ts                # Task 10
  src/lib/types.ts  src/lib/queries.ts     # Task 11
  src/features/tracking/model.ts  model.test.ts                 # Task 11
  src/features/shell/nav.ts  nav.test.ts  src/components/org-shell.tsx   # Task 11
  src/components/wikilink-textarea.tsx  wiki-text.tsx  follow-button.tsx  src/features/member-notifications/use-mark-read.ts   # Task 11
  src/features/tracking/components/*.tsx   src/app/(app)/[org]/tracking/page.tsx         # Task 12
  src/app/(app)/[org]/requirements/[key]/tracking-panel.tsx  page.tsx   src/features/tracking/components/progress-list.tsx   # Task 13
  src/app/(app)/[org]/work-items/[key]/page.tsx  blockers.tsx   # Task 14
  src/app/(app)/[org]/page.tsx  src/features/workbench/model.ts  model.test.ts  src/app/(app)/[org]/settings/tracking/page.tsx
  src/components/field-card.tsx  src/app/(app)/[org]/settings/workflows/[id]/page.tsx   # Task 15
  e2e/tracking.spec.ts  e2e/work-items.spec.ts                  # Task 16
docs/p3c1-validation.md  docs/handoff.md  docs/agent-log.md     # Task 18
```

---

### Task 1: 停留、暂停区间、老化与无进展的纯函数

**Files:**
- Modify: `packages/core/src/db/schema.ts`（只改 `OrgSettings` 类型，不产生迁移）
- Create: `packages/core/src/tracking/aging.ts`
- Test: `packages/core/test/tracking-aging.test.ts`

**Interfaces:**
- Consumes: `zonedDate(at: Date, timeZone: string): string`、`daysBetween(from: string, to: string): number`（`packages/core/src/dashboard/metrics.ts`）
- Produces（`packages/core/src/tracking/aging.ts`）:
  - `type TrackingSettings = { warnDays: number; alertDays: number; staleUpdateDays: number }`；`DEFAULT_TRACKING_SETTINGS`；`trackingSettingsOf(settings: { tracking?: Partial<TrackingSettings> }): TrackingSettings`
  - `TRACKED_CATEGORIES: readonly string[]`（`unstarted`、`started`）；`CLOSED_CATEGORIES: readonly string[]`（`completed`、`canceled`）
  - `type PauseEvent = { kind: 'paused' | 'resumed'; at: Date }`；`type PauseInterval = { from: Date; to: Date | null }`；`pauseIntervals(events: PauseEvent[]): PauseInterval[]`
  - `activeDays(from: Date | string, until: Date | string | null, today: string, intervals: PauseInterval[], timeZone: string): number`（字符串参数是已换算好的本地日期）
  - `type AgingLevel = 'normal' | 'warn' | 'alert'`；`agingLevel(stageDays: number, paused: boolean, s: TrackingSettings): AgingLevel`；`isStale(lastUpdateAt: Date, paused: boolean, today: string, timeZone: string, s: TrackingSettings): boolean`
  - `OrgSettings`（`schema.ts`）多一个可选键 `tracking?: { warnDays?: number; alertDays?: number; staleUpdateDays?: number }`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/tracking-aging.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { activeDays, agingLevel, DEFAULT_TRACKING_SETTINGS, isStale, pauseIntervals, trackingSettingsOf } from '../src/tracking/aging';

const SH = 'Asia/Shanghai';
const at = (iso: string) => new Date(iso);
const S = DEFAULT_TRACKING_SETTINGS;

describe('暂停区间', () => {
  it('按时间配对暂停与恢复；重复的暂停、没有暂停的恢复忽略；最后一段没有恢复时 to 为 null', () => {
    expect(
      pauseIntervals([
        { kind: 'resumed', at: at('2026-10-01T02:00:00Z') },
        { kind: 'paused', at: at('2026-10-02T02:00:00Z') },
        { kind: 'paused', at: at('2026-10-03T02:00:00Z') },
        { kind: 'resumed', at: at('2026-10-05T02:00:00Z') },
        { kind: 'paused', at: at('2026-10-10T02:00:00Z') },
      ]),
    ).toEqual([
      { from: at('2026-10-02T02:00:00Z'), to: at('2026-10-05T02:00:00Z') },
      { from: at('2026-10-10T02:00:00Z'), to: null },
    ]);
  });

  it('乱序输入先按时间排序', () => {
    expect(
      pauseIntervals([
        { kind: 'resumed', at: at('2026-10-05T02:00:00Z') },
        { kind: 'paused', at: at('2026-10-02T02:00:00Z') },
      ]),
    ).toEqual([{ from: at('2026-10-02T02:00:00Z'), to: at('2026-10-05T02:00:00Z') }]);
  });
});

describe('扣除暂停的天数', () => {
  it('没有暂停：组织时区下的自然日之差', () => {
    // 北京时间 10-13 00:30 进入，当天为 0；按 UTC 算会落到 10-12，多出 1 天
    expect(activeDays(at('2026-10-12T16:30:00Z'), null, '2026-10-13', [], SH)).toBe(0);
    expect(activeDays(at('2026-10-12T16:30:00Z'), null, '2026-10-13', [], 'UTC')).toBe(1);
    expect(activeDays(at('2026-10-01T02:00:00Z'), null, '2026-10-13', [], SH)).toBe(12);
  });

  it('多次暂停都扣除；同一天内暂停又恢复不扣', () => {
    const ivs = [
      { from: at('2026-10-03T02:00:00Z'), to: at('2026-10-05T02:00:00Z') },
      { from: at('2026-10-07T02:00:00Z'), to: at('2026-10-07T08:00:00Z') },
      { from: at('2026-10-09T02:00:00Z'), to: at('2026-10-10T02:00:00Z') },
    ];
    expect(activeDays(at('2026-10-01T02:00:00Z'), null, '2026-10-13', ivs, SH)).toBe(9);
  });

  it('暂停跨状态变化：暂停开始早于进入当前状态时，只扣进入之后的部分', () => {
    const ivs = [{ from: at('2026-10-01T02:00:00Z'), to: at('2026-10-08T02:00:00Z') }];
    expect(activeDays(at('2026-10-05T02:00:00Z'), null, '2026-10-13', ivs, SH)).toBe(5);
  });

  it('正在暂停：天数停在暂停开始那天', () => {
    const ivs = [{ from: at('2026-10-10T02:00:00Z'), to: null }];
    expect(activeDays(at('2026-10-01T02:00:00Z'), null, '2026-10-13', ivs, SH)).toBe(9);
  });

  it('有结束时刻（已完成）时算到结束那天；起点可以是本地日期；起点晚于今天时为 0', () => {
    expect(activeDays('2026-10-01', at('2026-10-06T02:00:00Z'), '2026-10-13', [], SH)).toBe(5);
    expect(activeDays('2026-10-14', null, '2026-10-13', [], SH)).toBe(0);
  });
});

describe('老化与无进展', () => {
  it('超过 14 天标黄、超过 30 天标红；暂停中不标色', () => {
    expect(agingLevel(14, false, S)).toBe('normal');
    expect(agingLevel(15, false, S)).toBe('warn');
    expect(agingLevel(30, false, S)).toBe('warn');
    expect(agingLevel(31, false, S)).toBe('alert');
    expect(agingLevel(99, true, S)).toBe('normal');
  });

  it('最新进展距今超过 7 天为无进展；暂停中不计', () => {
    expect(isStale(at('2026-10-06T02:00:00Z'), false, '2026-10-13', SH, S)).toBe(false);
    expect(isStale(at('2026-10-05T02:00:00Z'), false, '2026-10-13', SH, S)).toBe(true);
    expect(isStale(at('2026-10-01T02:00:00Z'), true, '2026-10-13', SH, S)).toBe(false);
  });

  it('组织设置：缺省或无效项取默认值；标黄不小于标红时这两项回到默认值', () => {
    expect(trackingSettingsOf({})).toEqual(S);
    expect(trackingSettingsOf({ tracking: { warnDays: 7, alertDays: 21, staleUpdateDays: 3 } })).toEqual({ warnDays: 7, alertDays: 21, staleUpdateDays: 3 });
    expect(trackingSettingsOf({ tracking: { warnDays: 0, alertDays: 1.5 } })).toEqual(S);
    expect(trackingSettingsOf({ tracking: { warnDays: 40, alertDays: 30, staleUpdateDays: 5 } })).toEqual({ ...S, staleUpdateDays: 5 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-aging.test.ts`
Expected: FAIL（找不到 `../src/tracking/aging`）。

- [ ] **Step 3: 扩充 `OrgSettings` 类型**

`packages/core/src/db/schema.ts` 中：

```ts
export type OrgSettings = { timezone?: string; structureLevelNames?: string[] };
```

改为：

```ts
/** tracking：跟进的老化阈值（P3-C1），缺省或无效时取默认值，见 tracking/aging.ts 的 trackingSettingsOf。 */
export type OrgSettings = {
  timezone?: string;
  structureLevelNames?: string[];
  tracking?: { warnDays?: number; alertDays?: number; staleUpdateDays?: number };
};
```

- [ ] **Step 4: 实现 `aging.ts`**

新建 `packages/core/src/tracking/aging.ts`：

```ts
/**
 * 工作跟进的停留与老化（P3-C1）：阈值、暂停区间、扣除暂停的天数、老化分档、无进展判定。
 * 纯函数。日期为组织时区下的 YYYY-MM-DD，时刻为 Date；天数按组织时区的自然日计算（同一天为 0）。
 */
import { daysBetween, zonedDate } from '../dashboard/metrics';

export type TrackingSettings = { warnDays: number; alertDays: number; staleUpdateDays: number };
export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = { warnDays: 14, alertDays: 30, staleUpdateDays: 7 };

/** 第一次进入这两类状态时自动加入跟进。 */
export const TRACKED_CATEGORIES: readonly string[] = ['unstarted', 'started'];
/** 处于这两类状态的需求不算在手。 */
export const CLOSED_CATEGORIES: readonly string[] = ['completed', 'canceled'];

const validDays = (v: number | undefined): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 365;

/** 组织设置里的阈值：缺省或无效的项取默认值；标黄不小于标红时这两项回到默认值。 */
export function trackingSettingsOf(settings: { tracking?: Partial<TrackingSettings> }): TrackingSettings {
  const t = settings.tracking ?? {};
  const warnDays = validDays(t.warnDays) ? t.warnDays : DEFAULT_TRACKING_SETTINGS.warnDays;
  const alertDays = validDays(t.alertDays) ? t.alertDays : DEFAULT_TRACKING_SETTINGS.alertDays;
  const staleUpdateDays = validDays(t.staleUpdateDays) ? t.staleUpdateDays : DEFAULT_TRACKING_SETTINGS.staleUpdateDays;
  return warnDays < alertDays
    ? { warnDays, alertDays, staleUpdateDays }
    : { warnDays: DEFAULT_TRACKING_SETTINGS.warnDays, alertDays: DEFAULT_TRACKING_SETTINGS.alertDays, staleUpdateDays };
}

export type PauseEvent = { kind: 'paused' | 'resumed'; at: Date };
export type PauseInterval = { from: Date; to: Date | null };

/** 暂停、恢复事件 → 暂停区间（先按时间排序；已在暂停时的暂停、没有暂停时的恢复忽略）；最后一段没有恢复时 to 为 null。 */
export function pauseIntervals(events: PauseEvent[]): PauseInterval[] {
  const out: PauseInterval[] = [];
  let open: Date | null = null;
  for (const e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (e.kind === 'paused' && !open) open = e.at;
    else if (e.kind === 'resumed' && open) {
      out.push({ from: open, to: e.at });
      open = null;
    }
  }
  if (open) out.push({ from: open, to: null });
  return out;
}

const later = (a: string, b: string): string => (a > b ? a : b);
const earlier = (a: string, b: string): string => (a < b ? a : b);

/**
 * from 到 until（为 null 时到 today）之间的自然日天数，扣除与之相交的暂停区间（同样按自然日）。
 * 正在暂停的区间延伸到 today，相当于天数停在暂停开始那天。字符串参数是已换算好的本地日期。结果不小于 0。
 */
export function activeDays(from: Date | string, until: Date | string | null, today: string, intervals: PauseInterval[], timeZone: string): number {
  const local = (d: Date | string): string => (typeof d === 'string' ? d : zonedDate(d, timeZone));
  const start = local(from);
  const end = until === null ? today : local(until);
  if (end <= start) return 0;
  let paused = 0;
  for (const iv of intervals) {
    const s = later(start, local(iv.from));
    const e = earlier(end, iv.to ? local(iv.to) : today);
    if (e > s) paused += daysBetween(s, e);
  }
  return Math.max(0, daysBetween(start, end) - paused);
}

export type AgingLevel = 'normal' | 'warn' | 'alert';

/** 本阶段停留超过 warnDays 标黄、超过 alertDays 标红；暂停中的条目不标色。 */
export function agingLevel(stageDays: number, paused: boolean, s: TrackingSettings): AgingLevel {
  if (paused) return 'normal';
  if (stageDays > s.alertDays) return 'alert';
  if (stageDays > s.warnDays) return 'warn';
  return 'normal';
}

/** 无进展：最新一条进展（没有时为加入跟进的时间）距今超过 staleUpdateDays 个自然日；暂停中的条目不计。 */
export function isStale(lastUpdateAt: Date, paused: boolean, today: string, timeZone: string, s: TrackingSettings): boolean {
  return !paused && daysBetween(zonedDate(lastUpdateAt, timeZone), today) > s.staleUpdateDays;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-aging.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/db/schema.ts packages/core/src/tracking/aging.ts packages/core/test/tracking-aging.test.ts
git commit -m "feat(core): 跟进的停留、暂停区间、老化与无进展纯函数

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 数据模型：需求五列、工作项与进展记录（RLS）、阻塞项挂工作项、回填与迁移工具清理

**Files:**
- Modify: `packages/core/src/db/schema.ts`、`packages/core/src/requirements/blockers.ts`（只加一处空值判断）、`packages/core/src/index.ts`、`packages/migrate/src/write.ts`、`packages/migrate/test/write.test.ts`
- Create: `packages/core/migrations/0019_*.sql`（生成）、`packages/core/migrations/0020_p3c1_tracking.sql`（`--custom` 生成后填写）、`packages/core/migrations/meta/*`（生成）、`packages/core/src/tracking/backfill.ts`
- Test: `packages/core/test/p3c1-schema.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OrgSettings.tracking`
- Produces:
  - 表（经 `@flower/core` 导出）：`workItems`、`progressUpdates`；常量 `WORK_ITEM_STATUSES = ['active', 'done', 'canceled'] as const`
  - 新列：`requirements.trackedSince`（`Date | null`）、`trackingOptedOut`（`boolean`）、`expectedDate`（`string | null`）、`pausedAt`（`Date | null`）、`pauseReason`（`string | null`）；`organizations.workItemSeq`；`blockers.workItemId`（`requirementId` 改为可空，二者恰有一个非空）
  - `fieldValues.entityType` 取值 `'requirement' | 'work_item'`；`fieldDefinitions.appliesTo` 取值 `'requirement' | 'work_item'`（只改 TypeScript 类型，数据库仍是 text）
  - `backfillTrackedSinceTx(tx: Tx, orgId: string): Promise<number>`（`packages/core/src/tracking/backfill.ts`）
  - `deleteOrgData` 清理新表；`writeImport` 导入后为该组织回填 `tracked_since`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/p3c1-schema.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockers, fieldDefinitions, fieldOptions, organizations, progressUpdates, requirements, stateTransitions, workItems } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { WorkflowBody } from '../src/definitions/workflow-schema';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { backfillTrackedSinceTx } from '../src/tracking/backfill';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
let reqId: string;
const orgB = newId();

const STATES: WorkflowBody['states'] = [
  { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
  { key: 'design', label: '设计中', color: '#60a5fa', order: 2, group: '', category: 'unstarted' },
  { key: 'dev', label: '开发中', color: '#f59e0b', order: 3, group: '', category: 'started' },
  { key: 'done', label: '已上线', color: '#10b981', order: 4, group: '', category: 'completed' },
];

/** 迁移 0020 除第一段（开启 RLS）以外的语句：回填加入跟进时间、补齐内置字段。 */
const BACKFILL = readFileSync(new URL('../migrations/0020_p3c1_tracking.sql', import.meta.url), 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(1);
const runMigrationBackfill = async () => {
  for (const s of BACKFILL) await t.adminDb.execute(sql.raw(s));
};

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  await t.adminDb.insert(organizations).values({ id: orgB, slug: 'b', name: 'B' });
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const wf = await createWorkflowTemplate(t.db, owner, {
    name: '回填流程',
    body: { states: STATES, initial: 'backlog', transitions: STATES.map((s) => ({ from: '*', to: s.key, conditions: [] })), actionGates: [], checkItems: [] },
  });
  await setProductWorkflowVersion(t.db, owner, productId, wf.version.id);
  reqId = (await createRequirement(t.db, owner, productId, { title: '回填用需求' })).id;
});
afterAll(() => t.cleanup());

describe('P3-C1 数据模型', () => {
  it('工作项与进展记录受行级安全约束，各有一条策略', async () => {
    await withOrg(t.db, owner.orgId, async (tx) => {
      const [w] = await tx.insert(workItems).values({ orgId: owner.orgId, number: 1, title: '协助排查', createdBy: owner.memberId }).returning();
      await tx.insert(progressUpdates).values({ orgId: owner.orgId, workItemId: w!.id, body: '已联系对方', authorMemberId: owner.memberId });
    });
    for (const table of [workItems, progressUpdates]) {
      expect(await withOrg(t.db, owner.orgId, (tx) => tx.select().from(table))).toHaveLength(1);
      expect(await withOrg(t.db, orgB, (tx) => tx.select().from(table))).toHaveLength(0);
    }
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename in ('work_items', 'progress_updates')`)) as unknown as [{ n: number }];
    expect(n).toBe(2);
  });

  it('默认值', async () => {
    const [r] = await t.adminDb.select().from(requirements).where(eq(requirements.id, reqId));
    expect(r).toMatchObject({ trackedSince: null, trackingOptedOut: false, expectedDate: null, pausedAt: null, pauseReason: null });
    const [w] = await t.adminDb.select().from(workItems);
    expect(w).toMatchObject({ status: 'active', productId: null, description: '', doneAt: null, pausedAt: null, deletedAt: null });
    const [o] = await t.adminDb.select().from(organizations).where(eq(organizations.id, orgB));
    expect(o!.workItemSeq).toBe(0);
  });

  it('进展记录与阻塞项恰好挂在一个对象上；工作项编号在组织内唯一', async () => {
    const [w] = await t.adminDb.select().from(workItems);
    const base = { orgId: owner.orgId, body: '进展', authorMemberId: owner.memberId };
    await expect(t.adminDb.insert(progressUpdates).values(base)).rejects.toThrow();
    await expect(t.adminDb.insert(progressUpdates).values({ ...base, requirementId: reqId, workItemId: w!.id })).rejects.toThrow();
    await t.adminDb.insert(progressUpdates).values({ ...base, requirementId: reqId });
    await expect(t.adminDb.insert(blockers).values({ orgId: owner.orgId, description: '无对象' })).rejects.toThrow();
    await expect(t.adminDb.insert(blockers).values({ orgId: owner.orgId, requirementId: reqId, workItemId: w!.id, description: '两个对象' })).rejects.toThrow();
    await t.adminDb.insert(blockers).values({ orgId: owner.orgId, workItemId: w!.id, description: '等对方回复' });
    await expect(t.adminDb.insert(workItems).values({ orgId: owner.orgId, number: 1, title: '重复编号' })).rejects.toThrow();
    await t.adminDb.insert(workItems).values({ orgId: orgB, number: 1, title: '另一个组织' });
  });
});

describe('迁移 0020 的回填', () => {
  const ids: Record<string, string> = {};

  /** 改写需求的流转历史与当前状态，并清空加入跟进的时间。 */
  async function rewrite(id: string, steps: Array<[string | null, string, string]>, extra: Partial<typeof requirements.$inferInsert> = {}) {
    await t.adminDb.delete(stateTransitions).where(eq(stateTransitions.requirementId, id));
    for (const [from, to, when] of steps) {
      await t.adminDb.insert(stateTransitions).values({ orgId: owner.orgId, requirementId: id, fromState: from, toState: to, at: new Date(when) });
    }
    const last = steps.at(-1);
    await t.adminDb
      .update(requirements)
      .set({ stateKey: last?.[1] ?? 'backlog', stateChangedAt: new Date(last?.[2] ?? '2026-09-01T00:00:00Z'), trackedSince: null, trackingOptedOut: false, deletedAt: null, ...extra })
      .where(eq(requirements.id, id));
  }

  async function arrange() {
    const start: Array<[string | null, string, string]> = [[null, 'backlog', '2026-09-01T02:00:00Z']];
    await rewrite(ids.r1!, [...start, ['backlog', 'design', '2026-09-05T02:00:00Z'], ['design', 'dev', '2026-09-10T02:00:00Z']]);
    await rewrite(ids.r2!, [...start, ['backlog', 'design', '2026-09-02T02:00:00Z'], ['design', 'done', '2026-09-08T02:00:00Z'], ['done', 'dev', '2026-09-15T02:00:00Z']]);
    await rewrite(ids.r3!, start);
    await rewrite(ids.r4!, [], { stateKey: 'dev', stateChangedAt: new Date('2026-09-20T02:00:00Z') });
    await rewrite(ids.r5!, [...start, ['backlog', 'dev', '2026-09-06T02:00:00Z']], { deletedAt: new Date('2026-09-30T02:00:00Z') });
    await rewrite(ids.r6!, [...start, ['backlog', 'dev', '2026-09-06T02:00:00Z']], { trackingOptedOut: true });
    await rewrite(ids.r7!, [...start, ['backlog', 'dev', '2026-09-06T02:00:00Z']], { trackedSince: new Date('2026-08-01T02:00:00Z') });
  }

  async function trackedOf(): Promise<Record<string, string | null>> {
    const rows = await t.adminDb.select({ id: requirements.id, at: requirements.trackedSince }).from(requirements).where(inArray(requirements.id, Object.values(ids)));
    return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, rows.find((r) => r.id === id)!.at?.toISOString() ?? null]));
  }

  const EXPECTED = {
    r1: '2026-09-05T02:00:00.000Z',
    r2: '2026-09-15T02:00:00.000Z',
    r3: null,
    r4: '2026-09-20T02:00:00.000Z',
    r5: null,
    r6: null,
    r7: '2026-08-01T02:00:00.000Z',
  };

  beforeAll(async () => {
    for (const k of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']) ids[k] = (await createRequirement(t.db, owner, productId, { title: `回填 ${k}` })).id;
  });

  it('取最近一次从其他类别进入未开始或进行中的时间；没有流转时取 state_changed_at；已删除、手动移出、已有值的不变；可重复执行', async () => {
    await arrange();
    await runMigrationBackfill();
    expect(await trackedOf()).toEqual(EXPECTED);
    await runMigrationBackfill();
    expect(await trackedOf()).toEqual(EXPECTED);
  });

  it('迁移工具用的 backfillTrackedSinceTx 与迁移结果一致，返回回填条数', async () => {
    await arrange();
    const n = await withOrg(t.db, owner.orgId, (tx) => backfillTrackedSinceTx(tx, owner.orgId));
    expect(await trackedOf()).toEqual(EXPECTED);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('补齐内置字段「类型」「工作类型」与预置选项，可重复执行', async () => {
    await t.adminDb.execute(sql`delete from field_options where field_id in (select id from field_definitions where key in ('type', 'work_type'))`);
    await t.adminDb.delete(fieldDefinitions).where(inArray(fieldDefinitions.key, ['type', 'work_type']));
    await runMigrationBackfill();
    await runMigrationBackfill();
    for (const org of [owner.orgId, orgB]) {
      const defs = await t.adminDb.select().from(fieldDefinitions).where(and(eq(fieldDefinitions.orgId, org), inArray(fieldDefinitions.key, ['type', 'work_type'])));
      expect(defs.map((d) => [d.key, d.appliesTo, d.builtin, d.cardinality, d.productId]).sort()).toEqual([
        ['type', 'requirement', true, 'single', null],
        ['work_type', 'work_item', true, 'single', null],
      ]);
      const labels = async (key: string) =>
        (await t.adminDb.select().from(fieldOptions).where(eq(fieldOptions.fieldId, defs.find((d) => d.key === key)!.id))).sort((a, b) => a.sort - b.sort).map((o) => o.label);
      expect(await labels('type')).toEqual(['新功能', '体验优化', '线上问题']);
      expect(await labels('work_type')).toEqual(['技术支持', '协调对接']);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/p3c1-schema.test.ts`
Expected: FAIL（`workItems`、`progressUpdates` 不存在）。

- [ ] **Step 3: 修改 `db/schema.ts`**

1. `organizations` 在 `personalEmailChannelId` 之后加一列：

```ts
  /** 工作项编号计数（P3-C1），显示为 W-n。 */
  workItemSeq: integer('work_item_seq').notNull().default(0),
```

2. `fieldDefinitions` 的 `appliesTo` 改为：

```ts
    /** 字段作用的对象（P3-C1 起生效）：需求或工作项。 */
    appliesTo: text('applies_to', { enum: ['requirement', 'work_item'] }).notNull().default('requirement'),
```

3. `requirements` 在 `legacyMeta` 之后加五列：

```ts
    /** 加入跟进的时间（P3-C1）：第一次进入未开始、进行中类别时自动填写，手动移出时清空，上线或取消后保留。 */
    trackedSince: ts('tracked_since'),
    /** 手动移出跟进后为 true，阻止再次自动加入；手动加入时置回 false。 */
    trackingOptedOut: boolean('tracking_opted_out').notNull().default(false),
    /** 预计上线日期。 */
    expectedDate: date('expected_date', { mode: 'string' }),
    /** 暂停中时非空，恢复时清空；暂停与恢复另记领域事件，用来计算扣除暂停的停留天数。 */
    pausedAt: ts('paused_at'),
    pauseReason: text('pause_reason'),
```

4. `fieldValues` 的 `entityType` 改为：

```ts
    entityType: text('entity_type', { enum: ['requirement', 'work_item'] }).notNull(),
```

5. `blockers` 整体替换为：

```ts
export const blockers = pgTable(
  'blockers',
  {
    id: id(),
    orgId: orgRef(),
    /** 挂在需求或工作项上（P3-C1），二者恰有一个非空。 */
    requirementId: uuid('requirement_id').references(() => requirements.id),
    workItemId: uuid('work_item_id').references((): AnyPgColumn => workItems.id),
    description: text('description').notNull(),
    status: text('status', { enum: ['active', 'resolved'] }).notNull().default('active'),
    ownerMemberId: memberRef('owner_member_id'),
    createdAt: createdAt(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    index('blockers_requirement').on(t.requirementId),
    index('blockers_work_item').on(t.workItemId),
    check('blockers_subject', sql`(${t.requirementId} is null) <> (${t.workItemId} is null)`),
  ],
);
```

6. 文件末尾追加：

```ts
// ---------- P3-C1：工作跟进 ----------

export const WORK_ITEM_STATUSES = ['active', 'done', 'canceled'] as const;

/** 不占需求编号的工作（技术支持、协调对接等），按组织编号 W-n，可选关联一个产品。 */
export const workItems = pgTable(
  'work_items',
  {
    id: id(),
    orgId: orgRef(),
    productId: uuid('product_id').references(() => products.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** Markdown，可以 @ 成员。 */
    description: text('description').notNull().default(''),
    ownerMemberId: memberRef('owner_member_id'),
    status: text('status', { enum: WORK_ITEM_STATUSES }).notNull().default('active'),
    startedOn: date('started_on', { mode: 'string' }),
    expectedDate: date('expected_date', { mode: 'string' }),
    /** 进入 done 的时间；改回其他状态时清空。 */
    doneAt: ts('done_at'),
    pausedAt: ts('paused_at'),
    pauseReason: text('pause_reason'),
    createdBy: memberRef('created_by'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('work_items_org_number').on(t.orgId, t.number),
    index('work_items_owner').on(t.ownerMemberId),
    index('work_items_product').on(t.productId),
  ],
);

/** 进展记录：挂在需求或工作项上（恰有一个非空），列表显示最新一条的进展、下一步与跟进人。 */
export const progressUpdates = pgTable(
  'progress_updates',
  {
    id: id(),
    orgId: orgRef(),
    requirementId: uuid('requirement_id').references(() => requirements.id),
    workItemId: uuid('work_item_id').references(() => workItems.id),
    body: text('body').notNull(),
    nextStep: text('next_step'),
    followerMemberId: memberRef('follower_member_id'),
    authorMemberId: memberRef('author_member_id'),
    createdAt: createdAt(),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('progress_updates_subject', sql`(${t.requirementId} is null) <> (${t.workItemId} is null)`),
    index('progress_updates_requirement').on(t.requirementId, t.createdAt),
    index('progress_updates_work_item').on(t.workItemId, t.createdAt),
    index('progress_updates_follower').on(t.followerMemberId),
  ],
);
```

- [ ] **Step 4: `resolveBlocker` 适配可空的 `requirementId`**

`packages/core/src/requirements/blockers.ts` 的 `resolveBlocker` 中：

```ts
    if (!cur) throw new AppError('not_found', '阻塞项不存在');
    const req = await loadRequirement(tx, cur.requirementId);
```

改为：

```ts
    if (!cur || !cur.requirementId) throw new AppError('not_found', '阻塞项不存在');
    const req = await loadRequirement(tx, cur.requirementId);
```

（Task 5 会把工作项上的阻塞项接进来。）

- [ ] **Step 5: 生成迁移并填写 RLS 与回填**

Run: `pnpm --filter @flower/core db:generate`
Expected: 生成 `packages/core/migrations/0019_*.sql`，含 `work_items`、`progress_updates` 两张表与索引；`organizations.work_item_seq`；`requirements` 五列；`blockers` 的 `requirement_id` 去掉 `NOT NULL`、新增 `work_item_id` 与外键、`blockers_subject` 约束与 `blockers_work_item` 索引；`progress_updates_subject` 约束。打开文件核对：没有 `DROP TABLE`、没有改动其他表；`applies_to`、`entity_type` 只是类型变化，不应出现在迁移里。

Run: `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p3c1_tracking`
Expected: 生成空的 `packages/core/migrations/0020_p3c1_tracking.sql`。写入：

```sql
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_items', 'progress_updates'] LOOP
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
-- 回填加入跟进的时间：当前处于未开始、进行中类别，未删除、尚未加入且未手动移出的需求，
-- 取最近一次从这两类之外（或创建）进入这两类的流转时间；没有这样的流转时取 state_changed_at
WITH st AS (
  SELECT p.id AS product_id, s->>'key' AS key, s->>'category' AS category
  FROM products p
  JOIN workflow_versions v ON v.id = p.workflow_version_id,
  jsonb_array_elements(v.body->'states') s
),
cur AS (
  SELECT r.id, r.product_id, r.state_changed_at
  FROM requirements r
  JOIN st ON st.product_id = r.product_id AND st.key = r.state_key
  WHERE r.deleted_at IS NULL AND r.tracked_since IS NULL AND NOT r.tracking_opted_out
    AND st.category IN ('unstarted', 'started')
),
entry AS (
  SELECT tr.requirement_id, max(tr.at) AS at
  FROM state_transitions tr
  JOIN cur ON cur.id = tr.requirement_id
  JOIN st sto ON sto.product_id = cur.product_id AND sto.key = tr.to_state
  LEFT JOIN st sf ON sf.product_id = cur.product_id AND sf.key = tr.from_state
  WHERE sto.category IN ('unstarted', 'started')
    AND coalesce(sf.category, 'backlog') NOT IN ('unstarted', 'started')
  GROUP BY tr.requirement_id
)
UPDATE requirements r
SET tracked_since = coalesce(entry.at, cur.state_changed_at)
FROM cur LEFT JOIN entry ON entry.requirement_id = cur.id
WHERE r.id = cur.id;
--> statement-breakpoint
-- 补齐内置字段「类型」（作用于需求）与「工作类型」（作用于工作项）；已有同 key 组织级字段的组织跳过
INSERT INTO field_definitions (id, org_id, product_id, key, label, cardinality, builtin, applies_to, created_at)
SELECT gen_random_uuid(), o.id, NULL, f.key, f.label, 'single', true, f.applies_to, now()
FROM organizations o
CROSS JOIN (VALUES ('type', '类型', 'requirement'), ('work_type', '工作类型', 'work_item')) AS f(key, label, applies_to)
WHERE NOT EXISTS (SELECT 1 FROM field_definitions d WHERE d.org_id = o.id AND d.product_id IS NULL AND d.key = f.key);
--> statement-breakpoint
-- 预置选项：只给还没有任何选项的这两个内置字段补
INSERT INTO field_options (id, org_id, field_id, key, label, color, sort, active)
SELECT gen_random_uuid(), d.org_id, d.id, o.key, o.label, o.color, o.sort, true
FROM field_definitions d
JOIN (VALUES
  ('type', 'feature', '新功能', '#2563eb', 0),
  ('type', 'improvement', '体验优化', '#0f766e', 1),
  ('type', 'incident', '线上问题', '#dc2626', 2),
  ('work_type', 'support', '技术支持', '#7c3aed', 0),
  ('work_type', 'coordination', '协调对接', '#ea580c', 1)
) AS o(field_key, key, label, color, sort) ON o.field_key = d.key
WHERE d.product_id IS NULL AND d.builtin
  AND NOT EXISTS (SELECT 1 FROM field_options x WHERE x.field_id = d.id);
```

- [ ] **Step 6: 按组织回填的函数（迁移工具用）**

新建 `packages/core/src/tracking/backfill.ts`：

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/tx';

/**
 * 为一个组织回填加入跟进的时间，规则与迁移 0020 的回填语句相同（多了组织条件）：
 * 当前处于未开始、进行中类别，未删除、尚未加入且未手动移出的需求，取最近一次从这两类之外（或创建）进入这两类的流转时间，
 * 没有这样的流转时取 state_changed_at。迁移工具导入旧数据后调用（系统写入，不记事件）。返回回填的需求数。
 */
export async function backfillTrackedSinceTx(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.execute(sql`
    WITH st AS (
      SELECT p.id AS product_id, s->>'key' AS key, s->>'category' AS category
      FROM products p
      JOIN workflow_versions v ON v.id = p.workflow_version_id,
      jsonb_array_elements(v.body->'states') s
      WHERE p.org_id = ${orgId}::uuid
    ),
    cur AS (
      SELECT r.id, r.product_id, r.state_changed_at
      FROM requirements r
      JOIN st ON st.product_id = r.product_id AND st.key = r.state_key
      WHERE r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL AND r.tracked_since IS NULL AND NOT r.tracking_opted_out
        AND st.category IN ('unstarted', 'started')
    ),
    entry AS (
      SELECT tr.requirement_id, max(tr.at) AS at
      FROM state_transitions tr
      JOIN cur ON cur.id = tr.requirement_id
      JOIN st sto ON sto.product_id = cur.product_id AND sto.key = tr.to_state
      LEFT JOIN st sf ON sf.product_id = cur.product_id AND sf.key = tr.from_state
      WHERE sto.category IN ('unstarted', 'started')
        AND coalesce(sf.category, 'backlog') NOT IN ('unstarted', 'started')
      GROUP BY tr.requirement_id
    )
    UPDATE requirements r
    SET tracked_since = coalesce(entry.at, cur.state_changed_at)
    FROM cur LEFT JOIN entry ON entry.requirement_id = cur.id
    WHERE r.id = cur.id
    RETURNING r.id
  `);
  return (rows as unknown as unknown[]).length;
}
```

`packages/core/src/index.ts` 在 `export * from './dashboard/dashboard';` 之后加：

```ts
export * from './tracking/backfill';
```

- [ ] **Step 7: 迁移工具：`--replace` 清理新表，导入后回填**

`packages/migrate/src/write.ts` 的 `deleteOrgData`，在「站内通知」那段 `for` 循环之前加：

```ts
  // 工作跟进：进展记录引用需求、工作项与成员；挂在工作项上的阻塞项引用工作项；工作项引用产品与成员
  await tx.execute(sql`delete from ${core.progressUpdates} where org_id = ${orgId}`);
  await tx.execute(sql`delete from ${core.blockers} where org_id = ${orgId} and work_item_id is not null`);
  await tx.execute(sql`delete from ${core.workItems} where org_id = ${orgId}`);
```

`writeImport` 的事务里，游标初始化的 `tx.execute(...)` 之后加：

```ts
    // 旧系统没有「跟进」：按当前状态类别回填加入跟进的时间，规则与迁移 0020 相同
    await core.backfillTrackedSinceTx(tx, org.id!);
```

`packages/migrate/test/write.test.ts`：

1. `@flower/core` 的导入列表加 `blockers`、`progressUpdates`、`workItems`；`drizzle-orm` 的导入加 `sql`。
2. 「导入后有过正常使用……仍可以 replace」用例里，`await writeImport(t.adminDb, plan, { replace: true });` 之前加：

```ts
    const [wi] = await t.adminDb.insert(workItems).values({ orgId: actor.orgId, number: 1, title: '导入后工作项', createdBy: actor.memberId }).returning();
    await t.adminDb.insert(progressUpdates).values({ orgId: actor.orgId, workItemId: wi!.id, body: '工作项进展', authorMemberId: actor.memberId });
    await t.adminDb.insert(progressUpdates).values({ orgId: actor.orgId, requirementId: created.id, body: '需求进展', authorMemberId: actor.memberId });
    await t.adminDb.insert(blockers).values({ orgId: actor.orgId, workItemId: wi!.id, description: '工作项阻塞' });
```

   在该用例末尾（`for (const table of [memberNotifications, subscriptions, wecomApps])` 那行之后）加：

```ts
    for (const table of [workItems, progressUpdates]) expect(await t.adminDb.select().from(table)).toEqual([]);
    expect(await t.adminDb.select().from(blockers).where(isNotNull(blockers.workItemId))).toEqual([]);
```

3. 在 `describe('写入数据库', …)` 末尾加一个用例：

```ts
  it('导入后为处于未开始、进行中类别的需求回填加入跟进的时间', async () => {
    const [row] = (await t.adminDb.execute(sql`
      with st as (
        select p.id as product_id, s->>'key' as key, s->>'category' as category
        from products p join organizations o on o.id = p.org_id and o.slug = 'pan123'
        join workflow_versions v on v.id = p.workflow_version_id, jsonb_array_elements(v.body->'states') s
      )
      select count(*) filter (where st.category in ('unstarted', 'started'))::int as expected,
             count(r.tracked_since)::int as tracked
      from requirements r join st on st.product_id = r.product_id and st.key = r.state_key
      where r.deleted_at is null`)) as unknown as [{ expected: number; tracked: number }];
    expect(row.expected).toBeGreaterThan(0);
    expect(row.tracked).toBe(row.expected);
  });
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/p3c1-schema.test.ts test/rls.test.ts test/blockers-relations.test.ts && pnpm --filter @flower/migrate exec vitest run test/write.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误。（core 的全局准备会按新迁移重建模板库。）

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/db/schema.ts packages/core/src/requirements/blockers.ts packages/core/src/tracking/backfill.ts packages/core/src/index.ts packages/core/migrations packages/core/test/p3c1-schema.test.ts packages/migrate/src/write.ts packages/migrate/test/write.test.ts
git commit -m "feat(core): P3-C1 数据模型：需求跟进列、工作项与进展记录（RLS）、阻塞项挂工作项、加入跟进时间回填

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 内置字段「类型」「工作类型」与 `applies_to` 生效

**Files:**
- Modify: `packages/core/src/definitions/defaults.ts`、`packages/core/src/definitions/fields.ts`、`packages/core/src/definitions/workflows.ts`、`packages/core/src/requirements/context.ts`、`packages/core/test/orgs.test.ts`、`packages/migrate/src/plan-base.ts`、`packages/migrate/test/plan-base.test.ts`
- Test: `packages/core/test/tracking-fields.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `fieldDefinitions.appliesTo`
- Produces:
  - `BUILTIN_FIELDS` 每项多一个可选 `appliesTo?: 'requirement' | 'work_item'`，新增 `type`（类型：新功能 / 体验优化 / 线上问题）与 `work_type`（工作类型，作用于工作项：技术支持 / 协调对接）
  - `FieldView.appliesTo: 'requirement' | 'work_item'`；`listFields(db, actor, { productId })` 只返回作用于需求的字段，不带 `productId` 时返回全部
  - `effectiveFields` 只返回作用于需求的字段；流程条件 `field_set` 只能引用作用于需求的字段；`forkFieldForProduct` 拒绝工作项字段（「工作项字段只在组织级维护，不能被产品覆盖」）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/tracking-fields.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forkFieldForProduct, listFields } from '../src/definitions/fields';
import { createWorkflowTemplate } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement, setRequirementField } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

describe('内置字段「类型」「工作类型」', () => {
  it('新组织预置两个字段与选项；「工作类型」作用于工作项', async () => {
    const fields = await listFields(t.db, owner);
    const type = fields.find((f) => f.key === 'type')!;
    const workType = fields.find((f) => f.key === 'work_type')!;
    expect(type).toMatchObject({ label: '类型', cardinality: 'single', builtin: true, appliesTo: 'requirement', productId: null });
    expect(type.options.map((o) => [o.key, o.label])).toEqual([
      ['feature', '新功能'],
      ['improvement', '体验优化'],
      ['incident', '线上问题'],
    ]);
    expect(workType).toMatchObject({ label: '工作类型', cardinality: 'single', builtin: true, appliesTo: 'work_item' });
    expect(workType.options.map((o) => [o.key, o.label])).toEqual([
      ['support', '技术支持'],
      ['coordination', '协调对接'],
    ]);
    expect(fields.find((f) => f.key === 'priority')!.appliesTo).toBe('requirement');
  });

  it('需求只用作用于需求的字段：可以设置「类型」，详情里没有「工作类型」，也不能给需求设置它', async () => {
    const type = (await listFields(t.db, owner)).find((f) => f.key === 'type')!;
    const r = await createRequirement(t.db, owner, pan, { title: '类型测试', fields: { type: [type.options[0]!.id] } });
    const d = await getRequirementByKey(t.db, owner, r.displayKey);
    expect(d.fields.find((f) => f.key === 'type')!.options.map((o) => o.label)).toEqual(['新功能']);
    expect(d.fields.map((f) => f.key)).not.toContain('work_type');
    await expect(setRequirementField(t.db, owner, r.id, 'work_type', [])).rejects.toMatchObject({ code: 'not_found' });
    expect((await listFields(t.db, owner, { productId: pan })).map((f) => f.key)).not.toContain('work_type');
  });

  it('工作项字段不能被产品覆盖，也不能作为流程条件', async () => {
    const workType = (await listFields(t.db, owner)).find((f) => f.key === 'work_type')!;
    await expect(forkFieldForProduct(t.db, owner, pan, workType.id)).rejects.toMatchObject({ code: 'invalid', message: '工作项字段只在组织级维护，不能被产品覆盖' });
    await expect(
      createWorkflowTemplate(t.db, owner, {
        name: '用工作类型做条件',
        body: {
          states: [
            { key: 'a', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
            { key: 'b', label: '开发中', color: '#f59e0b', order: 2, group: '', category: 'started' },
          ],
          initial: 'a',
          transitions: [{ from: '*', to: 'b', conditions: [{ type: 'field_set', field: 'work_type' }] }],
          checkItems: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: '流程定义有误' });
  });
});
```

`packages/core/test/orgs.test.ts` 中：

```ts
    expect(fields.map((f) => f.key).sort()).toEqual(['line', 'platform', 'priority', 'source']);
    const opts = await withOrg(t.db, org.id, (tx) => tx.select().from(fieldOptions));
    expect(opts.sort((a, b) => a.sort - b.sort).map((o) => o.label)).toEqual(['P0', 'P1', 'P2', 'P3']);
```

改为：

```ts
    expect(fields.map((f) => f.key).sort()).toEqual(['line', 'platform', 'priority', 'source', 'type', 'work_type']);
    const opts = await withOrg(t.db, org.id, (tx) => tx.select().from(fieldOptions));
    const labelsOf = (key: string) =>
      opts
        .filter((o) => o.fieldId === fields.find((f) => f.key === key)!.id)
        .sort((a, b) => a.sort - b.sort)
        .map((o) => o.label);
    expect(labelsOf('priority')).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(labelsOf('type')).toEqual(['新功能', '体验优化', '线上问题']);
    expect(labelsOf('work_type')).toEqual(['技术支持', '协调对接']);
```

`packages/migrate/test/plan-base.test.ts` 的「字段：优先级含"绿色通道"……」用例末尾加：

```ts
    expect(opt('type')).toEqual(['新功能', '体验优化', '线上问题']);
    expect(opt('work_type')).toEqual(['技术支持', '协调对接']);
    expect(rows.fieldDefinitions.find((f) => f.key === 'work_type')).toMatchObject({ appliesTo: 'work_item', builtin: true });
    expect(rows.fieldDefinitions.find((f) => f.key === 'priority')).toMatchObject({ appliesTo: 'requirement' });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-fields.test.ts test/orgs.test.ts`
Expected: FAIL（没有 `type`、`work_type` 字段；`appliesTo` 不在 `FieldView` 里）。

- [ ] **Step 3: 预置字段**

`packages/core/src/definitions/defaults.ts` 的 `BUILTIN_FIELDS` 改为：

```ts
export const BUILTIN_FIELDS: Array<{
  key: string;
  label: string;
  cardinality: 'single' | 'multi';
  /** 作用的对象，缺省为需求。 */
  appliesTo?: 'requirement' | 'work_item';
  options: Array<{ key: string; label: string; color: string }>;
}> = [
  {
    key: 'priority',
    label: '优先级',
    cardinality: 'single',
    options: [
      { key: 'p0', label: 'P0', color: '#dc2626' },
      { key: 'p1', label: 'P1', color: '#ea580c' },
      { key: 'p2', label: 'P2', color: '#ca8a04' },
      { key: 'p3', label: 'P3', color: '#64748b' },
    ],
  },
  { key: 'platform', label: '平台', cardinality: 'multi', options: [] },
  { key: 'source', label: '来源', cardinality: 'single', options: [] },
  { key: 'line', label: '业务线', cardinality: 'single', options: [] },
  {
    key: 'type',
    label: '类型',
    cardinality: 'single',
    options: [
      { key: 'feature', label: '新功能', color: '#2563eb' },
      { key: 'improvement', label: '体验优化', color: '#0f766e' },
      { key: 'incident', label: '线上问题', color: '#dc2626' },
    ],
  },
  {
    key: 'work_type',
    label: '工作类型',
    cardinality: 'single',
    appliesTo: 'work_item',
    options: [
      { key: 'support', label: '技术支持', color: '#7c3aed' },
      { key: 'coordination', label: '协调对接', color: '#ea580c' },
    ],
  },
];
```

`seedOrgDefaults` 里插入字段定义的一行改为：

```ts
      .values({ orgId, key: f.key, label: f.label, cardinality: f.cardinality, builtin: true, appliesTo: f.appliesTo ?? 'requirement' })
```

- [ ] **Step 4: 需求只取作用于需求的字段**

`packages/core/src/requirements/context.ts` 的 `effectiveFields` 查询条件改为：

```ts
  const defs = await tx
    .select()
    .from(fieldDefinitions)
    .where(and(eq(fieldDefinitions.appliesTo, 'requirement'), or(isNull(fieldDefinitions.productId), eq(fieldDefinitions.productId, productId))));
```

（文件顶部 `drizzle-orm` 的导入里已有 `and`、`eq`、`isNull`、`or`。）

`packages/core/src/definitions/workflows.ts` 的 `fieldKeysFor` 改为：

```ts
/** 流程条件可以引用的字段：作用于需求的组织级字段与本产品覆盖的字段。 */
async function fieldKeysFor(tx: Tx, productId: string | null): Promise<string[]> {
  const scope = productId ? or(isNull(fieldDefinitions.productId), eq(fieldDefinitions.productId, productId)) : isNull(fieldDefinitions.productId);
  const rows = await tx
    .select({ key: fieldDefinitions.key })
    .from(fieldDefinitions)
    .where(and(eq(fieldDefinitions.appliesTo, 'requirement'), scope));
  return [...new Set(rows.map((r) => r.key))];
}
```

- [ ] **Step 5: 字段字典带作用对象，工作项字段不能被产品覆盖**

`packages/core/src/definitions/fields.ts`：

1. `FieldView` 加一个属性：

```ts
export type FieldView = {
  id: string;
  key: string;
  label: string;
  cardinality: 'single' | 'multi';
  builtin: boolean;
  /** 作用的对象：需求或工作项。 */
  appliesTo: 'requirement' | 'work_item';
  productId: string | null;
  options: FieldOptionView[];
};
```

2. `withOptions` 里 `result.push({ … })` 改为：

```ts
    result.push({
      id: f.id, key: f.key, label: f.label, cardinality: f.cardinality, builtin: f.builtin, appliesTo: f.appliesTo, productId: f.productId,
      options: opts.map(optionView),
    });
```

3. `listFields` 的查询条件改为（产品范围只看作用于需求的字段，组织范围返回全部）：

```ts
      .where(
        opts.productId
          ? and(eq(fieldDefinitions.appliesTo, 'requirement'), or(isNull(fieldDefinitions.productId), eq(fieldDefinitions.productId, opts.productId)))
          : isNull(fieldDefinitions.productId),
      )
```

4. `forkFieldForProduct` 中 `if (src.productId) throw new AppError('invalid', '只能复制组织级字段');` 之后加：

```ts
    if (src.appliesTo !== 'requirement') throw new AppError('invalid', '工作项字段只在组织级维护，不能被产品覆盖');
```

- [ ] **Step 6: 迁移工具生成新的内置字段**

`packages/migrate/src/plan-base.ts` 的字段循环改为：

```ts
  for (const f of BUILTIN_FIELDS) {
    const fieldId = ctx.id('field', f.key);
    ctx.fieldId.set(f.key, fieldId);
    rows.fieldDefinitions.push({ id: fieldId, orgId, productId: null, key: f.key, label: f.label, cardinality: f.cardinality, builtin: true, appliesTo: f.appliesTo ?? 'requirement', createdAt });
    (optionSets[f.key] ?? f.options).forEach((o, i) =>
      rows.fieldOptions.push({ id: ctx.id('option', `${f.key}:${o.key}`), orgId, fieldId, key: o.key, label: o.label, color: o.color ?? null, sort: i, active: true }),
    );
  }
```

流程校验那一行改为只用作用于需求的字段：

```ts
  const valid = validateWorkflowBody(ctx.workflow, { fieldKeys: BUILTIN_FIELDS.filter((f) => (f.appliesTo ?? 'requirement') === 'requirement').map((f) => f.key) });
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-fields.test.ts test/orgs.test.ts test/fields.test.ts test/workflows.test.ts test/requirements.test.ts && pnpm --filter @flower/migrate exec vitest run test/plan-base.test.ts test/write.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/definitions packages/core/src/requirements/context.ts packages/core/test/tracking-fields.test.ts packages/core/test/orgs.test.ts packages/migrate/src/plan-base.ts packages/migrate/test/plan-base.test.ts
git commit -m "feat(core): 内置字段「类型」「工作类型」，字段按作用对象区分需求与工作项

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 工作项权限、需求的跟进设置与自动加入、详情带跟进信息

**Files:**
- Create: `packages/core/src/tracking/access.ts`、`packages/core/src/tracking/requirement-tracking.ts`
- Modify: `packages/core/src/requirements/transitions.ts`、`packages/core/src/requirements/requirements.ts`、`packages/core/src/requirements/detail.ts`、`packages/core/src/index.ts`、`packages/core/test/factories.ts`
- Test: `packages/core/test/tracking-requirements.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TRACKED_CATEGORIES`、`CLOSED_CATEGORIES`；Task 2 的 `requirements.trackedSince / trackingOptedOut / expectedDate / pausedAt / pauseReason`、`workItems`；已有的 `productRoleOf`、`atLeast`、`isOrgAdmin`、`requireProductRole`（`access/permissions.ts`），`loadRequirementForUpdate`、`productWorkflowBody`（`requirements/context.ts`），`assertIsoDate`（`dates.ts`），`recordEvent`
- Produces（`packages/core/src/tracking/access.ts`）:
  - `type WorkItemRow = typeof workItems.$inferSelect`；`type WorkItemAccess = { view: boolean; edit: boolean; progress: boolean; manage: boolean }`
  - `canViewUnlinked(actor: Actor): boolean`；`canWriteUnlinked(actor: Actor): boolean`；`canEditUnlinked(actor: Actor, people: { ownerMemberId: string | null; createdBy: string | null }): boolean`
  - `canEditAt(tx: Tx, actor: Actor, productId: string | null, people: { ownerMemberId: string | null; createdBy: string | null }): Promise<boolean>`
  - `workItemAccessTx(tx: Tx, actor: Actor, item: Pick<WorkItemRow, 'productId' | 'ownerMemberId' | 'createdBy'>): Promise<WorkItemAccess>`
  - `requireWorkItemAccess(tx: Tx, actor: Actor, item: Pick<WorkItemRow, 'productId' | 'ownerMemberId' | 'createdBy'>, need: keyof WorkItemAccess): Promise<WorkItemAccess>`
  - `loadWorkItemTx(tx: Tx, id: string, lock?: boolean): Promise<WorkItemRow>`
- Produces（`packages/core/src/tracking/requirement-tracking.ts`）:
  - `type RequirementTracking = { trackedSince: Date | null; active: boolean; optedOut: boolean; expectedDate: string | null; paused: { at: Date; reason: string } | null }`
  - `trackingView(row, category: string): RequirementTracking`；`assertPauseReason(reason: string): string`
  - `autoTrackTx(tx: Tx, actor: Actor, row: { id; productId; trackedSince; trackingOptedOut }, category: string, at: Date): Promise<boolean>`
  - `setExpectedDateTx(tx: Tx, actor: Actor, cur: { id; productId; expectedDate }, next: string | null): Promise<void>`
  - `joinTracking(db, actor, requirementId): Promise<RequirementTracking>`；`leaveTracking(db, actor, requirementId)`；`setRequirementExpectedDate(db, actor, requirementId, expectedDate: string | null)`；`pauseRequirement(db, actor, requirementId, input: { reason: string })`；`resumeRequirement(db, actor, requirementId)`（均返回 `Promise<RequirementTracking>`）
  - `RequirementDetail.tracking: RequirementTracking`
- Produces（`test/factories.ts`）：`trackingWorkflow(initial?: string): WorkflowBody`、`applyTrackingWorkflow(db, owner, productId, initial?): Promise<void>`

- [ ] **Step 1: 测试夹具：跟进用的流程**

`packages/core/test/factories.ts` 顶部导入加一行：

```ts
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
```

文件末尾追加：

```ts
/**
 * 工作跟进测试用的流程：收集（backlog）、设计中（unstarted）、开发中（started）、已上线（completed）、已取消（canceled），
 * 任意状态之间可以流转；initial 为初始状态。
 */
export function trackingWorkflow(initial = 'backlog'): WorkflowBody {
  const states: WorkflowBody['states'] = [
    { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
    { key: 'design', label: '设计中', color: '#60a5fa', order: 2, group: '', category: 'unstarted' },
    { key: 'dev', label: '开发中', color: '#f59e0b', order: 3, group: '', category: 'started' },
    { key: 'done', label: '已上线', color: '#10b981', order: 4, group: '', category: 'completed' },
    { key: 'dropped', label: '已取消', color: '#9ca3af', order: 5, group: '', category: 'canceled' },
  ];
  return { states, initial, transitions: states.map((s) => ({ from: '*', to: s.key, conditions: [] })), actionGates: [], checkItems: [] };
}

/** 给产品换上 trackingWorkflow。 */
export async function applyTrackingWorkflow(db: Db, owner: Actor, productId: string, initial = 'backlog'): Promise<void> {
  const wf = await createWorkflowTemplate(db, owner, { name: `跟进流程（${initial}）`, body: trackingWorkflow(initial) });
  await setProductWorkflowVersion(db, owner, productId, wf.version.id);
}
```

- [ ] **Step 2: 写失败的测试**

新建 `packages/core/test/tracking-requirements.test.ts`：

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, requirements } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { joinTracking, leaveTracking, pauseRequirement, resumeRequirement, setRequirementExpectedDate } from '../src/tracking/requirement-tracking';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let pan: string;
let quick: string;

const create = (title: string, productId = pan) => createRequirement(t.db, owner, productId, { title });
const move = (id: string, to: string) => transitionRequirement(t.db, owner, id, { to });
const row = async (id: string) => (await t.adminDb.select().from(requirements).where(eq(requirements.id, id)))[0]!;
const events = (id: string, types: string[]) =>
  t.adminDb
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.subjectId, id), inArray(domainEvents.type, types)))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  quick = (await createProduct(t.db, owner, { name: '快传', key: 'QK' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  await applyTrackingWorkflow(t.db, owner, quick, 'design');
  viewer = await asMember(t.db, owner, '只读成员');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('自动加入跟进', () => {
  it('第一次进入未开始或进行中类别时加入；收集阶段不加入；之后在这两类之间流转不重复加入', async () => {
    const r = await create('自动加入');
    expect((await row(r.id)).trackedSince).toBeNull();
    await move(r.id, 'design');
    const first = (await row(r.id)).trackedSince;
    expect(first).not.toBeNull();
    await move(r.id, 'dev');
    expect((await row(r.id)).trackedSince).toEqual(first);
    const joined = await events(r.id, ['requirement.tracking_joined']);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.payload).toMatchObject({ auto: true });
  });

  it('初始状态属于未开始类别时，新建即加入跟进', async () => {
    const r = await create('直接进入设计', quick);
    expect((await row(r.id)).trackedSince).not.toBeNull();
    expect(await events(r.id, ['requirement.tracking_joined'])).toHaveLength(1);
  });

  it('重新打开或退回收集：加入时间保留，不重复记加入事件，仍算跟进中', async () => {
    const r = await create('重新打开');
    await move(r.id, 'dev');
    const since = (await row(r.id)).trackedSince;
    await move(r.id, 'done');
    let d = await getRequirementByKey(t.db, owner, r.displayKey);
    expect(d.tracking.active).toBe(false);
    expect(d.tracking.trackedSince).toEqual(since);
    await move(r.id, 'dev');
    d = await getRequirementByKey(t.db, owner, r.displayKey);
    expect(d.tracking.active).toBe(true);
    await move(r.id, 'backlog');
    d = await getRequirementByKey(t.db, owner, r.displayKey);
    expect(d.tracking.active).toBe(true);
    expect(d.tracking.trackedSince).toEqual(since);
    expect(await events(r.id, ['requirement.tracking_joined'])).toHaveLength(1);
  });
});

describe('手动加入与移出', () => {
  it('手动移出后不再自动加入；手动加入（含收集阶段）清掉移出标记；重复加入、未加入时移出报错', async () => {
    const r = await create('手动');
    await expect(leaveTracking(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '需求不在跟进中' });
    expect(await joinTracking(t.db, owner, r.id)).toMatchObject({ active: true, optedOut: false });
    await expect(joinTracking(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '需求已在跟进中' });
    expect(await leaveTracking(t.db, owner, r.id)).toMatchObject({ trackedSince: null, active: false, optedOut: true });
    await move(r.id, 'dev');
    expect((await row(r.id)).trackedSince).toBeNull();
    expect(await joinTracking(t.db, owner, r.id)).toMatchObject({ active: true, optedOut: false });
    const list = await events(r.id, ['requirement.tracking_joined', 'requirement.tracking_left']);
    expect(list.map((e) => [e.type, (e.payload as { auto?: boolean }).auto ?? null])).toEqual([
      ['requirement.tracking_joined', false],
      ['requirement.tracking_left', null],
      ['requirement.tracking_joined', false],
    ]);
  });

  it('已上线或已取消的需求不能加入', async () => {
    const r = await create('已上线');
    await move(r.id, 'done');
    await expect(joinTracking(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '已上线或已取消的需求不能加入跟进' });
  });
});

describe('暂停与预计上线日期', () => {
  it('暂停与恢复：原因必填；重复暂停、没有暂停时恢复报错且不写事件；改状态不自动恢复', async () => {
    const r = await create('暂停');
    await expect(pauseRequirement(t.db, owner, r.id, { reason: '等设计' })).rejects.toMatchObject({ code: 'invalid', message: '只有跟进中的需求可以暂停' });
    await move(r.id, 'design');
    for (const reason of ['  ', 'x'.repeat(201)]) {
      await expect(pauseRequirement(t.db, owner, r.id, { reason })).rejects.toMatchObject({ code: 'invalid', message: '暂停原因不能为空，且不超过 200 个字符' });
    }
    await expect(resumeRequirement(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '需求没有暂停' });
    expect((await pauseRequirement(t.db, owner, r.id, { reason: ' 等法务确认 ' })).paused).toMatchObject({ reason: '等法务确认' });
    await expect(pauseRequirement(t.db, owner, r.id, { reason: '再暂停' })).rejects.toMatchObject({ code: 'invalid', message: '需求已暂停' });
    await move(r.id, 'dev');
    expect((await row(r.id)).pausedAt).not.toBeNull();
    expect((await resumeRequirement(t.db, owner, r.id)).paused).toBeNull();
    await expect(resumeRequirement(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '需求没有暂停' });
    const list = await events(r.id, ['requirement.paused', 'requirement.resumed']);
    expect(list.map((e) => e.type)).toEqual(['requirement.paused', 'requirement.resumed']);
    expect(list[0]!.payload).toMatchObject({ reason: '等法务确认' });
  });

  it('预计上线日期：校验格式；与原值相同时不记事件', async () => {
    const r = await create('预计日期');
    await expect(setRequirementExpectedDate(t.db, owner, r.id, '2026-02-30')).rejects.toMatchObject({ code: 'invalid', message: '预计上线日期格式应为 YYYY-MM-DD' });
    expect(await setRequirementExpectedDate(t.db, owner, r.id, '2026-11-20')).toMatchObject({ expectedDate: '2026-11-20' });
    await setRequirementExpectedDate(t.db, owner, r.id, '2026-11-20');
    expect(await setRequirementExpectedDate(t.db, owner, r.id, null)).toMatchObject({ expectedDate: null });
    expect((await events(r.id, ['requirement.expected_date_changed'])).map((e) => (e.payload as { changes: unknown[] }).changes)).toEqual([
      [{ field: 'expectedDate', old: null, new: '2026-11-20' }],
      [{ field: 'expectedDate', old: '2026-11-20', new: null }],
    ]);
  });

  it('只读成员与只读 Token 不能修改跟进设置；详情里带跟进信息', async () => {
    const r = await create('权限');
    await move(r.id, 'dev');
    for (const a of [viewer, readOnlyToken(owner)]) {
      await expect(pauseRequirement(t.db, a, r.id, { reason: '原因' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(leaveTracking(t.db, a, r.id)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(setRequirementExpectedDate(t.db, a, r.id, '2026-12-01')).rejects.toMatchObject({ code: 'forbidden' });
    }
    const d = await getRequirementByKey(t.db, viewer, r.displayKey);
    expect(d.tracking).toMatchObject({ active: true, optedOut: false, expectedDate: null, paused: null });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-requirements.test.ts`
Expected: FAIL（找不到 `../src/tracking/requirement-tracking`）。

- [ ] **Step 4: 实现工作项权限**

新建 `packages/core/src/tracking/access.ts`：

```ts
/**
 * 工作项的权限（P3-C1）。
 * 关联产品：查看 = 能看到该产品；修改、写进展、挂阻塞项 = 产品编辑及以上；管理（删除别人的进展）= 产品管理员。
 * 不关联产品：查看 = 非访客成员（Token 须为全部产品范围）；修改 = 负责人、创建人或组织管理员（只读 Token 不行）；
 * 写进展、挂阻塞项 = 能查看且非只读；管理 = 组织管理员。
 */
import { and, eq, isNull } from 'drizzle-orm';
import { atLeast, isOrgAdmin, productRoleOf } from '../access/permissions';
import { workItems } from '../db/schema';
import type { Tx } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';

export type WorkItemRow = typeof workItems.$inferSelect;
export type WorkItemAccess = { view: boolean; edit: boolean; progress: boolean; manage: boolean };
type People = { ownerMemberId: string | null; createdBy: string | null };

const readOnly = (actor: Actor): boolean => actor.tokenScope?.access === 'read';

/** 能否看到不关联产品的工作项：非访客成员；用 Token 时须为全部产品范围。 */
export function canViewUnlinked(actor: Actor): boolean {
  return actor.orgRole !== 'guest' && (!actor.tokenScope || actor.tokenScope.products === 'all');
}

/** 能否在不关联产品的工作项上写进展、挂阻塞项，以及新建不关联产品的工作项。 */
export function canWriteUnlinked(actor: Actor): boolean {
  return canViewUnlinked(actor) && !readOnly(actor);
}

/** 能否修改不关联产品的工作项：可以写，且是组织管理员、负责人或创建人。 */
export function canEditUnlinked(actor: Actor, people: People): boolean {
  return canWriteUnlinked(actor) && (isOrgAdmin(actor) || people.ownerMemberId === actor.memberId || people.createdBy === actor.memberId);
}

/** 在某个位置（产品，或不关联产品）上能否修改这个工作项。改关联产品时，目标位置也要用它检查。 */
export async function canEditAt(tx: Tx, actor: Actor, productId: string | null, people: People): Promise<boolean> {
  if (productId) return atLeast(await productRoleOf(tx, actor, productId), 'editor');
  return canEditUnlinked(actor, people);
}

export async function workItemAccessTx(tx: Tx, actor: Actor, item: Pick<WorkItemRow, 'productId' | 'ownerMemberId' | 'createdBy'>): Promise<WorkItemAccess> {
  if (item.productId) {
    const role = await productRoleOf(tx, actor, item.productId);
    const edit = atLeast(role, 'editor');
    return { view: role !== null, edit, progress: edit, manage: role === 'admin' };
  }
  const view = canViewUnlinked(actor);
  return { view, edit: canEditUnlinked(actor, item), progress: canWriteUnlinked(actor), manage: view && isOrgAdmin(actor) };
}

/** 看不到时报「工作项不存在」，看得到但缺少所需权限时报 forbidden。 */
export async function requireWorkItemAccess(
  tx: Tx,
  actor: Actor,
  item: Pick<WorkItemRow, 'productId' | 'ownerMemberId' | 'createdBy'>,
  need: keyof WorkItemAccess,
): Promise<WorkItemAccess> {
  const access = await workItemAccessTx(tx, actor, item);
  if (!access.view) throw new AppError('not_found', '工作项不存在');
  if (!access[need]) {
    throw new AppError('forbidden', need === 'edit' && !item.productId ? '只有负责人、创建人或组织管理员可以修改这个工作项' : '权限不足');
  }
  return access;
}

/** 读取未删除的工作项；lock 为 true 时加行锁（状态、暂停、进展等写操作用，避免并发写出重复的事件）。 */
export async function loadWorkItemTx(tx: Tx, id: string, lock = false): Promise<WorkItemRow> {
  const where = and(eq(workItems.id, id), isNull(workItems.deletedAt));
  const [row] = lock ? await tx.select().from(workItems).where(where).for('update') : await tx.select().from(workItems).where(where);
  if (!row) throw new AppError('not_found', '工作项不存在');
  return row;
}
```

- [ ] **Step 5: 实现需求的跟进设置与自动加入**

新建 `packages/core/src/tracking/requirement-tracking.ts`：

```ts
/**
 * 需求的跟进设置（P3-C1）：自动加入、手动加入与移出、预计上线日期、暂停与恢复。
 * 写操作要求产品编辑及以上，同一事务内记领域事件。暂停与恢复各记一条事件，用来计算扣除暂停的停留天数。
 */
import { eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { loadRequirementForUpdate, productWorkflowBody } from '../requirements/context';
import { CLOSED_CATEGORIES, TRACKED_CATEGORIES } from './aging';

type ReqRow = typeof requirements.$inferSelect;

export type RequirementTracking = {
  /** 加入跟进的时间；从未加入或已移出时为 null。上线或取消后保留。 */
  trackedSince: Date | null;
  /** 跟进中：已加入，且当前状态不在已完成、已取消类别。 */
  active: boolean;
  /** 手动移出过：之后状态变化不再自动加入。 */
  optedOut: boolean;
  expectedDate: string | null;
  paused: { at: Date; reason: string } | null;
};

export function trackingView(row: Pick<ReqRow, 'trackedSince' | 'trackingOptedOut' | 'expectedDate' | 'pausedAt' | 'pauseReason'>, category: string): RequirementTracking {
  return {
    trackedSince: row.trackedSince,
    active: row.trackedSince !== null && !CLOSED_CATEGORIES.includes(category),
    optedOut: row.trackingOptedOut,
    expectedDate: row.expectedDate,
    paused: row.pausedAt ? { at: row.pausedAt, reason: row.pauseReason ?? '' } : null,
  };
}

/** 暂停原因：去掉首尾空白后 1–200 字。需求与工作项共用。 */
export function assertPauseReason(reason: string): string {
  const r = reason.trim();
  if (!r || r.length > 200) throw new AppError('invalid', '暂停原因不能为空，且不超过 200 个字符');
  return r;
}

/** 需求当前状态的类别；状态不在流程里时按 backlog。 */
async function categoryOf(tx: Tx, row: Pick<ReqRow, 'productId' | 'stateKey'>): Promise<string> {
  const body = await productWorkflowBody(tx, row.productId);
  return body.states.find((s) => s.key === row.stateKey)?.category ?? 'backlog';
}

/**
 * 状态进入未开始或进行中类别时自动加入跟进。在调用方的事务里、状态写入之后调用（状态流转、新建需求）。
 * 已加入或曾手动移出的不变。加入时记 requirement.tracking_joined（auto: true）。返回是否加入。
 */
export async function autoTrackTx(
  tx: Tx,
  actor: Actor,
  row: Pick<ReqRow, 'id' | 'productId' | 'trackedSince' | 'trackingOptedOut'>,
  category: string,
  at: Date,
): Promise<boolean> {
  if (!TRACKED_CATEGORIES.includes(category) || row.trackedSince || row.trackingOptedOut) return false;
  await tx.update(requirements).set({ trackedSince: at }).where(eq(requirements.id, row.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: row.productId,
    type: 'requirement.tracking_joined',
    subjectType: 'requirement',
    subjectId: row.id,
    actor,
    payload: { auto: true, changes: [{ field: 'trackedSince', old: null, new: at.toISOString() }] },
  });
  return true;
}

/** 改预计上线日期并记事件（调用方已加锁读取需求并校验权限）；与原值相同时不写。写进展时顺手改日期也用它。 */
export async function setExpectedDateTx(tx: Tx, actor: Actor, cur: Pick<ReqRow, 'id' | 'productId' | 'expectedDate'>, next: string | null): Promise<void> {
  if (cur.expectedDate === next) return;
  await tx.update(requirements).set({ expectedDate: next, updatedAt: new Date() }).where(eq(requirements.id, cur.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: cur.productId,
    type: 'requirement.expected_date_changed',
    subjectType: 'requirement',
    subjectId: cur.id,
    actor,
    payload: { changes: [{ field: 'expectedDate', old: cur.expectedDate, new: next }] },
  });
}

/** 写操作的公共部分：加锁读取需求，要求产品编辑及以上，返回当前行与状态类别。 */
async function lockForTracking(tx: Tx, actor: Actor, requirementId: string): Promise<{ cur: ReqRow; category: string }> {
  const cur = await loadRequirementForUpdate(tx, requirementId);
  await requireProductRole(tx, actor, cur.productId, 'editor');
  return { cur, category: await categoryOf(tx, cur) };
}

export async function joinTracking(db: Db, actor: Actor, requirementId: string): Promise<RequirementTracking> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    if (CLOSED_CATEGORIES.includes(category)) throw new AppError('invalid', '已上线或已取消的需求不能加入跟进');
    if (cur.trackedSince) throw new AppError('invalid', '需求已在跟进中');
    const now = new Date();
    const [row] = await tx.update(requirements).set({ trackedSince: now, trackingOptedOut: false, updatedAt: now }).where(eq(requirements.id, requirementId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.tracking_joined',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { auto: false, changes: [{ field: 'trackedSince', old: null, new: now.toISOString() }] },
    });
    return trackingView(row!, category);
  });
}

/** 移出跟进：只有跟进中的需求可以移出；清空加入时间并记下移出标记。暂停标记不动（暂停与恢复事件始终成对）。 */
export async function leaveTracking(db: Db, actor: Actor, requirementId: string): Promise<RequirementTracking> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    if (!trackingView(cur, category).active) throw new AppError('invalid', '需求不在跟进中');
    const now = new Date();
    const [row] = await tx.update(requirements).set({ trackedSince: null, trackingOptedOut: true, updatedAt: now }).where(eq(requirements.id, requirementId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.tracking_left',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { changes: [{ field: 'trackedSince', old: cur.trackedSince!.toISOString(), new: null }] },
    });
    return trackingView(row!, category);
  });
}

export async function setRequirementExpectedDate(db: Db, actor: Actor, requirementId: string, expectedDate: string | null): Promise<RequirementTracking> {
  const next = expectedDate === null ? null : assertIsoDate(expectedDate, '预计上线日期');
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    await setExpectedDateTx(tx, actor, cur, next);
    return trackingView({ ...cur, expectedDate: next }, category);
  });
}

/** 暂停：只有跟进中的需求可以暂停；状态不变。已在暂停时报错，不写重复的暂停事件。 */
export async function pauseRequirement(db: Db, actor: Actor, requirementId: string, input: { reason: string }): Promise<RequirementTracking> {
  const reason = assertPauseReason(input.reason);
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    if (!trackingView(cur, category).active) throw new AppError('invalid', '只有跟进中的需求可以暂停');
    if (cur.pausedAt) throw new AppError('invalid', '需求已暂停');
    const now = new Date();
    const [row] = await tx.update(requirements).set({ pausedAt: now, pauseReason: reason, updatedAt: now }).where(eq(requirements.id, requirementId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.paused',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { reason, changes: [{ field: 'paused', old: false, new: true }] },
    });
    return trackingView(row!, category);
  });
}

/** 恢复：只要求正在暂停（移出跟进或改状态后也可以恢复）。 */
export async function resumeRequirement(db: Db, actor: Actor, requirementId: string): Promise<RequirementTracking> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { cur, category } = await lockForTracking(tx, actor, requirementId);
    if (!cur.pausedAt) throw new AppError('invalid', '需求没有暂停');
    const now = new Date();
    const [row] = await tx.update(requirements).set({ pausedAt: null, pauseReason: null, updatedAt: now }).where(eq(requirements.id, requirementId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.resumed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { pausedAt: cur.pausedAt.toISOString(), changes: [{ field: 'paused', old: true, new: false }] },
    });
    return trackingView(row!, category);
  });
}
```

- [ ] **Step 6: 状态流转与新建需求时自动加入**

`packages/core/src/requirements/transitions.ts`：导入加一行

```ts
import { autoTrackTx } from '../tracking/requirement-tracking';
```

`transitionRequirement` 中 `type: 'requirement.state_changed'` 那次 `recordEvent(...)` 之后、`return { stateKey: input.to };` 之前加：

```ts
    await autoTrackTx(tx, actor, cur, target.category, now);
```

`packages/core/src/requirements/requirements.ts`：导入加一行

```ts
import { autoTrackTx } from '../tracking/requirement-tracking';
```

`createRequirement` 中 `type: 'requirement.created'` 那次 `recordEvent(...)` 之后、`const [item] = await hydrateList(...)` 之前加：

```ts
    const initialCategory = body.states.find((s) => s.key === body.initial)?.category ?? 'backlog';
    await autoTrackTx(tx, actor, row!, initialCategory, row!.createdAt);
```

- [ ] **Step 7: 需求详情带跟进信息**

`packages/core/src/requirements/detail.ts`：

1. 导入加一行：

```ts
import { type RequirementTracking, trackingView } from '../tracking/requirement-tracking';
```

2. `RequirementDetail` 类型在 `aliases: string[];` 之后加：

```ts
  /** 跟进：加入时间、是否跟进中、预计上线日期、暂停（P3-C1）。 */
  tracking: RequirementTracking;
```

3. 返回对象里 `aliases: aliasRows.map((a) => a.alias).sort(),` 之后加：

```ts
      tracking: trackingView(row, body.states.find((s) => s.key === row.stateKey)?.category ?? 'backlog'),
```

`packages/core/src/index.ts` 在 `export * from './tracking/backfill';` 之后加：

```ts
export * from './tracking/aging';
export * from './tracking/access';
export * from './tracking/requirement-tracking';
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-requirements.test.ts && pnpm --filter @flower/core test && pnpm typecheck`
Expected: 全部 PASS（core 全量测试一并确认多出的 `requirement.tracking_joined` 事件不影响已有断言）；typecheck 无错误。

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/tracking/access.ts packages/core/src/tracking/requirement-tracking.ts packages/core/src/requirements/transitions.ts packages/core/src/requirements/requirements.ts packages/core/src/requirements/detail.ts packages/core/src/index.ts packages/core/test/factories.ts packages/core/test/tracking-requirements.test.ts
git commit -m "feat(core): 需求自动加入跟进、手动加入与移出、预计上线日期、暂停与恢复，工作项权限

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 工作项（编号、增删改查、状态与暂停）与工作项上的阻塞项

**Files:**
- Create: `packages/core/src/tracking/work-items.ts`
- Modify: `packages/core/src/links/syntax.ts`、`packages/core/src/requirements/blockers.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/tracking-work-items.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `workItems`、`organizations.workItemSeq`、`blockers.workItemId`、`fieldValues.entityType = 'work_item'`；Task 3 的内置字段 `work_type`；Task 4 的 `canEditAt`、`workItemAccessTx`、`requireWorkItemAccess`、`loadWorkItemTx`、`WorkItemAccess`、`WorkItemRow`、`assertPauseReason`；已有的 `assertTitle`、`MemberRef`、`OptionRef`（`requirements/requirements.ts`），`assertAssignableMember`、`memberNames`（`requirements/context.ts`），`requireProductRole`、`mentionedMemberIds`、`newMentionIds`、`assertIsoDate`
- Produces:
  - `links/syntax.ts`：`workItemDisplayKey(number: number): string`（`W-n`）、`parseWorkItemKey(key: string): number | null`
  - `tracking/work-items.ts`：`type WorkItemStatus`、`WORK_ITEM_STATUS_LABELS`；`type WorkItemDetail`；`type WorkItemInput = { title: string; description?: string; productId?: string | null; ownerMemberId?: string | null; workTypeOptionId?: string | null; startedOn?: string | null; expectedDate?: string | null }`；`type WorkItemPatch = Partial<WorkItemInput>`
  - `createWorkItem(db, actor, input: WorkItemInput): Promise<WorkItemDetail>`；`getWorkItemByKey(db, actor, key: string): Promise<WorkItemDetail>`；`updateWorkItem(db, actor, id, patch: WorkItemPatch)`；`setWorkItemStatus(db, actor, id, status: WorkItemStatus)`；`pauseWorkItem(db, actor, id, input: { reason: string })`；`resumeWorkItem(db, actor, id)`（均返回 `Promise<WorkItemDetail>`）；`deleteWorkItem(db, actor, id): Promise<void>`
  - `requirements/blockers.ts`：`createWorkItemBlocker(db, actor, workItemId, input: { description: string; ownerMemberId?: string | null }): Promise<BlockerView>`；`resolveBlocker` 同时处理需求与工作项上的阻塞项

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/tracking-work-items.test.ts`：

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { listFields } from '../src/definitions/fields';
import type { Actor } from '../src/domain-types';
import { mentionMarkup, parseWorkItemKey, workItemDisplayKey } from '../src/links/syntax';
import { createWorkItemBlocker, resolveBlocker } from '../src/requirements/blockers';
import { createProduct, setProductRole } from '../src/tenancy/products';
import {
  createWorkItem,
  deleteWorkItem,
  getWorkItemByKey,
  pauseWorkItem,
  resumeWorkItem,
  setWorkItemStatus,
  updateWorkItem,
} from '../src/tracking/work-items';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let ed: Actor;
let peer: Actor;
let docViewer: Actor;
let guest: Actor;
let panToken: Actor;
let pan: string;
let doc: string;
let support: string;
let p0: string;

const events = (id: string, types: string[]) =>
  t.adminDb
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.subjectId, id), inArray(domainEvents.type, types)))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  ed = await asMember(t.db, owner, '编辑甲');
  peer = await asMember(t.db, owner, '同事乙');
  docViewer = await asMember(t.db, owner, '文档只读丙');
  await setProductRole(t.db, owner, doc, docViewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '外部丁', 'guest');
  await setProductRole(t.db, owner, pan, guest.memberId, 'editor');
  panToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f2', tokenScope: { products: [pan], access: 'write' } };
  const fields = await listFields(t.db, owner);
  support = fields.find((f) => f.key === 'work_type')!.options.find((o) => o.key === 'support')!.id;
  p0 = fields.find((f) => f.key === 'priority')!.options.find((o) => o.key === 'p0')!.id;
});
afterAll(() => t.cleanup());

describe('编号', () => {
  it('W-n 的显示与解析（不区分大小写）', () => {
    expect(workItemDisplayKey(12)).toBe('W-12');
    expect(parseWorkItemKey('w-12')).toBe(12);
    expect(parseWorkItemKey(' W-3 ')).toBe(3);
    expect(parseWorkItemKey('PAN-3')).toBeNull();
  });
});

describe('工作项', () => {
  it('新建：按组织连续编号；工作类型、负责人、日期；记事件；按编号打开；校验工作类型与日期', async () => {
    await expect(createWorkItem(t.db, ed, { title: '错的类型', workTypeOptionId: p0 })).rejects.toMatchObject({ code: 'invalid', message: '选项不属于「工作类型」' });
    await expect(createWorkItem(t.db, ed, { title: '错的日期', startedOn: '2026-13-01' })).rejects.toMatchObject({ code: 'invalid', message: '启动日期格式应为 YYYY-MM-DD' });
    const w1 = await createWorkItem(t.db, ed, { title: ' 协助客服排查 ', workTypeOptionId: support, ownerMemberId: ed.memberId, startedOn: '2026-10-08', expectedDate: '2026-10-20' });
    expect(w1).toMatchObject({
      number: 1,
      displayKey: 'W-1',
      title: '协助客服排查',
      product: null,
      status: 'active',
      startedOn: '2026-10-08',
      expectedDate: '2026-10-20',
      doneAt: null,
      paused: null,
      workType: { id: support, label: '技术支持' },
      owner: { id: ed.memberId, displayName: '编辑甲' },
      createdBy: { id: ed.memberId, displayName: '编辑甲' },
      access: { view: true, edit: true, progress: true, manage: false },
      blockers: [],
    });
    const w2 = await createWorkItem(t.db, owner, { title: '对接渠道', productId: pan });
    expect(w2).toMatchObject({ displayKey: 'W-2', product: { id: pan, key: 'PAN', name: '网盘' } });
    expect((await getWorkItemByKey(t.db, ed, 'w-1')).id).toBe(w1.id);
    expect((await events(w1.id, ['work_item.created']))[0]!.payload).toMatchObject({ number: 1, title: '协助客服排查', ownerMemberId: ed.memberId });
    for (const key of ['W-99', 'PAN-1']) await expect(getWorkItemByKey(t.db, ed, key)).rejects.toMatchObject({ code: 'not_found', message: '工作项不存在' });
  });

  it('描述里的 @ 与负责人变化写进事件', async () => {
    const w = await createWorkItem(t.db, ed, { title: '描述', description: `请 ${mentionMarkup(peer.memberId, '同事乙')} 看` });
    expect((await events(w.id, ['work_item.created']))[0]!.payload).toMatchObject({ mentionedMemberIds: [peer.memberId] });
    await updateWorkItem(t.db, ed, w.id, { description: `请 ${mentionMarkup(peer.memberId, '同事乙')} ${mentionMarkup(owner.memberId, 'Owner')} 看`, ownerMemberId: peer.memberId });
    expect((await events(w.id, ['work_item.updated']))[0]!.payload).toMatchObject({
      mentionedMemberIds: [owner.memberId],
      changes: expect.arrayContaining([{ field: 'ownerMemberId', old: null, new: peer.memberId }]),
    });
  });

  it('不关联产品：非访客成员可以查看；负责人、创建人、组织管理员可以修改；访客、限定产品的 Token 看不到；只读 Token 不能修改与新建', async () => {
    const w = await createWorkItem(t.db, ed, { title: '不关联产品的工作' });
    expect((await getWorkItemByKey(t.db, peer, w.displayKey)).access).toEqual({ view: true, edit: false, progress: true, manage: false });
    await expect(updateWorkItem(t.db, peer, w.id, { title: '改名' })).rejects.toMatchObject({ code: 'forbidden', message: '只有负责人、创建人或组织管理员可以修改这个工作项' });
    await updateWorkItem(t.db, ed, w.id, { ownerMemberId: peer.memberId });
    expect((await updateWorkItem(t.db, peer, w.id, { title: '负责人改名' })).title).toBe('负责人改名');
    expect((await getWorkItemByKey(t.db, owner, w.displayKey)).access).toEqual({ view: true, edit: true, progress: true, manage: true });
    for (const a of [guest, panToken]) await expect(getWorkItemByKey(t.db, a, w.displayKey)).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateWorkItem(t.db, readOnlyToken(owner), w.id, { title: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    for (const a of [guest, readOnlyToken(owner)]) await expect(createWorkItem(t.db, a, { title: '新建' })).rejects.toMatchObject({ code: 'forbidden', message: '没有新建工作项的权限' });
  });

  it('改关联产品的权限：目标位置也要有修改权限', async () => {
    const w = await createWorkItem(t.db, peer, { title: '别人的产品工作', productId: pan });
    await expect(updateWorkItem(t.db, ed, w.id, { productId: null })).rejects.toMatchObject({
      code: 'forbidden',
      message: '只有负责人、创建人或组织管理员可以把工作项改为不关联产品',
    });
    await expect(updateWorkItem(t.db, docViewer, w.id, { productId: doc })).rejects.toMatchObject({ code: 'forbidden', message: '权限不足' });
    await expect(updateWorkItem(t.db, guest, w.id, { productId: doc })).rejects.toMatchObject({ code: 'not_found', message: '产品不存在' });
    expect((await updateWorkItem(t.db, ed, w.id, { productId: doc })).product).toMatchObject({ key: 'DOC' });
    expect((await updateWorkItem(t.db, peer, w.id, { productId: null })).product).toBeNull();
    const last = (await events(w.id, ['work_item.updated'])).at(-1)!;
    expect(last.payload).toMatchObject({ changes: [{ field: 'productId', old: doc, new: null }] });
    expect(last.productId).toBeNull();
  });

  it('状态与暂停：改成当前状态、重复暂停、没有暂停时恢复、已完成时暂停都报错，不写重复事件；改状态不自动恢复', async () => {
    const w = await createWorkItem(t.db, ed, { title: '状态测试' });
    await expect(setWorkItemStatus(t.db, ed, w.id, 'active')).rejects.toMatchObject({ code: 'invalid', message: '工作项已处于该状态' });
    await expect(resumeWorkItem(t.db, ed, w.id)).rejects.toMatchObject({ code: 'invalid', message: '工作项没有暂停' });
    expect((await pauseWorkItem(t.db, ed, w.id, { reason: '等对方排期' })).paused).toMatchObject({ reason: '等对方排期' });
    await expect(pauseWorkItem(t.db, ed, w.id, { reason: '再暂停' })).rejects.toMatchObject({ code: 'invalid', message: '工作项已暂停' });
    const done = await setWorkItemStatus(t.db, ed, w.id, 'done');
    expect(done.status).toBe('done');
    expect(done.doneAt).not.toBeNull();
    expect(done.paused).not.toBeNull();
    await resumeWorkItem(t.db, ed, w.id);
    await expect(pauseWorkItem(t.db, ed, w.id, { reason: '完成后暂停' })).rejects.toMatchObject({ code: 'invalid', message: '只有进行中的工作项可以暂停' });
    expect((await setWorkItemStatus(t.db, ed, w.id, 'active')).doneAt).toBeNull();
    expect((await events(w.id, ['work_item.paused', 'work_item.resumed', 'work_item.status_changed'])).map((e) => e.type)).toEqual([
      'work_item.paused',
      'work_item.status_changed',
      'work_item.resumed',
      'work_item.status_changed',
    ]);
  });

  it('删除：只有能修改的人可以删；删除后按编号打不开，也不能再改状态', async () => {
    const w = await createWorkItem(t.db, ed, { title: '要删除的' });
    await expect(deleteWorkItem(t.db, peer, w.id)).rejects.toMatchObject({ code: 'forbidden' });
    await deleteWorkItem(t.db, ed, w.id);
    await expect(getWorkItemByKey(t.db, ed, w.displayKey)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setWorkItemStatus(t.db, ed, w.id, 'done')).rejects.toMatchObject({ code: 'not_found', message: '工作项不存在' });
    expect(await events(w.id, ['work_item.deleted'])).toHaveLength(1);
  });

  it('阻塞项挂在工作项上：能写进展的人可以新建与解除；详情列出；事件挂在工作项上', async () => {
    const w = await createWorkItem(t.db, ed, { title: '阻塞测试' });
    const b = await createWorkItemBlocker(t.db, peer, w.id, { description: ' 等对方回复 ' });
    expect(b).toMatchObject({ description: '等对方回复', status: 'active' });
    expect((await getWorkItemByKey(t.db, ed, w.displayKey)).blockers.map((x) => x.description)).toEqual(['等对方回复']);
    await expect(createWorkItemBlocker(t.db, readOnlyToken(owner), w.id, { description: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolveBlocker(t.db, guest, b.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await resolveBlocker(t.db, peer, b.id)).status).toBe('resolved');
    expect((await events(w.id, ['blocker.created', 'blocker.resolved'])).map((e) => [e.type, e.subjectType])).toEqual([
      ['blocker.created', 'work_item'],
      ['blocker.resolved', 'work_item'],
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-work-items.test.ts`
Expected: FAIL（`parseWorkItemKey`、`../src/tracking/work-items` 不存在）。

- [ ] **Step 3: 编号的显示与解析**

`packages/core/src/links/syntax.ts` 在 `export const taskDisplayKey = …` 一行之后加：

```ts
/** 工作项编号（P3-C1）：按组织连续编号，不带产品前缀。 */
export const workItemDisplayKey = (number: number): string => `W-${number}`;

/** 解析 `W-n`（不区分大小写，忽略首尾空白）；不是工作项编号时返回 null。 */
export function parseWorkItemKey(key: string): number | null {
  const m = /^W-(\d{1,9})$/i.exec(key.trim());
  return m ? Number(m[1]) : null;
}
```

- [ ] **Step 4: 实现工作项**

新建 `packages/core/src/tracking/work-items.ts`：

```ts
/**
 * 工作项（P3-C1）：不占需求编号的工作（技术支持、协调对接等），按组织编号 W-n，可选关联一个产品。
 * 权限见 access.ts；每个写操作在同一事务内记领域事件。删除为软删除。
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { blockers, fieldDefinitions, fieldOptions, fieldValues, organizations, products, WORK_ITEM_STATUSES, workItems } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { mentionedMemberIds, newMentionIds, parseWorkItemKey, workItemDisplayKey } from '../links/syntax';
import type { BlockerView } from '../requirements/blockers';
import { assertAssignableMember, memberNames } from '../requirements/context';
import { assertTitle, type MemberRef, type OptionRef } from '../requirements/requirements';
import { canEditAt, loadWorkItemTx, requireWorkItemAccess, type WorkItemAccess, workItemAccessTx, type WorkItemRow } from './access';
import { assertPauseReason } from './requirement-tracking';

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export const WORK_ITEM_STATUS_LABELS: Record<WorkItemStatus, string> = { active: '进行中', done: '已完成', canceled: '已取消' };

export type WorkItemDetail = {
  id: string;
  number: number;
  displayKey: string;
  product: { id: string; key: string; name: string } | null;
  title: string;
  /** Markdown，可以 @ 成员。 */
  description: string;
  owner: MemberRef | null;
  createdBy: MemberRef | null;
  workType: OptionRef | null;
  status: WorkItemStatus;
  startedOn: string | null;
  expectedDate: string | null;
  doneAt: Date | null;
  paused: { at: Date; reason: string } | null;
  createdAt: Date;
  updatedAt: Date;
  /** 当前用户对它的权限：查看、修改、写进展与挂阻塞项、管理（删除别人的进展）。 */
  access: WorkItemAccess;
  blockers: BlockerView[];
};

export type WorkItemInput = {
  title: string;
  description?: string;
  productId?: string | null;
  ownerMemberId?: string | null;
  workTypeOptionId?: string | null;
  startedOn?: string | null;
  expectedDate?: string | null;
};
export type WorkItemPatch = Partial<WorkItemInput>;

function assertDescription(d: string): string {
  if (d.length > 50_000) throw new AppError('invalid', '描述不超过 50000 个字符');
  return d;
}

const dateOrNull = (v: string | null | undefined, label: string): string | null => (v ? assertIsoDate(v, label) : null);

/** 组织级内置字段「工作类型」及其选项；组织没有这个字段时为 null。 */
async function workTypeField(tx: Tx) {
  const [field] = await tx
    .select()
    .from(fieldDefinitions)
    .where(and(eq(fieldDefinitions.key, 'work_type'), isNull(fieldDefinitions.productId), eq(fieldDefinitions.appliesTo, 'work_item')));
  if (!field) return null;
  const options = await tx.select().from(fieldOptions).where(eq(fieldOptions.fieldId, field.id)).orderBy(asc(fieldOptions.sort));
  return { field, options };
}

/** 校验工作类型选项：属于「工作类型」字段，且未停用（停用但等于原值时放行）。 */
async function assertWorkType(tx: Tx, optionId: string, previous: string | null): Promise<{ fieldId: string; label: string }> {
  const wt = await workTypeField(tx);
  const option = wt?.options.find((o) => o.id === optionId);
  if (!wt || !option) throw new AppError('invalid', '选项不属于「工作类型」');
  if (!option.active && optionId !== previous) throw new AppError('invalid', `选项「${option.label}」已停用`);
  return { fieldId: wt.field.id, label: option.label };
}

async function currentWorkType(tx: Tx, itemId: string): Promise<OptionRef | null> {
  const [v] = await tx
    .select({ id: fieldOptions.id, key: fieldOptions.key, label: fieldOptions.label, color: fieldOptions.color })
    .from(fieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
    .where(and(eq(fieldValues.entityType, 'work_item'), eq(fieldValues.entityId, itemId), eq(fieldDefinitions.key, 'work_type')));
  return v ?? null;
}

async function writeWorkType(tx: Tx, orgId: string, itemId: string, fieldId: string, optionId: string | null): Promise<void> {
  await tx.delete(fieldValues).where(and(eq(fieldValues.entityId, itemId), eq(fieldValues.fieldId, fieldId)));
  if (optionId) await tx.insert(fieldValues).values({ orgId, entityType: 'work_item', entityId: itemId, fieldId, optionId });
}

async function detailTx(tx: Tx, actor: Actor, row: WorkItemRow): Promise<WorkItemDetail> {
  const access = await workItemAccessTx(tx, actor, row);
  const [product] = row.productId
    ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(eq(products.id, row.productId))
    : [];
  const blockerRows = await tx.select().from(blockers).where(eq(blockers.workItemId, row.id)).orderBy(asc(blockers.createdAt));
  const names = await memberNames(tx, [row.ownerMemberId, row.createdBy, ...blockerRows.map((b) => b.ownerMemberId)]);
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  return {
    id: row.id,
    number: row.number,
    displayKey: workItemDisplayKey(row.number),
    product: product ?? null,
    title: row.title,
    description: row.description,
    owner: ref(row.ownerMemberId),
    createdBy: ref(row.createdBy),
    workType: await currentWorkType(tx, row.id),
    status: row.status,
    startedOn: row.startedOn,
    expectedDate: row.expectedDate,
    doneAt: row.doneAt,
    paused: row.pausedAt ? { at: row.pausedAt, reason: row.pauseReason ?? '' } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    access,
    blockers: blockerRows.map((b) => ({ id: b.id, description: b.description, status: b.status, owner: ref(b.ownerMemberId), createdAt: b.createdAt, resolvedAt: b.resolvedAt })),
  };
}

export async function createWorkItem(db: Db, actor: Actor, input: WorkItemInput): Promise<WorkItemDetail> {
  const title = assertTitle(input.title);
  const description = assertDescription(input.description ?? '');
  const startedOn = dateOrNull(input.startedOn, '启动日期');
  const expectedDate = dateOrNull(input.expectedDate, '预计完成日期');
  return withOrg(db, actor.orgId, async (tx) => {
    const productId = input.productId ?? null;
    if (productId) await requireProductRole(tx, actor, productId, 'editor');
    else if (!(await canEditAt(tx, actor, null, { ownerMemberId: null, createdBy: actor.memberId }))) throw new AppError('forbidden', '没有新建工作项的权限');
    if (input.ownerMemberId) await assertAssignableMember(tx, input.ownerMemberId);
    const workType = input.workTypeOptionId ? await assertWorkType(tx, input.workTypeOptionId, null) : null;
    const [seq] = await tx
      .update(organizations)
      .set({ workItemSeq: sql`${organizations.workItemSeq} + 1` })
      .where(eq(organizations.id, actor.orgId))
      .returning({ n: organizations.workItemSeq });
    const [row] = await tx
      .insert(workItems)
      .values({ orgId: actor.orgId, productId, number: seq!.n, title, description, ownerMemberId: input.ownerMemberId ?? null, startedOn, expectedDate, createdBy: actor.memberId })
      .returning();
    if (workType) await writeWorkType(tx, actor.orgId, row!.id, workType.fieldId, input.workTypeOptionId!);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: row!.id,
      actor,
      payload: { number: row!.number, title, ownerMemberId: row!.ownerMemberId, mentionedMemberIds: mentionedMemberIds(description) },
    });
    return detailTx(tx, actor, row!);
  });
}

export async function getWorkItemByKey(db: Db, actor: Actor, key: string): Promise<WorkItemDetail> {
  const number = parseWorkItemKey(key);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = number === null ? [] : await tx.select().from(workItems).where(and(eq(workItems.number, number), isNull(workItems.deletedAt)));
    if (!row) throw new AppError('not_found', '工作项不存在');
    await requireWorkItemAccess(tx, actor, row, 'view');
    return detailTx(tx, actor, row);
  });
}

/**
 * 修改字段。改关联产品时目标位置也要有修改权限：移到产品需要该产品编辑及以上；改为不关联产品需要是
 * 负责人、创建人或组织管理员（按修改之前的负责人与创建人判断）。
 */
export async function updateWorkItem(db: Db, actor: Actor, id: string, input: WorkItemPatch): Promise<WorkItemDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    const next = {
      title: input.title === undefined ? cur.title : assertTitle(input.title),
      description: input.description === undefined ? cur.description : assertDescription(input.description),
      productId: input.productId === undefined ? cur.productId : input.productId,
      ownerMemberId: input.ownerMemberId === undefined ? cur.ownerMemberId : input.ownerMemberId,
      startedOn: input.startedOn === undefined ? cur.startedOn : dateOrNull(input.startedOn, '启动日期'),
      expectedDate: input.expectedDate === undefined ? cur.expectedDate : dateOrNull(input.expectedDate, '预计完成日期'),
    };
    if (next.productId !== cur.productId) {
      if (next.productId) await requireProductRole(tx, actor, next.productId, 'editor');
      else if (!(await canEditAt(tx, actor, null, cur))) throw new AppError('forbidden', '只有负责人、创建人或组织管理员可以把工作项改为不关联产品');
    }
    if (next.ownerMemberId && next.ownerMemberId !== cur.ownerMemberId) await assertAssignableMember(tx, next.ownerMemberId);
    const changes: Array<{ field: string; old: unknown; new: unknown }> = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    if (input.workTypeOptionId !== undefined) {
      const before = await currentWorkType(tx, id);
      if ((before?.id ?? null) !== input.workTypeOptionId) {
        const picked = input.workTypeOptionId ? await assertWorkType(tx, input.workTypeOptionId, before?.id ?? null) : null;
        const fieldId = picked?.fieldId ?? (await workTypeField(tx))?.field.id;
        if (fieldId) await writeWorkType(tx, actor.orgId, id, fieldId, input.workTypeOptionId);
        changes.push({ field: 'workType', old: before?.label ?? null, new: picked?.label ?? null });
      }
    }
    if (changes.length === 0) return detailTx(tx, actor, cur);
    const [row] = await tx.update(workItems).set({ ...next, updatedAt: new Date() }).where(eq(workItems.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: next.productId,
      type: 'work_item.updated',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { changes, ...(next.description !== cur.description ? { mentionedMemberIds: newMentionIds(cur.description, next.description) } : {}) },
    });
    return detailTx(tx, actor, row!);
  });
}

/** 改状态：改成 done 时记完成时间，改成其他状态时清空；暂停标记不动。 */
export async function setWorkItemStatus(db: Db, actor: Actor, id: string, status: WorkItemStatus): Promise<WorkItemDetail> {
  if (!(WORK_ITEM_STATUSES as readonly string[]).includes(status)) throw new AppError('invalid', '状态无效');
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    if (cur.status === status) throw new AppError('invalid', '工作项已处于该状态');
    const now = new Date();
    const [row] = await tx.update(workItems).set({ status, doneAt: status === 'done' ? now : null, updatedAt: now }).where(eq(workItems.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'work_item.status_changed',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { changes: [{ field: 'status', old: cur.status, new: status }] },
    });
    return detailTx(tx, actor, row!);
  });
}

/** 暂停：只有进行中的工作项可以暂停；已在暂停时报错，不写重复的暂停事件。 */
export async function pauseWorkItem(db: Db, actor: Actor, id: string, input: { reason: string }): Promise<WorkItemDetail> {
  const reason = assertPauseReason(input.reason);
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    if (cur.status !== 'active') throw new AppError('invalid', '只有进行中的工作项可以暂停');
    if (cur.pausedAt) throw new AppError('invalid', '工作项已暂停');
    const now = new Date();
    const [row] = await tx.update(workItems).set({ pausedAt: now, pauseReason: reason, updatedAt: now }).where(eq(workItems.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'work_item.paused',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { reason, changes: [{ field: 'paused', old: false, new: true }] },
    });
    return detailTx(tx, actor, row!);
  });
}

/** 恢复：只要求正在暂停（已完成的工作项也可以恢复）。 */
export async function resumeWorkItem(db: Db, actor: Actor, id: string): Promise<WorkItemDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    if (!cur.pausedAt) throw new AppError('invalid', '工作项没有暂停');
    const now = new Date();
    const [row] = await tx.update(workItems).set({ pausedAt: null, pauseReason: null, updatedAt: now }).where(eq(workItems.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'work_item.resumed',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { pausedAt: cur.pausedAt.toISOString(), changes: [{ field: 'paused', old: true, new: false }] },
    });
    return detailTx(tx, actor, row!);
  });
}

export async function deleteWorkItem(db: Db, actor: Actor, id: string): Promise<void> {
  await withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    await tx.update(workItems).set({ deletedAt: new Date() }).where(eq(workItems.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'work_item.deleted',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { number: cur.number, title: cur.title },
    });
  });
}
```

- [ ] **Step 5: 阻塞项挂在工作项上**

`packages/core/src/requirements/blockers.ts`：

1. 导入改为：

```ts
import { eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { blockers, requirements, workItems } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { loadWorkItemTx, requireWorkItemAccess } from '../tracking/access';
import { assertAssignableMember, loadRequirement, memberNames } from './context';
import type { MemberRef } from './requirements';
```

2. 在 `createBlocker` 之后加：

```ts
/** 工作项上的阻塞项：能写进展的人可以新建（P3-C1）。事件挂在工作项上。 */
export async function createWorkItemBlocker(
  db: Db,
  actor: Actor,
  workItemId: string,
  input: { description: string; ownerMemberId?: string | null },
): Promise<BlockerView> {
  const description = assertDescription(input.description);
  return withOrg(db, actor.orgId, async (tx) => {
    const item = await loadWorkItemTx(tx, workItemId, true);
    await requireWorkItemAccess(tx, actor, item, 'progress');
    if (input.ownerMemberId) await assertAssignableMember(tx, input.ownerMemberId);
    const [row] = await tx
      .insert(blockers)
      .values({ orgId: actor.orgId, workItemId, description, ownerMemberId: input.ownerMemberId ?? null })
      .returning();
    await tx.update(workItems).set({ updatedAt: new Date() }).where(eq(workItems.id, workItemId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: item.productId,
      type: 'blocker.created',
      subjectType: 'work_item',
      subjectId: workItemId,
      actor,
      payload: { blockerId: row!.id, description },
    });
    return toView(tx, row!);
  });
}
```

3. `resolveBlocker` 整体替换为（Task 2 加的空值判断一并被替换）：

```ts
/** 解除阻塞项：需求上的要求产品编辑及以上；工作项上的要求能写进展。事件挂在所属对象上。 */
export async function resolveBlocker(db: Db, actor: Actor, blockerId: string): Promise<BlockerView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(blockers).where(eq(blockers.id, blockerId)).for('update');
    if (!cur) throw new AppError('not_found', '阻塞项不存在');
    let subject: { type: 'requirement' | 'work_item'; id: string; productId: string | null };
    if (cur.workItemId) {
      const item = await loadWorkItemTx(tx, cur.workItemId);
      await requireWorkItemAccess(tx, actor, item, 'progress');
      subject = { type: 'work_item', id: item.id, productId: item.productId };
    } else {
      const req = await loadRequirement(tx, cur.requirementId!);
      await requireProductRole(tx, actor, req.productId, 'editor');
      subject = { type: 'requirement', id: req.id, productId: req.productId };
    }
    if (cur.status === 'resolved') throw new AppError('invalid', '该阻塞项已解除');
    const now = new Date();
    const [row] = await tx.update(blockers).set({ status: 'resolved', resolvedAt: now }).where(eq(blockers.id, blockerId)).returning();
    if (subject.type === 'work_item') await tx.update(workItems).set({ updatedAt: now }).where(eq(workItems.id, subject.id));
    else await tx.update(requirements).set({ updatedAt: now }).where(eq(requirements.id, subject.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: subject.productId,
      type: 'blocker.resolved',
      subjectType: subject.type,
      subjectId: subject.id,
      actor,
      payload: { blockerId, changes: [{ field: 'status', old: 'active', new: 'resolved' }] },
    });
    return toView(tx, row!);
  });
}
```

`packages/core/src/index.ts` 在 `export * from './tracking/requirement-tracking';` 之后加：

```ts
export * from './tracking/work-items';
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-work-items.test.ts test/blockers-relations.test.ts test/link-syntax.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/links/syntax.ts packages/core/src/tracking/work-items.ts packages/core/src/requirements/blockers.ts packages/core/src/index.ts packages/core/test/tracking-work-items.test.ts
git commit -m "feat(core): 工作项（W-n 编号、增删改查、状态与暂停）与工作项上的阻塞项

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 进展记录

**Files:**
- Create: `packages/core/src/tracking/progress.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/tracking-progress.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `progressUpdates`；Task 4 的 `loadWorkItemTx`、`requireWorkItemAccess`、`workItemAccessTx`、`setExpectedDateTx`；Task 5 的 `createWorkItem`、`deleteWorkItem`、`getWorkItemByKey`（测试用）；已有的 `productRoleOf`、`atLeast`、`assertAssignableMember`、`loadRequirementForUpdate`、`memberNames`、`assertIsoDate`
- Produces（`packages/core/src/tracking/progress.ts`）:
  - `type ProgressSubject = { type: 'requirement' | 'work_item'; id: string }`
  - `type ProgressView = { id: string; body: string; nextStep: string | null; follower: MemberRef | null; author: MemberRef | null; createdAt: Date; editedAt: Date | null; canEdit: boolean; canDelete: boolean }`
  - `type ProgressInput = { body: string; nextStep?: string | null; followerMemberId?: string | null; expectedDate?: string | null }`（`expectedDate` 省略表示不改）；`type ProgressPatch = { body?: string; nextStep?: string | null; followerMemberId?: string | null }`
  - `listProgress(db, actor, subject: ProgressSubject): Promise<ProgressView[]>`（时间倒序）
  - `createProgress(db, actor, subject, input: ProgressInput): Promise<ProgressView>`
  - `updateProgress(db, actor, progressId, patch: ProgressPatch): Promise<ProgressView>`
  - `deleteProgress(db, actor, progressId): Promise<void>`
  - 事件：`progress.created`（payload `{ progressId, followerMemberId, nextStep }`）、`progress.updated`（`{ progressId, changes }`）、`progress.deleted`（`{ progressId }`），`subjectType` 为所属对象

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/tracking-progress.test.ts`：

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { createAgentMember, updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createProgress, deleteProgress, listProgress, type ProgressSubject, updateProgress } from '../src/tracking/progress';
import { createWorkItem, deleteWorkItem, getWorkItemByKey } from '../src/tracking/work-items';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let ed: Actor;
let peer: Actor;
let padmin: Actor;
let viewer: Actor;
let leaver: Actor;
let agentId: string;
let pan: string;

const req = (id: string): ProgressSubject => ({ type: 'requirement', id });
const wi = (id: string): ProgressSubject => ({ type: 'work_item', id });
const newReq = async (title: string) => createRequirement(t.db, owner, pan, { title });
const eventTypes = async (id: string, types: string[]) =>
  (await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, id), inArray(domainEvents.type, types)))).map((e) => e.type).sort();

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  ed = await asMember(t.db, owner, '编辑甲');
  peer = await asMember(t.db, owner, '同事乙');
  padmin = await asMember(t.db, owner, '产品管理员');
  await setProductRole(t.db, owner, pan, padmin.memberId, 'admin');
  viewer = await asMember(t.db, owner, '只读成员');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  leaver = await asMember(t.db, owner, '将离开的人');
  agentId = (await createAgentMember(t.db, owner, { displayName: '机器人' })).id;
});
afterAll(() => t.cleanup());

describe('需求的进展记录', () => {
  it('写进展：进展必填，下一步与跟进人可选，时间倒序；可以顺手改预计上线日期', async () => {
    const r = await newReq('进展需求');
    await expect(createProgress(t.db, ed, req(r.id), { body: ' ' })).rejects.toMatchObject({ code: 'invalid', message: '进展不能为空，且不超过 2000 个字符' });
    await expect(createProgress(t.db, ed, req(r.id), { body: '有进展', nextStep: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'invalid', message: '下一步不超过 500 个字符' });
    const p1 = await createProgress(t.db, ed, req(r.id), { body: ' 完成接口评审 ', nextStep: ' ', followerMemberId: null });
    expect(p1).toMatchObject({ body: '完成接口评审', nextStep: null, follower: null, author: { id: ed.memberId, displayName: '编辑甲' }, canEdit: true, canDelete: true, editedAt: null });
    const p2 = await createProgress(t.db, ed, req(r.id), { body: '联调中', nextStep: '约测试', followerMemberId: peer.memberId, expectedDate: '2026-11-01' });
    expect(p2.follower).toEqual({ id: peer.memberId, displayName: '同事乙' });
    expect((await listProgress(t.db, peer, req(r.id))).map((p) => [p.body, p.canEdit, p.canDelete])).toEqual([
      ['联调中', false, false],
      ['完成接口评审', false, false],
    ]);
    expect((await getRequirementByKey(t.db, owner, r.displayKey)).tracking.expectedDate).toBe('2026-11-01');
    expect(await eventTypes(r.id, ['progress.created', 'requirement.expected_date_changed'])).toEqual(
      ['progress.created', 'progress.created', 'requirement.expected_date_changed'].sort(),
    );
  });

  it('跟进人校验：已离开的成员与 Agent 不能选；已保存的进展在跟进人离开后仍显示原名', async () => {
    const r = await newReq('跟进人');
    const p = await createProgress(t.db, ed, req(r.id), { body: '交接', followerMemberId: leaver.memberId });
    await updateMember(t.db, owner, leaver.memberId, { status: 'left' });
    expect((await listProgress(t.db, ed, req(r.id)))[0]!.follower).toEqual({ id: leaver.memberId, displayName: '将离开的人' });
    await expect(createProgress(t.db, ed, req(r.id), { body: '再交接', followerMemberId: leaver.memberId })).rejects.toMatchObject({ code: 'invalid', message: '该成员已离开组织，不能选择' });
    await expect(createProgress(t.db, ed, req(r.id), { body: '给机器人', followerMemberId: agentId })).rejects.toMatchObject({ code: 'invalid', message: '不能选择 Agent 成员' });
    expect((await updateProgress(t.db, ed, p.id, { body: '交接（补充）' })).follower).toEqual({ id: leaver.memberId, displayName: '将离开的人' });
    await expect(updateProgress(t.db, ed, p.id, { followerMemberId: agentId })).rejects.toMatchObject({ code: 'invalid', message: '不能选择 Agent 成员' });
  });

  it('修改与删除：作者本人可以；产品管理员可以删除别人的；只读成员、只读 Token 不能写', async () => {
    const r = await newReq('修改删除');
    const p = await createProgress(t.db, ed, req(r.id), { body: '原文' });
    await expect(updateProgress(t.db, peer, p.id, { body: '改别人的' })).rejects.toMatchObject({ code: 'forbidden', message: '只能修改自己写的进展' });
    const edited = await updateProgress(t.db, ed, p.id, { body: '改过', nextStep: '下周复盘' });
    expect(edited).toMatchObject({ body: '改过', nextStep: '下周复盘' });
    expect(edited.editedAt).not.toBeNull();
    const [updated] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, r.id), eq(domainEvents.type, 'progress.updated')));
    expect(updated!.payload).toMatchObject({
      progressId: p.id,
      changes: [
        { field: 'body', old: '原文', new: '改过' },
        { field: 'nextStep', old: null, new: '下周复盘' },
      ],
    });
    await expect(deleteProgress(t.db, peer, p.id)).rejects.toMatchObject({ code: 'forbidden', message: '没有删除这条进展的权限' });
    await deleteProgress(t.db, padmin, p.id);
    expect(await listProgress(t.db, ed, req(r.id))).toEqual([]);
    await expect(updateProgress(t.db, ed, p.id, { body: '已删' })).rejects.toMatchObject({ code: 'not_found', message: '进展记录不存在' });
    for (const a of [viewer, readOnlyToken(owner)]) await expect(createProgress(t.db, a, req(r.id), { body: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await eventTypes(r.id, ['progress.deleted'])).toEqual(['progress.deleted']);
  });
});

describe('工作项的进展记录', () => {
  it('不关联产品时能查看的非只读成员都能写；顺手改预计完成日期需要修改权限；组织管理员可以删除别人的', async () => {
    const w = await createWorkItem(t.db, ed, { title: '工作项进展' });
    const p = await createProgress(t.db, peer, wi(w.id), { body: '对方已回复' });
    await expect(createProgress(t.db, peer, wi(w.id), { body: '顺手改日期', expectedDate: '2026-11-11' })).rejects.toMatchObject({ code: 'forbidden' });
    await createProgress(t.db, ed, wi(w.id), { body: '负责人改日期', expectedDate: '2026-11-11' });
    expect((await getWorkItemByKey(t.db, ed, w.displayKey)).expectedDate).toBe('2026-11-11');
    expect((await listProgress(t.db, owner, wi(w.id))).find((x) => x.id === p.id)).toMatchObject({ canEdit: false, canDelete: true });
    await deleteProgress(t.db, owner, p.id);
    expect((await listProgress(t.db, ed, wi(w.id))).map((x) => x.body)).toEqual(['负责人改日期']);
  });

  it('已删除对象：已删除的工作项不能再写进展，也读不到进展', async () => {
    const w = await createWorkItem(t.db, ed, { title: '要删除的工作项' });
    await deleteWorkItem(t.db, ed, w.id);
    await expect(createProgress(t.db, ed, wi(w.id), { body: '删了还写' })).rejects.toMatchObject({ code: 'not_found', message: '工作项不存在' });
    await expect(listProgress(t.db, ed, wi(w.id))).rejects.toMatchObject({ code: 'not_found' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-progress.test.ts`
Expected: FAIL（找不到 `../src/tracking/progress`）。

- [ ] **Step 3: 实现进展记录**

新建 `packages/core/src/tracking/progress.ts`：

```ts
/**
 * 进展记录（P3-C1）：挂在需求或工作项上，按条保存进展、下一步与跟进人；列表显示最新一条。
 * 写：需求为产品编辑及以上，工作项见 access.ts 的 progress。作者本人（且仍能写）可以修改、删除；
 * 产品管理员（不关联产品时为组织管理员）可以删除别人的。删除为软删除。
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { atLeast, productRoleOf } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { progressUpdates, requirements, workItems } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertAssignableMember, loadRequirementForUpdate, memberNames } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import { loadWorkItemTx, requireWorkItemAccess, workItemAccessTx } from './access';
import { setExpectedDateTx } from './requirement-tracking';

export type ProgressSubject = { type: 'requirement' | 'work_item'; id: string };
export type ProgressView = {
  id: string;
  body: string;
  nextStep: string | null;
  follower: MemberRef | null;
  author: MemberRef | null;
  createdAt: Date;
  editedAt: Date | null;
  /** 当前用户能否修改、删除这一条。 */
  canEdit: boolean;
  canDelete: boolean;
};
export type ProgressInput = { body: string; nextStep?: string | null; followerMemberId?: string | null; expectedDate?: string | null };
export type ProgressPatch = { body?: string; nextStep?: string | null; followerMemberId?: string | null };

type ProgressRow = typeof progressUpdates.$inferSelect;
type Rights = { productId: string | null; write: boolean; manage: boolean };

function assertBody(v: string): string {
  const b = v.trim();
  if (!b || b.length > 2000) throw new AppError('invalid', '进展不能为空，且不超过 2000 个字符');
  return b;
}

function assertNextStep(v: string | null | undefined): string | null {
  const s = v?.trim() ?? '';
  if (s.length > 500) throw new AppError('invalid', '下一步不超过 500 个字符');
  return s || null;
}

/** 所属对象的产品与当前用户的写、管理权限；对象不存在、已删除或看不到时报「不存在」。 */
async function rightsTx(tx: Tx, actor: Actor, s: ProgressSubject): Promise<Rights> {
  if (s.type === 'requirement') {
    const [r] = await tx.select({ productId: requirements.productId }).from(requirements).where(and(eq(requirements.id, s.id), isNull(requirements.deletedAt)));
    const role = r ? await productRoleOf(tx, actor, r.productId) : null;
    if (!r || !role) throw new AppError('not_found', '需求不存在');
    return { productId: r.productId, write: atLeast(role, 'editor'), manage: role === 'admin' };
  }
  const item = await loadWorkItemTx(tx, s.id);
  const access = await workItemAccessTx(tx, actor, item);
  if (!access.view) throw new AppError('not_found', '工作项不存在');
  return { productId: item.productId, write: access.progress, manage: access.manage };
}

const subjectOf = (row: ProgressRow): ProgressSubject =>
  row.requirementId ? { type: 'requirement', id: row.requirementId } : { type: 'work_item', id: row.workItemId! };

async function viewsTx(tx: Tx, actor: Actor, rows: ProgressRow[], rights: Rights): Promise<ProgressView[]> {
  const names = await memberNames(tx, rows.flatMap((r) => [r.followerMemberId, r.authorMemberId]));
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  return rows.map((r) => {
    const mine = rights.write && r.authorMemberId === actor.memberId;
    return {
      id: r.id,
      body: r.body,
      nextStep: r.nextStep,
      follower: ref(r.followerMemberId),
      author: ref(r.authorMemberId),
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      canEdit: mine,
      canDelete: mine || rights.manage,
    };
  });
}

/** 写进展时顺手改预计日期：需求为预计上线日期（产品编辑即可），工作项为预计完成日期（需要修改权限）。 */
async function changeExpectedTx(tx: Tx, actor: Actor, s: ProgressSubject, next: string | null): Promise<void> {
  if (s.type === 'requirement') {
    await setExpectedDateTx(tx, actor, await loadRequirementForUpdate(tx, s.id), next);
    return;
  }
  const item = await loadWorkItemTx(tx, s.id, true);
  await requireWorkItemAccess(tx, actor, item, 'edit');
  if (item.expectedDate === next) return;
  await tx.update(workItems).set({ expectedDate: next, updatedAt: new Date() }).where(eq(workItems.id, item.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: item.productId,
    type: 'work_item.updated',
    subjectType: 'work_item',
    subjectId: item.id,
    actor,
    payload: { changes: [{ field: 'expectedDate', old: item.expectedDate, new: next }] },
  });
}

async function loadProgressTx(tx: Tx, id: string): Promise<ProgressRow> {
  const [row] = await tx.select().from(progressUpdates).where(and(eq(progressUpdates.id, id), isNull(progressUpdates.deletedAt))).for('update');
  if (!row) throw new AppError('not_found', '进展记录不存在');
  return row;
}

export async function listProgress(db: Db, actor: Actor, subject: ProgressSubject): Promise<ProgressView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const rights = await rightsTx(tx, actor, subject);
    const column = subject.type === 'requirement' ? progressUpdates.requirementId : progressUpdates.workItemId;
    const rows = await tx
      .select()
      .from(progressUpdates)
      .where(and(eq(column, subject.id), isNull(progressUpdates.deletedAt)))
      .orderBy(desc(progressUpdates.createdAt), desc(progressUpdates.id));
    return viewsTx(tx, actor, rows, rights);
  });
}

export async function createProgress(db: Db, actor: Actor, subject: ProgressSubject, input: ProgressInput): Promise<ProgressView> {
  const body = assertBody(input.body);
  const nextStep = assertNextStep(input.nextStep);
  const label = subject.type === 'requirement' ? '预计上线日期' : '预计完成日期';
  const expected = input.expectedDate === undefined ? undefined : input.expectedDate === null ? null : assertIsoDate(input.expectedDate, label);
  return withOrg(db, actor.orgId, async (tx) => {
    const rights = await rightsTx(tx, actor, subject);
    if (!rights.write) throw new AppError('forbidden', '权限不足');
    if (input.followerMemberId) await assertAssignableMember(tx, input.followerMemberId);
    const [row] = await tx
      .insert(progressUpdates)
      .values({
        orgId: actor.orgId,
        requirementId: subject.type === 'requirement' ? subject.id : null,
        workItemId: subject.type === 'work_item' ? subject.id : null,
        body,
        nextStep,
        followerMemberId: input.followerMemberId ?? null,
        authorMemberId: actor.memberId,
      })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rights.productId,
      type: 'progress.created',
      subjectType: subject.type,
      subjectId: subject.id,
      actor,
      payload: { progressId: row!.id, followerMemberId: row!.followerMemberId, nextStep },
    });
    if (expected !== undefined) await changeExpectedTx(tx, actor, subject, expected);
    return (await viewsTx(tx, actor, [row!], rights))[0]!;
  });
}

export async function updateProgress(db: Db, actor: Actor, progressId: string, input: ProgressPatch): Promise<ProgressView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadProgressTx(tx, progressId);
    const subject = subjectOf(cur);
    const rights = await rightsTx(tx, actor, subject);
    if (!rights.write || cur.authorMemberId !== actor.memberId) throw new AppError('forbidden', '只能修改自己写的进展');
    const next = {
      body: input.body === undefined ? cur.body : assertBody(input.body),
      nextStep: input.nextStep === undefined ? cur.nextStep : assertNextStep(input.nextStep),
      followerMemberId: input.followerMemberId === undefined ? cur.followerMemberId : input.followerMemberId,
    };
    if (next.followerMemberId && next.followerMemberId !== cur.followerMemberId) await assertAssignableMember(tx, next.followerMemberId);
    const changes = (Object.keys(next) as Array<keyof typeof next>).map((field) => ({ field, old: cur[field], new: next[field] })).filter((c) => c.old !== c.new);
    if (changes.length === 0) return (await viewsTx(tx, actor, [cur], rights))[0]!;
    const [row] = await tx.update(progressUpdates).set({ ...next, editedAt: new Date() }).where(eq(progressUpdates.id, progressId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rights.productId,
      type: 'progress.updated',
      subjectType: subject.type,
      subjectId: subject.id,
      actor,
      payload: { progressId, changes },
    });
    return (await viewsTx(tx, actor, [row!], rights))[0]!;
  });
}

export async function deleteProgress(db: Db, actor: Actor, progressId: string): Promise<void> {
  await withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadProgressTx(tx, progressId);
    const subject = subjectOf(cur);
    const rights = await rightsTx(tx, actor, subject);
    if (!rights.manage && !(rights.write && cur.authorMemberId === actor.memberId)) throw new AppError('forbidden', '没有删除这条进展的权限');
    await tx.update(progressUpdates).set({ deletedAt: new Date() }).where(eq(progressUpdates.id, progressId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rights.productId,
      type: 'progress.deleted',
      subjectType: subject.type,
      subjectId: subject.id,
      actor,
      payload: { progressId },
    });
  });
}
```

`packages/core/src/index.ts` 在 `export * from './tracking/work-items';` 之后加：

```ts
export * from './tracking/progress';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-progress.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tracking/progress.ts packages/core/src/index.ts packages/core/test/tracking-progress.test.ts
git commit -m "feat(core): 进展记录（进展、下一步、跟进人），作者修改与删除，管理员删除

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 跟进列表与组织阈值

**Files:**
- Create: `packages/core/src/tracking/tracking.ts`、`packages/core/src/tracking/settings.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/tracking-list.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `activeDays`、`agingLevel`、`isStale`、`pauseIntervals`、`trackingSettingsOf`、`CLOSED_CATEGORIES`、`TrackingSettings`、`AgingLevel`、`PauseEvent`；Task 4 的 `canViewUnlinked`、`canWriteUnlinked`、`canEditUnlinked`；Task 5 的 `WORK_ITEM_STATUS_LABELS`、`WorkItemStatus`、`workItemDisplayKey`；已有的 `visibleProductIds`、`productRoleOf`、`atLeast`、`requireOrgAdmin`、`orgTimeZone`（`dashboard/flow.ts`）、`zonedDate`、`addDays`（`dashboard/metrics.ts`）、`productWorkflowBody`、`memberNames`、`displayKey`
- Produces（`packages/core/src/tracking/tracking.ts`）:
  - `RECENT_DONE_DAYS = 30`
  - `type TrackingFilter = { productId?: string; ownerId?: string; typeOptionId?: string; paused?: boolean; blocked?: boolean; includeDone?: boolean }`
  - `type TrackingStage = { key: string; label: string; color: string; category: string }`
  - `type TrackingItem`（字段见下方代码：`kind`、`id`、`displayKey`、`title`、`product`、`owner`、`type`、`priority`、`stage`、`paused`、`stageDays`、`wipDays`、`aging`、`stale`、`startedOn`、`stageEnteredOn`、`blockers: { count; first }`、`latest`、`expectedDate`、`doneOn`、`done`、`canWrite`、`canEditDate`）
  - `type TrackingProduct = { id; key; name; states: Array<TrackingStage & { order: number }> }`
  - `type TrackingList = { today: string; timeZone: string; settings: TrackingSettings; products: TrackingProduct[]; owners: MemberRef[]; typeOptions: OptionRef[]; items: TrackingItem[] }`
  - `getTracking(db, actor, filter?: TrackingFilter, opts?: { now?: Date }): Promise<TrackingList>`
- Produces（`packages/core/src/tracking/settings.ts`）：`getTrackingSettings(db, actor): Promise<TrackingSettings>`；`updateTrackingSettings(db, actor, input: TrackingSettings): Promise<TrackingSettings>`（事件 `organization.tracking_settings_changed`）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/tracking-list.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, requirements, stateTransitions, workItems } from '../src/db/schema';
import { listFields } from '../src/definitions/fields';
import type { Actor } from '../src/domain-types';
import { createBlocker, resolveBlocker } from '../src/requirements/blockers';
import { createRequirement, setRequirementField } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createProgress } from '../src/tracking/progress';
import { joinTracking, pauseRequirement, resumeRequirement } from '../src/tracking/requirement-tracking';
import { getTrackingSettings, updateTrackingSettings } from '../src/tracking/settings';
import { getTracking, type TrackingList } from '../src/tracking/tracking';
import { createWorkItem, setWorkItemStatus, updateWorkItem } from '../src/tracking/work-items';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, seedInstance } from './factories';

/** 北京时间 2026-10-13 12:00。 */
const NOW = new Date('2026-10-13T04:00:00Z');
const at = (iso: string) => new Date(iso);
const RANDOM = '00000000-0000-4000-8000-000000000001';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let ed: Actor;
let peer: Actor;
let guest: Actor;
let panToken: Actor;
let pan: string;
let doc: string;
let feature: string;
let p1: string;
let support: string;

const create = (title: string, extra: { productId?: string; ownerMemberId?: string } = {}) =>
  createRequirement(t.db, owner, extra.productId ?? pan, { title, ownerMemberId: extra.ownerMemberId });
const move = (id: string, to: string) => transitionRequirement(t.db, owner, id, { to });
const rewrite = (id: string, patch: Partial<typeof requirements.$inferInsert>) => t.adminDb.update(requirements).set(patch).where(eq(requirements.id, id));
/** 把某个对象某类事件的时间改到过去（暂停、恢复）。 */
const shiftEvent = (id: string, type: string, iso: string) =>
  t.adminDb.update(domainEvents).set({ occurredAt: at(iso) }).where(and(eq(domainEvents.subjectId, id), eq(domainEvents.type, type)));
const pick = (list: TrackingList, prefix: string) => list.items.filter((i) => i.title.startsWith(prefix));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  await applyTrackingWorkflow(t.db, owner, doc);
  ed = await asMember(t.db, owner, '编辑甲');
  peer = await asMember(t.db, owner, '同事乙');
  guest = await asMember(t.db, owner, '访客丙', 'guest');
  await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
  panToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f3', tokenScope: { products: [pan], access: 'read' } };
  const fields = await listFields(t.db, owner);
  const option = (field: string, key: string) => fields.find((f) => f.key === field)!.options.find((o) => o.key === key)!.id;
  feature = option('type', 'feature');
  p1 = option('priority', 'p1');
  support = option('work_type', 'support');
});
afterAll(() => t.cleanup());

describe('跟进列表', () => {
  it('全部在手：跟进中的需求（含手动加入的收集阶段）与进行中的工作项；未加入、已上线、已删除、已完成的不在', async () => {
    const a = await create('[在手] 开发中的需求', { ownerMemberId: ed.memberId });
    await move(a.id, 'dev');
    const manual = await create('[在手] 手动加入的收集需求');
    await joinTracking(t.db, owner, manual.id);
    await create('[在手] 没加入的需求');
    const shipped = await create('[在手] 已上线的需求');
    await move(shipped.id, 'dev');
    await move(shipped.id, 'done');
    const removed = await create('[在手] 删除的需求');
    await move(removed.id, 'dev');
    await rewrite(removed.id, { deletedAt: new Date() });
    const w = await createWorkItem(t.db, ed, { title: '[在手] 协助排查', ownerMemberId: ed.memberId, startedOn: '2026-10-08' });
    const finished = await createWorkItem(t.db, ed, { title: '[在手] 已完成的工作' });
    await setWorkItemStatus(t.db, ed, finished.id, 'done');
    const list = await getTracking(t.db, owner, {}, { now: NOW });
    expect(list).toMatchObject({ today: '2026-10-13', timeZone: 'Asia/Shanghai', settings: { warnDays: 14, alertDays: 30, staleUpdateDays: 7 } });
    expect(pick(list, '[在手]').map((i) => i.title).sort()).toEqual(['[在手] 开发中的需求', '[在手] 手动加入的收集需求', '[在手] 协助排查'].sort());
    expect(pick(list, '[在手] 开发中')[0]).toMatchObject({
      kind: 'requirement',
      displayKey: a.displayKey,
      product: { id: pan, key: 'PAN', name: '网盘' },
      owner: { id: ed.memberId, displayName: '编辑甲' },
      stage: { key: 'dev', label: '开发中', category: 'started' },
      paused: null,
      blockers: { count: 0, first: null },
      latest: null,
      done: false,
      doneOn: null,
      canWrite: true,
      canEditDate: true,
    });
    expect(pick(list, '[在手] 协助')[0]).toMatchObject({
      kind: 'work_item',
      displayKey: w.displayKey,
      product: null,
      priority: null,
      stage: { key: 'active', label: '进行中', category: 'started' },
      startedOn: '2026-10-08',
      stageEnteredOn: '2026-10-08',
      stageDays: 5,
      wipDays: 5,
    });
  });

  it('退回收集与重新打开仍在手，停留从新的状态重新计算', async () => {
    const back = await create('[重开] 退回收集');
    await move(back.id, 'dev');
    await move(back.id, 'backlog');
    const again = await create('[重开] 重新打开');
    await move(again.id, 'dev');
    await move(again.id, 'done');
    await move(again.id, 'dev');
    const list = await getTracking(t.db, owner);
    expect(pick(list, '[重开]').map((i) => [i.title, i.stage.label, i.stageDays, i.done])).toEqual([
      ['[重开] 退回收集', '收集', 0, false],
      ['[重开] 重新打开', '开发中', 0, false],
    ]);
  });

  it('停留与在制扣除暂停（按组织时区的自然日）；老化分档；暂停中不标色、不计无进展', async () => {
    const r20 = await create('[老化] 停留 20 天');
    await move(r20.id, 'dev');
    await rewrite(r20.id, { stateChangedAt: at('2026-09-23T02:00:00Z'), trackedSince: at('2026-09-01T02:00:00Z') });
    const r40 = await create('[老化] 停留 40 天，暂停 5 天');
    await move(r40.id, 'dev');
    await pauseRequirement(t.db, owner, r40.id, { reason: '等资源' });
    await resumeRequirement(t.db, owner, r40.id);
    await shiftEvent(r40.id, 'requirement.paused', '2026-09-10T02:00:00Z');
    await shiftEvent(r40.id, 'requirement.resumed', '2026-09-15T02:00:00Z');
    await rewrite(r40.id, { stateChangedAt: at('2026-09-03T02:00:00Z'), trackedSince: at('2026-09-03T02:00:00Z') });
    const paused = await create('[老化] 暂停中');
    await move(paused.id, 'dev');
    await pauseRequirement(t.db, owner, paused.id, { reason: '等法务' });
    await shiftEvent(paused.id, 'requirement.paused', '2026-09-13T02:00:00Z');
    await rewrite(paused.id, { stateChangedAt: at('2026-08-14T02:00:00Z'), trackedSince: at('2026-08-14T02:00:00Z') });
    const fresh = await create('[老化] 有新进展');
    await move(fresh.id, 'dev');
    await rewrite(fresh.id, { stateChangedAt: at('2026-10-10T02:00:00Z'), trackedSince: at('2026-09-01T02:00:00Z') });
    await createProgress(t.db, owner, { type: 'requirement', id: fresh.id }, { body: '刚同步过' });
    await createWorkItem(t.db, ed, { title: '[老化] 工作项', startedOn: '2026-09-28' });
    const list = await getTracking(t.db, owner, {}, { now: NOW });
    expect(pick(list, '[老化]').map((i) => [i.title, i.stageDays, i.wipDays, i.aging, i.stale])).toEqual([
      ['[老化] 停留 40 天，暂停 5 天', 35, 35, 'alert', true],
      ['[老化] 暂停中', 30, 30, 'normal', false],
      ['[老化] 停留 20 天', 20, 42, 'warn', true],
      ['[老化] 工作项', 15, 15, 'warn', false],
      ['[老化] 有新进展', 3, 42, 'normal', false],
    ]);
    expect(pick(list, '[老化] 暂停中')[0]!.paused).toMatchObject({ reason: '等法务' });
  });

  it('阈值：组织管理员修改，校验范围与大小关系，记事件；修改后老化分档随之变化（沿用上一个用例的条目）', async () => {
    const valid = { warnDays: 25, alertDays: 50, staleUpdateDays: 3 };
    await expect(updateTrackingSettings(t.db, ed, valid)).rejects.toMatchObject({ code: 'forbidden' });
    for (const bad of [{ ...valid, warnDays: 0 }, { ...valid, staleUpdateDays: 1.5 }, { ...valid, alertDays: 366 }]) {
      await expect(updateTrackingSettings(t.db, owner, bad)).rejects.toMatchObject({ code: 'invalid', message: '天数应为 1–365 的整数' });
    }
    await expect(updateTrackingSettings(t.db, owner, { ...valid, warnDays: 50 })).rejects.toMatchObject({ code: 'invalid', message: '标黄天数应小于标红天数' });
    expect(await updateTrackingSettings(t.db, owner, valid)).toEqual(valid);
    expect(await getTrackingSettings(t.db, ed)).toEqual(valid);
    const [ev] = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'organization.tracking_settings_changed'));
    expect(ev!.payload).toMatchObject({
      changes: [
        { field: 'warnDays', old: 14, new: 25 },
        { field: 'alertDays', old: 30, new: 50 },
        { field: 'staleUpdateDays', old: 7, new: 3 },
      ],
    });
    const list = await getTracking(t.db, owner, {}, { now: NOW });
    expect(pick(list, '[老化]').map((i) => [i.title, i.aging])).toEqual([
      ['[老化] 停留 40 天，暂停 5 天', 'warn'],
      ['[老化] 暂停中', 'normal'],
      ['[老化] 停留 20 天', 'normal'],
      ['[老化] 工作项', 'normal'],
      ['[老化] 有新进展', 'normal'],
    ]);
    await updateTrackingSettings(t.db, owner, { warnDays: 14, alertDays: 30, staleUpdateDays: 7 });
  });

  it('最新进展、进行中的阻塞项（条数与第一条）、类型与优先级', async () => {
    const r = await create('[明细] 带进展');
    await move(r.id, 'dev');
    await createProgress(t.db, owner, { type: 'requirement', id: r.id }, { body: '第一次进展' });
    await createProgress(t.db, owner, { type: 'requirement', id: r.id }, { body: '第二次进展', nextStep: '约评审', followerMemberId: ed.memberId });
    await createBlocker(t.db, owner, r.id, { description: '等接口' });
    await createBlocker(t.db, owner, r.id, { description: '等设计稿' });
    const solved = await createBlocker(t.db, owner, r.id, { description: '已解决的' });
    await resolveBlocker(t.db, owner, solved.id);
    await setRequirementField(t.db, owner, r.id, 'type', [feature]);
    await setRequirementField(t.db, owner, r.id, 'priority', [p1]);
    const [item] = pick(await getTracking(t.db, owner), '[明细]');
    expect(item!.latest).toMatchObject({ body: '第二次进展', nextStep: '约评审', follower: { id: ed.memberId, displayName: '编辑甲' } });
    expect(item!.blockers).toEqual({ count: 2, first: '等接口' });
    expect(item!.type).toMatchObject({ id: feature, label: '新功能' });
    expect(item!.priority).toMatchObject({ id: p1, label: 'P1' });
  });

  it('含最近完成：最近 30 天上线的需求与完成的工作项；更早完成的不含；完成的条目不标老化', async () => {
    const recent = await create('[完成] 上线 10 天');
    await move(recent.id, 'dev');
    await move(recent.id, 'done');
    await t.adminDb.update(stateTransitions).set({ at: at('2026-10-03T02:00:00Z') }).where(and(eq(stateTransitions.requirementId, recent.id), eq(stateTransitions.toState, 'done')));
    const old = await create('[完成] 上线 40 天');
    await move(old.id, 'dev');
    await move(old.id, 'done');
    await t.adminDb.update(stateTransitions).set({ at: at('2026-09-03T02:00:00Z') }).where(and(eq(stateTransitions.requirementId, old.id), eq(stateTransitions.toState, 'done')));
    const w = await createWorkItem(t.db, ed, { title: '[完成] 工作项' });
    await setWorkItemStatus(t.db, ed, w.id, 'done');
    await t.adminDb.update(workItems).set({ doneAt: at('2026-10-05T02:00:00Z') }).where(eq(workItems.id, w.id));
    const early = await createWorkItem(t.db, ed, { title: '[完成] 早完成的工作项' });
    await setWorkItemStatus(t.db, ed, early.id, 'done');
    await t.adminDb.update(workItems).set({ doneAt: at('2026-09-01T02:00:00Z') }).where(eq(workItems.id, early.id));
    expect(pick(await getTracking(t.db, owner, {}, { now: NOW }), '[完成]')).toEqual([]);
    const withDone = await getTracking(t.db, owner, { includeDone: true }, { now: NOW });
    expect(pick(withDone, '[完成]').map((i) => [i.title, i.done, i.doneOn, i.aging, i.stale])).toEqual([
      ['[完成] 上线 10 天', true, '2026-10-03', 'normal', false],
      ['[完成] 工作项', true, '2026-10-05', 'normal', false],
    ]);
  });

  it('按可见产品过滤：访客只看到有角色的产品，看不到不关联产品的工作项；工作项移到看不到的产品后不再出现；限定产品的 Token 看不到不关联产品的工作项', async () => {
    const pr = await create('[可见] 网盘需求');
    await move(pr.id, 'dev');
    const dr = await create('[可见] 文档需求', { productId: doc });
    await move(dr.id, 'dev');
    await createWorkItem(t.db, ed, { title: '[可见] 不关联产品' });
    const linked = await createWorkItem(t.db, ed, { title: '[可见] 网盘工作项', productId: pan });
    expect(pick(await getTracking(t.db, owner), '[可见]')).toHaveLength(4);
    const g = await getTracking(t.db, guest);
    expect(pick(g, '[可见]').map((i) => i.title).sort()).toEqual(['[可见] 网盘需求', '[可见] 网盘工作项'].sort());
    expect(g.products.map((p) => p.key)).toEqual(['PAN']);
    expect(pick(g, '[可见] 网盘需求')[0]).toMatchObject({ canWrite: false, canEditDate: false });
    for (const hidden of ['[可见] 文档需求', '[可见] 不关联产品', doc]) expect(JSON.stringify(g)).not.toContain(hidden);
    await updateWorkItem(t.db, ed, linked.id, { productId: doc });
    expect(pick(await getTracking(t.db, guest), '[可见]').map((i) => i.title)).toEqual(['[可见] 网盘需求']);
    expect(pick(await getTracking(t.db, panToken), '[可见]').map((i) => i.title)).toEqual(['[可见] 网盘需求']);
  });

  it('看不到或不存在的筛选值返回空结果，不报错；按负责人、类型、暂停、阻塞、产品筛选；候选负责人不受负责人筛选影响', async () => {
    const mine = await create('[筛选] 编辑的需求', { ownerMemberId: ed.memberId });
    await move(mine.id, 'dev');
    const theirs = await create('[筛选] 同事的需求', { ownerMemberId: peer.memberId });
    await move(theirs.id, 'dev');
    await pauseRequirement(t.db, owner, theirs.id, { reason: '等资源' });
    await createBlocker(t.db, owner, mine.id, { description: '等接口' });
    await createWorkItem(t.db, ed, { title: '[筛选] 工作项', workTypeOptionId: support });
    for (const f of [{ productId: RANDOM }, { ownerId: RANDOM }, { typeOptionId: RANDOM }]) {
      const list = await getTracking(t.db, owner, f);
      expect(list.items, JSON.stringify(f)).toEqual([]);
      expect(list.products.map((p) => p.key)).toEqual(['DOC', 'PAN']);
    }
    expect((await getTracking(t.db, guest, { productId: doc })).items).toEqual([]);
    const byOwner = await getTracking(t.db, owner, { ownerId: peer.memberId });
    expect(pick(byOwner, '[筛选]').map((i) => i.title)).toEqual(['[筛选] 同事的需求']);
    expect(byOwner.owners.map((o) => o.id)).toEqual(expect.arrayContaining([ed.memberId, peer.memberId]));
    expect(pick(await getTracking(t.db, owner, { typeOptionId: support }), '[筛选]').map((i) => i.title)).toEqual(['[筛选] 工作项']);
    expect(pick(await getTracking(t.db, owner, { paused: true }), '[筛选]').map((i) => i.title)).toEqual(['[筛选] 同事的需求']);
    expect(pick(await getTracking(t.db, owner, { blocked: true }), '[筛选]').map((i) => i.title)).toEqual(['[筛选] 编辑的需求']);
    expect(pick(await getTracking(t.db, owner, { productId: pan }), '[筛选]').map((i) => i.title).sort()).toEqual(['[筛选] 同事的需求', '[筛选] 编辑的需求'].sort());
    expect((await getTracking(t.db, owner)).typeOptions.map((o) => o.label)).toEqual(['新功能', '体验优化', '线上问题', '技术支持', '协调对接']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-list.test.ts`
Expected: FAIL（找不到 `../src/tracking/tracking`）。

- [ ] **Step 3: 实现组织阈值**

新建 `packages/core/src/tracking/settings.ts`：

```ts
/** 组织的跟进阈值（P3-C1）：存在 organizations.settings.tracking，缺省或无效项取默认值。 */
import { eq } from 'drizzle-orm';
import { requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { organizations } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { type TrackingSettings, trackingSettingsOf } from './aging';

const KEYS = ['warnDays', 'alertDays', 'staleUpdateDays'] as const;

export async function getTrackingSettings(db: Db, actor: Actor): Promise<TrackingSettings> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, actor.orgId));
    return trackingSettingsOf(org?.settings ?? {});
  });
}

/** 组织管理员修改：每项为 1–365 的整数，且标黄天数小于标红天数。没有变化时不写。 */
export async function updateTrackingSettings(db: Db, actor: Actor, input: TrackingSettings): Promise<TrackingSettings> {
  requireOrgAdmin(actor);
  for (const k of KEYS) {
    const v = input[k];
    if (!Number.isInteger(v) || v < 1 || v > 365) throw new AppError('invalid', '天数应为 1–365 的整数');
  }
  if (input.warnDays >= input.alertDays) throw new AppError('invalid', '标黄天数应小于标红天数');
  const next: TrackingSettings = { warnDays: input.warnDays, alertDays: input.alertDays, staleUpdateDays: input.staleUpdateDays };
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, actor.orgId)).for('update');
    if (!cur) throw new AppError('not_found', '组织不存在');
    const old = trackingSettingsOf(cur.settings);
    const changes = KEYS.map((field) => ({ field, old: old[field], new: next[field] })).filter((c) => c.old !== c.new);
    if (changes.length === 0) return next;
    await tx.update(organizations).set({ settings: { ...cur.settings, tracking: next } }).where(eq(organizations.id, actor.orgId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'organization.tracking_settings_changed',
      subjectType: 'organization',
      subjectId: actor.orgId,
      actor,
      payload: { changes },
    });
    return next;
  });
}
```

- [ ] **Step 4: 实现跟进列表**

新建 `packages/core/src/tracking/tracking.ts`：

```ts
/**
 * 跟进列表（P3-C1）：在 withOrg 中按可见产品读出全部在手的需求与工作项，算好停留、在制、老化与无进展。
 * 四个页签（全部在手、任务老化、按阶段看板、按产品经理）由前端从同一份结果派生。
 * 看不到的产品的需求与工作项不出现在结果里；不关联产品的工作项只给非访客成员（Token 须为全部产品范围）。
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, visibleProductIds } from '../access/permissions';
import { orgTimeZone } from '../dashboard/flow';
import { addDays, zonedDate } from '../dashboard/metrics';
import type { Db } from '../db/client';
import {
  blockers,
  domainEvents,
  fieldDefinitions,
  fieldOptions,
  fieldValues,
  organizations,
  products,
  progressUpdates,
  requirements,
  stateTransitions,
  workItems,
} from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { workItemDisplayKey } from '../links/syntax';
import { memberNames, productWorkflowBody } from '../requirements/context';
import { displayKey, type MemberRef, type OptionRef } from '../requirements/requirements';
import { canEditUnlinked, canViewUnlinked, canWriteUnlinked } from './access';
import { activeDays, type AgingLevel, agingLevel, CLOSED_CATEGORIES, isStale, type PauseEvent, pauseIntervals, type TrackingSettings, trackingSettingsOf } from './aging';
import { WORK_ITEM_STATUS_LABELS, type WorkItemStatus } from './work-items';

/** 「含最近完成」往回看的天数。 */
export const RECENT_DONE_DAYS = 30;

const PAUSE_TYPES = ['requirement.paused', 'requirement.resumed', 'work_item.paused', 'work_item.resumed'];
const WORK_ITEM_COLOR: Record<WorkItemStatus, string> = { active: '#f59e0b', done: '#10b981', canceled: '#9ca3af' };
const WORK_ITEM_CATEGORY: Record<WorkItemStatus, string> = { active: 'started', done: 'completed', canceled: 'canceled' };

export type TrackingFilter = { productId?: string; ownerId?: string; typeOptionId?: string; paused?: boolean; blocked?: boolean; includeDone?: boolean };
export type TrackingStage = { key: string; label: string; color: string; category: string };
export type TrackingItem = {
  kind: 'requirement' | 'work_item';
  id: string;
  displayKey: string;
  title: string;
  product: { id: string; key: string; name: string } | null;
  owner: MemberRef | null;
  /** 需求为「类型」，工作项为「工作类型」。 */
  type: OptionRef | null;
  /** 需求的优先级；工作项为 null。 */
  priority: OptionRef | null;
  /** 需求为流程状态；工作项为进行中、已完成、已取消。 */
  stage: TrackingStage;
  paused: { at: Date; reason: string } | null;
  /** 本阶段停留天数（扣除暂停）：需求从进入当前状态起，工作项从启动日期起。 */
  stageDays: number;
  /** 在制天数（扣除暂停）：需求从加入跟进起，工作项从启动日期起；已完成的算到完成那天。 */
  wipDays: number;
  aging: AgingLevel;
  /** 超过阈值天数没有进展记录（没有进展时按加入跟进时间，工作项按创建时间）。 */
  stale: boolean;
  /** 启动日期：需求为加入跟进的日期，工作项为启动日期（没有时为创建日期）。 */
  startedOn: string;
  /** 进入当前阶段的日期：需求为进入当前状态的日期，工作项同启动日期。 */
  stageEnteredOn: string;
  blockers: { count: number; first: string | null };
  latest: { body: string; nextStep: string | null; follower: MemberRef | null; createdAt: Date } | null;
  expectedDate: string | null;
  /** 实际上线（完成）日期；未完成时为 null。 */
  doneOn: string | null;
  done: boolean;
  /** 当前用户能否写进展；写进展时能否顺手改预计日期。 */
  canWrite: boolean;
  canEditDate: boolean;
};
export type TrackingProduct = { id: string; key: string; name: string; states: Array<TrackingStage & { order: number }> };
export type TrackingList = {
  today: string;
  timeZone: string;
  settings: TrackingSettings;
  /** 可见产品与其流程状态（按产品编号排序），用于产品筛选与按阶段看板。 */
  products: TrackingProduct[];
  /** 筛选候选：在手条目的负责人（不受负责人、类型、暂停、阻塞筛选影响）。 */
  owners: MemberRef[];
  /** 筛选候选：「类型」与「工作类型」的选项。 */
  typeOptions: OptionRef[];
  items: TrackingItem[];
};

type ReqRow = typeof requirements.$inferSelect;
type StateMeta = Map<string, Map<string, TrackingStage>>;

async function pausesTx(tx: Tx, ids: string[]): Promise<Map<string, PauseEvent[]>> {
  const out = new Map<string, PauseEvent[]>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ subjectId: domainEvents.subjectId, type: domainEvents.type, at: domainEvents.occurredAt })
    .from(domainEvents)
    .where(and(inArray(domainEvents.type, PAUSE_TYPES), inArray(domainEvents.subjectId, ids)));
  for (const r of rows) out.set(r.subjectId, [...(out.get(r.subjectId) ?? []), { kind: r.type.endsWith('.paused') ? 'paused' : 'resumed', at: r.at }]);
  return out;
}

/** 每个对象最新一条未删除的进展。 */
async function latestTx(tx: Tx, reqIds: string[], wiIds: string[]): Promise<Map<string, typeof progressUpdates.$inferSelect>> {
  if (reqIds.length + wiIds.length === 0) return new Map();
  const rows = await tx
    .selectDistinctOn([progressUpdates.requirementId, progressUpdates.workItemId])
    .from(progressUpdates)
    .where(and(isNull(progressUpdates.deletedAt), or(inArray(progressUpdates.requirementId, reqIds), inArray(progressUpdates.workItemId, wiIds))))
    .orderBy(progressUpdates.requirementId, progressUpdates.workItemId, desc(progressUpdates.createdAt), desc(progressUpdates.id));
  return new Map(rows.map((r) => [(r.requirementId ?? r.workItemId)!, r]));
}

/** 进行中的阻塞项描述（按创建时间）。 */
async function activeBlockersTx(tx: Tx, reqIds: string[], wiIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (reqIds.length + wiIds.length === 0) return out;
  const rows = await tx
    .select({ requirementId: blockers.requirementId, workItemId: blockers.workItemId, description: blockers.description })
    .from(blockers)
    .where(and(eq(blockers.status, 'active'), or(inArray(blockers.requirementId, reqIds), inArray(blockers.workItemId, wiIds))))
    .orderBy(asc(blockers.createdAt), asc(blockers.id));
  for (const r of rows) {
    const id = (r.requirementId ?? r.workItemId)!;
    out.set(id, [...(out.get(id) ?? []), r.description]);
  }
  return out;
}

/** 类型、优先级、工作类型的取值：对象 id → 字段 key → 选项。 */
async function optionsTx(tx: Tx, ids: string[]): Promise<Map<string, Map<string, OptionRef>>> {
  const out = new Map<string, Map<string, OptionRef>>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ entityId: fieldValues.entityId, fieldKey: fieldDefinitions.key, id: fieldOptions.id, key: fieldOptions.key, label: fieldOptions.label, color: fieldOptions.color })
    .from(fieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
    .where(and(inArray(fieldValues.entityId, ids), inArray(fieldDefinitions.key, ['type', 'priority', 'work_type'])));
  for (const r of rows) {
    const m = out.get(r.entityId) ?? new Map<string, OptionRef>();
    m.set(r.fieldKey, { id: r.id, key: r.key, label: r.label, color: r.color });
    out.set(r.entityId, m);
  }
  return out;
}

/** 已完成需求的上线时刻：最后一次从非完成类（或创建）进入完成类的流转。 */
async function completedAtTx(tx: Tx, rows: ReqRow[], meta: StateMeta): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (rows.length === 0) return out;
  const productOf = new Map(rows.map((r) => [r.id, r.productId]));
  const trans = await tx
    .select({ requirementId: stateTransitions.requirementId, fromState: stateTransitions.fromState, toState: stateTransitions.toState, at: stateTransitions.at })
    .from(stateTransitions)
    .where(inArray(stateTransitions.requirementId, rows.map((r) => r.id)))
    .orderBy(asc(stateTransitions.at), asc(stateTransitions.id));
  for (const tr of trans) {
    const states = meta.get(productOf.get(tr.requirementId)!);
    const category = (k: string | null) => (k ? states?.get(k)?.category : undefined) ?? 'backlog';
    if (category(tr.toState) === 'completed' && (tr.fromState === null || category(tr.fromState) !== 'completed')) out.set(tr.requirementId, tr.at);
  }
  return out;
}

/** 「类型」与「工作类型」的选项（组织级与可见产品的覆盖）：类型在前，各自按排序。 */
async function typeOptionsTx(tx: Tx, visible: string[]): Promise<OptionRef[]> {
  const defs = await tx
    .select({ id: fieldDefinitions.id, key: fieldDefinitions.key })
    .from(fieldDefinitions)
    .where(and(inArray(fieldDefinitions.key, ['type', 'work_type']), or(isNull(fieldDefinitions.productId), inArray(fieldDefinitions.productId, visible))));
  if (defs.length === 0) return [];
  const rank = new Map(defs.map((d) => [d.id, d.key === 'type' ? 0 : 1]));
  const rows = await tx.select().from(fieldOptions).where(inArray(fieldOptions.fieldId, defs.map((d) => d.id)));
  return rows
    .sort((a, b) => rank.get(a.fieldId)! - rank.get(b.fieldId)! || a.sort - b.sort)
    .map((o) => ({ id: o.id, key: o.key, label: o.label, color: o.color }));
}

export async function getTracking(db: Db, actor: Actor, filter: TrackingFilter = {}, opts: { now?: Date } = {}): Promise<TrackingList> {
  return withOrg(db, actor.orgId, async (tx) => {
    const timeZone = await orgTimeZone(tx, actor.orgId);
    const today = zonedDate(opts.now ?? new Date(), timeZone);
    const cutoff = addDays(today, -RECENT_DONE_DAYS);
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, actor.orgId));
    const settings = trackingSettingsOf(org?.settings ?? {});

    const visible = [...(await visibleProductIds(tx, actor))];
    const roles = new Map<string, ProductRole | null>();
    for (const id of visible) roles.set(id, await productRoleOf(tx, actor, id));
    const productRows = visible.length
      ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(inArray(products.id, visible)).orderBy(asc(products.key))
      : [];
    const productList: TrackingProduct[] = [];
    const meta: StateMeta = new Map();
    for (const p of productRows) {
      const body = await productWorkflowBody(tx, p.id);
      const states = [...body.states]
        .sort((a, b) => a.order - b.order)
        .map((s) => ({ key: s.key, label: s.label, color: s.color, category: s.category, order: s.order }));
      productList.push({ ...p, states });
      meta.set(p.id, new Map(states.map((s) => [s.key, s])));
    }
    const productById = new Map(productRows.map((p) => [p.id, p]));
    // 合法但看不到或不存在的产品：范围为空，结果为空（不报错，也不暴露该产品是否存在）
    const scope = filter.productId ? visible.filter((id) => id === filter.productId) : visible;
    const unlinked = !filter.productId && canViewUnlinked(actor);
    const stageOf = (r: ReqRow): TrackingStage => meta.get(r.productId)?.get(r.stateKey) ?? { key: r.stateKey, label: r.stateKey, color: '#8a9199', category: 'backlog' };

    // 需求：已加入跟进；在手 = 当前状态不在已完成、已取消类别（退回收集也算）；「含最近完成」时加上最近 30 天上线的
    const reqRows = await tx
      .select()
      .from(requirements)
      .where(and(inArray(requirements.productId, scope), isNull(requirements.deletedAt), isNotNull(requirements.trackedSince)));
    const completedAt = await completedAtTx(tx, filter.includeDone ? reqRows.filter((r) => stageOf(r).category === 'completed') : [], meta);
    const doneAtOf = (r: ReqRow): Date => completedAt.get(r.id) ?? r.stateChangedAt;
    const reqs = reqRows.filter((r) => {
      const category = stageOf(r).category;
      if (!CLOSED_CATEGORIES.includes(category)) return true;
      return category === 'completed' && !!filter.includeDone && zonedDate(doneAtOf(r), timeZone) >= cutoff;
    });

    // 工作项：进行中；「含最近完成」时加上最近 30 天完成的
    const statuses: WorkItemStatus[] = filter.includeDone ? ['active', 'done'] : ['active'];
    const wiRows = (
      await tx
        .select()
        .from(workItems)
        .where(and(isNull(workItems.deletedAt), inArray(workItems.status, statuses), or(inArray(workItems.productId, scope), unlinked ? isNull(workItems.productId) : sql`false`)))
    ).filter((w) => w.status === 'active' || (w.doneAt !== null && zonedDate(w.doneAt, timeZone) >= cutoff));

    const reqIds = reqs.map((r) => r.id);
    const wiIds = wiRows.map((w) => w.id);
    const pauses = await pausesTx(tx, [...reqIds, ...wiIds]);
    const latest = await latestTx(tx, reqIds, wiIds);
    const blockerMap = await activeBlockersTx(tx, reqIds, wiIds);
    const options = await optionsTx(tx, [...reqIds, ...wiIds]);
    const names = await memberNames(tx, [
      ...reqs.map((r) => r.ownerMemberId),
      ...wiRows.map((w) => w.ownerMemberId),
      ...[...latest.values()].map((p) => p.followerMemberId),
    ]);
    const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
    const latestOf = (id: string): TrackingItem['latest'] => {
      const p = latest.get(id);
      return p ? { body: p.body, nextStep: p.nextStep, follower: ref(p.followerMemberId), createdAt: p.createdAt } : null;
    };
    const blockersOf = (id: string) => {
      const list = blockerMap.get(id) ?? [];
      return { count: list.length, first: list[0] ?? null };
    };
    const optionOf = (id: string, key: string): OptionRef | null => options.get(id)?.get(key) ?? null;

    const items: TrackingItem[] = [
      ...reqs.map((r): TrackingItem => {
        const stage = stageOf(r);
        const done = CLOSED_CATEGORIES.includes(stage.category);
        const until = done ? doneAtOf(r) : null;
        const intervals = pauseIntervals(pauses.get(r.id) ?? []);
        const stageDays = activeDays(r.stateChangedAt, until, today, intervals, timeZone);
        const paused = r.pausedAt !== null;
        const canWrite = atLeast(roles.get(r.productId) ?? null, 'editor');
        return {
          kind: 'requirement',
          id: r.id,
          displayKey: displayKey(productById.get(r.productId)!.key, r.number),
          title: r.title,
          product: productById.get(r.productId)!,
          owner: ref(r.ownerMemberId),
          type: optionOf(r.id, 'type'),
          priority: optionOf(r.id, 'priority'),
          stage,
          paused: r.pausedAt ? { at: r.pausedAt, reason: r.pauseReason ?? '' } : null,
          stageDays,
          wipDays: activeDays(r.trackedSince!, until, today, intervals, timeZone),
          aging: done ? 'normal' : agingLevel(stageDays, paused, settings),
          stale: !done && isStale(latest.get(r.id)?.createdAt ?? r.trackedSince!, paused, today, timeZone, settings),
          startedOn: zonedDate(r.trackedSince!, timeZone),
          stageEnteredOn: zonedDate(r.stateChangedAt, timeZone),
          blockers: blockersOf(r.id),
          latest: latestOf(r.id),
          expectedDate: r.expectedDate,
          doneOn: until ? zonedDate(until, timeZone) : null,
          done,
          canWrite,
          canEditDate: canWrite,
        };
      }),
      ...wiRows.map((w): TrackingItem => {
        const done = w.status === 'done';
        const start = w.startedOn ?? zonedDate(w.createdAt, timeZone);
        const until = done ? w.doneAt : null;
        const days = activeDays(start, until, today, pauseIntervals(pauses.get(w.id) ?? []), timeZone);
        const paused = w.pausedAt !== null;
        const canWrite = w.productId ? atLeast(roles.get(w.productId) ?? null, 'editor') : canWriteUnlinked(actor);
        return {
          kind: 'work_item',
          id: w.id,
          displayKey: workItemDisplayKey(w.number),
          title: w.title,
          product: w.productId ? productById.get(w.productId)! : null,
          owner: ref(w.ownerMemberId),
          type: optionOf(w.id, 'work_type'),
          priority: null,
          stage: { key: w.status, label: WORK_ITEM_STATUS_LABELS[w.status], color: WORK_ITEM_COLOR[w.status], category: WORK_ITEM_CATEGORY[w.status] },
          paused: w.pausedAt ? { at: w.pausedAt, reason: w.pauseReason ?? '' } : null,
          stageDays: days,
          wipDays: days,
          aging: done ? 'normal' : agingLevel(days, paused, settings),
          stale: !done && isStale(latest.get(w.id)?.createdAt ?? w.createdAt, paused, today, timeZone, settings),
          startedOn: start,
          stageEnteredOn: start,
          blockers: blockersOf(w.id),
          latest: latestOf(w.id),
          expectedDate: w.expectedDate,
          doneOn: until ? zonedDate(until, timeZone) : null,
          done,
          canWrite,
          canEditDate: w.productId ? canWrite : canEditUnlinked(actor, w),
        };
      }),
    ];

    const owners = [...new Map(items.flatMap((i) => (i.owner ? [[i.owner.id, i.owner] as const] : []))).values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, 'zh-CN'),
    );
    const shown = items
      .filter(
        (i) =>
          (!filter.ownerId || i.owner?.id === filter.ownerId) &&
          (!filter.typeOptionId || i.type?.id === filter.typeOptionId) &&
          (!filter.paused || i.paused !== null) &&
          (!filter.blocked || i.blockers.count > 0),
      )
      .sort((a, b) => b.stageDays - a.stageDays || a.displayKey.localeCompare(b.displayKey, 'zh-CN', { numeric: true }));
    return { today, timeZone, settings, products: productList, owners, typeOptions: await typeOptionsTx(tx, visible), items: shown };
  });
}
```

`packages/core/src/index.ts` 在 `export * from './tracking/progress';` 之后加：

```ts
export * from './tracking/tracking';
export * from './tracking/settings';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-list.test.ts test/tracking-aging.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/tracking/tracking.ts packages/core/src/tracking/settings.ts packages/core/src/index.ts packages/core/test/tracking-list.test.ts
git commit -m "feat(core): 跟进列表（在手条目、停留与在制、老化与无进展、按可见产品过滤）与组织阈值

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 通知：工作项指派与 @、进展记录的跟进人与关注者、工作项可以关注

**Files:**
- Modify: `packages/core/src/notifications/constants.ts`、`packages/core/src/member-notifications/content.ts`、`packages/core/src/member-notifications/recipients.ts`、`packages/core/src/member-notifications/generate.ts`、`packages/core/src/member-notifications/subscriptions.ts`、`packages/core/src/wecom/accounts.ts`
- Test: `packages/core/test/tracking-notify.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `canViewUnlinked`、`loadWorkItemTx`、`requireWorkItemAccess`；Task 5 的 `createWorkItem`、`updateWorkItem`、`workItemDisplayKey`；Task 6 的 `createProgress`、`updateProgress`（事件 payload `progressId`、`followerMemberId`、`nextStep`、`changes`）；已有的 `runNotificationTick`、`setSubscription`、`getSubscription`、`listMentionMembers`、`updateMember`
- Produces:
  - `NOTIFICATION_SUBJECT_TYPES` 与 `SUBSCRIPTION_SUBJECT_TYPES` 增加 `'work_item'`（`subject_type` 列是 text，不需要迁移）
  - `NotificationSubject.productId: string | null`；`HANDLED_EVENT_TYPES` 增加 `work_item.created`、`work_item.updated`、`progress.created`、`progress.updated`
  - `eligibleMembersTx(tx, productId, ids, opts?: { excludeGuests?: boolean })`
  - `getSubscription` / `setSubscription` 接受 `{ type: 'work_item', id }`
  - `listMentionMembers(db, actor, productId: string | null)`：`null` 为组织级（不关联产品的工作项），访客 403

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/tracking-notify.test.ts`：

```ts
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberNotifications, subscriptions } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { mentionMarkup } from '../src/links/syntax';
import { getSubscription, setSubscription } from '../src/member-notifications/subscriptions';
import { runNotificationTick } from '../src/notifications/worker';
import { createRequirement } from '../src/requirements/requirements';
import { updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createProgress, type ProgressSubject, updateProgress } from '../src/tracking/progress';
import { createWorkItem, updateWorkItem } from '../src/tracking/work-items';
import { listMentionMembers } from '../src/wecom/accounts';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, seedInstance } from './factories';
import { TEST_DEPS } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let b: Actor;
let guest: Actor;
let outsider: Actor;
let leaver: Actor;
let pan: string;
let reqId: string;
const deps = { ...TEST_DEPS, transport: fakeTransport().transport };
const tick = () => runNotificationTick(t.db, deps);
const inbox = (memberId: string) =>
  t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.memberId, memberId)).orderBy(asc(memberNotifications.createdAt), asc(memberNotifications.id));
const last = async (memberId: string) => (await inbox(memberId)).at(-1);
const req = (id: string): ProgressSubject => ({ type: 'requirement', id });
const wi = (id: string): ProgressSubject => ({ type: 'work_item', id });

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  a = await asMember(t.db, owner, '张三');
  b = await asMember(t.db, owner, '李四');
  // 访客：对网盘有只读角色；外部访客：没有任何产品角色
  guest = await asMember(t.db, owner, '访客', 'guest');
  await updateMember(t.db, owner, guest.memberId, { orgRole: 'guest' });
  await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
  outsider = await asMember(t.db, owner, '外部访客', 'guest');
  await updateMember(t.db, owner, outsider.memberId, { orgRole: 'guest' });
  leaver = await asMember(t.db, owner, '王五');
  reqId = (await createRequirement(t.db, owner, pan, { title: '登录页改版' })).id;
  await tick();
});
afterAll(() => t.cleanup());

describe('工作项通知', () => {
  it('负责人收到「被指派」并自动关注；描述里的 @ 收到「被 @」；不关联产品时访客收不到', async () => {
    const w = await createWorkItem(t.db, owner, {
      title: '协助排查',
      ownerMemberId: a.memberId,
      description: `${mentionMarkup(b.memberId, '李四')} ${mentionMarkup(guest.memberId, '访客')} 一起看`,
    });
    await tick();
    expect((await inbox(a.memberId)).map((n) => [n.kind, n.subjectType, n.subjectId, n.title, n.body, n.url])).toEqual([
      ['assigned', 'work_item', w.id, 'W-1 协助排查', '把工作项指派给你', '/acme/work-items/W-1'],
    ]);
    expect((await inbox(b.memberId)).map((n) => [n.kind, n.body])).toEqual([['mentioned', '在工作项描述中 @ 了你']]);
    expect(await inbox(guest.memberId)).toEqual([]);
    const subs = await t.adminDb.select().from(subscriptions).where(eq(subscriptions.subjectId, w.id));
    expect(subs.map((s) => [s.memberId, s.subjectType, s.source]).sort()).toEqual(
      [
        [a.memberId, 'work_item', 'auto'],
        [b.memberId, 'work_item', 'auto'],
      ].sort(),
    );
  });

  it('更换负责人：新负责人收到「被指派」', async () => {
    const w = await createWorkItem(t.db, owner, { title: '对接渠道' });
    await updateWorkItem(t.db, owner, w.id, { ownerMemberId: b.memberId });
    await tick();
    expect(await last(b.memberId)).toMatchObject({ kind: 'assigned', title: 'W-2 对接渠道', body: '把工作项指派给你' });
  });
});

describe('进展记录通知', () => {
  it('跟进人收到「你是下一步跟进人」；关注者收到「写了进展」；写的人自己不收', async () => {
    await setSubscription(t.db, b, { type: 'requirement', id: reqId }, true);
    // 每条之后各跑一轮：同一轮写入的通知时间相同，分开跑才能按时间断言顺序
    await createProgress(t.db, owner, req(reqId), { body: '接口已联调完成，等待测试环境部署后验证', nextStep: '部署测试环境', followerMemberId: a.memberId });
    await tick();
    await createProgress(t.db, owner, req(reqId), { body: '补充说明', followerMemberId: a.memberId });
    await tick();
    expect((await inbox(a.memberId)).slice(-2).map((n) => [n.kind, n.subjectType, n.title, n.body])).toEqual([
      ['assigned', 'requirement', 'PAN-1 登录页改版', '你是下一步跟进人：部署测试环境'],
      ['assigned', 'requirement', 'PAN-1 登录页改版', '你是下一步跟进人'],
    ]);
    expect((await inbox(b.memberId)).slice(-2).map((n) => [n.kind, n.body])).toEqual([
      ['followed_change', '写了进展：接口已联调完成，等待测试环境部署后验证'],
      ['followed_change', '写了进展：补充说明'],
    ]);
    expect(await inbox(owner.memberId)).toEqual([]);
  });

  it('跟进人离开或看不到对象：不写通知', async () => {
    await createProgress(t.db, owner, req(reqId), { body: '给外部访客', followerMemberId: outsider.memberId });
    await createProgress(t.db, owner, req(reqId), { body: '给王五', followerMemberId: leaver.memberId });
    await updateMember(t.db, owner, leaver.memberId, { status: 'left' });
    const w = await createWorkItem(t.db, owner, { title: '不关联产品的工作' });
    await createProgress(t.db, owner, wi(w.id), { body: '给访客', followerMemberId: guest.memberId });
    await tick();
    for (const m of [outsider, leaver, guest]) expect(await inbox(m.memberId)).toEqual([]);
  });

  it('修改进展换了跟进人：通知新的跟进人；没换跟进人不通知', async () => {
    const p = await createProgress(t.db, owner, req(reqId), { body: '先给张三', nextStep: '确认方案', followerMemberId: a.memberId });
    await tick();
    const before = (await inbox(b.memberId)).length;
    await updateProgress(t.db, owner, p.id, { followerMemberId: b.memberId });
    await updateProgress(t.db, owner, p.id, { body: '只改正文' });
    await tick();
    expect((await inbox(b.memberId)).slice(before).map((n) => [n.kind, n.body])).toEqual([['assigned', '你是下一步跟进人：确认方案']]);
  });
});

describe('工作项的关注与 @ 候选成员', () => {
  it('工作项可以关注，关注者在新进展时收到；访客不能关注不关联产品的工作项', async () => {
    const w = await createWorkItem(t.db, owner, { title: '可关注的工作' });
    expect(await setSubscription(t.db, a, { type: 'work_item', id: w.id }, true)).toEqual({ following: true, source: 'manual', reason: '你手动关注了' });
    await expect(getSubscription(t.db, guest, { type: 'work_item', id: w.id })).rejects.toMatchObject({ code: 'not_found' });
    await createProgress(t.db, b, wi(w.id), { body: '对方已确认' });
    await tick();
    expect(await last(a.memberId)).toMatchObject({ kind: 'followed_change', subjectType: 'work_item', title: `${w.displayKey} 可关注的工作`, body: '写了进展：对方已确认' });
  });

  it('组织级 @ 候选成员：访客标为看不到；访客自己不能读取', async () => {
    const list = await listMentionMembers(t.db, owner, null);
    expect(list.find((m) => m.id === guest.memberId)!.canSeeProduct).toBe(false);
    expect(list.find((m) => m.id === a.memberId)!.canSeeProduct).toBe(true);
    expect(list.find((m) => m.id === leaver.memberId)).toMatchObject({ status: 'left', canSeeProduct: false });
    await expect(listMentionMembers(t.db, guest, null)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-notify.test.ts`
Expected: FAIL（工作项事件不生成通知；`setSubscription` 的 `work_item` 不被接受）。

- [ ] **Step 3: 通知与关注的对象类型**

`packages/core/src/notifications/constants.ts` 中：

```ts
export const NOTIFICATION_SUBJECT_TYPES = ['requirement', 'document', 'task', 'schedule'] as const;
```

改为：

```ts
export const NOTIFICATION_SUBJECT_TYPES = ['requirement', 'document', 'task', 'schedule', 'work_item'] as const;
```

```ts
export const SUBSCRIPTION_SUBJECT_TYPES = ['requirement', 'document'] as const;
```

改为：

```ts
export const SUBSCRIPTION_SUBJECT_TYPES = ['requirement', 'document', 'work_item'] as const;
```

- [ ] **Step 4: 收件人可以排除访客**

`packages/core/src/member-notifications/recipients.ts` 的 `eligibleMembersTx` 改为：

```ts
/**
 * 能收到某产品通知的成员：在职的真人成员，且按组织角色与产品角色能看到该产品（与 productRoleOf 同一口径，不含 Token 范围）。
 * 产品已删除时没有人；productId 为空（组织级，如系统告警、不关联产品的工作项）时不看产品；excludeGuests 时排除访客。
 */
export async function eligibleMembersTx(tx: Tx, productId: string | null, ids: string[], opts: { excludeGuests?: boolean } = {}): Promise<Map<string, Recipient>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  if (productId) {
    const [p] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, productId), isNull(products.deletedAt)));
    if (!p) return new Map();
  }
  const rows = await tx
    .select({ id: members.id, displayName: members.displayName, email: members.email, orgRole: members.orgRole, wecomUserid: members.wecomUserid })
    .from(members)
    .where(and(inArray(members.id, unique), eq(members.status, 'active'), eq(members.kind, 'human')));
  const roles = productId
    ? await tx
        .select({ memberId: productMembers.memberId, role: productMembers.role })
        .from(productMembers)
        .where(and(eq(productMembers.productId, productId), inArray(productMembers.memberId, unique)))
    : [];
  const roleOf = new Map(roles.map((r) => [r.memberId, r.role]));
  return new Map(
    rows
      .filter((m) => !productId || baseProductRole(m.orgRole, roleOf.get(m.id) ?? null) !== null)
      .filter((m) => !opts.excludeGuests || m.orgRole !== 'guest')
      .map((m) => [m.id, m]),
  );
}
```

- [ ] **Step 5: 工作项与进展记录的通知内容**

`packages/core/src/member-notifications/content.ts`：

1. 导入改为：

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { baseProductRole } from '../access/permissions';
import {
  comments,
  documents,
  domainEvents,
  functionTags,
  memberFunctionTags,
  members,
  productMembers,
  products,
  progressUpdates,
  requirements,
  subscriptions,
  tasks,
  workItems,
} from '../db/schema';
import type { Tx } from '../db/tx';
import type { DocumentStatus } from '../documents/constants';
import { DOCUMENT_STATUS_LABELS, documentDisplayKey } from '../documents/markdown';
import { plainMentions, taskDisplayKey, workItemDisplayKey } from '../links/syntax';
import { MEMBER_NOTIFICATION_RANK, type MemberNotificationKind, type NotificationSubjectType } from '../notifications/constants';
import { productWorkflowBody } from '../requirements/context';
import type { CheckState } from '../requirements/labels';
import { displayKey } from '../requirements/requirements';
import { type CheckItem, reviewStarted } from '../requirements/workflow-runtime';
import { checkSnapshots, documentSnapshots, waitingFor } from '../reviews/snapshot';
```

2. `NotificationSubject` 改为：

```ts
/** productId 为空：不关联产品的工作项（收件人排除访客）。 */
export type NotificationSubject = { type: NotificationSubjectType; id: string; productId: string | null; title: string; url: string };
```

3. `HANDLED_EVENT_TYPES` 的集合末尾（`'task.updated',` 之后）加：

```ts
  'work_item.created',
  'work_item.updated',
  'progress.created',
  'progress.updated',
```

4. `shown` 常量之后加：

```ts
/** 进展记录指定跟进人时的说明：有下一步时带上下一步。 */
const followerBody = (nextStep: string | null): string => (nextStep ? `你是下一步跟进人：${clip(nextStep, EXCERPT_MAX)}` : '你是下一步跟进人');
```

5. `subjectTx` 里 `if (type === 'task') { … }` 之后、`return null;` 之前加：

```ts
  if (type === 'work_item') {
    const [w] = await tx
      .select({ productId: workItems.productId, number: workItems.number, title: workItems.title, productDeletedAt: products.deletedAt })
      .from(workItems)
      .leftJoin(products, eq(products.id, workItems.productId))
      .where(and(eq(workItems.id, id), isNull(workItems.deletedAt)));
    if (!w || w.productDeletedAt) return null;
    const k = workItemDisplayKey(w.number);
    return { type: 'work_item', id, productId: w.productId, title: clip(`${k} ${w.title}`, TITLE_MAX), url: `/${slug}/work-items/${k}` };
  }
```

6. `followersTx` 的首行改为：

```ts
  if (subject.type !== 'requirement' && subject.type !== 'document' && subject.type !== 'work_item') return [];
```

注释改为 `/** 未取消关注的关注者（需求、PRD 与工作项可以关注）。 */`。

7. `signersTx` 开头两行：

```ts
async function signersTx(tx: Tx, subject: NotificationSubject): Promise<Candidate[]> {
  const body = await productWorkflowBody(tx, subject.productId);
```

改为：

```ts
async function signersTx(tx: Tx, subject: NotificationSubject): Promise<Candidate[]> {
  // 只用于需求与 PRD，二者总属于某个产品
  const productId = subject.productId!;
  const body = await productWorkflowBody(tx, productId);
```

   同一函数里 `.where(eq(productMembers.productId, subject.productId));` 改为 `.where(eq(productMembers.productId, productId));`。

8. `planEventTx` 的 `case 'requirement.state_changed'` 与 `case 'check_item.updated' / 'check_item.signed'` 里两处 `await productWorkflowBody(tx, subject.productId)` 都改为 `await productWorkflowBody(tx, subject.productId!)`（这两类事件的对象是需求）。

9. `planEventTx` 的 `switch` 里 `case 'task.updated': … break;` 之后加：

```ts
    case 'work_item.created':
      assign(asId(p.ownerMemberId), '把工作项指派给你');
      mention(idList(p.mentionedMemberIds), '在工作项描述中 @ 了你');
      break;
    case 'work_item.updated':
      assign(asId(changeOf(p, 'ownerMemberId')?.new), '把工作项指派给你');
      mention(idList(p.mentionedMemberIds), '在工作项描述中 @ 了你');
      break;
    case 'progress.created': {
      const progressId = asId(p.progressId);
      const [row] = progressId
        ? await tx.select({ body: progressUpdates.body, nextStep: progressUpdates.nextStep }).from(progressUpdates).where(eq(progressUpdates.id, progressId))
        : [];
      add([asId(p.followerMemberId)], 'assigned', followerBody(row?.nextStep ?? null));
      await notifyFollowers(`写了进展：${clip(plainMentions(row?.body ?? '').replace(/\s+/g, ' ').trim(), EXCERPT_MAX)}`);
      break;
    }
    case 'progress.updated': {
      const ch = changeOf(p, 'followerMemberId');
      if (!ch) break;
      const progressId = asId(p.progressId);
      const [row] = progressId ? await tx.select({ nextStep: progressUpdates.nextStep }).from(progressUpdates).where(eq(progressUpdates.id, progressId)) : [];
      add([asId(ch.new)], 'assigned', followerBody(row?.nextStep ?? null));
      break;
    }
```

- [ ] **Step 6: 生成时按对象排除访客，工作项补自动关注**

`packages/core/src/member-notifications/generate.ts` 的 `processEventTx` 中：

```ts
  const eligible = await eligibleMembersTx(tx, plan.subject.productId, [...chosen.keys(), ...plan.autoSubscribe]);
```

改为：

```ts
  // 不关联产品的工作项：任何非访客成员都能看到，访客看不到
  const excludeGuests = plan.subject.type === 'work_item' && plan.subject.productId === null;
  const eligible = await eligibleMembersTx(tx, plan.subject.productId, [...chosen.keys(), ...plan.autoSubscribe], { excludeGuests });
```

```ts
  if (type === 'requirement' || type === 'document') {
```

改为：

```ts
  if (type === 'requirement' || type === 'document' || type === 'work_item') {
```

- [ ] **Step 7: 工作项可以关注**

`packages/core/src/member-notifications/subscriptions.ts`：

1. 导入改为：

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { comments, documents, requirementAssignments, requirements, subscriptions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import type { SubscriptionSource, SubscriptionSubjectType } from '../notifications/constants';
import { loadWorkItemTx, requireWorkItemAccess } from '../tracking/access';
```

2. `loadSubjectTx` 整体替换为：

```ts
/** 关注对象的产品与负责人，并确认操作者能看到它；不存在、已删除或看不到时报「不存在」。 */
async function loadVisibleSubjectTx(tx: Tx, actor: Actor, s: SubscriptionSubject): Promise<{ productId: string | null; ownerMemberId: string | null }> {
  if (s.type === 'work_item') {
    const item = await loadWorkItemTx(tx, s.id);
    await requireWorkItemAccess(tx, actor, item, 'view');
    return { productId: item.productId, ownerMemberId: item.ownerMemberId };
  }
  if (s.type === 'requirement') {
    const [r] = await tx
      .select({ productId: requirements.productId, ownerMemberId: requirements.ownerMemberId })
      .from(requirements)
      .where(and(eq(requirements.id, s.id), isNull(requirements.deletedAt)));
    if (!r) throw new AppError('not_found', '需求不存在');
    await requireProductRole(tx, actor, r.productId, 'viewer');
    return r;
  }
  const [d] = await tx
    .select({ productId: documents.productId, ownerMemberId: documents.ownerMemberId })
    .from(documents)
    .where(and(eq(documents.id, s.id), isNull(documents.deletedAt)));
  if (!d) throw new AppError('not_found', 'PRD 不存在');
  await requireProductRole(tx, actor, d.productId, 'viewer');
  return d;
}
```

3. `reasonTx` 中 `if (ownerMemberId === memberId) return '你是负责人';` 之后加：

```ts
  if (s.type === 'work_item') return '你曾负责或被 @';
```

4. `getSubscription` 的事务体改为：

```ts
  return withOrg(db, actor.orgId, async (tx) => {
    const subj = await loadVisibleSubjectTx(tx, actor, s);
    return viewTx(tx, actor.memberId, s, subj.ownerMemberId);
  });
```

5. `setSubscription` 事务体开头两行：

```ts
    const subj = await loadSubjectTx(tx, s);
    await requireProductRole(tx, actor, subj.productId, 'viewer');
```

改为：

```ts
    const subj = await loadVisibleSubjectTx(tx, actor, s);
```

- [ ] **Step 8: 组织级 @ 候选成员**

`packages/core/src/wecom/accounts.ts`：

1. 导入加一行：

```ts
import { canViewUnlinked } from '../tracking/access';
```

2. `listMentionMembers` 整体替换为：

```ts
/**
 * 组织的全部真人成员（含已离开，用于显示灰色原名）；能否看到该产品按组织角色与产品角色计算。
 * productId 为 null 时用于不关联产品的工作项：能看到 = 在职的非访客；访客不能读取（403）。访客调用时不返回邮箱。
 */
export async function listMentionMembers(db: Db, actor: Actor, productId: string | null): Promise<MentionMember[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    if (productId) await requireProductRole(tx, actor, productId, 'viewer');
    else if (!canViewUnlinked(actor)) throw new AppError('forbidden', '访客无权查看此内容');
    const rows = await tx
      .select({ id: members.id, displayName: members.displayName, email: members.email, status: members.status, orgRole: members.orgRole, wecomUserid: members.wecomUserid })
      .from(members)
      .where(eq(members.kind, 'human'))
      .orderBy(asc(members.displayName));
    const roles = productId ? await tx.select({ memberId: productMembers.memberId, role: productMembers.role }).from(productMembers).where(eq(productMembers.productId, productId)) : [];
    const roleOf = new Map(roles.map((r) => [r.memberId, r.role]));
    const hideEmail = actor.orgRole === 'guest';
    return rows.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      email: hideEmail ? null : m.email,
      status: m.status,
      wecomBound: m.wecomUserid !== null,
      canSeeProduct: m.status === 'active' && (productId ? baseProductRole(m.orgRole, roleOf.get(m.id) ?? null) !== null : m.orgRole !== 'guest'),
    }));
  });
}
```

- [ ] **Step 9: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-notify.test.ts test/member-notify-generate.test.ts test/member-subscriptions.test.ts test/wecom-accounts.test.ts test/member-notify-dispatch.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误（web 侧 `listMentionMembers` 的调用传字符串，仍然成立）。

- [ ] **Step 10: 提交**

```bash
git add packages/core/src/notifications/constants.ts packages/core/src/member-notifications packages/core/src/wecom/accounts.ts packages/core/test/tracking-notify.test.ts
git commit -m "feat(core): 工作项指派与 @、进展记录跟进人与关注者的站内通知，工作项可以关注，组织级 @ 候选成员

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 工作台：我负责的工作项与「等我跟进」

**Files:**
- Modify: `packages/core/src/workbench/workbench.ts`
- Test: `packages/core/test/tracking-workbench.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `canViewUnlinked`；Task 5 的 `createWorkItem`、`setWorkItemStatus`、`deleteWorkItem`、`workItemDisplayKey`；Task 6 的 `createProgress`；已有的 `getWorkbench`、`stateInfoByProduct`、`stateOf`
- Produces:
  - `WorkbenchRequirement` 多一个 `kind: 'requirement' | 'work_item'`（「我负责的」区块同时列出进行中的工作项，状态固定为「进行中」）
  - `type WorkbenchFollowUp = { org: WorkbenchOrg; kind: 'requirement' | 'work_item'; id: string; displayKey: string; title: string; nextStep: string | null; at: Date }`
  - `Workbench.following: WorkbenchSection<WorkbenchFollowUp>`：我是最新一条进展记录的跟进人、且仍在跟进中的条目（需求跟进中、工作项进行中），按进展时间从早到晚

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/tracking-workbench.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../src/auth/accounts';
import type { Actor } from '../src/domain-types';
import { createRequirement } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createProduct } from '../src/tenancy/products';
import { createProgress } from '../src/tracking/progress';
import { createWorkItem, deleteWorkItem, setWorkItemStatus } from '../src/tracking/work-items';
import { getWorkbench } from '../src/workbench/workbench';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let account: AccountView;
let owner: Actor;
let peer: Actor;
let pan: string;

const move = (id: string, to: string) => transitionRequirement(t.db, owner, id, { to });

beforeAll(async () => {
  t = await createTestDb();
  ({ account, owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  peer = await asMember(t.db, owner, '同事乙');
});
afterAll(() => t.cleanup());

describe('工作台', () => {
  it('我负责的需求与工作项：列出进行中的工作项；已完成、已删除的不列', async () => {
    await createRequirement(t.db, owner, pan, { title: '我的需求', ownerMemberId: owner.memberId });
    await createWorkItem(t.db, owner, { title: '我的工作项', ownerMemberId: owner.memberId });
    const done = await createWorkItem(t.db, owner, { title: '完成的工作项', ownerMemberId: owner.memberId });
    await setWorkItemStatus(t.db, owner, done.id, 'done');
    const removed = await createWorkItem(t.db, owner, { title: '删除的工作项', ownerMemberId: owner.memberId });
    await deleteWorkItem(t.db, owner, removed.id);
    const wb = await getWorkbench(t.db, account.id);
    expect(wb.owned.items.map((x) => [x.kind, x.displayKey, x.title, x.state.label]).sort()).toEqual(
      [
        ['requirement', 'PAN-1', '我的需求', '收集'],
        ['work_item', 'W-1', '我的工作项', '进行中'],
      ].sort(),
    );
  });

  it('等我跟进：我是最新一条进展的跟进人且仍在跟进中；被后来的进展换掉、已上线、已完成的不列', async () => {
    const r1 = await createRequirement(t.db, owner, pan, { title: '等我跟进的需求' });
    await move(r1.id, 'dev');
    await createProgress(t.db, peer, { type: 'requirement', id: r1.id }, { body: '方案初稿', nextStep: '请确认方案', followerMemberId: owner.memberId });
    const r2 = await createRequirement(t.db, owner, pan, { title: '被换掉的需求' });
    await move(r2.id, 'dev');
    await createProgress(t.db, peer, { type: 'requirement', id: r2.id }, { body: '先给你', followerMemberId: owner.memberId });
    await createProgress(t.db, peer, { type: 'requirement', id: r2.id }, { body: '改由我跟进', followerMemberId: peer.memberId });
    const r3 = await createRequirement(t.db, owner, pan, { title: '已上线的需求' });
    await move(r3.id, 'dev');
    await createProgress(t.db, peer, { type: 'requirement', id: r3.id }, { body: '上线前确认', followerMemberId: owner.memberId });
    await move(r3.id, 'done');
    const w1 = await createWorkItem(t.db, peer, { title: '等我跟进的工作项' });
    await createProgress(t.db, peer, { type: 'work_item', id: w1.id }, { body: '对方已回复', nextStep: '回复对方', followerMemberId: owner.memberId });
    const w2 = await createWorkItem(t.db, peer, { title: '已完成的工作项' });
    await createProgress(t.db, peer, { type: 'work_item', id: w2.id }, { body: '收尾', followerMemberId: owner.memberId });
    await setWorkItemStatus(t.db, peer, w2.id, 'done');
    const wb = await getWorkbench(t.db, account.id);
    expect(wb.following.total).toBe(2);
    expect(wb.following.items.map((x) => [x.kind, x.displayKey, x.title, x.nextStep])).toEqual([
      ['requirement', r1.displayKey, '等我跟进的需求', '请确认方案'],
      ['work_item', w1.displayKey, '等我跟进的工作项', '回复对方'],
    ]);
    expect(wb.following.items[0]!.org).toMatchObject({ slug: 'acme' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-workbench.test.ts`
Expected: FAIL（`kind`、`following` 不存在）。

- [ ] **Step 3: 实现**

`packages/core/src/workbench/workbench.ts`：

1. 导入改为：

```ts
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, commentReads, comments, documents, iterations, products, progressUpdates, requirements, tasks, workItems } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { documentDisplayKey } from '../documents/markdown';
import type { Actor } from '../domain-types';
import { type StateInfo, stateInfoByProduct, stateOf } from '../iterations/iterations';
import { workItemDisplayKey } from '../links/syntax';
import { memberNames, productWorkflowBody } from '../requirements/context';
import { displayKey } from '../requirements/requirements';
import { checkSnapshots, documentSnapshots, signerIdentity, waitingFor } from '../reviews/snapshot';
import { hydrateTasks, orgToday, type TaskStatus } from '../tasks/tasks';
import { listMyOrganizations } from '../tenancy/orgs';
import { canViewUnlinked } from '../tracking/access';
```

2. `WorkbenchRequirement` 改为：

```ts
/** 「我负责的」一行：需求或进行中的工作项（P3-C1）。 */
export type WorkbenchRequirement = { org: WorkbenchOrg; kind: 'requirement' | 'work_item'; id: string; displayKey: string; title: string; state: StateInfo; updatedAt: Date };
/** 「等我跟进」一行：我是最新一条进展记录的跟进人。at 为该进展的时间。 */
export type WorkbenchFollowUp = { org: WorkbenchOrg; kind: 'requirement' | 'work_item'; id: string; displayKey: string; title: string; nextStep: string | null; at: Date };
```

3. `Workbench` 类型在 `unread: WorkbenchSection<WorkbenchUnread>;` 之后加 `following: WorkbenchSection<WorkbenchFollowUp>;`；`OrgPart` 改为：

```ts
type OrgPart = { owned: WorkbenchRequirement[]; tasks: WorkbenchTask[]; signatures: WorkbenchSignature[]; unread: WorkbenchUnread[]; following: WorkbenchFollowUp[] };
```

4. `WORKBENCH_LIMIT` 之后加：

```ts
/** 工作项在「我负责的」里显示的状态（只列进行中的）。 */
const WORK_ITEM_STATE: StateInfo = { label: '进行中', color: '#f59e0b', category: 'started' };
```

5. `orgPart` 开头：

```ts
    const visible = [...(await visibleProductIds(tx, actor))];
    if (visible.length === 0) return { owned: [], tasks: [], signatures: [], unread: [] };
```

改为：

```ts
    const visible = [...(await visibleProductIds(tx, actor))];
    const unlinked = canViewUnlinked(actor);
    if (visible.length === 0 && !unlinked) return { owned: [], tasks: [], signatures: [], unread: [], following: [] };
```

6. 「我负责的未完成需求」那段替换为：

```ts
    // 我负责的未完成需求（状态类别按产品工作流判断）与进行中的工作项（关联产品时须能看到该产品）
    const ownedRows = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.ownerMemberId, actor.memberId), isNull(requirements.deletedAt), inArray(requirements.productId, visible)));
    const workScope = or(inArray(workItems.productId, visible), unlinked ? isNull(workItems.productId) : sql`false`);
    const myWork = await tx
      .select()
      .from(workItems)
      .where(and(eq(workItems.ownerMemberId, actor.memberId), eq(workItems.status, 'active'), isNull(workItems.deletedAt), workScope));
    const owned: WorkbenchRequirement[] = [
      ...ownedRows
        .filter(isOpen)
        .map((r) => ({ org, kind: 'requirement' as const, id: r.id, displayKey: keyFor(r), title: r.title, state: stateOf(info, r.productId, r.stateKey), updatedAt: r.updatedAt })),
      ...myWork.map((w) => ({ org, kind: 'work_item' as const, id: w.id, displayKey: workItemDisplayKey(w.number), title: w.title, state: WORK_ITEM_STATE, updatedAt: w.updatedAt })),
    ];
```

7. 「未读评论」那段（`const unread: WorkbenchUnread[] = [ … ];`）之后、`return` 之前加：

```ts
    // 等我跟进：每个对象最新一条未删除的进展，跟进人是我，且对象仍在跟进中（需求跟进中、工作项进行中）
    const mine = await tx
      .selectDistinct({ requirementId: progressUpdates.requirementId, workItemId: progressUpdates.workItemId })
      .from(progressUpdates)
      .where(and(eq(progressUpdates.followerMemberId, actor.memberId), isNull(progressUpdates.deletedAt)));
    const mineReq = mine.flatMap((m) => (m.requirementId ? [m.requirementId] : []));
    const mineWork = mine.flatMap((m) => (m.workItemId ? [m.workItemId] : []));
    const latest = mine.length
      ? (
          await tx
            .selectDistinctOn([progressUpdates.requirementId, progressUpdates.workItemId])
            .from(progressUpdates)
            .where(and(isNull(progressUpdates.deletedAt), or(inArray(progressUpdates.requirementId, mineReq), inArray(progressUpdates.workItemId, mineWork))))
            .orderBy(progressUpdates.requirementId, progressUpdates.workItemId, desc(progressUpdates.createdAt), desc(progressUpdates.id))
        ).filter((p) => p.followerMemberId === actor.memberId)
      : [];
    const following: WorkbenchFollowUp[] = [];
    const reqLatest = latest.filter((p) => p.requirementId);
    if (reqLatest.length) {
      const rows = await tx
        .select()
        .from(requirements)
        .where(and(inArray(requirements.id, reqLatest.map((p) => p.requirementId!)), isNull(requirements.deletedAt), inArray(requirements.productId, visible), isNotNull(requirements.trackedSince)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const p of reqLatest) {
        const r = byId.get(p.requirementId!);
        if (r && isOpen(r)) following.push({ org, kind: 'requirement', id: r.id, displayKey: keyFor(r), title: r.title, nextStep: p.nextStep, at: p.createdAt });
      }
    }
    const workLatest = latest.filter((p) => p.workItemId);
    if (workLatest.length) {
      const rows = await tx
        .select()
        .from(workItems)
        .where(and(inArray(workItems.id, workLatest.map((p) => p.workItemId!)), isNull(workItems.deletedAt), eq(workItems.status, 'active'), workScope));
      const byId = new Map(rows.map((w) => [w.id, w]));
      for (const p of workLatest) {
        const w = byId.get(p.workItemId!);
        if (w) following.push({ org, kind: 'work_item', id: w.id, displayKey: workItemDisplayKey(w.number), title: w.title, nextStep: p.nextStep, at: p.createdAt });
      }
    }
```

   `return { owned, tasks: myTasks, signatures, unread };` 改为 `return { owned, tasks: myTasks, signatures, unread, following };`

8. `getWorkbench` 的返回对象在 `unread: …` 之后加：

```ts
    following: section(parts.flatMap((p) => p.following), (a, b) => a.at.getTime() - b.at.getTime()),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/tracking-workbench.test.ts test/workbench.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/workbench/workbench.ts packages/core/test/tracking-workbench.test.ts
git commit -m "feat(core): 工作台列出我负责的进行中工作项与「等我跟进」

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 接口与权限测试

**Files:**
- Create: `apps/web/src/server/routes/tracking.ts`
- Modify: `apps/web/src/server/api.ts`、`apps/web/src/server/routes/member-notifications.ts`
- Test: `apps/web/test/api/tracking.test.ts`

**Interfaces:**
- Consumes: Task 4–8 的服务函数；已有的 `readJson`（`http.ts`）、`idParam`（`routes/notifications.ts`）
- Produces（均在 `/api/v1` 下）:
  - `GET /orgs/:org/tracking?product&owner&type&paused=1&blocked=1&done=1` → `{ tracking: TrackingList }`；参数格式不对返回 400「筛选参数无效」
  - `GET /orgs/:org/tracking-settings` → `{ settings }`；`PUT /orgs/:org/tracking-settings`（`{ warnDays, alertDays, staleUpdateDays }`）→ `{ settings }`
  - `PUT /orgs/:org/requirements/:id/tracking`（`{ tracking: boolean }`）、`PUT /orgs/:org/requirements/:id/expected-date`（`{ expectedDate: string | null }`）、`POST /orgs/:org/requirements/:id/pause`（`{ reason }`）、`POST /orgs/:org/requirements/:id/resume` → `{ tracking: RequirementTracking }`
  - `GET|POST /orgs/:org/requirements/:id/progress`、`GET|POST /orgs/:org/work-items/:id/progress` → `{ progress: ProgressView[] }` / 201 `{ progress: ProgressView }`；`PATCH /orgs/:org/progress/:id` → `{ progress }`；`DELETE /orgs/:org/progress/:id` → 204
  - `POST /orgs/:org/work-items` → 201 `{ workItem }`；`GET /orgs/:org/work-items/:key` → `{ workItem }`；`PATCH /orgs/:org/work-items/:id` → `{ workItem }`；`DELETE /orgs/:org/work-items/:id` → 204；`POST /orgs/:org/work-items/:id/status`（`{ status }`）、`/pause`（`{ reason }`）、`/resume` → `{ workItem }`；`POST /orgs/:org/work-items/:id/blockers` → 201 `{ blocker }`
  - `GET /orgs/:org/mention-members` → `{ members }`（组织级，访客 403）；`/orgs/:org/subscriptions/:type/:id` 的 `type` 接受 `work_item`

- [ ] **Step 1: 写失败的测试**

新建 `apps/web/test/api/tracking.test.ts`：

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
let panReq: { id: string; displayKey: string };
let docReq: { id: string; displayKey: string };
let free: { id: string; displayKey: string };
let agentId: string;
const who: Record<string, As> = {};
const ids: Record<string, string> = {};
const RANDOM = '00000000-0000-4000-8000-000000000001';

/** 邀请一个新账号加入组织，返回其会话与成员 id。 */
async function join(email: string, orgRole: 'member' | 'guest', name: string): Promise<{ session: string; memberId: string }> {
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email, orgRole } });
  const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name, password: 'password123' } });
  const s = sessionFrom(accept.res);
  return { session: s, memberId: (await call(app, 'GET', '/orgs/acme', { session: s })).body.me.memberId };
}

const list = (as: As, query = '') => call(app, 'GET', `/orgs/acme/tracking${query}`, as);
const titles = (body: { tracking: { items: Array<{ title: string }> } }) => body.tracking.items.map((i) => i.title).sort();

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  pan = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  doc = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '文档', key: 'DOC' } })).body.product.id;
  panReq = (await call(app, 'POST', `/orgs/acme/products/${pan}/requirements`, { session, body: { title: '网盘需求' } })).body.requirement;
  docReq = (await call(app, 'POST', `/orgs/acme/products/${doc}/requirements`, { session, body: { title: '文档需求' } })).body.requirement;
  for (const r of [panReq, docReq]) await call(app, 'POST', `/orgs/acme/requirements/${r.id}/transitions`, { session, body: { to: 'doing' } });
  free = (await call(app, 'POST', '/orgs/acme/work-items', { session, body: { title: '不关联产品的工作' } })).body.workItem;
  await call(app, 'POST', '/orgs/acme/work-items', { session, body: { title: '网盘工作项', productId: pan } });
  agentId = (await call(app, 'POST', '/orgs/acme/agents', { session, body: { displayName: '机器人' } })).body.member.id;

  const ownerId = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  const setRole = (memberId: string, role: 'admin' | 'viewer') => call(app, 'PUT', `/orgs/acme/products/${pan}/roles/${memberId}`, { session, body: { role } });
  const productAdmin = await join('padmin@example.com', 'member', '产品管理员');
  await setRole(productAdmin.memberId, 'admin');
  const editor = await join('editor@example.com', 'member', '编辑成员');
  const viewer = await join('viewer@example.com', 'member', '只读成员');
  await setRole(viewer.memberId, 'viewer');
  const guest = await join('guest@example.com', 'guest', '访客');
  await setRole(guest.memberId, 'viewer');
  const token = async (scope: unknown) => (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: ownerId, name: '跟进', scope } })).body.token as string;
  Object.assign(ids, { owner: ownerId, productAdmin: productAdmin.memberId, editor: editor.memberId, viewer: viewer.memberId, guest: guest.memberId });
  Object.assign(who, {
    owner: { session },
    productAdmin: { session: productAdmin.session },
    editor: { session: editor.session },
    viewer: { session: viewer.session },
    guest: { session: guest.session },
    readToken: { token: await token({ products: 'all', access: 'read' }) },
    panToken: { token: await token({ products: [pan], access: 'write' }) },
  });
});
afterAll(() => cleanup());

describe('跟进列表接口', () => {
  it('各角色都能读取；访客与限定产品的 Token 只看到有角色的产品，响应里没有其他产品与不关联产品的工作项', async () => {
    for (const k of ['owner', 'productAdmin', 'editor', 'viewer', 'guest', 'readToken', 'panToken']) expect((await list(who[k]!)).status, k).toBe(200);
    expect(titles((await list(who.editor!)).body)).toEqual(['不关联产品的工作', '文档需求', '网盘工作项', '网盘需求'].sort());
    for (const k of ['guest', 'panToken']) {
      const r = await list(who[k]!);
      expect(titles(r.body), k).toEqual(['网盘工作项', '网盘需求'].sort());
      const text = JSON.stringify(r.body);
      for (const hidden of ['文档需求', '不关联产品的工作', doc]) expect(text, `${k} ${hidden}`).not.toContain(hidden);
    }
  });

  it('筛选参数格式错误返回 400「筛选参数无效」；合法 UUID 但不存在或看不到时返回空结果', async () => {
    for (const q of ['?product=abc', '?owner=1', '?type=x', '?paused=yes', '?done=true']) {
      const r = await list(who.owner!, q);
      expect(r.status, q).toBe(400);
      expect(r.body.error.message).toBe('筛选参数无效');
    }
    for (const q of [`?product=${RANDOM}`, `?owner=${RANDOM}`, `?type=${RANDOM}`]) {
      const r = await list(who.owner!, q);
      expect(r.status, q).toBe(200);
      expect(r.body.tracking.items, q).toEqual([]);
    }
    const hidden = await list(who.guest!, `?product=${doc}`);
    expect(hidden.status).toBe(200);
    expect(hidden.body.tracking.items).toEqual([]);
    expect(titles((await list(who.owner!, `?product=${pan}&done=1`)).body)).toEqual(['网盘工作项', '网盘需求'].sort());
  });
});

describe('需求的跟进设置与进展记录', () => {
  const path = () => `/orgs/acme/requirements/${panReq.id}`;

  it('产品编辑可以改预计日期、暂停与恢复；只读成员、只读 Token 返回 403；看不到的产品返回 404；需求 id 格式错误返回 400', async () => {
    const date = await call(app, 'PUT', `${path()}/expected-date`, { ...who.editor, body: { expectedDate: '2026-11-30' } });
    expect(date.status).toBe(200);
    expect(date.body.tracking.expectedDate).toBe('2026-11-30');
    const paused = await call(app, 'POST', `${path()}/pause`, { ...who.editor, body: { reason: '等法务' } });
    expect(paused.body.tracking.paused.reason).toBe('等法务');
    const again = await call(app, 'POST', `${path()}/pause`, { ...who.editor, body: { reason: '再暂停' } });
    expect(again.status).toBe(400);
    expect(again.body.error.message).toBe('需求已暂停');
    expect((await call(app, 'POST', `${path()}/resume`, who.editor!)).body.tracking.paused).toBeNull();
    for (const k of ['viewer', 'readToken']) expect((await call(app, 'POST', `${path()}/pause`, { ...who[k], body: { reason: '原因' } })).status, k).toBe(403);
    expect((await call(app, 'PUT', `/orgs/acme/requirements/${docReq.id}/tracking`, { ...who.guest, body: { tracking: false } })).status).toBe(404);
    expect((await call(app, 'PUT', '/orgs/acme/requirements/not-a-uuid/tracking', { ...who.editor, body: { tracking: false } })).status).toBe(400);
    const left = await call(app, 'PUT', `${path()}/tracking`, { ...who.editor, body: { tracking: false } });
    expect(left.body.tracking).toMatchObject({ active: false, optedOut: true });
    expect((await call(app, 'PUT', `${path()}/tracking`, { ...who.editor, body: { tracking: true } })).body.tracking.active).toBe(true);
  });

  it('进展记录：编辑写，作者改，产品管理员删别人的；只读成员不能写；跟进人须为在职真人', async () => {
    const created = await call(app, 'POST', `${path()}/progress`, { ...who.editor, body: { body: '联调中', nextStep: '约测试', followerMemberId: ids.viewer } });
    expect(created.status).toBe(201);
    expect(created.body.progress.follower).toEqual({ id: ids.viewer, displayName: '只读成员' });
    const p = created.body.progress;
    expect((await call(app, 'GET', `${path()}/progress`, who.viewer!)).body.progress.map((x: { body: string }) => x.body)).toEqual(['联调中']);
    expect((await call(app, 'POST', `${path()}/progress`, { ...who.viewer, body: { body: '只读' } })).status).toBe(403);
    expect((await call(app, 'PATCH', `/orgs/acme/progress/${p.id}`, { ...who.productAdmin, body: { body: '改别人的' } })).status).toBe(403);
    expect((await call(app, 'PATCH', `/orgs/acme/progress/${p.id}`, { ...who.editor, body: { body: '联调完成' } })).body.progress.body).toBe('联调完成');
    expect((await call(app, 'DELETE', `/orgs/acme/progress/${p.id}`, who.productAdmin!)).status).toBe(204);
    const agent = await call(app, 'POST', `${path()}/progress`, { ...who.editor, body: { body: '给 Agent', followerMemberId: agentId } });
    expect(agent.status).toBe(400);
    expect(agent.body.error.message).toBe('不能选择 Agent 成员');
  });
});

describe('工作项接口', () => {
  it('不关联产品：非访客成员可以新建与查看；访客、只读 Token、限定产品的 Token 不能新建；修改限负责人、创建人与组织管理员；能看到的成员都能写进展与挂阻塞项', async () => {
    const created = await call(app, 'POST', '/orgs/acme/work-items', { ...who.editor, body: { title: '编辑新建', startedOn: '2026-10-08' } });
    expect(created.status).toBe(201);
    expect(created.body.workItem.displayKey).toMatch(/^W-\d+$/);
    const { id, displayKey } = created.body.workItem;
    for (const k of ['guest', 'readToken', 'panToken']) expect((await call(app, 'POST', '/orgs/acme/work-items', { ...who[k], body: { title: '新建' } })).status, k).toBe(403);
    expect((await call(app, 'GET', `/orgs/acme/work-items/${displayKey}`, who.guest!)).status).toBe(404);
    expect((await call(app, 'GET', `/orgs/acme/work-items/${displayKey}`, who.viewer!)).body.workItem.access).toEqual({ view: true, edit: false, progress: true, manage: false });
    expect((await call(app, 'PATCH', `/orgs/acme/work-items/${id}`, { ...who.viewer, body: { title: '改名' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/progress`, { ...who.viewer, body: { body: '帮忙看了' } })).status).toBe(201);
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/blockers`, { ...who.viewer, body: { description: '等对方' } })).status).toBe(201);
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/status`, { ...who.editor, body: { status: 'paused' } })).status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/pause`, { ...who.editor, body: { reason: '等对方排期' } })).body.workItem.paused.reason).toBe('等对方排期');
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/resume`, who.editor!)).body.workItem.paused).toBeNull();
    expect((await call(app, 'POST', `/orgs/acme/work-items/${id}/status`, { ...who.editor, body: { status: 'done' } })).body.workItem.status).toBe('done');
    expect((await call(app, 'DELETE', `/orgs/acme/work-items/${id}`, who.viewer!)).status).toBe(403);
    expect((await call(app, 'DELETE', `/orgs/acme/work-items/${id}`, who.editor!)).status).toBe(204);
    expect((await call(app, 'GET', `/orgs/acme/work-items/${displayKey}`, who.editor!)).status).toBe(404);
  });

  it('关联产品的工作项按产品角色：只读成员不能修改；限定产品的 Token 可以在该产品新建', async () => {
    const created = await call(app, 'POST', '/orgs/acme/work-items', { ...who.panToken, body: { title: 'Token 新建', productId: pan } });
    expect(created.status).toBe(201);
    expect((await call(app, 'PATCH', `/orgs/acme/work-items/${created.body.workItem.id}`, { ...who.viewer, body: { title: '改名' } })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/work-items', { ...who.panToken, body: { title: '别的产品', productId: doc } })).status).toBe(404);
  });

  it('工作项关注与组织级 @ 候选成员：访客不能关注不关联产品的工作项、不能读取组织级候选成员', async () => {
    expect((await call(app, 'PUT', `/orgs/acme/subscriptions/work_item/${free.id}`, { ...who.editor, body: { following: true } })).body.subscription.following).toBe(true);
    expect((await call(app, 'PUT', `/orgs/acme/subscriptions/work_item/${free.id}`, { ...who.guest, body: { following: true } })).status).toBe(404);
    expect((await call(app, 'GET', `/orgs/acme/subscriptions/task/${free.id}`, who.editor!)).status).toBe(400);
    const members = await call(app, 'GET', '/orgs/acme/mention-members', who.editor!);
    expect(members.status).toBe(200);
    expect(members.body.members.find((m: { id: string }) => m.id === ids.guest).canSeeProduct).toBe(false);
    expect((await call(app, 'GET', '/orgs/acme/mention-members', who.guest!)).status).toBe(403);
  });
});

describe('跟进阈值接口', () => {
  it('组织管理员可以改；成员与只读 Token 返回 403；无效值返回 400；列表随之变化', async () => {
    const body = { warnDays: 10, alertDays: 20, staleUpdateDays: 5 };
    for (const k of ['editor', 'readToken']) expect((await call(app, 'PUT', '/orgs/acme/tracking-settings', { ...who[k], body })).status, k).toBe(403);
    const bad = await call(app, 'PUT', '/orgs/acme/tracking-settings', { session, body: { ...body, warnDays: 20, alertDays: 10 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('标黄天数应小于标红天数');
    expect((await call(app, 'PUT', '/orgs/acme/tracking-settings', { session, body })).body.settings).toEqual(body);
    expect((await call(app, 'GET', '/orgs/acme/tracking-settings', who.editor!)).body.settings).toEqual(body);
    expect((await list(who.guest!)).body.tracking.settings).toEqual(body);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run test/api/tracking.test.ts`
Expected: FAIL（`/orgs/acme/work-items` 等接口 404「接口不存在」）。

- [ ] **Step 3: 实现接口**

新建 `apps/web/src/server/routes/tracking.ts`：

```ts
import {
  AppError,
  createProgress,
  createWorkItem,
  createWorkItemBlocker,
  deleteProgress,
  deleteWorkItem,
  getTracking,
  getTrackingSettings,
  getWorkItemByKey,
  joinTracking,
  leaveTracking,
  listProgress,
  pauseRequirement,
  pauseWorkItem,
  resumeRequirement,
  resumeWorkItem,
  setRequirementExpectedDate,
  setWorkItemStatus,
  type TrackingFilter,
  updateProgress,
  updateTrackingSettings,
  updateWorkItem,
  WORK_ITEM_STATUSES,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';
import { idParam } from './notifications';

const uuid = z.string().uuid();
const flag = z.literal('1').optional();
const trackingQuery = z.object({ product: uuid.optional(), owner: uuid.optional(), type: uuid.optional(), paused: flag, blocked: flag, done: flag });
const date = z.string().max(20).nullable();
const pauseBody = z.object({ reason: z.string().max(1000) });
const progressBody = z.object({
  body: z.string().max(10_000),
  nextStep: z.string().max(2000).nullable().optional(),
  followerMemberId: uuid.nullable().optional(),
  expectedDate: date.optional(),
});
const progressPatch = z.object({ body: z.string().max(10_000).optional(), nextStep: z.string().max(2000).nullable().optional(), followerMemberId: uuid.nullable().optional() });
const workItemFields = {
  description: z.string().max(60_000).optional(),
  productId: uuid.nullable().optional(),
  ownerMemberId: uuid.nullable().optional(),
  workTypeOptionId: uuid.nullable().optional(),
  startedOn: date.optional(),
  expectedDate: date.optional(),
};
const settingsBody = z.object({ warnDays: z.number(), alertDays: z.number(), staleUpdateDays: z.number() });

/** 地址栏筛选 → 服务参数；格式不对时报 400（合法 UUID 但看不到或不存在的值由服务返回空结果）。 */
function trackingFilter(c: Context): TrackingFilter {
  const q = trackingQuery.safeParse(c.req.query());
  if (!q.success) throw new AppError('invalid', '筛选参数无效');
  const { product, owner, type, paused, blocked, done } = q.data;
  return { productId: product, ownerId: owner, typeOptionId: type, paused: !!paused, blocked: !!blocked, includeDone: !!done };
}

export function registerTrackingRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/tracking', async (c) => c.json({ tracking: await getTracking(deps.db, c.get('actor'), trackingFilter(c)) }));

  app.get('/orgs/:org/tracking-settings', async (c) => c.json({ settings: await getTrackingSettings(deps.db, c.get('actor')) }));

  app.put('/orgs/:org/tracking-settings', async (c) => {
    const body = await readJson(c, settingsBody);
    return c.json({ settings: await updateTrackingSettings(deps.db, c.get('actor'), body) });
  });

  // 需求的跟进设置
  app.put('/orgs/:org/requirements/:id/tracking', async (c) => {
    const id = idParam(c, 'id', '需求不存在');
    const body = await readJson(c, z.object({ tracking: z.boolean() }));
    const actor = c.get('actor');
    return c.json({ tracking: body.tracking ? await joinTracking(deps.db, actor, id) : await leaveTracking(deps.db, actor, id) });
  });

  app.put('/orgs/:org/requirements/:id/expected-date', async (c) => {
    const id = idParam(c, 'id', '需求不存在');
    const body = await readJson(c, z.object({ expectedDate: date }));
    return c.json({ tracking: await setRequirementExpectedDate(deps.db, c.get('actor'), id, body.expectedDate) });
  });

  app.post('/orgs/:org/requirements/:id/pause', async (c) => {
    const id = idParam(c, 'id', '需求不存在');
    const body = await readJson(c, pauseBody);
    return c.json({ tracking: await pauseRequirement(deps.db, c.get('actor'), id, body) });
  });

  app.post('/orgs/:org/requirements/:id/resume', async (c) => c.json({ tracking: await resumeRequirement(deps.db, c.get('actor'), idParam(c, 'id', '需求不存在')) }));

  app.get('/orgs/:org/requirements/:id/progress', async (c) =>
    c.json({ progress: await listProgress(deps.db, c.get('actor'), { type: 'requirement', id: idParam(c, 'id', '需求不存在') }) }),
  );

  app.post('/orgs/:org/requirements/:id/progress', async (c) => {
    const id = idParam(c, 'id', '需求不存在');
    const body = await readJson(c, progressBody);
    return c.json({ progress: await createProgress(deps.db, c.get('actor'), { type: 'requirement', id }, body) }, 201);
  });

  // 工作项
  app.post('/orgs/:org/work-items', async (c) => {
    const body = await readJson(c, z.object({ title: z.string().max(1000), ...workItemFields }));
    return c.json({ workItem: await createWorkItem(deps.db, c.get('actor'), body) }, 201);
  });

  app.get('/orgs/:org/work-items/:key', async (c) => c.json({ workItem: await getWorkItemByKey(deps.db, c.get('actor'), c.req.param('key')) }));

  app.patch('/orgs/:org/work-items/:id', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, z.object({ title: z.string().max(1000).optional(), ...workItemFields }));
    return c.json({ workItem: await updateWorkItem(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/work-items/:id', async (c) => {
    await deleteWorkItem(deps.db, c.get('actor'), idParam(c, 'id', '工作项不存在'));
    return c.body(null, 204);
  });

  app.post('/orgs/:org/work-items/:id/status', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, z.object({ status: z.enum(WORK_ITEM_STATUSES) }));
    return c.json({ workItem: await setWorkItemStatus(deps.db, c.get('actor'), id, body.status) });
  });

  app.post('/orgs/:org/work-items/:id/pause', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, pauseBody);
    return c.json({ workItem: await pauseWorkItem(deps.db, c.get('actor'), id, body) });
  });

  app.post('/orgs/:org/work-items/:id/resume', async (c) => c.json({ workItem: await resumeWorkItem(deps.db, c.get('actor'), idParam(c, 'id', '工作项不存在')) }));

  app.get('/orgs/:org/work-items/:id/progress', async (c) =>
    c.json({ progress: await listProgress(deps.db, c.get('actor'), { type: 'work_item', id: idParam(c, 'id', '工作项不存在') }) }),
  );

  app.post('/orgs/:org/work-items/:id/progress', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, progressBody);
    return c.json({ progress: await createProgress(deps.db, c.get('actor'), { type: 'work_item', id }, body) }, 201);
  });

  app.post('/orgs/:org/work-items/:id/blockers', async (c) => {
    const id = idParam(c, 'id', '工作项不存在');
    const body = await readJson(c, z.object({ description: z.string().max(500), ownerMemberId: uuid.nullable().optional() }));
    return c.json({ blocker: await createWorkItemBlocker(deps.db, c.get('actor'), id, body) }, 201);
  });

  // 进展记录
  app.patch('/orgs/:org/progress/:id', async (c) => {
    const id = idParam(c, 'id', '进展记录不存在');
    const body = await readJson(c, progressPatch);
    return c.json({ progress: await updateProgress(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/progress/:id', async (c) => {
    await deleteProgress(deps.db, c.get('actor'), idParam(c, 'id', '进展记录不存在'));
    return c.body(null, 204);
  });
}
```

`apps/web/src/server/api.ts`：导入加 `import { registerTrackingRoutes } from './routes/tracking';`，在 `registerWorkbenchRoutes(app, deps);` 之后加 `registerTrackingRoutes(app, deps);`。

`apps/web/src/server/routes/member-notifications.ts`：

1. `subjectParam` 里的提示 `'只能关注需求或 PRD'` 改为 `'只能关注需求、PRD 或工作项'`。
2. `// @ 候选成员` 那条路由之后加：

```ts
  // 组织级 @ 候选成员（不关联产品的工作项）；访客 403
  app.get('/orgs/:org/mention-members', async (c) => c.json({ members: await listMentionMembers(deps.db, c.get('actor'), null) }));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run test/api/tracking.test.ts test/api/member-notifications.test.ts test/api/requirements.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/server/routes/tracking.ts apps/web/src/server/api.ts apps/web/src/server/routes/member-notifications.ts apps/web/test/api/tracking.test.ts
git commit -m "feat(web): 跟进、工作项、进展记录与跟进阈值接口，组织级 @ 候选成员

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 前端数据层、跟进纯逻辑、导航与共享组件

**Files:**
- Create: `apps/web/src/features/tracking/model.ts`、`apps/web/src/features/tracking/model.test.ts`
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`、`apps/web/src/features/shell/nav.ts`、`apps/web/src/features/shell/nav.test.ts`、`apps/web/src/components/org-shell.tsx`、`apps/web/src/components/wikilink-textarea.tsx`、`apps/web/src/components/wiki-text.tsx`、`apps/web/src/components/follow-button.tsx`、`apps/web/src/features/member-notifications/use-mark-read.ts`

**Interfaces:**
- Consumes: Task 4–10 的类型（`RequirementTracking`、`WorkItemDetail`、`ProgressView`、`TrackingList`、`TrackingSettings`）与接口
- Produces:
  - `lib/types.ts`：`TrackingList`、`TrackingItem`、`TrackingSettings`、`RequirementTracking`、`WorkItemDetail`、`ProgressEntry`、`ProgressSubjectType`
  - `lib/queries.ts`：`qk.tracking(o, query)`、`qk.trackingSettings(o)`、`qk.workItem(o, key)`、`qk.progress(o, type, id)`（都以 `['org', o, 'tracking']` 开头）；`trackingKeys(o)`；`useTracking(o, query)`、`useTrackingSettings(o)`、`useWorkItem(o, key)`、`useProgress(o, type, id)`；`useMentionMembers(o, productId: string | null | undefined)`（`null` 取组织级）；`useSubscription` 接受 `'work_item'`
  - `features/tracking/model.ts`：`TRACKING_TABS`、`TrackingTab`、`TAB_LABELS`、`TrackingFilter`、`DEFAULT_FILTER`、`filterFromParams(params: URLSearchParams): TrackingFilter`、`filterQuery(f): string`、`trackingHref(org, f): string`、`hasFilter(f): boolean`、`itemHref(org, item): string`、`agingRows(items)`、`staleRows(items)`、`BoardColumn`、`boardColumns(list, productId: string | null): BoardColumn[]`、`OwnerGroup`、`ownerGroups(items): OwnerGroup[]`、`AGING_CLASS`、`AGING_LABEL`、`WORK_ITEM_STATUS_LABELS`、`ProgressTarget`、`targetOf(item): ProgressTarget`
  - 导航：主导航「需求」之后「跟进」（键 `work-tracking`，`/{org}/tracking`，`/{org}/work-items/*` 也高亮）；组织设置「看板」之后「跟进」（键 `tracking`）；图标 `checklist`（`ListChecks`）
  - `WikilinkTextarea`、`WikiText` 的 `productId` 可为 `null`（不关联产品的工作项：@ 取组织级成员），并多一个可选属性 `links?: boolean`（默认 `true`；为 `false` 或 `productId` 为 `null` 时不做 `[[ ]]` 补全，`[[ ]]` 按原文显示，工作项描述用）；`FollowButton` 的 `type` 增加 `'work_item'`；`useMarkNotificationsRead` 的对象类型增加 `'work_item'`

- [ ] **Step 1: 写失败的测试**

新建 `apps/web/src/features/tracking/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { TrackingItem, TrackingList } from '@/lib/types';
import { agingRows, boardColumns, DEFAULT_FILTER, filterFromParams, filterQuery, hasFilter, itemHref, ownerGroups, staleRows, targetOf, trackingHref } from './model';

const item = (over: Partial<TrackingItem>): TrackingItem => ({
  kind: 'requirement',
  id: 'r1',
  displayKey: 'PAN-1',
  title: '需求',
  product: { id: 'p1', key: 'PAN', name: '网盘' },
  owner: null,
  type: null,
  priority: null,
  stage: { key: 'dev', label: '开发中', color: '#f59e0b', category: 'started' },
  paused: null,
  stageDays: 0,
  wipDays: 0,
  aging: 'normal',
  stale: false,
  startedOn: '2026-10-01',
  stageEnteredOn: '2026-10-01',
  blockers: { count: 0, first: null },
  latest: null,
  expectedDate: null,
  doneOn: null,
  done: false,
  canWrite: true,
  canEditDate: true,
  ...over,
});

const STATES = [
  { key: 'collect', label: '收集', color: '#94a3b8', category: 'backlog', order: 1 },
  { key: 'design', label: '设计中', color: '#60a5fa', category: 'unstarted', order: 2 },
  { key: 'dev', label: '开发中', color: '#f59e0b', category: 'started', order: 3 },
  { key: 'done', label: '已上线', color: '#10b981', category: 'completed', order: 4 },
];
const list = (items: TrackingItem[]): Pick<TrackingList, 'products' | 'items'> => ({ products: [{ id: 'p1', key: 'PAN', name: '网盘', states: STATES }], items });

describe('地址栏解析', () => {
  it('不认识的页签当作「全部在手」；布尔筛选只认 1；其余值原样带给接口', () => {
    expect(filterFromParams(new URLSearchParams('tab=nope&product=abc&paused=1&blocked=true'))).toEqual({ ...DEFAULT_FILTER, product: 'abc', paused: true });
    expect(filterFromParams(new URLSearchParams('tab=board&owner=m1&type=t1&done=1'))).toEqual({
      tab: 'board',
      product: null,
      owner: 'm1',
      type: 't1',
      paused: false,
      blocked: false,
      done: true,
    });
  });

  it('接口查询串不含页签；页面地址在非默认页签时带 tab；页签不算筛选', () => {
    const f = { ...DEFAULT_FILTER, tab: 'aging' as const, product: 'p1', blocked: true };
    expect(filterQuery(f)).toBe('product=p1&blocked=1');
    expect(trackingHref('acme', f)).toBe('/acme/tracking?product=p1&blocked=1&tab=aging');
    expect(trackingHref('acme', DEFAULT_FILTER)).toBe('/acme/tracking');
    expect(hasFilter(DEFAULT_FILTER)).toBe(false);
    expect(hasFilter({ ...DEFAULT_FILTER, tab: 'board' })).toBe(false);
    expect(hasFilter(f)).toBe(true);
  });

  it('条目链接与写进展的对象', () => {
    expect(itemHref('acme', item({}))).toBe('/acme/requirements/PAN-1');
    const w = item({ kind: 'work_item', id: 'w1', displayKey: 'W-3', title: '协助', expectedDate: '2026-10-20', canEditDate: false });
    expect(itemHref('acme', w)).toBe('/acme/work-items/W-3');
    expect(targetOf(w)).toEqual({ type: 'work_item', id: 'w1', displayKey: 'W-3', title: '协助', expectedDate: '2026-10-20', canEditDate: false });
  });
});

describe('派生视图', () => {
  it('任务老化：未完成的条目按停留降序，同天按编号；无进展只取 stale', () => {
    const items = [
      item({ id: 'a', displayKey: 'PAN-10', stageDays: 5 }),
      item({ id: 'b', displayKey: 'PAN-2', stageDays: 20, stale: true }),
      item({ id: 'c', displayKey: 'PAN-9', stageDays: 5, stale: true }),
      item({ id: 'd', displayKey: 'PAN-1', stageDays: 99, done: true }),
    ];
    expect(agingRows(items).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(staleRows(items).map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('按阶段看板：选定产品按该产品非完成、非取消的状态分列；全部产品按类别，收集有条目才显示；工作项单独一列；已完成的不上看板', () => {
    const items = [
      item({ id: 'a', stage: { key: 'design', label: '设计中', color: '#60a5fa', category: 'unstarted' } }),
      item({ id: 'b' }),
      item({ id: 'c', done: true, stage: { key: 'done', label: '已上线', color: '#10b981', category: 'completed' } }),
      item({ id: 'w', kind: 'work_item', displayKey: 'W-1', product: null, stage: { key: 'active', label: '进行中', color: '#f59e0b', category: 'started' } }),
    ];
    expect(boardColumns(list(items), 'p1').map((c) => [c.label, c.items.map((i) => i.id)])).toEqual([
      ['收集', []],
      ['设计中', ['a']],
      ['开发中', ['b']],
      ['工作项', ['w']],
    ]);
    expect(boardColumns(list(items), null).map((c) => [c.label, c.items.map((i) => i.id)])).toEqual([
      ['未开始', ['a']],
      ['进行中', ['b']],
      ['工作项', ['w']],
    ]);
    const withBacklog = [...items, item({ id: 'k', stage: { key: 'collect', label: '收集', color: '#94a3b8', category: 'backlog' } })];
    expect(boardColumns(list(withBacklog), null).map((c) => c.label)).toEqual(['收集', '未开始', '进行中', '工作项']);
  });

  it('按产品经理：按姓名分组，没有负责人的排最后；组标题计数只算未完成的条目', () => {
    const zhang = { id: 'm2', displayName: '张三' };
    const li = { id: 'm1', displayName: '李四' };
    const groups = ownerGroups([
      item({ id: 'a', owner: zhang, paused: { at: '2026-10-01T00:00:00.000Z', reason: '等' } }),
      item({ id: 'b', owner: zhang, blockers: { count: 1, first: '等接口' }, aging: 'warn' }),
      item({ id: 'c', owner: zhang, done: true, aging: 'normal', blockers: { count: 1, first: '已完成的' } }),
      item({ id: 'd', owner: null }),
      item({ id: 'e', owner: li, aging: 'alert' }),
    ]);
    expect(groups.map((g) => [g.name, g.items.length, g.paused, g.blocked, g.aging])).toEqual([
      ['李四', 1, 0, 0, 1],
      ['张三', 3, 1, 1, 1],
      ['未指定负责人', 1, 0, 0, 0],
    ]);
  });
});
```

`apps/web/src/features/shell/nav.test.ts`：

1. 第一个用例里主导航期望列表在 `['需求', '/acme/requirements'],` 之后加 `['跟进', '/acme/tracking'],`；设置期望列表在 `'/acme/settings/dashboard',` 之后加 `'/acme/settings/tracking',`。
2. 第三个用例末尾加：

```ts
    expect(activeNavKey('/acme/tracking', 'acme')).toBe('work-tracking');
    expect(activeNavKey('/acme/work-items/W-3', 'acme')).toBe('work-tracking');
    expect(activeNavKey('/acme/settings/tracking', 'acme')).toBe('tracking');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run src/features/tracking/model.test.ts src/features/shell/nav.test.ts`
Expected: FAIL（找不到 `./model`；导航缺「跟进」）。

- [ ] **Step 3: 类型与查询**

`apps/web/src/lib/types.ts`：

1. `@flower/core` 的 `import type` 列表按字母顺序加入：

```ts
  ProgressView as CoreProgressView,
  RequirementTracking as CoreRequirementTracking,
  TrackingList as CoreTrackingList,
  TrackingSettings as CoreTrackingSettings,
  WorkItemDetail as CoreWorkItemDetail,
```

2. 文件末尾追加：

```ts
export type TrackingList = Jsonify<CoreTrackingList>;
export type TrackingItem = TrackingList['items'][number];
export type TrackingSettings = CoreTrackingSettings;
export type RequirementTracking = Jsonify<CoreRequirementTracking>;
export type WorkItemDetail = Jsonify<CoreWorkItemDetail>;
export type ProgressEntry = Jsonify<CoreProgressView>;
export type ProgressSubjectType = 'requirement' | 'work_item';
```

`apps/web/src/lib/queries.ts`：

1. `./types` 的 `import type` 列表加入 `ProgressEntry`、`ProgressSubjectType`、`TrackingList`、`TrackingSettings`、`WorkItemDetail`（按字母顺序）。
2. `qk` 里 `orgDashboard` 一行之后加：

```ts
  tracking: (o: string, query: string) => ['org', o, 'tracking', 'list', query] as const,
  trackingSettings: (o: string) => ['org', o, 'tracking', 'settings'] as const,
  workItem: (o: string, key: string) => ['org', o, 'tracking', 'work-item', key] as const,
  progress: (o: string, type: string, id: string) => ['org', o, 'tracking', 'progress', type, id] as const,
```

3. `useOrgDashboard` 之后加：

```ts
/** 跟进相关查询的公共前缀：需求跟进设置、工作项、进展记录、阈值变化后统一失效。 */
export const trackingKeys = (o: string) => ['org', o, 'tracking'] as const;

export const useTracking = (o: string, query: string) =>
  useQuery({
    queryKey: qk.tracking(o, query),
    queryFn: () => api<{ tracking: TrackingList }>(`/orgs/${o}/tracking${query ? `?${query}` : ''}`),
    select: (d) => d.tracking,
    placeholderData: keepPreviousData,
  });

export const useTrackingSettings = (o: string) =>
  useQuery({ queryKey: qk.trackingSettings(o), queryFn: () => api<{ settings: TrackingSettings }>(`/orgs/${o}/tracking-settings`), select: (d) => d.settings });

export const useWorkItem = (o: string, key: string) =>
  useQuery({ queryKey: qk.workItem(o, key), queryFn: () => api<{ workItem: WorkItemDetail }>(`/orgs/${o}/work-items/${encodeURIComponent(key)}`), select: (d) => d.workItem });

export const useProgress = (o: string, type: ProgressSubjectType, id: string | undefined) =>
  useQuery({
    queryKey: qk.progress(o, type, id ?? ''),
    queryFn: () => api<{ progress: ProgressEntry[] }>(`/orgs/${o}/${type === 'requirement' ? 'requirements' : 'work-items'}/${id}/progress`),
    select: (d) => d.progress,
    enabled: !!id,
  });
```

4. `useSubscription` 的签名改为 `(o: string, type: 'requirement' | 'document' | 'work_item', id: string | undefined)`。
5. `useMentionMembers` 整体替换为：

```ts
/** @ 补全与成员标签用的成员列表；productId 为 null 时取组织级（不关联产品的工作项），为 undefined 时不请求。 */
export const useMentionMembers = (o: string, productId: string | null | undefined) =>
  useQuery({
    queryKey: qk.mentionMembers(o, productId ?? 'org'),
    queryFn: () => api<{ members: MentionMember[] }>(productId ? `/orgs/${o}/products/${productId}/mention-members` : `/orgs/${o}/mention-members`),
    select: (d) => d.members,
    enabled: productId !== undefined,
    staleTime: 60_000,
  });
```

- [ ] **Step 4: 跟进纯逻辑**

新建 `apps/web/src/features/tracking/model.ts`：

```ts
import type { ProgressSubjectType, TrackingItem, TrackingList } from '@/lib/types';

export const TRACKING_TABS = ['all', 'aging', 'board', 'owners'] as const;
export type TrackingTab = (typeof TRACKING_TABS)[number];
export const TAB_LABELS: Record<TrackingTab, string> = { all: '全部在手', aging: '任务老化', board: '按阶段看板', owners: '按产品经理' };

export const WORK_ITEM_STATUS_LABELS = { active: '进行中', done: '已完成', canceled: '已取消' } as const;

export type TrackingFilter = { tab: TrackingTab; product: string | null; owner: string | null; type: string | null; paused: boolean; blocked: boolean; done: boolean };
export const DEFAULT_FILTER: TrackingFilter = { tab: 'all', product: null, owner: null, type: null, paused: false, blocked: false, done: false };

/** 地址栏 → 筛选。不认识的页签当作「全部在手」；产品、负责人、类型原样带给接口（格式不对由接口返回 400）。 */
export function filterFromParams(params: URLSearchParams): TrackingFilter {
  const tab = params.get('tab') ?? '';
  return {
    tab: (TRACKING_TABS as readonly string[]).includes(tab) ? (tab as TrackingTab) : 'all',
    product: params.get('product') || null,
    owner: params.get('owner') || null,
    type: params.get('type') || null,
    paused: params.get('paused') === '1',
    blocked: params.get('blocked') === '1',
    done: params.get('done') === '1',
  };
}

/** 接口查询串（不含页签）。 */
export function filterQuery(f: TrackingFilter): string {
  const p = new URLSearchParams();
  if (f.product) p.set('product', f.product);
  if (f.owner) p.set('owner', f.owner);
  if (f.type) p.set('type', f.type);
  if (f.paused) p.set('paused', '1');
  if (f.blocked) p.set('blocked', '1');
  if (f.done) p.set('done', '1');
  return p.toString();
}

/** 页面地址：页签为「全部在手」时不写 tab。 */
export function trackingHref(org: string, f: TrackingFilter): string {
  const p = new URLSearchParams(filterQuery(f));
  if (f.tab !== 'all') p.set('tab', f.tab);
  const q = p.toString();
  return `/${org}/tracking${q ? `?${q}` : ''}`;
}

/** 是否有筛选（页签不算）。 */
export const hasFilter = (f: TrackingFilter): boolean => !!(f.product || f.owner || f.type || f.paused || f.blocked || f.done);

export const itemHref = (org: string, i: Pick<TrackingItem, 'kind' | 'displayKey'>): string =>
  `/${org}/${i.kind === 'requirement' ? 'requirements' : 'work-items'}/${i.displayKey}`;

/** 写进展小窗的对象。canEditDate：能否顺手改预计日期（需求为预计上线，工作项为预计完成）。 */
export type ProgressTarget = { type: ProgressSubjectType; id: string; displayKey: string; title: string; expectedDate: string | null; canEditDate: boolean };

export const targetOf = (i: TrackingItem): ProgressTarget => ({
  type: i.kind,
  id: i.id,
  displayKey: i.displayKey,
  title: i.title,
  expectedDate: i.expectedDate,
  canEditDate: i.canEditDate,
});

const byKey = (a: TrackingItem, b: TrackingItem) => a.displayKey.localeCompare(b.displayKey, 'zh-CN', { numeric: true });

/** 任务老化：未完成的条目按本阶段停留天数降序（同天按编号）。 */
export function agingRows(items: TrackingItem[]): TrackingItem[] {
  return items.filter((i) => !i.done).sort((a, b) => b.stageDays - a.stageDays || byKey(a, b));
}

/** 超过阈值天数没有进展记录的条目（顺序同任务老化）。 */
export const staleRows = (items: TrackingItem[]): TrackingItem[] => agingRows(items).filter((i) => i.stale);

export type BoardColumn = { key: string; label: string; color: string | null; items: TrackingItem[] };

/**
 * 按阶段看板的列。选定产品时：该产品流程中非已完成、已取消的状态各一列（按顺序）；
 * 全部产品时：按类别「收集」（有条目时才显示）、「未开始」「进行中」分列。最后一列「工作项」。已完成的条目不上看板。
 */
export function boardColumns(list: Pick<TrackingList, 'products' | 'items'>, productId: string | null): BoardColumn[] {
  const open = list.items.filter((i) => !i.done);
  const reqs = open.filter((i) => i.kind === 'requirement');
  const work: BoardColumn = { key: 'work-items', label: '工作项', color: null, items: open.filter((i) => i.kind === 'work_item') };
  const product = productId ? list.products.find((p) => p.id === productId) : undefined;
  if (product) {
    return [
      ...product.states
        .filter((s) => s.category !== 'completed' && s.category !== 'canceled')
        .map((s) => ({ key: s.key, label: s.label, color: s.color, items: reqs.filter((i) => i.stage.key === s.key) })),
      work,
    ];
  }
  const inCategory = (category: string) => reqs.filter((i) => i.stage.category === category);
  const backlog = inCategory('backlog');
  return [
    ...(backlog.length > 0 ? [{ key: 'backlog', label: '收集', color: null, items: backlog }] : []),
    { key: 'unstarted', label: '未开始', color: null, items: inCategory('unstarted') },
    { key: 'started', label: '进行中', color: null, items: inCategory('started') },
    work,
  ];
}

export type OwnerGroup = { id: string | null; name: string; items: TrackingItem[]; paused: number; blocked: number; aging: number };

/** 按负责人分组：按姓名排序，没有负责人的排最后；组标题的暂停、阻塞、老化数只算未完成的条目。 */
export function ownerGroups(items: TrackingItem[]): OwnerGroup[] {
  const map = new Map<string, OwnerGroup>();
  for (const i of items) {
    const key = i.owner?.id ?? '';
    let g = map.get(key);
    if (!g) {
      g = { id: i.owner?.id ?? null, name: i.owner?.displayName ?? '未指定负责人', items: [], paused: 0, blocked: 0, aging: 0 };
      map.set(key, g);
    }
    g.items.push(i);
    if (i.done) continue;
    if (i.paused) g.paused += 1;
    if (i.blockers.count > 0) g.blocked += 1;
    if (i.aging !== 'normal') g.aging += 1;
  }
  return [...map.values()].sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name, 'zh-CN')));
}

/** 停留天数的底色：超过标黄天数为黄，超过标红天数为红。 */
export const AGING_CLASS: Record<TrackingItem['aging'], string> = {
  normal: '',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  alert: 'bg-destructive/10 text-destructive',
};
export const AGING_LABEL: Record<TrackingItem['aging'], string> = { normal: '', warn: '超过标黄天数', alert: '超过标红天数' };
```

- [ ] **Step 5: 导航**

`apps/web/src/features/shell/nav.ts`：

1. `NavIcon` 加 `'checklist'`：

```ts
export type NavIcon = 'home' | 'grid' | 'list' | 'cycle' | 'review' | 'doc' | 'users' | 'tag' | 'box' | 'flow' | 'sliders' | 'bot' | 'building' | 'bell' | 'chart' | 'checklist';
```

2. `SETTINGS` 里 `['dashboard', '看板', 'chart'],` 之后加 `['tracking', '跟进', 'checklist'],`。
3. `main` 里 `{ key: 'requirements', … },` 之后加：

```ts
      { key: 'work-tracking', label: '跟进', href: `/${org}/tracking`, icon: 'checklist' },
```

4. `activeNavKey` 里 `if (/^\/dashboard(\/|$)/.test(rest)) return 'product-dashboard';` 之后加：

```ts
  // 主导航「跟进」与组织设置「跟进」（键 tracking）同名，主导航用另一个键；工作项详情也高亮「跟进」
  if (/^\/(tracking|work-items)(\/|$)/.test(rest)) return 'work-tracking';
```

`apps/web/src/components/org-shell.tsx`：`lucide-react` 导入加 `ListChecks`（按字母顺序放在 `List` 之后），`ICONS` 末尾加 `checklist: ListChecks,`。

- [ ] **Step 6: 共享组件支持不关联产品的工作项与工作项关注**

`apps/web/src/components/wikilink-textarea.tsx`：

1. `Props` 里 `productId` 的定义改为：

```ts
  /**
   * 来源所在产品：[[ 补全按它决定本产品优先与是否带产品前缀；@ 补全按它标出看不到该产品的成员。
   * 为 null 时（不关联产品的工作项）@ 取组织级成员（访客标为看不到）。
   */
  productId: string | null;
  /** 是否做 [[ ]] 补全，默认 true；工作项描述传 false（工作项不支持双链）。productId 为 null 时也不做。 */
  links?: boolean;
```

2. 函数参数解构里 `productId,` 之后加 `links = true,`，即：

```ts
export function WikilinkTextarea({ org, productId, links = true, value, onValueChange, onOpenChange, onKeyDown, onBlur, className, ...rest }: Props) {
```

3. `const wiki = activeWikiQuery(value, caret);` 改为：

```ts
  const wiki = links && productId ? activeWikiQuery(value, caret) : null;
```

4. `const search = useLinkSearch(org, productId, debouncedQuery, open && wiki !== null);` 改为：

```ts
  const search = useLinkSearch(org, productId ?? '', debouncedQuery, open && wiki !== null);
```

`apps/web/src/components/wiki-text.tsx` 的 `WikiText`：

1. 文档注释改为 `/** 纯文本（需求描述、评论、工作项描述）的显示：[[ ]] 渲染为链接卡，@ 渲染为成员标签，其余原样（保留换行）。links 为 false 或 productId 为 null 时 [[ ]] 按原文显示。 */`
2. 参数解构在 `productId,` 之后加 `links = true,`；参数类型里 `productId: string;` 改为：

```ts
  /** 正文所在产品：用来取成员的当前姓名与能否看到该产品；null 为组织级（不关联产品的工作项）。 */
  productId: string | null;
  /** 是否把 [[ ]] 渲染为链接卡，默认 true；工作项描述传 false。 */
  links?: boolean;
```

3. 渲染里的链接分支：

```tsx
        ) : s.kind === 'link' ? (
          <LinkChip key={i} org={org} card={cardFor(cards, s.link.target, productKey)} target={s.link.target} label={s.link.label} />
```

改为：

```tsx
        ) : s.kind === 'link' ? (
          !links || productId === null ? (
            <Fragment key={i}>{s.link.raw}</Fragment>
          ) : (
            <LinkChip key={i} org={org} card={cardFor(cards, s.link.target, productKey)} target={s.link.target} label={s.link.label} />
          )
```

`apps/web/src/components/follow-button.tsx`：

1. 注释与签名改为：

```tsx
/** 需求、PRD、工作项详情的关注按钮：已关注时悬停说明原因，再点取消关注。 */
export function FollowButton({ org, type, id }: { org: string; type: 'requirement' | 'document' | 'work_item'; id: string }) {
```

2. `title={…}` 改为：

```tsx
      title={s.following ? (s.reason ?? '已关注') : type === 'work_item' ? '关注后，新的进展记录会通知你' : '关注后，状态、优先级、迭代变化与新评论会通知你'}
```

`apps/web/src/features/member-notifications/use-mark-read.ts`：注释里的「需求、PRD 或任务详情」改为「需求、PRD、任务或工作项详情」，签名中的 `subjectType: 'requirement' | 'document' | 'task'` 改为 `subjectType: 'requirement' | 'document' | 'task' | 'work_item'`。

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run src/features/tracking/model.test.ts src/features/shell/nav.test.ts && pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: PASS；lint 零错误零警告；typecheck 无错误。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/features/tracking/model.ts apps/web/src/features/tracking/model.test.ts apps/web/src/features/shell apps/web/src/components/org-shell.tsx apps/web/src/components/wikilink-textarea.tsx apps/web/src/components/wiki-text.tsx apps/web/src/components/follow-button.tsx apps/web/src/features/member-notifications/use-mark-read.ts
git commit -m "feat(web): 跟进的数据层与纯逻辑、导航「跟进」，共享组件支持工作项

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 跟进页：筛选、四个页签、写进展与新建工作项

**Files:**
- Create: `apps/web/src/features/tracking/components/item-bits.tsx`、`progress-dialog.tsx`、`work-item-dialog.tsx`、`filter-bar.tsx`、`all-table.tsx`、`aging-view.tsx`、`board-view.tsx`、`owner-groups.tsx`（均在 `apps/web/src/features/tracking/components/` 下）、`apps/web/src/app/(app)/[org]/tracking/page.tsx`

**Interfaces:**
- Consumes: Task 11 的 `useTracking`、`trackingKeys`、`qk.workbench`、`requirementKeys`、`useMembers`、`useOrg`、`useFields`、`TAB_LABELS`、`TRACKING_TABS`、`filterFromParams`、`filterQuery`、`trackingHref`、`hasFilter`、`itemHref`、`agingRows`、`staleRows`、`boardColumns`、`ownerGroups`、`AGING_CLASS`、`AGING_LABEL`、`targetOf`、`ProgressTarget`、`DEFAULT_FILTER`；共享件 `PageHeader`、`EmptyState`、`QueryError`、`FormError`、`MemberPicker`、`Table`、`Select`、`Tabs`、`Dialog`、`Checkbox`、`Badge`；`activePeople`、`canListMembers`、`pickerOptions`、`formatDate`
- Produces（组件，后续任务复用）:
  - `item-bits.tsx`：`AgingDays({ item })`、`StageLabel({ item })`、`LatestProgress({ item })`、`WriteButton({ item, onWrite })`（无权限时不渲染；`aria-label` 为「写进展：编号」）
  - `progress-dialog.tsx`：`WriteProgressDialog({ org, target: ProgressTarget | null, defaultFollower: string | null, onOpenChange, onSaved(follower) })`（对话框名「写进展」，字段「进展」「下一步」「跟进人」与「预计上线日期」或「预计完成日期」，按钮「保存」，成功提示「已记录进展」）
  - `work-item-dialog.tsx`：`CreateWorkItemDialog({ org, products, open, onOpenChange })`（对话框名「新建工作项」，字段「标题」「工作类型」「负责人」「关联产品」「启动日期」「预计完成日期」，按钮「创建」，成功提示「已创建 W-n」）
  - `filter-bar.tsx`：`TrackingFilterBar({ list, filter, onChange })`（下拉「产品」「负责人」「类型」，复选「只看暂停」「只看有阻塞」「含最近 30 天完成」，按钮「清除筛选」）
  - `all-table.tsx`：`AllTable`（表格名「全部在手」）；`aging-view.tsx`：`AgingView`（区块「按本阶段停留排序」「超过 N 天没有进展记录」）；`board-view.tsx`：`BoardView`（每列一个区块，名称为列名；卡片 `article` 名称为「编号 标题」）；`owner-groups.tsx`：`OwnerGroups`（每人一个区块，名称为姓名）
  - 页面 `/{org}/tracking`：页签「全部在手」「任务老化」「按阶段看板」「按产品经理」写入地址栏 `tab`；筛选写入地址栏；无结果时「没有符合条件的条目」与「清除筛选」；接口 400 时「筛选参数无效」与「清除筛选」；右上角「新建工作项」（访客不显示）

- [ ] **Step 1: 条目上的小部件**

新建 `apps/web/src/features/tracking/components/item-bits.tsx`：

```tsx
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AGING_CLASS, AGING_LABEL } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 本阶段停留天数：超过阈值时标黄或标红（暂停中不标色）。 */
export function AgingDays({ item }: { item: TrackingItem }) {
  return (
    <span className={cn('inline-block whitespace-nowrap rounded-sm px-1.5 font-mono', AGING_CLASS[item.aging])} title={AGING_LABEL[item.aging] || undefined}>
      {item.stageDays} 天
    </span>
  );
}

/** 当前阶段：颜色点与名称；暂停时加「已暂停」标签，悬停显示原因。 */
export function StageLabel({ item }: { item: TrackingItem }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="size-2 shrink-0 rounded-full" style={{ background: item.stage.color }} aria-hidden="true" />
      {item.stage.label}
      {item.paused && (
        <Badge variant="outline" title={item.paused.reason}>
          已暂停
        </Badge>
      )}
    </span>
  );
}

/** 最新进展 · 下一步 · 跟进人：一行，超出截断，悬停看全文。 */
export function LatestProgress({ item }: { item: TrackingItem }) {
  const l = item.latest;
  if (!l) return <span className="text-muted-foreground">没有进展记录</span>;
  const full = [l.body, l.nextStep && `下一步：${l.nextStep}`, l.follower && `跟进人：${l.follower.displayName}`].filter(Boolean).join(' · ');
  return (
    <span className="block max-w-80 truncate" title={full}>
      {l.body}
      {l.nextStep && <span className="text-muted-foreground"> · 下一步：{l.nextStep}</span>}
      {l.follower && <span className="text-muted-foreground"> · {l.follower.displayName}</span>}
    </span>
  );
}

/** 「写进展」：只对能写的条目显示。 */
export function WriteButton({ item, onWrite }: { item: TrackingItem; onWrite: (item: TrackingItem) => void }) {
  if (!item.canWrite) return null;
  return (
    <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={`写进展：${item.displayKey}`} onClick={() => onWrite(item)}>
      写进展
    </Button>
  );
}
```

- [ ] **Step 2: 写进展小窗**

新建 `apps/web/src/features/tracking/components/progress-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import type { ProgressTarget } from '@/features/tracking/model';
import { api } from '@/lib/api';
import { qk, requirementKeys, trackingKeys, useApiMutation, useMembers, useOrg } from '@/lib/queries';
import type { ProgressEntry } from '@/lib/types';

function ProgressForm({ org, target, defaultFollower, onDone }: { org: string; target: ProgressTarget; defaultFollower: string | null; onDone: (follower: string | null) => void }) {
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const [body, setBody] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [follower, setFollower] = useState<string | null>(defaultFollower);
  const [expected, setExpected] = useState(target.expectedDate ?? '');
  const base = target.type === 'requirement' ? 'requirements' : 'work-items';
  const dateChanged = target.canEditDate && expected !== (target.expectedDate ?? '');
  const save = useApiMutation(
    () =>
      api<{ progress: ProgressEntry }>(`/orgs/${org}/${base}/${target.id}/progress`, {
        method: 'POST',
        body: { body, nextStep: nextStep.trim() || null, followerMemberId: follower, ...(dateChanged ? { expectedDate: expected || null } : {}) },
      }),
    { invalidate: [trackingKeys(org), requirementKeys(org), qk.workbench], silentError: true, success: '已记录进展', onSuccess: () => onDone(follower) },
  );
  const people = activePeople(members.data ?? []);
  const dateLabel = target.type === 'requirement' ? '预计上线日期' : '预计完成日期';

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="progress-body">进展</Label>
        <Textarea id="progress-body" autoFocus maxLength={2000} className="min-h-24 text-[13px]" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="progress-next">下一步</Label>
        <Input id="progress-next" maxLength={500} value={nextStep} onChange={(e) => setNextStep(e.target.value)} />
      </div>
      {people.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>跟进人</Label>
          <MemberPicker label="跟进人" className="w-full" noneLabel="不指定" options={pickerOptions(people, null)} value={follower} onChange={setFollower} modal />
        </div>
      )}
      {target.canEditDate && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="progress-date">{dateLabel}</Label>
          <Input id="progress-date" type="date" className="w-44" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
      )}
      <FormError error={save.error} />
      <DialogFooter>
        <Button type="submit" disabled={!body.trim() || save.isPending}>
          保存
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * 写进展的小窗：进展、下一步、跟进人，可以顺手改预计日期。
 * 连续填写时由调用方把上一次选择的跟进人传回 defaultFollower；每次打开都重新挂载表单，进展与下一步从空开始。
 */
export function WriteProgressDialog({
  org,
  target,
  defaultFollower,
  onOpenChange,
  onSaved,
}: {
  org: string;
  target: ProgressTarget | null;
  defaultFollower: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (follower: string | null) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>写进展</DialogTitle>
          <DialogDescription>{target ? `${target.displayKey} ${target.title}` : ''}</DialogDescription>
        </DialogHeader>
        {target && (
          <ProgressForm
            key={target.id}
            org={org}
            target={target}
            defaultFollower={defaultFollower}
            onDone={(follower) => {
              onSaved(follower);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: 新建工作项小窗**

新建 `apps/web/src/features/tracking/components/work-item-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { api } from '@/lib/api';
import { qk, trackingKeys, useApiMutation, useFields, useMembers, useOrg } from '@/lib/queries';
import type { WorkItemDetail } from '@/lib/types';

const NONE = '__none';

function WorkItemForm({ org, products, onDone }: { org: string; products: Array<{ id: string; name: string }>; onDone: () => void }) {
  const orgQ = useOrg(org);
  const canList = canListMembers(orgQ.data?.me);
  const members = useMembers(org, canList);
  const fields = useFields(org, undefined, canList);
  const [title, setTitle] = useState('');
  const [workType, setWorkType] = useState(NONE);
  const [owner, setOwner] = useState<string | null>(orgQ.data?.me.memberId ?? null);
  const [product, setProduct] = useState(NONE);
  const [startedOn, setStartedOn] = useState('');
  const [expected, setExpected] = useState('');
  const create = useApiMutation(
    () =>
      api<{ workItem: WorkItemDetail }>(`/orgs/${org}/work-items`, {
        method: 'POST',
        body: {
          title,
          workTypeOptionId: workType === NONE ? null : workType,
          ownerMemberId: owner,
          productId: product === NONE ? null : product,
          startedOn: startedOn || null,
          expectedDate: expected || null,
        },
      }),
    {
      invalidate: [trackingKeys(org), qk.workbench],
      silentError: true,
      onSuccess: (d) => {
        toast.success(`已创建 ${d.workItem.displayKey}`);
        onDone();
      },
    },
  );
  const workTypeField = fields.data?.find((f) => f.key === 'work_type');
  const people = activePeople(members.data ?? []);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wi-title">标题</Label>
        <Input id="wi-title" autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-4">
        {workTypeField && (
          <div className="flex flex-col gap-1.5">
            <Label>工作类型</Label>
            <Select value={workType} onValueChange={setWorkType}>
              <SelectTrigger className="w-36" aria-label="工作类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>不填</SelectItem>
                {workTypeField.options
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
        <div className="flex flex-col gap-1.5">
          <Label>关联产品</Label>
          <Select value={product} onValueChange={setProduct}>
            <SelectTrigger className="w-40" aria-label="关联产品">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不关联产品</SelectItem>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {people.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>负责人</Label>
          <MemberPicker label="负责人" className="w-full" noneLabel="不指定" options={pickerOptions(people, null)} value={owner} onChange={setOwner} modal />
        </div>
      )}
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wi-start">启动日期</Label>
          <Input id="wi-start" type="date" className="w-44" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wi-expected">预计完成日期</Label>
          <Input id="wi-expected" type="date" className="w-44" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
      </div>
      <FormError error={create.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" disabled={!title.trim() || create.isPending}>
          创建
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 新建工作项：标题、工作类型、负责人（默认自己）、可选产品、启动日期、预计完成日期。 */
export function CreateWorkItemDialog({
  org,
  products,
  open,
  onOpenChange,
}: {
  org: string;
  products: Array<{ id: string; name: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建工作项</DialogTitle>
        </DialogHeader>
        {open && <WorkItemForm org={org} products={products} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 筛选栏**

新建 `apps/web/src/features/tracking/components/filter-bar.tsx`：

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DEFAULT_FILTER, hasFilter, type TrackingFilter } from '@/features/tracking/model';
import type { TrackingList } from '@/lib/types';

const ALL = '__all';

/**
 * 跟进页的筛选：产品、负责人、类型、只看暂停、只看有阻塞、含最近 30 天完成。
 * 地址栏里的值不在候选里（产品看不到或已删除、负责人已不在列表、类型选项不存在）时，仍显示为一项占位，方便看清并清除。
 */
export function TrackingFilterBar({ list, filter, onChange }: { list: TrackingList; filter: TrackingFilter; onChange: (f: TrackingFilter) => void }) {
  const set = (patch: Partial<TrackingFilter>) => onChange({ ...filter, ...patch });
  const toggle = (key: 'paused' | 'blocked' | 'done', on: boolean) =>
    set(key === 'paused' ? { paused: on } : key === 'blocked' ? { blocked: on } : { done: on });
  const productMissing = !!filter.product && !list.products.some((p) => p.id === filter.product);
  const ownerMissing = !!filter.owner && !list.owners.some((o) => o.id === filter.owner);
  const typeMissing = !!filter.type && !list.typeOptions.some((o) => o.id === filter.type);
  const flags: Array<['paused' | 'blocked' | 'done', string]> = [
    ['paused', '只看暂停'],
    ['blocked', '只看有阻塞'],
    ['done', '含最近 30 天完成'],
  ];

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2 text-[13px]">
      <Select value={filter.product ?? ALL} onValueChange={(v) => set({ product: v === ALL ? null : v })}>
        <SelectTrigger className="h-8 w-40" aria-label="产品">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部产品</SelectItem>
          {list.products.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
          {productMissing && <SelectItem value={filter.product!}>（看不到的产品）</SelectItem>}
        </SelectContent>
      </Select>
      <Select value={filter.owner ?? ALL} onValueChange={(v) => set({ owner: v === ALL ? null : v })}>
        <SelectTrigger className="h-8 w-36" aria-label="负责人">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部负责人</SelectItem>
          {list.owners.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.displayName}
            </SelectItem>
          ))}
          {ownerMissing && <SelectItem value={filter.owner!}>（已不在列表中的负责人）</SelectItem>}
        </SelectContent>
      </Select>
      <Select value={filter.type ?? ALL} onValueChange={(v) => set({ type: v === ALL ? null : v })}>
        <SelectTrigger className="h-8 w-36" aria-label="类型">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部类型</SelectItem>
          {list.typeOptions.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
          {typeMissing && <SelectItem value={filter.type!}>（已不存在的类型）</SelectItem>}
        </SelectContent>
      </Select>
      {flags.map(([key, label]) => (
        <label key={key} className="flex items-center gap-1.5">
          <Checkbox checked={filter[key]} onCheckedChange={(v) => toggle(key, v === true)} />
          {label}
        </label>
      ))}
      {hasFilter(filter) && (
        <Button variant="ghost" size="sm" className="h-8" onClick={() => onChange({ ...DEFAULT_FILTER, tab: filter.tab })}>
          清除筛选
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 全部在手表格**

新建 `apps/web/src/features/tracking/components/all-table.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { itemHref } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { AgingDays, LatestProgress, StageLabel, WriteButton } from './item-bits';

const dash = (v: string | null | undefined): string => v || '—';

/** 全部在手：每条一行。表格在自己的容器里横向滚动，标题列固定在左侧。 */
export function AllTable({ org, items, onWrite }: { org: string; items: TrackingItem[]; onWrite: (item: TrackingItem) => void }) {
  return (
    <div className="min-w-0 rounded-md border bg-card">
      <Table aria-label="全部在手" className="text-[13px]">
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-20">编号</TableHead>
            <TableHead className="sticky left-0 z-10 min-w-56 bg-card">标题</TableHead>
            <TableHead>负责人</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>当前阶段</TableHead>
            <TableHead>本阶段停留</TableHead>
            <TableHead>优先级</TableHead>
            <TableHead>启动日期</TableHead>
            <TableHead>进入当前阶段</TableHead>
            <TableHead>阻塞/风险</TableHead>
            <TableHead>最新进展 · 下一步 · 跟进人</TableHead>
            <TableHead>预计上线</TableHead>
            <TableHead>实际上线</TableHead>
            <TableHead>在制时长</TableHead>
            <TableHead>
              <span className="sr-only">操作</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((i) => (
            <TableRow key={i.id} className="group h-10 even:bg-zebra">
              <TableCell className="font-mono text-xs text-muted-foreground">{i.displayKey}</TableCell>
              <TableCell className="sticky left-0 z-10 max-w-72 bg-card group-even:bg-zebra">
                <Link href={itemHref(org, i)} className="block truncate hover:underline">
                  {i.title}
                </Link>
              </TableCell>
              <TableCell className="whitespace-nowrap">{dash(i.owner?.displayName)}</TableCell>
              <TableCell className="whitespace-nowrap">{dash(i.type?.label)}</TableCell>
              <TableCell>
                <StageLabel item={i} />
              </TableCell>
              <TableCell>
                <AgingDays item={i} />
              </TableCell>
              <TableCell>{dash(i.priority?.label)}</TableCell>
              <TableCell className="font-mono text-xs">{i.startedOn}</TableCell>
              <TableCell className="font-mono text-xs">{i.stageEnteredOn}</TableCell>
              <TableCell className="max-w-48">
                {i.blockers.count > 0 ? (
                  <span className="block truncate" title={i.blockers.first ?? undefined}>
                    <span className="font-mono text-destructive">{i.blockers.count}</span> {i.blockers.first}
                  </span>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell>
                <LatestProgress item={i} />
              </TableCell>
              <TableCell className="font-mono text-xs">{dash(i.expectedDate)}</TableCell>
              <TableCell className="font-mono text-xs">{dash(i.doneOn)}</TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs">{i.wipDays} 天</TableCell>
              <TableCell>
                <WriteButton item={i} onWrite={onWrite} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 6: 任务老化**

新建 `apps/web/src/features/tracking/components/aging-view.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate } from '@/features/requirements/format';
import { agingRows, itemHref, staleRows } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { AgingDays, StageLabel, WriteButton } from './item-bits';

function ShortTable({ org, label, items, last, onWrite }: { org: string; label: string; items: TrackingItem[]; last: 'blockers' | 'latest'; onWrite: (item: TrackingItem) => void }) {
  return (
    <Table aria-label={label} className="text-[13px]">
      <TableHeader>
        <TableRow>
          <TableHead className="min-w-20">编号</TableHead>
          <TableHead className="sticky left-0 z-10 min-w-56 bg-card">标题</TableHead>
          <TableHead>负责人</TableHead>
          <TableHead>当前阶段</TableHead>
          <TableHead>本阶段停留</TableHead>
          <TableHead>{last === 'blockers' ? '阻塞/风险' : '最近进展'}</TableHead>
          <TableHead>
            <span className="sr-only">操作</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((i) => (
          <TableRow key={i.id} className="group h-10 even:bg-zebra">
            <TableCell className="font-mono text-xs text-muted-foreground">{i.displayKey}</TableCell>
            <TableCell className="sticky left-0 z-10 max-w-72 bg-card group-even:bg-zebra">
              <Link href={itemHref(org, i)} className="block truncate hover:underline">
                {i.title}
              </Link>
            </TableCell>
            <TableCell className="whitespace-nowrap">{i.owner?.displayName ?? '—'}</TableCell>
            <TableCell>
              <StageLabel item={i} />
            </TableCell>
            <TableCell>
              <AgingDays item={i} />
            </TableCell>
            <TableCell className="max-w-56 truncate">
              {last === 'blockers'
                ? i.blockers.count > 0
                  ? `${i.blockers.count} 条 · ${i.blockers.first}`
                  : '—'
                : i.latest
                  ? formatDate(i.latest.createdAt)
                  : '没有进展记录'}
            </TableCell>
            <TableCell>
              <WriteButton item={i} onWrite={onWrite} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** 任务老化：未完成的条目按本阶段停留降序（超过阈值标黄或标红）；下方单列超过阈值天数没有进展记录的条目。 */
export function AgingView({ org, items, staleDays, onWrite }: { org: string; items: TrackingItem[]; staleDays: number; onWrite: (item: TrackingItem) => void }) {
  const rows = agingRows(items);
  const stale = staleRows(items);
  const staleTitle = `超过 ${staleDays} 天没有进展记录`;
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="按本阶段停留排序" className="min-w-0 rounded-md border bg-card">
        <h2 className="border-b px-4 py-2.5 text-sm font-semibold">按本阶段停留排序</h2>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">没有未完成的条目</p>
        ) : (
          <ShortTable org={org} label="按本阶段停留排序" items={rows} last="blockers" onWrite={onWrite} />
        )}
      </section>
      <section aria-label={staleTitle} className="min-w-0 rounded-md border bg-card">
        <h2 className="flex items-center justify-between border-b px-4 py-2.5 text-sm font-semibold">
          {staleTitle}
          <span className="font-mono text-xs font-normal text-muted-foreground">{stale.length}</span>
        </h2>
        {stale.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">没有超过 {staleDays} 天没有进展的条目</p>
        ) : (
          <ShortTable org={org} label={staleTitle} items={stale} last="latest" onWrite={onWrite} />
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 7: 按阶段看板与按产品经理**

新建 `apps/web/src/features/tracking/components/board-view.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { boardColumns, itemHref } from '@/features/tracking/model';
import type { TrackingItem, TrackingList } from '@/lib/types';
import { AgingDays, WriteButton } from './item-bits';

/** 按阶段看板：只读，不能拖动。列在自己的容器里横向滚动。 */
export function BoardView({ org, list, productId, onWrite }: { org: string; list: TrackingList; productId: string | null; onWrite: (item: TrackingItem) => void }) {
  return (
    <div className="flex min-w-0 gap-3 overflow-x-auto pb-2">
      {boardColumns(list, productId).map((c) => (
        <section key={c.key} aria-label={c.label} className="flex w-64 shrink-0 flex-col gap-2 rounded-md border bg-muted/40 p-2">
          <h2 className="flex items-center gap-1.5 px-1 text-[13px] font-semibold">
            {c.color && <span className="size-2 rounded-full" style={{ background: c.color }} aria-hidden="true" />}
            {c.label}
            <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">{c.items.length}</span>
          </h2>
          {c.items.map((i) => (
            <article key={i.id} aria-label={`${i.displayKey} ${i.title}`} className="flex flex-col gap-1.5 rounded-md border bg-card p-2 text-[13px]">
              <Link href={itemHref(org, i)} className="line-clamp-2 hover:underline">
                {i.title}
              </Link>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-mono">{i.displayKey}</span>
                {i.owner && <span>{i.owner.displayName}</span>}
                <AgingDays item={i} />
                {i.paused && <Badge variant="outline">已暂停</Badge>}
                {i.blockers.count > 0 && <span className="text-destructive">阻塞 {i.blockers.count}</span>}
              </div>
              <div className="self-start">
                <WriteButton item={i} onWrite={onWrite} />
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
```

新建 `apps/web/src/features/tracking/components/owner-groups.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { itemHref, ownerGroups } from '@/features/tracking/model';
import type { TrackingItem } from '@/lib/types';
import { AgingDays, LatestProgress, StageLabel, WriteButton } from './item-bits';

/** 按产品经理：按负责人分组，组标题显示条数、暂停数、阻塞数、老化数；站会时按人逐个过。 */
export function OwnerGroups({ org, items, onWrite }: { org: string; items: TrackingItem[]; onWrite: (item: TrackingItem) => void }) {
  return (
    <div className="flex flex-col gap-4">
      {ownerGroups(items).map((g) => (
        <section key={g.id ?? 'none'} aria-label={g.name} className="min-w-0 rounded-md border bg-card">
          <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-sm font-semibold">
            {g.name}
            <span className="text-xs font-normal text-muted-foreground">
              {g.items.length} 条 · 暂停 {g.paused} · 阻塞 {g.blocked} · 老化 {g.aging}
            </span>
          </h2>
          <ul className="divide-y">
            {g.items.map((i) => (
              <li key={i.id} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-[13px]">
                <span className="font-mono text-xs text-muted-foreground">{i.displayKey}</span>
                <Link href={itemHref(org, i)} className="min-w-0 flex-1 truncate hover:underline">
                  {i.title}
                </Link>
                <StageLabel item={i} />
                <AgingDays item={i} />
                <span className="min-w-0 basis-full text-muted-foreground lg:basis-80">
                  <LatestProgress item={i} />
                </span>
                <WriteButton item={i} onWrite={onWrite} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: 跟进页**

新建 `apps/web/src/app/(app)/[org]/tracking/page.tsx`：

```tsx
'use client';

import { ListChecks } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AgingView } from '@/features/tracking/components/aging-view';
import { AllTable } from '@/features/tracking/components/all-table';
import { BoardView } from '@/features/tracking/components/board-view';
import { TrackingFilterBar } from '@/features/tracking/components/filter-bar';
import { OwnerGroups } from '@/features/tracking/components/owner-groups';
import { WriteProgressDialog } from '@/features/tracking/components/progress-dialog';
import { CreateWorkItemDialog } from '@/features/tracking/components/work-item-dialog';
import {
  DEFAULT_FILTER,
  filterFromParams,
  filterQuery,
  hasFilter,
  type ProgressTarget,
  TAB_LABELS,
  TRACKING_TABS,
  type TrackingFilter,
  type TrackingTab,
  targetOf,
  trackingHref,
} from '@/features/tracking/model';
import { ApiError } from '@/lib/api';
import { useOrg, useTracking } from '@/lib/queries';
import type { TrackingItem, TrackingList } from '@/lib/types';

function TabBody({ org, data, filter, onWrite }: { org: string; data: TrackingList; filter: TrackingFilter; onWrite: (item: TrackingItem) => void }) {
  if (filter.tab === 'aging') return <AgingView org={org} items={data.items} staleDays={data.settings.staleUpdateDays} onWrite={onWrite} />;
  if (filter.tab === 'board') return <BoardView org={org} list={data} productId={filter.product} onWrite={onWrite} />;
  if (filter.tab === 'owners') return <OwnerGroups org={org} items={data.items} onWrite={onWrite} />;
  return <AllTable org={org} items={data.items} onWrite={onWrite} />;
}

function TrackingPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const filter = filterFromParams(params);
  const q = useTracking(org, filterQuery(filter));
  const orgQ = useOrg(org);
  const [writing, setWriting] = useState<ProgressTarget | null>(null);
  const [lastFollower, setLastFollower] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const go = (f: TrackingFilter) => router.replace(trackingHref(org, f), { scroll: false });
  const onWrite = (i: TrackingItem) => setWriting(targetOf(i));
  const filtered = hasFilter(filter);

  let body: ReactNode;
  if (!q.data) {
    if (q.error instanceof ApiError && q.error.status === 400) {
      body = (
        <EmptyState
          icon={ListChecks}
          title="筛选参数无效"
          description="地址栏里的筛选条件格式不正确。"
          action={
            <Button variant="outline" onClick={() => go(DEFAULT_FILTER)}>
              清除筛选
            </Button>
          }
        />
      );
    } else if (q.isError) {
      body = <QueryError error={q.error} noAccessMessage="无法读取跟进列表。" retryMessage="加载跟进列表失败，请重试。" onRetry={() => q.refetch()} />;
    } else {
      body = <Skeleton className="h-64" />;
    }
  } else {
    const data = q.data;
    body = (
      <>
        <TrackingFilterBar list={data} filter={filter} onChange={go} />
        <Tabs value={filter.tab} onValueChange={(v) => go({ ...filter, tab: v as TrackingTab })}>
          <TabsList>
            {TRACKING_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={filter.tab} className="mt-2 min-w-0">
            {data.items.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title={filtered ? '没有符合条件的条目' : '还没有在手的工作'}
                description={filtered ? undefined : '需求进入设计阶段后会自动加入跟进；技术支持、协调对接等工作可以新建为工作项。'}
                action={
                  filtered ? (
                    <Button variant="outline" onClick={() => go({ ...DEFAULT_FILTER, tab: filter.tab })}>
                      清除筛选
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <TabBody org={org} data={data} filter={filter} onWrite={onWrite} />
            )}
          </TabsContent>
        </Tabs>
        <WriteProgressDialog
          org={org}
          target={writing}
          defaultFollower={lastFollower}
          onOpenChange={(open) => {
            if (!open) setWriting(null);
          }}
          onSaved={setLastFollower}
        />
        <CreateWorkItemDialog org={org} products={data.products} open={creating} onOpenChange={setCreating} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="跟进"
        description="跨产品查看在手的需求与工作项：本阶段停留、阻塞、最新进展与下一步。"
        actions={orgQ.data && orgQ.data.me.orgRole !== 'guest' ? <Button onClick={() => setCreating(true)}>新建工作项</Button> : undefined}
      />
      {body}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <TrackingPage />
    </Suspense>
  );
}
```

- [ ] **Step 9: 检查并提交**

Run: `pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: lint 零错误零警告；typecheck 无错误。（页面行为由 Task 16 的端到端测试覆盖。）

```bash
git add apps/web/src/features/tracking/components "apps/web/src/app/(app)/[org]/tracking/page.tsx"
git commit -m "feat(web): 跟进页（筛选、全部在手、任务老化、按阶段看板、按产品经理、写进展、新建工作项）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 需求详情：侧栏「跟进」区块与「进展记录」页签

**Files:**
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/tracking-panel.tsx`、`apps/web/src/features/tracking/components/progress-list.tsx`、`apps/web/src/features/tracking/components/pause-dialog.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`

**Interfaces:**
- Consumes: Task 4 的 `RequirementDetail.tracking`；Task 10 的需求跟进接口与进展记录接口；Task 11 的 `useProgress`、`trackingKeys`、`ProgressTarget`、`ProgressEntry`；Task 12 的 `WriteProgressDialog`；共享件 `ConfirmAction`、`FormError`、`QueryError`、`MemberPicker`、`Tabs`、`Dialog`
- Produces:
  - `PauseDialog({ open, onOpenChange, path, invalidate })`：对话框名「暂停」，字段「暂停原因」，按钮「确认暂停」，POST `${path}/pause`（需求与工作项共用）
  - `ProgressList({ org, target: ProgressTarget, canWrite: boolean })`：区块名「进展记录 N」，按钮「写进展」，每条有「修改」（作者本人）与「删除」（作者或管理员，确认后删除）；修改表单字段「修改进展」「修改下一步」「修改跟进人」
  - `TrackingPanel({ org, requirement })`：区块名「跟进」，状态文字（「跟进中（日期 起）」「已移出跟进」「已上线或已取消，不再显示为在手」「未加入跟进」），「已暂停：原因（日期 起）」，「预计上线日期」输入框（失去焦点时保存），按钮「加入跟进」「移出跟进」「暂停」「恢复」
  - 需求详情：侧栏「状态」之后加「跟进」区块；正文的「评论」改为页签「评论」「进展记录」（默认评论）

- [ ] **Step 1: 暂停小窗（需求与工作项共用）**

新建 `apps/web/src/features/tracking/components/pause-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/queries';

type Invalidate = ReadonlyArray<readonly unknown[]>;

function PauseForm({ path, invalidate, onDone }: { path: string; invalidate: Invalidate; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const pause = useApiMutation(() => api(`${path}/pause`, { method: 'POST', body: { reason } }), { invalidate, silentError: true, success: '已暂停', onSuccess: onDone });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        pause.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pause-reason">暂停原因</Label>
        <Textarea id="pause-reason" autoFocus maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <FormError error={pause.error} />
      <DialogFooter>
        <Button type="submit" disabled={!reason.trim() || pause.isPending}>
          确认暂停
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 暂停：填原因后 POST `${path}/pause`。path 为需求或工作项的接口路径（如 /orgs/acme/requirements/{id}）。 */
export function PauseDialog({ open, onOpenChange, path, invalidate }: { open: boolean; onOpenChange: (open: boolean) => void; path: string; invalidate: Invalidate }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>暂停</DialogTitle>
          <DialogDescription>暂停期间不计停留天数、不标老化，状态保持不变；恢复后接着算。</DialogDescription>
        </DialogHeader>
        {open && <PauseForm path={path} invalidate={invalidate} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 进展记录列表**

新建 `apps/web/src/features/tracking/components/progress-list.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { formatDateTime } from '@/features/requirements/format';
import type { ProgressTarget } from '@/features/tracking/model';
import { api } from '@/lib/api';
import { qk, trackingKeys, useApiMutation, useMembers, useOrg, useProgress } from '@/lib/queries';
import type { ProgressEntry } from '@/lib/types';
import { WriteProgressDialog } from './progress-dialog';

function EditForm({ org, entry, onDone }: { org: string; entry: ProgressEntry; onDone: () => void }) {
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const [body, setBody] = useState(entry.body);
  const [nextStep, setNextStep] = useState(entry.nextStep ?? '');
  const [follower, setFollower] = useState<string | null>(entry.follower?.id ?? null);
  const save = useApiMutation(
    () => api(`/orgs/${org}/progress/${entry.id}`, { method: 'PATCH', body: { body, nextStep: nextStep.trim() || null, followerMemberId: follower } }),
    { invalidate: [trackingKeys(org), qk.workbench], silentError: true, success: '已保存', onSuccess: onDone },
  );
  const people = activePeople(members.data ?? []);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <Textarea aria-label="修改进展" maxLength={2000} className="min-h-20 text-[13px]" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="修改下一步" placeholder="下一步" maxLength={500} className="h-8 min-w-0 flex-1" value={nextStep} onChange={(e) => setNextStep(e.target.value)} />
        {people.length > 0 && (
          <MemberPicker label="修改跟进人" className="h-8 w-36" noneLabel="不指定" options={pickerOptions(people, entry.follower)} value={follower} onChange={setFollower} />
        )}
      </div>
      <FormError error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={!body.trim() || save.isPending}>
          保存
        </Button>
      </div>
    </form>
  );
}

/** 进展记录：时间倒序；能写的人可以新增；作者本人可以修改；作者与管理员可以删除。需求详情与工作项详情共用。 */
export function ProgressList({ org, target, canWrite }: { org: string; target: ProgressTarget; canWrite: boolean }) {
  const q = useProgress(org, target.type, target.id);
  const [writing, setWriting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/progress/${id}`, { method: 'DELETE' }), { invalidate: [trackingKeys(org), qk.workbench], success: '已删除' });
  const entries = q.data ?? [];

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="progress-title">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="progress-title" className="text-sm font-semibold">
          进展记录 <span className="font-mono text-xs text-muted-foreground">{entries.length}</span>
        </h2>
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => setWriting(true)}>
            写进展
          </Button>
        )}
      </div>
      {q.isError ? (
        <QueryError error={q.error} noAccessMessage="无法读取进展记录。" retryMessage="加载进展记录失败，请重试。" onRetry={() => q.refetch()} />
      ) : entries.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有进展记录</p>
      ) : (
        <ul aria-label="进展记录列表" className="flex flex-col gap-3">
          {entries.map((p) => (
            <li key={p.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                <span className="font-medium text-foreground">{p.author?.displayName ?? '未知成员'}</span>
                <span>{formatDateTime(p.createdAt)}</span>
                {p.editedAt && <span>（已编辑）</span>}
                <span className="flex-1" />
                {p.canEdit && editing !== p.id && (
                  <button type="button" className="text-primary" onClick={() => setEditing(p.id)}>
                    修改
                  </button>
                )}
                {p.canDelete && (
                  <ConfirmAction
                    trigger={
                      <button type="button" className="text-destructive">
                        删除
                      </button>
                    }
                    title="删除这条进展？"
                    description="删除后不再显示在进展记录与跟进列表里。"
                    confirmLabel="删除"
                    destructive
                    onConfirm={() => remove.mutate(p.id)}
                  />
                )}
              </div>
              {editing === p.id ? (
                <EditForm org={org} entry={p} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-6">{p.body}</p>
                  {(p.nextStep || p.follower) && (
                    <p className="text-[13px] text-muted-foreground">
                      下一步：{p.nextStep ?? '—'}
                      {p.follower && ` · 跟进人：${p.follower.displayName}`}
                    </p>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <WriteProgressDialog org={org} target={writing ? target : null} defaultFollower={null} onOpenChange={setWriting} onSaved={() => undefined} />
    </section>
  );
}
```

- [ ] **Step 3: 需求的「跟进」区块**

新建 `apps/web/src/app/(app)/[org]/requirements/[key]/tracking-panel.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate } from '@/features/requirements/format';
import { PauseDialog } from '@/features/tracking/components/pause-dialog';
import { api } from '@/lib/api';
import { qk, requirementKeys, trackingKeys, useApiMutation } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

/** 需求详情侧栏「跟进」：加入 / 移出跟进、预计上线日期、暂停（填原因）/ 恢复。产品编辑及以上可以修改。 */
export function TrackingPanel({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const t = r.tracking;
  const canEdit = r.myRole !== 'viewer';
  const category = r.workflow.states.find((s) => s.key === r.stateKey)?.category ?? 'backlog';
  const closed = category === 'completed' || category === 'canceled';
  const [pausing, setPausing] = useState(false);
  const invalidate = [requirementKeys(org), trackingKeys(org), qk.workbench];
  const base = `/orgs/${org}/requirements/${r.id}`;
  const join = useApiMutation(() => api(`${base}/tracking`, { method: 'PUT', body: { tracking: true } }), { invalidate, success: '已加入跟进' });
  const leave = useApiMutation(() => api(`${base}/tracking`, { method: 'PUT', body: { tracking: false } }), { invalidate, success: '已移出跟进' });
  const date = useApiMutation((expectedDate: string | null) => api(`${base}/expected-date`, { method: 'PUT', body: { expectedDate } }), { invalidate, success: '已保存' });
  const resume = useApiMutation(() => api(`${base}/resume`, { method: 'POST' }), { invalidate, success: '已恢复' });
  const status = t.active
    ? `跟进中（${formatDate(t.trackedSince!)} 起）`
    : t.optedOut
      ? '已移出跟进'
      : t.trackedSince
        ? '已上线或已取消，不再显示为在手'
        : '未加入跟进';

  return (
    <section className="rounded-md border bg-card p-4 text-[13px]" aria-labelledby="tracking-title">
      <h2 id="tracking-title" className="mb-2 text-sm font-semibold">
        跟进
      </h2>
      <p>{status}</p>
      {t.paused && (
        <p className="mt-1 text-amber-800 dark:text-amber-300">
          已暂停：{t.paused.reason}（{formatDate(t.paused.at)} 起）
        </p>
      )}
      <div className="mt-3 flex flex-col gap-1.5">
        <Label htmlFor="tracking-expected">预计上线日期</Label>
        <Input
          id="tracking-expected"
          key={t.expectedDate ?? ''}
          type="date"
          className="h-8 w-44"
          defaultValue={t.expectedDate ?? ''}
          disabled={!canEdit || date.isPending}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== (t.expectedDate ?? '')) date.mutate(v || null);
          }}
        />
      </div>
      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!t.active && !closed && (
            <Button size="sm" variant="outline" disabled={join.isPending} onClick={() => join.mutate(undefined)}>
              加入跟进
            </Button>
          )}
          {t.active && (
            <ConfirmAction
              trigger={
                <Button size="sm" variant="outline">
                  移出跟进
                </Button>
              }
              title="移出跟进？"
              description="移出后不再显示在跟进列表里，之后状态变化也不会自动加入；可以随时手动加入。"
              confirmLabel="移出"
              onConfirm={() => leave.mutate(undefined)}
            />
          )}
          {t.active && !t.paused && (
            <Button size="sm" variant="outline" onClick={() => setPausing(true)}>
              暂停
            </Button>
          )}
          {t.paused && (
            <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate(undefined)}>
              恢复
            </Button>
          )}
        </div>
      )}
      <PauseDialog open={pausing} onOpenChange={setPausing} path={base} invalidate={invalidate} />
    </section>
  );
}
```

- [ ] **Step 4: 需求详情接入**

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：

1. 导入加：

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProgressList } from '@/features/tracking/components/progress-list';
import { TrackingPanel } from './tracking-panel';
```

2. 正文里的

```tsx
          <Comments org={org} requirementId={r.id} productId={r.productId} productKey={r.productKey} />
```

改为：

```tsx
          <Tabs defaultValue="comments">
            <TabsList>
              <TabsTrigger value="comments">评论</TabsTrigger>
              <TabsTrigger value="progress">进展记录</TabsTrigger>
            </TabsList>
            <TabsContent value="comments">
              <Comments org={org} requirementId={r.id} productId={r.productId} productKey={r.productKey} />
            </TabsContent>
            <TabsContent value="progress">
              <ProgressList
                org={org}
                target={{ type: 'requirement', id: r.id, displayKey: r.displayKey, title: r.title, expectedDate: r.tracking.expectedDate, canEditDate: canEdit }}
                canWrite={canEdit}
              />
            </TabsContent>
          </Tabs>
```

3. 侧栏 `<StatusPanel org={org} requirement={r} />` 之后加：

```tsx
          <TrackingPanel org={org} requirement={r} />
```

- [ ] **Step 5: 检查并提交**

Run: `pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: lint 零错误零警告；typecheck 无错误。（页面行为由 Task 16 覆盖；已有的需求详情、评论与 @ 端到端用例在 Task 16 一并回归。）

```bash
git add "apps/web/src/app/(app)/[org]/requirements/[key]/tracking-panel.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx" apps/web/src/features/tracking/components/progress-list.tsx apps/web/src/features/tracking/components/pause-dialog.tsx
git commit -m "feat(web): 需求详情的跟进区块与进展记录页签

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 工作项详情页

**Files:**
- Create: `apps/web/src/app/(app)/[org]/work-items/[key]/page.tsx`、`apps/web/src/app/(app)/[org]/work-items/[key]/blockers.tsx`

**Interfaces:**
- Consumes: Task 10 的工作项接口；Task 11 的 `useWorkItem`、`trackingKeys`、`WORK_ITEM_STATUS_LABELS`、`WorkItemDetail`，`WikilinkTextarea` / `WikiText` 的 `productId: null` 与 `links={false}`，`FollowButton type="work_item"`，`useMarkNotificationsRead(org, 'work_item', id)`；Task 13 的 `ProgressList`、`PauseDialog`；共享件 `PageHeader`、`EditableTitle`、`QueryError`、`ConfirmAction`、`MemberPicker`、`Select`、`FormError`；`useProducts`、`useFields`、`useMembers`、`useOrg`
- Produces: 页面 `/{org}/work-items/W-n`：面包屑「跟进 / W-n」，标题可改，右上「关注」；正文「描述」（编辑、@）、「进展记录」、「阻塞项」；侧栏「基本信息」：「状态」下拉（进行中、已完成、已取消）、「已暂停：原因」与「恢复」或「暂停」、「工作类型」、「负责人」、「关联产品」、「启动日期」、「预计完成日期」、创建信息、「删除工作项」（确认后回到跟进页）。没有修改权限的人只读

- [ ] **Step 1: 工作项上的阻塞项**

新建 `apps/web/src/app/(app)/[org]/work-items/[key]/blockers.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { formatDate } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { trackingKeys, useApiMutation, useMembers, useOrg } from '@/lib/queries';
import type { WorkItemDetail } from '@/lib/types';

/** 工作项上的阻塞项：能写进展的人可以新增与解除（与需求详情的阻塞项用法相同）。 */
export function WorkItemBlockers({ org, item: w }: { org: string; item: WorkItemDetail }) {
  const canEdit = w.access.progress;
  const orgQ = useOrg(org);
  const members = useMembers(org, canEdit && canListMembers(orgQ.data?.me));
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const invalidate = [trackingKeys(org)];
  const add = useApiMutation(() => api(`/orgs/${org}/work-items/${w.id}/blockers`, { method: 'POST', body: { description, ownerMemberId: owner } }), {
    invalidate,
    silentError: true,
    success: '已添加阻塞项',
    onSuccess: () => {
      setDescription('');
      setOwner(null);
    },
  });
  const resolve = useApiMutation((id: string) => api(`/orgs/${org}/blockers/${id}/resolve`, { method: 'POST' }), { invalidate, success: '已解除' });
  if (!canEdit && w.blockers.length === 0) return null;
  const active = w.blockers.filter((b) => b.status === 'active');
  const resolved = w.blockers.filter((b) => b.status === 'resolved');
  const people = activePeople(members.data ?? []);

  return (
    <section className="rounded-md border bg-card p-4" aria-label="阻塞项">
      <h2 className="mb-2 text-sm font-semibold">
        阻塞项
        {active.length > 0 && <span className="ml-2 text-destructive">{active.length}</span>}
      </h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {active.map((b) => (
          <li key={b.id} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {b.description}
              <span className="text-muted-foreground">
                {b.owner && ` · ${b.owner.displayName}`} · <span className="font-mono">{formatDate(b.createdAt)}</span>
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
                {b.resolvedAt && (
                  <>
                    {' · '}
                    <span className="font-mono">{formatDate(b.resolvedAt)}</span> 解除
                  </>
                )}
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
            <MemberPicker label="阻塞项负责人" className="h-8 w-32" noneLabel="无负责人" options={pickerOptions(people, null)} value={owner} onChange={setOwner} />
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

- [ ] **Step 2: 工作项详情页**

新建 `apps/web/src/app/(app)/[org]/work-items/[key]/page.tsx`：

```tsx
'use client';

import { useParams, useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { EditableTitle } from '@/components/editable-title';
import { FollowButton } from '@/components/follow-button';
import { QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { WikiText } from '@/components/wiki-text';
import { WikilinkTextarea } from '@/components/wikilink-textarea';
import { useMarkNotificationsRead } from '@/features/member-notifications/use-mark-read';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { formatDate, formatDateTime } from '@/features/requirements/format';
import { PauseDialog } from '@/features/tracking/components/pause-dialog';
import { ProgressList } from '@/features/tracking/components/progress-list';
import { WORK_ITEM_STATUS_LABELS } from '@/features/tracking/model';
import { api } from '@/lib/api';
import { qk, trackingKeys, useApiMutation, useFields, useMembers, useOrg, useProducts, useWorkItem } from '@/lib/queries';
import type { WorkItemDetail } from '@/lib/types';
import { WorkItemBlockers } from './blockers';

const NONE = '__none';
type Patch = { title?: string; description?: string; productId?: string | null; ownerMemberId?: string | null; workTypeOptionId?: string | null; startedOn?: string | null; expectedDate?: string | null };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function InfoPanel({ org, item: w }: { org: string; item: WorkItemDetail }) {
  const router = useRouter();
  const orgQ = useOrg(org);
  const edit = w.access.edit;
  const canList = canListMembers(orgQ.data?.me);
  const members = useMembers(org, edit && canList);
  const fields = useFields(org, undefined, edit && canList);
  const products = useProducts(org);
  const [pausing, setPausing] = useState(false);
  const invalidate = [trackingKeys(org), qk.workbench];
  const base = `/orgs/${org}/work-items/${w.id}`;
  const patch = useApiMutation((body: Patch) => api(base, { method: 'PATCH', body }), { invalidate, success: '已保存' });
  const status = useApiMutation((to: string) => api(`${base}/status`, { method: 'POST', body: { status: to } }), { invalidate, success: '已更新状态' });
  const resume = useApiMutation(() => api(`${base}/resume`, { method: 'POST' }), { invalidate, success: '已恢复' });
  const remove = useApiMutation(() => api(base, { method: 'DELETE' }), { invalidate, success: '已删除', onSuccess: () => router.push(`/${org}/tracking`) });
  const workType = fields.data?.find((f) => f.key === 'work_type');
  const people = activePeople(members.data ?? []);
  const dateInput = (label: string, key: 'startedOn' | 'expectedDate') => (
    <Input
      key={w[key] ?? ''}
      type="date"
      aria-label={label}
      className="h-8 w-44"
      defaultValue={w[key] ?? ''}
      disabled={!edit || patch.isPending}
      onBlur={(e) => {
        const v = e.target.value;
        if (v !== (w[key] ?? '')) patch.mutate(key === 'startedOn' ? { startedOn: v || null } : { expectedDate: v || null });
      }}
    />
  );

  return (
    <section aria-labelledby="info-title" className="flex flex-col gap-3 rounded-md border bg-card p-4 text-[13px]">
      <h2 id="info-title" className="text-sm font-semibold">
        基本信息
      </h2>
      <Field label="状态">
        <Select value={w.status} onValueChange={(v) => status.mutate(v)} disabled={!edit || status.isPending}>
          <SelectTrigger className="h-8 w-32" aria-label="状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(WORK_ITEM_STATUS_LABELS) as Array<keyof typeof WORK_ITEM_STATUS_LABELS>).map((s) => (
              <SelectItem key={s} value={s}>
                {WORK_ITEM_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {w.paused ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-amber-800 dark:text-amber-300">
            已暂停：{w.paused.reason}（{formatDate(w.paused.at)} 起）
          </span>
          {edit && (
            <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate(undefined)}>
              恢复
            </Button>
          )}
        </div>
      ) : (
        edit &&
        w.status === 'active' && (
          <Button size="sm" variant="outline" className="self-start" onClick={() => setPausing(true)}>
            暂停
          </Button>
        )
      )}
      <Field label="工作类型">
        {edit && workType ? (
          <Select value={w.workType?.id ?? NONE} onValueChange={(v) => patch.mutate({ workTypeOptionId: v === NONE ? null : v })}>
            <SelectTrigger className="h-8 w-36" aria-label="工作类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>未设置</SelectItem>
              {workType.options
                .filter((o) => o.active || o.id === w.workType?.id)
                .map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : (
          <span>{w.workType?.label ?? '未设置'}</span>
        )}
      </Field>
      <Field label="负责人">
        {edit && people.length > 0 ? (
          <MemberPicker label="负责人" className="h-8 w-full" noneLabel="无负责人" options={pickerOptions(people, w.owner)} value={w.owner?.id ?? null} onChange={(id) => patch.mutate({ ownerMemberId: id })} />
        ) : (
          <span>{w.owner?.displayName ?? '无负责人'}</span>
        )}
      </Field>
      <Field label="关联产品">
        {edit ? (
          <Select value={w.product?.id ?? NONE} onValueChange={(v) => patch.mutate({ productId: v === NONE ? null : v })}>
            <SelectTrigger className="h-8 w-40" aria-label="关联产品">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不关联产品</SelectItem>
              {(products.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
              {w.product && !(products.data ?? []).some((p) => p.id === w.product!.id) && <SelectItem value={w.product.id}>{w.product.name}</SelectItem>}
            </SelectContent>
          </Select>
        ) : (
          <span>{w.product?.name ?? '不关联产品'}</span>
        )}
      </Field>
      <Field label="启动日期">{dateInput('启动日期', 'startedOn')}</Field>
      <Field label="预计完成日期">{dateInput('预计完成日期', 'expectedDate')}</Field>
      <p className="text-xs text-muted-foreground">
        {w.createdBy?.displayName ?? '未知成员'} 创建于 {formatDateTime(w.createdAt)}
        {w.doneAt && ` · ${formatDate(w.doneAt)} 完成`}
      </p>
      {edit && (
        <ConfirmAction
          trigger={
            <Button size="sm" variant="ghost" className="self-start text-destructive">
              删除工作项
            </Button>
          }
          title={`删除 ${w.displayKey}？`}
          description="删除后不再出现在跟进列表与工作台里。"
          confirmLabel="删除"
          destructive
          onConfirm={() => remove.mutate(undefined)}
        />
      )}
      <PauseDialog open={pausing} onOpenChange={setPausing} path={base} invalidate={invalidate} />
    </section>
  );
}

export default function WorkItemPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const q = useWorkItem(org, decodeURIComponent(key));
  const w = q.data;
  useMarkNotificationsRead(org, 'work_item', w?.id);
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState('');
  const patch = useApiMutation((body: Patch) => api(`/orgs/${org}/work-items/${w!.id}`, { method: 'PATCH', body }), {
    invalidate: [trackingKeys(org), qk.workbench],
    success: '已保存',
  });

  if (!w && q.isError) {
    return <QueryError error={q.error} noAccessMessage="工作项不存在，或你没有查看它的权限。" retryMessage="加载工作项失败，请重试。" onRetry={() => q.refetch()} />;
  }
  if (!w) return <Skeleton className="h-64" />;

  return (
    <>
      <PageHeader
        crumbs={[{ label: '跟进', href: `/${org}/tracking` }, { label: w.displayKey }]}
        title={<EditableTitle displayKey={w.displayKey} title={w.title} canEdit={w.access.edit} onSubmit={(title, close) => patch.mutate({ title }, { onSuccess: close })} />}
        actions={<FollowButton org={org} type="work_item" id={w.id} />}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-md border bg-card p-4" aria-labelledby="desc-title">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="desc-title" className="text-sm font-semibold">
                描述
              </h2>
              {w.access.edit && !editingDesc && (
                <button
                  type="button"
                  className="text-[13px] text-primary"
                  onClick={() => {
                    setDescription(w.description);
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
                <WikilinkTextarea
                  org={org}
                  productId={w.product?.id ?? null}
                  links={false}
                  aria-label="描述"
                  className="min-h-32 text-[13px]"
                  value={description}
                  onValueChange={setDescription}
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingDesc(false)}>
                    取消
                  </Button>
                  <Button type="submit" size="sm" disabled={patch.isPending}>
                    保存
                  </Button>
                </div>
              </form>
            ) : w.description ? (
              <WikiText org={org} text={w.description} cards={[]} productKey={w.product?.key ?? ''} productId={w.product?.id ?? null} links={false} className="text-[13px] leading-6" />
            ) : (
              <p className="text-[13px] leading-6 text-muted-foreground">暂无描述</p>
            )}
          </section>
          <ProgressList
            org={org}
            target={{ type: 'work_item', id: w.id, displayKey: w.displayKey, title: w.title, expectedDate: w.expectedDate, canEditDate: w.access.edit }}
            canWrite={w.access.progress}
          />
          <WorkItemBlockers org={org} item={w} />
        </div>
        <div className="flex flex-col gap-4">
          <InfoPanel org={org} item={w} />
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: 检查并提交**

Run: `pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: lint 零错误零警告；typecheck 无错误。（页面行为由 Task 16 的 `work-items.spec.ts` 覆盖。）

```bash
git add "apps/web/src/app/(app)/[org]/work-items"
git commit -m "feat(web): 工作项详情页（描述与 @、状态、暂停与恢复、进展记录、阻塞项、关注、删除）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 工作台两个区块、组织设置「跟进」、字段字典与流程编辑器区分作用对象

**Files:**
- Create: `apps/web/src/app/(app)/[org]/settings/tracking/page.tsx`
- Modify: `apps/web/src/app/(app)/[org]/page.tsx`、`apps/web/src/features/workbench/model.ts`、`apps/web/src/features/workbench/model.test.ts`、`apps/web/src/components/field-card.tsx`、`apps/web/src/app/(app)/[org]/settings/workflows/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 9 的 `Workbench.owned.items[].kind`、`Workbench.following`；Task 10 的 `/tracking-settings`；Task 11 的 `useTrackingSettings`、`trackingKeys`、导航键 `tracking`；Task 3 的 `FieldView.appliesTo`
- Produces:
  - `features/workbench/model.ts`：`subjectHref(x: { org: { slug: string }; kind: 'requirement' | 'work_item'; displayKey: string }): string`
  - 工作台：区块「我负责的需求与工作项」（工作项行链接到工作项详情）与新区块「等我跟进」（编号、标题、下一步；空时「没有等你跟进的条目」）
  - 组织设置「跟进」（`/{org}/settings/tracking`，仅组织管理员）：输入框「标黄：本阶段停留超过（天）」「标红：本阶段停留超过（天）」「无进展：超过（天）没有进展记录」，按钮「保存」，错误在表单内显示
  - 字段字典：工作项字段显示「作用于工作项」；流程编辑器的条件只列作用于需求的字段

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/workbench/model.test.ts`：导入改为

```ts
import { requirementHref, showOrgBadge, signatureHref, subjectHref, taskHref, unreadHref } from './model';
```

`describe('工作台链接', …)` 末尾加：

```ts
  it('我负责的与等我跟进：需求去需求详情，工作项去工作项详情', () => {
    expect(subjectHref({ org, kind: 'requirement', displayKey: 'PAN-3' })).toBe('/acme/requirements/PAN-3');
    expect(subjectHref({ org, kind: 'work_item', displayKey: 'W-2' })).toBe('/acme/work-items/W-2');
  });
```

Run: `pnpm --filter @flower/web exec vitest run src/features/workbench/model.test.ts`
Expected: FAIL（`subjectHref` 不存在）。

- [ ] **Step 2: 工作台**

`apps/web/src/features/workbench/model.ts` 在 `requirementHref` 之后加：

```ts
/** 「我负责的」与「等我跟进」的一行：需求去需求详情，工作项去工作项详情。 */
export function subjectHref(x: { org: Pick<Org, 'slug'>; kind: 'requirement' | 'work_item'; displayKey: string }): string {
  return x.kind === 'work_item' ? `/${x.org.slug}/work-items/${x.displayKey}` : requirementHref(x.org, x.displayKey);
}
```

`apps/web/src/app/(app)/[org]/page.tsx`：

1. `@/features/workbench/model` 的导入改为：

```tsx
import { showOrgBadge, signatureHref, subjectHref, taskHref, unreadHref } from '@/features/workbench/model';
```

2. 「我负责的需求」区块整体替换为（后面紧跟新区块「等我跟进」）：

```tsx
      <Section title="我负责的需求与工作项" total={data.owned.total} shown={data.owned.items.length} empty="没有进行中的需求与工作项">
        {data.owned.items.map((r) => (
          <li key={r.id}>
            <Link href={subjectHref(r)} className={ROW}>
              <OrgBadge show={badge} name={r.org.name} />
              <span className="font-mono text-muted-foreground">{r.displayKey}</span>
              <span className="flex-1 truncate">{r.title}</span>
              <span className="text-xs" style={{ color: r.state.color }}>
                {r.state.label}
              </span>
            </Link>
          </li>
        ))}
      </Section>
      <Section title="等我跟进" total={data.following.total} shown={data.following.items.length} empty="没有等你跟进的条目">
        {data.following.items.map((f) => (
          <li key={f.id}>
            <Link href={subjectHref(f)} className={ROW}>
              <OrgBadge show={badge} name={f.org.name} />
              <span className="font-mono text-muted-foreground">{f.displayKey}</span>
              <span className="flex-1 truncate">{f.title}</span>
              {f.nextStep && <span className="max-w-48 truncate text-xs text-muted-foreground">{f.nextStep}</span>}
            </Link>
          </li>
        ))}
      </Section>
```

3. `PageHeader` 的说明改为：

```tsx
      <PageHeader title="工作台" description="汇总你在所有组织里负责的需求与工作项、等你跟进的条目、指派给你的任务、等你签字的检查项和未读评论。" />
```

- [ ] **Step 3: 组织设置「跟进」**

新建 `apps/web/src/app/(app)/[org]/settings/tracking/page.tsx`：

```tsx
'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { trackingKeys, useApiMutation, useTrackingSettings } from '@/lib/queries';

function DaysField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" inputMode="numeric" min={1} max={365} step={1} className="w-32 font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function TrackingSettingsPage() {
  const { org } = useParams<{ org: string }>();
  const q = useTrackingSettings(org);
  const [warnDays, setWarnDays] = useState('');
  const [alertDays, setAlertDays] = useState('');
  const [staleDays, setStaleDays] = useState('');
  const [synced, setSynced] = useState<typeof q.data>(undefined);
  if (q.data && q.data !== synced) {
    setSynced(q.data);
    setWarnDays(String(q.data.warnDays));
    setAlertDays(String(q.data.alertDays));
    setStaleDays(String(q.data.staleUpdateDays));
  }
  const save = useApiMutation(
    () =>
      api(`/orgs/${org}/tracking-settings`, {
        method: 'PUT',
        body: { warnDays: Number(warnDays), alertDays: Number(alertDays), staleUpdateDays: Number(staleDays) },
      }),
    { invalidate: [trackingKeys(org)], silentError: true, success: '已保存' },
  );
  if (q.isError) return <QueryError error={q.error} noAccessMessage="你没有修改跟进设置的权限。" retryMessage="加载跟进设置失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '跟进' }]}
        title="跟进"
        description="跟进页「任务老化」的阈值：本阶段停留（扣除暂停）超过标黄天数标黄、超过标红天数标红；超过无进展天数没有进展记录的条目单独列出。暂停中的条目不标色、不计无进展。"
      />
      <form
        className="flex max-w-lg flex-col gap-4 rounded-lg border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <DaysField id="tracking-warn" label="标黄：本阶段停留超过（天）" value={warnDays} onChange={setWarnDays} />
        <DaysField id="tracking-alert" label="标红：本阶段停留超过（天）" value={alertDays} onChange={setAlertDays} />
        <DaysField id="tracking-stale" label="无进展：超过（天）没有进展记录" value={staleDays} onChange={setStaleDays} />
        <FormError error={save.error} />
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
      <TrackingSettingsPage />
    </RequireOrgAdmin>
  );
}
```

- [ ] **Step 4: 字段字典与流程编辑器区分作用对象**

`apps/web/src/components/field-card.tsx`：`{field.productId && <span className="text-xs text-primary">产品覆盖</span>}` 之后加：

```tsx
        {field.appliesTo === 'work_item' && <span className="text-xs text-muted-foreground">作用于工作项</span>}
```

`apps/web/src/app/(app)/[org]/settings/workflows/[id]/page.tsx`：

1. `const fields = useFields(org, productId);` 之后加：

```tsx
  // 流程条件只能引用作用于需求的字段（工作项的「工作类型」不参与流程）
  const requirementFields = useMemo(() => fields.data?.filter((f) => f.appliesTo === 'requirement'), [fields.data]);
```

2. `issues` 的 `useMemo` 整体替换为：

```tsx
  const issues = useMemo(() => {
    if (!draft || !requirementFields) return [];
    const r = validateWorkflowBody(draft, { fieldKeys: requirementFields.map((f) => f.key) });
    return r.ok ? [] : r.issues;
  }, [draft, requirementFields]);
```

3. `<ActionGate body={draft} fields={fields.data ?? []} onChange={setDraft} />` 与 `<ConditionSheet body={draft} fields={fields.data ?? []} … />` 里的 `fields={fields.data ?? []}` 都改为 `fields={requirementFields ?? []}`。

- [ ] **Step 5: 运行测试、检查并提交**

Run: `pnpm --filter @flower/web exec vitest run src/features/workbench/model.test.ts && pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: PASS；lint 零错误零警告；typecheck 无错误。

```bash
git add "apps/web/src/app/(app)/[org]/page.tsx" apps/web/src/features/workbench "apps/web/src/app/(app)/[org]/settings/tracking/page.tsx" apps/web/src/components/field-card.tsx "apps/web/src/app/(app)/[org]/settings/workflows/[id]/page.tsx"
git commit -m "feat(web): 工作台「我负责的需求与工作项」「等我跟进」，组织设置「跟进」，字段按作用对象区分

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: 端到端测试（跟进页、需求详情、工作项、工作台、组织设置，1440 与 760）

**Files:**
- Create: `apps/web/e2e/tracking.spec.ts`、`apps/web/e2e/work-items.spec.ts`

**Interfaces:**
- Consumes: Task 12–15 的页面与文案；e2e `helpers.ts` 的 `ok`、`json`、`setupInstance`、`login`、`createProduct`、`createRequirement`、`memberRequest`、`acceptInvite`、`tick`、`expectNoPageOverflow`、`OWNER`；`db.ts` 的 `resetDatabase`、`adminSql`
- Produces: 两个 spec，共 7 个用例

默认流程（`createProduct` 建的产品）的状态：待处理（backlog）、待开始（todo，未开始类）、进行中（doing，进行中类）、已完成、已取消。

- [ ] **Step 1: 跟进页与需求详情**

新建 `apps/web/e2e/tracking.spec.ts`：

```ts
import { type APIRequestContext, expect, test } from '@playwright/test';
import { adminSql, resetDatabase } from './db';
import { acceptInvite, createProduct, createRequirement, expectNoPageOverflow, json, login, memberRequest, ok, OWNER, setupInstance, tick } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

const move = (request: APIRequestContext, id: string, to: string) => ok(request.post(`/api/v1/orgs/acme/requirements/${id}/transitions`, { data: { to } }));

type Seeded = {
  productId: string;
  zhang: { ctx: APIRequestContext; memberId: string };
  reqs: Record<'doing' | 'todo' | 'backlog', { id: string; displayKey: string }>;
};

/**
 * 网盘产品：「开发中的需求」（张三负责，进行中，停留 20 天、20 天没有进展）、「待开始的需求」（已暂停）、
 * 「收集中的需求」（待处理，手动加入跟进）；一个不关联产品的工作项「协助客服排查」（林澄负责）。
 */
async function seed(request: APIRequestContext): Promise<Seeded> {
  await setupInstance(request);
  const productId = await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  const doing = await createRequirement(request, productId, '开发中的需求');
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${doing.id}`, { data: { ownerMemberId: zhang.memberId } }));
  await move(request, doing.id, 'doing');
  await adminSql(`update requirements set state_changed_at = now() - interval '20 days', tracked_since = now() - interval '20 days' where id = $1`, [doing.id]);
  const todo = await createRequirement(request, productId, '待开始的需求');
  await move(request, todo.id, 'todo');
  await ok(request.post(`/api/v1/orgs/acme/requirements/${todo.id}/pause`, { data: { reason: '等法务确认' } }));
  const backlog = await createRequirement(request, productId, '收集中的需求');
  await ok(request.put(`/api/v1/orgs/acme/requirements/${backlog.id}/tracking`, { data: { tracking: true } }));
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  await ok(request.post('/api/v1/orgs/acme/work-items', { data: { title: '协助客服排查', ownerMemberId: me } }));
  return { productId, zhang, reqs: { doing, todo, backlog } };
}

test('四个页签与筛选：全部在手、任务老化、按阶段看板、按产品经理；筛选与页签写入地址栏；1440 与 760 不横向滚动', async ({ page, request }) => {
  const { productId, zhang } = await seed(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '跟进' }).click();
  await page.waitForURL('**/acme/tracking');
  const table = page.getByRole('table', { name: '全部在手' });
  for (const title of ['开发中的需求', '待开始的需求', '收集中的需求', '协助客服排查']) await expect(table.getByRole('link', { name: title })).toBeVisible();
  const doingRow = table.getByRole('row', { name: /开发中的需求/ });
  await expect(doingRow).toContainText('张三');
  await expect(doingRow.locator('span', { hasText: /^20 天$/ })).toHaveClass(/bg-amber-100/);
  await expect(table.getByRole('row', { name: /待开始的需求/ }).getByText('已暂停')).toBeVisible();
  await expectNoPageOverflow(page);

  await page.getByRole('checkbox', { name: '只看暂停' }).click();
  await expect(page).toHaveURL(/paused=1/);
  await expect(table.getByRole('link', { name: '待开始的需求' })).toBeVisible();
  await expect(table.getByRole('link', { name: '开发中的需求' })).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page).toHaveURL(/\/acme\/tracking$/);

  await page.getByLabel('负责人', { exact: true }).click();
  await page.getByRole('option', { name: '张三' }).click();
  await expect(page).toHaveURL(new RegExp(`owner=${zhang.memberId}`));
  await expect(table.getByRole('link', { name: '开发中的需求' })).toBeVisible();
  await expect(table.getByRole('link', { name: '协助客服排查' })).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(table.getByRole('link', { name: '协助客服排查' })).toBeVisible();

  await page.getByRole('tab', { name: '任务老化' }).click();
  await expect(page).toHaveURL(/tab=aging/);
  await expect(page.getByRole('region', { name: '按本阶段停留排序' }).getByRole('row').nth(1)).toContainText('开发中的需求');
  await expect(page.getByRole('region', { name: '超过 7 天没有进展记录' }).getByRole('link', { name: '开发中的需求' })).toBeVisible();

  await page.getByRole('tab', { name: '按阶段看板' }).click();
  await expect(page).toHaveURL(/tab=board/);
  for (const [column, title] of [
    ['收集', '收集中的需求'],
    ['未开始', '待开始的需求'],
    ['进行中', '开发中的需求'],
    ['工作项', '协助客服排查'],
  ]) {
    await expect(page.getByRole('region', { name: column, exact: true }).getByRole('article', { name: new RegExp(title) })).toBeVisible();
  }
  await page.getByLabel('产品', { exact: true }).click();
  await page.getByRole('option', { name: '网盘' }).click();
  await expect(page).toHaveURL(new RegExp(`product=${productId}`));
  await expect(page.getByRole('region', { name: '待处理', exact: true }).getByRole('article', { name: /收集中的需求/ })).toBeVisible();
  await expect(page.getByRole('region', { name: '待开始', exact: true }).getByRole('article', { name: /待开始的需求/ })).toBeVisible();

  await page.getByRole('tab', { name: '按产品经理' }).click();
  await expect(page).toHaveURL(/tab=owners/);
  await expect(page.getByRole('region', { name: '张三', exact: true })).toContainText('1 条 · 暂停 0 · 阻塞 0 · 老化 1');
  await expect(page.getByRole('region', { name: '未指定负责人', exact: true })).toContainText('2 条 · 暂停 1');

  await page.setViewportSize({ width: 760, height: 900 });
  for (const tab of ['all', 'aging', 'board', 'owners']) {
    await page.goto(`/acme/tracking?tab=${tab}`);
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
    await expect(page.getByText('协助客服排查').first()).toBeVisible();
    await expectNoPageOverflow(page);
  }
  await zhang.ctx.dispose();
});

test('写进展：小窗填写进展、下一步、跟进人，顺手改预计上线日期；连续填写保留上一次的跟进人；跟进人收到通知', async ({ page, request }) => {
  const { zhang, reqs } = await seed(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/tracking');
  const table = page.getByRole('table', { name: '全部在手' });
  await table.getByRole('button', { name: `写进展：${reqs.doing.displayKey}` }).click();
  const dialog = page.getByRole('dialog', { name: '写进展' });
  await dialog.getByLabel('进展').fill('接口联调完成');
  await dialog.getByLabel('下一步').fill('约测试');
  await dialog.getByRole('combobox', { name: '跟进人' }).click();
  await page.getByRole('option', { name: '张三' }).click();
  await dialog.getByLabel('预计上线日期').fill('2026-11-30');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已记录进展')).toBeVisible();
  const row = table.getByRole('row', { name: /开发中的需求/ });
  await expect(row).toContainText('接口联调完成 · 下一步：约测试 · 张三');
  await expect(row).toContainText('2026-11-30');

  await table.getByRole('button', { name: `写进展：${reqs.todo.displayKey}` }).click();
  await expect(dialog.getByRole('combobox', { name: '跟进人' })).toHaveText('张三');
  await dialog.getByLabel('进展').fill('法务已回复');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(table.getByRole('row', { name: /待开始的需求/ })).toContainText('法务已回复 · 张三');

  expect((await tick(request)).notified).toBeGreaterThanOrEqual(2);
  const inbox = await json<{ notifications: Array<{ kind: string; body: string }> }>(zhang.ctx.get('/api/v1/orgs/acme/notifications'));
  expect(inbox.notifications.map((n) => [n.kind, n.body])).toEqual(
    expect.arrayContaining([
      ['assigned', '你是下一步跟进人：约测试'],
      ['assigned', '你是下一步跟进人'],
    ]),
  );
  await zhang.ctx.dispose();
});

test('过期筛选：不认识的页签当作全部在手；产品不存在、负责人不在列表时显示「没有符合条件的条目」与「清除筛选」；格式错误显示「筛选参数无效」', async ({ page, request }) => {
  const { zhang } = await seed(request);
  await login(page, OWNER.email, OWNER.password);
  const random = '00000000-0000-4000-8000-000000000001';
  await page.goto(`/acme/tracking?tab=nope&product=${random}`);
  await expect(page.getByRole('tab', { name: '全部在手' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('没有符合条件的条目')).toBeVisible();
  await expect(page.getByLabel('产品', { exact: true })).toHaveText('（看不到的产品）');
  await page.getByRole('button', { name: '清除筛选' }).first().click();
  await expect(page).toHaveURL(/\/acme\/tracking$/);
  await expect(page.getByRole('table', { name: '全部在手' }).getByRole('link', { name: '开发中的需求' })).toBeVisible();

  await page.goto(`/acme/tracking?owner=${random}&tab=owners`);
  await expect(page.getByText('没有符合条件的条目')).toBeVisible();
  await expect(page.getByLabel('负责人', { exact: true })).toHaveText('（已不在列表中的负责人）');

  await page.goto('/acme/tracking?product=abc');
  await expect(page.getByText('筛选参数无效')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByRole('table', { name: '全部在手' })).toBeVisible();
  await zhang.ctx.dispose();
});

test('需求详情：跟进区块加入与移出、预计上线日期、暂停与恢复；进展记录页签新增、修改、删除', async ({ page, request }) => {
  await setupInstance(request);
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录页改版');
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const panel = page.getByRole('region', { name: '跟进', exact: true });
  await expect(panel).toContainText('未加入跟进');
  await panel.getByRole('button', { name: '加入跟进' }).click();
  await expect(panel).toContainText('跟进中');
  await panel.getByLabel('预计上线日期').fill('2026-11-30');
  await panel.getByLabel('预计上线日期').press('Tab');
  await expect(page.getByText('已保存')).toBeVisible();
  await panel.getByRole('button', { name: '暂停', exact: true }).click();
  const pause = page.getByRole('dialog', { name: '暂停', exact: true });
  await pause.getByLabel('暂停原因').fill('等法务确认');
  await pause.getByRole('button', { name: '确认暂停' }).click();
  await expect(panel).toContainText('已暂停：等法务确认');
  await panel.getByRole('button', { name: '恢复' }).click();
  await expect(panel).not.toContainText('已暂停');

  await page.getByRole('tab', { name: '进展记录' }).click();
  const progress = page.getByRole('region', { name: /^进展记录/ });
  await progress.getByRole('button', { name: '写进展' }).click();
  const dialog = page.getByRole('dialog', { name: '写进展' });
  await expect(dialog.getByLabel('预计上线日期')).toHaveValue('2026-11-30');
  await dialog.getByLabel('进展').fill('完成方案评审');
  await dialog.getByLabel('下一步').fill('拆分任务');
  await dialog.getByRole('button', { name: '保存' }).click();
  const list = progress.getByRole('list', { name: '进展记录列表' });
  await expect(list).toContainText('完成方案评审');
  await expect(list).toContainText('下一步：拆分任务');
  await list.getByRole('button', { name: '修改' }).click();
  await list.getByLabel('修改进展').fill('完成方案评审与排期');
  await list.getByRole('button', { name: '保存' }).click();
  await expect(list).toContainText('完成方案评审与排期');
  await expect(list).toContainText('（已编辑）');
  await list.getByRole('button', { name: '删除' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await expect(progress).toContainText('还没有进展记录');

  await panel.getByRole('button', { name: '移出跟进' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '移出' }).click();
  await expect(panel).toContainText('已移出跟进');
  await expectNoPageOverflow(page);
});

test('组织设置「跟进」：无效值显示错误；修改阈值后任务老化标色随之变化；成员无权访问', async ({ page, request, browser }) => {
  const { zhang } = await seed(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/tracking');
  const warn = page.getByLabel('标黄：本阶段停留超过（天）');
  await expect(warn).toHaveValue('14');
  await warn.fill('30');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '标黄天数应小于标红天数' })).toBeVisible();
  await warn.fill('25');
  await page.getByLabel('标红：本阶段停留超过（天）').fill('40');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expectNoPageOverflow(page);
  await page.goto('/acme/tracking?tab=aging');
  const row = page.getByRole('region', { name: '按本阶段停留排序' }).getByRole('row', { name: /开发中的需求/ });
  await expect(row.locator('span', { hasText: /^20 天$/ })).not.toHaveClass(/bg-amber-100/);

  const ctx = await browser.newContext();
  const member = await ctx.newPage();
  await acceptInvite(member, request, { email: 'member@example.com', orgRole: 'member', name: '成员乙' });
  await member.goto('/acme/settings/tracking');
  await expect(member.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await ctx.close();
  await zhang.ctx.dispose();
});
```

- [ ] **Step 2: 工作项与工作台**

新建 `apps/web/e2e/work-items.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, expectNoPageOverflow, json, login, memberRequest, ok, OWNER, setupInstance, tick } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

test('工作项全流程：新建、负责人、描述与 @、暂停与恢复、进展记录、阻塞项、关注、状态切换、删除；1440 与 760 不横向滚动', async ({ page, request }) => {
  await setupInstance(request);
  await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/tracking');
  await page.getByRole('button', { name: '新建工作项' }).click();
  const create = page.getByRole('dialog', { name: '新建工作项' });
  await create.getByLabel('标题').fill('协助客服排查上传失败');
  await create.getByLabel('工作类型').click();
  await page.getByRole('option', { name: '技术支持' }).click();
  await create.getByLabel('启动日期').fill('2026-10-08');
  await create.getByLabel('预计完成日期').fill('2026-10-20');
  await create.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建 W-1')).toBeVisible();
  const table = page.getByRole('table', { name: '全部在手' });
  await expect(table.getByRole('row', { name: /协助客服排查上传失败/ })).toContainText('技术支持');
  await table.getByRole('link', { name: '协助客服排查上传失败' }).click();
  await page.waitForURL('**/acme/work-items/W-1');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('协助客服排查上传失败');
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '跟进' })).toHaveAttribute('aria-current', 'page');
  await expectNoPageOverflow(page);

  const info = page.getByRole('region', { name: '基本信息' });
  await expect(info.getByLabel('工作类型')).toHaveText('技术支持');
  await expect(info.getByLabel('启动日期')).toHaveValue('2026-10-08');
  await info.getByRole('combobox', { name: '负责人' }).click();
  await page.getByRole('option', { name: '张三' }).click();
  await expect(info.getByRole('combobox', { name: '负责人' })).toHaveText('张三');

  const desc = page.getByRole('region', { name: '描述' });
  await desc.getByRole('button', { name: '编辑' }).click();
  await desc.getByLabel('描述').click();
  await page.keyboard.type('请 @张');
  await page.getByRole('listbox', { name: '成员补全' }).getByRole('option', { name: /张三/ }).click();
  await desc.getByRole('button', { name: '保存' }).click();
  await expect(desc.getByText('@张三', { exact: true })).toBeVisible();

  await info.getByRole('button', { name: '暂停', exact: true }).click();
  const pause = page.getByRole('dialog', { name: '暂停', exact: true });
  await pause.getByLabel('暂停原因').fill('等对方排期');
  await pause.getByRole('button', { name: '确认暂停' }).click();
  await expect(info).toContainText('已暂停：等对方排期');
  await info.getByRole('button', { name: '恢复' }).click();
  await expect(info).not.toContainText('已暂停');

  const progress = page.getByRole('region', { name: /^进展记录/ });
  await progress.getByRole('button', { name: '写进展' }).click();
  const dialog = page.getByRole('dialog', { name: '写进展' });
  await expect(dialog.getByLabel('预计完成日期')).toHaveValue('2026-10-20');
  await dialog.getByLabel('进展').fill('已定位到网关超时');
  await dialog.getByRole('combobox', { name: '跟进人' }).click();
  await page.getByRole('option', { name: '张三' }).click();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(progress.getByRole('list', { name: '进展记录列表' })).toContainText('已定位到网关超时');

  const blockers = page.getByRole('region', { name: '阻塞项' });
  await blockers.getByLabel('新阻塞项').fill('等网关团队回复');
  await blockers.getByRole('button', { name: '添加' }).click();
  await expect(blockers).toContainText('等网关团队回复');
  await blockers.getByRole('button', { name: '解除：等网关团队回复' }).click();
  await expect(blockers).toContainText('已解除 1 条');

  await page.getByRole('button', { name: '关注', exact: true }).click();
  await expect(page.getByRole('button', { name: '已关注' })).toBeVisible();

  expect((await tick(request)).notified).toBeGreaterThanOrEqual(3);
  const inbox = await json<{ notifications: Array<{ kind: string; body: string; url: string }> }>(zhang.ctx.get('/api/v1/orgs/acme/notifications'));
  expect(inbox.notifications.map((n) => [n.kind, n.body, n.url])).toEqual(
    expect.arrayContaining([
      ['assigned', '把工作项指派给你', '/acme/work-items/W-1'],
      ['mentioned', '在工作项描述中 @ 了你', '/acme/work-items/W-1'],
      ['assigned', '你是下一步跟进人', '/acme/work-items/W-1'],
    ]),
  );

  await info.getByLabel('状态').click();
  await page.getByRole('option', { name: '已完成' }).click();
  await expect(info.getByLabel('状态')).toHaveText('已完成');
  await expect(info.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(info).toBeVisible();
  await expectNoPageOverflow(page);

  await info.getByRole('button', { name: '删除工作项' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await page.waitForURL('**/acme/tracking');
  await expect(page.getByText('还没有在手的工作')).toBeVisible();
  await zhang.ctx.dispose();
});

test('工作台：「我负责的需求与工作项」列出进行中的工作项；「等我跟进」列出我是跟进人的条目，点击进入详情；1440 与 760', async ({ page, request }) => {
  await setupInstance(request);
  const productId = await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  await ok(request.post('/api/v1/orgs/acme/work-items', { data: { title: '我负责的工作项', ownerMemberId: me } }));
  const req = await createRequirement(request, productId, '等我确认的需求');
  await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/transitions`, { data: { to: 'doing' } }));
  await ok(zhang.ctx.post(`/api/v1/orgs/acme/requirements/${req.id}/progress`, { data: { body: '方案初稿', nextStep: '请确认方案', followerMemberId: me } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  const owned = page.getByRole('region', { name: /我负责的需求与工作项/ });
  await expect(owned.getByRole('link', { name: /我负责的工作项/ })).toBeVisible();
  const following = page.getByRole('region', { name: /等我跟进/ });
  await expect(following.getByRole('link', { name: /等我确认的需求/ })).toContainText('请确认方案');
  await expectNoPageOverflow(page);
  await following.getByRole('link', { name: /等我确认的需求/ }).click();
  await page.waitForURL(`**/acme/requirements/${req.displayKey}`);
  await page.goto('/acme');
  await owned.getByRole('link', { name: /我负责的工作项/ }).click();
  await page.waitForURL('**/acme/work-items/W-1');
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/acme');
  await expect(following.getByRole('link', { name: /等我确认的需求/ })).toBeVisible();
  await expectNoPageOverflow(page);
  await zhang.ctx.dispose();
});
```

- [ ] **Step 3: 运行端到端测试**

Run: `pnpm --filter @flower/web e2e tracking.spec.ts work-items.spec.ts`
Expected: 7 passed。断言不过时先用 `--trace on` 查看是数据（`adminSql` 改的时间、事件是否已生成）还是页面问题，不要放宽断言。

Run: `pnpm --filter @flower/web e2e requirements.spec.ts mentions.spec.ts member-notifications.spec.ts workbench.spec.ts layout.spec.ts fields.spec.ts workflows.spec.ts`
Expected: 全部通过（需求详情的评论改为页签、工作台改名、字段字典新增两个内置字段之后，已有用例仍成立）。

- [ ] **Step 4: lint 与类型检查并提交**

Run: `pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: 零错误零警告；typecheck 无错误。

```bash
git add apps/web/e2e/tracking.spec.ts apps/web/e2e/work-items.spec.ts
git commit -m "test(web): 跟进、工作项、工作台与组织设置「跟进」端到端测试（1440 与 760）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: 性能测量命令加入跟进用例

**Files:**
- Modify: `packages/migrate/src/perf.ts`
- Test: `packages/migrate/test/perf.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `getTracking`；已有的 `buildPerfCases`、`measure`
- Produces: `buildPerfCases` 返回的用例末尾多四个：`跟进：全部在手`、`跟进：含最近 30 天完成`、`跟进：按产品`、`跟进：按负责人（在手最多的人）`（共 24 个）

- [ ] **Step 1: 改测试（先失败）**

`packages/migrate/test/perf.test.ts` 第二个用例里，期望的用例名列表在 `'看板：组织汇总，近 90 天',` 之后加四项，长度改为 24：

```ts
      '看板：组织汇总，近 90 天',
      '跟进：全部在手',
      '跟进：含最近 30 天完成',
      '跟进：按产品',
      '跟进：按负责人（在手最多的人）',
    ]);
    const result = await measure(cases, 2);
    expect(result).toHaveLength(24);
```

Run: `pnpm --filter @flower/migrate exec vitest run test/perf.test.ts`
Expected: FAIL（用例名列表少四项）。

- [ ] **Step 2: 加用例**

`packages/migrate/src/perf.ts`：

1. `@flower/core` 的导入列表按字母顺序加入 `getTracking`。
2. 在 `const recent = …` 语句之后加：

```ts
  // 跟进按负责人：在手条目最多的负责人
  const tracked = await getTracking(db, actor);
  const trackedOwners = new Map<string, number>();
  for (const item of tracked.items) if (item.owner) trackedOwners.set(item.owner.id, (trackedOwners.get(item.owner.id) ?? 0) + 1);
  const topTracked = [...trackedOwners.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
```

3. 返回数组末尾（`看板：组织汇总，近 90 天` 那一项之后）加：

```ts
    { name: '跟进：全部在手', run: () => getTracking(db, actor) },
    { name: '跟进：含最近 30 天完成', run: () => getTracking(db, actor, { includeDone: true }) },
    { name: '跟进：按产品', run: () => getTracking(db, actor, { productId }) },
    { name: '跟进：按负责人（在手最多的人）', run: () => (topTracked ? getTracking(db, actor, { ownerId: topTracked }) : Promise.resolve(null)) },
```

- [ ] **Step 3: 运行测试确认通过，类型检查并提交**

Run: `pnpm --filter @flower/migrate exec vitest run test/perf.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

```bash
git add packages/migrate/src/perf.ts packages/migrate/test/perf.test.ts
git commit -m "feat(migrate): 性能测量加入跟进列表四个用例

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: 全量验证、开发库迁移与 SQL 核对、性能与界面复验（控制方）、验证记录与交接

**Files:**
- Create: `docs/p3c1-validation.md`
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
```

Expected: 全部通过（`editor-perf.spec.ts` 在未设置 `EDITOR_BENCH` 时跳过）；记下 core、web、migrate 单测数与 e2e 用例数。这一步不碰本地开发库（测试各自建库）；跑完后 `flower_app` 的密码是测试值，由 Step 2 的 `pnpm db:migrate` 改回。

- [ ] **Step 2: STOP——控制方迁移本地开发库并用 SQL 只读核对**

执行代理在这里停下。控制方依次执行（SQL 一律 `docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "…"`，只看数量与结构，不输出姓名、邮箱、标题）。

1. 迁移前记下需求数（预期 766）：

```sql
select count(*) from requirements r join organizations o on o.id = r.org_id where o.slug = 'pan123' and r.deleted_at is null;
```

2. 执行迁移（同时把 `flower_app` 密码改回 `apps/web/.env.local` 的值）：

```bash
pnpm db:migrate
```

Expected: 执行 0019、0020 两个迁移，无报错。

3. 迁移记录与新表的行级安全：

```sql
select count(*) from drizzle.__drizzle_migrations;
select relname, relrowsecurity from pg_class where relname in ('work_items', 'progress_updates') order by relname;
select tablename, count(*) from pg_policies where tablename in ('work_items', 'progress_updates') group by tablename order by tablename;
```

Expected: `21`；`progress_updates|t`、`work_items|t`；两张表各 `1` 条策略。

4. 回填 `tracked_since`（预期在手 81、已回填 81、在手之外 0，最早 2026-03-12、最晚 2026-09-29）与走兜底的条数（预期 0）：

```sql
with st as (
  select p.id as product_id, s->>'key' as key, s->>'category' as category
  from products p join organizations o on o.id = p.org_id and o.slug = 'pan123'
  join workflow_versions v on v.id = p.workflow_version_id, jsonb_array_elements(v.body->'states') s
)
select count(*) filter (where st.category in ('unstarted', 'started')) as in_hand,
       count(r.tracked_since) as tracked,
       count(*) filter (where r.tracked_since is not null and st.category not in ('unstarted', 'started')) as tracked_outside,
       min((r.tracked_since at time zone 'Asia/Shanghai')::date) as earliest,
       max((r.tracked_since at time zone 'Asia/Shanghai')::date) as latest
from requirements r join st on st.product_id = r.product_id and st.key = r.state_key
where r.deleted_at is null;

with st as (
  select p.id as product_id, s->>'key' as key, s->>'category' as category
  from products p join organizations o on o.id = p.org_id and o.slug = 'pan123'
  join workflow_versions v on v.id = p.workflow_version_id, jsonb_array_elements(v.body->'states') s
)
select count(*) from requirements r
where r.tracked_since is not null and r.deleted_at is null and r.product_id in (select product_id from st)
  and not exists (
    select 1 from state_transitions tr
    join st sto on sto.product_id = r.product_id and sto.key = tr.to_state
    left join st sf on sf.product_id = r.product_id and sf.key = tr.from_state
    where tr.requirement_id = r.id and sto.category in ('unstarted', 'started') and coalesce(sf.category, 'backlog') not in ('unstarted', 'started')
  );
```

5. 需求数不变：重跑第 1 条 SQL，预期仍为 766。

6. 内置字段与预置选项（两个组织都补齐）：

```sql
select d.key, d.applies_to, d.builtin, count(fo.id)
from field_definitions d join organizations o on o.id = d.org_id and o.slug = 'pan123'
left join field_options fo on fo.field_id = d.id
where d.product_id is null and d.key in ('type', 'work_type')
group by 1, 2, 3 order by 1;
select count(*) from field_definitions where product_id is null and key in ('type', 'work_type');
select count(*) from field_definitions where applies_to <> 'requirement' and key <> 'work_type';
```

Expected: `type|requirement|t|3`、`work_type|work_item|t|2`；`4`；`0`。

7. 约束、可空列与原有数据：

```sql
select conname from pg_constraint where conname in ('blockers_subject', 'progress_updates_subject') order by 1;
select is_nullable from information_schema.columns where table_name = 'blockers' and column_name = 'requirement_id';
select count(*), count(*) filter (where b.status = 'active') from blockers b join organizations o on o.id = b.org_id where o.slug = 'pan123' and b.requirement_id is not null and b.work_item_id is null;
select count(*) from field_values where entity_type <> 'requirement';
select work_item_seq from organizations where slug = 'pan123';
select count(distinct b.requirement_id) from blockers b join requirements r on r.id = b.requirement_id join organizations o on o.id = r.org_id and o.slug = 'pan123'
where b.status = 'active' and r.deleted_at is null and r.tracked_since is not null;
```

Expected: `blockers_subject`、`progress_updates_subject`；`YES`；`9|4`；`0`；`0`；最后一条是在手且有进行中阻塞项的需求数（记下，Step 4 第 2 项对照）。

任一项不符时停下来报告，先查回填 SQL 的类别口径（退回收集、没有流转记录、已删除）再改迁移。

- [ ] **Step 3: STOP——控制方在 pan123 上测量性能**

```bash
pnpm --filter @flower/migrate build && node --disable-warning=ExperimentalWarning --env-file=apps/web/.env.local packages/migrate/dist/cli.mjs perf --org-slug pan123 --owner-email <你的账号邮箱>
```

记录四个跟进用例的 p50 / p95 / 最大值，以及工作台用例（新增两段查询）的 p95。验收：p95 低于 300 毫秒（设计 §6）。超过时停下来报告慢在哪一步（可在本地临时给 `getTracking` 各段计时，不提交）；`domain_events` 按 `subject_id` 查暂停事件没有索引，如确认是瓶颈，加索引需要新迁移，先报告再定。

- [ ] **Step 4: STOP——控制方在 pan123 上复验界面**

控制方在本地开发库（pan123）上启动开发服务器，以所有者账号与已有的测试成员「联调成员（测试）」（另开一个浏览器配置登录），在 1440px 与 760px 两种宽度下逐项检查，确认页面本身不横向滚动，把结论（只写现象与数量，不写姓名、标题）交回：

1. **主导航「跟进」· 全部在手**：PAN 在手需求 81 条（与 Step 2 第 4 项一致），工作项 0；停留超过 14 天标黄、超过 30 天标红；任选一条核对「本阶段停留」与 SQL `(now() at time zone 'Asia/Shanghai')::date - (state_changed_at at time zone 'Asia/Shanghai')::date` 一致；表格在容器内横向滚动、标题列固定。
2. **筛选**：产品、负责人、类型（「类型」字段历史需求为空，选任一类型应为「没有符合条件的条目」）；「只看有阻塞」的条数与 Step 2 第 7 项最后一条一致；「含最近 30 天完成」；筛选写入地址栏，刷新后保持；地址栏改成不存在的产品显示「没有符合条件的条目」与「清除筛选」。
3. **写进展**：在一条 PAN 需求上「写进展」，填进展、下一步，跟进人选「联调成员（测试）」，顺手改预计上线日期；列表该行显示最新进展、下一步、跟进人与预计上线。再写一条时跟进人默认仍是上一次的人。等后台循环处理后（开发环境后台循环开启，约 30 秒内），测试成员的铃铛出现「被指派」「你是下一步跟进人：…」，点击进入该需求；测试成员工作台「等我跟进」列出该需求。
4. **暂停与恢复**：在该需求详情「跟进」区块暂停（填原因）→ 列表显示「已暂停」，老化不标色；恢复后标色回来、停留天数不变。
5. **需求详情**：「跟进」区块的加入 / 移出跟进（选一条收集阶段的需求手动加入，再移出）；「进展记录」页签新增、修改、删除。
6. **工作项全流程**：新建工作项（不关联产品、工作类型「技术支持」、负责人「联调成员（测试）」）→ 测试成员收到「把工作项指派给你」；详情页描述里 @ 测试成员、暂停与恢复、写进展、加阻塞项并解除、关注、状态改为已完成 → 列表默认不再显示，勾选「含最近 30 天完成」后出现；最后删除该工作项。
7. **四个页签**：任务老化（按停留降序，下方「超过 7 天没有进展记录」）；按阶段看板（全部产品按「收集」（有条目时）「未开始」「进行中」「工作项」分列；选 PAN 时按 PAN 流程的非完成状态分列）；按产品经理（每人的条数、暂停、阻塞、老化数）。
8. **工作台**：「我负责的需求与工作项」「等我跟进」两个区块。
9. **组织设置「跟进」**：标黄改为 21、标红改为 45 → 任务老化标色随之变化；标黄不小于标红时提示「标黄天数应小于标红天数」；最后改回 14 / 30 / 7。

复验会在 pan123 留下进展记录、暂停与恢复事件、手动加入与移出事件、通知；工作项在第 6 项末尾删除（软删除）。这些写进验证记录第 6 节。

- [ ] **Step 5: 写验证记录**

新建 `docs/p3c1-validation.md`，结构与 `docs/p3b2-validation.md` 一致，包含：

1. 自动化测试数量（Step 1）。
2. 迁移核对（Step 2）：迁移记录数、两张新表的行级安全与策略、回填条数（在手、已回填、在手之外、走兜底、最早与最晚日期）、需求数迁移前后、内置字段与选项、约束与原有阻塞项，每项一行「预期 / 实际 / 结论」。
3. 性能（Step 3）：四个跟进用例与工作台的 p50 / p95 / 最大值与是否达标。
4. 界面复验（Step 4）：每项「通过 / 问题与处理 / 未验证」。
5. 已知的数据限制与说明：旧系统的「进展」评论（`kind = update`，76 条）没有转成进展记录，仍在评论里显示「进展」标记；智能表的历史条目没有导入，上线后手工建工作项；回填只覆盖当前在手的需求，已上线、已取消的历史需求没有加入跟进的时间（P3-C2 周期汇总按状态流转统计上线，不依赖它）；「类型」字段历史需求为空，需要产品经理补填；进展记录、暂停与工作项从上线后开始积累。是否迁移旧「进展」评论由用户决定。
6. 复验留下的测试数据：pan123 上的进展记录条数、暂停 / 恢复与加入 / 移出事件条数、已删除的工作项条数（只写数量），以及下次 `--replace` 重导会把它们一并清除。
7. 人工验收清单（供用户试用）：全部在手与筛选、写进展（含跟进人通知与连续填写）、任务老化与阈值、按阶段看板、按产品经理、需求详情的跟进区块与进展记录、工作项全流程、工作台两个区块、760px 宽度。

- [ ] **Step 6: 更新交接文档与协作日志**

`docs/handoff.md`：

1. 「关键文档」表在 P3-B2 三行之后加三行：`docs/superpowers/specs/2026-10-13-flower-p3c1-tracking-design.md`（P3-C1 设计：工作跟进，替代「产品工作情况表」，已确认）、`docs/superpowers/plans/2026-10-13-flower-p3c1-tracking.md`（P3-C1 计划）、`docs/p3c1-validation.md`（P3-C1 迁移核对、性能与人工验收清单）。
2. 「当前进度」里「P3-B2 基础数据看板：已完成，待合并（分支 `feat/p3b2-dashboard`）」改为「P3-B2 基础数据看板：已完成，已合并（PR #17）」。
3. 「当前进度」加一条「P3-C1 工作跟进：已完成，待合并」（分支 `feat/p3c1-tracking`），写清：需求自动 / 手动加入跟进、类型与预计上线日期、暂停（不计停留与老化）、进展记录（进展、下一步、跟进人）、工作项 `W-n`（可选关联产品，阻塞项、关注、通知）、主导航「跟进」四个页签与筛选、需求详情跟进区块与进展记录页签、工作台「我负责的需求与工作项」「等我跟进」、组织设置「跟进」阈值；迁移 0019、0020（两张新表开启 RLS，回填 81 条，补齐两个内置字段）；性能结果；已知数据限制（第 5 节）。
4. 「下一步」改为：合并 P3-C1；用户按 `docs/p3c1-validation.md` 第 7 节验收（P3-B2 的验收事项见 `docs/p3b2-validation.md` 第 6 节）；之后做 P3-C2 周期汇总（周、月、季、半年、年；导出 Markdown 与 Excel；定时推送到群，推送规则接入本阶段的新事件）。原第 4 条（重导前先 `--dry-run`、重导后 `legacy rejoin`、重导会删除复验测试数据）保留，并把 P3-C1 复验留下的数据加进去。

`docs/agent-log.md`「记录」最上面加一条（日期写实际完成日）：

```
### 2026-10-XX · 本地 · P3-C1 工作跟进
- 分支 / PR：`feat/p3c1-tracking`
- 做了什么：
  - 数据模型：`requirements` 加跟进五列，新表 `work_items`、`progress_updates`（RLS），`blockers` 可挂工作项，`organizations.work_item_seq`；迁移 0019（结构）与 0020（RLS、回填 tracked_since、补齐内置字段「类型」「工作类型」）；`field_definitions.applies_to` 开始生效。
  - core `src/tracking/`：停留与老化纯函数、工作项权限、需求跟进设置与自动加入、工作项、进展记录、跟进列表与阈值；通知（工作项指派与 @、跟进人、关注者）、工作项关注、组织级 @ 候选成员；工作台两个区块。
  - 接口 `/orgs/:org/tracking`、`/tracking-settings`、需求跟进与进展、`/work-items`、`/progress`、`/mention-members`。
  - 页面：主导航「跟进」（四个页签、筛选、写进展、新建工作项）、工作项详情、需求详情跟进区块与进展记录页签、工作台、组织设置「跟进」。
  - perf 命令加四个跟进用例。
- 怎么验证的：（Step 1 的测试数；Step 2 的迁移核对；Step 3 的性能；Step 4 的复验结论）
- 留给对方：旧「进展」评论未转换、历史需求没有加入跟进时间、「类型」待补填（见 `docs/p3c1-validation.md` 第 5 节）；下一步 P3-C2 周期汇总。
```

- [ ] **Step 7: 提交**

```bash
git add docs/p3c1-validation.md docs/handoff.md docs/agent-log.md
git commit -m "docs: P3-C1 验证记录、迁移核对、交接进度与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 与设计、代码或数据的冲突

写计划时对照设计、代码与只读数据发现的不一致，以及本计划的处理：

| 设计说法或现状 | 实际情况 | 本计划的处理 |
|---|---|---|
| 设计 §3.6：回填「取最近一次进入该类别的流转时间」 | 「该类别」是未开始、进行中两类；按字面取最近一次进入任一类，「设计中 → 开发中」的需求会得到进入开发中的时间，与 §3.1「第一次进入未开始或进行中时加入」不一致。pan123 的 81 条在手需求全部有从其他类别进入这两类的流转 | 取最近一次「从这两类之外（或创建）进入这两类」的流转时间；退回收集后再进入的按再次进入计；没有这样的流转时取 `state_changed_at`（pan123 预期 0 条）。迁移 0020 与迁移工具的 `backfillTrackedSinceTx` 用同一条 SQL（Task 2），控制方在 Task 18 核对 |
| 设计 §3.2：「工作类型」的值存在字段值表，「`field_values` 增加对工作项的引用，规则同进展记录的『只挂一个对象』」 | `field_values` 是 `entity_type` + `entity_id` 的多态引用，没有外键，不是每类对象一列；`field_definitions.applies_to` 已有但从未使用，需求的字段查询都不按它过滤 | `entity_type` 增加取值 `work_item`（只改 TypeScript 类型，无迁移），不加 `work_item_id` 列与检查约束；`applies_to` 开始生效：需求的有效字段、产品范围的字段列表、流程条件只取作用于需求的字段，工作项字段不能被产品覆盖（Task 3） |
| 设计 §5：不关联产品的工作项「组织非访客成员可查看与新建；修改限负责人、创建人与组织管理员」 | 没有写写进展、挂阻塞项、删除别人的进展、关注由谁做，也没有写改关联产品时要什么权限 | 写进展与挂阻塞项 = 能查看且非只读；管理（删除别人的进展）= 组织管理员；关注 = 能查看。改关联产品时目标位置也要有修改权限：移到产品需该产品编辑及以上，改为不关联产品需是负责人、创建人或组织管理员（按修改前的负责人与创建人判断，防止先改负责人再移出）（Task 4、5） |
| 设计 §4.1、§5：接口「跟进列表（参数选择视图与筛选）」 | 四个视图用同一批在手条目；筛选下拉需要候选负责人与类型选项，而访客不能读成员列表与字段字典 | 一个接口返回在手条目（带四个视图需要的全部字段）、可见产品与流程状态、候选负责人（不受负责人、类型、暂停、阻塞筛选影响）、「类型」「工作类型」选项、阈值、今天与时区；页签只写在地址栏，由前端派生。格式错误返回 400「筛选参数无效」，合法但看不到或不存在的值返回空结果（Task 7、10、11） |
| 设计 §4.1 第 3 条：选「全部产品」时按状态类别（未开始、进行中）分列 | 手动加入的收集阶段需求、退回收集的需求也在手，按设计没有列可放 | 全部产品时加一列「收集」（有条目时才显示）；选定产品时按该产品流程中非已完成、已取消的状态分列（含收集类状态）（Task 11） |
| 设计 §4.1、§4.5：主导航「跟进」与组织设置「跟进」 | 导航高亮按键匹配，组织设置项的键取自路径（`tracking`），两项同名同键会同时高亮（同 P3-B2「看板」） | 主导航项用键 `work-tracking`（路径 `/{org}/tracking`，`/{org}/work-items/*` 也高亮它），组织设置项用键 `tracking`（Task 11） |
| 设计 §4.2：正文新增「进展记录」页签 | 需求详情正文没有页签，评论是一个独立区块 | 正文的「评论」区块改为页签「评论」「进展记录」（默认评论），其他区块不动（Task 13） |
| 设计 §4.4：「我负责的」加入我负责的进行中工作项 | 工作台区块叫「我负责的需求」 | 区块改名「我负责的需求与工作项」，工作项行状态固定为「进行中」，链接到工作项详情（Task 9、15） |
| 数据现状：评论 279 条，其中 `kind = update`（「进展」）76 条 | 设计没有说旧系统的「进展」评论是否转成进展记录 | 不转换，评论里仍显示「进展」标记；进展记录从上线后开始积累。写进验证记录第 5 节，是否迁移由用户决定 |
| 设计 §3.8：工作项负责人「被指派」并自动关注；进展记录跟进人「被指派」；关注者收到「关注对象变化」 | `NotificationSubject.productId` 必填；`eligibleMembersTx` 产品为空时不看产品（会包含访客）；`listMentionMembers` 必须传产品；关注对象只有需求与 PRD | 通知对象的产品改为可空；不关联产品的对象收件人排除访客；新增组织级 @ 候选成员接口（访客 403）；工作项可以关注。跟进人只收到通知，不自动关注（设计只要求工作项负责人与被 @ 者自动关注）（Task 8、10） |
| 设计 §1：不含工作项的 `[[ ]]` 链接；§3.2：描述「沿用需求描述的输入框与 @」 | 需求描述的输入框带 `[[` 补全，显示时把 `[[ ]]` 渲染为链接卡；@ 候选成员按产品取 | 工作项描述用同一输入框，关闭 `[[` 补全，`[[ ]]` 按原文显示（`links={false}`）；关联产品时 @ 按产品取候选成员，不关联产品时取组织级（Task 11、14） |
| 设计 §3.7：本阶段停留从进入当前状态起，在制从加入跟进起；无进展没有进展记录时取加入跟进的时间 | 工作项没有「进入当前状态」与「加入跟进」 | 工作项的停留与在制都从启动日期（没有时取创建日期）算起，「进入当前阶段」列显示启动日期；无进展的兜底取创建时间（Task 7） |
| 设计 §4.1：「实际上线」列；「可切换为同时显示最近 30 天内完成的」 | 需求可能在完成类之间流转（已上线 → 已验收），也可能完成后重新打开 | 实际上线 = 最后一次从非完成类进入完成类的日期（与 P3-B2 吞吐量同一口径）；「含最近 30 天完成」只含当前处于完成类的需求与已完成的工作项，已取消的不含（Task 7） |
| 设计 §2：暂停「状态保持不变」，暂停期间不计老化与在制 | 没有说暂停中改状态、移出跟进、工作项完成时暂停是否自动解除 | 都不自动恢复；只有跟进中的需求、进行中的工作项可以新暂停，恢复只要求正在暂停；重复暂停、没有暂停时恢复报错且不写事件，保证暂停区间能正确配对（Task 4、5） |
| 设计 §5：进展记录「作者本人可修改、删除」 | 作者后来可能失去写权限（被改为只读、Token 为只读） | 作者修改、删除还要求仍能写进展；产品管理员（不关联产品时为组织管理员）可以删除别人的（Task 6） |
| 设计 §4.1：每行与每张卡片有「写进展」 | 列表接口原本不带逐条权限，只读成员与访客点了才会被拒绝 | 条目带 `canWrite`（能否写进展）与 `canEditDate`（写进展时能否顺手改预计日期），没有权限的条目不显示按钮（Task 7、12） |
| 设计 §2「上线或取消后保留」与 §3.6 回填 | 回填只覆盖当前在手的需求，已上线、已取消的历史需求没有 `tracked_since` | 不为历史需求补加入时间（没有「曾经在手」的可靠依据）；P3-C2 周期汇总统计上线时按状态流转，不依赖 `tracked_since`。写进验证记录第 5 节与交接 |
| 性能：`domain_events` 只有 `(org_id, occurred_at)` 索引 | 跟进列表按事件类型与 `subject_id` 读暂停、恢复事件 | 不加索引（pan123 领域事件 4448 条，按组织与类型过滤）；Task 18 的 perf 超过 300 毫秒时停下报告，不在本计划内改表结构 |

## P3-C1 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm --filter @flower/web e2e`、`./scripts/smoke.sh` 全部通过；本地开发库执行 0019、0020 后，SQL 核对与预期一致（RLS、回填 81、需求数 766 不变、内置字段与选项、约束）。
- Review Focus 五类输入都有对应测试：重新打开或退回收集（Task 4、7）；跟进人离开、被改为访客或看不到对象（Task 6、8）；工作项在产品之间移动（Task 5、7）；重复或不合时宜的操作（Task 4、5、6）；过期或改坏的筛选（Task 7、10、11、16）。
- 设计 §6 的验证都有对应测试：停留扣除暂停（跨时区、暂停跨状态变化、多次暂停）与老化、无进展判定（Task 1、7）；自动加入跟进与手动移出（Task 4）；「恰有一个对象」的约束与回填（Task 2）；接口权限（组织管理员、产品管理员、编辑、只读、访客、只读 Token、限定产品的 Token）与看不到的产品不出现在任何响应与计数里（Task 7、10）；端到端的四个页签与筛选、写进展、暂停与恢复、工作项全流程、需求详情跟进区块、工作台「等我跟进」、1440 与 760（Task 16）；迁移核对、性能与界面复验（Task 17、18）。
- 不新增依赖；验证记录、交接文档与协作日志已更新（Task 18）。

## 自查

写完后对照设计逐条核对的结果：

| 设计条目 | 对应任务 |
|---|---|
| §1 范围：跟进、类型与预计上线、暂停、进展记录、工作项、跟进视图、工作台与组织设置；不含周期汇总、导出与推送、AI 总结、智能表导入、工作项评论与 `[[ ]]`、看板拖动 | Task 1–16（没有汇总、导出、推送、导入的代码；工作项描述关闭 `[[ ]]`；看板只读） |
| §2 用户已确认的决定（工作项、暂停、阻塞项、进展记录、跟进范围、工作项归属与编号、两档老化与无进展、历史数据、方案 A） | Task 1（老化）、2（方案 A 的表结构）、4（跟进范围与暂停）、5（工作项与阻塞项）、6（进展记录） |
| §3.1 需求五列与「跟进中」、内置字段「类型」 | Task 2、3、4 |
| §3.2 工作项与「工作类型」 | Task 2、3、5 |
| §3.3 进展记录 | Task 2、6 |
| §3.4 阻塞项挂工作项 | Task 2、5 |
| §3.5 组织设置阈值 | Task 1、7、15 |
| §3.6 迁移（表、RLS、回填、内置字段） | Task 2、3、18 |
| §3.7 停留、在制、老化、无进展，按组织时区 | Task 1、7 |
| §3.8 通知 | Task 8 |
| §4.1 主导航「跟进」、筛选与地址栏、新建工作项、四个页签、写进展与保留跟进人 | Task 11、12 |
| §4.2 需求详情跟进区块与进展记录页签 | Task 4、13 |
| §4.3 工作项新建与详情 | Task 5、12、14 |
| §4.4 工作台 | Task 9、15 |
| §4.5 组织设置「跟进」 | Task 7、15 |
| §4.6 1440 与 760 不横向滚动，表格容器内滚动、标题列固定 | Task 12–16 |
| §5 权限、Token、`withOrg` 与可见产品过滤、接口、领域事件 | Task 4–10 |
| §6 单元、接口、端到端、迁移核对、性能、界面复验 | Task 1–17、18 |

- 占位检查：计划中没有「待定」「以后实现」或只描述不给代码的步骤。`2026-10-XX` 是协作日志条目的日期，`<你的账号邮箱>` 是控制方执行 perf 时的输入，Task 18 的实际测量值与复验结论由控制方填写。
- 名称一致性：`TrackingSettings`、`DEFAULT_TRACKING_SETTINGS`、`trackingSettingsOf`、`TRACKED_CATEGORIES`、`CLOSED_CATEGORIES`、`pauseIntervals`、`activeDays`、`agingLevel`、`isStale`、`backfillTrackedSinceTx`、`workItems`、`progressUpdates`、`WORK_ITEM_STATUSES`、`WorkItemRow`、`WorkItemAccess`、`canViewUnlinked`、`canWriteUnlinked`、`canEditUnlinked`、`canEditAt`、`workItemAccessTx`、`requireWorkItemAccess`、`loadWorkItemTx`、`RequirementTracking`、`trackingView`、`assertPauseReason`、`autoTrackTx`、`setExpectedDateTx`、`joinTracking`、`leaveTracking`、`setRequirementExpectedDate`、`pauseRequirement`、`resumeRequirement`、`workItemDisplayKey`、`parseWorkItemKey`、`WorkItemStatus`、`WORK_ITEM_STATUS_LABELS`、`WorkItemDetail`、`WorkItemInput`、`WorkItemPatch`、`createWorkItem`、`getWorkItemByKey`、`updateWorkItem`、`setWorkItemStatus`、`pauseWorkItem`、`resumeWorkItem`、`deleteWorkItem`、`createWorkItemBlocker`、`ProgressSubject`、`ProgressView`、`listProgress`、`createProgress`、`updateProgress`、`deleteProgress`、`RECENT_DONE_DAYS`、`TrackingFilter`、`TrackingItem`、`TrackingList`、`getTracking`、`getTrackingSettings`、`updateTrackingSettings`、`eligibleMembersTx`（`excludeGuests`）、`WorkbenchFollowUp`、`registerTrackingRoutes`、`trackingKeys`、`useTracking`、`useTrackingSettings`、`useWorkItem`、`useProgress`、`filterFromParams`、`filterQuery`、`trackingHref`、`hasFilter`、`itemHref`、`agingRows`、`staleRows`、`boardColumns`、`ownerGroups`、`targetOf`、`ProgressTarget`、`AgingDays`、`StageLabel`、`LatestProgress`、`WriteButton`、`WriteProgressDialog`、`CreateWorkItemDialog`、`TrackingFilterBar`、`AllTable`、`AgingView`、`BoardView`、`OwnerGroups`、`PauseDialog`、`ProgressList`、`TrackingPanel`、`WorkItemBlockers`、`subjectHref`、`trackingWorkflow`、`applyTrackingWorkflow` 在定义与使用处一致。web 的 `WORK_ITEM_STATUS_LABELS`、`TrackingFilter` 在 `features/tracking/model.ts` 里另行定义，页面只从该文件导入，不与 `@flower/core` 的同名导出混用。
- 依赖顺序：Task 2 用 Task 1；Task 3 用 Task 2；Task 4 用 Task 1、2；Task 5 用 Task 3、4；Task 6 用 Task 4、5；Task 7 用 Task 1、4–6；Task 8 用 Task 4–6；Task 9 用 Task 4–6；Task 10 用 Task 4–8；Task 11 用 Task 4–10 的类型与接口；Task 12–15 用 Task 11（Task 13 用 Task 12 的写进展小窗，Task 14 用 Task 13 的进展列表与暂停小窗）；Task 16 用 Task 12–15；Task 17 用 Task 7；Task 18 收尾。
- 包入口：`tracking/aging`、`access`、`requirement-tracking`、`work-items`、`progress`、`tracking`、`settings` 依次在 Task 4–7 加入 `src/index.ts`，导出的名字与已有导出不重名（写计划时已检索）。
