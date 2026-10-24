#!/usr/bin/env bash
# 在线备份 Flower 的数据库和附件卷。只读，不停止服务，不删除任何东西。
# 不打印环境变量、连接串或密钥。附件打包只用本机已有镜像，不拉取、不构建。
set -euo pipefail

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
# 5. 只有 docker-compose.yml
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
  elif [[ -f "$repo/docker-compose.yml" ]]; then
    compose_files=("$repo/docker-compose.yml")
  else
    echo "找不到 compose 文件。生产默认是 compose.yml 加 compose.prod.yml，可用 --file 指定。" >&2
    exit 1
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
    echo "compose 文件不存在：$f" >&2
    exit 1
  fi
  resolved+=("$f")
done
if [[ "${#resolved[@]}" -eq 0 ]]; then
  echo "没有可用的 compose 文件。" >&2
  exit 1
fi

compose=(docker compose --project-directory "$repo" -p "$project")
for f in "${resolved[@]}"; do
  compose+=(-f "$f")
done

if [[ -z "$tar_image" ]]; then
  # 只要镜像名。错误输出里可能有插值后的环境值，直接丢掉。
  if ! image_raw="$("${compose[@]}" config --images postgres 2>/dev/null)"; then
    echo "无法从 compose 解析 postgres 服务的镜像，已停止。可用 --tar-image 指定本机已有镜像。" >&2
    exit 1
  fi
  tar_image="${image_raw%%$'\n'*}"
  tar_image="${tar_image%$'\r'}"
fi

# 必须像镜像引用（含标签或仓库路径）。不合规则不把原文打进日志。
if [[ -z "$tar_image" || ! "$tar_image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ || "$tar_image" != *[:/]* ]]; then
  echo "解析到的镜像名不合法，已停止。可用 --tar-image 指定本机已有镜像。" >&2
  exit 1
fi
case "$tar_image" in
  alpine|alpine:latest)
    echo "拒绝使用裸 alpine 镜像，已停止。备份不会拉取镜像。" >&2
    exit 1
    ;;
esac

if ! docker image inspect "$tar_image" >/dev/null 2>&1; then
  echo "本机没有镜像 ${tar_image}，已停止。备份不会拉取或构建镜像。" >&2
  exit 1
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

"${compose[@]}" exec -T postgres pg_dump -U flower_admin -d flower -Fc >"$dump"
if [[ ! -s "$dump" ]]; then
  echo "dump 为空" >&2
  exit 1
fi

# --entrypoint tar：不走 postgres 镜像的入口脚本。--pull never：本机没有镜像就失败，不拉取。
docker run --rm --pull never --network none --entrypoint tar \
  -v "${volume}:/data:ro" \
  "$tar_image" \
  -C /data -czf - . >"$tgz"
if [[ ! -s "$tgz" ]]; then
  echo "附件包为空" >&2
  exit 1
fi

"${compose[@]}" exec -T postgres pg_restore --list <"$dump" >/dev/null
tar -tzf "$tgz" >/dev/null
(
  cd "$out_real" &&
    sha256sum "$(basename "$dump")" >"$(basename "$dump").sha256" &&
    sha256sum "$(basename "$tgz")" >"$(basename "$tgz").sha256"
)
finished=1
echo "备份完成：$dump"
echo "备份完成：$tgz"
echo "附件镜像：$tar_image"
