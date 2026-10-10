# Flower P2-B2 模块文档、影响声明与人工合入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个模块节点有一份按功能点分节的模块文档（与变更 PRD 共用编辑器、修订、对比、`[[ ]]` 链接与评论）；变更 PRD 声明影响哪些功能点及每个功能点的来源小节，声明时可以当场新建模块与功能点；PRD 上线后在合入页逐个功能点「应用」或「跳过」，全部处理完时 PRD 变为「已合入」；`[[业务域/模块]]`、`[[业务域/模块/功能点]]` 链接到模块文档（及其小节）。

**Architecture:** 模块文档就是 `documents` 里 `kind = 'module'` 的行（`node_id` 指向第二层节点，部分唯一索引保证每个模块一份），状态 `active` / `archived` 并入同一个 `status` 列与 `transitionDocument`。新租户表 `document_affected_nodes`（RLS）同时承载影响声明与合入状态。模块文档的小节定位、替换、插入、删除、改名与 PRD 来源小节的提取是 `packages/core/src/documents/module-sections.ts` 里的纯函数；`module-docs.ts`（新建、列表、功能点改名同步）、`affected.ts`（声明的增删改、当场新建节点）、`merge.ts`（合入页数据、应用、跳过、撤销、合入记录）是服务层，合入与改名经 `documents.ts` 新导出的 `commitSystemRevisionTx` 写修订（`merged_from_document_id`、重新定位评论、重建链接）。页面：文档列表加「模块文档」页签，详情页按 `kind` 切换侧栏，PRD 侧栏加「影响的功能点」，新增合入页 `/{org}/documents/PAN-PRD-n/merge`，结构树页签的模块行显示模块文档链接；编辑器只在模块文档归档时多一个只读条件。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui、BlockNote 0.55（沿用 P2-A/P2-B1 的编辑器，不改）、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-09-flower-p2b2-module-docs-design.md`（用户 2026-10-09 确认，本计划的约束来源）；上位文档 `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§4.1 结构树、§5 文档、§6.4 双向链接）、P2-A 设计 `docs/superpowers/specs/2026-10-08-flower-p2a-change-prd-design.md`、P2-B1 设计 `docs/superpowers/specs/2026-10-09-flower-p2b1-links-design.md`。逐条决定见下方「设计决定」，与代码或上位文档不一致之处见文末「与代码或数据的冲突」。

## Global Constraints

- 真实数据只在本地开发库的组织 pan123 上操作：数量核对一律用只读查询 `docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select …"`；应用迁移用 `pnpm db:migrate`。本计划不重导数据，任何步骤都不使用 `--replace`。不连接、不操作任何服务器。
- `.local-data/` 存放生产数据副本与对账报告（含员工个人信息），不提交；计划、验证记录、提交信息只写数量，不写姓名、邮箱、标题或正文。测试与文档示例只用虚构内容和 `@example.com` 邮箱。
- 执行代理不得对开发库运行 `pnpm dev`。界面检查一律写成 Playwright 端到端用例（端到端用独立的 `flower_e2e` 库与 3100 端口）；真实数据上的最终界面复验由控制方完成（Task 15 的 STOP 步骤），在一份测试用 PRD 与复验专用的结构树节点上进行，不修改迁移来的数据。
- 迁移文件：`0013_*.sql` 由 `pnpm --filter @flower/core db:generate` 生成（新表、唯一索引、检查约束）；`0014_p2b2_rls.sql` 用 `--custom` 生成后填写，为 `document_affected_nodes` 开启 RLS（参照 `0002_rls.sql`、`0010_p2a_rls.sql`、`0012_p2b1_rls.sql`）。执行中如发现还要改表结构，停下来报告。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`（实体 id 作为第三个参数的现有写法照旧），一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写；写操作同事务调用 `recordEvent`，修改类事件 payload 带 `changes: [{field, old, new}]`。`withSystem` 只用于登录、成员关系查找、Token 认证、邀请接受。
- 模块文档复用变更 PRD 的全部正文能力：`saveDocumentContent`（乐观锁、5 分钟内同一作者合并修订）、`restoreRevision`、`diffRevisions`、`syncSourceLinks`、`reanchorDocumentComments`、评论与「被引用」。合入与功能点改名产生的修订一律经 `commitSystemRevisionTx`（不与自动保存合并、版本号加一、重新定位评论、重建链接）；合入修订的 `merged_from_document_id` 为变更 PRD 的 id。
- 锁的顺序（避免死锁）：合入为「变更 PRD 行 → 声明行 → 模块节点行 → 模块文档行」；新建模块文档为「模块节点行 → 模块文档行」；功能点改名为「功能点行（UPDATE）→ 模块文档行」；正文保存只锁文档行。新增代码不得以其他顺序取这些锁。
- 面向用户的文案与错误信息用中文，错误通过 `AppError(code, message, details?)` 抛出。`apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`、`@flower/core/markdown`（含 `constants.ts` 的再导出）、`@flower/core/links`。本计划新增的 `module-sections.ts` 只在服务端使用，不加导出入口。纯逻辑放 `apps/web/src/features/**/model.ts` 并写 Vitest 单测。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`；用渲染期间调整（参照 `apps/web/src/app/(app)/[org]/settings/general/page.tsx`）、「本地草稿为空时用服务端值」或换 `key` 重新挂载。编辑器只在挂载时读取初始正文。
- **P2-A/P2-B1 编辑器与自动保存的不变量**（`apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`），模块文档用同一个编辑器，本计划一条都不能破坏，相关端到端用例（`documents-editor.spec.ts`、`documents-revisions.spec.ts`、`documents-import.spec.ts`、`documents-links.spec.ts`、`documents-anchors.spec.ts`）必须原样通过：
  - 保存返回 409 时：`blocked` 置为 true、清掉已排上的定时器，之后 `flush` 一开头就返回，不再发保存请求；冲突提示与只读状态保持到重新加载。
  - 卸载时补发的保存只用它自己的返回结果写缓存（`setQueryData` 写入的正文与版本号来自这次保存的响应），不读取组件状态。
  - 本页改标题后，只有返回的版本号恰好等于当前版本号 + 1 时才采用（`onRenamed`），否则留给下一次保存报冲突。
  - 编辑器只读时（只读成员、冲突后、本计划新增的「模块文档已归档」）不自动保存（`onDirty` 在 `!editable || blocked` 时直接返回）。
  - 正文里的 `data:` 图片先上传为附件、换成附件网址，再保存（`uploadDataImages` 在读取 `baseVersion` 之前完成）。
  - 非 409 的保存失败自动重试一次（`retried`），重试期间不显示错误。
  - 恢复版本与改状态之前先 `saveNow()`（等在途保存、立即保存没到时间的修改），用编辑器的版本号作为 `baseVersion`。
  - 装饰插件（链接卡、评论锚点高亮）只带元数据、不改文档：不改存储的 Markdown，不改 DOM 文本，不触发 `onChange` 与自动保存。
  - 本计划对 `editor-pane.tsx` 只改一处：`editable` 加上 `doc.status !== 'archived'`。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框、内联表单与合入页的卡片用 `silentError: true` + `<FormError error={mutation.error} />`。页面加载失败用 `components/load-error.tsx` 的 `QueryError`。
- 复用已有的共享件：`QueryError`、`FormError`、`PageHeader`、`EmptyState`、`ConfirmAction`、`DocumentStatusBadge`、`Backlinks`、`Revisions`、`formatDateTime`、`levelLabel`、`nodeOptions`；e2e `helpers.ts`（`ok`、`json`、`createProduct`、`createRequirement`、`createDocument`、`acceptInvite`、`readToken`、`login`、`setupInstance`、`expectNoPageOverflow`，以及本计划新增的 `createNode`、`launchDocument`）。不在文件之间复制逻辑块（状态卡片抽成 `status-card.tsx` 由两种侧栏共用）。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0`。
- 视觉沿用 P0-B：表格行高 40px（`h-10`）、隔行底色 `even:bg-zebra`、编号与日期用 `font-mono`、卡片圆角 6px（`rounded-md`）、按钮与输入框圆角 4px。
- 布局：页面本身不出现横向滚动；新页面与新区块有 Playwright 守护用例，在 1440 与 760 两个宽度下断言（`expectNoPageOverflow`）。
- 端到端测试：每个 spec 在 `beforeEach` 或用例开头调用 `resetDatabase()`；不为迁就定位器修改应用或共享组件代码；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染。改动共享组件或页面结构的任务，要在同一任务里改好受影响的现有 spec，不削弱原有断言。
- `pnpm test` 和端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；之后要对开发库做任何操作，先执行 `pnpm db:migrate`。
- 每个 commit message 末尾加一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）；实际执行提交的若不是 Claude Opus 5.5，把这一行换成实际模型的名字。完成一项工作后按 `CLAUDE.md` 在 `docs/agent-log.md` 最上面追加一条（Task 15）。

## 设计决定

数量均为 2026-10-09 对本地开发库（组织 pan123）的只读查询所得，查询形如 `docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select depth, status, count(*) from structure_nodes s join organizations o on o.id = s.org_id where o.slug = 'pan123' group by 1, 2"`。

| 项 | 决定 | 依据 |
|---|---|---|
| 模块文档的状态值 | `DOCUMENT_STATUSES` 改为变更 PRD 的六个（`CHANGE_DOCUMENT_STATUSES`）加 `active`、`archived`（`MODULE_DOCUMENT_STATUSES`），共用 `documents.status` 列（text，没有数据库约束，不需要迁移）。`DOCUMENT_TRANSITIONS` 增加 `active → archived`、`archived → active`，走现有 `transitionDocument`；`launched → merged` 仍不在手动流转里，只由合入自动完成。文档列表的状态筛选与地址栏校验改用 `CHANGE_DOCUMENT_STATUSES`，并开始显示「已合入」 | 设计 §3「状态：active / archived」；P2-A 列表筛选隐藏了当时不可达的 merged |
| 模块文档一份一个模块 | 部分唯一索引 `documents_module_node`：`(node_id) where kind = 'module' and deleted_at is null`；检查约束 `documents_kind_node`：`(kind = 'module') = (node_id is not null)`。只有第二层节点能有模块文档，服务端检查 | 设计 §3「唯一约束：`node_id`，`kind = module` 且未删除」；上位文档 §5.1「node_id（仅 module，必填）」 |
| 模块文档的字段 | 编号沿用产品的 `document_seq`（`PAN-PRD-n`）；`source = native`、负责人为空、无模板；标题在新建时取模块名称，之后可以像 PRD 一样改，模块改名不同步标题（列表按结构树显示模块名称）；第 1 版正文为空字符串（概述为空）。详情返回 `kind` 与 `node`（模块与所属业务域），`checkItems`、`requirements` 为空；对模块文档改检查项、签字、关联需求报错 | 设计 §3「编号沿用」「概述为空」；上位文档 §5.1 表「检查项 —」「不直接关联需求」 |
| 新建时机 | `createModuleDocument(db, actor, nodeId)` 幂等：已有则返回已有的那份。先锁模块节点行，再查再建，同一模块的并发新建排队。入口：模块文档页签点击没有文档的模块（「也可以手动新建」与这里是同一入口）、合入第一次应用到该模块。只读成员点击不新建，显示「未建」 | 设计 §3「新建时机」「权限：与变更 PRD 相同」 |
| 归档后只读 | `assertWritable`：已归档的模块文档拒绝保存正文、改标题与负责人、恢复版本、合入，报「模块文档已归档，恢复为使用中后才能修改」；评论、对比、查看修订照常；编辑器只读、隐藏「恢复」。功能点改名同步标题不受归档限制（保持小节与结构树一致） | 设计 §3「归档后只读，可以恢复为使用中」 |
| 小节定位 | 只按二级标题切分（`## `，围栏代码块内不算）；第一个二级标题之前为概述；三级及以下标题属于所在小节。标题按 `normalizeHeading`（去开头编号与全部空白）与功能点名称比较，同名取第一个 | 设计 §3「每个功能点一个二级标题」「与评论锚点相同的规则」 |
| 小节的写法 | 一个小节写成「标题行、空行、正文、空行」（正文为空时为「标题行、空行」）。替换时保留原标题行（含手写的编号）；新增时标题为 `## 功能点名称` | 让合入结果与 BlockNote 序列化的样式一致，方便对比 |
| 新增插入位置 | 按该模块下功能点在结构树中的顺序（同级按 `sort`，再按名称）找排在它后面的、模块文档里已有的第一个小节，插在它之前；后面都没有时追加到文末；正文为空时直接写成这一节。功能点已不在模块的子节点里时追加到文末 | 设计 §5「新增时按结构树中功能点的顺序插入到对应位置」 |
| 功能点改名 | 在 `updateStructureNode` 的同一事务里：第三层节点改名时，找父节点（模块）的模块文档，按旧名称定位小节，把标题改为新名称（保留原标题开头的编号），经 `commitSystemRevisionTx` 写一版，摘要「功能点改名：旧名 → 新名」，事件 `document.section_renamed`。找不到模块文档或小节时不改。模块改名、业务域改名、只改说明不动模块文档；功能点移动到别的模块也不动模块文档（旧模块文档里的小节保留，合入到新模块时按新增处理） | 设计 §3「功能点改名」；移动不在设计范围内 |
| 来源小节的标识 | 存 `splitSections` 的键（从顶层到该小节的标题路径，以「 / 」连接，同名加 `#2`），只列有标题的小节，不含第一个标题之前的「（开头）」。PRD 当前正文里没有这个键时显示「已失效」，合入时不预填；修改声明时已存的失效键可以保留（不再校验），新选的键必须存在。`source_sections` 为非空 jsonb 数组，空数组表示没有来源（设计「可空」按「可以为空」处理），最多 20 个 | 设计 §4「按 1–3 级标题，与修订对比相同的切分」「改名后显示已失效」 |
| 预填内容 | 每个来源取该小节正文（不含它自己的标题行）加上它的全部下级小节；标题级别整体下移，使来源的直接下级成为三级标题（一级来源下的二级 → 三级、三级 → 四级，最多六级；二级、三级来源不变；围栏代码块内不改）。多个来源按声明里的顺序以一个空行拼接；失效的来源跳过；`removed` 不预填 | 设计 §5「预填来源小节内容（多个来源按声明顺序拼接）」；下移是为了不在模块文档里产生新的二级标题 |
| 合入内容校验 | 应用时右侧内容不能含一级、二级标题（围栏代码块内除外），报「合入内容里不能有一级或二级标题（二级标题是功能点的分节），请改为三级及以下」；长度与 `data:` 图片沿用 `assertMarkdown` | 二级标题会把模块文档拆出不对应功能点的小节 |
| 声明的编辑 | 产品编辑及以上；PRD 为草稿、评审中、已通过、已上线，且所有声明都还是 `pending` 时可以增删改；只能声明本产品第三层节点；同一 PRD 同一功能点只声明一次（「该功能点已声明」）；外部 PRD 的来源小节必须为空。声明与合入页一律按结构树先序排列，按模块分组。选择器不列已停用的节点（及其下级），已声明的照常显示 | 设计 §4「编辑」 |
| 当场新建节点的权限 | `createNodeForDocument(db, actor, documentId, { parentId, name })`：声明可以修改时，产品编辑及以上可以在业务域下新建模块、在模块下新建功能点；内部调用从 `createStructureNode` 抽出的 `insertStructureNodeTx`（同名检查、停用上级检查、事件 `structure_node.created`、接上悬空链接都不变）。业务域仍只能由产品管理员在产品设置的结构树页签新建；产品还没有业务域时对话框提示去产品设置添加 | 设计 §4「当场新建节点……新建走现有结构树服务」；现有 `createStructureNode` 要求产品管理员，而声明由产品编辑维护（见文末冲突） |
| 应用 | 一个功能点一个事务。客户端带上它看到的模块文档版本号（文档还不存在时为 `null`），与当前值不同即 409「模块文档已被其他人修改，请刷新左侧内容后重试」（`details.version` 为当前版本）。`added`、`modified`：有小节就替换正文，没有就按顺序插入（`modified` 找不到小节时合入页提示「按新增处理」）；`removed`：删除整个小节（找不到时正文不变）。不论正文是否变化都写一版（摘要「合入 PAN-PRD-12：功能点名」），保证每次应用都有合入记录。声明行改为 `applied`，记下修订、处理人、时间；事件 `document.merged`（subject 为模块文档，payload 带变更 PRD 的 id 与编号、功能点、变更类型、修订号、`changes`） | 设计 §5「应用」 |
| 跳过与撤销 | 跳过：`pending → skipped`，`merged_by`、`merged_at` 记录处理人与时间（这两列对应用与跳过通用），事件 `document.affected_node_skipped`。撤销：`skipped → pending`，清空处理人与时间，事件 `document.affected_node_reopened`；如果 PRD 已因全部处理完变为「已合入」，同一事务内退回「已上线」（事件 `document.status_changed`，「PRD」检查项按映射仍为通过）。已应用的不能撤销，需要回退时在模块文档里恢复历史版本 | 设计 §5「跳过后可以撤销为 pending 重新处理」 |
| 完成 | 应用或跳过之后，PRD 为已上线、声明不少于 1 条且全部为 `applied` / `skipped` 时，同一事务内改为 `merged`，记录 `document.status_changed`（`changes` 为 status 已上线 → 已合入），锁住覆盖的需求后调用 `syncPrdCheck`（merged → 通过）。没有声明的 PRD 不显示合入入口 | 设计 §5「完成」「不能合入」 |
| 合入入口与合入页 | PRD 侧栏「影响的功能点」卡片：已上线且有声明时显示「合入模块文档」，已合入时显示「查看合入」，都链接到 `/{org}/documents/PAN-PRD-n/merge`。合入页按模块分组；每个功能点一张卡片：左「模块文档现状」、右「合入内容」（可编辑，`removed` 显示「应用后将删除该小节」），按钮「应用」「跳过」或「撤销跳过」；409 时卡片内显示错误与「刷新左侧」。右侧草稿在用户修改之前跟随服务端的预填 | 设计 §5「入口」「合入页」 |
| 外部 PRD | 可以声明（来源小节为空），合入页右侧为空、手写内容后应用 | 设计 §4「外部 PRD 没有正文，来源小节不可选」 |
| 合入记录与修订来源 | 修订列表每条带 `mergedFrom`（变更 PRD 的 id、编号、标题），页面显示「来源 PAN-PRD-12」链接。模块文档详情另加「合入记录」区块：由 `document_affected_nodes` 关联 `document_revisions`（`merged_revision_id`）读出，按版本倒序列出功能点、变更类型、来源 PRD、版本、处理人与时间。不建 `document_merges` 表，不向 `entity_links` 写 `origin = system` 的行 | 设计 §5「历史」；合入状态已在 `document_affected_nodes`（设计 §4），见文末冲突 |
| 节点链接卡的跳转 | 第二层节点 → 模块文档 `documents/PAN-PRD-n`；第三层节点 → 父模块的模块文档 `documents/PAN-PRD-n?section=功能点名称`（沿用 P2-B1 的小节滚动）；模块还没有文档时 → `documents?product=PAN&view=modules&node={模块 id}`（模块文档页签并定位该模块）；第一层（业务域）仍跳需求列表 `requirements?product=PAN&node={id}`。卡片的标题与状态不变 | 设计 §6；设计没有写业务域，沿用 P2-B1 |
| 文档列表页签 | 页签只由地址栏决定：`?view=modules` 为「模块文档」，否则为「变更 PRD」；切换产品时保留当前页签。模块文档页签按业务域 → 模块列出（业务域行为分组标题），列：模块（有文档时链接到文档，没有时编辑可点击新建）、模块文档编号或「未建」、状态、功能点数、最近合入时间（该模块文档带 `merged_from_document_id` 的修订的最晚创建时间）；`?node=` 的行加 `aria-current="true"` 与底色并滚动到可见。层级叫法用产品设置里的名称 | 设计 §6 |
| 结构树页签 | 第二层节点行显示模块文档链接（有文档时文字为编号，链到文档；没有时文字为「模块文档」，链到模块文档页签并定位），无障碍名称「{模块名} 的模块文档」 | 设计 §6「结构树页签中，模块节点显示其模块文档链接」 |
| 事件 | `document.created`（模块文档的 payload 带 `kind: 'module'`、`nodeId`）、`document.affected_nodes_changed`（新增与移除的 `changes` 为 `affectedNode` 一项，old / new 为 `{path, changeType, sourceSections}` 或 null；修改为逐字段 `changeType`、`sourceSections`）、`document.merged`、`document.affected_node_skipped`、`document.affected_node_reopened`、`document.section_renamed`、`document.status_changed` | 设计 §4、§5 |
| 迁移工具 | `deleteOrgData` 在删除文档之前删除该组织的 `document_affected_nodes`（导入不写、正常使用会写的租户表；不删时 `--replace` 删除文档会因外键失败）。迁移工具导入不产生模块文档与声明 | 设计 §2「旧数据：模块文档从零开始」 |
| 旧数据 | pan123：结构树只有业务域 23 个（全部使用中），模块 0、功能点 0；文档 204 份全部为变更 PRD（Flower 内 12：草稿 7、已上线 5；外部 192），带 `node_id` 的 0、`kind = 'module'` 的 0、已合入 0；名称含 `/`、`[`、`]`、`|`、`#` 的节点 0 个；`entity_links` 共 6 条，指向结构树节点的 0 条（节点卡跳转改变不影响现有链接）。迁移不回填任何数据 | 设计 §2；只读核对 |
| 迁移文件 | `0013_*.sql` 由 `db:generate` 生成，不需要手工调整（新表、部分唯一索引、检查约束都在已有数据上成立：pan123 没有带 `node_id` 的文档）；`0014_p2b2_rls.sql` 用 `--custom` 生成后填写 | 只读核对 |
| 上位文档 | Task 2 同步上位文档 §5.1 影响声明一行、§5.3（不建 `document_merges`，合入状态在 `document_affected_nodes`；Agent 起草提案在 P5 再定存储）、§6.4（功能点合入历史不写 `entity_links`） | 与 P2-B1 计划同步上位文档的做法一致 |

## 文件结构

```
packages/core/
  src/documents/constants.ts            # 状态拆分、DOCUMENT_KINDS、AFFECTED_CHANGE_TYPES、MERGE_STATUSES（Task 2）
  src/documents/markdown.ts             # 状态文字与流转（Task 2）
  src/documents/module-sections.ts      # 纯函数：二级标题分节、替换 / 插入 / 删除、改名、来源小节（Task 1）
  src/db/schema.ts                      # document_affected_nodes、documents 的唯一索引与检查约束（Task 2）
  migrations/0013_*.sql  0014_p2b2_rls.sql  meta/                 # Task 2
  src/documents/documents.ts            # kind / node、assertWritable、writeRevision 导出、commitSystemRevisionTx（Task 3）、修订来源（Task 8）
  src/documents/module-docs.ts          # 新建、列表（Task 3）、功能点改名同步（Task 4）
  src/documents/coverage.ts  checks.ts  # 模块文档不关联需求、没有检查项（Task 3）
  src/structure/nodes.ts                # 改名同步（Task 4）、insertStructureNodeTx（Task 6）
  src/documents/affected.ts             # 声明（Task 5）、当场新建节点（Task 6）
  src/documents/merge.ts                # 合入页、应用、跳过、撤销（Task 7）、合入记录（Task 8）
  src/links/cards.ts                    # 节点链接卡跳转（Task 8）
  src/index.ts                          # 各任务
  test/module-sections.test.ts  p2b2-schema.test.ts  module-docs.test.ts  module-doc-rename.test.ts
  test/affected-nodes.test.ts  affected-new-node.test.ts  merge.test.ts  merge-history.test.ts
  test/link-queries.test.ts             # 节点链接卡的新地址（Task 8）
packages/migrate/
  src/write.ts  test/write.test.ts      # --replace 删除 document_affected_nodes（Task 2）
apps/web/
  src/server/api.ts  src/server/routes/module-docs.ts  test/api/module-docs.test.ts      # Task 9
  src/lib/types.ts  src/lib/queries.ts  # Task 9
  src/features/documents/model.ts  model.test.ts                # Task 2、10、12
  src/app/(app)/[org]/documents/page.tsx  module-docs-tab.tsx   # Task 10
  src/app/(app)/[org]/settings/products/[productId]/structure-tab.tsx                      # Task 10
  src/app/(app)/[org]/documents/[key]/page.tsx  status-card.tsx  side-panel.tsx  module-side-panel.tsx  merge-records.tsx  revisions.tsx  editor-pane.tsx   # Task 11
  src/app/(app)/[org]/documents/[key]/affected-nodes.tsx  affected-node-dialog.tsx         # Task 12
  src/app/(app)/[org]/documents/[key]/merge/page.tsx  merge/merge-item.tsx                 # Task 13
  e2e/helpers.ts  module-docs.spec.ts  module-affected.spec.ts  module-merge.spec.ts
docs/superpowers/specs/2026-09-28-flower-data-model-design.md  # §5.1、§5.3、§6.4（Task 2）
docs/p2b2-validation.md  docs/handoff.md  docs/agent-log.md     # Task 15
```

---

### Task 1: 模块文档分节的纯函数（`module-sections.ts`）

**Files:**
- Create: `packages/core/src/documents/module-sections.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/module-sections.test.ts`

**Interfaces:**
- Consumes: 现有 `normalizeHeading`、`splitSections`（`packages/core/src/documents/markdown.ts`）
- Produces（服务端使用，经 `@flower/core` 导出）:
  - `type FeatureSection = { heading: string; start: number; end: number }`（行号区间 `[start, end)`，`start` 为标题行）
  - `featureSections(lines: string[]): FeatureSection[]`
  - `featureSectionBody(markdown: string, name: string): string | null`
  - `applyFeatureSection(markdown: string, input: { name: string; body: string; order: string[]; remove?: boolean }): string`
  - `renameFeatureHeading(markdown: string, oldName: string, newName: string): string | null`
  - `hasTopHeadings(body: string): boolean`
  - `prdSectionKeys(markdown: string): string[]`
  - `sourceSectionText(markdown: string, key: string): string | null`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/module-sections.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  applyFeatureSection,
  featureSectionBody,
  featureSections,
  hasTopHeadings,
  prdSectionKeys,
  renameFeatureHeading,
  sourceSectionText,
} from '../src/documents/module-sections';

const DOC = '概述文字\n\n## 上传\n\n上传说明\n\n## 下载\n\n下载说明\n';

describe('模块文档按功能点分节', () => {
  it('只按二级标题切分；三级标题属于所在小节；代码块里的 # 不算', () => {
    const lines = '概述\n\n## 上传\n\n### 细节\n\n```\n## 不是标题\n```\n\n## 下载\n\n下载说明'.split('\n');
    expect(featureSections(lines).map((s) => [s.heading, s.start, s.end])).toEqual([
      ['上传', 2, 10],
      ['下载', 10, 13],
    ]);
  });

  it('小节正文：按归一化名称（去编号与空白）找第一个；不含标题行，去掉首尾空行；找不到为 null', () => {
    expect(featureSectionBody(DOC, '上传')).toBe('上传说明');
    expect(featureSectionBody('## 2. 上 传\n\n  缩进保留\n', '上传')).toBe('  缩进保留');
    expect(featureSectionBody('## 上传\n', '上传')).toBe('');
    expect(featureSectionBody(DOC, '分享')).toBeNull();
  });

  it('替换：保留原标题行，正文换成新内容；新内容为空时只留标题', () => {
    expect(applyFeatureSection(DOC, { name: '上传', body: '新的上传\n\n### 细节\n\n内容', order: [] })).toBe(
      '概述文字\n\n## 上传\n\n新的上传\n\n### 细节\n\n内容\n\n## 下载\n\n下载说明\n',
    );
    expect(applyFeatureSection('## 1. 上传\n\n旧\n', { name: '上传', body: '新', order: [] })).toBe('## 1. 上传\n\n新\n');
    expect(applyFeatureSection(DOC, { name: '下载', body: '  ', order: [] })).toBe('概述文字\n\n## 上传\n\n上传说明\n\n## 下载\n');
  });

  it('新增：按结构树顺序插到后面第一个已有小节之前；后面都没有时追加到文末；空文档直接写成该小节', () => {
    expect(applyFeatureSection(DOC, { name: '分享', body: '分享说明', order: ['上传', '分享', '下载'] })).toBe(
      '概述文字\n\n## 上传\n\n上传说明\n\n## 分享\n\n分享说明\n\n## 下载\n\n下载说明\n',
    );
    expect(applyFeatureSection(DOC, { name: '首页', body: '首页说明', order: ['首页', '上传', '下载'] })).toBe(
      '概述文字\n\n## 首页\n\n首页说明\n\n## 上传\n\n上传说明\n\n## 下载\n\n下载说明\n',
    );
    expect(applyFeatureSection(DOC, { name: '回收站', body: '回收站说明', order: ['上传', '下载', '回收站'] })).toBe(
      '概述文字\n\n## 上传\n\n上传说明\n\n## 下载\n\n下载说明\n\n## 回收站\n\n回收站说明\n',
    );
    expect(applyFeatureSection('概述', { name: '上传', body: '说明', order: ['上传'] })).toBe('概述\n\n## 上传\n\n说明\n');
    expect(applyFeatureSection('', { name: '上传', body: '说明', order: ['上传'] })).toBe('## 上传\n\n说明\n');
    expect(applyFeatureSection(DOC, { name: '不在树里', body: 'x', order: ['上传', '下载'] })).toBe(`${DOC}\n## 不在树里\n\nx\n`);
  });

  it('删除：移除整个小节（含下级标题）；找不到时原样返回', () => {
    expect(applyFeatureSection(DOC, { name: '上传', body: '', order: [], remove: true })).toBe('概述文字\n\n## 下载\n\n下载说明\n');
    expect(applyFeatureSection(DOC, { name: '下载', body: '', order: [], remove: true })).toBe('概述文字\n\n## 上传\n\n上传说明\n');
    expect(applyFeatureSection(DOC, { name: '分享', body: '', order: [], remove: true })).toBe(DOC);
  });

  it('功能点改名：只改标题行，保留编号；找不到返回 null', () => {
    expect(renameFeatureHeading(DOC, '上传', '极速上传')).toBe('概述文字\n\n## 极速上传\n\n上传说明\n\n## 下载\n\n下载说明\n');
    expect(renameFeatureHeading('## 2. 上传\n\n说明', '上传', '极速上传')).toBe('## 2. 极速上传\n\n说明');
    expect(renameFeatureHeading(DOC, '分享', '共享')).toBeNull();
  });

  it('合入内容不能有一级、二级标题（代码块内除外）', () => {
    expect(hasTopHeadings('### 细节\n\n正文')).toBe(false);
    expect(hasTopHeadings('```\n## 代码\n```')).toBe(false);
    expect(hasTopHeadings('正文\n## 新小节')).toBe(true);
    expect(hasTopHeadings('# 大标题')).toBe(true);
  });
});

