# Flower 数据模型设计（P0）

- 日期：2026-09-28
- 状态：已评审（逐段确认），待实现计划
- 范围：Flower 的完整数据模型，以及 123plane / push / prd 三个项目的旧数据迁移映射。P0 实现其中的租户与身份、可配置定义和 docker 骨架；其余模块按阶段实现，但表结构在此一次定清，避免返工。

## 0. 背景

Flower 是一个多组织、多产品的产品研发管理平台，最终以 docker 形式供他人自托管。它合并三个现有项目：

| 现有项目 | 职能 | 技术栈 | 线上数据量 |
|---|---|---|---|
| 123plane（dirctable.com） | 需求管理 | Next.js + SQLite | 需求 684、活动日志 4134 |
| push（push.dirctable.com） | 版本管理 + 企微推送 | Fastify + React + SQLite | 需求 328、甘特任务 359、设计签字 304 |
| prd（prd.dirctable.com） | PRD 管理 | Next.js + Postgres + drizzle | 页面 18、修订 114、附件 99 |

三者目前靠共享 JWT 密钥、跨站跳转登录、公网双向同步和一个直写 SQLite 的定时脚本串联，且全部没有租户概念，大量 123云盘 专属内容（人员名单、业务域、评审角色）写死在代码里。现状图见 `docs/diagrams/server-arch-current.svg`，目标架构草案见 `docs/diagrams/flower-target-v0.svg`。

### 不在范围内

- 123prd.dirctable.com（静态站）暂不动。
- b123 数据联动（P6），本文只保留挂钩点，不建表。
- 第三方登录（OIDC、企微扫码）、实时协同编辑、关系图谱视图、向量检索的实现。

## 1. 总体约定

- **数据库**：PostgreSQL 17，镜像 `pgvector/pgvector:pg17`；ORM 用 drizzle。
- **存储策略**：业务实体用关系表加外键；流程配置存为带版本的 JSON 定义（zod 校验）；运行时取值用关系表。
- **主键**：新建数据用 UUIDv7；迁移导入的行使用由来源键 SHA-1 派生的确定性 UUID（v5 位布局），重复导入得到相同 ID。人可读编号按产品自增（如 `PAN-123`、`PRD-12`）：需求编号由 `products.requirement_seq` 以 `update … returning` 分配；文档编号由 `products.document_seq` 以同样方式分配，显示为 `{product.key}-PRD-{n}`（P2-A 计划「设计决定」）。旧编号存 `legacy_key`。
- **租户隔离**：所有租户数据表带 `org_id`。应用层在每个事务开头设置当前组织并强制过滤；Postgres 行级安全（RLS）策略用同一个值再校验一次。
- **软删除**：业务实体带 `deleted_at`。字典选项只停用不删除。
- **审计**：领域事件表即审计日志（见 §6.1），不另建日志表。
- **时间**：统一存 `timestamptz`；组织设置默认时区（123云盘 为 Asia/Shanghai）。
- **密钥**：敏感配置用 `FLOWER_SECRET_KEY` 加密存储；缺少该环境变量时拒绝启动，不使用任何默认密钥。
- **运行时**：只依赖 Postgres，不引入 Redis。队列用 `FOR UPDATE SKIP LOCKED`，多实例互斥用 advisory lock。一个镜像，web 和 worker 两种启动模式。
- **API 形态**：`/api/v1/orgs/{org}/...`，Web 界面也走同一套接口；MCP 是 API 之上的适配层（P4）。
- **前端**：Next.js + Tailwind CSS + shadcn/ui，默认浅色主题，next-themes 提供深色模式；复用 123plane 的组件。

## 2. 租户与身份

### 2.1 表

