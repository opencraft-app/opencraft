#!/usr/bin/env bash
set -Eeuo pipefail
ci_repository_root="$(git rev-parse --show-toplevel)"
cd "$ci_repository_root"
ci_node_version="$(tr -d '[:space:]' < .nvmrc)"
if [[ "$(node --version)" != "v${ci_node_version}" ]]; then
  echo "CI requires Node ${ci_node_version}" >&2
  exit 1
fi
for ci_tool in git python3 make g++ redis-server; do
  command -v "$ci_tool" >/dev/null || { echo "Missing CI dependency: $ci_tool" >&2; exit 1; }
done
export CI=true
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
mkdir -p .local/ci
ci_snapshot="$(mktemp .local/ci/verify.XXXXXXXX.json)"
trap 'rm -f -- "$ci_snapshot"' EXIT
node scripts/ci/source-identity.mjs > "$ci_snapshot"
npm run ci:test:delivery
# Explicit full CI entry; isolated migration trials run ci:test:delivery without installing.
npm ci --no-audit --no-fund
for workspace in @opencraft/account-pool-host @opencraft/codex-core @join/opencraft-distribution; do
  npm run typecheck --workspace "$workspace"
done
npm run test:codex-anthropic
npm run test:codex-core
npm run join:test
npm run join:test:relay
node scripts/ci/source-identity.mjs --check "$ci_snapshot"
