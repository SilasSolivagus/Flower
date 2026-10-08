# 协作日志

本地开发 agent 与云端 agent（GitHub 仓库直连）之间的交接记录。

- **开工前**：读最上面几条，确认对方最近改了什么、留下了什么待办。
- **完成一项工作后**（一次合并、一个 PR、一次值得交代的提交）：在「记录」最上面加一条，与代码放在同一个提交或 PR 里。
- 只追加新条目，不改别人的旧条目；待办完成后，在自己的新条目里写明「已处理 XX 日的待办」。
- 两边同时追加导致冲突时，两条都保留，按时间排序。
- 长期有效的决定和项目背景仍写在 `docs/handoff.md`，这里只记「谁在什么时候做了什么」。

条目格式：

```
### YYYY-MM-DD · 本地 / 云端 · 一句话标题
- 分支 / PR：
- 做了什么：
- 怎么验证的：
- 留给对方：（没有就写"无"）
```

## 记录

### 2026-10-08 · 云端 · 审查 P1-C（PR #8）：修复同名人员被合并、rejoin 跳过导入成员
- 分支 / PR：`feat/p1c-polish`（PR #8）
- 做了什么：
  - **人员误合并**（`packages/migrate/src/people.ts`、`mapping.ts`、`plan.ts`）：邮箱不同的两个同名的人（例如两个「王伟」）会被当成一个人，三处都有问题：
    - suggest：带邮箱的写法先按名字查找，第二个「王伟」的账号被并进第一个，整个人从对照表里消失，名下记录全算到第一个人头上（main 上就是这样）。改为自带邮箱的写法先按邮箱找，按名字找到的人邮箱不同时另建一人。
    - 合并规则 1、2（头衔 / 昵称写法、已是别人的写法）在多个候选时按邮箱和出现次数挑一个，是在猜。改为与规则 3、4 一样只在唯一候选时合并；可并入的候选会在下一轮先并走，不影响正常合并。没能唯一合并的头衔写法也不再改名成同名的第三个人，保留原写法，留给用户在对照表里处理。
    - import：Resolver 遇到多人共用的写法时静默取最后一个人。改为记成对账问题「人员对照表中多人共用这个写法，无法判断是谁」，拒绝写入，由用户给其中一人改显示名或删去该别名。
  - **rejoin 跳过导入成员**（`packages/migrate/src/rejoin.ts`、`cli.ts`）：
    - 原来按邮箱判断「已在组织」。导入时已按邮箱建好、但还没关联账号的成员（旧数据里的本人）会被判成已在组织而跳过，账号始终进不来，CLI 却显示「已跳过」。之前 3 个测试账号的邮箱不在旧数据里，所以没暴露。
    - 改为只有已关联账号的成员才跳过；未关联账号的同邮箱成员，邀请时用 `memberId` 绑定到这个成员（结果为 `bound`），保留他名下的需求、任务和签字记录，不另建一个没有历史的新成员。
  - 其余重点没有问题：
    - 重导仍幂等：ID 由来源键和对照表 key 确定性生成；suggest 对自身输出再跑一次结果不变，同名场景也加了这条断言。
    - 对照表里标 `keep` 的条目、用户改过的显示名都保留。
    - MemberPicker 的 8 个调用点都经 `activePeople`（在职且为 human）过滤，甘特任务行由 gantt-tab 传入同样过滤后的列表；没有遗留的成员下拉。
    - 批量关联：ID 去重后排序再逐条插入，外键加锁顺序一致；任一条不属于本产品整批回滚；只读成员和只读 Token 被拒；已有并发测试。
- 怎么验证的：
  - 新增 3 个测试，均先在原代码上失败、修复后通过：
    - `people.test.ts`：同名两人保留为两人、头衔写法不猜；导入时多人共用写法报问题；
    - `rejoin.test.ts`：同邮箱占位成员被绑定而不是跳过，名下需求仍归他，再跑一次时跳过。
  - core 253、web 136、migrate 89、e2e 65 全部通过；类型检查、lint（`--max-warnings 0`）通过。
