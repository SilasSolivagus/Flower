# Flower 发布手册

> ⛔ **`scripts/smoke.sh` 禁止在生产机上运行，也禁止在任何还跑着别的 Flower 栈的机器上运行。**
> 它退出时会执行 `docker compose --profile schema --profile migrate down -v`，删掉本项目的数据卷。
> 它会重新构建镜像，覆盖 `flower:local` 和 `flower-migrate:local`。
> 它占用 3900 端口，并写入固定的测试密码。项目名虽然固定为 `flower_smoke`，只删自己的卷，但在同一台机器、同一个仓库目录里跑，镜像标签照样会被覆盖。
>
> ⛔ **生产机上不现场 build。**
> `flower:local` 和 `flower-migrate:local` 都在 47.x 以外的机器上，用同一个 commit 构建，再 `docker save` / `docker load` 传过去。
> 生产上的 `up` / `run` 不带构建参数。schema、migrate 两个服务没有 `build`，`pull_policy: never`：本机没有镜像就直接报错，不构建、不拉取。
> 在生产上现场构建要去 GitHub 下字体、拉 node 依赖。

合进仓库不等于上 47.x。下面凡是改生产的步骤都标「🔒 需 Silas 批准」。耗时都标「估算，未实测」。

## 硬检查（任一条不满足就停）

- 升级窗口：**先停 flower，再备份**。日常备份脚本本身可以在线跑；升级时不能先备份再停，否则停机前写入的数据回滚时会丢。迁移只能往前跑，没有 down 脚本。Flower 的回滚只能靠「恢复备份 + 回到旧镜像 + 当时的 compose 与 `.env`」。
- 生产环境的 `DATABASE_URL` 必须用 `flower_app`，禁止用 `flower_admin`。flower_admin 是超级用户，用它连库，RLS 会全部失效。核对：`docker compose config` 里 flower 服务的 `DATABASE_URL` 以 `postgres://flower_app:` 开头。
- admin 凭据只给 `schema` 和 `migrate`，通过 `.env.migrate` 提供。flower 容器里不能有 `DATABASE_ADMIN_URL` 或 `FLOWER_APP_DB_PASSWORD`。
  - 核对 1：`docker inspect <flower 容器> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -cE '^(DATABASE_ADMIN_URL|FLOWER_APP_DB_PASSWORD)='` 必须是 0。只数行数，不把内容贴进记录。
  - 核对 2：应用侧的 `.env` 里没有 `DATABASE_ADMIN_URL=` 这一行。
- **先 schema，再 up flower。** 忘了跑 schema，flower 会因版本闸以非 0 退出。不能靠闸兜底来代替这条检查。版本闸失败时先 `docker compose stop flower`，再处理，避免 `restart: unless-stopped` 反复拉起。
- `.env.migrate` 只在变更窗口里存在。权限 600。用完立刻删除，并用 `ls -la` 核对，在变更记录里写一笔。
- `.env.prdsrc` 只在导入窗口存在，权限 600，里面只有 `POSTGRES_PASSWORD`。用完即删，同样 `ls -la` 核对。prd-src 容器里不能出现 Flower 的连接串。
- **禁止用 `--prd-url` 传连接串。** 改用 `LEGACY_PRD_URL`，只写在 `.env.migrate` 里。密码与 `.env.prdsrc` 的 `POSTGRES_PASSWORD` 相同。
- `.env` 与 `.env.migrate` 里的 `FLOWER_APP_DB_PASSWORD` 必须是同一个值。schema 会把 flower_app 的密码重设成 `.env.migrate` 里的值。
- 导入用的 SQLite 必须是 `sqlite3 .backup` 出来的副本。不能直接拷贝正在运行的库文件。
- `FLOWER_SECRET_KEY` 另存进保险箱。导入时用的必须和实例是同一把。
- `FLOWER_PUBLIC_URL` 以 `https://` 开头；`FLOWER_TRUSTED_PROXY_HOPS` 按实际代理层数设置。
- 默认 compose 把端口绑在 `127.0.0.1`。机器以外的访问走 edge overlay，不要改成对所有网卡发布。
- 初始化向导完成前，不开放域名。向导里建组织时，slug 不能用 `pan123`。
- 导入的推送通道默认全部停用。启用 Flower 的通道之前，先停掉旧 push 的推送。
- `.env` 里的 `POSTGRES_ADMIN_PASSWORD` 不能删。postgres 服务要用它；回滚时也要它。
- 并行期内：禁止 `down` 123plane 整套；禁止 `docker network rm 123plane_default`。H3（edge 解耦）没做完之前，这一条是硬挡。
- **只允许把 47.x 上实际跑过的镜像打成 `:prev`**（`flower-migrate:prev` 同理）。不得用本地或 box 构建的旧镜像顶替。

