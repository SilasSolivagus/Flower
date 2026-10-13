# Flower P3-B1 站内通知、@ 成员、关注、个人通知偏好与企业微信绑定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 成员在评论、需求描述与 PRD 正文里 @ 同事；被 @、被指派、关注对象变化、等我签字、系统告警五类通知进入顶栏铃铛与通知页，并按个人偏好同时在产品的企业微信群里 @ 到本人、或合并成邮件；成员的企业微信账号可由组织管理员手动填写或 CSV 批量导入，也可由成员扫码绑定（企业微信自建应用网页授权，本地用模拟接口验证）。

**Architecture:** 业务写入只在领域事件里多记两类信息：本次新增的被 @ 成员（`mentionedMemberIds`）与新的负责人 / 被指派人。通知的收件人计算与分发全部放在 P3-A 的后台循环里：每个组织一行游标（`notification_cursors`），每轮以 `FOR UPDATE SKIP LOCKED` 锁住游标，按 `(occurred_at, id)` 读取游标之后、且早于仍在进行中的事务开始时间的事件（最多 500 条），每条在独立的子事务里算收件人、写站内通知、补自动关注，成功后前移游标；同一条连续失败 3 次跳过。企业微信与邮件提醒在一轮结束时按产品 / 按人合并，写成 P3-A 发送队列里 `kind = personal` 的待发记录，由原有的限流、重试与发送记录处理。纯逻辑（@ 写法、收件人排名、合并分条）放在 `links/syntax.ts`、`member-notifications/content.ts`、`member-notifications/dispatch.ts`，企业微信账号与网页授权放在 `packages/core/src/wecom/`。页面：顶栏铃铛、`/[org]/notifications`、纯文本输入框与 BlockNote 的 @ 补全和成员标签、需求与 PRD 详情的关注按钮、个人设置的通知偏好与企业微信绑定、组织设置成员页的企业微信账号列与导入、推送页的「企业微信应用」页签与个人通知邮件通道、产品设置推送页签的个人提醒通道。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui、BlockNote 0.55（自定义内联元素）、Vitest、Playwright。不新增依赖：企业微信接口用 Node 内置 `fetch`，测试用注入的假 `fetch`（core）与本机假企业微信服务（`apps/web/test/fake-wecom.ts`）。

**Spec:** `docs/superpowers/specs/2026-10-12-flower-p3b1-member-notifications-design.md`（用户 2026-10-12 确认，本计划的约束来源）；上位文档 `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§6.1 领域事件、§6.2 通知中心）；P3-A 设计 `docs/superpowers/specs/2026-10-10-flower-p3a-notifications-design.md` 与计划 `docs/superpowers/plans/2026-10-10-flower-p3a-notifications.md`（后台循环、发送队列、加密、假接收端）。逐条决定见下方「设计决定」，与设计、代码或数据不一致之处见文末「与设计、代码或数据的冲突」。

## Global Constraints

- **今天是 2026-10-12。** 计划、验证记录、协作日志里的日期以此为准。
- **测试里不调用真实企业微信。** core 单测给网页授权注入假的 `fetch`；接口测试与端到端只连本机假服务（`http://127.0.0.1:{随机端口}`，`apps/web/test/fake-webhook.ts`、`apps/web/test/fake-wecom.ts`），不连外网。群消息只发给假接收端；测试群联调只在 Task 20 由控制方进行，**每一次**发送前都先征得用户同意。
- **网页授权只访问 `qyapi.weixin.qq.com`。** 服务端调用企业微信的基础地址是常量 `WECOM_API_BASE = 'https://qyapi.weixin.qq.com'`，经 `ApiDeps.wecomApiBase` 注入，只有测试传入本机假服务的地址；生产配置与环境变量都不能改它。扫码页 `login.work.weixin.qq.com` 只由浏览器跳转打开，服务端不访问。
- **`state` 一次性、10 分钟过期。** 存 SHA-256 摘要，回调时先作废再换取；重放、过期、不属于当前成员的一律拒绝，有测试。
- **密钥不出现在任何响应里。** 企业微信应用密钥按 P3-A 的方式加密（`encryptConfig`，`v1:` 密文），接口只返回 `secretHint`（`****` 加末 4 位）；领域事件 `changes` 里只记 hint；企业微信报错信息不拼接请求网址（`gettoken` 的网址里含密钥）。各层都有断言。
- **执行代理不运行 `pnpm dev`，不读取 `.local-data/`。** 界面检查一律写成 Playwright 用例（独立的 `flower_e2e` 库与 3100 端口，`FLOWER_NOTIFY_WORKER=off`、`FLOWER_NOTIFY_TICK_API=1`，用 tick 接口驱动后台循环）；真实数据上的界面复验由控制方在 Task 20 完成。本地开发库只做只读查询与 `pnpm db:migrate`。
- 计划、验证记录、提交信息只写数量与结构，不写真实姓名、群名、需求标题、网址、密钥、企业微信账号。测试与示例只用虚构内容、`@example.com` 邮箱、`example.com` / `127.0.0.1` 网址。
- 迁移文件：`0017_*.sql` 由 `pnpm --filter @flower/core db:generate` 生成；`0018_p3b1_rls.sql` 用 `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p3b1_rls` 生成后填写（六张新表开启 RLS，参照 `0016_p3a_rls.sql`；并把每个组织的游标初始化为当前最新事件）。执行中如发现还要改表结构，停下来报告。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`（实体 id 作为第三个参数的现有写法照旧；需要密钥、网址的服务在最后多一个 `deps` 参数），一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写。`withSystem` 只沿用 P3-A 的「后台循环查出有待办的组织 id」，新增的待办条件（游标之后有事件、有过期的已读通知）属于同一用途。
- 用户发起的写操作同事务调用 `recordEvent`（修改类 payload 带 `changes: [{field, old, new}]`）。不记事件的写入：后台循环写站内通知、自动关注、个人提醒待发记录、游标、过期清理（「后台与系统写入不记事件」）；标记已读（与评论已读一致）；扫码绑定的 `state`（与登录会话一样属于认证过程）。
- 面向用户的文案与错误信息用中文，通过 `AppError(code, message, details?)` 抛出。`apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`、`@flower/core/markdown`、`@flower/core/links`、`@flower/core/notifications`。本计划不新增子路径：@ 的写法放进 `links/syntax.ts`，通知类型与偏好默认值放进 `notifications/constants.ts`，两个文件仍不导入任何模块。纯逻辑放 `apps/web/src/features/**/model.ts` 并写 Vitest 单测。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`；对话框用 `key` 重新挂载取初值，或渲染期间同步（参照 `apps/web/src/app/(app)/settings/page.tsx` 的 `synced`）。渲染期间不直接调用 `new Date()` / `Date.now()`（`react-hooks/purity`），用 `useState(() => new Date())` 或事件处理里取时间。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框用 `silentError: true` + `<FormError error={mutation.error} />`。页面加载失败用 `components/load-error.tsx` 的 `QueryError` / `LoadError`。
- 复用已有的共享件：`PageHeader`、`EmptyState`、`ConfirmAction`、`FormError`、`QueryError`、`LoadError`、`RequireOrgAdmin`、`CopyField`、`formatDateTime`；e2e `helpers.ts` 的 `ok`、`json`、`setupInstance`、`login`、`createProduct`、`createRequirement`、`createDocument`、`createWecomChannel`、`tick`、`expectNoPageOverflow`，以及本计划新增的 `memberRequest`。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0` 与 `pnpm typecheck`。
- 视觉沿用 P0-B：表格行高 40px（`h-10`）、隔行底色 `even:bg-zebra`、编号与时间用 `font-mono`、卡片圆角 6px（`rounded-md`）。未读圆点用 `bg-primary`。
- 布局：页面本身不出现横向滚动；新页面与铃铛面板在 1440 与 760 两个宽度下有 Playwright 断言（`expectNoPageOverflow`）。
- 端到端测试：每个 spec 在 `beforeEach` 或用例开头调用 `resetDatabase()`；不为迁就定位器修改共享组件；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染。
- `pnpm test` 和端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；之后要对开发库做任何操作，先执行 `pnpm db:migrate`。
- 提交信息用中文，每条末尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）；实际执行提交的若不是 Claude Opus 5.5，把这一行换成实际模型的名字。完成后按 `CLAUDE.md` 在 `docs/agent-log.md` 最上面追加一条（Task 20）。

## Review Focus

设计没有逐条写、各任务正常路径的测试也不一定覆盖、但最可能让使用者碰到问题的五类输入。每一条的测试已加在负责的任务里：

1. **处理到一半还没提交的事务里的事件。** 领域事件的 `occurred_at` 是写入事务的开始时间，长事务提交前，游标可能已经越过比它晚开始、先提交的事件。期望：未提交事务里的事件不会被游标跳过，提交后的下一轮照常生成通知。测试：Task 8「未提交事务里的事件不被跳过」。
2. **被 @ 或被指派的人在后台处理前离开组织、被改为访客或失去产品权限。** 期望：不给他写通知、不发企业微信，也不补自动关注；正文里的 @ 显示为灰色原名。测试：Task 8「收件人在处理前离开或看不到产品」、Task 14「已离开成员的 @ 显示为灰色原名」。
3. **对象在处理前被删除。** 需求或 PRD 被删除后，它之前的评论、指派事件到了后台。期望：跳过该事件、游标照常前移，不报错、不卡住后续事件。测试：Task 8「对象已删除的事件跳过且游标前移」。
4. **从 Excel 另存的 CSV。** 带 BOM、CRLF、表头行、中文逗号、带引号的单元格、空行，以及同一账号在文件里出现两次。期望：预览正确识别每一行并给出原因，确认后只写「可匹配」的行。测试：Task 6「CSV 解析容忍 Excel 导出格式」「预览分类」。
5. **扫码回调被重放、过期、换人或用户在企业微信里取消授权。** 期望：每种情况跳回个人设置并显示中文原因，`state` 只能用一次，任何情况下都不在页面或日志里出现应用密钥。测试：Task 7「回调的五种失败」、Task 11「回调重定向与密钥不外泄」。

## 设计决定

数量为 2026-10-12 写计划时对本地开发库的只读查询：`docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select …"`，只取数量。

| 项 | 决定 | 依据 |
|---|---|---|
| 现状数据 | 组织 2 个；pan123 领域事件 4428 条（其中非 `legacy.*` 21 条）；成员 84 人（在职真人 82，有账号 4）；产品 1 个；推送通道 6 个（企微 5 个，启用 0 个）；未删除需求 765 条；迁移已到 0016（drizzle 记录 17 条） | 只读核对 |
| @ 写法 | 正文存 `[@姓名](member:成员ID)`；姓名中的方括号与换行替换为空格、最多 50 字；成员 ID 统一小写。解析时跳过围栏代码块、行内代码与前面有反斜杠的写法（复用 `[[ ]]` 的 `codeRanges`）。显示按成员 ID 取当前姓名；成员已离开或查不到时显示灰色原名 | 设计 §4.1 |
| 新增比对 | `newMentionIds(上一版, 本次)`：只返回上一版没有的成员 ID，按首次出现顺序。评论新建时上一版为空；需求描述修改与 PRD 正文保存比较修改前后 | 设计 §3「只含本次保存相对上一版新增的被 @ 成员」 |
| 事件补充 | `comment.created`（需求、PRD）带 `mentionedMemberIds`；`requirement.created` 带 `ownerMemberId` 与描述里的 `mentionedMemberIds`；`requirement.updated` 在描述变化时带 `mentionedMemberIds`；`document.saved` 带 `mentionedMemberIds`；`document.created` 带 `ownerMemberId`；`task.created` 带 `assigneeMemberId`。负责人变更、新增分配、任务指派已有 `changes`，不再重复 | 设计 §3、§5.2 |
| 通知类型与排名 | `mentioned`（被 @）> `assigned`（被指派）> `signoff_due`（等我签字）> `followed_change`（关注对象变化）；同一事件同一人只写一条，取最高的一种；`system_alert` 没有事件，不参与比较 | 设计 §5.2（见冲突表） |
| 事件 → 通知 | 被 @：`comment.created`、`requirement.created/updated`、`document.saved` 的 `mentionedMemberIds`。被指派：`requirement.created`（负责人）、`requirement.updated`（负责人变更的新值）、`requirement.assignment_added`（被分配成员，说明里带职能名）、`document.created`（负责人）、`document.updated`（负责人变更的新值）、`task.created`、`task.updated`（指派变更的新值）。关注对象变化（发给未取消关注的关注者）：`requirement.state_changed`、`requirement.field_changed`（字段为 `priority`）、`requirement.iteration_changed`、`comment.created`、`document.status_changed`。等我签字：PRD 进入评审（`document.status_changed` 新值 `review`）；需求的评审由这次检查项变化开始（`check_item.updated` / `check_item.signed` 使 `reviewStarted` 由假变真）。其余事件与 `legacy.*` 不处理 | 设计 §5.2；`reviews/snapshot.ts` 的口径 |
| 等我签字的收件人 | 对每个能看到该产品的在职真人成员，用工作台同一个函数 `waitingFor(items, snap, who, false, started)` 判断，只取本人规则（不含代签）。职能标签规则在需求上有该标签的分配时只给被分配人，没有分配时给全部持有者 | 设计 §5.2「与工作台口径一致」 |
| 收件人过滤 | 操作人本人不通知；只发给在职（`status = active`）的真人成员；按组织角色与产品角色（`baseProductRole`）能看到该产品；对象已删除或产品已删除时整条事件跳过 | 设计 §5.2 |
| 通知内容 | `title` = 「编号 标题」（最多 120 字）；`body` = 动作，如「在评论中 @ 了你」「把你设为需求负责人」「把你分配为「设计」」「把任务指派给你」「把状态从「A」改为「B」」「把优先级从「P1」改为「P0」」「把迭代改为「X」」「发表了评论：前 60 字」「把 PRD 状态从「草稿」改为「评审中」」「「设计签字」等你签字」；`url` 为站内相对路径（`/{org}/requirements/PAN-12`、`/{org}/documents/PAN-PRD-3`、`/{org}/tasks/PAN-T-5`、系统告警为 `/{org}/settings/notifications?tab=schedules`）；操作人存 `actor_member_id`，列表时取当前姓名 | 设计 §6「谁对什么做了什么」 |
| 自动关注 | 处理事件时为负责人、被分配者、评论者（评论的操作人）、被 @ 者补上 `source = auto` 的关注（`on conflict do nothing`，已取消关注的行保留 `muted_at`，不会被加回）；只对需求与 PRD；只对能看到该产品的在职真人成员 | 设计 §2、§5.2 |
| 关注原因 | 手动：「你手动关注了」；自动：负责人 →「你是负责人」，需求上有分配 →「你被分配到这条需求」，发过评论 →「你评论过」，其他 →「你曾负责、被分配、评论或被 @」 | 设计 §6「悬停说明关注原因」 |
| 偏好 | `member_notification_prefs` 每人每类一行，没有记录时取默认：站内全开；企微只开被 @、被指派、等我签字；邮件全关。系统告警一行只对组织管理员（owner、admin）显示与生效 | 设计 §2、§6 |
| 游标 | 每个组织一行，记最后处理的 `(occurred_at, id)`（列 `last_occurred_at`、`last_event_id`）与连续失败的事件和次数。比较全部在 SQL 里做（JS 的 Date 只有毫秒，`occurred_at` 是微秒）。没有游标行（新组织）从头处理；迁移时为已有组织初始化为当前最新事件，不补发历史通知；`legacy import` 写入后同样初始化 | 设计 §5.1（见冲突表） |
| 未提交事务 | 只读取 `occurred_at` 早于 `least(now(), 本库其他会话中最早的事务开始时间)` 的事件（`pg_stat_activity` 的 `xact_start`，同一角色的会话可见）。未提交事务里的事件 `occurred_at` 等于其事务开始时间，不会被游标越过 | 见冲突表 |
| 一轮的处理 | 每轮每个组织最多 500 条；先 `insert … on conflict do nothing` 建游标行，再 `FOR UPDATE SKIP LOCKED` 锁住（拿不到说明另一个实例在处理，本轮跳过该组织）；每条事件在 savepoint 里处理；失败时记下事件与次数并结束本轮（保持顺序），同一条连续失败 3 次后跳过并 `console.warn`；企微与邮件提醒在本轮所有事件处理完后合并写入（也在 savepoint 里，出错只记警告） | 设计 §5.1 |
| 企微个人提醒 | 同一轮同一产品合并：每条一行 `<@userid> 操作人 动作：[编号 标题](绝对链接)`，按行合并为不超过 4096 字节的 markdown（单行超长时截断）；写入 `notification_deliveries`（`kind = personal`，`channel_id` 为该产品的个人提醒通道，`payload` 已渲染）。成员未绑定、产品未指定通道、通道停用或不再允许本产品使用时不发企微，只保留站内通知 | 设计 §4.3、§5.3 |
| 邮件个人提醒 | 同一轮同一人合并为一封：主题「Flower：你有 n 条新通知」，正文每条两行（动作与链接），末尾说明在个人设置里可以修改偏好；发到组织的个人通知邮件通道（必须为启用的邮件通道），收件地址为成员邮箱（`payload.to`，覆盖通道配置里的收件人）；成员没有邮箱或组织未指定通道时不发 | 设计 §5.3（见冲突表） |
| 系统告警 | 定时推送由正常变为告警时（发送记录全部放弃达到阈值、生成内容失败达到阈值、定时规则无效被停用三处），在写告警的同一事务里给组织管理员写 `system_alert`（`event_id` 为空，`subject_type = schedule`），并按偏好走企微（定时推送所属产品的个人提醒通道）与邮件。已在告警状态时不重复 | 设计 §5.2「后台循环在写告警时直接生成」 |
| 已读与清理 | 点通知标该条已读；铃铛「全部标为已读」；打开需求、PRD、任务详情时把本人与该对象相关的通知标为已读（页面挂载时调用一次）。只读 Token 能列出、不能标记。后台循环每轮对处理到的组织删除 `read_at` 早于 90 天的通知；有过期已读通知的组织也列入待办 | 设计 §5.4 |
| 列表与分页 | 按 `(created_at, id)` 倒序，游标为上一页最后一条的 `{created_at 微秒 UTC}|{id}`（与 P3-A 发送记录相同）；铃铛取 20 条，通知页每页 30 条「加载更多」；筛选 `filter`（all、unread、mentioned）与 `kind` | 设计 §6 |
| 企业微信账号 | `members.wecom_userid`（同一组织内唯一，部分唯一索引）；格式 1–64 位字母、数字与 `_ . @ -`；Agent 成员不能绑定；重复报「该企业微信账号已绑定到 {姓名}」；组织管理员手动填写、CSV 导入，成员扫码绑定与自行解除；每次变化记 `member.wecom_changed`（`via`: manual / import / oauth / self） | 设计 §4.2 |
| CSV 导入 | 两列（邮箱, 企业微信账号）；去 BOM、按 `\r?\n` 分行、逗号 / 中文逗号 / 制表符分列、去引号；第一行第一列不含 `@` 视为表头；最多 2000 行、200 KB。预览状态：可匹配（`ok`，原有账号时注明「将替换原账号」）、无变化（`unchanged`）、找不到成员（`not_found`，只匹配在职真人成员的邮箱）、账号重复（`duplicate`：已绑定到他人、文件中账号重复、文件中成员重复）、格式不对（`invalid`）。确认导入时重新计算并只写 `ok` 行 | 设计 §4.2 |
| 企业微信应用 | `wecom_apps` 每个组织最多一行：企业 ID（字母数字 1–64）、应用 ID（数字）、应用密钥（首次必填，之后留空表示不变；加密存储）、`secret_hint`、`bind_enabled`。页面显示回调地址 `{FLOWER_PUBLIC_URL}/api/v1/orgs/{org}/wecom/callback` 与要填到「授权回调域」的主机名 | 设计 §4.2 |
| 扫码绑定 | `POST /orgs/:org/me/wecom/bind`：未开启时报错；生成 24 字节随机 `state`（存 SHA-256，10 分钟过期），返回 `https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid=…&agentid=…&redirect_uri=…&state=…`，浏览器跳转。回调 `GET /orgs/:org/wecom/callback?code&state`：先在独立事务里把 `state` 标为已用，再校验所属成员与有效期、是否带 `code`，然后 `GET {base}/cgi-bin/gettoken?corpid&corpsecret` → `GET {base}/cgi-bin/auth/getuserinfo?access_token&code` 取 `userid`，写入成员；最后重定向到 `/settings?org={org}&wecom=bound` 或 `&wecom_error={原因}`。API Token 不能发起或完成绑定 | 设计 §4.2 |
| 个人提醒通道 | 产品管理员在产品设置「推送」页签选择；只能选对本产品可用、已启用的企业微信机器人通道；`products.personal_channel_id`，通道被删除时置空（`on delete set null`） | 设计 §3、§6 |
| 个人通知邮件通道 | 组织管理员在推送页「通道」页签选择；只能选启用的邮件通道；`organizations.personal_email_channel_id`，通道被删除时置空 | 设计 §3、§6 |
| @ 候选成员 | `GET /orgs/:org/products/:id/mention-members`（能看到该产品的人都可调用）：组织全部真人成员（含已离开，用于显示灰色原名），字段 id、姓名、邮箱（访客调用时为空）、状态、是否已绑定企业微信、能否看到该产品。补全只列在职成员，按姓名或邮箱包含匹配（姓名开头的排前），最多 8 个；看不到产品的标「看不到这个产品」，仍可插入 | 设计 §4.1 |
| 铃铛 | 顶栏用户菜单左侧；未读数每 30 秒刷新（超过 99 显示 99+）；面板 380px（窄屏不超过视口），「全部 / 未读 / @我」三个页签，按「今天 / 更早」分组，每条「操作人 动作」+ 标题 + 相对时间，未读有圆点；点击跳转并标为已读；底部「全部标为已读」「查看全部」 | 设计 §6 |
| 浏览器端的 BlockNote @ | 自定义内联元素 `mention`（`content: 'none'`，属性 memberId、name）；导出 HTML 为 `<a href="member:ID">@姓名</a>`，BlockNote 的 Markdown 导出得到 `[@姓名](member:ID)`；导入时由 `parse` 识别 `member:` 链接（BlockNote 的链接只接受 http 等协议，不会抢先解析）。编辑器与解析用同一个带 `mention` 的 schema；`@` 触发补全，与 `[[` 共用菜单组件与回车处理 | 设计 §4.1「BlockNote 内联元素」 |
| 依赖顺序 | Task 1 → 2 → 3–7（互不依赖）→ 8 → 9 → 10 → 11 → 12 → 13–18（依赖 12）→ 19 → 20 | — |

## 文件结构

```
packages/core/
  src/notifications/constants.ts      # 通知类型、排名、偏好默认值、企业微信账号格式（Task 1）；发送记录 personal（Task 2）；邮件收件人覆盖（Task 9）
  src/links/syntax.ts                 # @ 的解析、新增比对、写法、纯文字、混合片段（Task 1）
  src/db/schema.ts                    # 六张新表、三列、发送记录约束（Task 2）
  migrations/0017_*.sql  0018_p3b1_rls.sql  meta/   # Task 2
  src/requirements/comments.ts  src/documents/comments.ts  src/requirements/requirements.ts
  src/documents/documents.ts  src/tasks/tasks.ts       # 事件补充（Task 3）
  src/member-notifications/subscriptions.ts            # 关注（Task 4）
  src/member-notifications/prefs.ts                    # 偏好（Task 5）
  src/tenancy/members.ts  src/wecom/accounts.ts        # 企业微信账号、CSV、@ 候选成员（Task 6）
  src/wecom/app.ts  src/wecom/oauth.ts                 # 企业微信应用与扫码绑定（Task 7）
  src/member-notifications/recipients.ts  content.ts  generate.ts   # 通知生成（Task 8）
  src/notifications/worker.ts                          # 接入生成（Task 8）、告警（Task 10）
  src/member-notifications/channels.ts  dispatch.ts    # 个人提醒通道与分发（Task 9）
  src/notifications/sender.ts  src/notifications/deliveries.ts      # 邮件收件人覆盖、personal 记录（Task 9）；告警（Task 10）
  src/member-notifications/inbox.ts  alerts.ts         # 列表、已读、清理、系统告警（Task 10）
  src/index.ts                                         # 各任务
  test/mention-syntax.test.ts  p3b1-schema.test.ts  mention-events.test.ts  member-subscriptions.test.ts
  test/member-prefs.test.ts  wecom-accounts.test.ts  wecom-oauth.test.ts  member-notify-rules.test.ts
  test/member-notify-generate.test.ts  member-notify-dispatch.test.ts  member-notify-inbox.test.ts
  test/notify-transport.ts                             # 邮件收件人（Task 9）
packages/migrate/
  src/write.ts  test/write.test.ts                     # --replace 清理新表、导入后初始化游标（Task 2）
apps/web/
  src/server/api.ts  src/server/runtime.ts  src/server/routes/member-notifications.ts  src/server/routes/wecom.ts   # Task 11
  test/fake-wecom.ts  test/api/helpers.ts  test/api/member-notifications.test.ts  test/api/wecom.test.ts  test/api/notify-tick.test.ts
  src/lib/types.ts  src/lib/queries.ts                 # Task 12
  src/features/member-notifications/model.ts  model.test.ts  use-mark-read.ts   # Task 12、16
  src/features/mentions/model.ts  model.test.ts        # Task 12
  src/features/members/model.test.ts                   # Task 12（成员类型新增字段）
  src/components/notification-bell.tsx  src/components/org-shell.tsx  src/app/(app)/[org]/notifications/page.tsx   # Task 13
  src/components/wikilink-textarea.tsx  src/components/wiki-text.tsx  src/components/mention-chip.tsx                # Task 14
  src/features/documents/editor/mention.tsx  prd-editor.tsx  src/app/(app)/[org]/documents/[key]/editor-pane.tsx  src/app/globals.css   # Task 15
  src/components/follow-button.tsx  需求 / PRD / 任务详情页                       # Task 16
  src/app/(app)/settings/page.tsx  src/app/(app)/settings/notifications-section.tsx                               # Task 17
  src/app/(app)/[org]/settings/members/*  settings/notifications/*  settings/products/[productId]/notifications-tab.tsx   # Task 18
  e2e/helpers.ts  e2e/member-notifications.spec.ts  e2e/mentions.spec.ts  e2e/notification-settings.spec.ts  e2e/wecom-settings.spec.ts
docs/superpowers/specs/2026-10-12-flower-p3b1-member-notifications-design.md   # 实现补充（Task 2）
docs/p3b1-validation.md  docs/handoff.md  docs/agent-log.md                      # Task 20
```

---
### Task 1: 通知取值常量与 @ 写法（浏览器安全）

**Files:**
- Modify: `packages/core/src/notifications/constants.ts`（末尾追加）、`packages/core/src/links/syntax.ts`（末尾追加）
- Test: `packages/core/test/mention-syntax.test.ts`

**Interfaces:**
- Consumes: `links/syntax.ts` 内部的 `codeRanges`、`parseWikilinks`、`WikiSegment`
- Produces:
  - `notifications/constants.ts`（经 `@flower/core/notifications` 与 `@flower/core` 导出）：`MEMBER_NOTIFICATION_KINDS`、`type MemberNotificationKind`、`MEMBER_NOTIFICATION_KIND_LABELS`、`MEMBER_NOTIFICATION_RANK`、`NOTIFICATION_SUBJECT_TYPES`、`type NotificationSubjectType`、`SUBSCRIPTION_SUBJECT_TYPES`、`type SubscriptionSubjectType`、`SUBSCRIPTION_SOURCES`、`type SubscriptionSource`、`type NotificationPref = { inApp: boolean; wecom: boolean; email: boolean }`、`type NotificationPrefChannel = keyof NotificationPref`、`DEFAULT_NOTIFICATION_PREFS`、`NOTIFICATION_PREF_CHANNEL_LABELS`、`WECOM_USERID_RE`、`NOTIFICATION_RETENTION_DAYS`
  - `links/syntax.ts`（经 `@flower/core/links` 与 `@flower/core` 导出）：`type Mention = { memberId: string; name: string; raw: string; start: number; end: number }`、`type RichSegment`、`parseMentions(text): Mention[]`、`mentionedMemberIds(text): string[]`、`newMentionIds(previous, next): string[]`、`cleanMentionName(name): string`、`mentionMarkup(memberId, name): string`、`plainMentions(text): string`、`splitRichText(text): RichSegment[]`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/mention-syntax.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_PREFS, MEMBER_NOTIFICATION_KINDS, MEMBER_NOTIFICATION_RANK, WECOM_USERID_RE } from '../src/notifications/constants';
import { cleanMentionName, mentionedMemberIds, mentionMarkup, newMentionIds, parseMentions, plainMentions, splitRichText } from '../src/links/syntax';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';

describe('@ 成员的写法', () => {
  it('解析姓名与成员 ID；围栏代码块、行内代码与反斜杠转义的不算', () => {
    const text = [
      `请 ${mentionMarkup(A, '张三')} 看一下`,
      `\`[@李四](member:${B})\``,
      '```',
      `[@李四](member:${B})`,
      '```',
      `\\[@李四](member:${B})`,
    ].join('\n');
    expect(parseMentions(text).map((m) => [m.memberId, m.name])).toEqual([[A, '张三']]);
  });

  it('成员 ID 统一小写；同一人出现多次只算一次', () => {
    const text = `[@张三](member:${A.toUpperCase()}) 和 [@张三](member:${A}) 以及 [@李四](member:${B})`;
    expect(mentionedMemberIds(text)).toEqual([A, B]);
  });

  it('新增比对：只返回上一版没有的成员，按首次出现顺序', () => {
    const before = `先请 ${mentionMarkup(A, '张三')}`;
    const after = `${mentionMarkup(B, '李四')} 也来；${mentionMarkup(A, '张三')} 还在`;
    expect(newMentionIds(before, after)).toEqual([B]);
    expect(newMentionIds(after, before)).toEqual([]);
    expect(newMentionIds('', after)).toEqual([B, A]);
  });

  it('写法：姓名里的方括号与换行替换为空格，最多 50 字；空姓名用「成员」', () => {
    expect(cleanMentionName('王[五]\n六')).toBe('王 五 六');
    expect(mentionMarkup(A, '  ')).toBe(`[@成员](member:${A})`);
    expect(cleanMentionName('长'.repeat(60))).toHaveLength(50);
    expect(parseMentions(mentionMarkup(A, '王[五]'))[0]!.name).toBe('王 五');
  });

  it('纯文字与混合片段：@ 与 [[ ]] 交替出现时按位置切分', () => {
    const text = `请 ${mentionMarkup(A, '张三')} 看 [[PAN-1]]，谢谢`;
    expect(plainMentions(text)).toBe('请 @张三 看 [[PAN-1]]，谢谢');
    expect(splitRichText(text).map((s) => s.kind)).toEqual(['text', 'mention', 'text', 'link', 'text']);
  });
});

describe('通知取值', () => {
  it('五类通知；排名 被@ > 被指派 > 等我签字 > 关注对象变化', () => {
    expect(MEMBER_NOTIFICATION_KINDS).toEqual(['mentioned', 'assigned', 'followed_change', 'signoff_due', 'system_alert']);
    const order = [...MEMBER_NOTIFICATION_KINDS].filter((k) => k !== 'system_alert').sort((a, b) => MEMBER_NOTIFICATION_RANK[b] - MEMBER_NOTIFICATION_RANK[a]);
    expect(order).toEqual(['mentioned', 'assigned', 'signoff_due', 'followed_change']);
  });

  it('默认偏好：站内全开；企微只开被 @、被指派、等我签字；邮件全关', () => {
    for (const k of MEMBER_NOTIFICATION_KINDS) {
      expect(DEFAULT_NOTIFICATION_PREFS[k].inApp).toBe(true);
      expect(DEFAULT_NOTIFICATION_PREFS[k].email).toBe(false);
    }
    expect(MEMBER_NOTIFICATION_KINDS.filter((k) => DEFAULT_NOTIFICATION_PREFS[k].wecom)).toEqual(['mentioned', 'assigned', 'signoff_due']);
  });

  it('企业微信账号格式', () => {
    expect(WECOM_USERID_RE.test('zhang.san@corp-1_x')).toBe(true);
    expect(WECOM_USERID_RE.test('张三')).toBe(false);
    expect(WECOM_USERID_RE.test('a b')).toBe(false);
    expect(WECOM_USERID_RE.test('x'.repeat(65))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/mention-syntax.test.ts`
Expected: FAIL（`cleanMentionName` 等不存在：`does not provide an export named`）。

- [ ] **Step 3: 在 `notifications/constants.ts` 末尾追加**

```ts
// ---------- P3-B1：站内通知、关注、个人偏好 ----------

/** 站内通知的五种类型。 */
export const MEMBER_NOTIFICATION_KINDS = ['mentioned', 'assigned', 'followed_change', 'signoff_due', 'system_alert'] as const;
export type MemberNotificationKind = (typeof MEMBER_NOTIFICATION_KINDS)[number];
export const MEMBER_NOTIFICATION_KIND_LABELS: Record<MemberNotificationKind, string> = {
  mentioned: '被 @',
  assigned: '被指派',
  followed_change: '关注对象变化',
  signoff_due: '等我签字',
  system_alert: '系统告警',
};
/** 同一事件同一人只发一条，取排名最高的一种；系统告警没有事件，不参与比较。 */
export const MEMBER_NOTIFICATION_RANK: Record<MemberNotificationKind, number> = { mentioned: 4, assigned: 3, signoff_due: 2, followed_change: 1, system_alert: 0 };

export const NOTIFICATION_SUBJECT_TYPES = ['requirement', 'document', 'task', 'schedule'] as const;
export type NotificationSubjectType = (typeof NOTIFICATION_SUBJECT_TYPES)[number];
/** 可以关注的对象。 */
export const SUBSCRIPTION_SUBJECT_TYPES = ['requirement', 'document'] as const;
export type SubscriptionSubjectType = (typeof SUBSCRIPTION_SUBJECT_TYPES)[number];
export const SUBSCRIPTION_SOURCES = ['auto', 'manual'] as const;
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number];

export type NotificationPref = { inApp: boolean; wecom: boolean; email: boolean };
export type NotificationPrefChannel = keyof NotificationPref;
/** 没有个人设置时的默认值：站内全开；企微只开被 @、被指派、等我签字；邮件全关。 */
export const DEFAULT_NOTIFICATION_PREFS: Record<MemberNotificationKind, NotificationPref> = {
  mentioned: { inApp: true, wecom: true, email: false },
  assigned: { inApp: true, wecom: true, email: false },
  followed_change: { inApp: true, wecom: false, email: false },
  signoff_due: { inApp: true, wecom: true, email: false },
  system_alert: { inApp: true, wecom: false, email: false },
};
export const NOTIFICATION_PREF_CHANNEL_LABELS: Record<NotificationPrefChannel, string> = { inApp: '站内', wecom: '企业微信', email: '邮件' };

/** 企业微信账号（userid）：1–64 位字母、数字与 _ . @ -。 */
export const WECOM_USERID_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
/** 已读通知保留的天数，之后由后台循环删除。 */
export const NOTIFICATION_RETENTION_DAYS = 90;
```

- [ ] **Step 4: 在 `links/syntax.ts` 末尾追加**

```ts
// ---------- @ 成员 ----------

/** 正文里的一处 @：`[@姓名](member:成员ID)`。name 为写入时的姓名，显示时按 memberId 取当前姓名。 */
export type Mention = { memberId: string; name: string; raw: string; start: number; end: number };
/** 显示用的片段：普通文字、[[ ]] 链接、@ 成员。 */
export type RichSegment = WikiSegment | { kind: 'mention'; mention: Mention };

const MENTION_RE = /\[@([^[\]\n]{1,50})\]\(member:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

/** 解析 @：围栏代码块、行内代码里的，以及前面有反斜杠转义的不算。成员 ID 统一小写。 */
export function parseMentions(text: string): Mention[] {
  const code = codeRanges(text);
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index;
    if (text[start - 1] === '\\' || code.some(([s, e]) => start >= s && start < e)) continue;
    const name = m[1]!.trim();
    if (!name) continue;
    out.push({ memberId: m[2]!.toLowerCase(), name, raw: m[0], start, end: start + m[0].length });
  }
  return out;
}

/** 正文里被 @ 的成员（去重，按首次出现顺序）。 */
export const mentionedMemberIds = (text: string): string[] => [...new Set(parseMentions(text).map((m) => m.memberId))];

/** 本次保存相对上一版新出现的被 @ 成员（按首次出现顺序）。 */
export function newMentionIds(previous: string, next: string): string[] {
  const before = new Set(mentionedMemberIds(previous));
  return mentionedMemberIds(next).filter((id) => !before.has(id));
}

/** @ 写法里的姓名：方括号与换行换成空格、合并空白，最多 50 字；为空时用「成员」。 */
export function cleanMentionName(name: string): string {
  return name.replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || '成员';
}

/** 插入正文用的写法。 */
export const mentionMarkup = (memberId: string, name: string): string => `[@${cleanMentionName(name)}](member:${memberId})`;

/** 纯文字：@ 写法换成「@姓名」，用于通知摘要与企业微信消息。 */
export function plainMentions(text: string): string {
  let out = '';
  let at = 0;
  for (const m of parseMentions(text)) {
    out += `${text.slice(at, m.start)}@${m.name}`;
    at = m.end;
  }
  return out + text.slice(at);
}

/** 显示用：把文字拆成普通文字、[[ ]] 链接与 @ 三种片段（理论上不会重叠，重叠时取先出现的）。 */
export function splitRichText(text: string): RichSegment[] {
  const pieces: Array<{ start: number; end: number; seg: RichSegment }> = [
    ...parseWikilinks(text).map((link) => ({ start: link.start, end: link.end, seg: { kind: 'link' as const, link } })),
    ...parseMentions(text).map((mention) => ({ start: mention.start, end: mention.end, seg: { kind: 'mention' as const, mention } })),
  ].sort((a, b) => a.start - b.start);
  const out: RichSegment[] = [];
  let at = 0;
  for (const p of pieces) {
    if (p.start < at) continue;
    if (p.start > at) out.push({ kind: 'text', text: text.slice(at, p.start) });
    out.push(p.seg);
    at = p.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}
```

`links/syntax.ts` 文件头注释的「[[双链]] 的语法」改为「[[双链]] 与 @ 成员的语法」，其余不动；两个文件仍不导入任何模块。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/mention-syntax.test.ts test/link-syntax.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/notifications/constants.ts packages/core/src/links/syntax.ts packages/core/test/mention-syntax.test.ts
git commit -m "feat(core): 站内通知取值常量与 @ 成员的写法、解析和新增比对

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 数据模型：六张新表、三列、发送记录 personal（RLS、游标初始化、迁移工具清理）

**Files:**
- Modify: `packages/core/src/notifications/constants.ts`（`DELIVERY_KINDS`）、`packages/core/src/db/schema.ts`、`packages/migrate/src/write.ts`、`packages/migrate/test/write.test.ts`、`docs/superpowers/specs/2026-10-12-flower-p3b1-member-notifications-design.md`（§3 末尾追加实现补充）
- Create: `packages/core/migrations/0017_*.sql`（生成）、`packages/core/migrations/0018_p3b1_rls.sql`（`--custom` 生成后填写）、`packages/core/migrations/meta/*`（生成）
- Test: `packages/core/test/p3b1-schema.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `MEMBER_NOTIFICATION_KINDS`、`NOTIFICATION_SUBJECT_TYPES`、`SUBSCRIPTION_SUBJECT_TYPES`、`SUBSCRIPTION_SOURCES`
- Produces:
  - 表（drizzle 对象，经 `@flower/core` 导出）：`memberNotifications`、`memberNotificationPrefs`、`subscriptions`、`notificationCursors`、`wecomApps`、`wecomBindStates`
  - 新列：`members.wecomUserid`、`products.personalChannelId`、`organizations.personalEmailChannelId`
  - `DELIVERY_KINDS = ['rule', 'schedule', 'test', 'personal']`，`DELIVERY_KIND_LABELS.personal = '个人提醒'`；`notification_deliveries` 的来源约束接受 `personal`（规则与定时推送都为空）
  - `deleteOrgData` 清理六张新表；`writeImport` 写入后把该组织游标初始化为最新事件

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/p3b1-schema.test.ts`：

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  domainEvents,
  memberNotificationPrefs,
  memberNotifications,
  members,
  notificationChannels,
  notificationCursors,
  notificationDeliveries,
  organizations,
  products,
  subscriptions,
  wecomApps,
  wecomBindStates,
} from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const memberA = newId();
const memberA2 = newId();
const memberB = newId();
const channel = newId();
const event = newId();
const subject = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
  await t.adminDb.insert(members).values([
    { id: memberA, orgId: orgA, displayName: '张三', orgRole: 'member' },
    { id: memberA2, orgId: orgA, displayName: '李四', orgRole: 'member' },
    { id: memberB, orgId: orgB, displayName: '王五', orgRole: 'member' },
  ]);
  await t.adminDb.insert(domainEvents).values({ id: event, orgId: orgA, productId: productA, type: 'comment.created', subjectType: 'requirement', subjectId: subject, payload: {} });
  await t.adminDb.insert(notificationChannels).values({ id: channel, orgId: orgA, kind: 'wecom_robot', name: '研发群', config: 'v1:a:b:c', configHint: 'h', rateLimitPerMin: 20 });
});
afterAll(() => t.cleanup());

const TABLES = [memberNotifications, memberNotificationPrefs, subscriptions, notificationCursors, wecomApps, wecomBindStates];

describe('P3-B1 数据模型', () => {
  it('六张表都受行级安全约束，各有一条策略', async () => {
    await withOrg(t.db, orgA, async (tx) => {
      await tx.insert(memberNotifications).values({ orgId: orgA, memberId: memberA, eventId: event, kind: 'mentioned', subjectType: 'requirement', subjectId: subject, title: 'AA-1 标题', body: '在评论中 @ 了你', url: '/a/requirements/AA-1' });
      await tx.insert(memberNotificationPrefs).values({ orgId: orgA, memberId: memberA, kind: 'mentioned', inApp: true, wecom: false, email: false });
      await tx.insert(subscriptions).values({ orgId: orgA, memberId: memberA, subjectType: 'requirement', subjectId: subject, source: 'auto' });
      await tx.insert(notificationCursors).values({ orgId: orgA });
      await tx.insert(wecomApps).values({ orgId: orgA, corpId: 'ww0001', agentId: '1000002', secret: 'v1:a:b:c', secretHint: '****0001' });
      await tx.insert(wecomBindStates).values({ orgId: orgA, memberId: memberA, stateHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 600_000) });
    });
    for (const table of TABLES) {
      expect(await withOrg(t.db, orgA, (tx) => tx.select().from(table))).toHaveLength(1);
      expect(await withOrg(t.db, orgB, (tx) => tx.select().from(table))).toHaveLength(0);
    }
    const [{ n }] = (await t.adminDb.execute(
      sql`select count(*)::int as n from pg_policies where tablename in ('member_notifications', 'member_notification_prefs', 'subscriptions', 'notification_cursors', 'wecom_apps', 'wecom_bind_states')`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(6);
  });

  it('默认值', async () => {
    const [n] = await t.adminDb.select().from(memberNotifications);
    expect(n).toMatchObject({ readAt: null, actorMemberId: null });
    const [c] = await t.adminDb.select().from(notificationCursors);
    expect(c).toMatchObject({ lastOccurredAt: null, lastEventId: null, failingEventId: null, failures: 0 });
    const [w] = await t.adminDb.select().from(wecomApps);
    expect(w).toMatchObject({ bindEnabled: false });
    const [s] = await t.adminDb.select().from(subscriptions);
    expect(s).toMatchObject({ mutedAt: null, source: 'auto' });
    const [m] = await t.adminDb.select().from(members).where(eq(members.id, memberA));
    expect(m!.wecomUserid).toBeNull();
    const [p] = await t.adminDb.select().from(products);
    expect(p!.personalChannelId).toBeNull();
  });

  it('约束：同一人同一事件同一类只一条（系统告警可重复）；偏好、关注、state、企业微信应用唯一', async () => {
    await expect(
      t.adminDb.insert(memberNotifications).values({ orgId: orgA, memberId: memberA, eventId: event, kind: 'mentioned', subjectType: 'requirement', subjectId: subject, title: 't', body: 'b', url: '/u' }),
    ).rejects.toThrow();
    const alert = { orgId: orgA, memberId: memberA, eventId: null, kind: 'system_alert' as const, subjectType: 'schedule' as const, subjectId: newId(), title: 't', body: 'b', url: '/u' };
    await t.adminDb.insert(memberNotifications).values([alert, { ...alert }]);
    await expect(t.adminDb.insert(memberNotificationPrefs).values({ orgId: orgA, memberId: memberA, kind: 'mentioned', inApp: false, wecom: false, email: false })).rejects.toThrow();
    await expect(t.adminDb.insert(subscriptions).values({ orgId: orgA, memberId: memberA, subjectType: 'requirement', subjectId: subject, source: 'manual' })).rejects.toThrow();
    await expect(t.adminDb.insert(wecomBindStates).values({ orgId: orgA, memberId: memberA2, stateHash: 'a'.repeat(64), expiresAt: new Date() })).rejects.toThrow();
    await expect(t.adminDb.insert(wecomApps).values({ orgId: orgA, corpId: 'ww2', agentId: '2', secret: 'v1:x', secretHint: '****' })).rejects.toThrow();
  });

  it('企业微信账号在同一组织内唯一，不同组织可以相同', async () => {
    await t.adminDb.update(members).set({ wecomUserid: 'zhangsan' }).where(eq(members.id, memberA));
    await expect(t.adminDb.update(members).set({ wecomUserid: 'zhangsan' }).where(eq(members.id, memberA2))).rejects.toThrow();
    await t.adminDb.update(members).set({ wecomUserid: 'zhangsan' }).where(eq(members.id, memberB));
  });

  it('发送记录接受个人提醒（不属于规则与定时推送）', async () => {
    await t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'personal', channelId: channel, payload: { type: 'json', body: { msgtype: 'markdown', markdown: { content: 'x' } } } });
    await expect(t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'personal', channelId: channel, scheduleId: newId() })).rejects.toThrow();
  });

  it('个人提醒通道与个人通知邮件通道在通道删除时置空', async () => {
    const ch = newId();
    await t.adminDb.insert(notificationChannels).values({ id: ch, orgId: orgA, kind: 'wecom_robot', name: '临时群', config: 'v1:a:b:c', configHint: 'h', rateLimitPerMin: 20 });
    await t.adminDb.update(products).set({ personalChannelId: ch }).where(eq(products.id, productA));
    await t.adminDb.update(organizations).set({ personalEmailChannelId: ch }).where(eq(organizations.id, orgA));
    await t.adminDb.delete(notificationChannels).where(eq(notificationChannels.id, ch));
    expect((await t.adminDb.select().from(products).where(eq(products.id, productA)))[0]!.personalChannelId).toBeNull();
    expect((await t.adminDb.select().from(organizations).where(eq(organizations.id, orgA)))[0]!.personalEmailChannelId).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/p3b1-schema.test.ts`
Expected: FAIL（`memberNotifications` 等不存在）。

- [ ] **Step 3: 修改 `notifications/constants.ts` 的发送记录来源**

```ts
export const DELIVERY_KINDS = ['rule', 'schedule', 'test', 'personal'] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];
export const DELIVERY_KIND_LABELS: Record<DeliveryKind, string> = { rule: '事件规则', schedule: '定时推送', test: '测试消息', personal: '个人提醒' };
```

- [ ] **Step 4: 修改 `db/schema.ts`**

在顶部 `from '../notifications/constants'` 的导入里加上 `MEMBER_NOTIFICATION_KINDS`、`NOTIFICATION_SUBJECT_TYPES`、`SUBSCRIPTION_SOURCES`、`SUBSCRIPTION_SUBJECT_TYPES`（按字母顺序插入）。

`organizations` 加一列（放在 `settings` 之后）：

```ts
  /** 个人通知的邮件通道（P3-B1）；通道删除时置空。 */
  personalEmailChannelId: uuid('personal_email_channel_id').references((): AnyPgColumn => notificationChannels.id, { onDelete: 'set null' }),
```

`products` 加一列（放在 `taskSeq` 之后）：

```ts
    /** 个人提醒通道（P3-B1）：对本产品可用、已启用的企业微信机器人通道；通道删除时置空。 */
    personalChannelId: uuid('personal_channel_id').references((): AnyPgColumn => notificationChannels.id, { onDelete: 'set null' }),
```

`members` 加一列（放在 `status` 之后）与一个部分唯一索引：

```ts
    /** 企业微信账号（userid），同一组织内唯一（P3-B1）。 */
    wecomUserid: text('wecom_userid'),
```

```ts
  (t) => [
    uniqueIndex('members_org_account').on(t.orgId, t.accountId),
    index('members_account').on(t.accountId),
    uniqueIndex('members_org_wecom').on(t.orgId, t.wecomUserid).where(sql`${t.wecomUserid} is not null`),
  ],
```

`notificationDeliveries` 的来源约束改为：

```ts
    check(
      'notification_deliveries_source',
      sql`(${t.kind} = 'rule' and ${t.ruleId} is not null and ${t.scheduleId} is null) or (${t.kind} = 'schedule' and ${t.scheduleId} is not null and ${t.ruleId} is null) or (${t.kind} in ('test', 'personal') and ${t.ruleId} is null and ${t.scheduleId} is null)`,
    ),
```

文件末尾追加：

```ts
// ---------- P3-B1：站内通知、关注、个人偏好、企业微信 ----------

export const memberNotifications = pgTable(
  'member_notifications',
  {
    id: id(),
    orgId: orgRef(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    /** 系统告警没有对应的领域事件，为空。 */
    eventId: uuid('event_id').references(() => domainEvents.id),
    kind: text('kind', { enum: MEMBER_NOTIFICATION_KINDS }).notNull(),
    subjectType: text('subject_type', { enum: NOTIFICATION_SUBJECT_TYPES }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    /** 「编号 标题」。 */
    title: text('title').notNull(),
    /** 动作，如「在评论中 @ 了你」。 */
    body: text('body').notNull(),
    /** 站内相对路径，如 /acme/requirements/PAN-12。 */
    url: text('url').notNull(),
    actorMemberId: memberRef('actor_member_id'),
    createdAt: createdAt(),
    readAt: ts('read_at'),
  },
  (t) => [
    uniqueIndex('member_notifications_member_event_kind').on(t.memberId, t.eventId, t.kind).where(sql`${t.eventId} is not null`),
    index('member_notifications_member_created').on(t.memberId, t.createdAt.desc()),
    index('member_notifications_unread').on(t.memberId).where(sql`${t.readAt} is null`),
    index('member_notifications_subject').on(t.memberId, t.subjectType, t.subjectId),
    index('member_notifications_read_at').on(t.readAt).where(sql`${t.readAt} is not null`),
  ],
);

export const memberNotificationPrefs = pgTable(
  'member_notification_prefs',
  {
    id: id(),
    orgId: orgRef(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    kind: text('kind', { enum: MEMBER_NOTIFICATION_KINDS }).notNull(),
    inApp: boolean('in_app').notNull(),
    wecom: boolean('wecom').notNull(),
    email: boolean('email').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('member_notification_prefs_member_kind').on(t.memberId, t.kind)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    orgId: orgRef(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    subjectType: text('subject_type', { enum: SUBSCRIPTION_SUBJECT_TYPES }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    source: text('source', { enum: SUBSCRIPTION_SOURCES }).notNull(),
    /** 取消关注的时间：不删行，避免被自动关注加回。 */
    mutedAt: ts('muted_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('subscriptions_member_subject').on(t.memberId, t.subjectType, t.subjectId), index('subscriptions_subject').on(t.subjectType, t.subjectId)],
);

/** 站内通知的后台处理进度：每个组织一行。 */
export const notificationCursors = pgTable('notification_cursors', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id),
  /** 最后处理的事件（occurred_at, id）；为空表示从头处理。 */
  lastOccurredAt: ts('last_occurred_at'),
  lastEventId: uuid('last_event_id'),
  /** 连续处理失败的事件与次数：同一条连续失败 3 次后跳过。 */
  failingEventId: uuid('failing_event_id'),
  failures: integer('failures').notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const wecomApps = pgTable(
  'wecom_apps',
  {
    id: id(),
    orgId: orgRef(),
    corpId: text('corp_id').notNull(),
    agentId: text('agent_id').notNull(),
    /** 加密后的应用密钥（notifications/secrets.ts 的 `v1:…`），明文只在换取 access_token 时解密。 */
    secret: text('secret').notNull(),
    secretHint: text('secret_hint').notNull(),
    bindEnabled: boolean('bind_enabled').notNull().default(false),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('wecom_apps_org').on(t.orgId)],
);

/** 扫码绑定的一次性 state：只存 SHA-256，10 分钟过期，用过即作废。 */
export const wecomBindStates = pgTable(
  'wecom_bind_states',
  {
    id: id(),
    orgId: orgRef(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    stateHash: text('state_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('wecom_bind_states_hash').on(t.stateHash)],
);
```

- [ ] **Step 5: 生成迁移并填写 RLS 与游标初始化**

Run: `pnpm --filter @flower/core db:generate`
Expected: 生成 `packages/core/migrations/0017_*.sql`，含六张表、三列、索引、`members_org_wecom`、两条 `ON DELETE set null` 外键，以及 `notification_deliveries_source` 约束的删除与重建。打开文件核对：没有 `DROP TABLE`、没有改动其他表的列。

Run: `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p3b1_rls`
Expected: 生成空的 `0018_p3b1_rls.sql`。写入：

```sql
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'member_notifications', 'member_notification_prefs', 'subscriptions',
    'notification_cursors', 'wecom_apps', 'wecom_bind_states'
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
-- 上线时把每个组织的游标初始化为当前最新的事件：不为历史事件补发通知。没有事件的组织留空（从头处理，等价于从此刻开始）
INSERT INTO notification_cursors (org_id, last_occurred_at, last_event_id, updated_at)
SELECT o.id, e.occurred_at, e.id, now()
FROM organizations o
LEFT JOIN LATERAL (
  SELECT d.occurred_at, d.id FROM domain_events d WHERE d.org_id = o.id ORDER BY d.occurred_at DESC, d.id DESC LIMIT 1
) e ON true
ON CONFLICT (org_id) DO NOTHING;
```

- [ ] **Step 6: 迁移工具：`--replace` 清理新表，导入后初始化游标**

`packages/migrate/src/write.ts` 的 `deleteOrgData`，在 `entityLinks` 那一行之后、推送表循环之前加：

```ts
  // 站内通知：通知引用领域事件与成员，偏好、关注、扫码 state 引用成员，游标与企业微信应用只引用组织
  for (const table of [core.memberNotifications, core.memberNotificationPrefs, core.subscriptions, core.notificationCursors, core.wecomBindStates, core.wecomApps]) {
    await tx.execute(sql`delete from ${table} where org_id = ${orgId}`);
  }
```

`writeImport` 的事务里，`for (const key of INSERT_ORDER)` 循环结束之后加：

```ts
    // 导入的事件都是历史：游标从最新一条开始，不为它们生成站内通知
    await tx.execute(
      sql`insert into ${core.notificationCursors} (org_id, last_occurred_at, last_event_id)
          select ${org.id!}::uuid, e.occurred_at, e.id from ${core.domainEvents} e where e.org_id = ${org.id!}::uuid
          order by e.occurred_at desc, e.id desc limit 1
          on conflict (org_id) do nothing`,
    );
```

`packages/migrate/test/write.test.ts`：导入列表加 `memberNotifications`、`notificationCursors`、`subscriptions`、`wecomApps`；在「导入后有过正常使用……仍可以 replace」用例里，`await writeImport(t.adminDb, plan, { replace: true });` 之前加：

```ts
    await t.adminDb.insert(memberNotifications).values({ orgId: actor.orgId, memberId: actor.memberId, eventId: createdEvent!.id, kind: 'mentioned', subjectType: 'requirement', subjectId: created.id, title: 't', body: 'b', url: '/u' });
    await t.adminDb.insert(subscriptions).values({ orgId: actor.orgId, memberId: actor.memberId, subjectType: 'requirement', subjectId: created.id, source: 'manual' });
    await t.adminDb.insert(wecomApps).values({ orgId: actor.orgId, corpId: 'ww1', agentId: '1', secret: 'v1:x', secretHint: '****' });
```

在 `for (const table of [notificationDigestItems, …])` 断言循环之后加：

```ts
    for (const table of [memberNotifications, subscriptions, wecomApps]) expect(await t.adminDb.select().from(table)).toEqual([]);
    const [cursor] = await t.adminDb.select().from(notificationCursors).where(eq(notificationCursors.orgId, after.orgId));
    const [latest] = await t.adminDb.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.orgId, after.orgId)).orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id)).limit(1);
    expect(cursor!.lastEventId).toBe(latest!.id);
```

（`drizzle-orm` 的导入加上 `desc`。）

- [ ] **Step 7: 设计文档补充实现细节**

在 `docs/superpowers/specs/2026-10-12-flower-p3b1-member-notifications-design.md` §3 的「迁移」一段之后追加：

```markdown
实现补充（计划 2026-10-12）：

- 游标按领域事件的 `occurred_at`（事件表没有 `created_at`）与 `id` 比较，另记连续失败的事件与次数；只处理早于本库仍在进行中的事务开始时间的事件，避免越过未提交事务里的事件。
- 扫码绑定的一次性 `state` 存在新租户表 `wecom_bind_states`（只存摘要，10 分钟过期，开启 RLS）。
- 个人提醒写入 P3-A 发送队列时 `kind = personal`；邮件请求体可以带收件人，覆盖通道配置里的收件人。
- 事件 payload 沿用现有的驼峰命名：`mentionedMemberIds`。
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/p3b1-schema.test.ts test/p3a-schema.test.ts test/rls.test.ts && pnpm --filter @flower/migrate exec vitest run test/write.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误。（`pnpm test` 的全局准备会按新迁移重建模板库。）

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/notifications/constants.ts packages/core/src/db/schema.ts packages/core/migrations packages/core/test/p3b1-schema.test.ts packages/migrate/src/write.ts packages/migrate/test/write.test.ts docs/superpowers/specs/2026-10-12-flower-p3b1-member-notifications-design.md
git commit -m "feat(core): P3-B1 数据模型：站内通知、偏好、关注、游标、企业微信应用与绑定 state（RLS），成员企业微信账号与个人提醒通道

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 业务事件补充被 @ 成员与负责人、被指派人

**Files:**
- Modify: `packages/core/src/requirements/comments.ts`、`packages/core/src/documents/comments.ts`、`packages/core/src/requirements/requirements.ts`、`packages/core/src/documents/documents.ts`、`packages/core/src/tasks/tasks.ts`
- Test: `packages/core/test/mention-events.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `mentionedMemberIds`、`newMentionIds`；`documentMarkdownTx(tx, doc)`（`documents/documents.ts`）
- Produces（领域事件 payload，Task 8 读取）：
  - `comment.created`：`mentionedMemberIds: string[]`（需求与 PRD 评论）
  - `requirement.created`：`ownerMemberId: string | null`、`mentionedMemberIds: string[]`
  - `requirement.updated`：描述变化时 `mentionedMemberIds: string[]`（相对修改前新增）；描述没变时没有这个键
  - `document.saved`：`mentionedMemberIds: string[]`（相对保存前的正文新增）
  - `document.created`：`ownerMemberId: string | null`
  - `task.created`：`assigneeMemberId: string | null`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/mention-events.test.ts`：

```ts
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { addDocumentComment } from '../src/documents/comments';
import { createDocument, saveDocumentContent } from '../src/documents/documents';
import { mentionMarkup } from '../src/links/syntax';
import { addRequirementComment } from '../src/requirements/comments';
import { createRequirement, updateRequirement } from '../src/requirements/requirements';
import { createTask } from '../src/tasks/tasks';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let b: Actor;
let productId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  a = await asMember(t.db, owner, '张三');
  b = await asMember(t.db, owner, '李四');
});
afterAll(() => t.cleanup());

async function payloadOf(type: string, subjectId: string): Promise<Record<string, unknown>> {
  const [row] = await t.adminDb
    .select({ payload: domainEvents.payload })
    .from(domainEvents)
    .where(and(eq(domainEvents.type, type), eq(domainEvents.subjectId, subjectId)))
    .orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id))
    .limit(1);
  return row!.payload;
}

describe('事件里的被 @ 成员与负责人', () => {
  it('新建需求：带负责人与描述里的被 @ 成员', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '登录页改版', ownerMemberId: a.memberId, description: `请 ${mentionMarkup(b.memberId, '李四')} 评估` });
    expect(await payloadOf('requirement.created', r.id)).toMatchObject({ ownerMemberId: a.memberId, mentionedMemberIds: [b.memberId] });
  });

  it('修改描述只记新增的被 @；只改标题时没有这个键', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '分享页', description: `先请 ${mentionMarkup(a.memberId, '张三')}` });
    await updateRequirement(t.db, owner, r.id, { description: `先请 ${mentionMarkup(a.memberId, '张三')}，再请 ${mentionMarkup(b.memberId, '李四')}` });
    expect(await payloadOf('requirement.updated', r.id)).toMatchObject({ mentionedMemberIds: [b.memberId] });
    await updateRequirement(t.db, owner, r.id, { title: '分享页 v2' });
    expect(await payloadOf('requirement.updated', r.id)).not.toHaveProperty('mentionedMemberIds');
  });

  it('需求评论与 PRD 评论：带评论里的被 @', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '下载' });
    await addRequirementComment(t.db, owner, r.id, { body: `${mentionMarkup(a.memberId, '张三')} 看下` });
    expect(await payloadOf('comment.created', r.id)).toMatchObject({ mentionedMemberIds: [a.memberId] });
    const doc = await createDocument(t.db, owner, productId, { title: '下载 PRD' });
    await addDocumentComment(t.db, owner, doc.id, { body: `${mentionMarkup(b.memberId, '李四')} 请确认` });
    expect(await payloadOf('comment.created', doc.id)).toMatchObject({ mentionedMemberIds: [b.memberId] });
  });

  it('PRD 正文保存：相对保存前的正文新增；新建 PRD 带负责人', async () => {
    const doc = await createDocument(t.db, owner, productId, { title: '上传 PRD', ownerMemberId: a.memberId });
    expect(await payloadOf('document.created', doc.id)).toMatchObject({ ownerMemberId: a.memberId });
    const first = await saveDocumentContent(t.db, owner, doc.id, { baseVersion: doc.version, markdown: `# 背景\n\n${mentionMarkup(a.memberId, '张三')} 负责` });
    expect(await payloadOf('document.saved', doc.id)).toMatchObject({ mentionedMemberIds: [a.memberId] });
    await saveDocumentContent(t.db, owner, doc.id, { baseVersion: first.version, markdown: `# 背景\n\n${mentionMarkup(a.memberId, '张三')} 负责，${mentionMarkup(b.memberId, '李四')} 配合` });
    expect(await payloadOf('document.saved', doc.id)).toMatchObject({ mentionedMemberIds: [b.memberId] });
  });

  it('新建任务：带被指派人', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '回收站' });
    const task = await createTask(t.db, owner, { requirementId: r.id, title: '接口', assigneeMemberId: b.memberId });
    expect(await payloadOf('task.created', task.id)).toMatchObject({ assigneeMemberId: b.memberId });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/mention-events.test.ts`
Expected: FAIL（payload 里没有 `ownerMemberId`、`mentionedMemberIds`）。

- [ ] **Step 3: 需求评论与 PRD 评论**

`requirements/comments.ts`：导入加 `import { mentionedMemberIds } from '../links/syntax';`，`recordEvent` 的 payload 改为：

```ts
      payload: { commentId: row!.id, kind: row!.kind, mentionedMemberIds: mentionedMemberIds(body) },
```

`documents/comments.ts`：导入加 `import { mentionedMemberIds } from '../links/syntax';`，`addDocumentComment` 里 `comment.created` 的 payload 改为：

```ts
      payload: { commentId: row!.id, anchored: anchor !== null, mentionedMemberIds: mentionedMemberIds(body) },
```

- [ ] **Step 4: 需求新建与修改**

`requirements/requirements.ts`：导入加 `import { mentionedMemberIds, newMentionIds } from '../links/syntax';`。

`createRequirement` 的 `requirement.created` payload 改为：

```ts
      payload: { number: row!.number, title, ownerMemberId: row!.ownerMemberId, mentionedMemberIds: mentionedMemberIds(description) },
```

`updateRequirement` 的 `requirement.updated` payload 改为：

```ts
        payload: { changes, ...(next.description !== cur.description ? { mentionedMemberIds: newMentionIds(cur.description, next.description) } : {}) },
```

- [ ] **Step 5: PRD 正文保存与新建**

`documents/documents.ts`：导入加 `import { newMentionIds } from '../links/syntax';`。

`saveDocumentContent` 里，`const rev = await writeRevision(…)` 之前加一行（自动保存可能合并进上一版修订，必须在写入前读）：

```ts
    const previous = await documentMarkdownTx(tx, doc);
```

`document.saved` 的 payload 改为：

```ts
      payload: {
        revision: rev.number,
        merged: rev.merged,
        changes: title === doc.title ? [] : [{ field: 'title', old: doc.title, new: title }],
        mentionedMemberIds: newMentionIds(previous, markdown),
      },
```

`createDocument` 的 `document.created` payload 改为：

```ts
      payload: { number: doc.number, title, source: doc.source, externalUrl: doc.externalUrl, templateId, ownerMemberId: doc.ownerMemberId },
```

- [ ] **Step 6: 任务新建**

`tasks/tasks.ts` 的 `createTask` 里 `task.created` 的 payload 改为：

```ts
      payload: { number: row!.number, title: row!.title, requirementId: row!.requirementId, iterationId: row!.iterationId, assigneeMemberId: row!.assigneeMemberId },
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/mention-events.test.ts test/comments.test.ts test/document-comments.test.ts test/requirements.test.ts test/documents.test.ts test/tasks.test.ts test/events.test.ts`
Expected: 全部 PASS（已有测试对 payload 用 `toMatchObject`，多出的键不影响；如有用 `toEqual` 比较整个 payload 而失败的，把期望值补上新键，不改断言方式）。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/requirements/comments.ts packages/core/src/documents/comments.ts packages/core/src/requirements/requirements.ts packages/core/src/documents/documents.ts packages/core/src/tasks/tasks.ts packages/core/test/mention-events.test.ts
git commit -m "feat(core): 评论、需求描述与 PRD 正文的事件记下新增的被 @ 成员，新建需求、PRD 与任务的事件带负责人

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 关注服务（查询、关注与取消关注、自动关注）

**Files:**
- Create: `packages/core/src/member-notifications/subscriptions.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/member-subscriptions.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `subscriptions` 表；`requireProductRole`、`recordEvent`
- Produces:
  - `type SubscriptionSubject = { type: SubscriptionSubjectType; id: string }`
  - `type SubscriptionView = { following: boolean; source: SubscriptionSource | null; reason: string | null }`
  - `getSubscription(db, actor, subject): Promise<SubscriptionView>`
  - `setSubscription(db, actor, subject, following: boolean): Promise<SubscriptionView>`（记 `subscription.followed` / `subscription.unfollowed`）
  - `autoSubscribeTx(tx, orgId, subject, memberIds: string[]): Promise<void>`（Task 8 调用；已取消关注的不加回）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/member-subscriptions.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, subscriptions } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { autoSubscribeTx, getSubscription, setSubscription } from '../src/member-notifications/subscriptions';
import { addRequirementComment } from '../src/requirements/comments';
import { addRequirementAssignment } from '../src/requirements/assignments';
import { createRequirement } from '../src/requirements/requirements';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { updateMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let productId: string;
let reqId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  a = await asMember(t.db, owner, '张三');
  reqId = (await createRequirement(t.db, owner, productId, { title: '登录页改版' })).id;
});
afterAll(() => t.cleanup());

const subject = () => ({ type: 'requirement' as const, id: reqId });

describe('关注', () => {
  it('默认未关注；手动关注与取消关注，记事件', async () => {
    expect(await getSubscription(t.db, a, subject())).toEqual({ following: false, source: null, reason: null });
    expect(await setSubscription(t.db, a, subject(), true)).toEqual({ following: true, source: 'manual', reason: '你手动关注了' });
    const off = await setSubscription(t.db, a, subject(), false);
    expect(off.following).toBe(false);
    const types = (await t.adminDb.select({ type: domainEvents.type }).from(domainEvents).where(eq(domainEvents.subjectId, reqId))).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['subscription.followed', 'subscription.unfollowed']));
  });

  it('取消关注后，自动关注不会加回；手动关注可以恢复', async () => {
    await withOrg(t.db, owner.orgId, (tx) => autoSubscribeTx(tx, owner.orgId, subject(), [a.memberId]));
    expect((await getSubscription(t.db, a, subject())).following).toBe(false);
    expect((await setSubscription(t.db, a, subject(), true)).following).toBe(true);
  });

  it('自动关注的原因：负责人、被分配、评论过，其他为兜底说明', async () => {
    const b = await asMember(t.db, owner, '李四');
    const r = await createRequirement(t.db, owner, productId, { title: '分享页', ownerMemberId: b.memberId });
    const s = { type: 'requirement' as const, id: r.id };
    await withOrg(t.db, owner.orgId, (tx) => autoSubscribeTx(tx, owner.orgId, s, [b.memberId, b.memberId, a.memberId]));
    expect(await getSubscription(t.db, b, s)).toEqual({ following: true, source: 'auto', reason: '你是负责人' });
    expect((await getSubscription(t.db, a, s)).reason).toBe('你曾负责、被分配、评论或被 @');
    const tag = (await listFunctionTags(t.db, owner))[0]!;
    await addRequirementAssignment(t.db, owner, r.id, { memberId: a.memberId, functionTagId: tag.id });
    expect((await getSubscription(t.db, a, s)).reason).toBe('你被分配到这条需求');
    const c = await asMember(t.db, owner, '王五');
    await addRequirementComment(t.db, c, r.id, { body: '我来看看' });
    await withOrg(t.db, owner.orgId, (tx) => autoSubscribeTx(tx, owner.orgId, s, [c.memberId]));
    expect((await getSubscription(t.db, c, s)).reason).toBe('你评论过');
    const rows = await t.adminDb.select().from(subscriptions).where(and(eq(subscriptions.subjectId, r.id), eq(subscriptions.memberId, b.memberId)));
    expect(rows).toHaveLength(1);
  });

  it('只读 Token 不能修改；看不到产品的成员报不存在', async () => {
    await expect(setSubscription(t.db, readOnlyToken(owner), subject(), true)).rejects.toThrow('只读 Token 不能修改关注');
    const guest = await asMember(t.db, owner, '访客');
    await updateMember(t.db, owner, guest.memberId, { orgRole: 'guest' });
    await expect(getSubscription(t.db, { ...guest, orgRole: 'guest' }, subject())).rejects.toThrow('产品不存在');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/member-subscriptions.test.ts`
Expected: FAIL（`Cannot find module '../src/member-notifications/subscriptions'`）。

- [ ] **Step 3: 实现 `member-notifications/subscriptions.ts`**

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

export type SubscriptionSubject = { type: SubscriptionSubjectType; id: string };
export type SubscriptionView = { following: boolean; source: SubscriptionSource | null; reason: string | null };

const S = subscriptions;

/** 关注对象的产品与负责人；不存在或已删除时报「不存在」。 */
async function loadSubjectTx(tx: Tx, s: SubscriptionSubject): Promise<{ productId: string; ownerMemberId: string | null }> {
  if (s.type === 'requirement') {
    const [r] = await tx
      .select({ productId: requirements.productId, ownerMemberId: requirements.ownerMemberId })
      .from(requirements)
      .where(and(eq(requirements.id, s.id), isNull(requirements.deletedAt)));
    if (!r) throw new AppError('not_found', '需求不存在');
    return r;
  }
  const [d] = await tx
    .select({ productId: documents.productId, ownerMemberId: documents.ownerMemberId })
    .from(documents)
    .where(and(eq(documents.id, s.id), isNull(documents.deletedAt)));
  if (!d) throw new AppError('not_found', 'PRD 不存在');
  return d;
}

/** 自动关注的原因按当前情况推断：负责人、被分配、评论过；都不是时为兜底说明。 */
async function reasonTx(tx: Tx, memberId: string, s: SubscriptionSubject, source: SubscriptionSource, ownerMemberId: string | null): Promise<string> {
  if (source === 'manual') return '你手动关注了';
  if (ownerMemberId === memberId) return '你是负责人';
  if (s.type === 'requirement') {
    const [a] = await tx
      .select({ id: requirementAssignments.id })
      .from(requirementAssignments)
      .where(and(eq(requirementAssignments.requirementId, s.id), eq(requirementAssignments.memberId, memberId)))
      .limit(1);
    if (a) return '你被分配到这条需求';
  }
  const [c] = await tx
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.targetType, s.type), eq(comments.targetId, s.id), eq(comments.authorMemberId, memberId)))
    .limit(1);
  if (c) return '你评论过';
  return '你曾负责、被分配、评论或被 @';
}

async function viewTx(tx: Tx, memberId: string, s: SubscriptionSubject, ownerMemberId: string | null): Promise<SubscriptionView> {
  const [row] = await tx
    .select()
    .from(S)
    .where(and(eq(S.memberId, memberId), eq(S.subjectType, s.type), eq(S.subjectId, s.id)));
  if (!row || row.mutedAt) return { following: false, source: row?.source ?? null, reason: null };
  return { following: true, source: row.source, reason: await reasonTx(tx, memberId, s, row.source, ownerMemberId) };
}

export async function getSubscription(db: Db, actor: Actor, s: SubscriptionSubject): Promise<SubscriptionView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const subj = await loadSubjectTx(tx, s);
    await requireProductRole(tx, actor, subj.productId, 'viewer');
    return viewTx(tx, actor.memberId, s, subj.ownerMemberId);
  });
}

/** 关注或取消关注。取消关注不删行，只记 muted_at，自动关注不会加回；再次关注改为手动。 */
export async function setSubscription(db: Db, actor: Actor, s: SubscriptionSubject, following: boolean): Promise<SubscriptionView> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能修改关注');
  return withOrg(db, actor.orgId, async (tx) => {
    const subj = await loadSubjectTx(tx, s);
    await requireProductRole(tx, actor, subj.productId, 'viewer');
    const now = new Date();
    await tx
      .insert(S)
      .values({ orgId: actor.orgId, memberId: actor.memberId, subjectType: s.type, subjectId: s.id, source: 'manual', mutedAt: following ? null : now })
      .onConflictDoUpdate({
        target: [S.memberId, S.subjectType, S.subjectId],
        set: following ? { source: 'manual', mutedAt: null } : { mutedAt: sql`coalesce(${S.mutedAt}, ${now.toISOString()}::timestamptz)` },
      });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: subj.productId,
      type: following ? 'subscription.followed' : 'subscription.unfollowed',
      subjectType: s.type,
      subjectId: s.id,
      actor,
      payload: {},
    });
    return viewTx(tx, actor.memberId, s, subj.ownerMemberId);
  });
}

/** 后台生成通知时补上自动关注（不记事件）；已有的行（含已取消关注的）保持不变。 */
export async function autoSubscribeTx(tx: Tx, orgId: string, s: SubscriptionSubject, memberIds: string[]): Promise<void> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return;
  await tx
    .insert(S)
    .values(unique.map((memberId) => ({ orgId, memberId, subjectType: s.type, subjectId: s.id, source: 'auto' as const })))
    .onConflictDoNothing();
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './member-notifications/subscriptions';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/member-subscriptions.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/member-notifications/subscriptions.ts packages/core/src/index.ts packages/core/test/member-subscriptions.test.ts
git commit -m "feat(core): 关注服务：查询、手动关注与取消关注（不删行）、后台自动关注

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 个人通知偏好服务

**Files:**
- Create: `packages/core/src/member-notifications/prefs.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/member-prefs.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DEFAULT_NOTIFICATION_PREFS`、`MEMBER_NOTIFICATION_KINDS`、`NotificationPref`；Task 2 的 `memberNotificationPrefs`、`wecomApps`、`products.personalChannelId`、`organizations.personalEmailChannelId`、`members.wecomUserid`
- Produces:
  - `type NotificationPrefRow = { kind: MemberNotificationKind } & NotificationPref`
  - `type NotificationSettings = { prefs: NotificationPrefRow[]; wecom: { userid: string | null; bindEnabled: boolean; productChannels: number }; email: { address: string | null; channelConfigured: boolean } }`
  - `kindsForRole(orgRole: OrgRole): MemberNotificationKind[]`（系统告警只给 owner、admin）
  - `prefsForTx(tx, memberIds: string[]): Promise<Map<string, Record<MemberNotificationKind, NotificationPref>>>`（没有记录的取默认；Task 8、10 用）
  - `getNotificationSettings(db, actor): Promise<NotificationSettings>`
  - `setNotificationPref(db, actor, kind, pref: NotificationPref): Promise<NotificationSettings>`（记 `member.notification_pref_set`）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/member-prefs.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, organizations, products, wecomApps } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { getNotificationSettings, kindsForRole, prefsForTx, setNotificationPref } from '../src/member-notifications/prefs';
import { DEFAULT_NOTIFICATION_PREFS } from '../src/notifications/constants';
import { createChannel } from '../src/notifications/channels';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let productId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  a = await asMember(t.db, owner, '张三');
});
afterAll(() => t.cleanup());

describe('个人通知偏好', () => {
  it('系统告警只对组织管理员', () => {
    expect(kindsForRole('owner')).toContain('system_alert');
    expect(kindsForRole('admin')).toContain('system_alert');
    expect(kindsForRole('member')).not.toContain('system_alert');
    expect(kindsForRole('guest')).toEqual(['mentioned', 'assigned', 'followed_change', 'signoff_due']);
  });

  it('没有设置时取默认；企微未绑定、没有个人提醒通道、没有邮件通道', async () => {
    const s = await getNotificationSettings(t.db, a);
    expect(s.prefs.map((p) => p.kind)).toEqual(['mentioned', 'assigned', 'followed_change', 'signoff_due']);
    expect(s.prefs[0]).toEqual({ kind: 'mentioned', ...DEFAULT_NOTIFICATION_PREFS.mentioned });
    expect(s.wecom).toEqual({ userid: null, bindEnabled: false, productChannels: 0 });
    expect(s.email).toEqual({ address: null, channelConfigured: false });
  });

  it('修改一类并记事件；批量读取时其他人仍为默认', async () => {
    const s = await setNotificationPref(t.db, a, 'assigned', { inApp: false, wecom: true, email: true });
    expect(s.prefs.find((p) => p.kind === 'assigned')).toEqual({ kind: 'assigned', inApp: false, wecom: true, email: true });
    const map = await withOrg(t.db, owner.orgId, (tx) => prefsForTx(tx, [a.memberId, owner.memberId]));
    expect(map.get(a.memberId)!.assigned).toEqual({ inApp: false, wecom: true, email: true });
    expect(map.get(owner.memberId)!.assigned).toEqual(DEFAULT_NOTIFICATION_PREFS.assigned);
    const [ev] = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'member.notification_pref_set'));
    expect(ev!.payload).toMatchObject({ kind: 'assigned', changes: [{ field: 'inApp', old: true, new: false }, { field: 'email', old: false, new: true }] });
  });

  it('普通成员不能设置系统告警；只读 Token 不能修改', async () => {
    await expect(setNotificationPref(t.db, a, 'system_alert', { inApp: false, wecom: false, email: false })).rejects.toThrow('只有组织管理员接收系统告警');
    await expect(setNotificationPref(t.db, readOnlyToken(owner), 'mentioned', { inApp: false, wecom: false, email: false })).rejects.toThrow('只读 Token 不能修改通知偏好');
    expect((await setNotificationPref(t.db, owner, 'system_alert', { inApp: true, wecom: false, email: true })).prefs.at(-1)).toEqual({ kind: 'system_alert', inApp: true, wecom: false, email: true });
  });

  it('扫码绑定开关、产品个人提醒通道与组织邮件通道反映在设置里', async () => {
    const ch = await wecomChannel(t.db, owner, '研发群');
    await t.adminDb.update(products).set({ personalChannelId: ch.id }).where(eq(products.id, productId));
    const mail = await createChannel(
      t.db,
      owner,
      { kind: 'email', name: '个人通知邮件', config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
      TEST_DEPS,
    );
    await t.adminDb.update(organizations).set({ personalEmailChannelId: mail.id }).where(eq(organizations.id, owner.orgId));
    await t.adminDb.insert(wecomApps).values({ orgId: owner.orgId, corpId: 'ww0001', agentId: '1000002', secret: 'v1:a:b:c', secretHint: '****0001', bindEnabled: true });
    const s = await getNotificationSettings(t.db, owner);
    expect(s.wecom).toEqual({ userid: null, bindEnabled: true, productChannels: 1 });
    expect(s.email).toEqual({ address: 'owner@example.com', channelConfigured: true });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/member-prefs.test.ts`
Expected: FAIL（`Cannot find module '../src/member-notifications/prefs'`）。

- [ ] **Step 3: 实现 `member-notifications/prefs.ts`**

```ts
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { memberNotificationPrefs, members, notificationChannels, organizations, products, wecomApps } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, OrgRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { DEFAULT_NOTIFICATION_PREFS, MEMBER_NOTIFICATION_KINDS, type MemberNotificationKind, type NotificationPref } from '../notifications/constants';

export type NotificationPrefRow = { kind: MemberNotificationKind } & NotificationPref;
export type NotificationSettings = {
  prefs: NotificationPrefRow[];
  wecom: { userid: string | null; bindEnabled: boolean; productChannels: number };
  email: { address: string | null; channelConfigured: boolean };
};
type PrefMap = Record<MemberNotificationKind, NotificationPref>;

const P = memberNotificationPrefs;
const isAdminRole = (role: OrgRole): boolean => role === 'owner' || role === 'admin';

/** 成员可以设置、会收到的通知类型：系统告警只给组织管理员。 */
export function kindsForRole(orgRole: OrgRole): MemberNotificationKind[] {
  return MEMBER_NOTIFICATION_KINDS.filter((k) => k !== 'system_alert' || isAdminRole(orgRole));
}

function withDefaults(rows: Array<{ kind: MemberNotificationKind } & NotificationPref>): PrefMap {
  const out = Object.fromEntries(MEMBER_NOTIFICATION_KINDS.map((k) => [k, { ...DEFAULT_NOTIFICATION_PREFS[k] }])) as PrefMap;
  for (const r of rows) out[r.kind] = { inApp: r.inApp, wecom: r.wecom, email: r.email };
  return out;
}

/** 一批成员的偏好（没有记录的取默认）。 */
export async function prefsForTx(tx: Tx, memberIds: string[]): Promise<Map<string, PrefMap>> {
  const unique = [...new Set(memberIds)];
  const rows = unique.length
    ? await tx.select({ memberId: P.memberId, kind: P.kind, inApp: P.inApp, wecom: P.wecom, email: P.email }).from(P).where(inArray(P.memberId, unique))
    : [];
  return new Map(unique.map((id) => [id, withDefaults(rows.filter((r) => r.memberId === id))]));
}

async function settingsTx(tx: Tx, actor: Actor): Promise<NotificationSettings> {
  const [me] = await tx.select({ email: members.email, orgRole: members.orgRole, wecomUserid: members.wecomUserid }).from(members).where(eq(members.id, actor.memberId));
  if (!me) throw new AppError('not_found', '成员不存在');
  const prefs = (await prefsForTx(tx, [actor.memberId])).get(actor.memberId)!;
  const [app] = await tx.select({ bindEnabled: wecomApps.bindEnabled }).from(wecomApps).where(eq(wecomApps.orgId, actor.orgId));
  const visible = [...(await visibleProductIds(tx, actor))];
  const withChannel = visible.length
    ? await tx
        .select({ id: products.id })
        .from(products)
        .where(and(inArray(products.id, visible), isNotNull(products.personalChannelId), isNull(products.deletedAt)))
    : [];
  const [org] = await tx.select({ channelId: organizations.personalEmailChannelId }).from(organizations).where(eq(organizations.id, actor.orgId));
  const [mail] = org?.channelId
    ? await tx
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(and(eq(notificationChannels.id, org.channelId), eq(notificationChannels.enabled, true), eq(notificationChannels.kind, 'email')))
    : [];
  return {
    prefs: kindsForRole(me.orgRole).map((kind) => ({ kind, ...prefs[kind] })),
    wecom: { userid: me.wecomUserid, bindEnabled: app?.bindEnabled ?? false, productChannels: withChannel.length },
    email: { address: me.email, channelConfigured: !!mail },
  };
}

export async function getNotificationSettings(db: Db, actor: Actor): Promise<NotificationSettings> {
  return withOrg(db, actor.orgId, (tx) => settingsTx(tx, actor));
}

export async function setNotificationPref(db: Db, actor: Actor, kind: MemberNotificationKind, pref: NotificationPref): Promise<NotificationSettings> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能修改通知偏好');
  return withOrg(db, actor.orgId, async (tx) => {
    const [me] = await tx.select({ orgRole: members.orgRole }).from(members).where(eq(members.id, actor.memberId));
    if (!me) throw new AppError('not_found', '成员不存在');
    if (!kindsForRole(me.orgRole).includes(kind)) throw new AppError('invalid', '只有组织管理员接收系统告警');
    const cur = (await prefsForTx(tx, [actor.memberId])).get(actor.memberId)![kind];
    const next: NotificationPref = { inApp: pref.inApp, wecom: pref.wecom, email: pref.email };
    await tx
      .insert(P)
      .values({ orgId: actor.orgId, memberId: actor.memberId, kind, ...next })
      .onConflictDoUpdate({ target: [P.memberId, P.kind], set: { ...next, updatedAt: new Date() } });
    const changes = (['inApp', 'wecom', 'email'] as const).map((field) => ({ field, old: cur[field], new: next[field] })).filter((c) => c.old !== c.new);
    await recordEvent(tx, { orgId: actor.orgId, type: 'member.notification_pref_set', subjectType: 'member', subjectId: actor.memberId, actor, payload: { kind, changes } });
    return settingsTx(tx, actor);
  });
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './member-notifications/prefs';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/member-prefs.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/member-notifications/prefs.ts packages/core/src/index.ts packages/core/test/member-prefs.test.ts
git commit -m "feat(core): 个人通知偏好：默认值、按类读取与修改、企微与邮件可用情况

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 成员的企业微信账号（手动填写、CSV 预览与导入、自行解除）与 @ 候选成员

**Files:**
- Create: `packages/core/src/wecom/accounts.ts`
- Modify: `packages/core/src/tenancy/members.ts`（`MemberView.wecomUserid`）、`packages/core/src/index.ts`
- Test: `packages/core/test/wecom-accounts.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WECOM_USERID_RE`；Task 2 的 `members.wecomUserid`；`baseProductRole`、`requireOrgAdmin`、`requireProductRole`
- Produces:
  - `MemberView` 增加 `wecomUserid: string | null`
  - `WECOM_USERID_FORMAT`（错误文案）
  - `writeWecomUseridTx(tx, actor, memberId, userid: string | null, via: 'manual' | 'import' | 'oauth' | 'self'): Promise<{ memberId: string; wecomUserid: string | null }>`（Task 7 用；记 `member.wecom_changed`）
  - `setMemberWecomUserid(db, actor, memberId, userid: string | null)`（组织管理员）
  - `unbindMyWecom(db, actor): Promise<void>`
  - `type WecomCsvRow = { line: number; email: string; userid: string }`、`parseWecomCsv(csv: string): WecomCsvRow[]`
  - `type WecomImportStatus = 'ok' | 'unchanged' | 'not_found' | 'duplicate' | 'invalid'`、`type WecomImportRow`、`type WecomImportResult = { rows: WecomImportRow[]; counts: Record<WecomImportStatus, number>; applied: number }`
  - `previewWecomImport(db, actor, csv): Promise<WecomImportResult>`、`applyWecomImport(db, actor, csv): Promise<WecomImportResult>`
  - `type MentionMember = { id: string; displayName: string; email: string | null; status: 'active' | 'left'; wecomBound: boolean; canSeeProduct: boolean }`、`listMentionMembers(db, actor, productId): Promise<MentionMember[]>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/wecom-accounts.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, members } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createAgentMember, createPlaceholderMember, listMembers, updateMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { applyWecomImport, listMentionMembers, parseWecomCsv, previewWecomImport, setMemberWecomUserid, unbindMyWecom } from '../src/wecom/accounts';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
let zhang: string;
let li: string;
let wang: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  zhang = (await createPlaceholderMember(t.db, owner, { displayName: '张三', email: 'zhang@example.com' })).id;
  li = (await createPlaceholderMember(t.db, owner, { displayName: '李四', email: 'li@example.com' })).id;
  wang = (await createPlaceholderMember(t.db, owner, { displayName: '王五', email: 'wang@example.com' })).id;
});
afterAll(() => t.cleanup());

describe('手动填写', () => {
  it('写入、清空、记事件；列表里能看到', async () => {
    expect(await setMemberWecomUserid(t.db, owner, zhang, ' zhangsan ')).toEqual({ memberId: zhang, wecomUserid: 'zhangsan' });
    expect((await listMembers(t.db, owner)).find((m) => m.id === zhang)!.wecomUserid).toBe('zhangsan');
    const [ev] = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'member.wecom_changed'));
    expect(ev!.payload).toMatchObject({ via: 'manual', changes: [{ field: 'wecomUserid', old: null, new: 'zhangsan' }] });
    expect((await setMemberWecomUserid(t.db, owner, li, 'lisi')).wecomUserid).toBe('lisi');
    expect((await setMemberWecomUserid(t.db, owner, li, '')).wecomUserid).toBeNull();
  });

  it('重复时报已绑定到谁；格式不对；Agent 不能绑定；只有组织管理员', async () => {
    await expect(setMemberWecomUserid(t.db, owner, li, 'zhangsan')).rejects.toThrow('该企业微信账号已绑定到 张三');
    await expect(setMemberWecomUserid(t.db, owner, li, '李四')).rejects.toThrow('企业微信账号格式不正确');
    const agent = await createAgentMember(t.db, owner, { displayName: '助手' });
    await expect(setMemberWecomUserid(t.db, owner, agent.id, 'bot')).rejects.toThrow('Agent 成员不能绑定企业微信账号');
    const member = await asMember(t.db, owner, '普通成员');
    await expect(setMemberWecomUserid(t.db, member, li, 'lisi')).rejects.toThrow('需要组织管理员权限');
  });

  it('成员自行解除；只读 Token 不能解除', async () => {
    await t.adminDb.update(members).set({ wecomUserid: 'owner-wx' }).where(eq(members.id, owner.memberId));
    await expect(unbindMyWecom(t.db, readOnlyToken(owner))).rejects.toThrow('只读 Token 不能解除企业微信绑定');
    await unbindMyWecom(t.db, owner);
    expect((await t.adminDb.select().from(members).where(eq(members.id, owner.memberId)))[0]!.wecomUserid).toBeNull();
  });
});

describe('CSV 导入', () => {
  it('CSV 解析容忍 Excel 导出格式：BOM、CRLF、表头、中文逗号、引号、空行', () => {
    const csv = '﻿邮箱,企业微信账号\r\n"Zhang@Example.com","zhangsan"\r\n\r\nli@example.com，lisi\r\nwang@example.com\twangwu\r\n';
    expect(parseWecomCsv(csv)).toEqual([
      { line: 2, email: 'zhang@example.com', userid: 'zhangsan' },
      { line: 4, email: 'li@example.com', userid: 'lisi' },
      { line: 5, email: 'wang@example.com', userid: 'wangwu' },
    ]);
    expect(parseWecomCsv('a@example.com,x\n')).toEqual([{ line: 1, email: 'a@example.com', userid: 'x' }]);
  });

  it('预览分类：无变化、可匹配、找不到成员、账号重复（已绑定他人 / 文件内重复）、格式不对', async () => {
    const csv = [
      'zhang@example.com,zhangsan',
      'li@example.com,lisi',
      'nobody@example.com,nobody',
      'wang@example.com,zhangsan',
      'wang@example.com,wangwu',
      'owner@example.com,lisi',
      'li@example.com,',
      'bad@example.com,有空格 的账号',
    ].join('\n');
    const r = await previewWecomImport(t.db, owner, csv);
    expect(r.rows.map((x) => x.status)).toEqual(['unchanged', 'ok', 'not_found', 'duplicate', 'ok', 'duplicate', 'invalid', 'invalid']);
    expect(r.rows[3]!.note).toBe('该企业微信账号已绑定到 张三');
    expect(r.rows[5]!.note).toBe('与第 2 行的企业微信账号重复');
    expect(r.counts).toEqual({ ok: 2, unchanged: 1, not_found: 1, duplicate: 2, invalid: 2 });
    expect(r.applied).toBe(0);
    expect((await listMembers(t.db, owner)).find((m) => m.id === li)!.wecomUserid).toBeNull();
  });

  it('确认导入只写可匹配的行，每人一条事件', async () => {
    const r = await applyWecomImport(t.db, owner, 'li@example.com,lisi\nwang@example.com,wangwu\nnobody@example.com,x');
    expect(r.applied).toBe(2);
    const all = await listMembers(t.db, owner);
    expect(all.find((m) => m.id === li)!.wecomUserid).toBe('lisi');
    expect(all.find((m) => m.id === wang)!.wecomUserid).toBe('wangwu');
    const imports = (await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'member.wecom_changed'))).filter((e) => e.payload.via === 'import');
    expect(imports).toHaveLength(2);
  });

  it('超过 2000 行拒绝；非组织管理员不能预览', async () => {
    const big = Array.from({ length: 2001 }, (_, i) => `u${i}@example.com,u${i}`).join('\n');
    await expect(previewWecomImport(t.db, owner, big)).rejects.toThrow('一次最多导入 2000 行');
    const member = await asMember(t.db, owner, '成员乙');
    await expect(previewWecomImport(t.db, member, 'a@example.com,a')).rejects.toThrow('需要组织管理员权限');
  });
});

describe('@ 候选成员', () => {
  it('含已离开成员；看不到产品的标出来；访客调用时不返回邮箱', async () => {
    await updateMember(t.db, owner, wang, { status: 'left' });
    const guest = await asMember(t.db, owner, '访客甲');
    await updateMember(t.db, owner, guest.memberId, { orgRole: 'guest' });
    const list = await listMentionMembers(t.db, owner, productId);
    expect(list.find((m) => m.id === zhang)).toEqual({ id: zhang, displayName: '张三', email: 'zhang@example.com', status: 'active', wecomBound: true, canSeeProduct: true });
    expect(list.find((m) => m.id === wang)).toMatchObject({ status: 'left', canSeeProduct: false });
    expect(list.find((m) => m.id === guest.memberId)).toMatchObject({ status: 'active', canSeeProduct: false });
    const asGuestViewer = { ...guest, orgRole: 'guest' as const };
    await expect(listMentionMembers(t.db, asGuestViewer, productId)).rejects.toThrow('产品不存在');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/wecom-accounts.test.ts`
Expected: FAIL（`Cannot find module '../src/wecom/accounts'`）。

- [ ] **Step 3: `MemberView` 增加企业微信账号**

`tenancy/members.ts`：`MemberView` 类型在 `status` 之后加 `wecomUserid: string | null;`；`loadViews` 的映射在 `status: m.status,` 之后加 `wecomUserid: m.wecomUserid,`。

- [ ] **Step 4: 实现 `wecom/accounts.ts`**

```ts
import { and, asc, eq, ne } from 'drizzle-orm';
import { baseProductRole, requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { members, productMembers } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { WECOM_USERID_RE } from '../notifications/constants';

export const WECOM_USERID_FORMAT = '企业微信账号格式不正确：1–64 位字母、数字或 _ . @ -';
const MAX_CSV_CHARS = 200_000;
const MAX_ROWS = 2000;

export type WecomVia = 'manual' | 'import' | 'oauth' | 'self';

function normalizeUserid(raw: string | null): string | null {
  const v = raw?.trim() ?? '';
  if (!v) return null;
  if (!WECOM_USERID_RE.test(v)) throw new AppError('invalid', WECOM_USERID_FORMAT);
  return v;
}

/** 写入一个成员的企业微信账号（在调用方的事务里）。同一组织内重复时报冲突并带上已绑定成员的姓名。 */
export async function writeWecomUseridTx(tx: Tx, actor: Actor, memberId: string, raw: string | null, via: WecomVia): Promise<{ memberId: string; wecomUserid: string | null }> {
  const userid = normalizeUserid(raw);
  const [cur] = await tx.select({ kind: members.kind, wecomUserid: members.wecomUserid }).from(members).where(eq(members.id, memberId)).for('update');
  if (!cur) throw new AppError('not_found', '成员不存在');
  if (userid && cur.kind !== 'human') throw new AppError('invalid', 'Agent 成员不能绑定企业微信账号');
  if (cur.wecomUserid === userid) return { memberId, wecomUserid: userid };
  if (userid) {
    const [other] = await tx
      .select({ name: members.displayName })
      .from(members)
      .where(and(eq(members.wecomUserid, userid), ne(members.id, memberId)));
    if (other) throw new AppError('conflict', `该企业微信账号已绑定到 ${other.name}`);
  }
  try {
    await tx.update(members).set({ wecomUserid: userid }).where(eq(members.id, memberId));
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', '该企业微信账号已绑定到其他成员');
    throw e;
  }
  await recordEvent(tx, {
    orgId: actor.orgId,
    type: 'member.wecom_changed',
    subjectType: 'member',
    subjectId: memberId,
    actor,
    payload: { via, changes: [{ field: 'wecomUserid', old: cur.wecomUserid, new: userid }] },
  });
  return { memberId, wecomUserid: userid };
}

export async function setMemberWecomUserid(db: Db, actor: Actor, memberId: string, userid: string | null): Promise<{ memberId: string; wecomUserid: string | null }> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, (tx) => writeWecomUseridTx(tx, actor, memberId, userid, 'manual'));
}

export async function unbindMyWecom(db: Db, actor: Actor): Promise<void> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能解除企业微信绑定');
  await withOrg(db, actor.orgId, (tx) => writeWecomUseridTx(tx, actor, actor.memberId, null, 'self'));
}

// ---------- CSV 导入 ----------

export type WecomCsvRow = { line: number; email: string; userid: string };
export type WecomImportStatus = 'ok' | 'unchanged' | 'not_found' | 'duplicate' | 'invalid';
export type WecomImportRow = WecomCsvRow & { status: WecomImportStatus; memberId: string | null; memberName: string | null; note: string | null };
export type WecomImportResult = { rows: WecomImportRow[]; counts: Record<WecomImportStatus, number>; applied: number };

const unquote = (cell: string): string => cell.trim().replace(/^"(.*)"$/, '$1').trim();

/**
 * 两列 CSV（邮箱, 企业微信账号）：去 BOM，按行拆分，逗号、中文逗号或制表符分列，去掉引号与空行；
 * 第一行（第一个非空行）第一列不含 @ 时视为表头。行号从 1 开始，按原文件计。
 */
export function parseWecomCsv(csv: string): WecomCsvRow[] {
  if (csv.length > MAX_CSV_CHARS) throw new AppError('invalid', 'CSV 文件过大（最多 200 KB）');
  const rows: WecomCsvRow[] = [];
  let first = true;
  csv
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      if (!raw.trim()) return;
      const [email = '', userid = ''] = raw.split(/[,，\t]/).map(unquote);
      const header = first && !email.includes('@');
      first = false;
      if (header) return;
      rows.push({ line: i + 1, email: email.toLowerCase(), userid });
    });
  if (rows.length > MAX_ROWS) throw new AppError('invalid', '一次最多导入 2000 行');
  return rows;
}

const emptyCounts = (): Record<WecomImportStatus, number> => ({ ok: 0, unchanged: 0, not_found: 0, duplicate: 0, invalid: 0 });

async function planImportTx(tx: Tx, rows: WecomCsvRow[]): Promise<WecomImportRow[]> {
  const all = await tx
    .select({ id: members.id, displayName: members.displayName, email: members.email, status: members.status, kind: members.kind, wecomUserid: members.wecomUserid })
    .from(members);
  const byEmail = new Map(all.filter((m) => m.email && m.kind === 'human' && m.status === 'active').map((m) => [m.email!.toLowerCase(), m]));
  const byUserid = new Map(all.filter((m) => m.wecomUserid).map((m) => [m.wecomUserid!, m]));
  const seenUserid = new Map<string, number>();
  const seenMember = new Set<string>();
  return rows.map((r): WecomImportRow => {
    const base = { ...r, memberId: null, memberName: null, note: null };
    if (!r.email || !r.userid) return { ...base, status: 'invalid', note: '邮箱与企业微信账号都不能为空' };
    if (!WECOM_USERID_RE.test(r.userid)) return { ...base, status: 'invalid', note: WECOM_USERID_FORMAT };
    const m = byEmail.get(r.email);
    if (!m) return { ...base, status: 'not_found', note: '找不到该邮箱的在职成员' };
    const matched = { ...base, memberId: m.id, memberName: m.displayName };
    if (seenMember.has(m.id)) return { ...matched, status: 'duplicate', note: '文件中该成员重复出现' };
    const holder = byUserid.get(r.userid);
    if (holder && holder.id !== m.id) return { ...matched, status: 'duplicate', note: `该企业微信账号已绑定到 ${holder.displayName}` };
    const firstLine = seenUserid.get(r.userid);
    if (firstLine !== undefined) return { ...matched, status: 'duplicate', note: `与第 ${firstLine} 行的企业微信账号重复` };
    // 只有被采纳（可匹配或无变化）的行才占用成员与账号，被拒绝的行不影响后面的行
    seenMember.add(m.id);
    seenUserid.set(r.userid, r.line);
    if (m.wecomUserid === r.userid) return { ...matched, status: 'unchanged' };
    return { ...matched, status: 'ok', note: m.wecomUserid ? `将替换原账号 ${m.wecomUserid}` : null };
  });
}

function summarize(rows: WecomImportRow[], applied: number): WecomImportResult {
  const counts = emptyCounts();
  for (const r of rows) counts[r.status] += 1;
  return { rows, counts, applied };
}

export async function previewWecomImport(db: Db, actor: Actor, csv: string): Promise<WecomImportResult> {
  requireOrgAdmin(actor);
  const rows = parseWecomCsv(csv);
  return withOrg(db, actor.orgId, async (tx) => summarize(await planImportTx(tx, rows), 0));
}

/** 确认导入：在同一事务里重新计算，只写「可匹配」的行。 */
export async function applyWecomImport(db: Db, actor: Actor, csv: string): Promise<WecomImportResult> {
  requireOrgAdmin(actor);
  const rows = parseWecomCsv(csv);
  return withOrg(db, actor.orgId, async (tx) => {
    const planned = await planImportTx(tx, rows);
    let applied = 0;
    for (const r of planned) {
      if (r.status !== 'ok') continue;
      await writeWecomUseridTx(tx, actor, r.memberId!, r.userid, 'import');
      applied += 1;
    }
    return summarize(planned, applied);
  });
}

// ---------- @ 候选成员 ----------

export type MentionMember = { id: string; displayName: string; email: string | null; status: 'active' | 'left'; wecomBound: boolean; canSeeProduct: boolean };

/** 组织的全部真人成员（含已离开，用于显示灰色原名）；能否看到该产品按组织角色与产品角色计算。访客调用时不返回邮箱。 */
export async function listMentionMembers(db: Db, actor: Actor, productId: string): Promise<MentionMember[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const rows = await tx
      .select({ id: members.id, displayName: members.displayName, email: members.email, status: members.status, orgRole: members.orgRole, wecomUserid: members.wecomUserid })
      .from(members)
      .where(eq(members.kind, 'human'))
      .orderBy(asc(members.displayName));
    const roles = await tx.select({ memberId: productMembers.memberId, role: productMembers.role }).from(productMembers).where(eq(productMembers.productId, productId));
    const roleOf = new Map(roles.map((r) => [r.memberId, r.role]));
    const hideEmail = actor.orgRole === 'guest';
    return rows.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      email: hideEmail ? null : m.email,
      status: m.status,
      wecomBound: m.wecomUserid !== null,
      canSeeProduct: m.status === 'active' && baseProductRole(m.orgRole, roleOf.get(m.id) ?? null) !== null,
    }));
  });
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './wecom/accounts';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/wecom-accounts.test.ts test/members.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/wecom/accounts.ts packages/core/src/tenancy/members.ts packages/core/src/index.ts packages/core/test/wecom-accounts.test.ts
git commit -m "feat(core): 成员企业微信账号：手动填写、CSV 预览与导入、自行解除；@ 候选成员列表

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 企业微信应用配置与扫码绑定（一次性 state、模拟企业微信接口）

**Files:**
- Create: `packages/core/src/wecom/app.ts`、`packages/core/src/wecom/oauth.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/wecom-oauth.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `wecomApps`、`wecomBindStates`；Task 6 的 `writeWecomUseridTx`；P3-A 的 `encryptConfig`、`decryptConfig`；`randomToken`、`sha256`（`crypto.ts`）
- Produces:
  - `app.ts`：`type WecomAppView = { corpId: string; agentId: string; secretHint: string; bindEnabled: boolean; updatedAt: Date }`、`type WecomAppSettings = { app: WecomAppView | null; callbackUrl: string; callbackDomain: string }`、`type WecomAppInput = { corpId: string; agentId: string; secret?: string; bindEnabled: boolean }`、`wecomCallbackUrl(publicUrl, slug): string`、`getWecomApp(db, actor, deps: { publicUrl }): Promise<WecomAppSettings>`、`saveWecomApp(db, actor, input, deps: { secretKey; publicUrl }): Promise<WecomAppSettings>`（记 `wecom_app.updated`，`changes` 里密钥只记 hint）
  - `oauth.ts`：`WECOM_API_BASE = 'https://qyapi.weixin.qq.com'`、`WECOM_LOGIN_URL`、`WECOM_STATE_TTL_MS = 600_000`、`type WecomOAuthDeps = { secretKey: string; publicUrl: string; apiBase: string; fetch?: typeof fetch }`、`startWecomBind(db, actor, deps, now?): Promise<{ url: string }>`、`completeWecomBind(db, actor, input: { code: string | null; state: string | null }, deps, now?): Promise<{ userid: string }>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/wecom-oauth.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { domainEvents, members, wecomApps, wecomBindStates } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { decryptConfig } from '../src/notifications/secrets';
import { setMemberWecomUserid } from '../src/wecom/accounts';
import { getWecomApp, saveWecomApp } from '../src/wecom/app';
import { completeWecomBind, startWecomBind, WECOM_API_BASE, type WecomOAuthDeps } from '../src/wecom/oauth';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

const SECRET = 'app-secret-demo-0001';
const KEY = 'wecom-test-secret-wecom-test-secret-0001';

/** 假企业微信接口：只认 corpsecret = SECRET；code-ok → zhangsan，code-dup → lisi，其他 code 报错。不连网络。 */
function fakeWecom() {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const u = new URL(String(input));
    calls.push(`${u.origin}${u.pathname}`);
    if (u.pathname === '/cgi-bin/gettoken') {
      return Response.json(u.searchParams.get('corpsecret') === SECRET ? { errcode: 0, errmsg: 'ok', access_token: 'tok-1', expires_in: 7200 } : { errcode: 40001, errmsg: 'invalid credential' });
    }
    if (u.pathname === '/cgi-bin/auth/getuserinfo') {
      if (u.searchParams.get('access_token') !== 'tok-1') return Response.json({ errcode: 40014, errmsg: 'invalid access_token' });
      const code = u.searchParams.get('code');
      if (code === 'code-ok') return Response.json({ errcode: 0, errmsg: 'ok', userid: 'zhangsan' });
      if (code === 'code-dup') return Response.json({ errcode: 0, errmsg: 'ok', userid: 'lisi' });
      if (code === 'code-outsider') return Response.json({ errcode: 0, errmsg: 'ok', openid: 'o-123' });
      return Response.json({ errcode: 40029, errmsg: 'invalid code' });
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, fetchFn };
}

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let b: Actor;
const fake = fakeWecom();
const deps: WecomOAuthDeps = { secretKey: KEY, publicUrl: 'https://flower.example.com', apiBase: 'http://wecom.test', fetch: fake.fetchFn };
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  a = await asMember(t.db, owner, '张三');
  b = await asMember(t.db, owner, '李四');
});
afterAll(() => t.cleanup());
beforeEach(() => {
  fake.calls.length = 0;
});

describe('企业微信应用', () => {
  it('默认没有；首次保存必须填密钥；只返回脱敏提示与回调地址；密钥加密存储', async () => {
    expect(await getWecomApp(t.db, owner, deps)).toEqual({
      app: null,
      callbackUrl: 'https://flower.example.com/api/v1/orgs/acme/wecom/callback',
      callbackDomain: 'flower.example.com',
    });
    await expect(saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', bindEnabled: true }, deps)).rejects.toThrow('首次保存需要填写应用密钥');
    await expect(saveWecomApp(t.db, owner, { corpId: 'ww-0001', agentId: '1000002', secret: SECRET, bindEnabled: true }, deps)).rejects.toThrow('企业 ID 格式不正确');
    await expect(saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: 'x', secret: SECRET, bindEnabled: true }, deps)).rejects.toThrow('应用 ID（AgentId）应为数字');
    const s = await saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', secret: SECRET, bindEnabled: false }, deps);
    expect(s.app).toMatchObject({ corpId: 'ww0001', agentId: '1000002', secretHint: '****0001', bindEnabled: false });
    const [row] = await t.adminDb.select().from(wecomApps);
    expect(row!.secret).toMatch(/^v1:/);
    expect(decryptConfig<{ secret: string }>(row!.secret, KEY).secret).toBe(SECRET);
    const enabled = await saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', bindEnabled: true }, deps);
    expect(enabled.app!.bindEnabled).toBe(true);
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'wecom_app.updated'));
    for (const r of [s, enabled, events]) expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('只有组织管理员能查看与修改', async () => {
    await expect(getWecomApp(t.db, a, deps)).rejects.toThrow('需要组织管理员权限');
    await expect(saveWecomApp(t.db, a, { corpId: 'ww0001', agentId: '1', secret: SECRET, bindEnabled: true }, deps)).rejects.toThrow('需要组织管理员权限');
  });
});

describe('扫码绑定', () => {
  it('发起：返回企业微信扫码页地址，state 只存摘要；API Token 不能发起', async () => {
    const { url } = await startWecomBind(t.db, a, deps);
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://login.work.weixin.qq.com/wwlogin/sso/login');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      login_type: 'CorpApp',
      appid: 'ww0001',
      agentid: '1000002',
      redirect_uri: 'https://flower.example.com/api/v1/orgs/acme/wecom/callback',
    });
    const state = stateOf(url);
    const rows = await t.adminDb.select().from(wecomBindStates);
    expect(JSON.stringify(rows)).not.toContain(state);
    await expect(startWecomBind(t.db, { ...a, tokenId: '00000000-0000-0000-0000-0000000000f1' }, deps)).rejects.toThrow('请在浏览器中登录后绑定企业微信');
  });

  it('回调成功：换取 userid 写入成员，只访问注入的接口地址；默认地址是 qyapi.weixin.qq.com', async () => {
    expect(WECOM_API_BASE).toBe('https://qyapi.weixin.qq.com');
    const state = stateOf((await startWecomBind(t.db, a, deps)).url);
    expect(await completeWecomBind(t.db, a, { code: 'code-ok', state }, deps)).toEqual({ userid: 'zhangsan' });
    expect((await t.adminDb.select().from(members).where(eq(members.id, a.memberId)))[0]!.wecomUserid).toBe('zhangsan');
    expect(fake.calls).toEqual(['http://wecom.test/cgi-bin/gettoken', 'http://wecom.test/cgi-bin/auth/getuserinfo']);
    const [ev] = (await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'member.wecom_changed'))).filter((e) => e.payload.via === 'oauth');
    expect(ev!.payload).toMatchObject({ changes: [{ field: 'wecomUserid', old: null, new: 'zhangsan' }] });
  });

  it('回调的五种失败：重放、过期、不属于当前成员、取消授权、账号已被他人绑定', async () => {
    const replayed = stateOf((await startWecomBind(t.db, b, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-bad', state: replayed }, deps)).rejects.toThrow('企业微信返回错误：invalid code（40029）');
    await expect(completeWecomBind(t.db, b, { code: 'code-ok', state: replayed }, deps)).rejects.toThrow('绑定链接无效或已使用');

    const now = new Date();
    const expired = stateOf((await startWecomBind(t.db, b, deps, now)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-dup', state: expired }, deps, new Date(now.getTime() + 11 * 60_000))).rejects.toThrow('绑定链接已过期');

    const others = stateOf((await startWecomBind(t.db, a, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-dup', state: others }, deps)).rejects.toThrow('绑定链接不属于当前登录的成员');

    const cancelled = stateOf((await startWecomBind(t.db, b, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: null, state: cancelled }, deps)).rejects.toThrow('没有完成企业微信授权');

    const c = await asMember(t.db, owner, '王五');
    await setMemberWecomUserid(t.db, owner, c.memberId, 'lisi');
    const dup = stateOf((await startWecomBind(t.db, b, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-dup', state: dup }, deps)).rejects.toThrow('该企业微信账号已绑定到 王五');
    expect((await t.adminDb.select().from(members).where(eq(members.id, b.memberId)))[0]!.wecomUserid).toBeNull();
  });

  it('非本企业成员；应用密钥错误时报企业微信的错误且不含密钥；未开启时不能发起', async () => {
    const outsider = stateOf((await startWecomBind(t.db, b, deps)).url);
    await expect(completeWecomBind(t.db, b, { code: 'code-outsider', state: outsider }, deps)).rejects.toThrow('扫码的不是本企业的成员');
    await saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', secret: 'wrong-secret-9999', bindEnabled: true }, deps);
    const wrong = stateOf((await startWecomBind(t.db, b, deps)).url);
    const err = await completeWecomBind(t.db, b, { code: 'code-ok', state: wrong }, deps).catch((e: Error) => e);
    expect((err as Error).message).toBe('企业微信返回错误：invalid credential（40001）');
    expect((err as Error).message).not.toContain('wrong-secret');
    await saveWecomApp(t.db, owner, { corpId: 'ww0001', agentId: '1000002', bindEnabled: false }, deps);
    await expect(startWecomBind(t.db, b, deps)).rejects.toThrow('组织还没有开启企业微信扫码绑定');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/wecom-oauth.test.ts`
Expected: FAIL（`Cannot find module '../src/wecom/app'`）。

- [ ] **Step 3: 实现 `wecom/app.ts`**

```ts
import { eq } from 'drizzle-orm';
import { requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { organizations, wecomApps } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { encryptConfig } from '../notifications/secrets';

export type WecomAppView = { corpId: string; agentId: string; secretHint: string; bindEnabled: boolean; updatedAt: Date };
export type WecomAppSettings = { app: WecomAppView | null; callbackUrl: string; callbackDomain: string };
export type WecomAppInput = { corpId: string; agentId: string; secret?: string; bindEnabled: boolean };
type AppRow = typeof wecomApps.$inferSelect;

/** 扫码回调地址：成员在企业微信授权后跳回这里。主机名要填到自建应用的「授权回调域」。 */
export const wecomCallbackUrl = (publicUrl: string, slug: string): string => `${publicUrl.replace(/\/+$/, '')}/api/v1/orgs/${slug}/wecom/callback`;
const secretHint = (secret: string): string => `****${secret.slice(-4)}`;
const view = (r: AppRow): WecomAppView => ({ corpId: r.corpId, agentId: r.agentId, secretHint: r.secretHint, bindEnabled: r.bindEnabled, updatedAt: r.updatedAt });

async function settingsTx(tx: Tx, orgId: string, publicUrl: string): Promise<WecomAppSettings> {
  const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new AppError('not_found', '组织不存在');
  const [row] = await tx.select().from(wecomApps).where(eq(wecomApps.orgId, orgId));
  const callbackUrl = wecomCallbackUrl(publicUrl, org.slug);
  return { app: row ? view(row) : null, callbackUrl, callbackDomain: new URL(callbackUrl).host };
}

export async function getWecomApp(db: Db, actor: Actor, deps: { publicUrl: string }): Promise<WecomAppSettings> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, (tx) => settingsTx(tx, actor.orgId, deps.publicUrl));
}

/** 保存企业微信自建应用：密钥留空表示不变（首次必填），加密存储，接口与事件只出现脱敏提示。 */
export async function saveWecomApp(db: Db, actor: Actor, input: WecomAppInput, deps: { secretKey: string; publicUrl: string }): Promise<WecomAppSettings> {
  requireOrgAdmin(actor);
  const corpId = input.corpId.trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(corpId)) throw new AppError('invalid', '企业 ID 格式不正确');
  const agentId = input.agentId.trim();
  if (!/^\d{1,20}$/.test(agentId)) throw new AppError('invalid', '应用 ID（AgentId）应为数字');
  const secret = input.secret?.trim() || null;
  if (secret && (secret.length > 200 || /\s/.test(secret))) throw new AppError('invalid', '应用密钥格式不正确');
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(wecomApps).where(eq(wecomApps.orgId, actor.orgId)).for('update');
    if (!cur && !secret) throw new AppError('invalid', '首次保存需要填写应用密钥');
    const next = {
      corpId,
      agentId,
      bindEnabled: input.bindEnabled,
      secret: secret ? encryptConfig({ secret }, deps.secretKey) : cur!.secret,
      secretHint: secret ? secretHint(secret) : cur!.secretHint,
      updatedAt: new Date(),
    };
    if (cur) await tx.update(wecomApps).set(next).where(eq(wecomApps.id, cur.id));
    else await tx.insert(wecomApps).values({ orgId: actor.orgId, ...next });
    const changes = (['corpId', 'agentId', 'bindEnabled', 'secretHint'] as const)
      .map((field) => ({ field, old: cur ? cur[field] : null, new: next[field] }))
      .filter((c) => c.old !== c.new);
    await recordEvent(tx, { orgId: actor.orgId, type: 'wecom_app.updated', subjectType: 'organization', subjectId: actor.orgId, actor, payload: { changes } });
    return settingsTx(tx, actor.orgId, deps.publicUrl);
  });
}
```

- [ ] **Step 4: 实现 `wecom/oauth.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { randomToken, sha256 } from '../crypto';
import type { Db } from '../db/client';
import { organizations, wecomApps, wecomBindStates } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { WECOM_USERID_RE } from '../notifications/constants';
import { decryptConfig } from '../notifications/secrets';
import { writeWecomUseridTx } from './accounts';
import { wecomCallbackUrl } from './app';

/** 服务端只访问这个地址；测试经 deps.apiBase 换成本机假服务。 */
export const WECOM_API_BASE = 'https://qyapi.weixin.qq.com';
/** 企业微信扫码登录页：只由浏览器跳转打开，服务端不访问。 */
export const WECOM_LOGIN_URL = 'https://login.work.weixin.qq.com/wwlogin/sso/login';
export const WECOM_STATE_TTL_MS = 10 * 60 * 1000;

export type WecomOAuthDeps = { secretKey: string; publicUrl: string; apiBase: string; fetch?: typeof fetch };
type WecomReply = { errcode?: number; errmsg?: string };

const NOT_IN_BROWSER = '请在浏览器中登录后绑定企业微信';

/** 调用企业微信接口。错误信息里不出现请求网址（gettoken 的网址里含应用密钥）。 */
async function wecomGet<T extends WecomReply>(deps: WecomOAuthDeps, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, deps.apiBase);
  url.search = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new AppError('precondition_failed', '无法连接企业微信，请稍后重试');
  }
  if (!res.ok) throw new AppError('precondition_failed', `企业微信接口返回 HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new AppError('precondition_failed', '企业微信接口返回的内容无法解析');
  }
}

const wecomError = (r: WecomReply): AppError => new AppError('precondition_failed', `企业微信返回错误：${r.errmsg ?? '未知错误'}（${r.errcode ?? '无错误码'}）`);

/** 发起扫码绑定：生成一次性 state（只存摘要，10 分钟过期），返回企业微信扫码页地址。 */
export async function startWecomBind(db: Db, actor: Actor, deps: WecomOAuthDeps, now: Date = new Date()): Promise<{ url: string }> {
  if (actor.tokenId) throw new AppError('forbidden', NOT_IN_BROWSER);
  return withOrg(db, actor.orgId, async (tx) => {
    const [app] = await tx.select().from(wecomApps).where(eq(wecomApps.orgId, actor.orgId));
    if (!app?.bindEnabled) throw new AppError('invalid', '组织还没有开启企业微信扫码绑定，请联系组织管理员');
    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, actor.orgId));
    const state = randomToken(24);
    await tx.insert(wecomBindStates).values({ orgId: actor.orgId, memberId: actor.memberId, stateHash: sha256(state), expiresAt: new Date(now.getTime() + WECOM_STATE_TTL_MS) });
    const url = new URL(WECOM_LOGIN_URL);
    url.search = new URLSearchParams({ login_type: 'CorpApp', appid: app.corpId, agentid: app.agentId, redirect_uri: wecomCallbackUrl(deps.publicUrl, org!.slug), state }).toString();
    return { url: url.toString() };
  });
}

/**
 * 扫码回调：先在独立事务里把 state 标为已用（之后无论换取成功与否都不能再用），再校验所属成员、有效期与授权码，
 * 用应用密钥换 access_token、用授权码换 userid，最后写入当前成员。
 */
export async function completeWecomBind(db: Db, actor: Actor, input: { code: string | null; state: string | null }, deps: WecomOAuthDeps, now: Date = new Date()): Promise<{ userid: string }> {
  if (actor.tokenId) throw new AppError('forbidden', NOT_IN_BROWSER);
  if (!input.state) throw new AppError('invalid', '绑定链接无效或已使用，请重新扫码');
  const st = await withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .update(wecomBindStates)
      .set({ usedAt: now })
      .where(and(eq(wecomBindStates.stateHash, sha256(input.state!)), isNull(wecomBindStates.usedAt)))
      .returning();
    return row ?? null;
  });
  if (!st) throw new AppError('invalid', '绑定链接无效或已使用，请重新扫码');
  if (st.memberId !== actor.memberId) throw new AppError('invalid', '绑定链接不属于当前登录的成员，请重新扫码');
  if (st.expiresAt.getTime() <= now.getTime()) throw new AppError('invalid', '绑定链接已过期（10 分钟内有效），请重新扫码');
  if (!input.code) throw new AppError('invalid', '没有完成企业微信授权，请重新扫码');
  const app = await withOrg(db, actor.orgId, async (tx) => (await tx.select().from(wecomApps).where(eq(wecomApps.orgId, actor.orgId)))[0] ?? null);
  if (!app?.bindEnabled) throw new AppError('invalid', '组织已关闭企业微信扫码绑定');
  const { secret } = decryptConfig<{ secret: string }>(app.secret, deps.secretKey);
  const token = await wecomGet<WecomReply & { access_token?: string }>(deps, '/cgi-bin/gettoken', { corpid: app.corpId, corpsecret: secret });
  if (token.errcode !== 0 || !token.access_token) throw wecomError(token);
  const info = await wecomGet<WecomReply & { userid?: string }>(deps, '/cgi-bin/auth/getuserinfo', { access_token: token.access_token, code: input.code });
  if (info.errcode !== 0) throw wecomError(info);
  if (!info.userid) throw new AppError('invalid', '扫码的不是本企业的成员，无法绑定');
  if (!WECOM_USERID_RE.test(info.userid)) throw new AppError('invalid', '企业微信返回的账号格式无法识别');
  const userid = info.userid;
  await withOrg(db, actor.orgId, (tx) => writeWecomUseridTx(tx, actor, actor.memberId, userid, 'oauth'));
  return { userid };
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './wecom/app';
export * from './wecom/oauth';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/wecom-oauth.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/wecom/app.ts packages/core/src/wecom/oauth.ts packages/core/src/index.ts packages/core/test/wecom-oauth.test.ts
git commit -m "feat(core): 企业微信自建应用配置（密钥加密、只返回提示）与扫码绑定（一次性 state、10 分钟过期）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 通知生成：游标、收件人、去重、自动关注、失败重试与跳过（接入后台循环）

**Files:**
- Create: `packages/core/src/member-notifications/recipients.ts`、`packages/core/src/member-notifications/content.ts`、`packages/core/src/member-notifications/generate.ts`
- Modify: `packages/core/src/notifications/worker.ts`、`packages/core/src/index.ts`、`apps/web/test/api/notify-tick.test.ts`
- Test: `packages/core/test/member-notify-rules.test.ts`、`packages/core/test/member-notify-generate.test.ts`

**Interfaces:**
- Consumes: Task 2 的表；Task 3 的事件 payload；Task 4 的 `autoSubscribeTx`；Task 5 的 `prefsForTx`；`waitingFor`、`checkSnapshots`、`documentSnapshots`（`reviews/snapshot.ts`）、`reviewStarted`（`requirements/workflow-runtime.ts`）、`baseProductRole`
- Produces:
  - `recipients.ts`：`type Recipient = { id: string; displayName: string; email: string | null; orgRole: OrgRole; wecomUserid: string | null }`、`eligibleMembersTx(tx, productId: string | null, ids: string[]): Promise<Map<string, Recipient>>`
  - `content.ts`：`type EventRow`、`type NotificationSubject = { type: NotificationSubjectType; id: string; productId: string; title: string; url: string }`、`type Candidate = { memberId: string; kind: MemberNotificationKind; body: string }`、`type EventPlan = { subject; candidates; autoSubscribe: string[] }`、`HANDLED_EVENT_TYPES`、`pickRecipients(candidates, actorMemberId): Map<string, Candidate>`、`reviewJustStarted(items, states, itemKey, old): boolean`、`subjectTx(tx, slug, type, id): Promise<NotificationSubject | null>`、`planEventTx(tx, ev, slug): Promise<EventPlan | null>`
  - `generate.ts`：`type GenerateSummary = { events: number; notifications: number; skipped: number }`、`EVENT_BATCH = 500`、`MAX_EVENT_FAILURES = 3`、`generateMemberNotifications(db, orgId, deps: { publicUrl: string }, now: Date): Promise<GenerateSummary>`
  - `worker.ts`：`TickSummary` 增加 `events`、`notified`；`dueOrgIds` 增加「游标之后有事件」的组织；每轮每个组织先生成通知，再执行定时推送与发送

- [ ] **Step 1: 写失败的纯逻辑测试**

新建 `packages/core/test/member-notify-rules.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { pickRecipients, reviewJustStarted } from '../src/member-notifications/content';
import type { CheckItem } from '../src/requirements/workflow-runtime';

describe('收件人排名', () => {
  it('每人只取排名最高的一种；操作人本人不通知', () => {
    const r = pickRecipients(
      [
        { memberId: 'a', kind: 'followed_change', body: '关注' },
        { memberId: 'a', kind: 'mentioned', body: '被 @' },
        { memberId: 'a', kind: 'assigned', body: '指派' },
        { memberId: 'b', kind: 'signoff_due', body: '签字' },
        { memberId: 'b', kind: 'followed_change', body: '关注' },
        { memberId: 'me', kind: 'mentioned', body: '自己' },
      ],
      'me',
    );
    expect([...r.values()]).toEqual([
      { memberId: 'a', kind: 'mentioned', body: '被 @' },
      { memberId: 'b', kind: 'signoff_due', body: '签字' },
    ]);
  });

  it('同一种以先出现的说明为准；没有操作人时都保留', () => {
    const r = pickRecipients(
      [
        { memberId: 'a', kind: 'assigned', body: '把你设为需求负责人' },
        { memberId: 'a', kind: 'assigned', body: '把你分配为「设计」' },
      ],
      null,
    );
    expect(r.get('a')!.body).toBe('把你设为需求负责人');
  });
});

describe('评审是否由这次变化开始', () => {
  const items = [
    { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
    { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status', defaultState: 'not_started' },
  ] as CheckItem[];

  it('第一次离开默认状态才算；之后的变化与 auto 项不算', () => {
    expect(reviewJustStarted(items, { feasibility: 'in_progress', prd: 'not_started' }, 'feasibility', 'not_started')).toBe(true);
    expect(reviewJustStarted(items, { feasibility: 'passed', prd: 'not_started' }, 'feasibility', 'in_progress')).toBe(false);
    expect(reviewJustStarted(items, { feasibility: 'not_started', prd: 'passed' }, 'prd', 'not_started')).toBe(false);
  });
});
```

- [ ] **Step 2: 写失败的生成测试**

新建 `packages/core/test/member-notify-generate.test.ts`：

```ts
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { domainEvents, memberNotifications, notificationCursors, requirements, subscriptions } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import { listFields } from '../src/definitions/fields';
import type { Actor } from '../src/domain-types';
import { createDocument, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import { recordEvent } from '../src/events';
import { createIteration } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { mentionMarkup } from '../src/links/syntax';
import { setNotificationPref } from '../src/member-notifications/prefs';
import { setSubscription } from '../src/member-notifications/subscriptions';
import { runNotificationTick } from '../src/notifications/worker';
import { addRequirementAssignment } from '../src/requirements/assignments';
import { addRequirementComment } from '../src/requirements/comments';
import { createRequirement, setRequirementField, updateRequirement } from '../src/requirements/requirements';
import { setCheckItemState, transitionRequirement } from '../src/requirements/transitions';
import { createTask, updateTask } from '../src/tasks/tasks';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { setMemberFunctionTags, updateMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, prdWorkflow, regularIteration, reviewWorkflow, seedInstance } from './factories';
import { TEST_DEPS } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let b: Actor;
let boss: Actor;
let designer: Actor;
let guest: Actor;
let designTag: string;
let productId: string;
let docProductId: string;
let reqId: string;
const deps = { ...TEST_DEPS, transport: fakeTransport().transport };
const tick = (now?: Date) => runNotificationTick(t.db, deps, now);
const inbox = (memberId: string) =>
  t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.memberId, memberId)).orderBy(asc(memberNotifications.createdAt), asc(memberNotifications.id));
const cursor = async () => (await t.adminDb.select().from(notificationCursors).where(eq(notificationCursors.orgId, owner.orgId)))[0]!;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  docProductId = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  a = await asMember(t.db, owner, '张三');
  b = await asMember(t.db, owner, '李四');
  boss = await asMember(t.db, owner, '老板乙');
  designer = await asMember(t.db, owner, '设计师丁');
  await setMemberFunctionTags(t.db, owner, designer.memberId, [designTag]);
  guest = await asMember(t.db, owner, '访客');
  await updateMember(t.db, owner, guest.memberId, { orgRole: 'guest' });
  const review = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  await setProductWorkflowVersion(t.db, owner, productId, review.version.id);
  const prd = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
  await setProductWorkflowVersion(t.db, owner, docProductId, prd.version.id);
  reqId = (await createRequirement(t.db, owner, productId, { title: '登录页改版' })).id;
  await tick();
});
afterAll(() => t.cleanup());

describe('站内通知生成', () => {
  it('评论 @：被 @ 的人收到；本人与看不到产品的访客不收到；评论者与被 @ 者自动关注', async () => {
    await addRequirementComment(t.db, owner, reqId, {
      body: `${mentionMarkup(a.memberId, '张三')} ${mentionMarkup(owner.memberId, 'Owner')} ${mentionMarkup(guest.memberId, '访客')} 请看`,
    });
    const summary = await tick();
    expect(summary.notified).toBe(1);
    expect(await inbox(a.memberId)).toEqual([
      expect.objectContaining({
        kind: 'mentioned',
        subjectType: 'requirement',
        subjectId: reqId,
        title: 'PAN-1 登录页改版',
        body: '在评论中 @ 了你',
        url: '/acme/requirements/PAN-1',
        actorMemberId: owner.memberId,
        readAt: null,
      }),
    ]);
    expect(await inbox(owner.memberId)).toEqual([]);
    expect(await inbox(guest.memberId)).toEqual([]);
    const subs = await t.adminDb.select().from(subscriptions).where(eq(subscriptions.subjectId, reqId));
    expect(subs.map((s) => [s.memberId, s.source]).sort()).toEqual([[a.memberId, 'auto'], [owner.memberId, 'auto']].sort());
  });

  it('同一事件同一人只取最高的一种：既被设为负责人又被 @ 时只记被 @', async () => {
    await updateRequirement(t.db, owner, reqId, { ownerMemberId: b.memberId, description: `交给 ${mentionMarkup(b.memberId, '李四')}` });
    await tick();
    expect((await inbox(b.memberId)).map((n) => [n.kind, n.body])).toEqual([['mentioned', '在需求描述中 @ 了你']]);
  });

  it('关注对象变化：状态、优先级、迭代、新评论；取消关注的不收；操作人不收', async () => {
    await setSubscription(t.db, owner, { type: 'requirement', id: reqId }, false);
    await transitionRequirement(t.db, owner, reqId, { to: 'doing' });
    const p0 = (await listFields(t.db, owner)).find((f) => f.key === 'priority' && f.productId === null)!.options.find((o) => o.key === 'p0')!;
    await setRequirementField(t.db, owner, reqId, 'priority', [p0.id]);
    const it1 = await createIteration(t.db, owner, regularIteration(productId, '迭代一', '2026-10-01', '2026-10-31'));
    await setRequirementIteration(t.db, owner, reqId, { iterationId: it1.id });
    await addRequirementComment(t.db, b, reqId, { body: '我先看看 [[PAN-1]]' });
    await tick();
    expect((await inbox(a.memberId)).slice(1).map((n) => [n.kind, n.body])).toEqual([
      ['followed_change', '把状态从「收集」改为「开发中」'],
      ['followed_change', '把优先级从「空」改为「P0」'],
      ['followed_change', '把迭代改为「迭代一」'],
      ['followed_change', '发表了评论：我先看看 [[PAN-1]]'],
    ]);
    expect(await inbox(owner.memberId)).toEqual([]);
    expect((await inbox(b.memberId)).map((n) => n.body)).toEqual(['在需求描述中 @ 了你', '把状态从「收集」改为「开发中」', '把优先级从「空」改为「P0」', '把迭代改为「迭代一」']);
  });

  it('站内偏好关闭的类型不写站内通知', async () => {
    await setNotificationPref(t.db, a, 'followed_change', { inApp: false, wecom: false, email: false });
    const before = (await inbox(a.memberId)).length;
    await transitionRequirement(t.db, owner, reqId, { to: 'done' });
    await tick();
    expect(await inbox(a.memberId)).toHaveLength(before);
    await setNotificationPref(t.db, a, 'followed_change', { inApp: true, wecom: false, email: false });
  });

  it('被指派：新增分配（带职能名）与任务指派、改派', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '分享页' });
    await addRequirementAssignment(t.db, owner, r.id, { memberId: a.memberId, functionTagId: designTag });
    const task = await createTask(t.db, owner, { requirementId: r.id, title: '接口', assigneeMemberId: a.memberId });
    await updateTask(t.db, owner, task.id, { assigneeMemberId: b.memberId });
    await tick();
    expect((await inbox(a.memberId)).slice(-2).map((n) => [n.kind, n.subjectType, n.body, n.url])).toEqual([
      ['assigned', 'requirement', '把你分配为「设计」', '/acme/requirements/PAN-2'],
      ['assigned', 'task', '把任务指派给你', '/acme/tasks/PAN-T-1'],
    ]);
    expect((await inbox(b.memberId)).at(-1)).toMatchObject({ kind: 'assigned', subjectType: 'task', title: 'PAN-T-1 接口' });
  });

  it('等我签字：需求评审由这次检查项变化开始时，按分配给对应成员，没有分配时给标签持有者；之后的变化不重复', async () => {
    const plain = await createRequirement(t.db, owner, productId, { title: '回收站' });
    const assigned = await createRequirement(t.db, owner, productId, { title: '上传' });
    const other = await asMember(t.db, owner, '设计师戊');
    await setMemberFunctionTags(t.db, owner, other.memberId, [designTag]);
    await addRequirementAssignment(t.db, owner, assigned.id, { memberId: other.memberId, functionTagId: designTag });
    await tick();
    await setCheckItemState(t.db, owner, plain.id, 'feasibility', { state: 'in_progress' });
    await setCheckItemState(t.db, owner, assigned.id, 'feasibility', { state: 'in_progress' });
    await tick();
    const due = async (m: Actor, id: string) => (await inbox(m.memberId)).filter((n) => n.subjectId === id && n.kind === 'signoff_due');
    expect((await due(designer, plain.id)).map((n) => n.body)).toEqual(['「设计签字」等你签字']);
    expect(await due(boss, plain.id)).toHaveLength(1);
    expect(await due(designer, assigned.id)).toHaveLength(0);
    expect(await due(other, assigned.id)).toHaveLength(1);
    await setCheckItemState(t.db, owner, plain.id, 'feasibility', { state: 'passed' });
    await tick();
    expect(await due(designer, plain.id)).toHaveLength(1);
  });

  it('PRD：负责人被指派、正文新增的 @、进入评审时等签字的人与关注者', async () => {
    const doc = await createDocument(t.db, owner, docProductId, { title: '上传 PRD', ownerMemberId: a.memberId });
    await saveDocumentContent(t.db, owner, doc.id, { baseVersion: doc.version, markdown: `# 背景\n\n${mentionMarkup(b.memberId, '李四')} 配合` });
    await tick();
    expect((await inbox(a.memberId)).at(-1)).toMatchObject({ kind: 'assigned', body: '把你设为 PRD 负责人', title: 'DOC-PRD-1 上传 PRD', url: '/acme/documents/DOC-PRD-1' });
    expect((await inbox(b.memberId)).at(-1)).toMatchObject({ kind: 'mentioned', body: '在 PRD 正文中 @ 了你' });
    await transitionDocument(t.db, owner, doc.id, { to: 'review' });
    await tick();
    expect((await inbox(designer.memberId)).at(-1)).toMatchObject({ kind: 'signoff_due', subjectType: 'document', body: '「PRD 评审」等你签字' });
    expect((await inbox(a.memberId)).at(-1)).toMatchObject({ kind: 'followed_change', body: '把 PRD 状态从「草稿」改为「评审中」' });
  });

  it('收件人在处理前离开或看不到产品：不写通知、不补自动关注', async () => {
    const x = await asMember(t.db, owner, '将离开');
    const y = await asMember(t.db, owner, '将变访客');
    await addRequirementComment(t.db, owner, reqId, { body: `${mentionMarkup(x.memberId, '将离开')} ${mentionMarkup(y.memberId, '将变访客')}` });
    await updateMember(t.db, owner, x.memberId, { status: 'left' });
    await updateMember(t.db, owner, y.memberId, { orgRole: 'guest' });
    await tick();
    expect(await inbox(x.memberId)).toEqual([]);
    expect(await inbox(y.memberId)).toEqual([]);
    expect(await t.adminDb.select().from(subscriptions).where(inArray(subscriptions.memberId, [x.memberId, y.memberId]))).toEqual([]);
  });

  it('对象已删除的事件跳过且游标前移；legacy 事件不处理', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '将删除' });
    await addRequirementComment(t.db, owner, r.id, { body: `${mentionMarkup(a.memberId, '张三')} 看看` });
    await t.adminDb.update(requirements).set({ deletedAt: new Date() }).where(eq(requirements.id, r.id));
    await t.adminDb.insert(domainEvents).values({ orgId: owner.orgId, productId, type: 'legacy.push.change', subjectType: 'requirement', subjectId: reqId, payload: { mentionedMemberIds: [a.memberId] } });
    const summary = await tick();
    expect(summary.events).toBeGreaterThanOrEqual(3);
    expect((await inbox(a.memberId)).filter((n) => n.subjectId === r.id)).toEqual([]);
    const [latest] = await t.adminDb.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.orgId, owner.orgId)).orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id)).limit(1);
    expect((await cursor()).lastEventId).toBe(latest!.id);
  });

  it('未提交事务里的事件不被跳过：晚开始先提交的事件也等它提交后按顺序处理', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '长事务' });
    await tick();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = withOrg(t.db, owner.orgId, async (tx) => {
      await recordEvent(tx, { orgId: owner.orgId, productId, type: 'requirement.updated', subjectType: 'requirement', subjectId: r.id, actor: owner, payload: { changes: [], mentionedMemberIds: [a.memberId] } });
      started();
      await hold;
    });
    await begun;
    await addRequirementComment(t.db, owner, r.id, { body: `${mentionMarkup(b.memberId, '李四')} 先提交` });
    await tick();
    expect((await inbox(b.memberId)).filter((n) => n.subjectId === r.id)).toEqual([]);
    release();
    await slow;
    await tick();
    expect((await inbox(a.memberId)).filter((n) => n.subjectId === r.id).map((n) => n.body)).toEqual(['在需求描述中 @ 了你']);
    expect((await inbox(b.memberId)).filter((n) => n.subjectId === r.id).map((n) => n.body)).toEqual(['在评论中 @ 了你']);
  });

  it('同一条事件连续失败 3 次后跳过并记录警告，之后的事件照常处理', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await t.adminDb.insert(domainEvents).values({ orgId: owner.orgId, productId, type: 'comment.created', subjectType: 'requirement', subjectId: reqId, actorMemberId: owner.memberId, payload: { commentId: 'not-a-uuid' } });
    await addRequirementComment(t.db, owner, reqId, { body: `${mentionMarkup(a.memberId, '张三')} 后到` });
    const before = (await inbox(a.memberId)).length;
    await tick();
    await tick();
    expect(await inbox(a.memberId)).toHaveLength(before);
    expect((await cursor()).failures).toBe(2);
    await tick();
    expect(await inbox(a.memberId)).toHaveLength(before + 1);
    expect(await cursor()).toMatchObject({ failures: 0, failingEventId: null });
    expect(warn.mock.calls.some(([m]) => String(m).includes('连续失败 3 次，跳过该事件'))).toBe(true);
    warn.mockRestore();
    const rows = await t.adminDb.select().from(memberNotifications).where(and(eq(memberNotifications.memberId, a.memberId), eq(memberNotifications.subjectId, reqId)));
    expect(new Set(rows.map((r) => `${r.eventId}:${r.kind}`)).size).toBe(rows.length);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/member-notify-rules.test.ts test/member-notify-generate.test.ts`
Expected: FAIL（`Cannot find module '../src/member-notifications/content'`）。

- [ ] **Step 4: 实现 `member-notifications/recipients.ts`**

```ts
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { baseProductRole } from '../access/permissions';
import { members, productMembers, products } from '../db/schema';
import type { Tx } from '../db/tx';
import type { OrgRole } from '../domain-types';

export type Recipient = { id: string; displayName: string; email: string | null; orgRole: OrgRole; wecomUserid: string | null };

/**
 * 能收到某产品通知的成员：在职的真人成员，且按组织角色与产品角色能看到该产品（与 productRoleOf 同一口径，不含 Token 范围）。
 * 产品已删除时没有人；productId 为空（组织级，如系统告警）时不看产品。
 */
export async function eligibleMembersTx(tx: Tx, productId: string | null, ids: string[]): Promise<Map<string, Recipient>> {
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
  return new Map(rows.filter((m) => !productId || baseProductRole(m.orgRole, roleOf.get(m.id) ?? null) !== null).map((m) => [m.id, m]));
}
```

- [ ] **Step 5: 实现 `member-notifications/content.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { baseProductRole } from '../access/permissions';
import { comments, documents, domainEvents, functionTags, memberFunctionTags, members, productMembers, products, requirements, subscriptions, tasks } from '../db/schema';
import type { Tx } from '../db/tx';
import type { DocumentStatus } from '../documents/constants';
import { DOCUMENT_STATUS_LABELS, documentDisplayKey } from '../documents/markdown';
import { plainMentions, taskDisplayKey } from '../links/syntax';
import { MEMBER_NOTIFICATION_RANK, type MemberNotificationKind, type NotificationSubjectType } from '../notifications/constants';
import { productWorkflowBody } from '../requirements/context';
import type { CheckState } from '../requirements/labels';
import { displayKey } from '../requirements/requirements';
import { type CheckItem, reviewStarted } from '../requirements/workflow-runtime';
import { checkSnapshots, documentSnapshots, waitingFor } from '../reviews/snapshot';

export type EventRow = typeof domainEvents.$inferSelect;
export type NotificationSubject = { type: NotificationSubjectType; id: string; productId: string; title: string; url: string };
export type Candidate = { memberId: string; kind: MemberNotificationKind; body: string };
export type EventPlan = { subject: NotificationSubject; candidates: Candidate[]; autoSubscribe: string[] };
type Change = { field: string; old: unknown; new: unknown };

/** 会生成站内通知的事件；其余事件（含 legacy.*）不处理。 */
export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'comment.created',
  'requirement.created',
  'requirement.updated',
  'requirement.assignment_added',
  'requirement.state_changed',
  'requirement.field_changed',
  'requirement.iteration_changed',
  'document.created',
  'document.updated',
  'document.saved',
  'document.status_changed',
  'check_item.updated',
  'check_item.signed',
  'task.created',
  'task.updated',
]);

const TITLE_MAX = 120;
const EXCERPT_MAX = 60;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const changeOf = (payload: Record<string, unknown>, field: string): Change | undefined =>
  (Array.isArray(payload.changes) ? (payload.changes as Change[]) : []).find((c) => c.field === field);
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
const asId = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** 变化前后的值：数组用顿号连接，空值为「空」。 */
const shown = (v: unknown): string => (Array.isArray(v) ? (v.length ? v.join('、') : '空') : v === null || v === undefined || v === '' ? '空' : String(v));

/** 每人只取排名最高的一种（同一种以先出现的为准）；操作人本人不通知。 */
export function pickRecipients(candidates: Candidate[], actorMemberId: string | null): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  for (const c of candidates) {
    if (c.memberId === actorMemberId) continue;
    const cur = out.get(c.memberId);
    if (!cur || MEMBER_NOTIFICATION_RANK[c.kind] > MEMBER_NOTIFICATION_RANK[cur.kind]) out.set(c.memberId, c);
  }
  return out;
}

/** 需求的评审是否由这次检查项变化开始：变化后已开始，换回变化前的状态则未开始。 */
export function reviewJustStarted(items: CheckItem[], states: Record<string, CheckState>, itemKey: string, old: CheckState): boolean {
  return reviewStarted(items, states) && !reviewStarted(items, { ...states, [itemKey]: old });
}

/** 通知指向的对象：「编号 标题」与站内路径；对象或所在产品已删除时为 null。 */
export async function subjectTx(tx: Tx, slug: string, type: string, id: string): Promise<NotificationSubject | null> {
  if (type === 'requirement') {
    const [r] = await tx
      .select({ productId: requirements.productId, number: requirements.number, title: requirements.title, key: products.key })
      .from(requirements)
      .innerJoin(products, eq(products.id, requirements.productId))
      .where(and(eq(requirements.id, id), isNull(requirements.deletedAt), isNull(products.deletedAt)));
    if (!r) return null;
    const k = displayKey(r.key, r.number);
    return { type: 'requirement', id, productId: r.productId, title: clip(`${k} ${r.title}`, TITLE_MAX), url: `/${slug}/requirements/${k}` };
  }
  if (type === 'document') {
    const [d] = await tx
      .select({ productId: documents.productId, number: documents.number, title: documents.title, key: products.key })
      .from(documents)
      .innerJoin(products, eq(products.id, documents.productId))
      .where(and(eq(documents.id, id), isNull(documents.deletedAt), isNull(products.deletedAt)));
    if (!d) return null;
    const k = documentDisplayKey(d.key, d.number);
    return { type: 'document', id, productId: d.productId, title: clip(`${k} ${d.title}`, TITLE_MAX), url: `/${slug}/documents/${k}` };
  }
  if (type === 'task') {
    const [x] = await tx
      .select({ productId: tasks.productId, number: tasks.number, title: tasks.title, key: products.key })
      .from(tasks)
      .innerJoin(products, eq(products.id, tasks.productId))
      .where(and(eq(tasks.id, id), isNull(products.deletedAt)));
    if (!x) return null;
    const k = taskDisplayKey(x.key, x.number);
    return { type: 'task', id, productId: x.productId, title: clip(`${k} ${x.title}`, TITLE_MAX), url: `/${slug}/tasks/${k}` };
  }
  return null;
}

/** 未取消关注的关注者（只有需求与 PRD 可以关注）。 */
async function followersTx(tx: Tx, subject: NotificationSubject): Promise<string[]> {
  if (subject.type !== 'requirement' && subject.type !== 'document') return [];
  const rows = await tx
    .select({ memberId: subscriptions.memberId })
    .from(subscriptions)
    .where(and(eq(subscriptions.subjectType, subject.type), eq(subscriptions.subjectId, subject.id), isNull(subscriptions.mutedAt)));
  return rows.map((r) => r.memberId);
}

/** 等这个需求或 PRD 签字的成员：与工作台同一个 waitingFor，只取本人规则（不含代签）。PRD 只在进入评审时调用。 */
async function signersTx(tx: Tx, subject: NotificationSubject): Promise<Candidate[]> {
  const body = await productWorkflowBody(tx, subject.productId);
  const scope = subject.type === 'requirement' ? 'requirement' : 'document';
  const items = body.checkItems.filter((c) => c.scope === scope);
  if (!items.some((c) => c.type === 'signoff')) return [];
  const snap =
    subject.type === 'requirement' ? (await checkSnapshots(tx, body, [subject.id])).get(subject.id)! : (await documentSnapshots(tx, body, [subject.id])).get(subject.id)!;
  const people = await tx
    .select({ id: members.id, orgRole: members.orgRole })
    .from(members)
    .where(and(eq(members.status, 'active'), eq(members.kind, 'human')));
  const tags = await tx.select({ memberId: memberFunctionTags.memberId, tagId: memberFunctionTags.tagId }).from(memberFunctionTags);
  const roles = await tx.select({ memberId: productMembers.memberId, role: productMembers.role }).from(productMembers).where(eq(productMembers.productId, subject.productId));
  const roleOf = new Map(roles.map((r) => [r.memberId, r.role]));
  const out: Candidate[] = [];
  for (const p of people) {
    const productRole = baseProductRole(p.orgRole, roleOf.get(p.id) ?? null);
    if (!productRole) continue;
    const who = { memberId: p.id, functionTagIds: tags.filter((x) => x.memberId === p.id).map((x) => x.tagId), productRole };
    const waiting = waitingFor(items, snap, who, false, subject.type === 'document' ? true : undefined).filter((w) => !w.onBehalf);
    if (waiting.length === 0) continue;
    const labels = [...new Set(waiting.map((w) => items.find((c) => c.key === w.itemKey)!.label))];
    out.push({ memberId: p.id, kind: 'signoff_due', body: `「${labels.join('」「')}」等你签字` });
  }
  return out;
}

/** 一条事件要通知谁、说什么、给谁补自动关注；不生成通知的事件与对象已删除的事件返回 null。 */
export async function planEventTx(tx: Tx, ev: EventRow, slug: string): Promise<EventPlan | null> {
  if (!HANDLED_EVENT_TYPES.has(ev.type)) return null;
  const subject = await subjectTx(tx, slug, ev.subjectType, ev.subjectId);
  if (!subject) return null;
  const p = ev.payload;
  const candidates: Candidate[] = [];
  const autoSubscribe: string[] = [];
  const add = (ids: Array<string | null>, kind: MemberNotificationKind, body: string) => {
    for (const id of ids) if (id) candidates.push({ memberId: id, kind, body });
  };
  const assign = (id: string | null, body: string) => {
    add([id], 'assigned', body);
    if (id) autoSubscribe.push(id);
  };
  const mention = (ids: string[], body: string) => {
    add(ids, 'mentioned', body);
    autoSubscribe.push(...ids);
  };
  const notifyFollowers = async (body: string) => add(await followersTx(tx, subject), 'followed_change', body);

  switch (ev.type) {
    case 'comment.created': {
      mention(idList(p.mentionedMemberIds), '在评论中 @ 了你');
      if (ev.actorMemberId) autoSubscribe.push(ev.actorMemberId);
      const commentId = asId(p.commentId);
      const [c] = commentId ? await tx.select({ body: comments.body }).from(comments).where(eq(comments.id, commentId)) : [];
      await notifyFollowers(`发表了评论：${clip(plainMentions(c?.body ?? '').replace(/\s+/g, ' ').trim(), EXCERPT_MAX)}`);
      break;
    }
    case 'requirement.created':
      assign(asId(p.ownerMemberId), '把你设为需求负责人');
      mention(idList(p.mentionedMemberIds), '在需求描述中 @ 了你');
      break;
    case 'requirement.updated':
      assign(asId(changeOf(p, 'ownerMemberId')?.new), '把你设为需求负责人');
      mention(idList(p.mentionedMemberIds), '在需求描述中 @ 了你');
      break;
    case 'requirement.assignment_added': {
      const a = changeOf(p, 'assignments')?.new as { memberId?: unknown; functionTagId?: unknown } | null | undefined;
      const tagId = asId(a?.functionTagId);
      const [tag] = tagId ? await tx.select({ name: functionTags.name }).from(functionTags).where(eq(functionTags.id, tagId)) : [];
      assign(asId(a?.memberId), tag ? `把你分配为「${tag.name}」` : '把你分配到这条需求');
      break;
    }
    case 'requirement.state_changed': {
      const ch = changeOf(p, 'stateKey');
      const wf = await productWorkflowBody(tx, subject.productId);
      const name = (k: unknown) => wf.states.find((s) => s.key === k)?.label ?? shown(k);
      await notifyFollowers(`把状态从「${name(ch?.old)}」改为「${name(ch?.new)}」`);
      break;
    }
    case 'requirement.field_changed': {
      const ch = changeOf(p, 'priority');
      if (ch) await notifyFollowers(`把优先级从「${shown(ch.old)}」改为「${shown(ch.new)}」`);
      break;
    }
    case 'requirement.iteration_changed':
      await notifyFollowers(
        asId(changeOf(p, 'iterationId')?.new) ? `把迭代改为「${typeof p.iterationName === 'string' ? p.iterationName : '未命名迭代'}」` : '把需求移出了迭代',
      );
      break;
    case 'document.created':
      assign(asId(p.ownerMemberId), '把你设为 PRD 负责人');
      break;
    case 'document.updated':
      assign(asId(changeOf(p, 'ownerMemberId')?.new), '把你设为 PRD 负责人');
      break;
    case 'document.saved':
      mention(idList(p.mentionedMemberIds), '在 PRD 正文中 @ 了你');
      break;
    case 'document.status_changed': {
      const ch = changeOf(p, 'status');
      const name = (s: unknown) => DOCUMENT_STATUS_LABELS[s as DocumentStatus] ?? shown(s);
      await notifyFollowers(`把 PRD 状态从「${name(ch?.old)}」改为「${name(ch?.new)}」`);
      if (ch?.new === 'review') candidates.push(...(await signersTx(tx, subject)));
      break;
    }
    case 'check_item.updated':
    case 'check_item.signed': {
      const ch = changeOf(p, 'state');
      const itemKey = typeof p.itemKey === 'string' ? p.itemKey : null;
      if (subject.type !== 'requirement' || !ch || !itemKey) break;
      const wf = await productWorkflowBody(tx, subject.productId);
      const items = wf.checkItems.filter((c) => c.scope === 'requirement');
      const snap = (await checkSnapshots(tx, wf, [subject.id])).get(subject.id)!;
      if (reviewJustStarted(items, snap.states, itemKey, ch.old as CheckState)) candidates.push(...(await signersTx(tx, subject)));
      break;
    }
    case 'task.created':
      add([asId(p.assigneeMemberId)], 'assigned', '把任务指派给你');
      break;
    case 'task.updated':
      add([asId(changeOf(p, 'assigneeMemberId')?.new)], 'assigned', '把任务指派给你');
      break;
  }
  return { subject, candidates, autoSubscribe };
}
```

- [ ] **Step 6: 实现 `member-notifications/generate.ts`**

```ts
import { asc, and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { domainEvents, memberNotifications, notificationCursors, organizations } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { type EventRow, pickRecipients, planEventTx } from './content';
import { prefsForTx } from './prefs';
import { eligibleMembersTx } from './recipients';
import { autoSubscribeTx } from './subscriptions';

export type GenerateSummary = { events: number; notifications: number; skipped: number };
/** 每轮每个组织最多处理的事件数。 */
export const EVENT_BATCH = 500;
/** 同一条事件连续失败这么多次后跳过。 */
export const MAX_EVENT_FAILURES = 3;

const E = domainEvents;
const C = notificationCursors;
const N = memberNotifications;

/** 只取底层原因（drizzle 的查询错误把 SQL 与参数放在外层 message 里）。 */
function causeMessage(e: unknown): string {
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 游标之后、且早于本库其他会话里最早的事务开始时间的事件。领域事件的 occurred_at 是写入事务的开始时间：
 * 未提交事务里的事件提交前看不到，若不加这个上限，游标会越过它。比较全部在 SQL 里做（occurred_at 为微秒精度）。
 */
const pendingEvents = (orgId: string) =>
  and(
    eq(E.orgId, orgId),
    sql`not exists (select 1 from ${C} c where c.org_id = ${E.orgId} and c.last_event_id is not null and (${E.occurredAt}, ${E.id}) <= (c.last_occurred_at, c.last_event_id))`,
    sql`${E.occurredAt} < (select least(now(), coalesce(min(a.xact_start), now())) from pg_stat_activity a where a.datname = current_database() and a.pid <> pg_backend_pid() and a.xact_start is not null)`,
  );

/** 处理一条事件：算收件人、按偏好写站内通知（同一人同一事件同一类只一条）、补自动关注。返回新写的通知数。 */
async function processEventTx(tx: Tx, ev: EventRow, slug: string): Promise<number> {
  const plan = await planEventTx(tx, ev, slug);
  if (!plan) return 0;
  const chosen = pickRecipients(plan.candidates, ev.actorMemberId);
  const eligible = await eligibleMembersTx(tx, plan.subject.productId, [...chosen.keys(), ...plan.autoSubscribe]);
  const recipients = [...chosen.values()].filter((c) => eligible.has(c.memberId));
  const prefs = await prefsForTx(tx, recipients.map((c) => c.memberId));
  let created = 0;
  for (const c of recipients) {
    if (!prefs.get(c.memberId)![c.kind].inApp) continue;
    const rows = await tx
      .insert(N)
      .values({
        orgId: ev.orgId,
        memberId: c.memberId,
        eventId: ev.id,
        kind: c.kind,
        subjectType: plan.subject.type,
        subjectId: plan.subject.id,
        title: plan.subject.title,
        body: c.body,
        url: plan.subject.url,
        actorMemberId: ev.actorMemberId,
      })
      .onConflictDoNothing()
      .returning({ id: N.id });
    created += rows.length;
  }
  const type = plan.subject.type;
  if (type === 'requirement' || type === 'document') {
    await autoSubscribeTx(tx, ev.orgId, { type, id: plan.subject.id }, plan.autoSubscribe.filter((id) => eligible.has(id)));
  }
  return created;
}

/**
 * 处理一个组织游标之后的新事件（最多 EVENT_BATCH 条）。先建游标行再 SKIP LOCKED 锁住：拿不到说明另一个实例在处理，本轮跳过。
 * 每条事件在 savepoint 里处理，成功后前移游标；失败时记下事件与次数并结束本轮，同一条连续失败 MAX_EVENT_FAILURES 次后跳过。
 * legacy.* 事件不处理，只前移游标。后台写入，不记领域事件。
 */
export async function generateMemberNotifications(db: Db, orgId: string, deps: { publicUrl: string }, now: Date): Promise<GenerateSummary> {
  return withOrg(db, orgId, async (tx) => {
    const summary: GenerateSummary = { events: 0, notifications: 0, skipped: 0 };
    await tx.insert(C).values({ orgId }).onConflictDoNothing();
    const [cursor] = await tx.select().from(C).where(eq(C.orgId, orgId)).for('update', { skipLocked: true });
    if (!cursor) return summary;
    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId));
    const events = await tx.select().from(E).where(pendingEvents(orgId)).orderBy(asc(E.occurredAt), asc(E.id)).limit(EVENT_BATCH);
    let last: string | null = null;
    let failing: { eventId: string; failures: number } | null = null;
    for (const ev of events) {
      if (!ev.type.startsWith('legacy.')) {
        try {
          summary.notifications += await tx.transaction((sp) => processEventTx(sp, ev, org!.slug));
        } catch (e) {
          const failures = cursor.failingEventId === ev.id ? cursor.failures + 1 : 1;
          if (failures < MAX_EVENT_FAILURES) {
            console.warn(`[notify] 站内通知生成失败（第 ${failures} 次），下一轮重试：org=${orgId} event=${ev.id} type=${ev.type}：${causeMessage(e)}`);
            failing = { eventId: ev.id, failures };
            break;
          }
          console.warn(`[notify] 站内通知生成连续失败 ${MAX_EVENT_FAILURES} 次，跳过该事件：org=${orgId} event=${ev.id} type=${ev.type}：${causeMessage(e)}`);
          summary.skipped += 1;
        }
      }
      last = ev.id;
      summary.events += 1;
    }
    if (last || failing || cursor.failingEventId) {
      await tx
        .update(C)
        .set({
          ...(last ? { lastOccurredAt: sql`(select ${E.occurredAt} from ${E} where ${E.id} = ${last})`, lastEventId: last } : {}),
          failingEventId: failing?.eventId ?? null,
          failures: failing?.failures ?? 0,
          updatedAt: now,
        })
        .where(eq(C.orgId, orgId));
    }
    return summary;
  });
}
```

（`deps.publicUrl` 在 Task 9 用于企微与邮件里的绝对链接。）

- [ ] **Step 7: 接入后台循环 `notifications/worker.ts`**

导入改为：

```ts
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { domainEvents, notificationCursors, notificationDeliveries, notificationSchedules, organizations } from '../db/schema';
import { withOrg, withSystem } from '../db/tx';
import { generateMemberNotifications } from '../member-notifications/generate';
```

（其余导入不变。）`TickSummary` 改为：

```ts
export type TickSummary = ProcessSummary & { orgs: number; schedulesRun: number; events: number; notified: number };
```

`dueOrgIds` 改为：

```ts
/**
 * 后台循环唯一的跨组织查询：有到期（或租约到期）的发送记录、有需要排期或到点的定时推送、
 * 或游标之后有新事件（没有游标行的组织从头处理）的组织。
 */
async function dueOrgIds(db: Db, now: Date): Promise<string[]> {
  return withSystem(db, async (tx) => {
    const a = await tx.selectDistinct({ orgId: D.orgId }).from(D).where(and(inArray(D.status, ['pending', 'failed', 'sending']), lte(D.nextAttemptAt, now)));
    const b = await tx.selectDistinct({ orgId: S.orgId }).from(S).where(dueSchedule(now));
    const c = await tx
      .select({ orgId: organizations.id })
      .from(organizations)
      .where(
        and(
          isNull(organizations.deletedAt),
          sql`exists (select 1 from ${domainEvents} e left join ${notificationCursors} c on c.org_id = e.org_id
                      where e.org_id = ${organizations.id} and (c.last_event_id is null or (e.occurred_at, e.id) > (c.last_occurred_at, c.last_event_id)))`,
        ),
      );
    return [...new Set([...a, ...b, ...c].map((r) => r.orgId))];
  });
}
```

`runNotificationTick` 里 summary 的初值改为 `{ orgs: 0, schedulesRun: 0, events: 0, notified: 0, sent: 0, failed: 0, dead: 0, rateLimited: 0 }`，`try` 块开头加：

```ts
      const g = await generateMemberNotifications(db, orgId, deps, orgNow);
      summary.events += g.events;
      summary.notified += g.notifications;
```

函数注释改为「一轮：逐个组织先生成站内通知，再执行到点的定时推送，最后发送到期的记录。……」（后半句不变）。

`packages/core/src/index.ts` 末尾加：

```ts
export * from './member-notifications/recipients';
export * from './member-notifications/content';
export * from './member-notifications/generate';
```

`apps/web/test/api/notify-tick.test.ts` 的 `toEqual` 改为（组织 acme 初始化时有事件，没有游标行，第一轮会处理它们）：

```ts
    expect(r.body.summary).toMatchObject({ orgs: 1, schedulesRun: 0, notified: 0, sent: 0, failed: 0, dead: 0, rateLimited: 0 });
    expect(r.body.summary.events).toBeGreaterThan(0);
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/member-notify-rules.test.ts test/member-notify-generate.test.ts test/notify-worker.test.ts test/notify-deliveries.test.ts && pnpm --filter @flower/web exec vitest run test/api/notify-tick.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误。

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/member-notifications packages/core/src/notifications/worker.ts packages/core/src/index.ts packages/core/test/member-notify-rules.test.ts packages/core/test/member-notify-generate.test.ts apps/web/test/api/notify-tick.test.ts
git commit -m "feat(core): 后台循环生成站内通知：游标与未提交事务保护、收件人排名与过滤、自动关注、失败重试与跳过

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 个人提醒通道与企业微信、邮件分发（经 P3-A 发送队列）

**Files:**
- Create: `packages/core/src/member-notifications/channels.ts`、`packages/core/src/member-notifications/dispatch.ts`
- Modify: `packages/core/src/member-notifications/generate.ts`、`packages/core/src/notifications/constants.ts`（邮件请求体可带收件人）、`packages/core/src/notifications/sender.ts`、`packages/core/src/notifications/deliveries.ts`、`packages/core/test/notify-transport.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/member-notify-dispatch.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `products.personalChannelId`、`organizations.personalEmailChannelId`、发送记录 `personal`；Task 8 的 `generateMemberNotifications` 与 `Recipient`；P3-A 的 `usableChannelsTx`、`truncateBytes`、`WECOM_MARKDOWN_MAX_BYTES`、`processDueDeliveries`
- Produces:
  - `channels.ts`：`type PersonalChannelSetting = { channelId: string | null }`、`getPersonalChannel(db, actor, productId)`、`setPersonalChannel(db, actor, productId, channelId | null)`（产品管理员；记 `product.personal_channel_set`）、`getPersonalEmailChannel(db, actor)`、`setPersonalEmailChannel(db, actor, channelId | null)`（组织管理员；记 `organization.personal_email_channel_set`）
  - `dispatch.ts`：`type OutboundItem = { productId: string | null; memberId: string; email: string | null; wecomUserid: string | null; viaWecom: boolean; viaEmail: boolean; actorName: string | null; body: string; title: string; url: string }`、`wecomLine(item, publicUrl): string`、`chunkLines(lines, maxBytes?): string[]`、`emailFor(items, publicUrl): { subject: string; text: string }`、`dispatchPersonalTx(tx, orgId, items, publicUrl, now): Promise<{ wecom: number; email: number }>`（Task 10 的系统告警也用）
  - `ChannelPayload` 的邮件分支增加可选 `to?: string[]`；`Transport.sendMail(config, { subject, text, to? })`
  - 发送时 `personal` 记录与测试消息一样不受通道「可用产品」限制（生成时已检查）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/member-notify-dispatch.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memberNotifications, members, notificationDeliveries } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { mentionMarkup } from '../src/links/syntax';
import { getPersonalChannel, getPersonalEmailChannel, setPersonalChannel, setPersonalEmailChannel } from '../src/member-notifications/channels';
import { chunkLines, emailFor, type OutboundItem, wecomLine } from '../src/member-notifications/dispatch';
import { setNotificationPref } from '../src/member-notifications/prefs';
import { createChannel, updateChannel } from '../src/notifications/channels';
import { runNotificationTick } from '../src/notifications/worker';
import { addRequirementComment } from '../src/requirements/comments';
import { createRequirement } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
let otherProductId: string;
let zhang: string;
let li: string;
let wu: string;
let channelId: string;
let mailId: string;
const fake = fakeTransport();
const deps = { ...TEST_DEPS, transport: fake.transport };
const tick = (now?: Date) => runNotificationTick(t.db, deps, now);
const contents = () => fake.calls.map((c) => (c.body as { markdown: { content: string } }).markdown.content);
const EMAIL = { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] };

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  otherProductId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  zhang = (await createPlaceholderMember(t.db, owner, { displayName: '张三', email: 'zhang@example.com' })).id;
  li = (await createPlaceholderMember(t.db, owner, { displayName: '李四' })).id;
  wu = (await createPlaceholderMember(t.db, owner, { displayName: '吴六' })).id;
  await t.adminDb.update(members).set({ wecomUserid: 'zhangsan' }).where(eq(members.id, zhang));
  await t.adminDb.update(members).set({ wecomUserid: 'lisi' }).where(eq(members.id, li));
  channelId = (await wecomChannel(t.db, owner, '研发群', { rateLimitPerMin: 100 })).id;
  mailId = (await createChannel(t.db, owner, { kind: 'email', name: '通知邮件', config: EMAIL }, TEST_DEPS)).id;
  await tick();
});
afterAll(() => t.cleanup());
beforeEach(() => fake.reset(() => ({ status: 200, text: '{"errcode":0,"errmsg":"ok"}' })));

describe('个人提醒通道', () => {
  it('产品管理员设置：只能选对本产品可用、已启用的企业微信通道；可以清空', async () => {
    expect(await getPersonalChannel(t.db, owner, productId)).toEqual({ channelId: null });
    const unusable = '个人提醒通道只能选择对本产品可用、已启用的企业微信机器人通道';
    await expect(setPersonalChannel(t.db, owner, productId, mailId)).rejects.toThrow(unusable);
    const off = await wecomChannel(t.db, owner, '停用群', { enabled: false });
    await expect(setPersonalChannel(t.db, owner, productId, off.id)).rejects.toThrow(unusable);
    const elsewhere = await wecomChannel(t.db, owner, '相册群', { allowedProductIds: [otherProductId] });
    await expect(setPersonalChannel(t.db, owner, productId, elsewhere.id)).rejects.toThrow(unusable);
    expect(await setPersonalChannel(t.db, owner, productId, channelId)).toEqual({ channelId });
    const editor = await asMember(t.db, owner, '编辑');
    await expect(setPersonalChannel(t.db, editor, productId, null)).rejects.toThrow('权限不足');
  });

  it('组织管理员设置个人通知邮件通道：只能选启用的邮件通道', async () => {
    expect(await getPersonalEmailChannel(t.db, owner)).toEqual({ channelId: null });
    await expect(setPersonalEmailChannel(t.db, owner, channelId)).rejects.toThrow('个人通知邮件通道只能选择已启用的邮件通道');
    expect(await setPersonalEmailChannel(t.db, owner, mailId)).toEqual({ channelId: mailId });
    const editor = await asMember(t.db, owner, '编辑乙');
    await expect(setPersonalEmailChannel(t.db, editor, null)).rejects.toThrow('需要组织管理员权限');
  });
});

describe('企业微信与邮件分发', () => {
  it('同一轮同一产品合并为一条 markdown 并 @ 到本人；未绑定的人只有站内通知', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '登录页', ownerMemberId: zhang });
    await addRequirementComment(t.db, owner, r.id, { body: `${mentionMarkup(li, '李四')} ${mentionMarkup(wu, '吴六')} 看下` });
    const summary = await tick();
    expect(summary.sent).toBe(1);
    expect(contents()).toEqual([
      [
        `<@zhangsan> Owner 把你设为需求负责人：[PAN-1 登录页](http://flower.example.com/acme/requirements/PAN-1)`,
        `<@lisi> Owner 在评论中 @ 了你：[PAN-1 登录页](http://flower.example.com/acme/requirements/PAN-1)`,
      ].join('\n'),
    ]);
    expect(await t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.memberId, wu))).toHaveLength(1);
    const [d] = await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.kind, 'personal'));
    expect(d).toMatchObject({ channelId, status: 'sent', ruleId: null, scheduleId: null });
  });

  it('邮件：偏好开启的人每轮合并成一封，发到成员邮箱；没有邮箱的人不发', async () => {
    const zhangActor: Actor = { ...owner, memberId: zhang, orgRole: 'member', accountId: null };
    await setNotificationPref(t.db, zhangActor, 'assigned', { inApp: true, wecom: false, email: true });
    await createRequirement(t.db, owner, productId, { title: '分享页', ownerMemberId: zhang });
    await createRequirement(t.db, owner, productId, { title: '回收站', ownerMemberId: zhang });
    await tick();
    expect(fake.mails).toEqual([
      {
        to: ['zhang@example.com'],
        subject: 'Flower：你有 2 条新通知',
        text: [
          'Owner 把你设为需求负责人：PAN-2 分享页',
          'http://flower.example.com/acme/requirements/PAN-2',
          '',
          'Owner 把你设为需求负责人：PAN-3 回收站',
          'http://flower.example.com/acme/requirements/PAN-3',
          '',
          '在 Flower 的个人设置里可以修改通知偏好。',
        ].join('\n'),
      },
    ]);
    expect(contents()).toEqual([]);
  });

  it('个人提醒通道停用或产品没有指定时不发企业微信，站内照常', async () => {
    await updateChannel(t.db, owner, channelId, { enabled: false }, TEST_DEPS);
    const r = await createRequirement(t.db, owner, productId, { title: '上传', ownerMemberId: li });
    await tick();
    expect(fake.calls).toEqual([]);
    expect((await t.adminDb.select().from(memberNotifications).where(and(eq(memberNotifications.memberId, li), eq(memberNotifications.subjectId, r.id))))).toHaveLength(1);
    await updateChannel(t.db, owner, channelId, { enabled: true }, TEST_DEPS);
    await createRequirement(t.db, owner, otherProductId, { title: '相册首页', ownerMemberId: li });
    await tick();
    expect(fake.calls).toEqual([]);
  });

  it('两个实例同时处理：每条事件只处理一次，个人提醒只写一次', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '并发', ownerMemberId: li });
    const now = new Date();
    await Promise.all([tick(now), tick(now)]);
    await tick();
    const rows = (await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.kind, 'personal'))).filter((d) =>
      JSON.stringify(d.payload).includes('PAN-5 并发'),
    );
    expect(rows).toHaveLength(1);
    expect((await t.adminDb.select().from(memberNotifications).where(and(eq(memberNotifications.memberId, li), eq(memberNotifications.subjectId, r.id))))).toHaveLength(1);
  });
});

describe('消息拼装', () => {
  const item = (over: Partial<OutboundItem> = {}): OutboundItem => ({
    productId: 'p',
    memberId: 'm',
    email: 'm@example.com',
    wecomUserid: 'u1',
    viaWecom: true,
    viaEmail: false,
    actorName: '张三',
    body: '在评论中 @ 了你',
    title: 'PAN-1 [草稿] 标题',
    url: '/acme/requirements/PAN-1',
    ...over,
  });

  it('企微一行：标题里的方括号去掉；没有操作人时为「系统」', () => {
    expect(wecomLine(item(), 'https://flower.example.com/')).toBe('<@u1> 张三 在评论中 @ 了你：[PAN-1  草稿  标题](https://flower.example.com/acme/requirements/PAN-1)');
    expect(wecomLine(item({ actorName: null }), 'https://flower.example.com')).toContain('<@u1> 系统 ');
  });

  it('按行合并，每条不超过 4096 字节；单行超长时截断', () => {
    const line = 'a'.repeat(1500);
    const chunks = chunkLines([line, line, line, line]);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => Buffer.byteLength(c, 'utf8') <= 4096)).toBe(true);
    expect(chunks[0]!.split('\n')).toHaveLength(2);
    const huge = chunkLines(['中'.repeat(3000)]);
    expect(huge).toHaveLength(1);
    expect(Buffer.byteLength(huge[0]!, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('邮件主题带条数', () => {
    expect(emailFor([item(), item()], 'https://flower.example.com').subject).toBe('Flower：你有 2 条新通知');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/member-notify-dispatch.test.ts`
Expected: FAIL（`Cannot find module '../src/member-notifications/channels'`）。

- [ ] **Step 3: 邮件请求体可以带收件人**

`notifications/constants.ts` 的 `ChannelPayload` 改为：

```ts
/** 一次发送的请求体：企微与 Webhook 为 JSON，邮件为主题与正文（to 覆盖通道配置里的收件人，个人提醒用）。 */
export type ChannelPayload = { type: 'json'; body: Record<string, unknown> } | { type: 'email'; subject: string; text: string; to?: string[] };
```

`notifications/sender.ts`：

```ts
export type Transport = {
  postJson(url: string, body: string, headers: Record<string, string>): Promise<HttpResult>;
  sendMail(config: EmailConfig, message: { subject: string; text: string; to?: string[] }): Promise<string>;
};
```

`defaultTransport.sendMail` 里 `transporter.sendMail` 的调用改为：

```ts
    const info = await transporter.sendMail({ from: cfg.from, to: msg.to ?? cfg.to, subject: msg.subject, text: msg.text });
```

`sendPayload` 的邮件分支改为：

```ts
      return {
        result: 'sent',
        response: (await transport.sendMail(config as EmailConfig, { subject: payload.subject, text: payload.text, to: payload.to })).slice(0, RESPONSE_MAX_CHARS),
      };
```

`packages/core/test/notify-transport.ts` 的 `sendMail` 改为：

```ts
    async sendMail(cfg: EmailConfig, msg) {
      mails.push({ to: msg.to ?? cfg.to, subject: msg.subject, text: msg.text });
      return 'SMTP 已接受 1 个收件人';
    },
```

`notifications/deliveries.ts` 的 `processDueDeliveries` 里「可用产品」的判断改为（注释同步）：

```ts
      // 通道的可用产品可能在记录生成后收窄：不再允许的记录直接放弃（测试消息不属于产品；个人提醒在生成时已检查）
      const sendable: DeliveryRow[] = [];
      for (const d of list) {
        const allowed =
          d.kind === 'test' ||
          d.kind === 'personal' ||
          channel.allowedProductIds.length === 0 ||
          channel.allowedProductIds.includes((await deliveryProductIdTx(tx, d)) ?? '');
```

- [ ] **Step 4: 实现 `member-notifications/channels.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, organizations, products } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { usableChannelsTx } from '../notifications/channels';

export type PersonalChannelSetting = { channelId: string | null };

export async function getPersonalChannel(db: Db, actor: Actor, productId: string): Promise<PersonalChannelSetting> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [p] = await tx.select({ channelId: products.personalChannelId }).from(products).where(eq(products.id, productId));
    return { channelId: p?.channelId ?? null };
  });
}

/** 产品的个人提醒通道：只能是对本产品可用、已启用的企业微信机器人通道；为空表示不发企业微信个人提醒。 */
export async function setPersonalChannel(db: Db, actor: Actor, productId: string, channelId: string | null): Promise<PersonalChannelSetting> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [cur] = await tx
      .select({ channelId: products.personalChannelId })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.deletedAt)));
    if (!cur) throw new AppError('not_found', '产品不存在');
    if (channelId) {
      const [ch] = (await usableChannelsTx(tx, [channelId], productId)).filter((c) => c.kind === 'wecom_robot');
      if (!ch) throw new AppError('invalid', '个人提醒通道只能选择对本产品可用、已启用的企业微信机器人通道');
    }
    if (cur.channelId !== channelId) {
      await tx.update(products).set({ personalChannelId: channelId }).where(eq(products.id, productId));
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId,
        type: 'product.personal_channel_set',
        subjectType: 'product',
        subjectId: productId,
        actor,
        payload: { changes: [{ field: 'personalChannelId', old: cur.channelId, new: channelId }] },
      });
    }
    return { channelId };
  });
}

export async function getPersonalEmailChannel(db: Db, actor: Actor): Promise<PersonalChannelSetting> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [o] = await tx.select({ channelId: organizations.personalEmailChannelId }).from(organizations).where(eq(organizations.id, actor.orgId));
    return { channelId: o?.channelId ?? null };
  });
}

/** 组织的个人通知邮件通道：只能是启用的邮件通道；收件地址为成员邮箱。 */
export async function setPersonalEmailChannel(db: Db, actor: Actor, channelId: string | null): Promise<PersonalChannelSetting> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select({ channelId: organizations.personalEmailChannelId }).from(organizations).where(eq(organizations.id, actor.orgId));
    if (channelId) {
      const [ch] = await tx
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.kind, 'email'), eq(notificationChannels.enabled, true)));
      if (!ch) throw new AppError('invalid', '个人通知邮件通道只能选择已启用的邮件通道');
    }
    const old = cur?.channelId ?? null;
    if (old !== channelId) {
      await tx.update(organizations).set({ personalEmailChannelId: channelId }).where(eq(organizations.id, actor.orgId));
      await recordEvent(tx, {
        orgId: actor.orgId,
        type: 'organization.personal_email_channel_set',
        subjectType: 'organization',
        subjectId: actor.orgId,
        actor,
        payload: { changes: [{ field: 'personalEmailChannelId', old, new: channelId }] },
      });
    }
    return { channelId };
  });
}
```

- [ ] **Step 5: 实现 `member-notifications/dispatch.ts`**

```ts
import { and, eq } from 'drizzle-orm';
import { notificationChannels, notificationDeliveries, organizations, products } from '../db/schema';
import type { Tx } from '../db/tx';
import { usableChannelsTx } from '../notifications/channels';
import { truncateBytes, WECOM_MARKDOWN_MAX_BYTES } from '../notifications/template';

/** 一条要发到企业微信或邮件的个人提醒（站内通知之外）。url 为站内相对路径。 */
export type OutboundItem = {
  productId: string | null;
  memberId: string;
  email: string | null;
  wecomUserid: string | null;
  viaWecom: boolean;
  viaEmail: boolean;
  actorName: string | null;
  body: string;
  title: string;
  url: string;
};

const absolute = (publicUrl: string, url: string): string => `${publicUrl.replace(/\/+$/, '')}${url}`;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** 企业微信个人提醒的一行：`<@userid> 操作人 动作：[编号 标题](链接)`。标题里的方括号换成空格，免得破坏链接写法。 */
export function wecomLine(i: OutboundItem, publicUrl: string): string {
  return `<@${i.wecomUserid}> ${i.actorName ?? '系统'} ${i.body}：[${i.title.replace(/[[\]]/g, ' ')}](${absolute(publicUrl, i.url)})`;
}

/** 按行合并成若干条，每条不超过 maxBytes；单行超长时截断。 */
export function chunkLines(lines: string[], maxBytes = WECOM_MARKDOWN_MAX_BYTES): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of lines) {
    const line = bytes(raw) > maxBytes ? truncateBytes(raw, maxBytes) : raw;
    const next = cur ? `${cur}\n${line}` : line;
    if (bytes(next) <= maxBytes) {
      cur = next;
      continue;
    }
    out.push(cur);
    cur = line;
  }
  if (cur) out.push(cur);
  return out;
}

/** 一个人这一轮的邮件：主题带条数，每条两行（动作与链接）。 */
export function emailFor(items: OutboundItem[], publicUrl: string): { subject: string; text: string } {
  const entries = items.map((i) => `${i.actorName ?? '系统'} ${i.body}：${i.title}\n${absolute(publicUrl, i.url)}`);
  return { subject: `Flower：你有 ${items.length} 条新通知`, text: `${entries.join('\n\n')}\n\n在 Flower 的个人设置里可以修改通知偏好。` };
}

/**
 * 把一轮的个人提醒写进 P3-A 的发送队列（kind = personal，请求体已渲染）：
 * 企业微信按产品合并，发到该产品的个人提醒通道（未指定、停用或不再允许本产品使用时不发）；
 * 邮件按人合并，发到组织的个人通知邮件通道（未指定或停用时不发），收件地址为成员邮箱。
 */
export async function dispatchPersonalTx(tx: Tx, orgId: string, items: OutboundItem[], publicUrl: string, now: Date): Promise<{ wecom: number; email: number }> {
  let wecom = 0;
  let email = 0;
  const byProduct = new Map<string, OutboundItem[]>();
  for (const i of items) if (i.viaWecom && i.wecomUserid && i.productId) byProduct.set(i.productId, [...(byProduct.get(i.productId) ?? []), i]);
  for (const [productId, list] of byProduct) {
    const [p] = await tx.select({ channelId: products.personalChannelId }).from(products).where(eq(products.id, productId));
    if (!p?.channelId) continue;
    const [ch] = (await usableChannelsTx(tx, [p.channelId], productId)).filter((c) => c.kind === 'wecom_robot');
    if (!ch) continue;
    for (const content of chunkLines(list.map((i) => wecomLine(i, publicUrl)))) {
      await tx.insert(notificationDeliveries).values({
        orgId,
        kind: 'personal',
        channelId: ch.id,
        payload: { type: 'json', body: { msgtype: 'markdown', markdown: { content } } },
        status: 'pending',
        nextAttemptAt: now,
      });
      wecom += 1;
    }
  }
  const byMember = new Map<string, OutboundItem[]>();
  for (const i of items) if (i.viaEmail && i.email) byMember.set(i.memberId, [...(byMember.get(i.memberId) ?? []), i]);
  if (byMember.size > 0) {
    const [org] = await tx.select({ channelId: organizations.personalEmailChannelId }).from(organizations).where(eq(organizations.id, orgId));
    const [ch] = org?.channelId
      ? await tx
          .select({ id: notificationChannels.id })
          .from(notificationChannels)
          .where(and(eq(notificationChannels.id, org.channelId), eq(notificationChannels.kind, 'email'), eq(notificationChannels.enabled, true)))
      : [];
    if (ch) {
      for (const list of byMember.values()) {
        const msg = emailFor(list, publicUrl);
        await tx.insert(notificationDeliveries).values({
          orgId,
          kind: 'personal',
          channelId: ch.id,
          payload: { type: 'email', subject: msg.subject, text: msg.text, to: [list[0]!.email!] },
          status: 'pending',
          nextAttemptAt: now,
        });
        email += 1;
      }
    }
  }
  return { wecom, email };
}
```

- [ ] **Step 6: `generate.ts` 收集个人提醒并在一轮结束时分发**

整个文件替换为：

```ts
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { domainEvents, memberNotifications, members, notificationCursors, organizations } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { type EventRow, pickRecipients, planEventTx } from './content';
import { dispatchPersonalTx, type OutboundItem } from './dispatch';
import { prefsForTx } from './prefs';
import { eligibleMembersTx } from './recipients';
import { autoSubscribeTx } from './subscriptions';

export type GenerateSummary = { events: number; notifications: number; skipped: number };
/** 每轮每个组织最多处理的事件数。 */
export const EVENT_BATCH = 500;
/** 同一条事件连续失败这么多次后跳过。 */
export const MAX_EVENT_FAILURES = 3;

const E = domainEvents;
const C = notificationCursors;
const N = memberNotifications;

/** 只取底层原因（drizzle 的查询错误把 SQL 与参数放在外层 message 里）。 */
function causeMessage(e: unknown): string {
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 游标之后、且早于本库其他会话里最早的事务开始时间的事件。领域事件的 occurred_at 是写入事务的开始时间：
 * 未提交事务里的事件提交前看不到，若不加这个上限，游标会越过它。比较全部在 SQL 里做（occurred_at 为微秒精度）。
 */
const pendingEvents = (orgId: string) =>
  and(
    eq(E.orgId, orgId),
    sql`not exists (select 1 from ${C} c where c.org_id = ${E.orgId} and c.last_event_id is not null and (${E.occurredAt}, ${E.id}) <= (c.last_occurred_at, c.last_event_id))`,
    sql`${E.occurredAt} < (select least(now(), coalesce(min(a.xact_start), now())) from pg_stat_activity a where a.datname = current_database() and a.pid <> pg_backend_pid() and a.xact_start is not null)`,
  );

/**
 * 处理一条事件：算收件人、按偏好写站内通知（同一人同一事件同一类只一条）、补自动关注；
 * 偏好开了企业微信或邮件的，收集成个人提醒，由调用方在本轮结束时合并分发。
 */
async function processEventTx(tx: Tx, ev: EventRow, slug: string): Promise<{ created: number; outbound: OutboundItem[] }> {
  const plan = await planEventTx(tx, ev, slug);
  if (!plan) return { created: 0, outbound: [] };
  const chosen = pickRecipients(plan.candidates, ev.actorMemberId);
  const eligible = await eligibleMembersTx(tx, plan.subject.productId, [...chosen.keys(), ...plan.autoSubscribe]);
  const recipients = [...chosen.values()].filter((c) => eligible.has(c.memberId));
  const prefs = await prefsForTx(tx, recipients.map((c) => c.memberId));
  const [actor] = ev.actorMemberId ? await tx.select({ name: members.displayName }).from(members).where(eq(members.id, ev.actorMemberId)) : [];
  let created = 0;
  const outbound: OutboundItem[] = [];
  for (const c of recipients) {
    const pref = prefs.get(c.memberId)![c.kind];
    if (pref.inApp) {
      const rows = await tx
        .insert(N)
        .values({
          orgId: ev.orgId,
          memberId: c.memberId,
          eventId: ev.id,
          kind: c.kind,
          subjectType: plan.subject.type,
          subjectId: plan.subject.id,
          title: plan.subject.title,
          body: c.body,
          url: plan.subject.url,
          actorMemberId: ev.actorMemberId,
        })
        .onConflictDoNothing()
        .returning({ id: N.id });
      created += rows.length;
    }
    if (pref.wecom || pref.email) {
      const m = eligible.get(c.memberId)!;
      outbound.push({
        productId: plan.subject.productId,
        memberId: m.id,
        email: m.email,
        wecomUserid: m.wecomUserid,
        viaWecom: pref.wecom,
        viaEmail: pref.email,
        actorName: actor?.name ?? null,
        body: c.body,
        title: plan.subject.title,
        url: plan.subject.url,
      });
    }
  }
  const type = plan.subject.type;
  if (type === 'requirement' || type === 'document') {
    await autoSubscribeTx(tx, ev.orgId, { type, id: plan.subject.id }, plan.autoSubscribe.filter((id) => eligible.has(id)));
  }
  return { created, outbound };
}

/**
 * 处理一个组织游标之后的新事件（最多 EVENT_BATCH 条）。先建游标行再 SKIP LOCKED 锁住：拿不到说明另一个实例在处理，本轮跳过。
 * 每条事件在 savepoint 里处理，成功后前移游标；失败时记下事件与次数并结束本轮，同一条连续失败 MAX_EVENT_FAILURES 次后跳过。
 * legacy.* 事件不处理，只前移游标。本轮的企业微信与邮件提醒在最后合并写入发送队列。后台写入，不记领域事件。
 */
export async function generateMemberNotifications(db: Db, orgId: string, deps: { publicUrl: string }, now: Date): Promise<GenerateSummary> {
  return withOrg(db, orgId, async (tx) => {
    const summary: GenerateSummary = { events: 0, notifications: 0, skipped: 0 };
    await tx.insert(C).values({ orgId }).onConflictDoNothing();
    const [cursor] = await tx.select().from(C).where(eq(C.orgId, orgId)).for('update', { skipLocked: true });
    if (!cursor) return summary;
    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId));
    const events = await tx.select().from(E).where(pendingEvents(orgId)).orderBy(asc(E.occurredAt), asc(E.id)).limit(EVENT_BATCH);
    const outbound: OutboundItem[] = [];
    let last: string | null = null;
    let failing: { eventId: string; failures: number } | null = null;
    for (const ev of events) {
      if (!ev.type.startsWith('legacy.')) {
        try {
          const r = await tx.transaction((sp) => processEventTx(sp, ev, org!.slug));
          summary.notifications += r.created;
          outbound.push(...r.outbound);
        } catch (e) {
          const failures = cursor.failingEventId === ev.id ? cursor.failures + 1 : 1;
          if (failures < MAX_EVENT_FAILURES) {
            console.warn(`[notify] 站内通知生成失败（第 ${failures} 次），下一轮重试：org=${orgId} event=${ev.id} type=${ev.type}：${causeMessage(e)}`);
            failing = { eventId: ev.id, failures };
            break;
          }
          console.warn(`[notify] 站内通知生成连续失败 ${MAX_EVENT_FAILURES} 次，跳过该事件：org=${orgId} event=${ev.id} type=${ev.type}：${causeMessage(e)}`);
          summary.skipped += 1;
        }
      }
      last = ev.id;
      summary.events += 1;
    }
    if (outbound.length > 0) {
      try {
        await tx.transaction((sp) => dispatchPersonalTx(sp, orgId, outbound, deps.publicUrl, now));
      } catch (e) {
        console.warn(`[notify] 个人提醒写入发送队列失败，本轮的企业微信与邮件提醒未发送：org=${orgId}：${causeMessage(e)}`);
      }
    }
    if (last || failing || cursor.failingEventId) {
      await tx
        .update(C)
        .set({
          ...(last ? { lastOccurredAt: sql`(select ${E.occurredAt} from ${E} where ${E.id} = ${last})`, lastEventId: last } : {}),
          failingEventId: failing?.eventId ?? null,
          failures: failing?.failures ?? 0,
          updatedAt: now,
        })
        .where(eq(C.orgId, orgId));
    }
    return summary;
  });
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './member-notifications/channels';
export * from './member-notifications/dispatch';
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/member-notify-dispatch.test.ts test/member-notify-generate.test.ts test/notify-deliveries.test.ts test/notify-sender.test.ts test/notify-worker.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误（web 的 `deliveries-tab.tsx` 用 `DELIVERY_KIND_LABELS[d.kind]`，新增的 `personal` 已有中文名）。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/member-notifications packages/core/src/notifications/constants.ts packages/core/src/notifications/sender.ts packages/core/src/notifications/deliveries.ts packages/core/src/index.ts packages/core/test/notify-transport.ts packages/core/test/member-notify-dispatch.test.ts
git commit -m "feat(core): 个人提醒通道与邮件通道设置；企业微信按产品合并 @ 到本人、邮件按人合并，经发送队列发出

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 通知列表与已读、90 天清理、定时推送告警时的系统告警

**Files:**
- Create: `packages/core/src/member-notifications/inbox.ts`、`packages/core/src/member-notifications/alerts.ts`
- Modify: `packages/core/src/notifications/worker.ts`、`packages/core/src/notifications/deliveries.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/member-notify-inbox.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `memberNotifications`；Task 5 的 `prefsForTx`；Task 9 的 `dispatchPersonalTx`、`OutboundItem`；P3-A 的 `ScheduleRow`
- Produces:
  - `inbox.ts`：`type MemberNotificationView = { id; kind; subjectType; subjectId; title; body; url; actor: { id: string; displayName: string } | null; createdAt: Date; readAt: Date | null }`、`type NotificationFilter = 'all' | 'unread' | 'mentioned'`、`type NotificationListQuery = { filter?; kind?; before?: string; limit?: number }`、`listMyNotifications(db, actor, q): Promise<{ notifications: MemberNotificationView[]; nextCursor: string | null }>`、`countMyUnread(db, actor): Promise<number>`、`markNotificationRead(db, actor, id): Promise<void>`、`markAllNotificationsRead(db, actor): Promise<number>`、`markSubjectNotificationsRead(db, actor, subject: { type: NotificationSubjectType; id: string }): Promise<number>`、`retentionCutoff(now): Date`、`deleteExpiredNotifications(db, orgId, now): Promise<number>`
  - `alerts.ts`：`notifyScheduleAlertTx(tx, schedule: ScheduleRow, body: string, publicUrl: string, now: Date): Promise<number>`
  - `worker.ts`：每轮对处理到的组织删除过期的已读通知；有过期已读通知的组织列入待办；定时推送因生成失败进入告警时调用 `notifyScheduleAlertTx`
  - `deliveries.ts`：`settleRunTx`、`markDeadTx`、`finalizeTx` 多一个 `publicUrl` 参数；一次执行全部放弃使定时推送进入告警时调用 `notifyScheduleAlertTx`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/member-notify-inbox.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { memberNotifications, notificationDeliveries, notificationSchedules } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import {
  countMyUnread,
  listMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markSubjectNotificationsRead,
} from '../src/member-notifications/inbox';
import { createSchedule } from '../src/notifications/schedules';
import { runNotificationTick } from '../src/notifications/worker';
import { createRequirement } from '../src/requirements/requirements';
import { updateMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let productId: string;
let reqId: string;
const fake = fakeTransport();
const deps = { ...TEST_DEPS, transport: fake.transport };
const tick = (now?: Date) => runNotificationTick(t.db, deps, now);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  a = await asMember(t.db, owner, '张三');
  reqId = (await createRequirement(t.db, owner, productId, { title: '登录页改版' })).id;
  await tick();
  const base = { orgId: owner.orgId, memberId: a.memberId, subjectType: 'requirement' as const, subjectId: reqId, title: 'PAN-1 登录页改版', url: '/acme/requirements/PAN-1' };
  const rows = [
    { key: 'n1', kind: 'mentioned' as const, body: '在评论中 @ 了你', createdAt: minutesAgo(5), actorMemberId: owner.memberId },
    { key: 'n2', kind: 'assigned' as const, body: '把你设为需求负责人', createdAt: minutesAgo(4), actorMemberId: owner.memberId },
    { key: 'n3', kind: 'followed_change' as const, body: '把状态从「待处理」改为「进行中」', createdAt: minutesAgo(3), actorMemberId: owner.memberId, readAt: minutesAgo(1) },
    { key: 'n4', kind: 'mentioned' as const, body: '在需求描述中 @ 了你', createdAt: minutesAgo(2), actorMemberId: owner.memberId },
    { key: 'n5', kind: 'signoff_due' as const, body: '「设计签字」等你签字', createdAt: minutesAgo(1), actorMemberId: null },
  ];
  for (const { key, ...r } of rows) {
    const [row] = await t.adminDb.insert(memberNotifications).values({ ...base, ...r }).returning({ id: memberNotifications.id });
    ids[key] = row!.id;
  }
});
afterAll(() => t.cleanup());
beforeEach(() => fake.reset(() => ({ status: 200, text: '{"errcode":0,"errmsg":"ok"}' })));

describe('通知列表', () => {
  it('按时间倒序分页；操作人显示当前姓名；没有操作人时为空', async () => {
    await updateMember(t.db, owner, owner.memberId, { displayName: '林澄' });
    const p1 = await listMyNotifications(t.db, a, { limit: 2 });
    expect(p1.notifications.map((n) => n.id)).toEqual([ids.n5, ids.n4]);
    expect(p1.notifications[0]!.actor).toBeNull();
    expect(p1.notifications[1]!.actor).toEqual({ id: owner.memberId, displayName: '林澄' });
    const p2 = await listMyNotifications(t.db, a, { limit: 2, before: p1.nextCursor! });
    expect(p2.notifications.map((n) => n.id)).toEqual([ids.n3, ids.n2]);
    const p3 = await listMyNotifications(t.db, a, { limit: 2, before: p2.nextCursor! });
    expect(p3).toEqual({ notifications: [expect.objectContaining({ id: ids.n1 })], nextCursor: null });
    await expect(listMyNotifications(t.db, a, { before: 'x' })).rejects.toThrow('分页参数无效');
  });

  it('筛选：未读、@我、按类型；别人看不到', async () => {
    expect((await listMyNotifications(t.db, a, { filter: 'unread' })).notifications.map((n) => n.id)).toEqual([ids.n5, ids.n4, ids.n2, ids.n1]);
    expect((await listMyNotifications(t.db, a, { filter: 'mentioned' })).notifications.map((n) => n.id)).toEqual([ids.n4, ids.n1]);
    expect((await listMyNotifications(t.db, a, { kind: 'assigned' })).notifications.map((n) => n.id)).toEqual([ids.n2]);
    expect((await listMyNotifications(t.db, owner, {})).notifications).toEqual([]);
  });
});

describe('已读', () => {
  it('未读数；标一条；按对象标已读；全部标为已读', async () => {
    expect(await countMyUnread(t.db, a)).toBe(4);
    await markNotificationRead(t.db, a, ids.n5!);
    expect(await countMyUnread(t.db, a)).toBe(3);
    expect(await markSubjectNotificationsRead(t.db, a, { type: 'requirement', id: reqId })).toBe(3);
    expect(await countMyUnread(t.db, a)).toBe(0);
    await t.adminDb.update(memberNotifications).set({ readAt: null }).where(eq(memberNotifications.id, ids.n1!));
    expect(await markAllNotificationsRead(t.db, a)).toBe(1);
  });

  it('别人的通知报不存在；只读 Token 能看不能标', async () => {
    await expect(markNotificationRead(t.db, owner, ids.n1!)).rejects.toThrow('通知不存在');
    const token = readOnlyToken(a);
    expect((await listMyNotifications(t.db, token, {})).notifications).toHaveLength(5);
    await expect(markAllNotificationsRead(t.db, token)).rejects.toThrow('只读 Token 不能标记已读');
  });
});

describe('清理', () => {
  it('后台循环删除已读超过 90 天的通知；未读与较新的保留', async () => {
    const day = 86_400_000;
    const now = new Date();
    const base = { orgId: owner.orgId, memberId: a.memberId, kind: 'mentioned' as const, subjectType: 'requirement' as const, subjectId: reqId, title: 't', body: 'b', url: '/u' };
    const [oldRead] = await t.adminDb.insert(memberNotifications).values({ ...base, createdAt: new Date(now.getTime() - 120 * day), readAt: new Date(now.getTime() - 91 * day) }).returning();
    const [recentRead] = await t.adminDb.insert(memberNotifications).values({ ...base, createdAt: new Date(now.getTime() - 120 * day), readAt: new Date(now.getTime() - 89 * day) }).returning();
    const [oldUnread] = await t.adminDb.insert(memberNotifications).values({ ...base, createdAt: new Date(now.getTime() - 200 * day) }).returning();
    const summary = await tick(now);
    expect(summary.orgs).toBe(1);
    const left = (await t.adminDb.select({ id: memberNotifications.id }).from(memberNotifications)).map((r) => r.id);
    expect(left).not.toContain(oldRead!.id);
    expect(left).toEqual(expect.arrayContaining([recentRead!.id, oldUnread!.id]));
  });
});

describe('系统告警', () => {
  it('一次执行全部放弃使定时推送进入告警：给在职的组织管理员写一条，普通成员不收；已在告警时不重复', async () => {
    const admin = await asMember(t.db, owner, '管理员乙');
    await updateMember(t.db, owner, admin.memberId, { orgRole: 'admin' });
    const ch = await wecomChannel(t.db, owner, '日报群');
    const s = await createSchedule(t.db, owner, { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [ch.id], enabled: false, failThreshold: 1 });
    const failing = () =>
      t.adminDb.insert(notificationDeliveries).values({
        orgId: owner.orgId,
        kind: 'schedule',
        scheduleId: s.id,
        runId: newId(),
        channelId: ch.id,
        payload: { type: 'json', body: { msgtype: 'text', text: { content: '日报' } } },
        status: 'failed',
        attempts: 4,
        nextAttemptAt: new Date(Date.now() - 1000),
      });
    fake.reset(() => ({ status: 500, text: 'boom' }));
    await failing();
    await tick();
    expect((await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, s.id)))[0]!.alertState).toBe('alert');
    const alerts = await t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.kind, 'system_alert'));
    expect(alerts.map((n) => n.memberId).sort()).toEqual([owner.memberId, admin.memberId].sort());
    expect(alerts[0]).toMatchObject({
      eventId: null,
      subjectType: 'schedule',
      subjectId: s.id,
      title: '定时推送「日报」',
      body: '连续失败 1 次，已进入告警',
      url: '/acme/settings/notifications?tab=schedules',
      actorMemberId: null,
    });
    await failing();
    await tick();
    expect(await t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.kind, 'system_alert'))).toHaveLength(2);
  });

  it('定时规则无效被停用时也告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ch = await wecomChannel(t.db, owner, '周报群');
    const s = await createSchedule(t.db, owner, { productId, name: '周报', cron: '0 19 * * 5', source: 'overview_card', channelIds: [ch.id] });
    await t.adminDb.update(notificationSchedules).set({ cron: 'not a cron', nextRunAt: new Date(Date.now() - 1000) }).where(eq(notificationSchedules.id, s.id));
    await tick();
    const [n] = await t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.subjectId, s.id));
    expect(n).toMatchObject({ kind: 'system_alert', memberId: expect.any(String), body: '定时规则或时区无效，已停用并进入告警' });
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/member-notify-inbox.test.ts`
Expected: FAIL（`Cannot find module '../src/member-notifications/inbox'`）。

- [ ] **Step 3: 实现 `member-notifications/inbox.ts`**

```ts
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memberNotifications, members } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { type MemberNotificationKind, NOTIFICATION_RETENTION_DAYS, type NotificationSubjectType } from '../notifications/constants';

export type MemberNotificationView = {
  id: string;
  kind: MemberNotificationKind;
  subjectType: NotificationSubjectType;
  subjectId: string;
  title: string;
  body: string;
  url: string;
  actor: { id: string; displayName: string } | null;
  createdAt: Date;
  readAt: Date | null;
};
export type NotificationFilter = 'all' | 'unread' | 'mentioned';
export type NotificationListQuery = { filter?: NotificationFilter; kind?: MemberNotificationKind; before?: string; limit?: number };

const N = memberNotifications;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function assertCanMark(actor: Actor): void {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能标记已读');
}

/** 已读通知的保留期限：早于这个时间读过的通知会被删除。 */
export const retentionCutoff = (now: Date): Date => new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000);

/**
 * 本人的通知：按 (created_at, id) 倒序。游标为上一页最后一条的 `{created_at 微秒精度 UTC}|{id}`
 * （与发送记录相同：同一事务写入的通知 created_at 相同，JS Date 只有毫秒精度）。操作人显示当前姓名。
 */
export async function listMyNotifications(db: Db, actor: Actor, q: NotificationListQuery = {}): Promise<{ notifications: MemberNotificationView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  let cursor: { at: string; id: string } | null = null;
  if (q.before) {
    const m = CURSOR_RE.exec(q.before);
    if (!m) throw new AppError('invalid', '分页参数无效');
    cursor = { at: m[1]!, id: m[2]! };
  }
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .select({ n: N, actorName: members.displayName, cursorAt: sql<string>`to_char(${N.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
      .from(N)
      .leftJoin(members, eq(members.id, N.actorMemberId))
      .where(
        and(
          eq(N.memberId, actor.memberId),
          q.filter === 'unread' ? isNull(N.readAt) : undefined,
          q.filter === 'mentioned' ? eq(N.kind, 'mentioned') : undefined,
          q.kind ? eq(N.kind, q.kind) : undefined,
          cursor ? sql`(${N.createdAt}, ${N.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(N.createdAt), desc(N.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      notifications: page.map(({ n, actorName }) => ({
        id: n.id,
        kind: n.kind,
        subjectType: n.subjectType,
        subjectId: n.subjectId,
        title: n.title,
        body: n.body,
        url: n.url,
        actor: n.actorMemberId ? { id: n.actorMemberId, displayName: actorName ?? '已删除的成员' } : null,
        createdAt: n.createdAt,
        readAt: n.readAt,
      })),
      nextCursor: rows.length > limit && last ? `${last.cursorAt}|${last.n.id}` : null,
    };
  });
}

export async function countMyUnread(db: Db, actor: Actor): Promise<number> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(N)
      .where(and(eq(N.memberId, actor.memberId), isNull(N.readAt)));
    return r!.n;
  });
}

/** 标一条已读：只能标本人的通知（别人的报不存在）。标记已读不记领域事件（与评论已读一致）。 */
export async function markNotificationRead(db: Db, actor: Actor, id: string): Promise<void> {
  assertCanMark(actor);
  await withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({ readAt: N.readAt })
      .from(N)
      .where(and(eq(N.id, id), eq(N.memberId, actor.memberId)));
    if (!row) throw new AppError('not_found', '通知不存在');
    if (!row.readAt) await tx.update(N).set({ readAt: new Date() }).where(eq(N.id, id));
  });
}

export async function markAllNotificationsRead(db: Db, actor: Actor): Promise<number> {
  assertCanMark(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .update(N)
      .set({ readAt: new Date() })
      .where(and(eq(N.memberId, actor.memberId), isNull(N.readAt)))
      .returning({ id: N.id });
    return rows.length;
  });
}

/** 打开需求、PRD 或任务详情时，把本人与它相关的未读通知标为已读。 */
export async function markSubjectNotificationsRead(db: Db, actor: Actor, subject: { type: NotificationSubjectType; id: string }): Promise<number> {
  assertCanMark(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .update(N)
      .set({ readAt: new Date() })
      .where(and(eq(N.memberId, actor.memberId), eq(N.subjectType, subject.type), eq(N.subjectId, subject.id), isNull(N.readAt)))
      .returning({ id: N.id });
    return rows.length;
  });
}

/** 后台循环：删除已读超过保留期的通知（不记事件）。 */
export async function deleteExpiredNotifications(db: Db, orgId: string, now: Date): Promise<number> {
  return withOrg(db, orgId, async (tx) => (await tx.delete(N).where(lt(N.readAt, retentionCutoff(now))).returning({ id: N.id })).length);
}
```

- [ ] **Step 4: 实现 `member-notifications/alerts.ts`**

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { memberNotifications, members, organizations } from '../db/schema';
import type { Tx } from '../db/tx';
import type { ScheduleRow } from '../notifications/schedules';
import { dispatchPersonalTx, type OutboundItem } from './dispatch';
import { prefsForTx } from './prefs';

/**
 * 定时推送由正常变为告警时，在写告警的同一事务里给在职的组织管理员写系统告警（没有对应的领域事件），
 * 并按偏好写企业微信（定时推送所属产品的个人提醒通道）与邮件提醒。返回写入的站内通知数。
 */
export async function notifyScheduleAlertTx(tx: Tx, s: ScheduleRow, body: string, publicUrl: string, now: Date): Promise<number> {
  const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, s.orgId));
  if (!org) return 0;
  const admins = await tx
    .select({ id: members.id, email: members.email, wecomUserid: members.wecomUserid })
    .from(members)
    .where(and(inArray(members.orgRole, ['owner', 'admin']), eq(members.status, 'active'), eq(members.kind, 'human')));
  if (admins.length === 0) return 0;
  const prefs = await prefsForTx(tx, admins.map((x) => x.id));
  const title = `定时推送「${s.name}」`;
  const url = `/${org.slug}/settings/notifications?tab=schedules`;
  let created = 0;
  const outbound: OutboundItem[] = [];
  for (const m of admins) {
    const pref = prefs.get(m.id)!.system_alert;
    if (pref.inApp) {
      await tx.insert(memberNotifications).values({ orgId: s.orgId, memberId: m.id, eventId: null, kind: 'system_alert', subjectType: 'schedule', subjectId: s.id, title, body, url, actorMemberId: null, createdAt: now });
      created += 1;
    }
    if (pref.wecom || pref.email) {
      outbound.push({ productId: s.productId, memberId: m.id, email: m.email, wecomUserid: m.wecomUserid, viaWecom: pref.wecom, viaEmail: pref.email, actorName: null, body, title, url });
    }
  }
  if (outbound.length > 0) await dispatchPersonalTx(tx, s.orgId, outbound, publicUrl, now);
  return created;
}
```

- [ ] **Step 5: 发送结果进入告警时通知（`notifications/deliveries.ts`）**

导入加 `import { notifyScheduleAlertTx } from '../member-notifications/alerts';`。

`settleRunTx` 改为（签名多一个 `publicUrl`，放告警后通知组织管理员）：

```ts
async function settleRunTx(tx: Tx, d: DeliveryRow, now: Date, outcome: 'sent' | 'dead', publicUrl: string): Promise<void> {
  if (!d.runId || !d.scheduleId) return;
  const [s] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, d.scheduleId)).for('no key update');
  if (!s) return;
  if (outcome === 'sent') {
    const runAt = sql`${d.createdAt.toISOString()}::timestamptz`;
    await tx
      .update(notificationSchedules)
      .set({ consecutiveFailures: 0, alertState: 'normal', lastSuccessAt: sql`greatest(coalesce(${notificationSchedules.lastSuccessAt}, ${runAt}), ${runAt})`, updatedAt: now })
      .where(eq(notificationSchedules.id, s.id));
    await tx.update(notificationDigestItems).set({ consumedAt: now }).where(and(eq(notificationDigestItems.runId, d.runId), isNull(notificationDigestItems.consumedAt)));
    return;
  }
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.runId, d.runId), sql`${notificationDeliveries.status} <> 'dead'`));
  if (open!.n > 0) return;
  const failures = s.consecutiveFailures + 1;
  const alert = failures >= s.failThreshold;
  await tx
    .update(notificationSchedules)
    .set({ consecutiveFailures: failures, alertState: alert ? 'alert' : s.alertState, updatedAt: now })
    .where(eq(notificationSchedules.id, s.id));
  if (alert && s.alertState !== 'alert') await notifyScheduleAlertTx(tx, s, `连续失败 ${failures} 次，已进入告警`, publicUrl, now);
  await tx.update(notificationDigestItems).set({ runId: null }).where(and(eq(notificationDigestItems.runId, d.runId), isNull(notificationDigestItems.consumedAt)));
}
```

`markDeadTx` 与 `finalizeTx` 各多一个最后参数 `publicUrl`，传给 `settleRunTx`：

```ts
async function markDeadTx(tx: Tx, d: DeliveryRow, response: string, now: Date, publicUrl: string): Promise<void> {
  await tx.update(notificationDeliveries).set({ status: 'dead', nextAttemptAt: null, response }).where(eq(notificationDeliveries.id, d.id));
  await settleRunTx(tx, d, now, 'dead', publicUrl);
}
```

```ts
async function finalizeTx(tx: Tx, d: DeliveryRow, outcome: SendOutcome, now: Date, guard: SQL | undefined, publicUrl: string): Promise<FinalizeResult> {
  const response = outcome.response.slice(0, RESPONSE_MAX_CHARS);
  const apply = async (set: Partial<typeof notificationDeliveries.$inferInsert>) =>
    (await tx.update(notificationDeliveries).set({ ...set, response }).where(guard).returning({ id: notificationDeliveries.id })).length > 0;
  if (outcome.result === 'sent') {
    if (!(await apply({ status: 'sent', attempts: d.attempts + 1, sentAt: now, nextAttemptAt: null }))) return 'skipped';
    await settleRunTx(tx, d, now, 'sent', publicUrl);
    return 'sent';
  }
  if (outcome.result === 'rate_limited') {
    return (await apply({ status: 'pending', nextAttemptAt: new Date(now.getTime() + RATE_WINDOW_MS) })) ? 'rate_limited' : 'skipped';
  }
  const attempts = d.attempts + 1;
  const delay = d.kind === 'test' ? null : retryDelayMs(attempts);
  if (delay === null) {
    if (!(await apply({ status: 'dead', attempts, nextAttemptAt: null }))) return 'skipped';
    await settleRunTx(tx, d, now, 'dead', publicUrl);
    return 'dead';
  }
  return (await apply({ status: 'failed', attempts, nextAttemptAt: new Date(now.getTime() + delay) })) ? 'failed' : 'skipped';
}
```

`processDueDeliveries` 里的五处调用补上 `deps.publicUrl`：

```ts
      for (const d of expired) tally(await finalizeTx(tx, d, { result: 'failed', response: INTERRUPTED }, claimAt, eq(D.id, d.id), deps.publicUrl));
```

```ts
          await markDeadTx(tx, d, '通道已停用，未发送', claimAt, deps.publicUrl);
```

```ts
          await markDeadTx(tx, d, '通道不再允许本产品使用，未发送', claimAt, deps.publicUrl);
```

```ts
            await markDeadTx(tx, d, `渲染失败：${errorText(e)}`.slice(0, RESPONSE_MAX_CHARS), claimAt, deps.publicUrl);
```

```ts
    tally(await withOrg(db, orgId, (tx) => finalizeTx(tx, d, outcome, clockAfter(now), mine, deps.publicUrl)));
```

- [ ] **Step 6: 后台循环：清理、待办组织、生成失败进入告警（`notifications/worker.ts`）**

导入改为：

```ts
import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { domainEvents, memberNotifications, notificationCursors, notificationDeliveries, notificationSchedules, organizations } from '../db/schema';
import { withOrg, withSystem } from '../db/tx';
import { notifyScheduleAlertTx } from '../member-notifications/alerts';
import { generateMemberNotifications } from '../member-notifications/generate';
import { deleteExpiredNotifications, retentionCutoff } from '../member-notifications/inbox';
```

`dueOrgIds` 在 `c` 之后加一项并合并：

```ts
    // 有已读超过保留期的通知的组织
    const d = await tx.selectDistinct({ orgId: memberNotifications.orgId }).from(memberNotifications).where(lt(memberNotifications.readAt, retentionCutoff(now)));
    return [...new Set([...a, ...b, ...c, ...d].map((r) => r.orgId))];
```

（注释第一行改为「……或游标之后有新事件、或有过期的已读通知的组织。」）

`recordGenerationFailure` 改为（多一个 `publicUrl`，由正常进入告警时通知组织管理员）：

```ts
async function recordGenerationFailure(db: Db, orgId: string, id: string, error: unknown, now: Date, publicUrl: string): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    const [s] = await tx.select().from(S).where(eq(S.id, id)).for('update');
    if (!s) return;
    const failures = s.consecutiveFailures + 1;
    let next: Date;
    try {
      next = nextRunAt(s.cron, s.timezone, now);
    } catch (e) {
      // 存储的 cron 或时区无效，不会自行恢复：停用并告警，避免每轮重复出错
      const reason = causeMessage(e);
      await tx
        .update(S)
        .set({
          enabled: false,
          nextRunAt: null,
          lastRunAt: now,
          lastError: `定时规则或时区无效，已停用：${reason}`.slice(0, 500),
          consecutiveFailures: failures,
          alertState: 'alert',
          updatedAt: now,
        })
        .where(eq(S.id, id));
      if (s.alertState !== 'alert') await notifyScheduleAlertTx(tx, s, '定时规则或时区无效，已停用并进入告警', publicUrl, now);
      console.warn(`[notify] 定时推送的定时规则或时区无效，已停用：org=${orgId} schedule=${id}：${reason}`);
      return;
    }
    const alert = failures >= s.failThreshold;
    await tx
      .update(S)
      .set({
        lastRunAt: now,
        lastError: `生成内容失败：${causeMessage(error)}`.slice(0, 500),
        consecutiveFailures: failures,
        alertState: alert ? 'alert' : s.alertState,
        nextRunAt: next,
        updatedAt: now,
      })
      .where(eq(S.id, id));
    if (alert && s.alertState !== 'alert') await notifyScheduleAlertTx(tx, s, `连续失败 ${failures} 次，已进入告警`, publicUrl, now);
  });
}
```

`runDueSchedules` 的 `catch` 改为 `await recordGenerationFailure(db, orgId, id, e, now, deps.publicUrl);`。

`runNotificationTick` 的 `try` 块里，生成通知之后加：

```ts
      await deleteExpiredNotifications(db, orgId, orgNow);
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './member-notifications/inbox';
export * from './member-notifications/alerts';
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/member-notify-inbox.test.ts test/notify-deliveries.test.ts test/notify-worker.test.ts test/notify-run.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/member-notifications/inbox.ts packages/core/src/member-notifications/alerts.ts packages/core/src/notifications/deliveries.ts packages/core/src/notifications/worker.ts packages/core/src/index.ts packages/core/test/member-notify-inbox.test.ts
git commit -m "feat(core): 通知列表、未读数与已读标记，已读 90 天清理；定时推送进入告警时给组织管理员系统告警

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 接口：通知、关注、偏好、个人提醒通道、企业微信账号与应用、扫码回调

**Files:**
- Create: `apps/web/src/server/routes/member-notifications.ts`、`apps/web/src/server/routes/wecom.ts`、`apps/web/test/fake-wecom.ts`
- Modify: `apps/web/src/server/api.ts`、`apps/web/src/server/runtime.ts`、`apps/web/test/api/helpers.ts`
- Test: `apps/web/test/api/member-notifications.test.ts`、`apps/web/test/api/wecom.test.ts`

**Interfaces:**
- Consumes: Task 4–10 的服务函数
- Produces（全部在 `/api/v1` 下）：
  - `GET /orgs/:org/notifications?filter=&kind=&before=&limit=` → `{ notifications, nextCursor }`；`GET /orgs/:org/notifications/unread-count` → `{ count }`；`POST /orgs/:org/notifications/read-all` → `{ count }`；`POST /orgs/:org/notifications/read-subject`（`{ subjectType, subjectId }`）→ `{ count }`；`POST /orgs/:org/notifications/:id/read` → 204
  - `GET|PUT /orgs/:org/subscriptions/:type/:id`（PUT `{ following }`）→ `{ subscription }`
  - `GET /orgs/:org/me/notification-settings` → `{ settings }`；`PUT /orgs/:org/me/notification-prefs/:kind`（`{ inApp, wecom, email }`）→ `{ settings }`
  - `GET /orgs/:org/products/:id/mention-members` → `{ members }`
  - `GET|PUT /orgs/:org/products/:id/personal-channel`、`GET|PUT /orgs/:org/personal-email-channel`（PUT `{ channelId }`）→ `{ channelId }`
  - `PUT /orgs/:org/members/:id/wecom`（`{ userid }`）→ `{ member: { memberId, wecomUserid } }`；`POST /orgs/:org/wecom-import/preview`、`POST /orgs/:org/wecom-import`（`{ csv }`）→ `{ result }`
  - `GET|PUT /orgs/:org/wecom-app`（PUT `{ corpId, agentId, secret?, bindEnabled }`）→ `{ settings }`
  - `POST /orgs/:org/me/wecom/bind` → `{ url }`；`DELETE /orgs/:org/me/wecom` → 204；`GET /orgs/:org/wecom/callback?code&state` → 302 到 `/settings?org={org}&wecom=bound` 或 `&wecom_error={原因}`
  - `ApiDeps.wecomApiBase: string`（生产为 `WECOM_API_BASE`）；`makeApp({ wecomApiBase? })`；`startFakeWecom({ secret, users })` → `{ base, calls, close }`

- [ ] **Step 1: 写本机假企业微信服务**

新建 `apps/web/test/fake-wecom.ts`：

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本机假企业微信接口：只监听 127.0.0.1。gettoken 只认 opts.secret；getuserinfo 按 users 把授权码换成 userid，
 * 其他授权码报 40029。calls 记下访问过的路径（不记查询参数，里面有密钥）。
 */
export async function startFakeWecom(opts: { secret: string; users: Record<string, string> }): Promise<{ base: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    calls.push(u.pathname);
    let body: Record<string, unknown>;
    if (u.pathname === '/cgi-bin/gettoken') {
      body = u.searchParams.get('corpsecret') === opts.secret ? { errcode: 0, errmsg: 'ok', access_token: 'fake-token', expires_in: 7200 } : { errcode: 40001, errmsg: 'invalid credential' };
    } else if (u.pathname === '/cgi-bin/auth/getuserinfo') {
      const userid = u.searchParams.get('access_token') === 'fake-token' ? opts.users[u.searchParams.get('code') ?? ''] : undefined;
      body = userid ? { errcode: 0, errmsg: 'ok', userid } : { errcode: 40029, errmsg: 'invalid code' };
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
```

`apps/web/test/api/helpers.ts` 的 `makeApp` 改为：

```ts
/** 接口测试用的应用。推送默认用真实发送器，测试里的通道地址一律指向本机假接收端（test/fake-webhook.ts）；企业微信接口默认指向本机不可达端口。 */
export async function makeApp(opts: { transport?: Transport; tickApi?: boolean; wecomApiBase?: string } = {}): Promise<{ app: App; cleanup: () => Promise<void> }> {
  const t = await createTestDb();
  const storage = createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-api-storage-')));
  const app = createApi({
    db: t.db,
    secureCookies: false,
    publicUrl: 'http://localhost:3000',
    storage,
    notify: { secretKey: 'api-test-secret-api-test-secret-0001', publicUrl: 'http://localhost:3000', transport: opts.transport ?? defaultTransport },
    tickApi: opts.tickApi ?? false,
    wecomApiBase: opts.wecomApiBase ?? 'http://127.0.0.1:9',
  });
  return { app, cleanup: t.cleanup };
}
```

- [ ] **Step 2: 写失败的接口测试**

新建 `apps/web/test/api/member-notifications.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { startFakeWebhook } from '../fake-webhook';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
let session: string;
let zhang: { session: string; id: string };
let guest: { session: string; id: string };
let readToken: string;
let productId: string;
let reqId: string;

const tick = () => call(app, 'POST', '/instance/notifications/tick', { session, body: {} });
const mention = (id: string, name: string) => `[@${name}](member:${id})`;

beforeAll(async () => {
  hook = await startFakeWebhook();
  ({ app, cleanup } = await makeApp({ tickApi: true }));
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const join = async (email: string, name: string, orgRole: 'member' | 'guest') => {
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email, orgRole } });
    const s = sessionFrom((await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name, password: 'password123' } })).res);
    return { session: s, id: (await call(app, 'GET', '/orgs/acme', { session: s })).body.me.memberId as string };
  };
  zhang = await join('zhang@example.com', '张三', 'member');
  guest = await join('guest@example.com', '访客', 'guest');
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
  reqId = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '登录页改版' } })).body.requirement.id;
  await tick();
});
afterAll(async () => {
  await hook.close();
  await cleanup();
});

describe('站内通知接口', () => {
  it('被 @ 的成员能列出、计数与标已读；看不到产品的访客收不到；只读 Token 能看不能标', async () => {
    await call(app, 'POST', `/orgs/acme/requirements/${reqId}/comments`, { session, body: { body: `${mention(zhang.id, '张三')} ${mention(guest.id, '访客')} 请看` } });
    expect((await tick()).body.summary.notified).toBe(1);
    const list = await call(app, 'GET', '/orgs/acme/notifications', { session: zhang.session });
    expect(list.body.notifications).toEqual([
      expect.objectContaining({ kind: 'mentioned', body: '在评论中 @ 了你', title: 'PAN-1 登录页改版', url: '/acme/requirements/PAN-1', actor: expect.objectContaining({ displayName: 'Owner' }), readAt: null }),
    ]);
    expect((await call(app, 'GET', '/orgs/acme/notifications/unread-count', { session: zhang.session })).body).toEqual({ count: 1 });
    expect((await call(app, 'GET', '/orgs/acme/notifications', { session: guest.session })).body.notifications).toEqual([]);
    expect((await call(app, 'GET', '/orgs/acme/notifications?filter=bad', { session: zhang.session })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/notifications', { token: readToken })).status).toBe(200);
    expect((await call(app, 'POST', '/orgs/acme/notifications/read-all', { token: readToken })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/notifications/not-a-uuid/read', { session: zhang.session })).status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/notifications/${list.body.notifications[0].id}/read`, { session })).status).toBe(404);
    expect((await call(app, 'POST', `/orgs/acme/notifications/${list.body.notifications[0].id}/read`, { session: zhang.session })).status).toBe(204);
    expect((await call(app, 'GET', '/orgs/acme/notifications/unread-count', { session: zhang.session })).body).toEqual({ count: 0 });
    expect((await call(app, 'POST', '/orgs/acme/notifications/read-subject', { session: zhang.session, body: { subjectType: 'requirement', subjectId: reqId } })).body).toEqual({ count: 0 });
  });

  it('关注：查询与切换；只读 Token 不能改；访客看不到产品；只能关注需求或 PRD', async () => {
    const path = `/orgs/acme/subscriptions/requirement/${reqId}`;
    expect((await call(app, 'GET', path, { session: zhang.session })).body.subscription).toEqual({ following: true, source: 'auto', reason: '你曾负责、被分配、评论或被 @' });
    expect((await call(app, 'PUT', path, { session: zhang.session, body: { following: false } })).body.subscription.following).toBe(false);
    expect((await call(app, 'PUT', path, { token: readToken, body: { following: true } })).status).toBe(403);
    expect((await call(app, 'GET', path, { session: guest.session })).status).toBe(404);
    expect((await call(app, 'GET', `/orgs/acme/subscriptions/task/${reqId}`, { session: zhang.session })).status).toBe(400);
  });

  it('通知偏好：读取与修改；普通成员不能设置系统告警；只读 Token 不能改', async () => {
    const s = await call(app, 'GET', '/orgs/acme/me/notification-settings', { session: zhang.session });
    expect(s.body.settings.prefs.map((p: { kind: string }) => p.kind)).toEqual(['mentioned', 'assigned', 'followed_change', 'signoff_due']);
    const put = await call(app, 'PUT', '/orgs/acme/me/notification-prefs/assigned', { session: zhang.session, body: { inApp: false, wecom: true, email: false } });
    expect(put.body.settings.prefs[1]).toEqual({ kind: 'assigned', inApp: false, wecom: true, email: false });
    expect((await call(app, 'PUT', '/orgs/acme/me/notification-prefs/system_alert', { session: zhang.session, body: { inApp: false, wecom: false, email: false } })).status).toBe(400);
    expect((await call(app, 'PUT', '/orgs/acme/me/notification-prefs/bad', { session: zhang.session, body: { inApp: false, wecom: false, email: false } })).status).toBe(400);
    expect((await call(app, 'PUT', '/orgs/acme/me/notification-prefs/mentioned', { token: readToken, body: { inApp: false, wecom: false, email: false } })).status).toBe(403);
  });

  it('@ 候选成员：能看到产品的人可以调用；访客没有该产品时 404', async () => {
    const r = await call(app, 'GET', `/orgs/acme/products/${productId}/mention-members`, { session: zhang.session });
    expect(r.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: zhang.id, displayName: '张三', canSeeProduct: true, wecomBound: false }),
        expect.objectContaining({ id: guest.id, canSeeProduct: false }),
      ]),
    );
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/mention-members`, { session: guest.session })).status).toBe(404);
  });

  it('个人提醒：产品指定个人提醒通道、成员有企业微信账号时，被指派的成员在群里被 @；权限与校验', async () => {
    const channelId = (await call(app, 'POST', '/orgs/acme/notification-channels', { session, body: { kind: 'wecom_robot', name: '研发群', config: { url: hook.url('personal-0001') } } })).body.channel.id;
    const path = `/orgs/acme/products/${productId}/personal-channel`;
    expect((await call(app, 'PUT', path, { session: zhang.session, body: { channelId } })).status).toBe(403);
    expect((await call(app, 'PUT', path, { session, body: { channelId } })).body).toEqual({ channelId });
    expect((await call(app, 'GET', path, { session })).body).toEqual({ channelId });
    expect((await call(app, 'PUT', `/orgs/acme/members/${zhang.id}/wecom`, { session, body: { userid: 'zhangsan' } })).status).toBe(200);
    const before = hook.received.length;
    await call(app, 'PATCH', `/orgs/acme/requirements/${reqId}`, { session, body: { ownerMemberId: zhang.id } });
    expect((await tick()).body.summary.sent).toBe(1);
    expect(hook.received.length).toBe(before + 1);
    expect(hook.received.at(-1)!.body).toEqual({
      msgtype: 'markdown',
      markdown: { content: '<@zhangsan> Owner 把你设为需求负责人：[PAN-1 登录页改版](http://localhost:3000/acme/requirements/PAN-1)' },
    });
    expect((await call(app, 'GET', '/orgs/acme/personal-email-channel', { session: zhang.session })).status).toBe(403);
    expect((await call(app, 'PUT', '/orgs/acme/personal-email-channel', { session, body: { channelId } })).status).toBe(400);
    expect((await call(app, 'PUT', '/orgs/acme/personal-email-channel', { session, body: { channelId: null } })).body).toEqual({ channelId: null });
  });
});
```

新建 `apps/web/test/api/wecom.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { startFakeWecom } from '../fake-wecom';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

const SECRET = 'app-secret-demo-0001';
let app: App;
let cleanup: () => Promise<void>;
let wecom: Awaited<ReturnType<typeof startFakeWecom>>;
let session: string;
let zhang: { session: string; id: string };
let liId: string;

beforeAll(async () => {
  wecom = await startFakeWecom({ secret: SECRET, users: { 'code-zhang': 'zhangsan' } });
  ({ app, cleanup } = await makeApp({ wecomApiBase: wecom.base }));
  session = await initAndLogin(app);
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'zhang@example.com', orgRole: 'member' } });
  const s = sessionFrom((await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '张三', password: 'password123' } })).res);
  zhang = { session: s, id: (await call(app, 'GET', '/orgs/acme', { session: s })).body.me.memberId };
  liId = (await call(app, 'POST', '/orgs/acme/members', { session, body: { displayName: '李四', email: 'li@example.com' } })).body.member.id;
});
afterAll(async () => {
  await wecom.close();
  await cleanup();
});

describe('成员企业微信账号', () => {
  it('组织管理员填写；重复 409 带姓名；格式不对 400；普通成员 403', async () => {
    expect((await call(app, 'PUT', `/orgs/acme/members/${liId}/wecom`, { session, body: { userid: 'lisi' } })).body.member).toEqual({ memberId: liId, wecomUserid: 'lisi' });
    const members = (await call(app, 'GET', '/orgs/acme/members', { session })).body.members;
    expect(members.find((m: { id: string }) => m.id === liId).wecomUserid).toBe('lisi');
    const dup = await call(app, 'PUT', `/orgs/acme/members/${zhang.id}/wecom`, { session, body: { userid: 'lisi' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('该企业微信账号已绑定到 李四');
    expect((await call(app, 'PUT', `/orgs/acme/members/${zhang.id}/wecom`, { session, body: { userid: 'a b' } })).status).toBe(400);
    expect((await call(app, 'PUT', `/orgs/acme/members/${liId}/wecom`, { session: zhang.session, body: { userid: null } })).status).toBe(403);
  });

  it('CSV 预览不写入、确认导入只写可匹配的行；普通成员 403；过大 400', async () => {
    const csv = '邮箱,企业微信账号\nzhang@example.com,zhangsan\nnobody@example.com,x';
    const preview = await call(app, 'POST', '/orgs/acme/wecom-import/preview', { session, body: { csv } });
    expect(preview.body.result.counts).toEqual({ ok: 1, unchanged: 0, not_found: 1, duplicate: 0, invalid: 0 });
    expect(preview.body.result.applied).toBe(0);
    expect((await call(app, 'POST', '/orgs/acme/wecom-import', { session, body: { csv } })).body.result.applied).toBe(1);
    expect((await call(app, 'POST', '/orgs/acme/wecom-import/preview', { session: zhang.session, body: { csv } })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/wecom-import/preview', { session, body: { csv: 'x'.repeat(200_001) } })).status).toBe(400);
    await call(app, 'PUT', `/orgs/acme/members/${zhang.id}/wecom`, { session, body: { userid: null } });
  });
});

describe('企业微信应用与扫码绑定', () => {
  it('应用配置只返回脱敏提示与回调地址；任何响应里都没有密钥；普通成员 403', async () => {
    const empty = await call(app, 'GET', '/orgs/acme/wecom-app', { session });
    expect(empty.body.settings).toEqual({ app: null, callbackUrl: 'http://localhost:3000/api/v1/orgs/acme/wecom/callback', callbackDomain: 'localhost:3000' });
    expect((await call(app, 'PUT', '/orgs/acme/wecom-app', { session, body: { corpId: 'ww0001', agentId: '1000002', bindEnabled: true } })).status).toBe(400);
    const saved = await call(app, 'PUT', '/orgs/acme/wecom-app', { session, body: { corpId: 'ww0001', agentId: '1000002', secret: SECRET, bindEnabled: true } });
    expect(saved.body.settings.app).toMatchObject({ corpId: 'ww0001', agentId: '1000002', secretHint: '****0001', bindEnabled: true });
    const again = await call(app, 'GET', '/orgs/acme/wecom-app', { session });
    for (const r of [saved, again]) expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect((await call(app, 'GET', '/orgs/acme/wecom-app', { session: zhang.session })).status).toBe(403);
  });

  it('扫码绑定：发起返回扫码页地址；回调成功跳回个人设置；重放显示原因；只访问假企业微信；可以自行解除', async () => {
    const start = await call(app, 'POST', '/orgs/acme/me/wecom/bind', { session: zhang.session });
    const state = new URL(start.body.url).searchParams.get('state')!;
    expect(new URL(start.body.url).host).toBe('login.work.weixin.qq.com');
    const cb = await call(app, 'GET', `/orgs/acme/wecom/callback?code=code-zhang&state=${encodeURIComponent(state)}`, { session: zhang.session });
    expect(cb.status).toBe(302);
    expect(cb.res.headers.get('location')).toBe('/settings?org=acme&wecom=bound');
    expect(wecom.calls).toEqual(['/cgi-bin/gettoken', '/cgi-bin/auth/getuserinfo']);
    const settings = await call(app, 'GET', '/orgs/acme/me/notification-settings', { session: zhang.session });
    expect(settings.body.settings.wecom).toMatchObject({ userid: 'zhangsan', bindEnabled: true });
    const replay = await call(app, 'GET', `/orgs/acme/wecom/callback?code=code-zhang&state=${encodeURIComponent(state)}`, { session: zhang.session });
    const loc = new URL(replay.res.headers.get('location')!, 'http://localhost');
    expect(loc.pathname).toBe('/settings');
    expect(loc.searchParams.get('wecom_error')).toBe('绑定链接无效或已使用，请重新扫码');
    expect(replay.res.headers.get('location')).not.toContain(SECRET);
    expect((await call(app, 'DELETE', '/orgs/acme/me/wecom', { session: zhang.session })).status).toBe(204);
    expect((await call(app, 'GET', '/orgs/acme/me/notification-settings', { session: zhang.session })).body.settings.wecom.userid).toBeNull();
  });

  it('API Token 不能发起绑定', async () => {
    const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
    const token = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me, name: '写', scope: { products: 'all', access: 'write' } } })).body.token;
    expect((await call(app, 'POST', '/orgs/acme/me/wecom/bind', { token })).status).toBe(403);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run test/api/member-notifications.test.ts test/api/wecom.test.ts`
Expected: FAIL（接口 404：`接口不存在`；`makeApp` 的 `wecomApiBase` 未被 `createApi` 使用）。

- [ ] **Step 4: 实现 `routes/member-notifications.ts`**

```ts
import {
  AppError,
  countMyUnread,
  getNotificationSettings,
  getPersonalChannel,
  getPersonalEmailChannel,
  getSubscription,
  listMentionMembers,
  listMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markSubjectNotificationsRead,
  MEMBER_NOTIFICATION_KINDS,
  NOTIFICATION_SUBJECT_TYPES,
  setNotificationPref,
  setPersonalChannel,
  setPersonalEmailChannel,
  setSubscription,
  SUBSCRIPTION_SUBJECT_TYPES,
  type SubscriptionSubject,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const uuid = z.string().uuid();

/** 校验路径参数是合法的 UUID，否则报 400（而不是让 Postgres 的 22P02 落到 404）。 */
function idParam(c: Context, name: string, message: string): string {
  const r = uuid.safeParse(c.req.param(name));
  if (!r.success) throw new AppError('invalid', message);
  return r.data;
}

function subjectParam(c: Context): SubscriptionSubject {
  const type = z.enum(SUBSCRIPTION_SUBJECT_TYPES).safeParse(c.req.param('type'));
  if (!type.success) throw new AppError('invalid', '只能关注需求或 PRD');
  return { type: type.data, id: idParam(c, 'id', '关注的对象不存在') };
}

const listQuery = z.object({
  filter: z.enum(['all', 'unread', 'mentioned']).optional(),
  kind: z.enum(MEMBER_NOTIFICATION_KINDS).optional(),
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const prefBody = z.object({ inApp: z.boolean(), wecom: z.boolean(), email: z.boolean() });
const channelBody = z.object({ channelId: uuid.nullable() });

export function registerMemberNotificationRoutes(app: App, deps: ApiDeps): void {
  // 站内通知（本人）
  app.get('/orgs/:org/notifications', async (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) throw new AppError('invalid', '查询参数有误');
    return c.json(await listMyNotifications(deps.db, c.get('actor'), q.data));
  });

  app.get('/orgs/:org/notifications/unread-count', async (c) => c.json({ count: await countMyUnread(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/notifications/read-all', async (c) => c.json({ count: await markAllNotificationsRead(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/notifications/read-subject', async (c) => {
    const body = await readJson(c, z.object({ subjectType: z.enum(NOTIFICATION_SUBJECT_TYPES), subjectId: uuid }));
    return c.json({ count: await markSubjectNotificationsRead(deps.db, c.get('actor'), { type: body.subjectType, id: body.subjectId }) });
  });

  app.post('/orgs/:org/notifications/:id/read', async (c) => {
    await markNotificationRead(deps.db, c.get('actor'), idParam(c, 'id', '通知不存在'));
    return c.body(null, 204);
  });

  // 关注
  app.get('/orgs/:org/subscriptions/:type/:id', async (c) => c.json({ subscription: await getSubscription(deps.db, c.get('actor'), subjectParam(c)) }));

  app.put('/orgs/:org/subscriptions/:type/:id', async (c) => {
    const subject = subjectParam(c);
    const body = await readJson(c, z.object({ following: z.boolean() }));
    return c.json({ subscription: await setSubscription(deps.db, c.get('actor'), subject, body.following) });
  });

  // 个人偏好
  app.get('/orgs/:org/me/notification-settings', async (c) => c.json({ settings: await getNotificationSettings(deps.db, c.get('actor')) }));

  app.put('/orgs/:org/me/notification-prefs/:kind', async (c) => {
    const kind = z.enum(MEMBER_NOTIFICATION_KINDS).safeParse(c.req.param('kind'));
    if (!kind.success) throw new AppError('invalid', '通知类型不存在');
    const body = await readJson(c, prefBody);
    return c.json({ settings: await setNotificationPref(deps.db, c.get('actor'), kind.data, body) });
  });

  // @ 候选成员
  app.get('/orgs/:org/products/:id/mention-members', async (c) => c.json({ members: await listMentionMembers(deps.db, c.get('actor'), idParam(c, 'id', '产品不存在')) }));

  // 个人提醒通道（产品）与个人通知邮件通道（组织）
  app.get('/orgs/:org/products/:id/personal-channel', async (c) => c.json(await getPersonalChannel(deps.db, c.get('actor'), idParam(c, 'id', '产品不存在'))));

  app.put('/orgs/:org/products/:id/personal-channel', async (c) => {
    const productId = idParam(c, 'id', '产品不存在');
    const body = await readJson(c, channelBody);
    return c.json(await setPersonalChannel(deps.db, c.get('actor'), productId, body.channelId));
  });

  app.get('/orgs/:org/personal-email-channel', async (c) => c.json(await getPersonalEmailChannel(deps.db, c.get('actor'))));

  app.put('/orgs/:org/personal-email-channel', async (c) => {
    const body = await readJson(c, channelBody);
    return c.json(await setPersonalEmailChannel(deps.db, c.get('actor'), body.channelId));
  });
}
```

- [ ] **Step 5: 实现 `routes/wecom.ts`**

```ts
import {
  AppError,
  applyWecomImport,
  completeWecomBind,
  getWecomApp,
  previewWecomImport,
  saveWecomApp,
  setMemberWecomUserid,
  startWecomBind,
  unbindMyWecom,
  type WecomOAuthDeps,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const uuid = z.string().uuid();
const csvBody = z.object({ csv: z.string().max(200_000) });

function idParam(c: Context, name: string, message: string): string {
  const r = uuid.safeParse(c.req.param(name));
  if (!r.success) throw new AppError('invalid', message);
  return r.data;
}

export function registerWecomRoutes(app: App, deps: ApiDeps): void {
  const oauth = (): WecomOAuthDeps => ({ secretKey: deps.notify.secretKey, publicUrl: deps.publicUrl, apiBase: deps.wecomApiBase });

  // 成员的企业微信账号（组织管理员）
  app.put('/orgs/:org/members/:id/wecom', async (c) => {
    const memberId = idParam(c, 'id', '成员不存在');
    const body = await readJson(c, z.object({ userid: z.string().max(64).nullable() }));
    return c.json({ member: await setMemberWecomUserid(deps.db, c.get('actor'), memberId, body.userid) });
  });

  app.post('/orgs/:org/wecom-import/preview', async (c) => {
    const body = await readJson(c, csvBody);
    return c.json({ result: await previewWecomImport(deps.db, c.get('actor'), body.csv) });
  });

  app.post('/orgs/:org/wecom-import', async (c) => {
    const body = await readJson(c, csvBody);
    return c.json({ result: await applyWecomImport(deps.db, c.get('actor'), body.csv) });
  });

  // 企业微信自建应用（组织管理员）
  app.get('/orgs/:org/wecom-app', async (c) => c.json({ settings: await getWecomApp(deps.db, c.get('actor'), { publicUrl: deps.publicUrl }) }));

  app.put('/orgs/:org/wecom-app', async (c) => {
    const body = await readJson(c, z.object({ corpId: z.string().max(64), agentId: z.string().max(20), secret: z.string().max(200).optional(), bindEnabled: z.boolean() }));
    return c.json({ settings: await saveWecomApp(deps.db, c.get('actor'), body, { secretKey: deps.notify.secretKey, publicUrl: deps.publicUrl }) });
  });

  // 扫码绑定与解除（本人）
  app.post('/orgs/:org/me/wecom/bind', async (c) => c.json(await startWecomBind(deps.db, c.get('actor'), oauth())));

  app.delete('/orgs/:org/me/wecom', async (c) => {
    await unbindMyWecom(deps.db, c.get('actor'));
    return c.body(null, 204);
  });

  /** 企业微信授权后浏览器跳回这里：结果以查询参数带回个人设置页（成功 wecom=bound，失败 wecom_error=原因）。 */
  app.get('/orgs/:org/wecom/callback', async (c) => {
    const back = (q: Record<string, string>) => c.redirect(`/settings?${new URLSearchParams({ org: c.req.param('org'), ...q })}`);
    try {
      await completeWecomBind(deps.db, c.get('actor'), { code: c.req.query('code') ?? null, state: c.req.query('state') ?? null }, oauth());
      return back({ wecom: 'bound' });
    } catch (e) {
      if (e instanceof AppError) return back({ wecom_error: e.message });
      throw e;
    }
  });
}
```

- [ ] **Step 6: 注册路由与依赖**

`apps/web/src/server/api.ts`：导入加 `import { registerMemberNotificationRoutes } from './routes/member-notifications';`、`import { registerWecomRoutes } from './routes/wecom';`；`ApiDeps` 改为：

```ts
/**
 * notify：推送的密钥、对外网址与发送器；tickApi：是否开放手动驱动后台发送的接口（FLOWER_NOTIFY_TICK_API=1）；
 * wecomApiBase：服务端访问企业微信接口的基础地址，生产固定为 https://qyapi.weixin.qq.com，只有测试传入本机假服务。
 */
export type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string; storage: FileStorage; notify: NotifyDeps; tickApi: boolean; wecomApiBase: string };
```

`createApi` 末尾、`registerNotificationRoutes(app, deps);` 之后加：

```ts
  registerMemberNotificationRoutes(app, deps);
  registerWecomRoutes(app, deps);
```

`apps/web/src/server/runtime.ts`：导入加 `WECOM_API_BASE`，`createApi({ … })` 加一项 `wecomApiBase: WECOM_API_BASE,`。

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run test/api && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: 全部 PASS；typecheck 与 lint 无错误。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/server apps/web/test/fake-wecom.ts apps/web/test/api/helpers.ts apps/web/test/api/member-notifications.test.ts apps/web/test/api/wecom.test.ts
git commit -m "feat(web): 站内通知、关注、偏好、个人提醒通道、企业微信账号与应用、扫码回调接口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 前端数据层：类型、查询、通知与 @ 的纯逻辑

**Files:**
- Create: `apps/web/src/features/member-notifications/model.ts`、`apps/web/src/features/member-notifications/model.test.ts`、`apps/web/src/features/mentions/model.ts`、`apps/web/src/features/mentions/model.test.ts`
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`、`apps/web/src/features/members/model.test.ts`

**Interfaces:**
- Consumes: Task 11 的接口；`@flower/core/notifications` 的 `MEMBER_NOTIFICATION_KINDS`、`MemberNotificationKind`、`NotificationPrefChannel`；`@flower/core/links` 的 `mentionMarkup`
- Produces:
  - 类型：`MemberNotification`、`MentionMember`、`NotificationSettings`、`Subscription`、`WecomAppSettings`、`WecomImportResult`、`WecomImportRow`、`PersonalChannelSetting`
  - 查询：`qk.unreadCount`、`qk.notifications`、`qk.subscription`、`qk.notificationSettings`、`qk.mentionMembers`、`qk.wecomApp`、`qk.personalChannel`、`qk.personalEmailChannel`；`inboxKeys(o)`；`useUnreadCount(o)`（30 秒刷新）、`useNotifications(o, query, enabled)`、`useNotificationPages(o, query)`、`useSubscription(o, type, id)`、`useNotificationSettings(o)`、`useMentionMembers(o, productId)`、`useWecomApp(o)`、`usePersonalChannel(o, productId)`、`usePersonalEmailChannel(o)`
  - `features/member-notifications/model.ts`：`BELL_TABS`、`type BellTab`、`unreadBadge(count)`、`groupByDay(items, now, timeZone?)`、`relativeTime(iso, now, timeZone?)`、`actorLabel(n)`、`type NotificationPageFilter = { read: 'all' | 'unread'; kind: MemberNotificationKind | '' }`、`parseNotificationFilter(params)`、`pageUrlQuery(f)`、`pageApiQuery(f)`、`prefCell(settings, channel): { disabled: boolean; reason: string | null }`
  - `features/mentions/model.ts`：`type MentionQuery = { start: number; query: string }`、`activeMentionQuery(value, caret)`、`filterMentionMembers(list, query, limit?)`、`applyMention(value, q, caret, member)`、`mentionTitle(member: MentionMember | null | undefined)`、`MENTION_NO_ACCESS`

- [ ] **Step 1: 写失败的测试**

新建 `apps/web/src/features/member-notifications/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { NotificationSettings } from '@/lib/types';
import { actorLabel, groupByDay, pageApiQuery, pageUrlQuery, parseNotificationFilter, prefCell, relativeTime, unreadBadge } from './model';

const NOW = new Date('2026-10-12T10:00:00Z');
const TZ = 'Asia/Shanghai';
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('铃铛与列表', () => {
  it('未读数：0 不显示，超过 99 显示 99+', () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(7)).toBe('7');
    expect(unreadBadge(120)).toBe('99+');
  });

  it('相对时间', () => {
    expect(relativeTime(ago(30_000), NOW, TZ)).toBe('刚刚');
    expect(relativeTime(ago(5 * 60_000), NOW, TZ)).toBe('5 分钟前');
    expect(relativeTime(ago(3 * 3_600_000), NOW, TZ)).toBe('3 小时前');
    expect(relativeTime(ago(2 * 86_400_000), NOW, TZ)).toBe('2 天前');
    expect(relativeTime(ago(10 * 86_400_000), NOW, TZ)).toBe('10-02');
  });

  it('按今天与更早分组（按时区判断日期），空组不出现', () => {
    const today = { createdAt: '2026-10-11T17:00:00Z' };
    const earlier = { createdAt: '2026-10-11T15:00:00Z' };
    expect(groupByDay([today, earlier], NOW, TZ)).toEqual([
      { label: '今天', items: [today] },
      { label: '更早', items: [earlier] },
    ]);
    expect(groupByDay([earlier], NOW, TZ).map((g) => g.label)).toEqual(['更早']);
  });

  it('操作人：当前姓名；系统告警为「系统」', () => {
    expect(actorLabel({ kind: 'mentioned', actor: { id: 'x', displayName: '张三' } })).toBe('张三');
    expect(actorLabel({ kind: 'system_alert', actor: null })).toBe('系统');
  });

  it('通知页的筛选：地址栏与接口参数；不认识的值按默认', () => {
    const f = parseNotificationFilter(new URLSearchParams('read=unread&kind=assigned'));
    expect(f).toEqual({ read: 'unread', kind: 'assigned' });
    expect(pageUrlQuery(f)).toBe('read=unread&kind=assigned');
    expect(pageApiQuery(f)).toBe('filter=unread&kind=assigned&limit=30');
    expect(parseNotificationFilter(new URLSearchParams('read=x&kind=y'))).toEqual({ read: 'all', kind: '' });
    expect(pageApiQuery({ read: 'all', kind: '' })).toBe('filter=all&limit=30');
  });
});

describe('偏好表的可用情况', () => {
  const base: NotificationSettings = { prefs: [], wecom: { userid: 'zhangsan', bindEnabled: true, productChannels: 1 }, email: { address: 'a@example.com', channelConfigured: true } };
  it('企业微信：未绑定或没有产品指定个人提醒通道时置灰并说明', () => {
    expect(prefCell(base, 'wecom')).toEqual({ disabled: false, reason: null });
    expect(prefCell({ ...base, wecom: { ...base.wecom, userid: null } }, 'wecom').reason).toBe('还没有绑定企业微信');
    expect(prefCell({ ...base, wecom: { ...base.wecom, productChannels: 0 } }, 'wecom').reason).toBe('你能看到的产品都还没有指定个人提醒通道');
  });
  it('邮件：组织没有邮件通道或成员没有邮箱时置灰；站内总是可用', () => {
    expect(prefCell({ ...base, email: { address: 'a@example.com', channelConfigured: false } }, 'email').reason).toBe('组织还没有指定个人通知邮件通道');
    expect(prefCell({ ...base, email: { address: null, channelConfigured: true } }, 'email').reason).toBe('你的成员资料里没有邮箱');
    expect(prefCell({ ...base, wecom: { userid: null, bindEnabled: false, productChannels: 0 } }, 'inApp')).toEqual({ disabled: false, reason: null });
  });
});
```

新建 `apps/web/src/features/mentions/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { MentionMember } from '@/lib/types';
import { activeMentionQuery, applyMention, filterMentionMembers, mentionTitle } from './model';

const A = '0192a000-0000-7000-8000-00000000000a';
const m = (over: Partial<MentionMember>): MentionMember => ({ id: A, displayName: '张三', email: 'zhang@example.com', status: 'active', wecomBound: false, canSeeProduct: true, ...over });

describe('@ 补全', () => {
  it('光标前正在输入的 @：行首或空白、标点之后才算；邮箱里的 @、带空白或括号的不算', () => {
    expect(activeMentionQuery('请 @张', 4)).toEqual({ start: 2, query: '张' });
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeMentionQuery('（@李', 3)).toEqual({ start: 1, query: '李' });
    expect(activeMentionQuery('mail a@b.com', 12)).toBeNull();
    expect(activeMentionQuery('@张 三', 4)).toBeNull();
    expect(activeMentionQuery(`[@张三](member:${A})`, 3)).toBeNull();
    const long = `@${'张'.repeat(21)}`;
    expect(activeMentionQuery(long, long.length)).toBeNull();
  });

  it('只列在职成员，按姓名或邮箱包含匹配，姓名开头的排前，最多 8 个', () => {
    const list = [
      m({ id: '1', displayName: '小张', email: 'x@example.com' }),
      m({ id: '2', displayName: '张三' }),
      m({ id: '3', displayName: '张四', status: 'left' }),
      m({ id: '4', displayName: '李四', email: 'zhangli@example.com' }),
    ];
    expect(filterMentionMembers(list, '张').map((x) => x.id)).toEqual(['2', '1']);
    expect(filterMentionMembers(list, 'ZHANG').map((x) => x.id)).toEqual(['2', '4']);
    expect(filterMentionMembers(list, '').map((x) => x.id)).toEqual(['1', '2', '4']);
    expect(filterMentionMembers(Array.from({ length: 12 }, (_, i) => m({ id: String(i) })), '')).toHaveLength(8);
  });

  it('选中后写入 @ 写法并加一个空格，光标停在空格后', () => {
    const r = applyMention('请 @张 看下', { start: 2, query: '张' }, 4, m({}));
    expect(r.value).toBe(`请 [@张三](member:${A})  看下`);
    expect(r.caret).toBe(`请 [@张三](member:${A}) `.length);
  });

  it('悬停说明：邮箱与是否绑定企业微信；已离开与查不到的成员', () => {
    expect(mentionTitle(m({ wecomBound: true }))).toBe('zhang@example.com · 已绑定企业微信');
    expect(mentionTitle(m({ email: null, status: 'left' }))).toBe('没有邮箱 · 未绑定企业微信 · 已离开组织');
    expect(mentionTitle(null)).toBe('成员已不在组织中');
    expect(mentionTitle(undefined)).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run src/features/member-notifications/model.test.ts src/features/mentions/model.test.ts`
Expected: FAIL（`Cannot find module './model'`）。

- [ ] **Step 3: 类型（`lib/types.ts`）**

`from '@flower/core'` 的类型导入列表按字母顺序加入：`MemberNotificationView`、`MentionMember as CoreMentionMember`、`NotificationSettings as CoreNotificationSettings`、`PersonalChannelSetting as CorePersonalChannelSetting`、`SubscriptionView`、`WecomAppSettings as CoreWecomAppSettings`、`WecomImportResult as CoreWecomImportResult`。文件末尾加：

```ts
export type MemberNotification = Jsonify<MemberNotificationView>;
export type MentionMember = CoreMentionMember;
export type NotificationSettings = CoreNotificationSettings;
export type Subscription = SubscriptionView;
export type WecomAppSettings = Jsonify<CoreWecomAppSettings>;
export type WecomImportResult = CoreWecomImportResult;
export type WecomImportRow = WecomImportResult['rows'][number];
export type PersonalChannelSetting = CorePersonalChannelSetting;
```

`apps/web/src/features/members/model.test.ts` 的成员工厂补上新字段：

```ts
const m = (over: Partial<Member>): Member => ({
  id: 'x', kind: 'human', displayName: '成员', email: null, department: null, orgRole: 'member', status: 'active', wecomUserid: null,
  hasAccount: true, functionTagIds: [], productRoles: [], ...over,
});
```

- [ ] **Step 4: 查询（`lib/queries.ts`）**

`@tanstack/react-query` 的导入加 `useInfiniteQuery`；`./types` 的导入加 `MemberNotification`、`MentionMember`、`NotificationSettings`、`PersonalChannelSetting`、`Subscription`、`WecomAppSettings`。`qk` 末尾加：

```ts
  unreadCount: (o: string) => ['org', o, 'inbox', 'unread'] as const,
  notifications: (o: string, query: string) => ['org', o, 'inbox', 'list', query] as const,
  subscription: (o: string, type: string, id: string) => ['org', o, 'inbox', 'subscription', type, id] as const,
  notificationSettings: (o: string) => ['org', o, 'inbox', 'settings'] as const,
  mentionMembers: (o: string, productId: string) => ['org', o, 'mention-members', productId] as const,
  wecomApp: (o: string) => ['org', o, 'notify', 'wecom-app'] as const,
  personalChannel: (o: string, productId: string) => ['org', o, 'notify', 'personal-channel', productId] as const,
  personalEmailChannel: (o: string) => ['org', o, 'notify', 'personal-email-channel'] as const,
```

文件里推送查询之后加：

```ts
/** 站内通知相关查询的公共前缀：标已读、关注、偏好变化后统一失效。 */
export const inboxKeys = (o: string) => ['org', o, 'inbox'] as const;

export const useUnreadCount = (o: string) =>
  useQuery({ queryKey: qk.unreadCount(o), queryFn: () => api<{ count: number }>(`/orgs/${o}/notifications/unread-count`), select: (d) => d.count, refetchInterval: 30_000 });
export const useNotifications = (o: string, query: string, enabled = true) =>
  useQuery({
    queryKey: qk.notifications(o, query),
    queryFn: () => api<{ notifications: MemberNotification[]; nextCursor: string | null }>(`/orgs/${o}/notifications?${query}`),
    select: (d) => d.notifications,
    enabled,
    placeholderData: keepPreviousData,
  });
/** 通知页：按游标逐页加载。 */
export const useNotificationPages = (o: string, query: string) =>
  useInfiniteQuery({
    queryKey: [...qk.notifications(o, query), 'pages'],
    queryFn: ({ pageParam }) =>
      api<{ notifications: MemberNotification[]; nextCursor: string | null }>(`/orgs/${o}/notifications?${query}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
export const useSubscription = (o: string, type: 'requirement' | 'document', id: string | undefined) =>
  useQuery({
    queryKey: qk.subscription(o, type, id ?? ''),
    queryFn: () => api<{ subscription: Subscription }>(`/orgs/${o}/subscriptions/${type}/${id}`),
    select: (d) => d.subscription,
    enabled: !!id,
  });
export const useNotificationSettings = (o: string) =>
  useQuery({ queryKey: qk.notificationSettings(o), queryFn: () => api<{ settings: NotificationSettings }>(`/orgs/${o}/me/notification-settings`), select: (d) => d.settings });
/** @ 补全与成员标签用的成员列表；productId 为空时不请求。 */
export const useMentionMembers = (o: string, productId: string | undefined) =>
  useQuery({
    queryKey: qk.mentionMembers(o, productId ?? ''),
    queryFn: () => api<{ members: MentionMember[] }>(`/orgs/${o}/products/${productId}/mention-members`),
    select: (d) => d.members,
    enabled: !!productId,
    staleTime: 60_000,
  });
export const useWecomApp = (o: string) => useQuery({ queryKey: qk.wecomApp(o), queryFn: () => api<{ settings: WecomAppSettings }>(`/orgs/${o}/wecom-app`), select: (d) => d.settings });
export const usePersonalChannel = (o: string, productId: string) =>
  useQuery({ queryKey: qk.personalChannel(o, productId), queryFn: () => api<PersonalChannelSetting>(`/orgs/${o}/products/${productId}/personal-channel`), enabled: !!productId });
export const usePersonalEmailChannel = (o: string) => useQuery({ queryKey: qk.personalEmailChannel(o), queryFn: () => api<PersonalChannelSetting>(`/orgs/${o}/personal-email-channel`) });
```

- [ ] **Step 5: 实现 `features/member-notifications/model.ts`**

```ts
import { MEMBER_NOTIFICATION_KINDS, type MemberNotificationKind, type NotificationPrefChannel } from '@flower/core/notifications';
import type { MemberNotification, NotificationSettings } from '@/lib/types';

export const BELL_TABS = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'mentioned', label: '@我' },
] as const;
export type BellTab = (typeof BELL_TABS)[number]['key'];

/** 铃铛上的未读数：0 不显示，超过 99 显示 99+。 */
export function unreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

const dayOf = (d: Date, timeZone?: string): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** 按「今天 / 更早」分组（日期按浏览器时区，测试可传时区），组内保持原顺序，空组不出现。 */
export function groupByDay<T extends { createdAt: string }>(items: T[], now: Date, timeZone?: string): Array<{ label: '今天' | '更早'; items: T[] }> {
  const today = dayOf(now, timeZone);
  const isToday = (n: T) => dayOf(new Date(n.createdAt), timeZone) === today;
  return [
    { label: '今天' as const, items: items.filter(isToday) },
    { label: '更早' as const, items: items.filter((n) => !isToday(n)) },
  ].filter((g) => g.items.length > 0);
}

/** 相对时间：刚刚、n 分钟前、n 小时前、n 天前（7 天内），更早显示 MM-DD。 */
export function relativeTime(iso: string, now: Date, timeZone?: string): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return dayOf(new Date(iso), timeZone).slice(5);
}

/** 「谁」：操作人的当前姓名；系统告警为「系统」。 */
export const actorLabel = (n: Pick<MemberNotification, 'actor' | 'kind'>): string => n.actor?.displayName ?? (n.kind === 'system_alert' ? '系统' : '有人');

export type NotificationPageFilter = { read: 'all' | 'unread'; kind: MemberNotificationKind | '' };

export function parseNotificationFilter(p: URLSearchParams): NotificationPageFilter {
  const kind = p.get('kind') ?? '';
  return {
    read: p.get('read') === 'unread' ? 'unread' : 'all',
    kind: (MEMBER_NOTIFICATION_KINDS as readonly string[]).includes(kind) ? (kind as MemberNotificationKind) : '',
  };
}

/** 地址栏里的筛选：只写非默认值。 */
export function pageUrlQuery(f: NotificationPageFilter): string {
  const p = new URLSearchParams();
  if (f.read === 'unread') p.set('read', 'unread');
  if (f.kind) p.set('kind', f.kind);
  return p.toString();
}

/** 通知页请求接口的参数：每页 30 条。 */
export function pageApiQuery(f: NotificationPageFilter): string {
  const p = new URLSearchParams({ filter: f.read });
  if (f.kind) p.set('kind', f.kind);
  p.set('limit', '30');
  return p.toString();
}

/** 偏好表一列能否修改：企业微信要求已绑定、且有产品指定了个人提醒通道；邮件要求组织有个人通知邮件通道、成员有邮箱。 */
export function prefCell(s: NotificationSettings, channel: NotificationPrefChannel): { disabled: boolean; reason: string | null } {
  if (channel === 'wecom') {
    if (!s.wecom.userid) return { disabled: true, reason: '还没有绑定企业微信' };
    if (s.wecom.productChannels === 0) return { disabled: true, reason: '你能看到的产品都还没有指定个人提醒通道' };
  }
  if (channel === 'email') {
    if (!s.email.channelConfigured) return { disabled: true, reason: '组织还没有指定个人通知邮件通道' };
    if (!s.email.address) return { disabled: true, reason: '你的成员资料里没有邮箱' };
  }
  return { disabled: false, reason: null };
}
```

- [ ] **Step 6: 实现 `features/mentions/model.ts`**

```ts
import { mentionMarkup } from '@flower/core/links';
import type { MentionMember } from '@/lib/types';

export type MentionQuery = { start: number; query: string };

const MAX_QUERY = 20;
/** @ 前面允许的字符：行首、空白与常见标点。字母数字之后的 @（如邮箱）不触发补全。 */
const BEFORE_AT = /[\s(（,，.。:：;；!！?？、"'“‘]/;

export const MENTION_NO_ACCESS = '看不到这个产品';

/** 光标前正在输入的 @：@ 到光标之间不含空白与 []()，最多 20 字。 */
export function activeMentionQuery(value: string, caret: number): MentionQuery | null {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start === -1) return null;
  const prev = before[start - 1];
  if (prev !== undefined && !BEFORE_AT.test(prev)) return null;
  const query = before.slice(start + 1);
  if (query.length > MAX_QUERY || /[\s[\]()（）]/.test(query)) return null;
  return { start, query };
}

/** 补全候选：只列在职成员；按姓名或邮箱包含匹配（忽略大小写），姓名开头的排前；最多 limit 个。 */
export function filterMentionMembers(list: MentionMember[], query: string, limit = 8): MentionMember[] {
  const q = query.trim().toLowerCase();
  const active = list.filter((m) => m.status === 'active');
  const matched = q ? active.filter((m) => m.displayName.toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q)) : active;
  const starts = (m: MentionMember) => !!q && m.displayName.toLowerCase().startsWith(q);
  return [...matched.filter(starts), ...matched.filter((m) => !starts(m))].slice(0, limit);
}

/** 选中一个成员：把 @ 到光标的文字换成 @ 写法并加一个空格。 */
export function applyMention(value: string, q: MentionQuery, caret: number, member: Pick<MentionMember, 'id' | 'displayName'>): { value: string; caret: number } {
  const head = value.slice(0, q.start);
  const inserted = `${mentionMarkup(member.id, member.displayName)} `;
  return { value: head + inserted + value.slice(caret), caret: head.length + inserted.length };
}

/** 成员标签的悬停说明：undefined 为还在加载，null 为查不到（已不在组织中）。 */
export function mentionTitle(member: MentionMember | null | undefined): string {
  if (member === undefined) return '';
  if (member === null) return '成员已不在组织中';
  return [member.email ?? '没有邮箱', member.wecomBound ? '已绑定企业微信' : '未绑定企业微信', member.status === 'left' ? '已离开组织' : null].filter(Boolean).join(' · ');
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run src && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: 全部 PASS；typecheck 与 lint 无错误。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/features/member-notifications apps/web/src/features/mentions apps/web/src/features/members/model.test.ts
git commit -m "feat(web): 站内通知与 @ 的前端数据层：类型、查询与纯逻辑（分组、相对时间、筛选、偏好可用情况、@ 补全）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 页面：顶栏铃铛与通知页

**Files:**
- Create: `apps/web/src/components/notification-bell.tsx`、`apps/web/src/app/(app)/[org]/notifications/page.tsx`、`apps/web/e2e/member-notifications.spec.ts`
- Modify: `apps/web/src/components/org-shell.tsx`、`apps/web/src/features/shell/nav.ts`、`apps/web/src/features/shell/nav.test.ts`、`apps/web/e2e/helpers.ts`

**Interfaces:**
- Consumes: Task 12 的 `useUnreadCount`、`useNotifications`、`useNotificationPages`、`inboxKeys`、`BELL_TABS`、`groupByDay`、`relativeTime`、`actorLabel`、`unreadBadge`、`parseNotificationFilter`、`pageUrlQuery`、`pageApiQuery`
- Produces:
  - `NotificationItem({ n, now, onOpen })`（铃铛面板与通知页共用；按钮的无障碍名称为「操作人 动作：标题」，未读时加「（未读）」）、`NotificationBell({ org })`（按钮名称：有未读时「通知，n 条未读」，否则「通知」；面板 `role=dialog` 名称「通知」，页签 `role=tab`，分组 `region`「今天」「更早」）
  - 页面 `/[org]/notifications`：筛选「按类型筛选」「按已读状态筛选」写在地址栏（`read`、`kind`），列表 `list`「通知列表」，「加载更多」「全部标为已读」
  - `activeNavKey` 对 `/{org}/notifications` 返回 `inbox`（不高亮任何导航项）
  - e2e：`memberRequest(request, { email, name, orgRole?, password? }): Promise<{ ctx: APIRequestContext; memberId: string }>`；`tick` 的返回类型加 `events`、`notified`

- [ ] **Step 1: e2e 辅助函数**

`apps/web/e2e/helpers.ts`：`@playwright/test` 的导入加 `request as playwrightRequest`；`tick` 的返回类型改为：

```ts
type TickSummary = { orgs: number; schedulesRun: number; events: number; notified: number; sent: number; failed: number; dead: number; rateLimited: number };

/** 驱动一轮后台循环（端到端服务端设置了 FLOWER_NOTIFY_WORKER=off、FLOWER_NOTIFY_TICK_API=1）：生成站内通知、执行定时推送、发送；now 用来模拟时间。 */
export async function tick(request: APIRequestContext, now?: Date): Promise<TickSummary> {
  return (await json<{ summary: TickSummary }>(request.post('/api/v1/instance/notifications/tick', { data: now ? { now: now.toISOString() } : {} }))).summary;
}
```

文件末尾加：

```ts
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
```

- [ ] **Step 2: 写失败的端到端用例与导航单测**

`apps/web/src/features/shell/nav.test.ts` 的「根据路径判断当前导航项」用例末尾加：

```ts
    expect(activeNavKey('/acme/notifications', 'acme')).toBe('inbox');
```

新建 `apps/web/e2e/member-notifications.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, expectNoPageOverflow, login, memberRequest, ok, setupInstance, tick } from './helpers';

const mention = (id: string, name: string) => `[@${name}](member:${id})`;

test('铃铛：被 @ 与被指派后显示未读数；面板按今天分组、按 @我 筛选；点击跳转并标为已读；全部标为已读', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  const productId = await createProduct(request);
  const login1 = await createRequirement(request, productId, '登录页改版');
  const share = await createRequirement(request, productId, '分享页');
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  await ok(request.post(`/api/v1/orgs/acme/requirements/${login1.id}/comments`, { data: { body: `${mention(zhang.memberId, '张三')} 请看` } }));
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${share.id}`, { data: { ownerMemberId: zhang.memberId } }));
  expect((await tick(request)).notified).toBe(2);

  await login(page, 'zhang@example.com', 'password123');
  await page.goto('/acme');
  await page.getByRole('button', { name: '通知，2 条未读' }).click();
  const panel = page.getByRole('dialog', { name: '通知' });
  await expect(panel.getByRole('region', { name: '今天' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '林澄 把你设为需求负责人：PAN-2 分享页（未读）' })).toBeVisible();
  await panel.getByRole('tab', { name: '@我' }).click();
  const mentioned = panel.getByRole('button', { name: '林澄 在评论中 @ 了你：PAN-1 登录页改版（未读）' });
  await expect(mentioned).toBeVisible();
  await expect(panel.getByRole('button', { name: /把你设为需求负责人/ })).toHaveCount(0);
  await mentioned.click();
  await page.waitForURL('**/acme/requirements/PAN-1');
  await page.getByRole('button', { name: '通知，1 条未读' }).click();
  await page.getByRole('dialog', { name: '通知' }).getByRole('button', { name: '全部标为已读' }).click();
  await expect(page.getByRole('button', { name: '通知', exact: true })).toBeVisible();
  await zhang.ctx.dispose();
});

test('通知页：加载更多；按类型与已读状态筛选；点击跳转；1440 与 760 两种宽度不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  const productId = await createProduct(request);
  const login1 = await createRequirement(request, productId, '登录页改版');
  const share = await createRequirement(request, productId, '分享页');
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  for (let i = 1; i <= 31; i++) {
    await ok(request.post(`/api/v1/orgs/acme/requirements/${login1.id}/comments`, { data: { body: `${mention(zhang.memberId, '张三')} 第 ${i} 条` } }));
  }
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${share.id}`, { data: { ownerMemberId: zhang.memberId } }));
  expect((await tick(request)).notified).toBe(32);

  await login(page, 'zhang@example.com', 'password123');
  await page.goto('/acme/notifications');
  const list = page.getByRole('list', { name: '通知列表' });
  await expect(list.getByRole('listitem')).toHaveCount(30);
  await expectNoPageOverflow(page);
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(32);
  await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);
  await page.getByLabel('按类型筛选').click();
  await page.getByRole('option', { name: '被指派' }).click();
  await expect(page).toHaveURL(/kind=assigned/);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: /把你设为需求负责人/ }).click();
  await page.waitForURL('**/acme/requirements/PAN-2');
  await page.goto('/acme/notifications?read=unread&kind=assigned');
  await expect(page.getByText('没有通知')).toBeVisible();

  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/acme/notifications');
  await expect(list.getByRole('listitem').first()).toBeVisible();
  await expectNoPageOverflow(page);
  await page.getByRole('button', { name: /^通知，/ }).click();
  await expect(page.getByRole('dialog', { name: '通知' })).toBeVisible();
  await expectNoPageOverflow(page);
  await zhang.ctx.dispose();
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @flower/web exec vitest run src/features/shell/nav.test.ts && pnpm --filter @flower/web e2e member-notifications.spec.ts`
Expected: 单测 FAIL（返回 `home`）；端到端 FAIL（找不到「通知，2 条未读」按钮）。

- [ ] **Step 4: 导航（`features/shell/nav.ts`）**

`activeNavKey` 里 `const m = /^\/settings\/([^/]+)/.exec(rest);` 之前加：

```ts
  // 通知页不对应导航项（铃铛在顶栏）；不能返回 notifications，那是组织设置「推送」的键
  if (/^\/notifications(\/|$)/.test(rest)) return 'inbox';
```

- [ ] **Step 5: 铃铛（`components/notification-bell.tsx`）**

```tsx
'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { actorLabel, BELL_TABS, type BellTab, groupByDay, relativeTime, unreadBadge } from '@/features/member-notifications/model';
import { api } from '@/lib/api';
import { inboxKeys, useApiMutation, useNotifications, useUnreadCount } from '@/lib/queries';
import type { MemberNotification } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 一条通知：「谁 做了什么」、对象标题、相对时间；未读有圆点。铃铛面板与通知页共用。 */
export function NotificationItem({ n, now, onOpen }: { n: MemberNotification; now: Date; onOpen: (n: MemberNotification) => void }) {
  const actor = actorLabel(n);
  return (
    <button
      type="button"
      aria-label={`${actor} ${n.body}：${n.title}${n.readAt ? '' : '（未读）'}`}
      onClick={() => onOpen(n)}
      className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted"
    >
      <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] leading-5">
          <span className="font-medium">{actor}</span> {n.body}
        </span>
        <span className="truncate text-[12px] text-muted-foreground">{n.title}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{relativeTime(n.createdAt, now)}</span>
    </button>
  );
}

/** 顶栏铃铛：未读数每 30 秒刷新；面板列出最近 20 条，可切换全部 / 未读 / @我。 */
export function NotificationBell({ org }: { org: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<BellTab>('all');
  const [now, setNow] = useState(() => new Date());
  const count = useUnreadCount(org);
  const list = useNotifications(org, new URLSearchParams({ filter: tab, limit: '20' }).toString(), open);
  const readOne = useApiMutation((id: string) => api(`/orgs/${org}/notifications/${id}/read`, { method: 'POST' }), { invalidate: [inboxKeys(org)], silentError: true });
  const readAll = useApiMutation(() => api(`/orgs/${org}/notifications/read-all`, { method: 'POST' }), { invalidate: [inboxKeys(org)], success: '已全部标为已读' });
  const badge = unreadBadge(count.data ?? 0);
  const items = list.data ?? [];
  const onOpen = (n: MemberNotification) => {
    if (!n.readAt) readOne.mutate(n.id);
    setOpen(false);
    router.push(n.url);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setNow(new Date());
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={badge ? `通知，${count.data} 条未读` : '通知'}>
          <Bell className="size-4" aria-hidden="true" />
          {badge && (
            <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-destructive px-1 text-center font-mono text-[10px] leading-4 text-white">
              {badge}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="通知" className="w-[380px] max-w-[calc(100vw-2rem)] p-0">
        <div role="tablist" aria-label="通知筛选" className="flex gap-1 border-b px-2 py-1.5">
          {BELL_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn('rounded-md px-2.5 py-1 text-[13px]', tab === t.key ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="max-h-[420px] overflow-y-auto p-1">
          {list.isError ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">加载通知失败，请稍后再试。</p>
          ) : !list.data ? null : items.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">没有通知</p>
          ) : (
            groupByDay(items, now).map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h3 className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">{g.label}</h3>
                {g.items.map((n) => (
                  <NotificationItem key={n.id} n={n} now={now} onOpen={onOpen} />
                ))}
              </section>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => readAll.mutate(undefined)} disabled={readAll.isPending || !badge}>
            全部标为已读
          </Button>
          <Link href={`/${org}/notifications`} onClick={() => setOpen(false)} className="px-2 text-[13px] text-primary hover:underline">
            查看全部
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

`components/org-shell.tsx`：导入加 `import { NotificationBell } from './notification-bell';`，顶栏改为：

```tsx
        <div className="flex h-12 items-center justify-end gap-1 border-b bg-card px-6">
          <NotificationBell org={org} />
          <UserMenu />
        </div>
```

- [ ] **Step 6: 通知页（`app/(app)/[org]/notifications/page.tsx`）**

```tsx
'use client';

import { MEMBER_NOTIFICATION_KIND_LABELS, MEMBER_NOTIFICATION_KINDS } from '@flower/core/notifications';
import { Bell } from 'lucide-react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { NotificationItem } from '@/components/notification-bell';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type NotificationPageFilter, pageApiQuery, pageUrlQuery, parseNotificationFilter } from '@/features/member-notifications/model';
import { api } from '@/lib/api';
import { inboxKeys, useApiMutation, useNotificationPages } from '@/lib/queries';
import type { MemberNotification } from '@/lib/types';

const ALL_KINDS = 'all';

function NotificationsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const filter = parseNotificationFilter(useSearchParams());
  const [now] = useState(() => new Date());
  const pages = useNotificationPages(org, pageApiQuery(filter));
  const readOne = useApiMutation((id: string) => api(`/orgs/${org}/notifications/${id}/read`, { method: 'POST' }), { invalidate: [inboxKeys(org)], silentError: true });
  const readAll = useApiMutation(() => api(`/orgs/${org}/notifications/read-all`, { method: 'POST' }), { invalidate: [inboxKeys(org)], success: '已全部标为已读' });
  const setFilter = (next: NotificationPageFilter) => {
    const q = pageUrlQuery(next);
    router.replace(q ? `${pathname}?${q}` : pathname);
  };
  const open = (n: MemberNotification) => {
    if (!n.readAt) readOne.mutate(n.id);
    router.push(n.url);
  };
  const items = pages.data?.pages.flatMap((p) => p.notifications) ?? [];
  return (
    <>
      <PageHeader
        crumbs={[{ label: '通知' }]}
        title="通知"
        description="被 @、被指派、关注对象变化、等你签字与系统告警。通知偏好在个人设置里修改。"
        actions={
          <Button variant="outline" onClick={() => readAll.mutate(undefined)} disabled={readAll.isPending}>
            全部标为已读
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter.kind || ALL_KINDS} onValueChange={(v) => setFilter({ ...filter, kind: v === ALL_KINDS ? '' : (v as NotificationPageFilter['kind']) })}>
          <SelectTrigger className="w-36" aria-label="按类型筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_KINDS}>全部类型</SelectItem>
            {MEMBER_NOTIFICATION_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {MEMBER_NOTIFICATION_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.read} onValueChange={(v) => setFilter({ ...filter, read: v as NotificationPageFilter['read'] })}>
          <SelectTrigger className="w-28" aria-label="按已读状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="unread">未读</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {pages.isError ? (
        <LoadError message="加载通知失败，请重试。" onRetry={() => pages.refetch()} />
      ) : !pages.data ? null : items.length === 0 ? (
        <EmptyState icon={Bell} title="没有通知" description="被 @、被指派，或关注的需求与 PRD 有变化时会出现在这里。" />
      ) : (
        <ul aria-label="通知列表" className="flex flex-col divide-y rounded-md border bg-card">
          {items.map((n) => (
            <li key={n.id} className="px-1 py-0.5">
              <NotificationItem n={n} now={now} onOpen={open} />
            </li>
          ))}
        </ul>
      )}
      {pages.hasNextPage && (
        <Button variant="outline" className="self-center" onClick={() => pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
          加载更多
        </Button>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <NotificationsPage />
    </Suspense>
  );
}
```

- [ ] **Step 7: 运行确认通过**

Run: `pnpm --filter @flower/web exec vitest run src/features/shell/nav.test.ts && pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck && pnpm --filter @flower/web e2e member-notifications.spec.ts layout.spec.ts`
Expected: 全部 PASS（`layout.spec.ts` 确认顶栏加了铃铛后原有布局断言仍通过）。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/components/notification-bell.tsx apps/web/src/components/org-shell.tsx "apps/web/src/app/(app)/[org]/notifications/page.tsx" apps/web/src/features/shell apps/web/e2e/helpers.ts apps/web/e2e/member-notifications.spec.ts
git commit -m "feat(web): 顶栏铃铛（未读数、分组、筛选、全部标为已读）与通知页（筛选、加载更多）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 页面：评论与需求描述的 @ 补全、成员标签

**Files:**
- Create: `apps/web/src/components/mention-chip.tsx`、`apps/web/e2e/mentions.spec.ts`
- Modify: `apps/web/src/components/wikilink-textarea.tsx`、`apps/web/src/components/wiki-text.tsx`、`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`、`apps/web/src/app/(app)/[org]/requirements/[key]/comments.tsx`、`apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`

**Interfaces:**
- Consumes: Task 12 的 `useMentionMembers`、`activeMentionQuery`、`filterMentionMembers`、`applyMention`、`mentionTitle`、`MENTION_NO_ACCESS`；Task 1 的 `splitRichText`、`Mention`
- Produces:
  - `WikilinkTextarea` 同时支持 `[[` 与 `@` 补全：`@` 的列表 `listbox` 名称「成员补全」，每项「成员 · 姓名 · 邮箱 ·（看不到这个产品）」；上下选择、回车插入 `[@姓名](member:ID) `、Esc 关闭；`[[` 的行为不变
  - `MentionChip({ mention, member })`：显示「@当前姓名」，`title` 为悬停说明；成员已离开或查不到时灰色、显示原名
  - `WikiText` 增加必填属性 `productId`，正文里的 @ 渲染为 `MentionChip`

- [ ] **Step 1: 写失败的端到端用例**

新建 `apps/web/e2e/mentions.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('评论与需求描述：输入 @ 补全成员，看不到产品的标出来，回车插入，Esc 关闭；显示为成员标签并按当前姓名显示', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录页改版');
  const zhangId = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '张三', email: 'zhang@example.com' } }))).member.id;
  const guestId = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '张访客', email: 'guest@example.com' } }))).member.id;
  await ok(request.patch(`/api/v1/orgs/acme/members/${guestId}`, { data: { orgRole: 'guest' } }));
  await ok(request.put(`/api/v1/orgs/acme/members/${zhangId}/wecom`, { data: { userid: 'zhangsan' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);

  const comments = page.getByRole('region', { name: /^评论/ });
  const input = comments.getByRole('textbox', { name: '写评论' });
  await input.click();
  await page.keyboard.type('请 @张访');
  const list = page.getByRole('listbox', { name: '成员补全' });
  await expect(list.getByRole('option', { name: /张访客.*看不到这个产品/ })).toBeVisible();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('张三');
  await expect(list.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue(`请 [@张三](member:${zhangId}) `);
  await expect(list).toBeHidden();
  await page.keyboard.type('邮箱 a@b.com 看一下');
  await expect(list).toBeHidden();
  await comments.getByRole('button', { name: '发表' }).click();
  const chip = comments.getByText('@张三', { exact: true });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('title', 'zhang@example.com · 已绑定企业微信');

  const desc = page.getByRole('region', { name: '描述' });
  await desc.getByRole('button', { name: '编辑' }).click();
  const box = desc.getByRole('textbox', { name: '描述' });
  await box.click();
  await page.keyboard.type('负责人 @zhang');
  await expect(list.getByRole('option', { name: /张三/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await box.fill(`负责人 [@张三](member:${zhangId})`);
  await desc.getByRole('button', { name: '保存' }).click();
  await expect(desc.getByText('@张三', { exact: true })).toBeVisible();

  // 改名后按当前姓名显示；离开组织后显示为灰色并在说明里注明
  await ok(request.patch(`/api/v1/orgs/acme/members/${zhangId}`, { data: { displayName: '张三丰' } }));
  await page.reload();
  await expect(comments.getByText('@张三丰', { exact: true })).toBeVisible();
  await ok(request.patch(`/api/v1/orgs/acme/members/${zhangId}`, { data: { status: 'left' } }));
  await page.reload();
  await expect(comments.getByText('@张三丰', { exact: true })).toHaveAttribute('title', 'zhang@example.com · 已绑定企业微信 · 已离开组织');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @flower/web e2e mentions.spec.ts`
Expected: FAIL（找不到「成员补全」列表）。

- [ ] **Step 3: 成员标签（`components/mention-chip.tsx`）**

```tsx
import type { Mention } from '@flower/core/links';
import { mentionTitle } from '@/features/mentions/model';
import type { MentionMember } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * 正文里的 @：按成员 ID 显示当前姓名；member 为 null（查不到）或成员已离开时显示为灰色，查不到时用写入时的姓名。
 * member 为 undefined 表示成员列表还在加载，先按写入时的姓名正常显示。
 */
export function MentionChip({ mention, member }: { mention: Mention; member: MentionMember | null | undefined }) {
  const grey = member === null || member?.status === 'left';
  return (
    <span
      title={mentionTitle(member)}
      data-member-id={mention.memberId}
      className={cn('mx-0.5 rounded-sm px-1 text-[13px]', grey ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')}
    >
      @{member?.displayName ?? mention.name}
    </span>
  );
}
```

- [ ] **Step 4: 正文显示（`components/wiki-text.tsx`）**

导入改为：

```tsx
'use client';

import { splitRichText } from '@flower/core/links';
import Link from 'next/link';
import { Fragment } from 'react';
import { MentionChip } from '@/components/mention-chip';
import { cardFor, cardHref, cardLabel, isGrey, LINK_STATE_NOTE } from '@/features/links/model';
import { useMentionMembers } from '@/lib/queries';
import type { LinkCard } from '@/lib/types';
import { cn } from '@/lib/utils';
```

`WikiText` 改为（`LinkChip` 不变）：

```tsx
/** 纯文本（需求描述、评论）的显示：[[ ]] 渲染为链接卡，@ 渲染为成员标签，其余原样（保留换行）。 */
export function WikiText({
  org,
  text,
  cards,
  productKey,
  productId,
  as: Tag = 'p',
  className,
}: {
  org: string;
  text: string;
  cards: LinkCard[];
  productKey: string;
  /** 正文所在产品：用来取成员的当前姓名与能否看到该产品。 */
  productId: string;
  as?: 'p' | 'span';
  className?: string;
}) {
  const members = useMentionMembers(org, productId);
  return (
    <Tag className={cn('whitespace-pre-wrap break-words', className)}>
      {splitRichText(text).map((s, i) =>
        s.kind === 'text' ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : s.kind === 'link' ? (
          <LinkChip key={i} org={org} card={cardFor(cards, s.link.target, productKey)} target={s.link.target} label={s.link.label} />
        ) : (
          <MentionChip key={i} mention={s.mention} member={members.data ? (members.data.find((m) => m.id === s.mention.memberId) ?? null) : undefined} />
        ),
      )}
    </Tag>
  );
}
```

调用处补上 `productId`：

- `requirements/[key]/page.tsx`：`<WikiText org={org} text={r.description} cards={r.links} productKey={r.productKey} productId={r.productId} className="text-[13px] leading-6" />`
- `requirements/[key]/comments.tsx`：`<WikiText org={org} text={c.body} cards={c.links} productKey={productKey} productId={productId} className="text-[13px] leading-6" />`
- `documents/[key]/comments.tsx` 两处：`productId={doc.productId}`（加在 `productKey={doc.productKey}` 之后）

- [ ] **Step 5: 输入框补全（`components/wikilink-textarea.tsx`）**

整个文件替换为：

```tsx
'use client';

import { type ComponentProps, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { activeWikiQuery, applyCompletion, SUGGESTION_KIND_LABEL } from '@/features/links/model';
import { activeMentionQuery, applyMention, filterMentionMembers, MENTION_NO_ACCESS } from '@/features/mentions/model';
import { useLinkSearch, useMentionMembers } from '@/lib/queries';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 150;

type Props = Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange'> & {
  org: string;
  /** 来源所在产品：[[ 补全按它决定本产品优先与是否带产品前缀；@ 补全按它标出看不到该产品的成员。 */
  productId: string;
  value: string;
  onValueChange: (value: string) => void;
  /** 补全列表的打开状态变化：用于宿主把 Esc 只关掉列表、不关掉外层对话框。 */
  onOpenChange?: (open: boolean) => void;
};

/** 一个补全项：[[ 链接或 @ 成员。 */
type Option = { key: string; kind: string; main: string; mono: boolean; title: string; hint: string | null; apply: () => { value: string; caret: number } };

/**
 * 纯文本输入框加补全：[[ 按编号前缀或标题搜索（防抖 150ms）；@ 按姓名或邮箱在本组织成员里筛选。
 * 上下键选择、回车插入、Esc 关闭；输入法组字时回车不插入。
 */
export function WikilinkTextarea({ org, productId, value, onValueChange, onOpenChange, onKeyDown, onBlur, className, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const wiki = activeWikiQuery(value, caret);
  const mention = wiki ? null : activeMentionQuery(value, caret);
  const start = wiki?.start ?? mention?.start ?? null;
  const open = start !== null && dismissed !== start;
  // 查询变化时回到第一项（渲染期间调整）
  const queryKey = wiki ? `w${wiki.start}:${wiki.query}` : mention ? `m${mention.start}:${mention.query}` : null;
  const [seenQuery, setSeenQuery] = useState<string | null>(null);
  if (queryKey !== seenQuery) {
    setSeenQuery(queryKey);
    setActive(0);
  }

  // [[ 的防抖查询：至少 150ms 不再变化才传给 useLinkSearch；keepPreviousData 让列表在等待期间不闪烁
  const query = wiki?.query ?? null;
  const [debouncedQuery, setDebouncedQuery] = useState(query ?? '');
  useEffect(() => {
    if (query === null) return;
    const timer = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useLinkSearch(org, productId, debouncedQuery, open && wiki !== null);
  const members = useMentionMembers(org, productId);
  const options: Option[] = !open
    ? []
    : wiki
      ? (search.data ?? []).map((s) => ({
          key: `${s.kind}:${s.insert}`,
          kind: SUGGESTION_KIND_LABEL[s.kind],
          main: s.displayKey,
          mono: true,
          title: s.title,
          hint: s.hint,
          apply: () => applyCompletion(value, wiki, caret, s),
        }))
      : mention
        ? filterMentionMembers(members.data ?? [], mention.query).map((m) => ({
            key: m.id,
            kind: '成员',
            main: m.displayName,
            mono: false,
            title: m.email ?? '',
            hint: m.canSeeProduct ? null : MENTION_NO_ACCESS,
            apply: () => applyMention(value, mention, caret, m),
          }))
        : [];
  const index = Math.min(active, Math.max(options.length - 1, 0));
  // 结果是否对应当前输入：[[ 防抖未落定或正在用上一次查询的结果占位时都算未结算，回车不应采用；@ 在本地筛选，成员加载完即结算
  const settled = wiki ? debouncedQuery.trim() === wiki.query.trim() && !search.isPlaceholderData : mention !== null && members.data !== undefined;
  const shown = open && options.length > 0;

  useEffect(() => {
    onOpenChange?.(shown);
  }, [shown, onOpenChange]);

  const pick = (i: number) => {
    const o = options[i];
    if (!o) return;
    const next = o.apply();
    onValueChange(next.value);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari 下确认输入法组字的 Enter：isComposing 已为 false，但 keyCode 仍是 229
    if (open && start !== null && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      if (options.length > 0 && e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((index + 1) % options.length);
        return;
      }
      if (options.length > 0 && e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((index - 1 + options.length) % options.length);
        return;
      }
      if (options.length > 0 && e.key === 'Enter') {
        // 列表还没落定到当前输入时，回车不采用上一次查询留下的结果；继续显示旧列表，不吞掉这次按键之外的副作用
        e.preventDefault();
        if (settled) pick(index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(start);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        {...rest}
        className={className}
        value={value}
        aria-controls={shown ? listId : undefined}
        onChange={(e) => {
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={keyDown}
        onBlur={(e) => {
          if (start !== null) setDismissed(start);
          onBlur?.(e);
        }}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label={wiki ? '链接补全' : '成员补全'}
          aria-busy={!settled}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-[13px] shadow-md"
        >
          {options.map((o, i) => (
            <li
              key={o.key}
              role="option"
              aria-selected={i === index}
              className={cn('flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5', i === index && 'bg-accent')}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{o.kind}</span>
              <span className={cn('shrink-0', o.mono ? 'font-mono' : 'font-medium')}>{o.main}</span>
              <span className={cn('min-w-0 truncate', !o.mono && 'text-muted-foreground')}>{o.title}</span>
              {o.hint && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 运行确认通过**

Run: `pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck && pnpm --filter @flower/web e2e mentions.spec.ts links-autocomplete.spec.ts links.spec.ts documents-anchors.spec.ts`
Expected: 全部 PASS（`[[` 补全与评论的原有用例不受影响）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/mention-chip.tsx apps/web/src/components/wiki-text.tsx apps/web/src/components/wikilink-textarea.tsx "apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/comments.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx" apps/web/e2e/mentions.spec.ts
git commit -m "feat(web): 评论与需求描述的 @ 补全、成员标签（按当前姓名显示，离开后灰色）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 页面：PRD 编辑器里的 @（BlockNote 内联元素）

**Files:**
- Create: `apps/web/src/features/documents/editor/mention.tsx`
- Modify: `apps/web/src/features/documents/editor/prd-editor.tsx`、`apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`、`apps/web/src/app/globals.css`、`apps/web/e2e/mentions.spec.ts`

**Interfaces:**
- Consumes: Task 12 的 `useMentionMembers`、`filterMentionMembers`、`mentionTitle`、`MENTION_NO_ACCESS`；Task 1 的 `cleanMentionName`
- Produces:
  - `mention.tsx`：`MentionMembersContext`、`Mention`（BlockNote 内联元素 `mention`，属性 `memberId`、`name`）、`prdSchema`（默认内联元素加 `mention`）
  - `PrdEditorProps.mentionMembers?: MentionMember[]`：提供时显示当前姓名，可编辑时 `@` 打开成员补全（与 `[[` 共用菜单与回车处理）
  - 编辑器里的成员标签 `.mention-chip`（离开或查不到时加 `.mention-chip-grey`）；Markdown 写法 `[@姓名](member:ID)`

- [ ] **Step 1: 写失败的端到端用例**

`apps/web/e2e/mentions.spec.ts`：导入改为

```ts
import { createDocument, createProduct, createRequirement, json, login, memberRequest, ok, OWNER, presetTemplateId, setupInstance, tick } from './helpers';
```

文件末尾加：

```ts
test('PRD 正文：输入 @ 补全成员并插入成员标签；自动保存后正文为 @ 写法，刷新后仍显示；被 @ 的人收到通知', async ({ page, request }) => {
  const productId = await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  const doc = await createDocument(request, productId, { title: '登录 PRD', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('请 @张');
  await expect(page.getByRole('option', { name: /张三/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(body.locator('.mention-chip')).toHaveText('@张三');
  await expect(body.getByRole('status')).toHaveText('已保存');
  const saved = await json<{ document: { markdown: string } }>(request.get(`/api/v1/orgs/acme/documents/${doc.displayKey}`));
  expect(saved.document.markdown).toContain(`[@张三](member:${zhang.memberId})`);
  await page.reload();
  await expect(page.getByRole('region', { name: '正文' }).locator('.mention-chip')).toHaveText('@张三');
  expect((await tick(request)).notified).toBe(1);
  const list = await json<{ notifications: Array<{ body: string; title: string }> }>(zhang.ctx.get('/api/v1/orgs/acme/notifications'));
  expect(list.notifications.map((n) => [n.body, n.title])).toEqual([['在 PRD 正文中 @ 了你', 'PAN-PRD-1 登录 PRD']]);
  await zhang.ctx.dispose();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @flower/web e2e mentions.spec.ts -g "PRD 正文"`
Expected: FAIL（输入 @ 后没有补全项）。

- [ ] **Step 3: 内联元素（`features/documents/editor/mention.tsx`）**

```tsx
'use client';

import { BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core';
import { createReactInlineContentSpec } from '@blocknote/react';
import { createContext, useContext } from 'react';
import { mentionTitle } from '@/features/mentions/model';
import type { MentionMember } from '@/lib/types';
import { cn } from '@/lib/utils';

const MEMBER_HREF = /^member:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** 编辑器里 @ 显示当前姓名用的成员列表；没有提供时（undefined）按写入时的姓名显示。 */
export const MentionMembersContext = createContext<MentionMember[] | undefined>(undefined);

function MentionView({ memberId, name }: { memberId: string; name: string }) {
  const members = useContext(MentionMembersContext);
  const member = members ? (members.find((m) => m.id === memberId) ?? null) : undefined;
  const grey = member === null || member?.status === 'left';
  return (
    <span className={cn('mention-chip', grey && 'mention-chip-grey')} title={mentionTitle(member)} data-member-id={memberId}>
      @{member?.displayName ?? name}
    </span>
  );
}

/**
 * PRD 正文里的 @ 成员。Markdown 写法为 `[@姓名](member:成员ID)`：导出 HTML 为 member: 链接，
 * BlockNote 的 Markdown 导出得到上面的写法；导入时按 member: 链接识别（BlockNote 的链接只接受 http 等协议，不会抢先解析）。
 */
export const Mention = createReactInlineContentSpec(
  { type: 'mention', propSchema: { memberId: { default: '' }, name: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent }) => <MentionView memberId={inlineContent.props.memberId} name={inlineContent.props.name} />,
    toExternalHTML: ({ inlineContent }) => <a href={`member:${inlineContent.props.memberId}`}>@{inlineContent.props.name}</a>,
    parse: (el) => {
      if (el.tagName !== 'A') return undefined;
      const m = MEMBER_HREF.exec(el.getAttribute('href') ?? '');
      if (!m) return undefined;
      return { memberId: m[1]!.toLowerCase(), name: (el.textContent ?? '').replace(/^@/, '').trim() };
    },
  },
);

/** PRD 编辑器与 Markdown 解析共用的 schema：默认内联元素加上 mention。 */
export const prdSchema = BlockNoteSchema.create({ inlineContentSpecs: { ...defaultInlineContentSpecs, mention: Mention } });
```

`apps/web/src/app/globals.css` 在 `.wikilink-card` 一组样式之后加：

```css
/* PRD 编辑器：@ 成员 */
.mention-chip {
  margin: 0 1px;
  padding: 0 3px;
  border-radius: 2px;
  background: color-mix(in oklab, var(--primary) 10%, transparent);
  color: var(--primary);
}
.mention-chip-grey {
  background: var(--muted);
  color: var(--muted-foreground);
}
```

- [ ] **Step 4: 编辑器（`features/documents/editor/prd-editor.tsx`）**

整个文件替换为：

```tsx
'use client';

import '@blocknote/shadcn/style.css';
import { BlockNoteEditor } from '@blocknote/core';
import { SuggestionMenu } from '@blocknote/core/extensions';
import { zh } from '@blocknote/core/locales';
import { type DefaultReactSuggestionItem, SuggestionMenuController, type SuggestionMenuProps, useComponentsContext, useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { cleanMentionName } from '@flower/core/links';
import { useTheme } from 'next-themes';
import { createContext, type KeyboardEvent, type Ref, type RefObject, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { SUGGESTION_KIND_LABEL } from '@/features/links/model';
import { filterMentionMembers, MENTION_NO_ACCESS } from '@/features/mentions/model';
import type { LinkSuggestion, MentionMember } from '@/lib/types';
import { type DecorationInput, decorationsKey, flowerDecorations } from './decorations';
import { MentionMembersContext, prdSchema } from './mention';

export type PrdEditorHandle = { getMarkdown: () => string };
export type PrdEditorProps = {
  initialMarkdown: string;
  editable: boolean;
  onDirty?: () => void;
  uploadImage?: (file: File) => Promise<string>;
  /** 正文里的链接卡等显示数据：变化时推给编辑器重画，不改正文。 */
  decorations?: DecorationInput;
  /** 输入 [[ 时的补全搜索；不传时不启用补全。 */
  searchLinks?: (query: string) => Promise<LinkSuggestion[]>;
  /** 本组织成员：@ 显示当前姓名；可编辑时输入 @ 弹出成员补全。不传时不启用 @ 补全。 */
  mentionMembers?: MentionMember[];
  ref?: Ref<PrdEditorHandle>;
};

const TRIGGER = '[[';
const MENTION_TRIGGER = '@';
const DEBOUNCE_MS = 150;

/** 补全条目：带着它所属的查询，回车时据此判断列表是否已落定到当前输入。 */
type LinkItem = DefaultReactSuggestionItem & { query: string };
/** 补全菜单当前显示的内容：回车由编辑器自己的按键处理按它选条目。 */
type MenuShown = Pick<SuggestionMenuProps<LinkItem>, 'items' | 'selectedIndex' | 'onItemClick'>;
const MenuShownContext = createContext<RefObject<MenuShown | null> | null>(null);

/** [[ 与 @ 的补全菜单：显示方式与 BlockNote 默认菜单相同，另把显示中的条目与选中项记下来。 */
function LinkSuggestionMenu({ items, loadingState, selectedIndex, onItemClick }: SuggestionMenuProps<LinkItem>) {
  const Components = useComponentsContext()!;
  const shownRef = useContext(MenuShownContext);
  // layout 阶段记录：与屏幕上的列表同步更新，按键处理读到的就是用户看到的条目
  useLayoutEffect(() => {
    if (!shownRef) return;
    shownRef.current = { items, selectedIndex, onItemClick };
    return () => {
      shownRef.current = null;
    };
  });
  return (
    <Components.SuggestionMenu.Root id="bn-suggestion-menu" className="bn-suggestion-menu">
      {items.flatMap((item, i) => [
        ...(item.group !== items[i - 1]?.group
          ? [
              <Components.SuggestionMenu.Label key={`group:${item.group}`} className="bn-suggestion-menu-label">
                {item.group}
              </Components.SuggestionMenu.Label>,
            ]
          : []),
        <Components.SuggestionMenu.Item
          key={`${i}:${item.title}`}
          id={`bn-suggestion-menu-item-${i}`}
          className="bn-suggestion-menu-item"
          item={item}
          isSelected={i === selectedIndex}
          onClick={() => onItemClick?.(item)}
        />,
      ])}
      {items.length === 0 && loadingState !== 'loading-initial' && <Components.SuggestionMenu.EmptyItem className="bn-suggestion-menu-item">无匹配项</Components.SuggestionMenu.EmptyItem>}
      {loadingState !== 'loaded' && <Components.SuggestionMenu.Loader className="bn-suggestion-menu-loader" />}
    </Components.SuggestionMenu.Root>
  );
}

/** Markdown → 块：用一个不挂载、带 mention 的编辑器实例解析，只在首次渲染时调用。空正文返回 undefined（BlockNote 要求初始内容非空）。 */
function parseMarkdown(markdown: string) {
  if (!markdown.trim()) return undefined;
  const blocks = BlockNoteEditor.create({ schema: prdSchema }).tryParseMarkdownToBlocks(markdown);
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * 一篇 PRD 正文的 BlockNote 编辑器。Markdown 是唯一数据源：挂载时解析一次，之后由父组件
 * 通过 ref 的 getMarkdown() 在需要保存时序列化；正文被外部替换（冲突后重新加载、恢复版本）时由父组件换 key 重新挂载。
 * [[ ]] 在正文里是普通文字，链接卡由装饰插件显示；@ 成员是内联元素（mention.tsx）。
 */
export function PrdEditor({ initialMarkdown, editable, onDirty, uploadImage, decorations, searchLinks, mentionMembers, ref }: PrdEditorProps) {
  const [initialContent] = useState(() => parseMarkdown(initialMarkdown));
  const [extensions] = useState(() => [flowerDecorations()]);
  const editor = useCreateBlockNote({ schema: prdSchema, initialContent, dictionary: zh, uploadFile: uploadImage, extensions });
  useImperativeHandle(ref, () => ({ getMarkdown: () => editor.blocksToMarkdownLossy(editor.document) }), [editor]);
  // 只带元数据的事务：不改文档，不触发 onChange，因此不会引起自动保存
  useEffect(() => {
    if (!decorations) return;
    editor.transact((tr) => {
      tr.setMeta(decorationsKey, decorations);
    });
  }, [editor, decorations]);

  // 每次查询变化 BlockNote 都会调用 getItems；查询 150ms 内又变了的不发请求（它的结果 BlockNote 也会丢弃）
  const latestCall = useRef(0);
  const getItems = useCallback(
    async (query: string): Promise<LinkItem[]> => {
      if (!searchLinks) return [];
      const call = ++latestCall.current;
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
      if (call !== latestCall.current) return [];
      const list = await searchLinks(query).catch(() => []);
      return list.map((s) => ({
        query,
        title: `${s.displayKey} ${s.title}`.trim(),
        subtext: s.hint ?? undefined,
        group: SUGGESTION_KIND_LABEL[s.kind],
        onItemClick: () => {
          if (s.next === 'sections') {
            // 选中 PRD：重新打开补全并写入「编号#」，接着列出它的小节
            editor.getExtension(SuggestionMenu)?.openSuggestionMenu(TRIGGER, { deleteTriggerCharacter: true });
            editor.insertInlineContent(`${s.insert}#`, { updateSelection: true });
          } else {
            editor.insertInlineContent(`[[${s.insert}]]`, { updateSelection: true });
          }
        },
      }));
    },
    [editor, searchLinks],
  );

  // @ 补全：在本组织成员里本地筛选，不发请求；选中后插入成员标签和一个空格
  const getMentionItems = useCallback(
    async (query: string): Promise<LinkItem[]> =>
      filterMentionMembers(mentionMembers ?? [], query).map((m) => ({
        query,
        title: m.displayName,
        subtext: m.canSeeProduct ? (m.email ?? undefined) : MENTION_NO_ACCESS,
        group: '成员',
        onItemClick: () => {
          editor.insertInlineContent([{ type: 'mention', props: { memberId: m.id, name: cleanMentionName(m.displayName) } }, ' '], { updateSelection: true });
        },
      })),
    [editor, mentionMembers],
  );

  // 补全菜单打开时的回车由这里处理，拦在 BlockNote 自己的菜单按键处理（挂在内层编辑区的捕获阶段）之前：
  // BlockNote 在新查询的结果返回前仍用上一次查询的条目响应回车，且不识别 Safari 确认组字时的回车。
  const menuShown = useRef<MenuShown | null>(null);
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    const menu = editor.getExtension(SuggestionMenu)?.store.state;
    if (!menu?.show || (menu.triggerCharacter !== TRIGGER && menu.triggerCharacter !== MENTION_TRIGGER)) return;
    e.stopPropagation();
    // 输入法组字时的回车用于上屏，不选条目；Safari 确认组字时 isComposing 已为 false，但 keyCode 仍是 229
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const shown = menuShown.current;
    const item = shown && shown.selectedIndex !== undefined ? shown.items[shown.selectedIndex] : undefined;
    // 列表还没落定到当前输入（防抖未到或请求在途，显示的是上一次查询的结果）时，回车不采用
    if (item && item.query === menu.query) shown?.onItemClick?.(item);
  };

  const { resolvedTheme } = useTheme();
  return (
    <MentionMembersContext value={mentionMembers}>
      <BlockNoteView editor={editor} editable={editable} onChange={() => onDirty?.()} theme={resolvedTheme === 'dark' ? 'dark' : 'light'} onKeyDownCapture={onKeyDownCapture}>
        {editable && searchLinks && (
          <MenuShownContext value={menuShown}>
            <SuggestionMenuController triggerCharacter={TRIGGER} getItems={getItems} suggestionMenuComponent={LinkSuggestionMenu} />
          </MenuShownContext>
        )}
        {editable && mentionMembers && (
          <MenuShownContext value={menuShown}>
            <SuggestionMenuController triggerCharacter={MENTION_TRIGGER} getItems={getMentionItems} suggestionMenuComponent={LinkSuggestionMenu} />
          </MenuShownContext>
        )}
      </BlockNoteView>
    </MentionMembersContext>
  );
}
```

- [ ] **Step 5: 编辑器面板传入成员（`documents/[key]/editor-pane.tsx`）**

`@/lib/queries` 的导入加 `useMentionMembers`；在 `const comments = useDocumentComments(org, doc.id);` 之后加：

```tsx
  const mentionMembers = useMentionMembers(org, doc.productId);
```

`<DocumentBodyEditor … />` 加一个属性 `mentionMembers={mentionMembers.data}`（放在 `searchLinks` 之后）。

- [ ] **Step 6: 运行确认通过**

Run: `pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck && pnpm --filter @flower/web e2e mentions.spec.ts documents-links.spec.ts documents-editor.spec.ts documents-anchors.spec.ts documents-import.spec.ts`
Expected: 全部 PASS（`[[` 补全、划词评论与导入不受影响）。如果「正文为 @ 写法」一步失败（BlockNote 导出的 Markdown 与 `[@姓名](member:ID)` 不同），停下来报告实际导出的写法，不要改动服务端的解析规则。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/documents/editor/mention.tsx apps/web/src/features/documents/editor/prd-editor.tsx "apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx" apps/web/src/app/globals.css apps/web/e2e/mentions.spec.ts
git commit -m "feat(web): PRD 编辑器的 @ 成员（BlockNote 内联元素，Markdown 写法与评论一致）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: 页面：需求与 PRD 的关注按钮，打开详情时标为已读

**Files:**
- Create: `apps/web/src/components/follow-button.tsx`、`apps/web/src/features/member-notifications/use-mark-read.ts`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`、`apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`、`apps/web/src/app/(app)/[org]/tasks/[key]/page.tsx`、`apps/web/e2e/member-notifications.spec.ts`

**Interfaces:**
- Consumes: Task 12 的 `useSubscription`、`qk.subscription`、`inboxKeys`；Task 11 的 `PUT /subscriptions/:type/:id`、`POST /notifications/read-subject`
- Produces:
  - `FollowButton({ org, type: 'requirement' | 'document', id })`：未关注时按钮「关注」，已关注时「已关注」（`aria-pressed`，`title` 为关注原因），点击切换
  - `useMarkNotificationsRead(org, subjectType: 'requirement' | 'document' | 'task', subjectId: string | undefined): void`

- [ ] **Step 1: 写失败的端到端用例**

`apps/web/e2e/member-notifications.spec.ts`：导入改为

```ts
import { createDocument, createProduct, createRequirement, expectNoPageOverflow, json, login, memberRequest, ok, OWNER, setupInstance, tick } from './helpers';
```

文件末尾加：

```ts
test('关注按钮：手动关注后收到别人的评论；打开详情时通知标为已读；取消关注后不再收到；PRD 详情也有关注按钮', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录页改版');
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  await page.getByRole('button', { name: '关注', exact: true }).click();
  await expect(page.getByRole('button', { name: '已关注' })).toHaveAttribute('title', '你手动关注了');

  await ok(zhang.ctx.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: '我来看看' } }));
  await tick(request);
  const mine = () => json<{ notifications: Array<{ body: string; readAt: string | null }> }>(request.get('/api/v1/orgs/acme/notifications'));
  expect((await mine()).notifications.map((n) => n.body)).toEqual(['发表了评论：我来看看']);
  await page.reload();
  await expect(page.getByRole('button', { name: '已关注' })).toBeVisible();
  await expect.poll(async () => (await mine()).notifications[0]!.readAt).not.toBeNull();

  await page.getByRole('button', { name: '已关注' }).click();
  await expect(page.getByRole('button', { name: '关注', exact: true })).toBeVisible();
  await ok(zhang.ctx.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: '第二条' } }));
  await tick(request);
  expect((await mine()).notifications).toHaveLength(1);

  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('button', { name: '关注', exact: true }).click();
  await expect(page.getByRole('button', { name: '已关注' })).toBeVisible();
  await zhang.ctx.dispose();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @flower/web e2e member-notifications.spec.ts -g "关注按钮"`
Expected: FAIL（找不到「关注」按钮）。

- [ ] **Step 3: 关注按钮（`components/follow-button.tsx`）**

```tsx
'use client';

import { BellOff, BellPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { qk, useApiMutation, useSubscription } from '@/lib/queries';
import type { Subscription } from '@/lib/types';

/** 需求、PRD 详情的关注按钮：已关注时悬停说明原因，再点取消关注。 */
export function FollowButton({ org, type, id }: { org: string; type: 'requirement' | 'document'; id: string }) {
  const q = useSubscription(org, type, id);
  const toggle = useApiMutation((following: boolean) => api<{ subscription: Subscription }>(`/orgs/${org}/subscriptions/${type}/${id}`, { method: 'PUT', body: { following } }), {
    invalidate: [qk.subscription(org, type, id)],
  });
  if (!q.data) return null;
  const s = q.data;
  return (
    <Button
      variant={s.following ? 'secondary' : 'outline'}
      size="sm"
      aria-pressed={s.following}
      title={s.following ? (s.reason ?? '已关注') : '关注后，状态、优先级、迭代变化与新评论会通知你'}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!s.following)}
    >
      {s.following ? <BellOff className="size-4" aria-hidden="true" /> : <BellPlus className="size-4" aria-hidden="true" />}
      {s.following ? '已关注' : '关注'}
    </Button>
  );
}
```

- [ ] **Step 4: 打开详情时标为已读（`features/member-notifications/use-mark-read.ts`）**

```ts
'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api';
import { inboxKeys, useApiMutation } from '@/lib/queries';

/** 打开需求、PRD 或任务详情时，把本人与它相关的未读通知标为已读（失败不提示）。subjectId 为空（还在加载）时不调用。 */
export function useMarkNotificationsRead(org: string, subjectType: 'requirement' | 'document' | 'task', subjectId: string | undefined): void {
  const read = useApiMutation((id: string) => api(`/orgs/${org}/notifications/read-subject`, { method: 'POST', body: { subjectType, subjectId: id } }), {
    invalidate: [inboxKeys(org)],
    silentError: true,
  });
  const mutate = read.mutate;
  useEffect(() => {
    if (subjectId) mutate(subjectId);
  }, [subjectId, mutate]);
}
```

- [ ] **Step 5: 接到三个详情页**

`requirements/[key]/page.tsx`：导入加 `import { FollowButton } from '@/components/follow-button';`、`import { useMarkNotificationsRead } from '@/features/member-notifications/use-mark-read';`；在 `const r = q.data;` 之后加 `useMarkNotificationsRead(org, 'requirement', r?.id);`；`<PageHeader` 加属性 `actions={<FollowButton org={org} type="requirement" id={r.id} />}`。

`documents/[key]/page.tsx`：同样两个导入；在 `const d = q.data;` 之后加 `useMarkNotificationsRead(org, 'document', d?.id);`；`<PageHeader` 加属性 `actions={<FollowButton org={org} type="document" id={d.id} />}`。

`tasks/[key]/page.tsx`：导入加 `import { useMarkNotificationsRead } from '@/features/member-notifications/use-mark-read';`；在 `const q = useTask(org, decodeURIComponent(key));` 之后加 `useMarkNotificationsRead(org, 'task', q.data?.id);`。

- [ ] **Step 6: 运行确认通过**

Run: `pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck && pnpm --filter @flower/web e2e member-notifications.spec.ts requirements.spec.ts documents.spec.ts tasks.spec.ts`
Expected: 全部 PASS（铃铛用例里点通知跳到需求详情后，详情页同时把该需求的通知标为已读，未读数仍为 1：另一条在 PAN-2 上）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/follow-button.tsx apps/web/src/features/member-notifications/use-mark-read.ts "apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/page.tsx" "apps/web/src/app/(app)/[org]/tasks/[key]/page.tsx" apps/web/e2e/member-notifications.spec.ts
git commit -m "feat(web): 需求与 PRD 详情的关注按钮（悬停说明原因），打开详情时相关通知标为已读

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: 页面：个人设置的通知偏好与企业微信绑定

**Files:**
- Create: `apps/web/src/app/(app)/settings/notifications-section.tsx`、`apps/web/e2e/notification-settings.spec.ts`
- Modify: `apps/web/src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: Task 12 的 `useNotificationSettings`、`qk.notificationSettings`、`prefCell`；Task 11 的 `PUT /me/notification-prefs/:kind`、`POST /me/wecom/bind`、`DELETE /me/wecom`；回调重定向的查询参数 `org`、`wecom=bound`、`wecom_error`
- Produces:
  - `PersonalNotifications({ org })`：偏好表（每格一个开关，名称「类型 · 渠道」，如「被指派 · 企业微信」），不可用时置灰并在表下说明原因；企业微信账号、「绑定企业微信」（未开启扫码时不可用并说明）与「解除绑定」
  - 个人设置页新增「通知」一节（`region`「通知」），可选组织（默认取地址栏 `org`），显示扫码回调的结果（成功 `status`，失败 `alert`）

- [ ] **Step 1: 写失败的端到端用例**

新建 `apps/web/e2e/notification-settings.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, createWecomChannel, expectNoPageOverflow, login, memberRequest, ok, setupInstance, tick } from './helpers';

test('个人设置：按类保存偏好并生效；企业微信列在未绑定时置灰并说明；扫码未开启时不可用；回调结果；解除绑定；760 不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  const productId = await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  await login(page, 'zhang@example.com', 'password123');
  await page.goto('/settings');
  const section = page.getByRole('region', { name: '通知' });
  await expect(section.getByRole('switch', { name: '被指派 · 站内' })).toBeChecked();
  await expect(section.getByRole('switch', { name: '被指派 · 企业微信' })).toBeDisabled();
  await expect(section.getByText('企业微信：还没有绑定企业微信')).toBeVisible();
  await expect(section.getByText('邮件：组织还没有指定个人通知邮件通道')).toBeVisible();
  await expect(section.getByRole('switch', { name: '系统告警 · 站内' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: '绑定企业微信' })).toBeDisabled();

  await section.getByRole('switch', { name: '被指派 · 站内' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(section.getByRole('switch', { name: '被指派 · 站内' })).not.toBeChecked();
  const req = await createRequirement(request, productId, '登录页改版');
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${req.id}`, { data: { ownerMemberId: zhang.memberId } }));
  expect((await tick(request)).notified).toBe(0);

  // 组织管理员填写企业微信账号、产品指定个人提醒通道后，企业微信一列可以修改
  await ok(request.put(`/api/v1/orgs/acme/members/${zhang.memberId}/wecom`, { data: { userid: 'zhangsan' } }));
  const channelId = await createWecomChannel(request, '研发群', 'http://127.0.0.1:9/cgi-bin/webhook/send?key=settings-0001');
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/personal-channel`, { data: { channelId } }));
  await page.reload();
  await expect(section.getByRole('switch', { name: '被指派 · 企业微信' })).toBeEnabled();
  await expect(section.getByText('zhangsan')).toBeVisible();

  await page.goto(`/settings?org=acme&wecom_error=${encodeURIComponent('绑定链接已过期（10 分钟内有效），请重新扫码')}`);
  await expect(page.getByRole('alert')).toHaveText('企业微信绑定失败：绑定链接已过期（10 分钟内有效），请重新扫码');
  await page.goto('/settings?org=acme&wecom=bound');
  await expect(section.getByRole('status')).toHaveText('企业微信绑定成功。');

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(section.getByRole('switch', { name: '被指派 · 站内' })).toBeVisible();
  await expectNoPageOverflow(page);

  await section.getByRole('button', { name: '解除绑定' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '解除绑定' }).click();
  await expect(section.getByText('企业微信账号：未绑定')).toBeVisible();
  await zhang.ctx.dispose();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @flower/web e2e notification-settings.spec.ts`
Expected: FAIL（没有「通知」一节）。

- [ ] **Step 3: 通知一节（`app/(app)/settings/notifications-section.tsx`）**

```tsx
'use client';

import {
  MEMBER_NOTIFICATION_KIND_LABELS,
  type MemberNotificationKind,
  NOTIFICATION_PREF_CHANNEL_LABELS,
  type NotificationPref,
  type NotificationPrefChannel,
} from '@flower/core/notifications';
import { ConfirmAction } from '@/components/confirm-action';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { prefCell } from '@/features/member-notifications/model';
import { api } from '@/lib/api';
import { qk, useApiMutation, useNotificationSettings } from '@/lib/queries';

const CHANNELS: NotificationPrefChannel[] = ['inApp', 'wecom', 'email'];

/** 个人设置里某个组织的通知：偏好表（行为通知类型，列为站内、企业微信、邮件）与企业微信绑定。 */
export function PersonalNotifications({ org }: { org: string }) {
  const q = useNotificationSettings(org);
  const save = useApiMutation(
    (v: { kind: MemberNotificationKind; pref: NotificationPref }) => api(`/orgs/${org}/me/notification-prefs/${v.kind}`, { method: 'PUT', body: v.pref }),
    { invalidate: [qk.notificationSettings(org)], success: '已保存' },
  );
  const bind = useApiMutation(() => api<{ url: string }>(`/orgs/${org}/me/wecom/bind`, { method: 'POST' }), {
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const unbind = useApiMutation(() => api(`/orgs/${org}/me/wecom`, { method: 'DELETE' }), { invalidate: [qk.notificationSettings(org)], success: '已解除企业微信绑定' });
  if (q.isError) return <LoadError message="加载通知设置失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  const s = q.data;
  const cells = { inApp: prefCell(s, 'inApp'), wecom: prefCell(s, 'wecom'), email: prefCell(s, 'email') };
  const notes = (['wecom', 'email'] as const).flatMap((c) => (cells[c].reason ? [`${NOTIFICATION_PREF_CHANNEL_LABELS[c]}：${cells[c].reason}`] : []));
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>通知类型</TableHead>
              {CHANNELS.map((c) => (
                <TableHead key={c} className="w-24 text-center">
                  {NOTIFICATION_PREF_CHANNEL_LABELS[c]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.prefs.map((p) => (
              <TableRow key={p.kind} className="h-10 even:bg-zebra">
                <TableCell>{MEMBER_NOTIFICATION_KIND_LABELS[p.kind]}</TableCell>
                {CHANNELS.map((c) => (
                  <TableCell key={c} className="text-center">
                    <Switch
                      aria-label={`${MEMBER_NOTIFICATION_KIND_LABELS[p.kind]} · ${NOTIFICATION_PREF_CHANNEL_LABELS[c]}`}
                      checked={p[c]}
                      disabled={cells[c].disabled || save.isPending}
                      onCheckedChange={(v) => {
                        const pref: NotificationPref = { inApp: p.inApp, wecom: p.wecom, email: p.email };
                        pref[c] = v;
                        save.mutate({ kind: p.kind, pref });
                      }}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {notes.map((n) => (
        <p key={n} className="text-[13px] text-muted-foreground">
          {n}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
        <span className="text-[13px]">
          企业微信账号：{s.wecom.userid ? <span className="font-mono">{s.wecom.userid}</span> : '未绑定'}
        </span>
        {s.wecom.userid ? (
          <ConfirmAction
            trigger={
              <Button variant="outline" size="sm">
                解除绑定
              </Button>
            }
            title="解除企业微信绑定？"
            description="解除后，群里的个人提醒不再 @ 到你；站内通知不受影响。"
            confirmLabel="解除绑定"
            destructive
            onConfirm={() => unbind.mutate(undefined)}
          />
        ) : (
          <Button size="sm" disabled={!s.wecom.bindEnabled || bind.isPending} onClick={() => bind.mutate(undefined)}>
            绑定企业微信
          </Button>
        )}
        {!s.wecom.userid && !s.wecom.bindEnabled && (
          <span className="text-[12px] text-muted-foreground">组织还没有开启扫码绑定，可以请组织管理员在「成员」里填写你的企业微信账号。</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 个人设置页（`app/(app)/settings/page.tsx`）**

导入改为（新增 `Suspense`、`useSearchParams`、`PersonalNotifications`）：

```tsx
import { useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Suspense, useState } from 'react';
```

```tsx
import { PersonalNotifications } from './notifications-section';
```

把 `export default function PersonalSettingsPage()` 改名为 `function PersonalSettings()`，文件末尾加：

```tsx
export default function PersonalSettingsPage() {
  return (
    <Suspense>
      <PersonalSettings />
    </Suspense>
  );
}
```

`PersonalSettings` 里：`const [org, setOrg] = useState<string>('');` 之后加

```tsx
  const params = useSearchParams();
  const [noticeOrg, setNoticeOrg] = useState<string>('');
```

渲染期间同步的块改为：

```tsx
  if (me.data && me.data !== synced) {
    setSynced(me.data);
    setName(me.data.account.name);
    setOrg(org || me.data.orgs[0]?.slug || '');
    // 扫码绑定回调带回 ?org=：通知一节默认打开那个组织
    const wanted = params.get('org');
    setNoticeOrg(noticeOrg || (wanted && me.data.orgs.some((o) => o.slug === wanted) ? wanted : me.data.orgs[0]?.slug) || '');
  }
```

在「修改密码」表单之后、「个人 Token」一节之前加：

```tsx
      {me.data.orgs.length > 0 && (
        <section aria-labelledby="notify-title" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <h2 id="notify-title" className="flex-1 font-semibold">
              通知
            </h2>
            <Select value={noticeOrg} onValueChange={setNoticeOrg}>
              <SelectTrigger className="w-48" aria-label="通知设置所属组织">
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
          {params.get('wecom') === 'bound' && (
            <p role="status" className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
              企业微信绑定成功。
            </p>
          )}
          {params.get('wecom_error') && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              企业微信绑定失败：{params.get('wecom_error')}
            </p>
          )}
          <p className="text-[13px] text-muted-foreground">通知偏好按组织分别设置。站内通知在顶栏铃铛里查看；企业微信提醒发到产品的个人提醒群并 @ 到你。</p>
          {noticeOrg && <PersonalNotifications key={noticeOrg} org={noticeOrg} />}
        </section>
      )}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck && pnpm --filter @flower/web e2e notification-settings.spec.ts settings.spec.ts`
Expected: 全部 PASS（`settings.spec.ts` 确认个人设置原有的资料、主题、密码与 Token 不受影响）。

- [ ] **Step 6: 提交**

```bash
git add "apps/web/src/app/(app)/settings/page.tsx" "apps/web/src/app/(app)/settings/notifications-section.tsx" apps/web/e2e/notification-settings.spec.ts
git commit -m "feat(web): 个人设置的通知偏好（按组织）与企业微信扫码绑定、解除，显示回调结果

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: 页面：组织设置（成员企业微信账号与导入、企业微信应用、个人通知邮件通道）与产品个人提醒通道

**Files:**
- Create: `apps/web/src/app/(app)/[org]/settings/members/wecom-dialog.tsx`、`apps/web/src/app/(app)/[org]/settings/members/wecom-import-dialog.tsx`、`apps/web/src/app/(app)/[org]/settings/notifications/wecom-app-tab.tsx`、`apps/web/src/app/(app)/[org]/settings/notifications/personal-email-channel.tsx`、`apps/web/e2e/wecom-settings.spec.ts`
- Modify: `apps/web/src/app/(app)/[org]/settings/members/page.tsx`、`apps/web/src/app/(app)/[org]/settings/notifications/page.tsx`、`apps/web/src/app/(app)/[org]/settings/products/[productId]/notifications-tab.tsx`

**Interfaces:**
- Consumes: Task 12 的 `useWecomApp`、`usePersonalEmailChannel`、`usePersonalChannel`、`useNotificationChannels`、`useProductChannels`、`qk.*`、`WecomImportResult`、`WecomImportRow`；Task 11 的接口
- Produces:
  - 成员页：表格新增「企业微信账号」列与每行「修改」按钮（名称「修改{姓名}的企业微信账号」，对话框标题「{姓名}的企业微信账号」）；页头「导入企业微信账号」（对话框：选择 CSV 后预览，表格名称「导入预览」，「确认导入」只在有可匹配的行时可用）
  - 推送页：新页签「企业微信应用」（`?tab=wecom`；字段「企业 ID」「应用 ID（AgentId）」「应用密钥」、开关「允许成员扫码绑定」、复制框「回调地址」「授权回调域」）；「通道」页签下方「个人通知邮件通道」选择
  - 产品设置「推送」页签顶部「个人提醒通道」选择

- [ ] **Step 1: 写失败的端到端用例**

新建 `apps/web/e2e/wecom-settings.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { startFakeWebhook } from '../test/fake-webhook';
import { resetDatabase } from './db';
import { createProduct, createRequirement, createWecomChannel, expectNoPageOverflow, json, login, ok, OWNER, setupInstance, tick } from './helpers';

let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
test.beforeAll(async () => {
  hook = await startFakeWebhook();
});
test.afterAll(async () => {
  await hook.close();
});
test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const placeholder = async (request: Parameters<typeof createProduct>[0], displayName: string, email: string) =>
  (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName, email } }))).member.id;

test('成员页：企业微信账号列（修改、重复提示）与批量导入（预览、确认）；1440 与 760 不横向滚动', async ({ page, request }) => {
  await placeholder(request, '张三', 'zhang@example.com');
  await placeholder(request, '李四', 'li@example.com');
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/members');
  await page.getByRole('button', { name: '修改张三的企业微信账号' }).click();
  const dialog = page.getByRole('dialog', { name: '张三的企业微信账号' });
  await dialog.getByLabel('企业微信账号').fill('zhangsan');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /张三/ })).toContainText('zhangsan');

  await page.getByRole('button', { name: '修改李四的企业微信账号' }).click();
  const dup = page.getByRole('dialog', { name: '李四的企业微信账号' });
  await dup.getByLabel('企业微信账号').fill('zhangsan');
  await dup.getByRole('button', { name: '保存' }).click();
  await expect(dup.getByRole('alert')).toHaveText('该企业微信账号已绑定到 张三');
  await dup.getByRole('button', { name: '取消' }).click();

  await page.getByRole('button', { name: '导入企业微信账号' }).click();
  const imp = page.getByRole('dialog', { name: '导入企业微信账号' });
  await imp.getByLabel('CSV 文件').setInputFiles({
    name: 'wecom.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿邮箱,企业微信账号\r\nli@example.com,lisi\r\nnobody@example.com,x\r\nzhang@example.com,zhangsan\r\n'),
  });
  await expect(imp.getByText('wecom.csv：可匹配 1、无变化 1、找不到成员 1、账号重复 0、格式不对 0')).toBeVisible();
  await expect(imp.getByRole('table', { name: '导入预览' })).toContainText('找不到该邮箱的在职成员');
  await imp.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByText('已写入 1 个成员的企业微信账号')).toBeVisible();
  await expect(page.getByRole('row', { name: /李四/ })).toContainText('lisi');
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 760, height: 900 });
  await expectNoPageOverflow(page);
});

test('推送页：企业微信应用（密钥只显示提示、回调地址）与个人通知邮件通道；产品设置的个人提醒通道生效', async ({ page, request }) => {
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '研发群', hook.url('personal-0001'));
  const mailId = (
    await json<{ channel: { id: string } }>(
      request.post('/api/v1/orgs/acme/notification-channels', {
        data: { kind: 'email', name: '通知邮件', config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
      }),
    )
  ).channel.id;
  await login(page, OWNER.email, OWNER.password);

  await page.goto('/acme/settings/notifications?tab=wecom');
  await page.getByLabel('企业 ID').fill('ww0001');
  await page.getByLabel('应用 ID（AgentId）').fill('1000002');
  await page.getByLabel('应用密钥').fill('app-secret-demo-0001');
  await page.getByRole('switch', { name: '允许成员扫码绑定' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(page.getByLabel('应用密钥')).toHaveValue('');
  await expect(page.getByLabel('应用密钥')).toHaveAttribute('placeholder', '已设置 ****0001，留空表示不变');
  await expect(page.getByLabel('回调地址')).toHaveValue('http://localhost:3100/api/v1/orgs/acme/wecom/callback');
  await expect(page.getByLabel('授权回调域（填到自建应用的网页授权设置里）')).toHaveValue('localhost:3100');
  expect(await page.content()).not.toContain('app-secret-demo-0001');
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 760, height: 900 });
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/acme/settings/notifications');
  await page.getByLabel('个人通知邮件通道').click();
  await page.getByRole('option', { name: '通知邮件' }).click();
  await expect.poll(async () => (await json<{ channelId: string | null }>(request.get('/api/v1/orgs/acme/personal-email-channel'))).channelId).toBe(mailId);

  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '推送' }).click();
  await page.getByLabel('个人提醒通道').click();
  await page.getByRole('option', { name: '研发群' }).click();
  await expect.poll(async () => (await json<{ channelId: string | null }>(request.get(`/api/v1/orgs/acme/products/${productId}/personal-channel`))).channelId).toBe(channelId);

  const zhangId = await placeholder(request, '张三', 'zhang@example.com');
  await ok(request.put(`/api/v1/orgs/acme/members/${zhangId}/wecom`, { data: { userid: 'zhangsan' } }));
  const req = await createRequirement(request, productId, '登录页改版');
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${req.id}`, { data: { ownerMemberId: zhangId } }));
  const before = hook.received.length;
  expect((await tick(request)).sent).toBe(1);
  expect(hook.received.length).toBe(before + 1);
  expect((hook.received.at(-1)!.body as { markdown: { content: string } }).markdown.content).toBe(
    '<@zhangsan> 林澄 把你设为需求负责人：[PAN-1 登录页改版](http://localhost:3100/acme/requirements/PAN-1)',
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @flower/web e2e wecom-settings.spec.ts`
Expected: FAIL（找不到「修改张三的企业微信账号」按钮）。

- [ ] **Step 3: 成员企业微信账号对话框（`settings/members/wecom-dialog.tsx`）**

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
import type { Member } from '@/lib/types';

/** 组织管理员修改一个成员的企业微信账号（userid）；留空表示解除。父组件按成员 id 设 key 挂载。 */
export function WecomUseridDialog({ org, member, onClose }: { org: string; member: Member; onClose: () => void }) {
  const [value, setValue] = useState(member.wecomUserid ?? '');
  const save = useApiMutation(() => api(`/orgs/${org}/members/${member.id}/wecom`, { method: 'PUT', body: { userid: value.trim() || null } }), {
    invalidate: [qk.members(org)],
    success: '已保存',
    silentError: true,
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{member.displayName}的企业微信账号</DialogTitle>
            <DialogDescription>填写企业微信通讯录里的账号（userid），群里的个人提醒会 @ 到本人。留空表示解除。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wecom-userid">企业微信账号</Label>
            <Input id="wecom-userid" value={value} maxLength={64} className="font-mono" onChange={(e) => setValue(e.target.value)} />
          </div>
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={save.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: CSV 导入对话框（`settings/members/wecom-import-dialog.tsx`）**

```tsx
'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { qk, useApiMutation } from '@/lib/queries';
import type { WecomImportResult, WecomImportRow } from '@/lib/types';

const STATUS_LABEL: Record<WecomImportRow['status'], string> = { ok: '可匹配', unchanged: '无变化', not_found: '找不到成员', duplicate: '账号重复', invalid: '格式不对' };

/** 批量导入企业微信账号：选择 CSV（邮箱, 企业微信账号）后先预览，确认后只写入「可匹配」的行。关闭即卸载，状态不保留。 */
export function WecomImportDialog({ org, onClose }: { org: string; onClose: () => void }) {
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const preview = useApiMutation((text: string) => api<{ result: WecomImportResult }>(`/orgs/${org}/wecom-import/preview`, { method: 'POST', body: { csv: text } }), {
    silentError: true,
  });
  const apply = useApiMutation(() => api<{ result: WecomImportResult }>(`/orgs/${org}/wecom-import`, { method: 'POST', body: { csv: csv?.text ?? '' } }), {
    invalidate: [qk.members(org)],
    silentError: true,
    onSuccess: ({ result }) => {
      toast.success(`已写入 ${result.applied} 个成员的企业微信账号`);
      onClose();
    },
  });
  const result = preview.data?.result;
  const c = result?.counts;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入企业微信账号</DialogTitle>
          <DialogDescription>上传两列的 CSV：邮箱, 企业微信账号（可以带表头）。先预览，确认后只写入「可匹配」的行。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wecom-csv">CSV 文件</Label>
          <Input
            id="wecom-csv"
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const text = await file.text();
              setCsv({ name: file.name, text });
              preview.mutate(text);
            }}
          />
        </div>
        <FormError error={preview.error ?? apply.error} />
        {result && c && csv && (
          <>
            <p className="text-[13px]">
              {csv.name}：可匹配 {c.ok}、无变化 {c.unchanged}、找不到成员 {c.not_found}、账号重复 {c.duplicate}、格式不对 {c.invalid}
            </p>
            <div className="max-h-72 overflow-auto rounded-md border">
              <Table aria-label="导入预览">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">行</TableHead>
                    <TableHead>邮箱</TableHead>
                    <TableHead>企业微信账号</TableHead>
                    <TableHead>成员</TableHead>
                    <TableHead>结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((r) => (
                    <TableRow key={r.line} className="h-10 even:bg-zebra">
                      <TableCell className="font-mono">{r.line}</TableCell>
                      <TableCell className="font-mono text-[12px]">{r.email}</TableCell>
                      <TableCell className="font-mono text-[12px]">{r.userid}</TableCell>
                      <TableCell>{r.memberName ?? '—'}</TableCell>
                      <TableCell className={r.status === 'ok' ? undefined : 'text-muted-foreground'}>
                        {STATUS_LABEL[r.status]}
                        {r.note ? `：${r.note}` : ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!c || c.ok === 0 || apply.isPending} onClick={() => apply.mutate(undefined)}>
            确认导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: 成员页（`settings/members/page.tsx`）**

导入加：

```tsx
import { WecomUseridDialog } from './wecom-dialog';
import { WecomImportDialog } from './wecom-import-dialog';
```

`MembersPage` 里 `const [placeholder, setPlaceholder] = useState(false);` 之后加：

```tsx
  const [wecomFor, setWecomFor] = useState<Member | null>(null);
  const [importing, setImporting] = useState(false);
```

页头 `actions` 的第一个按钮之前加：

```tsx
            <Button variant="outline" onClick={() => setImporting(true)}>
              导入企业微信账号
            </Button>
```

表头在「职能」之后加 `<TableHead>企业微信账号</TableHead>`；每行在职能单元格之后加：

```tsx
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <span className={m.wecomUserid ? 'font-mono text-[13px]' : 'text-muted-foreground'}>{m.wecomUserid ?? '—'}</span>
                            {m.kind === 'human' && (
                              <Button variant="ghost" size="sm" className="h-7 px-2" aria-label={`修改${m.displayName}的企业微信账号`} onClick={() => setWecomFor(m)}>
                                修改
                              </Button>
                            )}
                          </div>
                        </TableCell>
```

`<PlaceholderDialog … />` 之后加：

```tsx
      {wecomFor && <WecomUseridDialog key={wecomFor.id} org={org} member={wecomFor} onClose={() => setWecomFor(null)} />}
      {importing && <WecomImportDialog org={org} onClose={() => setImporting(false)} />}
```

- [ ] **Step 6: 企业微信应用页签（`settings/notifications/wecom-app-tab.tsx`）**

```tsx
'use client';

import { useState } from 'react';
import { CopyField } from '@/components/copy-field';
import { FormError } from '@/components/form-error';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { qk, useApiMutation, useWecomApp } from '@/lib/queries';
import type { WecomAppSettings } from '@/lib/types';

function WecomAppForm({ org, settings }: { org: string; settings: WecomAppSettings }) {
  const [v, setV] = useState({ corpId: settings.app?.corpId ?? '', agentId: settings.app?.agentId ?? '', secret: '', bindEnabled: settings.app?.bindEnabled ?? false });
  const save = useApiMutation(
    () =>
      api(`/orgs/${org}/wecom-app`, {
        method: 'PUT',
        body: { corpId: v.corpId, agentId: v.agentId, bindEnabled: v.bindEnabled, ...(v.secret.trim() ? { secret: v.secret.trim() } : {}) },
      }),
    { invalidate: [qk.wecomApp(org)], success: '已保存', silentError: true },
  );
  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <p className="text-[13px] text-muted-foreground">
        企业微信自建应用的网页授权，用于成员在个人设置里扫码绑定企业微信账号。应用密钥加密保存，页面上只显示末 4 位；服务端只访问 qyapi.weixin.qq.com。
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wecom-corp">企业 ID</Label>
        <Input id="wecom-corp" className="font-mono" value={v.corpId} onChange={(e) => setV({ ...v, corpId: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wecom-agent">应用 ID（AgentId）</Label>
        <Input id="wecom-agent" className="font-mono" inputMode="numeric" value={v.agentId} onChange={(e) => setV({ ...v, agentId: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wecom-secret">应用密钥</Label>
        <Input
          id="wecom-secret"
          type="password"
          autoComplete="off"
          className="font-mono"
          placeholder={settings.app ? `已设置 ${settings.app.secretHint}，留空表示不变` : '首次保存必填'}
          value={v.secret}
          onChange={(e) => setV({ ...v, secret: e.target.value })}
        />
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <Switch aria-label="允许成员扫码绑定" checked={v.bindEnabled} onCheckedChange={(b) => setV({ ...v, bindEnabled: b })} />
        允许成员扫码绑定
      </label>
      <CopyField label="回调地址" value={settings.callbackUrl} />
      <CopyField label="授权回调域（填到自建应用的网页授权设置里）" value={settings.callbackDomain} />
      <FormError error={save.error} />
      <Button type="submit" className="self-start" disabled={save.isPending}>
        保存
      </Button>
    </form>
  );
}

/** 组织设置「推送」→「企业微信应用」。保存后按更新时间重新挂载表单，密钥框回到空。 */
export function WecomAppTab({ org }: { org: string }) {
  const q = useWecomApp(org);
  if (q.isError) return <LoadError message="加载企业微信应用失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return <WecomAppForm key={q.data.app?.updatedAt ?? 'new'} org={org} settings={q.data} />;
}
```

- [ ] **Step 7: 个人通知邮件通道（`settings/notifications/personal-email-channel.tsx`）**

```tsx
'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { qk, useApiMutation, useNotificationChannels, usePersonalEmailChannel } from '@/lib/queries';

const NONE = 'none';

/** 组织的个人通知邮件通道：成员在个人设置里开启邮件提醒后，经这个通道发到成员自己的邮箱。 */
export function PersonalEmailChannel({ org }: { org: string }) {
  const channels = useNotificationChannels(org);
  const current = usePersonalEmailChannel(org);
  const save = useApiMutation((channelId: string | null) => api(`/orgs/${org}/personal-email-channel`, { method: 'PUT', body: { channelId } }), {
    invalidate: [qk.personalEmailChannel(org)],
    success: '已保存',
  });
  if (!channels.data || !current.data) return null;
  const options = channels.data.filter((c) => c.kind === 'email' && c.enabled);
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">个人通知邮件通道</span>
        <span className="text-[12px] text-muted-foreground">成员在个人设置里开启邮件提醒后，经这个通道发到成员自己的邮箱。</span>
      </div>
      <Select value={current.data.channelId ?? NONE} onValueChange={(v) => save.mutate(v === NONE ? null : v)}>
        <SelectTrigger className="w-56" aria-label="个人通知邮件通道">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>不发邮件</SelectItem>
          {options.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}
```

- [ ] **Step 8: 推送页加页签与邮件通道（`settings/notifications/page.tsx`）**

导入加：

```tsx
import { PersonalEmailChannel } from './personal-email-channel';
import { WecomAppTab } from './wecom-app-tab';
```

`TABS` 改为 `const TABS = ['channels', 'schedules', 'templates', 'deliveries', 'wecom'];`；`<TabsList>` 末尾加 `<TabsTrigger value="wecom">企业微信应用</TabsTrigger>`；「通道」页签内容改为：

```tsx
        <TabsContent value="channels" className="flex flex-col gap-6">
          <ChannelsTab org={org} />
          <PersonalEmailChannel org={org} />
        </TabsContent>
```

`</Tabs>` 之前加：

```tsx
        <TabsContent value="wecom">
          <WecomAppTab org={org} />
        </TabsContent>
```

页头说明改为「登记群机器人、Webhook 与邮件通道，维护消息模板，查看定时推送与发送记录，配置企业微信扫码绑定。事件规则与个人提醒通道在各产品设置的「推送」页签配置。」

- [ ] **Step 9: 产品个人提醒通道（`settings/products/[productId]/notifications-tab.tsx`）**

导入：`@/components/ui/select` 的 `Select, SelectContent, SelectItem, SelectTrigger, SelectValue`；`@/lib/queries` 的导入加 `qk`、`usePersonalChannel`、`useProductChannels`。在 `RuleList` 之前加：

```tsx
const NO_CHANNEL = 'none';

/** 本产品的个人提醒通道：被 @、被指派等个人通知同时发到这个群并 @ 到本人。只列对本产品可用、已启用的企业微信机器人通道。 */
function PersonalChannelPicker({ org, productId }: { org: string; productId: string }) {
  const channels = useProductChannels(org, productId);
  const current = usePersonalChannel(org, productId);
  const save = useApiMutation((channelId: string | null) => api(`/orgs/${org}/products/${productId}/personal-channel`, { method: 'PUT', body: { channelId } }), {
    invalidate: [qk.personalChannel(org, productId)],
    success: '已保存',
  });
  if (!channels.data || !current.data) return null;
  const options = channels.data.filter((c) => c.kind === 'wecom_robot');
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">个人提醒通道</span>
        <span className="text-[12px] text-muted-foreground">被 @、被指派、等你签字等个人通知同时发到这个群并 @ 到本人；成员需要先绑定企业微信账号。</span>
      </div>
      <Select value={current.data.channelId ?? NO_CHANNEL} onValueChange={(v) => save.mutate(v === NO_CHANNEL ? null : v)}>
        <SelectTrigger className="w-56" aria-label="个人提醒通道">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_CHANNEL}>不发企业微信个人提醒</SelectItem>
          {options.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}
```

`NotificationsTab` 的根元素第一项加 `<PersonalChannelPicker org={org} productId={productId} />`。

- [ ] **Step 10: 运行确认通过**

Run: `pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck && pnpm --filter @flower/web e2e wecom-settings.spec.ts members.spec.ts notify-channels.spec.ts notify-rules-schedules.spec.ts notify-deliveries.spec.ts`
Expected: 全部 PASS（成员页与推送页原有用例不受影响）。

- [ ] **Step 11: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/settings/members" "apps/web/src/app/(app)/[org]/settings/notifications" "apps/web/src/app/(app)/[org]/settings/products/[productId]/notifications-tab.tsx" apps/web/e2e/wecom-settings.spec.ts
git commit -m "feat(web): 成员企业微信账号列与 CSV 导入、企业微信应用页签、个人通知邮件通道、产品个人提醒通道

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: 本地开发库执行迁移与只读核对

**Files:**
- 不改代码。只操作本地开发库（只读查询与 `pnpm db:migrate`）；不读 `.local-data/`，不运行 `pnpm dev`，不连接任何服务器。

**Interfaces:**
- Consumes: Task 2 的迁移 `0017`、`0018`

- [ ] **Step 1: 迁移前只读核对**

```bash
docker exec flower-postgres-1 psql -U flower_admin -d flower -At \
  -c "select count(*) from organizations" \
  -c "select count(*), count(*) filter (where e.type not like 'legacy.%') from domain_events e join organizations o on o.id = e.org_id where o.slug = 'pan123'" \
  -c "select count(*) from requirements r join organizations o on o.id = r.org_id where o.slug = 'pan123' and r.deleted_at is null" \
  -c "select count(*) from pg_tables where schemaname = 'public' and tablename in ('member_notifications', 'member_notification_prefs', 'subscriptions', 'notification_cursors', 'wecom_apps', 'wecom_bind_states')"
```

Expected（2026-10-12 写计划时的数量）：`2`；`4428|21`；`765`；`0`。前三项不同说明开发库在计划之后被使用过，记下实际数量继续（只报数量）；第四项不为 `0` 时停下来报告。

- [ ] **Step 2: 执行迁移并核对**

```bash
pnpm db:migrate
docker exec flower-postgres-1 psql -U flower_admin -d flower -At \
  -c "select count(*) from pg_class where relrowsecurity and relname in ('member_notifications', 'member_notification_prefs', 'subscriptions', 'notification_cursors', 'wecom_apps', 'wecom_bind_states')" \
  -c "select count(*) from pg_policies where tablename in ('member_notifications', 'member_notification_prefs', 'subscriptions', 'notification_cursors', 'wecom_apps', 'wecom_bind_states')" \
  -c "select (select count(*) from notification_cursors) = (select count(*) from organizations where exists (select 1 from domain_events d where d.org_id = organizations.id))" \
  -c "select c.last_event_id = (select d.id from domain_events d where d.org_id = o.id order by d.occurred_at desc, d.id desc limit 1) from notification_cursors c join organizations o on o.id = c.org_id where o.slug = 'pan123'" \
  -c "select (select count(*) from member_notifications) + (select count(*) from subscriptions) + (select count(*) from member_notification_prefs) + (select count(*) from wecom_apps)" \
  -c "select count(*) filter (where wecom_userid is not null) from members" \
  -c "select count(*) filter (where personal_channel_id is not null) from products" \
  -c "select pg_get_constraintdef(oid) like '%personal%' from pg_constraint where conname = 'notification_deliveries_source'" \
  -c "select count(*) from requirements r join organizations o on o.id = r.org_id where o.slug = 'pan123' and r.deleted_at is null"
```

Expected：`pnpm db:migrate` 应用 `0017`、`0018` 并把 `flower_app` 的密码改回 `apps/web/.env.local` 的值；依次输出 `6`、`6`、`t`、`t`、`0`、`0`、`0`、`t`、`765`（最后一项按 Step 1 的实际数量）。第三、四项为 `t` 说明上线时游标已指向每个组织的最新事件，开发服务器启动后不会为历史事件补发通知。

- [ ] **Step 3: 把核对结果交给控制方**

不提交（没有代码改动）。把 Step 1、Step 2 的输出（只有数量与 t/f）交给控制方，写进 Task 20 的验证记录。

---

### Task 20: 全量验证、真实数据界面复验与测试群联调（控制方）、验证记录与交接

**Files:**
- Create: `docs/p3b1-validation.md`
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

Expected: 全部通过（`editor-perf.spec.ts` 在未设置 `EDITOR_BENCH` 时跳过）；记下 core、web、migrate 单测数与 e2e 用例数。`./scripts/smoke.sh` 的镜像默认启动后台循环（库里没有事件游标之后的事件、没有个人提醒通道，不会发送），能正常启动即说明新增的后台处理在 standalone 构建里可用。最后一条把 `flower_app` 密码改回开发值。

- [ ] **Step 2: STOP——控制方在真实数据上复验界面**

执行代理不运行 `pnpm dev`。在这里停下，把复验清单交给控制方。控制方在本地开发库（pan123）上启动开发服务器（后台循环默认开启；推送通道全部停用、没有产品指定个人提醒通道，不会向任何群发送），以 1440px 与 760px 两种宽度逐项检查，确认页面本身不横向滚动，把结论（只写现象与数量，不写姓名、标题、账号）交回：

1. 顶栏铃铛：启动后第一轮不为历史事件生成通知（未读数为 0，「全部 / 未读 / @我」都为空，面板显示「没有通知」）；「查看全部」打开通知页，筛选与空状态正常。
2. 用两个测试账号（A 为所有者，B 为普通成员）：A 在一条测试需求的评论里输入 `@` 补全 B（补全列表能按姓名和邮箱筛选，看不到产品的成员标「看不到这个产品」），发表后显示成员标签，悬停显示邮箱与「未绑定企业微信」；几秒后 B 的铃铛显示 1 条未读，点击跳到该需求并标为已读。
3. A 把 B 设为该需求负责人、在 PRD 正文里 @ B（编辑器里显示成员标签，自动保存后刷新仍在）；B 的通知页按「被指派」「被 @」筛选正确；B 在需求详情点「已关注」显示关注原因，取消后 A 改状态不再通知 B。
4. B 的个人设置「通知」：五类偏好（普通成员四类），企业微信一列置灰并说明「还没有绑定企业微信」，邮件一列说明「组织还没有指定个人通知邮件通道」；关掉「被指派 · 站内」后 A 再指派，B 的铃铛不增加，再打开。
5. 组织设置 → 成员：「企业微信账号」一列与「修改」；「导入企业微信账号」只做预览（用只含测试账号的 CSV，不点确认）。组织设置 → 推送：「企业微信应用」页签显示回调地址与授权回调域（不保存真实密钥）；「通道」页签下方「个人通知邮件通道」为「不发邮件」。产品设置 PAN → 推送：顶部「个人提醒通道」为「不发企业微信个人提醒」。
6. 复验新建的测试需求、PRD、评论保留，在记录中写明编号；复验结束时把 B 的偏好恢复为默认。

- [ ] **Step 3: STOP——测试群联调（每次发送前征得用户确认）**

控制方执行，**每一次发送前都先向用户说明将发送什么、发到哪里，得到明确同意后再操作**：

1. 请用户提供测试群的机器人地址与一个测试成员的企业微信账号（userid）。两者只在对话中传递，不写入任何文件、提交、日志或验证记录（记录里只写 key 末 4 位，账号写「测试成员」）。
2. 组织设置 → 推送 → 登记通道「联调测试群」（企业微信机器人，可用产品 PAN，启用）；产品设置 PAN → 推送 → 个人提醒通道选「联调测试群」。
3. 组织设置 → 成员 → 给测试成员 B **手动填写**用户提供的企业微信账号（不用扫码；扫码要在正式部署、配置备案域名后验证）。
4. **群里 @ 到人**：征得同意后，A 把一条测试需求的负责人设为 B；后台循环在几秒内发送，发送记录里来源为「个人提醒」、状态「已发送」；请用户确认群里收到一条 markdown，且 B 被 @（企业微信里显示为 @姓名 并收到提醒），链接文字为「编号 标题」。如果企微返回错误（发送记录里 `errcode` 不为 0），记下 `errcode` 与 `errmsg`，停下来报告，不重复发送。
5. **合并**（可选，再次征得同意）：A 在同一分钟内对 B 做两件事（评论 @ B、把另一条需求指派给 B），确认群里收到的是一条两行的消息。
6. 结束：产品 PAN 的个人提醒通道改回「不发企业微信个人提醒」，停用「联调测试群」通道，清空测试成员 B 的企业微信账号。记录结论（通过 / 问题与 `errcode`）。

- [ ] **Step 4: 写验证记录**

新建 `docs/p3b1-validation.md`，结构与 `docs/p3a-validation.md` 一致，包含：

1. 迁移：Task 19 的核对结果（六张表 RLS 与策略；游标初始化；pan123 数量不变）。
2. 自动化测试数量（Step 1）。
3. 界面复验结果（Step 2，每项「通过 / 问题与处理 / 未验证」），复验新建对象的编号。
4. 测试群联调（Step 3）：群里 @ 到人、合并各一行结论，通道只写「联调测试群（key 末 4 位）」，账号写「测试成员」；结束时的恢复情况。
5. 人工验收清单（供用户试用）：评论、需求描述、PRD 正文的 @ 补全与成员标签；铃铛与通知页；被指派、关注与取消关注、等我签字；个人通知偏好；成员企业微信账号的手动填写与 CSV 导入；企业微信应用配置；产品个人提醒通道；个人通知邮件通道。
6. 正式部署后要做的事：在企业微信自建应用里配置授权回调域并在推送页填写企业 ID、应用 ID、应用密钥，用真实扫码验证绑定；决定是否为现有的负责人、评论者补自动关注（本计划不补，见计划冲突表）。

- [ ] **Step 5: 更新交接文档与协作日志**

`docs/handoff.md`：

1. 「关键文档」表加三行：`docs/superpowers/specs/2026-10-12-flower-p3b1-member-notifications-design.md`（P3-B1 设计，已确认）、`docs/superpowers/plans/2026-10-12-flower-p3b1-member-notifications.md`（P3-B1 计划）、`docs/p3b1-validation.md`（P3-B1 真实数据验证、测试群联调记录与人工验收清单）。
2. 「当前进度」加一条「P3-B1 站内通知：已完成，待合并」，写清：@ 成员（评论、需求描述、PRD 正文）、五类站内通知（铃铛与通知页）、关注、个人通知偏好、企业微信群里 @ 到人（个人提醒通道）、邮件合并提醒、成员企业微信账号（手动、CSV、扫码绑定待正式部署验证）、系统告警、联调结论。
3. 「下一步」改为：合并 P3-B1；用户按 `docs/p3b1-validation.md` 第 5 节验收并处理第 6 节；规划 P3-B2（数据看板）。

`docs/agent-log.md`「记录」最上面加一条：

```
### 2026-10-XX · 本地 · P3-B1 站内通知、@ 成员、关注、个人通知偏好与企业微信绑定
- 分支 / PR：`feat/p3b1-member-notifications`
- 做了什么：
  - 数据模型：member_notifications、member_notification_prefs、subscriptions、notification_cursors、wecom_apps、wecom_bind_states（均开 RLS）；members.wecom_userid、products.personal_channel_id、organizations.personal_email_channel_id；发送记录新增 kind = personal。游标在迁移时初始化为各组织最新事件。
  - @ 写法 `[@姓名](member:ID)`；评论、需求描述、PRD 正文的事件记下新增的被 @ 成员，新建需求、PRD、任务的事件带负责人。
  - 后台循环按组织游标处理事件（SKIP LOCKED；只处理早于仍在进行中事务开始时间的事件；每条 savepoint；连续失败 3 次跳过）：五类通知、收件人排名与过滤、自动关注；企业微信按产品合并 @ 到本人、邮件按人合并，经 P3-A 发送队列发出；定时推送进入告警时给组织管理员系统告警；已读 90 天清理。
  - 企业微信：成员账号手动填写、CSV 预览与导入；自建应用配置（密钥加密）与扫码绑定（一次性 state，10 分钟过期，只访问 qyapi.weixin.qq.com）。
  - 页面：顶栏铃铛、通知页、@ 补全与成员标签（输入框与 BlockNote）、关注按钮、个人设置的通知偏好与绑定、成员页企业微信账号列与导入、推送页企业微信应用与个人通知邮件通道、产品个人提醒通道。
- 怎么验证的：（Step 1 的测试数；Task 19 的核对；Step 2 的复验结论；Step 3 的联调结论）
- 留给对方：扫码绑定需在正式部署、配置授权回调域后用真实企业微信验证；是否为历史负责人、评论者补自动关注由用户决定。
```

- [ ] **Step 6: 提交**

```bash
git add docs/p3b1-validation.md docs/handoff.md docs/agent-log.md
git commit -m "docs: P3-B1 验证记录、测试群联调、交接进度与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 与设计、代码或数据的冲突

写计划时对照设计、上位文档、代码与只读数据发现的不一致，以及本计划的处理：

| 设计说法或现状 | 实际情况 | 本计划的处理 |
|---|---|---|
| 设计 §3、§5.1：游标记录事件的 `(created_at, id)` | `domain_events` 没有 `created_at`，只有 `occurred_at`，且取值为写入事务的开始时间（`now()`）：长事务提交前，游标可能越过比它晚开始、先提交的事件，事件被永久漏掉 | 游标用 `(occurred_at, id)`，比较全在 SQL 里做（微秒精度）；只处理早于本库其他会话最早事务开始时间（`pg_stat_activity.xact_start`）的事件。其他角色的会话（迁移用的管理员连接）看不到 `xact_start`，不影响：它们写的只有 `legacy.*` 事件。Task 8 有测试 |
| 设计 §3：事件 payload 带 `mentioned_member_ids` | 现有事件 payload 一律驼峰命名（`commentId`、`assignmentId`、`changes`） | 键名用 `mentionedMemberIds`；Task 2 在设计文档 §3 写明 |
| 设计 §3：「评论新建或修改」的事件带被 @ 成员 | 代码里评论只能新建与标记解决，没有修改评论的功能 | 只在 `comment.created` 上记；以后加评论修改时用同一个 `newMentionIds` 比较修改前后 |
| 设计 §3：「PRD 正文保存」的事件带被 @ 成员 | 正文还会因恢复版本、外部转 Flower、合入、功能点改名而变化 | 只在用户保存正文（`document.saved`）时记；其余属于整篇替换或系统写入，不当作新的 @ |
| 设计 §3：游标表「记录最后处理的事件与更新时间」 | §5.1 要求「同一条事件连续失败 3 次后跳过」，需要记下失败的事件与次数 | `notification_cursors` 多两列 `failing_event_id`、`failures` |
| 设计 §4.2：`state` 一次性，校验后作废 | 设计 §3 的新表里没有存放 `state` 的地方 | 新增租户表 `wecom_bind_states`（只存 SHA-256、10 分钟过期、开 RLS），回调时先作废再换取；与登录会话一样属于认证过程，不记领域事件 |
| 设计 §5.2：同一事件同一人按「被 @ > 被指派 > 关注对象变化」取一种 | PRD 进入评审会同时产生「关注对象变化」（关注者）与「等我签字」（签字人），设计没有给出两者的先后 | 排名为 被 @ > 被指派 > 等我签字 > 关注对象变化；系统告警没有事件，不参与 |
| 设计 §5.2：「检查项进入待签字」 | 没有对应的领域事件；需求的会签检查项在评审开始（任一需求检查项离开默认状态）后才算待签字，PRD 在进入评审时 | 需求：`check_item.updated` / `check_item.signed` 使评审由未开始变为开始时，给等签字的人发；PRD：状态变为「评审中」时发。之后新增分配、换签字人不再补发（工作台仍然实时显示） |
| 设计 §5.3：「来源标「个人提醒」」 | P3-A 发送记录的 `kind` 只有规则、定时推送、测试，并有来源约束 | 新增 `kind = personal`（规则与定时推送都为空），约束同步修改；发送记录页的来源筛选自动多出「个人提醒」 |
| 设计 §5.3：邮件「收件地址为成员邮箱」 | P3-A 邮件通道的收件人写在通道配置里 | 邮件请求体增加可选 `to`，覆盖通道配置里的收件人；只有个人提醒使用 |
| 设计 §3：个人提醒通道「只能是对本产品可用、已启用的企微通道」 | 通道之后可能被停用、收窄可用产品或删除；P3-A 删除通道前不检查产品与组织的引用 | 外键 `on delete set null`；分发时重新检查（停用或不再允许本产品使用时不发企微，站内照常）；发送时 `personal` 记录不再按可用产品放弃 |
| 设计 §6：「个人设置：通知偏好表；企业微信绑定」 | 现有个人设置页 `/settings` 是账号级的，偏好与企业微信账号按组织成员保存 | 个人设置新增「通知」一节，带组织选择（与「个人 Token」一节相同的做法）；扫码回调跳回 `/settings?org=…` |
| 设计 §6：企微列在「产品未指定个人提醒通道时置灰」 | 一个人可能看到多个产品，只有部分产品指定了通道 | 只有当他能看到的产品都没有指定通道时才置灰；部分产品指定时可以开启，没有通道的产品不发企微 |
| 设计 §2：负责、被分配、评论过、被 @ 的需求与 PRD 自动关注 | 自动关注在处理事件时补上；上线时游标从最新事件开始 | 上线前已有的负责人、评论者不补关注（与「不为历史事件补发通知」一致），可以手动关注；验证记录第 6 节请用户决定是否补 |
| 设计 §4.1：BlockNote 内联元素 | `[[ ]]` 在编辑器里是普通文字加装饰；BlockNote 的链接只接受 http 等协议，`member:` 链接会被丢掉 | 新增 BlockNote 自定义内联元素 `mention`，导出、导入都用 `member:` 链接；Markdown 写法与评论相同。已知限制：划词评论选中的文字里含 @ 时，按正文 Markdown 定位不到原文 |
| 设计 §4.1：补全按姓名或邮箱匹配 | 访客不能查看成员列表（`listMembers` 拒绝访客） | 候选成员接口对能看到该产品的人开放，访客调用时不返回邮箱 |
| P3-A 接口测试 `notify-tick.test.ts` 断言新组织第一轮 `orgs: 0` | 新组织有事件、没有游标行，第一轮会处理这些事件 | 断言改为 `toMatchObject`，`orgs` 为 1、`events` 大于 0 |
| 设计 §4.2：服务端只访问 `qyapi.weixin.qq.com` | 扫码页在 `login.work.weixin.qq.com` | 扫码页只由浏览器跳转打开，服务端不访问；服务端的基础地址为常量，只有测试注入本机假服务 |

## P3-B1 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm --filter @flower/web e2e`、`./scripts/smoke.sh` 全部通过。
- 设计 §7 列出的验证都有对应测试：@ 解析与新增比对（Task 1、3）；收件人规则与去重（Task 8）；偏好默认值（Task 1、5）；游标只处理一次（并发两实例，Task 9）；失败重试与跳过（Task 8）；企微合并与分条（Task 9）；扫码绑定回调（模拟企业微信接口，含 `state` 校验失败、账号重复，Task 7、11）；批量导入预览（Task 6、11）；接口权限（本人、组织管理员、产品管理员、只读、只读 Token）与应用密钥不出现在任何响应里、看不到产品的成员收不到通知（Task 11）；端到端的 @ 补全与站内通知、被指派、关注与取消关注、偏好开关、铃铛与通知页、成员企微账号与批量导入，1440 与 760 两种宽度（Task 13–18）。
- 本地开发库执行迁移后核对一致（Task 19）；控制方完成界面复验与测试群联调（每次发送前经用户确认），验证记录、交接文档与协作日志已更新（Task 20）。

## 自查

写完后对照设计逐条核对的结果：

| 设计条目 | 对应任务 |
|---|---|
| §1 范围：站内通知、@ 成员、关注、个人偏好、企微群里 @ 到人、企微账号绑定（手动、导入、扫码）；不含看板、浏览器与手机推送、飞书钉钉、AI 摘要 | Task 1–20（没有看板、浏览器推送、飞书钉钉、AI 摘要的代码） |
| §2 通知类型五种、企微 @ 到人、两步走的企微身份、按产品的个人提醒通道、偏好默认值、关注口径、方案 B 异步生成 | Task 1（类型与默认值）、Task 3 + 8（方案 B）、Task 4（关注）、Task 6–7（身份）、Task 9（通道与分发） |
| §3 四张新表与字段、唯一约束、`event_id` 为空不参与唯一；三列；`wecom_apps`；事件补充；`--replace` 清理 | Task 2（表、列、RLS、迁移工具）、Task 3（事件） |
| §4.1 写法、显示（当前姓名、离开后灰色原名、代码里不解析）、输入（评论、描述、PRD）、权限标注、@ 自己不发、新增比对 | Task 1、3、6、8、12、14、15 |
| §4.2 手动、批量导入（预览）、扫码绑定（应用配置、回调地址、一次性 state、只访问 qyapi）、本地模拟、自行解除 | Task 6、7、11、17、18 |
| §4.3 个人提醒发到产品的个人提醒通道、`<@userid>`、没有绑定或通道时只保留站内 | Task 9、18 |
| §5.1 后台循环、SKIP LOCKED 锁游标、每轮 500 条、`legacy.*` 不处理、子事务、失败 3 次跳过、上线时游标为最新 | Task 2（初始化）、Task 8 |
| §5.2 收件人规则表、本人不通知、看不到产品不通知、同一事件一条、自动关注 | Task 8；系统告警 Task 10 |
| §5.3 站内、企微合并与 4096 字节分条、走发送队列、邮件按人合并 | Task 8、9 |
| §5.4 打开详情标已读、全部标为已读、90 天清理 | Task 10、13、16 |
| §6 铃铛（30 秒刷新、20 条、分组、三个筛选、圆点、跳转并已读、底部两个操作）、通知页、个人设置、组织设置、产品设置、关注按钮、工作台不改 | Task 13、16、17、18（工作台没有改动） |
| §7 验证清单 | 见「P3-B1 完成标准」；测试群联调见 Task 20 Step 3 |

- 占位检查：计划中没有「待定」「以后实现」或只描述不给代码的步骤。`2026-10-XX` 是协作日志条目的日期，测试群地址与测试成员的企业微信账号由用户在 Task 20 提供且不落盘，都是执行时才能确定的外部输入。
- 名称一致性：`parseMentions`、`mentionedMemberIds`、`newMentionIds`、`cleanMentionName`、`mentionMarkup`、`plainMentions`、`splitRichText`、`MEMBER_NOTIFICATION_KINDS`、`MEMBER_NOTIFICATION_RANK`、`DEFAULT_NOTIFICATION_PREFS`、`NOTIFICATION_PREF_CHANNEL_LABELS`、`WECOM_USERID_RE`、`memberNotifications`、`memberNotificationPrefs`、`subscriptions`、`notificationCursors`、`wecomApps`、`wecomBindStates`、`getSubscription`、`setSubscription`、`autoSubscribeTx`、`kindsForRole`、`prefsForTx`、`getNotificationSettings`、`setNotificationPref`、`writeWecomUseridTx`、`setMemberWecomUserid`、`unbindMyWecom`、`parseWecomCsv`、`previewWecomImport`、`applyWecomImport`、`listMentionMembers`、`wecomCallbackUrl`、`getWecomApp`、`saveWecomApp`、`WECOM_API_BASE`、`startWecomBind`、`completeWecomBind`、`eligibleMembersTx`、`pickRecipients`、`reviewJustStarted`、`subjectTx`、`planEventTx`、`generateMemberNotifications`、`getPersonalChannel`、`setPersonalChannel`、`getPersonalEmailChannel`、`setPersonalEmailChannel`、`wecomLine`、`chunkLines`、`emailFor`、`dispatchPersonalTx`、`listMyNotifications`、`countMyUnread`、`markNotificationRead`、`markAllNotificationsRead`、`markSubjectNotificationsRead`、`retentionCutoff`、`deleteExpiredNotifications`、`notifyScheduleAlertTx` 在定义与使用处一致；web 的 `inboxKeys`、`useUnreadCount`、`useNotifications`、`useNotificationPages`、`useSubscription`、`useNotificationSettings`、`useMentionMembers`、`useWecomApp`、`usePersonalChannel`、`usePersonalEmailChannel`、`unreadBadge`、`groupByDay`、`relativeTime`、`actorLabel`、`parseNotificationFilter`、`pageUrlQuery`、`pageApiQuery`、`prefCell`、`activeMentionQuery`、`filterMentionMembers`、`applyMention`、`mentionTitle`、`NotificationItem`、`NotificationBell`、`MentionChip`、`FollowButton`、`useMarkNotificationsRead`、`PersonalNotifications`、`WecomUseridDialog`、`WecomImportDialog`、`WecomAppTab`、`PersonalEmailChannel`、`PersonalChannelPicker`、`prdSchema`、`MentionMembersContext` 同样一致；测试辅助 `startFakeWecom`（Task 11）、e2e `memberRequest`（Task 13）在使用它们的任务之前或之内定义。
- 依赖顺序：Task 3 用 Task 1 的写法；Task 4–7 用 Task 2 的表；Task 8 用 Task 3–5；Task 9 修改 Task 8 的 `generate.ts`；Task 10 用 Task 9 的分发并修改 P3-A 的 `deliveries.ts`、`worker.ts`；Task 11 用 Task 4–10；Task 12 用 Task 11；Task 13–18 用 Task 12；Task 16 的「打开详情标为已读」与 Task 13 的铃铛用例相容（两条通知在不同需求上）；Task 19 用 Task 2；Task 20 收尾。
- 循环引用：`notifications/deliveries.ts → member-notifications/alerts.ts → dispatch.ts → notifications/channels.ts → events.ts → notifications/match.ts → notifications/channels.ts` 与 P3-A 已有的环同类，环上只有函数声明，模块初始化时不调用；Task 10 Step 7 跑 core 的推送测试确认。
