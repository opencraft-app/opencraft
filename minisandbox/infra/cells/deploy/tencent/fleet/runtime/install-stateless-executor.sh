#!/usr/bin/env bash
set -euo pipefail
umask 077

cell=${RIVET_CELL_NAME:?RIVET_CELL_NAME is required}
kubeconfig=${KUBECONFIG_PATH:-${KUBECONFIG:-}}
runtime_image=${RIVET_RUNTIME_IMAGE:?RIVET_RUNTIME_IMAGE is required}
runtime_digest=${RIVET_RUNTIME_DIGEST:?RIVET_RUNTIME_DIGEST is required}
reporter_image=${RIVET_REPORTER_IMAGE:?RIVET_REPORTER_IMAGE is required}
stateless_machine_set=${STATELESS_MACHINE_SET:?STATELESS_MACHINE_SET must be the Terraform-owned Native NodePool ID}
registry_url=${RIVET_WORKER_REGISTRY_URL:?RIVET_WORKER_REGISTRY_URL is required}
object_router_address=${RIVET_OBJECT_ROUTER_ADDRESS:?RIVET_OBJECT_ROUTER_ADDRESS is required}
receipt=${RIVET_STATELESS_EXECUTOR_RECEIPT:?RIVET_STATELESS_EXECUTOR_RECEIPT is required}
admission_receipt=${RIVET_STATELESS_ADMISSION_RECEIPT:?RIVET_STATELESS_ADMISSION_RECEIPT is required}
auth_receipt=${RIVET_STATELESS_AUTH_RECEIPT:?RIVET_STATELESS_AUTH_RECEIPT is required}
namespace=actor-stateless-system
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
manifest=${RIVET_STATELESS_EXECUTOR_MANIFEST:-$script_dir/stateless-executor.yaml}

