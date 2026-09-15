#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"
source .ci/init.sh
ci_init_repo_root
if [[ "$(uname -s)" == "Linux" ]]; then
  ci_ensure_go
  ci_ensure_kustomize
else
  ci_require_commands go kustomize
fi
export GOWORK=off

(
  cd collaboration
  go test ./...
  go vet ./...
  ./scripts/check-migration-release.sh
  ./scripts/check-openapi-compatibility.sh
  go run ./cmd/migrationgen --dialect tdsql --verify
)
kustomize build collaboration/k8s/base >/dev/null
echo "collaboration guard: all checks passed"
