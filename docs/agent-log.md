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

### 2026-10-23 · 云端 · 工作台三列改到 ≥1920，1536 任务标题能对上号（FIX-4）
- 分支 / PR：`fix/dux-e-workbench-3col-readable`（草稿，不要 merge，不要标 ready）
- 做了什么：已处理同日 FIX-4。工作台网格从 `xl:grid-cols-2 2xl:grid-cols-3` 改为 `xl:grid-cols-2 3xl:grid-cols-3`。`3xl` 是 `120rem`，根字号 16px 时等于 1920px，排在 `xl`（80rem）和 `2xl`（96rem）之后。直接写 `min-[1920px]:` 或把断点写成 `1920px` 都会排在 `xl:grid-cols-2` 前面，同一条规则被盖住，1920 仍是两列。xl 起两列，≥1920 才三列。没有任务卡跨列，没有标题折行，没有改卡内列、共享组件、后端和计数接口。删掉密度端到端里 4 处 `console.log`。断言改成可见字符不少于 8，或可见宽不少于 104px；可见宽与卡片可视区、裁切父级取交集，标题自己的 `min-w-[64px]` 撑不满 104。迭代名 `toBeVisible` 且可见宽不少于 32px。计划日和进度复用同一套裁切宽度，须完整落在可视区里。宽度阈值留 0.5px。补了多组织徽标（1536 / 1920 进度不被裁）和侧栏收起。`layout.spec` 按 1440 / 1536 两列、1920 三列断言。满负荷截图：`docs/dux-e/workbench-full-1280.png`、`workbench-full-1440.png`、`workbench-full-1536.png`、`workbench-full-1920.png`。不碰生产。
- 怎么验证的：`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。Playwright：`layout`、`tasks`、`ux-residual-batch1`、`work-items`、`workbench`、`dux-e-workbench-density` 共 22 条通过。单组织满负荷：1280 卡宽 480，长标题可见 9 字 / 96px，短标题 6 字 / 130px；1440 卡宽 560，长标题 13 字 / 176px，短标题 6 字 / 210px；1536 卡宽 608，长标题 13 字 / 224px，短标题 6 字 / 258px；1920 三列卡宽 528，长标题 13 字 / 144px，短标题 6 字 / 178px。多组织徽标下 1536 进度宽 40/40，1920 进度宽 40/40；1920 长标题可见 7 字 / 72px，序号还在。侧栏收起后 1536 仍两列，页头「收起」仍能收回说明。006-A、007-A、三字段没有回归。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰生产。回滚：去掉 `3xl` 断点，网格改回 `xl:grid-cols-2 2xl:grid-cols-3`。截图用 `WB_SHOT=1` 重跑 `dux-e-workbench-density` 会写回 `docs/dux-e/`。仓外的 ACCEPT-CRITERIA / FIX-BRIEF / GATE 不在本仓库，没有改。

### 2026-10-23 · 云端 · 工作台 1280 改两列，任务标题不再被挤没（FIX-3）
- 分支 / PR：`fix/dux-e-workbench-density`（草稿 #39，不要 merge，不要标 ready）
- 做了什么：已处理同日 FIX-3。工作台网格从 `xl:grid-cols-3` 改为 `xl:grid-cols-2 2xl:grid-cols-3`。1280 与 1440 是两列，1536 才三列。任务标题加 `min-w-[64px]`，迭代名去掉 `shrink-0`、保留截断，并加上 `title` 以便悬停看全名。端到端在 1280 断言任务标题的可见宽度（算上父级 overflow 裁切）不少于 64px，计划日和进度的右边界不超出行。截图覆盖 `docs/dux-e/workbench-full-1280.png`、`docs/dux-e/workbench-partial-1280.png`，并新增 `docs/dux-e/workbench-full-1536.png`。没有 masonry，没有改共享组件、后端和计数接口。不碰 47.x。
- 怎么验证的：`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。Playwright：`layout`、`tasks`、`ux-residual-batch1`、`work-items`、`workbench`、`dux-e-workbench-density` 共 20 条通过。1280 任务卡宽 480px，有计划日的长标题可见宽度 96px，未排期的短标题 130px。1536 任务卡宽 400px，六条标题可见宽度都是 64px。进度和计划日右边界都在行内。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。回滚：网格改回 `xl:grid-cols-3`，标题去掉 `min-w-[64px]`，迭代名加回 `shrink-0` 并去掉 `title`。截图用 `WB_SHOT=1` 重跑 `dux-e-workbench-density` 会写回 `docs/dux-e/`。

### 2026-10-23 · 云端 · 工作台卡片按内容定高（FIX-2）
- 分支 / PR：`fix/dux-e-workbench-density`（草稿 #39，不要 merge，不要标 ready）
- 做了什么：已处理同日 FIX-2。工作台网格加 `items-start`，卡片按内容定高，不再把同一行拉齐。空文案改为顶对齐、`py-2`，不再在被拉高的卡里垂直居中。任务行迭代名 `min-w-0 max-w-24 shrink-0 truncate`，进度百分比 `shrink-0`，长迭代名截断、不挤掉百分比。1280 的编号、迭代、计划日断言改成逐字段 `toBeVisible()`。「了解更多」展开后再点一次，回到 `aria-expanded=false` 和「了解更多」。满负荷造数在 `apps/web/e2e/dux-e-workbench-density.spec.ts`；截图在 `docs/dux-e/workbench-full-1280.png` 与 `docs/dux-e/workbench-partial-1280.png`。没有 masonry，没有改共享组件、后端和计数接口。不碰 47.x。
- 怎么验证的：`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。Playwright：`layout`、`tasks`、`ux-residual-batch1`、`work-items`、`workbench`、`dux-e-workbench-density` 共 20 条通过。1280 实测：6 条数据卡 289px，12 条检查项 535px，同行的 6 条简报/未读仍是 289px。部分有数据时空块 80px，空文案距卡顶 43px；有数据卡仍是 289px。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。回滚：去掉网格 `items-start`，空文案改回居中。截图用 `WB_SHOT=1` 重跑 `dux-e-workbench-density` 会写回 `docs/dux-e/`。

### 2026-10-23 · 云端 · 工作台任务行恢复计划日，页头按钮可收起（FIX-1）
- 分支 / PR：`fix/dux-e-workbench-density`（草稿 #39，不要 merge，不要标 ready）
- 做了什么：已处理同日组验的 FIX-1。任务行不再按卡宽隐藏需求编号、迭代名、计划日，「未排期」在 1280 上重新可见。`@container` 随这段隐藏逻辑去掉。页头「了解更多」带 `aria-controls` 和 `aria-expanded`，展开后按钮文案变成「收起」。端到端里空态 `status` 收在「工作台空态」组内。补了 1280 满负荷和部分有数据截图，只记录不改布局。没有新计数接口，没有改共享组件，没有动后端。不碰 47.x。
- 怎么验证的：`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。Playwright：`layout`、`tasks`、`ux-residual-batch1`、`work-items`、`workbench` 通过（矮提示那条在收起按钮改成 exact 后复跑通过）。1280 满负荷：六块都有条目；短标题任务行文字含需求编号、迭代名、「未排期」，该行 `scrollWidth` 等于 `clientWidth`。同行里检查项 12 条（高 535）把只有 6 条的简报和未读评论也拉到 535，6 条卡本身约 289。部分有数据（跟进、检查项、简报清成 0）：六张卡都是 289，空块被拉到同行有数据卡的高度，空文案垂直居中。截图在 PR 描述。006-B 不自标硬过。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。空块被拉高只记录，本提交不修。回滚仍是网格改回 `xl:grid-cols-2`、页头恢复原长 description、去掉全空矮条。