[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& -n $kubeconfig && -f $kubeconfig \
	&& -f $manifest && ! -L $manifest \
	&& $runtime_image =~ @sha256:[0-9a-f]{64}$ \
	&& $runtime_digest =~ ^sha256:[0-9a-f]{64}$ \
	&& $reporter_image =~ @sha256:[0-9a-f]{64}$ \
	&& $stateless_machine_set =~ ^[A-Za-z0-9._-]+$ \
	&& -f $auth_receipt && ! -L $auth_receipt \
	&& $receipt == /* && ! -e $receipt \
	&& $admission_receipt == /* && ! -e $admission_receipt ]] || {
	echo "invalid stateless executor installation inputs" >&2
	exit 2
}
for command in kubectl python3 sha256sum; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

# Node admission is deliberately installed before the workload.  It can use
# the immutable bootstrap image while the Deployment is absent, proving each
# exact Node/Machine identity and retiring the CA startup taint before any
# executor Pod is schedulable.
RIVET_CELL_NAME="$cell" \
	KUBECONFIG_PATH="$kubeconfig" \
	RIVET_REPORTER_IMAGE="$reporter_image" \
	RIVET_RUNTIME_IMAGE="$runtime_image" \
	STATELESS_MACHINE_SET="$stateless_machine_set" \
	RIVET_STATELESS_ADMISSION_RECEIPT="$admission_receipt" \
	"$script_dir/install-stateless-admission-controller.sh"
python3 - "$admission_receipt" "$cell" "$stateless_machine_set" "$runtime_image" <<'PY'
import json,sys
receipt=json.load(open(sys.argv[1]))
if receipt.get("schema") != "actor-stateless-node-admission/v1" or receipt.get("verdict") != "passed":
    raise SystemExit("stateless admission receipt did not pass")
if receipt.get("cell") != sys.argv[2] or receipt.get("machineSet",{}).get("name") != sys.argv[3] or receipt.get("runtimeImage") != sys.argv[4]:
    raise SystemExit("stateless admission receipt identity differs")
PY
python3 - "$registry_url" "$object_router_address" <<'PY'
import ipaddress,sys,urllib.parse
registry=urllib.parse.urlsplit(sys.argv[1])
if registry.scheme not in ("http","https") or not registry.hostname or registry.path not in ("","/") or registry.query or registry.fragment:
    raise SystemExit("Worker Registry must be an HTTP origin")
try:
    address=ipaddress.ip_address(registry.hostname)
except ValueError:
    pass
else:
    if not address.is_private: raise SystemExit("Worker Registry address must be private")
raw=sys.argv[2]
host,separator,port=raw.rpartition(":")
if not separator or not host or not port.isdigit() or not (1 <= int(port) <= 65535):
    raise SystemExit("Object Router address must be host:port")
try:
    address=ipaddress.ip_address(host)
except ValueError:
    if ":" in host: raise SystemExit("IPv6 Object Router addresses require a future explicit format")
else:
    if not address.is_private: raise SystemExit("Object Router address must be private")
PY

temporary=$(mktemp -d /data/tmp/${cell}-stateless-executor.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
kube=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")
secret=${cell}-stateless-auth
"${kube[@]}" get secret "$secret" -o json >"$temporary/secret.json"
python3 - "$auth_receipt" "$temporary/secret.json" "$cell" <<'PY'
import base64,hashlib,json,sys
receipt,secret=json.load(open(sys.argv[1])),json.load(open(sys.argv[2]))
cell=sys.argv[3]
if (receipt.get("schema"),receipt.get("verdict")) != ("actor-stateless-auth/v1","passed"):
    raise SystemExit("stateless credential receipt did not pass")
credential=receipt.get("credential",{})
metadata=secret.get("metadata",{})
if (
    receipt.get("cell",{}).get("name") != cell
    or credential.get("name") != metadata.get("name")
    or credential.get("uid") != metadata.get("uid")
    or credential.get("resourceVersion") != metadata.get("resourceVersion")
    or credential.get("immutable") is not True or secret.get("immutable") is not True
):
    raise SystemExit("live stateless credential differs from its bootstrap receipt")
capabilities=("executor-token","object-router-token","workerd-token")
if credential.get("capabilities") != list(capabilities) or set(secret.get("data",{})) != set(capabilities):
    raise SystemExit("stateless credential capability inventory differs")
for name in capabilities:
    value=base64.b64decode(secret["data"][name],validate=True).decode("ascii")
    if credential.get("fingerprints",{}).get(name) != "sha256:"+hashlib.sha256(value.encode()).hexdigest():
        raise SystemExit("stateless credential fingerprint differs")
PY

sed \
	-e "s|__CELL_NAME__|$cell|g" \
	-e "s|__RUNTIME_IMAGE__|$runtime_image|g" \
	-e "s|__RUNTIME_DIGEST__|$runtime_digest|g" \
	-e "s|__STATELESS_MACHINE_SET__|$stateless_machine_set|g" \
	-e "s|__WORKER_REGISTRY_URL__|$registry_url|g" \
	-e "s|__OBJECT_ROUTER_ADDRESS__|$object_router_address|g" \
	"$manifest" >"$temporary/rendered.yaml"
if grep -Eq '__[A-Z0-9_]+__' "$temporary/rendered.yaml"; then
	echo "rendered stateless executor manifest contains an unresolved placeholder" >&2
	exit 1
fi
kubectl --kubeconfig "$kubeconfig" create --dry-run=client -f "$temporary/rendered.yaml" \
	-o json >"$temporary/rendered.json"
kubectl --kubeconfig "$kubeconfig" apply --server-side \
	--field-manager=rivet-stateless-executor -f "$temporary/rendered.yaml" >/dev/null
"${kube[@]}" rollout status deployment/"${cell}-stateless-executor" --timeout=10m
"${kube[@]}" get deployment "${cell}-stateless-executor" -o json >"$temporary/deployment.json"
"${kube[@]}" get service "${cell}-stateless-executor" -o json >"$temporary/service.json"
"${kube[@]}" get secret "$secret" -o json >"$temporary/secret-after.json"

mkdir -p "$(dirname -- "$receipt")"
python3 - "$temporary/deployment.json" "$temporary/service.json" "$temporary/secret-after.json" \
	"$temporary/rendered.yaml" "$receipt" "$cell" "$runtime_image" "$registry_url" "$object_router_address" "$stateless_machine_set" "$admission_receipt" "$auth_receipt" <<'PY'
import hashlib,json,os,sys,tempfile
deployment_path,service_path,secret_path,manifest_path,output,cell,image,registry,router,machine_set,admission_receipt,auth_receipt=sys.argv[1:]
deployment,service,secret=map(lambda path:json.load(open(path)),(deployment_path,service_path,secret_path))
status=deployment.get("status",{})
if status.get("readyReplicas") != 3 or status.get("updatedReplicas") != 3:
    raise SystemExit("stateless executor does not have three updated Ready replicas")
container_images={item.get("image") for item in deployment["spec"]["template"]["spec"]["containers"]}
if container_images != {image}: raise SystemExit("stateless executor image identity differs")
if service.get("spec",{}).get("selector") != {"fleet.actor.dev/cell-name":cell,"fleet.actor.dev/component":"stateless-executor"}:
    raise SystemExit("stateless executor Service selector differs")
value={
    "schema":"actor-stateless-executor-installation/v1","verdict":"passed","cell":cell,
    "runtimeImage":image,"registryUrl":registry,"objectRouterAddress":router,
    "machineSet":machine_set,
    "nodeAdmissionReceiptSha256":"sha256:"+hashlib.sha256(open(admission_receipt,"rb").read()).hexdigest(),
    "credentialReceiptSha256":"sha256:"+hashlib.sha256(open(auth_receipt,"rb").read()).hexdigest(),
    "manifestSha256":"sha256:"+hashlib.sha256(open(manifest_path,"rb").read()).hexdigest(),
    "deployment":{"name":deployment["metadata"]["name"],"uid":deployment["metadata"]["uid"],"generation":deployment["metadata"]["generation"]},
    "service":{"name":service["metadata"]["name"],"uid":service["metadata"]["uid"]},
    "credential":{"name":secret["metadata"]["name"],"uid":secret["metadata"]["uid"],
                  "capabilities":["executor-token","object-router-token","workerd-token"]},
}
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
printf 'stateless_executor_installation=passed cell=%s receipt=%s\n' "$cell" "$receipt"