- 留给对方：
  - **下次重导 pan123 前先 `--dry-run`**：如果真实数据里有同名的人，现在会报「多人共用这个写法」，需要在 `people.json` 里区分后再导入。
  - 重导后再跑一次 `rejoin`：清单里邮箱与导入成员相同的账号，现在会绑定到该成员（输出里会写明个数）。
  - 选人只在前端过滤离职成员和 Agent，服务端 `assertMemberInOrg` 仍接受任何本组织成员（例如通过 API 把任务指派给已离开的成员）。是否要在服务端也拦，由你决定。

### 2026-10-01 · 本地 · P1-C：界面测试后的修复
- 分支 / PR：`feat/p1c-polish`
- 做了什么：
  - migrate：人员对照表拆分多人写法、合并头衔 / 昵称 / 短名 / 邮箱前缀写法、工具账号建为 Agent（`people.ts`）；导入时单值字段取第一人、多值字段每人一条，代签写法按实际操作人；对账报告增加人员三节，并补一行说明会签栏的代签不计入「代签写法」节。pan123 经用户确认后重导。新增 `rejoin` 命令，检查成员是否已在组织后才写入，避免重复加入报错。
  - web：共享的可搜索成员选择框 `MemberPicker`，替换 9 处成员下拉；甘特任务表固定列宽；窄宽度布局；迭代详情页签写入地址栏；发布版本页签批量关联需求（core `linkRequirementsToRelease`、接口 `POST /orgs/:org/releases/:id/requirements`）。
  - 共享件：e2e `helpers.ts` 新增 `expectNoPageOverflow`、`textFits`；`features/members/model.ts` 新增 `pickerOptions`、`filterPickerOptions`。
  - 最终审查后的修复（3 个提交）：批量关联需求去重后排序，避免并发重叠批次死锁（`8f82d76`）；发布版本关联对话框状态只存版本 id、渲染时从查询结果取版本，避免显示过期的已关联状态（`391fae4`）；迁移测试补齐 id 稳定性、suggest 幂等与报告说明的测试缺口（`d53c262`）。Task 11 的完整验证与 pan123 复验在这三个提交之后进行，覆盖的是最终代码。
- 怎么验证的：`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm test`（core 253、web 136、migrate 86）、完整端到端测试（65 个）、`./scripts/smoke.sh` 全部通过；pan123 复验见 `docs/p1b-validation.md`「P1-C」。
- 留给对方：
  - 布局守护用例在 `e2e/layout.spec.ts`；以后新增表格或卡片网格的页面，照样在 1440 与 800 宽度下加 `expectNoPageOverflow`。
  - 几处留观的小问题：`MemberPicker` 搜索结果为空时，搜索框的 `aria-controls` 仍指向一个未渲染的 listbox id；成员抽屉里「产品角色」下拉文字「默认（编辑）」在窄宽度下略被截断；发布版本关联对话框新增的刷新校验 e2e 用例会多等约 11 秒（等待查询 `staleTime` 过期触发真实重取）。
  - 留给后续阶段的项见 P1-C 计划「设计决定」表最后一行：角色词或占位写法的统一处理规则；任务支持多个负责人（需要改表）；评审表筛选写入地址栏。

### 2026-09-30 · 云端 · 审查 P1-B2（PR #7）：四个重点均无问题，未改代码
- 分支 / PR：`feat/p1b2-gantt-workbench`（PR #7）
- 做了什么：按要求审查四个重点，都没有发现需要修的问题，本次只追加这条记录。
  - **工作台跨组织读取**：
    - 成员关系用 `listMyOrganizations`（withSystem）查找，只含在职成员、未删除的组织。
    - 每个组织各开一个 `withOrg`，以该组织的成员身份、按可见产品读取，不在同一个 RLS 上下文里混读。
    - `/me/workbench` 用 `requireAccount`：Bearer 认证不会设置 `account`，Token 访问返回 401，已有 API 测试覆盖。
  - **「等我签字」**：
    - `checkSnapshots` 只把「在职且当前持有该标签」的被分配人计入分配；`waitingRules` 有这样的人时只推给他们，否则退回全部持有者。
    - 评审未开始的不推。
    - 只读 Token 在评审表上没有待签，也没有代签（角色被压到 viewer）。
    - 分配给离职成员、分配给不持有标签的成员这两种回退都有测试。
  - **任务写路径加锁**：
    - 新建时先锁迭代（标重点时 UPDATE，否则 SHARE），再插入任务；需求由外键在之后加锁，顺序为「迭代 → 需求」，与 B1 的规则一致。
    - 修改只在可能新增重点时锁迭代，且在锁任务之前。
    - 删除迭代在迭代的 UPDATE 锁下检查任务数，与新建互斥。
    - 临时并发探针（未提交）把新建任务（含标重点）、修改任务、开始迭代、删除迭代、需求进出迭代按随机顺序并发跑了 80 轮，数据库错误 0 次。
  - **迁移 0008 的唯一约束** `UNIQUE NULLS NOT DISTINCT (requirement_id, member_id, function_tag_id, platform_option_id)`：
    - 需要 Postgres 15+，项目用 pg17。
    - 现有数据不会有重复，不会让迁移失败：本 PR 之前没有新增分配的接口；导入工具按「需求 + 成员 + 平台」去重，标签固定为「开发」；B1 的平台选项迁移是一一映射。
    - 重复分配返回 409「已经有相同的分配」，有测试。
