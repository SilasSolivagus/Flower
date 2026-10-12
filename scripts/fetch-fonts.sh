#!/usr/bin/env sh
# 下载看板图片用的思源黑体（Noto Sans SC，SIL OFL 1.1）常规与粗体并校验 sha256。
# 用法：./scripts/fetch-fonts.sh [目标目录]，默认 packages/core/assets/fonts（已忽略，不提交）。
set -eu
cd "$(dirname "$0")/.."

DIR="${1:-packages/core/assets/fonts}"
# 固定到上游的一个提交，避免上游更新字体后校验失败
BASE=https://github.com/notofonts/noto-cjk/raw/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/SC
mkdir -p "$DIR"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() {
  name=$1
  want=$2
  file="$DIR/$name"
  if [ -f "$file" ] && [ "$(sha256 "$file")" = "$want" ]; then
    echo "$name 已存在，校验通过"
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$file.part" "$BASE/$name"
  else
    wget -q -O "$file.part" "$BASE/$name"
  fi
  got=$(sha256 "$file.part")
  if [ "$got" != "$want" ]; then
    rm -f "$file.part"
    echo "$name 校验失败：期望 $want，实际 $got" >&2
    exit 1
  fi
  mv "$file.part" "$file"
  echo "$name 下载完成，校验通过"
}

fetch NotoSansSC-Regular.otf faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9
fetch NotoSansSC-Bold.otf c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0
