#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${HUB_KUBECONFIG:?HUB_KUBECONFIG is required}"
: "${ACTOR_MANAGEMENT_GIT_CREDENTIAL:?ACTOR_MANAGEMENT_GIT_CREDENTIAL is required}"
: "${ACTOR_WORKERS_API_ENDPOINT_RECEIPT:?ACTOR_WORKERS_API_ENDPOINT_RECEIPT is required}"
output=${ACTOR_WORKERS_API_LIVE_CONVERGENCE_RECEIPT:?ACTOR_WORKERS_API_LIVE_CONVERGENCE_RECEIPT is required}
python=${PYTHON:-python3.11}
forward_port=${ACTOR_MANAGEMENT_GIT_FORWARD_PORT:-30192}
read_url=http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git

for path in "$HUB_KUBECONFIG" "$ACTOR_MANAGEMENT_GIT_CREDENTIAL" "$ACTOR_WORKERS_API_ENDPOINT_RECEIPT"; do
	[[ $path == /* && -f $path && ! -L $path ]] || { echo "live recertification input must be an absolute regular file: $path" >&2; exit 2; }
done
[[ $output == /* && ! -e $output && -d $(dirname -- "$output") \
	&& $forward_port =~ ^[0-9]+$ && $forward_port -ge 1024 && $forward_port -le 65535 ]] || {
	echo "invalid live recertification output or forward port" >&2
	exit 2
}
for command in kubectl curl git tar "$python"; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done
"$python" -c 'import sys; assert sys.version_info >= (3,11)'

temporary=$(mktemp -d /data/tmp/workers-api-live-recertify.XXXXXX)
forward_pid=
cleanup() {
	[[ -z ${forward_pid:-} ]] || { kill "$forward_pid" 2>/dev/null || true; wait "$forward_pid" 2>/dev/null || true; }
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM
kube=(kubectl --kubeconfig "$HUB_KUBECONFIG")

"${kube[@]}" -n argocd get application actor-management-workers-api -o json >"$temporary/application.json"
"${kube[@]}" -n argocd get appproject actor-management-workloads -o json >"$temporary/project.json"
"${kube[@]}" -n workers-api-system get deployment workers-api -o json >"$temporary/deployment.json"
"${kube[@]}" -n workers-api-system get service workers-api-private -o json >"$temporary/service.json"
secret_name=$("$python" - "$temporary/deployment.json" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1])); pod=value.get("spec",{}).get("template",{}).get("spec",{})
names={
    reference.get("name")
    for container in pod.get("initContainers",[])+pod.get("containers",[])
    for item in container.get("env",[])
    if (reference:=item.get("valueFrom",{}).get("secretKeyRef")) is not None
}
if len(names)!=1:
    raise SystemExit("live Workers API Deployment does not use one credential Secret")
name=next(iter(names))
if name!="workers-api-internal-token" and not re.fullmatch(r"workers-api-internal-token-[0-9a-f]{12}",name or ""):
    raise SystemExit("live Workers API credential name is invalid")
print(name)
PY
)
"${kube[@]}" -n workers-api-system get secret "$secret_name" -o json >"$temporary/secret.json"
"${kube[@]}" -n workers-api-system get configmap workers-api -o json >"$temporary/config.json"
"${kube[@]}" -n workers-api-system get pods -l app.kubernetes.io/name=workers-api -o json >"$temporary/pods.json"
"${kube[@]}" get nodes -o json >"$temporary/nodes.json"

"${kube[@]}" -n actor-git-system port-forward service/actor-git "$forward_port:3000" >"$temporary/port-forward.log" 2>&1 &
forward_pid=$!
for _ in $(seq 1 60); do
	curl -fsS "http://127.0.0.1:$forward_port/api/healthz" >/dev/null 2>&1 && break
	sleep 1
done
curl -fsS "http://127.0.0.1:$forward_port/api/healthz" >/dev/null

"$python" - "$ACTOR_MANAGEMENT_GIT_CREDENTIAL" "$read_url" "$temporary/askpass" <<'PY'
import json,os,sys
credential_path,expected_url,askpass=sys.argv[1:]
value=json.load(open(credential_path))
if (
    value.get("schema") != "actor-management-git-publisher-credential/v1"
    or value.get("repositoryURL") != expected_url or value.get("username") != "release-publisher"
    or not isinstance(value.get("password"),str) or len(value["password"]) != 64
):
    raise SystemExit("management Git credential identity differs")
descriptor=os.open(askpass,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o700)
with os.fdopen(descriptor,"w") as stream:
    stream.write('#!/bin/sh\ncase "$1" in *sername*) echo release-publisher;; *) echo "$ACTOR_GIT_PASSWORD";; esac\n')
PY
export ACTOR_GIT_PASSWORD=$("$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["password"])' "$ACTOR_MANAGEMENT_GIT_CREDENTIAL")
export GIT_ASKPASS="$temporary/askpass" GIT_TERMINAL_PROMPT=0
git clone --quiet --no-checkout "http://127.0.0.1:$forward_port/release-publisher/fleet-desired.git" "$temporary/repository"
revision=$("$python" - "$temporary/application.json" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1])); spec=value.get("spec",{}).get("source",{}); status=value.get("status",{})
revision=spec.get("targetRevision","")
if not re.fullmatch(r"[0-9a-f]{40}",revision) or status.get("sync",{}).get("revision") != revision:
    raise SystemExit("Workers API Application is not pinned and synced to one Git commit")
print(revision)
PY
)
git -C "$temporary/repository" cat-file -e "$revision^{commit}"
mkdir "$temporary/desired"
git -C "$temporary/repository" archive "$revision" management/workers-api | \
	tar -C "$temporary/desired" --strip-components=2 -xf -

"$python" - "$temporary/application.json" "$temporary/project.json" \
	"$temporary/deployment.json" "$temporary/service.json" "$temporary/secret.json" \
	"$temporary/config.json" "$temporary/pods.json" "$temporary/nodes.json" "$ACTOR_WORKERS_API_ENDPOINT_RECEIPT" \
	"$temporary/desired" "$revision" "$output" <<'PY'
import hashlib,ipaddress,json,os,pathlib,re,sys,tempfile,urllib.parse,yaml
application_path,project_path,deployment_path,service_path,secret_path,config_path,pods_path,nodes_path,endpoint_path,desired_path,revision,output=sys.argv[1:]
application,project,deployment,service,secret,config,pods,nodes,endpoint=(json.load(open(path)) for path in sys.argv[1:10])
desired=pathlib.Path(desired_path)
files={item.name for item in desired.iterdir() if item.is_file() and not item.is_symlink()}
allowed={
    frozenset({"evidence.json","kustomization.yaml","private-endpoint.yaml","workers-api-render.json","workers-api.yaml"}),
    frozenset({"evidence.json","kustomization.yaml","private-endpoint.yaml","private-object-router-endpoint.yaml","workers-api-render.json","workers-api.yaml"}),
}
if frozenset(files) not in allowed or any(not item.is_file() or item.is_symlink() for item in desired.iterdir()):
    raise SystemExit("pinned Workers API Git tree has an invalid inventory")
evidence=json.load(open(desired/"evidence.json"))
if evidence.get("schema") != "actor-management-workers-api-desired-evidence/v1":
    raise SystemExit("pinned Workers API evidence schema differs")
render_bytes=(desired/"workers-api-render.json").read_bytes()
if "sha256:"+hashlib.sha256(render_bytes).hexdigest() != evidence.get("workersApiRenderReceiptSha256"):
    raise SystemExit("pinned Workers API render receipt differs from evidence")
render=json.loads(render_bytes)
if (render.get("schema"),render.get("verdict")) != ("actor-workers-api-render/v1","passed"):
    raise SystemExit("pinned Workers API render receipt did not pass")
phase=evidence.get("phase","durable-legacy")
if phase not in {"durable-legacy","object-router-bootstrap"}:
    raise SystemExit("live recertification requires a pre-serving Workers API phase")
documents=[item for item in yaml.safe_load_all((desired/"workers-api.yaml").read_text()) if item]
desired_deployment=next(item for item in documents if item.get("kind")=="Deployment" and item.get("metadata",{}).get("name")=="workers-api")
desired_config=next(item for item in documents if item.get("kind")=="ConfigMap" and item.get("metadata",{}).get("name")=="workers-api")
desired_image=desired_deployment["spec"]["template"]["spec"]["containers"][0]["image"]
desired_pod=desired_deployment["spec"]["template"]["spec"]
desired_secret_names={
    reference.get("name")
    for container in desired_pod.get("initContainers",[])+desired_pod.get("containers",[])
    for item in container.get("env",[])
    if (reference:=item.get("valueFrom",{}).get("secretKeyRef")) is not None
}
metadata=application.get("metadata",{}); status=application.get("status",{}); source=application.get("spec",{}).get("source",{})
annotations=metadata.get("annotations",{}); project_annotations=project.get("metadata",{}).get("annotations",{})
for key in ("fleet.actor.dev/publication-receipt-digest","fleet.actor.dev/desired-render-receipt-digest"):
    if not re.fullmatch(r"sha256:[0-9a-f]{64}",annotations.get(key,"")) or project_annotations.get(key)!=annotations[key]:
        raise SystemExit("Argo bootstrap receipt annotation differs")
if (
    source != {"repoURL":"http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git","targetRevision":revision,"path":"management/workers-api"}
    or annotations.get("fleet.actor.dev/git-revision") != revision
    or project_annotations.get("fleet.actor.dev/git-revision") != revision
    or status.get("sync",{}).get("status") != "Synced" or status.get("sync",{}).get("revision") != revision
    or status.get("health",{}).get("status") != "Healthy" or status.get("conditions",[]) != []
    or not status.get("resources") or any(item.get("status")!="Synced" for item in status["resources"])
):
    raise SystemExit("Workers API Argo state is not exactly pinned, synced and healthy")
spec,live_status=deployment.get("spec",{}),deployment.get("status",{})
replicas=spec.get("replicas")
if (
    deployment.get("metadata",{}).get("uid") != evidence.get("deploymentUidAtAdoption")
    or desired_image != evidence.get("workersApiImage")
    or desired_config.get("data") != config.get("data")
    or not isinstance(replicas,int) or replicas < 3
    or live_status.get("readyReplicas") != replicas or live_status.get("updatedReplicas") != replicas
):
    raise SystemExit("live Workers API workload differs from its pinned Git evidence")
ready=[item for item in pods.get("items",[]) if not item.get("metadata",{}).get("deletionTimestamp") and item.get("status",{}).get("phase")=="Running" and all(
    value.get("ready") for value in item.get("status",{}).get("containerStatuses",[]))]
images={value.get("imageID","").replace("docker-pullable://","") for item in ready for value in item["status"]["containerStatuses"]}
node_zones={
    item.get("metadata",{}).get("name"):item.get("metadata",{}).get("labels",{}).get("topology.kubernetes.io/zone")
    for item in nodes.get("items",[])
    if any(value.get("type")=="Ready" and value.get("status")=="True" for value in item.get("status",{}).get("conditions",[]))
}
ready_nodes={item.get("spec",{}).get("nodeName") for item in ready}
ready_zones={node_zones.get(name) for name in ready_nodes}
if len(ready)!=replicas or len(ready_nodes)<3 or None in ready_zones or len(ready_zones)<3 or images!={desired_image}:
    raise SystemExit("live Workers API replica/image topology differs")
if (endpoint.get("schema"),endpoint.get("verdict")) != ("actor-workers-api-private-endpoint-installation/v3","installed"):
    raise SystemExit("Workers API endpoint receipt did not pass")
parsed=urllib.parse.urlsplit(endpoint.get("endpoint","")); ingress=service.get("status",{}).get("loadBalancer",{}).get("ingress",[])
if (
    endpoint.get("service",{}).get("uid") != service.get("metadata",{}).get("uid")
    or evidence.get("endpointServiceUidAtAdoption") != service.get("metadata",{}).get("uid")
    or parsed.scheme!="http" or parsed.port!=6688 or not ipaddress.ip_address(parsed.hostname or "").is_private
    or len(ingress)!=1 or ingress[0].get("ip")!=parsed.hostname
):
    raise SystemExit("live Workers API private endpoint differs from its receipts")
secret_metadata=secret.get("metadata",{})
credential_name=secret_metadata.get("name","")
evidence_credential=evidence.get("externalCredentialName")
if (
    secret_metadata.get("namespace")!="workers-api-system" or not secret_metadata.get("uid")
    or desired_secret_names!={credential_name}
    or (
        evidence_credential is not None and evidence_credential!=credential_name
    )
    or (
        evidence_credential is None and credential_name!="workers-api-internal-token"
    )
    or (
        credential_name!="workers-api-internal-token"
        and not re.fullmatch(r"workers-api-internal-token-[0-9a-f]{12}",credential_name)
    )
):
    raise SystemExit("live externally owned credential identity differs")
value={
    "schema":"actor-management-workers-api-argocd-convergence/v1","verdict":"passed",
    "gitRevision":revision,"endpoint":endpoint["endpoint"],"objectRouterEndpoint":None,
    "releaseMode":"live-recertification","phase":phase,
    "sourceReceipts":{
        "publication":annotations["fleet.actor.dev/publication-receipt-digest"],
        "desiredRender":annotations["fleet.actor.dev/desired-render-receipt-digest"],
        "endpoint":"sha256:"+hashlib.sha256(open(endpoint_path,"rb").read()).hexdigest(),
    },
    "bootstrapResources":{
        "application":{"name":"actor-management-workers-api","uid":metadata["uid"]},
        "project":{"name":"actor-management-workloads","uid":project["metadata"]["uid"]},
    },
    "adoptedResources":{
        "deploymentUid":deployment["metadata"]["uid"],"privateServiceUid":service["metadata"]["uid"],
        "objectRouterServiceUid":None,"externalSecretName":credential_name,
        "externalSecretUid":secret_metadata["uid"],
    },
    "gates":{
        "pinnedGitTreeVerified":True,"synced":True,"healthy":True,"identityPreserved":True,
        "secretExternallyOwned":True,"threeNodeThreeZoneHa":True,"privateEndpointPreserved":True,
    },
}
descriptor,staged=tempfile.mkstemp(prefix="."+os.path.basename(output)+".",dir=os.path.dirname(output))
try:
    os.fchmod(descriptor,0o644)
    with os.fdopen(descriptor,"w") as stream:
        json.dump(value,stream,indent=2,sort_keys=True); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
    os.link(staged,output)
finally:
    try: os.unlink(staged)
    except FileNotFoundError: pass
PY
printf 'workers_api_live_recertification=passed revision=%s receipt=%s\n' "$revision" "$output"
