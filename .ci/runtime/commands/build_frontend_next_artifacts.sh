#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"
source .ci/init.sh
ci_init_repo_root
ci_require_commands bash git python3 curl tar xz flock

for required_name in REGISTRY_USERNAME REGISTRY_PASSWORD FRONTEND_ARTIFACT_MATRIX FRONTEND_ARTIFACT_REPOSITORY; do
  required_value="${!required_name:-}"
  if [[ -z "$required_value" || "$required_value" == *'${{'* ]]; then
    echo "frontend-next requires injected ${required_name}" >&2
    exit 1
  fi
done
unset required_value

FRONTEND_ARTIFACT_SOURCE_SHA="$(git rev-parse HEAD)"
if [[ ! "$FRONTEND_ARTIFACT_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "frontend-next requires an exact checkout commit" >&2
  exit 1
fi
if [[ -n "${FRONTEND_NEXT_EXPECTED_SHA:-}" && "${FRONTEND_NEXT_EXPECTED_SHA}" != "$FRONTEND_ARTIFACT_SOURCE_SHA" ]]; then
  echo "frontend-next checkout does not match the selected pipeline commit" >&2
  exit 1
fi
export FRONTEND_ARTIFACT_SOURCE_SHA
export FRONTEND_ARTIFACT_MODE=required
export FRONTEND_ARTIFACT_EXISTING_POLICY=reuse

echo "frontend-next source sha: ${FRONTEND_ARTIFACT_SOURCE_SHA}"
echo "frontend-next artifact matrix: ${FRONTEND_ARTIFACT_MATRIX}"
echo "frontend-next builds and verifies artifacts; Pages release is a separate pipeline"

ci_ensure_oras
ci_ensure_node
ci_ensure_pnpm
"$NODE_BIN" --version
"$NPM_BIN" --version
"$PNPM_BIN" --version

cd "$REPO_ROOT/opencraft"
"$NPM_BIN" ci
OPENCRAFT_BUILD_ID="embedded-${FRONTEND_ARTIFACT_SOURCE_SHA:0:12}" \
  OPENCRAFT_SOURCE_REVISION="$FRONTEND_ARTIFACT_SOURCE_SHA" \
  "$NPM_BIN" run build:embedded-workbench:release
export OPENCRAFT_EMBED_DIST_DIR="$REPO_ROOT/opencraft/apps/workbench-web/dist-embedded-workbench"
test -f "$OPENCRAFT_EMBED_DIST_DIR/embedded-workbench.js"
test -f "$OPENCRAFT_EMBED_DIST_DIR/.vite/manifest.json"

cd "$REPO_ROOT/frontend"
"$PNPM_BIN" install --frozen-lockfile
"$PNPM_BIN" build:release-artifacts