| 表 | 关键字段 | 说明 |
|---|---|---|
| `accounts` | email（citext 唯一）、name、password_hash（argon2id）、is_instance_admin、preferences（jsonb：语言、时区、主题） | 全局账号，一人一条 |
| `sessions` | account_id、expires_at、ip、user_agent | 服务端会话，cookie 只存不透明 id，可立即吊销 |
| `organizations` | slug（URL 用）、name、settings（jsonb：时区、结构树层级叫法等） | |
| `products` | org_id、key（组织内唯一，如 `PAN`）、name、status（启用 / 归档）、workflow_version_id、structure_level_names（可空，覆盖组织设置）、requirement_seq | requirement_seq 为已分配的最大需求编号 |
| `members` | org_id、account_id（可空）、kind（human / agent）、display_name、email（可空）、department（文本）、org_role（owner / admin / member / guest）、status（active / left） | 组织成员；无账号的成员也是成员。唯一约束（org_id, account_id） |
| `product_members` | product_id、member_id、role（admin / editor / viewer） | 产品级角色覆盖 |
| `function_tags` / `member_function_tags` | org_id、name、color / member_id、tag_id | 职能标签，一人多个，不影响权限 |
| `invitations` | org_id、email、member_id（可空，绑定已有无账号成员）、token_hash、expires_at、invited_by、accepted_at | 接受后成员关联账号，历史引用不变 |
| `api_tokens` | org_id、member_id（以谁的身份调用）、issued_by、name、prefix、token_hash、scope（jsonb：产品范围、读 / 读写）、expires_at、last_used_at、revoked_at | 明文只在创建时显示一次 |
| `entity_aliases` | org_id、entity_type、entity_id、alias | 旧编号与改号后的编号别名，保证旧链接有效 |

### 2.2 权限规则（固定在代码中）

- **组织级**：owner / admin 在所有产品上等同产品 admin，并管理成员、配置和产品；member 默认在所有产品上是 editor，可按产品下调；guest 默认看不到任何产品，需按产品单独授权。
- **产品级**：admin 可修改产品配置（流程覆盖、结构树、字段覆盖、通知规则）；editor 可增删改需求、文档、迭代、任务；viewer 只读。
- **强制流转**：条件不满足时，产品 admin 可以强制流转，必须填写原因，记入 `state_transitions` 和领域事件。
- **资源级规则不属于本层**，在各模块设计时逐条决定。已知待定项：成员能否修改他人创建的 PRD。已决定：产品只读成员（viewer）可以评论（见 P1-A 计划「设计决定」表「评论权限」行：提出人多为只读成员或访客，需要能跟进）。

### 2.3 Agent 与 API Token

- Agent 是 `kind = agent` 的成员，和人一样拥有组织角色、产品角色和职能标签。它写的 PRD、评论，作者显示为该 Agent。
- 个人 Token 的 member_id 为本人；Agent Token 由管理员为 Agent 成员签发。
- 每次请求的实际权限 = 身份当前权限 ∩ Token 范围。身份权限被下调时 Token 随之收窄。
- 领域事件同时记录操作成员和所用 Token。
- 只读 Token 不能签字、评论或标记已读：这三项只要求产品 viewer 角色，因此另外显式拒绝只读 Token。

### 2.4 自托管初始化

首次启动进入初始化向导，第一个账号成为实例管理员。实例设置包括：是否开放注册、是否允许普通用户创建组织、HTTP 取数白名单（§6.2）。

## 3. 可配置定义

### 3.1 流程定义（带版本）

| 表 | 关键字段 |
|---|---|
| `workflow_definitions` | org_id、name、product_id（为空表示组织模板；非空表示产品覆盖）、forked_from_version_id、current_version_id、archived_at |
| `workflow_versions` | definition_id、version（递增）、body（jsonb）、note、created_by、created_at。一经生成不可修改 |

产品通过 `products.workflow_version_id` 指定当前版本。组织模板更新不影响已在用的产品。

`body` 结构（zod 校验）：

```ts
{
  states: [{ key, label, color, order,
             group,                     // 可配置分组，用于看板泳道，如 "分析" / "开发"
             category }],               // 固定五类：backlog | unstarted | started | completed | canceled
  initial: stateKey,
  transitions: [{ from: stateKey | "*", to: stateKey, label?, conditions: Condition[] }],
  actionGates: [{ action: "join_iteration", conditions: Condition[] }],
  checkItems: [{ key, label,
                 scope: "requirement" | "document",   // document = 挂在变更 PRD 上，覆盖的需求共享结果
                 type: "single" | "signoff",
                 signers?: [{ by: "function_tag" | "member" | "product_role", ref }],
                 signoffRule?: "all" | "any",
                 auto?: "prd_status",                 // 作用于需求的普通检查项；需求被 PRD 覆盖时跟随 PRD 状态、不可手改（P2-A）
                 defaultState: CheckState }],
}
// CheckState 固定：not_started | in_progress | passed | rejected | not_needed
// Condition 首批四种：
//   { type: "check_item", item, in: CheckState[] }
//   { type: "field_set", field }
//   { type: "has_iteration" }
//   { type: "has_change_document" }
```

