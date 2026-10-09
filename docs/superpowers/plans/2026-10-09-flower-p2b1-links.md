# Flower P2-B1 双链与反向链接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在需求描述、PRD 正文、评论里用 `[[ ]]` 引用需求、PRD、PRD 小节、任务、迭代与结构树节点（输入 `[[` 弹出补全，保存后显示为带当前标题与状态的链接卡）；需求、PRD、任务、迭代详情页显示「被引用」；任务按产品编号（`PAN-T-12`）；PRD 编辑器内高亮未解决的评论锚点并与评论区联动；PRD 的未读评论进入工作台。

**Architecture:** 新增租户表 `entity_links`（RLS），`tasks.number` + `products.task_seq`（新迁移按创建时间补号），迭代 `(product_id, name)` 部分唯一索引。业务逻辑在 `packages/core/src/links/`：`syntax.ts` 是浏览器安全的纯函数（解析、分类、规范写法、上下文、编辑器文本块定位），以 `@flower/core/links` 导出；`links.ts` 在来源对象的写事务里重建链接、在目标新建或改名时接上悬空链接；`cards.ts`、`backlinks.ts`、`search.ts` 是读取（链接卡、「被引用」、`[[` 补全）。需求描述与评论的链接卡随原接口返回，PRD 正文的链接卡单独取（不动 PRD 详情缓存）。页面：纯文本输入框加补全弹层，显示时渲染链接卡；PRD 编辑器用 BlockNote `SuggestionMenuController`（触发符 `[[`）做补全，用一个只读 ProseMirror 装饰插件显示链接卡与评论锚点（不改正文、不改 Markdown 序列化、不触发自动保存）；新增只读的任务详情页。迁移工具导入任务时按同一规则编号。

**Tech Stack:** Postgres 17、drizzle-orm、Hono、Next.js 16、TanStack Query、shadcn/ui、BlockNote 0.55（`SuggestionMenuController`、`createExtension`）、`prosemirror-state` 1.4.4 与 `prosemirror-view` 1.42.6（与 BlockNote 依赖的版本相同，新增为 web 直接依赖）、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-09-flower-p2b1-links-design.md`（用户 2026-10-09 确认，本计划的约束来源）；上位文档 `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§4 需求与任务、§6.4 双向链接）与 P2-A 设计 `docs/superpowers/specs/2026-10-08-flower-p2a-change-prd-design.md`。逐条决定见下方「设计决定」，与代码不一致之处见文末「与代码或数据的冲突」。

## Global Constraints