### 2026-10-23 · 云端 · 工作台密度与页头收束（DUX-006/007）
- 分支 / PR：`fix/dux-e-workbench-density`（草稿，不要 merge，不要标 ready）
- 做了什么：只做切片 E。工作台六块总数都是 0 时改成一条矮提示（「没有需要你处理的条目。」加去需求、跟进、任务、检查项、简报、未读评论的链接），不再铺六块等高空卡。有任意一块有数时仍分块列表。网格从 `xl:grid-cols-2` 改为 `xl:grid-cols-3`；行 `min-w-0` 截断，任务行的需求编号、迭代名、计划日在卡宽不够时先藏，标题和进度留着。页头说明收成一行「你负责、跟进、任务和待确认的条目。」加「了解更多」，展开后才是原来的长句。`PageHeader` 的说明从 `p` 换成同样式的 `div`，好放下按钮；其它页文案没改。没有新计数接口，没有改壳 max-w、需求列表/详情、甘特。不碰 47.x。
- 怎么验证的：`workbenchIsEmpty` 单测 8 项通过。`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。Playwright：`layout`、`tasks`、`ux-residual-batch1`、`work-items`、`workbench` 共 19 条通过。1280 空态截图：主区是一条矮提示，没有六块空卡；页头是一行加「了解更多」。1280 有数据截图：三列，有条目的卡是单行列表。006-A 自检过。006-B 满负荷未截，标待确认。007-A 软项：一行说明不压住下面的区块。计数 API 未做、未覆盖。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。回滚：网格改回 `xl:grid-cols-2`，页头恢复原长 description，去掉全空矮条。006-B 等满负荷 1280 截图后再升硬闸。未做 F（DUX-008～010）、未读/逾期计数。

### 2026-10-23 · 云端 · 需求列表次要列默认不显示
- 分支 / PR：`fix/dux-c-list-columns`（草稿，不要 merge，不要标 ready）
- 做了什么：只做 DUX-005。需求列表不再渲染「平台」「业务域」「提出人」「更新」。编号、标题、状态仍常显；优先级、负责人、迭代从 md 起显示（迭代从 xl 升到 md）。没有列设置，没有新的 localStorage。筛条、PRE-01 的 `related`、壳宽、详情、甘特、工作台、API 都没改。行高仍是 `h-10`。不碰 47.x。
- 怎么验证的：`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。Playwright `dux-c-list-columns` 1 条通过：1280 表头没有「平台」「业务域」「提出人」「更新」，有编号、标题、状态、优先级、负责人、迭代，标题列宽于其余列，表宽接近主区；1600 这四列仍不出现；760 这四列不在 DOM，优先级、负责人、迭代为 `hidden`，标题单元格宽大于 160，页面不横向溢出。`requirements` 8 条和 `ux-residual-batch1` 7 条通过（含 G2：760 标题可读并能打开详情）。截图在 PR 描述。本机 Postgres 16 跑的，不是 CI。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。回滚：把四列的表头和单元格加回去，迭代改回 `hidden xl:table-cell`。列设置留到二期。

### 2026-10-23 · 云端 · 需求详情单一右轨、紧凑状态、历史出主列
- 分支 / PR：`fix/dux-b-detail-narrative`（草稿，不要 merge，不要标 ready）
- 做了什么：B 余 DUX-002/003/004/011/012。PRE-02 把状态卡单独放在 `lg:row-start-1`，aside 不写行号，宽屏上 aside 落到 row2，跟进整段在主列底边之下。这次收成**一个**右轨父节点，DOM 顺序是跟进 → 状态 → 状态历史 → 简报及其余；主列与右轨都是 `lg:row-start-1`，右轨 `lg:col-start-2`。展开写死 380px，收起仍是 2.5rem 把手。`flower.req.detail.asideCollapsed` 与 `flower.shell.navCollapsed` 没改。右轨 `lg:sticky lg:top-4`、`lg:max-h-[calc(100vh-2rem)]`、`lg:overflow-y-auto`，收展把手在同一层，不再单独 sticky。状态是当前态一行 + `变更状态` 菜单（非法项禁用并带短因）+ 至多一个主按钮；未满足条件只在菜单项副文案里，按钮下不再挂常驻列表。状态历史离开主列，默认最近 3 条，可展开全部。没有改流转 API，没有拖拽改宽，没有改壳 max-width，没有动列表、工作台、甘特。空态折叠（RA-009/010/012）没做。不碰 47.x。
- 怎么验证的：`collapse`、`history-preview`、`status-menu` 单测 13 项通过（含 `trackingBelowMain` 对 PRE-02 分格为 true、单轨为 false）。`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。Playwright：`dux-b-rail`（1280 轨宽 380、跟进不在主列之下、滚到中段跟进仍贴在 top 16px 内；760 跟进 → 状态 → 历史 → 主列）、`pre02-collapse`、`requirements` 详情流转、`documents-prd-flow`、`ux-gap` 的 C3 与 M0-007，共 15 条通过。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。回滚：状态历史放回主列；右轨拆回状态格 + aside 两格；展开宽改回 320px；状态恢复竖排按钮。已处理同日并行提交把窄屏主列放在跟进前面的问题：760 仍是跟进 → 状态 → 历史，然后才是主列。

### 2026-10-23 · 云端 · 详情主叙事、紧凑状态与跟进置顶（B 余）
- 分支 / PR：`fix/dux-b-detail-narrative`（草稿，不要 merge，不要标 ready）
- 做了什么：DUX-002/003/004/011/012 同一 PR。状态历史从主列挪到右栏，顺序是跟进 → 状态 → 状态历史 → 其余属性。右栏展开定宽 **380px**（360–400），lg 起 `sticky top-4`，过长时栏内滚动。状态改成一行：色点 + 当前文案，至多一个主操作，其余下一态在「变更状态」里；条件不满足的停用并写短因，不再竖排全部流转按钮。PRE-02 的 localStorage 键和收起把手（2.5rem）没改。没有拖拽改宽。没有改流转 API 或状态机。不碰 47.x。
- 怎么验证的：`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。收展与状态菜单单测 13 通过。端到端：`pre02-collapse`、需求详情流转、`documents-prd-flow`、`ux-gap-p0-mid` 共 17 通过。1280 展开右栏宽在 360–400；滚过主列后跟进仍贴在视口上沿；收起后历史不在主列、把手仍在；760 跟进仍在状态前面。状态区高度小于 96，没有竖排流转按钮。截图在 PR 描述。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。回滚：历史放回主列，去掉 sticky，右栏回到 320，状态恢复竖排按钮，跟进回到状态下。

