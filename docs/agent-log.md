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

### 2026-10-13 · 本地 · P3-B2 基础数据看板
- 分支 / PR：`feat/p3b2-dashboard`
- 做了什么：
  - core `src/dashboard/`：纯函数（周与组织时区、分位数、完成记录、吞吐量、前置与流动时间、在制品与停留、版本按期、迭代承诺、专项、评审效率与驳回率）与读取模块；`getProductDashboard`、`getOrgDashboard`（按可见产品过滤，组织汇总仅组织管理员，含全部产品范围的只读 Token）。无新表、无迁移、无新依赖。`validZone` 移到 `src/dates.ts`。
  - 接口 `GET /orgs/:org/products/:id/dashboard`、`GET /orgs/:org/dashboard`（近 30/90/180 天、自定义、按迭代）。
  - 页面：主导航「看板」（产品看板，纯 SVG 图表，口径说明，暂无数据原因）、组织设置「看板」（组织汇总）。
  - perf 命令加四个看板用例。
- 怎么验证的：`pnpm test`：core 628、web 235、migrate 123，全部通过；typecheck 通过；web lint 0 警告；全量 e2e 149 通过、1 跳过；`./scripts/smoke.sh` 通过。pan123 上四个看板用例 p95 在 18 毫秒以内；吞吐量、版本、专项三项 SQL 核对与接口一致；1440 / 760 界面复验通过，详见 `docs/p3b2-validation.md`。
- 留给对方：pan123 版本按期达成率与评审指标因数据缺口显示暂无数据（见 `docs/p3b2-validation.md` 第 5 节）；设计 §7 产品工作情况表待讨论。

### 2026-10-12 · 本地 · P3-B1 站内通知、@ 成员、关注、个人通知偏好与企业微信绑定
- 分支 / PR：`feat/p3b1-member-notifications`
- 做了什么：
  - 数据模型：member_notifications、member_notification_prefs、subscriptions、notification_cursors、wecom_apps、wecom_bind_states（均开 RLS）；members.wecom_userid、products.personal_channel_id、organizations.personal_email_channel_id；发送记录新增 kind = personal。游标在迁移时初始化为各组织最新事件。
  - @ 写法 `[@姓名](member:ID)`；评论、需求描述、PRD 正文的事件记下新增的被 @ 成员，新建需求、PRD、任务的事件带负责人。
  - 后台循环按组织游标处理事件（SKIP LOCKED；先单独读出仍在进行中事务的最早开始时间，只处理早于它的事件，超过 10 分钟的事务不再等待；每条 savepoint；连续失败 3 次跳过）：五类通知、收件人排名与过滤、自动关注；企业微信按产品合并 @ 到本人、邮件按人合并，经 P3-A 发送队列发出；定时推送进入告警时给组织管理员系统告警（savepoint 隔离）；已读 90 天与过期绑定 state 清理；生成、推送、清理各自兜底。
  - 企业微信：成员账号手动填写、CSV 预览与导入；自建应用配置（密钥加密）与扫码绑定（一次性 state，10 分钟过期，只访问 qyapi.weixin.qq.com，不跟随重定向）。
  - 页面：顶栏铃铛、通知页、@ 补全与成员标签（输入框与 BlockNote 自定义内联元素）、关注按钮、个人设置的通知偏好与绑定、成员页企业微信账号列与导入、推送页企业微信应用与个人通知邮件通道、产品个人提醒通道。
- 怎么验证的：
  - `pnpm test`：core 590、web 217、migrate 123，全部通过；typecheck 通过；web lint 0 警告；全量 e2e 144 通过、1 跳过（`editor-perf.spec.ts`）；`./scripts/smoke.sh` 通过。
  - Task 19 迁移核对：六张新表 RLS 与策略、游标指向最新事件、pan123 数量不变。
  - pan123 上两个账号的复验（被 @、被指派、关注与取消关注、偏好开关、设置页，1440 / 760）与测试群联调（群里 @ 到人，errcode 0，用户确认显示正确），详见 `docs/p3b1-validation.md`。
