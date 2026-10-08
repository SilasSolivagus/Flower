# Flower P1-C 界面测试后的修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-09-30 在 pan123 上做界面测试时发现的问题：旧数据人员映射（一个字段写了多人、头衔与昵称写法、代签写法、工具账号），经用户确认后重导 pan123；全部成员选择框换成可搜索的共享组件；甘特任务表与窄宽度（约 800px）下的布局；迭代详情的页签写入地址栏；在迭代的「发布版本」页签一次关联多条需求。最后在 pan123 上复验并更新文档。

**Architecture:** 不新增表、不新增迁移。人员规则全部在 `packages/migrate`：`normalize.ts` 负责拆分与解析写法，新文件 `people.ts` 负责生成人员对照表（拆掉多人条目、合并头衔 / 昵称 / 短名 / 邮箱前缀写法、识别工具账号），`mapping.ts` 的 `Resolver.people` 在导入时把一个原始写法解析为一个或多个成员，`PlanContext.memberId` / `memberIds` 分别处理单值与多值字段，对账报告增加三节供审阅；新增 `rejoin` 命令在重导后让测试账号重新加入组织。页面侧新增共享组件 `components/member-picker.tsx`（Popover + 搜索框 + listbox，纯逻辑在 `features/members/model.ts`），替换 8 个文件里的 9 处成员选择；布局用固定列宽、表格容器内横向滚动、粘性列和响应式栅格修复，并用 Playwright 在 1440 与 800 宽度下做边界框与可见性断言；迭代详情页签由 `?tab=` 决定；core 新增 `linkRequirementsToRelease` 与对应接口，发布版本页签加批量关联对话框。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui（Radix）、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§2.1 成员、§2.3 Agent 是 `kind = agent` 的成员、§4.2 需求分配与会签、§4.4 任务的 `assignee_member_id` 为单值、§6.1 领域事件、§7.1 演练 → 核对报告 → 修正规则 → 再执行、§7.2 人员对照表、§7.3「同一字段中写了多名负责人的情况，也在人员对照表中处理」「会签代签」）。范围由用户在 2026-09-30 界面测试后批准（控制方简报第 1–7 项），逐条决定见下方「设计决定」。

## Global Constraints

- 生产数据副本、对照表、对账报告、测试账号清单只放在 `.local-data/`（已在 `.git/info/exclude` 忽略），任何含员工姓名或邮箱的文件不得提交。测试夹具、端到端用例、文档示例只用虚构姓名和 `@example.com` 邮箱；验证记录只写数量与耗时，不写姓名、邮箱或需求标题。
- 迁移写库只针对本地开发库的组织 pan123。`--replace` 会删除 pan123 的全部数据，只能在 Task 4 的用户检查点得到用户明确同意之后执行。
- 本计划不新增表，也不新增迁移。执行中如发现必须改表结构或加索引，停下来报告。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`，一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写；写操作同事务调用 `recordEvent`，修改类事件 payload 带 `changes: [{field, old, new}]`。`withSystem` 只用于登录、成员关系查找、Token 认证、邀请接受。
- 权限按 spec §2.2：产品编辑及以上可以增删改需求、迭代、任务、发布版本及其关联；只读成员只读。产品内写操作用 `requireProductRole(tx, actor, productId, 'editor' | 'admin')`。只读 Token 在 `capByScope` 中被降为 viewer，写操作自动拒绝。
- 同时锁迭代和需求（或任务）时，先锁迭代、后锁其他行（B1 审查结论，本计划不新增这类写操作）。
- 面向用户的文案与错误信息用中文，错误通过 `AppError(code, message, details?)` 抛出。
- `apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`。纯逻辑放 `apps/web/src/features/**/model.ts` 并写 Vitest 单测。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`。用渲染期间调整（参照 `apps/web/src/app/(app)/[org]/settings/general/page.tsx`），或用 `key` 让组件在来源变化时重新挂载；能直接从地址栏或服务端数据推导的值不存进组件状态。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框和内联表单用 `silentError: true` + `<FormError error={mutation.error} />`。不留未处理的 `mutateAsync` 拒绝。
- 页面加载失败统一用 `components/load-error.tsx` 的 `LoadError` / `QueryError`。
- 复用已有的共享件：`components/load-error.tsx`；e2e `helpers.ts`（`ok`、`json`、`createProduct`、`createRequirement`、`createMember`、`createIteration`、`createTask`、`applyReviewWorkflow`、`setupInstance`、`login`、`FAIL_500`，本计划再加 `expectNoPageOverflow`、`textFits`）；成员相关的 `canListMembers`、`activePeople`（`features/members/model.ts`，本计划再加 `pickerOptions`、`filterPickerOptions`）；本计划新增的 `components/member-picker.tsx` 是全部成员选择的唯一实现。不在文件之间复制逻辑块。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0`（CI 已加入，零错误零警告）。
- 视觉沿用 P0-B：表格行高 40px 且单行（`h-10`，单元格不换行），隔行底色 `even:bg-zebra`、编号与日期用等宽字体（`font-mono`）、卡片圆角 6px、按钮与输入框圆角 4px、页面标题 20px。
- 布局：页面本身不出现横向滚动；内容超宽的表格只在自己的容器里横向滚动；抽屉固定在视口内。布局改动必须有 Playwright 守护用例，在 1440 与 800 两个宽度下断言（边界框不重叠、`toBeInViewport`、`expectNoPageOverflow`）。如果 `expectNoPageOverflow` 在列出的修复之后仍然失败，在用例里临时执行下面的片段找出超出视口的元素，用同样的手段（`flex-wrap`、`min-w-0`、容器内滚动）修掉，并在任务报告里写明改了哪里：

  ```ts
  console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 10).map((el) => `${el.tagName}.${el.className}`.slice(0, 160))));
  ```

- 端到端测试：每个 spec 自己在 `beforeEach` 或用例开头调用 `resetDatabase()`；不为迁就定位器修改应用或共享组件代码；Radix 弹出内容（含 `MemberPicker` 的选项）用 `page` 定位；名字互为子串的控件（例：「负责人」与「阻塞项负责人」）用 `exact: true` 或先限定区域；断言「重试」一类由 5xx 触发的界面时加 `{ timeout: 15_000 }`；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染。改动共享组件或页面结构的任务，要在同一任务里改好受影响的现有 spec，不削弱原有断言。端到端占用 3100 端口，不要与 `pnpm dev` 同时运行。
- `pnpm test` 和端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；之后要跑 `pnpm dev`、迁移导入或 `rejoin`，先执行 `pnpm db:migrate`。
- 每个 commit message 末尾加一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）；实际执行提交的若不是 Claude Opus 5.5，把这一行换成实际模型的名字。

## 设计决定

pan123 的数量均为 2026-09-30 只读查询开发库与 `.local-data/mapping/people.json` 所得。开发库 pan123 当时共 127 个成员（对照表 124 条 + 3 个测试账号），简报中的 128 与 24 是估计值，以下以实查为准。

| 项 | 决定 | 依据 |
|---|---|---|
| 范围 | 做简报第 1–6 项：人员映射修复与重导、可搜索的成员选择、甘特任务表布局、窄宽度布局、迭代页签写入地址栏、发布版本批量关联需求；第 7 项（甘特到人员负载的入口）不做，见下方单独一行 | 用户 2026-09-30 批准的界面测试结论 |
| 多人写法的拆分 | 顿号、中英文逗号、斜杠、分号，以及两个汉字之间的空白都算分隔（`splitNames`）。拆分在导入时由 `Resolver.people` 做：原始写法整体是某人的别名时不拆，否则逐个解析；人员对照表不再为多人写法建条目，旧版对照表里的多人条目（没有邮箱、每个写法都能拆成多人）在 `suggest` 时删除 | pan123：26 个多人成员（其中 3 个含空格分隔），全部来自 push 甘特任务的概览负责人（`ov_assignee`），被 30 条任务引用，这 30 条任务的 `assignee` 都为空，每条写了 2–11 人。拆开后只有 1 个名字此前不是成员，建为新成员 |
| 单值字段写了多人 | 需求负责人、提出人、任务负责人、事件操作人取第一人（按原文顺序）；其余保留原文：负责人在 `legacyMeta.*.coOwners`（P1-A 已有），提出人新增 `legacyMeta.*.coRequesters`，任务在 `meta.ovAssignee`（P1-A 已有）；全部列入对账报告「人员拆分」一节 | `tasks.assignee_member_id` 是单值（spec §4.4）。把一条任务拆成每人一条会产生各自可编辑、进度会分叉的副本，push 本身也把它当作概览上的一行。受影响的是上面的 30 条任务；需求的负责人、提出人里各有 1 处多人原文，此前已按第一人导入 |
| 多值字段写了多人 | 开发分配（`requirement_assignments`）与会签签字（`check_item_signoffs`）每人一条；第一个人沿用原来的行 id，其余在 id 键后加 `:序号` | 这两类字段的语义就是多人。pan123 目前没有这类写法（0 处），规则按字段语义定，数据出现时不需要再改代码 |
| 头衔与昵称写法 | 「头衔-姓名(昵称)」「头衔-姓名」「姓名（昵称）」在姓名是 2–4 个汉字时解析（`parsePersonName`）。有本名条目的并入本名，原写法和昵称成为别名；没有本名条目、显示名仍是原写法的，改用姓名作显示名。头衔不写入成员 | pan123：14 个（12 个带头衔、2 个带昵称），13 个并入已有成员、1 个改名；另有 1 个头衔后是拉丁字母的写法不解析。`members.department` 的语义是部门，头衔不是部门，原写法保留在别名里可以追溯 |
| 由合并派生的写法 | 同一写法已是另一成员的写法时并入（例：单独出现的昵称）；两个汉字的短名与唯一一个三字姓名的后两字相同时并入；与唯一一个人的邮箱前缀相同的拉丁写法并入该人。后两条只在显示名仍是原始写法时使用 | pan123：单独出现的昵称 1 个；短名 4 个（1 个是单独成员，3 个只出现在多人写法里）；邮箱前缀 1 个。同音错字与只有拼音的写法无法可靠判断，不自动合并（各 1 例），在 Task 4 检查点交给用户决定 |
| 保留用户编辑 | 删除、合并、改名只作用于「没有邮箱、没有标 `keep`、不是会签角色指向、不是 Agent」的条目；并入用户已有的条目时只追加别名，不改其职能标签与出现次数；改名只在显示名仍等于某个原始写法时发生。`PersonEntry` 新增两个可选字段：`kind`（缺省为 `human`）与 `keep`（为 `true` 时 `suggest` 不拆、不并这一条，例如用户确认某个多人写法是一个小组） | 简报要求 `suggestMapping` 保留用户编辑（现有行为）；现有对照表里「饶总」别名、会签角色映射等是用户编辑，必须保留 |
| 代签写法 | 「代X by Y」在会签以外的字段（push 变更记录的 `edited_by`）按实际操作人 Y 解析，作为领域事件的操作人，原写法写入事件 payload 的 `editedBy`；不建成员。会签里的代签维持 P1-A 的做法：`signer_member_id` = 被代签人，`acted_by_member_id` = Y | pan123：2 个代签写法成员，只被 13 条状态变更事件引用。会签中的 68 处代签已按 `acted_by_member_id` 导入，不受影响 |
| 工具账号 | 没有邮箱、形如「小写字母-小写字母数字」（`AGENT_NAME`）的名字建为 Agent 成员（`kind = agent`），不给职能标签；成员选择框只列在职真人（`activePeople`），因此不会出现 | pan123：2 个（同步程序：21 条变更事件；AI 预审模型：22 条预审结果）。spec §2.3：Agent 是 `kind = agent` 的成员；建为 Agent 保留审计来源，排除则这些事件和预审结果会失去操作人 |
| 未自动处理的写法 | 角色词或占位写法（例：客户、用户、财务）仍按人导入，不改规则 | pan123：10 个。是否并入某人、保留或以后另行处理，由用户在 Task 4 检查点决定（在 `people.json` 加别名或 `keep`） |
| 对账报告 | 「人员」表增加「类型」列；新增「人员拆分」「人员合并」「代签写法」三节 | 检查点需要让用户逐条审阅拆分与合并 |
| 重导后的测试账号 | migrate 新增 `rejoin` 命令：以所有者身份 `createInvitation`，再以该账号 `acceptInvitation`，然后恢复职能标签；账号清单放 `.local-data/test-accounts.json`（邮箱、组织角色、职能标签，不含密码） | `--replace` 会删除 pan123 的全部成员关系（3 个测试账号：1 个组织管理员、2 个带「设计」标签的成员），账号本身不删。走正常的邀请流程和审计事件；不经过浏览器，不需要输入密码；每次重导后都能重复执行 |
| 成员选择框 | 新增共享组件 `MemberPicker`（Popover + 搜索框 + listbox）：按姓名、邮箱、部门过滤，忽略大小写与空白，姓名以关键词开头的排前面，方向键与回车选择；触发按钮仍是 `role="combobox"`，选项仍是 `role="option"`。替换 8 个文件里的 9 处：需求详情的负责人与提出人、新建需求的提出人、阻塞项负责人、分配成员、甘特任务负责人、人员负载的成员、需求列表的负责人筛选、流程会签的「指定成员」 | 简报第 2 项；pan123 选项 100+，Radix Select 的首字母跳转对中文姓名无效。不引入 cmdk 依赖。成员设置页的抽屉里没有成员选择框（只有角色、状态、职能），不涉及 |
| 甘特任务表列宽 | 表格 `table-fixed`，每列固定宽度，总宽 1472px，超出时在表格容器内横向滚动；进度、工期、延期三个数字输入框加宽到 80px；行保持 `h-10` 单行 | 简报第 3 项。原来「需求 / 任务」列没有宽度，1180px 的最小宽度减去其余固定列只剩约 60px，128px 的别名输入框溢出到负责人列。工期、延期的输入框同样装不下「12.5」，一并加宽 |
| 窄宽度 | 成员页的筛选栏允许换行；评审表的展开与编号列固定在左侧（`sticky`）；发布版本表的操作列固定在右侧；工作台在 1280px 以下单列。抽屉本来就是 `fixed`，页面不再被撑宽后即在视口内 | 简报第 4 项。800px 时侧边导航占 240px，内容区约 496px。浏览器面板窄于 768px 时按手机模拟，布局视口会扩到页面宽度，这就是抽屉「开到屏幕外」的原因，因此守护以 `document.documentElement.scrollWidth ≤ clientWidth` 为准 |
| 迭代详情页签 | 页签只由地址栏 `?tab=` 决定（`requirements` 时省略参数），切换时 `router.replace`；未开始迭代的 `scope` 和不认识的值回到「需求」 | 简报第 5 项。页签不存进组件状态，也就没有需要同步的状态；`replace` 不给每次切换都加一条历史，离开后再后退仍回到原页签 |
| 批量关联需求 | core 新增 `linkRequirementsToRelease`（一次 1–200 条，必须同产品，已关联的跳过，每条新关联记一条 `requirement.release_linked` 事件，任一条不合法时整批不写入），单条的 `linkRequirementRelease` 改为调用它；`ReleaseView` 增加 `requirementIds`；接口 `POST /orgs/:org/releases/:id/requirements`；发布版本页签每行加「关联需求」对话框，候选为本迭代里同产品的需求 | 简报第 6 项，减少 `docs/p1b-comparison.md` 列出的多余步骤 |
| 甘特到人员负载的入口 | 不加 | 甘特页「团队负载」热力图里的姓名已经链接到人员负载页并带上该成员，与迭代列表的「人员负载」按钮步数相同（都是 4 步），再加一个链接不减少步数 |
| 留给后续阶段 | 角色词写法的统一处理；任务支持多个负责人（需要改表）；评审表筛选写入地址栏（P1-B2 已列） | 本计划的最小实现边界 |

## 文件结构

```
packages/migrate/
  src/normalize.ts                 # splitNames 增加汉字之间的空白；parsePersonName（Task 1）
  src/people.ts                    # 新文件：collectPersonMentions（从 suggest.ts 移入）、suggestPeople、AGENT_NAME、合并规则（Task 1）
  src/suggest.ts                   # 删除人员部分，改为调用 people.ts（Task 1）
  src/mapping.ts                   # PersonEntry.kind / keep（Task 1）；Resolver.people、proxies（Task 2）
  src/plan-types.ts                # memberId / memberIds、报告的 personSplits / personMerges / proxies、people.kind（Task 2）
  src/plan-base.ts                 # 成员 kind、人员合并清单（Task 2）
  src/plan-requirements.ts         # 负责人 / 提出人按原文解析、分配与签字每人一条、变更记录 editedBy（Task 2）
  src/plan.ts  src/report.ts       # 代签写法清单；报告三节与类型列（Task 2）
  src/rejoin.ts  src/cli.ts        # rejoin 命令（Task 3）
  test/fixtures.ts                 # messyLegacyData、reviewedMapping(data)（Task 1）
  test/normalize.test.ts  test/people.test.ts                 # Task 1
  test/mapping.test.ts  test/plan-requirements.test.ts  test/report.test.ts   # Task 2
  test/rejoin.test.ts              # Task 3
packages/core/
  src/releases/releases.ts  test/releases.test.ts             # 批量关联、requirementIds（Task 10）
apps/web/
  src/features/members/model.ts  model.test.ts                # pickerOptions、filterPickerOptions（Task 5）
  src/components/member-picker.tsx                            # 共享成员选择框（Task 5）
  src/app/(app)/[org]/requirements/[key]/fields-panel.tsx  blockers.tsx  assignments.tsx
  src/app/(app)/[org]/requirements/create-dialog.tsx          # Task 5
  src/app/(app)/[org]/iterations/[id]/task-row.tsx  src/app/(app)/[org]/workload/page.tsx
  src/app/(app)/[org]/requirements/page.tsx  src/features/workflow/components/check-items.tsx   # Task 6
  src/app/(app)/[org]/iterations/[id]/gantt-tab.tsx  task-row.tsx                             # 列宽（Task 7）
  src/app/(app)/[org]/settings/members/page.tsx  src/app/(app)/[org]/reviews/page.tsx
  src/app/(app)/[org]/iterations/[id]/releases-tab.tsx  src/app/(app)/[org]/page.tsx          # 窄宽度（Task 8）
  src/features/iterations/model.ts  model.test.ts  src/app/(app)/[org]/iterations/[id]/page.tsx   # 页签（Task 9）；linkCandidates（Task 10）
  src/app/(app)/[org]/iterations/[id]/link-requirements-dialog.tsx  src/server/routes/releases.ts  test/api/iterations.test.ts   # Task 10
  e2e/helpers.ts                   # expectNoPageOverflow、textFits（Task 7）
  e2e/member-picker.spec.ts        # 新文件（Task 5、6）
  e2e/gantt.spec.ts  e2e/workflows.spec.ts                    # Task 6、7
  e2e/layout.spec.ts               # 新文件（Task 8）
  e2e/iterations.spec.ts           # Task 9、10
