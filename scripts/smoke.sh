#!/usr/bin/env bash
# 禁止在生产机，以及任何还跑着别的 Flower 栈的机器上运行。
# 退出时会 docker compose down -v，并覆盖 flower:local / flower-migrate:local 标签。
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=flower_smoke
export POSTGRES_ADMIN_PASSWORD=smokeadmin123
export FLOWER_APP_DB_PASSWORD=smokeapp123
export FLOWER_SECRET_KEY="$(openssl rand -hex 32)"
export FLOWER_PORT=3900
export FLOWER_PUBLIC_URL=http://localhost:3900
# 容器里的主机名必须是 compose 服务名。宿主机不走这条连接串（postgres 不映射端口）。
export SMOKE_CONTAINER_PG_HOST=postgres
export SMOKE_HOST_PG_HOST=127.0.0.1
export DATABASE_ADMIN_URL="postgres://flower_admin:${POSTGRES_ADMIN_PASSWORD}@${SMOKE_CONTAINER_PG_HOST}:5432/flower"
export DATABASE_URL="postgres://flower_app:${FLOWER_APP_DB_PASSWORD}@${SMOKE_CONTAINER_PG_HOST}:5432/flower"
BASE=http://localhost:3900/api/v1
JAR="$(mktemp)"
names=()
run_log=""
run_code=0

url_host() {
  local rest="${1#*@}"
  local hostport="${rest%%/*}"
  printf '%s' "${hostport%%:*}"
}

require_container_url() {
  local name="$1"
  local url="$2"
  if [[ -z "$url" ]]; then
    if [[ "$name" == "DATABASE_ADMIN_URL" ]]; then
      echo "缺少 DATABASE_ADMIN_URL" >&2
    else
      echo "缺少 ${name}" >&2
    fi
    exit 1
  fi
  local host
  host="$(url_host "$url")"
  if [[ -z "$host" || "$host" == "$url" ]]; then
    echo "缺少 ${name} 的主机名" >&2
    exit 1
  fi
  if [[ "$host" != "postgres" ]]; then
    echo "${name} 的主机名必须是 postgres（当前是 ${host}）" >&2
    exit 1
  fi
}

for var in POSTGRES_ADMIN_PASSWORD FLOWER_APP_DB_PASSWORD FLOWER_SECRET_KEY; do
  if [[ -z "${!var}" ]]; then
    echo "缺少 ${var}" >&2
    exit 1
  fi
done
require_container_url DATABASE_ADMIN_URL "$DATABASE_ADMIN_URL"
require_container_url DATABASE_URL "$DATABASE_URL"
if [[ "$SMOKE_HOST_PG_HOST" == "postgres" ]]; then
  echo "宿主机变量 SMOKE_HOST_PG_HOST 不能写成服务名 postgres" >&2
  exit 1
fi