- 怎么验证的：core 251、web 131、migrate 63、e2e 53 全部通过；类型检查、lint（`--max-warnings 0`）通过。
- 留给对方：
  - 专项迭代的甘特里，`starredCount` 只统计操作者可见产品的任务；而重点上限 10 按整个迭代计算。看不到全部产品的人可能看到「还能标」却被拒绝，提示文案可以说明一下。不影响数据正确性。

### 2026-09-30 · 本地 · P1-B2：甘特、人员负载、评审表与工作台
- 分支 / PR：`feat/p1b2-gantt-workbench`
- 做了什么：
  - core：排期纯函数（push 的工作日进度、覆盖规则、热力图色阶、迭代概览，浏览器安全子路径 `@flower/core/schedule`）；任务新建 / 修改 / 删除（每个迭代最多 10 个重点，标重点时锁迭代防并发超限）；甘特、按需求、按人跨迭代的任务查询；按流程检查项生成的评审队列（整体评审状态、会签进度、等我签字含代签）；跨组织工作台（`listMyOrganizations` 查成员关系，逐个组织 `withOrg` 读取）。
  - 有任务的迭代不能删除（B1 只检查需求与发布版本）。
  - migrate：push 甘特任务的标记映射为 `attention`，手动进度写入 `meta.progress`；pan123 已重导。
  - web：甘特页签、时间轴与团队负载、人员负载页、评审表、工作台（登录后默认页），概览页移到 `/[org]/overview`；统一加载失败状态与网络错误中文提示，修复 AuthGate 与产品设置在 5xx 时的表现、`/admin` 两个一级标题、未处理的 `mutateAsync` 拒绝。
  - 检查项组件移到 `components/check-items.tsx`，需求详情与评审表共用。
  - 需求分配的新增与删除（core、接口、需求详情「分配」区块）；「等我签字」按分配推给对应的人，没有有效分配（被分配人在职且持有该标签）时推给该职能标签的全部成员，且只统计评审已开始的需求；新增迁移 `0008_*.sql`，给 `requirement_assignments` 加唯一约束。
  - 共享件：`components/load-error.tsx` 的 `QueryError`；e2e `helpers.ts` 新增 `acceptInvite`、`createMember`、`FAIL_500`、`applyReviewWorkflow`；`assertPlatformOption` 移到 `requirements/context.ts`，供 `releases.ts` 与 `assignments.ts` 两个服务共用。
  - `docs/p1b-comparison.md`：日常操作新旧对比，列出 3 项比旧系统多几步的操作。
- 怎么验证的：`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm test`（core 250、web 131、migrate 63）、完整端到端测试（53 个）、`./scripts/smoke.sh` 全部通过；真实数据性能见 `docs/p1b-validation.md`「P1-B2」第 2 节。
- 留给对方：
  - 用户验收与试用（`docs/p1b-validation.md`「P1-B2」第 3、4 节）。
  - 以后新增同时锁迭代与任务的代码，保持「先迭代、后任务」的顺序。
  - 留给后续阶段的项见 P1-B2 计划「设计决定」表最后一行。