版本闸（flower 启动时 `migrate.mjs --check`，只有一致才退出 0）：

| 情况 | 退出码 | 提示 |
|---|---|---|
| 库落后于镜像 | 1 | 数据库结构落后，并写出两边各自最新的迁移标签，请先跑 schema |
| 缺表或登记表是空的 | 1 | 数据库还没迁移，请先运行 `docker compose --profile schema run --rm schema` |
| 库比镜像新 | 1 | 数据库比镜像新：回滚请先恢复备份再用旧镜像 |
| 没有权限读登记表 | 1 | 没有权限，请重跑 schema 补授权（与「还没迁移」不是同一句） |
| 连不上库 | 1 | 写明主机名和端口、等了多久，或写明认证失败和账号名；带「可能还没迁移，先跑 schema」。不打印密码、完整连接串或堆栈 |

连库超时不超过 10 秒，整个 `--check` 不超过 30 秒。

## 首发 11 步

### 0. 准备 🔒

在 47.x 以外核对要发布的 commit。密钥放进保险箱。应用 `.env` 里的 `DATABASE_URL` 使用 `flower_app`。耗时：估算，未实测。

### 1. 备份旧系统 🔒

按本文「旧系统备份检查表」做一份，并拷到 47.x 以外。耗时：估算，未实测。

### 2. 旧系统切为只读（持续两周） 🔒

只读的具体做法和命令待 H1 + H3 + H-legacy-readonly 定稿后填。这一步不是临时冻结。耗时：估算，未实测。

### 3. 导出旧数据副本 🔒

SQLite 用 `.backup`。prd 用 `pg_dump -Fc`。记下 `pg_restore --list prd.dump | head` 里的「Dumped by pg_dump version」，用来决定 `PRDSRC_IMAGE`（默认 `postgres:17-alpine`，小版本不低于生产库，且与生产同为 alpine）。耗时：估算，未实测。

### 4. 机外构建并传入生产机 🔒

用同一个 commit 构建 `flower:local`（目标阶段 runner）和 `flower-migrate:local`（`docker build --target migrate`）。`docker save` / `docker load` 传到生产机，记录两个镜像的 ID。47.x 从未跑过 Flower，首发没有 `:prev`。耗时：估算，未实测。

### 5. 启动 Flower（F2 顺序） 🔒

1. `docker compose up -d --wait postgres`
2. 放好权限 600 的 `.env.migrate`（连接串主机名写服务名 `postgres`，不要写 127.0.0.1 或 localhost）
3. `docker compose --profile schema run --rm schema`，退出码必须为 0
4. `docker compose up -d --wait flower`

不再依赖 entrypoint 自动迁移。生产 compose 不给 flower 管理凭据。耗时：估算，未实测。

### 6. 只在内网完成初始化 🔒

打开 `/setup`。slug 不能用 `pan123`。默认端口只在本机 127.0.0.1。耗时：估算，未实测。

### 7. 导入（migrate profile） 🔒

