#!/usr/bin/env bash
# 在线备份 Flower 的数据库和附件卷。只读，不停止服务，不删除任何东西。
# 不打印环境变量、连接串或密钥。附件打包只用本机已有镜像，不拉取、不构建。
# 产物是 600。umask 077 让脚本自己新建的目录是 700，不改已有的 --out 目录。
#
# 退出码：
#   0  成功。卷存在但没有条目时也是 0，并另打印一行 WARN。
#   1  参数或 --out 不合法。
#   2  compose 文件或镜像名无法确定。
#   3  本机没有打包镜像，或拒绝裸 alpine。
#   4  附件卷不存在。
#   5  数据库备份失败。
#   6  附件打包失败。
#   7  校验失败（pg_restore --list、tar -tzf，或写不出 sha256）。
set -euo pipefail
umask 077

repo="$(cd "$(dirname "$0")/.." && pwd)"
out=""
project="${COMPOSE_PROJECT_NAME:-}"
tar_image="${FLOWER_BACKUP_TAR_IMAGE:-}"
compose_files=()
files_from_args=0
finished=0
dump=""
tgz=""

usage() {
  echo "用法：scripts/backup-flower.sh --out <目录> --project <项目名> [--file <compose 文件>]... [--tar-image <镜像>]" >&2
}

die() {
  local code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "缺少 --out <目录>" >&2
        exit 1
      fi
      out="$2"
      shift 2
      ;;
    --project)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "缺少 --project <项目名>" >&2
        exit 1
      fi
      project="$2"
      shift 2
      ;;
    --file)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "缺少 --file <路径>" >&2
        exit 1
      fi
      compose_files+=("$2")
      files_from_args=1
      shift 2
      ;;
    --tar-image)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "缺少 --tar-image <镜像>" >&2
        exit 1
      fi
      tar_image="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$out" ]]; then
  echo "缺少 --out <目录>" >&2
  exit 1
fi
if [[ ! -d "$out" ]]; then
  echo "--out 目录不存在：$out" >&2
  exit 1
