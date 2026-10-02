#!/usr/bin/env bash
set -euo pipefail
umask 077

cell=${RIVET_CELL_NAME:?RIVET_CELL_NAME is required}
namespace=${RIVET_STATELESS_NAMESPACE:-actor-stateless-system}
cell_namespace=actor-fdb-cell-system
datacenter=${RIVET_DATACENTER_NAME:?RIVET_DATACENTER_NAME is required}
subnet_id=${RIVET_STATELESS_PRIVATE_SUBNET_ID:?RIVET_STATELESS_PRIVATE_SUBNET_ID is required}
hub_cidrs=${RIVET_STATELESS_HUB_CIDRS:?RIVET_STATELESS_HUB_CIDRS is required}
security_group=${RIVET_STATELESS_SECURITY_GROUP_ID:?RIVET_STATELESS_SECURITY_GROUP_ID is required}
receipt=${RIVET_STATELESS_ENDPOINT_RECEIPT:?RIVET_STATELESS_ENDPOINT_RECEIPT is required}
kubeconfig=${KUBECONFIG_PATH:-${KUBECONFIG:-}}

[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
	&& $datacenter =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ \
	&& $subnet_id =~ ^subnet-[A-Za-z0-9]+$ \
	&& $security_group =~ ^sg-[A-Za-z0-9]+$ \
	&& -n $kubeconfig && -f $kubeconfig \
	&& $receipt == /* && ! -e $receipt ]] || {
	echo "private stateless endpoint inputs are invalid" >&2
	exit 2
}
for command in kubectl python3 curl; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

service=${cell}-stateless-executor-private
source_service=${cell}-stateless-executor
temporary=$(mktemp -d /data/tmp/${cell}-stateless-endpoint.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM
kube=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")
"${kube[@]}" get service "$source_service" -o json >"$temporary/source.json"
"${kube[@]}" get deployment "${cell}-stateless-executor" -o json >"$temporary/deployment.json"
kubectl --kubeconfig "$kubeconfig" -n "$cell_namespace" get rivetcell "$cell" -o json >"$temporary/cell.json"

python3 - "$temporary/source.json" "$temporary/deployment.json" "$temporary/cell.json" \
	"$temporary/service.json" "$temporary/service-config.json" \
	"$cell" "$namespace" "$service" "$subnet_id" "$hub_cidrs" "$security_group" <<'PY'
import ipaddress,json,sys
source_path,deployment_path,cell_path,output,config_output,cell,namespace,name,subnet,raw_cidrs,security_group=sys.argv[1:]
source,deployment,cell_object=map(lambda path:json.load(open(path)),(source_path,deployment_path,cell_path))
if source.get("spec",{}).get("type") != "ClusterIP": raise SystemExit("source stateless Service must be ClusterIP")
selector=source.get("spec",{}).get("selector")
port=next((item for item in source.get("spec",{}).get("ports",[]) if item.get("name")=="http"),None)
if not isinstance(selector,dict) or not selector or not port or port.get("port") != 19084:
    raise SystemExit("source stateless Service contract differs")
status=deployment.get("status",{})
if status.get("readyReplicas") != 3 or status.get("updatedReplicas") != 3:
    raise SystemExit("stateless executor does not have three updated Ready replicas")
if cell_object.get("metadata",{}).get("name") != cell or not cell_object.get("metadata",{}).get("uid"):
    raise SystemExit("live RivetCell identity differs")
cidrs=[]
for raw in raw_cidrs.split(","):
    raw=raw.strip()
    if not raw: continue
    network=ipaddress.ip_network(raw,strict=False)
    if network.version != 4 or not network.is_private: raise SystemExit("Hub ranges must be private IPv4")
    cidrs.append(str(network))
cidrs=sorted(set(cidrs))
if not cidrs: raise SystemExit("at least one Hub range is required")
config_name=name+"-config"
config={
 "apiVersion":"cloud.tencent.com/v1alpha1","kind":"TkeServiceConfig",
 "metadata":{"name":config_name,"namespace":namespace,"labels":{
   "fleet.actor.dev/cell-name":cell,"fleet.actor.dev/component":"stateless-executor",
   "app.kubernetes.io/managed-by":"actor-stateless-endpoint"}},
 "spec":{"loadBalancer":{"l4Listeners":[{
   "protocol":"TCP","port":19084,"scheduler":"LEAST_CONN",
   "deregisterTargetRst":True}]}}}
value={
 "apiVersion":"v1","kind":"Service",
 "metadata":{"name":name,"namespace":namespace,"labels":{
   "fleet.actor.dev/cell-name":cell,"fleet.actor.dev/component":"stateless-executor",
   "app.kubernetes.io/managed-by":"actor-stateless-endpoint",
   "service.cloud.tencent.com/loadbalance-type":"INTERNAL"},
   "annotations":{"service.kubernetes.io/qcloud-loadbalancer-internal-subnetid":subnet,
                  "service.cloud.tencent.com/security-groups":security_group,
                  "service.cloud.tencent.com/pass-to-target":"true",
                  "service.cloud.tencent.com/tke-service-config":config_name,
                  "service.cloud.tencent.com/loadbalance-retain":"true"}},
 "spec":{"type":"LoadBalancer","externalTrafficPolicy":"Local","loadBalancerSourceRanges":cidrs,"selector":selector,
         "ports":[{"name":"http","port":19084,"protocol":"TCP","targetPort":"executor"}]}}
json.dump(value,open(output,"w"),sort_keys=True)
json.dump(config,open(config_output,"w"),sort_keys=True)
PY
"${kube[@]}" apply -f "$temporary/service-config.json" >/dev/null
"${kube[@]}" apply -f "$temporary/service.json" >/dev/null

deadline=$((SECONDS + 600))
endpoint=
while ((SECONDS < deadline)); do
	"${kube[@]}" get service "$service" -o json >"$temporary/live.json"
	endpoint=$(python3 - "$temporary/live.json" <<'PY'
import json,sys
items=json.load(open(sys.argv[1])).get("status",{}).get("loadBalancer",{}).get("ingress",[])
print(items[0].get("ip","") if len(items)==1 else "")
PY
	)
	[[ -n $endpoint ]] && break
	sleep 5
done
[[ -n $endpoint ]] || { echo "private stateless load balancer did not receive one address" >&2; exit 1; }
load_balancer_id=$(python3 - "$temporary/live.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1])).get("metadata",{}).get("annotations",{}).get("service.kubernetes.io/loadbalance-id",""))
PY
)
[[ $load_balancer_id =~ ^lb-[A-Za-z0-9]+$ ]] || { echo "stateless endpoint has no Tencent CLB identity" >&2; exit 1; }

http_status=
for _ in $(seq 1 60); do
	http_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
		--connect-timeout 3 --max-time 5 "http://$endpoint:19084/healthz" || true)
	[[ $http_status == 204 ]] && break
	sleep 2
done
[[ $http_status == 204 ]] || { echo "private stateless endpoint did not become healthy" >&2; exit 1; }
"${kube[@]}" get endpoints "$service" -o json >"$temporary/endpoints.json"
"${kube[@]}" get tkeserviceconfig.cloud.tencent.com "${service}-config" -o json \
	>"$temporary/service-config-live.json"

mkdir -p "$(dirname -- "$receipt")"
python3 - "$temporary/service.json" "$temporary/live.json" "$temporary/cell.json" \
	"$temporary/deployment.json" "$temporary/endpoints.json" "$temporary/service-config-live.json" \
	"$receipt" "$cell" "$datacenter" \
	"$subnet_id" "$endpoint" "$security_group" "$load_balancer_id" <<'PY'
import hashlib,ipaddress,json,os,sys,tempfile
expected_path,live_path,cell_path,deployment_path,endpoints_path,config_path,output,cell,datacenter,subnet,endpoint,security_group,lb_id=sys.argv[1:]
expected,live,cell_object,deployment,endpoints,config=map(lambda path:json.load(open(path)),(expected_path,live_path,cell_path,deployment_path,endpoints_path,config_path))
spec=live.get("spec",{})
if spec.get("type") != "LoadBalancer" or spec.get("selector") != expected["spec"]["selector"]:
    raise SystemExit("live stateless endpoint selector differs")
if spec.get("externalTrafficPolicy") != "Local": raise SystemExit("live stateless endpoint forwarding policy differs")
if sorted(spec.get("loadBalancerSourceRanges",[])) != expected["spec"]["loadBalancerSourceRanges"]:
    raise SystemExit("live stateless endpoint source ranges differ")
annotations=live.get("metadata",{}).get("annotations",{})
config_name=expected["metadata"]["annotations"]["service.cloud.tencent.com/tke-service-config"]
if annotations.get("service.cloud.tencent.com/security-groups") != security_group or annotations.get("service.cloud.tencent.com/pass-to-target") != "true" or annotations.get("service.cloud.tencent.com/loadbalance-retain") != "true" or annotations.get("service.cloud.tencent.com/tke-service-config") != config_name or annotations.get("service.kubernetes.io/loadbalance-id") != lb_id:
    raise SystemExit("live stateless endpoint cloud identity differs")
listeners=config.get("spec",{}).get("loadBalancer",{}).get("l4Listeners",[])
if (config.get("metadata",{}).get("name") != config_name or len(listeners) != 1
    or listeners[0] != {"protocol":"TCP","port":19084,"scheduler":"LEAST_CONN","deregisterTargetRst":True}):
    raise SystemExit("live stateless endpoint scheduler differs")
if not ipaddress.ip_address(endpoint).is_private: raise SystemExit("stateless endpoint is not private")
addresses={address["ip"] for subset in endpoints.get("subsets",[]) for address in subset.get("addresses",[]) if address.get("ip")}
if len(addresses) != 3: raise SystemExit("stateless endpoint does not have three Ready backends")
metadata=live["metadata"]
value={"schema":"actor-stateless-private-endpoint/v1","verdict":"passed",
 "cell":{"name":cell,"uid":cell_object["metadata"]["uid"]},"datacenter":datacenter,
 "endpoint":f"http://{endpoint}:19084",
 "network":{"subnetId":subnet,"hubSourceCidrs":expected["spec"]["loadBalancerSourceRanges"],
            "securityGroupId":security_group,"loadBalancerId":lb_id},
 "service":{"namespace":metadata["namespace"],"name":metadata["name"],"uid":metadata["uid"],
            "resourceVersion":metadata["resourceVersion"],"readyEndpointCount":len(addresses),
            "listenerPort":19084,"targetPort":"executor","externalTrafficPolicy":"Local",
            "scheduler":"LEAST_CONN"},
 "serviceConfig":{"name":config_name,"uid":config["metadata"]["uid"],
                  "resourceVersion":config["metadata"]["resourceVersion"]},
 "deployment":{"uid":deployment["metadata"]["uid"],"generation":deployment["metadata"]["generation"],
               "readyReplicas":deployment["status"]["readyReplicas"]},"probe":{"path":"/healthz","status":204}}
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
printf 'stateless_private_endpoint=passed cell=%s endpoint=http://%s:19084 receipt=%s\n' \
	"$cell" "$endpoint" "$receipt"
