# Flower P2-A 设计：变更 PRD（Flower 内文档与外部文档）

日期：2026-10-08
上位文档：`docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§3 检查项、§4.5 评论、§5 文档、§7 迁移）。本文只写 P2-A 的范围，以及在上位文档基础上补充或改变的决定；未提到的内容沿用上位文档。

## 1. 范围

P2 拆为两段：
- **P2-A**：变更 PRD。PRD 可以写在 Flower 里，也可以只是外部文档的链接。覆盖：编辑与修订、评审会签、需求打通、模板、附件、导入，以及旧数据迁移。
- **P2-B**：模块文档（按功能点分节）、影响声明（`document_affected_nodes`）、人工合入（`document_merges`）、`[[双链]]` 与反向链接。

## 2. 用户已确认的决定（2026-10-08）

| 主题 | 决定 |
|---|---|
| 拆分 | P2-A / P2-B，如上 |
| 编辑权限 | 产品编辑及以上可以修改任何人创建的 PRD。每次修改都留下修订记录，可以恢复到任一历史版本。只读成员与只读 Token 不能修改，但可以评论（沿用 P1） |
| 修改记录 | 提供版本列表（作者、时间、摘要）、任选两版按小节对比、一键恢复。同一作者 5 分钟内的自动保存合并为一版 |
| 「PRD」检查项 | 跟随 PRD 状态自动更新，覆盖的每条需求同步。被 PRD 覆盖的需求不能手动改这一项；没挂 PRD 的需求照旧手工维护 |
| 评审签字 | 使用现有检查项会签，scope = document 的结果挂在 PRD 上，覆盖的需求共享 |
| 模板 | 组织级模板库，可按产品覆盖。每个模板列出小节及是否必填，提交评审时检查必填小节。预置一份与旧 prd 一致的模板（变更记录 / 背景 / 产品概述 / 需求说明） |
| 评论定位 | 选中正文文字发表评论，记录引用的原文片段与所在小节（W3C 文本引用方式）。原文改动后评论标为「已失效」，不删除。也可以对整篇评论，支持回复和标为已解决 |
| 大文档 | 先测再定：计划第一个任务用最大的旧 PRD（约 8 万字以上）测 BlockNote 的加载与输入延迟；超过阈值时改为按小节懒加载。正文仍以 markdown 为唯一数据源 |
| 外部 PRD | PRD 的正文可以放在 Flower 外。外部 PRD 是完整的 PRD：有状态流转、覆盖需求、会签检查项、「PRD」检查项联动、评审表、「等我签字」、整篇评论。没有的只是正文编辑、修订历史、对比、恢复、划词评论和必填小节检查 |
| 转为 Flower 文档 | 外部 PRD 可以通过三种方式转为 Flower 内的文档：粘贴（保留标题、列表、表格、图片，图片转存为附件）、上传 Markdown、上传 Word（.docx）。原链接保留在文档上。不自动抓取外部平台内容，因为需要登录授权 |
| 旧外部链接 | 改变上位文档 §7 的原决定：123plane `prd_link` 与 push `prd_url` 迁移为外部 PRD，见 §6 |

## 3. 数据模型（在上位文档 §5 基础上的增补）

- `documents` 增加以下字段：
  - `source`：`native | external`；
  - `external_url`、`external_provider`：取值 wecom / feishu / tencent_docs / notion / yuque / google_docs / other，按网址识别。

  其余约定：
  - `source = external` 时，`current_revision_id` 为空，也没有正文与修订。
  - 转为 Flower 文档时，`source` 改为 native，同时生成第一个修订，`external_url` 保留。
  - 网址唯一性：同一产品内，同一个外部网址只能对应一份 PRD（对网址做规范化：去掉追踪参数和末尾斜杠）。
- 文档编号：按产品自增，由 `products` 上新增的 `document_seq` 以 `update … returning` 分配，与需求编号的做法一致。显示格式在计划中确定。
- 状态：变更 PRD 的状态为 draft / review / approved / launched / merged / discarded。其中 `merged` 在 P2-A 中不会出现（合入属于 P2-B），状态机保留这个值。
- 「PRD」检查项的自动映射：
  - draft、review → in_progress
  - approved、launched、merged → passed
  - discarded → not_needed

  PRD 状态变更、需求被加入或移出覆盖时，在同一事务内更新受影响需求的检查项结果，并记录事件。
- 修订：`document_revisions.snapshot` 保存标题和正文 markdown。恢复历史版本时，以旧快照为内容新建一个修订，摘要写「恢复到第 N 版」，并记录 `document.restored` 事件。
- 对比：服务端按小节（标题层级）切分，逐段计算差异，返回新增、删除、修改三类。
- 评论：复用 `comments` 表。`target_type = document`，`anchor = {quote, prefix, suffix, sectionHeading}`，`anchor_state` 取 ok / stale / unanchored。保存新修订时重新定位评论；找不到原文时标为 stale。
- 附件：使用 `attachments` 表，存储适配器先实现本地卷。图片上传有大小与类型上限，具体值在计划中确定。
- 模板：使用 `document_templates` 表。必填小节的校验在 draft → review 时执行，缺少时报中文错误并列出缺少的小节。外部 PRD 不做这项校验。

## 4. 权限

| 操作 | 权限 |
|---|---|
| 新建、编辑正文、改状态、改覆盖需求、恢复版本、导入 | 产品编辑及以上 |
| 评论 | 产品只读成员及以上 |
| 模板管理 | 组织管理员（产品级覆盖由产品管理员负责） |
| 只读 Token | 一律不能写 |

## 5. 界面

- 侧栏「文档」入口启用。
- 文档列表：按状态、负责人、来源筛选。
- 文档详情：
  - Flower 内的 PRD 使用 BlockNote 编辑器，自动保存，乐观锁冲突时提示；
  - 外部 PRD 显示链接卡片，以及「转为 Flower 文档」入口。
- 右侧栏：状态流转、覆盖的需求、检查项（会签）、修订记录（版本列表、对比、恢复）。外部 PRD 没有修订记录。
- 选中文字后弹出「评论」入口；评论区显示失效标记。
- 组织设置新增「文档模板」页。
- 需求详情显示所挂的 PRD（标题、状态、来源），并提供「新建 / 关联 PRD」入口。

## 6. 迁移

- **prd 系统**：11 份未删除页面导入为 Flower 内的 PRD，连同：
  - 114 条修订
  - 99 个附件
  - 6 条评论（anchor_state = unanchored）
  - 1 条需求关联

  状态取 `prd_meta.status`：draft → draft，review → review，approved → approved，in_dev → approved，launched → launched。当前数据是 6 份 draft、5 份 launched。

  附件文件需要从服务器的 `prd_uploads` 卷只读导出到 `.local-data/`，导出前单独征得用户确认。
- **外部链接**：
  - 123plane `prd_link`：187 条，164 个不同网址；
  - push `prd_url`：115 条，105 个不同网址。

  规则：
  - 按规范化后的网址去重，每个网址建一份外部 PRD，挂到所有用到它的需求上。
  - 一条需求在两个系统里的网址不同时，以 123plane 为准，另一个写入对账报告。
  - 一条需求最多挂一份 PRD；冲突写入对账报告。

  外部 PRD 的状态由所挂需求在 123plane 的 `prd_status` 推出，规则在计划中确定，并写进对账报告。
- 迁移改变了上位文档 §7「外部 PRD 链接不迁移」的决定，上位文档同步修改。

## 7. 验证

- 第一个任务是大文档性能基线：用最大的旧 PRD 测 BlockNote 的加载时间与输入延迟，确定是否需要按小节懒加载。
- 单元测试与端到端测试覆盖以下内容：
  - 权限（编辑、只读、只读 Token）
  - 乐观锁冲突
  - 修订合并与恢复
  - 两版对比
  - 「PRD」检查项随状态联动
  - 外部 PRD 的全部流程
  - 三种导入方式
  - 必填小节校验
  - 划词评论与失效标记
- 最后一个任务在 pan123 上导入真实数据并复测，覆盖 1440px 与 760px 两种宽度。
