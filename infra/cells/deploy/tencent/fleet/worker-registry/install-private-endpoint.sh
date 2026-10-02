#!/usr/bin/env bash
set -euo pipefail
umask 077

namespace=worker-registry-system
source_service=worker-registry
service=worker-registry-private
subnet=${ACTOR_WORKER_REGISTRY_PRIVATE_SUBNET_ID:?ACTOR_WORKER_REGISTRY_PRIVATE_SUBNET_ID is required}
source_cidrs=${ACTOR_WORKER_REGISTRY_SOURCE_CIDRS:?ACTOR_WORKER_REGISTRY_SOURCE_CIDRS is required}
security_group=${ACTOR_WORKER_REGISTRY_SECURITY_GROUP_ID:?ACTOR_WORKER_REGISTRY_SECURITY_GROUP_ID is required}
receipt=${ACTOR_WORKER_REGISTRY_ENDPOINT_RECEIPT:?ACTOR_WORKER_REGISTRY_ENDPOINT_RECEIPT is required}
kubeconfig=${HUB_KUBECONFIG:-${KUBECONFIG:-}}
python=${PYTHON:-python3}

[[ $subnet =~ ^subnet-[A-Za-z0-9]+$ && $security_group =~ ^sg-[A-Za-z0-9]+$ ]] || {
	echo "invalid private Registry cloud identity" >&2; exit 2;
}
[[ -n $kubeconfig && -f $kubeconfig && ! -L $kubeconfig ]] || {
	echo "HUB_KUBECONFIG must be a non-symlink regular file" >&2; exit 2;
}
[[ $receipt == /* && -d $(dirname -- "$receipt") && ! -e $receipt ]] || {
	echo "endpoint receipt must be a new absolute path" >&2; exit 2;
}
for command in kubectl curl "$python"; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done

temporary=$(mktemp -d /data/tmp/worker-registry-private-endpoint.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM
k=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")
"${k[@]}" get service "$source_service" -o json >"$temporary/source.json"
"${k[@]}" get deployment worker-registry -o json >"$temporary/deployment.json"

"$python" - "$temporary/source.json" "$temporary/deployment.json" "$temporary/service.json" \
	"$subnet" "$source_cidrs" "$security_group" <<'PY'
import ipaddress,json,sys
source_path,deployment_path,output,subnet,raw_cidrs,security_group=sys.argv[1:]
source=json.load(open(source_path)); deployment=json.load(open(deployment_path)); spec=source.get("spec",{})
if spec.get("type") != "ClusterIP" or not isinstance(spec.get("selector"),dict) or not spec["selector"]:
    raise SystemExit("source Worker Registry Service must be a selectable ClusterIP")
port=next((item for item in spec.get("ports",[]) if item.get("name")=="http"),None)
if not port or port.get("port") != 8080:
    raise SystemExit("source Worker Registry Service does not expose http:8080")
status=deployment.get("status",{})
if status.get("readyReplicas") != 3 or status.get("updatedReplicas") != 3:
    raise SystemExit("Worker Registry does not have three updated Ready replicas")
cidrs=[]
for raw in raw_cidrs.split(","):
    if not raw.strip(): continue
    network=ipaddress.ip_network(raw.strip(),strict=False)
    if network.version != 4 or network.prefixlen < 12 or not network.is_private:
        raise SystemExit(f"unsafe Worker Registry source range: {raw}")
    cidrs.append(str(network))
cidrs=sorted(set(cidrs))
if not cidrs or len(cidrs)>16: raise SystemExit("Worker Registry requires 1..16 source ranges")
value={"apiVersion":"v1","kind":"Service","metadata":{"name":"worker-registry-private","namespace":"worker-registry-system","labels":{"app.kubernetes.io/name":"worker-registry","app.kubernetes.io/part-of":"rivet-worker-registry","app.kubernetes.io/managed-by":"actor-worker-registry-endpoint","service.cloud.tencent.com/loadbalance-type":"INTERNAL"},"annotations":{"service.kubernetes.io/qcloud-loadbalancer-internal-subnetid":subnet,"service.cloud.tencent.com/security-groups":security_group,"service.cloud.tencent.com/pass-to-target":"true","service.cloud.tencent.com/loadbalance-retain":"true"}},"spec":{"type":"LoadBalancer","externalTrafficPolicy":"Cluster","loadBalancerSourceRanges":cidrs,"selector":spec["selector"],"ports":[{"name":"http","port":8080,"protocol":"TCP","targetPort":"http"}]}}
json.dump(value,open(output,"w"),sort_keys=True)
PY

"${k[@]}" apply -f "$temporary/service.json" >/dev/null
endpoint=
load_balancer_id=
for _ in $(seq 1 120); do
	"${k[@]}" get service "$service" -o json >"$temporary/live.json"
	endpoint=$(jq -r '.status.loadBalancer.ingress | if length == 1 then .[0].ip // "" else "" end' "$temporary/live.json")
	load_balancer_id=$(jq -r '.metadata.annotations["service.kubernetes.io/loadbalance-id"] // ""' "$temporary/live.json")
	[[ -n $endpoint && $load_balancer_id == lb-* ]] && break
	sleep 5
done
[[ -n $endpoint && $load_balancer_id == lb-* ]] || {
	echo "private Worker Registry CLB has no stable address and load-balancer identity" >&2
	exit 1
}
for _ in $(seq 1 90); do
	curl -fsS --connect-timeout 3 --max-time 5 "http://$endpoint:8080/readyz" >"$temporary/ready.json" 2>/dev/null && break
	sleep 2
done
jq -e '.status == "ready"' "$temporary/ready.json" >/dev/null
"${k[@]}" get endpoints "$service" -o json >"$temporary/endpoints.json"

"$python" - "$temporary/service.json" "$temporary/live.json" "$temporary/deployment.json" \
	"$temporary/endpoints.json" "$receipt" "$endpoint" <<'PY'
import hashlib,ipaddress,json,os,sys,tempfile
expected_path,live_path,deployment_path,endpoints_path,output,endpoint=sys.argv[1:]
expected,live,deployment,endpoints=(json.load(open(p)) for p in (expected_path,live_path,deployment_path,endpoints_path))
spec=live.get("spec",{}); annotations=live.get("metadata",{}).get("annotations",{})
if spec.get("type")!="LoadBalancer" or spec.get("selector")!=expected["spec"]["selector"] or spec.get("externalTrafficPolicy")!="Cluster": raise SystemExit("live Registry Service differs")
if spec.get("loadBalancerSourceRanges")!=expected["spec"]["loadBalancerSourceRanges"]: raise SystemExit("live Registry source ranges differ")
if not ipaddress.ip_address(endpoint).is_private: raise SystemExit("Registry address is not private")
addresses=sorted({a["ip"] for subset in endpoints.get("subsets",[]) for a in subset.get("addresses",[])})
if len(addresses)!=3: raise SystemExit("Registry private Service does not have three Ready endpoints")
image=deployment["spec"]["template"]["spec"]["containers"][0]["image"]
lb=annotations.get("service.kubernetes.io/loadbalance-id","")
if "@sha256:" not in image or not lb.startswith("lb-"): raise SystemExit("Registry image or CLB identity is mutable")
value={"schema":"actor-worker-registry-private-endpoint/v1","verdict":"installed","endpoint":f"http://{endpoint}:8080","network":{"subnetId":annotations["service.kubernetes.io/qcloud-loadbalancer-internal-subnetid"],"sourceCidrs":spec["loadBalancerSourceRanges"],"securityGroupId":annotations["service.cloud.tencent.com/security-groups"],"loadBalancerId":lb},"service":{"namespace":live["metadata"]["namespace"],"name":live["metadata"]["name"],"uid":live["metadata"]["uid"],"readyEndpointCount":len(addresses)},"deployment":{"uid":deployment["metadata"]["uid"],"image":image,"readyReplicas":deployment["status"]["readyReplicas"]},"probe":{"path":"/readyz","status":200}}
fd,staged=tempfile.mkstemp(prefix="."+os.path.basename(output)+".",dir=os.path.dirname(output))
try:
    os.fchmod(fd,0o644)
    with os.fdopen(fd,"w") as stream:
        json.dump(value,stream,indent=2,sort_keys=True); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
    os.link(staged,output)
finally:
    try: os.unlink(staged)
    except FileNotFoundError: pass
PY
printf 'worker_registry_private_endpoint=installed endpoint=http://%s:8080 receipt=%s\n' "$endpoint" "$receipt"
