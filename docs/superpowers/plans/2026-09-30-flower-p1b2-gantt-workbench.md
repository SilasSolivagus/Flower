# Flower P1-B2 甘特、人员负载、评审表与工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让迭代可以按 push 的方式排期和跟踪：任务的增删改与重点标记、按工作日推算的进度与迭代概览、甘特页签（行内编辑、只读时间轴、团队负载热力图）、跨迭代的人员负载；按流程检查项生成的批量评审表；登录后默认进入的跨组织工作台；补齐 P0-B 以来暂缓的统一错误状态；最后用生产数据副本做性能验证、新旧日常操作对比和用户试用脚本。

**Architecture:** 不新增表；只新增一个迁移（Task 13：`requirement_assignments` 的唯一约束）。`tasks` 表在 P1-A 已建好并开启 RLS，现有索引（`tasks_iteration`、`tasks_assignee`、`requirements_owner`、`comments_target`、`comment_reads` 主键、`check_item_results_target_item`）覆盖本计划的查询。排期与进度是纯函数（`packages/core/src/tasks/schedule.ts`），同时作为浏览器安全的子路径 `@flower/core/schedule` 供页面使用；任务服务、评审队列、工作台放在 `packages/core/src/{tasks,reviews,workbench}/`，签名 `(db, actor, …)`（工作台为 `(db, accountId)`），在 `withOrg` 事务里读写并在同一事务调用 `recordEvent`。工作台的跨组织读取先用 `listMyOrganizations`（`withSystem`，属于「成员关系查找」）列出成员身份，再逐个组织各开一个 `withOrg` 事务。HTTP 层新增 `tasks.ts`、`reviews.ts`、`workbench.ts` 三个路由文件。页面沿用 P1-A/B1 写法（客户端组件 + TanStack Query + `/api/v1`）。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui（Radix）、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§2.2 权限、§2.3 只读 Token、§3.1 检查项与会签、§4.4 任务、§4.5 评论已读、§6.1 领域事件、§6.6 指标数据来源、§7.2 甘特任务迁移、§8 P1 用生产数据副本验证）。范围由用户在 2026-09-29 确认（P1-B 拆为 B1 / B2，B1 已以 PR #6 合并，本计划只做 B2），逐条决定见下方「设计决定」。

## Global Constraints

- 生产数据副本、对照表、对账报告只放在 `.local-data/`（已在 `.git/info/exclude` 忽略），任何含员工姓名或邮箱的文件不得提交。测试夹具、端到端用例、文档示例只用虚构姓名和 `@example.com` 邮箱；验证记录只写数量与耗时，不写姓名、邮箱或需求标题。
- 本计划不新增表；迁移只有 Task 13 的 `requirement_assignments_unique` 唯一约束。执行中如发现还必须改表结构或加索引，停下来报告；确需加索引时按 `CLAUDE.md` 执行 `pnpm --filter @flower/core db:generate`，自定义迁移按现有编号接在 `0007` 之后；新租户表带 `org_id` 并在新的自定义迁移里开启 RLS（参照 `0002_rls.sql`）。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`，一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写；写操作同事务调用 `recordEvent`，修改类事件 payload 带 `changes: [{field, old, new}]`。`withSystem` 只用于登录、成员关系查找、Token 认证、邀请接受；跨组织汇总时每个组织各开一个 `withOrg` 事务，绝不在一个 RLS 上下文里混读多个组织。
- 权限按 spec §2.2：产品编辑及以上可以增删改需求、迭代、任务；只读成员只读。产品内写操作用 `requireProductRole(tx, actor, productId, 'editor' | 'admin')`（或同义的 `productRoleOf` + `atLeast`）。只读 Token 在 `capByScope` 中被降为 viewer、在 `isOrgAdmin` 中返回 false，因此写操作自动拒绝只读 Token；签字、评论、标记已读另外显式拒绝只读 Token（spec §2.3）。
- 同时锁迭代和需求（或任务）时，先锁迭代、后锁其他行：开始迭代对迭代加 `FOR UPDATE`，加入迭代先对迭代加 `FOR SHARE` 再锁需求；本计划新增的任务写操作同样先锁迭代、再锁任务。
- 面向用户的文案与错误信息用中文，错误通过 `AppError(code, message, details?)` 抛出。
- `apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema` 和本计划新增的 `@flower/core/schedule`。纯逻辑放 `apps/web/src/features/**/model.ts` 并写 Vitest 单测。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`。用渲染期间调整（记住上次同步的来源值，初值为空 / `undefined`，来源变了就在渲染时同时更新同步值和表单状态，参照 `apps/web/src/app/(app)/[org]/settings/general/page.tsx`），或用以服务端值为 `key` 的非受控输入框（`defaultValue` + `key`），保存成功后服务端值变化会让输入框重新挂载。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框和内联表单用 `silentError: true` + `<FormError error={mutation.error} />`。不留未处理的 `mutateAsync` 拒绝。
- 页面加载失败：404 / 403 显示 `NoAccess`，其他错误（含 5xx、网络失败）显示「重试」按钮。统一用 `components/load-error.tsx` 的 `LoadError` / `QueryError`（Task 8 新增 `QueryError`）。
- 复用已有的共享件：`components/load-error.tsx`；e2e `helpers.ts`（`ok`、`json`、`createProduct`、`createRequirement`、`setupInstance`、`login`，本计划再加 `createIteration`、`createTask`、`applyReviewWorkflow`）；成员相关的 `canListMembers`、`activePeople`（`features/members/model.ts`）。不在文件之间复制逻辑块：第一次需要共享时就抽到 `model.ts` 或共享组件里。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0`（CI 已加入，零错误零警告）。
- 视觉沿用 P0-B：表格行高 40px、隔行底色 `even:bg-zebra`、编号与日期用等宽字体（`font-mono`）、卡片圆角 6px、按钮与输入框圆角 4px、页面标题 20px。
- 端到端测试：每个 spec 自己在 `beforeEach` 或用例开头调用 `resetDatabase()`；不为迁就定位器修改应用或共享组件代码；Radix 弹出内容用 `page` 定位；`role="alert"` 用 `.filter({ hasText })` 限定；断言「重试」一类由 5xx 触发的界面时加 `{ timeout: 15_000 }`（查询对 5xx 会自动重试两次）；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染。端到端占用 3100 端口，不要与 `pnpm dev` 同时运行。改动落地页、导航或共享组件的任务，要在同一任务里改好受影响的现有 spec。
- `pnpm test` 和端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；之后要跑 `pnpm dev`、迁移导入或性能测量，先执行 `pnpm db:migrate`。
- 每个 commit message 末尾加一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）。

## 设计决定

| 项 | 决定 | 依据 |
|---|---|---|
| 范围 | P1-B 拆为 B1（PR #6 已合并）与 B2（本计划）：任务与甘特、人员负载、批量评审表、工作台、界面打磨、新旧对比、真实数据验证与用户试用 | 用户 2026-09-29 决定 |
| 甘特进度算法 | 沿用 push 的工作日算法：`workdaysElapsed` 从开始日（不含）数到今天（含），跳过周六日；理论进度 = 已过工作日 ÷ max(1, 工期 + 延期)；展示进度：已完成 = 100，手动进度优先，没有开始日期 = 0 | 用户决定；push `src/core/progress.ts` |
| 默认落地页 | 登录后进入工作台 | 用户决定 |
| 评审表 | 按产品当前流程里 `scope = requirement` 的检查项生成列，不写死 push 的 7 项 | 用户决定；spec §3.1 |
| 任务标记（flag）取值 | Flower 只有一个标记值 `attention`（界面显示「关注」），`null` 为正常。迁移映射：`正常` / 空 → `null`，`关注` → `attention`，`延期` → `null`（push 界面已不提供「延期」标记，延期由延期天数表示）；其他取值报迁移问题并阻止写入 | 开发库 pan123 的 363 条 push 任务：正常 349、关注 12、延期 2；push `Versions.tsx` 的 FLAGS 只有「正常」「关注」 |
| 手动进度 | 存在 `tasks.meta.progress`（0–100 的整数，`null` 表示按工期推算）。迁移：push 的 `ov_progress ≥ 0` 优先，其次是数字形式的 `actual_status`；`actual_status = 已完成` 的任务状态记为已完成。开发库需要按新规则重导 pan123 | 简报；开发库中 `actualStatus` 全为空，有效的覆盖值都在 `ovProgress`（`-1` 表示无），迁移原样存在 `meta.ovProgress` 但没有 `meta.progress` |
| 任务说明 | 存在 `tasks.meta.note`（≤ 200 字，迁移已写入 push 的 note）；界面叫「说明」 | 表没有 note 列，不新增列；push 限 60 字，Flower 放宽 |
| 迭代概览的聚合 | 有需求的任务按需求聚合为一行，没有需求的按标题（去首尾空白）聚合；行进度 = 各任务展示进度的平均；「关注」且未完成的行不计入整体进度，计为遗留；理论进度按迭代开始到结束日的工作日比例；落后 = max(0, 理论 − 整体)；「关注」行和写了说明的正常行进入关注与周知列表（按标题去重）。不带 push 写死的排除标题（bugfix、集成测试、测试用例编写）和「推广分佣」合并规则 | push `src/core/overview.ts`；写死的名称属于 123云盘 专属内容（spec §0），与 push 的数字会有差异，在对比文档里说明 |
| 「今天」 | 服务端按组织时区（`organizations.settings.timezone`，未设置时 `Asia/Shanghai`，与组织信息页默认值一致）计算；服务函数接受可选的 `today` 供测试固定日期 | spec §1 时间约定 |
| 重点上限 | 每个迭代最多 10 个重点任务，超出返回 `conflict`「每个迭代最多 10 个重点任务」；标为重点时对迭代行加 `FOR UPDATE` 再计数，并发请求不会超限；没有迭代的任务不能标为重点 | 简报；push 的「每版最多 10」 |
| 任务的归属 | 任务至少属于一个迭代或一条需求；产品取自需求，其次取自常规迭代，专项里没有需求的任务必须指定产品；只能在规划中或进行中的迭代里新建；新建后不改所属迭代与需求 | 简报（允许无需求的手工任务）；spec §4.4 |
| 删除任务 | 硬删除（`tasks` 表没有 `deleted_at`），`task.deleted` 事件保存标题、需求与迭代 | 不新增列；领域事件即审计日志（spec §6.1） |
| 删除迭代的附加条件 | 迭代里还有任务时不能删除（「迭代中还有任务，请先删除」） | B1 只检查需求与发布版本；本计划起规划中的迭代可以有手工任务，不拦会留下指向已删除迭代的任务 |
| 时间轴与热力图的覆盖规则 | 一个任务占用 `[开始日, 开始日 + max(0.5, 工期 + 延期))` 内的自然日（工期为空或 0 按半天），按工作日列显示；时间轴区分计划内与延期部分；热力图单元格 = 当天被占用的任务数，按与最大值之比分 5 档；人员按姓名排序 | 简报；push `components/Heatmap.tsx`（push 写死的人员顺序不带） |
| 排期纯函数的位置 | `packages/core/src/tasks/schedule.ts`，不依赖数据库或 Node API；`package.json` 增加子路径导出 `@flower/core/schedule`，`CLAUDE.md` 的约定同步 | 服务端返回进度，页面画时间轴和热力图用同一套规则，避免两份实现 |
| 按人查看跨迭代负载的位置 | 新页面 `/[org]/workload?member=<id>`，从甘特热力图的姓名和迭代列表页「人员负载」按钮进入，导航高亮「迭代」，不加导航项；默认列出规划中和进行中迭代里的任务以及不在迭代中的未完成任务，可切换「包含已结束的迭代」；顶部显示从今天起 4 周的负载条 | 故事地图「按人查看跨迭代负载」；简报要求最小实现 |
| 评审队列的行 | 产品内状态类别不是已完成 / 已取消的需求；默认只列整体评审状态不是「已通过」的（即至少一个检查项不在终态，与简报一致），可按整体状态、单个检查项的状态、「等我签字」筛选；统计栏按整体状态计数 | 简报；已上线、已拒绝的需求不再需要评审 |
| 整体评审状态 | 忽略「不需要」的检查项后：任一驳回 = 有驳回；全部通过 = 已通过；全部未开始 = 未开始；其余为评审中；没有需要评审的检查项视为已通过 | 统计栏需要一个确定的归类 |
| 「等我签字」的判定 | 会签检查项处于未开始或进行中、该签字规则还没有任何签字记录、且这条需求的评审已经开始（任一检查项不在其默认状态）时才推送，并且「该谁签字就推给谁」：`function_tag` 规则只推给持有该标签、且在 `requirement_assignments` 里以该标签分配到这条需求的成员；需求上没有该标签的分配时退回为推给全部持有者；`member` 规则推给指定成员；`product_role` 规则推给持有该角色的人。产品管理员对「指定成员」类规则（不是本人）算「可代签」，不受分配影响；只读 Token 没有待签。评审队列与工作台用同一判定（`waitingRules`） | 简报要求含代签；用户 2026-09-30 补充「该谁签字就推给谁」。pan123 有 383 条未完成需求，只有 76 条有检查项记录，不加「评审已开始」条件时每位设计都会看到三百多条待签。pan123 的会签标签是设计、线条负责人、产品负责人；2026-09-30 查开发库，`requirement_assignments` 共 143 条，全部是「开发」标签（`plan-requirements.ts` 只从 123plane 的开发分配生成），未完成需求中有设计分配的为 0 条（有任何分配的也只有 1 条），所以真实数据上目前全部走「推给全部持有者」的回退 |
| 工作台路由 | `/[org]` 为工作台（跨组织内容，其他组织的行带组织名）；原概览页移到 `/[org]/overview`；导航依次为 工作台、概览、需求、迭代、评审、文档；`/` 在有组织时跳到第一个组织的工作台，没有组织时仍显示原页面的新建组织入口 | 工作台放在组织壳里才有侧边导航；内容本身跨组织，从哪个组织进入都一样；组织切换器已提供切换和新建组织 |
| 跨组织读取 | 接口 `GET /api/v1/me/workbench` 只接受会话（Token 绑定单个组织，返回 401）；先 `listMyOrganizations`（`withSystem`）列出在职成员身份，再按组织逐个 `withOrg` 读取，以该组织的成员身份计算权限 | 简报；CLAUDE.md 对 `withSystem` 的限定 |
| 工作台的四个区块 | 我负责的需求（状态类别不是已完成 / 已取消）；指派给我的任务（未完成，排除已取消或已删除迭代里的任务）；等我签字（含可代签）；我负责的需求上别人发的、我未读的评论（按需求合计）。每块最多 100 条并给出总数 | 简报 |
| 索引与迁移 | 查询不新增索引；只为需求分配新增唯一约束 `requirement_assignments_unique`（`requirement_id, member_id, function_tag_id, platform_option_id`，`NULLS NOT DISTINCT`），迁移 `0008_*.sql` 由 `db:generate` 生成 | 上文 Architecture 列出的现有索引已覆盖查询；分配原来没有唯一约束，服务层拦不住并发的重复分配。2026-09-30 检查开发库，按这四列分组没有重复行（含 pan123 的 143 条），迁移可以直接执行 |
| 需求分配的维护 | 新增 `addRequirementAssignment` / `removeRequirementAssignment`（产品编辑及以上，只读 Token 被拒绝）：成员必须在职，职能标签必须属于本组织，平台选项必须属于本产品当前生效的「平台」字段；重复返回 `conflict`「已经有相同的分配」。需求详情的「分配」区块提供新增（职能、成员、可选平台）与删除，只读成员和访客只能查看；修改后刷新需求详情、评审表和工作台 | 用户 2026-09-30 批准；「等我签字」按分配推送（见上一行），分配必须可以在界面上维护。原侧栏的只读「开发分配」块由新区块取代 |
| 统一错误状态 | `lib/api.ts` 把 `fetch` 的网络异常包装为 `ApiError(0, 'network', '网络连接失败，请检查网络后重试')`，查询对它和 5xx 一样自动重试；`components/load-error.tsx` 增加 `QueryError`（403 / 404 → `NoAccess`，其他 → 重试）；AuthGate、组织外壳、产品设置、流程编辑、需求详情、迭代详情改用它；`/admin` 对非实例管理员只保留一个一级标题；流程发布对话框与职能标签排序不再留下未处理的 `mutateAsync` 拒绝 | 记忆中 P0-B 暂缓项，逐条在代码中核实仍存在（见 Task 8）；「非管理员的产品卡片链接回本页」已在 B1 修复，不再处理 |
| 概览页加载闪空 | 移到 `/[org]/overview` 时，产品列表加载中显示骨架，失败显示重试 | P0-B 暂缓项，代码中产品未加载时渲染空网格 |
| 检查项组件 | `requirements/[key]/check-items.tsx` 移到 `components/check-items.tsx`，需求详情和评审表展开行共用（含本人签字与代签对话框） | 简报要求复用 P1-A 的签字服务与详情组件 |
| 评审表的筛选 | 产品、整体状态、检查项及其状态、「等我签字」保存在页面状态里，不写入 URL | 最小实现；写入 URL 留给后续 |
| 留给后续阶段 | 需求换迭代时任务跟随；甘特拖拽编辑（P2+）；push 概览的派生状态（待开发 / 已提测 / 测试中，迁移保存在 `meta.ovStatus`）与写死的排除和合并规则；`phase` 字段的界面（接口已支持）；评审表筛选写入 URL；工作台分页；待签与未读的消息提醒（P3 通知）；PRD 文档（P2）；管理员数据看板（P3/P6）；`visibleProductIds` 的 N+1 查询（B1 审查记录） | 简报「Out of scope」；本计划的最小实现边界 |

## 文件结构

```
packages/core/
  package.json                               # 子路径导出 ./schedule（Task 1）
  src/tasks/schedule.ts                      # 工作日、进度、覆盖规则、热力图色阶、迭代概览、组织当天日期（Task 1）
  src/tasks/tasks.ts                         # 任务新建、修改、删除，重点上限，hydrateTasks，orgToday（Task 2）
  src/tasks/queries.ts                       # 甘特（按迭代）、按需求、按人跨迭代（Task 3）
  src/iterations/iterations.ts               # 导出 loadVisibleIteration / stateInfoByProduct / stateOf；删除迭代检查任务（Task 2、3）
  src/requirements/workflow-runtime.ts       # 整体评审状态、评审是否开始、会签进度、待签规则（Task 5）
  src/reviews/snapshot.ts                    # 检查项快照、签字人身份（Task 5；detail.ts 改用）
  src/reviews/queue.ts                       # 评审队列（Task 5）
  src/requirements/detail.ts                 # 改用 reviews/snapshot 的 signerIdentity（Task 5）
  src/workbench/workbench.ts                 # 跨组织工作台（Task 6）
  src/requirements/assignments.ts            # 需求分配的新增与删除（Task 13）
  src/db/schema.ts  migrations/0008_*.sql    # requirement_assignments 唯一约束（Task 13）
  src/index.ts                               # 导出（Task 1–6、13）
  test/schedule.test.ts  test/tasks.test.ts  test/task-queries.test.ts
  test/review-runtime.test.ts  test/review-queue.test.ts  test/workbench.test.ts
  test/factories.ts                          # reviewWorkflow（Task 5）
packages/migrate/
  src/workflow-v1.ts  src/plan-requirements.ts  test/plan-requirements.test.ts   # 标记与手动进度映射（Task 4）
  src/perf.ts  test/perf.test.ts             # 性能用例（Task 15）
apps/web/
  src/server/routes/tasks.ts  reviews.ts  workbench.ts  src/server/api.ts        # 接口（Task 7）
  test/api/tasks.test.ts  test/api/reviews-workbench.test.ts
  src/lib/api.ts  api.test.ts  src/app/providers.tsx                             # 网络错误、重试策略（Task 8）
  src/components/load-error.tsx  auth-gate.tsx  org-shell.tsx                    # 统一错误状态（Task 8）
  src/lib/types.ts  src/lib/queries.ts  src/lib/labels.ts                        # Task 9–12 逐步增加
  src/features/gantt/model.ts  model.test.ts                                     # 输入解析、热力图行、时间轴格子、负载分组（Task 9、10）
  src/features/reviews/model.ts  model.test.ts                                   # 评审筛选与单元格文字（Task 11）
  src/features/workbench/model.ts  model.test.ts                                 # 工作台链接（Task 12）
  src/features/shell/nav.ts  nav.test.ts                                         # 评审、工作台、概览、负载页高亮（Task 10–12）
  src/components/load-heatmap.tsx                                                # 负载热力图（Task 10）
  src/components/check-items.tsx                                                 # 从需求详情移出（Task 11）
  src/app/(app)/[org]/iterations/[id]/page.tsx  gantt-tab.tsx  task-row.tsx  timeline.tsx
  src/app/(app)/[org]/workload/page.tsx  src/app/(app)/[org]/reviews/page.tsx
  src/app/(app)/[org]/page.tsx（工作台）  src/app/(app)/[org]/overview/page.tsx（概览）  src/app/(app)/page.tsx
  e2e/helpers.ts  e2e/error-states.spec.ts  e2e/gantt.spec.ts  e2e/workload.spec.ts  e2e/reviews.spec.ts  e2e/workbench.spec.ts
  e2e/overview.spec.ts  e2e/acceptance.spec.ts  e2e/product-admin.spec.ts        # 落地页变化后同步（Task 12）
  src/app/(app)/[org]/requirements/[key]/assignments.tsx  e2e/requirement-assignments.spec.ts   # 需求分配（Task 13）
CLAUDE.md                                    # 浏览器安全子路径（Task 1）
docs/p1b-comparison.md                       # 日常操作新旧对比（Task 14）
docs/p1b-validation.md  docs/handoff.md  docs/agent-log.md                       # Task 15、16
```

---
### Task 1: 排期纯函数：工作日、进度、覆盖规则、热力图色阶、迭代概览（`@flower/core/schedule`）

**Files:**
- Create: `packages/core/src/tasks/schedule.ts`
- Modify: `packages/core/package.json`（`exports` 增加 `"./schedule"`）
- Modify: `packages/core/src/index.ts`
- Modify: `CLAUDE.md`（约定里的浏览器安全子路径）
- Test: `packages/core/test/schedule.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，不导入任何模块）
- Produces（`tasks/schedule.ts`，同时可从 `@flower/core` 与 `@flower/core/schedule` 导入）：
  - `STARRED_LIMIT = 10`
  - `TASK_FLAGS = ['attention'] as const`；`type TaskFlag = 'attention'`
  - `dayNumber(date: string): number`、`dateOfDay(n: number): string`、`isWeekend(n: number): boolean`
  - `workdaysElapsed(planStart: string, today: string): number`
  - `theoreticalProgress(planStart: string, planDays: number | null, delayDays: number | null, today: string): number`
  - `type ProgressInput = { status: 'todo' | 'doing' | 'done'; planStart: string | null; planDays: number | null; delayDays: number | null; progressOverride: number | null }`
  - `displayProgress(t: ProgressInput, today: string): number`
  - `workdaysBetween(start: string, end: string): string[]`
  - `type ScheduleInput = { planStart: string | null; planDays: number | null; delayDays: number | null }`
  - `coverKind(t: ScheduleInput, day: string): 'plan' | 'delay' | null`
  - `loadCounts(tasks: ScheduleInput[], days: string[]): number[]`
  - `heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4`
  - `type OverviewTask = ProgressInput & { requirementId: string | null; title: string; flag: TaskFlag | null; note: string | null; assigneeName: string | null }`
  - `type IterationOverview = { rowCount: number; countedCount: number; overall: number; expected: number; behind: number; deferred: number; attention: Array<{ kind: 'attention' | 'notice'; title: string; assignees: string[]; note: string }> }`
  - `iterationOverview(tasks: OverviewTask[], iteration: { startDate: string; endDate: string }, today: string): IterationOverview`
  - `todayInZone(timeZone: string, now?: Date): string`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/schedule.test.ts`（日期对应的星期：2026-09-24 周四、25 周五、26 周六、27 周日、28 周一、30 周三、10-02 周五、10-09 周五）：

```ts
import { describe, expect, it } from 'vitest';
import {
  coverKind,
  displayProgress,
  heatLevel,
  iterationOverview,
  loadCounts,
  type OverviewTask,
  theoreticalProgress,
  todayInZone,
  workdaysBetween,
  workdaysElapsed,
} from '../src/tasks/schedule';

const task = (over: Partial<OverviewTask>): OverviewTask => ({
  status: 'doing',
  planStart: null,
  planDays: null,
  delayDays: null,
  progressOverride: null,
  requirementId: null,
  title: '任务',
  flag: null,
  note: null,
  assigneeName: null,
  ...over,
});

describe('工作日', () => {
  it('从开始日（不含）数到今天（含），跳过周六日；今天不晚于开始日时为 0', () => {
    expect(workdaysElapsed('2026-09-24', '2026-09-24')).toBe(0);
    expect(workdaysElapsed('2026-09-24', '2026-09-28')).toBe(2);
    expect(workdaysElapsed('2026-09-25', '2026-09-27')).toBe(0);
    expect(workdaysElapsed('2026-09-28', '2026-09-24')).toBe(0);
  });

  it('区间内的工作日（含两端）', () => {
    expect(workdaysBetween('2026-09-24', '2026-09-30')).toEqual(['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']);
    expect(workdaysBetween('2026-09-26', '2026-09-27')).toEqual([]);
  });

  it('组织时区的当天日期', () => {
    const now = new Date('2026-09-30T17:00:00Z');
    expect(todayInZone('Asia/Shanghai', now)).toBe('2026-10-01');
    expect(todayInZone('UTC', now)).toBe('2026-09-30');
  });
});

describe('进度', () => {
  it('理论进度 = 已过工作日 ÷ max(1, 工期 + 延期)，半天任务按 1 天算', () => {
    expect(theoreticalProgress('2026-09-24', 4, 0, '2026-09-28')).toBe(50);
    expect(theoreticalProgress('2026-09-24', 4, 1, '2026-09-28')).toBe(40);
    expect(theoreticalProgress('2026-09-24', 0.5, null, '2026-09-24')).toBe(0);
    expect(theoreticalProgress('2026-09-24', 0.5, null, '2026-09-25')).toBe(100);
    expect(theoreticalProgress('2026-09-24', 1.5, 0, '2026-09-25')).toBe(67);
    expect(theoreticalProgress('2026-09-24', 2, 0, '2026-10-09')).toBe(100);
  });

  it('展示进度：已完成 = 100，手动进度优先（取整并限制在 0–100），没有开始日期 = 0', () => {
    const base = { planStart: '2026-09-24', planDays: 4, delayDays: 0 };
    expect(displayProgress({ ...base, status: 'done', progressOverride: 30 }, '2026-09-28')).toBe(100);
    expect(displayProgress({ ...base, status: 'doing', progressOverride: 42.4 }, '2026-09-28')).toBe(42);
    expect(displayProgress({ ...base, status: 'doing', progressOverride: 150 }, '2026-09-28')).toBe(100);
    expect(displayProgress({ ...base, planStart: null, status: 'todo', progressOverride: null }, '2026-09-28')).toBe(0);
    expect(displayProgress({ ...base, status: 'doing', progressOverride: null }, '2026-09-28')).toBe(50);
  });
});

