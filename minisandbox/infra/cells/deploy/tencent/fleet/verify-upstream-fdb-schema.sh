#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
task_tmp=$(mktemp -d /data/tmp/actor-fdb-schema.XXXXXX)
trap 'rm -r -- "$task_tmp"' EXIT HUP INT TERM

operator_commit=b543152be5614170a1fa976421238989e9820cde
cluster_crd=apps.foundationdb.org_foundationdbclusters.yaml
expected_sha=57511675909ad02345909343efa295e4c28fcfb67c811cb021663a7c03dcd3f1
curl -fsSL \
  "https://raw.githubusercontent.com/FoundationDB/fdb-kubernetes-operator/$operator_commit/config/crd/bases/$cluster_crd" \
  -o "$task_tmp/$cluster_crd"

cmp "$script_dir/fdb-operator/vendor/crds/$cluster_crd" "$task_tmp/$cluster_crd" || {
  echo "vendored FoundationDBCluster CRD differs from the locked upstream commit" >&2
  exit 1
}

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$task_tmp/$cluster_crd" | sed 's/[[:space:]].*$//')
else
  actual_sha=$(shasum -a 256 "$task_tmp/$cluster_crd" | sed 's/[[:space:]].*$//')
fi
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "pinned FoundationDBCluster CRD checksum mismatch" >&2
  exit 1
fi

(
  cd "$repo_root"
  FDB_OPERATOR_CLUSTER_CRD="$task_tmp/$cluster_crd" \
    go test ./internal/fleetcontroller -run '^TestFoundationDBClusterMatchesPinnedUpstreamSchema$' -count=1
)