- 留给对方：扫码绑定需在正式部署、配置授权回调域后用真实企业微信验证；是否为历史负责人、评论者补自动关注由用户决定。

### 2026-10-12 · 云端 · PR #15 审查：发送时按解析出的 IP 拦截内网地址
- 分支 / PR：`feat/p3a-notifications`，PR #15
- 做了什么：审查 P3-A（租户隔离、密钥、SSRF、权限、发送管道、迁移、页面导入、字体脚本）。阻塞问题一个：内网地址检查只看字面量，公网域名解析到内网（或 Docker 内的 `postgres`、`flower` 这类单段主机名）可以绕过，测试消息还会把响应体返回给组织管理员。改为 `defaultTransport` 用 http(s).request + 自定义 lookup，解析后逐个地址检查、直连检查过的 IP，不跟随重定向，响应体最多读 64 KB；SMTP 先解析检查再直连该 IP，TLS 用原主机名（servername）校验证书。新增 `packages/core/test/notify-sender.test.ts`。`docs/handoff.md` 把「只发一次」改为「至少一次投递」的准确说法。
- 怎么验证的：新测试在原代码上失败（请求照常发往解析到本机的地址），修改后通过；`pnpm typecheck`、web lint、`pnpm test` 通过。
- 留给对方：非阻塞项见 PR #15 的审查汇总（「新需求」时间窗可能漏掉提交较晚的需求、无可用通道不计入连续失败告警、字体下载地址未固定到提交、迁移来的推送日志 response 未脱敏等），是否处理由用户决定。

### 2026-10-12 · 本地 · P3-A 推送（通道、事件规则、定时推送、模板与发送记录、迁移）
- 分支 / PR：`feat/p3a-notifications`
- 做了什么：
  - 数据模型：notification_channels、message_templates、notification_schedules、notification_rules、notification_digest_items、notification_deliveries（均开 RLS）。
  - 通道配置 AES-256-GCM 加密（密钥由 FLOWER_SECRET_KEY 经 HKDF 派生，v1 密文），接口只返回脱敏提示；保存与发送前都检查内网与本机地址（FLOWER_NOTIFY_ALLOW_PRIVATE=1 时放行，只用于测试与内网自部署）。
  - 事件规则在领域事件写入的同一事务内匹配（子事务隔离，出错只记警告），写待发记录或摘要条目；定时推送按 5 段 cron 与时区执行（cron-parser 5.10.2），内容来源概览卡片、新需求、变更摘要。
  - 后台循环随应用启动（FLOWER_NOTIFY_WORKER=off 关闭）：SKIP LOCKED 与按写入时钟计算的租约保证同一条只发一次，按通道限流，30 秒 / 2 分钟 / 10 分钟 / 1 小时重试，执行结果与告警；测试与端到端用 tick 接口驱动（FLOWER_NOTIFY_TICK_API=1）。
  - 设计 §9：按企微能力重新设计预置版式，新增 markdown_v2 格式；概览卡片可附带看板图片（satori + resvg 服务端生成，思源黑体由 `scripts/fetch-fonts.sh` 下载，不入库）。
  - 页面：组织设置「推送」（通道、定时推送、消息模板、发送记录），产品设置「推送」页签（事件规则、本产品定时推送）。
  - 迁移：push 群 / 推送计划 / 推送日志与 123plane 企微地址、摘要时间表、SMTP；通道全部停用。
  - CLAUDE.md：withSystem 增加「推送后台循环查出有待办的组织 id」；后台与系统写入不记事件；浏览器安全引用增加 `@flower/core/notifications`。`.dockerignore` 排除 `.local-data` 与 `.superpowers`。
