#!/usr/bin/env bash
set -euo pipefail

COMMAND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_DIR="$(cd "$COMMAND_DIR/../.." && pwd)"

FRONTEND_EDGEONE_CI_BRANCH="${FRONTEND_EDGEONE_CI_BRANCH:?FRONTEND_EDGEONE_CI_BRANCH is required}"
FRONTEND_EDGEONE_CI_SHA="${FRONTEND_EDGEONE_CI_SHA:-}"
FRONTEND_EDGEONE_COMBO="${FRONTEND_EDGEONE_COMBO:?FRONTEND_EDGEONE_COMBO is required}"
FRONTEND_EDGEONE_DISPLAY_NAME="${FRONTEND_EDGEONE_DISPLAY_NAME:-$FRONTEND_EDGEONE_COMBO}"
FRONTEND_ARTIFACT_REPOSITORY="${FRONTEND_ARTIFACT_REPOSITORY:?FRONTEND_ARTIFACT_REPOSITORY is required}"

if [[ "$FRONTEND_EDGEONE_CI_BRANCH" != "master" ]]; then
  echo "EdgeOne production release only allows master branch; got ${FRONTEND_EDGEONE_CI_BRANCH}" >&2
  exit 1
fi

case "$FRONTEND_EDGEONE_COMBO" in
  eo:cn-lightvela-prod-next)
    export EDGEONE_API_TOKEN_FILE=/etc/lightclaw-ci/edgeone_lightvela_prod_token
    export EDGEONE_API_TOKEN="${EDGEONE_LIGHTVELA_PROD_TOKEN:-}"
    ;;
  eo:global-lightvela-intl-prod-next)
    export EDGEONE_API_TOKEN_FILE=/etc/lightclaw-ci/edgeone_lightvela_intl_prod_token
    export EDGEONE_API_TOKEN="${EDGEONE_LIGHTVELA_INTL_PROD_TOKEN:-}"
    ;;
  *)
    echo "unsupported EdgeOne Next artifact combo: ${FRONTEND_EDGEONE_COMBO}" >&2
    exit 1
    ;;
esac

ARTIFACT_REF="${FRONTEND_EDGEONE_ARTIFACT_REF:-}"
ARTIFACT_SOURCE_SHA="${FRONTEND_EDGEONE_ARTIFACT_SOURCE_SHA:-}"
if [[ -z "$ARTIFACT_REF" && -z "$ARTIFACT_SOURCE_SHA" ]]; then
  ARTIFACT_SOURCE_SHA="$FRONTEND_EDGEONE_CI_SHA"
fi
if [[ -z "$ARTIFACT_REF" && -z "$ARTIFACT_SOURCE_SHA" ]]; then
  echo "FRONTEND_EDGEONE_ARTIFACT_SOURCE_SHA is empty and ci.sha is unavailable" >&2
  exit 1
fi

echo "============================================================"
echo "frontend 发布决策：进入 EdgeOne 正式 artifact 发布流程"
echo "目标站点：${FRONTEND_EDGEONE_DISPLAY_NAME}"
echo "发布 combo：${FRONTEND_EDGEONE_COMBO}"
echo "artifact 仓库：${FRONTEND_ARTIFACT_REPOSITORY}"
echo "artifact source sha：${ARTIFACT_SOURCE_SHA}"
echo "artifact ref override：${ARTIFACT_REF}"
echo "============================================================"

source "$CI_DIR/init.sh"
ci_init_repo_root
ci_set_registry_credentials shprod
ci_ensure_oras
ci_ensure_node
ci_ensure_pnpm

"$NODE_BIN" --version
"$NPM_BIN" --version

cd "$REPO_ROOT/frontend"
rm -rf node_modules
"$PNPM_BIN" --version
"$PNPM_BIN" install --frozen-lockfile

export FRONTEND_RELEASE_MATRIX="$FRONTEND_EDGEONE_COMBO"
export FRONTEND_ARTIFACT_SOURCE_SHA="$ARTIFACT_SOURCE_SHA"
export FRONTEND_ARTIFACT_REF="$ARTIFACT_REF"

echo "============================================================"
echo "发布 frontend EdgeOne combo：${FRONTEND_EDGEONE_COMBO}"
echo "FRONTEND_RELEASE_MATRIX=${FRONTEND_RELEASE_MATRIX}"
echo "FRONTEND_ARTIFACT_SOURCE_SHA=${FRONTEND_ARTIFACT_SOURCE_SHA}"
echo "FRONTEND_ARTIFACT_REF=${FRONTEND_ARTIFACT_REF}"
echo "============================================================"
ci_load_edgeone_credentials
"$PNPM_BIN" release:eo:artifact
