#!/usr/bin/env bash
#
# Bootstrap the sops-age secret required by Argo CD repo-server ksops support.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_FILE="${KEY_FILE:-${REPO_ROOT}/.secret/argocd-beijing-sandbox.agekey}"
NAMESPACE="${NAMESPACE:-argocd}"
SECRET_NAME="${SECRET_NAME:-sops-age}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-${KUBECONFIG:-}}"

for cmd in kubectl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required tool: $cmd" >&2
    exit 1
  fi
done

if [[ -z "${KUBECONFIG_PATH}" ]]; then
  echo "missing kubeconfig: set KUBECONFIG_PATH or KUBECONFIG to the Argo control-plane kubeconfig" >&2
  exit 1
fi

if [[ ! -f "${KUBECONFIG_PATH}" ]]; then
  echo "missing kubeconfig file: ${KUBECONFIG_PATH}" >&2
  exit 1
fi

if [[ ! -f "${KEY_FILE}" ]]; then
  echo "missing age key file: ${KEY_FILE}" >&2
  exit 1
fi

export KUBECONFIG="${KUBECONFIG_PATH}"

kubectl -n "${NAMESPACE}" create secret generic "${SECRET_NAME}" \
  --from-file=keys.txt="${KEY_FILE}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "${NAMESPACE}" get secret "${SECRET_NAME}" >/dev/null

echo "applied ${SECRET_NAME} in namespace ${NAMESPACE}"