### 2026-10-23 · 云端 · 左导航图标轨与需求详情右栏可收起
- 分支 / PR：`fix/pre02-collapse-panels`（草稿，不要 merge，不要标 ready）
- 做了什么：只做 PRE-02。桌面（xl，1280）左导航可收到 56px 图标轨（`xl:w-14`），展开仍是 `w-60`。需求详情右栏在 lg 及以上整列收成 40px 把手，状态卡一并收起，中间列变宽；状态历史仍留在主列。偏好只写 localStorage：`flower.shell.navCollapsed`、`flower.req.detail.asideCollapsed`（`1` 收起，`0` 或没有则展开）。760 抽屉仍是宽 240 的文字导航，汉堡、Esc、遮罩、收起都在；桌面收起偏好不会把窄屏右栏藏掉。没有新 API，没有迁移，没有账号同步。不做 DUX-002 / DUX-003 / DUX-004。不碰 47.x。已变基到 main@e24e042c（PRE-01 已合入）；冲突只在本日志，列表与 `related=me` 未改。
- 怎么验证的：变基到 main@e24e042c 之后复跑：`collapse` 与 `shell-width` 单测 10 项通过。`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。端到端 `e2e/pre02-collapse.spec.ts` 通过；`e2e/ux-residual-batch1.spec.ts` 7 项通过（含 760 汉堡，以及 PRE-01 改过的列表入口）。变基前在 1280 量过：展开导航 240、主区 1040、叙事列 640、右栏 320；收左后导航 56、主区 1224、叙事列 824；再收右后叙事列 1104，右栏 `display:none`。刷新后两个 key 仍是 `1`。760 且两个偏好都是收起时，导航默认隐藏，抽屉打开宽 240、文字可见，跟进和状态仍在单列里，Esc 能关上。截图在 PR 描述。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。回滚：去掉收展按钮和 class 分支，恢复常显 `w-60` 与 `lg:grid-cols-[minmax(0,1fr)_320px]`。状态历史还在主列，DUX-002/003/004 未做。

### 2026-10-23 · 云端 · 需求列表默认筛我的（PRE-01）
- 分支 / PR：`fix/pre01-related-me`（草稿，不要 merge，不要标 ready）
- 做了什么：现有 `GET /orgs/:org/products/:id/requirements` 增加 `related=me`。命中负责人、提出人，或 `requirement_assignments.memberId` 为当前成员（exists，同一人多行不重复）。省略 `related` 仍是产品内可读全量。`related` 不是 `me` 返回 400 `INVALID_RELATED`；与 `owner` 或 `requester` 同时传返回 400 `RELATED_CONFLICT`。总数在服务端 OR 之后 count。列表默认「我的」，顶栏可切「看全部」，偏好只写 localStorage `flower.req.relatedScope`（`me`|`all`）。选了负责人时请求改走全部并带 `owner`，不与 `related=me` 同发。没有新接口，没有迁移，不碰 47.x。不做 PRE-02，不做切片 B。
- 怎么验证的：core `requirement-related` 与原需求列表单测 16 通过。web 筛选单测 7 通过，需求 API 单测（含 400）通过。`pnpm typecheck` 通过。`pnpm --filter @flower/web lint` 0 警告。Playwright：`requirement-related` 2 条（默认我相关、看全部、刷新记住、查看者看全部没有「新建需求」），以及需求列表、成员选择器、ux-residual-batch1 共 19 条通过。全量端到端以本 PR 的 CI 为准。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。回滚：去掉 `related` 解析与过滤，列表恢复不带默认范围。未做 PRE-02、DUX-002～010、切片 B～F。

### 2026-10-23 · 云端 · 组织壳按路由放宽宽表页
- 分支 / PR：`fix/dux-a-shell-maxw`（草稿，不要 merge，不要标 ready）
- 做了什么：只做切片 A（DUX-001、PRE-03 随壳、DUX-010 基线）。`OrgShell` 的 `main` 按 pathname 第二段选宽度：`documents` 仍是 `max-w-[1280px] mx-auto`；工作台、需求、迭代（含甘特详情）以及其余组织内路由不加 max-w，只留 `w-full`。内边距仍是 `px-4 py-6 md:px-8`，侧栏 `w-60` 和 760 汉堡未改。没有新 API、没有迁移。不碰 47.x。
- 怎么验证的：`shell-width` 单测 3 项通过。`pnpm --filter @flower/web lint` 0 警告。`pnpm --filter @flower/web typecheck` 通过。本机起开发服务后量过主区：1920 下需求列表 / 工作台 / 迭代列表 / 甘特主区宽 1680（视口减侧栏），`max-width: none`，表宽约 1614；文档列表与正文主区 1280、左右各留 200。1280 视口下内容列本就只有 1040，主区贴齐、无额外居中沟。760 需求列表页不横向溢出，标题可见，汉堡打开后 Esc 关闭。全量端到端以本 PR 的 CI 为准。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。回滚：把 `main` 恢复成统一 `max-w-[1280px] mx-auto`。未做 PRE-01/02、DUX-002～009、DUX-010 底高 polish、Q1～Q4。

### 2026-10-23 · 云端 · e2e 重置不再踢 idle 的 flower_app
- 分支 / PR：`cursor/fix-e2e-reset-deadlock-a9e4` → `main`，PR #33（草稿，不要 merge，不要标 ready）
- 做了什么：已处理同日「无条件终止其余 flower_app」过猛的问题。CI 39890767328 上 idle 连接被踢，后续请求 CONNECTION_CLOSED，e2e 挂了 8 条。现在短等仍最多 2 秒；busy 数为 0 就跳过 terminate。只有超时后仍 busy 才 `pg_terminate_backend`，过滤 `usename = 'flower_app' AND state <> 'idle' AND pid <> pg_backend_pid()`。不终止 flower_admin。40P01 仍最多 5 次。没有改 db.spec、业务表锁、迁移、compose、CI。已并入 main@a42867ea。不碰 47.x。
- 怎么验证的：`pnpm typecheck` 通过。`pnpm --filter @flower/web lint` 0 警告。idle 的 flower_app 在 reset 后仍能查询（205ms，没有被踢）。idle in transaction 的 flower_app 约 2.2 秒后 CONNECTION_CLOSED，不是 40P01；flower_admin 连接还在。`e2e/db.spec.ts` 1 条通过，Postgres 新增的死锁仍是这条故意用例。全量 e2e 以本 PR CI 为准。
- 留给对方：不要 merge，不要标 ready。合仓不等于部署，不碰 47.x。

### 2026-10-23 · 云端 · e2e 重置前只终止 flower_app 后端
- 分支 / PR：`cursor/fix-e2e-reset-deadlock-a9e4` → `main`，PR #33（草稿，不要 merge，不要标 ready）
- 做了什么：`resetDatabase` 在列出表之后、TRUNCATE 之前，最多等 2 秒让本库非 idle 的 flower_app 结束，再 `pg_terminate_backend` 终止其余 flower_app（不含本连接，不含 flower_admin）。40P01 仍最多重试 5 次。没有改业务表锁、db.spec、迁移、compose、CI。不碰 47.x。
- 怎么验证的：`pnpm typecheck` 通过。`pnpm --filter @flower/web lint` 0 警告。`e2e/db.spec.ts` 1 条通过；Postgres 只记下这一条故意死锁（TRUNCATE 为受害者，对方是 `SELECT 1 FROM "instance_settings"`）。另用 flower_app 持 AccessShare：约 2 秒后连接被关掉（CONNECTION_CLOSED），不是 40P01，flower_admin 连接还在，没有新的死锁日志。`e2e/auth.spec.ts` 3 条通过。全量 e2e 以本 PR 的 CI 为准。
- 留给对方：不要 merge，不要标 ready。独立草稿，不要叠到 #31 / #32。合仓不等于部署，不碰 47.x。

### 2026-10-23 · 云端 · push 状态「设计中」不改检查项
- 分支 / PR：`fix/import-push-status-designing`（草稿，不要 merge，不要标 ready）
- 做了什么：`PUSH_STATUS_TO_CHECK` 增加 `设计中: null`，与「已搁置」一样不写背景、可行性、行业。有评审时仍按评审结果。没有新迁移，没有改 API、suggest、apps/web，也没有改其它映射。不碰 47.x。P1–P3 的对照表改动不在本 PR。
- 怎么验证的：`pnpm typecheck` 通过。migrate 不连库的单测 12 个文件、119 通过，其中「设计中」3 条单独再跑通过。本环境没有 Docker，54329 上的库测（migrate 的 write / rejoin / perf，以及 core、web）没跑，交给 GitHub Actions。相对 `d913dc51` 没有新迁移。
- 留给对方：不要 merge，不要标 ready。不要在 47.x 上跑。H-G3「没有新迁移」的起算点是 `d913dc51`。端到端若红，对照 main@d913dc51 的已知失败再记，不要写成三绿。

### 2026-10-23 · 云端 · ux-seed:batch2 改用合法 slug，并支持只清不种
- 分支 / PR：`cursor/ux-seed-batch2-slug-clean-8447` → `main`，PR #31（草稿，不要 merge，不要标 ready）。与 P4 分开。
- 做了什么：验收组织 slug 从 `flower_uxseed` 改为 `flower-uxseed`。脚本启动时用 `packages/core/src/tenancy/orgs.ts` 的 `SLUG_RE` 做硬校验。无参时组织已存在就报错并提示 `--clean`；`--clean` 仍是清完再种；新增 `--clean-only` 只删不种，组织本就不存在时退出 0。两个开关同时出现则报错。删除仍按 slug，先卸需求标签再 `deleteOrgData`。`package.json` 的 `ux-seed:batch2` 命令没改。没有新迁移，没改 `apps/web`、compose、CI。不碰 47.x。Docker compose 项目名可以仍是 `flower_uxseed`，那不是组织 slug。
- 怎么验证的：`pnpm typecheck` 通过。另用临时 tsconfig 检查了种子脚本、flags 和单测。`scripts/ux-seed-batch2.test.ts` 7 项通过（无参 / `--clean` / `--clean-only` / 两者同传抛错，以及 slug 通过 `SLUG_RE`、旧下划线 slug 不通过）。esbuild 能打出包。打包后用假的本机连接串跑 `--clean --clean-only`，在连库前退出 1，提示不能同时使用这两个开关；连接串含 47.115.229.192 时仍拒绝；缺少 `DATABASE_ADMIN_URL` 仍报错。没有对任何库执行种子。相对 `d913dc51` 迁移目录没有差异。
- 留给对方：不要 merge，不要标 ready。不要在 47.x 上跑。U2-07b / U2-12 不在本 PR。口径里的 `/flower_uxseed/` 要改成 `/flower-uxseed/`；E-5「清后不存在」用 `--clean-only`。若验收库里已经有探针种的 `flower-uxseed`，先 `--clean-only` 再种。回滚 revert 本 PR 即可。

### 2026-10-23 · 云端 · 备份哈希只记文件名，版本闸失败提示补下一步
- 分支 / PR：`fix/h5-debt-sha256-copy`（草稿，不要 merge，不要标 ready）
- 做了什么：`backup-flower.sh` 的 `.sha256` 在输出目录里按文件名计算，发布手册的校验改成先 `cd` 再 `sha256sum -c`。版本闸和 schema 服务的失败提示改成单行「原因。下一步：…」；`--check` 失败行加 `[Flower 启动检查]`，成功行不加。鉴权失败先核对 `.env` 密码。`failLine` 仍只取第一行，退出码仍是 1。没有新迁移。`apps/web` 未改。不碰 47.x。回滚节标题在 ce3679fc 上是 `## 回滚`。
- 怎么验证的：`pnpm typecheck` 通过。`pnpm --filter @flower/web lint` 0 警告。core 111 文件、772 通过、3 跳过。migrate 15 文件、136 通过。web 50 文件、279 通过、1 跳过。smoke 依赖片段仍在源码里。把脚本产物目录挪走后 `sha256sum -c *.sha256` 两条 OK，文件名不以 `/` 开头。GitHub Actions 是否因账单没跑，写在 PR 正文。
- 留给对方：不要 merge，不要标 ready。不要在 47.x 上跑。H-G3「没有新迁移」的起算点是 `ce3679fc`，本分支相对它没有新迁移。