describe('覆盖规则与热力图', () => {
  it('按自然日覆盖 [开始, 开始 + max(0.5, 工期 + 延期))，区分计划内与延期', () => {
    const t = { planStart: '2026-09-24', planDays: 2, delayDays: 1 };
    expect(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'].map((d) => coverKind(t, d))).toEqual(['plan', 'plan', 'delay', null]);
    expect(coverKind({ planStart: '2026-09-24', planDays: 0.5, delayDays: null }, '2026-09-24')).toBe('plan');
    expect(coverKind({ planStart: '2026-09-24', planDays: null, delayDays: null }, '2026-09-25')).toBeNull();
    expect(coverKind({ planStart: null, planDays: 3, delayDays: 0 }, '2026-09-24')).toBeNull();
  });

  it('周五开始的 5 天任务在工作日列上只占周五、周一、周二', () => {
    const days = workdaysBetween('2026-09-24', '2026-09-30');
    const friday = { planStart: '2026-09-25', planDays: 5, delayDays: 0 };
    const thursday = { planStart: '2026-09-24', planDays: 1, delayDays: 0 };
    expect(loadCounts([friday], days)).toEqual([0, 1, 1, 1, 0]);
    expect(loadCounts([friday, thursday], days)).toEqual([1, 1, 1, 1, 0]);
  });

  it('色阶按与最大值之比分 5 档', () => {
    expect([0, 1, 2, 3, 4].map((c) => heatLevel(c, 4))).toEqual([0, 1, 2, 3, 4]);
    expect(heatLevel(1, 0)).toBe(4);
  });
});

describe('迭代概览', () => {
  const sprint = { startDate: '2026-09-28', endDate: '2026-10-09' };

  it('按需求（无需求按标题）聚合；关注且未完成的不计入整体进度；关注与周知按标题去重', () => {
    const o = iterationOverview(
      [
        task({ requirementId: 'r1', title: 'PAN-1 上传提速', status: 'done' }),
        task({ requirementId: 'r1', title: 'PAN-1 上传提速', progressOverride: 50, assigneeName: '开发乙' }),
        task({ requirementId: 'r2', title: 'PAN-2 分享统计', flag: 'attention', progressOverride: 20 }),
        task({ title: '联调', progressOverride: 40, note: '等待接口' }),
        task({ title: ' 联调 ', progressOverride: 60 }),
        task({ requirementId: 'r3', title: 'PAN-3 回收站', flag: 'attention', status: 'done' }),
        task({ title: '  ' }),
      ],
      sprint,
      '2026-10-02',
    );
    expect(o).toEqual({
      rowCount: 4,
      countedCount: 3,
      overall: 75,
      expected: 44,
      behind: 0,
      deferred: 1,
      attention: [
        { kind: 'attention', title: 'PAN-2 分享统计', assignees: [], note: '' },
        { kind: 'notice', title: '联调', assignees: [], note: '等待接口' },
        { kind: 'attention', title: 'PAN-3 回收站', assignees: [], note: '' },
      ],
    });
  });

  it('落后 = 理论进度 − 整体进度；迭代结束后理论进度为 100；没有可计入的行时整体为 0', () => {
    expect(iterationOverview([task({ title: '埋点', progressOverride: 10 })], sprint, '2026-10-02')).toMatchObject({ overall: 10, expected: 44, behind: 34 });
    expect(iterationOverview([task({ title: '埋点', progressOverride: 10 })], sprint, '2026-10-20')).toMatchObject({ expected: 100, behind: 90 });
    expect(iterationOverview([], sprint, '2026-10-02')).toMatchObject({ rowCount: 0, overall: 0, behind: 44, deferred: 0 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/schedule.test.ts`
Expected: FAIL，找不到模块 `../src/tasks/schedule`。

- [ ] **Step 3: 实现**

`packages/core/src/tasks/schedule.ts`：

```ts
/**
 * 排期与进度的纯函数。服务端（进度、概览）与浏览器（时间轴、热力图）共用：
 * 通过 `@flower/core/schedule` 导入，因此本文件不能导入任何其他模块。日期一律为 YYYY-MM-DD。
 */

export const STARRED_LIMIT = 10;
export const TASK_FLAGS = ['attention'] as const;
export type TaskFlag = (typeof TASK_FLAGS)[number];

const DAY_MS = 86_400_000;

/** YYYY-MM-DD → 自 1970-01-01 起的天数（按 UTC 计算，不受运行环境时区影响）。 */
export function dayNumber(date: string): number {
  return Math.round(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS);
}

export function dateOfDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function isWeekend(n: number): boolean {
  const w = new Date(n * DAY_MS).getUTCDay();
  return w === 0 || w === 6;
}

/** 开始日（不含）到今天（含）之间的工作日数，跳过周六日；今天不晚于开始日时为 0。与 push 的算法一致。 */
export function workdaysElapsed(planStart: string, today: string): number {
  const end = dayNumber(today);
  let n = 0;
  for (let d = dayNumber(planStart) + 1; d <= end; d++) if (!isWeekend(d)) n++;
  return n;
}

/** 按工期（含延期）推算的理论进度，0–100 取整；工期不足 1 天按 1 天算。 */
export function theoreticalProgress(planStart: string, planDays: number | null, delayDays: number | null, today: string): number {
  const effective = Math.max(1, (planDays ?? 0) + (delayDays ?? 0));
  return Math.min(100, Math.max(0, Math.round((workdaysElapsed(planStart, today) / effective) * 100)));
}

export type ProgressInput = {
  status: 'todo' | 'doing' | 'done';
  planStart: string | null;
  planDays: number | null;
  delayDays: number | null;
  progressOverride: number | null;
};

/** 展示进度：已完成 = 100；手动进度优先；没有开始日期 = 0；否则按工作日推算。 */
export function displayProgress(t: ProgressInput, today: string): number {
  if (t.status === 'done') return 100;
  if (t.progressOverride !== null) return Math.min(100, Math.max(0, Math.round(t.progressOverride)));
  if (!t.planStart) return 0;
  return theoreticalProgress(t.planStart, t.planDays, t.delayDays, today);
}

/** start 到 end（都含）之间的工作日。 */
export function workdaysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const last = dayNumber(end);
  for (let d = dayNumber(start); d <= last; d++) if (!isWeekend(d)) out.push(dateOfDay(d));
  return out;
}

export type ScheduleInput = { planStart: string | null; planDays: number | null; delayDays: number | null };

/**
 * 某天是否被任务占用（push 热力图的规则）：占用 [开始日, 开始日 + max(0.5, 工期 + 延期)) 内的自然日，
 * 工期为空或 0 按半天。返回 'plan'（计划内）、'delay'（延期部分）或 null。
 */
export function coverKind(t: ScheduleInput, day: string): 'plan' | 'delay' | null {
  if (!t.planStart) return null;
  const start = dayNumber(t.planStart);
  const d = dayNumber(day);
  const plan = t.planDays || 0.5;
  const span = Math.max(0.5, plan + (t.delayDays || 0));
  if (d < start || d >= start + span) return null;
  return d < start + plan ? 'plan' : 'delay';
}

/** 每个工作日上被占用的任务数。 */
export function loadCounts(tasks: ScheduleInput[], days: string[]): number[] {
  return days.map((day) => tasks.filter((t) => coverKind(t, day) !== null).length);
}

/** 热力图色阶 0–4（push 的规则）：0 = 没有任务；其余按与最大值之比分四档。 */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  const r = count / Math.max(1, max);
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
}

export type OverviewTask = ProgressInput & {
  requirementId: string | null;
  /** 行标题：有需求时由调用方传入「编号 标题」，没有需求时为任务标题。 */
  title: string;
  flag: TaskFlag | null;
  note: string | null;
  assigneeName: string | null;
};

export type IterationOverview = {
  rowCount: number;
  countedCount: number;
  overall: number;
  expected: number;
  behind: number;
  deferred: number;
  attention: Array<{ kind: 'attention' | 'notice'; title: string; assignees: string[]; note: string }>;
};

/**
 * 迭代概览（push 的 A 方案）：任务按需求聚合为行（没有需求的按标题），行进度为各任务展示进度的平均；
 * 标了「关注」且未完成的行视为遗留下期，不计入整体进度；理论进度按迭代的工作日比例。
 */
export function iterationOverview(tasks: OverviewTask[], iteration: { startDate: string; endDate: string }, today: string): IterationOverview {
  const groups = new Map<string, OverviewTask[]>();
  for (const t of tasks) {
    const title = t.title.trim();
    if (!title) continue;
    const key = t.requirementId ?? `title:${title}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const rows = [...groups.values()].map((segs) => ({
    title: segs[0]!.title.trim(),
    progress: Math.round(segs.reduce((sum, s) => sum + displayProgress(s, today), 0) / segs.length),
    attention: segs.some((s) => s.flag === 'attention'),
    note: segs.map((s) => (s.note ?? '').trim()).find((n) => n !== '') ?? '',
    assignees: [...new Set(segs.map((s) => s.assigneeName).filter((x): x is string => !!x))],
  }));
  const counted = rows.filter((r) => !(r.attention && r.progress < 100));
  const overall = counted.length ? Math.round(counted.reduce((sum, r) => sum + r.progress, 0) / counted.length) : 0;
  const total = workdaysElapsed(iteration.startDate, iteration.endDate);
  const expected = total > 0 ? Math.min(100, Math.max(0, Math.round((workdaysElapsed(iteration.startDate, today) / total) * 100))) : 0;
  const seen = new Set<string>();
  const attention: IterationOverview['attention'] = [];
  for (const r of rows) {
    if ((!r.attention && !r.note) || seen.has(r.title)) continue;
    seen.add(r.title);
    attention.push({ kind: r.attention ? 'attention' : 'notice', title: r.title, assignees: r.assignees, note: r.note });
  }
  return {
    rowCount: rows.length,
    countedCount: counted.length,
    overall,
    expected,
    behind: Math.max(0, expected - overall),
    deferred: rows.length - counted.length,
    attention,
  };
}

/** 某个时区的当天日期（YYYY-MM-DD）。 */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
```

`packages/core/package.json` 的 `exports` 在 `"./workflow-schema"` 之后加一行：

```json
    "./schedule": "./src/tasks/schedule.ts",
```

`packages/core/src/index.ts` 末尾追加：

```ts
export * from './tasks/schedule';
```

`CLAUDE.md`「约定」一节中这一行：

```markdown
- 页面是客户端组件，通过 `/api/v1` 取数；只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`。
```

改为：

```markdown
- 页面是客户端组件，通过 `/api/v1` 取数；只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`（这两个文件不能导入其他模块）。
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/schedule.test.ts` 与 `pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tasks/schedule.ts packages/core/package.json packages/core/src/index.ts packages/core/test/schedule.test.ts CLAUDE.md
git commit -m "feat(core): 排期纯函数：工作日进度、覆盖规则、热力图色阶与迭代概览

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: 任务服务：新建、修改、删除，重点上限，权限；删除迭代时检查任务

**Files:**
- Create: `packages/core/src/tasks/tasks.ts`
- Modify: `packages/core/src/iterations/iterations.ts`（`deleteIteration` 检查任务）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/tasks.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `displayProgress`、`STARRED_LIMIT`、`TASK_FLAGS`、`TaskFlag`、`todayInZone`；`atLeast`、`productRoleOf`、`requireProductRole`（`access/permissions.ts`）；`assertMemberInOrg`、`loadRequirement`、`memberNames`（`requirements/context.ts`）；`displayKey`、`MemberRef`（`requirements/requirements.ts`）；`assertIsoDate`（`dates.ts`）
- Produces（`tasks/tasks.ts`）：
  - `TASK_STATUSES = ['todo', 'doing', 'done'] as const`；`type TaskStatus`；`DEFAULT_TIMEZONE = 'Asia/Shanghai'`
  - `type TaskView = { id: string; productId: string; iterationId: string | null; requirement: { id: string; displayKey: string; title: string } | null; title: string; alias: string | null; assignee: MemberRef | null; status: TaskStatus; planStart: string | null; planDays: number | null; delayDays: number | null; phase: string | null; flag: TaskFlag | null; starred: boolean; note: string | null; progressOverride: number | null; progress: number; canEdit: boolean; updatedAt: Date }`
  - `type TaskPatch = { title?: string; alias?: string | null; assigneeMemberId?: string | null; status?: TaskStatus; planStart?: string | null; planDays?: number | null; delayDays?: number | null; phase?: string | null; flag?: TaskFlag | null; starred?: boolean; note?: string | null; progress?: number | null }`
  - `type TaskCreateInput = TaskPatch & { title: string; iterationId?: string | null; requirementId?: string | null; productId?: string | null }`
  - `createTask(db, actor, input: TaskCreateInput, opts?: { today?: string }): Promise<TaskView>`
  - `updateTask(db, actor, id: string, input: TaskPatch, opts?: { today?: string }): Promise<TaskView>`
  - `deleteTask(db, actor, id: string): Promise<void>`
  - `hydrateTasks(tx: Tx, actor: Actor, rows: Array<typeof tasks.$inferSelect>, today: string): Promise<TaskView[]>`（Task 3、6 使用）
  - `orgToday(tx: Tx, orgId: string): Promise<string>`（Task 3、6 使用）
- 事件：`task.created`（`title`、`requirementId`、`iterationId`）、`task.updated`（`changes`，字段名与 `TaskPatch` 一致）、`task.deleted`（`title`、`requirementId`、`iterationId`）；`subjectType = 'task'`，`productId` 为任务所属产品
- 错误：`invalid`「任务需要属于一个迭代或一条需求」「专项里的任务需要指定所属产品」「不能把任务放进其他产品的迭代」「只能在规划中或进行中的迭代里新建任务」「只有迭代里的任务可以标为重点」「任务名称不能为空，且不超过 200 个字符」「别名不超过 50 个字符」「工期以半天为单位，范围 0.5–365 天」「延期以半天为单位，范围 0–365 天」「阶段不超过 20 个字符」「说明不超过 200 个字符」「进度应为 0–100 的整数」「标记无效」「任务状态无效」「开始日期格式应为 YYYY-MM-DD」；`conflict`「每个迭代最多 10 个重点任务」；`not_found`「任务不存在」「迭代不存在」；`forbidden`「权限不足」；删除迭代新增 `invalid`「迭代中还有任务，请先删除」

- [ ] **Step 1: 写失败的测试**

`packages/core/test/tasks.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createIteration, deleteIteration, type IterationView, setIterationStatus } from '../src/iterations/iterations';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { createTask, deleteTask, type TaskCreateInput, updateTask } from '../src/tasks/tasks';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, regularIteration, seedInstance } from './factories';

const TODAY = '2026-09-30';
let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guest: Actor;
let readToken: Actor;
let pan: string;
let doc: string;
let sprint: IterationView;
let next: IterationView;
let finished: IterationView;
let special: IterationView;
let docSprint: IterationView;
let req: RequirementListItem;

const eventsOf = (subjectId: string, type: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, subjectId), eq(domainEvents.type, type))));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  editor = await asMember(t.db, owner, '开发乙');
  viewer = await asMember(t.db, owner, '只读丙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '访客丁', 'guest');
  readToken = readOnlyToken(owner);
  sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0928', '2026-09-28', '2026-10-09'));
  next = await createIteration(t.db, owner, regularIteration(pan, '迭代1012', '2026-10-12', '2026-10-23'));
  finished = await createIteration(t.db, owner, regularIteration(pan, '迭代0914', '2026-09-14', '2026-09-25'));
  await setIterationStatus(t.db, owner, finished.id, 'active');
  await setIterationStatus(t.db, owner, finished.id, 'done');
  special = await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-09-01', endDate: '2026-12-31' });
  docSprint = await createIteration(t.db, owner, regularIteration(doc, '文档迭代', '2026-09-28', '2026-10-09'));
  req = await createRequirement(t.db, owner, pan, { title: '上传提速' });
});
afterAll(() => t.cleanup());

describe('新建任务', () => {
  it('挂需求的任务：产品取自需求，按今天推算进度，写 task.created 事件', async () => {
    const task = await createTask(
      t.db,
      editor,
      { requirementId: req.id, iterationId: sprint.id, title: '前端开发', assigneeMemberId: editor.memberId, planStart: '2026-09-28', planDays: 4 },
      { today: TODAY },
    );
    expect(task).toMatchObject({
      productId: pan,
      iterationId: sprint.id,
      requirement: { displayKey: 'PAN-1', title: '上传提速' },
      assignee: { displayName: '开发乙' },
      status: 'todo',
      planDays: 4,
      starred: false,
      flag: null,
      progressOverride: null,
      progress: 50,
      canEdit: true,
    });
    expect(await eventsOf(task.id, 'task.created')).toMatchObject([{ productId: pan, payload: { title: '前端开发', requirementId: req.id, iterationId: sprint.id } }]);
  });

  it('没有需求的任务：常规迭代取迭代的产品，专项必须指定产品，两者都没有时拒绝', async () => {
    expect((await createTask(t.db, editor, { iterationId: sprint.id, title: '联调' }, { today: TODAY })).productId).toBe(pan);
    await expect(createTask(t.db, owner, { iterationId: special.id, title: '专项设计' })).rejects.toMatchObject({ code: 'invalid', message: '专项里的任务需要指定所属产品' });
    expect((await createTask(t.db, owner, { iterationId: special.id, productId: doc, title: '专项设计' }, { today: TODAY })).productId).toBe(doc);
    await expect(createTask(t.db, owner, { title: '孤立任务' })).rejects.toMatchObject({ code: 'invalid', message: '任务需要属于一个迭代或一条需求' });
  });

  it('只能放进同产品、规划中或进行中的迭代', async () => {
    await expect(createTask(t.db, owner, { requirementId: req.id, iterationId: docSprint.id, title: '跨产品' })).rejects.toMatchObject({
      code: 'invalid',
      message: '不能把任务放进其他产品的迭代',
    });
    await expect(createTask(t.db, owner, { iterationId: finished.id, title: '补录' })).rejects.toMatchObject({ code: 'invalid', message: '只能在规划中或进行中的迭代里新建任务' });
  });

  it('字段校验：标题、工期以半天为单位、延期不能为负、进度 0–100、标记、日期', async () => {
    const bad = (input: Partial<TaskCreateInput>) => createTask(t.db, owner, { iterationId: sprint.id, title: '校验', ...input });
    await expect(bad({ title: ' ' })).rejects.toMatchObject({ code: 'invalid', message: '任务名称不能为空，且不超过 200 个字符' });
    await expect(bad({ planDays: 0 })).rejects.toMatchObject({ message: '工期以半天为单位，范围 0.5–365 天' });
    await expect(bad({ planDays: 1.3 })).rejects.toMatchObject({ message: '工期以半天为单位，范围 0.5–365 天' });
    await expect(bad({ delayDays: -0.5 })).rejects.toMatchObject({ message: '延期以半天为单位，范围 0–365 天' });
    await expect(bad({ progress: 101 })).rejects.toMatchObject({ message: '进度应为 0–100 的整数' });
    await expect(bad({ flag: 'bogus' as 'attention' })).rejects.toMatchObject({ message: '标记无效' });
    await expect(bad({ planStart: '2026-02-30' })).rejects.toMatchObject({ message: '开始日期格式应为 YYYY-MM-DD' });
    const half = await createTask(
      t.db,
      owner,
      { iterationId: sprint.id, title: '半天任务', planStart: '2026-09-28', planDays: 0.5, delayDays: 1.5, flag: 'attention' },
      { today: TODAY },
    );
    expect(half).toMatchObject({ planDays: 0.5, delayDays: 1.5, flag: 'attention', progress: 100 });
  });
});

describe('修改任务', () => {
  it('手动进度与说明存进 meta，事件带 changes；没有变化时不写事件；清空后按工期推算', async () => {
    const task = await createTask(t.db, editor, { iterationId: sprint.id, title: '埋点', planStart: '2026-09-28', planDays: 10 }, { today: TODAY });
    const v = await updateTask(t.db, editor, task.id, { progress: 30, note: '等接口', status: 'doing' }, { today: TODAY });
    expect(v).toMatchObject({ progressOverride: 30, progress: 30, note: '等接口', status: 'doing' });
    const [e] = await eventsOf(task.id, 'task.updated');
    expect(e!.payload.changes).toEqual([
      { field: 'status', old: 'todo', new: 'doing' },
      { field: 'note', old: null, new: '等接口' },
      { field: 'progress', old: null, new: 30 },
    ]);
    await updateTask(t.db, editor, task.id, { progress: 30 });
    expect(await eventsOf(task.id, 'task.updated')).toHaveLength(1);
    expect(await updateTask(t.db, editor, task.id, { progress: null, note: '' }, { today: TODAY })).toMatchObject({ progressOverride: null, note: null, progress: 20 });
    expect((await updateTask(t.db, editor, task.id, { status: 'done' }, { today: TODAY })).progress).toBe(100);
  });
});

describe('重点任务', () => {
  it('每个迭代最多 10 个；第 11 个返回冲突；其他迭代不受影响；取消后可以再标', async () => {
    const starred = [];
    for (let i = 1; i <= 10; i++) starred.push(await createTask(t.db, owner, { iterationId: next.id, title: `重点${i}`, starred: true }));
    await expect(createTask(t.db, owner, { iterationId: next.id, title: '重点11', starred: true })).rejects.toMatchObject({
      code: 'conflict',
      message: '每个迭代最多 10 个重点任务',
    });
    const plain = await createTask(t.db, owner, { iterationId: next.id, title: '普通任务' });
    await expect(updateTask(t.db, owner, plain.id, { starred: true })).rejects.toMatchObject({ code: 'conflict' });
    expect((await createTask(t.db, owner, { iterationId: sprint.id, title: '另一迭代的重点', starred: true })).starred).toBe(true);
    await updateTask(t.db, owner, starred[0]!.id, { starred: false });
    expect((await updateTask(t.db, owner, plain.id, { starred: true })).starred).toBe(true);
  });

  it('并发标为重点时不会超过上限', async () => {
    const it2 = await createIteration(t.db, owner, regularIteration(pan, '迭代1026', '2026-10-26', '2026-11-06'));
    for (let i = 1; i <= 8; i++) await createTask(t.db, owner, { iterationId: it2.id, title: `已标${i}`, starred: true });
    const candidates = [];
    for (let i = 1; i <= 3; i++) candidates.push(await createTask(t.db, owner, { iterationId: it2.id, title: `候选${i}` }));
    const results = await Promise.allSettled(candidates.map((c) => updateTask(t.db, owner, c.id, { starred: true })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['conflict']);
  });

  it('没有迭代的任务不能标为重点', async () => {
    await expect(createTask(t.db, owner, { requirementId: req.id, title: '需求子任务', starred: true })).rejects.toMatchObject({
      code: 'invalid',
      message: '只有迭代里的任务可以标为重点',
    });
  });
});

describe('权限', () => {
  it('只读成员与只读 Token 不能新建、修改、删除；看不到产品的访客得到 404', async () => {
    const task = await createTask(t.db, owner, { iterationId: sprint.id, title: '权限测试' });
    for (const who of [viewer, readToken]) {
      await expect(createTask(t.db, who, { iterationId: sprint.id, title: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(updateTask(t.db, who, task.id, { title: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(deleteTask(t.db, who, task.id)).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(createTask(t.db, guest, { iterationId: sprint.id, title: '越权' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateTask(t.db, guest, task.id, { title: '越权' })).rejects.toMatchObject({ code: 'not_found', message: '任务不存在' });
  });
});

describe('删除', () => {
  it('删除任务并写事件；删除后再修改返回 404；迭代里还有任务时不能删除迭代', async () => {
    const empty = await createIteration(t.db, owner, regularIteration(pan, '迭代1109', '2026-11-09', '2026-11-20'));
    const task = await createTask(t.db, owner, { iterationId: empty.id, title: '临时任务' });
    await expect(deleteIteration(t.db, owner, empty.id)).rejects.toMatchObject({ code: 'invalid', message: '迭代中还有任务，请先删除' });
    await deleteTask(t.db, owner, task.id);
    expect(await eventsOf(task.id, 'task.deleted')).toMatchObject([{ productId: pan, payload: { title: '临时任务', iterationId: empty.id, requirementId: null } }]);
    await expect(updateTask(t.db, owner, task.id, { title: '已删除' })).rejects.toMatchObject({ code: 'not_found', message: '任务不存在' });
    await deleteIteration(t.db, owner, empty.id);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/tasks.test.ts`
Expected: FAIL，找不到模块 `../src/tasks/tasks`。

- [ ] **Step 3: 实现任务服务**

`packages/core/src/tasks/tasks.ts`：

```ts
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { iterations, organizations, products, requirements, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertMemberInOrg, loadRequirement, memberNames } from '../requirements/context';
import { displayKey, type MemberRef } from '../requirements/requirements';
import { displayProgress, STARRED_LIMIT, TASK_FLAGS, type TaskFlag, todayInZone } from './schedule';

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** 组织没有设置时区时使用的默认值，与组织信息页的默认选项一致。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

export type TaskView = {
  id: string;
  productId: string;
  iterationId: string | null;
  requirement: { id: string; displayKey: string; title: string } | null;
  title: string;
  alias: string | null;
  assignee: MemberRef | null;
  status: TaskStatus;
  planStart: string | null;
  planDays: number | null;
  delayDays: number | null;
  phase: string | null;
  flag: TaskFlag | null;
  starred: boolean;
  note: string | null;
  progressOverride: number | null;
  progress: number;
  canEdit: boolean;
  updatedAt: Date;
};

export type TaskPatch = {
  title?: string;
  alias?: string | null;
  assigneeMemberId?: string | null;
  status?: TaskStatus;
  planStart?: string | null;
  planDays?: number | null;
  delayDays?: number | null;
  phase?: string | null;
  flag?: TaskFlag | null;
  starred?: boolean;
  note?: string | null;
  progress?: number | null;
};
export type TaskCreateInput = TaskPatch & { title: string; iterationId?: string | null; requirementId?: string | null; productId?: string | null };

type TaskRow = typeof tasks.$inferSelect;
type IterationRow = typeof iterations.$inferSelect;
type Columns = Partial<
  Pick<typeof tasks.$inferInsert, 'title' | 'alias' | 'assigneeMemberId' | 'status' | 'planStart' | 'planDays' | 'delayDays' | 'phase' | 'flag' | 'starred'>
>;
/** 存在 tasks.meta 里的字段：说明与手动进度。 */
type MetaPatch = { note?: string | null; progress?: number | null };
type Change = { field: string; old: unknown; new: unknown };

function optionalText(value: string | null, max: number, message: string): string | null {
  const s = value?.trim() ?? '';
  if (s.length > max) throw new AppError('invalid', message);
  return s || null;
}

function halfDays(value: number | null, min: number, message: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < min || value > 365 || !Number.isInteger(value * 2)) throw new AppError('invalid', message);
  return value;
}

function normalize(input: TaskPatch): { columns: Columns; meta: MetaPatch } {
  const columns: Columns = {};
  const meta: MetaPatch = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title || title.length > 200) throw new AppError('invalid', '任务名称不能为空，且不超过 200 个字符');
    columns.title = title;
  }
  if (input.alias !== undefined) columns.alias = optionalText(input.alias, 50, '别名不超过 50 个字符');
  if (input.assigneeMemberId !== undefined) columns.assigneeMemberId = input.assigneeMemberId;
  if (input.status !== undefined) {
    if (!(TASK_STATUSES as readonly string[]).includes(input.status)) throw new AppError('invalid', '任务状态无效');
    columns.status = input.status;
  }
  if (input.planStart !== undefined) columns.planStart = input.planStart === null ? null : assertIsoDate(input.planStart, '开始日期');
  if (input.planDays !== undefined) columns.planDays = halfDays(input.planDays, 0.5, '工期以半天为单位，范围 0.5–365 天');
  if (input.delayDays !== undefined) columns.delayDays = halfDays(input.delayDays, 0, '延期以半天为单位，范围 0–365 天');
  if (input.phase !== undefined) columns.phase = optionalText(input.phase, 20, '阶段不超过 20 个字符');
  if (input.flag !== undefined) {
    if (input.flag !== null && !(TASK_FLAGS as readonly string[]).includes(input.flag)) throw new AppError('invalid', '标记无效');
    columns.flag = input.flag;
  }
  if (input.starred !== undefined) columns.starred = input.starred;
  if (input.note !== undefined) meta.note = optionalText(input.note, 200, '说明不超过 200 个字符');
  if (input.progress !== undefined) {
    if (input.progress !== null && (!Number.isInteger(input.progress) || input.progress < 0 || input.progress > 100)) {
      throw new AppError('invalid', '进度应为 0–100 的整数');
    }
    meta.progress = input.progress;
  }
  return { columns, meta };
}

/** 组织时区的当天日期。 */
export async function orgToday(tx: Tx, orgId: string): Promise<string> {
  const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return todayInZone(org?.settings.timezone ?? DEFAULT_TIMEZONE);
}

async function lockIteration(tx: Tx, id: string, mode: 'update' | 'share'): Promise<IterationRow> {
  const [it] = await tx
    .select()
    .from(iterations)
    .where(and(eq(iterations.id, id), isNull(iterations.deletedAt)))
    .for(mode);
  if (!it) throw new AppError('not_found', '迭代不存在');
  return it;
}

async function assertStarredRoom(tx: Tx, iterationId: string): Promise<void> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.iterationId, iterationId), eq(tasks.starred, true)));
  if (row!.n >= STARRED_LIMIT) throw new AppError('conflict', `每个迭代最多 ${STARRED_LIMIT} 个重点任务`);
}

/** 任务写操作的权限：看不到产品时与任务不存在一样返回 404；只读成员与只读 Token 返回 403。 */
async function requireTaskEditor(tx: Tx, actor: Actor, productId: string): Promise<void> {
  const role = await productRoleOf(tx, actor, productId);
  if (!role) throw new AppError('not_found', '任务不存在');
  if (!atLeast(role, 'editor')) throw new AppError('forbidden', '权限不足');
}

export async function hydrateTasks(tx: Tx, actor: Actor, rows: TaskRow[], today: string): Promise<TaskView[]> {
  if (rows.length === 0) return [];
  const reqIds = [...new Set(rows.map((r) => r.requirementId).filter((x): x is string => !!x))];
  const reqs = reqIds.length
    ? await tx
        .select({ id: requirements.id, number: requirements.number, title: requirements.title, key: products.key })
        .from(requirements)
        .innerJoin(products, eq(products.id, requirements.productId))
        .where(inArray(requirements.id, reqIds))
    : [];
  const names = await memberNames(tx, rows.map((r) => r.assigneeMemberId));
  const roles = new Map<string, ProductRole | null>();
  for (const pid of new Set(rows.map((r) => r.productId))) roles.set(pid, await productRoleOf(tx, actor, pid));
  return rows.map((r) => {
    const req = reqs.find((x) => x.id === r.requirementId);
    const progressOverride = typeof r.meta.progress === 'number' ? r.meta.progress : null;
    return {
      id: r.id,
      productId: r.productId,
      iterationId: r.iterationId,
      requirement: req ? { id: req.id, displayKey: displayKey(req.key, req.number), title: req.title } : null,
      title: r.title,
      alias: r.alias || null,
      assignee: r.assigneeMemberId ? { id: r.assigneeMemberId, displayName: names.get(r.assigneeMemberId) ?? '已删除的成员' } : null,
      status: r.status,
      planStart: r.planStart,
      planDays: r.planDays,
      delayDays: r.delayDays,
      phase: r.phase,
      flag: r.flag === 'attention' ? 'attention' : null,
      starred: r.starred ?? false,
      note: typeof r.meta.note === 'string' && r.meta.note ? r.meta.note : null,
      progressOverride,
      progress: displayProgress({ status: r.status, planStart: r.planStart, planDays: r.planDays, delayDays: r.delayDays, progressOverride }, today),
      canEdit: atLeast(roles.get(r.productId) ?? null, 'editor'),
      updatedAt: r.updatedAt,
    };
  });
}

export async function createTask(db: Db, actor: Actor, input: TaskCreateInput, opts: { today?: string } = {}): Promise<TaskView> {
  const { columns, meta } = normalize(input);
  if (!input.iterationId && !input.requirementId) throw new AppError('invalid', '任务需要属于一个迭代或一条需求');
  return withOrg(db, actor.orgId, async (tx) => {
    // 先锁迭代（标为重点时用排他锁，保证重点数量检查不被并发绕过），再读需求
    const it = input.iterationId ? await lockIteration(tx, input.iterationId, columns.starred ? 'update' : 'share') : null;
    const req = input.requirementId ? await loadRequirement(tx, input.requirementId) : null;
    const productId = req?.productId ?? (it?.type === 'regular' ? it.productId : input.productId) ?? null;
    if (!productId) throw new AppError('invalid', '专项里的任务需要指定所属产品');
    await requireProductRole(tx, actor, productId, 'editor');
    if (it) {
      if (it.type === 'regular' && it.productId !== productId) throw new AppError('invalid', '不能把任务放进其他产品的迭代');
      if (it.status !== 'planning' && it.status !== 'active') throw new AppError('invalid', '只能在规划中或进行中的迭代里新建任务');
    }
    if (columns.assigneeMemberId) await assertMemberInOrg(tx, columns.assigneeMemberId);
    if (columns.starred) {
      if (!it) throw new AppError('invalid', '只有迭代里的任务可以标为重点');
      await assertStarredRoom(tx, it.id);
    }
    const metaValue = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== null));
    const [row] = await tx
      .insert(tasks)
      .values({ orgId: actor.orgId, productId, requirementId: req?.id ?? null, iterationId: it?.id ?? null, ...columns, title: columns.title!, meta: metaValue })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'task.created',
      subjectType: 'task',
      subjectId: row!.id,
      actor,
      payload: { title: row!.title, requirementId: row!.requirementId, iterationId: row!.iterationId },
    });
    const [view] = await hydrateTasks(tx, actor, [row!], opts.today ?? (await orgToday(tx, actor.orgId)));
    return view!;
  });
}

export async function updateTask(db: Db, actor: Actor, id: string, input: TaskPatch, opts: { today?: string } = {}): Promise<TaskView> {
  const { columns, meta } = normalize(input);
  return withOrg(db, actor.orgId, async (tx) => {
    const [peek] = await tx.select({ iterationId: tasks.iterationId }).from(tasks).where(eq(tasks.id, id));
    if (!peek) throw new AppError('not_found', '任务不存在');
    // 加锁顺序与加入迭代、开始迭代一致：先迭代、后任务
    if (columns.starred === true && peek.iterationId) await lockIteration(tx, peek.iterationId, 'update');
    const [cur] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
    if (!cur) throw new AppError('not_found', '任务不存在');
    await requireTaskEditor(tx, actor, cur.productId);
    if (columns.assigneeMemberId && columns.assigneeMemberId !== cur.assigneeMemberId) await assertMemberInOrg(tx, columns.assigneeMemberId);
    if (columns.starred === true && !cur.starred) {
      if (!cur.iterationId) throw new AppError('invalid', '只有迭代里的任务可以标为重点');
      await assertStarredRoom(tx, cur.iterationId);
    }
    const changes: Change[] = [];
    for (const [field, value] of Object.entries(columns) as Array<[keyof Columns, unknown]>) {
      const old = field === 'starred' ? (cur.starred ?? false) : cur[field];
      if (old !== value) changes.push({ field, old, new: value });
    }
    const nextMeta: Record<string, unknown> = { ...cur.meta };
    for (const [field, value] of Object.entries(meta) as Array<[keyof MetaPatch, string | number | null]>) {
      const old = cur.meta[field] ?? null;
      if (old !== value) changes.push({ field, old, new: value });
      if (value === null) delete nextMeta[field];
      else nextMeta[field] = value;
    }
    let row = cur;
    if (changes.length > 0) {
      [row] = (await tx.update(tasks).set({ ...columns, meta: nextMeta, updatedAt: new Date() }).where(eq(tasks.id, id)).returning()) as [TaskRow];
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'task.updated', subjectType: 'task', subjectId: id, actor, payload: { changes } });
    }
    const [view] = await hydrateTasks(tx, actor, [row], opts.today ?? (await orgToday(tx, actor.orgId)));
    return view!;
  });
}

export async function deleteTask(db: Db, actor: Actor, id: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
    if (!cur) throw new AppError('not_found', '任务不存在');
    await requireTaskEditor(tx, actor, cur.productId);
    await tx.delete(tasks).where(eq(tasks.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'task.deleted',
      subjectType: 'task',
      subjectId: id,
      actor,
      payload: { title: cur.title, requirementId: cur.requirementId, iterationId: cur.iterationId },
    });
  });
}
```

`packages/core/src/index.ts` 末尾追加：

```ts
export * from './tasks/tasks';
```

- [ ] **Step 4: 删除迭代时检查任务**

`packages/core/src/iterations/iterations.ts`：

1. schema import 改为：

```ts
import { blockers, type IterationMilestone, iterationScopeSnapshots, iterations, products, releases, requirements, tasks } from '../db/schema';
```

2. `deleteIteration` 中 `if (reqCount!.n > 0) throw new AppError('invalid', '迭代中还有需求，请先移出');` 之后加入：

```ts
    const [taskCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.iterationId, id));
    if (taskCount!.n > 0) throw new AppError('invalid', '迭代中还有任务，请先删除');
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/tasks.test.ts test/iterations.test.ts` 与 `pnpm typecheck`
Expected: PASS（`iterations.test.ts` 中删除迭代的既有用例不受影响：那些迭代里没有任务）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/tasks/tasks.ts packages/core/src/iterations/iterations.ts packages/core/src/index.ts packages/core/test/tasks.test.ts
git commit -m "feat(core): 任务新建、修改、删除，每个迭代最多 10 个重点任务；有任务的迭代不能删除

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: 任务查询：甘特（按迭代，含概览）、按需求、按人跨迭代

**Files:**
- Create: `packages/core/src/tasks/queries.ts`
- Modify: `packages/core/src/iterations/iterations.ts`（导出 `loadVisibleIteration`、`stateInfoByProduct`、`stateOf`）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/task-queries.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `iterationOverview`、`workdaysBetween`、`IterationOverview`；Task 2 的 `hydrateTasks`、`orgToday`、`TaskView`、`createTask`、`updateTask`；`visibleProductIds`、`productRoleOf`、`atLeast`；`loadRequirement`
- Produces（`iterations/iterations.ts`，由非导出改为导出，函数体不变）：
  - `loadVisibleIteration(tx: Tx, id: string, visible: Set<string>, lock?: boolean): Promise<typeof iterations.$inferSelect>`
  - `stateInfoByProduct(tx: Tx, productIds: Iterable<string>): Promise<Map<string, Map<string, StateInfo>>>`
  - `stateOf(info: Map<string, Map<string, StateInfo>>, productId: string, key: string): StateInfo`
- Produces（`tasks/queries.ts`）：
  - `type IterationGantt = { iteration: { id: string; name: string; type: 'regular' | 'special'; product: { id: string; key: string; name: string } | null; startDate: string; endDate: string; status: IterationStatus }; today: string; workdays: string[]; tasks: TaskView[]; overview: IterationOverview; starredCount: number; canAddTask: boolean; editableProductIds: string[] }`
  - `type MemberTask = TaskView & { iteration: { id: string; name: string; startDate: string; endDate: string; status: IterationStatus } | null }`
  - `type MemberTasks = { member: MemberRef; today: string; tasks: MemberTask[] }`
  - `getIterationGantt(db, actor, iterationId: string, opts?: { today?: string }): Promise<IterationGantt>`（任务顺序：重点在前，其余按开始日期、创建时间；专项只含看得到的产品的任务）
  - `listRequirementTasks(db, actor, requirementId: string, opts?: { today?: string }): Promise<TaskView[]>`
  - `listMemberTasks(db, actor, memberId: string, opts?: { today?: string; includeFinished?: boolean }): Promise<MemberTasks>`（默认：规划中 / 进行中迭代里的任务 + 不在迭代中的未完成任务；`includeFinished` 时再加已完成、已取消迭代里的任务；已删除迭代里的任务都不列；最多 500 条）
- 错误：`not_found`「迭代不存在」「需求不存在」「成员不存在」

- [ ] **Step 1: 写失败的测试**

`packages/core/test/task-queries.test.ts`（2026-09-28 周一，10-02 周五，10-09 周五）：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { createIteration, type IterationView, setIterationStatus } from '../src/iterations/iterations';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { getIterationGantt, listMemberTasks, listRequirementTasks } from '../src/tasks/queries';
import { createTask, updateTask } from '../src/tasks/tasks';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, regularIteration, seedInstance } from './factories';

const TODAY = '2026-10-02';
let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let dev: Actor;
let panViewer: Actor;
let outsider: Actor;
let pan: string;
let doc: string;
let active: IterationView;
let planning: IterationView;
let closed: IterationView;
let special: IterationView;
let r1: RequirementListItem;
let r2: RequirementListItem;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  dev = await asMember(t.db, owner, '开发乙');
  panViewer = await asMember(t.db, owner, '访客戊', 'guest');
  await setProductRole(t.db, owner, pan, panViewer.memberId, 'viewer');
  outsider = await asMember(t.db, owner, '访客己', 'guest');

  active = await createIteration(t.db, owner, regularIteration(pan, '迭代0928', '2026-09-28', '2026-10-09'));
  planning = await createIteration(t.db, owner, regularIteration(pan, '迭代1012', '2026-10-12', '2026-10-23'));
  closed = await createIteration(t.db, owner, regularIteration(pan, '迭代0914', '2026-09-14', '2026-09-25'));
  special = await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-09-01', endDate: '2026-12-31' });
  r1 = await createRequirement(t.db, owner, pan, { title: '上传提速' });
  r2 = await createRequirement(t.db, owner, pan, { title: '分享统计' });

  const a1 = await createTask(t.db, owner, { iterationId: active.id, requirementId: r1.id, title: '前端开发', assigneeMemberId: dev.memberId });
  await updateTask(t.db, owner, a1.id, { status: 'done' });
  await createTask(t.db, owner, { iterationId: active.id, requirementId: r1.id, title: '后端开发', assigneeMemberId: dev.memberId, planStart: '2026-10-01', planDays: 2, progress: 50 });
  await createTask(t.db, owner, { iterationId: active.id, requirementId: r2.id, title: '设计稿', flag: 'attention', progress: 20 });
  await createTask(t.db, owner, { iterationId: active.id, title: '联调', progress: 40, note: '等待接口' });
  await createTask(t.db, owner, { iterationId: planning.id, title: '预研', assigneeMemberId: dev.memberId, planStart: '2026-10-12' });
  await createTask(t.db, owner, { iterationId: closed.id, title: '旧任务', assigneeMemberId: dev.memberId });
  await createTask(t.db, owner, { requirementId: r2.id, title: '文档补充', assigneeMemberId: dev.memberId });
  await createTask(t.db, owner, { iterationId: special.id, productId: doc, title: '文档侧改造', assigneeMemberId: dev.memberId });
  await createTask(t.db, owner, { iterationId: special.id, productId: pan, title: '网盘侧改造', assigneeMemberId: dev.memberId });
  await setIterationStatus(t.db, owner, active.id, 'active');
  await setIterationStatus(t.db, owner, closed.id, 'active');
  await setIterationStatus(t.db, owner, closed.id, 'done');
});
afterAll(() => t.cleanup());

describe('甘特', () => {
  it('返回工作日、任务与概览：关注且未完成的需求不计入整体进度', async () => {
    const g = await getIterationGantt(t.db, owner, active.id, { today: TODAY });
    expect(g.iteration).toMatchObject({ id: active.id, name: '迭代0928', type: 'regular', product: { key: 'PAN' }, status: 'active' });
    expect(g.today).toBe(TODAY);
    expect(g.workdays).toHaveLength(10);
    expect(g.tasks.map((x) => x.title).sort()).toEqual(['前端开发', '后端开发', '联调', '设计稿'].sort());
    expect(g.overview).toEqual({
      rowCount: 3,
      countedCount: 2,
      overall: 58,
      expected: 44,
      behind: 0,
      deferred: 1,
      attention: [
        { kind: 'attention', title: 'PAN-2 分享统计', assignees: [], note: '' },
        { kind: 'notice', title: '联调', assignees: [], note: '等待接口' },
      ],
    });
    expect(g).toMatchObject({ starredCount: 0, canAddTask: true, editableProductIds: [pan] });
  });

  it('专项只列看得到的产品的任务；只读成员不能添加；已结束的迭代不能添加；看不到的迭代返回 404', async () => {
    const own = await getIterationGantt(t.db, owner, special.id, { today: TODAY });
    expect(own.tasks.map((x) => x.title).sort()).toEqual(['文档侧改造', '网盘侧改造'].sort());
    expect(own.editableProductIds.sort()).toEqual([pan, doc].sort());
    const viewerGantt = await getIterationGantt(t.db, panViewer, special.id, { today: TODAY });
    expect(viewerGantt.tasks.map((x) => x.title)).toEqual(['网盘侧改造']);
    expect(viewerGantt).toMatchObject({ canAddTask: false, editableProductIds: [] });
    expect((await getIterationGantt(t.db, owner, closed.id, { today: TODAY })).canAddTask).toBe(false);
    await expect(getIterationGantt(t.db, outsider, active.id)).rejects.toMatchObject({ code: 'not_found', message: '迭代不存在' });
  });
});

describe('按需求', () => {
  it('列出需求的全部任务；只读成员可以读；看不到产品返回 404', async () => {
    expect((await listRequirementTasks(t.db, panViewer, r1.id, { today: TODAY })).map((x) => x.title).sort()).toEqual(['前端开发', '后端开发'].sort());
    expect((await listRequirementTasks(t.db, owner, r2.id)).map((x) => x.title).sort()).toEqual(['文档补充', '设计稿'].sort());
    await expect(listRequirementTasks(t.db, outsider, r1.id)).rejects.toMatchObject({ code: 'not_found', message: '需求不存在' });
  });
});

describe('按人跨迭代', () => {
  it('默认列出规划中与进行中迭代里的任务和不在迭代中的未完成任务，可以包含已结束的迭代', async () => {
    const open = await listMemberTasks(t.db, owner, dev.memberId, { today: TODAY });
    expect(open.member).toEqual({ id: dev.memberId, displayName: '开发乙' });
    expect(open.today).toBe(TODAY);
    expect(open.tasks.map((x) => x.title).sort()).toEqual(['前端开发', '后端开发', '预研', '文档补充', '文档侧改造', '网盘侧改造'].sort());
    expect(open.tasks.find((x) => x.title === '预研')!.iteration).toEqual({ id: planning.id, name: '迭代1012', startDate: '2026-10-12', endDate: '2026-10-23', status: 'planning' });
    expect(open.tasks.find((x) => x.title === '文档补充')!.iteration).toBeNull();
    const all = await listMemberTasks(t.db, owner, dev.memberId, { today: TODAY, includeFinished: true });
    expect(all.tasks.map((x) => x.title)).toContain('旧任务');
  });

  it('只列看得到的产品；成员不存在返回 404', async () => {
    const seen = await listMemberTasks(t.db, panViewer, dev.memberId, { today: TODAY });
    expect(seen.tasks.map((x) => x.title)).not.toContain('文档侧改造');
    expect(seen.tasks.map((x) => x.title)).toContain('网盘侧改造');
    await expect(listMemberTasks(t.db, owner, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'not_found', message: '成员不存在' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/task-queries.test.ts`
Expected: FAIL，找不到模块 `../src/tasks/queries`。

- [ ] **Step 3: 导出迭代的内部函数**

`packages/core/src/iterations/iterations.ts` 中三处函数声明前加 `export`，函数体不变：

```ts
export async function stateInfoByProduct(tx: Tx, productIds: Iterable<string>): Promise<Map<string, Map<string, StateInfo>>> {
```

```ts
export function stateOf(info: Map<string, Map<string, StateInfo>>, productId: string, key: string): StateInfo {
```

```ts
export async function loadVisibleIteration(tx: Tx, id: string, visible: Set<string>, lock = false): Promise<IterRow> {
```

- [ ] **Step 4: 实现查询**

`packages/core/src/tasks/queries.ts`：

