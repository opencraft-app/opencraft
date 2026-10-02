#!/usr/bin/env bash
set -euo pipefail

cell=${RIVET_CELL_NAME:?RIVET_CELL_NAME is required}
kubeconfig=${KUBECONFIG_PATH:-${KUBECONFIG:-}}
reporter_image=${RIVET_REPORTER_IMAGE:?RIVET_REPORTER_IMAGE is required}
runtime_image=${RIVET_RUNTIME_IMAGE:?RIVET_RUNTIME_IMAGE is required}
machine_set=${STATELESS_MACHINE_SET:?STATELESS_MACHINE_SET must be the Terraform-owned Native NodePool ID}
receipt=${RIVET_STATELESS_ADMISSION_RECEIPT:?RIVET_STATELESS_ADMISSION_RECEIPT is required}
namespace=actor-runtime-admission-system
workload_namespace=actor-stateless-system
controller_namespace=${RIVET_CONTROLLER_NAMESPACE:-fdb-operator-actor-fleet-controller-system}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
manifest=${RIVET_STATELESS_ADMISSION_MANIFEST:-$script_dir/stateless-admission-controller.yaml}

[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& -n $kubeconfig && -f $kubeconfig \
	&& -f $manifest && ! -L $manifest \
	&& $reporter_image =~ @sha256:[0-9a-f]{64}$ \
	&& $runtime_image =~ @sha256:[0-9a-f]{64}$ \
	&& $machine_set =~ ^[A-Za-z0-9._-]+$ \
	&& $receipt == /* && ! -e $receipt ]] || {
	echo "invalid stateless admission installation inputs" >&2
	exit 2
}
for command in kubectl python3 sha256sum; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

temporary=$(mktemp -d /data/tmp/${cell}-stateless-admission.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
kube=(kubectl --kubeconfig "$kubeconfig")
"${kube[@]}" create namespace "$namespace" --dry-run=client -o yaml | \
	"${kube[@]}" apply -f - >/dev/null
"${kube[@]}" create namespace "$workload_namespace" --dry-run=client -o yaml | \
	"${kube[@]}" apply -f - >/dev/null
"${kube[@]}" get machineset.node.tke.cloud.tencent.com "$machine_set" -o json >"$temporary/machineset.json"
read -r min_replicas max_replicas machine_set_uid < <(python3 - "$temporary/machineset.json" "$cell" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); cell=sys.argv[2]
spec=m["spec"]; template=spec["template"]["spec"]
labels=template["metadata"]["labels"]
expected={
    "fleet.actor.dev/cell-name":cell,
    "fleet.actor.dev/stateless-pool":"true",
    "fleet.actor.dev/stateless-admitted":"true",
    "rivet.dev/stateless":"true",
}
for key,value in expected.items():
    if labels.get(key) != value: raise SystemExit(f"stateless MachineSet label differs: {key}")
taints={(x.get("key"),x.get("value"),x.get("effect")) for x in template.get("taints",[])}
required={
    ("rivet.dev/stateless","true","NoSchedule"),
    ("startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission","pending","NoSchedule"),
}
if not required.issubset(taints): raise SystemExit("stateless MachineSet taint contract differs")
scaling=spec.get("scaling",{})
minimum=int(scaling.get("minReplicas",0)); maximum=int(scaling.get("maxReplicas",0)); current=int(spec.get("replicas",0))
if not 1 <= minimum <= current <= maximum: raise SystemExit("stateless MachineSet scaling envelope is invalid")
if scaling.get("createPolicy") != "ZoneEquality": raise SystemExit("stateless MachineSet must use ZoneEquality")
uid=m.get("metadata",{}).get("uid")
if not uid: raise SystemExit("stateless MachineSet UID is absent")
print(minimum,maximum,uid)
PY
)

# The admission controller and its node-local probe must be able to pull before
# the stateless workload exists. Copy only the registry credential, never a
# controller token or kubeconfig.
for target_namespace in "$namespace" "$workload_namespace"; do
	"${kube[@]}" -n "$controller_namespace" get secret actor-fleet-tcr -o json | \
		python3 -c 'import json,sys; d=json.load(sys.stdin); m=d["metadata"]; m["name"]="actor-fleet-tcr"; m["namespace"]=sys.argv[1]; [m.pop(k,None) for k in ("uid","resourceVersion","creationTimestamp","managedFields")]; print(json.dumps(d))' "$target_namespace" | \
		"${kube[@]}" apply -f - >/dev/null
done

manifest_sha=$(
	{
		sha256sum "$manifest"
		printf '%s\n' "$cell" "$machine_set" "$machine_set_uid" "$min_replicas" "$max_replicas" "$reporter_image" "$runtime_image"
	} | sha256sum | cut -d' ' -f1
)
sed \
	-e "s|__CELL_NAME__|$cell|g" \
	-e "s|__STATELESS_MACHINE_SET__|$machine_set|g" \
	-e "s|__REPORTER_IMAGE__|$reporter_image|g" \
	-e "s|__RUNTIME_IMAGE__|$runtime_image|g" \
	-e "s|__MANIFEST_SHA256__|$manifest_sha|g" \
	"$manifest" >"$temporary/rendered.yaml"
if grep -Eq '__[A-Z0-9_]+__' "$temporary/rendered.yaml"; then
	echo "rendered stateless admission manifest contains an unresolved placeholder" >&2
	exit 1
fi
"${kube[@]}" apply --server-side --force-conflicts \
	--field-manager=rivet-stateless-admission -f "$temporary/rendered.yaml" >/dev/null
"${kube[@]}" -n "$namespace" rollout status deployment/"${cell}-stateless-admission" --timeout=5m

deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
	"${kube[@]}" get machines.node.tke.cloud.tencent.com \
		-l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/machines.json"
	"${kube[@]}" get nodes -l "node.tke.cloud.tencent.com/machineset=${machine_set}" -o json >"$temporary/nodes.json"
	if python3 - "$temporary/machines.json" "$temporary/nodes.json" "$cell" "$machine_set_uid" "$runtime_image" "$min_replicas" <<'PY'
import json,sys
machines,nodes=(json.load(open(p)) for p in sys.argv[1:3])
cell,machine_set_uid,image=sys.argv[3:6]; minimum=int(sys.argv[6])
machine_by_node={x.get("status",{}).get("nodeRef",{}).get("name"):x["metadata"]["uid"] for x in machines["items"]}
admitted=[]
for node in nodes["items"]:
    m=node["metadata"]; labels=m.get("labels",{}); annotations=m.get("annotations",{})
    conditions={x["type"]:x["status"] for x in node.get("status",{}).get("conditions",[])}
    taints={x.get("key") for x in node.get("spec",{}).get("taints",[])}
    if labels.get("fleet.actor.dev/cell-name") != cell or conditions.get("Ready") != "True": continue
    if labels.get("fleet.actor.dev/stateless-admitted") != "true": continue
    if "startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission" in taints: continue
    try: state=json.loads(annotations["fleet.actor.dev/stateless-admission-state"])
    except (KeyError,TypeError,json.JSONDecodeError): continue
    identity=state.get("identity",{})
    if state.get("phase") != "Admitted" or identity.get("node_uid") != m.get("uid") or identity.get("provider_id") != node.get("spec",{}).get("providerID") or identity.get("machine_uid") != machine_by_node.get(m.get("name")) or identity.get("machine_set_uid") != machine_set_uid or identity.get("runtime_image") != image: continue
    admitted.append(m["uid"])
if len(admitted) < minimum: raise SystemExit(1)
PY
	then
		break
	fi
	sleep 5
done
if ((SECONDS >= deadline)); then
	echo "stateless node admission did not reach the MachineSet minimum" >&2
	exit 1
fi

"${kube[@]}" -n "$namespace" get deployment "${cell}-stateless-admission" -o json >"$temporary/deployment.json"
mkdir -p "$(dirname -- "$receipt")"
python3 - "$temporary/deployment.json" "$receipt" "$cell" "$machine_set" "$machine_set_uid" "$runtime_image" "$reporter_image" "$manifest_sha" <<'PY'
import json,os,sys,tempfile
deployment_path,output,cell,machine_set,machine_set_uid,runtime_image,reporter_image,manifest_sha=sys.argv[1:]
deployment=json.load(open(deployment_path)); status=deployment.get("status",{})
if status.get("readyReplicas") != 1 or status.get("updatedReplicas") != 1: raise SystemExit("stateless admission controller is not Ready")
value={"schema":"actor-stateless-node-admission/v1","verdict":"passed","cell":cell,
       "machineSet":{"name":machine_set,"uid":machine_set_uid},"runtimeImage":runtime_image,
       "controllerImage":reporter_image,"manifestSha256":"sha256:"+manifest_sha,
       "deployment":{"name":deployment["metadata"]["name"],"uid":deployment["metadata"]["uid"]}}
fd,tmp=tempfile.mkstemp(prefix="."+os.path.basename(output)+".",dir=os.path.dirname(output))
try:
    os.fchmod(fd,0o644)
    with os.fdopen(fd,"w") as f: json.dump(value,f,indent=2,sort_keys=True); f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.link(tmp,output)
finally:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
PY
printf 'stateless_node_admission=passed cell=%s receipt=%s\n' "$cell" "$receipt"