1. 写好 `.env.prdsrc`（600，只有 `POSTGRES_PASSWORD`）和 `.env.migrate` 里的 `LEGACY_PRD_URL`（主机名 `prd-src`，密码与上一步相同）。
2. `docker compose --profile migrate up -d --wait prd-src`
3. 查扩展：`pg_restore --list prd.dump | grep -i 'EXTENSION'`。用到的扩展如果 `postgres:17-alpine` 没带，就停下来找后端。
4. 恢复：`docker compose --profile migrate exec -T prd-src pg_restore -U postgres -d prd_src --no-owner --no-privileges < prd.dump`  
   这里的 `--no-owner` / `--no-privileges` **只用于旧 prd 临时库**。恢复 Flower 自己的库时禁止加这两个参数。
5. 依次 `docker compose --profile migrate run --rm migrate suggest|import --dry-run|import|rejoin …`。输入在只读的 `/import/input`，对照表和报告在 `/import/work`。命令行里不出现任何连接串。覆盖组织必须带 `--replace --confirm-replace <slug>`。
6. 清理：`docker compose --profile migrate rm -sf prd-src`，然后 `docker volume rm <项目>_prd_src_data`。`docker volume ls` 确认 `prd_src` 卷已经消失，`flower_pg` 和 `flower_storage` 仍在。
7. 删除 `.env.migrate` 和 `.env.prdsrc`，`ls -la` 核对。

耗时：估算，未实测。

### 8. 切域名前先接入 edge 🔒

在生产机上用 overlay 文件（例如 `/opt/flower/compose.edge.yml`，不进仓库默认配置）把 flower 接到 edge 网络。网络名以 H1/H3 核对的结果为准，例如 `edge_net`。不推荐临时挂到 `123plane_default`。

```yaml
# 示例，网络名待 H1/H3
services:
  flower:
    networks: [edge_net]
networks:
  edge_net:
    external: true
```

启动：`docker compose -f docker-compose.yml -f compose.edge.yml up -d --wait flower`。不改仓库默认的端口绑定。耗时：估算，未实测。

### 9. 切域名 🔒

edge-nginx 把域名指到 Flower。切之前 Flower 已经挂在 edge 上（第 8 步）。耗时：估算，未实测。

### 10. 并行观察 🔒

从切换日 D0 到 D+14：123plane、push、prd 保持在线、只读。D+14 是否下线由 Silas 单独批准。耗时：估算，未实测。

## 日常升级

0. 🔒 在机外用同一个 commit 构建 `flower:local`，需要导入时也构建 `flower-migrate:local`。`docker save` 后在生产机 `docker load`。**load 之前**，只把 47.x 上实际跑过的镜像打成 `flower:prev` / `flower-migrate:prev`。把当时的 `docker-compose.yml`、`.env` 和 commit 号一起留档。不得用本地或 box 构建的旧镜像顶替。
1. 🔒 建 `.env.migrate`，权限 600。`FLOWER_APP_DB_PASSWORD` 与 `.env` 一致。连接串主机名是 `postgres`。
2. 🔒 `docker compose stop flower`（停机开始）。
3. 🔒 `scripts/backup-flower.sh --out <机外同步目录> --project <项目名>`。
4. 🔒 `docker compose --profile schema run --rm schema`，退出码必须为 0。
5. 🔒 `docker compose up -d --wait flower`。版本闸通过才算成功。闸失败时先 `docker compose stop flower`。
6. 登录和关键页面。`docker inspect` 确认没有 admin 变量（只数行数）。删除 `.env.migrate`，`ls -la` 核对。

耗时：估算，未实测。多出来的停机时间主要是 pg_dump。

## 备份

Flower 自己的库和附件用 `scripts/backup-flower.sh`。它只读，不停服务，不执行 down，也不删卷。不备份 `.env` 和 `.env.migrate`，密钥由 Silas 放进保险箱。

恢复演练（待演练验证，下面是步骤，不是已测耗时）：

1. 起一个空的 postgres。
2. 先确认 `flower_app` 角色存在。
3. `pg_restore`。**不要**加 `--no-owner` 或 `--no-privileges`，否则 flower_app 的授权会丢，版本闸会拦住启动。
4. 跑 `schema`。已登记的迁移会跳过，并再设一次密码、补一次只读授权。
5. 再 up flower。