```ts
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { iterations, members, products, tasks } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { type IterationStatus, loadVisibleIteration } from '../iterations/iterations';
import { loadRequirement } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import { type IterationOverview, iterationOverview, workdaysBetween } from './schedule';
import { hydrateTasks, orgToday, type TaskView } from './tasks';

export type IterationGantt = {
  iteration: {
    id: string;
    name: string;
    type: 'regular' | 'special';
    product: { id: string; key: string; name: string } | null;
    startDate: string;
    endDate: string;
    status: IterationStatus;
  };
  today: string;
  workdays: string[];
  tasks: TaskView[];
  overview: IterationOverview;
  starredCount: number;
  canAddTask: boolean;
  /** 操作者可以在本迭代里新建任务的产品（专项有多个时由界面选择）。 */
  editableProductIds: string[];
};
export type MemberTask = TaskView & { iteration: { id: string; name: string; startDate: string; endDate: string; status: IterationStatus } | null };
export type MemberTasks = { member: MemberRef; today: string; tasks: MemberTask[] };

const byPlanStart = [sql`${tasks.planStart} asc nulls last`, asc(tasks.createdAt)] as const;

export async function getIterationGantt(db: Db, actor: Actor, iterationId: string, opts: { today?: string } = {}): Promise<IterationGantt> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const it = await loadVisibleIteration(tx, iterationId, visible);
    const today = opts.today ?? (await orgToday(tx, actor.orgId));
    const rows =
      visible.size > 0
        ? await tx
            .select()
            .from(tasks)
            .where(and(eq(tasks.iterationId, iterationId), inArray(tasks.productId, [...visible])))
            .orderBy(...byPlanStart)
        : [];
    // 重点任务排在前面；sort 是稳定排序，其余保持开始日期顺序
    const views = (await hydrateTasks(tx, actor, rows, today)).sort((a, b) => Number(b.starred) - Number(a.starred));
    const [product] = it.productId
      ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(eq(products.id, it.productId))
      : [];
    const open = it.status === 'planning' || it.status === 'active';
    const editableProductIds: string[] = [];
    if (open) {
      for (const pid of it.type === 'regular' ? [it.productId!] : [...visible]) {
        if (atLeast(await productRoleOf(tx, actor, pid), 'editor')) editableProductIds.push(pid);
      }
    }
    const overview = iterationOverview(
      views.map((v) => ({
        status: v.status,
        planStart: v.planStart,
        planDays: v.planDays,
        delayDays: v.delayDays,
        progressOverride: v.progressOverride,
        requirementId: v.requirement?.id ?? null,
        title: v.requirement ? `${v.requirement.displayKey} ${v.requirement.title}` : v.title,
        flag: v.flag,
        note: v.note,
        assigneeName: v.assignee?.displayName ?? null,
      })),
      it,
      today,
    );
    return {
      iteration: { id: it.id, name: it.name, type: it.type, product: product ?? null, startDate: it.startDate, endDate: it.endDate, status: it.status },
      today,
      workdays: workdaysBetween(it.startDate, it.endDate),
      tasks: views,
      overview,
      starredCount: views.filter((v) => v.starred).length,
      canAddTask: editableProductIds.length > 0,
      editableProductIds,
    };
  });
}

export async function listRequirementTasks(db: Db, actor: Actor, requirementId: string, opts: { today?: string } = {}): Promise<TaskView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    if (!(await productRoleOf(tx, actor, req.productId))) throw new AppError('not_found', '需求不存在');
    const rows = await tx.select().from(tasks).where(eq(tasks.requirementId, requirementId)).orderBy(...byPlanStart);
    return hydrateTasks(tx, actor, rows, opts.today ?? (await orgToday(tx, actor.orgId)));
  });
}

export async function listMemberTasks(
  db: Db,
  actor: Actor,
  memberId: string,
  opts: { today?: string; includeFinished?: boolean } = {},
): Promise<MemberTasks> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [member] = await tx.select({ id: members.id, displayName: members.displayName }).from(members).where(eq(members.id, memberId));
    if (!member) throw new AppError('not_found', '成员不存在');
    const today = opts.today ?? (await orgToday(tx, actor.orgId));
    const visible = [...(await visibleProductIds(tx, actor))];
    if (visible.length === 0) return { member, today, tasks: [] };
    const scope = opts.includeFinished
      ? or(isNull(tasks.iterationId), isNull(iterations.deletedAt))
      : or(
          and(isNull(tasks.iterationId), ne(tasks.status, 'done')),
          and(isNull(iterations.deletedAt), inArray(iterations.status, ['planning', 'active'])),
        );
    const rows = await tx
      .select({
        t: tasks,
        it: { id: iterations.id, name: iterations.name, startDate: iterations.startDate, endDate: iterations.endDate, status: iterations.status },
      })
      .from(tasks)
      .leftJoin(iterations, eq(iterations.id, tasks.iterationId))
      .where(and(eq(tasks.assigneeMemberId, memberId), inArray(tasks.productId, visible), scope))
      .orderBy(...byPlanStart)
      .limit(500);
    const views = await hydrateTasks(tx, actor, rows.map((r) => r.t), today);
    return { member, today, tasks: views.map((v, i) => ({ ...v, iteration: rows[i]!.it })) };
  });
}
```

`packages/core/src/index.ts` 末尾追加：

```ts
export * from './tasks/queries';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/task-queries.test.ts test/iterations.test.ts` 与 `pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/tasks/queries.ts packages/core/src/iterations/iterations.ts packages/core/src/index.ts packages/core/test/task-queries.test.ts
git commit -m "feat(core): 任务查询：迭代甘特与概览、按需求、按人跨迭代

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: 迁移：push 甘特任务的标记与手动进度映射

**Files:**
- Modify: `packages/migrate/src/workflow-v1.ts`（`GANTT_FLAG`、`ganttProgressOverride`）
- Modify: `packages/migrate/src/plan-requirements.ts`（甘特任务的 `flag`、`status`、`meta.progress`）
- Test: `packages/migrate/test/plan-requirements.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TaskFlag`（`@flower/core`）
- Produces（`workflow-v1.ts`）：
  - `GANTT_FLAG: Record<string, TaskFlag | null>`（`''`、`正常`、`延期` → `null`；`关注` → `'attention'`）
  - `ganttProgressOverride(ovProgress: number | null, actualStatus: string | null): number | null`
- 迁移结果：`tasks.flag` 只会是 `'attention'` 或 `null`；有手动进度时 `tasks.meta.progress` 为 0–100 的整数；`actual_status = 已完成` 的任务 `status = 'done'`；未知标记写入 `report.problems`「push 甘特任务标记「X」没有对应规则」并阻止写入。原有 `meta` 键（`note`、`actualStatus`、`manual`、`ovAssignee`、`ovStatus`、`ovProgress`）保留。

- [ ] **Step 1: 写失败的测试**

`packages/migrate/test/plan-requirements.test.ts`：

1. 用例「任务：子任务与甘特任务，状态按日期计算」中这一行：

```ts
    expect(byTitle('专项设计')).toMatchObject({ requirementId: null, status: 'doing', starred: true, flag: '关注' });
```

改为：

```ts
    expect(byTitle('专项设计')).toMatchObject({ requirementId: null, status: 'doing', starred: true, flag: 'attention' });
    expect(byTitle('前端开发')).toMatchObject({ flag: null });
```

2. `describe('导入计划：需求（修复回归）', …)` 末尾（最后一个 `it` 之后、`});` 之前）追加：

```ts
  it('甘特任务：标记与手动进度按 push 的取值映射', () => {
    const data = makeLegacyData();
    const base = {
      requirement_id: null, version_id: 'it0316', assignee: null, phase: null, plan_start: '2026-03-02', plan_days: 1, delay_days: 0,
      note: '', created_at: null, alias: null, starred: null, ov_assignee: null, ov_status: null, manual: 0,
    };
    data.push.ganttTasks.push(
      { ...base, id: 10, title: '正常任务', flag: '正常', actual_status: '', ov_progress: -1 },
      { ...base, id: 11, title: '旧延期标记', flag: '延期', actual_status: '', ov_progress: null },
      { ...base, id: 12, title: '概览覆盖', flag: '关注', actual_status: '35', ov_progress: 60 },
      { ...base, id: 13, title: '实际进度', flag: '', actual_status: '35', ov_progress: -1 },
      { ...base, id: 14, title: '实际完成', flag: '正常', actual_status: '已完成', ov_progress: null, plan_start: '2099-01-01' },
    );
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    const byTitle = (title: string) => p.rows.tasks.find((x) => x.title === title)!;
    expect(byTitle('正常任务').flag).toBeNull();
    expect(byTitle('正常任务').meta).not.toHaveProperty('progress');
    expect(byTitle('旧延期标记').flag).toBeNull();
    expect(byTitle('概览覆盖')).toMatchObject({ flag: 'attention', meta: expect.objectContaining({ progress: 60, ovProgress: 60 }) });
    expect(byTitle('实际进度').meta).toMatchObject({ progress: 35 });
    expect(byTitle('实际完成')).toMatchObject({ status: 'done' });
    expect(p.report.problems.filter((m) => m.includes('甘特任务标记'))).toEqual([]);
  });

  it('甘特任务的未知标记会阻止写入', () => {
    const data = makeLegacyData();
    data.push.ganttTasks[0]!.flag = '神秘';
    const p = buildImportPlan(data, reviewedMapping(), OPTS);
    expect(p.report.problems).toContain('push 甘特任务标记「神秘」没有对应规则');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/migrate exec vitest run test/plan-requirements.test.ts`
Expected: FAIL，`flag` 仍为 `关注` / `正常`，`meta` 没有 `progress`。

- [ ] **Step 3: 实现**

`packages/migrate/src/workflow-v1.ts`：

1. 第一行 import 改为：

```ts
import { type CheckState, DEFAULT_FUNCTION_TAGS, type TaskFlag, type WorkflowBody } from '@flower/core';
```

2. `BLOCKER_STATUS` 之后加入：

```ts
/** push 甘特任务的标记。push 界面只提供「正常」「关注」；「延期」是旧取值，延期由延期天数表示，不再作为标记。 */
export const GANTT_FLAG: Record<string, TaskFlag | null> = { '': null, 正常: null, 关注: 'attention', 延期: null };

/** push 甘特任务的手动进度：概览覆盖值（≥ 0）优先，其次是数字形式的实际状态；都没有时为 null（按工期推算）。 */
export function ganttProgressOverride(ovProgress: number | null, actualStatus: string | null): number | null {
  if (ovProgress !== null && ovProgress >= 0) return Math.min(100, Math.round(ovProgress));
  const s = actualStatus?.trim();
  if (!s || Number.isNaN(Number(s))) return null;
  return Math.min(100, Math.max(0, Math.round(Number(s))));
}
```

`packages/migrate/src/plan-requirements.ts`：

1. `./workflow-v1` 的 import 列表加入 `GANTT_FLAG`、`ganttProgressOverride`（按字母顺序放在 `FEASIBILITY_TO_CHECK` 之后）：

```ts
import {
  BLOCKER_STATUS,
  FEASIBILITY_TO_CHECK,
  GANTT_FLAG,
  ganttProgressOverride,
  ITERATION_LOG_LABEL,
  LINE_OPTIONS,
  planeStatusToState,
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
```

2. 甘特任务循环（`for (const g of data.push.ganttTasks) {`）里，把

```ts
    const status = !start ? 'todo' : end! <= ctx.opts.asOf ? 'done' : start <= ctx.opts.asOf ? 'doing' : 'todo';
```

替换为：

```ts
    const flagKey = (g.flag ?? '').trim();
    if (!(flagKey in GANTT_FLAG)) ctx.problem(`push 甘特任务标记「${flagKey}」没有对应规则`);
    const progress = ganttProgressOverride(g.ov_progress, g.actual_status);
    const status =
      g.actual_status?.trim() === '已完成' ? 'done' : !start ? 'todo' : end! <= ctx.opts.asOf ? 'done' : start <= ctx.opts.asOf ? 'doing' : 'todo';
```

3. 同一个 `rows.tasks.push({…})` 里，把

```ts
      flag: g.flag,
```

替换为：

```ts
      flag: GANTT_FLAG[flagKey] ?? null,
```

把

```ts
      meta: { note: g.note, actualStatus: g.actual_status, manual: g.manual, ovAssignee: g.ov_assignee, ovStatus: g.ov_status, ovProgress: g.ov_progress },
```

替换为：

```ts
      meta: {
        note: g.note,
        actualStatus: g.actual_status,
        manual: g.manual,
        ovAssignee: g.ov_assignee,
        ovStatus: g.ov_status,
        ovProgress: g.ov_progress,
        ...(progress === null ? {} : { progress }),
      },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate test` 与 `pnpm typecheck`
Expected: PASS（`perf.test.ts` 用同一份夹具导入，也应通过）。

- [ ] **Step 5: 提交**

```bash
git add packages/migrate/src/workflow-v1.ts packages/migrate/src/plan-requirements.ts packages/migrate/test/plan-requirements.test.ts
git commit -m "feat(migrate): push 甘特任务的标记映射为 attention，手动进度写入 meta.progress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: 评审队列：整体评审状态、会签进度、待签判定与按检查项生成的队列

**Files:**
- Modify: `packages/core/src/requirements/workflow-runtime.ts`（`ReviewState`、`SignoffRecord`、`WaitingRule`、`reviewStateOf`、`reviewStarted`、`signoffProgress`、`waitingRules`；`signoffResultState` 复用最近结论的计算）
- Create: `packages/core/src/reviews/snapshot.ts`
- Create: `packages/core/src/reviews/queue.ts`
- Modify: `packages/core/src/requirements/detail.ts`（改用 `reviews/snapshot.ts` 的 `signerIdentity`）
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/factories.ts`（`reviewWorkflow`）
- Test: `packages/core/test/review-runtime.test.ts`、`packages/core/test/review-queue.test.ts`

**Interfaces:**
- Consumes: `checkStatesFor`、`matchingSignerRules`、`CheckItem`、`SignerIdentity`（`workflow-runtime.ts`）；`requirementAssignments`（`db/schema.ts`）；`productWorkflowBody`、`memberNames`；`displayKey`、`MemberRef`；Task 3 导出的 `stateInfoByProduct`、`stateOf`、`StateInfo`；`requireProductRole`
- Produces（`workflow-runtime.ts`）：
  - `type ReviewState = 'not_started' | 'in_progress' | 'rejected' | 'passed'`
  - `type SignoffRecord = { signerRuleIndex: number; decision: 'passed' | 'rejected'; at: Date }`
  - `type WaitingRule = { ruleIndex: number; onBehalf: boolean }`
  - `reviewStateOf(states: CheckState[]): ReviewState`
  - `reviewStarted(items: CheckItem[], checks: Record<string, CheckState>): boolean`（只看 `scope = requirement` 的检查项）
  - `signoffProgress(item: CheckItem, signoffs: SignoffRecord[]): { passed: number; total: number }`
  - `waitingRules(item: CheckItem, ctx: { state: CheckState; signedRules: Set<number>; reviewStarted: boolean; who: SignerIdentity; canSignOnBehalf: boolean; assignees: Map<string, Set<string>> }): WaitingRule[]`（`assignees`：职能标签 id → 这条需求上以该标签分配的成员 id）
- Produces（`reviews/snapshot.ts`）：
  - `type CheckSnapshot = { states: Record<string, CheckState>; signoffs: Map<string, SignoffRecord[]>; assignees: Map<string, Set<string>> }`（`assignees` 来自 `requirement_assignments` 中带职能标签的行）
  - `checkSnapshots(tx: Tx, body: WorkflowBody, requirementIds: string[]): Promise<Map<string, CheckSnapshot>>`
  - `signerIdentity(tx: Tx, actor: Actor, role: ProductRole): Promise<SignerIdentity>`（Task 6 使用）
- Produces（`reviews/queue.ts`）：
  - `REVIEW_FILTER_STATES = ['open', 'all', 'not_started', 'in_progress', 'rejected', 'passed'] as const`；`type ReviewFilterState`
  - `type ReviewQueueFilter = { state?: ReviewFilterState; itemKey?: string; itemState?: CheckState; waitingForMe?: boolean }`
  - `type ReviewCell = { state: CheckState; passed: number | null; total: number | null }`（普通检查项的 `passed`、`total` 为 `null`）
  - `type ReviewWaiting = { itemKey: string; ruleIndex: number; onBehalf: boolean }`
  - `type ReviewRow = { id: string; displayKey: string; title: string; state: StateInfo; owner: MemberRef | null; reviewState: ReviewState; cells: Record<string, ReviewCell>; waiting: ReviewWaiting[] }`
  - `type ReviewQueue = { columns: Array<{ key: string; label: string; type: 'single' | 'signoff' }>; stats: Record<ReviewState, number>; rows: ReviewRow[] }`
  - `listReviewQueue(db, actor, productId: string, filter?: ReviewQueueFilter): Promise<ReviewQueue>`（行按编号倒序；`stats` 统计全部未完成需求，不受筛选影响；`state` 默认 `open`）
- Produces（`test/factories.ts`）：`reviewWorkflow(designTagId: string, bossMemberId: string): WorkflowBody`（Task 6 使用）

- [ ] **Step 1: 写失败的单元测试**

`packages/core/test/review-runtime.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  type CheckItem,
  reviewStarted,
  reviewStateOf,
  signoffProgress,
  signoffResultState,
  waitingRules,
} from '../src/requirements/workflow-runtime';

const design: CheckItem = {
  key: 'design',
  label: '设计签字',
  scope: 'requirement',
  type: 'signoff',
  signers: [
    { by: 'function_tag', ref: 'tag-ui' },
    { by: 'member', ref: 'boss' },
    { by: 'product_role', ref: 'admin' },
  ],
  signoffRule: 'all',
  defaultState: 'not_started',
};
const at = (minute: number) => new Date(Date.UTC(2026, 8, 30, 0, minute));
const who = { memberId: 'me', functionTagIds: ['tag-ui'], productRole: 'editor' as const };

describe('整体评审状态', () => {
  it('忽略不需要；任一驳回为有驳回；全部通过为已通过；全部未开始为未开始；其余为评审中', () => {
    expect(reviewStateOf(['not_started', 'not_started'])).toBe('not_started');
    expect(reviewStateOf(['passed', 'not_started'])).toBe('in_progress');
    expect(reviewStateOf(['in_progress', 'not_needed'])).toBe('in_progress');
    expect(reviewStateOf(['passed', 'rejected', 'not_started'])).toBe('rejected');
    expect(reviewStateOf(['passed', 'not_needed'])).toBe('passed');
    expect(reviewStateOf(['not_needed'])).toBe('passed');
    expect(reviewStateOf([])).toBe('passed');
  });

  it('评审是否已开始：任一需求检查项不在默认状态；PRD 类检查项不计', () => {
    const items: CheckItem[] = [
      { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', defaultState: 'not_needed' },
      { key: 'doc_check', label: '文档检查', scope: 'document', type: 'single', defaultState: 'not_started' },
    ];
    expect(reviewStarted(items, { feasibility: 'not_started', prd: 'not_needed', doc_check: 'passed' })).toBe(false);
    expect(reviewStarted(items, { feasibility: 'passed', prd: 'not_needed', doc_check: 'not_started' })).toBe(true);
    expect(reviewStarted(items, { feasibility: 'not_started', prd: 'not_started', doc_check: 'not_started' })).toBe(true);
  });
});

describe('会签', () => {
  it('会签进度按每条规则最近一次的结论统计通过数；结果状态的计算不变', () => {
    expect(signoffProgress(design, [])).toEqual({ passed: 0, total: 3 });
    expect(
      signoffProgress(design, [
        { signerRuleIndex: 0, decision: 'rejected', at: at(1) },
        { signerRuleIndex: 0, decision: 'passed', at: at(2) },
        { signerRuleIndex: 1, decision: 'passed', at: at(3) },
        { signerRuleIndex: 2, decision: 'rejected', at: at(4) },
      ]),
    ).toEqual({ passed: 2, total: 3 });
    expect(signoffResultState(design, [{ signerRuleIndex: 1, decision: 'passed', at: at(1) }])).toBe('in_progress');
    expect(signoffResultState(design, [{ signerRuleIndex: 1, decision: 'rejected', at: at(1) }])).toBe('rejected');
  });

  it('待签：评审已开始、检查项未开始或进行中、规则尚无签字；本人匹配的算待我签，管理员对指定成员的规则算可代签', () => {
    const ctx = { state: 'not_started' as const, signedRules: new Set<number>(), reviewStarted: true, who, canSignOnBehalf: false, assignees: new Map<string, Set<string>>() };
    expect(waitingRules(design, ctx)).toEqual([{ ruleIndex: 0, onBehalf: false }]);
    expect(waitingRules(design, { ...ctx, state: 'in_progress', who: { ...who, productRole: 'admin' }, canSignOnBehalf: true })).toEqual([
      { ruleIndex: 0, onBehalf: false },
      { ruleIndex: 1, onBehalf: true },
      { ruleIndex: 2, onBehalf: false },
    ]);
    expect(waitingRules(design, { ...ctx, signedRules: new Set([0]) })).toEqual([]);
    expect(waitingRules(design, { ...ctx, reviewStarted: false })).toEqual([]);
    expect(waitingRules(design, { ...ctx, state: 'passed' })).toEqual([]);
    expect(waitingRules(design, { ...ctx, state: 'rejected' })).toEqual([]);
    expect(waitingRules({ ...design, type: 'single', signers: undefined, signoffRule: undefined }, ctx)).toEqual([]);
    expect(waitingRules({ ...design, signers: [{ by: 'member', ref: 'me' }] }, { ...ctx, canSignOnBehalf: true })).toEqual([{ ruleIndex: 0, onBehalf: false }]);
  });

  it('该谁签字就推给谁：职能标签规则只推给以该标签分配到需求的人，没有该标签的分配时推给全部持有者；代签不受分配影响', () => {
    const ctx = { state: 'not_started' as const, signedRules: new Set<number>(), reviewStarted: true, who, canSignOnBehalf: false, assignees: new Map<string, Set<string>>() };
    expect(waitingRules(design, { ...ctx, assignees: new Map([['tag-ui', new Set(['me'])]]) })).toEqual([{ ruleIndex: 0, onBehalf: false }]);
    expect(waitingRules(design, { ...ctx, assignees: new Map([['tag-ui', new Set(['other'])]]) })).toEqual([]);
    expect(waitingRules(design, { ...ctx, assignees: new Map([['tag-dev', new Set(['other'])]]) })).toEqual([{ ruleIndex: 0, onBehalf: false }]);
    const admin = { ...ctx, who: { ...who, productRole: 'admin' as const }, canSignOnBehalf: true, assignees: new Map([['tag-ui', new Set(['other'])]]) };
    expect(waitingRules(design, admin)).toEqual([
      { ruleIndex: 1, onBehalf: true },
      { ruleIndex: 2, onBehalf: false },
    ]);
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/review-runtime.test.ts`
Expected: FAIL，`reviewStateOf` 等未导出。

- [ ] **Step 2: 实现纯函数**

`packages/core/src/requirements/workflow-runtime.ts`：

1. 顶部类型定义之后（`export type SignerIdentity = …` 之后）加入：

```ts
export type ReviewState = 'not_started' | 'in_progress' | 'rejected' | 'passed';
export type SignoffRecord = { signerRuleIndex: number; decision: 'passed' | 'rejected'; at: Date };
export type WaitingRule = { ruleIndex: number; onBehalf: boolean };
```

2. 把现有的 `signoffResultState` 整个替换为（先抽出最近结论的计算，再加入新的函数）：

```ts
/** 每条签字规则最近一次的结论。 */
function latestDecisions(signoffs: SignoffRecord[]): Map<number, 'passed' | 'rejected'> {
  const latest = new Map<number, 'passed' | 'rejected'>();
  for (const s of [...signoffs].sort((a, b) => a.at.getTime() - b.at.getTime())) latest.set(s.signerRuleIndex, s.decision);
  return latest;
}

export function signoffResultState(item: CheckItem, signoffs: SignoffRecord[]): CheckState {
  if (signoffs.length === 0) return 'not_started';
  const latest = latestDecisions(signoffs);
  const decisions = [...latest.values()];
  if (decisions.includes('rejected')) return 'rejected';
  if (item.signoffRule === 'any') return 'passed';
  const need = item.signers?.length ?? 0;
  return latest.size >= need ? 'passed' : 'in_progress';
}

/** 会签进度：最近一次结论为通过的规则数 / 规则总数。 */
export function signoffProgress(item: CheckItem, signoffs: SignoffRecord[]): { passed: number; total: number } {
  const passed = [...latestDecisions(signoffs).values()].filter((d) => d === 'passed').length;
  return { passed, total: item.signers?.length ?? 0 };
}

/**
 * 需求的整体评审状态：忽略「不需要」的检查项；任一驳回 = 有驳回；全部通过 = 已通过；
 * 全部未开始 = 未开始；其余为评审中。没有需要评审的检查项时视为已通过。
 */
export function reviewStateOf(states: CheckState[]): ReviewState {
  const relevant = states.filter((s) => s !== 'not_needed');
  if (relevant.includes('rejected')) return 'rejected';
  if (relevant.every((s) => s === 'passed')) return 'passed';
  if (relevant.every((s) => s === 'not_started')) return 'not_started';
  return 'in_progress';
}

/** 需求的评审是否已经开始：任一需求检查项不在它的默认状态。 */
export function reviewStarted(items: CheckItem[], checks: Record<string, CheckState>): boolean {
  return items.some((c) => c.scope === 'requirement' && checks[c.key] !== undefined && checks[c.key] !== c.defaultState);
}

/**
 * 某个会签检查项上等操作者签的规则：评审已开始、检查项未开始或进行中、规则还没有任何签字。
 * 「该谁签字就推给谁」：职能标签规则只推给以该标签分配到这条需求的成员（assignees：标签 id → 成员 id），
 * 需求上没有该标签的分配时推给全部持有者；指定成员、产品角色规则按规则本身匹配。
 * 匹配本人时为「待我签」；产品管理员对指定其他成员的规则为「可代签」，不受分配影响。
 */
export function waitingRules(
  item: CheckItem,
  ctx: {
    state: CheckState;
    signedRules: Set<number>;
    reviewStarted: boolean;
    who: SignerIdentity;
    canSignOnBehalf: boolean;
    assignees: Map<string, Set<string>>;
  },
): WaitingRule[] {
  if (item.type !== 'signoff' || !ctx.reviewStarted || (ctx.state !== 'not_started' && ctx.state !== 'in_progress')) return [];
  const mine = new Set(matchingSignerRules(item, ctx.who));
  const out: WaitingRule[] = [];
  (item.signers ?? []).forEach((s, i) => {
    if (ctx.signedRules.has(i)) return;
    const assigned = s.by === 'function_tag' ? ctx.assignees.get(s.ref) : undefined;
    const assignedToOthers = !!assigned && assigned.size > 0 && !assigned.has(ctx.who.memberId);
    if (mine.has(i) && !assignedToOthers) out.push({ ruleIndex: i, onBehalf: false });
    else if (ctx.canSignOnBehalf && s.by === 'member' && s.ref !== ctx.who.memberId) out.push({ ruleIndex: i, onBehalf: true });
  });
  return out;
}
```

Run: `pnpm --filter @flower/core exec vitest run test/review-runtime.test.ts test/requirement-workflow.test.ts`
Expected: PASS（`signoffResultState` 行为不变，会签相关旧用例仍通过）。

- [ ] **Step 3: 写评审队列的失败测试**

`packages/core/test/factories.ts` 末尾追加：

```ts
/**
 * 带「可行性」「设计签字」「PRD」三个需求检查项的流程；设计签字由设计标签与一位指定成员会签。
 * 状态含进行中、已上线（已完成类）、已搁置（已取消类）。评审队列与工作台测试共用。
 */
export function reviewWorkflow(designTagId: string, bossMemberId: string): WorkflowBody {
  return {
    states: [
      { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
      { key: 'doing', label: '开发中', color: '#f59e0b', order: 2, group: '', category: 'started' },
      { key: 'done', label: '已上线', color: '#10b981', order: 3, group: '', category: 'completed' },
      { key: 'dropped', label: '已搁置', color: '#9ca3af', order: 4, group: '', category: 'canceled' },
    ],
    initial: 'backlog',
    transitions: [
      { from: '*', to: 'backlog', conditions: [] },
      { from: '*', to: 'doing', conditions: [] },
      { from: '*', to: 'done', conditions: [] },
      { from: '*', to: 'dropped', conditions: [] },
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
          { by: 'function_tag', ref: designTagId },
          { by: 'member', ref: bossMemberId },
        ],
        signoffRule: 'all',
        defaultState: 'not_started',
      },
      { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', defaultState: 'not_started' },
    ],
  };
}
```

`packages/core/test/review-queue.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requirementAssignments, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { createRequirement } from '../src/requirements/requirements';
import { setCheckItemState, signCheckItem } from '../src/requirements/transitions';
import { listReviewQueue } from '../src/reviews/queue';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { setMemberFunctionTags } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, reviewWorkflow, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let designer: Actor;
let boss: Actor;
let pan: string;
let doc: string;
let designTag: string;
const ids: Record<string, string> = {};
const assignDesigner = (requirementId: string, memberId: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.insert(requirementAssignments).values({ orgId: owner.orgId, requirementId, memberId, functionTagId: designTag }));
const waitingKeys = async (who: Actor) => (await listReviewQueue(t.db, who, pan, { waitingForMe: true })).rows.map((r) => r.displayKey);

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  designer = await asMember(t.db, owner, '设计师甲');
  await setMemberFunctionTags(t.db, owner, designer.memberId, [designTag]);
  boss = await asMember(t.db, owner, '老板乙');
  await setProductRole(t.db, owner, pan, boss.memberId, 'viewer');
  const { version } = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  // PAN-1 未开始，PAN-2 评审中，PAN-3 有驳回，PAN-4 已通过，PAN-5 已上线（不在队列里）
  for (const title of ['未开始的需求', '评审中的需求', '被驳回的需求', '已通过的需求', '已上线的需求']) {
    ids[title] = (await createRequirement(t.db, owner, pan, { title })).id;
  }
  await createRequirement(t.db, owner, doc, { title: '文档需求' });
  await setCheckItemState(t.db, owner, ids['评审中的需求']!, 'feasibility', { state: 'passed' });
  await setCheckItemState(t.db, owner, ids['被驳回的需求']!, 'feasibility', { state: 'rejected' });
  const passed = ids['已通过的需求']!;
  await setCheckItemState(t.db, owner, passed, 'feasibility', { state: 'passed' });
  await setCheckItemState(t.db, owner, passed, 'prd', { state: 'not_needed' });
  await signCheckItem(t.db, designer, passed, 'design', { decision: 'passed' });
  await signCheckItem(t.db, boss, passed, 'design', { decision: 'passed' });
  await withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ stateKey: 'done' }).where(eq(requirements.id, ids['已上线的需求']!)));
});
afterAll(() => t.cleanup());

describe('评审队列', () => {
  it('列按流程检查项生成；默认列出未完成需求中评审没有全部通过的；统计按整体评审状态', async () => {
    const q = await listReviewQueue(t.db, owner, pan);
    expect(q.columns).toEqual([
      { key: 'feasibility', label: '可行性', type: 'single' },
      { key: 'design', label: '设计签字', type: 'signoff' },
      { key: 'prd', label: 'PRD', type: 'single' },
    ]);
    expect(q.stats).toEqual({ not_started: 1, in_progress: 1, rejected: 1, passed: 1 });
    expect(q.rows.map((r) => [r.displayKey, r.reviewState])).toEqual([
      ['PAN-3', 'rejected'],
      ['PAN-2', 'in_progress'],
      ['PAN-1', 'not_started'],
    ]);
    expect(q.rows[1]).toMatchObject({ title: '评审中的需求', state: { label: '收集' } });
    expect(q.rows[1]!.cells).toEqual({
      feasibility: { state: 'passed', passed: null, total: null },
      design: { state: 'not_started', passed: 0, total: 2 },
      prd: { state: 'not_started', passed: null, total: null },
    });
  });

  it('按整体状态与单个检查项的状态筛选，统计不受筛选影响', async () => {
    const passed = await listReviewQueue(t.db, owner, pan, { state: 'passed' });
    expect(passed.rows.map((r) => r.displayKey)).toEqual(['PAN-4']);
    expect(passed.stats).toEqual({ not_started: 1, in_progress: 1, rejected: 1, passed: 1 });
    expect((await listReviewQueue(t.db, owner, pan, { state: 'all' })).rows).toHaveLength(4);
    const feasible = await listReviewQueue(t.db, owner, pan, { state: 'all', itemKey: 'feasibility', itemState: 'passed' });
    expect(feasible.rows.map((r) => r.displayKey)).toEqual(['PAN-4', 'PAN-2']);
  });

  it('等我签字：评审已开始的需求上本人未签的规则；产品管理员可代签指定成员；签过后不再出现', async () => {
    const mine = await listReviewQueue(t.db, designer, pan, { waitingForMe: true });
    expect(mine.rows.map((r) => [r.displayKey, r.waiting])).toEqual([
      ['PAN-3', [{ itemKey: 'design', ruleIndex: 0, onBehalf: false }]],
      ['PAN-2', [{ itemKey: 'design', ruleIndex: 0, onBehalf: false }]],
    ]);
    const proxy = await listReviewQueue(t.db, owner, pan, { waitingForMe: true });
    expect(proxy.rows.map((r) => [r.displayKey, r.waiting])).toEqual([
      ['PAN-3', [{ itemKey: 'design', ruleIndex: 1, onBehalf: true }]],
      ['PAN-2', [{ itemKey: 'design', ruleIndex: 1, onBehalf: true }]],
    ]);
    await signCheckItem(t.db, designer, ids['评审中的需求']!, 'design', { decision: 'passed' });
    expect((await listReviewQueue(t.db, designer, pan, { waitingForMe: true })).rows.map((r) => r.displayKey)).toEqual(['PAN-3']);
    const row = (await listReviewQueue(t.db, boss, pan, { waitingForMe: true })).rows.find((r) => r.displayKey === 'PAN-2')!;
    expect(row.cells.design).toEqual({ state: 'in_progress', passed: 1, total: 2 });
    expect(row.waiting).toEqual([{ itemKey: 'design', ruleIndex: 1, onBehalf: false }]);
  });

  it('该谁签字就推给谁：被分配的设计看得到，没被分配的同标签成员看不到；没有分配时推给全部设计；评审没开始的不推', async () => {
    const other = await asMember(t.db, owner, '设计师丙');
    await setMemberFunctionTags(t.db, owner, other.memberId, [designTag]);
    // PAN-6：评审已开始，设计分配给设计师甲
    const assigned = (await createRequirement(t.db, owner, pan, { title: '指派了设计的需求' })).id;
    await setCheckItemState(t.db, owner, assigned, 'feasibility', { state: 'passed' });
    await assignDesigner(assigned, designer.memberId);
    // PAN-7：设计分配给设计师丙，但评审还没开始
    await assignDesigner((await createRequirement(t.db, owner, pan, { title: '评审没开始的需求' })).id, other.memberId);

    // 设计师甲：看到分配给他的 PAN-6；PAN-3 没有设计分配，回退为推给全部设计（PAN-2 他已经签过）
    expect(await waitingKeys(designer)).toEqual(['PAN-6', 'PAN-3']);
    // 设计师丙：同样持有设计标签，但 PAN-6 分配给了别人；PAN-7 分配给了他，但评审没开始，也不推
    expect(await waitingKeys(other)).toEqual(['PAN-3']);
  });

  it('只读 Token 可以查看但没有待签；看不到产品返回 404；流程没有检查项时返回空表', async () => {
    const ro = await listReviewQueue(t.db, readOnlyToken(owner), pan);
    expect(ro.rows.length).toBeGreaterThan(0);
    expect(ro.rows.every((r) => r.waiting.length === 0)).toBe(true);
    const outsider = await asMember(t.db, owner, '访客丙', 'guest');
    await expect(listReviewQueue(t.db, outsider, pan)).rejects.toMatchObject({ code: 'not_found' });
    expect(await listReviewQueue(t.db, owner, doc)).toEqual({ columns: [], stats: { not_started: 0, in_progress: 0, rejected: 0, passed: 0 }, rows: [] });
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/review-queue.test.ts`
Expected: FAIL，找不到模块 `../src/reviews/queue`。

- [ ] **Step 4: 实现快照与队列**

`packages/core/src/reviews/snapshot.ts`：

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
import { checkItemResults, checkItemSignoffs, memberFunctionTags, requirementAssignments } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import type { Actor, ProductRole } from '../domain-types';
import type { CheckState } from '../requirements/labels';
import { checkStatesFor, type SignerIdentity, type SignoffRecord } from '../requirements/workflow-runtime';

export type CheckSnapshot = {
  states: Record<string, CheckState>;
  signoffs: Map<string, SignoffRecord[]>;
  /** 职能标签 id → 以该标签分配到这条需求的成员 id（requirement_assignments 中带职能标签的行）。 */
  assignees: Map<string, Set<string>>;
};

/** 一批需求的检查项状态（缺省按流程默认状态）、会签记录（按检查项分组、按时间排序）与按职能标签的分配。 */
export async function checkSnapshots(tx: Tx, body: WorkflowBody, requirementIds: string[]): Promise<Map<string, CheckSnapshot>> {
  const results = requirementIds.length
    ? await tx
        .select({ id: checkItemResults.id, targetId: checkItemResults.targetId, itemKey: checkItemResults.itemKey, state: checkItemResults.state })
        .from(checkItemResults)
        .where(and(eq(checkItemResults.targetType, 'requirement'), inArray(checkItemResults.targetId, requirementIds)))
    : [];
  const signoffs = results.length
    ? await tx
        .select({
          resultId: checkItemSignoffs.resultId,
          signerRuleIndex: checkItemSignoffs.signerRuleIndex,
          decision: checkItemSignoffs.decision,
          at: checkItemSignoffs.at,
        })
        .from(checkItemSignoffs)
        .where(inArray(checkItemSignoffs.resultId, results.map((r) => r.id)))
        .orderBy(asc(checkItemSignoffs.at), asc(checkItemSignoffs.id))
    : [];
  const byResult = new Map<string, SignoffRecord[]>();
  for (const s of signoffs) {
    const list = byResult.get(s.resultId) ?? [];
    list.push({ signerRuleIndex: s.signerRuleIndex, decision: s.decision, at: s.at });
    byResult.set(s.resultId, list);
  }
  const assignmentRows = requirementIds.length
    ? await tx
        .select({ requirementId: requirementAssignments.requirementId, memberId: requirementAssignments.memberId, tagId: requirementAssignments.functionTagId })
        .from(requirementAssignments)
        .where(inArray(requirementAssignments.requirementId, requirementIds))
    : [];
  const assigneesByRequirement = new Map<string, Map<string, Set<string>>>();
  for (const a of assignmentRows) {
    if (!a.tagId) continue;
    const byTag = assigneesByRequirement.get(a.requirementId) ?? new Map<string, Set<string>>();
    const members = byTag.get(a.tagId) ?? new Set<string>();
    members.add(a.memberId);
    byTag.set(a.tagId, members);
    assigneesByRequirement.set(a.requirementId, byTag);
  }
  const byRequirement = new Map<string, typeof results>();
  for (const r of results) {
    const list = byRequirement.get(r.targetId) ?? [];
    list.push(r);
    byRequirement.set(r.targetId, list);
  }
  const out = new Map<string, CheckSnapshot>();
  for (const id of requirementIds) {
    const mine = byRequirement.get(id) ?? [];
    out.set(id, {
      states: checkStatesFor(body, mine.map((r) => ({ itemKey: r.itemKey, state: r.state }))),
      signoffs: new Map(mine.map((r) => [r.itemKey, byResult.get(r.id) ?? []])),
      assignees: assigneesByRequirement.get(id) ?? new Map(),
    });
  }
  return out;
}

/** 操作者作为签字人的身份：成员本人、职能标签、在该产品上的角色。 */
export async function signerIdentity(tx: Tx, actor: Actor, role: ProductRole): Promise<SignerIdentity> {
  const tags = await tx.select({ tagId: memberFunctionTags.tagId }).from(memberFunctionTags).where(eq(memberFunctionTags.memberId, actor.memberId));
  return { memberId: actor.memberId, functionTagIds: tags.map((x) => x.tagId), productRole: role };
}
```

`packages/core/src/reviews/queue.ts`：

```ts
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { products, requirements } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { type StateInfo, stateInfoByProduct, stateOf } from '../iterations/iterations';
import { memberNames, productWorkflowBody } from '../requirements/context';
import type { CheckState } from '../requirements/labels';
import { displayKey, type MemberRef } from '../requirements/requirements';
import { type ReviewState, reviewStarted, reviewStateOf, signoffProgress, waitingRules } from '../requirements/workflow-runtime';
import { checkSnapshots, signerIdentity } from './snapshot';

export const REVIEW_FILTER_STATES = ['open', 'all', 'not_started', 'in_progress', 'rejected', 'passed'] as const;
export type ReviewFilterState = (typeof REVIEW_FILTER_STATES)[number];
export type ReviewQueueFilter = { state?: ReviewFilterState; itemKey?: string; itemState?: CheckState; waitingForMe?: boolean };
export type ReviewCell = { state: CheckState; passed: number | null; total: number | null };
export type ReviewWaiting = { itemKey: string; ruleIndex: number; onBehalf: boolean };
export type ReviewRow = {
  id: string;
  displayKey: string;
  title: string;
  state: StateInfo;
  owner: MemberRef | null;
  reviewState: ReviewState;
  cells: Record<string, ReviewCell>;
  waiting: ReviewWaiting[];
};
export type ReviewQueue = {
  columns: Array<{ key: string; label: string; type: 'single' | 'signoff' }>;
  stats: Record<ReviewState, number>;
  rows: ReviewRow[];
};

/**
 * 批量评审表：产品内未完成（状态类别不是已完成 / 已取消）的需求，每个需求检查项一列。
 * 统计覆盖全部未完成需求；state 默认 open（整体评审状态不是已通过）。
 */
export async function listReviewQueue(db: Db, actor: Actor, productId: string, filter: ReviewQueueFilter = {}): Promise<ReviewQueue> {
  return withOrg(db, actor.orgId, async (tx) => {
    const role = await requireProductRole(tx, actor, productId, 'viewer');
    const body = await productWorkflowBody(tx, productId);
    const items = body.checkItems.filter((c) => c.scope === 'requirement');
    const columns = items.map((c) => ({ key: c.key, label: c.label, type: c.type }));
    const stats: Record<ReviewState, number> = { not_started: 0, in_progress: 0, rejected: 0, passed: 0 };
    const openKeys = body.states.filter((s) => s.category !== 'completed' && s.category !== 'canceled').map((s) => s.key);
    if (items.length === 0 || openKeys.length === 0) return { columns, stats, rows: [] };

    const reqRows = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.productId, productId), isNull(requirements.deletedAt), inArray(requirements.stateKey, openKeys)))
      .orderBy(desc(requirements.number));
    const snaps = await checkSnapshots(tx, body, reqRows.map((r) => r.id));
    const who = await signerIdentity(tx, actor, role);
    const canSign = actor.tokenScope?.access !== 'read';
    const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.id, productId));
    const info = await stateInfoByProduct(tx, [productId]);
    const names = await memberNames(tx, reqRows.map((r) => r.ownerMemberId));

    const all: ReviewRow[] = reqRows.map((r) => {
      const snap = snaps.get(r.id)!;
      const started = reviewStarted(items, snap.states);
      const cells: Record<string, ReviewCell> = {};
      const waiting: ReviewWaiting[] = [];
      for (const c of items) {
        const state = snap.states[c.key]!;
        const signoffs = snap.signoffs.get(c.key) ?? [];
        const progress = c.type === 'signoff' ? signoffProgress(c, signoffs) : null;
        cells[c.key] = { state, passed: progress?.passed ?? null, total: progress?.total ?? null };
        if (!canSign) continue;
        const rules = waitingRules(c, {
          state,
          signedRules: new Set(signoffs.map((s) => s.signerRuleIndex)),
          reviewStarted: started,
          who,
          canSignOnBehalf: role === 'admin',
          assignees: snap.assignees,
        });
        for (const w of rules) waiting.push({ itemKey: c.key, ...w });
      }
      return {
        id: r.id,
        displayKey: displayKey(product!.key, r.number),
        title: r.title,
        state: stateOf(info, productId, r.stateKey),
        owner: r.ownerMemberId ? { id: r.ownerMemberId, displayName: names.get(r.ownerMemberId) ?? '已删除的成员' } : null,
        reviewState: reviewStateOf(items.map((c) => snap.states[c.key]!)),
        cells,
        waiting,
      };
    });
    for (const r of all) stats[r.reviewState] += 1;
    const state = filter.state ?? 'open';
    const rows = all.filter(
      (r) =>
        (state === 'all' || (state === 'open' ? r.reviewState !== 'passed' : r.reviewState === state)) &&
        (!filter.itemKey || !filter.itemState || r.cells[filter.itemKey]?.state === filter.itemState) &&
        (!filter.waitingForMe || r.waiting.length > 0),
    );
    return { columns, stats, rows };
  });
}
```

`packages/core/src/requirements/detail.ts`：

1. 从 schema import 列表中删除 `memberFunctionTags,`。
2. 删除本地函数 `signerIdentity`（`async function signerIdentity(tx: Tx, actor: Actor, role: ProductRole) { … }` 整段）。
3. 在 `import { joinIterationUnmet } from '../iterations/membership';` 之后加入：

```ts
import { signerIdentity } from '../reviews/snapshot';
```

`packages/core/src/index.ts` 末尾追加：

```ts
export * from './reviews/snapshot';
export * from './reviews/queue';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/review-runtime.test.ts test/review-queue.test.ts test/requirement-workflow.test.ts` 与 `pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/requirements/workflow-runtime.ts packages/core/src/reviews packages/core/src/requirements/detail.ts packages/core/src/index.ts packages/core/test/factories.ts packages/core/test/review-runtime.test.ts packages/core/test/review-queue.test.ts
git commit -m "feat(core): 按流程检查项生成的评审队列：整体评审状态、会签进度与等我签字

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: 跨组织工作台服务

**Files:**
- Create: `packages/core/src/workbench/workbench.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/workbench.test.ts`

**Interfaces:**
- Consumes: `listMyOrganizations`（`tenancy/orgs.ts`，`withSystem` 的成员关系查找）；`visibleProductIds`、`productRoleOf`；Task 2 的 `hydrateTasks`、`orgToday`、`TaskStatus`；Task 3 的 `stateInfoByProduct`、`stateOf`、`StateInfo`；Task 5 的 `checkSnapshots`、`signerIdentity`、`reviewStarted`、`waitingRules`；`productWorkflowBody`、`memberNames`、`displayKey`
- Produces（`workbench/workbench.ts`）：
  - `WORKBENCH_LIMIT = 100`
  - `type WorkbenchOrg = { id: string; slug: string; name: string }`
  - `type WorkbenchRequirement = { org: WorkbenchOrg; id: string; displayKey: string; title: string; state: StateInfo; updatedAt: Date }`
  - `type WorkbenchTask = { org: WorkbenchOrg; id: string; title: string; requirement: { displayKey: string; title: string } | null; iteration: { id: string; name: string } | null; status: TaskStatus; planStart: string | null; progress: number }`
  - `type WorkbenchSignature = { org: WorkbenchOrg; requirementId: string; displayKey: string; title: string; itemKey: string; itemLabel: string; ruleIndex: number; onBehalfOf: string | null }`
  - `type WorkbenchUnread = { org: WorkbenchOrg; requirementId: string; displayKey: string; title: string; unread: number; lastAt: Date }`
  - `type WorkbenchSection<T> = { total: number; items: T[] }`
  - `type Workbench = { orgs: WorkbenchOrg[]; owned: WorkbenchSection<WorkbenchRequirement>; tasks: WorkbenchSection<WorkbenchTask>; signatures: WorkbenchSection<WorkbenchSignature>; unread: WorkbenchSection<WorkbenchUnread> }`
  - `getWorkbench(db, accountId: string, opts?: { today?: string }): Promise<Workbench>`（排序：负责的需求按更新时间倒序；任务按开始日期，没有日期的在后；待签按编号；未读按最新评论时间倒序）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/workbench.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../src/auth/accounts';
import { requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { addRequirementComment, markRequirementCommentsRead } from '../src/requirements/comments';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { setCheckItemState } from '../src/requirements/transitions';
import { createTask, updateTask } from '../src/tasks/tasks';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { acceptInvitation, createInvitation } from '../src/tenancy/invitations';
import { setMemberFunctionTags } from '../src/tenancy/members';
import { createOrganization, type OrgView, resolveActor } from '../src/tenancy/orgs';
import { createProduct } from '../src/tenancy/products';
import { getWorkbench } from '../src/workbench/workbench';
import { createTestDb } from './db';
import { asMember, regularIteration, reviewWorkflow, seedInstance } from './factories';

const TODAY = '2026-09-30';
let t: Awaited<ReturnType<typeof createTestDb>>;
let account: AccountView;
let owner: Actor;
let peerAccountId: string;
let other: OrgView;
let mine: RequirementListItem;

beforeAll(async () => {
  t = await createTestDb();
  ({ account, owner } = await seedInstance(t.db));
  const pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  await setMemberFunctionTags(t.db, owner, owner.memberId, [designTag]);
  const boss = await asMember(t.db, owner, '老板乙');
  const { version } = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  const { token } = await createInvitation(t.db, owner, { email: 'peer@example.com', orgRole: 'member' });
  peerAccountId = (await acceptInvitation(t.db, token, { newAccount: { name: '同事丁', password: 'password123' } })).accountId;
  const peer = (await resolveActor(t.db, peerAccountId, 'acme'))!;

  mine = await createRequirement(t.db, owner, pan, { title: '上传提速', ownerMemberId: owner.memberId }); // PAN-1
  const shipped = await createRequirement(t.db, owner, pan, { title: '已上线的需求', ownerMemberId: owner.memberId }); // PAN-2
  await withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ stateKey: 'done' }).where(eq(requirements.id, shipped.id)));
  await createRequirement(t.db, owner, pan, { title: '同事负责的需求', ownerMemberId: peer.memberId }); // PAN-3
  await setCheckItemState(t.db, owner, mine.id, 'feasibility', { state: 'passed' });

  const sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0928', '2026-09-28', '2026-10-09'));
  await createTask(t.db, owner, { iterationId: sprint.id, requirementId: mine.id, title: '接口联调', assigneeMemberId: owner.memberId, planStart: '2026-09-28', planDays: 4 });
  const done = await createTask(t.db, owner, { iterationId: sprint.id, title: '已完成的任务', assigneeMemberId: owner.memberId });
  await updateTask(t.db, owner, done.id, { status: 'done' });
  await setIterationStatus(t.db, owner, sprint.id, 'active');
  const dropped = await createIteration(t.db, owner, regularIteration(pan, '迭代1012', '2026-10-12', '2026-10-23'));
  await createTask(t.db, owner, { iterationId: dropped.id, title: '取消迭代里的任务', assigneeMemberId: owner.memberId });
  await setIterationStatus(t.db, owner, dropped.id, 'canceled');
  await createTask(t.db, peer, { iterationId: sprint.id, title: '同事的任务', assigneeMemberId: peer.memberId });

  await addRequirementComment(t.db, peer, mine.id, { body: '接口文档在哪？' });
  await addRequirementComment(t.db, peer, mine.id, { body: '补充：需要鉴权吗？' });
  await addRequirementComment(t.db, owner, mine.id, { body: '稍后补上' });

  ({ org: other } = await createOrganization(t.db, account, { name: '第二组织', slug: 'other' }));
  const otherActor = (await resolveActor(t.db, account.id, 'other'))!;
  const docProduct = (await createProduct(t.db, otherActor, { name: '文档', key: 'DOC' })).id;
  await createRequirement(t.db, otherActor, docProduct, { title: '另一个组织的需求', ownerMemberId: otherActor.memberId });
});
afterAll(() => t.cleanup());

describe('工作台', () => {
  it('汇总本人在所有组织里负责的未完成需求，其他组织的行带组织信息', async () => {
    const wb = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(wb.orgs.map((o) => o.slug)).toEqual(['acme', 'other']);
    expect(wb.owned.total).toBe(2);
    expect(wb.owned.items.map((r) => `${r.org.slug}:${r.displayKey}`).sort()).toEqual(['acme:PAN-1', 'other:DOC-1']);
    expect(wb.owned.items.find((r) => r.displayKey === 'DOC-1')!.org).toEqual({ id: other.id, slug: 'other', name: '第二组织' });
    expect(wb.owned.items.find((r) => r.displayKey === 'PAN-1')!.state).toMatchObject({ label: '收集' });
  });

  it('指派给我的未完成任务，排除已完成的任务和已取消迭代里的任务', async () => {
    const wb = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(wb.tasks).toEqual({
      total: 1,
      items: [
        {
          org: { id: owner.orgId, slug: 'acme', name: '测试组织' },
          id: expect.any(String),
          title: '接口联调',
          requirement: { displayKey: 'PAN-1', title: '上传提速' },
          iteration: { id: expect.any(String), name: '迭代0928' },
          status: 'todo',
          planStart: '2026-09-28',
          progress: 50,
        },
      ],
    });
  });

  it('等我签字包括本人的规则和可以代签的规则', async () => {
    const wb = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(wb.signatures.items).toMatchObject([
      { displayKey: 'PAN-1', itemKey: 'design', itemLabel: '设计签字', ruleIndex: 0, onBehalfOf: null },
      { displayKey: 'PAN-1', itemKey: 'design', itemLabel: '设计签字', ruleIndex: 1, onBehalfOf: '老板乙' },
    ]);
  });

  it('我负责的需求上别人发的未读评论按需求合计；标记已读后消失', async () => {
    const before = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(before.unread.items).toMatchObject([{ displayKey: 'PAN-1', unread: 2 }]);
    await markRequirementCommentsRead(t.db, owner, mine.id);
    expect((await getWorkbench(t.db, account.id, { today: TODAY })).unread.total).toBe(0);
  });

  it('跨组织隔离：只属于一个组织的账号看不到其他组织的任何内容', async () => {
    const wb = await getWorkbench(t.db, peerAccountId, { today: TODAY });
    expect(wb.orgs.map((o) => o.slug)).toEqual(['acme']);
    expect(wb.owned.items.map((r) => r.displayKey)).toEqual(['PAN-3']);
    expect(wb.tasks.items.map((x) => x.title)).toEqual(['同事的任务']);
    expect(wb.signatures.total).toBe(0);
    expect(wb.unread.total).toBe(0);
    const all = [...wb.owned.items, ...wb.tasks.items, ...wb.signatures.items, ...wb.unread.items];
    expect(all.every((x) => x.org.slug === 'acme')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/workbench.test.ts`
Expected: FAIL，找不到模块 `../src/workbench/workbench`。

- [ ] **Step 3: 实现**

`packages/core/src/workbench/workbench.ts`：

```ts
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, commentReads, comments, iterations, products, requirements, tasks } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { type StateInfo, stateInfoByProduct, stateOf } from '../iterations/iterations';
import { memberNames, productWorkflowBody } from '../requirements/context';
import { displayKey } from '../requirements/requirements';
import { reviewStarted, waitingRules } from '../requirements/workflow-runtime';
import { checkSnapshots, signerIdentity } from '../reviews/snapshot';
import { hydrateTasks, orgToday, type TaskStatus } from '../tasks/tasks';
import { listMyOrganizations } from '../tenancy/orgs';

export const WORKBENCH_LIMIT = 100;

export type WorkbenchOrg = { id: string; slug: string; name: string };
export type WorkbenchRequirement = { org: WorkbenchOrg; id: string; displayKey: string; title: string; state: StateInfo; updatedAt: Date };
export type WorkbenchTask = {
  org: WorkbenchOrg;
  id: string;
  title: string;
  requirement: { displayKey: string; title: string } | null;
  iteration: { id: string; name: string } | null;
  status: TaskStatus;
  planStart: string | null;
  progress: number;
};
export type WorkbenchSignature = {
  org: WorkbenchOrg;
  requirementId: string;
  displayKey: string;
  title: string;
  itemKey: string;
  itemLabel: string;
  ruleIndex: number;
  /** 可代签时为被代签成员的名字；本人的规则为 null。 */
  onBehalfOf: string | null;
};
export type WorkbenchUnread = { org: WorkbenchOrg; requirementId: string; displayKey: string; title: string; unread: number; lastAt: Date };
export type WorkbenchSection<T> = { total: number; items: T[] };
export type Workbench = {
  orgs: WorkbenchOrg[];
  owned: WorkbenchSection<WorkbenchRequirement>;
  tasks: WorkbenchSection<WorkbenchTask>;
  signatures: WorkbenchSection<WorkbenchSignature>;
  unread: WorkbenchSection<WorkbenchUnread>;
};
type OrgPart = { owned: WorkbenchRequirement[]; tasks: WorkbenchTask[]; signatures: WorkbenchSignature[]; unread: WorkbenchUnread[] };

function section<T>(list: T[], compare: (a: T, b: T) => number): WorkbenchSection<T> {
  return { total: list.length, items: [...list].sort(compare).slice(0, WORKBENCH_LIMIT) };
}

/** 一个组织内的工作台数据：在该组织的 withOrg 事务里、以该组织的成员身份读取。 */
async function orgPart(db: Db, actor: Actor, org: WorkbenchOrg, today: string | undefined): Promise<OrgPart> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = [...(await visibleProductIds(tx, actor))];
    if (visible.length === 0) return { owned: [], tasks: [], signatures: [], unread: [] };
    const day = today ?? (await orgToday(tx, actor.orgId));
    const prods = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, visible));
    const keyOf = new Map(prods.map((p) => [p.id, p.key]));
    const keyFor = (r: { productId: string; number: number }) => displayKey(keyOf.get(r.productId)!, r.number);
    const info = await stateInfoByProduct(tx, visible);
    const isOpen = (r: { productId: string; stateKey: string }) => {
      const category = stateOf(info, r.productId, r.stateKey).category;
      return category !== 'completed' && category !== 'canceled';
    };

    // 我负责的需求（全部读出：未读评论也要用到已完成的需求）
    const ownedRows = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.ownerMemberId, actor.memberId), isNull(requirements.deletedAt), inArray(requirements.productId, visible)));
    const owned = ownedRows
      .filter(isOpen)
      .map((r) => ({ org, id: r.id, displayKey: keyFor(r), title: r.title, state: stateOf(info, r.productId, r.stateKey), updatedAt: r.updatedAt }));

    // 指派给我的未完成任务，排除已取消或已删除迭代里的
    const taskRows = await tx
      .select({ t: tasks, it: { id: iterations.id, name: iterations.name } })
      .from(tasks)
      .leftJoin(iterations, eq(iterations.id, tasks.iterationId))
      .where(
        and(
          eq(tasks.assigneeMemberId, actor.memberId),
          ne(tasks.status, 'done'),
          inArray(tasks.productId, visible),
          or(isNull(tasks.iterationId), and(isNull(iterations.deletedAt), ne(iterations.status, 'canceled'))),
        ),
      );
    const taskViews = await hydrateTasks(tx, actor, taskRows.map((r) => r.t), day);
    const myTasks = taskViews.map((v, i) => ({
      org,
      id: v.id,
      title: v.title,
      requirement: v.requirement ? { displayKey: v.requirement.displayKey, title: v.requirement.title } : null,
      iteration: taskRows[i]!.it,
      status: v.status,
      planStart: v.planStart,
      progress: v.progress,
    }));

    // 等我签字：只看有检查项记录（评审可能已开始）的未完成需求
    const candidates = await tx
      .select()
      .from(requirements)
      .where(
        and(
          inArray(requirements.productId, visible),
          isNull(requirements.deletedAt),
          sql`exists (select 1 from ${checkItemResults} where ${checkItemResults.targetType} = 'requirement' and ${checkItemResults.targetId} = ${requirements.id})`,
        ),
      );
    const signatures: WorkbenchSignature[] = [];
    for (const pid of new Set(candidates.map((r) => r.productId))) {
      const rows = candidates.filter((r) => r.productId === pid && isOpen(r));
      if (rows.length === 0) continue;
      const body = await productWorkflowBody(tx, pid);
      const items = body.checkItems.filter((c) => c.scope === 'requirement' && c.type === 'signoff');
      if (items.length === 0) continue;
      const role = (await productRoleOf(tx, actor, pid))!;
      const who = await signerIdentity(tx, actor, role);
      const snaps = await checkSnapshots(tx, body, rows.map((r) => r.id));
      const signerNames = await memberNames(tx, items.flatMap((c) => (c.signers ?? []).filter((s) => s.by === 'member').map((s) => s.ref)));
      for (const r of rows) {
        const snap = snaps.get(r.id)!;
        const started = reviewStarted(body.checkItems, snap.states);
        for (const c of items) {
          const signoffs = snap.signoffs.get(c.key) ?? [];
          const rules = waitingRules(c, {
            state: snap.states[c.key]!,
            signedRules: new Set(signoffs.map((s) => s.signerRuleIndex)),
            reviewStarted: started,
            who,
            canSignOnBehalf: role === 'admin',
            assignees: snap.assignees,
          });
          for (const w of rules) {
            signatures.push({
              org,
              requirementId: r.id,
              displayKey: keyFor(r),
              title: r.title,
              itemKey: c.key,
              itemLabel: c.label,
              ruleIndex: w.ruleIndex,
              onBehalfOf: w.onBehalf ? (signerNames.get(c.signers![w.ruleIndex]!.ref) ?? '已删除的成员') : null,
            });
          }
        }
      }
    }

    // 我负责的需求上别人发的、我还没读的评论
    const unreadRows = await tx
      .select({
        requirementId: comments.targetId,
        unread: sql<number>`count(*)::int`,
        lastAt: sql`max(${comments.createdAt})`.mapWith(comments.createdAt),
      })
      .from(comments)
      .innerJoin(requirements, eq(requirements.id, comments.targetId))
      .where(
        and(
          eq(comments.targetType, 'requirement'),
          eq(requirements.ownerMemberId, actor.memberId),
          isNull(requirements.deletedAt),
          inArray(requirements.productId, visible),
          or(isNull(comments.authorMemberId), ne(comments.authorMemberId, actor.memberId)),
          sql`not exists (select 1 from ${commentReads} where ${commentReads.commentId} = ${comments.id} and ${commentReads.memberId} = ${actor.memberId})`,
        ),
      )
      .groupBy(comments.targetId);
    const ownedById = new Map(ownedRows.map((r) => [r.id, r]));
    const unread = unreadRows.map((u) => {
      const r = ownedById.get(u.requirementId)!;
      return { org, requirementId: r.id, displayKey: keyFor(r), title: r.title, unread: u.unread, lastAt: u.lastAt };
    });

    return { owned, tasks: myTasks, signatures, unread };
  });
}

/**
 * 跨组织工作台。成员关系查找走 withSystem（listMyOrganizations，CLAUDE.md 允许的场景）；
 * 每个组织的数据各自在一个 withOrg 事务里、以该组织的成员身份读取，不在同一个 RLS 上下文里混读多个组织。
 */
export async function getWorkbench(db: Db, accountId: string, opts: { today?: string } = {}): Promise<Workbench> {
  const memberships = await listMyOrganizations(db, accountId);
  const orgs = memberships.map((m) => ({ id: m.id, slug: m.slug, name: m.name }));
  const parts: OrgPart[] = [];
  for (const [i, m] of memberships.entries()) {
    const actor: Actor = { accountId, memberId: m.memberId, orgId: m.id, orgRole: m.role, tokenId: null, tokenScope: null };
    parts.push(await orgPart(db, actor, orgs[i]!, opts.today));
  }
  return {
    orgs,
    owned: section(parts.flatMap((p) => p.owned), (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    tasks: section(parts.flatMap((p) => p.tasks), (a, b) => (a.planStart ?? '9999-12-31').localeCompare(b.planStart ?? '9999-12-31')),
    signatures: section(parts.flatMap((p) => p.signatures), (a, b) => a.displayKey.localeCompare(b.displayKey, 'zh-CN', { numeric: true })),
    unread: section(parts.flatMap((p) => p.unread), (a, b) => b.lastAt.getTime() - a.lastAt.getTime()),
  };
}
```

`packages/core/src/index.ts` 末尾追加：

```ts
export * from './workbench/workbench';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core test` 与 `pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/workbench packages/core/src/index.ts packages/core/test/workbench.test.ts
git commit -m "feat(core): 跨组织工作台：负责的需求、我的任务、等我签字与未读评论

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: HTTP 接口：任务、甘特、按需求与按人、评审队列、工作台

**Files:**
- Create: `apps/web/src/server/routes/tasks.ts`
- Create: `apps/web/src/server/routes/reviews.ts`
- Create: `apps/web/src/server/routes/workbench.ts`
- Modify: `apps/web/src/server/api.ts`（注册）
- Test: `apps/web/test/api/tasks.test.ts`、`apps/web/test/api/reviews-workbench.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `createTask`、`updateTask`、`deleteTask`、`TASK_STATUSES`；Task 1 的 `TASK_FLAGS`；Task 3 的 `getIterationGantt`、`listRequirementTasks`、`listMemberTasks`；Task 5 的 `listReviewQueue`、`REVIEW_FILTER_STATES`；Task 6 的 `getWorkbench`；`CHECK_STATES`、`AppError`（`@flower/core`）；`requireAccount`（`server/auth-middleware.ts`）
- Produces（HTTP，前缀 `/api/v1`）：

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /orgs/:org/iterations/:id/gantt` | — | `{ gantt: IterationGantt }` |
| `GET /orgs/:org/requirements/:id/tasks` | — | `{ tasks: TaskView[] }` |
| `GET /orgs/:org/members/:id/tasks` | 查询参数 `all=1`（包含已结束的迭代） | `MemberTasks`（`{ member, today, tasks }`） |
| `POST /orgs/:org/tasks` | `{ title, iterationId?, requirementId?, productId?, alias?, assigneeMemberId?, status?, planStart?, planDays?, delayDays?, phase?, flag?, starred?, note?, progress? }` | `201 { task: TaskView }` |
| `PATCH /orgs/:org/tasks/:id` | 上面除 `iterationId`、`requirementId`、`productId` 外的任意字段 | `{ task: TaskView }` |
| `DELETE /orgs/:org/tasks/:id` | — | `204` |
| `GET /orgs/:org/products/:id/reviews` | 查询参数 `state`（`REVIEW_FILTER_STATES`，默认 `open`）、`item` + `itemState`、`mine=1` | `{ queue: ReviewQueue }`；参数不合法 `400`「筛选条件无效」 |
| `GET /me/workbench` | 只接受会话 | `{ workbench: Workbench }`；API Token 返回 `401` |

- [ ] **Step 1: 写失败的测试**

`apps/web/test/api/tasks.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let memberId: string;
let readToken: string;
let iterationId: string;

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  memberId = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
  // 2026-01-05 周一至 01-16 周五，共 10 个工作日；运行测试时迭代已结束，理论进度为 100
  iterationId = (
    await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '迭代0105', startDate: '2026-01-05', endDate: '2026-01-16' } })
  ).body.iteration.id;
});
afterAll(() => cleanup());

describe('任务接口', () => {
  it('新建、修改、甘特与概览、按需求与按人查询、删除', async () => {
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '上传提速' } })).body.requirement;
    const created = await call(app, 'POST', '/orgs/acme/tasks', {
      session,
      body: { iterationId, requirementId: req.id, title: '前端开发', assigneeMemberId: memberId, planStart: '2026-01-05', planDays: 2 },
    });
    expect(created.status).toBe(201);
    const id = created.body.task.id as string;
    expect(created.body.task).toMatchObject({ requirement: { displayKey: 'PAN-1' }, planDays: 2, progress: 100 });

    const manual = await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '联调', flag: 'attention', progress: 20 } });
    expect(manual.body.task).toMatchObject({ requirement: null, flag: 'attention', progress: 20 });

    const patched = await call(app, 'PATCH', `/orgs/acme/tasks/${id}`, { session, body: { alias: '前端', note: '等设计稿', progress: 40 } });
    expect(patched.body.task).toMatchObject({ alias: '前端', note: '等设计稿', progressOverride: 40, progress: 40 });

    const gantt = (await call(app, 'GET', `/orgs/acme/iterations/${iterationId}/gantt`, { session })).body.gantt;
    expect(gantt.workdays).toHaveLength(10);
    expect(gantt.overview).toMatchObject({ rowCount: 2, deferred: 1, overall: 40, expected: 100, behind: 60 });
    expect(gantt.canAddTask).toBe(true);

    expect((await call(app, 'GET', `/orgs/acme/requirements/${req.id}/tasks`, { session })).body.tasks).toMatchObject([{ id }]);
    const person = await call(app, 'GET', `/orgs/acme/members/${memberId}/tasks`, { session });
    expect(person.body).toMatchObject({ member: { id: memberId }, tasks: [{ id, iteration: { id: iterationId, name: '迭代0105', status: 'planning' } }] });

    const manualId = manual.body.task.id as string;
    expect((await call(app, 'DELETE', `/orgs/acme/tasks/${manualId}`, { session })).status).toBe(204);
    expect((await call(app, 'PATCH', `/orgs/acme/tasks/${manualId}`, { session, body: { title: '已删除' } })).status).toBe(404);
  });

  it('参数错误返回 400 与中文原因；第 11 个重点返回 409', async () => {
    expect((await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '坏标记', flag: 'bogus' } })).status).toBe(400);
    const bad = await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '坏工期', planDays: 0.2 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'invalid', message: '工期以半天为单位，范围 0.5–365 天' });
    for (let i = 1; i <= 10; i++) {
      expect((await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: `重点${i}`, starred: true } })).status).toBe(201);
    }
    const over = await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '重点11', starred: true } });
    expect(over.status).toBe(409);
    expect(over.body.error.message).toBe('每个迭代最多 10 个重点任务');
  });

  it('只读 Token 可以读取甘特，不能新建、修改、删除任务', async () => {
    const id = (await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId, title: '只读测试' } })).body.task.id;
    expect((await call(app, 'GET', `/orgs/acme/iterations/${iterationId}/gantt`, { token: readToken })).status).toBe(200);
    expect((await call(app, 'POST', '/orgs/acme/tasks', { token: readToken, body: { iterationId, title: '越权' } })).status).toBe(403);
    expect((await call(app, 'PATCH', `/orgs/acme/tasks/${id}`, { token: readToken, body: { title: '越权' } })).status).toBe(403);
    expect((await call(app, 'DELETE', `/orgs/acme/tasks/${id}`, { token: readToken })).status).toBe(403);
  });
});
```

`apps/web/test/api/reviews-workbench.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let memberId: string;
let readToken: string;

