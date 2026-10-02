#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 5 || $# -eq 6 ]] || {
	echo "Usage: install-application.sh APPLICATION_YAML PUBLICATION_RECEIPT DESIRED_RENDER_RECEIPT ENDPOINT_RECEIPT [OBJECT_ROUTER_ENDPOINT_RECEIPT] CONVERGENCE_RECEIPT" >&2
	exit 2
}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${HUB_KUBECONFIG:?HUB_KUBECONFIG must name management cluster C kubeconfig}"
python=${PYTHON:-python3.11}
application_yaml=$1
publication_receipt=$2
desired_render_receipt=$3
endpoint_receipt=$4
release_phase=$(jq -er '.sources.phase' "$desired_render_receipt")
if [[ $release_phase == object-router-bootstrap && $# -eq 5 ]]; then
	object_router_endpoint_receipt=
	convergence_receipt=$5
	# The reviewed Workers API manifest owns 12 resources and the GitOps
	# overlay adds the existing private Workers API Service.
	expected_resource_count=13
elif [[ $release_phase == serving && $# -eq 6 ]]; then
	object_router_endpoint_receipt=$5
	convergence_receipt=$6
	# Serving adds both private Services to the same 12-resource manifest.
	expected_resource_count=14
else
	echo "Workers API release phase and endpoint arguments differ" >&2
	exit 2
fi

for command in curl kubectl jq sha256sum; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done
command -v "$python" >/dev/null && "$python" -c 'import sys; assert sys.version_info >= (3, 11)' || {
	echo "Workers API Argo installation requires Python 3.11 or newer" >&2
	exit 2
}
inputs=("$HUB_KUBECONFIG" "$application_yaml" "$publication_receipt" "$desired_render_receipt" "$endpoint_receipt")
[[ -z $object_router_endpoint_receipt ]] || inputs+=("$object_router_endpoint_receipt")
for path in "${inputs[@]}"; do
	[[ -f $path && ! -L $path ]] || { echo "input must be a regular non-symlink file: $path" >&2; exit 2; }
done
[[ $convergence_receipt == /* && ! -e $convergence_receipt && -d $(dirname -- "$convergence_receipt") ]] || {
	echo "convergence receipt must be a new absolute path with an existing parent" >&2
	exit 2
}

temporary=$(mktemp -d /data/tmp/actor-management-workers-api-adopt.XXXXXX)
registry_forward_pid=
cleanup() {
	if [[ -n ${registry_forward_pid:-} ]]; then
		kill "$registry_forward_pid" 2>/dev/null || true
		wait "$registry_forward_pid" 2>/dev/null || true
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

# Re-render before mutation. The bootstrap never applies a reviewed receipt with
# an independently edited Application definition.
"$python" "$script_dir/render-application.py" \
	--publication-receipt "$publication_receipt" \
	--desired-render-receipt "$desired_render_receipt" \
	--output "$temporary/expected.yaml" >/dev/null
cmp -s "$application_yaml" "$temporary/expected.yaml" || {
	echo "Application manifest differs from the receipt-bound rendering" >&2
	exit 1
}
revision=$(jq -er '.gitRevision' "$publication_receipt")
endpoint=$(jq -er '.endpoint' "$endpoint_receipt")
endpoint_uid=$(jq -er '.service.uid' "$endpoint_receipt")
object_router_endpoint=
object_router_endpoint_uid=
if [[ -n $object_router_endpoint_receipt ]]; then
	object_router_endpoint=$(jq -er '.endpoint' "$object_router_endpoint_receipt")
	object_router_endpoint_uid=$(jq -er '.service.uid' "$object_router_endpoint_receipt")
fi
deployment_uid=$(jq -er '.sources.deploymentUidAtAdoption' "$desired_render_receipt")
release_mode=$(jq -er '.sources.releaseMode' "$desired_render_receipt")
resumed_after_apply=false
external_secret_name=$(jq -er '.sources.externalCredentialName | select(test("^workers-api-internal-token-[0-9a-f]{12}$"))' "$desired_render_receipt")
[[ $release_mode == bootstrap-adoption || $release_mode == argocd-update ]] || {
	echo "Workers API release mode is invalid" >&2; exit 1;
}
[[ $(jq -er '.schema + ":" + .verdict' "$endpoint_receipt") == "actor-workers-api-private-endpoint-installation/v3:installed" ]] || {
	echo "private endpoint receipt did not pass" >&2; exit 1;
}
[[ $(jq -er '.sources.endpointInstallationReceiptSha256' "$desired_render_receipt") == "sha256:$(sha256sum "$endpoint_receipt" | cut -d' ' -f1)" ]] || {
	echo "desired rendering does not bind the supplied endpoint receipt" >&2; exit 1;
}
if [[ -n $object_router_endpoint_receipt ]]; then
	[[ $(jq -er '.schema + ":" + .verdict' "$object_router_endpoint_receipt") == "actor-object-router-private-endpoint/v1:passed" ]] || {
		echo "Object Router endpoint receipt did not pass" >&2; exit 1;
	}
	[[ $(jq -er '.sources.objectRouterEndpointReceiptSha256' "$desired_render_receipt") == "sha256:$(sha256sum "$object_router_endpoint_receipt" | cut -d' ' -f1)" ]] || {
		echo "desired rendering does not bind the supplied Object Router endpoint receipt" >&2; exit 1;
	}
else
	[[ $(jq -r '.sources.objectRouterEndpointReceiptSha256' "$desired_render_receipt") == null ]] || {
		echo "bootstrap desired state unexpectedly binds an Object Router endpoint" >&2; exit 1;
	}
fi

kube=(kubectl --kubeconfig "$HUB_KUBECONFIG")
if [[ $release_phase == serving ]]; then
	registry_endpoint=$("${kube[@]}" -n workers-api-system get configmap workers-api -o jsonpath='{.data.registry-url}')
	registry_probe_endpoint=$registry_endpoint
	readarray -t registry_service < <("$python" - "$registry_endpoint" <<'PY'
import sys,urllib.parse
parsed=urllib.parse.urlsplit(sys.argv[1])
labels=(parsed.hostname or "").split(".")
if parsed.scheme == "http" and len(labels) == 5 and labels[2:] == ["svc", "cluster", "local"]:
    if parsed.path.rstrip("/") or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise SystemExit("cluster-local Registry endpoint must be a credential-free origin")
    print(labels[0])
    print(labels[1])
    print(parsed.port or 80)
PY
	)
	if [[ ${#registry_service[@]} -eq 3 ]]; then
		registry_forward_port=${ACTOR_WORKER_REGISTRY_FORWARD_PORT:-38080}
		[[ $registry_forward_port =~ ^[0-9]+$ ]] && ((registry_forward_port >= 1024 && registry_forward_port <= 65535)) || {
			echo "ACTOR_WORKER_REGISTRY_FORWARD_PORT is invalid" >&2
			exit 2
		}
		"${kube[@]}" -n "${registry_service[1]}" port-forward \
			"service/${registry_service[0]}" "$registry_forward_port:${registry_service[2]}" \
			>"$temporary/registry-port-forward.log" 2>&1 &
		registry_forward_pid=$!
		registry_probe_endpoint="http://127.0.0.1:$registry_forward_port"
		for _ in $(seq 1 60); do
			if curl --fail --silent --max-time 1 "$registry_probe_endpoint/healthz" >/dev/null 2>&1; then break; fi
			kill -0 "$registry_forward_pid" 2>/dev/null || {
				cat "$temporary/registry-port-forward.log" >&2
				echo "Registry Service port-forward exited before verification" >&2
				exit 1
			}
			sleep 1
		done
		curl --fail --silent --max-time 2 "$registry_probe_endpoint/healthz" >/dev/null || {
			cat "$temporary/registry-port-forward.log" >&2
			echo "Registry Service port-forward did not become ready" >&2
			exit 1
		}
	fi
	"$python" "$script_dir/verify-registry-contract.py" \
		--endpoint "$registry_probe_endpoint" --namespace default --timeout 5 \
		>"$temporary/registry-contract.json" || {
		echo "Worker Registry is incompatible with stateless serving" >&2
		exit 1
	}
fi
"${kube[@]}" -n workers-api-system get deployment workers-api -o json >"$temporary/deployment-before.json"
"${kube[@]}" -n workers-api-system get service workers-api-private -o json >"$temporary/service-before.json"
if [[ -n $object_router_endpoint_receipt ]]; then
	"${kube[@]}" -n workers-api-system get service workers-object-router-private -o json >"$temporary/object-router-service-before.json"
fi
"${kube[@]}" -n workers-api-system get secret "$external_secret_name" -o json >"$temporary/secret-before.json"
"${kube[@]}" -n argocd get applications -o json >"$temporary/applications-before.json"
if [[ $release_mode == argocd-update ]]; then
	prior_revision=$(jq -er '.sources.priorArgoRevision | select(test("^[0-9a-f]{40}([0-9a-f]{24})?$"))' "$desired_render_receipt")
	"${kube[@]}" -n argocd get application actor-management-workers-api -o json >"$temporary/application-before.json"
	if jq -e --arg revision "$prior_revision" '
	  .spec.source.targetRevision == $revision and .status.sync.revision == $revision and
	  .status.sync.status == "Synced"
	' "$temporary/application-before.json" >/dev/null; then
		:
	elif jq -e --arg revision "$revision" '
	  .spec.source.targetRevision == $revision and .status.sync.revision == $revision and
	  .status.sync.status == "Synced" and .status.health.status == "Healthy" and
	  ((.status.conditions // []) | length == 0)
	' "$temporary/application-before.json" >/dev/null; then
		# A previous invocation can lose its local receipt after Argo has already
		# applied the exact published revision. Resume only from that fully
		# converged target; every partial or different revision remains closed.
		resumed_after_apply=true
	else
		echo "live Workers API Application is not at the receipt-bound prior revision" >&2
		exit 1
	fi
fi
mapfile -t cell_applications < <(jq -r '
  .items[] | select(any(.metadata.ownerReferences[]?; .kind == "ApplicationSet" and .name == "actor-cells")) |
  .metadata.name
' "$temporary/applications-before.json")
[[ ${#cell_applications[@]} -eq 2 ]] || { echo "Workers API adoption requires exactly two managed Cell Applications" >&2; exit 1; }
[[ $(jq -er '.metadata.uid' "$temporary/deployment-before.json") == "$deployment_uid" ]] || {
	echo "live Workers API Deployment is not the admitted adoption target" >&2; exit 1;
}
[[ $(jq -er '.metadata.uid' "$temporary/service-before.json") == "$endpoint_uid" ]] || {
	echo "live private Service is not the admitted adoption target" >&2; exit 1;
}
if [[ -n $object_router_endpoint_receipt ]]; then
	[[ $(jq -er '.metadata.uid' "$temporary/object-router-service-before.json") == "$object_router_endpoint_uid" ]] || {
		echo "live Object Router private Service is not the admitted adoption target" >&2; exit 1;
	}
fi

# C uses resource.inclusions as a global discovery allowlist. Merge only the
# exact serving kinds before creating the child Application; AppProject remains
# the authorization boundary, and Secret is deliberately absent.
"${kube[@]}" -n argocd get configmap argocd-cm -o json >"$temporary/argocd-cm.json"
management_cluster_ip=$("${kube[@]}" -n default get service kubernetes -o jsonpath='{.spec.clusterIP}')
management_cluster_url="https://$management_cluster_ip:443"
"$python" "$script_dir/merge-resource-inclusions.py" \
	--existing "$temporary/argocd-cm.json" --required "$script_dir/resource-inclusions.yaml" \
	--management-cluster-url "$management_cluster_url" \
	--output "$temporary/argocd-cm-merged.yaml"
inclusions_changed=$("$python" - "$temporary/argocd-cm.json" "$temporary/argocd-cm-merged.yaml" <<'PY'
import json,sys,yaml
existing=json.load(open(sys.argv[1])).get("data",{}).get("resource.inclusions","")
merged=yaml.safe_load(open(sys.argv[2]))["data"]["resource.inclusions"]
def normalized(value):
    return sorted(json.dumps(item,sort_keys=True,separators=(",",":")) for item in (yaml.safe_load(value) or []))
print("true" if normalized(existing) != normalized(merged) else "false")
PY
)
"${kube[@]}" apply --server-side --force-conflicts --field-manager=actor-management-bootstrap \
	-f "$temporary/argocd-cm-merged.yaml" >/dev/null
if [[ $inclusions_changed == true ]]; then
	"${kube[@]}" -n argocd rollout restart statefulset/argocd-application-controller >/dev/null
	"${kube[@]}" -n argocd rollout status statefulset/argocd-application-controller --timeout=5m >/dev/null
fi

# AppProject/Application are the one-time bootstrap root and deliberately stay
# outside their child Application. The child cannot create or mutate Secrets.
"${kube[@]}" apply --server-side --force-conflicts --field-manager=actor-management-bootstrap \
	-f "$application_yaml" >/dev/null
"${kube[@]}" -n argocd annotate application actor-management-workers-api \
	argocd.argoproj.io/refresh=hard --overwrite >/dev/null
for application in "${cell_applications[@]}"; do
	"${kube[@]}" -n argocd annotate application "$application" \
		argocd.argoproj.io/refresh=hard --overwrite >/dev/null
done

deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
	"${kube[@]}" -n argocd get application actor-management-workers-api -o json >"$temporary/application.json"
	if jq -e --arg revision "$revision" --arg count "$expected_resource_count" '
	  .status.sync.revision == $revision and .status.sync.status == "Synced" and .status.health.status == "Healthy" and
	  ((.status.conditions // []) | length == 0) and
	  (.status.resources | length == ($count | tonumber)) and all(.status.resources[]; .status == "Synced")
	' "$temporary/application.json" >/dev/null; then
		break
	fi
	sleep 5
done
jq -e --arg revision "$revision" --arg count "$expected_resource_count" '
  .status.sync.revision == $revision and .status.sync.status == "Synced" and .status.health.status == "Healthy" and
  ((.status.conditions // []) | length == 0) and
  (.status.resources | length == ($count | tonumber)) and all(.status.resources[]; .status == "Synced")
' "$temporary/application.json" >/dev/null || { echo "Workers API Argo Application did not converge" >&2; exit 1; }
deadline=$((SECONDS + 300))
while ((SECONDS < deadline)); do
	"${kube[@]}" -n argocd get applications -o json >"$temporary/applications-after.json"
	if "$python" - "$temporary/applications-before.json" "$temporary/applications-after.json" 2>/dev/null <<'PY'
import json,sys
before,after=(json.load(open(path)) for path in sys.argv[1:])
def cells(value):
    return {
        item["metadata"]["name"]: item
        for item in value["items"]
        if any(owner.get("kind")=="ApplicationSet" and owner.get("name")=="actor-cells" for owner in item["metadata"].get("ownerReferences",[]))
    }
b,a=cells(before),cells(after)
assert len(b)==len(a)==2 and set(b)==set(a)
for name in b:
    assert a[name]["spec"]["source"] == b[name]["spec"]["source"]
    assert a[name].get("status",{}).get("sync",{}).get("status") == "Synced"
    assert a[name].get("status",{}).get("health",{}).get("status") == "Healthy"
PY
	then break; fi
	sleep 5
done
"$python" - "$temporary/applications-before.json" "$temporary/applications-after.json" <<'PY'
import json,sys
before,after=(json.load(open(path)) for path in sys.argv[1:])
def cells(value):
    return {item["metadata"]["name"]:item for item in value["items"] if any(
        owner.get("kind")=="ApplicationSet" and owner.get("name")=="actor-cells"
        for owner in item["metadata"].get("ownerReferences",[]))}
b,a=cells(before),cells(after)
assert len(b)==len(a)==2 and set(b)==set(a)
assert all(a[n]["spec"]["source"]==b[n]["spec"]["source"] for n in b)
assert all(a[n].get("status",{}).get("sync",{}).get("status")=="Synced" for n in b)
assert all(a[n].get("status",{}).get("health",{}).get("status")=="Healthy" for n in b)
PY
"${kube[@]}" -n workers-api-system rollout status deployment/workers-api --timeout=10m >/dev/null

"${kube[@]}" -n workers-api-system get deployment workers-api -o json >"$temporary/deployment-after.json"
"${kube[@]}" -n workers-api-system get service workers-api-private -o json >"$temporary/service-after.json"
"${kube[@]}" -n workers-api-system get pods -l app.kubernetes.io/name=workers-api -o json >"$temporary/pods-after.json"
"${kube[@]}" get nodes -o json >"$temporary/nodes-after.json"
if [[ -n $object_router_endpoint_receipt ]]; then
	"${kube[@]}" -n workers-api-system get service workers-object-router-private -o json >"$temporary/object-router-service-after.json"
fi
"${kube[@]}" -n workers-api-system get secret "$external_secret_name" -o json >"$temporary/secret-after.json"
"$python" - "$temporary/deployment-before.json" "$temporary/deployment-after.json" \
	"$temporary/service-before.json" "$temporary/service-after.json" \
	"$temporary/secret-before.json" "$temporary/secret-after.json" \
	"$temporary/pods-after.json" "$temporary/nodes-after.json" "$endpoint" <<'PY'
import ipaddress,json,sys,urllib.parse
db,da,sb,sa,kb,ka,pods,nodes=(json.load(open(path)) for path in sys.argv[1:9])
endpoint=sys.argv[9]
if db["metadata"]["uid"] != da["metadata"]["uid"]:
    raise SystemExit("Argo adoption replaced the Workers API Deployment")
if sb["metadata"]["uid"] != sa["metadata"]["uid"]:
    raise SystemExit("Argo adoption replaced the private CLB Service")
if kb["metadata"]["uid"] != ka["metadata"]["uid"]:
    raise SystemExit("Argo adoption replaced the externally owned token Secret")
before=sb.get("status",{}).get("loadBalancer",{}).get("ingress",[])
after=sa.get("status",{}).get("loadBalancer",{}).get("ingress",[])
parsed=urllib.parse.urlsplit(endpoint)
if len(before) != 1 or len(after) != 1 or before[0].get("ip") != parsed.hostname or after[0].get("ip") != parsed.hostname:
    raise SystemExit("Argo adoption changed the private CLB address")
if not ipaddress.ip_address(parsed.hostname).is_private or parsed.port != 6688:
    raise SystemExit("adopted endpoint is not the private product listener")
spec=sa["spec"]
if spec.get("externalTrafficPolicy") != "Cluster" or next(p for p in spec["ports"] if p["name"]=="http")["port"] != 6688:
    raise SystemExit("Argo adoption changed the private listener contract")
replicas=da.get("spec",{}).get("replicas")
ready=[item for item in pods.get("items",[]) if not item.get("metadata",{}).get("deletionTimestamp") and item.get("status",{}).get("phase")=="Running" and item.get("status",{}).get("containerStatuses") and all(
    value.get("ready") for value in item["status"]["containerStatuses"])]
node_zones={
    item.get("metadata",{}).get("name"):item.get("metadata",{}).get("labels",{}).get("topology.kubernetes.io/zone")
    for item in nodes.get("items",[])
    if any(value.get("type")=="Ready" and value.get("status")=="True" for value in item.get("status",{}).get("conditions",[]))
}
ready_nodes={item.get("spec",{}).get("nodeName") for item in ready}
ready_zones={node_zones.get(name) for name in ready_nodes}
if (
    not isinstance(replicas,int) or replicas<3 or len(ready)!=replicas
    or None in ready_nodes or len(ready_nodes)<3
    or None in ready_zones or len(ready_zones)<3
):
    raise SystemExit("Workers API did not preserve its three-node/three-zone HA floor")
PY
if [[ -n $object_router_endpoint_receipt ]]; then
	"$python" - "$temporary/object-router-service-before.json" "$temporary/object-router-service-after.json" \
		"$object_router_endpoint" <<'PY'
import ipaddress,json,sys
orb,ora=(json.load(open(path)) for path in sys.argv[1:3])
router_endpoint=sys.argv[3]
if orb["metadata"]["uid"] != ora["metadata"]["uid"]:
    raise SystemExit("Argo adoption replaced the Object Router private CLB Service")
router_before=orb.get("status",{}).get("loadBalancer",{}).get("ingress",[])
router_after=ora.get("status",{}).get("loadBalancer",{}).get("ingress",[])
router_host,separator,router_port=router_endpoint.rpartition(":")
if not separator or router_port != "19085" or len(router_before) != 1 or len(router_after) != 1 or router_before[0].get("ip") != router_host or router_after[0].get("ip") != router_host:
    raise SystemExit("Argo adoption changed the Object Router private CLB address")
if not ipaddress.ip_address(router_host).is_private:
    raise SystemExit("adopted Object Router endpoint is not private")
router_spec=ora["spec"]
if router_spec.get("externalTrafficPolicy") != "Cluster" or next(p for p in router_spec["ports"] if p["name"]=="object-router")["port"] != 19085:
    raise SystemExit("Argo adoption changed the Object Router listener contract")
PY
fi

# Prove self-heal on a harmless, Argo-owned field without restarting Pods.
"${kube[@]}" -n workers-api-system patch deployment workers-api --type=merge \
	-p '{"spec":{"revisionHistoryLimit":4}}' >/dev/null
"${kube[@]}" -n argocd annotate application actor-management-workers-api \
	argocd.argoproj.io/refresh=hard --overwrite >/dev/null
deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
	[[ $("${kube[@]}" -n workers-api-system get deployment workers-api -o jsonpath='{.spec.revisionHistoryLimit}') == 3 ]] && break
	sleep 3
done
[[ $("${kube[@]}" -n workers-api-system get deployment workers-api -o jsonpath='{.spec.revisionHistoryLimit}') == 3 ]] || {
	echo "Argo did not self-heal Workers API drift" >&2; exit 1;
}

"${kube[@]}" -n argocd get application actor-management-workers-api -o json >"$temporary/application-final.json"
"${kube[@]}" -n argocd get appproject actor-management-workloads -o json >"$temporary/project-final.json"
cell_application_evidence=$(jq -c '[.items[] | select(any(.metadata.ownerReferences[]?; .kind == "ApplicationSet" and .name == "actor-cells")) |
  {name:.metadata.name,repoURL:.spec.source.repoURL,targetRevision:.spec.source.targetRevision,
   path:.spec.source.path,destinationServer:.spec.destination.server}] | sort_by(.name)' "$temporary/applications-after.json")
object_router_service_uid=
if [[ -n $object_router_endpoint_receipt ]]; then
	object_router_service_uid=$(jq -er '.metadata.uid' "$temporary/object-router-service-after.json")
fi
jq -cn \
	--arg revision "$revision" --arg endpoint "$endpoint" --arg object_router_endpoint "$object_router_endpoint" \
	--arg publication "sha256:$(sha256sum "$publication_receipt" | cut -d' ' -f1)" \
	--arg render "sha256:$(sha256sum "$desired_render_receipt" | cut -d' ' -f1)" \
	--arg application_uid "$(jq -er '.metadata.uid' "$temporary/application-final.json")" \
	--arg project_uid "$(jq -er '.metadata.uid' "$temporary/project-final.json")" \
	--arg deployment_uid "$(jq -er '.metadata.uid' "$temporary/deployment-after.json")" \
	--arg service_uid "$(jq -er '.metadata.uid' "$temporary/service-after.json")" \
	--arg object_router_service_uid "$object_router_service_uid" \
	--arg secret_name "$external_secret_name" \
	--arg secret_uid "$(jq -er '.metadata.uid' "$temporary/secret-after.json")" \
	--arg release_mode "$release_mode" --arg phase "$release_phase" \
	--argjson resumed_after_apply "$resumed_after_apply" \
	--argjson cell_applications "$cell_application_evidence" \
	'{schema:"actor-management-workers-api-argocd-convergence/v1",verdict:"passed",
	  gitRevision:$revision,endpoint:$endpoint,
	  objectRouterEndpoint:(if $object_router_endpoint == "" then null else $object_router_endpoint end),
	  releaseMode:$release_mode,phase:$phase,resumedAfterApply:$resumed_after_apply,
	  sourceReceipts:{publication:$publication,desiredRender:$render},
	  bootstrapResources:{application:{name:"actor-management-workers-api",uid:$application_uid},
	    project:{name:"actor-management-workloads",uid:$project_uid}},
	  adoptedResources:{deploymentUid:$deployment_uid,privateServiceUid:$service_uid,
	    objectRouterServiceUid:(if $object_router_service_uid == "" then null else $object_router_service_uid end),
	    externalSecretName:$secret_name,externalSecretUid:$secret_uid},
	  preservedCellApplications:$cell_applications,
	  gates:{synced:true,healthy:true,identityPreserved:true,secretExternallyOwned:true,
	    cellApplicationsPreserved:true,threeNodeThreeZoneHa:true,selfHeal:true,
	    registryDeploymentCursorContract:($phase == "serving")}}' >"$temporary/receipt.json"
ln "$temporary/receipt.json" "$convergence_receipt"
chmod 0644 "$convergence_receipt"
printf 'management_workers_api_argocd=passed revision=%s receipt=%s\n' "$revision" "$convergence_receipt"