CLAUDE.md                          # rejoin 命令（Task 3）
docs/p1b-comparison.md             # 批量关联的步数（Task 10）
docs/p1b-validation.md  docs/handoff.md  docs/agent-log.md    # Task 11
```

---
### Task 1: 迁移：人员对照表的拆分、合并与工具账号（`normalize.ts`、新文件 `people.ts`）

**Files:**
- Modify: `packages/migrate/src/normalize.ts`（`splitNames` 增加汉字之间的空白；新增 `parsePersonName`）
- Create: `packages/migrate/src/people.ts`（`collectPersonMentions` 从 `suggest.ts` 原样移入；`AGENT_NAME`、`suggestPeople` 与合并规则）
- Modify: `packages/migrate/src/suggest.ts`（删除人员部分，改为从 `people.ts` 导入 `suggestPeople`）
- Modify: `packages/migrate/src/mapping.ts`（`PersonEntry` 增加可选的 `kind`、`keep`）
- Modify: `packages/migrate/test/fixtures.ts`（`messyLegacyData()`；`reviewedMapping(data?)`）
- Test: `packages/migrate/test/normalize.test.ts`、`packages/migrate/test/people.test.ts`（新文件）

**Interfaces:**
- Consumes: 现有 `aliasKey`、`legacyUuid`、`parseProxySigner`、`BOSS_ROLE`、`SIGNOFF_ROLE_TAG`
- Produces:
  - `normalize.ts`：`splitNames(s: S | undefined): string[]`（分隔符：`、 , ， / ; ；` 以及两个汉字之间的空白）；`parsePersonName(raw: string): { name: string; title: string | null; nickname: string | null }`（不带头衔也不带昵称、或姓名不是 2–4 个汉字时返回 `{ name: raw.trim(), title: null, nickname: null }`）
  - `people.ts`：`AGENT_NAME: RegExp`；`collectPersonMentions(data: LegacyData)`；`suggestPeople(data: LegacyData, existing: Mapping['people'] | null): Mapping['people']`
  - `mapping.ts`：`PersonEntry.kind?: 'human' | 'agent'`、`PersonEntry.keep?: boolean`；`suggest` 生成的每一条都带 `kind`
  - `test/fixtures.ts`：`messyLegacyData(): LegacyData`；`reviewedMapping(data: LegacyData = makeLegacyData()): Mapping`（Task 2 使用）

- [ ] **Step 1: 写失败的测试**

`packages/migrate/test/normalize.test.ts`：

1. import 改为：

```ts
import { addDays, aliasKey, normTitle, parseJsonArray, parseLegacyDate, parseLegacyTime, parsePersonName, splitNames, splitPlatforms } from '../src/normalize';
```

2. 在 `describe('归一化', …)` 的 `it('拆分多人与多平台写法', …)` 之后加入：

```ts
  it('两个汉字之间的空白也算多人分隔，其他空白不拆', () => {
    expect(splitNames('王五、赵六 钱七')).toEqual(['王五', '赵六', '钱七']);
    expect(splitNames('王五 、 赵六  、、 钱七')).toEqual(['王五', '赵六', '钱七']);
    expect(splitNames('Alex Chen')).toEqual(['Alex Chen']);
    expect(splitNames('代饶总 by 张三')).toEqual(['代饶总 by 张三']);
  });

  it('解析「头衔-姓名(昵称)」「姓名（昵称）」；姓名不是 2–4 个汉字时原样返回', () => {
    expect(parsePersonName('产品经理-李四(小李)')).toEqual({ name: '李四', title: '产品经理', nickname: '小李' });
    expect(parsePersonName('运营-孙八')).toEqual({ name: '孙八', title: '运营', nickname: null });
    expect(parsePersonName('周小雨（雨雨）')).toEqual({ name: '周小雨', title: null, nickname: '雨雨' });
    expect(parsePersonName(' 王五 ')).toEqual({ name: '王五', title: null, nickname: null });
    expect(parsePersonName('市场-Amy')).toEqual({ name: '市场-Amy', title: null, nickname: null });
    expect(parsePersonName('data-sync')).toEqual({ name: 'data-sync', title: null, nickname: null });
  });
