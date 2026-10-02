#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
controller_namespace=${RIVET_CONTROLLER_NAMESPACE:-fdb-operator-actor-fleet-controller-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell_name=$RIVET_CELL_NAME
machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
reporter_image=${RIVET_REPORTER_IMAGE:?RIVET_REPORTER_IMAGE must be pinned by registry digest}
runtime_image=${RIVET_RUNTIME_IMAGE:?RIVET_RUNTIME_IMAGE must be pinned by registry digest}
timeout_seconds=${RUNTIME_ADMISSION_TIMEOUT_SECONDS:-600}
max_repair_surge=${RUNTIME_CAPACITY_MAX_REPAIR_SURGE:-0}
targeted_repair_enabled=${RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED:-false}
exact_scale_down_enabled=${RUNTIME_EXACT_SCALE_DOWN_ENABLED:-false}
provider_cluster_id=${RUNTIME_TKE_CLUSTER_ID:-disabled}
tencent_region=${TENCENT_REGION:-ap-beijing}
tke_oidc_role_arn=${RUNTIME_TKE_OIDC_ROLE_ARN:-disabled}
machine_repair_receipt=${RUNTIME_MACHINE_REPAIR_QUALIFICATION_RECEIPT:-}
field_manager=${RUNTIME_ADMISSION_FIELD_MANAGER:-rivet-runtime-admission-installer}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
static_release_transaction=${RUNTIME_STATIC_RELEASE_TRANSACTION:-0}

case "$static_release_transaction" in
0 | 1) ;;
*)
	echo "RUNTIME_STATIC_RELEASE_TRANSACTION must be 0 or 1" >&2
	exit 2
	;;
esac

# This Deployment is part of the immutable Runtime release ledger.  A direct
# reconfiguration after the first ledger exists would make an otherwise
# healthy Cell fail static-drift audit.  Only release-runtime.sh may change it
# at that point; bootstrap callers must run before the first ledger is issued.
if [[ $static_release_transaction != 1 ]] && \
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap \
		"${cell_name}-release-ledger" >/dev/null 2>&1; then
	echo "runtime admission configuration is release-owned; use release-runtime.sh after the first release ledger exists" >&2
	exit 2
fi

for value in "$cell_name" "$namespace" "$machine_set"; do
	[[ $value =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
		echo "Cell, namespace, and MachineSet names must be DNS labels" >&2
		exit 2
	}
done
for image in "$reporter_image" "$runtime_image"; do
	[[ $image =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
		echo "admission images must be immutable registry digests: $image" >&2
		exit 2
	}
done
[[ $timeout_seconds =~ ^[1-9][0-9]*$ ]] || {
	echo "RUNTIME_ADMISSION_TIMEOUT_SECONDS must be a positive integer" >&2
	exit 2
}
[[ $max_repair_surge =~ ^[0-9]+$ ]] || {
	echo "RUNTIME_CAPACITY_MAX_REPAIR_SURGE must be a non-negative integer" >&2
	exit 2
}
case "$targeted_repair_enabled" in
true | false) ;;
*)
	echo "RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED must be true or false" >&2
	exit 2
	;;
esac
case "$exact_scale_down_enabled" in
true | false) ;;
*)
	echo "RUNTIME_EXACT_SCALE_DOWN_ENABLED must be true or false" >&2
	exit 2
	;;