- 真实数据只在本地开发库的组织 pan123 上操作：数量核对一律用只读查询 `docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select …"`；应用迁移用 `pnpm db:migrate`；`--replace` 重导只能在 Task 15 的用户检查点得到用户明确同意后执行。不连接、不操作任何服务器。
- `.local-data/` 存放生产数据副本与对账报告（含员工个人信息），不提交；计划、验证记录、提交信息只写数量，不写姓名、邮箱、标题或正文。测试与文档示例只用虚构内容和 `@example.com` 邮箱。
- 执行代理不得对开发库运行 `pnpm dev`。界面检查一律写成 Playwright 端到端用例（端到端用独立的 `flower_e2e` 库与 3100 端口）；真实数据上的最终界面复验由控制方完成（Task 16 的 STOP 步骤）。
- 任务补号是 SQL 迁移（Task 2）；迁移工具导入任务时按同一规则分配编号（Task 3）。迭代 `(product_id, name)` 唯一约束写在迁移里（Task 2）。
- 新增租户表必须带 `org_id`，并在新的自定义迁移 `0012_p2b1_rls.sql` 里开启 RLS（参照 `0002_rls.sql` 与 `0010_p2a_rls.sql`）。执行中如发现还要改表结构，停下来报告。
- 业务逻辑只写在 `packages/core`，服务函数签名 `(db, actor, input)`（实体 id 作为第三个参数的现有写法照旧），一律 `async`，在 `withOrg(db, actor.orgId, …)` 中读写；写操作同事务调用 `recordEvent`，修改类事件 payload 带 `changes: [{field, old, new}]`。链接重建与悬空链接接上是来源或目标写操作的一部分，跟随该写操作已有的事件，不另记事件。`withSystem` 只用于登录、成员关系查找、Token 认证、邀请接受。
- 链接的解析与写入随来源对象的写操作进行，权限沿用来源对象的规则（不额外检查对目标的权限）；显示链接卡与「被引用」时按查看者的产品权限过滤（设计 §5）。
- 面向用户的文案与错误信息用中文，错误通过 `AppError(code, message, details?)` 抛出。`apps/web/src/server/routes` 只做参数校验和调用服务。
- 页面是客户端组件，只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`、`@flower/core/markdown` 和本计划新增的 `@flower/core/links`（`syntax.ts` 不导入任何其他模块）。纯逻辑放 `apps/web/src/features/**/model.ts` 并写 Vitest 单测。
- 接口数据 → 表单初值：不要 `useEffect` + `setState`；用渲染期间调整（参照 `apps/web/src/app/(app)/[org]/settings/general/page.tsx`）或换 `key` 重新挂载。编辑器只在挂载时读取初始正文。
- **P2-A 编辑器与自动保存的不变量**（`apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`），本计划改这个文件和编辑器时一条都不能破坏，相关端到端用例（`documents-editor.spec.ts`、`documents-revisions.spec.ts`、`documents-import.spec.ts`）必须原样通过：
  - 保存返回 409 时：`blocked` 置为 true、清掉已排上的定时器，之后 `flush` 一开头就返回，不再发保存请求；冲突提示与只读状态保持到重新加载。
  - 卸载时补发的保存只用它自己的返回结果写缓存（`setQueryData` 写入的正文与版本号来自这次保存的响应），不读取组件状态。
  - 本页改标题后，只有返回的版本号恰好等于当前版本号 + 1 时才采用（`onRenamed`），否则留给下一次保存报冲突。
  - 编辑器只读时（只读成员、冲突后）不自动保存（`onDirty` 在 `!editable || blocked` 时直接返回）。
  - 正文里的 `data:` 图片先上传为附件、换成附件网址，再保存（`uploadDataImages` 在读取 `baseVersion` 之前完成）。
  - 非 409 的保存失败自动重试一次（`retried`），重试期间不显示错误。
  - 本计划只新增：只带元数据、不改文档的装饰事务（不触发 `onChange`，因而不触发自动保存）、`[[` 补全插入的文字（与用户输入一样走 `onDirty`）、保存成功后额外失效链接查询（`linkKeys`），以及点击链接卡与评论锚点的处理。
- 每个修改操作失败时用户都能看到原因：默认由 `useApiMutation` 弹出错误提示；对话框和内联表单用 `silentError: true` + `<FormError error={mutation.error} />`。页面加载失败用 `components/load-error.tsx` 的 `QueryError`。
- 复用已有的共享件：`QueryError`、`FormError`、`PageHeader`、`EmptyState`、`MemberPicker`、`formatDateTime`；e2e `helpers.ts`（`ok`、`json`、`createProduct`、`createRequirement`、`createIteration`、`createTask`、`createDocument`、`presetTemplateId`、`acceptInvite`、`readToken`、`login`、`setupInstance`、`FAIL_500`、`expectNoPageOverflow`）。不在文件之间复制逻辑块。
- 每个 web 任务的验证步骤都要跑 `pnpm --filter @flower/web lint --max-warnings 0`。
- 视觉沿用 P0-B：表格行高 40px（`h-10`）、隔行底色 `even:bg-zebra`、编号与日期用 `font-mono`、卡片圆角 6px、按钮与输入框圆角 4px。
- 布局：页面本身不出现横向滚动；新页面与新区块有 Playwright 守护用例，在 1440 与 760 两个宽度下断言（`expectNoPageOverflow`）。
- 端到端测试：每个 spec 在 `beforeEach` 或用例开头调用 `resetDatabase()`；不为迁就定位器修改应用或共享组件代码；断言 `toHaveCount(0)` 之前先断言页面内容已经渲染；断言由 5xx 触发的「重试」时加 `{ timeout: 15_000 }`。改动共享组件或页面结构的任务，要在同一任务里改好受影响的现有 spec，不削弱原有断言。
- `pnpm test` 和端到端测试会把 `flower_app` 的密码改为 `flower_app_test`；之后要运行迁移导入或 `rejoin`，先执行 `pnpm db:migrate`。
- 每个 commit message 末尾加一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（本计划每条提交命令都已写好）；实际执行提交的若不是 Claude Opus 5.5，把这一行换成实际模型的名字。

## 设计决定

数量均为 2026-10-09 对本地开发库（组织 pan123）的只读查询所得，查询形如 `docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select count(*) from tasks t join organizations o on o.id = t.org_id where o.slug = 'pan123'"`。

| 项 | 决定 | 依据 |
|---|---|---|
| 链接语法的解析 | `[[` 与 `]]` 之间不含 `[`、`]`、换行；第一个 `|` 之前是目标、之后是显示文字（两边去空白，显示文字为空时视为没有）；目标为空的忽略。围栏代码块（``` 或 ~~~，不闭合时到文末）与同一行内成对反引号之间的 `[[ ]]` 不解析；紧跟在 `\` 后面的 `[[` 不解析。目标的分类顺序：`KEY-PRD-n(#小节)` → `KEY-T-n` → `KEY-n` → `(KEY/)迭代:名称`（`:` 与全角 `：` 都接受）→ 其余一律按路径（`/` 分段、去空白、丢空段）。`KEY` 为字母开头的 2–10 位字母或数字，大小写不敏感 | 设计 §3；产品编号前缀的格式取自 `createProduct`（`PRODUCT_KEY_RE`） |
| `target_text` 存规范写法 | `target_text` 存规范写法而不是逐字原文：编号转大写（`PAN-12`、`PAN-PRD-12#需求说明`、`PAN-T-12`），迭代与节点补上产品前缀（`PAN/迭代:名称`、`PAN/会员/支付`），小节标题保留原样。悬空链接按这个写法与新建或改名的目标逐字匹配；页面渲染时用同一个纯函数（`canonicalWikiText`）算出写法去找链接卡 | 设计 §4 写「原文」，但不带产品前缀的迭代与节点写法依赖来源所在产品，只存原文无法在新建目标时接上，也无法用 `(org_id, target_text)` 索引查找 |
| 大小写规范的范围 | 「保存时规范为大写」只作用于 `target_text`；需求描述、PRD 正文、评论原文按输入保存，不改写。补全插入的写法本身就是大写 | 改写 PRD 正文会让编辑器内容与服务端不一致，触发乐观锁冲突 |
| 路径首段是否是产品前缀 | 至少两段、且首段与产品编号前缀同形（大写字母开头、2–10 位大写字母或数字）时视为产品前缀；否则按来源所在产品的路径。服务端解析时如果首段形似前缀但组织里没有这个产品，再按来源产品内的完整路径找一次（如名为「API」的业务域）；这种情况下 `target_text` 仍是 `API/…`，悬空时不会自动接上 | 设计 §3「跨产品写 `[[PAN/业务域/…]]`」 |
| 旧编号 | `KEY-n` 在该产品下找不到时，用原文到 `entity_aliases` 查（如 `push-12`）；只有一段的路径也先查别名（如 `X20260312012`），查到就是需求链接。pan123 有 1015 个别名 | 设计 §3「旧编号通过 `entity_aliases` 解析」 |
| 迭代的解析 | 先找来源产品（或写明的前缀产品）中未删除、同名的常规迭代；没有时找同名的专项（未删除，按创建时间取第一个）。唯一约束为 `(product_id, name) where deleted_at is null` 的部分唯一索引：已删除的迭代不占名字；专项的 `product_id` 为空，不受约束。新建与改名重名时报「同一产品内已有同名迭代」（409）。pan123 有迭代 13 个（常规 11、专项 2），按 `(product_id, name)` 去重后仍为 13，没有已删除的迭代；迁移工具在试跑时检查常规迭代重名并写入问题列表 | 设计 §4；控制方已核对 13/13 不重名 |
| 同一来源的重复引用 | 同一来源、同一 `source_section`、同一 `target_text` 只记一条，上下文取第一次出现处。每次保存「先删后建」时，已存在的组合保留原来的 `created_at`，所以「被引用」里的时间是这处引用第一次出现的时间，而不是最后一次保存的时间 | 设计 §4「每次删除该来源的全部链接再重建」；§6「被引用」显示时间 |
| 引用处的上下文 | 从链接向前、向后找到最近的句末符号（`。！？!?；;` 或换行），取这一句（带句末标点）并去首尾空白；超过 120 字时以链接为中心截取 120 字，截掉的一端加「…」 | 设计 §4「引用处所在的一句，截断到 120 字」 |
| 来源小节 | PRD 正文中的链接，`source_section` 为它所在小节的原始标题（按 `splitSections` 切分，1–3 级标题，第一个标题之前为空）；需求描述与评论为空 | 设计 §4 |
| 只重建 wikilink | 「先删后建」只删除 `origin = 'wikilink'` 的行，给后续阶段的 `system` / `manual` 链接留出位置 | 设计 §4 |
| 悬空链接接上的时机 | 新建需求、PRD（同时接上指向它小节的链接）、任务、迭代（常规迭代匹配 `KEY/迭代:名称`；专项匹配组织内每个产品前缀的同名写法），迭代改名，结构树节点新建、改名、移动（改名与移动会改变整棵子树的路径，子树内每个节点都按新路径接一次）。只接 `target_id` 为空的行，已接上的链接不受改名影响 | 设计 §4「新建……以及改迭代名称、节点名称时补上」；移动同样改变节点名称路径 |
| 链接卡的状态 | `ok`；`missing`（目标不存在，`target_id` 为空）；`deleted`（需求或 PRD 已软删除、迭代已删除、任务或节点已不存在）；`canceled`（需求所在状态的类别为 `canceled`、PRD 为 `discarded`、迭代为 `canceled`、节点为 `deprecated`）；`section_missing`（PRD 当前正文里找不到该小节：标题按 `normalizeHeading` 去编号与空白后比较，同名取第一个；外部 PRD 没有正文，指向它小节的链接一律为失效）；`hidden`（目标所在产品对查看者不可见）。除 `ok` 与 `hidden` 外显示为灰色并附说明（目标不存在 / 已删除 / 已取消 / 小节已失效） | 设计 §4「断链」、§6「链接卡」 |
| 无权限时的链接卡 | `hidden` 只返回编号（需求、PRD、任务为当前编号，迭代与节点为链接里写的文字），标题、状态、跳转地址都为空，页面上显示为不可点击的编号；目标不存在时同样不返回任何目标信息。专项迭代对「至少能看到一个产品」的人可见（与迭代列表规则相同） | 设计 §5 |
| 链接卡的跳转 | 需求 → `/{org}/requirements/PAN-12`；PRD → `/{org}/documents/PAN-PRD-12`，指向小节时加 `?section=小节`，详情页编辑器渲染后滚动到第一个归一化标题相同的小节；任务 → 新增的任务详情页 `/{org}/tasks/PAN-T-12`；迭代 → `/{org}/iterations/{id}`；节点 → 需求列表按该节点筛选 `/{org}/requirements?product=PAN&node={id}`（节点没有详情页） | 设计 §6 |
| 任务详情页 | 新增只读页面：编号、标题、状态、负责人、开始与工期、进度、需求、迭代、说明，以及「被引用」区块；修改仍在迭代甘特页签里进行（页面给出链接）。甘特表与人员负载里的任务编号链接到这个页面 | 设计 §2、§6 要求「任务详情」显示编号与「被引用」，现有代码没有任务详情页 |
| 任务编号 | 显示为 `{产品key}-T-{n}`。新建时由 `products.task_seq` 以 `update … returning` 分配（与需求、文档编号相同做法）；删除的任务编号不复用。补号迁移与迁移工具使用同一顺序：同一产品内按 `created_at`、相同时按 `id` 升序（Postgres 的 uuid 比较与小写十六进制字符串比较顺序一致）。pan123 只有产品 PAN，任务 377 个，只有 75 个不同的创建时间，所以需要按 id 决定先后；补号后 `task_seq` 应为 377 | 设计 §4；只读核对的数量 |
| 「被引用」 | 只列 `origin = 'wikilink'` 的链接；按来源对象分组（评论归到它所在的需求或 PRD），每条显示来源方式（需求描述 / PRD 的「小节」/ 评论）、上下文与时间；组与条目按时间倒序。不列对象引用自己（如需求描述或需求评论里写了这条需求本身）；来源对象已删除，或查看者看不到来源所在产品时不列 | 设计 §6、§5 |
| `[[` 补全搜索 | 需要来源产品的查看权限；只在查看者能看到的产品里搜。按编号前缀（编号以输入开头，大小写不敏感，如 `PAN-1`、`pan-prd`、`PAN-T-`；纯数字时等于编号）或标题关键词（不区分大小写的包含匹配；任务另含别名，迭代与节点为名称）搜索；每类最多 6 条，依次为需求、PRD、任务、迭代、节点，需求与 PRD 本产品优先；查询为空时只给本产品最近更新的需求与 PRD。插入写法：同产品的迭代与节点不带前缀，其他产品带 `KEY/`，专项写 `迭代:名称`。名称含 `[`、`]`、`|`（节点另含 `/`）的迭代、节点、小节写不进 `[[ ]]`，不出现在补全里（pan123 为 0 个）；不为此新增名称校验 | 设计 §6「补全」 |
| 选中 PRD 后选小节 | 选中 PRD 不立即闭合，而是把查询改为 `PAN-PRD-12#`，补全列表换成「整篇」（插入 `[[PAN-PRD-12]]`）加该 PRD 当前正文的小节（插入 `[[PAN-PRD-12#归一化标题]]`，同名小节只列第一个）；继续输入可以按小节标题筛选 | 设计 §6「选中 PRD 后可以继续选它的小节」 |
| 补全弹层 | 纯文本输入框：输入框下方的列表（`role="listbox"`，名称「链接补全」），上下键选择、回车插入、Esc 关闭、输入法组字时回车不插入、失去焦点时关闭。PRD 编辑器：BlockNote `SuggestionMenuController`（`triggerCharacter="[["`，0.55 支持多字符触发符），选中后用 `insertInlineContent(…, { updateSelection: true })` 插入；选中 PRD 时用 `SuggestionMenu.openSuggestionMenu('[[')` 重新打开并写入 `PAN-PRD-12#` | 设计 §6 |
| PRD 编辑器里的链接显示 | 不改 BlockNote schema、不改 Markdown 序列化：正文里的 `[[ ]]` 仍是普通文字，由装饰插件加样式，并在其后放一个不可编辑的链接卡挂件（标题、状态、说明写在 `data-label`，由 CSS `::after` 显示，不进入 DOM 文本，划词评论读取前后文时不会读到）；点击挂件由编辑区的点击处理用 `router.push` 跳转。显示数据通过只带元数据的事务推给插件，不改文档，不触发 `onChange` 与自动保存；文档变化时插件按新文档重画 | 设计 §6「链接卡」；P2-A 的 Markdown 是唯一数据源 |
| 编辑器依赖 | web 新增直接依赖 `prosemirror-state@1.4.4`、`prosemirror-view@1.42.6`，与 BlockNote 0.55 解析到的版本完全相同，pnpm 复用同一份包，插件实例与编辑器使用同一套类 | 装饰插件需要 `Plugin`、`PluginKey`、`Decoration`；两份不同版本的 prosemirror 包同时存在会导致插件失效 |
| `\[[` 转义在 PRD 正文中 | 解析器按设计处理 `\[[`；但 BlockNote 把 Markdown 解析为块时会吃掉反斜杠，PRD 正文保存一次后 `\[[` 变成 `[[`。PRD 正文里需要写字面上的 `[[` 时用行内代码 | BlockNote 0.55 `markdownToHtml` 的转义处理（P2-A 已有的有损转换） |
| 评论锚点高亮 | 只高亮顶层、`anchorState = 'ok'`、未解决的划词评论；按与服务端 `locateQuote` 相同的比较方式（去空白与 Markdown 符号）和前后文打分在编辑器文档里定位，正文变化时重新定位（改掉原文后高亮消失，保存后服务端会标为已失效）。点击高亮：评论区滚动到该条（`scrollIntoView`，居中）并以 `aria-current="true"` 与底色标出，同一条再点一次仍会滚动；编辑器里对应高亮加深。评论区仍在编辑器下方（窄屏与宽屏相同），不调整布局 | 设计 §6「评论锚点高亮」；现有页面的评论区在正文下方 |
| PRD 未读评论的范围 | 我负责的 PRD（`owner_member_id`），或我在上面发过评论的 PRD；计入别人发的、我没读过的评论（作者为空的也计入）；已删除的 PRD 与看不到的产品不计。需求的规则保持现状（只看我负责的需求） | 设计 §6 写「沿用需求的规则：我负责的，或我参与过评论的」，但现有需求规则只有「我负责的」（见文末冲突）。PRD 按设计写明的规则实现，需求规则是否同步扩大留给用户决定 |
| 已读标记 | 打开 PRD 详情时（评论区挂载时）把该 PRD 的全部评论标为已读，与需求详情相同；只读 Token 不能标记已读（返回 403，页面静默忽略） | 设计 §6；P1 的规则 |
| 评论的修改 | 现有代码没有修改评论的功能，本计划只在新建评论时写链接；以后加修改评论时调用同一个 `syncSourceLinks` | 设计 §4「评论新建或修改」（见文末冲突） |
| 旧数据 | 不回填。pan123 需求描述、评论、Flower 内 PRD 当前正文中含 `[[` 的都是 0 条；迭代与节点名称中含 `/`、`|`、`[`、`]` 的都是 0 个 | 设计 §2；只读核对 |
| 迁移文件 | `0011_*.sql` 由 `db:generate` 生成后手工调整：`tasks.number` 先加为可空列，文件末尾补号、设 `task_seq`、再改为非空；`0012_p2b1_rls.sql` 用 `--custom` 生成后填写 | 生成的 `ADD COLUMN … NOT NULL` 在已有任务的库上会失败 |
| 端到端里的「改编号」 | 需求与任务的编号不会变（产品编号前缀不能修改）；「改编号或改标题后链接不断」在端到端里用改需求标题和改迭代名称（迭代以名称为标识）覆盖 | 设计 §7；`updateProduct` 不接受 `key` |

## 文件结构

```
packages/core/
  package.json                          # exports ./links（Task 1）
  src/links/syntax.ts                   # 纯函数，浏览器安全（Task 1）
  src/documents/markdown.ts             # 导出 normalizeHeading（Task 1）
  src/db/schema.ts                      # entity_links、tasks.number、products.task_seq、迭代名称唯一（Task 2）
  migrations/0011_*.sql  0012_p2b1_rls.sql  meta/                 # Task 2
  src/iterations/iterations.ts          # 重名报错（Task 2）、接上悬空链接（Task 5）
  src/tasks/tasks.ts  src/tasks/queries.ts                      # 编号分配（Task 2）、视图与按编号读取（Task 3）、接上（Task 5）
  src/requirements/detail.ts            # 任务编号（Task 3）、描述的链接卡（Task 6）
  src/workbench/workbench.ts            # 任务编号（Task 3）、PRD 未读评论（Task 14）
  src/links/links.ts                    # 重建与接上（Task 4、5）
  src/requirements/requirements.ts  src/documents/documents.ts  # 写入与接上（Task 4、5）
  src/requirements/comments.ts  src/documents/comments.ts       # 写入（Task 4）、链接卡（Task 6）、PRD 已读（Task 14）
  src/structure/nodes.ts                # Task 5
  src/links/cards.ts  src/links/backlinks.ts                    # Task 6
  src/links/search.ts                   # Task 7
  src/index.ts                          # 各任务
  test/link-syntax.test.ts  p2b1-schema.test.ts  task-numbers.test.ts  links.test.ts  link-queries.test.ts  link-search.test.ts
  test/iterations.test.ts  workbench.test.ts                    # Task 2、3、14
packages/migrate/
  src/plan-base.ts  src/plan-requirements.ts                    # 迭代重名检查与任务编号（Task 2）
  src/write.ts                          # --replace 时删除 entity_links（Task 4）
  test/plan-base.test.ts  test/plan-requirements.test.ts  test/write.test.ts
apps/web/
  package.json                          # prosemirror-state、prosemirror-view（Task 12）
  src/server/api.ts  src/server/routes/links.ts  routes/tasks.ts  routes/documents.ts   # Task 8、14
  test/api/links.test.ts                # Task 8
  src/lib/types.ts  src/lib/queries.ts  # Task 8
  src/features/links/model.ts  model.test.ts                    # Task 10、11
  src/features/documents/model.ts  model.test.ts                # Task 12、13
  src/features/documents/editor/decorations.ts  prd-editor.tsx  # Task 12、13
  src/features/workbench/model.ts  model.test.ts                # Task 3、14
  src/components/wiki-text.tsx  backlinks.tsx  wikilink-textarea.tsx                     # Task 10、11
  src/app/globals.css                   # Task 12、13
  src/app/(app)/[org]/tasks/[key]/page.tsx                      # Task 9
  src/app/(app)/[org]/iterations/[id]/task-row.tsx  iterations/[id]/page.tsx  workload/page.tsx  # Task 9、10
  src/app/(app)/[org]/requirements/[key]/page.tsx  comments.tsx  side-lists.tsx         # Task 9、10、11
  src/app/(app)/[org]/documents/[key]/page.tsx  editor-pane.tsx  comments.tsx           # Task 10–14
  src/app/(app)/[org]/page.tsx          # Task 3、14
  e2e/tasks.spec.ts  links.spec.ts  links-autocomplete.spec.ts  documents-links.spec.ts  documents-anchors.spec.ts  workbench.spec.ts
docs/superpowers/specs/2026-09-28-flower-data-model-design.md  # §6.4 字段名（Task 2）
docs/p2b1-validation.md  docs/handoff.md  docs/agent-log.md     # Task 16
```

---
### Task 1: 链接语法纯函数（`@flower/core/links`）

**Files:**
- Create: `packages/core/src/links/syntax.ts`
- Modify: `packages/core/src/documents/markdown.ts`（`normHeading` 改为导出的 `normalizeHeading`）
- Modify: `packages/core/package.json`（exports 加 `./links`）、`packages/core/src/index.ts`
- Test: `packages/core/test/link-syntax.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（`@flower/core/links`，浏览器安全，不导入其他模块）:
  - `LINK_SOURCE_TYPES = ['requirement', 'document', 'comment'] as const`，`type LinkSourceType`
  - `LINK_TARGET_TYPES = ['requirement', 'document', 'task', 'iteration', 'structure_node'] as const`，`type LinkTargetType`
  - `LINK_ORIGINS = ['wikilink', 'system', 'manual'] as const`，`type LinkOrigin`
  - `CONTEXT_MAX = 120`
  - `type WikiTarget = { kind: 'requirement'; productKey: string; number: number } | { kind: 'document'; productKey: string; number: number; section: string | null } | { kind: 'task'; productKey: string; number: number } | { kind: 'iteration'; productKey: string | null; name: string } | { kind: 'path'; segments: string[] }`
  - `type WikiLink = { raw: string; target: string; label: string | null; start: number; end: number }`
  - `type WikiSegment = { kind: 'text'; text: string } | { kind: 'link'; link: WikiLink }`
  - `type TextPart = { text: string; pos: number; code: boolean }`
  - `parseWikilinks(text: string): WikiLink[]`
  - `classifyTarget(target: string): WikiTarget`
  - `canonicalText(target: WikiTarget, sourceProductKey: string): string`
  - `canonicalWikiText(target: string, sourceProductKey: string): string`
  - `linkContext(text: string, start: number, end: number): string`
  - `splitWikiText(text: string): WikiSegment[]`
  - `wikiRangesInBlock(parts: TextPart[]): Array<{ from: number; to: number; target: string }>`
  - `taskDisplayKey(productKey: string, number: number): string`，`parseTaskKey(key: string): { productKey: string; number: number } | null`
- Produces（`@flower/core/markdown`）: `normalizeHeading(s: string): string`（去开头的数字编号与全部空白）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/link-syntax.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { normalizeHeading } from '../src/documents/markdown';
import {
  canonicalWikiText,
  classifyTarget,
  linkContext,
  parseTaskKey,
  parseWikilinks,
  splitWikiText,
  taskDisplayKey,
  wikiRangesInBlock,
} from '../src/links/syntax';

describe('双链语法', () => {
  it('各种写法与显示文字', () => {
    const text = '见 [[PAN-12]]、[[pan-prd-3#需求说明|说明]] 和 [[PAN-T-7]]，迭代 [[迭代:0316]]、[[DOC/迭代：一期]]，节点 [[会员/支付]]、[[DOC/会员/支付]]。';
    expect(parseWikilinks(text).map((l) => [l.target, l.label])).toEqual([
      ['PAN-12', null],
      ['pan-prd-3#需求说明', '说明'],
      ['PAN-T-7', null],
      ['迭代:0316', null],
      ['DOC/迭代：一期', null],
      ['会员/支付', null],
      ['DOC/会员/支付', null],
    ]);
    expect(classifyTarget('pan-prd-3#需求说明')).toEqual({ kind: 'document', productKey: 'PAN', number: 3, section: '需求说明' });
    expect(classifyTarget('PAN-PRD-3')).toEqual({ kind: 'document', productKey: 'PAN', number: 3, section: null });
    expect(classifyTarget('pan-t-7')).toEqual({ kind: 'task', productKey: 'PAN', number: 7 });
    expect(classifyTarget('Pan-12')).toEqual({ kind: 'requirement', productKey: 'PAN', number: 12 });
    expect(classifyTarget('DOC/迭代：一期')).toEqual({ kind: 'iteration', productKey: 'DOC', name: '一期' });
    expect(classifyTarget('迭代:0316')).toEqual({ kind: 'iteration', productKey: null, name: '0316' });
    expect(classifyTarget(' 会员 / 支付 ')).toEqual({ kind: 'path', segments: ['会员', '支付'] });
  });

  it('代码块、行内代码与转义中的 [[ ]] 不解析；目标为空的忽略', () => {
    const text = ['```', '[[PAN-1]]', '```', '行内 `[[PAN-2]]` 与 \\[[PAN-3]] 都不算，[[PAN-4]] 算，[[ |只有文字]] 不算', '~~~', '[[PAN-5]]'].join('\n');
    expect(parseWikilinks(text).map((l) => l.target)).toEqual(['PAN-4']);
  });

  it('规范写法：编号转大写，迭代与节点补上来源产品前缀', () => {
    expect(canonicalWikiText('pan-12', 'DOC')).toBe('PAN-12');
    expect(canonicalWikiText('pan-prd-3#需求说明', 'DOC')).toBe('PAN-PRD-3#需求说明');
    expect(canonicalWikiText('pan-t-7', 'DOC')).toBe('PAN-T-7');
    expect(canonicalWikiText('迭代：0316', 'pan')).toBe('PAN/迭代:0316');
    expect(canonicalWikiText('doc/迭代:一期', 'PAN')).toBe('DOC/迭代:一期');
    expect(canonicalWikiText('会员/支付', 'PAN')).toBe('PAN/会员/支付');
    expect(canonicalWikiText('DOC/会员/支付', 'PAN')).toBe('DOC/会员/支付');
    expect(canonicalWikiText('X20260312012', 'PAN')).toBe('PAN/X20260312012');
  });

  it('上下文：引用所在的一句；超过 120 字时截取链接附近', () => {
    const text = '第一句。这一句提到 [[PAN-1]] 的上传！第三句';
    const [l] = parseWikilinks(text);
    expect(linkContext(text, l!.start, l!.end)).toBe('这一句提到 [[PAN-1]] 的上传！');
    const long = `${'甲'.repeat(200)}[[PAN-2]]${'乙'.repeat(200)}`;
    const [m] = parseWikilinks(long);
    const ctx = linkContext(long, m!.start, m!.end);
    expect(ctx.startsWith('…') && ctx.endsWith('…')).toBe(true);
    expect(ctx).toContain('[[PAN-2]]');
    expect(ctx).toHaveLength(122);
  });

  it('拆分为显示片段', () => {
    expect(splitWikiText('看 [[PAN-1|登录]] 吧')).toEqual([
      { kind: 'text', text: '看 ' },
      { kind: 'link', link: { raw: '[[PAN-1|登录]]', target: 'PAN-1', label: '登录', start: 2, end: 14 } },
      { kind: 'text', text: ' 吧' },
    ]);
    expect(splitWikiText('没有链接')).toEqual([{ kind: 'text', text: '没有链接' }]);
  });

  it('编辑器文本块中的位置：跨文本节点；带代码样式的部分不解析', () => {
    const parts = [
      { text: '见 [[PAN', pos: 10, code: false },
      { text: '-1]] 和 ', pos: 17, code: false },
      { text: '[[PAN-2]]', pos: 24, code: true },
    ];
    expect(wikiRangesInBlock(parts)).toEqual([{ from: 12, to: 21, target: 'PAN-1' }]);
  });

  it('任务编号与小节标题归一化', () => {
    expect(taskDisplayKey('PAN', 12)).toBe('PAN-T-12');
    expect(parseTaskKey('pan-t-12')).toEqual({ productKey: 'PAN', number: 12 });
    expect(parseTaskKey('PAN-12')).toBeNull();
    expect(normalizeHeading('3. 需求 说明')).toBe('需求说明');
    expect(normalizeHeading('1.1 业务背景')).toBe('业务背景');
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/link-syntax.test.ts`
Expected: FAIL，找不到 `../src/links/syntax`。

- [ ] **Step 2: 实现语法模块**

新建 `packages/core/src/links/syntax.ts`：

```ts
/**
 * [[双链]] 的语法：解析、分类、规范写法、上下文与编辑器文本块定位。
 * 浏览器与服务端共用（@flower/core/links），不导入其他模块。
 */

export const LINK_SOURCE_TYPES = ['requirement', 'document', 'comment'] as const;
export type LinkSourceType = (typeof LINK_SOURCE_TYPES)[number];
export const LINK_TARGET_TYPES = ['requirement', 'document', 'task', 'iteration', 'structure_node'] as const;
export type LinkTargetType = (typeof LINK_TARGET_TYPES)[number];
export const LINK_ORIGINS = ['wikilink', 'system', 'manual'] as const;
export type LinkOrigin = (typeof LINK_ORIGINS)[number];

/** 引用处上下文的最大长度（字符）。 */
export const CONTEXT_MAX = 120;

export type WikiTarget =
  | { kind: 'requirement'; productKey: string; number: number }
  | { kind: 'document'; productKey: string; number: number; section: string | null }
  | { kind: 'task'; productKey: string; number: number }
  | { kind: 'iteration'; productKey: string | null; name: string }
  /** 结构树节点路径，或只有一段的旧编号；首段是否为产品前缀见 canonicalText。 */
  | { kind: 'path'; segments: string[] };

export type WikiLink = { raw: string; target: string; label: string | null; start: number; end: number };
export type WikiSegment = { kind: 'text'; text: string } | { kind: 'link'; link: WikiLink };
/** 编辑器文本块里的一段文字：pos 为首字符在文档中的位置，code 为带代码样式。 */
export type TextPart = { text: string; pos: number; code: boolean };

const KEY = '([A-Za-z][A-Za-z0-9]{1,9})';
const DOC_RE = new RegExp(`^${KEY}-PRD-(\\d{1,9})(?:#(.*))?$`, 'i');
const TASK_RE = new RegExp(`^${KEY}-T-(\\d{1,9})$`, 'i');
const REQ_RE = new RegExp(`^${KEY}-(\\d{1,9})$`);
const ITER_RE = new RegExp(`^(?:${KEY}\\/)?迭代[:：](.+)$`);
/** 路径首段与产品编号前缀同形时视为产品前缀。 */
const PREFIX_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const LINK_RE = /\[\[([^[\]\n]+?)\]\]/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const SENTENCE_END = /[。！？!?；;\n]/;

/** 围栏代码块（不闭合时到文末）与同一行内成对反引号所占的区间 [start, end)。 */
function codeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const plain: Array<[number, string]> = [];
  let pos = 0;
  let fence: { start: number; char: string } | null = null;
  for (const line of text.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence.char) {
        out.push([fence.start, pos + line.length]);
        fence = null;
      }
    } else if (m) {
      fence = { start: pos, char: m[1]![0]! };
    } else {
      plain.push([pos, line]);
    }
    pos += line.length + 1;
  }
  if (fence) out.push([fence.start, text.length]);
  for (const [start, line] of plain) {
    for (const m of line.matchAll(/(`+)[^`]+?\1(?!`)/g)) out.push([start + m.index, start + m.index + m[0].length]);
  }
  return out;
}

export function parseWikilinks(text: string): WikiLink[] {
  const code = codeRanges(text);
  const inCode = (i: number) => code.some(([s, e]) => i >= s && i < e);
  const out: WikiLink[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index;
    if (text[start - 1] === '\\' || inCode(start)) continue;
    const inner = m[1]!;
    const bar = inner.indexOf('|');
    const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    const label = bar === -1 ? null : inner.slice(bar + 1).trim() || null;
    if (!target) continue;
    out.push({ raw: m[0], target, label, start, end: start + m[0].length });
  }
  return out;
}

export function classifyTarget(target: string): WikiTarget {
  const t = target.trim();
  let m = DOC_RE.exec(t);
  if (m) return { kind: 'document', productKey: m[1]!.toUpperCase(), number: Number(m[2]), section: m[3]?.trim() || null };
  m = TASK_RE.exec(t);
  if (m) return { kind: 'task', productKey: m[1]!.toUpperCase(), number: Number(m[2]) };
  m = REQ_RE.exec(t);
  if (m) return { kind: 'requirement', productKey: m[1]!.toUpperCase(), number: Number(m[2]) };
  m = ITER_RE.exec(t);
  if (m && m[2]!.trim()) return { kind: 'iteration', productKey: m[1]?.toUpperCase() ?? null, name: m[2]!.trim() };
  return {
    kind: 'path',
    segments: t
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export const taskDisplayKey = (productKey: string, number: number): string => `${productKey}-T-${number}`;

export function parseTaskKey(key: string): { productKey: string; number: number } | null {
  const m = TASK_RE.exec(key.trim());
  return m ? { productKey: m[1]!.toUpperCase(), number: Number(m[2]) } : null;
}

/** 规范写法（存为 entity_links.target_text）：编号大写，迭代与节点带上产品前缀，小节标题保留原样。 */
export function canonicalText(t: WikiTarget, sourceProductKey: string): string {
  const own = sourceProductKey.toUpperCase();
  switch (t.kind) {
    case 'requirement':
      return `${t.productKey}-${t.number}`;
    case 'document':
      return `${t.productKey}-PRD-${t.number}${t.section ? `#${t.section}` : ''}`;
    case 'task':
      return taskDisplayKey(t.productKey, t.number);
    case 'iteration':
      return `${t.productKey ?? own}/迭代:${t.name}`;
    case 'path': {
      const prefixed = t.segments.length >= 2 && PREFIX_RE.test(t.segments[0]!);
      return prefixed ? t.segments.join('/') : [own, ...t.segments].join('/');
    }
  }
}

export const canonicalWikiText = (target: string, sourceProductKey: string): string => canonicalText(classifyTarget(target), sourceProductKey);

/** 引用处所在的一句（带句末标点）；超过 CONTEXT_MAX 时以链接为中心截取，截掉的一端加「…」。 */
export function linkContext(text: string, start: number, end: number): string {
  let a = start;
  while (a > 0 && !SENTENCE_END.test(text[a - 1]!)) a--;
  let b = end;
  while (b < text.length && !SENTENCE_END.test(text[b]!)) b++;
  if (b < text.length && text[b] !== '\n') b++;
  const raw = text.slice(a, b);
  const lead = raw.length - raw.trimStart().length;
  const s = raw.trim();
  if (s.length <= CONTEXT_MAX) return s;
  const rel = start - a - lead;
  const from = Math.max(0, Math.min(rel - 30, s.length - CONTEXT_MAX));
  return `${from > 0 ? '…' : ''}${s.slice(from, from + CONTEXT_MAX)}${from + CONTEXT_MAX < s.length ? '…' : ''}`;
}

/** 显示用：把文字拆成普通文字与链接两种片段。 */
export function splitWikiText(text: string): WikiSegment[] {
  const out: WikiSegment[] = [];
  let at = 0;
  for (const link of parseWikilinks(text)) {
    if (link.start > at) out.push({ kind: 'text', text: text.slice(at, link.start) });
    out.push({ kind: 'link', link });
    at = link.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/** 编辑器一个文本块里 [[ ]] 的位置 [from, to)；parts 是块内依次出现的文本节点，带代码样式的部分按空白处理。 */
export function wikiRangesInBlock(parts: TextPart[]): Array<{ from: number; to: number; target: string }> {
  let text = '';
  const posAt: number[] = [];
  for (const p of parts) {
    for (let i = 0; i < p.text.length; i++) posAt.push(p.pos + i);
    text += p.code ? ' '.repeat(p.text.length) : p.text;
  }
  return parseWikilinks(text).map((l) => ({ from: posAt[l.start]!, to: posAt[l.end - 1]! + 1, target: l.target }));
}
```

- [ ] **Step 3: 导出 `normalizeHeading`，登记导出路径**

`packages/core/src/documents/markdown.ts`：把

```ts
const normHeading = (s: string): string => s.replace(/^[\d.、\s]+/, '').replace(/\s+/g, '');
```

改为

```ts
/** 小节标题的比较形式：去掉开头的数字编号与全部空白。必填小节、评论所在小节与 [[PRD#小节]] 共用。 */
export const normalizeHeading = (s: string): string => s.replace(/^[\d.、\s]+/, '').replace(/\s+/g, '');
```

并把 `missingRequiredSections` 里的两处 `normHeading(` 改为 `normalizeHeading(`。

`packages/core/package.json` 的 `exports` 在 `"./markdown"` 一行后加：

```json
    "./links": "./src/links/syntax.ts",
```

`packages/core/src/index.ts` 在 `export * from './documents/markdown';` 一行后加：

```ts
export * from './links/syntax';
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/link-syntax.test.ts test/markdown.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/links/syntax.ts packages/core/src/documents/markdown.ts packages/core/package.json packages/core/src/index.ts packages/core/test/link-syntax.test.ts
git commit -m "feat(core): [[双链]] 语法纯函数：解析、分类、规范写法、上下文与编辑器定位

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 数据模型：`entity_links`、任务编号（补号迁移、新建分配、导入编号）、同一产品内迭代名称唯一

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Create: `packages/core/migrations/0011_*.sql`（`db:generate` 生成后手工调整）、`packages/core/migrations/0012_p2b1_rls.sql`（`--custom` 生成后填写）、`packages/core/migrations/meta/*`（生成）
- Modify: `packages/core/src/tasks/tasks.ts`（`createTask` 分配编号）
- Modify: `packages/core/src/iterations/iterations.ts`（重名报错）
- Modify: `packages/migrate/src/plan-requirements.ts`（导入时编号）、`packages/migrate/src/plan-base.ts`（试跑时检查常规迭代重名）
- Modify: `docs/superpowers/specs/2026-09-28-flower-data-model-design.md`（§6.4 字段名 `anchor` → `context`）
- Test: `packages/core/test/p2b1-schema.test.ts`、`packages/core/test/task-numbers.test.ts`、`packages/core/test/iterations.test.ts`、`packages/migrate/test/plan-base.test.ts`、`packages/migrate/test/plan-requirements.test.ts`

**Interfaces:**
- Consumes: Task 1 `LINK_SOURCE_TYPES`、`LINK_TARGET_TYPES`、`LINK_ORIGINS`
- Produces:
  - 表 `entityLinks`（`entity_links`）：`id, orgId, sourceType, sourceId, sourceSection, targetType, targetId, targetSection, targetText, context, origin, createdAt`；索引 `entity_links_source (source_type, source_id)`、`entity_links_target (target_type, target_id)`、`entity_links_org_text (org_id, target_text)`
  - `products.taskSeq`（`task_seq`，默认 0）；`tasks.number`（非空）与唯一索引 `tasks_product_number (product_id, number)`
  - 唯一索引 `iterations_product_name (product_id, name) where deleted_at is null`
  - `createTask` 分配 `tasks.number`；`task.created` 事件 payload 增加 `number`
  - 迭代新建与改名重名时：`AppError('conflict', '同一产品内已有同名迭代')`
  - 迁移工具：`assignTaskNumbers(rows: ImportRows): void`（`packages/migrate/src/plan-requirements.ts`）；问题列表新增 `同一产品内迭代名称重复：「{name}」`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/p2b1-schema.test.ts`：

```ts
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate';
import { entityLinks, iterations, organizations, products, tasks } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { ADMIN_URL, APP_PASSWORD, createTestDb, urlFor } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
});
afterAll(() => t.cleanup());

describe('P2-B1 数据模型', () => {
  it('entity_links 受行级安全约束；悬空链接的目标为空；默认来源为 wikilink', async () => {
    await withOrg(t.db, orgA, (tx) =>
      tx.insert(entityLinks).values({ orgId: orgA, sourceType: 'requirement', sourceId: newId(), targetType: 'requirement', targetId: null, targetText: 'AA-9', context: '见 [[AA-9]]' }),
    );
    const mine = await withOrg(t.db, orgA, (tx) => tx.select().from(entityLinks));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ origin: 'wikilink', sourceSection: null, targetSection: null, targetId: null });
    expect(await withOrg(t.db, orgB, (tx) => tx.select().from(entityLinks))).toHaveLength(0);
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename = 'entity_links'`)) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('任务编号在同一产品内唯一；task_seq 默认为 0', async () => {
    await t.adminDb.insert(tasks).values({ orgId: orgA, productId: productA, number: 1, title: '甲' });
    await expect(t.adminDb.insert(tasks).values({ orgId: orgA, productId: productA, number: 1, title: '乙' })).rejects.toThrow();
    const [p] = await t.adminDb.select({ seq: products.taskSeq }).from(products).where(eq(products.id, productA));
    expect(p!.seq).toBe(0);
  });

  it('同一产品内未删除的迭代不能重名；删除后可以再用这个名字；专项不受约束', async () => {
    const base = { orgId: orgA, productId: productA, type: 'regular' as const, name: '0316', startDate: '2026-03-02', endDate: '2026-03-13' };
    const [first] = await t.adminDb.insert(iterations).values(base).returning();
    await expect(t.adminDb.insert(iterations).values({ ...base, startDate: '2026-04-01', endDate: '2026-04-10' })).rejects.toThrow();
    await t.adminDb.update(iterations).set({ deletedAt: new Date() }).where(eq(iterations.id, first!.id));
    await t.adminDb.insert(iterations).values({ ...base, startDate: '2026-04-01', endDate: '2026-04-10' });
    const special = { orgId: orgA, productId: null, type: 'special' as const, name: '专项', startDate: '2026-03-02', endDate: '2026-03-13' };
    await t.adminDb.insert(iterations).values([special, special]);
  });

  it('补号迁移：同一产品内按创建时间（相同时按 id）为已有任务编号，task_seq 设为最大值', async () => {
    const name = `flower_t_mig_${Date.now().toString(36)}`;
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'flower-mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const upto = journal.entries.findIndex((e) => e.tag === '0010_p2a_rls');
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, upto + 1) }));
    const url = urlFor(ADMIN_URL, name);
    const db = postgres(url, { max: 1, onnotice: () => {} });
    try {
      // 先迁移到 P2-A 为止（还没有 tasks.number），写入几条任务，再执行全部迁移
      await runMigrations(url, APP_PASSWORD, dir);
      const org = newId();
      const pan = newId();
      const doc = newId();
      const tieA = '0192f000-0000-7000-8000-00000000000a';
      const tieB = '0192f000-0000-7000-8000-00000000000b';
      await db`insert into organizations (id, slug, name) values (${org}, 'm', 'M')`;
      await db`insert into products (id, org_id, key, name) values (${pan}, ${org}, 'PAN', '网盘'), (${doc}, ${org}, 'DOC', '文档')`;
      await db`insert into tasks (id, org_id, product_id, title, created_at) values
        (${tieB}, ${org}, ${pan}, '同时创建乙', '2026-03-04T00:00:00Z'),
        (${tieA}, ${org}, ${pan}, '同时创建甲', '2026-03-04T00:00:00Z'),
        (${newId()}, ${org}, ${pan}, '最早', '2026-03-01T00:00:00Z'),
        (${newId()}, ${org}, ${doc}, '另一个产品', '2026-03-09T00:00:00Z')`;
      await runMigrations(url, APP_PASSWORD);
      const rows = await db<Array<{ title: string; number: number }>>`select title, number from tasks order by product_id = ${pan} desc, number`;
      expect(rows.map((r) => [r.title, r.number])).toEqual([
        ['最早', 1],
        ['同时创建甲', 2],
        ['同时创建乙', 3],
        ['另一个产品', 1],
      ]);
      const seqs = await db<Array<{ key: string; task_seq: number }>>`select key, task_seq from products order by key`;
      expect(seqs.map((s) => [s.key, s.task_seq])).toEqual([
        ['DOC', 1],
        ['PAN', 3],
      ]);
    } finally {
      await db.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
```

新建 `packages/core/test/task-numbers.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, products, tasks } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createIteration, type IterationView } from '../src/iterations/iterations';
import { createRequirement } from '../src/requirements/requirements';
import { createTask, deleteTask } from '../src/tasks/tasks';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { regularIteration, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let doc: string;
let sprint: IterationView;
let docReqId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0928', '2026-09-28', '2026-10-09'));
  docReqId = (await createRequirement(t.db, owner, doc, { title: '文档需求' })).id;
});
afterAll(() => t.cleanup());

const numberOf = async (id: string): Promise<number> =>
  (await withOrg(t.db, owner.orgId, (tx) => tx.select({ n: tasks.number }).from(tasks).where(eq(tasks.id, id))))[0]!.n;

describe('任务编号', () => {
  it('新建时按产品递增分配，删除的编号不复用；产品的 task_seq 随之增加；事件记录编号', async () => {
    const a = await createTask(t.db, owner, { iterationId: sprint.id, title: '前端开发' });
    const b = await createTask(t.db, owner, { iterationId: sprint.id, title: '后端开发' });
    const c = await createTask(t.db, owner, { requirementId: docReqId, title: '文档任务' });
    expect([await numberOf(a.id), await numberOf(b.id), await numberOf(c.id)]).toEqual([1, 2, 1]);
    await deleteTask(t.db, owner, b.id);
    const d = await createTask(t.db, owner, { iterationId: sprint.id, title: '联调' });
    expect(await numberOf(d.id)).toBe(3);
    const [p] = await withOrg(t.db, owner.orgId, (tx) => tx.select({ seq: products.taskSeq }).from(products).where(eq(products.id, pan)));
    expect(p!.seq).toBe(3);
    const [ev] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, d.id), eq(domainEvents.type, 'task.created'))),
    );
    expect(ev!.payload).toMatchObject({ number: 3, title: '联调' });
  });
});
```

`packages/core/test/iterations.test.ts` 的 `describe('新建与修改迭代', …)` 末尾加：

```ts
  it('同一产品内迭代不能重名（新建与改名）；不同产品可以同名；删除后可以再用这个名字', async () => {
    const a = await createIteration(t.db, owner, regular(pan, '重名检查', '2027-03-01', '2027-03-05'));
    await expect(createIteration(t.db, owner, regular(pan, '重名检查', '2027-03-08', '2027-03-12'))).rejects.toMatchObject({ code: 'conflict', message: '同一产品内已有同名迭代' });
    const b = await createIteration(t.db, owner, regular(pan, '重名检查二', '2027-03-08', '2027-03-12'));
    await expect(updateIteration(t.db, owner, b.id, { name: '重名检查' })).rejects.toMatchObject({ code: 'conflict', message: '同一产品内已有同名迭代' });
    await createIteration(t.db, owner, regular(doc, '重名检查', '2027-03-01', '2027-03-05'));
    await deleteIteration(t.db, owner, a.id);
    await createIteration(t.db, owner, regular(pan, '重名检查', '2027-03-15', '2027-03-19'));
  });
```

`packages/migrate/test/plan-base.test.ts` 在「常规迭代时间重叠」用例后加：

```ts
  it('同一产品内常规迭代重名', () => {
    const m = reviewedMapping();
    m.iterations.iterations.find((i) => i.name === 'it0330')!.name = 'it0316';
    expect(buildImportPlan(makeLegacyData(), m, OPTS).report.problems).toContain('同一产品内迭代名称重复：「it0316」');
  });
```

`packages/migrate/test/plan-requirements.test.ts` 的 `describe('导入计划：需求', …)` 里、「合并结果与编号」用例之后加：

```ts
  it('任务按创建时间（相同时按 id）从 1 编号，task_seq 为任务数', () => {
    const ordered = [...rows.tasks].sort((a, b) => a.number - b.number);
    expect(ordered.map((x) => x.number)).toEqual(rows.tasks.map((_, i) => i + 1));
    for (let i = 1; i < ordered.length; i++) {
      const [a, b] = [ordered[i - 1]!, ordered[i]!];
      const [ta, tb] = [a.createdAt!.getTime(), b.createdAt!.getTime()];
      expect(ta < tb || (ta === tb && a.id! < b.id!)).toBe(true);
    }
    expect(ordered[0]!.title).toBe('接口联调');
    expect(rows.products[0]!.taskSeq).toBe(rows.tasks.length);
  });
```

Run: `pnpm --filter @flower/core exec vitest run test/p2b1-schema.test.ts test/task-numbers.test.ts test/iterations.test.ts`
Expected: FAIL（`entityLinks`、`tasks.number` 不存在；迭代重名没有报错）。

Run: `pnpm --filter @flower/migrate exec vitest run test/plan-base.test.ts test/plan-requirements.test.ts`
Expected: FAIL（没有重名问题；任务没有 `number`）。

- [ ] **Step 2: 改表结构**

`packages/core/src/db/schema.ts`：

1. import 区加：

```ts
import { LINK_ORIGINS, LINK_SOURCE_TYPES, LINK_TARGET_TYPES } from '../links/syntax';
```

2. `products` 的 `documentSeq` 一行之后加：

```ts
    taskSeq: integer('task_seq').notNull().default(0),
```

3. `iterations` 的约束数组里，`index('iterations_product').on(t.productId),` 一行之后加：

```ts
    uniqueIndex('iterations_product_name').on(t.productId, t.name).where(sql`${t.deletedAt} is null`),
```

4. `tasks` 的 `productId: productRef(),` 一行之后加 `number: integer('number').notNull(),`，并把它的约束数组改为：

```ts
  (t) => [
    uniqueIndex('tasks_product_number').on(t.productId, t.number),
    index('tasks_requirement').on(t.requirementId),
    index('tasks_assignee').on(t.assigneeMemberId),
    index('tasks_iteration').on(t.iterationId),
  ],
```

5. 文件末尾加：

```ts
// ---------- P2-B1：双链 ----------

export const entityLinks = pgTable(
  'entity_links',
  {
    id: id(),
    orgId: orgRef(),
    sourceType: text('source_type', { enum: LINK_SOURCE_TYPES }).notNull(),
    sourceId: uuid('source_id').notNull(),
    /** PRD 正文中链接所在小节的原始标题；需求描述与评论为空。 */
    sourceSection: text('source_section'),
    targetType: text('target_type', { enum: LINK_TARGET_TYPES }),
    /** 目标不存在（悬空）时为空；新建或改名的目标按 target_text 接上。 */
    targetId: uuid('target_id'),
    targetSection: text('target_section'),
    /** 规范写法：编号大写，迭代与节点带产品前缀。 */
    targetText: text('target_text').notNull(),
    /** 引用处所在的一句，最多 120 字。 */
    context: text('context').notNull().default(''),
    origin: text('origin', { enum: LINK_ORIGINS }).notNull().default('wikilink'),
    createdAt: createdAt(),
  },
  (t) => [
    index('entity_links_source').on(t.sourceType, t.sourceId),
    index('entity_links_target').on(t.targetType, t.targetId),
    index('entity_links_org_text').on(t.orgId, t.targetText),
  ],
);
```

- [ ] **Step 3: 生成迁移并调整补号顺序**

Run: `pnpm --filter @flower/core db:generate`
Expected: 生成 `packages/core/migrations/0011_<随机名>.sql` 与 `meta/0011_snapshot.json`，`_journal.json` 增加一项。

打开生成的 `0011_*.sql`：

1. 把这一句

```sql
ALTER TABLE "tasks" ADD COLUMN "number" integer NOT NULL;--> statement-breakpoint
```

改为（先加为可空列）：

```sql
ALTER TABLE "tasks" ADD COLUMN "number" integer;--> statement-breakpoint
```

2. 在文件末尾（最后一条语句末尾没有 `--> statement-breakpoint` 时先补上）追加：

```sql
UPDATE "tasks" AS t SET "number" = n.rn
FROM (SELECT "id", row_number() OVER (PARTITION BY "product_id" ORDER BY "created_at", "id") AS rn FROM "tasks") AS n
WHERE n."id" = t."id";--> statement-breakpoint
UPDATE "products" AS p SET "task_seq" = coalesce((SELECT max(t."number") FROM "tasks" AS t WHERE t."product_id" = p."id"), 0);--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;
```

唯一索引 `tasks_product_number` 在可空列上先建好没有问题（空值互不冲突），补号后的值也互不重复。核对文件里有：`CREATE TABLE "entity_links"`（含 `org_id` 外键）及其三个索引、`ALTER TABLE "products" ADD COLUMN "task_seq" integer DEFAULT 0 NOT NULL`、`CREATE UNIQUE INDEX "iterations_product_name" … WHERE "iterations"."deleted_at" is null`、`CREATE UNIQUE INDEX "tasks_product_number"`；缺任何一项就停下来报告。

Run: `pnpm --filter @flower/core exec drizzle-kit generate --custom --name=p2b1_rls`
Expected: 生成空的 `packages/core/migrations/0012_p2b1_rls.sql`。填入：

```sql
ALTER TABLE entity_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON entity_links
  USING (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid);
```

- [ ] **Step 4: 新建任务时分配编号**

`packages/core/src/tasks/tasks.ts` 的 `createTask`：在 `const metaValue = …` 一行之后、`insert(tasks)` 之前加：

```ts
    const [seq] = await tx
      .update(products)
      .set({ taskSeq: sql`${products.taskSeq} + 1` })
      .where(eq(products.id, productId))
      .returning({ n: products.taskSeq, key: products.key });
```

`.values({ … })` 里在 `productId,` 之后加 `number: seq!.n,`；`task.created` 事件的 payload 改为：

```ts
      payload: { number: row!.number, title: row!.title, requirementId: row!.requirementId, iterationId: row!.iterationId },
```

（`products` 与 `sql` 已在该文件的 import 里。产品行锁在迭代锁之后取，与 `createRequirement` 只锁产品行的顺序不冲突。）

- [ ] **Step 5: 迭代重名报错**

`packages/core/src/iterations/iterations.ts`：

1. import 改为 `import { AppError, isUniqueViolation, pgErrorCode } from '../errors';`
2. 把 `overlapToConflict` 整个函数替换为：

```ts
/** 写迭代时的约束冲突：时间重叠（排他约束）或同一产品内重名（部分唯一索引）。 */
function writeConflict(e: unknown): never {
  if (pgErrorCode(e) === '23P01') throw new AppError('conflict', '与已有迭代时间重叠');
  if (isUniqueViolation(e)) throw new AppError('conflict', '同一产品内已有同名迭代');
  throw e;
}
```

3. `createIteration` 与 `updateIteration` 里的两处 `overlapToConflict(e);` 改为 `writeConflict(e);`。

- [ ] **Step 6: 迁移工具：导入编号与重名检查**

`packages/migrate/src/plan-requirements.ts`：

1. 两处 `rows.tasks.push({ … })`（123plane 子任务一处、push 甘特任务一处）的对象里，在 `productId,` 之后加 `number: 0,`。
2. 第 5 节（任务）的 push 甘特任务 `for` 循环结束之后、`// 6. 发布版本关联` 注释之前加一行 `assignTaskNumbers(rows);`。
3. `import type { PlanContext } from './plan-types';` 改为 `import type { ImportRows, PlanContext } from './plan-types';`，文件末尾加：

```ts
/**
 * 任务编号：与补号迁移（0011）同一规则——同一产品内按创建时间、相同时按 id 升序，从 1 起；task_seq 设为最大值。
 * id 是小写十六进制的 uuid 字符串，字符串比较与 Postgres 的 uuid 比较顺序一致。
 */
export function assignTaskNumbers(rows: ImportRows): void {
  const sorted = [...rows.tasks].sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime() || (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0));
  sorted.forEach((task, i) => {
    task.number = i + 1;
  });
  rows.products[0]!.taskSeq = sorted.length;
}
```

`packages/migrate/src/plan-base.ts`：在「常规迭代时间重叠」检查的 `for` 循环之后、`// 发布版本` 注释之前加：

```ts
  const regularNames = new Set<string>();
  for (const it of regular) {
    if (regularNames.has(it.name)) ctx.problem(`同一产品内迭代名称重复：「${it.name}」`);
    regularNames.add(it.name);
  }
```

- [ ] **Step 7: 上位文档字段名与 P2-B1 设计一致**

`docs/superpowers/specs/2026-09-28-flower-data-model-design.md` §6.4 的 `entity_links` 一行，把 `target_text、anchor、origin` 改为 `target_text、context（引用处所在的一句）、origin`。

- [ ] **Step 8: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/p2b1-schema.test.ts test/task-numbers.test.ts test/iterations.test.ts test/p1a-schema.test.ts test/p2a-schema.test.ts test/rls.test.ts test/tasks.test.ts && pnpm --filter @flower/migrate exec vitest run && pnpm typecheck`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。如有既有用例在同一产品里建了同名迭代而失败，把后建的那个迭代改名（不改断言），并在提交说明里列出改了哪些文件。

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/db/schema.ts packages/core/migrations packages/core/src/tasks/tasks.ts packages/core/src/iterations/iterations.ts packages/migrate/src/plan-requirements.ts packages/migrate/src/plan-base.ts packages/core/test/p2b1-schema.test.ts packages/core/test/task-numbers.test.ts packages/core/test/iterations.test.ts packages/migrate/test/plan-base.test.ts packages/migrate/test/plan-requirements.test.ts docs/superpowers/specs/2026-09-28-flower-data-model-design.md
git commit -m "feat(core): entity_links 表（RLS）、任务编号（补号迁移、新建分配、导入编号）、同一产品内迭代名称唯一

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 任务编号的读取：视图、按编号读取、需求详情与工作台

**Files:**
- Modify: `packages/core/src/tasks/tasks.ts`（`TaskView` 加编号）、`packages/core/src/tasks/queries.ts`（`getTaskByKey`）
- Modify: `packages/core/src/requirements/detail.ts`（任务列表带编号）
- Modify: `packages/core/src/workbench/workbench.ts`（我的任务带编号）
- Modify: `apps/web/src/features/workbench/model.test.ts`（类型新增字段后的测试数据）
- Test: `packages/core/test/task-numbers.test.ts`、`packages/core/test/workbench.test.ts`

**Interfaces:**
- Consumes: Task 1 `taskDisplayKey`、`parseTaskKey`；Task 2 `tasks.number`
- Produces:
  - `TaskView` 增加 `number: number; displayKey: string`（`hydrateTasks` 填充，甘特、按人任务、工作台、新建与修改任务的返回都带上）
  - `type TaskDetail = TaskView & { productKey: string; iteration: { id: string; name: string; status: IterationStatus } | null; createdAt: Date }`
  - `getTaskByKey(db, actor, key: string, opts?: { today?: string }): Promise<TaskDetail>`（编号大小写不敏感；不存在或看不到所属产品时 `AppError('not_found', '任务不存在')`）
  - `RequirementDetail['tasks'][number]` 增加 `displayKey: string`
  - `WorkbenchTask` 增加 `displayKey: string`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/task-numbers.test.ts`：import 区补上

```ts
import { getRequirementByKey } from '../src/requirements/detail';
import { getTaskByKey } from '../src/tasks/queries';
import { asMember } from './factories';
```

（`asMember` 与已有的 `regularIteration, seedInstance` 合并到同一条 import。）在 `describe('任务编号', …)` 末尾加：

```ts
  it('视图带编号：新建、修改与需求详情的任务列表', async () => {
    const e = await createTask(t.db, owner, { requirementId: docReqId, title: '文档联调' });
    expect(e).toMatchObject({ number: await numberOf(e.id), displayKey: `DOC-T-${await numberOf(e.id)}` });
    const detail = await getRequirementByKey(t.db, owner, 'DOC-1');
    expect(detail.tasks.map((x) => [x.displayKey, x.title])).toEqual([
      ['DOC-T-1', '文档任务'],
      [e.displayKey, '文档联调'],
    ]);
  });

  it('按编号读取任务：大小写不敏感；不存在或看不到所属产品时一律为「任务不存在」', async () => {
    const d = await getTaskByKey(t.db, owner, 'pan-t-1');
    expect(d).toMatchObject({ displayKey: 'PAN-T-1', title: '前端开发', productKey: 'PAN', iteration: { id: sprint.id, name: '迭代0928', status: 'planning' }, requirement: null });
    expect(d.createdAt).toBeInstanceOf(Date);
    await expect(getTaskByKey(t.db, owner, 'PAN-T-99')).rejects.toMatchObject({ code: 'not_found', message: '任务不存在' });
    await expect(getTaskByKey(t.db, owner, 'PAN-99')).rejects.toMatchObject({ code: 'not_found', message: '任务不存在' });
    const guest = await asMember(t.db, owner, '访客甲', 'guest');
    await expect(getTaskByKey(t.db, guest, 'PAN-T-1')).rejects.toMatchObject({ code: 'not_found', message: '任务不存在' });
  });
```

`packages/core/test/workbench.test.ts` 的「指派给我的未完成任务…」用例里，`expect(wb.tasks).toEqual({ … })` 的 `items[0]` 在 `title: '接口联调',` 之前加 `displayKey: 'PAN-T-1',`。

Run: `pnpm --filter @flower/core exec vitest run test/task-numbers.test.ts test/workbench.test.ts`
Expected: FAIL（视图没有 `displayKey`，`getTaskByKey` 不存在）。

- [ ] **Step 2: 视图带编号**

`packages/core/src/tasks/tasks.ts`：

1. import 区加 `import { taskDisplayKey } from '../links/syntax';`
2. `TaskView` 类型在 `productId: string;` 之后加：

```ts
  number: number;
  displayKey: string;
```

3. `hydrateTasks` 中，`const names = …` 一行之前加：

```ts
  const keyRows = await tx
    .select({ id: products.id, key: products.key })
    .from(products)
    .where(inArray(products.id, [...new Set(rows.map((r) => r.productId))]));
  const keyOf = new Map(keyRows.map((p) => [p.id, p.key]));
```

返回对象在 `productId: r.productId,` 之后加：

```ts
      number: r.number,
      displayKey: taskDisplayKey(keyOf.get(r.productId)!, r.number),
```

- [ ] **Step 3: 按编号读取任务**

`packages/core/src/tasks/queries.ts`：

1. import 改为：

```ts
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { iterations, members, products, tasks } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { type IterationStatus, loadVisibleIteration } from '../iterations/iterations';
import { parseTaskKey } from '../links/syntax';
import { loadRequirement } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import { type IterationOverview, iterationOverview, workdaysBetween } from './schedule';
import { hydrateTasks, orgToday, type TaskView } from './tasks';
```

2. `MemberTasks` 类型之后加：

```ts
export type TaskDetail = TaskView & {
  productKey: string;
  iteration: { id: string; name: string; status: IterationStatus } | null;
  createdAt: Date;
};

const TASK_NOT_FOUND = '任务不存在';

/** 任务详情：编号形如 PAN-T-12（大小写不敏感）。看不到所属产品时与不存在一样。 */
export async function getTaskByKey(db: Db, actor: Actor, key: string, opts: { today?: string } = {}): Promise<TaskDetail> {
  const parsed = parseTaskKey(key);
  if (!parsed) throw new AppError('not_found', TASK_NOT_FOUND);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({ t: tasks })
      .from(tasks)
      .innerJoin(products, eq(products.id, tasks.productId))
      .where(and(eq(products.key, parsed.productKey), eq(tasks.number, parsed.number), isNull(products.deletedAt)));
    if (!row || !(await productRoleOf(tx, actor, row.t.productId))) throw new AppError('not_found', TASK_NOT_FOUND);
    const [view] = await hydrateTasks(tx, actor, [row.t], opts.today ?? (await orgToday(tx, actor.orgId)));
    const [it] = row.t.iterationId
      ? await tx
          .select({ id: iterations.id, name: iterations.name, status: iterations.status })
          .from(iterations)
          .where(and(eq(iterations.id, row.t.iterationId), isNull(iterations.deletedAt)))
      : [];
    return { ...view!, productKey: parsed.productKey, iteration: it ?? null, createdAt: row.t.createdAt };
  });
}
```

- [ ] **Step 4: 需求详情与工作台带编号**

`packages/core/src/requirements/detail.ts`：

1. import 区加 `import { taskDisplayKey } from '../links/syntax';`
2. `RequirementDetail` 的 `tasks` 类型改为：

```ts
  tasks: Array<{ id: string; displayKey: string; title: string; assignee: MemberRef | null; status: 'todo' | 'doing' | 'done'; planStart: string | null; planDays: number | null }>;
```

3. 返回对象里的 `tasks:` 一行改为：

```ts
      tasks: taskRows.map((x) => ({
        id: x.id,
        displayKey: taskDisplayKey(product!.key, x.number),
        title: x.title,
        assignee: ref(x.assigneeMemberId),
        status: x.status,
        planStart: x.planStart,
        planDays: x.planDays,
      })),
```

`packages/core/src/workbench/workbench.ts`：

1. `WorkbenchTask` 类型在 `id: string;` 之后加 `displayKey: string;`
2. `myTasks` 的映射在 `id: v.id,` 之后加 `displayKey: v.displayKey,`

`apps/web/src/features/workbench/model.test.ts`：`const base = { … }` 里在 `id: 't1',` 之后加 `displayKey: 'PAN-T-1',`。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/task-numbers.test.ts test/workbench.test.ts test/tasks.test.ts test/task-queries.test.ts test/requirements.test.ts && pnpm typecheck && pnpm --filter @flower/web test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/tasks/tasks.ts packages/core/src/tasks/queries.ts packages/core/src/requirements/detail.ts packages/core/src/workbench/workbench.ts packages/core/test/task-numbers.test.ts packages/core/test/workbench.test.ts apps/web/src/features/workbench/model.test.ts
git commit -m "feat(core): 任务视图带 PAN-T-n 编号，按编号读取任务；需求详情与工作台显示任务编号

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: 链接写入：来源保存时解析 `[[ ]]` 并重建

**Files:**
- Create: `packages/core/src/links/links.ts`
- Modify: `packages/core/src/requirements/requirements.ts`（新建、改描述）、`packages/core/src/requirements/comments.ts`（新建评论）
- Modify: `packages/core/src/documents/documents.ts`（新建、保存、恢复、转换）、`packages/core/src/documents/comments.ts`（新建评论）
- Modify: `packages/core/src/index.ts`
- Modify: `packages/migrate/src/write.ts`（`--replace` 删除组织数据时一并删除 `entity_links`）
- Test: `packages/core/test/links.test.ts`、`packages/migrate/test/write.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseWikilinks`、`classifyTarget`、`canonicalText`、`linkContext`；Task 2 `entityLinks`；现有 `splitSections`、`productKeyOf`
- Produces:
  - `type LinkSource = { type: LinkSourceType; id: string; productKey: string }`
  - `type ResolvedTarget = { targetType: LinkTargetType; targetId: string | null; targetSection: string | null; targetText: string }`
  - `syncSourceLinks(tx: Tx, orgId: string, source: LinkSource, text: string, opts?: { markdown?: boolean }): Promise<number>`（删除该来源全部 `wikilink` 行后重建，返回写入条数；`markdown: true` 时记录所在小节；已存在的组合保留原 `created_at`）
  - 写入时机：`createRequirement`、`updateRequirement`（描述变化时）、`createDocument`（Flower 内文档）、`saveDocumentContent`、`restoreRevision`、`convertExternalDocument`、`addRequirementComment`、`addDocumentComment`
  - 迁移工具 `deleteOrgData` 删除该组织的 `entity_links`（导入不写、正常使用会写的租户表；不删时 `--replace` 删除组织行会因外键失败）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/links.test.ts`：

```ts
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entityAliases, entityLinks } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addDocumentComment } from '../src/documents/comments';
import { convertExternalDocument, createDocument, type DocumentDetail, restoreRevision, saveDocumentContent } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createIteration, type IterationView } from '../src/iterations/iterations';
import type { LinkSourceType } from '../src/links/syntax';
import { addRequirementComment } from '../src/requirements/comments';
import { createRequirement, type RequirementListItem, updateRequirement } from '../src/requirements/requirements';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createStructureNode } from '../src/structure/nodes';
import { createTask, type TaskView } from '../src/tasks/tasks';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, regularIteration, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let pan: string;
let doc: string;
let login: RequirementListItem;
let docReq: RequirementListItem;
let prd: DocumentDetail;
let sprint: IterationView;
let special: IterationView;
let task: TaskView;
let pay: StructureNodeView;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  editor = await asMember(t.db, owner, '编辑乙');
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  login = await createRequirement(t.db, owner, pan, { title: '登录改版' }); // PAN-1
  docReq = await createRequirement(t.db, owner, doc, { title: '文档需求' }); // DOC-1
  prd = await createDocument(t.db, owner, pan, { title: '登录 PRD' }); // PAN-PRD-1
  sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0316', '2026-03-02', '2026-03-13'));
  special = await createIteration(t.db, owner, { type: 'special', name: '专项一', startDate: '2026-03-02', endDate: '2026-03-20' });
  task = await createTask(t.db, owner, { iterationId: sprint.id, title: '登录联调' }); // PAN-T-1
  const top = await createStructureNode(t.db, owner, pan, { name: '会员' });
  pay = await createStructureNode(t.db, owner, pan, { parentId: top.id, name: '支付' });
  await withOrg(t.db, owner.orgId, (tx) => tx.insert(entityAliases).values({ orgId: owner.orgId, entityType: 'requirement', entityId: login.id, alias: 'X2026' }));
});
afterAll(() => t.cleanup());