```

`packages/migrate/test/fixtures.ts`：

1. 把

```ts
/** 模拟用户审阅后的对照表：会签角色"饶总"指向王老板，业务域"会员"并入"会员与支付"。 */
export function reviewedMapping(): Mapping {
  const data = makeLegacyData();
  const m = suggestMapping(data, null);
```

替换为：

```ts
/** 带人员问题的旧数据（全部为虚构姓名）：一个字段写了多人、头衔与昵称写法、两字短名、邮箱前缀、代签写法、工具账号。 */
export function messyLegacyData(): LegacyData {
  const data = makeLegacyData();
  data.plane.users.push({ id: 'u4', email: 'zhouxiaoyu@example.com', name: '周小雨', nickname: null, role: 'member', created_at: '2026-03-01 00:00:00' });
  data.plane.requirements[0]!.requester = '客户甲、客户乙';
  data.plane.requirements.push(
    planeReq({ id: 'X004', title: '头衔写法', requester: '产品经理-李四(小李)', owner: '张三', created_at: '2026-03-04T08:00:00Z' }),
    planeReq({ id: 'X005', title: '昵称写法', requester: '小李', owner: '张三', created_at: '2026-03-05T08:00:00Z' }),
    planeReq({ id: 'X006', title: '只有头衔写法', requester: '运营-孙八', owner: '张三', created_at: '2026-03-06T08:00:00Z' }),
  );
  data.plane.requirementDevelopers.push({ id: 'd3', requirement_id: 'X002', platform: null, developer: '王五、赵六', created_at: null });
  data.plane.subtasks.push({ id: 's2', requirement_id: 'X001', title: '短名写法', status: 'todo', assignee: '小雨', created_at: '2026-03-04T00:00:00Z', updated_at: null });
  data.push.ganttTasks.push({ ...data.push.ganttTasks[0]!, id: 3, title: '多人任务', assignee: '', ov_assignee: '王五、赵六 钱七' });
  data.push.designSignoffs[2] = { ...data.push.designSignoffs[2]!, state: '通过', by: '张三、李四', at: '2026-03-04 00:00:00' };
  data.push.changeLog.push(
    { id: 2, entity_type: 'requirement', entity_id: '1', field: 'status', old_value: '评审中', new_value: '已通过', edited_by: '代饶总 by 张三', edited_at: '2026-03-05 00:00:00' },
    { id: 3, entity_type: 'requirement', entity_id: '1', field: 'prd_url', old_value: null, new_value: 'https://example.com/prd', edited_by: 'data-sync', edited_at: '2026-03-05 00:00:00' },
    { id: 4, entity_type: 'requirement', entity_id: '1', field: 'priority', old_value: 'P0', new_value: 'P1', edited_by: 'lisi', edited_at: '2026-03-06 00:00:00' },
  );
  data.push.autoReviews[0]!.reviewed_by = 'model-v4-flash';
  return data;
}

/** 模拟用户审阅后的对照表：会签角色"饶总"指向王老板，业务域"会员"并入"会员与支付"。 */
export function reviewedMapping(data: LegacyData = makeLegacyData()): Mapping {
  const m = suggestMapping(data, null);
```

（函数其余部分不变。）

新建 `packages/migrate/test/people.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { type PersonEntry, Resolver } from '../src/mapping';
import { suggestMapping } from '../src/suggest';
import { makeLegacyData, messyLegacyData } from './fixtures';

describe('人员对照表：多人写法、头衔与昵称、非人员写法', () => {
  const m = suggestMapping(messyLegacyData(), null);
  const r = new Resolver(m);
  const names = m.people.people.map((p) => p.displayName);

  it('多人写法不建成一个人；拆出的新名字单独建为成员，并按出现位置建议职能标签', () => {
    expect(names.filter((n) => /[、,，/;；]/.test(n) || /\p{Script=Han}\s+\p{Script=Han}/u.test(n))).toEqual([]);
    expect(r.person('钱七')).toMatchObject({ displayName: '钱七', kind: 'human', functionTags: ['开发'] });
  });

  it('头衔与昵称写法并入本人，昵称成为别名', () => {
    const lisi = r.person('李四')!;
    expect(r.person('产品经理-李四(小李)')?.key).toBe(lisi.key);
    expect(r.person('小李')?.key).toBe(lisi.key);
    expect(names).not.toContain('产品经理-李四(小李)');
    expect(names).not.toContain('小李');
  });

  it('只有头衔写法、没有本名条目时改用姓名作显示名', () => {
    expect(r.person('运营-孙八')?.displayName).toBe('孙八');
    expect(r.person('孙八')?.displayName).toBe('孙八');
  });

  it('两字短名并入唯一的三字姓名；邮箱前缀并入该邮箱的人', () => {
    expect(r.person('小雨')?.displayName).toBe('周小雨');
    expect(r.person('lisi')?.displayName).toBe('李四');
  });

  it('代签写法只算实际操作人，不建成员；工具名建为 Agent，不给职能标签', () => {
    expect(names.filter((n) => n.startsWith('代'))).toEqual([]);
    expect(r.person('data-sync')).toMatchObject({ kind: 'agent', functionTags: [] });
    expect(r.person('model-v4-flash')).toMatchObject({ kind: 'agent', functionTags: [] });
    expect(r.person('张三')?.kind).toBe('human');
  });
});

describe('人员对照表：读取旧版对照表', () => {
  it('删掉旧版的多人条目、合并头衔条目；标了 keep 的条目与用户改过的显示名保留', () => {
    const old = suggestMapping(makeLegacyData(), null);
    const entry = (key: string, displayName: string, over: Partial<PersonEntry> = {}): PersonEntry => ({
      key, displayName, email: null, orgRole: 'member', productRole: null, functionTags: ['开发'], aliases: [displayName], mentions: 1, ...over,
    });
    old.people.people.push(entry('p_old_team', '王五、赵六'), entry('p_old_kept', '王五、钱七', { keep: true }), entry('p_old_title', '产品经理-李四(小李)', { functionTags: [] }));
    // 旧版对照表没有 kind 字段
    for (const p of old.people.people) delete p.kind;
    old.people.people.find((p) => p.displayName === '王五')!.displayName = '王五（后端）';

    const m = suggestMapping(messyLegacyData(), old);
    const r = new Resolver(m);
    const keys = m.people.people.map((p) => p.key);
    expect(keys).not.toContain('p_old_team');
    expect(keys).toContain('p_old_kept');
    expect(keys).not.toContain('p_old_title');
    expect(r.person('王五、钱七')?.key).toBe('p_old_kept');
    expect(r.person('产品经理-李四(小李)')?.displayName).toBe('李四');
    expect(r.person('王五')?.displayName).toBe('王五（后端）');
    expect(m.people.people.every((p) => p.kind === 'human' || p.kind === 'agent')).toBe(true);
    expect(m.people.signoffRoles).toEqual(old.people.signoffRoles);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/migrate exec vitest run test/normalize.test.ts test/people.test.ts`
Expected: FAIL：`parsePersonName` 不存在；`splitNames('王五、赵六 钱七')` 只拆出两段；对照表里有「王五、赵六 钱七」「产品经理-李四(小李)」「代饶总 by 张三」这类条目，没有 `kind`。

- [ ] **Step 3: 实现**

`packages/migrate/src/normalize.ts`：把

```ts
export const splitNames = (s: S | undefined): string[] =>
  (s ?? '').split(/[、,，/;；]+/).map((x) => x.trim()).filter(Boolean);
```

替换为：

```ts
/** 一个字段写了多人：顿号、中英文逗号、斜杠、分号，以及两个汉字之间的空白都算分隔。 */
export const splitNames = (s: S | undefined): string[] =>
  (s ?? '').split(/[、,，/;；]+|(?<=\p{Script=Han})\s+(?=\p{Script=Han})/u).map((x) => x.trim()).filter(Boolean);

/**
 * 带头衔或昵称的写法：「头衔-姓名(昵称)」「头衔-姓名」「姓名（昵称）」。
 * 姓名是 2–4 个汉字时才解析；既没有头衔也没有昵称、或姓名不是汉字时原样返回。
 */
export function parsePersonName(raw: string): { name: string; title: string | null; nickname: string | null } {
  const t = raw.trim();
  const m = /^(?:([^-－—]+?)\s*[-－—]\s*)?(\p{Script=Han}{2,4})\s*(?:[（(]\s*([^（）()]+?)\s*[）)])?$/u.exec(t);
  if (!m || (!m[1] && !m[3])) return { name: t, title: null, nickname: null };
  return { name: m[2]!, title: m[1]?.trim() || null, nickname: m[3]?.trim() || null };
}
```

`packages/migrate/src/mapping.ts`：把 `PersonEntry` 替换为：

```ts
export type PersonEntry = {
  key: string;
  displayName: string;
  email: string | null;
  /** 缺省为 human；工具、同步程序等建为 agent（成员 kind = agent）。 */
  kind?: 'human' | 'agent';
  /** 为 true 时 suggest 不拆分、不合并这一条（例如用户确认某个多人写法是一个小组）。 */
  keep?: boolean;
  orgRole: 'admin' | 'member' | 'guest';
  productRole: 'admin' | 'editor' | 'viewer' | null;
  functionTags: string[];
  aliases: string[];
  mentions: number;
};
```

新建 `packages/migrate/src/people.ts`（`collectPersonMentions` 与 `Mention` 从 `suggest.ts` 原样移入）：

```ts
import { legacyUuid } from './ids';
import type { LegacyData } from './legacy-types';
import type { Mapping, PersonEntry } from './mapping';
import { aliasKey, parsePersonName, splitNames } from './normalize';
import { BOSS_ROLE, parseProxySigner, SIGNOFF_ROLE_TAG } from './workflow-v1';

type Mention = { raw: string; email: string | null; role: 'owner' | 'developer' | 'requester' | 'signer' | 'other'; signoffRole?: string };

/** 工具或同步程序的名字：小写字母开头、用连字符连接的小写字母数字串（例：`data-sync`、`model-v4-flash`）。 */
export const AGENT_NAME = /^[a-z][a-z0-9.]*(?:-[a-z0-9.]+)+$/;
const HAN2 = /^\p{Script=Han}{2}$/u;
const HAN3 = /^\p{Script=Han}{3}$/u;
const LATIN_LOGIN = /^[a-z][a-z0-9._]*$/;

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
const emailUser = (email: string) => email.split('@')[0]!.toLowerCase();
const writtenForms = (p: PersonEntry) => [p.displayName, ...p.aliases, ...(p.email ? [p.email] : [])];

function addAliases(p: PersonEntry, aliases: string[]): void {
  for (const a of aliases) if (a.trim() && !p.aliases.some((x) => aliasKey(x) === aliasKey(a))) p.aliases.push(a);
}

/** 可以被删除或并入别人的条目：没有邮箱、没有标 keep、不是会签角色指向的人、不是 Agent。 */
function absorbable(p: PersonEntry, roleKeys: Set<string>): boolean {
  return !p.email && !p.keep && !roleKeys.has(p.key) && p.kind !== 'agent';
}

/**
 * 给一个可并入的条目找目标，按顺序：
 * 1. 某个写法是「头衔-姓名(昵称)」「姓名（昵称）」，按姓名找到别人（昵称一并作为别名）；
 * 2. 某个写法已经是别人的写法；
 * 3. 两个汉字的短名，与唯一一个三字姓名的后两字相同；
 * 4. 拉丁字母写法与唯一一个人的邮箱前缀相同。
 * 3、4 只在显示名仍是原始写法（没被用户改过）时使用。多个候选时优先有邮箱的、再按出现次数。
 */
function mergeTarget(e: PersonEntry, people: PersonEntry[]): { into: PersonEntry; extra: string[] } | null {
  const others = people.filter((p) => p !== e && p.kind !== 'agent');
  const holders = (s: string) => others.filter((p) => writtenForms(p).some((a) => aliasKey(a) === aliasKey(s)));
  const pick = (list: PersonEntry[]) => [...list].sort((a, b) => Number(!!b.email) - Number(!!a.email) || b.mentions - a.mentions)[0];
  for (const a of e.aliases) {
    const parsed = parsePersonName(a);
    if (parsed.name === a.trim()) continue;
    const into = pick(holders(parsed.name));
    if (into) return { into, extra: parsed.nickname ? [parsed.nickname] : [] };
  }
  for (const a of e.aliases) {
    const into = pick(holders(a));
    if (into) return { into, extra: [] };
  }
  if (!e.aliases.includes(e.displayName)) return null;
  if (HAN2.test(e.displayName)) {
    const hits = others.filter((p) => HAN3.test(p.displayName) && p.displayName.endsWith(e.displayName));
    if (hits.length === 1) return { into: hits[0]!, extra: [] };
  }
  if (LATIN_LOGIN.test(e.displayName)) {
    const hits = others.filter((p) => !!p.email && emailUser(p.email) === e.displayName);
    if (hits.length === 1) return { into: hits[0]!, extra: [] };
  }
  return null;
}

/**
 * 反复合并直到没有变化。并入本次新建的条目时合并职能标签与出现次数；并入用户已有的条目时只追加写法。
 * 没有目标、但写法带头衔或昵称且显示名仍是这个写法的，改用姓名作显示名。
 */
function mergeVariants(people: PersonEntry[], roleKeys: Set<string>, fresh: Set<PersonEntry>): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of people) {
      if (!absorbable(e, roleKeys)) continue;
      const target = mergeTarget(e, people);
      if (target) {
        addAliases(target.into, [e.displayName, ...e.aliases, ...target.extra]);
        if (fresh.has(target.into)) {
          target.into.mentions += e.mentions;
          for (const t of e.functionTags) if (!target.into.functionTags.includes(t)) target.into.functionTags.push(t);
        }
        people.splice(people.indexOf(e), 1);
        changed = true;
        break;
      }
      const titled = e.aliases.map(parsePersonName).find((p, i) => p.name !== e.aliases[i]!.trim() && e.displayName === e.aliases[i]);
      if (titled) {
        e.displayName = titled.name;
        addAliases(e, [titled.name, ...(titled.nickname ? [titled.nickname] : [])]);
        changed = true;
      }
    }
  }
}

export function suggestPeople(data: LegacyData, existing: Mapping['people'] | null): Mapping['people'] {
  const people: PersonEntry[] = existing ? existing.people.map((p) => ({ ...p, aliases: [...p.aliases], functionTags: [...p.functionTags] })) : [];
  const signoffRoles: Record<string, string> = { ...(existing?.signoffRoles ?? {}) };
  const roleKeys = () => new Set(Object.values(signoffRoles));
  for (const p of people) p.kind ??= !p.email && AGENT_NAME.test(p.displayName) ? 'agent' : 'human';
  // 旧版对照表把「甲、乙」这类多人写法建成了一个人：删掉这种条目，导入时由 Resolver 逐个解析
  for (const p of people.filter((x) => absorbable(x, roleKeys()) && x.aliases.length > 0 && x.aliases.every((a) => splitNames(a).length > 1))) {
    people.splice(people.indexOf(p), 1);
  }

  const byAlias = new Map<string, PersonEntry>();
  const index = (p: PersonEntry) => {
    for (const a of writtenForms(p)) byAlias.set(aliasKey(a), p);
  };
  people.forEach(index);
  const nameToEmail = new Map<string, string>();
  for (const u of [...data.plane.users, ...data.prd.users]) if (u.name) nameToEmail.set(aliasKey(u.name), u.email.trim().toLowerCase());
  const planeUser = new Map(data.plane.users.map((u) => [u.email.trim().toLowerCase(), u]));
  const usedKeys = new Set(people.map((p) => p.key));
  const uniqueKey = (base: string) => {
    let k = base;
    for (let i = 2; usedKeys.has(k); i++) k = `${base}_${i}`;
    usedKeys.add(k);
    return k;
  };
  const fresh = new Set<PersonEntry>();

  function addPerson(name: string, email: string | null): PersonEntry {
    const user = email ? planeUser.get(email) : undefined;
    const p: PersonEntry = {
      key: uniqueKey(email ? `p_${localPart(email)}` : `p_${legacyUuid('person', name).slice(0, 8)}`),
      displayName: user?.name ?? name,
      email,
      kind: !email && AGENT_NAME.test(name) ? 'agent' : 'human',
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

  for (const m of collectPersonMentions(data)) {
    if (m.signoffRole === BOSS_ROLE && m.raw === BOSS_ROLE) {
      if (!signoffRoles[BOSS_ROLE]) {
        const p = byAlias.get(aliasKey(BOSS_ROLE)) ?? addPerson(BOSS_ROLE, null);
        signoffRoles[BOSS_ROLE] = p.key;
      }
      continue;
    }
    // 「代X by Y」出现在会签以外的字段（例如变更记录）时，只是 Y 的一次操作
    const raw = parseProxySigner(m.raw)?.actor ?? m.raw;
    const parts = byAlias.has(aliasKey(raw)) ? [raw] : splitNames(raw);
    for (const part of parts) {
      const email = (parts.length === 1 ? m.email : null) ?? nameToEmail.get(aliasKey(part)) ?? null;
      let p = byAlias.get(aliasKey(part)) ?? (email ? byAlias.get(aliasKey(email)) : undefined);
      if (!p) p = addPerson(part.includes('@') ? part.split('@')[0]! : part, email);
      if (!p.aliases.some((a) => aliasKey(a) === aliasKey(part))) {
        p.aliases.push(part);
        index(p);
      }
      if (fresh.has(p)) {
        p.mentions += 1;
        const tag =
          p.kind === 'agent'
            ? undefined
            : m.role === 'owner'
              ? '产品经理'
              : m.role === 'developer'
                ? '开发'
                : m.role === 'signer' && m.signoffRole
                  ? SIGNOFF_ROLE_TAG[m.signoffRole]
                  : undefined;
        if (tag && !p.functionTags.includes(tag)) p.functionTags.push(tag);
      }
    }
  }

  mergeVariants(people, roleKeys(), fresh);
  for (const p of fresh) p.functionTags.sort();
  return { people, signoffRoles };
}
```

`packages/migrate/src/suggest.ts`：

1. 前 5 行 import 替换为：

```ts
import { legacyUuid } from './ids';
import type { LegacyData } from './legacy-types';
import type { IterationEntry, Mapping } from './mapping';
import { aliasKey, parseJsonArray, parseLegacyDate, splitPlatforms } from './normalize';
import { suggestPeople } from './people';
import { DEFAULT_PLATFORM_OPTIONS, KNOWN_PLATFORM_ALIASES } from './workflow-v1';
```

2. 删除从 `type Mention = …` 开始、到 `function suggestPeople(…)` 的结束大括号为止的全部代码（`collectPersonMentions`、`localPart`、`suggestPeople`，已移到 `people.ts`）。`suggestMapping` 里的 `people: suggestPeople(data, existing?.people ?? null)` 不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate test` 与 `pnpm typecheck`
Expected: 全部 PASS（`mapping.test.ts` 的「已有条目在重新生成时保留用户的修改」「代签写法拆成会签角色和实际操作人」等原有用例不改也通过；`plan-*.test.ts`、`write.test.ts`、`perf.test.ts` 用原夹具，结果不变）。

- [ ] **Step 5: 提交**

```bash
git add packages/migrate/src/normalize.ts packages/migrate/src/people.ts packages/migrate/src/suggest.ts packages/migrate/src/mapping.ts packages/migrate/test/fixtures.ts packages/migrate/test/normalize.test.ts packages/migrate/test/people.test.ts
git commit -m "feat(migrate): 人员对照表拆分多人写法，合并头衔、昵称、短名与邮箱前缀写法，工具账号建为 Agent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 迁移：导入时按单值 / 多值解析多人写法，代签写法按实际操作人，对账报告增加人员三节

**Files:**
- Modify: `packages/migrate/src/mapping.ts`（`Resolver.people`、`Resolver.proxies`；`person` 改为取 `people` 的第一个）
- Modify: `packages/migrate/src/plan-types.ts`（`ReconReport` 新增 `personSplits`、`personMerges`、`proxies`，`people` 增加 `kind`；`PlanContext.memberId` 记录拆分、新增 `memberIds`）
- Modify: `packages/migrate/src/plan-base.ts`（成员 `kind`；人员合并清单）
- Modify: `packages/migrate/src/plan-requirements.ts`（负责人、提出人按原文解析；`coRequesters`；开发分配与会签每人一条；变更记录 payload 带 `editedBy`）
- Modify: `packages/migrate/src/plan.ts`（代签写法清单）
- Modify: `packages/migrate/src/report.ts`（「人员」表的类型列；三节）
- Test: `packages/migrate/test/mapping.test.ts`、`packages/migrate/test/plan-requirements.test.ts`、`packages/migrate/test/report.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `splitNames`、`PersonEntry.kind`、`messyLegacyData()`、`reviewedMapping(data)`
- Produces:
  - `Resolver.people(raw: string | null | undefined): PersonEntry[]`：整体是某人的写法时返回这个人；「代X by Y」返回 Y 的解析结果并计入 `proxies`；否则按 `splitNames` 拆开逐个解析（未匹配的部分记入 `unmapped.people`）
  - `Resolver.proxies: Map<string, number>`（原写法 → 次数）
  - `PlanContext.memberId(raw)`：单值，取第一人；`PlanContext.memberIds(raw): string[]`：多值；两者在拆出多人时写 `report.personSplits`
  - `ReconReport.personSplits: Array<{ raw: string; people: string[]; singleRefs: number; multiRefs: number }>`、`personMerges: Array<{ key: string; displayName: string; variants: string[] }>`、`proxies: Array<{ raw: string; refs: number }>`；`people[].kind: 'human' | 'agent'`
  - 对账报告标题：`### 人员拆分（一个字段写了多人）`、`### 人员合并（一个成员的其他写法）`、`### 代签写法（按实际操作人导入）`；「人员」表列为 `key | 名称 | 类型 | 邮箱 | 组织角色 | 关联账号 | 出现次数`，类型为「人」或「Agent」

- [ ] **Step 1: 写失败的测试**

`packages/migrate/test/mapping.test.ts`：在 `describe('建议对照表', …)` 末尾（最后一个 `it` 之后、`});` 之前）加入：

```ts
  it('多人写法按人解析；代签写法按实际操作人解析并计数', () => {
    const r2 = new Resolver(m);
    expect(r2.people('王五、李四').map((p) => p.displayName)).toEqual(['王五', '李四']);
    expect(r2.people('王五 李四').map((p) => p.displayName)).toEqual(['王五', '李四']);
    expect(r2.person('李四、王五')?.displayName).toBe('李四');
    expect(r2.people('代饶总 by 张三').map((p) => p.displayName)).toEqual(['张三']);
    expect([...r2.proxies]).toEqual([['代饶总 by 张三', 1]]);
    expect(r2.people('王五、查无此人').map((p) => p.displayName)).toEqual(['王五']);
    expect([...r2.unmapped.people]).toEqual(['查无此人']);
  });
```

`packages/migrate/test/plan-requirements.test.ts`：

1. 第 4 行 import 改为：

```ts
import { makeLegacyData, messyLegacyData, planeReq, reviewedMapping } from './fixtures';
```

2. 文件末尾加入：

```ts
describe('导入计划：一个字段写了多人、代签写法、工具账号', () => {
  const data = messyLegacyData();
  const { rows, report } = buildImportPlan(data, reviewedMapping(data), OPTS);
  const member = (name: string) => rows.members.find((m) => m.displayName === name)!.id;
  const byLegacyKey = (key: string) => rows.requirements.find((r) => r.legacyKey === key)!;

  it('没有阻止写入的问题', () => {
    expect(report.problems).toEqual([]);
  });

  it('单值字段取第一人，其余保留原文并记入报告', () => {
    const x1 = byLegacyKey('X001');
    expect(x1.requesterMemberId).toBe(member('客户甲'));
    expect(x1.legacyMeta).toMatchObject({ plane: { coRequesters: ['客户乙'] } });
    expect(rows.tasks.find((t) => t.title === '多人任务')).toMatchObject({ assigneeMemberId: member('王五'), meta: expect.objectContaining({ ovAssignee: '王五、赵六 钱七' }) });
    expect(report.personSplits).toEqual(
      expect.arrayContaining([
        { raw: '客户甲、客户乙', people: ['客户甲', '客户乙'], singleRefs: 1, multiRefs: 0 },
        { raw: '王五、赵六 钱七', people: ['王五', '赵六', '钱七'], singleRefs: 1, multiRefs: 0 },
      ]),
    );
  });

  it('多值字段每人一条：开发分配与会签签字', () => {
    const x2 = byLegacyKey('X002');
    expect(rows.requirementAssignments.filter((a) => a.requirementId === x2.id).map((a) => a.memberId).sort()).toEqual([member('王五'), member('赵六')].sort());
    const x1 = byLegacyKey('X001');
    const design = rows.checkItemResults.find((c) => c.targetId === x1.id && c.itemKey === 'design_signoff')!;
    const rule2 = rows.checkItemSignoffs.filter((s) => s.resultId === design.id && s.signerRuleIndex === 2);
    expect(rule2.map((s) => s.signerMemberId).sort()).toEqual([member('李四'), member('张三')].sort());
    expect(new Set(rule2.map((s) => s.id)).size).toBe(2);
    expect(report.personSplits).toEqual(
      expect.arrayContaining([
        { raw: '王五、赵六', people: ['王五', '赵六'], singleRefs: 0, multiRefs: 1 },
        { raw: '张三、李四', people: ['张三', '李四'], singleRefs: 0, multiRefs: 1 },
      ]),
    );
  });

  it('变更记录里的代签写法：事件操作人是实际操作人，原写法保存在 payload；不建成员', () => {
    const ev = rows.domainEvents.find((e) => e.type === 'legacy.push.change' && (e.payload as { field?: string }).field === 'status')!;
    expect(ev).toMatchObject({ actorMemberId: member('张三'), payload: expect.objectContaining({ editedBy: '代饶总 by 张三' }) });
    expect(rows.members.filter((m) => m.displayName.startsWith('代'))).toEqual([]);
    expect(report.proxies).toEqual([{ raw: '代饶总 by 张三', refs: 1 }]);
  });

  it('工具账号导入为 Agent 成员，报告里标出类型', () => {
    expect(rows.members.find((m) => m.displayName === 'model-v4-flash')).toMatchObject({ kind: 'agent', accountId: null });
    expect(report.people.find((p) => p.displayName === 'data-sync')?.kind).toBe('agent');
    expect(report.people.find((p) => p.displayName === '张三')?.kind).toBe('human');
  });

  it('人员合并清单列出成员的其他写法', () => {
    const lisi = report.personMerges.find((x) => x.displayName === '李四')!;
    expect(lisi.variants).toEqual(expect.arrayContaining(['产品经理-李四(小李)', '小李', 'lisi']));
    expect(lisi.variants.some((v) => v.includes('@'))).toBe(false);
  });
});
```

`packages/migrate/test/report.test.ts`：

1. import 改为：

```ts
import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import { renderReport } from '../src/report';
import { makeLegacyData, messyLegacyData, reviewedMapping } from './fixtures';
```

2. 在现有 `it` 之后、`});` 之前加入：

```ts
  it('人员表带类型；列出人员拆分、合并与代签写法', () => {
    const data = messyLegacyData();
    const plan = buildImportPlan(data, reviewedMapping(data), { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null });
    const md = renderReport(plan.report);
    for (const heading of ['### 人员拆分（一个字段写了多人）', '### 人员合并（一个成员的其他写法）', '### 代签写法（按实际操作人导入）']) expect(md).toContain(heading);
    expect(md).toContain('| key | 名称 | 类型 | 邮箱 | 组织角色 | 关联账号 | 出现次数 |');
    expect(md).toContain('| p_lisi | 李四 | 人 | lisi@example.com |');
    expect(md).toMatch(/\| model-v4-flash \| Agent \|/);
    expect(md).toContain('| 王五、赵六 | 王五、赵六 | 0 | 1 |');
    expect(md).toMatch(/\| p_lisi \| 李四 \| [^\n]*产品经理-李四\(小李\)[^\n]*\|/);
    expect(md).toContain('| 代饶总 by 张三 | 1 |');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/migrate exec vitest run test/mapping.test.ts test/plan-requirements.test.ts test/report.test.ts`
Expected: FAIL：`r2.people` 不是函数；报告没有 `personSplits`；多人任务的负责人为空并有「人员对照表缺少：王五、赵六 钱七」一类问题；报告没有三节标题。

- [ ] **Step 3: 实现**

`packages/migrate/src/mapping.ts`：

1. 第 3 行 import 改为：

```ts
import { aliasKey, splitNames } from './normalize';
import { parseProxySigner } from './workflow-v1';
```

2. `Resolver` 里 `ignoredIterationRefs = 0;` 之后加入：

```ts
  /** 「代X by Y」写法按实际操作人 Y 解析的次数（按原写法计），写入对账报告。 */
  readonly proxies = new Map<string, number>();
```

3. 把 `person(raw)` 方法整体替换为：

```ts
  /**
   * 一个原始写法对应的成员：整体是某人的写法时返回这个人；「代X by Y」取实际操作人 Y；
   * 否则按多人写法拆开逐个解析。未匹配的写法记入 unmapped。
   */
  people(raw: string | null | undefined): PersonEntry[] {
    const t = raw?.trim();
    if (!t) return [];
    const whole = this.personByAlias.get(aliasKey(t));
    if (whole) return [whole];
    const proxy = parseProxySigner(t);
    if (proxy) {
      this.proxies.set(t, (this.proxies.get(t) ?? 0) + 1);
      return this.people(proxy.actor);
    }
    const parts = splitNames(t);
    if (parts.length < 2) {
      this.unmapped.people.add(t);
      return [];
    }
    const out: PersonEntry[] = [];
    for (const part of parts) for (const p of this.people(part)) if (!out.includes(p)) out.push(p);
    return out;
  }

  /** 单个成员：写了多人时取第一人。需要记录拆分的地方用 PlanContext.memberId / memberIds。 */
  person(raw: string | null | undefined): PersonEntry | null {
    return this.people(raw)[0] ?? null;
  }
```

`packages/migrate/src/plan-types.ts`：

1. 第 4 行 import 改为：

```ts
import { type Mapping, type PersonEntry, Resolver } from './mapping';
```

2. `ReconReport` 里把

```ts
  people: Array<{ key: string; displayName: string; email: string | null; orgRole: string; hasAccount: boolean; mentions: number }>;
```

替换为：

```ts
  people: Array<{ key: string; displayName: string; email: string | null; kind: 'human' | 'agent'; orgRole: string; hasAccount: boolean; mentions: number }>;
  /** 一个字段写了多人：单值字段取第一人，多值字段每人一条。 */
  personSplits: Array<{ raw: string; people: string[]; singleRefs: number; multiRefs: number }>;
  /** 一个成员的其他写法（别名，不含邮箱），供审阅合并是否正确。 */
  personMerges: Array<{ key: string; displayName: string; variants: string[] }>;
  /** 「代X by Y」写法，按实际操作人 Y 导入。 */
  proxies: Array<{ raw: string; refs: number }>;
```

3. 构造函数里 `people: [],` 之后加入：

```ts
      personSplits: [],
      personMerges: [],
      proxies: [],
```

4. 把 `memberId(raw)` 方法整体替换为：

```ts
  /** 单值引用（需求负责人、提出人、任务负责人、事件操作人）：写了多人时取第一人，拆分记入报告。 */
  memberId(raw: string | null | undefined): string | null {
    const people = this.resolver.people(raw);
    if (people.length > 1) this.noteSplit(raw!, people, 'single');
    return people[0] ? (this.memberIdByKey.get(people[0].key) ?? null) : null;
  }

  /** 多值引用（开发分配、会签签字人）：写了多人时每人一个，拆分记入报告。 */
  memberIds(raw: string | null | undefined): string[] {
    const people = this.resolver.people(raw);
    if (people.length > 1) this.noteSplit(raw!, people, 'multi');
    return people.map((p) => this.memberIdByKey.get(p.key)).filter((id): id is string => !!id);
  }

  private noteSplit(raw: string, people: PersonEntry[], kind: 'single' | 'multi'): void {
    const key = raw.trim();
    let row = this.report.personSplits.find((s) => s.raw === key);
    if (!row) {
      row = { raw: key, people: people.map((p) => p.displayName), singleRefs: 0, multiRefs: 0 };
      this.report.personSplits.push(row);
    }
    if (kind === 'single') row.singleRefs += 1;
    else row.multiRefs += 1;
  }
```

`packages/migrate/src/plan-base.ts`：

1. 第 2 行 import 改为：

```ts
import { aliasKey, parseLegacyDate, parseLegacyTime } from './normalize';
```

2. 成员循环里 `rows.members.push({…})` 中的 `kind: 'human',` 替换为 `kind: p.kind ?? 'human',`。

3. 同一循环里把

```ts
    ctx.report.people.push({ key: p.key, displayName: p.displayName, email: p.email, orgRole: isOwner ? 'owner' : p.orgRole, hasAccount: isOwner, mentions: p.mentions });
```

替换为：

```ts
    ctx.report.people.push({ key: p.key, displayName: p.displayName, email: p.email, kind: p.kind ?? 'human', orgRole: isOwner ? 'owner' : p.orgRole, hasAccount: isOwner, mentions: p.mentions });
    const variants = p.aliases.filter((a) => aliasKey(a) !== aliasKey(p.displayName) && !a.includes('@'));
    if (variants.length > 0) ctx.report.personMerges.push({ key: p.key, displayName: p.displayName, variants });
```

`packages/migrate/src/plan-requirements.ts`：

1. 逐条需求循环里删除这两行：

```ts
    const ownerNames = splitNames(plane ? plane.owner : push!.owner);
    const requesterNames = splitNames(plane ? plane.requester : push!.requester);
```

2. `rows.requirements.push({…})` 里把

```ts
      ownerMemberId: ctx.memberId(ownerNames[0]),
      requesterMemberId: ctx.memberId(requesterNames[0]),
```

替换为：

```ts
      ownerMemberId: ctx.memberId(plane ? plane.owner : push!.owner),
      requesterMemberId: ctx.memberId(plane ? plane.requester : push!.requester),
```

3. 同一个 `legacyMeta` 里，把 `coOwners: splitNames(plane.owner).slice(1),` 替换为：

```ts
            coOwners: splitNames(plane.owner).slice(1),
            coRequesters: splitNames(plane.requester).slice(1),
```

把

```ts
          push: { id: push.id, alias: push.alias, developers: parseJsonArray(push.developers), lastEditedBy: push.last_edited_by, coOwners: splitNames(push.owner).slice(1) },
```

替换为：

```ts
          push: {
            id: push.id,
            alias: push.alias,
            developers: parseJsonArray(push.developers),
            lastEditedBy: push.last_edited_by,
            coOwners: splitNames(push.owner).slice(1),
            coRequesters: splitNames(push.requester).slice(1),
          },
```

4. 会签循环里，把从 `const proxy = parseProxySigner(s.by);` 到 `signoffs.push({ signerRuleIndex: ruleIndex, decision, at });` 的整段替换为：

```ts
      const proxy = parseProxySigner(s.by);
      const onBehalfOf = proxy ? resolver.signoffRole(proxy.onBehalfOf) : null;
      // 一栏写了多人时每人一条签字；代签只有被代签的一个人
      const signerIds = proxy ? (onBehalfOf ? [ctx.memberIdByKey.get(onBehalfOf.key)!] : []) : ctx.memberIds(s.by);
      if (signerIds.length === 0) continue;
      const at = ctx.time(s.at, createdAt);
      const rule = designItem.signers![ruleIndex]!;
      signerIds.forEach((signerId, i) => {
        if (rule.by === 'member' && rule.ref !== signerId) mismatched += 1;
        rows.checkItemSignoffs.push({
          id: ctx.id('signoff', i === 0 ? `push:${s.id}` : `push:${s.id}:${i}`),
          orgId,
          resultId: designResultId,
          signerMemberId: signerId,
          actedByMemberId: proxy ? ctx.memberId(proxy.actor) : null,
          signerRuleIndex: ruleIndex,
          decision,
          note: s.opinion?.trim() || null,
          at,
        });
      });
      signoffs.push({ signerRuleIndex: ruleIndex, decision, at });
```

5. 「开发分配」一段整体替换为：

```ts
    // 开发分配（多值）：一栏写了多人时每人一条
    if (plane) {
      for (const d of data.plane.requirementDevelopers.filter((x) => x.requirement_id === plane.id)) {
        const memberIds = ctx.memberIds(d.developer);
        if (memberIds.length === 0) continue;
        const platformKey = d.platform ? resolver.platforms(d.platform)[0] : undefined;
        const platformOptionId = platformKey ? ctx.optionId('platform', platformKey) : null;
        memberIds.forEach((memberId, i) => {
          if (rows.requirementAssignments.some((a) => a.requirementId === id && a.memberId === memberId && a.platformOptionId === platformOptionId)) return;
          rows.requirementAssignments.push({
            id: ctx.id('assignment', i === 0 ? `plane:${d.id}` : `plane:${d.id}:${i}`),
            orgId,
            requirementId: id,
            memberId,
            functionTagId: ctx.tagIdByName.get('开发') ?? null,
            platformOptionId,
          });
        });
      }
    }
```

6. push 变更记录的事件里把

```ts
      payload: { schemaVersion: 1, source: 'push', entityType: c.entity_type, entityId: c.entity_id, field: c.field, oldValue: c.old_value, newValue: c.new_value },
```

替换为：

```ts
      payload: { schemaVersion: 1, source: 'push', entityType: c.entity_type, entityId: c.entity_id, field: c.field, oldValue: c.old_value, newValue: c.new_value, editedBy: c.edited_by },
```

（子任务与甘特任务的负责人已经走 `ctx.memberId`，不用改。）

`packages/migrate/src/plan.ts`：在 `for (const [label, set] of unmapped) …` 之后加入：

```ts
  report.proxies = [...resolver.proxies].sort((a, b) => a[0].localeCompare(b[0], 'zh')).map(([raw, refs]) => ({ raw, refs }));
```

`packages/migrate/src/report.ts`：把

```ts
    '## 人员',
    '',
    table(['key', '名称', '邮箱', '组织角色', '关联账号', '出现次数'], r.people.map((p) => [p.key, p.displayName, p.email ?? '', p.orgRole, p.hasAccount ? '是' : '', p.mentions])),
```

替换为：

```ts
    '## 人员',
    '',
    table(
      ['key', '名称', '类型', '邮箱', '组织角色', '关联账号', '出现次数'],
      r.people.map((p) => [p.key, p.displayName, p.kind === 'agent' ? 'Agent' : '人', p.email ?? '', p.orgRole, p.hasAccount ? '是' : '', p.mentions]),
    ),
    '### 人员拆分（一个字段写了多人）',
    '',
    '单值字段（需求负责人、提出人、任务负责人、事件操作人）取第一人；多值字段（开发分配、会签签字）每人一条。',
    '',
    table(['原写法', '拆成', '单值引用', '多值引用'], r.personSplits.map((s) => [s.raw, s.people.join('、'), s.singleRefs, s.multiRefs])),
    '### 人员合并（一个成员的其他写法）',
    '',
    table(['key', '名称', '其他写法'], r.personMerges.map((x) => [x.key, x.displayName, x.variants.join('、')])),
    '### 代签写法（按实际操作人导入）',
    '',
    table(['原写法', '次数'], r.proxies.map((x) => [x.raw, x.refs])),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate test` 与 `pnpm typecheck`
Expected: 全部 PASS。原有用例（「PAN-2：多负责人…」的 `coOwners`、会签的 `actedByMemberId`、「对账数量与延后项」的数量）不变；`write.test.ts` 按新的 `kind` 写库仍通过。

- [ ] **Step 5: 提交**

```bash
git add packages/migrate/src/mapping.ts packages/migrate/src/plan-types.ts packages/migrate/src/plan-base.ts packages/migrate/src/plan-requirements.ts packages/migrate/src/plan.ts packages/migrate/src/report.ts packages/migrate/test/mapping.test.ts packages/migrate/test/plan-requirements.test.ts packages/migrate/test/report.test.ts
git commit -m "feat(migrate): 导入时按单值与多值字段解析多人写法，代签写法按实际操作人，对账报告列出人员拆分、合并与代签

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 迁移：`rejoin` 命令，重导后让已有账号重新加入组织

**Files:**
- Create: `packages/migrate/src/rejoin.ts`
- Modify: `packages/migrate/src/cli.ts`（`rejoin` 命令；`perf` 与 `rejoin` 共用 `ownerActor`）
- Modify: `CLAUDE.md`（命令表加一行）
- Test: `packages/migrate/test/rejoin.test.ts`（新文件）

**Interfaces:**
- Consumes: `createInvitation`、`acceptInvitation`、`listFunctionTags`、`setMemberFunctionTags`、`accounts`、`resolveActor`（`@flower/core`）
- Produces:
  - `rejoin.ts`：`type RejoinEntry = { email: string; orgRole: 'admin' | 'member' | 'guest'; functionTags: string[] }`；`rejoinAccounts(db: Db, owner: Actor, entries: RejoinEntry[]): Promise<Array<{ email: string; memberId: string }>>`（先校验全部账号与职能标签，任何一个不存在就抛错且不写入）
  - CLI：`rejoin --org-slug <slug> --owner-email <邮箱> --accounts <json 路径>`（读取 `DATABASE_URL`），成功时输出「已重新加入组织 <slug>：N 个账号。」
  - Task 4 使用的账号清单文件 `.local-data/test-accounts.json`，格式为 `RejoinEntry[]`

- [ ] **Step 1: 写失败的测试**

新建 `packages/migrate/test/rejoin.test.ts`：

```ts
import { createAccount, listFunctionTags, listMembers } from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { seedInstance } from '@flower/core/testing/factories';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejoinAccounts } from '../src/rejoin';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

describe('重导后让已有账号重新加入组织', () => {
  it('发邀请并以该账号接受，恢复组织角色与职能标签；账号或标签不存在时不写入任何数据', async () => {
    const { owner } = await seedInstance(t.db);
    await createAccount(t.adminDb, { email: 'design-a@example.com', name: '设计甲', password: 'password123' });
    await createAccount(t.adminDb, { email: 'admin-b@example.com', name: '管理员乙', password: 'password123' });

    await expect(
      rejoinAccounts(t.db, owner, [
        { email: 'design-a@example.com', orgRole: 'member', functionTags: ['设计'] },
        { email: 'nobody@example.com', orgRole: 'member', functionTags: [] },
      ]),
    ).rejects.toThrow('找不到账号 nobody@example.com');
    await expect(rejoinAccounts(t.db, owner, [{ email: 'design-a@example.com', orgRole: 'member', functionTags: ['不存在的标签'] }])).rejects.toThrow(
      '组织里没有职能标签「不存在的标签」',
    );
    expect((await listMembers(t.db, owner)).some((m) => m.email === 'design-a@example.com')).toBe(false);

    const joined = await rejoinAccounts(t.db, owner, [
      { email: 'Design-A@example.com', orgRole: 'member', functionTags: ['设计'] },
      { email: 'admin-b@example.com', orgRole: 'admin', functionTags: [] },
    ]);
    expect(joined.map((j) => j.email)).toEqual(['design-a@example.com', 'admin-b@example.com']);
    const design = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!;
    const members = await listMembers(t.db, owner);
    expect(members.find((m) => m.email === 'design-a@example.com')).toMatchObject({ id: joined[0]!.memberId, hasAccount: true, orgRole: 'member', functionTagIds: [design.id] });
    expect(members.find((m) => m.email === 'admin-b@example.com')).toMatchObject({ hasAccount: true, orgRole: 'admin', functionTagIds: [] });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/migrate exec vitest run test/rejoin.test.ts`
Expected: FAIL，找不到模块 `../src/rejoin`。

- [ ] **Step 3: 实现**

新建 `packages/migrate/src/rejoin.ts`：

```ts
import { acceptInvitation, accounts, type Actor, createInvitation, type Db, listFunctionTags, setMemberFunctionTags } from '@flower/core';
import { eq } from 'drizzle-orm';

export type RejoinEntry = { email: string; orgRole: 'admin' | 'member' | 'guest'; functionTags: string[] };

/**
 * `import --replace` 会删掉组织的全部成员关系，账号本身保留。这里让这些账号重新加入：
 * 以所有者身份发邀请，再以该账号接受（走正常的邀请流程与审计事件，不经过浏览器、不需要密码），最后恢复职能标签。
 * 先校验全部账号与标签，任何一个不存在就不写入。
 */
export async function rejoinAccounts(db: Db, owner: Actor, entries: RejoinEntry[]): Promise<Array<{ email: string; memberId: string }>> {
  const tags = await listFunctionTags(db, owner);
  const plan: Array<{ email: string; orgRole: RejoinEntry['orgRole']; accountId: string; tagIds: string[] }> = [];
  for (const e of entries) {
    const email = e.email.trim().toLowerCase();
    const [acc] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, email));
    if (!acc) throw new Error(`找不到账号 ${email}`);
    const tagIds = e.functionTags.map((name) => {
      const tag = tags.find((x) => x.name === name);
      if (!tag) throw new Error(`组织里没有职能标签「${name}」`);
      return tag.id;
    });
    plan.push({ email, orgRole: e.orgRole, accountId: acc.id, tagIds });
  }
  const out: Array<{ email: string; memberId: string }> = [];
  for (const p of plan) {
    const { token } = await createInvitation(db, owner, { email: p.email, orgRole: p.orgRole });
    const { memberId } = await acceptInvitation(db, token, { accountId: p.accountId });
    if (p.tagIds.length > 0) await setMemberFunctionTags(db, owner, memberId, p.tagIds);
    out.push({ email: p.email, memberId });
  }
  return out;
}
```

`packages/migrate/src/cli.ts`：

1. import 部分改为：

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { accounts, type Actor, createDb, type Db, listProducts, resolveActor } from '@flower/core';
import { eq } from 'drizzle-orm';
import type { LegacyData } from './legacy-types';
import { loadPlane, loadPrd, loadPush } from './load';
import { readMapping, writeMapping } from './mapping';
import { buildImportPlan } from './plan';
import { buildPerfCases, measure } from './perf';
import { type RejoinEntry, rejoinAccounts } from './rejoin';
import { renderReport } from './report';
import { suggestMapping } from './suggest';
import { writeImport } from './write';
```

2. `USAGE` 里 `perf …` 那一行之后加入一行：

```
  rejoin --org-slug pan123 --owner-email 邮箱 --accounts <账号清单.json>（读取 DATABASE_URL；重导后让已有账号重新加入）
```

3. `function fail(…)` 之后加入：

```ts
async function ownerActor(db: Db, email: string, orgSlug: string): Promise<Actor> {
  const [a] = await db.select().from(accounts).where(eq(accounts.email, email.trim().toLowerCase()));
  if (!a) fail(`找不到账号 ${email}`);
  return (await resolveActor(db, a.id, orgSlug)) ?? fail(`账号 ${email} 不是组织 ${orgSlug} 的成员`);
}
```

4. `parseArgs` 的 `options` 里 `runs: …` 之后加入 `accounts: { type: 'string' },`。

5. `perf` 分支里把

```ts
      const [a] = await db.select().from(accounts).where(eq(accounts.email, email.trim().toLowerCase()));
      if (!a) fail(`找不到账号 ${email}`);
      const actor = (await resolveActor(db, a.id, v['org-slug']!)) ?? fail(`账号 ${email} 不是组织 ${v['org-slug']} 的成员`);
```

替换为：

```ts
      const actor = await ownerActor(db, email, v['org-slug']!);
```

6. `perf` 分支（以 `return;\n  }` 结束）之后、`const data: LegacyData = …` 之前加入：

```ts
  if (cmd === 'rejoin') {
    const url = process.env.DATABASE_URL ?? fail('rejoin 需要 DATABASE_URL（运行时角色）');
    const email = v['owner-email'] ?? fail('缺少参数 --owner-email');
    const entries = JSON.parse(readFileSync(v.accounts ?? fail('缺少参数 --accounts'), 'utf8')) as RejoinEntry[];
    const { db, close } = createDb(url, { max: 2 });
    try {
      const joined = await rejoinAccounts(db, await ownerActor(db, email, v['org-slug']!), entries);
      console.log(`已重新加入组织 ${v['org-slug']}：${joined.length} 个账号。`);
    } finally {
      await close();
    }
    return;
  }
```

`CLAUDE.md` 命令表在「迁移旧数据」一行之后加入：

```markdown
| 重导后让测试账号重新加入组织（清单 `.local-data/test-accounts.json`：`[{"email","orgRole","functionTags"}]`，不含密码） | `pnpm --filter @flower/migrate legacy rejoin --org-slug pan123 --owner-email <你的账号邮箱> --accounts "$PWD/.local-data/test-accounts.json"` |
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate test`、`pnpm typecheck`、`pnpm --filter @flower/migrate build`
Expected: 全部 PASS；`build` 生成 `dist/cli.mjs` 无报错。

- [ ] **Step 5: 提交**

```bash
git add packages/migrate/src/rejoin.ts packages/migrate/src/cli.ts packages/migrate/test/rejoin.test.ts CLAUDE.md
git commit -m "feat(migrate): 新增 rejoin 命令，重导后以邀请流程让已有账号重新加入组织

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 用户检查点：确认人员拆分与合并后重导 pan123，恢复测试账号

本任务不改代码、不提交，只操作本地 `.local-data/` 与开发库。`<OWNER_EMAIL>` 由控制方提供（与 P1-B2 重导时相同的所有者账号）。

**Files:**
- 本地（不提交）：`.local-data/mapping/`（先备份）、`.local-data/reports/`、`.local-data/test-accounts.json`（新建）

**Interfaces:**
- Consumes: Task 1–3 的 `suggest`、`import`（报告三节）、`rejoin`
- Produces: 开发库 pan123 按新人员规则重导；3 个测试账号恢复成员关系；Task 11 用到的数量（Step 5、Step 9 的输出）

- [ ] **Step 1: 准备**

若之前跑过 `pnpm test` 或端到端测试，先把 `flower_app` 的密码改回；然后备份对照表（记下备份目录名，Step 5 要用）：

```bash
pnpm db:migrate
STAMP=$(date +%Y%m%d-%H%M) && cp -R .local-data/mapping ".local-data/mapping.bak-$STAMP" && echo ".local-data/mapping.bak-$STAMP"
```

- [ ] **Step 2: 按新规则重新生成对照表**

```bash
pnpm --filter @flower/migrate legacy suggest --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping"
```

Expected：输出「已写入对照表 …：人员 N、…」。按 2026-09-30 的对照表模拟，N 约为 81（原 124 条：删去 26 个多人条目与 2 个代签条目，并入 13 个头衔 / 昵称条目、1 个单独昵称、1 个短名、1 个邮箱前缀，新增 1 个只在多人写法里出现的名字）。以实际输出为准。

- [ ] **Step 3: 试跑导入**

```bash
pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --owner-email <OWNER_EMAIL> --as-of 2026-09-29 --replace --dry-run
```

Expected：「试跑完成，未写入数据库。」；对账报告 0 个阻止写入的问题。若有「人员对照表缺少：…」，说明某个拆出的名字没有进对照表，停下来报告，不要手改代码绕过。

- [ ] **Step 4: 检查对账报告的人员部分**

```bash
grep -n -A3 '### 人员拆分\|### 人员合并\|### 代签写法' .local-data/reports/migration-report.md | head -40
```

只在本地查看，不把姓名贴进提交或文档。

- [ ] **Step 5: 汇总数量**

把 `<备份目录>` 换成 Step 1 输出的目录：

```bash
node -e '
const r = require(process.argv[1]);
const before = require(process.argv[2]).people.length;
console.log(JSON.stringify({
  problems: r.problems.length,
  peopleBefore: before,
  peopleAfter: r.people.length,
  agents: r.people.filter((p) => p.kind === "agent").length,
  splitStrings: r.personSplits.length,
  splitSingleRefs: r.personSplits.reduce((n, s) => n + s.singleRefs, 0),
  splitMultiRefs: r.personSplits.reduce((n, s) => n + s.multiRefs, 0),
  mergedPeople: r.personMerges.length,
  proxyStrings: r.proxies.length,
  proxyRefs: r.proxies.reduce((n, p) => n + p.refs, 0),
}, null, 2));
' "$PWD/.local-data/reports/migration-report.json" "$PWD/<备份目录>/people.json"
```

Expected（2026-09-30 的估计，以实际为准）：`problems` 0；`peopleBefore` 124；`peopleAfter` 约 81；`agents` 2；`splitStrings` 约 28、`splitSingleRefs` 约 32（其中任务 30）、`splitMultiRefs` 0；`proxyStrings` 2、`proxyRefs` 13。

- [ ] **Step 6: 用户检查点（必须停下）**

控制方把 Step 5 的数量按下面的格式发给用户，**等用户明确回复同意后才能做 Step 7**。用户要求调整时：在 `.local-data/mapping/people.json` 里改（给目标条目加别名；确认是小组的多人写法加 `"keep": true`；需要时改 `kind`），然后从 Step 3 重做（不必重跑 Step 2；重跑 `suggest` 也会保留这些编辑）。

```
人员映射修复的试跑结果（明细在 .local-data/reports/migration-report.md「人员」一节，只在本地）：
- 阻止写入的问题：<problems> 个
- 人员对照表：<peopleBefore> → <peopleAfter> 条，其中 Agent <agents> 个（同步程序、AI 预审模型）
- 拆分：<splitStrings> 个多人写法；单值字段 <splitSingleRefs> 处取第一人（多为甘特任务的负责人），多值字段 <splitMultiRefs> 处每人一条
- 合并：<mergedPeople> 个成员带有其他写法（头衔、昵称、短名、邮箱前缀），见「人员合并」一节
- 代签写法：<proxyStrings> 个，共 <proxyRefs> 条变更记录，按实际操作人导入，不再建成员
- 未自动处理：角色词或占位写法（约 10 个）、同音错字与只有拼音的写法（各 1 例），仍按人导入；需要合并的请在 people.json 给目标条目加别名
确认后我用 --replace 重导 pan123（只动本地开发库）。这会清掉 9-30 界面测试时在 pan123 里做的改动，3 个测试账号随后用 rejoin 恢复。是否继续？
```

- [ ] **Step 7: 重导（用户同意之后）**

```bash
pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --owner-email <OWNER_EMAIL> --as-of 2026-09-29 --replace
```

Expected：「已写入组织 pan123：需求 N 条。」（需求数与 P1-B2 重导时相同）。

- [ ] **Step 8: 恢复测试账号**

按 `.local-data/test-accounts.md` 里的 3 个账号新建 `.local-data/test-accounts.json`（只写邮箱、组织角色、职能标签，不写密码）：

```json
[
  { "email": "<测试管理员的邮箱>", "orgRole": "admin", "functionTags": [] },
  { "email": "<设计甲的邮箱>", "orgRole": "member", "functionTags": ["设计"] },
  { "email": "<设计乙的邮箱>", "orgRole": "member", "functionTags": ["设计"] }
]
```

```bash
pnpm --filter @flower/migrate legacy rejoin --org-slug pan123 --owner-email <OWNER_EMAIL> --accounts "$PWD/.local-data/test-accounts.json"
```

Expected：「已重新加入组织 pan123：3 个账号。」

- [ ] **Step 9: 核对开发库（只读查询，只输出数量）**

```bash
docker compose -f docker-compose.dev.yml exec -T postgres psql -U flower_admin -d flower -At -F ' | ' -c "select count(*), count(*) filter (where m.kind = 'agent'), count(*) filter (where m.account_id is not null), count(*) filter (where m.display_name ~ '[、,，/;；]' or m.display_name ~ '[一-龥][[:space:]]+[一-龥]'), count(*) filter (where m.display_name ~ '^代.+by'), count(*) filter (where m.display_name ~ '^[^-]+-.+' and m.display_name ~ '[一-龥]') from members m join organizations o on o.id = m.org_id where o.slug = 'pan123'"
docker compose -f docker-compose.dev.yml exec -T postgres psql -U flower_admin -d flower -At -F ' | ' -c "select count(*), count(*) filter (where t.assignee_member_id is null), count(*) filter (where t.meta->>'ovAssignee' ~ '[、,，]') from tasks t join organizations o on o.id = t.org_id where o.slug = 'pan123'"
```

Expected：第一行约为 `84 | 2 | 4 | 0 | 0 | 1`（成员总数 = 对照表条数 + 3 个测试账号；Agent 2；有账号的 4；多人写法 0；代签写法 0；带头衔的只剩 1 个头衔后不是汉字姓名的写法）。第二行任务总数 377（与 P1-B2 相同），多人原文的任务约 30 条且都有负责人。把两行输出记下，Task 11 写进验证记录。

---
### Task 5: 共享成员选择框 `MemberPicker`；需求详情（负责人、提出人）、新建需求、阻塞项、分配五处替换

**Files:**
- Modify: `apps/web/src/features/members/model.ts`（`PickerOption`、`pickerOptions`、`filterPickerOptions`）
- Test: `apps/web/src/features/members/model.test.ts`
- Create: `apps/web/src/components/member-picker.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/fields-panel.tsx`（负责人、提出人）
- Modify: `apps/web/src/app/(app)/[org]/requirements/create-dialog.tsx`（提出人）
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/blockers.tsx`（阻塞项负责人）
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/assignments.tsx`（分配成员）
- Test: `apps/web/e2e/member-picker.spec.ts`（新文件）

**Interfaces:**
- Consumes: 现有 `activePeople`、`Member` 类型、`Popover`、`Input`、`Button`
- Produces:
  - `features/members/model.ts`：`type PickerOption = { id: string; displayName: string; email?: string | null; department?: string | null }`；`pickerOptions(people: Member[], current: { id: string; displayName: string } | null): PickerOption[]`（当前值不在列表里时追加在末尾，用于已离开的成员）；`filterPickerOptions(options: PickerOption[], query: string): PickerOption[]`
  - `components/member-picker.tsx`：`MemberPicker({ label, options, value, onChange, noneLabel?, placeholder?, disabled?, className? })`，`value: string | null`，`onChange(id: string | null)`。触发按钮 `role="combobox"`、`aria-label={label}`；搜索框的可访问名是 `搜索${label}`；选项 `role="option"`；有 `noneLabel` 且搜索框为空时，第一项是代表 `null` 的「不填 / 未指派…」
  - Task 6 用同一组件替换其余四处

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/members/model.test.ts`：

1. 第 3 行 import 改为：

```ts
import { activePeople, canListMembers, filterMembers, filterPickerOptions, invitationState, memberKind, pickerOptions } from './model';
```

2. 在 `describe('可选为负责人的成员', …)` 之后加入：

```ts
describe('成员选择框', () => {
  const people = activePeople(all);

  it('当前值指向已离开的成员时保留在选项末尾', () => {
    expect(pickerOptions(people, { id: '4', displayName: '沈知' }).map((o) => o.id)).toEqual(['1', '2', '4']);
    expect(pickerOptions(people, { id: '1', displayName: '林澄' }).map((o) => o.id)).toEqual(['1', '2']);
    expect(pickerOptions(people, null)).toEqual([
      { id: '1', displayName: '林澄', email: 'lin@example.com', department: null },
      { id: '2', displayName: '王总', email: null, department: '商务部' },
    ]);
  });

  it('按姓名、邮箱、部门过滤，忽略大小写与空白；姓名以关键词开头的排在前面', () => {
    const opts = [
      { id: 'a', displayName: '王小林' },
      { id: 'b', displayName: '林澄', email: 'lin@example.com' },
      { id: 'c', displayName: '赵六', department: '林业部' },
      { id: 'd', displayName: '钱七' },
    ];
    expect(filterPickerOptions(opts, '林').map((o) => o.id)).toEqual(['b', 'a', 'c']);
    expect(filterPickerOptions(opts, ' LIN ').map((o) => o.id)).toEqual(['b']);
    expect(filterPickerOptions(opts, '')).toHaveLength(4);
    expect(filterPickerOptions(opts, '不存在')).toEqual([]);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/members/model.test.ts`
Expected: FAIL，`pickerOptions` 与 `filterPickerOptions` 未导出。

- [ ] **Step 2: 实现纯函数**

`apps/web/src/features/members/model.ts`：在 `activePeople` 之后加入：

```ts
export type PickerOption = { id: string; displayName: string; email?: string | null; department?: string | null };

/** 成员选择框的选项：传入的成员；当前值指向不在列表里的成员（例如已离开）时追加在末尾，保证能显示出来。 */
export function pickerOptions(people: Member[], current: { id: string; displayName: string } | null): PickerOption[] {
  const list: PickerOption[] = people.map((p) => ({ id: p.id, displayName: p.displayName, email: p.email, department: p.department }));
  return current && !list.some((o) => o.id === current.id) ? [...list, { id: current.id, displayName: current.displayName }] : list;
}

/** 按姓名、邮箱、部门过滤，忽略大小写与空白；姓名以关键词开头的排在前面，其余保持原顺序。 */
export function filterPickerOptions(options: PickerOption[], query: string): PickerOption[] {
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase();
  const q = norm(query);
  if (!q) return options;
  const matched = options.filter((o) => [o.displayName, o.email, o.department].some((s) => norm(s).includes(q)));
  const starts = (o: PickerOption) => norm(o.displayName).startsWith(q);
  return [...matched.filter(starts), ...matched.filter((o) => !starts(o))];
}
```

Run: `pnpm --filter @flower/web exec vitest run src/features/members/model.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

新建 `apps/web/e2e/member-picker.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createMember, createProduct, createRequirement, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求详情：负责人与提出人可以搜索，回车与方向键选择，选「不填」清空', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  for (let i = 1; i <= 30; i++) await createMember(request, `成员${String(i).padStart(2, '0')}`);
  await createMember(request, '设计师甲');

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const panel = page.getByRole('region', { name: '属性' });
  const owner = panel.getByRole('combobox', { name: '负责人', exact: true });
  await owner.click();
  const search = page.getByRole('textbox', { name: '搜索负责人' });
  await expect(search).toBeFocused();
  await search.fill('设计');
  await expect(page.getByRole('option')).toHaveCount(1);
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/requirements/${req.id}`));
  await search.press('Enter');
  expect((await saved).ok()).toBeTruthy();
  await expect(owner).toHaveText('设计师甲');

  await owner.click();
  await page.getByRole('option', { name: '不填' }).click();
  await expect(owner).toHaveText('不填');

  const requester = panel.getByRole('combobox', { name: '提出人', exact: true });
  await requester.click();
  await page.getByRole('textbox', { name: '搜索提出人' }).fill('成员0');
  await expect(page.getByRole('option')).toHaveCount(9);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(requester).toHaveText('成员02');
  await page.reload();
  await expect(page.getByRole('region', { name: '属性' }).getByRole('combobox', { name: '提出人', exact: true })).toHaveText('成员02');
});

test('新建需求与阻塞项：提出人、阻塞项负责人用搜索选择', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  for (let i = 1; i <= 12; i++) await createMember(request, `成员${String(i).padStart(2, '0')}`);
  await createMember(request, '客户甲');

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const blockers = page.getByRole('region', { name: '阻塞项' });
  await blockers.getByLabel('新阻塞项').fill('等待支付接口');
  await blockers.getByRole('combobox', { name: '阻塞项负责人' }).click();
  await page.getByRole('textbox', { name: '搜索阻塞项负责人' }).fill('成员12');
  await page.getByRole('option', { name: '成员12' }).click();
  await blockers.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('已添加阻塞项')).toBeVisible();
  await expect(blockers).toContainText('成员12');

  await page.goto('/acme/requirements');
  await page.getByRole('button', { name: '新建需求' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('标题').fill('客户反馈的需求');
  await dialog.getByRole('combobox', { name: '提出人' }).click();
  await page.getByRole('textbox', { name: '搜索提出人' }).fill('客户');
  await page.getByRole('option', { name: '客户甲' }).click();
  await expect(dialog.getByRole('combobox', { name: '提出人' })).toHaveText('客户甲');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建 PAN-2')).toBeVisible();
  await page.goto('/acme/requirements/PAN-2');
  await expect(page.getByRole('region', { name: '属性' }).getByRole('combobox', { name: '提出人', exact: true })).toHaveText('客户甲');
});
```

Run: `pnpm --filter @flower/web e2e member-picker.spec.ts`
Expected: FAIL，找不到可访问名为「搜索负责人」的输入框（现在是 Radix Select，没有搜索）。

- [ ] **Step 4: 实现共享组件**

新建 `apps/web/src/components/member-picker.tsx`：

```tsx
'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { filterPickerOptions, type PickerOption } from '@/features/members/model';
import { cn } from '@/lib/utils';

/**
 * 可搜索的成员选择框：点开后输入姓名、邮箱或部门过滤，方向键移动、回车选中。
 * 触发按钮的角色是 combobox、选项的角色是 option，与原来的 Select 相同。
 * 有 noneLabel 时，搜索框为空时第一项代表「不选」（onChange(null)）。
 */
export function MemberPicker({
  label,
  options,
  value,
  onChange,
  noneLabel,
  placeholder = '选择成员',
  disabled,
  className,
}: {
  label: string;
  options: PickerOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  noneLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const items: Array<{ id: string | null; label: string }> = [
    ...(noneLabel && !query.trim() ? [{ id: null, label: noneLabel }] : []),
    ...filterPickerOptions(options, query).map((o) => ({ id: o.id, label: o.displayName })),
  ];
  const current = Math.min(active, items.length - 1);
  const selected = options.find((o) => o.id === value);
  const showsNone = !selected && value === null && !!noneLabel;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    setQuery('');
    setActive(0);
  };
  const pick = (id: string | null) => {
    changeOpen(false);
    if (id !== value) onChange(id);
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          disabled={disabled}
          className={cn('justify-between gap-1 px-3 font-normal', !selected && !showsNone && 'text-muted-foreground', className)}
        >
          <span className="truncate">{selected?.displayName ?? (showsNone ? noneLabel : placeholder)}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        <Input
          aria-label={`搜索${label}`}
          placeholder="输入姓名、邮箱或部门"
          className="mb-1 h-8"
          value={query}
          aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive(Math.min(current + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive(Math.max(current - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const item = items[current];
              if (item) pick(item.id);
            }
          }}
        />
        <ul id={listId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
          {items.map((it, i) => (
            <li
              key={it.id ?? '__none'}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={it.id === value}
              ref={i === current ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={cn('flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px]', i === current && 'bg-accent text-accent-foreground')}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(it.id)}
            >
              <Check className={cn('size-3.5 shrink-0', it.id === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
              <span className="truncate">{it.label}</span>
            </li>
          ))}
          {items.length === 0 && <li className="px-2 py-1.5 text-[13px] text-muted-foreground">没有匹配的成员</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 5: 替换五处**

`apps/web/src/app/(app)/[org]/requirements/[key]/fields-panel.tsx`：

1. import 里加入 `import { MemberPicker } from '@/components/member-picker';`（放在 `OptionMultiSelect` 那一行之前），并把 `import { activePeople, canListMembers } from '@/features/members/model';` 改为：

```ts
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
```

2. 把 `memberSelect` 整个函数替换为：

```tsx
  const memberSelect = (label: string, field: 'ownerMemberId' | 'requesterMemberId', current: { id: string; displayName: string } | null) => (
    <Row label={label}>
      {canEdit && canListMembersFlag ? (
        <MemberPicker
          label={label}
          className="h-8 w-full"
          noneLabel="不填"
          options={pickerOptions(people, current)}
          value={current?.id ?? null}
          onChange={(id) => patch.mutate({ [field]: id })}
        />
      ) : (
        (current?.displayName ?? '—')
      )}
    </Row>
  );
```

（`NONE`、`Select` 仍被结构节点与单选字段使用，保留。）

`apps/web/src/app/(app)/[org]/requirements/create-dialog.tsx`：

1. import 里加入 `import { MemberPicker } from '@/components/member-picker';`，并把 `import { activePeople, canListMembers } from '@/features/members/model';` 改为 `import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';`。

2. `const [requester, setRequester] = useState(NONE);` 改为 `const [requester, setRequester] = useState<string | null>(null);`；`reset` 里的 `setRequester(NONE);` 改为 `setRequester(null);`；请求体里的 `requesterMemberId: requester === NONE ? null : requester,` 改为 `requesterMemberId: requester,`。

3. 把「提出人」的 `<Select …>…</Select>` 整段替换为：

```tsx
              <MemberPicker label="提出人" className="w-full" noneLabel="不填" options={pickerOptions(people, null)} value={requester} onChange={setRequester} />
```

（`NONE` 与 `Select` 仍被优先级使用，保留。）

`apps/web/src/app/(app)/[org]/requirements/[key]/blockers.tsx`：

1. 删除 `import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';` 与 `const NONE = '__none';`；加入 `import { MemberPicker } from '@/components/member-picker';`；`import { activePeople, canListMembers } from '@/features/members/model';` 改为 `import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';`。

2. `const [owner, setOwner] = useState(NONE);` 改为 `const [owner, setOwner] = useState<string | null>(null);`；请求体 `ownerMemberId: owner === NONE ? null : owner` 改为 `ownerMemberId: owner`；`onSuccess` 里的 `setOwner(NONE);` 改为 `setOwner(null);`。

3. 把表单里的 `<Select value={owner} …>…</Select>` 整段替换为：

```tsx
            <MemberPicker label="阻塞项负责人" className="h-8 w-32" noneLabel="无负责人" options={pickerOptions(people, null)} value={owner} onChange={setOwner} />
```

`apps/web/src/app/(app)/[org]/requirements/[key]/assignments.tsx`：

1. 加入 `import { MemberPicker } from '@/components/member-picker';`；`import { activePeople, canListMembers } from '@/features/members/model';` 改为 `import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';`。

2. `const [memberId, setMemberId] = useState(NONE);` 改为 `const [memberId, setMemberId] = useState<string | null>(null);`；`onSuccess` 里的 `setMemberId(NONE);` 改为 `setMemberId(null);`。

3. 把「分配成员」的 `<Select value={memberId} …>…</Select>` 整段替换为：

```tsx
          <MemberPicker label="分配成员" className="h-8 w-full" options={pickerOptions(activePeople(members.data ?? []), null)} value={memberId} onChange={setMemberId} />
```

4. 提交按钮的 `disabled={tagId === NONE || memberId === NONE || add.isPending}` 改为 `disabled={tagId === NONE || !memberId || add.isPending}`。

- [ ] **Step 6: 运行测试确认通过**

Run:

```bash
pnpm --filter @flower/web exec vitest run src/features/members/model.test.ts
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web e2e member-picker.spec.ts requirement-assignments.spec.ts requirement-maintenance.spec.ts requirements.spec.ts
```

Expected: 全部 PASS。`requirement-assignments.spec.ts` 仍用 `section.getByRole('combobox', { name: '分配成员' })` + `page.getByRole('option', …)`，不需要修改。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/members/model.ts apps/web/src/features/members/model.test.ts apps/web/src/components/member-picker.tsx "apps/web/src/app/(app)/[org]/requirements/[key]/fields-panel.tsx" "apps/web/src/app/(app)/[org]/requirements/create-dialog.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/blockers.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/assignments.tsx" apps/web/e2e/member-picker.spec.ts
git commit -m "feat(web): 可搜索的成员选择框，替换需求详情、新建需求、阻塞项与分配中的成员下拉

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 其余四处成员选择：甘特任务负责人、人员负载、需求列表负责人筛选、流程会签「指定成员」

**Files:**
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx`
- Modify: `apps/web/src/app/(app)/[org]/workload/page.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/page.tsx`
- Modify: `apps/web/src/features/workflow/components/check-items.tsx`
- Test: `apps/web/e2e/member-picker.spec.ts`、`apps/web/e2e/gantt.spec.ts`、`apps/web/e2e/workflows.spec.ts`

**Interfaces:**
- Consumes: Task 5 的 `MemberPicker`、`pickerOptions`
- Produces: 可访问名不变的四个选择框：`负责人 <任务名>`、`选择成员`、`负责人`（需求列表）、`签字人`；搜索框名为 `搜索负责人 <任务名>`、`搜索选择成员`、`搜索负责人`、`搜索签字人`

- [ ] **Step 1: 写失败的端到端测试**

`apps/web/e2e/member-picker.spec.ts`：

1. import 改为：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createMember, createProduct, createRequirement, login, ok, OWNER, setupInstance } from './helpers';
```

2. 文件末尾加入：

```ts
test('需求列表：负责人筛选可以搜索', async ({ page, request }) => {
  const productId = await createProduct(request);
  const designer = await createMember(request, '设计师甲');
  for (let i = 1; i <= 12; i++) await createMember(request, `成员${String(i).padStart(2, '0')}`);
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '设计师负责的需求', ownerMemberId: designer } }));
  await createRequirement(request, productId, '没人负责的需求');

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements');
  await expect(page.getByText('没人负责的需求')).toBeVisible();
  await page.getByRole('combobox', { name: '负责人', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索负责人' }).fill('设计');
  await page.getByRole('option', { name: '设计师甲' }).click();
  await expect(page.getByText('设计师负责的需求')).toBeVisible();
  await expect(page.getByText('没人负责的需求')).toHaveCount(0);
  await expect(page).toHaveURL(/owner=/);
});
```

`apps/web/e2e/gantt.spec.ts`：

1. import 改为：

```ts
import { createIteration, createMember, createProduct, createRequirement, createTask, FAIL_500, login, OWNER, setupInstance } from './helpers';
```

2. 在「甘特页签：保存一个字段时…」用例之后加入：

```ts
test('甘特页签：任务负责人用搜索选择', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId, title: '联调' });
  for (let i = 1; i <= 20; i++) await createMember(request, `开发${String(i).padStart(2, '0')}`);
  await createMember(request, '测试丙');

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
  const assignee = page.getByRole('combobox', { name: '负责人 联调' });
  await expect(assignee).toHaveText('未指派');
  await assignee.click();
  await page.getByRole('textbox', { name: '搜索负责人 联调' }).fill('测试');
  const saved = taskSaved(page);
  await page.getByRole('option', { name: '测试丙' }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(assignee).toHaveText('测试丙');
  await page.reload();
  await expect(page.getByRole('combobox', { name: '负责人 联调' })).toHaveText('测试丙');
});
```

`apps/web/e2e/workflows.spec.ts`：

1. import 改为：

```ts
import { login, ok, OWNER, setupInstance } from './helpers';
```

2. 文件末尾加入：

```ts
test('会签检查项：「指定成员」签字人用搜索选择', async ({ page, request }) => {
  await ok(request.post('/api/v1/orgs/acme/members', { data: { displayName: '老板乙' } }));
  await page.getByRole('link', { name: '默认流程' }).click();
  await page.getByRole('tab', { name: /检查项/ }).click();
  await page.getByRole('button', { name: '新增检查项' }).click();
  const dialog = page.getByRole('dialog', { name: '新增检查项' });
  await dialog.getByLabel('检查项名称').fill('老板签字');
  await dialog.getByLabel('类型', { exact: true }).click();
  await page.getByRole('option', { name: '会签' }).click();
  await dialog.getByRole('combobox', { name: '签字人类型' }).click();
  await page.getByRole('option', { name: '成员' }).click();
  await dialog.getByRole('combobox', { name: '签字人', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索签字人' }).fill('老板');
  await page.getByRole('option', { name: '老板乙' }).click();
  await dialog.getByRole('button', { name: '加入' }).click();
  await expect(dialog.getByText('成员：老板乙')).toBeVisible();
});
```

Run: `pnpm --filter @flower/web e2e member-picker.spec.ts gantt.spec.ts workflows.spec.ts`
Expected: 新增的 3 个用例 FAIL（找不到「搜索…」输入框），其余用例 PASS。

- [ ] **Step 2: 替换四处**

`apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx`：

1. import 里加入 `import { MemberPicker } from '@/components/member-picker';` 与 `import { pickerOptions } from '@/features/members/model';`（`Select` 仍被状态与标记使用，保留）。

2. 删除这段：

```ts
  // 负责人下拉：在职真人成员；当前负责人已离开时也保留在选项里
  const options = people
    ? [
        ...people.map((p) => ({ id: p.id, displayName: p.displayName })),
        ...(t.assignee && !people.some((p) => p.id === t.assignee!.id) ? [t.assignee] : []),
      ]
    : null;
```

3. 负责人单元格整体替换为：

```tsx
        <TableCell>
          {people ? (
            <MemberPicker
              label={`负责人 ${label}`}
              className="h-8 w-full"
              noneLabel="未指派"
              options={pickerOptions(people, t.assignee)}
              value={t.assignee?.id ?? null}
              disabled={disabled}
              onChange={(id) => save({ assigneeMemberId: id })}
            />
          ) : (
            <span className="text-[13px]">{t.assignee?.displayName ?? '未指派'}</span>
          )}
        </TableCell>
```

`apps/web/src/app/(app)/[org]/workload/page.tsx`：

1. 删除 `import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';`；加入 `import { MemberPicker } from '@/components/member-picker';`；`import { activePeople, canListMembers } from '@/features/members/model';` 改为 `import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';`。

2. 把 `{people.length > 0 && (<Select value={memberId} …>…</Select>)}` 整段替换为：

```tsx
        {people.length > 0 && (
          <MemberPicker label="选择成员" className="h-8 w-44" options={pickerOptions(people, null)} value={memberId || null} onChange={(id) => id && go({ member: id })} />
        )}
```

`apps/web/src/app/(app)/[org]/requirements/page.tsx`：

1. 加入 `import { MemberPicker } from '@/components/member-picker';`；把 `activePeople` 所在的 import 改为同时导入 `pickerOptions`。

2. 把负责人筛选的 `{canListMembersFlag && members.data && (<Select …>…</Select>)}` 整段替换为：

```tsx
        {canListMembersFlag && members.data && (
          <MemberPicker
            label="负责人"
            className="h-8 w-32"
            noneLabel="全部负责人"
            options={pickerOptions(activePeople(members.data), null)}
            value={filter.owner}
            onChange={(id) => setFilter({ owner: id })}
          />
        )}
```

`apps/web/src/features/workflow/components/check-items.tsx`：

1. 加入 `import { MemberPicker } from '@/components/member-picker';` 与 `import { pickerOptions } from '@/features/members/model';`。

2. 把「签字人」那个 `<Select value={signer.ref} …>…</Select>` 整段替换为：

```tsx
                  {signer.by === 'member' ? (
                    <MemberPicker
                      label="签字人"
                      className="flex-1"
                      placeholder="选择"
                      options={pickerOptions(members.filter((m) => m.status === 'active'), null)}
                      value={signer.ref || null}
                      onChange={(id) => setSigner({ ...signer, ref: id ?? '' })}
                    />
                  ) : (
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
                        {signer.by === 'product_role' &&
                          (['admin', 'editor', 'viewer'] as const).map((r) => (
                            <SelectItem key={r} value={r}>
                              {PRODUCT_ROLE_LABEL[r]}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  )}
```

- [ ] **Step 3: 运行测试确认通过**

Run:

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web test
pnpm --filter @flower/web e2e member-picker.spec.ts gantt.spec.ts workflows.spec.ts workload.spec.ts requirements.spec.ts
```

Expected: 全部 PASS。`workload.spec.ts` 仍用 `combobox 选择成员` + `option 开发乙`，不需要修改。

- [ ] **Step 4: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx" "apps/web/src/app/(app)/[org]/workload/page.tsx" "apps/web/src/app/(app)/[org]/requirements/page.tsx" apps/web/src/features/workflow/components/check-items.tsx apps/web/e2e/member-picker.spec.ts apps/web/e2e/gantt.spec.ts apps/web/e2e/workflows.spec.ts
git commit -m "feat(web): 甘特任务负责人、人员负载、需求列表筛选与会签指定成员改用可搜索的成员选择框

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 甘特任务表：固定列宽与数字输入框宽度（1440 / 800 守护）

**Files:**
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/gantt-tab.tsx`（表头列宽、`table-fixed`）
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx`（标题单元格、三个数字输入框）
- Modify: `apps/web/e2e/helpers.ts`（`expectNoPageOverflow`、`textFits`）
- Test: `apps/web/e2e/gantt.spec.ts`

**Interfaces:**
- Consumes: Task 6 之后的 `task-row.tsx`（负责人列是 `MemberPicker`）
- Produces（e2e `helpers.ts`）：`expectNoPageOverflow(page: Page): Promise<void>`（断言 `document.documentElement.scrollWidth ≤ clientWidth`）；`textFits(input: Locator): Promise<boolean>`（按计算后的字体量输入框里的文字，数字输入框另留 16px 给上下箭头）。Task 8 使用。
- 列宽（Tailwind）：重点 `w-10`、需求 / 任务 `w-72`、负责人 `w-36`、状态 `w-28`、开始 / 工期 `w-64`、进度 `w-52`、标记 / 延期 `w-48`、说明 `w-48`、操作 `w-10`，合计 1472px

- [ ] **Step 1: 加测试辅助函数**

`apps/web/e2e/helpers.ts`：

1. 第 1 行 import 改为：

```ts
import { type APIRequestContext, type APIResponse, expect, type Locator, type Page } from '@playwright/test';
```

2. 文件末尾加入：

```ts
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
```

- [ ] **Step 2: 写失败的测试**

`apps/web/e2e/gantt.spec.ts`：

1. import 改为：

```ts
import { createIteration, createMember, createProduct, createRequirement, createTask, expectNoPageOverflow, FAIL_500, login, OWNER, setupInstance, textFits } from './helpers';
```

2. 在「甘特页签：任务负责人用搜索选择」之后加入：

```ts
test('甘特表：1440 与 800 宽度下「需求 / 任务」列不压到负责人列，进度、工期、延期的数字完整显示，页面不横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '一个很长的需求标题，用来检查需求与任务列不会压到负责人列');
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  const label = '前端开发联调与埋点验证';
  await createTask(request, { iterationId, requirementId: req.id, title: label, planStart: '2026-01-05', planDays: 12.5, delayDays: 10.5, progress: 100 });

  await login(page, OWNER.email, OWNER.password);
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
    const assignee = (await page.getByRole('combobox', { name: `负责人 ${label}` }).boundingBox())!;
    for (const left of [page.getByLabel(`别名 ${label}`), page.getByText(`· ${label}`, { exact: true })]) {
      const box = (await left.boundingBox())!;
      expect(box.x + box.width, `${width}px`).toBeLessThanOrEqual(assignee.x);
    }
    for (const name of [`进度 ${label}`, `工期 ${label}`, `延期 ${label}`]) {
      const input = page.getByLabel(name, { exact: true });
      await expect(input).not.toHaveValue('');
      expect(await textFits(input), `${name}，${width}px`).toBe(true);
    }
    await expectNoPageOverflow(page);
  }
});
```

Run: `pnpm --filter @flower/web e2e gantt.spec.ts`
Expected: 新用例 FAIL：1440px 时别名输入框的右边界超过负责人列（「需求 / 任务」列只剩约 60px）；`textFits` 对「100」「12.5」「10.5」返回 false。

- [ ] **Step 3: 实现**

`apps/web/src/app/(app)/[org]/iterations/[id]/gantt-tab.tsx`：把 `<Table className="min-w-[1180px]">` 到 `</TableHeader>` 整段替换为：

```tsx
          <Table className="min-w-[1472px] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <span className="sr-only">重点</span>
                </TableHead>
                <TableHead className="w-72">需求 / 任务</TableHead>
                <TableHead className="w-36">负责人</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-64">开始 / 工期（天）</TableHead>
                <TableHead className="w-52">进度（%）</TableHead>
                <TableHead className="w-48">标记 / 延期（天）</TableHead>
                <TableHead className="w-48">说明</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
```

`apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx`：

1. 标题单元格 `<TableCell className="max-w-0">` 改为 `<TableCell className="overflow-hidden">`（固定列宽下不再需要 `max-w-0` 的写法）。

2. 工期输入框（`aria-label={`工期 ${label}`}`）的 `className="h-8 w-16"` 改为 `className="h-8 w-20"`。

3. 进度输入框（`aria-label={`进度 ${label}`}`）的 `className="h-8 w-16"` 改为 `className="h-8 w-20"`。

4. 延期输入框（`aria-label={`延期 ${label}`}`）的 `className="h-8 w-16"` 改为 `className="h-8 w-20"`。

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web e2e gantt.spec.ts
```

Expected: 全部 PASS。若 800px 时 `expectNoPageOverflow` 失败，按 Global Constraints「布局」一条的片段定位并修掉，写进任务报告。

- [ ] **Step 5: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/iterations/[id]/gantt-tab.tsx" "apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx" apps/web/e2e/helpers.ts apps/web/e2e/gantt.spec.ts
git commit -m "fix(web): 甘特任务表固定列宽，需求列不再压到负责人列，数字输入框能完整显示

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: 窄宽度布局：成员页、评审表、发布版本表、工作台（1440 / 800 守护）

**Files:**
- Modify: `apps/web/src/app/(app)/[org]/settings/members/page.tsx`（筛选栏换行）
- Modify: `apps/web/src/app/(app)/[org]/reviews/page.tsx`（展开与编号列固定在左侧，标题截断）
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/releases-tab.tsx`（操作列固定在右侧）
- Modify: `apps/web/src/app/(app)/[org]/page.tsx`（工作台 1280px 以下单列）
- Test: `apps/web/e2e/layout.spec.ts`（新文件）

**Interfaces:**
- Consumes: Task 7 的 `expectNoPageOverflow`
- Produces: 发布版本表的行带 `group` 类、操作单元格为 `sticky right-0`（Task 10 在同一列加「关联需求」按钮）；评审表可访问名不变（`展开 PAN-x`、列头为检查项名称）

- [ ] **Step 1: 写失败的测试**

新建 `apps/web/e2e/layout.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyReviewWorkflow, createIteration, createMember, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

const LONG = '一个很长的需求标题，用来检查窄屏下表格与卡片不会把页面撑宽，也不会把标题挤没';
const WIDTHS = [1440, 800];

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('成员页：页面不横向滚动，成员抽屉完整显示在视口内', async ({ page, request }) => {
  await createProduct(request);
  await createMember(request, '王总');
  await login(page, OWNER.email, OWNER.password);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/settings/members');
    await expect(page.getByRole('row', { name: /王总/ })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.getByRole('button', { name: '查看王总' }).click();
    await expect(page.getByRole('dialog', { name: '王总' })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '王总' })).toHaveCount(0);
  }
});

test('评审表：横向滚动到最后一个检查项时编号列仍然可见，页面不横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  const boss = await createMember(request, '老板乙');
  await applyReviewWorkflow(request, productId, boss);
  await createRequirement(request, productId, LONG);
  await login(page, OWNER.email, OWNER.password);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/reviews');
    const last = page.getByRole('columnheader', { name: '设计签字' });
    await expect(last).toBeVisible();
    await expectNoPageOverflow(page);
    await page.getByRole('table').evaluate((table) => {
      const box = table.parentElement!;
      box.scrollLeft = box.scrollWidth;
    });
    await expect(last).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('cell', { name: 'PAN-1', exact: true })).toBeInViewport({ ratio: 1 });
  }
});

