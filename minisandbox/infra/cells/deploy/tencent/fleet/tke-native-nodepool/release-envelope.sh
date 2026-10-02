#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
overlay_name=${ACTOR_MACHINESET_OVERLAY:-actor-bj-k01}
: "${ACTOR_CELL_NAME:?ACTOR_CELL_NAME must name the exact Cell}"
cell=$ACTOR_CELL_NAME
namespace=${ACTOR_CELL_NAMESPACE:-actor-fdb-cell-system}
machine_set=${ACTOR_FDB_MACHINESET:-np-fdbpool0}
minimum=${ACTOR_FDB_NODE_MIN:-9}
maximum=${ACTOR_FDB_NODE_MAX:-30}

for value in "$minimum" "$maximum"; do
	[[ $value =~ ^[1-9][0-9]*$ ]] || { echo "node envelope bounds must be positive integers" >&2; exit 2; }
done
((minimum >= 9 && minimum % 3 == 0 && maximum >= minimum && maximum % 3 == 0)) || {
	echo "FDB node envelope must preserve the three-zone 9-node floor and three-node steps" >&2
	exit 2
}

temporary=$(mktemp -d)
rollback_required=false
cleanup() { rm -rf -- "$temporary"; }
rollback() {
	local status=$1
	if [[ $status -ne 0 && $rollback_required == true ]]; then
		echo "MachineSet envelope release failed; restoring exact prior replicas/scaling" >&2
		kubectl "${kubeconfig_args[@]}" patch machineset "$machine_set" --type merge \
			-p "$(<"$temporary/rollback.json")" >/dev/null || true
	fi
	cleanup
	exit "$status"
}
trap 'rollback $?' EXIT
trap 'rollback 130' INT
trap 'rollback 143' TERM

overlay="$script_dir/overlays/$overlay_name"
[[ -f $overlay/kustomization.yaml ]] || { echo "MachineSet overlay does not exist: $overlay" >&2; exit 2; }
kubectl "${kubeconfig_args[@]}" kustomize "$overlay" >"$temporary/machineset.yaml"
kubectl "${kubeconfig_args[@]}" create --dry-run=client -f "$temporary/machineset.yaml" -o json >"$temporary/machineset.json"

python3 - "$temporary/machineset.json" "$machine_set" "$minimum" "$maximum" <<'PY'
import json,sys
path,name,minimum,maximum=sys.argv[1:]
obj=json.load(open(path)); spec=obj.get("spec",{}); scaling=spec.get("scaling",{})
assert obj.get("apiVersion")=="node.tke.cloud.tencent.com/v1beta1" and obj.get("kind")=="MachineSet"
assert obj.get("metadata",{}).get("name")==name and spec.get("type")=="Native"
assert spec.get("replicas")==int(minimum)
assert scaling=={"createPolicy":"ZoneEquality","minReplicas":int(minimum),"maxReplicas":int(maximum)}
labels=spec.get("template",{}).get("spec",{}).get("metadata",{}).get("labels",{})
assert labels.get("fleet.actor.dev/fdb-dedicated")=="true"
assert labels.get("node.tke.cloud.tencent.com/spread-placement-group-type")=="HOST"
PY

backup_url=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbbackup "${cell}-continuous" \
	-o jsonpath='{.status.backupDetails.url}')
backup_pod=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
	-l "foundationdb.org/deployment-name=${cell}-continuous-backup-agents" \
	-o jsonpath='{.items[0].metadata.name}')
