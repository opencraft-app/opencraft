#!/usr/bin/env bash
#
# Apply mono repo AppProjects and root-app boundary manifests to the HK Argo control plane.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-${REPO_ROOT}/hk-cls-mp5b5r0y-extranet.kubeconfig}"
NAMESPACE="argocd"

PROJECTS=(
  "${REPO_ROOT}/argocd/projects/beijing-argocd-runtime.yaml"
  "${REPO_ROOT}/argocd/projects/beijing-root.yaml"
  "${REPO_ROOT}/argocd/projects/beijing-sandbox.yaml"
  "${REPO_ROOT}/argocd/projects/shprod-admin-gateway.yaml"
  "${REPO_ROOT}/argocd/projects/shprod-root.yaml"
  "${REPO_ROOT}/argocd/projects/shprod.yaml"
  "${REPO_ROOT}/argocd/projects/shprod-subscription.yaml"
)

ROOT_APPS=(
  "${REPO_ROOT}/argocd/root/beijing-sandbox.yaml"
  "${REPO_ROOT}/argocd/root/shprod.yaml"
)

for cmd in kubectl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required tool: $cmd" >&2
    exit 1
  fi
done

if [[ ! -f "$KUBECONFIG_PATH" ]]; then
  echo "missing kubeconfig: $KUBECONFIG_PATH" >&2
  exit 1
fi

export KUBECONFIG="$KUBECONFIG_PATH"
kubectl -n "$NAMESPACE" get cm argocd-cm >/dev/null

for file in "${PROJECTS[@]}" "${ROOT_APPS[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "missing manifest: $file" >&2
    exit 1
  fi
done

for file in "${PROJECTS[@]}"; do
  kubectl apply -f "$file"
done

for file in "${ROOT_APPS[@]}"; do
  kubectl apply -f "$file"
done

echo "applied mono argocd projects and root apps"