const REVIEW_WORKFLOW = {
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
      { key: 'design', label: '设计签字', scope: 'requirement', type: 'signoff', signers: [{ by: 'product_role', ref: 'admin' }], signoffRule: 'all' },
    ],
  },
};

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  memberId = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
  const wf = await call(app, 'POST', '/orgs/acme/workflows', { session, body: REVIEW_WORKFLOW });
  await call(app, 'PUT', `/orgs/acme/products/${productId}/workflow`, { session, body: { versionId: wf.body.version.id } });
});
afterAll(() => cleanup());

describe('评审队列接口', () => {
  it('按流程检查项生成列；统计；按检查项与「等我签字」筛选；参数不合法返回 400', async () => {
    await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '未开始的需求' } });
    const started = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '评审中的需求' } })).body.requirement;
    await call(app, 'PUT', `/orgs/acme/requirements/${started.id}/checks/feasibility`, { session, body: { state: 'passed' } });

    const q = (await call(app, 'GET', `/orgs/acme/products/${productId}/reviews`, { session })).body.queue;
    expect(q.columns.map((c: { key: string }) => c.key)).toEqual(['feasibility', 'design']);
    expect(q.stats).toEqual({ not_started: 1, in_progress: 1, rejected: 0, passed: 0 });
    const mine = (await call(app, 'GET', `/orgs/acme/products/${productId}/reviews?mine=1`, { session })).body.queue;
    expect(mine.rows).toMatchObject([{ displayKey: 'PAN-2', waiting: [{ itemKey: 'design', ruleIndex: 0, onBehalf: false }] }]);
    const byItem = (await call(app, 'GET', `/orgs/acme/products/${productId}/reviews?item=feasibility&itemState=passed`, { session })).body.queue;
    expect(byItem.rows.map((r: { displayKey: string }) => r.displayKey)).toEqual(['PAN-2']);
    const bad = await call(app, 'GET', `/orgs/acme/products/${productId}/reviews?state=bogus`, { session });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('筛选条件无效');
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/reviews?mine=1`, { token: readToken })).body.queue.rows).toEqual([]);
  });
});

describe('工作台接口', () => {
  it('会话用户得到跨组织汇总；API Token 返回 401', async () => {
    await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '我负责的需求', ownerMemberId: memberId } });
    const res = await call(app, 'GET', '/me/workbench', { session });
    expect(res.status).toBe(200);
    expect(res.body.workbench.orgs.map((o: { slug: string }) => o.slug)).toEqual(['acme']);
    expect(res.body.workbench.owned.items.map((r: { title: string }) => r.title)).toContain('我负责的需求');
    expect((await call(app, 'GET', '/me/workbench', { token: readToken })).status).toBe(401);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run test/api/tasks.test.ts test/api/reviews-workbench.test.ts`
Expected: FAIL，接口返回 404「接口不存在」。

- [ ] **Step 3: 实现路由**

`apps/web/src/server/routes/tasks.ts`：

```ts
import {
  createTask,
  deleteTask,
  getIterationGantt,
  listMemberTasks,
  listRequirementTasks,
  TASK_FLAGS,
  TASK_STATUSES,
  updateTask,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

// 长度、半天单位、进度范围等由服务校验并给出中文原因，这里只校验类型
const taskPatch = z.object({
  title: z.string().optional(),
  alias: z.string().nullable().optional(),
  assigneeMemberId: z.string().nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  planStart: z.string().nullable().optional(),
  planDays: z.number().nullable().optional(),
  delayDays: z.number().nullable().optional(),
  phase: z.string().nullable().optional(),
  flag: z.enum(TASK_FLAGS).nullable().optional(),
  starred: z.boolean().optional(),
  note: z.string().nullable().optional(),
  progress: z.number().nullable().optional(),
});

export function registerTaskRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/iterations/:id/gantt', async (c) => c.json({ gantt: await getIterationGantt(deps.db, c.get('actor'), c.req.param('id')) }));

  app.get('/orgs/:org/requirements/:id/tasks', async (c) => c.json({ tasks: await listRequirementTasks(deps.db, c.get('actor'), c.req.param('id')) }));

  app.get('/orgs/:org/members/:id/tasks', async (c) =>
    c.json(await listMemberTasks(deps.db, c.get('actor'), c.req.param('id'), { includeFinished: c.req.query('all') === '1' })),
  );

  app.post('/orgs/:org/tasks', async (c) => {
    const body = await readJson(
      c,
      taskPatch.extend({
        title: z.string(),
        iterationId: z.string().nullable().optional(),
        requirementId: z.string().nullable().optional(),
        productId: z.string().nullable().optional(),
      }),
    );
    return c.json({ task: await createTask(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/tasks/:id', async (c) => {
    const body = await readJson(c, taskPatch);
    return c.json({ task: await updateTask(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.delete('/orgs/:org/tasks/:id', async (c) => {
    await deleteTask(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });
}
```

`apps/web/src/server/routes/reviews.ts`：

```ts
import { AppError, CHECK_STATES, listReviewQueue, REVIEW_FILTER_STATES } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';

const reviewQuery = z.object({
  state: z.enum(REVIEW_FILTER_STATES).optional(),
  item: z.string().optional(),
  itemState: z.enum(CHECK_STATES).optional(),
  mine: z.literal('1').optional(),
});

export function registerReviewRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/reviews', async (c) => {
    const q = reviewQuery.safeParse(c.req.query());
    if (!q.success) throw new AppError('invalid', '筛选条件无效');
    const queue = await listReviewQueue(deps.db, c.get('actor'), c.req.param('id'), {
      state: q.data.state,
      itemKey: q.data.item,
      itemState: q.data.itemState,
      waitingForMe: q.data.mine === '1',
    });
    return c.json({ queue });
  });
}
```

`apps/web/src/server/routes/workbench.ts`：

```ts
import { getWorkbench } from '@flower/core';
import type { ApiDeps, App } from '../api';
import { requireAccount } from '../auth-middleware';

export function registerWorkbenchRoutes(app: App, deps: ApiDeps): void {
  // 跨组织汇总只对登录会话开放；API Token 绑定单个组织，requireAccount 会返回 401
  app.get('/me/workbench', async (c) => c.json({ workbench: await getWorkbench(deps.db, requireAccount(c).id) }));
}
```

`apps/web/src/server/api.ts`：

1. import 区在 `import { registerStructureRoutes } from './routes/structure';` 之后加入：

```ts
import { registerReviewRoutes } from './routes/reviews';
import { registerTaskRoutes } from './routes/tasks';
import { registerWorkbenchRoutes } from './routes/workbench';
```

2. `registerStructureRoutes(app, deps);` 之后加入：