const PRD = '# 概述\n\n总述\n\n## 需求说明\n\n要点\n\n### 上传\n\n上传细节\n\n### 下载\n\n下载细节\n\n## 其他\n\n别的';

describe('来源小节', () => {
  it('可选的小节：splitSections 的键，只含有标题的小节', () => {
    expect(prdSectionKeys(`开头\n\n${PRD}`)).toEqual(['概述', '概述 / 需求说明', '概述 / 需求说明 / 上传', '概述 / 需求说明 / 下载', '概述 / 其他']);
  });

  it('来源内容：小节正文加全部下级小节，标题级别下移到三级起；代码块内不改；找不到为 null', () => {
    expect(sourceSectionText(PRD, '概述 / 需求说明')).toBe('要点\n\n### 上传\n\n上传细节\n\n### 下载\n\n下载细节');
    expect(sourceSectionText(PRD, '概述')).toBe('总述\n\n### 需求说明\n\n要点\n\n#### 上传\n\n上传细节\n\n#### 下载\n\n下载细节\n\n### 其他\n\n别的');
    expect(sourceSectionText(PRD, '概述 / 需求说明 / 上传')).toBe('上传细节');
    expect(sourceSectionText('# 背景\n\n```\n# 代码\n```', '背景')).toBe('```\n# 代码\n```');
    expect(sourceSectionText(PRD, '概述 / 不存在')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/module-sections.test.ts`
Expected: FAIL（`Cannot find module '../src/documents/module-sections'`）。

- [ ] **Step 3: 实现**

新建 `packages/core/src/documents/module-sections.ts`：

```ts
import { normalizeHeading, splitSections } from './markdown';

/**
 * 模块文档按功能点分节：第一个二级标题之前为概述，每个功能点一个二级标题（标题文字为功能点名称），
 * 三级及以下标题属于所在小节。小节按功能点名称归一化（与评论锚点相同：去开头编号与空白）定位，同名取第一个。
 */

const H2 = /^##\s+(.*?)\s*#*\s*$/;
const TOP_HEADING = /^#{1,2}\s/;
const ANY_HEADING = /^(#{1,6})(\s.*)$/;
const FENCE = /^\s*(```|~~~)/;

export type FeatureSection = { heading: string; start: number; end: number };

const toLines = (markdown: string): string[] => markdown.replace(/\r\n?/g, '\n').split('\n');

/** 去掉首尾的空白行。 */
function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === '') a++;
  while (b > a && lines[b - 1]!.trim() === '') b--;
  return lines.slice(a, b);
}

/** 二级标题小节在行数组中的范围 [start, end)，start 为标题行；围栏代码块里的 # 不算。 */
export function featureSections(lines: string[]): FeatureSection[] {
  const out: FeatureSection[] = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fence = !fence;
    const m = fence ? null : H2.exec(line);
    if (!m) return;
    if (out.length > 0) out[out.length - 1]!.end = i;
    out.push({ heading: m[1]!, start: i, end: lines.length });
  });
  return out;
}

const findFeature = (sections: FeatureSection[], name: string): FeatureSection | undefined =>
  sections.find((s) => normalizeHeading(s.heading) === normalizeHeading(name));

/** 功能点小节的正文（不含标题行，去掉首尾空行）；找不到返回 null。 */
export function featureSectionBody(markdown: string, name: string): string | null {
  const lines = toLines(markdown);
  const hit = findFeature(featureSections(lines), name);
  return hit ? trimBlank(lines.slice(hit.start + 1, hit.end)).join('\n') : null;
}

/** 一个小节的行：标题行、空行、正文、空行；正文为空时为标题行、空行。 */
function sectionLines(headingLine: string, body: string): string[] {
  const bodyLines = trimBlank(toLines(body));
  return bodyLines.length > 0 ? [headingLine, '', ...bodyLines, ''] : [headingLine, ''];
}

/**
 * 合入一个功能点。已有小节：保留原标题行，替换正文。没有小节：按 order（该模块下功能点在结构树中的顺序）
 * 插到排在它后面的第一个已有小节之前，后面都没有（或它不在 order 里）时追加到文末。remove：删除整个小节，找不到时原样返回。
 */
export function applyFeatureSection(markdown: string, input: { name: string; body: string; order: string[]; remove?: boolean }): string {
  const lines = toLines(markdown);
  const sections = featureSections(lines);
  const hit = findFeature(sections, input.name);
  if (input.remove) {
    if (!hit) return markdown;
    lines.splice(hit.start, hit.end - hit.start);
    return lines.join('\n');
  }
  if (hit) {
    lines.splice(hit.start, hit.end - hit.start, ...sectionLines(lines[hit.start]!, input.body));
    return lines.join('\n');
  }
  const fresh = sectionLines(`## ${input.name}`, input.body);
  if (markdown.trim() === '') return fresh.join('\n');
  const want = normalizeHeading(input.name);
  const at = input.order.findIndex((n) => normalizeHeading(n) === want);
  const later = new Set(at === -1 ? [] : input.order.slice(at + 1).map(normalizeHeading));
  const next = sections.find((s) => later.has(normalizeHeading(s.heading)));
  const pos = next ? next.start : lines.length;
  // 与上一段之间空一行
  const gap = pos > 0 && lines[pos - 1]!.trim() !== '' ? [''] : [];
  lines.splice(pos, 0, ...gap, ...fresh);
  return lines.join('\n');
}

/** 功能点改名：把小节标题改为新名称，保留原标题开头的编号；找不到返回 null。 */
export function renameFeatureHeading(markdown: string, oldName: string, newName: string): string | null {
  const lines = toLines(markdown);
  const hit = findFeature(featureSections(lines), oldName);
  if (!hit) return null;
  const number = /^[\d.、\s]+/.exec(hit.heading)?.[0] ?? '';
  lines[hit.start] = `## ${number}${newName}`;
  return lines.join('\n');
}

/** 合入内容里是否有一级或二级标题（围栏代码块内的不算）。 */
export function hasTopHeadings(body: string): boolean {
  let fence = false;
  for (const line of toLines(body)) {
    if (FENCE.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence && TOP_HEADING.test(line)) return true;
  }
  return false;
}

/** 变更 PRD 可选的来源小节：splitSections 的键（标题路径），只含有标题的小节。 */
export function prdSectionKeys(markdown: string): string[] {
  return splitSections(markdown)
    .filter((s) => s.heading !== null)
    .map((s) => s.key);
}

/**
 * 来源小节的内容：该小节正文（不含它自己的标题行）加上它的全部下级小节。标题级别整体下移，
 * 使来源的直接下级成为三级标题（最多六级，围栏代码块内不改），避免在模块文档里产生新的二级标题。找不到返回 null。
 */
export function sourceSectionText(markdown: string, key: string): string | null {
  const sections = splitSections(markdown);
  const i = sections.findIndex((s) => s.heading !== null && s.key === key);
  if (i === -1) return null;
  const own = sections[i]!;
  const lines = own.markdown.split('\n').slice(1);
  for (let j = i + 1; j < sections.length && sections[j]!.level > own.level; j++) lines.push(...sections[j]!.markdown.split('\n'));
  const shift = Math.max(0, 2 - own.level);
  let fence = false;
  const shifted = lines.map((line) => {
    if (FENCE.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence || shift === 0) return line;
    const m = ANY_HEADING.exec(line);
    return m ? `${'#'.repeat(Math.min(6, m[1]!.length + shift))}${m[2]}` : line;
  });
  return trimBlank(shifted).join('\n');
}
```

`packages/core/src/index.ts`：在 `export * from './documents/markdown';` 之后加一行：

```ts
export * from './documents/module-sections';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/module-sections.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/documents/module-sections.ts packages/core/src/index.ts packages/core/test/module-sections.test.ts
git commit -m "feat(core): 模块文档按功能点分节的纯函数（替换、按顺序插入、删除、改名、来源小节）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 数据模型：`document_affected_nodes`、模块文档唯一与状态、迁移工具清理

**Files:**
- Modify: `packages/core/src/documents/constants.ts`、`packages/core/src/documents/markdown.ts`、`packages/core/src/db/schema.ts`
- Create: `packages/core/migrations/0013_*.sql`（生成）、`packages/core/migrations/0014_p2b2_rls.sql`（`--custom` 生成后填写）、`packages/core/migrations/meta/*`（生成）
- Modify: `packages/migrate/src/write.ts`
- Modify: `apps/web/src/features/documents/model.ts`、`apps/web/src/app/(app)/[org]/documents/page.tsx`（状态颜色与筛选，保持 typecheck 通过）
- Modify: `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`
- Test: `packages/core/test/p2b2-schema.test.ts`、`packages/migrate/test/write.test.ts`、`apps/web/src/features/documents/model.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CHANGE_DOCUMENT_STATUSES`、`MODULE_DOCUMENT_STATUSES`、`DOCUMENT_STATUSES`（两者合并）、`type ChangeDocumentStatus`、`type DocumentStatus`（八个值）
  - `DOCUMENT_KINDS = ['change', 'module']`、`type DocumentKind`
  - `AFFECTED_CHANGE_TYPES = ['added', 'modified', 'removed']`、`type AffectedChangeType`；`MERGE_STATUSES = ['pending', 'applied', 'skipped']`、`type MergeStatus`
  - `DOCUMENT_STATUS_LABELS.active = '使用中'`、`.archived = '已归档'`；`DOCUMENT_TRANSITIONS.active = ['archived']`、`.archived = ['active']`
  - 表 `documentAffectedNodes`（`id, orgId, documentId, nodeId, changeType, sourceSections: string[], mergeStatus, mergedRevisionId, mergedBy, mergedAt, createdAt`），唯一索引 `document_affected_nodes_doc_node`
  - `documents` 的 `documents_module_node` 部分唯一索引与 `documents_kind_node` 检查约束

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/p2b2-schema.test.ts`：

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentAffectedNodes, documents, organizations, products, structureNodes } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const domain = newId();
const mod = newId();
const feature = newId();
const prd = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
  await t.adminDb.insert(structureNodes).values([
    { id: domain, orgId: orgA, productId: productA, parentId: null, depth: 1, name: '存储' },
    { id: mod, orgId: orgA, productId: productA, parentId: domain, depth: 2, name: '上传' },
    { id: feature, orgId: orgA, productId: productA, parentId: mod, depth: 3, name: '分片上传' },
  ]);
  await t.adminDb.insert(documents).values({ id: prd, orgId: orgA, productId: productA, number: 1, kind: 'change', source: 'native', title: '变更', status: 'launched' });
});
afterAll(() => t.cleanup());

describe('P2-B2 数据模型', () => {
  it('document_affected_nodes 受行级安全约束；默认待合入、没有来源小节', async () => {
    await withOrg(t.db, orgA, (tx) => tx.insert(documentAffectedNodes).values({ orgId: orgA, documentId: prd, nodeId: feature, changeType: 'added' }));
    const mine = await withOrg(t.db, orgA, (tx) => tx.select().from(documentAffectedNodes));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ mergeStatus: 'pending', sourceSections: [], mergedRevisionId: null, mergedBy: null, mergedAt: null });
    expect(await withOrg(t.db, orgB, (tx) => tx.select().from(documentAffectedNodes))).toHaveLength(0);
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename = 'document_affected_nodes'`)) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('同一份 PRD 同一个功能点只能声明一次', async () => {
    await expect(t.adminDb.insert(documentAffectedNodes).values({ orgId: orgA, documentId: prd, nodeId: feature, changeType: 'modified' })).rejects.toThrow();
  });

  it('每个模块最多一份未删除的模块文档；模块文档必须有节点，变更 PRD 不能有节点', async () => {
    const [first] = await t.adminDb
      .insert(documents)
      .values({ orgId: orgA, productId: productA, number: 2, kind: 'module', source: 'native', title: '上传', nodeId: mod, status: 'active' })
      .returning();
    await expect(
      t.adminDb.insert(documents).values({ orgId: orgA, productId: productA, number: 3, kind: 'module', source: 'native', title: '上传', nodeId: mod, status: 'active' }),
    ).rejects.toThrow();
    await t.adminDb.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, first!.id));
    await t.adminDb.insert(documents).values({ orgId: orgA, productId: productA, number: 4, kind: 'module', source: 'native', title: '上传', nodeId: mod, status: 'active' });
    await expect(t.adminDb.insert(documents).values({ orgId: orgA, productId: productA, number: 5, kind: 'module', source: 'native', title: '无节点', status: 'active' })).rejects.toThrow();
    await expect(t.adminDb.insert(documents).values({ orgId: orgA, productId: productA, number: 6, kind: 'change', source: 'native', title: '带节点', nodeId: mod })).rejects.toThrow();
  });
});
```

`packages/migrate/test/write.test.ts`：`@flower/core` 的 import 列表按字母序加入 `createStructureNode` 与 `documentAffectedNodes`；「导入后有过正常使用……仍可以 replace」用例里，`expect(await t.adminDb.select().from(entityLinks)).toHaveLength(1);` 之后加：

```ts
    const area = await createStructureNode(t.db, actor, product!.id, { name: '导入后新建的业务域' });
    const mod = await createStructureNode(t.db, actor, product!.id, { parentId: area.id, name: '导入后模块' });
    const feature = await createStructureNode(t.db, actor, product!.id, { parentId: mod.id, name: '导入后功能点' });
    const prd = await createDocument(t.db, actor, product!.id, { title: '导入后 PRD' });
    await t.adminDb.insert(documentAffectedNodes).values({ orgId: actor.orgId, documentId: prd.id, nodeId: feature.id, changeType: 'added' });
```

并在 `expect(await t.adminDb.select().from(entityLinks)).toEqual([]);` 之后加：

```ts
    expect(await t.adminDb.select().from(documentAffectedNodes)).toEqual([]);
```

`apps/web/src/features/documents/model.test.ts`：「地址栏 ↔ 筛选；无效的状态与来源被忽略」用例末尾加：

```ts
    expect(parseDocumentFilter(new URLSearchParams('status=merged')).status).toBe('merged');
    expect(parseDocumentFilter(new URLSearchParams('status=archived')).status).toBe('');
```

Run: `pnpm --filter @flower/core exec vitest run test/p2b2-schema.test.ts`
Expected: FAIL（`documentAffectedNodes` 不存在，import 报错）。

Run: `pnpm --filter @flower/migrate exec vitest run test/write.test.ts`
Expected: FAIL（`documentAffectedNodes` 不是 `@flower/core` 的导出）。

web 的两条新断言是回归守护：现在就能通过；Step 2 把模块文档状态并入 `DOCUMENT_STATUSES` 之后，如果不做 Step 6，`status=archived` 会被当作有效筛选而失败。

- [ ] **Step 2: 状态与常量**

`packages/core/src/documents/constants.ts` 开头三行：

```ts
/** 变更 PRD 的状态。merged 属于 P2-B（合入），P2-A 不会进入这个状态。 */
export const DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'launched', 'merged', 'discarded'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
```

替换为：

```ts
/** 变更 PRD 的状态。merged 只由合入自动进入（全部影响声明处理完）。 */
export const CHANGE_DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'launched', 'merged', 'discarded'] as const;
export type ChangeDocumentStatus = (typeof CHANGE_DOCUMENT_STATUSES)[number];
/** 模块文档的状态：使用中 / 已归档（只读）。 */
export const MODULE_DOCUMENT_STATUSES = ['active', 'archived'] as const;
/** documents.status 的全部取值：两类文档共用一列。 */
export const DOCUMENT_STATUSES = [...CHANGE_DOCUMENT_STATUSES, ...MODULE_DOCUMENT_STATUSES] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_KINDS = ['change', 'module'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** 影响声明的变更类型与合入状态。 */
export const AFFECTED_CHANGE_TYPES = ['added', 'modified', 'removed'] as const;
export type AffectedChangeType = (typeof AFFECTED_CHANGE_TYPES)[number];
export const MERGE_STATUSES = ['pending', 'applied', 'skipped'] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];
```

`packages/core/src/documents/markdown.ts`：

1. `DOCUMENT_STATUS_LABELS` 里 `discarded: '已废弃',` 之后加：

```ts
  active: '使用中',
  archived: '已归档',
```

2. 把

```ts
/** 可流转的目标状态。launched → merged 属于 P2-B（合入），这里没有。 */
export const DOCUMENT_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  draft: ['review', 'discarded'],
  review: ['draft', 'approved', 'discarded'],
  approved: ['review', 'launched', 'discarded'],
  launched: [],
  merged: [],
  discarded: ['draft'],
};
```

替换为：

```ts
/** 可流转的目标状态。launched → merged 只由合入自动完成，这里没有。模块文档在使用中与已归档之间切换。 */
export const DOCUMENT_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  draft: ['review', 'discarded'],
  review: ['draft', 'approved', 'discarded'],
  approved: ['review', 'launched', 'discarded'],
  launched: [],
  merged: [],
  discarded: ['draft'],
  active: ['archived'],
  archived: ['active'],
};
```

- [ ] **Step 3: 表结构**

`packages/core/src/db/schema.ts`：

1. import 改为：

```ts
import { AFFECTED_CHANGE_TYPES, DOCUMENT_KINDS, DOCUMENT_STATUSES, EXTERNAL_PROVIDERS, MERGE_STATUSES, type RevisionSnapshot, type TemplateSection } from '../documents/constants';
```

2. `documents` 表里 `kind: text('kind', { enum: ['change', 'module'] }).notNull().default('change'),` 改为：

```ts
    kind: text('kind', { enum: DOCUMENT_KINDS }).notNull().default('change'),
```

3. `documents` 表的第三个参数数组，在 `check('documents_external', …),` 之后加：

```ts
    uniqueIndex('documents_module_node').on(t.nodeId).where(sql`${t.kind} = 'module' and ${t.deletedAt} is null`),
    check('documents_kind_node', sql`(${t.kind} = 'module') = (${t.nodeId} is not null)`),
```

4. 文件末尾（`entityLinks` 之后）加：

```ts
// ---------- P2-B2：影响声明与合入 ----------

export const documentAffectedNodes = pgTable(
  'document_affected_nodes',
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => structureNodes.id),
    changeType: text('change_type', { enum: AFFECTED_CHANGE_TYPES }).notNull(),
    /** PRD 小节的键（splitSections 的标题路径），按声明顺序；空数组表示没有来源。 */
    sourceSections: jsonb('source_sections').$type<string[]>().notNull().default([]),
    mergeStatus: text('merge_status', { enum: MERGE_STATUSES }).notNull().default('pending'),
    mergedRevisionId: uuid('merged_revision_id').references(() => documentRevisions.id),
    /** 应用或跳过的人与时间。 */
    mergedBy: memberRef('merged_by'),
    mergedAt: ts('merged_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('document_affected_nodes_doc_node').on(t.documentId, t.nodeId), index('document_affected_nodes_node').on(t.nodeId)],
);
```

- [ ] **Step 4: 生成迁移**

Run: `pnpm --filter @flower/core db:generate`
Expected: 生成 `packages/core/migrations/0013_<随机名>.sql` 与 `meta/0013_snapshot.json`，`_journal.json` 增加一项。核对文件里有：`CREATE TABLE "document_affected_nodes"`（含 `org_id`、`document_id`、`node_id`、`merged_revision_id`、`merged_by` 五个外键）、`CREATE UNIQUE INDEX "document_affected_nodes_doc_node"`、`CREATE INDEX "document_affected_nodes_node"`、`CREATE UNIQUE INDEX "documents_module_node" … WHERE "documents"."kind" = 'module' and "documents"."deleted_at" is null`、`ALTER TABLE "documents" ADD CONSTRAINT "documents_kind_node" CHECK …`；缺任何一项，或出现与本任务无关的语句（如改动 `documents.status`），停下来报告。

Run: `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p2b2_rls`
Expected: 生成空的 `packages/core/migrations/0014_p2b2_rls.sql`。填入：

```sql
ALTER TABLE document_affected_nodes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON document_affected_nodes
  USING (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid);
```

- [ ] **Step 5: 迁移工具：`--replace` 删除影响声明**

`packages/migrate/src/write.ts` 的 `deleteOrgData`：把

```ts
  // 导入不写、但正常使用会写的租户表：迭代快照在需求/迭代之前删，双链只引用组织、随时可删，Token 与邀请在成员之前删
  await tx.execute(sql`delete from ${core.iterationScopeSnapshots} where org_id = ${orgId}`);
  await tx.execute(sql`delete from ${core.entityLinks} where org_id = ${orgId}`);
```

替换为：

```ts
  // 导入不写、但正常使用会写的租户表：迭代快照在需求/迭代之前删，影响声明在文档、修订与结构树之前删，
  // 双链只引用组织、随时可删，Token 与邀请在成员之前删
  await tx.execute(sql`delete from ${core.iterationScopeSnapshots} where org_id = ${orgId}`);
  await tx.execute(sql`delete from ${core.documentAffectedNodes} where org_id = ${orgId}`);
  await tx.execute(sql`delete from ${core.entityLinks} where org_id = ${orgId}`);
```

（`documents` 的 `currentRevisionId` 已在函数开头置空；运行时新建的模块文档是 `documents` 的行，随 `documents` 一起删除。）

- [ ] **Step 6: 页面的状态颜色与筛选**

`apps/web/src/features/documents/model.ts`：

1. 第一行 import 中的 `DOCUMENT_STATUSES` 换成 `CHANGE_DOCUMENT_STATUSES`（其余不变）：

```ts
import { bestQuoteMatch, CHANGE_DOCUMENT_STATUSES, type DocumentStatus, type ExternalProvider, normalizeHeading, splitSections, squash, type TemplateSection } from '@flower/core/markdown';
```

2. `DOCUMENT_STATUS_COLOR` 里 `discarded: '#5c6570',` 之后加：

```ts
  active: '#1e8a5a',
  archived: '#8a9199',
```

3. `parseDocumentFilter` 里 `(DOCUMENT_STATUSES as readonly string[]).includes(status)` 改为 `(CHANGE_DOCUMENT_STATUSES as readonly string[]).includes(status)`。

`apps/web/src/app/(app)/[org]/documents/page.tsx`：

1. `import { DOCUMENT_STATUS_LABELS, DOCUMENT_STATUSES } from '@flower/core/markdown';` 改为 `import { CHANGE_DOCUMENT_STATUSES, DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';`
2. `{DOCUMENT_STATUSES.filter((s) => s !== 'merged').map((s) => (` 改为 `{CHANGE_DOCUMENT_STATUSES.map((s) => (`。

- [ ] **Step 7: 上位文档**

`docs/superpowers/specs/2026-09-28-flower-data-model-design.md`：

1. §5.1 表格中这一行

```
| 影响声明 | `document_affected_nodes`：document_id、node_id、change_type（added / modified / removed） | — |
```

改为：

```
| 影响声明 | `document_affected_nodes`：document_id、node_id、change_type（added / modified / removed）、source_sections、merge_status（pending / applied / skipped）、merged_revision_id、merged_by、merged_at（见 P2-B2 设计 §4） | — |
```

2. §5.3 中这两行

```
- `document_merges`：change_document_id、module_document_id、proposal（jsonb：按小节的改动）、status（proposed / applied / rejected）、proposed_by、applied_by、produced_revision_id。
- 流程：变更 PRD 上线后，生成合入提案（可由 Agent 起草）→ 人按小节审阅 → 应用，产生模块文档新版本，功能点历史中出现系统链接（§6.4）。试验回滚的变更 PRD 标记为 discarded，不合入。
```

改为：

```
- 人工合入（P2-B2）不建 `document_merges`：合入状态记在 `document_affected_nodes`（merge_status、merged_revision_id），合入产生的模块文档修订带 merged_from_document_id。Agent 起草合入提案（P5）时再确定提案的存储（2026-10-09，见 P2-B2 设计 §4、§5）。
- 流程：变更 PRD 上线后，按功能点把来源小节的内容合入模块文档（逐个应用或跳过），全部处理完时 PRD 变为 merged。试验回滚的变更 PRD 标记为 discarded，不合入。
```

3. §6.4 中这一行

```
- 模块文档中功能点的历史、需求与变更 PRD 的关联等系统生成的链接，以 origin = system 写入同一张表，反向链接面板一次查全。
```

改为：

```
- 需求与变更 PRD 的关联等系统生成的链接，以 origin = system 写入同一张表，反向链接面板一次查全。功能点的合入历史由 `document_affected_nodes` 与修订的 merged_from_document_id 读出，不写入本表（2026-10-09，见 P2-B2 设计 §5）。
```

- [ ] **Step 8: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/p2b2-schema.test.ts test/p2a-schema.test.ts test/p2b1-schema.test.ts test/rls.test.ts test/documents.test.ts && pnpm --filter @flower/migrate exec vitest run test/write.test.ts && pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/documents/constants.ts packages/core/src/documents/markdown.ts packages/core/src/db/schema.ts packages/core/migrations packages/core/test/p2b2-schema.test.ts packages/migrate/src/write.ts packages/migrate/test/write.test.ts apps/web/src/features/documents/model.ts apps/web/src/features/documents/model.test.ts "apps/web/src/app/(app)/[org]/documents/page.tsx" docs/superpowers/specs/2026-09-28-flower-data-model-design.md
git commit -m "feat(core): document_affected_nodes 表（RLS）、每个模块一份模块文档、模块文档状态

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 模块文档服务：新建、列表、详情、归档只读

**Files:**
- Create: `packages/core/src/documents/module-docs.ts`
- Modify: `packages/core/src/documents/documents.ts`、`packages/core/src/documents/coverage.ts`、`packages/core/src/documents/checks.ts`、`packages/core/src/index.ts`
- Test: `packages/core/test/module-docs.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `DocumentKind`、`documents.kind / nodeId`、状态与流转
- Produces:
  - `documents.ts`：`type DocumentRow = typeof documents.$inferSelect`；`type ModuleNodeRef = { id: string; name: string; status: 'active' | 'deprecated'; domain: { id: string; name: string } | null }`；`DocumentListItem.kind: DocumentKind`；`DocumentDetail.node: ModuleNodeRef | null`；`writeRevision(tx, actor, doc, snapshot, opts: { summary: string | null; allowMerge: boolean; mergedFrom?: string | null })`（改为导出）；`assertWritable(doc: DocumentRow): void`；`documentMarkdownTx(tx: Tx, doc: DocumentRow): Promise<string>`；`commitSystemRevisionTx(tx: Tx, actor: Actor, doc: DocumentRow, markdown: string, opts: { summary: string; mergedFrom: string | null }): Promise<{ id: string; number: number; version: number }>`
  - `module-docs.ts`：`type ModuleDocumentRow = { node: { id: string; name: string; status: 'active' | 'deprecated' }; featureCount: number; document: { id: string; displayKey: string; title: string; status: DocumentStatus; updatedAt: Date } | null; lastMergedAt: Date | null }`；`type ModuleDocumentGroup = { domain: { id: string; name: string; status: 'active' | 'deprecated' }; modules: ModuleDocumentRow[] }`；`type ModuleDocumentTree = { productKey: string; groups: ModuleDocumentGroup[] }`；`findModuleDocument(tx, moduleId, opts?: { lock?: boolean }): Promise<DocumentRow | null>`；`ensureModuleDocumentTx(tx, actor, moduleId): Promise<{ doc: DocumentRow; created: boolean }>`；`createModuleDocument(db, actor, nodeId): Promise<DocumentDetail>`；`listModuleDocuments(db, actor, productId): Promise<ModuleDocumentTree>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/module-docs.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDocumentCheckItemState } from '../src/documents/checks';
import { addDocumentComment } from '../src/documents/comments';
import { linkDocumentRequirements } from '../src/documents/coverage';
import { createDocument, getDocumentByKey, listDocuments, restoreRevision, saveDocumentContent, transitionDocument, updateDocument } from '../src/documents/documents';
import { createModuleDocument, listModuleDocuments } from '../src/documents/module-docs';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createRequirement } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;
let storage: StructureNodeView;
let upload: StructureNodeView;
let download: StructureNodeView;
let chunk: StructureNodeView;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  await createDocument(t.db, owner, pan, { title: '变更一' }); // PAN-PRD-1
});
afterAll(() => t.cleanup());