**版本升级**：产品从 vN 升到 vM 时，系统列出受影响的内容（被删状态上的需求数、被删检查项上的结果数），管理员给出映射后，在一个事务里完成迁移，并写入领域事件。需求只存 `state_key`，不存版本号；同一产品的需求始终使用同一版本。

### 3.2 字段字典（实时生效）

| 表 | 关键字段 |
|---|---|
| `field_definitions` | org_id、product_id（为空表示组织级）、key、label、cardinality（single / multi）、builtin、applies_to（requirement） |
| `field_options` | field_id、key、label、color、sort、active |

- 内置字段：priority、platform、source、line。
- 产品覆盖 = 把组织字段复制一份成为产品级定义，之后两者独立。
- 自定义字段（以后）= 在同一张表加 `builtin = false` 的行，取值仍存 `field_values`，不改表结构。

### 3.3 结构树层级叫法

`organizations.settings.structureLevelNames` 默认 `["业务域", "模块", "功能点"]`，最多 3 层；产品可在 `products.structure_level_names` 覆盖。不做版本化。

## 4. 需求、迭代与任务

### 4.1 结构树

`structure_nodes`：org_id、product_id、parent_id、depth（1–3）、name、description、status（active / deprecated）、sort（integer）、legacy_key。唯一约束：（product_id, parent_id, name）。

结构树按产品各建一棵。业务域即第一层节点，不再作为字典。

### 4.2 需求

`requirements`：

| 字段 | 说明 |
|---|---|
| id、org_id、product_id、number、legacy_key | 显示编号 `{product.key}-{number}` |
| title、description（markdown） | |
| state_key、state_changed_at | 状态由产品当前流程版本解释 |
| owner_member_id、requester_member_id | 引用成员 |
| node_id（可空） | 挂在结构树任意一层，只挂一个节点 |
| iteration_id（可空） | 最多属于一个迭代 |
| change_document_id（可空） | 最多挂一份变更 PRD |
| created_by、created_at、updated_at、deleted_at | |

附属表：

| 表 | 说明 |
|---|---|
| `field_values` | org_id、entity_type、entity_id、field_id、option_id。一行一个值，多选即多行 |
| `requirement_assignments` | requirement_id、member_id、function_tag_id、platform_option_id（可空）。如"PC 端开发：张三" |
| `requirement_relations` | from_id、to_id、type（duplicate_of / merged_into / derived_from / blocks / related） |
| `state_transitions` | requirement_id、from_state、to_state、actor_member_id、token_id、forced、reason、at。取代 123plane 的阶段时间戳 |
| `blockers` | requirement_id、description、status、owner_member_id |
| `check_item_results` | org_id、target_type（requirement / document）、target_id、item_key、state、note、meta（jsonb）、updated_by、updated_at |
| `check_item_signoffs` | result_id、signer_member_id、acted_by_member_id（可空，代签时的实际操作人）、signer_rule_index、decision（passed / rejected）、note、evidence_link_id（可空，引用 `external_links`）、at |

### 4.3 迭代与发布版本

`iterations`：

| 字段 | 说明 |
|---|---|
| org_id、product_id（专项为空） | 常规迭代属于产品，专项属于组织 |
| type（regular / special）、name、legacy_key | |
| start_date、end_date、baseline_end_date | 状态由规划中变为进行中时锁定基线 |
| status（planning / active / done / canceled） | 固定四种 |
| milestones（jsonb：`[{label, date}]`） | 容纳"启动 / 开发开始 / 开发结束 / 发布"等节点 |

