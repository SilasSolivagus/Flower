#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=flower_smoke
export POSTGRES_ADMIN_PASSWORD=smokeadmin123
export FLOWER_APP_DB_PASSWORD=smokeapp123
export FLOWER_SECRET_KEY="$(openssl rand -hex 32)"
export FLOWER_PORT=3900
export FLOWER_PUBLIC_URL=http://localhost:3900
BASE=http://localhost:3900/api/v1
JAR="$(mktemp)"
trap 'docker compose down -v >/dev/null 2>&1; rm -f "$JAR"' EXIT

docker compose up -d --build --wait

echo "1. 缺少密钥时镜像拒绝启动"
# 子 shell 里吞掉 docker run 自身的非零退出码（镜像里 loadConfig 拒绝启动会让进程以退出码 1
# 结束）：脚本开了 pipefail，否则即使 grep 匹配到了，管道的退出码仍会被 docker run 的失败盖过。
if (docker run --rm -e DATABASE_URL=x -e DATABASE_ADMIN_URL=x -e FLOWER_APP_DB_PASSWORD=x flower:local 2>&1; true) | grep -q 'FLOWER_SECRET_KEY'; then
  echo "   通过"
else
  echo "   失败：未提示缺少 FLOWER_SECRET_KEY"; exit 1
fi

echo "2. 初始化前状态"
curl -fs "$BASE/setup/status" | grep -q '"initialized":false'

echo "3. 初始化并自动登录"
curl -fs -c "$JAR" -H 'content-type: application/json' \
  -d '{"admin":{"email":"owner@example.com","name":"Owner","password":"password123"},"org":{"name":"冒烟组织","slug":"smoke"}}' \
  "$BASE/setup" >/dev/null
curl -fs -b "$JAR" "$BASE/me" | grep -q '"slug":"smoke"'

echo "4. 重新登录（验证 argon2 原生模块在镜像内可用）"
curl -fs -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"password123"}' "$BASE/auth/login" >/dev/null

echo "5. 重启后数据仍在，迁移可重复执行"
docker compose restart flower >/dev/null
docker compose up -d --wait >/dev/null
curl -fs "$BASE/setup/status" | grep -q '"initialized":true'

echo "冒烟测试通过"