test('发布版本：操作列固定在右侧，不用横向滚动就能点到「标记发布」', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0801', '2026-08-01', '2026-08-14');
  await ok(request.post('/api/v1/orgs/acme/releases', { data: { productId, versionName: '3.2.0', iterationId, plannedDate: '2026-08-14' } }));
  await login(page, OWNER.email, OWNER.password);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/iterations/${iterationId}`);
    await page.getByRole('tab', { name: '发布版本' }).click();
    await expect(page.getByRole('button', { name: '标记发布 3.2.0' })).toBeInViewport({ ratio: 1 });
    await expectNoPageOverflow(page);
  }
});

test('工作台：800px 下四个区块单列排列、标题不被挤没；1440px 下两列', async ({ page, request }) => {
  const productId = await createProduct(request);
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const boss = await createMember(request, '老板乙');
  await applyReviewWorkflow(request, productId, boss);
  const req = (await json<{ requirement: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: LONG, ownerMemberId: me } })))
    .requirement;
  await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/checks/feasibility`, { data: { state: 'passed' } }));

  await login(page, OWNER.email, OWNER.password);
  const owned = page.getByRole('region', { name: /我负责的需求/ });
  const tasks = page.getByRole('region', { name: /我的任务/ });
  const sign = page.getByRole('region', { name: /等我签字/ });

  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/acme');
  await expect(sign.getByRole('link')).toHaveCount(2);
  const a = (await owned.boundingBox())!;
  const b = (await tasks.boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  for (const title of await sign.getByText(LONG, { exact: true }).all()) expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(200);
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => Math.abs((await owned.boundingBox())!.y - (await tasks.boundingBox())!.y)).toBeLessThan(1);
  await expectNoPageOverflow(page);
});
```

Run: `pnpm --filter @flower/web e2e layout.spec.ts`
Expected: 4 个用例都 FAIL：成员页 800px 时页面宽度超过视口（筛选栏 288px 的搜索框加两个 128px 的下拉超出约 496px 的内容区）；评审表滚到最右时编号单元格被滚出容器；「标记发布」按钮在表格容器之外；工作台 800px 时仍是两列，签字标题宽度远小于 200px。

- [ ] **Step 2: 实现**

`apps/web/src/app/(app)/[org]/settings/members/page.tsx`：成员页签里筛选栏的 `<div className="flex items-center gap-2">` 改为 `<div className="flex flex-wrap items-center gap-2">`；其中搜索框外层 `<label className="flex h-9 w-72 items-center gap-2 rounded-md border bg-card px-3 text-muted-foreground">` 改为 `<label className="flex h-9 w-72 max-w-full items-center gap-2 rounded-md border bg-card px-3 text-muted-foreground">`。

`apps/web/src/app/(app)/[org]/reviews/page.tsx`，`QueueTable` 里：

1. 表头的前两列

```tsx
            <TableHead className="w-10">
              <span className="sr-only">展开</span>
            </TableHead>
            <TableHead className="w-24">编号</TableHead>