const linksOf = (type: LinkSourceType, id: string) =>
  withOrg(t.db, owner.orgId, (tx) =>
    tx
      .select()
      .from(entityLinks)
      .where(and(eq(entityLinks.sourceType, type), eq(entityLinks.sourceId, id)))
      .orderBy(asc(entityLinks.targetText)),
  );

describe('链接写入', () => {
  it('需求描述：新建与修改描述时解析并重建；各类目标、旧编号、悬空、去重、上下文；代码里的不算', async () => {
    const src = await createRequirement(t.db, owner, pan, {
      title: '引用方',
      description:
        '依赖 [[PAN-1]] 与 [[pan-1|登录]]。文档见 [[PAN-PRD-1#需求说明]]，任务 [[PAN-T-1]]。\n排期 [[迭代:迭代0316]]、[[迭代:专项一]]，模块 [[会员/支付]]，旧编号 [[X2026]]，跨产品 [[DOC-1]]，还没有的 [[PAN-99]]。`[[PAN-2]]` 不算。',
    });
    const rows = await linksOf('requirement', src.id);
    expect(Object.fromEntries(rows.map((r) => [r.targetText, [r.targetType, r.targetId, r.targetSection]]))).toEqual({
      'PAN-1': ['requirement', login.id, null],
      'PAN-PRD-1#需求说明': ['document', prd.id, '需求说明'],
      'PAN-T-1': ['task', task.id, null],
      'PAN/迭代:迭代0316': ['iteration', sprint.id, null],
      'PAN/迭代:专项一': ['iteration', special.id, null],
      'PAN/会员/支付': ['structure_node', pay.id, null],
      'PAN/X2026': ['requirement', login.id, null],
      'DOC-1': ['requirement', docReq.id, null],
      'PAN-99': ['requirement', null, null],
    });
    expect(rows.find((r) => r.targetText === 'PAN-1')).toMatchObject({ context: '依赖 [[PAN-1]] 与 [[pan-1|登录]]。', sourceSection: null, origin: 'wikilink' });
    const kept = rows.find((r) => r.targetText === 'PAN-T-1')!.createdAt;

    await updateRequirement(t.db, owner, src.id, { description: '只剩 [[PAN-T-1]]' });
    const after = await linksOf('requirement', src.id);
    expect(after.map((r) => r.targetText)).toEqual(['PAN-T-1']);
    expect(after[0]!.createdAt).toEqual(kept);
    await updateRequirement(t.db, owner, src.id, { title: '只改标题' });
    expect(await linksOf('requirement', src.id)).toHaveLength(1);
  });

  it('PRD 正文：保存、恢复、转为 Flower 文档时重建；记录所在小节', async () => {
    const d = await createDocument(t.db, owner, pan, { title: '引用 PRD' });
    await saveDocumentContent(t.db, owner, d.id, {
      baseVersion: 1,
      markdown: '开头 [[PAN-1]]\n\n## 1. 背景\n\n见 [[PAN-1]]\n\n```\n[[PAN-T-1]]\n```\n\n## 2. 方案\n\n[[迭代:迭代0316]]',
    });
    const rows = (await linksOf('document', d.id)).map((r) => [r.sourceSection, r.targetText]);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([[null, 'PAN-1'], ['1. 背景', 'PAN-1'], ['2. 方案', 'PAN/迭代:迭代0316']]));
    // 换一个作者保存，避免与上一次保存合并为同一条修订
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 2, markdown: '## 1. 背景\n\n没有引用' });
    expect(await linksOf('document', d.id)).toHaveLength(0);
    await restoreRevision(t.db, owner, d.id, { number: 1, baseVersion: 3 });
    expect(await linksOf('document', d.id)).toHaveLength(3);
    const ext = await createDocument(t.db, owner, pan, { title: '外部', externalUrl: 'https://docs.qq.com/doc/links' });
    await convertExternalDocument(t.db, owner, ext.id, { baseVersion: 1, markdown: '转换后引用 [[DOC-1]]' });
    expect((await linksOf('document', ext.id)).map((r) => r.targetText)).toEqual(['DOC-1']);
  });

  it('评论：需求评论与 PRD 评论新建时写链接', async () => {
    const c = await addRequirementComment(t.db, owner, login.id, { body: '参考 [[PAN-PRD-1]]' });
    expect(await linksOf('comment', c.id)).toMatchObject([{ targetType: 'document', targetId: prd.id, targetText: 'PAN-PRD-1', targetSection: null, context: '参考 [[PAN-PRD-1]]' }]);
    const dc = await addDocumentComment(t.db, editor, prd.id, { body: '对应 [[PAN-T-1]]' });
    expect(await linksOf('comment', dc.id)).toMatchObject([{ targetType: 'task', targetId: task.id }]);
  });
});
```

`packages/migrate/test/write.test.ts`：`@flower/core` 的 import 列表按字母序加入 `entityLinks`；「导入后有过正常使用……仍可以 replace」用例里，`await addRequirementComment(t.db, actor, created.id, { body: '导入后的评论' });` 之后加：

```ts
    await addRequirementComment(t.db, actor, created.id, { body: '引用 [[PAN-1]]' });
    expect(await t.adminDb.select().from(entityLinks)).toHaveLength(1);
```

并在 `expect(await t.adminDb.select().from(iterationScopeSnapshots)).toEqual([]);` 之后加：

```ts
    expect(await t.adminDb.select().from(entityLinks)).toEqual([]);
```

Run: `pnpm --filter @flower/core exec vitest run test/links.test.ts`
Expected: FAIL（来源保存时没有写 `entity_links`，查询结果为空）。

Run: `pnpm --filter @flower/migrate exec vitest run test/write.test.ts`
Expected: FAIL（评论没有写链接，`toHaveLength(1)` 不成立）。

- [ ] **Step 2: 实现解析与重建**

新建 `packages/core/src/links/links.ts`：

```ts
import { and, asc, eq, isNull } from 'drizzle-orm';
import { documents, entityAliases, entityLinks, iterations, products, requirements, structureNodes, tasks } from '../db/schema';
import type { Tx } from '../db/tx';
import { splitSections } from '../documents/markdown';
import { canonicalText, classifyTarget, linkContext, type LinkSourceType, type LinkTargetType, parseWikilinks } from './syntax';

export type LinkSource = { type: LinkSourceType; id: string; productKey: string };
export type ResolvedTarget = { targetType: LinkTargetType; targetId: string | null; targetSection: string | null; targetText: string };

type NodeRef = { id: string; parentId: string | null; name: string };

/** 一次重建内的解析器：缓存本组织的产品与各产品的结构树节点。在来源对象的写事务里使用（RLS 限定为本组织）。 */
class Resolver {
  private productByKey: Map<string, string> | null = null;
  private readonly nodesByProduct = new Map<string, NodeRef[]>();

  constructor(private readonly tx: Tx) {}

  private async productId(key: string): Promise<string | null> {
    if (!this.productByKey) {
      const rows = await this.tx.select({ id: products.id, key: products.key }).from(products).where(isNull(products.deletedAt));
      this.productByKey = new Map(rows.map((p) => [p.key, p.id]));
    }
    return this.productByKey.get(key.toUpperCase()) ?? null;
  }

  private async node(productId: string, path: string[]): Promise<string | null> {
    if (path.length === 0) return null;
    let all = this.nodesByProduct.get(productId);
    if (!all) {
      all = await this.tx
        .select({ id: structureNodes.id, parentId: structureNodes.parentId, name: structureNodes.name })
        .from(structureNodes)
        .where(eq(structureNodes.productId, productId));
      this.nodesByProduct.set(productId, all);
    }
    let parent: string | null = null;
    for (const name of path) {
      const hit = all.find((n) => n.parentId === parent && n.name === name);
      if (!hit) return null;
      parent = hit.id;
    }
    return parent;
  }

  private async alias(text: string): Promise<string | null> {
    const [a] = await this.tx
      .select({ id: entityAliases.entityId })
      .from(entityAliases)
      .where(and(eq(entityAliases.alias, text), eq(entityAliases.entityType, 'requirement')));
    return a?.id ?? null;
  }

  async resolve(target: string, sourceProductKey: string): Promise<ResolvedTarget> {
    const t = classifyTarget(target);
    const targetText = canonicalText(t, sourceProductKey);
    const out = (targetType: LinkTargetType, targetId: string | null, targetSection: string | null = null): ResolvedTarget => ({ targetType, targetId, targetSection, targetText });
    switch (t.kind) {
      case 'requirement': {
        const pid = await this.productId(t.productKey);
        const [r] = pid
          ? await this.tx.select({ id: requirements.id }).from(requirements).where(and(eq(requirements.productId, pid), eq(requirements.number, t.number)))
          : [];
        return out('requirement', r?.id ?? (await this.alias(target.trim())));
      }
      case 'document': {
        const pid = await this.productId(t.productKey);
        const [d] = pid ? await this.tx.select({ id: documents.id }).from(documents).where(and(eq(documents.productId, pid), eq(documents.number, t.number))) : [];
        return out('document', d?.id ?? null, t.section);
      }
      case 'task': {
        const pid = await this.productId(t.productKey);
        const [x] = pid ? await this.tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.productId, pid), eq(tasks.number, t.number))) : [];
        return out('task', x?.id ?? null);
      }
      case 'iteration': {
        const pid = await this.productId(t.productKey ?? sourceProductKey);
        const [own] = pid
          ? await this.tx
              .select({ id: iterations.id })
              .from(iterations)
              .where(and(eq(iterations.productId, pid), eq(iterations.name, t.name), isNull(iterations.deletedAt)))
          : [];
        if (own) return out('iteration', own.id);
        const [special] = await this.tx
          .select({ id: iterations.id })
          .from(iterations)
          .where(and(eq(iterations.type, 'special'), eq(iterations.name, t.name), isNull(iterations.deletedAt)))
          .orderBy(asc(iterations.createdAt))
          .limit(1);
        return out('iteration', special?.id ?? null);
      }
      case 'path': {
        if (t.segments.length === 1) {
          const aliased = await this.alias(t.segments[0]!);
          if (aliased) return out('requirement', aliased);
        }
        const [head, ...rest] = targetText.split('/');
        const pid = await this.productId(head!);
        let id = pid ? await this.node(pid, rest) : null;
        // 首段形似产品前缀、但没有这个产品时，按来源产品内的完整路径再找一次（如名为「API」的业务域）
        if (!id && !pid) {
          const own = await this.productId(sourceProductKey);
          id = own ? await this.node(own, t.segments) : null;
        }
        return out('structure_node', id);
      }
    }
  }
}

/** PRD 正文里各小节的起始位置与原始标题（第一个标题之前的内容标题为空）。 */
function sectionStarts(body: string): Array<{ start: number; heading: string | null }> {
  const out: Array<{ start: number; heading: string | null }> = [];
  let at = 0;
  for (const s of splitSections(body)) {
    const start = body.indexOf(s.markdown, at);
    out.push({ start, heading: s.heading });
    at = start + s.markdown.length;
  }
  return out;
}

/**
 * 重建一个来源的 [[ ]] 链接：删除该来源全部 wikilink 行后按正文重新解析写入，在来源对象的写事务里调用。
 * 同一小节内指向同一规范写法的只记一条；已存在的组合保留原来的 created_at（「被引用」显示第一次引用的时间）。
 */