[[ $backup_url == blobstore://* && -n $backup_pod ]] || {
	echo "continuous backup exact identity is unavailable" >&2
	exit 1
}
backup_description=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" exec "$backup_pod" \
	-c foundationdb -- timeout 45 fdbbackup describe -d "$backup_url")
grep -q '^Restorable: true$' <<<"$backup_description" || {
	echo "continuous backup exact container is not restorable" >&2
	exit 1
}

python3 - "${kubeconfig_args[@]}" "$namespace" "$cell" "$machine_set" "$minimum" "$temporary/rollback.json" <<'PY'
import json,subprocess,sys
args=sys.argv[1:-5]; namespace,cell,machine_set,minimum,rollback_path=sys.argv[-5:]; minimum=int(minimum)
def get(*parts): return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
jobs=get("get","jobs","-A").get("items",[])
assert not [x for x in jobs if x.get("status",{}).get("active",0)]
fdb=get("-n",namespace,"get","foundationdbcluster",cell); h=fdb.get("status",{}).get("health",{})
assert h.get("available") and h.get("healthy") and h.get("fullReplication")
assert fdb.get("status",{}).get("generations",{}).get("reconciled")==fdb["metadata"]["generation"]
assert fdb.get("spec",{}).get("processCounts",{}).get("storage")==minimum
backup=get("-n",namespace,"get","foundationdbbackup",cell+"-continuous").get("status",{}).get("backupDetails",{})
assert backup.get("running")
cell_obj=get("-n",namespace,"get","rivetcell",cell)
autoscale=cell_obj.get("status",{}).get("foundationDBAutoscaling",{})
assert autoscale.get("mode")=="ObserveOnly" and autoscale.get("desiredProcessCount")==minimum
machine=get("get","machineset",machine_set)
assert machine.get("status",{}).get("readyReplicas")==minimum
machine_spec=machine.get("spec",{})
machine_scaling=machine_spec.get("scaling",{})
machine_labels=machine_spec.get("template",{}).get("spec",{}).get("metadata",{}).get("labels",{})
assert machine_spec.get("type")=="Native" and machine_spec.get("replicas")==minimum
assert machine_scaling.get("createPolicy")=="ZoneEquality" and machine_scaling.get("minReplicas")==minimum
assert machine_scaling.get("maxReplicas",0)>=minimum
assert machine_labels.get("fleet.actor.dev/cell-name")==cell and machine_labels.get("fleet.actor.dev/fdb-dedicated")=="true"
rollback={"spec":{"replicas":machine.get("spec",{}).get("replicas"),"scaling":machine.get("spec",{}).get("scaling")}}
json.dump(rollback,open(rollback_path,"w"),separators=(",",":"))
PY

rollback_required=true
kubectl "${kubeconfig_args[@]}" patch machineset "$machine_set" --type merge \
	-p "{\"spec\":{\"replicas\":$minimum,\"scaling\":{\"createPolicy\":\"ZoneEquality\",\"minReplicas\":$minimum,\"maxReplicas\":$maximum}}}" >/dev/null

deadline=$((SECONDS + 300))
while ((SECONDS < deadline)); do
	generation=$(kubectl "${kubeconfig_args[@]}" get machineset "$machine_set" -o jsonpath='{.metadata.generation}')
	observed=$(kubectl "${kubeconfig_args[@]}" get machineset "$machine_set" -o jsonpath='{.status.observedGeneration}')
	ready=$(kubectl "${kubeconfig_args[@]}" get machineset "$machine_set" -o jsonpath='{.status.readyReplicas}')
	available=$(kubectl "${kubeconfig_args[@]}" get machineset "$machine_set" -o jsonpath='{.status.availableReplicas}')
	[[ $generation == "$observed" && $ready == "$minimum" && $available == "$minimum" ]] && break
	sleep 5
done
[[ $generation == "$observed" && $ready == "$minimum" && $available == "$minimum" ]]

python3 - "${kubeconfig_args[@]}" "$namespace" "$cell" "$machine_set" "$minimum" "$maximum" <<'PY'
import json,subprocess,sys
args=sys.argv[1:-5]; namespace,cell,machine_set,minimum,maximum=sys.argv[-5:]; minimum=int(minimum); maximum=int(maximum)
def get(*parts): return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
machine=get("get","machineset",machine_set); spec=machine.get("spec",{}); status=machine.get("status",{})
assert spec.get("replicas")==minimum
assert spec.get("scaling")=={"createPolicy":"ZoneEquality","minReplicas":minimum,"maxReplicas":maximum}
assert status.get("readyReplicas")==status.get("availableReplicas")==minimum
nodes=get("get","nodes","-l",f"node.tke.cloud.tencent.com/machineset={machine_set}").get("items",[])
zones={x.get("metadata",{}).get("labels",{}).get("topology.kubernetes.io/zone") for x in nodes}
assert len(nodes)==minimum and None not in zones and len(zones)==3
fdb=get("-n",namespace,"get","foundationdbcluster",cell); h=fdb.get("status",{}).get("health",{})
assert fdb.get("spec",{}).get("processCounts",{}).get("storage")==minimum
assert h.get("available") and h.get("healthy") and h.get("fullReplication")
print(json.dumps({"verdict":"passed","machineset":machine_set,"nodes":len(nodes),"zones":len(zones),"min":minimum,"max":maximum,"fdb_processes":minimum},sort_keys=True))
PY

rollback_required=false