约束：同一产品的常规迭代时间不得重叠，用 Postgres 排他约束实现：`EXCLUDE USING gist (product_id WITH =, daterange(start_date, end_date, '[)') WITH &&) WHERE (type = 'regular' AND deleted_at IS NULL)`。结束日与下一迭代的开始日可以是同一天（生产数据中发布日即下一迭代开始日）。专项不受限制。

`iteration_scope_snapshots`：iteration_id、requirement_id、snapshot_kind（committed）、at。迭代开始时记录承诺范围，用于区分承诺后完成、中途加入、中途移出。

`releases`：org_id、product_id、platform_option_id、version_name、iteration_id（可空）、status（planned / released）、planned_date、baseline_date、released_at、notes。

`requirement_releases`：requirement_id、release_id（多对多）。

### 4.4 任务

`tasks` 统一 123plane 的子任务和 push 的甘特任务：

| 字段 | 说明 |
|---|---|
| org_id、product_id、requirement_id（可空）、iteration_id（可空） | |
| title、alias、assignee_member_id、status（todo / doing / done） | |
| plan_start、plan_days、delay_days、phase、flag、starred（可空） | 排期字段，仅甘特类任务使用；plan_days、delay_days 为实数，允许半天 |
| meta（jsonb） | 迁移时保存 push 概览看板的手动覆盖值 |

"某人在忙什么"按 assignee 跨所有迭代汇总查询。

### 4.5 评论

`comments`：org_id、target_type（requirement / document / iteration）、target_id、parent_id、author_member_id、body（markdown）、kind（comment / update）、anchor（jsonb，可空）、anchor_state（ok / stale / unanchored）、resolved_at、resolved_by。

`comment_reads`：comment_id、member_id、read_at。

文档评论的 anchor 采用"引用原文片段 + 所在小节"定位（W3C 文本引用定位方式）；原文变更后标记为 stale，不丢弃评论。

## 5. 文档

### 5.1 两类文档

`documents`：org_id、product_id、number、kind（change / module）、source（native / external，外部 PRD 只存 external_url 与 external_provider，见 P2-A 设计）、title、owner_member_id、template_id、node_id（仅 module，必填；每个模块节点只有一份）、status、current_revision_id、version（乐观锁）、legacy_key、created_by、deleted_at。

| | 变更 PRD（change） | 模块文档（module） |
|---|---|---|
| 状态 | draft / review / approved / launched / merged / discarded | active / archived |
| 与需求的关系 | 覆盖 N 条需求；需求侧 `change_document_id` 保证一条需求最多一份 | 不直接关联需求 |
| 影响声明 | `document_affected_nodes`：document_id、node_id、change_type（added / modified / removed）、source_sections、merge_status（pending / applied / skipped）、merged_revision_id、merged_by、merged_at（见 P2-B2 设计 §4） | — |
| 检查项 | scope = document 的检查项结果挂在它上面 | — |

### 5.2 正文

- markdown 是唯一数据源，编辑器为 BlockNote。
- 变更 PRD 的正文是单个 markdown。
- 模块文档为单篇 markdown，按二级标题（功能点名称）定位小节，不建 `document_sections`（2026-10-09 修改，见 P2-B2 设计 §3）。

### 5.3 修订与合入

- `document_revisions`：document_id、version、snapshot（jsonb：标题与全部小节）、summary、author_member_id、merged_from_document_id（可空）、created_at。同一作者 5 分钟内的自动保存合并为一条。
- 人工合入（P2-B2）不建 `document_merges`：合入状态记在 `document_affected_nodes`（merge_status、merged_revision_id），合入产生的模块文档修订带 merged_from_document_id。Agent 起草合入提案（P5）时再确定提案的存储（2026-10-09，见 P2-B2 设计 §4、§5）。
- 流程：变更 PRD 上线后，按功能点把来源小节的内容合入模块文档（逐个应用或跳过），全部处理完时 PRD 变为 merged。试验回滚的变更 PRD 标记为 discarded，不合入。

### 5.4 模板

`document_templates`：org_id、product_id（可空）、kind、name、body（markdown，支持 `{{date}}`、`{{author}}` 等占位符）、sections（jsonb：`[{heading, required, guidance}]`）、active。