- 怎么验证的：
  - `pnpm test`：core 507、web 189、migrate 122，全部通过；typecheck 通过；web lint 0 错误 0 警告；全量 e2e 133 通过、1 跳过（`editor-perf.spec.ts`）；`./scripts/smoke.sh` 通过（含镜像内生成看板图片）。
  - pan123 用 `--replace` 重导（用户同意）：通道 5 个全部停用、定时推送 4 个、发送记录 115 条、配置全部加密。
  - 1440px 与 760px 界面复验与测试群联调四次发送（每次经用户确认，均 errcode 0），详见 `docs/p3a-validation.md`。
- 留给对方：无

### 2026-10-10 · 本地 · P2-B2 模块文档、影响声明与人工合入
- 分支 / PR：`feat/p2b2-module-docs`，PR #14
- 做了什么：
  - 数据模型：document_affected_nodes（RLS，声明与合入状态）；documents 每个模块一份模块文档（部分唯一索引）、kind 与 node_id 的检查约束；模块文档状态 active / archived 并入 documents.status。
  - 模块文档：与变更 PRD 共用编辑器、修订、链接与评论；按二级标题（功能点名称）分节；功能点改名同步小节标题；归档只读。
  - 影响声明：PRD 侧栏「影响的功能点」，来源小节与失效提示，声明时由产品编辑当场新建模块与功能点；开始合入后锁定。
  - 合入页：按模块分组，逐个功能点应用、跳过、撤销；版本冲突提示刷新；全部处理完 PRD 变为已合入并同步「PRD」检查项；修订带合入来源，模块文档有合入记录。
  - 节点链接卡：模块与功能点指向模块文档（功能点带小节），没有文档时指向「模块文档」页签。
- 怎么验证的：
  - `pnpm test`：core 384、web 173、migrate 112，全部通过；typecheck 通过；web lint 0 错误 0 警告。
  - 全量 e2e：122 通过、1 跳过（`editor-perf.spec.ts`，需要 `EDITOR_BENCH`）、0 失败（第二次全量运行；第一次的 6 次失败由本机 Postgres 一次性崩溃/恢复引起，未复现；另修复一处 `documents-prd-flow` 的不稳定断言，改为等待按钮消失后再判断状态）；`./scripts/smoke.sh` 通过。
  - Task 14 迁移只读核对（pan123，未重导）：迁移前深度 1 节点 23 个、文档 204 份（node_id 均未设置）；迁移后 `document_affected_nodes` RLS 已开启（0 行）、`documents_module_node` 唯一索引与 `documents_kind_node` 检查约束已建立，pan123 文档数仍为 204。
  - 1440px 与 760px 界面复验（pan123）：模块文档页签与新建、影响声明的增删改与当场新建模块/功能点、来源小节失效提示、合入页的应用/跳过/撤销、PRD 变为已合入与「PRD」检查项同步、修订来源与合入记录、功能点改名同步、节点链接跳到模块文档小节、结构树页签的模块文档链接，均通过；详见 `docs/p2b2-validation.md`。复验新增对象：业务域 1、模块 1、功能点 2、文档 2（PAN-PRD-205、PAN-PRD-206），结束后已停用该业务域，数据留在本地供用户验收。
- 留给对方：
  - 并发的嵌套子树移动可能死锁（属于已有的一类问题，Postgres 会中止其中一个事务）；归档切换过程中如果正在输入，可能丢失最后一次编辑。
  - 「是否已归档」的判断在 web 侧写了两处；结构树层级标签加载中会显示「第 N 层」。
  - 合入页在后台重新取数失败时会静默显示旧数据，「删除」类声明的文案在两种情况下不准确；归档的模块文档仍允许上传图片附件；`loadTree` 与声明相关查询在每次写操作里重复执行，`featureCount` 统计把已废弃的功能点算在内。

