# Flower 交接文档

更新：2026-09-30。新会话接手时先读这份，再读下面列出的 spec 和计划。最近谁做了什么，看 `docs/agent-log.md`。

## 项目是什么

Flower：多组织、多产品的产品研发管理平台，最终以 docker 形式供他人自托管。合并三个现有项目：

- 123plane（需求，dirctable.com）
- push（版本管理 + 企微推送，push.dirctable.com）
- prd（PRD，prd.dirctable.com）

第一个租户是 123云盘。开发只在本地进行，用 GitHub（私有仓库 SilasSolivagus/Flower）管理版本，**不动服务器 47.115.229.192**。

## 关键文档

| 文档 | 内容 |
|---|---|
| `docs/superpowers/specs/2026-09-28-flower-data-model-design.md` | 数据模型 spec（已逐段确认），含旧数据迁移映射和分阶段 P0–P6 |
| `docs/superpowers/plans/2026-09-28-flower-p0a-backend.md` | P0-A 后端计划（已完成） |
| `docs/superpowers/plans/2026-09-29-flower-p0b-admin-ui.md` | P0-B 管理界面计划（已完成） |
| `docs/superpowers/plans/2026-09-29-flower-p1a-requirements-migration.md` | P1-A 计划：需求数据模型、旧数据迁移、需求列表与详情（已完成） |
| `docs/p1a-validation.md` | P1-A 真实数据验证记录（迁移对账汇总、性能测量） |
| `docs/superpowers/plans/2026-09-30-flower-p1b1-iterations.md` | P1-B1 计划：迭代、发布版本、阻塞项与关联、结构树维护、产品管理员缺口（已完成） |
| `docs/superpowers/plans/2026-09-30-flower-p1b2-gantt-workbench.md` | P1-B2 计划：任务与甘特、人员负载、批量评审表、工作台、需求分配、统一错误状态（已完成） |
| `docs/p1b-comparison.md` | P1-B 日常操作新旧对比（8 项操作的步数与结论） |
| `docs/p1b-validation.md` | P1-B 真实数据验证记录与人工验收清单 |
| `docs/story-map/flower-story-map.html` | 用户故事地图（在线版：https://claude.ai/artifact/TsrYHNpBZ2TLc6uq6suadu） |
| 视觉样稿 | https://claude.ai/artifact/DgxTagCVRUGsKbvZSm9XPL （最上面一行"定稿"：A 配色 + C 密度） |
| `docs/diagrams/` | 服务器现状图、目标架构草案 |
| `CLAUDE.md` | 项目命令与约定 |
| `docs/agent-log.md` | 本地 agent 与云端 agent 的协作日志（每次完成工作后追加） |

## 当前进度

- **P0-A 后端基础：已完成并合并**（PR #1）。
- **P0-B 管理界面：已完成并合并**（PR #2，merge commit `cf39a1c`）。
- **P1-A 需求数据模型、旧数据迁移、需求列表与详情：已完成，已合并（PR #4）**（分支 `feat/p1a-requirements`）。
  - 迁移工具 `packages/migrate` 读三份生产只读副本，经可编辑的对照表生成导入计划和对账报告。
  - 真实数据已导入本地开发库，组织 pan123，共 764 条需求，对账 0 问题。
  - 性能：9 个场景 p95 均在 10ms 以内。
- **P1-B1 迭代、发布版本、阻塞项与关联、结构树维护：已完成，已合并（PR #6）**。
  - 迭代列表与详情（状态、里程碑、需求、承诺范围对比、发布版本），需求按流程准入条件加入迭代，产品管理员可强制。
  - 字段按产品覆盖时，发布版本与开发分配上的平台选项一并迁移（P1-A 遗留项已处理）。
  - 人工验收清单见 `docs/p1b-validation.md` 第 3 节，待用户执行。
- **P1-B2 甘特、人员负载、评审表与工作台：已完成**（分支见协作日志）。
  - 任务增删改与重点（每个迭代最多 10 个），push 的工作日进度算法与迭代概览，甘特页签（行内编辑、时间轴、团队负载热力图），跨迭代的人员负载页。
  - 按流程检查项生成的批量评审表（统计、筛选、展开签字与代签），登录后默认进入的跨组织工作台，概览页移到 `/[org]/overview`。
  - 需求详情可以新增、删除分配；「等我签字」按分配推给对应的人，没有分配时推给该职能标签的全部成员。
  - 统一的加载失败状态与网络错误中文提示（P0-B 暂缓项已处理）。
  - pan123 已按新的甘特任务映射重导；人工验收清单与用户试用脚本见 `docs/p1b-validation.md`「P1-B2」一节，待用户执行。

