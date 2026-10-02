#!/usr/bin/env bash
set -euo pipefail
umask 077

namespace=workers-api-system
source_service=workers-object-router
service=workers-object-router-private
listener_port=19085
subnet_id=${ACTOR_OBJECT_ROUTER_PRIVATE_SUBNET_ID:?ACTOR_OBJECT_ROUTER_PRIVATE_SUBNET_ID is required}
source_cidrs=${ACTOR_OBJECT_ROUTER_SOURCE_CIDRS:?ACTOR_OBJECT_ROUTER_SOURCE_CIDRS is required}
security_group=${ACTOR_OBJECT_ROUTER_SECURITY_GROUP_ID:?ACTOR_OBJECT_ROUTER_SECURITY_GROUP_ID is required}
receipt=${ACTOR_OBJECT_ROUTER_ENDPOINT_RECEIPT:?ACTOR_OBJECT_ROUTER_ENDPOINT_RECEIPT is required}
kubeconfig=${HUB_KUBECONFIG:-${KUBECONFIG:-}}
python=${PYTHON:-python3}

[[ $subnet_id =~ ^subnet-[A-Za-z0-9]+$ \
	&& $security_group =~ ^sg-[A-Za-z0-9]+$ \
	&& -n $kubeconfig && -f $kubeconfig && ! -L $kubeconfig \
	&& $receipt == /* && -d $(dirname -- "$receipt") && ! -e $receipt ]] || {
	echo "private Object Router endpoint inputs are invalid" >&2
	exit 2
}
for command in kubectl curl "$python"; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

temporary=$(mktemp -d /data/tmp/workers-object-router-endpoint.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM
kube=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")
"${kube[@]}" get service "$source_service" -o json >"$temporary/source.json"
"${kube[@]}" get deployment workers-api -o json >"$temporary/deployment.json"

"$python" - "$temporary/source.json" "$temporary/deployment.json" "$temporary/service.json" \
	"$namespace" "$service" "$subnet_id" "$source_cidrs" "$security_group" "$listener_port" <<'PY'
import ipaddress,json,sys
source_path,deployment_path,output,namespace,name,subnet,raw_cidrs,security_group,listener_port=sys.argv[1:]
source,deployment=map(lambda path:json.load(open(path)),(source_path,deployment_path))
spec=source.get("spec",{})
port=next((item for item in spec.get("ports",[]) if item.get("name")=="object-router"),None)
if spec.get("type") != "ClusterIP" or not spec.get("selector") or not port or port.get("port") != 8081:
    raise SystemExit("source Object Router Service contract differs")
status=deployment.get("status",{})
replicas=deployment.get("spec",{}).get("replicas")
if not isinstance(replicas,int) or replicas < 3 or status.get("readyReplicas") != replicas or status.get("updatedReplicas") != replicas or status.get("availableReplicas") != replicas:
    raise SystemExit("Object Router does not have its HPA-managed replica target Ready")
cidrs=[]
for raw in raw_cidrs.split(","):
    raw=raw.strip()
    if not raw: continue
    network=ipaddress.ip_network(raw,strict=False)
    if network.version != 4 or network.prefixlen < 12 or network.is_unspecified or network.is_multicast or network.is_loopback:
        raise SystemExit(f"Object Router source range is unsafe: {raw}")
    cidrs.append(str(network))
cidrs=sorted(set(cidrs))
if not 1 <= len(cidrs) <= 16: raise SystemExit("Object Router requires one to sixteen bounded source ranges")
value={"apiVersion":"v1","kind":"Service","metadata":{"name":name,"namespace":namespace,
 "labels":{"app.kubernetes.io/name":"workers-object-router","app.kubernetes.io/part-of":"rivet-workers-api",
           "app.kubernetes.io/managed-by":"actor-object-router-endpoint",
           "service.cloud.tencent.com/loadbalance-type":"INTERNAL"},
 "annotations":{"service.kubernetes.io/qcloud-loadbalancer-internal-subnetid":subnet,
                "service.cloud.tencent.com/security-groups":security_group,
                "service.cloud.tencent.com/pass-to-target":"true"}},
 "spec":{"type":"LoadBalancer","externalTrafficPolicy":"Cluster","loadBalancerSourceRanges":cidrs,
         "selector":spec["selector"],"ports":[{"name":"object-router","port":int(listener_port),
         "protocol":"TCP","targetPort":"object-router"}]}}
json.dump(value,open(output,"w"),sort_keys=True)
PY
"${kube[@]}" apply -f "$temporary/service.json" >/dev/null

deadline=$((SECONDS + 600))
endpoint=
while ((SECONDS < deadline)); do
	"${kube[@]}" get service "$service" -o json >"$temporary/live.json"
	endpoint=$("$python" - "$temporary/live.json" <<'PY'
import json,sys
items=json.load(open(sys.argv[1])).get("status",{}).get("loadBalancer",{}).get("ingress",[])
print(items[0].get("ip","") if len(items)==1 else "")
PY
	)
	[[ -n $endpoint ]] && break
	sleep 5
done
[[ -n $endpoint ]] || { echo "private Object Router load balancer did not receive one address" >&2; exit 1; }
load_balancer_id=$("$python" - "$temporary/live.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1])).get("metadata",{}).get("annotations",{}).get("service.kubernetes.io/loadbalance-id",""))
PY
)
[[ $load_balancer_id =~ ^lb-[A-Za-z0-9]+$ ]] || { echo "Object Router Service has no Tencent CLB identity" >&2; exit 1; }

# The internal listener intentionally exposes no unauthenticated health route.
# A 404 proves that the dedicated listener is reachable without granting the
# installer a Cell capability token.
http_status=
for _ in $(seq 1 60); do
	http_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
		--connect-timeout 3 --max-time 5 "http://$endpoint:$listener_port/healthz" || true)
	[[ $http_status == 404 ]] && break
	sleep 2
done
[[ $http_status == 404 ]] || { echo "private Object Router listener did not become reachable" >&2; exit 1; }

"${kube[@]}" get endpoints "$service" -o json >"$temporary/endpoints.json"
mkdir -p "$(dirname -- "$receipt")"
"$python" - "$temporary/service.json" "$temporary/live.json" "$temporary/source.json" \
	"$temporary/deployment.json" "$temporary/endpoints.json" "$receipt" "$subnet_id" "$endpoint" \
	"$security_group" "$load_balancer_id" "$listener_port" <<'PY'
import ipaddress,json,os,sys,tempfile
expected_path,live_path,source_path,deployment_path,endpoints_path,output,subnet,endpoint,security_group,lb_id,listener_port=sys.argv[1:]
expected,live,source,deployment,endpoints=map(lambda path:json.load(open(path)),
 (expected_path,live_path,source_path,deployment_path,endpoints_path))
spec=live.get("spec",{}); annotations=live.get("metadata",{}).get("annotations",{})
if spec.get("type") != "LoadBalancer" or spec.get("selector") != expected["spec"]["selector"]:
    raise SystemExit("live Object Router selector differs")
if spec.get("externalTrafficPolicy") != "Cluster" or sorted(spec.get("loadBalancerSourceRanges",[])) != expected["spec"]["loadBalancerSourceRanges"]:
    raise SystemExit("live Object Router forwarding policy differs")
if annotations.get("service.kubernetes.io/qcloud-loadbalancer-internal-subnetid") != subnet or annotations.get("service.cloud.tencent.com/security-groups") != security_group or annotations.get("service.cloud.tencent.com/pass-to-target") != "true" or annotations.get("service.kubernetes.io/loadbalance-id") != lb_id:
    raise SystemExit("live Object Router cloud identity differs")
if not ipaddress.ip_address(endpoint).is_private: raise SystemExit("Object Router endpoint is not private")
addresses={address["ip"] for subset in endpoints.get("subsets",[]) for address in subset.get("addresses",[]) if address.get("ip")}
if len(addresses) < 3: raise SystemExit("Object Router Service has fewer than three Ready endpoints")
metadata=live["metadata"]
value={"schema":"actor-object-router-private-endpoint/v1","verdict":"passed",
 "endpoint":f"{endpoint}:{listener_port}",
 "network":{"subnetId":subnet,"sourceCidrs":expected["spec"]["loadBalancerSourceRanges"],
            "securityGroupId":security_group,"loadBalancerId":lb_id},
 "service":{"namespace":metadata["namespace"],"name":metadata["name"],"uid":metadata["uid"],
            "resourceVersion":metadata["resourceVersion"],"sourceServiceUid":source["metadata"]["uid"],
            "readyEndpointCount":len(addresses),"listenerPort":int(listener_port),"targetPort":"object-router"},
 "deployment":{"uid":deployment["metadata"]["uid"],"generation":deployment["metadata"]["generation"],
               "image":deployment["spec"]["template"]["spec"]["containers"][0]["image"],
               "readyReplicas":deployment["status"]["readyReplicas"]},
 "probe":{"path":"/healthz","unauthenticatedStatus":404}}
fd,tmp=tempfile.mkstemp(prefix="."+os.path.basename(output)+".",dir=os.path.dirname(output))
try:
 os.fchmod(fd,0o644)
 with os.fdopen(fd,"w") as stream:
  json.dump(value,stream,indent=2,sort_keys=True); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
 os.link(tmp,output)
finally:
 try: os.unlink(tmp)
 except FileNotFoundError: pass
PY
printf 'object_router_private_endpoint=passed endpoint=%s:%s receipt=%s\n' "$endpoint" "$listener_port" "$receipt"