esac
[[ $provider_cluster_id == disabled || $provider_cluster_id =~ ^cls-[a-z0-9]+$ ]] || {
	echo "RUNTIME_TKE_CLUSTER_ID is invalid" >&2
	exit 2
}
[[ $tencent_region =~ ^[a-z]+-[a-z]+(-[0-9]+)?$ ]] || {
	echo "TENCENT_REGION is invalid" >&2
	exit 2
}
[[ $field_manager =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || {
	echo "RUNTIME_ADMISSION_FIELD_MANAGER is invalid" >&2
	exit 2
}

temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root"
temporary=$(mktemp -d "$temporary_root/runtime-admission-install.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

if [[ $targeted_repair_enabled == true ]]; then
	if ! kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "${cell_name}-runtime-auth" \
		-o jsonpath='{.data.token}' 2>/dev/null | base64 --decode >"$temporary/runtime-auth-token" ||
		[[ $(wc -c <"$temporary/runtime-auth-token") -ne 64 ]] ||
		! grep -Eq '^[0-9a-f]{64}$' "$temporary/runtime-auth-token"; then
		echo "automatic repair requires an existing valid ${cell_name}-runtime-auth Secret" >&2
		exit 1
	fi
fi

if [[ $exact_scale_down_enabled == true ]]; then
	[[ $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ && $machine_set == np-runtime0 ]] || {
		echo "exact provider scale-down requires a production Cell and np-runtime0" >&2
		exit 2
	}
	[[ $provider_cluster_id != disabled ]] || {
		echo "exact provider scale-down requires RUNTIME_TKE_CLUSTER_ID" >&2
		exit 2
	}
	[[ $tke_oidc_role_arn =~ ^qcs::cam::uin/[0-9]+:roleName/${cell_name}-runtime-scale-down$ ]] || {
		echo "exact provider scale-down requires the exact Cell TKE OIDC role ARN" >&2
		exit 2
	}
elif [[ $tke_oidc_role_arn != disabled ]]; then
	echo "RUNTIME_TKE_OIDC_ROLE_ARN is accepted only when exact scale-down is enabled" >&2
	exit 2
fi

# Admission owns the concrete Machine's pending taint after TKE creates it.
# The MachineSet keeps the taint as the birth default; removing it only from
# the Node is unstable because TKE periodically restores Machine.spec.taints.
machine_verbs="get, list, patch"
receipt_hash=disabled
if [[ $targeted_repair_enabled == true ]]; then
	[[ $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ && $machine_set == np-runtime0 ]] || {
		echo "automatic Machine repair requires a production Cell and np-runtime0" >&2
		exit 2
	}
	[[ $max_repair_surge == 1 ]] || {
		echo "automatic Machine repair requires exactly one repair surge" >&2
		exit 2
	}
	[[ -n $machine_repair_receipt && -f $machine_repair_receipt ]] || {
		echo "RUNTIME_MACHINE_REPAIR_QUALIFICATION_RECEIPT must name a local passing receipt" >&2
		exit 2
	}
	current_cluster_uid=$(kubectl "${kubeconfig_args[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}')
	current_machine_set_uid=$(kubectl "${kubeconfig_args[@]}" get \
		machineset.node.tke.cloud.tencent.com "$machine_set" -o jsonpath='{.metadata.uid}')
	[[ -n $current_cluster_uid && -n $current_machine_set_uid ]] || {
		echo "current cluster or MachineSet identity is empty" >&2
		exit 1
	}
	"$script_dir/../qualification/actor-bj-q01/verify-runtime-machine-repair-receipt.py" \
		--expected-cell "$cell_name" --expected-machine-set "$machine_set" \
		--cluster-uid "$current_cluster_uid" --machine-set-uid "$current_machine_set_uid" \
		"$machine_repair_receipt"
	machine_verbs="get, list, patch, delete"
	receipt_hash=$(sha256sum "$machine_repair_receipt" | cut -d' ' -f1)
elif [[ -n $machine_repair_receipt ]]; then
	echo "a Machine repair receipt is accepted only when targeted repair is enabled" >&2
	exit 2
fi

kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/machineset.json"
read -r min_replicas max_replicas < <(python3 - "$temporary/machineset.json" "$cell_name" "$targeted_repair_enabled" <<'PY'
import json
import sys

machine_set = json.load(open(sys.argv[1]))
cell = sys.argv[2]
targeted_repair_enabled = sys.argv[3] == "true"
template = machine_set["spec"]["template"]["spec"]
if template["metadata"]["labels"].get("fleet.actor.dev/cell-name") != cell:
    raise SystemExit("runtime MachineSet Cell identity mismatch")
if targeted_repair_enabled and machine_set["spec"].get("deletePolicy") != "Newest":
    raise SystemExit("runtime MachineSet requires deletePolicy=Newest")
pending = {"key": "fleet.actor.dev/runtime-admission", "value": "pending", "effect": "NoSchedule"}
if pending not in template.get("taints", []):
    raise SystemExit("runtime MachineSet lacks the default-deny admission birth taint")
scaling = machine_set["spec"]["scaling"]
minimum = int(scaling["minReplicas"])
maximum = int(scaling["maxReplicas"])
current = int(machine_set["spec"]["replicas"])
if not 1 <= minimum <= current <= maximum:
    raise SystemExit("runtime MachineSet replica bounds are invalid")
print(minimum, maximum)
PY
)
if ((max_repair_surge > max_replicas - min_replicas)); then
	echo "RUNTIME_CAPACITY_MAX_REPAIR_SURGE exceeds MachineSet headroom" >&2
	exit 2
fi
manifest_sha=$(
	{
		sha256sum "$script_dir/admission-controller.yaml"
		printf '%s\n' "$cell_name" "$namespace" "$machine_set" "$min_replicas" "$max_replicas" \
			"$max_repair_surge" "$targeted_repair_enabled" "$exact_scale_down_enabled" "$provider_cluster_id" \
			"$tencent_region" "$tke_oidc_role_arn" "$receipt_hash" "$reporter_image" "$runtime_image"
	} | sha256sum | cut -d' ' -f1
)

# Admission runs before the runtime StatefulSet, so both the controller and its
# tokenless probe must be able to pull from the private registry independently.
kubectl "${kubeconfig_args[@]}" -n "$controller_namespace" get secret actor-fleet-tcr -o json | \
	python3 -c 'import json,sys; d=json.load(sys.stdin); m=d["metadata"]; m["name"]="actor-fleet-tcr"; m["namespace"]=sys.argv[1]; [m.pop(k,None) for k in ("uid","resourceVersion","creationTimestamp","managedFields")]; print(json.dumps(d))' "$namespace" | \
	kubectl "${kubeconfig_args[@]}" apply -f - >/dev/null

sed \
	-e "s|__CELL_NAME__|$cell_name|g" \
	-e "s|__CELL_NAMESPACE__|$namespace|g" \
	-e "s|__MACHINESET__|$machine_set|g" \
	-e "s|__MIN_REPLICAS__|$min_replicas|g" \
	-e "s|__MAX_REPLICAS__|$max_replicas|g" \
	-e "s|__MAX_REPAIR_SURGE__|$max_repair_surge|g" \
	-e "s|__TARGETED_REPAIR_ENABLED__|$targeted_repair_enabled|g" \
	-e "s|__EXACT_SCALE_DOWN_ENABLED__|$exact_scale_down_enabled|g" \
	-e "s|__TKE_CLUSTER_ID__|$provider_cluster_id|g" \
	-e "s|__TENCENT_REGION__|$tencent_region|g" \
	-e "s|__MACHINE_VERBS__|$machine_verbs|g" \
	-e "s|__MACHINE_REPAIR_RECEIPT_SHA256__|$receipt_hash|g" \
	-e "s|__REPORTER_IMAGE__|$reporter_image|g" \
	-e "s|__RUNTIME_IMAGE__|$runtime_image|g" \
	-e "s|__MANIFEST_SHA256__|$manifest_sha|g" \
	"$script_dir/admission-controller.yaml" >"$temporary/admission-controller.yaml"
python3 "$script_dir/render-controller-oidc.py" \
	--enabled "$exact_scale_down_enabled" \
	--role-arn "$tke_oidc_role_arn" \
	--provider-id "$provider_cluster_id" \
	"$temporary/admission-controller.yaml"
if grep -Eq '__[A-Z0-9_]+__' "$temporary/admission-controller.yaml"; then
	echo "runtime admission manifest retained an unresolved placeholder" >&2
	exit 1
fi
kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts --dry-run=server \
	--field-manager="$field_manager" -f "$temporary/admission-controller.yaml" >/dev/null
kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
	--field-manager="$field_manager" -f "$temporary/admission-controller.yaml"
kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
	deployment/"${cell_name}-runtime-capacity" --timeout=5m

deadline=$((SECONDS + timeout_seconds))
required_admitted_nodes=$min_replicas
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-runtime-hosts" >/dev/null 2>&1; then
	required_admitted_nodes=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
		"${cell_name}-runtime-hosts" -o jsonpath='{.spec.replicas}')
fi
[[ $required_admitted_nodes =~ ^[1-9][0-9]*$ ]] || {
	echo "runtime desired Host count is invalid: $required_admitted_nodes" >&2
	exit 1
}
while ((SECONDS < deadline)); do
	kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/current-machineset.json"
	kubectl "${kubeconfig_args[@]}" get machines.node.tke.cloud.tencent.com \
		-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/current-machines.json"
	kubectl "${kubeconfig_args[@]}" get nodes \
		-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/current-nodes.json"
	if python3 - "$temporary/current-machineset.json" "$temporary/current-machines.json" "$temporary/current-nodes.json" "$cell_name" "$runtime_image" "$required_admitted_nodes" <<'PY'
import json
import sys

machine_set, machines, nodes = (json.load(open(path)) for path in sys.argv[1:4])
cell = sys.argv[4]
expected_runtime_image = sys.argv[5]
required_admitted_nodes = int(sys.argv[6])
machine_set_uid = machine_set["metadata"]["uid"]
machine_by_node = {
    item.get("status", {}).get("nodeRef", {}).get("name"): item["metadata"]["uid"]
    for item in machines["items"]
    if item.get("status", {}).get("nodeRef", {}).get("name")
}
if not nodes["items"] or len(nodes["items"]) != int(machine_set["status"].get("readyReplicas", -1)):
    raise SystemExit(1)
admitted_by_zone = {}
for node in nodes["items"]:
    metadata = node["metadata"]
    name = metadata["name"]
    if metadata.get("labels", {}).get("fleet.actor.dev/cell-name") != cell:
        raise SystemExit(1)
    conditions = {item["type"]: item["status"] for item in node.get("status", {}).get("conditions", [])}
    if conditions.get("Ready") != "True" or any(conditions.get(key) == "True" for key in ("DiskPressure", "MemoryPressure", "PIDPressure", "NetworkUnavailable")):
        raise SystemExit(1)
    admitted = metadata.get("labels", {}).get("fleet.actor.dev/runtime-admitted") == "true"
    if metadata.get("annotations", {}).get("fleet.actor.dev/runtime-capacity-drain"):
        raise SystemExit(1)
    taint_keys = {item.get("key") for item in node.get("spec", {}).get("taints", [])}
    if "fleet.actor.dev/runtime-capacity-drain" in taint_keys:
        raise SystemExit(1)
    try:
        state = json.loads(metadata["annotations"]["fleet.actor.dev/runtime-admission-state"])
    except (KeyError, TypeError, json.JSONDecodeError):
        raise SystemExit(1)
    identity = state.get("identity", {})
    if identity.get("node_uid") != metadata["uid"] or identity.get("provider_id") != node["spec"].get("providerID") or identity.get("machine_uid") != machine_by_node.get(name) or identity.get("machine_set_uid") != machine_set_uid or identity.get("runtime_image") != expected_runtime_image:
        raise SystemExit(1)
    if admitted:
        if state.get("phase") != "Admitted" or "fleet.actor.dev/runtime-admission" in taint_keys:
            raise SystemExit(1)
        zone = metadata.get("labels", {}).get("topology.kubernetes.io/zone")
        if not zone:
            raise SystemExit(1)
        admitted_by_zone[zone] = admitted_by_zone.get(zone, 0) + 1
    elif state.get("phase") not in {"Pending", "Probing", "Prepared", "Blocked", "Quarantined"} or "fleet.actor.dev/runtime-admission" not in taint_keys:
        raise SystemExit(1)
if len(admitted_by_zone) != 3:
    raise SystemExit(1)
counts = list(admitted_by_zone.values())
if max(counts) - min(counts) > 1 or sum(counts) < required_admitted_nodes:
    raise SystemExit(1)
raise SystemExit(0)
PY
	then
		break
	fi
	sleep 5
done
((SECONDS < deadline)) || {
	echo "runtime Nodes did not obtain exact admission before timeout" >&2
	exit 1
}

echo "runtime Node admission converged: cell=$cell_name machineset=$machine_set manifest_sha256=$manifest_sha field_manager=$field_manager"
