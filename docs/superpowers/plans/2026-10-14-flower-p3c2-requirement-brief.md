# Flower P3-C2 需求简报 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Flower 里按固定结构记录写 PRD 之前的讨论结论：新增文档类型「简报」（`{产品}-B-n`），预置用户提供的 18 节模板与头部结构化字段，覆盖需求，软闸口（3 项自动检查、8 项人工勾选），一键转为变更 PRD 草稿，复制 / 下载 Markdown 与只读上下文接口；文档页加「简报」页签，需求详情侧栏加「简报」区块。

**Architecture:** 方案 A：简报是 `documents.kind = 'brief'` 的一份文档，复用编辑器、修订、划词评论、`[[ ]]` 链接、附件、关注与状态列；按产品单独编号（`products.brief_seq`，`documents` 的编号唯一索引按「是否简报」拆成两个部分索引）。头部字段放在一对一的新表 `document_briefs`（RLS），需求用 `requirements.brief_document_id` 挂简报。纯逻辑在 `packages/core/src/documents/brief-template.ts`（预置模板、闸口项、转 PRD 对应表）与 `brief-model.ts`（闸口判定、转 PRD 拼接、上下文 Markdown）；写操作在 `briefs.ts` 与 `coverage.ts`，同事务记领域事件。页面沿用 PRD 详情页（`/{org}/documents/PAN-B-n`），侧栏换成简报自己的卡片；闸口结果由接口计算，页面不导入服务端模块。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、BlockNote（已有）、shadcn/ui（Tabs、Table、Dialog、Select、Checkbox、Popover）、lucide-react、Vitest、Playwright。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-14-flower-p3c2-requirement-brief-design.md`（用户 2026-10-14 确认，含附录 A 用户提供的简报模板，本计划的约束来源）；上位文档 `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`；P2-A 设计与计划（文档、模板、修订、评论、覆盖需求）；P3-B1（站内通知「被指派」）；P3-C1 计划（`perf` 命令、e2e 写法）。逐条决定见「设计决定」，与设计、代码或数据不一致之处见文末「与设计、代码或数据的冲突」。

## Global Constraints

- **今天是 2026-10-14。** 计划、验证记录、协作日志里的日期以此为准。
- **执行代理不运行 `pnpm dev`，不读取 `.local-data/`，除 `pnpm db:migrate` 外不写本地开发库。** 本地开发库只做只读查询（`docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select …"`，只取数量与结构）。界面检查一律写成 Playwright 用例；真实数据上的迁移核对、界面复验与性能测量由控制方在 Task 16 完成。
- `pnpm test` 与端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；跑完之后、对开发库做任何操作之前，先执行一次 `pnpm db:migrate`。
- 计划、验证记录、提交信息、测试数据只写数量与结构，不写真实姓名、职务、邮箱、需求标题。测试只用虚构内容与 `@example.com` 邮箱；预置模板不预填任何人名。
- **不新增依赖。** 复制用 `navigator.clipboard`，下载用 `Blob` + `URL.createObjectURL`。
- 迁移：`0021_*.sql` 由 `pnpm --filter @flower/core db:generate` 生成（列、表、索引、外键）；`0022_p3c2_briefs.sql` 用 `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p3c2_briefs` 生成后填写：为 `document_briefs` 开启 RLS（参照 `0020_p3c1_tracking.sql` 第一段），为没有组织级简报模板的组织补齐预置简报模板。执行中如发现还要改表结构，停下来报告。
- 新租户表必须带 `org_id` 并开启 RLS；业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`（实体 id 作为第三个参数的现有写法照旧），一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写，列表按可见产品过滤。
- **每个写操作在同一事务内调用 `recordEvent`**（修改类 payload 带 `changes: [{field, old, new}]`）。本计划新增：`brief.created`、`brief.updated`（头部字段）、`brief.gate_checked`、`brief.converted`，主体均为 `subjectType: 'document'`。沿用的文档事件：正文 `document.saved`、改状态 `document.status_changed`（简报的 payload 带 `kind: 'brief'`）、覆盖需求 `document.requirements_linked` / `document.requirement_unlinked` 与 `requirement.updated`（字段 `briefDocumentId`）、转出的 PRD `document.created`（payload 带 `fromBriefId`）。后台与系统写入不记事件：迁移补齐模板、新组织初始化模板。
- **新事件不接入企业微信群推送**：不加入 `NOTIFIABLE_EVENT_TYPES`；简报的 `document.status_changed` 由事件规则匹配跳过（Task 5）。站内通知只新增「被设为决策人」（`brief.updated`，Task 8）。
- 面向用户的文案与错误信息用中文，通过 `AppError(code, message, details?)` 抛出。`apps/web/src/server/routes` 只做参数校验和调用服务；路径里的 id 用 `idParam` 校验，格式错误返回 400。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`、`@flower/core/markdown`、`@flower/core/links`、`@flower/core/notifications`。本计划不新增子路径：`briefDisplayKey`、`documentKeyOf`、`BRIEF_TRANSITIONS` 放进 `documents/markdown.ts`（仍只依赖 `diff` 与类型导入，不新增值导入）；`[[PAN-B-n]]` 的识别放进 `links/syntax.ts`（仍不导入任何模块）。`brief-template.ts`、`brief-model.ts` 只在服务端使用，页面从接口拿闸口结果。
- **`src/index.ts` 用 `export *` 汇总导出，新名字不能与已有导出重名**（P3-C1 教训）。本计划新增的导出名见「自查」，写计划时已检索不重名；执行中新增任何导出前先 `grep -rn "export .*<名字>" packages/core/src`。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`；对话框用 `key` 或 `open && <Form/>` 重新挂载取初值，输入框随服务端值变化时在渲染期间同步（参照 `apps/web/src/app/(app)/[org]/settings/general/page.tsx` 的 `synced`）。渲染期间不直接调用 `new Date()` / `Date.now()`（`react-hooks/purity`）。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框与带输入的表单用 `silentError: true` + `<FormError error={mutation.error} />`。页面加载失败用 `QueryError`。
- 复用已有的共享件：`PageHeader`、`EmptyState`、`QueryError`、`FormError`、`MemberPicker`、`OptionMultiSelect`、`FollowButton`、`Backlinks`、`DocumentStatusBadge`、`Table` 系列、`Select` 系列、`Tabs` 系列、`Dialog` 系列、`Checkbox`；`features/members/model.ts` 的 `activePeople`、`canListMembers`、`pickerOptions`；`features/requirements/format.ts` 的 `formatDateTime`；PRD 详情页的 `EditorPane`、`StatusCard`、`Revisions`、`DocumentComments`、`ImportDialog`；e2e `helpers.ts` 的 `ok`、`json`、`setupInstance`、`login`、`createProduct`、`createRequirement`、`createMember`、`expectNoPageOverflow`，`db.ts` 的 `resetDatabase`。
- 视觉沿用 P0-B：表格行高 40px（`h-10`）、隔行底色 `even:bg-zebra`、编号与进度用 `font-mono`、卡片 `rounded-md border bg-card p-4`。闸口未通过的原因用 `text-destructive`。
- 布局：1440 与 760 两个宽度下页面本身不横向滚动；列表在自己的容器里横向滚动；正文宽表格在编辑器内横向滚动（编辑器已有）；新页面与新页签都有 Playwright 断言（`expectNoPageOverflow`）。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0` 与 `pnpm typecheck`。
- 端到端测试：每个 spec 在 `beforeEach` 调用 `resetDatabase()`；不为迁就定位器修改共享组件；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染。同名元素要按角色区分：文档页的页签「简报」（`tab`）与需求详情侧栏的区块「简报」（`region`，`exact: true`）；模板设置页同一时刻只渲染一个「新建模板」按钮（简报模板用下拉切换，不并排两个编辑器）。
- 提交信息用中文，每条末尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）；实际执行提交的若不是 Claude Opus 5.5，把这一行换成实际模型的名字。完成后按 `CLAUDE.md` 在 `docs/agent-log.md` 最上面追加一条（Task 16）。

## Review Focus

设计没有逐条写、各任务正常路径的测试也不一定覆盖、但最可能让使用者碰到问题的五类输入。每一条的测试已加在负责的任务里：

1. **编辑器保存后的正文格式与「不适用」写法。** BlockNote 保存时会重排表格（补空格、分隔线变长）、把列表符号改成 `*`、给 `[` 与标题里的 `1.` 加反斜杠；用户可能只写「不适用」或「不适用：」而不写理由。期望：没动过的模板内容仍算「还没有填写」，只写「不适用」没有理由的小节判为未通过并说明原因，写了理由的算通过。测试：Task 2「编辑器重排后的模板仍算未填写」「不适用」；Task 14 在编辑器里给「不适用：」补上理由后闸口刷新。
2. **简报与 PRD 同号（`PAN-B-1` 与 `PAN-PRD-1`）。** 期望：按编号打开、`[[ ]]` 解析与链接卡、被引用、PRD 列表、评审表都不串号；在需求详情「PRD」区块「关联已有 PRD」里填简报编号时拒绝并提示填 PRD 编号，而不是把需求挂到简报上。测试：Task 3「各自编号」；Task 5「按编号打开」「[[ ]] 与链接卡」；Task 13 / Task 14「PRD 区块填简报编号」。
3. **推送与站内通知把简报当成 PRD。** 订阅了「PRD 状态变化」的群推送规则、关注者通知文案、决策人是看不到该产品的访客或已离开的成员。期望：简报改状态不产生群推送；站内通知写「简报」而不是「PRD」；设为决策人时只通知能看到该产品的在职成员，已离开的成员不能被选为决策人。测试：Task 5「推送规则」；Task 6「决策人校验」；Task 8「通知文案」「访客决策人」。
4. **重复转换与部分覆盖。** 覆盖的需求有的已挂在别的 PRD 上；已经转过一次又点「转 PRD」；简报已废弃；简报很长，拼出的 PRD 超过 30 万字。期望：已挂别的 PRD 的需求跳过并在结果里列出（编号与所在 PRD）；再次转换先返回 409「这份简报已转为 PAN-PRD-n」，确认后才生成新草稿，原 PRD 与其覆盖的需求保留；已废弃的不能转；过长时报中文错误、不写入。测试：Task 7；Task 9「转 PRD」；Task 14「再生成一份新草稿」。
5. **可见范围与只读。** 限定产品的 Token、访客只能看到有角色的产品；只读 Token 读上下文。期望：列表、上下文、需求详情里不出现看不到的产品的简报；看不到的简报的上下文返回 404（不暴露是否存在）；只读成员与只读 Token 能读闸口与上下文，但不能勾选、改头部、转 PRD；筛选参数格式错误返回 400「筛选参数无效」，合法 UUID 但看不到的产品返回空列表。测试：Task 6「列表」；Task 9「列表」「上下文」「闸口」。

## 设计决定

数量为 2026-10-14 写计划时对本地开发库的只读查询，只取数量。

| 项 | 决定 | 依据 |
|---|---|---|
| 现状数据 | 组织 2 个（有产品的 1 个，pan123）；pan123 产品 1 个（PAN，`document_seq = 203`）；文档 203 份，全部是变更 PRD（草稿 84、评审中 16、已通过 20、已上线 83），没有模块文档；文档模板 1 份（pan123 的组织级预置 PRD 模板，另一个组织 0 份）；未删除需求 766 条，其中挂了 PRD 的 242 条；迁移已到 0020（drizzle 记录 21 条） | 只读核对 |
| 文档类型与状态 | `DOCUMENT_KINDS` 加 `brief`；简报状态 `discussing` 讨论中、`ready` 可写 PRD、`converted` 已转 PRD、`discarded` 已废弃，与其他文档共用 `documents.status`（`discarded` 共用）。流转按类型取：讨论中 → 可写 PRD / 已废弃；可写 PRD → 讨论中 / 已废弃；已转 PRD → 讨论中 / 已废弃；已废弃 → 讨论中。已转 PRD 只由「转 PRD」进入；闸口不限制改状态 | 设计 §3.1、§3.5 |
| 编号 | 新列 `products.brief_seq`；`documents` 原唯一索引 `(product_id, number)` 改为两个部分唯一索引（非简报、简报各一个）；显示 `{产品}-B-n`（`briefDisplayKey`），`documentKeyOf(kind, …)` 统一取显示编号；按编号查文档、`[[ ]]` 解析、链接卡、被引用都按类型区分 | 设计 §3.1，见冲突表 |
| `[[ ]]` | `classifyTarget` 识别 `KEY-B-n` 与 `KEY-B-n#小节`（新增目标种类 `brief`，存为 `target_type = 'document'`）；新建简报时接上同写法的悬空链接。`[[` 补全不列简报（手写照常解析为链接卡） | 设计 §3.1，见冲突表 |
| 头部表 | `document_briefs`：主键 `document_id`（与文档一对一）、`org_id`、`version`（默认 `v0.1`，1–30 字）、提出人 / 决策人 / 作者（成员引用，可空；新选择时须为在职真人成员）、`participant_tag_ids`（职能标签，最多 20 个）、`related_links`（最多 20 条：`{kind:'wiki', target, note}` 或 `{kind:'url', url, note}`，说明 ≤ 100 字）、`gate_checks`（`[{item, memberId, at}]`）、`converted_document_id`、`updated_at` | 设计 §3.3 |
| 覆盖需求 | `requirements.brief_document_id`（与 `change_document_id` 同样写法，带索引）；一条需求可以同时挂一份简报和一份 PRD。覆盖需求复用文档接口 `POST/DELETE /documents/:id/requirements`，服务端按文档类型写对应的列；已挂其他简报时 409「PAN-3 已挂在 PAN-B-2 上，请先从那份简报移出」；已废弃的简报不能再关联 | 设计 §3.2、§5 |
| 预置模板 | 组织级「需求简报（预置）」：正文为附录 A 的 18 节（二级标题 `## 1. 问题与目标` …，各节表格与列表作为初始内容，小标题用加粗段落），18 节全部必填；附录 A「用法」三条存为模板说明。新列 `document_templates.guidance`（模板说明，≤ 2000 字），显示在编辑器上方。迁移 0022 为两个组织补齐；新组织初始化时写入；迁移工具导入 pan123 时一并写入。头部信息表不进正文（结构化字段） | 设计 §3.4，见冲突表 |
| 模板按类型 | `listTemplates` / `createTemplate` / `effectiveTemplates` / `loadUsableTemplate` / `createPresetTemplate` 带类型参数（默认 `change`，原有调用不变）；产品覆盖规则与 PRD 模板相同（同名覆盖）。设置页用「模板类型」下拉切换 PRD 模板与简报模板 | 设计 §3.4、§5 |
| 闸口 | 每次读取时计算。自动 3 项：1）第 1–14 节每节去掉模板原样内容后有内容，或写了「不适用：理由」且理由非空（缺小节、没填、只写「不适用」分别说明）；7）第 8 节表格里「结论」非空的每一行，「证据」「核对日期」两列非空；10）第 16 节表格「是否阻塞 PRD」列没有「是」。比较时每行去掉 Markdown 符号与空白（与编辑器的保存格式无关），小节按内置标题找（去掉编号、反斜杠与空白），列按表头前缀找。其余 8 项人工勾选，记录勾选人与时间，可取消；自动项不能勾选。进度显示为「通过数/11」 | 设计 §3.5，见冲突表 |
| 转 PRD | 按附录 A 第 18 节生成固定章节（见 `BRIEF_TO_PRD`），每章下面依次放来源小节：引用块「来自简报第 n 节「名称」」+ 该节原文（空节写「（简报中这一节为空）」）；第一行「由简报 [[PAN-B-n]] 生成…」。新 PRD 为 Flower 文档、草稿、不套模板（`template_id` 为空）、标题同简报、负责人为简报作者（作者已离开或是 Agent 时为空），第 1 版摘要「由简报 PAN-B-n 生成」。覆盖简报覆盖的、还没挂 PRD 的需求，其余跳过并返回。简报改为已转 PRD、记录 `converted_document_id`；已转过且原 PRD 仍在时，不带 `again` 返回 409（`details.documentKey`），带 `again` 生成新草稿并替换 `converted_document_id`。PRD 详情显示「由简报 PAN-B-n 生成」（当前指向它的简报）；正文第一行的 `[[ ]]` 让两边在「被引用」里互相可见 | 设计 §3.6，见冲突表 |
| 上下文 | `GET /orgs/:org/briefs/:id/context?format=markdown\|json`（缺省 markdown）：头部、覆盖的需求（编号、标题、状态名）、闸口结果、转出的 PRD、正文；Markdown 格式见 `briefContextMarkdown`。只读 Token 可读。简报页「复制为 Markdown」「下载 .md」取同一份 Markdown（先保存编辑器里没到时间的修改） | 设计 §3.7 |
| 接口 | `GET /orgs/:org/briefs?product&status&decider`（`status` 逗号分隔）、`POST /orgs/:org/products/:id/briefs`、`PATCH /orgs/:org/briefs/:id`、`GET /orgs/:org/briefs/:id/gate`、`PUT /orgs/:org/briefs/:id/gate/:item`、`POST /orgs/:org/briefs/:id/convert`、`GET /orgs/:org/briefs/:id/context`；`GET /orgs/:org/templates?kind=brief`、`POST /orgs/:org/templates/preset?kind=brief`。详情、正文、修订、评论、状态、覆盖需求、附件、关注沿用文档接口 | 设计 §5 |
| 权限 | 同变更 PRD：查看 = 能看到该产品；新建、改头部、关联需求、改状态、勾选闸口、转 PRD = 产品编辑及以上（只读 Token 按只读）；改简报模板 = 组织管理员（产品覆盖为产品管理员）。看不到的简报一律按「简报不存在」处理 | 设计 §5 |
| 通知 | `brief.updated` 里决策人变为某人时给他「被指派」（「把你设为简报决策人」）并自动关注；简报的正文 @、状态变化、评论沿用文档通知，文案把「PRD」换成「简报」 | 设计 §5 |
| 页面 | 文档页页签顺序「变更 PRD」「模块文档」「简报」（`?view=briefs`），默认仍是变更 PRD；简报列表列出编号、标题、状态、覆盖需求数、闸口进度、决策人、更新时间，按状态、决策人筛选（写入地址栏）。简报详情沿用 `/{org}/documents/PAN-B-n`：模板说明在正文上方；侧栏依次为状态、头部信息、覆盖的需求、写 PRD 闸口、操作、修订。需求详情侧栏在「PRD」之前加「简报」区块 | 设计 §4，见冲突表 |
| 性能 | `perf` 加两个用例：简报列表（全部产品）、上下文（最近更新的简报）；pan123 上 p95 低于 300 毫秒。控制方在界面复验写出一份真实简报之后再测 | 设计 §6 |
| 依赖顺序 | Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11–13（依赖 10）→ 14 → 15 → 16 | — |

## 文件结构

```
packages/core/
  src/documents/constants.ts  markdown.ts            # 简报状态、类型、编号、流转（Task 1）
  src/links/syntax.ts  links.ts                      # [[PAN-B-n]] 识别与解析（Task 1）
  src/documents/brief-template.ts                    # 预置简报模板、闸口项、转 PRD 对应表（Task 2）
  src/documents/brief-model.ts                       # 纯函数：闸口判定、转 PRD 拼接、上下文 Markdown（Task 2）
  src/db/schema.ts                                   # brief_seq、brief_document_id、guidance、document_briefs、编号索引（Task 3）
  migrations/0021_*.sql  0022_p3c2_briefs.sql  meta/ # Task 3
  src/documents/templates.ts  src/definitions/defaults.ts   # 模板按类型、模板说明、预置简报模板（Task 4）
  src/documents/brief-header.ts                      # 头部信息视图（Task 5）
  src/documents/documents.ts                         # 新建原生文档的公共步骤、按类型的编号与详情（Task 5）
  src/documents/briefs.ts                            # 新建（Task 5）；头部、闸口、列表（Task 6）；转 PRD、上下文（Task 7）
  src/documents/coverage.ts                          # 简报覆盖需求（Task 6）
  src/links/cards.ts  backlinks.ts  search.ts  src/notifications/match.ts   # Task 5
  src/member-notifications/content.ts  src/requirements/detail.ts           # Task 8
  src/index.ts                                       # Task 2、5
  test/brief-keys.test.ts  brief-model.test.ts  p3c2-schema.test.ts  brief-templates.test.ts
  test/briefs-documents.test.ts  briefs-services.test.ts  brief-convert.test.ts  brief-notify.test.ts
packages/migrate/
  src/write.ts  test/write.test.ts                   # 清理 document_briefs（Task 3）
  src/plan-documents.ts  test/plan-documents.test.ts # 导入时写预置简报模板（Task 4）
  src/perf.ts  test/perf.test.ts                     # 简报用例（Task 15）
apps/web/
  src/server/routes/briefs.ts  templates.ts  src/server/api.ts  test/api/briefs.test.ts   # Task 9
  src/lib/types.ts  queries.ts  api.ts  src/features/documents/model.ts  model.test.ts   # Task 10
  src/components/template-editor.tsx  src/app/(app)/[org]/settings/templates/page.tsx   # Task 10
  src/app/(app)/[org]/documents/page.tsx  briefs-tab.tsx  create-brief-dialog.tsx       # Task 11
  src/app/(app)/[org]/documents/[key]/page.tsx  side-panel.tsx  covered-requirements.tsx
  src/app/(app)/[org]/documents/[key]/brief-side-panel.tsx  brief-header-card.tsx  brief-gate-card.tsx  brief-actions-card.tsx  editor-pane.tsx   # Task 12
  src/app/(app)/[org]/requirements/[key]/brief-card.tsx  prd-card.tsx  page.tsx        # Task 13
  e2e/helpers.ts  e2e/briefs.spec.ts                 # Task 14
docs/p3c2-validation.md  docs/handoff.md  docs/agent-log.md   # Task 16
```

---
### Task 1: 简报的状态、类型、编号与 `[[ ]]` 写法

**Files:**
- Modify: `packages/core/src/documents/constants.ts`、`packages/core/src/documents/markdown.ts`、`packages/core/src/links/syntax.ts`、`packages/core/src/links/links.ts`
- Test: `packages/core/test/brief-keys.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `constants.ts`：`BRIEF_STATUSES = ['discussing', 'ready', 'converted', 'discarded'] as const`、`BriefStatus`；`DOCUMENT_STATUSES` 多三个取值；`DOCUMENT_KINDS = ['change', 'module', 'brief']`；`TEMPLATE_KINDS = ['change', 'brief']`、`TemplateKind`；`BriefRelatedLink = { kind: 'wiki'; target: string; note: string } | { kind: 'url'; url: string; note: string }`；`BriefGateCheck = { item: number; memberId: string; at: string }`
  - `markdown.ts`：`briefDisplayKey(productKey, number): string`（`PAN-B-3`）、`parseBriefKey(key): { productKey; number } | null`、`documentKeyOf(kind: DocumentKind, productKey, number): string`、`BRIEF_TRANSITIONS: Record<BriefStatus, BriefStatus[]>`、`documentTransitions(kind, status): DocumentStatus[]`、`canTransition(from, to, kind = 'change')`；`DOCUMENT_STATUS_LABELS` 多三项
  - `syntax.ts`：`WikiTarget` 多一种 `{ kind: 'brief'; productKey; number; section: string | null }`，`classifyTarget` / `canonicalText` 支持
  - `links.ts`：解析 `[[PAN-PRD-n]]` 只找非简报文档，`[[PAN-B-n]]` 只找简报（`targetType` 都是 `'document'`）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/brief-keys.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  BRIEF_TRANSITIONS,
  briefDisplayKey,
  canTransition,
  DOCUMENT_STATUS_LABELS,
  documentKeyOf,
  documentTransitions,
  parseBriefKey,
  parseDocumentKey,
} from '../src/documents/markdown';
import { canonicalWikiText, classifyTarget, parseWikilinks } from '../src/links/syntax';

describe('简报编号', () => {
  it('显示与解析；PRD 编号与简报编号互不混淆', () => {
    expect(briefDisplayKey('PAN', 3)).toBe('PAN-B-3');
    expect(documentKeyOf('brief', 'PAN', 3)).toBe('PAN-B-3');
    expect(documentKeyOf('change', 'PAN', 3)).toBe('PAN-PRD-3');
    expect(documentKeyOf('module', 'PAN', 3)).toBe('PAN-PRD-3');
    expect(parseBriefKey(' PAN-B-12 ')).toEqual({ productKey: 'PAN', number: 12 });
    expect(parseBriefKey('PAN-PRD-12')).toBeNull();
    expect(parseBriefKey('pan-b-1')).toBeNull();
    expect(parseDocumentKey('PAN-B-12')).toBeNull();
  });
});

describe('简报状态与流转', () => {
  it('中文名称', () => {
    expect([DOCUMENT_STATUS_LABELS.discussing, DOCUMENT_STATUS_LABELS.ready, DOCUMENT_STATUS_LABELS.converted, DOCUMENT_STATUS_LABELS.discarded]).toEqual([
      '讨论中',
      '可写 PRD',
      '已转 PRD',
      '已废弃',
    ]);
  });

  it('按文档类型取流转；已转 PRD 只由转换进入；PRD 的流转不变', () => {
    expect(documentTransitions('brief', 'discussing')).toEqual(['ready', 'discarded']);
    expect(documentTransitions('brief', 'ready')).toEqual(['discussing', 'discarded']);
    expect(documentTransitions('brief', 'converted')).toEqual(['discussing', 'discarded']);
    expect(documentTransitions('brief', 'discarded')).toEqual(['discussing']);
    expect(documentTransitions('brief', 'draft')).toEqual([]);
    expect(documentTransitions('change', 'discarded')).toEqual(['draft']);
    expect(documentTransitions('module', 'active')).toEqual(['archived']);
    expect(Object.values(BRIEF_TRANSITIONS).flat()).not.toContain('converted');
    expect(canTransition('discussing', 'ready', 'brief')).toBe(true);
    expect(canTransition('discussing', 'draft', 'brief')).toBe(false);
    expect(canTransition('draft', 'discussing')).toBe(false);
    expect(canTransition('draft', 'review')).toBe(true);
  });
});

describe('[[ ]] 里的简报编号', () => {
  it('识别为简报，可带小节；规范写法大写；不影响 PRD、需求与任务', () => {
    expect(classifyTarget('pan-b-3#数据依据')).toEqual({ kind: 'brief', productKey: 'PAN', number: 3, section: '数据依据' });
    expect(classifyTarget('PAN-B-3')).toEqual({ kind: 'brief', productKey: 'PAN', number: 3, section: null });
    expect(canonicalWikiText('pan-b-3', 'DOC')).toBe('PAN-B-3');
    expect(canonicalWikiText('PAN-B-3#2. 数据依据', 'PAN')).toBe('PAN-B-3#2. 数据依据');
    expect(classifyTarget('PAN-PRD-3').kind).toBe('document');
    expect(classifyTarget('PAN-T-3').kind).toBe('task');
    expect(classifyTarget('PAN-3').kind).toBe('requirement');
    expect(parseWikilinks('见 [[PAN-B-3|简报]]')[0]).toMatchObject({ target: 'PAN-B-3', label: '简报' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/brief-keys.test.ts`
Expected: FAIL（`briefDisplayKey` 等不存在）。

- [ ] **Step 3: 修改 `documents/constants.ts`**

文件开头的状态与类型改为：

```ts
/** 变更 PRD 的状态。merged 只由合入自动进入（全部影响声明处理完）。 */
export const CHANGE_DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'launched', 'merged', 'discarded'] as const;
export type ChangeDocumentStatus = (typeof CHANGE_DOCUMENT_STATUSES)[number];
/** 模块文档的状态：使用中 / 已归档（只读）。 */
export const MODULE_DOCUMENT_STATUSES = ['active', 'archived'] as const;
/** 需求简报的状态（P3-C2）：讨论中 / 可写 PRD / 已转 PRD / 已废弃。converted 只由「转 PRD」进入。 */
export const BRIEF_STATUSES = ['discussing', 'ready', 'converted', 'discarded'] as const;
export type BriefStatus = (typeof BRIEF_STATUSES)[number];
/** documents.status 的全部取值：三类文档共用一列，discarded 为变更 PRD 与简报共用。 */
export const DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'launched', 'merged', 'discarded', 'active', 'archived', 'discussing', 'ready', 'converted'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_KINDS = ['change', 'module', 'brief'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
/** 有模板的文档类型：变更 PRD 与简报（模块文档没有模板）。 */
export const TEMPLATE_KINDS = ['change', 'brief'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
```

文件末尾加：

```ts
/** 简报头部「关联文档」的一条：[[ ]] 引用（存方括号里的写法）或外部网址，各带一句说明。 */
export type BriefRelatedLink = { kind: 'wiki'; target: string; note: string } | { kind: 'url'; url: string; note: string };
/** 简报闸口人工项的勾选记录：项号、勾选人、时间（ISO 字符串）。 */
export type BriefGateCheck = { item: number; memberId: string; at: string };
```

- [ ] **Step 4: 修改 `documents/markdown.ts`**

1. 第 3 行的类型导入改为：

```ts
import type { BriefStatus, DocumentKind, DocumentStatus, ExternalProvider, RevisionSnapshot, TemplateSection } from './constants';
```

2. `DOCUMENT_STATUS_LABELS` 在 `archived: '已归档',` 之后加：

```ts
  discussing: '讨论中',
  ready: '可写 PRD',
  converted: '已转 PRD',
```

3. `parseDocumentKey` 之后加：

```ts
/** 简报编号（P3-C2）：按产品单独编号。 */
export const briefDisplayKey = (productKey: string, number: number): string => `${productKey}-B-${number}`;

export function parseBriefKey(key: string): { productKey: string; number: number } | null {
  const m = /^([A-Z][A-Z0-9]{1,9})-B-(\d{1,9})$/.exec(key.trim());
  return m ? { productKey: m[1]!, number: Number(m[2]) } : null;
}

/** 文档的显示编号：简报为 `{产品}-B-n`，变更 PRD 与模块文档为 `{产品}-PRD-n`。 */
export const documentKeyOf = (kind: DocumentKind, productKey: string, number: number): string =>
  kind === 'brief' ? briefDisplayKey(productKey, number) : documentDisplayKey(productKey, number);
```

4. `DOCUMENT_TRANSITIONS` 的注释改为「变更 PRD 与模块文档可流转的目标状态。launched → merged 只由合入自动完成，这里没有。模块文档在使用中与已归档之间切换。简报见 BRIEF_TRANSITIONS。」，并在 `archived: ['active'],` 之后加：

```ts
  discussing: [],
  ready: [],
  converted: [],
```

5. 原来的 `canTransition` 整行替换为：

```ts
/** 简报的流转：闸口不限制改状态；已转 PRD 只由「转 PRD」进入，转过之后可以退回讨论中继续改。 */
export const BRIEF_TRANSITIONS: Record<BriefStatus, BriefStatus[]> = {
  discussing: ['ready', 'discarded'],
  ready: ['discussing', 'discarded'],
  converted: ['discussing', 'discarded'],
  discarded: ['discussing'],
};

/** 按文档类型取可流转的目标状态。 */
export function documentTransitions(kind: DocumentKind, status: DocumentStatus): DocumentStatus[] {
  if (kind === 'brief') return BRIEF_TRANSITIONS[status as BriefStatus] ?? [];
  return DOCUMENT_TRANSITIONS[status];
}

export const canTransition = (from: DocumentStatus, to: DocumentStatus, kind: DocumentKind = 'change'): boolean => documentTransitions(kind, from).includes(to);
```

本文件仍然只有 `diff` 与类型导入（`BRIEF_TRANSITIONS` 的键用类型约束，不导入 `BRIEF_STATUSES` 的值）。

- [ ] **Step 5: 修改 `links/syntax.ts`**

1. `DOC_RE` 之后加一行：

```ts
const BRIEF_RE = new RegExp(`^${KEY}-B-(\\d{1,9})(?:#(.*))?$`, 'i');
```

2. `WikiTarget` 在 `document` 一行之后加：

```ts
  /** 需求简报（P3-C2），解析为 target_type = 'document' 的简报文档。 */
  | { kind: 'brief'; productKey: string; number: number; section: string | null }
```

3. `classifyTarget` 在 `DOC_RE` 判断之后加：

```ts
  m = BRIEF_RE.exec(t);
  if (m) return { kind: 'brief', productKey: m[1]!.toUpperCase(), number: Number(m[2]), section: m[3]?.trim() || null };
```

4. `canonicalText` 的 `case 'document':` 之后加：

```ts
    case 'brief':
      return `${t.productKey}-B-${t.number}${t.section ? `#${t.section}` : ''}`;
```

- [ ] **Step 6: 修改 `links/links.ts` 的解析器**

1. 第 1 行导入加 `ne`：

```ts
import { and, asc, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
```

2. `Resolver.resolve` 的 `case 'document':` 整段替换为：

```ts
      case 'document': {
        const pid = await this.productId(t.productKey);
        const [d] = pid
          ? await this.tx
              .select({ id: documents.id })
              .from(documents)
              .where(and(eq(documents.productId, pid), eq(documents.number, t.number), ne(documents.kind, 'brief')))
          : [];
        return out('document', d?.id ?? null, t.section);
      }
      case 'brief': {
        const pid = await this.productId(t.productKey);
        const [d] = pid
          ? await this.tx
              .select({ id: documents.id })
              .from(documents)
              .where(and(eq(documents.productId, pid), eq(documents.number, t.number), eq(documents.kind, 'brief')))
          : [];
        return out('document', d?.id ?? null, t.section);
      }
```

- [ ] **Step 7: 运行测试与类型检查**

Run: `pnpm --filter @flower/core exec vitest run test/brief-keys.test.ts test/markdown.test.ts test/link-syntax.test.ts test/links.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误（`DOCUMENT_STATUS_COLOR` 在 web 侧是 `Record<DocumentStatus, string>`，此时会报缺少三个键——在 `apps/web/src/features/documents/model.ts` 的 `DOCUMENT_STATUS_COLOR` 里先补上 `discussing: '#2f6fd6', ready: '#1f6f54', converted: '#0f766e',`，与本任务一起提交）。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/documents/constants.ts packages/core/src/documents/markdown.ts packages/core/src/links/syntax.ts packages/core/src/links/links.ts packages/core/test/brief-keys.test.ts apps/web/src/features/documents/model.ts
git commit -m "feat(core): 简报的状态、编号与 [[ ]] 写法

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 预置简报模板、闸口判定、转 PRD 拼接与上下文 Markdown（纯函数）

**Files:**
- Create: `packages/core/src/documents/brief-template.ts`、`packages/core/src/documents/brief-model.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/brief-model.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BriefGateCheck`、`BriefRelatedLink`、`BriefStatus`；已有的 `splitSections`、`normalizeHeading`、`plainText`、`squash`、`Section`（`markdown.ts`）
- Produces:
  - `brief-template.ts`：`BRIEF_SECTIONS: ReadonlyArray<{ no: number; heading: string; guidance: string }>`（18 项）、`BRIEF_TEMPLATE: { name: string; guidance: string; body: string; sections: TemplateSection[] }`、`BRIEF_GATE_ITEMS: ReadonlyArray<{ no: number; label: string; auto: boolean }>`（11 项）、`BRIEF_TO_PRD: ReadonlyArray<{ heading: string; level: 2 | 3; from: number[]; note?: string }>`
  - `brief-model.ts`：`BriefGateItem`、`BriefGate = { items: BriefGateItem[]; passed: number; total: number }`、`evaluateBriefGate(input: { markdown; templateBody; checks: BriefGateCheck[]; names: Map<string, string> }): BriefGate`、`briefToPrdMarkdown(input: { briefKey; markdown }): string`、`BriefContext`、`briefContextMarkdown(ctx: BriefContext): string`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/brief-model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { type BriefContext, briefContextMarkdown, briefToPrdMarkdown, evaluateBriefGate, type BriefGate } from '../src/documents/brief-model';
import { BRIEF_GATE_ITEMS, BRIEF_SECTIONS, BRIEF_TEMPLATE, BRIEF_TO_PRD } from '../src/documents/brief-template';
import type { BriefGateCheck } from '../src/documents/constants';
import { missingRequiredSections, splitSections } from '../src/documents/markdown';

const T = BRIEF_TEMPLATE.body;
const gate = (markdown: string, checks: BriefGateCheck[] = []): BriefGate =>
  evaluateBriefGate({ markdown, templateBody: T, checks, names: new Map([['m1', '决策人甲']]) });
const item = (g: BriefGate, no: number) => g.items.find((i) => i.no === no)!;

/** 把第 no 节的正文换成 text（保留标题行）。 */
function fill(md: string, no: number, text: string): string {
  const heading = BRIEF_SECTIONS[no - 1]!.heading;
  return splitSections(md)
    .map((s) => (s.heading === heading ? `${s.markdown.split('\n')[0]}\n\n${text}\n` : s.markdown))
    .join('\n');
}

/** 去掉第 no 节（连同标题）。 */
const drop = (md: string, no: number): string =>
  splitSections(md)
    .filter((s) => s.heading !== BRIEF_SECTIONS[no - 1]!.heading)
    .map((s) => s.markdown)
    .join('\n');

/** 模拟编辑器保存后的写法：表格补空格、分隔线变长、列表符号改为 *、方括号与标题编号加反斜杠。 */
const reformat = (md: string): string =>
  md
    .split('\n')
    .map((l) => (l.startsWith('|') ? l.replace(/\| --- /g, '| ------ ').replace(/ \| /g, '  |  ') : l.startsWith('- ') ? `* ${l.slice(2)}` : l))
    .join('\n')
    .replace(/\[数值\]/g, '\\[数值\\]')
    .replace(/^## (\d+)\. /gm, '## $1\\. ');

const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
const s8 = (rows: string[][]) =>
  ['| # | 要核对的现状 | 结论 | 证据（仓库 文件:行号 / 提交号） | 核对日期 | 和他人说法的差异 |', '| --- | --- | --- | --- | --- | --- |', ...rows.map(row)].join('\n');
const s16 = (flags: string[]) =>
  ['| # | 问题 | 选项 | 建议 | 待谁定 | 是否阻塞 PRD |', '| --- | --- | --- | --- | --- | --- |', ...flags.map((f, i) => row([String(i + 1), `问题${i + 1}`, '', '', '', f]))].join('\n');

describe('预置简报模板', () => {
  it('18 个必填小节与正文的二级标题一一对应；原样模板的每一节都算未填写；闸口 11 项，自动 1、7、10', () => {
    expect(BRIEF_TEMPLATE.sections).toHaveLength(18);
    expect(BRIEF_TEMPLATE.sections.every((s) => s.required)).toBe(true);
    expect(splitSections(T).filter((s) => s.level === 2).map((s) => s.heading)).toEqual(BRIEF_SECTIONS.map((s) => s.heading));
    expect(missingRequiredSections(T, BRIEF_TEMPLATE)).toEqual(BRIEF_SECTIONS.map((s) => s.heading));
    expect(BRIEF_GATE_ITEMS).toHaveLength(11);
    expect(BRIEF_GATE_ITEMS.filter((g) => g.auto).map((g) => g.no)).toEqual([1, 7, 10]);
    expect(BRIEF_TO_PRD.flatMap((c) => c.from).every((n) => n >= 1 && n <= 18)).toBe(true);
    expect(T).not.toMatch(/[`$]/);
    expect(BRIEF_TEMPLATE.guidance.split('\n')).toHaveLength(3);
  });
});

describe('闸口第 1 项：第 1–14 节没有空白', () => {
  it('原样模板与编辑器重排后的模板都算 14 节未填写；7、10 两项通过；人工项未勾选', () => {
    for (const md of [T, reformat(T)]) {
      const g = gate(md);
      expect(item(g, 1).passed).toBe(false);
      expect(item(g, 1).reasons).toHaveLength(14);
      expect(item(g, 1).reasons[0]).toBe('「1. 问题与目标」还没有填写');
      expect(item(g, 1).section).toBe('1. 问题与目标');
      expect(item(g, 7).passed).toBe(true);
      expect(item(g, 10).passed).toBe(true);
      expect([g.passed, g.total]).toEqual([2, 11]);
    }
  });

  it('逐节写了内容后通过；「不适用：理由」算填写；只写「不适用」或「不适用：」不算', () => {
    let md = T;
    for (let no = 1; no <= 14; no++) md = fill(md, no, `第 ${no} 节的结论`);
    expect(item(gate(md), 1)).toMatchObject({ passed: true, reasons: [], section: null });
    expect(item(gate(reformat(md)), 1).passed).toBe(true);
    expect(item(gate(fill(md, 5, '不适用：只有一种对象')), 1).passed).toBe(true);
    for (const text of ['不适用：', '不适用', '不适用： ']) {
      const g = gate(fill(md, 5, text));
      expect(item(g, 1).reasons, text).toEqual(['「5. 对象与状态」写了「不适用」但没有写理由']);
      expect(item(g, 1).section).toBe('5. 对象与状态');
    }
  });

  it('表格单元格里填了答案即算填写；缺小节时说明缺哪一节，不给定位', () => {
    const cell = T.replace('| 要解决什么问题（带数字） | |', '| 要解决什么问题（带数字） | 上传失败率 3% |');
    expect(item(gate(cell), 1).reasons).toHaveLength(13);
    expect(item(gate(cell), 1).reasons[0]).toBe('「2. 数据依据」还没有填写');
    let md = T;
    for (let no = 1; no <= 14; no++) md = fill(md, no, '已填写');
    expect(item(gate(drop(md, 9)), 1)).toMatchObject({ passed: false, reasons: ['缺少小节「9. 可行性与性能」'], section: null });
  });
});

describe('闸口第 7、10 项', () => {
  it('第 8 节：填了结论的行必须有证据与核对日期', () => {
    const ok = fill(T, 8, s8([['1', '上传限速', '有', 'web/upload.ts:42', '2026-10-10', ''], ['2', '下载限速', '', '', '', '']]));
    expect(item(gate(ok), 7).passed).toBe(true);
    const bad = fill(T, 8, s8([['1', '上传限速', '有', '', '2026-10-10', ''], ['2', '秒传', '无', '', ' ', '']]));
    expect(item(gate(bad), 7)).toMatchObject({ passed: false, reasons: ['第 1 行缺少「证据」', '第 2 行缺少「证据」「核对日期」'], section: '8. 现状核对' });
    expect(item(gate(reformat(bad)), 7).reasons).toHaveLength(2);
    expect(item(gate(drop(T, 8)), 7).reasons).toEqual(['缺少小节「8. 现状核对」']);
  });

  it('第 16 节：「是否阻塞 PRD」为「是」的问题不通过；模板默认的「是 / 否」不算', () => {
    expect(item(gate(fill(T, 16, s16(['否', '是 / 否']))), 10).passed).toBe(true);
    expect(item(gate(fill(T, 16, s16(['否', '是']))), 10)).toMatchObject({ passed: false, reasons: ['第 2 个待定问题标为阻塞 PRD'], section: '16. 待定问题' });
    expect(item(gate(drop(T, 16)), 10).reasons).toEqual(['缺少小节「16. 待定问题」']);
  });
});

describe('闸口人工项', () => {
  it('勾选记录带勾选人与时间；成员已删除时显示「已删除的成员」；勾选记录里的自动项编号被忽略', () => {
    const g = gate(T, [
      { item: 2, memberId: 'm1', at: '2026-10-14T02:00:00.000Z' },
      { item: 4, memberId: 'gone', at: '2026-10-14T03:00:00.000Z' },
      { item: 7, memberId: 'm1', at: '2026-10-14T04:00:00.000Z' },
    ]);
    expect(item(g, 2)).toMatchObject({ auto: false, passed: true, checkedBy: { id: 'm1', displayName: '决策人甲' }, checkedAt: '2026-10-14T02:00:00.000Z' });
    expect(item(g, 4).checkedBy).toEqual({ id: 'gone', displayName: '已删除的成员' });
    expect(item(g, 3)).toMatchObject({ passed: false, checkedBy: null, checkedAt: null });
    expect(item(g, 7)).toMatchObject({ auto: true, checkedBy: null });
    expect(g.passed).toBe(4);
  });
});

describe('转 PRD 的拼接', () => {
  it('按第 18 节的对应表生成章节；每章注明来源小节并原样放入内容；空节写明为空', () => {
    let md = fill(T, 1, '上传失败率 3%');
    md = fill(md, 16, s16(['否']));
    const prd = briefToPrdMarkdown({ briefKey: 'PAN-B-2', markdown: md });
    expect(prd.split('\n')[0]).toBe('> 由简报 [[PAN-B-2]] 生成。各章节下的引用块注明内容来自简报的哪一节，请按 PRD 的写法改写后再提交评审。');
    const sections = splitSections(prd);
    expect(sections.filter((s) => s.heading).map((s) => s.heading)).toEqual(BRIEF_TO_PRD.map((c) => c.heading));
    const of = (h: string) => sections.find((s) => s.heading === h)!.markdown;
    expect(of('1. 背景介绍')).toContain('> 来自简报第 1 节「问题与目标」\n\n上传失败率 3%');
    expect(of('1. 背景介绍')).toContain('> 来自简报第 2 节「数据依据」');
    expect(of('6.2 开放问题')).toContain('| 1 | 问题1 |');
    expect(of('7. 测试要点')).toContain('> 取第 4 节的边界情况、第 7 节的算例、第 10 节');
    expect(briefToPrdMarkdown({ briefKey: 'PAN-B-2', markdown: '' })).toContain('（简报中这一节为空）');
    expect(missingRequiredSections(prd, { body: '', sections: [{ heading: '1. 背景介绍', required: true }, { heading: '3. 需求说明', required: true }] })).toEqual([]);
  });
});

describe('上下文 Markdown', () => {
  it('头部表、覆盖的需求、闸口与正文；表格单元格里的竖线转义，空值写「—」', () => {
    const ctx: BriefContext = {
      brief: {
        id: 'b1',
        displayKey: 'PAN-B-2',
        title: '上传提速',
        status: 'discussing',
        statusLabel: '讨论中',
        product: { key: 'PAN', name: '网盘' },
        version: 'v0.2',
        requester: null,
        decider: '决策人甲',
        author: '作者乙',
        participants: ['产品', '后端'],
        relatedLinks: [
          { kind: 'wiki', target: 'PAN-PRD-1', note: '旧方案' },
          { kind: 'url', url: 'https://doc.example.com/a|b', note: '' },
        ],
        convertedDocument: null,
        updatedAt: '2026-10-14T02:00:00.000Z',
      },
      requirements: [{ displayKey: 'PAN-12', title: '上传 | 提速', state: '设计中' }],
      gate: gate(T),
      markdown: '## 1. 问题与目标\n\n正文\n',
    };
    const out = briefContextMarkdown(ctx);
    expect(out.startsWith('# PAN-B-2 上传提速\n')).toBe(true);
    expect(out).toContain('| 产品 | 网盘（PAN） |');
    expect(out).toContain('| 决策人 | 决策人甲 |');
    expect(out).toContain('| 提出人 | — |');
    expect(out).toContain('| 参与方 | 产品、后端 |');
    expect(out).toContain('| 关联文档 | [[PAN-PRD-1]] 旧方案；https://doc.example.com/a\\|b |');
    expect(out).toContain('| 转出的 PRD | — |');
    expect(out).toContain('| PAN-12 | 上传 \\| 提速 | 设计中 |');
    expect(out).toContain('## 写 PRD 闸口（2/11）');
    expect(out).toContain('- [ ] 1. 第 1~14 节没有空白，不涉及的都写了理由：「1. 问题与目标」还没有填写；');
    expect(out).toContain('- [x] 7. 第 8 节的每条现状都有代码证据和核对日期\n');
    expect(out).toContain('- [ ] 2. 第 1 节的问题有数字支撑（第 2 节）（人工确认）');
    expect(out.endsWith('## 正文\n\n## 1. 问题与目标\n\n正文\n')).toBe(true);
    expect(briefContextMarkdown({ ...ctx, requirements: [] })).toContain('## 覆盖的需求\n\n没有覆盖需求\n');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/brief-model.test.ts`
Expected: FAIL（`brief-template`、`brief-model` 不存在）。

- [ ] **Step 3: 新建 `packages/core/src/documents/brief-template.ts`**

模板正文与迁移 0022 里的 SQL 字面量必须逐字一致（Task 3 的测试会比对）；空单元格一律写成 `| |`（一个空格），正文里不出现反引号与 `$`。

```ts
import type { TemplateSection } from './constants';

/**
 * 预置「需求简报」模板（P3-C2，用户提供，设计附录 A）。头部信息表不进正文（结构化字段，见 document_briefs）；
 * 「用法」三条是模板说明，显示在编辑器上方。不预填任何人名。迁移 0022 的 SQL 与这里逐字一致。
 */

export const BRIEF_SECTIONS: ReadonlyArray<{ no: number; heading: string; guidance: string }> = [
  { no: 1, heading: '1. 问题与目标', guidance: '要解决的问题带数字；写清明确不做什么' },
  { no: 2, heading: '2. 数据依据', guidance: '取数口径必须和第 7 节一致' },
  { no: 3, heading: '3. 受影响用户', guidance: '估出影响人数与付费用户占比' },
  { no: 4, heading: '4. 场景清单', guidance: '边界情况逐条写：刚好等于阈值、进行中状态变化、多端同时操作、撤销与恢复' },
  { no: 5, heading: '5. 对象与状态', guidance: '有多状态、多层级、多个相似对象时必填；不涉及写「不适用：理由」' },
  { no: 6, heading: '6. 规则与方案', guidance: '核心规则一句话；未定的数值列进第 16 节' },
  { no: 7, heading: '7. 计算口径与算法', guidance: '涉及阈值、计数、排名、计费、配额时必填；每个指标写公式、口径与至少 3 个算例' },
  { no: 8, heading: '8. 现状核对', guidance: '实读代码；每条现状写证据（仓库 文件:行号 / 提交号）与核对日期' },
  { no: 9, heading: '9. 可行性与性能', guidance: '研发给出可行性结论' },
  { no: 10, heading: '10. 影响面与兼容', guidance: '各端逐一确认老版本表现' },
  { no: 11, heading: '11. 用户感知与触达', guidance: '文案写原文' },
  { no: 12, heading: '12. 商业与合规', guidance: '已付费权益、协议、退款与法务意见' },
  { no: 13, heading: '13. 上线策略', guidance: '灰度、开关、回滚与观察指标' },
  { no: 14, heading: '14. 分工', guidance: '每个角色写负责人与时间点' },
  { no: 15, heading: '15. 决策日志', guidance: '结论被推翻时在这里记录推翻的过程' },
  { no: 16, heading: '16. 待定问题', guidance: '「是否阻塞 PRD」填「是」或「否」' },
  { no: 17, heading: '17. 写 PRD 闸口', guidance: '闸口结果以侧栏「写 PRD 闸口」为准' },
  { no: 18, heading: '18. 与 PRD 章节的对应', guidance: '转 PRD 时按此表拼接' },
];

const BODY = `## 1. 问题与目标

| 问题 | 回答 |
| --- | --- |
| 要解决什么问题（带数字） | |
| 为什么现在做 | |
| 做成以后是什么样（可衡量） | |
| 明确不做什么 | |
| 不做会怎样 | |

## 2. 数据依据

| # | 要回答的问题 | 取数表 | 结论 | 口径 / 数据日期 |
| --- | --- | --- | --- | --- |
| 1 | | 表 x | | |

- 还没拿到的数据：
- 数据推翻了哪些原有设想：
- 取数口径必须和第 7 节一致；口径变了要重跑的表：

## 3. 受影响用户

| 用户群 | 人数 / 占比 | 其中付费用户 | 影响程度 | 怎么处理 |
| --- | --- | --- | --- | --- |
| | | | 无感 / 有提示 / 被限制 | |

- 会不会误伤（正常用户、付费用户、大客户）：
- 是否需要提前沟通（商务外联、客服预案）：

## 4. 场景清单

| # | 场景 | 现在怎样 | 改后怎样 | 边界情况 |
| --- | --- | --- | --- | --- |
| 1 | | | | 刚好等于阈值 / 进行中状态变化 / 多端同时操作 / 撤销与恢复 |

## 5. 对象与状态

**对象定义**

| 对象 | 定义 | 用户是否可见 | 和相似对象的区别 |
| --- | --- | --- | --- |
| | | | |

**状态表**

| 状态 | 进入条件 | 能做 / 不能做 | 用户看到什么 | 怎么离开 |
| --- | --- | --- | --- | --- |
| | | | | |

## 6. 规则与方案

- 核心规则（一句话）：
- 规则明细：

| # | 规则 | 数值 | 状态 |
| --- | --- | --- | --- |
| 1 | | [数值] | 已定 / 待定 |

- 候选方案对比：

| 方案 | 做法 | 优点 | 代价 / 风险 | 结论 |
| --- | --- | --- | --- | --- |
| A | | | | 选定 |
| B | | | | 否决：理由 |

## 7. 计算口径与算法

**指标定义**

| 指标 | 一句话定义 | 公式 | 单位 / 取值范围 | 用在哪（规则 / 展示 / 统计） |
| --- | --- | --- | --- | --- |
| | | | | |

**口径细节**（每个指标逐项写清，不涉及的写「不适用」）

| 问题 | 回答 |
| --- | --- |
| 统计对象：按用户 / 文件 / 设备 / 账号主体 | |
| 包含与排除：回收站、已删除、分享转存、离线下载、秒传、系统文件、子账号 | |
| 去重规则：同内容多份、同一文件多次引用怎么算 | |
| 时间窗口：自然日 / 自然月 / 滚动 30 天；起止时刻和时区 | |
| 计算时机：实时 / 增量更新 / 定时全量重算；多久生效 | |
| 取整与精度：向上 / 向下取整、保留几位、单位换算（1TB=1024GB） | |
| 边界：刚好等于阈值、为 0、为负、溢出 | |
| 数据来源：哪张表、哪个字段；与 DBA 取数口径是否一致 | |
| 结果会不会被用户操作反复改变，怎么防止抖动 | |

**阈值与参数**

| 参数 | 取值 | 依据（第 2 节表 x） | 能否后台调整 |
| --- | --- | --- | --- |
| | | | |

**算例**（至少 3 个：普通情况、刚好在边界、极端情况）

| # | 输入 | 计算过程 | 结果 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | | | | |

**口径变更记录**

| 日期 | 改了什么 | 原因 | 影响哪些数据和规则 |
| --- | --- | --- | --- |
| | | | |

## 8. 现状核对

| # | 要核对的现状 | 结论 | 证据（仓库 文件:行号 / 提交号） | 核对日期 | 和他人说法的差异 |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | |

- 没有核到的范围（仓库没拉、只有快照、线上配置）：

## 9. 可行性与性能

| 问题 | 回答 |
| --- | --- |
| 涉及哪些链路（上传、转存、删除、下载……） | |
| 量级（用户数、文件数、每日新增、峰值） | |
| 会不会拖慢核心链路 | |
| 计算 / 存储 / 队列方案 | |
| 需要压测验证的项 | |
| 历史上类似方案出过的问题 | |
| 研发评估结论 | 可行 / 有条件可行（条件） / 不可行 |

## 10. 影响面与兼容

| 端 / 对象 | 是否受影响 | 老版本表现 | 要不要发版 | 处理 |
| --- | --- | --- | --- | --- |
| Web | | | | |
| PC 客户端 | | | | |
| 同步盘 | | | | |
| App（iOS / Android） | | | | |
| 小程序 | | | | |
| TV | | | | |
| 开放平台 / 第三方 | | | | |
| 运营后台 | | | | |
| 存量数据 | | | | 是否要迁移、重算、对账 |

- 与其他在做或已上线需求的交叉、冲突：

## 11. 用户感知与触达

| 问题 | 回答 |
| --- | --- |
| 用户在什么时候、什么页面看到什么（文案原文） | |
| 触达方式（弹窗 / 站内信 / 公告 / 短信） | |
| 规则是否对外公开 | |
| 客服口径 | |
| 舆论风险及预案 | |

## 12. 商业与合规

| 问题 | 回答 |
| --- | --- |
| 是否影响已付费权益、在售商品、自动续费 | |
| 协议是否要改 | |
| 退款、补偿规则 | |
| 法务意见 | |

## 13. 上线策略

| 问题 | 回答 |
| --- | --- |
| 前置依赖（必须先完成的事） | |
| 分阶段 / 灰度方式 | |
| 开关与参数是否可配置 | |
| 出问题怎么回滚 | |
| 上线后观察什么指标、观察多久 | |

## 14. 分工

| 角色 | 负责人 | 负责什么 | 时间点 |
| --- | --- | --- | --- |
| 产品 | | | |
| 后端 | | | |
| 客户端 | | | |
| 测试 | | | |
| DBA | | | |
| 商业化 / 客服 / 法务 | | | |

## 15. 决策日志

| 日期 | 决定 | 谁定 | 理由 | 替代了哪条 |
| --- | --- | --- | --- | --- |
| | | | | |

## 16. 待定问题

| # | 问题 | 选项 | 建议 | 待谁定 | 是否阻塞 PRD |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | 是 / 否 |

## 17. 写 PRD 闸口

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 第 1~14 节没有空白，不涉及的都写了理由 | |
| 2 | 第 1 节的问题有数字支撑（第 2 节） | |
| 3 | 第 3 节已估出影响人数和付费用户占比 | |
| 4 | 第 5 节对象与状态已确认（或注明不适用） | |
| 5 | 第 6 节核心规则已定；未定的数值都在第 16 节 | |
| 6 | 第 7 节每个指标都有公式、口径和算例，且与取数需求口径一致 | |
| 7 | 第 8 节的每条现状都有代码证据和核对日期 | |
| 8 | 第 9 节研发给出了可行性结论 | |
| 9 | 第 10 节各端都过了一遍，老版本表现已确认 | |
| 10 | 第 16 节没有「阻塞 PRD」的问题 | |
| 11 | 决策人确认过第 1、6、7、13 节 | |

## 18. 与 PRD 章节的对应

| PRD 章节 | 取自简报 |
| --- | --- |
| 1 背景介绍 | 第 1、2 节 |
| 2.1 定位、2.2 服务对象 | 第 1、3 节 |
| 2.3 适用平台 | 第 10 节 |
| 2.4 角色术语、2.5 状态表 | 第 5 节 |
| 3.1 需求列表、3.6 需求明细 | 第 4、6 节 |
| 3.2 整体流程 | 第 4、5、6 节 |
| 3.3 计算规则、分层上线 | 第 7、13 节 |
| 3.7 站内信 / 公告 | 第 11 节 |
| 4 技术约束与接口 | 第 7、8、9 节 |
| 5 成功指标 | 第 1、7、13 节 |
| 6.1 依赖 | 第 13、14 节 |
| 6.2 开放问题 | 第 16 节 |
| 7 测试要点 | 第 4 节的边界情况、第 7 节的算例、第 10 节 |
| 客服 FAQ | 第 11 节 |
| 变更记录 | 第 15 节 |
`;

const GUIDANCE = `- 简报记录的是讨论到当前为止的结论，不是会议流水账。结论被推翻时直接改正文，推翻的过程记进第 15 节「决策日志」。
- 每一节都必须填写；不涉及的写「不适用：理由」，不能空着。
- 第 17 节的闸口全部通过后才能开始写 PRD。PRD 的各章节从对应小节取内容（见第 18 节）。`;

export const BRIEF_TEMPLATE: { name: string; guidance: string; body: string; sections: TemplateSection[] } = {
  name: '需求简报（预置）',
  guidance: GUIDANCE,
  body: BODY,
  sections: BRIEF_SECTIONS.map((s) => ({ heading: s.heading, required: true, guidance: s.guidance })),
};

/** 写 PRD 闸口（附录 A 第 17 节）：1、7、10 由系统检查，其余人工勾选。 */
export const BRIEF_GATE_ITEMS: ReadonlyArray<{ no: number; label: string; auto: boolean }> = [
  { no: 1, label: '第 1~14 节没有空白，不涉及的都写了理由', auto: true },
  { no: 2, label: '第 1 节的问题有数字支撑（第 2 节）', auto: false },
  { no: 3, label: '第 3 节已估出影响人数和付费用户占比', auto: false },
  { no: 4, label: '第 5 节对象与状态已确认（或注明不适用）', auto: false },
  { no: 5, label: '第 6 节核心规则已定；未定的数值都在第 16 节', auto: false },
  { no: 6, label: '第 7 节每个指标都有公式、口径和算例，且与取数需求口径一致', auto: false },
  { no: 7, label: '第 8 节的每条现状都有代码证据和核对日期', auto: true },
  { no: 8, label: '第 9 节研发给出了可行性结论', auto: false },
  { no: 9, label: '第 10 节各端都过了一遍，老版本表现已确认', auto: false },
  { no: 10, label: '第 16 节没有「阻塞 PRD」的问题', auto: true },
  { no: 11, label: '决策人确认过第 1、6、7、13 节', auto: false },
];

/**
 * 转 PRD 的章节与来源小节（附录 A 第 18 节）。「2. 产品概述」「3. 需求说明」「6. 依赖与开放问题」是为二、三级章节补的上级标题，
 * 本身没有来源；「1. 背景介绍」「3. 需求说明」与预置 PRD 模板的必填小节同名。
 */
export const BRIEF_TO_PRD: ReadonlyArray<{ heading: string; level: 2 | 3; from: number[]; note?: string }> = [
  { heading: '1. 背景介绍', level: 2, from: [1, 2] },
  { heading: '2. 产品概述', level: 2, from: [] },
  { heading: '2.1 定位、2.2 服务对象', level: 3, from: [1, 3] },
  { heading: '2.3 适用平台', level: 3, from: [10] },
  { heading: '2.4 角色术语、2.5 状态表', level: 3, from: [5] },
  { heading: '3. 需求说明', level: 2, from: [] },
  { heading: '3.1 需求列表、3.6 需求明细', level: 3, from: [4, 6] },
  { heading: '3.2 整体流程', level: 3, from: [4, 5, 6] },
  { heading: '3.3 计算规则、分层上线', level: 3, from: [7, 13] },
  { heading: '3.7 站内信 / 公告', level: 3, from: [11] },
  { heading: '4. 技术约束与接口', level: 2, from: [7, 8, 9] },
  { heading: '5. 成功指标', level: 2, from: [1, 7, 13] },
  { heading: '6. 依赖与开放问题', level: 2, from: [] },
  { heading: '6.1 依赖', level: 3, from: [13, 14] },
  { heading: '6.2 开放问题', level: 3, from: [16] },
  { heading: '7. 测试要点', level: 2, from: [4, 7, 10], note: '取第 4 节的边界情况、第 7 节的算例、第 10 节' },
  { heading: '客服 FAQ', level: 2, from: [11] },
  { heading: '变更记录', level: 2, from: [15] },
];
```

- [ ] **Step 4: 新建 `packages/core/src/documents/brief-model.ts`**

```ts
import { BRIEF_GATE_ITEMS, BRIEF_SECTIONS, BRIEF_TO_PRD } from './brief-template';
import type { BriefGateCheck, BriefRelatedLink, BriefStatus } from './constants';
import { normalizeHeading, plainText, type Section, splitSections, squash } from './markdown';

export type BriefGateItem = {
  no: number;
  label: string;
  auto: boolean;
  passed: boolean;
  /** 自动项未通过的原因；人工项为空。 */
  reasons: string[];
  /** 自动项未通过时可以定位到的小节标题（模板里的写法）。 */
  section: string | null;
  checkedBy: { id: string; displayName: string } | null;
  checkedAt: string | null;
};
export type BriefGate = { items: BriefGateItem[]; passed: number; total: number };

type Check = { reasons: string[]; section: string | null };
type Table = { header: string[]; rows: string[][] };

/** 表格分隔行（含编辑器写出的任意长度分隔线）与分隔线。 */
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** 一行的比较形式：去掉 Markdown 符号与全部空白；分隔行与空行为空串。编辑器保存时的格式差异（空格、列表符号、转义）都被抹平。 */
const norm = (line: string): string => (RULE.test(line) ? '' : squash(plainText(line.trim())));
/** 小节标题的比较形式：去掉反斜杠（编辑器会写成 `1\.`）、开头的编号与空白。 */
const headKey = (heading: string): string => normalizeHeading(heading.replace(/\\/g, ''));
const NOT_APPLICABLE = /^不适用(?:[:：](.*))?$/;

/** 小节及其下级小节的正文行（不含本节标题行）；找不到小节时为 null。 */
function ownLines(sections: Section[], heading: string): string[] | null {
  const want = headKey(heading);
  const i = sections.findIndex((s) => s.heading !== null && headKey(s.heading) === want);
  if (i === -1) return null;
  const lines = sections[i]!.markdown.split('\n').slice(1);
  for (let j = i + 1; j < sections.length && sections[j]!.level > sections[i]!.level; j++) lines.push(...sections[j]!.markdown.split('\n'));
  return lines;
}

/** 去掉模板原样内容之后：没有内容为 blank；只剩「不适用」且没有理由为 no_reason；否则为 filled。 */
function fillState(lines: string[], template: Set<string>): 'filled' | 'blank' | 'no_reason' {
  const own = lines.map(norm).filter((l) => l !== '' && !template.has(l));
  if (own.length === 0) return 'blank';
  return own.every((l) => {
    const m = NOT_APPLICABLE.exec(l);
    return m !== null && !m[1];
  })
    ? 'no_reason'
    : 'filled';
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(norm);

/** 连续以 | 开头、第二行是分隔行的几行为一张表。 */
function tablesIn(lines: string[]): Table[] {
  const out: Table[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length >= 2 && RULE.test(block[1]!)) out.push({ header: cells(block[0]!), rows: block.slice(2).map(cells) });
    block = [];
  };
  for (const l of lines) {
    if (l.trim().startsWith('|')) block.push(l);
    else flush();
  }
  flush();
  return out;
}

const column = (t: Table, prefix: string): number => t.header.findIndex((h) => h.startsWith(prefix));
const rowLabel = (t: Table, r: string[], i: number): string => {
  const c = column(t, '#');
  return (c !== -1 && r[c]) || String(i + 1);
};

function blankCheck(sections: Section[], template: Set<string>): Check {
  const reasons: string[] = [];
  let section: string | null = null;
  for (const s of BRIEF_SECTIONS.slice(0, 14)) {
    const lines = ownLines(sections, s.heading);
    if (!lines) {
      reasons.push(`缺少小节「${s.heading}」`);
      continue;
    }
    const state = fillState(lines, template);
    if (state === 'filled') continue;
    reasons.push(state === 'blank' ? `「${s.heading}」还没有填写` : `「${s.heading}」写了「不适用」但没有写理由`);
    section ??= s.heading;
  }
  return { reasons, section };
}

/** 第 no 节的表格逐行检查；缺小节时不通过。 */
function tableCheck(sections: Section[], no: number, rowReasons: (t: Table) => string[]): Check {
  const heading = BRIEF_SECTIONS[no - 1]!.heading;
  const lines = ownLines(sections, heading);
  if (!lines) return { reasons: [`缺少小节「${heading}」`], section: null };
  const reasons = tablesIn(lines).flatMap(rowReasons);
  return { reasons, section: reasons.length > 0 ? heading : null };
}

const evidenceReasons = (t: Table): string[] => {
  const [c, e, d] = [column(t, '结论'), column(t, '证据'), column(t, '核对日期')];
  if (c === -1 || e === -1 || d === -1) return [];
  return t.rows.flatMap((r, i) => {
    if (!r[c]) return [];
    const missing = [...(r[e] ? [] : ['证据']), ...(r[d] ? [] : ['核对日期'])];
    return missing.length > 0 ? [`第 ${rowLabel(t, r, i)} 行缺少「${missing.join('」「')}」`] : [];
  });
};

const blockingReasons = (t: Table): string[] => {
  const b = column(t, '是否阻塞');
  if (b === -1) return [];
  return t.rows.flatMap((r, i) => (r[b] === '是' ? [`第 ${rowLabel(t, r, i)} 个待定问题标为阻塞 PRD`] : []));
};

/**
 * 写 PRD 闸口（设计 §3.5）：自动项按当前正文计算，人工项看勾选记录。templateBody 是简报所用模板的正文，
 * 与模板原样相同的行不算内容。names 为勾选人的当前姓名。
 */
export function evaluateBriefGate(input: { markdown: string; templateBody: string; checks: BriefGateCheck[]; names: Map<string, string> }): BriefGate {
  const sections = splitSections(input.markdown);
  const template = new Set(input.templateBody.split('\n').map(norm).filter((l) => l !== ''));
  const auto: Record<number, () => Check> = {
    1: () => blankCheck(sections, template),
    7: () => tableCheck(sections, 8, evidenceReasons),
    10: () => tableCheck(sections, 16, blockingReasons),
  };
  const items = BRIEF_GATE_ITEMS.map((g): BriefGateItem => {
    if (g.auto) {
      const r = auto[g.no]!();
      return { no: g.no, label: g.label, auto: true, passed: r.reasons.length === 0, reasons: r.reasons, section: r.section, checkedBy: null, checkedAt: null };
    }
    const c = input.checks.find((x) => x.item === g.no);
    return {
      no: g.no,
      label: g.label,
      auto: false,
      passed: !!c,
      reasons: [],
      section: null,
      checkedBy: c ? { id: c.memberId, displayName: input.names.get(c.memberId) ?? '已删除的成员' } : null,
      checkedAt: c?.at ?? null,
    };
  });
  return { items, passed: items.filter((i) => i.passed).length, total: items.length };
}

const sectionName = (heading: string): string => heading.replace(/^\d+\.\s*/, '');

/** 转 PRD（设计 §3.6）：按 BRIEF_TO_PRD 生成章节，每章依次放来源小节的原文，前面用引用块注明来源。 */
export function briefToPrdMarkdown(input: { briefKey: string; markdown: string }): string {
  const sections = splitSections(input.markdown);
  const out: string[] = [`> 由简报 [[${input.briefKey}]] 生成。各章节下的引用块注明内容来自简报的哪一节，请按 PRD 的写法改写后再提交评审。`, ''];
  for (const ch of BRIEF_TO_PRD) {
    out.push(`${'#'.repeat(ch.level)} ${ch.heading}`, '');
    if (ch.note) out.push(`> ${ch.note}`, '');
    for (const no of ch.from) {
      const s = BRIEF_SECTIONS[no - 1]!;
      const text = (ownLines(sections, s.heading) ?? []).join('\n').trim();
      out.push(`> 来自简报第 ${no} 节「${sectionName(s.heading)}」`, '', text || '（简报中这一节为空）', '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** 上下文接口与「复制为 Markdown」的内容（设计 §3.7）。时间为 ISO 字符串。 */
export type BriefContext = {
  brief: {
    id: string;
    displayKey: string;
    title: string;
    status: BriefStatus;
    statusLabel: string;
    product: { key: string; name: string };
    version: string;
    requester: string | null;
    decider: string | null;
    author: string | null;
    participants: string[];
    relatedLinks: BriefRelatedLink[];
    convertedDocument: { displayKey: string; title: string; statusLabel: string } | null;
    updatedAt: string;
  };
  requirements: Array<{ displayKey: string; title: string; state: string }>;
  gate: BriefGate;
  markdown: string;
};

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim() || '—';
const linkText = (l: BriefRelatedLink): string => `${l.kind === 'wiki' ? `[[${l.target}]]` : l.url}${l.note ? ` ${l.note}` : ''}`;

export function briefContextMarkdown(ctx: BriefContext): string {
  const b = ctx.brief;
  const rows: Array<[string, string]> = [
    ['产品', `${b.product.name}（${b.product.key}）`],
    ['状态', b.statusLabel],
    ['版本', b.version],
    ['提出人', b.requester ?? ''],
    ['决策人', b.decider ?? ''],
    ['参与方', b.participants.join('、')],
    ['作者', b.author ?? ''],
    ['关联文档', b.relatedLinks.map(linkText).join('；')],
    ['转出的 PRD', b.convertedDocument ? `${b.convertedDocument.displayKey} ${b.convertedDocument.title}（${b.convertedDocument.statusLabel}）` : ''],
    ['更新时间', b.updatedAt],
  ];
  const out = [`# ${b.displayKey} ${b.title}`, '', '| 项 | 内容 |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`), '', '## 覆盖的需求', ''];
  if (ctx.requirements.length === 0) out.push('没有覆盖需求');
  else out.push('| 编号 | 标题 | 状态 |', '| --- | --- | --- |', ...ctx.requirements.map((r) => `| ${r.displayKey} | ${cell(r.title)} | ${cell(r.state)} |`));
  out.push('', `## 写 PRD 闸口（${ctx.gate.passed}/${ctx.gate.total}）`, '');
  for (const i of ctx.gate.items) {
    const tail = i.auto ? (i.passed ? '' : `：${i.reasons.join('；')}`) : i.checkedBy ? `（人工确认：${i.checkedBy.displayName}，${i.checkedAt}）` : '（人工确认）';
    out.push(`- [${i.passed ? 'x' : ' '}] ${i.no}. ${i.label}${tail}`);
  }
  out.push('', '## 正文', '', ctx.markdown.trim());
  return `${out.join('\n')}\n`;
}
```

- [ ] **Step 5: 加入包入口**

`packages/core/src/index.ts` 在 `export * from './documents/module-sections';` 之后加：

```ts
export * from './documents/brief-template';
export * from './documents/brief-model';
```

新导出名 `BRIEF_SECTIONS`、`BRIEF_TEMPLATE`、`BRIEF_GATE_ITEMS`、`BRIEF_TO_PRD`、`BriefGateItem`、`BriefGate`、`evaluateBriefGate`、`briefToPrdMarkdown`、`BriefContext`、`briefContextMarkdown` 在 `packages/core/src` 里没有同名导出（写计划时已检索；执行前再跑一次 `grep -rn "export .*\(BRIEF_\|BriefGate\|BriefContext\|evaluateBriefGate\|briefToPrdMarkdown\|briefContextMarkdown\)" packages/core/src`，只应命中这两个新文件）。

- [ ] **Step 6: 运行测试确认通过，类型检查并提交**

Run: `pnpm --filter @flower/core exec vitest run test/brief-model.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

```bash
git add packages/core/src/documents/brief-template.ts packages/core/src/documents/brief-model.ts packages/core/src/index.ts packages/core/test/brief-model.test.ts
git commit -m "feat(core): 预置简报模板、写 PRD 闸口判定、转 PRD 拼接与上下文 Markdown

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: 数据模型：简报编号、头部表（RLS）、需求挂简报、模板说明、补齐预置简报模板

**Files:**
- Modify: `packages/core/src/db/schema.ts`、`packages/migrate/src/write.ts`、`packages/migrate/test/write.test.ts`
- Create: `packages/core/migrations/0021_*.sql`（生成）、`packages/core/migrations/0022_p3c2_briefs.sql`（`--custom` 生成后填写）、`packages/core/migrations/meta/*`（生成）
- Test: `packages/core/test/p3c2-schema.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DOCUMENT_KINDS`、`DOCUMENT_STATUSES`、`BriefRelatedLink`、`BriefGateCheck`；Task 2 的 `BRIEF_TEMPLATE`
- Produces:
  - 表 `documentBriefs`（经 `@flower/core` 导出）：`documentId`（主键，引用 `documents.id`）、`orgId`、`version`（默认 `'v0.1'`）、`requesterMemberId`、`deciderMemberId`、`authorMemberId`、`participantTagIds: string[]`、`relatedLinks: BriefRelatedLink[]`、`gateChecks: BriefGateCheck[]`、`convertedDocumentId`、`updatedAt`
  - 新列：`products.briefSeq`、`requirements.briefDocumentId`（带索引 `requirements_brief_document`）、`documentTemplates.guidance`（默认 `''`）；`documentTemplates.kind` 取值加 `'brief'`
  - `documents` 的编号唯一索引拆为 `documents_product_number`（非简报）与 `documents_product_brief_number`（简报）两个部分索引
  - `deleteOrgData` 清理 `document_briefs`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/p3c2-schema.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentBriefs, documents, documentTemplates, organizations, products, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { BRIEF_TEMPLATE } from '../src/documents/brief-template';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
const orgB = newId();

/** 迁移 0022 除前两段（开启 RLS、建策略）以外的语句：补齐预置简报模板。 */
const BACKFILL = readFileSync(new URL('../migrations/0022_p3c2_briefs.sql', import.meta.url), 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(2);
const runBackfill = async () => {
  for (const s of BACKFILL) await t.adminDb.execute(sql.raw(s));
};
const doc = (number: number, kind: 'change' | 'brief', title: string) => ({
  orgId: owner.orgId,
  productId,
  number,
  kind,
  source: 'native' as const,
  title,
  status: kind === 'brief' ? ('discussing' as const) : ('draft' as const),
});

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  await t.adminDb.insert(organizations).values({ id: orgB, slug: 'b', name: 'B' });
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

describe('P3-C2 数据模型', () => {
  it('document_briefs 受行级安全约束，有一条策略；与文档一对一', async () => {
    const [brief] = await t.adminDb.insert(documents).values(doc(1, 'brief', '简报一')).returning();
    await withOrg(t.db, owner.orgId, (tx) => tx.insert(documentBriefs).values({ documentId: brief!.id, orgId: owner.orgId }));
    expect(await withOrg(t.db, owner.orgId, (tx) => tx.select().from(documentBriefs))).toHaveLength(1);
    expect(await withOrg(t.db, orgB, (tx) => tx.select().from(documentBriefs))).toHaveLength(0);
    await expect(t.adminDb.insert(documentBriefs).values({ documentId: brief!.id, orgId: owner.orgId })).rejects.toThrow();
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename = 'document_briefs'`)) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('默认值；简报与 PRD 各自编号，同一产品里可以都有 1 号，同类不能重号', async () => {
    const [b] = await t.adminDb.select().from(documentBriefs);
    expect(b).toMatchObject({
      version: 'v0.1',
      requesterMemberId: null,
      deciderMemberId: null,
      authorMemberId: null,
      participantTagIds: [],
      relatedLinks: [],
      gateChecks: [],
      convertedDocumentId: null,
    });
    const [p] = await t.adminDb.select().from(products).where(eq(products.id, productId));
    expect(p!.briefSeq).toBe(0);
    await t.adminDb.insert(documents).values(doc(1, 'change', 'PRD 一'));
    await expect(t.adminDb.insert(documents).values(doc(1, 'brief', '重号简报'))).rejects.toThrow();
    await expect(t.adminDb.insert(documents).values(doc(1, 'change', '重号 PRD'))).rejects.toThrow();
  });

  it('需求可以同时挂一份简报和一份 PRD；模板说明默认为空', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '挂简报' });
    const [brief] = await t.adminDb.select().from(documents).where(eq(documents.kind, 'brief'));
    const [prd] = await t.adminDb.select().from(documents).where(eq(documents.kind, 'change'));
    await t.adminDb.update(requirements).set({ briefDocumentId: brief!.id, changeDocumentId: prd!.id }).where(eq(requirements.id, r.id));
    const [row] = await t.adminDb.select().from(requirements).where(eq(requirements.id, r.id));
    expect([row!.briefDocumentId, row!.changeDocumentId]).toEqual([brief!.id, prd!.id]);
    const [tpl] = await t.adminDb
      .select()
      .from(documentTemplates)
      .where(and(eq(documentTemplates.orgId, owner.orgId), eq(documentTemplates.kind, 'change')));
    expect(tpl!.guidance).toBe('');
  });
});

describe('迁移 0022 的补齐', () => {
  it('为没有组织级简报模板的组织写入预置简报模板，内容与代码里的常量逐字一致；可重复执行', async () => {
    await t.adminDb.delete(documentTemplates).where(eq(documentTemplates.kind, 'brief'));
    await runBackfill();
    await runBackfill();
    for (const org of [owner.orgId, orgB]) {
      const rows = await t.adminDb
        .select()
        .from(documentTemplates)
        .where(and(eq(documentTemplates.orgId, org), eq(documentTemplates.kind, 'brief')));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ productId: null, name: BRIEF_TEMPLATE.name, active: true });
      expect(rows[0]!.body).toBe(BRIEF_TEMPLATE.body);
      expect(rows[0]!.guidance).toBe(BRIEF_TEMPLATE.guidance);
      expect(rows[0]!.sections).toEqual(BRIEF_TEMPLATE.sections);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/p3c2-schema.test.ts`
Expected: FAIL（`documentBriefs` 不存在）。

- [ ] **Step 3: 修改 `db/schema.ts`**

1. 第 21 行从 `../documents/constants` 的导入加入两个类型：

```ts
import {
  AFFECTED_CHANGE_TYPES,
  type BriefGateCheck,
  type BriefRelatedLink,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  EXTERNAL_PROVIDERS,
  MERGE_STATUSES,
  type RevisionSnapshot,
  type TemplateSection,
} from '../documents/constants';
```

2. `products` 在 `taskSeq` 之后加：

```ts
    /** 简报编号计数（P3-C2），显示为 {产品}-B-n；变更 PRD 与模块文档共用 documentSeq。 */
    briefSeq: integer('brief_seq').notNull().default(0),
```

3. `requirements` 在 `changeDocumentId` 之后加：

```ts
    /** 所挂的需求简报（P3-C2）：一份简报覆盖多条需求，每条需求最多挂一份。 */
    briefDocumentId: uuid('brief_document_id').references((): AnyPgColumn => documents.id),
```

索引数组在 `index('requirements_change_document')…` 之后加：

```ts
    index('requirements_brief_document').on(t.briefDocumentId),
```

4. `documentTemplates`：`kind` 改为 `text('kind', { enum: ['change', 'module', 'brief'] }).notNull().default('change'),`，在 `sections` 之后加：

```ts
    /** 模板说明（P3-C2）：显示在用这份模板写的文档的编辑器上方。 */
    guidance: text('guidance').notNull().default(''),
```

5. `documents` 的索引数组里，`uniqueIndex('documents_product_number').on(t.productId, t.number),` 替换为：

```ts
    // 简报按产品单独编号（brief_seq），与变更 PRD、模块文档（document_seq）互不占号
    uniqueIndex('documents_product_number').on(t.productId, t.number).where(sql`${t.kind} <> 'brief'`),
    uniqueIndex('documents_product_brief_number').on(t.productId, t.number).where(sql`${t.kind} = 'brief'`),
```

6. `documentRevisions` 定义之后加：

```ts
/** 需求简报的头部信息（P3-C2），与简报文档一对一。 */
export const documentBriefs = pgTable(
  'document_briefs',
  {
    documentId: uuid('document_id')
      .primaryKey()
      .references((): AnyPgColumn => documents.id),
    orgId: orgRef(),
    /** 自由填写，如 v0.1；修订历史仍自动记录。 */
    version: text('version').notNull().default('v0.1'),
    requesterMemberId: memberRef('requester_member_id'),
    deciderMemberId: memberRef('decider_member_id'),
    authorMemberId: memberRef('author_member_id'),
    /** 参与方：组织职能标签。 */
    participantTagIds: jsonb('participant_tag_ids').$type<string[]>().notNull().default([]),
    relatedLinks: jsonb('related_links').$type<BriefRelatedLink[]>().notNull().default([]),
    /** 闸口人工项的勾选记录。 */
    gateChecks: jsonb('gate_checks').$type<BriefGateCheck[]>().notNull().default([]),
    /** 最近一次转出的变更 PRD。 */
    convertedDocumentId: uuid('converted_document_id').references((): AnyPgColumn => documents.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('document_briefs_converted').on(t.convertedDocumentId)],
);
```

- [ ] **Step 4: 生成结构迁移 0021**

Run: `pnpm --filter @flower/core db:generate`
Expected: 生成 `packages/core/migrations/0021_<随机名>.sql` 与 `meta/0021_snapshot.json`。打开 SQL 核对只包含：新表 `document_briefs`（含三个成员外键与两个文档外键）、`products.brief_seq`、`requirements.brief_document_id`（外键与索引）、`document_templates.guidance`、删除并重建 `documents_product_number`（带 `WHERE kind <> 'brief'`）、新建 `documents_product_brief_number`、`document_briefs_converted` 索引。出现其他改动时停下来报告。

- [ ] **Step 5: 生成并填写自定义迁移 0022**

Run: `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p3c2_briefs`

把生成的 `packages/core/migrations/0022_p3c2_briefs.sql` 内容替换为下面全文（第三段 `$tpl$` 与 `$g$` 之间的文字必须与 `BRIEF_TEMPLATE.body`、`BRIEF_TEMPLATE.guidance` 逐字一致，Step 1 的测试会比对）：

````sql
ALTER TABLE document_briefs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON document_briefs
  USING (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
-- 为还没有组织级简报模板的组织补齐预置简报模板（设计 §3.4）；新组织由初始化写入
INSERT INTO document_templates (id, org_id, product_id, kind, name, body, sections, guidance, active, created_at, updated_at)
SELECT gen_random_uuid(), o.id, NULL, 'brief', '需求简报（预置）', $tpl$## 1. 问题与目标

| 问题 | 回答 |
| --- | --- |
| 要解决什么问题（带数字） | |
| 为什么现在做 | |
| 做成以后是什么样（可衡量） | |
| 明确不做什么 | |
| 不做会怎样 | |

## 2. 数据依据

| # | 要回答的问题 | 取数表 | 结论 | 口径 / 数据日期 |
| --- | --- | --- | --- | --- |
| 1 | | 表 x | | |

- 还没拿到的数据：
- 数据推翻了哪些原有设想：
- 取数口径必须和第 7 节一致；口径变了要重跑的表：

## 3. 受影响用户

| 用户群 | 人数 / 占比 | 其中付费用户 | 影响程度 | 怎么处理 |
| --- | --- | --- | --- | --- |
| | | | 无感 / 有提示 / 被限制 | |

- 会不会误伤（正常用户、付费用户、大客户）：
- 是否需要提前沟通（商务外联、客服预案）：

## 4. 场景清单

| # | 场景 | 现在怎样 | 改后怎样 | 边界情况 |
| --- | --- | --- | --- | --- |
| 1 | | | | 刚好等于阈值 / 进行中状态变化 / 多端同时操作 / 撤销与恢复 |

## 5. 对象与状态

**对象定义**

| 对象 | 定义 | 用户是否可见 | 和相似对象的区别 |
| --- | --- | --- | --- |
| | | | |

**状态表**

| 状态 | 进入条件 | 能做 / 不能做 | 用户看到什么 | 怎么离开 |
| --- | --- | --- | --- | --- |
| | | | | |

## 6. 规则与方案

- 核心规则（一句话）：
- 规则明细：

| # | 规则 | 数值 | 状态 |
| --- | --- | --- | --- |
| 1 | | [数值] | 已定 / 待定 |

- 候选方案对比：

| 方案 | 做法 | 优点 | 代价 / 风险 | 结论 |
| --- | --- | --- | --- | --- |
| A | | | | 选定 |
| B | | | | 否决：理由 |

## 7. 计算口径与算法

**指标定义**

| 指标 | 一句话定义 | 公式 | 单位 / 取值范围 | 用在哪（规则 / 展示 / 统计） |
| --- | --- | --- | --- | --- |
| | | | | |

**口径细节**（每个指标逐项写清，不涉及的写「不适用」）

| 问题 | 回答 |
| --- | --- |
| 统计对象：按用户 / 文件 / 设备 / 账号主体 | |
| 包含与排除：回收站、已删除、分享转存、离线下载、秒传、系统文件、子账号 | |
| 去重规则：同内容多份、同一文件多次引用怎么算 | |
| 时间窗口：自然日 / 自然月 / 滚动 30 天；起止时刻和时区 | |
| 计算时机：实时 / 增量更新 / 定时全量重算；多久生效 | |
| 取整与精度：向上 / 向下取整、保留几位、单位换算（1TB=1024GB） | |
| 边界：刚好等于阈值、为 0、为负、溢出 | |
| 数据来源：哪张表、哪个字段；与 DBA 取数口径是否一致 | |
| 结果会不会被用户操作反复改变，怎么防止抖动 | |

**阈值与参数**

| 参数 | 取值 | 依据（第 2 节表 x） | 能否后台调整 |
| --- | --- | --- | --- |
| | | | |

**算例**（至少 3 个：普通情况、刚好在边界、极端情况）

| # | 输入 | 计算过程 | 结果 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | | | | |

**口径变更记录**

| 日期 | 改了什么 | 原因 | 影响哪些数据和规则 |
| --- | --- | --- | --- |
| | | | |

## 8. 现状核对

| # | 要核对的现状 | 结论 | 证据（仓库 文件:行号 / 提交号） | 核对日期 | 和他人说法的差异 |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | |

- 没有核到的范围（仓库没拉、只有快照、线上配置）：

## 9. 可行性与性能

| 问题 | 回答 |
| --- | --- |
| 涉及哪些链路（上传、转存、删除、下载……） | |
| 量级（用户数、文件数、每日新增、峰值） | |
| 会不会拖慢核心链路 | |
| 计算 / 存储 / 队列方案 | |
| 需要压测验证的项 | |
| 历史上类似方案出过的问题 | |
| 研发评估结论 | 可行 / 有条件可行（条件） / 不可行 |

## 10. 影响面与兼容

| 端 / 对象 | 是否受影响 | 老版本表现 | 要不要发版 | 处理 |
| --- | --- | --- | --- | --- |
| Web | | | | |
| PC 客户端 | | | | |
| 同步盘 | | | | |
| App（iOS / Android） | | | | |
| 小程序 | | | | |
| TV | | | | |
| 开放平台 / 第三方 | | | | |
| 运营后台 | | | | |
| 存量数据 | | | | 是否要迁移、重算、对账 |

- 与其他在做或已上线需求的交叉、冲突：

## 11. 用户感知与触达

| 问题 | 回答 |
| --- | --- |
| 用户在什么时候、什么页面看到什么（文案原文） | |
| 触达方式（弹窗 / 站内信 / 公告 / 短信） | |
| 规则是否对外公开 | |
| 客服口径 | |
| 舆论风险及预案 | |

## 12. 商业与合规

| 问题 | 回答 |
| --- | --- |
| 是否影响已付费权益、在售商品、自动续费 | |
| 协议是否要改 | |
| 退款、补偿规则 | |
| 法务意见 | |

## 13. 上线策略

| 问题 | 回答 |
| --- | --- |
| 前置依赖（必须先完成的事） | |
| 分阶段 / 灰度方式 | |
| 开关与参数是否可配置 | |
| 出问题怎么回滚 | |
| 上线后观察什么指标、观察多久 | |

## 14. 分工

| 角色 | 负责人 | 负责什么 | 时间点 |
| --- | --- | --- | --- |
| 产品 | | | |
| 后端 | | | |
| 客户端 | | | |
| 测试 | | | |
| DBA | | | |
| 商业化 / 客服 / 法务 | | | |

## 15. 决策日志

| 日期 | 决定 | 谁定 | 理由 | 替代了哪条 |
| --- | --- | --- | --- | --- |
| | | | | |

## 16. 待定问题

| # | 问题 | 选项 | 建议 | 待谁定 | 是否阻塞 PRD |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | 是 / 否 |

## 17. 写 PRD 闸口

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 第 1~14 节没有空白，不涉及的都写了理由 | |
| 2 | 第 1 节的问题有数字支撑（第 2 节） | |
| 3 | 第 3 节已估出影响人数和付费用户占比 | |
| 4 | 第 5 节对象与状态已确认（或注明不适用） | |
| 5 | 第 6 节核心规则已定；未定的数值都在第 16 节 | |
| 6 | 第 7 节每个指标都有公式、口径和算例，且与取数需求口径一致 | |
| 7 | 第 8 节的每条现状都有代码证据和核对日期 | |
| 8 | 第 9 节研发给出了可行性结论 | |
| 9 | 第 10 节各端都过了一遍，老版本表现已确认 | |
| 10 | 第 16 节没有「阻塞 PRD」的问题 | |
| 11 | 决策人确认过第 1、6、7、13 节 | |

## 18. 与 PRD 章节的对应

| PRD 章节 | 取自简报 |
| --- | --- |
| 1 背景介绍 | 第 1、2 节 |
| 2.1 定位、2.2 服务对象 | 第 1、3 节 |
| 2.3 适用平台 | 第 10 节 |
| 2.4 角色术语、2.5 状态表 | 第 5 节 |
| 3.1 需求列表、3.6 需求明细 | 第 4、6 节 |
| 3.2 整体流程 | 第 4、5、6 节 |
| 3.3 计算规则、分层上线 | 第 7、13 节 |
| 3.7 站内信 / 公告 | 第 11 节 |
| 4 技术约束与接口 | 第 7、8、9 节 |
| 5 成功指标 | 第 1、7、13 节 |
| 6.1 依赖 | 第 13、14 节 |
| 6.2 开放问题 | 第 16 节 |
| 7 测试要点 | 第 4 节的边界情况、第 7 节的算例、第 10 节 |
| 客服 FAQ | 第 11 节 |
| 变更记录 | 第 15 节 |
$tpl$, $sec$[
  {"heading": "1. 问题与目标", "required": true, "guidance": "要解决的问题带数字；写清明确不做什么"},
  {"heading": "2. 数据依据", "required": true, "guidance": "取数口径必须和第 7 节一致"},
  {"heading": "3. 受影响用户", "required": true, "guidance": "估出影响人数与付费用户占比"},
  {"heading": "4. 场景清单", "required": true, "guidance": "边界情况逐条写：刚好等于阈值、进行中状态变化、多端同时操作、撤销与恢复"},
  {"heading": "5. 对象与状态", "required": true, "guidance": "有多状态、多层级、多个相似对象时必填；不涉及写「不适用：理由」"},
  {"heading": "6. 规则与方案", "required": true, "guidance": "核心规则一句话；未定的数值列进第 16 节"},
  {"heading": "7. 计算口径与算法", "required": true, "guidance": "涉及阈值、计数、排名、计费、配额时必填；每个指标写公式、口径与至少 3 个算例"},
  {"heading": "8. 现状核对", "required": true, "guidance": "实读代码；每条现状写证据（仓库 文件:行号 / 提交号）与核对日期"},
  {"heading": "9. 可行性与性能", "required": true, "guidance": "研发给出可行性结论"},
  {"heading": "10. 影响面与兼容", "required": true, "guidance": "各端逐一确认老版本表现"},
  {"heading": "11. 用户感知与触达", "required": true, "guidance": "文案写原文"},
  {"heading": "12. 商业与合规", "required": true, "guidance": "已付费权益、协议、退款与法务意见"},
  {"heading": "13. 上线策略", "required": true, "guidance": "灰度、开关、回滚与观察指标"},
  {"heading": "14. 分工", "required": true, "guidance": "每个角色写负责人与时间点"},
  {"heading": "15. 决策日志", "required": true, "guidance": "结论被推翻时在这里记录推翻的过程"},
  {"heading": "16. 待定问题", "required": true, "guidance": "「是否阻塞 PRD」填「是」或「否」"},
  {"heading": "17. 写 PRD 闸口", "required": true, "guidance": "闸口结果以侧栏「写 PRD 闸口」为准"},
  {"heading": "18. 与 PRD 章节的对应", "required": true, "guidance": "转 PRD 时按此表拼接"}
]$sec$::jsonb, $g$- 简报记录的是讨论到当前为止的结论，不是会议流水账。结论被推翻时直接改正文，推翻的过程记进第 15 节「决策日志」。
- 每一节都必须填写；不涉及的写「不适用：理由」，不能空着。
- 第 17 节的闸口全部通过后才能开始写 PRD。PRD 的各章节从对应小节取内容（见第 18 节）。$g$, true, now(), now()
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM document_templates t WHERE t.org_id = o.id AND t.product_id IS NULL AND t.kind = 'brief'
);
````

文件按 `--> statement-breakpoint` 分成三段（开启 RLS、建策略、补齐模板）；Step 1 的 `BACKFILL` 用 `slice(2)` 只重放第三段（重放建策略会报「已存在」）。

- [ ] **Step 6: 迁移工具清理新表**

`packages/migrate/src/write.ts` 的 `deleteOrgData` 里，在 `// 工作跟进：…` 那一段之前加：

```ts
  // 需求简报：头部表引用文档与成员，要在文档与成员之前删；需求上的 brief_document_id 随需求一起删
  await tx.execute(sql`delete from ${core.documentBriefs} where org_id = ${orgId}`);
```

`packages/migrate/test/write.test.ts`：

1. 从 `@flower/core` 的导入列表按字母顺序加入 `documentBriefs`。
2. 「导入后有过正常使用…仍可以 replace」用例里，`await t.adminDb.insert(blockers).values({ orgId: actor.orgId, workItemId: wi!.id, description: '工作项阻塞' });` 之后加：

```ts
    const [briefDoc] = await t.adminDb
      .insert(documents)
      .values({ orgId: actor.orgId, productId: product!.id, number: 1, kind: 'brief', source: 'native', title: '导入后简报', status: 'discussing' })
      .returning();
    await t.adminDb.insert(documentBriefs).values({ documentId: briefDoc!.id, orgId: actor.orgId, convertedDocumentId: prd.id });
    await t.adminDb.update(requirements).set({ briefDocumentId: briefDoc!.id }).where(eq(requirements.id, created.id));
```

3. 同一用例 `for (const table of [workItems, progressUpdates]) …` 之后加：

```ts
    expect(await t.adminDb.select().from(documentBriefs)).toEqual([]);
    expect(await t.adminDb.select().from(documents).where(eq(documents.kind, 'brief'))).toEqual([]);
```

- [ ] **Step 7: 运行测试确认通过，类型检查并提交**

Run: `pnpm --filter @flower/core exec vitest run test/p3c2-schema.test.ts test/rls.test.ts test/documents.test.ts && pnpm --filter @flower/migrate exec vitest run test/write.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

```bash
git add packages/core/src/db/schema.ts packages/core/migrations packages/core/test/p3c2-schema.test.ts packages/migrate/src/write.ts packages/migrate/test/write.test.ts
git commit -m "feat(core): 简报的数据模型：按产品单独编号、头部表与 RLS、需求挂简报、模板说明、补齐预置简报模板

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: 模板按类型（PRD / 简报）、模板说明、预置简报模板的初始化与导入

**Files:**
- Modify: `packages/core/src/documents/templates.ts`、`packages/core/src/definitions/defaults.ts`、`packages/migrate/src/plan-documents.ts`、`packages/migrate/test/plan-documents.test.ts`
- Test: `packages/core/test/brief-templates.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TemplateKind`；Task 2 的 `BRIEF_TEMPLATE`；Task 3 的 `documentTemplates.guidance`
- Produces（`templates.ts`）:
  - `TemplateView` 多两个字段：`kind: TemplateKind`、`guidance: string`
  - `insertPresetBriefTemplate(tx: Tx, orgId: string): Promise<void>`
  - `effectiveTemplates(tx, productId, kind: TemplateKind = 'change')`、`loadUsableTemplate(tx, productId, templateId, kind: TemplateKind = 'change')`
  - `listTemplates(db, actor, { productId?, usable?, kind? })`（缺省 `change`）、`createTemplate(db, actor, { productId?, kind?, name, body, sections, guidance? })`、`updateTemplate(db, actor, id, { name?, body?, sections?, guidance?, active? })`、`createPresetTemplate(db, actor, kind: TemplateKind = 'change')`
  - 模板说明不超过 2000 字：`模板说明不超过 2000 个字符`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/brief-templates.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { BRIEF_TEMPLATE } from '../src/documents/brief-template';
import { createPresetTemplate, createTemplate, effectiveTemplates, listTemplates, PRESET_TEMPLATE, updateTemplate } from '../src/documents/templates';
import type { Actor } from '../src/domain-types';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productAdmin: Actor;
let editor: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  productAdmin = await asMember(t.db, owner, '产品管理员丙');
  await setProductRole(t.db, owner, pan, productAdmin.memberId, 'admin');
  editor = await asMember(t.db, owner, '编辑丁');
});
afterAll(() => t.cleanup());

describe('模板按类型', () => {
  it('新组织同时有预置 PRD 模板与预置简报模板；按类型分开列出，原有调用只看到 PRD 模板', async () => {
    expect((await listTemplates(t.db, owner, {})).map((x) => [x.kind, x.name])).toEqual([['change', PRESET_TEMPLATE.name]]);
    const briefs = await listTemplates(t.db, owner, { kind: 'brief' });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({ kind: 'brief', productId: null, name: BRIEF_TEMPLATE.name, body: BRIEF_TEMPLATE.body, guidance: BRIEF_TEMPLATE.guidance, active: true });
    expect(briefs[0]!.sections).toEqual(BRIEF_TEMPLATE.sections);
    expect((await listTemplates(t.db, owner, { productId: pan, usable: true, kind: 'brief' })).map((x) => x.name)).toEqual([BRIEF_TEMPLATE.name]);
    expect((await listTemplates(t.db, owner, { productId: pan, usable: true })).map((x) => x.name)).toEqual([PRESET_TEMPLATE.name]);
  });

  it('产品管理员用同名模板覆盖组织简报模板；PRD 模板不受影响；编辑不能新建模板；PRD 与简报模板可以同名', async () => {
    await createTemplate(t.db, productAdmin, {
      productId: pan,
      kind: 'brief',
      name: BRIEF_TEMPLATE.name,
      body: '## 1. 问题与目标\n\n产品版\n',
      sections: [{ heading: '1. 问题与目标', required: true }],
      guidance: '本产品的写法',
    });
    const usable = await withOrg(t.db, owner.orgId, (tx) => effectiveTemplates(tx, pan, 'brief'));
    expect(usable.map((x) => [x.productId, x.guidance])).toEqual([[pan, '本产品的写法']]);
    expect((await withOrg(t.db, owner.orgId, (tx) => effectiveTemplates(tx, pan))).map((x) => x.name)).toEqual([PRESET_TEMPLATE.name]);
    await expect(createTemplate(t.db, editor, { productId: pan, kind: 'brief', name: '编辑的模板', body: '', sections: [] })).rejects.toMatchObject({ code: 'forbidden' });
    const same = await createTemplate(t.db, owner, { kind: 'change', name: BRIEF_TEMPLATE.name, body: '', sections: [] });
    expect(same.kind).toBe('change');
  });

  it('模板说明不超过 2000 字；修改记入 template.updated 的 changes', async () => {
    const [b] = await listTemplates(t.db, owner, { kind: 'brief' });
    await expect(updateTemplate(t.db, owner, b!.id, { guidance: 'x'.repeat(2001) })).rejects.toThrow('模板说明不超过 2000 个字符');
    expect((await updateTemplate(t.db, owner, b!.id, { guidance: '先写结论' })).guidance).toBe('先写结论');
    const [ev] = await t.adminDb
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.type, 'template.updated'), eq(domainEvents.subjectId, b!.id)));
    expect(ev!.payload.changes).toEqual([{ field: 'guidance', old: BRIEF_TEMPLATE.guidance, new: '先写结论' }]);
  });

  it('预置简报模板已存在时不能重复添加', async () => {
    await expect(createPresetTemplate(t.db, owner, 'brief')).rejects.toMatchObject({ code: 'conflict', message: '预置模板已存在' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/brief-templates.test.ts`
Expected: FAIL（`listTemplates` 不认 `kind`，新组织没有简报模板）。

- [ ] **Step 3: 改写 `documents/templates.ts`**

整个文件替换为：

```ts
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentTemplates } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { BRIEF_TEMPLATE } from './brief-template';
import type { TemplateKind, TemplateSection } from './constants';

export type TemplateView = {
  id: string;
  productId: string | null;
  kind: TemplateKind;
  name: string;
  body: string;
  sections: TemplateSection[];
  /** 模板说明（P3-C2），显示在编辑器上方；没有时为空字符串。 */
  guidance: string;
  active: boolean;
  updatedAt: Date;
};

const GUIDANCE_MAX = 2000;

/** 与旧 prd 系统一致的预置模板（变更记录 / 背景 / 产品概述 / 需求说明）。 */
export const PRESET_TEMPLATE: { name: string; body: string; sections: TemplateSection[] } = {
  name: '变更 PRD（预置）',
  body: `## 变更记录

| 日期 | 修订人 | 内容 |
|---|---|---|
| {{date}} | {{author}} | 初稿 |

## 1. 背景介绍

### 1.1 业务背景

简述本需求所处的业务背景、当前问题。

### 1.2 业务场景

| 场景 / 商业模式 | 商业价值 |
|---|---|
| 待填 | 待填 |

## 2. 产品概述

### 2.1 产品定位

一句话定位。

### 2.2 服务对象

- 角色 1
- 角色 2

### 2.3 信息架构

在此插入信息架构图（粘贴或拖入图片）。

### 2.4 角色术语

| 角色 | 定义 |
|---|---|
| 待填 | 待填 |

## 3. 需求说明

### 3.1 需求列表

| 序号 | 需求名称 | 优先级 | 状态 |
|---|---|---|---|
| R1 | 待填 | P0 | 待评审 |

### 3.2 需求明细

#### R1 · （需求名称）

**原型**：粘贴原型截图

**模块组成**：

**交互说明**：

**逻辑规则**：

**数据来源**：

**埋点需求**：
`,
  sections: [
    { heading: '变更记录', required: false, guidance: '每次修订追加一行：日期、修订人、内容' },
    { heading: '1. 背景介绍', required: true, guidance: '业务背景与业务场景' },
    { heading: '2. 产品概述', required: false, guidance: '定位、服务对象、信息架构、角色术语' },
    { heading: '3. 需求说明', required: true, guidance: '需求列表与逐条明细' },
  ],
};

const view = (r: typeof documentTemplates.$inferSelect): TemplateView => ({
  id: r.id,
  productId: r.productId,
  kind: r.kind === 'brief' ? 'brief' : 'change',
  name: r.name,
  body: r.body,
  sections: r.sections,
  guidance: r.guidance,
  active: r.active,
  updatedAt: r.updatedAt,
});

export async function insertPresetTemplate(tx: Tx, orgId: string): Promise<void> {
  await tx.insert(documentTemplates).values({ orgId, productId: null, kind: 'change', name: PRESET_TEMPLATE.name, body: PRESET_TEMPLATE.body, sections: PRESET_TEMPLATE.sections });
}

/** 预置简报模板（P3-C2）：新组织初始化时写入；已有组织由迁移 0022 补齐。 */
export async function insertPresetBriefTemplate(tx: Tx, orgId: string): Promise<void> {
  await tx.insert(documentTemplates).values({
    orgId,
    productId: null,
    kind: 'brief',
    name: BRIEF_TEMPLATE.name,
    body: BRIEF_TEMPLATE.body,
    sections: BRIEF_TEMPLATE.sections,
    guidance: BRIEF_TEMPLATE.guidance,
  });
}

function validate(input: { name: string; body: string; sections: TemplateSection[]; guidance: string }): {
  name: string;
  body: string;
  sections: TemplateSection[];
  guidance: string;
} {
  const name = input.name.trim();
  if (!name || name.length > 50) throw new AppError('invalid', '模板名称不能为空，且不超过 50 个字符');
  if (input.body.length > 50_000) throw new AppError('invalid', '模板正文不超过 50000 个字符');
  if (input.guidance.length > GUIDANCE_MAX) throw new AppError('invalid', `模板说明不超过 ${GUIDANCE_MAX} 个字符`);
  if (input.sections.length > 50) throw new AppError('invalid', '小节不超过 50 个');
  const sections = input.sections.map((s) => ({ heading: s.heading.trim(), required: s.required, ...(s.guidance?.trim() ? { guidance: s.guidance.trim() } : {}) }));
  if (sections.some((s) => !s.heading || s.heading.length > 100)) throw new AppError('invalid', '小节标题不能为空，且不超过 100 个字符');
  if (new Set(sections.map((s) => s.heading)).size !== sections.length) throw new AppError('invalid', '小节标题不能重复');
  return { name, body: input.body, sections, guidance: input.guidance.trim() };
}

/** 组织级模板需要组织管理员；产品级模板需要该产品的管理员。 */
async function requireTemplateAdmin(tx: Tx, actor: Actor, productId: string | null): Promise<void> {
  if (productId) await requireProductRole(tx, actor, productId, 'admin');
  else requireOrgAdmin(actor);
}

/** 产品可用的某类模板：产品自己的启用模板，加上没有被同名产品模板覆盖的启用组织模板。 */
export async function effectiveTemplates(tx: Tx, productId: string, kind: TemplateKind = 'change'): Promise<TemplateView[]> {
  const rows = await tx
    .select()
    .from(documentTemplates)
    .where(and(eq(documentTemplates.kind, kind), eq(documentTemplates.active, true), or(isNull(documentTemplates.productId), eq(documentTemplates.productId, productId))))
    .orderBy(asc(documentTemplates.createdAt), asc(documentTemplates.id));
  const overridden = new Set(rows.filter((r) => r.productId !== null).map((r) => r.name));
  return rows.filter((r) => r.productId !== null || !overridden.has(r.name)).map(view);
}

export async function loadUsableTemplate(tx: Tx, productId: string, templateId: string, kind: TemplateKind = 'change'): Promise<TemplateView> {
  const tpl = (await effectiveTemplates(tx, productId, kind)).find((x) => x.id === templateId);
  if (!tpl) throw new AppError('invalid', '模板不存在或已停用');
  return tpl;
}

/**
 * 按类型（缺省为变更 PRD）列出：不带 productId 为组织级模板（含停用的）；带 productId 为该产品自己的模板（含停用的）；
 * 带 productId 且 usable 为新建文档时可选的模板（effectiveTemplates）。
 */
export async function listTemplates(db: Db, actor: Actor, input: { productId?: string | null; usable?: boolean; kind?: TemplateKind }): Promise<TemplateView[]> {
  const kind = input.kind ?? 'change';
  return withOrg(db, actor.orgId, async (tx) => {
    if (!input.productId) {
      requireNonGuest(actor);
      const rows = await tx
        .select()
        .from(documentTemplates)
        .where(and(isNull(documentTemplates.productId), eq(documentTemplates.kind, kind)))
        .orderBy(asc(documentTemplates.createdAt), asc(documentTemplates.id));
      return rows.map(view);
    }
    await requireProductRole(tx, actor, input.productId, 'viewer');
    if (input.usable) return effectiveTemplates(tx, input.productId, kind);
    const rows = await tx
      .select()
      .from(documentTemplates)
      .where(and(eq(documentTemplates.productId, input.productId), eq(documentTemplates.kind, kind)))
      .orderBy(asc(documentTemplates.createdAt), asc(documentTemplates.id));
    return rows.map(view);
  });
}

export async function createTemplate(
  db: Db,
  actor: Actor,
  input: { productId?: string | null; kind?: TemplateKind; name: string; body: string; sections: TemplateSection[]; guidance?: string },
): Promise<TemplateView> {
  const v = validate({ ...input, guidance: input.guidance ?? '' });
  const kind = input.kind ?? 'change';
  return withOrg(db, actor.orgId, async (tx) => {
    const productId = input.productId ?? null;
    await requireTemplateAdmin(tx, actor, productId);
    let row: typeof documentTemplates.$inferSelect;
    try {
      [row] = (await tx.insert(documentTemplates).values({ orgId: actor.orgId, productId, kind, ...v }).returning()) as [typeof documentTemplates.$inferSelect];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已有同名模板');
      throw e;
    }
    await recordEvent(tx, { orgId: actor.orgId, productId, type: 'template.created', subjectType: 'document_template', subjectId: row.id, actor, payload: { name: row.name, kind } });
    return view(row);
  });
}

export async function updateTemplate(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: string; body?: string; sections?: TemplateSection[]; guidance?: string; active?: boolean },
): Promise<TemplateView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(documentTemplates).where(eq(documentTemplates.id, id)).for('update');
    if (!cur) throw new AppError('not_found', '模板不存在');
    await requireTemplateAdmin(tx, actor, cur.productId);
    const v = validate({ name: input.name ?? cur.name, body: input.body ?? cur.body, sections: input.sections ?? cur.sections, guidance: input.guidance ?? cur.guidance });
    const next = { ...v, active: input.active ?? cur.active };
    const changes = (['name', 'body', 'sections', 'guidance', 'active'] as const)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => JSON.stringify(c.old) !== JSON.stringify(c.new));
    if (changes.length === 0) return view(cur);
    let row: typeof documentTemplates.$inferSelect;
    try {
      [row] = (await tx.update(documentTemplates).set({ ...next, updatedAt: new Date() }).where(eq(documentTemplates.id, id)).returning()) as [typeof documentTemplates.$inferSelect];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已有同名模板');
      throw e;
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'template.updated',
      subjectType: 'document_template',
      subjectId: id,
      actor,
      payload: { changes: changes.map((c) => (c.field === 'body' ? { field: 'body', old: `${cur.body.length} 字符`, new: `${next.body.length} 字符` } : c)) },
    });
    return view(row);
  });
}

/** 组织缺少预置模板时，由组织管理员在设置页添加（P2-A 之前的组织没有预置 PRD 模板）。 */
export async function createPresetTemplate(db: Db, actor: Actor, kind: TemplateKind = 'change'): Promise<TemplateView> {
  try {
    return await createTemplate(db, actor, kind === 'brief' ? { productId: null, kind, ...BRIEF_TEMPLATE } : { productId: null, kind, ...PRESET_TEMPLATE });
  } catch (e) {
    if (e instanceof AppError && e.code === 'conflict') throw new AppError('conflict', '预置模板已存在');
    throw e;
  }
}
```

（`PRESET_TEMPLATE` 的内容与原文件逐字相同，只是整体搬入；其余改动为类型参数、`guidance` 与 `insertPresetBriefTemplate`。）

- [ ] **Step 4: 新组织初始化时写入预置简报模板**

`packages/core/src/definitions/defaults.ts`：第 4 行导入改为 `import { insertPresetBriefTemplate, insertPresetTemplate } from '../documents/templates';`，`seedOrgDefaults` 里 `await insertPresetTemplate(tx, orgId);` 之后加：

```ts
  await insertPresetBriefTemplate(tx, orgId);
```

- [ ] **Step 5: 迁移工具导入时一并写入**

`packages/migrate/src/plan-documents.ts`：第 4 行从 `@flower/core` 的导入加入 `BRIEF_TEMPLATE`；`buildDocumentTemplates` 末尾（原 `push` 之后）加：

```ts
  ctx.rows.documentTemplates.push({
    id: ctx.id('template', 'preset-brief'),
    orgId: ctx.orgId,
    productId: null,
    kind: 'brief',
    name: BRIEF_TEMPLATE.name,
    body: BRIEF_TEMPLATE.body,
    sections: BRIEF_TEMPLATE.sections,
    guidance: BRIEF_TEMPLATE.guidance,
    active: true,
    createdAt: ctx.asOfTime,
    updatedAt: ctx.asOfTime,
  });
```

`packages/migrate/test/plan-documents.test.ts` 第 35 行的断言改为：

```ts
    expect(rows.documentTemplates.map((t) => [t.kind, t.name])).toEqual([
      ['change', '变更 PRD（预置）'],
      ['brief', '需求简报（预置）'],
    ]);
```

- [ ] **Step 6: 运行测试确认通过，类型检查并提交**

Run: `pnpm --filter @flower/core exec vitest run test/brief-templates.test.ts test/templates-attachments.test.ts test/documents.test.ts test/orgs.test.ts && pnpm --filter @flower/migrate exec vitest run test/plan-documents.test.ts test/write.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误（`apps/web/src/server/routes/templates.ts` 的调用不带 `kind` 时仍按变更 PRD 处理，Task 9 再接参数）。

```bash
git add packages/core/src/documents/templates.ts packages/core/src/definitions/defaults.ts packages/core/test/brief-templates.test.ts packages/migrate/src/plan-documents.ts packages/migrate/test/plan-documents.test.ts
git commit -m "feat(core): 文档模板按类型区分，增加模板说明，新组织与导入时写入预置简报模板

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: 文档系统识别简报：新建、编号、详情、流转、链接与推送

**Files:**
- Create: `packages/core/src/documents/brief-header.ts`、`packages/core/src/documents/briefs.ts`
- Modify: `packages/core/src/documents/documents.ts`、`packages/core/src/links/cards.ts`、`packages/core/src/links/backlinks.ts`、`packages/core/src/links/search.ts`、`packages/core/src/notifications/match.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/briefs-documents.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `documentKeyOf`、`briefDisplayKey`、`parseBriefKey`、`documentTransitions`；Task 3 的 `documentBriefs`、`products.briefSeq`、`requirements.briefDocumentId`、`documentTemplates.guidance`；Task 4 的 `effectiveTemplates(tx, productId, 'brief')`、`loadUsableTemplate(…, 'brief')`
- Produces:
  - `brief-header.ts`：`BriefRow = typeof documentBriefs.$inferSelect`；`BriefHeader = { version: string; requester: MemberRef | null; decider: MemberRef | null; author: MemberRef | null; participantTags: Array<{ id; name; color }>; relatedLinks: BriefRelatedLink[]; convertedDocument: { id; displayKey; title; status: DocumentStatus } | null }`；`briefHeaderTx(tx, row: BriefRow): Promise<BriefHeader>`
  - `documents.ts`：`DocumentDetail` 多三个字段 `brief: BriefHeader | null`、`sourceBrief: { id; displayKey; title } | null`、`templateGuidance: string | null`；`insertNativeDocumentTx(tx, actor, { productId; kind: 'change' | 'brief'; title; status; ownerMemberId; templateId; markdown; summary }): Promise<DocumentRow>`；`getDocumentByKey` 认 `PAN-B-n`；`transitionDocument` 按类型流转；`setDocumentStatusTx` 对简报在 payload 带 `kind: 'brief'` 且不同步「PRD」检查项
  - `briefs.ts`：`loadBriefTx(tx, id, opts?: { lock?: boolean }): Promise<{ doc: DocumentRow; header: BriefRow }>`（不是简报或已删除时 `not_found`「简报不存在」）；`briefRoleTx(tx, actor, doc, need: ProductRole): Promise<ProductRole>`（看不到时 `not_found`「简报不存在」）；`createBrief(db, actor, productId, input: { title: string; templateId?: string | null }): Promise<DocumentDetail>`
  - 链接卡、被引用里的简报显示 `PAN-B-n`、地址 `documents/PAN-B-n`；`[[` 小节补全只找非简报文档；简报的 `document.status_changed` 不匹配事件规则

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/briefs-documents.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, notificationDeliveries } from '../src/db/schema';
import { BRIEF_TEMPLATE } from '../src/documents/brief-template';
import { createBrief } from '../src/documents/briefs';
import { createDocument, getDocumentByKey, listDocuments, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { listBacklinks } from '../src/links/backlinks';
import { listDocumentLinkCards } from '../src/links/cards';
import { createRule } from '../src/notifications/rules';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guest: Actor;
let pan: string;
let prd: Awaited<ReturnType<typeof createDocument>>;

const eventsOf = (subjectId: string) => t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, subjectId));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '访客丙', 'guest');
});
afterAll(() => t.cleanup());

describe('新建简报', () => {
  it('按预置模板生成正文；编号 PAN-B-n 与 PRD 编号各自从 1 开始；讨论中；作者为创建人；只记 brief.created', async () => {
    prd = await createDocument(t.db, editor, pan, { title: '已有 PRD' });
    expect(prd.displayKey).toBe('PAN-PRD-1');
    const b = await createBrief(t.db, editor, pan, { title: '上传提速' });
    expect(b).toMatchObject({
      displayKey: 'PAN-B-1',
      kind: 'brief',
      status: 'discussing',
      source: 'native',
      revisionNumber: 1,
      transitions: ['ready', 'discarded'],
      requirements: [],
      checkItems: [],
      sourceBrief: null,
      templateGuidance: BRIEF_TEMPLATE.guidance,
    });
    expect(b.markdown).toBe(BRIEF_TEMPLATE.body);
    expect(b.brief).toEqual({
      version: 'v0.1',
      requester: null,
      decider: null,
      author: { id: editor.memberId, displayName: '编辑甲' },
      participantTags: [],
      relatedLinks: [],
      convertedDocument: null,
    });
    expect(prd.brief).toBeNull();
    expect((await createBrief(t.db, editor, pan, { title: '下载限速' })).displayKey).toBe('PAN-B-2');
    expect((await createDocument(t.db, editor, pan, { title: '第二份 PRD' })).displayKey).toBe('PAN-PRD-2');
    expect((await eventsOf(b.id)).map((e) => e.type)).toEqual(['brief.created']);
  });

  it('只读成员与只读 Token 不能新建；看不到产品时按不存在处理；标题不能为空', async () => {
    await expect(createBrief(t.db, viewer, pan, { title: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createBrief(t.db, readOnlyToken(owner), pan, { title: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createBrief(t.db, guest, pan, { title: '访客' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createBrief(t.db, editor, pan, { title: ' ' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('简报与 PRD 同号互不串号', () => {
  it('按编号打开：PAN-B-1 是简报，PAN-PRD-1 是 PRD；PRD 列表不含简报；不存在的简报编号返回「简报不存在」', async () => {
    expect((await getDocumentByKey(t.db, viewer, 'PAN-B-1')).kind).toBe('brief');
    expect((await getDocumentByKey(t.db, viewer, 'PAN-PRD-1')).kind).toBe('change');
    await expect(getDocumentByKey(t.db, viewer, 'PAN-B-9')).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
    await expect(getDocumentByKey(t.db, guest, 'PAN-B-1')).rejects.toMatchObject({ code: 'not_found' });
    expect((await listDocuments(t.db, viewer, pan)).map((d) => d.displayKey).sort()).toEqual(['PAN-PRD-1', 'PAN-PRD-2']);
  });

  it('[[ ]]：PAN-B-n（含小节）解析为简报，PAN-PRD-n 为 PRD；后建的简报接上悬空链接；被引用里显示 PRD 编号', async () => {
    await saveDocumentContent(t.db, editor, prd.id, { baseVersion: prd.version, markdown: '见 [[PAN-B-1]]、[[PAN-B-1#2. 数据依据]]、[[PAN-PRD-2]] 与 [[PAN-B-3]]。\n' });
    const cards = async () => Object.fromEntries((await listDocumentLinkCards(t.db, editor, prd.id)).map((c) => [c.text, [c.displayKey, c.state, c.href]]));
    expect(await cards()).toEqual({
      'PAN-B-1': ['PAN-B-1', 'ok', 'documents/PAN-B-1'],
      'PAN-B-1#2. 数据依据': ['PAN-B-1#2. 数据依据', 'ok', `documents/PAN-B-1?section=${encodeURIComponent('2. 数据依据')}`],
      'PAN-PRD-2': ['PAN-PRD-2', 'ok', 'documents/PAN-PRD-2'],
      'PAN-B-3': ['PAN-B-3', 'missing', null],
    });
    await createBrief(t.db, editor, pan, { title: '分享有效期' });
    expect((await cards())['PAN-B-3']).toEqual(['PAN-B-3', 'ok', 'documents/PAN-B-3']);
    const b1 = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    expect((await listBacklinks(t.db, editor, { type: 'document', id: b1.id })).map((g) => [g.displayKey, g.href])).toEqual([['PAN-PRD-1', 'documents/PAN-PRD-1']]);
  });
});

describe('简报的状态流转与推送', () => {
  it('讨论中 → 可写 PRD；不能改为 PRD 的状态，也不能直接改为已转 PRD；只读不能改；事件带 kind', async () => {
    const b = await getDocumentByKey(t.db, editor, 'PAN-B-2');
    const r = await transitionDocument(t.db, editor, b.id, { to: 'ready' });
    expect([r.status, r.transitions]).toEqual(['ready', ['discussing', 'discarded']]);
    await expect(transitionDocument(t.db, editor, b.id, { to: 'draft' })).rejects.toThrow('不能从「可写 PRD」改为「草稿」');
    await expect(transitionDocument(t.db, editor, b.id, { to: 'converted' })).rejects.toThrow('不能从「可写 PRD」改为「已转 PRD」');
    await expect(transitionDocument(t.db, viewer, b.id, { to: 'discussing' })).rejects.toMatchObject({ code: 'forbidden' });
    const [ev] = (await eventsOf(b.id)).filter((e) => e.type === 'document.status_changed');
    expect(ev!.payload).toMatchObject({ kind: 'brief', changes: [{ field: 'status', old: 'discussing', new: 'ready' }] });
  });

  it('订阅「PRD 状态变化」的事件规则不因简报改状态产生发送记录，PRD 改状态照常', async () => {
    const channel = await wecomChannel(t.db, owner, '研发群');
    const rule = await createRule(t.db, owner, pan, { name: 'PRD 状态', eventTypes: ['document.status_changed'], channelIds: [channel.id] });
    const deliveries = () => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, rule.id));
    const b = await getDocumentByKey(t.db, editor, 'PAN-B-2');
    await transitionDocument(t.db, editor, b.id, { to: 'discussing' });
    expect(await deliveries()).toHaveLength(0);
    await transitionDocument(t.db, editor, prd.id, { to: 'review' });
    expect(await deliveries()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/briefs-documents.test.ts`
Expected: FAIL（`../src/documents/briefs` 不存在）。

- [ ] **Step 3: 新建 `packages/core/src/documents/brief-header.ts`**

```ts
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { documentBriefs, documents, functionTags, products } from '../db/schema';
import type { Tx } from '../db/tx';
import { memberNames } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import type { BriefRelatedLink, DocumentStatus } from './constants';
import { documentKeyOf } from './markdown';

export type BriefRow = typeof documentBriefs.$inferSelect;
export type BriefHeader = {
  version: string;
  requester: MemberRef | null;
  decider: MemberRef | null;
  author: MemberRef | null;
  /** 已删除的职能标签不再显示。 */
  participantTags: Array<{ id: string; name: string; color: string }>;
  relatedLinks: BriefRelatedLink[];
  /** 最近一次转出的变更 PRD（已删除时为空）。 */
  convertedDocument: { id: string; displayKey: string; title: string; status: DocumentStatus } | null;
};

/** 简报头部信息的显示形式：成员取当前姓名，标签取当前名称与颜色。 */
export async function briefHeaderTx(tx: Tx, h: BriefRow): Promise<BriefHeader> {
  const names = await memberNames(tx, [h.requesterMemberId, h.deciderMemberId, h.authorMemberId]);
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  const tags = h.participantTagIds.length > 0 ? await tx.select().from(functionTags).where(inArray(functionTags.id, h.participantTagIds)) : [];
  const tagOf = new Map(tags.map((x) => [x.id, x]));
  const [conv] = h.convertedDocumentId
    ? await tx
        .select({ d: documents, key: products.key })
        .from(documents)
        .innerJoin(products, eq(products.id, documents.productId))
        .where(and(eq(documents.id, h.convertedDocumentId), isNull(documents.deletedAt)))
    : [];
  return {
    version: h.version,
    requester: ref(h.requesterMemberId),
    decider: ref(h.deciderMemberId),
    author: ref(h.authorMemberId),
    participantTags: h.participantTagIds.flatMap((id) => {
      const x = tagOf.get(id);
      return x ? [{ id: x.id, name: x.name, color: x.color }] : [];
    }),
    relatedLinks: h.relatedLinks,
    convertedDocument: conv ? { id: conv.d.id, displayKey: documentKeyOf(conv.d.kind, conv.key, conv.d.number), title: conv.d.title, status: conv.d.status } : null,
  };
}
```

- [ ] **Step 4: 修改 `documents/documents.ts`**

1. 导入改为（去掉不再使用的 `DOCUMENT_TRANSITIONS`）：

```ts
import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { productRoleOf, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentBriefs, documentRevisions, documents, documentTemplates, products, requirements, structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { relinkDangling, syncSourceLinks } from '../links/links';
import { newMentionIds } from '../links/syntax';
import { assertAssignableMember, memberNames } from '../requirements/context';
import type { CheckItemView } from '../requirements/check-views';
import { assertTitle, productKeyOf, displayKey as requirementDisplayKey, type MemberRef } from '../requirements/requirements';
import { orgToday } from '../tasks/tasks';
import { type BriefHeader, briefHeaderTx } from './brief-header';
import { reanchorDocumentComments } from './comments';
import { documentCheckItemViews } from './checks';
import { linkRequirementsTx, syncPrdCheck } from './coverage';
import type { DocumentKind, DocumentStatus, ExternalProvider, RevisionSnapshot } from './constants';
import {
  briefDisplayKey,
  canTransition,
  diffRevisionSnapshots,
  DOCUMENT_STATUS_LABELS,
  documentDisplayKey,
  documentKeyOf,
  documentTransitions,
  fillTemplate,
  missingRequiredSections,
  normalizeExternalUrl,
  parseBriefKey,
  parseDocumentKey,
  type RevisionDiff,
} from './markdown';
import { loadUsableTemplate } from './templates';
```

2. `DocumentDetail` 在 `node: ModuleNodeRef | null;` 之后加：

```ts
  /** 简报的头部信息；其他文档为空。 */
  brief: BriefHeader | null;
  /** 变更 PRD 由哪份简报转出（该简报当前的 converted_document_id 指向它）；没有时为空。 */
  sourceBrief: { id: string; displayKey: string; title: string } | null;
  /** 所用模板的说明，显示在编辑器上方；没有模板或说明为空时为空。 */
  templateGuidance: string | null;
```

3. `hydrate` 整个函数替换为：

```ts
async function hydrate(tx: Tx, rows: DocRow[]): Promise<DocumentListItem[]> {
  if (rows.length === 0) return [];
  const keys = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, [...new Set(rows.map((r) => r.productId))]));
  const keyOf = new Map(keys.map((k) => [k.id, k.key]));
  const names = await memberNames(tx, rows.map((r) => r.ownerMemberId));
  // 覆盖需求数：变更 PRD 看 change_document_id，简报看 brief_document_id
  const changeIds = rows.filter((r) => r.kind !== 'brief').map((r) => r.id);
  const briefIds = rows.filter((r) => r.kind === 'brief').map((r) => r.id);
  const counts = [
    ...(changeIds.length > 0
      ? await tx
          .select({ id: requirements.changeDocumentId, n: sql<number>`count(*)::int` })
          .from(requirements)
          .where(and(inArray(requirements.changeDocumentId, changeIds), isNull(requirements.deletedAt)))
          .groupBy(requirements.changeDocumentId)
      : []),
    ...(briefIds.length > 0
      ? await tx
          .select({ id: requirements.briefDocumentId, n: sql<number>`count(*)::int` })
          .from(requirements)
          .where(and(inArray(requirements.briefDocumentId, briefIds), isNull(requirements.deletedAt)))
          .groupBy(requirements.briefDocumentId)
      : []),
  ];
  const countOf = new Map(counts.map((c) => [c.id!, c.n]));
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    number: r.number,
    displayKey: documentKeyOf(r.kind, keyOf.get(r.productId)!, r.number),
    kind: r.kind,
    title: r.title,
    source: r.source,
    status: r.status,
    owner: r.ownerMemberId ? { id: r.ownerMemberId, displayName: names.get(r.ownerMemberId) ?? '已删除的成员' } : null,
    externalUrl: r.externalUrl,
    externalProvider: r.externalProvider,
    requirementCount: countOf.get(r.id) ?? 0,
    updatedAt: r.updatedAt,
  }));
}
```

4. `detailOf` 整个函数替换为：

```ts
async function detailOf(tx: Tx, actor: Actor, doc: DocRow): Promise<DocumentDetail> {
  const role = await productRoleOf(tx, actor, doc.productId);
  if (!role) throw new AppError('not_found', doc.kind === 'brief' ? '简报不存在' : 'PRD 不存在');
  const [base] = await hydrate(tx, [doc]);
  const productKey = await productKeyOf(tx, doc.productId);
  const [rev] = doc.currentRevisionId ? await tx.select().from(documentRevisions).where(eq(documentRevisions.id, doc.currentRevisionId)) : [];
  const covers = doc.kind === 'brief' ? eq(requirements.briefDocumentId, doc.id) : eq(requirements.changeDocumentId, doc.id);
  const reqs = await tx
    .select()
    .from(requirements)
    .where(and(covers, isNull(requirements.deletedAt)))
    .orderBy(asc(requirements.number));
  const [header] = doc.kind === 'brief' ? await tx.select().from(documentBriefs).where(eq(documentBriefs.documentId, doc.id)) : [];
  const [source] =
    doc.kind === 'change'
      ? await tx
          .select({ id: documents.id, number: documents.number, title: documents.title })
          .from(documentBriefs)
          .innerJoin(documents, eq(documents.id, documentBriefs.documentId))
          .where(and(eq(documentBriefs.convertedDocumentId, doc.id), isNull(documents.deletedAt)))
          .limit(1)
      : [];
  const [tpl] = doc.templateId ? await tx.select({ guidance: documentTemplates.guidance }).from(documentTemplates).where(eq(documentTemplates.id, doc.templateId)) : [];
  return {
    ...base!,
    productKey,
    version: doc.version,
    templateId: doc.templateId,
    markdown: rev ? rev.snapshot.markdown : null,
    revisionNumber: rev ? rev.version : null,
    myRole: role,
    transitions: role === 'viewer' ? [] : documentTransitions(doc.kind, doc.status),
    requirements: reqs.map((r) => ({ id: r.id, displayKey: requirementDisplayKey(productKey, r.number), title: r.title, stateKey: r.stateKey })),
    checkItems: doc.kind === 'change' ? await documentCheckItemViews(tx, actor, role, doc) : [],
    node: await moduleNodeOf(tx, doc.nodeId),
    brief: header ? await briefHeaderTx(tx, header) : null,
    sourceBrief: source ? { id: source.id, displayKey: briefDisplayKey(productKey, source.number), title: source.title } : null,
    templateGuidance: tpl?.guidance.trim() ? tpl.guidance : null,
    createdAt: doc.createdAt,
  };
}
```

5. 在 `commitSystemRevisionTx` 之后加：

```ts
/**
 * 新建一份 Flower 文档：按类型取编号（简报用 brief_seq，变更 PRD 与模块文档共用 document_seq），写第 1 版正文，
 * 重建正文里的 [[ ]] 链接并接上写法相同的悬空链接。不检查权限，不记事件（调用方记）。
 */
export async function insertNativeDocumentTx(
  tx: Tx,
  actor: Actor,
  input: {
    productId: string;
    kind: 'change' | 'brief';
    title: string;
    status: DocumentStatus;
    ownerMemberId: string | null;
    templateId: string | null;
    markdown: string;
    summary: string | null;
  },
): Promise<DocRow> {
  const markdown = assertMarkdown(input.markdown);
  const [seq] =
    input.kind === 'brief'
      ? await tx
          .update(products)
          .set({ briefSeq: sql`${products.briefSeq} + 1` })
          .where(eq(products.id, input.productId))
          .returning({ n: products.briefSeq, key: products.key })
      : await tx
          .update(products)
          .set({ documentSeq: sql`${products.documentSeq} + 1` })
          .where(eq(products.id, input.productId))
          .returning({ n: products.documentSeq, key: products.key });
  const [row] = await tx
    .insert(documents)
    .values({
      orgId: actor.orgId,
      productId: input.productId,
      number: seq!.n,
      kind: input.kind,
      source: 'native',
      title: input.title,
      ownerMemberId: input.ownerMemberId,
      templateId: input.templateId,
      status: input.status,
      createdBy: actor.memberId,
    })
    .returning();
  const rev = await writeRevision(tx, actor, row!, { title: input.title, markdown }, { summary: input.summary, allowMerge: false });
  await tx.update(documents).set({ currentRevisionId: rev.id }).where(eq(documents.id, row!.id));
  await syncSourceLinks(tx, actor.orgId, { type: 'document', id: row!.id, productKey: seq!.key }, markdown, { markdown: true });
  await relinkDangling(tx, { type: 'document', id: row!.id, texts: [documentKeyOf(input.kind, seq!.key, row!.number)], withSections: true });
  return { ...row!, currentRevisionId: rev.id };
}
```

6. `getDocumentByKey` 整个函数替换为：

```ts
export async function getDocumentByKey(db: Db, actor: Actor, key: string): Promise<DocumentDetail> {
  const prd = parseDocumentKey(key);
  const brief = prd ? null : parseBriefKey(key);
  const parsed = prd ?? brief;
  const missing = brief ? '简报不存在' : 'PRD 不存在';
  if (!parsed) throw new AppError('not_found', missing);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({ d: documents })
      .from(documents)
      .innerJoin(products, eq(products.id, documents.productId))
      .where(
        and(
          eq(products.key, parsed.productKey),
          eq(documents.number, parsed.number),
          brief ? eq(documents.kind, 'brief') : ne(documents.kind, 'brief'),
          isNull(documents.deletedAt),
          isNull(products.deletedAt),
        ),
      );
    if (!row) throw new AppError('not_found', missing);
    return detailOf(tx, actor, row.d);
  });
}
```

7. `transitionDocument` 里 `if (!canTransition(doc.status, input.to)) {` 改为 `if (!canTransition(doc.status, input.to, doc.kind)) {`。

8. `setDocumentStatusTx` 整个函数替换为：

```ts
/**
 * 改文档状态：记录 document.status_changed（简报的 payload 带 kind: 'brief'，事件规则据此跳过）；变更 PRD 再按 id 升序锁住覆盖的需求，
 * 把它们的「PRD」检查项同步为新状态对应的结果。不检查权限与能否流转（调用方决定）。调用方已锁住文档行（锁顺序：文档 → 需求）。
 */
export async function setDocumentStatusTx(tx: Tx, actor: Actor, doc: DocRow, to: DocumentStatus): Promise<void> {
  await tx.update(documents).set({ status: to, updatedAt: new Date() }).where(eq(documents.id, doc.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: doc.productId,
    type: 'document.status_changed',
    subjectType: 'document',
    subjectId: doc.id,
    actor,
    payload: { changes: [{ field: 'status', old: doc.status, new: to }], ...(doc.kind === 'brief' ? { kind: 'brief' } : {}) },
  });
  if (doc.kind !== 'change') return;
  const covered = await tx
    .select({ id: requirements.id })
    .from(requirements)
    .where(and(eq(requirements.changeDocumentId, doc.id), isNull(requirements.deletedAt)))
    .orderBy(asc(requirements.id))
    .for('update');
  await syncPrdCheck(tx, actor, { id: doc.id, productId: doc.productId, status: to }, covered.map((r) => r.id));
}
```

`DocumentKind` 已在 `DocumentListItem.kind` 里使用；`documentDisplayKey` 仍用于 `assertUrlFree`、`createDocument`、`listRevisions`。

- [ ] **Step 5: 新建 `packages/core/src/documents/briefs.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentBriefs, documents } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { memberNames } from '../requirements/context';
import { assertTitle } from '../requirements/requirements';
import { orgToday } from '../tasks/tasks';
import type { BriefRow } from './brief-header';
import { type DocumentDetail, documentDetailInTx, type DocumentRow, insertNativeDocumentTx } from './documents';
import { fillTemplate } from './markdown';
import { effectiveTemplates, loadUsableTemplate } from './templates';

/** 取简报文档与头部（lock 时两行都 FOR UPDATE）；不是简报、已删除或没有头部时按「简报不存在」处理。 */
export async function loadBriefTx(tx: Tx, id: string, opts: { lock?: boolean } = {}): Promise<{ doc: DocumentRow; header: BriefRow }> {
  const dq = tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.kind, 'brief'), isNull(documents.deletedAt)));
  const [doc] = opts.lock ? await dq.for('update') : await dq;
  if (!doc) throw new AppError('not_found', '简报不存在');
  const hq = tx.select().from(documentBriefs).where(eq(documentBriefs.documentId, id));
  const [header] = opts.lock ? await hq.for('update') : await hq;
  if (!header) throw new AppError('not_found', '简报不存在');
  return { doc, header };
}

/** 简报所在产品的角色：看不到时按「简报不存在」处理，不够时 forbidden。 */
export async function briefRoleTx(tx: Tx, actor: Actor, doc: DocumentRow, need: ProductRole): Promise<ProductRole> {
  const role = await productRoleOf(tx, actor, doc.productId);
  if (!role) throw new AppError('not_found', '简报不存在');
  if (!atLeast(role, need)) throw new AppError('forbidden', '权限不足');
  return role;
}

/**
 * 新建简报：产品编辑及以上。没有指定模板时用产品可用的第一份简报模板（没有时为空白正文）；作者为创建人；状态讨论中。
 */
export async function createBrief(db: Db, actor: Actor, productId: string, input: { title: string; templateId?: string | null }): Promise<DocumentDetail> {
  const title = assertTitle(input.title);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'editor');
    const tpl = input.templateId ? await loadUsableTemplate(tx, productId, input.templateId, 'brief') : ((await effectiveTemplates(tx, productId, 'brief'))[0] ?? null);
    const names = await memberNames(tx, [actor.memberId]);
    const markdown = tpl ? fillTemplate(tpl.body, { date: await orgToday(tx, actor.orgId), author: names.get(actor.memberId) ?? '' }) : '';
    const doc = await insertNativeDocumentTx(tx, actor, { productId, kind: 'brief', title, status: 'discussing', ownerMemberId: null, templateId: tpl?.id ?? null, markdown, summary: null });
    await tx.insert(documentBriefs).values({ documentId: doc.id, orgId: actor.orgId, authorMemberId: actor.memberId });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'brief.created',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { number: doc.number, title, templateId: doc.templateId, authorMemberId: actor.memberId },
    });
    return documentDetailInTx(tx, actor, doc.id);
  });
}
```

- [ ] **Step 6: 链接卡、被引用、补全与事件规则**

1. `packages/core/src/links/cards.ts`：导入改为 `import { DOCUMENT_STATUS_LABELS, documentDisplayKey, documentKeyOf, normalizeHeading, splitSections } from '../documents/markdown';`（`documentDisplayKey` 仍用于模块与功能点链接到模块文档的 `href`）；`loadTargets` 里文档那段 `const key = documentDisplayKey(keyOf.get(d.productId)!, d.number);` 改为：

```ts
      const key = documentKeyOf(d.kind, keyOf.get(d.productId)!, d.number);
```

2. `packages/core/src/links/backlinks.ts`：导入改为 `import { documentKeyOf } from '../documents/markdown';`，文档分组那行改为：

```ts
      const key = documentKeyOf(d.kind, keyOf.get(d.productId)!, d.number);
```

3. `packages/core/src/links/search.ts`：drizzle 导入加 `ne`；`sectionSuggestions` 的查询条件改为：

```ts
    .where(and(eq(documents.productId, productId), eq(documents.number, number), ne(documents.kind, 'brief'), isNull(documents.deletedAt)));
```

4. `packages/core/src/notifications/match.ts`：`matchNotificationRules` 第一行改为：

```ts
  // 简报沿用 document.status_changed（payload.kind = 'brief'），不当作「PRD 状态变化」推送（设计 §5）
  if (!isNotifiableEventType(ev.type) || ev.payload.kind === 'brief') return;
```

- [ ] **Step 7: 加入包入口**

`packages/core/src/index.ts` 在 `export * from './documents/documents';` 之后加：

```ts
export * from './documents/brief-header';
export * from './documents/briefs';
```

新导出名 `BriefRow`、`BriefHeader`、`briefHeaderTx`、`loadBriefTx`、`briefRoleTx`、`createBrief`、`insertNativeDocumentTx` 不与已有导出重名（写计划时已检索）。

- [ ] **Step 8: 运行测试确认通过，类型检查并提交**

Run: `pnpm --filter @flower/core exec vitest run test/briefs-documents.test.ts test/documents.test.ts test/document-coverage.test.ts test/module-docs.test.ts test/links.test.ts test/link-queries.test.ts test/link-search.test.ts test/notify-rules.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

```bash
git add packages/core/src/documents/brief-header.ts packages/core/src/documents/briefs.ts packages/core/src/documents/documents.ts packages/core/src/links/cards.ts packages/core/src/links/backlinks.ts packages/core/src/links/search.ts packages/core/src/notifications/match.ts packages/core/src/index.ts packages/core/test/briefs-documents.test.ts
git commit -m "feat(core): 新建简报；文档详情、按编号打开、流转、链接卡与被引用按简报区分；简报改状态不触发群推送

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: 简报的覆盖需求、头部信息、闸口与列表

**Files:**
- Modify: `packages/core/src/documents/coverage.ts`、`packages/core/src/documents/briefs.ts`
- Test: `packages/core/test/briefs-services.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `evaluateBriefGate`、`BriefGate`、`BRIEF_GATE_ITEMS`、`BRIEF_TEMPLATE`；Task 5 的 `loadBriefTx`、`briefRoleTx`、`documentDetailInTx`、`createBrief`
- Produces:
  - `coverage.ts`：`linkBriefRequirementsTx(tx, actor, documentId, requirementIds): Promise<{ linked: number }>`；`linkDocumentRequirements` 与 `unlinkDocumentRequirement` 按文档类型处理（简报写 `brief_document_id`）
  - `briefs.ts`：
    - `createBrief(db, actor, productId, { title; templateId?; requirementIds?: string[] })`
    - `BriefHeaderInput = { version?: string; requesterMemberId?: string | null; deciderMemberId?: string | null; authorMemberId?: string | null; participantTagIds?: string[]; relatedLinks?: BriefRelatedLink[] }`；`updateBrief(db, actor, id, input: BriefHeaderInput): Promise<DocumentDetail>`
    - `briefGatesTx(tx, rows: Array<{ doc: DocumentRow; header: BriefRow }>): Promise<Map<string, BriefGate>>`；`getBriefGate(db, actor, id): Promise<BriefGate>`；`setBriefGateCheck(db, actor, id, item: number, input: { checked: boolean }): Promise<BriefGate>`
    - `BriefFilter = { productId?: string; statuses?: DocumentStatus[]; deciderId?: string }`；`BriefListItem = { id; productId; displayKey; title; status: DocumentStatus; requirementCount: number; gate: { passed: number; total: number }; decider: MemberRef | null; updatedAt: Date }`；`listBriefs(db, actor, filter?: BriefFilter): Promise<BriefListItem[]>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/briefs-services.test.ts`：

```ts
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, requirements } from '../src/db/schema';
import { createBrief, getBriefGate, listBriefs, setBriefGateCheck, updateBrief } from '../src/documents/briefs';
import { linkDocumentRequirements, unlinkDocumentRequirement } from '../src/documents/coverage';
import { createDocument, getDocumentByKey, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createRequirement } from '../src/requirements/requirements';
import { createFunctionTag, deleteFunctionTag, listFunctionTags } from '../src/tenancy/function-tags';
import { createAgentMember, updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guest: Actor;
let pan: string;
let docProduct: string;
let prdId: string;
const RANDOM = '00000000-0000-4000-8000-000000000001';

const eventsOf = (subjectId: string, type?: string) =>
  t.adminDb
    .select()
    .from(domainEvents)
    .where(type ? and(eq(domainEvents.subjectId, subjectId), eq(domainEvents.type, type)) : eq(domainEvents.subjectId, subjectId))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));
const brief1 = () => getDocumentByKey(t.db, editor, 'PAN-B-1');

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  docProduct = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '访客丙', 'guest');
  await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('覆盖需求', () => {
  it('新建时可直接覆盖；按文档接口关联与移出；一条需求只能挂一份简报，可以同时挂 PRD；已废弃的简报不能再关联；记事件', async () => {
    const r1 = await createRequirement(t.db, editor, pan, { title: '需求一' });
    const r2 = await createRequirement(t.db, editor, pan, { title: '需求二' });
    const r3 = await createRequirement(t.db, editor, docProduct, { title: '别的产品的需求' });
    const b1 = await createBrief(t.db, editor, pan, { title: '简报一', requirementIds: [r1.id] });
    expect([b1.requirements.map((r) => r.displayKey), b1.requirementCount]).toEqual([['PAN-1'], 1]);
    await linkDocumentRequirements(t.db, editor, b1.id, { requirementIds: [r2.id] });
    const prd = await createDocument(t.db, editor, pan, { title: 'PRD', requirementIds: [r2.id] });
    prdId = prd.id;
    const [row] = await t.adminDb.select().from(requirements).where(eq(requirements.id, r2.id));
    expect([row!.briefDocumentId, row!.changeDocumentId]).toEqual([b1.id, prd.id]);

    const b2 = await createBrief(t.db, editor, pan, { title: '简报二' });
    await expect(linkDocumentRequirements(t.db, editor, b2.id, { requirementIds: [r1.id] })).rejects.toThrow('PAN-1 已挂在 PAN-B-1 上，请先从那份简报移出');
    await expect(linkDocumentRequirements(t.db, editor, b2.id, { requirementIds: [r3.id] })).rejects.toThrow('DOC-1 不属于这份简报所在的产品');
    await expect(linkDocumentRequirements(t.db, viewer, b1.id, { requirementIds: [r2.id] })).rejects.toMatchObject({ code: 'forbidden' });

    await unlinkDocumentRequirement(t.db, editor, b1.id, r2.id);
    await expect(unlinkDocumentRequirement(t.db, editor, b1.id, r2.id)).rejects.toThrow('该需求没有挂在这份简报上');
    expect((await brief1()).requirements.map((r) => r.displayKey)).toEqual(['PAN-1']);
    expect((await getDocumentByKey(t.db, editor, prd.displayKey)).requirements.map((r) => r.displayKey)).toEqual(['PAN-2']);
    expect((await eventsOf(b1.id)).map((e) => e.type)).toEqual(['brief.created', 'document.requirements_linked', 'document.requirements_linked', 'document.requirement_unlinked']);
    const [ev] = await eventsOf(r1.id, 'requirement.updated');
    expect(ev!.payload).toMatchObject({ changes: [{ field: 'briefDocumentId', old: null, new: b1.id }], brief: 'PAN-B-1' });

    await transitionDocument(t.db, editor, b2.id, { to: 'discarded' });
    await expect(linkDocumentRequirements(t.db, editor, b2.id, { requirementIds: [r2.id] })).rejects.toThrow('已废弃的简报不能再关联需求');
  });
});

describe('头部信息', () => {
  it('改版本、提出人、决策人、参与方、关联文档；只记变化的字段；没有变化时不记事件', async () => {
    const b = await brief1();
    const [dev, qa] = (await listFunctionTags(t.db, owner)).filter((x) => ['开发', '测试'].includes(x.name));
    const r = await updateBrief(t.db, editor, b.id, {
      version: ' v0.2 ',
      deciderMemberId: viewer.memberId,
      requesterMemberId: owner.memberId,
      participantTagIds: [dev!.id, qa!.id, dev!.id],
      relatedLinks: [
        { kind: 'wiki', target: '[[PAN-PRD-1]]', note: ' 旧方案 ' },
        { kind: 'url', url: ' https://doc.example.com/x ', note: '群聊记录' },
      ],
    });
    expect(r.brief).toMatchObject({
      version: 'v0.2',
      decider: { id: viewer.memberId, displayName: '只读乙' },
      requester: { id: owner.memberId },
      author: { id: editor.memberId },
      participantTags: [
        { id: dev!.id, name: '开发' },
        { id: qa!.id, name: '测试' },
      ],
      relatedLinks: [
        { kind: 'wiki', target: 'PAN-PRD-1', note: '旧方案' },
        { kind: 'url', url: 'https://doc.example.com/x', note: '群聊记录' },
      ],
    });
    const updated = await eventsOf(b.id, 'brief.updated');
    expect(updated).toHaveLength(1);
    expect((updated[0]!.payload.changes as Array<{ field: string }>).map((c) => c.field).sort()).toEqual(['deciderMemberId', 'participantTagIds', 'relatedLinks', 'requesterMemberId', 'version']);
    await updateBrief(t.db, editor, b.id, { version: 'v0.2' });
    expect(await eventsOf(b.id, 'brief.updated')).toHaveLength(1);
  });

  it('校验：Agent 与已离开的成员不能被选；标签必须存在；网址与引用格式；条数与长度；只读不能改', async () => {
    const b = await brief1();
    const agent = await createAgentMember(t.db, owner, { displayName: '机器人' });
    await expect(updateBrief(t.db, editor, b.id, { deciderMemberId: agent.id })).rejects.toThrow('不能选择 Agent 成员');
    const left = await asMember(t.db, owner, '已离开丁');
    await updateMember(t.db, owner, left.memberId, { status: 'left' });
    await expect(updateBrief(t.db, editor, b.id, { authorMemberId: left.memberId })).rejects.toThrow('该成员已离开组织，不能选择');
    await expect(updateBrief(t.db, editor, b.id, { participantTagIds: [RANDOM] })).rejects.toThrow('参与方标签不存在');
    await expect(updateBrief(t.db, editor, b.id, { relatedLinks: [{ kind: 'url', url: 'ftp://x', note: '' }] })).rejects.toThrow('关联文档的网址无效');
    await expect(updateBrief(t.db, editor, b.id, { relatedLinks: [{ kind: 'wiki', target: '[[ ]]', note: '' }] })).rejects.toThrow('引用写法无效');
    const many = Array.from({ length: 21 }, (_, i) => ({ kind: 'url' as const, url: `https://doc.example.com/${i}`, note: '' }));
    await expect(updateBrief(t.db, editor, b.id, { relatedLinks: many })).rejects.toThrow('关联文档不超过 20 条');
    await expect(updateBrief(t.db, editor, b.id, { version: ' ' })).rejects.toThrow('版本不能为空，且不超过 30 个字符');
    await expect(updateBrief(t.db, viewer, b.id, { version: 'v1' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateBrief(t.db, readOnlyToken(owner), b.id, { version: 'v1' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateBrief(t.db, editor, prdId, { version: 'v1' })).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
  });

  it('删掉的职能标签不再显示在参与方里', async () => {
    const b = await brief1();
    const legal = await createFunctionTag(t.db, owner, { name: '法务', color: '#64748b' });
    await updateBrief(t.db, editor, b.id, { participantTagIds: [legal.id] });
    await deleteFunctionTag(t.db, owner, legal.id);
    expect((await brief1()).brief!.participantTags).toEqual([]);
  });
});

describe('闸口', () => {
  it('只读可读；编辑勾选与取消人工项并记录勾选人与时间；重复勾选不记事件；自动项与不存在的项不能勾选；只读 Token 不能勾选', async () => {
    const b = await brief1();
    const g0 = await getBriefGate(t.db, viewer, b.id);
    expect([g0.passed, g0.total]).toEqual([2, 11]);
    const g1 = await setBriefGateCheck(t.db, editor, b.id, 2, { checked: true });
    expect(g1.passed).toBe(3);
    expect(g1.items.find((i) => i.no === 2)).toMatchObject({ passed: true, checkedBy: { id: editor.memberId, displayName: '编辑甲' } });
    expect(g1.items.find((i) => i.no === 2)!.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await setBriefGateCheck(t.db, editor, b.id, 2, { checked: true })).passed).toBe(3);
    expect((await setBriefGateCheck(t.db, editor, b.id, 2, { checked: false })).passed).toBe(2);
    await expect(setBriefGateCheck(t.db, editor, b.id, 1, { checked: true })).rejects.toThrow('这一项由系统检查，不能手动勾选');
    await expect(setBriefGateCheck(t.db, editor, b.id, 12, { checked: true })).rejects.toThrow('闸口项不存在');
    await expect(setBriefGateCheck(t.db, viewer, b.id, 3, { checked: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setBriefGateCheck(t.db, readOnlyToken(owner), b.id, 3, { checked: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getBriefGate(t.db, editor, prdId)).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
    expect((await eventsOf(b.id, 'brief.gate_checked')).map((e) => e.payload)).toMatchObject([
      { item: 2, checked: true, changes: [{ field: 'gate.2', old: false, new: true }] },
      { item: 2, checked: false },
    ]);
  });
});

describe('简报列表', () => {
  it('按可见产品过滤；按产品、状态、决策人筛选；带覆盖需求数、闸口进度与决策人；按更新时间倒序', async () => {
    const other = await createBrief(t.db, owner, docProduct, { title: '别的产品的简报' });
    expect(other.displayKey).toBe('DOC-B-1');
    const all = await listBriefs(t.db, owner);
    expect(all.map((x) => x.displayKey)).toEqual(['DOC-B-1', 'PAN-B-1', 'PAN-B-2']);
    expect(all.find((x) => x.displayKey === 'PAN-B-1')).toMatchObject({
      title: '简报一',
      status: 'discussing',
      requirementCount: 1,
      gate: { passed: 2, total: 11 },
      decider: { id: viewer.memberId, displayName: '只读乙' },
    });
    expect((await listBriefs(t.db, owner, { productId: pan })).map((x) => x.displayKey)).toEqual(['PAN-B-1', 'PAN-B-2']);
    expect((await listBriefs(t.db, owner, { statuses: ['discarded'] })).map((x) => x.displayKey)).toEqual(['PAN-B-2']);
    expect((await listBriefs(t.db, owner, { deciderId: viewer.memberId })).map((x) => x.displayKey)).toEqual(['PAN-B-1']);
    expect((await listBriefs(t.db, guest)).map((x) => x.displayKey)).toEqual(['PAN-B-1', 'PAN-B-2']);
    expect(await listBriefs(t.db, guest, { productId: docProduct })).toEqual([]);
    expect(await listBriefs(t.db, owner, { productId: RANDOM })).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/briefs-services.test.ts`
Expected: FAIL（`createBrief` 不认 `requirementIds`，`updateBrief` 等不存在）。

- [ ] **Step 3: 修改 `documents/coverage.ts`**

1. 第 4 行的表导入加 `documents`：`import { checkItemResults, documents, products, requirements } from '../db/schema';`；第 14 行改为 `import { briefDisplayKey, documentDisplayKey, prdCheckState } from './markdown';`。

2. 在 `linkRequirementsTx` 之后加：

```ts
/** 在已有事务里把需求挂到简报上（先锁简报，再按 id 升序锁需求）。已挂在这份简报上的跳过。 */
export async function linkBriefRequirementsTx(tx: Tx, actor: Actor, documentId: string, requirementIds: string[]): Promise<{ linked: number }> {
  const ids = [...new Set(requirementIds)].sort();
  if (ids.length === 0 || ids.length > 200) throw new AppError('invalid', '一次关联 1–200 条需求');
  const doc = await loadDocument(tx, documentId, { lock: true });
  await requireProductRole(tx, actor, doc.productId, 'editor');
  if (doc.kind !== 'brief') throw new AppError('invalid', '只有简报可以这样关联需求');
  if (doc.status === 'discarded') throw new AppError('invalid', '已废弃的简报不能再关联需求');
  const rows = await tx
    .select()
    .from(requirements)
    .where(and(inArray(requirements.id, ids), isNull(requirements.deletedAt)))
    .orderBy(asc(requirements.id))
    .for('update');
  if (rows.length !== ids.length) throw new AppError('invalid', '需求不存在');
  const keyRows = await tx
    .select({ id: products.id, key: products.key })
    .from(products)
    .where(inArray(products.id, [...new Set([doc.productId, ...rows.map((r) => r.productId)])]));
  const keyOf = new Map(keyRows.map((k) => [k.id, k.key]));
  const productKey = keyOf.get(doc.productId)!;
  for (const r of rows) {
    const reqKey = displayKey(keyOf.get(r.productId)!, r.number);
    if (r.productId !== doc.productId) throw new AppError('invalid', `${reqKey} 不属于这份简报所在的产品`);
    if (r.briefDocumentId && r.briefDocumentId !== doc.id) {
      const other = await loadDocument(tx, r.briefDocumentId);
      throw new AppError('conflict', `${reqKey} 已挂在 ${briefDisplayKey(productKey, other.number)} 上，请先从那份简报移出`);
    }
  }
  const fresh = rows.filter((r) => r.briefDocumentId !== doc.id);
  if (fresh.length === 0) return { linked: 0 };
  const now = new Date();
  const briefKey = briefDisplayKey(productKey, doc.number);
  for (const r of fresh) {
    await tx.update(requirements).set({ briefDocumentId: doc.id, updatedAt: now }).where(eq(requirements.id, r.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'requirement.updated',
      subjectType: 'requirement',
      subjectId: r.id,
      actor,
      payload: { changes: [{ field: 'briefDocumentId', old: null, new: doc.id }], brief: briefKey },
    });
  }
  await tx.update(documents).set({ updatedAt: now }).where(eq(documents.id, doc.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: doc.productId,
    type: 'document.requirements_linked',
    subjectType: 'document',
    subjectId: doc.id,
    actor,
    payload: { requirementIds: fresh.map((r) => r.id), changes: [{ field: 'requirements', old: null, new: fresh.map((r) => displayKey(productKey, r.number)) }] },
  });
  return { linked: fresh.length };
}
```

3. `linkDocumentRequirements` 整个函数替换为：

```ts
/** 文档接口的「关联需求」：变更 PRD 写 change_document_id，简报写 brief_document_id。 */
export async function linkDocumentRequirements(db: Db, actor: Actor, documentId: string, input: { requirementIds: string[] }): Promise<{ linked: number }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [d] = await tx.select({ kind: documents.kind }).from(documents).where(eq(documents.id, documentId));
    return d?.kind === 'brief' ? linkBriefRequirementsTx(tx, actor, documentId, input.requirementIds) : linkRequirementsTx(tx, actor, documentId, input.requirementIds);
  });
}
```

4. `unlinkDocumentRequirement` 整个函数替换为：

```ts
/** 从 PRD 或简报移出一条需求。PRD 的「PRD」检查项保留当时的值，之后恢复手工维护。 */
export async function unlinkDocumentRequirement(db: Db, actor: Actor, documentId: string, requirementId: string): Promise<void> {
  await withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    const brief = doc.kind === 'brief';
    const field = brief ? 'briefDocumentId' : 'changeDocumentId';
    const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, requirementId), isNull(requirements.deletedAt))).for('update');
    if (!r || r[field] !== doc.id) throw new AppError('invalid', brief ? '该需求没有挂在这份简报上' : '该需求没有挂在这份 PRD 上');
    const now = new Date();
    await tx
      .update(requirements)
      .set(brief ? { briefDocumentId: null, updatedAt: now } : { changeDocumentId: null, updatedAt: now })
      .where(eq(requirements.id, r.id));
    if (brief) await tx.update(documents).set({ updatedAt: now }).where(eq(documents.id, doc.id));
    const reqKey = displayKey(await productKeyOf(tx, r.productId), r.number);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'requirement.updated',
      subjectType: 'requirement',
      subjectId: r.id,
      actor,
      payload: { changes: [{ field, old: doc.id, new: null }] },
    });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.requirement_unlinked',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { requirementId: r.id, changes: [{ field: 'requirements', old: reqKey, new: null }] },
    });
  });
}
```

- [ ] **Step 4: 扩充 `documents/briefs.ts`**

1. 导入整体替换为：

```ts
import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { documentBriefs, documentRevisions, documents, documentTemplates, functionTags, products, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertAssignableMember, memberNames } from '../requirements/context';
import { assertTitle, type MemberRef } from '../requirements/requirements';
import { orgToday } from '../tasks/tasks';
import type { BriefRow } from './brief-header';
import { type BriefGate, evaluateBriefGate } from './brief-model';
import { BRIEF_GATE_ITEMS, BRIEF_TEMPLATE } from './brief-template';
import type { BriefRelatedLink, DocumentStatus } from './constants';
import { linkBriefRequirementsTx } from './coverage';
import { type DocumentDetail, documentDetailInTx, type DocumentRow, insertNativeDocumentTx } from './documents';
import { briefDisplayKey, fillTemplate, normalizeExternalUrl } from './markdown';
import { effectiveTemplates, loadUsableTemplate } from './templates';
```

2. `createBrief` 的 `input` 类型改为 `{ title: string; templateId?: string | null; requirementIds?: string[] }`，在 `recordEvent(… 'brief.created' …)` 之后、`return` 之前加：

```ts
    if (input.requirementIds?.length) await linkBriefRequirementsTx(tx, actor, doc.id, input.requirementIds);
```

3. 文件末尾加：

```ts
export type BriefHeaderInput = {
  version?: string;
  requesterMemberId?: string | null;
  deciderMemberId?: string | null;
  authorMemberId?: string | null;
  participantTagIds?: string[];
  relatedLinks?: BriefRelatedLink[];
};
export type BriefFilter = { productId?: string; statuses?: DocumentStatus[]; deciderId?: string };
export type BriefListItem = {
  id: string;
  productId: string;
  displayKey: string;
  title: string;
  status: DocumentStatus;
  requirementCount: number;
  gate: { passed: number; total: number };
  decider: MemberRef | null;
  updatedAt: Date;
};

const LINKS_MAX = 20;
const TAGS_MAX = 20;
const NOTE_MAX = 100;

function assertVersion(v: string): string {
  const s = v.trim();
  if (!s || s.length > 30) throw new AppError('invalid', '版本不能为空，且不超过 30 个字符');
  return s;
}

function assertLinks(links: BriefRelatedLink[]): BriefRelatedLink[] {
  if (links.length > LINKS_MAX) throw new AppError('invalid', `关联文档不超过 ${LINKS_MAX} 条`);
  return links.map((l): BriefRelatedLink => {
    const note = l.note.trim();
    if (note.length > NOTE_MAX) throw new AppError('invalid', `关联文档的说明不超过 ${NOTE_MAX} 个字符`);
    if (l.kind === 'url') {
      const u = normalizeExternalUrl(l.url);
      if (!u) throw new AppError('invalid', '关联文档的网址无效（需以 http:// 或 https:// 开头，且不含空格）');
      return { kind: 'url', url: u.url, note };
    }
    const target = l.target.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
    if (!target || target.length > 100 || /[[\]|\n]/.test(target)) throw new AppError('invalid', '引用写法无效，例如 PAN-PRD-3');
    return { kind: 'wiki', target, note };
  });
}

/** 一批简报的闸口结果：一次取当前正文、所用模板与勾选人姓名。简报没有模板时按预置简报模板去掉原样内容。 */
export async function briefGatesTx(tx: Tx, rows: Array<{ doc: DocumentRow; header: BriefRow }>): Promise<Map<string, BriefGate>> {
  if (rows.length === 0) return new Map();
  const revIds = rows.map((r) => r.doc.currentRevisionId).filter((x): x is string => !!x);
  const revs = revIds.length > 0 ? await tx.select({ id: documentRevisions.id, snapshot: documentRevisions.snapshot }).from(documentRevisions).where(inArray(documentRevisions.id, revIds)) : [];
  const tplIds = [...new Set(rows.map((r) => r.doc.templateId).filter((x): x is string => !!x))];
  const tpls = tplIds.length > 0 ? await tx.select({ id: documentTemplates.id, body: documentTemplates.body }).from(documentTemplates).where(inArray(documentTemplates.id, tplIds)) : [];
  const names = await memberNames(tx, rows.flatMap((r) => r.header.gateChecks.map((c) => c.memberId)));
  const markdownOf = new Map(revs.map((v) => [v.id, v.snapshot.markdown]));
  const bodyOf = new Map(tpls.map((x) => [x.id, x.body]));
  return new Map(
    rows.map((r) => [
      r.doc.id,
      evaluateBriefGate({
        markdown: r.doc.currentRevisionId ? (markdownOf.get(r.doc.currentRevisionId) ?? '') : '',
        templateBody: (r.doc.templateId ? bodyOf.get(r.doc.templateId) : undefined) ?? BRIEF_TEMPLATE.body,
        checks: r.header.gateChecks,
        names,
      }),
    ]),
  );
}

export async function getBriefGate(db: Db, actor: Actor, id: string): Promise<BriefGate> {
  return withOrg(db, actor.orgId, async (tx) => {
    const b = await loadBriefTx(tx, id);
    await briefRoleTx(tx, actor, b.doc, 'viewer');
    return (await briefGatesTx(tx, [b])).get(id)!;
  });
}

/** 勾选或取消闸口人工项（产品编辑及以上）；状态不变时不写、不记事件。 */
export async function setBriefGateCheck(db: Db, actor: Actor, id: string, item: number, input: { checked: boolean }): Promise<BriefGate> {
  const def = BRIEF_GATE_ITEMS.find((g) => g.no === item);
  if (!def) throw new AppError('invalid', '闸口项不存在');
  if (def.auto) throw new AppError('invalid', '这一项由系统检查，不能手动勾选');
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, header } = await loadBriefTx(tx, id, { lock: true });
    await briefRoleTx(tx, actor, doc, 'editor');
    const cur = header.gateChecks.some((c) => c.item === item);
    let gateChecks = header.gateChecks;
    if (input.checked !== cur) {
      const now = new Date();
      gateChecks = input.checked
        ? [...header.gateChecks, { item, memberId: actor.memberId, at: now.toISOString() }].sort((a, b) => a.item - b.item)
        : header.gateChecks.filter((c) => c.item !== item);
      await tx.update(documentBriefs).set({ gateChecks, updatedAt: now }).where(eq(documentBriefs.documentId, id));
      await tx.update(documents).set({ updatedAt: now }).where(eq(documents.id, id));
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: doc.productId,
        type: 'brief.gate_checked',
        subjectType: 'document',
        subjectId: id,
        actor,
        payload: { item, checked: input.checked, changes: [{ field: `gate.${item}`, old: cur, new: input.checked }] },
      });
    }
    return (await briefGatesTx(tx, [{ doc, header: { ...header, gateChecks } }])).get(id)!;
  });
}

/** 改头部信息（产品编辑及以上）。新选的成员须为在职真人成员；参与方须为现有职能标签；只记变化的字段。 */
export async function updateBrief(db: Db, actor: Actor, id: string, input: BriefHeaderInput): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, header: cur } = await loadBriefTx(tx, id, { lock: true });
    await briefRoleTx(tx, actor, doc, 'editor');
    const next = {
      version: input.version === undefined ? cur.version : assertVersion(input.version),
      requesterMemberId: input.requesterMemberId === undefined ? cur.requesterMemberId : input.requesterMemberId,
      deciderMemberId: input.deciderMemberId === undefined ? cur.deciderMemberId : input.deciderMemberId,
      authorMemberId: input.authorMemberId === undefined ? cur.authorMemberId : input.authorMemberId,
      participantTagIds: input.participantTagIds === undefined ? cur.participantTagIds : [...new Set(input.participantTagIds)],
      relatedLinks: input.relatedLinks === undefined ? cur.relatedLinks : assertLinks(input.relatedLinks),
    };
    for (const f of ['requesterMemberId', 'deciderMemberId', 'authorMemberId'] as const) {
      const v = next[f];
      if (v && v !== cur[f]) await assertAssignableMember(tx, v);
    }
    if (input.participantTagIds !== undefined) {
      if (next.participantTagIds.length > TAGS_MAX) throw new AppError('invalid', `参与方不超过 ${TAGS_MAX} 个`);
      const found = next.participantTagIds.length > 0 ? await tx.select({ id: functionTags.id }).from(functionTags).where(inArray(functionTags.id, next.participantTagIds)) : [];
      if (found.length !== next.participantTagIds.length) throw new AppError('invalid', '参与方标签不存在');
    }
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => JSON.stringify(c.old) !== JSON.stringify(c.new));
    if (changes.length > 0) {
      const now = new Date();
      await tx.update(documentBriefs).set({ ...next, updatedAt: now }).where(eq(documentBriefs.documentId, id));
      await tx.update(documents).set({ updatedAt: now }).where(eq(documents.id, id));
      await recordEvent(tx, { orgId: actor.orgId, productId: doc.productId, type: 'brief.updated', subjectType: 'document', subjectId: id, actor, payload: { changes } });
    }
    return documentDetailInTx(tx, actor, id);
  });
}

/** 简报列表：只含看得到的产品；合法 UUID 但看不到或不存在的产品返回空列表。按更新时间倒序。 */
export async function listBriefs(db: Db, actor: Actor, filter: BriefFilter = {}): Promise<BriefListItem[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = [...(await visibleProductIds(tx, actor))];
    const productIds = filter.productId ? visible.filter((p) => p === filter.productId) : visible;
    if (productIds.length === 0) return [];
    const conds: SQL[] = [inArray(documents.productId, productIds), eq(documents.kind, 'brief'), isNull(documents.deletedAt)];
    if (filter.statuses?.length) conds.push(inArray(documents.status, filter.statuses));
    if (filter.deciderId) conds.push(eq(documentBriefs.deciderMemberId, filter.deciderId));
    const rows = await tx
      .select({ doc: documents, header: documentBriefs, key: products.key })
      .from(documents)
      .innerJoin(documentBriefs, eq(documentBriefs.documentId, documents.id))
      .innerJoin(products, eq(products.id, documents.productId))
      .where(and(...conds))
      .orderBy(desc(documents.updatedAt), desc(documents.number));
    if (rows.length === 0) return [];
    const gates = await briefGatesTx(tx, rows);
    const counts = await tx
      .select({ id: requirements.briefDocumentId, n: sql<number>`count(*)::int` })
      .from(requirements)
      .where(and(inArray(requirements.briefDocumentId, rows.map((r) => r.doc.id)), isNull(requirements.deletedAt)))
      .groupBy(requirements.briefDocumentId);
    const countOf = new Map(counts.map((c) => [c.id!, c.n]));
    const names = await memberNames(tx, rows.map((r) => r.header.deciderMemberId));
    return rows.map(({ doc, header, key }) => {
      const g = gates.get(doc.id)!;
      return {
        id: doc.id,
        productId: doc.productId,
        displayKey: briefDisplayKey(key, doc.number),
        title: doc.title,
        status: doc.status,
        requirementCount: countOf.get(doc.id) ?? 0,
        gate: { passed: g.passed, total: g.total },
        decider: header.deciderMemberId ? { id: header.deciderMemberId, displayName: names.get(header.deciderMemberId) ?? '已删除的成员' } : null,
        updatedAt: doc.updatedAt,
      };
    });
  });
}
```

（`atLeast`、`productRoleOf` 仍由 Task 5 的 `briefRoleTx` 使用；新导出名 `BriefHeaderInput`、`BriefFilter`、`BriefListItem`、`briefGatesTx`、`getBriefGate`、`setBriefGateCheck`、`updateBrief`、`listBriefs`、`linkBriefRequirementsTx` 不与已有导出重名。）

- [ ] **Step 5: 运行测试确认通过，类型检查并提交**

Run: `pnpm --filter @flower/core exec vitest run test/briefs-services.test.ts test/briefs-documents.test.ts test/document-coverage.test.ts test/module-docs.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

```bash
git add packages/core/src/documents/coverage.ts packages/core/src/documents/briefs.ts packages/core/test/briefs-services.test.ts
git commit -m "feat(core): 简报覆盖需求、头部信息、写 PRD 闸口与简报列表

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: 转 PRD 与上下文

**Files:**
- Modify: `packages/core/src/documents/briefs.ts`
- Test: `packages/core/test/brief-convert.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `briefToPrdMarkdown`、`BriefContext`；Task 5 的 `insertNativeDocumentTx`、`setDocumentStatusTx`、`documentMarkdownTx`、`MAX_MARKDOWN_CHARS`、`briefHeaderTx`；Task 6 的 `briefGatesTx`；已有的 `linkRequirementsTx`（`coverage.ts`）、`productWorkflowBody`
- Produces（`briefs.ts`）:
  - `BriefConvertResult = { document: DocumentDetail; skipped: Array<{ id: string; displayKey: string; title: string; documentKey: string }> }`
  - `convertBriefToPrd(db, actor, id, input?: { again?: boolean }): Promise<BriefConvertResult>`；已转过且原 PRD 仍在、没有 `again` 时 `AppError('conflict', '这份简报已转为 PAN-PRD-n', { documentKey })`
  - `getBriefContext(db, actor, id): Promise<BriefContext>`（查看权限，只读 Token 可读）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/brief-convert.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { briefContextMarkdown } from '../src/documents/brief-model';
import { convertBriefToPrd, createBrief, getBriefContext, updateBrief } from '../src/documents/briefs';
import { createDocument, getDocumentByKey, listDocuments, listRevisions, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { listBacklinks } from '../src/links/backlinks';
import { createRequirement } from '../src/requirements/requirements';
import { updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guest: Actor;
let pan: string;

const eventOf = async (subjectId: string, type: string) =>
  (await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, subjectId), eq(domainEvents.type, type))))[0];

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '访客丙', 'guest');
});
afterAll(() => t.cleanup());

describe('转 PRD', () => {
  it('生成草稿：按对应表拼接；覆盖没挂 PRD 的需求，已挂别的 PRD 的跳过并列出；简报改为已转 PRD；两边互相可见；记事件', async () => {
    const r1 = await createRequirement(t.db, editor, pan, { title: '需求一' });
    const r2 = await createRequirement(t.db, editor, pan, { title: '需求二' });
    const r3 = await createRequirement(t.db, editor, pan, { title: '需求三' });
    await createDocument(t.db, editor, pan, { title: '旧 PRD', requirementIds: [r2.id] });
    const b = await createBrief(t.db, editor, pan, { title: '上传提速', requirementIds: [r1.id, r2.id, r3.id] });
    await saveDocumentContent(t.db, editor, b.id, { baseVersion: b.version, markdown: '## 1. 问题与目标\n\n上传失败率 3%。\n' });

    const res = await convertBriefToPrd(t.db, editor, b.id);
    expect(res.document).toMatchObject({
      displayKey: 'PAN-PRD-2',
      kind: 'change',
      status: 'draft',
      source: 'native',
      templateId: null,
      title: '上传提速',
      owner: { id: editor.memberId },
      sourceBrief: { id: b.id, displayKey: 'PAN-B-1', title: '上传提速' },
      templateGuidance: null,
    });
    expect(res.document.requirements.map((r) => r.displayKey)).toEqual(['PAN-1', 'PAN-3']);
    expect(res.document.markdown!.split('\n')[0]).toBe('> 由简报 [[PAN-B-1]] 生成。各章节下的引用块注明内容来自简报的哪一节，请按 PRD 的写法改写后再提交评审。');
    expect(res.document.markdown).toContain('> 来自简报第 1 节「问题与目标」\n\n上传失败率 3%。');
    expect(res.skipped).toEqual([{ id: r2.id, displayKey: 'PAN-2', title: '需求二', documentKey: 'PAN-PRD-1' }]);

    const brief = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    expect([brief.status, brief.transitions]).toEqual(['converted', ['discussing', 'discarded']]);
    expect(brief.brief!.convertedDocument).toMatchObject({ id: res.document.id, displayKey: 'PAN-PRD-2', status: 'draft' });
    expect((await listRevisions(t.db, editor, res.document.id)).map((r) => r.summary)).toEqual(['由简报 PAN-B-1 生成']);
    expect((await listBacklinks(t.db, editor, { type: 'document', id: b.id })).map((g) => g.displayKey)).toEqual(['PAN-PRD-2']);
    expect((await eventOf(b.id, 'document.status_changed'))!.payload).toMatchObject({ kind: 'brief', changes: [{ field: 'status', old: 'discussing', new: 'converted' }] });
    expect((await eventOf(b.id, 'brief.converted'))!.payload).toMatchObject({ documentId: res.document.id, documentKey: 'PAN-PRD-2', skipped: ['PAN-2'] });
    expect((await eventOf(res.document.id, 'document.created'))!.payload).toMatchObject({ fromBriefId: b.id });
  });

  it('再转：原 PRD 还在时返回 409 并给出编号；确认后生成新草稿，原 PRD 与它覆盖的需求保留', async () => {
    const b = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    await expect(convertBriefToPrd(t.db, editor, b.id)).rejects.toMatchObject({ code: 'conflict', message: '这份简报已转为 PAN-PRD-2', details: { documentKey: 'PAN-PRD-2' } });
    const res = await convertBriefToPrd(t.db, editor, b.id, { again: true });
    expect(res.document.displayKey).toBe('PAN-PRD-3');
    expect(res.document.requirements).toEqual([]);
    expect(res.skipped.map((s) => [s.displayKey, s.documentKey])).toEqual([
      ['PAN-1', 'PAN-PRD-2'],
      ['PAN-2', 'PAN-PRD-1'],
      ['PAN-3', 'PAN-PRD-2'],
    ]);
    const prev = await getDocumentByKey(t.db, editor, 'PAN-PRD-2');
    expect([prev.requirements.map((r) => r.displayKey), prev.sourceBrief]).toEqual([['PAN-1', 'PAN-3'], null]);
    expect((await getDocumentByKey(t.db, editor, 'PAN-B-1')).brief!.convertedDocument!.displayKey).toBe('PAN-PRD-3');
    expect((await getDocumentByKey(t.db, editor, 'PAN-PRD-3')).sourceBrief!.displayKey).toBe('PAN-B-1');
  });

  it('只读不能转；看不到时按不存在处理；已废弃的不能转；作者已离开时新 PRD 不设负责人', async () => {
    const b2 = await createBrief(t.db, editor, pan, { title: '要废弃的简报' });
    await expect(convertBriefToPrd(t.db, viewer, b2.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(convertBriefToPrd(t.db, readOnlyToken(owner), b2.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(convertBriefToPrd(t.db, guest, b2.id)).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
    await transitionDocument(t.db, editor, b2.id, { to: 'discarded' });
    await expect(convertBriefToPrd(t.db, editor, b2.id)).rejects.toThrow('已废弃的简报不能转 PRD');
    const leaver = await asMember(t.db, owner, '离开的作者');
    const b3 = await createBrief(t.db, leaver, pan, { title: '作者会离开' });
    await updateMember(t.db, owner, leaver.memberId, { status: 'left' });
    expect((await convertBriefToPrd(t.db, editor, b3.id)).document.owner).toBeNull();
  });

  it('拼出的 PRD 超过 30 万字时报错，不新建文档', async () => {
    const b4 = await createBrief(t.db, editor, pan, { title: '很长的简报' });
    await saveDocumentContent(t.db, editor, b4.id, { baseVersion: b4.version, markdown: `## 1. 问题与目标\n\n${'很'.repeat(110_000)}\n` });
    const before = (await listDocuments(t.db, editor, pan)).length;
    await expect(convertBriefToPrd(t.db, editor, b4.id)).rejects.toThrow('生成的 PRD 超过 300000 个字符，请先精简简报正文');
    expect(await listDocuments(t.db, editor, pan)).toHaveLength(before);
  });
});

describe('上下文', () => {
  it('头部、覆盖的需求与状态名、闸口、转出的 PRD 与正文；只读 Token 可读；看不到时按不存在处理', async () => {
    const b = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    await updateBrief(t.db, editor, b.id, { deciderMemberId: viewer.memberId, relatedLinks: [{ kind: 'wiki', target: 'PAN-PRD-1', note: '旧方案' }] });
    const ctx = await getBriefContext(t.db, readOnlyToken(owner), b.id);
    expect(ctx.brief).toMatchObject({
      displayKey: 'PAN-B-1',
      title: '上传提速',
      status: 'converted',
      statusLabel: '已转 PRD',
      product: { key: 'PAN', name: '网盘' },
      version: 'v0.1',
      decider: '只读乙',
      author: '编辑甲',
      requester: null,
      relatedLinks: [{ kind: 'wiki', target: 'PAN-PRD-1', note: '旧方案' }],
      convertedDocument: { displayKey: 'PAN-PRD-3', title: '上传提速', statusLabel: '草稿' },
    });
    expect(ctx.requirements).toEqual([
      { displayKey: 'PAN-1', title: '需求一', state: '待处理' },
      { displayKey: 'PAN-2', title: '需求二', state: '待处理' },
      { displayKey: 'PAN-3', title: '需求三', state: '待处理' },
    ]);
    expect(ctx.gate.total).toBe(11);
    expect(ctx.markdown).toContain('上传失败率 3%。');
    const md = briefContextMarkdown(ctx);
    expect(md.startsWith('# PAN-B-1 上传提速\n')).toBe(true);
    expect(md).toContain('| 转出的 PRD | PAN-PRD-3 上传提速（草稿） |');
    await expect(getBriefContext(t.db, guest, b.id)).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/brief-convert.test.ts`
Expected: FAIL（`convertBriefToPrd`、`getBriefContext` 不存在）。

- [ ] **Step 3: 扩充 `documents/briefs.ts`**

1. 导入调整：

```ts
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { documentBriefs, documentRevisions, documents, documentTemplates, functionTags, members, products, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertAssignableMember, memberNames, productWorkflowBody } from '../requirements/context';
import { assertTitle, type MemberRef, productKeyOf, displayKey as requirementDisplayKey } from '../requirements/requirements';
import { orgToday } from '../tasks/tasks';
import { type BriefRow, briefHeaderTx } from './brief-header';
import { type BriefContext, type BriefGate, briefToPrdMarkdown, evaluateBriefGate } from './brief-model';
import { BRIEF_GATE_ITEMS, BRIEF_TEMPLATE } from './brief-template';
import type { BriefRelatedLink, BriefStatus, DocumentStatus } from './constants';
import { linkBriefRequirementsTx, linkRequirementsTx } from './coverage';
import {
  type DocumentDetail,
  documentDetailInTx,
  documentMarkdownTx,
  type DocumentRow,
  insertNativeDocumentTx,
  MAX_MARKDOWN_CHARS,
  setDocumentStatusTx,
} from './documents';
import { briefDisplayKey, DOCUMENT_STATUS_LABELS, documentDisplayKey, fillTemplate, normalizeExternalUrl } from './markdown';
import { effectiveTemplates, loadUsableTemplate } from './templates';
```

2. 文件末尾加：

```ts
export type BriefConvertResult = {
  document: DocumentDetail;
  /** 已挂在其他 PRD 上、没有被新 PRD 覆盖的需求。 */
  skipped: Array<{ id: string; displayKey: string; title: string; documentKey: string }>;
};

/**
 * 转 PRD（设计 §3.6）：按第 18 节对应表生成变更 PRD 草稿（不套模板，负责人为在职的真人作者），覆盖简报覆盖的、还没挂 PRD 的需求，
 * 简报改为已转 PRD 并记录转出的 PRD。已转过且原 PRD 仍在时，不带 again 返回 409；带 again 生成新草稿，原 PRD 保留。
 * 锁顺序：简报 → 新 PRD → 需求（与关联需求一致）。
 */
export async function convertBriefToPrd(db: Db, actor: Actor, id: string, input: { again?: boolean } = {}): Promise<BriefConvertResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, header } = await loadBriefTx(tx, id, { lock: true });
    await briefRoleTx(tx, actor, doc, 'editor');
    if (doc.status === 'discarded') throw new AppError('invalid', '已废弃的简报不能转 PRD');
    const productKey = await productKeyOf(tx, doc.productId);
    const briefKey = briefDisplayKey(productKey, doc.number);
    if (header.convertedDocumentId && !input.again) {
      const [prev] = await tx
        .select({ number: documents.number })
        .from(documents)
        .where(and(eq(documents.id, header.convertedDocumentId), isNull(documents.deletedAt)));
      if (prev) {
        const documentKey = documentDisplayKey(productKey, prev.number);
        throw new AppError('conflict', `这份简报已转为 ${documentKey}`, { documentKey });
      }
    }
    const markdown = briefToPrdMarkdown({ briefKey, markdown: await documentMarkdownTx(tx, doc) });
    if (markdown.length > MAX_MARKDOWN_CHARS) throw new AppError('invalid', `生成的 PRD 超过 ${MAX_MARKDOWN_CHARS} 个字符，请先精简简报正文`);
    const [author] = header.authorMemberId
      ? await tx.select({ kind: members.kind, status: members.status }).from(members).where(eq(members.id, header.authorMemberId))
      : [];
    const ownerMemberId = author?.kind === 'human' && author.status === 'active' ? header.authorMemberId : null;
    const prd = await insertNativeDocumentTx(tx, actor, {
      productId: doc.productId,
      kind: 'change',
      title: doc.title,
      status: 'draft',
      ownerMemberId,
      templateId: null,
      markdown,
      summary: `由简报 ${briefKey} 生成`,
    });
    const prdKey = documentDisplayKey(productKey, prd.number);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.created',
      subjectType: 'document',
      subjectId: prd.id,
      actor,
      payload: { number: prd.number, title: prd.title, source: 'native', externalUrl: null, templateId: null, ownerMemberId, fromBriefId: doc.id },
    });
    const covered = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.briefDocumentId, doc.id), isNull(requirements.deletedAt)))
      .orderBy(asc(requirements.number));
    const taken = covered.filter((r) => r.changeDocumentId);
    const takenDocs = taken.length > 0 ? await tx.select({ id: documents.id, number: documents.number }).from(documents).where(inArray(documents.id, taken.map((r) => r.changeDocumentId!))) : [];
    const numberOf = new Map(takenDocs.map((d) => [d.id, d.number]));
    const skipped = taken.map((r) => ({
      id: r.id,
      displayKey: requirementDisplayKey(productKey, r.number),
      title: r.title,
      documentKey: documentDisplayKey(productKey, numberOf.get(r.changeDocumentId!) ?? 0),
    }));
    const free = covered.filter((r) => !r.changeDocumentId).map((r) => r.id);
    if (free.length > 0) await linkRequirementsTx(tx, actor, prd.id, free);
    const now = new Date();
    await tx.update(documentBriefs).set({ convertedDocumentId: prd.id, updatedAt: now }).where(eq(documentBriefs.documentId, doc.id));
    if (doc.status !== 'converted') await setDocumentStatusTx(tx, actor, doc, 'converted');
    else await tx.update(documents).set({ updatedAt: now }).where(eq(documents.id, doc.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'brief.converted',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: {
        documentId: prd.id,
        documentKey: prdKey,
        skipped: skipped.map((s) => s.displayKey),
        changes: [{ field: 'convertedDocumentId', old: header.convertedDocumentId, new: prd.id }],
      },
    });
    return { document: await documentDetailInTx(tx, actor, prd.id), skipped };
  });
}

/** Agent 上下文（设计 §3.7）：查看权限即可，只读 Token 可读。 */
export async function getBriefContext(db: Db, actor: Actor, id: string): Promise<BriefContext> {
  return withOrg(db, actor.orgId, async (tx) => {
    const b = await loadBriefTx(tx, id);
    await briefRoleTx(tx, actor, b.doc, 'viewer');
    const [product] = await tx.select({ key: products.key, name: products.name }).from(products).where(eq(products.id, b.doc.productId));
    const h = await briefHeaderTx(tx, b.header);
    const gate = (await briefGatesTx(tx, [b])).get(id)!;
    const reqs = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.briefDocumentId, id), isNull(requirements.deletedAt)))
      .orderBy(asc(requirements.number));
    // 有需求的产品一定有流程；没有需求时不读流程（产品可能还没指定流程）
    const states = reqs.length > 0 ? (await productWorkflowBody(tx, b.doc.productId)).states : [];
    return {
      brief: {
        id,
        displayKey: briefDisplayKey(product!.key, b.doc.number),
        title: b.doc.title,
        status: b.doc.status as BriefStatus,
        statusLabel: DOCUMENT_STATUS_LABELS[b.doc.status],
        product: product!,
        version: h.version,
        requester: h.requester?.displayName ?? null,
        decider: h.decider?.displayName ?? null,
        author: h.author?.displayName ?? null,
        participants: h.participantTags.map((x) => x.name),
        relatedLinks: h.relatedLinks,
        convertedDocument: h.convertedDocument
          ? { displayKey: h.convertedDocument.displayKey, title: h.convertedDocument.title, statusLabel: DOCUMENT_STATUS_LABELS[h.convertedDocument.status] }
          : null,
        updatedAt: b.doc.updatedAt.toISOString(),
      },
      requirements: reqs.map((r) => ({
        displayKey: requirementDisplayKey(product!.key, r.number),
        title: r.title,
        state: states.find((s) => s.key === r.stateKey)?.label ?? r.stateKey,
      })),
      gate,
      markdown: await documentMarkdownTx(tx, b.doc),
    };
  });
}
```

新导出名 `BriefConvertResult`、`convertBriefToPrd`、`getBriefContext` 不与已有导出重名。

- [ ] **Step 4: 运行测试确认通过，类型检查并提交**

Run: `pnpm --filter @flower/core exec vitest run test/brief-convert.test.ts test/briefs-services.test.ts test/briefs-documents.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

```bash
git add packages/core/src/documents/briefs.ts packages/core/test/brief-convert.test.ts
git commit -m "feat(core): 简报一键转变更 PRD 草稿与只读上下文

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: 站内通知（决策人「被指派」、简报文案）与需求详情里的简报

**Files:**
- Modify: `packages/core/src/member-notifications/content.ts`、`packages/core/src/requirements/detail.ts`
- Test: `packages/core/test/brief-notify.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `documentKeyOf`；Task 6 的 `briefGatesTx`、`updateBrief`
- Produces:
  - `NotificationSubject` 多一个可选字段 `documentKind?: DocumentKind`；文档通知标题用 `documentKeyOf` 的编号
  - `HANDLED_EVENT_TYPES` 加 `brief.updated`：决策人变为某人时给他「把你设为简报决策人」（`assigned`）并自动关注
  - 简报的「在简报正文中 @ 了你」「把简报状态从「…」改为「…」」
  - `RequirementDetail.brief: { id: string; displayKey: string; title: string; status: DocumentStatus; gate: { passed: number; total: number } } | null`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/brief-notify.test.ts`：

```ts
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberNotifications } from '../src/db/schema';
import { createBrief, updateBrief } from '../src/documents/briefs';
import { unlinkDocumentRequirement } from '../src/documents/coverage';
import { getDocumentByKey, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { mentionMarkup } from '../src/links/syntax';
import { generateMemberNotifications } from '../src/member-notifications/generate';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { updateMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let decider: Actor;
let member: Actor;
let outsider: Actor;
let pan: string;

const generate = () => generateMemberNotifications(t.db, owner.orgId, { publicUrl: 'http://flower.example.com' }, new Date());
const inbox = (memberId: string) =>
  t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.memberId, memberId)).orderBy(asc(memberNotifications.createdAt), asc(memberNotifications.id));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  decider = await asMember(t.db, owner, '决策人乙');
  member = await asMember(t.db, owner, '成员丙');
  outsider = await asMember(t.db, owner, '访客丁');
  await updateMember(t.db, owner, outsider.memberId, { orgRole: 'guest' });
});
afterAll(() => t.cleanup());

describe('简报的站内通知', () => {
  it('被设为决策人时收到「被指派」；自己设自己不通知；看不到该产品的访客不通知', async () => {
    const brief = await createBrief(t.db, editor, pan, { title: '上传提速' });
    await updateBrief(t.db, editor, brief.id, { deciderMemberId: editor.memberId });
    await updateBrief(t.db, editor, brief.id, { deciderMemberId: decider.memberId });
    await updateBrief(t.db, editor, brief.id, { deciderMemberId: outsider.memberId });
    await generate();
    expect((await inbox(decider.memberId)).map((n) => [n.kind, n.title, n.body, n.url])).toEqual([['assigned', 'PAN-B-1 上传提速', '把你设为简报决策人', '/acme/documents/PAN-B-1']]);
    expect((await inbox(editor.memberId)).filter((n) => n.body === '把你设为简报决策人')).toEqual([]);
    expect(await inbox(outsider.memberId)).toEqual([]);
  });

  it('正文 @ 与状态变化的文案写「简报」；决策人已自动关注', async () => {
    const brief = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    await saveDocumentContent(t.db, editor, brief.id, { baseVersion: brief.version, markdown: `请 ${mentionMarkup(member.memberId, '成员丙')} 补充数据\n` });
    await transitionDocument(t.db, editor, brief.id, { to: 'ready' });
    await generate();
    expect((await inbox(member.memberId)).map((n) => n.body)).toContain('在简报正文中 @ 了你');
    expect((await inbox(decider.memberId)).map((n) => n.body)).toContain('把简报状态从「讨论中」改为「可写 PRD」');
  });
});

describe('需求详情里的简报', () => {
  it('显示所挂简报的编号、标题、状态与闸口进度；没挂或移出后为空', async () => {
    const r = await createRequirement(t.db, editor, pan, { title: '挂简报的需求' });
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).brief).toBeNull();
    const brief = await createBrief(t.db, editor, pan, { title: '第二份简报', requirementIds: [r.id] });
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).brief).toEqual({
      id: brief.id,
      displayKey: 'PAN-B-2',
      title: '第二份简报',
      status: 'discussing',
      gate: { passed: 2, total: 11 },
    });
    await unlinkDocumentRequirement(t.db, editor, brief.id, r.id);
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).brief).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/brief-notify.test.ts`
Expected: FAIL（决策人没有收到通知；`brief` 字段不存在）。

- [ ] **Step 3: 修改 `member-notifications/content.ts`**

1. 第 19、20 行改为：

```ts
import type { DocumentKind, DocumentStatus } from '../documents/constants';
import { DOCUMENT_STATUS_LABELS, documentKeyOf } from '../documents/markdown';
```

2. `NotificationSubject` 改为：

```ts
/** productId 为空：不关联产品的工作项（收件人排除访客）。documentKind：文档对象的类型（简报的文案写「简报」）。 */
export type NotificationSubject = { type: NotificationSubjectType; id: string; productId: string | null; title: string; url: string; documentKind?: DocumentKind };
```

3. `HANDLED_EVENT_TYPES` 在 `'document.status_changed',` 之后加 `'brief.updated',`。

4. `subjectTx` 的文档分支替换为：

```ts
  if (type === 'document') {
    const [d] = await tx
      .select({ productId: documents.productId, number: documents.number, title: documents.title, kind: documents.kind, key: products.key })
      .from(documents)
      .innerJoin(products, eq(products.id, documents.productId))
      .where(and(eq(documents.id, id), isNull(documents.deletedAt), isNull(products.deletedAt)));
    if (!d) return null;
    const k = documentKeyOf(d.kind, d.key, d.number);
    return { type: 'document', id, productId: d.productId, title: clip(`${k} ${d.title}`, TITLE_MAX), url: `/${slug}/documents/${k}`, documentKind: d.kind };
  }
```

5. `planEventTx` 里 `const notifyFollowers = …` 之后加：

```ts
  const isBrief = subject.documentKind === 'brief';
```

`switch` 里三处替换 / 新增：

```ts
    case 'document.saved':
      mention(idList(p.mentionedMemberIds), isBrief ? '在简报正文中 @ 了你' : '在 PRD 正文中 @ 了你');
      break;
    case 'document.status_changed': {
      const ch = changeOf(p, 'status');
      const name = (s: unknown) => DOCUMENT_STATUS_LABELS[s as DocumentStatus] ?? shown(s);
      await notifyFollowers(`${isBrief ? '把简报状态' : '把 PRD 状态'}从「${name(ch?.old)}」改为「${name(ch?.new)}」`);
      if (ch?.new === 'review') candidates.push(...(await signersTx(tx, subject)));
      break;
    }
    case 'brief.updated':
      assign(asId(changeOf(p, 'deciderMemberId')?.new), '把你设为简报决策人');
      break;
```

- [ ] **Step 4: 修改 `requirements/detail.ts`**

1. 表导入加 `documentBriefs`；第 23 行改为 `import { briefDisplayKey, documentDisplayKey, prdCheckState } from '../documents/markdown';`；加 `import { briefGatesTx } from '../documents/briefs';`。

2. `RequirementDetail` 在 `documentCheckItems: CheckItemView[];` 之后加：

```ts
  /** 所挂的需求简报（P3-C2）与闸口进度。 */
  brief: { id: string; displayKey: string; title: string; status: DocumentStatus; gate: { passed: number; total: number } } | null;
```

3. 在 `const [docRow] = row.changeDocumentId ? …` 之后加：

```ts
    const [briefRow] = row.briefDocumentId
      ? await tx
          .select({ doc: documents, header: documentBriefs })
          .from(documents)
          .innerJoin(documentBriefs, eq(documentBriefs.documentId, documents.id))
          .where(and(eq(documents.id, row.briefDocumentId), isNull(documents.deletedAt)))
      : [];
    const briefGate = briefRow ? (await briefGatesTx(tx, [briefRow])).get(briefRow.doc.id)! : null;
```

4. 返回对象在 `documentCheckItems,` 之后加：

```ts
      brief:
        briefRow && briefGate
          ? {
              id: briefRow.doc.id,
              displayKey: briefDisplayKey(product!.key, briefRow.doc.number),
              title: briefRow.doc.title,
              status: briefRow.doc.status,
              gate: { passed: briefGate.passed, total: briefGate.total },
            }
          : null,
```

- [ ] **Step 5: 运行测试确认通过，类型检查并提交**

Run: `pnpm --filter @flower/core exec vitest run test/brief-notify.test.ts test/member-notify-generate.test.ts test/requirements.test.ts test/tracking-notify.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误（web 侧 `RequirementDetail` 多一个字段，不影响现有页面）。

```bash
git add packages/core/src/member-notifications/content.ts packages/core/src/requirements/detail.ts packages/core/test/brief-notify.test.ts
git commit -m "feat(core): 简报决策人收到「被指派」，简报的通知文案；需求详情带所挂简报与闸口进度

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: 接口与权限测试

**Files:**
- Create: `apps/web/src/server/routes/briefs.ts`
- Modify: `apps/web/src/server/routes/templates.ts`、`apps/web/src/server/api.ts`
- Test: `apps/web/test/api/briefs.test.ts`

**Interfaces:**
- Consumes: Task 4–7 的服务函数；已有的 `readJson`、`csvParam`（`http.ts`）、`idParam`（`routes/notifications.ts`）
- Produces（均在 `/api/v1` 下）:
  - `GET /orgs/:org/briefs?product&status&decider` → `{ briefs: BriefListItem[] }`；格式错误 400「筛选参数无效」
  - `POST /orgs/:org/products/:id/briefs`（`{ title, templateId?, requirementIds? }`）→ 201 `{ document: DocumentDetail }`
  - `PATCH /orgs/:org/briefs/:id`（`BriefHeaderInput`）→ `{ document }`
  - `GET /orgs/:org/briefs/:id/gate` → `{ gate }`；`PUT /orgs/:org/briefs/:id/gate/:item`（`{ checked }`）→ `{ gate }`
  - `POST /orgs/:org/briefs/:id/convert`（`{ again?: boolean }`）→ 201 `{ document, skipped }`；409 时 `error.details.documentKey`
  - `GET /orgs/:org/briefs/:id/context?format=markdown|json`（缺省 markdown）→ `text/markdown; charset=utf-8` 正文，或 `{ context: BriefContext }`；其他格式 400「格式只能是 markdown 或 json」
  - `GET /orgs/:org/templates?kind=change|brief`、`POST /orgs/:org/templates`（多 `kind`、`guidance`）、`PATCH /orgs/:org/templates/:id`（多 `guidance`）、`POST /orgs/:org/templates/preset?kind=brief`；`kind` 不认识时 400「模板类型无效」
  - 路径里的简报 id 不是 UUID 时 400「简报无效」，产品 id 不是 UUID 时 400「产品无效」

- [ ] **Step 1: 写失败的测试**

新建 `apps/web/test/api/briefs.test.ts`：

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

/** 不按 JSON 解析的请求（Markdown 上下文）。 */
const raw = (path: string, as: As) =>
  app.request(`/api/v1${path}`, {
    headers: { ...(as.token ? { authorization: `Bearer ${as.token}` } : {}), ...(as.session ? { cookie: `flower_session=${as.session}` } : {}) },
  });
const create = (as: As, productId: string, body: Record<string, unknown>) => call(app, 'POST', `/orgs/acme/products/${productId}/briefs`, { ...as, body });
const keys = async (as: As, q = ''): Promise<string[]> => {
  const r = await call(app, 'GET', `/orgs/acme/briefs${q}`, as);
  expect(r.status, q).toBe(200);
  return r.body.briefs.map((b: { displayKey: string }) => b.displayKey);
};

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  pan = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  doc = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '文档', key: 'DOC' } })).body.product.id;
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
  const token = async (scope: unknown) => (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: ownerId, name: '简报', scope } })).body.token as string;
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

describe('新建与列表', () => {
  it('编辑新建 201 并返回简报详情；只读成员与只读 Token 403；访客对没有角色的产品 404；产品 id 格式错误 400', async () => {
    const req = (await call(app, 'POST', `/orgs/acme/products/${pan}/requirements`, { session, body: { title: '网盘需求' } })).body.requirement;
    const r = await create(who.editor!, pan, { title: '上传提速', requirementIds: [req.id] });
    expect(r.status).toBe(201);
    expect(r.body.document).toMatchObject({ displayKey: 'PAN-B-1', kind: 'brief', status: 'discussing', requirements: [{ displayKey: 'PAN-1' }], brief: { version: 'v0.1' } });
    ids.brief = r.body.document.id;
    for (const k of ['viewer', 'readToken']) expect((await create(who[k]!, pan, { title: '不行' })).status, k).toBe(403);
    expect((await create(who.guest!, doc, { title: '不行' })).status).toBe(404);
    expect((await create(who.editor!, 'not-a-uuid', { title: '不行' })).status).toBe(400);
    ids.docBrief = (await create(who.owner!, doc, { title: '文档产品的简报' })).body.document.id;
    expect((await call(app, 'GET', '/orgs/acme/documents/PAN-B-1', who.viewer!)).body.document.kind).toBe('brief');
  });

  it('列表：只看到有角色的产品；按产品、状态、决策人筛选；格式错误 400；合法 UUID 但看不到或不存在时返回空', async () => {
    expect(await keys(who.owner!)).toEqual(['DOC-B-1', 'PAN-B-1']);
    for (const k of ['guest', 'panToken']) expect(await keys(who[k]!), k).toEqual(['PAN-B-1']);
    expect(await keys(who.owner!, `?product=${pan}`)).toEqual(['PAN-B-1']);
    expect(await keys(who.owner!, '?status=ready,discarded')).toEqual([]);
    expect(await keys(who.guest!, `?product=${doc}`)).toEqual([]);
    expect(await keys(who.owner!, `?decider=${RANDOM}`)).toEqual([]);
    for (const q of ['?product=abc', '?status=draft', '?decider=1']) {
      const r = await call(app, 'GET', `/orgs/acme/briefs${q}`, who.owner!);
      expect([r.status, r.body.error.message], q).toEqual([400, '筛选参数无效']);
    }
    expect((await call(app, 'GET', '/orgs/acme/briefs', who.guest!)).body.briefs[0]).toMatchObject({ requirementCount: 1, gate: { passed: 2, total: 11 }, decider: null });
  });
});

describe('头部、闸口、状态与覆盖需求', () => {
  it('头部：编辑可改；只读成员与只读 Token 403；决策人不能是 Agent；id 格式错误 400；限定产品的 Token 改不了其他产品的简报', async () => {
    const path = `/orgs/acme/briefs/${ids.brief}`;
    const r = await call(app, 'PATCH', path, {
      ...who.editor,
      body: { version: 'v0.2', deciderMemberId: ids.viewer, relatedLinks: [{ kind: 'url', url: 'https://doc.example.com/a', note: '群聊' }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.document.brief).toMatchObject({
      version: 'v0.2',
      decider: { id: ids.viewer, displayName: '只读成员' },
      relatedLinks: [{ kind: 'url', url: 'https://doc.example.com/a', note: '群聊' }],
    });
    for (const k of ['viewer', 'readToken']) expect((await call(app, 'PATCH', path, { ...who[k], body: { version: 'v9' } })).status, k).toBe(403);
    const agent = await call(app, 'PATCH', path, { ...who.editor, body: { deciderMemberId: agentId } });
    expect([agent.status, agent.body.error.message]).toEqual([400, '不能选择 Agent 成员']);
    expect((await call(app, 'PATCH', '/orgs/acme/briefs/not-a-uuid', { ...who.editor, body: { version: 'v1' } })).status).toBe(400);
    expect((await call(app, 'PATCH', `/orgs/acme/briefs/${ids.docBrief}`, { ...who.panToken, body: { version: 'v1' } })).status).toBe(404);
  });

  it('闸口：只读成员、访客与只读 Token 可读；编辑勾选人工项；自动项、非数字的项号与只读 Token 勾选被拒', async () => {
    const path = `/orgs/acme/briefs/${ids.brief}/gate`;
    for (const k of ['viewer', 'readToken', 'guest']) expect((await call(app, 'GET', path, who[k]!)).body.gate.total, k).toBe(11);
    const checked = await call(app, 'PUT', `${path}/2`, { ...who.editor, body: { checked: true } });
    expect([checked.status, checked.body.gate.passed]).toEqual([200, 3]);
    expect((await call(app, 'PUT', `${path}/1`, { ...who.editor, body: { checked: true } })).status).toBe(400);
    expect((await call(app, 'PUT', `${path}/x`, { ...who.editor, body: { checked: true } })).status).toBe(400);
    expect((await call(app, 'PUT', `${path}/3`, { ...who.readToken, body: { checked: true } })).status).toBe(403);
  });

  it('状态与覆盖需求沿用文档接口：可改为可写 PRD、不能改为 PRD 的状态；关联别的产品的需求 400', async () => {
    const t1 = await call(app, 'POST', `/orgs/acme/documents/${ids.brief}/transitions`, { ...who.editor, body: { to: 'ready' } });
    expect([t1.status, t1.body.document.status]).toEqual([200, 'ready']);
    expect((await call(app, 'POST', `/orgs/acme/documents/${ids.brief}/transitions`, { ...who.editor, body: { to: 'draft' } })).status).toBe(400);
    const docReq = (await call(app, 'POST', `/orgs/acme/products/${doc}/requirements`, { session, body: { title: '文档需求' } })).body.requirement;
    const bad = await call(app, 'POST', `/orgs/acme/documents/${ids.brief}/requirements`, { ...who.editor, body: { requirementIds: [docReq.id] } });
    expect([bad.status, bad.body.error.message]).toEqual([400, 'DOC-1 不属于这份简报所在的产品']);
  });
});

describe('上下文', () => {
  it('Markdown（缺省）与 JSON；只读 Token 可读；看不到的简报 404；格式与 id 错误 400', async () => {
    const path = `/orgs/acme/briefs/${ids.brief}/context`;
    const res = await raw(path, who.readToken!);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const text = await res.text();
    expect(text.startsWith('# PAN-B-1 上传提速\n')).toBe(true);
    expect(text).toContain('| 决策人 | 只读成员 |');
    expect(text).toContain('## 写 PRD 闸口（3/11）');
    expect(text).toContain('| PAN-1 | 网盘需求 |');
    const json = await call(app, 'GET', `${path}?format=json`, who.viewer!);
    expect(json.body.context.brief).toMatchObject({ displayKey: 'PAN-B-1', statusLabel: '可写 PRD', version: 'v0.2' });
    expect(json.body.context.requirements).toHaveLength(1);
    for (const k of ['panToken', 'guest']) expect((await call(app, 'GET', `/orgs/acme/briefs/${ids.docBrief}/context?format=json`, who[k]!)).status, k).toBe(404);
    const html = await call(app, 'GET', `${path}?format=html`, who.viewer!);
    expect([html.status, html.body.error.message]).toEqual([400, '格式只能是 markdown 或 json']);
    expect((await call(app, 'GET', '/orgs/acme/briefs/not-a-uuid/context?format=json', who.viewer!)).status).toBe(400);
  });
});

describe('转 PRD', () => {
  it('编辑 201 返回 PRD 与跳过的需求；已转过再转 409 并给出已有 PRD；确认后再生成；只读 Token 403', async () => {
    const path = `/orgs/acme/briefs/${ids.brief}/convert`;
    expect((await call(app, 'POST', path, { ...who.readToken, body: {} })).status).toBe(403);
    const first = await call(app, 'POST', path, { ...who.editor, body: {} });
    expect(first.status).toBe(201);
    expect(first.body.document).toMatchObject({ displayKey: 'PAN-PRD-1', kind: 'change', sourceBrief: { displayKey: 'PAN-B-1' }, requirements: [{ displayKey: 'PAN-1' }] });
    expect(first.body.skipped).toEqual([]);
    const again = await call(app, 'POST', path, { ...who.editor, body: {} });
    expect([again.status, again.body.error.message, again.body.error.details]).toEqual([409, '这份简报已转为 PAN-PRD-1', { documentKey: 'PAN-PRD-1' }]);
    const second = await call(app, 'POST', path, { ...who.editor, body: { again: true } });
    expect([second.status, second.body.document.displayKey]).toEqual([201, 'PAN-PRD-2']);
    expect(second.body.skipped).toEqual([expect.objectContaining({ displayKey: 'PAN-1', documentKey: 'PAN-PRD-1' })]);
    expect((await call(app, 'GET', '/orgs/acme/documents/PAN-B-1', who.viewer!)).body.document.brief.convertedDocument.displayKey).toBe('PAN-PRD-2');
  });
});

describe('模板按类型', () => {
  it('按类型列出；组织管理员新建简报模板，产品管理员覆盖，编辑 403；类型参数错误 400', async () => {
    const list = await call(app, 'GET', '/orgs/acme/templates?kind=brief', who.owner!);
    expect(list.body.templates.map((x: { name: string; kind: string }) => [x.kind, x.name])).toEqual([['brief', '需求简报（预置）']]);
    expect((await call(app, 'GET', '/orgs/acme/templates', who.owner!)).body.templates.map((x: { kind: string }) => x.kind)).toEqual(['change']);
    const created = await call(app, 'POST', '/orgs/acme/templates', { ...who.owner, body: { kind: 'brief', name: '轻量简报', body: '## 1. 问题与目标\n', sections: [], guidance: '先写结论' } });
    expect([created.status, created.body.template.kind, created.body.template.guidance]).toEqual([201, 'brief', '先写结论']);
    const override = await call(app, 'POST', '/orgs/acme/templates', { ...who.productAdmin, body: { productId: pan, kind: 'brief', name: '轻量简报', body: '## 产品版\n', sections: [] } });
    expect(override.status).toBe(201);
    expect((await call(app, 'POST', '/orgs/acme/templates', { ...who.editor, body: { productId: pan, kind: 'brief', name: '编辑的', body: '', sections: [] } })).status).toBe(403);
    expect((await call(app, 'GET', `/orgs/acme/templates?product=${pan}&usable=1&kind=brief`, who.editor!)).body.templates.map((x: { productId: string | null }) => x.productId)).toEqual([null, pan]);
    expect((await call(app, 'POST', '/orgs/acme/templates/preset?kind=brief', { ...who.owner, body: {} })).status).toBe(409);
    expect((await call(app, 'GET', '/orgs/acme/templates?kind=module', who.owner!)).status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run test/api/briefs.test.ts`
Expected: FAIL（`/orgs/acme/products/:id/briefs` 返回 404）。

- [ ] **Step 3: 新建 `apps/web/src/server/routes/briefs.ts`**

```ts
import {
  AppError,
  BRIEF_STATUSES,
  briefContextMarkdown,
  convertBriefToPrd,
  createBrief,
  getBriefContext,
  getBriefGate,
  listBriefs,
  setBriefGateCheck,
  updateBrief,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { csvParam as csv, readJson } from '../http';
import { idParam } from './notifications';

const uuid = z.string().uuid();
const listQuery = z.object({ product: uuid.optional(), status: z.array(z.enum(BRIEF_STATUSES)).optional(), decider: uuid.optional() });
const relatedLink = z.union([
  z.object({ kind: z.literal('wiki'), target: z.string().max(200), note: z.string().max(200) }),
  z.object({ kind: z.literal('url'), url: z.string().max(2000), note: z.string().max(200) }),
]);
const headerBody = z.object({
  version: z.string().max(100).optional(),
  requesterMemberId: uuid.nullable().optional(),
  deciderMemberId: uuid.nullable().optional(),
  authorMemberId: uuid.nullable().optional(),
  participantTagIds: z.array(uuid).max(50).optional(),
  relatedLinks: z.array(relatedLink).max(50).optional(),
});
const briefId = (c: Context) => idParam(c, 'id', '简报无效');

export function registerBriefRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/briefs', async (c) => {
    const q = listQuery.safeParse({ product: c.req.query('product') || undefined, status: csv(c.req.query('status')), decider: c.req.query('decider') || undefined });
    if (!q.success) throw new AppError('invalid', '筛选参数无效');
    return c.json({ briefs: await listBriefs(deps.db, c.get('actor'), { productId: q.data.product, statuses: q.data.status, deciderId: q.data.decider }) });
  });

  app.post('/orgs/:org/products/:id/briefs', async (c) => {
    const productId = idParam(c, 'id', '产品无效');
    const body = await readJson(c, z.object({ title: z.string(), templateId: uuid.nullable().optional(), requirementIds: z.array(uuid).max(200).optional() }));
    return c.json({ document: await createBrief(deps.db, c.get('actor'), productId, body) }, 201);
  });

  app.patch('/orgs/:org/briefs/:id', async (c) => {
    const id = briefId(c);
    const body = await readJson(c, headerBody);
    return c.json({ document: await updateBrief(deps.db, c.get('actor'), id, body) });
  });

  app.get('/orgs/:org/briefs/:id/gate', async (c) => c.json({ gate: await getBriefGate(deps.db, c.get('actor'), briefId(c)) }));

  app.put('/orgs/:org/briefs/:id/gate/:item', async (c) => {
    const id = briefId(c);
    const item = Number(c.req.param('item'));
    if (!Number.isInteger(item)) throw new AppError('invalid', '闸口项不存在');
    const body = await readJson(c, z.object({ checked: z.boolean() }));
    return c.json({ gate: await setBriefGateCheck(deps.db, c.get('actor'), id, item, body) });
  });

  app.post('/orgs/:org/briefs/:id/convert', async (c) => {
    const id = briefId(c);
    const body = await readJson(c, z.object({ again: z.boolean().optional() }));
    return c.json(await convertBriefToPrd(deps.db, c.get('actor'), id, body), 201);
  });

  app.get('/orgs/:org/briefs/:id/context', async (c) => {
    const id = briefId(c);
    const format = c.req.query('format') ?? 'markdown';
    if (format !== 'markdown' && format !== 'json') throw new AppError('invalid', '格式只能是 markdown 或 json');
    const context = await getBriefContext(deps.db, c.get('actor'), id);
    if (format === 'json') return c.json({ context });
    return c.body(briefContextMarkdown(context), 200, { 'content-type': 'text/markdown; charset=utf-8' });
  });
}
```

- [ ] **Step 4: 模板接口接上类型与说明**

`apps/web/src/server/routes/templates.ts` 整个文件替换为：

```ts
import { AppError, createPresetTemplate, createTemplate, listTemplates, TEMPLATE_KINDS, updateTemplate } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const sections = z
  .array(z.object({ heading: z.string().max(100), required: z.boolean(), guidance: z.string().max(500).optional() }))
  .max(50);
const kindSchema = z.enum(TEMPLATE_KINDS);

/** 地址栏里的模板类型，缺省为变更 PRD。 */
function kindOf(v: string | undefined) {
  const r = kindSchema.safeParse(v || 'change');
  if (!r.success) throw new AppError('invalid', '模板类型无效');
  return r.data;
}

export function registerTemplateRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/templates', async (c) =>
    c.json({
      templates: await listTemplates(deps.db, c.get('actor'), {
        productId: c.req.query('product') || null,
        usable: c.req.query('usable') === '1',
        kind: kindOf(c.req.query('kind')),
      }),
    }),
  );

  app.post('/orgs/:org/templates', async (c) => {
    const body = await readJson(
      c,
      z.object({ productId: z.string().nullable().optional(), kind: kindSchema.optional(), name: z.string(), body: z.string(), sections, guidance: z.string().max(5000).optional() }),
    );
    return c.json({ template: await createTemplate(deps.db, c.get('actor'), body) }, 201);
  });

  app.post('/orgs/:org/templates/preset', async (c) => c.json({ template: await createPresetTemplate(deps.db, c.get('actor'), kindOf(c.req.query('kind'))) }, 201));

  app.patch('/orgs/:org/templates/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({ name: z.string().optional(), body: z.string().optional(), sections: sections.optional(), guidance: z.string().max(5000).optional(), active: z.boolean().optional() }),
    );
    return c.json({ template: await updateTemplate(deps.db, c.get('actor'), c.req.param('id'), body) });
  });
}
```

（`guidance` 在接口层放宽到 5000，超过 2000 时由服务返回中文「模板说明不超过 2000 个字符」。）

- [ ] **Step 5: 注册路由**

`apps/web/src/server/api.ts`：导入 `import { registerBriefRoutes } from './routes/briefs';`，在 `registerDocumentRoutes(app, deps);` 之后加 `registerBriefRoutes(app, deps);`。

- [ ] **Step 6: 运行测试确认通过，类型检查、lint 并提交**

Run: `pnpm --filter @flower/web exec vitest run test/api/briefs.test.ts test/api/documents.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS；typecheck、lint 无错误与警告。

```bash
git add apps/web/src/server/routes/briefs.ts apps/web/src/server/routes/templates.ts apps/web/src/server/api.ts apps/web/test/api/briefs.test.ts
git commit -m "feat(web): 简报接口（列表、新建、头部、闸口、转 PRD、上下文）与按类型的模板接口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: 前端数据层、简报纯逻辑与模板设置（PRD / 简报切换、模板说明）

**Files:**
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`、`apps/web/src/lib/api.ts`、`apps/web/src/features/documents/model.ts`、`apps/web/src/components/template-editor.tsx`、`apps/web/src/app/(app)/[org]/settings/templates/page.tsx`
- Test: `apps/web/src/features/documents/model.test.ts`

**Interfaces:**
- Consumes: Task 9 的接口；core 的类型 `BriefListItem`、`BriefGate`、`BriefRelatedLink`、`BriefStatus`、`BriefConvertResult`、`TemplateKind`（只 `import type`）；浏览器安全的 `@flower/core/markdown`（`BRIEF_STATUSES`）与 `@flower/core/links`（`classifyTarget`）
- Produces:
  - `lib/types.ts`：`BriefStatus`、`BriefListItem`、`BriefGate`、`BriefRelatedLink`、`BriefConvertResult`、`TemplateKind`
  - `lib/queries.ts`：`qk.briefs(o, query)`、`qk.briefGate(o, id)`、`briefKeys(o)`、`useBriefs(o, query, enabled?)`、`useBriefGate(o, id)`；`useTemplates(o, { productId?, usable?, kind? })`
  - `lib/api.ts`：`apiText(path): Promise<string>`（出错时与 `api` 一样抛 `ApiError`）
  - `features/documents/model.ts`：`DocumentView` 加 `'briefs'`；`briefsHref(org, productKey)`；`BriefListFilter = { product: string; status: BriefStatus | ''; decider: string }`、`parseBriefFilter`、`briefFilterToSearch`、`briefFilterToApiQuery(f, productId)`；`gateLabel(g)`；`briefFileName(displayKey)`；`convertMessage(r)`；`parseRelatedInput(text, note): BriefRelatedLink | null`；`relatedLinkHref(org, target): string | null`
  - `TemplateEditor` 内部用「模板类型」下拉在 PRD 模板与简报模板之间切换；模板对话框多「模板说明」

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/documents/model.test.ts`：顶部从 `./model` 的导入列表按字母顺序加入 `briefFileName`、`briefFilterToApiQuery`、`briefFilterToSearch`、`briefsHref`、`convertMessage`、`DOCUMENT_STATUS_COLOR`、`gateLabel`、`parseBriefFilter`、`parseRelatedInput`、`relatedLinkHref`，文件末尾加：

```ts
describe('简报列表与链接', () => {
  it('页签由地址栏决定；地址栏 ↔ 筛选；无效状态被忽略；接口查询带产品 id', () => {
    expect(documentView(new URLSearchParams('view=briefs'))).toBe('briefs');
    expect(documentView(new URLSearchParams('view=bogus'))).toBe('change');
    expect(briefsHref('acme', 'PAN')).toBe('/acme/documents?product=PAN&view=briefs');
    const f = parseBriefFilter(new URLSearchParams('product=PAN&view=briefs&status=ready&decider=m1'));
    expect(f).toEqual({ product: 'PAN', status: 'ready', decider: 'm1' });
    expect(parseBriefFilter(new URLSearchParams('status=draft')).status).toBe('');
    expect(briefFilterToSearch(f)).toBe('product=PAN&view=briefs&status=ready&decider=m1');
    expect(briefFilterToSearch({ product: 'PAN', status: '', decider: '' })).toBe('product=PAN&view=briefs');
    expect(briefFilterToApiQuery(f, 'p1')).toBe('product=p1&status=ready&decider=m1');
    expect(briefFilterToApiQuery({ product: '', status: '', decider: '' }, 'p1')).toBe('product=p1');
  });

  it('闸口进度、下载文件名、转 PRD 的结果提示；简报状态有颜色', () => {
    expect(gateLabel({ passed: 7, total: 11 })).toBe('7/11');
    expect(briefFileName('PAN-B-3')).toBe('PAN-B-3.md');
    expect(convertMessage({ document: { displayKey: 'PAN-PRD-5' }, skipped: [] })).toBe('已生成 PAN-PRD-5');
    expect(
      convertMessage({
        document: { displayKey: 'PAN-PRD-5' },
        skipped: [
          { displayKey: 'PAN-2', documentKey: 'PAN-PRD-1' },
          { displayKey: 'PAN-7', documentKey: 'PAN-PRD-3' },
        ],
      }),
    ).toBe('已生成 PAN-PRD-5；以下需求已挂在其他 PRD 上，没有覆盖：PAN-2（PAN-PRD-1）、PAN-7（PAN-PRD-3）');
    for (const s of ['discussing', 'ready', 'converted'] as const) expect(DOCUMENT_STATUS_COLOR[s]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('关联文档：输入解析与站内地址', () => {
    expect(parseRelatedInput(' https://doc.example.com/x ', ' 群聊 ')).toEqual({ kind: 'url', url: 'https://doc.example.com/x', note: '群聊' });
    expect(parseRelatedInput('[[pan-prd-3]]', '')).toEqual({ kind: 'wiki', target: 'pan-prd-3', note: '' });
    expect(parseRelatedInput('PAN-12', '原需求')).toEqual({ kind: 'wiki', target: 'PAN-12', note: '原需求' });
    expect(parseRelatedInput('  ', '')).toBeNull();
    expect(parseRelatedInput('[[ ]]', '')).toBeNull();
    expect(relatedLinkHref('acme', 'pan-prd-3')).toBe('/acme/documents/PAN-PRD-3');
    expect(relatedLinkHref('acme', 'PAN-B-2#数据依据')).toBe('/acme/documents/PAN-B-2');
    expect(relatedLinkHref('acme', 'PAN-12')).toBe('/acme/requirements/PAN-12');
    expect(relatedLinkHref('acme', 'PAN-T-4')).toBe('/acme/tasks/PAN-T-4');
    expect(relatedLinkHref('acme', '上传/分片')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: FAIL（`briefsHref` 等不存在）。

- [ ] **Step 3: 纯逻辑（`features/documents/model.ts`）**

1. 第 1 行导入改为两行：

```ts
import { classifyTarget } from '@flower/core/links';
import { bestQuoteMatch, BRIEF_STATUSES, CHANGE_DOCUMENT_STATUSES, type DocumentStatus, type ExternalProvider, normalizeHeading, splitSections, squash, type TemplateSection } from '@flower/core/markdown';
```

并把第 3 行的类型导入改为 `import type { AffectedChangeType, BriefRelatedLink, BriefStatus, DocumentComment, MergeStatus, StructureNode } from '@/lib/types';`。

2. `DocumentView` 与 `documentView` 替换为：

```ts
export type DocumentView = 'change' | 'modules' | 'briefs';

/** 文档页的页签只由地址栏决定：?view=modules 为「模块文档」，?view=briefs 为「简报」，否则为「变更 PRD」。 */
export function documentView(sp: URLSearchParams): DocumentView {
  const v = sp.get('view');
  return v === 'modules' ? 'modules' : v === 'briefs' ? 'briefs' : 'change';
}
```

3. `moduleDocsHref` 之后加：

```ts
/** 「简报」页签的地址。 */
export const briefsHref = (org: string, productKey: string): string => `/${org}/documents?${new URLSearchParams({ product: productKey, view: 'briefs' }).toString()}`;

export type BriefListFilter = { product: string; status: BriefStatus | ''; decider: string };

export function parseBriefFilter(sp: URLSearchParams): BriefListFilter {
  const status = sp.get('status') ?? '';
  return {
    product: sp.get('product') ?? '',
    status: (BRIEF_STATUSES as readonly string[]).includes(status) ? (status as BriefStatus) : '',
    decider: sp.get('decider') ?? '',
  };
}

/** 地址栏：带上产品与页签。 */
export function briefFilterToSearch(f: BriefListFilter): string {
  const p = new URLSearchParams();
  if (f.product) p.set('product', f.product);
  p.set('view', 'briefs');
  if (f.status) p.set('status', f.status);
  if (f.decider) p.set('decider', f.decider);
  return p.toString();
}

/** 接口查询串：产品用 id。 */
export function briefFilterToApiQuery(f: BriefListFilter, productId: string): string {
  const p = new URLSearchParams({ product: productId });
  if (f.status) p.set('status', f.status);
  if (f.decider) p.set('decider', f.decider);
  return p.toString();
}

export const gateLabel = (g: { passed: number; total: number }): string => `${g.passed}/${g.total}`;
export const briefFileName = (displayKey: string): string => `${displayKey}.md`;

/** 转 PRD 成功后的提示：已挂在其他 PRD 上、没有覆盖的需求逐条列出。 */
export function convertMessage(r: { document: { displayKey: string }; skipped: Array<{ displayKey: string; documentKey: string }> }): string {
  const head = `已生成 ${r.document.displayKey}`;
  if (r.skipped.length === 0) return head;
  return `${head}；以下需求已挂在其他 PRD 上，没有覆盖：${r.skipped.map((s) => `${s.displayKey}（${s.documentKey}）`).join('、')}`;
}

/** 新增关联文档的输入：以 http(s):// 开头为网址，否则为 [[ ]] 引用（去掉外层方括号）。 */
export function parseRelatedInput(text: string, note: string): BriefRelatedLink | null {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return { kind: 'url', url: t, note: note.trim() };
  const target = t.replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
  return target ? { kind: 'wiki', target, note: note.trim() } : null;
}

/** 关联文档里 [[ ]] 引用的站内地址：需求、PRD、简报、任务按编号跳转，其他写法不链接。 */
export function relatedLinkHref(org: string, target: string): string | null {
  const t = classifyTarget(target);
  if (t.kind === 'requirement') return `/${org}/requirements/${t.productKey}-${t.number}`;
  if (t.kind === 'document') return `/${org}/documents/${t.productKey}-PRD-${t.number}`;
  if (t.kind === 'brief') return `/${org}/documents/${t.productKey}-B-${t.number}`;
  if (t.kind === 'task') return `/${org}/tasks/${t.productKey}-T-${t.number}`;
  return null;
}
```

- [ ] **Step 4: 运行纯逻辑测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型、查询与文本请求**

1. `apps/web/src/lib/types.ts`：从 `@flower/core` 的类型导入按字母顺序加入 `BriefConvertResult as CoreBriefConvertResult`、`BriefGate as CoreBriefGate`、`BriefListItem as CoreBriefListItem`、`BriefRelatedLink as CoreBriefRelatedLink`、`BriefStatus as CoreBriefStatus`、`TemplateKind as CoreTemplateKind`；在 `export type DocumentTemplate = …` 之后加：

```ts
export type TemplateKind = CoreTemplateKind;
export type BriefStatus = CoreBriefStatus;
export type BriefListItem = Jsonify<CoreBriefListItem>;
export type BriefGate = CoreBriefGate;
export type BriefRelatedLink = CoreBriefRelatedLink;
export type BriefConvertResult = Jsonify<CoreBriefConvertResult>;
```

2. `apps/web/src/lib/queries.ts`：
   - 类型导入加入 `BriefGate`、`BriefListItem`、`TemplateKind`。
   - `qk` 在 `mergeRecords` 之后加：

```ts
  briefs: (o: string, query: string) => ['org', o, 'briefs', 'list', query] as const,
  briefGate: (o: string, id: string) => ['org', o, 'briefs', 'gate', id] as const,
```

   - `export const templateKeys = …` 之后加：

```ts
/** 简报列表与闸口的公共前缀：正文保存、头部、覆盖需求、勾选与转 PRD 之后统一失效。 */
export const briefKeys = (o: string) => ['org', o, 'briefs'] as const;
export const useBriefs = (o: string, query: string, enabled = true) =>
  useQuery({ queryKey: qk.briefs(o, query), queryFn: () => api<{ briefs: BriefListItem[] }>(`/orgs/${o}/briefs?${query}`), select: (d) => d.briefs, enabled });
export const useBriefGate = (o: string, id: string) =>
  useQuery({ queryKey: qk.briefGate(o, id), queryFn: () => api<{ gate: BriefGate }>(`/orgs/${o}/briefs/${id}/gate`), select: (d) => d.gate });
```

   - `useTemplates` 替换为：

```ts
export const useTemplates = (o: string, opts: { productId?: string; usable?: boolean; kind?: TemplateKind }, enabled = true) =>
  useQuery({
    queryKey: qk.templates(o, `${opts.productId ?? 'org'}:${opts.usable ? 'usable' : 'all'}:${opts.kind ?? 'change'}`),
    queryFn: () =>
      api<{ templates: DocumentTemplate[] }>(
        `/orgs/${o}/templates?${new URLSearchParams({ ...(opts.productId ? { product: opts.productId } : {}), ...(opts.usable ? { usable: '1' } : {}), kind: opts.kind ?? 'change' })}`,
      ),
    select: (d) => d.templates,
    enabled,
  });
```

3. `apps/web/src/lib/api.ts` 在 `apiUpload` 之后加：

```ts
/** 读取文本响应（如简报的 Markdown 上下文）。出错时与 api 一样抛 ApiError。 */
export async function apiText(path: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', NETWORK_ERROR_MESSAGE, null);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? '服务暂时不可用，请稍后重试', e?.details ?? null);
  }
  return res.text();
}
```

- [ ] **Step 6: 模板设置：PRD / 简报切换与模板说明**

`apps/web/src/components/template-editor.tsx` 整个文件替换为：

```tsx
'use client';

import { FileText, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { sectionsFromBody } from '@/features/documents/model';
import { api } from '@/lib/api';
import { templateKeys, useApiMutation, useTemplates } from '@/lib/queries';
import type { DocumentTemplate, TemplateKind, TemplateSection } from '@/lib/types';

const KIND_LABEL: Record<TemplateKind, string> = { change: 'PRD 模板', brief: '简报模板' };
const KINDS: TemplateKind[] = ['change', 'brief'];

function TemplateDialog({
  org,
  productId,
  kind,
  template,
  onClose,
}: {
  org: string;
  productId: string | null;
  kind: TemplateKind;
  template: DocumentTemplate | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [guidance, setGuidance] = useState(template?.guidance ?? '');
  const [sections, setSections] = useState<TemplateSection[]>(template?.sections ?? []);
  const save = useApiMutation(
    () =>
      template
        ? api(`/orgs/${org}/templates/${template.id}`, { method: 'PATCH', body: { name, body, sections, guidance } })
        : api(`/orgs/${org}/templates`, { method: 'POST', body: { productId, kind, name, body, sections, guidance } }),
    { silentError: true, invalidate: [templateKeys(org)], success: '已保存模板', onSuccess: onClose },
  );
  const update = (i: number, patch: Partial<TemplateSection>) => setSections((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{template ? '编辑模板' : '新建模板'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-name">模板名称</Label>
          <Input id="tpl-name" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-guidance">模板说明</Label>
          <Textarea id="tpl-guidance" className="min-h-20 text-[13px]" maxLength={2000} value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          <span className="text-xs text-muted-foreground">选填。显示在用这份模板写的文档的编辑器上方。</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-body">模板正文</Label>
          <Textarea id="tpl-body" className="min-h-48 font-mono text-[12px]" value={body} onChange={(e) => setBody(e.target.value)} />
          <span className="text-xs text-muted-foreground">Markdown。可以用 {'{{date}}'}（当天日期）与 {'{{author}}'}（新建人）占位。</span>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">小节</span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setSections(sectionsFromBody(body))}>
                从正文提取小节
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setSections((prev) => [...prev, { heading: '', required: false }])}>
                添加小节
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {kind === 'brief' ? '简报的必填小节用于「写 PRD 闸口」第 1 项（第 1–14 节）；闸口只作提示，不限制改状态。' : '提交评审时检查必填小节：标题存在，且内容不只是模板原文。'}
          </p>
          <ul className="flex flex-col gap-2">
            {sections.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Input aria-label={`小节 ${i + 1} 标题`} className="h-8 w-48" value={s.heading} onChange={(e) => update(i, { heading: e.target.value })} />
                <label className="flex items-center gap-1.5 text-[13px]">
                  <Checkbox aria-label={`小节 ${i + 1} 必填`} checked={s.required} onCheckedChange={(v) => update(i, { required: v === true })} />
                  必填
                </label>
                <Input aria-label={`小节 ${i + 1} 说明`} placeholder="写作说明（选填）" className="h-8 min-w-0 flex-1" value={s.guidance ?? ''} onChange={(e) => update(i, { guidance: e.target.value })} />
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`删除小节 ${i + 1}`} onClick={() => setSections((prev) => prev.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <FormError error={save.error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={save.isPending || !name.trim()} onClick={() => save.mutate(undefined)}>
            保存模板
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function scopeNote(productId: string | null, kind: TemplateKind): string {
  if (!productId) return kind === 'brief' ? '组织内所有产品新建简报时可用；产品管理员可以在产品设置里用同名模板覆盖。' : '组织内所有产品可用；产品管理员可以在产品设置里用同名模板覆盖。';
  return kind === 'brief' ? '只用于本产品。与组织模板同名时，新建简报用本产品的版本。' : '只用于本产品。与组织模板同名时，新建 PRD 用本产品的版本。';
}

/** 文档模板列表与编辑，用「模板类型」切换 PRD 模板与简报模板。productId 为 null 时是组织模板（组织管理员），否则是该产品的覆盖模板（产品管理员）。 */
export function TemplateEditor({ org, productId }: { org: string; productId: string | null }) {
  const [kind, setKind] = useState<TemplateKind>('change');
  const list = useTemplates(org, productId ? { productId, kind } : { kind });
  const [editing, setEditing] = useState<DocumentTemplate | 'new' | null>(null);
  const invalidate = [templateKeys(org)];
  const preset = useApiMutation(() => api(`/orgs/${org}/templates/preset?kind=${kind}`, { method: 'POST' }), { invalidate, success: '已添加预置模板' });
  const toggle = useApiMutation((t: DocumentTemplate) => api(`/orgs/${org}/templates/${t.id}`, { method: 'PATCH', body: { active: !t.active } }), { invalidate });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(v) => v && setKind(v as TemplateKind)}>
            <SelectTrigger className="h-8 w-32" aria-label="模板类型">
              <SelectValue>{KIND_LABEL[kind]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[13px] text-muted-foreground">{scopeNote(productId, kind)}</p>
        </div>
        <div className="flex gap-2">
          {!productId && list.data?.length === 0 && (
            <Button variant="outline" disabled={preset.isPending} onClick={() => preset.mutate(undefined)}>
              添加预置模板
            </Button>
          )}
          <Button onClick={() => setEditing('new')}>新建模板</Button>
        </div>
      </div>
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage="没有查看模板的权限。" retryMessage="加载模板失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-32" />
      ) : list.data.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="还没有模板"
          description={productId ? '没有覆盖时使用组织模板。' : kind === 'brief' ? '可以添加预置的需求简报模板。' : '可以先添加与旧 PRD 一致的预置模板。'}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>必填小节</TableHead>
                <TableHead className="w-20">启用</TableHead>
                <TableHead className="w-20">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((t) => (
                <TableRow key={t.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="max-w-96 truncate text-[13px] text-muted-foreground">
                    {t.sections
                      .filter((s) => s.required)
                      .map((s) => s.heading)
                      .join('、') || '—'}
                  </TableCell>
                  <TableCell>
                    <Switch aria-label={`启用 ${t.name}`} checked={t.active} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(t)} />
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                      编辑
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing && (
        <TemplateDialog
          key={editing === 'new' ? `new-${kind}` : editing.id}
          org={org}
          productId={productId}
          kind={kind}
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/templates/page.tsx` 的 `description` 改为 `"新建 PRD 与简报时套用；PRD 提交评审时检查必填小节，简报的必填小节用于写 PRD 闸口。"`。

- [ ] **Step 7: 验证并提交**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS；typecheck、lint 无错误与警告。

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/lib/api.ts apps/web/src/features/documents/model.ts apps/web/src/features/documents/model.test.ts apps/web/src/components/template-editor.tsx "apps/web/src/app/(app)/[org]/settings/templates/page.tsx"
git commit -m "feat(web): 简报的数据层与纯逻辑；模板设置可切换 PRD 模板与简报模板，增加模板说明

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: 文档页「简报」页签与新建简报

**Files:**
- Create: `apps/web/src/app/(app)/[org]/documents/briefs-tab.tsx`、`apps/web/src/app/(app)/[org]/documents/create-brief-dialog.tsx`
- Modify: `apps/web/src/app/(app)/[org]/documents/page.tsx`

**Interfaces:**
- Consumes: Task 10 的 `useBriefs`、`useTemplates({ kind: 'brief' })`、`briefKeys`、`parseBriefFilter`、`briefFilterToSearch`、`briefFilterToApiQuery`、`briefsHref`、`gateLabel`、`documentView`；接口 `POST /orgs/:org/products/:id/briefs`
- Produces:
  - `CreateBriefDialog({ org, productId, open, onOpenChange, initialTitle?, requirementIds? })`：标题、简报模板、可选的覆盖需求编号（从需求详情打开时直接覆盖那条需求，不显示编号输入）；创建后跳到简报详情（Task 13 在需求详情复用）
  - `BriefsTab({ org, product, filter, onFilter, members })`：筛选（状态、决策人）与列表
  - 文档页页签「简报」（`?view=briefs`），页头按钮「新建简报」

- [ ] **Step 1: 新建对话框 `create-brief-dialog.tsx`**

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { documentHref, parseRequirementKeys } from '@/features/documents/model';
import { api } from '@/lib/api';
import { briefKeys, documentKeys, requirementKeys, useApiMutation, useTemplates } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

function CreateBriefForm({
  org,
  productId,
  initialTitle,
  requirementIds,
  onCancel,
}: {
  org: string;
  productId: string;
  initialTitle: string;
  requirementIds?: string[];
  onCancel: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [templateId, setTemplateId] = useState<string | null>(null);
  // 从文档页新建时可以顺手填要覆盖的需求编号；从需求详情新建时直接覆盖那条需求
  const [keys, setKeys] = useState('');
  const templates = useTemplates(org, { productId, usable: true, kind: 'brief' });
  // 未手动选择时用第一份可用的简报模板；没有模板时服务端新建空白简报
  const chosen = templateId ?? templates.data?.[0]?.id ?? null;
  const create = useApiMutation(
    async () => {
      const ids =
        requirementIds ??
        (await Promise.all(parseRequirementKeys(keys).map(async (k) => (await api<{ requirement: { id: string } }>(`/orgs/${org}/requirements/${encodeURIComponent(k)}`)).requirement.id)));
      return api<{ document: DocumentDetail }>(`/orgs/${org}/products/${productId}/briefs`, {
        method: 'POST',
        body: { title, ...(ids.length > 0 ? { requirementIds: ids } : {}), ...(chosen ? { templateId: chosen } : {}) },
      });
    },
    {
      silentError: true,
      invalidate: [documentKeys(org), briefKeys(org), requirementKeys(org)],
      success: '已创建简报',
      onSuccess: (d) => router.push(documentHref(org, d.document.displayKey)),
    },
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="brief-title">标题</Label>
        <Input id="brief-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="brief-template">模板</Label>
        {templates.data && templates.data.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">没有可用的简报模板，将新建空白简报。</p>
        ) : (
          // 与新建 PRD 相同：忽略隐藏原生 select 回灌的空串，选中项文字直接作为 SelectValue 的 children
          <Select value={chosen ?? ''} onValueChange={(v) => v && setTemplateId(v)}>
            <SelectTrigger id="brief-template" aria-label="模板">
              <SelectValue>{templates.data?.find((t) => t.id === chosen)?.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(templates.data ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {requirementIds ? (
        <p className="text-[13px] text-muted-foreground">新简报会覆盖当前需求。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-requirements">覆盖需求（选填）</Label>
          <Input id="brief-requirements" placeholder="PAN-12, PAN-15" value={keys} onChange={(e) => setKeys(e.target.value)} />
        </div>
      )}
      <FormError error={create.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={create.isPending || !title.trim()}>
          创建
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 新建简报：从文档页或需求详情打开；requirementIds 用于从需求详情新建时直接覆盖这条需求。 */
export function CreateBriefDialog({
  org,
  productId,
  open,
  onOpenChange,
  initialTitle = '',
  requirementIds,
}: {
  org: string;
  productId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTitle?: string;
  requirementIds?: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建简报</DialogTitle>
        </DialogHeader>
        {open && <CreateBriefForm org={org} productId={productId} initialTitle={initialTitle} requirementIds={requirementIds} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 列表页签 `briefs-tab.tsx`**

```tsx
'use client';

import { BRIEF_STATUSES, DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { DocumentStatusBadge } from '@/components/document-status';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type BriefListFilter, briefFilterToApiQuery, documentHref, gateLabel } from '@/features/documents/model';
import { activePeople, pickerOptions } from '@/features/members/model';
import { formatDateTime } from '@/features/requirements/format';
import { useBriefs } from '@/lib/queries';
import type { BriefStatus, Member, Product } from '@/lib/types';

const ALL = '__all';

/** 文档页「简报」页签：按状态、决策人筛选（写在地址栏），列出编号、标题、状态、覆盖需求、闸口进度、决策人、更新时间。 */
export function BriefsTab({
  org,
  product,
  filter,
  onFilter,
  members,
}: {
  org: string;
  product: Product;
  filter: BriefListFilter;
  onFilter: (patch: Partial<BriefListFilter>) => void;
  members: Member[] | undefined;
}) {
  const list = useBriefs(org, briefFilterToApiQuery(filter, product.id));
  const decider = members?.find((m) => m.id === filter.decider) ?? null;
  const filtered = !!(filter.status || filter.decider);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter.status || ALL} onValueChange={(v) => v && onFilter({ status: v === ALL ? '' : (v as BriefStatus) })}>
          <SelectTrigger className="h-8 w-32" aria-label="状态">
            <SelectValue>{filter.status ? DOCUMENT_STATUS_LABELS[filter.status] : '全部状态'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {BRIEF_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {DOCUMENT_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {members && (
          <MemberPicker
            label="决策人"
            className="h-8 w-36"
            options={pickerOptions(activePeople(members), decider ? { id: decider.id, displayName: decider.displayName } : null)}
            value={filter.decider || null}
            noneLabel="全部决策人"
            placeholder="全部决策人"
            onChange={(id) => onFilter({ decider: id ?? '' })}
          />
        )}
      </div>
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage="你没有查看这个产品的权限。" retryMessage="加载简报失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-48" />
      ) : list.data.length === 0 ? (
        filtered ? (
          <p className="py-8 text-center text-muted-foreground">没有符合条件的简报</p>
        ) : (
          <EmptyState icon={FileText} title="还没有简报" description="写 PRD 之前，把查代码、取数、可行性与方案讨论的结论按模板记在简报里。" />
        )
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">编号</TableHead>
                <TableHead className="w-[34%]">标题</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-20">覆盖需求</TableHead>
                <TableHead className="w-20">闸口</TableHead>
                <TableHead className="w-24">决策人</TableHead>
                <TableHead className="w-36">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((b) => (
                <TableRow key={b.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono text-[13px]">
                    <Link href={documentHref(org, b.displayKey)} className="hover:underline">
                      {b.displayKey}
                    </Link>
                  </TableCell>
                  <TableCell className="truncate">
                    <Link href={documentHref(org, b.displayKey)} className="hover:underline">
                      {b.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <DocumentStatusBadge status={b.status} />
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{b.requirementCount}</TableCell>
                  <TableCell className="font-mono text-[13px]">{gateLabel(b.gate)}</TableCell>
                  <TableCell className="truncate text-[13px]">{b.decider?.displayName ?? '—'}</TableCell>
                  <TableCell className="font-mono text-[13px] text-muted-foreground">{formatDateTime(b.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: 文档页接入页签**

`apps/web/src/app/(app)/[org]/documents/page.tsx` 整个文件替换为：

```tsx
'use client';

import { CHANGE_DOCUMENT_STATUSES, DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { MemberPicker } from '@/components/member-picker';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  type BriefListFilter,
  briefFilterToSearch,
  briefsHref,
  type DocumentListFilter,
  documentFilterToApiQuery,
  documentFilterToSearch,
  documentHref,
  documentView,
  moduleDocsHref,
  parseBriefFilter,
  parseDocumentFilter,
  sourceLabel,
} from '@/features/documents/model';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { formatDateTime } from '@/features/requirements/format';
import { useDocuments, useMembers, useOrg, useProducts } from '@/lib/queries';
import type { DocumentStatus } from '@/lib/types';
import { BriefsTab } from './briefs-tab';
import { CreateBriefDialog } from './create-brief-dialog';
import { CreateDocumentDialog } from './create-dialog';
import { ModuleDocsTab } from './module-docs-tab';

const ALL = '__all';
const VIEW_LABEL = { change: '变更 PRD', modules: '模块文档', briefs: '简报' } as const;

function DocumentsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = useMemo(() => parseDocumentFilter(new URLSearchParams(searchParams.toString())), [searchParams]);
  const briefFilter = useMemo(() => parseBriefFilter(new URLSearchParams(searchParams.toString())), [searchParams]);
  const orgQ = useOrg(org);
  const products = useProducts(org);
  const product = products.data?.find((p) => p.key === filter.product) ?? products.data?.[0];
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const view = documentView(new URLSearchParams(searchParams.toString()));
  const list = useDocuments(org, view === 'change' ? product?.id : undefined, documentFilterToApiQuery(filter));
  const [creating, setCreating] = useState(false);
  const [creatingBrief, setCreatingBrief] = useState(false);
  const [q, setQ] = useState(filter.q);
  // 地址栏里的 q 变化时（前进后退）同步到输入框；在渲染期间调整
  const [syncedQ, setSyncedQ] = useState(filter.q);
  if (filter.q !== syncedQ) {
    setSyncedQ(filter.q);
    setQ(filter.q);
  }
  const setFilter = (patch: Partial<DocumentListFilter>) => {
    const qs = documentFilterToSearch({ ...filter, product: product?.key ?? filter.product, ...patch });
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  };
  const setBriefFilter = (patch: Partial<BriefListFilter>) => {
    router.replace(`?${briefFilterToSearch({ ...briefFilter, product: product?.key ?? briefFilter.product, ...patch })}`, { scroll: false });
  };
  const hrefFor = (v: string, key: string) => (v === 'modules' ? moduleDocsHref(org, key) : v === 'briefs' ? briefsHref(org, key) : `/${org}/documents?product=${key}`);

  if (products.isError) return <QueryError error={products.error} noAccessMessage="你没有查看产品的权限。" retryMessage="加载产品失败，请重试。" onRetry={() => products.refetch()} />;
  if (!products.data) return <Skeleton className="h-64" />;
  if (!product) {
    return (
      <>
        <PageHeader title="文档" />
        <EmptyState icon={FileText} title="还没有产品" description="PRD 与简报挂在产品下。请组织管理员先在「组织设置 / 产品」中创建产品。" />
      </>
    );
  }
  const canCreate = product.myRole !== 'viewer';
  const filtered = !!(filter.status || filter.owner || filter.source || filter.q);
  const owner = members.data?.find((m) => m.id === filter.owner) ?? null;

  return (
    <>
      <PageHeader
        title="文档"
        description={`${product.name} · ${VIEW_LABEL[view]}`}
        actions={
          <>
            {products.data.length > 1 && (
              <Select value={product.key} onValueChange={(key) => router.replace(view === 'change' ? `?${documentFilterToSearch({ ...filter, product: key })}` : hrefFor(view, key))}>
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
            {canCreate && view === 'change' && <Button onClick={() => setCreating(true)}>新建 PRD</Button>}
            {canCreate && view === 'briefs' && <Button onClick={() => setCreatingBrief(true)}>新建简报</Button>}
          </>
        }
      />
      <Tabs value={view} onValueChange={(v) => router.replace(hrefFor(v, product.key))}>
        <TabsList>
          <TabsTrigger value="change">变更 PRD</TabsTrigger>
          <TabsTrigger value="modules">模块文档</TabsTrigger>
          <TabsTrigger value="briefs">简报</TabsTrigger>
        </TabsList>
      </Tabs>
      {view === 'modules' ? (
        <ModuleDocsTab org={org} product={product} focusNodeId={searchParams.get('node')} />
      ) : view === 'briefs' ? (
        <BriefsTab org={org} product={product} filter={briefFilter} onFilter={setBriefFilter} members={members.data} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <form
              className="min-w-0 flex-1 basis-48"
              onSubmit={(e) => {
                e.preventDefault();
                setFilter({ q: q.trim() });
              }}
            >
              <Input type="search" aria-label="搜索 PRD" placeholder="按标题、编号或网址搜索，回车确认" value={q} onChange={(e) => setQ(e.target.value)} className="h-8" />
            </form>
            <Select value={filter.status || ALL} onValueChange={(v) => setFilter({ status: v === ALL ? '' : (v as DocumentStatus) })}>
              <SelectTrigger className="h-8 w-32" aria-label="状态">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部状态</SelectItem>
                {CHANGE_DOCUMENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {DOCUMENT_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filter.source || ALL} onValueChange={(v) => setFilter({ source: v === ALL ? '' : (v as 'native' | 'external') })}>
              <SelectTrigger className="h-8 w-32" aria-label="来源">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部来源</SelectItem>
                <SelectItem value="native">Flower 文档</SelectItem>
                <SelectItem value="external">外部链接</SelectItem>
              </SelectContent>
            </Select>
            {members.data && (
              <MemberPicker
                label="负责人"
                className="h-8 w-36"
                options={pickerOptions(activePeople(members.data), owner ? { id: owner.id, displayName: owner.displayName } : null)}
                value={filter.owner || null}
                noneLabel="全部负责人"
                placeholder="全部负责人"
                onChange={(id) => setFilter({ owner: id ?? '' })}
              />
            )}
          </div>
          {list.isError ? (
            <QueryError error={list.error} noAccessMessage="你没有查看这个产品的权限。" retryMessage="加载 PRD 失败，请重试。" onRetry={() => list.refetch()} />
          ) : !list.data ? (
            <Skeleton className="h-48" />
          ) : list.data.length === 0 ? (
            filtered ? (
              <p className="py-8 text-center text-muted-foreground">没有符合条件的 PRD</p>
            ) : (
              <EmptyState icon={FileText} title="还没有 PRD" description="PRD 可以写在 Flower 里，也可以只登记外部文档的链接。" />
            )
          ) : (
            <div className="overflow-x-auto rounded-md border bg-card">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">编号</TableHead>
                    <TableHead className="w-[40%]">标题</TableHead>
                    <TableHead className="w-24">状态</TableHead>
                    <TableHead className="w-32">来源</TableHead>
                    <TableHead className="w-24">负责人</TableHead>
                    <TableHead className="w-20">覆盖需求</TableHead>
                    <TableHead className="w-36">更新时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.map((d) => (
                    <TableRow key={d.id} className="h-10 even:bg-zebra">
                      <TableCell className="font-mono text-[13px]">
                        <Link href={documentHref(org, d.displayKey)} className="hover:underline">
                          {d.displayKey}
                        </Link>
                      </TableCell>
                      <TableCell className="truncate">
                        <Link href={documentHref(org, d.displayKey)} className="hover:underline">
                          {d.title}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <DocumentStatusBadge status={d.status} />
                      </TableCell>
                      <TableCell className="truncate text-[13px] text-muted-foreground">{sourceLabel(d)}</TableCell>
                      <TableCell className="truncate text-[13px]">{d.owner?.displayName ?? '—'}</TableCell>
                      <TableCell className="font-mono text-[13px]">{d.requirementCount}</TableCell>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{formatDateTime(d.updatedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
      <CreateDocumentDialog org={org} productId={product.id} open={creating} onOpenChange={setCreating} />
      <CreateBriefDialog org={org} productId={product.id} open={creatingBrief} onOpenChange={setCreatingBrief} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <DocumentsPage />
    </Suspense>
  );
}
```

（与原文件相比只改了：页签与描述的「简报」、产品切换与页签切换的地址（`hrefFor`）、`BriefsTab` 分支、「新建简报」按钮与对话框、空状态说明里的「PRD 与简报」。）

- [ ] **Step 4: 验证并提交**

Run: `pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0 && pnpm --filter @flower/web exec vitest run src/features/documents`
Expected: 无错误与警告；单测通过。界面行为由 Task 14 的端到端测试覆盖。

```bash
git add "apps/web/src/app/(app)/[org]/documents/page.tsx" "apps/web/src/app/(app)/[org]/documents/briefs-tab.tsx" "apps/web/src/app/(app)/[org]/documents/create-brief-dialog.tsx"
git commit -m "feat(web): 文档页「简报」页签：列表、状态与决策人筛选、新建简报

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: 简报详情页（模板说明、头部信息、覆盖的需求、写 PRD 闸口、操作）与 PRD 的来源

**Files:**
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/covered-requirements.tsx`、`brief-side-panel.tsx`、`brief-header-card.tsx`、`brief-gate-card.tsx`、`brief-actions-card.tsx`（均在 `[key]/` 下）
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`、`side-panel.tsx`、`editor-pane.tsx`

**Interfaces:**
- Consumes: Task 10 的 `useBriefGate`、`briefKeys`、`apiText`、`briefsHref`、`gateLabel`、`briefFileName`、`convertMessage`、`parseRelatedInput`、`relatedLinkHref`、类型 `BriefConvertResult`、`BriefRelatedLink`；Task 9 的接口；已有的 `StatusCard`、`Revisions`、`EditorPane`
- Produces:
  - `CoveredRequirements({ org, doc, invalidate })`：从 `SidePanel` 抽出的「覆盖的需求」区块，PRD 与简报共用
  - `BriefSidePanel({ org, doc, onReload, saveEditor })`：状态、头部信息、覆盖的需求、写 PRD 闸口、操作、修订
  - 区块与控件的可访问名称（Task 14 用）：区块「头部信息」「覆盖的需求」「写 PRD 闸口」「操作」「模板说明」；输入「版本」「引用或网址」「说明」；成员选择「提出人」「决策人」「作者」；多选「参与方」；闸口列表项「闸口 n」、勾选框「勾选闸口 n」；按钮「转 PRD」「复制为 Markdown」「下载 .md」；对话框「转 PRD」与按钮「生成 PRD 草稿」「再生成一份新草稿」「打开 PAN-PRD-n」
  - PRD 详情在正文上方显示「由简报 PAN-B-n 生成」（`role="note"`，名称「来源简报」；正文第一行也有「由简报 …」，端到端测试按角色区分）

- [ ] **Step 1: 抽出「覆盖的需求」`covered-requirements.tsx`**

```tsx
'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { parseRequirementKeys } from '@/features/documents/model';
import { ApiError, api } from '@/lib/api';
import { useApiMutation } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

/** 文档覆盖的需求：列表、按编号关联、移出。变更 PRD 与简报共用，服务端按文档类型写对应的列。 */
export function CoveredRequirements({ org, doc, invalidate }: { org: string; doc: DocumentDetail; invalidate: ReadonlyArray<readonly unknown[]> }) {
  const canEdit = doc.myRole !== 'viewer';
  const [keys, setKeys] = useState('');
  const link = useApiMutation(
    async (input: string) => {
      const wanted = parseRequirementKeys(input);
      if (wanted.length === 0) throw new ApiError(400, 'invalid', '请输入需求编号，例如 PAN-12', null);
      const ids = await Promise.all(wanted.map(async (k) => (await api<{ requirement: { id: string } }>(`/orgs/${org}/requirements/${encodeURIComponent(k)}`)).requirement.id));
      return api(`/orgs/${org}/documents/${doc.id}/requirements`, { method: 'POST', body: { requirementIds: ids } });
    },
    { silentError: true, invalidate, success: '已关联需求', onSuccess: () => setKeys('') },
  );
  const unlink = useApiMutation((requirementId: string) => api(`/orgs/${org}/documents/${doc.id}/requirements/${requirementId}`, { method: 'DELETE' }), {
    invalidate,
    success: '已移出',
  });
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-req-title">
      <h2 id="doc-req-title" className="mb-2 text-sm font-semibold">
        覆盖的需求
      </h2>
      {doc.requirements.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有覆盖需求</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {doc.requirements.map((r) => (
            <li key={r.id} className="flex h-8 items-center gap-2 text-[13px]">
              <Link href={`/${org}/requirements/${r.displayKey}`} className="min-w-0 flex-1 truncate hover:underline">
                <span className="mr-2 font-mono text-muted-foreground">{r.displayKey}</span>
                {r.title}
              </Link>
              {canEdit && (
                <Button size="icon-sm" variant="ghost" aria-label={`移出 ${r.displayKey}`} disabled={unlink.isPending} onClick={() => unlink.mutate(r.id)}>
                  <X className="size-4" aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && doc.status !== 'discarded' && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            link.mutate(keys);
          }}
        >
          <div className="flex gap-2">
            <Input aria-label="需求编号" placeholder={`${doc.productKey}-12, ${doc.productKey}-15`} className="h-8" value={keys} onChange={(e) => setKeys(e.target.value)} />
            <Button type="submit" size="sm" disabled={link.isPending || !keys.trim()}>
              关联
            </Button>
          </div>
          <FormError error={link.error} />
        </form>
      )}
    </section>
  );
}
```

`side-panel.tsx`：删除原「覆盖的需求」整个 `<section>`、`keys` 状态与 `link` / `unlink` 两个 mutation，改为在负责人区块之后放：

```tsx
      <CoveredRequirements org={org} doc={doc} invalidate={invalidate} />
```

并删去因此不再使用的导入（`X`、`Link`、`useState`、`FormError`、`Input`、`parseRequirementKeys`、`ApiError`），加 `import { CoveredRequirements } from './covered-requirements';`。占位文字由固定的 `PAN-12, PAN-15` 改为按当前产品编号（现有 e2e 用 `getByLabel('需求编号')` 定位，不受影响）。

- [ ] **Step 2: 头部信息 `brief-header-card.tsx`**

```tsx
'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { OptionMultiSelect } from '@/components/option-multi-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseRelatedInput, relatedLinkHref } from '@/features/documents/model';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { ApiError, api } from '@/lib/api';
import { briefKeys, documentKeys, useApiMutation, useFunctionTags, useMembers, useOrg } from '@/lib/queries';
import type { BriefRelatedLink, DocumentDetail } from '@/lib/types';

type Patch = {
  version?: string;
  requesterMemberId?: string | null;
  deciderMemberId?: string | null;
  authorMemberId?: string | null;
  participantTagIds?: string[];
  relatedLinks?: BriefRelatedLink[];
};
const PEOPLE = [
  { field: 'requesterMemberId', key: 'requester', label: '提出人' },
  { field: 'deciderMemberId', key: 'decider', label: '决策人' },
  { field: 'authorMemberId', key: 'author', label: '作者' },
] as const;

/** 简报头部信息：版本、提出人、决策人、参与方、作者、关联文档。每改一项保存一次。 */
export function BriefHeaderCard({ org, doc }: { org: string; doc: DocumentDetail }) {
  const h = doc.brief!;
  const canEdit = doc.myRole !== 'viewer';
  const me = useOrg(org).data?.me;
  const members = useMembers(org, canEdit && canListMembers(me));
  const tags = useFunctionTags(org, canEdit && !!me && me.orgRole !== 'guest');
  const invalidate = [documentKeys(org), briefKeys(org)];
  const [version, setVersion] = useState(h.version);
  // 服务端的版本变化时（保存后、别人改了）在渲染期间同步到输入框
  const [syncedVersion, setSyncedVersion] = useState(h.version);
  if (h.version !== syncedVersion) {
    setSyncedVersion(h.version);
    setVersion(h.version);
  }
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const save = useApiMutation((body: Patch) => api(`/orgs/${org}/briefs/${doc.id}`, { method: 'PATCH', body }), { invalidate, success: '已保存' });
  const addLink = useApiMutation(
    async () => {
      const link = parseRelatedInput(target, note);
      if (!link) throw new ApiError(400, 'invalid', '请输入编号（如 PAN-PRD-3）或以 http:// 或 https:// 开头的网址', null);
      return api(`/orgs/${org}/briefs/${doc.id}`, { method: 'PATCH', body: { relatedLinks: [...h.relatedLinks, link] } });
    },
    {
      silentError: true,
      invalidate,
      success: '已添加关联文档',
      onSuccess: () => {
        setTarget('');
        setNote('');
      },
    },
  );
  const saveVersion = (e?: FormEvent) => {
    e?.preventDefault();
    const v = version.trim();
    if (v && v !== h.version) save.mutate({ version: v });
  };

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="brief-header-title">
      <h2 id="brief-header-title" className="mb-3 text-sm font-semibold">
        头部信息
      </h2>
      <div className="flex flex-col gap-3 text-[13px]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brief-version">版本</Label>
          {canEdit ? (
            <form onSubmit={saveVersion}>
              <Input id="brief-version" className="h-8" maxLength={30} value={version} onChange={(e) => setVersion(e.target.value)} onBlur={() => saveVersion()} />
            </form>
          ) : (
            <p id="brief-version">{h.version}</p>
          )}
        </div>
        {PEOPLE.map((p) => (
          <div key={p.field} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{p.label}</span>
            {canEdit && members.data ? (
              <MemberPicker
                label={p.label}
                options={pickerOptions(activePeople(members.data), h[p.key])}
                value={h[p.key]?.id ?? null}
                noneLabel="未指定"
                onChange={(id) => save.mutate({ [p.field]: id } as Patch)}
              />
            ) : (
              <p>{h[p.key]?.displayName ?? '未指定'}</p>
            )}
          </div>
        ))}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">参与方</span>
          {canEdit && tags.data && (
            <div>
              <OptionMultiSelect
                label="参与方"
                options={tags.data.map((x) => ({ id: x.id, label: x.name, color: x.color }))}
                value={h.participantTags.map((x) => x.id)}
                onChange={(ids) => save.mutate({ participantTagIds: ids })}
              />
            </div>
          )}
          <p className="text-muted-foreground">{h.participantTags.map((x) => x.name).join('、') || '未填写'}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">关联文档</span>
          {h.relatedLinks.length === 0 ? (
            <p className="text-muted-foreground">还没有关联文档</p>
          ) : (
            <ul aria-label="关联文档" className="flex flex-col gap-1">
              {h.relatedLinks.map((l, i) => {
                const href = l.kind === 'url' ? l.url : relatedLinkHref(org, l.target);
                const text = l.kind === 'url' ? l.url : l.target;
                return (
                  <li key={i} className="flex min-h-8 items-center gap-2">
                    <span className="min-w-0 flex-1 break-all">
                      {href ? (
                        l.kind === 'url' ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {text}
                          </a>
                        ) : (
                          <Link href={href} className="font-mono hover:underline">
                            {text}
                          </Link>
                        )
                      ) : (
                        <span className="font-mono">{text}</span>
                      )}
                      {l.note && <span className="ml-2 text-muted-foreground">{l.note}</span>}
                    </span>
                    {canEdit && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`移除关联 ${i + 1}`}
                        disabled={save.isPending}
                        onClick={() => save.mutate({ relatedLinks: h.relatedLinks.filter((_, j) => j !== i) })}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canEdit && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addLink.mutate(undefined);
              }}
            >
              <Input aria-label="引用或网址" placeholder={`${doc.productKey}-PRD-3 或 https://…`} className="h-8" value={target} onChange={(e) => setTarget(e.target.value)} />
              <div className="flex gap-2">
                <Input aria-label="说明" placeholder="说明（选填）" className="h-8" maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} />
                <Button type="submit" size="sm" disabled={addLink.isPending || !target.trim()}>
                  添加
                </Button>
              </div>
              <FormError error={addLink.error} />
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: 写 PRD 闸口 `brief-gate-card.tsx`**

```tsx
'use client';

import { Check, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { QueryError } from '@/components/load-error';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { gateLabel } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { briefKeys, useApiMutation, useBriefGate } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

/** 写 PRD 闸口：自动项显示结果与原因并可定位到小节；人工项可勾选，显示勾选人与时间。只作提示，不限制改状态与转 PRD。 */
export function BriefGateCard({ org, doc }: { org: string; doc: DocumentDetail }) {
  const gate = useBriefGate(org, doc.id);
  const router = useRouter();
  const pathname = usePathname();
  const canEdit = doc.myRole !== 'viewer';
  const check = useApiMutation(
    (v: { item: number; checked: boolean }) => api(`/orgs/${org}/briefs/${doc.id}/gate/${v.item}`, { method: 'PUT', body: { checked: v.checked } }),
    { invalidate: [briefKeys(org)] },
  );
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="brief-gate-title">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 id="brief-gate-title" className="text-sm font-semibold">
          写 PRD 闸口
        </h2>
        {gate.data && <span className="font-mono text-[13px] text-muted-foreground">{gateLabel(gate.data)}</span>}
      </div>
      <p className="mb-3 text-[12px] text-muted-foreground">只作提示，不限制改状态与转 PRD。</p>
      {gate.isError ? (
        <QueryError error={gate.error} noAccessMessage="没有查看这份简报的权限。" retryMessage="加载闸口失败，请重试。" onRetry={() => gate.refetch()} />
      ) : !gate.data ? (
        <Skeleton className="h-40" />
      ) : (
        <ul aria-label="闸口项" className="flex flex-col gap-2">
          {gate.data.items.map((i) => (
            <li key={i.no} aria-label={`闸口 ${i.no}`} className="flex gap-2 text-[13px] leading-5">
              {i.auto ? (
                <span role="img" aria-label={i.passed ? '通过' : '未通过'} className="mt-0.5 shrink-0">
                  {i.passed ? <Check className="size-4 text-emerald-600" aria-hidden="true" /> : <X className="size-4 text-destructive" aria-hidden="true" />}
                </span>
              ) : (
                <Checkbox
                  className="mt-0.5"
                  aria-label={`勾选闸口 ${i.no}`}
                  checked={i.passed}
                  disabled={!canEdit || check.isPending}
                  onCheckedChange={(v) => check.mutate({ item: i.no, checked: v === true })}
                />
              )}
              <div className="min-w-0 flex-1">
                <p>
                  <span className="mr-1 font-mono text-muted-foreground">{i.no}</span>
                  {i.label}
                  {i.auto && <span className="ml-1 text-[12px] text-muted-foreground">（自动检查）</span>}
                </p>
                {i.reasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[12px] text-destructive">
                    {i.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
                {i.section && (
                  <button
                    type="button"
                    className="mt-1 text-[12px] text-primary hover:underline"
                    onClick={() => router.replace(`${pathname}?section=${encodeURIComponent(i.section!)}`, { scroll: false })}
                  >
                    定位到「{i.section}」
                  </button>
                )}
                {i.checkedBy && i.checkedAt && (
                  <p className="text-[12px] text-muted-foreground">
                    {i.checkedBy.displayName} · {formatDateTime(i.checkedAt)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: 操作与转 PRD `brief-actions-card.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { briefFileName, convertMessage, documentHref } from '@/features/documents/model';
import { api, apiText } from '@/lib/api';
import { briefKeys, documentKeys, requirementKeys, useApiMutation, useBriefGate } from '@/lib/queries';
import type { BriefConvertResult, DocumentDetail } from '@/lib/types';

type Props = { org: string; doc: DocumentDetail; saveEditor: () => Promise<number | null> };

/** 转 PRD 的确认：先列出没通过的闸口项（不阻止）；已转过时可以打开已有 PRD 或再生成一份新草稿。 */
function ConvertDialog({ org, doc, saveEditor, open, onOpenChange }: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const gate = useBriefGate(org, doc.id);
  const failing = gate.data?.items.filter((i) => !i.passed) ?? [];
  const converted = doc.brief!.convertedDocument;
  const convert = useApiMutation(
    async (again: boolean) => {
      await saveEditor();
      return api<BriefConvertResult>(`/orgs/${org}/briefs/${doc.id}/convert`, { method: 'POST', body: { again } });
    },
    {
      silentError: true,
      invalidate: [documentKeys(org), briefKeys(org), requirementKeys(org)],
      onSuccess: (r) => {
        toast.success(convertMessage(r));
        onOpenChange(false);
        router.push(documentHref(org, r.document.displayKey));
      },
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>转 PRD</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[13px]">
          <p>按简报第 18 节的对应关系生成一份变更 PRD 草稿，覆盖与简报相同的需求；已挂在其他 PRD 上的需求会跳过并列出。</p>
          {gate.data &&
            (failing.length > 0 ? (
              <div>
                <p>以下闸口项还没有通过（不影响生成）：</p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {failing.map((i) => (
                    <li key={i.no}>
                      {i.no}. {i.label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p>闸口全部通过。</p>
            ))}
          {converted && (
            <p>
              这份简报已转为{' '}
              <Link href={documentHref(org, converted.displayKey)} className="font-mono hover:underline">
                {converted.displayKey}
              </Link>
              。再生成会新建一份草稿，原来的 PRD 保留。
            </p>
          )}
          <FormError error={convert.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {converted ? (
            <>
              <Button variant="outline" asChild>
                <Link href={documentHref(org, converted.displayKey)}>打开 {converted.displayKey}</Link>
              </Button>
              <Button disabled={convert.isPending} onClick={() => convert.mutate(true)}>
                再生成一份新草稿
              </Button>
            </>
          ) : (
            <Button disabled={convert.isPending} onClick={() => convert.mutate(false)}>
              生成 PRD 草稿
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 操作：转 PRD、复制为 Markdown、下载 .md（先保存编辑器里没到时间的修改，内容与上下文接口一致）。 */
export function BriefActionsCard({ org, doc, saveEditor }: Props) {
  const [converting, setConverting] = useState(false);
  const canEdit = doc.myRole !== 'viewer';
  const converted = doc.brief!.convertedDocument;
  const markdown = async () => {
    await saveEditor();
    return apiText(`/orgs/${org}/briefs/${doc.id}/context?format=markdown`);
  };
  const copy = useApiMutation(async () => navigator.clipboard.writeText(await markdown()), { success: '已复制 Markdown' });
  const download = useApiMutation(async () => {
    const url = URL.createObjectURL(new Blob([await markdown()], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = briefFileName(doc.displayKey);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="brief-actions-title">
      <h2 id="brief-actions-title" className="mb-2 text-sm font-semibold">
        操作
      </h2>
      {converted && (
        <p className="mb-2 text-[13px]">
          已转为{' '}
          <Link href={documentHref(org, converted.displayKey)} className="font-mono hover:underline">
            {converted.displayKey}
          </Link>{' '}
          {converted.title}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canEdit && doc.status !== 'discarded' && (
          <Button size="sm" onClick={() => setConverting(true)}>
            转 PRD
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={copy.isPending} onClick={() => copy.mutate(undefined)}>
          复制为 Markdown
        </Button>
        <Button size="sm" variant="outline" disabled={download.isPending} onClick={() => download.mutate(undefined)}>
          下载 .md
        </Button>
      </div>
      {canEdit && <ConvertDialog org={org} doc={doc} saveEditor={saveEditor} open={converting} onOpenChange={setConverting} />}
    </section>
  );
}
```

- [ ] **Step 5: 简报侧栏 `brief-side-panel.tsx`**

```tsx
'use client';

import { briefKeys, documentKeys, qk, requirementKeys } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';
import { BriefActionsCard } from './brief-actions-card';
import { BriefGateCard } from './brief-gate-card';
import { BriefHeaderCard } from './brief-header-card';
import { CoveredRequirements } from './covered-requirements';
import { Revisions } from './revisions';
import { StatusCard } from './status-card';

/** 简报详情的侧栏：状态、头部信息、覆盖的需求、写 PRD 闸口、操作、修订。 */
export function BriefSidePanel({ org, doc, onReload, saveEditor }: { org: string; doc: DocumentDetail; onReload: () => void; saveEditor: () => Promise<number | null> }) {
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <StatusCard org={org} doc={doc} saveEditor={saveEditor} />
      <BriefHeaderCard org={org} doc={doc} />
      <CoveredRequirements org={org} doc={doc} invalidate={[documentKeys(org), requirementKeys(org), briefKeys(org), qk.workbench]} />
      <BriefGateCard org={org} doc={doc} />
      <BriefActionsCard org={org} doc={doc} saveEditor={saveEditor} />
      <Revisions org={org} doc={doc} onRestored={onReload} saveEditor={saveEditor} />
    </aside>
  );
}
```

- [ ] **Step 6: 详情页与编辑器**

1. `apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`：
   - 加导入 `import Link from 'next/link';`、`import { BriefSidePanel } from './brief-side-panel';`，`@/features/documents/model` 的导入改为 `import { briefsHref, documentHref, moduleDocsHref } from '@/features/documents/model';`。
   - `PageHeader` 的 `crumbs` 第一项的 `href` 改为：

```tsx
d.kind === 'module' ? moduleDocsHref(org, d.productKey, d.node?.id) : d.kind === 'brief' ? briefsHref(org, d.productKey) : `/${org}/documents?product=${d.productKey}`
```

   - 左栏 `<div className="flex min-w-0 flex-col gap-4">` 里、正文之前加：

```tsx
          {d.templateGuidance && (
            <section aria-label="模板说明" className="whitespace-pre-wrap rounded-md border bg-muted/40 px-4 py-3 text-[13px] leading-6 text-muted-foreground">
              {d.templateGuidance}
            </section>
          )}
          {d.sourceBrief && (
            <p role="note" aria-label="来源简报" className="text-[13px] text-muted-foreground">
              由简报{' '}
              <Link href={documentHref(org, d.sourceBrief.displayKey)} className="font-mono hover:underline">
                {d.sourceBrief.displayKey}
              </Link>{' '}
              生成
            </p>
          )}
```

   - 右栏的选择改为：

```tsx
        {d.kind === 'module' ? (
          <ModuleSidePanel org={org} doc={d} onReload={() => void reload()} saveEditor={saveEditor} />
        ) : d.kind === 'brief' ? (
          <BriefSidePanel org={org} doc={d} onReload={() => void reload()} saveEditor={saveEditor} />
        ) : (
          <SidePanel org={org} doc={d} onReload={() => void reload()} saveEditor={saveEditor} />
        )}
```

   - 加载失败的提示 `noAccessMessage` 改为 `"文档不存在，或你没有查看它所在产品的权限。"`、`retryMessage` 改为 `"加载文档失败，请重试。"`（同一页面现在也打开简报；写计划时已检索，现有端到端用例没有断言旧文字）。

2. `apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`：`@/lib/queries` 的导入加 `briefKeys`；保存的 `invalidate` 改为：

```ts
      invalidate: [qk.documentRevisions(org, doc.id), linkKeys(org), briefKeys(org)],
```

（正文保存后简报的闸口与列表进度随之刷新；PRD 页面没有挂简报查询时失效为空操作。）

- [ ] **Step 7: 验证并提交**

Run: `pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0 && pnpm --filter @flower/web e2e documents.spec.ts documents-prd-flow.spec.ts documents-editor.spec.ts`
Expected: 无错误与警告；已有 PRD 页面的端到端用例照常通过（「覆盖的需求」抽成组件后行为不变）。简报详情的行为由 Task 14 覆盖。

```bash
git add "apps/web/src/app/(app)/[org]/documents/[key]"
git commit -m "feat(web): 简报详情页：模板说明、头部信息、覆盖的需求、写 PRD 闸口、转 PRD 与 Markdown 复制下载；PRD 显示来源简报

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 需求详情侧栏「简报」区块；「PRD」区块拒绝简报编号

**Files:**
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/brief-card.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`、`apps/web/src/app/(app)/[org]/requirements/[key]/prd-card.tsx`

**Interfaces:**
- Consumes: Task 8 的 `RequirementDetail.brief`；Task 11 的 `CreateBriefDialog`；Task 10 的 `gateLabel`
- Produces: 侧栏区块「简报」（`aria-labelledby`，名称「简报」）：没挂时「还没有简报」与「新建简报」（编辑及以上）；挂了时编号、标题、状态与「闸口 7/11」；「PRD」区块「关联已有 PRD」输入简报编号时提示「请输入 PRD 编号，例如 PAN-PRD-1」

- [ ] **Step 1: 新建 `brief-card.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { Button } from '@/components/ui/button';
import { documentHref, gateLabel } from '@/features/documents/model';
import type { RequirementDetail } from '@/lib/types';
import { CreateBriefDialog } from '../../documents/create-brief-dialog';

/** 需求所挂的简报：编号、标题、状态与闸口进度；没挂时可以新建并自动覆盖这条需求。 */
export function BriefCard({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const brief = r.brief;
  const [creating, setCreating] = useState(false);
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="req-brief-title">
      <h2 id="req-brief-title" className="mb-2 text-sm font-semibold">
        简报
      </h2>
      {brief ? (
        <div className="flex flex-col gap-2">
          <Link href={documentHref(org, brief.displayKey)} className="text-[13px] hover:underline">
            <span className="mr-2 font-mono text-muted-foreground">{brief.displayKey}</span>
            {brief.title}
          </Link>
          <div className="flex items-center gap-3">
            <DocumentStatusBadge status={brief.status} />
            <span className="font-mono text-[12px] text-muted-foreground">闸口 {gateLabel(brief.gate)}</span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-muted-foreground">还没有简报</p>
          {canEdit && (
            <Button size="sm" className="self-start" onClick={() => setCreating(true)}>
              新建简报
            </Button>
          )}
          <CreateBriefDialog org={org} productId={r.productId} open={creating} onOpenChange={setCreating} initialTitle={r.title} requirementIds={[r.id]} />
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 放进侧栏**

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：加 `import { BriefCard } from './brief-card';`，侧栏 `<PrdCard org={org} requirement={r} />` 之前加 `<BriefCard org={org} requirement={r} />`。

- [ ] **Step 3: 「PRD」区块拒绝简报编号**

`prd-card.tsx`：`@/lib/api` 的导入改为 `import { ApiError, api } from '@/lib/api';`；`link` 的请求函数改为：

```ts
    async (k: string) => {
      const found = await api<{ document: { id: string; kind: string } }>(`/orgs/${org}/documents/${encodeURIComponent(k.trim().toUpperCase())}`);
      // 简报与 PRD 编号同形（PAN-B-n / PAN-PRD-n），这里只接受变更 PRD，免得把需求挂到简报上
      if (found.document.kind !== 'change') throw new ApiError(400, 'invalid', `请输入 PRD 编号，例如 ${r.productKey}-PRD-1`, null);
      return api(`/orgs/${org}/documents/${found.document.id}/requirements`, { method: 'POST', body: { requirementIds: [r.id] } });
    },
```

- [ ] **Step 4: 验证并提交**

Run: `pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0 && pnpm --filter @flower/web e2e documents-prd-flow.spec.ts requirements.spec.ts`
Expected: 无错误与警告；已有用例通过。新区块与拒绝简报编号由 Task 14 覆盖。

```bash
git add "apps/web/src/app/(app)/[org]/requirements/[key]/brief-card.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/prd-card.tsx"
git commit -m "feat(web): 需求详情侧栏「简报」区块；「关联已有 PRD」不接受简报编号

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: 端到端测试（从需求新建、头部与正文、闸口、转 PRD 与互链、Markdown、简报页签、模板设置，1440 与 760）

**Files:**
- Modify: `apps/web/e2e/helpers.ts`
- Create: `apps/web/e2e/briefs.spec.ts`

**Interfaces:**
- Consumes: Task 9–13 的页面与接口
- Produces: `helpers.ts` 的 `createBrief(request, productId, data: { title: string; requirementIds?: string[] }): Promise<{ id: string; displayKey: string; version: number }>`

- [ ] **Step 1: 加 helper**

`apps/web/e2e/helpers.ts` 在 `createDocument` 之后加：

```ts
export async function createBrief(
  request: APIRequestContext,
  productId: string,
  data: { title: string; requirementIds?: string[] },
): Promise<{ id: string; displayKey: string; version: number }> {
  return (await json<{ document: { id: string; displayKey: string; version: number } }>(request.post(`/api/v1/orgs/acme/products/${productId}/briefs`, { data }))).document;
}
```

- [ ] **Step 2: 写端到端用例**

新建 `apps/web/e2e/briefs.spec.ts`：

```ts
import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createBrief, createMember, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

/**
 * 按模板写好的简报正文（虚构内容）：第 1–13 节各写结论（第 5、7、12 节写「不适用：理由」），第 8 节一条有证据与日期的现状，
 * 第 16 节一个不阻塞的问题；第 14 节放在最后，只写「不适用：」——闸口第 1 项因此不通过。
 */
function filledBrief(): string {
  const sections = [
    '## 1. 问题与目标\n\n上传失败率 3%，目标降到 1%。',
    '## 2. 数据依据\n\n近 30 天的上传日志。',
    '## 3. 受影响用户\n\n上传大文件的用户约 2 万人。',
    '## 4. 场景清单\n\n断点续传。',
    '## 5. 对象与状态\n\n不适用：只有上传任务一种对象。',
    '## 6. 规则与方案\n\n失败后自动重试三次。',
    '## 7. 计算口径与算法\n\n不适用：不涉及计数。',
    '## 8. 现状核对\n\n| # | 要核对的现状 | 结论 | 证据（仓库 文件:行号 / 提交号） | 核对日期 | 和他人说法的差异 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | 重试次数 | 目前不重试 | web/upload.ts:42 | 2026-10-10 | |',
    '## 9. 可行性与性能\n\n研发评估可行。',
    '## 10. 影响面与兼容\n\nWeb 与 PC 客户端。',
    '## 11. 用户感知与触达\n\n失败时提示正在重试。',
    '## 12. 商业与合规\n\n不适用：不涉及付费。',
    '## 13. 上线策略\n\n灰度 10%。',
    '## 15. 决策日志\n\n重试三次。',
    '## 16. 待定问题\n\n| # | 问题 | 选项 | 建议 | 待谁定 | 是否阻塞 PRD |\n| --- | --- | --- | --- | --- | --- |\n| 1 | 重试间隔 | 1 秒 / 3 秒 | 3 秒 | 后端 | 否 |',
    '## 17. 写 PRD 闸口\n\n见侧栏。',
    '## 18. 与 PRD 章节的对应\n\n见模板。',
    '## 14. 分工\n\n不适用：',
  ];
  return `${sections.join('\n\n')}\n`;
}

/** 在正文末尾输入一段文字，等自动保存的 PUT 返回。 */
async function typeAtEnd(page: Page, docId: string, text: string) {
  const saved = page.waitForResponse((r) => r.url().endsWith(`/documents/${docId}/content`) && r.request().method() === 'PUT');
  await page.getByRole('region', { name: '正文' }).locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  return saved;
}

test('从需求新建简报：头部信息、正文与闸口、转 PRD 与互链、复制与下载 Markdown；PRD 区块不接受简报编号', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '上传失败自动重试');
  await createRequirement(request, productId, '下载限速');
  await createMember(request, '决策人甲');
  await login(page, OWNER.email, OWNER.password);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/acme/requirements/PAN-1');
  const card = page.getByRole('region', { name: '简报', exact: true });
  await expect(card).toContainText('还没有简报');
  await card.getByRole('button', { name: '新建简报' }).click();
  const dialog = page.getByRole('dialog', { name: '新建简报' });
  await expect(dialog.getByLabel('标题')).toHaveValue('上传失败自动重试');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-B-1');
  await expect(page.getByRole('region', { name: '模板说明' })).toContainText('不是会议流水账');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('1. 问题与目标');
  const side = page.getByRole('complementary');
  await expect(side.getByRole('region', { name: '状态' })).toContainText('讨论中');
  await expect(side.getByRole('region', { name: '覆盖的需求' })).toContainText('PAN-1');

  // 头部信息：版本、决策人、参与方、关联文档
  const header = side.getByRole('region', { name: '头部信息' });
  await header.getByLabel('版本').fill('v0.2');
  await header.getByLabel('版本').press('Enter');
  await header.getByRole('combobox', { name: '决策人' }).click();
  await page.getByRole('option', { name: '决策人甲' }).click();
  await expect(header.getByRole('combobox', { name: '决策人' })).toHaveText('决策人甲');
  await header.getByRole('button', { name: '参与方' }).click();
  await page.getByRole('checkbox', { name: '开发' }).click();
  await page.keyboard.press('Escape');
  await expect(header).toContainText('开发');
  await header.getByLabel('引用或网址').fill('PAN-2');
  await header.getByLabel('说明').fill('相关需求');
  await header.getByRole('button', { name: '添加' }).click();
  await expect(header.getByRole('list', { name: '关联文档' }).getByRole('link', { name: 'PAN-2' })).toHaveAttribute('href', '/acme/requirements/PAN-2');

  // 正文：接口写入按模板填好的内容后刷新；第 14 节只写了「不适用：」
  const brief = await json<{ document: { id: string; version: number } }>(request.get('/api/v1/orgs/acme/documents/PAN-B-1'));
  await ok(request.put(`/api/v1/orgs/acme/documents/${brief.document.id}/content`, { data: { baseVersion: brief.document.version, markdown: filledBrief() } }));
  await page.reload();
  await expect(header.getByLabel('版本')).toHaveValue('v0.2');
  const gate = side.getByRole('region', { name: '写 PRD 闸口' });
  await expect(gate).toContainText('2/11');
  await expect(gate.getByRole('listitem', { name: '闸口 1' })).toContainText('「14. 分工」写了「不适用」但没有写理由');
  await expect(gate.getByRole('listitem', { name: '闸口 7' }).getByLabel('通过')).toBeVisible();

  // 在编辑器里补上理由：自动保存后闸口第 1 项通过
  expect((await typeAtEnd(page, brief.document.id, '暂不涉及分工')).ok()).toBeTruthy();
  await expect(gate).toContainText('3/11');
  await expect(gate.getByRole('listitem', { name: '闸口 1' }).getByLabel('通过')).toBeVisible();

  // 人工勾选
  await gate.getByRole('checkbox', { name: '勾选闸口 2' }).click();
  await expect(gate).toContainText('4/11');
  await expect(gate.getByRole('listitem', { name: '闸口 2' })).toContainText(OWNER.name);

  // 复制与下载 Markdown
  const actions = side.getByRole('region', { name: '操作' });
  await actions.getByRole('button', { name: '复制为 Markdown' }).click();
  await expect(page.getByText('已复制 Markdown')).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('# PAN-B-1 上传失败自动重试');
  expect(copied).toContain('| 决策人 | 决策人甲 |');
  expect(copied).toContain('## 写 PRD 闸口（4/11）');
  const downloading = page.waitForEvent('download');
  await actions.getByRole('button', { name: '下载 .md' }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe('PAN-B-1.md');
  expect(await readFile(await file.path(), 'utf8')).toContain('## 正文');

  // 转 PRD：先列出没通过的闸口项，生成后跳到 PRD，两边互相链接
  await actions.getByRole('button', { name: '转 PRD' }).click();
  const conv = page.getByRole('dialog', { name: '转 PRD' });
  await expect(conv).toContainText('以下闸口项还没有通过');
  await expect(conv).toContainText('3. 第 3 节已估出影响人数和付费用户占比');
  await conv.getByRole('button', { name: '生成 PRD 草稿' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-1');
  const source = page.getByRole('note', { name: '来源简报' });
  await expect(source).toContainText('由简报 PAN-B-1 生成');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('来自简报第 1 节「问题与目标」');
  await expect(page.getByRole('complementary').getByRole('region', { name: '覆盖的需求' })).toContainText('PAN-1');
  await source.getByRole('link', { name: 'PAN-B-1' }).click();
  await page.waitForURL('**/acme/documents/PAN-B-1');
  await expect(side.getByRole('region', { name: '状态' })).toContainText('已转 PRD');
  await expect(actions).toContainText('已转为 PAN-PRD-1');

  // 再转：提示已有 PRD，可以打开或再生成；需求已在 PAN-PRD-1 上，结果里列出
  await actions.getByRole('button', { name: '转 PRD' }).click();
  await expect(conv).toContainText('这份简报已转为 PAN-PRD-1');
  await expect(conv.getByRole('link', { name: '打开 PAN-PRD-1' })).toBeVisible();
  await conv.getByRole('button', { name: '再生成一份新草稿' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-2');
  await expect(page.getByText('以下需求已挂在其他 PRD 上，没有覆盖：PAN-1（PAN-PRD-1）')).toBeVisible();

  // 需求详情的「简报」区块；「PRD」区块不接受简报编号
  await page.goto('/acme/requirements/PAN-1');
  const briefCard = page.getByRole('region', { name: '简报', exact: true });
  await expect(briefCard.getByRole('link', { name: /PAN-B-1/ })).toBeVisible();
  await expect(briefCard).toContainText('已转 PRD');
  await expect(briefCard).toContainText('闸口 4/11');
  await page.goto('/acme/requirements/PAN-2');
  const prdCard = page.getByRole('region', { name: 'PRD', exact: true });
  await prdCard.getByRole('button', { name: '关联已有 PRD' }).click();
  await prdCard.getByLabel('PRD 编号').fill('PAN-B-1');
  await prdCard.getByRole('button', { name: '关联' }).click();
  await expect(prdCard.getByRole('alert')).toContainText('请输入 PRD 编号，例如 PAN-PRD-1');
});

test('文档页「简报」页签：列表、状态与决策人筛选（写入地址栏）、新建；1440 与 760 下列表与详情不横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  const deciderId = await createMember(request, '决策人甲');
  const a = await createBrief(request, productId, { title: '上传提速' });
  const b = await createBrief(request, productId, { title: '下载限速' });
  await ok(request.patch(`/api/v1/orgs/acme/briefs/${a.id}`, { data: { deciderMemberId: deciderId } }));
  await ok(request.post(`/api/v1/orgs/acme/documents/${b.id}/transitions`, { data: { to: 'ready' } }));
  await login(page, OWNER.email, OWNER.password);

  await page.goto('/acme/documents');
  await page.getByRole('tab', { name: '简报' }).click();
  await page.waitForURL(/view=briefs/);
  const rowA = page.getByRole('row', { name: /PAN-B-1/ });
  const rowB = page.getByRole('row', { name: /PAN-B-2/ });
  await expect(rowA).toContainText('上传提速');
  await expect(rowA).toContainText('2/11');
  await expect(rowA).toContainText('决策人甲');
  await expect(rowB).toContainText('可写 PRD');

  await page.getByRole('combobox', { name: '状态' }).click();
  await page.getByRole('option', { name: '可写 PRD' }).click();
  await expect(page).toHaveURL(/status=ready/);
  await expect(rowB).toBeVisible();
  await expect(rowA).toHaveCount(0);

  await page.getByRole('combobox', { name: '状态' }).click();
  await page.getByRole('option', { name: '全部状态' }).click();
  await page.getByRole('combobox', { name: '决策人' }).click();
  await page.getByRole('option', { name: '决策人甲' }).click();
  await expect(page).toHaveURL(/decider=/);
  await page.reload();
  await expect(rowA).toBeVisible();
  await expect(rowB).toHaveCount(0);

  await page.getByRole('button', { name: '新建简报' }).click();
  const dialog = page.getByRole('dialog', { name: '新建简报' });
  await dialog.getByLabel('标题').fill('分享有效期');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-B-3');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('18. 与 PRD 章节的对应');

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/documents?product=PAN&view=briefs');
    await expect(page.getByRole('row', { name: /PAN-B-3/ })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto('/acme/documents/PAN-B-1');
    await expect(page.getByRole('complementary').getByRole('region', { name: '写 PRD 闸口' })).toContainText('2/11');
    await expectNoPageOverflow(page);
  }
});

test('模板设置：切换到简报模板，看到预置简报模板的必填小节与模板说明', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/templates');
  await expect(page.getByRole('row', { name: /变更 PRD（预置）/ })).toBeVisible();
  await page.getByRole('combobox', { name: '模板类型' }).click();
  await page.getByRole('option', { name: '简报模板' }).click();
  const row = page.getByRole('row', { name: /需求简报（预置）/ });
  await expect(row).toContainText('1. 问题与目标、2. 数据依据');
  await row.getByRole('button', { name: '编辑' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑模板' });
  await expect(dialog.getByLabel('模板说明')).toHaveValue(/不是会议流水账/);
  await expect(dialog.getByLabel('小节 18 标题')).toHaveValue('18. 与 PRD 章节的对应');
});
```

- [ ] **Step 3: 运行端到端测试**

Run: `pnpm --filter @flower/web e2e briefs.spec.ts documents-permissions.spec.ts documents-prd-flow.spec.ts documents.spec.ts`
Expected: 全部通过。失败时先看是定位器还是行为：BlockNote 把最后一段「不适用：」后面补的文字放进了新段落也算通过（第 14 节两行合起来有理由）；不要为迁就定位器修改共享组件。

- [ ] **Step 4: 提交**

```bash
git add apps/web/e2e/helpers.ts apps/web/e2e/briefs.spec.ts
git commit -m "test(web): 需求简报的端到端用例（新建、头部、闸口、转 PRD、Markdown、简报页签、模板设置，1440 与 760）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 性能测量命令加入简报用例

**Files:**
- Modify: `packages/migrate/src/perf.ts`
- Test: `packages/migrate/test/perf.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `listBriefs`；Task 7 的 `getBriefContext`；已有的 `buildPerfCases`、`measure`
- Produces: `buildPerfCases` 返回的用例末尾多两个：`简报：列表（全部产品）`、`简报：上下文（最近更新的简报）`（共 26 个）

- [ ] **Step 1: 改测试（先失败）**

`packages/migrate/test/perf.test.ts` 期望的用例名列表在 `'跟进：按负责人（在手最多的人）',` 之后加两项，长度改为 26：

```ts
      '跟进：按负责人（在手最多的人）',
      '简报：列表（全部产品）',
      '简报：上下文（最近更新的简报）',
    ]);
    const result = await measure(cases, 2);
    expect(result).toHaveLength(26);
```

Run: `pnpm --filter @flower/migrate exec vitest run test/perf.test.ts`
Expected: FAIL（用例名列表少两项）。

- [ ] **Step 2: 加用例**

`packages/migrate/src/perf.ts`：

1. `@flower/core` 的导入列表按字母顺序加入 `getBriefContext`、`listBriefs`。
2. 在 `const topTracked = …` 语句之后加：

```ts
  // 简报上下文：最近更新的一份（导入的数据没有简报时为空，用例直接返回）
  const latestBrief = (await listBriefs(db, actor))[0]?.id;
```

3. 返回数组末尾（`跟进：按负责人（在手最多的人）` 那一项之后）加：

```ts
    { name: '简报：列表（全部产品）', run: () => listBriefs(db, actor) },
    { name: '简报：上下文（最近更新的简报）', run: () => (latestBrief ? getBriefContext(db, actor, latestBrief) : Promise.resolve(null)) },
```

- [ ] **Step 3: 运行测试确认通过，类型检查并提交**

Run: `pnpm --filter @flower/migrate exec vitest run test/perf.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

```bash
git add packages/migrate/src/perf.ts packages/migrate/test/perf.test.ts
git commit -m "feat(migrate): 性能测量加入简报列表与上下文两个用例

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 16: 全量验证、开发库迁移与 SQL 核对、界面复验与性能（控制方）、验证记录与交接

**Files:**
- Create: `docs/p3c2-validation.md`
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

1. 迁移前记下基线（预期 766、203、`203|0`、21）：

```sql
select count(*) from requirements r join organizations o on o.id = r.org_id where o.slug = 'pan123' and r.deleted_at is null;
select count(*) from documents d join organizations o on o.id = d.org_id where o.slug = 'pan123' and d.deleted_at is null;
select count(*) filter (where kind = 'change'), count(*) filter (where kind <> 'change') from documents;
select count(*) from drizzle.__drizzle_migrations;
```

2. 执行迁移（同时把 `flower_app` 密码改回 `apps/web/.env.local` 的值）：

```bash
pnpm db:migrate
```

Expected: 执行 0021、0022 两个迁移，无报错。

3. 迁移记录、新表的行级安全与策略：

```sql
select count(*) from drizzle.__drizzle_migrations;
select relname, relrowsecurity from pg_class where relname = 'document_briefs';
select count(*) from pg_policies where tablename = 'document_briefs';
```

Expected: `23`；`document_briefs|t`；`1`。

4. 两个组织都补齐了预置简报模板，内容一致，18 个必填小节，有模板说明；PRD 模板不变：

```sql
select count(*), count(distinct org_id), count(distinct md5(body)), min(jsonb_array_length(sections)), min(length(guidance)) > 0
from document_templates where kind = 'brief' and product_id is null;
select count(*) from document_templates t, jsonb_array_elements(t.sections) s where t.kind = 'brief' and (s->>'required')::boolean;
select o.slug = 'pan123', count(*) filter (where t.kind = 'change'), count(*) filter (where t.kind = 'brief')
from organizations o left join document_templates t on t.org_id = o.id group by 1 order by 1;
```

Expected: `2|2|1|18|t`；`36`；`f|0|1`、`t|1|1`。

5. 编号索引与新列：

```sql
select indexname, indexdef from pg_indexes where tablename = 'documents' and indexname in ('documents_product_number', 'documents_product_brief_number') order by 1;
select p.brief_seq, p.document_seq from products p join organizations o on o.id = p.org_id where o.slug = 'pan123';
select count(*) from requirements where brief_document_id is not null;
select count(*) from document_briefs;
select column_name, is_nullable, column_default from information_schema.columns where table_name = 'document_templates' and column_name = 'guidance';
```

Expected: 两个索引，`documents_product_brief_number` 带 `WHERE (kind = 'brief'::text)`，`documents_product_number` 带 `WHERE (kind <> 'brief'::text)`；`0|203`；`0`；`0`；`guidance|NO|''::text`。

6. 原有数据不变：重跑第 1 条的四句 SQL，预期 766、203、`203|0`（迁移记录变为 23）。

任一项不符时停下来报告，先查 0021 的索引重建与 0022 的模板补齐语句。

- [ ] **Step 3: STOP——控制方在 pan123 上复验界面**

控制方在本地开发库（pan123）上启动开发服务器，以所有者账号（另开一个浏览器配置登录已有的测试成员「联调成员（测试）」看通知），在 1440px 与 760px 两种宽度下逐项检查，确认页面本身不横向滚动（正文里的宽表格在编辑器内横向滚动），把结论（只写现象与数量，不写姓名、标题与正文内容）交回：

1. **从需求新建**：选一条 PAN 的真实需求（处于设计中，还没有简报），需求详情侧栏「简报」区块 → 新建简报，标题自动带出 → 跳到 `PAN-B-1`；正文上方显示模板说明三条，正文按 18 节展开，表格可编辑；「覆盖的需求」里是这条需求。
2. **按模板写一份简报**：用这条需求的真实讨论结论逐节填写（不涉及的写「不适用：理由」），第 8 节写至少一条带证据与核对日期的现状，第 16 节写待定问题。自动保存正常；修订里有版本。
3. **头部信息**：版本、提出人、决策人（选「联调成员（测试）」）、参与方、作者、关联文档（一条 `[[PAN-PRD-n]]` 引用一份真实 PRD、一条外部网址）；刷新后保持；关联文档的引用能跳到那份 PRD。后台循环处理后（约 30 秒），测试成员的铃铛出现「把你设为简报决策人」。
4. **写 PRD 闸口**：自动项结果与正文一致（故意留空一节或只写「不适用：」时第 1 项列出原因，「定位到」能滚到该节；补上后刷新为通过）；第 8 节删掉一条证据时第 7 项列出行号；第 16 节把某个问题标「是」时第 10 项不通过，改回后通过；人工勾选 2–3 项，显示勾选人与时间，取消后恢复。进度与文档页列表里的「n/11」一致。
5. **复制与下载**：「复制为 Markdown」粘贴到文本编辑器，包含头部表、覆盖的需求、闸口与正文；「下载 .md」文件名为 `PAN-B-1.md`、内容相同；浏览器打开 `/api/v1/orgs/pan123/briefs/<简报 id>/context?format=json` 与页面一致。
6. **转 PRD**：「转 PRD」对话框列出未通过的闸口项 → 生成后跳到新 PRD（`PAN-PRD-204`）：正文第一行「由简报 PAN-B-1 生成」，各章节下注明来源小节，内容与简报对应小节一致（逐章对照第 18 节的对应表核对一遍）；顶部显示「由简报 PAN-B-1 生成」；覆盖的需求与简报相同（若这条需求原来已挂 PRD，则不覆盖并在提示里列出）；简报状态为「已转 PRD」，「操作」区块显示转出的 PRD；两边的「被引用」互相可见。再点「转 PRD」时提示已转为 `PAN-PRD-204`，「打开」能跳过去（不点「再生成」，免得多留一份草稿）。
7. **文档页「简报」页签**：列表显示编号、标题、状态、覆盖需求数、闸口进度、决策人、更新时间；按状态、决策人筛选写入地址栏，刷新后保持；「PRD 列表」不出现简报。
8. **需求详情与 PRD 区块**：需求详情「简报」区块显示编号、状态与闸口进度；在另一条需求的「PRD」区块「关联已有 PRD」里填 `PAN-B-1` 时提示填 PRD 编号。
9. **模板设置**：组织设置「文档模板」切换到「简报模板」，看到「需求简报（预置）」与 18 个必填小节、模板说明；不改动。

复验会在 pan123 留下一份简报、一份转出的 PRD 草稿（`document_seq` 变为 204）、相关领域事件与通知；写进验证记录第 6 节。

- [ ] **Step 4: STOP——控制方在 pan123 上测量性能**

在 Step 3 写出简报之后测（导入的数据里没有简报，先测上下文用例会直接返回）：

```bash
pnpm --filter @flower/migrate build && node --disable-warning=ExperimentalWarning --env-file=apps/web/.env.local packages/migrate/dist/cli.mjs perf --org-slug pan123 --owner-email <你的账号邮箱>
```

记录两个简报用例的 p50 / p95 / 最大值，以及「详情：轮流打开」（需求详情多读了所挂简报）的 p95。验收：p95 低于 300 毫秒（设计 §6）。超过时停下来报告慢在哪一步（可在本地临时给 `listBriefs`、`briefGatesTx` 各段计时，不提交）。

- [ ] **Step 5: 写验证记录**

新建 `docs/p3c2-validation.md`，结构与 `docs/p3c1-validation.md` 一致，包含：

1. 自动化测试数量（Step 1）。
2. 迁移核对（Step 2）：迁移记录数、`document_briefs` 的行级安全与策略、两个组织的预置简报模板（条数、内容一致、必填小节数、模板说明）、编号索引、新列默认值、需求数与文档数迁移前后，每项一行「预期 / 实际 / 结论」。
3. 界面复验（Step 3）：每项「通过 / 问题与处理 / 未验证」。
4. 性能（Step 4）：两个简报用例与需求详情的 p50 / p95 / 最大值与是否达标。
5. 已知限制与说明：闸口自动项按内置的小节标题与表头前缀判断（组织改了模板里这几节的标题或列名时，第 1 项会报缺少小节、第 7 与第 10 项找不到表格时不检查）；关联文档里的 `[[ ]]` 只按编号生成链接，不显示标题与状态，也不进「被引用」；`[[` 补全不列简报；转出的 PRD 不套 PRD 模板（章节按简报第 18 节）；再转时需求已在第一份 PRD 上，新草稿不覆盖需求；旧系统的需求简报（`requirement_briefs`）没有导入；另一个组织原本没有预置 PRD 模板，本次只补了简报模板。
6. 复验留下的测试数据：pan123 上的简报份数、转出的 PRD 份数、领域事件与通知条数（只写数量），以及下次 `--replace` 重导会把它们一并清除。
7. 人工验收清单（供用户试用）：从需求新建简报并按模板写完、头部信息、闸口的自动项与人工项、复制与下载 Markdown、上下文接口（只读 Token）、转 PRD 与再转、文档页「简报」页签与筛选、需求详情「简报」区块、模板设置里的简报模板、760px 宽度。

- [ ] **Step 6: 更新交接文档与协作日志**

`docs/handoff.md`：

1. 「关键文档」表在 P3-C1 三行之后加三行：`docs/superpowers/specs/2026-10-14-flower-p3c2-requirement-brief-design.md`（P3-C2 设计：需求简报，已确认）、`docs/superpowers/plans/2026-10-14-flower-p3c2-requirement-brief.md`（P3-C2 计划）、`docs/p3c2-validation.md`（P3-C2 迁移核对、性能与人工验收清单）。
2. 「当前进度」里「**P3-C1 工作跟进：已完成，待合并**（分支 `feat/p3c1-tracking`）」改为「**P3-C1 工作跟进：已完成，已合并（PR #18）**」。
3. 「当前进度」加一条「**P3-C2 需求简报：已完成，待合并**（分支 `feat/p3c2-requirement-brief`）」，写清：文档类型「简报」（`PAN-B-n`，按产品单独编号，`[[ ]]` 与链接卡支持）、预置简报模板（18 节必填、模板说明、组织可改、产品可覆盖）、头部结构化字段、覆盖需求、写 PRD 闸口（自动 3 项、人工 8 项，只作提示）、一键转变更 PRD 草稿（按第 18 节拼接，可再转）、复制 / 下载 Markdown 与只读上下文接口、文档页「简报」页签、需求详情「简报」区块、决策人「被指派」通知；迁移 0021、0022（`document_briefs` 开启 RLS，两个组织补齐预置简报模板）；性能结果；已知限制（验证记录第 5 节）。
4. 「下一步」改为：
   1. 合并 P3-C2（分支 `feat/p3c2-requirement-brief`）。
   2. 用户按 `docs/p3c2-validation.md` 第 7 节验收；P3-C1 见 `docs/p3c1-validation.md` 第 7 节，P3-B2、P3-B1、P3-A 见各自验证记录。
   3. P3-C3 周期汇总：完成清单、在推进与风险、进展摘录、数字与对比（周、月、季、半年、年；按产品经理、类型、产品）；导出与定时推送到群，推送规则是否接入 P3-C1、P3-C2 的新事件届时再定。
   4. 待规划：原型评审增值模块（可拆卸）——保留原第 4 条的说明不变。
   5. 原第 5 条（重导前先 `--dry-run`、重导后 `legacy rejoin`、重导会删除复验测试数据）保留，并把 P3-C2 复验留下的简报与转出的 PRD 加进去。

`docs/agent-log.md`「记录」最上面加一条（日期写实际完成日）：

```
### 2026-10-XX · 本地 · P3-C2 需求简报
- 分支 / PR：`feat/p3c2-requirement-brief`
- 做了什么：
  - 数据模型：`documents.kind` 加 `brief`，简报四个状态；`products.brief_seq` 与按类型拆开的编号唯一索引；新表 `document_briefs`（RLS）；`requirements.brief_document_id`；`document_templates.guidance`；迁移 0021（结构）与 0022（RLS、两个组织补齐预置简报模板）。
  - core：预置简报模板与闸口、转 PRD 对应表（`brief-template.ts`）；闸口判定、转 PRD 拼接、上下文 Markdown（`brief-model.ts`）；新建、头部、覆盖需求、闸口、列表、转 PRD、上下文（`briefs.ts`、`coverage.ts`）；文档系统按类型区分编号、详情、流转、链接卡与被引用；简报改状态不触发群推送；决策人「被指派」通知；需求详情带所挂简报。
  - 接口 `/orgs/:org/briefs`（列表、头部、闸口、转 PRD、上下文）、`/products/:id/briefs`、模板接口的 `kind`。
  - 页面：文档页「简报」页签与新建、简报详情（模板说明、头部信息、覆盖的需求、写 PRD 闸口、转 PRD、复制与下载 Markdown）、PRD 显示来源简报、需求详情「简报」区块、模板设置切换简报模板。
  - perf 命令加两个简报用例。
- 怎么验证的：（Step 1 的测试数；Step 2 的迁移核对；Step 3 的复验结论；Step 4 的性能）
- 留给对方：已知限制见 `docs/p3c2-validation.md` 第 5 节；下一步 P3-C3 周期汇总，之后规划原型评审增值模块。
```

- [ ] **Step 7: 提交**

```bash
git add docs/p3c2-validation.md docs/handoff.md docs/agent-log.md
git commit -m "docs: P3-C2 验证记录、迁移核对、交接进度与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 与设计、代码或数据的冲突

写计划时对照设计、代码与只读数据发现的不一致，以及本计划的处理：

| 设计说法或现状 | 实际情况 | 本计划的处理 |
|---|---|---|
| 设计 §3.6：「把简报各节内容依次放入 PRD 模板对应章节」 | 附录 A 第 18 节的 PRD 章节（2.5 状态表、3.3 计算规则、3.6 需求明细、3.7 站内信、4 技术约束、5 成功指标、6.1 依赖、6.2 开放问题、7 测试要点、客服 FAQ）不是 Flower 预置 PRD 模板的章节（变更记录 / 1 背景介绍 / 2 产品概述 / 3 需求说明），组织模板也可能被改过 | 转出的草稿按第 18 节生成固定章节（`BRIEF_TO_PRD`），为二、三级章节补「2. 产品概述」「3. 需求说明」「6. 依赖与开放问题」三个上级标题，「1. 背景介绍」「3. 需求说明」与预置模板的必填小节同名；草稿不套模板（`template_id` 为空，提交评审时不做必填小节检查）（Task 2、7） |
| 设计 §3.1：简报「按产品单独编号」 | `documents` 有唯一索引 `(product_id, number)`，变更 PRD 与模块文档共用 `products.document_seq`；按编号查文档、`[[ ]]` 解析、链接卡、被引用、小节补全都只按编号找 | 新列 `products.brief_seq`；唯一索引拆成「非简报」「简报」两个部分索引；`documentKeyOf` 统一显示编号；所有按编号的查找加类型条件（Task 1、3、5） |
| 设计 §3.4：「用法」三条「作为模板说明显示在编辑器顶部」 | `document_templates` 只有小节级的写作说明，没有模板级说明 | 新列 `document_templates.guidance`（≤ 2000 字），模板对话框可编辑；任何文档只要所用模板有说明，就显示在正文上方（PRD 预置模板为空，不显示）（Task 3、4、10、12） |
| 附录 A 头部表：「版本 v0.1（YYYY-MM-DD）」「状态」两行 | 设计 §3.3 把头部做成结构化字段，状态就是 `documents.status` | 头部表不进正文；`version` 默认 `v0.1`（日期由修订历史记录）；状态用文档状态切换（Task 2、3） |
| 附录 A 头部表：参与方「产品 / 后端 / 客户端 / 测试 / DBA / 商业化 / 客服 / 法务」 | 设计 §3.3 定为组织职能标签；新组织默认只有「产品经理」「设计」「开发」「测试」 | 参与方从组织现有的职能标签里选，缺的由组织管理员在组织设置里补；已删除的标签不再显示（Task 6、12） |
| 设计 §3.3：关联文档可以是「`[[ ]]` 引用」 | 链接卡与「被引用」来自正文与描述同步出的 `entity_links`；头部字段不在正文里，正文保存时会重建该来源的全部链接 | 头部的 `[[ ]]` 引用不写 `entity_links`：页面按编号生成站内链接（需求、PRD、简报、任务），不显示标题与状态，也不进对方的「被引用」（Task 10、12），写进验证记录第 5 节 |
| 设计 §5：「正文保存、状态、覆盖需求沿用现有文档事件」 | `document.status_changed` 是群推送可订阅的「PRD 状态变化」；站内通知的文案写死「PRD」 | 简报的 `document.status_changed` 在 payload 带 `kind: 'brief'`，事件规则匹配时跳过；站内通知按文档类型写「简报」或「PRD」（Task 5、8） |
| 设计 §3.5：自动项按第 1–14、8、16 节的内容判断 | 组织可以改简报模板（标题、表格列）；BlockNote 保存时会重排表格、改列表符号、加反斜杠，正文行与模板原文不再逐字相同 | 小节按内置标题找（去掉编号、反斜杠与空白），列按表头前缀找（结论 / 证据 / 核对日期 / 是否阻塞）；去掉模板原样内容时按「去掉 Markdown 符号与空白后」比较；找不到小节时该项不通过并说明，找不到表格时第 7、10 项不检查（Task 2），写进验证记录第 5 节 |
| 设计 §3.6：再转时「新草稿替换 `converted_document_id`」，PRD「覆盖与简报相同的需求（需求已挂其他 PRD 的跳过）」 | 第一次转换后这些需求已挂在第一份 PRD 上 | 再转生成的新草稿不覆盖任何需求，结果里逐条列出（编号与所在 PRD）；原 PRD 与它覆盖的需求保留（Task 7） |
| 设计 §3.6：PRD 顶部显示「由简报 {key} 生成」 | 再转后 `converted_document_id` 指向新草稿，旧 PRD 找不到来源 | 顶部提示只对当前转出的 PRD 显示；每份转出的 PRD 正文第一行都有「由简报 [[PAN-B-n]] 生成」，旧 PRD 仍在简报的「被引用」里（Task 2、5、12） |
| 设计 §4：文档页「新建简报」（产品、标题、可选覆盖需求） | 文档页按当前选中的产品显示，新建 PRD 对话框没有选需求的控件 | 产品取当前页的产品；对话框加「覆盖需求（选填）」按编号输入；从需求详情新建时直接覆盖那条需求（Task 11、13） |
| 设计 §3.1：`[[ ]]` 语法与链接卡支持 `PAN-B-n` | `[[` 补全只列需求、PRD、任务、迭代、节点 | 本期只做解析与链接卡（手写 `[[PAN-B-n]]` 照常成为链接卡）；补全不列简报（Task 1、5），写进验证记录第 5 节 |
| 设计 §1、§6：不导入历史数据 | 旧系统 123plane 有 `requirement_briefs` 表（迁移工具的读取只统计条数） | 不导入；写进验证记录第 5 节 |
| 数据现状：另一个组织没有产品，也没有预置 PRD 模板 | 迁移 0022 只补简报模板 | 两个组织各补一份预置简报模板；预置 PRD 模板的缺失保持原样（组织管理员可在设置页添加）（Task 3、16） |
| 设计 §6：pan123 上测简报列表与上下文的性能 | 导入的数据里没有简报，上下文用例会直接返回 | 控制方先在界面复验里写出一份真实简报，再跑 perf（Task 15、16） |
| 设计 §3.3：作者「默认创建人」 | Token 背后可能是 Agent 成员；转 PRD 时负责人须为在职真人 | 新建时作者照记创建人（含 Agent），之后可改为真人；转 PRD 时作者已离开或是 Agent 则新 PRD 不设负责人（Task 5、7） |
| 需求详情「PRD」区块的「关联已有 PRD」 | 它按编号取文档再调文档的「关联需求」接口；接口现在按文档类型分别处理，填简报编号会把需求挂到简报上 | 「关联已有 PRD」只接受变更 PRD，填简报编号时提示「请输入 PRD 编号，例如 PAN-PRD-1」（Task 13、14） |

## P3-C2 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm --filter @flower/web e2e`、`./scripts/smoke.sh` 全部通过；本地开发库执行 0021、0022 后，SQL 核对与预期一致（`document_briefs` 的 RLS 与策略、两个组织的预置简报模板、编号索引、需求数 766 与文档数 203 不变）。
- Review Focus 五类输入都有对应测试：编辑器保存格式与「不适用」（Task 2、14）；简报与 PRD 同号（Task 3、5、13、14）；推送与通知把简报当 PRD、决策人可见性（Task 5、6、8）；重复转换与部分覆盖、过长（Task 7、9、14）；可见范围与只读（Task 6、9）。
- 设计 §6 的验证都有对应测试：闸口自动三项（空小节、「不适用：理由」、阻塞问题、证据与日期列）（Task 2）；转 PRD 的拼接与需求覆盖（Task 2、7）；上下文导出格式（Task 2、7、9）；接口权限（组织管理员、产品管理员、编辑、只读、访客、只读 Token、限定产品的 Token）与看不到的产品的简报不出现在列表与上下文里（Task 6、9）；端到端的从需求新建、编辑头部与正文、闸口显示与勾选、转 PRD 跳转与互链、复制与下载 Markdown、1440 与 760（Task 14）；pan123 复验与性能（Task 15、16）。
- 不新增依赖；验证记录、交接文档与协作日志已更新（Task 16）。

## 自查

写完后对照设计逐条核对的结果：

| 设计条目 | 对应任务 |
|---|---|
| §1 范围：简报类型、预置模板、头部字段、覆盖需求、软闸口、转 PRD、Markdown 导出与上下文接口；不含周期汇总、AI 起草、MCP、代码仓库直连 | Task 1–15（没有汇总、AI、MCP 与仓库直连的代码；第 8 节证据手填） |
| §2 用户已确认的决定（顺序、形式、方案 A、对应关系、软闸口、Agent 上下文） | Task 2（模板）、3（方案 A 的表结构）、6（对应关系与闸口）、7（上下文） |
| §3.1 文档类型、编号 `{产品}-B-n`、`[[ ]]` 与链接卡、四个状态 | Task 1、3、5 |
| §3.2 `requirements.brief_document_id`，需求详情显示所挂简报，简报列出覆盖的需求可增删 | Task 3、6、8、12、13 |
| §3.3 头部表 `document_briefs`（RLS）各字段 | Task 3、5、6、12 |
| §3.4 预置模板（18 节必填、表格为初始内容、用法为模板说明、组织可改产品可覆盖、不预填人名、迁移补齐与新组织写入） | Task 2、3、4、10 |
| §3.5 软闸口（自动 1、7、10，人工 8 项记勾选人与时间可取消，侧栏显示原因并可定位，不阻止改状态与转 PRD） | Task 2、6、12 |
| §3.6 转 PRD（拼接注明来源、覆盖相同需求并列出跳过的、已转 PRD 与 `converted_document_id`、PRD 显示来源、再转可打开或新生成） | Task 2、7、12、14 |
| §3.7 Agent 上下文（导出内容、复制 / 下载、只读接口与两种格式） | Task 2、7、9、12 |
| §4 页面（文档页「简报」页签与筛选、两处新建、简报详情侧栏四部分、转 PRD 弹窗与互链、1440 与 760） | Task 11、12、13、14 |
| §5 权限、接口、事件、通知（被设为决策人「被指派」；新事件不接入群推送） | Task 4–9 |
| §6 迁移与验证（迁移内容、单元测试、接口测试、端到端、pan123 复验与性能） | Task 1–15、16 |

- 占位检查：计划中没有「待定」「以后实现」或只描述不给代码的步骤。`0021_*` 是 drizzle 生成的随机文件名，`2026-10-XX` 是协作日志条目的日期，`<你的账号邮箱>`、`<简报 id>` 是控制方执行时的输入，Task 16 的实际测量值与复验结论由控制方填写。
- 名称一致性：`BRIEF_STATUSES`、`BriefStatus`、`TEMPLATE_KINDS`、`TemplateKind`、`BriefRelatedLink`、`BriefGateCheck`、`briefDisplayKey`、`parseBriefKey`、`documentKeyOf`、`BRIEF_TRANSITIONS`、`documentTransitions`、`canTransition`、`BRIEF_SECTIONS`、`BRIEF_TEMPLATE`、`BRIEF_GATE_ITEMS`、`BRIEF_TO_PRD`、`BriefGateItem`、`BriefGate`、`evaluateBriefGate`、`briefToPrdMarkdown`、`BriefContext`、`briefContextMarkdown`、`documentBriefs`、`briefSeq`、`briefDocumentId`、`guidance`、`insertPresetBriefTemplate`、`BriefRow`、`BriefHeader`、`briefHeaderTx`、`insertNativeDocumentTx`、`loadBriefTx`、`briefRoleTx`、`createBrief`、`linkBriefRequirementsTx`、`BriefHeaderInput`、`BriefFilter`、`BriefListItem`、`briefGatesTx`、`getBriefGate`、`setBriefGateCheck`、`updateBrief`、`listBriefs`、`BriefConvertResult`、`convertBriefToPrd`、`getBriefContext`、`registerBriefRoutes`、`apiText`、`briefKeys`、`useBriefs`、`useBriefGate`、`briefsHref`、`BriefListFilter`、`parseBriefFilter`、`briefFilterToSearch`、`briefFilterToApiQuery`、`gateLabel`、`briefFileName`、`convertMessage`、`parseRelatedInput`、`relatedLinkHref`、`CreateBriefDialog`、`BriefsTab`、`CoveredRequirements`、`BriefSidePanel`、`BriefHeaderCard`、`BriefGateCard`、`BriefActionsCard`、`BriefCard`、`createBrief`（e2e helper，与 core 同名但在 `apps/web/e2e/helpers.ts`，不经 `@flower/core` 导出）在定义与使用处一致。
- 依赖顺序：Task 2 用 Task 1；Task 3 用 Task 1、2；Task 4 用 Task 2、3；Task 5 用 Task 1、3、4；Task 6 用 Task 2、5；Task 7 用 Task 2、5、6；Task 8 用 Task 5、6；Task 9 用 Task 4–7；Task 10 用 Task 9 的接口与 core 类型；Task 11–13 用 Task 10（Task 13 用 Task 11 的新建对话框）；Task 14 用 Task 11–13；Task 15 用 Task 6、7；Task 16 收尾。
- 包入口：`documents/brief-template`、`brief-model`（Task 2）、`brief-header`、`briefs`（Task 5）加入 `src/index.ts`；新导出名与已有导出不重名（写计划时已检索 `packages/core/src` 中的 `export`，只有 `requirements/lookups.ts` 的 `IterationBrief` 与本计划的名字相近、不冲突）。页面不从 `@flower/core` 导入任何值，只用浏览器安全子路径的 `BRIEF_STATUSES`、`DOCUMENT_STATUS_LABELS`、`CHANGE_DOCUMENT_STATUSES`、`classifyTarget`。