sections 供 Agent 逐节写作，并由系统校验必填小节是否齐全。

### 5.5 外部链接、产品资源与附件

- `external_links`：org_id、target_type（requirement / document / iteration / release / task）、target_id、kind（figma / wecom_doc / git_pr / git_commit / url）、url、title、meta（jsonb：如 Figma 的 fileKey 和 nodeId、仓库名和 PR 号）、created_by。
- `product_resources`：org_id、product_id、kind（git_repo / figma_file / component_library / doc_site / other）、name、url、config（jsonb：分支、包含和排除路径等）、credentials（加密）、index_enabled。Agent 通过 MCP 列出资源后自行读取代码或调用 Figma MCP，Flower 只保存结果链接。
- `attachments`：org_id、target_type、target_id、storage_key、filename、mime、size_bytes、width、height、uploader_member_id。存储适配器：本地卷（默认）/ S3 兼容。

## 6. 平台层

### 6.1 领域事件（兼审计日志）

- `domain_events`：id（UUIDv7）、org_id、product_id、type（如 `requirement.state_changed`）、subject_type、subject_id、actor_member_id、actor_token_id、payload（jsonb，含 `schemaVersion`；修改类事件含 `changes: [{field, old, new}]`）、occurred_at。
- 与业务修改在同一事务内写入（outbox 模式）。
- `event_deliveries`：event_id、consumer（notifications / search_index / webhooks / member_notifications）、status、attempts、next_attempt_at、last_error。投递保证至少一次，消费方必须幂等。

### 6.2 通知中心

| 表 | 关键字段 |
|---|---|
| `notification_channels` | org_id、kind（wecom_robot / feishu_robot / dingtalk_robot / webhook / email）、name、group_label（所属群，仅用于展示）、config（加密：URL、签名密钥）、rate_limit_per_min（企微默认 20）、allowed_product_ids（为空表示全部产品）、enabled |
| `notification_rules` | org_id、product_id、name、event_types[]、filter（jsonb）、channel_ids[]、template_id、enabled |
| `notification_schedules` | org_id、product_id（可空）、name、cron、timezone、source（daily_report / new_requirements / overview_card / http）、source_config、channel_ids[]、template_id、enabled |
| `message_templates` | org_id、format（text / markdown / card / image）、body |
| `notification_deliveries` | rule_id 或 schedule_id、channel_id、event_id（可空）、status、attempts、response、sent_at |
| `member_notifications` | member_id、event_id、read_at（站内通知：被 @、被指派等） |
| `member_notification_prefs` | member_id、event_type、channels（站内 / 邮件） |

- 一个通道对应一个 webhook。同一企微群的多个机器人登记为多个通道，按 group_label 归组展示。每个通道单独排队限流。
- 通道由组织管理员登记；通知规则可以由产品 admin 在本产品内配置，只能选择对本产品可用的通道。
- 不支持"执行脚本"作为内容来源。"http"来源只允许实例管理员配置，且受白名单限制。
- 外部触发：用 API Token 调用"立即执行某个定时推送"，取代 push 的 `/trigger/:id`。

### 6.3 知识库

- `kb_chunks`：org_id、product_id、source_type（document_section / requirement / comment / resource_file）、source_id、content、tsv（tsvector，jieba 分词）、embedding（vector，可空）、content_hash、updated_at。
- P0 只建表，并由 worker 消费事件，增量维护文档和需求的全文索引。向量检索与混合排序后置。
- 检索按查询者可见的产品过滤。

### 6.4 双向链接

- 正文语法：`[[PAN-123]]`、`[[PAN-PRD-12]]`、`[[PAN-PRD-12#小节]]`、`[[PAN-T-12]]`（任务）、`[[迭代:名称]]`、`[[业务域/模块/功能点]]`。需求描述、文档、评论中均可使用。细则见 P2-B1 设计（2026-10-09 修改：文档与任务编号带产品前缀，增加任务与迭代）。
- `entity_links`：org_id、source_type、source_id、source_section（可空）、target_type（可空）、target_id（可空）、target_text、context（引用处所在的一句）、origin（wikilink / system / manual）。
- 保存时解析 wikilink 并重建该来源的链接。目标暂不存在时 target_id 为空，之后创建同名对象时自动接上。存目标 id，改标题不断链；旧编号通过 `entity_aliases` 解析。
- 需求与变更 PRD 的关联等系统生成的链接，以 origin = system 写入同一张表，反向链接面板一次查全。功能点的合入历史由 `document_affected_nodes` 与修订的 merged_from_document_id 读出，不写入本表（2026-10-09，见 P2-B2 设计 §5）。
- 检索时可沿链接扩展上下文。关系图谱视图后置。

