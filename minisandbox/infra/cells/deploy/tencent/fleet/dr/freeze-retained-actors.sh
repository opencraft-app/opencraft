#!/usr/bin/env bash
set -euo pipefail

kubeconfig=${KUBECONFIG:-/root/.kube/actor-bj-k01.kubeconfig}
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell=$RIVET_CELL_NAME
freezer=${DR_FREEZER:?DR_FREEZER must point to freeze-retained-actors.py}
inflight=${DR_SEED_INFLIGHT:?DR_SEED_INFLIGHT is required}
qualification=${DR_SEED_QUALIFICATION_RESULT:?DR_SEED_QUALIFICATION_RESULT is required}
receipt=${DR_SEED_RECEIPT:?DR_SEED_RECEIPT is required}
temporary=$(mktemp -d)
pids=()
cleanup() {
	if ((${#pids[@]})); then
		kill "${pids[@]}" 2>/dev/null || true
		wait "${pids[@]}" 2>/dev/null || true
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

kubectl --kubeconfig "$kubeconfig" -n "$namespace" port-forward \
	service/"${cell}-engine" 16420:6420 16421:6421 >"$temporary/engine.log" 2>&1 &
pids+=("$!")
for attempt in $(seq 1 60); do
	if curl -fsS http://127.0.0.1:16421/health >/dev/null 2>&1; then
		break
	fi
	if [[ $attempt -eq 60 ]]; then
		echo "Engine port-forward did not become ready" >&2
		exit 1
	fi
	sleep 1
done

python3 "$freezer" \
	--inflight "$inflight" \
	--qualification-result "$qualification" \
	--output "$receipt"

source_pod=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get pod \
	-l "foundationdb.org/fdb-cluster-name=${cell}" -o jsonpath='{.items[0].metadata.name}')
source_version=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" exec "$source_pod" \
	-c foundationdb -- fdbcli -C /var/fdb/data/fdb.cluster --exec getversion | \
	tr -d '\r' | tail -n 1)
[[ $source_version =~ ^[0-9]+$ ]]
python3 - "$receipt" "$source_version" <<'PY'
import json, os, sys
path, version = sys.argv[1], int(sys.argv[2])
receipt = json.load(open(path))
receipt["source_fdb_read_version_after_freeze"] = version
temporary = path + ".tmp"
with open(temporary, "w") as output:
    json.dump(receipt, output, indent=2, sort_keys=True)
    output.write("\n")
os.replace(temporary, path)
print(json.dumps({"source_fdb_read_version_after_freeze": version}, sort_keys=True))
PY
