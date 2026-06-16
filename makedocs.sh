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

FRAGMENT_ROOT="$DOCS_SITE_DIR/generated/docs-index"
FRAGMENT_BUNDLE="$DOCS_SITE_DIR/generated/docs-index.fragments.json"
mkdir -p "$(dirname "$FRAGMENT_BUNDLE")"
node - "$FRAGMENT_ROOT" "$FRAGMENT_BUNDLE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [fragmentRoot, outFile] = process.argv.slice(2);
const fragments = [];
if (fs.existsSync(fragmentRoot)) {
  for (const name of fs.readdirSync(fragmentRoot).sort()) {
    if (!name.endsWith('.json')) continue;
    const fullPath = path.join(fragmentRoot, name);
    fragments.push(JSON.parse(fs.readFileSync(fullPath, 'utf8')));
  }
}

const bundle = {
  object: 'mono2.docs.fragments',
  version: 'v1',
  generated_from: 'makedocs.sh',
  fragments,
};

fs.writeFileSync(outFile + '.tmp', `${JSON.stringify(bundle, null, 2)}\n`);
fs.renameSync(outFile + '.tmp', outFile);
NODE
echo "[makedocs] wrote ${FRAGMENT_BUNDLE#$ROOT_DIR/}"

if [ -f "$DOCS_SITE_DIR/makedocs.sh" ]; then
  echo "[makedocs] site=docs-site"
  (
    cd "$DOCS_SITE_DIR"
    bash ./makedocs.sh
  )
fi