export async function syncSourceLinks(tx: Tx, orgId: string, source: LinkSource, text: string, opts: { markdown?: boolean } = {}): Promise<number> {
  const body = text.replace(/\r\n?/g, '\n');
  const mine = and(eq(entityLinks.sourceType, source.type), eq(entityLinks.sourceId, source.id), eq(entityLinks.origin, 'wikilink'));
  const before = await tx.select({ sourceSection: entityLinks.sourceSection, targetText: entityLinks.targetText, createdAt: entityLinks.createdAt }).from(entityLinks).where(mine);
  const firstSeen = new Map(before.map((r) => [`${r.sourceSection ?? ''}\u0000${r.targetText}`, r.createdAt]));
  await tx.delete(entityLinks).where(mine);
  const sections = opts.markdown ? sectionStarts(body) : [];
  const resolver = new Resolver(tx);
  const seen = new Set<string>();
  const values: Array<typeof entityLinks.$inferInsert> = [];
  for (const link of parseWikilinks(body)) {
    const sourceSection = sections.filter((s) => s.start <= link.start).at(-1)?.heading ?? null;
    const resolved = await resolver.resolve(link.target, source.productKey);
    const key = `${sourceSection ?? ''}\u0000${resolved.targetText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({
      orgId,
      sourceType: source.type,
      sourceId: source.id,
      sourceSection,
      ...resolved,
      context: linkContext(body, link.start, link.end),
      origin: 'wikilink',
      createdAt: firstSeen.get(key) ?? new Date(),
    });
  }
  if (values.length > 0) await tx.insert(entityLinks).values(values);
  return values.length;
}
```

`packages/core/src/index.ts` 在 `export * from './links/syntax';` 之后加 `export * from './links/links';`。

- [ ] **Step 3: 在来源对象的写操作里调用**

`packages/core/src/requirements/requirements.ts`：

1. import 区加 `import { syncSourceLinks } from '../links/links';`
2. `createRequirement` 中 `for (const [field, ids] of values) await replaceFieldValues(…);` 一行之后加：

```ts
    await syncSourceLinks(tx, actor.orgId, { type: 'requirement', id: row!.id, productKey: seq!.key }, description);
```

3. `updateRequirement` 中 `const [row] = await tx.update(requirements)…returning();` 之后加：

```ts
    if (next.description !== cur.description) {
      await syncSourceLinks(tx, actor.orgId, { type: 'requirement', id: requirementId, productKey: await productKeyOf(tx, cur.productId) }, next.description);
    }
```

`packages/core/src/requirements/comments.ts`：

1. import 区加 `import { syncSourceLinks } from '../links/links';`，并把 `import type { MemberRef } from './requirements';` 改为 `import { type MemberRef, productKeyOf } from './requirements';`
2. `addRequirementComment` 中 `await tx.insert(commentReads)…;` 一行之后加：

```ts
    await syncSourceLinks(tx, actor.orgId, { type: 'comment', id: row!.id, productKey: await productKeyOf(tx, req.productId) }, body);
```

`packages/core/src/documents/documents.ts`：

1. import 区加 `import { syncSourceLinks } from '../links/links';`
2. `createDocument` 中 `if (!external) { … }` 块内、`await tx.update(documents).set({ currentRevisionId: rev.id })…;` 之后加：

```ts
      await syncSourceLinks(tx, actor.orgId, { type: 'document', id: doc.id, productKey: await productKeyOf(tx, productId) }, markdown, { markdown: true });
```

3. `saveDocumentContent` 中 `await reanchorDocumentComments(tx, id, markdown);` 之后加：

```ts
    await syncSourceLinks(tx, actor.orgId, { type: 'document', id, productKey: await productKeyOf(tx, doc.productId) }, markdown, { markdown: true });
```

4. `restoreRevision` 中 `await reanchorDocumentComments(tx, id, snapshot.markdown);` 之后加：

```ts
    await syncSourceLinks(tx, actor.orgId, { type: 'document', id, productKey: await productKeyOf(tx, doc.productId) }, snapshot.markdown, { markdown: true });
```

5. `convertExternalDocument` 中 `await tx.update(documents).set({ source: 'native', … })…;` 之后加：

```ts
    await syncSourceLinks(tx, actor.orgId, { type: 'document', id, productKey: await productKeyOf(tx, doc.productId) }, markdown, { markdown: true });
```

`packages/core/src/documents/comments.ts`：

1. import 区加 `import { syncSourceLinks } from '../links/links';`，并把 `import type { MemberRef } from '../requirements/requirements';` 改为 `import { type MemberRef, productKeyOf } from '../requirements/requirements';`
2. `addDocumentComment` 中 `await tx.insert(commentReads)…;` 一行之后加：

```ts
    await syncSourceLinks(tx, actor.orgId, { type: 'comment', id: row!.id, productKey: await productKeyOf(tx, doc.productId) }, body);
```

`packages/migrate/src/write.ts` 的 `deleteOrgData`：把注释与下一行

```ts
  // 导入不写、但正常使用会写的租户表：迭代快照在需求/迭代之前删，Token 与邀请在成员之前删
  await tx.execute(sql`delete from ${core.iterationScopeSnapshots} where org_id = ${orgId}`);
```

改为

```ts
  // 导入不写、但正常使用会写的租户表：迭代快照在需求/迭代之前删，双链只引用组织、随时可删，Token 与邀请在成员之前删
  await tx.execute(sql`delete from ${core.iterationScopeSnapshots} where org_id = ${orgId}`);
  await tx.execute(sql`delete from ${core.entityLinks} where org_id = ${orgId}`);
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/links.test.ts test/requirements.test.ts test/comments.test.ts test/documents.test.ts test/document-comments.test.ts && pnpm --filter @flower/migrate exec vitest run test/write.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/links/links.ts packages/core/src/index.ts packages/core/src/requirements/requirements.ts packages/core/src/requirements/comments.ts packages/core/src/documents/documents.ts packages/core/src/documents/comments.ts packages/core/test/links.test.ts packages/migrate/src/write.ts packages/migrate/test/write.test.ts
git commit -m "feat(core): 需求描述、PRD 正文与评论保存时解析 [[ ]] 并重建链接

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 悬空链接自动接上

**Files:**
- Modify: `packages/core/src/links/links.ts`
- Modify: `packages/core/src/requirements/requirements.ts`、`packages/core/src/documents/documents.ts`、`packages/core/src/tasks/tasks.ts`、`packages/core/src/iterations/iterations.ts`、`packages/core/src/structure/nodes.ts`
- Test: `packages/core/test/links.test.ts`

**Interfaces:**
- Consumes: Task 2 `entityLinks`；Task 3 `taskDisplayKey`；Task 4 `links.ts`
- Produces:
  - `relinkDangling(tx: Tx, target: { type: LinkTargetType; id: string; texts: string[]; withSections?: boolean }): Promise<number>`（只更新 `target_id` 为空、类型相同、`target_text` 等于给定写法的行；`withSections` 时同时接上 `写法#…`）
  - `nodePathTexts(tx: Tx, productId: string): Promise<Map<string, string>>`（节点 id → `KEY/名称/路径`）
  - `relinkNodes(tx: Tx, productId: string, nodeIds: Iterable<string>): Promise<number>`
  - `iterationLinkTexts(tx: Tx, it: { type: 'regular' | 'special'; productId: string | null; name: string }): Promise<string[]>`
  - 接上时机：`createRequirement`、`createDocument`、`createTask`、`createIteration`、`updateIteration`（改名时）、`createStructureNode`、`updateStructureNode`（改名时，整棵子树）、`moveStructureNode`（整棵子树）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/links.test.ts`：

1. import 区：`createIteration, type IterationView` 改为 `createIteration, type IterationView, updateIteration`；`createStructureNode` 改为 `createStructureNode, moveStructureNode, updateStructureNode`。
2. 文件末尾加：

```ts
describe('悬空链接自动接上', () => {
  let neo: string;
  beforeAll(async () => {
    neo = (await createProduct(t.db, owner, { name: '新产品', key: 'NEW' })).id;
  });
  const targetIds = async (sourceId: string) => Object.fromEntries((await linksOf('requirement', sourceId)).map((x) => [x.targetText, x.targetId]));

  it('新建需求、PRD（含指向小节的链接）、任务、迭代（含专项）、节点后接上', async () => {
    const src = await createRequirement(t.db, owner, pan, {
      title: '先引用后创建',
      description: '[[NEW-1]] [[NEW-PRD-1]] [[NEW-PRD-1#方案]] [[NEW-T-1]] [[NEW/迭代:一期]] [[NEW/会员/支付]] [[迭代:新专项]]',
    });
    expect(Object.values(await targetIds(src.id)).every((id) => id === null)).toBe(true);
    const r = await createRequirement(t.db, owner, neo, { title: '后建需求' });
    const d = await createDocument(t.db, owner, neo, { title: '后建 PRD' });
    const it1 = await createIteration(t.db, owner, regularIteration(neo, '一期', '2026-11-02', '2026-11-13'));
    const later = await createTask(t.db, owner, { iterationId: it1.id, title: '后建任务' });
    const top = await createStructureNode(t.db, owner, neo, { name: '会员' });
    const leaf = await createStructureNode(t.db, owner, neo, { parentId: top.id, name: '支付' });
    const sp = await createIteration(t.db, owner, { type: 'special', name: '新专项', startDate: '2026-11-02', endDate: '2026-11-20' });
    expect(await targetIds(src.id)).toEqual({
      'NEW-1': r.id,
      'NEW-PRD-1': d.id,
      'NEW-PRD-1#方案': d.id,
      'NEW-T-1': later.id,
      'NEW/迭代:一期': it1.id,
      'NEW/会员/支付': leaf.id,
      'PAN/迭代:新专项': sp.id,
    });
  });

  it('迭代改名、节点改名或移动后按新的写法接上；已接上的链接不受改名影响', async () => {
    const it2 = await createIteration(t.db, owner, regularIteration(neo, '二期', '2026-11-16', '2026-11-27'));
    const growth = await createStructureNode(t.db, owner, neo, { name: '增长中心' });
    const child = await createStructureNode(t.db, owner, neo, { parentId: growth.id, name: '拉新' });
    const oldDomain = await createStructureNode(t.db, owner, neo, { name: '旧域' });
    const moved = await createStructureNode(t.db, owner, neo, { parentId: oldDomain.id, name: '模块甲' });
    const newDomain = await createStructureNode(t.db, owner, neo, { name: '新域' });
    const src = await createRequirement(t.db, owner, pan, { title: '改名前后', description: '[[NEW/迭代:二期]] [[NEW/迭代:三期]] [[NEW/增长/拉新]] [[NEW/新域/模块甲]]' });
    expect(await targetIds(src.id)).toEqual({ 'NEW/迭代:二期': it2.id, 'NEW/迭代:三期': null, 'NEW/增长/拉新': null, 'NEW/新域/模块甲': null });
    await updateIteration(t.db, owner, it2.id, { name: '三期' });
    await updateStructureNode(t.db, owner, growth.id, { name: '增长' });
    await moveStructureNode(t.db, owner, moved.id, { parentId: newDomain.id });
    expect(await targetIds(src.id)).toEqual({ 'NEW/迭代:二期': it2.id, 'NEW/迭代:三期': it2.id, 'NEW/增长/拉新': child.id, 'NEW/新域/模块甲': moved.id });
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/links.test.ts`
Expected: 新增的两个用例 FAIL（目标新建后链接仍为空）。

- [ ] **Step 2: 实现接上**

`packages/core/src/links/links.ts`：import 改为

```ts
import { and, asc, eq, inArray, isNull, like, or } from 'drizzle-orm';
```

文件末尾加：

```ts
/**
 * 新建或改名的目标：把同组织内写法相同的悬空链接接上（只更新 target_id 为空的行）。
 * PRD 加 withSections，同时接上「写法#小节」。在目标的写事务里调用。
 */
export async function relinkDangling(tx: Tx, target: { type: LinkTargetType; id: string; texts: string[]; withSections?: boolean }): Promise<number> {
  if (target.texts.length === 0) return 0;
  const exact = inArray(entityLinks.targetText, target.texts);
  // 写法只含产品编号前缀、连字符与数字，用作 LIKE 前缀不需要转义
  const textMatch = target.withSections ? or(exact, ...target.texts.map((t) => like(entityLinks.targetText, `${t}#%`)))! : exact;
  const rows = await tx
    .update(entityLinks)
    .set({ targetId: target.id })
    .where(and(eq(entityLinks.targetType, target.type), isNull(entityLinks.targetId), textMatch))
    .returning({ id: entityLinks.id });
  return rows.length;
}

/** 产品内每个节点的规范写法：产品前缀 + 从顶层到该节点的名称路径。 */
export async function nodePathTexts(tx: Tx, productId: string): Promise<Map<string, string>> {
  const [p] = await tx.select({ key: products.key }).from(products).where(eq(products.id, productId));
  const nodes = await tx
    .select({ id: structureNodes.id, parentId: structureNodes.parentId, name: structureNodes.name })
    .from(structureNodes)
    .where(eq(structureNodes.productId, productId));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string>();
  for (const n of nodes) {
    const names: string[] = [];
    for (let cur: NodeRef | undefined = n; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) names.unshift(cur.name);
    out.set(n.id, [p!.key, ...names].join('/'));
  }
  return out;
}

/** 节点新建、改名或移动后，按新路径接上这些节点的悬空链接。 */
export async function relinkNodes(tx: Tx, productId: string, nodeIds: Iterable<string>): Promise<number> {
  const texts = await nodePathTexts(tx, productId);
  let n = 0;
  for (const id of nodeIds) {
    const text = texts.get(id);
    if (text) n += await relinkDangling(tx, { type: 'structure_node', id, texts: [text] });
  }
  return n;
}

/** 迭代可被引用的写法：常规迭代为所属产品的 `KEY/迭代:名称`；专项为组织内每个产品前缀的同名写法。 */
export async function iterationLinkTexts(tx: Tx, it: { type: 'regular' | 'special'; productId: string | null; name: string }): Promise<string[]> {
  const rows =
    it.type === 'regular'
      ? await tx.select({ key: products.key }).from(products).where(eq(products.id, it.productId!))
      : await tx.select({ key: products.key }).from(products).where(isNull(products.deletedAt));
  return rows.map((p) => `${p.key}/迭代:${it.name}`);
}
```

- [ ] **Step 3: 在目标的写操作里调用**

`packages/core/src/requirements/requirements.ts`：import 改为 `import { relinkDangling, syncSourceLinks } from '../links/links';`；`createRequirement` 中 Task 4 加的 `syncSourceLinks(…)` 一行之后加：

```ts
    await relinkDangling(tx, { type: 'requirement', id: row!.id, texts: [displayKey(seq!.key, row!.number)] });
```

`packages/core/src/documents/documents.ts`：import 改为 `import { relinkDangling, syncSourceLinks } from '../links/links';`；`createDocument` 中 `recordEvent(… 'document.created' …)` 之后、`if (input.requirementIds?.length)` 之前加：

```ts
    await relinkDangling(tx, { type: 'document', id: doc.id, texts: [documentDisplayKey(await productKeyOf(tx, productId), doc.number)], withSections: true });
```

`packages/core/src/tasks/tasks.ts`：import 区加 `import { relinkDangling } from '../links/links';`；`createTask` 中 `recordEvent(… 'task.created' …)` 之后加：

```ts
    await relinkDangling(tx, { type: 'task', id: row!.id, texts: [taskDisplayKey(seq!.key, row!.number)] });
```

`packages/core/src/iterations/iterations.ts`：import 区加 `import { iterationLinkTexts, relinkDangling } from '../links/links';`；

1. `createIteration` 中 `recordEvent(… 'iteration.created' …)` 之后加：

```ts
    await relinkDangling(tx, { type: 'iteration', id: row.id, texts: await iterationLinkTexts(tx, row) });
```

2. `updateIteration` 中 `if (changes.length > 0) { await recordEvent(…); }` 之后加：

```ts
    if (next.name !== cur.name) await relinkDangling(tx, { type: 'iteration', id, texts: await iterationLinkTexts(tx, row) });
```

`packages/core/src/structure/nodes.ts`：import 区加 `import { relinkNodes } from '../links/links';`；

1. `createStructureNode` 中 `recordEvent(… 'structure_node.created' …)` 之后加：

```ts
    await relinkNodes(tx, productId, [row.id]);
```

2. `updateStructureNode` 中 `if (changes.length > 0) { await recordEvent(…); }` 之后加：

```ts
    if (next.name !== cur.name) {
      const all = await tx.select({ id: structureNodes.id, parentId: structureNodes.parentId }).from(structureNodes).where(eq(structureNodes.productId, cur.productId));
      await relinkNodes(tx, cur.productId, subtreeIds(all, nodeId));
    }
```

3. `moveStructureNode` 中 `recordEvent(… 'structure_node.moved' …)` 之后加：

```ts
    await relinkNodes(tx, node.productId, subtree);
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/links.test.ts test/structure.test.ts test/iterations.test.ts test/tasks.test.ts test/documents.test.ts test/requirements.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/links/links.ts packages/core/src/requirements/requirements.ts packages/core/src/documents/documents.ts packages/core/src/tasks/tasks.ts packages/core/src/iterations/iterations.ts packages/core/src/structure/nodes.ts packages/core/test/links.test.ts
git commit -m "feat(core): 新建或改名的需求、PRD、任务、迭代、结构树节点接上悬空链接

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: 链接卡与「被引用」查询

**Files:**
- Create: `packages/core/src/links/cards.ts`、`packages/core/src/links/backlinks.ts`
- Modify: `packages/core/src/requirements/detail.ts`（描述的链接卡）、`packages/core/src/requirements/comments.ts`、`packages/core/src/documents/comments.ts`（评论的链接卡）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/link-queries.test.ts`

**Interfaces:**
- Consumes: Task 4 `syncSourceLinks`；Task 5 `nodePathTexts`；Task 1 `taskDisplayKey`、`normalizeHeading`；现有 `stateInfoByProduct`、`stateOf`、`ITERATION_STATUS_LABELS`、`DOCUMENT_STATUS_LABELS`、`documentDisplayKey`、`loadVisibleIteration`、`productRoleOf`、`visibleProductIds`
- Produces（`cards.ts`）:
  - `type LinkCardState = 'ok' | 'missing' | 'deleted' | 'canceled' | 'section_missing' | 'hidden'`
  - `type LinkCard = { text: string; targetType: LinkTargetType | null; state: LinkCardState; displayKey: string; title: string | null; status: { label: string; color: string | null } | null; href: string | null }`（`href` 为组织内相对地址，不含 `/{org}/`）
  - `sourceKey(type: LinkSourceType, id: string): string`（`${type}:${id}`）
  - `linkCardsFor(tx: Tx, actor: Actor, sources: Array<{ type: LinkSourceType; id: string }>): Promise<Map<string, LinkCard[]>>`（同一来源按 `text` 去重）
  - `listDocumentLinkCards(db, actor, documentId: string): Promise<LinkCard[]>`（PRD 不存在或看不到时 `not_found`「PRD 不存在」）
- Produces（`backlinks.ts`）:
  - `BACKLINK_TARGET_TYPES = ['requirement', 'document', 'task', 'iteration'] as const`，`type BacklinkTargetType`
  - `type BacklinkItem = { via: 'description' | 'body' | 'comment'; section: string | null; context: string; createdAt: Date }`
  - `type BacklinkGroup = { kind: 'requirement' | 'document'; id: string; displayKey: string; title: string; href: string; items: BacklinkItem[] }`
  - `listBacklinks(db, actor, target: { type: BacklinkTargetType; id: string }): Promise<BacklinkGroup[]>`（目标不存在或看不到时 `not_found`：「需求不存在」/「PRD 不存在」/「任务不存在」/「迭代不存在」）
- Produces（随原接口返回）: `RequirementDetail.links: LinkCard[]`；`CommentView.links: LinkCard[]`；`DocumentCommentView.links: LinkCard[]`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/link-queries.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addDocumentComment } from '../src/documents/comments';
import { createDocument, type DocumentDetail, saveDocumentContent } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createIteration, type IterationView } from '../src/iterations/iterations';
import { listBacklinks } from '../src/links/backlinks';
import { type LinkCard, listDocumentLinkCards } from '../src/links/cards';
import { addRequirementComment, listRequirementComments } from '../src/requirements/comments';
import { getRequirementByKey } from '../src/requirements/detail';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createRequirement, type RequirementListItem, updateRequirement } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { createTask, deleteTask, type TaskView } from '../src/tasks/tasks';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, regularIteration, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let guest: Actor;
let pan: string;
let doc: string;
let loginReq: RequirementListItem;
let docReq: RequirementListItem;
let prd: DocumentDetail;
let sprint: IterationView;
let task: TaskView;
let node: StructureNodeView;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  guest = await asMember(t.db, owner, '访客甲', 'guest');
  await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
  loginReq = await createRequirement(t.db, owner, pan, { title: '登录改版' }); // PAN-1
  docReq = await createRequirement(t.db, owner, doc, { title: '文档保密需求' }); // DOC-1
  prd = await createDocument(t.db, owner, pan, { title: '登录 PRD' }); // PAN-PRD-1
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: 1, markdown: '## 1. 背景\n\n现状\n\n## 2. 需求 说明\n\n内容' });
  sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0316', '2026-03-02', '2026-03-13'));
  task = await createTask(t.db, owner, { iterationId: sprint.id, title: '登录联调' }); // PAN-T-1
  const top = await createStructureNode(t.db, owner, pan, { name: '会员' });
  node = await createStructureNode(t.db, owner, pan, { parentId: top.id, name: '登录' });
});
afterAll(() => t.cleanup());

const byText = (cards: LinkCard[]) => Object.fromEntries(cards.map((c) => [c.text, c]));

describe('链接卡', () => {
  it('当前编号、标题与状态；悬空；小节有效与失效；跨产品无权限时只显示编号', async () => {
    const src = await createRequirement(t.db, owner, pan, {
      title: '引用方',
      description: '[[PAN-1|登录]] [[PAN-PRD-1#需求说明]] [[PAN-PRD-1#方案]] [[PAN-T-1]] [[迭代:迭代0316]] [[会员/登录]] [[DOC-1]] [[PAN-99]]',
    });
    const cards = byText((await getRequirementByKey(t.db, owner, src.displayKey)).links);
    expect(cards['PAN-1']).toEqual({
      text: 'PAN-1',
      targetType: 'requirement',
      state: 'ok',
      displayKey: 'PAN-1',
      title: '登录改版',
      status: { label: '待处理', color: '#94a3b8' },
      href: 'requirements/PAN-1',
    });
    expect(cards['PAN-PRD-1#需求说明']).toMatchObject({
      state: 'ok',
      displayKey: 'PAN-PRD-1#需求说明',
      title: '登录 PRD',
      status: { label: '草稿' },
      href: 'documents/PAN-PRD-1?section=%E9%9C%80%E6%B1%82%E8%AF%B4%E6%98%8E',
    });
    expect(cards['PAN-PRD-1#方案']).toMatchObject({ state: 'section_missing', displayKey: 'PAN-PRD-1#方案', href: 'documents/PAN-PRD-1' });
    expect(cards['PAN-T-1']).toMatchObject({ state: 'ok', displayKey: 'PAN-T-1', title: '登录联调', status: { label: '待开始' }, href: 'tasks/PAN-T-1' });
    expect(cards['PAN/迭代:迭代0316']).toMatchObject({ state: 'ok', displayKey: '迭代:迭代0316', status: { label: '规划中' }, href: `iterations/${sprint.id}` });
    expect(cards['PAN/会员/登录']).toMatchObject({ state: 'ok', displayKey: '会员/登录', href: `requirements?product=PAN&node=${node.id}` });
    expect(cards['DOC-1']).toMatchObject({ state: 'ok', title: '文档保密需求' });
    expect(cards['PAN-99']).toEqual({ text: 'PAN-99', targetType: 'requirement', state: 'missing', displayKey: 'PAN-99', title: null, status: null, href: null });

    const forGuest = byText((await getRequirementByKey(t.db, guest, src.displayKey)).links);
    expect(forGuest['DOC-1']).toEqual({ text: 'DOC-1', targetType: 'requirement', state: 'hidden', displayKey: 'DOC-1', title: null, status: null, href: null });
    expect(forGuest['PAN-1']!.title).toBe('登录改版');
  });

  it('目标改标题后链接不断；删除、取消后显示为已删除、已取消', async () => {
    const victim = await createRequirement(t.db, owner, pan, { title: '将被取消' });
    const gone = await createRequirement(t.db, owner, pan, { title: '将被删除' });
    const tmp = await createTask(t.db, owner, { iterationId: sprint.id, title: '将被删除的任务' });
    const src = await createRequirement(t.db, owner, pan, { title: '引用方二', description: `[[${victim.displayKey}]] [[${gone.displayKey}]] [[${tmp.displayKey}]] [[PAN-1]]` });
    await updateRequirement(t.db, owner, loginReq.id, { title: '登录改版二期' });
    await withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ stateKey: 'canceled' }).where(eq(requirements.id, victim.id)));
    await withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ deletedAt: new Date() }).where(eq(requirements.id, gone.id)));
    await deleteTask(t.db, owner, tmp.id);
    const cards = byText((await getRequirementByKey(t.db, owner, src.displayKey)).links);
    expect(cards['PAN-1']!.title).toBe('登录改版二期');
    expect(cards[victim.displayKey]).toMatchObject({ state: 'canceled', status: { label: '已取消' }, href: `requirements/${victim.displayKey}` });
    expect(cards[gone.displayKey]).toMatchObject({ state: 'deleted', href: null });
    expect(cards[tmp.displayKey]).toMatchObject({ state: 'deleted', title: null, href: null });
  });

  it('评论的链接卡随评论返回；PRD 正文的链接卡单独读取', async () => {
    const c = await addRequirementComment(t.db, owner, loginReq.id, { body: '参考 [[PAN-PRD-1]]' });
    expect(c.links).toMatchObject([{ text: 'PAN-PRD-1', state: 'ok', title: '登录 PRD' }]);
    expect((await listRequirementComments(t.db, owner, loginReq.id)).find((x) => x.id === c.id)!.links).toHaveLength(1);
    const dc = await addDocumentComment(t.db, owner, prd.id, { body: '对应 [[PAN-T-1]]' });
    expect(dc.links).toMatchObject([{ text: 'PAN-T-1', state: 'ok' }]);
    expect(await listDocumentLinkCards(t.db, owner, prd.id)).toEqual([]);
    await saveDocumentContent(t.db, owner, prd.id, { baseVersion: prd.version + 1, markdown: '## 1. 背景\n\n见 [[PAN-T-1]]\n\n## 2. 需求 说明\n\n内容' });
    expect(await listDocumentLinkCards(t.db, owner, prd.id)).toMatchObject([{ text: 'PAN-T-1', state: 'ok' }]);
  });
});

describe('「被引用」', () => {
  it('按来源对象分组：需求描述、PRD 小节、评论；看不到的来源不列出；不列自己；看不到目标时 404', async () => {
    const target = await createTask(t.db, owner, { iterationId: sprint.id, title: '被引用的任务' });
    const a = await createRequirement(t.db, owner, pan, { title: '描述引用', description: `依赖 [[${target.displayKey}]] 的联调。` });
    const d = await createDocument(t.db, owner, pan, { title: '正文引用' });
    await saveDocumentContent(t.db, owner, d.id, { baseVersion: 1, markdown: `## 1. 方案\n\n联调见 [[${target.displayKey}]]。` });
    await addRequirementComment(t.db, owner, a.id, { body: `再提一次 [[${target.displayKey}]]` });
    const hiddenSrc = await createRequirement(t.db, owner, doc, { title: '另一个产品里的引用', description: `[[${target.displayKey}]]` });

    const groups = await listBacklinks(t.db, owner, { type: 'task', id: target.id });
    expect(groups.map((g) => [g.kind, g.displayKey, g.href, g.items.map((i) => [i.via, i.section, i.context])])).toEqual([
      ['requirement', hiddenSrc.displayKey, `requirements/${hiddenSrc.displayKey}`, [['description', null, `[[${target.displayKey}]]`]]],
      ['requirement', a.displayKey, `requirements/${a.displayKey}`, [['comment', null, `再提一次 [[${target.displayKey}]]`], ['description', null, `依赖 [[${target.displayKey}]] 的联调。`]]],
      ['document', d.displayKey, `documents/${d.displayKey}`, [['body', '1. 方案', `联调见 [[${target.displayKey}]]。`]]],
    ]);
    expect(groups[1]!.items[0]!.createdAt).toBeInstanceOf(Date);
    expect((await listBacklinks(t.db, guest, { type: 'task', id: target.id })).map((g) => g.displayKey)).toEqual([a.displayKey, d.displayKey]);

    await updateRequirement(t.db, owner, a.id, { description: `自己 [[${a.displayKey}]]` });
    expect(await listBacklinks(t.db, owner, { type: 'requirement', id: a.id })).toEqual([]);
    await expect(listBacklinks(t.db, guest, { type: 'requirement', id: docReq.id })).rejects.toMatchObject({ code: 'not_found', message: '需求不存在' });
    await expect(listBacklinks(t.db, owner, { type: 'iteration', id: sprint.id })).resolves.toEqual(expect.any(Array));
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/link-queries.test.ts`
Expected: FAIL，找不到 `../src/links/backlinks`、`../src/links/cards`。

- [ ] **Step 2: 实现链接卡**

新建 `packages/core/src/links/cards.ts`：

```ts
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { documentRevisions, documents, entityLinks, iterations, products, requirements, structureNodes, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { DOCUMENT_STATUS_LABELS, documentDisplayKey, normalizeHeading, splitSections } from '../documents/markdown';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { ITERATION_STATUS_LABELS, stateInfoByProduct, stateOf } from '../iterations/iterations';
import { displayKey as requirementDisplayKey } from '../requirements/requirements';
import { nodePathTexts } from './links';
import { type LinkSourceType, type LinkTargetType, taskDisplayKey } from './syntax';

export type LinkCardState = 'ok' | 'missing' | 'deleted' | 'canceled' | 'section_missing' | 'hidden';
export type LinkCard = {
  /** 规范写法；页面用 canonicalWikiText 算出正文里 [[ ]] 的写法来找对应的卡。 */
  text: string;
  targetType: LinkTargetType | null;
  state: LinkCardState;
  displayKey: string;
  title: string | null;
  status: { label: string; color: string | null } | null;
  /** 组织内的相对地址（不含 /{org}/）；看不到、不存在或已删除时为空。 */
  href: string | null;
};

const TASK_STATUS_LABELS = { todo: '待开始', doing: '进行中', done: '已完成' } as const;

type LinkRow = typeof entityLinks.$inferSelect;
type Target = {
  productId: string | null;
  /** 需求、PRD、任务有编号；迭代与节点以名称为标识。 */
  numbered: boolean;
  state: 'ok' | 'deleted' | 'canceled';
  displayKey: string;
  title: string | null;
  status: LinkCard['status'];
  href: string | null;
  /** PRD 当前正文的小节标题（归一化后）。 */
  headings?: string[];
};

export const sourceKey = (type: LinkSourceType, id: string): string => `${type}:${id}`;

async function loadTargets(tx: Tx, rows: LinkRow[]): Promise<Map<string, Target>> {
  const out = new Map<string, Target>();
  const ids = (type: LinkTargetType) => [...new Set(rows.filter((r) => r.targetType === type && r.targetId).map((r) => r.targetId!))];
  const keyOf = new Map((await tx.select({ id: products.id, key: products.key }).from(products)).map((p) => [p.id, p.key]));

  const reqIds = ids('requirement');
  if (reqIds.length > 0) {
    const rs = await tx.select().from(requirements).where(inArray(requirements.id, reqIds));
    const info = await stateInfoByProduct(tx, rs.map((r) => r.productId));
    for (const r of rs) {
      const st = stateOf(info, r.productId, r.stateKey);
      const key = requirementDisplayKey(keyOf.get(r.productId)!, r.number);
      out.set(`requirement:${r.id}`, {
        productId: r.productId,
        numbered: true,
        state: r.deletedAt ? 'deleted' : st.category === 'canceled' ? 'canceled' : 'ok',
        displayKey: key,
        title: r.title,
        status: { label: st.label, color: st.color },
        href: r.deletedAt ? null : `requirements/${key}`,
      });
    }
  }

  const docIds = ids('document');
  if (docIds.length > 0) {
    const ds = await tx.select().from(documents).where(inArray(documents.id, docIds));
    const revIds = ds.map((d) => d.currentRevisionId).filter((x): x is string => !!x);
    const revs = revIds.length > 0 ? await tx.select({ id: documentRevisions.id, snapshot: documentRevisions.snapshot }).from(documentRevisions).where(inArray(documentRevisions.id, revIds)) : [];
    const headingsOf = new Map(revs.map((v) => [v.id, splitSections(v.snapshot.markdown).flatMap((s) => (s.heading ? [normalizeHeading(s.heading)] : []))]));
    for (const d of ds) {
      const key = documentDisplayKey(keyOf.get(d.productId)!, d.number);
      out.set(`document:${d.id}`, {
        productId: d.productId,
        numbered: true,
        state: d.deletedAt ? 'deleted' : d.status === 'discarded' ? 'canceled' : 'ok',
        displayKey: key,
        title: d.title,
        status: { label: DOCUMENT_STATUS_LABELS[d.status], color: null },
        href: d.deletedAt ? null : `documents/${key}`,
        headings: d.currentRevisionId ? (headingsOf.get(d.currentRevisionId) ?? []) : [],
      });
    }
  }

  const taskIds = ids('task');
  if (taskIds.length > 0) {
    for (const x of await tx.select().from(tasks).where(inArray(tasks.id, taskIds))) {
      const key = taskDisplayKey(keyOf.get(x.productId)!, x.number);
      out.set(`task:${x.id}`, { productId: x.productId, numbered: true, state: 'ok', displayKey: key, title: x.title, status: { label: TASK_STATUS_LABELS[x.status], color: null }, href: `tasks/${key}` });
    }
  }

  const iterIds = ids('iteration');
  if (iterIds.length > 0) {
    for (const i of await tx.select().from(iterations).where(inArray(iterations.id, iterIds))) {
      out.set(`iteration:${i.id}`, {
        productId: i.productId,
        numbered: false,
        state: i.deletedAt ? 'deleted' : i.status === 'canceled' ? 'canceled' : 'ok',
        displayKey: `迭代:${i.name}`,
        title: null,
        status: { label: ITERATION_STATUS_LABELS[i.status], color: null },
        href: i.deletedAt ? null : `iterations/${i.id}`,
      });
    }
  }

  const nodeIds = ids('structure_node');
  if (nodeIds.length > 0) {
    const ns = await tx.select().from(structureNodes).where(inArray(structureNodes.id, nodeIds));
    for (const pid of new Set(ns.map((n) => n.productId))) {
      const paths = await nodePathTexts(tx, pid);
      const key = keyOf.get(pid)!;
      for (const n of ns.filter((x) => x.productId === pid)) {
        out.set(`structure_node:${n.id}`, {
          productId: pid,
          numbered: false,
          state: n.status === 'deprecated' ? 'canceled' : 'ok',
          displayKey: paths.get(n.id)!.slice(key.length + 1),
          title: null,
          status: n.status === 'deprecated' ? { label: '已停用', color: null } : null,
          href: `requirements?product=${key}&node=${n.id}`,
        });
      }
    }
  }
  return out;
}

function toCard(row: LinkRow, t: Target | undefined, visible: boolean): LinkCard {
  const base = { text: row.targetText, targetType: row.targetType };
  const blank = { title: null, status: null, href: null };
  if (!row.targetId) return { ...base, state: 'missing', displayKey: row.targetText, ...blank };
  if (!t) return { ...base, state: 'deleted', displayKey: row.targetText, ...blank };
  if (!visible) return { ...base, state: 'hidden', displayKey: t.numbered ? t.displayKey : row.targetText, ...blank };
  const section = row.targetSection;
  const displayKey = section ? `${t.displayKey}#${section}` : t.displayKey;
  if (section && t.state === 'ok' && !(t.headings ?? []).includes(normalizeHeading(section))) {
    return { ...base, state: 'section_missing', displayKey, title: t.title, status: t.status, href: t.href };
  }
  return { ...base, state: t.state, displayKey, title: t.title, status: t.status, href: t.href && section ? `${t.href}?section=${encodeURIComponent(section)}` : t.href };
}

/** 一批来源的链接卡，按来源分组（键为 sourceKey），同一来源按规范写法去重。按查看者的产品权限决定能看到多少。 */
export async function linkCardsFor(tx: Tx, actor: Actor, sources: Array<{ type: LinkSourceType; id: string }>): Promise<Map<string, LinkCard[]>> {
  const out = new Map<string, LinkCard[]>(sources.map((s) => [sourceKey(s.type, s.id), []]));
  const rows: LinkRow[] = [];
  for (const type of new Set(sources.map((s) => s.type))) {
    const ids = sources.filter((s) => s.type === type).map((s) => s.id);
    rows.push(
      ...(await tx
        .select()
        .from(entityLinks)
        .where(and(eq(entityLinks.sourceType, type), inArray(entityLinks.sourceId, ids), eq(entityLinks.origin, 'wikilink')))),
    );
  }
  if (rows.length === 0) return out;
  const targets = await loadTargets(tx, rows);
  const roles = new Map<string, ProductRole | null>();
  let anyVisible: boolean | null = null;
  const canSee = async (t: Target): Promise<boolean> => {
    if (t.productId === null) {
      // 专项不属于产品：能看到任一产品的人都能看到（与迭代列表一致）
      anyVisible ??= (await visibleProductIds(tx, actor)).size > 0;
      return anyVisible;
    }
    if (!roles.has(t.productId)) roles.set(t.productId, await productRoleOf(tx, actor, t.productId));
    return roles.get(t.productId) !== null;
  };
  for (const row of rows) {
    const list = out.get(sourceKey(row.sourceType, row.sourceId))!;
    if (list.some((c) => c.text === row.targetText)) continue;
    const t = row.targetId ? targets.get(`${row.targetType}:${row.targetId}`) : undefined;
    list.push(toCard(row, t, t ? await canSee(t) : false));
  }
  return out;
}

/** PRD 正文的链接卡：与 PRD 详情分开读取，编辑器保存后单独刷新，不动详情里的正文缓存。 */
export async function listDocumentLinkCards(db: Db, actor: Actor, documentId: string): Promise<LinkCard[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [d] = await tx.select({ productId: documents.productId }).from(documents).where(and(eq(documents.id, documentId), isNull(documents.deletedAt)));
    if (!d || !(await productRoleOf(tx, actor, d.productId))) throw new AppError('not_found', 'PRD 不存在');
    return (await linkCardsFor(tx, actor, [{ type: 'document', id: documentId }])).get(sourceKey('document', documentId))!;
  });
}
```

- [ ] **Step 3: 实现「被引用」**

新建 `packages/core/src/links/backlinks.ts`：

```ts
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { comments, documents, entityLinks, products, requirements, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { documentDisplayKey } from '../documents/markdown';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { loadVisibleIteration } from '../iterations/iterations';
import { displayKey as requirementDisplayKey } from '../requirements/requirements';

export const BACKLINK_TARGET_TYPES = ['requirement', 'document', 'task', 'iteration'] as const;
export type BacklinkTargetType = (typeof BACKLINK_TARGET_TYPES)[number];
export type BacklinkItem = { via: 'description' | 'body' | 'comment'; section: string | null; context: string; createdAt: Date };
export type BacklinkGroup = { kind: 'requirement' | 'document'; id: string; displayKey: string; title: string; href: string; items: BacklinkItem[] };

const NOT_FOUND = { requirement: '需求不存在', document: 'PRD 不存在', task: '任务不存在' } as const;

/** 目标不存在或看不到时与不存在一样返回 404。 */
async function assertTargetVisible(tx: Tx, actor: Actor, target: { type: BacklinkTargetType; id: string }): Promise<void> {
  if (target.type === 'iteration') {
    await loadVisibleIteration(tx, target.id, await visibleProductIds(tx, actor));
    return;
  }
  const [row] =
    target.type === 'requirement'
      ? await tx.select({ productId: requirements.productId }).from(requirements).where(and(eq(requirements.id, target.id), isNull(requirements.deletedAt)))
      : target.type === 'document'
        ? await tx.select({ productId: documents.productId }).from(documents).where(and(eq(documents.id, target.id), isNull(documents.deletedAt)))
        : await tx.select({ productId: tasks.productId }).from(tasks).where(eq(tasks.id, target.id));
  if (!row || !(await productRoleOf(tx, actor, row.productId))) throw new AppError('not_found', NOT_FOUND[target.type]);
}

/**
 * 「被引用」：手写的 [[ ]] 链接，按来源对象（需求或 PRD；评论归到它所在的对象）分组，组与条目按时间倒序。
 * 不列对象引用自己；来源已删除或查看者看不到来源所在产品时不列。
 */
export async function listBacklinks(db: Db, actor: Actor, target: { type: BacklinkTargetType; id: string }): Promise<BacklinkGroup[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await assertTargetVisible(tx, actor, target);
    const rows = await tx
      .select()
      .from(entityLinks)
      .where(and(eq(entityLinks.targetType, target.type), eq(entityLinks.targetId, target.id), eq(entityLinks.origin, 'wikilink')))
      .orderBy(desc(entityLinks.createdAt), desc(entityLinks.id));
    const commentIds = rows.filter((r) => r.sourceType === 'comment').map((r) => r.sourceId);
    const commentRows =
      commentIds.length > 0
        ? await tx.select({ id: comments.id, targetType: comments.targetType, targetId: comments.targetId }).from(comments).where(inArray(comments.id, commentIds))
        : [];
    const parentOf = new Map(commentRows.map((c) => [c.id, c]));
    const refs: Array<{ kind: 'requirement' | 'document'; id: string; item: BacklinkItem }> = [];
    for (const r of rows) {
      const item = { section: r.sourceSection, context: r.context, createdAt: r.createdAt };
      if (r.sourceType === 'comment') {
        const c = parentOf.get(r.sourceId);
        if (c && (c.targetType === 'requirement' || c.targetType === 'document')) refs.push({ kind: c.targetType, id: c.targetId, item: { via: 'comment', ...item } });
      } else {
        refs.push({ kind: r.sourceType, id: r.sourceId, item: { via: r.sourceType === 'requirement' ? 'description' : 'body', ...item } });
      }
    }
    const reqIds = [...new Set(refs.filter((x) => x.kind === 'requirement').map((x) => x.id))];
    const docIds = [...new Set(refs.filter((x) => x.kind === 'document').map((x) => x.id))];
    const reqRows = reqIds.length > 0 ? await tx.select().from(requirements).where(and(inArray(requirements.id, reqIds), isNull(requirements.deletedAt))) : [];
    const docRows = docIds.length > 0 ? await tx.select().from(documents).where(and(inArray(documents.id, docIds), isNull(documents.deletedAt))) : [];
    const keyOf = new Map((await tx.select({ id: products.id, key: products.key }).from(products)).map((p) => [p.id, p.key]));
    const roles = new Map<string, ProductRole | null>();
    const canSee = async (pid: string): Promise<boolean> => {
      if (!roles.has(pid)) roles.set(pid, await productRoleOf(tx, actor, pid));
      return roles.get(pid) !== null;
    };
    const heads = new Map<string, Omit<BacklinkGroup, 'items'>>();
    for (const r of reqRows) {
      if (!(await canSee(r.productId))) continue;
      const key = requirementDisplayKey(keyOf.get(r.productId)!, r.number);
      heads.set(`requirement:${r.id}`, { kind: 'requirement', id: r.id, displayKey: key, title: r.title, href: `requirements/${key}` });
    }
    for (const d of docRows) {
      if (!(await canSee(d.productId))) continue;
      const key = documentDisplayKey(keyOf.get(d.productId)!, d.number);
      heads.set(`document:${d.id}`, { kind: 'document', id: d.id, displayKey: key, title: d.title, href: `documents/${key}` });
    }
    const groups = new Map<string, BacklinkGroup>();
    for (const ref of refs) {
      if (ref.kind === target.type && ref.id === target.id) continue;
      const k = `${ref.kind}:${ref.id}`;
      const head = heads.get(k);
      if (!head) continue;
      const g = groups.get(k) ?? { ...head, items: [] };
      g.items.push(ref.item);
      groups.set(k, g);
    }
    return [...groups.values()];
  });
}
```

`packages/core/src/index.ts` 在 `export * from './links/links';` 之后加：

```ts
export * from './links/cards';
export * from './links/backlinks';
```

- [ ] **Step 4: 链接卡随需求详情与评论返回**

`packages/core/src/requirements/detail.ts`：

1. import 区加 `import { type LinkCard, linkCardsFor, sourceKey } from '../links/cards';`
2. `RequirementDetail` 在 `description: string;` 之后加：

```ts
  /** 描述里 [[ ]] 的链接卡。 */
  links: LinkCard[];
```

3. `const ctx = { … }` 之前加：

```ts
    const links = (await linkCardsFor(tx, actor, [{ type: 'requirement', id: row.id }])).get(sourceKey('requirement', row.id))!;
```

返回对象在 `description: row.description,` 之后加 `links,`。

`packages/core/src/requirements/comments.ts`：

1. import 区加 `import { type LinkCard, linkCardsFor, sourceKey } from '../links/cards';`
2. `CommentView` 在 `read: boolean;` 之后加 `links: LinkCard[];`
3. `listRequirementComments` 中 `const names = …` 之后加：

```ts
    const cards = await linkCardsFor(tx, actor, rows.map((c) => ({ type: 'comment' as const, id: c.id })));
```

返回的对象在 `read: readSet.has(c.id),` 之后加 `links: cards.get(sourceKey('comment', c.id))!,`。

4. `addRequirementComment` 中 `const names = await memberNames(tx, [actor.memberId]);` 之后加：

```ts
    const cards = await linkCardsFor(tx, actor, [{ type: 'comment', id: row!.id }]);
```

返回对象在 `read: true,` 之后加 `links: cards.get(sourceKey('comment', row!.id))!,`。

`packages/core/src/documents/comments.ts`：

1. import 区加 `import { type LinkCard, linkCardsFor, sourceKey } from '../links/cards';`
2. `DocumentCommentView` 在 `createdAt: Date;` 之后加 `links: LinkCard[];`
3. `views` 改为带 `actor`：

```ts
async function views(tx: Tx, actor: Actor, rows: CommentRow[]): Promise<DocumentCommentView[]> {
  const names = await memberNames(tx, rows.flatMap((r) => [r.authorMemberId, r.resolvedBy]));
  const cards = await linkCardsFor(tx, actor, rows.map((c) => ({ type: 'comment' as const, id: c.id })));
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
    links: cards.get(sourceKey('comment', c.id))!,
  }));
}
```

并把 `listDocumentComments`、`addDocumentComment`、`setDocumentCommentResolved` 中的三处 `views(tx, …)` 改为 `views(tx, actor, …)`。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/link-queries.test.ts test/links.test.ts test/comments.test.ts test/document-comments.test.ts test/requirements.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/links/cards.ts packages/core/src/links/backlinks.ts packages/core/src/index.ts packages/core/src/requirements/detail.ts packages/core/src/requirements/comments.ts packages/core/src/documents/comments.ts packages/core/test/link-queries.test.ts
git commit -m "feat(core): 链接卡（标题、状态、灰色与无权限）与「被引用」查询

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `[[` 补全搜索

**Files:**
- Create: `packages/core/src/links/search.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/link-search.test.ts`

**Interfaces:**
- Consumes: Task 5 `nodePathTexts`；Task 1 `taskDisplayKey`、`normalizeHeading`；现有 `requireProductRole`、`visibleProductIds`、`documentDisplayKey`、`splitSections`
- Produces:
  - `SUGGESTIONS_PER_KIND = 6`
  - `type LinkSuggestion = { kind: LinkTargetType | 'section'; insert: string; displayKey: string; title: string; hint: string | null; next: 'insert' | 'sections' }`（`insert` 是 `[[ ]]` 里的写法；`next: 'sections'` 表示选中后继续选小节）
  - `searchLinkTargets(db, actor, input: { productId: string; q: string }): Promise<LinkSuggestion[]>`（需要来源产品的查看权限；编号以输入开头即匹配）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/link-search.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, saveDocumentContent } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createIteration } from '../src/iterations/iterations';
import { searchLinkTargets } from '../src/links/search';
import { createRequirement } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { createTask } from '../src/tasks/tasks';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, regularIteration, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let guest: Actor;
let pan: string;
let doc: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  guest = await asMember(t.db, owner, '访客甲', 'guest');
  await setProductRole(t.db, owner, doc, guest.memberId, 'viewer');
  await createRequirement(t.db, owner, pan, { title: '登录改版' }); // PAN-1
  await createRequirement(t.db, owner, pan, { title: '上传提速' }); // PAN-2
  await createRequirement(t.db, owner, doc, { title: '登录日志' }); // DOC-1
  const prd = await createDocument(t.db, owner, pan, { title: '登录 PRD' }); // PAN-PRD-1
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: 1, markdown: '## 1. 背景\n\n现状\n\n## 2. 需求 说明\n\n内容\n\n## 3. 需求说明\n\n同名的第二个' });
  const sprint = await createIteration(t.db, owner, regularIteration(pan, '登录迭代', '2026-03-02', '2026-03-13'));
  await createTask(t.db, owner, { iterationId: sprint.id, title: '登录联调' }); // PAN-T-1
  await createIteration(t.db, owner, { type: 'special', name: '登录专项', startDate: '2026-03-02', endDate: '2026-03-20' });
  await createIteration(t.db, owner, regularIteration(pan, '登录[旧]', '2026-04-01', '2026-04-10'));
  const top = await createStructureNode(t.db, owner, pan, { name: '会员' });
  await createStructureNode(t.db, owner, pan, { parentId: top.id, name: '登录' });
});
afterAll(() => t.cleanup());

describe('[[ 补全搜索', () => {
  it('按标题关键词：依次为需求、PRD、任务、迭代、节点，本产品优先；写不进 [[ ]] 的名称不出现', async () => {
    const list = await searchLinkTargets(t.db, owner, { productId: pan, q: '登录' });
    expect(list.map((s) => [s.kind, s.insert, s.title, s.next])).toEqual([
      ['requirement', 'PAN-1', '登录改版', 'insert'],
      ['requirement', 'DOC-1', '登录日志', 'insert'],
      ['document', 'PAN-PRD-1', '登录 PRD', 'sections'],
      ['task', 'PAN-T-1', '登录联调', 'insert'],
      ['iteration', '迭代:登录迭代', '2026-03-02 ~ 2026-03-13', 'insert'],
      ['iteration', '迭代:登录专项', '2026-03-02 ~ 2026-03-20', 'insert'],
      ['structure_node', '会员/登录', '', 'insert'],
    ]);
  });

  it('从其他产品引用时，迭代与节点带上产品前缀；专项不带', async () => {
    const list = await searchLinkTargets(t.db, owner, { productId: doc, q: '登录' });
    expect(list.map((s) => s.insert)).toEqual(['DOC-1', 'PAN-1', 'PAN-PRD-1', 'PAN-T-1', 'PAN/迭代:登录迭代', '迭代:登录专项', 'PAN/会员/登录']);
  });

  it('按编号前缀（大小写不敏感，可以只输入一部分）；查询为空时只给本产品最近更新的需求与 PRD', async () => {
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'pan-2' })).map((s) => s.insert)).toEqual(['PAN-2']);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'PAN-T-1' })).map((s) => s.insert)).toEqual(['PAN-T-1']);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'pan-prd-1' })).map((s) => s.insert)).toEqual(['PAN-PRD-1']);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'pan-prd' })).map((s) => s.insert)).toEqual(['PAN-PRD-1']);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: '' })).map((s) => s.insert)).toEqual(['PAN-2', 'PAN-1', 'PAN-PRD-1']);
  });

  it('PRD 小节：先给「整篇」，再给当前正文的小节（归一化标题，同名只列第一个），可按小节标题筛选', async () => {
    const secs = await searchLinkTargets(t.db, owner, { productId: pan, q: 'PAN-PRD-1#' });
    expect(secs.map((s) => [s.kind, s.insert, s.title, s.hint, s.next])).toEqual([
      ['document', 'PAN-PRD-1', '登录 PRD', '整篇', 'insert'],
      ['section', 'PAN-PRD-1#背景', '1. 背景', null, 'insert'],
      ['section', 'PAN-PRD-1#需求说明', '2. 需求 说明', null, 'insert'],
    ]);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'pan-prd-1#需求' })).map((s) => s.insert)).toEqual(['PAN-PRD-1', 'PAN-PRD-1#需求说明']);
  });

  it('只在能看到的产品里搜；需要来源产品的查看权限', async () => {
    expect((await searchLinkTargets(t.db, guest, { productId: doc, q: '登录' })).map((s) => s.insert)).toEqual(['DOC-1', '迭代:登录专项']);
    expect(await searchLinkTargets(t.db, guest, { productId: doc, q: 'PAN-PRD-1#' })).toEqual([]);
    await expect(searchLinkTargets(t.db, guest, { productId: pan, q: '登录' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
```

Run: `pnpm --filter @flower/core exec vitest run test/link-search.test.ts`
Expected: FAIL，找不到 `../src/links/search`。

- [ ] **Step 2: 实现搜索**

新建 `packages/core/src/links/search.ts`：

```ts
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { requireProductRole, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { documentRevisions, documents, iterations, products, requirements, structureNodes, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { documentDisplayKey, normalizeHeading, splitSections } from '../documents/markdown';
import type { Actor } from '../domain-types';
import { displayKey as requirementDisplayKey } from '../requirements/requirements';
import { nodePathTexts } from './links';
import { type LinkTargetType, taskDisplayKey } from './syntax';

export const SUGGESTIONS_PER_KIND = 6;

export type LinkSuggestion = {
  kind: LinkTargetType | 'section';
  /** [[ ]] 里的写法。 */
  insert: string;
  displayKey: string;
  title: string;
  hint: string | null;
  /** sections：选中后不闭合，继续选这份 PRD 的小节。 */
  next: 'insert' | 'sections';
};

const SECTION_QUERY = /^([A-Za-z][A-Za-z0-9]{1,9})-PRD-(\d{1,9})#(.*)$/i;
/** 名称里有这些字符时写不进 [[ ]]，不出现在补全里。 */
const UNLINKABLE = /[[\]|]/;

async function sectionSuggestions(tx: Tx, productId: string | undefined, number: number, partial: string, keyOf: Map<string, string>): Promise<LinkSuggestion[]> {
  if (!productId) return [];
  const [d] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.productId, productId), eq(documents.number, number), isNull(documents.deletedAt)));
  if (!d) return [];
  const key = documentDisplayKey(keyOf.get(productId)!, d.number);
  const out: LinkSuggestion[] = [{ kind: 'document', insert: key, displayKey: key, title: d.title, hint: '整篇', next: 'insert' }];
  const [rev] = d.currentRevisionId ? await tx.select({ snapshot: documentRevisions.snapshot }).from(documentRevisions).where(eq(documentRevisions.id, d.currentRevisionId)) : [];
  const want = normalizeHeading(partial);
  const seen = new Set<string>();
  for (const s of splitSections(rev?.snapshot.markdown ?? '')) {
    if (!s.heading) continue;
    const h = normalizeHeading(s.heading);
    if (!h || seen.has(h) || UNLINKABLE.test(h) || (want && !h.includes(want))) continue;
    seen.add(h);
    out.push({ kind: 'section', insert: `${key}#${h}`, displayKey: `${key}#${h}`, title: s.heading, hint: null, next: 'insert' });
  }
  return out;
}

/**
 * [[ 补全：只在查看者能看到的产品里搜。编号以输入开头（大小写不敏感，如 PAN-1、pan-prd、PAN-T-）或纯数字等于编号，
 * 或标题（任务另含别名、迭代与节点为名称）包含输入；需求与 PRD 本产品优先。查询为空时只给本产品最近更新的需求与 PRD。
 */
export async function searchLinkTargets(db: Db, actor: Actor, input: { productId: string; q: string }): Promise<LinkSuggestion[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, input.productId, 'viewer');
    const visible = [...(await visibleProductIds(tx, actor))];
    const prods = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, visible));
    const keyOf = new Map(prods.map((p) => [p.id, p.key]));
    const idOfKey = new Map(prods.map((p) => [p.key, p.id]));
    const own = input.productId;
    const q = input.q.trim();
    const sec = SECTION_QUERY.exec(q);
    if (sec) return sectionSuggestions(tx, idOfKey.get(sec[1]!.toUpperCase()), Number(sec[2]), sec[3]!, keyOf);
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const like = `%${escaped}%`;
    const prefix = `${escaped}%`;
    const digits = /^\d{1,9}$/.test(q) ? Number(q) : null;
    const out: LinkSuggestion[] = [];

    const reqRows = await tx
      .select({ r: requirements, key: products.key })
      .from(requirements)
      .innerJoin(products, eq(products.id, requirements.productId))
      .where(
        and(
          inArray(requirements.productId, visible),
          isNull(requirements.deletedAt),
          q
            ? or(ilike(requirements.title, like), ilike(sql`${products.key} || '-' || ${requirements.number}`, prefix), ...(digits === null ? [] : [eq(requirements.number, digits)]))
            : eq(requirements.productId, own),
        ),
      )
      .orderBy(sql`(${requirements.productId} = ${own}) desc`, desc(requirements.updatedAt), desc(requirements.number))
      .limit(SUGGESTIONS_PER_KIND);
    for (const { r, key } of reqRows) {
      const k = requirementDisplayKey(key, r.number);
      out.push({ kind: 'requirement', insert: k, displayKey: k, title: r.title, hint: null, next: 'insert' });
    }

    const docRows = await tx
      .select({ d: documents, key: products.key })
      .from(documents)
      .innerJoin(products, eq(products.id, documents.productId))
      .where(
        and(
          inArray(documents.productId, visible),
          eq(documents.kind, 'change'),
          isNull(documents.deletedAt),
          q
            ? or(ilike(documents.title, like), ilike(sql`${products.key} || '-PRD-' || ${documents.number}`, prefix), ...(digits === null ? [] : [eq(documents.number, digits)]))
            : eq(documents.productId, own),
        ),
      )
      .orderBy(sql`(${documents.productId} = ${own}) desc`, desc(documents.updatedAt), desc(documents.number))
      .limit(SUGGESTIONS_PER_KIND);
    for (const { d, key } of docRows) {
      const k = documentDisplayKey(key, d.number);
      out.push({ kind: 'document', insert: k, displayKey: k, title: d.title, hint: null, next: 'sections' });
    }
    if (!q) return out;

    const taskRows = await tx
      .select({ x: tasks, key: products.key })
      .from(tasks)
      .innerJoin(products, eq(products.id, tasks.productId))
      .where(
        and(
          inArray(tasks.productId, visible),
          or(ilike(tasks.title, like), ilike(tasks.alias, like), ilike(sql`${products.key} || '-T-' || ${tasks.number}`, prefix), ...(digits === null ? [] : [eq(tasks.number, digits)])),
        ),
      )
      .orderBy(sql`(${tasks.productId} = ${own}) desc`, desc(tasks.createdAt), desc(tasks.number))
      .limit(SUGGESTIONS_PER_KIND);
    for (const { x, key } of taskRows) {
      const k = taskDisplayKey(key, x.number);
      out.push({ kind: 'task', insert: k, displayKey: k, title: x.title, hint: null, next: 'insert' });
    }

    const iterRows = await tx
      .select()
      .from(iterations)
      .where(and(isNull(iterations.deletedAt), ilike(iterations.name, like), or(inArray(iterations.productId, visible), eq(iterations.type, 'special'))))
      .orderBy(sql`(${iterations.productId} = ${own}) desc nulls last`, desc(iterations.startDate))
      .limit(SUGGESTIONS_PER_KIND * 2);
    for (const i of iterRows.filter((x) => !UNLINKABLE.test(x.name)).slice(0, SUGGESTIONS_PER_KIND)) {
      const pre = i.productId && i.productId !== own ? `${keyOf.get(i.productId)}/` : '';
      const insert = `${pre}迭代:${i.name}`;
      out.push({ kind: 'iteration', insert, displayKey: insert, title: `${i.startDate} ~ ${i.endDate}`, hint: i.type === 'special' ? '专项' : null, next: 'insert' });
    }

    const nodeRows = await tx
      .select()
      .from(structureNodes)
      .where(and(inArray(structureNodes.productId, visible), ilike(structureNodes.name, like)))
      .orderBy(sql`(${structureNodes.productId} = ${own}) desc`, asc(structureNodes.depth), asc(structureNodes.sort))
      .limit(SUGGESTIONS_PER_KIND * 2);
    const paths = new Map<string, Map<string, string>>();
    let added = 0;
    for (const n of nodeRows) {
      if (added >= SUGGESTIONS_PER_KIND) break;
      if (!paths.has(n.productId)) paths.set(n.productId, await nodePathTexts(tx, n.productId));
      const full = paths.get(n.productId)!.get(n.id)!;
      const path = full.slice(keyOf.get(n.productId)!.length + 1);
      // 路径段数与层级不一致说明某一级名称里有「/」，同样写不进 [[ ]]
      if (UNLINKABLE.test(path) || path.split('/').length !== n.depth) continue;
      const insert = n.productId === own ? path : full;
      out.push({ kind: 'structure_node', insert, displayKey: insert, title: n.description ?? '', hint: null, next: 'insert' });
      added += 1;
    }
    return out;
  });
}
```

`packages/core/src/index.ts` 在 `export * from './links/backlinks';` 之后加 `export * from './links/search';`。

- [ ] **Step 3: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/link-search.test.ts && pnpm --filter @flower/core typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/core/src/links/search.ts packages/core/src/index.ts packages/core/test/link-search.test.ts
git commit -m "feat(core): [[ 补全搜索：编号前缀与标题关键词，PRD 小节，按可见产品过滤

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: 接口与前端数据层

**Files:**
- Create: `apps/web/src/server/routes/links.ts`
- Modify: `apps/web/src/server/api.ts`、`apps/web/src/server/routes/tasks.ts`
- Modify: `apps/web/src/lib/types.ts`、`apps/web/src/lib/queries.ts`
- Test: `apps/web/test/api/links.test.ts`

**Interfaces:**
- Consumes: Task 3 `getTaskByKey`、`TaskDetail`；Task 6 `listBacklinks`、`listDocumentLinkCards`、`LinkCard`、`BacklinkGroup`、`BacklinkTargetType`、`BACKLINK_TARGET_TYPES`；Task 7 `searchLinkTargets`、`LinkSuggestion`
- Produces（接口）:
  - `GET /orgs/:org/links/search?product={productId}&q=` → `{ suggestions: LinkSuggestion[] }`（缺 `product` 时 400「缺少产品」；`q` 截到 100 字）
  - `GET /orgs/:org/backlinks?type={requirement|document|task|iteration}&id=` → `{ groups: BacklinkGroup[] }`（参数无效 400「引用目标无效」）
  - `GET /orgs/:org/documents/:id/links` → `{ cards: LinkCard[] }`
  - `GET /orgs/:org/tasks/:key` → `{ task: TaskDetail }`
- Produces（`@/lib/types`）: `LinkCard`、`LinkSuggestion`、`BacklinkGroup`、`BacklinkTargetType`、`TaskDetail`
- Produces（`@/lib/queries`）:
  - `qk.backlinks(o, type, id)`、`qk.documentLinks(o, id)`、`qk.linkSearch(o, productId, q)`、`qk.task(o, key)`
  - `linkKeys(o) = ['org', o, 'links']`（链接卡、「被引用」、补全的公共前缀；任何会改链接的保存之后失效它）
  - `useBacklinks(o, type, id)`、`useDocumentLinks(o, documentId)`、`useLinkSearch(o, productId, q, enabled)`、`useTask(o, key)`

- [ ] **Step 1: 写失败的测试**

新建 `apps/web/test/api/links.test.ts`：

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

describe('链接接口', () => {
  it('需求描述的链接卡随详情返回；「被引用」；补全搜索', async () => {
    const target = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '登录改版' } })).body.requirement;
    const src = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '引用方', description: '依赖 [[PAN-1]]。' } })).body.requirement;
    const detail = await call(app, 'GET', `/orgs/acme/requirements/${src.displayKey}`, { session });
    expect(detail.body.requirement.links).toMatchObject([{ text: 'PAN-1', state: 'ok', title: '登录改版', href: 'requirements/PAN-1' }]);

    const back = await call(app, 'GET', `/orgs/acme/backlinks?type=requirement&id=${target.id}`, { session });
    expect(back.status).toBe(200);
    expect(back.body.groups).toMatchObject([{ kind: 'requirement', displayKey: 'PAN-2', items: [{ via: 'description', context: '依赖 [[PAN-1]]。' }] }]);
    expect((await call(app, 'GET', '/orgs/acme/backlinks?type=bogus&id=x', { session })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/backlinks?type=requirement&id=00000000-0000-7000-8000-000000000000', { session })).status).toBe(404);

    const search = await call(app, 'GET', `/orgs/acme/links/search?product=${productId}&q=${encodeURIComponent('登录')}`, { session });
    expect(search.body.suggestions[0]).toMatchObject({ kind: 'requirement', insert: 'PAN-1', next: 'insert' });
    expect((await call(app, 'GET', '/orgs/acme/links/search?q=x', { session })).status).toBe(400);
    expect((await call(app, 'GET', `/orgs/acme/links/search?product=${productId}&q=PAN`, { token: readToken })).status).toBe(200);
  });

  it('PRD 正文与评论的链接卡；按编号读取任务（只读 Token 可读）', async () => {
    const doc = (await call(app, 'POST', `/orgs/acme/products/${productId}/documents`, { session, body: { title: '登录 PRD' } })).body.document;
    await call(app, 'PUT', `/orgs/acme/documents/${doc.id}/content`, { session, body: { baseVersion: doc.version, markdown: '## 背景\n\n见 [[PAN-1]]' } });
    const cards = await call(app, 'GET', `/orgs/acme/documents/${doc.id}/links`, { session });
    expect(cards.body.cards).toMatchObject([{ text: 'PAN-1', state: 'ok' }]);
    const comment = await call(app, 'POST', `/orgs/acme/documents/${doc.id}/comments`, { session, body: { body: '对应 [[PAN-PRD-1#背景]]' } });
    expect(comment.body.comment.links).toMatchObject([{ text: 'PAN-PRD-1#背景', state: 'ok', href: 'documents/PAN-PRD-1?section=%E8%83%8C%E6%99%AF' }]);

    const iteration = (
      await call(app, 'POST', '/orgs/acme/iterations', { session, body: { type: 'regular', productId, name: '迭代0105', startDate: '2026-01-05', endDate: '2026-01-16' } })
    ).body.iteration;
    await call(app, 'POST', '/orgs/acme/tasks', { session, body: { iterationId: iteration.id, title: '联调' } });
    const task = await call(app, 'GET', '/orgs/acme/tasks/pan-t-1', { token: readToken });
    expect(task.status).toBe(200);
    expect(task.body.task).toMatchObject({ displayKey: 'PAN-T-1', title: '联调', iteration: { name: '迭代0105' } });
    expect((await call(app, 'GET', '/orgs/acme/tasks/PAN-T-9', { session })).status).toBe(404);
  });
});
```