describe('模块文档', () => {
  it('第一次打开模块时新建：编号沿用产品文档编号，标题为模块名称，概述为空；再次打开返回同一份', async () => {
    const d = await createModuleDocument(t.db, editor, upload.id);
    expect(d).toMatchObject({
      displayKey: 'PAN-PRD-2',
      kind: 'module',
      source: 'native',
      title: '上传',
      status: 'active',
      owner: null,
      markdown: '',
      revisionNumber: 1,
      version: 1,
      transitions: ['archived'],
      checkItems: [],
      requirements: [],
      node: { id: upload.id, name: '上传', status: 'active', domain: { id: storage.id, name: '存储' } },
    });
    expect((await createModuleDocument(t.db, owner, upload.id)).id).toBe(d.id);
    expect((await getDocumentByKey(t.db, viewer, 'PAN-PRD-2')).kind).toBe('module');
    expect((await listDocuments(t.db, owner, pan)).map((x) => [x.displayKey, x.kind])).toEqual([['PAN-PRD-1', 'change']]);
  });

  it('只有模块节点可以有模块文档；只读成员与只读 Token 不能新建', async () => {
    await expect(createModuleDocument(t.db, owner, storage.id)).rejects.toThrow('只有模块节点可以有模块文档');
    await expect(createModuleDocument(t.db, owner, chunk.id)).rejects.toThrow('只有模块节点可以有模块文档');
    await expect(createModuleDocument(t.db, viewer, download.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createModuleDocument(t.db, readOnlyToken(owner), download.id)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('模块文档列表：按业务域 → 模块列出，是否已有文档、功能点数、最近合入时间', async () => {
    const tree = await listModuleDocuments(t.db, viewer, pan);
    expect(tree.productKey).toBe('PAN');
    expect(tree.groups.map((g) => g.domain)).toEqual([{ id: storage.id, name: '存储', status: 'active' }]);
    expect(tree.groups[0]!.modules.map((m) => [m.node.name, m.featureCount, m.document?.displayKey ?? null, m.document?.status ?? null, m.lastMergedAt])).toEqual([
      ['上传', 1, 'PAN-PRD-2', 'active', null],
      ['下载', 0, null, null, null],
    ]);
  });

  it('与变更 PRD 相同的正文编辑与评论；不关联需求、没有检查项', async () => {
    const d = await createModuleDocument(t.db, owner, upload.id);
    const saved = await saveDocumentContent(t.db, owner, d.id, { baseVersion: d.version, markdown: '上传模块总述\n\n## 分片上传\n\n见 [[PAN-PRD-1]]' });
    expect(saved).toMatchObject({ version: d.version + 1, revisionNumber: 2, merged: false });
    expect((await addDocumentComment(t.db, viewer, d.id, { body: '模块文档也能评论' })).body).toBe('模块文档也能评论');
    const req = await createRequirement(t.db, owner, pan, { title: '一条需求' });
    await expect(linkDocumentRequirements(t.db, owner, d.id, { requirementIds: [req.id] })).rejects.toThrow('模块文档不关联需求');
    await expect(setDocumentCheckItemState(t.db, owner, d.id, 'prd_review', { state: 'passed' })).rejects.toThrow('模块文档没有检查项');
  });

  it('归档后只读：不能改正文、标题、恢复版本；评论照常；可以恢复为使用中', async () => {
    const d = await createModuleDocument(t.db, owner, download.id);
    const archived = await transitionDocument(t.db, editor, d.id, { to: 'archived' });
    expect(archived).toMatchObject({ status: 'archived', transitions: ['active'] });
    await expect(saveDocumentContent(t.db, owner, d.id, { baseVersion: archived.version, markdown: 'x' })).rejects.toThrow('模块文档已归档，恢复为使用中后才能修改');
    await expect(updateDocument(t.db, owner, d.id, { title: '新标题' })).rejects.toThrow('模块文档已归档');
    await expect(restoreRevision(t.db, owner, d.id, { number: 1, baseVersion: archived.version })).rejects.toThrow('模块文档已归档');
    await addDocumentComment(t.db, viewer, d.id, { body: '归档后也能评论' });
    await expect(transitionDocument(t.db, owner, d.id, { to: 'draft' })).rejects.toThrow('不能从「已归档」改为「草稿」');
    expect((await transitionDocument(t.db, owner, d.id, { to: 'active' })).status).toBe('active');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/module-docs.test.ts`
Expected: FAIL（`Cannot find module '../src/documents/module-docs'`）。

- [ ] **Step 3: `documents.ts`：类型、详情、修订写入、只读检查**

`packages/core/src/documents/documents.ts`：

1. schema import 改为：

```ts
import { documentRevisions, documents, documentTemplates, products, requirements, structureNodes } from '../db/schema';
```

constants import 改为：

```ts
import type { DocumentKind, DocumentStatus, ExternalProvider, RevisionSnapshot } from './constants';
```

2. `DocumentListItem` 里 `displayKey: string;` 之后加 `kind: DocumentKind;`。

3. `DocumentDetail` 定义之前加：

```ts
/** 模块文档所属的模块节点与业务域。 */
export type ModuleNodeRef = { id: string; name: string; status: 'active' | 'deprecated'; domain: { id: string; name: string } | null };
```

`DocumentDetail` 里 `checkItems: CheckItemView[];` 之后加：

```ts
  /** 模块文档对应的模块；变更 PRD 为空。 */
  node: ModuleNodeRef | null;
```

4. `type DocRow = typeof documents.$inferSelect;` 改为：

```ts
export type DocumentRow = typeof documents.$inferSelect;
type DocRow = DocumentRow;
```

5. `assertBaseVersion` 函数之后加：

```ts
/** 已归档的模块文档只读：正文、标题、负责人、恢复与合入都不能改；评论照常。 */
export function assertWritable(doc: DocRow): void {
  if (doc.kind === 'module' && doc.status === 'archived') throw new AppError('invalid', '模块文档已归档，恢复为使用中后才能修改');
}
```

6. `hydrate` 返回对象里 `displayKey: documentDisplayKey(keyOf.get(r.productId)!, r.number),` 之后加 `kind: r.kind,`。

7. `detailOf` 之前加：

```ts
async function moduleNodeOf(tx: Tx, nodeId: string | null): Promise<ModuleNodeRef | null> {
  if (!nodeId) return null;
  const [n] = await tx.select().from(structureNodes).where(eq(structureNodes.id, nodeId));
  if (!n) return null;
  const [p] = n.parentId ? await tx.select({ id: structureNodes.id, name: structureNodes.name }).from(structureNodes).where(eq(structureNodes.id, n.parentId)) : [];
  return { id: n.id, name: n.name, status: n.status, domain: p ? { id: p.id, name: p.name } : null };
}
```

`detailOf` 返回对象里 `checkItems: await documentCheckItemViews(tx, actor, role, doc),` 改为：

```ts
    checkItems: doc.kind === 'module' ? [] : await documentCheckItemViews(tx, actor, role, doc),
    node: await moduleNodeOf(tx, doc.nodeId),
```

8. `writeRevision`：函数声明前加 `export`，`opts` 类型改为 `{ summary: string | null; allowMerge: boolean; mergedFrom?: string | null }`，新建修订的 `.values({ … })` 里在 `authorMemberId: actor.memberId,` 之后加 `mergedFromDocumentId: opts.mergedFrom ?? null,`。函数注释末尾补一句「mergedFrom 为合入来源的变更 PRD」。

9. `writeRevision` 之后加：

```ts
/** 文档当前正文（外部 PRD 为空字符串）。 */
export async function documentMarkdownTx(tx: Tx, doc: DocRow): Promise<string> {
  if (!doc.currentRevisionId) return '';
  const [rev] = await tx.select({ snapshot: documentRevisions.snapshot }).from(documentRevisions).where(eq(documentRevisions.id, doc.currentRevisionId));
  return rev?.snapshot.markdown ?? '';
}

/**
 * 系统写入的一版（合入、功能点改名）：不与自动保存合并，版本号加一，重新定位划词评论、重建 [[ ]] 链接。
 * 不检查归档（调用方决定），事件由调用方记录。调用方已锁住文档行。
 */
export async function commitSystemRevisionTx(
  tx: Tx,
  actor: Actor,
  doc: DocRow,
  markdown: string,
  opts: { summary: string; mergedFrom: string | null },
): Promise<{ id: string; number: number; version: number }> {
  const md = assertMarkdown(markdown);
  const rev = await writeRevision(tx, actor, doc, { title: doc.title, markdown: md }, { summary: opts.summary, allowMerge: false, mergedFrom: opts.mergedFrom });
  const version = doc.version + 1;
  await tx.update(documents).set({ version, currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(documents.id, doc.id));
  await reanchorDocumentComments(tx, doc.id, md);
  await syncSourceLinks(tx, actor.orgId, { type: 'document', id: doc.id, productKey: await productKeyOf(tx, doc.productId) }, md, { markdown: true });
  return { id: rev.id, number: rev.number, version };
}
```

10. 只读检查：`updateDocument`、`saveDocumentContent`、`restoreRevision` 三处 `await requireProductRole(tx, actor, cur.productId, 'editor');` / `await requireProductRole(tx, actor, doc.productId, 'editor');` 的下一行各加一行（`updateDocument` 里变量名是 `cur`）：

```ts
    assertWritable(cur);
```

```ts
    assertWritable(doc);
```

- [ ] **Step 4: 模块文档不关联需求、没有检查项**

`packages/core/src/documents/coverage.ts` 的 `linkRequirementsTx`：`await requireProductRole(tx, actor, doc.productId, 'editor');` 之后加：

```ts
  if (doc.kind !== 'change') throw new AppError('invalid', '模块文档不关联需求');
```

`packages/core/src/documents/checks.ts`：`setDocumentCheckItemState` 与 `signDocumentCheckItem` 两个函数里，`const doc = await loadDocument(tx, documentId, { lock: true });` 的下一行各加：

```ts
    if (doc.kind !== 'change') throw new AppError('invalid', '模块文档没有检查项');
```

- [ ] **Step 5: 新建与列表**

新建 `packages/core/src/documents/module-docs.ts`：

```ts
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentRevisions, documents, products, structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { relinkDangling } from '../links/links';
import { productKeyOf } from '../requirements/requirements';
import type { DocumentStatus } from './constants';
import { type DocumentDetail, documentDetailInTx, type DocumentRow, writeRevision } from './documents';
import { documentDisplayKey } from './markdown';

export type ModuleDocumentRow = {
  node: { id: string; name: string; status: 'active' | 'deprecated' };
  featureCount: number;
  document: { id: string; displayKey: string; title: string; status: DocumentStatus; updatedAt: Date } | null;
  /** 最近一次合入（带合入来源的修订）的时间。 */
  lastMergedAt: Date | null;
};
export type ModuleDocumentGroup = { domain: { id: string; name: string; status: 'active' | 'deprecated' }; modules: ModuleDocumentRow[] };
export type ModuleDocumentTree = { productKey: string; groups: ModuleDocumentGroup[] };

/** 模块节点（结构树第二层）未删除的模块文档，没有时为 null。lock 时锁住文档行。 */
export async function findModuleDocument(tx: Tx, moduleId: string, opts: { lock?: boolean } = {}): Promise<DocumentRow | null> {
  const q = tx
    .select()
    .from(documents)
    .where(and(eq(documents.nodeId, moduleId), eq(documents.kind, 'module'), isNull(documents.deletedAt)));
  const [d] = opts.lock ? await q.for('update') : await q;
  return d ?? null;
}

/**
 * 取模块节点的模块文档，没有时新建（标题为模块名称，概述为空，第 1 版）。先锁模块节点行再查再建，
 * 同一模块的并发新建排队进行。调用方已检查权限。
 */
export async function ensureModuleDocumentTx(tx: Tx, actor: Actor, moduleId: string): Promise<{ doc: DocumentRow; created: boolean }> {
  const [node] = await tx.select().from(structureNodes).where(eq(structureNodes.id, moduleId)).for('update');
  if (!node || node.depth !== 2) throw new AppError('invalid', '只有模块节点可以有模块文档');
  const existing = await findModuleDocument(tx, moduleId, { lock: true });
  if (existing) return { doc: existing, created: false };
  const [seq] = await tx
    .update(products)
    .set({ documentSeq: sql`${products.documentSeq} + 1` })
    .where(eq(products.id, node.productId))
    .returning({ n: products.documentSeq, key: products.key });
  const [row] = await tx
    .insert(documents)
    .values({ orgId: actor.orgId, productId: node.productId, number: seq!.n, kind: 'module', source: 'native', title: node.name, nodeId: node.id, status: 'active', createdBy: actor.memberId })
    .returning();
  const rev = await writeRevision(tx, actor, row!, { title: node.name, markdown: '' }, { summary: null, allowMerge: false });
  await tx.update(documents).set({ currentRevisionId: rev.id }).where(eq(documents.id, row!.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: node.productId,
    type: 'document.created',
    subjectType: 'document',
    subjectId: row!.id,
    actor,
    payload: { number: row!.number, title: node.name, kind: 'module', nodeId: node.id },
  });
  await relinkDangling(tx, { type: 'document', id: row!.id, texts: [documentDisplayKey(seq!.key, row!.number)], withSections: true });
  return { doc: { ...row!, currentRevisionId: rev.id }, created: true };
}

/** 打开模块的模块文档，没有时新建。产品编辑及以上；重复调用返回同一份。 */
export async function createModuleDocument(db: Db, actor: Actor, nodeId: string): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [node] = await tx.select({ productId: structureNodes.productId }).from(structureNodes).where(eq(structureNodes.id, nodeId));
    if (!node) throw new AppError('not_found', '节点不存在');
    await requireProductRole(tx, actor, node.productId, 'editor');
    const { doc } = await ensureModuleDocumentTx(tx, actor, nodeId);
    return documentDetailInTx(tx, actor, doc.id);
  });
}

/** 「模块文档」页签：按业务域 → 模块列出（同级按 sort、名称），是否已有文档、功能点数、最近合入时间。 */
export async function listModuleDocuments(db: Db, actor: Actor, productId: string): Promise<ModuleDocumentTree> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const productKey = await productKeyOf(tx, productId);
    const nodes = await tx.select().from(structureNodes).where(eq(structureNodes.productId, productId)).orderBy(asc(structureNodes.sort), asc(structureNodes.name));
    const docs = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.productId, productId), eq(documents.kind, 'module'), isNull(documents.deletedAt)));
    const merged =
      docs.length > 0
        ? await tx
            .select({ id: documentRevisions.documentId, at: sql<Date>`max(${documentRevisions.createdAt})`.mapWith(documentRevisions.createdAt) })
            .from(documentRevisions)
            .where(and(inArray(documentRevisions.documentId, docs.map((d) => d.id)), isNotNull(documentRevisions.mergedFromDocumentId)))
            .groupBy(documentRevisions.documentId)
        : [];
    const docOf = new Map(docs.map((d) => [d.nodeId!, d]));
    const mergedAt = new Map(merged.map((m) => [m.id, m.at]));
    const groups = nodes
      .filter((n) => n.depth === 1)
      .map((domain) => ({
        domain: { id: domain.id, name: domain.name, status: domain.status },
        modules: nodes
          .filter((m) => m.depth === 2 && m.parentId === domain.id)
          .map((m) => {
            const d = docOf.get(m.id);
            return {
              node: { id: m.id, name: m.name, status: m.status },
              featureCount: nodes.filter((f) => f.depth === 3 && f.parentId === m.id).length,
              document: d ? { id: d.id, displayKey: documentDisplayKey(productKey, d.number), title: d.title, status: d.status, updatedAt: d.updatedAt } : null,
              lastMergedAt: d ? (mergedAt.get(d.id) ?? null) : null,
            };
          }),
      }));
    return { productKey, groups };
  });
}
```

`packages/core/src/index.ts`：在 `export * from './documents/checks';` 之后加：

```ts
export * from './documents/module-docs';
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/module-docs.test.ts test/documents.test.ts test/document-coverage.test.ts test/document-checks.test.ts test/document-comments.test.ts test/links.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/documents/documents.ts packages/core/src/documents/module-docs.ts packages/core/src/documents/coverage.ts packages/core/src/documents/checks.ts packages/core/src/index.ts packages/core/test/module-docs.test.ts
git commit -m "feat(core): 模块文档的新建、列表与详情，归档后只读

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 功能点改名同步模块文档的小节标题

**Files:**
- Modify: `packages/core/src/documents/module-docs.ts`、`packages/core/src/structure/nodes.ts`
- Test: `packages/core/test/module-doc-rename.test.ts`

**Interfaces:**
- Consumes: Task 1 `renameFeatureHeading`；Task 3 `findModuleDocument`、`documentMarkdownTx`、`commitSystemRevisionTx`
- Produces: `syncFeatureRenameTx(tx: Tx, actor: Actor, feature: { id: string; parentId: string | null; oldName: string; newName: string }): Promise<boolean>`（改了返回 true）；`updateStructureNode` 在第三层节点改名时调用

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/module-doc-rename.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { type DocumentDetail, getDocument, listRevisions, saveDocumentContent } from '../src/documents/documents';
import { createModuleDocument } from '../src/documents/module-docs';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createStructureNode, updateStructureNode } from '../src/structure/nodes';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let storage: StructureNodeView;
let upload: StructureNodeView;
let chunk: StructureNodeView;
let doc: DocumentDetail;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '秒传' });
  doc = await createModuleDocument(t.db, owner, upload.id);
  await saveDocumentContent(t.db, owner, doc.id, { baseVersion: doc.version, markdown: '总述\n\n## 1. 分片上传\n\n说明\n\n## 秒传\n\n秒传说明\n' });
});
afterAll(() => t.cleanup());

describe('功能点改名', () => {
  it('同步模块文档里该小节的标题（保留编号），生成一版并记录事件', async () => {
    const before = await getDocument(t.db, owner, doc.id);
    await updateStructureNode(t.db, owner, chunk.id, { name: '断点续传' });
    const after = await getDocument(t.db, owner, doc.id);
    expect(after.markdown).toBe('总述\n\n## 1. 断点续传\n\n说明\n\n## 秒传\n\n秒传说明\n');
    expect(after.version).toBe(before.version + 1);
    expect((await listRevisions(t.db, owner, doc.id))[0]).toMatchObject({ number: before.revisionNumber! + 1, summary: '功能点改名：分片上传 → 断点续传' });
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'document.section_renamed'));
    expect(events.map((e) => [e.subjectId, (e.payload as { changes: unknown }).changes])).toEqual([[doc.id, [{ field: 'section', old: '分片上传', new: '断点续传' }]]]);
  });

  it('找不到小节、模块或业务域改名、只改说明时不动模块文档；没有模块文档的模块下改名照常', async () => {
    const v = (await getDocument(t.db, owner, doc.id)).version;
    const extra = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '离线上传' });
    await updateStructureNode(t.db, owner, extra.id, { name: '离线' });
    await updateStructureNode(t.db, owner, upload.id, { name: '上传中心' });
    await updateStructureNode(t.db, owner, storage.id, { name: '存储服务' });
    await updateStructureNode(t.db, owner, chunk.id, { description: '只改说明' });
    expect((await getDocument(t.db, owner, doc.id)).version).toBe(v);
    const download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
    const offline = await createStructureNode(t.db, owner, pan, { parentId: download.id, name: '离线下载' });
    expect((await updateStructureNode(t.db, owner, offline.id, { name: '后台下载' })).name).toBe('后台下载');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/module-doc-rename.test.ts`
Expected: FAIL（第一个用例：正文里的标题还是「1. 分片上传」）。

- [ ] **Step 3: 实现**

`packages/core/src/documents/module-docs.ts`：

1. import 改为：

```ts
import { type DocumentDetail, commitSystemRevisionTx, documentDetailInTx, documentMarkdownTx, type DocumentRow, writeRevision } from './documents';
import { documentDisplayKey } from './markdown';
import { renameFeatureHeading } from './module-sections';
```

2. 文件末尾加：

```ts
/**
 * 功能点改名：把所在模块文档里该小节的标题改为新名称（保留原编号），写一版（摘要「功能点改名：旧名 → 新名」）。
 * 没有模块文档或找不到小节时不改。在节点改名的事务里调用；归档的模块文档同样同步，保持小节与结构树一致。
 */
export async function syncFeatureRenameTx(tx: Tx, actor: Actor, feature: { id: string; parentId: string | null; oldName: string; newName: string }): Promise<boolean> {
  if (!feature.parentId) return false;
  const doc = await findModuleDocument(tx, feature.parentId, { lock: true });
  if (!doc) return false;
  const next = renameFeatureHeading(await documentMarkdownTx(tx, doc), feature.oldName, feature.newName);
  if (next === null) return false;
  const rev = await commitSystemRevisionTx(tx, actor, doc, next, { summary: `功能点改名：${feature.oldName} → ${feature.newName}`, mergedFrom: null });
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: doc.productId,
    type: 'document.section_renamed',
    subjectType: 'document',
    subjectId: doc.id,
    actor,
    payload: { nodeId: feature.id, revision: rev.number, changes: [{ field: 'section', old: feature.oldName, new: feature.newName }] },
  });
  return true;
}
```

`packages/core/src/structure/nodes.ts`：

1. import 区加：

```ts
import { syncFeatureRenameTx } from '../documents/module-docs';
```

2. `updateStructureNode` 里

```ts
    if (next.name !== cur.name) {
      const all = await tx.select({ id: structureNodes.id, parentId: structureNodes.parentId }).from(structureNodes).where(eq(structureNodes.productId, cur.productId));
      await relinkNodes(tx, cur.productId, subtreeIds(all, nodeId));
    }
```

替换为：

```ts
    if (next.name !== cur.name) {
      const all = await tx.select({ id: structureNodes.id, parentId: structureNodes.parentId }).from(structureNodes).where(eq(structureNodes.productId, cur.productId));
      await relinkNodes(tx, cur.productId, subtreeIds(all, nodeId));
      if (cur.depth === 3) await syncFeatureRenameTx(tx, actor, { id: nodeId, parentId: cur.parentId, oldName: cur.name, newName: next.name });
    }
```

（节点行已被上面的 `update` 锁住，再锁模块文档行，与「功能点行 → 模块文档行」的锁顺序一致。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/module-doc-rename.test.ts test/module-docs.test.ts test/structure.test.ts test/links.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/documents/module-docs.ts packages/core/src/structure/nodes.ts packages/core/test/module-doc-rename.test.ts
git commit -m "feat(core): 功能点改名时同步模块文档的小节标题并生成一版

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 影响声明：查看、新增、修改、移除与锁定

**Files:**
- Create: `packages/core/src/documents/affected.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/affected-nodes.test.ts`

**Interfaces:**
- Consumes: Task 1 `prdSectionKeys`；Task 2 `documentAffectedNodes`、`AFFECTED_CHANGE_TYPES`；Task 3 `DocumentRow`、`documentMarkdownTx`、`loadDocument`
- Produces:
  - `type AffectedNodeView = { nodeId: string; name: string; path: string; module: { id: string; name: string } | null; nodeStatus: 'active' | 'deprecated'; changeType: AffectedChangeType; sourceSections: Array<{ key: string; stale: boolean }>; mergeStatus: MergeStatus; mergedRevisionNumber: number | null; mergedBy: MemberRef | null; mergedAt: Date | null }`
  - `type AffectedNodes = { editable: boolean; locked: boolean; sections: string[]; items: AffectedNodeView[] }`
  - `type StructureTree = { byId: Map<string, NodeRow>; rank: Map<string, number>; path: (id: string) => string; children: (parentId: string) => NodeRow[] }`；`loadTree(tx: Tx, productId: string): Promise<StructureTree>`
  - `assertChangeDocument(doc: DocumentRow): void`；`assertDeclarationsEditable(tx: Tx, doc: DocumentRow): Promise<void>`
  - `affectedNodesInTx(tx: Tx, doc: DocumentRow, role: ProductRole): Promise<AffectedNodes>`
  - `listAffectedNodes(db, actor, documentId): Promise<AffectedNodes>`
  - `addAffectedNode(db, actor, documentId, input: { nodeId: string; changeType: AffectedChangeType; sourceSections?: string[] }): Promise<AffectedNodes>`
  - `updateAffectedNode(db, actor, documentId, nodeId, input: { changeType?: AffectedChangeType; sourceSections?: string[] }): Promise<AffectedNodes>`
  - `removeAffectedNode(db, actor, documentId, nodeId): Promise<AffectedNodes>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/affected-nodes.test.ts`：

```ts
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentAffectedNodes, domainEvents } from '../src/db/schema';
import { addAffectedNode, listAffectedNodes, removeAffectedNode, updateAffectedNode } from '../src/documents/affected';
import { createDocument, type DocumentDetail, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import { createModuleDocument } from '../src/documents/module-docs';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createStructureNode } from '../src/structure/nodes';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;
let other: string;
let upload: StructureNodeView;
let chunk: StructureNodeView;
let instant: StructureNodeView;
let offline: StructureNodeView;
let foreign: StructureNodeView;
let prd: DocumentDetail;

const PRD_BODY = '## 背景\n\n现状\n\n## 需求说明\n\n上传改为分片\n\n### 细节\n\n断点续传';

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  other = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  const storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  instant = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '秒传' });
  const download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
  offline = await createStructureNode(t.db, owner, pan, { parentId: download.id, name: '离线下载' });
  const album = await createStructureNode(t.db, owner, other, { name: '相册' });
  const share = await createStructureNode(t.db, owner, other, { parentId: album.id, name: '分享' });
  foreign = await createStructureNode(t.db, owner, other, { parentId: share.id, name: '分享链接' });
  prd = await createDocument(t.db, owner, pan, { title: '上传改版' });
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: prd.version, markdown: PRD_BODY });
});
afterAll(() => t.cleanup());