```ts
  registerTaskRoutes(app, deps);
  registerReviewRoutes(app, deps);
  registerWorkbenchRoutes(app, deps);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run test/api` 与 `pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/server/routes/tasks.ts apps/web/src/server/routes/reviews.ts apps/web/src/server/routes/workbench.ts apps/web/src/server/api.ts apps/web/test/api/tasks.test.ts apps/web/test/api/reviews-workbench.test.ts
git commit -m "feat(web): 任务、甘特、按人任务、评审队列与工作台接口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: 统一错误状态与 P0-B 暂缓的界面问题

逐条核实（2026-09-30，main 6fc518d）：

| 暂缓项 | 代码现状 | 处理 |
|---|---|---|
| 5xx 时页面空白、没有共享的错误状态 | `org-shell.tsx` 非 404 错误 `return null`；`requirements/[key]/page.tsx`、`roles-tab.tsx` 各自内联一份「重试」；`iterations/[id]/page.tsx` 手写 404/403 判断 | 新增 `QueryError`，这些地方统一改用 |
| 产品设置遇到 5xx 显示「无权访问」 | `settings/products/[productId]/page.tsx`：`if (product.isError) return <NoAccess …/>`；流程编辑页 `settings/workflows/[id]/page.tsx` 同样 | 改用 `QueryError` |
| AuthGate 在 `/me` 5xx 时一直转圈 | `auth-gate.tsx` 只处理 401 | 没有数据且不是 401 时显示重试 |
| 网络失败显示英文 "Failed to fetch" | `lib/api.ts` 没有捕获 `fetch` 的异常；`providers.tsx` 的重试条件把 `status < 500` 都当作不重试 | 包装为 `ApiError(0, 'network', …)`；只对 4xx 不重试 |
| `mutateAsync` 拒绝未处理 | `publish-dialog.tsx` 的 `await onPublish(note)`；`settings/tags/page.tsx` 的 `reorder` | 捕获后停止（错误已由 FormError / 提示显示） |
| `/admin` 对非管理员显示两个 h1 | `admin/page.tsx` 在 `NoAccess` 之外还渲染「实例设置」h1 | 非管理员只渲染 `NoAccess` |
| 概览页产品网格加载时闪空 | 存在 | 放在 Task 12 移动概览页时一起处理 |
| 非管理员的产品卡片链接回本页 | B1 已改为链接到需求列表 | 不处理 |

**Files:**
- Modify: `apps/web/src/lib/api.ts`、`apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/app/providers.tsx`
- Modify: `apps/web/src/components/load-error.tsx`（`QueryError`）
- Modify: `apps/web/src/components/auth-gate.tsx`、`apps/web/src/components/org-shell.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`、`roles-tab.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/workflows/[id]/page.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`
- Modify: `apps/web/src/app/(app)/admin/page.tsx`
- Modify: `apps/web/src/features/workflow/components/publish-dialog.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/tags/page.tsx`
- Modify: `apps/web/e2e/helpers.ts`（`FAIL_500`）
- Test: `apps/web/e2e/error-states.spec.ts`

**Interfaces:**
- Produces（e2e `helpers.ts`）：`FAIL_500`（模拟 5xx 的 `route.fulfill` 参数）
- Produces（`lib/api.ts`）：`NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试'`；网络异常抛出 `ApiError(0, 'network', NETWORK_ERROR_MESSAGE, null)`；`isAccessDenied(error: unknown): boolean`（`ApiError` 且状态 403 / 404）
- Produces（`components/load-error.tsx`）：`QueryError({ error, noAccessMessage, retryMessage, onRetry }: { error: unknown; noAccessMessage: string; retryMessage: string; onRetry: () => void })`（Task 9–12 的新页面都用它）
- 保持不变的文案（现有 e2e 依赖）：「加载需求失败，请重试。」「加载迭代失败，请重试。」

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/lib/api.test.ts` 的 import 改为 `import { ApiError, api, isAccessDenied, unmetFrom } from './api';`，`describe('api', …)` 里最后一个 `it` 之后加入：

```ts
  it('网络不通时抛出中文提示的 ApiError（status 0）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(api('/x')).rejects.toMatchObject({ status: 0, code: 'network', message: '网络连接失败，请检查网络后重试' });
  });
```

文件末尾追加：

```ts
describe('isAccessDenied', () => {
  it('403 与 404 视为无权访问，其他错误可以重试', () => {
    expect(isAccessDenied(new ApiError(403, 'forbidden', '权限不足', null))).toBe(true);
    expect(isAccessDenied(new ApiError(404, 'not_found', '不存在', null))).toBe(true);
    expect(isAccessDenied(new ApiError(500, 'internal', '服务器内部错误', null))).toBe(false);
    expect(isAccessDenied(new ApiError(0, 'network', '网络连接失败，请检查网络后重试', null))).toBe(false);
    expect(isAccessDenied(new Error('x'))).toBe(false);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/lib/api.test.ts`
Expected: FAIL，`isAccessDenied` 未导出；网络用例拿到的是 `TypeError`。

- [ ] **Step 2: 实现 `api.ts`、重试策略与 `QueryError`**

`apps/web/src/lib/api.ts` 中 `api` 函数替换为下面的版本，并在其后加入 `isAccessDenied`（`ApiError` 类与 `unmetFrom` 不变）：

```ts
/** 请求没有到达服务器（断网、DNS 失败、连接被重置等）时的提示。 */
export const NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试';

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', NETWORK_ERROR_MESSAGE, null);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? '服务暂时不可用，请稍后重试', e?.details ?? null);
  }
  return data as T;
}

/** 403 / 404：页面显示「无权访问」；其他错误（5xx、网络失败）显示「重试」。 */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}
```

`apps/web/src/app/providers.tsx` 中：

```ts
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
```

改为（网络失败的 status 为 0，应当和 5xx 一样重试）：

```ts
            retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
```

`apps/web/src/components/load-error.tsx` 整个替换为：

```tsx
import { NoAccess } from '@/components/no-access';
import { Button } from '@/components/ui/button';
import { isAccessDenied } from '@/lib/api';

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <p className="text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/** 查询失败时的统一显示：403 / 404 显示「无权访问」，其他错误（5xx、网络失败）显示「重试」。 */
export function QueryError({ error, noAccessMessage, retryMessage, onRetry }: { error: unknown; noAccessMessage: string; retryMessage: string; onRetry: () => void }) {
  if (isAccessDenied(error)) return <NoAccess message={noAccessMessage} />;
  return <LoadError message={retryMessage} onRetry={onRetry} />;
}
```

Run: `pnpm --filter @flower/web exec vitest run src/lib/api.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/helpers.ts` 末尾追加（本计划新的 spec 模拟 5xx 时共用）：

```ts
/** 模拟服务端 5xx 的响应，配合 page.route(...).fulfill 使用。 */
export const FAIL_500 = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '服务器错误' } }) };
```

`apps/web/e2e/error-states.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, FAIL_500, json, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('账号信息加载失败（5xx）时显示重试，恢复后进入页面', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.route('**/api/v1/me', (route) => route.fulfill(FAIL_500));
  await page.goto('/acme/requirements');
  await expect(page.getByText('加载账号信息失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/v1/me');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('heading', { name: '需求' })).toBeVisible();
});

test('产品设置加载失败（5xx）显示重试，不显示无权访问', async ({ page, request }) => {
  const productId = await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.route(`**/api/v1/orgs/acme/products/${productId}`, (route) => route.fulfill(FAIL_500));
  await page.goto(`/acme/settings/products/${productId}`);
  await expect(page.getByText('加载产品失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: '无权访问' })).toHaveCount(0);
  await page.unroute(`**/api/v1/orgs/acme/products/${productId}`);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('heading', { name: '网盘' })).toBeVisible();
});

test('网络断开时，保存操作提示「网络连接失败」', async ({ page, request }) => {
  const productId = await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/settings/products/${productId}`);
  await expect(page.getByRole('heading', { name: '网盘' })).toBeVisible();
  await page.route(`**/api/v1/orgs/acme/products/${productId}`, (route) =>
    route.request().method() === 'PATCH' ? route.abort('internetdisconnected') : route.continue(),
  );
  await page.getByLabel('产品名称').fill('网盘二期');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('网络连接失败，请检查网络后重试')).toBeVisible();
});

test('非实例管理员打开 /admin：显示无权访问，页面只有一个一级标题', async ({ browser, request }) => {
  const { token } = await json<{ token: string }>(request.post('/api/v1/orgs/acme/invitations', { data: { email: 'member@example.com', orgRole: 'member' } }));
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/invite/${token}`);
  await page.getByLabel('你的姓名').fill('成员甲');
  await page.getByLabel('设置密码').fill('password123');
  await page.getByRole('button', { name: '接受邀请' }).click();
  await page.waitForURL('**/acme');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await ctx.close();
});
```

Run: `pnpm --filter @flower/web e2e error-states.spec.ts`
Expected: FAIL：第一个用例一直是骨架屏；第二个显示「无权访问」；第三个提示「Failed to fetch」；第四个有两个一级标题。

- [ ] **Step 4: 各页面改用统一错误状态**

`apps/web/src/components/auth-gate.tsx`：

1. import 区加入：

```ts
import { LoadError } from '@/components/load-error';
```

2. 把

```tsx
  if (!me.data) {
    return (
      <div className="flex h-screen items-center justify-center" aria-busy="true">
        <Skeleton className="h-6 w-40" />
      </div>
    );
  }
```

替换为：

```tsx
  if (!me.data) {
    if (me.isError && !unauthenticated) return <LoadError message="加载账号信息失败，请重试。" onRetry={() => me.refetch()} />;
    return (
      <div className="flex h-screen items-center justify-center" aria-busy="true">
        <Skeleton className="h-6 w-40" />
      </div>
    );
  }
```

`apps/web/src/components/org-shell.tsx`：

1. 删除 `import { ApiError } from '@/lib/api';` 与 `import { NoAccess } from './no-access';`，加入：

```ts
import { QueryError } from './load-error';
```

2. 把

```tsx
  if (q.error instanceof ApiError && q.error.status === 404) {
    return <NoAccess message="组织不存在，或者你还不是这个组织的成员。" />;
  }
  if (!q.data) return null;
```

替换为：

```tsx
  if (!q.data) {
    if (!q.isError) return null;
    return <QueryError error={q.error} noAccessMessage="组织不存在，或者你还不是这个组织的成员。" retryMessage="加载组织失败，请重试。" onRetry={() => q.refetch()} />;
  }
```

`apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`：

1. import 区加入 `import { QueryError } from '@/components/load-error';`（`NoAccess` 仍用于非产品管理员）。
2. 把

```tsx
  if (product.isError) return <NoAccess message="产品不存在，或者你没有访问权限。" />;
```

替换为：

```tsx
  if (!product.data && product.isError) {
    return <QueryError error={product.error} noAccessMessage="产品不存在，或者你没有访问权限。" retryMessage="加载产品失败，请重试。" onRetry={() => product.refetch()} />;
  }
```

`apps/web/src/app/(app)/[org]/settings/products/[productId]/roles-tab.tsx`：

1. 删除 `import { Button } from '@/components/ui/button';`，加入 `import { LoadError } from '@/components/load-error';`。
2. 把

```tsx
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
```

替换为：

```tsx
  if (q.isError) return <LoadError message="加载成员失败，请重试。" onRetry={() => q.refetch()} />;
```

`apps/web/src/app/(app)/[org]/settings/workflows/[id]/page.tsx`：

1. `import { NoAccess } from '@/components/no-access';` 改为 `import { QueryError } from '@/components/load-error';`。
2. 把

```tsx
  if (wf.isError) return <NoAccess message="流程不存在，或者你没有编辑权限。" />;
```

替换为：

```tsx
  if (!wf.data && wf.isError) {
    return <QueryError error={wf.error} noAccessMessage="流程不存在，或者你没有编辑权限。" retryMessage="加载流程失败，请重试。" onRetry={() => wf.refetch()} />;
  }
```

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：

1. 删除 `import { NoAccess } from '@/components/no-access';`，加入 `import { QueryError } from '@/components/load-error';`；`import { ApiError, api } from '@/lib/api';` 改为 `import { api } from '@/lib/api';`。
2. 把

```tsx
  if (q.error instanceof ApiError && q.error.status === 404) return <NoAccess message="需求不存在，或你没有查看它所在产品的权限。" />;
  if (q.isError)
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-muted-foreground">加载需求失败，请重试。</p>
        <Button variant="outline" onClick={() => q.refetch()}>
          重试
        </Button>
      </div>
    );
```

替换为：

```tsx
  if (!r && q.isError) {
    return <QueryError error={q.error} noAccessMessage="需求不存在，或你没有查看它所在产品的权限。" retryMessage="加载需求失败，请重试。" onRetry={() => q.refetch()} />;
  }
```

`apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`：

1. 删除 `import { LoadError } from '@/components/load-error';` 与 `import { NoAccess } from '@/components/no-access';`，加入 `import { QueryError } from '@/components/load-error';`；`import { ApiError, api } from '@/lib/api';` 改为 `import { api } from '@/lib/api';`。
2. 把

```tsx
  if (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403)) return <NoAccess message="迭代不存在，或你没有查看它的权限。" />;
  if (q.isError) return <LoadError message="加载迭代失败，请重试。" onRetry={() => q.refetch()} />;
```

替换为：

```tsx
  if (!q.data && q.isError) {
    return <QueryError error={q.error} noAccessMessage="迭代不存在，或你没有查看它的权限。" retryMessage="加载迭代失败，请重试。" onRetry={() => q.refetch()} />;
  }
```

`apps/web/src/app/(app)/admin/page.tsx` 的 `AdminPage` 替换为：

```tsx
export default function AdminPage() {
  const me = useMe();
  if (!me.data) return null;
  return (
    <PlainShell>
      {me.data.account.isInstanceAdmin ? (
        <>
          <h1 className="text-xl font-semibold">实例设置</h1>
          <Settings />
        </>
      ) : (
        <NoAccess message="只有实例管理员可以修改实例设置。" />
      )}
    </PlainShell>
  );
}
```

`apps/web/src/features/workflow/components/publish-dialog.tsx` 中确认按钮的 `onClick` 替换为：

```tsx
            onClick={async () => {
              try {
                await onPublish(note);
              } catch {
                // 失败原因由上面的 FormError（error 属性）显示，对话框保持打开
                return;
              }
              setOpen(false);
              setNote('');
            }}
```

`apps/web/src/app/(app)/[org]/settings/tags/page.tsx` 的 `reorder` 替换为：

```ts
  async function reorder(next: FunctionTag[]) {
    // 逐个保存排序；某个请求失败时 useApiMutation 已提示原因，停止后续请求
    try {
      for (const [i, t] of next.entries()) {
        if (t.sort !== i) await update.mutateAsync({ id: t.id, sort: i });
      }
    } catch {
      return;
    }
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run（端到端在后台运行并写日志）：

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web test
pnpm --filter @flower/web e2e error-states.spec.ts requirements.spec.ts iterations.spec.ts product-admin.spec.ts workflows.spec.ts tags.spec.ts
```

Expected: 全部 PASS（现有 spec 依赖的「加载需求失败，请重试。」「加载迭代失败，请重试。」文案不变）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/app/providers.tsx apps/web/src/components/load-error.tsx apps/web/src/components/auth-gate.tsx apps/web/src/components/org-shell.tsx "apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx" "apps/web/src/app/(app)/[org]/settings/products/[productId]/roles-tab.tsx" "apps/web/src/app/(app)/[org]/settings/workflows/[id]/page.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx" "apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx" "apps/web/src/app/(app)/admin/page.tsx" apps/web/src/features/workflow/components/publish-dialog.tsx "apps/web/src/app/(app)/[org]/settings/tags/page.tsx" apps/web/e2e/helpers.ts apps/web/e2e/error-states.spec.ts
git commit -m "fix(web): 统一加载失败状态，网络错误提示中文，AuthGate 与产品设置在 5xx 时可重试

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: 迭代详情「甘特」页签：进度概览、任务表行内编辑（失焦保存）、重点、新增与删除任务

**Files:**
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`、`apps/web/src/lib/labels.ts`
- Create: `apps/web/src/features/gantt/model.ts`、`apps/web/src/features/gantt/model.test.ts`
- Create: `apps/web/src/app/(app)/[org]/iterations/[id]/gantt-tab.tsx`
- Create: `apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx`
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`（「甘特」页签，`?tab=gantt` 直接打开）
- Modify: `apps/web/e2e/helpers.ts`（`createIteration`、`createTask`）
- Test: `apps/web/e2e/gantt.spec.ts`

**Interfaces:**
- Consumes: Task 7 的 `GET /orgs/:org/iterations/:id/gantt`、`POST /orgs/:org/tasks`、`PATCH /orgs/:org/tasks/:id`、`DELETE /orgs/:org/tasks/:id`；Task 1 的 `STARRED_LIMIT`（`@flower/core/schedule`）；Task 8 的 `QueryError`；`canListMembers`、`activePeople`；`useMembers`、`useOrg`、`useProducts`、`iterationKeys`、`requirementKeys`
- Produces（`lib/types.ts`）：`Task = Jsonify<TaskView>`、`IterationGantt = Jsonify<CoreIterationGantt>`
- Produces（`lib/queries.ts`）：`qk.gantt(o, id)`（前缀在 `iterationKeys` 下）、`qk.workbench = ['me', 'workbench']`、`taskKeys(o) = ['org', o, 'tasks']`、`taskMutationKeys(o)`（任务修改后要失效的键：迭代、需求、按人任务、工作台）、`useIterationGantt(o, id)`
- Produces（`lib/labels.ts`）：`TASK_FLAG_LABEL = { attention: '关注' }`
- Produces（`features/gantt/model.ts`）：`type ParsedNumber = { ok: true; value: number | null } | { ok: false; message: string }`；`parseHalfDays(text: string, min: number, label: '工期' | '延期'): ParsedNumber`；`parseProgress(text: string): ParsedNumber`（提示文字与服务端一致）
- Produces（e2e `helpers.ts`）：`createIteration(request, productId, name, startDate, endDate): Promise<string>`；`createTask(request, data: Record<string, unknown>): Promise<string>`
- Produces（组件）：`GanttTab({ org, iterationId })`；`TaskRow({ org, task, people })`（每个输入框的 `aria-label` 为「字段名 任务标题」，例如「别名 前端开发」「工期 联调」；进度条 `role="progressbar"`，名称为「任务标题 进度」）

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/gantt/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseHalfDays, parseProgress } from './model';

describe('甘特输入解析', () => {
  it('工期、延期以半天为单位；空表示未填；提示文字与服务端一致', () => {
    expect(parseHalfDays('', 0.5, '工期')).toEqual({ ok: true, value: null });
    expect(parseHalfDays(' 1.5 ', 0.5, '工期')).toEqual({ ok: true, value: 1.5 });
    expect(parseHalfDays('0.3', 0.5, '工期')).toEqual({ ok: false, message: '工期以半天为单位，范围 0.5–365 天' });
    expect(parseHalfDays('0', 0.5, '工期')).toEqual({ ok: false, message: '工期以半天为单位，范围 0.5–365 天' });
    expect(parseHalfDays('0', 0, '延期')).toEqual({ ok: true, value: 0 });
    expect(parseHalfDays('abc', 0, '延期')).toEqual({ ok: false, message: '延期以半天为单位，范围 0–365 天' });
  });

  it('手动进度：空表示按工期推算，否则为 0–100 的整数', () => {
    expect(parseProgress('')).toEqual({ ok: true, value: null });
    expect(parseProgress('60')).toEqual({ ok: true, value: 60 });
    expect(parseProgress('60.5')).toEqual({ ok: false, message: '进度应为 0–100 的整数' });
    expect(parseProgress('101')).toEqual({ ok: false, message: '进度应为 0–100 的整数' });
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/gantt/model.test.ts`
Expected: FAIL，找不到模块 `./model`。

- [ ] **Step 2: 实现模型、类型、查询与文案**

`apps/web/src/features/gantt/model.ts`：

```ts
export type ParsedNumber = { ok: true; value: number | null } | { ok: false; message: string };

/** 工期、延期输入：空 = 未填；以半天为单位，范围 min–365。提示文字与服务端校验一致。 */
export function parseHalfDays(text: string, min: number, label: '工期' | '延期'): ParsedNumber {
  const s = text.trim();
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > 365 || !Number.isInteger(n * 2)) return { ok: false, message: `${label}以半天为单位，范围 ${min}–365 天` };
  return { ok: true, value: n };
}

/** 手动进度输入：空 = 按工期推算；否则为 0–100 的整数。 */
export function parseProgress(text: string): ParsedNumber {
  const s = text.trim();
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 100) return { ok: false, message: '进度应为 0–100 的整数' };
  return { ok: true, value: n };
}
```

`apps/web/src/lib/types.ts`：

1. `@flower/core` 的 type import 列表加入（按字母顺序）：

```ts
  IterationGantt as CoreIterationGantt,
```

```ts
  TaskView,
```

2. 文件末尾追加：

```ts
export type Task = Jsonify<TaskView>;
export type IterationGantt = Jsonify<CoreIterationGantt>;
```

`apps/web/src/lib/queries.ts`：

1. types import 列表加入 `IterationGantt`。
2. `qk` 对象中 `iterationScope` 一行之后加入：

```ts
  gantt: (o: string, id: string) => ['org', o, 'iterations', 'gantt', id] as const,
  workbench: ['me', 'workbench'] as const,
```

3. `useIterationScope` 之后加入：

```ts
/** 按人查看任务的公共前缀。 */
export const taskKeys = (o: string) => ['org', o, 'tasks'] as const;

/** 任务修改后要刷新的查询：迭代（含甘特）、需求（详情里的任务）、按人任务、工作台。 */
export const taskMutationKeys = (o: string) => [iterationKeys(o), requirementKeys(o), taskKeys(o), qk.workbench];

export const useIterationGantt = (o: string, id: string) =>
  useQuery({ queryKey: qk.gantt(o, id), queryFn: () => api<{ gantt: IterationGantt }>(`/orgs/${o}/iterations/${id}/gantt`), select: (d) => d.gantt });
```

`apps/web/src/lib/labels.ts` 中 `TASK_STATUS_LABEL` 一行之后加入：

```ts
export const TASK_FLAG_LABEL = { attention: '关注' } as const;
```

Run: `pnpm --filter @flower/web exec vitest run src/features/gantt/model.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/helpers.ts` 末尾追加：

```ts
export async function createIteration(request: APIRequestContext, productId: string, name: string, startDate: string, endDate: string): Promise<string> {
  return (await json<{ iteration: { id: string } }>(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name, startDate, endDate } })))
    .iteration.id;
}

export async function createTask(request: APIRequestContext, data: Record<string, unknown>): Promise<string> {
  return (await json<{ task: { id: string } }>(request.post('/api/v1/orgs/acme/tasks', { data }))).task.id;
}
```

`apps/web/e2e/gantt.spec.ts`：

```ts
import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createIteration, createProduct, createRequirement, createTask, FAIL_500, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const taskSaved = (page: Page) => page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/v1/orgs/acme/tasks/'));

test('甘特页签：失焦保存别名与进度，标记关注后计入遗留，非法工期提示并还原', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  // 迭代在测试运行时已结束，理论进度为 100%；进度用手动值，结果不依赖运行日期
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId, requirementId: req.id, title: '前端开发', planStart: '2026-01-05', planDays: 2 });
  await createTask(request, { iterationId, title: '联调', progress: 20 });

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
  const overview = page.getByRole('region', { name: '进度概览' });
  await expect(overview.getByRole('group', { name: '理论进度' })).toContainText('100%');
  await expect(overview.getByRole('group', { name: '遗留' })).toContainText('0 项');

  const alias = page.getByLabel('别名 前端开发');
  await alias.fill('前端');
  const aliasSaved = taskSaved(page);
  await alias.blur();
  expect((await aliasSaved).ok()).toBeTruthy();

  const progress = page.getByLabel('进度 联调', { exact: true });
  await progress.fill('60');
  const progressSaved = taskSaved(page);
  await progress.blur();
  expect((await progressSaved).ok()).toBeTruthy();
  await expect(page.getByRole('progressbar', { name: '联调 进度' })).toHaveAttribute('aria-valuenow', '60');

  await page.getByRole('combobox', { name: '标记 联调' }).click();
  await page.getByRole('option', { name: '关注' }).click();
  await expect(overview.getByRole('group', { name: '遗留' })).toContainText('1 项');
  await expect(page.getByRole('list', { name: '关注与周知' })).toContainText('联调');

  const days = page.getByLabel('工期 联调');
  await days.fill('0.3');
  await days.blur();
  await expect(page.getByText('工期以半天为单位，范围 0.5–365 天')).toBeVisible();
  await expect(page.getByLabel('工期 联调')).toHaveValue('');

  await page.reload();
  await expect(page.getByLabel('别名 前端开发')).toHaveValue('前端');
  await expect(page.getByLabel('进度 联调', { exact: true })).toHaveValue('60');
});

test('甘特页签：每个迭代最多 10 个重点任务；新增与删除不挂需求的任务', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  for (let i = 1; i <= 10; i++) await createTask(request, { iterationId, title: `重点${i}`, starred: true });
  await createTask(request, { iterationId, title: '联调' });

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
  await expect(page.getByText('重点 10/10')).toBeVisible();
  await page.getByRole('button', { name: '标为重点 联调' }).click();
  await expect(page.getByText('每个迭代最多 10 个重点任务')).toBeVisible();
  await page.getByRole('button', { name: '取消重点 重点1', exact: true }).click();
  await expect(page.getByText('重点 9/10')).toBeVisible();
  await page.getByRole('button', { name: '标为重点 联调' }).click();
  await expect(page.getByRole('button', { name: '取消重点 联调' })).toBeVisible();

  await page.getByRole('button', { name: '＋ 任务' }).click();
  await page.getByLabel('新任务名称').fill('埋点');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('已添加任务')).toBeVisible();
  await expect(page.getByLabel('别名 埋点')).toBeVisible();
  await page.getByRole('button', { name: '删除 埋点' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('已删除任务')).toBeVisible();
  await expect(page.getByLabel('别名 联调')).toBeVisible();
  await expect(page.getByLabel('别名 埋点')).toHaveCount(0);
});

test('甘特页签：加载失败（5xx）显示重试', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await login(page, OWNER.email, OWNER.password);
  await page.route(`**/api/v1/orgs/acme/iterations/${iterationId}/gantt`, (route) => route.fulfill(FAIL_500));
  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
  await expect(page.getByText('加载甘特失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute(`**/api/v1/orgs/acme/iterations/${iterationId}/gantt`);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('还没有任务')).toBeVisible();
});
```

Run: `pnpm --filter @flower/web e2e gantt.spec.ts`
Expected: FAIL，页面没有「甘特」页签。

- [ ] **Step 4: 实现任务行**

`apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx`：

```tsx
'use client';

import { Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/confirm-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TableCell, TableRow } from '@/components/ui/table';
import { type ParsedNumber, parseHalfDays, parseProgress } from '@/features/gantt/model';
import { api } from '@/lib/api';
import { TASK_FLAG_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';
import { taskMutationKeys, useApiMutation } from '@/lib/queries';
import type { Member, Task } from '@/lib/types';
import { cn } from '@/lib/utils';

type Patch = {
  alias?: string | null;
  assigneeMemberId?: string | null;
  status?: Task['status'];
  planStart?: string | null;
  planDays?: number | null;
  delayDays?: number | null;
  flag?: Task['flag'];
  starred?: boolean;
  note?: string | null;
  progress?: number | null;
};
const NONE = 'none';

/** 甘特表的一行：文本和数字输入失焦时保存（与 push 一致），下拉框选中后立即保存。 */
export function TaskRow({ org, task: t, people }: { org: string; task: Task; people: Member[] | null }) {
  // 输入框以服务端的值为 key：保存成功后 updatedAt 变化会重新挂载；保存失败或输入不合法时加一，恢复服务端的值
  const [nonce, setNonce] = useState(0);
  const reset = () => setNonce((n) => n + 1);
  const invalidate = taskMutationKeys(org);
  const patch = useApiMutation((body: Patch) => api(`/orgs/${org}/tasks/${t.id}`, { method: 'PATCH', body }), { invalidate });
  const remove = useApiMutation(() => api(`/orgs/${org}/tasks/${t.id}`, { method: 'DELETE' }), { invalidate, success: '已删除任务' });
  const save = (body: Patch) => patch.mutate(body, { onError: reset });
  const saveNumber = (parsed: ParsedNumber, current: number | null, toPatch: (v: number | null) => Patch) => {
    if (!parsed.ok) {
      toast.error(parsed.message);
      reset();
      return;
    }
    if (parsed.value !== current) save(toPatch(parsed.value));
  };
  const k = `${t.updatedAt}-${nonce}`;
  const label = t.title;
  const disabled = !t.canEdit;
  // 负责人下拉：在职真人成员；当前负责人已离开时也保留在选项里
  const options = people
    ? [
        ...people.map((p) => ({ id: p.id, displayName: p.displayName })),
        ...(t.assignee && !people.some((p) => p.id === t.assignee!.id) ? [t.assignee] : []),
      ]
    : null;

  return (
    <TableRow className="even:bg-zebra">
      <TableCell>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t.starred ? `取消重点 ${label}` : `标为重点 ${label}`}
          aria-pressed={t.starred}
          disabled={disabled || patch.isPending}
          onClick={() => save({ starred: !t.starred })}
        >
          <Star className={cn('size-4', t.starred ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground')} aria-hidden="true" />
        </Button>
      </TableCell>
      <TableCell>
        <Input
          key={`alias-${k}`}
          aria-label={`别名 ${label}`}
          defaultValue={t.alias ?? ''}
          placeholder={t.title}
          maxLength={50}
          disabled={disabled}
          className="h-8 border-transparent bg-transparent px-1 font-medium shadow-none"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (t.alias ?? '')) save({ alias: v || null });
          }}
        />
        <div className="flex min-w-0 items-center gap-1.5 px-1 text-[12px] text-muted-foreground">
          {t.requirement ? (
            <Link href={`/${org}/requirements/${t.requirement.displayKey}`} className="flex min-w-0 gap-1.5 hover:underline">
              <span className="font-mono">{t.requirement.displayKey}</span>
              <span className="truncate">{t.requirement.title}</span>
            </Link>
          ) : (
            <span>未挂需求</span>
          )}
          <span className="truncate">· {t.title}</span>
        </div>
      </TableCell>
      <TableCell>
        {options ? (
          <Select value={t.assignee?.id ?? NONE} disabled={disabled} onValueChange={(v) => save({ assigneeMemberId: v === NONE ? null : v })}>
            <SelectTrigger className="h-8 w-full" aria-label={`负责人 ${label}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>未指派</SelectItem>
              {options.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-[13px]">{t.assignee?.displayName ?? '未指派'}</span>
        )}
      </TableCell>
      <TableCell>
        <Select value={t.status} disabled={disabled} onValueChange={(v) => save({ status: v as Task['status'] })}>
          <SelectTrigger className="h-8 w-full" aria-label={`状态 ${label}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TASK_STATUS_LABEL) as Array<Task['status']>).map((s) => (
              <SelectItem key={s} value={s}>
                {TASK_STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <div className="flex gap-1.5">
          <Input
            key={`start-${k}`}
            type="date"
            aria-label={`开始日期 ${label}`}
            defaultValue={t.planStart ?? ''}
            disabled={disabled}
            className="h-8 w-36 font-mono text-[12px]"
            onBlur={(e) => {
              const v = e.target.value || null;
              if (v !== t.planStart) save({ planStart: v });
            }}
          />
          <Input
            key={`days-${k}`}
            type="number"
            min={0.5}
            step={0.5}
            aria-label={`工期 ${label}`}
            defaultValue={t.planDays ?? ''}
            disabled={disabled}
            className="h-8 w-16 font-mono"
            onBlur={(e) => saveNumber(parseHalfDays(e.target.value, 0.5, '工期'), t.planDays, (v) => ({ planDays: v }))}
          />
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Input
            key={`progress-${k}`}
            type="number"
            min={0}
            max={100}
            step={1}
            aria-label={`进度 ${label}`}
            defaultValue={t.progressOverride ?? ''}
            placeholder="自动"
            disabled={disabled}
            className="h-8 w-16 font-mono"
            onBlur={(e) => saveNumber(parseProgress(e.target.value), t.progressOverride, (v) => ({ progress: v }))}
          />
          <div
            role="progressbar"
            aria-label={`${label} 进度`}
            aria-valuenow={t.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 flex-1 rounded-full bg-muted"
          >
            <div className={cn('h-full rounded-full', t.progress >= 100 ? 'bg-emerald-600' : 'bg-primary')} style={{ width: `${t.progress}%` }} />
          </div>
          <span className="w-9 text-right font-mono text-[12px]">{t.progress}%</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex gap-1.5">
          <Select value={t.flag ?? NONE} disabled={disabled} onValueChange={(v) => save({ flag: v === NONE ? null : 'attention' })}>
            <SelectTrigger className="h-8 w-20" aria-label={`标记 ${label}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>正常</SelectItem>
              <SelectItem value="attention">{TASK_FLAG_LABEL.attention}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            key={`delay-${k}`}
            type="number"
            min={0}
            step={0.5}
            aria-label={`延期 ${label}`}
            defaultValue={t.delayDays ?? ''}
            placeholder="0"
            disabled={disabled}
            className="h-8 w-16 font-mono"
            onBlur={(e) => saveNumber(parseHalfDays(e.target.value, 0, '延期'), t.delayDays, (v) => ({ delayDays: v }))}
          />
        </div>
      </TableCell>
      <TableCell>
        <Input
          key={`note-${k}`}
          aria-label={`说明 ${label}`}
          defaultValue={t.note ?? ''}
          placeholder="卡点、周知事项"
          maxLength={200}
          disabled={disabled}
          className="h-8"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (t.note ?? '')) save({ note: v || null });
          }}
        />
      </TableCell>
      <TableCell>
        {t.canEdit && (
          <ConfirmAction
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={`删除 ${label}`}>
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            }
            title={`删除「${label}」？`}
            description="删除后不能恢复。"
            confirmLabel="删除"
            destructive
            onConfirm={() => remove.mutate(undefined)}
          />
        )}
      </TableCell>
    </TableRow>
  );
}
```

- [ ] **Step 5: 实现甘特页签**

`apps/web/src/app/(app)/[org]/iterations/[id]/gantt-tab.tsx`：

```tsx
'use client';

import { STARRED_LIMIT } from '@flower/core/schedule';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { activePeople, canListMembers } from '@/features/members/model';
import { api } from '@/lib/api';
import { taskMutationKeys, useApiMutation, useIterationGantt, useMembers, useOrg, useProducts } from '@/lib/queries';
import type { IterationGantt } from '@/lib/types';
import { TaskRow } from './task-row';