### 旧系统备份检查表

这些命令只写在这里，由有权限的人在 Silas 批准后执行。不要在改仓时对 47.x 执行。

| 对象 | 类型 | 推荐的备份方式（在线一致性） | 现在 daily-backup 有没有覆盖 |
|---|---|---|---|
| wecom-push `data.db` | SQLite | `sqlite3 /opt/wecom-push/data.db ".backup '/backup/wecom-push-data-<日期>.db'"`，然后 `sqlite3 <备份> "PRAGMA integrity_check;"` 必须是 `ok` | 没有，必须补 |
| 123plane `123plane.db` | SQLite | 同上，用 `.backup`。不要直接 `cp` | 有，但方式未知，要核对是不是 `cp` |
| prd-postgres | PG17 | `pg_dump -Fc`，并用 `pg_restore --list` 校验 | 有 |
| prd-uploads | 文件 | `tar -czf` 加 `sha256sum` | 有 |
| 备份放在哪 | — | 切换前拷一份到 47.x 以外 | — |

## 回滚

### 首发失败（47.x 还没有跑过 Flower，没有 `:prev`） 🔒

停 flower，只删 Flower 自己的库卷。旧系统并行不受影响。禁止 down 123plane，禁止删除 `123plane_default`。不要对 123plane、prd、push 做恢复。耗时：估算，未实测。

### 切域名之前 🔒

停 Flower：`docker compose stop flower`。撤销旧系统的只读配置。不要对 123plane、prd、push 做任何恢复，旧数据没有被导入改动过。约 10 分钟（估算，未实测）。

### 切域名之后 🔒

edge-nginx 改回原来的上游，旧系统恢复可写。切换后在 Flower 里写的数据没法同步回旧系统，回滚会丢掉这部分。回滚之前先对 Flower 做一次备份留证。约 15 分钟（估算，未实测）。

### Flower 升级失败 🔒

不要试图往回迁移。把留档的三件套一起换回去：`flower:prev`（以及需要时的 `flower-migrate:prev`）、当时的 compose 文件、当时的 `.env`。`.env` 里的 `POSTGRES_ADMIN_PASSWORD` 不能删。

1. `docker compose stop flower`。
2. 恢复升级前的备份：删库重建或换新卷；确认 `flower_app` 角色存在；`pg_restore` **不加** `--no-owner` / `--no-privileges`；附件有改动时用 tgz 恢复 `flower_storage`。
3. 把留档镜像和 compose、`.env` 换回去。
4. `docker compose up -d --wait flower`。版本闸会核对恢复后的库和这只旧镜像是否一致。只换镜像、不恢复备份，会被「库比镜像新」拦住。
5. 恢复演练没有实测过。首发前要在 box 上演练一次，记录耗时。在此之前，上面的分钟数都是估算。

`:prev` 只能来自 47.x 上实际跑过的镜像。首发成功之后的 `:prev` 就是上一只带版本闸的 Flower 镜像。

## 并行只读两周

从切换日 D0 到 D+14：123plane、push、prd 保持在线、只读；123plane 继续负责登录。禁止 down 123plane 整套，禁止删除 `123plane_default`。D+14 是否下线，由 Silas 单独批准。只读命令待 H1、H3 与 H-legacy-readonly 定稿后补。

## 员工账号

旧密码不迁移。员工要逐个邀请，再绑定到对应的占位成员。邀请名单模板另出（链接待补）。

## 本地与 CI

- 日常开发迁移用 `pnpm db:migrate`，不走生产 compose。
- 本地如果要整栈跑 compose，也是先 postgres，再 schema，再 flower。`docker-compose.dev.yml` 不承担这件事。
- 给容器的 `DATABASE_ADMIN_URL` / `DATABASE_URL` 主机名写 `postgres`。宿主机另用别的变量，不要把 `127.0.0.1` 或 `localhost` 原样传进容器。
- `./scripts/smoke.sh` 只在没有其他 Flower 栈的开发机或 CI 上跑。
