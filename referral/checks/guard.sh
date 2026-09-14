#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"
source .ci/init.sh
ci_init_repo_root

if [[ "$(uname -s)" == "Linux" ]]; then
  ci_ensure_go
  ci_ensure_kustomize
else
  ci_require_commands go kustomize
fi

(
  cd "${repo_root}/referral"
  go test ./...
  go vet ./...
)

if [[ -n "${SOPS_AGE_KEY_FILE:-}" && -r "${SOPS_AGE_KEY_FILE}" ]]; then
  kustomize build "${repo_root}/argocd/services/referral/beijing-sandbox" \
    --enable-alpha-plugins \
    --enable-exec >/dev/null
else
  # Local contributors usually have only the public age recipient. CI and Argo
  # render the full KSOPS target with the private key.
  kustomize build "${repo_root}/referral/k8s/base" >/dev/null
fi