```

替换为：

```tsx
            <TableHead className="sticky left-0 z-10 w-12 bg-card">
              <span className="sr-only">展开</span>
            </TableHead>
            <TableHead className="sticky left-12 z-10 w-24 bg-card">编号</TableHead>
```

2. 数据行 `<TableRow className="h-10 even:bg-zebra">` 改为 `<TableRow className="group h-10 even:bg-zebra">`。

3. 同一行里放展开按钮的 `<TableCell>` 改为 `<TableCell className="sticky left-0 z-10 bg-card group-even:bg-zebra">`；编号单元格 `<TableCell className="font-mono text-[13px]">{r.displayKey}</TableCell>` 改为 `<TableCell className="sticky left-12 z-10 bg-card font-mono text-[13px] group-even:bg-zebra">{r.displayKey}</TableCell>`。

4. 标题链接

```tsx
                    <Link href={`/${org}/requirements/${r.displayKey}`} className="hover:underline">
                      {r.title}
                    </Link>
```

替换为：

```tsx
                    <Link href={`/${org}/requirements/${r.displayKey}`} className="block max-w-80 truncate hover:underline" title={r.title}>
                      {r.title}
                    </Link>
```

`apps/web/src/app/(app)/[org]/iterations/[id]/releases-tab.tsx`：

1. 表头最后一列 `<TableHead className="w-40" />` 改为 `<TableHead className="sticky right-0 z-10 w-40 bg-card" />`。

2. 数据行 `<TableRow key={r.id} className="h-10 even:bg-zebra">` 改为 `<TableRow key={r.id} className="group h-10 even:bg-zebra">`。

3. 操作单元格 `<TableCell className="text-right">` 改为 `<TableCell className="sticky right-0 z-10 bg-card text-right group-even:bg-zebra">`。

`apps/web/src/app/(app)/[org]/page.tsx`（工作台）：

1. `Section` 的 `<section aria-labelledby={id} className="flex flex-col rounded-lg border bg-card">` 改为 `<section aria-labelledby={id} className="flex min-w-0 flex-col rounded-lg border bg-card">`。

2. `Sections` 的 `<div className="grid grid-cols-2 gap-4">` 改为 `<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">`。