describe('影响声明', () => {
  it('新增、修改、移除；按结构树顺序列出，带路径、所属模块与来源小节；记录事件', async () => {
    await addAffectedNode(t.db, editor, prd.id, { nodeId: instant.id, changeType: 'modified', sourceSections: ['需求说明 / 细节'] });
    const added = await addAffectedNode(t.db, editor, prd.id, { nodeId: chunk.id, changeType: 'added', sourceSections: ['需求说明', '背景', '需求说明'] });
    expect(added).toMatchObject({ editable: true, locked: false, sections: ['背景', '需求说明', '需求说明 / 细节'] });
    expect(added.items.map((i) => [i.path, i.module?.name, i.changeType, i.sourceSections, i.mergeStatus])).toEqual([
      ['存储/上传/分片上传', '上传', 'added', [{ key: '需求说明', stale: false }, { key: '背景', stale: false }], 'pending'],
      ['存储/上传/秒传', '上传', 'modified', [{ key: '需求说明 / 细节', stale: false }], 'pending'],
    ]);
    const updated = await updateAffectedNode(t.db, editor, prd.id, chunk.id, { changeType: 'modified', sourceSections: ['背景'] });
    expect(updated.items[0]).toMatchObject({ changeType: 'modified', sourceSections: [{ key: '背景', stale: false }] });
    const removed = await removeAffectedNode(t.db, editor, prd.id, instant.id);
    expect(removed.items.map((i) => i.name)).toEqual(['分片上传']);
    const seen = await listAffectedNodes(t.db, viewer, prd.id);
    expect(seen).toMatchObject({ editable: false, locked: false });
    expect(seen.items).toHaveLength(1);
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'document.affected_nodes_changed')).orderBy(asc(domainEvents.occurredAt));
    expect(events.map((e) => (e.payload as { changes: Array<{ field: string }> }).changes.map((c) => c.field))).toEqual([['affectedNode'], ['affectedNode'], ['changeType', 'sourceSections'], ['affectedNode']]);
    expect((events[3]!.payload as { changes: unknown }).changes).toEqual([{ field: 'affectedNode', old: { path: '存储/上传/秒传', changeType: 'modified', sourceSections: ['需求说明 / 细节'] }, new: null }]);
  });

  it('校验：重复、不是本产品的功能点、来源小节不存在、外部 PRD 选来源', async () => {
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: chunk.id, changeType: 'added' })).rejects.toMatchObject({ code: 'conflict', message: '该功能点已声明' });
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: upload.id, changeType: 'added' })).rejects.toThrow('只能声明本产品结构树第三层的功能点');
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: foreign.id, changeType: 'added' })).rejects.toThrow('只能声明本产品结构树第三层的功能点');
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: offline.id, changeType: 'added', sourceSections: ['不存在'] })).rejects.toThrow('PRD 中没有这些小节：不存在');
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: offline.id, changeType: 'bogus' as 'added' })).rejects.toThrow('变更类型无效');
    const ext = await createDocument(t.db, owner, pan, { title: '外部', externalUrl: 'https://docs.qq.com/doc/affected' });
    await expect(addAffectedNode(t.db, owner, ext.id, { nodeId: offline.id, changeType: 'added', sourceSections: ['背景'] })).rejects.toThrow('外部 PRD 没有正文，不能选择来源小节');
    expect((await addAffectedNode(t.db, owner, ext.id, { nodeId: offline.id, changeType: 'added' })).sections).toEqual([]);
    const mod = await createModuleDocument(t.db, owner, upload.id);
    await expect(listAffectedNodes(t.db, owner, mod.id)).rejects.toThrow('模块文档没有影响声明');
  });

  it('PRD 小节改名后来源显示已失效；修改声明时已存的失效来源可以保留', async () => {
    const cur = await listAffectedNodes(t.db, owner, prd.id);
    expect(cur.items[0]!.sourceSections).toEqual([{ key: '背景', stale: false }]);
    const d = await saveDocumentContent(t.db, editor, prd.id, { baseVersion: 2, markdown: PRD_BODY.replace('## 背景', '## 现状分析') });
    expect(d.version).toBe(3);
    const after = await listAffectedNodes(t.db, owner, prd.id);
    expect(after.items[0]!.sourceSections).toEqual([{ key: '背景', stale: true }]);
    const kept = await updateAffectedNode(t.db, owner, prd.id, chunk.id, { changeType: 'added', sourceSections: ['背景', '现状分析'] });
    expect(kept.items[0]!.sourceSections).toEqual([{ key: '背景', stale: true }, { key: '现状分析', stale: false }]);
  });

  it('权限与锁定：只读成员与只读 Token 不能改；已废弃不能改；有一条已处理后全部锁定', async () => {
    await expect(addAffectedNode(t.db, viewer, prd.id, { nodeId: offline.id, changeType: 'added' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addAffectedNode(t.db, readOnlyToken(owner), prd.id, { nodeId: offline.id, changeType: 'added' })).rejects.toMatchObject({ code: 'forbidden' });
    const dropped = await createDocument(t.db, owner, pan, { title: '将废弃' });
    await transitionDocument(t.db, owner, dropped.id, { to: 'discarded' });
    await expect(addAffectedNode(t.db, owner, dropped.id, { nodeId: offline.id, changeType: 'added' })).rejects.toThrow('「已废弃」的 PRD 不能修改影响声明');

    await t.adminDb.update(documentAffectedNodes).set({ mergeStatus: 'skipped' }).where(and(eq(documentAffectedNodes.documentId, prd.id), eq(documentAffectedNodes.nodeId, chunk.id)));
    const locked = await listAffectedNodes(t.db, owner, prd.id);
    expect(locked).toMatchObject({ editable: false, locked: true });
    await expect(addAffectedNode(t.db, owner, prd.id, { nodeId: offline.id, changeType: 'added' })).rejects.toThrow('已开始合入，影响声明不能再修改');
    await expect(updateAffectedNode(t.db, owner, prd.id, chunk.id, { changeType: 'removed' })).rejects.toThrow('已开始合入');
    await expect(removeAffectedNode(t.db, owner, prd.id, chunk.id)).rejects.toThrow('已开始合入');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/affected-nodes.test.ts`
Expected: FAIL（`Cannot find module '../src/documents/affected'`）。

- [ ] **Step 3: 实现**

新建 `packages/core/src/documents/affected.ts`：

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentAffectedNodes, documentRevisions, structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { memberNames } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import { AFFECTED_CHANGE_TYPES, type AffectedChangeType, type DocumentStatus, type MergeStatus } from './constants';
import { type DocumentRow, documentMarkdownTx, loadDocument } from './documents';
import { DOCUMENT_STATUS_LABELS } from './markdown';
import { prdSectionKeys } from './module-sections';

export const MAX_SOURCE_SECTIONS = 20;
/** 可以修改影响声明的 PRD 状态。 */
const DECLARABLE: DocumentStatus[] = ['draft', 'review', 'approved', 'launched'];

type NodeRow = typeof structureNodes.$inferSelect;

export type AffectedNodeView = {
  nodeId: string;
  name: string;
  /** 业务域/模块/功能点。 */
  path: string;
  /** 功能点所在的模块（父节点为第二层时）；已不在模块下时为空。 */
  module: { id: string; name: string } | null;
  nodeStatus: 'active' | 'deprecated';
  changeType: AffectedChangeType;
  /** 按声明顺序；stale 为 PRD 当前正文里已没有这个小节。 */
  sourceSections: Array<{ key: string; stale: boolean }>;
  mergeStatus: MergeStatus;
  mergedRevisionNumber: number | null;
  mergedBy: MemberRef | null;
  mergedAt: Date | null;
};
export type AffectedNodes = {
  /** 当前查看者能否增删改声明。 */
  editable: boolean;
  /** 已有声明被应用或跳过：声明只能在合入页处理。 */
  locked: boolean;
  /** PRD 当前正文可选的来源小节（splitSections 的键，只含有标题的小节）；外部 PRD 为空。 */
  sections: string[];
  items: AffectedNodeView[];
};

export type StructureTree = {
  byId: Map<string, NodeRow>;
  /** 先序位置：同级按 sort，再按名称。 */
  rank: Map<string, number>;
  path: (id: string) => string;
  children: (parentId: string) => NodeRow[];
};

const byTreeOrder = (a: NodeRow, b: NodeRow): number => a.sort - b.sort || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 产品的结构树：节点、先序位置、名称路径、按顺序的子节点。 */
export async function loadTree(tx: Tx, productId: string): Promise<StructureTree> {
  const rows = await tx.select().from(structureNodes).where(eq(structureNodes.productId, productId));
  const byId = new Map(rows.map((n) => [n.id, n]));
  const kids = new Map<string | null, NodeRow[]>();
  for (const n of rows) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const list of kids.values()) list.sort(byTreeOrder);
  const rank = new Map<string, number>();
  const visit = (parentId: string | null) => {
    for (const n of kids.get(parentId) ?? []) {
      rank.set(n.id, rank.size);
      visit(n.id);
    }
  };
  visit(null);
  const path = (id: string): string => {
    const names: string[] = [];
    for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) names.unshift(cur.name);
    return names.join('/');
  };
  return { byId, rank, path, children: (parentId) => kids.get(parentId) ?? [] };
}

export function assertChangeDocument(doc: DocumentRow): void {
  if (doc.kind !== 'change') throw new AppError('invalid', '模块文档没有影响声明');
}

function assertChangeType(v: string): void {
  if (!(AFFECTED_CHANGE_TYPES as readonly string[]).includes(v)) throw new AppError('invalid', '变更类型无效');
}

const rowsOf = (tx: Tx, documentId: string) => tx.select().from(documentAffectedNodes).where(eq(documentAffectedNodes.documentId, documentId));

/** 声明能否修改：变更 PRD 处于草稿到已上线之间，且还没有任何一条被应用或跳过。 */
export async function assertDeclarationsEditable(tx: Tx, doc: DocumentRow): Promise<void> {
  assertChangeDocument(doc);
  if (!DECLARABLE.includes(doc.status)) throw new AppError('invalid', `「${DOCUMENT_STATUS_LABELS[doc.status]}」的 PRD 不能修改影响声明`);
  if ((await rowsOf(tx, doc.id)).some((r) => r.mergeStatus !== 'pending')) throw new AppError('invalid', '已开始合入，影响声明不能再修改');
}

/** 来源小节：去空白、去重（保留顺序）；必须是 PRD 当前正文里的小节，或这条声明原来就有的（已失效的可以保留）。 */
function cleanSources(doc: DocumentRow, markdown: string, keys: string[] | undefined, kept: string[] = []): string[] {
  const list = [...new Set((keys ?? []).map((k) => k.trim()).filter(Boolean))];
  if (list.length === 0) return [];
  if (doc.source !== 'native') throw new AppError('invalid', '外部 PRD 没有正文，不能选择来源小节');
  if (list.length > MAX_SOURCE_SECTIONS) throw new AppError('invalid', `来源小节最多 ${MAX_SOURCE_SECTIONS} 个`);
  const valid = new Set([...prdSectionKeys(markdown), ...kept]);
  const bad = list.filter((k) => !valid.has(k));
  if (bad.length > 0) throw new AppError('invalid', `PRD 中没有这些小节：${bad.join('、')}`);
  return list;
}

const declared = (path: string, r: { changeType: AffectedChangeType; sourceSections: string[] }) => ({ path, changeType: r.changeType, sourceSections: r.sourceSections });

export async function affectedNodesInTx(tx: Tx, doc: DocumentRow, role: ProductRole): Promise<AffectedNodes> {
  const rows = await rowsOf(tx, doc.id);
  const tree = await loadTree(tx, doc.productId);
  const sections = doc.source === 'native' ? prdSectionKeys(await documentMarkdownTx(tx, doc)) : [];
  const current = new Set(sections);
  const revIds = rows.map((r) => r.mergedRevisionId).filter((x): x is string => !!x);
  const revs = revIds.length > 0 ? await tx.select({ id: documentRevisions.id, version: documentRevisions.version }).from(documentRevisions).where(inArray(documentRevisions.id, revIds)) : [];
  const revNumber = new Map(revs.map((r) => [r.id, r.version]));
  const names = await memberNames(tx, rows.map((r) => r.mergedBy));
  const locked = rows.some((r) => r.mergeStatus !== 'pending');
  const items = rows
    .map((r): AffectedNodeView => {
      const node = tree.byId.get(r.nodeId)!;
      const parent = node.parentId ? tree.byId.get(node.parentId) : undefined;
      return {
        nodeId: r.nodeId,
        name: node.name,
        path: tree.path(r.nodeId),
        module: parent && parent.depth === 2 ? { id: parent.id, name: parent.name } : null,
        nodeStatus: node.status,
        changeType: r.changeType,
        sourceSections: r.sourceSections.map((key) => ({ key, stale: !current.has(key) })),
        mergeStatus: r.mergeStatus,
        mergedRevisionNumber: r.mergedRevisionId ? (revNumber.get(r.mergedRevisionId) ?? null) : null,
        mergedBy: r.mergedBy ? { id: r.mergedBy, displayName: names.get(r.mergedBy) ?? '已删除的成员' } : null,
        mergedAt: r.mergedAt,
      };
    })
    .sort((a, b) => (tree.rank.get(a.nodeId) ?? 0) - (tree.rank.get(b.nodeId) ?? 0));
  return { editable: role !== 'viewer' && DECLARABLE.includes(doc.status) && !locked, locked, sections, items };
}

export async function listAffectedNodes(db: Db, actor: Actor, documentId: string): Promise<AffectedNodes> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    const role = await requireProductRole(tx, actor, doc.productId, 'viewer');
    assertChangeDocument(doc);
    return affectedNodesInTx(tx, doc, role);
  });
}

export async function addAffectedNode(
  db: Db,
  actor: Actor,
  documentId: string,
  input: { nodeId: string; changeType: AffectedChangeType; sourceSections?: string[] },
): Promise<AffectedNodes> {
  assertChangeType(input.changeType);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    const role = await requireProductRole(tx, actor, doc.productId, 'editor');
    await assertDeclarationsEditable(tx, doc);
    const [node] = await tx.select().from(structureNodes).where(eq(structureNodes.id, input.nodeId));
    if (!node || node.productId !== doc.productId || node.depth !== 3) throw new AppError('invalid', '只能声明本产品结构树第三层的功能点');
    const [dup] = await tx
      .select({ id: documentAffectedNodes.id })
      .from(documentAffectedNodes)
      .where(and(eq(documentAffectedNodes.documentId, doc.id), eq(documentAffectedNodes.nodeId, node.id)));
    if (dup) throw new AppError('conflict', '该功能点已声明');
    const sourceSections = cleanSources(doc, await documentMarkdownTx(tx, doc), input.sourceSections);
    await tx.insert(documentAffectedNodes).values({ orgId: actor.orgId, documentId: doc.id, nodeId: node.id, changeType: input.changeType, sourceSections });
    const tree = await loadTree(tx, doc.productId);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.affected_nodes_changed',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { nodeId: node.id, changes: [{ field: 'affectedNode', old: null, new: declared(tree.path(node.id), { changeType: input.changeType, sourceSections }) }] },
    });
    return affectedNodesInTx(tx, doc, role);
  });
}

async function loadDeclaration(tx: Tx, documentId: string, nodeId: string) {
  const [row] = await tx
    .select()
    .from(documentAffectedNodes)
    .where(and(eq(documentAffectedNodes.documentId, documentId), eq(documentAffectedNodes.nodeId, nodeId)));
  if (!row) throw new AppError('not_found', '这份 PRD 没有声明这个功能点');
  return row;
}

export async function updateAffectedNode(
  db: Db,
  actor: Actor,
  documentId: string,
  nodeId: string,
  input: { changeType?: AffectedChangeType; sourceSections?: string[] },
): Promise<AffectedNodes> {
  if (input.changeType !== undefined) assertChangeType(input.changeType);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    const role = await requireProductRole(tx, actor, doc.productId, 'editor');
    await assertDeclarationsEditable(tx, doc);
    const row = await loadDeclaration(tx, doc.id, nodeId);
    const next = {
      changeType: input.changeType ?? row.changeType,
      sourceSections: input.sourceSections === undefined ? row.sourceSections : cleanSources(doc, await documentMarkdownTx(tx, doc), input.sourceSections, row.sourceSections),
    };
    const changes = [
      ...(next.changeType === row.changeType ? [] : [{ field: 'changeType', old: row.changeType, new: next.changeType }]),
      ...(JSON.stringify(next.sourceSections) === JSON.stringify(row.sourceSections) ? [] : [{ field: 'sourceSections', old: row.sourceSections, new: next.sourceSections }]),
    ];
    if (changes.length > 0) {
      await tx.update(documentAffectedNodes).set(next).where(eq(documentAffectedNodes.id, row.id));
      const tree = await loadTree(tx, doc.productId);
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: doc.productId,
        type: 'document.affected_nodes_changed',
        subjectType: 'document',
        subjectId: doc.id,
        actor,
        payload: { nodeId, path: tree.path(nodeId), changes },
      });
    }
    return affectedNodesInTx(tx, doc, role);
  });
}

export async function removeAffectedNode(db: Db, actor: Actor, documentId: string, nodeId: string): Promise<AffectedNodes> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    const role = await requireProductRole(tx, actor, doc.productId, 'editor');
    await assertDeclarationsEditable(tx, doc);
    const row = await loadDeclaration(tx, doc.id, nodeId);
    await tx.delete(documentAffectedNodes).where(eq(documentAffectedNodes.id, row.id));
    const tree = await loadTree(tx, doc.productId);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.affected_nodes_changed',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { nodeId, changes: [{ field: 'affectedNode', old: declared(tree.path(nodeId), row), new: null }] },
    });
    return affectedNodesInTx(tx, doc, role);
  });
}
```

`packages/core/src/index.ts`：在 `export * from './documents/module-docs';` 之后加：

```ts
export * from './documents/affected';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/affected-nodes.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/documents/affected.ts packages/core/src/index.ts packages/core/test/affected-nodes.test.ts
git commit -m "feat(core): 变更 PRD 的影响声明（增删改、来源小节与失效、开始合入后锁定）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 声明影响时当场新建模块与功能点

**Files:**
- Modify: `packages/core/src/structure/nodes.ts`、`packages/core/src/documents/affected.ts`
- Test: `packages/core/test/affected-new-node.test.ts`

**Interfaces:**
- Consumes: Task 5 `assertDeclarationsEditable`
- Produces:
  - `insertStructureNodeTx(tx: Tx, actor: Actor, productId: string, input: { parentId?: string | null; name: string; description?: string | null }): Promise<StructureNodeView>`（从 `createStructureNode` 抽出：名称与说明校验、上级检查、层级上限、同名检查、事件、接上悬空链接；不检查权限）
  - `createNodeForDocument(db, actor, documentId, input: { parentId: string; name: string }): Promise<StructureNodeView>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/affected-new-node.test.ts`：

```ts
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { addAffectedNode, createNodeForDocument } from '../src/documents/affected';
import { createDocument, type DocumentDetail, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createStructureNode, updateStructureNode } from '../src/structure/nodes';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;
let storage: StructureNodeView;
let prd: DocumentDetail;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  prd = await createDocument(t.db, owner, pan, { title: '上传改版' });
});
afterAll(() => t.cleanup());

describe('当场新建节点', () => {
  it('产品编辑可以在业务域下新建模块、在模块下新建功能点，然后声明；结构树服务本身仍要求产品管理员', async () => {
    await expect(createStructureNode(t.db, editor, pan, { parentId: storage.id, name: '直接新建' })).rejects.toMatchObject({ code: 'forbidden' });
    const mod = await createNodeForDocument(t.db, editor, prd.id, { parentId: storage.id, name: '上传' });
    expect(mod).toMatchObject({ parentId: storage.id, depth: 2, name: '上传', status: 'active' });
    const feature = await createNodeForDocument(t.db, editor, prd.id, { parentId: mod.id, name: ' 分片上传 ' });
    expect(feature).toMatchObject({ parentId: mod.id, depth: 3, name: '分片上传' });
    const declared = await addAffectedNode(t.db, editor, prd.id, { nodeId: feature.id, changeType: 'added' });
    expect(declared.items.map((i) => i.path)).toEqual(['存储/上传/分片上传']);
    const created = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'structure_node.created')).orderBy(asc(domainEvents.occurredAt));
    expect(created.filter((e) => e.actorMemberId === editor.memberId).map((e) => (e.payload as { name: string }).name)).toEqual(['上传', '分片上传']);
  });

  it('同名、在功能点下新建、在已停用的节点下新建都被拒绝', async () => {
    await expect(createNodeForDocument(t.db, editor, prd.id, { parentId: storage.id, name: '上传' })).rejects.toMatchObject({ code: 'conflict', message: '同一上级下已有同名节点' });
    const download = await createNodeForDocument(t.db, editor, prd.id, { parentId: storage.id, name: '下载中心' });
    const offline = await createNodeForDocument(t.db, editor, prd.id, { parentId: download.id, name: '离线下载' });
    await expect(createNodeForDocument(t.db, editor, prd.id, { parentId: offline.id, name: '更深一层' })).rejects.toThrow('只能在业务域下新建模块，或在模块下新建功能点');
    await updateStructureNode(t.db, owner, download.id, { status: 'deprecated' });
    await expect(createNodeForDocument(t.db, editor, prd.id, { parentId: download.id, name: '新功能' })).rejects.toThrow('不能在已停用的节点下新增');
  });

  it('只读成员不能新建；声明不能修改时（已废弃）也不能新建', async () => {
    await expect(createNodeForDocument(t.db, viewer, prd.id, { parentId: storage.id, name: '只读新建' })).rejects.toMatchObject({ code: 'forbidden' });
    const dropped = await createDocument(t.db, owner, pan, { title: '将废弃' });
    await transitionDocument(t.db, owner, dropped.id, { to: 'discarded' });
    await expect(createNodeForDocument(t.db, owner, dropped.id, { parentId: storage.id, name: '废弃后新建' })).rejects.toThrow('「已废弃」的 PRD 不能修改影响声明');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/affected-new-node.test.ts`
Expected: FAIL（`createNodeForDocument` 不是 `../src/documents/affected` 的导出）。

- [ ] **Step 3: 抽出 `insertStructureNodeTx`**

`packages/core/src/structure/nodes.ts`：把整个 `createStructureNode` 函数替换为：

```ts
/** 新建节点：名称与说明校验、上级检查、层级上限、同名检查、事件、接上悬空链接。调用方已检查权限。 */
export async function insertStructureNodeTx(
  tx: Tx,
  actor: Actor,
  productId: string,
  input: { parentId?: string | null; name: string; description?: string | null },
): Promise<StructureNodeView> {
  const name = assertName(input.name);
  const description = assertDescription(input.description);
  const parentId = input.parentId ?? null;
  let depth = 1;
  if (parentId) {
    const parent = await loadNode(tx, parentId);
    if (parent.productId !== productId) throw new AppError('invalid', '上级节点不属于该产品');
    if (parent.status === 'deprecated') throw new AppError('invalid', '不能在已停用的节点下新增');
    depth = parent.depth + 1;
    if (depth > MAX_STRUCTURE_DEPTH) throw new AppError('invalid', `结构树最多 ${MAX_STRUCTURE_DEPTH} 层`);
  }
  const sort = await nextSort(tx, productId, parentId);
  let row: NodeRow;
  try {
    [row] = (await tx.insert(structureNodes).values({ orgId: actor.orgId, productId, parentId, depth, name, description, sort }).returning()) as [NodeRow];
  } catch (e) {
    duplicateName(e);
  }
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId,
    type: 'structure_node.created',
    subjectType: 'structure_node',
    subjectId: row.id,
    actor,
    payload: { name, parentId, depth },
  });
  await relinkNodes(tx, productId, [row.id]);
  return view(row);
}

export async function createStructureNode(
  db: Db,
  actor: Actor,
  productId: string,
  input: { parentId?: string | null; name: string; description?: string | null },
): Promise<StructureNodeView> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    return insertStructureNodeTx(tx, actor, productId, input);
  });
}
```

（行为不变：名称校验从事务外移到事务内，抛出的 `AppError` 相同。）

- [ ] **Step 4: `createNodeForDocument`**

`packages/core/src/documents/affected.ts`：

1. import 区加：

```ts
import type { StructureNodeView } from '../requirements/lookups';
import { insertStructureNodeTx } from '../structure/nodes';
```

2. 文件末尾加：

```ts
/**
 * 声明影响时当场新建：parentId 为业务域时新建模块，为模块时新建功能点。声明可以修改时产品编辑及以上可用
 * （结构树页签的新建仍要求产品管理员）；同名检查、事件与接上悬空链接沿用结构树服务。
 */
export async function createNodeForDocument(db: Db, actor: Actor, documentId: string, input: { parentId: string; name: string }): Promise<StructureNodeView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    await assertDeclarationsEditable(tx, doc);
    const [parent] = await tx.select().from(structureNodes).where(eq(structureNodes.id, input.parentId));
    if (!parent || parent.productId !== doc.productId) throw new AppError('invalid', '上级节点不属于该产品');
    if (parent.depth > 2) throw new AppError('invalid', '只能在业务域下新建模块，或在模块下新建功能点');
    return insertStructureNodeTx(tx, actor, doc.productId, { parentId: parent.id, name: input.name });
  });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/affected-new-node.test.ts test/affected-nodes.test.ts test/structure.test.ts test/links.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/structure/nodes.ts packages/core/src/documents/affected.ts packages/core/test/affected-new-node.test.ts
git commit -m "feat(core): 声明影响时由产品编辑当场新建模块与功能点

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 合入：合入页数据、应用、跳过与撤销、全部处理完变为已合入

**Files:**
- Create: `packages/core/src/documents/merge.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/merge.test.ts`

**Interfaces:**
- Consumes: Task 1 `applyFeatureSection`、`featureSectionBody`、`hasTopHeadings`、`sourceSectionText`；Task 3 `assertWritable`、`commitSystemRevisionTx`、`documentMarkdownTx`、`loadDocument`、`findModuleDocument`、`ensureModuleDocumentTx`；Task 5 `affectedNodesInTx`、`assertChangeDocument`、`loadTree`、`AffectedNodeView`；现有 `syncPrdCheck`
- Produces:
  - `type MergeItem = AffectedNodeView & { current: string | null; prefill: string }`
  - `type MergeGroup = { module: { id: string; name: string; path: string } | null; document: { id: string; displayKey: string; version: number; status: DocumentStatus } | null; items: MergeItem[] }`
  - `type MergePlan = { document: { id: string; displayKey: string; title: string; status: DocumentStatus }; canMerge: boolean; canReopen: boolean; done: number; total: number; groups: MergeGroup[] }`
  - `type MergeResult = { status: DocumentStatus; done: number; total: number; moduleDocument: { id: string; displayKey: string; version: number } | null }`
  - `getMergePlan(db, actor, documentId): Promise<MergePlan>`
  - `applyMerge(db, actor, documentId, nodeId, input: { baseVersion: number | null; body: string }): Promise<MergeResult>`
  - `skipMerge(db, actor, documentId, nodeId): Promise<MergeResult>`
  - `reopenMerge(db, actor, documentId, nodeId): Promise<MergeResult>`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/merge.test.ts`：

```ts
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkItemResults, documentRevisions, domainEvents } from '../src/db/schema';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import { addAffectedNode } from '../src/documents/affected';
import { createDocument, type DocumentDetail, getDocument, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import { applyMerge, getMergePlan, reopenMerge, skipMerge } from '../src/documents/merge';
import { createModuleDocument } from '../src/documents/module-docs';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, prdWorkflow, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;
let upload: StructureNodeView;
let download: StructureNodeView;
let chunk: StructureNodeView;
let instant: StructureNodeView;
let legacy: StructureNodeView;
let offline: StructureNodeView;
let moduleDoc: DocumentDetail;
let prd: DocumentDetail;
let req: RequirementListItem;

const PRD_BODY = '## 背景\n\n现状\n\n## 需求说明\n\n上传改为分片\n\n### 细节\n\n断点续传';
const MODULE_BODY = '上传总述\n\n## 秒传\n\n秒传说明\n\n## 旧接口\n\n旧接口说明\n';

async function prdState(requirementId: string): Promise<string | undefined> {
  const [r] = await t.adminDb
    .select({ state: checkItemResults.state })
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, requirementId), eq(checkItemResults.itemKey, 'prd')));
  return r?.state;
}

const markdownOf = async (id: string) => (await getDocument(t.db, owner, id)).markdown;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  const { version } = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  const storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  instant = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '秒传' });
  legacy = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '旧接口' });
  download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
  offline = await createStructureNode(t.db, owner, pan, { parentId: download.id, name: '离线下载' });
  req = await createRequirement(t.db, owner, pan, { title: '分片上传' });
  prd = await createDocument(t.db, owner, pan, { title: '上传改版', requirementIds: [req.id] }); // PAN-PRD-1
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: prd.version, markdown: PRD_BODY });
  moduleDoc = await createModuleDocument(t.db, owner, upload.id); // PAN-PRD-2
  await saveDocumentContent(t.db, owner, moduleDoc.id, { baseVersion: moduleDoc.version, markdown: MODULE_BODY });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: chunk.id, changeType: 'added', sourceSections: ['需求说明'] });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: instant.id, changeType: 'modified', sourceSections: ['需求说明 / 细节', '背景'] });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: legacy.id, changeType: 'removed' });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: offline.id, changeType: 'added' });
});
afterAll(() => t.cleanup());

