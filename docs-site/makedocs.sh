#!/usr/bin/env bash
set -euo pipefail

DOCS_SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DOCS_SITE_DIR"

if [ ! -d node_modules ]; then
  npm ci
fi

npm run build