- [ ] **Step 3: 运行测试确认通过**

Run:

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web e2e layout.spec.ts reviews.spec.ts members.spec.ts iterations.spec.ts workbench.spec.ts
```

Expected: 全部 PASS。若某个页面 800px 时 `expectNoPageOverflow` 仍失败，按 Global Constraints「布局」一条的片段定位并修掉，写进任务报告。

- [ ] **Step 4: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/settings/members/page.tsx" "apps/web/src/app/(app)/[org]/reviews/page.tsx" "apps/web/src/app/(app)/[org]/iterations/[id]/releases-tab.tsx" "apps/web/src/app/(app)/[org]/page.tsx" apps/web/e2e/layout.spec.ts
git commit -m "fix(web): 窄宽度下页面不再被撑宽：成员筛选栏换行，评审表编号列与发布版本操作列固定，工作台单列

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 迭代详情的当前页签写入地址栏（`?tab=`）

**Files:**
- Modify: `apps/web/src/features/iterations/model.ts`（`ITERATION_TABS`、`IterationTab`、`iterationTab`）
- Test: `apps/web/src/features/iterations/model.test.ts`
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`
- Test: `apps/web/e2e/iterations.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `ITERATION_TABS = ['requirements', 'gantt', 'scope', 'releases'] as const`；`type IterationTab`；`iterationTab(raw: string | null, started: boolean): IterationTab`。地址栏约定：`requirements` 不带参数，其余为 `?tab=gantt|scope|releases`；工作台任务链接的 `?tab=gantt` 保持有效

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/iterations/model.test.ts`：

