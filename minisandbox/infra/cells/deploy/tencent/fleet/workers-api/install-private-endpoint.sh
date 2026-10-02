#!/usr/bin/env bash
set -euo pipefail
umask 077

namespace=workers-api-system
source_service=workers-api
service=workers-api-private
public_port=6688
subnet_id=${ACTOR_WORKERS_API_PRIVATE_SUBNET_ID:?ACTOR_WORKERS_API_PRIVATE_SUBNET_ID is required}
source_cidrs=${ACTOR_WORKERS_API_SOURCE_CIDRS:?ACTOR_WORKERS_API_SOURCE_CIDRS is required}
security_group=${ACTOR_WORKERS_API_SECURITY_GROUP_ID:?ACTOR_WORKERS_API_SECURITY_GROUP_ID is required}
receipt=${ACTOR_WORKERS_API_ENDPOINT_RECEIPT:?ACTOR_WORKERS_API_ENDPOINT_RECEIPT is required}
kubeconfig=${HUB_KUBECONFIG:-${KUBECONFIG:-}}
python=${PYTHON:-python3}

[[ $subnet_id =~ ^subnet-[A-Za-z0-9]+$ ]] || { echo "invalid private endpoint subnet ID" >&2; exit 2; }
[[ $security_group =~ ^sg-[A-Za-z0-9]+$ ]] || { echo "invalid Workers API security group ID" >&2; exit 2; }
[[ -n $kubeconfig && -f $kubeconfig && ! -L $kubeconfig ]] || {
	echo "HUB_KUBECONFIG must be a non-symlink regular file" >&2
	exit 2
}
[[ $receipt == /* && -d $(dirname -- "$receipt") && ! -e $receipt ]] || {
	echo "endpoint receipt must be a new absolute path with an existing parent" >&2
	exit 2
}
for command in kubectl curl; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done
command -v "$python" >/dev/null || { echo "PYTHON interpreter is unavailable: $python" >&2; exit 2; }
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
	echo "PYTHON must select Python 3.10 or newer" >&2
	exit 2
}

temporary=$(mktemp -d /data/tmp/workers-api-private-endpoint.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
kube=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")
"${kube[@]}" get service "$source_service" -o json >"$temporary/source.json"
"${kube[@]}" get deployment workers-api -o json >"$temporary/deployment.json"

"$python" - "$temporary/source.json" "$temporary/deployment.json" "$temporary/service.json" \
	"$namespace" "$service" "$subnet_id" "$source_cidrs" "$security_group" <<'PY'
import ipaddress
import json
import sys

source_path, deployment_path, output, namespace, name, subnet, raw_cidrs, security_group = sys.argv[1:]
source = json.load(open(source_path))
deployment = json.load(open(deployment_path))
spec = source.get("spec", {})
if spec.get("type") != "ClusterIP":
    raise SystemExit("source Workers API Service must be ClusterIP")
selector = spec.get("selector")
if not isinstance(selector, dict) or not selector:
    raise SystemExit("source Workers API Service has no selector")
ports = spec.get("ports", [])
http = next((item for item in ports if item.get("name") == "http"), None)
if not http or http.get("port") != 8080:
    raise SystemExit("source Workers API Service does not expose HTTP port 8080")
status = deployment.get("status", {})
replicas = deployment.get("spec", {}).get("replicas")
if (
    not isinstance(replicas, int)
    or replicas < 3
    or status.get("readyReplicas") != replicas
    or status.get("updatedReplicas") != replicas
    or status.get("availableReplicas") != replicas
):
    raise SystemExit("Workers API does not have its HPA-managed replica target Ready")
cidrs = []
for raw in raw_cidrs.split(","):
    raw = raw.strip()
    if not raw:
        continue
    network = ipaddress.ip_network(raw, strict=False)
    if (
        network.version != 4
        or network.prefixlen < 12
        or network.is_unspecified
        or network.is_multicast
        or network.is_loopback
    ):
        raise SystemExit(f"Workers API source range is unsafe: {raw}")
    cidrs.append(str(network))
cidrs = sorted(set(cidrs))
if not cidrs or len(cidrs) > 16:
    raise SystemExit("Workers API requires between one and sixteen bounded source ranges")
document = {
    "apiVersion": "v1",
    "kind": "Service",
    "metadata": {
        "name": name,
        "namespace": namespace,
        "labels": {
            "app.kubernetes.io/name": "workers-api",
            "app.kubernetes.io/part-of": "rivet-workers-api",
            "app.kubernetes.io/managed-by": "actor-workers-api-endpoint",
            "service.cloud.tencent.com/loadbalance-type": "INTERNAL",
        },
        "annotations": {
            "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid": subnet,
            "service.cloud.tencent.com/security-groups": security_group,
            "service.cloud.tencent.com/pass-to-target": "true",
        },
    },
    "spec": {
        "type": "LoadBalancer",
        # Workers API does not consume the original client IP. Cluster policy
        # keeps every CLB node target usable while one API Pod is replaced;
        # the qualified CLB security group remains the source boundary.
        "externalTrafficPolicy": "Cluster",
        "loadBalancerSourceRanges": cidrs,
        "selector": selector,
        "ports": [{"name": "http", "port": 6688, "protocol": "TCP", "targetPort": "http"}],
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
	endpoint=$("$python" - "$temporary/live.json" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1]))
items = value.get("status", {}).get("loadBalancer", {}).get("ingress", [])
print(items[0].get("ip", "") if len(items) == 1 else "")
PY
	)
	[[ -n $endpoint ]] && break
	sleep 5
done
[[ -n $endpoint ]] || { echo "private Workers API load balancer did not receive one address" >&2; exit 1; }

load_balancer_id=$("$python" - "$temporary/live.json" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1]))
print(value.get("metadata", {}).get("annotations", {}).get("service.kubernetes.io/loadbalance-id", ""))
PY
)
[[ $load_balancer_id =~ ^lb-[A-Za-z0-9]+$ ]] || {
	echo "private Workers API Service has no valid Tencent CLB identity" >&2
	exit 1
}

ready=false
for _ in $(seq 1 60); do
	if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
		"http://$endpoint:$public_port/readyz" >"$temporary/ready.json" 2>"$temporary/curl-error"; then
		ready=true
		break
	fi
	sleep 2
done
if [[ $ready != true ]]; then
	cat "$temporary/curl-error" >&2
	echo "private Workers API endpoint did not become ready" >&2
	exit 1
fi

"${kube[@]}" get endpoints "$service" -o json >"$temporary/endpoints.json"
"$python" - "$temporary/service.json" "$temporary/live.json" "$temporary/source.json" \
	"$temporary/deployment.json" "$temporary/endpoints.json" "$temporary/ready.json" \
	"$receipt" "$subnet_id" "$endpoint" "$security_group" "$load_balancer_id" <<'PY'
import hashlib
import ipaddress
import json
import os
import sys
import tempfile

expected_path, live_path, source_path, deployment_path, endpoints_path, ready_path, output, subnet, endpoint, security_group, load_balancer_id = sys.argv[1:]
expected, live, source, deployment, endpoints = map(
    lambda path: json.load(open(path)),
    (expected_path, live_path, source_path, deployment_path, endpoints_path),
)
spec = live.get("spec", {})
if spec.get("type") != "LoadBalancer" or spec.get("selector") != expected["spec"]["selector"]:
    raise SystemExit("live private Workers API Service differs from the source selector")
if spec.get("externalTrafficPolicy") != "Cluster":
    raise SystemExit("live private Workers API Service does not use HA Cluster forwarding")
if sorted(spec.get("loadBalancerSourceRanges", [])) != expected["spec"]["loadBalancerSourceRanges"]:
    raise SystemExit("live private Workers API source ranges differ")
if live.get("metadata", {}).get("annotations", {}).get(
    "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid"
) != subnet:
    raise SystemExit("live private Workers API subnet differs")
annotations = live.get("metadata", {}).get("annotations", {})
if annotations.get("service.cloud.tencent.com/security-groups") != security_group:
    raise SystemExit("live private Workers API security group differs")
if annotations.get("service.cloud.tencent.com/pass-to-target") != "true":
    raise SystemExit("live private Workers API pass-to-target contract differs")
if annotations.get("service.kubernetes.io/loadbalance-id") != load_balancer_id:
    raise SystemExit("live private Workers API CLB identity differs")
if not ipaddress.ip_address(endpoint).is_private:
    raise SystemExit("Workers API endpoint is not private")
addresses = sorted({
    address["ip"]
    for subset in endpoints.get("subsets", [])
    for address in subset.get("addresses", [])
    if isinstance(address.get("ip"), str)
})
if len(addresses) < 3:
    raise SystemExit("private Workers API Service has fewer than three Ready endpoints")
ready_bytes = open(ready_path, "rb").read()
ready_value = json.loads(ready_bytes)
if ready_value.get("status") != "ready":
    raise SystemExit("private Workers API readiness response is invalid")
metadata = live["metadata"]
source_metadata = source["metadata"]
deployment_metadata = deployment["metadata"]
image = deployment["spec"]["template"]["spec"]["containers"][0]["image"]
if "@sha256:" not in image:
    raise SystemExit("Workers API image is not digest pinned")
value = {
    "schema": "actor-workers-api-private-endpoint-installation/v3",
    "verdict": "installed",
    "endpoint": f"http://{endpoint}:6688",
    "network": {
        "subnetId": subnet,
        "sourceCidrs": expected["spec"]["loadBalancerSourceRanges"],
        "securityGroupId": security_group,
        "loadBalancerId": load_balancer_id,
    },
    "service": {
        "namespace": metadata["namespace"], "name": metadata["name"],
        "uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"],
        "sourceServiceUid": source_metadata["uid"], "readyEndpointCount": len(addresses),
        "listenerPort": 6688, "targetPort": "http", "externalTrafficPolicy": "Cluster",
    },
    "deployment": {
        "uid": deployment_metadata["uid"], "generation": deployment_metadata["generation"],
        "image": image, "readyReplicas": deployment["status"]["readyReplicas"],
    },
    "probe": {
        "path": "/readyz", "responseBytes": len(ready_bytes),
        "responseSha256": "sha256:" + hashlib.sha256(ready_bytes).hexdigest(),
    },
}
descriptor, staged = tempfile.mkstemp(prefix="." + os.path.basename(output) + ".", dir=os.path.dirname(output))
try:
    os.fchmod(descriptor, 0o644)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.link(staged, output)
finally:
    try:
        os.unlink(staged)
    except FileNotFoundError:
        pass
PY

printf 'workers_api_private_endpoint=installed endpoint=http://%s:%s receipt=%s\n' \
	"$endpoint" "$public_port" "$receipt"
