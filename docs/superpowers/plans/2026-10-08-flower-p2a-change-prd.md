# Flower P2-A 变更 PRD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 变更 PRD 可以写在 Flower 里（BlockNote 编辑、自动保存、修订、按小节对比、恢复、划词评论、模板与必填小节、图片附件），也可以只是外部文档的链接（完整的状态流转、覆盖需求、会签、「PRD」检查项联动、评审表、「等我签字」、整篇评论），外部 PRD 可以通过粘贴、Markdown、Word 转为 Flower 文档；旧 prd 系统的页面、修订、附件、评论和 123plane / push 的外部链接迁入 pan123。

**Architecture:** 新增 `documents`、`document_revisions`、`document_templates`、`attachments` 四张租户表（`products.document_seq` 分配编号，`requirements.change_document_id` 加外键）。业务逻辑在 `packages/core/src/documents/`：纯函数（小节切分、对比、纯文本、文本引用定位、网址规范化、必填小节）放在浏览器安全的 `markdown.ts`，以 `@flower/core/markdown` 导出；服务函数按 `(db, actor, input)` 写在 `documents.ts`、`coverage.ts`、`checks.ts`、`comments.ts`、`templates.ts`、`attachments.ts`；图片存储走 `storage.ts` 的本地卷适配器。「PRD」检查项改为「作用于需求、`auto: 'prd_status'`」：PRD 状态变化和覆盖变化时在同一事务里写受影响需求的检查项结果；scope = document 的检查项结果挂在 PRD 上，覆盖的需求在流转条件、详情、等我签字中共享。接口在 `apps/web/src/server/routes/documents.ts`（上传用 multipart）。页面新增文档列表、文档详情（BlockNote 编辑器以 `next/dynamic` 只在客户端加载）、修订与对比、划词评论、导入对话框（mammoth 把 .docx 转成 HTML，BlockNote 把 HTML / Markdown 统一转成 Markdown）、文档模板设置，需求详情显示所挂的 PRD。迁移新增 `plan-documents.ts`（prd 页面）与 `plan-external.ts`（外部链接）。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui（Radix）、BlockNote 0.55（`@blocknote/core`、`@blocknote/react`、`@blocknote/shadcn`）、mammoth 1.13、jsdiff（`diff` 9）、Vitest、Playwright（新增开发依赖 `docx` 用于生成测试用 Word 文件）。

**Spec:** `docs/superpowers/specs/2026-10-08-flower-p2a-change-prd-design.md`（用户 2026-10-08 确认，本计划的约束来源），上位文档 `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§3.1 检查项、§4.5 评论、§5 文档、§7 迁移）。逐条决定见下方「设计决定」。

## Global Constraints

- 生产数据副本、对照表、对账报告、导出的附件文件（`.local-data/prd_uploads/`）、性能测量用的旧 PRD 正文（`.local-data/perf/`）只放在 `.local-data/`（已在 `.git/info/exclude` 忽略），任何含员工姓名、邮箱或文档正文的文件不得提交。测试夹具、端到端用例、文档示例只用虚构姓名、`@example.com` 邮箱和虚构正文；验证记录只写数量与耗时，不写姓名、邮箱、标题或正文。
- 迁移写库只针对本地开发库的组织 pan123。`--replace` 会删除 pan123 的全部数据，只能在 Task 17 的用户检查点得到用户明确同意之后执行。从服务器 `prd_uploads` 卷导出附件文件是只读操作，但仍需单独征得用户同意（Task 17 STOP 步骤），执行代理不得自行连接服务器。
- 不动服务器 47.115.229.192 上的任何东西；不改 `prd_src` 库和 `.local-data/` 里的 sqlite 文件（只读查询）。
- 新增租户表必须带 `org_id`，并在新的自定义迁移 `0010_p2a_rls.sql` 里开启 RLS（参照 `0006_p1a_rls.sql`）。执行中如发现还要改表结构，停下来报告。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`（实体 id 作为第三个参数的现有写法照旧），一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写；写操作同事务调用 `recordEvent`，修改类事件 payload 带 `changes: [{field, old, new}]`。`withSystem` 只用于登录、成员关系查找、Token 认证、邀请接受。
- 权限按设计 §4：新建、编辑正文、改状态、改覆盖需求、恢复版本、导入、上传图片——产品编辑及以上（`requireProductRole(tx, actor, productId, 'editor')`）；评论、解决评论——产品只读成员及以上，并显式拒绝只读 Token；组织级模板——组织管理员（`requireOrgAdmin`）；产品级模板——产品管理员；只读 Token 一律不能写（`capByScope` 降为 viewer，评论另行显式拒绝）。
- 写入负责人时用 `assertAssignableMember`，只在值变化时校验。
- 同时锁 PRD 和需求时，先锁 PRD（`documents` 行 `for update`），再按 id 升序锁需求。
- 面向用户的文案与错误信息用中文，错误通过 `AppError(code, message, details?)` 抛出。
- `apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`、本计划新增的 `@flower/core/markdown`。纯逻辑放 `apps/web/src/features/**/model.ts` 并写 Vitest 单测。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`。用渲染期间调整（参照 `apps/web/src/app/(app)/[org]/settings/general/page.tsx`），或用 `key` 让组件在来源变化时重新挂载；能直接从地址栏或服务端数据推导的值不存进组件状态。编辑器只在挂载时读取初始正文（`useState(() => …)`），外部要求重新加载时由父组件换 `key`。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框和内联表单用 `silentError: true` + `<FormError error={mutation.error} />`。不留未处理的 `mutateAsync` 拒绝。
- 页面加载失败统一用 `components/load-error.tsx` 的 `LoadError` / `QueryError`。
- 复用已有的共享件：`QueryError`、`FormError`、`PageHeader`、`EmptyState`、`MemberPicker`（成员选择的唯一实现，选项用 `pickerOptions(activePeople(members), current)`）、`components/check-items.tsx`（本计划把它改为按检查项列表和接口前缀工作，需求与 PRD 共用）；e2e `helpers.ts`（`ok`、`json`、`createProduct`、`createRequirement`、`createMember`、`setupInstance`、`login`、`acceptInvite`、`FAIL_500`、`expectNoPageOverflow`，本计划再加 `createDocument`、`readToken`、`applyPrdWorkflow`）。不在文件之间复制逻辑块。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0`。
- 视觉沿用 P0-B：表格行高 40px 且单行（`h-10`），隔行底色 `even:bg-zebra`、编号与日期用等宽字体（`font-mono`）、卡片圆角 6px、按钮与输入框圆角 4px、页面标题 20px。
- 布局：页面本身不出现横向滚动；新页面有 Playwright 守护用例，在 1440 与 760 两个宽度下断言（`expectNoPageOverflow`、`toBeInViewport`）。
- 端到端测试：每个 spec 自己在 `beforeEach` 或用例开头调用 `resetDatabase()`；不为迁就定位器修改应用或共享组件代码；Radix 弹出内容用 `page` 定位；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染；断言由 5xx 触发的「重试」时加 `{ timeout: 15_000 }`。改动共享组件或页面结构的任务，要在同一任务里改好受影响的现有 spec，不削弱原有断言。端到端占用 3100 端口，不要与 `pnpm dev` 同时运行。
- `pnpm test` 和端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；之后要跑 `pnpm dev`、迁移导入或 `rejoin`，先执行 `pnpm db:migrate`。
- 每个 commit message 末尾加一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）；实际执行提交的若不是 Claude Opus 5.5，把这一行换成实际模型的名字。

## 设计决定

数量均为 2026-10-08 只读查询所得：prd 系统用 `docker exec flower-postgres-1 psql -U flower_admin -d prd_src`，123plane / push 用 `sqlite3 -readonly .local-data/{123plane,push}.db`，外部链接数是按下表规则规范化、并按迁移脚本的需求配对（plane_id，其次唯一标题）模拟后的结果。

| 项 | 决定 | 依据 |
|---|---|---|
| 大文档性能基线 | Task 1 先测再定。用合成文档（20k / 40k / 80k / 160k 字符，结构按最大旧 PRD 的比例：每 270 字一个小标题、表格行占三分之一）和最大旧 PRD（去掉内嵌图片前后各测一次），在 1440×900 的 Chromium 里测两项：**加载**＝从挂载编辑器到最后一个块渲染完成，5 次取中位数；**输入延迟**＝在文末连续输入 30 个字符，每次从 `keydown` 到下一帧，取 p95。阈值：加载 ≤ 1500 ms，输入 p95 ≤ 50 ms。**判定**：80k 合成文档两项都达标 → 整篇一个编辑器（默认实现）；80k 不达标 → 按小节懒加载（`##` 切分，默认折叠，展开时才挂载该小节的编辑器，未展开小节的 Markdown 原样保留），对超过「最大达标档位」字符数的文档启用；20k 也不达标 → 停下来报告，不继续 Task 2。测得的数字与结论由 Task 1 写回本行下方的「Task 1 结果」 | 设计 §2「大文档：先测再定」、§7 第一项 |
| Task 1 结果 | 合成 20k / 40k / 80k / 160k：加载 220 / 417 / 632 / 1277 ms，输入 p95 15 / 12 / 18 / 27 ms；最大旧 PRD（含内嵌图片 785,745 字符）加载 252 ms、输入 p95 18 ms，去掉内嵌图片后（15,903 字符）309 ms / 17 ms。结论：整篇一个编辑器（80k 与 160k 两项均达标，未触发懒加载分支） | 2026-10-08 本机 Chromium 实测，数据见 apps/web/test-results/editor-perf.json（不提交） |
| 最大旧 PRD 的实际规模 | 最大页面 785,744 字符（约 0.8 MB），其中约 77 万字符是 6 张 base64 内嵌图片；去掉内嵌图片后正文 15,977 字符（汉字 5,402）。纯文字最长的页面 20,804 字符（汉字 11,993，453 行）。11 份页面正文都不到 2.1 万字符 | 只读查询 `prd_src.pages`。设计写的「约 8 万字以上」与数据不符（见文末「与代码或数据的冲突」），基线因此用合成文档覆盖 8 万字 |
| 内嵌图片 | 正文不保存 `data:` 图片：保存接口拒绝含 `](data:` 的 Markdown；编辑器粘贴图片走上传；导入与迁移把 `data:` 图片抽成附件、替换为附件网址 | 内嵌图片让最大页面膨胀 49 倍，且每个修订都复制一份（该页面 42 个修订里各有 6 张） |
| 文档编号显示格式 | `{产品key}-PRD-{n}`，例 `PAN-PRD-12`。`n` 由 `products.document_seq` 以 `update … returning` 分配。地址栏 `/[org]/documents/PAN-PRD-12` | 需求编号是 `PAN-12`，加上 `PRD` 段后两类编号不会冲突，多个产品时也不歧义；上位文档 §6.4 的 `[[PRD-12]]` 写法在 P2-B 实现双链时按此格式解析 |
| 状态流转 | draft → review / discarded；review → draft / approved / discarded；approved → review / launched / discarded；discarded → draft；launched、merged 没有可去的状态（merged 属于 P2-B）。全部要求产品编辑及以上；draft → review 时 Flower 内文档检查模板必填小节 | 设计 §3 状态列表；「合入」在 P2-B |
| 「PRD」检查项的配置方式 | 流程里的「PRD」检查项为**作用于需求的普通检查项 + `auto: 'prd_status'`**（每个流程最多一个）。现有校验「自动同步必须作用于 PRD」改为「必须作用于需求且为普通检查项」，流程编辑页的勾选框跟着移到「作用于需求」下。结果写在需求上（`target_type = requirement`）：被 PRD 覆盖时由系统按下行映射写入、不能手改；没挂 PRD 时照旧手工维护；移出覆盖后保留当时的值、解除锁定，恢复手工维护 | 设计 §2「覆盖的每条需求同步……没挂 PRD 的需求照旧手工维护」只能在需求上存结果；现有代码 `workflow-schema.ts:89` 要求 scope = document，与之冲突（见文末）。设计 §3 写「移出覆盖时更新检查项结果」：移出后结果不再由 PRD 决定，清空会丢掉已有进度，所以只解除锁定、不改值 |
| 「PRD」检查项映射 | draft、review → in_progress；approved、launched、merged → passed；discarded → not_needed（`prdCheckState`）。PRD 状态变化、需求加入覆盖时写入并记 `check_item.updated`（payload 带 `auto: true`、`documentId`） | 设计 §3 |
| 评审是否已开始 | `reviewStarted` 不计 `auto` 检查项 | 需求挂上 PRD 后「PRD」项自动变为进行中，不应因此把会签推给签字人 |
| PRD 上的会签 | scope = document 的检查项结果存 `target_type = document`；签字、代签、普通检查项改状态的逻辑从 `transitions.ts` 抽到 `requirements/check-writes.ts`，需求与 PRD 共用。需求的流转条件、加入迭代准入、详情里的检查项状态合并其所挂 PRD 的 document 结果（`requirementCheckStates`）。「等我签字」与评审表只把**处于 review 状态**的 PRD 当作评审已开始；PRD 上没有按职能分配，职能标签规则推给全部持有者 | 设计 §2「scope = document 的结果挂在 PRD 上，覆盖的需求共享」、§2 外部 PRD 有「评审表、等我签字」 |
| 外部 PRD 网址规范化 | 去首尾空白；只接受 `http(s)://` 开头且不含空白的网址，否则报「不是有效的网址」；去重键（`external_url_key`）：协议统一为 `https`、主机名小写、去掉默认端口、去掉 `#` 片段、去掉路径末尾斜杠、去掉参数 `utm_*`、`spm`、`from`、`share_source`、`scode`（企业微信文档的分享码，同一文档不同人分享各不相同），figma 再去 `t`，其余参数按名排序保留。`external_url` 保存原文（保留 `scode`，打开时仍可用分享码访问）。唯一索引 `(product_id, external_url_key) where deleted_at is null`，转为 Flower 文档后链接保留，唯一性仍然生效 | 设计 §3「去掉追踪参数和末尾斜杠」。实测：288 个企业微信链接全部带 `scode`；123plane 164 个不同原文规范化后为 157 个 |
| 外部平台识别 | 按主机名：`doc.weixin.qq.com`、`drive.weixin.qq.com` → wecom；`docs.qq.com` → tencent_docs；`*.feishu.cn`、`*.larksuite.com`、`*.larkoffice.com` → feishu；`notion.so`、`*.notion.so`、`*.notion.site` → notion；`yuque.com`、`*.yuque.com` → yuque；`docs.google.com` → google_docs；其余 → other | 设计 §3 取值。实测 192 份中企业微信 187、语雀 1、腾讯文档 1、其他 3（含 1 个 figma 链接） |
| 外部 PRD 迁移的状态推导 | 取所挂需求在 123plane 的 `prd_status`：approved → approved，submitted → review，in-progress、not-started → draft，not-needed 与 push 独有需求不参与；多条需求时取最靠后的状态（approved > review > draft），都不参与时为 draft；结果为 approved 且所挂需求全部处于「已上线」时为 launched。所挂需求的「PRD」检查项按上面的映射改写，改写前后不同的逐条写入对账报告 | 设计 §6「规则在计划中确定，并写进对账报告」。同一份 PRD 的审批是文档属性，需求上的旧状态更可能是没跟着更新。模拟结果：192 份中 launched 78、draft 78、approved 20、review 16；242 条需求中约 100 条「PRD」检查项会变（主要是有链接但标「未开始」的 44 条变为进行中） |
| 外部链接迁移规则 | 一条需求：123plane `prd_link` 优先，push `prd_url` 只在 123plane 没有时使用，两边规范化后不同的写入报告；不是网址的值（push 7 个，实为需求标题等文字）不建 PRD、写入报告；已被 push 内合并的需求不导入，它的链接只在其他需求也用到时才建；需求已挂 prd 系统的 Flower 内 PRD 时，外部链接写入报告、不挂。每个去重键一份外部 PRD，标题取所挂编号最小的需求标题，负责人取该需求负责人，创建时间取所挂需求中最早的 | 设计 §6。模拟：242 条需求有链接，192 份外部 PRD，两边不一致 6 条，被多条需求共用的 27 份（最多 13 条） |
| prd 系统页面迁移范围 | 只导入 11 份未删除页面及其下的修订（104）、附件（98）、评论（3）和 1 条需求关联；已删除页面（7 份）及其下的 10 条修订、1 个附件、3 条评论计入对账报告「跳过」 | 设计 §6 写 114 / 99 / 6，是包括已删除页面在内的总数（见文末冲突） |
| prd 页面状态与修订 | `prd_meta.status`：draft → draft、review → review、approved → approved、in_dev → approved、launched → launched，其他值报问题。修订按旧 `version` 升序重新编号为 1…k（旧版本号不连续，最大 423），摘要取 `diff_summary`；页面当前正文与最后一个修订不同时再加一个「迁移时的当前内容」修订。负责人取 `prd_meta.ownerUserId`，没有时取创建人 | 设计 §6 |
| 旧附件与图片引用 | `/api/files/{storage_key}` 改写为 `/api/v1/orgs/{org}/attachments/{id}`；6 张内嵌图片抽成附件（同一页面按内容 SHA-1 去重）；企业微信 CDN 外链图片（10 处）与相对路径图片（6 处，旧导入时已失效）原样保留并计入报告。导入时附件文件不存在的不阻止写入，报告「附件文件缺失 N 个」，之后补拷文件即可显示 | 实测 73 处 `/api/files/` 引用；文件导出是 Task 17 的单独确认步骤 |
| 旧评论 | `anchor = null`、`anchor_state = unanchored`，保留回复关系与解决状态 | 设计 §6；旧锚点是 BlockNote 块 id，新正文里不存在 |
| 图片上限 | 单张 ≤ 10 MB；只收 PNG、JPEG、GIF、WebP，按文件头字节判断类型，不信任客户端声明；不收 SVG。返回时 `Content-Type` 取入库类型，加 `X-Content-Type-Options: nosniff` 与 `Content-Disposition: inline` | 旧系统上限 5 MB，实测最大 1.7 MB；截图粘贴常见 3–8 MB。SVG 可携带脚本 |
| 存储 | `FLOWER_STORAGE_DIR`（缺省为进程工作目录下的 `.flower-storage`；docker 镜像为 `/app/data/storage`，挂卷 `flower_storage`）。键为 `{orgId}/{attachmentId}.{ext}` | 设计 §3「存储适配器先实现本地卷」 |
| 修订合并 | 同一作者、距该作者上一次保存不到 5 分钟、且上一条修订没有摘要（不是恢复或转换产生的；迁移的修订时间都早于 5 分钟，不会被合并）时，覆盖上一条修订（`document_revisions.updated_at` 记最后一次保存时间）；否则新建。每次保存 `documents.version` 都加 1，供乐观锁比较 | 设计 §2 |
| 乐观锁 | 保存、恢复、转换都带 `baseVersion`；与当前 `version` 不同返回 409「文档已被其他人修改，请重新加载后再编辑」，`details.version` 为当前版本。页面显示提示条与「重新加载」按钮，不自动覆盖 | 设计 §5 |
| 对比粒度 | 按 1–3 级标题切分小节（代码块内的 `#` 不算），小节键为从顶层到本节的标题路径，同名小节按出现次序加 `#2`、`#3`；两版按键配对，返回新增、删除、修改三类；修改的小节内用 jsdiff `diffLines` 给出逐行增删。标题变化单独返回 | 设计 §3「按小节（标题层级）切分，逐段计算差异」 |
| 文本引用定位 | 自行实现 W3C TextQuoteSelector 的精确匹配：对正文按小节取纯文本（去 Markdown 语法、去全部空白），在各小节中找 `quote` 的全部出现，按与 `prefix` 的公共后缀长度 + 与 `suffix` 的公共前缀长度打分取最高；找不到为 stale，重新找到时恢复 ok。新建评论时找不到所选文字报「所选文字在当前版本中找不到，请刷新后重新选择」 | 设计 §2「原文改动后评论标为已失效」要求精确匹配；`@apache-annotator/dom`（0.2.0，2022 年后未更新）只做 DOM 定位，`diff-match-patch-es` 的模糊匹配会把评论挪到改过的文字上，与「已失效」语义相反 |
| docx → Markdown | 浏览器端：`mammoth`（1.13.0，2026-09 更新，BSD-2）把 .docx 转成 HTML（图片内嵌为 `data:`），再由 BlockNote `tryParseHTMLToBlocks` + `blocksToMarkdownLossy` 转成 Markdown；粘贴走同一条 HTML 路径，.md 直接读文本。随后统一抽出 `data:` 图片上传为附件。远程图片网址不抓取，保留原链接并提示数量 | 三种导入共用一条管线；服务端不需要解析 Word。设计 §2「不自动抓取外部平台内容」 |
| 对比算法库 | `diff`（jsdiff 9.0.0，2026-04 更新，BSD-3，自带类型，可在浏览器与 Node 使用） | 维护活跃，`diffLines` 正好对应「小节内逐行」 |
| 编辑器 | `@blocknote/core`、`@blocknote/react`、`@blocknote/shadcn` 0.55.0（2026-09 更新，MPL-2.0），中文词典 `zh`。用 shadcn 版本而不是 mantine 版本，避免引入第二套组件库样式 | 上位文档 §5.2；项目已用 shadcn/ui 与 Tailwind 4 |
| 模板 | 组织级模板 + 产品级覆盖（同名的产品模板取代组织模板）。预置模板「变更 PRD（预置）」与旧 prd 模板一致，小节：变更记录（选填）、1. 背景介绍（必填）、2. 产品概述（选填）、3. 需求说明（必填）。新组织在 `seedOrgDefaults` 里创建；P2-A 之前已有的组织在「文档模板」设置页点「添加预置模板」。占位符 `{{date}}`（组织时区当天）、`{{author}}`（操作者显示名） | 设计 §2、§5 |
| 必填小节校验 | 以标题去掉编号与空白后相等判断小节存在；小节内容（含下级小节）去掉与模板正文完全相同的行后仍有文字才算已填。缺少时报「以下必填小节未填写：…」，`details.missing` 列出 | 只看标题会让原样保留模板占位文字的 PRD 通过 |
| 导入入口 | 外部 PRD 详情的「转为 Flower 文档」与新建对话框的「导入」两处；新建导入 = 先建空白 Flower 文档、上传图片、再保存正文 | 设计 §2、§5 |
| 删除 PRD | 不提供；不用的 PRD 改为「已废弃」 | 设计未要求删除；废弃保留审计链与需求上的历史 |
| 留给 P2-B | 模块文档、影响声明、人工合入（含 merged 状态的流转）、`[[双链]]` 与反向链接；编辑器内高亮评论锚点；非图片附件（PDF 等）；PRD 的「未读评论」进工作台；外部平台内容自动抓取（需要各平台授权） | 设计 §1；后四项是本计划的最小实现边界 |

## 文件结构

```
packages/core/
  package.json                       # exports ./markdown；依赖 diff（Task 3）
  src/db/schema.ts                   # 四张新表、products.document_seq、requirements.change_document_id 外键（Task 2）
  migrations/0009_*.sql  0010_p2a_rls.sql                     # Task 2
  src/documents/constants.ts         # 状态、平台、快照与锚点类型（Task 2）
  src/documents/markdown.ts          # 纯函数，浏览器安全（Task 3）
  src/documents/templates.ts  src/storage.ts  src/documents/attachments.ts   # 模板、本地卷、图片（Task 4）
  src/documents/documents.ts         # 新建、列表、详情、保存、修订、对比、恢复、流转、转换（Task 5；Task 6、7、8 修改）
  src/documents/comments.ts          # 文档评论与重新定位（Task 6）
  src/documents/coverage.ts          # 覆盖需求与「PRD」检查项联动（Task 7）
  src/documents/checks.ts            # PRD 上的检查项、PRD 评审表（Task 8）
  src/requirements/check-views.ts  check-writes.ts            # 检查项视图与写入的共用部分（Task 8）
  src/requirements/{transitions,detail,workflow-runtime}.ts  src/iterations/membership.ts  # Task 7、8
  src/definitions/workflow-schema.ts  src/definitions/defaults.ts                         # Task 7、4
  src/reviews/snapshot.ts  src/workbench/workbench.ts         # Task 8
  src/config.ts  src/index.ts                                 # Task 9、各任务
  test/p2a-schema.test.ts  markdown.test.ts  templates-attachments.test.ts  documents.test.ts
  test/document-comments.test.ts  document-coverage.test.ts  document-checks.test.ts  factories.ts   # Task 2–8
apps/web/
  package.json                       # BlockNote（Task 1）、mammoth 与 docx（Task 13）
  playwright.config.ts               # FLOWER_STORAGE_DIR（Task 9）
  src/server/{api,runtime,http}.ts  src/server/routes/documents.ts  routes/templates.ts   # Task 9
  test/api/helpers.ts  test/api/documents.test.ts             # Task 9
  src/lib/{types,queries,api}.ts  src/lib/api.test.ts         # Task 10
  src/features/shell/nav.ts          # Task 10、14
  src/features/documents/model.ts  model.test.ts              # Task 10–14
  src/features/documents/editor/prd-editor.tsx  body-editor.tsx   # Task 1（懒加载时另有 sections.ts、sectioned-editor.tsx）
  src/features/documents/editor/selection.ts  src/features/documents/import.ts            # Task 12、13
  src/features/workbench/model.ts    # Task 14
  src/app/dev/editor-bench/{page,bench-loader,bench}.tsx      # Task 1（开发环境专用）
  src/components/check-items.tsx     # 改为通用（Task 11）
  src/components/document-status.tsx # Task 10
  src/components/template-editor.tsx # Task 14
  src/app/(app)/[org]/documents/page.tsx  create-dialog.tsx  import-dialog.tsx            # Task 10、13
  src/app/(app)/[org]/documents/[key]/page.tsx  editor-pane.tsx  external-card.tsx  side-panel.tsx  # Task 11
  src/app/(app)/[org]/documents/[key]/revisions.tsx  comments.tsx                         # Task 12
  src/app/(app)/[org]/settings/templates/page.tsx  settings/products/[productId]/page.tsx # Task 14
  src/app/(app)/[org]/requirements/[key]/prd-card.tsx  page.tsx                           # Task 11、14
  src/app/(app)/[org]/reviews/page.tsx  reviews/document-reviews.tsx  src/app/(app)/[org]/page.tsx   # Task 8、11、14
  e2e/helpers.ts  e2e/fixtures/large-prd.ts  e2e/editor-perf.spec.ts                      # Task 1、10
  e2e/documents.spec.ts  documents-editor.spec.ts  documents-revisions.spec.ts  documents-import.spec.ts
  e2e/documents-prd-flow.spec.ts  documents-permissions.spec.ts                           # Task 10–14
  e2e/auth.spec.ts                   # 导航不再有「P2」标签（Task 10）
packages/migrate/
  src/legacy-types.ts  src/load.ts   # prd 页面、修订、附件、评论；push prd_url（Task 15）
  src/plan-types.ts  src/plan.ts  src/plan-requirements.ts  src/write.ts  src/report.ts  src/cli.ts   # Task 15、16
  src/plan-documents.ts              # prd 页面（Task 15）
  src/plan-external.ts               # 外部链接（Task 16）
  src/workflow-v1.ts                 # 「PRD」检查项 auto（Task 16）
  test/fixtures.ts  test/plan-documents.test.ts  test/plan-external.test.ts  test/write.test.ts
Dockerfile  docker-compose.yml  .env.example  .gitignore  scripts/smoke.sh   # 存储目录（Task 4、9）
CLAUDE.md                            # 迁移命令新参数（Task 15）、存储目录（Task 18）
docs/superpowers/specs/2026-09-28-flower-data-model-design.md # §1 文档编号（Task 2）、§3.1 auto（Task 7）、§7.2 PRD（Task 16）
docs/p2a-validation.md  docs/handoff.md  docs/agent-log.md    # Task 18
```

---
### Task 1: BlockNote 大文档性能基线（先测再定）与正文编辑器组件

**Files:**
- Modify: `apps/web/package.json`（`@blocknote/core`、`@blocknote/react`、`@blocknote/shadcn` 0.55.0）
- Modify: `apps/web/src/app/globals.css`（让 Tailwind 扫描 BlockNote 的 shadcn 组件）
- Create: `apps/web/src/features/documents/editor/prd-editor.tsx`（单个 BlockNote 编辑器，Markdown 进出）
- Create: `apps/web/src/features/documents/editor/body-editor.tsx`（正文编辑器入口；懒加载时在这里分流）
- Create: `apps/web/src/app/dev/editor-bench/page.tsx`、`bench-loader.tsx`、`bench.tsx`（开发环境专用的测量页，生产环境 404）
- Create: `apps/web/e2e/fixtures/large-prd.ts`（合成大文档，全部为虚构文字）
- Create: `apps/web/e2e/editor-perf.spec.ts`（测量与守护）
- Modify: `docs/superpowers/plans/2026-10-08-flower-p2a-change-prd.md`（「设计决定」表的「Task 1 结果」行）
- 仅在 80k 不达标时：Create `apps/web/src/features/documents/editor/sections.ts`、`sections.test.ts`、`sectioned-editor.tsx`，Modify `body-editor.tsx`

**Interfaces:**
- Produces:
  - `prd-editor.tsx`：`type PrdEditorHandle = { getMarkdown: () => string }`；`type PrdEditorProps = { initialMarkdown: string; editable: boolean; onDirty?: () => void; uploadImage?: (file: File) => Promise<string>; ref?: Ref<PrdEditorHandle> }`；`PrdEditor(props)`。只在挂载时读取 `initialMarkdown`。
  - `body-editor.tsx`：`DocumentBodyEditor(props: PrdEditorProps)`——Task 11 只用这个入口，不直接用 `PrdEditor`。
  - 测量页 `/dev/editor-bench`：读取 `window.__BENCH_MARKDOWN__`，挂载完成后写 `window.__BENCH__ = { mountMs }` 并给 `body` 加 `data-bench-ready="1"`。

- [ ] **Step 1: 安装 BlockNote**

Run: `pnpm --filter @flower/web add @blocknote/core@0.55.0 @blocknote/react@0.55.0 @blocknote/shadcn@0.55.0`
Expected: `apps/web/package.json` 的 dependencies 出现三项，`pnpm-lock.yaml` 更新。

在 `apps/web/src/app/globals.css` 的 `@import "tailwindcss";` 一行之后加入（BlockNote 的 shadcn 组件用 Tailwind 类名，Tailwind 4 默认不扫描 node_modules）：

```css
@source "../../node_modules/@blocknote/shadcn";
```

- [ ] **Step 2: 编辑器组件**

新建 `apps/web/src/features/documents/editor/prd-editor.tsx`：

```tsx
'use client';

import '@blocknote/shadcn/style.css';
import { BlockNoteEditor } from '@blocknote/core';
import { zh } from '@blocknote/core/locales';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useTheme } from 'next-themes';
import { type Ref, useImperativeHandle, useState } from 'react';

export type PrdEditorHandle = { getMarkdown: () => string };
export type PrdEditorProps = {
  initialMarkdown: string;
  editable: boolean;
  onDirty?: () => void;
  uploadImage?: (file: File) => Promise<string>;
  ref?: Ref<PrdEditorHandle>;
};

/** Markdown → 块：用一个不挂载的编辑器实例解析，只在首次渲染时调用。空正文返回 undefined（BlockNote 要求初始内容非空）。 */
function parseMarkdown(markdown: string) {
  if (!markdown.trim()) return undefined;
  const blocks = BlockNoteEditor.create().tryParseMarkdownToBlocks(markdown);
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * 一篇 PRD 正文的 BlockNote 编辑器。Markdown 是唯一数据源：挂载时解析一次，之后由父组件
 * 通过 ref 的 getMarkdown() 在需要保存时序列化；正文被外部替换（冲突后重新加载、恢复版本）时由父组件换 key 重新挂载。
 */
export function PrdEditor({ initialMarkdown, editable, onDirty, uploadImage, ref }: PrdEditorProps) {
  const [initialContent] = useState(() => parseMarkdown(initialMarkdown));
  const editor = useCreateBlockNote({ initialContent, dictionary: zh, uploadFile: uploadImage });
  useImperativeHandle(ref, () => ({ getMarkdown: () => editor.blocksToMarkdownLossy(editor.document) }), [editor]);
  const { resolvedTheme } = useTheme();
  return <BlockNoteView editor={editor} editable={editable} onChange={() => onDirty?.()} theme={resolvedTheme === 'dark' ? 'dark' : 'light'} />;
}
```

新建 `apps/web/src/features/documents/editor/body-editor.tsx`：

```tsx
'use client';

import { PrdEditor, type PrdEditorProps } from './prd-editor';

/** PRD 正文编辑器的入口。是否对大文档按小节懒加载由 Task 1 的基线决定（见计划「设计决定」）。 */
export function DocumentBodyEditor(props: PrdEditorProps) {
  return <PrdEditor {...props} />;
}
```

BlockNote 文档（v0.54）给出的签名是同步的：`tryParseMarkdownToBlocks(markdown): Block[]`、`blocksToMarkdownLossy(blocks?): string`。如果 Step 6 的类型检查显示 0.55 改成了返回 Promise，停下来报告，不要改用 `useEffect` 里 `replaceBlocks` 的写法。

- [ ] **Step 3: 开发环境测量页**

新建 `apps/web/src/app/dev/editor-bench/page.tsx`：

```tsx
import { notFound } from 'next/navigation';
import { BenchLoader } from './bench-loader';

/** 只在开发环境使用的编辑器性能测量页（Task 1 基线与 e2e/editor-perf.spec.ts）。 */
export default function EditorBenchPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <BenchLoader />;
}
```

新建 `apps/web/src/app/dev/editor-bench/bench-loader.tsx`：

```tsx
'use client';

import dynamic from 'next/dynamic';

const Bench = dynamic(() => import('./bench').then((m) => m.Bench), { ssr: false });

export function BenchLoader() {
  return <Bench />;
}
```

新建 `apps/web/src/app/dev/editor-bench/bench.tsx`：

```tsx
'use client';

import { useEffect, useState } from 'react';
import { DocumentBodyEditor } from '@/features/documents/editor/body-editor';

declare global {
  interface Window {
    __BENCH_MARKDOWN__?: string;
    __BENCH__?: { mountMs: number };
  }
}

export function Bench() {
  const [start] = useState(() => performance.now());
  const [markdown] = useState(() => window.__BENCH_MARKDOWN__ ?? '');
  useEffect(() => {
    // 子组件（编辑器）的 effect 先于这里执行；再等一帧，记录到内容实际绘制为止
    requestAnimationFrame(() => {
      window.__BENCH__ = { mountMs: performance.now() - start };
      document.body.dataset.benchReady = '1';
    });
  }, [start]);
  return (
    <main className="mx-auto max-w-4xl p-6">
      <DocumentBodyEditor initialMarkdown={markdown} editable />
    </main>
  );
}
```

- [ ] **Step 4: 合成大文档与测量用例**

新建 `apps/web/e2e/fixtures/large-prd.ts`：

```ts
const PARA = '本节说明该功能在不同场景下的处理方式，包括入口位置、默认值、异常提示与埋点要求，全部文字均为测试用的虚构内容。';

/**
 * 合成一篇约 targetChars 字符的 PRD：结构按最大旧 PRD 的比例（约每 270 字一个小标题，表格行约占三分之一），
 * 只用虚构文字，可以提交。
 */
export function syntheticPrd(targetChars: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let n = 1; size < targetChars; n++) {
    const chunk = [
      `## ${n}. 功能模块 ${n}`,
      '',
      `### ${n}.1 规则说明`,
      '',
      PARA,
      '',
      `- 规则 ${n}-1：${PARA.slice(0, 30)}`,
      `- 规则 ${n}-2：${PARA.slice(10, 40)}`,
      '',
      '| 字段 | 说明 | 默认值 |',
      '|---|---|---|',
      ...Array.from({ length: 4 }, (_, i) => `| 字段${n}-${i + 1} | ${PARA.slice(0, 24)} | 无 |`),
      '',
    ].join('\n');
    parts.push(chunk);
    size += chunk.length + 1;
  }
  return parts.join('\n');
}
```

新建 `apps/web/e2e/editor-perf.spec.ts`：

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { syntheticPrd } from './fixtures/large-prd';

/** 设计决定「大文档性能基线」的阈值：加载中位数与输入延迟 p95。 */
const LOAD_MS = 1500;
const KEY_P95_MS = 50;
const SIZES = [20_000, 40_000, 80_000, 160_000];
const RUNS = 5;
const KEYS = 30;

type Row = { name: string; chars: number; loadMs: number; keyP95: number };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;

async function measure(page: Page, name: string, markdown: string): Promise<Row> {
  await page.addInitScript((md) => {
    window.__BENCH_MARKDOWN__ = md;
  }, markdown);
  const loads: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await page.goto('/dev/editor-bench');
    await page.waitForSelector('body[data-bench-ready="1"]', { timeout: 120_000 });
    loads.push(await page.evaluate(() => window.__BENCH__!.mountMs));
  }
  // 懒加载模式下先展开最后一个小节再输入
  const collapsed = page.locator('[data-section-toggle][aria-expanded="false"]');
  if ((await collapsed.count()) > 0) await collapsed.last().click();
  await page.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const w = window as unknown as { __keys: number[] };
    w.__keys = [];
    document.addEventListener(
      'keydown',
      () => {
        const t0 = performance.now();
        requestAnimationFrame(() => setTimeout(() => w.__keys.push(performance.now() - t0), 0));
      },
      true,
    );
  });
  await page.keyboard.type('测'.repeat(KEYS), { delay: 60 });
  await page.waitForTimeout(500);
  const keys = await page.evaluate(() => (window as unknown as { __keys: number[] }).__keys);
  return { name, chars: markdown.length, loadMs: Math.round(median(loads)), keyP95: Math.round(p95(keys)) };
}

test.beforeEach(async () => {
  await resetDatabase();
});

test('大文档基线：合成文档与本地旧 PRD 的加载时间、输入延迟', async ({ page }) => {
  // 跑一次要几分钟，只在显式开启时运行（Task 1 基线、Task 18 复测）；日常的全量端到端不跑
  test.skip(process.env.EDITOR_BENCH !== '1', '设置 EDITOR_BENCH=1 时运行');
  test.setTimeout(900_000);
  const rows: Row[] = [];
  for (const size of SIZES) rows.push(await measure(page, `合成 ${size}`, syntheticPrd(size)));
  // 本地真实旧 PRD 只在 .local-data/perf/ 存在时测（不提交）；用逗号分隔多个文件
  for (const file of (process.env.BENCH_FILES ?? '').split(',').filter(Boolean)) {
    if (existsSync(file)) rows.push(await measure(page, path.basename(file), readFileSync(file, 'utf8')));
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/editor-perf.json', `${JSON.stringify(rows, null, 2)}\n`);
  console.log(['| 文档 | 字符数 | 加载中位数 (ms) | 输入 p95 (ms) |', '|---|---|---|---|', ...rows.map((r) => `| ${r.name} | ${r.chars} | ${r.loadMs} | ${r.keyP95} |`)].join('\n'));
  const at80 = rows.find((r) => r.name === '合成 80000')!;
  expect(at80.loadMs, '80k 合成文档的加载中位数').toBeLessThanOrEqual(LOAD_MS);
  expect(at80.keyP95, '80k 合成文档的输入延迟 p95').toBeLessThanOrEqual(KEY_P95_MS);
});
```

- [ ] **Step 5: 导出最大旧 PRD（只读，不提交）**

```bash
mkdir -p .local-data/perf
docker exec flower-postgres-1 psql -U flower_admin -d prd_src -At -c "select markdown from pages where deleted_at is null order by char_length(markdown) desc limit 1" > .local-data/perf/largest-prd.md
perl -pe 's/!\[[^\]]*\]\(data:image\/[a-z]+;base64,[A-Za-z0-9+\/=]+\)//g' .local-data/perf/largest-prd.md > .local-data/perf/largest-prd-noimg.md
wc -m .local-data/perf/largest-prd.md .local-data/perf/largest-prd-noimg.md
```

Expected: 两个文件约 785,744 与 15,977 字符（以实际输出为准）。这两个文件含真实正文，只在本地，绝不提交。

- [ ] **Step 6: 跑基线**

Run: `pnpm --filter @flower/web typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: 通过。

Run: `EDITOR_BENCH=1 BENCH_FILES="$PWD/.local-data/perf/largest-prd.md,$PWD/.local-data/perf/largest-prd-noimg.md" pnpm --filter @flower/web e2e editor-perf.spec.ts`
Expected: 控制台打印 6 行表格，`apps/web/test-results/editor-perf.json` 写出。用例通过 = 80k 达标；失败 = 80k 不达标（这次失败是结论，不是要修的 bug）。

- [ ] **Step 7: 记录结论**

把本计划「设计决定」表「Task 1 结果」一行的右两列改为实测内容，格式：

```
| Task 1 结果 | 合成 20k / 40k / 80k / 160k：加载 a / b / c / d ms，输入 p95 e / f / g / h ms；最大旧 PRD（含内嵌图片 785,744 字符）加载 x ms、输入 p95 y ms，去掉内嵌图片后 x' / y' ms。结论：整篇一个编辑器（或：大于 N 字符的文档按小节懒加载，N = 最大达标档位） | 2026-10-0X 本机 Chromium 实测，数据见 apps/web/test-results/editor-perf.json（不提交） |
```

若 20k 也不达标：停止执行，向控制方报告数字，不做 Step 8 之后的任何任务。

- [ ] **Step 8（仅当 80k 不达标）：按小节懒加载**

新建 `apps/web/src/features/documents/editor/sections.ts`：

```ts
/** 按二级标题切分（代码块内的 # 不算）。第一段可能没有标题。各段用 '\n' 拼回去等于原文。 */
export function splitTopSections(markdown: string): Array<{ heading: string | null; markdown: string }> {
  const out: Array<{ heading: string | null; markdown: string }> = [];
  let lines: string[] = [];
  let heading: string | null = null;
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^##\s+/.test(line) ? line.replace(/^##\s+/, '').trim() : null;
    if (h !== null && (lines.length > 0 || heading !== null)) {
      out.push({ heading, markdown: lines.join('\n') });
      lines = [];
    }
    if (h !== null) heading = h;
    lines.push(line);
  }
  out.push({ heading, markdown: lines.join('\n') });
  return out;
}
```

新建 `apps/web/src/features/documents/editor/sections.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { splitTopSections } from './sections';

describe('按二级标题切分', () => {
  it('切分后拼回等于原文；代码块里的 ## 不算标题', () => {
    const md = '开头\n\n## 背景\n正文\n```\n## 不是标题\n```\n## 需求\n- a';
    const parts = splitTopSections(md);
    expect(parts.map((p) => p.heading)).toEqual([null, '背景', '需求']);
    expect(parts.map((p) => p.markdown).join('\n')).toBe(md);
  });

  it('以标题开头时没有空的开头段', () => {
    expect(splitTopSections('## 一\nx\n## 二\ny').map((p) => p.heading)).toEqual(['一', '二']);
  });
});
```

新建 `apps/web/src/features/documents/editor/sectioned-editor.tsx`：

```tsx
'use client';

import { useImperativeHandle, useRef, useState } from 'react';
import { PrdEditor, type PrdEditorHandle, type PrdEditorProps } from './prd-editor';
import { splitTopSections } from './sections';

/** 大文档：按二级标题分节，默认折叠，展开时才挂载该节的编辑器；未展开的小节保存时原样拼回。 */
export function SectionedEditor({ initialMarkdown, editable, onDirty, uploadImage, ref }: PrdEditorProps) {
  const [sections] = useState(() => splitTopSections(initialMarkdown));
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const handles = useRef(new Map<number, PrdEditorHandle>());
  useImperativeHandle(ref, () => ({ getMarkdown: () => sections.map((s, i) => handles.current.get(i)?.getMarkdown() ?? s.markdown).join('\n') }), [sections]);
  return (
    <div className="flex flex-col gap-2">
      {sections.map((s, i) => (
        <section key={i} className="rounded-md border">
          <button
            type="button"
            data-section-toggle
            aria-expanded={open.has(i)}
            disabled={open.has(i)}
            className="flex h-10 w-full items-center px-3 text-left text-sm font-medium disabled:cursor-default"
            onClick={() => setOpen((prev) => new Set(prev).add(i))}
          >
            {s.heading ?? '开头'}
          </button>
          {open.has(i) && (
            <PrdEditor
              initialMarkdown={s.markdown}
              editable={editable}
              onDirty={onDirty}
              uploadImage={uploadImage}
              ref={(h) => {
                if (h) handles.current.set(i, h);
              }}
            />
          )}
        </section>
      ))}
    </div>
  );
}
```

把 `body-editor.tsx` 整个替换为（`N` 换成 Step 7 记录的懒加载阈值）：

```tsx
'use client';

import { PrdEditor, type PrdEditorProps } from './prd-editor';
import { SectionedEditor } from './sectioned-editor';

/** 超过这个字符数的正文按小节懒加载（Task 1 实测的最大达标档位）。 */
export const LAZY_SECTION_THRESHOLD = N;

/** PRD 正文编辑器的入口：大文档按小节懒加载，其余整篇一个编辑器。 */
export function DocumentBodyEditor(props: PrdEditorProps) {
  return props.initialMarkdown.length > LAZY_SECTION_THRESHOLD ? <SectionedEditor {...props} /> : <PrdEditor {...props} />;
}
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/editor/sections.test.ts && EDITOR_BENCH=1 pnpm --filter @flower/web e2e editor-perf.spec.ts`
Expected: 单测通过；性能用例通过（懒加载模式下 80k 达标）。

- [ ] **Step 9: 提交**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/app/globals.css apps/web/src/features/documents/editor apps/web/src/app/dev apps/web/e2e/fixtures/large-prd.ts apps/web/e2e/editor-perf.spec.ts docs/superpowers/plans/2026-10-08-flower-p2a-change-prd.md
git commit -m "feat(web): PRD 正文编辑器与大文档性能基线

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: 数据模型：文档、修订、模板、附件

**Files:**
- Create: `packages/core/src/documents/constants.ts`
- Modify: `packages/core/src/db/schema.ts`（四张新表；`products.document_seq`；`requirements.change_document_id` 外键与索引）
- Create: `packages/core/migrations/0009_*.sql`（`db:generate` 生成）、`packages/core/migrations/0010_p2a_rls.sql`（`--custom` 生成后填写）
- Modify: `docs/superpowers/specs/2026-09-28-flower-data-model-design.md` §1 主键一条（文档编号）
- Test: `packages/core/test/p2a-schema.test.ts`

**Interfaces:**
- Produces（从 `@flower/core` 导出）：
  - `constants.ts`：`DOCUMENT_STATUSES = ['draft','review','approved','launched','merged','discarded'] as const`、`type DocumentStatus`、`EXTERNAL_PROVIDERS = ['wecom','feishu','tencent_docs','notion','yuque','google_docs','other'] as const`、`type ExternalProvider`、`type TemplateSection = { heading: string; required: boolean; guidance?: string }`、`type RevisionSnapshot = { title: string; markdown: string }`、`type TextAnchor = { quote: string; prefix: string; suffix: string; sectionHeading: string | null }`
  - 表对象：`documentTemplates`、`documents`、`documentRevisions`、`attachments`；`products.documentSeq`
  - 列：`documents.{id, orgId, productId, number, kind, source, title, ownerMemberId, templateId, nodeId, status, currentRevisionId, externalUrl, externalUrlKey, externalProvider, version, legacyKey, createdBy, createdAt, updatedAt, deletedAt}`；`documentRevisions.{id, orgId, documentId, version, snapshot, summary, authorMemberId, mergedFromDocumentId, createdAt, updatedAt}`；`documentTemplates.{id, orgId, productId, kind, name, body, sections, active, createdAt, updatedAt}`；`attachments.{id, orgId, targetType, targetId, storageKey, filename, mime, sizeBytes, width, height, uploaderMemberId, createdAt}`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/p2a-schema.test.ts`：

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachments, documentRevisions, documents, documentTemplates, members, organizations, products, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const memberA = newId();

const ext = (number: number, key: string) => ({
  orgId: orgA,
  productId: productA,
  number,
  source: 'external' as const,
  title: `外部 PRD ${number}`,
  externalUrl: `${key}?scode=x`,
  externalUrlKey: key,
  externalProvider: 'wecom' as const,
});

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
  await t.adminDb.insert(members).values({ id: memberA, orgId: orgA, displayName: '甲', orgRole: 'member' });
});
afterAll(() => t.cleanup());

describe('P2-A 数据模型', () => {
  it('四张新表受行级安全约束', async () => {
    const [doc] = await withOrg(t.db, orgA, (tx) => tx.insert(documents).values(ext(1, 'https://doc.weixin.qq.com/doc/a')).returning());
    await withOrg(t.db, orgA, async (tx) => {
      await tx.insert(documentRevisions).values({ orgId: orgA, documentId: doc!.id, version: 1, snapshot: { title: 't', markdown: '' } });
      await tx.insert(documentTemplates).values({ orgId: orgA, name: '模板', body: '', sections: [] });
      await tx.insert(attachments).values({ orgId: orgA, targetType: 'document', targetId: doc!.id, storageKey: `${orgA}/${newId()}.png`, filename: 'a.png', mime: 'image/png', sizeBytes: 1 });
    });
    for (const table of [documents, documentRevisions, documentTemplates, attachments]) {
      expect(await withOrg(t.db, orgA, (tx) => tx.select().from(table))).toHaveLength(1);
      expect(await withOrg(t.db, orgB, (tx) => tx.select().from(table))).toHaveLength(0);
    }
  });

  it('同一产品内编号唯一；同一规范化网址只能对应一份未删除的 PRD', async () => {
    await expect(withOrg(t.db, orgA, (tx) => tx.insert(documents).values(ext(1, 'https://doc.weixin.qq.com/doc/b')))).rejects.toThrow();
    await expect(withOrg(t.db, orgA, (tx) => tx.insert(documents).values(ext(2, 'https://doc.weixin.qq.com/doc/a')))).rejects.toThrow();
    await withOrg(t.db, orgA, (tx) => tx.update(documents).set({ deletedAt: new Date() }).where(eq(documents.number, 1)));
    await withOrg(t.db, orgA, (tx) => tx.insert(documents).values(ext(2, 'https://doc.weixin.qq.com/doc/a')));
  });

  it('外部 PRD 必须有网址且没有当前修订', async () => {
    await expect(
      withOrg(t.db, orgA, (tx) => tx.insert(documents).values({ orgId: orgA, productId: productA, number: 9, source: 'external', title: '没有网址' })),
    ).rejects.toThrow();
  });

  it('需求的 change_document_id 引用 documents', async () => {
    await expect(
      withOrg(t.db, orgA, (tx) =>
        tx.insert(requirements).values({ orgId: orgA, productId: productA, number: 1, title: '挂错', stateKey: 'backlog', changeDocumentId: newId() }),
      ),
    ).rejects.toThrow();
    const [p] = await t.adminDb.select({ seq: products.documentSeq }).from(products).where(eq(products.id, productA));
    expect(p!.seq).toBe(0);
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename in ('documents','document_revisions','document_templates','attachments')`)) as unknown as [{ n: number }];
    expect(n).toBe(4);
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/p2a-schema.test.ts`
Expected: FAIL，`documents` 等未从 schema 导出。

- [ ] **Step 2: 常量**

新建 `packages/core/src/documents/constants.ts`：

```ts
/** 变更 PRD 的状态。merged 属于 P2-B（合入），P2-A 不会进入这个状态。 */
export const DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'launched', 'merged', 'discarded'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const EXTERNAL_PROVIDERS = ['wecom', 'feishu', 'tencent_docs', 'notion', 'yuque', 'google_docs', 'other'] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

export type TemplateSection = { heading: string; required: boolean; guidance?: string };
export type RevisionSnapshot = { title: string; markdown: string };
/** W3C TextQuoteSelector：引用的原文片段与前后文，加上所在小节标题。 */
export type TextAnchor = { quote: string; prefix: string; suffix: string; sectionHeading: string | null };
```

- [ ] **Step 3: 表结构**

`packages/core/src/db/schema.ts`：

1. 第 21 行 `import type { TokenScope } from '../domain-types';` 之后加：

```ts
import { DOCUMENT_STATUSES, EXTERNAL_PROVIDERS, type RevisionSnapshot, type TemplateSection } from '../documents/constants';
```

2. `products` 表的 `requirementSeq` 一行之后加：

```ts
    documentSeq: integer('document_seq').notNull().default(0),
```

3. `requirements` 表的 `changeDocumentId: uuid('change_document_id'),` 改为：

```ts
    changeDocumentId: uuid('change_document_id').references((): AnyPgColumn => documents.id),
```

并在该表的索引数组末尾 `index('requirements_iteration').on(t.iterationId),` 之后加：

```ts
    index('requirements_change_document').on(t.changeDocumentId),
```

4. 文件末尾追加：

```ts
// ---------- P2-A：文档 ----------

export const documentTemplates = pgTable(
  'document_templates',
  {
    id: id(),
    orgId: orgRef(),
    productId: uuid('product_id').references(() => products.id),
    kind: text('kind', { enum: ['change', 'module'] }).notNull().default('change'),
    name: text('name').notNull(),
    body: text('body').notNull().default(''),
    sections: jsonb('sections').$type<TemplateSection[]>().notNull().default([]),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_templates_org_name').on(t.orgId, t.kind, t.name).where(sql`${t.productId} is null`),
    uniqueIndex('document_templates_product_name').on(t.productId, t.kind, t.name).where(sql`${t.productId} is not null`),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: id(),
    orgId: orgRef(),
    productId: productRef(),
    number: integer('number').notNull(),
    kind: text('kind', { enum: ['change', 'module'] }).notNull().default('change'),
    source: text('source', { enum: ['native', 'external'] }).notNull(),
    title: text('title').notNull(),
    ownerMemberId: memberRef('owner_member_id'),
    templateId: uuid('template_id').references(() => documentTemplates.id),
    nodeId: uuid('node_id').references(() => structureNodes.id),
    status: text('status', { enum: DOCUMENT_STATUSES }).notNull().default('draft'),
    currentRevisionId: uuid('current_revision_id').references((): AnyPgColumn => documentRevisions.id),
    externalUrl: text('external_url'),
    externalUrlKey: text('external_url_key'),
    externalProvider: text('external_provider', { enum: EXTERNAL_PROVIDERS }),
    version: integer('version').notNull().default(1),
    legacyKey: text('legacy_key'),
    createdBy: memberRef('created_by'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('documents_product_number').on(t.productId, t.number),
    uniqueIndex('documents_product_url').on(t.productId, t.externalUrlKey).where(sql`${t.externalUrlKey} is not null and ${t.deletedAt} is null`),
    index('documents_product_updated').on(t.productId, t.updatedAt.desc()),
    check('documents_external', sql`${t.source} <> 'external' or (${t.externalUrl} is not null and ${t.externalUrlKey} is not null and ${t.currentRevisionId} is null)`),
  ],
);

export const documentRevisions = pgTable(
  'document_revisions',
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid('document_id')
      .notNull()
      .references((): AnyPgColumn => documents.id),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').$type<RevisionSnapshot>().notNull(),
    summary: text('summary'),
    authorMemberId: memberRef('author_member_id'),
    mergedFromDocumentId: uuid('merged_from_document_id'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('document_revisions_doc_version').on(t.documentId, t.version)],
);

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    orgId: orgRef(),
    targetType: text('target_type', { enum: ['document'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    uploaderMemberId: memberRef('uploader_member_id'),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_target').on(t.targetType, t.targetId)],
);
```

5. `packages/core/src/index.ts` 在 `export * from './db/schema';` 之后加 `export * from './documents/constants';`。

- [ ] **Step 4: 生成迁移**

Run: `pnpm --filter @flower/core db:generate`
Expected: 生成 `packages/core/migrations/0009_<随机名>.sql`，含 4 个 `CREATE TABLE`、`products` 的 `ADD COLUMN "document_seq"`、`requirements` 的外键与索引。打开文件核对没有 `DROP`。

Run: `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p2a_rls`
Expected: 生成空的 `packages/core/migrations/0010_p2a_rls.sql`。写入：

```sql
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents', 'document_revisions', 'document_templates', 'attachments'] LOOP
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

- [ ] **Step 5: 同步上位文档**

`docs/superpowers/specs/2026-09-28-flower-data-model-design.md` §1「主键」一条中，把 `P2 文档编号届时另加列或引入计数表。` 改为 `文档编号由 \`products.document_seq\` 以同样方式分配，显示为 \`{product.key}-PRD-{n}\`（P2-A 计划「设计决定」）。`

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @flower/core test && pnpm typecheck`
Expected: 全部通过（`rls.test.ts` 如逐表检查 RLS，也覆盖新表）。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/documents/constants.ts packages/core/src/db/schema.ts packages/core/src/index.ts packages/core/migrations packages/core/test/p2a-schema.test.ts docs/superpowers/specs/2026-09-28-flower-data-model-design.md
git commit -m "feat(core): 文档、修订、模板与附件的数据模型

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: 文档纯函数：编号、状态、小节、对比、纯文本、文本引用定位、网址规范化、模板（`@flower/core/markdown`）

**Files:**
- Modify: `packages/core/package.json`（依赖 `diff@9.0.0`；exports 增加 `./markdown`）
- Create: `packages/core/src/documents/markdown.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/markdown.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `constants.ts`；`CheckState`（`requirements/labels.ts`，仅类型）
- Produces（`@flower/core/markdown` 浏览器安全；同时从 `@flower/core` 导出）：
  - 重新导出 `constants.ts` 的全部内容
  - `DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string>`（草稿、评审中、已通过、已上线、已合入、已废弃）
  - `documentDisplayKey(productKey: string, number: number): string`（`PAN-PRD-12`）；`parseDocumentKey(key: string): { productKey: string; number: number } | null`
  - `DOCUMENT_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]>`；`canTransition(from: DocumentStatus, to: DocumentStatus): boolean`
  - `prdCheckState(status: DocumentStatus): CheckState`
  - `type Section = { key: string; heading: string | null; level: number; path: string[]; markdown: string }`；`splitSections(markdown: string): Section[]`
  - `type DiffLine = { type: 'add' | 'del' | 'same'; text: string }`；`type SectionChange = { key: string; heading: string | null; change: 'added' | 'removed' | 'modified'; lines: DiffLine[] }`；`type RevisionDiff = { title: { old: string; new: string } | null; sections: SectionChange[] }`；`diffSections(oldMd: string, newMd: string): SectionChange[]`；`diffRevisionSnapshots(a: RevisionSnapshot, b: RevisionSnapshot): RevisionDiff`
  - `plainText(markdown: string): string`；`squash(s: string): string`；`locateQuote(markdown: string, a: { quote: string; prefix: string; suffix: string }): { sectionHeading: string | null } | null`
  - `detectProvider(host: string): ExternalProvider`；`normalizeExternalUrl(raw: string): { url: string; key: string; provider: ExternalProvider } | null`
  - `fillTemplate(body: string, vars: { date: string; author: string }): string`；`missingRequiredSections(markdown: string, template: { body: string; sections: TemplateSection[] }): string[]`

- [ ] **Step 1: 安装依赖并声明导出**

Run: `pnpm --filter @flower/core add diff@9.0.0`
Expected: `packages/core/package.json` dependencies 出现 `"diff": "9.0.0"`（或 `^9.0.0`）。

`packages/core/package.json` 的 `exports` 中，`"./schedule": "./src/tasks/schedule.ts",` 之后加一行：

```json
    "./markdown": "./src/documents/markdown.ts",
```

- [ ] **Step 2: 写失败的测试**

新建 `packages/core/test/markdown.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  detectProvider,
  diffRevisionSnapshots,
  diffSections,
  documentDisplayKey,
  fillTemplate,
  locateQuote,
  missingRequiredSections,
  normalizeExternalUrl,
  parseDocumentKey,
  plainText,
  prdCheckState,
  splitSections,
} from '../src/documents/markdown';

const DOC = [
  '开头说明',
  '',
  '## 1. 背景介绍',
  '',
  '### 1.1 业务背景',
  '',
  '用户反馈上传 **大文件** 太慢。',
  '',
  '```',
  '## 代码块里的标题',
  '```',
  '',
  '## 2. 需求说明',
  '',
  '| 序号 | 需求 |',
  '|---|---|',
  '| R1 | 分片上传 |',
  '',
  '## 2. 需求说明',
  '',
  '- 断点续传，见[接口文档](https://example.com/api)',
].join('\n');

describe('编号与状态', () => {
  it('显示格式与解析', () => {
    expect(documentDisplayKey('PAN', 12)).toBe('PAN-PRD-12');
    expect(parseDocumentKey(' PAN-PRD-12 ')).toEqual({ productKey: 'PAN', number: 12 });
    expect(parseDocumentKey('PAN-12')).toBeNull();
  });

  it('状态流转与「PRD」检查项映射', () => {
    expect(canTransition('draft', 'review')).toBe(true);
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('approved', 'launched')).toBe(true);
    expect(canTransition('launched', 'merged')).toBe(false);
    expect(canTransition('discarded', 'draft')).toBe(true);
    expect(['draft', 'review', 'approved', 'launched', 'merged', 'discarded'].map((s) => prdCheckState(s as never))).toEqual([
      'in_progress', 'in_progress', 'passed', 'passed', 'passed', 'not_needed',
    ]);
  });
});

describe('小节与对比', () => {
  it('按 1–3 级标题切分，代码块里的 # 不算；同名小节加序号', () => {
    const s = splitSections(DOC);
    expect(s.map((x) => x.key)).toEqual(['（开头）', '1. 背景介绍', '1. 背景介绍 / 1.1 业务背景', '2. 需求说明', '2. 需求说明#2']);
    expect(s[2]!.markdown).toContain('## 代码块里的标题');
    expect(s.map((x) => x.markdown).join('\n')).toBe(DOC);
  });

  it('按小节返回新增、删除、修改，修改的小节给出逐行差异；没变的小节不返回', () => {
    const next = DOC.replace('| R1 | 分片上传 |', '| R1 | 分片上传 |\n| R2 | 秒传 |').replace('开头说明\n\n', '') + '\n\n## 3. 埋点\n\n上报上传耗时';
    const changes = diffSections(DOC, next);
    expect(changes.map((c) => [c.key, c.change])).toEqual([
      ['2. 需求说明', 'modified'],
      ['3. 埋点', 'added'],
      ['（开头）', 'removed'],
    ]);
    expect(changes[0]!.lines.filter((l) => l.type !== 'same')).toEqual([{ type: 'add', text: '| R2 | 秒传 |' }]);
    expect(diffRevisionSnapshots({ title: '旧', markdown: DOC }, { title: '新', markdown: DOC })).toEqual({ title: { old: '旧', new: '新' }, sections: [] });
  });
});

describe('纯文本与文本引用定位', () => {
  it('纯文本去掉 Markdown 语法', () => {
    const t = plainText(DOC);
    expect(t).toContain('1. 背景介绍');
    expect(t).toContain('用户反馈上传 大文件 太慢。');
    expect(t).toContain('断点续传，见接口文档');
    expect(t).not.toContain('|---|');
    expect(t).not.toContain('https://example.com');
  });

  it('按引用与前后文定位到小节，忽略空白与强调符号；多处出现时按前后文取最匹配的一处', () => {
    expect(locateQuote(DOC, { quote: '上传大文件', prefix: '用户反馈', suffix: '太慢' })).toEqual({ sectionHeading: '1.1 业务背景' });
    expect(locateQuote(DOC, { quote: 'R1 分片上传', prefix: '序号需求', suffix: '' })).toEqual({ sectionHeading: '2. 需求说明' });
    expect(locateQuote(DOC, { quote: '需求说明', prefix: '分片上传', suffix: '断点续传' })).toEqual({ sectionHeading: '2. 需求说明' });
    expect(locateQuote(DOC, { quote: '已经删掉的句子', prefix: '', suffix: '' })).toBeNull();
    expect(locateQuote(DOC, { quote: '   ', prefix: '', suffix: '' })).toBeNull();
  });
});

describe('外部网址', () => {
  it('规范化：去追踪参数与分享码、片段、末尾斜杠，主机名小写，协议统一；原文保留', () => {
    expect(normalizeExternalUrl(' https://Doc.Weixin.QQ.com/doc/w3_AB/?scode=xyz&utm_source=x#h1 ')).toEqual({
      url: 'https://Doc.Weixin.QQ.com/doc/w3_AB/?scode=xyz&utm_source=x#h1',
      key: 'https://doc.weixin.qq.com/doc/w3_AB',
      provider: 'wecom',
    });
    expect(normalizeExternalUrl('http://docs.qq.com:443/sheet/X?tab=b&a=1')!.key).toBe('https://docs.qq.com/sheet/X?a=1&tab=b');
    expect(normalizeExternalUrl('https://www.figma.com/design/K/x?node-id=1-2&t=abc')!.key).toBe('https://www.figma.com/design/K/x?node-id=1-2');
    expect(normalizeExternalUrl('需求仅设计了流程图')).toBeNull();
    expect(normalizeExternalUrl('https://a.com/x y')).toBeNull();
  });

  it('按主机名识别平台', () => {
    expect(['doc.weixin.qq.com', 'docs.qq.com', 'abc.feishu.cn', 'x.larksuite.com', 'www.notion.so', 'team.notion.site', 'demo.yuque.com', 'docs.google.com', 'example.com'].map(detectProvider)).toEqual([
      'wecom', 'tencent_docs', 'feishu', 'feishu', 'notion', 'notion', 'yuque', 'google_docs', 'other',
    ]);
  });
});

describe('模板', () => {
  const template = {
    body: '## 1. 背景介绍\n\n### 1.1 业务背景\n\n简述本需求所处的业务背景。\n\n## 3. 需求说明\n\n| 序号 | 需求名称 |\n|---|---|\n| R1 | 待填 |\n',
    sections: [
      { heading: '1. 背景介绍', required: true },
      { heading: '2. 产品概述', required: false },
      { heading: '3. 需求说明', required: true },
    ],
  };

  it('占位符', () => {
    expect(fillTemplate('| {{date}} | {{author}} | 初稿 |', { date: '2026-10-08', author: '林澄' })).toBe('| 2026-10-08 | 林澄 | 初稿 |');
  });

  it('必填小节：标题不看编号与空白；只剩模板原文的小节算未填写', () => {
    expect(missingRequiredSections(template.body, template)).toEqual(['1. 背景介绍', '3. 需求说明']);
    const filled = template.body.replace('简述本需求所处的业务背景。', '上传慢的投诉占三成。').replace('| R1 | 待填 |', '| R1 | 分片上传 |');
    expect(missingRequiredSections(filled.replace('## 3. 需求说明', '## 三、需求说明'), template)).toEqual(['3. 需求说明']);
    expect(missingRequiredSections(filled, template)).toEqual([]);
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/markdown.test.ts`
Expected: FAIL，找不到模块 `../src/documents/markdown`。

注意第 2 个必填断言：`三、需求说明` 去掉开头编号后是 `三、需求说明`（汉字编号不去），与 `需求说明` 不相等，所以仍算缺少。

- [ ] **Step 3: 实现**

新建 `packages/core/src/documents/markdown.ts`：

```ts
import { diffLines } from 'diff';
import type { CheckState } from '../requirements/labels';
import type { DocumentStatus, ExternalProvider, RevisionSnapshot, TemplateSection } from './constants';

export * from './constants';

// ---------- 编号与状态 ----------

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: '草稿',
  review: '评审中',
  approved: '已通过',
  launched: '已上线',
  merged: '已合入',
  discarded: '已废弃',
};

export const documentDisplayKey = (productKey: string, number: number): string => `${productKey}-PRD-${number}`;

export function parseDocumentKey(key: string): { productKey: string; number: number } | null {
  const m = /^([A-Z][A-Z0-9]{1,9})-PRD-(\d{1,9})$/.exec(key.trim());
  return m ? { productKey: m[1]!, number: Number(m[2]) } : null;
}

/** 可流转的目标状态。launched → merged 属于 P2-B（合入），这里没有。 */
export const DOCUMENT_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  draft: ['review', 'discarded'],
  review: ['draft', 'approved', 'discarded'],
  approved: ['review', 'launched', 'discarded'],
  launched: [],
  merged: [],
  discarded: ['draft'],
};

export const canTransition = (from: DocumentStatus, to: DocumentStatus): boolean => DOCUMENT_TRANSITIONS[from].includes(to);

/** 「PRD」检查项跟随 PRD 状态的结果（设计 §3）。 */
export function prdCheckState(status: DocumentStatus): CheckState {
  if (status === 'draft' || status === 'review') return 'in_progress';
  if (status === 'discarded') return 'not_needed';
  return 'passed';
}

// ---------- 小节与对比 ----------

export type Section = { key: string; heading: string | null; level: number; path: string[]; markdown: string };

const HEADING = /^(#{1,3})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * 按 1–3 级标题切分（代码块内的 # 不算）。键是从顶层到本节的标题路径，同名小节按出现次序加 #2、#3；
 * 第一个标题之前的内容（不为空时）键为「（开头）」。各节 markdown 用 '\n' 拼回去等于原文。
 */
export function splitSections(markdown: string): Section[] {
  const out: Section[] = [];
  const seen = new Map<string, number>();
  const stack: Array<{ level: number; heading: string }> = [];
  let cur: { heading: string | null; level: number; path: string[]; lines: string[] } = { heading: null, level: 0, path: [], lines: [] };
  let fence = false;
  const flush = () => {
    if (cur.heading === null && cur.lines.join('').trim() === '') return;
    const base = cur.heading === null ? '（开头）' : cur.path.join(' / ');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: n === 1 ? base : `${base}#${n}`, heading: cur.heading, level: cur.level, path: cur.path, markdown: cur.lines.join('\n') });
  };
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) fence = !fence;
    const m = fence ? null : HEADING.exec(line);
    if (!m) {
      cur.lines.push(line);
      continue;
    }
    flush();
    const level = m[1]!.length;
    const heading = m[2]!;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, heading });
    cur = { heading, level, path: stack.map((s) => s.heading), lines: [line] };
  }
  flush();
  return out;
}

export type DiffLine = { type: 'add' | 'del' | 'same'; text: string };
export type SectionChange = { key: string; heading: string | null; change: 'added' | 'removed' | 'modified'; lines: DiffLine[] };
export type RevisionDiff = { title: { old: string; new: string } | null; sections: SectionChange[] };

/** 末尾补换行：jsdiff 会把「没有结尾换行的最后一行」与同样内容带换行的行当作不同的行。 */
const withEol = (s: string): string => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

function lineDiff(a: string, b: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const part of diffLines(withEol(a), withEol(b))) {
    const type: DiffLine['type'] = part.added ? 'add' : part.removed ? 'del' : 'same';
    for (const text of part.value.replace(/\n$/, '').split('\n')) out.push({ type, text });
  }
  return out;
}

/** 两版正文按小节配对比较：先按新版顺序列出修改与新增，再按旧版顺序列出删除。 */
export function diffSections(oldMd: string, newMd: string): SectionChange[] {
  const before = splitSections(oldMd);
  const after = splitSections(newMd);
  const oldByKey = new Map(before.map((s) => [s.key, s]));
  const newKeys = new Set(after.map((s) => s.key));
  const out: SectionChange[] = [];
  for (const s of after) {
    const prev = oldByKey.get(s.key);
    if (!prev) out.push({ key: s.key, heading: s.heading, change: 'added', lines: lineDiff('', s.markdown) });
    else if (prev.markdown.trim() !== s.markdown.trim()) out.push({ key: s.key, heading: s.heading, change: 'modified', lines: lineDiff(prev.markdown.trim(), s.markdown.trim()) });
  }
  for (const s of before) if (!newKeys.has(s.key)) out.push({ key: s.key, heading: s.heading, change: 'removed', lines: lineDiff(s.markdown, '') });
  return out;
}

export function diffRevisionSnapshots(a: RevisionSnapshot, b: RevisionSnapshot): RevisionDiff {
  return { title: a.title === b.title ? null : { old: a.title, new: b.title }, sections: diffSections(a.markdown, b.markdown) };
}

// ---------- 纯文本与文本引用定位 ----------

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** 正文的可见文字：去掉代码块围栏、表格分隔行、图片、链接网址、HTML 标签、标题与引用符号、列表符号、强调符号。 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !FENCE.test(l) && !TABLE_RULE.test(l))
    .map((l) => l.replace(/^\s*>\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^\s{0,3}#{1,6}\s+/, ''))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`]+/g, '');
}

/** 比较用的形式：去掉全部空白与不影响阅读的 Markdown 符号。页面上选中的文字与正文按同一规则处理。 */
export const squash = (s: string): string => s.replace(/[\s*_~`|\\]/g, '');

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * W3C TextQuoteSelector 的精确匹配：在每个小节的纯文本里找 quote 的全部出现，
 * 按「与 prefix 的公共后缀 + 与 suffix 的公共前缀」打分取最高。找不到返回 null（评论标为已失效）。
 */
export function locateQuote(markdown: string, a: { quote: string; prefix: string; suffix: string }): { sectionHeading: string | null } | null {
  const q = squash(a.quote);
  if (!q) return null;
  const pre = squash(a.prefix);
  const suf = squash(a.suffix);
  let best: { score: number; heading: string | null } | null = null;
  for (const s of splitSections(markdown)) {
    const text = squash(plainText(s.markdown));
    for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) {
      const score = commonSuffix(text.slice(0, i), pre) + commonPrefix(text.slice(i + q.length), suf);
      if (!best || score > best.score) best = { score, heading: s.heading };
    }
  }
  return best ? { sectionHeading: best.heading } : null;
}

// ---------- 外部网址 ----------

const PROVIDER_HOSTS: Array<[ExternalProvider, RegExp]> = [
  ['wecom', /^(doc|drive)\.weixin\.qq\.com$/],
  ['tencent_docs', /^docs\.qq\.com$/],
  ['feishu', /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/],
  ['notion', /(^|\.)notion\.(so|site)$/],
  ['yuque', /(^|\.)yuque\.com$/],
  ['google_docs', /^docs\.google\.com$/],
];

export function detectProvider(host: string): ExternalProvider {
  const h = host.toLowerCase();
  return PROVIDER_HOSTS.find(([, re]) => re.test(h))?.[0] ?? 'other';
}

/** 不影响指向哪份文档的参数：追踪参数与企业微信的分享码。 */
const DROP_PARAMS = new Set(['spm', 'from', 'share_source', 'scode']);

/**
 * 外部 PRD 网址：url 是去掉首尾空白的原文（保留分享码，打开时仍可用）；key 用于同一产品内去重
 * （https、主机名小写、去默认端口、去片段与末尾斜杠、去追踪参数，其余参数按名排序）。不是网址返回 null。
 */
export function normalizeExternalUrl(raw: string): { url: string; key: string; provider: ExternalProvider } | null {
  const url = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const provider = detectProvider(host);
  const params = [...u.searchParams.entries()]
    .filter(([k]) => {
      const l = k.toLowerCase();
      return !l.startsWith('utm_') && !DROP_PARAMS.has(l) && !(l === 't' && host.endsWith('figma.com'));
    })
    .sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
  return { url, key: `https://${host}${port}${u.pathname.replace(/\/+$/, '')}${query}`, provider };
}

// ---------- 模板 ----------

export function fillTemplate(body: string, vars: { date: string; author: string }): string {
  return body.replaceAll('{{date}}', vars.date).replaceAll('{{author}}', vars.author);
}

const normHeading = (s: string): string => s.replace(/^[\d.、\s]+/, '').replace(/\s+/g, '');

/**
 * 缺少或未填写的必填小节（按模板顺序返回模板里的标题）。标题去掉开头的数字编号与空白后相等即为同一小节；
 * 小节及其下级小节里，除了与模板正文完全相同的行，还有文字才算已填写。
 */
export function missingRequiredSections(markdown: string, template: { body: string; sections: TemplateSection[] }): string[] {
  const sections = splitSections(markdown);
  const templateLines = new Set(
    template.body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !HEADING.test(l)),
  );
  const filled = (s: Section) =>
    s.markdown
      .split('\n')
      .slice(s.heading === null ? 0 : 1)
      .some((l) => {
        const t = l.trim();
        return t !== '' && !templateLines.has(t) && squash(plainText(t)) !== '';
      });
  return template.sections
    .filter((t) => t.required)
    .filter((t) => {
      const i = sections.findIndex((s) => s.heading !== null && normHeading(s.heading) === normHeading(t.heading));
      if (i === -1) return true;
      const own = [sections[i]!];
      for (let j = i + 1; j < sections.length && sections[j]!.level > sections[i]!.level; j++) own.push(sections[j]!);
      return !own.some(filled);
    })
    .map((t) => t.heading);
}
```

`packages/core/src/index.ts`：把 Task 2 加的 `export * from './documents/constants';` 改为 `export * from './documents/markdown';`（`markdown.ts` 已重新导出常量）。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/markdown.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/documents/markdown.ts packages/core/src/index.ts packages/core/test/markdown.test.ts
git commit -m "feat(core): 文档纯函数：编号、状态、小节对比、文本引用定位、网址规范化、必填小节

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: 文档模板、本地卷存储与图片附件

**Files:**
- Create: `packages/core/src/documents/templates.ts`
- Modify: `packages/core/src/definitions/defaults.ts`（新组织创建预置模板）
- Create: `packages/core/src/storage.ts`
- Create: `packages/core/src/documents/attachments.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `.gitignore`（`.flower-storage/`）
- Test: `packages/core/test/templates-attachments.test.ts`

**Interfaces:**
- Consumes: Task 2 表；Task 3 `TemplateSection`；现有 `requireOrgAdmin`、`requireNonGuest`、`requireProductRole`、`recordEvent`、`newId`
- Produces:
  - `templates.ts`：`type TemplateView = { id: string; productId: string | null; name: string; body: string; sections: TemplateSection[]; active: boolean; updatedAt: Date }`；`PRESET_TEMPLATE: { name: string; body: string; sections: TemplateSection[] }`；`insertPresetTemplate(tx: Tx, orgId: string): Promise<void>`；`effectiveTemplates(tx: Tx, productId: string): Promise<TemplateView[]>`；`loadUsableTemplate(tx: Tx, productId: string, templateId: string): Promise<TemplateView>`；`listTemplates(db, actor, input: { productId?: string | null; usable?: boolean }): Promise<TemplateView[]>`；`createTemplate(db, actor, input: { productId?: string | null; name: string; body: string; sections: TemplateSection[] }): Promise<TemplateView>`；`updateTemplate(db, actor, id: string, input: { name?: string; body?: string; sections?: TemplateSection[]; active?: boolean }): Promise<TemplateView>`；`createPresetTemplate(db, actor): Promise<TemplateView>`
  - `storage.ts`：`type FileStorage = { put(key: string, bytes: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array | null> }`；`createLocalStorage(dir: string): FileStorage`
  - `attachments.ts`：`IMAGE_MAX_BYTES = 10 * 1024 * 1024`；`IMAGE_TYPES`；`sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null`；`type AttachmentView = { id: string; filename: string; mime: string; sizeBytes: number }`；`uploadDocumentImage(db, actor, input: { documentId: string; filename: string; bytes: Uint8Array; storage: FileStorage }): Promise<AttachmentView>`；`readAttachment(db, actor, input: { attachmentId: string; storage: FileStorage }): Promise<{ mime: string; filename: string; bytes: Uint8Array }>`
  - 事件：`template.created`、`template.updated`（subjectType `document_template`）、`attachment.uploaded`（subjectType `document`）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/templates-attachments.test.ts`：

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documents } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { readAttachment, sniffImage, uploadDocumentImage } from '../src/documents/attachments';
import { createPresetTemplate, createTemplate, listTemplates, PRESET_TEMPLATE, updateTemplate } from '../src/documents/templates';
import { createLocalStorage } from '../src/storage';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let productAdmin: Actor;
let pan: string;
let docId: string;
let dir: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  productAdmin = await asMember(t.db, owner, '产品管理员丙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  await setProductRole(t.db, owner, pan, productAdmin.memberId, 'admin');
  const [doc] = await t.adminDb
    .insert(documents)
    .values({ orgId: owner.orgId, productId: pan, number: 1, source: 'external', title: '外部 PRD', externalUrl: 'https://example.com/a', externalUrlKey: 'https://example.com/a', externalProvider: 'other' })
    .returning();
  docId = doc!.id;
  dir = mkdtempSync(path.join(os.tmpdir(), 'flower-storage-'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await t.cleanup();
});

describe('文档模板', () => {
  it('新组织自带预置模板；预置模板不能重复添加', async () => {
    const list = await listTemplates(t.db, owner, {});
    expect(list).toMatchObject([{ name: PRESET_TEMPLATE.name, productId: null, active: true }]);
    expect(list[0]!.sections.filter((s) => s.required).map((s) => s.heading)).toEqual(['1. 背景介绍', '3. 需求说明']);
    await expect(createPresetTemplate(t.db, owner)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('组织模板只有组织管理员能建；产品模板由产品管理员建，并按名称覆盖组织模板', async () => {
    const input = { name: '轻量 PRD', body: '## 背景\n', sections: [{ heading: '背景', required: true }] };
    await expect(createTemplate(t.db, editor, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createTemplate(t.db, readOnlyToken(owner), input)).rejects.toMatchObject({ code: 'forbidden' });
    const orgTpl = await createTemplate(t.db, owner, input);
    await expect(createTemplate(t.db, owner, input)).rejects.toMatchObject({ code: 'conflict', message: '已有同名模板' });
    await expect(createTemplate(t.db, editor, { ...input, productId: pan })).rejects.toMatchObject({ code: 'forbidden' });
    const productTpl = await createTemplate(t.db, productAdmin, { ...input, productId: pan, body: '## 背景\n\n产品版\n' });
    const usable = await listTemplates(t.db, viewer, { productId: pan, usable: true });
    expect(usable.map((x) => x.id)).toEqual([expect.any(String), productTpl.id]);
    expect(usable.find((x) => x.id === orgTpl.id)).toBeUndefined();
    expect(await listTemplates(t.db, viewer, { productId: pan })).toEqual([productTpl]);
    await updateTemplate(t.db, productAdmin, productTpl.id, { active: false });
    expect((await listTemplates(t.db, viewer, { productId: pan, usable: true })).map((x) => x.id)).toContain(orgTpl.id);
    await expect(updateTemplate(t.db, productAdmin, orgTpl.id, { active: false })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('小节标题不能为空或重复', async () => {
    await expect(createTemplate(t.db, owner, { name: '坏模板', body: '', sections: [{ heading: ' ', required: true }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      createTemplate(t.db, owner, { name: '坏模板', body: '', sections: [{ heading: '背景', required: true }, { heading: '背景', required: false }] }),
    ).rejects.toMatchObject({ code: 'invalid', message: '小节标题不能重复' });
  });
});

describe('图片附件', () => {
  it('按文件头判断类型', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(SVG)).toBeNull();
  });

  it('编辑可以上传，只读成员可以读取；只读成员、只读 Token 不能上传；SVG 与超限文件被拒绝', async () => {
    const storage = createLocalStorage(dir);
    const att = await uploadDocumentImage(t.db, editor, { documentId: docId, filename: 'shot.png', bytes: PNG, storage });
    expect(att).toMatchObject({ filename: 'shot.png', mime: 'image/png', sizeBytes: PNG.byteLength });
    const read = await readAttachment(t.db, viewer, { attachmentId: att.id, storage });
    expect(read.mime).toBe('image/png');
    expect([...read.bytes]).toEqual([...PNG]);
    await expect(uploadDocumentImage(t.db, viewer, { documentId: docId, filename: 'a.png', bytes: PNG, storage })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(uploadDocumentImage(t.db, readOnlyToken(owner), { documentId: docId, filename: 'a.png', bytes: PNG, storage })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(uploadDocumentImage(t.db, editor, { documentId: docId, filename: 'x.svg', bytes: SVG, storage })).rejects.toMatchObject({
      code: 'invalid',
      message: '只支持 PNG、JPEG、GIF、WebP 图片',
    });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    await expect(uploadDocumentImage(t.db, editor, { documentId: docId, filename: 'big.png', bytes: big, storage })).rejects.toMatchObject({ message: '图片不能超过 10 MB' });
  });

  it('文件丢失时读取报「附件文件不存在」', async () => {
    const storage = createLocalStorage(dir);
    const att = await uploadDocumentImage(t.db, editor, { documentId: docId, filename: 'gone.png', bytes: PNG, storage });
    await expect(readAttachment(t.db, owner, { attachmentId: att.id, storage: createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-empty-'))) })).rejects.toMatchObject({
      code: 'not_found',
      message: '附件文件不存在',
    });
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/templates-attachments.test.ts`
Expected: FAIL，找不到 `../src/documents/attachments`。

- [ ] **Step 2: 模板服务**

新建 `packages/core/src/documents/templates.ts`：

```ts
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentTemplates } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import type { TemplateSection } from './constants';

export type TemplateView = { id: string; productId: string | null; name: string; body: string; sections: TemplateSection[]; active: boolean; updatedAt: Date };

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
  name: r.name,
  body: r.body,
  sections: r.sections,
  active: r.active,
  updatedAt: r.updatedAt,
});

export async function insertPresetTemplate(tx: Tx, orgId: string): Promise<void> {
  await tx.insert(documentTemplates).values({ orgId, productId: null, kind: 'change', name: PRESET_TEMPLATE.name, body: PRESET_TEMPLATE.body, sections: PRESET_TEMPLATE.sections });
}

function validate(input: { name: string; body: string; sections: TemplateSection[] }): { name: string; body: string; sections: TemplateSection[] } {
  const name = input.name.trim();
  if (!name || name.length > 50) throw new AppError('invalid', '模板名称不能为空，且不超过 50 个字符');
  if (input.body.length > 50_000) throw new AppError('invalid', '模板正文不超过 50000 个字符');
  if (input.sections.length > 50) throw new AppError('invalid', '小节不超过 50 个');
  const sections = input.sections.map((s) => ({ heading: s.heading.trim(), required: s.required, ...(s.guidance?.trim() ? { guidance: s.guidance.trim() } : {}) }));
  if (sections.some((s) => !s.heading || s.heading.length > 100)) throw new AppError('invalid', '小节标题不能为空，且不超过 100 个字符');
  if (new Set(sections.map((s) => s.heading)).size !== sections.length) throw new AppError('invalid', '小节标题不能重复');
  return { name, body: input.body, sections };
}

/** 组织级模板需要组织管理员；产品级模板需要该产品的管理员。 */
async function requireTemplateAdmin(tx: Tx, actor: Actor, productId: string | null): Promise<void> {
  if (productId) await requireProductRole(tx, actor, productId, 'admin');
  else requireOrgAdmin(actor);
}

/** 产品可用的模板：产品自己的启用模板，加上没有被同名产品模板覆盖的启用组织模板。 */
export async function effectiveTemplates(tx: Tx, productId: string): Promise<TemplateView[]> {
  const rows = await tx
    .select()
    .from(documentTemplates)
    .where(and(eq(documentTemplates.kind, 'change'), eq(documentTemplates.active, true), or(isNull(documentTemplates.productId), eq(documentTemplates.productId, productId))))
    .orderBy(asc(documentTemplates.createdAt), asc(documentTemplates.id));
  const overridden = new Set(rows.filter((r) => r.productId !== null).map((r) => r.name));
  return rows.filter((r) => r.productId !== null || !overridden.has(r.name)).map(view);
}

export async function loadUsableTemplate(tx: Tx, productId: string, templateId: string): Promise<TemplateView> {
  const tpl = (await effectiveTemplates(tx, productId)).find((x) => x.id === templateId);
  if (!tpl) throw new AppError('invalid', '模板不存在或已停用');
  return tpl;
}

/**
 * 不带 productId：组织级模板（含停用的）；带 productId：该产品自己的模板（含停用的）；
 * 带 productId 且 usable：新建 PRD 时可选的模板（effectiveTemplates）。
 */
export async function listTemplates(db: Db, actor: Actor, input: { productId?: string | null; usable?: boolean }): Promise<TemplateView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    if (!input.productId) {
      requireNonGuest(actor);
      const rows = await tx.select().from(documentTemplates).where(isNull(documentTemplates.productId)).orderBy(asc(documentTemplates.createdAt), asc(documentTemplates.id));
      return rows.map(view);
    }
    await requireProductRole(tx, actor, input.productId, 'viewer');
    if (input.usable) return effectiveTemplates(tx, input.productId);
    const rows = await tx.select().from(documentTemplates).where(eq(documentTemplates.productId, input.productId)).orderBy(asc(documentTemplates.createdAt), asc(documentTemplates.id));
    return rows.map(view);
  });
}

export async function createTemplate(
  db: Db,
  actor: Actor,
  input: { productId?: string | null; name: string; body: string; sections: TemplateSection[] },
): Promise<TemplateView> {
  const v = validate(input);
  return withOrg(db, actor.orgId, async (tx) => {
    const productId = input.productId ?? null;
    await requireTemplateAdmin(tx, actor, productId);
    let row: typeof documentTemplates.$inferSelect;
    try {
      [row] = (await tx.insert(documentTemplates).values({ orgId: actor.orgId, productId, kind: 'change', ...v }).returning()) as [typeof documentTemplates.$inferSelect];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已有同名模板');
      throw e;
    }
    await recordEvent(tx, { orgId: actor.orgId, productId, type: 'template.created', subjectType: 'document_template', subjectId: row.id, actor, payload: { name: row.name } });
    return view(row);
  });
}

export async function updateTemplate(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: string; body?: string; sections?: TemplateSection[]; active?: boolean },
): Promise<TemplateView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(documentTemplates).where(eq(documentTemplates.id, id)).for('update');
    if (!cur) throw new AppError('not_found', '模板不存在');
    await requireTemplateAdmin(tx, actor, cur.productId);
    const v = validate({ name: input.name ?? cur.name, body: input.body ?? cur.body, sections: input.sections ?? cur.sections });
    const next = { ...v, active: input.active ?? cur.active };
    const changes = (['name', 'body', 'sections', 'active'] as const)
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

/** P2-A 之前已有的组织没有预置模板，由组织管理员在设置页添加。 */
export async function createPresetTemplate(db: Db, actor: Actor): Promise<TemplateView> {
  try {
    return await createTemplate(db, actor, { productId: null, ...PRESET_TEMPLATE });
  } catch (e) {
    if (e instanceof AppError && e.code === 'conflict') throw new AppError('conflict', '预置模板已存在');
    throw e;
  }
}
```

`packages/core/src/definitions/defaults.ts`：

1. 顶部 import 区加 `import { insertPresetTemplate } from '../documents/templates';`
2. `seedOrgDefaults` 里 `await tx.insert(functionTags)…` 一行之后加：

```ts
  await insertPresetTemplate(tx, orgId);
```

- [ ] **Step 3: 存储与附件**

新建 `packages/core/src/storage.ts`：

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 附件文件的存取。先实现本地卷（FLOWER_STORAGE_DIR）；S3 兼容存储以后按同一接口实现。 */
export type FileStorage = { put(key: string, bytes: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array | null> };

/** 键固定为 `{orgId}/{attachmentId}.{ext}`，校验后再拼路径，杜绝 `..` 之类的路径穿越。 */
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

export function createLocalStorage(dir: string): FileStorage {
  const file = (key: string) => {
    if (!KEY.test(key)) throw new Error(`非法的存储键：${key}`);
    return path.join(dir, key);
  };
  return {
    async put(key, bytes) {
      const p = file(key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, bytes);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(file(key)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
  };
}
```

新建 `packages/core/src/documents/attachments.ts`：

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { attachments, documents } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { newId } from '../ids';
import type { FileStorage } from '../storage';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as const;
export type ImageMime = keyof typeof IMAGE_TYPES;
export type AttachmentView = { id: string; filename: string; mime: string; sizeBytes: number };

/** 按文件头字节判断图片类型，不信任客户端声明的类型；SVG 等可携带脚本的格式一律返回 null。 */
export function sniffImage(b: Uint8Array): ImageMime | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

export async function uploadDocumentImage(
  db: Db,
  actor: Actor,
  input: { documentId: string; filename: string; bytes: Uint8Array; storage: FileStorage },
): Promise<AttachmentView> {
  if (input.bytes.byteLength > IMAGE_MAX_BYTES) throw new AppError('invalid', '图片不能超过 10 MB');
  const mime = sniffImage(input.bytes);
  if (!mime) throw new AppError('invalid', '只支持 PNG、JPEG、GIF、WebP 图片');
  const filename = (input.filename.trim() || 'image').slice(0, 200);
  return withOrg(db, actor.orgId, async (tx) => {
    const [doc] = await tx
      .select({ id: documents.id, productId: documents.productId })
      .from(documents)
      .where(and(eq(documents.id, input.documentId), isNull(documents.deletedAt)));
    if (!doc) throw new AppError('not_found', 'PRD 不存在');
    await requireProductRole(tx, actor, doc.productId, 'editor');
    const id = newId();
    const storageKey = `${actor.orgId}/${id}.${IMAGE_TYPES[mime]}`;
    // 先写文件再入库：事务回滚时只留下一个没有引用的文件，不会出现有记录没文件
    await input.storage.put(storageKey, input.bytes);
    await tx.insert(attachments).values({ id, orgId: actor.orgId, targetType: 'document', targetId: doc.id, storageKey, filename, mime, sizeBytes: input.bytes.byteLength, uploaderMemberId: actor.memberId });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'attachment.uploaded',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { attachmentId: id, filename, mime, sizeBytes: input.bytes.byteLength },
    });
    return { id, filename, mime, sizeBytes: input.bytes.byteLength };
  });
}

export async function readAttachment(db: Db, actor: Actor, input: { attachmentId: string; storage: FileStorage }): Promise<{ mime: string; filename: string; bytes: Uint8Array }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [att] = await tx.select().from(attachments).where(eq(attachments.id, input.attachmentId));
    if (!att) throw new AppError('not_found', '附件不存在');
    const [doc] = await tx.select({ productId: documents.productId }).from(documents).where(eq(documents.id, att.targetId));
    if (!doc) throw new AppError('not_found', '附件不存在');
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const bytes = await input.storage.get(att.storageKey);
    if (!bytes) throw new AppError('not_found', '附件文件不存在');
    return { mime: att.mime, filename: att.filename, bytes };
  });
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './storage';
export * from './documents/templates';
export * from './documents/attachments';
```

`.gitignore` 末尾加一行 `.flower-storage/`。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/templates-attachments.test.ts`
Expected: PASS。

Run: `pnpm --filter @flower/core test && pnpm typecheck`
Expected: 全部通过。若有测试断言新组织的事件数或表行数，因为预置模板不写事件，不应受影响；如有失败，按「新组织多一份预置模板」更新断言并在报告里写明。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/documents/templates.ts packages/core/src/definitions/defaults.ts packages/core/src/storage.ts packages/core/src/documents/attachments.ts packages/core/src/index.ts packages/core/test/templates-attachments.test.ts .gitignore
git commit -m "feat(core): 文档模板（组织级与产品覆盖、预置模板）、本地卷存储与图片附件

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: 文档服务：新建、列表、详情、保存与修订合并、对比、恢复、状态流转与必填小节、转为 Flower 文档

**Files:**
- Create: `packages/core/src/documents/documents.ts`
- Modify: `packages/core/src/requirements/requirements.ts`（导出 `assertTitle`、`productKeyOf` 供文档共用）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/documents.test.ts`

**Interfaces:**
- Consumes: Task 2 表；Task 3 `documentDisplayKey`、`parseDocumentKey`、`DOCUMENT_TRANSITIONS`、`DOCUMENT_STATUS_LABELS`、`canTransition`、`normalizeExternalUrl`、`fillTemplate`、`missingRequiredSections`、`diffRevisionSnapshots`；Task 4 `loadUsableTemplate`；现有 `assertAssignableMember`、`memberNames`、`orgToday`、`displayKey`（需求编号）
- Produces:
  - `MAX_MARKDOWN_CHARS = 300_000`
  - `type DocumentListItem = { id: string; productId: string; number: number; displayKey: string; title: string; source: 'native' | 'external'; status: DocumentStatus; owner: MemberRef | null; externalUrl: string | null; externalProvider: ExternalProvider | null; requirementCount: number; updatedAt: Date }`
  - `type DocumentFilter = { statuses?: DocumentStatus[]; ownerIds?: string[]; source?: 'native' | 'external'; q?: string }`
  - `type DocumentDetail = DocumentListItem & { productKey: string; version: number; templateId: string | null; markdown: string | null; revisionNumber: number | null; myRole: ProductRole; transitions: DocumentStatus[]; requirements: Array<{ id: string; displayKey: string; title: string; stateKey: string }>; checkItems: CheckItemView[]; createdAt: Date }`（`checkItems` 在本任务恒为 `[]`，Task 8 填充）
  - `type RevisionListItem = { number: number; summary: string | null; author: MemberRef | null; createdAt: Date; updatedAt: Date }`；`type SaveResult = { version: number; revisionNumber: number; merged: boolean }`
  - `loadDocument(tx: Tx, id: string, opts?: { lock?: boolean }): Promise<typeof documents.$inferSelect>`
  - `createDocument(db, actor, productId: string, input: { title: string; ownerMemberId?: string | null; templateId?: string | null; externalUrl?: string | null }): Promise<DocumentDetail>`
  - `listDocuments(db, actor, productId: string, filter?: DocumentFilter): Promise<DocumentListItem[]>`
  - `getDocument(db, actor, id: string)`、`getDocumentByKey(db, actor, key: string)`：`Promise<DocumentDetail>`
  - `updateDocument(db, actor, id: string, input: { title?: string; ownerMemberId?: string | null; externalUrl?: string }): Promise<DocumentDetail>`
  - `saveDocumentContent(db, actor, id: string, input: { baseVersion: number; markdown: string; title?: string }): Promise<SaveResult>`
  - `listRevisions(db, actor, id: string): Promise<RevisionListItem[]>`（新到旧）；`getRevision(db, actor, id: string, number: number): Promise<{ number: number; title: string; markdown: string; createdAt: Date }>`；`diffRevisions(db, actor, id: string, input: { from: number; to: number }): Promise<RevisionDiff>`
  - `restoreRevision(db, actor, id: string, input: { number: number; baseVersion: number }): Promise<SaveResult>`
  - `transitionDocument(db, actor, id: string, input: { to: DocumentStatus }): Promise<DocumentDetail>`
  - `convertExternalDocument(db, actor, id: string, input: { baseVersion: number; markdown: string }): Promise<SaveResult>`
  - 内部共用（Task 6、7、8 使用）：`detailOf(tx, actor, doc)`、`writeRevision(tx, actor, doc, snapshot, opts)` 不导出；`documentDetailInTx(tx: Tx, actor: Actor, id: string): Promise<DocumentDetail>` 导出
  - 事件：`document.created`、`document.updated`、`document.saved`、`document.restored`、`document.status_changed`、`document.converted`（subjectType `document`）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/documents.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentRevisions, domainEvents } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import {
  convertExternalDocument,
  createDocument,
  diffRevisions,
  getDocumentByKey,
  getRevision,
  listDocuments,
  listRevisions,
  restoreRevision,
  saveDocumentContent,
  transitionDocument,
  updateDocument,
} from '../src/documents/documents';
import { listTemplates } from '../src/documents/templates';
import { createPlaceholderMember, updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;
let preset: string;

const WECOM = 'https://doc.weixin.qq.com/doc/w3_ABC?scode=one';

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  preset = (await listTemplates(t.db, owner, {}))[0]!.id;
});
afterAll(() => t.cleanup());

/** 把某份文档最近一条修订的保存时间往前拨，模拟「距上次保存已超过 5 分钟」。 */
async function ageLatestRevision(documentId: string, minutes: number) {
  const rows = await t.adminDb.select().from(documentRevisions).where(eq(documentRevisions.documentId, documentId));
  const last = rows.sort((a, b) => b.version - a.version)[0]!;
  await t.adminDb.update(documentRevisions).set({ updatedAt: new Date(Date.now() - minutes * 60_000) }).where(eq(documentRevisions.id, last.id));
}

describe('新建与列表', () => {
  it('Flower 文档按模板生成正文与第 1 版，编号按产品自增', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '上传提速 PRD', templateId: preset, ownerMemberId: editor.memberId });
    expect(d).toMatchObject({ displayKey: 'PAN-PRD-1', source: 'native', status: 'draft', revisionNumber: 1, version: 1, owner: { id: editor.memberId }, transitions: ['review', 'discarded'] });
    expect(d.markdown).toContain('## 1. 背景介绍');
    expect(d.markdown).toContain('| 编辑甲 | 初稿 |');
    expect(d.markdown).not.toContain('{{date}}');
  });

  it('外部 PRD 只存网址：识别平台；同一规范化网址在同一产品内只能有一份；不是网址报错', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '外部方案', externalUrl: WECOM });
    expect(d).toMatchObject({ displayKey: 'PAN-PRD-2', source: 'external', externalUrl: WECOM, externalProvider: 'wecom', markdown: null, revisionNumber: null });
    await expect(createDocument(t.db, editor, pan, { title: '重复', externalUrl: 'https://doc.weixin.qq.com/doc/w3_ABC/?scode=two#x' })).rejects.toMatchObject({
      code: 'conflict',
      message: '该网址已对应 PAN-PRD-2',
    });
    await expect(createDocument(t.db, editor, pan, { title: '坏链接', externalUrl: '见附件' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('权限：只读成员与只读 Token 不能新建；负责人必须是在职的人类成员', async () => {
    await expect(createDocument(t.db, viewer, pan, { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createDocument(t.db, readOnlyToken(owner), pan, { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    const left = await createPlaceholderMember(t.db, owner, { displayName: '离职丙' });
    await updateMember(t.db, owner, left.id, { status: 'left' });
    await expect(createDocument(t.db, editor, pan, { title: 'x', ownerMemberId: left.id })).rejects.toMatchObject({ message: '该成员已离开组织，不能选择' });
  });

  it('列表按状态、负责人、来源、关键词筛选；按编号取详情', async () => {
    expect((await listDocuments(t.db, viewer, pan)).map((d) => d.displayKey)).toEqual(['PAN-PRD-2', 'PAN-PRD-1']);
    expect((await listDocuments(t.db, viewer, pan, { source: 'external' })).map((d) => d.displayKey)).toEqual(['PAN-PRD-2']);
    expect((await listDocuments(t.db, viewer, pan, { ownerIds: [editor.memberId] })).map((d) => d.displayKey)).toEqual(['PAN-PRD-1']);
    expect((await listDocuments(t.db, viewer, pan, { q: 'PAN-PRD-2' })).map((d) => d.title)).toEqual(['外部方案']);
    expect((await listDocuments(t.db, viewer, pan, { statuses: ['review'] }))).toEqual([]);
    const d = await getDocumentByKey(t.db, viewer, 'PAN-PRD-1');
    expect(d).toMatchObject({ title: '上传提速 PRD', myRole: 'viewer', transitions: [] });
    await expect(getDocumentByKey(t.db, viewer, 'PAN-PRD-99')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('保存、修订与恢复', () => {
  it('同一作者 5 分钟内的保存合并为一版；换人或超过 5 分钟另起一版；版本号不对返回 409', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '修订测试' });
    const r1 = await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: '## 背景\n\n第一稿' });
    expect(r1).toEqual({ version: 2, revisionNumber: 1, merged: true });
    const r2 = await saveDocumentContent(t.db, owner, d.id, { baseVersion: 2, markdown: '## 背景\n\n第二稿' });
    expect(r2).toEqual({ version: 3, revisionNumber: 2, merged: false });
    await ageLatestRevision(d.id, 6);
    const r3 = await saveDocumentContent(t.db, owner, d.id, { baseVersion: 3, markdown: '## 背景\n\n第三稿\n\n## 需求\n\n- 分片' });
    expect(r3).toEqual({ version: 4, revisionNumber: 3, merged: false });
    await expect(saveDocumentContent(t.db, editor, d.id, { baseVersion: 3, markdown: 'x' })).rejects.toMatchObject({ code: 'conflict', details: { version: 4 } });
    expect((await listRevisions(t.db, viewer, d.id)).map((r) => [r.number, r.author?.displayName, r.summary])).toEqual([
      [3, 'Owner', null],
      [2, 'Owner', null],
      [1, '编辑甲', null],
    ]);
    const diff = await diffRevisions(t.db, viewer, d.id, { from: 1, to: 3 });
    expect(diff.sections.map((s) => [s.key, s.change])).toEqual([
      ['背景', 'modified'],
      ['需求', 'added'],
    ]);
  });

  it('恢复：以旧快照新建一版，摘要「恢复到第 N 版」，记 document.restored 事件', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '恢复测试' });
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: '旧正文', title: '旧标题' });
    await ageLatestRevision(d.id, 6);
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 2, markdown: '新正文', title: '新标题' });
    const r = await restoreRevision(t.db, editor, d.id, { number: 1, baseVersion: 3 });
    expect(r).toEqual({ version: 4, revisionNumber: 3, merged: false });
    expect(await getRevision(t.db, viewer, d.id, 3)).toMatchObject({ title: '旧标题', markdown: '旧正文' });
    const after = await getDocumentByKey(t.db, viewer, d.displayKey);
    expect(after).toMatchObject({ title: '旧标题', markdown: '旧正文', revisionNumber: 3 });
    expect((await listRevisions(t.db, viewer, d.id))[0]!.summary).toBe('恢复到第 1 版');
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, d.id));
    expect(events.map((e) => e.type)).toContain('document.restored');
    // 恢复之后同一作者马上保存，不能合并进「恢复」那一版
    expect(await saveDocumentContent(t.db, editor, d.id, { baseVersion: 4, markdown: '恢复后再改' })).toMatchObject({ revisionNumber: 4, merged: false });
  });

  it('正文不能内嵌 data: 图片；外部 PRD 不能保存正文；只读成员不能保存', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '校验' });
    await expect(saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: '![](data:image/png;base64,AAAA)' })).rejects.toMatchObject({
      message: '正文中不能内嵌图片数据，请上传图片',
    });
    await expect(saveDocumentContent(t.db, viewer, d.id, { baseVersion: 1, markdown: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    const ext = await createDocument(t.db, editor, pan, { title: '外部', externalUrl: 'https://docs.qq.com/doc/zz' });
    await expect(saveDocumentContent(t.db, editor, ext.id, { baseVersion: 1, markdown: 'x' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('状态流转与转换', () => {
  it('按流转表限制目标；提交评审时检查模板必填小节', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '必填测试', templateId: preset });
    await expect(transitionDocument(t.db, editor, d.id, { to: 'approved' })).rejects.toMatchObject({ code: 'invalid', message: '不能从「草稿」改为「已通过」' });
    await expect(transitionDocument(t.db, editor, d.id, { to: 'review' })).rejects.toMatchObject({
      code: 'invalid',
      message: '以下必填小节未填写：1. 背景介绍、3. 需求说明',
      details: { missing: ['1. 背景介绍', '3. 需求说明'] },
    });
    const filled = d.markdown!.replace('简述本需求所处的业务背景、当前问题。', '上传慢的投诉占三成。').replace('| R1 | 待填 | P0 | 待评审 |', '| R1 | 分片上传 | P0 | 待评审 |');
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: filled });
    expect(await transitionDocument(t.db, editor, d.id, { to: 'review' })).toMatchObject({ status: 'review', transitions: ['draft', 'approved', 'discarded'] });
    await expect(transitionDocument(t.db, viewer, d.id, { to: 'approved' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('外部 PRD 修改链接；转为 Flower 文档后保留原链接、生成第 1 版，不再是外部', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '待转换', externalUrl: 'https://abc.feishu.cn/docx/1' });
    const moved = await updateDocument(t.db, editor, d.id, { externalUrl: 'https://abc.feishu.cn/docx/2' });
    expect(moved).toMatchObject({ externalUrl: 'https://abc.feishu.cn/docx/2', externalProvider: 'feishu', version: 1 });
    const r = await convertExternalDocument(t.db, editor, d.id, { baseVersion: 1, markdown: '## 背景\n\n从飞书粘贴' });
    expect(r).toEqual({ version: 2, revisionNumber: 1, merged: false });
    const after = await getDocumentByKey(t.db, viewer, d.displayKey);
    expect(after).toMatchObject({ source: 'native', externalUrl: 'https://abc.feishu.cn/docx/2', markdown: '## 背景\n\n从飞书粘贴', revisionNumber: 1 });
    await expect(convertExternalDocument(t.db, editor, d.id, { baseVersion: 2, markdown: 'x' })).rejects.toMatchObject({ message: '只有外部 PRD 可以转为 Flower 文档' });
    await expect(createDocument(t.db, editor, pan, { title: '同链接', externalUrl: 'https://abc.feishu.cn/docx/2' })).rejects.toMatchObject({ code: 'conflict' });
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/documents.test.ts`
Expected: FAIL，找不到 `../src/documents/documents`。

- [ ] **Step 2: 实现**

新建 `packages/core/src/documents/documents.ts`：

```ts
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { productRoleOf, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentRevisions, documents, documentTemplates, products, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { assertAssignableMember, memberNames } from '../requirements/context';
import type { CheckItemView } from '../requirements/detail';
import { assertTitle, productKeyOf, displayKey as requirementDisplayKey, type MemberRef } from '../requirements/requirements';
import { orgToday } from '../tasks/tasks';
import type { DocumentStatus, ExternalProvider, RevisionSnapshot } from './constants';
import {
  canTransition,
  diffRevisionSnapshots,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TRANSITIONS,
  documentDisplayKey,
  fillTemplate,
  missingRequiredSections,
  normalizeExternalUrl,
  parseDocumentKey,
  type RevisionDiff,
} from './markdown';
import { loadUsableTemplate } from './templates';

export const MAX_MARKDOWN_CHARS = 300_000;
const MERGE_WINDOW_MS = 5 * 60 * 1000;
const INVALID_URL = '不是有效的网址（需以 http:// 或 https:// 开头，且不含空格）';

export type DocumentListItem = {
  id: string;
  productId: string;
  number: number;
  displayKey: string;
  title: string;
  source: 'native' | 'external';
  status: DocumentStatus;
  owner: MemberRef | null;
  externalUrl: string | null;
  externalProvider: ExternalProvider | null;
  requirementCount: number;
  updatedAt: Date;
};
export type DocumentFilter = { statuses?: DocumentStatus[]; ownerIds?: string[]; source?: 'native' | 'external'; q?: string };
export type DocumentDetail = DocumentListItem & {
  productKey: string;
  version: number;
  templateId: string | null;
  markdown: string | null;
  revisionNumber: number | null;
  myRole: ProductRole;
  transitions: DocumentStatus[];
  requirements: Array<{ id: string; displayKey: string; title: string; stateKey: string }>;
  checkItems: CheckItemView[];
  createdAt: Date;
};
export type RevisionListItem = { number: number; summary: string | null; author: MemberRef | null; createdAt: Date; updatedAt: Date };
export type SaveResult = { version: number; revisionNumber: number; merged: boolean };
type DocRow = typeof documents.$inferSelect;

function assertMarkdown(markdown: string): string {
  if (markdown.length > MAX_MARKDOWN_CHARS) throw new AppError('invalid', `正文不超过 ${MAX_MARKDOWN_CHARS} 个字符`);
  if (/\]\(\s*data:/i.test(markdown)) throw new AppError('invalid', '正文中不能内嵌图片数据，请上传图片');
  return markdown;
}

function assertBaseVersion(doc: DocRow, baseVersion: number): void {
  if (doc.version !== baseVersion) throw new AppError('conflict', '文档已被其他人修改，请重新加载后再编辑', { version: doc.version });
}

export async function loadDocument(tx: Tx, id: string, opts: { lock?: boolean } = {}): Promise<DocRow> {
  const q = tx.select().from(documents).where(and(eq(documents.id, id), isNull(documents.deletedAt)));
  const [d] = opts.lock ? await q.for('update') : await q;
  if (!d) throw new AppError('not_found', 'PRD 不存在');
  return d;
}

/** 同一产品内一个规范化网址只能对应一份 PRD；except 为正在修改的这份。 */
async function assertUrlFree(tx: Tx, productId: string, key: string, except: string | null): Promise<void> {
  const [other] = await tx
    .select({ id: documents.id, number: documents.number })
    .from(documents)
    .where(and(eq(documents.productId, productId), eq(documents.externalUrlKey, key), isNull(documents.deletedAt)));
  if (other && other.id !== except) throw new AppError('conflict', `该网址已对应 ${documentDisplayKey(await productKeyOf(tx, productId), other.number)}`);
}

async function hydrate(tx: Tx, rows: DocRow[]): Promise<DocumentListItem[]> {
  if (rows.length === 0) return [];
  const keys = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, [...new Set(rows.map((r) => r.productId))]));
  const keyOf = new Map(keys.map((k) => [k.id, k.key]));
  const names = await memberNames(tx, rows.map((r) => r.ownerMemberId));
  const counts = await tx
    .select({ id: requirements.changeDocumentId, n: sql<number>`count(*)::int` })
    .from(requirements)
    .where(and(inArray(requirements.changeDocumentId, rows.map((r) => r.id)), isNull(requirements.deletedAt)))
    .groupBy(requirements.changeDocumentId);
  const countOf = new Map(counts.map((c) => [c.id!, c.n]));
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    number: r.number,
    displayKey: documentDisplayKey(keyOf.get(r.productId)!, r.number),
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

async function detailOf(tx: Tx, actor: Actor, doc: DocRow): Promise<DocumentDetail> {
  const role = await productRoleOf(tx, actor, doc.productId);
  if (!role) throw new AppError('not_found', 'PRD 不存在');
  const [base] = await hydrate(tx, [doc]);
  const productKey = await productKeyOf(tx, doc.productId);
  const [rev] = doc.currentRevisionId ? await tx.select().from(documentRevisions).where(eq(documentRevisions.id, doc.currentRevisionId)) : [];
  const reqs = await tx
    .select()
    .from(requirements)
    .where(and(eq(requirements.changeDocumentId, doc.id), isNull(requirements.deletedAt)))
    .orderBy(asc(requirements.number));
  return {
    ...base!,
    productKey,
    version: doc.version,
    templateId: doc.templateId,
    markdown: rev ? rev.snapshot.markdown : null,
    revisionNumber: rev ? rev.version : null,
    myRole: role,
    transitions: role === 'viewer' ? [] : DOCUMENT_TRANSITIONS[doc.status],
    requirements: reqs.map((r) => ({ id: r.id, displayKey: requirementDisplayKey(productKey, r.number), title: r.title, stateKey: r.stateKey })),
    checkItems: [],
    createdAt: doc.createdAt,
  };
}

export async function documentDetailInTx(tx: Tx, actor: Actor, id: string): Promise<DocumentDetail> {
  return detailOf(tx, actor, await loadDocument(tx, id));
}

/**
 * 写一条修订：同一作者、距该作者上次保存不到 5 分钟、且上一条没有摘要（不是恢复或转换产生的）时覆盖上一条，
 * 否则新建。调用方已锁住文档行。
 */
async function writeRevision(
  tx: Tx,
  actor: Actor,
  doc: DocRow,
  snapshot: RevisionSnapshot,
  opts: { summary: string | null; allowMerge: boolean },
): Promise<{ id: string; number: number; merged: boolean }> {
  const [latest] = await tx.select().from(documentRevisions).where(eq(documentRevisions.documentId, doc.id)).orderBy(desc(documentRevisions.version)).limit(1);
  const now = new Date();
  if (
    opts.allowMerge &&
    latest &&
    latest.summary === null &&
    latest.authorMemberId === actor.memberId &&
    now.getTime() - latest.updatedAt.getTime() < MERGE_WINDOW_MS
  ) {
    await tx.update(documentRevisions).set({ snapshot, updatedAt: now }).where(eq(documentRevisions.id, latest.id));
    return { id: latest.id, number: latest.version, merged: true };
  }
  const [rev] = await tx
    .insert(documentRevisions)
    .values({ orgId: actor.orgId, documentId: doc.id, version: (latest?.version ?? 0) + 1, snapshot, summary: opts.summary, authorMemberId: actor.memberId, createdAt: now, updatedAt: now })
    .returning();
  return { id: rev!.id, number: rev!.version, merged: false };
}

export async function createDocument(
  db: Db,
  actor: Actor,
  productId: string,
  input: { title: string; ownerMemberId?: string | null; templateId?: string | null; externalUrl?: string | null },
): Promise<DocumentDetail> {
  const title = assertTitle(input.title);
  const wantsExternal = !!input.externalUrl?.trim();
  const external = wantsExternal ? normalizeExternalUrl(input.externalUrl!) : null;
  if (wantsExternal && !external) throw new AppError('invalid', INVALID_URL);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'editor');
    if (input.ownerMemberId) await assertAssignableMember(tx, input.ownerMemberId);
    if (external) await assertUrlFree(tx, productId, external.key, null);
    let markdown = '';
    let templateId: string | null = null;
    if (!external && input.templateId) {
      const tpl = await loadUsableTemplate(tx, productId, input.templateId);
      templateId = tpl.id;
      const names = await memberNames(tx, [actor.memberId]);
      markdown = fillTemplate(tpl.body, { date: await orgToday(tx, actor.orgId), author: names.get(actor.memberId) ?? '' });
    }
    const [seq] = await tx
      .update(products)
      .set({ documentSeq: sql`${products.documentSeq} + 1` })
      .where(eq(products.id, productId))
      .returning({ n: products.documentSeq });
    let doc: DocRow;
    try {
      [doc] = (await tx
        .insert(documents)
        .values({
          orgId: actor.orgId,
          productId,
          number: seq!.n,
          kind: 'change',
          source: external ? 'external' : 'native',
          title,
          ownerMemberId: input.ownerMemberId ?? null,
          templateId,
          status: 'draft',
          externalUrl: external?.url ?? null,
          externalUrlKey: external?.key ?? null,
          externalProvider: external?.provider ?? null,
          createdBy: actor.memberId,
        })
        .returning()) as [DocRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '该网址已对应其他 PRD');
      throw e;
    }
    if (!external) {
      const rev = await writeRevision(tx, actor, doc, { title, markdown }, { summary: null, allowMerge: false });
      await tx.update(documents).set({ currentRevisionId: rev.id }).where(eq(documents.id, doc.id));
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'document.created',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { number: doc.number, title, source: doc.source, externalUrl: doc.externalUrl, templateId },
    });
    return documentDetailInTx(tx, actor, doc.id);
  });
}

export async function listDocuments(db: Db, actor: Actor, productId: string, filter: DocumentFilter = {}): Promise<DocumentListItem[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const conds: SQL[] = [eq(documents.productId, productId), eq(documents.kind, 'change'), isNull(documents.deletedAt)];
    if (filter.statuses?.length) conds.push(inArray(documents.status, filter.statuses));
    if (filter.ownerIds?.length) conds.push(inArray(documents.ownerMemberId, filter.ownerIds));
    if (filter.source) conds.push(eq(documents.source, filter.source));
    const q = filter.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const num = /^(?:[A-Za-z][A-Za-z0-9]*-PRD-)?(\d{1,9})$/i.exec(q);
      const parts = [ilike(documents.title, like), ilike(documents.externalUrl, like)];
      if (num) parts.push(eq(documents.number, Number(num[1])));
      conds.push(or(...parts)!);
    }
    const rows = await tx.select().from(documents).where(and(...conds)).orderBy(desc(documents.updatedAt), desc(documents.number));
    return hydrate(tx, rows);
  });
}

export async function getDocument(db: Db, actor: Actor, id: string): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, (tx) => documentDetailInTx(tx, actor, id));
}

export async function getDocumentByKey(db: Db, actor: Actor, key: string): Promise<DocumentDetail> {
  const parsed = parseDocumentKey(key);
  if (!parsed) throw new AppError('not_found', 'PRD 不存在');
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({ d: documents })
      .from(documents)
      .innerJoin(products, eq(products.id, documents.productId))
      .where(and(eq(products.key, parsed.productKey), eq(documents.number, parsed.number), isNull(documents.deletedAt), isNull(products.deletedAt)));
    if (!row) throw new AppError('not_found', 'PRD 不存在');
    return detailOf(tx, actor, row.d);
  });
}

export async function updateDocument(
  db: Db,
  actor: Actor,
  id: string,
  input: { title?: string; ownerMemberId?: string | null; externalUrl?: string },
): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const next = {
      title: input.title === undefined ? cur.title : assertTitle(input.title),
      ownerMemberId: input.ownerMemberId === undefined ? cur.ownerMemberId : input.ownerMemberId,
      externalUrl: cur.externalUrl,
      externalUrlKey: cur.externalUrlKey,
      externalProvider: cur.externalProvider,
    };
    if (next.ownerMemberId && next.ownerMemberId !== cur.ownerMemberId) await assertAssignableMember(tx, next.ownerMemberId);
    if (input.externalUrl !== undefined) {
      if (cur.source !== 'external') throw new AppError('invalid', '只有外部 PRD 可以修改链接');
      const ext = normalizeExternalUrl(input.externalUrl);
      if (!ext) throw new AppError('invalid', INVALID_URL);
      if (ext.key !== cur.externalUrlKey) await assertUrlFree(tx, cur.productId, ext.key, cur.id);
      Object.assign(next, { externalUrl: ext.url, externalUrlKey: ext.key, externalProvider: ext.provider });
    }
    const changes = (['title', 'ownerMemberId', 'externalUrl'] as const).map((field) => ({ field, old: cur[field], new: next[field] })).filter((c) => c.old !== c.new);
    if (changes.length > 0) {
      await tx.update(documents).set({ ...next, updatedAt: new Date() }).where(eq(documents.id, id));
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'document.updated', subjectType: 'document', subjectId: id, actor, payload: { changes } });
    }
    return documentDetailInTx(tx, actor, id);
  });
}

export async function saveDocumentContent(db: Db, actor: Actor, id: string, input: { baseVersion: number; markdown: string; title?: string }): Promise<SaveResult> {
  const markdown = assertMarkdown(input.markdown);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    if (doc.source !== 'native') throw new AppError('invalid', '外部 PRD 没有正文，请先转为 Flower 文档');
    assertBaseVersion(doc, input.baseVersion);
    const title = input.title === undefined ? doc.title : assertTitle(input.title);
    const rev = await writeRevision(tx, actor, doc, { title, markdown }, { summary: null, allowMerge: true });
    const version = doc.version + 1;
    await tx.update(documents).set({ title, version, currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(documents.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.saved',
      subjectType: 'document',
      subjectId: id,
      actor,
      payload: { revision: rev.number, merged: rev.merged, changes: title === doc.title ? [] : [{ field: 'title', old: doc.title, new: title }] },
    });
    return { version, revisionNumber: rev.number, merged: rev.merged };
  });
}

export async function listRevisions(db: Db, actor: Actor, id: string): Promise<RevisionListItem[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const rows = await tx.select().from(documentRevisions).where(eq(documentRevisions.documentId, id)).orderBy(desc(documentRevisions.version));
    const names = await memberNames(tx, rows.map((r) => r.authorMemberId));
    return rows.map((r) => ({
      number: r.version,
      summary: r.summary,
      author: r.authorMemberId ? { id: r.authorMemberId, displayName: names.get(r.authorMemberId) ?? '已删除的成员' } : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  });
}

async function revisionSnapshot(tx: Tx, documentId: string, number: number): Promise<typeof documentRevisions.$inferSelect> {
  const [rev] = await tx.select().from(documentRevisions).where(and(eq(documentRevisions.documentId, documentId), eq(documentRevisions.version, number)));
  if (!rev) throw new AppError('not_found', `第 ${number} 版不存在`);
  return rev;
}

export async function getRevision(db: Db, actor: Actor, id: string, number: number): Promise<{ number: number; title: string; markdown: string; createdAt: Date }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const rev = await revisionSnapshot(tx, id, number);
    return { number: rev.version, title: rev.snapshot.title, markdown: rev.snapshot.markdown, createdAt: rev.createdAt };
  });
}

export async function diffRevisions(db: Db, actor: Actor, id: string, input: { from: number; to: number }): Promise<RevisionDiff> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const [a, b] = [await revisionSnapshot(tx, id, input.from), await revisionSnapshot(tx, id, input.to)];
    return diffRevisionSnapshots(a.snapshot, b.snapshot);
  });
}

export async function restoreRevision(db: Db, actor: Actor, id: string, input: { number: number; baseVersion: number }): Promise<SaveResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    if (doc.source !== 'native') throw new AppError('invalid', '外部 PRD 没有修订');
    assertBaseVersion(doc, input.baseVersion);
    const target = await revisionSnapshot(tx, id, input.number);
    const rev = await writeRevision(tx, actor, doc, target.snapshot, { summary: `恢复到第 ${input.number} 版`, allowMerge: false });
    const version = doc.version + 1;
    await tx.update(documents).set({ title: target.snapshot.title, version, currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(documents.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.restored',
      subjectType: 'document',
      subjectId: id,
      actor,
      payload: { from: input.number, revision: rev.number, changes: target.snapshot.title === doc.title ? [] : [{ field: 'title', old: doc.title, new: target.snapshot.title }] },
    });
    return { version, revisionNumber: rev.number, merged: false };
  });
}

export async function transitionDocument(db: Db, actor: Actor, id: string, input: { to: DocumentStatus }): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    if (!canTransition(doc.status, input.to)) {
      throw new AppError('invalid', `不能从「${DOCUMENT_STATUS_LABELS[doc.status]}」改为「${DOCUMENT_STATUS_LABELS[input.to]}」`);
    }
    if (input.to === 'review' && doc.source === 'native' && doc.templateId) {
      const [tpl] = await tx.select().from(documentTemplates).where(eq(documentTemplates.id, doc.templateId));
      const [rev] = doc.currentRevisionId ? await tx.select().from(documentRevisions).where(eq(documentRevisions.id, doc.currentRevisionId)) : [];
      const missing = tpl ? missingRequiredSections(rev?.snapshot.markdown ?? '', tpl) : [];
      if (missing.length > 0) throw new AppError('invalid', `以下必填小节未填写：${missing.join('、')}`, { missing });
    }
    await tx.update(documents).set({ status: input.to, updatedAt: new Date() }).where(eq(documents.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.status_changed',
      subjectType: 'document',
      subjectId: id,
      actor,
      payload: { changes: [{ field: 'status', old: doc.status, new: input.to }] },
    });
    return documentDetailInTx(tx, actor, id);
  });
}

export async function convertExternalDocument(db: Db, actor: Actor, id: string, input: { baseVersion: number; markdown: string }): Promise<SaveResult> {
  const markdown = assertMarkdown(input.markdown);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, id, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    if (doc.source !== 'external') throw new AppError('invalid', '只有外部 PRD 可以转为 Flower 文档');
    assertBaseVersion(doc, input.baseVersion);
    const rev = await writeRevision(tx, actor, doc, { title: doc.title, markdown }, { summary: '由外部文档转换', allowMerge: false });
    const version = doc.version + 1;
    await tx.update(documents).set({ source: 'native', currentRevisionId: rev.id, version, updatedAt: new Date() }).where(eq(documents.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.converted',
      subjectType: 'document',
      subjectId: id,
      actor,
      payload: { revision: rev.number, externalUrl: doc.externalUrl, changes: [{ field: 'source', old: 'external', new: 'native' }] },
    });
    return { version, revisionNumber: rev.number, merged: false };
  });
}
```

`packages/core/src/requirements/requirements.ts`：`function assertTitle(title: string): string {` 改为 `export function assertTitle(title: string): string {`，`async function productKeyOf(tx: Tx, productId: string): Promise<string> {` 改为 `export async function productKeyOf(tx: Tx, productId: string): Promise<string> {`（标题规则与产品编号查询和需求一致，不另写一份）。

`packages/core/src/index.ts` 末尾加 `export * from './documents/documents';`。

两处说明：

- `createDocument` 写第 1 版时 `allowMerge: false`、摘要为空，所以作者 5 分钟内的第一次保存会合并进第 1 版（测试「修订」用例 `r1.merged === true`）。
- 「修订」用例里 `listRevisions` 的作者名 `Owner` 来自 `seedInstance` 的账号名。

- [ ] **Step 3: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/documents.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/core/src/documents/documents.ts packages/core/src/index.ts packages/core/test/documents.test.ts
git commit -m "feat(core): PRD 新建、列表、保存与修订合并、对比、恢复、状态流转与必填小节、外部转换

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: 文档评论：划词定位、整篇评论、回复、解决；保存与恢复时重新定位

**Files:**
- Create: `packages/core/src/documents/comments.ts`
- Modify: `packages/core/src/documents/documents.ts`（`saveDocumentContent`、`restoreRevision` 写完修订后调用重新定位）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/document-comments.test.ts`

**Interfaces:**
- Consumes: Task 3 `locateQuote`、`TextAnchor`；Task 5 `loadDocument`、`createDocument`、`saveDocumentContent`、`restoreRevision`；现有 `comments`、`commentReads` 表与 `memberNames`
- Produces:
  - `type DocumentCommentView = { id: string; parentId: string | null; author: MemberRef | null; body: string; anchor: TextAnchor | null; anchorState: 'ok' | 'stale' | 'unanchored' | null; resolvedAt: Date | null; resolvedBy: MemberRef | null; createdAt: Date }`
  - `listDocumentComments(db, actor, documentId: string): Promise<DocumentCommentView[]>`（时间正序）
  - `addDocumentComment(db, actor, documentId: string, input: { body: string; parentId?: string | null; anchor?: { quote: string; prefix?: string; suffix?: string } | null }): Promise<DocumentCommentView>`
  - `setDocumentCommentResolved(db, actor, commentId: string, input: { resolved: boolean }): Promise<DocumentCommentView>`
  - `reanchorDocumentComments(tx: Tx, documentId: string, markdown: string): Promise<number>`（返回状态或小节有变化的评论数）
  - 事件：`comment.created`、`comment.resolved`、`comment.reopened`（subjectType `document`）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/document-comments.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { addDocumentComment, listDocumentComments, setDocumentCommentResolved } from '../src/documents/comments';
import { createDocument, restoreRevision, saveDocumentContent } from '../src/documents/documents';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

const V1 = '## 1. 背景\n\n上传大文件时经常超时，用户需要重新上传。\n\n## 2. 方案\n\n采用分片上传。';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('文档评论', () => {
  it('只读成员可以划词评论与整篇评论；只读 Token 不能评论', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '评论测试' });
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: V1 });
    const c = await addDocumentComment(t.db, viewer, d.id, { body: '超时时间是多少？', anchor: { quote: '经常超时', prefix: '上传大文件时', suffix: '，用户需要' } });
    expect(c).toMatchObject({ anchorState: 'ok', anchor: { quote: '经常超时', sectionHeading: '1. 背景' }, author: { displayName: '只读乙' } });
    const whole = await addDocumentComment(t.db, viewer, d.id, { body: '整体同意' });
    expect(whole).toMatchObject({ anchor: null, anchorState: null });
    await expect(addDocumentComment(t.db, readOnlyToken(owner), d.id, { body: 'x' })).rejects.toMatchObject({ code: 'forbidden', message: '只读 Token 不能评论' });
    await expect(addDocumentComment(t.db, viewer, d.id, { body: 'x', anchor: { quote: '正文里没有的话' } })).rejects.toMatchObject({
      code: 'invalid',
      message: '所选文字在当前版本中找不到，请刷新后重新选择',
    });
    const reply = await addDocumentComment(t.db, editor, d.id, { body: '30 秒', parentId: c.id });
    expect(reply.parentId).toBe(c.id);
    await expect(addDocumentComment(t.db, editor, d.id, { body: 'x', parentId: c.id, anchor: { quote: '分片上传' } })).rejects.toMatchObject({ message: '回复不能再选择原文' });
    expect((await listDocumentComments(t.db, viewer, d.id)).map((x) => x.body)).toEqual(['超时时间是多少？', '整体同意', '30 秒']);
  });

  it('原文改动后评论标为已失效；恢复后重新定位为正常；小节改名时更新小节', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '失效测试' });
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: V1 });
    const c = await addDocumentComment(t.db, viewer, d.id, { body: '为什么用分片？', anchor: { quote: '分片上传', prefix: '采用', suffix: '' } });
    await saveDocumentContent(t.db, owner, d.id, { baseVersion: 2, markdown: V1.replace('## 2. 方案', '## 2. 技术方案') });
    expect((await listDocumentComments(t.db, viewer, d.id))[0]).toMatchObject({ anchorState: 'ok', anchor: { sectionHeading: '2. 技术方案' } });
    await saveDocumentContent(t.db, owner, d.id, { baseVersion: 3, markdown: V1.replace('采用分片上传。', '改用断点续传。') });
    expect((await listDocumentComments(t.db, viewer, d.id))[0]).toMatchObject({ id: c.id, anchorState: 'stale' });
    await restoreRevision(t.db, editor, d.id, { number: 1, baseVersion: 4 });
    expect((await listDocumentComments(t.db, viewer, d.id))[0]).toMatchObject({ anchorState: 'ok', anchor: { sectionHeading: '2. 方案' } });
  });

  it('外部 PRD 只能整篇评论；作者或产品编辑可以标为已解决，其他只读成员不行', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '外部', externalUrl: 'https://docs.qq.com/doc/c1' });
    await expect(addDocumentComment(t.db, viewer, d.id, { body: 'x', anchor: { quote: 'y' } })).rejects.toMatchObject({ message: '外部 PRD 不能划词评论' });
    const c = await addDocumentComment(t.db, editor, d.id, { body: '链接打不开' });
    await expect(setDocumentCommentResolved(t.db, viewer, c.id, { resolved: true })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await setDocumentCommentResolved(t.db, editor, c.id, { resolved: true })).toMatchObject({ resolvedBy: { displayName: '编辑甲' } });
    expect(await setDocumentCommentResolved(t.db, owner, c.id, { resolved: false })).toMatchObject({ resolvedAt: null, resolvedBy: null });
    const mine = await addDocumentComment(t.db, viewer, d.id, { body: '我自己的' });
    expect((await setDocumentCommentResolved(t.db, viewer, mine.id, { resolved: true })).resolvedAt).not.toBeNull();
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/document-comments.test.ts`
Expected: FAIL，找不到 `../src/documents/comments`。

- [ ] **Step 2: 实现评论服务**

新建 `packages/core/src/documents/comments.ts`：

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { commentReads, comments, documentRevisions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { memberNames } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import type { TextAnchor } from './constants';
import { loadDocument } from './documents';
import { locateQuote } from './markdown';

export type DocumentCommentView = {
  id: string;
  parentId: string | null;
  author: MemberRef | null;
  body: string;
  anchor: TextAnchor | null;
  anchorState: 'ok' | 'stale' | 'unanchored' | null;
  resolvedAt: Date | null;
  resolvedBy: MemberRef | null;
  createdAt: Date;
};
type CommentRow = typeof comments.$inferSelect;

const onDocument = (documentId: string) => and(eq(comments.targetType, 'document'), eq(comments.targetId, documentId));

async function views(tx: Tx, rows: CommentRow[]): Promise<DocumentCommentView[]> {
  const names = await memberNames(tx, rows.flatMap((r) => [r.authorMemberId, r.resolvedBy]));
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  return rows.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    author: ref(c.authorMemberId),
    body: c.body,
    anchor: (c.anchor as TextAnchor | null) ?? null,
    anchorState: c.anchorState,
    resolvedAt: c.resolvedAt,
    resolvedBy: ref(c.resolvedBy),
    createdAt: c.createdAt,
  }));
}

export async function listDocumentComments(db: Db, actor: Actor, documentId: string): Promise<DocumentCommentView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const rows = await tx.select().from(comments).where(onDocument(documentId)).orderBy(asc(comments.createdAt), asc(comments.id));
    return views(tx, rows);
  });
}

export async function addDocumentComment(
  db: Db,
  actor: Actor,
  documentId: string,
  input: { body: string; parentId?: string | null; anchor?: { quote: string; prefix?: string; suffix?: string } | null },
): Promise<DocumentCommentView> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能评论');
  const body = input.body.trim();
  if (!body || body.length > 10_000) throw new AppError('invalid', '评论不能为空，且不超过 10000 个字符');
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    if (input.parentId) {
      const [parent] = await tx.select({ id: comments.id }).from(comments).where(and(eq(comments.id, input.parentId), onDocument(documentId)));
      if (!parent) throw new AppError('invalid', '回复的评论不存在');
    }
    let anchor: TextAnchor | null = null;
    if (input.anchor) {
      if (input.parentId) throw new AppError('invalid', '回复不能再选择原文');
      if (doc.source !== 'native' || !doc.currentRevisionId) throw new AppError('invalid', '外部 PRD 不能划词评论');
      const quote = input.anchor.quote.trim();
      if (!quote || quote.length > 500) throw new AppError('invalid', '选中的文字不能为空，且不超过 500 个字符');
      const prefix = (input.anchor.prefix ?? '').slice(-64);
      const suffix = (input.anchor.suffix ?? '').slice(0, 64);
      const [rev] = await tx.select().from(documentRevisions).where(eq(documentRevisions.id, doc.currentRevisionId));
      const found = locateQuote(rev!.snapshot.markdown, { quote, prefix, suffix });
      if (!found) throw new AppError('invalid', '所选文字在当前版本中找不到，请刷新后重新选择');
      anchor = { quote, prefix, suffix, sectionHeading: found.sectionHeading };
    }
    const [row] = await tx
      .insert(comments)
      .values({
        orgId: actor.orgId,
        targetType: 'document',
        targetId: documentId,
        parentId: input.parentId ?? null,
        authorMemberId: actor.memberId,
        body,
        kind: 'comment',
        anchor,
        anchorState: anchor ? 'ok' : null,
      })
      .returning();
    await tx.insert(commentReads).values({ orgId: actor.orgId, commentId: row!.id, memberId: actor.memberId });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'comment.created',
      subjectType: 'document',
      subjectId: documentId,
      actor,
      payload: { commentId: row!.id, anchored: anchor !== null },
    });
    return (await views(tx, [row!]))[0]!;
  });
}

export async function setDocumentCommentResolved(db: Db, actor: Actor, commentId: string, input: { resolved: boolean }): Promise<DocumentCommentView> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能修改评论');
  return withOrg(db, actor.orgId, async (tx) => {
    const [c] = await tx.select().from(comments).where(and(eq(comments.id, commentId), eq(comments.targetType, 'document')));
    if (!c) throw new AppError('not_found', '评论不存在');
    const doc = await loadDocument(tx, c.targetId);
    const role = await requireProductRole(tx, actor, doc.productId, 'viewer');
    if (role === 'viewer' && c.authorMemberId !== actor.memberId) throw new AppError('forbidden', '只能解决自己发的评论，其他评论由产品编辑处理');
    if (c.parentId) throw new AppError('invalid', '只能解决顶层评论');
    const [row] = await tx
      .update(comments)
      .set(input.resolved ? { resolvedAt: new Date(), resolvedBy: actor.memberId } : { resolvedAt: null, resolvedBy: null })
      .where(eq(comments.id, commentId))
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: input.resolved ? 'comment.resolved' : 'comment.reopened',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { commentId },
    });
    return (await views(tx, [row!]))[0]!;
  });
}

/**
 * 正文变化后重新定位划词评论：找到原文时为 ok 并更新所在小节，找不到时为 stale（不删除）。
 * 迁移导入的 unanchored 评论与整篇评论不处理。在保存或恢复修订的同一事务里调用。
 */
export async function reanchorDocumentComments(tx: Tx, documentId: string, markdown: string): Promise<number> {
  const rows = await tx
    .select({ id: comments.id, anchor: comments.anchor, anchorState: comments.anchorState })
    .from(comments)
    .where(and(onDocument(documentId), inArray(comments.anchorState, ['ok', 'stale'])));
  let changed = 0;
  for (const r of rows) {
    const anchor = r.anchor as TextAnchor;
    const found = locateQuote(markdown, anchor);
    const next = found ? { anchorState: 'ok' as const, anchor: { ...anchor, sectionHeading: found.sectionHeading } } : { anchorState: 'stale' as const, anchor };
    if (next.anchorState === r.anchorState && next.anchor.sectionHeading === anchor.sectionHeading) continue;
    await tx.update(comments).set(next).where(eq(comments.id, r.id));
    changed += 1;
  }
  return changed;
}
```

- [ ] **Step 3: 保存与恢复时重新定位**

`packages/core/src/documents/documents.ts`：

1. import 区加 `import { reanchorDocumentComments } from './comments';`（与 `comments.ts` 互相引用；两边都只在函数体内使用对方，ESM 下没有初始化顺序问题）。
2. `saveDocumentContent` 中 `await tx.update(documents).set({ title, version, currentRevisionId: rev.id, updatedAt: new Date() })…` 一行之后加：

```ts
    await reanchorDocumentComments(tx, id, markdown);
```

3. `restoreRevision` 中 `await tx.update(documents).set({ title: target.snapshot.title, version, currentRevisionId: rev.id, updatedAt: new Date() })…` 一行之后加：

```ts
    await reanchorDocumentComments(tx, id, target.snapshot.markdown);
```

`packages/core/src/index.ts` 末尾加 `export * from './documents/comments';`。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/document-comments.test.ts test/documents.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/documents/comments.ts packages/core/src/documents/documents.ts packages/core/src/index.ts packages/core/test/document-comments.test.ts
git commit -m "feat(core): PRD 评论：划词定位、回复、解决，正文变化后重新定位并标记已失效

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: 覆盖需求与「PRD」检查项联动

**Files:**
- Modify: `packages/core/src/definitions/workflow-schema.ts`（`auto: 'prd_status'` 的校验）
- Modify: `packages/core/test/workflow-schema.test.ts`（替换原「必须作用于 PRD」用例）
- Modify: `packages/core/src/requirements/workflow-runtime.ts`（`reviewStarted` 不计 auto 项）
- Modify: `packages/core/test/review-runtime.test.ts`
- Modify: `packages/core/src/requirements/transitions.ts`（被覆盖的需求不能手改「PRD」项）
- Create: `packages/core/src/documents/coverage.ts`
- Modify: `packages/core/src/documents/documents.ts`（`createDocument` 支持 `requirementIds`；`transitionDocument` 同步「PRD」项）
- Modify: `packages/core/test/factories.ts`（`prdWorkflow`）
- Modify: `packages/core/src/index.ts`
- Modify: `apps/web/src/features/workflow/components/check-items.tsx`（「自动同步」勾选框移到作用于需求的普通检查项）
- Modify: `docs/superpowers/specs/2026-09-28-flower-data-model-design.md` §3.1 `auto` 一行的注释
- Test: `packages/core/test/document-coverage.test.ts`

**Interfaces:**
- Consumes: Task 3 `prdCheckState`、`documentDisplayKey`；Task 5 `loadDocument`、`documentDetailInTx`、`createDocument`、`transitionDocument`
- Produces:
  - `coverage.ts`：`prdAutoItem(body: WorkflowBody): CheckItem | null`；`syncPrdCheck(tx: Tx, actor: Actor, doc: { id: string; productId: string; status: DocumentStatus }, requirementIds: string[]): Promise<void>`；`linkRequirementsTx(tx: Tx, actor: Actor, documentId: string, requirementIds: string[]): Promise<{ linked: number }>`；`linkDocumentRequirements(db, actor, documentId: string, input: { requirementIds: string[] }): Promise<{ linked: number }>`；`unlinkDocumentRequirement(db, actor, documentId: string, requirementId: string): Promise<void>`
  - `createDocument` 的 input 增加 `requirementIds?: string[]`
  - `factories.ts`：`prdWorkflow(designTagId: string): WorkflowBody`（检查项：`feasibility` 需求普通；`prd` 需求普通 + `auto: 'prd_status'`；`prd_review` PRD 会签，签字人为设计标签；流转到 `doing` 需要 `prd_review` 通过）
  - 事件：`requirement.updated`（changes `changeDocumentId`）、`document.requirements_linked`、`document.requirement_unlinked`、`check_item.updated`（payload 带 `auto: true`、`documentId`）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/factories.ts` 末尾加：

```ts
/**
 * 带 PRD 联动的流程：「PRD」是作用于需求、跟随 PRD 状态的普通检查项；「PRD 评审」是挂在 PRD 上、由设计标签会签的检查项，
 * 流转到「开发中」需要它通过。PRD 相关测试与端到端 helper 共用同一结构。
 */
export function prdWorkflow(designTagId: string): WorkflowBody {
  return {
    states: [
      { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
      { key: 'doing', label: '开发中', color: '#f59e0b', order: 2, group: '', category: 'started' },
      { key: 'done', label: '已上线', color: '#10b981', order: 3, group: '', category: 'completed' },
    ],
    initial: 'backlog',
    transitions: [
      { from: '*', to: 'backlog', conditions: [] },
      { from: '*', to: 'doing', conditions: [{ type: 'check_item', item: 'prd_review', in: ['passed'] }] },
      { from: '*', to: 'done', conditions: [] },
    ],
    actionGates: [],
    checkItems: [
      { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status', defaultState: 'not_started' },
      {
        key: 'prd_review',
        label: 'PRD 评审',
        scope: 'document',
        type: 'signoff',
        signers: [{ by: 'function_tag', ref: designTagId }],
        signoffRule: 'all',
        defaultState: 'not_started',
      },
    ],
  };
}
```

`packages/core/test/workflow-schema.test.ts`：把整个 `it('自动同步 PRD 状态的检查项必须作用于 PRD', …)` 替换为：

```ts
  it('自动同步 PRD 状态的检查项必须是作用于需求的普通检查项，且最多一个', () => {
    const onDocument = issuesOf({
      ...valid,
      checkItems: [...valid.checkItems, { key: 'prd', label: 'PRD', scope: 'document', type: 'single', auto: 'prd_status' }],
    });
    expect(onDocument).toContain('自动同步 PRD 状态的检查项必须作用于需求，且为普通检查项');
    const two = issuesOf({
      ...valid,
      checkItems: [
        ...valid.checkItems,
        { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status' },
        { key: 'prd2', label: 'PRD2', scope: 'requirement', type: 'single', auto: 'prd_status' },
      ],
    });
    expect(two).toContain('最多只能有一个自动同步 PRD 状态的检查项');
    expect(issuesOf({ ...valid, checkItems: [...valid.checkItems, { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status' }] })).toEqual([]);
  });
```

（`issuesOf` 与 `valid` 是该文件已有的辅助；若 `issuesOf` 对通过的输入返回别的形状，按文件里现有的「通过」写法断言 `ok === true`。）

`packages/core/test/review-runtime.test.ts`：在 `it('评审是否已开始：…')` 的最后一个 `expect` 之后加：

```ts
    const withAuto: CheckItem[] = [...items, { key: 'prd_auto', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status', defaultState: 'not_started' }];
    expect(reviewStarted(withAuto, { feasibility: 'not_started', prd: 'not_needed', doc_check: 'not_started', prd_auto: 'in_progress' })).toBe(false);
```

新建 `packages/core/test/document-coverage.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkItemResults, domainEvents } from '../src/db/schema';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { linkDocumentRequirements, unlinkDocumentRequirement } from '../src/documents/coverage';
import { createDocument, getDocumentByKey, transitionDocument } from '../src/documents/documents';
import { createRequirement } from '../src/requirements/requirements';
import { setCheckItemState } from '../src/requirements/transitions';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, prdWorkflow, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let pan: string;
let other: string;

async function prdState(requirementId: string): Promise<string | undefined> {
  const [r] = await t.adminDb
    .select({ state: checkItemResults.state })
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, requirementId), eq(checkItemResults.itemKey, 'prd')));
  return r?.state;
}

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  other = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  const { version } = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('覆盖需求与「PRD」检查项', () => {
  it('新建时挂上需求：「PRD」项变为进行中；PRD 状态变化时同步；被覆盖的需求不能手改「PRD」项', async () => {
    const r1 = await createRequirement(t.db, owner, pan, { title: '分片上传' });
    const r2 = await createRequirement(t.db, owner, pan, { title: '断点续传' });
    await setCheckItemState(t.db, owner, r2.id, 'prd', { state: 'passed' });
    const d = await createDocument(t.db, owner, pan, { title: '上传 PRD', externalUrl: 'https://doc.weixin.qq.com/doc/up', requirementIds: [r1.id, r2.id] });
    expect(d.requirements.map((r) => r.displayKey)).toEqual(['PAN-1', 'PAN-2']);
    expect([await prdState(r1.id), await prdState(r2.id)]).toEqual(['in_progress', 'in_progress']);
    await expect(setCheckItemState(t.db, owner, r1.id, 'prd', { state: 'passed' })).rejects.toMatchObject({
      code: 'invalid',
      message: '「PRD」检查项跟随所挂 PRD 的状态，不能手动修改',
    });
    await transitionDocument(t.db, owner, d.id, { to: 'review' });
    await transitionDocument(t.db, owner, d.id, { to: 'approved' });
    expect(await prdState(r1.id)).toBe('passed');
    await transitionDocument(t.db, owner, d.id, { to: 'discarded' });
    expect(await prdState(r2.id)).toBe('not_needed');
    const events = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, r1.id), eq(domainEvents.type, 'check_item.updated')));
    expect(events.map((e) => (e.payload as { changes: Array<{ new: string }> }).changes[0]!.new)).toEqual(['in_progress', 'passed', 'not_needed']);
    expect(events.every((e) => (e.payload as { auto?: boolean; documentId?: string }).auto === true && (e.payload as { documentId?: string }).documentId === d.id)).toBe(true);
  });

  it('一条需求只能挂一份 PRD；不能挂其他产品的需求；移出后恢复手工维护并保留当时的值', async () => {
    const r = await createRequirement(t.db, owner, pan, { title: '秒传' });
    const a = await createDocument(t.db, owner, pan, { title: 'A', externalUrl: 'https://doc.weixin.qq.com/doc/a' });
    const b = await createDocument(t.db, owner, pan, { title: 'B', externalUrl: 'https://doc.weixin.qq.com/doc/b' });
    expect(await linkDocumentRequirements(t.db, owner, a.id, { requirementIds: [r.id, r.id] })).toEqual({ linked: 1 });
    expect(await linkDocumentRequirements(t.db, owner, a.id, { requirementIds: [r.id] })).toEqual({ linked: 0 });
    await expect(linkDocumentRequirements(t.db, owner, b.id, { requirementIds: [r.id] })).rejects.toMatchObject({
      code: 'conflict',
      message: `${r.displayKey} 已挂在 ${a.displayKey} 上，请先从那份 PRD 移出`,
    });
    const elsewhere = await createRequirement(t.db, owner, other, { title: '别的产品' });
    await expect(linkDocumentRequirements(t.db, owner, b.id, { requirementIds: [elsewhere.id] })).rejects.toMatchObject({ message: 'PIC-1 不属于这份 PRD 所在的产品' });
    await unlinkDocumentRequirement(t.db, owner, a.id, r.id);
    expect(await prdState(r.id)).toBe('in_progress');
    await setCheckItemState(t.db, owner, r.id, 'prd', { state: 'not_needed' });
    expect((await getDocumentByKey(t.db, owner, a.displayKey)).requirementCount).toBe(0);
    await expect(unlinkDocumentRequirement(t.db, owner, a.id, r.id)).rejects.toMatchObject({ message: '该需求没有挂在这份 PRD 上' });
  });

  it('权限：只读成员与只读 Token 不能改覆盖；已废弃的 PRD 不能再挂需求', async () => {
    const r = await createRequirement(t.db, owner, pan, { title: '权限' });
    const d = await createDocument(t.db, owner, pan, { title: 'C', externalUrl: 'https://doc.weixin.qq.com/doc/c' });
    await expect(linkDocumentRequirements(t.db, viewer, d.id, { requirementIds: [r.id] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(linkDocumentRequirements(t.db, readOnlyToken(owner), d.id, { requirementIds: [r.id] })).rejects.toMatchObject({ code: 'forbidden' });
    await transitionDocument(t.db, owner, d.id, { to: 'discarded' });
    await expect(linkDocumentRequirements(t.db, owner, d.id, { requirementIds: [r.id] })).rejects.toMatchObject({ message: '已废弃的 PRD 不能再关联需求' });
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/document-coverage.test.ts test/workflow-schema.test.ts test/review-runtime.test.ts`
Expected: FAIL：`prdWorkflow` 校验不通过（`auto` 需要 scope = document）、`coverage.ts` 不存在、`reviewStarted` 新断言失败。

- [ ] **Step 2: 流程校验与评审开始判断**

`packages/core/src/definitions/workflow-schema.ts`：把

```ts
    if (c.auto === 'prd_status' && c.scope !== 'document') {
      issues.push({ path: `${path}.auto`, message: '自动同步 PRD 状态的检查项作用范围必须是 PRD' });
    }
```

替换为

```ts
    if (c.auto === 'prd_status' && (c.scope !== 'requirement' || c.type !== 'single')) {
      issues.push({ path: `${path}.auto`, message: '自动同步 PRD 状态的检查项必须作用于需求，且为普通检查项' });
    }
```

并在 `b.checkItems.forEach(…)` 整段之后加：

```ts
  if (b.checkItems.filter((c) => c.auto === 'prd_status').length > 1) {
    issues.push({ path: 'checkItems', message: '最多只能有一个自动同步 PRD 状态的检查项' });
  }
```

`packages/core/src/requirements/workflow-runtime.ts` 的 `reviewStarted` 改为：

```ts
/** 需求的评审是否已经开始：任一需求检查项不在它的默认状态。跟随 PRD 状态的 auto 项不算（挂上 PRD 不等于开始评审）。 */
export function reviewStarted(items: CheckItem[], checks: Record<string, CheckState>): boolean {
  return items.some((c) => c.scope === 'requirement' && !c.auto && checks[c.key] !== undefined && checks[c.key] !== c.defaultState);
}
```

`packages/core/src/requirements/transitions.ts` 的 `setCheckItemState` 中，`if (item.type === 'signoff') throw …` 一行之后加：

```ts
    if (item.auto === 'prd_status' && cur.changeDocumentId) throw new AppError('invalid', '「PRD」检查项跟随所挂 PRD 的状态，不能手动修改');
```

`docs/superpowers/specs/2026-09-28-flower-data-model-design.md` §3.1 中 `auto?: "prd_status",                 // 由系统自动更新，不可手改` 改为 `auto?: "prd_status",                 // 作用于需求的普通检查项；需求被 PRD 覆盖时跟随 PRD 状态、不可手改（P2-A）`。

`apps/web/src/features/workflow/components/check-items.tsx`：

1. 列表里的 `{c.auto === 'prd_status' && ' · 自动同步 PRD 状态'}` 改为 `{c.auto === 'prd_status' && ' · 跟随 PRD 状态'}`。
2. 类型下拉的 `onValueChange` 里两处 `setDraft(…)` 都加上 `auto: undefined`：

```tsx
                  onValueChange={(v) =>
                    setDraft(
                      v === 'signoff'
                        ? { ...draft, type: 'signoff', signers: [], signoffRule: 'all', auto: undefined }
                        : { ...draft, type: 'single', signers: undefined, signoffRule: undefined, auto: undefined },
                    )
                  }
```

3. 把 `{draft.scope === 'document' && (` 开头的勾选框整块替换为：

```tsx
            {draft.scope === 'requirement' && draft.type === 'single' && (
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={draft.auto === 'prd_status'} onCheckedChange={(v) => setDraft({ ...draft, auto: v ? 'prd_status' : undefined })} />
                跟随 PRD 状态（需求挂上 PRD 后由系统更新，不能手改）
              </label>
            )}
```

- [ ] **Step 3: 覆盖服务**

新建 `packages/core/src/documents/coverage.ts`：

```ts
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, products, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { productWorkflowBody } from '../requirements/context';
import { displayKey } from '../requirements/requirements';
import type { CheckItem } from '../requirements/workflow-runtime';
import type { DocumentStatus } from './constants';
import { loadDocument } from './documents';
import { documentDisplayKey, prdCheckState } from './markdown';

export function prdAutoItem(body: WorkflowBody): CheckItem | null {
  return body.checkItems.find((c) => c.auto === 'prd_status' && c.scope === 'requirement') ?? null;
}

/** 把被覆盖需求的「PRD」检查项写成 PRD 状态对应的结果；流程里没有 auto 项时什么也不做。调用方已锁住文档与这些需求。 */
export async function syncPrdCheck(tx: Tx, actor: Actor, doc: { id: string; productId: string; status: DocumentStatus }, requirementIds: string[]): Promise<void> {
  if (requirementIds.length === 0) return;
  const item = prdAutoItem(await productWorkflowBody(tx, doc.productId));
  if (!item) return;
  const state = prdCheckState(doc.status);
  const now = new Date();
  for (const id of requirementIds) {
    const [existing] = await tx
      .select()
      .from(checkItemResults)
      .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, id), eq(checkItemResults.itemKey, item.key)));
    const old = existing?.state ?? item.defaultState;
    if (old === state && existing) continue;
    if (existing) await tx.update(checkItemResults).set({ state, updatedBy: actor.memberId, updatedAt: now }).where(eq(checkItemResults.id, existing.id));
    else await tx.insert(checkItemResults).values({ orgId: actor.orgId, targetType: 'requirement', targetId: id, itemKey: item.key, state, updatedBy: actor.memberId, updatedAt: now });
    if (old === state) continue;
    await tx.update(requirements).set({ updatedAt: now }).where(eq(requirements.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'check_item.updated',
      subjectType: 'requirement',
      subjectId: id,
      actor,
      payload: { itemKey: item.key, auto: true, documentId: doc.id, changes: [{ field: 'state', old, new: state }] },
    });
  }
}

/** 在已有事务里把需求挂到 PRD 上（先锁 PRD，再按 id 升序锁需求）。已挂在这份 PRD 上的跳过。 */
export async function linkRequirementsTx(tx: Tx, actor: Actor, documentId: string, requirementIds: string[]): Promise<{ linked: number }> {
  const ids = [...new Set(requirementIds)].sort();
  if (ids.length === 0 || ids.length > 200) throw new AppError('invalid', '一次关联 1–200 条需求');
  const doc = await loadDocument(tx, documentId, { lock: true });
  await requireProductRole(tx, actor, doc.productId, 'editor');
  if (doc.status === 'discarded') throw new AppError('invalid', '已废弃的 PRD 不能再关联需求');
  const rows = await tx
    .select()
    .from(requirements)
    .where(and(inArray(requirements.id, ids), isNull(requirements.deletedAt)))
    .orderBy(asc(requirements.id))
    .for('update');
  if (rows.length !== ids.length) throw new AppError('invalid', '需求不存在');
  const keyRows = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, [...new Set(rows.map((r) => r.productId))]));
  const keyOf = new Map(keyRows.map((k) => [k.id, k.key]));
  const docKey = documentDisplayKey(keyOf.get(doc.productId) ?? '', doc.number);
  for (const r of rows) {
    const reqKey = displayKey(keyOf.get(r.productId)!, r.number);
    if (r.productId !== doc.productId) throw new AppError('invalid', `${reqKey} 不属于这份 PRD 所在的产品`);
    if (r.changeDocumentId && r.changeDocumentId !== doc.id) {
      const other = await loadDocument(tx, r.changeDocumentId);
      throw new AppError('conflict', `${reqKey} 已挂在 ${documentDisplayKey(keyOf.get(doc.productId)!, other.number)} 上，请先从那份 PRD 移出`);
    }
  }
  const fresh = rows.filter((r) => r.changeDocumentId !== doc.id);
  if (fresh.length === 0) return { linked: 0 };
  const now = new Date();
  for (const r of fresh) {
    await tx.update(requirements).set({ changeDocumentId: doc.id, updatedAt: now }).where(eq(requirements.id, r.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'requirement.updated',
      subjectType: 'requirement',
      subjectId: r.id,
      actor,
      payload: { changes: [{ field: 'changeDocumentId', old: null, new: doc.id }], document: docKey },
    });
  }
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: doc.productId,
    type: 'document.requirements_linked',
    subjectType: 'document',
    subjectId: doc.id,
    actor,
    payload: { requirementIds: fresh.map((r) => r.id) },
  });
  await syncPrdCheck(tx, actor, doc, fresh.map((r) => r.id));
  return { linked: fresh.length };
}

export async function linkDocumentRequirements(db: Db, actor: Actor, documentId: string, input: { requirementIds: string[] }): Promise<{ linked: number }> {
  return withOrg(db, actor.orgId, (tx) => linkRequirementsTx(tx, actor, documentId, input.requirementIds));
}

/** 从 PRD 移出一条需求。「PRD」检查项保留当时的值，之后恢复手工维护。 */
export async function unlinkDocumentRequirement(db: Db, actor: Actor, documentId: string, requirementId: string): Promise<void> {
  await withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, requirementId), isNull(requirements.deletedAt))).for('update');
    if (!r || r.changeDocumentId !== doc.id) throw new AppError('invalid', '该需求没有挂在这份 PRD 上');
    await tx.update(requirements).set({ changeDocumentId: null, updatedAt: new Date() }).where(eq(requirements.id, r.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'requirement.updated',
      subjectType: 'requirement',
      subjectId: r.id,
      actor,
      payload: { changes: [{ field: 'changeDocumentId', old: doc.id, new: null }] },
    });
    await recordEvent(tx, { orgId: actor.orgId, productId: doc.productId, type: 'document.requirement_unlinked', subjectType: 'document', subjectId: doc.id, actor, payload: { requirementId: r.id } });
  });
}
```

`syncPrdCheck` 里 `if (old === state && existing) continue;` 处理「已有结果且相同」；没有结果但默认状态恰好等于目标状态时仍插入一行结果（让需求详情显示「由系统更新」），不记事件。

- [ ] **Step 4: 新建时挂需求、流转时同步**

`packages/core/src/documents/documents.ts`：

1. import 区加 `import { linkRequirementsTx, syncPrdCheck } from './coverage';`（同样是两个文件互相引用，只在函数体内使用）。
2. `createDocument` 的 input 类型加 `requirementIds?: string[]`，并在 `await recordEvent(tx, { … type: 'document.created' … });` 之后、`return documentDetailInTx(tx, actor, doc.id);` 之前加：

```ts
    if (input.requirementIds?.length) await linkRequirementsTx(tx, actor, doc.id, input.requirementIds);
```

3. `transitionDocument` 中 `await recordEvent(tx, { … type: 'document.status_changed' … });` 之后加：

```ts
    const covered = await tx
      .select({ id: requirements.id })
      .from(requirements)
      .where(and(eq(requirements.changeDocumentId, id), isNull(requirements.deletedAt)))
      .orderBy(asc(requirements.id))
      .for('update');
    await syncPrdCheck(tx, actor, { id, productId: doc.productId, status: input.to }, covered.map((r) => r.id));
```

`packages/core/src/index.ts` 末尾加 `export * from './documents/coverage';`。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @flower/core test && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src packages/core/test apps/web/src/features/workflow/components/check-items.tsx docs/superpowers/specs/2026-09-28-flower-data-model-design.md
git commit -m "feat(core): PRD 覆盖需求，「PRD」检查项跟随 PRD 状态并禁止手改

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: PRD 上的检查项与会签：共享给覆盖的需求、等我签字、PRD 评审表

**Files:**
- Create: `packages/core/src/requirements/check-views.ts`（检查项视图的共用组装；需求检查状态合并所挂 PRD 的结果）
- Create: `packages/core/src/requirements/check-writes.ts`（普通检查项改状态、会签的共用写入）
- Modify: `packages/core/src/requirements/transitions.ts`（整文件替换：改用上面两个模块）
- Modify: `packages/core/src/requirements/detail.ts`（整文件替换：`changeDocument`、`documentCheckItems`，检查项视图改用共用组装）
- Modify: `packages/core/src/iterations/membership.ts`（准入条件合并 PRD 的结果）
- Modify: `packages/core/src/reviews/snapshot.ts`（整文件替换：`documentSnapshots`；`waitingFor` 可指定「评审已开始」）
- Create: `packages/core/src/documents/checks.ts`
- Modify: `packages/core/src/documents/documents.ts`（详情返回 PRD 检查项）
- Modify: `packages/core/src/workbench/workbench.ts`（等我签字包含评审中的 PRD）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/document-checks.test.ts`

**Interfaces:**
- Consumes: Task 5 `loadDocument`、`documentDetailInTx`；Task 7 `prdWorkflow`、`linkRequirementsTx`；现有 `signoffResultState`、`signoffProgress`、`waitingRules`、`matchingSignerRules`、`ReviewCell`、`ReviewWaiting`
- Produces:
  - `check-views.ts`：`type CheckItemView`（原 `detail.ts` 中的字段，加 `auto: boolean; locked: boolean`）；`buildCheckItemViews(tx: Tx, actor: Actor, role: ProductRole, items: CheckItem[], target: CheckTarget, opts: { lockedAuto: boolean }): Promise<CheckItemView[]>`；`requirementCheckStates(tx: Tx, body: WorkflowBody, req: { id: string; changeDocumentId: string | null }): Promise<Record<string, CheckState>>`
  - `check-writes.ts`：`type CheckTarget = { type: 'requirement' | 'document'; id: string }`；`type SignInput = { decision: 'passed' | 'rejected'; note?: string | null; ruleIndex?: number; onBehalf?: boolean }`；`assertCheckState(state: string): void`；`writeSingleCheck(tx, actor, target, item, input: { state: CheckState; note?: string | null }): Promise<Array<{ field: string; old: unknown; new: unknown }>>`；`writeSignoff(tx, actor, role, target, item, input: SignInput): Promise<{ old: CheckState; state: CheckState; ruleIndex: number }>`
  - `RequirementDetail` 增加 `changeDocument: { id: string; displayKey: string; title: string; status: DocumentStatus; source: 'native' | 'external' } | null` 与 `documentCheckItems: CheckItemView[]`
  - `snapshot.ts`：`documentSnapshots(tx: Tx, body: WorkflowBody, documentIds: string[]): Promise<Map<string, CheckSnapshot>>`；`waitingFor(items, snap, who, canSignOnBehalf, started?: boolean)`
  - `checks.ts`：`documentCheckItemViews(tx, actor, role, doc: { id: string; productId: string }): Promise<CheckItemView[]>`；`setDocumentCheckItemState(db, actor, documentId, itemKey, input: { state: CheckState; note?: string | null }): Promise<{ state: CheckState }>`；`signDocumentCheckItem(db, actor, documentId, itemKey, input: SignInput): Promise<{ state: CheckState }>`；`type DocumentReviewRow = { id: string; displayKey: string; title: string; source: 'native' | 'external'; status: DocumentStatus; owner: MemberRef | null; cells: Record<string, ReviewCell>; waiting: ReviewWaiting[] }`；`type DocumentReviewQueue = { columns: Array<{ key: string; label: string; type: 'single' | 'signoff' }>; rows: DocumentReviewRow[] }`；`listDocumentReviewQueue(db, actor, productId: string): Promise<DocumentReviewQueue>`
  - `WorkbenchSignature` 的 `requirementId` 改为 `string | null`，新增 `documentId: string | null`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/document-checks.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../src/auth/accounts';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { listDocumentReviewQueue, setDocumentCheckItemState, signDocumentCheckItem } from '../src/documents/checks';
import { createDocument, getDocumentByKey, transitionDocument } from '../src/documents/documents';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { setMemberFunctionTags } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { getWorkbench } from '../src/workbench/workbench';
import { createTestDb } from './db';
import { asMember, prdWorkflow, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let account: AccountView;
let owner: Actor;
let outsider: Actor;
let req: RequirementListItem;
let docId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ account, owner } = await seedInstance(t.db));
  const pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  await setMemberFunctionTags(t.db, owner, owner.memberId, [designTag]);
  const { version } = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  outsider = await asMember(t.db, owner, '没有设计标签的编辑');
  req = await createRequirement(t.db, owner, pan, { title: '分片上传' });
  docId = (await createDocument(t.db, owner, pan, { title: '上传 PRD', externalUrl: 'https://doc.weixin.qq.com/doc/up', requirementIds: [req.id] })).id;
});
afterAll(() => t.cleanup());

describe('PRD 上的检查项', () => {
  it('PRD 详情列出作用于 PRD 的检查项；需求详情显示所挂 PRD、共享的检查项，「PRD」项标为不可手改', async () => {
    const d = await getDocumentByKey(t.db, owner, 'PAN-PRD-1');
    expect(d.checkItems).toMatchObject([{ key: 'prd_review', type: 'signoff', state: 'not_started', canSign: [0] }]);
    const r = await getRequirementByKey(t.db, owner, req.displayKey);
    expect(r.changeDocument).toEqual({ id: docId, displayKey: 'PAN-PRD-1', title: '上传 PRD', status: 'draft', source: 'external' });
    expect(r.documentCheckItems.map((c) => c.key)).toEqual(['prd_review']);
    expect(r.checkItems.find((c) => c.key === 'prd')).toMatchObject({ state: 'in_progress', auto: true, locked: true });
    expect(r.checkItems.find((c) => c.key === 'feasibility')).toMatchObject({ auto: false, locked: false });
  });

  it('PRD 在评审中时进入「等我签字」与 PRD 评审表；签字结果挂在 PRD 上，覆盖的需求在流转条件中共享', async () => {
    expect((await getWorkbench(t.db, account.id)).signatures.items.filter((s) => s.documentId)).toEqual([]);
    await expect(transitionRequirement(t.db, owner, req.id, { to: 'doing' })).rejects.toMatchObject({
      code: 'invalid',
      details: { unmet: ['「PRD 评审」需为通过（当前：未开始）'] },
    });
    await transitionDocument(t.db, owner, docId, { to: 'review' });
    expect((await getWorkbench(t.db, account.id)).signatures.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ requirementId: null, documentId: docId, displayKey: 'PAN-PRD-1', itemLabel: 'PRD 评审', onBehalfOf: null })]),
    );
    const queue = await listDocumentReviewQueue(t.db, owner, req.productId);
    expect(queue.columns).toEqual([{ key: 'prd_review', label: 'PRD 评审', type: 'signoff' }]);
    expect(queue.rows).toMatchObject([{ displayKey: 'PAN-PRD-1', status: 'review', cells: { prd_review: { state: 'not_started', passed: 0, total: 1 } }, waiting: [{ itemKey: 'prd_review', ruleIndex: 0, onBehalf: false }] }]);

    await expect(signDocumentCheckItem(t.db, readOnlyToken(owner), docId, 'prd_review', { decision: 'passed' })).rejects.toMatchObject({ message: '只读 Token 不能签字' });
    await expect(signDocumentCheckItem(t.db, outsider, docId, 'prd_review', { decision: 'passed' })).rejects.toMatchObject({ message: '你不在该检查项的签字人中' });
    await expect(setDocumentCheckItemState(t.db, owner, docId, 'prd_review', { state: 'passed' })).rejects.toMatchObject({ message: '会签检查项的状态由签字结果决定' });
    expect(await signDocumentCheckItem(t.db, owner, docId, 'prd_review', { decision: 'passed' })).toEqual({ state: 'passed' });

    expect((await getRequirementByKey(t.db, owner, req.displayKey)).documentCheckItems[0]).toMatchObject({ state: 'passed', signoffs: [{ decision: 'passed' }] });
    expect(await transitionRequirement(t.db, owner, req.id, { to: 'doing' })).toEqual({ stateKey: 'doing' });
    expect((await getWorkbench(t.db, account.id)).signatures.items.filter((s) => s.documentId)).toEqual([]);
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/document-checks.test.ts`
Expected: FAIL，找不到 `../src/documents/checks`。

- [ ] **Step 2: 共用的检查项视图与写入**

新建 `packages/core/src/requirements/check-views.ts`：

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
import { checkItemResults, checkItemSignoffs, functionTags } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import type { Actor, ProductRole } from '../domain-types';
import { signerIdentity } from '../reviews/snapshot';
import type { CheckTarget } from './check-writes';
import { memberNames } from './context';
import type { CheckState } from './labels';
import type { MemberRef } from './requirements';
import { type CheckItem, checkStatesFor, matchingSignerRules } from './workflow-runtime';

export type CheckItemView = {
  key: string;
  label: string;
  type: 'single' | 'signoff';
  state: CheckState;
  note: string | null;
  meta: Record<string, unknown>;
  updatedAt: Date | null;
  updatedBy: MemberRef | null;
  signers: Array<{ index: number; by: 'function_tag' | 'member' | 'product_role'; ref: string; label: string }>;
  signoffRule: 'all' | 'any' | null;
  signoffs: Array<{ id: string; signer: MemberRef; actedBy: MemberRef | null; ruleIndex: number; decision: 'passed' | 'rejected'; note: string | null; at: Date }>;
  canSign: number[];
  canSignOnBehalf: number[];
  /** 跟随 PRD 状态的检查项。 */
  auto: boolean;
  /** 不能手动修改（需求已被 PRD 覆盖时的 auto 项）。 */
  locked: boolean;
};

const PRODUCT_ROLE_SIGNER_LABEL: Record<string, string> = { admin: '产品管理员', editor: '产品编辑', viewer: '产品只读成员' };

/** 一个对象（需求或 PRD）上若干检查项的视图：状态、备注、签字记录、本人可签与可代签的规则。 */
export async function buildCheckItemViews(
  tx: Tx,
  actor: Actor,
  role: ProductRole,
  items: CheckItem[],
  target: CheckTarget,
  opts: { lockedAuto: boolean },
): Promise<CheckItemView[]> {
  if (items.length === 0) return [];
  const results = await tx.select().from(checkItemResults).where(and(eq(checkItemResults.targetType, target.type), eq(checkItemResults.targetId, target.id)));
  const signoffs = results.length
    ? await tx.select().from(checkItemSignoffs).where(inArray(checkItemSignoffs.resultId, results.map((r) => r.id))).orderBy(asc(checkItemSignoffs.at), asc(checkItemSignoffs.id))
    : [];
  const signers = items.flatMap((c) => c.signers ?? []);
  const names = await memberNames(tx, [
    ...signoffs.flatMap((s) => [s.signerMemberId, s.actedByMemberId]),
    ...results.map((r) => r.updatedBy),
    ...signers.filter((s) => s.by === 'member').map((s) => s.ref),
  ]);
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  const tagIds = [...new Set(signers.filter((s) => s.by === 'function_tag').map((s) => s.ref))];
  const tagRows = tagIds.length ? await tx.select({ id: functionTags.id, name: functionTags.name }).from(functionTags).where(inArray(functionTags.id, tagIds)) : [];
  const tagName = new Map(tagRows.map((x) => [x.id, x.name]));
  const identity = await signerIdentity(tx, actor, role);
  const canWrite = actor.tokenScope?.access !== 'read';
  return items.map((c) => {
    const result = results.find((r) => r.itemKey === c.key);
    const list = (c.signers ?? []).map((s, index) => ({
      index,
      by: s.by,
      ref: s.ref,
      label: s.by === 'function_tag' ? (tagName.get(s.ref) ?? '已删除的标签') : s.by === 'member' ? (names.get(s.ref) ?? '已删除的成员') : (PRODUCT_ROLE_SIGNER_LABEL[s.ref] ?? s.ref),
    }));
    return {
      key: c.key,
      label: c.label,
      type: c.type,
      state: result?.state ?? c.defaultState,
      note: result?.note ?? null,
      meta: result?.meta ?? {},
      updatedAt: result?.updatedAt ?? null,
      updatedBy: ref(result?.updatedBy ?? null),
      signers: list,
      signoffRule: c.signoffRule ?? null,
      signoffs: signoffs
        .filter((s) => s.resultId === result?.id)
        .map((s) => ({ id: s.id, signer: ref(s.signerMemberId)!, actedBy: ref(s.actedByMemberId), ruleIndex: s.signerRuleIndex, decision: s.decision, note: s.note, at: s.at })),
      canSign: c.type === 'signoff' && canWrite ? matchingSignerRules(c, identity) : [],
      canSignOnBehalf: c.type === 'signoff' && role === 'admin' && canWrite ? list.filter((s) => s.by === 'member' && s.ref !== actor.memberId).map((s) => s.index) : [],
      auto: c.auto === 'prd_status',
      locked: c.auto === 'prd_status' && opts.lockedAuto,
    };
  });
}

/** 需求的检查状态：作用于需求的项取需求自己的结果，作用于 PRD 的项取所挂 PRD 的结果（没挂 PRD 时为默认状态）。 */
export async function requirementCheckStates(tx: Tx, body: WorkflowBody, req: { id: string; changeDocumentId: string | null }): Promise<Record<string, CheckState>> {
  const docKeys = new Set(body.checkItems.filter((c) => c.scope === 'document').map((c) => c.key));
  const own = await tx
    .select({ itemKey: checkItemResults.itemKey, state: checkItemResults.state })
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, req.id)));
  const shared = req.changeDocumentId
    ? await tx
        .select({ itemKey: checkItemResults.itemKey, state: checkItemResults.state })
        .from(checkItemResults)
        .where(and(eq(checkItemResults.targetType, 'document'), eq(checkItemResults.targetId, req.changeDocumentId)))
    : [];
  return checkStatesFor(body, [...own.filter((r) => !docKeys.has(r.itemKey)), ...shared.filter((r) => docKeys.has(r.itemKey))]);
}
```

新建 `packages/core/src/requirements/check-writes.ts`：

```ts
import { and, asc, eq } from 'drizzle-orm';
import { checkItemResults, checkItemSignoffs, memberFunctionTags } from '../db/schema';
import type { Tx } from '../db/tx';
import { CHECK_STATES } from '../definitions/workflow-schema';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import type { CheckState } from './labels';
import { type CheckItem, matchingSignerRules, signoffResultState } from './workflow-runtime';

export type CheckTarget = { type: 'requirement' | 'document'; id: string };
export type SignInput = { decision: 'passed' | 'rejected'; note?: string | null; ruleIndex?: number; onBehalf?: boolean };

export function assertCheckState(state: string): void {
  if (!(CHECK_STATES as readonly string[]).includes(state)) throw new AppError('invalid', '检查状态无效');
}

async function ensureResult(tx: Tx, orgId: string, target: CheckTarget, itemKey: string, defaultState: CheckState) {
  const [existing] = await tx
    .select()
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, target.type), eq(checkItemResults.targetId, target.id), eq(checkItemResults.itemKey, itemKey)));
  if (existing) return existing;
  const [row] = await tx.insert(checkItemResults).values({ orgId, targetType: target.type, targetId: target.id, itemKey, state: defaultState }).returning();
  return row!;
}

/** 普通检查项改状态与备注，返回修改事件用的 changes。调用方已锁住对象并校验了权限。 */
export async function writeSingleCheck(
  tx: Tx,
  actor: Actor,
  target: CheckTarget,
  item: CheckItem,
  input: { state: CheckState; note?: string | null },
): Promise<Array<{ field: string; old: unknown; new: unknown }>> {
  if (item.type === 'signoff') throw new AppError('invalid', '会签检查项的状态由签字结果决定');
  const result = await ensureResult(tx, actor.orgId, target, item.key, item.defaultState);
  const note = input.note === undefined ? result.note : input.note?.trim() || null;
  await tx.update(checkItemResults).set({ state: input.state, note, updatedBy: actor.memberId, updatedAt: new Date() }).where(eq(checkItemResults.id, result.id));
  return [
    { field: 'state', old: result.state, new: input.state },
    { field: 'note', old: result.note, new: note },
  ].filter((c) => c.old !== c.new);
}

/**
 * 会签：本人按匹配的签字规则签，或产品管理员代「指定成员」规则签（acted_by 记实际操作人）。
 * 调用方已锁住对象、拒绝了只读 Token，并取得操作者在该产品上的角色。
 */
export async function writeSignoff(
  tx: Tx,
  actor: Actor,
  role: ProductRole,
  target: CheckTarget,
  item: CheckItem,
  input: SignInput,
): Promise<{ old: CheckState; state: CheckState; ruleIndex: number }> {
  if (item.type !== 'signoff') throw new AppError('invalid', '该检查项不需要会签');
  let signer = actor.memberId;
  let actedBy: string | null = null;
  let ruleIndex: number;
  if (input.onBehalf) {
    if (role !== 'admin') throw new AppError('forbidden', '只有产品管理员可以代签');
    const rule = input.ruleIndex === undefined ? undefined : item.signers?.[input.ruleIndex];
    if (!rule || rule.by !== 'member') throw new AppError('invalid', '只能代签"指定成员"类的签字规则');
    if (rule.ref === actor.memberId) throw new AppError('invalid', '不能代自己签字');
    ruleIndex = input.ruleIndex!;
    signer = rule.ref;
    actedBy = actor.memberId;
  } else {
    const tags = await tx.select({ tagId: memberFunctionTags.tagId }).from(memberFunctionTags).where(eq(memberFunctionTags.memberId, actor.memberId));
    const matches = matchingSignerRules(item, { memberId: actor.memberId, functionTagIds: tags.map((x) => x.tagId), productRole: role });
    if (matches.length === 0) throw new AppError('forbidden', '你不在该检查项的签字人中');
    if (input.ruleIndex !== undefined && !matches.includes(input.ruleIndex)) throw new AppError('forbidden', '你不能代表这条签字规则签字');
    ruleIndex = input.ruleIndex ?? matches[0]!;
  }
  const result = await ensureResult(tx, actor.orgId, target, item.key, item.defaultState);
  const now = new Date();
  await tx.insert(checkItemSignoffs).values({
    orgId: actor.orgId,
    resultId: result.id,
    signerMemberId: signer,
    actedByMemberId: actedBy,
    signerRuleIndex: ruleIndex,
    decision: input.decision,
    note: input.note?.trim() || null,
    at: now,
  });
  const all = await tx.select().from(checkItemSignoffs).where(eq(checkItemSignoffs.resultId, result.id)).orderBy(asc(checkItemSignoffs.at), asc(checkItemSignoffs.id));
  const state = signoffResultState(item, all.map((s) => ({ signerRuleIndex: s.signerRuleIndex, decision: s.decision, at: s.at })));
  await tx.update(checkItemResults).set({ state, updatedBy: actor.memberId, updatedAt: now }).where(eq(checkItemResults.id, result.id));
  return { old: result.state, state, ruleIndex };
}
```

- [ ] **Step 3: 需求侧改用共用模块**

把 `packages/core/src/requirements/transitions.ts` 整个替换为：

```ts
import { eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { fieldDefinitions, fieldValues, requirements, stateTransitions } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { requirementCheckStates } from './check-views';
import { assertCheckState, type SignInput, writeSignoff, writeSingleCheck } from './check-writes';
import { effectiveFields, loadRequirementForUpdate, productWorkflowBody } from './context';
import type { CheckState } from './labels';
import { findTransitionRule, unmetConditions } from './workflow-runtime';

export async function transitionRequirement(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { to: string; force?: boolean; reason?: string },
): Promise<{ stateKey: string }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    const role = await requireProductRole(tx, actor, cur.productId, 'editor');
    const body = await productWorkflowBody(tx, cur.productId);
    const target = body.states.find((s) => s.key === input.to);
    if (!target) throw new AppError('invalid', '目标状态不存在');
    if (input.to === cur.stateKey) throw new AppError('invalid', '需求已处于该状态');
    const reason = input.reason?.trim() || null;
    if (input.force) {
      if (role !== 'admin') throw new AppError('forbidden', '只有产品管理员可以强制流转');
      if (!reason || reason.length > 500) throw new AppError('invalid', '强制流转必须填写原因（不超过 500 个字符）');
    } else {
      const from = body.states.find((s) => s.key === cur.stateKey)?.label ?? cur.stateKey;
      const rule = findTransitionRule(body, cur.stateKey, input.to);
      if (!rule) throw new AppError('invalid', `不能从「${from}」流转到「${target.label}」`);
      const fields = await effectiveFields(tx, cur.productId);
      const filled = await tx
        .selectDistinct({ key: fieldDefinitions.key })
        .from(fieldValues)
        .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
        .where(eq(fieldValues.entityId, requirementId));
      const unmet = unmetConditions(
        rule.conditions,
        {
          checks: await requirementCheckStates(tx, body, cur),
          filledFields: new Set(filled.map((f) => f.key)),
          hasIteration: cur.iterationId !== null,
          hasChangeDocument: cur.changeDocumentId !== null,
        },
        { checkItem: (k) => body.checkItems.find((c) => c.key === k)?.label ?? k, field: (k) => fields.get(k)?.label ?? k },
      );
      if (unmet.length > 0) throw new AppError('invalid', '流转条件未满足', { unmet: unmet.map((u) => u.message) });
    }
    const now = new Date();
    await tx.update(requirements).set({ stateKey: input.to, stateChangedAt: now, updatedAt: now }).where(eq(requirements.id, requirementId));
    await tx.insert(stateTransitions).values({
      orgId: actor.orgId,
      requirementId,
      fromState: cur.stateKey,
      toState: input.to,
      actorMemberId: actor.memberId,
      tokenId: actor.tokenId,
      forced: !!input.force,
      reason: input.force ? reason : null,
      at: now,
    });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.state_changed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { changes: [{ field: 'stateKey', old: cur.stateKey, new: input.to }], forced: !!input.force, reason: input.force ? reason : null },
    });
    return { stateKey: input.to };
  });
}

export async function setCheckItemState(
  db: Db,
  actor: Actor,
  requirementId: string,
  itemKey: string,
  input: { state: CheckState; note?: string | null },
): Promise<{ state: CheckState }> {
  assertCheckState(input.state);
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const body = await productWorkflowBody(tx, cur.productId);
    const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'requirement');
    if (!item) throw new AppError('not_found', '检查项不存在');
    if (item.auto === 'prd_status' && cur.changeDocumentId) throw new AppError('invalid', '「PRD」检查项跟随所挂 PRD 的状态，不能手动修改');
    const changes = await writeSingleCheck(tx, actor, { type: 'requirement', id: requirementId }, item, input);
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'check_item.updated',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { itemKey, changes },
    });
    return { state: input.state };
  });
}

export async function signCheckItem(db: Db, actor: Actor, requirementId: string, itemKey: string, input: SignInput): Promise<{ state: CheckState }> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能签字');
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    const role = await requireProductRole(tx, actor, cur.productId, 'viewer');
    const body = await productWorkflowBody(tx, cur.productId);
    const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'requirement');
    if (!item) throw new AppError('not_found', '检查项不存在');
    const r = await writeSignoff(tx, actor, role, { type: 'requirement', id: requirementId }, item, input);
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'check_item.signed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { itemKey, ruleIndex: r.ruleIndex, decision: input.decision, onBehalf: !!input.onBehalf, changes: r.old === r.state ? [] : [{ field: 'state', old: r.old, new: r.state }] },
    });
    return { state: r.state };
  });
}
```

`packages/core/src/iterations/membership.ts` 的 `joinIterationUnmet`：删去 `const results = await tx.select({ itemKey…})…;` 那条查询，`checks: checkStatesFor(body, results),` 改为 `checks: await requirementCheckStates(tx, body, req),`；import 里去掉 `checkItemResults` 与 `checkStatesFor`（若不再使用），加 `import { requirementCheckStates } from '../requirements/check-views';`。

- [ ] **Step 4: 需求详情**

把 `packages/core/src/requirements/detail.ts` 整个替换为：

```ts
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { productRoleOf } from '../access/permissions';
import type { Db } from '../db/client';
import {
  blockers,
  documents,
  entityAliases,
  fieldDefinitions,
  fieldOptions,
  fieldValues,
  functionTags,
  products,
  releases,
  requirementAssignments,
  requirementRelations,
  requirementReleases,
  requirements,
  stateTransitions,
  tasks,
} from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { DocumentStatus } from '../documents/constants';
import { documentDisplayKey } from '../documents/markdown';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { joinIterationUnmet } from '../iterations/membership';
import { buildCheckItemViews, type CheckItemView, requirementCheckStates } from './check-views';
import { effectiveFields, memberNames, productWorkflowBody } from './context';
import { displayKey, hydrateList, type MemberRef, type OptionRef, type RequirementListItem } from './requirements';
import { availableTransitions, type TransitionOption, type UnmetCondition } from './workflow-runtime';

export type RequirementDetail = RequirementListItem & {
  productKey: string;
  description: string;
  createdAt: Date;
  stateChangedAt: Date;
  myRole: ProductRole;
  canForce: boolean;
  workflow: { states: Array<{ key: string; label: string; color: string; category: string; group: string; order: number }> };
  fields: Array<{ key: string; label: string; cardinality: 'single' | 'multi'; options: OptionRef[] }>;
  checkItems: CheckItemView[];
  /** 所挂的变更 PRD。 */
  changeDocument: { id: string; displayKey: string; title: string; status: DocumentStatus; source: 'native' | 'external' } | null;
  /** 所挂 PRD 上作用于 PRD 的检查项（覆盖的需求共享）。 */
  documentCheckItems: CheckItemView[];
  transitions: TransitionOption[];
  joinIterationUnmet: UnmetCondition[];
  history: Array<{ from: string | null; to: string; actor: MemberRef | null; forced: boolean; reason: string | null; at: Date }>;
  assignments: Array<{ id: string; member: MemberRef; functionTag: { id: string; name: string } | null; platform: OptionRef | null }>;
  blockers: Array<{ id: string; description: string; status: 'active' | 'resolved'; owner: MemberRef | null; createdAt: Date; resolvedAt: Date | null }>;
  relations: Array<{ id: string; type: string; direction: 'out' | 'in'; other: { id: string; displayKey: string; title: string } }>;
  releases: Array<{ id: string; versionName: string; platform: OptionRef | null; status: 'planned' | 'released'; releasedAt: Date | null }>;
  tasks: Array<{ id: string; title: string; assignee: MemberRef | null; status: 'todo' | 'doing' | 'done'; planStart: string | null; planDays: number | null }>;
  aliases: string[];
};

async function resolveKey(tx: Tx, key: string): Promise<typeof requirements.$inferSelect> {
  const m = /^([A-Z][A-Z0-9]{1,9})-(\d{1,9})$/.exec(key.trim());
  let row: typeof requirements.$inferSelect | undefined;
  if (m) {
    [row] = await tx
      .select({ r: requirements })
      .from(requirements)
      .innerJoin(products, eq(products.id, requirements.productId))
      .where(and(eq(products.key, m[1]!), eq(requirements.number, Number(m[2])), isNull(requirements.deletedAt), isNull(products.deletedAt)))
      .then((rows) => rows.map((x) => x.r));
  }
  if (!row) {
    const [alias] = await tx.select().from(entityAliases).where(and(eq(entityAliases.alias, key.trim()), eq(entityAliases.entityType, 'requirement')));
    if (alias) [row] = await tx.select().from(requirements).where(and(eq(requirements.id, alias.entityId), isNull(requirements.deletedAt)));
  }
  if (!row) throw new AppError('not_found', '需求不存在');
  return row;
}

export async function getRequirementByKey(db: Db, actor: Actor, key: string): Promise<RequirementDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const row = await resolveKey(tx, key);
    const role = await productRoleOf(tx, actor, row.productId);
    if (!role) throw new AppError('not_found', '需求不存在');
    const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.id, row.productId));
    const [base] = await hydrateList(tx, product!.key, [row]);
    const body = await productWorkflowBody(tx, row.productId);
    const fields = await effectiveFields(tx, row.productId);

    const values = await tx
      .select({ fieldId: fieldValues.fieldId, fieldKey: fieldDefinitions.key, id: fieldOptions.id, key: fieldOptions.key, label: fieldOptions.label, color: fieldOptions.color, sort: fieldOptions.sort })
      .from(fieldValues)
      .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
      .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
      .where(eq(fieldValues.entityId, row.id));
    const fieldList = [...fields.values()].map((f) => ({
      key: f.key,
      label: f.label,
      cardinality: f.cardinality,
      options: values
        .filter((v) => v.fieldKey === f.key)
        .sort((a, b) => a.sort - b.sort)
        .map((v) => ({ id: v.id, key: v.key, label: v.label, color: v.color })),
    }));

    const history = await tx
      .select()
      .from(stateTransitions)
      .where(eq(stateTransitions.requirementId, row.id))
      .orderBy(asc(stateTransitions.at), asc(stateTransitions.id));
    const assignments = await tx.select().from(requirementAssignments).where(eq(requirementAssignments.requirementId, row.id));
    const blockerRows = await tx.select().from(blockers).where(eq(blockers.requirementId, row.id)).orderBy(asc(blockers.createdAt));
    const relationRows = await tx
      .select()
      .from(requirementRelations)
      .where(or(eq(requirementRelations.fromId, row.id), eq(requirementRelations.toId, row.id)));
    const releaseRows = await tx
      .select({ r: releases })
      .from(requirementReleases)
      .innerJoin(releases, eq(releases.id, requirementReleases.releaseId))
      .where(eq(requirementReleases.requirementId, row.id));
    const taskRows = await tx.select().from(tasks).where(eq(tasks.requirementId, row.id)).orderBy(asc(tasks.planStart), asc(tasks.createdAt));
    const aliasRows = await tx.select({ alias: entityAliases.alias }).from(entityAliases).where(eq(entityAliases.entityId, row.id));
    const [docRow] = row.changeDocumentId ? await tx.select().from(documents).where(and(eq(documents.id, row.changeDocumentId), isNull(documents.deletedAt))) : [];

    const names = await memberNames(tx, [
      ...history.map((h) => h.actorMemberId),
      ...assignments.map((a) => a.memberId),
      ...blockerRows.map((b) => b.ownerMemberId),
      ...taskRows.map((x) => x.assigneeMemberId),
    ]);
    const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
    const tagIds = [...new Set(assignments.map((a) => a.functionTagId).filter((x): x is string => !!x))];
    const tagRows = tagIds.length ? await tx.select({ id: functionTags.id, name: functionTags.name }).from(functionTags).where(inArray(functionTags.id, tagIds)) : [];
    const tagName = new Map(tagRows.map((x) => [x.id, x.name]));
    const optionIds = [
      ...new Set([...assignments.map((a) => a.platformOptionId), ...releaseRows.map((x) => x.r.platformOptionId)].filter((x): x is string => !!x)),
    ];
    const optionRows = optionIds.length ? await tx.select().from(fieldOptions).where(inArray(fieldOptions.id, optionIds)) : [];
    const optionRef = (id: string | null): OptionRef | null => {
      const o = id ? optionRows.find((x) => x.id === id) : undefined;
      return o ? { id: o.id, key: o.key, label: o.label, color: o.color } : null;
    };
    const otherIds = [...new Set(relationRows.map((r) => (r.fromId === row.id ? r.toId : r.fromId)))];
    const otherRows = otherIds.length
      ? await tx
          .select({ r: requirements, productKey: products.key })
          .from(requirements)
          .innerJoin(products, eq(products.id, requirements.productId))
          .where(and(inArray(requirements.id, otherIds), isNull(requirements.deletedAt), isNull(products.deletedAt)))
      : [];
    const otherProductIds = [...new Set(otherRows.map((x) => x.r.productId).filter((id) => id !== row.productId))];
    const otherRoles = new Map<string, ProductRole | null>();
    for (const pid of otherProductIds) otherRoles.set(pid, await productRoleOf(tx, actor, pid));
    const others = otherRows
      .filter((x) => x.r.productId === row.productId || otherRoles.get(x.r.productId))
      .map((x) => ({ id: x.r.id, number: x.r.number, title: x.r.title, productKey: x.productKey }));

    const checkItems = await buildCheckItemViews(tx, actor, role, body.checkItems.filter((c) => c.scope === 'requirement'), { type: 'requirement', id: row.id }, { lockedAuto: !!docRow });
    const documentCheckItems = docRow
      ? await buildCheckItemViews(tx, actor, role, body.checkItems.filter((c) => c.scope === 'document'), { type: 'document', id: docRow.id }, { lockedAuto: false })
      : [];
    const ctx = {
      checks: await requirementCheckStates(tx, body, row),
      filledFields: new Set(fieldList.filter((f) => f.options.length > 0).map((f) => f.key)),
      hasIteration: row.iterationId !== null,
      hasChangeDocument: row.changeDocumentId !== null,
    };
    const lookup = { checkItem: (k: string) => body.checkItems.find((c) => c.key === k)?.label ?? k, field: (k: string) => fields.get(k)?.label ?? k };

    return {
      ...base!,
      productKey: product!.key,
      description: row.description,
      createdAt: row.createdAt,
      stateChangedAt: row.stateChangedAt,
      myRole: role,
      canForce: role === 'admin',
      workflow: { states: [...body.states].sort((a, b) => a.order - b.order).map((s) => ({ key: s.key, label: s.label, color: s.color, category: s.category, group: s.group, order: s.order })) },
      fields: fieldList,
      checkItems,
      changeDocument: docRow ? { id: docRow.id, displayKey: documentDisplayKey(product!.key, docRow.number), title: docRow.title, status: docRow.status, source: docRow.source } : null,
      documentCheckItems,
      transitions: availableTransitions(body, row.stateKey, ctx, lookup),
      joinIterationUnmet: await joinIterationUnmet(tx, body, row),
      history: history.map((h) => ({ from: h.fromState, to: h.toState, actor: ref(h.actorMemberId), forced: h.forced, reason: h.reason, at: h.at })),
      assignments: assignments.map((a) => ({
        id: a.id,
        member: ref(a.memberId)!,
        functionTag: a.functionTagId ? { id: a.functionTagId, name: tagName.get(a.functionTagId) ?? '' } : null,
        platform: optionRef(a.platformOptionId),
      })),
      blockers: blockerRows.map((b) => ({ id: b.id, description: b.description, status: b.status, owner: ref(b.ownerMemberId), createdAt: b.createdAt, resolvedAt: b.resolvedAt })),
      relations: relationRows
        .map((r) => {
          const otherId = r.fromId === row.id ? r.toId : r.fromId;
          const o = others.find((x) => x.id === otherId);
          if (!o) return null;
          return { id: r.id, type: r.type, direction: r.fromId === row.id ? ('out' as const) : ('in' as const), other: { id: otherId, displayKey: displayKey(o.productKey, o.number), title: o.title } };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
      releases: releaseRows.map(({ r }) => ({ id: r.id, versionName: r.versionName, platform: optionRef(r.platformOptionId), status: r.status, releasedAt: r.releasedAt })),
      tasks: taskRows.map((x) => ({ id: x.id, title: x.title, assignee: ref(x.assigneeMemberId), status: x.status, planStart: x.planStart, planDays: x.planDays })),
      aliases: aliasRows.map((a) => a.alias).sort(),
    };
  });
}
```

`packages/core/src/index.ts`：在 `export * from './requirements/detail';` 之前加 `export * from './requirements/check-views';` 与 `export * from './requirements/check-writes';`。

- [ ] **Step 5: 快照、PRD 检查项服务与工作台**

把 `packages/core/src/reviews/snapshot.ts` 整个替换为：

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
import { checkItemResults, checkItemSignoffs, memberFunctionTags, members, requirementAssignments } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import type { Actor, ProductRole } from '../domain-types';
import type { CheckState } from '../requirements/labels';
import {
  type CheckItem,
  checkStatesFor,
  reviewStarted,
  type SignerIdentity,
  type SignoffRecord,
  waitingRules,
  type WaitingRule,
} from '../requirements/workflow-runtime';

export type CheckSnapshot = {
  states: Record<string, CheckState>;
  signoffs: Map<string, SignoffRecord[]>;
  /** 职能标签 id → 以该标签分配到这条需求的成员 id（requirement_assignments 中带职能标签的行）。PRD 上没有分配，恒为空。 */
  assignees: Map<string, Set<string>>;
};

/** 一批对象的检查项结果（按对象分组）与会签记录（按结果分组、按时间排序）。 */
async function loadResults(tx: Tx, targetType: 'requirement' | 'document', ids: string[]) {
  const results = ids.length
    ? await tx
        .select({ id: checkItemResults.id, targetId: checkItemResults.targetId, itemKey: checkItemResults.itemKey, state: checkItemResults.state })
        .from(checkItemResults)
        .where(and(eq(checkItemResults.targetType, targetType), inArray(checkItemResults.targetId, ids)))
    : [];
  const signoffs = results.length
    ? await tx
        .select({ resultId: checkItemSignoffs.resultId, signerRuleIndex: checkItemSignoffs.signerRuleIndex, decision: checkItemSignoffs.decision, at: checkItemSignoffs.at })
        .from(checkItemSignoffs)
        .where(inArray(checkItemSignoffs.resultId, results.map((r) => r.id)))
        .orderBy(asc(checkItemSignoffs.at), asc(checkItemSignoffs.id))
    : [];
  const byResult = new Map<string, SignoffRecord[]>();
  for (const s of signoffs) {
    const list = byResult.get(s.resultId) ?? [];
    list.push({ signerRuleIndex: s.signerRuleIndex, decision: s.decision, at: s.at });
    byResult.set(s.resultId, list);
  }
  const byTarget = new Map<string, typeof results>();
  for (const r of results) {
    const list = byTarget.get(r.targetId) ?? [];
    list.push(r);
    byTarget.set(r.targetId, list);
  }
  return (body: WorkflowBody, id: string, assignees: Map<string, Set<string>>): CheckSnapshot => {
    const mine = byTarget.get(id) ?? [];
    return {
      states: checkStatesFor(body, mine.map((r) => ({ itemKey: r.itemKey, state: r.state }))),
      signoffs: new Map(mine.map((r) => [r.itemKey, byResult.get(r.id) ?? []])),
      assignees,
    };
  };
}

/** 一批需求的检查项状态（缺省按流程默认状态）、会签记录（按检查项分组、按时间排序）与按职能标签的分配。 */
export async function checkSnapshots(tx: Tx, body: WorkflowBody, requirementIds: string[]): Promise<Map<string, CheckSnapshot>> {
  const snapshotOf = await loadResults(tx, 'requirement', requirementIds);
  // 只把在职、且当前持有该标签的被分配人计入 assignees；否则 waitingRules 视同没有有效分配，回退为推给全部持有者。
  const assignmentRows = requirementIds.length
    ? await tx
        .select({ requirementId: requirementAssignments.requirementId, memberId: requirementAssignments.memberId, tagId: requirementAssignments.functionTagId })
        .from(requirementAssignments)
        .innerJoin(members, eq(members.id, requirementAssignments.memberId))
        .innerJoin(
          memberFunctionTags,
          and(eq(memberFunctionTags.memberId, requirementAssignments.memberId), eq(memberFunctionTags.tagId, requirementAssignments.functionTagId)),
        )
        .where(and(inArray(requirementAssignments.requirementId, requirementIds), eq(members.status, 'active')))
    : [];
  const assigneesByRequirement = new Map<string, Map<string, Set<string>>>();
  for (const a of assignmentRows) {
    if (!a.tagId) continue;
    const byTag = assigneesByRequirement.get(a.requirementId) ?? new Map<string, Set<string>>();
    const set = byTag.get(a.tagId) ?? new Set<string>();
    set.add(a.memberId);
    byTag.set(a.tagId, set);
    assigneesByRequirement.set(a.requirementId, byTag);
  }
  return new Map(requirementIds.map((id) => [id, snapshotOf(body, id, assigneesByRequirement.get(id) ?? new Map())]));
}

/** 一批 PRD 的检查项状态与会签记录。 */
export async function documentSnapshots(tx: Tx, body: WorkflowBody, documentIds: string[]): Promise<Map<string, CheckSnapshot>> {
  const snapshotOf = await loadResults(tx, 'document', documentIds);
  return new Map(documentIds.map((id) => [id, snapshotOf(body, id, new Map())]));
}

/** 操作者作为签字人的身份：成员本人、职能标签、在该产品上的角色。 */
export async function signerIdentity(tx: Tx, actor: Actor, role: ProductRole): Promise<SignerIdentity> {
  const tags = await tx.select({ tagId: memberFunctionTags.tagId }).from(memberFunctionTags).where(eq(memberFunctionTags.memberId, actor.memberId));
  return { memberId: actor.memberId, functionTagIds: tags.map((x) => x.tagId), productRole: role };
}

export type ItemWaiting = WaitingRule & { itemKey: string };

/**
 * 一个对象上操作者等待处理的全部会签规则：按检查项逐个装配 waitingRules 需要的上下文并调用它。
 * 评审是否已开始：需求按 reviewStarted 判断；PRD 由调用方传入 started（处于评审中）。
 */
export function waitingFor(items: CheckItem[], snap: CheckSnapshot, who: SignerIdentity, canSignOnBehalf: boolean, started?: boolean): ItemWaiting[] {
  const begun = started ?? reviewStarted(items, snap.states);
  const out: ItemWaiting[] = [];
  for (const item of items) {
    const state = snap.states[item.key];
    if (state === undefined) continue;
    const signoffs = snap.signoffs.get(item.key) ?? [];
    const rules = waitingRules(item, {
      state,
      signedRules: new Set(signoffs.map((s) => s.signerRuleIndex)),
      reviewStarted: begun,
      who,
      canSignOnBehalf,
      assignees: snap.assignees,
    });
    for (const w of rules) out.push({ itemKey: item.key, ...w });
  }
  return out;
}
```

新建 `packages/core/src/documents/checks.ts`：

```ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documents, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { buildCheckItemViews, type CheckItemView } from '../requirements/check-views';
import { assertCheckState, type SignInput, writeSignoff, writeSingleCheck } from '../requirements/check-writes';
import { memberNames, productWorkflowBody } from '../requirements/context';
import type { CheckState } from '../requirements/labels';
import type { MemberRef } from '../requirements/requirements';
import { signoffProgress } from '../requirements/workflow-runtime';
import type { ReviewCell, ReviewWaiting } from '../reviews/queue';
import { documentSnapshots, signerIdentity, waitingFor } from '../reviews/snapshot';
import type { DocumentStatus } from './constants';
import { loadDocument } from './documents';
import { documentDisplayKey } from './markdown';

export type DocumentReviewRow = {
  id: string;
  displayKey: string;
  title: string;
  source: 'native' | 'external';
  status: DocumentStatus;
  owner: MemberRef | null;
  cells: Record<string, ReviewCell>;
  waiting: ReviewWaiting[];
};
export type DocumentReviewQueue = { columns: Array<{ key: string; label: string; type: 'single' | 'signoff' }>; rows: DocumentReviewRow[] };

export async function documentCheckItemViews(tx: Tx, actor: Actor, role: ProductRole, doc: { id: string; productId: string }): Promise<CheckItemView[]> {
  const body = await productWorkflowBody(tx, doc.productId);
  return buildCheckItemViews(tx, actor, role, body.checkItems.filter((c) => c.scope === 'document'), { type: 'document', id: doc.id }, { lockedAuto: false });
}

async function documentItem(tx: Tx, productId: string, itemKey: string) {
  const body = await productWorkflowBody(tx, productId);
  const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'document');
  if (!item) throw new AppError('not_found', '检查项不存在');
  return item;
}

export async function setDocumentCheckItemState(
  db: Db,
  actor: Actor,
  documentId: string,
  itemKey: string,
  input: { state: CheckState; note?: string | null },
): Promise<{ state: CheckState }> {
  assertCheckState(input.state);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    const item = await documentItem(tx, doc.productId, itemKey);
    const changes = await writeSingleCheck(tx, actor, { type: 'document', id: doc.id }, item, input);
    await tx.update(documents).set({ updatedAt: new Date() }).where(eq(documents.id, doc.id));
    await recordEvent(tx, { orgId: actor.orgId, productId: doc.productId, type: 'check_item.updated', subjectType: 'document', subjectId: doc.id, actor, payload: { itemKey, changes } });
    return { state: input.state };
  });
}

export async function signDocumentCheckItem(db: Db, actor: Actor, documentId: string, itemKey: string, input: SignInput): Promise<{ state: CheckState }> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能签字');
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    const role = await requireProductRole(tx, actor, doc.productId, 'viewer');
    const item = await documentItem(tx, doc.productId, itemKey);
    const r = await writeSignoff(tx, actor, role, { type: 'document', id: doc.id }, item, input);
    await tx.update(documents).set({ updatedAt: new Date() }).where(eq(documents.id, doc.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'check_item.signed',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { itemKey, ruleIndex: r.ruleIndex, decision: input.decision, onBehalf: !!input.onBehalf, changes: r.old === r.state ? [] : [{ field: 'state', old: r.old, new: r.state }] },
    });
    return { state: r.state };
  });
}

/** PRD 评审表：产品内处于评审中的 PRD，每个作用于 PRD 的检查项一列。 */
export async function listDocumentReviewQueue(db: Db, actor: Actor, productId: string): Promise<DocumentReviewQueue> {
  return withOrg(db, actor.orgId, async (tx) => {
    const role = await requireProductRole(tx, actor, productId, 'viewer');
    const body = await productWorkflowBody(tx, productId);
    const items = body.checkItems.filter((c) => c.scope === 'document');
    const columns = items.map((c) => ({ key: c.key, label: c.label, type: c.type }));
    if (items.length === 0) return { columns, rows: [] };
    const docRows = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.productId, productId), eq(documents.status, 'review'), isNull(documents.deletedAt)))
      .orderBy(desc(documents.number));
    const snaps = await documentSnapshots(tx, body, docRows.map((d) => d.id));
    const who = await signerIdentity(tx, actor, role);
    const canSign = actor.tokenScope?.access !== 'read';
    const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.id, productId));
    const names = await memberNames(tx, docRows.map((d) => d.ownerMemberId));
    const rows = docRows.map((d) => {
      const snap = snaps.get(d.id)!;
      const cells: Record<string, ReviewCell> = {};
      for (const c of items) {
        const progress = c.type === 'signoff' ? signoffProgress(c, snap.signoffs.get(c.key) ?? []) : null;
        cells[c.key] = { state: snap.states[c.key]!, passed: progress?.passed ?? null, total: progress?.total ?? null };
      }
      return {
        id: d.id,
        displayKey: documentDisplayKey(product!.key, d.number),
        title: d.title,
        source: d.source,
        status: d.status,
        owner: d.ownerMemberId ? { id: d.ownerMemberId, displayName: names.get(d.ownerMemberId) ?? '已删除的成员' } : null,
        cells,
        waiting: canSign ? waitingFor(items, snap, who, role === 'admin', true) : [],
      };
    });
    return { columns, rows };
  });
}
```

`packages/core/src/documents/documents.ts`：

1. import 区加 `import { documentCheckItemViews } from './checks';`
2. `detailOf` 返回对象里的 `checkItems: [],` 改为 `checkItems: await documentCheckItemViews(tx, actor, role, doc),`
3. `import type { CheckItemView } from '../requirements/detail';` 改为 `import type { CheckItemView } from '../requirements/check-views';`

`packages/core/src/workbench/workbench.ts`：

1. import 区：`import { checkItemResults, commentReads, comments, iterations, products, requirements, tasks } from '../db/schema';` 加入 `documents`；加 `import { documentDisplayKey } from '../documents/markdown';`；`import { checkSnapshots, signerIdentity, waitingFor } from '../reviews/snapshot';` 改为 `import { checkSnapshots, documentSnapshots, signerIdentity, waitingFor } from '../reviews/snapshot';`
2. `WorkbenchSignature` 类型的 `requirementId: string;` 改为：

```ts
  /** 需求上的签字为需求 id，PRD 上的签字为 null。 */
  requirementId: string | null;
  /** PRD 上的签字为 PRD id，需求上的签字为 null。 */
  documentId: string | null;
```

3. 需求签字 `signatures.push({ org, requirementId: r.id, …` 中加 `documentId: null,`。
4. 需求签字的 `for (const pid of new Set(candidates.map((r) => r.productId))) { … }` 整段之后加：

```ts
    // 等我签字（PRD）：评审中的 PRD 上、作用于 PRD 的会签检查项
    const docRows = await tx
      .select()
      .from(documents)
      .where(and(inArray(documents.productId, visible), eq(documents.status, 'review'), isNull(documents.deletedAt)));
    for (const pid of new Set(docRows.map((d) => d.productId))) {
      const body = await productWorkflowBody(tx, pid);
      const items = body.checkItems.filter((c) => c.scope === 'document');
      if (items.length === 0) continue;
      const rows = docRows.filter((d) => d.productId === pid);
      const role = (await productRoleOf(tx, actor, pid))!;
      const who = await signerIdentity(tx, actor, role);
      const snaps = await documentSnapshots(tx, body, rows.map((d) => d.id));
      const signerNames = await memberNames(tx, items.flatMap((c) => (c.signers ?? []).filter((s) => s.by === 'member').map((s) => s.ref)));
      for (const d of rows) {
        for (const w of waitingFor(items, snaps.get(d.id)!, who, role === 'admin', true)) {
          const item = items.find((c) => c.key === w.itemKey)!;
          signatures.push({
            org,
            requirementId: null,
            documentId: d.id,
            displayKey: documentDisplayKey(keyOf.get(pid)!, d.number),
            title: d.title,
            itemKey: w.itemKey,
            itemLabel: item.label,
            ruleIndex: w.ruleIndex,
            onBehalfOf: w.onBehalf ? (signerNames.get(item.signers![w.ruleIndex]!.ref) ?? '已删除的成员') : null,
          });
        }
      }
    }
```

`packages/core/src/index.ts` 末尾加 `export * from './documents/checks';`。

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @flower/core test && pnpm typecheck`
Expected: 全部通过（包括原有的 `review-queue`、`review-runtime`、`workbench`、`requirement-workflow`、`iteration-membership` 等测试，它们覆盖本任务改写的需求侧逻辑）。

`apps/web/src/app/(app)/[org]/page.tsx` 签字列表的 `key` 改为 `` `${s.requirementId ?? s.documentId}-${s.itemKey}-${s.ruleIndex}` ``（两份 PRD 上同一检查项的签字原来会得到相同的 key；链接在 Task 14 改）。Run: `pnpm --filter @flower/web typecheck && pnpm --filter @flower/web lint --max-warnings 0`，Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src apps/web/src/app/\(app\)/\[org\]/page.tsx packages/core/test/document-checks.test.ts
git commit -m "feat(core): PRD 上的检查项会签，覆盖的需求共享结果；等我签字与 PRD 评审表

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: 接口：PRD、修订、评论、检查项、覆盖需求、模板、图片上传与读取；存储配置与镜像

**Files:**
- Modify: `packages/core/src/config.ts`（`ServerConfig.storageDir`）
- Modify: `packages/core/test/config.test.ts`
- Modify: `apps/web/src/server/api.ts`（`ApiDeps.storage`；注册路由）
- Modify: `apps/web/src/server/runtime.ts`
- Modify: `apps/web/src/server/http.ts`（`readUpload`；`csvParam` 从需求路由移来共用）
- Modify: `apps/web/src/server/routes/requirements.ts`（改用 `csvParam`）
- Create: `apps/web/src/server/routes/documents.ts`
- Create: `apps/web/src/server/routes/templates.ts`
- Modify: `apps/web/test/api/helpers.ts`（`makeApp` 带临时存储目录；`upload` 辅助）
- Modify: `apps/web/playwright.config.ts`（`FLOWER_STORAGE_DIR`）
- Modify: `Dockerfile`、`docker-compose.yml`、`.env.example`、`scripts/smoke.sh`
- Test: `apps/web/test/api/documents.test.ts`

**Interfaces:**
- Consumes: Task 4–8 的全部服务函数
- Produces（HTTP，前缀 `/api/v1`）：
  - `GET /orgs/:org/products/:id/documents?status=a,b&owner=id,id&source=native|external&q=` → `{ documents: DocumentListItem[] }`
  - `POST /orgs/:org/products/:id/documents` `{ title, ownerMemberId?, templateId?, externalUrl?, requirementIds? }` → 201 `{ document: DocumentDetail }`
  - `GET /orgs/:org/documents/:key`（`PAN-PRD-1`）→ `{ document }`；`PATCH /orgs/:org/documents/:id` `{ title?, ownerMemberId?, externalUrl? }` → `{ document }`
  - `PUT /orgs/:org/documents/:id/content` `{ baseVersion, markdown, title? }` → `SaveResult`（409 时 `error.details.version`）
  - `POST /orgs/:org/documents/:id/convert` `{ baseVersion, markdown }` → `SaveResult`
  - `POST /orgs/:org/documents/:id/transitions` `{ to }` → `{ document }`
  - `GET /orgs/:org/documents/:id/revisions` → `{ revisions }`；`GET …/revisions/:number` → `{ revision }`；`GET …/diff?from=&to=` → `{ diff: RevisionDiff }`；`POST …/restore` `{ number, baseVersion }` → `SaveResult`
  - `POST /orgs/:org/documents/:id/requirements` `{ requirementIds }` → `{ linked }`；`DELETE /orgs/:org/documents/:id/requirements/:requirementId` → 204
  - `GET|POST /orgs/:org/documents/:id/comments`（POST `{ body, parentId?, anchor? }` → 201 `{ comment }`）；`POST /orgs/:org/document-comments/:id/resolve` `{ resolved }` → `{ comment }`
  - `PUT /orgs/:org/documents/:id/checks/:itemKey`；`POST /orgs/:org/documents/:id/checks/:itemKey/signoffs`（与需求的同名接口同形）
  - `GET /orgs/:org/products/:id/document-reviews` → `{ queue: DocumentReviewQueue }`
  - `POST /orgs/:org/documents/:id/attachments`（multipart，字段 `file`）→ 201 `{ attachment: AttachmentView & { url } }`，`url = /api/v1/orgs/{org}/attachments/{id}`
  - `GET /orgs/:org/attachments/:id` → 图片字节
  - `GET /orgs/:org/templates?product=&usable=1` → `{ templates }`；`POST /orgs/:org/templates`；`PATCH /orgs/:org/templates/:id`；`POST /orgs/:org/templates/preset`
  - `test/api/helpers.ts`：`upload(app, path, opts: { session?: string; token?: string; file: Blob; filename: string })`

- [ ] **Step 1: 写失败的接口测试**

`apps/web/test/api/helpers.ts`：

1. 顶部 import 改为：

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalStorage } from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { type App, createApi } from '@/server/api';
```

2. `makeApp` 改为：

```ts
export async function makeApp(): Promise<{ app: App; cleanup: () => Promise<void> }> {
  const t = await createTestDb();
  const storage = createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-api-storage-')));
  const app = createApi({ db: t.db, secureCookies: false, publicUrl: 'http://localhost:3000', storage });
  return { app, cleanup: t.cleanup };
}
```

3. 文件末尾加：

```ts
/** multipart 上传一个文件（字段名 file）。 */
export async function upload(
  app: App,
  pathname: string,
  opts: { session?: string; token?: string; file: Blob; filename: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.set('file', opts.file, opts.filename);
  const headers: Record<string, string> = {};
  if (opts.session) headers.cookie = `flower_session=${opts.session}`;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.request(`/api/v1${pathname}`, { method: 'POST', headers, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
```

新建 `apps/web/test/api/documents.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom, upload } from './helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

let app: App;
let cleanup: () => Promise<void>;
let session: string;
let viewerSession: string;
let readToken: string;
let productId: string;

beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'viewer@example.com', orgRole: 'member' } });
  const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '只读乙', password: 'password123' } });
  viewerSession = sessionFrom(accept.res);
  const viewerId = (await call(app, 'GET', '/orgs/acme', { session: viewerSession })).body.me.memberId;
  await call(app, 'PUT', `/orgs/acme/products/${productId}/roles/${viewerId}`, { session, body: { role: 'viewer' } });
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me.memberId, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
});
afterAll(() => cleanup());

describe('PRD 接口', () => {
  it('新建、按编号读取、保存、冲突、修订、对比、恢复、流转', async () => {
    const preset = (await call(app, 'GET', `/orgs/acme/templates?product=${productId}&usable=1`, { session })).body.templates[0];
    const created = await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '上传 PRD', templateId: preset.id } });
    expect(created.status).toBe(201);
    const doc = created.body.document;
    expect(doc).toMatchObject({ displayKey: 'PAN-PRD-1', source: 'native', version: 1 });
    expect((await call(app, 'GET', '/orgs/acme/documents/PAN-PRD-1', { session: viewerSession })).body.document.myRole).toBe('viewer');

    const saved = await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { session, body: { baseVersion: 1, markdown: '## 背景\n\n第一稿' } });
    expect(saved.body).toEqual({ version: 2, revisionNumber: 1, merged: true });
    const stale = await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { session, body: { baseVersion: 1, markdown: 'x' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ message: '文档已被其他人修改，请重新加载后再编辑', details: { version: 2 } });

    const revisions = await call(app, 'GET', `/orgs/acme/documents/${doc.id}/revisions`, { session: viewerSession });
    expect(revisions.body.revisions.map((r: { number: number }) => r.number)).toEqual([1]);
    expect((await call(app, 'GET', `/orgs/acme/documents/${doc.id}/revisions/1`, { session })).body.revision.markdown).toBe('## 背景\n\n第一稿');
    expect((await call(app, 'GET', `/orgs/acme/documents/${doc.id}/diff?from=1&to=1`, { session })).body.diff).toEqual({ title: null, sections: [] });
    expect((await call(app, 'GET', `/orgs/acme/documents/${doc.id}/diff?from=0&to=1`, { session })).status).toBe(400);
    const restored = await call(app, 'POST', `/orgs/acme/documents/${doc.id}/restore`, { session, body: { number: 1, baseVersion: 2 } });
    expect(restored.body).toMatchObject({ version: 3, revisionNumber: 2 });

    const moved = await call(app, 'POST', `/orgs/acme/documents/${doc.id}/transitions`, { session, body: { to: 'discarded' } });
    expect(moved.body.document.status).toBe('discarded');
    expect((await call(app, 'POST', `/orgs/acme/documents/${doc.id}/transitions`, { session, body: { to: 'bogus' } })).status).toBe(400);
  });

  it('外部 PRD：列表筛选、重复网址 409、覆盖需求、转换', async () => {
    const req = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '分片上传' } })).body.requirement;
    const ext = await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, {
      session,
      body: { title: '外部方案', externalUrl: 'https://doc.weixin.qq.com/doc/x?scode=1', requirementIds: [req.id] },
    });
    expect(ext.body.document).toMatchObject({ source: 'external', externalProvider: 'wecom', requirements: [{ id: req.id }] });
    const dup = await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '重复', externalUrl: 'https://doc.weixin.qq.com/doc/x?scode=2' } });
    expect(dup.status).toBe(409);
    const list = await call(app, 'GET', `/orgs/acme/products/${productId}/documents?source=external&status=draft`, { session });
    expect(list.body.documents.map((d: { title: string }) => d.title)).toEqual(['外部方案']);
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/documents?status=bogus`, { session })).status).toBe(400);
    expect((await call(app, 'DELETE', `/orgs/acme/documents/${ext.body.document.id}/requirements/${req.id}`, { session })).status).toBe(204);
    expect((await call(app, 'POST', `/orgs/acme/documents/${ext.body.document.id}/requirements`, { session, body: { requirementIds: [req.id] } })).body).toEqual({ linked: 1 });
    const converted = await call(app, 'POST', `/orgs/acme/documents/${ext.body.document.id}/convert`, { session, body: { baseVersion: 1, markdown: '## 背景\n\n粘贴的内容' } });
    expect(converted.body).toMatchObject({ revisionNumber: 1 });
  });

  it('图片上传与读取：只读成员能读不能传；SVG 被拒绝；返回头带 nosniff', async () => {
    const doc = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '带图' } })).body.document;
    const up = await upload(app, `/orgs/acme/documents/${doc.id}/attachments`, { session, file: new Blob([PNG], { type: 'image/png' }), filename: '截图.png' });
    expect(up.status).toBe(201);
    expect(up.body.attachment).toMatchObject({ filename: '截图.png', mime: 'image/png', url: `/api/v1/orgs/acme/attachments/${up.body.attachment.id}` });
    const res = await app.request(up.body.attachment.url, { headers: { cookie: `flower_session=${viewerSession}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect((await upload(app, `/orgs/acme/documents/${doc.id}/attachments`, { session: viewerSession, file: new Blob([PNG]), filename: 'a.png' })).status).toBe(403);
    expect((await upload(app, `/orgs/acme/documents/${doc.id}/attachments`, { token: readToken, file: new Blob([PNG]), filename: 'a.png' })).status).toBe(403);
    const svg = await upload(app, `/orgs/acme/documents/${doc.id}/attachments`, { session, file: new Blob(['<svg/>'], { type: 'image/svg+xml' }), filename: 'x.svg' });
    expect(svg.status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/documents/${doc.id}/attachments`, { session, body: {} })).status).toBe(400);
  });

  it('权限矩阵：只读成员能评论不能写；只读 Token 只能读；模板只有组织管理员能建', async () => {
    const doc = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '权限' } })).body.document;
    expect((await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { session: viewerSession, body: { baseVersion: 1, markdown: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/documents/${doc.id}/transitions`, { session: viewerSession, body: { to: 'review' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session: viewerSession, body: { title: 'x' } })).status).toBe(403);
    const comment = await call(app, 'POST', `/orgs/acme/documents/${doc.id}/comments`, { session: viewerSession, body: { body: '整体同意' } });
    expect(comment.status).toBe(201);
    expect((await call(app, 'POST', `/orgs/acme/document-comments/${comment.body.comment.id}/resolve`, { session: viewerSession, body: { resolved: true } })).status).toBe(200);
    expect((await call(app, 'GET', `/orgs/acme/documents/${doc.id}/comments`, { token: readToken })).body.comments).toHaveLength(1);
    expect((await call(app, 'GET', '/orgs/acme/documents/PAN-PRD-1', { token: readToken })).status).toBe(200);
    expect((await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { token: readToken, body: { baseVersion: 1, markdown: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/documents/${doc.id}/comments`, { token: readToken, body: { body: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { token: readToken, body: { title: 'x' } })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/templates', { session: viewerSession, body: { name: 'x', body: '', sections: [] } })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/templates', { session, body: { name: '轻量', body: '## 背景\n', sections: [{ heading: '背景', required: true }] } })).status).toBe(201);
    expect((await call(app, 'POST', '/orgs/acme/templates/preset', { session })).status).toBe(409);
    expect((await call(app, 'GET', '/orgs/acme/templates', { session: viewerSession })).body.templates.map((x: { name: string }) => x.name)).toEqual(['变更 PRD（预置）', '轻量']);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run test/api/documents.test.ts`
Expected: FAIL（`createApi` 不接受 `storage`、接口 404）。

- [ ] **Step 2: 存储配置**

`packages/core/src/config.ts`：

1. 顶部加 `import path from 'node:path';`
2. `ServerConfig` 类型加一行 `storageDir: string;`
3. `loadServerConfig` 的返回对象加：

```ts
    storageDir: env.FLOWER_STORAGE_DIR || path.join(process.cwd(), '.flower-storage'),
```

`packages/core/test/config.test.ts`：顶部加 `import path from 'node:path';`；「只需要 DATABASE_URL 与 FLOWER_SECRET_KEY」用例的期望对象加 `storageDir: path.join(process.cwd(), '.flower-storage'),`，并在该 describe 里加：

```ts
  it('附件存储目录可由 FLOWER_STORAGE_DIR 指定', () => {
    expect(loadServerConfig({ ...serverEnv, FLOWER_STORAGE_DIR: '/data/storage' }).storageDir).toBe('/data/storage');
  });
```

- [ ] **Step 3: 接口实现**

`apps/web/src/server/http.ts` 末尾加（`csvParam` 是 `routes/requirements.ts` 里原来的 `csv`，移到这里供两个路由共用）：

```ts
/** 逗号分隔的查询参数 → 去空白后的列表；空时为 undefined。 */
export const csvParam = (v: string | undefined): string[] | undefined => {
  const list = v?.split(',').map((s) => s.trim()).filter(Boolean);
  return list?.length ? list : undefined;
};

/**
 * 读取 multipart 上传的 file 字段。Content-Length 明显超过上限时不读请求体直接拒绝；
 * 文件本身的大小与类型由服务函数按文件头再校验一次。
 */
export async function readUpload(c: Context, maxBytes: number, tooLarge: string): Promise<{ filename: string; bytes: Uint8Array }> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) throw new AppError('invalid', '请求必须使用 multipart/form-data');
  if (Number(c.req.header('content-length') ?? '0') > maxBytes + 64 * 1024) throw new AppError('invalid', tooLarge);
  let body: Record<string, string | File>;
  try {
    body = (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    throw new AppError('invalid', '上传内容无法解析');
  }
  const file = body.file;
  if (!(file instanceof File)) throw new AppError('invalid', '缺少文件');
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
```

新建 `apps/web/src/server/routes/documents.ts`：

```ts
import {
  addDocumentComment,
  AppError,
  CHECK_STATES,
  convertExternalDocument,
  createDocument,
  diffRevisions,
  DOCUMENT_STATUSES,
  getDocumentByKey,
  getRevision,
  IMAGE_MAX_BYTES,
  linkDocumentRequirements,
  listDocumentComments,
  listDocumentReviewQueue,
  listDocuments,
  listRevisions,
  readAttachment,
  restoreRevision,
  saveDocumentContent,
  setDocumentCheckItemState,
  setDocumentCommentResolved,
  signDocumentCheckItem,
  transitionDocument,
  unlinkDocumentRequirement,
  updateDocument,
  uploadDocumentImage,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { csvParam as csv, readJson, readUpload } from '../http';

const positiveInt = (v: string | undefined, message: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new AppError('invalid', message);
  return n;
};

const listQuery = z.object({
  statuses: z.array(z.enum(DOCUMENT_STATUSES)).optional(),
  source: z.enum(['native', 'external']).optional(),
});

const anchorSchema = z.object({ quote: z.string().max(500), prefix: z.string().max(200).optional(), suffix: z.string().max(200).optional() });

export function registerDocumentRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/products/:id/documents', async (c) => {
    const q = listQuery.safeParse({ statuses: csv(c.req.query('status')), source: c.req.query('source') || undefined });
    if (!q.success) throw new AppError('invalid', '筛选条件无效');
    const documents = await listDocuments(deps.db, c.get('actor'), c.req.param('id'), {
      statuses: q.data.statuses,
      source: q.data.source,
      ownerIds: csv(c.req.query('owner')),
      q: c.req.query('q') || undefined,
    });
    return c.json({ documents });
  });

  app.post('/orgs/:org/products/:id/documents', async (c) => {
    const body = await readJson(
      c,
      z.object({
        title: z.string(),
        ownerMemberId: z.string().nullable().optional(),
        templateId: z.string().nullable().optional(),
        externalUrl: z.string().max(2000).nullable().optional(),
        requirementIds: z.array(z.string()).max(200).optional(),
      }),
    );
    return c.json({ document: await createDocument(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.get('/orgs/:org/documents/:key', async (c) => c.json({ document: await getDocumentByKey(deps.db, c.get('actor'), c.req.param('key')) }));

  app.patch('/orgs/:org/documents/:id', async (c) => {
    const body = await readJson(c, z.object({ title: z.string().optional(), ownerMemberId: z.string().nullable().optional(), externalUrl: z.string().max(2000).optional() }));
    return c.json({ document: await updateDocument(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.put('/orgs/:org/documents/:id/content', async (c) => {
    const body = await readJson(c, z.object({ baseVersion: z.number().int(), markdown: z.string(), title: z.string().optional() }));
    return c.json(await saveDocumentContent(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.post('/orgs/:org/documents/:id/convert', async (c) => {
    const body = await readJson(c, z.object({ baseVersion: z.number().int(), markdown: z.string() }));
    return c.json(await convertExternalDocument(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.post('/orgs/:org/documents/:id/transitions', async (c) => {
    const body = await readJson(c, z.object({ to: z.enum(DOCUMENT_STATUSES) }));
    return c.json({ document: await transitionDocument(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.get('/orgs/:org/documents/:id/revisions', async (c) => c.json({ revisions: await listRevisions(deps.db, c.get('actor'), c.req.param('id')) }));

  app.get('/orgs/:org/documents/:id/revisions/:number', async (c) =>
    c.json({ revision: await getRevision(deps.db, c.get('actor'), c.req.param('id'), positiveInt(c.req.param('number'), '版本号无效')) }),
  );

  app.get('/orgs/:org/documents/:id/diff', async (c) => {
    const from = positiveInt(c.req.query('from'), '版本号无效');
    const to = positiveInt(c.req.query('to'), '版本号无效');
    return c.json({ diff: await diffRevisions(deps.db, c.get('actor'), c.req.param('id'), { from, to }) });
  });

  app.post('/orgs/:org/documents/:id/restore', async (c) => {
    const body = await readJson(c, z.object({ number: z.number().int().min(1), baseVersion: z.number().int() }));
    return c.json(await restoreRevision(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.post('/orgs/:org/documents/:id/requirements', async (c) => {
    const body = await readJson(c, z.object({ requirementIds: z.array(z.string()).min(1).max(200) }));
    return c.json(await linkDocumentRequirements(deps.db, c.get('actor'), c.req.param('id'), body));
  });

  app.delete('/orgs/:org/documents/:id/requirements/:requirementId', async (c) => {
    await unlinkDocumentRequirement(deps.db, c.get('actor'), c.req.param('id'), c.req.param('requirementId'));
    return c.body(null, 204);
  });

  app.get('/orgs/:org/documents/:id/comments', async (c) => c.json({ comments: await listDocumentComments(deps.db, c.get('actor'), c.req.param('id')) }));

  app.post('/orgs/:org/documents/:id/comments', async (c) => {
    const body = await readJson(c, z.object({ body: z.string().max(10_000), parentId: z.string().nullable().optional(), anchor: anchorSchema.nullable().optional() }));
    return c.json({ comment: await addDocumentComment(deps.db, c.get('actor'), c.req.param('id'), body) }, 201);
  });

  app.post('/orgs/:org/document-comments/:id/resolve', async (c) => {
    const body = await readJson(c, z.object({ resolved: z.boolean() }));
    return c.json({ comment: await setDocumentCommentResolved(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.put('/orgs/:org/documents/:id/checks/:itemKey', async (c) => {
    const body = await readJson(c, z.object({ state: z.enum(CHECK_STATES), note: z.string().max(2000).nullable().optional() }));
    return c.json(await setDocumentCheckItemState(deps.db, c.get('actor'), c.req.param('id'), c.req.param('itemKey'), body));
  });

  app.post('/orgs/:org/documents/:id/checks/:itemKey/signoffs', async (c) => {
    const body = await readJson(
      c,
      z.object({
        decision: z.enum(['passed', 'rejected']),
        note: z.string().max(2000).nullable().optional(),
        ruleIndex: z.number().int().min(0).optional(),
        onBehalf: z.boolean().optional(),
      }),
    );
    return c.json(await signDocumentCheckItem(deps.db, c.get('actor'), c.req.param('id'), c.req.param('itemKey'), body), 201);
  });

  app.get('/orgs/:org/products/:id/document-reviews', async (c) => c.json({ queue: await listDocumentReviewQueue(deps.db, c.get('actor'), c.req.param('id')) }));

  app.post('/orgs/:org/documents/:id/attachments', async (c) => {
    const file = await readUpload(c, IMAGE_MAX_BYTES, '图片不能超过 10 MB');
    const attachment = await uploadDocumentImage(deps.db, c.get('actor'), { documentId: c.req.param('id'), ...file, storage: deps.storage });
    return c.json({ attachment: { ...attachment, url: `/api/v1/orgs/${c.req.param('org')}/attachments/${attachment.id}` } }, 201);
  });

  app.get('/orgs/:org/attachments/:id', async (c) => {
    const f = await readAttachment(deps.db, c.get('actor'), { attachmentId: c.req.param('id'), storage: deps.storage });
    return c.body(new Uint8Array(f.bytes), 200, {
      'content-type': f.mime,
      'content-length': String(f.bytes.byteLength),
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    });
  });
}
```

`apps/web/src/server/routes/requirements.ts`：删去文件里的 `const csv = …;` 定义（4 行），`import { readJson } from '../http';` 改为 `import { csvParam as csv, readJson } from '../http';`。

新建 `apps/web/src/server/routes/templates.ts`：

```ts
import { createPresetTemplate, createTemplate, listTemplates, updateTemplate } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

const sections = z
  .array(z.object({ heading: z.string().max(100), required: z.boolean(), guidance: z.string().max(500).optional() }))
  .max(50);

export function registerTemplateRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/templates', async (c) =>
    c.json({ templates: await listTemplates(deps.db, c.get('actor'), { productId: c.req.query('product') || null, usable: c.req.query('usable') === '1' }) }),
  );

  app.post('/orgs/:org/templates', async (c) => {
    const body = await readJson(c, z.object({ productId: z.string().nullable().optional(), name: z.string(), body: z.string(), sections }));
    return c.json({ template: await createTemplate(deps.db, c.get('actor'), body) }, 201);
  });

  app.post('/orgs/:org/templates/preset', async (c) => c.json({ template: await createPresetTemplate(deps.db, c.get('actor')) }, 201));

  app.patch('/orgs/:org/templates/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().optional(), body: z.string().optional(), sections: sections.optional(), active: z.boolean().optional() }));
    return c.json({ template: await updateTemplate(deps.db, c.get('actor'), c.req.param('id'), body) });
  });
}
```

`apps/web/src/server/api.ts`：

1. 第一行 import 改为 `import type { AccountView, Actor, Db, FileStorage } from '@flower/core';`
2. 路由 import 区加 `import { registerDocumentRoutes } from './routes/documents';` 与 `import { registerTemplateRoutes } from './routes/templates';`
3. `export type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string };` 改为 `export type ApiDeps = { db: Db; secureCookies: boolean; publicUrl: string; storage: FileStorage };`
4. `registerWorkbenchRoutes(app, deps);` 之后加 `registerDocumentRoutes(app, deps);` 与 `registerTemplateRoutes(app, deps);`

`apps/web/src/server/runtime.ts` 改为：

```ts
import { createDb, createLocalStorage, loadServerConfig } from '@flower/core';
import { type App, createApi } from './api';

let api: App | undefined;

export function getApi(): App {
  if (!api) {
    const config = loadServerConfig();
    const { db } = createDb(config.databaseUrl);
    api = createApi({ db, secureCookies: config.publicUrl.startsWith('https://'), publicUrl: config.publicUrl, storage: createLocalStorage(config.storageDir) });
  }
  return api;
}
```

`apps/web/playwright.config.ts`：顶部加 `import path from 'node:path';`，`webServer.env` 加 `FLOWER_STORAGE_DIR: path.join(__dirname, 'test-results', 'e2e-storage'),`。

- [ ] **Step 4: 镜像与本地配置**

`Dockerfile` 的 runner 阶段：`ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 FLOWER_MIGRATIONS_DIR=/app/migrations` 改为 `ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 FLOWER_MIGRATIONS_DIR=/app/migrations FLOWER_STORAGE_DIR=/app/data/storage`；`USER node` 之前加一行：

```dockerfile
RUN mkdir -p /app/data/storage && chown -R node:node /app/data
```

`docker-compose.yml`：`flower` 服务的 `ports:` 之前加

```yaml
    volumes:
      - flower_storage:/app/data/storage
```

文件末尾 `volumes:` 下加一行 `  flower_storage: {}`。

`.env.example` 末尾加：

```
# PRD 图片附件的存放目录（缺省为进程工作目录下的 .flower-storage，开发时即 apps/web/.flower-storage）
# FLOWER_STORAGE_DIR=
```

`scripts/smoke.sh`：在 `echo "5. 重启后数据仍在，迁移可重复执行"` 之前加：

```bash
echo "4c. 图片写入存储卷"
jget() { node -e "let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',()=>console.log(JSON.parse(s)$1))"; }
PRODUCT_ID="$(curl -fs -b "$JAR" -H 'content-type: application/json' -d '{"name":"冒烟产品","key":"SMK"}' "$BASE/orgs/smoke/products" | jget .product.id)"
DOC_ID="$(curl -fs -b "$JAR" -H 'content-type: application/json' -d '{"title":"冒烟 PRD"}' "$BASE/orgs/smoke/products/$PRODUCT_ID/documents" | jget .document.id)"
PNG="$(mktemp)"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0d' > "$PNG"
ATT_URL="$(curl -fs -b "$JAR" -F "file=@$PNG;filename=smoke.png" "$BASE/orgs/smoke/documents/$DOC_ID/attachments" | jget .attachment.url)"
rm -f "$PNG"
curl -fs -b "$JAR" -o /dev/null "http://localhost:3900$ATT_URL"
```

并在 `curl -fs "$BASE/setup/status" | grep -q '"initialized":true'` 之后加：

```bash
curl -fs -b "$JAR" -o /dev/null "http://localhost:3900$ATT_URL"
```

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/config.test.ts && pnpm --filter @flower/web exec vitest run test/api && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: 全部通过（其他 `test/api/*.test.ts` 经 `makeApp` 自动带上存储目录）。

Run: `./scripts/smoke.sh`
Expected: 输出「冒烟测试通过」（需要本机 docker）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/config.ts packages/core/test/config.test.ts apps/web/src/server apps/web/test/api apps/web/playwright.config.ts Dockerfile docker-compose.yml .env.example scripts/smoke.sh
git commit -m "feat(web): PRD、修订、评论、检查项、模板与图片附件接口；附件存储卷

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: 页面：启用「文档」导航、PRD 列表、新建对话框（Flower 文档 / 外部链接）

**Files:**
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`、`apps/web/src/lib/api.ts`（`apiUpload`）
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/features/shell/nav.ts`、`nav.test.ts`
- Create: `apps/web/src/features/documents/model.ts`、`model.test.ts`
- Create: `apps/web/src/app/(app)/[org]/documents/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/documents/create-dialog.tsx`
- Create: `apps/web/src/components/document-status.tsx`（`DocumentStatusBadge`）
- Modify: `apps/web/e2e/helpers.ts`（`createDocument`、`presetTemplateId`、`readToken`、`applyPrdWorkflow`）
- Modify: `apps/web/e2e/auth.spec.ts`（导航不再有「P2」标签）
- Test: `apps/web/e2e/documents.spec.ts`

**Interfaces:**
- Consumes: Task 9 接口；`@flower/core/markdown` 的 `DOCUMENT_STATUS_LABELS`、`DOCUMENT_STATUSES`、`documentDisplayKey`
- Produces:
  - `lib/types.ts`：`DocumentStatus`、`ExternalProvider`、`TemplateSection`、`DocumentListItem`、`DocumentDetail`、`DocumentRevision`、`RevisionDiff`、`DocumentComment`、`DocumentTemplate`、`DocumentReviewQueue`、`Attachment`（`AttachmentView & { url: string }`）、`CheckItem`（`RequirementDetail['checkItems'][number]`）
  - `lib/queries.ts`：`qk.documents(o, productId, query)`、`qk.document(o, key)`、`qk.documentRevisions(o, id)`、`qk.documentDiff(o, id, from, to)`、`qk.documentComments(o, id)`、`qk.documentReviews(o, productId)`、`qk.templates(o, scope)`；`documentKeys(o)`、`templateKeys(o)`；`useDocuments(o, productId, query)`、`useDocument(o, key)`、`useDocumentRevisions(o, id, enabled?)`、`useDocumentDiff(o, id, from, to)`、`useDocumentComments(o, id)`、`useDocumentReviews(o, productId)`、`useTemplates(o, opts: { productId?: string; usable?: boolean }, enabled?)`
  - `lib/api.ts`：`apiUpload<T>(path: string, file: Blob, filename: string): Promise<T>`
  - `features/documents/model.ts`：`DOCUMENT_STATUS_COLOR`、`PROVIDER_LABEL`、`sourceLabel(d: { source; externalProvider })`、`type DocumentListFilter = { product: string; status: DocumentStatus | ''; owner: string; source: 'native' | 'external' | ''; q: string }`、`parseDocumentFilter(sp: URLSearchParams)`、`documentFilterToSearch(f)`、`documentFilterToApiQuery(f)`、`documentHref(org: string, displayKey: string)`
  - `create-dialog.tsx`：`CreateDocumentDialog({ org, productId, open, onOpenChange, initialTitle?, requirementIds? })`
  - e2e：`PNG_1PX_BASE64`、`createDocument(request, productId, data: { title: string; templateId?: string; externalUrl?: string; requirementIds?: string[] }): Promise<{ id: string; displayKey: string; version: number }>`、`presetTemplateId(request, productId): Promise<string>`、`readToken(request): Promise<string>`、`applyPrdWorkflow(request, productId): Promise<void>`（检查项：`prd` 作用于需求、跟随 PRD 状态；`prd_review` 作用于 PRD，由产品管理员会签）

- [ ] **Step 1: 写失败的单元测试**

新建 `apps/web/src/features/documents/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { documentFilterToApiQuery, documentFilterToSearch, documentHref, parseDocumentFilter, sourceLabel } from './model';

describe('PRD 列表筛选', () => {
  it('地址栏 ↔ 筛选；无效的状态与来源被忽略', () => {
    const f = parseDocumentFilter(new URLSearchParams('product=PAN&status=review&source=external&owner=m1&q=支付'));
    expect(f).toEqual({ product: 'PAN', status: 'review', owner: 'm1', source: 'external', q: '支付' });
    expect(parseDocumentFilter(new URLSearchParams('status=bogus&source=x'))).toEqual({ product: '', status: '', owner: '', source: '', q: '' });
    expect(documentFilterToSearch(f)).toBe('product=PAN&status=review&owner=m1&source=external&q=%E6%94%AF%E4%BB%98');
    expect(documentFilterToApiQuery(f)).toBe('status=review&owner=m1&source=external&q=%E6%94%AF%E4%BB%98');
    expect(documentFilterToApiQuery({ product: 'PAN', status: '', owner: '', source: '', q: '' })).toBe('');
  });

  it('链接与来源文字', () => {
    expect(documentHref('acme', 'PAN-PRD-3')).toBe('/acme/documents/PAN-PRD-3');
    expect(sourceLabel({ source: 'native', externalProvider: 'wecom' })).toBe('Flower 文档');
    expect(sourceLabel({ source: 'external', externalProvider: 'wecom' })).toBe('企业微信文档');
    expect(sourceLabel({ source: 'external', externalProvider: null })).toBe('外部链接');
  });
});
```

`apps/web/src/lib/api.test.ts`：第 2 行 import 改为 `import { ApiError, api, apiUpload, isAccessDenied, unmetFrom } from './api';`，并在 `describe('api', …)` 里加：

```ts
  it('上传用 FormData，不设 content-type（由浏览器带上 boundary）', async () => {
    const f = mockFetch(201, { attachment: { id: 'a' } });
    await expect(apiUpload('/orgs/acme/documents/d/attachments', new Blob(['x']), 'a.png')).resolves.toEqual({ attachment: { id: 'a' } });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(init.headers).toBeUndefined();
  });
```

`apps/web/src/features/shell/nav.test.ts`：`['文档', 'P2', null],` 改为 `['文档', null, '/acme/documents'],`；`activeNavKey` 用例末尾加：

```ts
    expect(activeNavKey('/acme/documents', 'acme')).toBe('documents');
    expect(activeNavKey('/acme/documents/PAN-PRD-1', 'acme')).toBe('documents');
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts src/lib/api.test.ts src/features/shell/nav.test.ts`
Expected: FAIL（`./model` 不存在、`apiUpload` 未导出、导航仍是 P2）。

- [ ] **Step 2: 纯逻辑、请求与导航**

新建 `apps/web/src/features/documents/model.ts`：

```ts
import { DOCUMENT_STATUSES, type DocumentStatus, type ExternalProvider } from '@flower/core/markdown';

export const DOCUMENT_STATUS_COLOR: Record<DocumentStatus, string> = {
  draft: '#8a9199',
  review: '#2f6fd6',
  approved: '#1f6f54',
  launched: '#1e8a5a',
  merged: '#0f766e',
  discarded: '#5c6570',
};

export const PROVIDER_LABEL: Record<ExternalProvider, string> = {
  wecom: '企业微信文档',
  feishu: '飞书文档',
  tencent_docs: '腾讯文档',
  notion: 'Notion',
  yuque: '语雀',
  google_docs: 'Google 文档',
  other: '外部链接',
};

export function sourceLabel(d: { source: 'native' | 'external'; externalProvider: ExternalProvider | null }): string {
  return d.source === 'native' ? 'Flower 文档' : PROVIDER_LABEL[d.externalProvider ?? 'other'];
}

export const documentHref = (org: string, displayKey: string): string => `/${org}/documents/${displayKey}`;

export type DocumentListFilter = { product: string; status: DocumentStatus | ''; owner: string; source: 'native' | 'external' | ''; q: string };

export function parseDocumentFilter(sp: URLSearchParams): DocumentListFilter {
  const status = sp.get('status') ?? '';
  const source = sp.get('source') ?? '';
  return {
    product: sp.get('product') ?? '',
    status: (DOCUMENT_STATUSES as readonly string[]).includes(status) ? (status as DocumentStatus) : '',
    owner: sp.get('owner') ?? '',
    source: source === 'native' || source === 'external' ? source : '',
    q: sp.get('q') ?? '',
  };
}

function toParams(f: DocumentListFilter, keys: Array<keyof DocumentListFilter>): string {
  const p = new URLSearchParams();
  for (const k of keys) if (f[k]) p.set(k, f[k]);
  return p.toString();
}

/** 地址栏：带上产品。 */
export const documentFilterToSearch = (f: DocumentListFilter): string => toParams(f, ['product', 'status', 'owner', 'source', 'q']);
/** 接口查询串：产品在路径里，不重复。 */
export const documentFilterToApiQuery = (f: DocumentListFilter): string => toParams(f, ['status', 'owner', 'source', 'q']);
```

`apps/web/src/lib/api.ts`：把 `api` 函数整个替换为下面两段（`ApiError`、`NETWORK_ERROR_MESSAGE`、`unmetFrom`、`isAccessDenied` 不变）：

```ts
async function send<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { ...init, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', NETWORK_ERROR_MESSAGE, null);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? '服务暂时不可用，请稍后重试', e?.details ?? null);
  }
  return data as T;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  return send<T>(path, {
    method: init.method ?? 'GET',
    headers: hasBody ? { 'content-type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });
}

/** multipart 上传一个文件（字段名 file）。不设 content-type，由浏览器带上 boundary。 */
export async function apiUpload<T>(path: string, file: Blob, filename: string): Promise<T> {
  const form = new FormData();
  form.set('file', file, filename);
  return send<T>(path, { method: 'POST', body: form });
}
```

`apps/web/src/lib/types.ts`：

1. 顶部 `import type { … } from '@flower/core';` 列表里加入（按字母序插入）：`AttachmentView`、`DocumentCommentView`、`DocumentDetail as CoreDocumentDetail`、`DocumentListItem as CoreDocumentListItem`、`DocumentReviewQueue as CoreDocumentReviewQueue`、`DocumentStatus as CoreDocumentStatus`、`ExternalProvider as CoreExternalProvider`、`RevisionDiff as CoreRevisionDiff`、`RevisionListItem`、`TemplateSection as CoreTemplateSection`、`TemplateView`。
2. 文件末尾加：

```ts
export type CheckItem = RequirementDetail['checkItems'][number];
export type DocumentStatus = CoreDocumentStatus;
export type ExternalProvider = CoreExternalProvider;
export type TemplateSection = CoreTemplateSection;
export type DocumentListItem = Jsonify<CoreDocumentListItem>;
export type DocumentDetail = Jsonify<CoreDocumentDetail>;
export type DocumentRevision = Jsonify<RevisionListItem>;
export type RevisionDiff = CoreRevisionDiff;
export type DocumentComment = Jsonify<DocumentCommentView>;
export type DocumentTemplate = Jsonify<TemplateView>;
export type DocumentReviewQueue = Jsonify<CoreDocumentReviewQueue>;
export type Attachment = AttachmentView & { url: string };
```

`apps/web/src/lib/queries.ts`：

1. `import type { … } from './types';` 里加入 `DocumentComment`、`DocumentDetail`、`DocumentListItem`、`DocumentReviewQueue`、`DocumentRevision`、`DocumentTemplate`、`RevisionDiff`。
2. `qk` 对象末尾 `releases: …,` 之后加：

```ts
  documents: (o: string, productId: string, query: string) => ['org', o, 'documents', 'list', productId, query] as const,
  document: (o: string, key: string) => ['org', o, 'documents', 'detail', key] as const,
  documentRevisions: (o: string, id: string) => ['org', o, 'documents', 'revisions', id] as const,
  documentDiff: (o: string, id: string, from: number, to: number) => ['org', o, 'documents', 'diff', id, from, to] as const,
  documentComments: (o: string, id: string) => ['org', o, 'documents', 'comments', id] as const,
  documentReviews: (o: string, productId: string) => ['org', o, 'documents', 'reviews', productId] as const,
  templates: (o: string, scope: string) => ['org', o, 'templates', scope] as const,
```

3. `useProductIterations` 之后加：

```ts
/** PRD 相关查询的公共前缀：PRD、修订、评论、检查项变化后统一失效。 */
export const documentKeys = (o: string) => ['org', o, 'documents'] as const;
export const templateKeys = (o: string) => ['org', o, 'templates'] as const;

export const useDocuments = (o: string, productId: string | undefined, query: string) =>
  useQuery({
    queryKey: qk.documents(o, productId ?? '', query),
    queryFn: () => api<{ documents: DocumentListItem[] }>(`/orgs/${o}/products/${productId}/documents?${query}`),
    select: (d) => d.documents,
    enabled: !!productId,
    placeholderData: keepPreviousData,
  });
export const useDocument = (o: string, key: string) =>
  useQuery({ queryKey: qk.document(o, key), queryFn: () => api<{ document: DocumentDetail }>(`/orgs/${o}/documents/${encodeURIComponent(key)}`), select: (d) => d.document });
export const useDocumentRevisions = (o: string, id: string, enabled = true) =>
  useQuery({
    queryKey: qk.documentRevisions(o, id),
    queryFn: () => api<{ revisions: DocumentRevision[] }>(`/orgs/${o}/documents/${id}/revisions`),
    select: (d) => d.revisions,
    enabled,
  });
export const useDocumentDiff = (o: string, id: string, from: number, to: number) =>
  useQuery({
    queryKey: qk.documentDiff(o, id, from, to),
    queryFn: () => api<{ diff: RevisionDiff }>(`/orgs/${o}/documents/${id}/diff?from=${from}&to=${to}`),
    select: (d) => d.diff,
    enabled: from > 0 && to > 0 && from !== to,
  });
export const useDocumentComments = (o: string, id: string) =>
  useQuery({ queryKey: qk.documentComments(o, id), queryFn: () => api<{ comments: DocumentComment[] }>(`/orgs/${o}/documents/${id}/comments`), select: (d) => d.comments });
export const useDocumentReviews = (o: string, productId: string | undefined) =>
  useQuery({
    queryKey: qk.documentReviews(o, productId ?? ''),
    queryFn: () => api<{ queue: DocumentReviewQueue }>(`/orgs/${o}/products/${productId}/document-reviews`),
    select: (d) => d.queue,
    enabled: !!productId,
  });
export const useTemplates = (o: string, opts: { productId?: string; usable?: boolean }, enabled = true) =>
  useQuery({
    queryKey: qk.templates(o, `${opts.productId ?? 'org'}:${opts.usable ? 'usable' : 'all'}`),
    queryFn: () => api<{ templates: DocumentTemplate[] }>(`/orgs/${o}/templates?${new URLSearchParams({ ...(opts.productId ? { product: opts.productId } : {}), ...(opts.usable ? { usable: '1' } : {}) })}`),
    select: (d) => d.templates,
    enabled,
  });
```

`apps/web/src/features/shell/nav.ts`：`{ key: 'documents', label: '文档', icon: 'doc', phase: 'P2' },` 改为 `{ key: 'documents', label: '文档', href: \`/${org}/documents\`, icon: 'doc' },`；`activeNavKey` 中 `if (/^\/reviews(\/|$)/.test(rest)) return 'reviews';` 之后加 `if (/^\/documents(\/|$)/.test(rest)) return 'documents';`。

`apps/web/e2e/auth.spec.ts`：`await expect(page.getByText('P2').first()).toBeVisible();` 改为 `await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '文档' })).toBeVisible();`。

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts src/lib/api.test.ts src/features/shell/nav.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

`apps/web/e2e/helpers.ts` 末尾加：

```ts
export async function createDocument(
  request: APIRequestContext,
  productId: string,
  data: { title: string; templateId?: string; externalUrl?: string; requirementIds?: string[] },
): Promise<{ id: string; displayKey: string; version: number }> {
  return (await json<{ document: { id: string; displayKey: string; version: number } }>(request.post(`/api/v1/orgs/acme/products/${productId}/documents`, { data }))).document;
}

/** 1×1 像素的 PNG（base64），图片上传与导入用例共用。 */
export const PNG_1PX_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function presetTemplateId(request: APIRequestContext, productId: string): Promise<string> {
  return (await json<{ templates: Array<{ id: string }> }>(request.get(`/api/v1/orgs/acme/templates?product=${productId}&usable=1`))).templates[0]!.id;
}

/** 以所有者身份签发一个只读、全部产品的 Token。 */
export async function readToken(request: APIRequestContext): Promise<string> {
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  return (await json<{ token: string }>(request.post('/api/v1/orgs/acme/tokens', { data: { memberId: me, name: '只读', scope: { products: 'all', access: 'read' } } }))).token;
}

/** 给产品换上带 PRD 联动的流程：「PRD」跟随 PRD 状态；「PRD 评审」挂在 PRD 上，由产品管理员会签；进入「开发中」需要 PRD 评审通过。 */
export async function applyPrdWorkflow(request: APIRequestContext, productId: string): Promise<void> {
  const wf = await json<{ version: { id: string } }>(
    request.post('/api/v1/orgs/acme/workflows', {
      data: {
        name: 'PRD 流程',
        body: {
          states: [
            { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
            { key: 'doing', label: '开发中', color: '#f59e0b', order: 2, group: '', category: 'started' },
          ],
          initial: 'backlog',
          transitions: [
            { from: '*', to: 'backlog', conditions: [] },
            { from: '*', to: 'doing', conditions: [{ type: 'check_item', item: 'prd_review', in: ['passed'] }] },
          ],
          checkItems: [
            { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status' },
            { key: 'prd_review', label: 'PRD 评审', scope: 'document', type: 'signoff', signers: [{ by: 'product_role', ref: 'admin' }], signoffRule: 'all' },
          ],
        },
      },
    }),
  );
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId: wf.version.id } }));
}
```

新建 `apps/web/e2e/documents.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createProduct, expectNoPageOverflow, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('新建 Flower 文档与外部 PRD；重复网址报错；列表按来源与状态筛选', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '文档' }).click();
  await expect(page.getByText('还没有 PRD')).toBeVisible();

  await page.getByRole('button', { name: '新建 PRD' }).click();
  const dialog = page.getByRole('dialog', { name: '新建 PRD' });
  await dialog.getByLabel('标题').fill('上传提速');
  await expect(dialog.getByRole('combobox', { name: '模板' })).toHaveText('变更 PRD（预置）');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-1');

  await page.goto('/acme/documents');
  await page.getByRole('button', { name: '新建 PRD' }).click();
  await dialog.getByRole('tab', { name: '外部链接' }).click();
  await dialog.getByLabel('标题').fill('支付改版');
  await dialog.getByLabel('文档网址').fill('https://doc.weixin.qq.com/doc/w3_PAY?scode=abc');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-2');

  await page.goto('/acme/documents');
  await page.getByRole('button', { name: '新建 PRD' }).click();
  await dialog.getByRole('tab', { name: '外部链接' }).click();
  await dialog.getByLabel('标题').fill('重复');
  await dialog.getByLabel('文档网址').fill('https://doc.weixin.qq.com/doc/w3_PAY/?scode=xyz');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog.getByRole('alert')).toContainText('该网址已对应 PAN-PRD-2');
  await dialog.getByRole('button', { name: '取消' }).click();

  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row', { name: /PAN-PRD-2/ })).toContainText('企业微信文档');
  await expect(table.getByRole('row', { name: /PAN-PRD-1/ })).toContainText('草稿');
  await page.getByRole('combobox', { name: '来源' }).click();
  await page.getByRole('option', { name: '外部链接' }).click();
  await expect(page).toHaveURL(/source=external/);
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByRole('combobox', { name: '状态' }).click();
  await page.getByRole('option', { name: '评审中' }).click();
  await expect(page.getByText('没有符合条件的 PRD')).toBeVisible();
});

test('只读成员看不到新建按钮，可以搜索；1440 与 760 宽度下页面不横向滚动', async ({ browser, request }) => {
  const productId = await createProduct(request);
  await createDocument(request, productId, { title: '一个很长的 PRD 标题，用来检查窄屏下表格不会把页面撑宽，也不会把标题挤没' });
  await createDocument(request, productId, { title: '支付改版', externalUrl: 'https://docs.qq.com/doc/pay' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));

  await page.goto('/acme/documents');
  await expect(page.getByRole('row', { name: /支付改版/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建 PRD' })).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: '搜索 PRD' });
  await search.fill('支付');
  await search.press('Enter');
  await expect(page).toHaveURL(/q=/);
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/documents');
    await expect(page.getByRole('row', { name: /支付改版/ })).toBeVisible();
    await expectNoPageOverflow(page);
  }
  await ctx.close();
});
```

Run: `pnpm --filter @flower/web e2e documents.spec.ts`
Expected: FAIL，页面 `/acme/documents` 不存在（404）。

- [ ] **Step 4: 列表页与新建对话框**

新建 `apps/web/src/app/(app)/[org]/documents/create-dialog.tsx`：

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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { documentHref } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, requirementKeys, useApiMutation, useTemplates } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

const BLANK = '__blank';
type Mode = 'native' | 'external';

function CreateForm({
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
  const [mode, setMode] = useState<Mode>('native');
  const [title, setTitle] = useState(initialTitle);
  const [url, setUrl] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const templates = useTemplates(org, { productId, usable: true });
  // 未手动选择时默认用第一个可用模板；没有模板时为空白文档
  const chosen = templateId ?? templates.data?.[0]?.id ?? BLANK;
  const create = useApiMutation(
    () =>
      api<{ document: DocumentDetail }>(`/orgs/${org}/products/${productId}/documents`, {
        method: 'POST',
        body: { title, requirementIds, ...(mode === 'external' ? { externalUrl: url } : { templateId: chosen === BLANK ? null : chosen }) },
      }),
    {
      silentError: true,
      invalidate: [documentKeys(org), requirementKeys(org)],
      success: '已创建 PRD',
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
      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <TabsList>
          <TabsTrigger value="native">Flower 文档</TabsTrigger>
          <TabsTrigger value="external">外部链接</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="doc-title">标题</Label>
        <Input id="doc-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {mode === 'native' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="doc-template">模板</Label>
          <Select value={chosen} onValueChange={setTemplateId}>
            <SelectTrigger id="doc-template" aria-label="模板">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(templates.data ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
              <SelectItem value={BLANK}>空白文档</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="doc-url">文档网址</Label>
          <Input id="doc-url" required type="url" placeholder="https://doc.weixin.qq.com/…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <span className="text-xs text-muted-foreground">正文留在外部平台；状态流转、覆盖需求、会签与评论在 Flower 里进行。</span>
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

/** 新建 PRD：Flower 文档（可选模板）或外部链接。requirementIds 用于从需求详情新建时直接覆盖这条需求。 */
export function CreateDocumentDialog({
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
          <DialogTitle>新建 PRD</DialogTitle>
        </DialogHeader>
        {open && <CreateForm org={org} productId={productId} initialTitle={initialTitle} requirementIds={requirementIds} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
```

新建 `apps/web/src/components/document-status.tsx`（列表、详情、需求详情、评审表共用）：

```tsx
import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { DOCUMENT_STATUS_COLOR } from '@/features/documents/model';
import type { DocumentStatus } from '@/lib/types';

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span className="size-2 rounded-full" style={{ background: DOCUMENT_STATUS_COLOR[status] }} aria-hidden="true" />
      {DOCUMENT_STATUS_LABELS[status]}
    </span>
  );
}
```

新建 `apps/web/src/app/(app)/[org]/documents/page.tsx`：

```tsx
'use client';

import { DOCUMENT_STATUS_LABELS, DOCUMENT_STATUSES } from '@flower/core/markdown';
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
import {
  type DocumentListFilter,
  documentFilterToApiQuery,
  documentFilterToSearch,
  documentHref,
  parseDocumentFilter,
  sourceLabel,
} from '@/features/documents/model';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { formatDateTime } from '@/features/requirements/format';
import { useDocuments, useMembers, useOrg, useProducts } from '@/lib/queries';
import type { DocumentStatus } from '@/lib/types';
import { CreateDocumentDialog } from './create-dialog';

const ALL = '__all';

function DocumentsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = useMemo(() => parseDocumentFilter(new URLSearchParams(searchParams.toString())), [searchParams]);
  const orgQ = useOrg(org);
  const products = useProducts(org);
  const product = products.data?.find((p) => p.key === filter.product) ?? products.data?.[0];
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const list = useDocuments(org, product?.id, documentFilterToApiQuery(filter));
  const [creating, setCreating] = useState(false);
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

  if (products.isError) return <QueryError error={products.error} noAccessMessage="你没有查看产品的权限。" retryMessage="加载产品失败，请重试。" onRetry={() => products.refetch()} />;
  if (!products.data) return <Skeleton className="h-64" />;
  if (!product) {
    return (
      <>
        <PageHeader title="文档" />
        <EmptyState icon={FileText} title="还没有产品" description="PRD 挂在产品下。请组织管理员先在「组织设置 / 产品」中创建产品。" />
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
        description={`${product.name} · 变更 PRD`}
        actions={
          <>
            {products.data.length > 1 && (
              <Select value={product.key} onValueChange={(key) => router.replace(`?${documentFilterToSearch({ ...filter, product: key })}`)}>
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
            {canCreate && <Button onClick={() => setCreating(true)}>新建 PRD</Button>}
          </>
        }
      />
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
            {DOCUMENT_STATUSES.filter((s) => s !== 'merged').map((s) => (
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
      <CreateDocumentDialog org={org} productId={product.id} open={creating} onOpenChange={setCreating} />
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

`MemberPicker` 的 `className` 作用在触发按钮上（P1-C 组件约定）；若该组件不支持 `placeholder` 与 `noneLabel` 同时出现时的文字，以组件现有行为为准，不改组件。`table-fixed` 搭配列宽让长标题在单元格内截断，760px 时表格在自己的容器里横向滚动。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @flower/web exec vitest run && pnpm --filter @flower/web typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e documents.spec.ts auth.spec.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib apps/web/src/components/document-status.tsx apps/web/src/features/shell apps/web/src/features/documents/model.ts apps/web/src/features/documents/model.test.ts "apps/web/src/app/(app)/[org]/documents" apps/web/e2e/helpers.ts apps/web/e2e/auth.spec.ts apps/web/e2e/documents.spec.ts
git commit -m "feat(web): 文档导航、PRD 列表与新建（Flower 文档 / 外部链接）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: 页面：PRD 详情——编辑器与自动保存、冲突提示、外部链接卡片、右侧栏（状态、负责人、覆盖的需求、检查项）

**Files:**
- Modify: `apps/web/src/components/check-items.tsx`（整文件替换：按检查项列表与接口前缀工作，需求与 PRD 共用；显示「跟随 PRD」）
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`、`apps/web/src/app/(app)/[org]/reviews/page.tsx`（`CheckItems` 新用法）
- Modify: `apps/web/src/features/documents/model.ts`、`model.test.ts`（`parseRequirementKeys`、`saveStateLabel`）
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/external-card.tsx`
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/side-panel.tsx`
- Test: `apps/web/e2e/documents-editor.spec.ts`

**Interfaces:**
- Consumes: Task 1 `DocumentBodyEditor`、`PrdEditorHandle`；Task 10 `useDocument`、`documentKeys`、`apiUpload`、`DocumentStatusBadge`、`sourceLabel`、`documentHref`；现有 `MemberPicker`、`pickerOptions`、`activePeople`、`canListMembers`
- Produces:
  - `components/check-items.tsx`：`CheckItems({ items, canEdit, basePath, invalidate, title? })`——`items: CheckItem[]`；`basePath` 形如 `/orgs/acme/requirements/{id}/checks` 或 `/orgs/acme/documents/{id}/checks`；区块的可访问名为 `title`（缺省「检查项」）
  - `features/documents/model.ts`：`parseRequirementKeys(input: string): string[]`；`type SaveState = 'saved' | 'dirty' | 'saving'`；`saveStateLabel(state: SaveState, editable: boolean): string`
  - `editor-pane.tsx`：`EditorPane({ org, doc, onReload })`；`AUTOSAVE_MS = 1000`；区块可访问名「正文」，保存状态 `role="status"`，冲突提示 `role="alert"` 含「文档已被其他人修改」与按钮「重新加载」
  - `external-card.tsx`：`ExternalCard({ org, doc, onConvert? })`；区块可访问名「外部文档」
  - `side-panel.tsx`：`SidePanel({ org, doc, onReload })`；`<aside>`，区块「状态」「负责人」「覆盖的需求」与 `CheckItems`；状态按钮文字「改为{状态}」；覆盖需求的输入框标签「需求编号」、按钮「关联」、移出按钮可访问名「移出 {编号}」
  - 详情页：`/[org]/documents/[key]`；`epoch` 变化时编辑器重新挂载（冲突后重新加载、Task 12 的恢复版本、Task 13 的导入）

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/documents/model.test.ts`：第 2 行 import 加入 `parseRequirementKeys, saveStateLabel`，文件末尾加：

```ts
describe('详情页辅助', () => {
  it('需求编号：逗号、顿号、空白分隔，转大写、去重，丢弃不合法的写法', () => {
    expect(parseRequirementKeys(' pan-1，PAN-2、PAN-1  x-y PAN-03 ')).toEqual(['PAN-1', 'PAN-2', 'PAN-03']);
    expect(parseRequirementKeys('')).toEqual([]);
  });

  it('保存状态文字', () => {
    expect(saveStateLabel('saved', true)).toBe('已保存');
    expect(saveStateLabel('dirty', true)).toBe('未保存');
    expect(saveStateLabel('saving', true)).toBe('保存中…');
    expect(saveStateLabel('saved', false)).toBe('只读');
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: FAIL，`parseRequirementKeys` 未导出。

- [ ] **Step 2: 实现辅助函数**

`apps/web/src/features/documents/model.ts` 末尾加：

```ts
/** 「关联需求」输入框：逗号、顿号、空白分隔的需求编号，转大写、去重。 */
export function parseRequirementKeys(input: string): string[] {
  const keys = input
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9]{1,9}-\d{1,9}$/.test(s));
  return [...new Set(keys)];
}

export type SaveState = 'saved' | 'dirty' | 'saving';

export function saveStateLabel(state: SaveState, editable: boolean): string {
  if (!editable) return '只读';
  return state === 'saving' ? '保存中…' : state === 'dirty' ? '未保存' : '已保存';
}
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

新建 `apps/web/e2e/documents-editor.spec.ts`：

```ts
import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import {
  acceptInvite,
  createDocument,
  createMember,
  createProduct,
  createRequirement,
  expectNoPageOverflow,
  login,
  ok,
  OWNER,
  presetTemplateId,
  setupInstance,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

/** 在正文末尾输入一段文字，等自动保存的 PUT 返回。 */
async function typeAtEnd(page: Page, docId: string, text: string) {
  const saved = page.waitForResponse((r) => r.url().endsWith(`/documents/${docId}/content`) && r.request().method() === 'PUT');
  await page.getByRole('region', { name: '正文' }).locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  return saved;
}

test('Flower 文档：输入后自动保存，刷新后仍在', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '上传提速', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  expect((await typeAtEnd(page, doc.id, '上传失败率降到百分之一以下')).ok()).toBeTruthy();
  await expect(body.getByRole('status')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('上传失败率降到百分之一以下');
});

test('两个窗口同时编辑：后保存的一方看到冲突提示，重新加载后看到对方的内容', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '冲突', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  const other = await page.context().newPage();
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await other.goto(`/acme/documents/${doc.displayKey}`);
  await expect(other.getByRole('region', { name: '正文' })).toContainText('1. 背景介绍');

  expect((await typeAtEnd(page, doc.id, '甲窗口写的')).ok()).toBeTruthy();
  const conflict = await typeAtEnd(other, doc.id, '乙窗口写的');
  expect(conflict.status()).toBe(409);
  const alert = other.getByRole('alert').filter({ hasText: '文档已被其他人修改' });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: '重新加载' }).click();
  await expect(other.getByRole('region', { name: '正文' })).toContainText('甲窗口写的');
  await expect(other.getByRole('region', { name: '正文' })).not.toContainText('乙窗口写的');
  await expect(other.getByRole('alert').filter({ hasText: '文档已被其他人修改' })).toHaveCount(0);
});

test('外部 PRD：链接卡片、改状态、指定负责人、覆盖需求的关联与移出', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '分片上传');
  await createMember(request, '产品经理甲');
  const doc = await createDocument(request, productId, { title: '外部方案', externalUrl: 'https://doc.weixin.qq.com/doc/w3_X?scode=1' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);

  const card = page.getByRole('region', { name: '外部文档' });
  await expect(card).toContainText('企业微信文档');
  await expect(card.getByRole('link', { name: 'https://doc.weixin.qq.com/doc/w3_X?scode=1' })).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('region', { name: '正文' })).toHaveCount(0);

  const side = page.getByRole('complementary');
  await side.getByRole('button', { name: '改为评审中' }).click();
  await expect(side.getByRole('region', { name: '状态' })).toContainText('评审中');
  await expect(side.getByRole('button', { name: '改为已通过' })).toBeVisible();

  await side.getByRole('combobox', { name: '负责人' }).click();
  await page.getByRole('option', { name: '产品经理甲' }).click();
  await expect(side.getByRole('combobox', { name: '负责人' })).toHaveText('产品经理甲');

  const cover = side.getByRole('region', { name: '覆盖的需求' });
  await expect(cover.getByText('还没有覆盖需求')).toBeVisible();
  await cover.getByLabel('需求编号').fill('pan-1');
  await cover.getByRole('button', { name: '关联' }).click();
  await expect(cover.getByRole('link', { name: /PAN-1/ })).toBeVisible();
  await cover.getByRole('button', { name: '移出 PAN-1' }).click();
  await expect(cover.getByText('还没有覆盖需求')).toBeVisible();
});

test('只读成员：编辑器不可编辑，没有改状态按钮；1440 与 760 宽度下页面不横向滚动', async ({ browser, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '只读查看', templateId: await presetTemplateId(request, productId) });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/documents/${doc.displayKey}`);
    await expect(page.getByRole('region', { name: '正文' })).toContainText('1. 背景介绍');
    await expect(page.locator('.bn-editor')).toHaveAttribute('contenteditable', 'false');
    await expect(page.getByRole('complementary').getByRole('region', { name: '状态' })).toContainText('草稿');
    await expect(page.getByRole('button', { name: /^改为/ })).toHaveCount(0);
    await expectNoPageOverflow(page);
  }
  await ctx.close();
});
```

Run: `pnpm --filter @flower/web e2e documents-editor.spec.ts`
Expected: FAIL，详情页不存在。

- [ ] **Step 4: 通用的检查项组件**

把 `apps/web/src/components/check-items.tsx` 整个替换为：

```tsx
'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { CHECK_STATE_LABEL } from '@/lib/labels';
import { useApiMutation } from '@/lib/queries';
import type { CheckItem, CheckState } from '@/lib/types';

export const CHECK_STATE_STYLE: Record<CheckState, string> = {
  not_started: 'text-muted-foreground',
  in_progress: 'text-amber-700 dark:text-amber-400',
  passed: 'text-primary',
  rejected: 'text-destructive',
  not_needed: 'text-muted-foreground',
};

function Rounds({ meta }: { meta: Record<string, unknown> }) {
  const rounds = Array.isArray(meta.rounds) ? (meta.rounds as Array<{ blockingCount?: number }>) : null;
  if (!rounds?.length) return null;
  return (
    <p className="text-[12px] text-muted-foreground">
      共 {rounds.length} 轮，最后一轮阻塞问题 {rounds.at(-1)?.blockingCount ?? 0} 个
    </p>
  );
}

/**
 * 检查项与会签：普通检查项改状态、本人签字、产品管理员代签。需求与 PRD 共用，basePath 决定写到哪个对象上
 * （`/orgs/{org}/requirements/{id}/checks` 或 `/orgs/{org}/documents/{id}/checks`）。
 */
export function CheckItems({
  items,
  canEdit,
  basePath,
  invalidate,
  title = '检查项',
}: {
  items: CheckItem[];
  canEdit: boolean;
  basePath: string;
  invalidate: ReadonlyArray<readonly unknown[]>;
  title?: string;
}) {
  const headingId = useId();
  const [proxy, setProxy] = useState<{ item: CheckItem; ruleIndex: number } | null>(null);
  const [decision, setDecision] = useState<'passed' | 'rejected'>('passed');
  const [note, setNote] = useState('');
  const setState = useApiMutation((v: { key: string; state: CheckState }) => api(`${basePath}/${v.key}`, { method: 'PUT', body: { state: v.state } }), { invalidate });
  const sign = useApiMutation(
    (v: { key: string; decision: 'passed' | 'rejected'; ruleIndex?: number; onBehalf?: boolean; note?: string }) =>
      api(`${basePath}/${v.key}/signoffs`, { method: 'POST', body: { decision: v.decision, ruleIndex: v.ruleIndex, onBehalf: v.onBehalf, note: v.note } }),
    {
      invalidate,
      success: '已签字',
      onSuccess: () => {
        setProxy(null);
        setNote('');
      },
    },
  );
  if (items.length === 0) return null;

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-3 text-sm font-semibold">
        {title}
      </h2>
      <ul className="flex flex-col divide-y">
        {items.map((c) => (
          <li key={c.key} className="flex flex-col gap-1.5 py-2.5" aria-label={c.label}>
            <div className="flex items-center gap-3">
              <span className="w-24 text-[13px] font-medium">{c.label}</span>
              {c.type === 'single' && canEdit && !c.locked ? (
                <Select value={c.state} onValueChange={(v) => setState.mutate({ key: c.key, state: v as CheckState })}>
                  <SelectTrigger className="h-8 w-28" aria-label={`${c.label}状态`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CHECK_STATE_LABEL) as CheckState[]).map((s) => (
                      <SelectItem key={s} value={s}>
                        {CHECK_STATE_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className={`text-[13px] ${CHECK_STATE_STYLE[c.state]}`}>{CHECK_STATE_LABEL[c.state]}</span>
              )}
              {c.locked && <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[12px] text-muted-foreground">跟随 PRD</span>}
              {c.note && <span className="truncate text-[12px] text-muted-foreground">{c.note}</span>}
            </div>
            <Rounds meta={c.meta} />
            {c.type === 'signoff' && (
              <ul className="ml-24 flex flex-col gap-1">
                {c.signers.map((s) => {
                  const latest = [...c.signoffs].reverse().find((x) => x.ruleIndex === s.index);
                  return (
                    <li key={s.index} className="flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="w-24 text-muted-foreground">{s.label}</span>
                      {latest ? (
                        <span className={latest.decision === 'passed' ? 'text-primary' : 'text-destructive'}>
                          {latest.decision === 'passed' ? '通过' : '驳回'} · {latest.signer.displayName}
                          {latest.actedBy && `（由 ${latest.actedBy.displayName} 代签）`} · {formatDateTime(latest.at)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">未签</span>
                      )}
                      {c.canSign.includes(s.index) && (
                        <>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[12px]" disabled={sign.isPending} onClick={() => sign.mutate({ key: c.key, decision: 'passed', ruleIndex: s.index })}>
                            通过
                          </Button>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[12px]" disabled={sign.isPending} onClick={() => sign.mutate({ key: c.key, decision: 'rejected', ruleIndex: s.index })}>
                            驳回
                          </Button>
                        </>
                      )}
                      {c.canSignOnBehalf.includes(s.index) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[12px]"
                          onClick={() => {
                            setDecision('passed');
                            setNote('');
                            setProxy({ item: c, ruleIndex: s.index });
                          }}
                        >
                          代签
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <Dialog open={!!proxy} onOpenChange={(o) => !o && setProxy(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>代「{proxy ? proxy.item.signers[proxy.ruleIndex]?.label : ''}」签字</DialogTitle>
          </DialogHeader>
          <Select value={decision} onValueChange={(v) => setDecision(v as 'passed' | 'rejected')}>
            <SelectTrigger aria-label="结论">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="passed">通过</SelectItem>
              <SelectItem value="rejected">驳回</SelectItem>
            </SelectContent>
          </Select>
          <Textarea aria-label="备注" placeholder="例如：电话确认" value={note} onChange={(e) => setNote(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setProxy(null)}>
              取消
            </Button>
            <Button disabled={sign.isPending} onClick={() => proxy && sign.mutate({ key: proxy.item.key, decision, ruleIndex: proxy.ruleIndex, onBehalf: true, note })}>
              确认代签
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：`import { requirementKeys, useApiMutation, useRequirement } from '@/lib/queries';` 改为 `import { qk, requirementKeys, useApiMutation, useRequirement } from '@/lib/queries';`；`<CheckItems org={org} requirement={r} />` 改为：

```tsx
          <CheckItems items={r.checkItems} canEdit={canEdit} basePath={`/orgs/${org}/requirements/${r.id}/checks`} invalidate={[requirementKeys(org), qk.workbench]} />
```

`apps/web/src/app/(app)/[org]/reviews/page.tsx` 的 `RowDetail`：`return <CheckItems org={org} requirement={q.data} />;` 改为：

```tsx
  return (
    <CheckItems
      items={q.data.checkItems}
      canEdit={q.data.myRole !== 'viewer'}
      basePath={`/orgs/${org}/requirements/${q.data.id}/checks`}
      invalidate={[requirementKeys(org), qk.workbench]}
    />
  );
```

并把该文件的 `import { useProducts, useRequirement, useReviewQueue } from '@/lib/queries';` 改为 `import { qk, requirementKeys, useProducts, useRequirement, useReviewQueue } from '@/lib/queries';`。

- [ ] **Step 5: 详情页**

新建 `apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`：

```tsx
'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { PrdEditorHandle } from '@/features/documents/editor/prd-editor';
import { type SaveState, saveStateLabel } from '@/features/documents/model';
import { ApiError, api, apiUpload } from '@/lib/api';
import { documentKeys, useApiMutation } from '@/lib/queries';
import type { Attachment, DocumentDetail } from '@/lib/types';

// BlockNote 只在浏览器里运行
const DocumentBodyEditor = dynamic(() => import('@/features/documents/editor/body-editor').then((m) => m.DocumentBodyEditor), {
  ssr: false,
  loading: () => <Skeleton className="h-96" />,
});

export const AUTOSAVE_MS = 1000;

/**
 * Flower 内 PRD 的正文：编辑后 1 秒自动保存（带 baseVersion 乐观锁）。409 时停止自动保存、提示重新加载；
 * 重新加载由页面换 key 让本组件重新挂载，编辑器读取新的正文与版本号。
 */
export function EditorPane({ org, doc, onReload }: { org: string; doc: DocumentDetail; onReload: () => void }) {
  const editable = doc.myRole !== 'viewer';
  const handle = useRef<PrdEditorHandle>(null);
  const version = useRef(doc.version);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const blocked = useRef(false);
  const [state, setState] = useState<SaveState>('saved');
  const save = useApiMutation(
    (markdown: string) => api<{ version: number }>(`/orgs/${org}/documents/${doc.id}/content`, { method: 'PUT', body: { baseVersion: version.current, markdown } }),
    { silentError: true, invalidate: [documentKeys(org)] },
  );
  const conflict = save.error instanceof ApiError && save.error.status === 409;

  const flush = () => {
    timer.current = null;
    if (inFlight.current) {
      timer.current = setTimeout(flush, AUTOSAVE_MS);
      return;
    }
    const markdown = handle.current?.getMarkdown();
    if (markdown === undefined) return;
    inFlight.current = true;
    setState('saving');
    save.mutate(markdown, {
      onSuccess: (r) => {
        version.current = r.version;
        setState(timer.current ? 'dirty' : 'saved');
      },
      onError: (e) => {
        if (e.status === 409) blocked.current = true;
        setState('dirty');
      },
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };

  const onDirty = () => {
    if (blocked.current) return;
    setState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  };

  const uploadImage = async (file: File): Promise<string> => {
    try {
      return (await apiUpload<{ attachment: Attachment }>(`/orgs/${org}/documents/${doc.id}/attachments`, file, file.name)).attachment.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '图片上传失败');
      throw e;
    }
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // 有未保存的修改时，关闭或刷新页面前由浏览器提示
  useEffect(() => {
    if (state === 'saved') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  return (
    <section className="rounded-md border bg-card" aria-label="正文">
      <div className="flex h-10 items-center justify-between border-b px-4 text-[13px] text-muted-foreground">
        <span>第 {doc.revisionNumber} 版</span>
        <span role="status">{saveStateLabel(state, editable)}</span>
      </div>
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b bg-destructive/5 px-4 py-2 text-[13px] text-destructive">
          <span>文档已被其他人修改，你刚才的修改没有保存。重新加载后再编辑（需要保留的内容请先复制）。</span>
          <Button size="sm" variant="outline" onClick={onReload}>
            重新加载
          </Button>
        </div>
      )}
      {save.error && !conflict && (
        <div className="px-4 pt-3">
          <FormError error={save.error} />
        </div>
      )}
      <div className="px-2 py-4">
        <DocumentBodyEditor ref={handle} initialMarkdown={doc.markdown ?? ''} editable={editable && !conflict} onDirty={onDirty} uploadImage={uploadImage} />
      </div>
    </section>
  );
}
```

新建 `apps/web/src/app/(app)/[org]/documents/[key]/external-card.tsx`：

```tsx
'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sourceLabel } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

/** 外部 PRD：链接卡片、修改链接、「转为 Flower 文档」入口（onConvert 由 Task 13 的导入对话框提供）。 */
export function ExternalCard({ org, doc, onConvert }: { org: string; doc: DocumentDetail; onConvert?: () => void }) {
  const canEdit = doc.myRole !== 'viewer';
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const patch = useApiMutation((externalUrl: string) => api(`/orgs/${org}/documents/${doc.id}`, { method: 'PATCH', body: { externalUrl } }), {
    silentError: true,
    invalidate: [documentKeys(org)],
    success: '已更新链接',
    onSuccess: () => setEditing(false),
  });
  return (
    <section aria-label="外部文档" className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <ExternalLink className="size-4" aria-hidden="true" />
        {sourceLabel(doc)}
      </p>
      <a href={doc.externalUrl ?? undefined} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">
        {doc.externalUrl}
      </a>
      <p className="text-[13px] text-muted-foreground">正文在外部平台。状态、覆盖需求、检查项与评论在 Flower 里处理；需要在 Flower 里编辑、留修订记录时，可以转为 Flower 文档（原链接保留）。</p>
      {canEdit &&
        (editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              patch.mutate(url);
            }}
          >
            <Input aria-label="文档网址" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
            <FormError error={patch.error} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={patch.isPending}>
                保存链接
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                取消
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setUrl(doc.externalUrl ?? '');
                patch.reset();
                setEditing(true);
              }}
            >
              修改链接
            </Button>
            {onConvert && (
              <Button size="sm" onClick={onConvert}>
                转为 Flower 文档
              </Button>
            )}
          </div>
        ))}
    </section>
  );
}
```

新建 `apps/web/src/app/(app)/[org]/documents/[key]/side-panel.tsx`：

```tsx
'use client';

import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CheckItems } from '@/components/check-items';
import { DocumentStatusBadge } from '@/components/document-status';
import { FormError } from '@/components/form-error';
import { MemberPicker } from '@/components/member-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { parseRequirementKeys } from '@/features/documents/model';
import { activePeople, canListMembers, pickerOptions } from '@/features/members/model';
import { ApiError, api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation, useMembers, useOrg } from '@/lib/queries';
import type { DocumentDetail, DocumentStatus } from '@/lib/types';

const CARD = 'rounded-md border bg-card p-4';

export function SidePanel({ org, doc }: { org: string; doc: DocumentDetail; onReload: () => void }) {
  const canEdit = doc.myRole !== 'viewer';
  const orgQ = useOrg(org);
  const members = useMembers(org, canListMembers(orgQ.data?.me));
  const invalidate = [documentKeys(org), requirementKeys(org), qk.workbench];
  const [keys, setKeys] = useState('');
  const move = useApiMutation((to: DocumentStatus) => api(`/orgs/${org}/documents/${doc.id}/transitions`, { method: 'POST', body: { to } }), {
    silentError: true,
    invalidate,
    success: '已更新状态',
  });
  const setOwner = useApiMutation((ownerMemberId: string | null) => api(`/orgs/${org}/documents/${doc.id}`, { method: 'PATCH', body: { ownerMemberId } }), {
    invalidate: [documentKeys(org)],
    success: '已保存',
  });
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
    <aside className="flex min-w-0 flex-col gap-4">
      <section className={CARD} aria-labelledby="doc-status-title">
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

      <section className={CARD} aria-labelledby="doc-owner-title">
        <h2 id="doc-owner-title" className="mb-2 text-sm font-semibold">
          负责人
        </h2>
        {canEdit && members.data ? (
          <MemberPicker
            label="负责人"
            options={pickerOptions(activePeople(members.data), doc.owner)}
            value={doc.owner?.id ?? null}
            noneLabel="未指定"
            onChange={(id) => setOwner.mutate(id)}
          />
        ) : (
          <p className="text-[13px]">{doc.owner?.displayName ?? '未指定'}</p>
        )}
      </section>

      <section className={CARD} aria-labelledby="doc-req-title">
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
              <Input aria-label="需求编号" placeholder="PAN-12, PAN-15" className="h-8" value={keys} onChange={(e) => setKeys(e.target.value)} />
              <Button type="submit" size="sm" disabled={link.isPending || !keys.trim()}>
                关联
              </Button>
            </div>
            <FormError error={link.error} />
          </form>
        )}
      </section>

      <CheckItems items={doc.checkItems} canEdit={canEdit} basePath={`/orgs/${org}/documents/${doc.id}/checks`} invalidate={invalidate} />

      {doc.source === 'native' && doc.externalUrl && (
        <p className="break-all text-[12px] text-muted-foreground">
          原链接：
          <a href={doc.externalUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {doc.externalUrl}
          </a>
        </p>
      )}
    </aside>
  );
}
```

（`SidePanel` 的 `onReload` 参数本任务不用，Task 12 的修订面板在恢复版本后调用它；先在类型里声明，避免 Task 12 改两处签名。）

新建 `apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`：

```tsx
'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation, useDocument } from '@/lib/queries';
import { EditorPane } from './editor-pane';
import { ExternalCard } from './external-card';
import { SidePanel } from './side-panel';

export default function DocumentPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const q = useDocument(org, decodeURIComponent(key));
  const d = q.data;
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  // 正文被外部替换（冲突后重新加载、恢复版本、导入）时加一，让编辑器按最新正文重新挂载
  const [epoch, setEpoch] = useState(0);
  const reload = async () => {
    await q.refetch();
    setEpoch((e) => e + 1);
  };
  const patch = useApiMutation((body: { title: string }) => api(`/orgs/${org}/documents/${d!.id}`, { method: 'PATCH', body }), {
    invalidate: [documentKeys(org)],
    success: '已保存',
    onSuccess: () => setEditingTitle(false),
  });

  if (!d && q.isError) {
    return <QueryError error={q.error} noAccessMessage="PRD 不存在，或你没有查看它所在产品的权限。" retryMessage="加载 PRD 失败，请重试。" onRetry={() => q.refetch()} />;
  }
  if (!d) return <Skeleton className="h-64" />;
  const canEdit = d.myRole !== 'viewer';

  return (
    <>
      <PageHeader
        crumbs={[{ label: '文档', href: `/${org}/documents?product=${d.productKey}` }, { label: d.displayKey }]}
        title={
          editingTitle ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                patch.mutate({ title });
              }}
            >
              <Input aria-label="标题" className="h-9 text-xl font-semibold" value={title} autoFocus maxLength={200} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditingTitle(false)} />
            </form>
          ) : (
            <button
              type="button"
              disabled={!canEdit}
              className="text-left disabled:cursor-default"
              onClick={() => {
                setTitle(d.title);
                setEditingTitle(true);
              }}
            >
              <span className="mr-2 font-mono text-base text-muted-foreground">{d.displayKey}</span>
              {d.title}
            </button>
          )
        }
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          {d.source === 'native' ? <EditorPane key={`${d.id}:${epoch}`} org={org} doc={d} onReload={() => void reload()} /> : <ExternalCard org={org} doc={d} />}
        </div>
        <SidePanel org={org} doc={d} onReload={() => void reload()} />
      </div>
    </>
  );
}
```

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @flower/web typecheck && pnpm --filter @flower/web lint --max-warnings 0 && pnpm --filter @flower/web exec vitest run`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e documents-editor.spec.ts requirements.spec.ts reviews.spec.ts layout.spec.ts`
Expected: PASS（后三个是改了 `CheckItems` 用法后的回归）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/check-items.tsx "apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx" "apps/web/src/app/(app)/[org]/reviews/page.tsx" apps/web/src/features/documents "apps/web/src/app/(app)/[org]/documents/[key]" apps/web/e2e/documents-editor.spec.ts
git commit -m "feat(web): PRD 详情：BlockNote 编辑与自动保存、冲突提示、外部链接卡片、状态与覆盖需求

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: 页面：修订记录（版本列表、任选两版按小节对比、恢复）与评论（划词评论、整篇评论、回复、解决、失效标记）

**Files:**
- Modify: `apps/web/src/features/documents/model.ts`、`model.test.ts`（`clipContext`、`groupThreads`、`SECTION_CHANGE_LABEL`、`ANCHOR_STATE_LABEL`）
- Create: `apps/web/src/features/documents/editor/selection.ts`
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/revisions.tsx`
- Create: `apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/side-panel.tsx`（加修订记录）
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`（选中文字后的「评论」按钮）
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`（加评论区）
- Test: `apps/web/e2e/documents-revisions.spec.ts`

**Interfaces:**
- Consumes: Task 10 `useDocumentRevisions`、`useDocumentDiff`、`useDocumentComments`、`qk.documentComments`；Task 11 `EditorPane`、`SidePanel`（`onReload`）
- Produces:
  - `model.ts`：`clipContext(before: string, after: string): { prefix: string; suffix: string }`（各取 32 个字符）；`type Thread = { comment: DocumentComment; replies: DocumentComment[] }`；`groupThreads(comments: DocumentComment[]): Thread[]`；`SECTION_CHANGE_LABEL`；`ANCHOR_STATE_LABEL`（stale → 已失效，unanchored → 未定位）
  - `selection.ts`：`type SelectionAnchor = { quote: string; prefix: string; suffix: string }`；`selectionAnchor(container: HTMLElement, sel: Selection | null): (SelectionAnchor & { rect: DOMRect }) | null`
  - `revisions.tsx`：`Revisions({ org, doc, onRestored })`，区块名「修订记录」；每版的按钮「对比第 N 版与上一版」「恢复第 N 版」；对比对话框名「对比修订」，两个下拉「从」「到」，每个变化小节是一个以小节标题命名的 region
  - `comments.tsx`：`DocumentComments({ org, doc })`，区块名「评论」，整篇评论输入框「发表评论」与按钮「发表」，线程按钮「回复」「标为已解决」「重新打开」，回复输入框「回复内容」与按钮「发送回复」；`AnchorCommentDialog({ documentId, anchor, onClose })`（组织取自地址栏），对话框名「评论选中的文字」，输入框「评论内容」，按钮「发表」

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/documents/model.test.ts`：第 2 行 import 加入 `clipContext, groupThreads`，文件末尾加：

```ts
describe('评论', () => {
  it('划词的前后文各取 32 个字符', () => {
    const before = '甲'.repeat(40) + '前文';
    expect(clipContext(before, '后文' + '乙'.repeat(40))).toEqual({ prefix: before.slice(-32), suffix: ('后文' + '乙'.repeat(40)).slice(0, 32) });
    expect(clipContext('', '')).toEqual({ prefix: '', suffix: '' });
  });

  it('按顶层评论分组，回复挂在所属评论下，找不到上级的回复当作顶层', () => {
    const c = (id: string, parentId: string | null) =>
      ({ id, parentId, author: null, body: id, anchor: null, anchorState: null, resolvedAt: null, resolvedBy: null, createdAt: '2026-10-08T00:00:00Z' }) as const;
    expect(groupThreads([c('a', null), c('b', null), c('a1', 'a'), c('x1', 'gone')]).map((t) => [t.comment.id, t.replies.map((r) => r.id)])).toEqual([
      ['a', ['a1']],
      ['b', []],
      ['x1', []],
    ]);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: FAIL，`clipContext` 未导出。

- [ ] **Step 2: 纯逻辑与选区**

`apps/web/src/features/documents/model.ts`：顶部加 `import type { DocumentComment } from '@/lib/types';`，末尾加：

```ts
const CONTEXT_CHARS = 32;

/** 划词评论的前后文（W3C TextQuoteSelector 的 prefix / suffix），各取 32 个字符。 */
export function clipContext(before: string, after: string): { prefix: string; suffix: string } {
  return { prefix: before.slice(-CONTEXT_CHARS), suffix: after.slice(0, CONTEXT_CHARS) };
}

export type Thread = { comment: DocumentComment; replies: DocumentComment[] };

/** 评论按顶层分组（保持时间顺序），回复挂在所属评论下；上级不存在的回复当作顶层显示。 */
export function groupThreads(comments: DocumentComment[]): Thread[] {
  const ids = new Set(comments.map((c) => c.id));
  const threads = comments.filter((c) => !c.parentId || !ids.has(c.parentId)).map((comment) => ({ comment, replies: [] as DocumentComment[] }));
  const byId = new Map(threads.map((t) => [t.comment.id, t]));
  for (const c of comments) if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId)!.replies.push(c);
  return threads;
}

export const SECTION_CHANGE_LABEL = { added: '新增', removed: '删除', modified: '修改' } as const;
export const ANCHOR_STATE_LABEL = { stale: '已失效', unanchored: '未定位' } as const;
```

新建 `apps/web/src/features/documents/editor/selection.ts`：

```ts
import { clipContext } from '../model';

export type SelectionAnchor = { quote: string; prefix: string; suffix: string };

/** 编辑器容器里的当前选区：引用文字、前后文与位置；选区为空、超过 500 字或不在容器里时返回 null。 */
export function selectionAnchor(container: HTMLElement, sel: Selection | null): (SelectionAnchor & { rect: DOMRect }) | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = range.toString().trim();
  if (!quote || quote.length > 500) return null;
  const before = document.createRange();
  before.setStart(container, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(container, container.childNodes.length);
  return { quote, ...clipContext(before.toString(), after.toString()), rect: range.getBoundingClientRect() };
}
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

新建 `apps/web/e2e/documents-revisions.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('修订记录：任选两版按小节对比，恢复到旧版本', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '修订', externalUrl: 'https://docs.qq.com/doc/rev' });
  await ok(request.post(`/api/v1/orgs/acme/documents/${doc.id}/convert`, { data: { baseVersion: 1, markdown: '## 背景\n\n上传慢\n\n## 方案\n\n分片上传' } }));
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: 2, markdown: '## 背景\n\n上传慢且经常失败\n\n## 方案\n\n分片上传\n\n## 埋点\n\n记录耗时' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const revs = page.getByRole('complementary').getByRole('region', { name: '修订记录' });
  await expect(revs.getByRole('listitem')).toHaveCount(2);
  await expect(revs.getByRole('listitem').last()).toContainText('由外部文档转换');

  await revs.getByRole('button', { name: '对比第 2 版与上一版' }).click();
  const dialog = page.getByRole('dialog', { name: '对比修订' });
  await expect(dialog.getByRole('region', { name: '背景' })).toContainText('修改');
  await expect(dialog.getByRole('region', { name: '背景' })).toContainText('上传慢且经常失败');
  await expect(dialog.getByRole('region', { name: '埋点' })).toContainText('新增');
  await expect(dialog.getByRole('region', { name: '方案' })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '从' }).click();
  await page.getByRole('option', { name: '第 2 版' }).click();
  await expect(dialog).toContainText('请选择两个不同的版本');
  await page.keyboard.press('Escape');

  await revs.getByRole('button', { name: '恢复第 1 版' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '恢复' }).click();
  await expect(page.getByRole('region', { name: '正文' })).not.toContainText('经常失败');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('上传慢');
  await expect(revs.getByRole('listitem').first()).toContainText('恢复到第 1 版');
});

test('评论：选中文字评论，原文改动后标为已失效；整篇评论、回复、标为已解决', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '评论', externalUrl: 'https://docs.qq.com/doc/cmt' });
  await ok(request.post(`/api/v1/orgs/acme/documents/${doc.id}/convert`, { data: { baseVersion: 1, markdown: '## 背景\n\n上传大文件时经常超时\n\n## 方案\n\n分片上传' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('region', { name: '正文' }).getByText('上传大文件时经常超时').click({ clickCount: 3 });
  await page.getByRole('button', { name: '评论', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '评论选中的文字' });
  await expect(dialog).toContainText('上传大文件时经常超时');
  await dialog.getByLabel('评论内容').fill('超时阈值是多少？');
  await dialog.getByRole('button', { name: '发表' }).click();
  const comments = page.getByRole('region', { name: '评论' });
  const anchored = comments.getByRole('listitem').filter({ hasText: '超时阈值是多少？' });
  await expect(anchored).toContainText('位于「背景」');

  await comments.getByLabel('发表评论').fill('整体同意');
  await comments.getByRole('button', { name: '发表' }).click();
  const whole = comments.getByRole('listitem').filter({ hasText: '整体同意' });
  await whole.getByRole('button', { name: '回复' }).click();
  await whole.getByLabel('回复内容').fill('收到');
  await whole.getByRole('button', { name: '发送回复' }).click();
  await expect(whole).toContainText('收到');
  await whole.getByRole('button', { name: '标为已解决' }).click();
  await expect(whole).toContainText('已解决');

  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: 2, markdown: '## 背景\n\n上传大文件时偶尔失败\n\n## 方案\n\n分片上传' } }));
  await page.reload();
  await expect(page.getByRole('region', { name: '评论' }).getByRole('listitem').filter({ hasText: '超时阈值是多少？' })).toContainText('已失效');
});
```

Run: `pnpm --filter @flower/web e2e documents-revisions.spec.ts`
Expected: FAIL，找不到「修订记录」区块。

- [ ] **Step 4: 修订记录**

新建 `apps/web/src/app/(app)/[org]/documents/[key]/revisions.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { QueryError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { SECTION_CHANGE_LABEL } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation, useDocumentDiff, useDocumentRevisions } from '@/lib/queries';
import type { DocumentDetail, DocumentRevision } from '@/lib/types';
import { cn } from '@/lib/utils';

const LINE_STYLE = { add: 'bg-primary/10 text-primary', del: 'bg-destructive/10 text-destructive line-through', same: 'text-muted-foreground' } as const;
const LINE_MARK = { add: '+', del: '-', same: ' ' } as const;

function DiffDialog({ org, docId, revisions, initial, onClose }: { org: string; docId: string; revisions: DocumentRevision[]; initial: { from: number; to: number }; onClose: () => void }) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const diff = useDocumentDiff(org, docId, from, to);
  const picker = (label: string, value: number, onChange: (n: number) => void) => (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-8 w-28" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {revisions.map((r) => (
          <SelectItem key={r.number} value={String(r.number)}>
            第 {r.number} 版
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>对比修订</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 text-[13px]">
          从 {picker('从', from, setFrom)} 到 {picker('到', to, setTo)}
        </div>
        {from === to ? (
          <p className="text-[13px] text-muted-foreground">请选择两个不同的版本</p>
        ) : diff.isError ? (
          <QueryError error={diff.error} noAccessMessage="没有查看这份 PRD 的权限。" retryMessage="加载对比失败，请重试。" onRetry={() => diff.refetch()} />
        ) : !diff.data ? (
          <Skeleton className="h-32" />
        ) : !diff.data.title && diff.data.sections.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">两版内容相同</p>
        ) : (
          <div className="flex flex-col gap-3">
            {diff.data.title && (
              <p className="text-[13px]">
                标题：<span className="line-through">{diff.data.title.old}</span> → {diff.data.title.new}
              </p>
            )}
            {diff.data.sections.map((s) => (
              <section key={`${s.change}:${s.key}`} aria-label={s.heading ?? '开头'} className="rounded-md border">
                <header className="flex items-center gap-2 border-b px-3 py-1.5 text-[13px]">
                  <span className="rounded-sm bg-muted px-1.5 text-xs">{SECTION_CHANGE_LABEL[s.change]}</span>
                  <span className="font-medium">{s.key}</span>
                </header>
                <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-5">
                  {s.lines.map((l, i) => (
                    <div key={i} className={cn('whitespace-pre-wrap', LINE_STYLE[l.type])}>
                      {LINE_MARK[l.type]} {l.text}
                    </div>
                  ))}
                </pre>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 修订记录：版本列表（作者、时间、摘要），与上一版对比（对话框里可任选两版），恢复到旧版本（新建一版）。 */
export function Revisions({ org, doc, onRestored }: { org: string; doc: DocumentDetail; onRestored: () => void }) {
  const canEdit = doc.myRole !== 'viewer';
  const list = useDocumentRevisions(org, doc.id);
  const [diff, setDiff] = useState<{ from: number; to: number } | null>(null);
  const restore = useApiMutation((number: number) => api(`/orgs/${org}/documents/${doc.id}/restore`, { method: 'POST', body: { number, baseVersion: doc.version } }), {
    invalidate: [documentKeys(org)],
    success: '已恢复',
    onSuccess: () => onRestored(),
  });
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-revisions-title">
      <h2 id="doc-revisions-title" className="mb-2 text-sm font-semibold">
        修订记录
      </h2>
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage="没有查看修订的权限。" retryMessage="加载修订失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-24" />
      ) : (
        <ul className="flex flex-col divide-y">
          {list.data.map((r) => (
            <li key={r.number} className="flex flex-col gap-1 py-2 text-[13px]">
              <div className="flex items-center gap-2">
                <span className="font-medium">第 {r.number} 版</span>
                {r.number === doc.revisionNumber && <span className="rounded-sm bg-muted px-1.5 text-xs">当前</span>}
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.author?.displayName ?? '—'}</span>
                <span className="font-mono text-xs text-muted-foreground">{formatDateTime(r.updatedAt)}</span>
              </div>
              {r.summary && <p className="text-xs text-muted-foreground">{r.summary}</p>}
              <div className="flex gap-1">
                {r.number > 1 && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" aria-label={`对比第 ${r.number} 版与上一版`} onClick={() => setDiff({ from: r.number - 1, to: r.number })}>
                    对比
                  </Button>
                )}
                {canEdit && r.number !== doc.revisionNumber && (
                  <ConfirmAction
                    trigger={
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" aria-label={`恢复第 ${r.number} 版`} disabled={restore.isPending}>
                        恢复
                      </Button>
                    }
                    title={`恢复到第 ${r.number} 版？`}
                    description="会以这一版的内容新建一版，之前的版本都保留。编辑器里还没保存的修改会被丢弃。"
                    confirmLabel="恢复"
                    onConfirm={() => restore.mutate(r.number)}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {diff && list.data && <DiffDialog org={org} docId={doc.id} revisions={list.data} initial={diff} onClose={() => setDiff(null)} />}
    </section>
  );
}
```

`side-panel.tsx`：

1. 函数签名 `export function SidePanel({ org, doc }: { org: string; doc: DocumentDetail; onReload: () => void })` 改为 `export function SidePanel({ org, doc, onReload }: { org: string; doc: DocumentDetail; onReload: () => void })`。
2. import 区加 `import { Revisions } from './revisions';`
3. `<CheckItems … />` 之后加：

```tsx
      {doc.source === 'native' && <Revisions org={org} doc={doc} onRestored={onReload} />}
```

- [ ] **Step 5: 评论**

新建 `apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`：

```tsx
'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import type { SelectionAnchor } from '@/features/documents/editor/selection';
import { ANCHOR_STATE_LABEL, groupThreads } from '@/features/documents/model';
import { formatDateTime } from '@/features/requirements/format';
import { api } from '@/lib/api';
import { qk, useApiMutation, useDocumentComments, useOrg } from '@/lib/queries';
import type { DocumentComment, DocumentDetail } from '@/lib/types';

function Quote({ c }: { c: DocumentComment }) {
  if (!c.anchor && c.anchorState !== 'unanchored') return null;
  return (
    <div className="flex flex-col gap-1">
      {c.anchor && <blockquote className="border-l-2 pl-2 text-[12px] text-muted-foreground">{c.anchor.quote}</blockquote>}
      <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
        {c.anchor?.sectionHeading && <span>位于「{c.anchor.sectionHeading}」</span>}
        {(c.anchorState === 'stale' || c.anchorState === 'unanchored') && (
          <span className="rounded-sm bg-amber-100 px-1.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{ANCHOR_STATE_LABEL[c.anchorState]}</span>
        )}
      </p>
    </div>
  );
}

/** PRD 评论区：整篇评论、回复、标为已解决；划词评论显示引用原文、所在小节与失效标记。 */
export function DocumentComments({ org, doc }: { org: string; doc: DocumentDetail }) {
  const orgQ = useOrg(org);
  const list = useDocumentComments(org, doc.id);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const invalidate = [qk.documentComments(org, doc.id)];
  const add = useApiMutation((v: { body: string; parentId?: string }) => api(`/orgs/${org}/documents/${doc.id}/comments`, { method: 'POST', body: v }), {
    silentError: true,
    invalidate,
    success: '已发表',
  });
  const resolve = useApiMutation((v: { id: string; resolved: boolean }) => api(`/orgs/${org}/document-comments/${v.id}/resolve`, { method: 'POST', body: { resolved: v.resolved } }), {
    invalidate,
  });
  const me = orgQ.data?.me.memberId;
  const canResolve = (c: DocumentComment) => doc.myRole !== 'viewer' || c.author?.id === me;

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="doc-comments-title">
      <h2 id="doc-comments-title" className="mb-3 text-sm font-semibold">
        评论
      </h2>
      {list.isError ? (
        <QueryError error={list.error} noAccessMessage="没有查看评论的权限。" retryMessage="加载评论失败，请重试。" onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-20" />
      ) : list.data.length === 0 ? (
        <p className="mb-3 text-[13px] text-muted-foreground">还没有评论。在正文里选中文字可以针对那段话评论。</p>
      ) : (
        <ul className="mb-3 flex flex-col divide-y">
          {groupThreads(list.data).map(({ comment: c, replies }) => (
            <li key={c.id} className="flex flex-col gap-2 py-3">
              <Quote c={c} />
              <p className="text-[12px] text-muted-foreground">
                {c.author?.displayName ?? '已删除的成员'} · <span className="font-mono">{formatDateTime(c.createdAt)}</span>
                {c.resolvedAt && <span className="ml-2 rounded-sm bg-muted px-1.5">已解决</span>}
              </p>
              <p className="whitespace-pre-wrap text-[13px]">{c.body}</p>
              {replies.length > 0 && (
                <ul className="ml-4 flex flex-col gap-2 border-l pl-3">
                  {replies.map((r) => (
                    <li key={r.id} className="text-[13px]">
                      <span className="text-[12px] text-muted-foreground">{r.author?.displayName ?? '已删除的成员'}：</span>
                      <span className="whitespace-pre-wrap">{r.body}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[12px]"
                  onClick={() => {
                    setReplyTo(c.id);
                    setReply('');
                  }}
                >
                  回复
                </Button>
                {canResolve(c) && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: c.id, resolved: !c.resolvedAt })}>
                    {c.resolvedAt ? '重新打开' : '标为已解决'}
                  </Button>
                )}
              </div>
              {replyTo === c.id && (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    add.mutate({ body: reply, parentId: c.id }, { onSuccess: () => setReplyTo(null) });
                  }}
                >
                  <Textarea aria-label="回复内容" className="min-h-16 text-[13px]" value={reply} onChange={(e) => setReply(e.target.value)} />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={add.isPending || !reply.trim()}>
                      发送回复
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setReplyTo(null)}>
                      取消
                    </Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({ body }, { onSuccess: () => setBody('') });
        }}
      >
        <Textarea aria-label="发表评论" placeholder="对整篇 PRD 的意见" className="min-h-20 text-[13px]" value={body} onChange={(e) => setBody(e.target.value)} />
        <FormError error={add.error} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={add.isPending || !body.trim()}>
            发表
          </Button>
        </div>
      </form>
    </section>
  );
}

/** 选中正文文字后的评论对话框。 */
export function AnchorCommentDialog({ documentId, anchor, onClose }: { documentId: string; anchor: SelectionAnchor | null; onClose: () => void }) {
  const { org } = useParams<{ org: string }>();
  const [body, setBody] = useState('');
  const add = useApiMutation(() => api(`/orgs/${org}/documents/${documentId}/comments`, { method: 'POST', body: { body, anchor } }), {
    silentError: true,
    invalidate: [qk.documentComments(org, documentId)],
    success: '已发表',
    onSuccess: () => {
      setBody('');
      onClose();
    },
  });
  return (
    <Dialog
      open={!!anchor}
      onOpenChange={(o) => {
        if (!o) {
          add.reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>评论选中的文字</DialogTitle>
        </DialogHeader>
        <blockquote className="border-l-2 pl-2 text-[13px] text-muted-foreground">{anchor?.quote}</blockquote>
        <Textarea aria-label="评论内容" className="min-h-20 text-[13px]" value={body} onChange={(e) => setBody(e.target.value)} />
        <FormError error={add.error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={add.isPending || !body.trim()} onClick={() => add.mutate(undefined)}>
            发表
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`editor-pane.tsx`：

1. import 区加 `import { type SelectionAnchor, selectionAnchor } from '@/features/documents/editor/selection';` 与 `import { AnchorCommentDialog } from './comments';`
2. `const [state, setState] = useState<SaveState>('saved');` 之后加：

```tsx
  const container = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<(SelectionAnchor & { top: number; left: number }) | null>(null);
  const [commenting, setCommenting] = useState<SelectionAnchor | null>(null);
  /** 鼠标或键盘松开时读取选区，在选区下方显示「评论」按钮。 */
  const onSelect = () => {
    const el = container.current;
    const a = el ? selectionAnchor(el, window.getSelection()) : null;
    if (!el || !a) {
      setPick(null);
      return;
    }
    const box = el.getBoundingClientRect();
    setPick({ quote: a.quote, prefix: a.prefix, suffix: a.suffix, top: a.rect.bottom - box.top + 4, left: Math.max(0, a.rect.left - box.left) });
  };
```

3. 把 `<div className="px-2 py-4">…</div>` 整段替换为：

```tsx
      <div ref={container} className="relative px-2 py-4" onMouseUp={onSelect} onKeyUp={onSelect}>
        <DocumentBodyEditor ref={handle} initialMarkdown={doc.markdown ?? ''} editable={editable && !conflict} onDirty={onDirty} uploadImage={uploadImage} />
        {pick && (
          <Button
            size="sm"
            className="absolute z-10"
            style={{ top: pick.top, left: pick.left }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setCommenting({ quote: pick.quote, prefix: pick.prefix, suffix: pick.suffix });
              setPick(null);
            }}
          >
            评论
          </Button>
        )}
      </div>
      <AnchorCommentDialog documentId={doc.id} anchor={commenting} onClose={() => setCommenting(null)} />
```

`page.tsx`：import 区加 `import { DocumentComments } from './comments';`；在 `{d.source === 'native' ? <EditorPane … /> : <ExternalCard … />}` 之后加 `<DocumentComments org={org} doc={d} />`。

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @flower/web typecheck && pnpm --filter @flower/web lint --max-warnings 0 && pnpm --filter @flower/web exec vitest run src/features/documents`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e documents-revisions.spec.ts documents-editor.spec.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/documents "apps/web/src/app/(app)/[org]/documents/[key]" apps/web/e2e/documents-revisions.spec.ts
git commit -m "feat(web): PRD 修订记录（按小节对比、恢复）与评论（划词、整篇、回复、解决、已失效标记）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 13: 页面：转为 Flower 文档与导入（粘贴、Markdown、Word），图片转存为附件

**Files:**
- Modify: `apps/web/package.json`（`mammoth@1.13.0`；开发依赖 `docx@9.9.0`）
- Modify: `apps/web/src/features/documents/model.ts`、`model.test.ts`（`findDataImages`、`replaceImageSources`、`countRemoteImages`、`base64ToBytes`、`importSummary`、`IMPORT_LIMITS`）
- Create: `apps/web/src/features/documents/import.ts`（`htmlToMarkdown`、`docxToMarkdown`、`uploadDataImages`）
- Create: `apps/web/src/app/(app)/[org]/documents/import-dialog.tsx`
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`（整文件替换：导入对话框；`?import=1` 自动打开）
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`（自动保存前把粘贴进来的 `data:` 图片转存）
- Modify: `apps/web/src/app/(app)/[org]/documents/create-dialog.tsx`（第三个页签「导入」）
- Test: `apps/web/e2e/documents-import.spec.ts`

**Interfaces:**
- Consumes: Task 10 `apiUpload`、`documentKeys`；Task 11 `ExternalCard({ onConvert })`、`EditorPane`；`@flower/core/markdown` 的 `splitSections`
- Produces:
  - `model.ts`：`findDataImages(markdown: string): Array<{ src: string; mime: string; base64: string }>`（去重）；`replaceImageSources(markdown: string, map: Map<string, string>): string`；`countRemoteImages(markdown: string): number`；`base64ToBytes(b64: string): Uint8Array`；`importSummary(markdown: string): { chars: number; sections: number; images: number; remoteImages: number }`；`IMPORT_LIMITS = { markdownBytes: 2 MB, docxBytes: 20 MB }`
  - `import.ts`：`htmlToMarkdown(html: string): string`；`docxToMarkdown(file: Blob): Promise<string>`；`uploadDataImages(org: string, documentId: string, markdown: string, cache?: Map<string, string>): Promise<string>`
  - `import-dialog.tsx`：`ImportDialog({ org, doc, open, onOpenChange, onImported })`，对话框名：外部 PRD 为「转为 Flower 文档」，Flower 文档为「导入内容」；页签「粘贴」「Markdown 文件」「Word 文件」；粘贴区可访问名「粘贴区域」；文件输入框「选择 Markdown 文件」「选择 Word 文件」；预览区块「导入预览」；按钮「确认导入」
  - 新建对话框的「导入」页签：建一份空白 Flower 文档后跳到 `/{org}/documents/{key}?import=1`

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @flower/web add mammoth@1.13.0 && pnpm --filter @flower/web add -D docx@9.9.0`
Expected: `apps/web/package.json` 出现两项。

- [ ] **Step 2: 写失败的单元测试**

`apps/web/src/features/documents/model.test.ts`：第 2 行 import 加入 `base64ToBytes, countRemoteImages, findDataImages, importSummary, replaceImageSources`，文件末尾加：

```ts
describe('导入与图片', () => {
  const md = '## 背景\n\n![a](data:image/png;base64,iVBORw0K)\n\n![b](data:image/png;base64,iVBORw0K)\n\n![c](https://wdcdn.qpic.cn/x.png)\n\n![d](data:image/svg+xml;base64,PHN2Zz4=)\n\n## 需求\n\n- 分片';

  it('找出可上传的 data: 图片（去重，SVG 不算），统计外部图片', () => {
    expect(findDataImages(md)).toEqual([{ src: 'data:image/png;base64,iVBORw0K', mime: 'image/png', base64: 'iVBORw0K' }]);
    expect(countRemoteImages(md)).toBe(1);
    expect(importSummary(md)).toEqual({ chars: md.length, sections: 2, images: 1, remoteImages: 1 });
  });

  it('按映射替换图片网址，其余不变', () => {
    const out = replaceImageSources(md, new Map([['data:image/png;base64,iVBORw0K', '/api/v1/orgs/acme/attachments/1']]));
    expect(out.match(/\/api\/v1\/orgs\/acme\/attachments\/1/g)).toHaveLength(2);
    expect(out).toContain('![c](https://wdcdn.qpic.cn/x.png)');
  });

  it('base64 → 字节', () => {
    expect([...base64ToBytes('iVBORw==')]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: FAIL，`findDataImages` 未导出。

- [ ] **Step 3: 实现纯函数与转换**

`apps/web/src/features/documents/model.ts`：第一行 import 改为 `import { DOCUMENT_STATUSES, type DocumentStatus, type ExternalProvider, splitSections } from '@flower/core/markdown';`，末尾加：

```ts
export const IMPORT_LIMITS = { markdownBytes: 2 * 1024 * 1024, docxBytes: 20 * 1024 * 1024 } as const;

const DATA_IMAGE = /!\[[^\]]*\]\((data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+))\)/g;
const REMOTE_IMAGE = /!\[[^\]]*\]\(https?:\/\/[^)\s]+\)/g;

/** 正文里可以转存为附件的 data: 图片（PNG、JPEG、GIF、WebP），按内容去重。 */
export function findDataImages(markdown: string): Array<{ src: string; mime: string; base64: string }> {
  const out = new Map<string, { src: string; mime: string; base64: string }>();
  for (const m of markdown.matchAll(DATA_IMAGE)) if (!out.has(m[1]!)) out.set(m[1]!, { src: m[1]!, mime: m[2]!, base64: m[3]! });
  return [...out.values()];
}

export function replaceImageSources(markdown: string, map: Map<string, string>): string {
  return markdown.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (all, open: string, src: string, close: string) => (map.has(src) ? `${open}${map.get(src)}${close}` : all));
}

/** 指向外部网址的图片：不抓取（需要外部平台登录），保留原链接。 */
export const countRemoteImages = (markdown: string): number => [...markdown.matchAll(REMOTE_IMAGE)].length;

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function importSummary(markdown: string): { chars: number; sections: number; images: number; remoteImages: number } {
  return {
    chars: markdown.length,
    sections: splitSections(markdown).filter((s) => s.heading !== null).length,
    images: findDataImages(markdown).length,
    remoteImages: countRemoteImages(markdown),
  };
}
```

新建 `apps/web/src/features/documents/import.ts`：

```ts
import { BlockNoteEditor } from '@blocknote/core';
import { apiUpload } from '@/lib/api';
import type { Attachment } from '@/lib/types';
import { base64ToBytes, findDataImages, replaceImageSources } from './model';

let converter: BlockNoteEditor | null = null;

/** 不挂载的 BlockNote 实例，只用来做 HTML / Markdown 转换；粘贴、Word 导入与编辑器用同一套规则。 */
function editor(): BlockNoteEditor {
  converter ??= BlockNoteEditor.create();
  return converter;
}

export function htmlToMarkdown(html: string): string {
  const e = editor();
  return e.blocksToMarkdownLossy(e.tryParseHTMLToBlocks(html));
}

/** .docx → HTML（mammoth，图片内嵌为 data:）→ Markdown。mammoth 只在用到时加载。 */
export async function docxToMarkdown(file: Blob): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return htmlToMarkdown(value);
}

/**
 * 把正文里的 data: 图片逐个上传为这份 PRD 的附件并替换成附件网址。cache 记录已上传过的图片，
 * 编辑器自动保存时传同一个 cache，同一张图不会重复上传。
 */
export async function uploadDataImages(org: string, documentId: string, markdown: string, cache: Map<string, string> = new Map()): Promise<string> {
  for (const [i, img] of findDataImages(markdown).entries()) {
    if (cache.has(img.src)) continue;
    const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime.slice('image/'.length);
    const blob = new Blob([base64ToBytes(img.base64)], { type: img.mime });
    const res = await apiUpload<{ attachment: Attachment }>(`/orgs/${org}/documents/${documentId}/attachments`, blob, `image-${i + 1}.${ext}`);
    cache.set(img.src, res.attachment.url);
  }
  return replaceImageSources(markdown, cache);
}
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: PASS。

- [ ] **Step 4: 写失败的端到端测试**

新建 `apps/web/e2e/documents-import.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph } from 'docx';
import { resetDatabase } from './db';
import { createDocument, createProduct, login, OWNER, PNG_1PX_BASE64 as PNG_B64, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('外部 PRD 上传 Markdown 转为 Flower 文档，原链接保留', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '飞书方案', externalUrl: 'https://abc.feishu.cn/docx/1' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('region', { name: '外部文档' }).getByRole('button', { name: '转为 Flower 文档' }).click();
  const dialog = page.getByRole('dialog', { name: '转为 Flower 文档' });
  await dialog.getByRole('tab', { name: 'Markdown 文件' }).click();
  await dialog.getByLabel('选择 Markdown 文件').setInputFiles({ name: 'prd.md', mimeType: 'text/markdown', buffer: Buffer.from('## 背景\n\n从 Markdown 导入\n\n## 需求\n\n- 分片上传') });
  await expect(dialog.getByRole('region', { name: '导入预览' })).toContainText('2 个小节');
  await dialog.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('从 Markdown 导入');
  await expect(page.getByRole('region', { name: '外部文档' })).toHaveCount(0);
  await expect(page.getByRole('complementary')).toContainText('原链接');
  await expect(page.getByRole('complementary').getByRole('region', { name: '修订记录' })).toContainText('由外部文档转换');
});

test('新建时选「导入」，上传 Word：标题、正文与图片都进入 Flower 文档，图片转存为附件', async ({ page, request }) => {
  await createProduct(request);
  const buffer = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: '背景', heading: HeadingLevel.HEADING_2 }),
            new Paragraph('从 Word 导入的正文'),
            new Paragraph({ children: [new ImageRun({ type: 'png', data: Buffer.from(PNG_B64, 'base64'), transformation: { width: 10, height: 10 } })] }),
          ],
        },
      ],
    }),
  );
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/documents');
  await page.getByRole('button', { name: '新建 PRD' }).click();
  const create = page.getByRole('dialog', { name: '新建 PRD' });
  await create.getByRole('tab', { name: '导入' }).click();
  await create.getByLabel('标题').fill('Word 导入');
  await create.getByRole('button', { name: '创建' }).click();
  await page.waitForURL(/\/acme\/documents\/PAN-PRD-1\?import=1$/);

  const dialog = page.getByRole('dialog', { name: '导入内容' });
  await dialog.getByRole('tab', { name: 'Word 文件' }).click();
  await dialog.getByLabel('选择 Word 文件').setInputFiles({ name: 'prd.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
  await expect(dialog.getByRole('region', { name: '导入预览' })).toContainText('1 张图片将上传为附件');
  const uploaded = page.waitForResponse((r) => r.url().includes('/attachments') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: '确认导入' }).click();
  expect((await uploaded).status()).toBe(201);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('从 Word 导入的正文');
  await expect(body.locator('img[src*="/attachments/"]')).toHaveCount(1);
  await expect(page).not.toHaveURL(/import=1/);
});

test('粘贴：保留标题与表格，内嵌图片上传，外部图片保留链接', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '粘贴方案', externalUrl: 'https://doc.weixin.qq.com/doc/w3_P' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('button', { name: '转为 Flower 文档' }).click();
  const dialog = page.getByRole('dialog', { name: '转为 Flower 文档' });
  const html = `<h2>背景</h2><p>从网页粘贴的内容</p><table><tr><th>字段</th><th>说明</th></tr><tr><td>大小</td><td>上限 10 GB</td></tr></table><p><img src="data:image/png;base64,${PNG_B64}"></p><p><img src="https://wdcdn.qpic.cn/x.png"></p>`;
  await dialog.getByRole('textbox', { name: '粘贴区域' }).evaluate((el, content) => {
    const dt = new DataTransfer();
    dt.setData('text/html', content);
    dt.setData('text/plain', '从网页粘贴的内容');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, html);
  const preview = dialog.getByRole('region', { name: '导入预览' });
  await expect(preview).toContainText('1 张图片将上传为附件');
  await expect(preview).toContainText('1 张外部图片保留原链接');
  await dialog.getByRole('button', { name: '确认导入' }).click();
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('从网页粘贴的内容');
  await expect(body).toContainText('上限 10 GB');
  await expect(body.locator('img[src*="/attachments/"]')).toHaveCount(1);
});
```

Run: `pnpm --filter @flower/web e2e documents-import.spec.ts`
Expected: FAIL，没有「转为 Flower 文档」按钮。

- [ ] **Step 5: 导入对话框**

新建 `apps/web/src/app/(app)/[org]/documents/import-dialog.tsx`：

```tsx
'use client';

import { type ClipboardEvent, useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { docxToMarkdown, htmlToMarkdown, uploadDataImages } from '@/features/documents/import';
import { IMPORT_LIMITS, importSummary } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation } from '@/lib/queries';
import type { DocumentDetail } from '@/lib/types';

type Source = 'paste' | 'markdown' | 'docx';
type Target = Pick<DocumentDetail, 'id' | 'version' | 'source'>;

function ImportForm({ org, doc, onDone, onCancel }: { org: string; doc: Target; onDone: () => void; onCancel: () => void }) {
  const [source, setSource] = useState<Source>('paste');
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const commit = useApiMutation(
    async () => {
      const md = await uploadDataImages(org, doc.id, markdown ?? '');
      return doc.source === 'external'
        ? api(`/orgs/${org}/documents/${doc.id}/convert`, { method: 'POST', body: { baseVersion: doc.version, markdown: md } })
        : api(`/orgs/${org}/documents/${doc.id}/content`, { method: 'PUT', body: { baseVersion: doc.version, markdown: md } });
    },
    { silentError: true, invalidate: [documentKeys(org)], success: doc.source === 'external' ? '已转为 Flower 文档' : '已导入', onSuccess: onDone },
  );

  const readFile = async (file: File, kind: 'markdown' | 'docx') => {
    setReadError(null);
    setMarkdown(null);
    if (file.size > (kind === 'markdown' ? IMPORT_LIMITS.markdownBytes : IMPORT_LIMITS.docxBytes)) {
      setReadError(kind === 'markdown' ? 'Markdown 文件不能超过 2 MB' : 'Word 文件不能超过 20 MB');
      return;
    }
    setReading(true);
    try {
      setMarkdown(kind === 'markdown' ? await file.text() : await docxToMarkdown(file));
    } catch {
      setReadError('文件无法解析，请确认是有效的 .md 或 .docx 文件');
    } finally {
      setReading(false);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    setReadError(null);
    setMarkdown(html ? htmlToMarkdown(html) : e.clipboardData.getData('text/plain'));
  };

  const summary = markdown === null ? null : importSummary(markdown);
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        value={source}
        onValueChange={(v) => {
          setSource(v as Source);
          setMarkdown(null);
          setReadError(null);
        }}
      >
        <TabsList>
          <TabsTrigger value="paste">粘贴</TabsTrigger>
          <TabsTrigger value="markdown">Markdown 文件</TabsTrigger>
          <TabsTrigger value="docx">Word 文件</TabsTrigger>
        </TabsList>
      </Tabs>
      {source === 'paste' && (
        <div
          role="textbox"
          aria-label="粘贴区域"
          tabIndex={0}
          contentEditable
          suppressContentEditableWarning
          onPaste={onPaste}
          className="min-h-28 rounded-md border p-3 text-[13px] text-muted-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          在这里粘贴（Ctrl / ⌘ + V）从企业微信、飞书等文档复制的内容，标题、列表、表格与图片会保留。
        </div>
      )}
      {source === 'markdown' && (
        <Input
          type="file"
          aria-label="选择 Markdown 文件"
          accept=".md,.markdown,text/markdown,text/plain"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f, 'markdown');
          }}
        />
      )}
      {source === 'docx' && (
        <Input
          type="file"
          aria-label="选择 Word 文件"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f, 'docx');
          }}
        />
      )}
      {reading && <p className="text-[13px] text-muted-foreground">正在解析…</p>}
      {readError && (
        <p role="alert" className="text-[13px] text-destructive">
          {readError}
        </p>
      )}
      {summary && markdown !== null && (
        <section aria-label="导入预览" className="flex flex-col gap-2">
          <p className="text-[13px]">
            {summary.chars} 字符 · {summary.sections} 个小节 · {summary.images} 张图片将上传为附件
            {summary.remoteImages > 0 && ` · ${summary.remoteImages} 张外部图片保留原链接（不转存）`}
          </p>
          <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 font-mono text-[12px] whitespace-pre-wrap">{markdown.slice(0, 3000)}</pre>
        </section>
      )}
      {doc.source === 'native' && <p className="text-[13px] text-muted-foreground">导入会替换当前正文，旧内容保留在修订记录里。</p>}
      <FormError error={commit.error} />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button disabled={!markdown?.trim() || commit.isPending} onClick={() => commit.mutate(undefined)}>
          确认导入
        </Button>
      </DialogFooter>
    </div>
  );
}

/** 外部 PRD 转为 Flower 文档，或给 Flower 文档导入内容：粘贴、上传 Markdown、上传 Word。 */
export function ImportDialog({
  org,
  doc,
  open,
  onOpenChange,
  onImported,
}: {
  org: string;
  doc: Target;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{doc.source === 'external' ? '转为 Flower 文档' : '导入内容'}</DialogTitle>
        </DialogHeader>
        {open && <ImportForm org={org} doc={doc} onDone={onImported} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
```

把 `apps/web/src/app/(app)/[org]/documents/[key]/page.tsx` 整个替换为：

```tsx
'use client';

import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { documentKeys, useApiMutation, useDocument } from '@/lib/queries';
import { ImportDialog } from '../import-dialog';
import { DocumentComments } from './comments';
import { EditorPane } from './editor-pane';
import { ExternalCard } from './external-card';
import { SidePanel } from './side-panel';

function DocumentPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const q = useDocument(org, decodeURIComponent(key));
  const d = q.data;
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const [converting, setConverting] = useState(false);
  // 正文被外部替换（冲突后重新加载、恢复版本、导入）时加一，让编辑器按最新正文重新挂载
  const [epoch, setEpoch] = useState(0);
  const reload = async () => {
    await q.refetch();
    setEpoch((e) => e + 1);
  };
  const patch = useApiMutation((body: { title: string }) => api(`/orgs/${org}/documents/${d!.id}`, { method: 'PATCH', body }), {
    invalidate: [documentKeys(org)],
    success: '已保存',
    onSuccess: () => setEditingTitle(false),
  });

  if (!d && q.isError) {
    return <QueryError error={q.error} noAccessMessage="PRD 不存在，或你没有查看它所在产品的权限。" retryMessage="加载 PRD 失败，请重试。" onRetry={() => q.refetch()} />;
  }
  if (!d) return <Skeleton className="h-64" />;
  const canEdit = d.myRole !== 'viewer';
  // 新建对话框选「导入」后带着 ?import=1 跳过来
  const importOpen = canEdit && (converting || searchParams.get('import') === '1');
  const closeImport = () => {
    setConverting(false);
    if (searchParams.get('import')) router.replace(pathname);
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: '文档', href: `/${org}/documents?product=${d.productKey}` }, { label: d.displayKey }]}
        title={
          editingTitle ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                patch.mutate({ title });
              }}
            >
              <Input aria-label="标题" className="h-9 text-xl font-semibold" value={title} autoFocus maxLength={200} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditingTitle(false)} />
            </form>
          ) : (
            <button
              type="button"
              disabled={!canEdit}
              className="text-left disabled:cursor-default"
              onClick={() => {
                setTitle(d.title);
                setEditingTitle(true);
              }}
            >
              <span className="mr-2 font-mono text-base text-muted-foreground">{d.displayKey}</span>
              {d.title}
            </button>
          )
        }
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          {d.source === 'native' ? (
            <EditorPane key={`${d.id}:${epoch}`} org={org} doc={d} onReload={() => void reload()} />
          ) : (
            <ExternalCard org={org} doc={d} onConvert={() => setConverting(true)} />
          )}
          <DocumentComments org={org} doc={d} />
        </div>
        <SidePanel org={org} doc={d} onReload={() => void reload()} />
      </div>
      <ImportDialog
        org={org}
        doc={d}
        open={importOpen}
        onOpenChange={(o) => !o && closeImport()}
        onImported={() => {
          closeImport();
          void reload();
        }}
      />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <DocumentPage />
    </Suspense>
  );
}
```

- [ ] **Step 6: 自动保存转存粘贴的图片；新建对话框的「导入」页签**

`editor-pane.tsx`：

1. import 区加 `import { uploadDataImages } from '@/features/documents/import';`
2. `const blocked = useRef(false);` 之后加 `const uploaded = useRef(new Map<string, string>());`
3. `save` 的 mutationFn 改为：

```tsx
  const save = useApiMutation(
    async (markdown: string) => {
      // 粘贴进来的内嵌图片先转存为附件（同一张图只传一次），正文里只存附件网址
      const md = await uploadDataImages(org, doc.id, markdown, uploaded.current);
      return api<{ version: number }>(`/orgs/${org}/documents/${doc.id}/content`, { method: 'PUT', body: { baseVersion: version.current, markdown: md } });
    },
    { silentError: true, invalidate: [documentKeys(org)] },
  );
```

`create-dialog.tsx`：

1. `type Mode = 'native' | 'external';` 改为 `type Mode = 'native' | 'external' | 'import';`
2. `create` 的请求体改为：

```tsx
        body: {
          title,
          requirementIds,
          ...(mode === 'external' ? { externalUrl: url } : mode === 'import' ? {} : { templateId: chosen === BLANK ? null : chosen }),
        },
```

3. `onSuccess: (d) => router.push(documentHref(org, d.document.displayKey)),` 改为 `onSuccess: (d) => router.push(\`${documentHref(org, d.document.displayKey)}${mode === 'import' ? '?import=1' : ''}\`),`
4. `<TabsTrigger value="external">外部链接</TabsTrigger>` 之后加 `<TabsTrigger value="import">导入</TabsTrigger>`
5. `{mode === 'native' ? (…) : (…)}` 整段改为三分支：`mode === 'native'` 显示模板下拉；`mode === 'external'` 显示网址输入（原样）；`mode === 'import'` 显示：

```tsx
        <p className="text-[13px] text-muted-foreground">先建一份空白 Flower 文档，下一步粘贴内容或上传 Markdown、Word 文件。</p>
```

- [ ] **Step 7: 运行测试**

Run: `pnpm --filter @flower/web typecheck && pnpm --filter @flower/web lint --max-warnings 0 && pnpm --filter @flower/web exec vitest run`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e documents-import.spec.ts documents-editor.spec.ts documents.spec.ts`
Expected: PASS。如果 BlockNote 0.55 的 `tryParseHTMLToBlocks` 丢掉了表格，在任务报告里写明实际保留的结构，并把第 3 个用例对表格的断言改为对实际保留的结构断言（不要为了通过而删除标题、正文和图片的断言）。

- [ ] **Step 8: 提交**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/features/documents "apps/web/src/app/(app)/[org]/documents" apps/web/e2e/documents-import.spec.ts
git commit -m "feat(web): 外部 PRD 转为 Flower 文档与导入（粘贴、Markdown、Word），内嵌图片转存为附件

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: 页面：文档模板设置（组织级与产品覆盖）、需求详情挂 PRD、PRD 评审表、工作台签字链接；权限矩阵端到端

**Files:**
- Modify: `apps/web/src/features/documents/model.ts`、`model.test.ts`（`sectionsFromBody`）
- Modify: `apps/web/src/features/workbench/model.ts`、`model.test.ts`（`signatureHref`）
- Modify: `apps/web/src/features/shell/nav.ts`、`nav.test.ts`（设置分组加「文档模板」）
- Create: `apps/web/src/components/template-editor.tsx`
- Create: `apps/web/src/app/(app)/[org]/settings/templates/page.tsx`
- Modify: `apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`（「文档模板」页签）
- Create: `apps/web/src/app/(app)/[org]/requirements/[key]/prd-card.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`（PRD 卡片、PRD 检查项）
- Create: `apps/web/src/app/(app)/[org]/reviews/document-reviews.tsx`
- Modify: `apps/web/src/app/(app)/[org]/reviews/page.tsx`（PRD 评审表）
- Modify: `apps/web/src/app/(app)/[org]/page.tsx`（签字链接）
- Test: `apps/web/e2e/documents-prd-flow.spec.ts`、`apps/web/e2e/documents-permissions.spec.ts`

**Interfaces:**
- Consumes: Task 8 `RequirementDetail.changeDocument`、`documentCheckItems`、`WorkbenchSignature.documentId`；Task 9 模板与评审表接口；Task 10 `CreateDocumentDialog`、`useTemplates`、`useDocumentReviews`、`templateKeys`、`DocumentStatusBadge`、`documentHref`；Task 11 `CheckItems`
- Produces:
  - `model.ts`：`sectionsFromBody(body: string): TemplateSection[]`（正文里的二级标题，均为选填）
  - `workbench/model.ts`：`signatureHref(s: Workbench['signatures']['items'][number]): string`
  - `components/template-editor.tsx`：`TemplateEditor({ org, productId })`（`productId` 为 null 时管理组织模板）；表格列：名称、必填小节、启用；对话框「新建模板」/「编辑模板」，字段「模板名称」「模板正文」，按钮「从正文提取小节」「添加小节」「保存模板」，小节行的输入框「小节 N 标题」「小节 N 说明」、勾选框「小节 N 必填」
  - 设置页 `/[org]/settings/templates`；产品设置页签「文档模板」
  - `prd-card.tsx`：`PrdCard({ org, requirement })`，区块名「PRD」；按钮「新建 PRD」「关联已有 PRD」「移出 PRD」；输入框「PRD 编号」
  - `document-reviews.tsx`：`DocumentReviews({ org, productId })`，区块名「PRD 评审」

- [ ] **Step 1: 写失败的单元测试**

`apps/web/src/features/documents/model.test.ts`：import 加入 `sectionsFromBody`，末尾加：

```ts
describe('模板', () => {
  it('从正文提取二级标题作为小节，默认选填', () => {
    expect(sectionsFromBody('# 标题\n\n## 1. 背景\n\n### 1.1 细节\n\n## 2. 方案\n')).toEqual([
      { heading: '1. 背景', required: false },
      { heading: '2. 方案', required: false },
    ]);
  });
});
```

`apps/web/src/features/workbench/model.test.ts`：import 加入 `signatureHref`，`describe('工作台链接', …)` 里加：

```ts
  it('签字行：需求链接到需求详情，PRD 链接到 PRD 详情', () => {
    const s = { org, itemKey: 'k', itemLabel: '评审', ruleIndex: 0, onBehalfOf: null, title: 't' };
    expect(signatureHref({ ...s, requirementId: 'r1', documentId: null, displayKey: 'PAN-1' })).toBe('/acme/requirements/PAN-1');
    expect(signatureHref({ ...s, requirementId: null, documentId: 'd1', displayKey: 'PAN-PRD-1' })).toBe('/acme/documents/PAN-PRD-1');
  });
```

`apps/web/src/features/shell/nav.test.ts`：设置分组的期望列表里，在 `'/acme/settings/fields',` 之后加 `'/acme/settings/templates',`；`activeNavKey` 用例加 `expect(activeNavKey('/acme/settings/templates', 'acme')).toBe('templates');`。

Run: `pnpm --filter @flower/web exec vitest run src/features`
Expected: FAIL（`sectionsFromBody`、`signatureHref` 未导出，导航缺「文档模板」）。

- [ ] **Step 2: 实现**

`apps/web/src/features/documents/model.ts`：import 类型加 `type TemplateSection`（`@flower/core/markdown` 已重新导出），末尾加：

```ts
/** 模板编辑时「从正文提取小节」：正文里的二级标题，默认选填。 */
export function sectionsFromBody(body: string): TemplateSection[] {
  return splitSections(body)
    .filter((s) => s.level === 2 && s.heading)
    .map((s) => ({ heading: s.heading!, required: false }));
}
```

`apps/web/src/features/workbench/model.ts` 末尾加：

```ts
/** 等我签字：需求上的签字去需求详情，PRD 上的签字去 PRD 详情。 */
export function signatureHref(s: Workbench['signatures']['items'][number]): string {
  return s.documentId ? `/${s.org.slug}/documents/${s.displayKey}` : requirementHref(s.org, s.displayKey);
}
```

`apps/web/src/features/shell/nav.ts`：`SETTINGS` 数组里 `['fields', '字段字典', 'sliders'],` 之后加 `['templates', '文档模板', 'doc'],`。

`apps/web/src/app/(app)/[org]/page.tsx`：import 改为 `import { requirementHref, showOrgBadge, signatureHref, taskHref } from '@/features/workbench/model';`；签字列表里 `<Link href={requirementHref(s.org, s.displayKey)} className={ROW}>` 改为 `<Link href={signatureHref(s)} className={ROW}>`。

Run: `pnpm --filter @flower/web exec vitest run src/features`
Expected: PASS。

- [ ] **Step 3: 写失败的端到端测试**

新建 `apps/web/e2e/documents-prd-flow.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyPrdWorkflow, createProduct, createRequirement, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求挂 PRD：从需求新建 PRD；PRD 状态带动「PRD」检查项；PRD 评审签字后需求可以进入开发中', async ({ page, request }) => {
  const productId = await createProduct(request);
  await applyPrdWorkflow(request, productId);
  await createRequirement(request, productId, '分片上传');
  await login(page, OWNER.email, OWNER.password);

  await page.goto('/acme/requirements/PAN-1');
  const card = page.getByRole('region', { name: 'PRD', exact: true });
  await expect(card).toContainText('还没有挂 PRD');
  await card.getByRole('button', { name: '新建 PRD' }).click();
  const dialog = page.getByRole('dialog', { name: '新建 PRD' });
  await expect(dialog.getByLabel('标题')).toHaveValue('分片上传');
  await dialog.getByRole('tab', { name: '外部链接' }).click();
  await dialog.getByLabel('文档网址').fill('https://doc.weixin.qq.com/doc/w3_UP');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-1');
  const side = page.getByRole('complementary');
  await expect(side.getByRole('region', { name: '覆盖的需求' })).toContainText('PAN-1');
  await side.getByRole('button', { name: '改为评审中' }).click();
  await expect(side.getByRole('region', { name: '状态' })).toContainText('评审中');

  await page.goto('/acme');
  const sign = page.getByRole('region', { name: /等我签字/ });
  await expect(sign.getByRole('link', { name: /PAN-PRD-1/ })).toHaveAttribute('href', '/acme/documents/PAN-PRD-1');
  await page.goto('/acme/reviews');
  await expect(page.getByRole('region', { name: 'PRD 评审' }).getByRole('row', { name: /PAN-PRD-1/ })).toContainText('待我签');

  await page.goto('/acme/requirements/PAN-1');
  const checks = page.getByRole('region', { name: '检查项', exact: true });
  await expect(checks.getByRole('listitem', { name: 'PRD', exact: true })).toContainText('进行中');
  await expect(checks.getByRole('listitem', { name: 'PRD', exact: true })).toContainText('跟随 PRD');
  await expect(checks.getByRole('combobox', { name: 'PRD状态' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: '可流转到' }).getByRole('button', { name: '开发中' })).toBeDisabled();

  await page.goto('/acme/documents/PAN-PRD-1');
  await page.getByRole('complementary').getByRole('listitem', { name: 'PRD 评审' }).getByRole('button', { name: '通过' }).click();
  await expect(page.getByText('已签字')).toBeVisible();
  await page.getByRole('complementary').getByRole('button', { name: '改为已通过' }).click();
  await expect(page.getByRole('complementary').getByRole('region', { name: '状态' })).toContainText('已通过');

  await page.goto('/acme/requirements/PAN-1');
  await expect(page.getByRole('region', { name: '检查项', exact: true }).getByRole('listitem', { name: 'PRD', exact: true })).toContainText('通过');
  await expect(page.getByRole('region', { name: 'PRD 检查项' }).getByRole('listitem', { name: 'PRD 评审' })).toContainText('通过');
  await page.getByRole('list', { name: '可流转到' }).getByRole('button', { name: '开发中' }).click();
  await expect(page.getByTestId('current-state')).toHaveText('开发中');
});
```

新建 `apps/web/e2e/documents-permissions.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createProduct, json, login, ok, OWNER, PNG_1PX_BASE64, presetTemplateId, readToken, setupInstance } from './helpers';

const PNG = Buffer.from(PNG_1PX_BASE64, 'base64');

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('只读成员：能看、能评论，不能改正文、状态、覆盖需求、恢复版本、转换外部 PRD', async ({ browser, request }) => {
  const productId = await createProduct(request);
  const native = await createDocument(request, productId, { title: '原生', templateId: await presetTemplateId(request, productId) });
  await ok(request.put(`/api/v1/orgs/acme/documents/${native.id}/content`, { data: { baseVersion: 1, markdown: '## 背景\n\n第一稿' } }));
  const external = await createDocument(request, productId, { title: '外部', externalUrl: 'https://docs.qq.com/doc/ro' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));

  await page.goto(`/acme/documents/${native.displayKey}`);
  const side = page.getByRole('complementary');
  await expect(side.getByRole('region', { name: '修订记录' })).toContainText('第 1 版');
  await expect(side.getByRole('button', { name: /^改为/ })).toHaveCount(0);
  await expect(side.getByRole('button', { name: '关联' })).toHaveCount(0);
  await expect(side.getByRole('button', { name: /^恢复第/ })).toHaveCount(0);
  const comments = page.getByRole('region', { name: '评论' });
  await comments.getByLabel('发表评论').fill('只读成员也能提意见');
  await comments.getByRole('button', { name: '发表' }).click();
  await expect(comments).toContainText('只读成员也能提意见');

  await page.goto(`/acme/documents/${external.displayKey}`);
  await expect(page.getByRole('region', { name: '外部文档' })).toContainText('腾讯文档');
  await expect(page.getByRole('button', { name: '转为 Flower 文档' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '修改链接' })).toHaveCount(0);
  await ctx.close();
});

test('只读 Token：能读 PRD、修订与评论；不能新建、保存、改状态、评论、上传', async ({ request, playwright }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '接口', templateId: await presetTemplateId(request, productId) });
  const token = await readToken(request);
  const api = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  expect((await api.get(`/api/v1/orgs/acme/documents/${doc.displayKey}`)).status()).toBe(200);
  expect((await api.get(`/api/v1/orgs/acme/documents/${doc.id}/revisions`)).status()).toBe(200);
  expect((await api.get(`/api/v1/orgs/acme/documents/${doc.id}/comments`)).status()).toBe(200);
  expect((await api.post(`/api/v1/orgs/acme/products/${productId}/documents`, { data: { title: 'x' } })).status()).toBe(403);
  expect((await api.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: 1, markdown: 'x' } })).status()).toBe(403);
  expect((await api.post(`/api/v1/orgs/acme/documents/${doc.id}/transitions`, { data: { to: 'review' } })).status()).toBe(403);
  expect((await api.post(`/api/v1/orgs/acme/documents/${doc.id}/comments`, { data: { body: 'x' } })).status()).toBe(403);
  expect((await api.post(`/api/v1/orgs/acme/documents/${doc.id}/attachments`, { multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: PNG } } })).status()).toBe(403);
  await api.dispose();
});

test('文档模板：组织管理员维护模板与必填小节，提交评审时检查；普通成员进不了设置页；产品管理员在产品设置里覆盖', async ({ page, browser, request }) => {
  const productId = await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '文档模板' }).click();
  await expect(page.getByRole('row', { name: /变更 PRD（预置）/ })).toContainText('1. 背景介绍、3. 需求说明');

  await page.getByRole('button', { name: '新建模板' }).click();
  const dialog = page.getByRole('dialog', { name: '新建模板' });
  await dialog.getByLabel('模板名称').fill('轻量 PRD');
  await dialog.getByLabel('模板正文').fill('## 背景\n\n待填\n\n## 方案\n\n待填\n');
  await dialog.getByRole('button', { name: '从正文提取小节' }).click();
  await expect(dialog.getByLabel('小节 2 标题')).toHaveValue('方案');
  await dialog.getByRole('checkbox', { name: '小节 1 必填' }).click();
  await dialog.getByRole('button', { name: '保存模板' }).click();
  await expect(page.getByRole('row', { name: /轻量 PRD/ })).toContainText('背景');

  const templates = (await json<{ templates: Array<{ id: string; name: string }> }>(request.get(`/api/v1/orgs/acme/templates?product=${productId}&usable=1`))).templates;
  const doc = await createDocument(request, productId, { title: '缺小节', templateId: templates.find((t) => t.name === '轻量 PRD')!.id });
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('complementary').getByRole('button', { name: '改为评审中' }).click();
  await expect(page.getByRole('complementary').getByRole('alert')).toContainText('以下必填小节未填写：背景');

  const ctx = await browser.newContext();
  const member = await ctx.newPage();
  const memberId = await acceptInvite(member, request, { email: 'pm@example.com', orgRole: 'member', name: '产品管理员乙' });
  await member.goto('/acme/settings/templates');
  await expect(member.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${memberId}`, { data: { role: 'admin' } }));
  await member.goto(`/acme/settings/products/${productId}`);
  await member.getByRole('tab', { name: '文档模板' }).click();
  await member.getByRole('button', { name: '新建模板' }).click();
  const productDialog = member.getByRole('dialog', { name: '新建模板' });
  await productDialog.getByLabel('模板名称').fill('轻量 PRD');
  await productDialog.getByLabel('模板正文').fill('## 背景\n\n产品版\n');
  await productDialog.getByRole('button', { name: '保存模板' }).click();
  await expect(member.getByRole('tabpanel').getByRole('row', { name: /轻量 PRD/ })).toBeVisible();
  await ctx.close();
});
```

Run: `pnpm --filter @flower/web e2e documents-prd-flow.spec.ts documents-permissions.spec.ts`
Expected: FAIL（需求详情没有 PRD 卡片、没有模板设置页）。

- [ ] **Step 4: 模板设置**

新建 `apps/web/src/components/template-editor.tsx`：

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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { sectionsFromBody } from '@/features/documents/model';
import { api } from '@/lib/api';
import { templateKeys, useApiMutation, useTemplates } from '@/lib/queries';
import type { DocumentTemplate, TemplateSection } from '@/lib/types';

function TemplateDialog({ org, productId, template, onClose }: { org: string; productId: string | null; template: DocumentTemplate | null; onClose: () => void }) {
  const [name, setName] = useState(template?.name ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [sections, setSections] = useState<TemplateSection[]>(template?.sections ?? []);
  const save = useApiMutation(
    () =>
      template
        ? api(`/orgs/${org}/templates/${template.id}`, { method: 'PATCH', body: { name, body, sections } })
        : api(`/orgs/${org}/templates`, { method: 'POST', body: { productId, name, body, sections } }),
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
          <p className="text-xs text-muted-foreground">提交评审时检查必填小节：标题存在，且内容不只是模板原文。</p>
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

/** 文档模板列表与编辑。productId 为 null 时是组织模板（组织管理员），否则是该产品的覆盖模板（产品管理员）。 */
export function TemplateEditor({ org, productId }: { org: string; productId: string | null }) {
  const list = useTemplates(org, productId ? { productId } : {});
  const [editing, setEditing] = useState<DocumentTemplate | 'new' | null>(null);
  const invalidate = [templateKeys(org)];
  const preset = useApiMutation(() => api(`/orgs/${org}/templates/preset`, { method: 'POST' }), { invalidate, success: '已添加预置模板' });
  const toggle = useApiMutation((t: DocumentTemplate) => api(`/orgs/${org}/templates/${t.id}`, { method: 'PATCH', body: { active: !t.active } }), { invalidate });
  if (list.isError) return <QueryError error={list.error} noAccessMessage="没有查看模板的权限。" retryMessage="加载模板失败，请重试。" onRetry={() => list.refetch()} />;
  if (!list.data) return <Skeleton className="h-32" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">
          {productId ? '只用于本产品。与组织模板同名时，新建 PRD 用本产品的版本。' : '组织内所有产品可用；产品管理员可以在产品设置里用同名模板覆盖。'}
        </p>
        <div className="flex gap-2">
          {!productId && list.data.length === 0 && (
            <Button variant="outline" disabled={preset.isPending} onClick={() => preset.mutate(undefined)}>
              添加预置模板
            </Button>
          )}
          <Button onClick={() => setEditing('new')}>新建模板</Button>
        </div>
      </div>
      {list.data.length === 0 ? (
        <EmptyState icon={FileText} title="还没有模板" description={productId ? '没有覆盖时使用组织模板。' : '可以先添加与旧 PRD 一致的预置模板。'} />
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
                  <TableCell className="truncate text-[13px] text-muted-foreground">
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
      {editing && <TemplateDialog key={editing === 'new' ? 'new' : editing.id} org={org} productId={productId} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
```

新建 `apps/web/src/app/(app)/[org]/settings/templates/page.tsx`：

```tsx
'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { TemplateEditor } from '@/components/template-editor';

export default function TemplatesPage() {
  const { org } = useParams<{ org: string }>();
  return (
    <RequireOrgAdmin>
      <PageHeader crumbs={[{ label: '组织设置' }, { label: '文档模板' }]} title="文档模板" description="新建 PRD 时套用；提交评审时检查必填小节。" />
      <TemplateEditor org={org} productId={null} />
    </RequireOrgAdmin>
  );
}
```

`apps/web/src/app/(app)/[org]/settings/products/[productId]/page.tsx`：import 区加 `import { TemplateEditor } from '@/components/template-editor';`；`<TabsTrigger value="structure">结构树</TabsTrigger>` 之后加 `<TabsTrigger value="templates">文档模板</TabsTrigger>`；`<TabsContent value="structure">…</TabsContent>` 之后加：

```tsx
        <TabsContent value="templates">
          <TemplateEditor org={org} productId={productId} />
        </TabsContent>
```

- [ ] **Step 5: 需求详情挂 PRD、PRD 评审表**

新建 `apps/web/src/app/(app)/[org]/requirements/[key]/prd-card.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DocumentStatusBadge } from '@/components/document-status';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { documentHref } from '@/features/documents/model';
import { api } from '@/lib/api';
import { documentKeys, qk, requirementKeys, useApiMutation } from '@/lib/queries';
import type { RequirementDetail } from '@/lib/types';
import { CreateDocumentDialog } from '../../documents/create-dialog';

/** 需求所挂的 PRD：标题、状态、来源；没挂时可以新建或关联已有 PRD。 */
export function PrdCard({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  const canEdit = r.myRole !== 'viewer';
  const doc = r.changeDocument;
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [key, setKey] = useState('');
  const invalidate = [requirementKeys(org), documentKeys(org), qk.workbench];
  const unlink = useApiMutation(() => api(`/orgs/${org}/documents/${doc!.id}/requirements/${r.id}`, { method: 'DELETE' }), { invalidate, success: '已移出 PRD' });
  const link = useApiMutation(
    async (k: string) => {
      const found = await api<{ document: { id: string } }>(`/orgs/${org}/documents/${encodeURIComponent(k.trim().toUpperCase())}`);
      return api(`/orgs/${org}/documents/${found.document.id}/requirements`, { method: 'POST', body: { requirementIds: [r.id] } });
    },
    {
      silentError: true,
      invalidate,
      success: '已关联 PRD',
      onSuccess: () => {
        setLinking(false);
        setKey('');
      },
    },
  );
  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="req-prd-title">
      <h2 id="req-prd-title" className="mb-2 text-sm font-semibold">
        PRD
      </h2>
      {doc ? (
        <div className="flex flex-col gap-2">
          <Link href={documentHref(org, doc.displayKey)} className="text-[13px] hover:underline">
            <span className="mr-2 font-mono text-muted-foreground">{doc.displayKey}</span>
            {doc.title}
          </Link>
          <div className="flex items-center gap-3">
            <DocumentStatusBadge status={doc.status} />
            <span className="text-[12px] text-muted-foreground">{doc.source === 'native' ? 'Flower 文档' : '外部链接'}</span>
          </div>
          {canEdit && (
            <Button size="sm" variant="ghost" className="self-start" disabled={unlink.isPending} onClick={() => unlink.mutate(undefined)}>
              移出 PRD
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-muted-foreground">还没有挂 PRD</p>
          {canEdit &&
            (linking ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  link.mutate(key);
                }}
              >
                <Input aria-label="PRD 编号" placeholder={`${r.productKey}-PRD-1`} className="h-8" value={key} onChange={(e) => setKey(e.target.value)} />
                <FormError error={link.error} />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={link.isPending || !key.trim()}>
                    关联
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setLinking(false)}>
                    取消
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setCreating(true)}>
                  新建 PRD
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    link.reset();
                    setLinking(true);
                  }}
                >
                  关联已有 PRD
                </Button>
              </div>
            ))}
          <CreateDocumentDialog org={org} productId={r.productId} open={creating} onOpenChange={setCreating} initialTitle={r.title} requirementIds={[r.id]} />
        </div>
      )}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：

1. import 区加 `import { PrdCard } from './prd-card';`；`import { qk, requirementKeys, useApiMutation, useRequirement } from '@/lib/queries';` 改为 `import { documentKeys, qk, requirementKeys, useApiMutation, useRequirement } from '@/lib/queries';`
2. 主列 `<CheckItems items={r.checkItems} … />` 之后加：

```tsx
          {r.changeDocument && (
            <CheckItems
              title="PRD 检查项"
              items={r.documentCheckItems}
              canEdit={canEdit}
              basePath={`/orgs/${org}/documents/${r.changeDocument.id}/checks`}
              invalidate={[requirementKeys(org), documentKeys(org), qk.workbench]}
            />
          )}
```

3. 右列 `<StatusPanel org={org} requirement={r} />` 之后加 `<PrdCard org={org} requirement={r} />`。

新建 `apps/web/src/app/(app)/[org]/reviews/document-reviews.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { QueryError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { documentHref } from '@/features/documents/model';
import { cellText, waitingText } from '@/features/reviews/model';
import { useDocumentReviews } from '@/lib/queries';

/** PRD 评审表：评审中的 PRD，每个作用于 PRD 的检查项一列；流程没有这类检查项时不显示。 */
export function DocumentReviews({ org, productId }: { org: string; productId: string }) {
  const q = useDocumentReviews(org, productId);
  if (q.isError) return <QueryError error={q.error} noAccessMessage="没有查看 PRD 评审的权限。" retryMessage="加载 PRD 评审失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-24" />;
  if (q.data.columns.length === 0) return null;
  return (
    <section aria-labelledby="doc-reviews-title" className="flex flex-col gap-2">
      <h2 id="doc-reviews-title" className="text-sm font-semibold">
        PRD 评审
      </h2>
      {q.data.rows.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted-foreground">没有评审中的 PRD</p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">编号</TableHead>
                <TableHead>标题</TableHead>
                <TableHead className="w-24">负责人</TableHead>
                {q.data.columns.map((c) => (
                  <TableHead key={c.key} className="w-28">
                    {c.label}
                  </TableHead>
                ))}
                <TableHead className="w-20">
                  <span className="sr-only">待签</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.rows.map((r) => (
                <TableRow key={r.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono text-[13px]">
                    <Link href={documentHref(org, r.displayKey)} className="hover:underline">
                      {r.displayKey}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-80 truncate">{r.title}</TableCell>
                  <TableCell className="text-[13px]">{r.owner?.displayName ?? '—'}</TableCell>
                  {q.data.columns.map((c) => (
                    <TableCell key={c.key} className="text-[13px]">
                      {cellText(r.cells[c.key]!)}
                    </TableCell>
                  ))}
                  <TableCell className="text-[12px] text-primary">{waitingText(r.waiting)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
```

`apps/web/src/app/(app)/[org]/reviews/page.tsx`：import 区加 `import { DocumentReviews } from './document-reviews';`；返回值里 `{body}` 之后加 `{product && <DocumentReviews org={org} productId={product.id} />}`。

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @flower/web typecheck && pnpm --filter @flower/web lint --max-warnings 0 && pnpm --filter @flower/web exec vitest run`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e documents-prd-flow.spec.ts documents-permissions.spec.ts requirements.spec.ts reviews.spec.ts workbench.spec.ts settings.spec.ts products.spec.ts`
Expected: PASS（后五个是改动需求详情、评审页、工作台、设置导航与产品设置页签后的回归）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src "apps/web/src/app/(app)/[org]" apps/web/e2e/documents-prd-flow.spec.ts apps/web/e2e/documents-permissions.spec.ts
git commit -m "feat(web): 文档模板设置与产品覆盖、需求挂 PRD、PRD 评审表与等我签字链接

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 15: 迁移：prd 系统页面、修订、附件（含内嵌图片）、评论与需求关联

**Files:**
- Modify: `packages/migrate/src/legacy-types.ts`（`PrdData` 增加页面、修订、附件、评论，`users` 带 id）
- Modify: `packages/migrate/src/load.ts`（`loadPrd`）
- Modify: `packages/migrate/src/plan-types.ts`（`ImportRows` 四张新表、`INSERT_ORDER`、`ImportOptions.availableUploads`、`ImportFile`、`ImportPlan.files`、报告的 `documents` 节、`PlanContext.requirementSources` 与 `files`）
- Modify: `packages/migrate/src/plan-requirements.ts`（记录 `requirementSources`）
- Create: `packages/migrate/src/plan-documents.ts`
- Modify: `packages/migrate/src/plan.ts`（调用、来源数量、跳过与延后清单）
- Modify: `packages/migrate/src/write.ts`（新表、`current_revision_id` 两段写入、删除顺序、附件文件写入存储）
- Modify: `packages/migrate/src/report.ts`（「PRD 文档」一节）
- Modify: `packages/migrate/src/cli.ts`（`--uploads`、`--storage`）
- Modify: `packages/migrate/test/fixtures.ts`（`withPrdPages`；prd 用户带 id）
- Modify: `CLAUDE.md`（导入命令加两个参数）
- Test: `packages/migrate/test/plan-documents.test.ts`、`packages/migrate/test/write.test.ts`

**Interfaces:**
- Consumes: Task 2 表；Task 3 `prdCheckState`、`documentDisplayKey`；Task 4 `PRESET_TEMPLATE`、`createLocalStorage`、`FileStorage`；现有 `PlanContext`、`legacyUuid`、`parseLegacyTime`
- Produces:
  - `legacy-types.ts`：`PrdUser`、`PrdPage`、`PrdPageVersion`、`PrdAttachment`、`PrdComment`；`PrdData = { domains; users: PrdUser[]; pages; pageVersions; attachments; comments; counts }`（`counts` 为含已删除页面的总数）
  - `plan-types.ts`：`type ImportFile = { storageKey: string; from: { legacyKey: string } | { base64: string } }`；`ImportPlan = { rows; report; files: ImportFile[] }`；`ImportOptions.availableUploads?: Set<string>`；`PlanContext.requirementSources: Array<{ id: string; number: number; plane: PlaneRequirement | null; push: PushRequirement | null }>`、`PlanContext.files: ImportFile[]`；`ReconReport.documents`（见 Step 3）
  - `plan-documents.ts`：`PRD_PAGE_STATUS`；`attachmentUrl(ctx, id)`；`coverRequirement(ctx, requirementId, documentId, status, documentKey): void`；`buildDocumentTemplates(ctx)`；`buildPrdDocuments(ctx)`
  - `write.ts`：`writeImport(adminDb, plan, opts: { replace: boolean; storage?: FileStorage; uploadsDir?: string }): Promise<{ filesWritten: number; filesMissing: number }>`
  - CLI：`import … [--uploads <prd_uploads 导出目录>] [--storage <附件存储目录，缺省读 FLOWER_STORAGE_DIR>]`

- [ ] **Step 1: 写失败的测试**

`packages/migrate/test/fixtures.ts`：

1. `pushReq` 的默认值里加 `prd_url: null,`（Task 16 用；`PushRequirement` 在 Step 3 加这个字段）。
2. `makeLegacyData()` 的 `prd` 改为：

```ts
    prd: {
      domains: [
        { name: '会员与支付', type: '产品域', group: '增长组', status: 'active', display_order: 1 },
        { name: '跨盘迁移', type: '产品域', group: '基础组', status: 'active', display_order: 2 },
      ],
      users: [{ id: 'pu1', email: 'zhangsan@example.com', name: '张三' }],
      pages: [],
      pageVersions: [],
      attachments: [],
      comments: [],
      counts: { pages: 0, pageVersions: 0, attachments: 0, comments: 0 },
    },
```

3. 文件末尾加：

```ts
export const LEGACY_FILE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png';
export const INLINE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 两份 prd 页面（全部为虚构内容）：一份已上线、挂在 X001 上，正文引用旧附件并内嵌一张图片；一份开发中。另有已删除页面的计数。 */
export function withPrdPages(data: LegacyData = makeLegacyData()): LegacyData {
  data.prd.users.push({ id: 'pu2', email: 'lisi@example.com', name: '李四' });
  const title = '[会员] 批量下载 - 2026-03-01';
  data.prd.pages = [
    {
      id: 'pg1', title, markdown: `## 背景\n\n![](/api/files/${LEGACY_FILE})\n\n![](data:image/png;base64,${INLINE_PNG})\n\n当前正文`, version: 3, status: 'launched',
      owner_user_id: 'pu2', created_by: 'pu1', updated_by: 'pu1', created_at: '2026-03-01T00:00:00.000Z', updated_at: '2026-03-05T00:00:00.000Z', linked_requirement_id: 'X001',
    },
    {
      id: 'pg2', title: '草稿页', markdown: '## 背景\n\n草稿', version: 1, status: 'in_dev', owner_user_id: null, created_by: 'pu2', updated_by: 'pu2',
      created_at: '2026-03-02T00:00:00.000Z', updated_at: '2026-03-02T00:00:00.000Z', linked_requirement_id: null,
    },
  ];
  data.prd.pageVersions = [
    { page_id: 'pg1', version: 1, title, markdown: '## 背景\n\n第一版', diff_summary: null, author_id: 'pu1', created_at: '2026-03-01T00:00:00.000Z' },
    { page_id: 'pg1', version: 3, title, markdown: `## 背景\n\n![](data:image/png;base64,${INLINE_PNG})\n\n第三版`, diff_summary: '补图', author_id: 'pu2', created_at: '2026-03-03T00:00:00.000Z' },
    { page_id: 'pg2', version: 1, title: '草稿页', markdown: '## 背景\n\n草稿', diff_summary: null, author_id: 'pu2', created_at: '2026-03-02T00:00:00.000Z' },
  ];
  data.prd.attachments = [
    { id: 'att1', page_id: 'pg1', uploader_id: 'pu1', storage_key: LEGACY_FILE, filename: '截图.png', mime: 'image/png', size_bytes: 1234, width: null, height: null, created_at: '2026-03-01T00:00:00.000Z' },
  ];
  data.prd.comments = [
    { id: 'c1', page_id: 'pg1', parent_comment_id: null, body_markdown: '这里要确认', resolved_at: null, resolved_by: null, author_id: 'pu2', created_at: '2026-03-02T00:00:00.000Z' },
    { id: 'c2', page_id: 'pg1', parent_comment_id: 'c1', body_markdown: '已确认', resolved_at: '2026-03-03T00:00:00.000Z', resolved_by: 'pu1', author_id: 'pu1', created_at: '2026-03-03T00:00:00.000Z' },
  ];
  data.prd.counts = { pages: 3, pageVersions: 4, attachments: 2, comments: 3 };
  return data;
}
```

新建 `packages/migrate/test/plan-documents.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { legacyUuid } from '../src/ids';
import { buildImportPlan } from '../src/plan';
import type { ImportOptions } from '../src/plan-types';
import { INLINE_PNG, LEGACY_FILE, reviewedMapping, withPrdPages } from './fixtures';

const OPTS: ImportOptions = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null, availableUploads: new Set() };

describe('导入计划：prd 页面', () => {
  const data = withPrdPages();
  const { rows, report, files } = buildImportPlan(data, reviewedMapping(data), OPTS);
  const doc1 = rows.documents.find((d) => d.legacyKey === 'prd:pg1')!;
  const member = (name: string) => rows.members.find((m) => m.displayName === name)!.id;

  it('页面按创建时间编号；状态映射；负责人取 prd_meta.ownerUserId；预置模板一并导入', () => {
    expect(report.problems).toEqual([]);
    expect(rows.documents.map((d) => [d.number, d.legacyKey, d.status, d.source])).toEqual([
      [1, 'prd:pg1', 'launched', 'native'],
      [2, 'prd:pg2', 'approved', 'native'],
    ]);
    expect(doc1.ownerMemberId).toBe(member('李四'));
    expect(rows.products[0]!.documentSeq).toBe(2);
    expect(rows.documentTemplates.map((t) => t.name)).toEqual(['变更 PRD（预置）']);
  });

  it('修订按旧版本号升序重新编号；当前正文与最后一版不同时追加一版；图片引用改为附件网址，内嵌图片抽成附件', () => {
    const revs = rows.documentRevisions.filter((r) => r.documentId === doc1.id).sort((a, b) => a.version - b.version);
    expect(revs.map((r) => [r.version, r.summary])).toEqual([
      [1, null],
      [2, '补图'],
      [3, '迁移时的当前内容'],
    ]);
    expect(doc1).toMatchObject({ version: 3, currentRevisionId: revs[2]!.id });
    const legacyAtt = legacyUuid('pan123/attachment', 'prd:att1');
    const current = revs[2]!.snapshot.markdown;
    expect(current).toContain(`/api/v1/orgs/pan123/attachments/${legacyAtt}`);
    expect(current).not.toContain('data:');
    expect(current).not.toContain('/api/files/');
    expect(revs[1]!.snapshot.markdown).not.toContain('data:');
    expect(rows.attachments.map((a) => [a.filename, a.mime, a.targetId])).toEqual([
      ['截图.png', 'image/png', doc1.id],
      [expect.stringMatching(/^inline-[0-9a-f]{8}\.png$/), 'image/png', doc1.id],
    ]);
    expect(files).toEqual([
      { storageKey: rows.attachments[0]!.storageKey, from: { legacyKey: LEGACY_FILE } },
      { storageKey: rows.attachments[1]!.storageKey, from: { base64: INLINE_PNG } },
    ]);
  });

  it('评论导入为未定位，保留回复与解决状态；需求关联写入 change_document_id', () => {
    const cs = rows.comments.filter((c) => c.targetType === 'document');
    expect(cs.map((c) => [c.body, c.anchorState, c.anchor])).toEqual([
      ['这里要确认', 'unanchored', null],
      ['已确认', 'unanchored', null],
    ]);
    expect(cs[1]!.parentId).toBe(cs[0]!.id);
    expect(cs[1]!.resolvedBy).toBe(member('张三'));
    expect(rows.requirements.find((r) => r.legacyKey === 'X001')!.changeDocumentId).toBe(doc1.id);
  });

  it('对账报告：数量、缺失的附件文件、已删除页面计入跳过', () => {
    expect(report.documents).toMatchObject({ pages: 2, revisions: 4, attachments: 1, inlineImages: 1, comments: 2, linkedRequirements: 1, missingFiles: 1 });
    expect(report.skipped).toEqual(
      expect.arrayContaining([{ what: 'prd 已删除的页面（连同其修订 1 条、附件 1 个、评论 1 条）', count: 1, reason: '页面已在 prd 系统中删除' }]),
    );
    expect(report.deferred.map((d) => d.what)).not.toContain('PRD 页面');
  });
});
```

（`withPrdPages` 的计数：页面总数 3、修订 4、附件 2、评论 3，减去导入的 2 / 3 / 1 / 2，已删除页面 1 份连同修订 1、附件 1、评论 1。）

`packages/migrate/test/write.test.ts`：

1. 顶部 import 加：

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalStorage, getDocumentByKey, listDocumentComments, readAttachment } from '@flower/core';
```

并把 `import { makeLegacyData, reviewedMapping } from './fixtures';` 改为 `import { INLINE_PNG, LEGACY_FILE, makeLegacyData, reviewedMapping, withPrdPages } from './fixtures';`

2. `describe('写入数据库', …)` 里加：

```ts
  it('prd 页面：文档、修订、评论写入；附件文件从导出目录与内嵌图片写进存储', async () => {
    const uploads = mkdtempSync(path.join(os.tmpdir(), 'prd-uploads-'));
    writeFileSync(path.join(uploads, LEGACY_FILE), Buffer.from(INLINE_PNG, 'base64'));
    const storage = createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-storage-')));
    const data = withPrdPages();
    const plan = buildImportPlan(data, reviewedMapping(data), { ...opts, orgSlug: 'prd123', availableUploads: new Set([LEGACY_FILE]) });
    expect(await writeImport(t.adminDb, plan, { replace: false, storage, uploadsDir: uploads })).toEqual({ filesWritten: 2, filesMissing: 0 });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'prd123'))!;
    const doc = await getDocumentByKey(t.db, actor, 'PAN-PRD-1');
    expect(doc).toMatchObject({ source: 'native', status: 'launched', revisionNumber: 3, requirements: [{ displayKey: 'PAN-1' }] });
    expect(await listDocumentComments(t.db, actor, doc.id)).toHaveLength(2);
    for (const att of plan.rows.attachments) {
      expect((await readAttachment(t.db, actor, { attachmentId: att.id!, storage })).mime).toBe('image/png');
    }
    await writeImport(t.adminDb, plan, { replace: true, storage, uploadsDir: uploads });
    expect((await getDocumentByKey(t.db, actor, 'PAN-PRD-1')).revisionNumber).toBe(3);
  });
```

Run: `pnpm --filter @flower/migrate test`
Expected: FAIL（类型不符：`pages` 不在 `PrdData`；`buildImportPlan` 没有 `files`）。

- [ ] **Step 2: 读取 prd 库**

`packages/migrate/src/legacy-types.ts`：把 `export type PrdData = {…};` 替换为：

```ts
export type PrdUser = { id: string; email: string; name: S };
export type PrdPage = {
  id: string; title: string; markdown: string; version: number; status: S; owner_user_id: S; created_by: string; updated_by: string;
  created_at: string; updated_at: string; linked_requirement_id: S;
};
export type PrdPageVersion = { page_id: string; version: number; title: string; markdown: string; diff_summary: S; author_id: string; created_at: string };
export type PrdAttachment = {
  id: string; page_id: string; uploader_id: string; storage_key: string; filename: string; mime: string; size_bytes: number;
  width: number | null; height: number | null; created_at: string;
};
export type PrdComment = {
  id: string; page_id: string; parent_comment_id: S; body_markdown: string; resolved_at: S; resolved_by: S; author_id: string; created_at: string;
};
export type PrdData = {
  domains: Array<{ name: string; type: S; group: S; status: string; display_order: number }>;
  users: PrdUser[];
  /** 未删除的页面及其下的修订、附件、评论。 */
  pages: PrdPage[];
  pageVersions: PrdPageVersion[];
  attachments: PrdAttachment[];
  comments: PrdComment[];
  /** 含已删除页面在内的总数，用于对账报告的「跳过」。 */
  counts: { pages: number; pageVersions: number; attachments: number; comments: number };
};
```

并在 `PushRequirement` 的字段里 `merged_into: number | null;` 之前加 `prd_url: S;`。

`packages/migrate/src/load.ts`：

1. `loadPush` 的需求查询 `last_edited_by, last_edited_at, plane_id, merged_into from requirements` 改为 `last_edited_by, last_edited_at, plane_id, prd_url, merged_into from requirements`。
2. import 改为 `import type { PlaneData, PrdData, PushData } from './legacy-types';`（不变），把 `loadPrd` 整个替换为：

```ts
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function loadPrd(url: string): Promise<PrdData> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const domains = await sql<PrdData['domains']>`select name, type, "group", status, display_order from prd_domains order by display_order, name`;
    const users = await sql<PrdData['users']>`select id, email, name from users order by email`;
    const pages = await sql<Array<Omit<PrdData['pages'][number], 'created_at' | 'updated_at'> & { created_at: Date; updated_at: Date }>>`
      select id::text, title, markdown, version, prd_meta->>'status' as status, prd_meta->>'ownerUserId' as owner_user_id,
             created_by, updated_by, created_at, updated_at, linked_requirement_id
      from pages where deleted_at is null order by created_at, id`;
    const live = sql`(select id from pages where deleted_at is null)`;
    const versions = await sql<Array<Omit<PrdData['pageVersions'][number], 'created_at'> & { created_at: Date }>>`
      select page_id::text, version, title, markdown, diff_summary, author_id, created_at
      from page_versions where page_id in ${live} order by page_id, version`;
    const attachments = await sql<Array<Omit<PrdData['attachments'][number], 'created_at' | 'size_bytes'> & { created_at: Date; size_bytes: string }>>`
      select id::text, page_id::text, uploader_id, storage_key, filename, mime, size_bytes, width, height, created_at
      from attachments where page_id in ${live} order by created_at, id`;
    const comments = await sql<Array<Omit<PrdData['comments'][number], 'created_at' | 'resolved_at'> & { created_at: Date; resolved_at: Date | null }>>`
      select id::text, page_id::text, parent_comment_id::text, body_markdown, resolved_at, resolved_by, author_id, created_at
      from comments where page_id in ${live} order by created_at, id`;
    const [c] = await sql<Array<PrdData['counts']>>`
      select (select count(*)::int from pages) as pages,
             (select count(*)::int from page_versions) as "pageVersions",
             (select count(*)::int from attachments) as attachments,
             (select count(*)::int from comments) as comments`;
    return {
      domains: [...domains],
      users: [...users],
      pages: pages.map((p) => ({ ...p, created_at: iso(p.created_at)!, updated_at: iso(p.updated_at)! })),
      pageVersions: versions.map((v) => ({ ...v, created_at: iso(v.created_at)! })),
      attachments: attachments.map((a) => ({ ...a, size_bytes: Number(a.size_bytes), created_at: iso(a.created_at)! })),
      comments: comments.map((x) => ({ ...x, resolved_at: iso(x.resolved_at), created_at: iso(x.created_at)! })),
      counts: c!,
    };
  } finally {
    await sql.end();
  }
}
```

（`bigint` 由驱动返回字符串，所以 `size_bytes` 先按字符串取再转数字。）

- [ ] **Step 3: 计划类型**

`packages/migrate/src/plan-types.ts`：

1. import 改为：

```ts
import type * as core from '@flower/core';
import { legacyUuid } from './ids';
import type { LegacyData, PlaneRequirement, PushRequirement } from './legacy-types';
import { type Mapping, type PersonEntry, Resolver } from './mapping';
import { parseLegacyTime } from './normalize';
```

2. `ImportOptions` 加一行：

```ts
  /** --uploads 导出目录里有的旧附件文件名；没给目录时为 undefined（报告里不统计缺失）。 */
  availableUploads?: Set<string>;
```

3. `ImportRows` 在 `structureNodes` 之后加：

```ts
  documentTemplates: Ins<typeof core.documentTemplates>;
  documents: Ins<typeof core.documents>;
  documentRevisions: Ins<typeof core.documentRevisions>;
  attachments: Ins<typeof core.attachments>;
```

4. `INSERT_ORDER` 改为：

```ts
export const INSERT_ORDER: Array<keyof ImportRows> = [
  'organizations', 'members', 'functionTags', 'memberFunctionTags', 'workflowDefinitions', 'workflowVersions', 'products',
  'productMembers', 'fieldDefinitions', 'fieldOptions', 'structureNodes', 'iterations', 'releases',
  'documentTemplates', 'documents', 'documentRevisions', 'attachments', 'requirements', 'fieldValues',
  'requirementAssignments', 'requirementRelations', 'stateTransitions', 'blockers', 'checkItemResults', 'checkItemSignoffs',
  'requirementReleases', 'tasks', 'comments', 'commentReads', 'entityAliases', 'domainEvents',
];
```

5. `ReconReport` 在 `problems: string[];` 之前加：

```ts
  documents: {
    pages: number;
    revisions: number;
    attachments: number;
    inlineImages: number;
    comments: number;
    linkedRequirements: number;
    /** 导出目录里缺少的旧附件文件数；没给导出目录时为 null。 */
    missingFiles: number | null;
    externalImages: number;
    brokenImageRefs: number;
    external: {
      docs: number;
      requirements: number;
      shared: number;
      statusCounts: Record<string, number>;
      nonUrl: Array<{ displayKey: string; source: string; value: string }>;
      mismatches: Array<{ displayKey: string; plane: string; push: string }>;
      skippedNative: Array<{ displayKey: string; url: string }>;
      mergedOnly: number;
    };
    prdCheckChanges: Array<{ displayKey: string; document: string; from: string; to: string }>;
  };
```

6. 文件里 `export type ImportPlan = { rows: ImportRows; report: ReconReport };` 改为：

```ts
export type ImportFile = { storageKey: string; from: { legacyKey: string } | { base64: string } };
export type ImportPlan = { rows: ImportRows; report: ReconReport; files: ImportFile[] };
```

7. `PlanContext` 类里 `workflow!: core.WorkflowBody;` 之后加：

```ts
  /** 每条导入需求的来源（123plane 与 push 配对结果），外部 PRD 链接按它取原值。 */
  readonly requirementSources: Array<{ id: string; number: number; plane: PlaneRequirement | null; push: PushRequirement | null }> = [];
  /** 需要写进附件存储的文件。 */
  readonly files: ImportFile[] = [];
```

构造函数里 `this.report = { … problems: [] };` 的对象加：

```ts
      documents: {
        pages: 0,
        revisions: 0,
        attachments: 0,
        inlineImages: 0,
        comments: 0,
        linkedRequirements: 0,
        missingFiles: opts.availableUploads ? 0 : null,
        externalImages: 0,
        brokenImageRefs: 0,
        external: { docs: 0, requirements: 0, shared: 0, statusCounts: {}, nonUrl: [], mismatches: [], skippedNative: [], mergedOnly: 0 },
        prdCheckChanges: [],
      },
```

`packages/migrate/src/plan-requirements.ts`：在 `// 2. 逐条需求` 循环体里 `const id = plane ? … ;` 一行之后加：

```ts
    ctx.requirementSources.push({ id, number, plane, push });
```

- [ ] **Step 4: prd 页面的导入计划**

新建 `packages/migrate/src/plan-documents.ts`：

```ts
import { createHash } from 'node:crypto';
import { type CheckState, type DocumentStatus, PRESET_TEMPLATE, prdCheckState } from '@flower/core';
import type { PrdPage } from './legacy-types';
import type { PlanContext } from './plan-types';

/** prd 系统的 prd_meta.status → 变更 PRD 状态（设计 §6）。 */
export const PRD_PAGE_STATUS: Record<string, DocumentStatus> = { draft: 'draft', review: 'review', approved: 'approved', in_dev: 'approved', launched: 'launched' };
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const FILE_REF = /\/api\/files\/([0-9a-f-]{36}\.[a-z]+)/g;
const DATA_IMAGE = /data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)/g;
const REMOTE_IMAGE = /!\[[^\]]*\]\(https?:\/\//g;
const RELATIVE_IMAGE = /!\[[^\]]*\]\((?!https?:\/\/|\/|data:)[^)]+\)/g;

export const attachmentUrl = (ctx: PlanContext, id: string): string => `/api/v1/orgs/${ctx.opts.orgSlug}/attachments/${id}`;

const byCreated = <T extends { created_at: string; id: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

export function buildDocumentTemplates(ctx: PlanContext): void {
  ctx.rows.documentTemplates.push({
    id: ctx.id('template', 'preset'),
    orgId: ctx.orgId,
    productId: null,
    kind: 'change',
    name: PRESET_TEMPLATE.name,
    body: PRESET_TEMPLATE.body,
    sections: PRESET_TEMPLATE.sections,
    active: true,
    createdAt: ctx.asOfTime,
    updatedAt: ctx.asOfTime,
  });
}

/** 需求挂到 PRD 上，「PRD」检查项按 PRD 状态改写（设计 §3 映射）；改写前后不同的记入对账报告。 */
export function coverRequirement(ctx: PlanContext, requirementId: string, documentId: string, status: DocumentStatus, documentKey: string): void {
  const req = ctx.rows.requirements.find((r) => r.id === requirementId)!;
  req.changeDocumentId = documentId;
  const state: CheckState = prdCheckState(status);
  const existing = ctx.rows.checkItemResults.find((c) => c.targetType === 'requirement' && c.targetId === requirementId && c.itemKey === 'prd');
  const old = existing?.state ?? 'not_started';
  if (existing) existing.state = state;
  else {
    ctx.rows.checkItemResults.push({
      id: ctx.id('check', `${requirementId}:prd`),
      orgId: ctx.orgId,
      targetType: 'requirement',
      targetId: requirementId,
      itemKey: 'prd',
      state,
      note: null,
      meta: {},
      updatedBy: null,
      updatedAt: ctx.asOfTime,
    });
  }
  if (old !== state) ctx.report.documents.prdCheckChanges.push({ displayKey: `${ctx.opts.productKey}-${req.number}`, document: documentKey, from: old, to: state });
}

/** prd 系统未删除的页面 → Flower 内的变更 PRD，连同修订、附件（含内嵌图片）、评论与需求关联。 */
export function buildPrdDocuments(ctx: PlanContext): void {
  const { data, rows, orgId, productId, report } = ctx;
  const prd = data.prd;
  const userById = new Map(prd.users.map((u) => [u.id, u]));
  const member = (userId: string | null): string | null => {
    if (!userId) return null;
    const u = userById.get(userId);
    if (!u) {
      ctx.problem(`prd 用户 ${userId} 不在 users 表中`);
      return null;
    }
    return ctx.resolver.personPeek(u.email) ? ctx.memberId(u.email) : ctx.memberId(u.name ?? u.email);
  };
  const legacyAttachmentId = new Map(prd.attachments.map((a) => [a.storage_key, ctx.id('attachment', `prd:${a.id}`)]));
  const pages = [...prd.pages].sort(byCreated);
  const docs = report.documents;

  pages.forEach((p: PrdPage, index) => {
    const number = index + 1;
    const id = ctx.id('document', `prd:${p.id}`);
    const documentKey = `${ctx.opts.productKey}-PRD-${number}`;
    const status = PRD_PAGE_STATUS[p.status ?? ''];
    if (!status) {
      ctx.problem(`prd 页面状态「${p.status}」没有对应的 PRD 状态`);
      return;
    }
    const inline = new Map<string, string>();
    const rewrite = (markdown: string): string =>
      markdown
        .replace(FILE_REF, (all, key: string) => {
          const att = legacyAttachmentId.get(key);
          return att ? attachmentUrl(ctx, att) : all;
        })
        .replace(DATA_IMAGE, (_all, mime: string, base64: string) => {
          const sha = createHash('sha1').update(base64).digest('hex');
          let attId = inline.get(sha);
          if (!attId) {
            attId = ctx.id('attachment', `inline:${p.id}:${sha}`);
            inline.set(sha, attId);
            const storageKey = `${orgId}/${attId}.${IMAGE_EXT[mime]}`;
            rows.attachments.push({
              id: attId,
              orgId,
              targetType: 'document',
              targetId: id,
              storageKey,
              filename: `inline-${sha.slice(0, 8)}.${IMAGE_EXT[mime]}`,
              mime,
              sizeBytes: Buffer.from(base64, 'base64').byteLength,
              width: null,
              height: null,
              uploaderMemberId: member(p.created_by),
              createdAt: ctx.time(p.created_at),
            });
            ctx.files.push({ storageKey, from: { base64 } });
            docs.inlineImages += 1;
          }
          return attachmentUrl(ctx, attId);
        });

    // 旧附件：先于内嵌图片登记，报告与文件列表里顺序稳定
    for (const a of prd.attachments.filter((x) => x.page_id === p.id)) {
      const attId = legacyAttachmentId.get(a.storage_key)!;
      const ext = IMAGE_EXT[a.mime];
      if (!ext) {
        ctx.problem(`prd 附件类型「${a.mime}」不是支持的图片类型`);
        continue;
      }
      const storageKey = `${orgId}/${attId}.${ext}`;
      rows.attachments.push({
        id: attId,
        orgId,
        targetType: 'document',
        targetId: id,
        storageKey,
        filename: a.filename,
        mime: a.mime,
        sizeBytes: a.size_bytes,
        width: a.width,
        height: a.height,
        uploaderMemberId: member(a.uploader_id),
        createdAt: ctx.time(a.created_at),
      });
      ctx.files.push({ storageKey, from: { legacyKey: a.storage_key } });
      docs.attachments += 1;
      if (ctx.opts.availableUploads && !ctx.opts.availableUploads.has(a.storage_key)) docs.missingFiles = (docs.missingFiles ?? 0) + 1;
    }

    const snaps = prd.pageVersions
      .filter((v) => v.page_id === p.id)
      .sort((a, b) => a.version - b.version)
      .map((v) => ({ title: v.title, markdown: rewrite(v.markdown), summary: v.diff_summary?.trim() || null, author: member(v.author_id), at: ctx.time(v.created_at) }));
    const current = { title: p.title, markdown: rewrite(p.markdown) };
    const last = snaps.at(-1);
    if (!last || last.title !== current.title || last.markdown !== current.markdown) {
      snaps.push({ ...current, summary: '迁移时的当前内容', author: member(p.updated_by), at: ctx.time(p.updated_at) });
    }
    snaps.forEach((s, j) =>
      rows.documentRevisions.push({
        id: ctx.id('revision', `prd:${p.id}:${j + 1}`),
        orgId,
        documentId: id,
        version: j + 1,
        snapshot: { title: s.title, markdown: s.markdown },
        summary: s.summary,
        authorMemberId: s.author,
        createdAt: s.at,
        updatedAt: s.at,
      }),
    );
    docs.revisions += snaps.length;
    docs.externalImages += [...current.markdown.matchAll(REMOTE_IMAGE)].length;
    docs.brokenImageRefs += [...current.markdown.matchAll(RELATIVE_IMAGE)].length;

    rows.documents.push({
      id,
      orgId,
      productId,
      number,
      kind: 'change',
      source: 'native',
      title: p.title.trim() || '（无标题）',
      ownerMemberId: member(p.owner_user_id ?? p.created_by),
      templateId: null,
      status,
      currentRevisionId: ctx.id('revision', `prd:${p.id}:${snaps.length}`),
      externalUrl: null,
      externalUrlKey: null,
      externalProvider: null,
      version: snaps.length,
      legacyKey: `prd:${p.id}`,
      createdBy: member(p.created_by),
      createdAt: ctx.time(p.created_at),
      updatedAt: ctx.time(p.updated_at),
    });
    docs.pages += 1;

    const pageComments = prd.comments.filter((c) => c.page_id === p.id).sort(byCreated);
    const commentIds = new Set(pageComments.map((c) => c.id));
    for (const c of pageComments) {
      if (c.parent_comment_id && !commentIds.has(c.parent_comment_id)) ctx.problem(`prd 评论 ${c.id} 的上级评论不在同一页面`);
      rows.comments.push({
        id: ctx.id('comment', `prd:${c.id}`),
        orgId,
        targetType: 'document',
        targetId: id,
        parentId: c.parent_comment_id ? ctx.id('comment', `prd:${c.parent_comment_id}`) : null,
        authorMemberId: member(c.author_id),
        body: c.body_markdown,
        kind: 'comment',
        anchor: null,
        anchorState: 'unanchored',
        resolvedAt: c.resolved_at ? ctx.time(c.resolved_at) : null,
        resolvedBy: member(c.resolved_by),
        createdAt: ctx.time(c.created_at),
      });
      docs.comments += 1;
    }

    const linked = p.linked_requirement_id?.trim();
    if (linked) {
      const requirementId = ctx.id('req', `plane:${linked}`);
      if (!rows.requirements.some((r) => r.id === requirementId)) ctx.problem(`prd 页面关联的需求 ${linked} 不在导入范围内`);
      else {
        coverRequirement(ctx, requirementId, id, status, documentKey);
        docs.linkedRequirements += 1;
      }
    }
  });
  rows.products[0]!.documentSeq = rows.documents.length;
}
```

- [ ] **Step 5: 计划入口、写入与报告**

`packages/migrate/src/plan.ts`：

1. import 加 `import { buildDocumentTemplates, buildPrdDocuments } from './plan-documents';`
2. `buildRequirements(ctx);` 之后加：

```ts
  buildDocumentTemplates(ctx);
  buildPrdDocuments(ctx);
```

3. `sourceCounts` 里 `'prd.users': prd.users.length,` 之后加：

```ts
    'prd.pages': prd.pages.length,
    'prd.pageVersions': prd.pageVersions.length,
    'prd.attachments': prd.attachments.length,
    'prd.comments': prd.comments.length,
```

4. `report.deferred.push(…)` 里删去 `PRD 页面`、`PRD 页面修订`、`PRD 附件`、`PRD 评论` 四行。
5. `report.skipped.push(…)` 的参数列表开头加：

```ts
    {
      what: `prd 已删除的页面（连同其修订 ${prd.counts.pageVersions - prd.pageVersions.length} 条、附件 ${prd.counts.attachments - prd.attachments.length} 个、评论 ${prd.counts.comments - prd.comments.length} 条）`,
      count: prd.counts.pages - prd.pages.length,
      reason: '页面已在 prd 系统中删除',
    },
```

6. `return { rows, report };` 改为 `return { rows, report, files: ctx.files };`

`packages/migrate/src/write.ts`：

1. import 区：`import * as core from '@flower/core';` 下面加 `import { existsSync, readFileSync } from 'node:fs';`、`import path from 'node:path';`；`import type { Db, Tx } from '@flower/core';` 改为 `import type { Db, FileStorage, Tx } from '@flower/core';`
2. `TABLES` 里 `structureNodes: core.structureNodes,` 之后加：

```ts
  documentTemplates: core.documentTemplates,
  documents: core.documents,
  documentRevisions: core.documentRevisions,
  attachments: core.attachments,
```

3. `deleteOrgData` 第一行之前加：

```ts
  await tx.update(core.documents).set({ currentRevisionId: null }).where(eq(core.documents.orgId, orgId));
```

4. `writeImport` 整个替换为：

```ts
export async function writeImport(
  adminDb: Db,
  plan: ImportPlan,
  opts: { replace: boolean; storage?: FileStorage; uploadsDir?: string },
): Promise<{ filesWritten: number; filesMissing: number }> {
  if (plan.report.problems.length > 0) throw new Error(`导入计划有 ${plan.report.problems.length} 个问题，拒绝写入。请先处理对账报告中的问题。`);
  const org = plan.rows.organizations[0]!;
  await adminDb.transaction(async (tx) => {
    const [existing] = await tx.select({ id: core.organizations.id }).from(core.organizations).where(eq(core.organizations.slug, org.slug));
    if (existing) {
      if (!opts.replace) throw new Error(`组织「${org.slug}」已存在；确认要用本次导入覆盖时加 --replace`);
      // 覆盖会删掉现有的全部成员关系；计划里没有关联账号的所有者时，覆盖后就没有任何账号能进入该组织
      if (!plan.rows.members.some((m) => m.accountId && m.orgRole === 'owner')) {
        throw new Error(`覆盖组织「${org.slug}」时必须用 --owner-email 指定所有者账号，否则覆盖后没有任何账号能登录该组织`);
      }
      await deleteOrgData(tx, existing.id);
    }
    for (const key of INSERT_ORDER) {
      // 与当前版本 / 当前修订互相引用的两张表先不写引用，等被引用的行写完再补
      const rows = (
        key === 'workflowDefinitions'
          ? plan.rows.workflowDefinitions.map((d) => ({ ...d, currentVersionId: null }))
          : key === 'documents'
            ? plan.rows.documents.map((d) => ({ ...d, currentRevisionId: null }))
            : plan.rows[key]
      ) as unknown[];
      for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(TABLES[key]).values(rows.slice(i, i + CHUNK) as never);
      if (key === 'workflowVersions') {
        for (const d of plan.rows.workflowDefinitions) {
          await tx.update(core.workflowDefinitions).set({ currentVersionId: d.currentVersionId }).where(eq(core.workflowDefinitions.id, d.id!));
        }
      }
      if (key === 'documentRevisions') {
        for (const d of plan.rows.documents) {
          if (d.currentRevisionId) await tx.update(core.documents).set({ currentRevisionId: d.currentRevisionId }).where(eq(core.documents.id, d.id!));
        }
      }
    }
  });
  // 数据库提交后再写文件：键由来源确定，重复导入覆盖同一个文件
  let filesWritten = 0;
  let filesMissing = 0;
  if (opts.storage) {
    for (const f of plan.files) {
      let bytes: Uint8Array | null = null;
      if ('base64' in f.from) bytes = Buffer.from(f.from.base64, 'base64');
      else if (opts.uploadsDir && existsSync(path.join(opts.uploadsDir, f.from.legacyKey))) bytes = readFileSync(path.join(opts.uploadsDir, f.from.legacyKey));
      if (!bytes) {
        filesMissing += 1;
        continue;
      }
      await opts.storage.put(f.storageKey, bytes);
      filesWritten += 1;
    }
  } else filesMissing = plan.files.length;
  return { filesWritten, filesMissing };
}
```

`packages/migrate/src/report.ts`：在 `'## 跳过的数据',` 之前插入：

```ts
    '## PRD 文档（prd 系统）',
    '',
    table(
      ['项', '数量'],
      [
        ['页面', r.documents.pages],
        ['修订', r.documents.revisions],
        ['附件', r.documents.attachments],
        ['内嵌图片抽成附件', r.documents.inlineImages],
        ['评论（未定位）', r.documents.comments],
        ['需求关联', r.documents.linkedRequirements],
        ['附件文件缺失', r.documents.missingFiles === null ? '未提供导出目录' : r.documents.missingFiles],
        ['外链图片（保留原链接）', r.documents.externalImages],
        ['相对路径图片（旧导入时已失效，原样保留）', r.documents.brokenImageRefs],
      ],
    ),
```

`packages/migrate/src/cli.ts`：

1. `USAGE` 的 import 那两行之后加一行说明：`          [--uploads <prd_uploads 导出目录>] [--storage <附件存储目录，缺省读 FLOWER_STORAGE_DIR>]`
2. `parseArgs` 的 options 加 `uploads: { type: 'string' },` 与 `storage: { type: 'string' },`；import 区加 `import { existsSync, readdirSync } from 'node:fs';`（与现有 `node:fs` import 合并），`import { createLocalStorage } from '@flower/core';`（与现有 `@flower/core` import 合并）。
3. `buildImportPlan(data, mapping, { … owner, })` 的选项对象加：

```ts
    availableUploads: v.uploads && existsSync(v.uploads) ? new Set(readdirSync(v.uploads)) : undefined,
```

4. 写库部分 `await writeImport(db, plan, { replace: v.replace! });` 改为：

```ts
    const storageDir = v.storage ?? process.env.FLOWER_STORAGE_DIR;
    const files = await writeImport(db, plan, { replace: v.replace!, storage: storageDir ? createLocalStorage(storageDir) : undefined, uploadsDir: v.uploads });
    console.log(storageDir ? `附件文件：写入 ${files.filesWritten} 个，缺失 ${files.filesMissing} 个。` : `未指定 --storage，附件文件 ${files.filesMissing} 个没有写入。`);
```

`CLAUDE.md` 命令表「迁移旧数据」一行的命令改为：

```
pnpm --filter @flower/migrate legacy import …同上参数… --out "$PWD/.local-data/reports" --owner-email <你的账号邮箱> --uploads "$PWD/.local-data/prd_uploads" --storage "$PWD/apps/web/.flower-storage" [--replace] [--dry-run]
```

并在「约定」最后一条后补一句：`prd 系统的附件文件需要先从服务器只读导出到 .local-data/prd_uploads/（导出前征得用户同意）；没有导出时导入仍可进行，报告列出缺失的文件数。`

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @flower/migrate test && pnpm --filter @flower/migrate typecheck`
Expected: 全部通过（含原有 `plan-requirements`、`write`、`load`、`report` 测试）。

- [ ] **Step 7: 提交**

```bash
git add packages/migrate CLAUDE.md
git commit -m "feat(migrate): prd 系统页面、修订、附件与评论导入为 Flower 内的变更 PRD

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 16: 迁移：123plane `prd_link` 与 push `prd_url` 导入为外部 PRD；「PRD」检查项跟随 PRD 状态

**Files:**
- Create: `packages/migrate/src/plan-external.ts`
- Modify: `packages/migrate/src/plan.ts`（调用；删除「外部 PRD 链接不迁移」两条跳过记录）
- Modify: `packages/migrate/src/workflow-v1.ts`（「PRD」检查项加 `auto: 'prd_status'`）
- Modify: `packages/migrate/src/report.ts`（「外部 PRD」「PRD 检查项改写」两节）
- Modify: `docs/superpowers/specs/2026-09-28-flower-data-model-design.md` §7.2「PRD」第二条
- Test: `packages/migrate/test/plan-external.test.ts`

**Interfaces:**
- Consumes: Task 3 `normalizeExternalUrl`、`documentDisplayKey`；Task 15 `coverRequirement`、`PlanContext.requirementSources`、`ReconReport.documents.external`、`prdCheckChanges`
- Produces:
  - `plan-external.ts`：`PLANE_PRD_STATUS_TO_DOCUMENT: Record<string, 'draft' | 'review' | 'approved' | null>`；`deriveExternalStatus(uses: Array<{ prdStatus: string | null; stateKey: string }>): DocumentStatus`；`buildExternalDocuments(ctx: PlanContext): void`
  - 外部 PRD 的 ID：`ctx.id('document', 'ext:' + 规范化网址)`；`legacyKey = 'ext:' + 规范化网址`

- [ ] **Step 1: 写失败的测试**

新建 `packages/migrate/test/plan-external.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { LegacyData } from '../src/legacy-types';
import { buildImportPlan } from '../src/plan';
import { deriveExternalStatus } from '../src/plan-external';
import type { ImportOptions } from '../src/plan-types';
import { makeLegacyData, reviewedMapping, withPrdPages } from './fixtures';

const OPTS: ImportOptions = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: null };

/** X001、X002 共用一份企业微信文档（分享码不同）；X001 在 push 里写了另一个网址；push 独有的离线下载有链接；已搁置需求的链接其实是一段文字；被合并的 push 需求有一个只有它用的链接。 */
function withLinks(data: LegacyData = makeLegacyData()): LegacyData {
  const plane = (id: string) => data.plane.requirements.find((r) => r.id === id)!;
  const push = (id: number) => data.push.requirements.find((r) => r.id === id)!;
  plane('X001').prd_link = 'https://doc.weixin.qq.com/doc/w3_A?scode=one';
  plane('X002').prd_link = ' https://doc.weixin.qq.com/doc/w3_A?scode=two ';
  push(1).prd_url = 'https://docs.qq.com/doc/B';
  push(3).prd_url = 'https://docs.qq.com/doc/C/';
  push(5).prd_url = '需求仅设计了流程图';
  push(4).prd_url = 'https://docs.qq.com/doc/D';
  return data;
}

describe('外部 PRD 的状态推导', () => {
  it('取最靠后的 prd_status；都不参与时为草稿；已通过且全部已上线时为已上线', () => {
    expect(deriveExternalStatus([{ prdStatus: 'approved', stateKey: 'developing' }, { prdStatus: 'not-started', stateKey: 'collect' }])).toBe('approved');
    expect(deriveExternalStatus([{ prdStatus: 'submitted', stateKey: 'collect' }, { prdStatus: 'in-progress', stateKey: 'collect' }])).toBe('review');
    expect(deriveExternalStatus([{ prdStatus: 'not-needed', stateKey: 'launched' }, { prdStatus: null, stateKey: 'launched' }])).toBe('draft');
    expect(deriveExternalStatus([{ prdStatus: 'approved', stateKey: 'launched' }, { prdStatus: null, stateKey: 'launched' }])).toBe('launched');
  });
});

describe('导入计划：外部 PRD', () => {
  it('按规范化网址去重，每个网址一份外部 PRD；123plane 优先；不是网址、两边不一致、只被合并需求用到的写入报告', () => {
    const data = withLinks();
    const { rows, report } = buildImportPlan(data, reviewedMapping(data), OPTS);
    expect(report.problems).toEqual([]);
    const ext = rows.documents.filter((d) => d.source === 'external');
    expect(ext.map((d) => [d.number, d.title, d.externalUrl, d.externalUrlKey, d.externalProvider, d.status])).toEqual([
      [1, '批量下载', 'https://doc.weixin.qq.com/doc/w3_A?scode=one', 'https://doc.weixin.qq.com/doc/w3_A', 'wecom', 'approved'],
      [2, '离线下载', 'https://docs.qq.com/doc/C/', 'https://docs.qq.com/doc/C', 'tencent_docs', 'draft'],
    ]);
    const byKey = (legacyKey: string) => rows.requirements.find((r) => r.legacyKey === legacyKey)!;
    expect(byKey('X001').changeDocumentId).toBe(ext[0]!.id);
    expect(byKey('X002').changeDocumentId).toBe(ext[0]!.id);
    expect(byKey('push-3').changeDocumentId).toBe(ext[1]!.id);
    expect(byKey('push-5').changeDocumentId ?? null).toBeNull();
    expect(rows.products[0]!.documentSeq).toBe(2);
    expect(report.documents.external).toMatchObject({
      docs: 2,
      requirements: 3,
      shared: 1,
      statusCounts: { approved: 1, draft: 1 },
      nonUrl: [{ displayKey: 'PAN-5', source: 'push', value: '需求仅设计了流程图' }],
      mismatches: [{ displayKey: 'PAN-1', plane: 'https://doc.weixin.qq.com/doc/w3_A?scode=one', push: 'https://docs.qq.com/doc/B' }],
      mergedOnly: 1,
    });
    expect(report.documents.prdCheckChanges).toEqual([
      { displayKey: 'PAN-2', document: 'PAN-PRD-1', from: 'not_started', to: 'passed' },
      { displayKey: 'PAN-4', document: 'PAN-PRD-2', from: 'not_started', to: 'in_progress' },
    ]);
    expect(report.skipped.map((s) => s.what)).not.toContain('123plane 外部 PRD 链接');
    expect(rows.workflowVersions[0]!.body).toMatchObject({ checkItems: expect.arrayContaining([expect.objectContaining({ key: 'prd', auto: 'prd_status' })]) });
  });

  it('已挂 prd 系统页面的需求不再挂外部 PRD，写入报告；外部 PRD 编号排在 prd 页面之后', () => {
    const data = withLinks(withPrdPages());
    const { rows, report } = buildImportPlan(data, reviewedMapping(data), OPTS);
    expect(report.problems).toEqual([]);
    expect(rows.documents.map((d) => [d.number, d.source])).toEqual([
      [1, 'native'],
      [2, 'native'],
      [3, 'external'],
      [4, 'external'],
    ]);
    expect(report.documents.external.skippedNative).toEqual([{ displayKey: 'PAN-1', url: 'https://doc.weixin.qq.com/doc/w3_A?scode=one' }]);
    const shared = rows.documents.find((d) => d.externalUrlKey === 'https://doc.weixin.qq.com/doc/w3_A')!;
    expect(shared).toMatchObject({ title: '相册归类', externalUrl: 'https://doc.weixin.qq.com/doc/w3_A?scode=two', status: 'draft' });
    expect(rows.products[0]!.documentSeq).toBe(4);
  });
});
```

（第一例：X001 是 PAN-1、X002 是 PAN-2、push-3 是 PAN-4、push-5 是 PAN-5，与 `plan-requirements.test.ts` 的编号一致。X002 的 `prd_status` 为 not-started（对应草稿），共用文档取两者中较靠后的 X001 的 approved，定为已通过，X002 的「PRD」检查项由未开始改为通过；push 独有需求没有 `prd_status`，文档为草稿，检查项改为进行中。第二例里 X001 已挂 prd 页面，共用文档只剩 X002，标题取 X002、原文取 X002 的写法、状态为草稿。）

Run: `pnpm --filter @flower/migrate exec vitest run test/plan-external.test.ts`
Expected: FAIL，找不到 `../src/plan-external`。

- [ ] **Step 2: 实现**

新建 `packages/migrate/src/plan-external.ts`：

```ts
import { documentDisplayKey, type DocumentStatus, type ExternalProvider, normalizeExternalUrl } from '@flower/core';
import type { PlaneRequirement } from './legacy-types';
import { coverRequirement } from './plan-documents';
import type { PlanContext } from './plan-types';

/** 123plane prd_status → 外部 PRD 状态的候选；not-needed 不参与推导（设计决定「外部 PRD 迁移的状态推导」）。 */
export const PLANE_PRD_STATUS_TO_DOCUMENT: Record<string, 'draft' | 'review' | 'approved' | null> = {
  approved: 'approved',
  submitted: 'review',
  'in-progress': 'draft',
  'not-started': 'draft',
  'not-needed': null,
};
const RANK = { draft: 1, review: 2, approved: 3 } as const;

export function deriveExternalStatus(uses: Array<{ prdStatus: string | null; stateKey: string }>): DocumentStatus {
  let best = 0;
  for (const u of uses) {
    const s = u.prdStatus ? PLANE_PRD_STATUS_TO_DOCUMENT[u.prdStatus] : null;
    if (s) best = Math.max(best, RANK[s]);
  }
  const status: DocumentStatus = best === 3 ? 'approved' : best === 2 ? 'review' : 'draft';
  return status === 'approved' && uses.every((u) => u.stateKey === 'launched') ? 'launched' : status;
}

type Use = { requirementId: string; number: number; plane: PlaneRequirement | null; url: string; provider: ExternalProvider };

/**
 * 123plane prd_link 与 push prd_url → 外部 PRD：按规范化网址去重，每个网址一份，挂到所有用到它的需求上。
 * 一条需求两边都有时以 123plane 为准；已挂 prd 系统页面的需求不再挂外部 PRD。编号接在 prd 页面之后。
 */
export function buildExternalDocuments(ctx: PlanContext): void {
  const { rows, orgId, productId, data } = ctx;
  const ext = ctx.report.documents.external;
  const groups = new Map<string, Use[]>();
  for (const src of ctx.requirementSources) {
    const displayKey = `${ctx.opts.productKey}-${src.number}`;
    const rawPlane = src.plane?.prd_link?.trim() || null;
    const rawPush = src.push?.prd_url?.trim() || null;
    const plane = rawPlane ? normalizeExternalUrl(rawPlane) : null;
    const push = rawPush ? normalizeExternalUrl(rawPush) : null;
    if (rawPlane && !plane) ext.nonUrl.push({ displayKey, source: '123plane', value: rawPlane });
    if (rawPush && !push) ext.nonUrl.push({ displayKey, source: 'push', value: rawPush });
    if (plane && push && plane.key !== push.key) ext.mismatches.push({ displayKey, plane: plane.url, push: push.url });
    const chosen = plane ?? push;
    if (!chosen) continue;
    const prdStatus = src.plane?.prd_status ?? null;
    if (prdStatus && !(prdStatus in PLANE_PRD_STATUS_TO_DOCUMENT)) ctx.problem(`123plane PRD 状态「${prdStatus}」没有对应的外部 PRD 状态`);
    const req = rows.requirements.find((r) => r.id === src.id)!;
    if (req.changeDocumentId) {
      ext.skippedNative.push({ displayKey, url: chosen.url });
      continue;
    }
    const list = groups.get(chosen.key) ?? [];
    list.push({ requirementId: src.id, number: src.number, plane: src.plane, url: chosen.url, provider: chosen.provider });
    groups.set(chosen.key, list);
  }
  for (const p of data.push.requirements) {
    if (p.merged_into === null || !p.prd_url?.trim()) continue;
    const n = normalizeExternalUrl(p.prd_url);
    if (n && !groups.has(n.key)) ext.mergedOnly += 1;
  }

  let number = rows.documents.length;
  const ordered = [...groups.entries()].sort(([, a], [, b]) => Math.min(...a.map((u) => u.number)) - Math.min(...b.map((u) => u.number)));
  for (const [key, uses] of ordered) {
    uses.sort((a, b) => a.number - b.number);
    const reqs = uses.map((u) => rows.requirements.find((r) => r.id === u.requirementId)!);
    const first = reqs[0]!;
    const status = deriveExternalStatus(uses.map((u, i) => ({ prdStatus: u.plane?.prd_status ?? null, stateKey: reqs[i]!.stateKey })));
    number += 1;
    const id = ctx.id('document', `ext:${key}`);
    const createdAt = reqs.map((r) => r.createdAt ?? ctx.asOfTime).reduce((a, b) => (a < b ? a : b));
    rows.documents.push({
      id,
      orgId,
      productId,
      number,
      kind: 'change',
      source: 'external',
      title: first.title,
      ownerMemberId: first.ownerMemberId ?? null,
      templateId: null,
      status,
      currentRevisionId: null,
      externalUrl: uses[0]!.url,
      externalUrlKey: key,
      externalProvider: uses[0]!.provider,
      version: 1,
      legacyKey: `ext:${key}`,
      createdBy: null,
      createdAt,
      updatedAt: ctx.asOfTime,
    });
    const documentKey = documentDisplayKey(ctx.opts.productKey, number);
    for (const u of uses) coverRequirement(ctx, u.requirementId, id, status, documentKey);
    ext.docs += 1;
    ext.requirements += uses.length;
    if (uses.length > 1) ext.shared += 1;
    ext.statusCounts[status] = (ext.statusCounts[status] ?? 0) + 1;
  }
  rows.products[0]!.documentSeq = rows.documents.length;
}
```

`packages/migrate/src/plan.ts`：import 加 `import { buildExternalDocuments } from './plan-external';`；`buildPrdDocuments(ctx);` 之后加 `buildExternalDocuments(ctx);`；`report.skipped.push(…)` 里删去 `123plane 外部 PRD 链接`、`push 外部 PRD 链接` 两行；`sourceCounts` 加：

```ts
    'plane.prdLinks': plane.counts.prdLinks,
    'push.prdUrls': push.counts.prdUrls,
```

`packages/migrate/src/workflow-v1.ts`：`{ key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', defaultState: 'not_started' },` 改为 `{ key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status', defaultState: 'not_started' },`。

`packages/migrate/src/report.ts`：在 Task 15 加的「PRD 文档（prd 系统）」一节之后插入：

```ts
    '## 外部 PRD（123plane prd_link 与 push prd_url）',
    '',
    table(
      ['项', '数量'],
      [
        ['外部 PRD', r.documents.external.docs],
        ['挂上外部 PRD 的需求', r.documents.external.requirements],
        ['被多条需求共用的外部 PRD', r.documents.external.shared],
        ...Object.entries(r.documents.external.statusCounts).map(([s, n]): [string, number] => [`状态：${s}`, n]),
        ['只被 push 内已合并需求用到的链接（不建）', r.documents.external.mergedOnly],
      ],
    ),
    '### 不是网址的值（不建 PRD）',
    '',
    table(['需求', '来源', '原值'], r.documents.external.nonUrl.map((x) => [x.displayKey, x.source, x.value])),
    '### 两边网址不一致（以 123plane 为准）',
    '',
    table(['需求', '123plane', 'push'], r.documents.external.mismatches.map((x) => [x.displayKey, x.plane, x.push])),
    '### 已挂 prd 系统页面、未挂外部链接的需求',
    '',
    table(['需求', '外部网址'], r.documents.external.skippedNative.map((x) => [x.displayKey, x.url])),
    '## 「PRD」检查项改写（跟随所挂 PRD 的状态）',
    '',
    table(['需求', 'PRD', '原状态', '新状态'], r.documents.prdCheckChanges.map((x) => [x.displayKey, x.document, x.from, x.to])),
```

`docs/superpowers/specs/2026-09-28-flower-data-model-design.md` §7.2「PRD」下第二条 `123plane 的 prd_status 迁移为"PRD"检查项的手工状态，不附链接。` 改为 `123plane 的 prd_status 迁移为"PRD"检查项的状态；需求挂上 PRD（prd 系统页面或外部链接）后，该项改为跟随 PRD 状态，改写前后不同的列入对账报告（P2-A）。`

- [ ] **Step 3: 运行测试**

Run: `pnpm --filter @flower/migrate test && pnpm --filter @flower/migrate typecheck`
Expected: 全部通过。

- [ ] **Step 4: 用只读副本试跑（不写库）**

Run: `pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --dry-run`
Expected: 输出「试跑完成，未写入数据库。」；`.local-data/reports/migration-report.md` 的「外部 PRD」一节约 192 份、约 242 条需求、两边不一致约 6 条，「不是网址」约 6 条（模拟值，以报告为准）；「PRD 文档」一节页面 11、修订 104 加上「迁移时的当前内容」修订（若有）、附件 98、评论 3、需求关联 1、附件文件缺失「未提供导出目录」。结论为 0 个问题时继续；有问题时按报告修正对照表或规则后重跑，不进入 Task 17。只在任务报告里写数量，不写标题与网址。

- [ ] **Step 5: 提交**

```bash
git add packages/migrate docs/superpowers/specs/2026-09-28-flower-data-model-design.md
git commit -m "feat(migrate): 123plane 与 push 的 PRD 链接导入为外部 PRD，「PRD」检查项跟随 PRD 状态

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 17: 用户检查点：确认对账报告；导出 prd 附件文件（只读，单独确认）；重导 pan123

**Files:**
- 不改代码。读写 `.local-data/`（不提交）与本地开发库。

**Interfaces:**
- Consumes: Task 15、16 的 `legacy import`（`--uploads`、`--storage`、`--dry-run`、`--replace`）与已有的 `legacy rejoin`

- [ ] **Step 1: 迁移本地开发库的表结构，并试跑**

```bash
pnpm db:migrate
pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --dry-run
```

Expected: `pnpm db:migrate` 应用 `0009`、`0010` 两个迁移并把 `flower_app` 的密码改回 `apps/web/.env.local` 的值；试跑输出「试跑完成，未写入数据库。」，报告 0 个问题。

- [ ] **Step 2: STOP——向控制方汇报，等待用户确认**

执行代理在这里停下，把下面这些数量（只写数量，不写姓名、标题、网址）交给控制方，由控制方转给用户：

1. prd 系统：页面、修订（其中「迁移时的当前内容」几条）、附件、内嵌图片、评论、需求关联；已删除页面跳过几份；外链图片与失效的相对路径图片各几处。
2. 外部 PRD：份数、挂上的需求数、被多条需求共用的份数、状态分布、不是网址的值几条、两边网址不一致几条、已挂 prd 页面而未挂外部链接几条、只被已合并需求用到的链接几个。
3. 「PRD」检查项改写：总条数，以及按「原状态 → 新状态」分组的条数。
4. 附件文件：报告显示「未提供导出目录」，98 个旧附件文件需要从服务器导出，否则这些图片在 Flower 里显示不出来（内嵌图片已从正文抽出，不受影响）。

请用户分别答复三件事，任何一件没有明确答复都不往下执行：

- (a) 对账报告的规则是否接受（外部 PRD 的状态推导、标题取需求标题、「PRD」检查项改写）。不接受时按用户意见改 Task 15 / 16 的规则与测试，重新试跑，回到本步骤。
- (b) 是否从服务器 `prd_uploads` 卷只读导出附件文件。这一步要连服务器，**必须得到用户单独、明确的同意**；用户也可以选择自己执行，或者不导出。
- (c) 是否用 `--replace` 重导本地开发库的 pan123（会删除 pan123 的全部数据后重建，测试账号之后用 `legacy rejoin` 恢复）。

- [ ] **Step 3（仅在 Step 2 (b) 得到同意后）：只读导出附件文件**

由用户提供服务器的 SSH 登录方式（下面写作 `<服务器>`）；执行代理不猜测、不保存任何凭据。先只读列出卷名，再以只读方式挂载打包：

```bash
ssh <服务器> 'docker volume ls --format "{{.Name}}" | grep prd_uploads'
mkdir -p .local-data/prd_uploads
ssh <服务器> 'docker run --rm -v <上一步列出的卷名>:/data:ro alpine tar -C /data -cf - .' | tar -C .local-data/prd_uploads -xf -
ls .local-data/prd_uploads | wc -l
```

Expected: 文件数约 99（含已删除页面的 1 个）。服务器上的卷以 `:ro` 挂载，只读；不在服务器上执行其他命令。

- [ ] **Step 4（仅在 Step 2 (c) 得到同意后）：重导 pan123 并恢复测试账号**

```bash
pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --owner-email <用户的账号邮箱> --uploads "$PWD/.local-data/prd_uploads" --storage "$PWD/apps/web/.flower-storage" --replace
pnpm --filter @flower/migrate legacy rejoin --org-slug pan123 --owner-email <用户的账号邮箱> --accounts "$PWD/.local-data/test-accounts.json"
```

Expected: 输出「已写入组织 pan123：需求 N 条。」与「附件文件：写入 X 个，缺失 Y 个。」（没有导出时 Y = 98）；`rejoin` 输出重新加入的账号数。用只读查询核对数量：

```bash
docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select source, status, count(*) from documents d join organizations o on o.id = d.org_id where o.slug = 'pan123' group by 1, 2 order by 1, 2" -c "select count(*) from requirements r join organizations o on o.id = r.org_id where o.slug = 'pan123' and r.change_document_id is not null" -c "select count(*) from document_revisions v join organizations o on o.id = v.org_id where o.slug = 'pan123'" -c "select count(*) from attachments a join organizations o on o.id = a.org_id where o.slug = 'pan123'"
```

Expected: 与对账报告一致。

---
### Task 18: 真实数据复验、验证记录、交接文档与协作日志

**Files:**
- Create: `docs/p2a-validation.md`
- Modify: `docs/handoff.md`、`docs/agent-log.md`、`CLAUDE.md`

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

Expected: 全部通过（`editor-perf.spec.ts` 在未设置 `EDITOR_BENCH` 时跳过，由 Step 2 单独跑）；记下 core、web、migrate 单测数与 e2e 用例数。最后一条把 `flower_app` 密码改回开发值。

- [ ] **Step 2: 真实数据上的大文档复测**

Run: `EDITOR_BENCH=1 BENCH_FILES="$PWD/.local-data/perf/largest-prd.md,$PWD/.local-data/perf/largest-prd-noimg.md" pnpm --filter @flower/web e2e editor-perf.spec.ts`
Expected: 通过；把数字与 Task 1 的基线对比，差异超过 20% 时在验证记录里写明原因。

`pnpm dev` 启动后，以测试账号登录，打开 pan123 中正文最长的 Flower 内 PRD（按 `select number from documents … order by length((select snapshot->>'markdown' from document_revisions where id = current_revision_id)) desc limit 1` 只读查出编号），在浏览器开发者工具里记录从导航到正文渲染完成的时间（3 次取中位数），在正文末尾输入 30 个字确认没有卡顿。

- [ ] **Step 3: pan123 界面复验（1440px 与 760px）**

两种宽度下逐项检查，并确认页面本身不横向滚动：

1. 文档列表：总数与对账报告一致；按状态、来源、负责人筛选；搜索编号与标题。
2. 一份 Flower 内 PRD（迁移的）：正文、图片（导出了附件时显示，未导出时显示为破图并在记录里注明）、修订记录与对比、迁移的评论显示「未定位」。
3. 一份外部 PRD：链接卡片、状态、覆盖的多条需求、「转为 Flower 文档」入口（只看，不在真实数据上转换）。
4. 一条挂了外部 PRD 的需求：PRD 卡片、「PRD」检查项显示「跟随 PRD」、不能手改。
5. 评审页的「PRD 评审」区块（真实数据里没有评审中的 PRD 时显示「没有评审中的 PRD」）；工作台。
6. 文档模板设置页：预置模板。

只记录现象与数量，不记录标题、姓名、网址。

- [ ] **Step 4: 写验证记录**

新建 `docs/p2a-validation.md`，结构与 `docs/p1b-validation.md` 一致，包含：

1. 迁移对账汇总（Task 17 的数量：prd 页面 / 修订 / 附件 / 内嵌图片 / 评论 / 需求关联、外部 PRD 份数与状态分布、两边网址不一致与不是网址的条数、「PRD」检查项改写条数、附件文件写入与缺失数）。
2. 大文档性能：Task 1 基线表、Step 2 的复测表与页面实测中位数、采用整篇编辑器还是懒加载。
3. 自动化测试数量（Step 1）。
4. 界面复验结果（Step 3，每项「通过 / 问题与处理」）。
5. 人工验收清单（供用户试用）：新建 Flower 文档并写正文、自动保存与两个窗口冲突、对比与恢复、划词评论与已失效、外部 PRD 转为 Flower 文档的三种方式、需求挂 PRD 后「PRD」检查项联动、PRD 评审签字与等我签字、模板必填小节、只读成员只能评论。

- [ ] **Step 5: 更新交接文档、协作日志与命令说明**

`docs/handoff.md`：

1. 「关键文档」表加两行：`docs/superpowers/specs/2026-10-08-flower-p2a-change-prd-design.md`（P2-A 设计）、`docs/superpowers/plans/2026-10-08-flower-p2a-change-prd.md`（P2-A 计划），以及 `docs/p2a-validation.md`。
2. 「当前进度」加一条「P2-A 变更 PRD：已完成，待合并」，写清：Flower 内 PRD 与外部 PRD、修订与对比、划词评论、模板、图片附件（`FLOWER_STORAGE_DIR`）、三种导入、「PRD」检查项跟随 PRD 状态、迁移结果（数量）。
3. 「下一步」改为：合并 P2-A；用户按 `docs/p2a-validation.md` 第 5 节验收；规划 P2-B（模块文档、影响声明、合入、双链），并列出本计划「留给 P2-B」一行的内容。
4. 「生产数据副本」一节加 `prd_uploads/`（导出的附件文件，若已导出）与 `perf/`（性能测量用的旧 PRD 正文）。

`docs/agent-log.md`「记录」最上面加一条（格式按文件头）：

```
### 2026-10-XX · 本地 · P2-A 变更 PRD
- 分支 / PR：`feat/p2a-change-prd`
- 做了什么：
  - 数据模型：documents、document_revisions、document_templates、attachments（RLS），products.document_seq，requirements.change_document_id 外键。
  - Flower 内 PRD（BlockNote，自动保存与乐观锁，同一作者 5 分钟内合并修订，按小节对比与恢复，划词评论与已失效标记）与外部 PRD（链接、状态、覆盖需求、会签、评论）；三种导入；模板与必填小节；图片附件存本地卷。
  - 「PRD」检查项改为作用于需求、跟随 PRD 状态；PRD 上的会签结果覆盖的需求共享；等我签字与 PRD 评审表包含评审中的 PRD。
  - 迁移：prd 系统页面、修订、附件、评论；123plane 与 push 的 PRD 链接导入为外部 PRD。
- 怎么验证的：（Step 1 的测试数；Task 17 的对账数量；Step 2、3 的结论）
- 留给对方：（没有就写"无"）
```

`CLAUDE.md`：「首次开发」一段末尾加一句：`PRD 图片附件默认存在 apps/web/.flower-storage/（已忽略），可用 FLOWER_STORAGE_DIR 改到别处；迁移导入时用 --storage 指向同一个目录。`

- [ ] **Step 6: 提交**

```bash
git add docs/p2a-validation.md docs/handoff.md docs/agent-log.md CLAUDE.md
git commit -m "docs: P2-A 真实数据验证记录、交接进度与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 与代码或数据的冲突

写计划时对照代码与只读数据发现的、与设计文档不一致之处，以及本计划的处理：

| 设计说法 | 实际情况 | 本计划的处理 |
|---|---|---|
| 设计 §3「`documents` 增加以下字段」，即假定 P2 的表已存在 | `schema.ts` 里没有 `documents`、`document_revisions`、`document_templates`、`attachments`，`requirements.change_document_id` 没有外键（只有 `comments` 已支持 `target_type = document`） | Task 2 新建四张表、开启 RLS，补外键 |
| 上位文档 §3.1 `scope: document` + `auto: 'prd_status'`；现有校验 `workflow-schema.ts:89` 要求自动同步项必须作用于 PRD，流程编辑页也只在「作用于 PRD」时显示勾选框 | 设计 §2 要求覆盖的每条需求同步、未挂 PRD 的需求手工维护，结果只能存在需求上；pan123 流程 v1 的「PRD」项是作用于需求、没有 `auto` | Task 7 改为「作用于需求的普通检查项 + auto」，同步改校验、测试、流程编辑页与上位文档；Task 16 给 v1 加 `auto` |
| 设计 §2、§7「最大的旧 PRD（约 8 万字以上）」 | 最大页面 785,744 字符中约 77 万是 6 张 base64 内嵌图片，去掉后 15,977 字符；11 份页面正文都不到 2.1 万字符 | Task 1 用合成文档覆盖 8 万字档位，同时测真实页面的两种形态；内嵌图片在迁移与保存时一律抽成附件 |
| 设计 §6「114 条修订、99 个附件、6 条评论」 | 这是包括 7 份已删除页面在内的总数；11 份未删除页面下为 104 / 98 / 3 | 只导入未删除页面下的内容，其余计入对账报告「跳过」 |
| 设计 §6「push `prd_url`：115 条，105 个不同网址」 | 其中 7 条不是网址（是一段文字），4 条属于 push 内已合并的需求 | 不是网址的写入报告不建 PRD；只被已合并需求用到的链接计数后跳过 |
| 设计 §2「编辑权限」一行「只读成员与只读 Token 不能修改，但可以评论（沿用 P1）」字面上可读成只读 Token 也能评论 | 设计 §4「只读 Token 一律不能写」，上位文档 §2.3 与 P1 规定只读 Token 不能签字、评论、标记已读 | 按 §4 与 P1：只读成员可以评论，只读 Token 不能评论（`addDocumentComment` 显式拒绝，有测试） |
| 设计未规定外部 PRD 的标题 | 旧数据只有链接没有标题 | 取所挂编号最小的需求标题（设计决定表「外部链接迁移规则」） |
| 设计 §3 修订合并「同一作者 5 分钟内」、网址唯一性 | 上位文档 §5 的 `document_revisions` 没有「最后保存时间」，`documents` 没有存规范化网址的列 | 增加 `document_revisions.updated_at` 与 `documents.external_url_key`（唯一索引），在 Task 2 一并建 |

## P2-A 完成标准

- Task 1 的结论写进「设计决定」，大文档性能用例在采用的模式下通过。
- `pnpm test`、`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm --filter @flower/web e2e`、`./scripts/smoke.sh` 全部通过。
- 设计 §7 列出的内容都有单元或端到端测试：权限（编辑、只读、只读 Token）、乐观锁冲突、修订合并与恢复、两版对比、「PRD」检查项随状态联动、外部 PRD 的全部流程、三种导入、必填小节校验、划词评论与失效标记。
- pan123 按 Task 17 得到用户确认后重导，Task 18 在 1440px 与 760px 两种宽度下复验，验证记录、交接文档与协作日志已更新。
