#!/bin/sh
set -eu

scan_root=${1:-"$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"}

if ! command -v rg >/dev/null 2>&1; then
  echo "凭证扫描失败：缺少 rg" >&2
  exit 2
fi

matches=$(
  rg -n --hidden \
    --glob '!.git/**' \
    --glob '!**/node_modules/**' \
    --glob '!go.sum' \
    --glob '!*.db' \
    --glob '!*.db-*' \
    --glob '!task_plan.md' \
    --glob '!progress.md' \
    --glob '!findings.md' \
    -e 'AKID[A-Za-z0-9]{20,}' \
    -e 'Bearer[[:space:]]+[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}' \
    -e 'eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}' \
    -e 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' \
    -e '(SecretKey|secret_key)[^[:cntrl:]]{0,24}[=:][[:space:]]*["'\'']?[A-Za-z0-9/+_-]{24,}' \
    "$scan_root" || true
)

if [ -n "$matches" ]; then
  echo "凭证扫描失败：发现疑似真实凭证" >&2
  echo "$matches" >&2
  exit 1
fi

echo "凭证扫描通过"
