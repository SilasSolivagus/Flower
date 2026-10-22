#!/bin/sh
set -e
# 开发/CI 兼容：只有显式给了 admin 凭据才自己迁移；生产 compose 不给，跳过
if [ -n "$DATABASE_ADMIN_URL" ]; then
  node migrate.mjs
fi
# 版本闸：缺表、落后、领先、无权限、连不上都以非 0 退出，禁止带着旧表起服务
node migrate.mjs --check
exec env -u DATABASE_ADMIN_URL -u FLOWER_APP_DB_PASSWORD node apps/web/server.js
