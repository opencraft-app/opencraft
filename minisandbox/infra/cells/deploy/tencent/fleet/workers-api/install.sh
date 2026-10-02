#!/usr/bin/env bash
set -euo pipefail
umask 077

hub=${HUB_KUBECONFIG:?HUB_KUBECONFIG is required}
manifest=${ACTOR_WORKERS_API_MANIFEST:?ACTOR_WORKERS_API_MANIFEST is required}
render_receipt=${ACTOR_WORKERS_API_RENDER_RECEIPT:?ACTOR_WORKERS_API_RENDER_RECEIPT is required}
credential_receipt=${ACTOR_WORKERS_API_CREDENTIAL_RECEIPT:?ACTOR_WORKERS_API_CREDENTIAL_RECEIPT is required}
receipt=${ACTOR_WORKERS_API_INSTALL_RECEIPT:?ACTOR_WORKERS_API_INSTALL_RECEIPT is required}
namespace=workers-api-system

for path in "$hub" "$manifest" "$render_receipt" "$credential_receipt"; do
	[[ $path == /* && -f $path && ! -L $path ]] || { echo "Workers API input must be an absolute non-symlink file: $path" >&2; exit 2; }
done
[[ $receipt == /* && ! -e $receipt ]] || { echo "install receipt must be a new absolute path" >&2; exit 2; }
for command in kubectl python3 curl; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

temporary=$(mktemp -d /data/tmp/workers-api-install.XXXXXX)
forward_pid=
cleanup() {
	[[ -z ${forward_pid:-} ]] || { kill "$forward_pid" 2>/dev/null || true; wait "$forward_pid" 2>/dev/null || true; }
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

python3 - "$render_receipt" "$manifest" "$credential_receipt" >"$temporary/expected.json" <<'PY'
import hashlib,json,sys
receipt=json.load(open(sys.argv[1]))
if receipt.get("schema") != "actor-workers-api-render/v1" or receipt.get("verdict") != "passed":
    raise SystemExit("Workers API render receipt did not pass")
manifest="sha256:"+hashlib.sha256(open(sys.argv[2],"rb").read()).hexdigest()
if receipt.get("manifestSha256") != manifest:
    raise SystemExit("Workers API manifest differs from its render receipt")
credential=json.load(open(sys.argv[3]))
if (credential.get("schema"),credential.get("verdict")) != ("actor-workers-api-credential-sync/v1","passed"):
    raise SystemExit("Workers API credential synchronization did not pass")
bound=receipt.get("credentialReceipt",{})
credential_digest="sha256:"+hashlib.sha256(open(sys.argv[3],"rb").read()).hexdigest()
identity=credential.get("credential",{})
if (
    bound.get("sha256") != credential_digest or bound.get("name") != identity.get("name")
    or bound.get("uid") != identity.get("uid")
    or bound.get("resourceVersion") != identity.get("resourceVersion")
):
    raise SystemExit("Workers API render does not bind the supplied credential receipt")
cells=receipt.get("cells",[])
if len(cells) != 2 or [item.get("cell") for item in cells] != sorted(item.get("cell") for item in cells):
    raise SystemExit("Workers API render receipt does not bind two canonical Cells")
print(json.dumps({"cells":[{"name":item["cell"],"uid":item["cellUid"]} for item in cells],"image":receipt["workersApiImage"],"manifest":manifest,"credential":credential["credential"]}))
PY

secret_name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["credential"]["name"])' "$temporary/expected.json")
[[ $secret_name =~ ^workers-api-internal-token-[0-9a-f]{12}$ ]] || {
	echo "Workers API credential name is not content-addressed" >&2; exit 1;
}
kubectl --kubeconfig "$hub" -n "$namespace" get secret "$secret_name" -o json >"$temporary/live-secret.json"
python3 - "$credential_receipt" "$temporary/live-secret.json" <<'PY'
import base64,hashlib,json,sys
receipt,secret=json.load(open(sys.argv[1])),json.load(open(sys.argv[2]))
expected=receipt.get("credential",{}); metadata=secret.get("metadata",{})
if (
    expected.get("name") != metadata.get("name") or expected.get("namespace") != metadata.get("namespace")
    or expected.get("uid") != metadata.get("uid") or expected.get("resourceVersion") != metadata.get("resourceVersion")
    or expected.get("immutable") is not True or secret.get("immutable") is not True
    or expected.get("keys") != sorted(secret.get("data",{}))
):
    raise SystemExit("live Workers API credential differs from its synchronization receipt")
for name,value in secret.get("data",{}).items():
    fingerprint="sha256:"+hashlib.sha256(base64.b64decode(value,validate=True)).hexdigest()
    if expected.get("fingerprints",{}).get(name) != fingerprint:
        raise SystemExit("live Workers API capability fingerprint differs")
PY

kubectl --kubeconfig "$hub" apply -f "$manifest" >/dev/null
kubectl --kubeconfig "$hub" -n "$namespace" rollout status deployment/workers-api --timeout=10m
kubectl --kubeconfig "$hub" -n "$namespace" get deployment workers-api -o json >"$temporary/deployment.json"
kubectl --kubeconfig "$hub" -n "$namespace" get pods -l app.kubernetes.io/name=workers-api -o json >"$temporary/pods.json"
python3 - "$temporary/expected.json" "$temporary/deployment.json" "$temporary/pods.json" >"$temporary/live.json" <<'PY'
import json,sys
expected,deployment,pods=map(lambda path:json.load(open(path)),sys.argv[1:])
spec,status=deployment.get("spec",{}),deployment.get("status",{})
replicas=spec.get("replicas")
if not isinstance(replicas,int) or replicas < 3 or status.get("readyReplicas") != replicas or status.get("updatedReplicas") != replicas or status.get("availableReplicas") != replicas:
    raise SystemExit("Workers API does not have its complete HPA-managed replica set Ready")
ready=[]
for pod in pods.get("items",[]):
    containers=pod.get("status",{}).get("containerStatuses",[])
    if pod.get("status",{}).get("phase") == "Running" and containers and all(item.get("ready") for item in containers): ready.append(pod)
if len(ready) != replicas or len({pod["spec"]["nodeName"] for pod in ready}) < 3:
    raise SystemExit("Workers API replicas do not preserve the three-node HA floor")
images={item.get("imageID","").replace("docker-pullable://","") for pod in ready for item in pod["status"]["containerStatuses"]}
if images != {expected["image"]}: raise SystemExit("Workers API live image differs from the render receipt")
print(json.dumps({"deploymentUid":deployment["metadata"]["uid"],"generation":deployment["metadata"]["generation"],"podUids":sorted(pod["metadata"]["uid"] for pod in ready)}))
PY

kubectl --kubeconfig "$hub" -n "$namespace" port-forward service/workers-api 18080:8080 >"$temporary/forward.log" 2>&1 &
forward_pid=$!
for attempt in $(seq 1 60); do
	curl -fsS --max-time 5 http://127.0.0.1:18080/readyz >"$temporary/ready.json" 2>/dev/null && break
	[[ $attempt -lt 60 ]] || { echo "Workers API did not become ready through its Service" >&2; exit 1; }
	sleep 1
done
kill "$forward_pid" 2>/dev/null || true
wait "$forward_pid" 2>/dev/null || true
forward_pid=

mkdir -p "$(dirname -- "$receipt")"
python3 - "$render_receipt" "$credential_receipt" "$temporary/live.json" "$temporary/live-secret.json" "$receipt" <<'PY'
import hashlib,json,os,sys,tempfile
render_path,credential_path,live_path,secret_path,output=sys.argv[1:]
render,live,secret=json.load(open(render_path)),json.load(open(live_path)),json.load(open(secret_path))
value={"schema":"actor-workers-api-installation/v1","verdict":"passed","renderReceipt":{"path":os.path.realpath(render_path),"sha256":"sha256:"+hashlib.sha256(open(render_path,"rb").read()).hexdigest()},"credentialReceipt":{"path":os.path.realpath(credential_path),"sha256":"sha256:"+hashlib.sha256(open(credential_path,"rb").read()).hexdigest()},"topology":{"pool":render["pool"],"cells":render["cells"],"workersApiImage":render["workersApiImage"]},"deployment":live,"credentialSecret":{"name":secret["metadata"]["name"],"uid":secret["metadata"]["uid"],"resourceVersion":secret["metadata"]["resourceVersion"],"cellScopedTokens":True},"serviceReady":True}
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
printf 'workers_api_installation=passed receipt=%s\n' "$receipt"
