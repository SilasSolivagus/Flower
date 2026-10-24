#!/usr/bin/env bash
# 备份脚本的行为测试。用假的 docker 拦住拉取，不连接生产，也不起真实容器。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/scripts/backup-flower.sh"
secret='super-secret-value-xyz'

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "缺少 shellcheck" >&2
  exit 1
fi
shellcheck -s bash "$script" "$root/scripts/backup-flower.test.sh"
unset COMPOSE_FILE FLOWER_COMPOSE_FILES FLOWER_BACKUP_TAR_IMAGE COMPOSE_PROJECT_NAME || true

failures=0
pass() { printf '通过：%s\n' "$1"; }
fail() {
  printf '失败：%s\n' "$1" >&2
  failures=$((failures + 1))
}

assert_eq() {
  local name="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    pass "$name"
  else
    fail "$name（期望 $want，实际 $got）"
  fi
}

assert_ok() {
  local name="$1" status="$2"
  if [[ "$status" -eq 0 ]]; then
    pass "$name"
  else
    fail "$name（退出码 $status）"
  fi
}

assert_fail() {
  local name="$1" status="$2"
  if [[ "$status" -ne 0 ]]; then
    pass "$name"
  else
    fail "$name（不应成功）"
  fi
}

no_secret() {
  local name="$1" file="$2"
  if grep -F -q "$secret" "$file"; then
    fail "$name（输出里出现了密钥）"
  else
    pass "$name"
  fi
}

# 读一条以 NUL 分隔的参数记录，结果放在 ARGS。
read_args() {
  ARGS=()
  local arg
  while IFS= read -r -d '' arg; do
    ARGS+=("$arg")
  done <"$1" || true
}