### 6.5 设置页面

| 层级 | 可进入者 | 内容 |
|---|---|---|
| 实例设置 | 实例管理员 | 注册开关、组织创建权限、HTTP 取数白名单 |
| 组织设置 | 组织 owner / admin | 成员与邀请、职能标签、流程模板、字段字典、层级叫法、文档模板、通知通道、产品资源与凭据、Agent 成员及 Token |
| 产品设置 | 产品 admin | 流程覆盖与升级、字段覆盖、结构树、通知规则 |
| 个人设置 | 所有人 | 资料、密码、个人 Token、通知偏好、界面偏好 |

敏感值加密存储，界面只显示部分字符，可以替换但不能再查看原文；修改记入领域事件。

### 6.6 管理员数据看板

具体指标后续讨论。数据模型已保证以下指标可计算：

| 指标 | 数据来源 |
|---|---|
| 需求流速、流动时间、在制品数量 | `state_transitions` + 状态类别 |
| 版本按期达成率 | `releases.baseline_date` 与 `released_at` 比较 |
| 迭代承诺完成率 | `iteration_scope_snapshots` + 状态类别 |
| 专项完成率 | 专项内需求按状态类别统计 |
| 评审效率、驳回率 | `check_item_results` / `check_item_signoffs` + 领域事件 |

先按需实时计算；数据量增大后加每日快照表，不影响现有结构。

### 6.7 AI 能力

Flower 中的 AI 分两类：

- **外部 Agent**（经 MCP 接入）：模型和费用在 Agent 一侧，Flower 不需要配置 key。
- **内置 AI 功能**（页面内起草 PRD、合入提案、AI 预审、语义查重、别名生成、知识库向量检索）：由 Flower 调用模型，需要配置 key。

**能力分层**：

| 配置 | 可用能力 |
|---|---|
| 无 key | 全部业务功能、MCP、知识库全文与双链检索 |
| 配置对话模型 | 以上 + 页面内 AI 功能 |
| 再配置向量模型 | 以上 + 知识库语义检索 |

未配置时 AI 入口不隐藏，点开后提示由组织管理员在"组织设置 → AI"中配置。界面标明每次使用的模型。

**key 的层级**：组织级为主；实例级可配默认值兜底，组织已配置时优先用组织的；暂不支持个人 key。

**表**：

| 表 | 关键字段 |
|---|---|
| `ai_providers` | org_id（为空表示实例默认）、kind（anthropic / openai_compatible）、name、base_url、api_key（加密）、models（jsonb） |
| `ai_model_assignments` | org_id、purpose（writing / fast / embedding）、provider_id、model |
| `ai_usage` | org_id、member_id、feature、provider_id、model、input_tokens、output_tokens、cost_estimate、at |

组织可设置月度额度上限（`organizations.settings.aiMonthlyBudget`），超出后内置 AI 功能暂停并提示。

**实现时机**：与第一个内置 AI 功能一起实现，P0 不包含。push 现有的 AI 预审和别名生成，迁移时只迁历史结果，功能届时接回。

**非功能性需求（后续再定）**：启用 AI 后，界面展示和动效要有明显区别，给用户"切换到智能模式"的感受。

## 7. 旧数据迁移

### 7.1 方式

- 迁移脚本放在仓库内，可重复执行，同样输入得到同样结果。输入为三个生产库的只读副本（拉取副本前需征得同意，因含员工个人信息）。
- 每次执行输出对账报告：各表迁移前后数量、人员对照表、需求匹配结果、字段冲突清单、未映射数据。
- 演练 → 核对报告 → 修正规则 → 再执行，直至对账通过。