### 2026-10-22 · 云端 · 上线前仓库加固（H5，选 F2）
- 分支 / PR：`cursor/golive-h5-ops-1db6`（草稿，不要 merge）
- 做了什么：按简报 a–g 与文末附录做 F2。备份脚本、`--replace` 二次确认、`LEGACY_PRD_URL`、`.env.migrate` / `.env.prdsrc`、发布手册。迁移挪到一次性 `schema` 服务；flower 不再带 admin 凭据；entrypoint 只在显式给了 admin 连接串时才迁移，然后跑版本闸。版本闸按镜像 `_journal.json` 对库 `__drizzle_migrations`，不写死编号。schema / migrate 去掉 `build`，`pull_policy: never`。没有新的 SQL 迁移。不碰 47.x。
- 怎么验证的：`pnpm typecheck`、`pnpm --filter @flower/web lint`、`pnpm test` 通过。版本闸单测覆盖五类结果、flower_app 只读授权、drizzle 把连库错误包在 cause 里时仍报「连不上」。修前：容器里用 127.0.0.1 时 schema 约 4 秒退出 1，中文提示连不上。本机 iptables-legacy 的 FORWARD 默认 DROP，服务名 postgres 也会等满 10 秒连不上；只在这台机器把该策略改成 ACCEPT（不进仓库）。之后 schema 用主机名 postgres 退出 0。未迁移时 `up --wait` 把 flower 判为 unhealthy。修好连库后未再改冒烟脚本，`./scripts/smoke.sh` 退出 0。日志在 PR 描述。
- 留给对方：不要 merge，不要标 ready。合仓不等于上 47.x。H-G3 起算点是 `fdf9b4c0`，本分支相对它没有新迁移。box 上的整套闸口演练未在本环境跑完的，PR 里标了未执行。