function OverviewStrip({ overview }: { overview: IterationGantt['overview'] }) {
  const tiles = [
    { label: '整体进度', value: `${overview.overall}%` },
    { label: '理论进度', value: `${overview.expected}%` },
    { label: '落后', value: `${overview.behind}%` },
    { label: '遗留', value: `${overview.deferred} 项` },
  ];
  return (
    <section aria-label="进度概览" className="flex flex-col gap-2">
      <div className="grid grid-cols-4 gap-3">
        {tiles.map((t) => (
          <div key={t.label} role="group" aria-label={t.label} className="rounded-md border bg-card px-4 py-3">
            <div className="text-[12px] text-muted-foreground">{t.label}</div>
            <div className="font-mono text-lg font-semibold">{t.value}</div>
          </div>
        ))}
      </div>
      {overview.attention.length > 0 && (
        <ul aria-label="关注与周知" className="flex flex-col gap-1 rounded-md border bg-card px-4 py-2 text-[13px]">
          {overview.attention.map((a) => (
            <li key={`${a.kind}-${a.title}`} className="flex flex-wrap items-center gap-2">
              <span className={a.kind === 'attention' ? 'font-medium text-destructive' : 'font-medium text-primary'}>{a.kind === 'attention' ? '关注' : '周知'}</span>
              <span>{a.title}</span>
              {a.assignees.length > 0 && <span className="text-muted-foreground">{a.assignees.join('、')}</span>}
              {a.note && <span className="text-muted-foreground">· {a.note}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px] text-muted-foreground">整体进度按需求平均；标了「关注」且未完成的需求记为遗留，不计入整体进度；理论进度按迭代已过的工作日计算。</p>
    </section>
  );
}

function AddTask({ org, gantt, onDone }: { org: string; gantt: IterationGantt; onDone: () => void }) {
  const products = useProducts(org);
  const choices = (products.data ?? []).filter((p) => gantt.editableProductIds.includes(p.id));
  const [title, setTitle] = useState('');
  const [productId, setProductId] = useState('');
  const picked = choices.find((p) => p.id === productId) ?? choices[0];
  const create = useApiMutation(
    () =>
      api(`/orgs/${org}/tasks`, {
        method: 'POST',
        body: { iterationId: gantt.iteration.id, title, productId: gantt.iteration.product ? undefined : picked?.id },
      }),
    { invalidate: taskMutationKeys(org), silentError: true, success: '已添加任务', onSuccess: onDone },
  );
  return (
    <form
      aria-label="新建任务"
      className="flex flex-col gap-2 rounded-md border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined);
      }}
    >
      <div className="flex items-center gap-2">
        {!gantt.iteration.product && choices.length > 1 && (
          <Select value={picked?.id} onValueChange={setProductId}>
            <SelectTrigger className="h-8 w-36" aria-label="所属产品">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          aria-label="新任务名称"
          placeholder="不挂需求的任务，例如：联调、埋点"
          className="h-8 max-w-sm"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!title.trim() || create.isPending}>
          添加
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
      <FormError error={create.error} />
    </form>
  );
}

export function GanttTab({ org, iterationId }: { org: string; iterationId: string }) {
  const q = useIterationGantt(org, iterationId);
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const [adding, setAdding] = useState(false);
  if (!q.data) {
    if (q.isError) {
      return <QueryError error={q.error} noAccessMessage="迭代不存在，或你没有查看它的权限。" retryMessage="加载甘特失败，请重试。" onRetry={() => q.refetch()} />;
    }
    return <Skeleton className="h-64" />;
  }
  const g = q.data;
  const people = members.data ? activePeople(members.data) : null;
  return (
    <div className="flex flex-col gap-4">
      <OverviewStrip overview={g.overview} />
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold">
          任务（{g.tasks.length}）
          <span className="font-mono text-xs font-normal text-muted-foreground">
            重点 {g.starredCount}/{STARRED_LIMIT}
          </span>
        </h2>
        {g.canAddTask && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            ＋ 任务
          </Button>
        )}
      </div>
      {adding && <AddTask org={org} gantt={g} onDone={() => setAdding(false)} />}
      {g.tasks.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">还没有任务</p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <Table className="min-w-[1180px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <span className="sr-only">重点</span>
                </TableHead>
                <TableHead>需求 / 任务</TableHead>
                <TableHead className="w-32">负责人</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-60">开始 / 工期（天）</TableHead>
                <TableHead className="w-48">进度（%）</TableHead>
                <TableHead className="w-44">标记 / 延期（天）</TableHead>
                <TableHead className="w-48">说明</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.tasks.map((t) => (
                <TaskRow key={t.id} org={org} task={t} people={people} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 迭代详情页加「甘特」页签**

`apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`（在 Task 8 修改后的版本上）：

1. 前两行 import 改为：

```ts
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
```

2. `import { cn } from '@/lib/utils';` 之后加入 `import { GanttTab } from './gantt-tab';`。

3. `export default function IterationPage() {` 改为 `function IterationPage() {`，并在 `const router = useRouter();` 之后加入：

```ts
  // 工作台里的任务链接带 ?tab=gantt，直接打开甘特页签
  const initialTab = useSearchParams().get('tab') === 'gantt' ? 'gantt' : 'requirements';
```

4. 页签部分

```tsx
      <Tabs defaultValue="requirements">
        <TabsList>
          <TabsTrigger value="requirements">需求（{it.requirementCount}）</TabsTrigger>
```

改为：

```tsx
      <Tabs defaultValue={initialTab}>
        <TabsList>
          <TabsTrigger value="requirements">需求（{it.requirementCount}）</TabsTrigger>
          <TabsTrigger value="gantt">甘特</TabsTrigger>
```

并在 `<TabsContent value="requirements">…</TabsContent>` 之后加入：

```tsx
        <TabsContent value="gantt">
          <GanttTab org={org} iterationId={it.id} />
        </TabsContent>
```

5. 文件末尾追加：

```tsx
export default function Page() {
  return (
    <Suspense>
      <IterationPage />
    </Suspense>
  );
}
```

- [ ] **Step 7: 运行测试确认通过**

Run（端到端在后台运行并写日志）：

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web test
pnpm --filter @flower/web e2e gantt.spec.ts iterations.spec.ts
```

Expected: 全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/lib/labels.ts apps/web/src/features/gantt "apps/web/src/app/(app)/[org]/iterations/[id]" apps/web/e2e/helpers.ts apps/web/e2e/gantt.spec.ts
git commit -m "feat(web): 迭代详情甘特页签：进度概览、任务行内编辑、重点与手工任务

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: 甘特的时间轴与团队负载热力图；跨迭代的人员负载页

**Files:**
- Modify: `apps/web/src/features/gantt/model.ts`、`model.test.ts`（热力图行、色阶、时间轴格子、日期显示、未来工作日、按迭代分组）
- Create: `apps/web/src/components/load-heatmap.tsx`（甘特和人员负载页共用）
- Create: `apps/web/src/app/(app)/[org]/iterations/[id]/timeline.tsx`
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/gantt-tab.tsx`（表格下方加时间轴与热力图）
- Create: `apps/web/src/app/(app)/[org]/workload/page.tsx`
- Modify: `apps/web/src/app/(app)/[org]/iterations/page.tsx`（「人员负载」入口）
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`
- Modify: `apps/web/src/features/shell/nav.ts`、`nav.test.ts`（负载页高亮「迭代」）
- Test: `apps/web/e2e/workload.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `coverKind`、`heatLevel`、`loadCounts`、`workdaysBetween`、`dateOfDay`、`dayNumber`（`@flower/core/schedule`）；Task 7 的 `GET /orgs/:org/members/:id/tasks`；Task 9 的 `GanttTab`、`Task`、`taskKeys`
- Produces（`features/gantt/model.ts`）：
  - `type HeatRow = { id: string; name: string; counts: number[] }`
  - `heatRows(tasks: Array<Pick<Task, 'assignee' | 'planStart' | 'planDays' | 'delayDays'>>, days: string[]): { rows: HeatRow[]; max: number }`
  - `HEAT_CLASSES`（5 档底色）、`heatClass(count: number, max: number): string`
  - `timelineCells(t: Pick<Task, 'planStart' | 'planDays' | 'delayDays'>, days: string[]): Array<'plan' | 'delay' | null>`
  - `shortDate(date: string): string`（`2026-01-05` → `1/5`）
  - `upcomingWorkdays(today: string, weeks: number): string[]`
  - `type IterationGroup = { key: string; iteration: MemberTask['iteration']; tasks: MemberTask[] }`；`groupByIteration(tasks: MemberTask[]): IterationGroup[]`
- Produces（`lib/types.ts`）：`MemberTask = Jsonify<CoreMemberTask>`、`MemberTasks = Jsonify<CoreMemberTasks>`
- Produces（`lib/queries.ts`）：`qk.memberTasks(o, memberId, all)`（前缀在 `taskKeys` 下）、`useMemberTasks(o, memberId, all)`
- Produces（组件）：`DayHeader({ days, today, style, className? })`（工作日列头，时间轴与热力图共用）；`LoadHeatmap({ org, title, days, rows, max, today })`（`section` 的 `aria-label` 为 `title`，姓名链接到 `/[org]/workload?member=<id>`，单元格带 `data-count`）；`Timeline({ tasks, days, today })`（`aria-label="时间轴"`，格子带 `data-kind="plan" | "delay"`）
- Produces（页面）：`/[org]/workload?member=<id>[&all=1]`

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/gantt/model.test.ts`：import 改为

```ts
import { describe, expect, it } from 'vitest';
import type { MemberTask } from '@/lib/types';
import { groupByIteration, heatClass, heatRows, parseHalfDays, parseProgress, shortDate, timelineCells, upcomingWorkdays } from './model';
```

文件末尾追加：

```ts
describe('热力图与时间轴', () => {
  // 09-24 周四、09-25 周五、09-28 周一、09-29 周二、09-30 周三
  const days = ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30'];

  it('每个负责人一行，按姓名排序；未指派的任务不计；周末不占列', () => {
    const a = { id: 'a', displayName: '乙' };
    const b = { id: 'b', displayName: '甲' };
    const r = heatRows(
      [
        { assignee: a, planStart: '2026-09-25', planDays: 5, delayDays: 0 },
        { assignee: a, planStart: '2026-09-24', planDays: 1, delayDays: 0 },
        { assignee: b, planStart: '2026-09-30', planDays: 1, delayDays: null },
        { assignee: null, planStart: '2026-09-24', planDays: 3, delayDays: 0 },
      ],
      days,
    );
    expect(r).toEqual({
      rows: [
        { id: 'b', name: '甲', counts: [0, 0, 0, 0, 1] },
        { id: 'a', name: '乙', counts: [1, 1, 1, 1, 0] },
      ],
      max: 1,
    });
    expect(heatRows([], days)).toEqual({ rows: [], max: 1 });
    expect(heatClass(0, 4)).toBe('bg-muted');
    expect(heatClass(4, 4)).toBe('bg-primary');
  });

  it('时间轴格子区分计划内与延期；没有开始日期的全空', () => {
    expect(timelineCells({ planStart: '2026-09-28', planDays: 2, delayDays: 1 }, days)).toEqual([null, null, 'plan', 'plan', 'delay']);
    expect(timelineCells({ planStart: null, planDays: 2, delayDays: 0 }, days)).toEqual([null, null, null, null, null]);
  });

  it('日期显示与从今天起的工作日', () => {
    expect(shortDate('2026-01-05')).toBe('1/5');
    expect(upcomingWorkdays('2026-09-30', 1)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']);
  });
});

describe('人员负载', () => {
  it('按迭代分组：迭代按开始日期倒序，不在迭代中的放最后', () => {
    const first = { id: 'i1', name: '迭代0105', startDate: '2026-01-05', endDate: '2026-01-16', status: 'active' as const };
    const second = { id: 'i2', name: '迭代0119', startDate: '2026-01-19', endDate: '2026-01-30', status: 'planning' as const };
    const task = (id: string, iteration: typeof first | typeof second | null) => ({ id, iteration }) as unknown as MemberTask;
    const groups = groupByIteration([task('a', first), task('b', null), task('c', second), task('d', first)]);
    expect(groups.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ['i2', ['c']],
      ['i1', ['a', 'd']],
      ['none', ['b']],
    ]);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/gantt/model.test.ts`
Expected: FAIL，`heatRows` 等未导出。

- [ ] **Step 2: 实现模型、类型与查询**

`apps/web/src/features/gantt/model.ts` 文件开头加入 import：

```ts
import { coverKind, dateOfDay, dayNumber, heatLevel, loadCounts, workdaysBetween } from '@flower/core/schedule';
import type { MemberTask, Task } from '@/lib/types';
```

文件末尾追加：

```ts
export type HeatRow = { id: string; name: string; counts: number[] };

/** 热力图的行：每个负责人一行（按姓名排序），列为工作日，值为当天被占用的任务数；未指派的任务不计。 */
export function heatRows(tasks: Array<Pick<Task, 'assignee' | 'planStart' | 'planDays' | 'delayDays'>>, days: string[]): { rows: HeatRow[]; max: number } {
  const byPerson = new Map<string, { name: string; tasks: typeof tasks }>();
  for (const t of tasks) {
    if (!t.assignee) continue;
    const person = byPerson.get(t.assignee.id) ?? { name: t.assignee.displayName, tasks: [] };
    person.tasks.push(t);
    byPerson.set(t.assignee.id, person);
  }
  const rows = [...byPerson.entries()]
    .map(([id, p]) => ({ id, name: p.name, counts: loadCounts(p.tasks, days) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return { rows, max: Math.max(1, ...rows.flatMap((r) => r.counts)) };
}

/** 热力图 5 档底色，对应 heatLevel 的 0–4。 */
export const HEAT_CLASSES = ['bg-muted', 'bg-primary/20', 'bg-primary/40', 'bg-primary/65', 'bg-primary'] as const;
export const heatClass = (count: number, max: number): string => HEAT_CLASSES[heatLevel(count, max)];

/** 时间轴一行在各工作日上的格子：计划内、延期或空。 */
export function timelineCells(t: Pick<Task, 'planStart' | 'planDays' | 'delayDays'>, days: string[]): Array<'plan' | 'delay' | null> {
  return days.map((d) => coverKind(t, d));
}

/** 列头日期：M/D。 */
export const shortDate = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/** 从今天起若干周内的工作日（人员负载页的负载条）。 */
export function upcomingWorkdays(today: string, weeks: number): string[] {
  return workdaysBetween(today, dateOfDay(dayNumber(today) + weeks * 7 - 1));
}

export type IterationGroup = { key: string; iteration: MemberTask['iteration']; tasks: MemberTask[] };

/** 人员负载页：按迭代分组，迭代按开始日期倒序，不在迭代中的任务放最后。 */
export function groupByIteration(tasks: MemberTask[]): IterationGroup[] {
  const groups = new Map<string, IterationGroup>();
  for (const t of tasks) {
    const key = t.iteration?.id ?? 'none';
    const group = groups.get(key) ?? { key, iteration: t.iteration, tasks: [] };
    group.tasks.push(t);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.iteration) return 1;
    if (!b.iteration) return -1;
    return b.iteration.startDate.localeCompare(a.iteration.startDate);
  });
}
```

`apps/web/src/lib/types.ts`：`@flower/core` 的 type import 列表加入 `MemberTask as CoreMemberTask`、`MemberTasks as CoreMemberTasks`，文件末尾追加：

```ts
export type MemberTask = Jsonify<CoreMemberTask>;
export type MemberTasks = Jsonify<CoreMemberTasks>;
```

`apps/web/src/lib/queries.ts`：

1. types import 列表加入 `MemberTasks`。
2. `qk` 中 `workbench` 一行之后加入：

```ts
  memberTasks: (o: string, memberId: string, all: boolean) => ['org', o, 'tasks', 'member', memberId, all ? 'all' : 'open'] as const,
```

3. `useIterationGantt` 之后加入：

```ts
export const useMemberTasks = (o: string, memberId: string, all: boolean) =>
  useQuery({
    queryKey: qk.memberTasks(o, memberId, all),
    queryFn: () => api<MemberTasks>(`/orgs/${o}/members/${memberId}/tasks${all ? '?all=1' : ''}`),
    enabled: !!memberId,
  });
```

Run: `pnpm --filter @flower/web exec vitest run src/features/gantt/model.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/workload.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createIteration, createProduct, createTask, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('甘特下方的时间轴与团队负载；点姓名进入人员负载页，跨迭代列出任务，可以包含已结束的迭代', async ({ page, request }) => {
  const productId = await createProduct(request);
  const dev = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '开发乙' } }))).member.id;
  const first = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  const second = await createIteration(request, productId, '迭代0119', '2026-01-19', '2026-01-30');
  const old = await createIteration(request, productId, '迭代1208', '2025-12-08', '2025-12-19');
  // 01-07 周三开始，工期 2 天、延期 1 天：07、08 为计划内，09 为延期
  await createTask(request, { iterationId: first, title: '接口开发', assigneeMemberId: dev, planStart: '2026-01-07', planDays: 2, delayDays: 1 });
  await createTask(request, { iterationId: second, title: '联调', assigneeMemberId: dev, planStart: '2026-01-19', planDays: 1 });
  await createTask(request, { iterationId: old, title: '旧需求收尾', assigneeMemberId: dev });
  await ok(request.post(`/api/v1/orgs/acme/iterations/${old}/status`, { data: { to: 'active' } }));
  await ok(request.post(`/api/v1/orgs/acme/iterations/${old}/status`, { data: { to: 'done' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${first}?tab=gantt`);
  const timeline = page.getByRole('region', { name: '时间轴' });
  await expect(timeline).toContainText('接口开发');
  await expect(timeline.locator('[data-kind="plan"]')).toHaveCount(2);
  await expect(timeline.locator('[data-kind="delay"]')).toHaveCount(1);
  const heat = page.getByRole('region', { name: '团队负载' });
  await expect(heat.locator('[data-count="1"]')).toHaveCount(3);
  await heat.getByRole('link', { name: '开发乙' }).click();

  await expect(page).toHaveURL(new RegExp(`/acme/workload\\?member=${dev}$`));
  await expect(page.getByRole('heading', { name: '开发乙 的任务' })).toBeVisible();
  await expect(page.getByRole('region', { name: '迭代0105' })).toContainText('接口开发');
  await expect(page.getByRole('region', { name: '迭代0119' })).toContainText('联调');
  await expect(page.getByText('旧需求收尾')).toHaveCount(0);
  await page.getByRole('switch', { name: '包含已结束的迭代' }).click();
  await expect(page.getByRole('region', { name: '迭代1208' })).toContainText('旧需求收尾');
});

test('迭代列表的「人员负载」入口：选择成员后列出任务', async ({ page, request }) => {
  const productId = await createProduct(request);
  const dev = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '开发乙' } }))).member.id;
  const first = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId: first, title: '接口开发', assigneeMemberId: dev });

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/iterations');
  await page.getByRole('link', { name: '人员负载' }).click();
  await expect(page.getByText('选择一位成员，查看他在各个迭代里的任务。')).toBeVisible();
  await page.getByRole('combobox', { name: '选择成员' }).click();
  await page.getByRole('option', { name: '开发乙' }).click();
  await expect(page.getByRole('region', { name: '迭代0105' })).toContainText('接口开发');
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '迭代', exact: true })).toHaveAttribute('aria-current', 'page');
});
```

Run: `pnpm --filter @flower/web e2e workload.spec.ts`
Expected: FAIL，甘特页签下没有「时间轴」区域，也没有 `/acme/workload` 页面。

- [ ] **Step 4: 实现热力图、时间轴、负载页与入口**

`apps/web/src/components/load-heatmap.tsx`：

```tsx
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { HEAT_CLASSES, type HeatRow, heatClass, shortDate } from '@/features/gantt/model';
import { cn } from '@/lib/utils';

/** 工作日列头：第一列留给名称，之后隔一列显示日期，今天加粗。热力图与时间轴共用。 */
export function DayHeader({ days, today, style, className }: { days: string[]; today: string; style: CSSProperties; className?: string }) {
  return (
    <div className={cn('grid text-[10px] text-muted-foreground', className)} style={style}>
      <span />
      {days.map((d, i) => (
        <span key={d} className={cn('text-center font-mono', d === today && 'font-semibold text-foreground')}>
          {i % 2 === 0 || d === today ? shortDate(d) : ''}
        </span>
      ))}
    </div>
  );
}

/** 人员 × 工作日的负载热力图（push 的规则）；姓名链接到人员负载页。 */
export function LoadHeatmap({ org, title, days, rows, max, today }: { org: string; title: string; days: string[]; rows: HeatRow[]; max: number; today: string }) {
  const cols = { gridTemplateColumns: `112px repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <section aria-label={title} className="flex flex-col gap-1.5 overflow-x-auto rounded-md border bg-card p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">没有已指派负责人的任务</p>
      ) : (
        <>
          <DayHeader days={days} today={today} style={cols} className="gap-1" />
          {rows.map((r) => (
            <div key={r.id} className="grid items-center gap-1" style={cols}>
              <Link href={`/${org}/workload?member=${r.id}`} className="truncate pr-2 text-[12px] hover:underline">
                {r.name}
              </Link>
              {r.counts.map((c, i) => (
                <span key={days[i]} title={`${r.name} ${shortDate(days[i]!)}：${c} 个任务`} data-count={c} className={cn('h-5 rounded-sm', heatClass(c, max))} />
              ))}
            </div>
          ))}
          <div className="flex items-center gap-1 pt-1 text-[10px] text-muted-foreground">
            少
            {HEAT_CLASSES.map((c) => (
              <span key={c} className={cn('inline-block size-3 rounded-sm', c)} />
            ))}
            多 · 周末不显示
          </div>
        </>
      )}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/iterations/[id]/timeline.tsx`：

```tsx
import { DayHeader } from '@/components/load-heatmap';
import { timelineCells } from '@/features/gantt/model';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 只读时间轴：按迭代的工作日画出每个有开始日期的任务，计划内与延期分色。 */
export function Timeline({ tasks, days, today }: { tasks: Task[]; days: string[]; today: string }) {
  const scheduled = tasks.filter((t) => t.planStart);
  const cols = { gridTemplateColumns: `180px repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <section aria-label="时间轴" className="flex flex-col gap-1 overflow-x-auto rounded-md border bg-card p-3">
      <h3 className="text-sm font-semibold">时间轴</h3>
      {scheduled.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">没有填写开始日期的任务</p>
      ) : (
        <>
          <DayHeader days={days} today={today} style={cols} className="gap-px" />
          {scheduled.map((t) => (
            <div key={t.id} className="grid items-center gap-px" style={cols}>
              <span className="truncate pr-2 text-[12px]" title={t.title}>
                {t.alias || t.title}
              </span>
              {timelineCells(t, days).map((kind, i) => (
                <span
                  key={days[i]}
                  data-kind={kind ?? undefined}
                  className={cn('h-4', kind === 'plan' ? 'bg-primary/70' : kind === 'delay' ? 'bg-destructive/60' : days[i] === today ? 'bg-muted' : '')}
                />
              ))}
            </div>
          ))}
          <p className="flex items-center gap-3 pt-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-4 bg-primary/70" />
              计划
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-4 bg-destructive/60" />
              延期
            </span>
            <span>周末不显示</span>
          </p>
        </>
      )}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/iterations/[id]/gantt-tab.tsx`：

1. import 区加入：

```ts
import { LoadHeatmap } from '@/components/load-heatmap';
import { heatRows } from '@/features/gantt/model';
import { Timeline } from './timeline';
```

2. `GanttTab` 返回的最外层 `<div className="flex flex-col gap-4">` 里，在 `{g.tasks.length === 0 ? … : …}` 整段之后、`</div>` 之前加入：

```tsx
      <Timeline tasks={g.tasks} days={g.workdays} today={g.today} />
      <LoadHeatmap org={org} title="团队负载" days={g.workdays} {...heatRows(g.tasks, g.workdays)} today={g.today} />
```

`apps/web/src/app/(app)/[org]/workload/page.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { LoadHeatmap } from '@/components/load-heatmap';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { groupByIteration, heatRows, upcomingWorkdays } from '@/features/gantt/model';
import { activePeople, canListMembers } from '@/features/members/model';
import { ITERATION_STATUS_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';
import { useMembers, useMemberTasks, useOrg } from '@/lib/queries';
import type { MemberTasks } from '@/lib/types';

function WorkloadBody({ org, data }: { org: string; data: MemberTasks }) {
  const days = upcomingWorkdays(data.today, 4);
  const groups = groupByIteration(data.tasks);
  return (
    <div className="flex flex-col gap-4">
      <LoadHeatmap org={org} title="未来四周负载" days={days} {...heatRows(data.tasks, days)} today={data.today} />
      {groups.length === 0 && <p className="py-8 text-center text-muted-foreground">没有进行中的任务</p>}
      {groups.map((g) => (
        <section key={g.key} aria-label={g.iteration?.name ?? '不在迭代中'} className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 font-semibold">
            {g.iteration ? (
              <Link href={`/${org}/iterations/${g.iteration.id}?tab=gantt`} className="hover:underline">
                {g.iteration.name}
              </Link>
            ) : (
              '不在迭代中'
            )}
            {g.iteration && (
              <span className="text-xs font-normal text-muted-foreground">
                <span className="font-mono">
                  {g.iteration.startDate} ~ {g.iteration.endDate}
                </span>{' '}
                · {ITERATION_STATUS_LABEL[g.iteration.status]}
              </span>
            )}
          </h2>
          <div className="overflow-hidden rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>任务</TableHead>
                  <TableHead className="w-64">需求</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-44">开始 / 工期</TableHead>
                  <TableHead className="w-20 text-right">进度</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.tasks.map((t) => (
                  <TableRow key={t.id} className="h-10 even:bg-zebra">
                    <TableCell>{t.alias || t.title}</TableCell>
                    <TableCell>
                      {t.requirement ? (
                        <Link href={`/${org}/requirements/${t.requirement.displayKey}`} className="hover:underline">
                          <span className="font-mono">{t.requirement.displayKey}</span> {t.requirement.title}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{TASK_STATUS_LABEL[t.status]}</TableCell>
                    <TableCell className="font-mono text-[13px]">
                      {t.planStart ?? '—'}
                      {t.planDays !== null && ` · ${t.planDays} 天`}
                    </TableCell>
                    <TableCell className="text-right font-mono">{t.progress}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}
    </div>
  );
}

function WorkloadPage() {
  const { org } = useParams<{ org: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const memberId = params.get('member') ?? '';
  const includeFinished = params.get('all') === '1';
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const q = useMemberTasks(org, memberId, includeFinished);
  const people = members.data ? activePeople(members.data) : [];
  const go = (next: { member?: string; all?: boolean }) => {
    const sp = new URLSearchParams();
    const member = next.member ?? memberId;
    if (member) sp.set('member', member);
    if (next.all ?? includeFinished) sp.set('all', '1');
    router.replace(`/${org}/workload?${sp.toString()}`);
  };

  let body: ReactNode;
  if (!memberId) body = <p className="py-12 text-center text-muted-foreground">选择一位成员，查看他在各个迭代里的任务。</p>;
  else if (q.data) body = <WorkloadBody org={org} data={q.data} />;
  else if (q.isError) body = <QueryError error={q.error} noAccessMessage="成员不存在，或你没有查看权限。" retryMessage="加载任务失败，请重试。" onRetry={() => q.refetch()} />;
  else body = <Skeleton className="h-40" />;

  return (
    <>
      <PageHeader
        crumbs={[{ label: '迭代', href: `/${org}/iterations` }, { label: '人员负载' }]}
        title={q.data ? `${q.data.member.displayName} 的任务` : '人员负载'}
        description="跨迭代列出一个人负责的任务。默认只看规划中和进行中的迭代，以及不在迭代中的未完成任务。"
      />
      <div className="flex items-center gap-4">
        {people.length > 0 && (
          <Select value={memberId || undefined} onValueChange={(v) => go({ member: v })}>
            <SelectTrigger className="h-8 w-44" aria-label="选择成员">
              <SelectValue placeholder="选择成员" />
            </SelectTrigger>
            <SelectContent>
              {people.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="flex items-center gap-2 text-[13px]">
          <Switch aria-label="包含已结束的迭代" checked={includeFinished} onCheckedChange={(v) => go({ all: v })} />
          包含已结束的迭代
        </span>
      </div>
      {body}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <WorkloadPage />
    </Suspense>
  );
}
```

`apps/web/src/app/(app)/[org]/iterations/page.tsx` 中：

```tsx
        actions={canCreate && <Button onClick={() => setDialog({ open: true, iteration: null })}>新建迭代</Button>}
```

改为：

```tsx
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href={`/${org}/workload`}>人员负载</Link>
            </Button>
            {canCreate && <Button onClick={() => setDialog({ open: true, iteration: null })}>新建迭代</Button>}
          </>
        }
```

`apps/web/src/features/shell/nav.ts` 的 `activeNavKey` 中，`if (/^\/iterations(\/|$)/.test(rest)) return 'iterations';` 之后加入：

```ts
  if (/^\/workload(\/|$)/.test(rest)) return 'iterations';
```

`apps/web/src/features/shell/nav.test.ts` 的「根据路径判断当前导航项」用例末尾加入：

```ts
    expect(activeNavKey('/acme/workload', 'acme')).toBe('iterations');
```

- [ ] **Step 5: 运行测试确认通过**

Run（端到端在后台运行并写日志）：

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web test
pnpm --filter @flower/web e2e workload.spec.ts gantt.spec.ts iterations.spec.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/features/gantt apps/web/src/components/load-heatmap.tsx "apps/web/src/app/(app)/[org]/iterations" "apps/web/src/app/(app)/[org]/workload" apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/features/shell/nav.ts apps/web/src/features/shell/nav.test.ts apps/web/e2e/workload.spec.ts
git commit -m "feat(web): 甘特时间轴与团队负载热力图，跨迭代的人员负载页

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: 批量评审表 `/[org]/reviews`：按检查项的列、统计栏、筛选、展开签字与代签

**Files:**
- Move: `apps/web/src/app/(app)/[org]/requirements/[key]/check-items.tsx` → `apps/web/src/components/check-items.tsx`（导出 `CHECK_STATE_STYLE`；签字后同时刷新工作台）
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`（改从 `@/components/check-items` 导入）
- Create: `apps/web/src/features/reviews/model.ts`、`apps/web/src/features/reviews/model.test.ts`
- Create: `apps/web/src/app/(app)/[org]/reviews/page.tsx`
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`
- Modify: `apps/web/src/features/shell/nav.ts`、`nav.test.ts`、`apps/web/src/components/org-shell.tsx`（导航「评审」）
- Modify: `apps/web/e2e/helpers.ts`（`applyReviewWorkflow`）
- Test: `apps/web/e2e/reviews.spec.ts`

**Interfaces:**
- Consumes: Task 7 的 `GET /orgs/:org/products/:id/reviews`；P1-A 的签字接口（经由 `CheckItems`）；`useRequirement`、`useProducts`、`requirementKeys`；Task 9 的 `qk.workbench`；Task 8 的 `QueryError`
- Produces（`components/check-items.tsx`）：`CheckItems({ org, requirement })`（行为不变）、`CHECK_STATE_STYLE: Record<CheckState, string>`
- Produces（`lib/types.ts`）：`ReviewQueue = Jsonify<CoreReviewQueue>`、`ReviewState`、`ReviewFilterState`
- Produces（`lib/queries.ts`）：`qk.reviews(o, productId, query)`（前缀在 `requirementKeys` 下，签字后自动刷新）、`useReviewQueue(o, productId | undefined, query)`
- Produces（`features/reviews/model.ts`）：`type ReviewFilter = { state: ReviewFilterState; itemKey: string; itemState: CheckState; mine: boolean }`、`DEFAULT_REVIEW_FILTER`、`REVIEW_STATES`、`REVIEW_STATE_LABEL`、`REVIEW_FILTER_OPTIONS`、`reviewQuery(f: ReviewFilter): string`、`cellText(cell): string`、`waitingText(waiting): string | null`
- Produces（e2e `helpers.ts`）：`applyReviewWorkflow(request, productId, bossMemberId): Promise<void>`（检查项：可行性（普通）、设计签字（会签：产品管理员 + 指定成员））

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/reviews/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { cellText, DEFAULT_REVIEW_FILTER, reviewQuery, waitingText } from './model';

describe('评审表', () => {
  it('查询参数：整体状态必带；选了检查项才带检查项状态；等我签字', () => {
    expect(reviewQuery(DEFAULT_REVIEW_FILTER)).toBe('state=open');
    expect(reviewQuery({ ...DEFAULT_REVIEW_FILTER, state: 'all', itemKey: 'design', itemState: 'in_progress', mine: true })).toBe(
      'state=all&item=design&itemState=in_progress&mine=1',
    );
  });

  it('单元格：普通检查项只显示状态，会签检查项加上通过数', () => {
    expect(cellText({ state: 'passed', passed: null, total: null })).toBe('通过');
    expect(cellText({ state: 'in_progress', passed: 1, total: 2 })).toBe('进行中 1/2');
  });

  it('待签标记：有本人的规则为「待我签」，只有代签时为「可代签」', () => {
    expect(waitingText([])).toBeNull();
    expect(waitingText([{ itemKey: 'design', ruleIndex: 1, onBehalf: true }])).toBe('可代签');
    expect(
      waitingText([
        { itemKey: 'design', ruleIndex: 1, onBehalf: true },
        { itemKey: 'design', ruleIndex: 0, onBehalf: false },
      ]),
    ).toBe('待我签');
  });
});
```

`apps/web/src/features/shell/nav.test.ts`：「管理员看到设置分组」用例中 `nav.main` 的期望改为：

```ts
    expect(nav.main.map((i) => [i.label, i.phase ?? null, i.href ?? null])).toEqual([
      ['概览', null, '/acme'],
      ['需求', null, '/acme/requirements'],
      ['迭代', null, '/acme/iterations'],
      ['评审', null, '/acme/reviews'],
      ['文档', 'P2', null],
    ]);
```

「根据路径判断当前导航项」用例末尾加入：

```ts
    expect(activeNavKey('/acme/reviews', 'acme')).toBe('reviews');
```

Run: `pnpm --filter @flower/web exec vitest run src/features/reviews/model.test.ts src/features/shell/nav.test.ts`
Expected: FAIL，`./model` 不存在；导航没有「评审」。

- [ ] **Step 2: 实现模型、类型、查询与导航**

`apps/web/src/features/reviews/model.ts`：

```ts
import { CHECK_STATE_LABEL } from '@/lib/labels';
import type { CheckState, ReviewFilterState, ReviewQueue, ReviewState } from '@/lib/types';

export type ReviewFilter = { state: ReviewFilterState; itemKey: string; itemState: CheckState; mine: boolean };
export const DEFAULT_REVIEW_FILTER: ReviewFilter = { state: 'open', itemKey: '', itemState: 'not_started', mine: false };
export const REVIEW_STATES: ReviewState[] = ['not_started', 'in_progress', 'rejected', 'passed'];
export const REVIEW_STATE_LABEL: Record<ReviewState, string> = { not_started: '未开始', in_progress: '评审中', rejected: '有驳回', passed: '已通过' };
export const REVIEW_FILTER_OPTIONS: Array<{ value: ReviewFilterState; label: string }> = [
  { value: 'open', label: '待评审（未全部通过）' },
  { value: 'not_started', label: '未开始' },
  { value: 'in_progress', label: '评审中' },
  { value: 'rejected', label: '有驳回' },
  { value: 'passed', label: '已通过' },
  { value: 'all', label: '全部' },
];

export function reviewQuery(f: ReviewFilter): string {
  const p = new URLSearchParams({ state: f.state });
  if (f.itemKey) {
    p.set('item', f.itemKey);
    p.set('itemState', f.itemState);
  }
  if (f.mine) p.set('mine', '1');
  return p.toString();
}

type Row = ReviewQueue['rows'][number];

/** 单元格文字：普通检查项只显示状态，会签检查项加上「通过数/规则数」。 */
export function cellText(cell: Row['cells'][string]): string {
  const label = CHECK_STATE_LABEL[cell.state];
  return cell.total === null ? label : `${label} ${cell.passed}/${cell.total}`;
}

/** 行尾的待签标记：有本人的规则为「待我签」，只有可代签的规则时为「可代签」。 */
export function waitingText(waiting: Row['waiting']): string | null {
  if (waiting.some((w) => !w.onBehalf)) return '待我签';
  return waiting.length > 0 ? '可代签' : null;
}
```

`apps/web/src/lib/types.ts`：`@flower/core` 的 type import 列表加入 `ReviewFilterState as CoreReviewFilterState`、`ReviewQueue as CoreReviewQueue`、`ReviewState as CoreReviewState`，文件末尾追加：

```ts
export type ReviewQueue = Jsonify<CoreReviewQueue>;
export type ReviewState = CoreReviewState;
export type ReviewFilterState = CoreReviewFilterState;
```

`apps/web/src/lib/queries.ts`：

1. types import 列表加入 `ReviewQueue`。
2. `qk` 中 `requirementComments` 一行之后加入：

```ts
  reviews: (o: string, productId: string, query: string) => ['org', o, 'requirements', 'reviews', productId, query] as const,
```

3. `useRequirementComments` 之后加入：

```ts
export const useReviewQueue = (o: string, productId: string | undefined, query: string) =>
  useQuery({
    queryKey: qk.reviews(o, productId ?? '', query),
    queryFn: () => api<{ queue: ReviewQueue }>(`/orgs/${o}/products/${productId}/reviews?${query}`),
    select: (d) => d.queue,
    enabled: !!productId,
    placeholderData: keepPreviousData,
  });
```

`apps/web/src/features/shell/nav.ts`：

1. `NavIcon` 类型加入 `'review'`：

```ts
export type NavIcon = 'home' | 'list' | 'cycle' | 'review' | 'doc' | 'users' | 'tag' | 'box' | 'flow' | 'sliders' | 'bot' | 'building';
```

2. `main` 中「迭代」之后加入：

```ts
      { key: 'reviews', label: '评审', href: `/${org}/reviews`, icon: 'review' },
```

3. `activeNavKey` 中 `workload` 一行之后加入：

```ts
  if (/^\/reviews(\/|$)/.test(rest)) return 'reviews';
```

`apps/web/src/components/org-shell.tsx`：lucide import 列表加入 `ClipboardCheck`，`ICONS` 中 `cycle: RefreshCw,` 之后加入 `review: ClipboardCheck,`。

Run: `pnpm --filter @flower/web exec vitest run src/features/reviews/model.test.ts src/features/shell/nav.test.ts`
Expected: PASS。

- [ ] **Step 3: 移动检查项组件**

```bash
git mv "apps/web/src/app/(app)/[org]/requirements/[key]/check-items.tsx" apps/web/src/components/check-items.tsx
```

`apps/web/src/components/check-items.tsx`：

1. `import { requirementKeys, useApiMutation } from '@/lib/queries';` 改为：

```ts
import { qk, requirementKeys, useApiMutation } from '@/lib/queries';
```

2. `const STATE_STYLE: Record<CheckState, string> = {` 改为 `export const CHECK_STATE_STYLE: Record<CheckState, string> = {`，文件里的 `STATE_STYLE[c.state]` 改为 `CHECK_STATE_STYLE[c.state]`。

3. 两处 `invalidate: [requirementKeys(org)],` 都改为（签字与检查项变化会影响工作台的「等我签字」）：

```ts
    invalidate: [requirementKeys(org), qk.workbench],
```

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx` 中 `import { CheckItems } from './check-items';` 删除，在 `@/components/…` 的 import 之间加入：

```ts
import { CheckItems } from '@/components/check-items';
```

- [ ] **Step 4: 写失败的端到端测试**

`apps/web/e2e/helpers.ts` 末尾追加：

```ts
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
```

`apps/web/e2e/reviews.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyReviewWorkflow, createProduct, createRequirement, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('评审表：按检查项生成列，统计与「等我签字」筛选，展开后本人签字与代签', async ({ page, request }) => {
  const productId = await createProduct(request);
  const boss = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '老板乙' } }))).member.id;
  await applyReviewWorkflow(request, productId, boss);
  await createRequirement(request, productId, '未开始的需求');
  const started = await createRequirement(request, productId, '评审中的需求');
  await ok(request.put(`/api/v1/orgs/acme/requirements/${started.id}/checks/feasibility`, { data: { state: 'passed' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '评审' }).click();
  await expect(page).toHaveURL(/\/acme\/reviews$/);
  await expect(page.getByRole('columnheader', { name: '设计签字' })).toBeVisible();
  const stats = page.getByRole('group', { name: '评审统计' });
  await expect(stats.getByRole('button', { name: /未开始/ })).toContainText('1');
  await expect(stats.getByRole('button', { name: /评审中/ })).toContainText('1');

  await page.getByRole('checkbox', { name: '等我签字' }).click();
  const row = page.getByRole('row').filter({ hasText: '评审中的需求' });
  await expect(row).toContainText('待我签');
  await expect(page.getByRole('row').filter({ hasText: '未开始的需求' })).toHaveCount(0);

  await page.getByRole('button', { name: '展开 PAN-2' }).click();
  const design = page.getByRole('listitem', { name: '设计签字' });
  await design.getByRole('button', { name: '通过' }).click();
  await expect(page.getByText('已签字')).toBeVisible();
  await expect(row.first()).toContainText('进行中 1/2');
  await expect(row.first()).toContainText('可代签');

  await design.getByRole('button', { name: '代签' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认代签' }).click();
  await expect(stats.getByRole('button', { name: /已通过/ })).toContainText('1');
  await expect(page.getByText('没有符合条件的需求')).toBeVisible();
});

test('评审表：流程没有检查项时给出提示', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/reviews');
  await expect(page.getByText('这个产品的流程没有配置检查项')).toBeVisible();
});
```

Run: `pnpm --filter @flower/web e2e reviews.spec.ts`
Expected: FAIL，没有 `/acme/reviews` 页面。

- [ ] **Step 5: 实现评审页**

`apps/web/src/app/(app)/[org]/reviews/page.tsx`：

```tsx
'use client';

import { ChevronDown, ChevronRight, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, type ReactNode, useState } from 'react';
import { CHECK_STATE_STYLE, CheckItems } from '@/components/check-items';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  cellText,
  DEFAULT_REVIEW_FILTER,
  REVIEW_FILTER_OPTIONS,
  REVIEW_STATE_LABEL,
  REVIEW_STATES,
  type ReviewFilter,
  reviewQuery,
  waitingText,
} from '@/features/reviews/model';
import { CHECK_STATE_LABEL } from '@/lib/labels';
import { useProducts, useRequirement, useReviewQueue } from '@/lib/queries';
import type { CheckState, ReviewFilterState, ReviewQueue } from '@/lib/types';
import { cn } from '@/lib/utils';

const ANY = 'any';

/** 展开行：复用需求详情的检查项组件（本人签字、代签对话框、普通检查项的状态下拉）。 */
function RowDetail({ org, displayKey }: { org: string; displayKey: string }) {
  const q = useRequirement(org, displayKey);
  if (!q.data) {
    if (q.isError) return <QueryError error={q.error} noAccessMessage="需求不存在，或你没有查看权限。" retryMessage="加载检查项失败，请重试。" onRetry={() => q.refetch()} />;
    return <Skeleton className="h-24" />;
  }
  return <CheckItems org={org} requirement={q.data} />;
}

function QueueTable({ org, queue }: { org: string; queue: ReviewQueue }) {
  const [open, setOpen] = useState<string | null>(null);
  if (queue.rows.length === 0) return <p className="py-8 text-center text-muted-foreground">没有符合条件的需求</p>;
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <span className="sr-only">展开</span>
            </TableHead>
            <TableHead className="w-24">编号</TableHead>
            <TableHead>标题</TableHead>
            <TableHead className="w-24">状态</TableHead>
            <TableHead className="w-24">负责人</TableHead>
            {queue.columns.map((c) => (
              <TableHead key={c.key} className="w-28">
                {c.label}
              </TableHead>
            ))}
            <TableHead className="w-20">
              <span className="sr-only">待签</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {queue.rows.map((r) => {
            const expanded = open === r.id;
            const waiting = waitingText(r.waiting);
            return (
              <Fragment key={r.id}>
                <TableRow className="h-10 even:bg-zebra">
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${expanded ? '收起' : '展开'} ${r.displayKey}`}
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : r.id)}
                    >
                      {expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                    </Button>
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{r.displayKey}</TableCell>
                  <TableCell>
                    <Link href={`/${org}/requirements/${r.displayKey}`} className="hover:underline">
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-[13px]" style={{ color: r.state.color }}>
                    {r.state.label}
                  </TableCell>
                  <TableCell className="text-[13px]">{r.owner?.displayName ?? '—'}</TableCell>
                  {queue.columns.map((c) => {
                    const cell = r.cells[c.key]!;
                    return (
                      <TableCell key={c.key} className={cn('text-[13px]', CHECK_STATE_STYLE[cell.state])}>
                        {cellText(cell)}
                      </TableCell>
                    );
                  })}
                  <TableCell>{waiting && <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{waiting}</span>}</TableCell>
                </TableRow>
                {expanded && (
                  <TableRow>
                    <TableCell colSpan={queue.columns.length + 6} className="bg-muted/40 p-3">
                      <RowDetail org={org} displayKey={r.displayKey} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function Filters({ queue, filter, onChange }: { queue: ReviewQueue; filter: ReviewFilter; onChange: (patch: Partial<ReviewFilter>) => void }) {
  return (
    <>
      <div role="group" aria-label="评审统计" className="flex flex-wrap gap-2">
        {REVIEW_STATES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={filter.state === s ? 'secondary' : 'outline'}
            aria-pressed={filter.state === s}
            onClick={() => onChange({ state: filter.state === s ? 'open' : s })}
          >
            {REVIEW_STATE_LABEL[s]} <span className="font-mono">{queue.stats[s]}</span>
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={filter.state} onValueChange={(v) => onChange({ state: v as ReviewFilterState })}>
          <SelectTrigger className="h-8 w-48" aria-label="整体状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REVIEW_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.itemKey || ANY} onValueChange={(v) => onChange({ itemKey: v === ANY ? '' : v })}>
          <SelectTrigger className="h-8 w-40" aria-label="检查项">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>全部检查项</SelectItem>
            {queue.columns.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filter.itemKey && (
          <Select value={filter.itemState} onValueChange={(v) => onChange({ itemState: v as CheckState })}>
            <SelectTrigger className="h-8 w-28" aria-label="检查项状态">
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
        )}
        <span className="flex items-center gap-2 text-[13px]">
          <Checkbox aria-label="等我签字" checked={filter.mine} onCheckedChange={(v) => onChange({ mine: v === true })} />
          等我签字
        </span>
      </div>
    </>
  );
}

export default function ReviewsPage() {
  const { org } = useParams<{ org: string }>();
  const products = useProducts(org);
  const [productId, setProductId] = useState('');
  const product = (products.data ?? []).find((p) => p.id === productId) ?? products.data?.[0];
  const [filter, setFilter] = useState<ReviewFilter>(DEFAULT_REVIEW_FILTER);
  const q = useReviewQueue(org, product?.id, reviewQuery(filter));
  const change = (patch: Partial<ReviewFilter>) => setFilter((f) => ({ ...f, ...patch }));

  let body: ReactNode;
  if (products.data && products.data.length === 0) body = <EmptyState icon={ClipboardCheck} title="还没有产品" />;
  else if (!q.data) {
    body = q.isError ? (
      <QueryError error={q.error} noAccessMessage="产品不存在，或你没有查看权限。" retryMessage="加载评审表失败，请重试。" onRetry={() => q.refetch()} />
    ) : (
      <Skeleton className="h-64" />
    );
  } else if (q.data.columns.length === 0) {
    body = <EmptyState icon={ClipboardCheck} title="这个产品的流程没有配置检查项" description="组织管理员可以在「流程模板」里给流程添加检查项。" />;
  } else {
    body = (
      <>
        <Filters queue={q.data} filter={filter} onChange={change} />
        <QueueTable org={org} queue={q.data} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="评审"
        description="按流程里配置的检查项批量查看评审进度；展开一行即可签字或代签。"
        actions={
          (products.data?.length ?? 0) > 1 && (
            <Select
              value={product?.id}
              onValueChange={(v) => {
                setProductId(v);
                setFilter(DEFAULT_REVIEW_FILTER);
              }}
            >
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
```

- [ ] **Step 6: 运行测试确认通过**

Run（端到端在后台运行并写日志）：

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web test
pnpm --filter @flower/web e2e reviews.spec.ts requirements.spec.ts
```

Expected: 全部 PASS（`requirements.spec.ts` 覆盖需求详情里本人签字与代签，检查项组件移动后行为不变）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/check-items.tsx "apps/web/src/app/(app)/[org]/requirements/[key]" "apps/web/src/app/(app)/[org]/reviews" apps/web/src/features/reviews apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/features/shell/nav.ts apps/web/src/features/shell/nav.test.ts apps/web/src/components/org-shell.tsx apps/web/e2e/helpers.ts apps/web/e2e/reviews.spec.ts
git commit -m "feat(web): 批量评审表：按流程检查项生成列，统计、筛选、展开签字与代签

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: 工作台作为登录后的默认页；概览页移到 `/[org]/overview`

**Files:**
- Move: `apps/web/src/app/(app)/[org]/page.tsx` → `apps/web/src/app/(app)/[org]/overview/page.tsx`（产品列表加载中显示骨架、失败显示重试）
- Create: `apps/web/src/app/(app)/[org]/page.tsx`（工作台）
- Create: `apps/web/src/features/workbench/model.ts`、`apps/web/src/features/workbench/model.test.ts`
- Modify: `apps/web/src/app/(app)/page.tsx`（有组织时跳到第一个组织的工作台）
- Modify: `apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`（面包屑「概览」指向 `/[org]/overview`）
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`
- Modify: `apps/web/src/features/shell/nav.ts`、`nav.test.ts`、`apps/web/src/components/org-shell.tsx`（导航「工作台」「概览」）
- Modify: `apps/web/e2e/overview.spec.ts`、`apps/web/e2e/acceptance.spec.ts`、`apps/web/e2e/product-admin.spec.ts`（落地页变化后同步）
- Test: `apps/web/e2e/workbench.spec.ts`

**Interfaces:**
- Consumes: Task 7 的 `GET /me/workbench`；Task 9 的 `qk.workbench`；Task 11 的 `applyReviewWorkflow`；Task 8 的 `QueryError`
- Produces（`lib/types.ts`）：`Workbench = Jsonify<CoreWorkbench>`
- Produces（`lib/queries.ts`）：`useWorkbench()`
- Produces（`features/workbench/model.ts`）：`requirementHref(org: { slug: string }, displayKey: string): string`、`taskHref(task): string`、`showOrgBadge(orgs): boolean`
- Produces（页面）：`/[org]` = 工作台（四个 `section`，名称以「我负责的需求」「我的任务」「等我签字」「未读评论」开头）；`/[org]/overview` = 原概览页

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/workbench/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { requirementHref, showOrgBadge, taskHref } from './model';

describe('工作台链接', () => {
  const org = { id: 'o1', slug: 'acme', name: '测试组织' };
  const base = { org, id: 't1', title: '联调', status: 'todo' as const, planStart: null, progress: 0 };

  it('需求行链接到详情；任务行优先链接到需求，没有需求时到迭代的甘特页签', () => {
    expect(requirementHref(org, 'PAN-1')).toBe('/acme/requirements/PAN-1');
    expect(taskHref({ ...base, requirement: { displayKey: 'PAN-2', title: '分享统计' }, iteration: { id: 'i1', name: '迭代0105' } })).toBe('/acme/requirements/PAN-2');
    expect(taskHref({ ...base, requirement: null, iteration: { id: 'i1', name: '迭代0105' } })).toBe('/acme/iterations/i1?tab=gantt');
  });

  it('加入多个组织时才在每行标出组织名', () => {
    expect(showOrgBadge([org])).toBe(false);
    expect(showOrgBadge([org, { id: 'o2', slug: 'other', name: '第二组织' }])).toBe(true);
  });
});
```

`apps/web/src/features/shell/nav.test.ts`：「管理员看到设置分组」用例中 `nav.main` 的期望改为：

```ts
    expect(nav.main.map((i) => [i.label, i.phase ?? null, i.href ?? null])).toEqual([
      ['工作台', null, '/acme'],
      ['概览', null, '/acme/overview'],
      ['需求', null, '/acme/requirements'],
      ['迭代', null, '/acme/iterations'],
      ['评审', null, '/acme/reviews'],
      ['文档', 'P2', null],
    ]);
```

「根据路径判断当前导航项」用例末尾加入：

```ts
    expect(activeNavKey('/acme/overview', 'acme')).toBe('overview');
```

Run: `pnpm --filter @flower/web exec vitest run src/features/workbench/model.test.ts src/features/shell/nav.test.ts`
Expected: FAIL。

- [ ] **Step 2: 实现模型、类型、查询与导航**

`apps/web/src/features/workbench/model.ts`：

```ts
import type { Workbench } from '@/lib/types';

type Org = Workbench['orgs'][number];

export const requirementHref = (org: Pick<Org, 'slug'>, displayKey: string): string => `/${org.slug}/requirements/${displayKey}`;

/** 任务行的链接：挂了需求的去需求详情，否则去所在迭代的甘特页签。 */
export function taskHref(t: Workbench['tasks']['items'][number]): string {
  if (t.requirement) return requirementHref(t.org, t.requirement.displayKey);
  if (t.iteration) return `/${t.org.slug}/iterations/${t.iteration.id}?tab=gantt`;
  return `/${t.org.slug}/iterations`;
}

/** 只有加入了多个组织时才在每行标出组织名。 */
export const showOrgBadge = (orgs: Workbench['orgs']): boolean => orgs.length > 1;
```

`apps/web/src/lib/types.ts`：`@flower/core` 的 type import 列表加入 `Workbench as CoreWorkbench`，文件末尾追加：

```ts
export type Workbench = Jsonify<CoreWorkbench>;
```

`apps/web/src/lib/queries.ts`：types import 列表加入 `Workbench`；`useMe` 之后加入：

```ts
export const useWorkbench = () =>
  useQuery({ queryKey: qk.workbench, queryFn: () => api<{ workbench: Workbench }>('/me/workbench'), select: (d) => d.workbench });
```

`apps/web/src/features/shell/nav.ts`：

1. `NavIcon` 类型加入 `'grid'`：

```ts
export type NavIcon = 'home' | 'grid' | 'list' | 'cycle' | 'review' | 'doc' | 'users' | 'tag' | 'box' | 'flow' | 'sliders' | 'bot' | 'building';
```

2. `main` 中

```ts
      { key: 'home', label: '概览', href: `/${org}`, icon: 'home' },
```

替换为：

```ts
      { key: 'home', label: '工作台', href: `/${org}`, icon: 'home' },
      { key: 'overview', label: '概览', href: `/${org}/overview`, icon: 'grid' },
```

3. `activeNavKey` 中 `reviews` 一行之后加入：

```ts
  if (/^\/overview(\/|$)/.test(rest)) return 'overview';
```

`apps/web/src/components/org-shell.tsx`：lucide import 列表加入 `LayoutGrid`，`ICONS` 中 `home: Home,` 之后加入 `grid: LayoutGrid,`。

Run: `pnpm --filter @flower/web exec vitest run src/features/workbench/model.test.ts src/features/shell/nav.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试，并同步受影响的现有 spec**

`apps/web/e2e/workbench.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyReviewWorkflow, createIteration, createProduct, createTask, FAIL_500, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('登录后进入工作台：跨组织汇总负责的需求、我的任务、等我签字与未读评论，行可以点进去', async ({ page, request, playwright }) => {
  const productId = await createProduct(request);
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const boss = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '老板乙' } }))).member.id;
  await applyReviewWorkflow(request, productId, boss);
  const req = (
    await json<{ requirement: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '上传提速', ownerMemberId: me } }))
  ).requirement;
  await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/checks/feasibility`, { data: { state: 'passed' } }));
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId, requirementId: req.id, title: '接口联调', assigneeMemberId: me });

  // 用 Agent 的 Token 发一条评论，作为「别人的评论」
  const agent = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/agents', { data: { displayName: '评审助手' } }))).member.id;
  const { token } = await json<{ token: string }>(
    request.post('/api/v1/orgs/acme/tokens', { data: { memberId: agent, name: '评论', scope: { products: 'all', access: 'write' } } }),
  );
  const bot = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  await ok(bot.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: '接口文档在哪？' } }));
  await bot.dispose();

  // 第二个组织里也有一条自己负责的需求
  await ok(request.post('/api/v1/orgs', { data: { name: '第二组织', slug: 'second' } }));
  const secondProduct = (await json<{ product: { id: string } }>(request.post('/api/v1/orgs/second/products', { data: { name: '文档', key: 'DOC' } }))).product.id;
  const secondMe = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/second'))).me.memberId;
  await ok(request.post(`/api/v1/orgs/second/products/${secondProduct}/requirements`, { data: { title: '另一个组织的需求', ownerMemberId: secondMe } }));

  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  const owned = page.getByRole('region', { name: /我负责的需求/ });
  await expect(owned.getByRole('link', { name: /PAN-1/ })).toBeVisible();
  await expect(owned.getByRole('link', { name: /DOC-1/ })).toContainText('第二组织');
  await expect(page.getByRole('region', { name: /我的任务/ }).getByRole('link', { name: /接口联调/ })).toBeVisible();
  const sign = page.getByRole('region', { name: /等我签字/ });
  await expect(sign.getByRole('link')).toHaveCount(2);
  await expect(sign.getByRole('link').filter({ hasText: '代 老板乙' })).toBeVisible();
  const unread = page.getByRole('region', { name: /未读评论/ });
  await expect(unread.getByRole('link', { name: /PAN-1/ })).toContainText('1 条未读');
  await unread.getByRole('link', { name: /PAN-1/ }).click();
  await expect(page).toHaveURL(/\/acme\/requirements\/PAN-1$/);
});

test('工作台加载失败（5xx）显示重试', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.route('**/api/v1/me/workbench', (route) => route.fulfill(FAIL_500));
  await page.goto('/acme');
  await expect(page.getByText('加载工作台失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/v1/me/workbench');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('region', { name: /我负责的需求/ })).toBeVisible();
});
```

`apps/web/e2e/overview.spec.ts` 整个替换为：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

test('只有一个组织时登录后进入该组织的工作台；概览页显示产品与管理员的配置清单', async ({ page, request }) => {
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '概览' }).click();
  await expect(page).toHaveURL(/\/acme\/overview$/);
  await expect(page.getByRole('heading', { name: '测试组织' })).toBeVisible();
  const list = page.getByRole('list', { name: '组织配置清单' });
  await expect(list.getByRole('listitem')).toHaveCount(6);
  await expect(page.getByText('已完成 0 / 6')).toBeVisible();
  await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  await page.reload();
  await expect(page.getByText('已完成 1 / 6')).toBeVisible();
  await expect(page.getByRole('link', { name: /网盘/ }).filter({ hasText: 'PAN' })).toBeVisible();
});
```

`apps/web/e2e/acceptance.spec.ts`：

1. 第 1 步末尾

```ts
  await page.waitForURL('**/pan');
  await expect(page.getByText('已完成 0 / 6')).toBeVisible();
```

改为：

```ts
  await page.waitForURL('**/pan');
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  await page.goto('/pan/overview');
  await expect(page.getByText('已完成 0 / 6')).toBeVisible();
```

2. 第 8 步

```ts
  await page.goto('/pan');
```

改为：

```ts
  await page.goto('/pan/overview');
```

`apps/web/e2e/product-admin.spec.ts`：

1. 把

```ts
  await page.reload();
  await page.getByRole('link', { name: '网盘 产品设置' }).click();
```

改为：

```ts
  await page.goto('/acme/overview');
  await page.getByRole('link', { name: '网盘 产品设置' }).click();
```

2. 把

```ts
  await expect(page).toHaveURL(/\/acme$/);
```

改为：

```ts
  await expect(page).toHaveURL(/\/acme\/overview$/);
```

Run: `pnpm --filter @flower/web e2e workbench.spec.ts overview.spec.ts`
Expected: FAIL，`/acme` 仍是概览页，没有「工作台」标题。

- [ ] **Step 4: 移动概览页并处理加载状态**

```bash
mkdir -p "apps/web/src/app/(app)/[org]/overview"
git mv "apps/web/src/app/(app)/[org]/page.tsx" "apps/web/src/app/(app)/[org]/overview/page.tsx"
```

`apps/web/src/app/(app)/[org]/overview/page.tsx`：

1. import 区加入：

```ts
import { LoadError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
```

2. 产品列表部分

```tsx
        {products.data && products.data.length === 0 ? (
          <p className="text-muted-foreground">还没有产品。</p>
        ) : (
          <ul className="grid grid-cols-3 gap-3">
            {products.data?.map((p) => (
```

改为（加载中显示骨架，失败显示重试，不再先渲染一个空网格）：

```tsx
        {!products.data ? (
          products.isError ? (
            <LoadError message="加载产品失败，请重试。" onRetry={() => products.refetch()} />
          ) : (
            <Skeleton className="h-16" />
          )
        ) : products.data.length === 0 ? (
          <p className="text-muted-foreground">还没有产品。</p>
        ) : (
          <ul className="grid grid-cols-3 gap-3">
            {products.data.map((p) => (
```

`apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx` 中面包屑

```tsx
            : [{ label: '概览', href: `/${org}` }, { label: '产品设置' }, { label: p.name }]
```

改为：

```tsx
            : [{ label: '概览', href: `/${org}/overview` }, { label: '产品设置' }, { label: p.name }]
```

- [ ] **Step 5: 实现工作台页面**

`apps/web/src/app/(app)/[org]/page.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { type ReactNode, useId } from 'react';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { requirementHref, showOrgBadge, taskHref } from '@/features/workbench/model';
import { useWorkbench } from '@/lib/queries';
import type { Workbench } from '@/lib/types';

const ROW = 'flex h-10 items-center gap-3 px-4 text-[13px] hover:bg-muted';

function Section({ title, total, shown, empty, children }: { title: string; total: number; shown: number; empty: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col rounded-lg border bg-card">
      <h2 id={id} className="flex items-center justify-between border-b px-4 py-2.5 font-semibold">
        {title}
        <span className="font-mono text-xs font-normal text-muted-foreground">{total}</span>
      </h2>
      {total === 0 ? <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{empty}</p> : <ul className="divide-y">{children}</ul>}
      {total > shown && <p className="border-t px-4 py-2 text-xs text-muted-foreground">只显示前 {shown} 条</p>}
    </section>
  );
}

function OrgBadge({ show, name }: { show: boolean; name: string }) {
  return show ? <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{name}</span> : null;
}

function Sections({ data }: { data: Workbench }) {
  const badge = showOrgBadge(data.orgs);
  return (
    <div className="grid grid-cols-2 gap-4">
      <Section title="我负责的需求" total={data.owned.total} shown={data.owned.items.length} empty="没有进行中的需求">
        {data.owned.items.map((r) => (
          <li key={r.id}>
            <Link href={requirementHref(r.org, r.displayKey)} className={ROW}>
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
      <Section title="我的任务" total={data.tasks.total} shown={data.tasks.items.length} empty="没有未完成的任务">
        {data.tasks.items.map((t) => (
          <li key={t.id}>
            <Link href={taskHref(t)} className={ROW}>
              <OrgBadge show={badge} name={t.org.name} />
              <span className="flex-1 truncate">{t.title}</span>
              {t.requirement && <span className="font-mono text-xs text-muted-foreground">{t.requirement.displayKey}</span>}
              {t.iteration && <span className="text-xs text-muted-foreground">{t.iteration.name}</span>}
              <span className="font-mono text-xs text-muted-foreground">{t.planStart ?? '未排期'}</span>
              <span className="w-10 text-right font-mono text-xs">{t.progress}%</span>
            </Link>
          </li>
        ))}
      </Section>
      <Section title="等我签字" total={data.signatures.total} shown={data.signatures.items.length} empty="没有等你签字的检查项">
        {data.signatures.items.map((s) => (
          <li key={`${s.requirementId}-${s.itemKey}-${s.ruleIndex}`}>
            <Link href={requirementHref(s.org, s.displayKey)} className={ROW}>
              <OrgBadge show={badge} name={s.org.name} />
              <span className="font-mono text-muted-foreground">{s.displayKey}</span>
              <span className="flex-1 truncate">{s.title}</span>
              <span className="text-xs">{s.itemLabel}</span>
              {s.onBehalfOf && <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">代 {s.onBehalfOf}</span>}
            </Link>
          </li>
        ))}
      </Section>
      <Section title="未读评论" total={data.unread.total} shown={data.unread.items.length} empty="你负责的需求上没有未读评论">
        {data.unread.items.map((u) => (
          <li key={u.requirementId}>
            <Link href={requirementHref(u.org, u.displayKey)} className={ROW}>
              <OrgBadge show={badge} name={u.org.name} />
              <span className="font-mono text-muted-foreground">{u.displayKey}</span>
              <span className="flex-1 truncate">{u.title}</span>
              <span className="text-xs text-primary">{u.unread} 条未读</span>
            </Link>
          </li>
        ))}
      </Section>
    </div>
  );
}

export default function WorkbenchPage() {
  const q = useWorkbench();
  let body: ReactNode;
  if (q.data) body = <Sections data={q.data} />;
  else if (q.isError) body = <QueryError error={q.error} noAccessMessage="无法读取工作台。" retryMessage="加载工作台失败，请重试。" onRetry={() => q.refetch()} />;
  else body = <Skeleton className="h-64" />;
  return (
    <>
      <PageHeader title="工作台" description="汇总你在所有组织里负责的需求、指派给你的任务、等你签字的检查项和未读评论。" />
      {body}
    </>
  );
}
```

`apps/web/src/app/(app)/page.tsx` 整个替换为（有组织时跳到第一个组织的工作台；组织切换器仍可切换与新建组织）：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CreateOrgDialog } from '@/components/create-org-dialog';
import { PlainShell } from '@/components/plain-shell';
import { Button } from '@/components/ui/button';
import { useMe, useSetupStatus } from '@/lib/queries';

export default function HomePage() {
  const router = useRouter();
  const me = useMe();
  const setup = useSetupStatus();
  const [creating, setCreating] = useState(false);
  const canCreate = Boolean(me.data?.account.isInstanceAdmin || setup.data?.allowOrgCreation);
  const firstSlug = me.data?.orgs[0]?.slug ?? null;

  useEffect(() => {
    if (firstSlug) router.replace(`/${firstSlug}`);
  }, [firstSlug, router]);

  if (firstSlug) return null;
  return (
    <PlainShell>
      <div className="flex items-end justify-between">
        <h1 className="text-xl font-semibold">我的组织</h1>
        {canCreate && <Button onClick={() => setCreating(true)}>新建组织</Button>}
      </div>
      <p className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
        你还没有加入任何组织。{canCreate ? '可以新建一个组织，或' : ''}请向组织管理员索取邀请链接。
      </p>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </PlainShell>
  );
}
```

- [ ] **Step 6: 运行测试确认通过**

Run（端到端在后台运行并写日志）：

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web test
pnpm --filter @flower/web e2e workbench.spec.ts overview.spec.ts acceptance.spec.ts product-admin.spec.ts auth.spec.ts requirements.spec.ts iterations.spec.ts
```

Expected: 全部 PASS。`auth.spec.ts`、`requirements.spec.ts`、`iterations.spec.ts` 在登录后落到工作台，再点侧边导航；工作台在这些用例里没有数据，不会出现名称含「需求」「迭代」的链接。

- [ ] **Step 7: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/page.tsx" "apps/web/src/app/(app)/[org]/overview" "apps/web/src/app/(app)/page.tsx" "apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx" apps/web/src/features/workbench apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/features/shell/nav.ts apps/web/src/features/shell/nav.test.ts apps/web/src/components/org-shell.tsx apps/web/e2e/workbench.spec.ts apps/web/e2e/overview.spec.ts apps/web/e2e/acceptance.spec.ts apps/web/e2e/product-admin.spec.ts
git commit -m "feat(web): 登录后进入跨组织工作台，概览页移到 /[org]/overview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 13: 需求分配的新增与删除

「等我签字」按 `requirement_assignments` 推送（Task 5），但目前没有任何界面或接口能维护这张表：P1-A 只在迁移时写入（`plan-requirements.ts` 只生成「开发」标签的分配），需求详情侧栏只读显示「开发分配」。本任务补上新增与删除。

唯一约束：`requirement_assignments` 现在只有 `requirement_assignments_requirement`、`requirement_assignments_member` 两个普通索引，没有唯一约束，服务层无法可靠地拦住重复分配。本任务新增唯一约束 `requirement_assignments_unique`（`requirement_id, member_id, function_tag_id, platform_option_id`，`NULLS NOT DISTINCT`，与 `structure_nodes_parent_name` 写法一致），由 `db:generate` 生成新迁移 `0008_*.sql`。2026-09-30 检查开发库：按这四列分组后没有重复行（0 组，含 pan123 的 143 条），迁移可以直接执行；迁移脚本自身按需求、成员、平台去重写入，标签固定为「开发」，重导不会产生重复。

**Files:**
- Modify: `packages/core/src/db/schema.ts`（`requirementAssignments` 增加唯一约束）
- Create: `packages/core/migrations/0008_*.sql` 与 `packages/core/migrations/meta/`（由 `db:generate` 生成）
- Create: `packages/core/src/requirements/assignments.ts`
- Modify: `packages/core/src/requirements/detail.ts`（`assignments[]` 增加 `id`）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/assignments.test.ts`
- Modify: `apps/web/src/server/routes/requirements.ts`（新增、删除分配的路由）
- Test: `apps/web/test/api/assignments.test.ts`
- Modify: `apps/web/src/lib/queries.ts`（`useFunctionTags` 增加 `enabled` 参数，默认 `true`，现有调用不变）
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/assignments.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/side-lists.tsx`（去掉只读的「开发分配」块）
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`（渲染 `Assignments`）
- Test: `apps/web/e2e/requirement-assignments.spec.ts`

**Interfaces:**
- Consumes: `requireProductRole`、`loadRequirement`、`effectiveFields`（`requirements/context.ts`）、`isUniqueViolation`、`recordEvent`；Task 5 的 `listReviewQueue`、`reviewWorkflow`（测试）；Task 9 的 `qk.workbench`；`canListMembers`、`activePeople`；`useFields`、`useMembers`、`useOrg`、`requirementKeys`
- Produces（`requirements/assignments.ts`）：
  - `type AssignmentInput = { memberId: string; functionTagId: string; platformOptionId?: string | null }`
  - `addRequirementAssignment(db, actor, requirementId: string, input: AssignmentInput): Promise<{ id: string }>`
  - `removeRequirementAssignment(db, actor, assignmentId: string): Promise<void>`
- Produces（`requirements/detail.ts`）：`RequirementDetail['assignments'][number]` 增加 `id: string`
- 事件：`requirement.assignment_added`、`requirement.assignment_removed`，`subjectType = 'requirement'`，payload `{ assignmentId, changes: [{ field: 'assignments', old, new }] }`，`old` / `new` 为 `{ memberId, functionTagId, platformOptionId }` 或 `null`
- 错误：`invalid`「只能分配给在职成员」「职能标签不存在」「平台选项不属于本产品的「平台」字段」；`conflict`「已经有相同的分配」；`not_found`「分配不存在」；只读成员与只读 Token 在 `requireProductRole(…, 'editor')` 处得到 `forbidden`
- Produces（HTTP）：`POST /orgs/:org/requirements/:id/assignments`（`{ memberId, functionTagId, platformOptionId? }` → `201 { assignment: { id } }`）；`DELETE /orgs/:org/assignments/:id` → `204`

- [ ] **Step 1: 写失败的 core 测试**

`packages/core/test/assignments.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addFieldOption, listFields } from '../src/definitions/fields';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { addRequirementAssignment, removeRequirementAssignment } from '../src/requirements/assignments';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { setCheckItemState } from '../src/requirements/transitions';
import { listReviewQueue } from '../src/reviews/queue';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createPlaceholderMember, setMemberFunctionTags, updateMember } from '../src/tenancy/members';
import { createOrganization, resolveActor } from '../src/tenancy/orgs';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, reviewWorkflow, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let designerA: Actor;
let designerB: Actor;
let viewer: Actor;
let pan: string;
let designTag: string;
let pc: string;
let priorityOption: string;
let otherOrgTag: string;
let reqId: string;

const eventsOf = (subjectId: string, type: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, subjectId), eq(domainEvents.type, type))));

beforeAll(async () => {
  t = await createTestDb();
  const seeded = await seedInstance(t.db);
  owner = seeded.owner;
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  designerA = await asMember(t.db, owner, '设计师甲');
  designerB = await asMember(t.db, owner, '设计师乙');
  await setMemberFunctionTags(t.db, owner, designerA.memberId, [designTag]);
  await setMemberFunctionTags(t.db, owner, designerB.memberId, [designTag]);
  const boss = await asMember(t.db, owner, '老板丙');
  viewer = await asMember(t.db, owner, '只读丁');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  const { version } = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  const fields = await listFields(t.db, owner);
  pc = (await addFieldOption(t.db, owner, fields.find((f) => f.key === 'platform')!.id, { label: 'PC客户端' })).id;
  priorityOption = fields.find((f) => f.key === 'priority')!.options[0]!.id;
  await createOrganization(t.db, seeded.account, { name: '第二组织', slug: 'other' });
  const otherActor = (await resolveActor(t.db, seeded.account.id, 'other'))!;
  otherOrgTag = (await listFunctionTags(t.db, otherActor))[0]!.id;
  reqId = (await createRequirement(t.db, owner, pan, { title: '上传提速' })).id;
});
afterAll(() => t.cleanup());

describe('需求分配', () => {
  it('编辑者新增分配并写事件；需求详情带分配 id；完全相同的分配返回冲突，平台不同不算重复', async () => {
    const a = await addRequirementAssignment(t.db, owner, reqId, { memberId: designerA.memberId, functionTagId: designTag });
    const [e] = await eventsOf(reqId, 'requirement.assignment_added');
    expect(e!.payload).toMatchObject({
      assignmentId: a.id,
      changes: [{ field: 'assignments', old: null, new: { memberId: designerA.memberId, functionTagId: designTag, platformOptionId: null } }],
    });
    await expect(addRequirementAssignment(t.db, owner, reqId, { memberId: designerA.memberId, functionTagId: designTag })).rejects.toMatchObject({
      code: 'conflict',
      message: '已经有相同的分配',
    });
    await addRequirementAssignment(t.db, owner, reqId, { memberId: designerA.memberId, functionTagId: designTag, platformOptionId: pc });
    await expect(
      addRequirementAssignment(t.db, owner, reqId, { memberId: designerA.memberId, functionTagId: designTag, platformOptionId: pc }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const detail = await getRequirementByKey(t.db, owner, 'PAN-1');
    expect(detail.assignments).toContainEqual({ id: a.id, member: { id: designerA.memberId, displayName: '设计师甲' }, functionTag: { id: designTag, name: '设计' }, platform: null });
  });

  it('校验：离职成员、其他组织的职能标签、不属于「平台」字段的选项', async () => {
    const left = await createPlaceholderMember(t.db, owner, { displayName: '离职戊' });
    await updateMember(t.db, owner, left.id, { status: 'left' });
    await expect(addRequirementAssignment(t.db, owner, reqId, { memberId: left.id, functionTagId: designTag })).rejects.toMatchObject({
      code: 'invalid',
      message: '只能分配给在职成员',
    });
    await expect(addRequirementAssignment(t.db, owner, reqId, { memberId: designerB.memberId, functionTagId: otherOrgTag })).rejects.toMatchObject({
      code: 'invalid',
      message: '职能标签不存在',
    });
    await expect(
      addRequirementAssignment(t.db, owner, reqId, { memberId: designerB.memberId, functionTagId: designTag, platformOptionId: priorityOption }),
    ).rejects.toMatchObject({ code: 'invalid', message: '平台选项不属于本产品的「平台」字段' });
  });

  it('只读成员与只读 Token 不能新增或删除；看不到产品的访客得到 404', async () => {
    const a = await addRequirementAssignment(t.db, owner, reqId, { memberId: designerB.memberId, functionTagId: designTag });
    for (const who of [viewer, readOnlyToken(owner)]) {
      await expect(addRequirementAssignment(t.db, who, reqId, { memberId: designerB.memberId, functionTagId: designTag, platformOptionId: pc })).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(removeRequirementAssignment(t.db, who, a.id)).rejects.toMatchObject({ code: 'forbidden' });
    }
    const guest = await asMember(t.db, owner, '访客己', 'guest');
    await expect(removeRequirementAssignment(t.db, guest, a.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('删除分配并写事件；再次删除返回 404', async () => {
    const a = await addRequirementAssignment(t.db, owner, reqId, { memberId: designerB.memberId, functionTagId: designTag, platformOptionId: pc });
    await removeRequirementAssignment(t.db, owner, a.id);
    const removed = (await eventsOf(reqId, 'requirement.assignment_removed')).find((x) => x.payload.assignmentId === a.id);
    expect(removed!.payload.changes).toEqual([
      { field: 'assignments', old: { memberId: designerB.memberId, functionTagId: designTag, platformOptionId: pc }, new: null },
    ]);
    await expect(removeRequirementAssignment(t.db, owner, a.id)).rejects.toMatchObject({ code: 'not_found', message: '分配不存在' });
  });

  it('分配设计后，「等我签字」只推给被分配的设计；删除分配后回到推给全部设计', async () => {
    const r = (await createRequirement(t.db, owner, pan, { title: '分享统计' })).id; // PAN-2
    await setCheckItemState(t.db, owner, r, 'feasibility', { state: 'passed' });
    const waiting = async (who: Actor) => (await listReviewQueue(t.db, who, pan, { waitingForMe: true })).rows.map((x) => x.displayKey);
    expect(await waiting(designerA)).toContain('PAN-2');
    expect(await waiting(designerB)).toContain('PAN-2');
    const a = await addRequirementAssignment(t.db, owner, r, { memberId: designerA.memberId, functionTagId: designTag });
    expect(await waiting(designerA)).toContain('PAN-2');
    expect(await waiting(designerB)).not.toContain('PAN-2');
    await removeRequirementAssignment(t.db, owner, a.id);
    expect(await waiting(designerB)).toContain('PAN-2');
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/assignments.test.ts`
Expected: FAIL，找不到模块 `../src/requirements/assignments`。

- [ ] **Step 2: 加唯一约束并生成迁移**

`packages/core/src/db/schema.ts` 中 `requirementAssignments` 的第三个参数改为：

```ts
  (t) => [
    index('requirement_assignments_requirement').on(t.requirementId),
    index('requirement_assignments_member').on(t.memberId),
    unique('requirement_assignments_unique').on(t.requirementId, t.memberId, t.functionTagId, t.platformOptionId).nullsNotDistinct(),
  ],
```

Run: `pnpm --filter @flower/core db:generate`
Expected: 生成 `packages/core/migrations/0008_<随机名>.sql`，内容只有一行：

```sql
ALTER TABLE "requirement_assignments" ADD CONSTRAINT "requirement_assignments_unique" UNIQUE NULLS NOT DISTINCT("requirement_id","member_id","function_tag_id","platform_option_id");
```

并更新 `migrations/meta/_journal.json`、新增 `migrations/meta/0008_snapshot.json`。内容不是这一行时停下来报告。

- [ ] **Step 3: 实现服务**

`packages/core/src/requirements/assignments.ts`：

```ts
import { eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { functionTags, members, requirementAssignments, requirements } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { effectiveFields, loadRequirement } from './context';

export type AssignmentInput = { memberId: string; functionTagId: string; platformOptionId?: string | null };

type AssignmentRow = typeof requirementAssignments.$inferSelect;
const snapshot = (a: Pick<AssignmentRow, 'memberId' | 'functionTagId' | 'platformOptionId'>) => ({
  memberId: a.memberId,
  functionTagId: a.functionTagId,
  platformOptionId: a.platformOptionId,
});

/** 给需求分配某职能的负责成员（可限定平台）。分配决定会签检查项的「等我签字」推给谁。 */
export async function addRequirementAssignment(db: Db, actor: Actor, requirementId: string, input: AssignmentInput): Promise<{ id: string }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'editor');
    const [member] = await tx.select({ status: members.status }).from(members).where(eq(members.id, input.memberId));
    if (!member || member.status !== 'active') throw new AppError('invalid', '只能分配给在职成员');
    const [tag] = await tx.select({ id: functionTags.id }).from(functionTags).where(eq(functionTags.id, input.functionTagId));
    if (!tag) throw new AppError('invalid', '职能标签不存在');
    const platformOptionId = input.platformOptionId ?? null;
    if (platformOptionId) {
      const platform = (await effectiveFields(tx, req.productId)).get('platform');
      if (!platform?.options.some((o) => o.id === platformOptionId)) throw new AppError('invalid', '平台选项不属于本产品的「平台」字段');
    }
    let row: AssignmentRow;
    try {
      [row] = (await tx
        .insert(requirementAssignments)
        .values({ orgId: actor.orgId, requirementId, memberId: input.memberId, functionTagId: input.functionTagId, platformOptionId })
        .returning()) as [AssignmentRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已经有相同的分配');
      throw e;
    }
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: req.productId,
      type: 'requirement.assignment_added',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { assignmentId: row.id, changes: [{ field: 'assignments', old: null, new: snapshot(row) }] },
    });
    return { id: row.id };
  });
}

export async function removeRequirementAssignment(db: Db, actor: Actor, assignmentId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(requirementAssignments).where(eq(requirementAssignments.id, assignmentId)).for('update');
    if (!cur) throw new AppError('not_found', '分配不存在');
    const req = await loadRequirement(tx, cur.requirementId);
    await requireProductRole(tx, actor, req.productId, 'editor');
    await tx.delete(requirementAssignments).where(eq(requirementAssignments.id, assignmentId));
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, req.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: req.productId,
      type: 'requirement.assignment_removed',
      subjectType: 'requirement',
      subjectId: req.id,
      actor,
      payload: { assignmentId, changes: [{ field: 'assignments', old: snapshot(cur), new: null }] },
    });
  });
}
```

`packages/core/src/requirements/detail.ts`：

1. `RequirementDetail` 类型中

```ts
  assignments: Array<{ member: MemberRef; functionTag: { id: string; name: string } | null; platform: OptionRef | null }>;
```

改为：

```ts
  assignments: Array<{ id: string; member: MemberRef; functionTag: { id: string; name: string } | null; platform: OptionRef | null }>;
```

2. 返回值中 `assignments: assignments.map((a) => ({` 下一行加入 `id: a.id,`：

```ts
      assignments: assignments.map((a) => ({
        id: a.id,
        member: ref(a.memberId)!,
```

`packages/core/src/index.ts` 在 `export * from './requirements/relations';` 之后加入：

```ts
export * from './requirements/assignments';
```

Run: `pnpm --filter @flower/core exec vitest run test/assignments.test.ts test/requirement-workflow.test.ts test/review-queue.test.ts` 与 `pnpm typecheck`
Expected: PASS（测试库由 global-setup 按迁移目录重建，包含新约束）。

- [ ] **Step 4: 路由与接口测试**

`apps/web/test/api/assignments.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let memberId: string;
let readToken: string;

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  memberId = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
});
afterAll(() => cleanup());

describe('需求分配接口', () => {
  it('新增返回 201，重复返回 409，详情带分配 id，删除返回 204；只读 Token 返回 403', async () => {
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '上传提速' } })).body.requirement;
    const tags = (await call(app, 'GET', '/orgs/acme/function-tags', { session })).body.tags as Array<{ id: string; name: string }>;
    const design = tags.find((x) => x.name === '设计')!.id;
    const body = { memberId, functionTagId: design };
    const created = await call(app, 'POST', `/orgs/acme/requirements/${req.id}/assignments`, { session, body });
    expect(created.status).toBe(201);
    const dup = await call(app, 'POST', `/orgs/acme/requirements/${req.id}/assignments`, { session, body });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('已经有相同的分配');
    const detail = (await call(app, 'GET', `/orgs/acme/requirements/${req.displayKey}`, { session })).body.requirement;
    expect(detail.assignments).toMatchObject([{ id: created.body.assignment.id, functionTag: { name: '设计' } }]);
    expect((await call(app, 'POST', `/orgs/acme/requirements/${req.id}/assignments`, { token: readToken, body })).status).toBe(403);
    expect((await call(app, 'DELETE', `/orgs/acme/assignments/${created.body.assignment.id}`, { token: readToken })).status).toBe(403);
    expect((await call(app, 'DELETE', `/orgs/acme/assignments/${created.body.assignment.id}`, { session })).status).toBe(204);
  });
});
```

`apps/web/src/server/routes/requirements.ts`：

1. `@flower/core` 的 import 列表加入 `addRequirementAssignment`、`removeRequirementAssignment`（按字母顺序）。
2. `registerRequirementRoutes` 末尾（`app.delete('/orgs/:org/relations/:id', …)` 之后）加入：

```ts
  app.post('/orgs/:org/requirements/:id/assignments', async (c) => {
    const body = await readJson(c, z.object({ memberId: z.string(), functionTagId: z.string(), platformOptionId: z.string().nullable().optional() }));
    return c.json({ assignment: await addRequirementAssignment(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.delete('/orgs/:org/assignments/:id', async (c) => {
    await removeRequirementAssignment(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });
```

Run: `pnpm --filter @flower/web exec vitest run test/api/assignments.test.ts`
Expected: PASS。

- [ ] **Step 5: 写失败的端到端测试**

`apps/web/e2e/requirement-assignments.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求详情：新增与删除分配，重复时在表单里提示', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  await json(request.post('/api/v1/orgs/acme/members', { data: { displayName: '设计师甲' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const section = page.getByRole('region', { name: '分配', exact: true });
  await expect(section).toContainText('还没有分配');

  const pick = async (combobox: string, option: string) => {
    await section.getByRole('combobox', { name: combobox }).click();
    await page.getByRole('option', { name: option }).click();
  };
  await pick('分配职能', '设计');
  await pick('分配成员', '设计师甲');
  await section.getByRole('button', { name: '添加分配' }).click();
  await expect(page.getByText('已添加分配')).toBeVisible();
  await expect(section).toContainText('设计师甲 · 设计');

  await pick('分配成员', '设计师甲');
  await section.getByRole('button', { name: '添加分配' }).click();
  await expect(section.getByRole('alert').filter({ hasText: '已经有相同的分配' })).toBeVisible();

  await section.getByRole('button', { name: '删除分配：设计师甲 · 设计' }).click();
  await expect(page.getByText('已删除分配')).toBeVisible();
  await expect(section).toContainText('还没有分配');
});

test('需求详情：只读成员能看到分配，但没有新增和删除', async ({ request, browser }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  const designer = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '设计师甲' } }))).member.id;
  const tags = (await json<{ tags: Array<{ id: string; name: string }> }>(request.get('/api/v1/orgs/acme/function-tags'))).tags;
  await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/assignments`, { data: { memberId: designer, functionTagId: tags.find((x) => x.name === '设计')!.id } }));
  const { token } = await json<{ token: string }>(request.post('/api/v1/orgs/acme/invitations', { data: { email: 'viewer@example.com', orgRole: 'member' } }));

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/invite/${token}`);
  await page.getByLabel('你的姓名').fill('只读成员');
  await page.getByLabel('设置密码').fill('password123');
  await page.getByRole('button', { name: '接受邀请' }).click();
  await page.waitForURL('**/acme');
  const members = (await json<{ members: Array<{ id: string; email: string | null }> }>(request.get('/api/v1/orgs/acme/members'))).members;
  const viewerId = members.find((m) => m.email === 'viewer@example.com')!.id;
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));

  await page.goto(`/acme/requirements/${req.displayKey}`);
  const section = page.getByRole('region', { name: '分配', exact: true });
  await expect(section).toContainText('设计师甲 · 设计');
  await expect(section.getByRole('button', { name: '添加分配' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: /删除分配/ })).toHaveCount(0);
  await ctx.close();
});
```

Run: `pnpm --filter @flower/web e2e requirement-assignments.spec.ts`
Expected: FAIL，需求详情没有「分配」区块。

- [ ] **Step 6: 实现分配区块**

`apps/web/src/lib/queries.ts` 中 `useFunctionTags` 改为（访客不能读取职能标签，用 `enabled` 跳过请求）：

```ts
export const useFunctionTags = (o: string, enabled = true) =>
  useQuery({ queryKey: qk.tags(o), queryFn: () => api<{ tags: FunctionTag[] }>(`/orgs/${o}/function-tags`), select: (d) => d.tags, enabled });
```

`apps/web/src/app/(app)/[org]/requirements/[key]/assignments.tsx`：

```tsx
'use client';

import { X } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { activePeople, canListMembers } from '@/features/members/model';
import { api } from '@/lib/api';
import { qk, requirementKeys, useApiMutation, useFields, useFunctionTags, useMembers, useOrg } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';

const NONE = 'none';

/** 需求的分配：某职能由谁负责（可限定平台）。会签检查项的「等我签字」按这里的分配推送。 */
export function Assignments({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const orgQ = useOrg(org);
  // 选择成员和职能标签需要读取成员列表，访客读不到，因此访客只读
  const canEdit = r.myRole !== 'viewer' && canListMembers(orgQ.data?.me);
  const members = useMembers(org, canEdit);
  const tags = useFunctionTags(org, canEdit);
  const fields = useFields(org, r.productId, canEdit);
  const platformOptions = (fields.data?.find((f) => f.key === 'platform')?.options ?? []).filter((o) => o.active);
  const [tagId, setTagId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [platformId, setPlatformId] = useState(NONE);
  // 分配改变「等我签字」的推送对象：刷新需求详情、评审表（都在 requirementKeys 下）和工作台
  const invalidate = [requirementKeys(org), qk.workbench];
  const add = useApiMutation(
    () =>
      api(`/orgs/${org}/requirements/${r.id}/assignments`, {
        method: 'POST',
        body: { memberId, functionTagId: tagId, platformOptionId: platformId === NONE ? null : platformId },
      }),
    {
      invalidate,
      silentError: true,
      success: '已添加分配',
      onSuccess: () => {
        setMemberId('');
        setPlatformId(NONE);
      },
    },
  );
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/assignments/${id}`, { method: 'DELETE' }), {
    invalidate,
    silentError: true,
    success: '已删除分配',
    onSuccess: () => add.reset(),
  });
  if (!canEdit && r.assignments.length === 0) return null;

  return (
    <section className="rounded-md border bg-card p-4" aria-label="分配">
      <h2 className="mb-2 text-sm font-semibold">分配</h2>
      {r.assignments.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有分配</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {r.assignments.map((a) => {
            const label = [a.member.displayName, a.functionTag?.name, a.platform?.label].filter(Boolean).join(' · ');
            return (
              <li key={a.id} className="flex items-center gap-2">
                <span className="flex-1">{label}</span>
                {canEdit && (
                  <Button variant="ghost" size="icon-xs" aria-label={`删除分配：${label}`} disabled={remove.isPending} onClick={() => remove.mutate(a.id)}>
                    <X aria-hidden="true" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <form
          className="mt-3 flex flex-col gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined);
          }}
        >
          <Select value={tagId || undefined} onValueChange={setTagId}>
            <SelectTrigger className="h-8" aria-label="分配职能">
              <SelectValue placeholder="选择职能" />
            </SelectTrigger>
            <SelectContent>
              {(tags.data ?? []).map((tag) => (
                <SelectItem key={tag.id} value={tag.id}>
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={memberId || undefined} onValueChange={setMemberId}>
            <SelectTrigger className="h-8" aria-label="分配成员">
              <SelectValue placeholder="选择成员" />
            </SelectTrigger>
            <SelectContent>
              {activePeople(members.data ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {platformOptions.length > 0 && (
            <Select value={platformId} onValueChange={setPlatformId}>
              <SelectTrigger className="h-8" aria-label="分配平台">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>不限平台</SelectItem>
                {platformOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button type="submit" size="sm" variant="outline" disabled={!tagId || !memberId || add.isPending}>
            添加分配
          </Button>
          <FormError error={add.error ?? remove.error} />
        </form>
      )}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/requirements/[key]/side-lists.tsx`：删除 `{r.assignments.length > 0 && ( <Block title="开发分配"> … </Block> )}` 整段（分配改由 `Assignments` 显示），其余不变。

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：

1. `import { Relations } from './relations';` 之前加入 `import { Assignments } from './assignments';`。
2. 把 `<SideLists requirement={r} />` 改为：

```tsx
          <Assignments org={org} requirement={r} />
          <SideLists requirement={r} />
```

- [ ] **Step 7: 运行测试确认通过**

Run（端到端在后台运行并写日志）：

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/core test
pnpm --filter @flower/web test
pnpm --filter @flower/web e2e requirement-assignments.spec.ts requirements.spec.ts requirement-maintenance.spec.ts reviews.spec.ts
```

Expected: 全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/db/schema.ts packages/core/migrations packages/core/src/requirements/assignments.ts packages/core/src/requirements/detail.ts packages/core/src/index.ts packages/core/test/assignments.test.ts apps/web/src/server/routes/requirements.ts apps/web/test/api/assignments.test.ts apps/web/src/lib/queries.ts "apps/web/src/app/(app)/[org]/requirements/[key]" apps/web/e2e/requirement-assignments.spec.ts
git commit -m "feat: 需求分配的新增与删除，分配决定会签的待签推送对象

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: 日常操作新旧对比文档

**Files:**
- Create: `docs/p1b-comparison.md`

**Interfaces:**
- Consumes: Task 9–13 的页面与端到端用例；旧系统源码（只读）：`/Users/silas/Documents/123plane`、`/Users/silas/code/wecom-push`
- Produces: `docs/p1b-comparison.md`（8 项日常操作的旧步骤、Flower 步骤、结论与验证用例），Task 15 的用户试用脚本引用它

步数的计法：从登录后的落地页开始，数用户的点击、输入和确认（一次输入算一步，下拉框「点开 + 选中」算两步），不数页面加载。旧系统的步骤按下表列出的源码核对；Flower 的步骤按页面代码核对，并用端到端用例实际跑一遍。

- [ ] **Step 1: 核对旧系统的操作路径**

逐项打开下列文件，确认 Step 3 表格「旧系统步骤」一列与代码一致；不一致时以代码为准改表格：

| 操作 | 旧系统 | 源码 |
|---|---|---|
| 新建需求 | 123plane | `src/app/(dashboard)/board/page.tsx`（「新建需求」按钮）、`src/components/shared/create-requirement-dialog.tsx`（标题、提出人必填） |
| 已通过需求拉入版本 | push | `frontend/src/pages/Versions.tsx`（版本列表 → 版本详情 →「拉已通过评审的需求…」下拉 →「拉入」） |
| 设计项签字 | push | `frontend/src/pages/ReviewGate.tsx`（点行展开 → 环节「通过」；代签对象由界面自动写「代 × by 我」） |
| 记录卡点 | 123plane | `src/components/detail/detail-blockers.tsx`（「记录卡点」→ 输入 → 回车） |
| 更新甘特进度 | push | `frontend/src/pages/Versions.tsx`（版本详情 → 进度滑块，松手保存） |
| 查看某人负载 | push | `frontend/src/components/Heatmap.tsx`（只在单个版本详情里显示） |
| 找我待签的 | push | `frontend/src/pages/ReviewGate.tsx`（筛选只有线条、负责人、状态，没有「待我签」） |
| 发布版本 | 123plane | `src/components/versions/version-list.tsx`（行上「发布」图标 → 浏览器确认框） |

- [ ] **Step 2: 用端到端用例跑一遍 Flower 的操作路径**

Run（后台运行并写日志；不要与 `pnpm dev` 同时运行）：

```bash
pnpm --filter @flower/web e2e requirements.spec.ts iterations.spec.ts requirement-maintenance.spec.ts reviews.spec.ts gantt.spec.ts workload.spec.ts workbench.spec.ts
```

Expected: 全部 PASS。对照 Step 3 表格「验证用例」一列，确认每项 Flower 步骤都在对应用例里出现；用例里的点击顺序与表格不一致时，以页面实际操作为准改表格。

- [ ] **Step 3: 写对比文档**

`docs/p1b-comparison.md`：

```markdown
# P1-B 日常操作新旧对比

对比 123plane / push 与 Flower 完成 8 项日常操作所需的步骤。步数从登录后的落地页开始计：一次点击、一次输入、一次确认各算一步，下拉框「点开 + 选中」算两步，不计页面加载。旧系统的路径按源码核对（文件见 P1-B2 计划 Task 14），Flower 的路径按页面代码核对，并由「验证用例」一列的端到端用例实际执行。

| # | 操作 | 旧系统步骤 | 旧步数 | Flower 步骤 | Flower 步数 | 结论 | 验证用例 |
|---|---|---|---|---|---|---|---|
| 1 | 新建需求 | 123plane：看板「新建需求」→ 填标题 → 点开「提出人」→ 选人（必填）→「创建」 | 5 | 侧边导航「需求」→「新建需求」→ 填标题 →「创建」（提出人、优先级、平台可选） | 4 | 少 1 步；提出人改为可选 | `requirements.spec.ts`「需求列表：新建、按状态和优先级筛选、搜索编号」 |
| 2 | 已通过需求拉入版本 / 迭代 | push：版本页点版本 → 点开「拉已通过评审的需求…」→ 选需求 →「拉入」 | 4 | 侧边导航「迭代」→ 点迭代 → 在「添加需求」框输入编号或标题 →「加入」 | 4 | 步数相同；条件不满足时直接给出原因，产品管理员可以带原因强制加入 | `iterations.spec.ts`「迭代详情：添加需求、准入条件不满足时强制加入…」 |
| 3 | 设计项签字 | push：评审页点需求行展开 → 对应环节「通过」 | 2 | 工作台「等我签字」点行 → 需求详情「通过」；或 侧边导航「评审」→ 展开 →「通过」 | 2 / 3 | 从工作台进入步数相同；签字项按流程配置，不再写死 7 项 | `workbench.spec.ts`、`reviews.spec.ts` |
| 4 | 记录卡点（阻塞项） | 123plane：打开需求 →「记录卡点」→ 输入 → 回车 | 4 | 打开需求 → 在「新阻塞项」框输入 →「添加」（负责人可选） | 3 | 少 1 步 | `requirement-maintenance.spec.ts`「需求详情：新增与解除阻塞项…」 |
| 5 | 更新甘特进度 | push：版本页点版本 → 拖动进度滑块（松手保存） | 2 | 侧边导航「迭代」→ 点迭代 →「甘特」页签 → 改进度 → 离开输入框保存 | 5 | 多 3 步；工作台「我的任务」里没挂需求的任务可直接进甘特页签。列入用户试用观察项 | `gantt.spec.ts`「甘特页签：失焦保存别名与进度…」 |
| 6 | 查看某人负载 | push：版本页点版本 → 看热力图对应行（只含当前版本） | 1 | 侧边导航「迭代」→「人员负载」→ 点开「选择成员」→ 选人（跨全部未结束的迭代） | 4 | 多 3 步，但可以跨迭代看；从甘特热力图点姓名也能进入 | `workload.spec.ts` |
| 7 | 找到我待签的 | push：评审页逐条展开查看，没有「待我签」筛选 | 按需求数逐条展开 | 登录即见工作台「等我签字」 | 0 | 不再需要逐条查找 | `workbench.spec.ts`「登录后进入工作台…」 |
| 8 | 发布版本 | 123plane：版本页行上「发布」图标 → 确认 | 2 | 侧边导航「迭代」→ 点迭代 →「发布版本」页签 →「标记发布」→ 确认 | 5 | 多 3 步；发布版本按迭代组织（P1-B1 设计决定），按产品的版本总览留给后续 | `iterations.spec.ts`「发布版本：在迭代详情新建…标记发布…」 |

## 与 push 数字不一致的地方

- 迭代概览的整体进度：push 按任务标题聚合，并写死排除 bugfix、集成测试、测试用例编写三类标题、把「推广分佣」系列合并为一行；Flower 按需求聚合（没有需求的按标题），不写死任何名称。同一迭代的整体进度和遗留数可能与 push 不同，差异来自这些行。
- push 概览的派生状态（待开发 / 已提测 / 测试中）没有迁到 Flower 的界面上，迁移值保存在 `tasks.meta.ovStatus`。

## 需要在用户试用中确认的地方

- 第 5、8 项比旧系统多 3 步。试用时请记录是否影响日常使用；如果影响，候选改法是进行中的迭代默认打开「甘特」页签、在迭代列表加「甘特」「发布版本」直达链接。
- 第 6 项的入口位置（迭代列表的「人员负载」按钮）是否好找。
```

- [ ] **Step 4: 提交**

```bash
git add docs/p1b-comparison.md
git commit -m "docs: P1-B 日常操作新旧对比

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 15: 真实数据验证：重导 pan123、性能测量、验证记录、人工验收清单与用户试用脚本

**Files:**
- Modify: `packages/migrate/src/perf.ts`（新增 5 个用例）
- Modify: `packages/migrate/test/perf.test.ts`
- Modify: `docs/p1b-validation.md`（追加「P1-B2」一节；只写数量与耗时，不写姓名、邮箱或需求标题）

**Interfaces:**
- Consumes: `getIterationGantt`、`listMemberTasks`、`listReviewQueue`、`getWorkbench`（`@flower/core`）；现有 `measure`、`buildPerfCases`
- Produces：`buildPerfCases` 返回 16 个用例，新增「甘特：任务最多的迭代」「人员负载：任务最多的人（含已结束迭代）」「评审队列：默认」「评审队列：等我签字」「工作台」

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
      '甘特：任务最多的迭代',
      '人员负载：任务最多的人（含已结束迭代）',
      '评审队列：默认',
      '评审队列：等我签字',
      '工作台',
    ]);
    const result = await measure(cases, 2);
    expect(result).toHaveLength(16);
```

Run: `pnpm --filter @flower/migrate exec vitest run test/perf.test.ts`
Expected: FAIL，只有 11 个用例。

- [ ] **Step 2: 实现**

`packages/migrate/src/perf.ts`：

1. import 改为：

```ts
import {
  type Actor,
  type Db,
  getIterationGantt,
  getIterationScope,
  getRequirementByKey,
  getWorkbench,
  listIterations,
  listMemberTasks,
  listRequirementComments,
  listRequirements,
  listReviewQueue,
} from '@flower/core';
```

2. `buildPerfCases` 中把

```ts
  // 范围对比只对已开始的迭代有意义；取其中需求最多的一个
  const largest = (await listIterations(db, actor))
    .filter((it) => it.status !== 'planning')
    .sort((a, b) => b.requirementCount - a.requirementCount)[0];
```

替换为：

```ts
  const iterationList = await listIterations(db, actor);
  // 范围对比只对已开始的迭代有意义；取其中需求最多的一个
  const largest = iterationList.filter((it) => it.status !== 'planning').sort((a, b) => b.requirementCount - a.requirementCount)[0];
  // 甘特取任务最多的迭代；人员负载取任务最多的负责人
  let busiest: { id: string; count: number } | null = null;
  const assigneeCount = new Map<string, number>();
  for (const it of iterationList) {
    const g = await getIterationGantt(db, actor, it.id);
    if (!busiest || g.tasks.length > busiest.count) busiest = { id: it.id, count: g.tasks.length };
    for (const t of g.tasks) if (t.assignee) assigneeCount.set(t.assignee.id, (assigneeCount.get(t.assignee.id) ?? 0) + 1);
  }
  const topAssignee = [...assigneeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
```

3. 返回数组末尾（`迭代：范围对比` 之后）追加：

```ts
    { name: '甘特：任务最多的迭代', run: () => (busiest ? getIterationGantt(db, actor, busiest.id) : Promise.resolve(null)) },
    {
      name: '人员负载：任务最多的人（含已结束迭代）',
      run: () => (topAssignee ? listMemberTasks(db, actor, topAssignee, { includeFinished: true }) : Promise.resolve(null)),
    },
    { name: '评审队列：默认', run: () => listReviewQueue(db, actor, productId) },
    { name: '评审队列：等我签字', run: () => listReviewQueue(db, actor, productId, { waitingForMe: true }) },
    { name: '工作台', run: () => getWorkbench(db, actor.accountId!) },
```

Run: `pnpm --filter @flower/migrate test` 与 `pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 3: 提交代码**

```bash
git add packages/migrate/src/perf.ts packages/migrate/test/perf.test.ts
git commit -m "feat(migrate): 性能测量增加甘特、人员负载、评审队列与工作台

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: 按新映射重导 pan123**

Task 4 改了甘特任务的标记与手动进度映射，开发库需要重导才能看到。`--replace` 会先删除 pan123 的全部数据；用户已于 2026-09-30 批准在本任务中用 `--replace` 重导 pan123（仅限本地开发库），执行时不必再确认。`<OWNER_EMAIL>` 由控制方在派发时提供。若之前跑过 `pnpm test` 或端到端测试，先执行 `pnpm db:migrate` 把 `flower_app` 的密码改回。

```bash
pnpm db:migrate
pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --owner-email <OWNER_EMAIL> --as-of 2026-09-29 --replace --dry-run
```

Expected：对账报告 0 个阻止写入的问题（没有「甘特任务标记」相关问题）。确认后去掉 `--dry-run` 再执行一次。

查看导入后的任务数据（只输出数量）：

```bash
docker compose -f docker-compose.dev.yml exec -T postgres psql -U flower_admin -d flower -At -F ' | ' -c "select coalesce(t.flag, '(正常)'), count(*) from tasks t join organizations o on o.id = t.org_id where o.slug = 'pan123' group by 1 order by 1"
docker compose -f docker-compose.dev.yml exec -T postgres psql -U flower_admin -d flower -At -F ' | ' -c "select count(*), count(*) filter (where t.meta ? 'progress'), count(*) filter (where t.requirement_id is null) from tasks t join organizations o on o.id = t.org_id where o.slug = 'pan123'"
docker compose -f docker-compose.dev.yml exec -T postgres psql -U flower_admin -d flower -At -F ' | ' -c "select i.status, count(*) from iterations i join organizations o on o.id = i.org_id where o.slug = 'pan123' and i.deleted_at is null group by 1 order by 1"
```

Expected（2026-09-30 检查开发库时的数量，重导后应一致）：标记 `attention` 12、正常 365；任务共 377，其中不挂需求的 270（均为 push 任务）；有手动进度的 58 条（`ov_progress ≥ 0` 的记录数；`actual_status` 全为空）。迭代状态：已完成 12、规划中 1、没有进行中的迭代。

- [ ] **Step 5: 测量性能**

```bash
pnpm --filter @flower/migrate build
node --disable-warning=ExperimentalWarning --env-file=apps/web/.env.local packages/migrate/dist/cli.mjs perf --org-slug pan123 --owner-email <OWNER_EMAIL> --runs 40
```

Expected：输出 16 个用例的 p50 / p95 / 最大值。目标：每个用例 p95 ≤ 300 ms。超过的用例不要自行优化，在任务报告中列出数字，状态报 DONE_WITH_CONCERNS。

- [ ] **Step 6: 写验证记录、人工验收清单与用户试用脚本**

在 `docs/p1b-validation.md` 末尾追加下面一节。第 1、2 节的表格用 Step 4、Step 5 的输出填写；其余内容照写：

```markdown
## P1-B2：甘特、人员负载、评审表与工作台

数据：2026-09-29 的生产只读副本，本地开发库组织 pan123，于 P1-B2 按新的甘特任务映射以 `--as-of 2026-09-29 --replace` 重导。迁移命令见 `CLAUDE.md`，对账报告全文在 `.local-data/reports/`（不进仓库）。

### 1. 数据状态

| 项 | 结果 |
|---|---|
| 导入对账 | 0 个阻止写入的问题 |
| 任务总数 / 不挂需求的任务 | （Step 4 第二条查询） |
| 标记为「关注」的任务 / 正常 | （Step 4 第一条查询） |
| 有手动进度（`meta.progress`）的任务 | （Step 4 第二条查询） |
| 迭代状态 | （Step 4 第三条查询）；没有进行中的迭代时，试用前先按第 4 节开始一个迭代 |

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
| 甘特：任务最多的迭代 | | | |
| 人员负载：任务最多的人（含已结束迭代） | | | |
| 评审队列：默认 | | | |
| 评审队列：等我签字 | | | |
| 工作台 | | | |

### 3. 人工验收清单（由用户在本地 pan123 上执行）

用自己的账号登录 `pnpm dev` 启动的开发环境，逐项打勾；发现的问题记在本节末尾。验收中新建的数据用「验收-」开头命名，结束后删除或取消。

工作台
- [ ] 登录后直接进入工作台，四个区块的数量与需求列表、评审表的结果一致（「我负责的需求」= 需求列表按负责人筛选后去掉已上线、已拒绝、已搁置）。
- [ ] 侧边导航「概览」进入原来的产品卡片页，组织管理员仍能看到配置清单。
- [ ] 如果加入了多个组织，其他组织的行带组织名，点进去跳到对应组织。

甘特
- [ ] 打开任务最多的已完成迭代的「甘特」页签：概览的整体进度、遗留数与 push 对应版本大致一致；差异来自 push 写死的排除标题与合并规则（见 `docs/p1b-comparison.md`）。
- [ ] 迁移来的「关注」任务显示为「关注」，概览的「关注与周知」列出它们；写了说明的正常任务显示为「周知」。
- [ ] 新建常规迭代「验收-迭代」，用「＋ 任务」加两个任务，改开始日期、工期（试一次 0.3，应提示以半天为单位并还原）、延期、进度、说明，离开输入框后刷新页面仍保留。
- [ ] 标 10 个重点后第 11 个提示「每个迭代最多 10 个重点任务」。
- [ ] 时间轴按工作日显示，计划内和延期颜色不同；热力图按人显示，点姓名进入人员负载页。

人员负载
- [ ] 迭代列表「人员负载」选一个开发，列出他在规划中、进行中迭代里的任务；打开「包含已结束的迭代」后出现历史任务。

评审表
- [ ] 侧边导航「评审」：列与本产品流程的检查项一致（背景、可行性、行业、设计签字、PRD、AI 预审），没有写死的 7 项。
- [ ] 统计栏的数量与筛选结果一致；按「设计签字 = 未开始」筛选后逐条可展开。
- [ ] 勾「等我签字」只剩需要自己签的需求；展开一条签字，行内的通过数加一；产品管理员能对指定成员的签字规则代签，代签记录显示「由 … 代签」。
- [ ] 在需求详情「分配」区块给一条评审中的需求分配一位设计：只有这位设计的「等我签字」出现它；删除分配后，其他设计也能看到。重复添加同一分配时提示「已经有相同的分配」。

界面打磨
- [ ] 断开网络后点任意保存，提示「网络连接失败，请检查网络后重试」。
- [ ] 非实例管理员打开 `/admin`，只看到「无权访问」。

问题记录：

### 4. 用户试用脚本

目的：用真实数据走一遍日常工作，记录不顺手的地方。每项做完在「阻力」一栏写下卡住、找不到、步骤多余的地方；没有就写「无」。对照的旧系统步骤见 `docs/p1b-comparison.md`。

准备：迭代列表里把一个规划中的迭代点「开始迭代」（或新建「验收-迭代」并开始），往里加 3–5 条已评审通过的需求，并给每条需求在「甘特」页签加 1–2 个任务、指派负责人和开始日期。

| # | 任务 | 预期结果 | 用时 | 阻力 |
|---|---|---|---|---|
| 1 | 登录，说出今天要处理的事 | 工作台四个区块给出答案，不用打开别的页面 | | |
| 2 | 新建一条需求并填写提出人和优先级 | 需求列表出现新需求 | | |
| 3 | 把一条已通过评审的需求拉进进行中的迭代 | 迭代「需求」页签出现它；条件不满足时看到原因 | | |
| 4 | 在评审表里找到等你签字的设计项并签字 | 行内通过数加一；工作台「等我签字」少一条 | | |
| 5 | 给一条需求记录一个阻塞项，再解除 | 迭代「需求」页签的阻塞标记随之出现和消失 | | |
| 6 | 在甘特里更新两个任务的进度和延期 | 概览的整体进度、落后数随之变化 | | |
| 7 | 查看一位开发接下来四周的负载 | 人员负载页的负载条与甘特热力图一致 | | |
| 8 | 给迭代建一个发布版本并标记发布 | 发布版本显示已发布和发布日期 | | |
| 9 | 把一个任务标为「关注」并写说明 | 概览「关注与周知」出现它，遗留数加一 | | |
| 10 | 在一条评审已开始的需求上，用「分配」区块指派一位设计 | 只有这位设计的工作台「等我签字」出现这条需求；其他持有设计标签的人看不到（可用另一个设计账号登录核对） | | |
| 11 | 用完后回想：哪一步最想减少？ | —— | | |

试用结束后删除或取消「验收-」开头的数据。

### 5. 留给后续阶段

需求换迭代时任务跟随、甘特拖拽编辑、push 概览派生状态、`phase` 字段界面、评审表筛选写入 URL、工作台分页、待签与未读的消息提醒（P3 通知）、按产品的发布版本总览。
```

- [ ] **Step 7: 提交文档**

```bash
git add docs/p1b-validation.md
git commit -m "docs: P1-B2 真实数据验证记录、人工验收清单与用户试用脚本

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 16: 交接文档与协作日志，完整验证

**Files:**
- Modify: `docs/handoff.md`
- Modify: `docs/agent-log.md`（在「记录」最上面加一条）

**Interfaces:**
- Consumes: Task 1–15 的结果；Task 15 Step 5 的性能数字

- [ ] **Step 1: 完整验证**

Run（按顺序；端到端在后台运行并写日志，不要与 `pnpm dev` 同时运行）：

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm test
pnpm --filter @flower/web e2e
./scripts/smoke.sh
pnpm db:migrate
```

Expected：全部通过；最后一步把 `flower_app` 的密码改回 `apps/web/.env.local` 中的值，之后 `pnpm dev` 可以正常连接 pan123。记下 core / web / migrate / e2e 各自的用例数，写进协作日志。

- [ ] **Step 2: 更新交接文档**

`docs/handoff.md`：

1. 第 3 行「更新：2026-09-29。」改为「更新：2026-09-30。」

2. 「关键文档」表格中 P1-B1 计划那一行之后加入：

```markdown
| `docs/superpowers/plans/2026-09-30-flower-p1b2-gantt-workbench.md` | P1-B2 计划：任务与甘特、人员负载、批量评审表、工作台、需求分配、统一错误状态（已完成） |
| `docs/p1b-comparison.md` | P1-B 日常操作新旧对比（8 项操作的步数与结论） |
```

3. 「当前进度」中 P1-B1 一条改为「**P1-B1 迭代、发布版本、阻塞项与关联、结构树维护：已完成，已合并（PR #6）**」，其下三行不变；列表末尾加入：

```markdown
- **P1-B2 甘特、人员负载、评审表与工作台：已完成**（分支见协作日志）。
  - 任务增删改与重点（每个迭代最多 10 个），push 的工作日进度算法与迭代概览，甘特页签（行内编辑、时间轴、团队负载热力图），跨迭代的人员负载页。
  - 按流程检查项生成的批量评审表（统计、筛选、展开签字与代签），登录后默认进入的跨组织工作台，概览页移到 `/[org]/overview`。
  - 需求详情可以新增、删除分配；「等我签字」按分配推给对应的人，没有分配时推给该职能标签的全部成员。
  - 统一的加载失败状态与网络错误中文提示（P0-B 暂缓项已处理）。
  - pan123 已按新的甘特任务映射重导；人工验收清单与用户试用脚本见 `docs/p1b-validation.md`「P1-B2」一节，待用户执行。
```

4. 「下一步」整节替换为：

```markdown
## 下一步

1. 用户按 `docs/p1b-validation.md`「P1-B2」第 3、4 节在本地 pan123 上验收并试用，问题与阻力记在对应位置。
2. 根据试用结果决定是否调整甘特与发布版本的入口（`docs/p1b-comparison.md` 第 5、8 项比旧系统多 3 步）。
3. 进入 P2（文档）之前，确认 P1-B2 计划「设计决定」表「留给后续阶段」一行里哪些要提前。
```

5. 「已确认的决定（要点）」列表末尾加入：

```markdown
- 甘特进度沿用 push 的工作日算法；任务标记只有「关注」一种，手动进度存 `tasks.meta.progress`；迭代概览按需求聚合，不写死 123云盘 的排除标题。
- 工作台在 `/[org]`，内容跨组织；概览页在 `/[org]/overview`。评审表的「等我签字」只统计评审已开始的需求，并按需求分配推给对应的人。
```

- [ ] **Step 3: 写协作日志**

`docs/agent-log.md`：在「## 记录」下面、现有第一条之前加入（分支名和用例数按实际填写）：

```markdown
### 2026-09-30 · 本地 · P1-B2：甘特、人员负载、评审表与工作台
- 分支 / PR：`feat/p1b2-gantt-workbench`
- 做了什么：
  - core：排期纯函数（push 的工作日进度、覆盖规则、热力图色阶、迭代概览，浏览器安全子路径 `@flower/core/schedule`）；任务新建 / 修改 / 删除（每个迭代最多 10 个重点，标重点时锁迭代防并发超限）；甘特、按需求、按人跨迭代的任务查询；按流程检查项生成的评审队列（整体评审状态、会签进度、等我签字含代签）；跨组织工作台（`listMyOrganizations` 查成员关系，逐个组织 `withOrg` 读取）。
  - 有任务的迭代不能删除（B1 只检查需求与发布版本）。
  - migrate：push 甘特任务的标记映射为 `attention`，手动进度写入 `meta.progress`；pan123 已重导。
  - web：甘特页签、时间轴与团队负载、人员负载页、评审表、工作台（登录后默认页），概览页移到 `/[org]/overview`；统一加载失败状态与网络错误中文提示，修复 AuthGate 与产品设置在 5xx 时的表现、`/admin` 两个一级标题、未处理的 `mutateAsync` 拒绝。
  - 检查项组件移到 `components/check-items.tsx`，需求详情与评审表共用。
  - 需求分配的新增与删除（core、接口、需求详情「分配」区块）；新增迁移 `0008_*.sql`，给 `requirement_assignments` 加唯一约束。
- 怎么验证的：`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm test`（core / web / migrate）、完整端到端测试、`./scripts/smoke.sh` 全部通过；真实数据性能见 `docs/p1b-validation.md`「P1-B2」第 2 节。
- 留给对方：
  - 用户验收与试用（`docs/p1b-validation.md`「P1-B2」第 3、4 节）。
  - 以后新增同时锁迭代与任务的代码，保持「先迭代、后任务」的顺序。
  - 留给后续阶段的项见 P1-B2 计划「设计决定」表最后一行。
```

- [ ] **Step 4: 提交**

```bash
git add docs/handoff.md docs/agent-log.md
git commit -m "docs: P1-B2 交接与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## P1-B2 完成标准

- `pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm test`（core、web、migrate）、完整端到端测试、`./scripts/smoke.sh` 全部通过。
- 权限与规则均有测试覆盖：只读成员、只读 Token 写任务或修改分配 → forbidden；重复分配 → conflict；分配设计后「等我签字」只推给该设计；看不到产品的访客 → not_found；第 11 个重点 → conflict（含并发）；工作日算法跳过周末、半天任务按 1 天算；「关注」且未完成的需求不计入整体进度；评审队列的「等我签字」只在评审开始后出现，职能标签规则只推给被分配的人（没有分配时推给全部持有者），代签只给产品管理员；工作台跨组织隔离（只属于一个组织的账号看不到其他组织的内容）；工作台拒绝 API Token。
- 现有 spec（`overview`、`acceptance`、`product-admin`、`auth`、`requirements`、`iterations`）在落地页改为工作台后仍然通过。
- pan123 已按新映射重导；`docs/p1b-validation.md`「P1-B2」第 1、2 节已填，第 3、4 节交给用户；`docs/p1b-comparison.md` 已完成。