1. 第 3 行 import 改为：

```ts
import { commitmentRate, editableIterationProducts, groupIterations, iterationFormError, iterationTab, localToday, milestoneTimeline, STATUS_ACTIONS } from './model';
```

2. 文件末尾加入：

```ts
describe('迭代详情页签', () => {
  it('地址栏的 tab 转成页签；不认识的值和未开始迭代的「范围对比」回到「需求」', () => {
    expect(iterationTab(null, true)).toBe('requirements');
    expect(iterationTab('gantt', false)).toBe('gantt');
    expect(iterationTab('releases', false)).toBe('releases');
    expect(iterationTab('scope', true)).toBe('scope');
    expect(iterationTab('scope', false)).toBe('requirements');
    expect(iterationTab('whatever', true)).toBe('requirements');
  });
});
```

`apps/web/e2e/iterations.spec.ts`：

1. 第 3 行 import 改为：

```ts
import { acceptInvite, createIteration, createProduct, FAIL_500, login, ok, OWNER, setupInstance } from './helpers';
```

2. 在「迭代详情：不存在时显示无权访问…」用例之后加入：

```ts
test('迭代详情：当前页签写入地址栏，刷新、离开再后退都保持；未开始的迭代没有范围对比', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iterationId}`);
  await expect(page.getByRole('tab', { name: /^需求/ })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tab', { name: '发布版本' }).click();
  await expect(page).toHaveURL(new RegExp(`/acme/iterations/${iterationId}\\?tab=releases$`));
  await page.reload();
  await expect(page.getByRole('tab', { name: '发布版本' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '新建发布版本' })).toBeVisible();

  await page.getByRole('tab', { name: '甘特' }).click();
  await expect(page).toHaveURL(/\?tab=gantt$/);
  await page.getByRole('navigation', { name: '面包屑' }).getByRole('link', { name: '迭代' }).click();
  await expect(page).toHaveURL(/\/acme\/iterations$/);
  await page.goBack();
  await expect(page).toHaveURL(/\?tab=gantt$/);
  await expect(page.getByRole('tab', { name: '甘特' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tab', { name: /^需求/ }).click();
  await expect(page).toHaveURL(new RegExp(`/acme/iterations/${iterationId}$`));

  await page.goto(`/acme/iterations/${iterationId}?tab=scope`);
  await expect(page.getByRole('tab', { name: /^需求/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: '范围对比' })).toHaveCount(0);
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/iterations/model.test.ts` 与 `pnpm --filter @flower/web e2e iterations.spec.ts`
Expected: 单测 FAIL（`iterationTab` 未导出）；新 e2e 用例 FAIL（点「发布版本」后地址栏没有 `?tab=releases`）。

- [ ] **Step 2: 实现**

`apps/web/src/features/iterations/model.ts`：在 `milestoneTimeline` 之后加入：

```ts
export const ITERATION_TABS = ['requirements', 'gantt', 'scope', 'releases'] as const;
export type IterationTab = (typeof ITERATION_TABS)[number];

/** 地址栏的 ?tab= 转成页签；不认识的值和未开始迭代的「范围对比」都回到「需求」。 */
export function iterationTab(raw: string | null, started: boolean): IterationTab {
  const tab = (ITERATION_TABS as readonly string[]).includes(raw ?? '') ? (raw as IterationTab) : 'requirements';
  return tab === 'scope' && !started ? 'requirements' : tab;
}
```

`apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`：

1. `import { localToday, milestoneTimeline, STATUS_ACTIONS } from '@/features/iterations/model';` 改为：

```ts
import { iterationTab, localToday, milestoneTimeline, STATUS_ACTIONS } from '@/features/iterations/model';
```

2. 把

```ts
  // 工作台里的任务链接带 ?tab=gantt，直接打开甘特页签
  const initialTab = useSearchParams().get('tab') === 'gantt' ? 'gantt' : 'requirements';
```

替换为：

```ts
  const params = useSearchParams();
```

3. 把 `const started = it.status !== 'planning';` 替换为：

```ts
  const started = it.status !== 'planning';
  // 页签只由地址栏决定：切换时改写 ?tab=，刷新、离开再后退都回到同一个页签（工作台的任务链接带 ?tab=gantt）
  const tab = iterationTab(params.get('tab'), started);
  const selectTab = (next: string) => {
    const sp = new URLSearchParams(params.toString());
    if (next === 'requirements') sp.delete('tab');
    else sp.set('tab', next);
    const qs = sp.toString();
    router.replace(`/${org}/iterations/${id}${qs ? `?${qs}` : ''}`, { scroll: false });
  };
```

4. `<Tabs defaultValue={initialTab}>` 改为 `<Tabs value={tab} onValueChange={selectTab}>`。

- [ ] **Step 3: 运行测试确认通过**

Run:

```bash
pnpm --filter @flower/web exec vitest run src/features/iterations/model.test.ts
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/web e2e iterations.spec.ts gantt.spec.ts workbench.spec.ts layout.spec.ts
```

Expected: 全部 PASS（`gantt.spec.ts` 与工作台的任务链接用 `?tab=gantt`，行为不变）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/features/iterations/model.ts apps/web/src/features/iterations/model.test.ts "apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx" apps/web/e2e/iterations.spec.ts
git commit -m "feat(web): 迭代详情的当前页签写入地址栏，刷新和后退后保持

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 在迭代的「发布版本」页签一次关联多条需求

**Files:**
- Modify: `packages/core/src/releases/releases.ts`（`linkRequirementsToRelease`；`linkRequirementRelease` 改为调用它；`ReleaseView.requirementIds`）
- Test: `packages/core/test/releases.test.ts`
- Modify: `apps/web/src/server/routes/releases.ts`（`POST /orgs/:org/releases/:id/requirements`）
- Test: `apps/web/test/api/iterations.test.ts`
- Modify: `apps/web/src/features/iterations/model.ts`（`linkCandidates`）
- Test: `apps/web/src/features/iterations/model.test.ts`
- Create: `apps/web/src/app/(app)/[org]/iterations/[id]/link-requirements-dialog.tsx`
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/releases-tab.tsx`（整文件替换，含 Task 8 的粘性操作列）
- Test: `apps/web/e2e/iterations.spec.ts`
- Modify: `docs/p1b-comparison.md`

**Interfaces:**
- Consumes: 现有 `loadRelease`、`loadRequirement`、`requireProductRole`、`recordEvent`；Task 8 的粘性操作列；Task 9 的 `?tab=releases`
- Produces:
  - core：`linkRequirementsToRelease(db: Db, actor: Actor, releaseId: string, requirementIds: string[]): Promise<{ linked: number }>`（去重后 1–200 条，否则 `invalid`「一次关联 1–200 条需求」；不是本产品的需求 `invalid`「只能关联本产品的需求」，整批不写入）；`ReleaseView.requirementIds: string[]`（未删除的已关联需求）
  - 接口：`POST /api/v1/orgs/:org/releases/:id/requirements`，body `{ requirementIds: string[] }`（1–200），返回 `{ linked: number }`
  - web：`linkCandidates(requirements, release, query): LinkCandidate[]`，`type LinkCandidate = { id: string; displayKey: string; title: string; linked: boolean }`；`LinkRequirementsDialog({ org, iteration, release, onClose })`；行按钮 `关联需求 <版本号>`、对话框标题「关联需求到 <版本号>」、提交按钮以「关联所选」开头

- [ ] **Step 1: 写失败的 core 测试**

`packages/core/test/releases.test.ts`：

1. 第 1 行改为 `import { and, eq, inArray } from 'drizzle-orm';`；从 `../src/releases/releases` 的 import 列表加入 `linkRequirementsToRelease`（放在 `linkRequirementRelease` 之后）。

2. 在 `describe('发布版本', …)` 最后一个 `it`（「并发标记发布只有一次成功…」）之后、`});` 之前加入：

```ts
  it('批量关联：去重、跳过已关联、每条新关联记一条事件；有一条不属于本产品时整批不写入', async () => {
    const a = await createRequirement(t.db, owner, pan, { title: '批量关联一' });
    const b = await createRequirement(t.db, owner, pan, { title: '批量关联二' });
    const other = await createRequirement(t.db, owner, doc, { title: '别的产品' });
    // 计划日期取得早，按计划日期倒序时排在最后，不影响后面按产品取第一条的用例
    const rel = await createRelease(t.db, editor, { productId: pan, versionName: '3.1.9', plannedDate: '2026-01-15' });
    const view = async () => (await listReleases(t.db, owner, { productId: pan })).find((r) => r.id === rel.id)!;

    await expect(linkRequirementsToRelease(t.db, editor, rel.id, [a.id, other.id])).rejects.toMatchObject({ code: 'invalid', message: '只能关联本产品的需求' });
    expect(await view()).toMatchObject({ requirementCount: 0, requirementIds: [] });
    expect(await linkRequirementsToRelease(t.db, editor, rel.id, [a.id, a.id])).toEqual({ linked: 1 });
    expect(await linkRequirementsToRelease(t.db, editor, rel.id, [a.id, b.id])).toEqual({ linked: 1 });
    await expect(linkRequirementsToRelease(t.db, viewer, rel.id, [a.id])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(linkRequirementsToRelease(t.db, readToken, rel.id, [a.id])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(linkRequirementsToRelease(t.db, editor, rel.id, [])).rejects.toMatchObject({ code: 'invalid', message: '一次关联 1–200 条需求' });

    const v = await view();
    expect(v.requirementCount).toBe(2);
    expect([...v.requirementIds].sort()).toEqual([a.id, b.id].sort());
    const events = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.type, 'requirement.release_linked'), inArray(domainEvents.subjectId, [a.id, b.id]))),
    );
    expect(events).toHaveLength(2);
  });
```

Run: `pnpm --filter @flower/core exec vitest run test/releases.test.ts`
Expected: FAIL，`linkRequirementsToRelease` 未导出。

- [ ] **Step 2: 实现 core**

`packages/core/src/releases/releases.ts`：

1. `ReleaseView` 里 `requirementCount: number;` 之前加入 `requirementIds: string[];`。

2. `views()` 里把

```ts
  const counts = await tx
    .select({ releaseId: requirementReleases.releaseId, n: sql<number>`count(*)::int` })
    .from(requirementReleases)
    .innerJoin(requirements, eq(requirements.id, requirementReleases.requirementId))
    .where(and(inArray(requirementReleases.releaseId, ids), isNull(requirements.deletedAt)))
    .groupBy(requirementReleases.releaseId);
```

替换为：

```ts
  const links = await tx
    .select({ releaseId: requirementReleases.releaseId, requirementId: requirementReleases.requirementId })
    .from(requirementReleases)
    .innerJoin(requirements, eq(requirements.id, requirementReleases.requirementId))
    .where(and(inArray(requirementReleases.releaseId, ids), isNull(requirements.deletedAt)));
```

并把返回对象里的 `requirementCount: counts.find((c) => c.releaseId === r.id)?.n ?? 0,` 替换为：

```ts
      requirementIds: links.filter((l) => l.releaseId === r.id).map((l) => l.requirementId),
      requirementCount: links.filter((l) => l.releaseId === r.id).length,
```

（`sql` 仍被 `listReleases` 的排序使用，保留 import。）

3. 把整个 `linkRequirementRelease` 函数替换为：

```ts
/** 把多条需求关联到一个发布版本：已关联的跳过，每条新关联记一条事件；任一条不合法时整批不写入。 */
export async function linkRequirementsToRelease(db: Db, actor: Actor, releaseId: string, requirementIds: string[]): Promise<{ linked: number }> {
  const ids = [...new Set(requirementIds)];
  if (ids.length === 0 || ids.length > 200) throw new AppError('invalid', '一次关联 1–200 条需求');
  return withOrg(db, actor.orgId, async (tx) => {
    const rel = await loadRelease(tx, releaseId);
    await requireProductRole(tx, actor, rel.productId, 'editor');
    let linked = 0;
    for (const requirementId of ids) {
      const req = await loadRequirement(tx, requirementId);
      if (req.productId !== rel.productId) throw new AppError('invalid', '只能关联本产品的需求');
      const inserted = await tx
        .insert(requirementReleases)
        .values({ orgId: actor.orgId, requirementId: req.id, releaseId: rel.id })
        .onConflictDoNothing()
        .returning({ releaseId: requirementReleases.releaseId });
      if (inserted.length === 0) continue;
      linked += 1;
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: rel.productId,
        type: 'requirement.release_linked',
        subjectType: 'requirement',
        subjectId: req.id,
        actor,
        payload: { releaseId: rel.id, versionName: rel.versionName },
      });
    }
    return { linked };
  });
}

export async function linkRequirementRelease(db: Db, actor: Actor, releaseId: string, requirementId: string): Promise<void> {
  await linkRequirementsToRelease(db, actor, releaseId, [requirementId]);
}
```

Run: `pnpm --filter @flower/core exec vitest run test/releases.test.ts` 与 `pnpm typecheck`
Expected: PASS（原有「重复关联与解除不报错」「只能关联同产品需求」等用例不变）。

- [ ] **Step 3: 接口的失败测试与实现**

`apps/web/test/api/iterations.test.ts`：在创建、修改、发布版本那个 `it` 所在的 `describe` 末尾（最后一个 `it` 之后、`});` 之前）加入：

```ts
  it('批量关联需求到发布版本：已关联的跳过，只读 Token 被拒绝，空列表返回 400', async () => {
    const rel = (await call(app, 'POST', '/orgs/acme/releases', { session, body: { productId, versionName: '0.9.0', plannedDate: '2026-01-15' } })).body.release;
    const a = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '批量关联一' } })).body.requirement;
    const b = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '批量关联二' } })).body.requirement;
    const path = `/orgs/acme/releases/${rel.id}/requirements`;
    expect((await call(app, 'POST', path, { session, body: { requirementIds: [a.id] } })).body).toEqual({ linked: 1 });
    expect((await call(app, 'POST', path, { session, body: { requirementIds: [a.id, b.id] } })).body).toEqual({ linked: 1 });
    const listed = (await call(app, 'GET', `/orgs/acme/releases?product=${productId}`, { session })).body.releases.find((r: { id: string }) => r.id === rel.id);
    expect(listed.requirementCount).toBe(2);
    expect([...listed.requirementIds].sort()).toEqual([a.id, b.id].sort());
    expect((await call(app, 'POST', path, { token: readToken, body: { requirementIds: [a.id] } })).status).toBe(403);
    expect((await call(app, 'POST', path, { session, body: { requirementIds: [] } })).status).toBe(400);
  });
```

Run: `pnpm --filter @flower/web exec vitest run test/api/iterations.test.ts`
Expected: FAIL，新接口返回 404。

`apps/web/src/server/routes/releases.ts`：

1. 第 1 行 import 改为：

```ts
import { createRelease, linkRequirementRelease, linkRequirementsToRelease, listReleases, markReleaseReleased, unlinkRequirementRelease, updateRelease } from '@flower/core';
```

2. 在 `app.put('/orgs/:org/releases/:id/requirements/:requirementId', …)` 之前加入：

```ts
  app.post('/orgs/:org/releases/:id/requirements', async (c) => {
    const body = await readJson(c, z.object({ requirementIds: z.array(z.string()).min(1).max(200) }));
    return c.json(await linkRequirementsToRelease(deps.db, c.get('actor'), c.req.param('id'), body.requirementIds));
  });
```

Run: `pnpm --filter @flower/web exec vitest run test/api/iterations.test.ts`
Expected: PASS。

- [ ] **Step 4: 候选需求的失败单测与实现**

`apps/web/src/features/iterations/model.test.ts`：import 列表加入 `linkCandidates`（放在 `iterationTab` 之后），文件末尾加入：

```ts
describe('发布版本关联需求的候选', () => {
  const reqs = [
    { id: 'r1', productId: 'p1', displayKey: 'PAN-1', title: '分享链接加密码' },
    { id: 'r2', productId: 'p1', displayKey: 'PAN-2', title: '回收站恢复' },
    { id: 'r3', productId: 'p2', displayKey: 'DOC-1', title: '文档导出' },
  ];

  it('只列本迭代里同产品的需求，按编号或标题过滤，标出已关联的', () => {
    const release = { productId: 'p1', requirementIds: ['r2'] };
    expect(linkCandidates(reqs, release, '')).toEqual([
      { id: 'r1', displayKey: 'PAN-1', title: '分享链接加密码', linked: false },
      { id: 'r2', displayKey: 'PAN-2', title: '回收站恢复', linked: true },
    ]);
    expect(linkCandidates(reqs, release, 'pan-2').map((c) => c.id)).toEqual(['r2']);
    expect(linkCandidates(reqs, release, ' 分享 ').map((c) => c.id)).toEqual(['r1']);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/iterations/model.test.ts`
Expected: FAIL，`linkCandidates` 未导出。

`apps/web/src/features/iterations/model.ts`：在 `iterationTab` 之后加入：

```ts
export type LinkCandidate = { id: string; displayKey: string; title: string; linked: boolean };

/** 发布版本可以关联的需求：本迭代里同产品的需求，按编号或标题过滤（忽略大小写与首尾空白）；已关联的标出来。 */
export function linkCandidates(
  requirements: Array<{ id: string; productId: string; displayKey: string; title: string }>,
  release: { productId: string; requirementIds: string[] },
  query: string,
): LinkCandidate[] {
  const q = query.trim().toLowerCase();
  return requirements
    .filter((r) => r.productId === release.productId)
    .filter((r) => !q || r.displayKey.toLowerCase().includes(q) || r.title.toLowerCase().includes(q))
    .map((r) => ({ id: r.id, displayKey: r.displayKey, title: r.title, linked: release.requirementIds.includes(r.id) }));
}
```

Run: `pnpm --filter @flower/web exec vitest run src/features/iterations/model.test.ts`
Expected: PASS。

- [ ] **Step 5: 写失败的端到端测试**

`apps/web/e2e/iterations.spec.ts`：

1. 第 3 行 import 改为：

```ts
import { acceptInvite, createIteration, createProduct, createRequirement, FAIL_500, json, login, ok, OWNER, setupInstance } from './helpers';
```

2. 文件末尾加入：

```ts
test('发布版本：在迭代的发布版本页签一次关联多条需求，已关联的不能再勾', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0801', '2026-08-01', '2026-08-14');
  const reqs = [];
  for (const title of ['分享链接加密码', '回收站恢复', '离线下载']) {
    const r = await createRequirement(request, productId, title);
    await ok(request.put(`/api/v1/orgs/acme/requirements/${r.id}/iteration`, { data: { iterationId } }));
    reqs.push(r);
  }
  const release = (await json<{ release: { id: string } }>(request.post('/api/v1/orgs/acme/releases', { data: { productId, versionName: '3.2.0', iterationId, plannedDate: '2026-08-14' } })))
    .release;
  await ok(request.put(`/api/v1/orgs/acme/releases/${release.id}/requirements/${reqs[2]!.id}`));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iterationId}?tab=releases`);
  const row = page.getByRole('row').filter({ hasText: '3.2.0' });
  await expect(row.getByRole('cell', { name: '1', exact: true })).toBeVisible();
  await row.getByRole('button', { name: '关联需求 3.2.0' }).click();
  const dialog = page.getByRole('dialog', { name: '关联需求到 3.2.0' });
  await expect(dialog.getByRole('checkbox', { name: /PAN-3/ })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: /PAN-3/ })).toBeChecked();
  await dialog.getByRole('checkbox', { name: /PAN-1/ }).check();
  await dialog.getByRole('checkbox', { name: /PAN-2/ }).check();
  await dialog.getByRole('button', { name: /^关联所选/ }).click();
  await expect(page.getByText('已关联需求')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole('cell', { name: '3', exact: true })).toBeVisible();

  await page.goto(`/acme/requirements/${reqs[0]!.displayKey}`);
  await expect(page.getByRole('region', { name: '发布版本' })).toContainText('3.2.0');
});
```

Run: `pnpm --filter @flower/web e2e iterations.spec.ts`
Expected: 新用例 FAIL，行上没有「关联需求 3.2.0」按钮。

- [ ] **Step 6: 实现页面**

新建 `apps/web/src/app/(app)/[org]/iterations/[id]/link-requirements-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { linkCandidates } from '@/features/iterations/model';
import { api } from '@/lib/api';
import { releaseKeys, requirementKeys, useApiMutation } from '@/lib/queries';
import type { IterationDetail, Release } from '@/lib/types';