### 2026-10-22 · 云端 · UX 残留批次 2（需求标签、工作项列表、批量状态）
- 分支 / PR：`fix/ux-residual-batch2` → `main`（草稿，不要 merge）
- 做了什么：批次 2 的 20 项。组织级「需求标签」字典（新表 `requirement_tags` / `requirement_tag_links`，迁移 `0024`，RLS，不改已有表，不复用职能标签）；详情 chip 可挂可卸，删除标签级联卸挂，确认文案「会从 N 个需求上移除」。跟进表只对工作项批量改状态，单请求、逐条鉴权、部分失败说明；需求行勾选禁用。`/work-items` 与 `/tasks` 是真列表，不 302；主导航不新增，入口是跟进「只看工作项」和工作台「我的任务」的「查看全部」。失败简报「去改」沿用现码（滚动偏移 ≥56，清掉 `section=`）。已删除文档打开时说明链接失效，不用「无权访问」。迭代列表按产品筛选且计数等于行数；甘特窄屏改成标题+状态；只读 Token 单独提示。验收种子 `pnpm ux-seed:batch2`，组织 `flower_uxseed`，拒绝 47.115.229.192。另有单独提交把批次 1 面包屑遗留补上：顶层「文档」可点回列表，最后一级只显示并带 `aria-current="page"`。
- 怎么验证的：`pnpm --filter @flower/core typecheck`、`pnpm --filter @flower/web typecheck`、`pnpm --filter @flower/migrate typecheck` 通过；`pnpm --filter @flower/web lint` 0 警告。core 110 文件、755 通过、3 跳过。web 单测 50 文件、279 通过、1 跳过。migrate 13 文件、124 通过。端到端全量 190 条：首次 187 通过、2 跳过、1 失败（主导航「需求」被设置项「需求标签」子串匹配）；`requirements.spec.ts` 改为 `exact: true` 后该条复跑通过。`e2e/ux-residual-batch2.spec.ts` 6 条通过。迁移用例「在独立库上 up → down → up」在本机 54329 的 `flower_mig_*` 上通过，没有动 3000。种子脚本没有对任何库执行（本机没有 `apps/web/.env.local`）。
- 留给对方：已处理批次 1 留下的面包屑两条。不要 merge。不要单独把本 PR 上到 47.115.229.192。与 H5 同一窗口、排在 H5 之后；先迁 schema 再启动 flower。H5 要 rebase，H-G3「没有新迁移」的基线从 `7da2c3b1` 挪到本 PR 的合并提交；H5 合入前按 0024 重算 schema-gate 期望值。回滚 SQL 在 `packages/core/migrations/0024_requirement_tags.down.sql`，不在 journal 里。不要对 flower:local、flower_h5gate 或 47.x 跑 `down -v`。

### 2026-10-22 · 云端 · UX 残留批次 1（760 抽屉与文案）
- 分支 / PR：`fix/ux-residual-batch1` → `main`（草稿，不要 merge）
- 做了什么：只做批次 1 的 26 项。760 主导航改为默认关闭的汉堡 + 遮罩抽屉（Esc、遮罩、收起、点导航后关闭），1280 及以上仍是 w-60 文字侧栏。需求列表窄屏保住标题；详情把状态操作提前；查看者看到中文锁定说明。简报列表少横滑，待定问题不再重复「建议」，下载有反馈，再生成对话框标题与按钮一致，发表/添加/关联改为描边。工作台空栏可点进现有列表。文档和任务面包屑带上类型和关联需求。跟进空筛写明条件，整页只读时说明不能写进展。设置项补中文校验、谁可邀请、状态改名风险、字段不能新建的说明、看板名称对照、初始状态含义、个人设置保存反馈、Token 须先复制且列表只留前缀。用户可见的旧「决策人（测试）/简报决策人/设为决策人」在展示时换成确认人，不改字段名、不改历史迁移。没有新业务 API，没有 SQL 迁移，没有改 compose / .env / entrypoint / smoke / 镜像。不碰服务器 47.115.229.192。批次 2（标签、批量状态、/work-items 与 /tasks 列表）未做。
- 怎么验证的：`pnpm typecheck` 通过；`pnpm --filter @flower/web lint` 0 警告。相关单测 58 项通过。端到端 `e2e/ux-residual-batch1.spec.ts` 7 条通过（抽屉 A1–A7、需求标题、查看者说明、setup 与邀请退出、空筛、组织名与邀请文案、工作台空栏）。回归：跟进窄屏与设置、组织/个人设置、Agent Token、简报主流程与 760、需求、成员、通知偏好、流程、字段。
- 留给对方：不要 merge。不要碰服务器 47.115.229.192。不要把本批扩成批次 2 或 P3-C3。字典清洗只在展示层，没有修生产数据。

### 2026-10-20 · 云端 · 文档废弃确认与列表加载失败态（UX gap P0+中）
- 分支 / PR：`fix/ux-gap-p0-mid` → `main`（草稿，不要 merge）
- 做了什么：文档「改为已废弃」先走共享确认框，文案写明不能恢复，焦点在取消，取消不改状态。组织壳、概览、产品/成员/需求等列表在慢网时显示骨架和「加载中」，接口失败（含 500）显示中文错误和重试，不再把失败当成空表。禁用的主按钮旁写明原因。需求状态只把当前之后最近的允许目标做成实心主按钮，其余描边；不允许或只读时禁用并说明。工作项详情和跟进列表渲染已有的 `expectedDate`，空值写「未设置」，未完成且早于今天用琥珀色「已逾期」。没有新业务 API，没有 SQL 迁移，没有改 `decider*`。不碰服务器 47.115.229.192。
- 怎么验证的：`pnpm --filter @flower/web typecheck` 通过；web lint 0 警告。预计日与状态主按钮单测 10 项通过。`e2e/ux-gap-p0-mid.spec.ts` 5 条通过（废弃只走取消、产品列表加载中与 500、状态主次、查看者禁用理由、W 预计日逾期与未设置）。回归 29 条通过：跟进窄屏与设置确认、需求、工作项、错误态、产品、PRD 流转、简报（含 760「打开当前 PRD」）。1280 与 760 截了需求状态和工作项详情，760 另截了跟进窄列表。
- 留给对方：合仓不等于上 47.x。不要 merge。不要碰服务器 47.115.229.192。不要真废弃共享环境里的验收文档。

