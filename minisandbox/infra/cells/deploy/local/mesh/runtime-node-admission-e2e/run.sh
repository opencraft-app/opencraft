#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cells_dir=$(CDPATH= cd -- "$script_dir/../../../.." && pwd)
cluster=${RUNTIME_ADMISSION_E2E_CLUSTER:-rivet-runtime-admission-e2e}
temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root"
temporary=$(mktemp -d "$temporary_root/runtime-node-admission-e2e.XXXXXX")
created=false

cleanup() {
	if [[ $created == true ]]; then
		k3d cluster delete "$cluster" >/dev/null 2>&1 || true
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

command -v k3d >/dev/null
command -v kubectl >/dev/null
if k3d cluster list -o json | python3 -c 'import json,sys; name=sys.argv[1]; raise SystemExit(0 if all(item["name"] != name for item in json.load(sys.stdin)) else 1)' "$cluster"; then
	k3d cluster create "$cluster" --servers 1 --agents 0 --wait --timeout 3m >/dev/null
	created=true
else
	echo "refusing to adopt existing k3d cluster: $cluster" >&2
	exit 2
fi

k3d kubeconfig get "$cluster" >"$temporary/kubeconfig"
chmod 0600 "$temporary/kubeconfig"
kubectl --kubeconfig "$temporary/kubeconfig" apply -f "$script_dir/crds.yaml" >/dev/null
kubectl --kubeconfig "$temporary/kubeconfig" wait \
	--for=condition=Established \
	customresourcedefinition/machinesets.node.tke.cloud.tencent.com \
	customresourcedefinition/machines.node.tke.cloud.tencent.com \
	--timeout=60s >/dev/null

KUBECONFIG="$temporary/kubeconfig" \
RUNTIME_ADMISSION_K3S_E2E=1 \
GOSUMDB=${GOSUMDB:-sum.golang.org} \
GOTOOLCHAIN=${GOTOOLCHAIN:-auto} \
	go test -C "$cells_dir" -count=1 -run TestRuntimeNodeAdmissionK3S -v ./deploy/local/mesh/runtime-node-admission-e2e

echo "runtime Node admission k3s state machine E2E: pass"