Run: `pnpm --filter @flower/web exec vitest run test/api/links.test.ts`
Expected: FAIL（接口返回 404「接口不存在」）。

- [ ] **Step 2: 接口**

新建 `apps/web/src/server/routes/links.ts`：

```ts
import { AppError, BACKLINK_TARGET_TYPES, listBacklinks, listDocumentLinkCards, searchLinkTargets } from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';

const backlinkQuery = z.object({ type: z.enum(BACKLINK_TARGET_TYPES), id: z.string().min(1) });

export function registerLinkRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/links/search', async (c) => {
    const productId = c.req.query('product');
    if (!productId) throw new AppError('invalid', '缺少产品');
    const q = (c.req.query('q') ?? '').slice(0, 100);
    return c.json({ suggestions: await searchLinkTargets(deps.db, c.get('actor'), { productId, q }) });
  });

  app.get('/orgs/:org/backlinks', async (c) => {
    const parsed = backlinkQuery.safeParse({ type: c.req.query('type'), id: c.req.query('id') });
    if (!parsed.success) throw new AppError('invalid', '引用目标无效');
    return c.json({ groups: await listBacklinks(deps.db, c.get('actor'), parsed.data) });
  });

  app.get('/orgs/:org/documents/:id/links', async (c) => c.json({ cards: await listDocumentLinkCards(deps.db, c.get('actor'), c.req.param('id')) }));
}
```

`apps/web/src/server/api.ts`：import 区加 `import { registerLinkRoutes } from './routes/links';`，在 `registerTemplateRoutes(app, deps);` 之后加 `registerLinkRoutes(app, deps);`。

`apps/web/src/server/routes/tasks.ts`：import 列表加 `getTaskByKey`；在 `app.post('/orgs/:org/tasks', …)` 之前加：

```ts
  app.get('/orgs/:org/tasks/:key', async (c) => c.json({ task: await getTaskByKey(deps.db, c.get('actor'), c.req.param('key')) }));
```

- [ ] **Step 3: 前端类型与查询**

`apps/web/src/lib/types.ts`：`@flower/core` 的 `import type { … }` 列表里按字母序加入 `BacklinkGroup as CoreBacklinkGroup`、`BacklinkTargetType as CoreBacklinkTargetType`、`LinkCard as CoreLinkCard`、`LinkSuggestion as CoreLinkSuggestion`、`TaskDetail as CoreTaskDetail`；文件末尾加：

```ts
export type LinkCard = CoreLinkCard;
export type LinkSuggestion = CoreLinkSuggestion;
export type BacklinkTargetType = CoreBacklinkTargetType;
export type BacklinkGroup = Jsonify<CoreBacklinkGroup>;
export type TaskDetail = Jsonify<CoreTaskDetail>;
```

`apps/web/src/lib/queries.ts`：

1. `import type { … } from './types'` 列表里加入 `BacklinkGroup`、`BacklinkTargetType`、`LinkCard`、`LinkSuggestion`、`TaskDetail`。
2. `qk` 对象末尾（`templates` 之后）加：

```ts
  backlinks: (o: string, type: string, id: string) => ['org', o, 'links', 'backlinks', type, id] as const,
  documentLinks: (o: string, id: string) => ['org', o, 'links', 'document', id] as const,
  linkSearch: (o: string, productId: string, q: string) => ['org', o, 'links', 'search', productId, q] as const,
  task: (o: string, key: string) => ['org', o, 'tasks', 'detail', key] as const,
```

3. `useTemplates` 之后加：

```ts
/** 链接相关查询的公共前缀：需求描述、PRD 正文、评论保存后统一失效（链接卡、「被引用」、补全）。 */
export const linkKeys = (o: string) => ['org', o, 'links'] as const;

export const useBacklinks = (o: string, type: BacklinkTargetType, id: string) =>
  useQuery({
    queryKey: qk.backlinks(o, type, id),
    queryFn: () => api<{ groups: BacklinkGroup[] }>(`/orgs/${o}/backlinks?${new URLSearchParams({ type, id })}`),
    select: (d) => d.groups,
  });
export const useDocumentLinks = (o: string, id: string) =>
  useQuery({ queryKey: qk.documentLinks(o, id), queryFn: () => api<{ cards: LinkCard[] }>(`/orgs/${o}/documents/${id}/links`), select: (d) => d.cards });
export const useLinkSearch = (o: string, productId: string, q: string, enabled: boolean) =>
  useQuery({
    queryKey: qk.linkSearch(o, productId, q),
    queryFn: () => api<{ suggestions: LinkSuggestion[] }>(`/orgs/${o}/links/search?${new URLSearchParams({ product: productId, q })}`),
    select: (d) => d.suggestions,
    enabled,
    placeholderData: keepPreviousData,
  });
export const useTask = (o: string, key: string) =>
  useQuery({ queryKey: qk.task(o, key), queryFn: () => api<{ task: TaskDetail }>(`/orgs/${o}/tasks/${encodeURIComponent(key)}`), select: (d) => d.task });
```

（`qk.task` 在 `taskKeys(o)` 前缀之下，任务修改后由 `taskMutationKeys` 一并失效。）

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @flower/web exec vitest run test/api/links.test.ts test/api/tasks.test.ts test/api/requirements.test.ts test/api/documents.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/server/routes/links.ts apps/web/src/server/api.ts apps/web/src/server/routes/tasks.ts apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/test/api/links.test.ts
git commit -m "feat(web): 链接补全、「被引用」、PRD 链接卡与按编号读取任务的接口与查询

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 页面：任务编号显示、任务详情页与「被引用」区块组件

**Files:**
- Create: `apps/web/src/features/links/model.ts`、`apps/web/src/features/links/model.test.ts`
- Create: `apps/web/src/components/backlinks.tsx`
- Create: `apps/web/src/app/(app)/[org]/tasks/[key]/page.tsx`
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx`、`apps/web/src/app/(app)/[org]/workload/page.tsx`、`apps/web/src/app/(app)/[org]/requirements/[key]/side-lists.tsx`、`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`（给 `SideLists` 传 `org`）、`apps/web/src/app/(app)/[org]/page.tsx`
- Test: `apps/web/e2e/tasks.spec.ts`

**Interfaces:**
- Consumes: Task 8 `useTask`、`useBacklinks`、`TaskDetail`、`BacklinkGroup`、`BacklinkTargetType`；Task 3 `displayKey`（任务视图、需求详情任务、工作台任务）
- Produces:
  - `backlinkViaLabel(item: { via: 'description' | 'body' | 'comment'; section: string | null }): string`（`features/links/model.ts`）
  - `<Backlinks org={string} type={BacklinkTargetType} id={string} />`（区块名称「被引用 n」，空时「还没有被引用」）
  - 任务详情页 `/{org}/tasks/{PAN-T-n}`；甘特表、人员负载、需求详情侧栏的任务编号链接到该页面

- [ ] **Step 1: 写失败的测试**

新建 `apps/web/src/features/links/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { backlinkViaLabel } from './model';

describe('「被引用」的来源说明', () => {
  it('需求描述、PRD 小节（无小节时为正文）、评论', () => {
    expect(backlinkViaLabel({ via: 'description', section: null })).toBe('需求描述');
    expect(backlinkViaLabel({ via: 'body', section: '1. 方案' })).toBe('小节「1. 方案」');
    expect(backlinkViaLabel({ via: 'body', section: null })).toBe('正文');
    expect(backlinkViaLabel({ via: 'comment', section: null })).toBe('评论');
  });
});
```

新建 `apps/web/e2e/tasks.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createIteration, createProduct, createRequirement, createTask, expectNoPageOverflow, json, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('任务编号：甘特与人员负载显示 PAN-T-n，点进任务详情；详情显示字段与「被引用」', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  await createTask(request, { iterationId, requirementId: req.id, title: '前端开发', assigneeMemberId: me, planStart: '2026-01-05', planDays: 2 });
  await createTask(request, { iterationId, title: '联调' });
  await login(page, OWNER.email, OWNER.password);

  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
  await expect(page.getByRole('link', { name: 'PAN-T-2' })).toBeVisible();
  await page.getByRole('link', { name: 'PAN-T-1' }).click();
  await expect(page).toHaveURL(/\/acme\/tasks\/PAN-T-1$/);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('PAN-T-1');
  await expect(heading).toContainText('前端开发');
  const info = page.getByRole('region', { name: '任务信息' });
  await expect(info).toContainText('上传提速');
  await expect(info).toContainText('迭代0105');
  await expect(info).toContainText(OWNER.name);
  await expect(page.getByRole('region', { name: /被引用/ })).toContainText('还没有被引用');

  await page.goto(`/acme/workload?member=${me}`);
  await expect(page.getByRole('link', { name: 'PAN-T-1' })).toBeVisible();
  await page.goto(`/acme/requirements/${req.displayKey}`);
  await expect(page.getByRole('region', { name: '任务', exact: true }).getByRole('link', { name: /PAN-T-1/ })).toBeVisible();
  await page.goto('/acme');
  await expect(page.getByRole('region', { name: /我的任务/ }).getByRole('link', { name: /PAN-T-1/ })).toBeVisible();
});

test('任务不存在时提示；任务详情在 1440 与 760 宽度下不横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId, title: '一个名字很长很长很长很长很长很长很长很长很长很长很长很长很长的任务' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/tasks/PAN-T-99');
  await expect(page.getByText('任务不存在，或你没有查看它所在产品的权限。')).toBeVisible();
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/tasks/PAN-T-1');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('PAN-T-1');
    await expectNoPageOverflow(page);
  }
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/links/model.test.ts`
Expected: FAIL，找不到 `./model`。

Run: `pnpm --filter @flower/web e2e tasks.spec.ts`
Expected: FAIL（甘特里没有 `PAN-T-1` 链接）。

- [ ] **Step 2: 纯函数与「被引用」组件**

新建 `apps/web/src/features/links/model.ts`：

```ts
/** 「被引用」每一条的来源说明：需求描述 / PRD 的小节 / 评论。 */
export function backlinkViaLabel(item: { via: 'description' | 'body' | 'comment'; section: string | null }): string {
  if (item.via === 'description') return '需求描述';
  if (item.via === 'comment') return '评论';
  return item.section ? `小节「${item.section}」` : '正文';
}
```

新建 `apps/web/src/components/backlinks.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useId } from 'react';
import { QueryError } from '@/components/load-error';
import { Skeleton } from '@/components/ui/skeleton';
import { backlinkViaLabel } from '@/features/links/model';
import { formatDateTime } from '@/features/requirements/format';
import { useBacklinks } from '@/lib/queries';
import type { BacklinkTargetType } from '@/lib/types';