/** 从本迭代的需求里勾选多条，一次关联到发布版本；已关联的显示为勾选且不能再改。打开另一个版本时由父组件换 key 重置勾选。 */
export function LinkRequirementsDialog({ org, iteration, release, onClose }: { org: string; iteration: IterationDetail; release: Release | null; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const candidates = release ? linkCandidates(iteration.requirements, release, query) : [];
  const link = useApiMutation(
    () => api<{ linked: number }>(`/orgs/${org}/releases/${release!.id}/requirements`, { method: 'POST', body: { requirementIds: picked } }),
    { invalidate: [releaseKeys(org), requirementKeys(org)], silentError: true, success: '已关联需求', onSuccess: onClose },
  );
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Dialog open={!!release} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>关联需求到 {release?.versionName}</DialogTitle>
        </DialogHeader>
        <Input aria-label="筛选需求" placeholder="输入编号或标题" value={query} onChange={(e) => setQuery(e.target.value)} />
        {candidates.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">本迭代里没有这个产品的需求</p>
        ) : (
          <ul aria-label="本迭代的需求" className="flex max-h-80 flex-col overflow-y-auto">
            {candidates.map((c) => (
              <li key={c.id}>
                <label className="flex h-8 items-center gap-2 rounded-sm px-2 text-[13px] hover:bg-muted">
                  <Checkbox
                    aria-label={`${c.displayKey} ${c.title}`}
                    checked={c.linked || picked.includes(c.id)}
                    disabled={c.linked}
                    onCheckedChange={() => toggle(c.id)}
                  />
                  <span className="font-mono text-muted-foreground">{c.displayKey}</span>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {c.linked && <span className="text-xs text-muted-foreground">已关联</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        <FormError error={link.error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={picked.length === 0 || link.isPending} onClick={() => link.mutate(undefined)}>
            关联所选（<span className="font-mono">{picked.length}</span>）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/app/(app)/[org]/iterations/[id]/releases-tab.tsx` 整文件替换为（保留 Task 8 的粘性操作列，列宽由 `w-40` 放宽到 `w-56` 以放下三个按钮）：

```tsx
'use client';

import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { editableIterationProducts } from '@/features/iterations/model';
import { api } from '@/lib/api';
import { releaseStatusText } from '@/lib/labels';
import { releaseKeys, requirementKeys, useApiMutation, useProducts, useReleases } from '@/lib/queries';
import type { IterationDetail, Release } from '@/lib/types';
import { LinkRequirementsDialog } from './link-requirements-dialog';
import { ReleaseDialog } from './release-dialog';

export function ReleasesTab({ org, iteration: it }: { org: string; iteration: IterationDetail }) {
  const products = useProducts(org);
  const editable = editableIterationProducts(products.data ?? [], it);
  const q = useReleases(org, `iteration=${it.id}`);
  const [dialog, setDialog] = useState<{ open: boolean; release: Release | null }>({ open: false, release: null });
  const [linking, setLinking] = useState<Release | null>(null);
  const markReleased = useApiMutation((id: string) => api(`/orgs/${org}/releases/${id}/released`, { method: 'POST' }), {
    invalidate: [releaseKeys(org), requirementKeys(org)],
    success: '已标记为已发布',
  });

  if (q.isError) return <LoadError message="加载发布版本失败，请重试。" onRetry={() => q.refetch()} />;
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
                <TableHead className="sticky right-0 z-10 w-56 bg-card" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((r) => (
                <TableRow key={r.id} className="group h-10 even:bg-zebra">
                  <TableCell className="font-mono">{r.versionName}</TableCell>
                  {!it.product && <TableCell className="font-mono text-[13px]">{r.productKey}</TableCell>}
                  <TableCell className="text-[13px]">{r.platform?.label ?? '—'}</TableCell>
                  <TableCell className="font-mono text-[13px]">{r.plannedDate ?? '—'}</TableCell>
                  <TableCell className="font-mono text-[13px]">{r.baselineDate ?? '—'}</TableCell>
                  <TableCell className="text-[13px]">{releaseStatusText(r)}</TableCell>
                  <TableCell className="text-right font-mono">{r.requirementCount}</TableCell>
                  <TableCell className="sticky right-0 z-10 bg-card text-right group-even:bg-zebra">
                    {r.canEdit && (
                      <>
                        <Button variant="ghost" size="sm" aria-label={`关联需求 ${r.versionName}`} onClick={() => setLinking(r)}>
                          关联需求
                        </Button>
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
      <ReleaseDialog org={org} open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} iteration={it} release={dialog.release} products={editable} />
      <LinkRequirementsDialog key={linking?.id ?? 'closed'} org={org} iteration={it} release={linking} onClose={() => setLinking(null)} />
    </div>
  );
}
```

- [ ] **Step 7: 更新日常操作对比文档**

`docs/p1b-comparison.md`：

1. 主表第 8 行（「发布版本」）之后加入一行：

```markdown
| 9 | 把一个迭代里的多条需求关联到发布版本 | 123plane：在需求详情里逐条维护所属版本（接口 `PUT /api/requirements/[id]/versions`，每次保存一条需求） | 每条需求单独操作 | 侧边导航「迭代」→ 点迭代 →「发布版本」页签 → 行上「关联需求」→ 勾选 N 条 →「关联所选」 | 5 + N | P1-C 之前 Flower 也只能在需求详情逐条关联（打开需求 → 点开「关联发布版本」→ 选版本，每条 3 步，共 3N）；现在关联 3 条及以上时步数更少，关联 N 条共少 2N − 5 步 | `iterations.spec.ts`「发布版本：在迭代的发布版本页签一次关联多条需求…」 |
```

2. 「需要在用户试用中确认的地方」一节末尾加入一条：

```markdown
- P1-C 起迭代详情的页签写入地址栏（`?tab=`），从浏览器历史或书签回到迭代时直接落在上次的页签；第 5、8 项在第二次及以后进入同一迭代时可以少点一次页签。第 9 项的批量关联是否覆盖日常的关联方式，请在试用中确认。
```

- [ ] **Step 8: 运行测试确认通过**

Run:

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm --filter @flower/core exec vitest run test/releases.test.ts
pnpm --filter @flower/web test
pnpm --filter @flower/web e2e iterations.spec.ts layout.spec.ts
```

Expected: 全部 PASS（`layout.spec.ts` 的「标记发布」在加宽后的粘性操作列里仍完整可见）。

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/releases/releases.ts packages/core/test/releases.test.ts apps/web/src/server/routes/releases.ts apps/web/test/api/iterations.test.ts apps/web/src/features/iterations/model.ts apps/web/src/features/iterations/model.test.ts "apps/web/src/app/(app)/[org]/iterations/[id]/link-requirements-dialog.tsx" "apps/web/src/app/(app)/[org]/iterations/[id]/releases-tab.tsx" apps/web/e2e/iterations.spec.ts docs/p1b-comparison.md
git commit -m "feat: 在迭代的发布版本页签一次关联多条需求

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 完整验证、pan123 界面复验、验证记录与交接文档

**Files:**
- Modify: `docs/p1b-validation.md`（追加「P1-C」一节；只写数量，不写姓名、邮箱或需求标题）
- Modify: `docs/handoff.md`（当前进度、下一步、生产数据副本）
- Modify: `docs/agent-log.md`（最上面加一条记录）

**Interfaces:**
- Consumes: Task 4 Step 5、Step 9 的输出；Task 1–10 的全部改动
- Produces: 验证记录与交接文档

- [ ] **Step 1: 完整验证**

```bash
pnpm typecheck
pnpm --filter @flower/web lint --max-warnings 0
pnpm test
pnpm --filter @flower/web e2e
./scripts/smoke.sh
```

Expected: 全部通过。记下 core、web、migrate 的单测数量与端到端用例数量，写进 Step 4 的协作日志。

- [ ] **Step 2: 在 pan123 上复验（控制方执行）**

`pnpm test` 与端到端测试改过 `flower_app` 的密码，先执行 `pnpm db:migrate`，再 `pnpm dev`。用 `.local-data/test-accounts.md` 里的测试管理员账号登录 pan123（Task 4 已用 rejoin 恢复），把浏览器宽度分别调到约 1440px 与约 760px，重走 2026-09-30 界面测试的三条流程，记录每项「通过 / 问题」：

- 流程 A（人员）：打开一条需求，改负责人与提出人（输入两个字能搜到人，回车选中）；在甘特页签给一个任务改负责人；人员负载页选一个人。成员下拉里没有多人写法、代签写法、工具名，同一个人只出现一次。
- 流程 B（甘特）：打开任务最多的迭代的「甘特」页签，编辑一行的别名、负责人、进度（填 100）、工期（填 12.5）；「需求 / 任务」列不压到负责人列，数字完整显示，行高不变。
- 流程 C（窄宽度与迭代）：约 760px 宽度下依次打开评审表（向右滚到最后一个检查项，编号列仍可见）、成员设置页（打开一个成员的抽屉，完整显示）、一个迭代的「发布版本」页签（不滚动就能看到「标记发布」；用「关联需求」一次关联两条需求）、工作台（单列，「等我签字」的标题可读）；切到「甘特」页签后刷新页面，仍停在甘特。
- 流程 D（重做 2026-09-30 的三项测试）：开始一个迭代后看甘特、时间轴、团队负载与人员负载页；给一条已开始评审的需求把「设计」分配给设计甲，分别登录设计甲、设计乙核对工作台「等我签字」只推给设计甲；按 `docs/p1b-comparison.md` 重走「更新甘特进度」「查看负载」「发布版本（含关联需求）」三项，记下实际步数。

- [ ] **Step 3: 写验证记录**

在 `docs/p1b-validation.md` 末尾追加下面一节。第 1 节表格用 Task 4 Step 5、Step 9 的输出填写，第 2 节用 Step 2 的结果填写；其余照写：

```markdown
## P1-C：界面测试后的修复

数据：2026-09-29 的生产只读副本，本地开发库组织 pan123，于 P1-C 按新的人员规则以 `--as-of 2026-09-29 --replace` 重导，3 个测试账号用 `legacy rejoin` 恢复成员关系。对账报告全文在 `.local-data/reports/`（不进仓库）。

### 1. 人员数据

| 项 | 重导前（2026-09-30） | 重导后 |
|---|---|---|
| 人员对照表条数 | 124 | （Step 5 的 peopleAfter） |
| 成员总数（含 3 个测试账号） | 127 | （Step 9 第一行第 1 列） |
| 多人写法成员 | 26 | 0 |
| 代签写法成员 | 2 | 0 |
| Agent 成员 | 0 | （Step 9 第一行第 2 列） |
| 带头衔的成员 | 13 | （Step 9 第一行第 6 列，头衔后不是汉字姓名、未解析的写法） |
| 对账报告：人员拆分 / 人员合并 / 代签写法（行数） | — | （Step 5 的 splitStrings / mergedPeople / proxyStrings） |
| 写了多人、按第一人导入负责人的任务 | 30（负责人为多人写法成员） | （Step 9 第二行第 3 列），均有负责人 |
| 未自动处理的写法 | — | 角色词或占位写法约 10 个、同音错字与只有拼音的写法各 1 例，按用户在检查点的决定处理 |

### 2. 界面复验（1440px 与约 760px）

| 流程 | 1440px | 约 760px | 问题 |
|---|---|---|---|
| A 人员：搜索选择负责人、提出人、任务负责人、人员负载 | （通过 / 问题） | （通过 / 问题） | |
| B 甘特：编辑一行，列不重叠，数字完整显示 | | | |
| C 窄宽度与迭代：评审表、成员抽屉、发布版本（含批量关联）、工作台、页签刷新后保持 | | | |
| D 重做 09-30 三项：迭代与甘特、负载；「等我签字」按分配推送；更新甘特进度 / 查看负载 / 发布版本的实际步数 | | | |

### 3. 留给后续阶段

- 角色词或占位写法的统一处理规则。
- 任务支持多个负责人（需要改表）；目前多人写法的任务按第一人导入，原文在 `tasks.meta.ovAssignee`。
- 评审表筛选写入地址栏。
```

- [ ] **Step 4: 交接文档与协作日志**

`docs/handoff.md`：

1. 「当前进度」列表末尾加入：

```markdown
- **P1-C 界面测试后的修复：已完成**（分支见协作日志）。
  - 迁移：一个字段写了多人时按字段拆分（单值取第一人、多值每人一条）；头衔、昵称、短名、邮箱前缀写法并入本人；「代X by Y」按实际操作人导入；工具账号建为 Agent 成员。对账报告新增「人员拆分」「人员合并」「代签写法」三节。pan123 已在用户确认后重导，测试账号用 `legacy rejoin` 恢复。
  - 界面：全部成员选择换成可搜索的 `MemberPicker`；甘特任务表固定列宽；800px 宽度下页面不再被撑宽（评审表编号列、发布版本操作列固定，工作台单列）；迭代详情页签写入地址栏；发布版本页签可以一次关联多条需求。
  - 复验记录见 `docs/p1b-validation.md`「P1-C」一节。
```

2. 「下一步」整节替换为：

```markdown
1. 用户按 `docs/p1b-validation.md`「P1-B2」第 3、4 节与「P1-C」第 2 节在本地 pan123 上验收并试用，问题与阻力记在对应位置。
2. 角色词或占位写法是否需要统一规则，按试用反馈决定。
3. 进入 P2（文档）之前，确认 P1-B2、P1-C 计划「设计决定」表「留给后续阶段」一行里哪些要提前。
```

3. 「生产数据副本」一节的列表里加入一项：

```markdown
- 测试账号清单 `test-accounts.md`（含共用密码，只在本地）与供 `legacy rejoin` 使用的 `test-accounts.json`（只有邮箱、角色、职能标签）；每次 `--replace` 重导后执行一次 `rejoin`，命令见 `CLAUDE.md`；
```

`docs/agent-log.md`：在「## 记录」下面、现有第一条之前加入（数量用 Step 1 的实际结果填写）：

```markdown
### 2026-10-01 · 本地 · P1-C：界面测试后的修复
- 分支 / PR：`feat/p1c-polish`
- 做了什么：
  - migrate：人员对照表拆分多人写法、合并头衔 / 昵称 / 短名 / 邮箱前缀写法、工具账号建为 Agent（`people.ts`）；导入时单值字段取第一人、多值字段每人一条，代签写法按实际操作人；对账报告增加人员三节；新增 `rejoin` 命令。pan123 经用户确认后重导。
  - web：共享的可搜索成员选择框 `MemberPicker`，替换 9 处成员下拉；甘特任务表固定列宽；窄宽度布局；迭代详情页签写入地址栏；发布版本页签批量关联需求（core `linkRequirementsToRelease`、接口 `POST /orgs/:org/releases/:id/requirements`）。
  - 共享件：e2e `helpers.ts` 新增 `expectNoPageOverflow`、`textFits`；`features/members/model.ts` 新增 `pickerOptions`、`filterPickerOptions`。
- 怎么验证的：`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm test`（core N、web N、migrate N）、完整端到端测试（N 个）、`./scripts/smoke.sh` 全部通过；pan123 复验见 `docs/p1b-validation.md`「P1-C」。
- 留给对方：
  - 布局守护用例在 `e2e/layout.spec.ts`；以后新增表格或卡片网格的页面，照样在 1440 与 800 宽度下加 `expectNoPageOverflow`。
  - 留给后续阶段的项见 P1-C 计划「设计决定」表最后一行。
```

- [ ] **Step 5: 提交**

```bash
git add docs/p1b-validation.md docs/handoff.md docs/agent-log.md
git commit -m "docs: 记录 P1-C 的 pan123 重导与界面复验，更新交接文档与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## P1-C 完成标准

- `pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm test`、完整端到端测试、`./scripts/smoke.sh` 全部通过。
- pan123 在用户确认后按新人员规则重导：没有多人写法、代签写法成员；工具账号为 Agent；3 个测试账号已恢复。
- 9 处成员选择都能搜索；1440 与 800 宽度下的布局守护用例通过；迭代页签刷新与后退后保持；发布版本页签可以一次关联多条需求。
- `docs/p1b-validation.md`「P1-C」一节、`docs/handoff.md`、`docs/agent-log.md` 已更新，不含姓名、邮箱或需求标题。