### 7.2 映射

**组织与人员**

- 组织"123云盘"，产品"123云盘"，key 为 `PAN`。平台（PC客户端 / 移动端 / Web端 / 小程序 / 后端）是字典选项，不是产品。
- 三边账号与旧数据中的名字字符串（提出人 63、负责人 8、开发 19，以及甘特任务负责人、签字人）合并去重为成员，生成人员对照表供确认。无法对应账号的建为无账号成员。
- 密码不迁移，所有人通过邀请链接重新设置。
- 角色：123plane admin → admin；member → member；viewer → member + 产品 viewer。push 超管 → admin；线条负责人 / PM / UI → 职能标签。123plane 的 role_permissions / user_permission_overrides 不迁（从未生效）。

**需求合并**

- 以 123plane 的 684 条为主体。push 的 328 条先按 plane_id 匹配（255 条已填），其余按归一化标题（去空白和中英文标点）完全相等匹配；仍未匹配的作为新需求导入。
- 字段冲突：标题、描述、优先级、负责人以 123plane 为准；评审、迭代、排期以 push 为准。冲突全部列入报告。
- 新编号 `PAN-1…` 重新生成，旧编号存 legacy_key 并写入 entity_aliases。

**流程 v1（123云盘）**

| 状态 | 类别 | 分组 |
|---|---|---|
| 收集、待评估、已评估 | backlog | 分析 |
| 待设计、待开发 | unstarted | 开发 |
| 设计中、开发中、测试中 | started | 开发 |
| 已上线 | completed | 开发 |
| 已拒绝、已搁置 | canceled | — |

检查项：背景、可行性、行业（对应 push 评审 e1–e3，对应关系在脚本中核实；123plane 的 feasibility_status 并入"可行性"）、设计签字（会签：UI / 线条负责人 / 产品负责人 / 饶总）、PRD、AI 预审（22 条结果存入 meta）。

push 主状态映射到检查项与迭代：评审中 → 检查项 in_progress；已通过 → passed；待修订 → rejected；已进版本 → passed 并设置 iteration_id；已搁置 → 主状态已搁置（仅对 push 独有需求生效）。

**PRD**

- 外部 PRD 链接迁移为外部 PRD（2026-10-08 修改，原决定为不迁移）：123plane 的 prd_link 与 push 的 prd_url 按规范化网址去重，建成 `source = external` 的变更 PRD 并挂到对应需求；两边网址不一致时以 123plane 为准，差异写入对账报告。详见 `2026-10-08-flower-p2a-change-prd-design.md` §6。
- 123plane 的 prd_status 迁移为"PRD"检查项的状态；需求挂上 PRD（prd 系统页面或外部链接）后，该项改为跟随 PRD 状态，改写前后不同的列入对账报告（P2-A）。
- prd 系统的 11 份未删除页面 → 变更 PRD 正文文档，连同 114 条修订、99 个附件、6 条评论（anchor_state = unanchored）。

**迭代与发布版本**

- 发布日期相同的 123plane 迭代与 push 迭代合并为一个，名称用 push 的叫法（例：V2026.07.1 与迭代0721、V2026.07.2 与迭代0804）。
- 完全重复的合并（V2026.03.1 与 V2026.04.1）。其余冲突（如 V2026.06.23 与 V2026.05.2 重叠）列入报告逐个决定。
- 已过结束日期的迭代，状态按日期修正为 done；基线取迁移时的结束日期。
- "专业空间版本发布"导入为组织级专项。
- 123plane versions（14）→ releases；requirement_versions（37）→ requirement_releases。

**其他**

| 旧数据 | 目标 |
|---|---|
| 子任务 14、甘特任务 359 | tasks（概览手动覆盖值存 meta） |
| 评论 199、进展更新 76、迭代日志 7 | comments（kind = comment / update） |
| 评论已读 1444 | comment_reads（按邮箱对应成员） |
| 简报 12（HTML） | 需求附件 |
| 活动日志 4134、变更日志 236 | domain_events（type = `legacy.*`，原始数据保存在 payload） |
| push groups 2 + 123plane 设置中的 webhook | notification_channels |
| push tasks 3 + 123plane 日报 / 汇总设置 | notification_schedules |
| push 推送日志 111 | notification_deliveries |
| prd_domains 23 + 123plane business_domain 取值 | structure_nodes 第一层（名称合并去重）；未填业务域的 194 条需求 node_id 为空 |
| 通知队列、同步收件箱和发件箱 | 不迁 |