describe('合入', () => {
  it('合入页：按模块分组，左侧为模块文档现状，右侧预填来源小节；未上线时不能合入', async () => {
    const plan = await getMergePlan(t.db, editor, prd.id);
    expect(plan).toMatchObject({ document: { displayKey: 'PAN-PRD-1', status: 'draft' }, canMerge: false, canReopen: false, done: 0, total: 4 });
    expect(plan.groups.map((g) => [g.module?.path, g.document?.displayKey ?? null])).toEqual([
      ['存储/上传', 'PAN-PRD-2'],
      ['存储/下载', null],
    ]);
    expect(plan.groups[0]!.items.map((i) => [i.name, i.current, i.prefill])).toEqual([
      ['分片上传', null, '上传改为分片\n\n### 细节\n\n断点续传'],
      ['秒传', '秒传说明', '断点续传\n\n现状'],
      ['旧接口', '旧接口说明', ''],
    ]);
    expect(plan.groups[1]!.items.map((i) => [i.name, i.current, i.prefill])).toEqual([['离线下载', null, '']]);
    await expect(applyMerge(t.db, owner, prd.id, chunk.id, { baseVersion: plan.groups[0]!.document!.version, body: 'x' })).rejects.toThrow('只有已上线的 PRD 可以合入');
    for (const to of ['review', 'approved', 'launched'] as const) await transitionDocument(t.db, owner, prd.id, { to });
    expect(await getMergePlan(t.db, viewer, prd.id)).toMatchObject({ canMerge: false, canReopen: false });
    expect(await getMergePlan(t.db, editor, prd.id)).toMatchObject({ canMerge: true, canReopen: true });
  });

  it('应用：新增按结构树顺序插入、修改替换、删除移除；每次一版，带合入来源；版本冲突；内容不能有二级标题', async () => {
    let plan = await getMergePlan(t.db, editor, prd.id);
    const v0 = plan.groups[0]!.document!.version;
    const r1 = await applyMerge(t.db, editor, prd.id, chunk.id, { baseVersion: v0, body: plan.groups[0]!.items[0]!.prefill });
    expect(r1).toMatchObject({ status: 'launched', done: 1, total: 4, moduleDocument: { id: moduleDoc.id, displayKey: 'PAN-PRD-2', version: v0 + 1 } });
    expect(await markdownOf(moduleDoc.id)).toBe('上传总述\n\n## 分片上传\n\n上传改为分片\n\n### 细节\n\n断点续传\n\n## 秒传\n\n秒传说明\n\n## 旧接口\n\n旧接口说明\n');
    const [rev] = await t.adminDb.select().from(documentRevisions).where(eq(documentRevisions.documentId, moduleDoc.id)).orderBy(asc(documentRevisions.version)).then((rows) => rows.slice(-1));
    expect(rev).toMatchObject({ summary: '合入 PAN-PRD-1：分片上传', mergedFromDocumentId: prd.id, authorMemberId: editor.memberId });

    await expect(applyMerge(t.db, editor, prd.id, instant.id, { baseVersion: v0, body: '新的秒传' })).rejects.toMatchObject({
      code: 'conflict',
      message: '模块文档已被其他人修改，请刷新左侧内容后重试',
      details: { version: v0 + 1 },
    });
    await expect(applyMerge(t.db, editor, prd.id, instant.id, { baseVersion: v0 + 1, body: '正文\n## 新小节' })).rejects.toThrow('合入内容里不能有一级或二级标题');
    await applyMerge(t.db, editor, prd.id, instant.id, { baseVersion: v0 + 1, body: '断点续传，单文件最大 10 GB' });
    const r3 = await applyMerge(t.db, editor, prd.id, legacy.id, { baseVersion: v0 + 2, body: '应被忽略' });
    expect(r3).toMatchObject({ status: 'launched', done: 3, moduleDocument: { version: v0 + 3 } });
    expect(await markdownOf(moduleDoc.id)).toBe('上传总述\n\n## 分片上传\n\n上传改为分片\n\n### 细节\n\n断点续传\n\n## 秒传\n\n断点续传，单文件最大 10 GB\n');
    await expect(applyMerge(t.db, editor, prd.id, chunk.id, { baseVersion: v0 + 3, body: 'x' })).rejects.toThrow('这个功能点已处理');

    plan = await getMergePlan(t.db, editor, prd.id);
    expect(plan.groups[0]!.items.map((i) => [i.name, i.mergeStatus, i.mergedRevisionNumber, i.mergedBy?.displayName])).toEqual([
      ['分片上传', 'applied', 2, '编辑甲'],
      ['秒传', 'applied', 3, '编辑甲'],
      ['旧接口', 'applied', 4, '编辑甲'],
    ]);
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'document.merged')).orderBy(asc(domainEvents.occurredAt));
    expect(events.map((e) => [e.subjectId, (e.payload as { changes: unknown }).changes])).toEqual([
      [moduleDoc.id, [{ field: 'section', old: null, new: '分片上传' }]],
      [moduleDoc.id, [{ field: 'section', old: '秒传', new: '秒传' }]],
      [moduleDoc.id, [{ field: 'section', old: '旧接口', new: null }]],
    ]);
  });

  it('跳过后全部处理完即为已合入；撤销跳过退回已上线；没有模块文档时自动新建；「PRD」检查项同步', async () => {
    const skipped = await skipMerge(t.db, editor, prd.id, offline.id);
    expect(skipped).toMatchObject({ status: 'merged', done: 4, total: 4, moduleDocument: null });
    expect((await getDocument(t.db, owner, prd.id)).status).toBe('merged');
    expect(await getMergePlan(t.db, editor, prd.id)).toMatchObject({ canMerge: false, canReopen: true });

    const reopened = await reopenMerge(t.db, editor, prd.id, offline.id);
    expect(reopened).toMatchObject({ status: 'launched', done: 3, total: 4 });
    expect((await getDocument(t.db, owner, prd.id)).status).toBe('launched');
    await expect(reopenMerge(t.db, editor, prd.id, chunk.id)).rejects.toThrow('只有已跳过的功能点可以撤销');

    // 模拟「PRD」检查项与 PRD 状态不一致，验证完成时同步
    await t.adminDb
      .update(checkItemResults)
      .set({ state: 'in_progress' })
      .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, req.id), eq(checkItemResults.itemKey, 'prd')));
    const done = await applyMerge(t.db, editor, prd.id, offline.id, { baseVersion: null, body: '支持离线下载' });
    expect(done).toMatchObject({ status: 'merged', done: 4, total: 4, moduleDocument: { displayKey: 'PAN-PRD-3', version: 2 } });
    expect(await markdownOf(done.moduleDocument!.id)).toBe('## 离线下载\n\n支持离线下载\n');
    expect((await getDocument(t.db, owner, done.moduleDocument!.id)).node).toMatchObject({ id: download.id });
    expect(await prdState(req.id)).toBe('passed');
    const statusEvents = await t.adminDb
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.type, 'document.status_changed'), eq(domainEvents.subjectId, prd.id)))
      .orderBy(asc(domainEvents.occurredAt));
    expect(statusEvents.slice(-3).map((e) => (e.payload as { changes: unknown }).changes)).toEqual([
      [{ field: 'status', old: 'launched', new: 'merged' }],
      [{ field: 'status', old: 'merged', new: 'launched' }],
      [{ field: 'status', old: 'launched', new: 'merged' }],
    ]);
    await expect(skipMerge(t.db, editor, prd.id, offline.id)).rejects.toThrow('只有已上线的 PRD 可以合入');
  });

  it('权限：只读成员与只读 Token 不能应用、跳过、撤销；不是变更 PRD、模块文档已归档时不能合入', async () => {
    const other = await createDocument(t.db, owner, pan, { title: '另一份' });
    const node = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '回收站' });
    await addAffectedNode(t.db, owner, other.id, { nodeId: node.id, changeType: 'added' });
    for (const to of ['review', 'approved', 'launched'] as const) await transitionDocument(t.db, owner, other.id, { to });
    const version = (await getDocument(t.db, owner, moduleDoc.id)).version;
    await expect(applyMerge(t.db, viewer, other.id, node.id, { baseVersion: version, body: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(skipMerge(t.db, readOnlyToken(owner), other.id, node.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(reopenMerge(t.db, viewer, other.id, node.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getMergePlan(t.db, owner, moduleDoc.id)).rejects.toThrow('模块文档没有影响声明');
    await transitionDocument(t.db, owner, moduleDoc.id, { to: 'archived' });
    await expect(applyMerge(t.db, owner, other.id, node.id, { baseVersion: version, body: 'x' })).rejects.toThrow('模块文档已归档');
    await transitionDocument(t.db, owner, moduleDoc.id, { to: 'active' });
    expect((await applyMerge(t.db, owner, other.id, node.id, { baseVersion: version, body: '回收站说明' })).status).toBe('merged');
  });
});
```

修订号的来由：`moduleDoc` 由 `createModuleDocument` 建出第 1 版（版本号 1）；同一作者 5 分钟内的 `saveDocumentContent` 合并进第 1 版（版本号 2）；之后三次合入各写一版，依次为第 2、3、4 版（版本号 3、4、5）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/merge.test.ts`
Expected: FAIL（`Cannot find module '../src/documents/merge'`）。

- [ ] **Step 3: 实现**

新建 `packages/core/src/documents/merge.ts`：

```ts
import { and, asc, eq, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentAffectedNodes, documents, requirements, structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { productKeyOf } from '../requirements/requirements';
import { type AffectedNodeView, affectedNodesInTx, assertChangeDocument, loadTree } from './affected';
import type { DocumentStatus } from './constants';
import { syncPrdCheck } from './coverage';
import { assertWritable, commitSystemRevisionTx, type DocumentRow, documentMarkdownTx, loadDocument } from './documents';
import { documentDisplayKey } from './markdown';
import { ensureModuleDocumentTx, findModuleDocument } from './module-docs';
import { applyFeatureSection, featureSectionBody, hasTopHeadings, sourceSectionText } from './module-sections';

export type MergeItem = AffectedNodeView & {
  /** 模块文档中该功能点小节的当前正文（不含标题行）；模块文档不存在或没有这个小节时为空。 */
  current: string | null;
  /** 右侧预填：来源小节内容按声明顺序拼接（失效的跳过）；removed 为空字符串。 */
  prefill: string;
};
export type MergeGroup = {
  /** 功能点所在的模块；已不在模块下的功能点归入 module 为空的一组（不能应用，只能跳过）。 */
  module: { id: string; name: string; path: string } | null;
  document: { id: string; displayKey: string; version: number; status: DocumentStatus } | null;
  items: MergeItem[];
};
export type MergePlan = {
  document: { id: string; displayKey: string; title: string; status: DocumentStatus };
  /** 能否应用、跳过：产品编辑及以上，PRD 为已上线。 */
  canMerge: boolean;
  /** 能否撤销跳过：产品编辑及以上，PRD 为已上线或已合入。 */
  canReopen: boolean;
  done: number;
  total: number;
  groups: MergeGroup[];
};
export type MergeResult = { status: DocumentStatus; done: number; total: number; moduleDocument: { id: string; displayKey: string; version: number } | null };

export async function getMergePlan(db: Db, actor: Actor, documentId: string): Promise<MergePlan> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    const role = await requireProductRole(tx, actor, doc.productId, 'viewer');
    assertChangeDocument(doc);
    const { items } = await affectedNodesInTx(tx, doc, role);
    const productKey = await productKeyOf(tx, doc.productId);
    const prdMarkdown = await documentMarkdownTx(tx, doc);
    const tree = await loadTree(tx, doc.productId);
    const groups: MergeGroup[] = [];
    const moduleMarkdown = new Map<string, string>();
    for (const item of items) {
      const moduleId = item.module?.id ?? null;
      let g = groups.find((x) => (x.module?.id ?? null) === moduleId);
      if (!g) {
        const mdoc = moduleId ? await findModuleDocument(tx, moduleId) : null;
        if (mdoc) moduleMarkdown.set(mdoc.id, await documentMarkdownTx(tx, mdoc));
        g = {
          module: item.module ? { ...item.module, path: tree.path(item.module.id) } : null,
          document: mdoc ? { id: mdoc.id, displayKey: documentDisplayKey(productKey, mdoc.number), version: mdoc.version, status: mdoc.status } : null,
          items: [],
        };
        groups.push(g);
      }
      const current = g.document ? featureSectionBody(moduleMarkdown.get(g.document.id)!, item.name) : null;
      const prefill =
        item.changeType === 'removed'
          ? ''
          : item.sourceSections
              .filter((s) => !s.stale)
              .map((s) => sourceSectionText(prdMarkdown, s.key))
              .filter((x): x is string => !!x)
              .join('\n\n');
      g.items.push({ ...item, current, prefill });
    }
    const canEdit = role !== 'viewer';
    return {
      document: { id: doc.id, displayKey: documentDisplayKey(productKey, doc.number), title: doc.title, status: doc.status },
      canMerge: canEdit && doc.status === 'launched',
      canReopen: canEdit && (doc.status === 'launched' || doc.status === 'merged'),
      done: items.filter((i) => i.mergeStatus !== 'pending').length,
      total: items.length,
      groups,
    };
  });
}

/** 锁住变更 PRD 与这条声明（锁顺序的前两步），检查产品编辑权限。 */
async function lockDeclaration(tx: Tx, actor: Actor, documentId: string, nodeId: string) {
  const doc = await loadDocument(tx, documentId, { lock: true });
  await requireProductRole(tx, actor, doc.productId, 'editor');
  assertChangeDocument(doc);
  const [row] = await tx
    .select()
    .from(documentAffectedNodes)
    .where(and(eq(documentAffectedNodes.documentId, doc.id), eq(documentAffectedNodes.nodeId, nodeId)))
    .for('update');
  if (!row) throw new AppError('not_found', '这份 PRD 没有声明这个功能点');
  return { doc, row };
}

function assertLaunched(doc: DocumentRow): void {
  if (doc.status !== 'launched') throw new AppError('invalid', '只有已上线的 PRD 可以合入');
}

async function progressOf(tx: Tx, documentId: string): Promise<{ done: number; total: number }> {
  const rows = await tx.select({ s: documentAffectedNodes.mergeStatus }).from(documentAffectedNodes).where(eq(documentAffectedNodes.documentId, documentId));
  return { done: rows.filter((r) => r.s !== 'pending').length, total: rows.length };
}

/** 改 PRD 状态（已上线 ↔ 已合入），记录事件，并按状态同步覆盖需求的「PRD」检查项。调用方已锁住 PRD。 */
async function setDocumentStatus(tx: Tx, actor: Actor, doc: DocumentRow, to: DocumentStatus): Promise<void> {
  await tx.update(documents).set({ status: to, updatedAt: new Date() }).where(eq(documents.id, doc.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: doc.productId,
    type: 'document.status_changed',
    subjectType: 'document',
    subjectId: doc.id,
    actor,
    payload: { changes: [{ field: 'status', old: doc.status, new: to }] },
  });
  const covered = await tx
    .select({ id: requirements.id })
    .from(requirements)
    .where(and(eq(requirements.changeDocumentId, doc.id), isNull(requirements.deletedAt)))
    .orderBy(asc(requirements.id))
    .for('update');
  await syncPrdCheck(tx, actor, { id: doc.id, productId: doc.productId, status: to }, covered.map((r) => r.id));
}

/** 应用或跳过之后：已上线的 PRD 的声明全部处理完时改为已合入。 */
async function finish(tx: Tx, actor: Actor, doc: DocumentRow): Promise<{ status: DocumentStatus; done: number; total: number }> {
  const p = await progressOf(tx, doc.id);
  if (doc.status === 'launched' && p.total > 0 && p.done === p.total) {
    await setDocumentStatus(tx, actor, doc, 'merged');
    return { status: 'merged', ...p };
  }
  return { status: doc.status, ...p };
}

/**
 * 应用一个功能点：锁顺序为变更 PRD → 声明 → 模块节点 → 模块文档（不存在则新建）。baseVersion 是客户端看到的模块文档版本号
 * （文档不存在时为 null），与当前值不同返回冲突。added / modified 替换或按顺序插入该小节，removed 删除该小节；不论正文是否变化都写一版。
 */
export async function applyMerge(db: Db, actor: Actor, documentId: string, nodeId: string, input: { baseVersion: number | null; body: string }): Promise<MergeResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, row } = await lockDeclaration(tx, actor, documentId, nodeId);
    assertLaunched(doc);
    if (row.mergeStatus !== 'pending') throw new AppError('invalid', '这个功能点已处理');
    const removing = row.changeType === 'removed';
    if (!removing && hasTopHeadings(input.body)) throw new AppError('invalid', '合入内容里不能有一级或二级标题（二级标题是功能点的分节），请改为三级及以下');
    const tree = await loadTree(tx, doc.productId);
    const node = tree.byId.get(nodeId)!;
    const parent = node.parentId ? tree.byId.get(node.parentId) : undefined;
    if (!parent || parent.depth !== 2) throw new AppError('invalid', '这个功能点已不在任何模块下，无法合入，请跳过');
    await tx.select({ id: structureNodes.id }).from(structureNodes).where(eq(structureNodes.id, parent.id)).for('update');
    const existing = await findModuleDocument(tx, parent.id, { lock: true });
    if ((existing?.version ?? null) !== input.baseVersion) {
      throw new AppError('conflict', '模块文档已被其他人修改，请刷新左侧内容后重试', { version: existing?.version ?? null });
    }
    if (existing) assertWritable(existing);
    const mdoc = existing ?? (await ensureModuleDocumentTx(tx, actor, parent.id)).doc;
    const before = await documentMarkdownTx(tx, mdoc);
    const had = featureSectionBody(before, node.name) !== null;
    const next = applyFeatureSection(before, { name: node.name, body: removing ? '' : input.body, order: tree.children(parent.id).map((n) => n.name), remove: removing });
    const productKey = await productKeyOf(tx, doc.productId);
    const prdKey = documentDisplayKey(productKey, doc.number);
    const rev = await commitSystemRevisionTx(tx, actor, mdoc, next, { summary: `合入 ${prdKey}：${node.name}`, mergedFrom: doc.id });
    await tx
      .update(documentAffectedNodes)
      .set({ mergeStatus: 'applied', mergedRevisionId: rev.id, mergedBy: actor.memberId, mergedAt: new Date() })
      .where(eq(documentAffectedNodes.id, row.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.merged',
      subjectType: 'document',
      subjectId: mdoc.id,
      actor,
      payload: {
        changeDocumentId: doc.id,
        changeDocument: prdKey,
        nodeId,
        changeType: row.changeType,
        revision: rev.number,
        changes: [{ field: 'section', old: had ? node.name : null, new: removing ? null : node.name }],
      },
    });
    const progress = await finish(tx, actor, doc);
    return { ...progress, moduleDocument: { id: mdoc.id, displayKey: documentDisplayKey(productKey, mdoc.number), version: rev.version } };
  });
}

export async function skipMerge(db: Db, actor: Actor, documentId: string, nodeId: string): Promise<MergeResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, row } = await lockDeclaration(tx, actor, documentId, nodeId);
    assertLaunched(doc);
    if (row.mergeStatus !== 'pending') throw new AppError('invalid', '这个功能点已处理');
    await tx.update(documentAffectedNodes).set({ mergeStatus: 'skipped', mergedBy: actor.memberId, mergedAt: new Date() }).where(eq(documentAffectedNodes.id, row.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.affected_node_skipped',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { nodeId, changes: [{ field: 'mergeStatus', old: 'pending', new: 'skipped' }] },
    });
    return { ...(await finish(tx, actor, doc)), moduleDocument: null };
  });
}

/** 撤销跳过：skipped → pending。PRD 已因全部处理完变为已合入时退回已上线。 */
export async function reopenMerge(db: Db, actor: Actor, documentId: string, nodeId: string): Promise<MergeResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, row } = await lockDeclaration(tx, actor, documentId, nodeId);
    if (doc.status !== 'launched' && doc.status !== 'merged') throw new AppError('invalid', '只有已上线的 PRD 可以合入');
    if (row.mergeStatus !== 'skipped') throw new AppError('invalid', '只有已跳过的功能点可以撤销');
    await tx.update(documentAffectedNodes).set({ mergeStatus: 'pending', mergedBy: null, mergedAt: null }).where(eq(documentAffectedNodes.id, row.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.affected_node_reopened',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { nodeId, changes: [{ field: 'mergeStatus', old: 'skipped', new: 'pending' }] },
    });
    if (doc.status === 'merged') await setDocumentStatus(tx, actor, doc, 'launched');
    const p = await progressOf(tx, doc.id);
    return { status: 'launched', ...p, moduleDocument: null };
  });
}
```

`packages/core/src/index.ts`：在 `export * from './documents/affected';` 之后加：

```ts
export * from './documents/merge';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/merge.test.ts test/affected-nodes.test.ts test/module-docs.test.ts test/document-coverage.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/documents/merge.ts packages/core/src/index.ts packages/core/test/merge.test.ts
git commit -m "feat(core): 按功能点合入模块文档（应用、跳过、撤销），全部处理完 PRD 变为已合入

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 合入来源与合入记录；节点链接卡指向模块文档

**Files:**
- Modify: `packages/core/src/documents/documents.ts`（`listRevisions` 的合入来源）、`packages/core/src/documents/merge.ts`（合入记录）、`packages/core/src/links/cards.ts`（节点链接卡）
- Test: `packages/core/test/merge-history.test.ts`、`packages/core/test/link-queries.test.ts`

**Interfaces:**
- Consumes: Task 3 `findModuleDocument` 的约定（`kind = 'module'` 且未删除）；Task 7 `applyMerge`
- Produces:
  - `RevisionListItem.mergedFrom: { id: string; displayKey: string; title: string } | null`
  - `type MergeRecord = { revisionNumber: number; mergedAt: Date; by: MemberRef | null; changeType: AffectedChangeType; feature: { id: string; name: string }; changeDocument: { id: string; displayKey: string; title: string } }`；`listMergeRecords(db, actor, documentId): Promise<MergeRecord[]>`（变更 PRD 返回空数组）
  - `LinkCard.href`（结构树节点）：第一层 `requirements?product=KEY&node={id}`；第二层 `documents/KEY-PRD-n` 或 `documents?product=KEY&view=modules&node={模块 id}`；第三层 `documents/KEY-PRD-n?section={功能点名称（encodeURIComponent）}` 或 `documents?product=KEY&view=modules&node={父模块 id}`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/merge-history.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addAffectedNode } from '../src/documents/affected';
import { createDocument, type DocumentDetail, listRevisions, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import { applyMerge, listMergeRecords } from '../src/documents/merge';
import type { Actor } from '../src/domain-types';
import type { LinkCard } from '../src/links/cards';
import { getRequirementByKey } from '../src/requirements/detail';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createRequirement } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let pan: string;
let storage: StructureNodeView;
let upload: StructureNodeView;
let download: StructureNodeView;
let chunk: StructureNodeView;
let prd: DocumentDetail;
let moduleId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  editor = await asMember(t.db, owner, '编辑甲');
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  await createStructureNode(t.db, owner, pan, { parentId: download.id, name: '离线下载' });
  prd = await createDocument(t.db, owner, pan, { title: '上传改版' }); // PAN-PRD-1
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: prd.version, markdown: '## 需求说明\n\n上传改为分片' });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: chunk.id, changeType: 'added', sourceSections: ['需求说明'] });
  for (const to of ['review', 'approved', 'launched'] as const) await transitionDocument(t.db, owner, prd.id, { to });
  moduleId = (await applyMerge(t.db, editor, prd.id, chunk.id, { baseVersion: null, body: '上传改为分片' })).moduleDocument!.id; // PAN-PRD-2
});
afterAll(() => t.cleanup());

describe('合入历史', () => {
  it('修订列表带合入来源；合入记录列出功能点、变更类型、来源 PRD 与处理人', async () => {
    const revs = await listRevisions(t.db, owner, moduleId);
    expect(revs.map((r) => [r.number, r.summary, r.mergedFrom])).toEqual([
      [2, '合入 PAN-PRD-1：分片上传', { id: prd.id, displayKey: 'PAN-PRD-1', title: '上传改版' }],
      [1, null, null],
    ]);
    const records = await listMergeRecords(t.db, owner, moduleId);
    expect(records).toMatchObject([
      { revisionNumber: 2, changeType: 'added', feature: { id: chunk.id, name: '分片上传' }, changeDocument: { id: prd.id, displayKey: 'PAN-PRD-1', title: '上传改版' }, by: { displayName: '编辑甲' } },
    ]);
    expect(records[0]!.mergedAt).toBeInstanceOf(Date);
    expect(await listMergeRecords(t.db, owner, prd.id)).toEqual([]);
    expect((await listRevisions(t.db, owner, prd.id)).every((r) => r.mergedFrom === null)).toBe(true);
  });

  it('节点链接卡：模块与功能点指向模块文档（功能点带小节）；模块还没有文档时指向模块文档页签；业务域仍指向需求列表', async () => {
    const src = await createRequirement(t.db, owner, pan, {
      title: '引用方',
      description: '[[存储]] [[存储/上传]] [[存储/上传/分片上传]] [[存储/下载]] [[存储/下载/离线下载]]',
    });
    const cards = Object.fromEntries((await getRequirementByKey(t.db, owner, src.displayKey)).links.map((c: LinkCard) => [c.text, c.href]));
    expect(cards).toEqual({
      'PAN/存储': `requirements?product=PAN&node=${storage.id}`,
      'PAN/存储/上传': 'documents/PAN-PRD-2',
      'PAN/存储/上传/分片上传': `documents/PAN-PRD-2?section=${encodeURIComponent('分片上传')}`,
      'PAN/存储/下载': `documents?product=PAN&view=modules&node=${download.id}`,
      'PAN/存储/下载/离线下载': `documents?product=PAN&view=modules&node=${download.id}`,
    });
  });
});
```

`packages/core/test/link-queries.test.ts`：「当前编号、标题与状态……」用例里

```ts
    expect(cards['PAN/会员/登录']).toMatchObject({ state: 'ok', displayKey: '会员/登录', href: `requirements?product=PAN&node=${node.id}` });
```

改为（`会员/登录` 是第二层节点，还没有模块文档）：

```ts
    expect(cards['PAN/会员/登录']).toMatchObject({ state: 'ok', displayKey: '会员/登录', href: `documents?product=PAN&view=modules&node=${node.id}` });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/core exec vitest run test/merge-history.test.ts test/link-queries.test.ts`
Expected: FAIL（`listMergeRecords` 不存在；节点卡仍指向需求列表）。

- [ ] **Step 3: 修订列表的合入来源**

`packages/core/src/documents/documents.ts`：

1. `RevisionListItem` 改为：

```ts
export type RevisionListItem = {
  number: number;
  summary: string | null;
  author: MemberRef | null;
  /** 合入产生的修订：来源变更 PRD。 */
  mergedFrom: { id: string; displayKey: string; title: string } | null;
  createdAt: Date;
  updatedAt: Date;
};
```

2. `listRevisions` 里 `const names = await memberNames(tx, rows.map((r) => r.authorMemberId));` 之后加：

```ts
    const sourceIds = [...new Set(rows.map((r) => r.mergedFromDocumentId).filter((x): x is string => !!x))];
    const sources = sourceIds.length > 0 ? await tx.select({ id: documents.id, number: documents.number, title: documents.title }).from(documents).where(inArray(documents.id, sourceIds)) : [];
    const productKey = sources.length > 0 ? await productKeyOf(tx, doc.productId) : '';
    const sourceOf = new Map(sources.map((s) => [s.id, { id: s.id, displayKey: documentDisplayKey(productKey, s.number), title: s.title }]));
```

返回对象里 `author: …,` 之后加：

```ts
      mergedFrom: r.mergedFromDocumentId ? (sourceOf.get(r.mergedFromDocumentId) ?? null) : null,
```

（变更 PRD 与它合入的模块文档在同一产品内，编号前缀相同。）

- [ ] **Step 4: 合入记录**

`packages/core/src/documents/merge.ts`：

1. import 改为：

```ts
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentAffectedNodes, documentRevisions, documents, requirements, structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { memberNames } from '../requirements/context';
import { type MemberRef, productKeyOf } from '../requirements/requirements';
import { type AffectedNodeView, affectedNodesInTx, assertChangeDocument, loadTree } from './affected';
import type { AffectedChangeType, DocumentStatus } from './constants';
```

（其余 import 不变。）

2. 文件末尾加：

```ts
export type MergeRecord = {
  revisionNumber: number;
  mergedAt: Date;
  by: MemberRef | null;
  changeType: AffectedChangeType;
  feature: { id: string; name: string };
  changeDocument: { id: string; displayKey: string; title: string };
};

/** 模块文档的合入记录：来自哪些变更 PRD 的哪些功能点，按修订号倒序。变更 PRD 返回空数组。 */
export async function listMergeRecords(db: Db, actor: Actor, documentId: string): Promise<MergeRecord[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    if (doc.kind !== 'module') return [];
    const rows = await tx
      .select({ a: documentAffectedNodes, version: documentRevisions.version, revisedAt: documentRevisions.createdAt, prdNumber: documents.number, prdTitle: documents.title, nodeName: structureNodes.name })
      .from(documentAffectedNodes)
      .innerJoin(documentRevisions, eq(documentRevisions.id, documentAffectedNodes.mergedRevisionId))
      .innerJoin(documents, eq(documents.id, documentAffectedNodes.documentId))
      .innerJoin(structureNodes, eq(structureNodes.id, documentAffectedNodes.nodeId))
      .where(eq(documentRevisions.documentId, doc.id))
      .orderBy(desc(documentRevisions.version));
    const key = await productKeyOf(tx, doc.productId);
    const names = await memberNames(tx, rows.map((r) => r.a.mergedBy));
    return rows.map((r) => ({
      revisionNumber: r.version,
      mergedAt: r.a.mergedAt ?? r.revisedAt,
      by: r.a.mergedBy ? { id: r.a.mergedBy, displayName: names.get(r.a.mergedBy) ?? '已删除的成员' } : null,
      changeType: r.a.changeType,
      feature: { id: r.a.nodeId, name: r.nodeName },
      changeDocument: { id: r.a.documentId, displayKey: documentDisplayKey(key, r.prdNumber), title: r.prdTitle },
    }));
  });
}
```

- [ ] **Step 5: 节点链接卡**

`packages/core/src/links/cards.ts` 的 `loadTargets` 里，把整个 `const nodeIds = ids('structure_node');` 区块（到 `return out;` 之前）替换为：

```ts
  const nodeIds = ids('structure_node');
  if (nodeIds.length > 0) {
    const ns = await tx.select().from(structureNodes).where(inArray(structureNodes.id, nodeIds));
    // 模块与功能点链接到模块文档：模块为自己，功能点为父模块；业务域仍链接到需求列表
    const moduleOf = (n: { id: string; depth: number; parentId: string | null }): string | null => (n.depth === 2 ? n.id : n.depth === 3 ? n.parentId : null);
    const moduleIds = [...new Set(ns.map(moduleOf).filter((x): x is string => !!x))];
    const moduleDocs =
      moduleIds.length > 0
        ? await tx
            .select({ nodeId: documents.nodeId, number: documents.number })
            .from(documents)
            .where(and(inArray(documents.nodeId, moduleIds), eq(documents.kind, 'module'), isNull(documents.deletedAt)))
        : [];
    const docNumberOf = new Map(moduleDocs.map((d) => [d.nodeId!, d.number]));
    for (const pid of new Set(ns.map((n) => n.productId))) {
      const paths = await nodePathTexts(tx, pid);
      const key = keyOf.get(pid)!;
      for (const n of ns.filter((x) => x.productId === pid)) {
        const moduleId = moduleOf(n);
        const number = moduleId ? docNumberOf.get(moduleId) : undefined;
        const href = !moduleId
          ? `requirements?product=${key}&node=${n.id}`
          : number === undefined
            ? `documents?product=${key}&view=modules&node=${moduleId}`
            : `documents/${documentDisplayKey(key, number)}${n.depth === 3 ? `?section=${encodeURIComponent(n.name)}` : ''}`;
        out.set(`structure_node:${n.id}`, {
          productId: pid,
          numbered: false,
          state: n.status === 'deprecated' ? 'canceled' : 'ok',
          displayKey: paths.get(n.id)!.slice(key.length + 1),
          title: null,
          status: n.status === 'deprecated' ? { label: '已停用', color: null } : null,
          href,
        });
      }
    }
  }
```

（`and`、`eq`、`isNull`、`documents`、`documentDisplayKey` 已在该文件的 import 里。）

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/core exec vitest run test/merge-history.test.ts test/link-queries.test.ts test/documents.test.ts test/merge.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/documents/documents.ts packages/core/src/documents/merge.ts packages/core/src/links/cards.ts packages/core/test/merge-history.test.ts packages/core/test/link-queries.test.ts
git commit -m "feat(core): 修订的合入来源、模块文档合入记录，节点链接卡指向模块文档

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 接口与前端数据层

**Files:**
- Create: `apps/web/src/server/routes/module-docs.ts`
- Modify: `apps/web/src/server/api.ts`、`apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`
- Test: `apps/web/test/api/module-docs.test.ts`

**Interfaces:**
- Consumes: Task 3 `createModuleDocument`、`listModuleDocuments`；Task 5 `listAffectedNodes`、`addAffectedNode`、`updateAffectedNode`、`removeAffectedNode`；Task 6 `createNodeForDocument`；Task 7 `getMergePlan`、`applyMerge`、`skipMerge`、`reopenMerge`；Task 8 `listMergeRecords`
- Produces（接口，全部在 `/api/v1` 下）:
  - `GET /orgs/:org/products/:id/module-documents` → `{ tree: ModuleDocumentTree }`
  - `POST /orgs/:org/nodes/:id/module-document` → `{ document: DocumentDetail }`（200，重复调用返回同一份）
  - `GET /orgs/:org/documents/:id/affected-nodes` → `{ affected: AffectedNodes }`
  - `POST /orgs/:org/documents/:id/affected-nodes`（`{ nodeId, changeType, sourceSections? }`）→ 201 `{ affected }`
  - `PATCH /orgs/:org/documents/:id/affected-nodes/:nodeId`（`{ changeType?, sourceSections? }`）→ `{ affected }`
  - `DELETE /orgs/:org/documents/:id/affected-nodes/:nodeId` → `{ affected }`
  - `POST /orgs/:org/documents/:id/affected-nodes/new-node`（`{ parentId, name }`）→ 201 `{ node: StructureNodeView }`
  - `GET /orgs/:org/documents/:id/merge` → `{ plan: MergePlan }`
  - `POST /orgs/:org/documents/:id/merge/:nodeId/apply`（`{ baseVersion: number | null, body }`）、`…/skip`、`…/reopen` → `{ result: MergeResult }`
  - `GET /orgs/:org/documents/:id/merge-records` → `{ records: MergeRecord[] }`
  - web 类型：`ModuleDocumentTree`、`AffectedNodes`、`AffectedNode`、`AffectedChangeType`、`MergeStatus`、`MergePlan`、`MergeItem`、`MergeResult`、`MergeRecord`
  - web 查询：`qk.moduleDocuments(o, productId)`、`qk.affectedNodes(o, id)`、`qk.mergePlan(o, id)`、`qk.mergeRecords(o, id)`（都在 `['org', o, 'documents', …]` 之下，`documentKeys(org)` 一并失效）；`useModuleDocuments(o, productId | undefined)`、`useAffectedNodes(o, id)`、`useMergePlan(o, id | undefined)`、`useMergeRecords(o, id)`

- [ ] **Step 1: 写失败的测试**

新建 `apps/web/test/api/module-docs.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let productId: string;
let readToken: string;

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
});
afterAll(() => cleanup());

const node = async (parentId: string | null, name: string): Promise<string> =>
  (await call(app, 'POST', `/orgs/acme/products/${productId}/nodes`, { session, body: { parentId, name } })).body.node.id;

describe('模块文档、影响声明与合入接口', () => {
  it('模块文档：新建（重复调用返回同一份）与列表；只读 Token 能看不能建', async () => {
    const storage = await node(null, '存储');
    const upload = await node(storage, '上传');
    const created = await call(app, 'POST', `/orgs/acme/nodes/${upload}/module-document`, { session });
    expect(created.status).toBe(200);
    expect(created.body.document).toMatchObject({ kind: 'module', title: '上传', status: 'active', node: { id: upload } });
    expect((await call(app, 'POST', `/orgs/acme/nodes/${upload}/module-document`, { session })).body.document.id).toBe(created.body.document.id);
    const tree = await call(app, 'GET', `/orgs/acme/products/${productId}/module-documents`, { token: readToken });
    expect(tree.status).toBe(200);
    expect(tree.body.tree).toMatchObject({ productKey: 'PAN', groups: [{ domain: { name: '存储' }, modules: [{ node: { name: '上传' }, document: { displayKey: created.body.document.displayKey } }] }] });
    expect((await call(app, 'POST', `/orgs/acme/nodes/${storage}/module-document`, { token: readToken })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/nodes/${storage}/module-document`, { session })).status).toBe(400);
  });

  it('影响声明、当场新建节点、合入、修订来源与合入记录', async () => {
    const area = await node(null, '下载域');
    const prd = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '下载 PRD' } })).body.document;
    await call(app, 'PUT', `/orgs/acme/documents/${prd.id}/content`, { session, body: { baseVersion: prd.version, markdown: '## 需求说明\n\n支持离线下载' } });
    const mod = await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes/new-node`, { session, body: { parentId: area, name: '离线' } });
    expect(mod.status).toBe(201);
    expect(mod.body.node).toMatchObject({ depth: 2, name: '离线' });
    const feature = (await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes/new-node`, { session, body: { parentId: mod.body.node.id, name: '离线下载' } })).body.node;

    const added = await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes`, { session, body: { nodeId: feature.id, changeType: 'added', sourceSections: ['需求说明'] } });
    expect(added.status).toBe(201);
    expect(added.body.affected.items).toMatchObject([{ path: '下载域/离线/离线下载', changeType: 'added', sourceSections: [{ key: '需求说明', stale: false }] }]);
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes`, { session, body: { nodeId: feature.id, changeType: 'bogus' } })).status).toBe(400);
    const patched = await call(app, 'PATCH', `/orgs/acme/documents/${prd.id}/affected-nodes/${feature.id}`, { session, body: { changeType: 'modified' } });
    expect(patched.body.affected.items[0].changeType).toBe('modified');
    expect((await call(app, 'GET', `/orgs/acme/documents/${prd.id}/affected-nodes`, { token: readToken })).body.affected).toMatchObject({ editable: false, sections: ['需求说明'] });
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/affected-nodes`, { token: readToken, body: { nodeId: feature.id, changeType: 'added' } })).status).toBe(403);

    for (const to of ['review', 'approved', 'launched']) await call(app, 'POST', `/orgs/acme/documents/${prd.id}/transitions`, { session, body: { to } });
    const plan = await call(app, 'GET', `/orgs/acme/documents/${prd.id}/merge`, { token: readToken });
    expect(plan.body.plan).toMatchObject({
      canMerge: false,
      total: 1,
      done: 0,
      groups: [{ module: { name: '离线', path: '下载域/离线' }, document: null, items: [{ name: '离线下载', current: null, prefill: '支持离线下载' }] }],
    });
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/apply`, { token: readToken, body: { baseVersion: null, body: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/apply`, { session, body: { baseVersion: 'x', body: 'x' } })).status).toBe(400);
    const applied = await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/apply`, { session, body: { baseVersion: null, body: '支持离线下载' } });
    expect(applied.body.result).toMatchObject({ status: 'merged', done: 1, total: 1, moduleDocument: { version: 2 } });
    const moduleId = applied.body.result.moduleDocument.id;
    expect((await call(app, 'GET', `/orgs/acme/documents/${moduleId}/revisions`, { session })).body.revisions[0].mergedFrom).toMatchObject({ id: prd.id, displayKey: prd.displayKey });
    expect((await call(app, 'GET', `/orgs/acme/documents/${moduleId}/merge-records`, { token: readToken })).body.records).toMatchObject([
      { changeType: 'modified', feature: { name: '离线下载' }, changeDocument: { displayKey: prd.displayKey } },
    ]);
    expect((await call(app, 'DELETE', `/orgs/acme/documents/${prd.id}/affected-nodes/${feature.id}`, { session })).status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/skip`, { session })).status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/documents/${prd.id}/merge/${feature.id}/reopen`, { session })).status).toBe(400);
  });

  it('畸形 id 返回 400，不是 500', async () => {
    expect((await call(app, 'GET', '/orgs/acme/documents/not-a-uuid/merge', { session })).status).toBe(400);
    expect((await call(app, 'POST', '/orgs/acme/nodes/not-a-uuid/module-document', { session })).status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run test/api/module-docs.test.ts`
Expected: FAIL（接口返回 404「接口不存在」）。

- [ ] **Step 3: 接口**

新建 `apps/web/src/server/routes/module-docs.ts`：

```ts
import {
  addAffectedNode,
  AFFECTED_CHANGE_TYPES,
  applyMerge,
  createModuleDocument,
  createNodeForDocument,
  getMergePlan,
  listAffectedNodes,
  listMergeRecords,
  listModuleDocuments,
  removeAffectedNode,
  reopenMerge,
  skipMerge,
  updateAffectedNode,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const sourceSections = z.array(z.string().max(500)).max(20);

export function registerModuleDocRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/module-documents', async (c) => c.json({ tree: await listModuleDocuments(deps.db, c.get('actor'), c.req.param('id')) }));

  app.post('/orgs/:org/nodes/:id/module-document', async (c) => c.json({ document: await createModuleDocument(deps.db, c.get('actor'), c.req.param('id')) }));

  app.get('/orgs/:org/documents/:id/affected-nodes', async (c) => c.json({ affected: await listAffectedNodes(deps.db, c.get('actor'), c.req.param('id')) }));

  app.post('/orgs/:org/documents/:id/affected-nodes', async (c) => {
    const body = await readJson(c, z.object({ nodeId: z.string(), changeType: z.enum(AFFECTED_CHANGE_TYPES), sourceSections: sourceSections.optional() }));
    return c.json({ affected: await addAffectedNode(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.post('/orgs/:org/documents/:id/affected-nodes/new-node', async (c) => {
    const body = await readJson(c, z.object({ parentId: z.string(), name: z.string() }));
    return c.json({ node: await createNodeForDocument(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.patch('/orgs/:org/documents/:id/affected-nodes/:nodeId', async (c) => {
    const body = await readJson(c, z.object({ changeType: z.enum(AFFECTED_CHANGE_TYPES).optional(), sourceSections: sourceSections.optional() }));
    return c.json({ affected: await updateAffectedNode(deps.db, c.get('actor'), c.req.param('id'), c.req.param('nodeId'), body) });
  });

  app.delete('/orgs/:org/documents/:id/affected-nodes/:nodeId', async (c) =>
    c.json({ affected: await removeAffectedNode(deps.db, c.get('actor'), c.req.param('id'), c.req.param('nodeId')) }),
  );

  app.get('/orgs/:org/documents/:id/merge', async (c) => c.json({ plan: await getMergePlan(deps.db, c.get('actor'), c.req.param('id')) }));

  app.post('/orgs/:org/documents/:id/merge/:nodeId/apply', async (c) => {
    const body = await readJson(c, z.object({ baseVersion: z.number().int().nullable(), body: z.string().max(300_000) }));
    return c.json({ result: await applyMerge(deps.db, c.get('actor'), c.req.param('id'), c.req.param('nodeId'), body) });
  });

  app.post('/orgs/:org/documents/:id/merge/:nodeId/skip', async (c) => c.json({ result: await skipMerge(deps.db, c.get('actor'), c.req.param('id'), c.req.param('nodeId')) }));

  app.post('/orgs/:org/documents/:id/merge/:nodeId/reopen', async (c) => c.json({ result: await reopenMerge(deps.db, c.get('actor'), c.req.param('id'), c.req.param('nodeId')) }));

  app.get('/orgs/:org/documents/:id/merge-records', async (c) => c.json({ records: await listMergeRecords(deps.db, c.get('actor'), c.req.param('id')) }));
}
```

`apps/web/src/server/api.ts`：import 区在 `import { registerLinkRoutes } from './routes/links';` 之后加 `import { registerModuleDocRoutes } from './routes/module-docs';`；`createApi` 里 `registerLinkRoutes(app, deps);` 之后加 `registerModuleDocRoutes(app, deps);`。

- [ ] **Step 4: 前端类型与查询**

`apps/web/src/lib/types.ts`：

1. 顶部 `from '@flower/core'` 的 type import 列表按字母序加入：

```ts
  AffectedChangeType as CoreAffectedChangeType,
  AffectedNodes as CoreAffectedNodes,
  MergePlan as CoreMergePlan,
  MergeRecord as CoreMergeRecord,
  MergeResult as CoreMergeResult,
  MergeStatus as CoreMergeStatus,
  ModuleDocumentTree as CoreModuleDocumentTree,
```

2. `export type TaskDetail = Jsonify<CoreTaskDetail>;` 之后加：

```ts
export type ModuleDocumentTree = Jsonify<CoreModuleDocumentTree>;
export type AffectedChangeType = CoreAffectedChangeType;
export type MergeStatus = CoreMergeStatus;
export type AffectedNodes = Jsonify<CoreAffectedNodes>;
export type AffectedNode = AffectedNodes['items'][number];
export type MergePlan = Jsonify<CoreMergePlan>;
export type MergeItem = MergePlan['groups'][number]['items'][number];
export type MergeResult = Jsonify<CoreMergeResult>;
export type MergeRecord = Jsonify<CoreMergeRecord>;
```

`apps/web/src/lib/queries.ts`：

1. `from './types'` 的 import 列表按字母序加入 `AffectedNodes`、`MergePlan`、`MergeRecord`、`ModuleDocumentTree`。
2. `qk` 里 `documentReviews: …,` 之后加：

```ts
  moduleDocuments: (o: string, productId: string) => ['org', o, 'documents', 'modules', productId] as const,
  affectedNodes: (o: string, id: string) => ['org', o, 'documents', 'affected', id] as const,
  mergePlan: (o: string, id: string) => ['org', o, 'documents', 'merge', id] as const,
  mergeRecords: (o: string, id: string) => ['org', o, 'documents', 'merge-records', id] as const,
```

3. `useTemplates` 定义之前加：

```ts
export const useModuleDocuments = (o: string, productId: string | undefined) =>
  useQuery({
    queryKey: qk.moduleDocuments(o, productId ?? ''),
    queryFn: () => api<{ tree: ModuleDocumentTree }>(`/orgs/${o}/products/${productId}/module-documents`),
    select: (d) => d.tree,
    enabled: !!productId,
  });
export const useAffectedNodes = (o: string, id: string) =>
  useQuery({ queryKey: qk.affectedNodes(o, id), queryFn: () => api<{ affected: AffectedNodes }>(`/orgs/${o}/documents/${id}/affected-nodes`), select: (d) => d.affected });
export const useMergePlan = (o: string, id: string | undefined) =>
  useQuery({
    queryKey: qk.mergePlan(o, id ?? ''),
    queryFn: () => api<{ plan: MergePlan }>(`/orgs/${o}/documents/${id}/merge`),
    select: (d) => d.plan,
    enabled: !!id,
  });
export const useMergeRecords = (o: string, id: string) =>
  useQuery({ queryKey: qk.mergeRecords(o, id), queryFn: () => api<{ records: MergeRecord[] }>(`/orgs/${o}/documents/${id}/merge-records`), select: (d) => d.records });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run test/api/module-docs.test.ts test/api/documents.test.ts test/api/links.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/server/routes/module-docs.ts apps/web/src/server/api.ts apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/test/api/module-docs.test.ts
git commit -m "feat(web): 模块文档、影响声明与合入的接口和前端数据层

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 页面：文档列表的「模块文档」页签，结构树页签的模块文档链接

**Files:**
- Create: `apps/web/src/app/(app)/[org]/documents/module-docs-tab.tsx`
- Modify: `apps/web/src/app/(app)/[org]/documents/page.tsx`、`apps/web/src/features/documents/model.ts`、`apps/web/src/app/(app)/[org]/settings/products/[productId]/structure-tab.tsx`、`apps/web/e2e/helpers.ts`
- Test: `apps/web/src/features/documents/model.test.ts`、`apps/web/e2e/module-docs.spec.ts`

**Interfaces:**
- Consumes: Task 9 `useModuleDocuments`、`POST /orgs/:org/nodes/:id/module-document`、`ModuleDocumentTree`
- Produces:
  - `type DocumentView = 'change' | 'modules'`；`documentView(sp: URLSearchParams): DocumentView`；`moduleDocsHref(org: string, productKey: string, nodeId?: string | null): string`（`/{org}/documents?product=KEY&view=modules[&node=id]`）
  - `<ModuleDocsTab org product focusNodeId />`
  - e2e helper `createNode(request, productId, parentId: string | null, name): Promise<string>`

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/documents/model.test.ts`：import 列表按字母序加入 `documentView`、`moduleDocsHref`；文件末尾加：

```ts
describe('模块文档页签', () => {
  it('页签只由地址栏的 view 决定；模块文档页签的地址带产品与要定位的模块', () => {
    expect(documentView(new URLSearchParams('product=PAN&view=modules'))).toBe('modules');
    expect(documentView(new URLSearchParams('product=PAN'))).toBe('change');
    expect(documentView(new URLSearchParams('view=bogus'))).toBe('change');
    expect(moduleDocsHref('acme', 'PAN')).toBe('/acme/documents?product=PAN&view=modules');
    expect(moduleDocsHref('acme', 'PAN', 'n1')).toBe('/acme/documents?product=PAN&view=modules&node=n1');
  });
});
```

`apps/web/e2e/helpers.ts` 末尾加：

```ts
/** 新建结构树节点（以所有者身份，产品管理员权限），返回节点 id。 */
export async function createNode(request: APIRequestContext, productId: string, parentId: string | null, name: string): Promise<string> {
  return (await json<{ node: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/nodes`, { data: { parentId, name } }))).node.id;
}
```

新建 `apps/web/e2e/module-docs.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createNode, createProduct, expectNoPageOverflow, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('模块文档页签：按业务域列出模块；点击没有文档的模块即新建并打开；结构树页签显示模块文档链接并能定位', async ({ page, request }) => {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  const upload = await createNode(request, productId, storage, '上传');
  const download = await createNode(request, productId, storage, '下载');
  await createNode(request, productId, upload, '分片上传');
  await createNode(request, productId, null, '会员');
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/documents');
  await page.getByRole('tab', { name: '模块文档' }).click();
  await expect(page).toHaveURL(/view=modules/);
  const table = page.getByRole('table');
  await expect(table.getByRole('row', { name: '存储' })).toBeVisible();
  await expect(table.getByRole('row', { name: '会员' })).toBeVisible();
  await expect(table).toContainText('还没有模块');
  const row = table.getByRole('row', { name: /^上传/ });
  await expect(row).toContainText('未建');
  await expect(row).toContainText('1');
  await row.getByRole('button', { name: '上传' }).click();
  await expect(page).toHaveURL(/\/acme\/documents\/PAN-PRD-1$/);
  await expect(page.getByRole('region', { name: '正文' }).getByRole('status')).toHaveText('已保存');

  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '结构树' }).click();
  const tree = page.getByRole('region', { name: '结构树' });
  await expect(tree.getByRole('link', { name: '上传 的模块文档' })).toHaveText('PAN-PRD-1');
  await tree.getByRole('link', { name: '下载 的模块文档' }).click();
  await expect(page).toHaveURL(new RegExp(`view=modules&node=${download}`));
  await expect(page.getByRole('row', { name: /^下载/ })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('tab', { name: '变更 PRD' }).click();
  await expect(page.getByRole('button', { name: '新建 PRD' })).toBeVisible();
});

test('只读成员看得到模块文档页签，但不能新建；两种宽度下不横向滚动', async ({ browser, request }) => {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  await createNode(request, productId, storage, '上传');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/documents?product=PAN&view=modules');
    const row = page.getByRole('row', { name: /^上传/ });
    await expect(row).toContainText('未建');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expectNoPageOverflow(page);
  }
  await ctx.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: FAIL（`documentView` 不存在）。

Run: `pnpm --filter @flower/web e2e module-docs.spec.ts`
Expected: FAIL（找不到「模块文档」页签）。

- [ ] **Step 3: 纯函数**

`apps/web/src/features/documents/model.ts`：在 `documentHref` 之后加：

```ts
export type DocumentView = 'change' | 'modules';

/** 文档页的页签只由地址栏决定：?view=modules 为「模块文档」，否则为「变更 PRD」。 */
export const documentView = (sp: URLSearchParams): DocumentView => (sp.get('view') === 'modules' ? 'modules' : 'change');

/** 「模块文档」页签的地址；带 nodeId 时定位到这个模块。 */
export function moduleDocsHref(org: string, productKey: string, nodeId?: string | null): string {
  const p = new URLSearchParams({ product: productKey, view: 'modules' });
  if (nodeId) p.set('node', nodeId);
  return `/${org}/documents?${p.toString()}`;
}
```

- [ ] **Step 4: 「模块文档」页签**

新建 `apps/web/src/app/(app)/[org]/documents/module-docs-tab.tsx`：

```tsx
'use client';

import { FolderTree } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { EmptyState } from '@/components/empty-state';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { documentHref } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { levelLabel } from '@/features/structure/model';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation, useLevelNames, useModuleDocuments } from '@/lib/queries';
import type { DocumentDetail, Product } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 「模块文档」页签：按业务域 → 模块列出，是否已有文档、功能点数、最近合入时间。点击没有文档的模块即新建（产品编辑及以上）。 */
export function ModuleDocsTab({ org, product, focusNodeId }: { org: string; product: Product; focusNodeId: string | null }) {
  const router = useRouter();
  const tree = useModuleDocuments(org, product.id);
  const levels = useLevelNames(org, product.id);
  const names = levels.data?.names ?? [];
  const canCreate = product.myRole !== 'viewer';
  const create = useApiMutation((nodeId: string) => api<{ document: DocumentDetail }>(`/orgs/${org}/nodes/${nodeId}/module-document`, { method: 'POST' }), {
    silentError: true,
    invalidate: [documentKeys(org)],
    onSuccess: (r) => router.push(documentHref(org, r.document.displayKey)),
  });
  // 链接卡、面包屑或结构树带着 ?node= 跳过来：列表渲染后滚动到这个模块
  useEffect(() => {
    if (!focusNodeId || !tree.data) return;
    document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(focusNodeId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focusNodeId, tree.data]);

  if (tree.isError) return <QueryError error={tree.error} noAccessMessage="你没有查看这个产品的权限。" retryMessage="加载模块文档失败，请重试。" onRetry={() => tree.refetch()} />;
  if (!tree.data) return <Skeleton className="h-48" />;
  const domainLabel = levelLabel(names, 1);
  const moduleLabel = levelLabel(names, 2);
  if (tree.data.groups.length === 0) {
    return (
      <EmptyState
        icon={FolderTree}
        title={`结构树还没有${domainLabel}`}
        description={`模块文档按${moduleLabel}建立。产品管理员可以在产品设置的结构树页签中添加${domainLabel}；${moduleLabel}也可以在变更 PRD 声明影响时当场新建。`}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <FormError error={create.error} />
      <div className="overflow-x-auto rounded-md border bg-card">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[36%]">{moduleLabel}</TableHead>
              <TableHead className="w-32">模块文档</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-20">{levelLabel(names, 3)}</TableHead>
              <TableHead className="w-36">最近合入</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tree.data.groups.map((g) => (
              <Fragment key={g.domain.id}>
                <TableRow className="h-10 bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={5} className="truncate text-[13px] font-medium">
                    {g.domain.name}
                    {g.domain.status === 'deprecated' && '（已停用）'}
                  </TableCell>
                </TableRow>
                {g.modules.length === 0 && (
                  <TableRow className="h-10">
                    <TableCell colSpan={5} className="pl-8 text-[13px] text-muted-foreground">
                      还没有{moduleLabel}
                    </TableCell>
                  </TableRow>
                )}
                {g.modules.map((m) => {
                  const focused = m.node.id === focusNodeId;
                  return (
                    <TableRow key={m.node.id} data-node-id={m.node.id} aria-current={focused ? 'true' : undefined} className={cn('h-10 even:bg-zebra', focused && 'bg-primary/5 even:bg-primary/5')}>
                      <TableCell className="truncate pl-8">
                        {m.document ? (
                          <Link href={documentHref(org, m.document.displayKey)} className="hover:underline">
                            {m.node.name}
                          </Link>
                        ) : canCreate ? (
                          <button type="button" className="hover:underline disabled:opacity-50" disabled={create.isPending} onClick={() => create.mutate(m.node.id)}>
                            {m.node.name}
                          </button>
                        ) : (
                          m.node.name
                        )}
                        {m.node.status === 'deprecated' && <span className="text-muted-foreground">（已停用）</span>}
                      </TableCell>
                      <TableCell className="font-mono text-[13px]">
                        {m.document ? (
                          <Link href={documentHref(org, m.document.displayKey)} className="hover:underline">
                            {m.document.displayKey}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">未建</span>
                        )}
                      </TableCell>
                      <TableCell>{m.document && <DocumentStatusBadge status={m.document.status} />}</TableCell>
                      <TableCell className="font-mono text-[13px]">{m.featureCount}</TableCell>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{m.lastMergedAt ? formatDateTime(m.lastMergedAt) : '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 文档页加页签**

`apps/web/src/app/(app)/[org]/documents/page.tsx`：

1. import 区：`@/components/ui/table` 之后加 `import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';`；`@/features/documents/model` 的 import 列表按字母序加入 `documentView`、`moduleDocsHref`；`import { CreateDocumentDialog } from './create-dialog';` 之后加 `import { ModuleDocsTab } from './module-docs-tab';`。

2. `const filter = useMemo(…);` 之后加：

```tsx
  const view = documentView(new URLSearchParams(searchParams.toString()));
```

`const list = useDocuments(org, product?.id, documentFilterToApiQuery(filter));` 改为（模块文档页签不取 PRD 列表）：

```tsx
  const list = useDocuments(org, view === 'change' ? product?.id : undefined, documentFilterToApiQuery(filter));
```

3. 把 `return (` 之后从 `<PageHeader` 到 `<div className="flex flex-wrap items-center gap-2">` 之前的 `PageHeader` 整段替换为：

```tsx
      <PageHeader
        title="文档"
        description={`${product.name} · ${view === 'modules' ? '模块文档' : '变更 PRD'}`}
        actions={
          <>
            {products.data.length > 1 && (
              <Select
                value={product.key}
                onValueChange={(key) => router.replace(view === 'modules' ? moduleDocsHref(org, key) : `?${documentFilterToSearch({ ...filter, product: key })}`)}
              >
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
          </>
        }
      />
      <Tabs value={view} onValueChange={(v) => router.replace(v === 'modules' ? moduleDocsHref(org, product.key) : `/${org}/documents?product=${product.key}`)}>
        <TabsList>
          <TabsTrigger value="change">变更 PRD</TabsTrigger>
          <TabsTrigger value="modules">模块文档</TabsTrigger>
        </TabsList>
      </Tabs>
      {view === 'modules' ? (
        <ModuleDocsTab org={org} product={product} focusNodeId={searchParams.get('node')} />
      ) : (
        <>
```

4. 在原来的列表区块（`{list.isError ? ( … ) : ( <div className="overflow-x-auto rounded-md border bg-card"> … </div> )}`）结束之后、`<CreateDocumentDialog …/>` 之前，闭合上一步打开的片段：

```tsx
        </>
      )}
```

（筛选条、空状态与表格原样保留在「变更 PRD」分支里。）

- [ ] **Step 6: 结构树页签的模块文档链接**

`apps/web/src/app/(app)/[org]/settings/products/[productId]/structure-tab.tsx`：

1. import 区加：

```tsx
import Link from 'next/link';
import { documentHref, moduleDocsHref } from '@/features/documents/model';
```

`@/lib/queries` 的 import 改为：

```tsx
import { documentKeys, qk, requirementKeys, useApiMutation, useLevelNames, useModuleDocuments, useNodes } from '@/lib/queries';
```

2. `const levels = useLevelNames(org, productId);` 之后加：

```tsx
  const moduleDocs = useModuleDocuments(org, productId);
  const docKeyOf = new Map(moduleDocs.data?.groups.flatMap((g) => g.modules.map((m) => [m.node.id, m.document?.displayKey ?? null] as const)) ?? []);
```

`const invalidate = [qk.nodes(org, productId), requirementKeys(org)];` 改为：

```tsx
  const invalidate = [qk.nodes(org, productId), requirementKeys(org), documentKeys(org)];
```

3. 节点行里 `<span className={cn('min-w-0 flex-1 truncate', deprecated && 'line-through')}> … </span>` 之后、「上移」按钮之前加：

```tsx
                    {n.depth === 2 && moduleDocs.data && (
                      <Link
                        href={docKeyOf.get(n.id) ? documentHref(org, docKeyOf.get(n.id)!) : moduleDocsHref(org, moduleDocs.data.productKey, n.id)}
                        aria-label={`${n.name} 的模块文档`}
                        className="shrink-0 font-mono text-[13px] text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {docKeyOf.get(n.id) ?? '模块文档'}
                      </Link>
                    )}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e module-docs.spec.ts documents.spec.ts structure.spec.ts layout.spec.ts`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/documents/module-docs-tab.tsx" "apps/web/src/app/(app)/[org]/documents/page.tsx" apps/web/src/features/documents/model.ts apps/web/src/features/documents/model.test.ts "apps/web/src/app/(app)/[org]/settings/products/[productId]/structure-tab.tsx" apps/web/e2e/helpers.ts apps/web/e2e/module-docs.spec.ts
git commit -m "feat(web): 文档页「模块文档」页签，结构树页签显示模块文档链接

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 页面：模块文档详情（侧栏、合入记录、修订来源、归档只读）

**Files:**
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/status-card.tsx`、`module-side-panel.tsx`、`merge-records.tsx`
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`、`side-panel.tsx`、`revisions.tsx`、`editor-pane.tsx`、`apps/web/src/features/documents/model.ts`
- Test: `apps/web/src/features/documents/model.test.ts`、`apps/web/e2e/module-docs.spec.ts`

**Interfaces:**
- Consumes: Task 3 `DocumentDetail.kind / node`、状态流转；Task 8 `RevisionListItem.mergedFrom`、`MergeRecord`；Task 9 `useMergeRecords`、`useLevelNames`；Task 10 `moduleDocsHref`
- Produces:
  - `<StatusCard org doc saveEditor />`（两种侧栏共用，区块名称「状态」）
  - `<ModuleSidePanel org doc onReload saveEditor />`（状态、所属、修订记录）
  - `<MergeRecords org doc />`（区块名称「合入记录」）
  - `CHANGE_TYPE_LABEL: Record<AffectedChangeType, string>`、`MERGE_STATUS_LABEL: Record<MergeStatus, string>`（`features/documents/model.ts`）

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/documents/model.test.ts`：import 列表按字母序加入 `CHANGE_TYPE_LABEL`、`MERGE_STATUS_LABEL`；「模块文档页签」describe 里加：

```ts
  it('变更类型与合入状态的文字', () => {
    expect(CHANGE_TYPE_LABEL).toEqual({ added: '新增', modified: '修改', removed: '删除' });
    expect(MERGE_STATUS_LABEL).toEqual({ pending: '待合入', applied: '已应用', skipped: '已跳过' });
  });
```

`apps/web/e2e/module-docs.spec.ts`：import 里加入 `json`；文件末尾加：

```ts
test('模块文档详情：所属与合入记录；编辑自动保存；归档后只读、隐藏恢复，恢复为使用中后可编辑；面包屑回到模块文档页签并定位', async ({ page, request }) => {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  const upload = await createNode(request, productId, storage, '上传');
  const mod = (await json<{ document: { id: string; displayKey: string; version: number } }>(request.post(`/api/v1/orgs/acme/nodes/${upload}/module-document`))).document;
  await ok(request.put(`/api/v1/orgs/acme/documents/${mod.id}/content`, { data: { baseVersion: mod.version, markdown: '上传总述\n\n## 分片上传\n\n说明' } }));
  // 同一作者 5 分钟内的保存并入第 1 版；恢复一次得到第 2 版，页面上才有「恢复第 1 版」按钮可检查
  await ok(request.post(`/api/v1/orgs/acme/documents/${mod.id}/restore`, { data: { number: 1, baseVersion: mod.version + 1 } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${mod.displayKey}`);
  const side = page.getByRole('complementary');
  await expect(side.getByRole('region', { name: '所属' })).toContainText('存储');
  await expect(side.getByRole('region', { name: '所属' })).toContainText('上传');
  await expect(side.getByRole('region', { name: '状态' })).toContainText('使用中');
  await expect(side.getByRole('region', { name: '修订记录' })).toContainText('第 2 版');
  await expect(side.getByRole('button', { name: '恢复第 1 版' })).toBeVisible();
  await expect(side.getByRole('region', { name: '覆盖的需求' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '合入记录' })).toContainText('还没有合入记录');
  await expect(page.getByRole('region', { name: '被引用' })).toBeVisible();

  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('分片上传');
  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('，支持断点续传');
  await expect(body.getByRole('status')).toHaveText('已保存');

  await side.getByRole('button', { name: '改为已归档' }).click();
  await expect(side.getByRole('region', { name: '状态' })).toContainText('已归档');
  await expect(body.getByRole('status')).toHaveText('只读');
  await expect(side.getByRole('region', { name: '修订记录' })).toContainText('第 1 版');
  await expect(side.getByRole('button', { name: /^恢复第/ })).toHaveCount(0);
  await side.getByRole('button', { name: '改为使用中' }).click();
  await expect(body.getByRole('status')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('支持断点续传');

  await page.getByRole('navigation', { name: '面包屑' }).getByRole('link', { name: '文档' }).click();
  await expect(page).toHaveURL(new RegExp(`view=modules&node=${upload}`));
  await expect(page.getByRole('row', { name: /^上传/ })).toHaveAttribute('aria-current', 'true');

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/documents/${mod.displayKey}`);
    await expect(page.getByRole('region', { name: '合入记录' })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: FAIL（`CHANGE_TYPE_LABEL` 不存在）。

Run: `pnpm --filter @flower/web e2e module-docs.spec.ts`
Expected: 新用例 FAIL（找不到「所属」区块）。

- [ ] **Step 3: 文字常量**

`apps/web/src/features/documents/model.ts`：

1. 文件开头加：

```ts
import type { AffectedChangeType, MergeStatus } from '@/lib/types';
```

（与已有的 `import type { DocumentComment } from '@/lib/types';` 合并为一行：`import type { AffectedChangeType, DocumentComment, MergeStatus } from '@/lib/types';`）

2. `SECTION_CHANGE_LABEL` 之后加：

```ts
export const CHANGE_TYPE_LABEL: Record<AffectedChangeType, string> = { added: '新增', modified: '修改', removed: '删除' };
export const MERGE_STATUS_LABEL: Record<MergeStatus, string> = { pending: '待合入', applied: '已应用', skipped: '已跳过' };
```

- [ ] **Step 4: 状态卡片抽出，两种侧栏共用**

新建 `apps/web/src/app/(app)/[org]/documents/[key]/status-card.tsx`：

```tsx
'use client';

import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { DocumentStatusBadge } from '@/components/document-status';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { DocumentDetail, DocumentStatus } from '@/lib/types';

/** 状态卡片：当前状态与可流转的目标。改状态之前先保存编辑器里没到时间的修改（必填小节按服务端正文校验）。 */
export function StatusCard({ org, doc, saveEditor }: { org: string; doc: DocumentDetail; saveEditor: () => Promise<number | null> }) {
  const move = useApiMutation(
    async (to: DocumentStatus) => {
      await saveEditor();
      return api(`/orgs/${org}/documents/${doc.id}/transitions`, { method: 'POST', body: { to } });
    },
    { silentError: true, invalidate: [documentKeys(org), requirementKeys(org), qk.workbench], success: '已更新状态' },
  );
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-status-title">
      <h2 id="doc-status-title" className="mb-2 text-sm font-semibold">
        状态
      </h2>
      <DocumentStatusBadge status={doc.status} />
      {doc.transitions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {doc.transitions.map((to) => (
            <Button key={to} size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate(to)}>
              改为{DOCUMENT_STATUS_LABELS[to]}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-2">
        <FormError error={move.error} />
      </div>
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/documents/[key]/side-panel.tsx`：

1. 删除 `import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';` 与 `import { DocumentStatusBadge } from '@/components/document-status';`；`import type { DocumentDetail, DocumentStatus } from '@/lib/types';` 改为 `import type { DocumentDetail } from '@/lib/types';`；`import { Revisions } from './revisions';` 之前加 `import { StatusCard } from './status-card';`。
2. 删除整个 `const move = useApiMutation( … );`。
3. 把整个 `<section className={CARD} aria-labelledby="doc-status-title"> … </section>` 替换为：

```tsx
      <StatusCard org={org} doc={doc} saveEditor={saveEditor} />
```

（`invalidate` 仍被关联需求、移出需求与检查项使用，保留。）

- [ ] **Step 5: 模块文档的侧栏与合入记录**

新建 `apps/web/src/app/(app)/[org]/documents/[key]/module-side-panel.tsx`：

```tsx
'use client';

import { levelLabel } from '@/features/structure/model';
import { useLevelNames } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';
import { Revisions } from './revisions';
import { StatusCard } from './status-card';

/** 模块文档的右侧栏：状态（使用中 / 已归档）、所属的业务域与模块、修订记录。模块文档没有负责人、覆盖需求与检查项。 */
export function ModuleSidePanel({ org, doc, onReload, saveEditor }: { org: string; doc: DocumentDetail; onReload: () => void; saveEditor: () => Promise<number | null> }) {
  const levels = useLevelNames(org, doc.productId);
  const names = levels.data?.names ?? [];
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <StatusCard org={org} doc={doc} saveEditor={saveEditor} />
      <section className="rounded-md border bg-card p-4" aria-labelledby="doc-node-title">
        <h2 id="doc-node-title" className="mb-2 text-sm font-semibold">
          所属
        </h2>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">{levelLabel(names, 1)}</dt>
          <dd className="truncate">{doc.node?.domain?.name ?? '—'}</dd>
          <dt className="text-muted-foreground">{levelLabel(names, 2)}</dt>
          <dd className="truncate">
            {doc.node?.name ?? '—'}
            {doc.node?.status === 'deprecated' && '（已停用）'}
          </dd>
        </dl>
      </section>
      <Revisions org={org} doc={doc} onRestored={onReload} saveEditor={saveEditor} />
    </aside>
  );
}
```

新建 `apps/web/src/app/(app)/[org]/documents/[key]/merge-records.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { QueryError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { CHANGE_TYPE_LABEL, documentHref } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { useMergeRecords } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

/** 模块文档的合入记录：按版本倒序列出来自哪些变更 PRD、哪些功能点。功能点的历史即其中对应它的部分。 */
export function MergeRecords({ org, doc }: { org: string; doc: DocumentDetail }) {
  const q = useMergeRecords(org, doc.id);
  return (
    <section className="min-w-0 rounded-md border bg-card p-4" aria-labelledby="doc-merges-title">
      <h2 id="doc-merges-title" className="mb-2 text-sm font-semibold">
        合入记录
      </h2>
      {q.isError ? (
        <QueryError error={q.error} noAccessMessage="没有查看合入记录的权限。" retryMessage="加载合入记录失败，请重试。" onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-12" />
      ) : q.data.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有合入记录</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {q.data.map((r) => (
            <li key={r.revisionNumber} className="flex min-w-0 flex-col gap-0.5 py-2 text-[13px]">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{r.feature.name}</span>
                <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs">{CHANGE_TYPE_LABEL[r.changeType]}</span>
              </div>
              <Link href={documentHref(org, r.changeDocument.displayKey)} className="flex min-w-0 gap-2 text-muted-foreground hover:underline">
                <span className="shrink-0 font-mono">{r.changeDocument.displayKey}</span>
                <span className="truncate">{r.changeDocument.title}</span>
              </Link>
              <span className="text-xs text-muted-foreground">
                第 {r.revisionNumber} 版 · {r.by?.displayName ?? '—'} · <span className="font-mono">{formatDateTime(r.mergedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 6: 修订来源、只读与详情页切换**

`apps/web/src/app/(app)/[org]/documents/[key]/revisions.tsx`：

1. import 区加 `import Link from 'next/link';`，`@/features/documents/model` 的 import 改为 `import { documentHref, SECTION_CHANGE_LABEL } from '@/features/documents/model';`。
2. `Revisions` 里 `const canEdit = doc.myRole !== 'viewer';` 改为：

```tsx
  // 已归档的模块文档只读，不能恢复版本
  const canEdit = doc.myRole !== 'viewer' && doc.status !== 'archived';
```

3. `{r.summary && <p className="text-xs text-muted-foreground">{r.summary}</p>}` 之后加：

```tsx
              {r.mergedFrom && (
                <Link href={documentHref(org, r.mergedFrom.displayKey)} className="text-xs text-muted-foreground hover:underline" aria-label={`来源 ${r.mergedFrom.displayKey} ${r.mergedFrom.title}`}>
                  来源 <span className="font-mono">{r.mergedFrom.displayKey}</span>
                </Link>
              )}
```

`apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`：只改一行，

```tsx
  const editable = doc.myRole !== 'viewer';
```

改为：

```tsx
  // 已归档的模块文档只读（服务端同样拒绝保存）
  const editable = doc.myRole !== 'viewer' && doc.status !== 'archived';
```

`apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`：

1. import 区加：

```tsx
import { moduleDocsHref } from '@/features/documents/model';
import { MergeRecords } from './merge-records';
import { ModuleSidePanel } from './module-side-panel';
```

2. `crumbs={[{ label: '文档', href: `/${org}/documents?product=${d.productKey}` }, { label: d.displayKey }]}` 改为：

```tsx
        crumbs={[{ label: '文档', href: d.kind === 'module' ? moduleDocsHref(org, d.productKey, d.node?.id) : `/${org}/documents?product=${d.productKey}` }, { label: d.displayKey }]}
```

3. `<Backlinks org={org} type="document" id={d.id} />` 之后加：

```tsx
          {d.kind === 'module' && <MergeRecords org={org} doc={d} />}
```

4. `<SidePanel org={org} doc={d} onReload={() => void reload()} saveEditor={saveEditor} />` 改为：

```tsx
        {d.kind === 'module' ? (
          <ModuleSidePanel org={org} doc={d} onReload={() => void reload()} saveEditor={saveEditor} />
        ) : (
          <SidePanel org={org} doc={d} onReload={() => void reload()} saveEditor={saveEditor} />
        )}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e module-docs.spec.ts documents-editor.spec.ts documents-revisions.spec.ts documents-prd-flow.spec.ts documents-permissions.spec.ts documents-import.spec.ts documents-links.spec.ts documents-anchors.spec.ts`
Expected: PASS（P2-A/P2-B1 的编辑器用例原样通过）。

- [ ] **Step 8: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/documents/[key]" apps/web/src/features/documents/model.ts apps/web/src/features/documents/model.test.ts apps/web/e2e/module-docs.spec.ts
git commit -m "feat(web): 模块文档详情：所属、合入记录、修订来源，归档后只读

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 页面：PRD 的「影响的功能点」与声明对话框（含当场新建模块与功能点）

**Files:**
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/affected-nodes.tsx`、`affected-node-dialog.tsx`
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/side-panel.tsx`、`apps/web/src/features/documents/model.ts`、`apps/web/e2e/helpers.ts`
- Test: `apps/web/src/features/documents/model.test.ts`、`apps/web/e2e/module-affected.spec.ts`

**Interfaces:**
- Consumes: Task 9 `useAffectedNodes`、`useNodes`、`useLevelNames`、声明与新建节点接口；Task 11 `CHANGE_TYPE_LABEL`、`MERGE_STATUS_LABEL`；现有 `nodeOptions`
- Produces:
  - `type NodeOption = { id: string; path: string }`；`featureOptions(nodes: StructureNode[], q: string, exclude: Set<string>): NodeOption[]`（第三层、本身与上级都没停用、未声明，路径包含查询，按树的顺序最多 20 个）；`moduleOptions(nodes): NodeOption[]`；`domainOptions(nodes): NodeOption[]`
  - `<AffectedNodes org doc />`（区块名称「影响的功能点」，PRD 侧栏「覆盖的需求」之后）；`<AffectedNodeDialog org doc affected item onClose />`（对话框标题「声明影响」或「修改影响声明」）
  - e2e helper `launchDocument(request, documentId)`（草稿 → 评审中 → 已通过 → 已上线）

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/documents/model.test.ts`：import 列表按字母序加入 `domainOptions`、`featureOptions`、`moduleOptions`，并加 `import type { StructureNode } from '@/lib/types';`（与已有的 `import type { DocumentComment } from '@/lib/types';` 合并）；文件末尾加：

```ts
describe('声明影响的选项', () => {
  const N = (id: string, parentId: string | null, depth: number, name: string, sort: number, status: 'active' | 'deprecated' = 'active'): StructureNode => ({
    id,
    parentId,
    depth,
    name,
    description: null,
    status,
    sort,
  });
  const NODES = [
    N('d1', null, 1, '存储', 0),
    N('m1', 'd1', 2, '上传', 0),
    N('f1', 'm1', 3, '分片上传', 0),
    N('f2', 'm1', 3, '秒传', 1),
    N('m2', 'd1', 2, '旧模块', 1, 'deprecated'),
    N('f3', 'm2', 3, '旧功能', 0),
    N('d2', null, 1, '会员', 1),
  ];

  it('功能点：第三层、本身与上级都没停用、未声明，按路径搜索，按树的顺序', () => {
    expect(featureOptions(NODES, '', new Set())).toEqual([
      { id: 'f1', path: '存储/上传/分片上传' },
      { id: 'f2', path: '存储/上传/秒传' },
    ]);
    expect(featureOptions(NODES, ' 秒 ', new Set())).toEqual([{ id: 'f2', path: '存储/上传/秒传' }]);
    expect(featureOptions(NODES, '上传', new Set(['f1']))).toEqual([{ id: 'f2', path: '存储/上传/秒传' }]);
    expect(featureOptions(NODES, '旧功能', new Set())).toEqual([]);
  });

  it('模块与业务域：没停用的', () => {
    expect(moduleOptions(NODES)).toEqual([{ id: 'm1', path: '存储/上传' }]);
    expect(domainOptions(NODES)).toEqual([
      { id: 'd1', path: '存储' },
      { id: 'd2', path: '会员' },
    ]);
  });
});
```

`apps/web/e2e/helpers.ts` 末尾加：

```ts
/** 把 PRD 从草稿依次改为评审中、已通过、已上线。 */
export async function launchDocument(request: APIRequestContext, documentId: string): Promise<void> {
  for (const to of ['review', 'approved', 'launched']) await ok(request.post(`/api/v1/orgs/acme/documents/${documentId}/transitions`, { data: { to } }));
}
```

新建 `apps/web/e2e/module-affected.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createNode, createProduct, expectNoPageOverflow, launchDocument, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const PRD_BODY = '## 背景\n\n现状\n\n## 需求说明\n\n上传改为分片\n\n### 细节\n\n断点续传';

test('声明影响：当场新建模块与功能点，选变更类型与来源小节；修改、移除；只读成员只能看', async ({ page, browser, request }) => {
  const productId = await createProduct(request);
  await createNode(request, productId, null, '存储');
  const prd = await createDocument(request, productId, { title: '上传改版' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${prd.id}/content`, { data: { baseVersion: prd.version, markdown: PRD_BODY } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${prd.displayKey}`);
  const card = page.getByRole('complementary').getByRole('region', { name: '影响的功能点' });
  await expect(card).toContainText('还没有声明影响的功能点');

  await card.getByRole('button', { name: '声明影响' }).click();
  const dialog = page.getByRole('dialog', { name: '声明影响' });
  await expect(dialog).toContainText('没有可选的功能点');
  await dialog.getByRole('combobox', { name: '所属业务域' }).click();
  await page.getByRole('option', { name: '存储' }).click();
  await dialog.getByLabel('新模块名称').fill('上传');
  await dialog.getByRole('button', { name: '新建模块' }).click();
  await expect(dialog.getByRole('combobox', { name: '所属模块' })).toHaveText('存储/上传');
  await dialog.getByLabel('新功能点名称').fill('分片上传');
  await dialog.getByRole('button', { name: '新建功能点' }).click();
  await expect(dialog.getByRole('button', { name: '存储/上传/分片上传' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('combobox', { name: '变更类型' }).click();
  await page.getByRole('option', { name: '新增' }).click();
  await dialog.getByRole('checkbox', { name: '需求说明', exact: true }).check();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText('存储/上传/分片上传');
  await expect(card).toContainText('新增');
  await expect(card).toContainText('来源：需求说明');

  await card.getByRole('button', { name: '修改 存储/上传/分片上传' }).click();
  const edit = page.getByRole('dialog', { name: '修改影响声明' });
  await edit.getByRole('combobox', { name: '变更类型' }).click();
  await page.getByRole('option', { name: '修改' }).click();
  await edit.getByRole('checkbox', { name: '需求说明 / 细节' }).check();
  await edit.getByRole('button', { name: '保存' }).click();
  await expect(card).toContainText('来源：需求说明、需求说明 / 细节');

  const ctx = await browser.newContext();
  const viewerPage = await ctx.newPage();
  const viewerId = await acceptInvite(viewerPage, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  await viewerPage.goto(`/acme/documents/${prd.displayKey}`);
  const viewerCard = viewerPage.getByRole('complementary').getByRole('region', { name: '影响的功能点' });
  await expect(viewerCard).toContainText('存储/上传/分片上传');
  await expect(viewerCard.getByRole('button')).toHaveCount(0);
  await ctx.close();

  await card.getByRole('button', { name: '移除 存储/上传/分片上传' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '移除' }).click();
  await expect(card).toContainText('还没有声明影响的功能点');

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/documents/${prd.displayKey}`);
    await page.getByRole('complementary').getByRole('region', { name: '影响的功能点' }).getByRole('button', { name: '声明影响' }).click();
    await expect(page.getByRole('dialog', { name: '声明影响' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '声明影响' }).getByRole('button', { name: '存储/上传/分片上传' })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.keyboard.press('Escape');
  }
});

test('外部 PRD 不能选来源小节；开始合入后声明锁定，显示合入入口', async ({ page, request }) => {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  const upload = await createNode(request, productId, storage, '上传');
  const chunk = await createNode(request, productId, upload, '分片上传');
  const instant = await createNode(request, productId, upload, '秒传');
  const ext = await createDocument(request, productId, { title: '外部', externalUrl: 'https://docs.qq.com/doc/affected-e2e' });
  const prd = await createDocument(request, productId, { title: '上传改版' });
  await ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/affected-nodes`, { data: { nodeId: chunk, changeType: 'added' } }));
  await ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/affected-nodes`, { data: { nodeId: instant, changeType: 'modified' } }));
  await launchDocument(request, prd.id);
  await ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/merge/${chunk}/skip`));
  await login(page, OWNER.email, OWNER.password);

  await page.goto(`/acme/documents/${ext.displayKey}`);
  await page.getByRole('complementary').getByRole('region', { name: '影响的功能点' }).getByRole('button', { name: '声明影响' }).click();
  await expect(page.getByRole('dialog', { name: '声明影响' })).toContainText('外部 PRD 没有正文，来源小节不可选');
  await page.keyboard.press('Escape');

  await page.goto(`/acme/documents/${prd.displayKey}`);
  const card = page.getByRole('complementary').getByRole('region', { name: '影响的功能点' });
  await expect(card).toContainText('已开始合入，声明在合入页处理。');
  await expect(card).toContainText('已跳过');
  await expect(card.getByRole('button', { name: '声明影响' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^修改 / })).toHaveCount(0);
  await expect(card.getByRole('link', { name: '合入模块文档' })).toHaveAttribute('href', `/acme/documents/${prd.displayKey}/merge`);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: FAIL（`featureOptions` 不存在）。

Run: `pnpm --filter @flower/web e2e module-affected.spec.ts`
Expected: FAIL（找不到「影响的功能点」区块）。

- [ ] **Step 3: 选项的纯函数**

`apps/web/src/features/documents/model.ts`：

1. import 区加 `import { nodeOptions } from '@/features/structure/model';`，`@/lib/types` 的 type import 加入 `StructureNode`。
2. 文件末尾加：

```ts
export type NodeOption = { id: string; path: string };

function pathOf(nodes: StructureNode[]): (id: string) => string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id) => {
    const names: string[] = [];
    for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) names.unshift(cur.name);
    return names.join('/');
  };
}

/** 某一层没停用（本身与上级都没停用）的节点，按树的顺序，带名称路径。 */
function activeAt(nodes: StructureNode[], depth: number): NodeOption[] {
  const path = pathOf(nodes);
  return nodeOptions(nodes, null)
    .filter((n) => n.depth === depth)
    .map((n) => ({ id: n.id, path: path(n.id) }));
}

/** 声明影响时可选的功能点：没停用、还没声明过，名称路径包含查询（不区分大小写），按树的顺序最多 20 个。 */
export function featureOptions(nodes: StructureNode[], q: string, exclude: Set<string>): NodeOption[] {
  const want = q.trim().toLowerCase();
  return activeAt(nodes, 3)
    .filter((o) => !exclude.has(o.id) && (!want || o.path.toLowerCase().includes(want)))
    .slice(0, 20);
}

/** 当场新建功能点时可选的模块。 */
export const moduleOptions = (nodes: StructureNode[]): NodeOption[] => activeAt(nodes, 2);

/** 当场新建模块时可选的业务域。 */
export const domainOptions = (nodes: StructureNode[]): NodeOption[] => activeAt(nodes, 1);
```

- [ ] **Step 4: 声明对话框**

新建 `apps/web/src/app/(app)/[org]/documents/[key]/affected-node-dialog.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CHANGE_TYPE_LABEL, domainOptions, featureOptions, moduleOptions } from '@/features/documents/model';
import { levelLabel } from '@/features/structure/model';
import { api } from '@/lib/api';
import { documentKeys, qk, useApiMutation, useLevelNames, useNodes } from '@/lib/queries';
import type { AffectedChangeType, AffectedNode, AffectedNodes, DocumentDetail, StructureNode } from '@/lib/types';
import { cn } from '@/lib/utils';

const CHANGE_TYPES: AffectedChangeType[] = ['added', 'modified', 'removed'];

/**
 * 声明影响（item 为空）或修改一条声明。功能点按名称搜索本产品的结构树；没有时可以在模块下新建功能点，
 * 或在业务域下新建模块再建功能点。初值只在挂载时读取，调用方用 key 重新挂载。
 */
export function AffectedNodeDialog({
  org,
  doc,
  affected,
  item,
  onClose,
}: {
  org: string;
  doc: DocumentDetail;
  affected: AffectedNodes;
  item: AffectedNode | null;
  onClose: () => void;
}) {
  const nodes = useNodes(org, doc.productId);
  const levels = useLevelNames(org, doc.productId);
  const names = levels.data?.names ?? [];
  const [q, setQ] = useState('');
  const [nodeId, setNodeId] = useState<string | null>(item?.nodeId ?? null);
  const [changeType, setChangeType] = useState<AffectedChangeType>(item?.changeType ?? 'modified');
  const [sources, setSources] = useState<string[]>(item?.sourceSections.map((s) => s.key) ?? []);
  const [domainId, setDomainId] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [moduleId, setModuleId] = useState('');
  const [featureName, setFeatureName] = useState('');
  const newNode = useApiMutation(
    (v: { parentId: string; name: string }) => api<{ node: StructureNode }>(`/orgs/${org}/documents/${doc.id}/affected-nodes/new-node`, { method: 'POST', body: v }),
    { silentError: true, invalidate: [qk.nodes(org, doc.productId), documentKeys(org)] },
  );
  const save = useApiMutation(
    () =>
      item
        ? api(`/orgs/${org}/documents/${doc.id}/affected-nodes/${item.nodeId}`, { method: 'PATCH', body: { changeType, sourceSections: sources } })
        : api(`/orgs/${org}/documents/${doc.id}/affected-nodes`, { method: 'POST', body: { nodeId, changeType, sourceSections: sources } }),
    { silentError: true, invalidate: [documentKeys(org)], success: '已保存', onSuccess: onClose },
  );
  const all = nodes.data ?? [];
  const options = featureOptions(all, q, new Set(affected.items.map((x) => x.nodeId)));
  const modules = moduleOptions(all);
  const domains = domainOptions(all);
  // 已失效的来源仍列出（已勾选），由用户决定保留还是去掉
  const choices = [...affected.sections, ...(item?.sourceSections.filter((s) => s.stale).map((s) => s.key) ?? [])];
  const stale = new Set(item?.sourceSections.filter((s) => s.stale).map((s) => s.key) ?? []);
  const featureLabel = levelLabel(names, 3);
  const moduleLabel = levelLabel(names, 2);
  const domainLabel = levelLabel(names, 1);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item ? '修改影响声明' : '声明影响'}</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (item || nodeId) save.mutate();
          }}
        >
          {item ? (
            <p className="text-[13px]">{item.path}</p>
          ) : (
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{featureLabel}</legend>
              <Input aria-label={`搜索${featureLabel}`} placeholder={`按名称搜索本产品的${featureLabel}`} className="h-8" value={q} onChange={(e) => setQ(e.target.value)} />
              {options.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">没有可选的{featureLabel}，可以在下面新建</p>
              ) : (
                <ul className="flex max-h-48 flex-col overflow-y-auto rounded-md border">
                  {options.map((o) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        aria-pressed={nodeId === o.id}
                        className={cn('w-full truncate px-3 py-1.5 text-left text-[13px] hover:bg-muted', nodeId === o.id && 'bg-primary/10')}
                        onClick={() => setNodeId(o.id)}
                      >
                        {o.path}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
                <p className="text-xs text-muted-foreground">没有合适的{featureLabel}时当场新建</p>
                {domains.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    结构树还没有{domainLabel}，请产品管理员在产品设置的结构树页签中添加。
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={moduleId} onValueChange={setModuleId}>
                        <SelectTrigger className="h-8 w-48" aria-label={`所属${moduleLabel}`}>
                          <SelectValue placeholder={`选择${moduleLabel}`} />
                        </SelectTrigger>
                        <SelectContent>
                          {modules.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.path}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input aria-label={`新${featureLabel}名称`} className="h-8 w-40" maxLength={50} value={featureName} onChange={(e) => setFeatureName(e.target.value)} />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!moduleId || !featureName.trim() || newNode.isPending}
                        onClick={() =>
                          newNode.mutate(
                            { parentId: moduleId, name: featureName },
                            {
                              onSuccess: (r) => {
                                setNodeId(r.node.id);
                                setFeatureName('');
                                setQ('');
                              },
                            },
                          )
                        }
                      >
                        新建{featureLabel}
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={domainId} onValueChange={setDomainId}>
                        <SelectTrigger className="h-8 w-48" aria-label={`所属${domainLabel}`}>
                          <SelectValue placeholder={`选择${domainLabel}`} />
                        </SelectTrigger>
                        <SelectContent>
                          {domains.map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.path}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input aria-label={`新${moduleLabel}名称`} className="h-8 w-40" maxLength={50} value={moduleName} onChange={(e) => setModuleName(e.target.value)} />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!domainId || !moduleName.trim() || newNode.isPending}
                        onClick={() =>
                          newNode.mutate(
                            { parentId: domainId, name: moduleName },
                            {
                              onSuccess: (r) => {
                                setModuleId(r.node.id);
                                setModuleName('');
                              },
                            },
                          )
                        }
                      >
                        新建{moduleLabel}
                      </Button>
                    </div>
                  </>
                )}
                <FormError error={newNode.error} />
              </div>
            </fieldset>
          )}

          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">变更类型</span>
            <Select value={changeType} onValueChange={(v) => setChangeType(v as AffectedChangeType)}>
              <SelectTrigger className="h-8 w-28" aria-label="变更类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANGE_TYPES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CHANGE_TYPE_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">来源小节</legend>
            {doc.source !== 'native' ? (
              <p className="text-[13px] text-muted-foreground">外部 PRD 没有正文，来源小节不可选</p>
            ) : choices.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">PRD 正文还没有小节</p>
            ) : (
              choices.map((key) => (
                <label key={key} className="flex min-w-0 items-center gap-1.5 text-[13px]">
                  <Checkbox aria-label={key} checked={sources.includes(key)} onCheckedChange={(v) => setSources(v ? [...sources, key] : sources.filter((x) => x !== key))} />
                  <span className={cn('truncate', stale.has(key) && 'line-through')}>{key}</span>
                  {stale.has(key) && <span className="shrink-0 text-xs text-muted-foreground">（已失效）</span>}
                </label>
              ))
            )}
          </fieldset>

          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={save.isPending || (!item && !nodeId)}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: 「影响的功能点」卡片**

新建 `apps/web/src/app/(app)/[org]/documents/[key]/affected-nodes.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { QueryError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CHANGE_TYPE_LABEL, MERGE_STATUS_LABEL } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, useAffectedNodes, useApiMutation } from '@/lib/queries';
import type { AffectedNode, DocumentDetail } from '@/lib/types';
import { cn } from '@/lib/utils';
import { AffectedNodeDialog } from './affected-node-dialog';

/** 变更 PRD 侧栏「影响的功能点」：声明列表、增删改，已上线时进入合入页。 */
export function AffectedNodes({ org, doc }: { org: string; doc: DocumentDetail }) {
  const q = useAffectedNodes(org, doc.id);
  // seq 让每次打开对话框都重新挂载，初值取当时的声明
  const [editing, setEditing] = useState<{ item: AffectedNode | null; seq: number } | null>(null);
  const remove = useApiMutation((nodeId: string) => api(`/orgs/${org}/documents/${doc.id}/affected-nodes/${nodeId}`, { method: 'DELETE' }), {
    invalidate: [documentKeys(org)],
    success: '已移除',
  });
  const open = (item: AffectedNode | null) => setEditing((e) => ({ item, seq: (e?.seq ?? 0) + 1 }));
  const a = q.data;
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-affected-title">
      <h2 id="doc-affected-title" className="mb-2 text-sm font-semibold">
        影响的功能点
      </h2>
      {q.isError ? (
        <QueryError error={q.error} noAccessMessage="没有查看影响声明的权限。" retryMessage="加载影响声明失败，请重试。" onRetry={() => q.refetch()} />
      ) : !a ? (
        <Skeleton className="h-12" />
      ) : (
        <>
          {a.items.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">还没有声明影响的功能点</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {a.items.map((it) => (
                <li key={it.nodeId} className="flex min-w-0 flex-col gap-1 py-2 text-[13px]">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={it.path}>
                      {it.path}
                    </span>
                    <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs">{CHANGE_TYPE_LABEL[it.changeType]}</span>
                  </div>
                  {it.sourceSections.length > 0 && (
                    <p className="break-words text-xs text-muted-foreground">
                      来源：
                      {it.sourceSections.map((s, i) => (
                        <span key={s.key}>
                          {i > 0 && '、'}
                          <span className={cn(s.stale && 'line-through')}>{s.key}</span>
                          {s.stale && '（已失效）'}
                        </span>
                      ))}
                    </p>
                  )}
                  {it.mergeStatus !== 'pending' && <p className="text-xs text-muted-foreground">{MERGE_STATUS_LABEL[it.mergeStatus]}</p>}
                  {a.editable && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" aria-label={`修改 ${it.path}`} onClick={() => open(it)}>
                        修改
                      </Button>
                      <ConfirmAction
                        trigger={
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" aria-label={`移除 ${it.path}`} disabled={remove.isPending}>
                            移除
                          </Button>
                        }
                        title={`移除「${it.path}」？`}
                        description="只移除这条影响声明，结构树里的功能点保留。"
                        confirmLabel="移除"
                        onConfirm={() => remove.mutate(it.nodeId)}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {a.locked && <p className="mt-2 text-xs text-muted-foreground">已开始合入，声明在合入页处理。</p>}
          {(a.editable || (a.items.length > 0 && (doc.status === 'launched' || doc.status === 'merged'))) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {a.editable && (
                <Button size="sm" variant="outline" onClick={() => open(null)}>
                  声明影响
                </Button>
              )}
              {a.items.length > 0 && (doc.status === 'launched' || doc.status === 'merged') && (
                <Button size="sm" asChild>
                  <Link href={`/${org}/documents/${doc.displayKey}/merge`}>{doc.status === 'launched' ? '合入模块文档' : '查看合入'}</Link>
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {editing && a && <AffectedNodeDialog key={editing.seq} org={org} doc={doc} affected={a} item={editing.item} onClose={() => setEditing(null)} />}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/documents/[key]/side-panel.tsx`：import 区加 `import { AffectedNodes } from './affected-nodes';`；「覆盖的需求」区块（`aria-labelledby="doc-req-title"` 的 `<section>`）结束之后、`<CheckItems …/>` 之前加：

```tsx
      <AffectedNodes org={org} doc={doc} />
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e module-affected.spec.ts documents-prd-flow.spec.ts documents-permissions.spec.ts documents.spec.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/documents/[key]/affected-nodes.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/affected-node-dialog.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/side-panel.tsx" apps/web/src/features/documents/model.ts apps/web/src/features/documents/model.test.ts apps/web/e2e/helpers.ts apps/web/e2e/module-affected.spec.ts
git commit -m "feat(web): PRD 的影响声明，声明时当场新建模块与功能点

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 页面：合入页（逐个功能点应用、跳过、撤销），节点链接跳到模块文档小节

**Files:**
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/merge/page.tsx`、`apps/web/src/app/(app)/[org]/documents/[key]/merge/merge-item.tsx`
- Test: `apps/web/e2e/module-merge.spec.ts`

**Interfaces:**
- Consumes: Task 9 `useDocument`、`useMergePlan`、合入接口、`MergeItem`、`MergeResult`；Task 11 `CHANGE_TYPE_LABEL`、`MERGE_STATUS_LABEL`；Task 12 e2e `launchDocument`、Task 10 e2e `createNode`
- Produces: 页面 `/{org}/documents/{PRD 编号}/merge`；`<MergeItemCard org documentId baseVersion item canMerge canReopen onRefresh />`（`article`，无障碍名称为功能点路径）

- [ ] **Step 1: 写失败的测试**

新建 `apps/web/e2e/module-merge.spec.ts`：

```ts
import { type APIRequestContext, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createNode, createProduct, expectNoPageOverflow, json, launchDocument, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const PRD_BODY = '## 背景\n\n现状\n\n## 需求说明\n\n上传改为分片\n\n### 细节\n\n断点续传';

/** 存储/上传/{分片上传, 秒传, 旧接口}、存储/下载/离线下载；上传已有模块文档；PRD 声明四个功能点后上线。 */
async function setup(request: APIRequestContext) {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  const upload = await createNode(request, productId, storage, '上传');
  const chunk = await createNode(request, productId, upload, '分片上传');
  const instant = await createNode(request, productId, upload, '秒传');
  const legacy = await createNode(request, productId, upload, '旧接口');
  const download = await createNode(request, productId, storage, '下载');
  const offline = await createNode(request, productId, download, '离线下载');
  const prd = await createDocument(request, productId, { title: '上传改版' }); // PAN-PRD-1
  await ok(request.put(`/api/v1/orgs/acme/documents/${prd.id}/content`, { data: { baseVersion: prd.version, markdown: PRD_BODY } }));
  const mod = (await json<{ document: { id: string; displayKey: string; version: number } }>(request.post(`/api/v1/orgs/acme/nodes/${upload}/module-document`))).document; // PAN-PRD-2
  await ok(request.put(`/api/v1/orgs/acme/documents/${mod.id}/content`, { data: { baseVersion: mod.version, markdown: '上传总述\n\n## 秒传\n\n秒传说明\n\n## 旧接口\n\n旧接口说明\n' } }));
  const declare = (nodeId: string, changeType: string, sourceSections: string[]) =>
    ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/affected-nodes`, { data: { nodeId, changeType, sourceSections } }));
  await declare(chunk, 'added', ['需求说明']);
  await declare(instant, 'modified', ['需求说明 / 细节']);
  await declare(legacy, 'removed', []);
  await declare(offline, 'added', []);
  await launchDocument(request, prd.id);
  return { productId, prd, mod, download, chunk };
}

test('合入页：逐个应用与跳过，撤销跳过后再应用；全部处理完 PRD 变为已合入', async ({ page, request }) => {
  const { prd } = await setup(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${prd.displayKey}`);
  await page.getByRole('complementary').getByRole('link', { name: '合入模块文档' }).click();
  await expect(page).toHaveURL(/\/acme\/documents\/PAN-PRD-1\/merge$/);
  const progress = page.getByRole('status').filter({ hasText: '已处理' });
  await expect(progress).toHaveText('已处理 0 / 4');

  const chunk = page.getByRole('article', { name: '存储/上传/分片上传' });
  await expect(chunk).toContainText('模块文档里还没有这个小节');
  await expect(chunk.getByLabel('分片上传 合入内容')).toHaveValue('上传改为分片\n\n### 细节\n\n断点续传');
  await chunk.getByRole('button', { name: '应用 分片上传' }).click();
  await expect(chunk).toContainText('已应用 · 第 2 版');

  const instant = page.getByRole('article', { name: '存储/上传/秒传' });
  await expect(instant.getByLabel('秒传 现状')).toHaveText('秒传说明');
  await expect(instant.getByLabel('秒传 合入内容')).toHaveValue('断点续传');
  await instant.getByLabel('秒传 合入内容').fill('断点续传，单文件最大 10 GB');
  await instant.getByRole('button', { name: '应用 秒传' }).click();
  await expect(instant).toContainText('已应用');

  const legacy = page.getByRole('article', { name: '存储/上传/旧接口' });
  await expect(legacy).toContainText('应用后将删除该小节');
  await legacy.getByRole('button', { name: '跳过 旧接口' }).click();
  await expect(legacy).toContainText('已跳过');
  await legacy.getByRole('button', { name: '撤销跳过 旧接口' }).click();
  await legacy.getByRole('button', { name: '应用 旧接口' }).click();
  await expect(legacy).toContainText('已应用');

  await expect(page.getByRole('region', { name: '存储/下载' })).toContainText('模块文档将在第一次应用时自动新建');
  const offline = page.getByRole('article', { name: '存储/下载/离线下载' });
  await offline.getByLabel('离线下载 合入内容').fill('支持离线下载');
  await offline.getByRole('button', { name: '应用 离线下载' }).click();
  await expect(progress).toHaveText('已处理 4 / 4，全部处理完，PRD 已变为「已合入」');
  await expect(page.getByRole('region', { name: '存储/下载' }).getByRole('link', { name: 'PAN-PRD-3' })).toBeVisible();

  await page.goto(`/acme/documents/${prd.displayKey}`);
  await expect(page.getByRole('complementary').getByRole('region', { name: '状态' })).toContainText('已合入');
  await expect(page.getByRole('complementary').getByRole('link', { name: '查看合入' })).toBeVisible();
});

test('版本冲突：合入页打开后模块文档被别人改过，应用时提示并刷新左侧后重试', async ({ page, request }) => {
  const { prd, mod } = await setup(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${prd.displayKey}/merge`);
  const instant = page.getByRole('article', { name: '存储/上传/秒传' });
  await expect(instant.getByLabel('秒传 现状')).toHaveText('秒传说明');
  const cur = await json<{ document: { version: number } }>(request.get(`/api/v1/orgs/acme/documents/${mod.displayKey}`));
  await ok(request.put(`/api/v1/orgs/acme/documents/${mod.id}/content`, { data: { baseVersion: cur.document.version, markdown: '上传总述\n\n## 秒传\n\n别人刚改的秒传说明\n\n## 旧接口\n\n旧接口说明\n' } }));
  await instant.getByRole('button', { name: '应用 秒传' }).click();
  await expect(instant.getByRole('alert')).toContainText('模块文档已被其他人修改，请刷新左侧内容后重试');
  await instant.getByRole('button', { name: '刷新左侧' }).click();
  await expect(instant.getByLabel('秒传 现状')).toHaveText('别人刚改的秒传说明');
  await expect(instant.getByRole('alert')).toHaveCount(0);
  await instant.getByRole('button', { name: '应用 秒传' }).click();
  await expect(instant).toContainText('已应用');
});

test('模块文档：合入后的正文、修订来源与合入记录；节点链接跳到模块文档小节或模块文档页签；两种宽度不横向滚动', async ({ page, request }) => {
  const { productId, prd, mod, download } = await setup(request);
  const plan = await json<{ plan: { groups: Array<{ document: { version: number } | null; items: Array<{ nodeId: string; prefill: string }> }> } }>(
    request.get(`/api/v1/orgs/acme/documents/${prd.id}/merge`),
  );
  const up = plan.plan.groups[0]!;
  await ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/merge/${up.items[0]!.nodeId}/apply`, { data: { baseVersion: up.document!.version, body: up.items[0]!.prefill } }));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '引用模块', description: '见 [[存储/上传/分片上传]] 与 [[存储/下载]]' } }));
  await login(page, OWNER.email, OWNER.password);

  await page.goto(`/acme/documents/${mod.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body.getByRole('heading', { name: '分片上传' })).toBeVisible();
  const revisions = page.getByRole('complementary').getByRole('region', { name: '修订记录' });
  await expect(revisions).toContainText('合入 PAN-PRD-1：分片上传');
  await expect(revisions.getByRole('link', { name: '来源 PAN-PRD-1 上传改版' })).toHaveAttribute('href', `/acme/documents/${prd.displayKey}`);
  const records = page.getByRole('region', { name: '合入记录' });
  await expect(records).toContainText('分片上传');
  await expect(records).toContainText('新增');
  await expect(records.getByRole('link', { name: /PAN-PRD-1/ })).toContainText('上传改版');

  await page.goto('/acme/requirements/PAN-1');
  await page.getByRole('link', { name: '存储/上传/分片上传' }).click();
  await expect(page).toHaveURL(new RegExp(`/acme/documents/${mod.displayKey}\\?section=`));
  await expect(page.getByRole('region', { name: '正文' }).getByRole('heading', { name: '分片上传' })).toBeInViewport();
  await page.goto('/acme/requirements/PAN-1');
  await page.getByRole('link', { name: '存储/下载' }).click();
  await expect(page).toHaveURL(new RegExp(`view=modules&node=${download}`));
  await expect(page.getByRole('row', { name: /^下载/ })).toHaveAttribute('aria-current', 'true');

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/documents/${prd.displayKey}/merge`);
    await expect(page.getByRole('article', { name: '存储/上传/秒传' })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});

test('只读成员能看合入页，没有应用、跳过按钮', async ({ browser, request }) => {
  const { productId, prd } = await setup(request);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  await page.goto(`/acme/documents/${prd.displayKey}/merge`);
  const chunk = page.getByRole('article', { name: '存储/上传/分片上传' });
  await expect(chunk.getByLabel('分片上传 合入内容')).toHaveValue('上传改为分片\n\n### 细节\n\n断点续传');
  await expect(page.getByRole('button', { name: /^(应用|跳过) / })).toHaveCount(0);
  await ctx.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @flower/web e2e module-merge.spec.ts`
Expected: FAIL（合入页 404）。

- [ ] **Step 3: 合入卡片**

新建 `apps/web/src/app/(app)/[org]/documents/[key]/merge/merge-item.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CHANGE_TYPE_LABEL, MERGE_STATUS_LABEL } from '@/features/documents/model';
import { ApiError, api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { MergeItem, MergeResult } from '@/lib/types';

/**
 * 合入页的一个功能点：左侧模块文档现状，右侧可编辑的合入内容（用户改过之前跟随服务端预填），应用 / 跳过 / 撤销跳过。
 * baseVersion 是本页看到的模块文档版本号（文档还不存在时为 null），模块文档有更新的版本时服务端返回 409。
 */
export function MergeItemCard({
  org,
  documentId,
  baseVersion,
  item,
  canMerge,
  canReopen,
  onRefresh,
}: {
  org: string;
  documentId: string;
  baseVersion: number | null;
  item: MergeItem;
  canMerge: boolean;
  canReopen: boolean;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const body = draft ?? item.prefill;
  const invalidate = [documentKeys(org), requirementKeys(org), qk.workbench];
  const path = `/orgs/${org}/documents/${documentId}/merge/${item.nodeId}`;
  const apply = useApiMutation(() => api<{ result: MergeResult }>(`${path}/apply`, { method: 'POST', body: { baseVersion, body } }), { silentError: true, invalidate, success: '已应用' });
  const skip = useApiMutation(() => api<{ result: MergeResult }>(`${path}/skip`, { method: 'POST' }), { silentError: true, invalidate, success: '已跳过' });
  const reopen = useApiMutation(() => api<{ result: MergeResult }>(`${path}/reopen`, { method: 'POST' }), { silentError: true, invalidate, success: '已撤销跳过' });
  const error = apply.error ?? skip.error ?? reopen.error;
  const conflict = apply.error instanceof ApiError && apply.error.status === 409;
  const busy = apply.isPending || skip.isPending || reopen.isPending;
  const pending = item.mergeStatus === 'pending';
  const removing = item.changeType === 'removed';
  const stale = item.sourceSections.filter((s) => s.stale);
  const actions = (pending && canMerge) || (item.mergeStatus === 'skipped' && canReopen);
  return (
    <article aria-label={item.path} className="min-w-0 rounded-md border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[13px]">
        <span className="font-medium">{item.name}</span>
        <span className="rounded-sm bg-muted px-1.5 text-xs">{CHANGE_TYPE_LABEL[item.changeType]}</span>
        <span className="text-muted-foreground">
          {MERGE_STATUS_LABEL[item.mergeStatus]}
          {item.mergeStatus === 'applied' && item.mergedRevisionNumber !== null && ` · 第 ${item.mergedRevisionNumber} 版`}
        </span>
      </header>
      <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">模块文档现状</h3>
          {item.current === null ? (
            <p className="text-[13px] text-muted-foreground">{item.changeType === 'modified' && pending ? '模块文档里没有这个小节，应用时按新增处理' : '模块文档里还没有这个小节'}</p>
          ) : (
            <pre aria-label={`${item.name} 现状`} className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-[12px]">
              {item.current || '（空）'}
            </pre>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">合入内容</h3>
          {removing ? (
            <p className="text-[13px]">应用后将删除该小节</p>
          ) : (
            <Textarea
              aria-label={`${item.name} 合入内容`}
              className="min-h-40 font-mono text-[12px]"
              value={body}
              readOnly={!pending || !canMerge}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
          {stale.length > 0 && <p className="text-xs text-muted-foreground">来源小节已失效，未预填：{stale.map((s) => s.key).join('、')}</p>}
        </div>
      </div>
      {(error || actions) && (
        <footer className="flex flex-col gap-2 border-t px-4 py-2">
          <FormError error={error} />
          <div className="flex flex-wrap gap-2">
            {conflict && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  apply.reset();
                  onRefresh();
                }}
              >
                刷新左侧
              </Button>
            )}
            {pending && canMerge && (
              <>
                <Button size="sm" disabled={busy} aria-label={`应用 ${item.name}`} onClick={() => apply.mutate()}>
                  应用
                </Button>
                <Button size="sm" variant="outline" disabled={busy} aria-label={`跳过 ${item.name}`} onClick={() => skip.mutate()}>
                  跳过
                </Button>
              </>
            )}
            {item.mergeStatus === 'skipped' && canReopen && (
              <Button size="sm" variant="outline" disabled={busy} aria-label={`撤销跳过 ${item.name}`} onClick={() => reopen.mutate()}>
                撤销跳过
              </Button>
            )}
          </div>
        </footer>
      )}
    </article>
  );
}
```

- [ ] **Step 4: 合入页**

新建 `apps/web/src/app/(app)/[org]/documents/[key]/merge/page.tsx`：

```tsx
'use client';

import { GitMerge } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { documentHref } from '@/features/documents/model';
import { useDocument, useMergePlan } from '@/lib/queries';
import { MergeItemCard } from './merge-item';

/** 合入页：按模块分组，逐个功能点把变更 PRD 的来源小节合入模块文档。 */
function MergePage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const d = useDocument(org, decodeURIComponent(key));
  const plan = useMergePlan(org, d.data?.id);
  if (d.isError) {
    return <QueryError error={d.error} noAccessMessage="PRD 不存在，或你没有查看它所在产品的权限。" retryMessage="加载 PRD 失败，请重试。" onRetry={() => d.refetch()} />;
  }
  if (plan.isError) {
    return <QueryError error={plan.error} noAccessMessage="没有查看合入的权限。" retryMessage="加载合入内容失败，请重试。" onRetry={() => plan.refetch()} />;
  }
  if (!d.data || !plan.data) return <Skeleton className="h-64" />;
  const p = plan.data;
  return (
    <>
      <PageHeader
        crumbs={[
          { label: '文档', href: `/${org}/documents?product=${d.data.productKey}` },
          { label: p.document.displayKey, href: documentHref(org, p.document.displayKey) },
          { label: '合入模块文档' },
        ]}
        title="合入模块文档"
        description={`${p.document.displayKey} ${p.document.title}`}
        actions={<DocumentStatusBadge status={p.document.status} />}
      />
      <p role="status" className="text-[13px] text-muted-foreground">
        已处理 {p.done} / {p.total}
        {p.document.status === 'merged' && '，全部处理完，PRD 已变为「已合入」'}
      </p>
      {p.total === 0 ? (
        <EmptyState icon={GitMerge} title="还没有影响声明" description="先在 PRD 详情的「影响的功能点」里声明要合入的功能点。" />
      ) : (
        p.groups.map((g) => (
          <section key={g.module?.id ?? 'none'} aria-label={g.module?.path ?? '不在模块下的功能点'} className="flex min-w-0 flex-col gap-3">
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {g.module?.path ?? '不在模块下的功能点'}
              {g.document ? (
                <Link href={documentHref(org, g.document.displayKey)} className="font-mono text-[13px] font-normal text-muted-foreground hover:underline">
                  {g.document.displayKey}
                </Link>
              ) : (
                g.module && <span className="text-[13px] font-normal text-muted-foreground">模块文档将在第一次应用时自动新建</span>
              )}
            </h2>
            {g.items.map((it) => (
              <MergeItemCard key={it.nodeId} org={org} documentId={p.document.id} baseVersion={g.document?.version ?? null} item={it} canMerge={p.canMerge} canReopen={p.canReopen} onRefresh={() => void plan.refetch()} />
            ))}
          </section>
        ))
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <MergePage />
    </Suspense>
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e module-merge.spec.ts module-affected.spec.ts module-docs.spec.ts links.spec.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add "apps/web/src/app/(app)/[org]/documents/[key]/merge" apps/web/e2e/module-merge.spec.ts
git commit -m "feat(web): 合入页：按功能点应用、跳过、撤销，版本冲突时刷新重试

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 本地开发库执行迁移并只读核对

**Files:**
- 不改代码。只操作本地开发库。

**Interfaces:**
- Consumes: Task 2 的迁移 `0013`、`0014`

- [ ] **Step 1: 迁移前只读核对**

```bash
docker exec flower-postgres-1 psql -U flower_admin -d flower -At \
  -c "select count(*) from documents d join organizations o on o.id = d.org_id where o.slug = 'pan123' and (d.kind = 'module' or d.node_id is not null)" \
  -c "select count(*), count(*) filter (where d.status = 'merged') from documents d join organizations o on o.id = d.org_id where o.slug = 'pan123' and d.deleted_at is null" \
  -c "select s.depth, count(*) from structure_nodes s join organizations o on o.id = s.org_id where o.slug = 'pan123' group by 1 order by 1"
```

Expected: `0`；`204|0`；`1|23`（只有业务域）。第一项不为 0 时停下来报告（检查约束或唯一索引可能建不起来）。

- [ ] **Step 2: 执行迁移并核对**

```bash
pnpm db:migrate
docker exec flower-postgres-1 psql -U flower_admin -d flower -At \
  -c "select relrowsecurity from pg_class where relname = 'document_affected_nodes'" \
  -c "select count(*) from pg_policies where tablename = 'document_affected_nodes'" \
  -c "select count(*) from document_affected_nodes" \
  -c "select indexname from pg_indexes where tablename = 'documents' and indexname = 'documents_module_node'" \
  -c "select conname from pg_constraint where conname = 'documents_kind_node'" \
  -c "select count(*) from documents d join organizations o on o.id = d.org_id where o.slug = 'pan123' and d.deleted_at is null"
```

Expected: `pnpm db:migrate` 应用 `0013`、`0014`，并把 `flower_app` 的密码改回 `apps/web/.env.local` 的值；依次输出 `t`、`1`、`0`、`documents_module_node`、`documents_kind_node`、`204`。任何一项不符时停下来报告（只报数量）。

---

### Task 15: 全量验证、真实数据复验（控制方）、验证记录与交接

**Files:**
- Create: `docs/p2b2-validation.md`
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

Expected: 全部通过（`editor-perf.spec.ts` 在未设置 `EDITOR_BENCH` 时跳过）；记下 core、web、migrate 单测数与 e2e 用例数。最后一条把 `flower_app` 密码改回开发值。

- [ ] **Step 2: STOP——控制方在真实数据上复验界面**

执行代理不运行 `pnpm dev`。在这里停下，把下面的复验清单交给控制方；控制方在本地开发库（pan123）上以 1440px 与 760px 两种宽度逐项检查，确认页面本身不横向滚动，把结论（只写现象与数量）交回。复验只新建复验专用的对象，不修改迁移来的 PRD、需求与业务域：

1. 文档页「模块文档」页签：列出 pan123 的 23 个业务域，每个都显示「还没有模块」；「变更 PRD」页签的状态筛选里有「已合入」。
2. 产品设置 → 结构树：新建业务域「P2-B2 复验」（产品管理员操作）。
3. 新建一份 Flower 内的测试 PRD「P2-B2 复验 PRD」，正文写两个二级小节（如「背景」「需求说明」，后者带一个三级小节）。在「影响的功能点」里声明影响：在「P2-B2 复验」下当场新建模块「复验模块」，再新建功能点「复验功能点 A」「复验功能点 B」；A 选「新增」+ 来源「需求说明」，B 选「修改」不选来源。修改一次、移除再加回一次。
4. 把测试 PRD 依次改为评审中、已通过、已上线；侧栏出现「合入模块文档」。合入页：A 的右侧预填为「需求说明」及其下级小节（标题下移为三级起）；应用 A；B 先跳过、再撤销、再填写内容后应用；最后 PRD 变为「已合入」，侧栏变为「查看合入」。
5. 「复验模块」的模块文档：正文两节顺序与结构树一致；修订记录显示「合入 PAN-PRD-n：…」与来源链接；「合入记录」两条；归档后编辑器只读、「恢复」按钮消失，恢复为使用中后可编辑。
6. 结构树页签：「复验模块」行显示模块文档编号链接；把「复验功能点 A」改名为「复验功能点 A1」，模块文档里该小节标题同步，修订记录多一版「功能点改名：复验功能点 A → 复验功能点 A1」。
7. 在测试 PRD 的正文末尾写 `[[P2-B2 复验/复验模块/复验功能点 B]]`（PRD 已合入后仍可编辑正文）：链接卡点击后跳到模块文档并滚动到该小节；`[[P2-B2 复验/复验模块]]` 跳到模块文档。
8. 复验结束后，在结构树页签把「P2-B2 复验」业务域停用。记录复验新增的对象数量：业务域 1、模块 1、功能点 2、文档 2（测试 PRD 与模块文档）。

- [ ] **Step 3: 写验证记录**

新建 `docs/p2b2-validation.md`，结构与 `docs/p2b1-validation.md` 一致，包含：

1. 迁移：Task 14 的核对结果（`document_affected_nodes` RLS 开启、`documents_module_node` 与 `documents_kind_node` 已建、pan123 文档 204 份不变、模块文档与声明均为 0）。
2. 自动化测试数量（Step 1）。
3. 界面复验结果（Step 2，每项「通过 / 问题与处理」），以及复验新增的对象数量与停用说明。
4. 人工验收清单（供用户试用）：模块文档页签与新建、模块文档编辑与归档、影响声明与当场新建节点、来源小节失效提示、合入页的应用 / 跳过 / 撤销 / 版本冲突、PRD 变为已合入与「PRD」检查项、修订来源与合入记录、功能点改名同步、节点链接跳到模块文档小节、结构树页签的模块文档链接。

- [ ] **Step 4: 更新交接文档与协作日志**

`docs/handoff.md`：

1. 「关键文档」表加三行：`docs/superpowers/specs/2026-10-09-flower-p2b2-module-docs-design.md`（P2-B2 设计，已确认）、`docs/superpowers/plans/2026-10-09-flower-p2b2-module-docs.md`（P2-B2 计划）、`docs/p2b2-validation.md`（P2-B2 真实数据验证记录与人工验收清单）。
2. 「当前进度」加一条「P2-B2 模块文档、影响声明与人工合入：已完成，待合并」，写清：模块文档（每个模块一份、按功能点分节、归档只读）、影响声明（来源小节、当场新建模块与功能点、开始合入后锁定）、合入页（应用 / 跳过 / 撤销、版本冲突、全部处理完变为已合入）、修订来源与合入记录、功能点改名同步、节点链接指向模块文档、迁移核对结果（数量）。
3. 「下一步」改为：合并 P2-B2；用户按 `docs/p2b2-validation.md` 第 4 节验收；规划下一阶段。

`docs/agent-log.md`「记录」最上面加一条（格式按文件头）：

```
### 2026-10-XX · 本地 · P2-B2 模块文档、影响声明与人工合入
- 分支 / PR：`feat/p2b2-module-docs`
- 做了什么：
  - 数据模型：document_affected_nodes（RLS，声明与合入状态）；documents 每个模块一份模块文档（部分唯一索引）、kind 与 node_id 的检查约束；模块文档状态 active / archived 并入 documents.status。
  - 模块文档：与变更 PRD 共用编辑器、修订、链接与评论；按二级标题（功能点名称）分节；功能点改名同步小节标题；归档只读。
  - 影响声明：PRD 侧栏「影响的功能点」，来源小节与失效提示，声明时由产品编辑当场新建模块与功能点；开始合入后锁定。
  - 合入页：按模块分组，逐个功能点应用、跳过、撤销；版本冲突提示刷新；全部处理完 PRD 变为已合入并同步「PRD」检查项；修订带合入来源，模块文档有合入记录。
  - 节点链接卡：模块与功能点指向模块文档（功能点带小节），没有文档时指向「模块文档」页签。
- 怎么验证的：（Step 1 的测试数；Task 14 的迁移核对；Step 2 的复验结论）
- 留给对方：（没有就写"无"）
```

- [ ] **Step 5: 提交**

```bash
git add docs/p2b2-validation.md docs/handoff.md docs/agent-log.md
git commit -m "docs: P2-B2 验证记录、交接进度与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 与代码或数据的冲突

写计划时对照代码、上位文档与只读数据发现的不一致，以及本计划的处理：

| 设计说法 | 实际情况 | 本计划的处理 |
|---|---|---|
| 设计 §4「当场新建节点……新建走现有结构树服务」，声明由产品编辑及以上维护 | 现有 `createStructureNode` 要求产品管理员 | 抽出 `insertStructureNodeTx`（同名检查、事件、接上悬空链接不变），新增 `createNodeForDocument`：声明可修改时产品编辑可以建模块与功能点；结构树页签与业务域仍要求产品管理员 |
| 上位文档 §5.3 `document_merges`（提案、状态、产生的修订）与 §6.4「功能点历史以 origin = system 写入 entity_links」 | P2-B2 设计把合入状态放在 `document_affected_nodes`（§4），合入记录从声明与修订读出（§5） | 不建 `document_merges`，不写 system 链接；Task 2 同步上位文档 §5.1、§5.3、§6.4，Agent 起草提案（P5）时再定提案存储 |
| 设计 §4 `source_sections`「可空」 | jsonb 可空与空数组表达同一件事，查询两种都要处理 | 存为非空 jsonb，默认空数组，空数组表示没有来源 |
| 设计 §4「来源小节：从 PRD 当前正文的小节列表中选（按 1–3 级标题）」 | 小节可以重名，只存标题无法区分；只取所选小节的正文会丢掉下级小节 | 存 `splitSections` 的键（标题路径），预填含下级小节并把标题下移到三级起 |
| 设计 §5「跳过后可以撤销为 pending 重新处理」与「全部处理完时 PRD 变为已合入」 | 最后一条被跳过时 PRD 立即变为已合入，撤销后声明又有未处理的 | 撤销时同一事务把 PRD 退回已上线（记录状态事件，「PRD」检查项仍为通过）；再次全部处理完时重新变为已合入 |
| 设计 §6 只写了 `[[业务域/模块]]`、`[[业务域/模块/功能点]]` | P2-B1 的节点卡一律指向按节点筛选的需求列表，业务域也是节点 | 模块与功能点改为指向模块文档；业务域保持需求列表 |
| 设计 §3「也可以手动新建」 | 新建模块文档没有需要填写的字段 | 与「点开一个还没有文档的模块即新建」用同一入口（模块文档页签的模块名称）；只读成员不能新建 |
| P2-A 文档列表的状态筛选隐藏「已合入」 | P2-B2 起 PRD 会进入已合入 | 筛选改用 `CHANGE_DOCUMENT_STATUSES`，显示「已合入」，不显示模块文档的两个状态 |

## P2-B2 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm --filter @flower/web e2e`、`./scripts/smoke.sh` 全部通过；P2-A/P2-B1 的编辑器用例原样通过。
- 设计 §7 列出的内容都有单元或端到端测试：模块文档唯一性与自动新建；声明的增删改与锁定；应用（替换、按顺序插入、删除）、修订与来源、版本冲突；全部处理完变为已合入并同步「PRD」检查项；功能点改名同步标题；跳过与撤销；权限（编辑、只读、只读 Token）；声明时当场新建模块与功能点；合入页逐个应用与跳过；模块文档的修订来源与合入记录；节点链接跳到模块文档小节；1440 与 760 两种宽度。
- 本地开发库执行迁移后核对一致（Task 14）；控制方在 1440px 与 760px 两种宽度下用测试 PRD 走完声明 → 合入流程（Task 15），验证记录、交接文档与协作日志已更新。

## 自查

写完后对照设计逐条核对的结果：

| 设计条目 | 对应任务 |
|---|---|
| §3 对应关系：`kind = module`、`node_id` 指向模块、每个模块最多一份、编号沿用 | Task 2（索引与约束）、Task 3（新建与详情） |
| §3 状态 active / archived，归档只读可恢复，模块停用不影响文档 | Task 2（状态与流转）、Task 3（`assertWritable`）、Task 11（编辑器只读、隐藏恢复） |
| §3 正文与 PRD 相同的编辑器、自动保存、修订、对比、恢复、`[[ ]]`、评论 | Task 3（复用服务）、Task 11（复用详情页与编辑器） |
| §3 结构约定：概述、每个功能点一个二级标题、按归一化名称定位 | Task 1 |
| §3 功能点改名同步标题并生成修订 | Task 1（`renameFeatureHeading`）、Task 4 |
| §3 新建时机（第一次合入、点开没有文档的模块、手动） | Task 3（`ensureModuleDocumentTx`）、Task 7（合入时新建）、Task 10（页签点击新建） |
| §3 权限（编辑可改、只读可评论、只读 Token 不能写） | Task 3、Task 5、Task 7、Task 9（接口测试） |
| §4 `document_affected_nodes` 字段、唯一约束、RLS | Task 2 |
| §4 编辑规则与锁定 | Task 5 |
| §4 当场新建节点 | Task 6（服务）、Task 12（对话框） |
| §4 来源小节、已失效、外部 PRD 不可选 | Task 1（`prdSectionKeys`）、Task 5、Task 12 |
| §4 事件 `document.affected_nodes_changed` 带 `changes` | Task 5 |
| §5 入口、合入页左右两栏、`removed` 的说明、应用 / 跳过 | Task 7（数据）、Task 12（入口）、Task 13（页面） |
| §5 应用：锁、替换 / 按顺序插入 / 删除、修订摘要与 `merged_from_document_id`、版本检查、声明行、`document.merged` | Task 1、Task 3（`commitSystemRevisionTx`）、Task 7 |
| §5 跳过与撤销 | Task 7、Task 13 |
| §5 完成：同一事务改为 merged、「PRD」检查项同步 | Task 7 |
| §5 不能合入（作废、没有声明） | Task 7（只有已上线可合入）、Task 12（没有声明时不显示入口）、Task 13（没有声明的空状态） |
| §5 历史：修订列表显示合入来源、「合入记录」区块 | Task 8（服务）、Task 11（页面） |
| §6 层级叫法、「模块文档」页签、`[[ ]]` 链接、结构树页签链接 | Task 8（链接卡）、Task 10（页签与结构树）、Task 11、Task 12 |
| §7 单元测试、端到端测试、真实数据复验 | 见「P2-B2 完成标准」；Task 14、Task 15 |

- 占位检查：计划中没有「待定」「以后实现」或只描述不给代码的步骤；`2026-10-XX` 是协作日志条目的日期，执行时按实际日期填写，与 P2-B1 计划的写法一致。
- 名称一致性：`featureSections`、`featureSectionBody`、`applyFeatureSection`、`renameFeatureHeading`、`hasTopHeadings`、`prdSectionKeys`、`sourceSectionText`、`DocumentRow`、`assertWritable`、`writeRevision`、`documentMarkdownTx`、`commitSystemRevisionTx`、`findModuleDocument`、`ensureModuleDocumentTx`、`createModuleDocument`、`listModuleDocuments`、`syncFeatureRenameTx`、`loadTree`、`assertChangeDocument`、`assertDeclarationsEditable`、`affectedNodesInTx`、`listAffectedNodes`、`addAffectedNode`、`updateAffectedNode`、`removeAffectedNode`、`insertStructureNodeTx`、`createNodeForDocument`、`getMergePlan`、`applyMerge`、`skipMerge`、`reopenMerge`、`listMergeRecords` 在定义与使用处一致；web 的 `documentView`、`moduleDocsHref`、`CHANGE_TYPE_LABEL`、`MERGE_STATUS_LABEL`、`featureOptions`、`moduleOptions`、`domainOptions`、`useModuleDocuments`、`useAffectedNodes`、`useMergePlan`、`useMergeRecords` 同样一致；e2e helper `createNode`（Task 10）与 `launchDocument`（Task 12）在使用它们的任务之前或之内定义。
- 依赖顺序：Task 4 依赖 Task 3 的 `commitSystemRevisionTx`；Task 6 修改 Task 5 新建的 `affected.ts`；Task 7 依赖 Task 3、5；Task 8 修改 Task 7 新建的 `merge.ts` 的 import；Task 11 的 `CHANGE_TYPE_LABEL` 被 Task 12、13 使用；Task 13 的 e2e 用到 Task 10、12 的 helper。