/** 「被引用」区块：别处手写的 [[ ]] 引用，按来源对象分组，每条显示来源、上下文与时间。 */
export function Backlinks({ org, type, id }: { org: string; type: BacklinkTargetType; id: string }) {
  const q = useBacklinks(org, type, id);
  const titleId = useId();
  const count = q.data?.reduce((n, g) => n + g.items.length, 0);
  return (
    <section className="min-w-0 rounded-md border bg-card p-4" aria-labelledby={titleId}>
      <h2 id={titleId} className="mb-2 text-sm font-semibold">
        被引用 {count !== undefined && <span className="font-mono text-xs text-muted-foreground">{count}</span>}
      </h2>
      {q.isError ? (
        <QueryError error={q.error} noAccessMessage="没有查看引用的权限。" retryMessage="加载引用失败，请重试。" onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-12" />
      ) : q.data.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有被引用</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {q.data.map((g) => (
            <li key={`${g.kind}:${g.id}`} className="flex min-w-0 flex-col gap-1">
              <Link href={`/${org}/${g.href}`} className="flex min-w-0 gap-2 text-[13px] hover:underline">
                <span className="shrink-0 font-mono text-muted-foreground">{g.displayKey}</span>
                <span className="truncate">{g.title}</span>
              </Link>
              <ul className="ml-3 flex flex-col gap-1.5 border-l pl-3">
                {g.items.map((it, i) => (
                  <li key={i} className="flex min-w-0 flex-col text-[12px] text-muted-foreground">
                    <span>
                      <span className="text-foreground">{backlinkViaLabel(it)}</span> · <span className="font-mono">{formatDateTime(it.createdAt)}</span>
                    </span>
                    <span className="break-words">{it.context}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 3: 任务详情页**

新建 `apps/web/src/app/(app)/[org]/tasks/[key]/page.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, type ReactNode } from 'react';
import { Backlinks } from '@/components/backlinks';
import { QueryError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ITERATION_STATUS_LABEL, TASK_STATUS_LABEL } from '@/lib/labels';
import { useTask } from '@/lib/queries';

/** 任务详情（只读）：修改仍在迭代的甘特页签里进行。 */
export default function TaskPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const q = useTask(org, decodeURIComponent(key));
  if (!q.data && q.isError) {
    return <QueryError error={q.error} noAccessMessage="任务不存在，或你没有查看它所在产品的权限。" retryMessage="加载任务失败，请重试。" onRetry={() => q.refetch()} />;
  }
  if (!q.data) return <Skeleton className="h-64" />;
  const t = q.data;
  const gantt = t.iteration ? `/${org}/iterations/${t.iteration.id}?tab=gantt` : null;
  const rows: Array<[string, ReactNode]> = [
    ['状态', TASK_STATUS_LABEL[t.status]],
    ['负责人', t.assignee?.displayName ?? '未指派'],
    [
      '开始 / 工期',
      <span key="plan" className="font-mono">
        {t.planStart ?? '未排期'}
        {t.planDays !== null && ` · ${t.planDays} 天`}
      </span>,
    ],
    ['进度', <span key="progress" className="font-mono">{t.progress}%</span>],
    [
      '需求',
      t.requirement ? (
        <Link key="req" href={`/${org}/requirements/${t.requirement.displayKey}`} className="hover:underline">
          <span className="font-mono">{t.requirement.displayKey}</span> {t.requirement.title}
        </Link>
      ) : (
        '未挂需求'
      ),
    ],
    [
      '迭代',
      t.iteration && gantt ? (
        <Link key="it" href={gantt} className="hover:underline">
          {t.iteration.name}（{ITERATION_STATUS_LABEL[t.iteration.status]}）
        </Link>
      ) : (
        '不在迭代中'
      ),
    ],
    ['说明', t.note ?? '—'],
  ];
  return (
    <>
      <PageHeader
        crumbs={[{ label: '迭代', href: `/${org}/iterations` }, ...(t.iteration && gantt ? [{ label: t.iteration.name, href: gantt }] : []), { label: t.displayKey }]}
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-muted-foreground">{t.displayKey}</span>
            <span className="min-w-0 break-words">{t.title}</span>
          </span>
        }
        description={gantt ? '任务在迭代的甘特页签里修改。' : undefined}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="任务信息" className="min-w-0 rounded-md border bg-card p-4">
          <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
            {rows.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
        <Backlinks org={org} type="task" id={t.id} />
      </div>
    </>
  );
}
```

- [ ] **Step 4: 各处显示任务编号**

`apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx`：名称单元格里 `<div className="flex min-w-0 items-center gap-2">` 的第一个子元素（别名输入框）之前加：

```tsx
            <Link href={`/${org}/tasks/${t.displayKey}`} className="shrink-0 font-mono text-[12px] text-muted-foreground hover:underline">
              {t.displayKey}
            </Link>
```

`apps/web/src/app/(app)/[org]/workload/page.tsx`：把 `<TableCell>{t.alias || t.title}</TableCell>` 改为：

```tsx
                    <TableCell>
                      <Link href={`/${org}/tasks/${t.displayKey}`} className="mr-2 font-mono text-[12px] text-muted-foreground hover:underline">
                        {t.displayKey}
                      </Link>
                      {t.alias || t.title}
                    </TableCell>
```

`apps/web/src/app/(app)/[org]/requirements/[key]/side-lists.tsx` 整个替换为：

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';
import { TASK_STATUS_LABEL } from '@/lib/labels';
import type { RequirementDetail } from '@/lib/types';

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border bg-card p-4" aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <ul className="flex flex-col gap-1.5 text-[13px]">{children}</ul>
    </section>
  );
}

export function SideLists({ org, requirement: r }: { org: string; requirement: RequirementDetail }) {
  return (
    <>
      {r.tasks.length > 0 && (
        <Block title="任务">
          {r.tasks.map((t) => (
            <li key={t.id} className="flex min-w-0 flex-col">
              <Link href={`/${org}/tasks/${t.displayKey}`} className="flex min-w-0 gap-1.5 hover:underline">
                <span className="shrink-0 font-mono text-muted-foreground">{t.displayKey}</span>
                <span className="truncate">{t.title}</span>
              </Link>
              <span className="text-[12px] text-muted-foreground">
                {[t.assignee?.displayName, TASK_STATUS_LABEL[t.status], t.planStart && `${t.planStart} 起`, t.planDays && `${t.planDays} 天`].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </Block>
      )}
    </>
  );
}
```

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：`<SideLists requirement={r} />` 改为 `<SideLists org={org} requirement={r} />`。

`apps/web/src/app/(app)/[org]/page.tsx`：「我的任务」每行的 `<span className="flex-1 truncate">{t.title}</span>` 之前加：

```tsx
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.displayKey}</span>
```

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @flower/web exec vitest run src/features/links/model.test.ts && pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e tasks.spec.ts gantt.spec.ts workload.spec.ts workbench.spec.ts requirements.spec.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/features/links/model.ts apps/web/src/features/links/model.test.ts apps/web/src/components/backlinks.tsx "apps/web/src/app/(app)/[org]/tasks/[key]/page.tsx" "apps/web/src/app/(app)/[org]/iterations/[id]/task-row.tsx" "apps/web/src/app/(app)/[org]/workload/page.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/side-lists.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx" "apps/web/src/app/(app)/[org]/page.tsx" apps/web/e2e/tasks.spec.ts
git commit -m "feat(web): 任务编号显示与只读任务详情页，「被引用」区块组件

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: 页面：链接卡渲染（需求描述与评论）与「被引用」区块

**Files:**
- Modify: `apps/web/src/features/links/model.ts`、`apps/web/src/features/links/model.test.ts`
- Create: `apps/web/src/components/wiki-text.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`（描述显示、「被引用」、给评论传 `productKey`）、`apps/web/src/app/(app)/[org]/requirements/[key]/comments.tsx`
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`、`apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`（「被引用」）
- Modify: `apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`（「被引用」）
- Test: `apps/web/e2e/links.spec.ts`

**Interfaces:**
- Consumes: Task 1 `canonicalWikiText`、`splitWikiText`（`@flower/core/links`）；Task 6 `RequirementDetail.links`、`CommentView.links`、`DocumentCommentView.links`；Task 8 `linkKeys`、`LinkCard`；Task 9 `<Backlinks>`
- Produces（`features/links/model.ts`）:
  - `LINK_STATE_NOTE: Record<LinkCard['state'], string | null>`（`ok`、`hidden` 为 null；其余为「目标不存在」「已删除」「已取消」「小节已失效」）
  - `cardFor(cards: LinkCard[], target: string, productKey: string): LinkCard | null`
  - `cardHref(org: string, card: LinkCard): string | null`
  - `isGrey(card: LinkCard | null): boolean`
  - `cardLabel(card: LinkCard | null, target: string, label?: string | null): string`（无障碍名称：编号、标题或显示文字、状态、说明；没有卡时为「{写法} 未解析」）
- Produces（`components/wiki-text.tsx`）: `<LinkChip org card target label />`、`<WikiText org text cards productKey as? className? />`

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/links/model.test.ts`：import 改为

```ts
import { describe, expect, it } from 'vitest';
import type { LinkCard } from '@/lib/types';
import { backlinkViaLabel, cardFor, cardHref, cardLabel, isGrey } from './model';
```

文件末尾加：

```ts
describe('链接卡', () => {
  const card = (over: Partial<LinkCard>): LinkCard => ({
    text: 'PAN-1',
    targetType: 'requirement',
    state: 'ok',
    displayKey: 'PAN-1',
    title: '登录改版',
    status: { label: '待处理', color: '#94a3b8' },
    href: 'requirements/PAN-1',
    ...over,
  });

  it('按来源产品算出规范写法找到对应的卡', () => {
    const cards = [card({}), card({ text: 'PAN/迭代:0316', targetType: 'iteration', displayKey: '迭代:0316', title: null, href: 'iterations/i1' })];
    expect(cardFor(cards, 'pan-1', 'PAN')).toBe(cards[0]);
    expect(cardFor(cards, '迭代：0316', 'PAN')).toBe(cards[1]);
    expect(cardFor(cards, '迭代:0316', 'DOC')).toBeNull();
  });

  it('地址、灰色与无障碍名称', () => {
    expect(cardHref('acme', card({}))).toBe('/acme/requirements/PAN-1');
    expect(cardHref('acme', card({ state: 'hidden', href: null }))).toBeNull();
    expect(isGrey(card({}))).toBe(false);
    expect(isGrey(card({ state: 'hidden' }))).toBe(false);
    expect(isGrey(card({ state: 'section_missing' }))).toBe(true);
    expect(isGrey(null)).toBe(true);
    expect(cardLabel(card({}), 'PAN-1')).toBe('PAN-1 登录改版 待处理');
    expect(cardLabel(card({}), 'PAN-1', '登录')).toBe('PAN-1 登录 待处理');
    expect(
      cardLabel(card({ state: 'section_missing', displayKey: 'PAN-PRD-1#方案', title: '登录 PRD', status: { label: '草稿', color: null } }), 'PAN-PRD-1#方案'),
    ).toBe('PAN-PRD-1#方案 登录 PRD 草稿 小节已失效');
    expect(cardLabel(card({ state: 'hidden', displayKey: 'DOC-1', title: null, status: null, href: null }), 'DOC-1')).toBe('DOC-1');
    expect(cardLabel(null, 'PAN-9')).toBe('PAN-9 未解析');
  });
});
```

新建 `apps/web/e2e/links.spec.ts`：

```ts
import { type APIRequestContext, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createIteration, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function requirementWith(request: APIRequestContext, productId: string, title: string, description: string): Promise<{ id: string; displayKey: string }> {
  return (await json<{ requirement: { id: string; displayKey: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title, description } })))
    .requirement;
}

test('需求描述里的链接卡：改标题后链接不断，点击跳转；目标的「被引用」列出来源与上下文', async ({ page, request }) => {
  const productId = await createProduct(request);
  const target = await createRequirement(request, productId, '登录改版'); // PAN-1
  const src = await requirementWith(request, productId, '引用方', '依赖 [[PAN-1]] 的接口。'); // PAN-2
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${target.id}`, { data: { title: '登录改版二期' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${src.displayKey}`);
  await page.getByRole('region', { name: '描述' }).getByRole('link', { name: 'PAN-1 登录改版二期 待处理' }).click();
  await expect(page).toHaveURL(/\/acme\/requirements\/PAN-1$/);
  const back = page.getByRole('region', { name: /被引用/ });
  await expect(back.getByRole('link', { name: /PAN-2/ })).toContainText('引用方');
  await expect(back).toContainText('需求描述');
  await expect(back).toContainText('依赖 [[PAN-1]] 的接口。');
});

test('迭代改名后链接不断；PRD 小节有效、改名后失效；迭代、任务、PRD 详情页的「被引用」', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0316', '2026-03-02', '2026-03-13');
  const task = (await json<{ task: { displayKey: string } }>(request.post('/api/v1/orgs/acme/tasks', { data: { iterationId, title: '接口联调' } }))).task;
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: `## 1. 背景\n\n排期见 [[迭代:迭代0316]]，任务 [[${task.displayKey}]]。` } }));
  const src = await requirementWith(request, productId, '引用方', `排期 [[迭代:迭代0316]]，文档 [[${doc.displayKey}#背景]] 与 [[${doc.displayKey}#方案]]。`);
  await ok(request.patch(`/api/v1/orgs/acme/iterations/${iterationId}`, { data: { name: '迭代0316-改' } }));
  await login(page, OWNER.email, OWNER.password);

  await page.goto(`/acme/requirements/${src.displayKey}`);
  const desc = page.getByRole('region', { name: '描述' });
  await expect(desc.getByRole('link', { name: '迭代:迭代0316-改 规划中' })).toBeVisible();
  await expect(desc.getByRole('link', { name: `${doc.displayKey}#背景 登录 PRD 草稿` })).toBeVisible();
  await expect(desc.getByRole('link', { name: `${doc.displayKey}#方案 登录 PRD 草稿 小节已失效` })).toBeVisible();

  await ok(
    request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, {
      data: { baseVersion: doc.version + 1, markdown: `## 1. 现状\n\n排期见 [[迭代:迭代0316-改]]，任务 [[${task.displayKey}]]。` },
    }),
  );
  await page.reload();
  await expect(desc.getByRole('link', { name: `${doc.displayKey}#背景 登录 PRD 草稿 小节已失效` })).toBeVisible();

  await page.goto(`/acme/iterations/${iterationId}`);
  const itBack = page.getByRole('region', { name: /被引用/ });
  await expect(itBack.getByRole('link', { name: new RegExp(`^${src.displayKey} `) })).toBeVisible();
  await expect(itBack.getByRole('link', { name: new RegExp(`^${doc.displayKey} `) })).toBeVisible();
  await expect(itBack).toContainText('小节「1. 现状」');

  await page.goto(`/acme/tasks/${task.displayKey}`);
  await expect(page.getByRole('region', { name: /被引用/ }).getByRole('link', { name: new RegExp(`^${doc.displayKey} `) })).toBeVisible();

  await page.goto(`/acme/documents/${doc.displayKey}`);
  await expect(page.getByRole('region', { name: /被引用/ }).getByRole('link', { name: new RegExp(`^${src.displayKey} `) })).toBeVisible();
});

test('评论里的链接卡：需求评论与 PRD 评论，显示文字替代标题', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: `PRD 见 [[${doc.displayKey}]]` } }));
  await ok(request.post(`/api/v1/orgs/acme/documents/${doc.id}/comments`, { data: { body: `对应需求 [[${req.displayKey}|登录]]` } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  await expect(page.getByRole('region', { name: /^评论/ }).getByRole('link', { name: `${doc.displayKey} 登录 PRD 草稿` })).toBeVisible();
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('region', { name: /^评论/ }).getByRole('link', { name: `${req.displayKey} 登录 待处理` }).click();
  await expect(page).toHaveURL(new RegExp(`/acme/requirements/${req.displayKey}$`));
});

test('看不到目标所在产品时只显示编号', async ({ browser, request }) => {
  const pan = await createProduct(request);
  const other = await createProduct(request, '文档', 'DOC');
  await createRequirement(request, other, '保密需求');
  const src = await requirementWith(request, pan, '引用方', '见 [[DOC-1]]');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const guestId = await acceptInvite(page, request, { email: 'guest@example.com', orgRole: 'guest', name: '访客甲' });
  await ok(request.put(`/api/v1/orgs/acme/products/${pan}/roles/${guestId}`, { data: { role: 'viewer' } }));
  await page.goto(`/acme/requirements/${src.displayKey}`);
  const desc = page.getByRole('region', { name: '描述' });
  await expect(desc).toContainText('DOC-1');
  await expect(desc).not.toContainText('保密需求');
  await expect(desc.getByRole('link')).toHaveCount(0);
  await ctx.close();
});

test('「被引用」区块在 1440 与 760 宽度下不让页面横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  const target = await createRequirement(request, productId, '登录改版');
  await requirementWith(request, productId, '一个标题很长很长很长很长很长很长很长很长很长很长很长很长的引用方', `${'很长的上下文'.repeat(30)} [[PAN-1]]`);
  await login(page, OWNER.email, OWNER.password);
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/requirements/${target.displayKey}`);
    await expect(page.getByRole('region', { name: /被引用/ })).toContainText('需求描述');
    await expectNoPageOverflow(page);
  }
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/links/model.test.ts`
Expected: FAIL（`cardFor` 等未导出）。

Run: `pnpm --filter @flower/web e2e links.spec.ts`
Expected: FAIL（描述里没有链接卡）。

- [ ] **Step 2: 纯函数**

`apps/web/src/features/links/model.ts` 开头加 import，末尾加函数：

```ts
import { canonicalWikiText } from '@flower/core/links';
import type { LinkCard } from '@/lib/types';
```

```ts
/** 链接卡的说明文字；为 null 时不显示说明、也不显示为灰色。 */
export const LINK_STATE_NOTE: Record<LinkCard['state'], string | null> = {
  ok: null,
  hidden: null,
  missing: '目标不存在',
  deleted: '已删除',
  canceled: '已取消',
  section_missing: '小节已失效',
};

/** 正文中一个 [[ ]] 对应的链接卡：按来源产品算出规范写法后查找。 */
export function cardFor(cards: LinkCard[], target: string, productKey: string): LinkCard | null {
  const text = canonicalWikiText(target, productKey);
  return cards.find((c) => c.text === text) ?? null;
}

export const cardHref = (org: string, card: LinkCard): string | null => (card.href ? `/${org}/${card.href}` : null);

/** 不存在、已删除、已取消、小节失效、未解析时显示为灰色。 */
export const isGrey = (card: LinkCard | null): boolean => !card || LINK_STATE_NOTE[card.state] !== null;

/** 链接卡的无障碍名称：编号、标题（有显示文字时用显示文字）、状态、说明。 */
export function cardLabel(card: LinkCard | null, target: string, label: string | null = null): string {
  if (!card) return `${target} 未解析`;
  return [card.displayKey, label ?? card.title, card.status?.label, LINK_STATE_NOTE[card.state]].filter(Boolean).join(' ');
}
```

- [ ] **Step 3: 链接卡组件**

新建 `apps/web/src/components/wiki-text.tsx`：

```tsx
'use client';

import { splitWikiText } from '@flower/core/links';
import Link from 'next/link';
import { Fragment } from 'react';
import { cardFor, cardHref, cardLabel, isGrey, LINK_STATE_NOTE } from '@/features/links/model';
import type { LinkCard } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 行内链接卡：编号、标题（或 [[ |显示文字]]）、状态。灰色时附说明；看不到目标时只有编号、不可点击。 */
export function LinkChip({ org, card, target, label }: { org: string; card: LinkCard | null; target: string; label: string | null }) {
  const href = card ? cardHref(org, card) : null;
  const grey = isGrey(card);
  const note = card ? LINK_STATE_NOTE[card.state] : '未解析';
  const title = label ?? card?.title ?? null;
  const name = cardLabel(card, target, label);
  const cls = cn(
    'mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-sm border px-1 align-baseline text-[12px] leading-5',
    grey ? 'border-dashed text-muted-foreground' : 'bg-muted/60',
  );
  const body = (
    <>
      <span className="shrink-0 font-mono">{card?.displayKey ?? target}</span>
      {title && <span className="truncate">{title}</span>}
      {card?.status && (
        <span className="shrink-0 text-[11px]" style={!grey && card.status.color ? { color: card.status.color } : undefined}>
          {card.status.label}
        </span>
      )}
      {note && <span className="shrink-0 text-[11px]">{note}</span>}
    </>
  );
  return href ? (
    <Link href={href} aria-label={name} className={cn(cls, 'hover:underline')}>
      {body}
    </Link>
  ) : (
    <span title={name} className={cls}>
      {body}
    </span>
  );
}

/** 纯文本（需求描述、评论）的显示：[[ ]] 渲染为链接卡，其余原样（保留换行）。 */
export function WikiText({
  org,
  text,
  cards,
  productKey,
  as: Tag = 'p',
  className,
}: {
  org: string;
  text: string;
  cards: LinkCard[];
  productKey: string;
  as?: 'p' | 'span';
  className?: string;
}) {
  return (
    <Tag className={cn('whitespace-pre-wrap break-words', className)}>
      {splitWikiText(text).map((s, i) =>
        s.kind === 'text' ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : (
          <LinkChip key={i} org={org} card={cardFor(cards, s.link.target, productKey)} target={s.link.target} label={s.link.label} />
        ),
      )}
    </Tag>
  );
}
```

- [ ] **Step 4: 需求详情页**

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：

1. import 区加 `import { Backlinks } from '@/components/backlinks';`、`import { WikiText } from '@/components/wiki-text';`，`@/lib/queries` 的 import 加 `linkKeys`。
2. `patch` 的 `invalidate: [requirementKeys(org)]` 改为 `invalidate: [requirementKeys(org), linkKeys(org)]`。
3. 描述的显示部分

```tsx
              <p className="whitespace-pre-wrap text-[13px] leading-6">{r.description || <span className="text-muted-foreground">暂无描述</span>}</p>
```

改为

```tsx
              r.description ? (
                <WikiText org={org} text={r.description} cards={r.links} productKey={r.productKey} className="text-[13px] leading-6" />
              ) : (
                <p className="text-[13px] leading-6 text-muted-foreground">暂无描述</p>
              )
```

4. `<Relations org={org} requirement={r} />` 之后加 `<Backlinks org={org} type="requirement" id={r.id} />`；`<Comments org={org} requirementId={r.id} />` 改为 `<Comments org={org} requirementId={r.id} productKey={r.productKey} />`。

`apps/web/src/app/(app)/[org]/requirements/[key]/comments.tsx`：

1. import 区加 `import { WikiText } from '@/components/wiki-text';`，`@/lib/queries` 的 import 加 `linkKeys`。
2. 组件签名改为 `export function Comments({ org, requirementId, productKey }: { org: string; requirementId: string; productKey: string })`。
3. `add` 的 `invalidate: [qk.requirementComments(org, requirementId)]` 改为 `invalidate: [qk.requirementComments(org, requirementId), linkKeys(org)]`。
4. `<p className="whitespace-pre-wrap text-[13px] leading-6">{c.body}</p>` 改为：

```tsx
            <WikiText org={org} text={c.body} cards={c.links} productKey={productKey} className="text-[13px] leading-6" />
```

- [ ] **Step 5: PRD 评论与 PRD、迭代详情页**

`apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`：

1. import 区加 `import { WikiText } from '@/components/wiki-text';`，`@/lib/queries` 的 import 加 `linkKeys`。
2. `DocumentComments` 中 `const invalidate = [qk.documentComments(org, doc.id)];` 改为 `const invalidate = [qk.documentComments(org, doc.id), linkKeys(org)];`。
3. `<p className="whitespace-pre-wrap text-[13px]">{c.body}</p>` 改为：

```tsx
              <WikiText org={org} text={c.body} cards={c.links} productKey={doc.productKey} className="text-[13px]" />
```

4. 回复里的 `<span className="whitespace-pre-wrap">{r.body}</span>` 改为：

```tsx
                      <WikiText org={org} text={r.body} cards={r.links} productKey={doc.productKey} as="span" />
```

5. `AnchorCommentDialog` 中 `invalidate: [qk.documentComments(org, documentId)]` 改为 `invalidate: [qk.documentComments(org, documentId), linkKeys(org)]`。

`apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`：import 区加 `import { Backlinks } from '@/components/backlinks';`；`<DocumentComments org={org} doc={d} />` 之后加 `<Backlinks org={org} type="document" id={d.id} />`。

`apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx`：import 区加 `import { Backlinks } from '@/components/backlinks';`；`</Tabs>` 之后加 `<Backlinks org={org} type="iteration" id={it.id} />`。

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @flower/web exec vitest run src/features/links/model.test.ts && pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e links.spec.ts requirements.spec.ts documents-revisions.spec.ts documents-permissions.spec.ts iterations.spec.ts layout.spec.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/links/model.ts apps/web/src/features/links/model.test.ts apps/web/src/components/wiki-text.tsx "apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/comments.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/page.tsx" "apps/web/src/app/(app)/[org]/iterations/[id]/page.tsx" apps/web/e2e/links.spec.ts
git commit -m "feat(web): 需求描述与评论显示链接卡；需求、PRD、迭代详情页加「被引用」

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 页面：纯文本输入框的 `[[` 补全

**Files:**
- Modify: `apps/web/src/features/links/model.ts`、`apps/web/src/features/links/model.test.ts`
- Create: `apps/web/src/components/wikilink-textarea.tsx`
- Modify: `apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`（描述编辑）、`apps/web/src/app/(app)/[org]/requirements/[key]/comments.tsx`
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`（整篇评论、回复、划词评论对话框）、`apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`（给划词评论对话框传 `productId`）
- Test: `apps/web/e2e/links-autocomplete.spec.ts`

**Interfaces:**
- Consumes: Task 7 `LinkSuggestion`（`next`）；Task 8 `useLinkSearch`
- Produces（`features/links/model.ts`）:
  - `type WikiQuery = { start: number; query: string }`
  - `activeWikiQuery(value: string, caret: number): WikiQuery | null`
  - `applyCompletion(value: string, q: WikiQuery, caret: number, s: Pick<LinkSuggestion, 'insert' | 'next'>): { value: string; caret: number }`
  - `SUGGESTION_KIND_LABEL: Record<LinkSuggestion['kind'], string>`
- Produces（`components/wikilink-textarea.tsx`）: `<WikilinkTextarea org productId value onValueChange …textarea 属性 />`（列表 `role="listbox"`，名称「链接补全」）
- Produces: `AnchorCommentDialog` 新增必填属性 `productId: string`；`Comments`（需求）新增必填属性 `productId: string`

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/links/model.test.ts`：import 改为

```ts
import { describe, expect, it } from 'vitest';
import type { LinkCard } from '@/lib/types';
import { activeWikiQuery, applyCompletion, backlinkViaLabel, cardFor, cardHref, cardLabel, isGrey } from './model';
```

文件末尾加：

```ts
describe('[[ 补全', () => {
  it('光标前未闭合、未转义、不跨行的 [[ 才算正在补全', () => {
    expect(activeWikiQuery('见 [[登录', 6)).toEqual({ start: 2, query: '登录' });
    expect(activeWikiQuery('见 [[', 4)).toEqual({ start: 2, query: '' });
    expect(activeWikiQuery('见 [[PAN-1]] 和', 12)).toBeNull();
    expect(activeWikiQuery('[[登\n录', 5)).toBeNull();
    expect(activeWikiQuery('\\[[登录', 5)).toBeNull();
    expect(activeWikiQuery('见 [[登录', 3)).toBeNull();
  });

  it('选中后闭合；选 PRD 时改为 [[KEY#，光标落在插入内容之后', () => {
    const q = activeWikiQuery('见 [[登录 吧', 6)!;
    expect(applyCompletion('见 [[登录 吧', q, 6, { insert: 'PAN-1', next: 'insert' })).toEqual({ value: '见 [[PAN-1]] 吧', caret: 11 });
    expect(applyCompletion('见 [[登录 吧', q, 6, { insert: 'PAN-PRD-1', next: 'sections' })).toEqual({ value: '见 [[PAN-PRD-1# 吧', caret: 14 });
  });
});
```

新建 `apps/web/e2e/links-autocomplete.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, createRequirement, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求描述：输入 [[ 弹出补全，按标题搜索、回车插入；Esc 关闭；保存后显示链接卡', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const src = await createRequirement(request, productId, '引用方');
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${src.displayKey}`);
  const desc = page.getByRole('region', { name: '描述' });
  await desc.getByRole('button', { name: '编辑' }).click();
  const input = desc.getByRole('textbox', { name: '描述' });
  await input.click();
  await page.keyboard.type('依赖 [[登录');
  const list = page.getByRole('listbox', { name: '链接补全' });
  await expect(list.getByRole('option', { name: /PAN-1.*登录改版/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('依赖 [[PAN-1]]');
  await expect(list).toBeHidden();
  await page.keyboard.type(' 和 [[');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await input.fill('依赖 [[PAN-1]]');
  await desc.getByRole('button', { name: '保存' }).click();
  await expect(desc.getByRole('link', { name: 'PAN-1 登录改版 待处理' })).toBeVisible();
});

test('需求评论：选中 PRD 后继续选小节，上下键选择；发表后显示链接卡', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: '## 1. 背景\n\n现状\n\n## 2. 需求说明\n\n内容' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const comments = page.getByRole('region', { name: /^评论/ });
  const input = comments.getByRole('textbox', { name: '写评论' });
  await input.click();
  await page.keyboard.type('PRD 见 [[PAN-PRD');
  const list = page.getByRole('listbox', { name: '链接补全' });
  await expect(list.getByRole('option', { name: /PAN-PRD-1.*登录 PRD/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('PRD 见 [[PAN-PRD-1#');
  await expect(list.getByRole('option', { name: /整篇/ })).toBeVisible();
  await expect(list.getByRole('option')).toHaveCount(3);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('PRD 见 [[PAN-PRD-1#需求说明]]');
  await comments.getByRole('button', { name: '发表' }).click();
  await expect(comments.getByRole('link', { name: 'PAN-PRD-1#需求说明 登录 PRD 草稿' })).toBeVisible();
});

test('PRD 评论区的输入框同样支持 [[ 补全', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const input = page.getByRole('region', { name: /^评论/ }).getByRole('textbox', { name: '发表评论' });
  await input.click();
  await page.keyboard.type('对应 [[PAN-1');
  await expect(page.getByRole('listbox', { name: '链接补全' }).getByRole('option', { name: /PAN-1.*登录改版/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('对应 [[PAN-1]]');
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/links/model.test.ts`
Expected: FAIL（`activeWikiQuery` 等未导出）。

Run: `pnpm --filter @flower/web e2e links-autocomplete.spec.ts`
Expected: FAIL（没有补全列表）。

- [ ] **Step 2: 纯函数**

`apps/web/src/features/links/model.ts`：import 改为

```ts
import { canonicalWikiText } from '@flower/core/links';
import type { LinkCard, LinkSuggestion } from '@/lib/types';
```

文件末尾加：

```ts
export type WikiQuery = { start: number; query: string };

const MAX_QUERY = 60;

/** 光标前正在输入的 [[ 补全：最近一个未转义的 [[ 到光标之间的文字，不含 [、]、换行，最多 60 字。 */
export function activeWikiQuery(value: string, caret: number): WikiQuery | null {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf('[[');
  if (start === -1 || before[start - 1] === '\\') return null;
  const query = before.slice(start + 2);
  if (query.length > MAX_QUERY || /[[\]\n]/.test(query)) return null;
  return { start, query };
}

/** 选中补全项：闭合为 [[insert]]；选的是 PRD（next 为 sections）时改为 [[insert#，继续选小节。 */
export function applyCompletion(value: string, q: WikiQuery, caret: number, s: Pick<LinkSuggestion, 'insert' | 'next'>): { value: string; caret: number } {
  const head = value.slice(0, q.start);
  const inserted = s.next === 'sections' ? `[[${s.insert}#` : `[[${s.insert}]]`;
  return { value: head + inserted + value.slice(caret), caret: head.length + inserted.length };
}

export const SUGGESTION_KIND_LABEL: Record<LinkSuggestion['kind'], string> = {
  requirement: '需求',
  document: 'PRD',
  section: '小节',
  task: '任务',
  iteration: '迭代',
  structure_node: '结构树',
};
```

- [ ] **Step 3: 补全输入框组件**

新建 `apps/web/src/components/wikilink-textarea.tsx`：

```tsx
'use client';

import { type ComponentProps, type KeyboardEvent, useId, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { activeWikiQuery, applyCompletion, SUGGESTION_KIND_LABEL } from '@/features/links/model';
import { useLinkSearch } from '@/lib/queries';
import { cn } from '@/lib/utils';

type Props = Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange'> & {
  org: string;
  /** 来源所在产品：补全按它决定本产品优先与是否带产品前缀。 */
  productId: string;
  value: string;
  onValueChange: (value: string) => void;
};

/** 纯文本输入框加 [[ 补全：按编号前缀或标题搜索，上下键选择、回车插入、Esc 关闭；输入法组字时回车不插入。 */
export function WikilinkTextarea({ org, productId, value, onValueChange, onKeyDown, onBlur, className, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const q = activeWikiQuery(value, caret);
  const open = q !== null && dismissed !== q.start;
  // 查询变化时回到第一项（渲染期间调整）
  const queryKey = q ? `${q.start}:${q.query}` : null;
  const [seenQuery, setSeenQuery] = useState<string | null>(null);
  if (queryKey !== seenQuery) {
    setSeenQuery(queryKey);
    setActive(0);
  }
  const search = useLinkSearch(org, productId, q?.query ?? '', open);
  const items = open ? (search.data ?? []) : [];
  const index = Math.min(active, Math.max(items.length - 1, 0));

  const pick = (i: number) => {
    const s = items[i];
    if (!s || !q) return;
    const next = applyCompletion(value, q, caret, s);
    onValueChange(next.value);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && q && !e.nativeEvent.isComposing) {
      if (items.length > 0 && e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((index + 1) % items.length);
        return;
      }
      if (items.length > 0 && e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((index - 1 + items.length) % items.length);
        return;
      }
      if (items.length > 0 && e.key === 'Enter') {
        e.preventDefault();
        pick(index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(q.start);
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
        aria-controls={open && items.length > 0 ? listId : undefined}
        onChange={(e) => {
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={keyDown}
        onBlur={(e) => {
          if (q) setDismissed(q.start);
          onBlur?.(e);
        }}
      />
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" aria-label="链接补全" className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-[13px] shadow-md">
          {items.map((s, i) => (
            <li
              key={`${s.kind}:${s.insert}`}
              role="option"
              aria-selected={i === index}
              className={cn('flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5', i === index && 'bg-accent')}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{SUGGESTION_KIND_LABEL[s.kind]}</span>
              <span className="shrink-0 font-mono">{s.displayKey}</span>
              <span className="min-w-0 truncate">{s.title}</span>
              {s.hint && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{s.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 用在描述、需求评论、PRD 评论与划词评论**

`apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx`：

1. import 区加 `import { WikilinkTextarea } from '@/components/wikilink-textarea';`；`Textarea` 不再使用时删除它的 import。
2. 描述编辑的

```tsx
                <Textarea aria-label="描述" className="min-h-48 text-[13px]" value={description} onChange={(e) => setDescription(e.target.value)} />
```

改为

```tsx
                <WikilinkTextarea org={org} productId={r.productId} aria-label="描述" className="min-h-48 text-[13px]" value={description} onValueChange={setDescription} />
```

3. `<Comments org={org} requirementId={r.id} productKey={r.productKey} />` 改为 `<Comments org={org} requirementId={r.id} productId={r.productId} productKey={r.productKey} />`。

`apps/web/src/app/(app)/[org]/requirements/[key]/comments.tsx`：

1. import 区加 `import { WikilinkTextarea } from '@/components/wikilink-textarea';`，删除 `Textarea` 的 import。
2. 签名改为 `export function Comments({ org, requirementId, productId, productKey }: { org: string; requirementId: string; productId: string; productKey: string })`。
3. 输入框改为：

```tsx
        <WikilinkTextarea org={org} productId={productId} aria-label="写评论" placeholder="写评论…" value={body} maxLength={10000} onValueChange={setBody} />
```

`apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`：

1. import 区加 `import { WikilinkTextarea } from '@/components/wikilink-textarea';`，删除 `Textarea` 的 import。
2. 回复输入框改为：

```tsx
                  <WikilinkTextarea org={org} productId={doc.productId} aria-label="回复内容" className="min-h-16 text-[13px]" value={reply} onValueChange={setReply} />
```

3. 整篇评论输入框改为：

```tsx
        <WikilinkTextarea org={org} productId={doc.productId} aria-label="发表评论" placeholder="对整篇 PRD 的意见" className="min-h-20 text-[13px]" value={body} onValueChange={setBody} />
```

4. `AnchorCommentDialog` 的签名改为 `export function AnchorCommentDialog({ documentId, productId, anchor, onClose }: { documentId: string; productId: string; anchor: SelectionAnchor | null; onClose: () => void })`，对话框里的输入框改为：

```tsx
        <WikilinkTextarea org={org} productId={productId} aria-label="评论内容" className="min-h-20 text-[13px]" value={body} onValueChange={setBody} />
```

`apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`：`<AnchorCommentDialog documentId={doc.id} anchor={commenting} onClose={() => setCommenting(null)} />` 改为 `<AnchorCommentDialog documentId={doc.id} productId={doc.productId} anchor={commenting} onClose={() => setCommenting(null)} />`（编辑器与自动保存相关的代码不动）。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @flower/web exec vitest run src/features/links/model.test.ts && pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e links-autocomplete.spec.ts links.spec.ts requirements.spec.ts documents-revisions.spec.ts documents-permissions.spec.ts documents-editor.spec.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/features/links/model.ts apps/web/src/features/links/model.test.ts apps/web/src/components/wikilink-textarea.tsx "apps/web/src/app/(app)/[org]/requirements/[key]/page.tsx" "apps/web/src/app/(app)/[org]/requirements/[key]/comments.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx" apps/web/e2e/links-autocomplete.spec.ts
git commit -m "feat(web): 需求描述与评论输入框支持 [[ 补全，选中 PRD 后可继续选小节

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: 页面：PRD 编辑器的 `[[` 补全、链接卡显示与小节跳转

**Files:**
- Modify: `apps/web/package.json`（`prosemirror-state`、`prosemirror-view`）、`pnpm-lock.yaml`
- Create: `apps/web/src/features/documents/editor/decorations.ts`
- Modify: `apps/web/src/features/documents/editor/prd-editor.tsx`
- Modify: `apps/web/src/features/documents/model.ts`、`apps/web/src/features/documents/model.test.ts`（`findSectionIndex`）
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`、`apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Test: `apps/web/e2e/documents-links.spec.ts`

**Interfaces:**
- Consumes: Task 1 `wikiRangesInBlock`、`TextPart`（`@flower/core/links`）、`normalizeHeading`（`@flower/core/markdown`）；Task 8 `useDocumentLinks`、`linkKeys`、`LinkSuggestion`；Task 10 `cardFor`、`cardLabel`、`isGrey`、`LINK_STATE_NOTE`；Task 11 `SUGGESTION_KIND_LABEL`
- Produces:
  - `decorations.ts`：`type DecorationInput = { org: string; productKey: string; cards: LinkCard[] }`、`decorationsKey: PluginKey`、`flowerDecorations(): ExtensionFactoryInstance`
  - `PrdEditorProps` 新增可选 `decorations?: DecorationInput`、`searchLinks?: (query: string) => Promise<LinkSuggestion[]>`
  - `EditorPane` 新增可选属性 `section?: string | null`（渲染后滚动到该小节）
  - `findSectionIndex(headings: string[], section: string): number`（`features/documents/model.ts`）
  - 编辑器里的链接卡挂件：`.wikilink-card`（`a[href][data-wikilink-href]` 或 `span`），`data-state` 为卡的状态，`aria-label` 为 `cardLabel`

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/documents/model.test.ts`：import 列表加 `findSectionIndex`；文件末尾加：

```ts
describe('小节跳转', () => {
  it('按归一化标题找第一个匹配的标题', () => {
    expect(findSectionIndex(['1. 背景', '2. 需求 说明', '3. 需求说明'], '需求说明')).toBe(1);
    expect(findSectionIndex(['1. 背景'], '方案')).toBe(-1);
  });
});
```

新建 `apps/web/e2e/documents-links.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, createRequirement, login, ok, OWNER, presetTemplateId, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const AUTOSAVE_MS = 1000;

test('PRD 正文：输入 [[ 弹出补全、回车插入；自动保存后显示链接卡，刷新后仍在，点击跳转', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '引用', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('依赖 [[登录');
  await expect(page.getByRole('option', { name: /PAN-1 登录改版/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(body).toContainText('依赖 [[PAN-1]]');
  await expect(body.getByRole('status')).toHaveText('已保存');
  await expect(body.getByRole('link', { name: 'PAN-1 登录改版 待处理' })).toBeVisible();
  await page.reload();
  const again = page.getByRole('region', { name: '正文' });
  await expect(again).toContainText('依赖 [[PAN-1]]');
  await again.getByRole('link', { name: 'PAN-1 登录改版 待处理' }).click();
  await expect(page).toHaveURL(/\/acme\/requirements\/PAN-1$/);
});

test('PRD 正文：选中 PRD 后继续选小节；点击小节链接跳到详情页并滚动到该小节', async ({ page, request }) => {
  const productId = await createProduct(request);
  const target = await createDocument(request, productId, { title: '登录 PRD' }); // PAN-PRD-1
  const filler = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段说明文字。`).join('\n\n');
  await ok(request.put(`/api/v1/orgs/acme/documents/${target.id}/content`, { data: { baseVersion: target.version, markdown: `## 1. 背景\n\n${filler}\n\n## 2. 需求说明\n\n要点` } }));
  const doc = await createDocument(request, productId, { title: '引用', templateId: await presetTemplateId(request, productId) }); // PAN-PRD-2
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('详见 [[PAN-PRD-1');
  await expect(page.getByRole('option', { name: /PAN-PRD-1 登录 PRD/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: /整篇/ })).toBeVisible();
  await page.getByRole('option', { name: /PAN-PRD-1#需求说明/ }).click();
  await expect(body).toContainText('详见 [[PAN-PRD-1#需求说明]]');
  await expect(body.getByRole('status')).toHaveText('已保存');
  await body.getByRole('link', { name: 'PAN-PRD-1#需求说明 登录 PRD 草稿' }).click();
  await expect(page).toHaveURL(/\/acme\/documents\/PAN-PRD-1\?section=/);
  await expect(page.getByRole('region', { name: '正文' }).getByRole('heading', { name: '2. 需求说明' })).toBeInViewport();
});

test('链接卡不触发自动保存：打开含链接的 PRD 后不发保存请求；不存在的目标显示为灰色', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '只看' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: '## 背景\n\n依赖 [[PAN-1]] 与 [[PAN-99]]' } }));
  let puts = 0;
  page.on('request', (r) => {
    if (r.url().endsWith(`/documents/${doc.id}/content`) && r.method() === 'PUT') puts += 1;
  });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body.getByRole('link', { name: 'PAN-1 登录改版 待处理' })).toBeVisible();
  await expect(body.locator('.wikilink-card[data-state="missing"]')).toHaveAttribute('aria-label', 'PAN-99 目标不存在');
  await page.waitForTimeout(AUTOSAVE_MS * 2 + 500);
  expect(puts).toBe(0);
  await expect(body.getByRole('status')).toHaveText('已保存');
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: FAIL（`findSectionIndex` 未导出）。

Run: `pnpm --filter @flower/web e2e documents-links.spec.ts`
Expected: FAIL（编辑器里没有补全菜单与链接卡）。

- [ ] **Step 2: 依赖与纯函数**

Run: `pnpm --filter @flower/web add prosemirror-state@1.4.4 prosemirror-view@1.42.6`
Expected: `apps/web/package.json` 的 `dependencies` 增加这两项；`pnpm-lock.yaml` 里两者仍各只有一个版本（`grep -c "^  prosemirror-state@" pnpm-lock.yaml` 与 `grep -c "^  prosemirror-view@" pnpm-lock.yaml` 都输出 1；不是 1 时停下来报告）。

`apps/web/src/features/documents/model.ts`：第一行 import 改为

```ts
import { DOCUMENT_STATUSES, type DocumentStatus, type ExternalProvider, normalizeHeading, splitSections, type TemplateSection } from '@flower/core/markdown';
```

文件末尾加：

```ts
/** [[PRD#小节]] 跳转：按归一化标题（去编号与空白）找第一个匹配的标题，没有时为 -1。 */
export function findSectionIndex(headings: string[], section: string): number {
  const want = normalizeHeading(section);
  return headings.findIndex((h) => normalizeHeading(h) === want);
}
```

- [ ] **Step 3: 编辑器装饰插件**

新建 `apps/web/src/features/documents/editor/decorations.ts`：

```ts
import { createExtension } from '@blocknote/core';
import { type TextPart, wikiRangesInBlock } from '@flower/core/links';
import { type EditorState, Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { cardFor, cardLabel, isGrey, LINK_STATE_NOTE } from '@/features/links/model';
import type { LinkCard } from '@/lib/types';

/** 推给编辑器的显示数据：正文里 [[ ]] 的链接卡。只影响显示，不改正文。 */
export type DecorationInput = { org: string; productKey: string; cards: LinkCard[] };
type State = { input: DecorationInput | null; set: DecorationSet };
type Doc = EditorState['doc'];

export const decorationsKey = new PluginKey<State>('flower-decorations');

/** 链接卡挂件：标题、状态、说明放在 data-label，由 CSS ::after 显示，不进入 DOM 文本（划词评论读取前后文时不会读到）。 */
function chip(card: LinkCard | null, target: string, org: string): HTMLElement {
  const href = card?.href ? `/${org}/${card.href}` : null;
  const el = document.createElement(href ? 'a' : 'span');
  el.className = 'wikilink-card';
  el.contentEditable = 'false';
  el.dataset.state = card?.state ?? 'missing';
  el.dataset.label = [card?.title, card?.status?.label, card ? LINK_STATE_NOTE[card.state] : '未解析'].filter(Boolean).join(' · ');
  el.setAttribute('aria-label', cardLabel(card, target));
  if (href) {
    el.setAttribute('href', href);
    el.dataset.wikilinkHref = href;
  }
  return el;
}

function build(doc: Doc, input: DecorationInput | null): DecorationSet {
  if (!input) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    const parts: TextPart[] = [];
    node.forEach((child, offset) => {
      if (child.isText) parts.push({ text: child.text ?? '', pos: pos + 1 + offset, code: child.marks.some((m) => m.type.name === 'code') });
    });
    for (const r of wikiRangesInBlock(parts)) {
      const card = cardFor(input.cards, r.target, input.productKey);
      decos.push(Decoration.inline(r.from, r.to, { class: isGrey(card) ? 'wikilink wikilink-grey' : 'wikilink' }));
      decos.push(
        Decoration.widget(r.to, () => chip(card, r.target, input.org), {
          side: 1,
          ignoreSelection: true,
          key: `${r.target}|${card?.state ?? 'missing'}|${card?.title ?? ''}|${card?.status?.label ?? ''}`,
        }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/**
 * 显示用的装饰插件：收到只带元数据的事务（decorationsKey）时按新数据重画，文档变化时按新文档重画。
 * 元数据事务不改文档，不触发 BlockNote 的 onChange，因此不会引起自动保存。
 */
export function flowerDecorations() {
  return createExtension({
    key: 'flowerDecorations',
    prosemirrorPlugins: [
      new Plugin<State>({
        key: decorationsKey,
        state: {
          init: () => ({ input: null, set: DecorationSet.empty }),
          apply: (tr, prev, _old, next) => {
            const input = tr.getMeta(decorationsKey) as DecorationInput | undefined;
            if (input) return { input, set: build(next.doc, input) };
            if (tr.docChanged) return { input: prev.input, set: build(next.doc, prev.input) };
            return prev;
          },
        },
        props: { decorations: (state) => decorationsKey.getState(state)?.set },
      }),
    ],
  });
}
```

- [ ] **Step 4: 编辑器组件**

`apps/web/src/features/documents/editor/prd-editor.tsx` 整个替换为：

```tsx
'use client';

import '@blocknote/shadcn/style.css';
import { BlockNoteEditor } from '@blocknote/core';
import { SuggestionMenu } from '@blocknote/core/extensions';
import { zh } from '@blocknote/core/locales';
import { type DefaultReactSuggestionItem, SuggestionMenuController, useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useTheme } from 'next-themes';
import { type Ref, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { SUGGESTION_KIND_LABEL } from '@/features/links/model';
import type { LinkSuggestion } from '@/lib/types';
import { type DecorationInput, decorationsKey, flowerDecorations } from './decorations';

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
 * [[ ]] 在正文里是普通文字，链接卡由装饰插件显示。
 */
export function PrdEditor({ initialMarkdown, editable, onDirty, uploadImage, decorations, searchLinks, ref }: PrdEditorProps) {
  const [initialContent] = useState(() => parseMarkdown(initialMarkdown));
  const [extensions] = useState(() => [flowerDecorations()]);
  const editor = useCreateBlockNote({ initialContent, dictionary: zh, uploadFile: uploadImage, extensions });
  useImperativeHandle(ref, () => ({ getMarkdown: () => editor.blocksToMarkdownLossy(editor.document) }), [editor]);
  // 只带元数据的事务：不改文档，不触发 onChange，因此不会引起自动保存
  useEffect(() => {
    if (!decorations) return;
    editor.transact((tr) => {
      tr.setMeta(decorationsKey, decorations);
    });
  }, [editor, decorations]);
  const getItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      if (!searchLinks) return [];
      const list = await searchLinks(query);
      return list.map((s) => ({
        title: `${s.displayKey} ${s.title}`.trim(),
        subtext: s.hint ?? undefined,
        group: SUGGESTION_KIND_LABEL[s.kind],
        onItemClick: () => {
          if (s.next === 'sections') {
            // 选中 PRD：重新打开补全并写入「编号#」，接着列出它的小节
            editor.getExtension(SuggestionMenu)?.openSuggestionMenu('[[', { deleteTriggerCharacter: true });
            editor.insertInlineContent(`${s.insert}#`, { updateSelection: true });
          } else {
            editor.insertInlineContent(`[[${s.insert}]]`, { updateSelection: true });
          }
        },
      }));
    },
    [editor, searchLinks],
  );
  const { resolvedTheme } = useTheme();
  return (
    <BlockNoteView editor={editor} editable={editable} onChange={() => onDirty?.()} theme={resolvedTheme === 'dark' ? 'dark' : 'light'}>
      {editable && searchLinks && <SuggestionMenuController triggerCharacter="[[" getItems={getItems} />}
    </BlockNoteView>
  );
}
```

（`body-editor.tsx` 不改：它把 `PrdEditorProps` 原样传给 `PrdEditor`。）

- [ ] **Step 5: 编辑区与详情页**

`apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`（只做下面这些改动，P2-A 的保存、冲突、重试、卸载保存逻辑一行不动）：

1. import 区：
   - 加 `import { useRouter } from 'next/navigation';`
   - react 的 import 改为 `import { type MouseEvent, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';`
   - 加 `import type { DecorationInput } from '@/features/documents/editor/decorations';`
   - `import { type SaveState, saveStateLabel } from '@/features/documents/model';` 改为 `import { findSectionIndex, type SaveState, saveStateLabel } from '@/features/documents/model';`
   - `import { qk, useApiMutation } from '@/lib/queries';` 改为 `import { linkKeys, qk, useApiMutation, useDocumentLinks } from '@/lib/queries';`
   - `import type { Attachment, DocumentDetail } from '@/lib/types';` 改为 `import type { Attachment, DocumentDetail, LinkSuggestion } from '@/lib/types';`
2. 签名改为：

```tsx
export function EditorPane({
  org,
  doc,
  onReload,
  section,
  ref,
}: {
  org: string;
  doc: DocumentDetail;
  onReload: () => void;
  /** 地址栏 ?section=：编辑器渲染后滚动到这个小节。 */
  section?: string | null;
  ref?: Ref<EditorPaneHandle>;
}) {
```

3. `const qc = useQueryClient();` 之后加：

```tsx
  const router = useRouter();
  const links = useDocumentLinks(org, doc.id);
  const decorations = useMemo<DecorationInput>(() => ({ org, productKey: doc.productKey, cards: links.data ?? [] }), [org, doc.productKey, links.data]);
  const searchLinks = useCallback(
    (q: string) => api<{ suggestions: LinkSuggestion[] }>(`/orgs/${org}/links/search?${new URLSearchParams({ product: doc.productId, q })}`).then((r) => r.suggestions),
    [org, doc.productId],
  );
```

4. `save` 的 `invalidate: [qk.documentRevisions(org, doc.id)],` 改为 `invalidate: [qk.documentRevisions(org, doc.id), linkKeys(org)],`（保存后刷新链接卡；`onSuccess` 写缓存的方式不变）。
5. 「有未保存的修改时…」那个 `useEffect` 之后加：

```tsx
  // 地址栏指定了小节：等编辑器渲染出标题后滚动过去（最多等 3 秒）
  useEffect(() => {
    if (!section) return;
    let tries = 0;
    const timer = setInterval(() => {
      const heads = container.current ? [...container.current.querySelectorAll<HTMLElement>('[data-content-type="heading"]')] : [];
      const i = findSectionIndex(
        heads.map((h) => h.textContent ?? ''),
        section,
      );
      tries += 1;
      if (i >= 0 || tries >= 30) {
        clearInterval(timer);
        heads[i]?.scrollIntoView({ block: 'start' });
      }
    }, 100);
    return () => clearInterval(timer);
  }, [section]);

  /** 点击正文里的链接卡：站内跳转（编辑区是可编辑区域，浏览器不会自己跟随链接）。 */
  const onBodyClick = (e: MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('[data-wikilink-href]');
    if (link?.dataset.wikilinkHref) {
      e.preventDefault();
      router.push(link.dataset.wikilinkHref);
    }
  };
```

6. 编辑区容器 `<div ref={container} className="relative px-2 py-4" onMouseUp={onSelect} onKeyUp={onSelect}>` 加 `onClick={onBodyClick}`；`<DocumentBodyEditor … />` 加两个属性 `decorations={decorations} searchLinks={editable ? searchLinks : undefined}`。

`apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`：`<EditorPane key={`${d.id}:${epoch}`} ref={editor} org={org} doc={d} onReload={() => void reload()} />` 加属性 `section={searchParams.get('section')}`。

`apps/web/src/app/globals.css` 末尾加：

```css
/* PRD 编辑器：[[ ]] 链接与链接卡挂件（挂件文字在 data-label 里，由 ::after 显示，不进入 DOM 文本） */
.wikilink {
  color: var(--primary);
}
.wikilink-grey {
  color: var(--muted-foreground);
  text-decoration: line-through dashed;
}
.wikilink-card {
  margin-left: 2px;
  font-size: 12px;
  color: var(--muted-foreground);
  cursor: pointer;
  user-select: none;
}
.wikilink-card::after {
  content: attr(data-label);
}
a.wikilink-card:hover {
  text-decoration: underline;
}
```

- [ ] **Step 6: 运行测试**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts && pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e documents-links.spec.ts documents-editor.spec.ts documents-revisions.spec.ts documents-import.spec.ts documents-permissions.spec.ts documents.spec.ts`
Expected: PASS（P2-A 的编辑器用例原样通过，证明自动保存不变量没有被破坏）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/features/documents/editor/decorations.ts apps/web/src/features/documents/editor/prd-editor.tsx apps/web/src/features/documents/model.ts apps/web/src/features/documents/model.test.ts "apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/page.tsx" apps/web/src/app/globals.css apps/web/e2e/documents-links.spec.ts
git commit -m "feat(web): PRD 编辑器 [[ 补全、链接卡显示与小节跳转（装饰插件，不改正文）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 页面：PRD 编辑器评论锚点高亮与点击联动

**Files:**
- Modify: `apps/web/src/features/documents/model.ts`、`apps/web/src/features/documents/model.test.ts`（`locateAnchorRange`、`editorAnchors`）
- Modify: `apps/web/src/features/documents/editor/decorations.ts`
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`、`apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`、`apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Test: `apps/web/e2e/documents-anchors.spec.ts`

**Interfaces:**
- Consumes: Task 12 `DecorationInput`、`decorationsKey`、`flowerDecorations`；现有 `squash`（`@flower/core/markdown`）、`useDocumentComments`
- Produces:
  - `type TextSegment = { text: string; pos: number }`；`locateAnchorRange(segments: TextSegment[], a: { quote: string; prefix: string; suffix: string }): { from: number; to: number } | null`
  - `type EditorAnchor = { id: string; quote: string; prefix: string; suffix: string }`；`editorAnchors(comments: DocumentComment[]): EditorAnchor[]`
  - `DecorationInput` 增加 `anchors: EditorAnchor[]; activeAnchorId: string | null`；高亮为 `.comment-anchor[data-comment-id]`，当前一条加 `.comment-anchor-active`
  - `EditorPane` 新增可选属性 `activeCommentId?: string | null`、`onAnchorClick?: (commentId: string) => void`
  - `DocumentComments` 新增可选属性 `focus?: { id: string; seq: number } | null`；每条顶层评论 `id="comment-{id}"`，当前一条 `aria-current="true"`

- [ ] **Step 1: 写失败的测试**

`apps/web/src/features/documents/model.test.ts`：import 列表加 `editorAnchors, locateAnchorRange`；文件末尾加：

```ts
describe('评论锚点在编辑器中的位置', () => {
  const segs = [
    { text: '上传大文件时', pos: 1 },
    { text: '经常超时', pos: 8 },
    { text: '。下载也经常超时', pos: 20 },
  ];

  it('跨文本节点、忽略空白；多处出现时按前后文取', () => {
    expect(locateAnchorRange(segs, { quote: '经常超时', prefix: '上传大文件时', suffix: '。' })).toEqual({ from: 8, to: 12 });
    expect(locateAnchorRange(segs, { quote: '经常超时', prefix: '下载也', suffix: '' })).toEqual({ from: 24, to: 28 });
    expect(locateAnchorRange(segs, { quote: '大 文件', prefix: '', suffix: '' })).toEqual({ from: 3, to: 6 });
    expect(locateAnchorRange(segs, { quote: '不存在', prefix: '', suffix: '' })).toBeNull();
  });

  it('只高亮顶层、定位正常、未解决的划词评论', () => {
    const base = { parentId: null, author: null, body: 'x', resolvedAt: null, resolvedBy: null, createdAt: '2026-10-09T00:00:00.000Z', links: [] };
    const anchor = { quote: '经常超时', prefix: 'p', suffix: 's', sectionHeading: null };
    const list = [
      { ...base, id: 'a', anchor, anchorState: 'ok' as const },
      { ...base, id: 'b', anchor, anchorState: 'stale' as const },
      { ...base, id: 'c', anchor, anchorState: 'ok' as const, resolvedAt: '2026-10-09T01:00:00.000Z' },
      { ...base, id: 'd', anchor: null, anchorState: null },
      { ...base, id: 'e', anchor, anchorState: 'ok' as const, parentId: 'a' },
    ];
    expect(editorAnchors(list)).toEqual([{ id: 'a', quote: '经常超时', prefix: 'p', suffix: 's' }]);
  });
});
```

新建 `apps/web/e2e/documents-anchors.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('评论锚点：未解决的划词评论在正文中高亮，点击后评论区滚动到该条并标出；已解决、已失效的不高亮', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '锚点' });
  const filler = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段说明文字。`).join('\n\n');
  const md = (plan: string) => `## 1. 背景\n\n上传大文件时经常超时，需要重试。\n\n下载也会失败。\n\n## 2. 方案\n\n${plan}\n\n${filler}`;
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: md('采用分片上传。') } }));
  const add = async (body: string, quote: string, prefix = '', suffix = '') =>
    (await json<{ comment: { id: string } }>(request.post(`/api/v1/orgs/acme/documents/${doc.id}/comments`, { data: { body, anchor: { quote, prefix, suffix } } }))).comment;
  const open = await add('超时阈值是多少？', '经常超时', '上传大文件时', '，需要重试');
  const done = await add('已确认', '下载也会失败');
  await ok(request.post(`/api/v1/orgs/acme/document-comments/${done.id}/resolve`, { data: { resolved: true } }));
  const stale = await add('分片大小？', '采用分片上传');
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version + 1, markdown: md('改用断点续传。') } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('经常超时');
  await expect(body.locator(`[data-comment-id="${open.id}"]`)).toHaveText('经常超时');
  await expect(body.locator('[data-comment-id]')).toHaveCount(1);
  await expect(body.locator(`[data-comment-id="${done.id}"]`)).toHaveCount(0);
  await expect(body.locator(`[data-comment-id="${stale.id}"]`)).toHaveCount(0);

  const item = page.locator(`#comment-${open.id}`);
  await expect(item).not.toBeInViewport();
  await body.locator(`[data-comment-id="${open.id}"]`).click();
  await expect(item).toHaveAttribute('aria-current', 'true');
  await expect(item).toBeInViewport();
  await expect(body.locator('.comment-anchor-active')).toHaveText('经常超时');
});
```

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts`
Expected: FAIL（`locateAnchorRange` 未导出）。

Run: `pnpm --filter @flower/web e2e documents-anchors.spec.ts`
Expected: FAIL（正文里没有 `[data-comment-id]`）。

- [ ] **Step 2: 纯函数**

`apps/web/src/features/documents/model.ts`：第一行 import 改为

```ts
import { DOCUMENT_STATUSES, type DocumentStatus, type ExternalProvider, normalizeHeading, splitSections, squash, type TemplateSection } from '@flower/core/markdown';
```

文件末尾加：

```ts
export type TextSegment = { text: string; pos: number };
export type EditorAnchor = { id: string; quote: string; prefix: string; suffix: string };

/** 与 squash 相同的忽略规则：空白与不影响阅读的 Markdown 符号。 */
const IGNORED = /[\s*_~`|\\]/;

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
 * 划词评论的原文在编辑器文档中的位置 [from, to)：与服务端 locateQuote 相同的比较方式（忽略空白与 Markdown 符号）
 * 和打分规则（与 prefix 的公共后缀 + 与 suffix 的公共前缀）。segments 是文档里依次出现的文本节点。找不到返回 null。
 */
export function locateAnchorRange(segments: TextSegment[], a: { quote: string; prefix: string; suffix: string }): { from: number; to: number } | null {
  let text = '';
  const posAt: number[] = [];
  for (const s of segments) {
    for (let i = 0; i < s.text.length; i++) {
      const ch = s.text[i]!;
      if (IGNORED.test(ch)) continue;
      text += ch;
      posAt.push(s.pos + i);
    }
  }
  const q = squash(a.quote);
  if (!q) return null;
  const pre = squash(a.prefix);
  const suf = squash(a.suffix);
  let best: { score: number; at: number } | null = null;
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) {
    const score = commonSuffix(text.slice(0, i), pre) + commonPrefix(text.slice(i + q.length), suf);
    if (!best || score > best.score) best = { score, at: i };
  }
  return best ? { from: posAt[best.at]!, to: posAt[best.at + q.length - 1]! + 1 } : null;
}

/** 编辑器里要高亮的评论：顶层、定位正常（已失效与未定位的不算）、未解决的划词评论。 */
export function editorAnchors(comments: DocumentComment[]): EditorAnchor[] {
  return comments
    .filter((c) => !c.parentId && c.anchor && c.anchorState === 'ok' && !c.resolvedAt)
    .map((c) => ({ id: c.id, quote: c.anchor!.quote, prefix: c.anchor!.prefix, suffix: c.anchor!.suffix }));
}
```

- [ ] **Step 3: 装饰插件加上评论锚点**

`apps/web/src/features/documents/editor/decorations.ts`：

1. 加 import `import { type EditorAnchor, locateAnchorRange, type TextSegment } from '@/features/documents/model';`
2. `DecorationInput` 改为：

```ts
/** 推给编辑器的显示数据：正文里 [[ ]] 的链接卡与要高亮的评论锚点。只影响显示，不改正文。 */
export type DecorationInput = { org: string; productKey: string; cards: LinkCard[]; anchors: EditorAnchor[]; activeAnchorId: string | null };
```

3. `build` 整个替换为：

```ts
function build(doc: Doc, input: DecorationInput | null): DecorationSet {
  if (!input) return DecorationSet.empty;
  const decos: Decoration[] = [];
  const segments: TextSegment[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const parts: TextPart[] = [];
    node.forEach((child, offset) => {
      if (!child.isText) return;
      const part = { text: child.text ?? '', pos: pos + 1 + offset, code: child.marks.some((m) => m.type.name === 'code') };
      parts.push(part);
      segments.push({ text: part.text, pos: part.pos });
    });
    if (node.type.spec.code) return false;
    for (const r of wikiRangesInBlock(parts)) {
      const card = cardFor(input.cards, r.target, input.productKey);
      decos.push(Decoration.inline(r.from, r.to, { class: isGrey(card) ? 'wikilink wikilink-grey' : 'wikilink' }));
      decos.push(
        Decoration.widget(r.to, () => chip(card, r.target, input.org), {
          side: 1,
          ignoreSelection: true,
          key: `${r.target}|${card?.state ?? 'missing'}|${card?.title ?? ''}|${card?.status?.label ?? ''}`,
        }),
      );
    }
    return false;
  });
  for (const a of input.anchors) {
    const range = locateAnchorRange(segments, a);
    if (!range) continue;
    decos.push(
      Decoration.inline(range.from, range.to, {
        class: a.id === input.activeAnchorId ? 'comment-anchor comment-anchor-active' : 'comment-anchor',
        'data-comment-id': a.id,
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}
```

- [ ] **Step 4: 编辑区、评论区与详情页联动**

`apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx`（P2-A 的保存逻辑不动）：

1. `import { findSectionIndex, type SaveState, saveStateLabel } from '@/features/documents/model';` 改为 `import { editorAnchors, findSectionIndex, type SaveState, saveStateLabel } from '@/features/documents/model';`；`import { linkKeys, qk, useApiMutation, useDocumentLinks } from '@/lib/queries';` 改为 `import { linkKeys, qk, useApiMutation, useDocumentComments, useDocumentLinks } from '@/lib/queries';`
2. 签名的解构与类型加上 `activeCommentId` 与 `onAnchorClick`：

```tsx
export function EditorPane({
  org,
  doc,
  onReload,
  section,
  activeCommentId = null,
  onAnchorClick,
  ref,
}: {
  org: string;
  doc: DocumentDetail;
  onReload: () => void;
  /** 地址栏 ?section=：编辑器渲染后滚动到这个小节。 */
  section?: string | null;
  /** 评论区当前选中的评论：正文里对应的高亮加深。 */
  activeCommentId?: string | null;
  /** 点击正文里的评论高亮。 */
  onAnchorClick?: (commentId: string) => void;
  ref?: Ref<EditorPaneHandle>;
}) {
```

3. Task 12 加的 `decorations` 改为：

```tsx
  const comments = useDocumentComments(org, doc.id);
  const anchors = useMemo(() => editorAnchors(comments.data ?? []), [comments.data]);
  const decorations = useMemo<DecorationInput>(
    () => ({ org, productKey: doc.productKey, cards: links.data ?? [], anchors, activeAnchorId: activeCommentId }),
    [org, doc.productKey, links.data, anchors, activeCommentId],
  );
```

4. `onBodyClick` 改为：

```tsx
  /** 点击正文里的链接卡：站内跳转（编辑区是可编辑区域，浏览器不会自己跟随链接）；点击评论高亮：交给评论区定位。 */
  const onBodyClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLElement>('[data-wikilink-href]');
    if (link?.dataset.wikilinkHref) {
      e.preventDefault();
      router.push(link.dataset.wikilinkHref);
      return;
    }
    const anchor = target.closest<HTMLElement>('[data-comment-id]');
    if (anchor?.dataset.commentId) onAnchorClick?.(anchor.dataset.commentId);
  };
```

`apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`：

1. react 的 import 改为 `import { useEffect, useState } from 'react';`；`@/lib/utils` 加 `import { cn } from '@/lib/utils';`
2. `DocumentComments` 签名改为 `export function DocumentComments({ org, doc, focus = null }: { org: string; doc: DocumentDetail; focus?: { id: string; seq: number } | null })`，函数体开头（`const orgQ = useOrg(org);` 之前）加：

```tsx
  // 正文里点了某条评论的高亮：滚动到这条（seq 变化时同一条也会再滚动一次）
  useEffect(() => {
    if (focus) document.getElementById(`comment-${focus.id}`)?.scrollIntoView({ block: 'center' });
  }, [focus]);
```

3. 顶层评论的 `<li key={c.id} className="flex flex-col gap-2 py-3">` 改为：

```tsx
            <li
              key={c.id}
              id={`comment-${c.id}`}
              aria-current={focus?.id === c.id ? 'true' : undefined}
              className={cn('flex flex-col gap-2 py-3', focus?.id === c.id && '-mx-2 rounded-sm bg-amber-50 px-2 dark:bg-amber-900/20')}
            >
```

`apps/web/src/app/(app)/[org]/documents/[key]/page.tsx`：

1. `const [epoch, setEpoch] = useState(0);` 之后加：

```tsx
  // 正文里点击的评论高亮：评论区滚动并标出这一条，正文里的高亮加深
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
```

2. `<EditorPane … section={searchParams.get('section')} />` 再加两个属性 `activeCommentId={focus?.id ?? null} onAnchorClick={(id) => setFocus((f) => ({ id, seq: (f?.seq ?? 0) + 1 }))}`；`<DocumentComments org={org} doc={d} />` 改为 `<DocumentComments org={org} doc={d} focus={focus} />`。

`apps/web/src/app/globals.css` 末尾加：

```css
/* PRD 编辑器：未解决的划词评论 */
.comment-anchor {
  background: rgba(251, 191, 36, 0.28);
  cursor: pointer;
}
.comment-anchor-active {
  background: rgba(251, 191, 36, 0.6);
}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @flower/web exec vitest run src/features/documents/model.test.ts && pnpm --filter @flower/web lint --max-warnings 0 && pnpm typecheck`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e documents-anchors.spec.ts documents-links.spec.ts documents-editor.spec.ts documents-revisions.spec.ts`
Expected: PASS（`documents-revisions.spec.ts` 里的划词评论流程不受高亮影响）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/features/documents/model.ts apps/web/src/features/documents/model.test.ts apps/web/src/features/documents/editor/decorations.ts "apps/web/src/app/(app)/[org]/documents/[key]/editor-pane.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx" "apps/web/src/app/(app)/[org]/documents/[key]/page.tsx" apps/web/src/app/globals.css apps/web/e2e/documents-anchors.spec.ts
git commit -m "feat(web): PRD 编辑器高亮未解决的评论锚点，点击后评论区滚动到该条

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: PRD 未读评论：打开即已读，进工作台

**Files:**
- Modify: `packages/core/src/documents/comments.ts`（`markDocumentCommentsRead`）
- Modify: `packages/core/src/workbench/workbench.ts`
- Modify: `apps/web/src/server/routes/documents.ts`
- Modify: `apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`（打开即标为已读）
- Modify: `apps/web/src/features/workbench/model.ts`、`apps/web/src/features/workbench/model.test.ts`、`apps/web/src/app/(app)/[org]/page.tsx`
- Test: `packages/core/test/workbench.test.ts`、`apps/web/e2e/workbench.spec.ts`

**Interfaces:**
- Consumes: 现有 `comments`、`commentReads`、`documents`、`documentDisplayKey`、`loadDocument`
- Produces:
  - `markDocumentCommentsRead(db, actor, documentId: string): Promise<number>`（只读 Token：`AppError('forbidden', '只读 Token 不能标记已读')`）
  - `POST /orgs/:org/documents/:id/comments/read` → `{ marked: number }`
  - `WorkbenchUnread` 改为 `{ org; requirementId: string | null; documentId: string | null; displayKey; title; unread; lastAt }`（需求行 `documentId` 为 null，PRD 行 `requirementId` 为 null）
  - `unreadHref(u: Workbench['unread']['items'][number]): string`（`features/workbench/model.ts`）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/workbench.test.ts`：

1. import 区加：

```ts
import { addDocumentComment, markDocumentCommentsRead } from '../src/documents/comments';
import { createDocument } from '../src/documents/documents';
```

并把 `import { asMember, regularIteration, reviewWorkflow, seedInstance } from './factories';` 改为 `import { asMember, readOnlyToken, regularIteration, reviewWorkflow, seedInstance } from './factories';`

2. `describe('工作台', …)` 的最后（「跨组织隔离」用例之后）加：

```ts
  it('PRD 的未读评论：我负责的或我评论过的 PRD 上别人发的；标记已读后消失；需求行不受影响', async () => {
    const peer = (await resolveActor(t.db, peerAccountId, 'acme'))!;
    const owned = await createDocument(t.db, owner, mine.productId, { title: '我负责的 PRD', ownerMemberId: owner.memberId });
    const joined = await createDocument(t.db, peer, mine.productId, { title: '我评论过的 PRD', ownerMemberId: peer.memberId });
    const unrelated = await createDocument(t.db, peer, mine.productId, { title: '无关的 PRD', ownerMemberId: peer.memberId });
    await addDocumentComment(t.db, peer, owned.id, { body: '负责人看一下' });
    await addDocumentComment(t.db, owner, joined.id, { body: '我先提一个问题' });
    await addDocumentComment(t.db, peer, joined.id, { body: '已回答' });
    await addDocumentComment(t.db, peer, unrelated.id, { body: '与我无关' });

    const before = await getWorkbench(t.db, account.id, { today: TODAY });
    expect(before.unread.items.filter((u) => u.documentId).map((u) => [u.displayKey, u.title, u.unread, u.requirementId]).sort()).toEqual([
      [owned.displayKey, '我负责的 PRD', 1, null],
      [joined.displayKey, '我评论过的 PRD', 1, null],
    ]);
    expect(before.unread.items.filter((u) => u.requirementId).every((u) => u.documentId === null)).toBe(true);

    await expect(markDocumentCommentsRead(t.db, readOnlyToken(owner), owned.id)).rejects.toMatchObject({ code: 'forbidden', message: '只读 Token 不能标记已读' });
    expect(await markDocumentCommentsRead(t.db, owner, owned.id)).toBe(1);
    expect(await markDocumentCommentsRead(t.db, owner, joined.id)).toBe(1);
    expect((await getWorkbench(t.db, account.id, { today: TODAY })).unread.items.filter((u) => u.documentId)).toEqual([]);
  });
```

（放在「跨组织隔离」之后：这条用例让同事有了未读评论，放在前面会改变那条用例的结果。）

`apps/web/src/features/workbench/model.test.ts`：import 加 `unreadHref`；文件末尾 `});` 之前加：

```ts
  it('未读评论：需求去需求详情，PRD 去 PRD 详情', () => {
    const u = { org, title: 't', unread: 1, lastAt: '2026-10-09T00:00:00.000Z' };
    expect(unreadHref({ ...u, requirementId: 'r1', documentId: null, displayKey: 'PAN-1' })).toBe('/acme/requirements/PAN-1');
    expect(unreadHref({ ...u, requirementId: null, documentId: 'd1', displayKey: 'PAN-PRD-1' })).toBe('/acme/documents/PAN-PRD-1');
  });
```

`apps/web/e2e/workbench.spec.ts` 末尾加：

```ts
test('工作台的 PRD 未读评论：我负责的 PRD 上别人的评论；打开 PRD 后变为已读', async ({ page, request, playwright }) => {
  const productId = await createProduct(request);
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const doc = (await json<{ document: { id: string; displayKey: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/documents`, { data: { title: '登录 PRD', ownerMemberId: me } })))
    .document;
  const agent = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/agents', { data: { displayName: '评审助手' } }))).member.id;
  const { token } = await json<{ token: string }>(
    request.post('/api/v1/orgs/acme/tokens', { data: { memberId: agent, name: '评论', scope: { products: 'all', access: 'write' } } }),
  );
  const bot = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  await ok(bot.post(`/api/v1/orgs/acme/documents/${doc.id}/comments`, { data: { body: '背景还缺数据' } }));
  await bot.dispose();

  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  const unread = page.getByRole('region', { name: /未读评论/ });
  await expect(unread.getByRole('link', { name: new RegExp(doc.displayKey) })).toContainText('1 条未读');
  const read = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc.id}/comments/read`) && r.request().method() === 'POST');
  await unread.getByRole('link', { name: new RegExp(doc.displayKey) }).click();
  await expect(page).toHaveURL(new RegExp(`/acme/documents/${doc.displayKey}$`));
  expect((await read).ok()).toBeTruthy();
  await expect(page.getByRole('region', { name: /^评论/ })).toContainText('背景还缺数据');
  await page.goto('/acme');
  await expect(page.getByRole('region', { name: /未读评论/ })).toContainText('没有未读评论');
});
```

Run: `pnpm --filter @flower/core exec vitest run test/workbench.test.ts && pnpm --filter @flower/web exec vitest run src/features/workbench/model.test.ts`
Expected: FAIL（`markDocumentCommentsRead`、`unreadHref` 不存在）。

- [ ] **Step 2: 标记已读**

`packages/core/src/documents/comments.ts`：drizzle 的 import 改为 `import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';`；文件末尾加：

```ts
/** 打开 PRD 详情时把它的全部评论标为已读（与需求详情一致）；只读 Token 不能标记。 */
export async function markDocumentCommentsRead(db: Db, actor: Actor, documentId: string): Promise<number> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能标记已读');
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const already = tx.select({ id: commentReads.commentId }).from(commentReads).where(eq(commentReads.memberId, actor.memberId));
    const unread = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(and(onDocument(documentId), notInArray(comments.id, already)));
    if (unread.length === 0) return 0;
    await tx
      .insert(commentReads)
      .values(unread.map((c) => ({ orgId: actor.orgId, commentId: c.id, memberId: actor.memberId })))
      .onConflictDoNothing();
    return unread.length;
  });
}
```

`apps/web/src/server/routes/documents.ts`：import 列表加 `markDocumentCommentsRead`；在 `app.post('/orgs/:org/documents/:id/comments', …)` 之后加：

```ts
  app.post('/orgs/:org/documents/:id/comments/read', async (c) =>
    c.json({ marked: await markDocumentCommentsRead(deps.db, c.get('actor'), c.req.param('id')) }),
  );
```

- [ ] **Step 3: 工作台**

`packages/core/src/workbench/workbench.ts`：

1. `WorkbenchUnread` 改为：

```ts
export type WorkbenchUnread = {
  org: WorkbenchOrg;
  /** 需求上的未读评论为需求 id，PRD 上的为 null。 */
  requirementId: string | null;
  /** PRD 上的未读评论为 PRD id，需求上的为 null。 */
  documentId: string | null;
  displayKey: string;
  title: string;
  unread: number;
  lastAt: Date;
};
```

2. 需求未读的映射 `return { org, requirementId: r.id, displayKey: keyFor(r), title: r.title, unread: u.unread, lastAt: u.lastAt };` 改为：

```ts
      return { org, requirementId: r.id, documentId: null, displayKey: keyFor(r), title: r.title, unread: u.unread, lastAt: u.lastAt };
```

3. 在 `return { owned, tasks: myTasks, signatures, unread };` 之前加：

```ts
    // 我负责的、或我评论过的 PRD 上别人发的、我还没读的评论
    const docUnreadRows = await tx
      .select({
        documentId: comments.targetId,
        unread: sql<number>`count(*)::int`,
        lastAt: sql`max(${comments.createdAt})`.mapWith(comments.createdAt),
      })
      .from(comments)
      .innerJoin(documents, eq(documents.id, comments.targetId))
      .where(
        and(
          eq(comments.targetType, 'document'),
          isNull(documents.deletedAt),
          inArray(documents.productId, visible),
          or(isNull(comments.authorMemberId), ne(comments.authorMemberId, actor.memberId)),
          sql`not exists (select 1 from ${commentReads} where ${commentReads.commentId} = ${comments.id} and ${commentReads.memberId} = ${actor.memberId})`,
          or(
            eq(documents.ownerMemberId, actor.memberId),
            sql`exists (select 1 from ${comments} as mine where mine.target_type = 'document' and mine.target_id = ${documents.id} and mine.author_member_id = ${actor.memberId})`,
          ),
        ),
      )
      .groupBy(comments.targetId);
    const unreadDocs =
      docUnreadRows.length > 0
        ? await tx
            .select({ id: documents.id, productId: documents.productId, number: documents.number, title: documents.title })
            .from(documents)
            .where(inArray(documents.id, docUnreadRows.map((u) => u.documentId)))
        : [];
    const docById = new Map(unreadDocs.map((d) => [d.id, d]));
    for (const u of docUnreadRows) {
      const d = docById.get(u.documentId)!;
      unread.push({ org, requirementId: null, documentId: d.id, displayKey: documentDisplayKey(keyOf.get(d.productId)!, d.number), title: d.title, unread: u.unread, lastAt: u.lastAt });
    }
```

并把需求未读的 `const unread = unreadRows.map((u) => {` 改为 `const unread: WorkbenchUnread[] = unreadRows.map((u) => {`（后面要往里追加 PRD 行）。

- [ ] **Step 4: 页面**

`apps/web/src/features/workbench/model.ts` 末尾加：

```ts
/** 未读评论：需求去需求详情，PRD 去 PRD 详情（打开即标为已读）。 */
export function unreadHref(u: Workbench['unread']['items'][number]): string {
  return u.documentId ? `/${u.org.slug}/documents/${u.displayKey}` : requirementHref(u.org, u.displayKey);
}
```

`apps/web/src/app/(app)/[org]/page.tsx`：

1. `import { requirementHref, showOrgBadge, signatureHref, taskHref } from '@/features/workbench/model';` 改为 `import { requirementHref, showOrgBadge, signatureHref, taskHref, unreadHref } from '@/features/workbench/model';`
2. 「未读评论」区块的 `empty="你负责的需求上没有未读评论"` 改为 `empty="没有未读评论"`；`<li key={u.requirementId}>` 改为 `<li key={u.requirementId ?? u.documentId}>`；`<Link href={requirementHref(u.org, u.displayKey)} className={ROW}>`（在「未读评论」区块里的那一处）改为 `<Link href={unreadHref(u)} className={ROW}>`。

`apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx`：`DocumentComments` 中 Task 13 加的滚动 `useEffect` 之后加：

```tsx
  // 打开 PRD 详情即把评论标为已读（与需求详情一致）；只读 Token 会被拒绝，静默忽略
  const read = useApiMutation(() => api(`/orgs/${org}/documents/${doc.id}/comments/read`, { method: 'POST' }), { invalidate: [qk.workbench], silentError: true });
  const readMutate = read.mutate;
  useEffect(() => {
    readMutate(undefined);
  }, [doc.id, readMutate]);
```

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @flower/core exec vitest run test/workbench.test.ts test/document-comments.test.ts && pnpm --filter @flower/web exec vitest run src/features/workbench/model.test.ts test/api/reviews-workbench.test.ts && pnpm typecheck && pnpm --filter @flower/web lint --max-warnings 0`
Expected: PASS。

Run: `pnpm --filter @flower/web e2e workbench.spec.ts documents-permissions.spec.ts documents-revisions.spec.ts`
Expected: PASS（只读 Token 打开 PRD 时标记已读被拒绝，页面不出现错误提示）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/documents/comments.ts packages/core/src/workbench/workbench.ts packages/core/test/workbench.test.ts apps/web/src/server/routes/documents.ts "apps/web/src/app/(app)/[org]/documents/[key]/comments.tsx" apps/web/src/features/workbench/model.ts apps/web/src/features/workbench/model.test.ts "apps/web/src/app/(app)/[org]/page.tsx" apps/web/e2e/workbench.spec.ts
git commit -m "feat: PRD 的未读评论进工作台（我负责或评论过的 PRD），打开 PRD 即标为已读

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 用户检查点：本地开发库执行迁移、核对任务补号；（经同意后）重导 pan123

**Files:**
- 不改代码。只操作本地开发库与 `.local-data/`（不提交）。

**Interfaces:**
- Consumes: Task 2 的迁移 `0011`、`0012` 与迁移工具的任务编号；已有的 `legacy import`（`--replace`）与 `legacy rejoin`

- [ ] **Step 1: 迁移前只读核对**

```bash
docker exec flower-postgres-1 psql -U flower_admin -d flower -At \
  -c "select count(*) from tasks t join organizations o on o.id = t.org_id where o.slug = 'pan123'" \
  -c "select count(*), count(distinct (coalesce(i.product_id::text, ''), i.name)) from iterations i join organizations o on o.id = i.org_id where o.slug = 'pan123' and i.type = 'regular' and i.deleted_at is null"
```

Expected: 任务 377；常规迭代两个数相等（2026-10-09 为 11 / 11）。不相等时停下来报告（`0011` 的唯一索引会创建失败）。

- [ ] **Step 2: 执行迁移并核对补号**

```bash
pnpm db:migrate
docker exec flower-postgres-1 psql -U flower_admin -d flower -At \
  -c "select count(*), count(t.number), count(distinct t.number), min(t.number), max(t.number) from tasks t join organizations o on o.id = t.org_id where o.slug = 'pan123'" \
  -c "select p.key, p.task_seq from products p join organizations o on o.id = p.org_id where o.slug = 'pan123'" \
  -c "select count(*) from (select t.number, row_number() over (order by t.created_at, t.id) as rn from tasks t join organizations o on o.id = t.org_id where o.slug = 'pan123') x where x.number <> x.rn" \
  -c "select count(*) from entity_links" \
  -c "select relrowsecurity from pg_class where relname = 'entity_links'"
```

Expected: `pnpm db:migrate` 应用 `0011`、`0012`，并把 `flower_app` 的密码改回 `apps/web/.env.local` 的值；任务 `377|377|377|1|377`；`PAN|377`；顺序不符的 0 条；`entity_links` 0 行；RLS 为 `t`。把补号结果另存一份供重导后对比（只含旧系统键与编号，放在 `.local-data/`，不提交）：

```bash
docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select t.legacy_key, t.number from tasks t join organizations o on o.id = t.org_id where o.slug = 'pan123' order by 1" > "$PWD/.local-data/reports/task-numbers-backfill.txt"
wc -l "$PWD/.local-data/reports/task-numbers-backfill.txt"
```

Expected: 377 行。

- [ ] **Step 3: STOP——向控制方汇报，等待用户确认**

执行代理在这里停下，把 Step 1、2 的数量交给控制方，由控制方转给用户，并请用户答复：

- 是否用 `--replace` 重导本地开发库的 pan123，验证迁移工具导入时给任务编的号与补号迁移一致。重导会删除 pan123 的全部数据后重建（测试账号之后用 `legacy rejoin` 恢复）。这一步可以跳过：补号迁移已经给现有任务编好号，迁移工具的编号规则有单元测试覆盖。

没有明确同意时不执行 Step 4，直接进入 Task 16。

- [ ] **Step 4（仅在 Step 3 得到同意后）：重导 pan123 并对比编号**

`--as-of` 沿用 `docs/p2a-validation.md` 记录的日期 `2026-09-29`；附件参数沿用 P2-A 的重导方式（`.local-data/prd_uploads` 已在 P2-A 导出）。

```bash
pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --owner-email <用户的账号邮箱> --as-of 2026-09-29 --uploads "$PWD/.local-data/prd_uploads" --storage "$PWD/apps/web/.flower-storage" --dry-run
```

Expected: 试跑输出「试跑完成，未写入数据库。」，报告 0 个问题（含新增的「同一产品内迭代名称重复」检查）。

```bash
pnpm --filter @flower/migrate legacy import --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping" --out "$PWD/.local-data/reports" --owner-email <用户的账号邮箱> --as-of 2026-09-29 --uploads "$PWD/.local-data/prd_uploads" --storage "$PWD/apps/web/.flower-storage" --replace
pnpm --filter @flower/migrate legacy rejoin --org-slug pan123 --owner-email <用户的账号邮箱> --accounts "$PWD/.local-data/test-accounts.json"
docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select t.legacy_key, t.number from tasks t join organizations o on o.id = t.org_id where o.slug = 'pan123' order by 1" > "$PWD/.local-data/reports/task-numbers-import.txt"
diff "$PWD/.local-data/reports/task-numbers-backfill.txt" "$PWD/.local-data/reports/task-numbers-import.txt" && echo 编号一致
docker exec flower-postgres-1 psql -U flower_admin -d flower -At -c "select p.task_seq from products p join organizations o on o.id = p.org_id where o.slug = 'pan123'"
```

Expected: 输出「编号一致」；`task_seq` 为 377。不一致时停下来报告差异行数（只报数量，不报内容）。

---

### Task 16: 全量验证、真实数据复验（控制方）、验证记录与交接

**Files:**
- Create: `docs/p2b1-validation.md`
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

- [ ] **Step 2: 编辑器输入延迟复测**

Run: `EDITOR_BENCH=1 pnpm --filter @flower/web e2e editor-perf.spec.ts`
Expected: 通过；把合成文档 20k / 40k / 80k / 160k 的加载与输入 p95 与 `docs/p2a-validation.md` 的基线对比（装饰插件在每次文档变化时重画），差异超过 20% 时在验证记录里写明。超过 P2-A 的阈值（加载 ≤ 1500 ms、输入 p95 ≤ 50 ms）时停下来报告。

- [ ] **Step 3: STOP——控制方在真实数据上复验界面**

执行代理不运行 `pnpm dev`。在这里停下，把下面的复验清单交给控制方；控制方在本地开发库（pan123）上以 1440px 与 760px 两种宽度逐项检查，确认页面本身不横向滚动，把结论（只写现象与数量）交回：

1. 迭代甘特与人员负载显示 `PAN-T-n`，点进任务详情；任务详情字段与「被引用」。
2. 任选一条需求，编辑描述输入 `[[`：补全列表、按编号与标题搜索、选 PRD 后选小节；保存后链接卡的标题与状态；点击跳转。复验完把描述改回原文（或在测试账号能编辑的、复验专用的需求上进行）。
3. 一份 Flower 内 PRD：正文里输入 `[[` 的补全、自动保存后的链接卡、小节链接跳转与滚动；有划词评论时的高亮与点击联动（pan123 的迁移评论都是「未定位」，不会高亮，属预期）。复验在一份测试用 PRD 上进行，不改迁移来的 PRD 正文。
4. 需求、PRD、迭代详情页的「被引用」区块。
5. 工作台「未读评论」：PRD 行的链接与「条未读」，打开 PRD 后消失。

- [ ] **Step 4: 写验证记录**

新建 `docs/p2b1-validation.md`，结构与 `docs/p2a-validation.md` 一致，包含：

1. 迁移与补号：Task 15 的数量（任务 377、编号 1–377 连续、`task_seq` 377、顺序不符 0、常规迭代 11 个不重名）；如做了重导，写「导入编号与补号一致」与对账报告的问题数。
2. 自动化测试数量（Step 1）与编辑器复测表（Step 2）。
3. 界面复验结果（Step 3，每项「通过 / 问题与处理」）。
4. 人工验收清单（供用户试用）：三处输入框的 `[[` 补全与选小节、链接卡的标题状态与灰色说明、改标题或改迭代名称后链接不断、小节改名后显示失效、无权限时只显示编号、「被引用」、任务编号与任务详情、评论锚点高亮与联动、工作台的 PRD 未读评论。

- [ ] **Step 5: 更新交接文档与协作日志**

`docs/handoff.md`：

1. 「关键文档」表加三行：`docs/superpowers/specs/2026-10-09-flower-p2b1-links-design.md`（P2-B1 设计）、`docs/superpowers/plans/2026-10-09-flower-p2b1-links.md`（P2-B1 计划）、`docs/p2b1-validation.md`。
2. 「当前进度」加一条「P2-B1 双链与反向链接：已完成，待合并」，写清：`[[ ]]` 语法与补全、链接卡、「被引用」、任务编号与任务详情、评论锚点高亮、PRD 未读评论进工作台、补号迁移结果（数量）。
3. 「下一步」改为：合并 P2-B1；用户按 `docs/p2b1-validation.md` 第 4 节验收；规划 P2-B2（模块文档、影响声明、人工合入、结构树补建模块与功能点）；待用户决定的事项：需求的未读评论是否也加上「我参与过评论的」（见本计划文末冲突表）。

`docs/agent-log.md`「记录」最上面加一条（格式按文件头）：

```
### 2026-10-XX · 本地 · P2-B1 双链与反向链接
- 分支 / PR：`feat/p2b1-links`
- 做了什么：
  - 数据模型：entity_links（RLS）；tasks.number + products.task_seq（迁移按创建时间补号，迁移工具导入时同样编号）；同一产品内迭代名称唯一（部分唯一索引）。
  - 需求描述、PRD 正文、评论保存时解析 [[ ]] 并重建链接；新建或改名的目标接上悬空链接；链接卡（标题、状态、灰色说明、无权限只显示编号）；需求、PRD、任务、迭代详情页的「被引用」。
  - [[ 补全：纯文本输入框的列表与 PRD 编辑器的 BlockNote 补全菜单，选 PRD 后可选小节；PRD 编辑器用只读装饰插件显示链接卡与评论锚点高亮，不改正文、不触发自动保存。
  - 任务编号 PAN-T-n 与只读任务详情页；PRD 的未读评论进工作台，打开 PRD 即标为已读。
- 怎么验证的：（Task 16 Step 1 的测试数；Task 15 的补号数量；Step 2、3 的结论）
- 留给对方：（没有就写"无"）
```

- [ ] **Step 6: 提交**

```bash
git add docs/p2b1-validation.md docs/handoff.md docs/agent-log.md
git commit -m "docs: P2-B1 验证记录、交接进度与协作日志

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 与代码或数据的冲突

写计划时对照代码与只读数据发现的、与设计文档不一致之处，以及本计划的处理：

| 设计说法 | 实际情况 | 本计划的处理 |
|---|---|---|
| 设计 §4「`target_text`（原文，如 `PAN-PRD-12#需求说明`）」 | 不带产品前缀的迭代与节点写法依赖来源所在产品；只存原文，新建目标时无法按文字接上悬空链接，也无法按 `(org_id, target_text)` 查 | 存规范写法（编号大写、补产品前缀），见「设计决定」；页面用同一纯函数算写法找链接卡 |
| 设计 §4 写入时机「评论新建或修改」 | 现有代码没有修改评论的功能 | 只在新建评论时写链接；`syncSourceLinks` 可直接用于以后的评论修改 |
| 设计 §6「任务列表、任务详情……显示 `PAN-T-12`」「任务……详情页各加『被引用』」 | 没有任务详情页，任务只在甘特表里行内编辑 | 新增只读任务详情页 `/{org}/tasks/PAN-T-n`（含「被引用」），修改仍在甘特 |
| 设计 §6「PRD 未读评论……范围沿用需求的规则：我负责的，或我参与过评论的」 | 现有需求的未读规则只有「我负责的需求」（`workbench.ts`） | PRD 按设计写明的规则（负责或评论过）；需求规则不改，交接文档列为待用户决定 |
| 设计 §6「点击后右侧评论区滚动到该条」 | PRD 详情页的评论区在正文下方（右侧是状态与检查项侧栏） | 不调整布局，评论区（正文下方）滚动到该条并标出 |
| 设计 §7「改编号或改标题后链接不断」 | 需求、PRD、任务的编号不会变（产品编号前缀不能修改） | 端到端用改需求标题与改迭代名称覆盖；链接存目标 id，编号若将来可改同样不断 |
| 设计 §3「`\[[` 为转义」 | BlockNote 解析 Markdown 时吃掉反斜杠，PRD 正文保存一次后 `\[[` 变为 `[[` | 解析器按设计实现；PRD 正文里的字面 `[[` 建议写在行内代码中（记入设计决定） |
| 设计 §4 悬空链接在「改迭代名称、节点名称时」补上 | 移动节点同样改变节点名称路径 | 节点移动时也按新路径接上（整棵子树） |
| 上位文档 §6.4 `entity_links` 字段 `anchor` | P2-B1 设计 §4 为 `context` | 按 P2-B1 设计建 `context`，Task 2 同步改上位文档字段名 |

## P2-B1 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm --filter @flower/web lint --max-warnings 0`、`pnpm --filter @flower/web e2e`、`./scripts/smoke.sh` 全部通过；P2-A 的编辑器用例原样通过。
- 设计 §7 列出的内容都有单元或端到端测试：语法（各种写法、显示文字、代码块与行内代码、转义、大小写、跨产品前缀）、定位（旧编号别名、PRD 小节归一化）、悬空链接自动接上、任务编号分配与补号迁移；三处输入框的 `[[` 补全、链接卡跳转（含小节滚动）、「被引用」、改标题或改名后链接不断、小节改名后失效、无权限只显示编号、评论锚点高亮与点击联动、工作台的 PRD 未读评论。
- 本地开发库 pan123 执行补号迁移后数量核对一致（Task 15）；控制方在 1440px 与 760px 两种宽度下复验（Task 16），验证记录、交接文档与协作日志已更新。

## 自查

写完后对照设计逐条核对的结果：

| 设计条目 | 对应任务 |
|---|---|
| §3 语法（六类目标、显示文字、代码与转义、大小写、跨产品前缀、不带前缀按来源产品） | Task 1（纯函数与单测）、Task 4（解析写入） |
| §3 旧编号经 `entity_aliases` 解析；PRD 小节按评论锚点相同的归一化、同名取第一个 | Task 4（别名）、Task 6（小节有效性）、Task 7（小节补全） |
| §4 `entity_links` 字段、`origin`、三个索引、RLS | Task 2 |
| §4 写入时机（需求新建与改描述、PRD 保存含合并修订、恢复、导入、转换、评论新建）与先删后建 | Task 4（导入走保存与转换接口） |
| §4 悬空链接与自动接上（含迭代与节点改名） | Task 4（悬空写入）、Task 5（接上） |
| §4 断链（存 id；删除、取消显示灰色；小节失效） | Task 6、Task 10、Task 12 |
| §4 任务编号（分配、补号迁移、迁移工具） | Task 2、Task 3、Task 15 |
| §4 迭代名称唯一与报错文案；迁移前只读核对 | Task 2、Task 15 Step 1 |
| §5 权限（随来源写入；无权限只显示编号；「被引用」只列可见来源） | Task 4、Task 6、Task 10 |
| §6 补全（搜索规则、本产品优先、PRD 后选小节、键盘操作） | Task 7、Task 11、Task 12 |
| §6 链接卡（编号、标题、状态、跳转、小节滚动、灰色说明） | Task 6、Task 10、Task 12 |
| §6 「被引用」区块（需求、PRD、任务、迭代） | Task 6、Task 9、Task 10 |
| §6 任务编号显示（任务列表、任务详情、甘特、工作台） | Task 3、Task 9 |
| §6 评论锚点高亮与点击联动 | Task 13 |
| §6 PRD 未读评论与打开即已读 | Task 14 |
| §7 单元测试与端到端测试清单 | 见「P2-B1 完成标准」 |
| §7 真实数据补号核对、1440 / 760 复验 | Task 15、Task 16 |

- 占位检查：计划中没有「待定」「以后实现」或只描述不给代码的步骤；`<用户的账号邮箱>` 是执行时由用户提供的参数，沿用 P2-A 计划的写法。
- 名称一致性：`syncSourceLinks`、`relinkDangling`、`relinkNodes`、`nodePathTexts`、`iterationLinkTexts`、`linkCardsFor`、`sourceKey`、`listDocumentLinkCards`、`listBacklinks`、`searchLinkTargets`、`getTaskByKey`、`markDocumentCommentsRead` 在定义与使用处一致；`LinkCard.href` 一律为不含 `/{org}/` 的相对地址，页面统一用 `cardHref` 或 `/${org}/${href}` 拼接；`DecorationInput` 在 Task 12 定义、Task 13 扩展，`EditorPane` 的 `decorations` 随之更新。
- 依赖顺序：Task 9 的任务详情页用到的 `<Backlinks>` 在 Task 9 内新建；Task 12 依赖 Task 10 的 `cardFor` 等与 Task 11 的 `SUGGESTION_KIND_LABEL`；Task 14 的评论区改动建立在 Task 13 的 `useEffect` import 之上。