### 2026-09-30 · 云端 · 审查 P1-B1（PR #6）：修复加入迭代与开始迭代的死锁
- 分支 / PR：`feat/p1b1-iterations`（PR #6）
- 做了什么：
  - 按要求审查四个重点：
    - 迭代与发布版本的权限：常规迭代需产品编辑及以上，专项需组织管理员（`isOrgAdmin` 同时拒绝只读 Token 和限定产品的 Token），强制加入需产品管理员；发布版本的增改、发布、关联都需编辑及以上。
    - 专项迭代的可见性：详情、计数、范围对比、按迭代列发布版本都按可见产品过滤；看不到任何产品的访客看不到专项。
    - 字段覆盖时平台选项的迁移：只改指向被复制字段自身选项的发布版本和开发分配，复制非平台字段不会误改；也没有「取消覆盖」的反向路径需要处理。
    - 以上三项没有发现问题，测试也覆盖到了。
  - **修复死锁**（`packages/core/src/iterations/membership.ts`）：
    - 加入迭代原来先锁需求（FOR UPDATE）再锁目标迭代（FOR SHARE）；开始迭代先锁迭代（FOR UPDATE），写承诺快照时外键再锁其中的需求。两边顺序相反。
    - 两个迭代同时开始、又有需求在两者之间互换时，会形成 4 个事务的等待环，Postgres 报 40P01，用户看到 500。
    - 改为先锁目标迭代、再锁需求，全部路径统一为「先迭代、后需求」，不可能再成环。错误返回顺序不变（仍先校验权限，再报「迭代不存在」）。
    - 这和本地 09-30 那条 e2e 清库死锁是两回事：那条在测试工具里，这条在业务代码里，生产环境也会遇到。
  - 新增 `packages/core/test/iteration-locking.test.ts`：30 轮随机顺序并发执行「开始 A、开始 B、A→B、B→A、移出、加入」，断言没有任何失败。
- 怎么验证的：
  - 临时探针在修复前 40 轮出现 6 次 40P01，修复后连续 3 次共 120 轮 0 次。
  - 回归测试在未修复的代码上失败（4 次 40P01），修复后通过。
  - core 203、web 111、migrate 60、e2e 37 全部通过；类型检查、lint（`--max-warnings 0`）通过。
- 留给对方：
  - 以后新增同时锁迭代和需求的代码，保持「先迭代、后需求」的顺序。
  - `visibleProductIds` 对每个产品各查两次（N+1），产品多了以后迭代列表会变慢，届时可改成一次查询。目前不影响性能数据。

### 2026-09-30 · 本地 · e2e：resetDatabase 的 TRUNCATE 与上一用例残留请求死锁（补记 a9eda4a）
- 分支 / PR：`feat/p1b1-iterations`，代码在 a9eda4a
- 做了什么：全量 e2e 偶发 `requirements.spec.ts:138` 在 `beforeEach` 报 `PostgresError: deadlock detected`。Postgres 日志中 09-29、09-30 的几次死锁都是 `resetDatabase()` 的 TRUNCATE（逐表取 ACCESS EXCLUSIVE）与 webServer 上一用例残留的只读查询（`field_options`、`product_members`、`sessions`）互相等待，与签字 / 流程流转和迭代锁顺序无关。a9eda4a 让 `apps/web/e2e/db.ts` 在 40P01 时重试 TRUNCATE（最多 5 次），并用 `e2e/db.spec.ts` 构造该交错作回归测试。
- 怎么验证的：独立脚本构造同样的环，修复前稳定报 40P01、修复后通过；`requirements.spec.ts` 8 个用例通过；lint、typecheck 通过。全量 e2e 未跑。
- 留给对方：无

### 2026-09-30 · 本地 · P1-B1：迭代、发布版本、阻塞项与关联、结构树维护
- 分支 / PR：`feat/p1b1-iterations`
- 做了什么：
  - core：迭代（新建、修改、状态流转、开始时写承诺快照、删除、范围对比）、加入 / 移出迭代（流程准入条件、产品管理员强制）、发布版本、阻塞项、需求关联、结构树维护、产品成员角色列表；新增错误码 `precondition_failed`（HTTP 412）。
  - 字段按产品覆盖时同时迁移发布版本与开发分配的平台选项（已处理 2026-09-29 P1-A 待办）。
  - web：迭代列表与详情、需求详情的迭代选择 / 阻塞项 / 关联 / 发布版本、产品设置结构树页签；修复产品管理员的面包屑、选项编辑与访客角色页签。
  - 常规迭代的新建 / 修改 / 状态流转 / 删除需要产品 editor 及以上权限（spec §2.2）；专项迭代仅组织管理员；强制加入仅产品管理员。
  - 抽出共享组件与工具：`components/load-error.tsx`，e2e 的 `helpers.ts`（`ok`、`createProduct`、`json`、`createRequirement` 等），以及成员相关的 `canListMembers`、`activePeople`。
  - 修了需求关联新增时的一个竞态：搜索框只在文字没变时才清空，避免和列表刷新冲突。
