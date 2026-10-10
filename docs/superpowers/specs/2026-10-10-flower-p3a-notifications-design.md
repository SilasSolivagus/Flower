# Flower P3-A 设计：推送（通道、事件规则、定时推送、模板与发送记录）

日期：2026-10-10
上位文档：`docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§6.1 领域事件、§6.2 通知中心、§7.2 迁移映射、§8 分阶段）。本文只写 P3-A 的范围，以及在上位文档基础上补充或改变的决定。

## 1. 范围

P3 拆为两段：
- **P3-A（本文）**：通道、事件规则（即时与合并到摘要）、定时推送、消息模板、发送记录与后台发送，以及 push / 123plane 推送配置的迁移。做完即可替代 push 的推送。
- **P3-B**：站内通知（被 @、被指派等）与个人通知偏好，基础数据看板。

不在 P3-A 内：站内通知与个人偏好、数据看板、AI 日报（P5）、飞书与钉钉机器人、「http」内容来源。

## 2. 用户已确认的决定（2026-10-10）

| 主题 | 决定 |
|---|---|
| 拆分 | P3-A 推送；P3-B 站内通知与看板 |
| 推送内容 | 概览卡片、新需求（替代 push）；事件即时推送；变更摘要（合并推送）；邮件通道 |
| 发送方式 | 应用进程内的后台循环，任务存数据库（发送记录即发件队列）；多实例时用数据库锁保证同一条只发一次 |
| 设计五节 | 通道、事件规则、定时推送、模板与发送记录、迁移与联调，按 2026-10-10 对话确认的内容 |

旧数据（2026-10-10 只读核实）：push 有 2 个群机器人；3 个定时任务（工作日 19:00 概览卡片推 2 个群，启用；工作日 10:00 概览卡片，停用；每天 9:30 新需求推 1 个群，启用）；115 条推送日志，全部成功。123plane 有需求与日报两个企微 webhook 设置、变更摘要时间表（为空，即已停用）、通知队列 67 条、SMTP 设置。

## 3. 通道

- 表 `notification_channels`（租户表，开 RLS）：`org_id`、`kind`（wecom_robot / webhook / email）、`name`、`group_label`（所属群，仅用于展示）、`config`（加密）、`config_hint`（脱敏展示文本）、`rate_limit_per_min`（企微默认 20，其余默认 60）、`allowed_product_ids`（空数组表示全部产品）、`enabled`、`created_at`、`updated_at`。
- `config` 的明文结构：
  - wecom_robot：`{ url }`；
  - webhook：`{ url, secret? }`，有 secret 时请求带 HMAC-SHA256 签名头；
  - email：`{ host, port, secure, user, pass, from, to[] }`。
- 加密：用实例密钥 `FLOWER_SECRET_KEY` 派生的密钥做 AES-256-GCM，存为带版本号的密文。界面与接口只返回 `config_hint`（如 `…/send?key=****abcd`），不返回明文；修改时可只改非敏感字段，敏感字段留空表示不变。
- 权限：组织管理员登记、修改、停用、删除（有发送记录或被规则引用时只能停用）。产品管理员配置规则时只能选对本产品可用、且已启用的通道。
- 「发送测试消息」：组织管理员可以对一个通道发一条固定内容的测试消息，结果写入发送记录。

## 4. 事件规则

- 表 `notification_rules`（租户表，开 RLS）：`org_id`、`product_id`、`name`、`event_types`（数组）、`filter`（jsonb）、`channel_ids`（数组）、`template_id`（可空，空时用默认模板）、`mode`（immediate / digest）、`digest_schedule_id`（mode = digest 时必填）、`enabled`。
- 可订阅的事件类型（取自现有领域事件）：`requirement.created`、`requirement.state_changed`、`requirement.field_changed`、`requirement.assignment_added`、`requirement.iteration_changed`、`document.status_changed`、`check_item.signed`、`release.released`、`iteration.status_changed`。
- 过滤：`filter` 支持按需求状态（变化后的状态键）、优先级、业务域节点、文档状态、字段名（只看这些字段的变化）组合，各条件之间为「且」，同一条件内多个值为「或」。
- 匹配时机：领域事件写入时，在同一事务内查本产品启用的规则；命中的即时规则写入待发的发送记录；命中的摘要规则写入 `notification_digest_items`（`org_id`、`rule_id`、`schedule_id`、`event_id`、`created_at`、`consumed_at`）。事件本身不跨产品；组织级事件不参与规则。
- 权限：产品管理员管理本产品的规则；只读 Token 不能写。

## 5. 定时推送

- 表 `notification_schedules`（租户表，开 RLS）：`org_id`、`product_id`（可空）、`name`、`cron`（5 段）、`timezone`（默认 Asia/Shanghai）、`source`（overview_card / new_requirements / digest）、`source_config`（jsonb）、`channel_ids`、`template_id`（可空）、`enabled`、`next_run_at`、`last_run_at`、`last_success_at`、`consecutive_failures`、`fail_threshold`（默认 1）、`alert_state`。
- 内容来源：
  - **概览卡片**（企微模板卡片）：版式对齐 push 现有概览卡片；数据为本产品当前迭代与需求概况，具体字段在计划中按 push 实际输出核对确定。
  - **新需求**（markdown）：上次成功推送以来新建的需求列表（编号、标题、提出人、链接），没有新需求时按配置决定不发或发「今日无新需求」。
  - **变更摘要**：取本计划下未消费的摘要条目，按需求分组合并成一条，发送成功后标记已消费；没有条目时不发。
- 执行：后台循环按 `next_run_at` 判断到点，到点后生成内容、为每个通道写入待发的发送记录，并算出下一次时间。
- 立即执行：组织管理员（组织级）或产品管理员（本产品）可以手动执行；也可以用 API Token 调用接口执行（需要写权限），取代 push 的 `/trigger/:id`。
- 失败告警：连续失败次数达到 `fail_threshold` 时 `alert_state` 记为告警，在定时推送列表与发送记录中标红；站内提醒在 P3-B 接上。

## 6. 模板与发送记录

- 表 `message_templates`（租户表，开 RLS）：`org_id`、`name`、`format`（text / markdown / template_card / email）、`body`（模板文本，template_card 为 JSON 模板）、`builtin`（预置，不可删）。变量用 `{{path}}` 语法，只做字段替换与按列表重复，不执行代码。每种内容来源和事件规则各有预置默认模板。
- 表 `notification_deliveries`（租户表，开 RLS）：`org_id`、`rule_id` 或 `schedule_id`（至少一个，测试消息两者皆空并标 `kind = test`）、`channel_id`、`event_id`（可空）、`payload`（渲染后的请求体）、`status`（pending / sending / sent / failed / dead）、`attempts`、`next_attempt_at`、`response`（截断到 2000 字）、`sent_at`、`created_at`、`legacy_key`。
- 重试：失败按 30 秒、2 分钟、10 分钟、1 小时退避，最多 5 次，之后记为 dead。企微返回限流错误时按限流处理，不计入失败次数。
- 限流：每个通道按 `rate_limit_per_min` 滑动窗口计数，超出的留到下一轮。
- 后台循环：应用进程启动时启动，每 5 秒运行一次：用 `FOR UPDATE SKIP LOCKED` 取一批到期的 pending 记录改为 sending 后发送；同一轮检查到点的定时推送（用 advisory lock 保证同一个定时推送不被两个实例同时执行）。进程退出前停止取新任务。测试与 e2e 环境可以关闭循环、改为手动驱动。
- 发送记录页（组织设置）：按通道、来源、状态、时间筛选；单条可以「重发」（复制为新的 pending 记录）。
- 实现补充（2026-10-10，见 P3-A 计划「设计决定」）：`notification_deliveries` 增加 `kind`（rule / schedule / test）与 `run_id`（同一次定时执行的记录共享，用于执行结果与告警）；`notification_digest_items` 增加 `run_id`；`notification_schedules` 增加 `last_error`；`message_templates` 增加 `builtin_key`（预置模板的用途）。P3-A 的三种内容来源都要求选择产品。

## 7. 迁移与联调

- 迁移映射（迁移工具 `legacy import` 增加）：
  - push `groups` → wecom_robot 通道（`group_label` 取群名）；
  - push `tasks` → 定时推送（cron、时区、来源 overview → overview_card、newreqs → new_requirements；保留启用状态）；`task_targets` → 通道关联；
  - push `push_logs` → 发送记录（status = sent，`legacy_key` 记原 id）；
  - 123plane `wecom_requirement_webhook_url`、`wecom_daily_webhook_url` → wecom_robot 通道；`wecom_digest_schedule` → digest 定时推送（为空则停用）；SMTP 设置与收件人 → email 通道；`notification_queue` 不迁。
- **迁移来的通道一律停用**（`enabled = false`）：它们是生产群的地址，开发阶段不能误发；正式切换另行安排。
- 联调：用户提供测试群 webhook，在本地登记为测试通道；每次「发送测试消息」或「立即执行」前先征得用户确认。三种格式（文本、markdown、模板卡片）各验证一次。
- 对账报告增加「推送」一节：通道、定时推送、发送记录的数量。

## 8. 验证

- 单元测试：加密往返与脱敏；规则匹配与过滤；cron 下一次时间（含时区）；摘要合并；模板渲染（含缺字段）；限流窗口；重试退避；`SKIP LOCKED` 下并发取任务不重复。
- 接口测试：权限（组织管理员、产品管理员、编辑、只读、只读 Token）；明文配置不出现在任何响应里。
- 端到端测试：用本地假 webhook 接收端（不连外网）验证测试消息、即时规则、立即执行定时推送、失败重试与发送记录页；1440 与 760 两种宽度。
- 迁移：在 pan123 上试跑，核对数量；迁移来的通道全部停用。
- 联调：在测试群上验证三种格式（需用户确认后发送）。
