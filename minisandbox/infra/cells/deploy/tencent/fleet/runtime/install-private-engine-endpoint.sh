#!/usr/bin/env bash
set -euo pipefail
umask 077

cell=${RIVET_CELL_NAME:?RIVET_CELL_NAME is required}
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
datacenter=${RIVET_DATACENTER_NAME:?RIVET_DATACENTER_NAME is required}
subnet_id=${RIVET_ENGINE_PRIVATE_SUBNET_ID:?RIVET_ENGINE_PRIVATE_SUBNET_ID is required}
hub_cidrs=${RIVET_ENGINE_HUB_CIDRS:?RIVET_ENGINE_HUB_CIDRS is required as comma-separated private CIDRs}
receipt=${RIVET_ENGINE_ENDPOINT_RECEIPT:?RIVET_ENGINE_ENDPOINT_RECEIPT is required}
kubeconfig=${KUBECONFIG_PATH:-${KUBECONFIG:-}}

[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
	&& $datacenter =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ \
	&& $subnet_id =~ ^subnet-[A-Za-z0-9]+$ ]] || {
	echo "private Engine endpoint identity is invalid" >&2
	exit 2
}
[[ -n $kubeconfig && -f $kubeconfig && $receipt == /* && ! -e $receipt ]] || {
	echo "kubeconfig must exist and endpoint receipt must be a new absolute path" >&2
	exit 2
}
for command in kubectl python3; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

service=${cell}-engine-private
source_service=${cell}-engine
temporary=$(mktemp -d /data/tmp/${cell}-engine-endpoint.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM
kube=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")
"${kube[@]}" get service "$source_service" -o json >"$temporary/source.json"
"${kube[@]}" get rivetcell "$cell" -o json >"$temporary/cell.json"

python3 - "$temporary/source.json" "$temporary/cell.json" "$temporary/service.json" \
	"$cell" "$namespace" "$service" "$subnet_id" "$hub_cidrs" <<'PY'
import ipaddress, json, sys

source_path, cell_path, output, cell, namespace, name, subnet, raw_cidrs = sys.argv[1:]
source = json.load(open(source_path))
cell_object = json.load(open(cell_path))
if source.get("spec", {}).get("type") != "ClusterIP":
    raise SystemExit("source Engine Service must be ClusterIP")
selector = source.get("spec", {}).get("selector")
if not isinstance(selector, dict) or not selector:
    raise SystemExit("source Engine Service has no selector")
ports = source.get("spec", {}).get("ports", [])
api = next((item for item in ports if item.get("name") == "api"), None)
if not api or api.get("port") != 6420:
    raise SystemExit("source Engine Service does not expose the expected api port")
if cell_object.get("metadata", {}).get("name") != cell:
    raise SystemExit("live RivetCell identity differs")
cell_uid = cell_object.get("metadata", {}).get("uid")
if not isinstance(cell_uid, str) or not cell_uid:
    raise SystemExit("live RivetCell UID is absent")
cidrs = []
for raw in raw_cidrs.split(","):
    raw = raw.strip()
    if not raw:
        continue
    network = ipaddress.ip_network(raw, strict=False)
    if network.version != 4 or not network.is_private:
        raise SystemExit("Hub source ranges must be private IPv4 networks")
    cidrs.append(str(network))
cidrs = sorted(set(cidrs))
if not cidrs:
    raise SystemExit("at least one Hub source range is required")
document = {
    "apiVersion": "v1", "kind": "Service",
    "metadata": {
        "name": name, "namespace": namespace,
        "labels": {
            "fleet.actor.dev/cell-name": cell,
            "fleet.actor.dev/component": "engine",
            "app.kubernetes.io/managed-by": "actor-engine-endpoint",
            "service.cloud.tencent.com/loadbalance-type": "INTERNAL",
        },
        "annotations": {
            "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid": subnet,
            "service.cloud.tencent.com/loadbalance-retain": "true",
        },
    },
    "spec": {
        "type": "LoadBalancer", "loadBalancerSourceRanges": cidrs,
        "selector": selector,
        "ports": [{"name": "api", "port": 6420, "protocol": "TCP", "targetPort": "api"}],
    },
}
with open(output, "w") as stream:
    json.dump(document, stream, sort_keys=True)
PY

"${kube[@]}" apply -f "$temporary/service.json" >/dev/null
deadline=$((SECONDS + 600))
endpoint=
while ((SECONDS < deadline)); do
	"${kube[@]}" get service "$service" -o json >"$temporary/live.json"
	endpoint=$(python3 - "$temporary/live.json" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
items=value.get("status",{}).get("loadBalancer",{}).get("ingress",[])
print(items[0].get("ip", "") if len(items) == 1 else "")
PY
	)
	[[ -n $endpoint ]] && break
	sleep 5
done
[[ -n $endpoint ]] || { echo "private Engine load balancer did not receive one address" >&2; exit 1; }

mkdir -p "$(dirname -- "$receipt")"
python3 - "$temporary/service.json" "$temporary/live.json" "$temporary/cell.json" \
	"$receipt" "$cell" "$datacenter" "$subnet_id" "$endpoint" <<'PY'
import hashlib, ipaddress, json, os, sys, tempfile

expected_path, live_path, cell_path, output, cell, datacenter, subnet, endpoint = sys.argv[1:]
expected, live, cell_object = map(lambda p: json.load(open(p)), (expected_path, live_path, cell_path))
spec = live.get("spec", {})
if spec.get("type") != "LoadBalancer" or spec.get("selector") != expected["spec"]["selector"]:
    raise SystemExit("live private Engine Service differs from the source Engine selector")
if sorted(spec.get("loadBalancerSourceRanges", [])) != expected["spec"]["loadBalancerSourceRanges"]:
    raise SystemExit("live private Engine source ranges differ")
if live.get("metadata", {}).get("annotations", {}).get(
    "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid"
) != subnet:
    raise SystemExit("live private Engine subnet differs")
if not ipaddress.ip_address(endpoint).is_private:
    raise SystemExit("Engine endpoint is not private")
metadata = live.get("metadata", {})
receipt = {
    "schema": "actor-engine-private-endpoint/v1", "verdict": "passed",
    "cell": {"name": cell, "uid": cell_object["metadata"]["uid"]},
    "datacenter": datacenter,
    "endpoint": "http://{}:6420".format(endpoint),
    "network": {"subnetId": subnet, "hubSourceCidrs": expected["spec"]["loadBalancerSourceRanges"]},
    "service": {
        "namespace": metadata["namespace"], "name": metadata["name"],
        "uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"],
    },
}
directory=os.path.dirname(output)
fd, temporary=tempfile.mkstemp(prefix="."+os.path.basename(output)+".", dir=directory)
try:
    os.fchmod(fd, 0o644)
    with os.fdopen(fd, "w") as stream:
        json.dump(receipt, stream, indent=2, sort_keys=True); stream.write("\n")
        stream.flush(); os.fsync(stream.fileno())
    os.link(temporary, output)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY

printf 'engine_private_endpoint=passed cell=%s endpoint=http://%s:6420 receipt=%s\n' \
	"$cell" "$endpoint" "$receipt"