## 下一步

1. 用户按 `docs/p1b-validation.md`「P1-B2」第 3、4 节在本地 pan123 上验收并试用，问题与阻力记在对应位置。
2. 根据试用结果决定是否调整甘特与发布版本的入口（`docs/p1b-comparison.md` 第 5、6、8 项比旧系统多 3 步）。
3. 进入 P2（文档）之前，确认 P1-B2 计划「设计决定」表「留给后续阶段」一行里哪些要提前。

## 生产数据副本

`.local-data/` 只在本地，不提交，内容包括：
- 123plane.db、push.db、prd.dump；
- 对照表 `mapping/`；
- 对账报告 `reports/`。

这些文件含员工个人信息。导入命令见 `CLAUDE.md`，本次导入使用的是 `--as-of 2026-09-29`。

## 已确认的决定（要点）

- 需求状态可配置：状态 + 流转 + 流转条件；组织模板，产品可覆盖；流程定义带版本。
- 多条状态线 = 一条主状态流 + 可配置检查项（作用范围：需求 / PRD）。
- 迭代分常规（属于产品，不重叠）和专项（属于组织）；发布版本可选；子任务与甘特任务合并为 `tasks`。
- 成员可以没有账号；Agent 是一种成员；权限为固定角色两级（组织 / 产品），职能标签与权限分开。资源级规则（如"只能改自己创建的 PRD"）在各模块设计时再定。
- PRD 两类：变更 PRD（覆盖多条需求）与模块文档（按功能点分节，变更上线后合入）。
- 产品结构树按产品各建一棵（业务域 → 模块 → 功能点），层级叫法可配置。
- 通知：一个通道对应一个 webhook，按群归组；通知规则由产品管理员在本产品内配置。先接测试群联调，正式环境替换稍后。
- 内置 AI 需要组织级 key，未配置时系统照常可用；外部 Agent 走 MCP，不需要 Flower 的 key。启用 AI 后界面要有明显区分（非功能性需求，以后再做）。
- 外部 PRD 链接（企微文档）不迁移；旧数据其余部分全部迁移（P1）。
- 前端：Next.js + Tailwind + shadcn/ui，默认浅色；流程图用 React Flow；表单用受控组件；字体用 @fontsource。
- 保留的组织标识：api、admin、settings、setup、login、register、invite。
- 甘特进度沿用 push 的工作日算法；任务标记只有「关注」一种，手动进度存 `tasks.meta.progress`；迭代概览按需求聚合，不写死 123云盘 的排除标题。
- 工作台在 `/[org]`，内容跨组织；概览页在 `/[org]/overview`。评审表的「等我签字」只统计评审已开始的需求，并按需求分配推给对应的人。

## 暂缓项（已排进计划或待定）

- 已在 P0-B 计划中：成员离开时清理产品角色并吊销 Token、登录限流、过期会话清理、修改密码放进同一事务。
- 仍待定：生产环境是否强制 `FLOWER_PUBLIC_URL`；实例级操作的审计记录（`domain_events.org_id` 不能为空）；迁移改为一次性 compose 服务；邀请绑定占位成员时，接受者已有"离开"记录的处理方式。

## 注意事项

- 跑 `pnpm test` 会把集群级数据库账号 `flower_app` 的密码改为 `flower_app_test`；之后 `pnpm dev` 前先执行 `pnpm db:migrate`。
- 端到端测试（P0-B 引入）占用 3100 端口，不要和 `pnpm dev` 同时运行；首次需要 `pnpm --filter @flower/web exec playwright install chromium`。
- docker 镜像首次构建很慢（依赖下载），冒烟测试应放在后台运行并看日志。
- 本机 `~/.docker/config.json` 会给容器注入 HTTP 代理；`docker-compose.yml` 的健康检查已只在探活命令里清空代理，不要改成整个容器禁用代理。
- 子 agent 执行计划时，审查中多次发现计划代码本身的缺陷（时序侧信道、越权、审计缺失），审查环节不要省。
- 与用户沟通用中文，工程语气；每完成一个任务称呼用户"爸爸"。
