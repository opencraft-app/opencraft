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
  cd referral
  go test ./...
  go vet ./...
)

if [[ -n "${SOPS_AGE_KEY_FILE:-}" && -r "${SOPS_AGE_KEY_FILE}" ]]; then
  kustomize build argocd/services/referral/beijing-sandbox \
    --enable-alpha-plugins \
    --enable-exec >/dev/null
else
  # The MR guard can validate source manifests without decrypting runtime
  # credentials. Full KSOPS rendering remains part of the GitOps release gate.
  kustomize build referral/k8s/base >/dev/null
fi

echo "referral guard: all checks passed"
