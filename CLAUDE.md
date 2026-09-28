# Flower

多组织、多产品的产品研发管理平台。设计文档：`docs/superpowers/specs/2026-09-28-flower-data-model-design.md`。

## 命令

| 用途 | 命令 |
|---|---|
| 启动开发数据库（端口 54329） | `pnpm db:up` |
| 执行迁移（读 apps/web/.env.local） | `pnpm db:migrate` |
| 开发服务器 | `pnpm dev` |
| 全部测试（需要先 db:up） | `pnpm test` |
| 类型检查 | `pnpm typecheck` |
| 修改 schema 后生成迁移 | `pnpm --filter @flower/core db:generate` |
| 镜像冒烟测试 | `./scripts/smoke.sh` |

首次开发：`cp .env.example apps/web/.env.local`，填入 `FLOWER_SECRET_KEY`（`openssl rand -base64 48`）。

`pnpm test` 会把集群里 `flower_app` 角色的密码改成测试固定值 `flower_app_test`；测试跑完后、`pnpm dev` 之前先执行一次 `pnpm db:migrate` 把密码改回 `apps/web/.env.local` 里配置的值。

## 约定

- 业务逻辑只写在 `packages/core`，服务函数签名为 `(db, actor, input)`；`apps/web/src/server/routes` 只做参数校验和调用。
- 租户数据一律在 `withOrg(db, actor.orgId, ...)` 中读写；`withSystem` 只用于登录、成员关系查找、Token 认证、邀请接受。
- 新增租户表必须带 `org_id`，并在一个新的自定义迁移里为它开启 RLS（参照 `0002_rls.sql`）。
- 每个写操作在同一事务内调用 `recordEvent`。
- 服务函数一律声明为 `async`，保证权限校验失败以 Promise 拒绝的形式返回。
- 面向用户的错误信息用中文，通过 `AppError(code, message, details?)` 抛出。