### 2026-10-20 · 云端 · 跟进窄屏与组织设置无权、确认（UX 批次 E+F）
- 分支 / PR：`fix/ux-follow-settings` → `main`，PR #25（草稿，不要 merge）
- 做了什么：760 下跟进「全部在手 / 任务老化」改成卡片，阶段徽章完整可见，「写进展」在每条右侧，不用横滑；更宽时表格把「写进展」钉在右侧。按阶段看板在窄屏改为上下排列。工作项详情只加一句说明，没有需求外键，也没有关联控件。最终句子：「工作项不关联需求；请从需求详情看关联」。无权限用户仍然不显示「组织设置」；`/settings`、未知子路径、成员/组织信息等直链，以及没有产品管理员身份时的产品设置，都显示同一句「无权访问，请联系组织管理员」，不再落到英文 404。760 下设置侧栏里的「组织设置」默认收起，页内顶栏横向切换子页；说明保持横排。成员改为「已离开」、产品归档/取消归档都先弹出确认，焦点在取消。没有新业务 API，没有 SQL 迁移。不碰服务器 47.115.229.192。
- 怎么验证的：`pnpm typecheck` 通过；`pnpm --filter @flower/web lint` 0 警告。导航单测 3 项通过。端到端 `e2e/ux-follow-settings.spec.ts` 6 条通过（含 760 阶段与写进展在视口内可点、无权句、顶栏切换、离开与归档的取消路径）。相关回归 46 条通过（跟进、工作项、登录与设置入口、布局、成员、产品、产品管理员、结构树、文档权限、组织设置、企业微信设置、看板、错误态、流程、字段、推送规则；其中看板图片一条按原用例跳过）。F3/F4 只走取消，没有把成员设为已离开，也没有归档产品。1280 与 760 截了跟进和设置页。
- 留给对方：已处理 2026-10-20「本批合完后再开 E+F」的待办。不要给工作项加需求外键。不要 merge。不要碰服务器 47.115.229.192。

### 2026-10-20 · 云端 · 简报端到端不再撞 60 秒整测超时
- 分支 / PR：`fix/ux-req-brief` → `main`，PR #24（仍是草稿）
- 做了什么：`e2e/briefs.spec.ts` 第一条主流程加 `test.setTimeout(120_000)`。760 长标题换行、与「已关注」不重叠、只保留一个「打开当前 PRD」拆成独立用例，用接口建简报并转 PRD，不再挂在主流程末尾。未改关注按钮，未改登录。不碰服务器 47.115.229.192。
- 怎么验证的：对照 CI run 39363069924，超时在第 196 行，关注按钮 locator 已解析。本地 `pnpm exec playwright test e2e/briefs.spec.ts`（在 `apps/web`）4 条通过：主流程 23.6s，拆出的 760 用例 2.6s。
- 留给对方：工作台 `workbench.spec.ts` 登录后仍停在 `/login` 当作环境抖动，本轮没改。不要 merge。不要碰服务器 47.115.229.192。

### 2026-10-20 · 云端 · 简报模板迁移测试不再绑当前常量（CI）
- 分支 / PR：`fix/ux-req-brief` → `main`，PR #24（仍是草稿）
- 做了什么：`p3c2-schema` 里 0022/0023 的断言改为对照迁移文件自己的快照（0023 的 `$new$` 说明，以及文件里的 replace）。不再要求库内文案等于当前 `BRIEF_TEMPLATE`。另加一条：`insertPresetBriefTemplate` 写入的正文、说明、小节与当前常量一致。没有新 migration，没有改 `.sql`。已存模板不回写。不碰服务器 47.115.229.192。
- 怎么验证的：`pnpm --filter @flower/core exec vitest run test/p3c2-schema.test.ts test/brief-templates.test.ts`，2 个文件 9 项通过。
- 留给对方：本批合完后再开 E+F。不要加 0024 去回写已存模板。不要碰服务器 47.115.229.192。

### 2026-10-20 · 云端 · 需求详情与简报的主次动作和折叠（UX 批次 C+D）
- 分支 / PR：`fix/ux-req-brief` → `main`
- 做了什么：需求简报卡在已生成 PRD 时主按钮是「已生成 · 打开」，旁边是「检查记录 a/b」，去掉「还差 N」。流转按钮只渲染 `transitions`，不允许的禁用并在悬停时显示 unmet，原来的条件列表和「强制流转」还在。关注点下去立刻变。需求列表筛空可以「清除筛选」。简报未填的二级节默认收起，顶栏写「还有 N 节未填 · 展开全部」；写了理由的「不适用」保持展开，节头芯片与页头都用「不适用」（解析仍认「不涉及」）。侧栏标签改为「对外版本」，简报修订写成「修订记录 · 第 N 次」（PRD 仍是「版」）。窄于 md 时标题换行，关注按钮排到标题下面。xl 以下只保留标题下那一个实心主按钮。用户可见的「闸口」在界面和预置模板里已经是「写 PRD 前检查」，没有改字段名，也没有新迁移。需求详情多返回简报已转出的 PRD，文档详情多返回简报模板正文，都在原来的 GET 上，没有新 path，没有 SQL。未做 C2，未改 `decider*`，未改遮罩。不碰服务器 47.115.229.192。
- 怎么验证的：`pnpm typecheck` 通过；web lint 0 警告。core 简报相关 25 项、web 模型与简报接口 36 项通过。`e2e/briefs.spec.ts` 3 条、`e2e/requirements.spec.ts`（含清除筛选和 unmet 悬停）、`e2e/member-notifications.spec.ts` 的关注按钮、`e2e/documents-revisions.spec.ts` 通过。1280 与 760 截了需求详情和简报页。
- 留给对方：本批合完后再开 E+F（`fix/ux-follow-settings`）。已经保存的预置模板说明不会回写；新组织用现在的模板文案。不要碰服务器 47.115.229.192。

### 2026-10-20 · 云端 · 铃铛遮罩改挂到 body 并写死页底色（B4）
- 分支 / PR：`fix/ux-notify-copy` → `main`，PR #23
- 做了什么：遮罩的 `createPortal` 挪到 `Popover` 外面，挂到 `document.body`。仍是不透明 `bg-background`，并内联 `backgroundColor: var(--background)`，避免类名没铺上色时时间戳透出来。没有改成半透明黑。浮层仍是 `z-60` / `bg-popover`，点遮罩关闭。不碰服务器 47.115.229.192。
- 怎么验证的：`pnpm typecheck` 通过；web lint 0 警告。`e2e/member-notifications.spec.ts` 4 条通过。遮罩是 `body` 的子节点，铺满视口，背景不透明且低于浮层；通知页时间戳中心要么点在遮罩上，要么点在浮层上。1280 与 760 截图里列表区是页底色，背后的「…前」不可见。
- 留给对方：不要把遮罩改成半透明。已经发出的通知正文仍不回写。不要碰服务器 47.115.229.192。

