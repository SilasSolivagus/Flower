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
