#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${FDB_KUBE_CONTEXT:?set FDB_KUBE_CONTEXT to the explicit TKE context}"
operator_mode=${FDB_OPERATOR_MODE:-qualification}
cell_name=${FDB_CELL_NAME:-actor-bj-k01}
case "$operator_mode" in
  qualification | production) ;;
  *)
    echo "FDB_OPERATOR_MODE must be qualification or production" >&2
    exit 1
    ;;
esac
case "$cell_name" in
  *[!a-z0-9-]* | '' | -* | *-)
    echo "FDB_CELL_NAME must be a lowercase DNS label" >&2
    exit 1
    ;;
esac

server_version=$(kubectl --context "$FDB_KUBE_CONTEXT" get --raw /version | sed -n 's/.*"gitVersion"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p')
server_major=${server_version%%.*}
server_rest=${server_version#*.}
server_minor=${server_rest%%.*}
server_minor=$(printf '%s' "$server_minor" | sed 's/[^0-9].*$//')
if [ -z "$server_version" ] || [ -z "$server_major" ] || [ -z "$server_minor" ] || \
  [ "$server_major" -lt 1 ] || { [ "$server_major" -eq 1 ] && [ "$server_minor" -lt 19 ]; }; then
  echo "FoundationDB Operator v2.34.0 requires Kubernetes >=1.19; observed server=${server_version:-unknown}" >&2
  exit 1
fi

task_tmp=$(mktemp -d /data/tmp/actor-fdb-operator.XXXXXX)
trap 'rm -r -- "$task_tmp"' EXIT HUP INT TERM
crd_dir=$script_dir/vendor/crds

verify_crd() {
  task_name=$1
  task_sha=$2
  task_path=$crd_dir/$task_name
  if [ ! -f "$task_path" ]; then
    echo "vendored FoundationDB Operator CRD is missing: $task_name" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    task_actual=$(sha256sum "$task_path" | sed 's/[[:space:]].*$//')
  else
    task_actual=$(shasum -a 256 "$task_path" | sed 's/[[:space:]].*$//')
  fi
  if [ "$task_actual" != "$task_sha" ]; then
    echo "checksum mismatch for $task_name: expected $task_sha, got $task_actual" >&2
    exit 1
  fi
}

verify_crd apps.foundationdb.org_foundationdbclusters.yaml 57511675909ad02345909343efa295e4c28fcfb67c811cb021663a7c03dcd3f1
verify_crd apps.foundationdb.org_foundationdbbackups.yaml 2fb8313e25fa58be8a09f8a0cfc04172d80605b92850a523d73031ba8195a266
verify_crd apps.foundationdb.org_foundationdbrestores.yaml 499d7feb7d3e553f75b23c77a7e7d9467355703f771284b683ec4f4515ee9c6b

kubectl --context "$FDB_KUBE_CONTEXT" apply \
  -f "$crd_dir/apps.foundationdb.org_foundationdbclusters.yaml" \
  -f "$crd_dir/apps.foundationdb.org_foundationdbbackups.yaml" \
  -f "$crd_dir/apps.foundationdb.org_foundationdbrestores.yaml"
kubectl --context "$FDB_KUBE_CONTEXT" apply -f "$script_dir/../storageclasses.yaml"
kubectl --context "$FDB_KUBE_CONTEXT" apply -f "$script_dir/namespace.yaml"

if [ "$operator_mode" = production ]; then
  ACTOR_IMAGE_LOCK_TOOL=$script_dir/../gitops/image-seed/image-lock.py
  # shellcheck source=../gitops/image-seed/bind-inventory.sh
  source "$script_dir/../gitops/image-seed/bind-inventory.sh"
  actor_image_inventory_require
  actor_image_inventory_bind FDB_OPERATOR_IMAGE fdb-kubernetes-operator
  actor_image_inventory_bind FDB_MONITOR_IMAGE fdb-kubernetes-monitor
  image_inventory_digest=$(python3 "$ACTOR_IMAGE_LOCK_TOOL" validate-inventory \
    --lock "$ACTOR_IMAGE_INVENTORY" | jq -er '.inventoryDigest')
  kubectl --context "$FDB_KUBE_CONTEXT" -n actor-fdb-cell-system get secret actor-fleet-tcr >/dev/null
  kubectl --context "$FDB_KUBE_CONTEXT" -n actor-fdb-cell-system get secret fdb-operator-tls >/dev/null
  kubectl --context "$FDB_KUBE_CONTEXT" kustomize "$script_dir" >"$task_tmp/source-install.yaml"
  python3 "$script_dir/render-install.py" \
    --input "$task_tmp/source-install.yaml" \
    --output "$task_tmp/private-install.yaml" \
    --operator-image "$FDB_OPERATOR_IMAGE" \
    --monitor-image "$FDB_MONITOR_IMAGE" \
    --inventory-digest "$image_inventory_digest"
  kubectl --context "$FDB_KUBE_CONTEXT" apply -f "$task_tmp/private-install.yaml"
else
  kubectl --context "$FDB_KUBE_CONTEXT" apply -k "$script_dir"
fi
if [ "$operator_mode" = production ]; then
  operator_tls_patch="$task_tmp/operator-tls-patch.yaml"
  sed "s/secretName: actor-bj-k01-backup-credentials/secretName: ${cell_name}-backup-credentials/" \
    "$script_dir/production/operator-tls-patch.yaml" >"$operator_tls_patch"
  kubectl --context "$FDB_KUBE_CONTEXT" -n actor-fdb-cell-system patch \
    deployment fdb-kubernetes-operator-controller-manager --type strategic \
    --patch-file "$operator_tls_patch"
fi

kubectl --context "$FDB_KUBE_CONTEXT" -n actor-fdb-cell-system rollout status deployment/fdb-kubernetes-operator-controller-manager --timeout=5m
