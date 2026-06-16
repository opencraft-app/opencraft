#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_SITE_DIR="${MONO2_DOCS_ROOT:-$ROOT_DIR/docs-site}"

export MONO2_DOCS_ROOT="$DOCS_SITE_DIR"

echo "[makedocs] root=$ROOT_DIR"
echo "[makedocs] docs_site=$DOCS_SITE_DIR"

while IFS= read -r script; do
  component_dir="$(dirname "$script")"
  echo "[makedocs] component=${component_dir#$ROOT_DIR/}"
  (
    cd "$component_dir"
    bash ./makedocs.sh
  )
done < <(
  find "$ROOT_DIR" \
    -path "$ROOT_DIR/.git" -prune -o \
    -path "$ROOT_DIR/.worktrees" -prune -o \
    -path "$DOCS_SITE_DIR" -prune -o \
    -path "*/node_modules" -prune -o \
    -type f -name makedocs.sh \
    ! -path "$ROOT_DIR/makedocs.sh" \
    -print | sort
)

if [ -f "$DOCS_SITE_DIR/makedocs.sh" ]; then
  echo "[makedocs] site=docs-site"
  (
    cd "$DOCS_SITE_DIR"
    bash ./makedocs.sh
  )
fi
