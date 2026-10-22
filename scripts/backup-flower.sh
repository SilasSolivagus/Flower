#!/usr/bin/env bash
# 在线备份 Flower 的数据库和附件卷。只读，不停止服务，不删除任何东西。
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
out=""
project="${COMPOSE_PROJECT_NAME:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      out="${2:-}"
      shift 2
      ;;
    --project)
      project="${2:-}"
      shift 2
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

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$out_real/flower-${stamp}.dump"
tgz="$out_real/flower-storage-${stamp}.tgz"
compose=(docker compose -p "$project" --project-directory "$repo")

"${compose[@]}" exec -T postgres pg_dump -U flower_admin -d flower -Fc >"$dump"
docker run --rm -v "${project}_flower_storage:/data:ro" alpine tar -C /data -czf - . >"$tgz"

if [[ ! -s "$dump" ]]; then
  echo "dump 为空" >&2
  exit 1
fi
if [[ ! -s "$tgz" ]]; then
  echo "附件包为空" >&2
  exit 1
fi

"${compose[@]}" exec -T postgres pg_restore --list <"$dump" >/dev/null
tar -tzf "$tgz" >/dev/null
sha256sum "$dump" >"${dump}.sha256"
sha256sum "$tgz" >"${tgz}.sha256"
echo "备份完成：$dump"
echo "备份完成：$tgz"
