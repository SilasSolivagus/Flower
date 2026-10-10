# Flower P3-A 推送（通道、事件规则、定时推送、模板与发送记录、迁移） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 组织管理员登记企业微信机器人、Webhook、邮件通道（配置加密存储，界面只见脱敏提示）；产品管理员为本产品配置事件规则（即时推送或合并到变更摘要）与定时推送（概览卡片、新需求、变更摘要）；消息由可编辑的模板渲染，全部发送经发送记录表排队，由应用进程内的后台循环限流、重试、告警；push 与 123plane 的推送配置迁移为停用状态的通道、定时推送与历史发送记录。做完即可替代 push 的推送。

**Architecture:** 新增六张租户表（RLS）：`notification_channels`、`message_templates`、`notification_schedules`、`notification_rules`、`notification_digest_items`、`notification_deliveries`。纯逻辑在 `packages/core/src/notifications/`：`secrets.ts`（AES-256-GCM）、`channel-config.ts`（校验、脱敏、合并）、`cron.ts`（cron-parser）、`template.ts`（`{{ }}` 渲染、按通道生成请求体、markdown 拆分）。服务层：`channels.ts`、`message-templates.ts`、`schedules.ts`、`rules.ts` + `match.ts`（`recordEvent` 在同一事务内调用，只写待发记录或摘要条目）、`sources.ts` + `run.ts`（生成概览卡片、新需求、变更摘要与事件消息）、`sender.ts` + `deliveries.ts`（`FOR UPDATE SKIP LOCKED` 取任务、限流、重试、执行结果与告警、测试消息、重发、列表）、`worker.ts`（每 5 秒一轮的循环与可手动调用的 `runNotificationTick`）。web 在 `instrumentation.ts` 启动循环（`FLOWER_NOTIFY_WORKER=off` 关闭），测试与端到端用实例管理员的 tick 接口驱动。页面：组织设置新增「推送」（通道、定时推送、消息模板、发送记录四个页签），产品设置新增「推送」页签（事件规则与本产品定时推送）。迁移工具 `legacy import` 增加推送配置的计划、写入与对账。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui、Vitest、Playwright；新增 `cron-parser` 5.10.2、`nodemailer` 10.0.16；加密与 HTTP 用 Node 内置 `node:crypto`、`fetch`、`node:http`（测试假接收端）。

**Spec:** `docs/superpowers/specs/2026-10-10-flower-p3a-notifications-design.md`（用户 2026-10-10 确认，本计划的约束来源）；上位文档 `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§6.1 领域事件、§6.2 通知中心、§7.2 迁移映射、§8 分阶段）。逐条决定见下方「设计决定」，与设计、代码或数据不一致之处见文末「与设计、代码或数据的冲突」。

## Global Constraints

- **不真实发送。** 计划里的任何步骤都不向真实 webhook、真实邮箱发送。单元测试注入假的 `Transport`；接口测试与端到端测试只向本机假接收端（`http://127.0.0.1:{随机端口}`，`apps/web/test/fake-webhook.ts`）发送，不连外网。迁移来的通道一律 `enabled = false`；停用的通道不能发测试消息，排队的记录到发送时直接放弃。测试群联调只在 Task 18 由控制方进行：用户提供测试群 webhook，**每一次**「发送测试消息」或「立即执行」之前都先征得用户确认。
- **真实数据只在本地开发库的组织 pan123 上操作**：数量核对一律用只读查询 `docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select …"`；push 副本只用 `sqlite3 -readonly .local-data/push.db "select …"`；迁移只做 `--dry-run`。`--replace` 重导只在 Task 17 的用户检查点、经用户明确确认后执行。不连接、不操作任何服务器。
- `.local-data/` 存放生产数据副本与对账报告（含员工个人信息、生产群 webhook），不提交；计划、验证记录、提交信息只写数量与结构，不写姓名、群名、需求标题、网址、密钥或正文。测试与示例只用虚构内容、`@example.com` 邮箱、`example.com` / `127.0.0.1` 网址。
- 执行代理不得运行 `pnpm dev`。界面检查一律写成 Playwright 端到端用例（独立的 `flower_e2e` 库与 3100 端口；`playwright.config.ts` 给服务端设置 `FLOWER_NOTIFY_WORKER=off`、`FLOWER_NOTIFY_TICK_API=1`，用例通过 tick 接口驱动后台发送）；真实数据上的界面复验由控制方完成（Task 18）。
- **加密**：通道配置用 AES-256-GCM，密钥由 `FLOWER_SECRET_KEY` 经 HKDF-SHA256 派生，存为带版本号的密文 `v1:{iv}:{tag}:{密文}`。明文配置（网址、签名密钥、邮箱密码）不得出现在任何接口响应、领域事件 payload、对账报告里，各层都有测试断言。
- **新依赖只有两个**，精确版本、装在 `packages/core`：`cron-parser@5.10.2`、`nodemailer@10.0.16`。其余用 Node 内置模块。执行中如需其他依赖，停下来报告。
- 迁移文件：`0015_*.sql` 由 `pnpm --filter @flower/core db:generate` 生成；`0016_p3a_rls.sql` 用 `--custom` 生成后填写，为六张新表开启 RLS（参照 `0014_p2b2_rls.sql`）。执行中如发现还要改表结构，停下来报告。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`（实体 id 作为第三个参数的现有写法照旧；需要密钥、网址、发送器的服务在最后多一个 `deps` 参数），一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写；用户发起的写操作同事务调用 `recordEvent`，修改类事件 payload 带 `changes: [{field, old, new}]`。`withSystem` 除原有用途外，只允许后台循环用来查出「有待办的组织 id」（见设计决定）。
- 面向用户的文案与错误信息用中文，错误通过 `AppError(code, message, details?)` 抛出。`apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`、`@flower/core/markdown`、`@flower/core/links` 和本计划新增的 `@flower/core/notifications`（`notifications/constants.ts`，不导入任何模块）。纯逻辑放 `apps/web/src/features/notifications/model.ts` 并写 Vitest 单测。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`；对话框用 `key` 重新挂载取初值（参照 `apps/web/src/app/(app)/[org]/settings/general/page.tsx` 的渲染期间同步）。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框用 `silentError: true` + `<FormError error={mutation.error} />`。页面加载失败用 `components/load-error.tsx` 的 `QueryError` / `LoadError`。
- 复用已有的共享件：`PageHeader`、`EmptyState`、`ConfirmAction`、`FormError`、`QueryError`、`LoadError`、`NoAccess`、`RequireOrgAdmin`、`formatDateTime`（`features/requirements/format.ts`）、`nodeOptions`（`features/structure/model.ts`）；e2e `helpers.ts` 的 `ok`、`json`、`setupInstance`、`login`、`createProduct`、`createRequirement`、`createIteration`、`createTask`、`expectNoPageOverflow`，以及本计划新增的 `tick`、`createWecomChannel`。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0`。
- 视觉沿用 P0-B：表格行高 40px（`h-10`）、隔行底色 `even:bg-zebra`、编号与时间用 `font-mono`、卡片圆角 6px（`rounded-md`）。告警行用 `bg-destructive/5` 与 `text-destructive` 标红。
- 布局：页面本身不出现横向滚动；新页面在 1440 与 760 两个宽度下有 Playwright 断言（`expectNoPageOverflow`）。
- 端到端测试：每个 spec 在 `beforeEach` 或用例开头调用 `resetDatabase()`；不为迁就定位器修改共享组件；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染。
- `pnpm test` 和端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；之后要对开发库做任何操作，先执行 `pnpm db:migrate`。
- 每个 commit message 末尾加一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）；实际执行提交的若不是 Claude Opus 5.5，把这一行换成实际模型的名字。完成一项工作后按 `CLAUDE.md` 在 `docs/agent-log.md` 最上面追加一条（Task 18）。

## 设计决定

数量均为 2026-10-10 的只读查询所得：本地开发库（组织 pan123）用 `docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select …"`；push 与 123plane 副本用 `sqlite3 -readonly .local-data/push.db "select …"`、`sqlite3 -readonly .local-data/123plane.db "select …"`，只取数量、键名、长度与结构，不取内容。

| 项 | 决定 | 依据 |
|---|---|---|
| 旧数据 | push：`groups` 2（均启用，地址均为企微机器人 `…/cgi-bin/webhook/send?key=…`）；`tasks` 3（均为 cron、Asia/Shanghai、`source_config = {}`、`fail_threshold = 1`、无告警：工作日 19:00 概览卡片推 2 个群，启用；工作日 10:00 概览卡片，停用，推 0 个群；每天 9:30 新需求推 1 个群，启用）；`task_targets` 3；`push_logs` 115，全部 `ok`（概览 84 条 = 每次每群一条图片 + 一条卡片；新需求 31 条 = markdown（超长时分为多条「续n」）与随后的一条固定文字）；`settings` 8 个键（其中 `prd_notify_webhook` 不在设计范围）。123plane：`settings` 中企微地址 2 个（与 push 两个群互不相同，共 4 个不同地址），`wecom_digest_schedule` 为空数组，SMTP 五项齐全（端口 465，收件人 1 个），`notification_queue` 67 条（均为 requirement_updated）。pan123：产品 1 个（PAN），需求 765 条；优先级选项 5 个（key：p0、p1、p2、p3、green）；来源选项 2 个（original、online_issue）；常规迭代 11 个全部已完成（最近结束日 2026-09-15）；领域事件 4450 条，9 种可订阅事件中有记录的只有 `document.status_changed` 8 条、`requirement.created` 1 条 | 设计 §2、§7；只读核对 |
| 概览卡片（按 push 实际输出核对） | push 每次对每个群先发一条图片（看板截图，日志只记 md5），再发一条模板卡片；卡片在日志里的结构是 `{title, desc, buttons: [{title, url}]}`：`title` = 日报标题 + 「 · YYYY-MM-DD」；`desc` = 「{当前版本发版日 MMDD}发版 · 整体 {N}% · 引导语」（N 为整体进度）；一个按钮，链接到看板。Flower 的卡片为企微 `template_card`，`card_type = text_notice`：`main_title.title` ← `{前缀} · YYYY-MM-DD`（前缀默认「{产品名} 研发日报」，`source_config.titlePrefix` 可改）；`main_title.desc` ← 「{迭代结束日 MMDD} 发版 · 整体进度 {overall}% · 点开查看需求与甘特」；按钮 ← `jump_list[0]`（「查看完整明细」）与 `card_action`，都指向该迭代的甘特页 `/{org}/iterations/{id}`。`overall` 用 `iterationOverview(...).overall`，与甘特页「整体进度」同一口径（push 的 A 方案）。不发看板图片（见冲突表） | 设计 §5「版式对齐 push 现有概览卡片……在计划中按 push 实际输出核对确定」 |
| 概览卡片的当前迭代 | 本产品的常规迭代（未删除、未取消）：进行中的按结束日最早 → 规划中的按开始日最早 → 已完成的按结束日最晚。都没有时 `desc` 为「当前没有迭代 · 点开查看迭代列表」，按钮「查看迭代列表」指向 `/{org}/iterations`。pan123 目前会取最近完成的迭代 | 设计 §5「本产品当前迭代与需求概况」；pan123 没有进行中的迭代 |
| 新需求（按 push 实际输出核对） | 结构与 push 一致：标题行 `# 📋 {M/D} 新增需求`；引用行 `> 🆕 新增 {n} 条 · 🔧 线上转需求 {m} 条`；分组「🆕 新增需求」「🔧 线上转需求」（空组不显示）；每条 `**{序号}. [{编号} {标题}]({需求链接})** <font color="{warning 或 comment}">{优先级}</font>`、`<font color="comment">{提出人} · {业务线}[ · {平台/平台}]</font>`、可选说明行 `<font color="comment">{说明}</font>`、可选 `[PRD ↗]({PRD 网址})`；末行 `> 👉 [到 Flower 认领 / 分配 ↗]({需求列表})`。优先级选项 key 为 p0、p1 时用 warning 色。线上转需求 = 「来源」字段选项 key 在 `source_config.onlineSourceKeys` 里。说明取描述里第一行不是标题的文字，去掉开头的引用与列表标记，最多 80 字。PRD 网址：外部 PRD 取外部网址，Flower 内 PRD 取 `/{org}/documents/{编号}`。超过 4096 字节时按段拆成多条，第 2 条起标题行加「（续n）」（push 同样做法） | 设计 §5「编号、标题、提出人、链接」；push 日志结构 |
| 新需求的时间窗与空结果 | 窗口为 `(last_success_at, 本次执行时间]`；从未成功过时取最近 24 小时。`source_config.emptyBehavior`：`skip`（默认，与 push 一致——日志里没有新需求的日子没有记录）不发；`notice` 发一条文本「{产品名} {M/D} 没有新需求」 | 设计 §5「上次成功推送以来」「按配置决定不发或发」 |
| 变更摘要 | 一次执行取本定时推送未消费、未被其他执行取用的摘要条目（按时间最多 200 条，其余留给下一次），写上 `run_id`；按主体（需求、PRD、迭代、发布版本）分组，组内按时间列出「MM-DD HH:mm 操作人：事件名：变化」；没有条目不发。任一通道发送成功即标记已消费；全部通道都放弃时清空 `run_id` 留给下一次 | 设计 §5「按需求分组合并成一条，发送成功后标记已消费」 |
| 事件消息的数据 | `{ product{key,name}, event{type,label,actor,time}, subject{key,title,url}, changes[{label,old,new}], summary }`。值换成中文：`stateKey` → 流程状态名；`iterationId` → 迭代名；PRD、迭代、发布版本的 `status` → 状态名；`requirement.field_changed` 的字段 key → 字段名（选项已是名称）；分配 → 「成员 · 职能」；检查项状态 → `CHECK_STATE_LABELS`；空值为「空」。时间按组织时区 `MM-DD HH:mm`；操作人为成员显示名，没有时为「系统」 | 设计 §4、§6 |
| 渲染时机 | 事件规则匹配在业务事务里只写待发记录（`payload` 为空）或摘要条目；后台发送在第一次发送前渲染并写回 `payload`。模板错误或慢查询不影响业务写入。规则消息只取渲染结果的第一条请求体（事件消息远小于 4096 字节，超出时截断）。定时推送在执行时渲染，按通道写入请求体 | 设计 §6「payload（渲染后的请求体）」；业务写入不受推送影响 |
| 模板语法 | `{{path}}` 字段替换（点号路径，缺字段为空串）；`{{#path}}…{{/path}}`：数组逐项重复（项内先查项、再查外层），非空值渲染一次；`{{^path}}…{{/path}}`：值为空（缺失、null、false、空串、空数组）时渲染；独占一行的区块标签连同换行一起去掉。没有表达式、函数、下标，不执行代码。`template_card` 模板体是企微 `template_card` 对象的 JSON，只替换字符串值中的变量（不支持按列表重复）。`email` 格式第一行是主题 | 设计 §6「只做字段替换与按列表重复，不执行代码」 |
| 预置模板 | 四个：`event`（事件推送，markdown）、`overview_card`（template_card）、`new_requirements`（markdown）、`digest`（markdown），`builtin_key` 标识用途；名称与格式不可改，内容可改，不可删除。组织第一次读取模板列表时补齐（`on conflict do nothing`，属于基础数据补齐，不记事件）；渲染时找不到预置行就用代码里的默认内容 | 设计 §6「每种内容来源和事件规则各有预置默认模板」 |
| 格式到请求体 | 企微机器人：text → `{msgtype:'text'}`（2048 字节截断）；markdown → `{msgtype:'markdown'}`（4096 字节拆分）；template_card → `{msgtype:'template_card', template_card}`；email → text。Webhook：POST `{format, content}`（卡片的 content 为对象），有签名密钥时带 `X-Flower-Timestamp` 与 `X-Flower-Signature: sha256={HMAC-SHA256(secret, "{timestamp}.{body}")}`。邮件：纯文本；主题取第一行（去掉 `#`、`>`、`*`），email 格式取第一行、正文为其余行，卡片取 `main_title` 与链接 | 设计 §3 |
| 加密 | 密钥 = `HKDF-SHA256(FLOWER_SECRET_KEY, salt "flower/notification-config", info "aes-256-gcm/v1", 32 字节)`；每次随机 12 字节 IV；存 `v1:{iv}:{tag}:{密文}`（base64url）。解密失败报「通道配置无法解密：FLOWER_SECRET_KEY 与加密时不同，或数据已损坏」。迁移工具用同一函数 | 设计 §3「带版本号的密文」 |
| 敏感字段与返回 | 敏感：企微网址、Webhook 网址与签名密钥、邮箱密码。接口返回 `configHint`：企微 `…/send?key=****abcd`；Webhook `https://{host}/…****{末 4 位}`，有密钥时加「 · 已设置签名密钥」；邮件 `{host}:{port} · {from} → {n} 个收件人`。邮件通道另返回非敏感字段 `settings`（host、port、secure、user、from、to）供修改表单回填。修改时敏感字段留空表示不变，Webhook 用 `clearSecret: true` 清除密钥。事件 `changes` 里配置只记 hint | 设计 §3「只返回 config_hint」「可只改非敏感字段」（见冲突表） |
| 通道 | 组织管理员管理；名称组织内唯一、1–50 字；`group_label` 最多 50 字；`rate_limit_per_min` 1–600（默认企微 20、其余 60）；`allowed_product_ids` 必须是本组织产品。删除：有发送记录或被规则、定时推送引用时报「已有发送记录或被规则、定时推送引用的通道只能停用」。停用的通道不能发测试消息、不能被规则或定时推送新选中，排队记录到发送时标 `dead`「通道已停用，未发送」 | 设计 §3「权限」 |
| 事件规则 | 产品管理员（组织管理员在所有产品上是管理员）管理，只读 Token 403。名称 1–50 字；事件类型 1–9 个，必须在可订阅列表；即时规则选 1–10 个本产品可用且启用的通道；摘要规则不选通道（用定时推送的通道），`digest_schedule_id` 必须是本产品 `source = digest` 的定时推送。`filter`：`states`（流程状态 key）、`priorities`（优先级选项 key）、`nodeIds`（结构树节点，含其下级）、`documentStatuses`、`fields`（字段 key）；条件之间且、条件内或；条件只作用于适用的事件（需求条件只看主体为需求的事件，文档状态只看 `document.status_changed`，字段只看 `requirement.field_changed`），不适用时视为通过。删除：有发送记录或摘要条目时报「只能停用」 | 设计 §4 |
| 匹配 | `recordEvent` 插入事件后，类型在可订阅列表且有 `productId` 时，同一事务内调用 `matchNotificationRules`：查本产品启用且 `event_types` 含该类型的规则（没有时只多这一次查询）；命中即时规则 → 为每个仍可用的通道写一条 `kind = rule`、`payload` 为空的 pending 记录；命中摘要规则 → 写 `notification_digest_items`（同一规则同一事件只一条） | 设计 §4「匹配时机」 |
| 定时推送的范围与管理 | P3-A 三种来源都按产品取数，新建时必须选产品（`product_id` 列保留可空，给以后的组织级来源）；由本产品管理员管理与立即执行。`cron` 5 段（cron-parser 校验）；`timezone` 为 IANA 时区；通道 1–10 个、对本产品可用且启用（只在提交了 `channelIds` 时校验，迁移来的停用通道不影响修改其他字段）；`fail_threshold` 1–10；`source_config`：overview_card `{titlePrefix?}`，new_requirements `{emptyBehavior, onlineSourceKeys}`，digest `{}`。启用时 `next_run_at` = 下一次，停用时为空。删除：有发送记录或被摘要规则引用时报「只能停用」 | 设计 §5 |
| 定时执行 | 每轮：`next_run_at` 为空的启用定时推送只排期、不执行（迁移导入的情形，不补跑）；到点的先 `pg_try_advisory_xact_lock(hashtextextended('flower:notify-schedule:'||id, 0))`，拿到锁后在同一事务内重新读取、生成内容、写待发记录、更新 `last_run_at` 与 `next_run_at`（从本次时间算下一次，错过的不补跑）。生成出错：事务回滚，另起事务写 `last_error`、连续失败加一、按阈值告警、推进 `next_run_at`。没有可用通道：只记 `last_run_at` 与 `last_error`「没有可用的通道」，不计失败。「立即执行」走同一生成函数（不改 `next_run_at`），由后台循环在下一轮发送；拿不到锁时报 409「该定时推送正在执行，请稍后再试」 | 设计 §5「执行」「立即执行」、§6「advisory lock」 |
| 执行结果与告警 | 一次执行的全部记录共享 `run_id`。任一条发送成功 → 连续失败清零、`alert_state = normal`、`last_success_at` = 本次执行时间（记录的 `created_at`）、本次的摘要条目标记已消费；同一次的记录全部放弃 → 连续失败加一，达到 `fail_threshold` 时 `alert_state = alert`，本次的摘要条目清空 `run_id`。告警在定时推送列表与发送记录里标红 | 设计 §5「失败告警」 |
| 发送 | 每轮每个组织最多取 50 条到期的 pending / failed 记录（`FOR UPDATE SKIP LOCKED`，按 `next_attempt_at`、`created_at`）；按通道取 `pg_try_advisory_xact_lock(hashtextextended('flower:notify-channel:'||id, 0))`（拿不到的通道本轮跳过），以「60 秒内已发送 + 发送中」计数算余量，余量内的改为 `sending`（租约：`next_attempt_at` = 现在 + 2 分钟）后提交；在事务外逐条发送（HTTP 超时 10 秒），每条结果在新事务里写入。租约到期仍为 `sending` 的按一次失败处理（「发送中断」） | 设计 §6「后台循环」「限流」 |
| 重试与限流结果 | 失败后 30 秒、2 分钟、10 分钟、1 小时再试，第 5 次失败为 `dead`；`failed` 表示等待重试。测试消息只发一次，失败即 `dead`。企微 HTTP 200 且 `errcode = 0` 为成功，`errcode = 45009`（接口调用超过限制）或 HTTP 429 为限流：回到 `pending`、60 秒后再试、不计次数；其余为失败。Webhook 2xx 成功、429 限流。邮件 SMTP 接受为成功。`response` 截断到 2000 字 | 设计 §6「重试」 |
| 测试消息与重发 | 组织管理员。测试消息为固定文本「Flower 测试消息：通道「{名称}」可以正常接收推送。」加发送时间，在请求内同步发送一次并返回结果。重发：只对 `sent` / `dead`、非迁移记录、通道已启用时，复制为新的 pending 记录（不带 `run_id`，不影响定时推送的告警计数） | 设计 §3「发送测试消息」、§6「重发」 |
| 发送记录页 | 组织管理员；按通道、来源（规则 / 定时推送 / 测试）、状态、时间起止筛选（筛选写在地址栏），按创建时间倒序，每页 50 条（游标 `before`）；列：时间、来源（名称）、通道、状态、次数、下次重试、内容摘要（200 字）、响应；所属定时推送处于告警的行标红；行内「重发」 | 设计 §6「发送记录页」 |
| 后台循环 | `createNotificationWorker(db, deps, { intervalMs })`：每轮结束后等 5 秒再开始下一轮（不重叠），`stop()` 停止取新任务并等当前一轮结束。web 在 `instrumentation.ts` 启动（独立连接池 max 2），收到 SIGTERM / SIGINT 时 `stop()`；`FLOWER_NOTIFY_WORKER=off` 不启动。手动驱动：`runNotificationTick(db, deps, now?)`；接口 `POST /api/v1/instance/notifications/tick`（实例管理员；只在 `FLOWER_NOTIFY_TICK_API=1` 时存在，否则 404；可传 `now` 模拟时间） | 设计 §6「测试与 e2e 环境可以关闭循环、改为手动驱动」 |
| 跨组织查询 | 后台循环用 `withSystem` 只做一件事：查出有到期记录或需要处理的定时推送的组织 id；之后全部在 `withOrg(orgId)` 内进行 | CLAUDE.md「withSystem 只用于……」（见冲突表） |
| 领域事件 | `notification_channel.created/updated/deleted/tested`、`message_template.created/updated/deleted`、`notification_rule.created/updated/deleted`、`notification_schedule.created/updated/deleted/run`、`notification_delivery.resent`；修改类带 `changes`（通道配置只记 hint）。后台发送改状态不记事件 | CLAUDE.md「每个写操作……recordEvent」 |
| 迁移映射 | push `groups` → wecom_robot 通道（`name` 与 `group_label` 取群名）；push `tasks` → 定时推送（产品 PAN；cron、时区、启用、`last_run`、`last_success`、连续失败、阈值、告警原样；`next_run_at` 为空，由后台循环排期；`overview` → overview_card `{}`，`newreqs` → new_requirements `{emptyBehavior:'skip', onlineSourceKeys:['online_issue']}`）；`task_targets` → `channel_ids`；`push_logs` → 发送记录（`kind = schedule`、`status = sent`、`attempts = 1`、`payload = {type:'legacy', content}`、`sent_at` 与 `created_at` 为日志时间（UTC）、`legacy_key = push_logs:{id}`；任务或群找不到的跳过并列入报告）。123plane `wecom_requirement_webhook_url` → 通道「123plane 需求通知」，`wecom_daily_webhook_url` → 通道「123plane 日报」（`group_label` 123plane）；`wecom_digest_schedule` → digest 定时推送「123plane 变更摘要」（产品 PAN，通道为需求通知通道；数组为空时停用、cron `0 18 * * *`；否则按 HH:MM 的分钟分组合成 cron，每个分钟一个定时推送）；SMTP 齐全时 → 邮件通道「123plane 邮件」（`secure` = 端口为 465，`from` = 用户名，`to` 按逗号、分号、空白拆分）。**全部通道 `enabled = false`**。id 由来源键派生；配置用 `FLOWER_SECRET_KEY` 加密，缺少时计划报问题、拒绝写入。123plane settings 只读这 8 个键 | 设计 §7 |
| 对账报告 | 增加「推送」一节：通道（按来源列名称、类型、启用 = 否）、定时推送（来源、cron、启用）、发送记录数、跳过项。报告不含网址与密钥。「延后迁移」不再列 push 群、推送计划、推送日志、任务对象 | 设计 §7「对账报告增加推送一节」 |
| 迁移文件 | `0015_*.sql` 由 `db:generate` 生成（六张表、索引、检查约束）；`0016_p3a_rls.sql` 用 `--custom` 生成后填写 | CLAUDE.md「新增租户表必须……开启 RLS」 |
| 依赖 | `cron-parser@5.10.2`（5 段校验、时区与夏令时；依赖 luxon）——自写 5 段解析需要自己处理时区换算与夏令时，不划算；`nodemailer@10.0.16`（自带类型、零依赖）。web 的 `next.config.ts` 把 `nodemailer` 加入 `serverExternalPackages` | Global Constraints |

## 文件结构

```
packages/core/
  package.json                               # 依赖 cron-parser、nodemailer；导出 ./notifications（Task 1、2、10）
  src/notifications/constants.ts            # 取值、中文名称、类型（浏览器安全，Task 1）
  src/notifications/secrets.ts              # AES-256-GCM 加解密（Task 1）
  src/notifications/channel-config.ts       # 配置校验、脱敏、合并（Task 1）
  src/notifications/cron.ts                 # 5 段 cron 校验、时区、下一次时间（Task 2）
  src/notifications/template.ts             # 模板渲染、请求体、markdown 拆分（Task 3）
  src/db/schema.ts                          # 六张表（Task 4）
  migrations/0015_*.sql  0016_p3a_rls.sql  meta/                     # Task 4
  src/notifications/channels.ts             # 通道服务（Task 5）
  src/notifications/builtin.ts  message-templates.ts                 # 预置模板与模板服务（Task 6）
  src/notifications/schedules.ts            # 定时推送服务（Task 7）
  src/notifications/rules.ts  match.ts      # 事件规则与匹配（Task 8）
  src/events.ts                             # recordEvent 调用匹配（Task 8）
  src/notifications/sources.ts  run.ts      # 内容来源与执行（Task 9）
  src/notifications/sender.ts  deliveries.ts                         # 发送、重试、限流、测试消息、重发、列表（Task 10）
  src/notifications/worker.ts               # 一轮处理与循环（Task 11）
  src/index.ts                              # 各任务
  test/notify-secrets.test.ts  notify-cron.test.ts  notify-template.test.ts  p3a-schema.test.ts
  test/notify-helpers.ts  notify-channels.test.ts  notify-templates.test.ts  notify-schedules.test.ts
  test/notify-rules.test.ts  notify-run.test.ts  notify-deliveries.test.ts  notify-worker.test.ts
packages/migrate/
  src/legacy-types.ts  load.ts  plan-notify.ts  plan-types.ts  plan.ts  report.ts  write.ts  cli.ts   # Task 4、16
  test/fixtures.ts  sqlite-fixture.ts  load.test.ts  plan-notify.test.ts  plan-requirements.test.ts  report.test.ts  write.test.ts
apps/web/
  next.config.ts  playwright.config.ts  src/instrumentation.ts  src/server/worker.ts                # Task 10、11、13
  src/server/api.ts  src/server/runtime.ts  src/server/routes/instance.ts  src/server/routes/notifications.ts   # Task 11、12
  test/api/helpers.ts  test/fake-webhook.ts  test/api/notify-tick.test.ts  test/api/notifications.test.ts  test/server/worker.test.ts
  src/lib/types.ts  src/lib/queries.ts                                # Task 12
  src/features/notifications/model.ts  model.test.ts                  # Task 12
  src/features/shell/nav.ts  nav.test.ts  src/components/org-shell.tsx   # Task 12（导航「推送」）
  src/app/(app)/[org]/settings/notifications/page.tsx  channels-tab.tsx  channel-dialog.tsx  templates-tab.tsx  template-dialog.tsx   # Task 13
  src/app/(app)/[org]/settings/notifications/schedule-list.tsx  schedule-dialog.tsx                                      # Task 14
  src/app/(app)/[org]/settings/products/[productId]/notifications-tab.tsx  rule-dialog.tsx  page.tsx                     # Task 14
  src/app/(app)/[org]/settings/notifications/deliveries-tab.tsx                                                           # Task 15
  e2e/helpers.ts  notify-channels.spec.ts  notify-rules-schedules.spec.ts  notify-deliveries.spec.ts
docs/superpowers/specs/2026-10-10-flower-p3a-notifications-design.md   # 实现补充（Task 4）
docs/p3a-validation.md  docs/handoff.md  docs/agent-log.md            # Task 18
```

---
### Task 1: 取值常量、通道配置的加密与脱敏

**Files:**
- Create: `packages/core/src/notifications/constants.ts`、`packages/core/src/notifications/secrets.ts`、`packages/core/src/notifications/channel-config.ts`
- Modify: `packages/core/src/index.ts`、`packages/core/package.json`（导出 `./notifications`）
- Test: `packages/core/test/notify-secrets.test.ts`

**Interfaces:**
- Consumes: `AppError`（`packages/core/src/errors.ts`）
- Produces:
  - `constants.ts`（浏览器安全，经 `@flower/core/notifications` 与 `@flower/core` 导出）：`CHANNEL_KINDS`、`type ChannelKind`、`CHANNEL_KIND_LABELS`、`DEFAULT_RATE_LIMIT`；`TEMPLATE_FORMATS`、`type TemplateFormat`、`TEMPLATE_FORMAT_LABELS`；`NOTIFIABLE_EVENT_TYPES`、`type NotifiableEventType`、`EVENT_TYPE_LABELS`、`isNotifiableEventType(type: string): boolean`；`RULE_MODES`、`type RuleMode`、`RULE_MODE_LABELS`；`SCHEDULE_SOURCES`、`type ScheduleSource`、`SCHEDULE_SOURCE_LABELS`；`DELIVERY_KINDS`、`type DeliveryKind`、`DELIVERY_KIND_LABELS`；`DELIVERY_STATUSES`、`type DeliveryStatus`、`DELIVERY_STATUS_LABELS`；`ALERT_STATES`、`type AlertState`；`BUILTIN_TEMPLATE_KEYS`、`type BuiltinTemplateKey`；`SCHEDULE_DEFAULT_TIMEZONE`、`RETRY_DELAYS_SECONDS`、`MAX_ATTEMPTS`、`RESPONSE_MAX_CHARS`；`type RuleFilter`、`type NewRequirementsConfig`、`type OverviewCardConfig`、`type ChannelPayload`、`type DeliveryPayload`
  - `secrets.ts`：`encryptConfig(plain: unknown, secretKey: string): string`、`decryptConfig<T>(token: string, secretKey: string): T`
  - `channel-config.ts`：`type WecomConfig`、`type WebhookConfig`、`type EmailConfig`、`type ChannelConfig`、`type ChannelConfigPatch`、`type ChannelPublicSettings`、`parseChannelConfig(kind, raw): ChannelConfig`、`mergeChannelConfig(kind, current, patch): ChannelConfig`、`channelConfigHint(kind, config): string`、`channelPublicSettings(kind, config): ChannelPublicSettings`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/notify-secrets.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { channelConfigHint, channelPublicSettings, mergeChannelConfig, parseChannelConfig } from '../src/notifications/channel-config';
import { decryptConfig, encryptConfig } from '../src/notifications/secrets';

const KEY = 'unit-test-secret-unit-test-secret-unit-test-secret';
const WECOM_URL = 'https://qyapi.example.com/cgi-bin/webhook/send?key=00000000-aaaa-bbbb-cccc-0000demo1234';
const EMAIL = { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-password-1', from: 'robot@example.com', to: ['pm@example.com'] };

describe('通道配置加密', () => {
  it('往返一致；带 v1 前缀；同一明文两次密文不同；密文里看不到明文', () => {
    const a = encryptConfig({ url: WECOM_URL }, KEY);
    const b = encryptConfig({ url: WECOM_URL }, KEY);
    expect(a).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('demo1234');
    expect(decryptConfig(a, KEY)).toEqual({ url: WECOM_URL });
  });

  it('密钥不同、密文被改、版本不认识时报错', () => {
    const token = encryptConfig(EMAIL, KEY);
    expect(() => decryptConfig(token, `${KEY}-other`)).toThrow('通道配置无法解密');
    const [v, iv, tag, ct] = token.split(':');
    // 改第一个字符：它的 6 位全部落在第一个字节里，改动一定生效（末尾字符可能只含填充位）
    const flipped = `${ct![0] === 'A' ? 'B' : 'A'}${ct!.slice(1)}`;
    expect(() => decryptConfig([v, iv, tag, flipped].join(':'), KEY)).toThrow('通道配置无法解密');
    expect(() => decryptConfig(`v9:${iv}:${tag}:${ct}`, KEY)).toThrow('通道配置无法解密');
  });
});

describe('通道配置校验、脱敏与修改', () => {
  it('网址必须是 http(s)；邮件收件人格式；Webhook 空密钥视为没有', () => {
    expect(() => parseChannelConfig('wecom_robot', { url: 'ftp://x.example.com' })).toThrow('通道配置有误');
    expect(() => parseChannelConfig('email', { ...EMAIL, to: ['不是邮箱'] })).toThrow('通道配置有误');
    expect(parseChannelConfig('webhook', { url: 'https://hooks.example.com/in', secret: '' })).toEqual({ url: 'https://hooks.example.com/in' });
  });

  it('脱敏：企微只露 key 末 4 位；Webhook 显示主机与是否有密钥；邮件不含密码与用户名', () => {
    expect(channelConfigHint('wecom_robot', { url: WECOM_URL })).toBe('…/send?key=****1234');
    expect(channelConfigHint('webhook', { url: 'https://hooks.example.com/in/abcdef9876', secret: 's3cret-value' })).toBe('https://hooks.example.com/…****9876 · 已设置签名密钥');
    const hint = channelConfigHint('email', EMAIL);
    expect(hint).toBe('smtp.example.com:465 · robot@example.com → 1 个收件人');
    expect(hint).not.toContain('demo-password-1');
  });

  it('非敏感字段只对邮件返回，且不含密码', () => {
    expect(channelPublicSettings('wecom_robot', { url: WECOM_URL })).toBeNull();
    const s = channelPublicSettings('email', EMAIL);
    expect(s).toEqual({ host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', from: 'robot@example.com', to: ['pm@example.com'] });
    expect(JSON.stringify(s)).not.toContain('demo-password-1');
  });

  it('修改：敏感字段留空表示不变；clearSecret 清除签名密钥；新网址替换', () => {
    expect(mergeChannelConfig('email', EMAIL, { pass: '', host: 'smtp2.example.com' })).toEqual({ ...EMAIL, host: 'smtp2.example.com' });
    expect(mergeChannelConfig('webhook', { url: 'https://hooks.example.com/in', secret: 'old' }, { url: '  ' })).toEqual({ url: 'https://hooks.example.com/in', secret: 'old' });
    expect(mergeChannelConfig('webhook', { url: 'https://hooks.example.com/in', secret: 'old' }, { clearSecret: true })).toEqual({ url: 'https://hooks.example.com/in' });
    expect(mergeChannelConfig('wecom_robot', { url: WECOM_URL }, { url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=new-key-5678' })).toEqual({
      url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=new-key-5678',
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/notify-secrets.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/channel-config'`）。

- [ ] **Step 3: 实现**

新建 `packages/core/src/notifications/constants.ts`：

```ts
/**
 * 推送的取值、中文名称与共用类型。浏览器安全：本文件不导入任何模块，页面经 `@flower/core/notifications` 引用。
 */

export const CHANNEL_KINDS = ['wecom_robot', 'webhook', 'email'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = { wecom_robot: '企业微信机器人', webhook: 'Webhook', email: '邮件' };
/** 每分钟发送上限的默认值：企微机器人 20 条/分钟，其余 60。 */
export const DEFAULT_RATE_LIMIT: Record<ChannelKind, number> = { wecom_robot: 20, webhook: 60, email: 60 };

export const TEMPLATE_FORMATS = ['text', 'markdown', 'template_card', 'email'] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];
export const TEMPLATE_FORMAT_LABELS: Record<TemplateFormat, string> = { text: '文本', markdown: 'Markdown', template_card: '模板卡片', email: '邮件' };

/** 事件规则可以订阅的领域事件。 */
export const NOTIFIABLE_EVENT_TYPES = [
  'requirement.created',
  'requirement.state_changed',
  'requirement.field_changed',
  'requirement.assignment_added',
  'requirement.iteration_changed',
  'document.status_changed',
  'check_item.signed',
  'release.released',
  'iteration.status_changed',
] as const;
export type NotifiableEventType = (typeof NOTIFIABLE_EVENT_TYPES)[number];
export const EVENT_TYPE_LABELS: Record<NotifiableEventType, string> = {
  'requirement.created': '新建需求',
  'requirement.state_changed': '需求状态变化',
  'requirement.field_changed': '需求字段变化',
  'requirement.assignment_added': '需求新增分配',
  'requirement.iteration_changed': '需求所属迭代变化',
  'document.status_changed': 'PRD 状态变化',
  'check_item.signed': '检查项签字',
  'release.released': '版本发布',
  'iteration.status_changed': '迭代状态变化',
};
export const isNotifiableEventType = (type: string): type is NotifiableEventType => (NOTIFIABLE_EVENT_TYPES as readonly string[]).includes(type);

export const RULE_MODES = ['immediate', 'digest'] as const;
export type RuleMode = (typeof RULE_MODES)[number];
export const RULE_MODE_LABELS: Record<RuleMode, string> = { immediate: '即时推送', digest: '合并到变更摘要' };

export const SCHEDULE_SOURCES = ['overview_card', 'new_requirements', 'digest'] as const;
export type ScheduleSource = (typeof SCHEDULE_SOURCES)[number];
export const SCHEDULE_SOURCE_LABELS: Record<ScheduleSource, string> = { overview_card: '概览卡片', new_requirements: '新需求', digest: '变更摘要' };

export const DELIVERY_KINDS = ['rule', 'schedule', 'test'] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];
export const DELIVERY_KIND_LABELS: Record<DeliveryKind, string> = { rule: '事件规则', schedule: '定时推送', test: '测试消息' };

/** failed 表示本次失败、等待重试；dead 表示已放弃。 */
export const DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'failed', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = { pending: '待发送', sending: '发送中', sent: '已发送', failed: '失败待重试', dead: '已放弃' };

export const ALERT_STATES = ['normal', 'alert'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const BUILTIN_TEMPLATE_KEYS = ['event', 'overview_card', 'new_requirements', 'digest'] as const;
export type BuiltinTemplateKey = (typeof BUILTIN_TEMPLATE_KEYS)[number];

export const SCHEDULE_DEFAULT_TIMEZONE = 'Asia/Shanghai';
/** 第 n 次失败后等待的秒数；第 MAX_ATTEMPTS 次失败后放弃。 */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 3600] as const;
export const MAX_ATTEMPTS = 5;
export const RESPONSE_MAX_CHARS = 2000;

/** 事件规则的过滤条件：条件之间为「且」，同一条件内多个值为「或」；不适用于该事件的条件视为通过。 */
export type RuleFilter = { states?: string[]; priorities?: string[]; nodeIds?: string[]; documentStatuses?: string[]; fields?: string[] };
export type NewRequirementsConfig = { emptyBehavior: 'skip' | 'notice'; onlineSourceKeys: string[] };
export type OverviewCardConfig = { titlePrefix?: string };

/** 一次发送的请求体：企微与 Webhook 为 JSON，邮件为主题与正文。 */
export type ChannelPayload = { type: 'json'; body: Record<string, unknown> } | { type: 'email'; subject: string; text: string };
/** 发送记录里的请求体；legacy 为迁移来的 push 推送日志原文。 */
export type DeliveryPayload = ChannelPayload | { type: 'legacy'; content: string };
```

新建 `packages/core/src/notifications/secrets.ts`：

```ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { AppError } from '../errors';

const VERSION = 'v1';
const SALT = 'flower/notification-config';
const INFO = 'aes-256-gcm/v1';

/** 由实例密钥派生通道配置的加密密钥（HKDF-SHA256，32 字节）。 */
function deriveKey(secretKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secretKey, SALT, INFO, 32));
}

/** AES-256-GCM 加密，存为 `v1:{iv}:{tag}:{密文}`（base64url）；每次随机 IV。 */
export function encryptConfig(plain: unknown, secretKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretKey), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptConfig<T>(token: string, secretKey: string): T {
  const [version, iv, tag, ct] = token.split(':');
  const fail = () => new AppError('precondition_failed', '通道配置无法解密：FLOWER_SECRET_KEY 与加密时不同，或数据已损坏');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw fail();
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKey), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  } catch {
    throw fail();
  }
}
```

新建 `packages/core/src/notifications/channel-config.ts`：

```ts
import { z } from 'zod';
import { AppError } from '../errors';
import type { ChannelKind } from './constants';

export type WecomConfig = { url: string };
export type WebhookConfig = { url: string; secret?: string };
export type EmailConfig = { host: string; port: number; secure: boolean; user: string; pass: string; from: string; to: string[] };
export type ChannelConfig = WecomConfig | WebhookConfig | EmailConfig;

/** 修改通道时提交的配置：敏感字段（网址、签名密钥、邮箱密码）留空表示不变；clearSecret 清除 Webhook 签名密钥。 */
export type ChannelConfigPatch = {
  url?: string;
  secret?: string;
  clearSecret?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
  to?: string[];
};

/** 接口返回的非敏感配置：只有邮件通道有，供修改表单回填；网址、签名密钥、密码一律不返回。 */
export type ChannelPublicSettings = { host: string; port: number; secure: boolean; user: string; from: string; to: string[] } | null;

const httpUrl = z
  .string()
  .trim()
  .max(2000, '网址太长')
  .refine((v) => {
    const u = URL.parse(v);
    return !!u && (u.protocol === 'https:' || u.protocol === 'http:');
  }, '网址应以 http:// 或 https:// 开头');
const email = z.string().trim().max(255).regex(/^[^\s@]+@[^\s@]+$/, '邮箱地址格式不正确');

const SCHEMAS = {
  wecom_robot: z.object({ url: httpUrl }),
  webhook: z.object({ url: httpUrl, secret: z.string().max(200, '签名密钥太长').optional() }),
  email: z.object({
    host: z.string().trim().min(1, '请填写 SMTP 服务器').max(255),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().trim().min(1, '请填写用户名').max(255),
    pass: z.string().min(1, '请填写密码').max(500),
    from: email,
    to: z.array(email).min(1, '至少一个收件人').max(50, '收件人最多 50 个'),
  }),
};

export function parseChannelConfig(kind: ChannelKind, raw: unknown): ChannelConfig {
  const r = SCHEMAS[kind].safeParse(raw);
  if (!r.success) {
    throw new AppError('invalid', '通道配置有误', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (kind === 'webhook') {
    const { url, secret } = r.data as WebhookConfig;
    return secret ? { url, secret } : { url };
  }
  return r.data as ChannelConfig;
}

const filled = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v);

export function mergeChannelConfig(kind: ChannelKind, current: ChannelConfig, patch: ChannelConfigPatch): ChannelConfig {
  if (kind === 'wecom_robot') return parseChannelConfig(kind, { url: filled(patch.url) ?? (current as WecomConfig).url });
  if (kind === 'webhook') {
    const c = current as WebhookConfig;
    return parseChannelConfig(kind, { url: filled(patch.url) ?? c.url, secret: patch.clearSecret ? undefined : (filled(patch.secret) ?? c.secret) });
  }
  const c = current as EmailConfig;
  return parseChannelConfig(kind, {
    host: patch.host ?? c.host,
    port: patch.port ?? c.port,
    secure: patch.secure ?? c.secure,
    user: patch.user ?? c.user,
    pass: filled(patch.pass) ?? c.pass,
    from: patch.from ?? c.from,
    to: patch.to ?? c.to,
  });
}

const tail = (s: string): string => `****${s.slice(-4)}`;

function maskUrl(raw: string): string {
  const u = new URL(raw);
  const key = u.searchParams.get('key');
  if (key) return `…/${u.pathname.split('/').filter(Boolean).at(-1) ?? ''}?key=${tail(key)}`;
  return `${u.protocol}//${u.host}/…${tail(raw)}`;
}

/** 脱敏展示文本：不含网址中的密钥、签名密钥、邮箱用户名与密码。 */
export function channelConfigHint(kind: ChannelKind, config: ChannelConfig): string {
  if (kind === 'wecom_robot') return maskUrl((config as WecomConfig).url);
  if (kind === 'webhook') {
    const c = config as WebhookConfig;
    return `${maskUrl(c.url)}${c.secret ? ' · 已设置签名密钥' : ''}`;
  }
  const c = config as EmailConfig;
  return `${c.host}:${c.port} · ${c.from} → ${c.to.length} 个收件人`;
}

export function channelPublicSettings(kind: ChannelKind, config: ChannelConfig): ChannelPublicSettings {
  if (kind !== 'email') return null;
  const { host, port, secure, user, from, to } = config as EmailConfig;
  return { host, port, secure, user, from, to };
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/constants';
export * from './notifications/secrets';
export * from './notifications/channel-config';
```

`packages/core/package.json` 的 `exports` 在 `"./links": "./src/links/syntax.ts",` 之后加一行：

```json
    "./notifications": "./src/notifications/constants.ts",
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/notify-secrets.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/notifications packages/core/src/index.ts packages/core/package.json packages/core/test/notify-secrets.test.ts
git commit -m "feat(core): 推送取值常量、通道配置的 AES-256-GCM 加密与脱敏

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 5 段 cron 与时区（cron-parser）

**Files:**
- Create: `packages/core/src/notifications/cron.ts`
- Modify: `packages/core/package.json`、`pnpm-lock.yaml`（依赖 `cron-parser@5.10.2`）、`packages/core/src/index.ts`
- Test: `packages/core/test/notify-cron.test.ts`

**Interfaces:**
- Consumes: `AppError`
- Produces: `assertCron(expr: string): string`（返回规范化后的表达式）、`assertTimezone(tz: string): string`、`nextRunAt(cron: string, timezone: string, after: Date): Date`（严格晚于 `after`）

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @flower/core add cron-parser@5.10.2 --save-exact`
Expected: `packages/core/package.json` 的 `dependencies` 出现 `"cron-parser": "5.10.2"`（无 `^`），`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 写失败的测试**

新建 `packages/core/test/notify-cron.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { assertCron, assertTimezone, nextRunAt } from '../src/notifications/cron';

describe('cron', () => {
  it('只接受 5 段；规范化空白；字段越界或写错时报错', () => {
    expect(assertCron('  0  19 * *   1-5 ')).toBe('0 19 * * 1-5');
    expect(() => assertCron('0 0 19 * * 1')).toThrow('5 段');
    expect(() => assertCron('')).toThrow('5 段');
    expect(() => assertCron('61 * * * *')).toThrow('无法解析');
    expect(() => assertCron('0 25 * * *')).toThrow('无法解析');
  });

  it('时区必须是 IANA 名称', () => {
    expect(assertTimezone(' Asia/Shanghai ')).toBe('Asia/Shanghai');
    expect(() => assertTimezone('Mars/Base')).toThrow('时区');
    expect(() => assertTimezone('')).toThrow('时区');
  });

  it('按时区计算下一次：工作日 19:00（上海）；严格晚于给定时间', () => {
    // 2026-10-10 是周六
    expect(nextRunAt('0 19 * * 1-5', 'Asia/Shanghai', new Date('2026-10-10T03:00:00Z')).toISOString()).toBe('2026-10-12T11:00:00.000Z');
    expect(nextRunAt('0 19 * * 1-5', 'Asia/Shanghai', new Date('2026-10-12T11:00:00Z')).toISOString()).toBe('2026-10-13T11:00:00.000Z');
    expect(nextRunAt('30 9 * * *', 'Asia/Shanghai', new Date('2026-10-10T01:29:00Z')).toISOString()).toBe('2026-10-10T01:30:00.000Z');
    expect(nextRunAt('0 0 1 * *', 'UTC', new Date('2026-10-10T00:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('夏令时切换日按当地时间计算', () => {
    // 美国东部 2026-11-01 结束夏令时：前一天 9:00 为 UTC 13:00，当天 9:00 为 UTC 14:00
    expect(nextRunAt('0 9 * * *', 'America/New_York', new Date('2026-10-31T12:00:00Z')).toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(nextRunAt('0 9 * * *', 'America/New_York', new Date('2026-10-31T14:00:00Z')).toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/notify-cron.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/cron'`）。

- [ ] **Step 4: 实现**

新建 `packages/core/src/notifications/cron.ts`：

```ts
import { CronExpressionParser } from 'cron-parser';
import { AppError } from '../errors';

/** 校验 5 段 cron（分 时 日 月 周）并规范化空白；cron-parser 同时接受 6 段（含秒），这里只允许 5 段。 */
export function assertCron(expr: string): string {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) throw new AppError('invalid', '定时规则应为 5 段 cron 表达式（分 时 日 月 周）');
  const normalized = fields.join(' ');
  try {
    CronExpressionParser.parse(normalized, { tz: 'UTC' });
  } catch {
    throw new AppError('invalid', `定时规则「${normalized}」无法解析`);
  }
  return normalized;
}

export function assertTimezone(tz: string): string {
  const v = tz.trim();
  if (!v) throw new AppError('invalid', '请填写时区');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
  } catch {
    throw new AppError('invalid', `时区「${v}」无效`);
  }
  return v;
}

/** 严格晚于 after 的下一次执行时间；cron 按 timezone 的当地时间解释（含夏令时）。 */
export function nextRunAt(cron: string, timezone: string, after: Date): Date {
  const it = CronExpressionParser.parse(cron, { currentDate: after, tz: timezone });
  let next = it.next().toDate();
  while (next.getTime() <= after.getTime()) next = it.next().toDate();
  return next;
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/cron';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/notify-cron.test.ts && pnpm typecheck`
Expected: PASS。若 `61 * * * *` 或 `0 25 * * *` 没有被 cron-parser 拒绝，停下来报告（不要放宽测试）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/notifications/cron.ts packages/core/src/index.ts packages/core/test/notify-cron.test.ts
git commit -m "feat(core): 定时推送的 5 段 cron 校验与按时区计算下一次时间（cron-parser 5.10.2）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 消息模板渲染、按通道生成请求体、markdown 拆分

**Files:**
- Create: `packages/core/src/notifications/template.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/notify-template.test.ts`

**Interfaces:**
- Consumes: `ChannelKind`、`TemplateFormat`、`ChannelPayload`（Task 1）
- Produces:
  - `renderTemplate(body: string, data: Record<string, unknown>): string`
  - `assertTemplateBody(format: TemplateFormat, body: string): void`（语法错误、卡片不是 JSON 对象时抛 `AppError('invalid')`）
  - `type RenderedMessage = { format: 'text' | 'markdown' | 'email'; text: string } | { format: 'template_card'; card: Record<string, unknown> }`
  - `renderMessage(format: TemplateFormat, body: string, data: Record<string, unknown>): RenderedMessage`
  - `toChannelPayloads(kind: ChannelKind, msg: RenderedMessage): ChannelPayload[]`
  - `splitMarkdown(text: string, maxBytes?: number): string[]`、`truncateBytes(s: string, maxBytes: number): string`、`payloadPreview(payload: DeliveryPayload | null): string`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/notify-template.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { assertTemplateBody, payloadPreview, renderMessage, renderTemplate, splitMarkdown, toChannelPayloads, truncateBytes } from '../src/notifications/template';

describe('模板渲染', () => {
  it('字段替换：点号路径；缺字段、null、对象渲染为空串；数字与布尔转文字', () => {
    expect(renderTemplate('{{a.b}}-{{missing}}-{{n}}-{{flag}}-{{obj}}-{{nil}}', { a: { b: '值' }, n: 3, flag: true, obj: { x: 1 }, nil: null })).toBe('值--3-true--');
  });

  it('列表重复：项内先查项再查外层；非空值渲染一次；反向区块在值为空时渲染', () => {
    const tpl = '{{#items}}[{{name}}@{{group}}]{{/items}}{{#note}}<{{note}}>{{/note}}{{^items}}无{{/items}}';
    expect(renderTemplate(tpl, { group: 'G', items: [{ name: 'a' }, { name: 'b', group: 'H' }], note: '备注' })).toBe('[a@G][b@H]<备注>');
    expect(renderTemplate(tpl, { items: [] })).toBe('无');
  });

  it('独占一行的区块标签连同换行去掉', () => {
    const tpl = '标题\n{{#items}}\n- {{.}}{{name}}\n{{/items}}\n结尾';
    expect(renderTemplate(tpl, { items: [{ name: '一' }, { name: '二' }] })).toBe('标题\n- 一\n- 二\n结尾');
  });

  it('语法错误：区块没有结束、结束标签不配对；卡片必须是 JSON 对象', () => {
    expect(() => assertTemplateBody('markdown', '{{#a}}x')).toThrow('模板语法错误');
    expect(() => assertTemplateBody('markdown', '{{#a}}x{{/b}}')).toThrow('模板语法错误');
    expect(() => assertTemplateBody('template_card', '[1]')).toThrow('模板卡片的内容应为 JSON 对象');
    expect(() => assertTemplateBody('template_card', '{"main_title":{"title":"{{#x}}"}}')).toThrow('模板语法错误');
    expect(() => assertTemplateBody('text', '你好 {{name}}')).not.toThrow();
  });

  it('卡片：只替换字符串值；文本类去掉首尾空白', () => {
    const card = renderMessage('template_card', '{"card_type":"text_notice","main_title":{"title":"{{t}}"},"jump_list":[{"type":1,"url":"{{u}}"}]}', { t: '日报', u: 'http://127.0.0.1/x' });
    expect(card).toEqual({ format: 'template_card', card: { card_type: 'text_notice', main_title: { title: '日报' }, jump_list: [{ type: 1, url: 'http://127.0.0.1/x' }] } });
    expect(renderMessage('markdown', '\n**{{t}}**\n\n', { t: '标题' })).toEqual({ format: 'markdown', text: '**标题**' });
  });
});

describe('按通道生成请求体', () => {
  const md = { format: 'markdown' as const, text: '# 标题\n正文' };
  const card = { format: 'template_card' as const, card: { card_type: 'text_notice', main_title: { title: '日报 · 2026-10-09', desc: '1016 发版' }, jump_list: [{ type: 1, title: '查看', url: 'http://127.0.0.1/i/1' }] } };

  it('企微：文本、markdown、模板卡片、邮件格式转文本', () => {
    expect(toChannelPayloads('wecom_robot', md)).toEqual([{ type: 'json', body: { msgtype: 'markdown', markdown: { content: '# 标题\n正文' } } }]);
    expect(toChannelPayloads('wecom_robot', { format: 'text', text: '你好' })).toEqual([{ type: 'json', body: { msgtype: 'text', text: { content: '你好' } } }]);
    expect(toChannelPayloads('wecom_robot', card)).toEqual([{ type: 'json', body: { msgtype: 'template_card', template_card: card.card } }]);
    expect(toChannelPayloads('wecom_robot', { format: 'email', text: '主题\n正文' })).toEqual([{ type: 'json', body: { msgtype: 'text', text: { content: '主题\n正文' } } }]);
  });

  it('Webhook：{format, content}；卡片的 content 为对象', () => {
    expect(toChannelPayloads('webhook', md)).toEqual([{ type: 'json', body: { format: 'markdown', content: '# 标题\n正文' } }]);
    expect(toChannelPayloads('webhook', card)).toEqual([{ type: 'json', body: { format: 'template_card', content: card.card } }]);
  });

  it('邮件：主题取第一行并去掉 markdown 标记；email 格式第一行是主题；卡片取标题、描述与链接', () => {
    expect(toChannelPayloads('email', { format: 'markdown', text: '**PAN-1 新建需求**\n> 详情' })).toEqual([{ type: 'email', subject: 'PAN-1 新建需求', text: '**PAN-1 新建需求**\n> 详情' }]);
    expect(toChannelPayloads('email', { format: 'email', text: '周报\n第一行\n第二行' })).toEqual([{ type: 'email', subject: '周报', text: '第一行\n第二行' }]);
    expect(toChannelPayloads('email', card)).toEqual([{ type: 'email', subject: '日报 · 2026-10-09', text: '1016 发版\n查看：http://127.0.0.1/i/1' }]);
  });

  it('markdown 超过 4096 字节按段拆分，第 2 条起标题加「（续n）」；单段过长截断', () => {
    const para = (i: number) => `**${i}. ${'需求标题'.repeat(30)}**`;
    const text = ['# 📋 10/9 新增需求', ...Array.from({ length: 20 }, (_, i) => para(i + 1))].join('\n\n');
    const parts = splitMarkdown(text, 4096);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(4096);
    expect(parts[0]!.startsWith('# 📋 10/9 新增需求\n\n**1.')).toBe(true);
    expect(parts[1]!.startsWith('# 📋 10/9 新增需求（续2）\n\n')).toBe(true);
    expect(parts.join('\n')).toContain('**20.');
    expect(splitMarkdown('短文本')).toEqual(['短文本']);
    const long = truncateBytes('字'.repeat(3000), 2048);
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(2048);
    expect(long.endsWith('…')).toBe(true);
  });

  it('内容摘要：各类请求体取主要文字，最多 200 字', () => {
    expect(payloadPreview(null)).toBe('（发送前渲染）');
    expect(payloadPreview({ type: 'json', body: { msgtype: 'markdown', markdown: { content: '# 标题' } } })).toBe('# 标题');
    expect(payloadPreview({ type: 'json', body: { msgtype: 'template_card', template_card: card.card } })).toBe('日报 · 2026-10-09 · 1016 发版');
    expect(payloadPreview({ type: 'json', body: { format: 'text', content: '你好' } })).toBe('你好');
    expect(payloadPreview({ type: 'email', subject: '周报', text: '正文' })).toBe('周报');
    expect(payloadPreview({ type: 'legacy', content: 'x'.repeat(300) })).toHaveLength(200);
  });
});
```

注意第三个用例里 `{{.}}` 不是合法路径（`[\w.]+` 允许点号，但查不到值），渲染为空串，用来确认未知路径不会报错。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/notify-template.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/template'`）。

- [ ] **Step 3: 实现**

新建 `packages/core/src/notifications/template.ts`：

```ts
import { AppError } from '../errors';
import type { ChannelKind, ChannelPayload, DeliveryPayload, TemplateFormat } from './constants';

type Node = { t: 'text'; v: string } | { t: 'var'; path: string } | { t: 'section'; path: string; inverted: boolean; children: Node[] };

const TAG = /\{\{\s*([#^/]?)\s*([\w.]+)\s*\}\}/g;
/** 独占一行的区块标签（{{#x}}、{{^x}}、{{/x}}）连同行尾换行一起去掉，模板可以按行书写。 */
const STANDALONE = /^[ \t]*(\{\{\s*[#^/]\s*[\w.]+\s*\}\})[ \t]*(?:\r?\n|$)/gm;

function parseTemplate(body: string): Node[] {
  const src = body.replace(STANDALONE, '$1');
  const root: Node[] = [];
  const stack: Array<{ path: string; children: Node[] }> = [{ path: '', children: root }];
  let last = 0;
  for (const m of src.matchAll(TAG)) {
    const top = stack.at(-1)!;
    if (m.index > last) top.children.push({ t: 'text', v: src.slice(last, m.index) });
    last = m.index + m[0].length;
    const sigil = m[1];
    const path = m[2]!;
    if (sigil === '#' || sigil === '^') {
      const node: Node = { t: 'section', path, inverted: sigil === '^', children: [] };
      top.children.push(node);
      stack.push({ path, children: node.children });
    } else if (sigil === '/') {
      if (stack.length === 1 || top.path !== path) throw new AppError('invalid', `模板语法错误：{{/${path}}} 没有对应的开始标签`);
      stack.pop();
    } else {
      top.children.push({ t: 'var', path });
    }
  }
  if (stack.length > 1) {
    const open = stack.at(-1)!.path;
    throw new AppError('invalid', `模板语法错误：{{#${open}}} 没有对应的 {{/${open}}}`);
  }
  if (last < src.length) root.push({ t: 'text', v: src.slice(last) });
  return root;
}

/** 从内到外查找路径的第一段，找到所在的上下文后按点号取值。 */
function lookup(stack: unknown[], path: string): unknown {
  const parts = path.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx !== null && typeof ctx === 'object' && !Array.isArray(ctx) && parts[0]! in ctx) {
      let v: unknown = ctx;
      for (const p of parts) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined;
      return v;
    }
  }
  return undefined;
}

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0);
const toText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

function render(nodes: Node[], stack: unknown[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'var') out += toText(lookup(stack, n.path));
    else {
      const v = lookup(stack, n.path);
      if (n.inverted) {
        if (isEmpty(v)) out += render(n.children, stack);
      } else if (Array.isArray(v)) {
        for (const item of v) out += render(n.children, [...stack, item]);
      } else if (!isEmpty(v)) {
        out += render(n.children, [...stack, v]);
      }
    }
  }
  return out;
}

/** {{path}} 字段替换；{{#path}}…{{/path}} 按列表重复或在非空时渲染；{{^path}}…{{/path}} 在为空时渲染。不执行代码。 */
export function renderTemplate(body: string, data: Record<string, unknown>): string {
  return render(parseTemplate(body), [data]);
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

function parseCard(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError('invalid', '模板卡片的内容应为 JSON 对象');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('invalid', '模板卡片的内容应为 JSON 对象');
  return parsed as Record<string, unknown>;
}

export function assertTemplateBody(format: TemplateFormat, body: string): void {
  if (format === 'template_card') {
    mapStrings(parseCard(body), (s) => {
      parseTemplate(s);
      return s;
    });
  } else {
    parseTemplate(body);
  }
}

export type RenderedMessage = { format: 'text' | 'markdown' | 'email'; text: string } | { format: 'template_card'; card: Record<string, unknown> };

export function renderMessage(format: TemplateFormat, body: string, data: Record<string, unknown>): RenderedMessage {
  if (format === 'template_card') return { format, card: mapStrings(parseCard(body), (s) => renderTemplate(s, data)) as Record<string, unknown> };
  return { format, text: renderTemplate(body, data).trim() };
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** 按 UTF-8 字节截断，超出时以「…」结尾。 */
export function truncateBytes(s: string, maxBytes: number): string {
  if (bytes(s) <= maxBytes) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (n + b > maxBytes - 3) break;
    out += ch;
    n += b;
  }
  return `${out}…`;
}

/**
 * 企微 markdown 每条最多 4096 字节：按空行分段装箱；第一行是标题（以 # 开头）时，
 * 第 2 条起标题加「（续n）」。单段过长时截断。
 */
export function splitMarkdown(text: string, maxBytes = 4096): string[] {
  if (bytes(text) <= maxBytes) return [text];
  const lines = text.split('\n');
  const heading = lines[0]!.startsWith('#') ? lines[0]! : null;
  const paras = (heading ? lines.slice(1).join('\n') : text).split(/\n{2,}/).filter((p) => p.trim() !== '');
  const head = (i: number): string => (heading === null ? '' : i === 0 ? heading : `${heading}（续${i + 1}）`);
  const compose = (i: number, parts: string[]): string => [head(i), ...parts].filter(Boolean).join('\n\n');
  const chunks: string[] = [];
  let body: string[] = [];
  for (const p of paras) {
    if (bytes(compose(chunks.length, [...body, p])) <= maxBytes) {
      body.push(p);
      continue;
    }
    if (body.length > 0) {
      chunks.push(compose(chunks.length, body));
      body = [];
    }
    if (bytes(compose(chunks.length, [p])) <= maxBytes) body.push(p);
    else chunks.push(truncateBytes(compose(chunks.length, [p]), maxBytes));
  }
  if (body.length > 0 || chunks.length === 0) chunks.push(compose(chunks.length, body));
  return chunks;
}

const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), obj);

const cardLinks = (card: Record<string, unknown>): string[] => {
  const list = Array.isArray(card.jump_list) ? card.jump_list : [];
  return list.map((j) => `${toText(get(j, 'title'))}：${toText(get(j, 'url'))}`);
};

const subjectLine = (text: string): string =>
  (text.split('\n').find((l) => l.trim() !== '') ?? '')
    .replace(/^[#>\s*]+/, '')
    .replace(/\*+$/, '')
    .trim();

/** 渲染结果 → 通道的请求体。企微 markdown 可能拆成多条，其余都是一条。 */
export function toChannelPayloads(kind: ChannelKind, msg: RenderedMessage): ChannelPayload[] {
  if (kind === 'email') {
    if (msg.format === 'template_card') {
      const lines = [toText(get(msg.card, 'main_title.desc')), ...cardLinks(msg.card)].filter(Boolean);
      return [{ type: 'email', subject: toText(get(msg.card, 'main_title.title')) || 'Flower 推送', text: lines.join('\n') }];
    }
    if (msg.format === 'email') {
      const [first, ...rest] = msg.text.split('\n');
      return [{ type: 'email', subject: first!.trim() || 'Flower 推送', text: rest.join('\n').trim() }];
    }
    return [{ type: 'email', subject: subjectLine(msg.text) || 'Flower 推送', text: msg.text }];
  }
  if (kind === 'webhook') {
    return [{ type: 'json', body: msg.format === 'template_card' ? { format: msg.format, content: msg.card } : { format: msg.format, content: msg.text } }];
  }
  if (msg.format === 'template_card') return [{ type: 'json', body: { msgtype: 'template_card', template_card: msg.card } }];
  if (msg.format === 'markdown') return splitMarkdown(msg.text).map((content) => ({ type: 'json' as const, body: { msgtype: 'markdown', markdown: { content } } }));
  return [{ type: 'json', body: { msgtype: 'text', text: { content: truncateBytes(msg.text, 2048) } } }];
}

/** 发送记录页的内容摘要（最多 200 字），不含任何通道配置。 */
export function payloadPreview(payload: DeliveryPayload | null): string {
  if (!payload) return '（发送前渲染）';
  let text: string;
  if (payload.type === 'legacy') text = payload.content;
  else if (payload.type === 'email') text = payload.subject;
  else {
    const b = payload.body;
    const card = b.msgtype === 'template_card' ? b.template_card : b.format === 'template_card' ? b.content : null;
    if (card) text = [toText(get(card, 'main_title.title')), toText(get(card, 'main_title.desc'))].filter(Boolean).join(' · ');
    else text = toText(get(b, 'markdown.content')) || toText(get(b, 'text.content')) || toText(b.content);
  }
  return text.slice(0, 200);
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/template';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/notify-template.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/notifications/template.ts packages/core/src/index.ts packages/core/test/notify-template.test.ts
git commit -m "feat(core): 推送消息模板渲染、按通道生成请求体与 markdown 分条

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: 数据模型：六张推送表（RLS）、迁移工具清理

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Create: `packages/core/migrations/0015_*.sql`（生成）、`packages/core/migrations/0016_p3a_rls.sql`（`--custom` 生成后填写）、`packages/core/migrations/meta/*`（生成）
- Modify: `packages/migrate/src/write.ts`
- Modify: `docs/superpowers/specs/2026-10-10-flower-p3a-notifications-design.md`（实现补充）
- Test: `packages/core/test/p3a-schema.test.ts`、`packages/migrate/test/write.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CHANNEL_KINDS`、`TEMPLATE_FORMATS`、`BUILTIN_TEMPLATE_KEYS`、`RULE_MODES`、`SCHEDULE_SOURCES`、`DELIVERY_KINDS`、`DELIVERY_STATUSES`、`ALERT_STATES`、`RuleFilter`、`DeliveryPayload`
- Produces（drizzle 表，经 `@flower/core` 导出）:
  - `notificationChannels`（`id, orgId, kind, name, groupLabel, config, configHint, rateLimitPerMin, allowedProductIds: string[], enabled, createdAt, updatedAt`）
  - `messageTemplates`（`id, orgId, name, format, body, builtin, builtinKey, createdAt, updatedAt`）
  - `notificationSchedules`（`id, orgId, productId, name, cron, timezone, source, sourceConfig, channelIds: string[], templateId, enabled, nextRunAt, lastRunAt, lastSuccessAt, consecutiveFailures, failThreshold, alertState, lastError, createdAt, updatedAt`）
  - `notificationRules`（`id, orgId, productId, name, eventTypes: string[], filter: RuleFilter, channelIds: string[], templateId, mode, digestScheduleId, enabled, createdAt, updatedAt`）
  - `notificationDigestItems`（`id, orgId, ruleId, scheduleId, eventId, runId, createdAt, consumedAt`）
  - `notificationDeliveries`（`id, orgId, kind, ruleId, scheduleId, runId, channelId, eventId, payload: DeliveryPayload | null, status, attempts, nextAttemptAt, response, sentAt, createdAt, legacyKey`）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/p3a-schema.test.ts`：

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  domainEvents,
  messageTemplates,
  notificationChannels,
  notificationDeliveries,
  notificationDigestItems,
  notificationRules,
  notificationSchedules,
  organizations,
  products,
} from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const channel = newId();
const schedule = newId();
const rule = newId();
const event = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
  await t.adminDb.insert(domainEvents).values({ id: event, orgId: orgA, productId: productA, type: 'requirement.created', subjectType: 'requirement', subjectId: newId(), payload: {} });
});
afterAll(() => t.cleanup());

const TABLES = [notificationChannels, messageTemplates, notificationSchedules, notificationRules, notificationDigestItems, notificationDeliveries];

describe('P3-A 数据模型', () => {
  it('六张表都受行级安全约束，各有一条策略', async () => {
    await withOrg(t.db, orgA, async (tx) => {
      await tx.insert(notificationChannels).values({ id: channel, orgId: orgA, kind: 'wecom_robot', name: '研发群', config: 'v1:a:b:c', configHint: '…/send?key=****0001', rateLimitPerMin: 20 });
      await tx.insert(messageTemplates).values({ orgId: orgA, name: '自定义', format: 'markdown', body: '**{{subject.title}}**' });
      await tx.insert(notificationSchedules).values({ id: schedule, orgId: orgA, productId: productA, name: '摘要', cron: '0 18 * * *', source: 'digest', channelIds: [channel] });
      await tx.insert(notificationRules).values({ id: rule, orgId: orgA, productId: productA, name: '状态变化', eventTypes: ['requirement.state_changed'], mode: 'digest', digestScheduleId: schedule });
      await tx.insert(notificationDigestItems).values({ orgId: orgA, ruleId: rule, scheduleId: schedule, eventId: event });
      await tx.insert(notificationDeliveries).values({ orgId: orgA, kind: 'test', channelId: channel, payload: { type: 'json', body: { msgtype: 'text', text: { content: '测试' } } } });
    });
    for (const table of TABLES) {
      expect(await withOrg(t.db, orgA, (tx) => tx.select().from(table))).toHaveLength(1);
      expect(await withOrg(t.db, orgB, (tx) => tx.select().from(table))).toHaveLength(0);
    }
    const [{ n }] = (await t.adminDb.execute(
      sql`select count(*)::int as n from pg_policies where tablename in ('notification_channels', 'message_templates', 'notification_schedules', 'notification_rules', 'notification_digest_items', 'notification_deliveries')`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(6);
  });

  it('默认值', async () => {
    const [c] = await t.adminDb.select().from(notificationChannels);
    expect(c).toMatchObject({ enabled: true, allowedProductIds: [], groupLabel: null });
    const [s] = await t.adminDb.select().from(notificationSchedules);
    expect(s).toMatchObject({ timezone: 'Asia/Shanghai', failThreshold: 1, consecutiveFailures: 0, alertState: 'normal', enabled: true, nextRunAt: null, sourceConfig: {}, lastError: null });
    const [d] = await t.adminDb.select().from(notificationDeliveries);
    expect(d).toMatchObject({ status: 'pending', attempts: 0, runId: null, legacyKey: null, sentAt: null });
    const [r] = await t.adminDb.select().from(notificationRules);
    expect(r).toMatchObject({ filter: {}, channelIds: [], enabled: true, templateId: null });
  });

  it('约束：摘要规则与摘要定时推送成对；记录的来源与 kind 一致；预置模板与 builtin_key 成对且每种一个；通道同名；摘要条目不重复', async () => {
    await expect(t.adminDb.insert(notificationRules).values({ orgId: orgA, productId: productA, name: 'x', eventTypes: ['requirement.created'], mode: 'digest' })).rejects.toThrow();
    await expect(
      t.adminDb.insert(notificationRules).values({ orgId: orgA, productId: productA, name: 'x', eventTypes: ['requirement.created'], mode: 'immediate', digestScheduleId: schedule }),
    ).rejects.toThrow();
    await expect(t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'rule', channelId: channel })).rejects.toThrow();
    await expect(t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'test', channelId: channel, scheduleId: schedule })).rejects.toThrow();
    await t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'schedule', channelId: channel, scheduleId: schedule });
    await expect(t.adminDb.insert(messageTemplates).values({ orgId: orgA, name: '预置', format: 'markdown', body: 'x', builtin: true })).rejects.toThrow();
    await t.adminDb.insert(messageTemplates).values({ orgId: orgA, name: '默认 · 事件推送', format: 'markdown', body: 'x', builtin: true, builtinKey: 'event' });
    await expect(t.adminDb.insert(messageTemplates).values({ orgId: orgA, name: '另一个', format: 'markdown', body: 'x', builtin: true, builtinKey: 'event' })).rejects.toThrow();
    await expect(t.adminDb.insert(notificationChannels).values({ orgId: orgA, kind: 'webhook', name: '研发群', config: 'v1:a:b:c', configHint: 'h', rateLimitPerMin: 60 })).rejects.toThrow();
    await expect(t.adminDb.insert(notificationDigestItems).values({ orgId: orgA, ruleId: rule, scheduleId: schedule, eventId: event })).rejects.toThrow();
  });
});
```

`packages/migrate/test/write.test.ts`：

1. `@flower/core` 的 import 列表按字母序加入 `domainEvents`、`messageTemplates`、`notificationChannels`、`notificationDeliveries`、`notificationDigestItems`、`notificationRules`、`notificationSchedules`。
2. 「导入后有过正常使用……仍可以 replace」用例里，`await t.adminDb.insert(iterationScopeSnapshots).values(…);` 之后加：

```ts
    const [createdEvent] = await t.adminDb.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.subjectId, created.id));
    const [ch] = await t.adminDb
      .insert(notificationChannels)
      .values({ orgId: actor.orgId, kind: 'wecom_robot', name: '导入后通道', config: 'v1:a:b:c', configHint: 'h', rateLimitPerMin: 20 })
      .returning();
    const [tpl] = await t.adminDb.insert(messageTemplates).values({ orgId: actor.orgId, name: '导入后模板', format: 'markdown', body: 'x' }).returning();
    const [sch] = await t.adminDb
      .insert(notificationSchedules)
      .values({ orgId: actor.orgId, productId: product!.id, name: '导入后摘要', cron: '0 18 * * *', source: 'digest', channelIds: [ch!.id], templateId: tpl!.id })
      .returning();
    const [rl] = await t.adminDb
      .insert(notificationRules)
      .values({ orgId: actor.orgId, productId: product!.id, name: '导入后规则', eventTypes: ['requirement.created'], mode: 'digest', digestScheduleId: sch!.id, templateId: tpl!.id })
      .returning();
    await t.adminDb.insert(notificationDigestItems).values({ orgId: actor.orgId, ruleId: rl!.id, scheduleId: sch!.id, eventId: createdEvent!.id });
    await t.adminDb.insert(notificationDeliveries).values({ orgId: actor.orgId, kind: 'rule', ruleId: rl!.id, channelId: ch!.id, eventId: createdEvent!.id });
```

3. 同一用例 `expect(await t.adminDb.select().from(documentAffectedNodes)).toEqual([]);` 之后加：

```ts
    for (const table of [notificationDigestItems, notificationDeliveries, notificationRules, notificationSchedules, messageTemplates, notificationChannels]) {
      expect(await t.adminDb.select().from(table)).toEqual([]);
    }
```

Run: `pnpm --filter @flower/core exec vitest run test/p3a-schema.test.ts`
Expected: FAIL（`notificationChannels` 不是 schema 的导出）。

Run: `pnpm --filter @flower/migrate exec vitest run test/write.test.ts`
Expected: FAIL（`notificationChannels` 不是 `@flower/core` 的导出）。

- [ ] **Step 2: 表结构**

`packages/core/src/db/schema.ts`：

1. 在 `import { LINK_ORIGINS, LINK_SOURCE_TYPES, LINK_TARGET_TYPES } from '../links/syntax';` 之后加：

```ts
import {
  ALERT_STATES,
  BUILTIN_TEMPLATE_KEYS,
  CHANNEL_KINDS,
  DELIVERY_KINDS,
  DELIVERY_STATUSES,
  type DeliveryPayload,
  RULE_MODES,
  type RuleFilter,
  SCHEDULE_SOURCES,
  TEMPLATE_FORMATS,
} from '../notifications/constants';
```

2. 文件末尾（`documentAffectedNodes` 之后）加：

```ts
// ---------- P3-A：推送 ----------

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: id(),
    orgId: orgRef(),
    kind: text('kind', { enum: CHANNEL_KINDS }).notNull(),
    name: text('name').notNull(),
    /** 所属群，仅用于展示与归组。 */
    groupLabel: text('group_label'),
    /** 加密后的配置（notifications/secrets.ts 的 `v1:…`），明文只在发送时解密。 */
    config: text('config').notNull(),
    configHint: text('config_hint').notNull(),
    rateLimitPerMin: integer('rate_limit_per_min').notNull(),
    /** 空数组表示全部产品。 */
    allowedProductIds: uuid('allowed_product_ids').array().notNull().default(sql`'{}'`),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_channels_org_name').on(t.orgId, t.name), check('notification_channels_rate', sql`${t.rateLimitPerMin} between 1 and 600`)],
);

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: id(),
    orgId: orgRef(),
    name: text('name').notNull(),
    format: text('format', { enum: TEMPLATE_FORMATS }).notNull(),
    body: text('body').notNull(),
    builtin: boolean('builtin').notNull().default(false),
    /** 预置模板的用途；自建模板为空。 */
    builtinKey: text('builtin_key', { enum: BUILTIN_TEMPLATE_KEYS }),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_templates_org_name').on(t.orgId, t.name),
    uniqueIndex('message_templates_org_builtin').on(t.orgId, t.builtinKey).where(sql`${t.builtinKey} is not null`),
    check('message_templates_builtin', sql`${t.builtin} = (${t.builtinKey} is not null)`),
  ],
);

export const notificationSchedules = pgTable(
  'notification_schedules',
  {
    id: id(),
    orgId: orgRef(),
    /** P3-A 的三种来源都必须有产品（服务层校验）；列可空，留给以后的组织级来源。 */
    productId: uuid('product_id').references(() => products.id),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    source: text('source', { enum: SCHEDULE_SOURCES }).notNull(),
    sourceConfig: jsonb('source_config').$type<Record<string, unknown>>().notNull().default({}),
    channelIds: uuid('channel_ids').array().notNull().default(sql`'{}'`),
    templateId: uuid('template_id').references(() => messageTemplates.id),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: ts('next_run_at'),
    lastRunAt: ts('last_run_at'),
    lastSuccessAt: ts('last_success_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    failThreshold: integer('fail_threshold').notNull().default(1),
    alertState: text('alert_state', { enum: ALERT_STATES }).notNull().default('normal'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('notification_schedules_product').on(t.productId),
    index('notification_schedules_due').on(t.nextRunAt).where(sql`${t.enabled}`),
    check('notification_schedules_threshold', sql`${t.failThreshold} between 1 and 10`),
  ],
);

export const notificationRules = pgTable(
  'notification_rules',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    name: text('name').notNull(),
    eventTypes: text('event_types').array().notNull(),
    filter: jsonb('filter').$type<RuleFilter>().notNull().default({}),
    /** 即时规则的通道；摘要规则为空（用定时推送的通道）。 */
    channelIds: uuid('channel_ids').array().notNull().default(sql`'{}'`),
    templateId: uuid('template_id').references(() => messageTemplates.id),
    mode: text('mode', { enum: RULE_MODES }).notNull().default('immediate'),
    digestScheduleId: uuid('digest_schedule_id').references(() => notificationSchedules.id),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('notification_rules_product').on(t.productId), check('notification_rules_digest', sql`(${t.mode} = 'digest') = (${t.digestScheduleId} is not null)`)],
);

export const notificationDigestItems = pgTable(
  'notification_digest_items',
  {
    id: id(),
    orgId: orgRef(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => notificationRules.id),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => notificationSchedules.id),
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id),
    /** 被某次执行取用后、发送成功前的执行 id；该次全部放弃时清空，留给下一次。 */
    runId: uuid('run_id'),
    createdAt: createdAt(),
    consumedAt: ts('consumed_at'),
  },
  (t) => [
    uniqueIndex('notification_digest_items_rule_event').on(t.ruleId, t.eventId),
    index('notification_digest_items_open').on(t.scheduleId, t.createdAt).where(sql`${t.consumedAt} is null`),
    index('notification_digest_items_run').on(t.runId),
  ],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: id(),
    orgId: orgRef(),
    kind: text('kind', { enum: DELIVERY_KINDS }).notNull(),
    ruleId: uuid('rule_id').references(() => notificationRules.id),
    scheduleId: uuid('schedule_id').references(() => notificationSchedules.id),
    /** 同一次定时执行的记录共享，用于执行结果与告警。 */
    runId: uuid('run_id'),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id),
    eventId: uuid('event_id').references(() => domainEvents.id),
    /** 渲染后的请求体；事件规则的记录在第一次发送前渲染，此前为空。 */
    payload: jsonb('payload').$type<DeliveryPayload>(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** 待发、失败待重试时为下次尝试时间；发送中为租约到期时间。 */
    nextAttemptAt: ts('next_attempt_at'),
    response: text('response'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
    legacyKey: text('legacy_key'),
  },
  (t) => [
    index('notification_deliveries_due').on(t.nextAttemptAt).where(sql`${t.status} in ('pending', 'failed', 'sending')`),
    index('notification_deliveries_channel_sent').on(t.channelId, t.sentAt),
    index('notification_deliveries_org_created').on(t.orgId, t.createdAt.desc()),
    index('notification_deliveries_run').on(t.runId),
    check(
      'notification_deliveries_source',
      sql`(${t.kind} = 'rule' and ${t.ruleId} is not null and ${t.scheduleId} is null) or (${t.kind} = 'schedule' and ${t.scheduleId} is not null and ${t.ruleId} is null) or (${t.kind} = 'test' and ${t.ruleId} is null and ${t.scheduleId} is null)`,
    ),
  ],
);
```

- [ ] **Step 3: 生成迁移**

Run: `pnpm --filter @flower/core db:generate`
Expected: 生成 `packages/core/migrations/0015_<随机名>.sql` 与 `meta/0015_snapshot.json`，`_journal.json` 增加一项。核对文件里有六条 `CREATE TABLE`（`notification_channels`、`message_templates`、`notification_schedules`、`notification_rules`、`notification_digest_items`、`notification_deliveries`）、全部外键、上面列出的索引与四个检查约束（`notification_channels_rate`、`message_templates_builtin`、`notification_schedules_threshold`、`notification_rules_digest`、`notification_deliveries_source`），数组列带 `DEFAULT '{}'`。缺任何一项，或出现与本任务无关的语句，停下来报告。

Run: `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p3a_rls`
Expected: 生成空的 `packages/core/migrations/0016_p3a_rls.sql`。填入：

```sql
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'notification_channels', 'message_templates', 'notification_schedules',
    'notification_rules', 'notification_digest_items', 'notification_deliveries'
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
```

- [ ] **Step 4: 迁移工具：`--replace` 删除推送数据**

`packages/migrate/src/write.ts` 的 `deleteOrgData`：把

```ts
  await tx.execute(sql`delete from ${core.entityLinks} where org_id = ${orgId}`);
```

替换为：

```ts
  await tx.execute(sql`delete from ${core.entityLinks} where org_id = ${orgId}`);
  // 推送：摘要条目与发送记录引用规则、定时推送、通道与领域事件，规则引用定时推送与模板，定时推送引用模板与产品
  for (const table of [core.notificationDigestItems, core.notificationDeliveries, core.notificationRules, core.notificationSchedules, core.messageTemplates, core.notificationChannels]) {
    await tx.execute(sql`delete from ${table} where org_id = ${orgId}`);
  }
```

- [ ] **Step 5: 设计文档的实现补充**

`docs/superpowers/specs/2026-10-10-flower-p3a-notifications-design.md` §6 末尾（「发送记录页（组织设置）……」这一条之后）加一条：

```
- 实现补充（2026-10-10，见 P3-A 计划「设计决定」）：`notification_deliveries` 增加 `kind`（rule / schedule / test）与 `run_id`（同一次定时执行的记录共享，用于执行结果与告警）；`notification_digest_items` 增加 `run_id`；`notification_schedules` 增加 `last_error`；`message_templates` 增加 `builtin_key`（预置模板的用途）。P3-A 的三种内容来源都要求选择产品。
```

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/p3a-schema.test.ts test/rls.test.ts && pnpm --filter @flower/migrate exec vitest run test/write.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/db/schema.ts packages/core/migrations packages/core/test/p3a-schema.test.ts packages/migrate/src/write.ts packages/migrate/test/write.test.ts docs/superpowers/specs/2026-10-10-flower-p3a-notifications-design.md
git commit -m "feat(core): 推送六张表（通道、模板、定时推送、规则、摘要条目、发送记录）与 RLS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: 通道服务（登记、修改、停用、删除、产品可用的通道）

**Files:**
- Create: `packages/core/src/notifications/channels.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/notify-helpers.ts`
- Test: `packages/core/test/notify-channels.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseChannelConfig`、`mergeChannelConfig`、`channelConfigHint`、`channelPublicSettings`、`encryptConfig`、`decryptConfig`、`DEFAULT_RATE_LIMIT`；Task 4 的表
- Produces:
  - `type SecretDeps = { secretKey: string }`、`type ChannelRow = typeof notificationChannels.$inferSelect`
  - `type ChannelView = { id; kind: ChannelKind; name; groupLabel: string | null; configHint; settings: ChannelPublicSettings; rateLimitPerMin; allowedProductIds: string[]; enabled; createdAt: Date; updatedAt: Date; usage: { rules: number; schedules: number; deliveries: number } }`
  - `type ChannelOption = { id; kind: ChannelKind; name; groupLabel: string | null; enabled: boolean }`
  - `type ChannelInput = { kind: ChannelKind; name: string; groupLabel?: string | null; config: unknown; rateLimitPerMin?: number; allowedProductIds?: string[]; enabled?: boolean }`
  - `type ChannelPatch = { name?: string; groupLabel?: string | null; config?: ChannelConfigPatch; rateLimitPerMin?: number; allowedProductIds?: string[]; enabled?: boolean }`
  - `listChannels(db, actor, deps: SecretDeps): Promise<ChannelView[]>`、`createChannel(db, actor, input, deps): Promise<ChannelView>`、`updateChannel(db, actor, id, patch, deps): Promise<ChannelView>`、`deleteChannel(db, actor, id): Promise<void>`、`listProductChannelOptions(db, actor, productId): Promise<ChannelOption[]>`
  - `readChannelConfig(row: ChannelRow, secretKey: string): ChannelConfig`
  - `usableChannelsTx(tx, ids: string[] | null, productId: string | null): Promise<ChannelRow[]>`（启用且对该产品可用）
  - `assertUsableChannelsTx(tx, ids: string[], productId: string | null, opts: { min: number }): Promise<string[]>`（去重后 min–10 个，全部可用，否则 `AppError('invalid', '通道不存在、已停用或不允许本产品使用')`）
  - `channelOption(row: ChannelRow): ChannelOption`
  - 测试辅助 `test/notify-helpers.ts`：`TEST_SECRET`、`TEST_DEPS = { secretKey, publicUrl: 'http://flower.example.com' }`、`WECOM_URL`、`wecomChannel(db, actor, name, extra?)`

- [ ] **Step 1: 写测试辅助与失败的测试**

新建 `packages/core/test/notify-helpers.ts`：

```ts
import type { Db } from '../src/db/client';
import type { Actor } from '../src/domain-types';
import { type ChannelView, createChannel } from '../src/notifications/channels';

export const TEST_SECRET = 'notify-test-secret-notify-test-secret-0001';
export const TEST_DEPS = { secretKey: TEST_SECRET, publicUrl: 'http://flower.example.com' };
/** 指向本机不可达端口的虚构地址；测试里的发送一律经注入的 Transport，不会真的发出。 */
export const WECOM_URL = 'http://127.0.0.1:9/cgi-bin/webhook/send?key=demo-key-0001';

export function wecomChannel(
  db: Db,
  actor: Actor,
  name: string,
  extra: { allowedProductIds?: string[]; enabled?: boolean; rateLimitPerMin?: number; url?: string } = {},
): Promise<ChannelView> {
  return createChannel(
    db,
    actor,
    { kind: 'wecom_robot', name, config: { url: extra.url ?? WECOM_URL }, allowedProductIds: extra.allowedProductIds, enabled: extra.enabled, rateLimitPerMin: extra.rateLimitPerMin },
    TEST_DEPS,
  );
}
```

新建 `packages/core/test/notify-channels.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, notificationChannels, notificationSchedules } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createChannel, deleteChannel, listChannels, listProductChannelOptions, updateChannel } from '../src/notifications/channels';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, WECOM_URL, wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
let otherProductId: string;
const EMAIL = { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-password-1', from: 'robot@example.com', to: ['pm@example.com', 'dev@example.com'] };

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  otherProductId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
});
afterAll(() => t.cleanup());

describe('通道', () => {
  it('登记企微通道：返回脱敏提示与默认值；库里是密文；事件里没有明文', async () => {
    const ch = await createChannel(t.db, owner, { kind: 'wecom_robot', name: '研发群', groupLabel: '研发', config: { url: WECOM_URL } }, TEST_DEPS);
    expect(ch).toMatchObject({
      kind: 'wecom_robot',
      name: '研发群',
      groupLabel: '研发',
      configHint: '…/send?key=****0001',
      rateLimitPerMin: 20,
      enabled: true,
      allowedProductIds: [],
      settings: null,
      usage: { rules: 0, schedules: 0, deliveries: 0 },
    });
    expect(JSON.stringify(ch)).not.toContain('demo-key');
    const [row] = await t.adminDb.select().from(notificationChannels).where(eq(notificationChannels.id, ch.id));
    expect(row!.config.startsWith('v1:')).toBe(true);
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, ch.id));
    expect(events.map((e) => e.type)).toEqual(['notification_channel.created']);
    expect(JSON.stringify(events)).not.toContain('demo-key');
    await expect(wecomChannel(t.db, owner, '研发群')).rejects.toThrow('通道名称已存在');
  });

  it('邮件通道：默认每分钟 60；返回非敏感字段，不含密码；留空密码表示不变', async () => {
    const ch = await createChannel(t.db, owner, { kind: 'email', name: '邮件', config: EMAIL }, TEST_DEPS);
    expect(ch.rateLimitPerMin).toBe(60);
    expect(ch.settings).toEqual({ host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', from: 'robot@example.com', to: ['pm@example.com', 'dev@example.com'] });
    expect(JSON.stringify(ch)).not.toContain('demo-password-1');
    const updated = await updateChannel(t.db, owner, ch.id, { config: { pass: '', to: ['pm@example.com'] } }, TEST_DEPS);
    expect(updated.configHint).toBe('smtp.example.com:465 · robot@example.com → 1 个收件人');
    const all = await listChannels(t.db, owner, TEST_DEPS);
    expect(JSON.stringify(all)).not.toContain('demo-password-1');
  });

  it('修改网址：提示更新，事件 changes 只记提示；名称、上限、产品范围、启用', async () => {
    const ch = await wecomChannel(t.db, owner, '改址群');
    const updated = await updateChannel(
      t.db,
      owner,
      ch.id,
      { name: '改址群 2', rateLimitPerMin: 10, allowedProductIds: [productId], enabled: false, config: { url: 'http://127.0.0.1:9/cgi-bin/webhook/send?key=demo-key-9999' } },
      TEST_DEPS,
    );
    expect(updated).toMatchObject({ name: '改址群 2', rateLimitPerMin: 10, allowedProductIds: [productId], enabled: false, configHint: '…/send?key=****9999' });
    const [event] = await t.adminDb
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.type, 'notification_channel.updated'), eq(domainEvents.subjectId, ch.id)));
    expect(event!.payload.changes).toEqual(
      expect.arrayContaining([
        { field: 'name', old: '改址群', new: '改址群 2' },
        { field: 'config', old: '…/send?key=****0001', new: '…/send?key=****9999' },
      ]),
    );
    expect(JSON.stringify(event)).not.toContain('demo-key');
    await expect(updateChannel(t.db, owner, ch.id, { rateLimitPerMin: 0 }, TEST_DEPS)).rejects.toThrow('1–600');
    await expect(updateChannel(t.db, owner, ch.id, { allowedProductIds: ['00000000-0000-7000-8000-000000000000'] }, TEST_DEPS)).rejects.toThrow('不存在的产品');
  });

  it('权限：只有组织管理员（且不是只读 Token）能管理；产品管理员只能看本产品可用的通道', async () => {
    const member = await asMember(t.db, owner, '成员甲');
    await expect(listChannels(t.db, member, TEST_DEPS)).rejects.toThrow('需要组织管理员权限');
    await expect(wecomChannel(t.db, readOnlyToken(owner), '只读建的')).rejects.toThrow('需要组织管理员权限');
    const pa = await asMember(t.db, owner, '产品管理员甲');
    await setProductRole(t.db, owner, productId, pa.memberId, 'admin');
    await wecomChannel(t.db, owner, '只给相册', { allowedProductIds: [otherProductId] });
    await wecomChannel(t.db, owner, '停用的群', { enabled: false });
    const names = (await listProductChannelOptions(t.db, pa, productId)).map((c) => c.name);
    expect(names).toContain('研发群');
    expect(names).not.toContain('只给相册');
    expect(names).not.toContain('停用的群');
    await expect(listProductChannelOptions(t.db, member, productId)).rejects.toThrow('权限不足');
  });

  it('删除：没有引用时删除；被定时推送引用或有发送记录时只能停用', async () => {
    const free = await wecomChannel(t.db, owner, '可删的群');
    await deleteChannel(t.db, owner, free.id);
    expect(await t.adminDb.select().from(notificationChannels).where(eq(notificationChannels.id, free.id))).toEqual([]);
    const used = await wecomChannel(t.db, owner, '被引用的群');
    await t.adminDb.insert(notificationSchedules).values({ orgId: owner.orgId, productId, name: '引用', cron: '0 9 * * *', source: 'digest', channelIds: [used.id] });
    await expect(deleteChannel(t.db, owner, used.id)).rejects.toThrow('只能停用');
    expect((await listChannels(t.db, owner, TEST_DEPS)).find((c) => c.id === used.id)!.usage.schedules).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/notify-channels.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/channels'`）。

- [ ] **Step 3: 实现**

新建 `packages/core/src/notifications/channels.ts`：

```ts
import { and, arrayContains, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, notificationDeliveries, notificationRules, notificationSchedules, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import {
  type ChannelConfig,
  type ChannelConfigPatch,
  type ChannelPublicSettings,
  channelConfigHint,
  channelPublicSettings,
  mergeChannelConfig,
  parseChannelConfig,
} from './channel-config';
import { CHANNEL_KINDS, type ChannelKind, DEFAULT_RATE_LIMIT } from './constants';
import { decryptConfig, encryptConfig } from './secrets';

export type SecretDeps = { secretKey: string };
export type ChannelRow = typeof notificationChannels.$inferSelect;
export type ChannelView = {
  id: string;
  kind: ChannelKind;
  name: string;
  groupLabel: string | null;
  configHint: string;
  settings: ChannelPublicSettings;
  rateLimitPerMin: number;
  allowedProductIds: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  usage: { rules: number; schedules: number; deliveries: number };
};
export type ChannelOption = { id: string; kind: ChannelKind; name: string; groupLabel: string | null; enabled: boolean };
export type ChannelInput = {
  kind: ChannelKind;
  name: string;
  groupLabel?: string | null;
  config: unknown;
  rateLimitPerMin?: number;
  allowedProductIds?: string[];
  enabled?: boolean;
};
export type ChannelPatch = {
  name?: string;
  groupLabel?: string | null;
  config?: ChannelConfigPatch;
  rateLimitPerMin?: number;
  allowedProductIds?: string[];
  enabled?: boolean;
};

const NOT_FOUND = '通道不存在';
const UNUSABLE = '通道不存在、已停用或不允许本产品使用';

function assertName(name: string): string {
  const v = name.trim();
  if (!v || v.length > 50) throw new AppError('invalid', '通道名称不能为空，且不超过 50 个字');
  return v;
}

function assertGroupLabel(value: string | null | undefined): string | null {
  const v = value?.trim() ?? '';
  if (v.length > 50) throw new AppError('invalid', '所属群不超过 50 个字');
  return v || null;
}

function assertRate(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 600) throw new AppError('invalid', '每分钟发送上限应为 1–600 的整数');
  return value;
}

async function assertProducts(tx: Tx, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = await tx.select({ id: products.id }).from(products).where(and(inArray(products.id, unique), isNull(products.deletedAt)));
  if (found.length !== unique.length) throw new AppError('invalid', '可用产品中有不存在的产品');
  return unique;
}

export function readChannelConfig(row: ChannelRow, secretKey: string): ChannelConfig {
  return decryptConfig<ChannelConfig>(row.config, secretKey);
}

export const channelOption = (r: ChannelRow): ChannelOption => ({ id: r.id, kind: r.kind, name: r.name, groupLabel: r.groupLabel, enabled: r.enabled });

async function viewsTx(tx: Tx, rows: ChannelRow[], secretKey: string): Promise<ChannelView[]> {
  if (rows.length === 0) return [];
  const ruleRows = await tx.select({ ids: notificationRules.channelIds }).from(notificationRules);
  const scheduleRows = await tx.select({ ids: notificationSchedules.channelIds }).from(notificationSchedules);
  const deliveryCounts = await tx
    .select({ id: notificationDeliveries.channelId, n: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .where(inArray(notificationDeliveries.channelId, rows.map((r) => r.id)))
    .groupBy(notificationDeliveries.channelId);
  const refs = (list: Array<{ ids: string[] }>, id: string) => list.filter((r) => r.ids.includes(id)).length;
  return rows.map((r) => {
    let settings: ChannelPublicSettings = null;
    if (r.kind === 'email') {
      try {
        settings = channelPublicSettings(r.kind, readChannelConfig(r, secretKey));
      } catch {
        settings = null;
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      groupLabel: r.groupLabel,
      configHint: r.configHint,
      settings,
      rateLimitPerMin: r.rateLimitPerMin,
      allowedProductIds: r.allowedProductIds,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      usage: { rules: refs(ruleRows, r.id), schedules: refs(scheduleRows, r.id), deliveries: deliveryCounts.find((d) => d.id === r.id)?.n ?? 0 },
    };
  });
}

export async function listChannels(db: Db, actor: Actor, deps: SecretDeps): Promise<ChannelView[]> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx.select().from(notificationChannels).orderBy(asc(notificationChannels.groupLabel), asc(notificationChannels.name));
    return viewsTx(tx, rows, deps.secretKey);
  });
}

export async function createChannel(db: Db, actor: Actor, input: ChannelInput, deps: SecretDeps): Promise<ChannelView> {
  requireOrgAdmin(actor);
  if (!(CHANNEL_KINDS as readonly string[]).includes(input.kind)) throw new AppError('invalid', '通道类型无效');
  const name = assertName(input.name);
  const groupLabel = assertGroupLabel(input.groupLabel);
  const config = parseChannelConfig(input.kind, input.config);
  const rateLimitPerMin = assertRate(input.rateLimitPerMin ?? DEFAULT_RATE_LIMIT[input.kind]);
  return withOrg(db, actor.orgId, async (tx) => {
    const allowedProductIds = await assertProducts(tx, input.allowedProductIds ?? []);
    const configHint = channelConfigHint(input.kind, config);
    let row: ChannelRow;
    try {
      [row] = (await tx
        .insert(notificationChannels)
        .values({
          orgId: actor.orgId,
          kind: input.kind,
          name,
          groupLabel,
          config: encryptConfig(config, deps.secretKey),
          configHint,
          rateLimitPerMin,
          allowedProductIds,
          enabled: input.enabled ?? true,
        })
        .returning()) as [ChannelRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '通道名称已存在');
      throw e;
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'notification_channel.created',
      subjectType: 'notification_channel',
      subjectId: row.id,
      actor,
      payload: { kind: row.kind, name, groupLabel, configHint, rateLimitPerMin, allowedProductIds, enabled: row.enabled },
    });
    return (await viewsTx(tx, [row], deps.secretKey))[0]!;
  });
}

export async function updateChannel(db: Db, actor: Actor, id: string, patch: ChannelPatch, deps: SecretDeps): Promise<ChannelView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, id)).for('update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    const set: Partial<typeof notificationChannels.$inferInsert> = {};
    const changes: Array<{ field: string; old: unknown; new: unknown }> = [];
    if (patch.name !== undefined) {
      const v = assertName(patch.name);
      if (v !== cur.name) {
        set.name = v;
        changes.push({ field: 'name', old: cur.name, new: v });
      }
    }
    if (patch.groupLabel !== undefined) {
      const v = assertGroupLabel(patch.groupLabel);
      if (v !== cur.groupLabel) {
        set.groupLabel = v;
        changes.push({ field: 'groupLabel', old: cur.groupLabel, new: v });
      }
    }
    if (patch.rateLimitPerMin !== undefined) {
      const v = assertRate(patch.rateLimitPerMin);
      if (v !== cur.rateLimitPerMin) {
        set.rateLimitPerMin = v;
        changes.push({ field: 'rateLimitPerMin', old: cur.rateLimitPerMin, new: v });
      }
    }
    if (patch.allowedProductIds !== undefined) {
      const v = await assertProducts(tx, patch.allowedProductIds);
      if ([...v].sort().join() !== [...cur.allowedProductIds].sort().join()) {
        set.allowedProductIds = v;
        changes.push({ field: 'allowedProductIds', old: cur.allowedProductIds, new: v });
      }
    }
    if (patch.enabled !== undefined && patch.enabled !== cur.enabled) {
      set.enabled = patch.enabled;
      changes.push({ field: 'enabled', old: cur.enabled, new: patch.enabled });
    }
    if (patch.config !== undefined) {
      const before = readChannelConfig(cur, deps.secretKey);
      const next = mergeChannelConfig(cur.kind, before, patch.config);
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        const hint = channelConfigHint(cur.kind, next);
        set.config = encryptConfig(next, deps.secretKey);
        set.configHint = hint;
        // 只记脱敏提示，不记明文
        changes.push({ field: 'config', old: cur.configHint, new: hint });
      }
    }
    if (changes.length === 0) return (await viewsTx(tx, [cur], deps.secretKey))[0]!;
    let row: ChannelRow;
    try {
      [row] = (await tx
        .update(notificationChannels)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(notificationChannels.id, id))
        .returning()) as [ChannelRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '通道名称已存在');
      throw e;
    }
    await recordEvent(tx, { orgId: actor.orgId, type: 'notification_channel.updated', subjectType: 'notification_channel', subjectId: id, actor, payload: { changes } });
    return (await viewsTx(tx, [row], deps.secretKey))[0]!;
  });
}

export async function deleteChannel(db: Db, actor: Actor, id: string): Promise<void> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, id)).for('update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    const [delivery] = await tx.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(eq(notificationDeliveries.channelId, id)).limit(1);
    const [rule] = await tx.select({ id: notificationRules.id }).from(notificationRules).where(arrayContains(notificationRules.channelIds, [id])).limit(1);
    const [schedule] = await tx.select({ id: notificationSchedules.id }).from(notificationSchedules).where(arrayContains(notificationSchedules.channelIds, [id])).limit(1);
    if (delivery || rule || schedule) throw new AppError('conflict', '已有发送记录或被规则、定时推送引用的通道只能停用');
    await tx.delete(notificationChannels).where(eq(notificationChannels.id, id));
    await recordEvent(tx, { orgId: actor.orgId, type: 'notification_channel.deleted', subjectType: 'notification_channel', subjectId: id, actor, payload: { name: cur.name, kind: cur.kind } });
  });
}

/** 启用、且对该产品可用（allowed_product_ids 为空或包含该产品）的通道；ids 为 null 时不限通道。 */
export async function usableChannelsTx(tx: Tx, ids: string[] | null, productId: string | null): Promise<ChannelRow[]> {
  if (ids !== null && ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.enabled, true), ids === null ? undefined : inArray(notificationChannels.id, ids)))
    .orderBy(asc(notificationChannels.name));
  return rows.filter((r) => r.allowedProductIds.length === 0 || (productId !== null && r.allowedProductIds.includes(productId)));
}

/** 规则与定时推送选择的通道：去重后 min–10 个，全部启用且对该产品可用。 */
export async function assertUsableChannelsTx(tx: Tx, ids: string[], productId: string | null, opts: { min: number }): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length < opts.min || unique.length > 10) throw new AppError('invalid', opts.min > 0 ? '请选择 1–10 个通道' : '最多选择 10 个通道');
  const usable = await usableChannelsTx(tx, unique, productId);
  if (usable.length !== unique.length) throw new AppError('invalid', UNUSABLE);
  return unique;
}

export async function listProductChannelOptions(db: Db, actor: Actor, productId: string): Promise<ChannelOption[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    return (await usableChannelsTx(tx, null, productId)).map(channelOption);
  });
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/channels';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/notify-channels.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/notifications/channels.ts packages/core/src/index.ts packages/core/test/notify-helpers.ts packages/core/test/notify-channels.test.ts
git commit -m "feat(core): 推送通道的登记、修改、停用与删除（配置加密，只返回脱敏提示）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: 预置模板与消息模板服务

**Files:**
- Create: `packages/core/src/notifications/builtin.ts`、`packages/core/src/notifications/message-templates.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/notify-templates.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `assertTemplateBody`、`renderMessage`；Task 4 的 `messageTemplates`、`notificationRules`、`notificationSchedules`
- Produces:
  - `BUILTIN_TEMPLATES: Record<BuiltinTemplateKey, { name: string; format: TemplateFormat; body: string }>`
  - `type MessageTemplateView = { id; name; format: TemplateFormat; body; builtin: boolean; builtinKey: BuiltinTemplateKey | null; usage: { rules: number; schedules: number }; createdAt: Date; updatedAt: Date }`
  - `listMessageTemplates(db, actor): Promise<MessageTemplateView[]>`（非访客；补齐预置模板）
  - `createMessageTemplate(db, actor, input: { name: string; format: TemplateFormat; body: string }): Promise<MessageTemplateView>`
  - `updateMessageTemplate(db, actor, id, patch: { name?: string; format?: TemplateFormat; body?: string }): Promise<MessageTemplateView>`
  - `deleteMessageTemplate(db, actor, id): Promise<void>`
  - `resolveTemplateTx(tx, templateId: string | null, key: BuiltinTemplateKey): Promise<{ format: TemplateFormat; body: string }>`
  - `assertTemplateIdTx(tx, templateId: string | null | undefined): Promise<string | null>`（不存在时 `AppError('invalid', '模板不存在')`）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/notify-templates.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messageTemplates, notificationSchedules } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { BUILTIN_TEMPLATES } from '../src/notifications/builtin';
import { createMessageTemplate, deleteMessageTemplate, listMessageTemplates, resolveTemplateTx, updateMessageTemplate } from '../src/notifications/message-templates';
import { renderMessage } from '../src/notifications/template';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

describe('预置模板的渲染结果', () => {
  it('事件推送', () => {
    const { format, body } = BUILTIN_TEMPLATES.event;
    const msg = renderMessage(format, body, {
      product: { key: 'PAN', name: '网盘' },
      event: { label: '需求状态变化', actor: '林澄', time: '10-09 14:20' },
      subject: { key: 'PAN-12', title: '批量下载', url: 'http://flower.example.com/acme/requirements/PAN-12' },
      changes: [{ label: '状态', old: '待开始', new: '进行中' }],
    });
    expect(msg).toEqual({
      format: 'markdown',
      text: '**网盘 · 需求状态变化**\n[PAN-12 批量下载](http://flower.example.com/acme/requirements/PAN-12)\n> 状态：待开始 → 进行中\n<font color="comment">林澄 · 10-09 14:20</font>',
    });
  });

  it('新需求：与 push 相同的结构（标题、引用行、分组、每条三到四行、末行链接）', () => {
    const { format, body } = BUILTIN_TEMPLATES.new_requirements;
    const msg = renderMessage(format, body, {
      date: '10/9',
      newCount: 1,
      onlineCount: 1,
      sections: [
        {
          title: '🆕 新增需求',
          items: [{ index: 1, key: 'PAN-1', title: '离线下载', url: 'u1', priority: 'P0', priorityColor: 'warning', meta: '客户甲 · 功能 · PC/Web', brief: '支持离线', prdUrl: 'https://docs.example.com/prd-1' }],
        },
        { title: '🔧 线上转需求', items: [{ index: 2, key: 'PAN-2', title: '上传失败', url: 'u2', priority: 'P2', priorityColor: 'comment', meta: '客户乙 · 功能', brief: '', prdUrl: '' }] },
      ],
      listUrl: 'http://flower.example.com/acme/requirements?product=PAN',
    });
    expect(msg).toEqual({
      format: 'markdown',
      text: [
        '# 📋 10/9 新增需求',
        '> 🆕 新增 1 条 · 🔧 线上转需求 1 条',
        '',
        '**🆕 新增需求**',
        '',
        '**1. [PAN-1 离线下载](u1)** <font color="warning">P0</font>',
        '<font color="comment">客户甲 · 功能 · PC/Web</font>',
        '<font color="comment">支持离线</font>',
        '[PRD ↗](https://docs.example.com/prd-1)',
        '',
        '**🔧 线上转需求**',
        '',
        '**2. [PAN-2 上传失败](u2)** <font color="comment">P2</font>',
        '<font color="comment">客户乙 · 功能</font>',
        '',
        '> 👉 [到 Flower 认领 / 分配 ↗](http://flower.example.com/acme/requirements?product=PAN)',
      ].join('\n'),
    });
  });

  it('变更摘要与概览卡片', () => {
    const digest = renderMessage(BUILTIN_TEMPLATES.digest.format, BUILTIN_TEMPLATES.digest.body, {
      product: { name: '网盘' },
      period: '10-09 09:00 – 10-09 18:00',
      eventCount: 2,
      subjectCount: 1,
      groups: [{ key: 'PAN-12', title: '批量下载', url: 'u', lines: [{ text: '10-09 10:00 林澄：需求状态变化：状态 待开始 → 进行中' }, { text: '10-09 11:00 林澄：需求字段变化：优先级 P1 → P0' }] }],
    });
    expect(digest).toEqual({
      format: 'markdown',
      text: '# 📋 网盘 变更摘要\n> 10-09 09:00 – 10-09 18:00 · 共 2 项变化，涉及 1 个对象\n\n**[PAN-12 批量下载](u)**\n> 10-09 10:00 林澄：需求状态变化：状态 待开始 → 进行中\n> 10-09 11:00 林澄：需求字段变化：优先级 P1 → P0',
    });
    const card = renderMessage(BUILTIN_TEMPLATES.overview_card.format, BUILTIN_TEMPLATES.overview_card.body, {
      title: '网盘 研发日报 · 2026-10-09',
      desc: '1016 发版 · 整体进度 75% · 点开查看需求与甘特',
      button: { title: '查看完整明细', url: 'http://flower.example.com/acme/iterations/i1' },
    });
    expect(card).toEqual({
      format: 'template_card',
      card: {
        card_type: 'text_notice',
        main_title: { title: '网盘 研发日报 · 2026-10-09', desc: '1016 发版 · 整体进度 75% · 点开查看需求与甘特' },
        jump_list: [{ type: 1, title: '查看完整明细', url: 'http://flower.example.com/acme/iterations/i1' }],
        card_action: { type: 1, url: 'http://flower.example.com/acme/iterations/i1' },
      },
    });
  });
});

describe('消息模板', () => {
  it('列表补齐四个预置模板，重复读取不重复插入', async () => {
    const first = await listMessageTemplates(t.db, owner);
    expect(first.filter((x) => x.builtin).map((x) => x.builtinKey).sort()).toEqual(['digest', 'event', 'new_requirements', 'overview_card']);
    await listMessageTemplates(t.db, owner);
    expect(await t.adminDb.select().from(messageTemplates).where(eq(messageTemplates.builtin, true))).toHaveLength(4);
  });

  it('预置模板只能改内容，不能改名、改格式、删除', async () => {
    const ev = (await listMessageTemplates(t.db, owner)).find((x) => x.builtinKey === 'event')!;
    await expect(updateMessageTemplate(t.db, owner, ev.id, { name: '改名' })).rejects.toThrow('预置模板只能修改内容');
    await expect(updateMessageTemplate(t.db, owner, ev.id, { format: 'text' })).rejects.toThrow('预置模板只能修改内容');
    const edited = await updateMessageTemplate(t.db, owner, ev.id, { body: '{{subject.key}} {{event.label}}' });
    expect(edited.body).toBe('{{subject.key}} {{event.label}}');
    await expect(deleteMessageTemplate(t.db, owner, ev.id)).rejects.toThrow('预置模板不能删除');
  });

  it('新建：校验语法与卡片 JSON；名称唯一；成员只能看不能建；访客不能看', async () => {
    await expect(createMessageTemplate(t.db, owner, { name: '坏模板', format: 'markdown', body: '{{#a}}' })).rejects.toThrow('模板语法错误');
    await expect(createMessageTemplate(t.db, owner, { name: '坏卡片', format: 'template_card', body: 'not json' })).rejects.toThrow('JSON 对象');
    const tpl = await createMessageTemplate(t.db, owner, { name: '简版', format: 'text', body: '{{subject.key}} {{summary}}' });
    expect(tpl).toMatchObject({ builtin: false, builtinKey: null, usage: { rules: 0, schedules: 0 } });
    await expect(createMessageTemplate(t.db, owner, { name: '简版', format: 'text', body: 'x' })).rejects.toThrow('模板名称已存在');
    const member = await asMember(t.db, owner, '成员乙');
    expect((await listMessageTemplates(t.db, member)).some((x) => x.name === '简版')).toBe(true);
    await expect(createMessageTemplate(t.db, member, { name: '成员建', format: 'text', body: 'x' })).rejects.toThrow('需要组织管理员权限');
    const guest = await asMember(t.db, owner, '访客乙', 'guest');
    await expect(listMessageTemplates(t.db, guest)).rejects.toThrow('访客');
  });

  it('解析模板：指定的模板 → 预置行（含修改）→ 代码默认值；被引用的模板不能删除', async () => {
    const tpl = await createMessageTemplate(t.db, owner, { name: '被引用', format: 'markdown', body: '**{{title}}**' });
    await withOrg(t.db, owner.orgId, async (tx) => {
      expect(await resolveTemplateTx(tx, tpl.id, 'overview_card')).toEqual({ format: 'markdown', body: '**{{title}}**' });
      expect(await resolveTemplateTx(tx, null, 'event')).toEqual({ format: 'markdown', body: '{{subject.key}} {{event.label}}' });
    });
    await t.adminDb.delete(messageTemplates).where(and(eq(messageTemplates.orgId, owner.orgId), eq(messageTemplates.builtinKey, 'digest')));
    await withOrg(t.db, owner.orgId, async (tx) => {
      expect(await resolveTemplateTx(tx, null, 'digest')).toEqual({ format: BUILTIN_TEMPLATES.digest.format, body: BUILTIN_TEMPLATES.digest.body });
    });
    await t.adminDb.insert(notificationSchedules).values({ orgId: owner.orgId, productId, name: '用模板', cron: '0 9 * * *', source: 'overview_card', templateId: tpl.id });
    await expect(deleteMessageTemplate(t.db, owner, tpl.id)).rejects.toThrow('模板正在被规则或定时推送使用');
    const free = await createMessageTemplate(t.db, owner, { name: '可删', format: 'text', body: 'x' });
    await deleteMessageTemplate(t.db, owner, free.id);
    expect((await listMessageTemplates(t.db, owner)).some((x) => x.id === free.id)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/notify-templates.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/builtin'`）。

- [ ] **Step 3: 实现**

新建 `packages/core/src/notifications/builtin.ts`：

```ts
import type { BuiltinTemplateKey, TemplateFormat } from './constants';

/**
 * 预置模板的默认内容。数据结构见 sources.ts：事件消息 eventMessageData、概览卡片 overviewCardData、
 * 新需求 newRequirementsData、变更摘要 digestData。新需求与概览卡片的版式按 push 的实际输出核对（见 P3-A 计划「设计决定」）。
 */
export const BUILTIN_TEMPLATES: Record<BuiltinTemplateKey, { name: string; format: TemplateFormat; body: string }> = {
  event: {
    name: '默认 · 事件推送',
    format: 'markdown',
    body: [
      '**{{product.name}} · {{event.label}}**',
      '[{{subject.key}} {{subject.title}}]({{subject.url}})',
      '{{#changes}}',
      '> {{label}}：{{old}} → {{new}}',
      '{{/changes}}',
      '<font color="comment">{{event.actor}} · {{event.time}}</font>',
    ].join('\n'),
  },
  overview_card: {
    name: '默认 · 概览卡片',
    format: 'template_card',
    body: JSON.stringify(
      {
        card_type: 'text_notice',
        main_title: { title: '{{title}}', desc: '{{desc}}' },
        jump_list: [{ type: 1, title: '{{button.title}}', url: '{{button.url}}' }],
        card_action: { type: 1, url: '{{button.url}}' },
      },
      null,
      2,
    ),
  },
  new_requirements: {
    name: '默认 · 新需求',
    format: 'markdown',
    body: [
      '# 📋 {{date}} 新增需求',
      '> 🆕 新增 {{newCount}} 条 · 🔧 线上转需求 {{onlineCount}} 条',
      '{{#sections}}',
      '',
      '**{{title}}**',
      '{{#items}}',
      '',
      '**{{index}}. [{{key}} {{title}}]({{url}})** <font color="{{priorityColor}}">{{priority}}</font>',
      '<font color="comment">{{meta}}</font>',
      '{{#brief}}',
      '<font color="comment">{{brief}}</font>',
      '{{/brief}}',
      '{{#prdUrl}}',
      '[PRD ↗]({{prdUrl}})',
      '{{/prdUrl}}',
      '{{/items}}',
      '{{/sections}}',
      '',
      '> 👉 [到 Flower 认领 / 分配 ↗]({{listUrl}})',
    ].join('\n'),
  },
  digest: {
    name: '默认 · 变更摘要',
    format: 'markdown',
    body: [
      '# 📋 {{product.name}} 变更摘要',
      '> {{period}} · 共 {{eventCount}} 项变化，涉及 {{subjectCount}} 个对象',
      '{{#groups}}',
      '',
      '**[{{key}} {{title}}]({{url}})**',
      '{{#lines}}',
      '> {{text}}',
      '{{/lines}}',
      '{{/groups}}',
    ].join('\n'),
  },
};
```

新建 `packages/core/src/notifications/message-templates.ts`：

```ts
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { messageTemplates, notificationRules, notificationSchedules } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { BUILTIN_TEMPLATES } from './builtin';
import { BUILTIN_TEMPLATE_KEYS, type BuiltinTemplateKey, TEMPLATE_FORMATS, type TemplateFormat } from './constants';
import { assertTemplateBody } from './template';

type TemplateRow = typeof messageTemplates.$inferSelect;
export type MessageTemplateView = {
  id: string;
  name: string;
  format: TemplateFormat;
  body: string;
  builtin: boolean;
  builtinKey: BuiltinTemplateKey | null;
  usage: { rules: number; schedules: number };
  createdAt: Date;
  updatedAt: Date;
};

const NOT_FOUND = '模板不存在';

function assertName(name: string): string {
  const v = name.trim();
  if (!v || v.length > 50) throw new AppError('invalid', '模板名称不能为空，且不超过 50 个字');
  return v;
}

function assertFormat(format: string): TemplateFormat {
  if (!(TEMPLATE_FORMATS as readonly string[]).includes(format)) throw new AppError('invalid', '模板格式无效');
  return format as TemplateFormat;
}

function assertBody(format: TemplateFormat, body: string): string {
  if (!body.trim() || body.length > 20_000) throw new AppError('invalid', '模板内容不能为空，且不超过 20000 个字符');
  assertTemplateBody(format, body);
  return body;
}

/** 补齐四个预置模板（已有或同名时跳过）。属于基础数据补齐，不记事件。 */
async function ensureBuiltinsTx(tx: Tx, orgId: string): Promise<void> {
  await tx
    .insert(messageTemplates)
    .values(BUILTIN_TEMPLATE_KEYS.map((k) => ({ orgId, name: BUILTIN_TEMPLATES[k].name, format: BUILTIN_TEMPLATES[k].format, body: BUILTIN_TEMPLATES[k].body, builtin: true, builtinKey: k })))
    .onConflictDoNothing();
}

async function viewsTx(tx: Tx, rows: TemplateRow[]): Promise<MessageTemplateView[]> {
  const ruleRefs = await tx.select({ id: notificationRules.templateId }).from(notificationRules).where(isNotNull(notificationRules.templateId));
  const scheduleRefs = await tx.select({ id: notificationSchedules.templateId }).from(notificationSchedules).where(isNotNull(notificationSchedules.templateId));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    format: r.format,
    body: r.body,
    builtin: r.builtin,
    builtinKey: r.builtinKey,
    usage: { rules: ruleRefs.filter((x) => x.id === r.id).length, schedules: scheduleRefs.filter((x) => x.id === r.id).length },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function listMessageTemplates(db: Db, actor: Actor): Promise<MessageTemplateView[]> {
  requireNonGuest(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    await ensureBuiltinsTx(tx, actor.orgId);
    const rows = await tx.select().from(messageTemplates).orderBy(desc(messageTemplates.builtin), asc(messageTemplates.name));
    return viewsTx(tx, rows);
  });
}

export async function createMessageTemplate(db: Db, actor: Actor, input: { name: string; format: TemplateFormat; body: string }): Promise<MessageTemplateView> {
  requireOrgAdmin(actor);
  const name = assertName(input.name);
  const format = assertFormat(input.format);
  const body = assertBody(format, input.body);
  return withOrg(db, actor.orgId, async (tx) => {
    let row: TemplateRow;
    try {
      [row] = (await tx.insert(messageTemplates).values({ orgId: actor.orgId, name, format, body }).returning()) as [TemplateRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '模板名称已存在');
      throw e;
    }
    await recordEvent(tx, { orgId: actor.orgId, type: 'message_template.created', subjectType: 'message_template', subjectId: row.id, actor, payload: { name, format } });
    return (await viewsTx(tx, [row]))[0]!;
  });
}

export async function updateMessageTemplate(
  db: Db,
  actor: Actor,
  id: string,
  patch: { name?: string; format?: TemplateFormat; body?: string },
): Promise<MessageTemplateView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, id)).for('update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    const name = patch.name === undefined ? cur.name : assertName(patch.name);
    const format = patch.format === undefined ? cur.format : assertFormat(patch.format);
    if (cur.builtin && (name !== cur.name || format !== cur.format)) throw new AppError('invalid', '预置模板只能修改内容');
    const body = assertBody(format, patch.body ?? cur.body);
    const changes = (
      [
        ['name', cur.name, name],
        ['format', cur.format, format],
        ['body', cur.body, body],
      ] as const
    )
      .filter(([, a, b]) => a !== b)
      .map(([field, old, value]) => ({ field, old, new: value }));
    if (changes.length === 0) return (await viewsTx(tx, [cur]))[0]!;
    let row: TemplateRow;
    try {
      [row] = (await tx.update(messageTemplates).set({ name, format, body, updatedAt: new Date() }).where(eq(messageTemplates.id, id)).returning()) as [TemplateRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '模板名称已存在');
      throw e;
    }
    await recordEvent(tx, { orgId: actor.orgId, type: 'message_template.updated', subjectType: 'message_template', subjectId: id, actor, payload: { changes } });
    return (await viewsTx(tx, [row]))[0]!;
  });
}

export async function deleteMessageTemplate(db: Db, actor: Actor, id: string): Promise<void> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, id)).for('update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    if (cur.builtin) throw new AppError('invalid', '预置模板不能删除');
    const [rule] = await tx.select({ id: notificationRules.id }).from(notificationRules).where(eq(notificationRules.templateId, id)).limit(1);
    const [schedule] = await tx.select({ id: notificationSchedules.id }).from(notificationSchedules).where(eq(notificationSchedules.templateId, id)).limit(1);
    if (rule || schedule) throw new AppError('conflict', '模板正在被规则或定时推送使用');
    await tx.delete(messageTemplates).where(eq(messageTemplates.id, id));
    await recordEvent(tx, { orgId: actor.orgId, type: 'message_template.deleted', subjectType: 'message_template', subjectId: id, actor, payload: { name: cur.name } });
  });
}

/** 渲染用的模板：指定的模板 → 本组织的预置行 → 代码中的默认内容。 */
export async function resolveTemplateTx(tx: Tx, templateId: string | null, key: BuiltinTemplateKey): Promise<{ format: TemplateFormat; body: string }> {
  if (templateId) {
    const [row] = await tx.select({ format: messageTemplates.format, body: messageTemplates.body }).from(messageTemplates).where(eq(messageTemplates.id, templateId));
    if (row) return row;
  }
  const [builtin] = await tx
    .select({ format: messageTemplates.format, body: messageTemplates.body })
    .from(messageTemplates)
    .where(and(eq(messageTemplates.builtin, true), eq(messageTemplates.builtinKey, key)));
  return builtin ?? { format: BUILTIN_TEMPLATES[key].format, body: BUILTIN_TEMPLATES[key].body };
}

export async function assertTemplateIdTx(tx: Tx, templateId: string | null | undefined): Promise<string | null> {
  if (!templateId) return null;
  const [row] = await tx.select({ id: messageTemplates.id }).from(messageTemplates).where(eq(messageTemplates.id, templateId));
  if (!row) throw new AppError('invalid', '模板不存在');
  return row.id;
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/builtin';
export * from './notifications/message-templates';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/notify-templates.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/notifications/builtin.ts packages/core/src/notifications/message-templates.ts packages/core/src/index.ts packages/core/test/notify-templates.test.ts
git commit -m "feat(core): 推送消息模板（四个预置模板按 push 版式，可改内容；自建模板的增删改）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: 定时推送服务（新建、修改、停用、删除、列表）

**Files:**
- Create: `packages/core/src/notifications/schedules.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/notify-schedules.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `assertCron`、`assertTimezone`、`nextRunAt`；Task 5 的 `assertUsableChannelsTx`、`channelOption`、`ChannelOption`；Task 6 的 `assertTemplateIdTx`
- Produces:
  - `type ScheduleRow = typeof notificationSchedules.$inferSelect`
  - `type ScheduleView = { id; productId: string | null; product: { id: string; key: string; name: string } | null; name; cron; timezone; source: ScheduleSource; sourceConfig: Record<string, unknown>; channelIds: string[]; channels: ChannelOption[]; templateId: string | null; enabled; nextRunAt: Date | null; lastRunAt: Date | null; lastSuccessAt: Date | null; consecutiveFailures: number; failThreshold: number; alertState: AlertState; lastError: string | null; createdAt: Date; updatedAt: Date }`
  - `type ScheduleInput = { productId: string; name: string; cron: string; timezone?: string; source: ScheduleSource; sourceConfig?: Record<string, unknown>; channelIds: string[]; templateId?: string | null; enabled?: boolean; failThreshold?: number }`
  - `type SchedulePatch = { name?: string; cron?: string; timezone?: string; sourceConfig?: Record<string, unknown>; channelIds?: string[]; templateId?: string | null; enabled?: boolean; failThreshold?: number }`
  - `parseSourceConfig(source: ScheduleSource, raw: unknown): Record<string, unknown>`
  - `listSchedules(db, actor, opts?: { productId?: string }): Promise<ScheduleView[]>`、`getSchedule(db, actor, id): Promise<ScheduleView>`
  - `createSchedule(db, actor, input, opts?: { now?: Date }): Promise<ScheduleView>`、`updateSchedule(db, actor, id, patch, opts?: { now?: Date }): Promise<ScheduleView>`、`deleteSchedule(db, actor, id): Promise<void>`
  - `requireScheduleAdminTx(tx, actor, productId: string | null): Promise<void>`、`scheduleViewsTx(tx, rows: ScheduleRow[]): Promise<ScheduleView[]>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/notify-schedules.test.ts`：

```ts
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, notificationDeliveries, notificationRules } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { updateChannel } from '../src/notifications/channels';
import { createSchedule, deleteSchedule, getSchedule, listSchedules, updateSchedule } from '../src/notifications/schedules';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pa: Actor;
let productId: string;
let otherProductId: string;
let channelId: string;
const NOW = new Date('2026-10-10T03:00:00Z'); // 周六 11:00（上海）

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  otherProductId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  pa = await asMember(t.db, owner, '产品管理员丙');
  await setProductRole(t.db, owner, productId, pa.memberId, 'admin');
  channelId = (await wecomChannel(t.db, owner, '研发群')).id;
});
afterAll(() => t.cleanup());

const overview = (extra: Record<string, unknown> = {}) => ({ productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card' as const, channelIds: [channelId], ...extra });

describe('定时推送', () => {
  it('产品管理员新建：按时区算出下一次；带通道与产品；记事件', async () => {
    const s = await createSchedule(t.db, pa, overview(), { now: NOW });
    expect(s).toMatchObject({
      name: '日报',
      cron: '0 19 * * 1-5',
      timezone: 'Asia/Shanghai',
      source: 'overview_card',
      sourceConfig: {},
      enabled: true,
      failThreshold: 1,
      alertState: 'normal',
      product: { key: 'PAN' },
      channels: [{ id: channelId, name: '研发群', kind: 'wecom_robot' }],
    });
    expect(s.nextRunAt!.toISOString()).toBe('2026-10-12T11:00:00.000Z');
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, s.id));
    expect(events.map((e) => e.type)).toEqual(['notification_schedule.created']);
  });

  it('校验：5 段 cron、时区、通道、内容来源设置、产品', async () => {
    await expect(createSchedule(t.db, pa, overview({ cron: '0 0 19 * * 1' }))).rejects.toThrow('5 段');
    await expect(createSchedule(t.db, pa, overview({ timezone: 'Mars/Base' }))).rejects.toThrow('时区');
    await expect(createSchedule(t.db, pa, overview({ channelIds: [] }))).rejects.toThrow('请选择 1–10 个通道');
    const off = await wecomChannel(t.db, owner, '停用群', { enabled: false });
    await expect(createSchedule(t.db, pa, overview({ channelIds: [off.id] }))).rejects.toThrow('通道不存在、已停用或不允许本产品使用');
    const picOnly = await wecomChannel(t.db, owner, '相册群', { allowedProductIds: [otherProductId] });
    await expect(createSchedule(t.db, pa, overview({ channelIds: [picOnly.id] }))).rejects.toThrow('不允许本产品使用');
    await expect(createSchedule(t.db, pa, overview({ source: 'new_requirements', sourceConfig: { emptyBehavior: 'maybe' } }))).rejects.toThrow('内容来源的设置有误');
    await expect(createSchedule(t.db, pa, overview({ productId: '' }))).rejects.toThrow('请选择产品');
    const nr = await createSchedule(t.db, pa, overview({ name: '新需求', source: 'new_requirements', cron: '30 9 * * *' }), { now: NOW });
    expect(nr.sourceConfig).toEqual({ emptyBehavior: 'skip', onlineSourceKeys: [] });
  });

  it('权限：编辑、只读 Token 不能管理；产品管理员只看本产品；组织管理员看全部', async () => {
    const editor = await asMember(t.db, owner, '编辑丙');
    await expect(createSchedule(t.db, editor, overview())).rejects.toThrow('权限不足');
    await expect(createSchedule(t.db, readOnlyToken(owner), overview())).rejects.toThrow('权限不足');
    await expect(listSchedules(t.db, pa)).rejects.toThrow('需要组织管理员权限');
    expect((await listSchedules(t.db, pa, { productId })).every((s) => s.productId === productId)).toBe(true);
    await expect(listSchedules(t.db, pa, { productId: otherProductId })).rejects.toThrow('权限不足');
    await createSchedule(t.db, owner, overview({ productId: otherProductId, name: '相册日报', channelIds: [channelId] }), { now: NOW });
    expect((await listSchedules(t.db, owner)).map((s) => s.name)).toEqual(expect.arrayContaining(['日报', '新需求', '相册日报']));
  });

  it('修改：停用清空下一次；改 cron 重算；只改名称时不校验已停用的通道', async () => {
    const s = await createSchedule(t.db, pa, overview({ name: '可改' }), { now: NOW });
    expect((await updateSchedule(t.db, pa, s.id, { enabled: false }, { now: NOW })).nextRunAt).toBeNull();
    const re = await updateSchedule(t.db, pa, s.id, { enabled: true, cron: '30 9 * * *' }, { now: NOW });
    expect(re.nextRunAt!.toISOString()).toBe('2026-10-11T01:30:00.000Z');
    const temp = await wecomChannel(t.db, owner, '后来停用的群');
    const s2 = await createSchedule(t.db, pa, overview({ name: '用后来停用的群', channelIds: [temp.id] }), { now: NOW });
    await updateChannel(t.db, owner, temp.id, { enabled: false }, TEST_DEPS);
    expect((await updateSchedule(t.db, pa, s2.id, { name: '改个名' })).name).toBe('改个名');
    await expect(updateSchedule(t.db, pa, s2.id, { channelIds: [temp.id] })).rejects.toThrow('已停用');
    const [ev] = await t.adminDb
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.type, 'notification_schedule.updated'), eq(domainEvents.subjectId, s.id)))
      .orderBy(asc(domainEvents.occurredAt));
    expect(ev!.payload.changes).toEqual([{ field: 'enabled', old: true, new: false }]);
    expect((await getSchedule(t.db, pa, s.id)).cron).toBe('30 9 * * *');
  });

  it('删除：有发送记录或被摘要规则引用时只能停用', async () => {
    const free = await createSchedule(t.db, pa, overview({ name: '可删' }), { now: NOW });
    await deleteSchedule(t.db, pa, free.id);
    await expect(getSchedule(t.db, pa, free.id)).rejects.toThrow('定时推送不存在');
    const sent = await createSchedule(t.db, pa, overview({ name: '发过的' }), { now: NOW });
    await t.adminDb.insert(notificationDeliveries).values({ orgId: owner.orgId, kind: 'schedule', scheduleId: sent.id, channelId });
    await expect(deleteSchedule(t.db, pa, sent.id)).rejects.toThrow('已有发送记录的定时推送只能停用');
    const digest = await createSchedule(t.db, pa, overview({ name: '摘要', source: 'digest', cron: '0 18 * * *' }), { now: NOW });
    await t.adminDb.insert(notificationRules).values({ orgId: owner.orgId, productId, name: '并入摘要', eventTypes: ['requirement.created'], mode: 'digest', digestScheduleId: digest.id });
    await expect(deleteSchedule(t.db, pa, digest.id)).rejects.toThrow('有摘要规则使用该定时推送');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/notify-schedules.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/schedules'`）。

- [ ] **Step 3: 实现**

新建 `packages/core/src/notifications/schedules.ts`：

```ts
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, notificationDeliveries, notificationRules, notificationSchedules, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertUsableChannelsTx, type ChannelOption, channelOption } from './channels';
import { type AlertState, SCHEDULE_DEFAULT_TIMEZONE, SCHEDULE_SOURCES, type ScheduleSource } from './constants';
import { assertCron, assertTimezone, nextRunAt } from './cron';
import { assertTemplateIdTx } from './message-templates';

export type ScheduleRow = typeof notificationSchedules.$inferSelect;
export type ScheduleView = {
  id: string;
  productId: string | null;
  product: { id: string; key: string; name: string } | null;
  name: string;
  cron: string;
  timezone: string;
  source: ScheduleSource;
  sourceConfig: Record<string, unknown>;
  channelIds: string[];
  channels: ChannelOption[];
  templateId: string | null;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  failThreshold: number;
  alertState: AlertState;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type ScheduleInput = {
  productId: string;
  name: string;
  cron: string;
  timezone?: string;
  source: ScheduleSource;
  sourceConfig?: Record<string, unknown>;
  channelIds: string[];
  templateId?: string | null;
  enabled?: boolean;
  failThreshold?: number;
};
export type SchedulePatch = {
  name?: string;
  cron?: string;
  timezone?: string;
  sourceConfig?: Record<string, unknown>;
  channelIds?: string[];
  templateId?: string | null;
  enabled?: boolean;
  failThreshold?: number;
};

const NOT_FOUND = '定时推送不存在';

const SOURCE_CONFIG = {
  overview_card: z.object({ titlePrefix: z.string().trim().max(30).optional() }).strict(),
  new_requirements: z
    .object({ emptyBehavior: z.enum(['skip', 'notice']).default('skip'), onlineSourceKeys: z.array(z.string().max(32)).max(20).default([]) })
    .strict(),
  digest: z.object({}).strict(),
};

export function parseSourceConfig(source: ScheduleSource, raw: unknown): Record<string, unknown> {
  const r = SOURCE_CONFIG[source].safeParse(raw ?? {});
  if (!r.success) throw new AppError('invalid', '内容来源的设置有误', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data as Record<string, unknown>;
}

function assertName(name: string): string {
  const v = name.trim();
  if (!v || v.length > 50) throw new AppError('invalid', '定时推送名称不能为空，且不超过 50 个字');
  return v;
}

function assertThreshold(v: number): number {
  if (!Number.isInteger(v) || v < 1 || v > 10) throw new AppError('invalid', '告警阈值应为 1–10 的整数');
  return v;
}

/** P3-A 的定时推送都属于某个产品，由该产品的管理员管理；没有产品的（以后的组织级来源）由组织管理员管理。 */
export async function requireScheduleAdminTx(tx: Tx, actor: Actor, productId: string | null): Promise<void> {
  if (productId) await requireProductRole(tx, actor, productId, 'admin');
  else requireOrgAdmin(actor);
}

export async function scheduleViewsTx(tx: Tx, rows: ScheduleRow[]): Promise<ScheduleView[]> {
  const channelIds = [...new Set(rows.flatMap((r) => r.channelIds))];
  const chans = channelIds.length ? await tx.select().from(notificationChannels).where(inArray(notificationChannels.id, channelIds)) : [];
  const productIds = [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))];
  const prods = productIds.length ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(inArray(products.id, productIds)) : [];
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    product: prods.find((p) => p.id === r.productId) ?? null,
    name: r.name,
    cron: r.cron,
    timezone: r.timezone,
    source: r.source,
    sourceConfig: r.sourceConfig,
    channelIds: r.channelIds,
    channels: r.channelIds.flatMap((id) => {
      const c = chans.find((x) => x.id === id);
      return c ? [channelOption(c)] : [];
    }),
    templateId: r.templateId,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    lastSuccessAt: r.lastSuccessAt,
    consecutiveFailures: r.consecutiveFailures,
    failThreshold: r.failThreshold,
    alertState: r.alertState,
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function loadForUpdate(tx: Tx, id: string): Promise<ScheduleRow> {
  const [row] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)).for('update');
  if (!row) throw new AppError('not_found', NOT_FOUND);
  return row;
}

export async function listSchedules(db: Db, actor: Actor, opts: { productId?: string } = {}): Promise<ScheduleView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    if (opts.productId) await requireProductRole(tx, actor, opts.productId, 'admin');
    else requireOrgAdmin(actor);
    const rows = await tx
      .select()
      .from(notificationSchedules)
      .where(opts.productId ? eq(notificationSchedules.productId, opts.productId) : undefined)
      .orderBy(asc(notificationSchedules.name));
    return scheduleViewsTx(tx, rows);
  });
}

export async function getSchedule(db: Db, actor: Actor, id: string): Promise<ScheduleView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id));
    if (!row) throw new AppError('not_found', NOT_FOUND);
    await requireScheduleAdminTx(tx, actor, row.productId);
    return (await scheduleViewsTx(tx, [row]))[0]!;
  });
}

export async function createSchedule(db: Db, actor: Actor, input: ScheduleInput, opts: { now?: Date } = {}): Promise<ScheduleView> {
  if (!input.productId) throw new AppError('invalid', '请选择产品');
  if (!(SCHEDULE_SOURCES as readonly string[]).includes(input.source)) throw new AppError('invalid', '内容来源无效');
  const name = assertName(input.name);
  const cron = assertCron(input.cron);
  const timezone = assertTimezone(input.timezone ?? SCHEDULE_DEFAULT_TIMEZONE);
  const sourceConfig = parseSourceConfig(input.source, input.sourceConfig);
  const failThreshold = assertThreshold(input.failThreshold ?? 1);
  const enabled = input.enabled ?? true;
  return withOrg(db, actor.orgId, async (tx) => {
    await requireScheduleAdminTx(tx, actor, input.productId);
    const channelIds = await assertUsableChannelsTx(tx, input.channelIds, input.productId, { min: 1 });
    const templateId = await assertTemplateIdTx(tx, input.templateId);
    const [row] = await tx
      .insert(notificationSchedules)
      .values({
        orgId: actor.orgId,
        productId: input.productId,
        name,
        cron,
        timezone,
        source: input.source,
        sourceConfig,
        channelIds,
        templateId,
        enabled,
        failThreshold,
        nextRunAt: enabled ? nextRunAt(cron, timezone, opts.now ?? new Date()) : null,
      })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: input.productId,
      type: 'notification_schedule.created',
      subjectType: 'notification_schedule',
      subjectId: row!.id,
      actor,
      payload: { name, cron, timezone, source: input.source, sourceConfig, channelIds, templateId, enabled, failThreshold },
    });
    return (await scheduleViewsTx(tx, [row!]))[0]!;
  });
}

export async function updateSchedule(db: Db, actor: Actor, id: string, patch: SchedulePatch, opts: { now?: Date } = {}): Promise<ScheduleView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadForUpdate(tx, id);
    await requireScheduleAdminTx(tx, actor, cur.productId);
    const next = {
      name: patch.name === undefined ? cur.name : assertName(patch.name),
      cron: patch.cron === undefined ? cur.cron : assertCron(patch.cron),
      timezone: patch.timezone === undefined ? cur.timezone : assertTimezone(patch.timezone),
      sourceConfig: patch.sourceConfig === undefined ? cur.sourceConfig : parseSourceConfig(cur.source, patch.sourceConfig),
      // 只在提交了通道时校验：迁移来的停用通道不妨碍修改其他字段
      channelIds: patch.channelIds === undefined ? cur.channelIds : await assertUsableChannelsTx(tx, patch.channelIds, cur.productId, { min: 1 }),
      templateId: patch.templateId === undefined ? cur.templateId : await assertTemplateIdTx(tx, patch.templateId),
      enabled: patch.enabled ?? cur.enabled,
      failThreshold: patch.failThreshold === undefined ? cur.failThreshold : assertThreshold(patch.failThreshold),
    };
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]))
      .map((k) => ({ field: k, old: cur[k], new: next[k] }));
    if (changes.length === 0) return (await scheduleViewsTx(tx, [cur]))[0]!;
    const timing = next.cron !== cur.cron || next.timezone !== cur.timezone || next.enabled !== cur.enabled;
    const [row] = await tx
      .update(notificationSchedules)
      .set({
        ...next,
        ...(timing ? { nextRunAt: next.enabled ? nextRunAt(next.cron, next.timezone, opts.now ?? new Date()) : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(notificationSchedules.id, id))
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'notification_schedule.updated',
      subjectType: 'notification_schedule',
      subjectId: id,
      actor,
      payload: { changes },
    });
    return (await scheduleViewsTx(tx, [row!]))[0]!;
  });
}

export async function deleteSchedule(db: Db, actor: Actor, id: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadForUpdate(tx, id);
    await requireScheduleAdminTx(tx, actor, cur.productId);
    const [delivery] = await tx.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(eq(notificationDeliveries.scheduleId, id)).limit(1);
    if (delivery) throw new AppError('conflict', '已有发送记录的定时推送只能停用');
    const [rule] = await tx.select({ id: notificationRules.id }).from(notificationRules).where(eq(notificationRules.digestScheduleId, id)).limit(1);
    if (rule) throw new AppError('conflict', '有摘要规则使用该定时推送，先修改或删除这些规则');
    await tx.delete(notificationSchedules).where(eq(notificationSchedules.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'notification_schedule.deleted',
      subjectType: 'notification_schedule',
      subjectId: id,
      actor,
      payload: { name: cur.name, source: cur.source },
    });
  });
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/schedules';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/notify-schedules.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/notifications/schedules.ts packages/core/src/index.ts packages/core/test/notify-schedules.test.ts
git commit -m "feat(core): 定时推送的新建、修改、停用与删除（按时区排期，产品管理员管理）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: 事件规则与匹配（`recordEvent` 同一事务内写待发记录或摘要条目）

**Files:**
- Create: `packages/core/src/notifications/rules.ts`、`packages/core/src/notifications/match.ts`
- Modify: `packages/core/src/events.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/notify-rules.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `usableChannelsTx`、`assertUsableChannelsTx`、`channelOption`；Task 6 的 `assertTemplateIdTx`；Task 7 的 `createSchedule`（测试）
- Produces:
  - `recordEvent(tx, e): Promise<string>`（返回事件 id；原来是 `Promise<void>`，调用方不受影响）
  - `type RuleRow`、`type RuleView = { id; productId; name; eventTypes: NotifiableEventType[]; filter: RuleFilter; channelIds: string[]; channels: ChannelOption[]; templateId: string | null; mode: RuleMode; digestScheduleId: string | null; digestScheduleName: string | null; enabled: boolean; createdAt: Date; updatedAt: Date }`
  - `type RuleInput = { name: string; eventTypes: string[]; filter?: RuleFilter; channelIds?: string[]; templateId?: string | null; mode?: RuleMode; digestScheduleId?: string | null; enabled?: boolean }`、`type RulePatch = Partial<RuleInput>`
  - `parseRuleFilter(raw: unknown): RuleFilter`
  - `listRules(db, actor, productId)`、`createRule(db, actor, productId, input)`、`updateRule(db, actor, id, patch)`、`deleteRule(db, actor, id)`
  - `type MatchEvent = { id; orgId; productId; type; subjectType; subjectId; payload: Record<string, unknown> }`、`type EventFacts`、`ruleMatches(filter, facts): boolean`、`eventFactsTx(tx, ev): Promise<EventFacts>`、`matchNotificationRules(tx, ev): Promise<void>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/notify-rules.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, notificationDeliveries, notificationDigestItems } from '../src/db/schema';
import { listFields } from '../src/definitions/fields';
import { createDocument, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { updateChannel } from '../src/notifications/channels';
import { ruleMatches } from '../src/notifications/match';
import { createRule, deleteRule, listRules, updateRule } from '../src/notifications/rules';
import { createSchedule } from '../src/notifications/schedules';
import { createRequirement, setRequirementField } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createStructureNode } from '../src/structure/nodes';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pa: Actor;
let productId: string;
let otherProductId: string;
let channelId: string;
let priority: Record<string, string>;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  otherProductId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  pa = await asMember(t.db, owner, '产品管理员丁');
  await setProductRole(t.db, owner, productId, pa.memberId, 'admin');
  channelId = (await wecomChannel(t.db, owner, '研发群')).id;
  const field = (await listFields(t.db, owner, { productId })).find((f) => f.key === 'priority')!;
  priority = Object.fromEntries(field.options.map((o) => [o.key, o.id]));
});
afterAll(() => t.cleanup());

const deliveriesOf = (ruleId: string) => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, ruleId));

describe('过滤条件（纯函数）', () => {
  const req = { requirement: { stateKey: 'doing', priorities: ['p0'], nodePath: ['mod', 'area'] }, documentStatus: null, changedFields: null };
  it('条件之间且、条件内或；空条件通过', () => {
    expect(ruleMatches({}, req)).toBe(true);
    expect(ruleMatches({ states: ['todo', 'doing'], priorities: ['p0'] }, req)).toBe(true);
    expect(ruleMatches({ states: ['doing'], priorities: ['p1'] }, req)).toBe(false);
    expect(ruleMatches({ nodeIds: ['area'] }, req)).toBe(true);
    expect(ruleMatches({ nodeIds: ['other'] }, req)).toBe(false);
  });
  it('不适用于该事件的条件视为通过', () => {
    const doc = { requirement: null, documentStatus: 'review', changedFields: null };
    expect(ruleMatches({ states: ['doing'], documentStatuses: ['review'] }, doc)).toBe(true);
    expect(ruleMatches({ documentStatuses: ['approved'] }, doc)).toBe(false);
    expect(ruleMatches({ fields: ['priority'] }, req)).toBe(true);
    expect(ruleMatches({ fields: ['priority'] }, { ...req, changedFields: ['platform'] })).toBe(false);
  });
});

describe('事件规则', () => {
  it('产品管理员新建即时规则；编辑与只读 Token 不能；校验事件类型、通道与摘要定时推送', async () => {
    const rule = await createRule(t.db, pa, productId, { name: '新需求提醒', eventTypes: ['requirement.created'], channelIds: [channelId] });
    expect(rule).toMatchObject({ name: '新需求提醒', mode: 'immediate', eventTypes: ['requirement.created'], filter: {}, channels: [{ id: channelId, name: '研发群' }], enabled: true });
    expect((await listRules(t.db, pa, productId)).map((r) => r.id)).toContain(rule.id);
    const editor = await asMember(t.db, owner, '编辑丁');
    await expect(createRule(t.db, editor, productId, { name: 'x', eventTypes: ['requirement.created'], channelIds: [channelId] })).rejects.toThrow('权限不足');
    await expect(createRule(t.db, readOnlyToken(owner), productId, { name: 'x', eventTypes: ['requirement.created'], channelIds: [channelId] })).rejects.toThrow('权限不足');
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['comment.created'], channelIds: [channelId] })).rejects.toThrow('不支持订阅的事件');
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['requirement.created'] })).rejects.toThrow('请选择 1–10 个通道');
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['requirement.created'], mode: 'digest' })).rejects.toThrow('请选择摘要定时推送');
    const overview = await createSchedule(t.db, pa, { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId] });
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['requirement.created'], mode: 'digest', digestScheduleId: overview.id })).rejects.toThrow('不是本产品的变更摘要');
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['requirement.created'], channelIds: [channelId], filter: { nodeIds: ['not-a-uuid'] } })).rejects.toThrow('过滤条件有误');
  });

  it('匹配：新建需求在同一事务内写一条待发记录（未渲染）；其他产品的事件不匹配', async () => {
    const rule = (await listRules(t.db, pa, productId)).find((r) => r.name === '新需求提醒')!;
    const req = await createRequirement(t.db, owner, productId, { title: '离线下载' });
    const [event] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, req.id), eq(domainEvents.type, 'requirement.created')));
    expect(await deliveriesOf(rule.id)).toMatchObject([{ kind: 'rule', channelId, eventId: event!.id, status: 'pending', payload: null, attempts: 0 }]);
    await createRequirement(t.db, owner, otherProductId, { title: '相册需求' });
    expect(await deliveriesOf(rule.id)).toHaveLength(1);
  });

  it('过滤：优先级、状态、结构树节点（含下级）、字段', async () => {
    const byPriority = await createRule(t.db, pa, productId, { name: 'P0 新需求', eventTypes: ['requirement.created'], channelIds: [channelId], filter: { priorities: ['p0'] } });
    await createRequirement(t.db, owner, productId, { title: '普通', fields: { priority: [priority.p2!] } });
    await createRequirement(t.db, owner, productId, { title: '紧急', fields: { priority: [priority.p0!] } });
    expect(await deliveriesOf(byPriority.id)).toHaveLength(1);

    const byState = await createRule(t.db, pa, productId, { name: '开始开发', eventTypes: ['requirement.state_changed'], channelIds: [channelId], filter: { states: ['doing'] } });
    const r = await createRequirement(t.db, owner, productId, { title: '流转' });
    await transitionRequirement(t.db, owner, r.id, { to: 'todo' });
    expect(await deliveriesOf(byState.id)).toHaveLength(0);
    await transitionRequirement(t.db, owner, r.id, { to: 'doing' });
    expect(await deliveriesOf(byState.id)).toHaveLength(1);

    const area = await createStructureNode(t.db, owner, productId, { name: '存储' });
    const mod = await createStructureNode(t.db, owner, productId, { parentId: area.id, name: '上传' });
    const byNode = await createRule(t.db, pa, productId, { name: '存储域', eventTypes: ['requirement.created'], channelIds: [channelId], filter: { nodeIds: [area.id] } });
    await createRequirement(t.db, owner, productId, { title: '模块下的需求', nodeId: mod.id });
    await createRequirement(t.db, owner, productId, { title: '没有节点' });
    expect(await deliveriesOf(byNode.id)).toHaveLength(1);

    const byField = await createRule(t.db, pa, productId, { name: '改优先级', eventTypes: ['requirement.field_changed'], channelIds: [channelId], filter: { fields: ['priority'] } });
    await setRequirementField(t.db, owner, r.id, 'priority', [priority.p1!]);
    expect(await deliveriesOf(byField.id)).toHaveLength(1);
  });

  it('PRD 状态过滤；需求条件对 PRD 事件视为通过', async () => {
    const rule = await createRule(t.db, pa, productId, {
      name: 'PRD 提交评审',
      eventTypes: ['document.status_changed'],
      channelIds: [channelId],
      filter: { documentStatuses: ['review'], states: ['doing'] },
    });
    const doc = await createDocument(t.db, owner, productId, { title: '下载 PRD' });
    await transitionDocument(t.db, owner, doc.id, { to: 'review' });
    await transitionDocument(t.db, owner, doc.id, { to: 'approved' });
    expect(await deliveriesOf(rule.id)).toHaveLength(1);
  });

  it('摘要规则写摘要条目；停用的规则与停用的通道不产生记录', async () => {
    const digest = await createSchedule(t.db, pa, { productId, name: '变更摘要', cron: '0 18 * * *', source: 'digest', channelIds: [channelId] });
    const rule = await createRule(t.db, pa, productId, { name: '并入摘要', eventTypes: ['requirement.created'], mode: 'digest', digestScheduleId: digest.id, channelIds: [channelId] });
    expect(rule).toMatchObject({ mode: 'digest', channelIds: [], digestScheduleName: '变更摘要' });
    await createRequirement(t.db, owner, productId, { title: '进摘要' });
    expect(await t.adminDb.select().from(notificationDigestItems).where(eq(notificationDigestItems.ruleId, rule.id))).toMatchObject([{ scheduleId: digest.id, runId: null, consumedAt: null }]);

    const quiet = await createRule(t.db, pa, productId, { name: '停用的规则', eventTypes: ['requirement.created'], channelIds: [channelId], enabled: false });
    const temp = await wecomChannel(t.db, owner, '会停用的群');
    const viaTemp = await createRule(t.db, pa, productId, { name: '走会停用的群', eventTypes: ['requirement.created'], channelIds: [temp.id] });
    await updateChannel(t.db, owner, temp.id, { enabled: false }, TEST_DEPS);
    await createRequirement(t.db, owner, productId, { title: '没人收' });
    expect(await deliveriesOf(quiet.id)).toHaveLength(0);
    expect(await deliveriesOf(viaTemp.id)).toHaveLength(0);
  });

  it('修改与删除：改为摘要规则；有发送记录时只能停用', async () => {
    const rule = await createRule(t.db, pa, productId, { name: '可删规则', eventTypes: ['release.released'], channelIds: [channelId] });
    const updated = await updateRule(t.db, pa, rule.id, { name: '可删规则 2', filter: { priorities: ['p0'] }, enabled: false });
    expect(updated).toMatchObject({ name: '可删规则 2', filter: { priorities: ['p0'] }, enabled: false });
    await deleteRule(t.db, pa, rule.id);
    expect((await listRules(t.db, pa, productId)).some((r) => r.id === rule.id)).toBe(false);
    const used = (await listRules(t.db, pa, productId)).find((r) => r.name === '新需求提醒')!;
    await expect(deleteRule(t.db, pa, used.id)).rejects.toThrow('已有发送记录的规则只能停用');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/notify-rules.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/match'`）。

- [ ] **Step 3: 实现匹配**

新建 `packages/core/src/notifications/match.ts`：

```ts
import { and, arrayContains, eq } from 'drizzle-orm';
import { fieldDefinitions, fieldOptions, fieldValues, notificationDeliveries, notificationDigestItems, notificationRules, requirements, structureNodes } from '../db/schema';
import type { Tx } from '../db/tx';
import { usableChannelsTx } from './channels';
import { isNotifiableEventType, type RuleFilter } from './constants';

export type MatchEvent = { id: string; orgId: string; productId: string; type: string; subjectType: string; subjectId: string; payload: Record<string, unknown> };
/** 过滤要用的事实：需求主体的状态、优先级 key、所在节点及其上级；PRD 变化后的状态；变化的字段 key。不适用的为 null。 */
export type EventFacts = {
  requirement: { stateKey: string; priorities: string[]; nodePath: string[] } | null;
  documentStatus: string | null;
  changedFields: string[] | null;
};

const hit = (want: string[] | undefined, have: string[]): boolean => !want || want.length === 0 || want.some((w) => have.includes(w));

/** 条件之间为且、条件内为或；不适用于该事件的条件视为通过。 */
export function ruleMatches(filter: RuleFilter, facts: EventFacts): boolean {
  if (facts.requirement) {
    if (!hit(filter.states, [facts.requirement.stateKey])) return false;
    if (!hit(filter.priorities, facts.requirement.priorities)) return false;
    if (!hit(filter.nodeIds, facts.requirement.nodePath)) return false;
  }
  if (facts.documentStatus !== null && !hit(filter.documentStatuses, [facts.documentStatus])) return false;
  if (facts.changedFields !== null && !hit(filter.fields, facts.changedFields)) return false;
  return true;
}

const changesOf = (payload: Record<string, unknown>): Array<{ field?: unknown; new?: unknown }> =>
  Array.isArray(payload.changes) ? (payload.changes as Array<{ field?: unknown; new?: unknown }>) : [];

export async function eventFactsTx(tx: Tx, ev: MatchEvent): Promise<EventFacts> {
  let requirement: EventFacts['requirement'] = null;
  if (ev.subjectType === 'requirement') {
    const [req] = await tx.select({ stateKey: requirements.stateKey, nodeId: requirements.nodeId }).from(requirements).where(eq(requirements.id, ev.subjectId));
    if (req) {
      const pri = await tx
        .select({ key: fieldOptions.key })
        .from(fieldValues)
        .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
        .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
        .where(and(eq(fieldValues.entityId, ev.subjectId), eq(fieldDefinitions.key, 'priority')));
      const nodePath: string[] = [];
      let nodeId = req.nodeId;
      while (nodeId && nodePath.length < 3) {
        nodePath.push(nodeId);
        const [n] = await tx.select({ parentId: structureNodes.parentId }).from(structureNodes).where(eq(structureNodes.id, nodeId));
        nodeId = n?.parentId ?? null;
      }
      requirement = { stateKey: req.stateKey, priorities: pri.map((p) => p.key), nodePath };
    }
  }
  const status = ev.type === 'document.status_changed' ? changesOf(ev.payload).find((c) => c.field === 'status')?.new : undefined;
  return {
    requirement,
    documentStatus: typeof status === 'string' ? status : null,
    changedFields: ev.type === 'requirement.field_changed' ? changesOf(ev.payload).map((c) => String(c.field)) : null,
  };
}

/**
 * 在写入领域事件的同一事务内匹配本产品启用的规则：即时规则为每个仍可用的通道写一条待发记录（payload 为空，
 * 由后台发送在第一次发送前渲染）；摘要规则写摘要条目。没有规则时只多一次查询。
 */
export async function matchNotificationRules(tx: Tx, ev: MatchEvent): Promise<void> {
  if (!isNotifiableEventType(ev.type)) return;
  const rules = await tx
    .select()
    .from(notificationRules)
    .where(and(eq(notificationRules.productId, ev.productId), eq(notificationRules.enabled, true), arrayContains(notificationRules.eventTypes, [ev.type])));
  if (rules.length === 0) return;
  const facts = rules.some((r) => Object.keys(r.filter).length > 0) ? await eventFactsTx(tx, ev) : null;
  const now = new Date();
  for (const rule of rules) {
    if (facts && !ruleMatches(rule.filter, facts)) continue;
    if (rule.mode === 'digest') {
      await tx.insert(notificationDigestItems).values({ orgId: ev.orgId, ruleId: rule.id, scheduleId: rule.digestScheduleId!, eventId: ev.id }).onConflictDoNothing();
      continue;
    }
    const channels = await usableChannelsTx(tx, rule.channelIds, ev.productId);
    if (channels.length === 0) continue;
    await tx
      .insert(notificationDeliveries)
      .values(channels.map((c) => ({ orgId: ev.orgId, kind: 'rule' as const, ruleId: rule.id, channelId: c.id, eventId: ev.id, status: 'pending' as const, nextAttemptAt: now })));
  }
}
```

`packages/core/src/events.ts` 改为：

```ts
import { domainEvents } from './db/schema';
import type { Tx } from './db/tx';
import type { Actor } from './domain-types';
import { matchNotificationRules } from './notifications/match';

export type EventInput = {
  orgId: string;
  productId?: string | null;
  type: string;
  subjectType: string;
  subjectId: string;
  actor: Actor | null;
  payload?: Record<string, unknown>;
};

/** 必须在业务修改所在的同一个事务里调用。返回事件 id。 */
export async function recordEvent(tx: Tx, e: EventInput): Promise<string> {
  const payload = { schemaVersion: 1, ...(e.payload ?? {}) };
  const [row] = await tx
    .insert(domainEvents)
    .values({
      orgId: e.orgId,
      productId: e.productId ?? null,
      type: e.type,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      actorMemberId: e.actor?.memberId ?? null,
      actorTokenId: e.actor?.tokenId ?? null,
      payload,
    })
    .returning({ id: domainEvents.id });
  // 推送：同一事务内匹配本产品的事件规则，只写待发记录或摘要条目，不在这里渲染或发送
  if (e.productId) {
    await matchNotificationRules(tx, { id: row!.id, orgId: e.orgId, productId: e.productId, type: e.type, subjectType: e.subjectType, subjectId: e.subjectId, payload });
  }
  return row!.id;
}
```

- [ ] **Step 4: 实现规则服务**

新建 `packages/core/src/notifications/rules.ts`：

```ts
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, notificationDeliveries, notificationDigestItems, notificationRules, notificationSchedules } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertUsableChannelsTx, type ChannelOption, channelOption } from './channels';
import { isNotifiableEventType, type NotifiableEventType, RULE_MODES, type RuleFilter, type RuleMode } from './constants';
import { assertTemplateIdTx } from './message-templates';

export type RuleRow = typeof notificationRules.$inferSelect;
export type RuleView = {
  id: string;
  productId: string;
  name: string;
  eventTypes: NotifiableEventType[];
  filter: RuleFilter;
  channelIds: string[];
  channels: ChannelOption[];
  templateId: string | null;
  mode: RuleMode;
  digestScheduleId: string | null;
  digestScheduleName: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};
export type RuleInput = {
  name: string;
  eventTypes: string[];
  filter?: RuleFilter;
  channelIds?: string[];
  templateId?: string | null;
  mode?: RuleMode;
  digestScheduleId?: string | null;
  enabled?: boolean;
};
export type RulePatch = Partial<RuleInput>;

const NOT_FOUND = '规则不存在';
const values = (item: z.ZodString) => z.array(item).max(50).optional();
const FILTER = z
  .object({
    states: values(z.string().min(1).max(64)),
    priorities: values(z.string().min(1).max(32)),
    nodeIds: values(z.string().uuid()),
    documentStatuses: values(z.string().min(1).max(32)),
    fields: values(z.string().min(1).max(64)),
  })
  .strict();

/** 校验过滤条件，去掉空数组。 */
export function parseRuleFilter(raw: unknown): RuleFilter {
  const r = FILTER.safeParse(raw ?? {});
  if (!r.success) throw new AppError('invalid', '过滤条件有误', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return Object.fromEntries(Object.entries(r.data).filter(([, v]) => Array.isArray(v) && v.length > 0)) as RuleFilter;
}

function assertName(name: string): string {
  const v = name.trim();
  if (!v || v.length > 50) throw new AppError('invalid', '规则名称不能为空，且不超过 50 个字');
  return v;
}

function assertEventTypes(types: string[]): NotifiableEventType[] {
  const unique = [...new Set(types)];
  if (unique.length === 0) throw new AppError('invalid', '至少选择一种事件');
  const bad = unique.filter((x) => !isNotifiableEventType(x));
  if (bad.length > 0) throw new AppError('invalid', `不支持订阅的事件：${bad.join('、')}`);
  return unique as NotifiableEventType[];
}

function assertMode(mode: string): RuleMode {
  if (!(RULE_MODES as readonly string[]).includes(mode)) throw new AppError('invalid', '推送方式无效');
  return mode as RuleMode;
}

/** 即时规则：校验通道；摘要规则：不用通道，摘要定时推送必须是本产品的 digest。 */
async function resolveTargetTx(
  tx: Tx,
  productId: string,
  mode: RuleMode,
  channelIds: string[],
  digestScheduleId: string | null | undefined,
): Promise<{ channelIds: string[]; digestScheduleId: string | null }> {
  if (mode === 'immediate') return { channelIds: await assertUsableChannelsTx(tx, channelIds, productId, { min: 1 }), digestScheduleId: null };
  if (!digestScheduleId) throw new AppError('invalid', '合并到变更摘要时请选择摘要定时推送');
  const [s] = await tx
    .select({ id: notificationSchedules.id, productId: notificationSchedules.productId, source: notificationSchedules.source })
    .from(notificationSchedules)
    .where(eq(notificationSchedules.id, digestScheduleId));
  if (!s || s.source !== 'digest' || s.productId !== productId) throw new AppError('invalid', '摘要定时推送不存在，或不是本产品的变更摘要');
  return { channelIds: [], digestScheduleId: s.id };
}

async function viewsTx(tx: Tx, rows: RuleRow[]): Promise<RuleView[]> {
  const channelIds = [...new Set(rows.flatMap((r) => r.channelIds))];
  const chans = channelIds.length ? await tx.select().from(notificationChannels).where(inArray(notificationChannels.id, channelIds)) : [];
  const scheduleIds = [...new Set(rows.map((r) => r.digestScheduleId).filter((x): x is string => !!x))];
  const schedules = scheduleIds.length
    ? await tx.select({ id: notificationSchedules.id, name: notificationSchedules.name }).from(notificationSchedules).where(inArray(notificationSchedules.id, scheduleIds))
    : [];
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    name: r.name,
    eventTypes: r.eventTypes as NotifiableEventType[],
    filter: r.filter,
    channelIds: r.channelIds,
    channels: r.channelIds.flatMap((id) => {
      const c = chans.find((x) => x.id === id);
      return c ? [channelOption(c)] : [];
    }),
    templateId: r.templateId,
    mode: r.mode,
    digestScheduleId: r.digestScheduleId,
    digestScheduleName: schedules.find((s) => s.id === r.digestScheduleId)?.name ?? null,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function listRules(db: Db, actor: Actor, productId: string): Promise<RuleView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const rows = await tx.select().from(notificationRules).where(eq(notificationRules.productId, productId)).orderBy(asc(notificationRules.name));
    return viewsTx(tx, rows);
  });
}

export async function createRule(db: Db, actor: Actor, productId: string, input: RuleInput): Promise<RuleView> {
  const name = assertName(input.name);
  const eventTypes = assertEventTypes(input.eventTypes);
  const filter = parseRuleFilter(input.filter);
  const mode = assertMode(input.mode ?? 'immediate');
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const target = await resolveTargetTx(tx, productId, mode, input.channelIds ?? [], input.digestScheduleId);
    const templateId = await assertTemplateIdTx(tx, input.templateId);
    const [row] = await tx
      .insert(notificationRules)
      .values({ orgId: actor.orgId, productId, name, eventTypes, filter, mode, templateId, enabled: input.enabled ?? true, ...target })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'notification_rule.created',
      subjectType: 'notification_rule',
      subjectId: row!.id,
      actor,
      payload: { name, eventTypes, filter, mode, templateId, enabled: row!.enabled, ...target },
    });
    return (await viewsTx(tx, [row!]))[0]!;
  });
}

export async function updateRule(db: Db, actor: Actor, id: string, patch: RulePatch): Promise<RuleView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationRules).where(eq(notificationRules.id, id)).for('update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    await requireProductRole(tx, actor, cur.productId, 'admin');
    const mode = patch.mode === undefined ? cur.mode : assertMode(patch.mode);
    const targetChanged = patch.mode !== undefined || patch.channelIds !== undefined || patch.digestScheduleId !== undefined;
    const target = targetChanged
      ? await resolveTargetTx(tx, cur.productId, mode, patch.channelIds ?? cur.channelIds, patch.digestScheduleId === undefined ? cur.digestScheduleId : patch.digestScheduleId)
      : { channelIds: cur.channelIds, digestScheduleId: cur.digestScheduleId };
    const next = {
      name: patch.name === undefined ? cur.name : assertName(patch.name),
      eventTypes: patch.eventTypes === undefined ? cur.eventTypes : assertEventTypes(patch.eventTypes),
      filter: patch.filter === undefined ? cur.filter : parseRuleFilter(patch.filter),
      mode,
      channelIds: target.channelIds,
      digestScheduleId: target.digestScheduleId,
      templateId: patch.templateId === undefined ? cur.templateId : await assertTemplateIdTx(tx, patch.templateId),
      enabled: patch.enabled ?? cur.enabled,
    };
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]))
      .map((k) => ({ field: k, old: cur[k], new: next[k] }));
    if (changes.length === 0) return (await viewsTx(tx, [cur]))[0]!;
    const [row] = await tx
      .update(notificationRules)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(notificationRules.id, id))
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'notification_rule.updated', subjectType: 'notification_rule', subjectId: id, actor, payload: { changes } });
    return (await viewsTx(tx, [row!]))[0]!;
  });
}

export async function deleteRule(db: Db, actor: Actor, id: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationRules).where(eq(notificationRules.id, id)).for('update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    await requireProductRole(tx, actor, cur.productId, 'admin');
    const [delivery] = await tx.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, id)).limit(1);
    const [item] = await tx.select({ id: notificationDigestItems.id }).from(notificationDigestItems).where(eq(notificationDigestItems.ruleId, id)).limit(1);
    if (delivery || item) throw new AppError('conflict', '已有发送记录的规则只能停用');
    await tx.delete(notificationRules).where(eq(notificationRules.id, id));
    await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'notification_rule.deleted', subjectType: 'notification_rule', subjectId: id, actor, payload: { name: cur.name } });
  });
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/match';
export * from './notifications/rules';
```

- [ ] **Step 5: 运行测试确认通过（含全部 core 测试，确认 recordEvent 的改动不影响其他模块）**

Run: `pnpm --filter @flower/core exec vitest run test/notify-rules.test.ts && pnpm --filter @flower/core test && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/notifications/match.ts packages/core/src/notifications/rules.ts packages/core/src/events.ts packages/core/src/index.ts packages/core/test/notify-rules.test.ts
git commit -m "feat(core): 推送事件规则（即时与合并到摘要、过滤条件），领域事件写入时同一事务内匹配

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: 内容来源（事件消息、概览卡片、新需求、变更摘要）与执行定时推送

**Files:**
- Create: `packages/core/src/notifications/sources.ts`、`packages/core/src/notifications/run.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/notify-run.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `renderMessage`、`toChannelPayloads`、`RenderedMessage`；Task 5 的 `usableChannelsTx`；Task 6 的 `resolveTemplateTx`；Task 7 的 `ScheduleRow`、`parseSourceConfig`、`requireScheduleAdminTx`；现有 `iterationOverview`、`todayInZone`、`displayKey`、`documentDisplayKey`、`productWorkflowBody`、`ITERATION_STATUS_LABELS`、`DOCUMENT_STATUS_LABELS`、`CHECK_STATE_LABELS`
- Produces:
  - `type OrgContext = { orgId; slug; name; timeZone; base }`（`base` = `{publicUrl}/{slug}`）、`orgContextTx(tx, orgId, publicUrl): Promise<OrgContext>`、`formatMinute(d: Date, timeZone: string): string`（`MM-DD HH:mm`）、`shortDate(d: Date, timeZone: string): string`（`M/D`）
  - `type EventMessageData = { product: { key; name }; event: { type; label; actor; time }; subject: { key; title; url }; changes: Array<{ label; old; new }>; summary: string; occurredAt: Date; subjectRef: string }`、`eventMessageDataTx(tx, eventId, ctx): Promise<EventMessageData>`
  - `overviewCardDataTx(tx, schedule, ctx, now)`、`newRequirementsDataTx(tx, schedule, ctx, now): Promise<… | null>`、`digestDataTx(tx, schedule, items: Array<{ eventId: string; createdAt: Date }>, ctx)`
  - `type RunResult = { runId: string | null; deliveries: number; skipped: string | null }`
  - `tryScheduleLockTx(tx, scheduleId): Promise<boolean>`
  - `generateScheduleRunTx(tx, schedule: ScheduleRow, deps: { publicUrl: string }, now: Date): Promise<RunResult>`（写待发记录、`last_run_at`、`last_error`；不改 `next_run_at`）
  - `runScheduleNow(db, actor, id, deps: { publicUrl: string }, opts?: { now?: Date }): Promise<RunResult>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/notify-run.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, notificationDeliveries, notificationDigestItems, notificationSchedules } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addFieldOption, listFields } from '../src/definitions/fields';
import { createDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { createChannel } from '../src/notifications/channels';
import { createRule } from '../src/notifications/rules';
import { generateScheduleRunTx, runScheduleNow } from '../src/notifications/run';
import { createSchedule, updateSchedule } from '../src/notifications/schedules';
import { eventMessageDataTx, orgContextTx } from '../src/notifications/sources';
import { createRequirement } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createTask } from '../src/tasks/tasks';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let wecomId: string;
let emailId: string;
const NOW = new Date('2026-10-10T03:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  wecomId = (await wecomChannel(t.db, owner, '研发群')).id;
  emailId = (
    await createChannel(
      t.db,
      owner,
      { kind: 'email', name: '邮件', config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
      TEST_DEPS,
    )
  ).id;
});
afterAll(() => t.cleanup());

const scheduleRow = async (id: string) => (await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)))[0]!;
const generate = (id: string, now: Date) => withOrg(t.db, owner.orgId, async (tx) => generateScheduleRunTx(tx, (await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)))[0]!, TEST_DEPS, now));
const deliveriesOf = (scheduleId: string) => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.scheduleId, scheduleId));

describe('事件消息的数据', () => {
  it('状态换成中文名称；主体带编号、标题与链接；操作人与时间', async () => {
    const productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
    const req = await createRequirement(t.db, owner, productId, { title: '批量下载' });
    await transitionRequirement(t.db, owner, req.id, { to: 'doing' });
    const [ev] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, req.id), eq(domainEvents.type, 'requirement.state_changed')));
    const data = await withOrg(t.db, owner.orgId, async (tx) => eventMessageDataTx(tx, ev!.id, await orgContextTx(tx, owner.orgId, TEST_DEPS.publicUrl)));
    expect(data).toMatchObject({
      product: { key: 'PAN', name: '网盘' },
      event: { type: 'requirement.state_changed', label: '需求状态变化', actor: 'Owner' },
      subject: { key: 'PAN-1', title: '批量下载', url: 'http://flower.example.com/acme/requirements/PAN-1' },
      changes: [{ label: '状态', old: '待处理', new: '进行中' }],
      summary: '状态 待处理 → 进行中',
    });
    expect(data.event.time).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('概览卡片', () => {
  it('取进行中的迭代；整体进度同甘特口径；企微为模板卡片，邮件取标题与描述', async () => {
    const productId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
    const it = await createIteration(t.db, owner, { type: 'regular', productId, name: '迭代1016', startDate: '2026-10-01', endDate: '2026-10-16' });
    await setIterationStatus(t.db, owner, it.id, 'active');
    await createTask(t.db, owner, { productId, iterationId: it.id, title: '前端开发', status: 'done' });
    await createTask(t.db, owner, { productId, iterationId: it.id, title: '接口联调', progress: 50 });
    const s = await createSchedule(t.db, owner, { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [wecomId, emailId] }, { now: NOW });
    const result = await generate(s.id, NOW);
    expect(result).toMatchObject({ deliveries: 2, skipped: null });
    const rows = await deliveriesOf(s.id);
    expect(new Set(rows.map((r) => r.runId))).toEqual(new Set([result.runId]));
    const card = {
      card_type: 'text_notice',
      main_title: { title: '相册 研发日报 · 2026-10-10', desc: '1016 发版 · 整体进度 75% · 点开查看需求与甘特' },
      jump_list: [{ type: 1, title: '查看完整明细', url: `http://flower.example.com/acme/iterations/${it.id}` }],
      card_action: { type: 1, url: `http://flower.example.com/acme/iterations/${it.id}` },
    };
    expect(rows.find((r) => r.channelId === wecomId)!.payload).toEqual({ type: 'json', body: { msgtype: 'template_card', template_card: card } });
    expect(rows.find((r) => r.channelId === emailId)!.payload).toEqual({
      type: 'email',
      subject: '相册 研发日报 · 2026-10-10',
      text: `1016 发版 · 整体进度 75% · 点开查看需求与甘特\n查看完整明细：http://flower.example.com/acme/iterations/${it.id}`,
    });
    expect((await scheduleRow(s.id)).lastRunAt!.toISOString()).toBe(NOW.toISOString());
  });

  it('没有迭代时指向迭代列表；没有可用通道时跳过并记 last_error', async () => {
    const productId = (await createProduct(t.db, owner, { name: '空产品', key: 'EMP' })).id;
    const s = await createSchedule(t.db, owner, { productId, name: '空日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [wecomId], sourceConfig: { titlePrefix: '空日报' } }, { now: NOW });
    await generate(s.id, NOW);
    const [row] = await deliveriesOf(s.id);
    expect(row!.payload).toMatchObject({ body: { template_card: { main_title: { title: '空日报 · 2026-10-10', desc: '当前没有迭代 · 点开查看迭代列表' } } } });
    await t.adminDb.update(notificationSchedules).set({ channelIds: [] }).where(eq(notificationSchedules.id, s.id));
    expect(await generate(s.id, NOW)).toMatchObject({ deliveries: 0, skipped: '没有可用的通道（通道已停用、已删除或不允许本产品使用）' });
    expect((await scheduleRow(s.id)).lastError).toBe('没有可用的通道（通道已停用、已删除或不允许本产品使用）');
  });
});

describe('新需求', () => {
  it('窗口内的需求按 push 版式列出；线上转需求单独分组；PRD 链接；没有新需求时跳过或发提示', async () => {
    const productId = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
    const fields = await listFields(t.db, owner, { productId });
    const priority = fields.find((f) => f.key === 'priority')!;
    const source = fields.find((f) => f.key === 'source')!;
    const online = await addFieldOption(t.db, owner, source.id, { label: '线上问题', key: 'online_issue' });
    const requester = await createPlaceholderMember(t.db, owner, { displayName: '客户甲' });
    const a = await createRequirement(t.db, owner, productId, {
      title: '协同编辑',
      description: '## 背景\n\n多人同时编辑同一文档',
      requesterMemberId: requester.id,
      fields: { priority: [priority.options.find((o) => o.key === 'p0')!.id] },
    });
    await createDocument(t.db, owner, productId, { title: '协同 PRD', externalUrl: 'https://docs.example.com/prd-a', requirementIds: [a.id] });
    const b = await createRequirement(t.db, owner, productId, { title: '导出失败', fields: { priority: [priority.options.find((o) => o.key === 'p2')!.id], source: [online.id] } });
    const s = await createSchedule(
      t.db,
      owner,
      { productId, name: '新需求', cron: '30 9 * * *', source: 'new_requirements', channelIds: [wecomId], sourceConfig: { onlineSourceKeys: ['online_issue'] } },
      { now: NOW },
    );
    const now = new Date(Date.now() + 1000);
    await generate(s.id, now);
    const [row] = await deliveriesOf(s.id);
    const content = (row!.payload as { body: { markdown: { content: string } } }).body.markdown.content;
    expect(content).toMatch(/^# 📋 \d{1,2}\/\d{1,2} 新增需求\n> 🆕 新增 1 条 · 🔧 线上转需求 1 条\n\n\*\*🆕 新增需求\*\*\n\n/);
    expect(content).toContain(`**1. [${a.displayKey} 协同编辑](http://flower.example.com/acme/requirements/${a.displayKey})** <font color="warning">P0</font>\n<font color="comment">客户甲 · —</font>\n<font color="comment">多人同时编辑同一文档</font>\n[PRD ↗](https://docs.example.com/prd-a)`);
    expect(content).toContain(`**🔧 线上转需求**\n\n**2. [${b.displayKey} 导出失败](http://flower.example.com/acme/requirements/${b.displayKey})** <font color="comment">P2</font>\n<font color="comment">— · —</font>`);
    expect(content).toContain('> 👉 [到 Flower 认领 / 分配 ↗](http://flower.example.com/acme/requirements?product=DOC)');

    await t.adminDb.update(notificationSchedules).set({ lastSuccessAt: now }).where(eq(notificationSchedules.id, s.id));
    expect(await generate(s.id, new Date(now.getTime() + 1000))).toMatchObject({ deliveries: 0, skipped: '没有新需求' });
    expect((await scheduleRow(s.id)).lastError).toBeNull();
    await updateSchedule(t.db, owner, s.id, { sourceConfig: { emptyBehavior: 'notice', onlineSourceKeys: ['online_issue'] } });
    await generate(s.id, new Date(now.getTime() + 2000));
    const notice = (await deliveriesOf(s.id)).find((r) => (r.payload as { body: { msgtype: string } }).body.msgtype === 'text');
    expect((notice!.payload as { body: { text: { content: string } } }).body.text.content).toMatch(/^文档 \d{1,2}\/\d{1,2} 没有新需求$/);
  });
});

describe('变更摘要', () => {
  it('取未消费的条目按对象分组，写上 run_id；再次执行时没有新条目则跳过', async () => {
    const productId = (await createProduct(t.db, owner, { name: '会员', key: 'VIP' })).id;
    const s = await createSchedule(t.db, owner, { productId, name: '变更摘要', cron: '0 18 * * *', source: 'digest', channelIds: [wecomId] }, { now: NOW });
    await createRule(t.db, owner, productId, { name: '状态并入摘要', eventTypes: ['requirement.state_changed'], mode: 'digest', digestScheduleId: s.id });
    const r1 = await createRequirement(t.db, owner, productId, { title: '续费提醒' });
    const r2 = await createRequirement(t.db, owner, productId, { title: '发票' });
    await transitionRequirement(t.db, owner, r1.id, { to: 'todo' });
    await transitionRequirement(t.db, owner, r1.id, { to: 'doing' });
    await transitionRequirement(t.db, owner, r2.id, { to: 'done' });
    const result = await generate(s.id, new Date(Date.now() + 1000));
    expect(result.deliveries).toBe(1);
    const items = await t.adminDb.select().from(notificationDigestItems).where(eq(notificationDigestItems.scheduleId, s.id));
    expect(items.every((i) => i.runId === result.runId && i.consumedAt === null)).toBe(true);
    const [row] = await deliveriesOf(s.id);
    const content = (row!.payload as { body: { markdown: { content: string } } }).body.markdown.content;
    expect(content).toContain('# 📋 会员 变更摘要');
    expect(content).toContain('共 3 项变化，涉及 2 个对象');
    expect(content).toContain(`**[${r1.displayKey} 续费提醒](http://flower.example.com/acme/requirements/${r1.displayKey})**`);
    expect(content).toMatch(/> \d{2}-\d{2} \d{2}:\d{2} Owner：需求状态变化：状态 待开始 → 进行中/);
    expect(await generate(s.id, new Date(Date.now() + 2000))).toMatchObject({ deliveries: 0, skipped: '没有待合并的变化' });
  });
});

describe('立即执行', () => {
  it('产品管理员可以；编辑与只读 Token 不能；记事件', async () => {
    const productId = (await createProduct(t.db, owner, { name: '传输', key: 'TRS' })).id;
    const pa = await asMember(t.db, owner, '产品管理员戊');
    await setProductRole(t.db, owner, productId, pa.memberId, 'admin');
    const s = await createSchedule(t.db, pa, { productId, name: '传输日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [wecomId] }, { now: NOW });
    const editor = await asMember(t.db, owner, '编辑戊');
    await expect(runScheduleNow(t.db, editor, s.id, TEST_DEPS)).rejects.toThrow('权限不足');
    await expect(runScheduleNow(t.db, readOnlyToken(owner), s.id, TEST_DEPS)).rejects.toThrow('权限不足');
    expect(await runScheduleNow(t.db, pa, s.id, TEST_DEPS, { now: NOW })).toMatchObject({ deliveries: 1, skipped: null });
    const events = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, s.id), eq(domainEvents.type, 'notification_schedule.run')));
    expect(events[0]!.payload).toMatchObject({ manual: true, deliveries: 1, skipped: null });
    expect((await scheduleRow(s.id)).nextRunAt!.toISOString()).toBe('2026-10-12T11:00:00.000Z');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/notify-run.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/run'`）。

- [ ] **Step 3: 实现内容来源**

新建 `packages/core/src/notifications/sources.ts`：

```ts
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  documents,
  domainEvents,
  fieldDefinitions,
  fieldOptions,
  fieldValues,
  functionTags,
  iterations,
  members,
  organizations,
  products,
  releases,
  requirements,
  tasks,
} from '../db/schema';
import type { Tx } from '../db/tx';
import { DOCUMENT_STATUS_LABELS, documentDisplayKey } from '../documents/markdown';
import { AppError } from '../errors';
import { ITERATION_STATUS_LABELS } from '../iterations/iterations';
import { productWorkflowBody } from '../requirements/context';
import { CHECK_STATE_LABELS } from '../requirements/labels';
import { displayKey } from '../requirements/requirements';
import { iterationOverview, todayInZone } from '../tasks/schedule';
import { EVENT_TYPE_LABELS, isNotifiableEventType, type NewRequirementsConfig, type OverviewCardConfig, SCHEDULE_DEFAULT_TIMEZONE } from './constants';
import { parseSourceConfig, type ScheduleRow } from './schedules';

export type OrgContext = { orgId: string; slug: string; name: string; timeZone: string; base: string };

const validZone = (tz: string | undefined): string | null => {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
};

export async function orgContextTx(tx: Tx, orgId: string, publicUrl: string): Promise<OrgContext> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new AppError('not_found', '组织不存在');
  return {
    orgId,
    slug: org.slug,
    name: org.name,
    timeZone: validZone(org.settings.timezone) ?? SCHEDULE_DEFAULT_TIMEZONE,
    base: `${publicUrl.replace(/\/+$/, '')}/${org.slug}`,
  };
}

function zoned(d: Date, timeZone: string): { m: string; d: string; hh: string; mm: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { m: parts.month!, d: parts.day!, hh: parts.hour!, mm: parts.minute! };
}

/** 按时区格式化为 MM-DD HH:mm。 */
export function formatMinute(d: Date, timeZone: string): string {
  const p = zoned(d, timeZone);
  return `${p.m}-${p.d} ${p.hh}:${p.mm}`;
}

/** 按时区格式化为 M/D（push 新需求标题的写法）。 */
export function shortDate(d: Date, timeZone: string): string {
  const p = zoned(d, timeZone);
  return `${Number(p.m)}/${Number(p.d)}`;
}

const valueText = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '空';
  if (Array.isArray(v)) return v.length ? v.map(valueText).join('、') : '空';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const RELEASE_STATUS_LABELS: Record<string, string> = { planned: '计划中', released: '已发布' };

export type EventMessageData = {
  product: { key: string; name: string };
  event: { type: string; label: string; actor: string; time: string };
  subject: { key: string; title: string; url: string };
  changes: Array<{ label: string; old: string; new: string }>;
  summary: string;
  occurredAt: Date;
  subjectRef: string;
};

type EventRow = typeof domainEvents.$inferSelect;

async function subjectTx(tx: Tx, ev: EventRow, productKey: string, ctx: OrgContext): Promise<EventMessageData['subject']> {
  if (ev.subjectType === 'requirement') {
    const [r] = await tx.select({ number: requirements.number, title: requirements.title }).from(requirements).where(eq(requirements.id, ev.subjectId));
    if (r) {
      const key = displayKey(productKey, r.number);
      return { key, title: r.title, url: `${ctx.base}/requirements/${key}` };
    }
  }
  if (ev.subjectType === 'document') {
    const [d] = await tx.select({ number: documents.number, title: documents.title }).from(documents).where(eq(documents.id, ev.subjectId));
    if (d) {
      const key = documentDisplayKey(productKey, d.number);
      return { key, title: d.title, url: `${ctx.base}/documents/${key}` };
    }
  }
  if (ev.subjectType === 'iteration') {
    const [i] = await tx.select({ name: iterations.name }).from(iterations).where(eq(iterations.id, ev.subjectId));
    if (i) return { key: '迭代', title: i.name, url: `${ctx.base}/iterations/${ev.subjectId}` };
  }
  if (ev.subjectType === 'release') {
    const [r] = await tx.select({ name: releases.versionName }).from(releases).where(eq(releases.id, ev.subjectId));
    if (r) return { key: '版本', title: r.name, url: `${ctx.base}/iterations` };
  }
  return { key: '', title: '', url: ctx.base };
}

async function changeLinesTx(tx: Tx, ev: EventRow): Promise<EventMessageData['changes']> {
  const raw = Array.isArray(ev.payload.changes) ? (ev.payload.changes as Array<{ field: string; old: unknown; new: unknown }>) : [];
  const out: EventMessageData['changes'] = [];
  for (const c of raw) {
    if (c.field === 'stateKey' && ev.productId) {
      const body = await productWorkflowBody(tx, ev.productId);
      const name = (k: unknown) => (k ? (body.states.find((s) => s.key === k)?.label ?? String(k)) : '空');
      out.push({ label: '状态', old: name(c.old), new: name(c.new) });
    } else if (c.field === 'iterationId') {
      const nameOf = async (id: unknown) =>
        typeof id === 'string' ? ((await tx.select({ name: iterations.name }).from(iterations).where(eq(iterations.id, id)))[0]?.name ?? '已删除的迭代') : '空';
      const named = typeof ev.payload.iterationName === 'string' ? ev.payload.iterationName : null;
      out.push({ label: '迭代', old: await nameOf(c.old), new: named ?? (await nameOf(c.new)) });
    } else if (c.field === 'status') {
      const labels: Record<string, string> =
        ev.subjectType === 'document' ? DOCUMENT_STATUS_LABELS : ev.subjectType === 'iteration' ? ITERATION_STATUS_LABELS : RELEASE_STATUS_LABELS;
      out.push({ label: '状态', old: labels[String(c.old)] ?? valueText(c.old), new: labels[String(c.new)] ?? valueText(c.new) });
    } else if (c.field === 'assignments') {
      const a = (c.new ?? {}) as { memberId?: string; functionTagId?: string };
      const [m] = a.memberId ? await tx.select({ name: members.displayName }).from(members).where(eq(members.id, a.memberId)) : [];
      const [tag] = a.functionTagId ? await tx.select({ name: functionTags.name }).from(functionTags).where(eq(functionTags.id, a.functionTagId)) : [];
      out.push({ label: '分配', old: '空', new: [m?.name, tag?.name].filter(Boolean).join(' · ') || '空' });
    } else if (c.field === 'state') {
      const labels = CHECK_STATE_LABELS as Record<string, string>;
      out.push({ label: `检查项「${String(ev.payload.itemKey ?? '')}」`, old: labels[String(c.old)] ?? valueText(c.old), new: labels[String(c.new)] ?? valueText(c.new) });
    } else if (ev.type === 'requirement.field_changed') {
      const [f] = await tx
        .select({ label: fieldDefinitions.label })
        .from(fieldDefinitions)
        .where(and(eq(fieldDefinitions.key, c.field), ev.productId ? or(eq(fieldDefinitions.productId, ev.productId), isNull(fieldDefinitions.productId)) : isNull(fieldDefinitions.productId)))
        .orderBy(sql`${fieldDefinitions.productId} nulls last`)
        .limit(1);
      out.push({ label: f?.label ?? c.field, old: valueText(c.old), new: valueText(c.new) });
    } else {
      out.push({ label: c.field, old: valueText(c.old), new: valueText(c.new) });
    }
  }
  return out;
}

export async function eventMessageDataTx(tx: Tx, eventId: string, ctx: OrgContext): Promise<EventMessageData> {
  const [ev] = await tx.select().from(domainEvents).where(eq(domainEvents.id, eventId));
  if (!ev) throw new AppError('not_found', '事件不存在');
  const [product] = ev.productId ? await tx.select({ key: products.key, name: products.name }).from(products).where(eq(products.id, ev.productId)) : [];
  const [actor] = ev.actorMemberId ? await tx.select({ name: members.displayName }).from(members).where(eq(members.id, ev.actorMemberId)) : [];
  const label = isNotifiableEventType(ev.type) ? EVENT_TYPE_LABELS[ev.type] : ev.type;
  const changes = await changeLinesTx(tx, ev);
  return {
    product: product ?? { key: '', name: ctx.name },
    event: { type: ev.type, label, actor: actor?.name ?? '系统', time: formatMinute(ev.occurredAt, ctx.timeZone) },
    subject: await subjectTx(tx, ev, product?.key ?? '', ctx),
    changes,
    summary: changes.length ? changes.map((c) => `${c.label} ${c.old} → ${c.new}`).join('；') : label,
    occurredAt: ev.occurredAt,
    subjectRef: `${ev.subjectType}:${ev.subjectId}`,
  };
}

async function productOf(tx: Tx, s: ScheduleRow): Promise<{ id: string; key: string; name: string }> {
  const [p] = await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(eq(products.id, s.productId!));
  if (!p) throw new AppError('not_found', '定时推送的产品不存在');
  return p;
}

/** 本产品的当前迭代：进行中（结束日最早）→ 规划中（开始日最早）→ 已完成（结束日最晚）。 */
function pickIteration<T extends { status: string; startDate: string; endDate: string }>(its: T[]): T | undefined {
  const by = (status: string, cmp: (a: T, b: T) => number) => its.filter((i) => i.status === status).sort(cmp)[0];
  return (
    by('active', (a, b) => a.endDate.localeCompare(b.endDate)) ??
    by('planning', (a, b) => a.startDate.localeCompare(b.startDate)) ??
    by('done', (a, b) => b.endDate.localeCompare(a.endDate))
  );
}

export async function overviewCardDataTx(tx: Tx, s: ScheduleRow, ctx: OrgContext, now: Date): Promise<Record<string, unknown>> {
  const product = await productOf(tx, s);
  const cfg = s.sourceConfig as OverviewCardConfig;
  const today = todayInZone(s.timezone, now);
  const title = `${cfg.titlePrefix || `${product.name} 研发日报`} · ${today}`;
  const its = await tx
    .select()
    .from(iterations)
    .where(and(eq(iterations.productId, product.id), eq(iterations.type, 'regular'), isNull(iterations.deletedAt), ne(iterations.status, 'canceled')));
  const it = pickIteration(its);
  if (!it) return { title, desc: '当前没有迭代 · 点开查看迭代列表', button: { title: '查看迭代列表', url: `${ctx.base}/iterations` }, product, iteration: null, overall: null };
  const rows = await tx.select().from(tasks).where(and(eq(tasks.iterationId, it.id), eq(tasks.productId, product.id)));
  const reqIds = [...new Set(rows.map((r) => r.requirementId).filter((x): x is string => !!x))];
  const reqs = reqIds.length ? await tx.select({ id: requirements.id, number: requirements.number, title: requirements.title }).from(requirements).where(inArray(requirements.id, reqIds)) : [];
  const assigneeIds = [...new Set(rows.map((r) => r.assigneeMemberId).filter((x): x is string => !!x))];
  const names = assigneeIds.length ? await tx.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, assigneeIds)) : [];
  const overview = iterationOverview(
    rows.map((r) => {
      const req = reqs.find((x) => x.id === r.requirementId);
      return {
        status: r.status,
        planStart: r.planStart,
        planDays: r.planDays,
        delayDays: r.delayDays,
        progressOverride: typeof r.meta.progress === 'number' ? r.meta.progress : null,
        requirementId: r.requirementId,
        title: req ? `${displayKey(product.key, req.number)} ${req.title}` : r.title,
        flag: r.flag === 'attention' ? ('attention' as const) : null,
        note: typeof r.meta.note === 'string' && r.meta.note ? r.meta.note : null,
        assigneeName: names.find((n) => n.id === r.assigneeMemberId)?.name ?? null,
      };
    }),
    it,
    today,
  );
  const mmdd = `${it.endDate.slice(5, 7)}${it.endDate.slice(8, 10)}`;
  return {
    title,
    desc: `${mmdd} 发版 · 整体进度 ${overview.overall}% · 点开查看需求与甘特`,
    button: { title: '查看完整明细', url: `${ctx.base}/iterations/${it.id}` },
    product,
    iteration: { name: it.name, startDate: it.startDate, endDate: it.endDate, status: it.status },
    overall: overview.overall,
    expected: overview.expected,
  };
}

/** 需求说明：描述里第一行不是标题的文字，去掉开头的引用、列表标记，最多 80 字。 */
const briefOf = (description: string): string => {
  const line = description
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  const text = (line ?? '').replace(/^[>*\-\s]+/, '').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

/** 时间窗内新建的需求（push 新需求的版式数据）；没有时返回 null。 */
export async function newRequirementsDataTx(tx: Tx, s: ScheduleRow, ctx: OrgContext, now: Date): Promise<Record<string, unknown> | null> {
  const product = await productOf(tx, s);
  const cfg = parseSourceConfig('new_requirements', s.sourceConfig) as NewRequirementsConfig;
  const since = s.lastSuccessAt ?? new Date(now.getTime() - 24 * 3600_000);
  const rows = await tx
    .select()
    .from(requirements)
    .where(and(eq(requirements.productId, product.id), isNull(requirements.deletedAt), gt(requirements.createdAt, since), lte(requirements.createdAt, now)))
    .orderBy(asc(requirements.number));
  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.id);
  const values = await tx
    .select({ entityId: fieldValues.entityId, field: fieldDefinitions.key, key: fieldOptions.key, label: fieldOptions.label })
    .from(fieldValues)
    .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .where(and(inArray(fieldValues.entityId, ids), inArray(fieldDefinitions.key, ['priority', 'line', 'platform', 'source'])))
    .orderBy(asc(fieldOptions.sort));
  const opts = (id: string, field: string) => values.filter((v) => v.entityId === id && v.field === field);
  const requesterIds = [...new Set(rows.map((r) => r.requesterMemberId).filter((x): x is string => !!x))];
  const people = requesterIds.length ? await tx.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, requesterIds)) : [];
  const docIds = [...new Set(rows.map((r) => r.changeDocumentId).filter((x): x is string => !!x))];
  const docs = docIds.length
    ? await tx.select({ id: documents.id, number: documents.number, source: documents.source, externalUrl: documents.externalUrl }).from(documents).where(inArray(documents.id, docIds))
    : [];
  const items = rows.map((r) => {
    const key = displayKey(product.key, r.number);
    const pr = opts(r.id, 'priority')[0];
    const platforms = opts(r.id, 'platform').map((v) => v.label);
    const doc = docs.find((d) => d.id === r.changeDocumentId);
    return {
      online: opts(r.id, 'source').some((v) => cfg.onlineSourceKeys.includes(v.key)),
      key,
      title: r.title,
      url: `${ctx.base}/requirements/${key}`,
      priority: pr?.label ?? '—',
      priorityColor: pr && (pr.key === 'p0' || pr.key === 'p1') ? 'warning' : 'comment',
      meta: [people.find((p) => p.id === r.requesterMemberId)?.name ?? '—', opts(r.id, 'line')[0]?.label ?? '—', ...(platforms.length ? [platforms.join('/')] : [])].join(' · '),
      brief: briefOf(r.description),
      prdUrl: doc ? (doc.source === 'external' ? (doc.externalUrl ?? '') : `${ctx.base}/documents/${documentDisplayKey(product.key, doc.number)}`) : '',
    };
  });
  const normal = items.filter((i) => !i.online);
  const online = items.filter((i) => i.online);
  let index = 0;
  const numbered = (list: typeof items) => list.map(({ online: _online, ...rest }) => ({ index: ++index, ...rest }));
  return {
    product,
    date: shortDate(now, s.timezone),
    newCount: normal.length,
    onlineCount: online.length,
    sections: [
      { title: '🆕 新增需求', items: numbered(normal) },
      { title: '🔧 线上转需求', items: numbered(online) },
    ].filter((x) => x.items.length > 0),
    listUrl: `${ctx.base}/requirements?product=${product.key}`,
  };
}

/** 摘要条目按主体分组（按出现顺序），组内按时间列出。 */
export async function digestDataTx(tx: Tx, s: ScheduleRow, items: Array<{ eventId: string; createdAt: Date }>, ctx: OrgContext): Promise<Record<string, unknown>> {
  const product = await productOf(tx, s);
  const sorted = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const datas: EventMessageData[] = [];
  for (const it of sorted) datas.push(await eventMessageDataTx(tx, it.eventId, ctx));
  const groups = new Map<string, EventMessageData[]>();
  for (const d of datas) groups.set(d.subjectRef, [...(groups.get(d.subjectRef) ?? []), d]);
  const times = datas.map((d) => d.occurredAt.getTime());
  return {
    product,
    period: `${formatMinute(new Date(Math.min(...times)), ctx.timeZone)} – ${formatMinute(new Date(Math.max(...times)), ctx.timeZone)}`,
    eventCount: datas.length,
    subjectCount: groups.size,
    groups: [...groups.values()].map((g) => ({
      key: g[0]!.subject.key,
      title: g[0]!.subject.title,
      url: g[0]!.subject.url,
      lines: g.map((d) => ({ text: `${d.event.time} ${d.event.actor}：${d.event.label}${d.changes.length ? `：${d.summary}` : ''}` })),
    })),
  };
}
```

- [ ] **Step 4: 实现执行**

新建 `packages/core/src/notifications/run.ts`：

```ts
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { notificationDeliveries, notificationDigestItems, notificationSchedules, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { newId } from '../ids';
import { usableChannelsTx } from './channels';
import type { NewRequirementsConfig } from './constants';
import { resolveTemplateTx } from './message-templates';
import { parseSourceConfig, requireScheduleAdminTx, type ScheduleRow } from './schedules';
import { digestDataTx, newRequirementsDataTx, orgContextTx, overviewCardDataTx, shortDate } from './sources';
import { type RenderedMessage, renderMessage, toChannelPayloads } from './template';

export type RunResult = { runId: string | null; deliveries: number; skipped: string | null };

const DIGEST_BATCH = 200;
export const NO_CHANNEL = '没有可用的通道（通道已停用、已删除或不允许本产品使用）';

/** 同一定时推送同时只能有一处在执行（多实例互斥）；拿不到锁返回 false。 */
export async function tryScheduleLockTx(tx: Tx, scheduleId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`flower:notify-schedule:${scheduleId}`}, 0)) as locked`)) as unknown as [{ locked: boolean }];
  return row!.locked;
}

/**
 * 生成一次执行的内容：按来源取数、用模板渲染、为每个可用通道写待发记录（同一个 run_id），
 * 更新 last_run_at 与 last_error。不改 next_run_at（由后台循环或调用方决定）。
 */
export async function generateScheduleRunTx(tx: Tx, s: ScheduleRow, deps: { publicUrl: string }, now: Date): Promise<RunResult> {
  const skip = async (reason: string, isError: boolean): Promise<RunResult> => {
    await tx.update(notificationSchedules).set({ lastRunAt: now, lastError: isError ? reason : null, updatedAt: now }).where(eq(notificationSchedules.id, s.id));
    return { runId: null, deliveries: 0, skipped: reason };
  };
  if (!s.productId) return skip('定时推送没有指定产品', true);
  const channels = await usableChannelsTx(tx, s.channelIds, s.productId);
  if (channels.length === 0) return skip(NO_CHANNEL, true);
  const ctx = await orgContextTx(tx, s.orgId, deps.publicUrl);
  const tpl = await resolveTemplateTx(tx, s.templateId, s.source);
  const runId = newId();
  let messages: RenderedMessage[];
  if (s.source === 'overview_card') {
    messages = [renderMessage(tpl.format, tpl.body, await overviewCardDataTx(tx, s, ctx, now))];
  } else if (s.source === 'new_requirements') {
    const data = await newRequirementsDataTx(tx, s, ctx, now);
    if (data) messages = [renderMessage(tpl.format, tpl.body, data)];
    else {
      const cfg = parseSourceConfig('new_requirements', s.sourceConfig) as NewRequirementsConfig;
      if (cfg.emptyBehavior !== 'notice') return skip('没有新需求', false);
      const [p] = await tx.select({ name: products.name }).from(products).where(eq(products.id, s.productId));
      messages = [{ format: 'text', text: `${p?.name ?? ''} ${shortDate(now, s.timezone)} 没有新需求` }];
    }
  } else {
    const open = tx
      .select({ id: notificationDigestItems.id })
      .from(notificationDigestItems)
      .where(and(eq(notificationDigestItems.scheduleId, s.id), isNull(notificationDigestItems.consumedAt), isNull(notificationDigestItems.runId)))
      .orderBy(asc(notificationDigestItems.createdAt))
      .limit(DIGEST_BATCH);
    const items = await tx
      .update(notificationDigestItems)
      .set({ runId })
      .where(inArray(notificationDigestItems.id, open))
      .returning({ eventId: notificationDigestItems.eventId, createdAt: notificationDigestItems.createdAt });
    if (items.length === 0) return skip('没有待合并的变化', false);
    messages = [renderMessage(tpl.format, tpl.body, await digestDataTx(tx, s, items, ctx))];
  }
  const rows = channels.flatMap((c) =>
    messages
      .flatMap((m) => toChannelPayloads(c.kind, m))
      .map((payload) => ({ orgId: s.orgId, kind: 'schedule' as const, scheduleId: s.id, runId, channelId: c.id, payload, status: 'pending' as const, nextAttemptAt: now })),
  );
  await tx.insert(notificationDeliveries).values(rows);
  await tx.update(notificationSchedules).set({ lastRunAt: now, lastError: null, updatedAt: now }).where(eq(notificationSchedules.id, s.id));
  return { runId, deliveries: rows.length, skipped: null };
}

/** 立即执行：只生成待发记录，由后台循环发送；不改 next_run_at。 */
export async function runScheduleNow(db: Db, actor: Actor, id: string, deps: { publicUrl: string }, opts: { now?: Date } = {}): Promise<RunResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id));
    if (!cur) throw new AppError('not_found', '定时推送不存在');
    await requireScheduleAdminTx(tx, actor, cur.productId);
    if (!(await tryScheduleLockTx(tx, id))) throw new AppError('conflict', '该定时推送正在执行，请稍后再试');
    const [fresh] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id));
    const result = await generateScheduleRunTx(tx, fresh!, deps, opts.now ?? new Date());
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'notification_schedule.run',
      subjectType: 'notification_schedule',
      subjectId: id,
      actor,
      payload: { manual: true, deliveries: result.deliveries, skipped: result.skipped },
    });
    return result;
  });
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/sources';
export * from './notifications/run';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/notify-run.test.ts && pnpm typecheck`
Expected: PASS。若概览卡片的整体进度不是 75，先核对 `iterationOverview` 对「已完成 = 100、手动进度 50」两行的平均，不要改断言去迁就实现。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/notifications/sources.ts packages/core/src/notifications/run.ts packages/core/src/index.ts packages/core/test/notify-run.test.ts
git commit -m "feat(core): 推送内容来源（事件消息、概览卡片、新需求、变更摘要）与执行定时推送

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: 发送、重试、限流、执行结果与告警；测试消息、重发、发送记录列表

**Files:**
- Create: `packages/core/src/notifications/sender.ts`、`packages/core/src/notifications/deliveries.ts`
- Modify: `packages/core/package.json`、`pnpm-lock.yaml`（依赖 `nodemailer@10.0.16`）、`packages/core/src/index.ts`、`apps/web/next.config.ts`
- Create: `packages/core/test/notify-transport.ts`
- Test: `packages/core/test/notify-deliveries.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `toChannelPayloads`、`renderMessage`、`payloadPreview`；Task 5 的 `readChannelConfig`、`ChannelRow`；Task 6 的 `resolveTemplateTx`；Task 9 的 `orgContextTx`、`eventMessageDataTx`、`formatMinute`
- Produces:
  - `sender.ts`：`type HttpResult = { status: number; text: string }`、`type Transport = { postJson(url, body: string, headers): Promise<HttpResult>; sendMail(config: EmailConfig, message: { subject; text }): Promise<string> }`、`type NotifyDeps = { secretKey: string; publicUrl: string; transport: Transport }`、`defaultTransport`、`type SendOutcome = { result: 'sent' | 'failed' | 'rate_limited'; response: string }`、`classifyHttp(kind, res)`、`signWebhook(secret, timestamp, body)`、`sendPayload(kind, config, payload, transport, now)`、`retryDelayMs(attempts): number | null`
  - `deliveries.ts`：`type DeliveryView = { id; kind: DeliveryKind; source: { type: DeliveryKind; id: string | null; name: string | null; alert: boolean }; channel: { id; name; kind: ChannelKind }; eventId: string | null; status: DeliveryStatus; attempts: number; nextAttemptAt: Date | null; response: string | null; sentAt: Date | null; createdAt: Date; preview: string; legacy: boolean; canResend: boolean }`、`type DeliveryQuery = { channelId?; kind?; status?; from?: Date; to?: Date; before?: string; limit?: number }`、`type ProcessSummary = { sent; failed; dead; rateLimited }`
  - `processDueDeliveries(db, orgId, deps: NotifyDeps, now: Date, opts?: { onlyIds?: string[] }): Promise<ProcessSummary>`
  - `sendTestMessage(db, actor, channelId, deps): Promise<DeliveryView>`、`resendDelivery(db, actor, id): Promise<DeliveryView>`、`listDeliveries(db, actor, query): Promise<{ deliveries: DeliveryView[]; nextCursor: string | null }>`
  - 测试辅助 `test/notify-transport.ts`：`fakeTransport(responder?)` → `{ calls, mails, transport, reset(responder) }`

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @flower/core add nodemailer@10.0.16 --save-exact`
Expected: `packages/core/package.json` 的 `dependencies` 出现 `"nodemailer": "10.0.16"`（无 `^`），`pnpm-lock.yaml` 更新。不安装 `@types/nodemailer`（10.x 自带类型）。

`apps/web/next.config.ts` 的 `serverExternalPackages: ['@node-rs/argon2'],` 改为：

```ts
  serverExternalPackages: ['@node-rs/argon2', 'nodemailer'],
```

- [ ] **Step 2: 写测试辅助与失败的测试**

新建 `packages/core/test/notify-transport.ts`：

```ts
import type { EmailConfig } from '../src/notifications/channel-config';
import type { HttpResult, Transport } from '../src/notifications/sender';

export type FakeCall = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
type Responder = (call: FakeCall) => HttpResult;

/** 假发送器：记录每次调用并按 responder 返回；不连任何网络。 */
export function fakeTransport(initial: Responder = () => ({ status: 200, text: '{"errcode":0,"errmsg":"ok"}' })) {
  let responder = initial;
  const calls: FakeCall[] = [];
  const mails: Array<{ to: string[]; subject: string; text: string }> = [];
  const transport: Transport = {
    async postJson(url, body, headers) {
      const call = { url, body: JSON.parse(body) as Record<string, unknown>, headers };
      calls.push(call);
      return responder(call);
    },
    async sendMail(cfg: EmailConfig, msg) {
      mails.push({ to: cfg.to, ...msg });
      return 'SMTP 已接受 1 个收件人';
    },
  };
  return {
    calls,
    mails,
    transport,
    reset(next: Responder) {
      responder = next;
      calls.length = 0;
      mails.length = 0;
    },
  };
}
```

新建 `packages/core/test/notify-deliveries.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notificationDeliveries, notificationDigestItems, notificationSchedules } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createChannel, updateChannel } from '../src/notifications/channels';
import { listDeliveries, processDueDeliveries, resendDelivery, sendTestMessage } from '../src/notifications/deliveries';
import { createRule } from '../src/notifications/rules';
import { runScheduleNow } from '../src/notifications/run';
import { createSchedule } from '../src/notifications/schedules';
import { classifyHttp, retryDelayMs, signWebhook } from '../src/notifications/sender';
import { createRequirement } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
const fake = fakeTransport();
const deps = { ...TEST_DEPS, transport: fake.transport };
const OK = { status: 200, text: '{"errcode":0,"errmsg":"ok"}' };
const BAD = { status: 200, text: '{"errcode":93000,"errmsg":"invalid webhook url"}' };
const LIMITED = { status: 200, text: '{"errcode":45009,"errmsg":"api freq out of limit"}' };
/** 每个用例用自己的地址（都指向本机不可达端口，只经假发送器）。 */
const url = (name: string) => `http://127.0.0.1:9/cgi-bin/webhook/send?key=${name}-0001`;
const callsTo = (u: string) => fake.calls.filter((c) => c.url === u);
const row = async (id: string) => (await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]!;
const ofRule = (ruleId: string) => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, ruleId));
const process = (now: Date) => processDueDeliveries(t.db, owner.orgId, deps, now);
const later = (ms = 1000) => new Date(Date.now() + ms);
let seq = 0;
const newProduct = async () => (await createProduct(t.db, owner, { name: `产品${++seq}`, key: `P${seq}X` })).id;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
});
afterAll(() => t.cleanup());
beforeEach(() => fake.reset(() => OK));

describe('发送结果判断', () => {
  it('企微 errcode、HTTP 状态、Webhook、重试间隔、签名', () => {
    expect(classifyHttp('wecom_robot', OK).result).toBe('sent');
    expect(classifyHttp('wecom_robot', BAD).result).toBe('failed');
    expect(classifyHttp('wecom_robot', LIMITED).result).toBe('rate_limited');
    expect(classifyHttp('wecom_robot', { status: 429, text: '' }).result).toBe('rate_limited');
    expect(classifyHttp('wecom_robot', { status: 502, text: 'bad gateway' })).toEqual({ result: 'failed', response: 'HTTP 502 bad gateway' });
    expect(classifyHttp('wecom_robot', { status: 200, text: 'not json' }).result).toBe('failed');
    expect(classifyHttp('webhook', { status: 204, text: '' }).result).toBe('sent');
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([30_000, 120_000, 600_000, 3_600_000, null]);
    expect(signWebhook('k', '1700000000', '{}')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('测试消息', () => {
  it('同步发送一次并返回结果；失败直接放弃；停用的通道不能发；只有组织管理员；邮件与 Webhook 签名', async () => {
    const ch = await wecomChannel(t.db, owner, '测试群', { url: url('test') });
    const view = await sendTestMessage(t.db, owner, ch.id, deps);
    expect(view).toMatchObject({ kind: 'test', status: 'sent', attempts: 1, channel: { id: ch.id, name: '测试群', kind: 'wecom_robot' }, source: { type: 'test', name: null, alert: false } });
    const [call] = callsTo(url('test'));
    expect((call!.body.text as { content: string }).content).toMatch(/^Flower 测试消息：通道「测试群」可以正常接收推送。\n发送时间：\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(JSON.stringify(view)).not.toContain('127.0.0.1');

    fake.reset(() => BAD);
    expect(await sendTestMessage(t.db, owner, ch.id, deps)).toMatchObject({ status: 'dead', attempts: 1 });
    await updateChannel(t.db, owner, ch.id, { enabled: false }, TEST_DEPS);
    await expect(sendTestMessage(t.db, owner, ch.id, deps)).rejects.toThrow('通道已停用，启用后才能发送测试消息');
    const member = await asMember(t.db, owner, '成员己');
    await expect(sendTestMessage(t.db, member, ch.id, deps)).rejects.toThrow('需要组织管理员权限');

    fake.reset(() => OK);
    const mail = await createChannel(
      t.db,
      owner,
      { kind: 'email', name: '测试邮件', config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
      TEST_DEPS,
    );
    expect((await sendTestMessage(t.db, owner, mail.id, deps)).status).toBe('sent');
    expect(fake.mails[0]).toMatchObject({ to: ['pm@example.com'], subject: 'Flower 测试消息：通道「测试邮件」可以正常接收推送。' });
    const hook = await createChannel(t.db, owner, { kind: 'webhook', name: '签名 Webhook', config: { url: 'http://127.0.0.1:9/hooks/flower', secret: 's3cret' } }, TEST_DEPS);
    await sendTestMessage(t.db, owner, hook.id, deps);
    const [signed] = callsTo('http://127.0.0.1:9/hooks/flower');
    expect(signed!.body).toMatchObject({ format: 'text' });
    expect(signed!.headers['x-flower-signature']).toBe(signWebhook('s3cret', signed!.headers['x-flower-timestamp']!, JSON.stringify(signed!.body)));
  });
});

describe('后台发送', () => {
  it('事件规则的记录在发送前渲染；失败后按 30 秒、2 分钟、10 分钟、1 小时重试，第 5 次失败放弃', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '重试群', { url: url('retry') });
    const rule = await createRule(t.db, owner, productId, { name: '重试规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    const req = await createRequirement(t.db, owner, productId, { title: '重试的需求' });
    const [d] = await ofRule(rule.id);
    fake.reset(() => BAD);
    let now = later();
    const waits = [30, 120, 600, 3600];
    for (let i = 0; i < 4; i++) {
      await process(now);
      const cur = await row(d!.id);
      expect(cur).toMatchObject({ status: 'failed', attempts: i + 1 });
      expect(cur.nextAttemptAt!.getTime() - now.getTime()).toBe(waits[i]! * 1000);
      await process(new Date(now.getTime() + 1000));
      expect((await row(d!.id)).attempts).toBe(i + 1);
      now = new Date(cur.nextAttemptAt!.getTime() + 1);
    }
    await process(now);
    expect(await row(d!.id)).toMatchObject({ status: 'dead', attempts: 5, nextAttemptAt: null });
    expect(callsTo(url('retry'))).toHaveLength(5);
    const body = callsTo(url('retry'))[0]!.body;
    expect((body.markdown as { content: string }).content).toContain(`[${req.displayKey} 重试的需求](http://flower.example.com/acme/requirements/${req.displayKey})`);
    expect((await row(d!.id)).payload).toEqual({ type: 'json', body });
  });

  it('企微限流应答：回到待发送，60 秒后再试，不计次数', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '限流应答群', { url: url('limited') });
    const rule = await createRule(t.db, owner, productId, { name: '限流规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    await createRequirement(t.db, owner, productId, { title: '会被限流' });
    fake.reset(() => LIMITED);
    const now = later();
    await process(now);
    const [d] = await ofRule(rule.id);
    expect(d).toMatchObject({ status: 'pending', attempts: 0 });
    expect(d!.nextAttemptAt!.getTime() - now.getTime()).toBe(60_000);
    expect(d!.response).toContain('45009');
  });

  it('每分钟上限：超出的留到下一轮', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '上限群', { url: url('window'), rateLimitPerMin: 2 });
    const rule = await createRule(t.db, owner, productId, { name: '上限规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    for (const title of ['一', '二', '三']) await createRequirement(t.db, owner, productId, { title });
    const now = later();
    await process(now);
    expect(callsTo(url('window'))).toHaveLength(2);
    expect((await ofRule(rule.id)).map((d) => d.status).sort()).toEqual(['pending', 'sent', 'sent']);
    await process(new Date(now.getTime() + 61_000));
    expect(callsTo(url('window'))).toHaveLength(3);
  });

  it('两个实例同时处理：每条只发一次（FOR UPDATE SKIP LOCKED 与通道锁）', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '并发群', { url: url('race'), rateLimitPerMin: 100 });
    const rule = await createRule(t.db, owner, productId, { name: '并发规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    for (let i = 0; i < 6; i++) await createRequirement(t.db, owner, productId, { title: `并发 ${i}` });
    const now = later();
    await Promise.all([process(now), process(now)]);
    await process(now);
    expect(callsTo(url('race'))).toHaveLength(6);
    expect((await ofRule(rule.id)).every((d) => d.status === 'sent' && d.attempts === 1)).toBe(true);
  });

  it('定时推送：同一次执行全部放弃时连续失败加一并告警；下一次成功清零并记 last_success_at', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '日报群', { url: url('schedule') });
    const s = await createSchedule(t.db, owner, { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [ch.id] });
    const run = await runScheduleNow(t.db, owner, s.id, deps);
    await t.adminDb.update(notificationDeliveries).set({ attempts: 4 }).where(eq(notificationDeliveries.runId, run.runId!));
    fake.reset(() => BAD);
    await process(later());
    const failed = (await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, s.id)))[0]!;
    expect(failed).toMatchObject({ consecutiveFailures: 1, alertState: 'alert', lastSuccessAt: null });
    expect((await listDeliveries(t.db, owner, { kind: 'schedule' })).deliveries.find((d) => d.source.id === s.id)!.source).toMatchObject({ name: '日报', alert: true });

    fake.reset(() => OK);
    const run2 = await runScheduleNow(t.db, owner, s.id, deps);
    await process(later(2000));
    const [d2] = await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.runId, run2.runId!));
    const ok = (await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, s.id)))[0]!;
    expect(ok).toMatchObject({ consecutiveFailures: 0, alertState: 'normal' });
    expect(ok.lastSuccessAt!.getTime()).toBe(d2!.createdAt.getTime());
  });

  it('变更摘要：发送成功后条目标记已消费；全部放弃时释放给下一次', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '摘要群', { url: url('digest') });
    const s = await createSchedule(t.db, owner, { productId, name: '摘要', cron: '0 18 * * *', source: 'digest', channelIds: [ch.id] });
    await createRule(t.db, owner, productId, { name: '并入摘要', eventTypes: ['requirement.state_changed'], mode: 'digest', digestScheduleId: s.id });
    const r = await createRequirement(t.db, owner, productId, { title: '摘要需求' });
    await transitionRequirement(t.db, owner, r.id, { to: 'doing' });
    const run = await runScheduleNow(t.db, owner, s.id, deps);
    await process(later());
    const items = () => t.adminDb.select().from(notificationDigestItems).where(eq(notificationDigestItems.scheduleId, s.id));
    expect((await items()).every((i) => i.consumedAt !== null && i.runId === run.runId)).toBe(true);

    await transitionRequirement(t.db, owner, r.id, { to: 'done' });
    const run2 = await runScheduleNow(t.db, owner, s.id, deps);
    await t.adminDb.update(notificationDeliveries).set({ attempts: 4 }).where(eq(notificationDeliveries.runId, run2.runId!));
    fake.reset(() => BAD);
    await process(later(2000));
    const open = (await items()).filter((i) => i.consumedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.runId).toBeNull();
  });

  it('租约到期仍在发送中的按一次失败处理；停用通道的记录直接放弃', async () => {
    const ch = await wecomChannel(t.db, owner, '中断群', { url: url('lease') });
    const [stuck] = await t.adminDb
      .insert(notificationDeliveries)
      .values({ orgId: owner.orgId, kind: 'test', channelId: ch.id, payload: { type: 'json', body: { msgtype: 'text', text: { content: '中断' } } }, status: 'sending', nextAttemptAt: new Date(Date.now() - 1000) })
      .returning();
    await process(new Date());
    expect(await row(stuck!.id)).toMatchObject({ status: 'dead', attempts: 1, response: '发送中断（进程退出或超时），按失败处理' });

    const productId = await newProduct();
    const off = await wecomChannel(t.db, owner, '将停用群', { url: url('disabled') });
    const rule = await createRule(t.db, owner, productId, { name: '停用规则', eventTypes: ['requirement.created'], channelIds: [off.id] });
    await createRequirement(t.db, owner, productId, { title: '发不出去' });
    await updateChannel(t.db, owner, off.id, { enabled: false }, TEST_DEPS);
    await process(later());
    expect((await ofRule(rule.id))[0]).toMatchObject({ status: 'dead', response: '通道已停用，未发送' });
    expect(callsTo(url('disabled'))).toHaveLength(0);
  });
});

describe('重发与发送记录列表', () => {
  it('重发复制为新的待发记录；迁移记录、未结束的记录不能重发；只有组织管理员', async () => {
    const ch = await wecomChannel(t.db, owner, '重发群', { url: url('resend') });
    const sent = await sendTestMessage(t.db, owner, ch.id, deps);
    const again = await resendDelivery(t.db, owner, sent.id);
    expect(again).toMatchObject({ kind: 'test', status: 'pending', attempts: 0 });
    expect((await row(again.id)).payload).toEqual((await row(sent.id)).payload);
    await expect(resendDelivery(t.db, owner, again.id)).rejects.toThrow('只能重发已发送或已放弃的记录');
    const [legacy] = await t.adminDb
      .insert(notificationDeliveries)
      .values({ orgId: owner.orgId, kind: 'test', channelId: ch.id, payload: { type: 'legacy', content: '旧日志' }, status: 'sent', attempts: 1, legacyKey: 'push_logs:1' })
      .returning();
    await expect(resendDelivery(t.db, owner, legacy!.id)).rejects.toThrow('迁移来的历史记录不能重发');
    const member = await asMember(t.db, owner, '成员庚');
    await expect(resendDelivery(t.db, member, sent.id)).rejects.toThrow('需要组织管理员权限');
  });

  it('按来源、状态、通道筛选，按时间倒序分页；不含通道配置', async () => {
    const page1 = await listDeliveries(t.db, owner, { kind: 'test', limit: 2 });
    expect(page1.deliveries).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listDeliveries(t.db, owner, { kind: 'test', limit: 2, before: page1.nextCursor! });
    expect(page2.deliveries.some((d) => page1.deliveries.some((x) => x.id === d.id))).toBe(false);
    expect(page1.deliveries[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(page2.deliveries[0]!.createdAt.getTime());
    expect((await listDeliveries(t.db, owner, { status: 'dead' })).deliveries.every((d) => d.status === 'dead')).toBe(true);
    const all = await listDeliveries(t.db, owner, { limit: 100 });
    const legacy = all.deliveries.find((d) => d.legacy)!;
    expect(legacy).toMatchObject({ preview: '旧日志', canResend: false });
    expect(JSON.stringify(all)).not.toContain('127.0.0.1');
    const ch = all.deliveries[0]!.channel.id;
    expect((await listDeliveries(t.db, owner, { channelId: ch })).deliveries.every((d) => d.channel.id === ch)).toBe(true);
  });
});
```


- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/notify-deliveries.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/deliveries'`）。

- [ ] **Step 4: 实现发送器**

新建 `packages/core/src/notifications/sender.ts`：

```ts
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { ChannelConfig, EmailConfig, WebhookConfig, WecomConfig } from './channel-config';
import { type ChannelKind, type ChannelPayload, MAX_ATTEMPTS, RESPONSE_MAX_CHARS, RETRY_DELAYS_SECONDS } from './constants';

export type HttpResult = { status: number; text: string };
export type Transport = {
  postJson(url: string, body: string, headers: Record<string, string>): Promise<HttpResult>;
  sendMail(config: EmailConfig, message: { subject: string; text: string }): Promise<string>;
};
/** 后台发送与测试消息需要的依赖：实例密钥（解密配置）、对外网址（消息里的链接）、发送器。 */
export type NotifyDeps = { secretKey: string; publicUrl: string; transport: Transport };

export const defaultTransport: Transport = {
  async postJson(url, body, headers) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, text: await res.text() };
  },
  async sendMail(cfg, msg) {
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    const info = await transporter.sendMail({ from: cfg.from, to: cfg.to, subject: msg.subject, text: msg.text });
    return `SMTP 已接受 ${info.accepted.length} 个收件人`;
  },
};

export type SendOutcome = { result: 'sent' | 'failed' | 'rate_limited'; response: string };

/** 企微机器人「接口调用超过限制」。 */
const WECOM_RATE_LIMITED = 45009;

export function classifyHttp(kind: 'wecom_robot' | 'webhook', res: HttpResult): SendOutcome {
  const response = `HTTP ${res.status} ${res.text}`.trim().slice(0, RESPONSE_MAX_CHARS);
  if (res.status === 429) return { result: 'rate_limited', response };
  if (res.status < 200 || res.status >= 300) return { result: 'failed', response };
  if (kind === 'webhook') return { result: 'sent', response };
  let errcode: unknown;
  try {
    errcode = (JSON.parse(res.text) as { errcode?: unknown }).errcode;
  } catch {
    return { result: 'failed', response };
  }
  if (errcode === 0) return { result: 'sent', response };
  if (errcode === WECOM_RATE_LIMITED) return { result: 'rate_limited', response };
  return { result: 'failed', response };
}

/** Webhook 签名：sha256={HMAC-SHA256(secret, "{timestamp}.{body}") 的十六进制}。 */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const errorText = (e: unknown): string => {
  const cause = e instanceof Error ? (e.cause as { code?: string } | undefined)?.code : undefined;
  return [e instanceof Error ? e.message : String(e), cause].filter(Boolean).join('：').slice(0, RESPONSE_MAX_CHARS);
};

export async function sendPayload(kind: ChannelKind, config: ChannelConfig, payload: ChannelPayload, transport: Transport, now: Date): Promise<SendOutcome> {
  try {
    if (kind === 'email') {
      if (payload.type !== 'email') return { result: 'failed', response: '请求体与通道类型不符' };
      return { result: 'sent', response: (await transport.sendMail(config as EmailConfig, { subject: payload.subject, text: payload.text })).slice(0, RESPONSE_MAX_CHARS) };
    }
    if (payload.type !== 'json') return { result: 'failed', response: '请求体与通道类型不符' };
    const body = JSON.stringify(payload.body);
    const headers: Record<string, string> = {};
    const secret = kind === 'webhook' ? (config as WebhookConfig).secret : undefined;
    if (secret) {
      const timestamp = String(Math.floor(now.getTime() / 1000));
      headers['x-flower-timestamp'] = timestamp;
      headers['x-flower-signature'] = signWebhook(secret, timestamp, body);
    }
    return classifyHttp(kind, await transport.postJson((config as WecomConfig).url, body, headers));
  } catch (e) {
    return { result: 'failed', response: errorText(e) };
  }
}

/** 第 attempts 次失败之后等待的毫秒数；达到上限返回 null（放弃）。 */
export function retryDelayMs(attempts: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_SECONDS[Math.max(0, attempts - 1)]! * 1000;
}
```

- [ ] **Step 5: 实现发送记录的处理、测试消息、重发与列表**

新建 `packages/core/src/notifications/deliveries.ts`：

```ts
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, notificationDeliveries, notificationDigestItems, notificationRules, notificationSchedules } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import type { ChannelConfig } from './channel-config';
import { type ChannelRow, readChannelConfig } from './channels';
import { type ChannelKind, type ChannelPayload, type DeliveryKind, type DeliveryStatus, RESPONSE_MAX_CHARS } from './constants';
import { resolveTemplateTx } from './message-templates';
import { type NotifyDeps, retryDelayMs, type SendOutcome, sendPayload } from './sender';
import { eventMessageDataTx, formatMinute, orgContextTx } from './sources';
import { payloadPreview, renderMessage, toChannelPayloads } from './template';

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;
export type DeliveryView = {
  id: string;
  kind: DeliveryKind;
  source: { type: DeliveryKind; id: string | null; name: string | null; alert: boolean };
  channel: { id: string; name: string; kind: ChannelKind };
  eventId: string | null;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  response: string | null;
  sentAt: Date | null;
  createdAt: Date;
  preview: string;
  legacy: boolean;
  canResend: boolean;
};
export type DeliveryQuery = { channelId?: string; kind?: DeliveryKind; status?: DeliveryStatus; from?: Date; to?: Date; before?: string; limit?: number };
export type ProcessSummary = { sent: number; failed: number; dead: number; rateLimited: number };

const BATCH = 50;
/** 发送中的租约：超过这个时间仍是 sending，视为进程中断。 */
const LEASE_MS = 120_000;
const RATE_LIMIT_WAIT_MS = 60_000;
const NOT_FOUND = '发送记录不存在';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, RESPONSE_MAX_CHARS);

async function tryChannelLockTx(tx: Tx, channelId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`flower:notify-channel:${channelId}`}, 0)) as locked`)) as unknown as [{ locked: boolean }];
  return row!.locked;
}

/**
 * 定时推送一次执行的结果：任一条成功 → 清零、解除告警、记 last_success_at（执行时间）、摘要条目已消费；
 * 同一次的记录全部放弃 → 连续失败加一、达到阈值告警、摘要条目释放。
 */
async function settleRunTx(tx: Tx, d: DeliveryRow, now: Date, outcome: 'sent' | 'dead'): Promise<void> {
  if (!d.runId || !d.scheduleId) return;
  if (outcome === 'sent') {
    await tx
      .update(notificationSchedules)
      .set({
        consecutiveFailures: 0,
        alertState: 'normal',
        lastSuccessAt: sql`greatest(coalesce(${notificationSchedules.lastSuccessAt}, ${d.createdAt}), ${d.createdAt})`,
        updatedAt: now,
      })
      .where(eq(notificationSchedules.id, d.scheduleId));
    await tx.update(notificationDigestItems).set({ consumedAt: now }).where(and(eq(notificationDigestItems.runId, d.runId), isNull(notificationDigestItems.consumedAt)));
    return;
  }
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.runId, d.runId), sql`${notificationDeliveries.status} <> 'dead'`));
  if (open!.n > 0) return;
  const [s] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, d.scheduleId)).for('update');
  if (!s) return;
  const failures = s.consecutiveFailures + 1;
  await tx
    .update(notificationSchedules)
    .set({ consecutiveFailures: failures, alertState: failures >= s.failThreshold ? 'alert' : s.alertState, updatedAt: now })
    .where(eq(notificationSchedules.id, s.id));
  await tx.update(notificationDigestItems).set({ runId: null }).where(and(eq(notificationDigestItems.runId, d.runId), isNull(notificationDigestItems.consumedAt)));
}

async function markDeadTx(tx: Tx, d: DeliveryRow, response: string, now: Date): Promise<void> {
  await tx.update(notificationDeliveries).set({ status: 'dead', nextAttemptAt: null, response }).where(eq(notificationDeliveries.id, d.id));
  await settleRunTx(tx, d, now, 'dead');
}

/** 写入一次发送的结果；只处理仍是 sending 的记录（已被租约回收的跳过）。 */
async function finalizeTx(tx: Tx, d: DeliveryRow, outcome: SendOutcome, now: Date): Promise<'sent' | 'failed' | 'dead' | 'rate_limited' | 'skipped'> {
  const sending = and(eq(notificationDeliveries.id, d.id), eq(notificationDeliveries.status, 'sending'));
  const response = outcome.response.slice(0, RESPONSE_MAX_CHARS);
  const apply = async (set: Partial<typeof notificationDeliveries.$inferInsert>) =>
    (await tx.update(notificationDeliveries).set({ ...set, response }).where(sending).returning({ id: notificationDeliveries.id })).length > 0;
  if (outcome.result === 'sent') {
    if (!(await apply({ status: 'sent', attempts: d.attempts + 1, sentAt: now, nextAttemptAt: null }))) return 'skipped';
    await settleRunTx(tx, d, now, 'sent');
    return 'sent';
  }
  if (outcome.result === 'rate_limited') {
    return (await apply({ status: 'pending', nextAttemptAt: new Date(now.getTime() + RATE_LIMIT_WAIT_MS) })) ? 'rate_limited' : 'skipped';
  }
  const attempts = d.attempts + 1;
  const delay = d.kind === 'test' ? null : retryDelayMs(attempts);
  if (delay === null) {
    if (!(await apply({ status: 'dead', attempts, nextAttemptAt: null }))) return 'skipped';
    await settleRunTx(tx, d, now, 'dead');
    return 'dead';
  }
  return (await apply({ status: 'failed', attempts, nextAttemptAt: new Date(now.getTime() + delay) })) ? 'failed' : 'skipped';
}

/** 事件规则的记录：用规则的模板（或预置「事件推送」）渲染，取第一条请求体。 */
async function renderRuleDeliveryTx(tx: Tx, d: DeliveryRow, channel: ChannelRow, deps: { publicUrl: string }): Promise<ChannelPayload> {
  if (!d.eventId) throw new AppError('invalid', '记录缺少事件');
  const [rule] = d.ruleId ? await tx.select({ templateId: notificationRules.templateId }).from(notificationRules).where(eq(notificationRules.id, d.ruleId)) : [];
  const tpl = await resolveTemplateTx(tx, rule?.templateId ?? null, 'event');
  const data = await eventMessageDataTx(tx, d.eventId, await orgContextTx(tx, d.orgId, deps.publicUrl));
  return toChannelPayloads(channel.kind, renderMessage(tpl.format, tpl.body, data))[0]!;
}

/**
 * 处理一个组织到期的发送记录：回收租约到期的发送中记录；取到期的待发与待重试记录（SKIP LOCKED），
 * 按通道加锁、按每分钟上限取余量、改为发送中后提交；在事务外逐条发送，每条结果在新事务里写入。
 */
export async function processDueDeliveries(db: Db, orgId: string, deps: NotifyDeps, now: Date, opts: { onlyIds?: string[] } = {}): Promise<ProcessSummary> {
  const summary: ProcessSummary = { sent: 0, failed: 0, dead: 0, rateLimited: 0 };
  const tally = (r: Awaited<ReturnType<typeof finalizeTx>>) => {
    if (r === 'sent') summary.sent++;
    else if (r === 'failed') summary.failed++;
    else if (r === 'dead') summary.dead++;
    else if (r === 'rate_limited') summary.rateLimited++;
  };
  const claimed = await withOrg(db, orgId, async (tx) => {
    const expired = await tx
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.status, 'sending'), lte(notificationDeliveries.nextAttemptAt, now)))
      .for('update', { skipLocked: true });
    for (const d of expired) tally(await finalizeTx(tx, d, { result: 'failed', response: '发送中断（进程退出或超时），按失败处理' }, now));
    const due = await tx
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          inArray(notificationDeliveries.status, ['pending', 'failed']),
          lte(notificationDeliveries.nextAttemptAt, now),
          opts.onlyIds ? inArray(notificationDeliveries.id, opts.onlyIds) : undefined,
        ),
      )
      .orderBy(asc(notificationDeliveries.nextAttemptAt), asc(notificationDeliveries.createdAt))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    const byChannel = new Map<string, DeliveryRow[]>();
    for (const d of due) byChannel.set(d.channelId, [...(byChannel.get(d.channelId) ?? []), d]);
    const out: Array<{ d: DeliveryRow; channel: ChannelRow }> = [];
    for (const [channelId, list] of byChannel) {
      const [channel] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
      if (!channel || !channel.enabled) {
        for (const d of list) {
          await markDeadTx(tx, d, '通道已停用，未发送', now);
          summary.dead++;
        }
        continue;
      }
      if (!(await tryChannelLockTx(tx, channelId))) continue;
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.channelId, channelId),
            or(and(eq(notificationDeliveries.status, 'sent'), gt(notificationDeliveries.sentAt, new Date(now.getTime() - 60_000))), eq(notificationDeliveries.status, 'sending')),
          ),
        );
      for (const d of list.slice(0, Math.max(0, channel.rateLimitPerMin - used!.n))) {
        let payload = d.payload;
        if (!payload) {
          try {
            payload = await renderRuleDeliveryTx(tx, d, channel, deps);
          } catch (e) {
            await markDeadTx(tx, d, `渲染失败：${errorText(e)}`, now);
            summary.dead++;
            continue;
          }
        }
        await tx.update(notificationDeliveries).set({ status: 'sending', payload, nextAttemptAt: new Date(now.getTime() + LEASE_MS) }).where(eq(notificationDeliveries.id, d.id));
        out.push({ d: { ...d, status: 'sending', payload }, channel });
      }
    }
    return out;
  });
  const configs = new Map<string, ChannelConfig>();
  for (const { d, channel } of claimed) {
    let outcome: SendOutcome;
    if (d.payload!.type === 'legacy') outcome = { result: 'failed', response: '迁移来的历史记录不能发送' };
    else {
      try {
        const config = configs.get(channel.id) ?? readChannelConfig(channel, deps.secretKey);
        configs.set(channel.id, config);
        outcome = await sendPayload(channel.kind, config, d.payload as ChannelPayload, deps.transport, now);
      } catch (e) {
        outcome = { result: 'failed', response: errorText(e) };
      }
    }
    tally(await withOrg(db, orgId, (tx) => finalizeTx(tx, d, outcome, now)));
  }
  return summary;
}

async function viewsTx(tx: Tx, rows: DeliveryRow[]): Promise<DeliveryView[]> {
  if (rows.length === 0) return [];
  const channelIds = [...new Set(rows.map((r) => r.channelId))];
  const chans = await tx.select().from(notificationChannels).where(inArray(notificationChannels.id, channelIds));
  const ruleIds = [...new Set(rows.map((r) => r.ruleId).filter((x): x is string => !!x))];
  const rules = ruleIds.length ? await tx.select({ id: notificationRules.id, name: notificationRules.name }).from(notificationRules).where(inArray(notificationRules.id, ruleIds)) : [];
  const scheduleIds = [...new Set(rows.map((r) => r.scheduleId).filter((x): x is string => !!x))];
  const schedules = scheduleIds.length
    ? await tx
        .select({ id: notificationSchedules.id, name: notificationSchedules.name, alertState: notificationSchedules.alertState })
        .from(notificationSchedules)
        .where(inArray(notificationSchedules.id, scheduleIds))
    : [];
  return rows.map((r) => {
    const ch = chans.find((c) => c.id === r.channelId)!;
    const schedule = schedules.find((s) => s.id === r.scheduleId);
    const legacy = r.payload?.type === 'legacy';
    return {
      id: r.id,
      kind: r.kind,
      source: {
        type: r.kind,
        id: r.ruleId ?? r.scheduleId,
        name: r.kind === 'rule' ? (rules.find((x) => x.id === r.ruleId)?.name ?? null) : r.kind === 'schedule' ? (schedule?.name ?? null) : null,
        alert: schedule?.alertState === 'alert',
      },
      channel: { id: ch.id, name: ch.name, kind: ch.kind },
      eventId: r.eventId,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      response: r.response,
      sentAt: r.sentAt,
      createdAt: r.createdAt,
      preview: payloadPreview(r.payload),
      legacy,
      canResend: !legacy && (r.status === 'sent' || r.status === 'dead') && ch.enabled,
    };
  });
}

async function viewOf(db: Db, orgId: string, id: string): Promise<DeliveryView> {
  return withOrg(db, orgId, async (tx) => {
    const [row] = await tx.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id));
    if (!row) throw new AppError('not_found', NOT_FOUND);
    return (await viewsTx(tx, [row]))[0]!;
  });
}

/** 发一条固定内容的测试消息：只对启用的通道；在请求内同步发送一次，失败不重试。 */
export async function sendTestMessage(db: Db, actor: Actor, channelId: string, deps: NotifyDeps): Promise<DeliveryView> {
  requireOrgAdmin(actor);
  const now = new Date();
  const id = await withOrg(db, actor.orgId, async (tx) => {
    const [ch] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    if (!ch) throw new AppError('not_found', '通道不存在');
    if (!ch.enabled) throw new AppError('invalid', '通道已停用，启用后才能发送测试消息');
    const ctx = await orgContextTx(tx, actor.orgId, deps.publicUrl);
    const [payload] = toChannelPayloads(ch.kind, { format: 'text', text: `Flower 测试消息：通道「${ch.name}」可以正常接收推送。\n发送时间：${formatMinute(now, ctx.timeZone)}` });
    const [row] = await tx
      .insert(notificationDeliveries)
      .values({ orgId: actor.orgId, kind: 'test', channelId, payload: payload!, status: 'pending', nextAttemptAt: now })
      .returning({ id: notificationDeliveries.id });
    await recordEvent(tx, { orgId: actor.orgId, type: 'notification_channel.tested', subjectType: 'notification_channel', subjectId: channelId, actor, payload: { deliveryId: row!.id } });
    return row!.id;
  });
  await processDueDeliveries(db, actor.orgId, deps, now, { onlyIds: [id] });
  return viewOf(db, actor.orgId, id);
}

/** 重发：复制为新的待发记录（不带 run_id，不影响定时推送的告警计数）。 */
export async function resendDelivery(db: Db, actor: Actor, id: string): Promise<DeliveryView> {
  requireOrgAdmin(actor);
  const newId = await withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id));
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    if (cur.payload?.type === 'legacy') throw new AppError('invalid', '迁移来的历史记录不能重发');
    if (cur.status !== 'sent' && cur.status !== 'dead') throw new AppError('invalid', '只能重发已发送或已放弃的记录');
    const [ch] = await tx.select({ enabled: notificationChannels.enabled }).from(notificationChannels).where(eq(notificationChannels.id, cur.channelId));
    if (!ch?.enabled) throw new AppError('invalid', '通道已停用，启用后才能重发');
    const [row] = await tx
      .insert(notificationDeliveries)
      .values({
        orgId: actor.orgId,
        kind: cur.kind,
        ruleId: cur.ruleId,
        scheduleId: cur.scheduleId,
        channelId: cur.channelId,
        eventId: cur.eventId,
        payload: cur.payload,
        status: 'pending',
        nextAttemptAt: new Date(),
      })
      .returning({ id: notificationDeliveries.id });
    await recordEvent(tx, { orgId: actor.orgId, type: 'notification_delivery.resent', subjectType: 'notification_delivery', subjectId: row!.id, actor, payload: { from: id } });
    return row!.id;
  });
  return viewOf(db, actor.orgId, newId);
}

/** 发送记录：按创建时间倒序；游标为上一页最后一条的 `{createdAt ISO}|{id}`。 */
export async function listDeliveries(db: Db, actor: Actor, q: DeliveryQuery): Promise<{ deliveries: DeliveryView[]; nextCursor: string | null }> {
  requireOrgAdmin(actor);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  let cursor: { at: Date; id: string } | null = null;
  if (q.before) {
    const [at, cid] = q.before.split('|');
    const date = new Date(at ?? '');
    if (!cid || Number.isNaN(date.getTime())) throw new AppError('invalid', '分页参数无效');
    cursor = { at: date, id: cid };
  }
  return withOrg(db, actor.orgId, async (tx) => {
    const D = notificationDeliveries;
    const rows = await tx
      .select()
      .from(D)
      .where(
        and(
          q.channelId ? eq(D.channelId, q.channelId) : undefined,
          q.kind ? eq(D.kind, q.kind) : undefined,
          q.status ? eq(D.status, q.status) : undefined,
          q.from ? gte(D.createdAt, q.from) : undefined,
          q.to ? lt(D.createdAt, q.to) : undefined,
          cursor ? or(lt(D.createdAt, cursor.at), and(eq(D.createdAt, cursor.at), lt(D.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(D.createdAt), desc(D.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { deliveries: await viewsTx(tx, page), nextCursor: rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null };
  });
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/sender';
export * from './notifications/deliveries';
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/notify-deliveries.test.ts && pnpm typecheck`
Expected: PASS。「两个实例同时处理」如果偶发重复发送，停下来报告（不要加重试或放宽断言）。

- [ ] **Step 7: 提交**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/notifications/sender.ts packages/core/src/notifications/deliveries.ts packages/core/src/index.ts packages/core/test/notify-transport.ts packages/core/test/notify-deliveries.test.ts apps/web/next.config.ts
git commit -m "feat(core): 推送发送（SKIP LOCKED 取任务、按通道限流、退避重试、执行结果与告警）、测试消息、重发与发送记录

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: 后台循环（每 5 秒一轮）、应用启动时启动、手动驱动的 tick 接口

**Files:**
- Create: `packages/core/src/notifications/worker.ts`
- Modify: `packages/core/src/index.ts`
- Create: `apps/web/src/server/worker.ts`
- Modify: `apps/web/src/instrumentation.ts`、`apps/web/src/server/api.ts`、`apps/web/src/server/runtime.ts`、`apps/web/src/server/routes/instance.ts`、`apps/web/test/api/helpers.ts`、`.env.example`
- Test: `packages/core/test/notify-worker.test.ts`、`apps/web/test/server/worker.test.ts`、`apps/web/test/api/notify-tick.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `nextRunAt`；Task 9 的 `generateScheduleRunTx`、`tryScheduleLockTx`；Task 10 的 `processDueDeliveries`、`NotifyDeps`、`defaultTransport`、`Transport`
- Produces:
  - `type TickSummary = { orgs: number; schedulesRun: number; sent: number; failed: number; dead: number; rateLimited: number }`
  - `runNotificationTick(db, deps: NotifyDeps, now?: Date): Promise<TickSummary>`
  - `type NotificationWorker = { start(): void; stop(): Promise<void> }`、`createNotificationWorker(db, deps, opts?: { intervalMs?: number; onError?: (e: unknown) => void }): NotificationWorker`
  - web：`startNotificationWorker(env?: Record<string, string | undefined>): boolean`（`FLOWER_NOTIFY_WORKER=off` 时返回 false、不连数据库）
  - `ApiDeps` 增加 `notify: NotifyDeps` 与 `tickApi: boolean`；`POST /api/v1/instance/notifications/tick`（body `{ now?: string }`，返回 `{ summary: TickSummary }`）
  - 测试辅助 `makeApp(opts?: { transport?: Transport; tickApi?: boolean })`

- [ ] **Step 1: 写失败的测试（core）**

新建 `packages/core/test/notify-worker.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messageTemplates, notificationDeliveries, notificationSchedules } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createMessageTemplate } from '../src/notifications/message-templates';
import { createRule } from '../src/notifications/rules';
import { createSchedule } from '../src/notifications/schedules';
import { createNotificationWorker, runNotificationTick } from '../src/notifications/worker';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
let channelId: string;
const fake = fakeTransport();
const deps = { ...TEST_DEPS, transport: fake.transport };
const URL_ = 'http://127.0.0.1:9/cgi-bin/webhook/send?key=worker-0001';
const schedule = async (id: string) => (await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)))[0]!;
const deliveriesOf = (id: string) => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.scheduleId, id));
let seq = 0;
const overview = async (extra: Record<string, unknown> = {}) =>
  createSchedule(t.db, owner, { productId, name: `日报 ${++seq}`, cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId], ...extra });

async function until(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待超时');
}

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  channelId = (await wecomChannel(t.db, owner, '研发群', { url: URL_, rateLimitPerMin: 100 })).id;
});
afterAll(() => t.cleanup());
beforeEach(() => fake.reset(() => ({ status: 200, text: '{"errcode":0,"errmsg":"ok"}' })));

describe('一轮处理', () => {
  it('没有排期的启用定时推送只排期、不补跑', async () => {
    const s = await overview();
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: null }).where(eq(notificationSchedules.id, s.id));
    const now = new Date('2026-10-12T12:00:00Z');
    await runNotificationTick(t.db, deps, now);
    expect((await schedule(s.id)).nextRunAt!.toISOString()).toBe('2026-10-13T11:00:00.000Z');
    expect(await deliveriesOf(s.id)).toHaveLength(0);
    // 停用，免得后面的用例按真实时间运行时把它当成到点
    await t.adminDb.update(notificationSchedules).set({ enabled: false }).where(eq(notificationSchedules.id, s.id));
  });

  it('到点的执行一次并发送，按本次时间算下一次；未到点与停用的不执行', async () => {
    const due = await overview();
    const notDue = await overview();
    const off = await overview({ enabled: false });
    const now = new Date();
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: new Date(now.getTime() - 1000) }).where(eq(notificationSchedules.id, due.id));
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: new Date(now.getTime() + 3_600_000) }).where(eq(notificationSchedules.id, notDue.id));
    const summary = await runNotificationTick(t.db, deps, now);
    expect(summary).toMatchObject({ schedulesRun: 1, sent: 1 });
    expect((await deliveriesOf(due.id)).map((d) => d.status)).toEqual(['sent']);
    const after = await schedule(due.id);
    expect(after.lastRunAt!.getTime()).toBe(now.getTime());
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await deliveriesOf(notDue.id)).toHaveLength(0);
    expect(await deliveriesOf(off.id)).toHaveLength(0);
  });

  it('两个实例同时到点：同一定时推送只执行一次', async () => {
    const s = await overview();
    const now = new Date();
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: new Date(now.getTime() - 1000) }).where(eq(notificationSchedules.id, s.id));
    await Promise.all([runNotificationTick(t.db, deps, now), runNotificationTick(t.db, deps, now)]);
    expect(await deliveriesOf(s.id)).toHaveLength(1);
  });

  it('生成出错：不写记录，记 last_error、连续失败加一并告警，推进下一次', async () => {
    const tpl = await createMessageTemplate(t.db, owner, { name: '会坏的模板', format: 'markdown', body: '{{title}}' });
    const s = await overview({ templateId: tpl.id });
    await t.adminDb.update(messageTemplates).set({ body: '{{#title}}' }).where(eq(messageTemplates.id, tpl.id));
    const now = new Date();
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: new Date(now.getTime() - 1000) }).where(eq(notificationSchedules.id, s.id));
    await runNotificationTick(t.db, deps, now);
    const after = await schedule(s.id);
    expect(after).toMatchObject({ consecutiveFailures: 1, alertState: 'alert' });
    expect(after.lastError).toMatch(/^生成内容失败：模板语法错误/);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await deliveriesOf(s.id)).toHaveLength(0);
  });
});

describe('循环', () => {
  it('启动后按间隔处理；stop 之后不再取新任务', async () => {
    const rule = await createRule(t.db, owner, productId, { name: '循环规则', eventTypes: ['requirement.created'], channelIds: [channelId] });
    const worker = createNotificationWorker(t.db, deps, { intervalMs: 20 });
    worker.start();
    await createRequirement(t.db, owner, productId, { title: '循环发送' });
    await until(async () => fake.calls.length === 1);
    await worker.stop();
    await createRequirement(t.db, owner, productId, { title: '停了以后' });
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.calls).toHaveLength(1);
    const rows = await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, rule.id));
    expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'sent']);
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/notify-worker.test.ts`
Expected: FAIL（`Cannot find module '../src/notifications/worker'`）。

- [ ] **Step 2: 实现一轮处理与循环**

新建 `packages/core/src/notifications/worker.ts`：

```ts
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { notificationDeliveries, notificationSchedules } from '../db/schema';
import { withOrg, withSystem } from '../db/tx';
import { nextRunAt } from './cron';
import { type ProcessSummary, processDueDeliveries } from './deliveries';
import { generateScheduleRunTx, tryScheduleLockTx } from './run';
import type { NotifyDeps } from './sender';

export type TickSummary = ProcessSummary & { orgs: number; schedulesRun: number };
export type NotificationWorker = { start(): void; stop(): Promise<void> };

const S = notificationSchedules;
const D = notificationDeliveries;
const dueSchedule = (now: Date) => and(eq(S.enabled, true), or(isNull(S.nextRunAt), lte(S.nextRunAt, now)));

/** 后台循环唯一的跨组织查询：有到期（或租约到期）的发送记录、或有需要排期或到点的定时推送的组织。 */
async function dueOrgIds(db: Db, now: Date): Promise<string[]> {
  return withSystem(db, async (tx) => {
    const a = await tx.selectDistinct({ orgId: D.orgId }).from(D).where(and(inArray(D.status, ['pending', 'failed', 'sending']), lte(D.nextAttemptAt, now)));
    const b = await tx.selectDistinct({ orgId: S.orgId }).from(S).where(dueSchedule(now));
    return [...new Set([...a, ...b].map((r) => r.orgId))];
  });
}

async function recordGenerationFailure(db: Db, orgId: string, id: string, error: unknown, now: Date): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    const [s] = await tx.select().from(S).where(eq(S.id, id)).for('update');
    if (!s) return;
    const failures = s.consecutiveFailures + 1;
    await tx
      .update(S)
      .set({
        lastRunAt: now,
        lastError: `生成内容失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
        consecutiveFailures: failures,
        alertState: failures >= s.failThreshold ? 'alert' : s.alertState,
        nextRunAt: nextRunAt(s.cron, s.timezone, now),
        updatedAt: now,
      })
      .where(eq(S.id, id));
  });
}

async function runDueSchedules(db: Db, orgId: string, deps: NotifyDeps, now: Date): Promise<number> {
  const due = await withOrg(db, orgId, (tx) => tx.select({ id: S.id }).from(S).where(dueSchedule(now)));
  let ran = 0;
  for (const { id } of due) {
    try {
      const did = await withOrg(db, orgId, async (tx) => {
        if (!(await tryScheduleLockTx(tx, id))) return false;
        // 拿到锁后重新读取：另一个实例可能刚执行完并推进了 next_run_at
        const [s] = await tx.select().from(S).where(eq(S.id, id));
        if (!s || !s.enabled) return false;
        const next = nextRunAt(s.cron, s.timezone, now);
        if (s.nextRunAt === null) {
          // 没有排期（迁移导入的定时推送）：只排期，不补跑
          await tx.update(S).set({ nextRunAt: next }).where(eq(S.id, id));
          return false;
        }
        if (s.nextRunAt.getTime() > now.getTime()) return false;
        await generateScheduleRunTx(tx, s, deps, now);
        await tx.update(S).set({ nextRunAt: next }).where(eq(S.id, id));
        return true;
      });
      if (did) ran++;
    } catch (e) {
      await recordGenerationFailure(db, orgId, id, e, now);
    }
  }
  return ran;
}

/** 一轮：逐个组织执行到点的定时推送，再发送到期的记录。测试与端到端用它手动驱动。 */
export async function runNotificationTick(db: Db, deps: NotifyDeps, now: Date = new Date()): Promise<TickSummary> {
  const summary: TickSummary = { orgs: 0, schedulesRun: 0, sent: 0, failed: 0, dead: 0, rateLimited: 0 };
  for (const orgId of await dueOrgIds(db, now)) {
    summary.orgs++;
    summary.schedulesRun += await runDueSchedules(db, orgId, deps, now);
    const r = await processDueDeliveries(db, orgId, deps, now);
    summary.sent += r.sent;
    summary.failed += r.failed;
    summary.dead += r.dead;
    summary.rateLimited += r.rateLimited;
  }
  return summary;
}

/** 后台循环：每轮结束后等 intervalMs 再开始下一轮（不重叠）；stop() 停止取新任务并等当前一轮结束。 */
export function createNotificationWorker(db: Db, deps: NotifyDeps, opts: { intervalMs?: number; onError?: (e: unknown) => void } = {}): NotificationWorker {
  const interval = opts.intervalMs ?? 5000;
  const onError = opts.onError ?? ((e: unknown) => console.error('[notify] 后台发送出错', e));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> | null = null;
  let stopped = false;
  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, interval);
  };
  const tick = () => {
    timer = null;
    current = runNotificationTick(db, deps)
      .then(() => undefined, onError)
      .finally(() => {
        current = null;
        schedule();
      });
  };
  return {
    start() {
      if (!stopped && !timer && !current) schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await current;
    },
  };
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './notifications/worker';
```

Run: `pnpm --filter @flower/core exec vitest run test/notify-worker.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: 写失败的测试（web）**

新建 `apps/web/test/server/worker.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { startNotificationWorker } from '@/server/worker';

describe('后台发送循环的开关', () => {
  it('FLOWER_NOTIFY_WORKER=off 时不启动，也不需要数据库配置', () => {
    expect(startNotificationWorker({ FLOWER_NOTIFY_WORKER: 'off' })).toBe(false);
  });
});
```

新建 `apps/web/test/api/notify-tick.test.ts`：

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

describe('手动驱动后台发送', () => {
  it('没有开启 FLOWER_NOTIFY_TICK_API 时接口不存在', async () => {
    const { app, cleanup } = await makeApp();
    cleanups.push(cleanup);
    const session = await initAndLogin(app);
    expect((await call(app, 'POST', '/instance/notifications/tick', { session, body: {} })).status).toBe(404);
  });

  it('开启后实例管理员可以驱动一轮（可传 now）；其他账号 403', async () => {
    const { app, cleanup } = await makeApp({ tickApi: true });
    cleanups.push(cleanup);
    const session = await initAndLogin(app);
    const r = await call(app, 'POST', '/instance/notifications/tick', { session, body: { now: '2026-10-12T12:00:00Z' } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ orgs: 0, schedulesRun: 0, sent: 0, failed: 0, dead: 0, rateLimited: 0 });
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'member@example.com', orgRole: 'admin' } });
    const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '组织管理员', password: 'password123' } });
    expect((await call(app, 'POST', '/instance/notifications/tick', { session: sessionFrom(accept.res), body: {} })).status).toBe(403);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run test/server/worker.test.ts test/api/notify-tick.test.ts`
Expected: FAIL（`@/server/worker` 不存在；`makeApp` 不接受参数）。

- [ ] **Step 4: 实现 web 的启动、依赖与 tick 接口**

新建 `apps/web/src/server/worker.ts`：

```ts
import { createDb, createNotificationWorker, defaultTransport, loadServerConfig } from '@flower/core';

const KEY = Symbol.for('flower.notificationWorker');
type Holder = Record<symbol, { stop: () => Promise<void> } | undefined>;

/**
 * 应用进程内的后台发送循环（instrumentation.ts 启动）。FLOWER_NOTIFY_WORKER=off 时不启动（测试与端到端改为调用 tick 接口）。
 * 用独立的小连接池；开发环境热重载时不重复启动；收到 SIGTERM / SIGINT 时停止取新任务。
 */
export function startNotificationWorker(env: Record<string, string | undefined> = process.env): boolean {
  if (env.FLOWER_NOTIFY_WORKER === 'off') return false;
  const holder = globalThis as unknown as Holder;
  if (holder[KEY]) return false;
  const config = loadServerConfig(env);
  const { db, close } = createDb(config.databaseUrl, { max: 2 });
  const worker = createNotificationWorker(db, { secretKey: config.secretKey, publicUrl: config.publicUrl, transport: defaultTransport });
  worker.start();
  const stop = async () => {
    await worker.stop();
    await close();
  };
  holder[KEY] = { stop };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void stop());
  return true;
}
```

`apps/web/src/instrumentation.ts` 改为：

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadServerConfig } = await import('@flower/core');
    loadServerConfig();
    const { startNotificationWorker } = await import('./server/worker');
    startNotificationWorker();
  }
}
```

`apps/web/src/server/api.ts`：

1. 第一行改为：

```ts
import type { AccountView, Actor, Db, FileStorage, NotifyDeps } from '@flower/core';
```

2. `export type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string; storage: FileStorage };` 改为：

```ts
/** notify：推送的密钥、对外网址与发送器；tickApi：是否开放手动驱动后台发送的接口（FLOWER_NOTIFY_TICK_API=1）。 */
export type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string; storage: FileStorage; notify: NotifyDeps; tickApi: boolean };
```

`apps/web/src/server/runtime.ts` 改为：

```ts
import { createDb, createLocalStorage, defaultTransport, loadServerConfig } from '@flower/core';
import { type App, createApi } from './api';

let api: App | undefined;

export function getApi(): App {
  if (!api) {
    const config = loadServerConfig();
    const { db } = createDb(config.databaseUrl);
    api = createApi({
      db,
      secureCookies: config.publicUrl.startsWith('https://'),
      publicUrl: config.publicUrl,
      storage: createLocalStorage(config.storageDir),
      notify: { secretKey: config.secretKey, publicUrl: config.publicUrl, transport: defaultTransport },
      tickApi: process.env.FLOWER_NOTIFY_TICK_API === '1',
    });
  }
  return api;
}
```

`apps/web/src/server/routes/instance.ts` 改为：

```ts
import { AppError, getInstanceStatus, runNotificationTick, updateInstanceSettings } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { requireAccount } from '../auth-middleware';
import { readJson } from '../http';

export function registerInstanceRoutes(app: App, deps: ApiDeps): void {
  app.get('/instance/settings', async (c) => {
    if (!requireAccount(c).isInstanceAdmin) throw new AppError('forbidden', '需要实例管理员权限');
    return c.json(await getInstanceStatus(deps.db));
  });

  app.patch('/instance/settings', async (c) => {
    const account = requireAccount(c);
    const body = await readJson(c, z.object({ allowSignup: z.boolean().optional(), allowOrgCreation: z.boolean().optional() }));
    return c.json(await updateInstanceSettings(deps.db, account, body));
  });

  /** 手动驱动一轮后台发送（端到端测试用）；只在 FLOWER_NOTIFY_TICK_API=1 时存在。 */
  app.post('/instance/notifications/tick', async (c) => {
    if (!deps.tickApi) throw new AppError('not_found', '接口不存在');
    if (!requireAccount(c).isInstanceAdmin) throw new AppError('forbidden', '需要实例管理员权限');
    const body = await readJson(c, z.object({ now: z.coerce.date().optional() }));
    return c.json({ summary: await runNotificationTick(deps.db, deps.notify, body.now) });
  });
}
```

`apps/web/test/api/helpers.ts`：

1. import 改为：

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalStorage, defaultTransport, type Transport } from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { type App, createApi } from '@/server/api';
```

2. `makeApp` 改为：

```ts
/** 接口测试用的应用。推送默认用真实发送器，测试里的通道地址一律指向本机假接收端（test/fake-webhook.ts）。 */
export async function makeApp(opts: { transport?: Transport; tickApi?: boolean } = {}): Promise<{ app: App; cleanup: () => Promise<void> }> {
  const t = await createTestDb();
  const storage = createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-api-storage-')));
  const app = createApi({
    db: t.db,
    secureCookies: false,
    publicUrl: 'http://localhost:3000',
    storage,
    notify: { secretKey: 'api-test-secret-api-test-secret-0001', publicUrl: 'http://localhost:3000', transport: opts.transport ?? defaultTransport },
    tickApi: opts.tickApi ?? false,
  });
  return { app, cleanup: t.cleanup };
}
```

`.env.example` 末尾加：

```
# 推送后台发送循环：默认随应用启动；设为 off 时不启动（测试与端到端用）
# FLOWER_NOTIFY_WORKER=off
# 设为 1 时开放 POST /api/v1/instance/notifications/tick（实例管理员手动驱动一轮，仅测试用）
# FLOWER_NOTIFY_TICK_API=1
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run test/server/worker.test.ts test/api/notify-tick.test.ts && pnpm --filter @flower/web test && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS（`pnpm --filter @flower/web test` 确认改了 `makeApp` 之后原有接口测试都不受影响）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/notifications/worker.ts packages/core/src/index.ts packages/core/test/notify-worker.test.ts apps/web/src/server/worker.ts apps/web/src/instrumentation.ts apps/web/src/server/api.ts apps/web/src/server/runtime.ts apps/web/src/server/routes/instance.ts apps/web/test/api/helpers.ts apps/web/test/server/worker.test.ts apps/web/test/api/notify-tick.test.ts .env.example
git commit -m "feat: 推送后台循环（随应用启动、可关闭）与实例管理员手动驱动的 tick 接口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: 推送接口与前端数据层（类型、查询、model、导航）

**Files:**
- Create: `apps/web/src/server/routes/notifications.ts`、`apps/web/test/fake-webhook.ts`
- Modify: `apps/web/src/server/api.ts`
- Test: `apps/web/test/api/notifications.test.ts`
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`
- Create: `apps/web/src/features/notifications/model.ts`、`apps/web/src/features/notifications/model.test.ts`
- Modify: `apps/web/src/features/shell/nav.ts`、`apps/web/src/features/shell/nav.test.ts`、`apps/web/src/components/org-shell.tsx`

**Interfaces:**
- Consumes: Task 5–11 的全部服务函数；`ApiDeps.notify`（Task 11）
- Produces:
  - 接口（`/api/v1` 下）：
    - `GET|POST /orgs/:org/notification-channels`、`PATCH|DELETE /orgs/:org/notification-channels/:id`、`POST /orgs/:org/notification-channels/:id/test` → `{ channels }` / `{ channel }` / `{ delivery }`
    - `GET /orgs/:org/products/:id/notification-channels` → `{ channels: ChannelOption[] }`
    - `GET|POST /orgs/:org/message-templates`、`PATCH|DELETE /orgs/:org/message-templates/:id` → `{ templates }` / `{ template }`
    - `GET|POST /orgs/:org/products/:id/notification-rules`、`PATCH|DELETE /orgs/:org/notification-rules/:id` → `{ rules }` / `{ rule }`
    - `GET /orgs/:org/notification-schedules[?product=]`、`POST /orgs/:org/notification-schedules`、`PATCH|DELETE /orgs/:org/notification-schedules/:id`、`POST /orgs/:org/notification-schedules/:id/run` → `{ schedules }` / `{ schedule }` / `{ result: RunResult }`
    - `GET /orgs/:org/notification-deliveries?channel=&kind=&status=&from=&to=&before=&limit=` → `{ deliveries, nextCursor }`；`POST /orgs/:org/notification-deliveries/:id/resend` → `{ delivery }`
  - 测试辅助 `apps/web/test/fake-webhook.ts`：`startFakeWebhook(): Promise<{ url(key: string): string; received: Received[]; reply(status: number, body: unknown): void; close(): Promise<void> }>`
  - 类型：`NotificationChannel`、`ChannelOption`、`MessageTemplate`、`NotificationRule`、`NotificationSchedule`、`NotificationDelivery`、`RunResult`
  - 查询：`qk.notificationChannels(o)`、`qk.productChannels(o, productId)`、`qk.messageTemplates(o)`、`qk.notificationRules(o, productId)`、`qk.notificationSchedules(o, productId | '')`、`qk.notificationDeliveries(o, query)`、`notifyKeys(o)`；`useNotificationChannels`、`useProductChannels`、`useMessageTemplates`、`useNotificationRules`、`useNotificationSchedules`、`useNotificationDeliveries`
  - model：`type ChannelForm`、`emptyChannelForm(kind?)`、`channelToForm(channel)`、`channelFormBody(form, editing)`、`parseRecipients(text)`、`toggle(list, value)`、`type DeliveryFilter`、`parseDeliveryFilter(params)`、`deliveryUrlQuery(filter)`、`deliveryApiQuery(filter, offsetMinutes)`、`DELIVERY_STATUS_TONE`、`filterSummary(filter, lookups)`、`scheduleState(schedule)`
  - 导航：组织设置增加「推送」（`/{org}/settings/notifications`，图标 `bell`）

- [ ] **Step 1: 写本机假接收端与失败的接口测试**

新建 `apps/web/test/fake-webhook.ts`：

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Received = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

/** 本机假 webhook 接收端：只监听 127.0.0.1，记录收到的请求；reply 设定应答（默认企微成功）。接口测试与端到端共用。 */
export async function startFakeWebhook(): Promise<{
  url: (key: string) => string;
  received: Received[];
  reply: (status: number, body: unknown) => void;
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  let response: { status: number; body: unknown } = { status: 200, body: { errcode: 0, errmsg: 'ok' } };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (key) => `http://127.0.0.1:${port}/cgi-bin/webhook/send?key=${key}`,
    received,
    reply: (status, body) => {
      response = { status, body };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

新建 `apps/web/test/api/notifications.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { startFakeWebhook } from '../fake-webhook';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
let session: string;
let editorSession: string;
let readToken: string;
let writeToken: string;
let productId: string;
let channelId: string;

beforeAll(async () => {
  hook = await startFakeWebhook();
  ({ app, cleanup } = await makeApp({ tickApi: true }));
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'editor@example.com', orgRole: 'member' } });
  editorSession = sessionFrom((await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '编辑', password: 'password123' } })).res);
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  const issue = (access: 'read' | 'write') => call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me, name: access, scope: { products: 'all', access } } });
  readToken = (await issue('read')).body.token;
  writeToken = (await issue('write')).body.token;
});
afterAll(async () => {
  await hook.close();
  await cleanup();
});

describe('推送接口', () => {
  it('通道：登记、测试消息发到本机假接收端；任何响应里都没有明文配置', async () => {
    const created = await call(app, 'POST', '/orgs/acme/notification-channels', { session, body: { kind: 'wecom_robot', name: '研发群', config: { url: hook.url('api-demo-0001') } } });
    expect(created.status).toBe(201);
    expect(created.body.channel).toMatchObject({ name: '研发群', configHint: '…/send?key=****0001', rateLimitPerMin: 20 });
    channelId = created.body.channel.id;
    const test = await call(app, 'POST', `/orgs/acme/notification-channels/${channelId}/test`, { session });
    expect(test.body.delivery).toMatchObject({ kind: 'test', status: 'sent', attempts: 1 });
    expect(hook.received.at(-1)!.body).toMatchObject({ msgtype: 'text' });
    const list = await call(app, 'GET', '/orgs/acme/notification-channels', { session });
    const deliveries = await call(app, 'GET', '/orgs/acme/notification-deliveries', { session });
    for (const r of [created, test, list, deliveries]) expect(JSON.stringify(r.body)).not.toContain('api-demo-0001');
    expect((await call(app, 'PATCH', `/orgs/acme/notification-channels/${channelId}`, { session, body: { config: { url: 'ftp://x.example.com' } } })).status).toBe(400);
    expect((await call(app, 'POST', '/orgs/acme/notification-channels', { session, body: { kind: 'sms', name: 'x', config: {} } })).status).toBe(400);
  });

  it('权限：编辑与只读 Token 不能管理通道、规则、定时推送与发送记录；成员可以读模板', async () => {
    const rule = { name: 'x', eventTypes: ['requirement.created'], channelIds: [channelId] };
    const schedule = { productId, name: 'x', cron: '0 9 * * *', source: 'overview_card', channelIds: [channelId] };
    const checks: Array<[string, string, { session?: string; token?: string; body?: unknown }]> = [
      ['GET', '/orgs/acme/notification-channels', { session: editorSession }],
      ['GET', '/orgs/acme/notification-channels', { token: readToken }],
      ['POST', '/orgs/acme/notification-channels', { token: readToken, body: { kind: 'wecom_robot', name: 'x', config: { url: hook.url('x') } } }],
      ['POST', `/orgs/acme/notification-channels/${channelId}/test`, { session: editorSession }],
      ['GET', `/orgs/acme/products/${productId}/notification-channels`, { session: editorSession }],
      ['POST', `/orgs/acme/products/${productId}/notification-rules`, { session: editorSession, body: rule }],
      ['POST', `/orgs/acme/products/${productId}/notification-rules`, { token: readToken, body: rule }],
      ['POST', '/orgs/acme/notification-schedules', { token: readToken, body: schedule }],
      ['GET', `/orgs/acme/notification-schedules?product=${productId}`, { session: editorSession }],
      ['GET', '/orgs/acme/notification-deliveries', { session: editorSession }],
      ['POST', '/orgs/acme/message-templates', { session: editorSession, body: { name: 'x', format: 'text', body: 'x' } }],
    ];
    for (const [method, path, opts] of checks) expect((await call(app, method, path, opts)).status, `${method} ${path}`).toBe(403);
    expect((await call(app, 'GET', '/orgs/acme/message-templates', { session: editorSession })).status).toBe(200);
  });

  it('规则、定时推送、立即执行（Token 需要写权限）、驱动发送、发送记录、重发、停用与删除', async () => {
    const rule = await call(app, 'POST', `/orgs/acme/products/${productId}/notification-rules`, { session, body: { name: '新需求', eventTypes: ['requirement.created'], channelIds: [channelId] } });
    expect(rule.status).toBe(201);
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/notification-rules`, { session })).body.rules).toHaveLength(1);
    await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '接口需求' } });
    const created = await call(app, 'POST', '/orgs/acme/notification-schedules', { session, body: { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId] } });
    expect(created.status).toBe(201);
    const scheduleId = created.body.schedule.id;
    expect(created.body.schedule.nextRunAt).not.toBeNull();
    expect((await call(app, 'POST', `/orgs/acme/notification-schedules/${scheduleId}/run`, { token: readToken })).status).toBe(403);
    const run = await call(app, 'POST', `/orgs/acme/notification-schedules/${scheduleId}/run`, { token: writeToken });
    expect(run.body.result).toMatchObject({ deliveries: 1, skipped: null });
    const before = hook.received.length;
    const tick = await call(app, 'POST', '/instance/notifications/tick', { session, body: {} });
    expect(tick.body.summary).toMatchObject({ sent: 2 });
    expect(hook.received.length - before).toBe(2);
    const list = await call(app, 'GET', '/orgs/acme/notification-deliveries?kind=schedule', { session });
    expect(list.body.deliveries[0]).toMatchObject({ status: 'sent', source: { type: 'schedule', name: '日报' }, channel: { name: '研发群' } });
    const resend = await call(app, 'POST', `/orgs/acme/notification-deliveries/${list.body.deliveries[0].id}/resend`, { session });
    expect(resend.status).toBe(201);
    expect(resend.body.delivery.status).toBe('pending');
    expect((await call(app, 'GET', '/orgs/acme/notification-deliveries?status=bogus', { session })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/notification-schedules', { session })).body.schedules).toHaveLength(1);
    expect((await call(app, 'PATCH', `/orgs/acme/notification-schedules/${scheduleId}`, { session, body: { enabled: false } })).body.schedule.nextRunAt).toBeNull();
    expect((await call(app, 'PATCH', `/orgs/acme/notification-rules/${rule.body.rule.id}`, { session, body: { enabled: false } })).body.rule.enabled).toBe(false);
    expect((await call(app, 'DELETE', `/orgs/acme/notification-rules/${rule.body.rule.id}`, { session })).status).toBe(409);
    expect((await call(app, 'DELETE', `/orgs/acme/notification-channels/${channelId}`, { session })).status).toBe(409);
  });

  it('模板：列表含四个预置模板；语法错误 400', async () => {
    const list = await call(app, 'GET', '/orgs/acme/message-templates', { session });
    expect(list.body.templates.filter((x: { builtin: boolean }) => x.builtin)).toHaveLength(4);
    const bad = await call(app, 'POST', '/orgs/acme/message-templates', { session, body: { name: '坏', format: 'markdown', body: '{{#a}}' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('模板语法错误');
  });

  it('畸形 id 返回 400', async () => {
    expect((await call(app, 'POST', '/orgs/acme/notification-channels/not-a-uuid/test', { session })).status).toBe(400);
    expect((await call(app, 'POST', '/orgs/acme/notification-schedules/not-a-uuid/run', { session })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/notification-schedules?product=not-a-uuid', { session })).status).toBe(400);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run test/api/notifications.test.ts`
Expected: FAIL（接口不存在，404）。

- [ ] **Step 2: 实现接口**

新建 `apps/web/src/server/routes/notifications.ts`：

```ts
import {
  AppError,
  CHANNEL_KINDS,
  createChannel,
  createMessageTemplate,
  createRule,
  createSchedule,
  DELIVERY_KINDS,
  DELIVERY_STATUSES,
  deleteChannel,
  deleteMessageTemplate,
  deleteRule,
  deleteSchedule,
  listChannels,
  listDeliveries,
  listMessageTemplates,
  listProductChannelOptions,
  listRules,
  listSchedules,
  resendDelivery,
  RULE_MODES,
  runScheduleNow,
  SCHEDULE_SOURCES,
  sendTestMessage,
  TEMPLATE_FORMATS,
  updateChannel,
  updateMessageTemplate,
  updateRule,
  updateSchedule,
} from '@flower/core';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const uuid = z.string().uuid();
const ids = z.array(uuid).max(100);
const record = z.record(z.string(), z.unknown());

/** 校验路径参数是合法的 UUID，否则报 400（而不是让 Postgres 的 22P02 落到 404）。 */
function idParam(c: Context, name: string, message: string): string {
  const r = uuid.safeParse(c.req.param(name));
  if (!r.success) throw new AppError('invalid', message);
  return r.data;
}

const configPatch = z
  .object({
    url: z.string().max(2000),
    secret: z.string().max(200),
    clearSecret: z.boolean(),
    host: z.string().max(255),
    port: z.number().int(),
    secure: z.boolean(),
    user: z.string().max(255),
    pass: z.string().max(500),
    from: z.string().max(255),
    to: z.array(z.string().max(255)).max(50),
  })
  .partial();

/** 过滤条件只校验形状，取值由服务层校验（parseRuleFilter）。 */
const list = z.array(z.string().max(100)).max(50);
const ruleFilter = z.object({ states: list, priorities: list, nodeIds: list, documentStatuses: list, fields: list }).partial();

const ruleBody = z.object({
  name: z.string(),
  eventTypes: z.array(z.string()).max(20),
  filter: ruleFilter.optional(),
  channelIds: ids.optional(),
  templateId: uuid.nullable().optional(),
  mode: z.enum(RULE_MODES).optional(),
  digestScheduleId: uuid.nullable().optional(),
  enabled: z.boolean().optional(),
});

const scheduleBody = z.object({
  name: z.string(),
  cron: z.string().max(100),
  timezone: z.string().max(64).optional(),
  sourceConfig: record.optional(),
  channelIds: ids,
  templateId: uuid.nullable().optional(),
  enabled: z.boolean().optional(),
  failThreshold: z.number().int().optional(),
});

const deliveryQuery = z.object({
  channel: uuid.optional(),
  kind: z.enum(DELIVERY_KINDS).optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function registerNotificationRoutes(app: App, deps: ApiDeps): void {
  // 通道（组织管理员）
  app.get('/orgs/:org/notification-channels', async (c) => c.json({ channels: await listChannels(deps.db, c.get('actor'), deps.notify) }));

  app.post('/orgs/:org/notification-channels', async (c) => {
    const body = await readJson(
      c,
      z.object({
        kind: z.enum(CHANNEL_KINDS),
        name: z.string(),
        groupLabel: z.string().nullable().optional(),
        config: record,
        rateLimitPerMin: z.number().int().optional(),
        allowedProductIds: ids.optional(),
        enabled: z.boolean().optional(),
      }),
    );
    return c.json({ channel: await createChannel(deps.db, c.get('actor'), body, deps.notify) }, 201);
  });

  app.patch('/orgs/:org/notification-channels/:id', async (c) => {
    const id = idParam(c, 'id', '通道无效');
    const body = await readJson(
      c,
      z.object({
        name: z.string().optional(),
        groupLabel: z.string().nullable().optional(),
        config: configPatch.optional(),
        rateLimitPerMin: z.number().int().optional(),
        allowedProductIds: ids.optional(),
        enabled: z.boolean().optional(),
      }),
    );
    return c.json({ channel: await updateChannel(deps.db, c.get('actor'), id, body, deps.notify) });
  });

  app.delete('/orgs/:org/notification-channels/:id', async (c) => {
    await deleteChannel(deps.db, c.get('actor'), idParam(c, 'id', '通道无效'));
    return c.body(null, 204);
  });

  app.post('/orgs/:org/notification-channels/:id/test', async (c) =>
    c.json({ delivery: await sendTestMessage(deps.db, c.get('actor'), idParam(c, 'id', '通道无效'), deps.notify) }),
  );

  app.get('/orgs/:org/products/:id/notification-channels', async (c) =>
    c.json({ channels: await listProductChannelOptions(deps.db, c.get('actor'), idParam(c, 'id', '产品无效')) }),
  );

  // 消息模板（读：非访客；写：组织管理员）
  app.get('/orgs/:org/message-templates', async (c) => c.json({ templates: await listMessageTemplates(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/message-templates', async (c) => {
    const body = await readJson(c, z.object({ name: z.string(), format: z.enum(TEMPLATE_FORMATS), body: z.string().max(20_000) }));
    return c.json({ template: await createMessageTemplate(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/message-templates/:id', async (c) => {
    const id = idParam(c, 'id', '模板无效');
    const body = await readJson(c, z.object({ name: z.string().optional(), format: z.enum(TEMPLATE_FORMATS).optional(), body: z.string().max(20_000).optional() }));
    return c.json({ template: await updateMessageTemplate(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/message-templates/:id', async (c) => {
    await deleteMessageTemplate(deps.db, c.get('actor'), idParam(c, 'id', '模板无效'));
    return c.body(null, 204);
  });

  // 事件规则（产品管理员）
  app.get('/orgs/:org/products/:id/notification-rules', async (c) => c.json({ rules: await listRules(deps.db, c.get('actor'), idParam(c, 'id', '产品无效')) }));

  app.post('/orgs/:org/products/:id/notification-rules', async (c) => {
    const productId = idParam(c, 'id', '产品无效');
    const body = await readJson(c, ruleBody);
    return c.json({ rule: await createRule(deps.db, c.get('actor'), productId, body) }, 201);
  });

  app.patch('/orgs/:org/notification-rules/:id', async (c) => {
    const id = idParam(c, 'id', '规则无效');
    const body = await readJson(c, ruleBody.partial());
    return c.json({ rule: await updateRule(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/notification-rules/:id', async (c) => {
    await deleteRule(deps.db, c.get('actor'), idParam(c, 'id', '规则无效'));
    return c.body(null, 204);
  });

  // 定时推送（本产品管理员；不带 product 时列出全部，需要组织管理员）
  app.get('/orgs/:org/notification-schedules', async (c) => {
    const product = c.req.query('product');
    if (product !== undefined && !uuid.safeParse(product).success) throw new AppError('invalid', '产品无效');
    return c.json({ schedules: await listSchedules(deps.db, c.get('actor'), { productId: product }) });
  });

  app.post('/orgs/:org/notification-schedules', async (c) => {
    const body = await readJson(c, scheduleBody.extend({ productId: uuid, source: z.enum(SCHEDULE_SOURCES) }));
    return c.json({ schedule: await createSchedule(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/notification-schedules/:id', async (c) => {
    const id = idParam(c, 'id', '定时推送无效');
    const body = await readJson(c, scheduleBody.partial());
    return c.json({ schedule: await updateSchedule(deps.db, c.get('actor'), id, body) });
  });

  app.delete('/orgs/:org/notification-schedules/:id', async (c) => {
    await deleteSchedule(deps.db, c.get('actor'), idParam(c, 'id', '定时推送无效'));
    return c.body(null, 204);
  });

  /** 立即执行：会话或有写权限的 API Token（取代 push 的 /trigger/:id）。 */
  app.post('/orgs/:org/notification-schedules/:id/run', async (c) =>
    c.json({ result: await runScheduleNow(deps.db, c.get('actor'), idParam(c, 'id', '定时推送无效'), deps.notify) }),
  );

  // 发送记录（组织管理员）
  app.get('/orgs/:org/notification-deliveries', async (c) => {
    const parsed = deliveryQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError('invalid', '查询参数有误');
    const { channel, ...rest } = parsed.data;
    return c.json(await listDeliveries(deps.db, c.get('actor'), { channelId: channel, ...rest }));
  });

  app.post('/orgs/:org/notification-deliveries/:id/resend', async (c) =>
    c.json({ delivery: await resendDelivery(deps.db, c.get('actor'), idParam(c, 'id', '发送记录无效')) }, 201),
  );
}
```

`apps/web/src/server/api.ts`：在 `import { registerModuleDocRoutes } from './routes/module-docs';` 之后加 `import { registerNotificationRoutes } from './routes/notifications';`；在 `registerModuleDocRoutes(app, deps);` 之后加 `registerNotificationRoutes(app, deps);`。

Run: `pnpm --filter @flower/web exec vitest run test/api/notifications.test.ts`
Expected: PASS。

- [ ] **Step 3: 写 model 的失败测试**

新建 `apps/web/src/features/notifications/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { NotificationChannel, NotificationSchedule } from '@/lib/types';
import { channelFormBody, channelToForm, deliveryApiQuery, deliveryUrlQuery, emptyChannelForm, filterSummary, parseDeliveryFilter, parseRecipients, scheduleState, toggle } from './model';

const email: NotificationChannel = {
  id: 'c1',
  kind: 'email',
  name: '邮件',
  groupLabel: null,
  configHint: 'smtp.example.com:465 · robot@example.com → 2 个收件人',
  settings: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', from: 'robot@example.com', to: ['a@example.com', 'b@example.com'] },
  rateLimitPerMin: 60,
  allowedProductIds: [],
  enabled: true,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  usage: { rules: 0, schedules: 0, deliveries: 0 },
};

describe('通道表单', () => {
  it('新建：带完整配置与默认上限', () => {
    const f = { ...emptyChannelForm('wecom_robot'), name: '研发群', url: 'http://127.0.0.1:9/send?key=k' };
    expect(f.rateLimitPerMin).toBe('20');
    expect(channelFormBody(f, false)).toEqual({ kind: 'wecom_robot', name: '研发群', groupLabel: null, rateLimitPerMin: 20, allowedProductIds: [], enabled: true, config: { url: 'http://127.0.0.1:9/send?key=k' } });
  });

  it('修改：敏感字段留空时不带；邮件回填非敏感字段，收件人按逗号、分号、空白拆分', () => {
    const f = channelToForm(email);
    expect(f).toMatchObject({ host: 'smtp.example.com', port: '465', to: 'a@example.com, b@example.com', pass: '' });
    expect(channelFormBody(f, true)).toEqual({
      name: '邮件',
      groupLabel: null,
      rateLimitPerMin: 60,
      allowedProductIds: [],
      enabled: true,
      config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', from: 'robot@example.com', to: ['a@example.com', 'b@example.com'] },
    });
    const wecom = { ...emptyChannelForm('wecom_robot'), name: '研发群' };
    expect(channelFormBody(wecom, true)).not.toHaveProperty('config');
    expect(channelFormBody({ ...emptyChannelForm('webhook'), name: 'h', clearSecret: true }, true)).toMatchObject({ config: { clearSecret: true } });
    expect(parseRecipients('a@example.com，b@example.com; c@example.com\n')).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('发送记录筛选', () => {
  it('地址栏 ↔ 筛选；无效值忽略；日期按所在时区换算为起止时间', () => {
    const f = parseDeliveryFilter(new URLSearchParams('kind=schedule&status=bogus&from=2026-10-09&to=2026-10-10&channel=c1'));
    expect(f).toEqual({ channel: 'c1', kind: 'schedule', status: '', from: '2026-10-09', to: '2026-10-10', before: '' });
    expect(deliveryUrlQuery(f)).toBe('channel=c1&kind=schedule&from=2026-10-09&to=2026-10-10');
    // UTC+8：getTimezoneOffset() 为 -480
    expect(deliveryApiQuery(f, -480)).toBe('channel=c1&kind=schedule&from=2026-10-08T16%3A00%3A00.000Z&to=2026-10-10T16%3A00%3A00.000Z');
    expect(deliveryApiQuery({ ...f, from: '', to: '', before: 'x|y' }, 0)).toBe('channel=c1&kind=schedule&before=x%7Cy');
  });
});

describe('规则与定时推送的展示', () => {
  it('过滤条件摘要', () => {
    const lookups = { states: new Map([['doing', '进行中']]), priorities: new Map([['p0', 'P0']]), nodes: new Map([['n1', '存储']]), fields: new Map([['priority', '优先级']]) };
    expect(filterSummary({}, lookups)).toBe('全部');
    expect(filterSummary({ states: ['doing'], priorities: ['p0', 'p9'], nodeIds: ['n1'], documentStatuses: ['review'], fields: ['priority'] }, lookups)).toBe(
      '状态：进行中 · 优先级：P0、p9 · 结构树：存储 · PRD 状态：评审中 · 字段：优先级',
    );
  });

  it('定时推送状态：告警优先，其次停用', () => {
    const s = { enabled: true, alertState: 'normal' } as NotificationSchedule;
    expect(scheduleState(s)).toBe('normal');
    expect(scheduleState({ ...s, enabled: false })).toBe('disabled');
    expect(scheduleState({ ...s, enabled: false, alertState: 'alert' })).toBe('alert');
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/notifications/model.test.ts`
Expected: FAIL（`./model` 不存在）。

- [ ] **Step 4: 实现类型、查询与 model**

`apps/web/src/lib/types.ts`：

1. 顶部 `import type { … } from '@flower/core';` 列表按字母序加入：`ChannelOption as CoreChannelOption`、`ChannelView`、`DeliveryView`、`MessageTemplateView`、`RuleView`、`RunResult as CoreRunResult`、`ScheduleView`。
2. 文件末尾加：

```ts
export type NotificationChannel = Jsonify<ChannelView>;
export type ChannelOption = CoreChannelOption;
export type MessageTemplate = Jsonify<MessageTemplateView>;
export type NotificationRule = Jsonify<RuleView>;
export type NotificationSchedule = Jsonify<ScheduleView>;
export type NotificationDelivery = Jsonify<DeliveryView>;
export type RunResult = CoreRunResult;
```

`apps/web/src/lib/queries.ts`：

1. `import type { … } from './types';` 列表按字母序加入 `ChannelOption`、`MessageTemplate`、`NotificationChannel`、`NotificationDelivery`、`NotificationRule`、`NotificationSchedule`。
2. `qk` 对象里 `task: …` 之后加：

```ts
  notificationChannels: (o: string) => ['org', o, 'notify', 'channels'] as const,
  productChannels: (o: string, productId: string) => ['org', o, 'notify', 'product-channels', productId] as const,
  messageTemplates: (o: string) => ['org', o, 'notify', 'templates'] as const,
  notificationRules: (o: string, productId: string) => ['org', o, 'notify', 'rules', productId] as const,
  notificationSchedules: (o: string, productId: string) => ['org', o, 'notify', 'schedules', productId] as const,
  notificationDeliveries: (o: string, query: string) => ['org', o, 'notify', 'deliveries', query] as const,
```

3. `useTask` 之后加：

```ts
/** 推送相关查询的公共前缀：通道、模板、规则、定时推送或发送记录变化后统一失效。 */
export const notifyKeys = (o: string) => ['org', o, 'notify'] as const;

export const useNotificationChannels = (o: string) =>
  useQuery({ queryKey: qk.notificationChannels(o), queryFn: () => api<{ channels: NotificationChannel[] }>(`/orgs/${o}/notification-channels`), select: (d) => d.channels });
export const useProductChannels = (o: string, productId: string) =>
  useQuery({
    queryKey: qk.productChannels(o, productId),
    queryFn: () => api<{ channels: ChannelOption[] }>(`/orgs/${o}/products/${productId}/notification-channels`),
    select: (d) => d.channels,
    enabled: !!productId,
  });
export const useMessageTemplates = (o: string) =>
  useQuery({ queryKey: qk.messageTemplates(o), queryFn: () => api<{ templates: MessageTemplate[] }>(`/orgs/${o}/message-templates`), select: (d) => d.templates });
export const useNotificationRules = (o: string, productId: string) =>
  useQuery({
    queryKey: qk.notificationRules(o, productId),
    queryFn: () => api<{ rules: NotificationRule[] }>(`/orgs/${o}/products/${productId}/notification-rules`),
    select: (d) => d.rules,
  });
/** productId 为空时列出全部（组织管理员）。 */
export const useNotificationSchedules = (o: string, productId?: string) =>
  useQuery({
    queryKey: qk.notificationSchedules(o, productId ?? ''),
    queryFn: () => api<{ schedules: NotificationSchedule[] }>(`/orgs/${o}/notification-schedules${productId ? `?product=${productId}` : ''}`),
    select: (d) => d.schedules,
  });
export const useNotificationDeliveries = (o: string, query: string) =>
  useQuery({
    queryKey: qk.notificationDeliveries(o, query),
    queryFn: () => api<{ deliveries: NotificationDelivery[]; nextCursor: string | null }>(`/orgs/${o}/notification-deliveries${query ? `?${query}` : ''}`),
    placeholderData: keepPreviousData,
  });
```

新建 `apps/web/src/features/notifications/model.ts`：

```ts
import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import {
  type ChannelKind,
  DEFAULT_RATE_LIMIT,
  DELIVERY_KINDS,
  DELIVERY_STATUSES,
  type DeliveryKind,
  type DeliveryStatus,
  type RuleFilter,
} from '@flower/core/notifications';
import type { NotificationChannel, NotificationSchedule } from '@/lib/types';

export type ChannelForm = {
  kind: ChannelKind;
  name: string;
  groupLabel: string;
  url: string;
  secret: string;
  clearSecret: boolean;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
  rateLimitPerMin: string;
  allowedProductIds: string[];
  enabled: boolean;
};

export function emptyChannelForm(kind: ChannelKind = 'wecom_robot'): ChannelForm {
  return {
    kind,
    name: '',
    groupLabel: '',
    url: '',
    secret: '',
    clearSecret: false,
    host: '',
    port: '465',
    secure: true,
    user: '',
    pass: '',
    from: '',
    to: '',
    rateLimitPerMin: String(DEFAULT_RATE_LIMIT[kind]),
    allowedProductIds: [],
    enabled: true,
  };
}

/** 修改时的初值：网址、签名密钥、密码一律留空（留空表示不变）；邮件的非敏感字段回填。 */
export function channelToForm(c: NotificationChannel): ChannelForm {
  const s = c.settings;
  return {
    ...emptyChannelForm(c.kind),
    name: c.name,
    groupLabel: c.groupLabel ?? '',
    rateLimitPerMin: String(c.rateLimitPerMin),
    allowedProductIds: c.allowedProductIds,
    enabled: c.enabled,
    ...(s ? { host: s.host, port: String(s.port), secure: s.secure, user: s.user, from: s.from, to: s.to.join(', ') } : {}),
  };
}

export const parseRecipients = (text: string): string[] =>
  text
    .split(/[,，;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

/** 新建：完整配置；修改：只带填写了的敏感字段，没有要改的配置时不带 config。 */
export function channelFormBody(f: ChannelForm, editing: boolean): Record<string, unknown> {
  const base = { name: f.name, groupLabel: f.groupLabel.trim() || null, rateLimitPerMin: Number(f.rateLimitPerMin), allowedProductIds: f.allowedProductIds, enabled: f.enabled };
  const keep = (value: string) => value !== '' || !editing;
  let config: Record<string, unknown>;
  if (f.kind === 'email') {
    config = { host: f.host, port: Number(f.port), secure: f.secure, user: f.user, from: f.from, to: parseRecipients(f.to), ...(keep(f.pass) ? { pass: f.pass } : {}) };
  } else if (f.kind === 'webhook') {
    config = { ...(keep(f.url) ? { url: f.url } : {}), ...(f.secret ? { secret: f.secret } : {}), ...(editing && f.clearSecret ? { clearSecret: true } : {}) };
  } else {
    config = keep(f.url) ? { url: f.url } : {};
  }
  if (editing) return Object.keys(config).length > 0 ? { ...base, config } : base;
  return { kind: f.kind, ...base, config };
}

export type DeliveryFilter = { channel: string; kind: DeliveryKind | ''; status: DeliveryStatus | ''; from: string; to: string; before: string };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDeliveryFilter(p: URLSearchParams): DeliveryFilter {
  const kind = p.get('kind') ?? '';
  const status = p.get('status') ?? '';
  const day = (v: string | null) => (v && DAY.test(v) ? v : '');
  return {
    channel: p.get('channel') ?? '',
    kind: (DELIVERY_KINDS as readonly string[]).includes(kind) ? (kind as DeliveryKind) : '',
    status: (DELIVERY_STATUSES as readonly string[]).includes(status) ? (status as DeliveryStatus) : '',
    from: day(p.get('from')),
    to: day(p.get('to')),
    before: p.get('before') ?? '',
  };
}

const params = (entries: Array<[string, string]>): string => new URLSearchParams(entries.filter(([, v]) => v !== '')).toString();

/** 地址栏：原样保存筛选（日期为 YYYY-MM-DD）。 */
export function deliveryUrlQuery(f: DeliveryFilter): string {
  return params([
    ['channel', f.channel],
    ['kind', f.kind],
    ['status', f.status],
    ['from', f.from],
    ['to', f.to],
    ['before', f.before],
  ]);
}

/** 本地日期 00:00 对应的 UTC 时间；offsetMinutes 为 Date#getTimezoneOffset() 的值。 */
const localMidnight = (day: string, offsetMinutes: number, plusDays = 0): string => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + plusDays) + offsetMinutes * 60_000).toISOString();
};

/** 接口查询：起始日 00:00 到结束日次日 00:00（含结束日整天）。 */
export function deliveryApiQuery(f: DeliveryFilter, offsetMinutes: number): string {
  return params([
    ['channel', f.channel],
    ['kind', f.kind],
    ['status', f.status],
    ['from', f.from ? localMidnight(f.from, offsetMinutes) : ''],
    ['to', f.to ? localMidnight(f.to, offsetMinutes, 1) : ''],
    ['before', f.before],
  ]);
}

export const DELIVERY_STATUS_TONE: Record<DeliveryStatus, string> = {
  pending: 'text-muted-foreground',
  sending: 'text-muted-foreground',
  sent: 'text-emerald-700 dark:text-emerald-400',
  failed: 'text-amber-700 dark:text-amber-400',
  dead: 'text-destructive',
};

export type FilterLookups = { states: Map<string, string>; priorities: Map<string, string>; nodes: Map<string, string>; fields: Map<string, string> };

/** 规则过滤条件的一行摘要；查不到名称时显示原 key。 */
export function filterSummary(filter: RuleFilter, l: FilterLookups): string {
  const name = (map: Map<string, string>, keys: string[] | undefined) => (keys ?? []).map((k) => map.get(k) ?? k).join('、');
  const docs = (filter.documentStatuses ?? []).map((k) => (DOCUMENT_STATUS_LABELS as Record<string, string>)[k] ?? k).join('、');
  const parts = [
    filter.states?.length ? `状态：${name(l.states, filter.states)}` : '',
    filter.priorities?.length ? `优先级：${name(l.priorities, filter.priorities)}` : '',
    filter.nodeIds?.length ? `结构树：${name(l.nodes, filter.nodeIds)}` : '',
    docs ? `PRD 状态：${docs}` : '',
    filter.fields?.length ? `字段：${name(l.fields, filter.fields)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '全部';
}

export function scheduleState(s: Pick<NotificationSchedule, 'enabled' | 'alertState'>): 'alert' | 'disabled' | 'normal' {
  if (s.alertState === 'alert') return 'alert';
  return s.enabled ? 'normal' : 'disabled';
}
```

- [ ] **Step 5: 导航「推送」**

`apps/web/src/features/shell/nav.ts`：

1. `NavIcon` 联合类型末尾加 `| 'bell'`。
2. `SETTINGS` 里 `['agents', 'Agent 与 Token', 'bot'],` 之后加 `['notifications', '推送', 'bell'],`。

`apps/web/src/features/shell/nav.test.ts`：管理员设置分组的期望列表里 `'/acme/settings/agents',` 之后加 `'/acme/settings/notifications',`；「根据路径判断当前导航项」里加 `expect(activeNavKey('/acme/settings/notifications', 'acme')).toBe('notifications');`。

`apps/web/src/components/org-shell.tsx`：lucide 的 import 列表加入 `Bell`（按字母序放在 `Blocks` 之前），`ICONS` 里 `building: Building2,` 之后加 `bell: Bell,`。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run src/features/notifications/model.test.ts src/features/shell/nav.test.ts test/api/notifications.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/server/routes/notifications.ts apps/web/src/server/api.ts apps/web/test/fake-webhook.ts apps/web/test/api/notifications.test.ts apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/features/notifications apps/web/src/features/shell/nav.ts apps/web/src/features/shell/nav.test.ts apps/web/src/components/org-shell.tsx
git commit -m "feat(web): 推送接口（通道、模板、规则、定时推送、立即执行、发送记录、重发）与前端数据层

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 13: 页面：组织设置「推送」——通道与消息模板

**Files:**
- Create: `apps/web/src/app/(app)/[org]/settings/notifications/page.tsx`、`channels-tab.tsx`、`channel-dialog.tsx`、`templates-tab.tsx`、`template-dialog.tsx`
- Modify: `apps/web/playwright.config.ts`
- Test: `apps/web/e2e/notify-channels.spec.ts`

**Interfaces:**
- Consumes: Task 12 的 `useNotificationChannels`、`useMessageTemplates`、`useProducts`、`notifyKeys`、`ChannelForm`、`emptyChannelForm`、`channelToForm`、`channelFormBody`、`toggle`；`startFakeWebhook`（`apps/web/test/fake-webhook.ts`）
- Produces: 页面 `/{org}/settings/notifications`（`?tab=channels|templates`，Task 14、15 再加 `schedules`、`deliveries`）；组件 `ChannelsTab`、`ChannelDialog`、`TemplatesTab`、`TemplateDialog`

- [ ] **Step 1: 端到端测试的服务端关闭后台循环、开放 tick 接口**

`apps/web/playwright.config.ts` 的 `webServer.env` 里 `FLOWER_STORAGE_DIR: …,` 之后加：

```ts
      // 推送：不启动后台循环，用例通过 POST /api/v1/instance/notifications/tick 驱动
      FLOWER_NOTIFY_WORKER: 'off',
      FLOWER_NOTIFY_TICK_API: '1',
```

- [ ] **Step 2: 写失败的端到端测试**

新建 `apps/web/e2e/notify-channels.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { startFakeWebhook } from '../test/fake-webhook';
import { resetDatabase } from './db';
import { expectNoPageOverflow, login, OWNER, setupInstance } from './helpers';

let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
test.beforeAll(async () => {
  hook = await startFakeWebhook();
});
test.afterAll(async () => {
  await hook.close();
});

test('登记企微通道、确认后发送测试消息、修改（地址留空不变）、停用后不能测试；页面不显示明文地址', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/notifications');
  await expect(page.getByText('还没有通道')).toBeVisible();
  await page.getByRole('button', { name: '登记通道' }).click();
  await page.getByLabel('名称', { exact: true }).fill('研发群');
  await page.getByLabel('所属群').fill('研发');
  await page.getByLabel('机器人地址').fill(hook.url('e2e-demo-0001'));
  await page.getByRole('button', { name: '保存' }).click();
  const row = page.getByRole('row', { name: /研发群/ });
  await expect(row).toContainText('…/send?key=****0001');
  await expect(page.getByText('e2e-demo-0001')).toHaveCount(0);

  const before = hook.received.length;
  await row.getByRole('button', { name: '测试' }).click();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('测试消息已发送')).toBeVisible();
  expect(hook.received.length).toBe(before + 1);
  expect(hook.received.at(-1)!.body).toMatchObject({ msgtype: 'text' });

  await row.getByRole('button', { name: '修改' }).click();
  await expect(page.getByLabel('机器人地址')).toHaveValue('');
  await page.getByLabel('名称', { exact: true }).fill('研发群 A');
  await page.getByRole('button', { name: '保存' }).click();
  const renamed = page.getByRole('row', { name: /研发群 A/ });
  await expect(renamed).toContainText('****0001');

  await page.getByRole('switch', { name: '启用研发群 A' }).click();
  await expect(renamed.getByRole('button', { name: '测试' })).toBeDisabled();
});

test('邮件通道：必填项与收件人；修改时回填非敏感字段，密码留空', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/notifications');
  await page.getByRole('button', { name: '登记通道' }).click();
  await page.getByLabel('通道类型').click();
  await page.getByRole('option', { name: '邮件' }).click();
  await page.getByLabel('名称', { exact: true }).fill('周报邮件');
  await page.getByLabel('SMTP 服务器').fill('smtp.example.com');
  await page.getByLabel('用户名').fill('robot@example.com');
  await page.getByLabel('密码').fill('demo-pass');
  await page.getByLabel('发件人').fill('robot@example.com');
  await page.getByLabel('收件人').fill('pm@example.com, dev@example.com');
  await page.getByRole('button', { name: '保存' }).click();
  const row = page.getByRole('row', { name: /周报邮件/ });
  await expect(row).toContainText('smtp.example.com:465 · robot@example.com → 2 个收件人');
  await row.getByRole('button', { name: '修改' }).click();
  await expect(page.getByLabel('SMTP 服务器')).toHaveValue('smtp.example.com');
  await expect(page.getByLabel('密码')).toHaveValue('');
  await expect(page.getByText('demo-pass')).toHaveCount(0);
});

test('消息模板：预置模板只改内容；新建自定义模板，语法错误给出提示；删除', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/notifications?tab=templates');
  await expect(page.getByRole('row', { name: /默认 · 事件推送/ })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '预置' })).toHaveCount(4);

  await page.getByRole('row', { name: /默认 · 事件推送/ }).getByRole('button', { name: '修改' }).click();
  await expect(page.getByLabel('模板名称')).toBeDisabled();
  await page.getByLabel('内容').fill('{{subject.key}} {{event.label}}');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('模板已保存')).toBeVisible();

  await page.getByRole('button', { name: '新建模板' }).click();
  await page.getByLabel('模板名称').fill('简版');
  await page.getByLabel('内容').fill('{{#a}}');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('alert')).toContainText('模板语法错误');
  await page.getByLabel('内容').fill('{{subject.key}} {{summary}}');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('row', { name: /简版/ })).toBeVisible();
  await page.getByRole('row', { name: /简版/ }).getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('row', { name: /默认 · 事件推送/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /简版/ })).toHaveCount(0);
});

test('通道与模板页签在 1440 与 760 宽度下不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await request.post('/api/v1/orgs/acme/notification-channels', {
    data: { kind: 'wecom_robot', name: '一个名字比较长的研发群机器人', groupLabel: '研发中心', config: { url: hook.url('layout-0001') } },
  });
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/settings/notifications');
    await expect(page.getByRole('row', { name: /一个名字比较长/ })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto('/acme/settings/notifications?tab=templates');
    await expect(page.getByRole('row', { name: /默认 · 事件推送/ })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});
```

Run: `pnpm --filter @flower/web e2e notify-channels.spec.ts`
Expected: FAIL（页面不存在）。

- [ ] **Step 3: 页面**

新建 `apps/web/src/app/(app)/[org]/settings/notifications/page.tsx`：

```tsx
'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChannelsTab } from './channels-tab';
import { TemplatesTab } from './templates-tab';

const TABS = ['channels', 'templates'];

function NotificationsPage() {
  const { org } = useParams<{ org: string }>();
  const tab = useSearchParams().get('tab') ?? '';
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '推送' }]}
        title="推送"
        description="登记群机器人、Webhook 与邮件通道，维护消息模板，查看定时推送与发送记录。事件规则在各产品设置的「推送」页签配置。"
      />
      <Tabs defaultValue={TABS.includes(tab) ? tab : 'channels'}>
        <TabsList>
          <TabsTrigger value="channels">通道</TabsTrigger>
          <TabsTrigger value="templates">消息模板</TabsTrigger>
        </TabsList>
        <TabsContent value="channels">
          <ChannelsTab org={org} />
        </TabsContent>
        <TabsContent value="templates">
          <TemplatesTab org={org} />
        </TabsContent>
      </Tabs>
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <RequireOrgAdmin>
        <NotificationsPage />
      </RequireOrgAdmin>
    </Suspense>
  );
}
```

新建 `apps/web/src/app/(app)/[org]/settings/notifications/channel-dialog.tsx`：

```tsx
'use client';

import { CHANNEL_KIND_LABELS, CHANNEL_KINDS, type ChannelKind } from '@flower/core/notifications';
import { type ReactNode, useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { type ChannelForm, channelFormBody, channelToForm, emptyChannelForm, toggle } from '@/features/notifications/model';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useProducts } from '@/lib/queries';
import type { NotificationChannel } from '@/lib/types';

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** 登记或修改通道。初值只在挂载时读取：父组件用 key 让每次打开重新挂载。敏感字段修改时留空表示不变。 */
export function ChannelDialog({ org, channel, open, onOpenChange }: { org: string; channel: NotificationChannel | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const products = useProducts(org);
  const [form, setForm] = useState<ChannelForm>(() => (channel ? channelToForm(channel) : emptyChannelForm()));
  const set = (patch: Partial<ChannelForm>) => setForm((f) => ({ ...f, ...patch }));
  const save = useApiMutation(
    () =>
      channel
        ? api(`/orgs/${org}/notification-channels/${channel.id}`, { method: 'PATCH', body: channelFormBody(form, true) })
        : api(`/orgs/${org}/notification-channels`, { method: 'POST', body: channelFormBody(form, false) }),
    { invalidate: [notifyKeys(org)], success: channel ? '已保存' : '通道已登记', silentError: true, onSuccess: () => onOpenChange(false) },
  );
  const keep = channel ? '留空表示不变' : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{channel ? `修改通道「${channel.name}」` : '登记通道'}</DialogTitle>
            <DialogDescription>网址、签名密钥与密码加密保存，保存后只显示脱敏提示。</DialogDescription>
          </DialogHeader>
          {!channel && (
            <Field id="ch-kind" label="通道类型">
              <Select value={form.kind} onValueChange={(v) => setForm({ ...emptyChannelForm(v as ChannelKind), name: form.name, groupLabel: form.groupLabel })}>
                <SelectTrigger id="ch-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {CHANNEL_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ch-name" label="名称">
              <Input id="ch-name" required value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field id="ch-group" label="所属群" hint="仅用于展示与归组">
              <Input id="ch-group" value={form.groupLabel} onChange={(e) => set({ groupLabel: e.target.value })} />
            </Field>
          </div>
          {form.kind !== 'email' && (
            <Field id="ch-url" label={form.kind === 'wecom_robot' ? '机器人地址' : 'Webhook 地址'} hint={channel ? `当前：${channel.configHint}，留空表示不变` : undefined}>
              <Input id="ch-url" required={!channel} autoComplete="off" className="font-mono" placeholder="https://" value={form.url} onChange={(e) => set({ url: e.target.value })} />
            </Field>
          )}
          {form.kind === 'webhook' && (
            <>
              <Field id="ch-secret" label="签名密钥" hint={keep ?? '可选；填写后请求带 HMAC-SHA256 签名头'}>
                <Input id="ch-secret" type="password" autoComplete="new-password" value={form.secret} onChange={(e) => set({ secret: e.target.value })} />
              </Field>
              {channel?.configHint.includes('已设置签名密钥') && (
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox aria-label="清除签名密钥" checked={form.clearSecret} onCheckedChange={(v) => set({ clearSecret: v === true })} />
                  清除签名密钥
                </label>
              )}
            </>
          )}
          {form.kind === 'email' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ch-host" label="SMTP 服务器">
                <Input id="ch-host" required value={form.host} onChange={(e) => set({ host: e.target.value })} />
              </Field>
              <Field id="ch-port" label="端口">
                <Input id="ch-port" type="number" required min={1} max={65535} value={form.port} onChange={(e) => set({ port: e.target.value })} />
              </Field>
              <Field id="ch-user" label="用户名">
                <Input id="ch-user" required autoComplete="off" value={form.user} onChange={(e) => set({ user: e.target.value })} />
              </Field>
              <Field id="ch-pass" label="密码" hint={keep}>
                <Input id="ch-pass" type="password" required={!channel} autoComplete="new-password" value={form.pass} onChange={(e) => set({ pass: e.target.value })} />
              </Field>
              <Field id="ch-from" label="发件人">
                <Input id="ch-from" type="email" required value={form.from} onChange={(e) => set({ from: e.target.value })} />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-[13px]">
                <Checkbox aria-label="使用 SSL" checked={form.secure} onCheckedChange={(v) => set({ secure: v === true })} />
                使用 SSL（端口 465）
              </label>
              <div className="sm:col-span-2">
                <Field id="ch-to" label="收件人" hint="多个地址用逗号、分号或换行分隔">
                  <Textarea id="ch-to" rows={2} required value={form.to} onChange={(e) => set({ to: e.target.value })} />
                </Field>
              </div>
            </div>
          )}
          <Field id="ch-rate" label="每分钟上限" hint="企业微信机器人每分钟最多 20 条">
            <Input id="ch-rate" type="number" required min={1} max={600} className="w-32" value={form.rateLimitPerMin} onChange={(e) => set({ rateLimitPerMin: e.target.value })} />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">可用产品</legend>
            <p className="text-xs text-muted-foreground">都不勾选表示全部产品可用。</p>
            <div className="flex flex-wrap gap-3">
              {(products.data ?? []).map((p) => (
                <label key={p.id} className="flex items-center gap-1.5 text-[13px]">
                  <Checkbox aria-label={p.name} checked={form.allowedProductIds.includes(p.id)} onCheckedChange={() => set({ allowedProductIds: toggle(form.allowedProductIds, p.id) })} />
                  {p.name}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox aria-label="启用" checked={form.enabled} onCheckedChange={(v) => set({ enabled: v === true })} />
            启用
          </label>
          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
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

新建 `apps/web/src/app/(app)/[org]/settings/notifications/channels-tab.tsx`：

```tsx
'use client';

import { CHANNEL_KIND_LABELS } from '@flower/core/notifications';
import { Radio } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useNotificationChannels, useProducts } from '@/lib/queries';
import type { NotificationChannel, NotificationDelivery } from '@/lib/types';
import { ChannelDialog } from './channel-dialog';

export function ChannelsTab({ org }: { org: string }) {
  const q = useNotificationChannels(org);
  const products = useProducts(org);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);
  const productName = new Map((products.data ?? []).map((p) => [p.id, p.name]));
  const toggleEnabled = useApiMutation(
    (v: { id: string; enabled: boolean }) => api(`/orgs/${org}/notification-channels/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }),
    { invalidate: [notifyKeys(org)], success: '已保存' },
  );
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/notification-channels/${id}`, { method: 'DELETE' }), { invalidate: [notifyKeys(org)], success: '通道已删除' });
  const test = useApiMutation((id: string) => api<{ delivery: NotificationDelivery }>(`/orgs/${org}/notification-channels/${id}/test`, { method: 'POST' }), {
    invalidate: [notifyKeys(org)],
    onSuccess: ({ delivery }) => {
      if (delivery.status === 'sent') toast.success('测试消息已发送');
      else toast.error(`测试消息发送失败：${delivery.response ?? '未知原因'}`);
    },
  });
  if (q.isError) return <LoadError message="加载通道失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">一个通道对应一个机器人或地址；同一个群的多个机器人用「所属群」归组。迁移来的通道默认停用。</p>
        <Button onClick={() => setCreating(true)}>登记通道</Button>
      </div>
      {q.data.length === 0 ? (
        <EmptyState icon={Radio} title="还没有通道" description="登记企业微信机器人、Webhook 或邮件后，才能配置事件规则与定时推送。" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>地址</TableHead>
                <TableHead>可用产品</TableHead>
                <TableHead className="w-24">每分钟上限</TableHead>
                <TableHead className="w-16">启用</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((c) => (
                <TableRow key={c.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-medium">
                    {c.name}
                    {c.groupLabel && <span className="ml-2 text-xs text-muted-foreground">{c.groupLabel}</span>}
                  </TableCell>
                  <TableCell>{CHANNEL_KIND_LABELS[c.kind]}</TableCell>
                  <TableCell className="font-mono text-xs">{c.configHint}</TableCell>
                  <TableCell className="text-[13px]">{c.allowedProductIds.length ? c.allowedProductIds.map((id) => productName.get(id) ?? '已删除的产品').join('、') : '全部产品'}</TableCell>
                  <TableCell className="font-mono text-xs">{c.rateLimitPerMin}</TableCell>
                  <TableCell>
                    <Switch aria-label={`启用${c.name}`} checked={c.enabled} onCheckedChange={(v) => toggleEnabled.mutate({ id: c.id, enabled: v })} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm" disabled={!c.enabled || test.isPending} title={c.enabled ? undefined : '启用后才能发送测试消息'}>
                          测试
                        </Button>
                      }
                      title={`向「${c.name}」发送测试消息？`}
                      description="会向该群或地址真实发送一条固定内容的消息，结果写入发送记录。"
                      confirmLabel="发送"
                      onConfirm={() => test.mutate(c.id)}
                    />
                    <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                      修改
                    </Button>
                    {c.usage.rules + c.usage.schedules + c.usage.deliveries === 0 && (
                      <ConfirmAction
                        trigger={
                          <Button variant="ghost" size="sm">
                            删除
                          </Button>
                        }
                        title={`删除通道「${c.name}」？`}
                        description="删除后不能恢复。已有发送记录或被规则、定时推送引用的通道只能停用。"
                        confirmLabel="确认删除"
                        destructive
                        onConfirm={() => remove.mutate(c.id)}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {creating && <ChannelDialog org={org} channel={null} open onOpenChange={setCreating} />}
      {editing && <ChannelDialog key={editing.id} org={org} channel={editing} open onOpenChange={(v) => !v && setEditing(null)} />}
    </section>
  );
}
```

新建 `apps/web/src/app/(app)/[org]/settings/notifications/template-dialog.tsx`：

```tsx
'use client';

import { TEMPLATE_FORMAT_LABELS, TEMPLATE_FORMATS, type TemplateFormat } from '@flower/core/notifications';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation } from '@/lib/queries';
import type { MessageTemplate } from '@/lib/types';

const FORMAT_HINT: Record<TemplateFormat, string> = {
  text: '纯文本。',
  markdown: '企业微信 markdown：支持加粗、链接、引用与 <font color="warning|comment|info">。',
  template_card: '内容是企业微信 template_card 对象的 JSON，只替换字符串里的变量。',
  email: '第一行是邮件主题，其余为正文。',
};

/** 新建或修改模板。预置模板只能改内容。初值只在挂载时读取：父组件每次打开时重新挂载。 */
export function TemplateDialog({ org, template, onClose }: { org: string; template: MessageTemplate | null; onClose: () => void }) {
  const [name, setName] = useState(template?.name ?? '');
  const [format, setFormat] = useState<TemplateFormat>(template?.format ?? 'markdown');
  const [body, setBody] = useState(template?.body ?? '');
  const builtin = template?.builtin ?? false;
  const save = useApiMutation(
    () =>
      template
        ? api(`/orgs/${org}/message-templates/${template.id}`, { method: 'PATCH', body: builtin ? { body } : { name, format, body } })
        : api(`/orgs/${org}/message-templates`, { method: 'POST', body: { name, format, body } }),
    { invalidate: [notifyKeys(org)], success: '模板已保存', silentError: true, onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{template ? `修改模板「${template.name}」` : '新建模板'}</DialogTitle>
            <DialogDescription>
              变量写作 {'{{path}}'}，如 {'{{subject.title}}'}；{'{{#list}}…{{/list}}'} 按列表重复，{'{{^x}}…{{/x}}'} 在为空时显示。缺少的字段显示为空。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tpl-name">模板名称</Label>
              <Input id="tpl-name" required disabled={builtin} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tpl-format">格式</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as TemplateFormat)} disabled={builtin}>
                <SelectTrigger id="tpl-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_FORMATS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {TEMPLATE_FORMAT_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tpl-body">内容</Label>
            <Textarea id="tpl-body" required rows={14} className="font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
            <span className="text-xs text-muted-foreground">{FORMAT_HINT[format]}</span>
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

新建 `apps/web/src/app/(app)/[org]/settings/notifications/templates-tab.tsx`：

```tsx
'use client';

import { TEMPLATE_FORMAT_LABELS } from '@flower/core/notifications';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { LoadError } from '@/components/load-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useMessageTemplates } from '@/lib/queries';
import type { MessageTemplate } from '@/lib/types';
import { TemplateDialog } from './template-dialog';

export function TemplatesTab({ org }: { org: string }) {
  const q = useMessageTemplates(org);
  const [open, setOpen] = useState<{ template: MessageTemplate | null } | null>(null);
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/message-templates/${id}`, { method: 'DELETE' }), { invalidate: [notifyKeys(org)], success: '模板已删除' });
  if (q.isError) return <LoadError message="加载模板失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">规则与定时推送不指定模板时使用对应的预置模板。预置模板可以改内容，不能删除。</p>
        <Button onClick={() => setOpen({ template: null })}>新建模板</Button>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead className="w-28">格式</TableHead>
              <TableHead className="w-48">使用情况</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.map((t) => (
              <TableRow key={t.id} className="h-10 even:bg-zebra">
                <TableCell className="font-medium">
                  {t.name}
                  {t.builtin && (
                    <Badge variant="secondary" className="ml-2">
                      预置
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{TEMPLATE_FORMAT_LABELS[t.format]}</TableCell>
                <TableCell className="text-[13px] text-muted-foreground">
                  规则 {t.usage.rules} · 定时推送 {t.usage.schedules}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  <Button variant="ghost" size="sm" onClick={() => setOpen({ template: t })}>
                    修改
                  </Button>
                  {!t.builtin && t.usage.rules + t.usage.schedules === 0 && (
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm">
                          删除
                        </Button>
                      }
                      title={`删除模板「${t.name}」？`}
                      description="删除后不能恢复。"
                      confirmLabel="确认删除"
                      destructive
                      onConfirm={() => remove.mutate(t.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {open && <TemplateDialog key={open.template?.id ?? 'new'} org={org} template={open.template} onClose={() => setOpen(null)} />}
    </section>
  );
}
```

- [ ] **Step 4: 运行端到端测试确认通过**

Run: `pnpm --filter @flower/web e2e notify-channels.spec.ts && pnpm --filter @flower/web e2e settings.spec.ts layout.spec.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS（`settings.spec.ts`、`layout.spec.ts` 覆盖设置导航，确认新增的「推送」导航项不影响原有用例；如原有用例按数量断言导航项，在本任务里同步改好，不削弱断言）。

- [ ] **Step 5: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/settings/notifications" apps/web/playwright.config.ts apps/web/e2e/notify-channels.spec.ts
git commit -m "feat(web): 组织设置「推送」：通道的登记、测试消息、修改与停用，消息模板

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: 页面：定时推送（组织设置与产品设置）与事件规则（产品设置「推送」页签）

**Files:**
- Create: `apps/web/src/components/check-group.tsx`
- Create: `apps/web/src/app/(app)/[org]/settings/notifications/schedule-list.tsx`、`schedule-dialog.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/notifications/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/settings/products/[productId]/notifications-tab.tsx`、`rule-dialog.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`
- Modify: `apps/web/e2e/helpers.ts`（`tick`、`createWecomChannel`）
- Test: `apps/web/e2e/notify-rules-schedules.spec.ts`

**Interfaces:**
- Consumes: Task 12 的 `useNotificationSchedules`、`useNotificationRules`、`useProductChannels`、`useMessageTemplates`、`notifyKeys`、`toggle`、`filterSummary`、`scheduleState`、`FilterLookups`；现有 `useProducts`、`useFields`、`useNodes`、`useProductWorkflow`、`nodeOptions`、`formatDateTime`
- Produces:
  - `CheckGroup({ legend, options: Array<{ value; label; indent? }>, value: string[], onChange })`（每个选项的无障碍名称为「{legend}：{label}」）
  - `ScheduleList({ org, productId? })`、`ScheduleDialog({ org, productId?, schedule, onClose })`、`NotificationsTab({ org, productId })`、`RuleDialog({ org, productId, rule, onClose })`
  - e2e：`tick(request, now?): Promise<{ orgs; schedulesRun; sent; failed; dead; rateLimited }>`、`createWecomChannel(request, name, url, extra?): Promise<string>`

- [ ] **Step 1: e2e 辅助函数与失败的端到端测试**

`apps/web/e2e/helpers.ts` 末尾加：

```ts
/** 驱动一轮后台发送（端到端服务端设置了 FLOWER_NOTIFY_WORKER=off、FLOWER_NOTIFY_TICK_API=1）；now 用来模拟时间。 */
export async function tick(request: APIRequestContext, now?: Date): Promise<{ orgs: number; schedulesRun: number; sent: number; failed: number; dead: number; rateLimited: number }> {
  return (await json<{ summary: { orgs: number; schedulesRun: number; sent: number; failed: number; dead: number; rateLimited: number } }>(
    request.post('/api/v1/instance/notifications/tick', { data: now ? { now: now.toISOString() } : {} }),
  )).summary;
}

/** 登记企微通道（地址为本机假接收端），返回通道 id。 */
export async function createWecomChannel(request: APIRequestContext, name: string, url: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await json<{ channel: { id: string } }>(request.post('/api/v1/orgs/acme/notification-channels', { data: { kind: 'wecom_robot', name, config: { url }, ...extra } }))).channel.id;
}
```

新建 `apps/web/e2e/notify-rules-schedules.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { startFakeWebhook } from '../test/fake-webhook';
import { resetDatabase } from './db';
import { createProduct, createRequirement, createWecomChannel, expectNoPageOverflow, login, ok, OWNER, setupInstance, tick } from './helpers';

let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
test.beforeAll(async () => {
  hook = await startFakeWebhook();
});
test.afterAll(async () => {
  await hook.close();
});

test('产品设置「推送」：新建即时规则；新建需求后驱动发送，假接收端收到 markdown', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  await createWecomChannel(request, '研发群', hook.url('rules-0001'));
  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '推送' }).click();
  await expect(page.getByText('还没有事件规则')).toBeVisible();
  await page.getByRole('button', { name: '新建规则' }).click();
  await page.getByLabel('规则名称').fill('新需求提醒');
  await page.getByRole('checkbox', { name: '事件：新建需求' }).click();
  await page.getByRole('checkbox', { name: '通道：研发群' }).click();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('row', { name: /新需求提醒/ })).toContainText('研发群');

  const req = await createRequirement(request, productId, '端到端需求');
  const before = hook.received.length;
  expect((await tick(request)).sent).toBe(1);
  expect(hook.received.length).toBe(before + 1);
  const msg = hook.received.at(-1)!.body as { msgtype: string; markdown: { content: string } };
  expect(msg.msgtype).toBe('markdown');
  expect(msg.markdown.content).toContain(`${req.displayKey} 端到端需求`);
});

test('定时推送：产品设置里新建「新需求」并立即执行；组织设置里立即执行概览卡片', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '研发群', hook.url('schedules-0001'));
  await createRequirement(request, productId, '今天的新需求');
  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '推送' }).click();
  await page.getByRole('button', { name: '新建定时推送' }).click();
  await page.getByLabel('名称', { exact: true }).fill('每日新需求');
  await page.getByLabel('内容来源').click();
  await page.getByRole('option', { name: '新需求' }).click();
  await page.getByLabel('定时规则').fill('30 9 * * *');
  await page.getByRole('checkbox', { name: '通道：研发群' }).click();
  await page.getByRole('button', { name: '保存' }).click();
  const row = page.getByRole('row', { name: /每日新需求/ });
  await expect(row).toContainText('30 9 * * *');
  await row.getByRole('button', { name: '立即执行' }).click();
  await page.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.getByText('已生成 1 条待发记录，几秒内发送')).toBeVisible();
  await tick(request);
  const md = hook.received.at(-1)!.body as { markdown: { content: string } };
  expect(md.markdown.content).toMatch(/^# 📋 \d{1,2}\/\d{1,2} 新增需求/);
  expect(md.markdown.content).toContain('今天的新需求');

  await ok(request.post('/api/v1/orgs/acme/notification-schedules', { data: { productId, name: '研发日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId] } }));
  await page.goto('/acme/settings/notifications?tab=schedules');
  const daily = page.getByRole('row', { name: /研发日报/ });
  await expect(daily).toContainText('网盘');
  await daily.getByRole('button', { name: '立即执行' }).click();
  await page.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.getByText('已生成 1 条待发记录，几秒内发送')).toBeVisible();
  await tick(request);
  expect(hook.received.at(-1)!.body).toMatchObject({ msgtype: 'template_card', template_card: { card_type: 'text_notice' } });
});

test('产品「推送」页签与组织「定时推送」页签在 1440 与 760 宽度下不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '一个名字比较长的研发群机器人', hook.url('layout-0002'));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/notification-rules`, { data: { name: '需求状态变化提醒', eventTypes: ['requirement.state_changed', 'requirement.created'], channelIds: [channelId] } }));
  await ok(request.post('/api/v1/orgs/acme/notification-schedules', { data: { productId, name: '工作日研发日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId] } }));
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/settings/products/${productId}`);
    await page.getByRole('tab', { name: '推送' }).click();
    await expect(page.getByRole('row', { name: /需求状态变化提醒/ })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto('/acme/settings/notifications?tab=schedules');
    await expect(page.getByRole('row', { name: /工作日研发日报/ })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});
```

Run: `pnpm --filter @flower/web e2e notify-rules-schedules.spec.ts`
Expected: FAIL（没有「推送」页签）。

- [ ] **Step 2: 共用的多选组**

新建 `apps/web/src/components/check-group.tsx`：

```tsx
'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { toggle } from '@/features/notifications/model';

/** 一组复选框；每个选项的无障碍名称为「{legend}：{label}」。indent 为缩进层级（结构树节点）。 */
export function CheckGroup({
  legend,
  hint,
  options,
  value,
  onChange,
}: {
  legend: string;
  hint?: string;
  options: Array<{ value: string; label: string; indent?: number }>;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1.5 text-[13px]" style={o.indent ? { paddingLeft: o.indent * 12 } : undefined}>
            <Checkbox aria-label={`${legend}：${o.label}`} checked={value.includes(o.value)} onCheckedChange={() => onChange(toggle(value, o.value))} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
```

- [ ] **Step 3: 定时推送列表与对话框**

新建 `apps/web/src/app/(app)/[org]/settings/notifications/schedule-dialog.tsx`：

```tsx
'use client';

import { SCHEDULE_SOURCE_LABELS, SCHEDULE_SOURCES, type ScheduleSource } from '@flower/core/notifications';
import { useState } from 'react';
import { CheckGroup } from '@/components/check-group';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useFields, useMessageTemplates, useProductChannels, useProducts } from '@/lib/queries';
import type { NotificationSchedule } from '@/lib/types';

const DEFAULT_TEMPLATE = 'default';
type SourceConfig = { titlePrefix?: string; emptyBehavior?: 'skip' | 'notice'; onlineSourceKeys?: string[] };

/** 新建或修改定时推送。fixedProductId 给定时（产品设置页）不能选产品。初值只在挂载时读取。 */
export function ScheduleDialog({ org, productId: fixedProductId, schedule, onClose }: { org: string; productId?: string; schedule: NotificationSchedule | null; onClose: () => void }) {
  const products = useProducts(org);
  const templates = useMessageTemplates(org);
  const cfg = (schedule?.sourceConfig ?? {}) as SourceConfig;
  const [productId, setProductId] = useState(schedule?.productId ?? fixedProductId ?? '');
  const [name, setName] = useState(schedule?.name ?? '');
  const [source, setSource] = useState<ScheduleSource>(schedule?.source ?? 'overview_card');
  const [cron, setCron] = useState(schedule?.cron ?? '0 19 * * 1-5');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? 'Asia/Shanghai');
  const [channelIds, setChannelIds] = useState<string[]>(schedule?.channelIds ?? []);
  const [templateId, setTemplateId] = useState(schedule?.templateId ?? DEFAULT_TEMPLATE);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [failThreshold, setFailThreshold] = useState(String(schedule?.failThreshold ?? 1));
  const [titlePrefix, setTitlePrefix] = useState(cfg.titlePrefix ?? '');
  const [emptyBehavior, setEmptyBehavior] = useState<'skip' | 'notice'>(cfg.emptyBehavior ?? 'skip');
  const [onlineKeys, setOnlineKeys] = useState<string[]>(cfg.onlineSourceKeys ?? []);
  const channels = useProductChannels(org, productId);
  const fields = useFields(org, productId || undefined, source === 'new_requirements' && !!productId);
  const sourceOptions = fields.data?.find((f) => f.key === 'source')?.options ?? [];
  // 本产品可用的通道，加上当前已选、但已停用的通道（迁移来的定时推送）
  const options = [...(channels.data ?? []), ...(schedule?.channels ?? []).filter((c) => !(channels.data ?? []).some((x) => x.id === c.id))];
  const sourceConfig =
    source === 'overview_card' ? (titlePrefix.trim() ? { titlePrefix: titlePrefix.trim() } : {}) : source === 'new_requirements' ? { emptyBehavior, onlineSourceKeys: onlineKeys } : {};
  // 通道没有改动时不提交，已停用的通道不妨碍修改其他字段
  const channelsChanged = !schedule || [...channelIds].sort().join() !== [...schedule.channelIds].sort().join();
  const body = {
    name,
    cron,
    timezone,
    sourceConfig,
    templateId: templateId === DEFAULT_TEMPLATE ? null : templateId,
    enabled,
    failThreshold: Number(failThreshold),
    ...(channelsChanged ? { channelIds } : {}),
  };
  const save = useApiMutation(
    () =>
      schedule
        ? api(`/orgs/${org}/notification-schedules/${schedule.id}`, { method: 'PATCH', body })
        : api(`/orgs/${org}/notification-schedules`, { method: 'POST', body: { ...body, productId, source, channelIds } }),
    { invalidate: [notifyKeys(org)], success: '定时推送已保存', silentError: true, onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{schedule ? `修改定时推送「${schedule.name}」` : '新建定时推送'}</DialogTitle>
            <DialogDescription>到点后按内容来源生成消息，用模板渲染后发到所选通道。</DialogDescription>
          </DialogHeader>
          {!schedule && !fixedProductId && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-product">产品</Label>
              <Select
                value={productId}
                onValueChange={(v) => {
                  setProductId(v);
                  setChannelIds([]);
                }}
              >
                <SelectTrigger id="sc-product">
                  <SelectValue placeholder="选择产品" />
                </SelectTrigger>
                <SelectContent>
                  {(products.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-name">名称</Label>
              <Input id="sc-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-source">内容来源</Label>
              <Select value={source} onValueChange={(v) => setSource(v as ScheduleSource)} disabled={!!schedule}>
                <SelectTrigger id="sc-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SCHEDULE_SOURCE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-cron">定时规则</Label>
              <Input id="sc-cron" required className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} />
              <span className="text-xs text-muted-foreground">5 段：分 时 日 月 周。0 19 * * 1-5 为工作日 19:00</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-tz">时区</Label>
              <Input id="sc-tz" required className="font-mono" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
          </div>
          {productId ? (
            <CheckGroup
              legend="通道"
              hint="只列出本产品可用、且已启用的通道"
              options={options.map((c) => ({ value: c.id, label: c.enabled ? c.name : `${c.name}（已停用）` }))}
              value={channelIds}
              onChange={setChannelIds}
            />
          ) : (
            <p className="text-[13px] text-muted-foreground">先选择产品，再选择通道。</p>
          )}
          {source === 'overview_card' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-title">卡片标题前缀</Label>
              <Input id="sc-title" placeholder="默认为「产品名 研发日报」" value={titlePrefix} onChange={(e) => setTitlePrefix(e.target.value)} />
            </div>
          )}
          {source === 'new_requirements' && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sc-empty">没有新需求时</Label>
                <Select value={emptyBehavior} onValueChange={(v) => setEmptyBehavior(v as 'skip' | 'notice')}>
                  <SelectTrigger id="sc-empty">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">不发送</SelectItem>
                    <SelectItem value="notice">发送「没有新需求」</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <CheckGroup
                legend="线上转需求的来源"
                hint="「来源」字段为这些选项的需求单独列为「线上转需求」"
                options={sourceOptions.map((o) => ({ value: o.key, label: o.label }))}
                value={onlineKeys}
                onChange={setOnlineKeys}
              />
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-template">模板</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="sc-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_TEMPLATE}>默认模板</SelectItem>
                  {(templates.data ?? [])
                    .filter((t) => !t.builtin)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-threshold">连续失败几次告警</Label>
              <Input id="sc-threshold" type="number" min={1} max={10} required value={failThreshold} onChange={(e) => setFailThreshold(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox aria-label="启用" checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
            启用
          </label>
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

新建 `apps/web/src/app/(app)/[org]/settings/notifications/schedule-list.tsx`：

```tsx
'use client';

import { SCHEDULE_SOURCE_LABELS } from '@flower/core/notifications';
import { CalendarClock } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { scheduleState } from '@/features/notifications/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useNotificationSchedules } from '@/lib/queries';
import type { NotificationSchedule, RunResult } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ScheduleDialog } from './schedule-dialog';

const STATE_LABEL = { alert: '告警', disabled: '已停用', normal: '正常' } as const;

/** 定时推送列表：给了 productId 只列本产品（产品设置页），否则列出全部并显示产品列（组织设置页）。 */
export function ScheduleList({ org, productId }: { org: string; productId?: string }) {
  const q = useNotificationSchedules(org, productId);
  const [open, setOpen] = useState<{ schedule: NotificationSchedule | null } | null>(null);
  const run = useApiMutation((id: string) => api<{ result: RunResult }>(`/orgs/${org}/notification-schedules/${id}/run`, { method: 'POST' }), {
    invalidate: [notifyKeys(org)],
    onSuccess: ({ result }) => {
      if (result.skipped) toast.info(`没有生成消息：${result.skipped}`);
      else toast.success(`已生成 ${result.deliveries} 条待发记录，几秒内发送`);
    },
  });
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/notification-schedules/${id}`, { method: 'DELETE' }), { invalidate: [notifyKeys(org)], success: '定时推送已删除' });
  if (q.isError) return <LoadError message="加载定时推送失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">到点后生成内容并发到所选通道；连续失败达到阈值时标红告警。</p>
        <Button onClick={() => setOpen({ schedule: null })}>新建定时推送</Button>
      </div>
      {q.data.length === 0 ? (
        <EmptyState icon={CalendarClock} title="还没有定时推送" description="例如工作日 19:00 推送概览卡片，每天 9:30 推送新需求。" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                {!productId && <TableHead>产品</TableHead>}
                <TableHead>内容</TableHead>
                <TableHead>定时</TableHead>
                <TableHead>下次执行</TableHead>
                <TableHead>通道</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="w-52" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((s) => {
                const state = scheduleState(s);
                return (
                  <TableRow key={s.id} className={cn('h-10 even:bg-zebra', state === 'alert' && 'bg-destructive/5 even:bg-destructive/5')}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    {!productId && <TableCell>{s.product?.name ?? '—'}</TableCell>}
                    <TableCell>{SCHEDULE_SOURCE_LABELS[s.source]}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {s.cron}
                      <span className="ml-1 text-muted-foreground">{s.timezone}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{s.nextRunAt ? formatDateTime(s.nextRunAt) : '—'}</TableCell>
                    <TableCell className="text-[13px]">{s.channels.map((c) => (c.enabled ? c.name : `${c.name}（已停用）`)).join('、') || '—'}</TableCell>
                    <TableCell className={cn('text-[13px]', state === 'alert' && 'font-medium text-destructive')} title={s.lastError ?? undefined}>
                      {STATE_LABEL[state]}
                      {state === 'alert' && ` · 连续失败 ${s.consecutiveFailures} 次`}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <ConfirmAction
                        trigger={
                          <Button variant="ghost" size="sm" disabled={run.isPending}>
                            立即执行
                          </Button>
                        }
                        title={`立即执行「${s.name}」？`}
                        description="会生成内容并向所选通道真实发送，结果见发送记录。"
                        confirmLabel="执行"
                        onConfirm={() => run.mutate(s.id)}
                      />
                      <Button variant="ghost" size="sm" onClick={() => setOpen({ schedule: s })}>
                        修改
                      </Button>
                      <ConfirmAction
                        trigger={
                          <Button variant="ghost" size="sm">
                            删除
                          </Button>
                        }
                        title={`删除定时推送「${s.name}」？`}
                        description="已有发送记录或被摘要规则使用的定时推送只能停用。"
                        confirmLabel="确认删除"
                        destructive
                        onConfirm={() => remove.mutate(s.id)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {open && <ScheduleDialog key={open.schedule?.id ?? 'new'} org={org} productId={productId} schedule={open.schedule} onClose={() => setOpen(null)} />}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/notifications/page.tsx`：

1. `import { ChannelsTab } from './channels-tab';` 之后加 `import { ScheduleList } from './schedule-list';`。
2. `const TABS = ['channels', 'templates'];` 改为 `const TABS = ['channels', 'schedules', 'templates'];`。
3. `<TabsTrigger value="channels">通道</TabsTrigger>` 之后加 `<TabsTrigger value="schedules">定时推送</TabsTrigger>`。
4. 通道的 `</TabsContent>` 之后加：

```tsx
        <TabsContent value="schedules">
          <ScheduleList org={org} />
        </TabsContent>
```

- [ ] **Step 4: 产品设置「推送」页签：事件规则与本产品定时推送**

新建 `apps/web/src/app/(app)/[org]/settings/products/[productId]/rule-dialog.tsx`：

```tsx
'use client';

import { CHANGE_DOCUMENT_STATUSES, DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { EVENT_TYPE_LABELS, NOTIFIABLE_EVENT_TYPES, RULE_MODE_LABELS, RULE_MODES, type RuleMode } from '@flower/core/notifications';
import { useState } from 'react';
import { CheckGroup } from '@/components/check-group';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { nodeOptions } from '@/features/structure/model';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useFields, useMessageTemplates, useNodes, useNotificationSchedules, useProductChannels, useProductWorkflow } from '@/lib/queries';
import type { NotificationRule } from '@/lib/types';

const DEFAULT_TEMPLATE = 'default';
const NONE = 'none';

/** 新建或修改事件规则。初值只在挂载时读取。 */
export function RuleDialog({ org, productId, rule, onClose }: { org: string; productId: string; rule: NotificationRule | null; onClose: () => void }) {
  const channels = useProductChannels(org, productId);
  const schedules = useNotificationSchedules(org, productId);
  const templates = useMessageTemplates(org);
  const workflow = useProductWorkflow(org, productId);
  const fields = useFields(org, productId);
  const nodes = useNodes(org, productId);
  const [name, setName] = useState(rule?.name ?? '');
  const [eventTypes, setEventTypes] = useState<string[]>(rule?.eventTypes ?? []);
  const [mode, setMode] = useState<RuleMode>(rule?.mode ?? 'immediate');
  const [channelIds, setChannelIds] = useState<string[]>(rule?.channelIds ?? []);
  const [digestScheduleId, setDigestScheduleId] = useState(rule?.digestScheduleId ?? NONE);
  const [templateId, setTemplateId] = useState(rule?.templateId ?? DEFAULT_TEMPLATE);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [states, setStates] = useState<string[]>(rule?.filter.states ?? []);
  const [priorities, setPriorities] = useState<string[]>(rule?.filter.priorities ?? []);
  const [nodeIds, setNodeIds] = useState<string[]>(rule?.filter.nodeIds ?? []);
  const [documentStatuses, setDocumentStatuses] = useState<string[]>(rule?.filter.documentStatuses ?? []);
  const [fieldKeys, setFieldKeys] = useState<string[]>(rule?.filter.fields ?? []);
  const channelOptions = [...(channels.data ?? []), ...(rule?.channels ?? []).filter((c) => !(channels.data ?? []).some((x) => x.id === c.id))];
  const digests = (schedules.data ?? []).filter((s) => s.source === 'digest');
  const priorityField = fields.data?.find((f) => f.key === 'priority');
  // 推送方式与通道都没改时不提交通道，已停用的通道不妨碍修改其他字段
  const targetChanged = !rule || mode !== rule.mode || digestScheduleId !== (rule.digestScheduleId ?? NONE) || [...channelIds].sort().join() !== [...rule.channelIds].sort().join();
  const body = {
    name,
    eventTypes,
    filter: { states, priorities, nodeIds, documentStatuses, fields: fieldKeys },
    templateId: templateId === DEFAULT_TEMPLATE ? null : templateId,
    enabled,
    ...(targetChanged ? { mode, channelIds: mode === 'immediate' ? channelIds : [], digestScheduleId: mode === 'digest' && digestScheduleId !== NONE ? digestScheduleId : null } : {}),
  };
  const save = useApiMutation(
    () =>
      rule
        ? api(`/orgs/${org}/notification-rules/${rule.id}`, { method: 'PATCH', body })
        : api(`/orgs/${org}/products/${productId}/notification-rules`, { method: 'POST', body }),
    { invalidate: [notifyKeys(org)], success: '规则已保存', silentError: true, onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{rule ? `修改规则「${rule.name}」` : '新建规则'}</DialogTitle>
            <DialogDescription>本产品发生所选事件且满足条件时推送：即时推送到通道，或合并进变更摘要定时发送。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-name">规则名称</Label>
            <Input id="rule-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <CheckGroup legend="事件" options={NOTIFIABLE_EVENT_TYPES.map((t) => ({ value: t, label: EVENT_TYPE_LABELS[t] }))} value={eventTypes} onChange={setEventTypes} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-mode">推送方式</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as RuleMode)}>
                <SelectTrigger id="rule-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULE_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {RULE_MODE_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-template">模板</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="rule-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_TEMPLATE}>默认模板</SelectItem>
                  {(templates.data ?? [])
                    .filter((t) => !t.builtin)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {mode === 'immediate' ? (
            <CheckGroup
              legend="通道"
              hint="只列出本产品可用、且已启用的通道"
              options={channelOptions.map((c) => ({ value: c.id, label: c.enabled ? c.name : `${c.name}（已停用）` }))}
              value={channelIds}
              onChange={setChannelIds}
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-digest">摘要定时推送</Label>
              <Select value={digestScheduleId} onValueChange={setDigestScheduleId}>
                <SelectTrigger id="rule-digest">
                  <SelectValue placeholder="选择内容来源为「变更摘要」的定时推送" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>未选择</SelectItem>
                  {digests.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <p className="text-sm font-medium">过滤条件（可选）</p>
            <p className="text-xs text-muted-foreground">条件之间为「且」，同一条件内多选为「或」；不适用于所选事件的条件不生效。</p>
            <CheckGroup legend="需求状态" options={(workflow.data?.version.body.states ?? []).map((s) => ({ value: s.key, label: s.label }))} value={states} onChange={setStates} />
            <CheckGroup legend="优先级" options={(priorityField?.options ?? []).map((o) => ({ value: o.key, label: o.label }))} value={priorities} onChange={setPriorities} />
            <CheckGroup
              legend="结构树节点"
              hint="含下级节点"
              options={nodeOptions(nodes.data ?? [], null).map((n) => ({ value: n.id, label: n.name, indent: n.depth - 1 }))}
              value={nodeIds}
              onChange={setNodeIds}
            />
            <CheckGroup legend="PRD 状态" options={CHANGE_DOCUMENT_STATUSES.map((s) => ({ value: s, label: DOCUMENT_STATUS_LABELS[s] }))} value={documentStatuses} onChange={setDocumentStatuses} />
            <CheckGroup legend="变化的字段" options={(fields.data ?? []).map((f) => ({ value: f.key, label: f.label }))} value={fieldKeys} onChange={setFieldKeys} />
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox aria-label="启用" checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
            启用
          </label>
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

新建 `apps/web/src/app/(app)/[org]/settings/products/[productId]/notifications-tab.tsx`：

```tsx
'use client';

import { EVENT_TYPE_LABELS, type NotifiableEventType } from '@flower/core/notifications';
import { BellRing } from 'lucide-react';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type FilterLookups, filterSummary } from '@/features/notifications/model';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useFields, useNodes, useNotificationRules, useProductWorkflow } from '@/lib/queries';
import type { NotificationRule } from '@/lib/types';
import { ScheduleList } from '../../notifications/schedule-list';
import { RuleDialog } from './rule-dialog';

function RuleList({ org, productId }: { org: string; productId: string }) {
  const q = useNotificationRules(org, productId);
  const workflow = useProductWorkflow(org, productId);
  const fields = useFields(org, productId);
  const nodes = useNodes(org, productId);
  const [open, setOpen] = useState<{ rule: NotificationRule | null } | null>(null);
  const toggleEnabled = useApiMutation(
    (v: { id: string; enabled: boolean }) => api(`/orgs/${org}/notification-rules/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }),
    { invalidate: [notifyKeys(org)], success: '已保存' },
  );
  const remove = useApiMutation((id: string) => api(`/orgs/${org}/notification-rules/${id}`, { method: 'DELETE' }), { invalidate: [notifyKeys(org)], success: '规则已删除' });
  const lookups: FilterLookups = {
    states: new Map((workflow.data?.version.body.states ?? []).map((s) => [s.key, s.label])),
    priorities: new Map((fields.data?.find((f) => f.key === 'priority')?.options ?? []).map((o) => [o.key, o.label])),
    nodes: new Map((nodes.data ?? []).map((n) => [n.id, n.name])),
    fields: new Map((fields.data ?? []).map((f) => [f.key, f.label])),
  };
  if (q.isError) return <LoadError message="加载事件规则失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">事件规则</h2>
        <Button onClick={() => setOpen({ rule: null })}>新建规则</Button>
      </div>
      {q.data.length === 0 ? (
        <EmptyState icon={BellRing} title="还没有事件规则" description="例如：新建需求时推送到产品群；需求状态变化合并进每天的变更摘要。" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>事件</TableHead>
                <TableHead>条件</TableHead>
                <TableHead>推送到</TableHead>
                <TableHead className="w-16">启用</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((r) => (
                <TableRow key={r.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-[13px]">{r.eventTypes.map((t: NotifiableEventType) => EVENT_TYPE_LABELS[t]).join('、')}</TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">{filterSummary(r.filter, lookups)}</TableCell>
                  <TableCell className="text-[13px]">
                    {r.mode === 'digest' ? `变更摘要「${r.digestScheduleName ?? '—'}」` : r.channels.map((c) => (c.enabled ? c.name : `${c.name}（已停用）`)).join('、')}
                  </TableCell>
                  <TableCell>
                    <Switch aria-label={`启用${r.name}`} checked={r.enabled} onCheckedChange={(v) => toggleEnabled.mutate({ id: r.id, enabled: v })} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <Button variant="ghost" size="sm" onClick={() => setOpen({ rule: r })}>
                      修改
                    </Button>
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" size="sm">
                          删除
                        </Button>
                      }
                      title={`删除规则「${r.name}」？`}
                      description="已有发送记录的规则只能停用。"
                      confirmLabel="确认删除"
                      destructive
                      onConfirm={() => remove.mutate(r.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {open && <RuleDialog key={open.rule?.id ?? 'new'} org={org} productId={productId} rule={open.rule} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** 产品设置「推送」页签：本产品的事件规则与定时推送（产品管理员）。 */
export function NotificationsTab({ org, productId }: { org: string; productId: string }) {
  return (
    <div className="flex flex-col gap-8">
      <RuleList org={org} productId={productId} />
      <div className="flex flex-col gap-3">
        <h2 className="font-semibold">定时推送</h2>
        <ScheduleList org={org} productId={productId} />
      </div>
    </div>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`：

1. `import { FieldsTab } from './fields-tab';` 之后加 `import { NotificationsTab } from './notifications-tab';`。
2. `<TabsTrigger value="templates">文档模板</TabsTrigger>` 之后加 `<TabsTrigger value="notifications">推送</TabsTrigger>`。
3. 文档模板的 `</TabsContent>` 之后加：

```tsx
        <TabsContent value="notifications">
          <NotificationsTab org={org} productId={productId} />
        </TabsContent>
```

- [ ] **Step 5: 运行端到端测试确认通过**

Run: `pnpm --filter @flower/web e2e notify-rules-schedules.spec.ts notify-channels.spec.ts product-admin.spec.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS（`product-admin.spec.ts` 覆盖产品设置页签，确认新增页签不影响原有用例）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/check-group.tsx "apps/web/src/app/(app)/[org]/settings/notifications" "apps/web/src/app/(app)/[org]/settings/products/[productId]" apps/web/e2e/helpers.ts apps/web/e2e/notify-rules-schedules.spec.ts
git commit -m "feat(web): 定时推送（组织与产品设置）、事件规则（产品设置「推送」页签）与立即执行

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 15: 页面：发送记录（筛选、告警标红、重发、分页）与失败重试的端到端验证

**Files:**
- Create: `apps/web/src/app/(app)/[org]/settings/notifications/deliveries-tab.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/notifications/page.tsx`
- Test: `apps/web/e2e/notify-deliveries.spec.ts`

**Interfaces:**
- Consumes: Task 12 的 `useNotificationDeliveries`、`useNotificationChannels`、`parseDeliveryFilter`、`deliveryUrlQuery`、`deliveryApiQuery`、`DELIVERY_STATUS_TONE`、`notifyKeys`；Task 14 的 e2e `tick`、`createWecomChannel`
- Produces: `DeliveriesTab({ org })`；页面 `?tab=deliveries`，筛选写在地址栏（`channel`、`kind`、`status`、`from`、`to`、`before`）

- [ ] **Step 1: 写失败的端到端测试**

新建 `apps/web/e2e/notify-deliveries.spec.ts`：

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
test.beforeEach(() => {
  hook.reply(200, { errcode: 0, errmsg: 'ok' });
});

test('失败后显示「失败待重试」与响应；到时间后重试成功；重发；按状态筛选', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '研发群', hook.url('deliveries-0001'));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/notification-rules`, { data: { name: '新需求提醒', eventTypes: ['requirement.created'], channelIds: [channelId] } }));
  hook.reply(200, { errcode: 93000, errmsg: 'invalid webhook url' });
  const req = await createRequirement(request, productId, '重试的需求');
  expect((await tick(request)).failed).toBe(1);

  await page.goto('/acme/settings/notifications?tab=deliveries');
  const row = page.getByRole('row', { name: /新需求提醒/ });
  await expect(row).toContainText('失败待重试');
  await expect(row).toContainText('93000');

  hook.reply(200, { errcode: 0, errmsg: 'ok' });
  expect((await tick(request, new Date(Date.now() + 31_000))).sent).toBe(1);
  await page.reload();
  await expect(row).toContainText('已发送');
  expect(JSON.stringify(hook.received.at(-1)!.body)).toContain(req.displayKey);

  await row.getByRole('button', { name: '重发' }).click();
  await expect(page.getByText('已加入发送队列')).toBeVisible();
  await expect(page.getByRole('row', { name: /新需求提醒/ })).toHaveCount(2);

  await page.getByRole('combobox', { name: '按状态筛选' }).click();
  await page.getByRole('option', { name: '待发送' }).click();
  await expect(page).toHaveURL(/status=pending/);
  await expect(page.getByRole('row', { name: /新需求提醒/ })).toHaveCount(1);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByRole('row', { name: /新需求提醒/ })).toHaveCount(2);
});

test('定时推送五次都失败：记录「已放弃」，所属定时推送告警并在两处标红', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '研发群', hook.url('alert-0001'));
  // 停用状态下只能手动执行，避免模拟时间时被当成到点
  const { schedule } = await json<{ schedule: { id: string } }>(
    request.post('/api/v1/orgs/acme/notification-schedules', { data: { productId, name: '研发日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId], enabled: false } }),
  );
  await ok(request.post(`/api/v1/orgs/acme/notification-schedules/${schedule.id}/run`));
  hook.reply(500, { message: 'down' });
  const t0 = Date.now();
  for (const seconds of [0, 31, 152, 753, 4354]) await tick(request, new Date(t0 + seconds * 1000));

  await page.goto('/acme/settings/notifications?tab=deliveries');
  const row = page.getByRole('row', { name: /研发日报/ });
  await expect(row).toContainText('已放弃');
  await expect(row).toContainText('告警');
  await expect(row).toContainText('HTTP 500');
  await page.goto('/acme/settings/notifications?tab=schedules');
  await expect(page.getByRole('row', { name: /研发日报/ })).toContainText('告警 · 连续失败 1 次');
});

test('发送记录页在 1440 与 760 宽度下不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const channelId = await createWecomChannel(request, '一个名字比较长的研发群机器人', hook.url('layout-0003'));
  await ok(request.post(`/api/v1/orgs/acme/notification-channels/${channelId}/test`));
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/settings/notifications?tab=deliveries');
    await expect(page.getByRole('row', { name: /测试消息/ })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});
```

Run: `pnpm --filter @flower/web e2e notify-deliveries.spec.ts`
Expected: FAIL（没有「发送记录」页签）。

- [ ] **Step 2: 实现发送记录页签**

新建 `apps/web/src/app/(app)/[org]/settings/notifications/deliveries-tab.tsx`：

```tsx
'use client';

import { DELIVERY_KIND_LABELS, DELIVERY_KINDS, DELIVERY_STATUS_LABELS, DELIVERY_STATUSES } from '@flower/core/notifications';
import { Inbox } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DELIVERY_STATUS_TONE, type DeliveryFilter, deliveryApiQuery, deliveryUrlQuery, parseDeliveryFilter } from '@/features/notifications/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { notifyKeys, useApiMutation, useNotificationChannels, useNotificationDeliveries } from '@/lib/queries';
import { cn } from '@/lib/utils';

const ALL = 'all';

export function DeliveriesTab({ org }: { org: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const filter = parseDeliveryFilter(useSearchParams());
  const [offset] = useState(() => new Date().getTimezoneOffset());
  const q = useNotificationDeliveries(org, deliveryApiQuery(filter, offset));
  const channels = useNotificationChannels(org);
  const resend = useApiMutation((id: string) => api(`/orgs/${org}/notification-deliveries/${id}/resend`, { method: 'POST' }), {
    invalidate: [notifyKeys(org)],
    success: '已加入发送队列',
  });
  /** 改筛选回到第一页；筛选与页签都写在地址栏。 */
  const update = (patch: Partial<DeliveryFilter>) => {
    const qs = deliveryUrlQuery({ ...filter, before: '', ...patch });
    router.replace(`${pathname}?tab=deliveries${qs ? `&${qs}` : ''}`);
  };
  const filtered = !!(filter.channel || filter.kind || filter.status || filter.from || filter.to);
  if (q.isError) return <LoadError message="加载发送记录失败，请重试。" onRetry={() => q.refetch()} />;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter.channel || ALL} onValueChange={(v) => update({ channel: v === ALL ? '' : v })}>
          <SelectTrigger className="w-40" aria-label="按通道筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部通道</SelectItem>
            {(channels.data ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.kind || ALL} onValueChange={(v) => update({ kind: v === ALL ? '' : (v as DeliveryFilter['kind']) })}>
          <SelectTrigger className="w-32" aria-label="按来源筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部来源</SelectItem>
            {DELIVERY_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {DELIVERY_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.status || ALL} onValueChange={(v) => update({ status: v === ALL ? '' : (v as DeliveryFilter['status']) })}>
          <SelectTrigger className="w-32" aria-label="按状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {DELIVERY_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {DELIVERY_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" aria-label="起始日期" className="w-40" value={filter.from} onChange={(e) => update({ from: e.target.value })} />
        <span className="text-[13px] text-muted-foreground">至</span>
        <Input type="date" aria-label="结束日期" className="w-40" value={filter.to} onChange={(e) => update({ to: e.target.value })} />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => router.replace(`${pathname}?tab=deliveries`)}>
            清除筛选
          </Button>
        )}
      </div>
      {!q.data ? null : q.data.deliveries.length === 0 ? (
        <EmptyState icon={Inbox} title={filtered ? '没有符合条件的发送记录' : '还没有发送记录'} description="测试消息、事件规则与定时推送的每一次发送都会记在这里。" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">时间</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>通道</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-12">次数</TableHead>
                <TableHead className="w-36">下次重试</TableHead>
                <TableHead>内容</TableHead>
                <TableHead>响应</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.deliveries.map((d) => (
                <TableRow key={d.id} className={cn('h-10 even:bg-zebra', d.source.alert && 'bg-destructive/5 even:bg-destructive/5')}>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{formatDateTime(d.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-[13px]">
                    {DELIVERY_KIND_LABELS[d.kind]}
                    {d.source.name && <span className="ml-1 font-medium">{d.source.name}</span>}
                    {d.source.alert && <span className="ml-1 text-xs font-medium text-destructive">告警</span>}
                    {d.legacy && <span className="ml-1 text-xs text-muted-foreground">迁移</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-[13px]">{d.channel.name}</TableCell>
                  <TableCell className={cn('whitespace-nowrap text-[13px]', DELIVERY_STATUS_TONE[d.status])}>{DELIVERY_STATUS_LABELS[d.status]}</TableCell>
                  <TableCell className="font-mono text-xs">{d.attempts}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{d.status === 'failed' && d.nextAttemptAt ? formatDateTime(d.nextAttemptAt) : '—'}</TableCell>
                  <TableCell className="max-w-[20rem] truncate text-[13px]" title={d.preview}>
                    {d.preview}
                  </TableCell>
                  <TableCell className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground" title={d.response ?? undefined}>
                    {d.response ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {d.canResend && (
                      <Button variant="ghost" size="sm" disabled={resend.isPending} onClick={() => resend.mutate(d.id)}>
                        重发
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="flex justify-end gap-2">
        {filter.before && (
          <Button variant="outline" size="sm" onClick={() => update({})}>
            回到最新
          </Button>
        )}
        {q.data?.nextCursor && (
          <Button variant="outline" size="sm" onClick={() => update({ before: q.data!.nextCursor! })}>
            下一页
          </Button>
        )}
      </div>
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/notifications/page.tsx`：

1. `import { ChannelsTab } from './channels-tab';` 之后加 `import { DeliveriesTab } from './deliveries-tab';`。
2. `const TABS = ['channels', 'schedules', 'templates'];` 改为 `const TABS = ['channels', 'schedules', 'templates', 'deliveries'];`。
3. `<TabsTrigger value="templates">消息模板</TabsTrigger>` 之后加 `<TabsTrigger value="deliveries">发送记录</TabsTrigger>`。
4. 模板的 `</TabsContent>` 之后加：

```tsx
        <TabsContent value="deliveries">
          <DeliveriesTab org={org} />
        </TabsContent>
```

- [ ] **Step 3: 运行端到端测试确认通过**

Run: `pnpm --filter @flower/web e2e notify-deliveries.spec.ts notify-rules-schedules.spec.ts notify-channels.spec.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/settings/notifications" apps/web/e2e/notify-deliveries.spec.ts
git commit -m "feat(web): 推送发送记录页（筛选、告警标红、重发、分页）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 16: 迁移工具：push 与 123plane 的推送配置（通道一律停用）

**Files:**
- Modify: `packages/migrate/src/legacy-types.ts`、`packages/migrate/src/load.ts`
- Create: `packages/migrate/src/plan-notify.ts`
- Modify: `packages/migrate/src/plan-types.ts`、`packages/migrate/src/plan.ts`、`packages/migrate/src/report.ts`、`packages/migrate/src/write.ts`、`packages/migrate/src/cli.ts`
- Modify: `packages/migrate/test/fixtures.ts`、`packages/migrate/test/sqlite-fixture.ts`
- Test: `packages/migrate/test/plan-notify.test.ts`、`packages/migrate/test/load.test.ts`、`packages/migrate/test/plan-requirements.test.ts`、`packages/migrate/test/report.test.ts`、`packages/migrate/test/write.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseChannelConfig`、`channelConfigHint`、`encryptConfig`、`DEFAULT_RATE_LIMIT`；Task 2 的 `assertCron`；Task 4 的三张表；Task 5 的 `listChannels`（写入测试）
- Produces:
  - `PLANE_NOTIFY_KEYS`、`type PushGroup`、`type PushTask`、`type PushLog`；`PushData` 增加 `groups`、`tasks`、`taskTargets`、`pushLogs`；`PlaneData` 增加 `notifySettings`
  - `ImportOptions.secretKey?: string`；`ImportRows` 增加 `notificationChannels`、`notificationSchedules`、`notificationDeliveries`（`INSERT_ORDER` 末尾）
  - `ReconReport.notifications = { channels: Array<{ source; name; kind; enabled }>; schedules: Array<{ source; name; kind; cron; enabled; channels: number }>; deliveries: number; skipped: Array<{ what; reason }> }`
  - `planeDigestTimes(raw: string | undefined): string[]`、`digestCrons(times: string[]): string[]`、`buildNotifications(ctx: PlanContext): void`
  - 测试辅助 `withPushConfig(data?)`（全部为虚构值）

- [ ] **Step 1: 写失败的测试**

`packages/migrate/test/fixtures.ts`：

1. import 行改为 `import type { LegacyData, PlaneRequirement, PushRequirement } from '../src/legacy-types';`（不变），`makeLegacyData()` 的 `plane` 对象在 `counts: {…}` 之前加 `notifySettings: {},`；`push` 对象在 `counts: {…}` 之前加：

```ts
      groups: [],
      tasks: [],
      taskTargets: [],
      pushLogs: [],
```

2. 文件末尾加：

```ts
/** 推送配置（全部为虚构值）：push 两个群、四个推送计划（一个来源不支持）、三条日志（一条找不到计划）；123plane 两个企微地址、空的摘要时间表、SMTP。 */
export function withPushConfig(data: LegacyData = makeLegacyData()): LegacyData {
  const task = (t: Partial<LegacyData['push']['tasks'][number]> & { id: number; name: string; cron_expr: string; source_type: string }) => ({
    enabled: 1,
    trigger_type: 'cron',
    timezone: 'Asia/Shanghai',
    source_config: '{}',
    format: 'markdown',
    next_run: null,
    last_run: null,
    last_success: null,
    alert_state: null,
    consecutive_failures: 0,
    fail_threshold: 1,
    ...t,
  });
  data.push.groups = [
    { id: 3, name: '产品群', webhook_url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=group-0003', enabled: 1, created_at: '2026-08-01 00:00:00' },
    { id: 4, name: '研发群', webhook_url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=group-0004', enabled: 1, created_at: '2026-08-01 00:00:00' },
  ];
  data.push.tasks = [
    task({ id: 4, name: '晚间日报', cron_expr: '0 19 * * 1-5', source_type: 'overview', format: 'template_card', last_run: '2026-09-28T11:00:01.000Z', last_success: '2026-09-28T11:00:01.000Z' }),
    task({ id: 5, name: '早间日报', cron_expr: '0 10 * * 1-5', source_type: 'overview', format: 'template_card', enabled: 0 }),
    task({ id: 6, name: '每日新需求', cron_expr: '30 9 * * *', source_type: 'newreqs' }),
    task({ id: 7, name: '外部数据', cron_expr: '0 8 * * *', source_type: 'http' }),
  ];
  data.push.taskTargets = [
    { task_id: 4, group_id: 3 },
    { task_id: 4, group_id: 4 },
    { task_id: 6, group_id: 4 },
  ];
  data.push.pushLogs = [
    { id: 300, task_id: 4, group_id: 3, content: '{"title":"示例日报 · 2026-09-28","desc":"0930发版 · 整体 50%","buttons":[]}', status: 'ok', error: null, sent_at: '2026-09-28 11:00:01' },
    { id: 301, task_id: 6, group_id: 4, content: '# 📋 9/28 新增需求', status: 'ok', error: null, sent_at: '2026-09-29 01:30:02' },
    { id: 302, task_id: 99, group_id: 4, content: '找不到计划的日志', status: 'ok', error: null, sent_at: '2026-09-29 01:30:03' },
  ];
  data.push.counts = { ...data.push.counts, groups: 2, tasks: 4, taskTargets: 3, pushLogs: 3 };
  data.plane.notifySettings = {
    wecom_requirement_webhook_url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=plane-req-01',
    wecom_daily_webhook_url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=plane-daily-1',
    wecom_digest_schedule: '[]',
    smtp_host: 'smtp.example.com',
    smtp_port: '465',
    smtp_user: 'robot@example.com',
    smtp_pass: 'demo-smtp-pass',
    email_recipients: 'pm@example.com, dev@example.com',
  };
  return data;
}
```

新建 `packages/migrate/test/plan-notify.test.ts`：

```ts
import { decryptConfig } from '@flower/core';
import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import { digestCrons, planeDigestTimes } from '../src/plan-notify';
import type { ImportOptions } from '../src/plan-types';
import { renderReport } from '../src/report';
import { makeLegacyData, reviewedMapping, withPushConfig } from './fixtures';

const KEY = 'migrate-test-secret-migrate-test-secret-01';
const OPTS: ImportOptions = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null, secretKey: KEY };
const SECRETS = ['group-0003', 'group-0004', 'plane-req-01', 'plane-daily-1', 'demo-smtp-pass'];

describe('推送配置迁移', () => {
  const plan = buildImportPlan(withPushConfig(), reviewedMapping(), OPTS);
  const { notificationChannels: channels, notificationSchedules: schedules, notificationDeliveries: deliveries } = plan.rows;

  it('通道：push 群与 123plane 地址、SMTP，全部停用，配置加密，只留脱敏提示', () => {
    expect(channels.map((c) => [c.name, c.kind, c.groupLabel, c.enabled])).toEqual([
      ['产品群', 'wecom_robot', '产品群', false],
      ['研发群', 'wecom_robot', '研发群', false],
      ['123plane 需求通知', 'wecom_robot', '123plane', false],
      ['123plane 日报', 'wecom_robot', '123plane', false],
      ['123plane 邮件', 'email', '123plane', false],
    ]);
    expect(channels.every((c) => c.config.startsWith('v1:') && c.rateLimitPerMin === (c.kind === 'email' ? 60 : 20))).toBe(true);
    expect(decryptConfig(channels[0]!.config, KEY)).toEqual({ url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=group-0003' });
    expect(channels[0]!.configHint).toBe('…/send?key=****0003');
    expect(decryptConfig(channels[4]!.config, KEY)).toEqual({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'robot@example.com',
      pass: 'demo-smtp-pass',
      from: 'robot@example.com',
      to: ['pm@example.com', 'dev@example.com'],
    });
  });

  it('定时推送：push 计划按来源映射、保留启用与执行记录、不排期；123plane 空摘要时间表为停用的摘要推送', () => {
    expect(schedules.map((s) => [s.name, s.source, s.cron, s.enabled, s.channelIds!.length, s.nextRunAt])).toEqual([
      ['晚间日报', 'overview_card', '0 19 * * 1-5', true, 2, null],
      ['早间日报', 'overview_card', '0 10 * * 1-5', false, 0, null],
      ['每日新需求', 'new_requirements', '30 9 * * *', true, 1, null],
      ['123plane 变更摘要', 'digest', '0 18 * * *', false, 1, null],
    ]);
    expect(schedules[0]!.lastSuccessAt).toEqual(new Date('2026-09-28T11:00:01.000Z'));
    expect(schedules[2]!.sourceConfig).toEqual({ emptyBehavior: 'skip', onlineSourceKeys: ['online_issue'] });
    expect(schedules[3]!.channelIds).toEqual([channels[2]!.id]);
    expect(schedules.every((s) => s.productId === plan.rows.products[0]!.id)).toBe(true);
    expect(plan.report.notifications.skipped).toEqual(
      expect.arrayContaining([
        { what: 'push 推送计划「外部数据」', reason: '不支持的内容来源或触发方式（http / cron）' },
        { what: 'push 推送日志 1 条', reason: '对应的推送计划或群没有迁移' },
      ]),
    );
  });

  it('发送记录：push 日志为已发送的迁移记录，原文存为 legacy', () => {
    expect(deliveries.map((d) => [d.legacyKey, d.status, d.kind, d.attempts])).toEqual([
      ['push_logs:300', 'sent', 'schedule', 1],
      ['push_logs:301', 'sent', 'schedule', 1],
    ]);
    expect(deliveries[0]).toMatchObject({ payload: { type: 'legacy', content: expect.stringContaining('示例日报') }, sentAt: new Date('2026-09-28T11:00:01Z'), createdAt: new Date('2026-09-28T11:00:01Z') });
    expect(plan.report.notifications.deliveries).toBe(2);
  });

  it('同样输入得到同样的 id；报告有「推送」一节，不含网址密钥与密码；不再把推送列为延后迁移', () => {
    const again = buildImportPlan(withPushConfig(), reviewedMapping(), OPTS);
    expect(again.rows.notificationChannels.map((c) => c.id)).toEqual(channels.map((c) => c.id));
    expect(again.rows.notificationSchedules.map((s) => s.id)).toEqual(schedules.map((s) => s.id));
    const md = renderReport(plan.report);
    expect(md).toContain('## 推送（迁移来的通道一律停用）');
    expect(md).toContain('| push | 产品群 | wecom_robot | 否 |');
    for (const s of SECRETS) {
      expect(md).not.toContain(s);
      expect(JSON.stringify(plan.report)).not.toContain(s);
    }
    expect(plan.report.deferred.map((d) => d.what)).not.toEqual(expect.arrayContaining(['push 推送群']));
  });

  it('缺少 FLOWER_SECRET_KEY 时报问题、拒绝写入；没有推送配置时不需要密钥', () => {
    expect(buildImportPlan(withPushConfig(), reviewedMapping(), { ...OPTS, secretKey: undefined }).report.problems).toContain('缺少 FLOWER_SECRET_KEY，无法加密推送通道配置');
    expect(buildImportPlan(makeLegacyData(), reviewedMapping(), { ...OPTS, secretKey: undefined }).report.problems).toEqual([]);
  });

  it('123plane 摘要时间表：没有保存用默认时间；空数组停用；同一分钟合成一条 cron', () => {
    expect(planeDigestTimes(undefined)).toEqual(['09:00', '12:00', '18:00']);
    expect(planeDigestTimes('[]')).toEqual([]);
    expect(planeDigestTimes('不是 JSON')).toEqual(['09:00', '12:00', '18:00']);
    expect(digestCrons(['09:00', '12:00', '18:00'])).toEqual(['0 9,12,18 * * *']);
    expect(digestCrons(['09:00', '12:30'])).toEqual(['0 9 * * *', '30 12 * * *']);
  });
});
```

`packages/migrate/test/sqlite-fixture.ts`：

1. `PLANE_DDL` 不变；`makeSqliteFixtures` 里 123plane 的 `insert into settings values ('smtp_pass','must-not-be-read');` 改为：

```ts
    insert into settings values ('ai_daily_prompt','must-not-be-read'), ('wecom_digest_schedule','[]'), ('smtp_pass','fixture-pass');
```

2. `PUSH_DDL` 里这四行

```
create table groups (id integer);
create table tasks (id integer);
create table task_targets (id integer);
create table push_logs (id integer);
```

改为：

```
create table groups (id integer primary key, name text, webhook_url text, enabled integer, created_at text);
create table tasks (id integer primary key, name text, enabled integer, trigger_type text, cron_expr text, timezone text, source_type text, source_config text, format text, priority integer, next_run text, last_run text, last_success text, alert_state text, consecutive_failures integer, fail_threshold integer, cooldown_sec integer, last_alert_at text, created_at text);
create table task_targets (task_id integer, group_id integer);
create table push_logs (id integer primary key, task_id integer, group_id integer, content text, status text, error text, sent_at text);
```

3. push 的插入里 `insert into push_logs values (1),(2);` 改为：

```ts
    insert into groups values (3, '示例群', 'https://qyapi.example.com/cgi-bin/webhook/send?key=fixture-0003', 1, '2026-08-01 00:00:00');
    insert into tasks (id, name, enabled, trigger_type, cron_expr, timezone, source_type, source_config, format, consecutive_failures, fail_threshold) values (4, '示例日报', 1, 'cron', '0 19 * * 1-5', 'Asia/Shanghai', 'overview', '{}', 'template_card', 0, 1);
    insert into task_targets values (4, 3);
    insert into push_logs (id, task_id, group_id, content, status, sent_at) values (1, 4, 3, '示例', 'ok', '2026-09-28 11:00:01'), (2, 4, 3, '示例', 'ok', '2026-09-28 11:00:02');
```

`packages/migrate/test/load.test.ts`：

1. 第一个用例标题改为 `'读取 123plane 的业务表；settings 只读推送需要的键'`，`expect(plane.counts).toMatchObject({ settings: 1, briefs: 0, notificationQueue: 0 });` 改为：

```ts
    expect(plane.counts).toMatchObject({ settings: 3, briefs: 0, notificationQueue: 0 });
    expect(plane.notifySettings).toEqual({ wecom_digest_schedule: '[]', smtp_pass: 'fixture-pass' });
```

2. 第二个用例 `expect(push.counts).toMatchObject({ pushLogs: 2, groups: 0 });` 改为：

```ts
    expect(push.counts).toMatchObject({ pushLogs: 2, groups: 1 });
    expect(push.groups).toEqual([{ id: 3, name: '示例群', webhook_url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=fixture-0003', enabled: 1, created_at: '2026-08-01 00:00:00' }]);
    expect(push.tasks[0]).toMatchObject({ id: 4, cron_expr: '0 19 * * 1-5', source_type: 'overview', fail_threshold: 1 });
    expect(push.taskTargets).toEqual([{ task_id: 4, group_id: 3 }]);
    expect(push.pushLogs.map((l) => [l.id, l.task_id, l.group_id, l.status, l.sent_at])).toEqual([
      [1, 4, 3, 'ok', '2026-09-28 11:00:01'],
      [2, 4, 3, 'ok', '2026-09-28 11:00:02'],
    ]);
```

`packages/migrate/test/plan-requirements.test.ts` 的「报告补全：settings / taskTargets / reviewObjections」用例：删去期望里的 `{ what: 'push 任务对象（task_targets）', count: 3, phase: 'P3 通知' },` 一行（推送配置已迁移，不再列为延后），其余不变。

`packages/migrate/test/report.test.ts` 第一个用例的标题列表里 `'## 延后迁移'` 之前加 `'## 推送（迁移来的通道一律停用）'`。

`packages/migrate/test/write.test.ts`：

1. `@flower/core` 的 import 列表按字母序加入 `listChannels`、`listSchedules`（第一项已在 Task 4 加入 `notificationChannels` 等表）；`./fixtures` 的 import 加入 `withPushConfig`。
2. 「写入数据库」的 `describe` 末尾加一个用例：

```ts
  it('推送配置：通道停用、配置能用同一个 FLOWER_SECRET_KEY 解开；定时推送没有排期；迁移记录写入', async () => {
    const key = 'migrate-test-secret-migrate-test-secret-01';
    await writeImport(t.adminDb, buildImportPlan(withPushConfig(), reviewedMapping(), { ...opts, secretKey: key }), { replace: true });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    const channels = await listChannels(t.db, actor, { secretKey: key });
    expect(channels.map((c) => [c.name, c.enabled])).toEqual(
      expect.arrayContaining([
        ['产品群', false],
        ['123plane 邮件', false],
      ]),
    );
    expect(channels.find((c) => c.name === '123plane 邮件')!.settings).toMatchObject({ host: 'smtp.example.com', to: ['pm@example.com', 'dev@example.com'] });
    expect(JSON.stringify(channels)).not.toContain('demo-smtp-pass');
    const schedules = await listSchedules(t.db, actor);
    expect(schedules.every((s) => s.nextRunAt === null)).toBe(true);
    expect(await t.adminDb.select().from(notificationDeliveries)).toHaveLength(2);
  });
```

Run: `pnpm --filter @flower/migrate exec vitest run test/plan-notify.test.ts test/load.test.ts`
Expected: FAIL（`../src/plan-notify` 不存在；`notifySettings` 不存在）。

- [ ] **Step 2: 读取旧数据**

`packages/migrate/src/legacy-types.ts`：

1. `PlaneData` 的 `counts: {…};` 之前加一行：

```ts
  /** settings 表里推送需要的键（PLANE_NOTIFY_KEYS），其余键不读。 */
  notifySettings: Partial<Record<PlaneNotifyKey, string>>;
```

2. `PushData` 的 `counts: {…};` 之前加：

```ts
  groups: PushGroup[];
  tasks: PushTask[];
  taskTargets: Array<{ task_id: number; group_id: number }>;
  pushLogs: PushLog[];
```

3. 文件末尾加：

```ts
export const PLANE_NOTIFY_KEYS = [
  'wecom_requirement_webhook_url',
  'wecom_daily_webhook_url',
  'wecom_digest_schedule',
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'email_recipients',
] as const;
export type PlaneNotifyKey = (typeof PLANE_NOTIFY_KEYS)[number];
export type PushGroup = { id: number; name: string; webhook_url: string; enabled: number; created_at: S };
export type PushTask = {
  id: number; name: string; enabled: number; trigger_type: string; cron_expr: S; timezone: string; source_type: string; source_config: string;
  format: string; next_run: S; last_run: S; last_success: S; alert_state: S; consecutive_failures: number; fail_threshold: number;
};
export type PushLog = { id: number; task_id: number | null; group_id: number | null; content: string; status: string; error: S; sent_at: string };
```

`packages/migrate/src/load.ts`：

1. import 改为 `import { type PlaneData, type PlaneNotifyKey, PLANE_NOTIFY_KEYS, type PrdData, type PushData } from './legacy-types';`。
2. `loadPlane` 的注释改为 `/** 只读取迁移需要的列；users.password、avatar_url 不读；settings 表只读推送需要的 8 个键（PLANE_NOTIFY_KEYS，含 SMTP 密码，迁移时加密写入）。 */`，返回对象在 `counts: {` 之前加：

```ts
      notifySettings: Object.fromEntries(
        all<{ key: PlaneNotifyKey; value: string }>(db, `select key, value from settings where key in (${PLANE_NOTIFY_KEYS.map((k) => `'${k}'`).join(', ')})`).map((r) => [r.key, r.value]),
      ),
```

3. `loadPush` 返回对象在 `counts: {` 之前加：

```ts
      groups: all(db, 'select id, name, webhook_url, enabled, created_at from groups order by id'),
      tasks: all(
        db,
        `select id, name, enabled, trigger_type, cron_expr, timezone, source_type, source_config, format, next_run, last_run, last_success,
          alert_state, consecutive_failures, fail_threshold from tasks order by id`,
      ),
      taskTargets: all(db, 'select task_id, group_id from task_targets order by task_id, group_id'),
      pushLogs: all(db, 'select id, task_id, group_id, content, status, error, sent_at from push_logs order by id'),
```

- [ ] **Step 3: 计划与对账报告**

新建 `packages/migrate/src/plan-notify.ts`：

```ts
import { assertCron, type ChannelConfig, channelConfigHint, type ChannelKind, DEFAULT_RATE_LIMIT, encryptConfig, parseChannelConfig } from '@flower/core';
import { parseLegacyTime } from './normalize';
import type { PlanContext } from './plan-types';

const PUSH_SOURCES: Record<string, 'overview_card' | 'new_requirements'> = { overview: 'overview_card', newreqs: 'new_requirements' };
/** 123plane 没有保存摘要时间表时的默认值（与 123plane 的 wecom-digest-scheduler 一致）。 */
const PLANE_DEFAULT_DIGEST = ['09:00', '12:00', '18:00'];
/** 时间表为空（已停用）时给定时推送的占位 cron；推送本身是停用的。 */
const DISABLED_DIGEST_CRON = '0 18 * * *';

/** 123plane 的摘要时间表：没有保存 → 默认时间；空数组 → 停用；无法解析 → 默认时间（与 123plane 相同）。 */
export function planeDigestTimes(raw: string | undefined): string[] {
  if (raw === undefined) return PLANE_DEFAULT_DIGEST;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return PLANE_DEFAULT_DIGEST;
  }
  if (!Array.isArray(parsed)) return PLANE_DEFAULT_DIGEST;
  return parsed.filter((x): x is string => typeof x === 'string' && /^\d{2}:\d{2}$/.test(x));
}

/** HH:MM 列表 → cron：同一分钟的合成一条（小时用逗号连接）。 */
export function digestCrons(times: string[]): string[] {
  const byMinute = new Map<number, number[]>();
  for (const t of times) {
    const [h, m] = t.split(':').map(Number) as [number, number];
    if (h > 23 || m > 59) continue;
    byMinute.set(m, [...(byMinute.get(m) ?? []), h]);
  }
  return [...byMinute.entries()]
    .sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]))
    .map(([m, hours]) => `${m} ${[...new Set(hours)].sort((a, b) => a - b).join(',')} * * *`);
}

/**
 * push 群、推送计划、推送对象、推送日志与 123plane 的企微地址、摘要时间表、SMTP → 通道、定时推送、发送记录。
 * 通道一律停用（生产群地址，开发阶段不能误发）；配置用 FLOWER_SECRET_KEY 加密；定时推送不排期，由后台循环排期。
 */
export function buildNotifications(ctx: PlanContext): void {
  const { push, plane } = ctx.data;
  const out = ctx.report.notifications;
  const names = new Set<string>();
  const uniqueName = (name: string): string => {
    const base = name.trim() || '未命名通道';
    let v = base;
    for (let i = 2; names.has(v); i++) v = `${base} (${i})`;
    names.add(v);
    return v;
  };
  const addChannel = (key: string, source: string, kind: ChannelKind, name: string, groupLabel: string | null, raw: unknown, createdAt: Date): string | null => {
    let config: ChannelConfig;
    try {
      config = parseChannelConfig(kind, raw);
    } catch {
      out.skipped.push({ what: `${source} 通道「${name}」`, reason: '配置不完整或网址无效' });
      return null;
    }
    if (!ctx.opts.secretKey) {
      ctx.problem('缺少 FLOWER_SECRET_KEY，无法加密推送通道配置');
      return null;
    }
    const id = ctx.id('notification-channel', key);
    const finalName = uniqueName(name);
    ctx.rows.notificationChannels.push({
      id,
      orgId: ctx.orgId,
      kind,
      name: finalName,
      groupLabel,
      config: encryptConfig(config, ctx.opts.secretKey),
      configHint: channelConfigHint(kind, config),
      rateLimitPerMin: DEFAULT_RATE_LIMIT[kind],
      allowedProductIds: [],
      enabled: false,
      createdAt,
      updatedAt: createdAt,
    });
    out.channels.push({ source, name: finalName, kind, enabled: false });
    return id;
  };

  const groupChannel = new Map<number, string>();
  for (const g of push.groups) {
    const id = addChannel(`push-group:${g.id}`, 'push', 'wecom_robot', g.name, g.name, { url: g.webhook_url }, ctx.time(g.created_at));
    if (id) groupChannel.set(g.id, id);
  }

  const taskSchedule = new Map<number, string>();
  for (const t of push.tasks) {
    const source = PUSH_SOURCES[t.source_type];
    let cron: string | null = null;
    try {
      cron = t.trigger_type === 'cron' && t.cron_expr ? assertCron(t.cron_expr) : null;
    } catch {
      cron = null;
    }
    if (!source || !cron) {
      out.skipped.push({ what: `push 推送计划「${t.name}」`, reason: `不支持的内容来源或触发方式（${t.source_type} / ${t.trigger_type}）` });
      continue;
    }
    const channelIds = push.taskTargets.filter((x) => x.task_id === t.id).flatMap((x) => groupChannel.get(x.group_id) ?? []);
    const id = ctx.id('notification-schedule', `push-task:${t.id}`);
    ctx.rows.notificationSchedules.push({
      id,
      orgId: ctx.orgId,
      productId: ctx.productId,
      name: t.name,
      cron,
      timezone: t.timezone || 'Asia/Shanghai',
      source,
      sourceConfig: source === 'new_requirements' ? { emptyBehavior: 'skip', onlineSourceKeys: ['online_issue'] } : {},
      channelIds,
      enabled: t.enabled === 1,
      nextRunAt: null,
      lastRunAt: parseLegacyTime(t.last_run),
      lastSuccessAt: parseLegacyTime(t.last_success),
      consecutiveFailures: t.consecutive_failures,
      failThreshold: Math.min(10, Math.max(1, t.fail_threshold)),
      alertState: t.alert_state ? 'alert' : 'normal',
      createdAt: ctx.asOfTime,
      updatedAt: ctx.asOfTime,
    });
    taskSchedule.set(t.id, id);
    out.schedules.push({ source: 'push', name: t.name, kind: source, cron, enabled: t.enabled === 1, channels: channelIds.length });
  }

  let orphanLogs = 0;
  for (const l of push.pushLogs) {
    const scheduleId = l.task_id === null ? undefined : taskSchedule.get(l.task_id);
    const channelId = l.group_id === null ? undefined : groupChannel.get(l.group_id);
    if (!scheduleId || !channelId) {
      orphanLogs++;
      continue;
    }
    const at = ctx.time(l.sent_at);
    const sent = l.status === 'ok';
    ctx.rows.notificationDeliveries.push({
      id: ctx.id('notification-delivery', `push-log:${l.id}`),
      orgId: ctx.orgId,
      kind: 'schedule',
      scheduleId,
      channelId,
      payload: { type: 'legacy', content: l.content },
      status: sent ? 'sent' : 'dead',
      attempts: 1,
      response: l.error,
      sentAt: sent ? at : null,
      createdAt: at,
      legacyKey: `push_logs:${l.id}`,
    });
  }
  if (orphanLogs > 0) out.skipped.push({ what: `push 推送日志 ${orphanLogs} 条`, reason: '对应的推送计划或群没有迁移' });
  out.deliveries = ctx.rows.notificationDeliveries.length;

  const s = plane.notifySettings;
  const reqUrl = s.wecom_requirement_webhook_url?.trim();
  const requirementChannel = reqUrl ? addChannel('plane:wecom_requirement', '123plane', 'wecom_robot', '123plane 需求通知', '123plane', { url: reqUrl }, ctx.asOfTime) : null;
  const dailyUrl = s.wecom_daily_webhook_url?.trim();
  if (dailyUrl) addChannel('plane:wecom_daily', '123plane', 'wecom_robot', '123plane 日报', '123plane', { url: dailyUrl }, ctx.asOfTime);
  if (s.wecom_digest_schedule !== undefined || requirementChannel) {
    const times = planeDigestTimes(s.wecom_digest_schedule);
    const crons = times.length ? digestCrons(times) : [DISABLED_DIGEST_CRON];
    if (!requirementChannel) out.skipped.push({ what: '123plane 变更摘要时间表', reason: '没有需求通知地址，无法确定发到哪里' });
    else {
      crons.forEach((cron, i) => {
        const name = crons.length > 1 ? `123plane 变更摘要 ${i + 1}` : '123plane 变更摘要';
        ctx.rows.notificationSchedules.push({
          id: ctx.id('notification-schedule', `plane-digest:${i}`),
          orgId: ctx.orgId,
          productId: ctx.productId,
          name,
          cron,
          timezone: 'Asia/Shanghai',
          source: 'digest',
          sourceConfig: {},
          channelIds: [requirementChannel],
          enabled: times.length > 0,
          nextRunAt: null,
          createdAt: ctx.asOfTime,
          updatedAt: ctx.asOfTime,
        });
        out.schedules.push({ source: '123plane', name, kind: 'digest', cron, enabled: times.length > 0, channels: 1 });
      });
    }
  }
  const host = s.smtp_host?.trim();
  const user = s.smtp_user?.trim();
  const recipients = s.email_recipients?.trim();
  if (host && user && s.smtp_pass && recipients) {
    const port = Number.parseInt(s.smtp_port ?? '465', 10) || 465;
    addChannel(
      'plane:smtp',
      '123plane',
      'email',
      '123plane 邮件',
      '123plane',
      { host, port, secure: port === 465, user, pass: s.smtp_pass, from: user, to: recipients.split(/[,，;；\s]+/).filter(Boolean) },
      ctx.asOfTime,
    );
  } else if (host || user || s.smtp_pass || recipients) {
    out.skipped.push({ what: '123plane SMTP 设置', reason: '配置不完整' });
  }
}
```

`packages/migrate/src/plan-types.ts`：

1. `ImportOptions` 末尾（`uploadsDir?: string;` 之后）加：

```ts
  /** 实例密钥 FLOWER_SECRET_KEY：加密推送通道配置。有通道要迁移而没有密钥时计划报问题。 */
  secretKey?: string;
```

2. `ImportRows` 末尾（`domainEvents: …;` 之后）加：

```ts
  notificationChannels: Ins<typeof core.notificationChannels>;
  notificationSchedules: Ins<typeof core.notificationSchedules>;
  notificationDeliveries: Ins<typeof core.notificationDeliveries>;
```

3. `INSERT_ORDER` 末尾 `'domainEvents',` 之后加 `'notificationChannels', 'notificationSchedules', 'notificationDeliveries',`。

4. `ReconReport` 在 `problems: string[];` 之前加：

```ts
  notifications: {
    channels: Array<{ source: string; name: string; kind: string; enabled: boolean }>;
    schedules: Array<{ source: string; name: string; kind: string; cron: string; enabled: boolean; channels: number }>;
    deliveries: number;
    skipped: Array<{ what: string; reason: string }>;
  };
```

5. `PlanContext` 构造函数里 `this.report = {…}` 的 `problems: [],` 之前加 `notifications: { channels: [], schedules: [], deliveries: 0, skipped: [] },`。

`packages/migrate/src/plan.ts`：

1. `import { buildExternalDocuments } from './plan-external';` 之后加 `import { buildNotifications } from './plan-notify';`。
2. `buildExternalDocuments(ctx);` 之后加 `buildNotifications(ctx);`。
3. `report.sourceCounts` 里 `'push.prdUrls': push.counts.prdUrls,` 之后加：

```ts
    'push.groups': push.groups.length,
    'push.tasks': push.tasks.length,
    'push.taskTargets': push.taskTargets.length,
    'push.pushLogs': push.pushLogs.length,
    'plane.notifySettings': Object.keys(plane.notifySettings).length,
```

4. `report.deferred.push(…)` 里删去这四项（已迁移）：

```ts
    { what: 'push 推送群', count: push.counts.groups, phase: 'P3 通知' },
    { what: 'push 推送计划', count: push.counts.tasks, phase: 'P3 通知' },
    { what: 'push 推送日志', count: push.counts.pushLogs, phase: 'P3 通知' },
    { what: 'push 任务对象（task_targets）', count: push.counts.taskTargets, phase: 'P3 通知' },
```

`packages/migrate/src/report.ts`：`'## 跳过的数据',` 之前加：

```ts
    '## 推送（迁移来的通道一律停用）',
    '',
    table(['来源', '通道', '类型', '启用'], r.notifications.channels.map((c) => [c.source, c.name, c.kind, c.enabled ? '是' : '否'])),
    '### 定时推送',
    '',
    table(['来源', '名称', '内容', 'cron', '启用', '通道数'], r.notifications.schedules.map((s) => [s.source, s.name, s.kind, s.cron, s.enabled ? '是' : '否', s.channels])),
    `发送记录（push 推送日志）：${r.notifications.deliveries} 条。`,
    '',
    '### 推送的跳过项',
    '',
    table(['内容', '原因'], r.notifications.skipped.map((s) => [s.what, s.reason])),
```

`packages/migrate/src/write.ts` 的 `TABLES` 末尾（`domainEvents: core.domainEvents,` 之后）加：

```ts
  notificationChannels: core.notificationChannels,
  notificationSchedules: core.notificationSchedules,
  notificationDeliveries: core.notificationDeliveries,
```

`packages/migrate/src/cli.ts`：

1. `buildImportPlan(data, mapping, { … uploadsDir: … })` 的参数对象末尾加 `secretKey: process.env.FLOWER_SECRET_KEY,`。
2. 最后一行 `console.log(\`已写入组织 …：需求 ${plan.rows.requirements.length} 条。\`);` 改为：

```ts
  console.log(
    `已写入组织 ${plan.rows.organizations[0]!.slug}：需求 ${plan.rows.requirements.length} 条；推送通道 ${plan.rows.notificationChannels.length} 个（全部停用）、定时推送 ${plan.rows.notificationSchedules.length} 个、发送记录 ${plan.rows.notificationDeliveries.length} 条。`,
  );
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/migrate test && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/migrate/src packages/migrate/test
git commit -m "feat(migrate): 迁移 push 与 123plane 的推送配置（通道一律停用、配置加密）、推送日志与对账报告「推送」一节

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 17: 本地开发库执行迁移、只读核对与试跑导入；用户检查点：是否 `--replace` 重导

**Files:**
- 不改代码。只操作本地开发库与 `.local-data/`（不提交）。

**Interfaces:**
- Consumes: Task 4 的迁移 `0015`、`0016`；Task 16 的迁移工具

- [ ] **Step 1: 迁移前只读核对**

```bash
docker exec flower-postgres-1 psql -U flower_admin -d flower -At \
  -c "select count(*) from requirements r join organizations o on o.id = r.org_id where o.slug = 'pan123' and r.deleted_at is null" \
  -c "select count(*) from pg_tables where schemaname = 'public' and tablename in ('notification_channels', 'message_templates', 'notification_schedules', 'notification_rules', 'notification_digest_items', 'notification_deliveries')"
```

Expected: `765`；`0`。第一项不同说明开发库在计划之后被改动过，停下来报告（只报数量）。

- [ ] **Step 2: 执行迁移并核对**

```bash
pnpm db:migrate
docker exec flower-postgres-1 psql -U flower_admin -d flower -At \
  -c "select count(*) from pg_class where relrowsecurity and relname in ('notification_channels', 'message_templates', 'notification_schedules', 'notification_rules', 'notification_digest_items', 'notification_deliveries')" \
  -c "select count(*) from pg_policies where tablename in ('notification_channels', 'message_templates', 'notification_schedules', 'notification_rules', 'notification_digest_items', 'notification_deliveries')" \
  -c "select (select count(*) from notification_channels) + (select count(*) from notification_schedules) + (select count(*) from notification_deliveries)" \
  -c "select count(*) from requirements r join organizations o on o.id = r.org_id where o.slug = 'pan123' and r.deleted_at is null"
```

Expected: `pnpm db:migrate` 应用 `0015`、`0016` 并把 `flower_app` 的密码改回 `apps/web/.env.local` 的值；依次输出 `6`、`6`、`0`、`765`。

- [ ] **Step 3: 旧数据只读核对（与计划时一致）**

```bash
sqlite3 -readonly .local-data/push.db \
  "select count(*) from groups" \
  "select count(*), sum(enabled) from tasks" \
  "select count(*) from task_targets" \
  "select count(*), sum(status = 'ok') from push_logs"
sqlite3 -readonly .local-data/123plane.db \
  "select count(*) from settings where key in ('wecom_requirement_webhook_url', 'wecom_daily_webhook_url', 'wecom_digest_schedule', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'email_recipients')" \
  "select value from settings where key = 'wecom_digest_schedule'"
```

Expected: `2`；`3|2`；`3`；`115|115`；`8`；`[]`。不一致时停下来报告（只报数量）。不要输出 `webhook_url`、`smtp_*` 等列的值。

- [ ] **Step 4: 试跑导入（不写库）并核对「推送」一节**

```bash
pnpm --filter @flower/migrate legacy import \
  --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" \
  --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" \
  --out "$PWD/.local-data/reports/p3a-dry" --as-of 2026-09-29 --uploads "$PWD/.local-data/prd_uploads" --dry-run
node -e "const r = require('./.local-data/reports/p3a-dry/migration-report.json'); const n = r.notifications; console.log(r.problems.length, n.channels.length, n.channels.filter((c) => c.enabled).length, n.schedules.length, n.schedules.filter((s) => s.enabled).length, n.deliveries, n.skipped.length)"
grep -cE 'key=[A-Za-z0-9-]{6}' .local-data/reports/p3a-dry/migration-report.md .local-data/reports/p3a-dry/migration-report.json
```

Expected: 试跑输出「试跑完成，未写入数据库。」；`node` 输出 `0 5 0 4 2 115 0`（问题 0；通道 5 个——push 2、123plane 3——全部停用；定时推送 4 个，其中启用 2 个；发送记录 115 条；跳过 0 项）；`grep` 两个文件都是 `0`（报告里没有网址密钥）。再与上一次导入的报告对照写入数量，除新增的三个推送表外应一致：

```bash
node -e "const a = require('./.local-data/reports/migration-report.json').targetCounts, b = require('./.local-data/reports/p3a-dry/migration-report.json').targetCounts; const d = Object.keys(b).filter((k) => a[k] !== b[k]); console.log(d.join(','))"
```

Expected: `notificationChannels,notificationSchedules,notificationDeliveries`。出现其他表时，先用 `git log --oneline -- packages/migrate` 核对上次导入之后迁移工具是否有计划内的改动；无法解释的差异停下来报告（只报表名与数量）。

- [ ] **Step 5: STOP——用户检查点：是否重导 pan123**

执行代理在这里停下，由控制方把下面的说明交给用户并等待明确答复，**没有明确同意不执行重导**：

> 推送配置只在导入时写入。要在本地看到迁移来的 5 个停用通道、4 个定时推送与 115 条历史发送记录（Task 18 的界面复验会用到），需要用 `--replace` 重导 pan123。重导会先删除 pan123 的全部数据（包括之前复验时新建的对象），再按 `--as-of 2026-09-29` 重新导入，之后让测试账号重新加入。是否现在重导？如果同意，请告诉我所有者账号的邮箱。

用户同意后，控制方执行（`<所有者账号邮箱>` 用用户答复的邮箱替换）：

```bash
pnpm --filter @flower/migrate legacy import \
  --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" \
  --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" \
  --out "$PWD/.local-data/reports/p3a-import" --owner-email <所有者账号邮箱> --as-of 2026-09-29 \
  --uploads "$PWD/.local-data/prd_uploads" --storage "$PWD/apps/web/.flower-storage" --replace
pnpm --filter @flower/migrate legacy rejoin --org-slug pan123 --owner-email <所有者账号邮箱> --accounts "$PWD/.local-data/test-accounts.json"
docker exec flower-postgres-1 psql -U flower_admin -d flower -At \
  -c "select count(*), count(*) filter (where enabled) from notification_channels c join organizations o on o.id = c.org_id where o.slug = 'pan123'" \
  -c "select count(*), count(*) filter (where enabled), count(*) filter (where next_run_at is null) from notification_schedules s join organizations o on o.id = s.org_id where o.slug = 'pan123'" \
  -c "select count(*), count(*) filter (where legacy_key is not null and status = 'sent') from notification_deliveries d join organizations o on o.id = d.org_id where o.slug = 'pan123'" \
  -c "select count(*) from notification_channels where config not like 'v1:%'" \
  -c "select count(*) from requirements r join organizations o on o.id = r.org_id where o.slug = 'pan123' and r.deleted_at is null"
```

Expected: 导入输出最后一行含「推送通道 5 个（全部停用）、定时推送 4 个、发送记录 115 条」；核对依次为 `5|0`、`4|2|4`、`115|115`、`0`、`765`。用户不同意时，记录「未重导；推送迁移只做了试跑」，Task 18 中依赖迁移数据的复验项标为「未验证（未重导）」。

---

### Task 18: 全量验证、真实数据界面复验与测试群联调（控制方）、验证记录与交接

**Files:**
- Create: `docs/p3a-validation.md`
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

Expected: 全部通过（`editor-perf.spec.ts` 在未设置 `EDITOR_BENCH` 时跳过）；记下 core、web、migrate 单测数与 e2e 用例数。`./scripts/smoke.sh` 的镜像默认启动后台循环（库里没有通道，不会发送），确认镜像正常启动即说明 `instrumentation.ts` 与 `nodemailer`、`cron-parser` 在 standalone 构建里可用。最后一条把 `flower_app` 密码改回开发值。

- [ ] **Step 2: STOP——控制方在真实数据上复验界面**

执行代理不运行 `pnpm dev`。在这里停下，把复验清单交给控制方。控制方在本地开发库（pan123）上启动开发服务器（后台循环默认开启；迁移来的通道全部停用，不会向生产群发送），以 1440px 与 760px 两种宽度逐项检查，确认页面本身不横向滚动，把结论（只写现象与数量，不写群名、网址、标题）交回。复验不修改迁移来的数据：

1. 组织设置 → 推送 → 通道：迁移来的 5 个通道全部停用，「测试」按钮不可用；地址列只有 `…/send?key=****` 加末 4 位，页面任何位置都看不到完整地址；邮件通道显示「主机:465 · 发件人 → 1 个收件人」，打开「修改」时密码框为空。
2. 定时推送：4 个；通道列带「（已停用）」；两个启用的 push 定时推送在开发服务器启动后的第一轮有了「下次执行」时间（不补跑）；如果复验期间到点，不产生发送记录，状态不变（没有可用通道，只记 last_error）。
3. 发送记录：115 条迁移记录，来源为「定时推送 + 名称」并标「迁移」，没有「重发」按钮；按通道、来源、状态、日期筛选与「下一页」正常。
4. 消息模板：4 个预置模板，修改预置模板时名称与格式不可改（只打开不保存）。
5. 产品设置 PAN → 推送：没有规则；新建一条**停用**的规则「复验规则（停用）」，确认列表、条件摘要显示正确后删除。
6. 未重导时：第 1–3 项只确认空状态，并在记录中标「未验证（未重导）」。

- [ ] **Step 3: STOP——测试群联调（每次发送前征得用户确认）**

控制方执行，**每一次发送前都先向用户说明将发送什么、发到哪里，得到明确同意后再点按钮**：

1. 请用户提供测试群的机器人地址。地址只在对话中传递，不写入任何文件、提交、日志或验证记录（记录里只写 key 末 4 位）。
2. 组织设置 → 推送 → 登记通道「联调测试群」（企业微信机器人，可用产品 PAN，启用）。
3. **文本**：征得同意后点该通道的「测试」→「发送」；页面提示「测试消息已发送」，发送记录为「已发送」；请用户确认群里收到。
4. **markdown**：在需求列表新建一条测试需求「P3-A 联调需求（可删除）」；在产品设置 PAN → 推送新建定时推送「联调·新需求」（内容来源「新需求」，通道只选「联调测试群」，**不勾选启用**）；征得同意后点「立即执行」；后台循环在几秒内发送，发送记录为「已发送」；请用户确认群里显示为 push 同样的版式（标题、引用行、分组、每条的优先级颜色与提出人行、末行链接）。
5. **模板卡片**：新建定时推送「联调·概览卡片」（内容来源「概览卡片」，通道只选「联调测试群」，**不勾选启用**）；征得同意后点「立即执行」；请用户确认群里是一张文本通知卡片：标题「{产品名} 研发日报 · 日期」、描述「MMDD 发版 · 整体进度 N% · …」、跳转「查看完整明细」能打开 Flower 的迭代甘特页（本地地址在手机上打不开属正常，只核对链接目标）。如果企微返回错误（发送记录里 `errcode` 不为 0），记下 `errcode` 与 `errmsg`，停下来报告，不重复发送。
6. 结束：停用「联调测试群」通道，确认两个联调定时推送为停用；测试需求保留并在记录中注明编号。记录三种格式的结论（通过 / 问题与 `errcode`）。

- [ ] **Step 4: 写验证记录**

新建 `docs/p3a-validation.md`，结构与 `docs/p2b2-validation.md` 一致，包含：

1. 迁移：Task 17 的核对结果（六张表 RLS 与策略；旧数据数量；试跑的「推送」一节数量；是否重导及重导后的核对数量）。
2. 自动化测试数量（Step 1）。
3. 界面复验结果（Step 2，每项「通过 / 问题与处理 / 未验证」）。
4. 测试群联调（Step 3）：三种格式各一行结论，通道只写「联调测试群（key 末 4 位）」；测试需求编号；结束时的停用情况。
5. 人工验收清单（供用户试用）：登记通道与测试消息、通道停用与删除限制、消息模板（预置与自建）、事件规则（即时与摘要、过滤条件）、定时推送（新建、立即执行、告警标红）、发送记录（筛选、重发、分页、迁移记录）、迁移来的配置全部停用。
6. 正式切换前需要用户决定的事项：启用哪些迁移通道、是否把 123plane「新建需求即时推送」配成事件规则、push 新需求之后那条固定文字提醒是否需要、看板图片是否需要（见计划「与设计、代码或数据的冲突」）。

- [ ] **Step 5: 更新交接文档与协作日志**

`docs/handoff.md`：

1. 「关键文档」表加三行：`docs/superpowers/specs/2026-10-10-flower-p3a-notifications-design.md`（P3-A 设计，已确认）、`docs/superpowers/plans/2026-10-10-flower-p3a-notifications.md`（P3-A 计划）、`docs/p3a-validation.md`（P3-A 真实数据验证、测试群联调记录与人工验收清单）。
2. 「当前进度」加一条「P3-A 推送：已完成，待合并」，写清：通道（企微机器人、Webhook、邮件，配置加密）、消息模板（四个预置）、事件规则（即时与合并到摘要）、定时推送（概览卡片、新需求、变更摘要，按 push 版式）、发送记录与后台循环（限流、重试、告警、重发）、迁移（通道全部停用）、联调结论。
3. 「下一步」改为：合并 P3-A；用户按 `docs/p3a-validation.md` 第 5 节验收并决定第 6 节的切换事项；规划 P3-B（站内通知与看板）。

`docs/agent-log.md`「记录」最上面加一条：

```
### 2026-10-XX · 本地 · P3-A 推送（通道、事件规则、定时推送、模板与发送记录、迁移）
- 分支 / PR：`feat/p3a-notifications`
- 做了什么：
  - 数据模型：notification_channels、message_templates、notification_schedules、notification_rules、notification_digest_items、notification_deliveries（均开 RLS）。
  - 通道配置 AES-256-GCM 加密（密钥由 FLOWER_SECRET_KEY 经 HKDF 派生，v1 密文），接口只返回脱敏提示；测试消息只能发给启用的通道。
  - 事件规则在领域事件写入的同一事务内匹配，只写待发记录或摘要条目；定时推送按 5 段 cron 与时区执行（cron-parser 5.10.2），内容来源概览卡片、新需求（按 push 版式）、变更摘要。
  - 后台循环随应用启动（FLOWER_NOTIFY_WORKER=off 关闭）：SKIP LOCKED 取任务、按通道限流、30 秒 / 2 分钟 / 10 分钟 / 1 小时重试、执行结果与告警；测试与端到端用 tick 接口驱动（FLOWER_NOTIFY_TICK_API=1）。
  - 页面：组织设置「推送」（通道、定时推送、消息模板、发送记录），产品设置「推送」页签（事件规则、本产品定时推送）。
  - 迁移：push 群 / 推送计划 / 推送日志与 123plane 企微地址、摘要时间表、SMTP；通道全部停用。
- 怎么验证的：（Step 1 的测试数；Task 17 的核对；Step 2 的复验结论；Step 3 的联调结论）
- 留给对方：CLAUDE.md「withSystem 只用于……」是否加上「后台发送查找有待办的组织」，由用户决定（见计划冲突表）。
```

- [ ] **Step 6: 提交**

```bash
git add docs/p3a-validation.md docs/handoff.md docs/agent-log.md
git commit -m "docs: P3-A 验证记录、测试群联调、交接进度与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 与设计、代码或数据的冲突

写计划时对照设计、上位文档、代码与只读数据发现的不一致，以及本计划的处理：

| 设计说法或现状 | 实际情况 | 本计划的处理 |
|---|---|---|
| 设计 §5「概览卡片……版式对齐 push 现有概览卡片」 | push 每次先发一张看板截图（图片消息），再发卡片；P3-A 的模板格式没有图片，生成截图需要无头浏览器 | 只发卡片，卡片按钮指向 Flower 的迭代甘特页；是否需要图片列入验证记录第 6 节，由用户在切换前决定 |
| push 新需求每次在 markdown 之后再发一条固定文字提醒 | 设计 §5 只要求新需求列表 | 不发；列入验证记录第 6 节 |
| 设计 §3「界面与接口只返回 config_hint」与「修改时可只改非敏感字段」 | 只返回提示时，邮件通道的修改表单无法回填主机、端口、收件人 | 邮件通道另返回非敏感字段 `settings`（不含密码）；网址、签名密钥、密码一律不返回，测试断言 |
| 设计 §6 发送记录的字段 | 「测试消息两者皆空并标 kind = test」需要 `kind` 列；判断「一次执行」的成败需要把同一次的记录关联起来；摘要条目「发送成功后标记已消费」需要知道是哪一次取用的 | 增加 `notification_deliveries.kind`、`run_id`，`notification_digest_items.run_id`；定时推送增加 `last_error`，模板增加 `builtin_key`；Task 4 在设计文档 §6 末尾写明实现补充 |
| 设计 §5 `product_id`（可空） | P3-A 的三种内容来源都按产品取数，摘要规则也按产品 | 新建时必须选产品，列保留可空给以后的组织级来源；「组织管理员（组织级）立即执行」在 P3-A 不出现（组织管理员在所有产品上是产品管理员） |
| 设计 §6「失败」与「dead」 | `failed` 若表示最终失败，就没有「等待重试」的状态 | `failed` = 本次失败、等待重试，`dead` = 已放弃；测试消息失败直接 `dead` |
| 设计 §5「失败告警：连续失败次数」 | 一次执行有多个通道、每条记录各自重试，「失败」口径没有写 | 以一次执行为单位：任一条成功算成功；全部放弃算一次失败；生成内容出错也算一次失败 |
| CLAUDE.md「withSystem 只用于登录、成员关系查找、Token 认证、邀请接受」 | 后台循环必须先知道哪些组织有待办 | 只用 `withSystem` 查组织 id，其余都在 `withOrg` 内；CLAUDE.md 是否增加这一用途由用户决定（本计划不改 CLAUDE.md），协作日志里留给对方 |
| 上位文档 §7.2「push 推送日志 111」 | 2026-10-10 只读核对为 115 条，全部 ok | 按实际数量迁移；对账报告按记录数核对（上位文档 §7.3 已约定不写死数量） |
| push `settings` 里有 `prd_notify_webhook` | 设计 §7 没有列出 | 不迁（push 系统设置仍按原来的延后项计数）；切换时如需要，作为新通道手工登记 |
| 123plane 新建需求时实时推送到需求通知地址 | 设计 §7 的映射只有通道与摘要时间表 | 不迁成事件规则；列入验证记录第 6 节，切换时由用户决定是否配置 |
| 123plane `wecom_digest_schedule` 为空数组 | 设计 §7「为空则停用」；123plane 没有保存时用默认时间 09:00、12:00、18:00 | 空数组 → 一个停用的摘要定时推送（cron 占位 `0 18 * * *`）；没有保存 → 按 123plane 的默认时间启用（pan123 不出现） |
| 迁移来的 push 定时推送「保留启用状态」 | 启用的定时推送导入后会按时执行 | 通道全部停用，执行时没有可用通道：只记 `last_error`、不计失败、不产生发送记录；`next_run_at` 为空，由后台循环第一次排期，不补跑 |

## P3-A 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm --filter @flower/web e2e`、`./scripts/smoke.sh` 全部通过。
- 设计 §8 列出的验证都有对应测试：加密往返与脱敏（Task 1）；规则匹配与过滤（Task 8）；cron 下一次时间含时区（Task 2）；摘要合并（Task 9、10）；模板渲染含缺字段（Task 3、6）；限流窗口与重试退避（Task 10）；`SKIP LOCKED` 下并发取任务不重复（Task 10、11）；权限（组织管理员、产品管理员、编辑、只读、只读 Token）与明文配置不出现在响应与事件里（Task 5、10、12）；端到端用本地假接收端验证测试消息、即时规则、立即执行定时推送、失败重试与发送记录页，1440 与 760 两种宽度（Task 13–15）；迁移在 pan123 上试跑并核对数量、迁移来的通道全部停用（Task 16、17）。
- 本地开发库执行迁移后核对一致（Task 17）；控制方完成界面复验与测试群联调（三种格式各一次，每次发送前经用户确认），验证记录、交接文档与协作日志已更新（Task 18）。

## 自查

写完后对照设计逐条核对的结果：

| 设计条目 | 对应任务 |
|---|---|
| §1 范围：通道、事件规则（即时与摘要）、定时推送、模板、发送记录与后台发送、迁移；不含站内通知、看板、AI 日报、飞书钉钉、http 来源 | Task 1–18（没有站内通知、看板、AI 日报、飞书钉钉、http 来源的任何代码） |
| §2 发送方式：进程内后台循环、发送记录即发件队列、多实例数据库锁 | Task 10（SKIP LOCKED、通道锁）、Task 11（循环、定时推送锁） |
| §3 通道表字段、三种配置结构、HMAC 签名头 | Task 1（配置）、Task 4（表）、Task 10（签名） |
| §3 加密与只返回 config_hint、敏感字段留空不变 | Task 1、Task 5、Task 12（接口断言）、Task 13（表单） |
| §3 权限（组织管理员登记；被引用只能停用；产品管理员只能选本产品可用且启用的通道） | Task 5、Task 7、Task 8 |
| §3 发送测试消息，结果写入发送记录 | Task 10、Task 13 |
| §4 规则表字段、可订阅事件、过滤、匹配时机、摘要条目、权限 | Task 4、Task 8、Task 14 |
| §5 定时推送表字段、三种内容来源、执行、立即执行（含 API Token）、失败告警 | Task 4、Task 7、Task 9、Task 10、Task 11、Task 12、Task 14 |
| §6 模板表、`{{path}}` 与按列表重复、每种来源与规则的预置模板 | Task 3、Task 6、Task 13 |
| §6 发送记录表、重试（30 秒、2 分钟、10 分钟、1 小时，最多 5 次）、企微限流不计次数、按通道滑动窗口限流 | Task 4、Task 10 |
| §6 后台循环每 5 秒、进程退出前停止取新任务、测试与 e2e 可关闭并手动驱动 | Task 11、Task 13（playwright 配置） |
| §6 发送记录页：按通道、来源、状态、时间筛选，单条重发 | Task 10、Task 12、Task 15 |
| §7 迁移映射、迁移来的通道一律停用、对账报告「推送」一节 | Task 16、Task 17 |
| §7 联调：测试通道、每次发送前征得同意、三种格式各一次 | Task 18 Step 3 |
| §8 验证清单 | 见「P3-A 完成标准」 |

- 占位检查：计划中没有「待定」「以后实现」或只描述不给代码的步骤。`2026-10-XX` 是协作日志条目的日期，`<所有者账号邮箱>` 是 Task 17 检查点由用户答复后填入的值，测试群地址由用户在 Task 18 提供且不落盘，三处都是执行时才能确定的外部输入。
- 名称一致性：`encryptConfig`、`decryptConfig`、`parseChannelConfig`、`mergeChannelConfig`、`channelConfigHint`、`channelPublicSettings`、`assertCron`、`assertTimezone`、`nextRunAt`、`renderTemplate`、`assertTemplateBody`、`renderMessage`、`toChannelPayloads`、`splitMarkdown`、`truncateBytes`、`payloadPreview`、`listChannels`、`createChannel`、`updateChannel`、`deleteChannel`、`listProductChannelOptions`、`readChannelConfig`、`usableChannelsTx`、`assertUsableChannelsTx`、`channelOption`、`BUILTIN_TEMPLATES`、`listMessageTemplates`、`createMessageTemplate`、`updateMessageTemplate`、`deleteMessageTemplate`、`resolveTemplateTx`、`assertTemplateIdTx`、`parseSourceConfig`、`listSchedules`、`getSchedule`、`createSchedule`、`updateSchedule`、`deleteSchedule`、`requireScheduleAdminTx`、`scheduleViewsTx`、`ruleMatches`、`eventFactsTx`、`matchNotificationRules`、`parseRuleFilter`、`listRules`、`createRule`、`updateRule`、`deleteRule`、`orgContextTx`、`formatMinute`、`shortDate`、`eventMessageDataTx`、`overviewCardDataTx`、`newRequirementsDataTx`、`digestDataTx`、`tryScheduleLockTx`、`generateScheduleRunTx`、`runScheduleNow`、`classifyHttp`、`signWebhook`、`sendPayload`、`retryDelayMs`、`defaultTransport`、`processDueDeliveries`、`sendTestMessage`、`resendDelivery`、`listDeliveries`、`runNotificationTick`、`createNotificationWorker`、`startNotificationWorker`、`planeDigestTimes`、`digestCrons`、`buildNotifications` 在定义与使用处一致；web 的 `notifyKeys`、`useNotificationChannels`、`useProductChannels`、`useMessageTemplates`、`useNotificationRules`、`useNotificationSchedules`、`useNotificationDeliveries`、`channelFormBody`、`channelToForm`、`emptyChannelForm`、`parseRecipients`、`toggle`、`parseDeliveryFilter`、`deliveryUrlQuery`、`deliveryApiQuery`、`DELIVERY_STATUS_TONE`、`filterSummary`、`scheduleState`、`CheckGroup`、`ScheduleList`、`ScheduleDialog`、`RuleDialog`、`NotificationsTab`、`ChannelsTab`、`ChannelDialog`、`TemplatesTab`、`TemplateDialog`、`DeliveriesTab` 同样一致；测试辅助 `TEST_DEPS`、`wecomChannel`（Task 5）、`fakeTransport`（Task 10）、`startFakeWebhook`（Task 12）、e2e `tick` 与 `createWecomChannel`（Task 14）在使用它们的任务之前或之内定义。
- 依赖顺序：Task 7 用 Task 5 的通道校验与 Task 6 的模板校验；Task 8 的摘要规则依赖 Task 7 的定时推送；Task 9 依赖 Task 3、5、6、7；Task 10 依赖 Task 9 的事件消息；Task 11 依赖 Task 9、10；Task 12 依赖 Task 5–11；Task 13–15 依赖 Task 12；Task 16 依赖 Task 1、2、4、5、7；Task 17 依赖 Task 4、16。
- 循环引用：`events.ts → notifications/match.ts → notifications/channels.ts → events.ts` 构成模块环，环上只有函数声明，模块初始化时不调用，Node ESM、esbuild（迁移工具与迁移 CLI）与 Next 打包都能处理；Task 8 Step 5 跑全部 core 测试确认。