- 怎么验证的：`pnpm typecheck`、`pnpm test`（core / web / migrate）、`pnpm --filter @flower/web lint --max-warnings 0`、完整端到端测试全部通过；真实数据性能见 `docs/p1b-validation.md` 第 2 节。
- 留给对方：人工验收清单（`docs/p1b-validation.md` 第 3 节）由用户执行；P1-B2 范围见 P1-B1 计划「留给 P1-B2」。

### 2026-09-29 · 云端 · 清零 web lint 并加进 CI
- 分支 / PR：`claude/compassionate-babbage-ei9baf`
- 做了什么：
  - 8 个错误里有 7 个是 `react-hooks/set-state-in-effect`：在 `useEffect` 里把接口数据拷进表单状态。改成 React 文档推荐的「渲染期间调整状态」：记住上次同步的来源值，变了就在渲染时更新。行为不变，只是少一轮渲染。涉及需求列表的搜索框、组织信息、成员抽屉、产品详情、流程编辑器、个人设置、层级名称编辑器。
    - 注意：这类写法里「上次同步值」的初始值要设为空，不能设为当前数据。否则 React Query 已有缓存时首屏不会填充表单。
  - `test/api/helpers.ts` 的 `body: any` 是有意的（测试直接读任意响应字段），改为带说明的单行禁用。
  - 顺手清掉 3 个警告：首页 `useEffect` 依赖每次渲染都是新数组，改为依赖唯一组织的 slug；`api.test.ts` 未使用的参数。
  - CI 的 test 任务在类型检查之后加一步 `pnpm --filter @flower/web lint --max-warnings 0`（零错误、零警告）；`CLAUDE.md` 命令表同步。
  - `docs/handoff.md`：P1-A 改为「已合并（PR #4）」。
- 怎么验证的：lint 0 错误 0 警告，同一条命令在 main 上失败、在本分支通过；类型检查通过；core 159、web 83、migrate 60、e2e 25 全部通过（e2e 覆盖了上面改到的每个表单）。
- 留给对方：
  - 以后 web 代码也要过 lint，本地提交前跑一次 `pnpm --filter @flower/web lint`。
  - 新写「接口数据 → 表单初值」时不要再用 `useEffect` + `setState`，参照上面的写法。

### 2026-09-29 · 云端 · 审查 P1-A（PR #4）：修复 --replace 覆盖后无人能登录，补跨产品/跨组织权限测试
- 分支 / PR：`feat/p1a-requirements`（PR #4）
- 做了什么：
  - 按本地条目的要求审查了三个重点：
    - 租户隔离：17 张新表全部有 RLS，并有目录级测试兜底；新代码没有 `withSystem` 或管理员连接绕过；所有从请求里带进来的 ID（成员、结构树节点、字段选项、父评论）都在 `withOrg` 里校验归属。
    - 只读 Token：流转、检查项、字段、增改都需要 editor，只读 Token 会被降为 viewer；签字、评论、标记已读都显式拒绝只读 Token；详情里的 `canSign`、`canSignOnBehalf`、`canForce` 也随之收紧。
    - `deleteOrgData`：覆盖了全部租户表，删除顺序满足外键约束。
  - 修复 `packages/migrate/src/write.ts`：`--replace` 会删掉组织现有的全部成员关系。如果导入时没带 `--owner-email`，计划里就没有关联账号的成员，覆盖后没有任何账号能登录该组织，界面上也无法恢复。现在覆盖时若计划里没有关联账号的所有者，直接拒绝并提示加 `--owner-email`，原数据不动。首次导入不受影响。
  - 在 `packages/core/test/requirement-workflow.test.ts` 补了两个测试：
    - 限定产品的写 Token 读写不到其他产品的需求（详情、列表、修改、强制流转、签字、评论）；
    - 其他组织的成员拿到需求 ID 也读写不到。
    两个都在现有代码上直接通过，属于防回归；故意去掉产品范围校验后，前者确实会失败。