### 2026-10-20 · 云端 · 铃铛打开时遮住背后通知时间戳（B4）
- 分支 / PR：`fix/ux-notify-copy` → `main`，PR #23
- 做了什么：闸口 4 挡合。380px 浮层右缘盖不住通知页右侧的「13 小时前」。铃铛打开时在 `document.body` 加不透明 `fixed inset-0` 遮罩（`z-55`、`bg-background`），浮层仍是 `z-60` / `bg-popover`。点遮罩关闭。没有加宽浮层。B1/B2/B3/B6 未改。没有新 API，没有 SQL 迁移，不改 `decider*`。不碰服务器 47.115.229.192。
- 怎么验证的：`pnpm typecheck` 通过；`pnpm --filter @flower/web lint` 0 警告。`e2e/member-notifications.spec.ts` 4 条通过。打开铃铛后，通知页上每个时间戳的中心点 `elementFromPoint` 都落在遮罩或浮层上，遮罩背景不透明且层级低于浮层。1280 与 760 截图里背后列表的时间戳不可见。
- 留给对方：已经发出的通知正文仍不回写。无未读时没有角标。测试人名里仍有「决策人」。铃铛仍按今天 / 更早分组。不要碰服务器 47.115.229.192。

### 2026-10-20 · 云端 · 通知中心分区与确认人文案（UX 批次 B）
- 分支 / PR：`fix/ux-notify-copy` → `main`，PR #23
- 做了什么：通知中心按现有 `kind` 分成「要你做的事」（被 @、被指派、等你签字）和「全部动态」，行动项在前；没有条目的分区不出现。设为确认人的通知改为「请看问题是否说清、规则是否可执行」。铃铛正文把「已生成 PRD」这类中英短语保持在同一行，未读角标加大并加描边，浮层提高层级并盖住背后列表。用户可见面本来已是「确认人」，只改了一处注释；`decider*` 字段名未动。没有新 API，没有 SQL 迁移。不碰服务器 47.115.229.192。
- 怎么验证的：`pnpm typecheck` 通过；`pnpm --filter @flower/web lint` 0 警告；简报通知 3 项、通知前端模型 9 项通过。`e2e/member-notifications.spec.ts` 4 条通过（含 1280 / 760 铃铛：短语单行、角标可点中、浮层盖住背后时间戳，以及通知中心分区）。
- 留给对方：已经发出的通知正文不会改写。分区只处理已经加载的页，更早的行动项要点「加载更多」后才会进「要你做的事」。历史文档、迁移 0022 和测试人名里仍有「决策人」。不要碰服务器 47.115.229.192。不要开始 C+D。

### 2026-10-20 · 云端 · 需求详情列出挂过的变更 PRD（C2）
- 分支 / PR：`fix/ux-c2-change-documents` → `main`，PR #22
- 做了什么：需求详情增加只读 `changeDocuments[]`。从本需求的 `requirement.updated`（`changes[].field === changeDocumentId`）重建挂过的变更 PRD，并并上当前外键。当前项置顶，其余按最近一次挂上的时间从新到旧；已删除的文档略去。`changeDocument` / `changeDocumentId` 的挂载语义不变。PRD 卡片列出这些文档，历史项也可以点开。没有加产品级变更 PRD 列表链接，没有 SQL 迁移。不碰服务器 47.115.229.192。
- 怎么验证的：`pnpm typecheck` 通过；`pnpm --filter @flower/web lint` 0 警告；`packages/core/test/change-documents.test.ts` 12 项通过（含从未挂、只挂一份、挂 A 卸 A 再挂 B、仅有当前外键无事件，以及已删除文档略去、简报不混入）。`e2e/documents-prd-flow.spec.ts` 3 条通过，其中多份历史在 1280 与 760 下都可见，检查项仍跟随当前 PRD，页面不横向溢出。
- 留给对方：没有挂载事件时列表只有当前这一份，不能当作完整历史（迁移直接写外键即是这种情况）。已删除文档直接略去，不标 unavailable。不要碰服务器 47.115.229.192。

### 2026-10-20 · 云端 · 工作台等我确认与窄屏 P0
- 分支 / PR：`fix/ux-p0`
- 做了什么：变更 PRD 列表沿用简报页签的表级 `min-w` 和标题列 `min-w`，760 下标题列不再被挤没。`GET /me/workbench` 增加 `confirmations`（确认人是当前成员，状态为讨论中或可以写 PRD；已转 PRD、已废弃不计入）。工作台增加「等我确认」，并把工作台里的「签字」改成「确认」。概览产品卡窄屏单列并允许换行，1280 仍是三列。开放注册和允许用户自建组织先弹出确认，取消不保存，仍走原来的 `PATCH /instance/settings`。未做 C2，未碰 47.x。
- 怎么验证的：`pnpm typecheck`；`pnpm --filter @flower/web lint` 0 警告；core 工作台 9 项、web 工作台单测与接口 8 项通过。端到端 20 条通过，含 760 与 1280 的变更 PRD 标题列、概览不叠字且 1280 三列、工作台待确认简报、实例开关取消路径，以及简报 760 标题和「写 PRD 前检查」。
- 留给对方：C2 的 `changeDocuments` 另开分支。不要碰服务器 47.115.229.192。

### 2026-10-19 · 云端 · 简报 UX 与文案（P3-C2 小单）
- 分支 / PR：`feat/p3c2-ux-copy` → `main`
- 做了什么：按定稿小单改简报路径。760 下列表标题列不再被挤没；用户可见文案去掉「闸口」，检查进度写「还差 N 项」和「系统 / 人工」；未勾完也可以生成 PRD。已生成后主按钮是「打开当前 PRD」，再生成写明已关联需求不会挂到新草稿。决策人改为确认人，进页有任务条，通知写明要确认什么，第 16 节关键列收进内容区。窄屏把状态、检查进度和主操作放在标题下。空筛可清除；「去改」高亮目标节并清掉定位参数；编辑器提示「不涉及：理由」。预置模板用迁移 0023 对齐，不改已发出的简报正文。未做 P3-C3，未碰 47.x。变更 PRD 列表的同类挤列未改。
- 怎么验证的：`pnpm typecheck`；`pnpm --filter @flower/web lint` 0 警告；core 简报相关 42 项、web 简报 29 项通过；`e2e/briefs.spec.ts` 3 条通过。
- 留给对方：侧栏只链最新一份已生成 PRD，更早的草稿仍从「被引用」进。不要开始 P3-C3。不要碰服务器 47.115.229.192。

### 2026-10-19 · 云端 · 交接：P3-C2 已合并
- 分支 / PR：`main`（PR #19，merge commit `4eee7a43982c2aa649d56f8689beaaebe0f7d8f2`）
- 做了什么：更新 `docs/handoff.md`。P3-C2 标为已合并；原「CI 绿后再合并」从下一步删去。下一步首条改为 P3-C3 周期汇总（设计待确认，分支拟 `feat/p3c3-period-summary`，确认前不写码；不碰服务器 47.115.229.192）。已处理 2026-10-19「CI 绿之前不要合并 / 不要自行合并」的待办。
- 怎么验证的：只改文档，未改业务代码。
- 留给对方：P3-C3 设计确认前不写码。不碰服务器 47.115.229.192。

