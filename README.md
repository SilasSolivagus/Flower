# Flower

多组织、多产品的产品研发管理平台：需求、迭代、PRD、通知、知识库，并通过 MCP 向外部 Agent 开放。

## 自托管

1. `cp .env.selfhost.example .env`，填写 `POSTGRES_ADMIN_PASSWORD`、`FLOWER_APP_DB_PASSWORD`（只用字母数字，`openssl rand -hex 24`）和 `FLOWER_SECRET_KEY`（`openssl rand -base64 48`）。
2. `docker compose up -d`
3. 打开 `http://localhost:3000`，按初始化向导创建管理员和第一个组织。

默认为邀请制，实例管理员可在实例设置中开放注册。

初始化向导完成前 `/setup` 是开放的，不要在完成初始化前把新实例暴露到公网。

## 开发

见 `CLAUDE.md`。