fi
out_real="$(cd "$out" && pwd)"
case "$out_real" in
  "$repo"|"$repo"/*)
    echo "拒绝：--out 不能指向仓库目录内部" >&2
    exit 1
    ;;
esac
if [[ -z "$project" ]]; then
  echo "缺少 --project，且没有 COMPOSE_PROJECT_NAME" >&2
  exit 1
fi

# 1. 重复的 --file
# 2. FLOWER_COMPOSE_FILES（冒号分隔）
# 3. COMPOSE_FILE（与 docker compose 相同）
# 4. 仓库根同时有 compose.yml 与 compose.prod.yml
# 5. 仓库根同时有 docker-compose.yml 与 compose.prod.yml（生产 /opt/flower）
# 6. 只有 docker-compose.yml
if [[ "$files_from_args" -eq 0 && -n "${FLOWER_COMPOSE_FILES:-}" ]]; then
  raw="${FLOWER_COMPOSE_FILES}"
  while [[ "$raw" == *:* ]]; do
    compose_files+=("${raw%%:*}")
    raw="${raw#*:}"
  done
  compose_files+=("$raw")
  files_from_args=1
fi
if [[ "$files_from_args" -eq 0 && -n "${COMPOSE_FILE:-}" ]]; then
  raw="${COMPOSE_FILE}"
  while [[ "$raw" == *:* ]]; do
    compose_files+=("${raw%%:*}")
    raw="${raw#*:}"
  done
  compose_files+=("$raw")
  files_from_args=1
fi
if [[ "$files_from_args" -eq 0 ]]; then
  if [[ -f "$repo/compose.yml" && -f "$repo/compose.prod.yml" ]]; then
    compose_files=("$repo/compose.yml" "$repo/compose.prod.yml")
  elif [[ -f "$repo/docker-compose.yml" && -f "$repo/compose.prod.yml" ]]; then
    compose_files=("$repo/docker-compose.yml" "$repo/compose.prod.yml")
  elif [[ -f "$repo/docker-compose.yml" ]]; then
    compose_files=("$repo/docker-compose.yml")
  else
    die 2 "找不到 compose 文件。生产是 docker-compose.yml 加 compose.prod.yml，可用 --file 指定。"
  fi
fi

resolved=()
for f in "${compose_files[@]}"; do
  [[ -z "$f" ]] && continue
  if [[ "$f" != /* ]]; then
    if [[ -f "$repo/$f" ]]; then
      f="$repo/$f"
    elif [[ -f "$f" ]]; then
      f="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"
    fi
  fi
  if [[ ! -f "$f" ]]; then
    die 2 "compose 文件不存在：$f"
  fi
  resolved+=("$f")
done
if [[ "${#resolved[@]}" -eq 0 ]]; then
  die 2 "没有可用的 compose 文件。"
fi

compose=(docker compose --project-directory "$repo" -p "$project")
for f in "${resolved[@]}"; do
  compose+=(-f "$f")
done

if [[ -z "$tar_image" ]]; then
  # 只要镜像名。错误输出里可能有插值后的环境值，直接丢掉。
  if ! image_raw="$("${compose[@]}" config --images postgres 2>/dev/null)"; then
    die 2 "无法从 compose 解析 postgres 服务的镜像，已停止。可用 --tar-image 指定本机已有镜像。"
  fi
  tar_image="${image_raw%%$'\n'*}"
  tar_image="${tar_image%$'\r'}"
fi

# 必须像镜像引用（含标签或仓库路径）。不合规则不把原文打进日志。
if [[ -z "$tar_image" || ! "$tar_image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ || "$tar_image" != *[:/]* ]]; then
  die 2 "解析到的镜像名不合法，已停止。可用 --tar-image 指定本机已有镜像。"
fi
case "$tar_image" in
  alpine|alpine:latest)
    die 3 "拒绝使用裸 alpine 镜像，已停止。备份不会拉取镜像。"
    ;;
esac

if ! docker image inspect "$tar_image" >/dev/null 2>&1; then
  die 3 "本机没有镜像 ${tar_image}，已停止。备份不会拉取或构建镜像。"
fi

cleanup() {
  if [[ "$finished" -ne 1 ]]; then
    if [[ -n "$dump" ]]; then
      rm -f "$dump" "${dump}.sha256"
    fi
    if [[ -n "$tgz" ]]; then
      rm -f "$tgz" "${tgz}.sha256"
    fi
  fi
}
trap cleanup EXIT

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$out_real/flower-${stamp}.dump"
tgz="$out_real/flower-storage-${stamp}.tgz"
# 默认卷名是「项目名_flower_storage」。flower 容器还在（含已停止）时，用它实际挂上的卷。
volume="${project}_flower_storage"
flower_raw="$("${compose[@]}" ps -aq flower 2>/dev/null || true)"
flower_id="${flower_raw%%$'\n'*}"
flower_id="${flower_id%$'\r'}"
if [[ -n "$flower_id" ]]; then
  mounted="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data/storage"}}{{.Name}}{{end}}{{end}}' "$flower_id" 2>/dev/null || true)"
  mounted="${mounted%%$'\n'*}"
  if [[ "$mounted" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    volume="$mounted"
  fi
fi

# docker run -v 会在卷不存在时把空卷建出来。先查，没有就停，避免空包被当成成功。
if ! docker volume inspect "$volume" >/dev/null 2>&1; then
  die 4 "附件卷不存在：${volume}。已停止，没有备份。"
fi

if ! "${compose[@]}" exec -T postgres pg_dump -U flower_admin -d flower -Fc >"$dump" 2>/dev/null; then
  die 5 "数据库备份失败。pg_dump 没有完成，已停止。"
fi
if [[ ! -s "$dump" ]]; then
  die 5 "数据库备份失败。dump 是空的，已停止。"
fi

# --entrypoint tar：不走 postgres 镜像的入口脚本。--pull never：本机没有镜像就失败，不拉取。
if ! docker run --rm --pull never --network none --entrypoint tar \
  -v "${volume}:/data:ro" \
  "$tar_image" \
  -C /data -czf - . >"$tgz" 2>/dev/null; then
  die 6 "附件打包失败。打包没有完成，已停止。"
fi
if [[ ! -s "$tgz" ]]; then
  die 6 "附件打包失败。附件包是空的，已停止。"
fi

if ! "${compose[@]}" exec -T postgres pg_restore --list <"$dump" >/dev/null 2>&1; then
  die 7 "数据库备份校验失败。pg_restore 无法读取这份 dump，已停止。"
fi
if ! listing="$(tar -tzf "$tgz" 2>/dev/null)"; then
  die 7 "附件包校验失败。tar 无法读取这个包，已停止。"
fi
entry_count=0
while IFS= read -r entry || [[ -n "${entry:-}" ]]; do
  case "$entry" in
    ''|'.'|'./') ;;
    *) entry_count=$((entry_count + 1)) ;;
  esac
done <<<"$listing"
if ! (
  cd "$out_real" &&
    sha256sum "$(basename "$dump")" >"$(basename "$dump").sha256" &&
    sha256sum "$(basename "$tgz")" >"$(basename "$tgz").sha256"
); then
  die 7 "校验和没有写成，已停止。"
fi
chmod 600 "$dump" "$tgz" "${dump}.sha256" "${tgz}.sha256"
finished=1
echo "备份完成：$dump"
echo "备份完成：$tgz"
echo "附件镜像：$tar_image"
echo "附件条目数：${entry_count}"
if [[ "$entry_count" -eq 0 ]]; then
  echo "WARN：附件卷存在，但里面没有条目。" >&2
fi
