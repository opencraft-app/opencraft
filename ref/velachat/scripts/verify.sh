#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

(cd "$repo_root/backend" && go test ./...)
(cd "$repo_root/agent" && go test ./...)
(cd "$repo_root/web" && bun install --frozen-lockfile && bun run verify)

"$repo_root/backend/scripts/scan-secrets.sh" "$repo_root/backend"

echo "Velachat verification passed"
