#!/bin/sh
set -eu

assets=${1:-}
binary=${2:-}

if [ ! -d "$assets" ] || [ ! -f "$assets/index.html" ]; then
  echo "Web 发布扫描失败：静态目录或首页不存在" >&2
  exit 2
fi
if [ ! -f "$binary" ]; then
  echo "Web 发布扫描失败：最终二进制不存在" >&2
  exit 2
fi
if ! command -v rg >/dev/null 2>&1; then
  echo "Web 发布扫描失败：缺少 rg" >&2
  exit 2
fi

if [ -n "$(find "$assets" -type l -print -quit)" ]; then
  echo "Web 发布扫描失败：静态目录包含符号链接" >&2
  exit 1
fi
if [ -n "$(find "$assets" -type f -name '*.map' -print -quit)" ]; then
  echo "Web 发布扫描失败：静态目录包含 source map" >&2
  exit 1
fi

if rg -a -l \
  -e 'https?://127([.][0-9]+){1,3}:18080' \
  -e 'https?://localhost:18080' \
  "$assets" "$binary" >/dev/null; then
  echo "Web 发布扫描失败：发现固定开发地址" >&2
  exit 1
fi

if rg -a -l \
  -e 'AKID[A-Za-z0-9]{20,}' \
  -e 'Bearer[[:space:]]+[A-Za-z0-9_-]{6,}[.][A-Za-z0-9_-]{6,}[.][A-Za-z0-9_-]{6,}' \
  -e 'eyJ[A-Za-z0-9_-]{6,}[.][A-Za-z0-9_-]{6,}[.][A-Za-z0-9_-]{6,}' \
  -e 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' \
  -e "(SecretKey|secret_key)[^[:cntrl:]]{0,24}[=:][[:space:]]*[\"']?[A-Za-z0-9/+_-]{24,}" \
  "$assets" "$binary" >/dev/null; then
  echo "Web 发布扫描失败：发现疑似真实凭据" >&2
  exit 1
fi

echo "Web 发布扫描通过"