### 2026-10-09 · 云端 · PR #13 迁移 0011 处理重名迭代
- 分支 / PR：`feat/p2b1-links`，PR #13
- 做了什么：审查 PR #13 发现 0011 的 `iterations_product_name` 唯一索引在已有重名常规迭代的库上会建失败。按用户选择，在建索引前加一段去重：同一产品内未删除的常规迭代按 `(created_at, id)` 排序，重名的第 2 个起改名为「名称（N）」，N 从 2 起跳过已占用的名称；已删除的迭代和专项迭代不动。新增 `packages/core/test/migration-0011.test.ts`：先迁到 0010，造重名数据（含同一创建时间按 id 排序、「名称（2）」已被占用、已删除、其他产品、专项迭代），再迁到最新并断言改名结果与唯一索引。`docs/handoff.md` 记了一句。
- 怎么验证的：新测试通过；还原 0011 后新测试在建索引时失败（23505）；`pnpm typecheck`、web lint、`pnpm test` 通过。已经执行过 0011 的库不会重跑这段（drizzle 按迁移记录跳过），这些库本来就没有重名。
- 留给对方：无

### 2026-10-09 · 本地 · P2-B1 双链与反向链接
- 分支 / PR：`feat/p2b1-links`，PR #13
- 做了什么：
  - 数据模型：entity_links（RLS）；tasks.number + products.task_seq（迁移按创建时间补号，迁移工具导入时同样编号）；同一产品内迭代名称唯一（部分唯一索引）。
  - 需求描述、PRD 正文、评论保存时解析 `[[ ]]` 并重建链接；新建或改名的目标接上悬空链接；链接卡（标题、状态、灰色说明、无权限只显示编号）；需求、PRD、任务、迭代详情页的「被引用」。
  - `[[` 补全：纯文本输入框的列表与 PRD 编辑器的 BlockNote 补全菜单，选 PRD 后可选小节；PRD 编辑器用只读装饰插件显示链接卡与评论锚点高亮，不改正文、不触发自动保存。
  - 任务编号 `PAN-T-n` 与只读任务详情页；PRD 的未读评论进工作台，打开 PRD 即标为已读；需求的未读评论规则同步扩大为「我负责的，或我参与过评论的」（2026-10-09 用户决定，与 PRD 一致）。
- 怎么验证的：
  - `pnpm test`：core 346、web 166、migrate 112，全部通过；typecheck 通过；web lint 0 错误 0 警告。
  - 全量 e2e：110 通过、1 跳过（`editor-perf.spec.ts`，需要 `EDITOR_BENCH`）、0 失败；`./scripts/smoke.sh` 通过。
  - 编辑器输入延迟复测（`EDITOR_BENCH=1`）：合成 160k 文档加载 1240/1550/1241 ms、输入 p95 24/27/22 ms，与主干及 P2-A 基线一致，未超阈值（加载 ≤ 1500 ms、输入 p95 ≤ 50 ms）；装饰插件整篇重扫在 160k 文档 3 锚点时把输入 p95 从 23 ms 推到 37 ms，仍在阈值内。
  - Task 15 只读核对（pan123，未重导）：任务 377 个，编号 1..377 连续不重复，顺序与 `(created_at, id)` 排序 0 处不符，`task_seq` 377；常规迭代 11 个互不重名。
  - 1440px 与 760px 界面复验（pan123）：甘特任务编号与任务详情、需求描述 `[[` 补全与链接卡、PRD 编辑器的链接卡与评论锚点高亮联动、三处「被引用」、工作台未读评论，均通过；详见 `docs/p2b1-validation.md`。
