#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"
source .ci/init.sh
ci_init_repo_root
if [[ "$(uname -s)" == Linux ]]; then
  ci_ensure_go
else
  ci_require_commands go
fi
export GOWORK=off
export GOENV=off
export GOFLAGS=
cd vela-computer
go test -p 2 ./...
go vet ./...
CGO_ENABLED=1 go test -race -p 2 ./internal/vela/... ./internal/runtimeactor/... ./internal/agentcli/...
echo "vela-computer guard: all checks passed"