invocations() {
  local dir="$1"
  shopt -s nullglob
  local files=("$dir"/*.args)
  shopt -u nullglob
  printf '%s\n' "${files[@]}"
}

# 在一条 docker run 参数里找出镜像名（选项都在镜像前面）。
run_image() {
  local -a args=("$@")
  local i=0
  while [[ "$i" -lt "${#args[@]}" ]]; do
    case "${args[$i]}" in
      run)
        i=$((i + 1))
        ;;
      --rm|--init|--interactive|-i|--tty|-t)
        i=$((i + 1))
        ;;
      --pull|--network|--entrypoint|-v|--name|-u|--user|--label|-l|-e|--env|-w|--workdir)
        i=$((i + 2))
        ;;
      --)
        i=$((i + 1))
        break
        ;;
      -*)
        i=$((i + 1))
        ;;
      *)
        printf '%s' "${args[$i]}"
        return 0
        ;;
    esac
  done
  return 1
}

has_pair() {
  local key="$1" value="$2"
  shift 2
  local i
  for ((i = 0; i < $#; i++)); do
    local cur="${*:$((i + 1)):1}"
    if [[ "$cur" == "$key" && $((i + 1)) -lt $# ]]; then
      local nxt="${*:$((i + 2)):1}"
      if [[ "$nxt" == "$value" ]]; then
        return 0
      fi
    fi
  done
  return 1
}

write_mock() {
  local bin="$1"
  mkdir -p "$bin"
  cat >"$bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
dir="${MOCK_DIR:?}"
secret="${MOCK_SECRET:?}"
n="$(find "$dir" -maxdepth 1 -name '*.args' | wc -l)"
out="$(printf '%s/%03d.args' "$dir" "$((n + 1))")"
printf '%s\0' "$@" >"$out"

if [[ "${1:-}" == "pull" ]]; then
  echo "unexpected pull" >&2
  exit 97
fi

if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  printf '%s\n' "$secret"
  printf '%s\n' "$secret" >&2
  name="${3:-}"
  IFS='|' read -r -a ok <<<"${MOCK_OK_IMAGES:-}"
  local_ok=1
  for item in "${ok[@]}"; do
    if [[ -n "$item" && "$item" == "$name" ]]; then
      local_ok=0
    fi
  done
  exit "$local_ok"
fi

if [[ "${1:-}" == "compose" ]]; then
  sub=""
  i=2
  while [[ "$i" -le $# ]]; do
    cur="${!i}"
    case "$cur" in
      -f|-p|--project-name|--project-directory)
        i=$((i + 2))
        ;;
      -*)
        i=$((i + 1))
        ;;
      *)
        sub="$cur"
        break
        ;;
    esac
  done
  if [[ "$sub" == "config" ]]; then
    if [[ "$*" == *" --environment"* || "$*" == *" --environment "* ]]; then
      printf '%s\n' "$secret"
      exit 0
    fi
    if [[ "${MOCK_CONFIG_STATUS:-0}" -ne 0 ]]; then
      printf '%s\n' "$secret" >&2
      exit 1
    fi
    case " $* " in
      *" --images "*)
        printf '%s\n' "${MOCK_IMAGE:?}"
        exit 0
        ;;
      *)
        printf '%s\n' "$secret"
        exit 0
        ;;
    esac
  fi
  if [[ "$sub" == "ps" ]]; then
    if [[ -n "${MOCK_FLOWER_ID:-}" ]]; then
      printf '%s\n' "$MOCK_FLOWER_ID"
    fi
    exit 0
  fi
  if [[ "$sub" == "exec" ]]; then
    if [[ "$*" == *" pg_dump "* ]]; then
      printf 'PGDMP'
      exit 0
    fi
    if [[ "$*" == *" pg_restore "* ]]; then
      cat >/dev/null
      exit 0
    fi
  fi
  echo "unexpected compose" >&2
  exit 96
fi

  if [[ "${1:-}" == "inspect" ]]; then
  printf '%s\n' "${MOCK_VOLUME:-}"
  exit 0
fi

if [[ "${1:-}" == "run" ]]; then
  pull_ok=0
  i=1
  while [[ "$i" -le $# ]]; do
    nxt=$((i + 1))
    nxt_val=""
    if [[ "$nxt" -le $# ]]; then
      nxt_val="${!nxt}"
    fi
    if [[ "${!i}" == "--pull" && "$nxt_val" == "never" ]]; then
      pull_ok=1
    fi
    i=$((i + 1))
  done
  if [[ "$pull_ok" -ne 1 ]]; then
    echo "missing --pull never" >&2
    exit 98
  fi
  image=""
  i=1
  while [[ "$i" -le $# ]]; do
    cur="${!i}"
    case "$cur" in
      --rm|--init)
        i=$((i + 1))
        ;;
      --pull|--network|--entrypoint|-v|--name|-u|--user|--label|-l|-e|--env|-w|--workdir)
        i=$((i + 2))
        ;;
      --)
        i=$((i + 1))
        break
        ;;
      -*)
        i=$((i + 1))
        ;;
      *)
        image="$cur"
        break
        ;;
    esac
  done
  if [[ "$image" == "alpine" || "$image" == "alpine:latest" ]]; then
    echo "refusing bare alpine" >&2
    exit 99
  fi
  if [[ "${MOCK_RUN_STATUS:-0}" -ne 0 ]]; then
    exit "${MOCK_RUN_STATUS}"
  fi
  python3 -c 'import io,sys,tarfile; raw=io.BytesIO(); t=tarfile.open(fileobj=raw, mode="w:gz"); info=tarfile.TarInfo("hello.txt"); data=b"hi"; info.size=len(data); t.addfile(info, io.BytesIO(data)); t.close(); sys.stdout.buffer.write(raw.getvalue())'
  exit 0
fi

echo "unexpected docker" >&2
exit 95
EOF
  chmod +x "$bin/docker"
}

run_backup() {
  local fixture="$1" out="$2"
  shift 2
  local log="$out/script.log"
  mkdir -p "$out"
  set +e
  env -u COMPOSE_PROJECT_NAME \
    MOCK_DIR="$MOCK_DIR" MOCK_SECRET="$secret" MOCK_IMAGE="$MOCK_IMAGE" \
    MOCK_OK_IMAGES="$MOCK_OK_IMAGES" MOCK_CONFIG_STATUS="${MOCK_CONFIG_STATUS:-0}" \
    MOCK_RUN_STATUS="${MOCK_RUN_STATUS:-0}" \
    MOCK_FLOWER_ID="${MOCK_FLOWER_ID:-}" MOCK_VOLUME="${MOCK_VOLUME:-}" \
    POSTGRES_ADMIN_PASSWORD="$secret" FLOWER_SECRET_KEY="$secret" \
    DATABASE_URL="postgres://flower_app:${secret}@postgres:5432/flower" \
    PATH="$MOCK_BIN:$PATH" \
    bash "$fixture/scripts/backup-flower.sh" --out "$out" --project flower_prod "$@" \
    >"$log" 2>&1
  status=$?
  set -e
  printf '%s' "$status"
}

new_fixture() {
  local dir="$1" kind="$2"
  mkdir -p "$dir/scripts" "$dir/out-parent"
  cp "$script" "$dir/scripts/backup-flower.sh"
  chmod +x "$dir/scripts/backup-flower.sh"
  printf 'POSTGRES_ADMIN_PASSWORD=%s\nFLOWER_SECRET_KEY=%s\n' "$secret" "$secret" >"$dir/.env"
  case "$kind" in
    prod)
      printf 'services:\n  postgres:\n    image: postgres:17-alpine\n' >"$dir/compose.yml"
      printf 'services:\n  postgres:\n    image: postgres:17-alpine\n' >"$dir/compose.prod.yml"
      printf 'services:\n  postgres:\n    image: alpine:latest\n' >"$dir/docker-compose.yml"
      ;;
    repo)
      printf 'services:\n  postgres:\n    image: pgvector/pgvector:pg17\n' >"$dir/docker-compose.yml"
      ;;
  esac
}

f_args() {
  local file="$1" flag="$2"
  read_args "$file"
  local i found=()
  for ((i = 0; i < ${#ARGS[@]}; i++)); do
    if [[ "${ARGS[$i]}" == "$flag" ]]; then
      found+=("${ARGS[$((i + 1))]}")
    fi
  done
  printf '%s\n' "${found[@]}"
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. 生产两份 compose：不使用裸 alpine，docker run 带 --pull never，产物可校验。
fx="$work/prod"
new_fixture "$fx" prod
MOCK_DIR="$work/mock1"
MOCK_BIN="$work/bin1"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='pgvector/pgvector:pg17'
MOCK_OK_IMAGES="$MOCK_IMAGE"
out="$work/out1"
status="$(run_backup "$fx" "$out")"
assert_ok "生产 compose 备份成功" "$status"
no_secret "成功时不打印密钥" "$out/script.log"
files_line="$(invocations "$MOCK_DIR" | while IFS= read -r f; do
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "compose" ]]; then
    printf '%s\n' "$(f_args "$f" -f | paste -sd, -)"
    break
  fi
done)"
if [[ "$files_line" == *"/compose.yml,"*"/compose.prod.yml" && "$files_line" != *"docker-compose.yml"* ]]; then
  pass "compose 使用 compose.yml 与 compose.prod.yml"
else
  fail "compose 文件列表不对（$files_line）"
fi
run_file="$(invocations "$MOCK_DIR" | while IFS= read -r f; do
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "run" ]]; then
    printf '%s' "$f"
    break
  fi
done)"
if [[ -z "$run_file" ]]; then
  fail "没有 docker run"
else
  read_args "$run_file"
  if has_pair --pull never "${ARGS[@]}"; then
    pass "docker run 带 --pull never"
  else
    fail "docker run 缺少 --pull never"
  fi
  if has_pair --entrypoint tar "${ARGS[@]}"; then
    pass "docker run 用 tar 作为入口，不走镜像默认入口"
  else
    fail "docker run 缺少 --entrypoint tar"
  fi
  if has_pair --network none "${ARGS[@]}"; then
    pass "打包容器没有网络"
  else
    fail "docker run 缺少 --network none"
  fi
  vol=""
  for ((i = 0; i < ${#ARGS[@]}; i++)); do
    if [[ "${ARGS[$i]}" == "-v" ]]; then
      vol="${ARGS[$((i + 1))]}"
    fi
  done
  assert_eq "附件卷只读挂载" "flower_prod_flower_storage:/data:ro" "$vol"
  got_image="$(run_image "${ARGS[@]}")"
  assert_eq "打包镜像来自 compose config --images" "$MOCK_IMAGE" "$got_image"
fi
saw_images=0
saw_pull=0
saw_alpine=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "pull" ]]; then
    saw_pull=1
  fi
  if [[ "${ARGS[0]:-}" == "run" ]]; then
    img="$(run_image "${ARGS[@]}" || true)"
    if [[ "$img" == "alpine" || "$img" == "alpine:latest" ]]; then
      saw_alpine=1
    fi
  fi
  if [[ "${ARGS[0]:-}" == "compose" ]]; then
    for a in "${ARGS[@]}"; do
      if [[ "$a" == "--images" ]]; then
        saw_images=1
      fi
      if [[ "$a" == "--environment" ]]; then
        fail "调用了会打印环境值的 compose config --environment"
      fi
    done
  fi
done < <(invocations "$MOCK_DIR")
assert_eq "用 config --images 取镜像名" "1" "$saw_images"
assert_eq "没有 docker pull" "0" "$saw_pull"
assert_eq "没有使用裸 alpine" "0" "$saw_alpine"
dump="$(find "$out" -name 'flower-*.dump' -print -quit)"
tgz="$(find "$out" -name 'flower-storage-*.tgz' -print -quit)"
if [[ -s "$dump" && -s "$tgz" && -s "${dump}.sha256" && -s "${tgz}.sha256" ]]; then
  pass "生成 dump、附件包和 sha256"
else
  fail "产物不完整"
fi
if (cd "$out" && sha256sum -c ./*.sha256 >/dev/null); then
  pass "sha256 校验通过"
else
  fail "sha256 校验失败"
fi
if tar -tzf "$tgz" | grep -q 'hello.txt'; then
  pass "tar -tzf 能列出附件包"
else
  fail "tar -tzf 失败"
fi
saw_dump=0
saw_restore=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  read_args "$f"
  [[ "${ARGS[0]:-}" == "compose" ]] || continue
  text=" ${ARGS[*]} "
  if [[ "$text" == *" exec "* && "$text" == *" -T "* && "$text" == *" postgres "* && "$text" == *" pg_dump "* ]]; then
    saw_dump=1
  fi
  if [[ "$text" == *" exec "* && "$text" == *" -T "* && "$text" == *" postgres "* && "$text" == *" pg_restore "* && "$text" == *" --list "* ]]; then
    saw_restore=1
  fi
done < <(invocations "$MOCK_DIR")
assert_eq "pg_dump 走 compose exec -T postgres" "1" "$saw_dump"
assert_eq "pg_restore --list 走 compose exec -T postgres" "1" "$saw_restore"

# 2. 只有 docker-compose.yml 时用这一份，不臆造 compose.prod.yml。
fx="$work/repo"
new_fixture "$fx" repo
MOCK_DIR="$work/mock2"
MOCK_BIN="$work/bin2"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='pgvector/pgvector:pg17'
MOCK_OK_IMAGES="$MOCK_IMAGE"
out="$work/out2"
status="$(run_backup "$fx" "$out")"
assert_ok "仓库默认 compose 备份成功" "$status"
repo_files="$(invocations "$MOCK_DIR" | while IFS= read -r f; do
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "compose" ]]; then
    f_args "$f" -f | paste -sd, -
    break
  fi
done)"
if [[ "$repo_files" == *"/docker-compose.yml" && "$repo_files" != *"compose.prod.yml"* ]]; then
  pass "只有 docker-compose.yml 时不追加 compose.prod.yml"
else
  fail "默认 compose 文件不对（$repo_files）"
fi

# 3. 缺镜像时退出，且不执行 docker run。
fx="$work/missing"
new_fixture "$fx" repo
MOCK_DIR="$work/mock3"
MOCK_BIN="$work/bin3"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='pgvector/pgvector:pg17'
MOCK_OK_IMAGES='nginx:alpine'
out="$work/out3"
status="$(run_backup "$fx" "$out")"
assert_fail "缺镜像时失败" "$status"
no_secret "缺镜像时不打印密钥" "$out/script.log"
if grep -q '不会拉取' "$out/script.log"; then
  pass "缺镜像时说明不会拉取"
else
  fail "缺镜像提示没有说明不会拉取"
fi
ran=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "run" || "${ARGS[0]:-}" == "pull" ]]; then
    ran=1
  fi
done < <(invocations "$MOCK_DIR")
assert_eq "缺镜像时没有 run 也没有 pull" "0" "$ran"
if find "$out" -name 'flower-*' -print -quit | grep -q .; then
  fail "缺镜像时留下了产物"
else
  pass "缺镜像时没有产物"
fi

# 4. compose 解析失败时不转发错误输出（里面可能有环境值）。
fx="$work/cfgfail"
new_fixture "$fx" repo
MOCK_DIR="$work/mock4"
MOCK_BIN="$work/bin4"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='pgvector/pgvector:pg17'
MOCK_OK_IMAGES="$MOCK_IMAGE"
MOCK_CONFIG_STATUS=1
out="$work/out4"
status="$(run_backup "$fx" "$out")"
assert_fail "compose 解析失败时退出" "$status"
no_secret "compose 错误输出不进日志" "$out/script.log"
if grep -q '无法从 compose 解析' "$out/script.log"; then
  pass "解析失败有明确提示"
else
  fail "解析失败提示不对"
fi
unset MOCK_CONFIG_STATUS

# 5. --tar-image 覆盖默认镜像。
fx="$work/override"
new_fixture "$fx" repo
MOCK_DIR="$work/mock5"
MOCK_BIN="$work/bin5"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='pgvector/pgvector:pg17'
MOCK_OK_IMAGES='postgres:17-alpine'
out="$work/out5"
status="$(run_backup "$fx" "$out" --tar-image postgres:17-alpine)"
assert_ok "指定 --tar-image 成功" "$status"
run_file="$(invocations "$MOCK_DIR" | while IFS= read -r f; do
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "run" ]]; then
    printf '%s' "$f"
    break
  fi
done)"
if [[ -z "$run_file" || ! -f "$run_file" ]]; then
  fail "指定 --tar-image 时没有 docker run"
else
  read_args "$run_file"
  assert_eq "--tar-image 被用于打包" "postgres:17-alpine" "$(run_image "${ARGS[@]}")"
fi

# 6. 显式 --file 覆盖自动检测。
fx="$work/files"
new_fixture "$fx" prod
printf 'services:\n  postgres:\n    image: nginx:alpine\n' >"$fx/custom.yml"
MOCK_DIR="$work/mock6"
MOCK_BIN="$work/bin6"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='nginx:alpine'
MOCK_OK_IMAGES='nginx:alpine'
out="$work/out6"
status="$(run_backup "$fx" "$out" --file "$fx/custom.yml")"
assert_ok "显式 --file 成功" "$status"
custom_files="$(invocations "$MOCK_DIR" | while IFS= read -r f; do
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "compose" ]]; then
    f_args "$f" -f | paste -sd, -
    break
  fi
done)"
if [[ "$custom_files" == *"/custom.yml" && "$custom_files" != *"compose.prod.yml"* ]]; then
  pass "--file 替换默认的 compose 列表"
else
  fail "--file 没有替换默认列表（$custom_files）"
fi

# 7. FLOWER_COMPOSE_FILES 优先于 COMPOSE_FILE，相对路径按仓库根解析。
fx="$work/envfiles"
new_fixture "$fx" prod
printf 'services:\n  postgres:\n    image: nginx:alpine\n' >"$fx/custom.yml"
MOCK_DIR="$work/mock7"
MOCK_BIN="$work/bin7"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='nginx:alpine'
MOCK_OK_IMAGES='nginx:alpine'
export FLOWER_COMPOSE_FILES="custom.yml"
export COMPOSE_FILE="compose.yml:compose.prod.yml"
out="$work/out7a"
status="$(run_backup "$fx" "$out")"
assert_ok "FLOWER_COMPOSE_FILES 备份成功" "$status"
env_files="$(invocations "$MOCK_DIR" | while IFS= read -r f; do
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "compose" ]]; then
    f_args "$f" -f | paste -sd, -
    break
  fi
done)"
if [[ "$env_files" == *"/custom.yml" && "$env_files" != *"compose.prod.yml"* ]]; then
  pass "FLOWER_COMPOSE_FILES 覆盖 COMPOSE_FILE"
else
  fail "FLOWER_COMPOSE_FILES 没有生效（$env_files）"
fi
unset FLOWER_COMPOSE_FILES COMPOSE_FILE

# 8. 打包失败时不留下未校验产物。
fx="$work/runfail"
new_fixture "$fx" repo
MOCK_DIR="$work/mock7"
MOCK_BIN="$work/bin7"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='pgvector/pgvector:pg17'
MOCK_OK_IMAGES="$MOCK_IMAGE"
MOCK_RUN_STATUS=1
out="$work/out7"
status="$(run_backup "$fx" "$out")"
assert_fail "打包失败时退出" "$status"
if find "$out" \( -name 'flower-*.dump' -o -name 'flower-storage-*.tgz' -o -name '*.sha256' \) -print -quit | grep -q .; then
  fail "打包失败仍留下产物"
else
  pass "打包失败不留未校验产物"
fi
unset MOCK_RUN_STATUS

# 8. compose 若给出裸 alpine，直接拒绝，不 run。
fx="$work/bare"
new_fixture "$fx" repo
MOCK_DIR="$work/mock8"
MOCK_BIN="$work/bin8"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='alpine:latest'
MOCK_OK_IMAGES='alpine:latest'
out="$work/out8"
status="$(run_backup "$fx" "$out")"
assert_fail "裸 alpine 被拒绝" "$status"
ran=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "run" || "${ARGS[0]:-}" == "pull" ]]; then
    ran=1
  fi
done < <(invocations "$MOCK_DIR")
assert_eq "拒绝裸 alpine 时没有 run 或 pull" "0" "$ran"

# 9. flower 容器还在时，附件卷用它实际挂载的名字。
fx="$work/vol"
new_fixture "$fx" repo
MOCK_DIR="$work/mock-vol"
MOCK_BIN="$work/bin-vol"
mkdir -p "$MOCK_DIR"
write_mock "$MOCK_BIN"
MOCK_IMAGE='pgvector/pgvector:pg17'
MOCK_OK_IMAGES="$MOCK_IMAGE"
MOCK_FLOWER_ID='abc123'
MOCK_VOLUME='custom_storage_name'
out="$work/out-vol"
status="$(run_backup "$fx" "$out")"
assert_ok "能读到容器挂载卷" "$status"
run_file="$(invocations "$MOCK_DIR" | while IFS= read -r f; do
  read_args "$f"
  if [[ "${ARGS[0]:-}" == "run" ]]; then
    printf '%s' "$f"
    break
  fi
done)"
read_args "$run_file"
vol=""
for ((i = 0; i < ${#ARGS[@]}; i++)); do
  if [[ "${ARGS[$i]}" == "-v" ]]; then
    vol="${ARGS[$((i + 1))]}"
  fi
done
assert_eq "使用容器上的附件卷" "custom_storage_name:/data:ro" "$vol"
unset MOCK_FLOWER_ID MOCK_VOLUME

# 10. --out 不能指向仓库内部。
inside="$work/inside-repo"
mkdir -p "$inside"
set +e
bash "$script" --out "$root" --project flower_prod >"$inside/log" 2>&1
status=$?
set -e
assert_fail "拒绝仓库内的 --out" "$status"

if [[ "$failures" -ne 0 ]]; then
  printf '失败 %s 项\n' "$failures" >&2
  exit 1
fi
printf '全部通过\n'
