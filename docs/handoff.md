# Flower 交接文档

更新：2026-09-29。新会话接手时先读这份，再读下面列出的 spec 和计划。最近谁做了什么，看 `docs/agent-log.md`。

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
| `docs/superpowers/plans/2026-09-29-flower-p0b-admin-ui.md` | **P0-B 管理界面计划（下一步执行）** |
| `docs/story-map/flower-story-map.html` | 用户故事地图（在线版：https://claude.ai/artifact/TsrYHNpBZ2TLc6uq6suadu） |
| 视觉样稿 | https://claude.ai/artifact/DgxTagCVRUGsKbvZSm9XPL （最上面一行"定稿"：A 配色 + C 密度） |
| `docs/diagrams/` | 服务器现状图、目标架构草案 |
| `CLAUDE.md` | 项目命令与约定 |
| `docs/agent-log.md` | 本地 agent 与云端 agent 的协作日志（每次完成工作后追加） |

## 当前进度

- **P0-A 后端基础：已完成并合并**（PR #1，merge commit `01819f6`）。core 100 个测试、web 21 个测试、类型检查、docker 冒烟测试全部通过。
- **P0-B 管理界面：计划已写好，尚未开始执行**。`main` 最新提交 `b37580e`。

## 下一步

1. 从 `main` 拉分支 `feat/p0b-admin-ui`。
2. 用 superpowers:subagent-driven-development 执行 P0-B 计划（16 个任务）。用户选择的方式是：每个任务一个子 agent，任务后审查，最后全分支审查。
3. 完成后按 `docs/p0-demo.md`（P0-B 任务 16 产出）给用户做界面验收演示，再决定合并方式。

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
