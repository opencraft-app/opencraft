#!/usr/bin/env bash
set -euo pipefail

namespace=observability
service=actor-observability-federate
cluster=${ACTOR_FEDERATION_CLUSTER:?ACTOR_FEDERATION_CLUSTER is required}
subnet_id=${ACTOR_FEDERATION_SUBNET_ID:?ACTOR_FEDERATION_SUBNET_ID is required}
security_group_id=${ACTOR_FEDERATION_SECURITY_GROUP_ID:?ACTOR_FEDERATION_SECURITY_GROUP_ID is required}
hub_cidrs=${ACTOR_FEDERATION_HUB_CIDRS:?ACTOR_FEDERATION_HUB_CIDRS is required as comma-separated private CIDRs}
receipt=${ACTOR_FEDERATION_ENDPOINT_RECEIPT:?ACTOR_FEDERATION_ENDPOINT_RECEIPT is required}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

for command in kubectl python3; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done
[[ $cluster =~ ^actor-[a-z]{2}-[a-z][0-9]{2}$ ]] || { echo "invalid Cell identity" >&2; exit 2; }
[[ $subnet_id =~ ^subnet-[a-zA-Z0-9]+$ && $security_group_id =~ ^sg-[a-zA-Z0-9]+$ ]] || {
	echo "invalid Tencent subnet or security-group ID" >&2
	exit 2
}
[[ $receipt == /* && -d $(dirname -- "$receipt") && ! -e $receipt ]] || {
	echo "endpoint receipt must be a new absolute path with an existing parent" >&2
	exit 2
}
temporary=$(mktemp -d /data/tmp/actor-federation-endpoint.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
selector_json=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get service \
	actor-observability-prometheus -o json | \
	python3 -c 'import json,sys; selector=json.load(sys.stdin)["spec"].get("selector"); assert selector; print(json.dumps(selector,separators=(",",":")))')

python3 - "$namespace" "$service" "$subnet_id" "$security_group_id" "$hub_cidrs" "$selector_json" <<'PY' | kubectl "${kubeconfig_args[@]}" apply -f -
import ipaddress, json, sys
namespace, name, subnet, security_group, raw_cidrs, raw_selector = sys.argv[1:]
selector = json.loads(raw_selector)
cidrs = [item.strip() for item in raw_cidrs.split(",") if item.strip()]
if not cidrs:
    raise SystemExit("at least one Hub source CIDR is required")
for cidr in cidrs:
    network = ipaddress.ip_network(cidr, strict=False)
    if not network.is_private:
        raise SystemExit(f"Hub source CIDR must be private: {cidr}")
document = {
    "apiVersion": "v1", "kind": "Service",
    "metadata": {
        "name": name, "namespace": namespace,
        "labels": {"app.kubernetes.io/part-of": "actor-fleet"},
        "annotations": {
            "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid": subnet,
            "service.cloud.tencent.com/security-groups": security_group,
            "service.cloud.tencent.com/loadbalance-retain": "true",
        },
    },
    "spec": {
        "type": "LoadBalancer",
        "loadBalancerSourceRanges": cidrs,
        "selector": selector,
        "ports": [{"name": "http-web", "port": 9090, "protocol": "TCP", "targetPort": 9090}],
    },
}
print(json.dumps(document))
PY

kubectl "${kubeconfig_args[@]}" apply -f "$(dirname "$0")/spoke-rules.yaml"
for _ in $(seq 1 60); do
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get service "$service" -o json >"$temporary/live.json"
	endpoint=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print((d.get("status",{}).get("loadBalancer",{}).get("ingress") or [{}])[0].get("ip", ""))' "$temporary/live.json")
	load_balancer_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("metadata",{}).get("annotations",{}).get("service.kubernetes.io/loadbalance-id", ""))' "$temporary/live.json")
	[[ -n $endpoint && $load_balancer_id == lb-* ]] && break
	sleep 5
done
[[ -n ${endpoint:-} && ${load_balancer_id:-} == lb-* ]] || {
	echo "private federation CLB did not receive a stable address and identity" >&2
	exit 1
}
python3 - "$temporary/live.json" "$receipt" "$cluster" "$subnet_id" "$security_group_id" "$hub_cidrs" <<'PY'
import ipaddress, json, os, sys

live_path, output, cluster, subnet, security_group, raw_cidrs = sys.argv[1:]
live = json.load(open(live_path))
metadata, spec = live["metadata"], live["spec"]
ingress = live.get("status", {}).get("loadBalancer", {}).get("ingress", [])
if len(ingress) != 1:
    raise SystemExit("federation Service does not have exactly one endpoint")
address = ipaddress.ip_address(ingress[0].get("ip", ""))
cidrs = [str(ipaddress.ip_network(item.strip(), strict=False)) for item in raw_cidrs.split(",") if item.strip()]
if not address.is_private or spec.get("loadBalancerSourceRanges") != cidrs:
    raise SystemExit("federation Service address or source ranges differ")
annotations = metadata.get("annotations", {})
if (
    annotations.get("service.kubernetes.io/qcloud-loadbalancer-internal-subnetid") != subnet
    or annotations.get("service.cloud.tencent.com/security-groups") != security_group
    or not annotations.get("service.kubernetes.io/loadbalance-id", "").startswith("lb-")
):
    raise SystemExit("federation Service cloud identity differs")
ports = spec.get("ports", [])
if len(ports) != 1 or ports[0].get("port") != 9090 or ports[0].get("targetPort") != 9090:
    raise SystemExit("federation Service port contract differs")
result = {
    "schema": "actor-prometheus-federation-endpoint/v1", "verdict": "installed",
    "cluster": cluster, "endpoint": f"http://{address}:9090",
    "network": {"subnetId": subnet, "securityGroupId": security_group,
                "sourceCidrs": cidrs, "loadBalancerId": annotations["service.kubernetes.io/loadbalance-id"]},
    "service": {"namespace": metadata["namespace"], "name": metadata["name"], "uid": metadata["uid"]},
}
with open(output, "x") as stream:
    json.dump(result, stream, indent=2, sort_keys=True); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
PY
echo "spoke federation endpoint ready: $endpoint:9090 receipt=$receipt"