- 留给对方：
  - 装饰插件在每次文档变化时整篇重扫，大文档多锚点时输入延迟升高（仍在阈值内）；改进方向是增量重扫，并让性能基准测试页传入装饰数据。
  - Android 输入法的 `keyCode 229` 会挡住 PRD 编辑器 `[[` 补全菜单里用 Enter 选中；编辑器链接卡的 Cmd/Ctrl/中键点击不会新开标签页；「被引用 0」的标题会和空列表一起显示；过期的补全候选项没有视觉区分。
  - 按字搜索是逐条扫描，pan123 规模下没问题，数据量到 10 万级以上需要上 pg_trgm；迁移来的 PRD 评论（pan123 有 3 条）没有已读标记；缺测试：对看不到来源产品的被引用隐藏、隐藏迭代或节点的链接卡、同名的常规迭代与专项迭代。
  - 改迭代名称或结构树节点名称后，指向旧写法的悬空链接会按新路径接上；如果之后又有别的迭代或节点用回旧名称，旧写法的链接在下一次来源对象保存时会重新接到这个新目标上（与悬空链接接上的规则一致），不是永久指向最初的目标。
  - P2-B2 范围：模块文档、影响声明、人工合入、结构树补建模块与功能点。

### 2026-10-09 · 本地 · P2-A 变更 PRD
- 分支 / PR：`feat/p2a-change-prd`，PR #12
- 做了什么：
  - 数据模型：documents、document_revisions、document_templates、attachments（RLS），products.document_seq，requirements.change_document_id 外键。
  - Flower 内 PRD（BlockNote，自动保存与乐观锁，同一作者 5 分钟内合并修订，按小节对比与恢复，划词评论与已失效标记）与外部 PRD（链接、状态、覆盖需求、会签、评论）；三种导入；模板与必填小节；图片附件存本地卷。
  - 「PRD」检查项改为作用于需求、跟随 PRD 状态；PRD 上的会签结果覆盖的需求共享；等我签字与 PRD 评审表包含评审中的 PRD。
  - 迁移：prd 系统页面、修订、附件、评论；123plane 与 push 的 PRD 链接导入为外部 PRD。
- 怎么验证的：
  - `pnpm test`：core 309、web 154、migrate 110，全部通过；typecheck 通过；web lint 0 错误 0 警告。
  - 全量 e2e：91 passed、1 skipped（`editor-perf.spec.ts`，需要 `EDITOR_BENCH`）、0 failed，跑了两次；`./scripts/smoke.sh` 通过。
  - 迁移对账（Task 17，2026-10-09，`--as-of 2026-09-29 --replace`，用户已确认）：prd 系统 11 份未删除页面（104 条修订、98 个附件 + 6 张内嵌图片、3 条评论、0 条需求关联）；外部 PRD 192 份（关联需求 242 条）；「PRD」检查项改写 100 条；读只读 SQL 复查与报告一致。
  - 大文档性能复测（Task 1 基线 vs 真实数据）与 1440px / 760px 界面复验结论均见 `docs/p2a-validation.md`。
- 留给对方：
  - 本机 DNS 不可达时，e2e 应用的数据库连接改用 `127.0.0.1`，否则 `getaddrinfo` 会阻塞约 30 秒。
  - 留观的非阻塞项：编辑器保存后 `setQueryData` 不比对版本号，可能多弹一次冲突提示；SVG 粘贴为 `data:` 图片保存会 400；迁移工具按姓名回退匹配成员、需求关联覆盖写入、导入中途存储错误、标题裁剪、仅统计 `merged` 的需求个数几处小问题；`setCheckItemState` 加锁未排除软删除的 PRD。
  - P2-B 范围见计划「留给 P2-B」一行。

### 2026-10-08 · 本地 · 合并服务端成员校验（PR #9），P1 收尾
- 分支 / PR：`docs/progress-after-p9`
- 做了什么：
  - 核对 PR #9：`assertAssignableMember` 接在需求负责人与提出人、任务负责人、需求分配、阻塞项负责人、流程「指定成员」签字人 6 处写入点；冲突解决后两条日志都保留。CI 三项在 `410308a` 上通过后合并（merge commit `b573e7a`）。
  - `docs/handoff.md`：成员校验标为已合并，记录 P1 阶段全部完成；下一步改为规划 P2。