### 7.3 按 2026-09-29 生产数据核实后的补充

以生产库只读副本核实 §7.2，补充以下规则：

- 数据量以迁移时的实际记录为准，对账报告按记录数核对，不写死数量。当时的数量为：123plane 需求 688 条，push 需求 335 条（其中 8 条已在 push 内标记合并），甘特任务 363 条，设计签字 320 条。
- 需求合并：push 有 249 条按 plane_id 匹配，2 条按标题匹配，约 76 条为 push 独有需求，迁移后约 764 条。
- push 主状态"待排期"：背景、可行性、行业三个检查项保持 not_started。主状态以 123plane 为准；push 独有需求的主状态为"待评估"。
- 123plane 历史上物理删除的需求（activity_log 中 83 条 deleted）不恢复为需求，只随 activity_log 迁入 domain_events。
- 迭代：迭代0624 与 V2026.06.2（发布日期相差一天）合并，名称用"迭代0624"。"专业空间优化"与"专业空间版本发布"一样，导入为组织级专项。其余没有对应的迭代单独导入。
- 会签代签：`check_item_signoffs` 增加 `acted_by_member_id`（可空），记录实际操作人。`signer_member_id` 记被代签的人。"代饶总 by ×××"按此迁移。
- 平台、业务域、人员去重、迭代配对由迁移脚本根据数据生成建议对照表，用户审阅修改后重新执行迁移，不在代码中写死：
  - 平台是 42 种逗号拼接组合，含鸿蒙、TV端、H5、管理后台、全端等值。
  - 业务域存在同义词，prd_domains 中有 8 个在 123plane 未出现。
  - 同一字段中写了多名负责人的情况，也在人员对照表中处理。
- 123plane 优先级"绿色通道"作为优先级字典的新增选项。
- push 需求的 `line`（功能 / 商业）写入内置字段 line。push 独有字段 `alias` 存入需求的 legacy 元数据。
- push AI 预审结果（22 条）存入"AI 预审"检查项结果的 meta。
- 123plane 发布版本没有计划发布日期，历史版本的"按期达成率"不可计算，只对迁移后新建的版本生效。
- 迁移脚本的状态映射按源码定义的完整取值编写，不只覆盖数据中出现过的值。

## 8. 分阶段

| 阶段 | 内容 |
|---|---|
| P0 | monorepo（`apps/web`、`packages/core`、`packages/mcp`）；§2 租户与身份、§3 可配置定义；RLS；领域事件表；docker compose（app + postgres）；初始化向导 |
| P1 | §4 需求、迭代、任务；迁移脚本与对账报告。分两段：P1-A 数据模型、服务、接口、迁移与对账，加需求列表与详情界面；P1-B 迭代、发布版本、甘特、工作台、评审会签界面。P1 用生产数据副本验证：迁移对账、日常操作新旧对比、真实数据量下的界面、用户试用 |
| P2 | §5 文档 |
| P3 | §6.2 通知中心（先接测试群 webhook 联调，正式环境切换另行安排）；基础数据看板（§6.6 中已可计算的指标） |
| P4 | OpenAPI + MCP server |
| P5 | 知识库（向量检索）、Agent 按模板起草 PRD、合入提案 |
| P6 | b123 数据联动、管理员看板完善 |

每个阶段结束时都要有可操作的界面，用来验收该阶段交付的用户价值（见 `docs/story-map/flower-story-map.html`）。P0 的验收演示对象是管理员。P3 完成前，新旧系统并行运行。

## 9. 待定事项

- 资源级权限规则（§2.2），在各模块设计时决定。
- 管理员看板的具体指标与图表。
- push 评审 e1–e3 与"背景 / 可行 / 行业"的对应关系，在迁移脚本中核实。
- 迭代合并后剩余冲突的逐个决策。
