#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

(
  cd "${repo_root}/referral"
  go test ./...
  go vet ./...
)

kubectl kustomize "${repo_root}/argocd/services/referral/beijing-sandbox" >/dev/null