### 2026-10-19 · 云端 · 合前修简报软闸口提示与 760 宽表
- 分支 / PR：`feat/p3c2-requirement-brief` → `main`，PR #19（不另开 PR，不合并）
- 做了什么：写 PRD 闸口「只作提示，不限制改状态与转 PRD。」改为琥珀色提示条（Info 图标、浅底描边），行为仍不拦改状态与转 PRD。正文宽表（简报第 10 节一类 5 列表）只在表格容器内横向滚动，编辑器链路允许收缩，760 下整页不再被撑出视口。端到端补上：等第 10 节宽表画出后再测 `expectNoPageOverflow`，并核对简报页签、需求详情、模板设置。
- 怎么验证的：`pnpm typecheck` 通过；`pnpm --filter @flower/web lint` 0 警告；`e2e/briefs.spec.ts` 3 条通过（含 760 下第 10 节宽表画出后的 `expectNoPageOverflow`，以及简报页签、需求详情、模板设置）。上次 CI 的端到端在 30 分钟时限内仍在跑就被取消（日志末尾还在打开编辑器，Postgres 死锁已被既有重试处理），本次把该作业时限调到 60 分钟。
- 留给对方：CI（含端到端）绿之前不要合并。不要开始 P3-C3。

### 2026-10-19 · 云端 · 审查 P3-C2 并开 PR
- 分支 / PR：`feat/p3c2-requirement-brief` → `main`，PR #19
- 做了什么：对照设计与计划审查租户隔离、RLS、权限、与 `main` 的差异。`document_briefs` 带 `org_id` 且策略与既有租户表一致；简报读写都在 `withOrg` 里，列表按可见产品过滤，看不到的简报按不存在处理；只读成员与只读 Token 不能改头部、勾选闸口或转 PRD。与 `origin/main` 无落后提交。补了一处：文档详情「覆盖的需求」混入无法识别的编号时，与新建简报一样直接报错，不再静默丢掉。
- 怎么验证的：`pnpm typecheck` 通过；`pnpm --filter @flower/web lint --max-warnings 0` 0 警告；`pnpm test`：core 735、web 261、migrate 124，全部通过。端到端与镜像冒烟沿用 `docs/p3c2-validation.md` 的记录（159 通过、1 跳过；`./scripts/smoke.sh` 通过），本次未重跑。
- 留给对方：已知限制与人工验收仍见 `docs/p3c2-validation.md` 第 5、7 节。不要自行合并。不要开始 P3-C3。

### 2026-10-16 · 本地 · P3-C2 需求简报
- 分支 / PR：`feat/p3c2-requirement-brief`
- 做了什么：
  - 数据模型：`documents.kind` 加 `brief`，简报四个状态；`products.brief_seq` 与按类型拆开的编号唯一索引；新表 `document_briefs`（RLS）；`requirements.brief_document_id`；`document_templates.guidance`；迁移 0021（结构）与 0022（RLS、两个组织补齐预置简报模板）。
  - core：预置简报模板与闸口、转 PRD 对应表（`brief-template.ts`）；闸口判定、转 PRD 拼接、上下文 Markdown（`brief-model.ts`）；新建、头部、覆盖需求、闸口、列表、转 PRD、上下文（`briefs.ts`、`coverage.ts`）；文档系统按类型区分编号、详情、流转、链接卡与被引用；PRD 专用入口（检查项、签字、影响声明、合入、负责人）拒绝简报；简报改状态不触发群推送；决策人「被指派」通知；需求详情带所挂简报；工作台与通知文案按类型生成编号。
  - 接口 `/orgs/:org/briefs`（列表、头部、闸口、转 PRD、上下文）、`/products/:id/briefs`、模板接口的 `kind`。
  - 页面：文档页「简报」页签与新建、简报详情（模板说明、头部信息、覆盖的需求、写 PRD 闸口、转 PRD、复制与下载 Markdown）、PRD 显示来源简报、需求详情「简报」区块、模板设置切换简报模板。
  - perf 命令加两个简报用例。
- 怎么验证的：`pnpm test`：core 735、web 261、migrate 124，全部通过；typecheck 通过；web lint 0 警告；全量 e2e 159 通过、1 跳过；`./scripts/smoke.sh` 通过。开发库迁移核对与预期一致（RLS、两个组织的预置简报模板、编号索引、需求 766 与文档 203 不变）；pan123 上写一份测试简报并转 PRD 的复验通过（含编辑器重排格式后的闸口判定）；简报列表 p95 4.2 毫秒、上下文 5.6 毫秒。详见 `docs/p3c2-validation.md`。
- 留给对方：已知限制见 `docs/p3c2-validation.md` 第 5 节；下一步 P3-C3 周期汇总，之后规划原型评审增值模块。

### 2026-10-14 · 本地 · P3-C1 工作跟进
- 分支 / PR：`feat/p3c1-tracking`
- 做了什么：
  - 数据模型：`requirements` 加跟进五列，新表 `work_items`、`progress_updates`（RLS），`blockers` 可挂工作项，`organizations.work_item_seq`；迁移 0019（结构）与 0020（RLS、回填 tracked_since、补齐内置字段「类型」「工作类型」）；`field_definitions.applies_to` 开始生效。
  - core `src/tracking/`：停留与老化纯函数、工作项权限、需求跟进设置与自动加入、工作项、进展记录、跟进列表与阈值；通知（工作项指派与 @、跟进人、关注者）、工作项关注、组织级 @ 候选成员；工作台两个区块。
  - 接口 `/orgs/:org/tracking`、`/tracking-settings`、需求跟进与进展、`/work-items`、`/progress`、`/mention-members`。
  - 页面：主导航「跟进」（四个页签、筛选、写进展、新建工作项）、工作项详情、需求详情跟进区块与进展记录页签、工作台、组织设置「跟进」；阻塞项区块抽为共享组件。
  - perf 命令加四个跟进用例。
- 怎么验证的：`pnpm test`：core 688、web 250、migrate 124，全部通过；typecheck 通过；web lint 0 警告；全量 e2e 156 通过、1 跳过；`./scripts/smoke.sh` 通过。开发库迁移核对（RLS、回填 81、需求数 766 不变、内置字段、约束）与预期一致；跟进列表 p95 约 12 毫秒、工作台 29.5 毫秒；pan123 上两个账号复验（写进展与跟进人通知、暂停与恢复、工作项全流程、四个页签、阈值，1440 / 760）通过，详见 `docs/p3c1-validation.md`。
- 留给对方：旧「进展」评论未转换、历史需求没有加入跟进时间、「类型」待补填（见 `docs/p3c1-validation.md` 第 5 节）；下一步 P3-C2 周期汇总；待规划原型评审增值模块。

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