- 怎么验证的：新的 `--replace` 测试先在未修复的代码上复现（覆盖成功、所有者被删），修复后通过。core 159、web 83、migrate 60、e2e 25 全部通过，类型检查通过。
- 留给对方：
  - `--replace` 一次删掉整个组织，包括导入之后用户在 Flower 里产生的全部数据，目前唯一的保护就是这个开关。生产环境切换后如果还要重导，建议加一道确认：先列出将删除的非导入数据量，再要求输入组织 slug。这是设计取舍，没有改，由你决定。
  - `--dry-run` 不会提示「组织已存在、正式运行需要 `--replace`」，可以顺手补一行提示。

### 2026-09-29 · 本地 · P1-A：需求数据模型、旧数据迁移、需求列表与详情
- 分支 / PR：`feat/p1a-requirements`；已合并 PR #3 并把 main 合入本分支
- 做了什么：
  - core 新增 17 张租户表（均开启 RLS）、需求/流转/会签/评论服务与 13 个 API；
  - 新增 `packages/migrate`，从 123plane、push、prd 三份只读副本迁移，带可编辑对照表和对账报告；
  - web 新增需求列表页和详情页；
  - 任务天数支持半天；字段按产品覆盖时同步迁移已有字段值。
- 怎么验证的：core 157、web 83、migrate 59 个测试通过；端到端 25 个通过；类型检查、构建通过；真实数据导入本地开发库 764 条需求，对账 0 问题，性能见 `docs/p1a-validation.md`。
- 留给对方：
  - 请审查本 PR，重点是租户隔离、只读 Token 权限和迁移的 `--replace`；
  - web lint 在本分支上是 8 个错误（新增 1 个），P1-A 合并后再清理；
  - `docs/handoff.md` 进度已在本 PR 更新，已处理 2026-09-29 云端条目里的这条待办。

### 2026-09-29 · 云端 · 加 GitHub Actions CI，修复职能标签 e2e 用例的偶发失败
- 分支 / PR：`claude/compassionate-babbage-ei9baf`
- 做了什么：
  - 新增 `.github/workflows/ci.yml`，PR 和推送到 `main` 时并行跑三个任务：类型检查 + 单元测试、Playwright 端到端测试、`scripts/smoke.sh` 镜像冒烟测试。前两个任务用 `pgvector/pgvector:pg17` 服务容器，映射到 54329 端口，账号与 `docker-compose.dev.yml` 一致，测试代码无需改动。端到端测试失败时上传 `apps/web/test-results/`（含 trace）作为构建产物。
  - 修复 `apps/web/e2e/tags.spec.ts` 的偶发失败：`getByRole('textbox', { name: '标签名称' })` 默认是子串匹配，会同时匹配新增表单里的「新标签名称」输入框。点「添加」后表单要等列表重新请求完才关闭，这段时间里「4 个标签 + 表单输入框」恰好凑满 5 个，于是 `.last()` 选中了「测试」那一行。改为 `exact: true`。
  - 新增本文档，并在 `CLAUDE.md`、`docs/handoff.md` 中指向它。
- 怎么验证的：`pnpm typecheck` 通过；`pnpm test` 通过（core 113、web 75）；e2e 全部 17 个通过，`tags.spec.ts` 连续重复 8 次全部通过。冒烟测试在云端容器里跑不了（沙箱代理证书在 docker build 内不受信任），但在 GitHub Actions 上首次运行即通过；三个 CI 任务全绿。
- 留给对方：
  - `pnpm --filter @flower/web lint` 目前有 7 个错误、3 个警告（如 `apps/web/test/api/helpers.ts` 的 `no-explicit-any`），所以暂未放进 CI。清理完后可以在 CI 的 test 任务里加一步 lint。
  - `docs/handoff.md` 里「当前进度」还写着「P0-B 尚未开始」，实际已由 PR #2 合并，下次更新时顺手改掉。