cleanup() {
  local n
  if [[ ${#names[@]} -gt 0 ]]; then
    for n in "${names[@]}"; do
      docker rm -f "$n" >/dev/null 2>&1 || true
    done
  fi
  docker compose --profile schema --profile migrate down -v >/dev/null 2>&1 || true
  rm -f "$JAR"
}
trap cleanup EXIT

# 用法：compose_run 秒 容器名 [compose 全局参数] -- [run 参数与服务名]
# 结果写到 run_code / run_log。超时直接退出。函数本身不以非 0 返回，避免 set -e 把调用方跳过。
compose_run() {
  local seconds="$1" name="$2"
  shift 2
  local -a pre=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    pre+=("$1")
    shift
  done
  [[ "${1:-}" == "--" ]] && shift
  names+=("$name")
  run_log="$(mktemp)"
  set +e
  timeout --signal=TERM --kill-after=10 "$seconds" docker compose "${pre[@]}" run -T --rm --name "$name" "$@" < /dev/null >"$run_log" 2>&1
  run_code=$?
  set -e
  if [[ "$run_code" -eq 124 || "$run_code" -eq 137 || "$run_code" -eq 143 ]]; then
    echo "超时（${seconds}s）：docker compose run --name ${name}" >&2
    docker logs "$name" 2>&1 | tail -n 50 >&2 || true
    docker rm -f "$name" >/dev/null 2>&1 || true
    exit 1
  fi
}

up_wait() {
  local log code
  log="$(mktemp)"
  set +e
  timeout --signal=TERM --kill-after=10 150 docker compose up -d --wait --wait-timeout 120 "$@" < /dev/null >"$log" 2>&1
  code=$?
  set -e
  if [[ "$code" -ne 0 ]]; then
    echo "启动失败或超时：docker compose up $* （退出码 ${code}）" >&2
    cat "$log" >&2
    docker compose logs --tail 50 flower >&2 || true
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
}

echo "准备：构建镜像并启动 postgres"
docker compose build flower
docker build --target migrate -t flower-migrate:local .
up_wait postgres

echo "1. 缺少密钥时镜像拒绝启动"
if (docker run --rm --name "smoke-step1-$$" -e DATABASE_URL=x -e DATABASE_ADMIN_URL=x -e FLOWER_APP_DB_PASSWORD=x flower:local < /dev/null 2>&1; true) | grep -q 'FLOWER_SECRET_KEY'; then
  names+=("smoke-step1-$$")
  echo "   通过"
else
  names+=("smoke-step1-$$")
  echo "   失败：未提示缺少 FLOWER_SECRET_KEY"
  exit 1
fi

echo "0b. 数据库结构未迁移时拒绝启动"
compose_run 40 "smoke-0b-$$" -- --no-deps flower
code=$run_code
if [[ "$code" -eq 0 ]]; then
  echo "   失败：未迁移时 flower 不应启动成功"
  exit 1
fi
if [[ "$code" -ne 1 ]]; then
  echo "   失败：期望退出码 1，实际 ${code}"
  cat "$run_log" >&2 || true
  exit 1
fi
if ! grep -q 'schema' "$run_log"; then
  echo "   失败：输出未包含 schema"
  cat "$run_log" >&2 || true
  exit 1
fi
echo "   通过"
rm -f "$run_log"

echo "0c. 先迁移"
compose_run 180 "smoke-0c-$$" --profile schema -- -e DATABASE_ADMIN_URL -e FLOWER_APP_DB_PASSWORD -e DATABASE_URL -e FLOWER_SECRET_KEY schema
code=$run_code
if [[ "$code" -ne 0 ]]; then
  echo "   失败：schema 退出码 ${code}，停止冒烟，不再启动 flower" >&2
  cat "$run_log" >&2 || true
  docker logs "smoke-0c-$$" 2>&1 | tail -n 50 >&2 || true
  exit 1
fi
echo "   通过"
rm -f "$run_log"

echo "0d. 再启动 flower"
up_wait flower

echo "0e. flower 容器里没有 admin 凭据"
env_count="$(docker inspect "$(docker compose ps -q flower)" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -cE '^(DATABASE_ADMIN_URL|FLOWER_APP_DB_PASSWORD)=' || true)"
if [[ "$env_count" != "0" ]]; then
  echo "   失败：flower 环境里仍有 admin 变量（${env_count} 行）"
  exit 1
fi
echo "   通过"

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

echo "4b. 页面可以访问"
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY curl -fs -o /dev/null -w '%{http_code}' http://localhost:3900/login | grep -q '200'
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY curl -fs http://localhost:3900/login | grep -q '<title>Flower</title>'

echo "4c. 图片写入存储卷"
jget() { node -e "let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',()=>console.log(JSON.parse(s)$1))"; }
PRODUCT_ID="$(curl -fs -b "$JAR" -H 'content-type: application/json' -d '{"name":"冒烟产品","key":"SMK"}' "$BASE/orgs/smoke/products" | jget .product.id)"
DOC_ID="$(curl -fs -b "$JAR" -H 'content-type: application/json' -d '{"title":"冒烟 PRD"}' "$BASE/orgs/smoke/products/$PRODUCT_ID/documents" | jget .document.id)"
PNG="$(mktemp)"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0d' > "$PNG"
ATT_URL="$(curl -fs -b "$JAR" -F "file=@$PNG;filename=smoke.png" "$BASE/orgs/smoke/documents/$DOC_ID/attachments" | jget .attachment.url)"
rm -f "$PNG"
curl -fs -b "$JAR" -o /dev/null "http://localhost:3900$ATT_URL"

echo "4d. 看板图片：字体与 satori、resvg（原生模块 musl 版）在镜像内可用"
# Next 把 serverExternalPackages 以带哈希的别名放在 .next/node_modules 下，按前缀查找
docker compose exec -T flower node -e "
const fs = require('fs');
const dir = '/app/apps/web/.next/node_modules/';
const { Resvg } = require(dir + '@resvg/' + fs.readdirSync(dir + '@resvg').find((n) => n.startsWith('resvg-js')));
const satori = require(dir + fs.readdirSync(dir).find((n) => n.startsWith('satori'))).default;
const font = (f, weight) => ({ name: 'Noto Sans SC', data: fs.readFileSync(process.env.FLOWER_FONT_DIR + '/' + f), weight, style: 'normal' });
satori({ type: 'div', props: { style: { display: 'flex', fontSize: 32 }, children: '看板图片 100%' } }, { width: 400, height: 80, fonts: [font('NotoSansSC-Regular.otf', 400), font('NotoSansSC-Bold.otf', 700)] })
  .then((svg) => { if (new Resvg(svg).render().asPng().length < 100) process.exit(1); });
"

echo "5. 再迁移一次后重启，数据仍在"
compose_run 180 "smoke-schema-2-$$" --profile schema -- -e DATABASE_ADMIN_URL -e FLOWER_APP_DB_PASSWORD -e DATABASE_URL -e FLOWER_SECRET_KEY schema
code=$run_code
if [[ "$code" -ne 0 ]]; then
  echo "   失败：重复 schema 退出码 ${code}" >&2
  cat "$run_log" >&2 || true
  exit 1
fi
rm -f "$run_log"
up_wait --force-recreate flower
curl -fs "$BASE/setup/status" | grep -q '"initialized":true'
curl -fs -b "$JAR" -o /dev/null "http://localhost:3900$ATT_URL"
echo "   通过"

echo "6. 备份脚本可用"
bak="$(mktemp -d)"
scripts/backup-flower.sh --out "$bak" --project flower_smoke
dump="$(find "$bak" -name 'flower-*.dump' -print -quit)"
tgz="$(find "$bak" -name 'flower-storage-*.tgz' -print -quit)"
if [[ ! -s "$dump" || ! -s "$tgz" ]]; then
  echo "   失败：备份文件缺失"
  exit 1
fi
docker compose exec -T postgres pg_restore --list <"$dump" >/dev/null
tar -tzf "$tgz" >/dev/null
rm -rf "$bak"
echo "   通过"

echo "7. 导入镜像可用，--replace 未确认时拒绝"
if (docker run --rm --name "smoke-usage-$$" flower-migrate:local < /dev/null 2>&1; true) | grep -q '用法'; then
  names+=("smoke-usage-$$")
  echo "   USAGE 通过"
else
  names+=("smoke-usage-$$")
  echo "   失败：未打印用法"
  exit 1
fi
replace_log="$(mktemp)"
set +e
docker run --rm --name "smoke-replace-$$" flower-migrate:local import --replace --org-slug smoke --plane /nope --push /nope --mapping /nope < /dev/null >"$replace_log" 2>&1
code=$?
set -e
names+=("smoke-replace-$$")
if [[ "$code" -eq 0 ]] || ! grep -q -- '--confirm-replace' "$replace_log"; then
  echo "   失败：--replace 未确认时仍应退出非 0，并提示 --confirm-replace（退出码 ${code}）" >&2
  cat "$replace_log" >&2 || true
  rm -f "$replace_log"
  exit 1
fi
rm -f "$replace_log"
echo "   通过"

echo "冒烟测试通过"
