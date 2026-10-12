# Flower

多组织、多产品的产品研发管理平台。设计文档：`docs/superpowers/specs/2026-09-28-flower-data-model-design.md`。

## 协作

本地开发 agent 和云端 agent（GitHub 直连）共用 `docs/agent-log.md`：开工前读最上面几条，完成一项工作后在最上面追加一条，与代码放在同一个提交或 PR 里。格式见该文件开头。

PR 会跑 GitHub Actions CI（`.github/workflows/ci.yml`）：类型检查 + web lint + 单元测试、端到端测试、镜像冒烟测试。

## 命令

| 用途 | 命令 |
|---|---|
| 启动开发数据库（端口 54329） | `pnpm db:up` |
| 执行迁移（读 apps/web/.env.local） | `pnpm db:migrate` |
| 开发服务器 | `pnpm dev` |
| 全部测试（需要先 db:up） | `pnpm test` |
| 类型检查 | `pnpm typecheck` |
| web lint（CI 会跑，需零错误零警告） | `pnpm --filter @flower/web lint` |
| 修改 schema 后生成迁移 | `pnpm --filter @flower/core db:generate` |
| 镜像冒烟测试 | `./scripts/smoke.sh` |
| 下载看板图片字体（存到已忽略的 packages/core/assets/fonts/） | `./scripts/fetch-fonts.sh` |
| 端到端测试（需要 db:up；会占用 3100 端口，不要与 pnpm dev 同时运行） | `pnpm --filter @flower/web e2e` |
| 生成旧数据对照表（只读副本放在 .local-data/） | `pnpm --filter @flower/migrate legacy suggest --plane "$PWD/.local-data/123plane.db" --push "$PWD/.local-data/push.db" --prd-url postgres://flower_admin:flower_admin@localhost:54329/prd_src --mapping "$PWD/.local-data/mapping"` |
| 迁移旧数据（先加 --dry-run 看对账报告；--as-of 决定迭代与任务状态，重导沿用 docs/p1a-validation.md 记录的日期） | `pnpm --filter @flower/migrate legacy import …同上参数… --out "$PWD/.local-data/reports" --owner-email <你的账号邮箱> --uploads "$PWD/.local-data/prd_uploads" --storage "$PWD/apps/web/.flower-storage" --as-of YYYY-MM-DD [--replace] [--dry-run]` |
| 重导后让测试账号重新加入组织（清单 `.local-data/test-accounts.json`：`[{"email","orgRole","functionTags"}]`，不含密码） | `pnpm --filter @flower/migrate legacy rejoin --org-slug pan123 --owner-email <你的账号邮箱> --accounts "$PWD/.local-data/test-accounts.json"` |
| 真实数据性能测量（需先导入 pan123） | `pnpm --filter @flower/migrate build && node --disable-warning=ExperimentalWarning --env-file=apps/web/.env.local packages/migrate/dist/cli.mjs perf --org-slug pan123 --owner-email <邮箱>` |

首次开发：`cp .env.example apps/web/.env.local`，填入 `FLOWER_SECRET_KEY`（`openssl rand -base64 48`）。PRD 图片附件默认存在 apps/web/.flower-storage/（已忽略），可用 FLOWER_STORAGE_DIR 改到别处；迁移导入时用 --storage 指向同一个目录。

`pnpm test` 会把集群里 `flower_app` 角色的密码改成测试固定值 `flower_app_test`；测试跑完后、`pnpm dev` 之前先执行一次 `pnpm db:migrate` 把密码改回 `apps/web/.env.local` 里配置的值。

首次跑端到端测试前执行一次 `pnpm --filter @flower/web exec playwright install chromium`。`apps/web/e2e/db.ts` 里 `createDatabase()` 只在 `global-setup.ts` 跑一次，建库并迁移到 `flower_e2e`；每个 spec 在 `beforeEach`/用例开头调用的 `resetDatabase()` 只是 TRUNCATE 所有业务表，不会重建数据库或重跑迁移。

## 约定

- 业务逻辑只写在 `packages/core`，服务函数签名为 `(db, actor, input)`；`apps/web/src/server/routes` 只做参数校验和调用。
- 租户数据一律在 `withOrg(db, actor.orgId, ...)` 中读写；`withSystem` 只用于登录、成员关系查找、Token 认证、邀请接受，以及推送后台循环查出有待办的组织 id（之后的读写仍在 `withOrg` 中）。
- 新增租户表必须带 `org_id`，并在一个新的自定义迁移里为它开启 RLS（参照 `0002_rls.sql`）。
- 每个写操作在同一事务内调用 `recordEvent`。后台与系统写入不记事件：预置模板补齐、定时推送的到点执行、发送记录的状态更新。
- 服务函数一律声明为 `async`，保证权限校验失败以 Promise 拒绝的形式返回。
- 面向用户的错误信息用中文，通过 `AppError(code, message, details?)` 抛出。
- 页面是客户端组件，通过 `/api/v1` 取数；只允许 `import type` 引用 `@flower/core`，以及浏览器安全的 `@flower/core/workflow-schema`、`@flower/core/schedule`、`@flower/core/markdown`、`@flower/core/links`、`@flower/core/notifications`。`markdown` 只依赖 `diff` 和类型导入，其余四个不导入任何其他模块。
- 纯逻辑放在 `apps/web/src/features/**/model.ts` 并写 Vitest 单测；页面行为用 Playwright 覆盖，每个 spec 自己调用 `resetDatabase()`。
- `.local-data/` 存放生产数据副本、对照表和对账报告，含员工个人信息，只在本地，不提交。迁移写入需要 `DATABASE_ADMIN_URL`；同一组织再次导入必须加 `--replace`，会先删除该组织的全部数据。prd 系统的附件文件需要先从服务器只读导出到 .local-data/prd_uploads/（导出前征得用户同意）；没有导出时导入仍可进行，报告列出缺失的文件数。