- 怎么验证的：PR #9 CI 三项通过；本地 `pnpm db:migrate` 后开发服务器可用。
- 留给对方：无

### 2026-10-08 · 云端 · 服务端写入成员时校验：本组织在职的人类成员
- 分支 / PR：`claude/compassionate-babbage-ei9baf`
- 做了什么：
  - `packages/core/src/requirements/context.ts`：新增 `assertAssignableMember`，替换原来只查「是否存在」的 `assertMemberInOrg`。成员必须是本组织在职的人类成员，否则抛 `AppError('invalid', …)`：
    - 不存在或属于其他组织（RLS 查不到）：「成员不存在或不属于本组织」；
    - Agent：「不能选择 Agent 成员」；
    - 已离开：「该成员已离开组织，不能选择」。
  - 用在这些写入点：需求负责人 / 提出人（新建、修改）、任务负责人（新建、修改）、需求分配成员、阻塞项负责人、会签「指定成员」（新建流程模板、发布新版本）。
  - 只校验**新设置的值**，与原有逻辑一致：负责人后来离职，修改需求的其他字段、或保持原负责人不变都不报错。
  - 流程同理，只校验相对当前版本新加入的指定签字人；沿用已离职的签字人仍可发布，以免挡住与他无关的修改（产品管理员可以代签，或在新版本里换人）。错误信息带检查项名称。
  - 需求分配原来只拦离职、不拦 Agent，文案从「只能分配给在职成员」改为统一文案，`assignments.test.ts` 同步更新。
  - 导入工具用管理员连接直接写行，不经过这些服务函数，导入时引用的离职成员不受影响。
- 怎么验证的：
  - 新增 `packages/core/test/member-assignability.test.ts`（7 个用例），覆盖以上每个写入点的离职成员和 Agent 两种情况，以及不存在的成员、负责人后来离职、流程沿用已离职签字人。
  - 其中 6 个在改动前失败；「负责人后来离职仍可改其他字段」在改动前后都通过，作为防回归。
  - 合入 #8 之后的代码上：core 260、web 136、migrate 89、e2e 65 全部通过；类型检查、lint 通过。
- 留给对方：
  - 已处理 2026-10-08 云端 #8 审查条目里「服务端仍接受离职成员」这条待办。
  - 回复 2026-10-08 本地条目：已合入最新 main 并核对 core 里所有写入成员 ID 的地方。甘特任务负责人走 `createTask` / `updateTask`，需求分配走 `addRequirementAssignment`，都已校验；批量关联只写需求 ID，不涉及成员；`invitations.memberId` 是绑定账号，另有「只能绑定没有账号的人类成员」的校验。测试数与 main 对齐（core 在 main 的 253 上加本 PR 的 7 个，共 260）。
  - 本地 agent 新增其他「选人」写入点时，用 `assertAssignableMember`，并且只在值变化时校验。

### 2026-10-08 · 本地 · 合并 P1-C（PR #8），更新交接进度
- 分支 / PR：`docs/progress-after-p1c`
- 做了什么：
  - 核对云端补修提交 `4e66611`（只改迁移代码与测试），确认 CI 三项通过后合并 PR #8（merge commit `fa9376d`）。
  - 用 `4e66611` 的迁移代码对 pan123 只读副本试跑：0 个阻止写入的问题，「多人共用这个写法」0 条，本地开发库不重导。
  - `docs/handoff.md`：P1-B2、P1-C 标为已合并；补记云端补修与进行中的服务端成员校验；下一步改为合并成员校验 PR、规划 P2。
- 怎么验证的：PR #8 在 `4e66611` 上 CI 三项通过；本地 `pnpm db:migrate` 后开发服务器可用。
- 留给对方：服务端成员校验分支合入最新 main 后，请确认 P1-C 新增或改动的写入点（甘特任务负责人、批量关联、分配）都走 `assertAssignableMember`，测试数与 main 对齐。

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
