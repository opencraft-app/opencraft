#!/usr/bin/env bash
set -euo pipefail
umask 077

# Bind an already installed Cell runtime to the regional, management-owned
# Worker Registry before the public admission chain is opened.  This changes
# both the workerd-host fetch origin and the Cell qualification API publish
# origin, then records one resulting live binding.  Leaving those origins split
# makes prepare succeed in one Registry while every Host receives a 404 from
# another.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cell=${RIVET_CELL_NAME:?RIVET_CELL_NAME is required}
cell_vpc=${RIVET_CELL_VPC_CIDR:?RIVET_CELL_VPC_CIDR is required}
endpoint_receipt=${ACTOR_WORKER_REGISTRY_ENDPOINT_RECEIPT:?ACTOR_WORKER_REGISTRY_ENDPOINT_RECEIPT is required}
binding_receipt=${ACTOR_REGISTRY_BINDING_RECEIPT:?ACTOR_REGISTRY_BINDING_RECEIPT is required}
kubeconfig=${KUBECONFIG:?KUBECONFIG is required}
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
python=${PYTHON:-python3}
release_ledger=${cell}-release-ledger

[[ ${ACTOR_REGISTRY_BINDING_PRE_ADMISSION:-false} == true ]] || {
	echo "Registry binding is a pre-admission operation; set ACTOR_REGISTRY_BINDING_PRE_ADMISSION=true" >&2
	exit 2
}
[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ ]] || { echo "invalid Cell identity" >&2; exit 2; }
for path in "$kubeconfig" "$endpoint_receipt"; do
	[[ $path == /* && -f $path && ! -L $path ]] || { echo "binding input must be an absolute non-symlink file: $path" >&2; exit 2; }
done
[[ $binding_receipt == /* && -d $(dirname -- "$binding_receipt") && ! -e $binding_receipt ]] || {
	echo "binding receipt must be a new absolute path with an existing parent" >&2
	exit 2
}
for command in kubectl jq sha256sum "$python" flock; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done

# Registry binding changes the release-owned Host Pod template.  It is a
# create-first bootstrap step, not an alternative release mechanism.  Once a
# ledger exists the endpoint must be changed by a user-transparent Runtime
# release, otherwise this patch would silently invalidate the ledger.
if kubectl --kubeconfig "$kubeconfig" -n "$namespace" get configmap \
	"$release_ledger" >/dev/null 2>&1; then
	echo "Worker Registry binding must precede the first static Runtime release ledger" >&2
	exit 2
fi

lock=$(dirname -- "$binding_receipt")/.worker-registry-binding-$cell.lock
exec 9>"$lock"
flock -n 9 || { echo "another Registry binding operation is running for this Cell" >&2; exit 1; }

temporary=$(mktemp -d /data/tmp/worker-registry-binding.XXXXXX)
statefulset_patched=false
workers_api_patched=false
reporter_patched=false
rollback() {
	status=$?
	if [[ $status -ne 0 ]]; then
		if [[ $reporter_patched == true ]]; then
			echo "Registry binding failed; restoring the previous Cell Reporter revision" >&2
			kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout undo deployment/"${cell}-cell-reporter" >/dev/null || true
			kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status deployment/"${cell}-cell-reporter" --timeout=10m >/dev/null || true
		fi
		if [[ $workers_api_patched == true ]]; then
			echo "Registry binding failed; restoring the previous qualification Workers API revision" >&2
			kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout undo deployment/"${cell}-workers-api" >/dev/null || true
			kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status deployment/"${cell}-workers-api" --timeout=10m >/dev/null || true
		fi
		if [[ $statefulset_patched == true ]]; then
			echo "Registry binding failed; restoring the previous StatefulSet revision" >&2
			kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout undo statefulset/"${cell}-runtime-hosts" >/dev/null || true
			kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status statefulset/"${cell}-runtime-hosts" --timeout=15m >/dev/null || true
		fi
	fi
	rm -rf -- "$temporary"
	exit "$status"
}
trap rollback EXIT INT TERM

endpoint=$("$python" - "$endpoint_receipt" "$cell_vpc" <<'PY'
import ipaddress, json, sys, urllib.parse

receipt = json.load(open(sys.argv[1]))
if (receipt.get("schema"), receipt.get("verdict")) != ("actor-worker-registry-private-endpoint/v1", "installed"):
    raise SystemExit("Worker Registry endpoint receipt did not pass")
parsed = urllib.parse.urlsplit(str(receipt.get("endpoint", "")))
if parsed.scheme != "http" or parsed.port != 8080 or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
    raise SystemExit("Worker Registry endpoint is not an HTTP origin on port 8080")
if not parsed.hostname or not ipaddress.ip_address(parsed.hostname).is_private:
    raise SystemExit("Worker Registry endpoint is not private")
cell = ipaddress.ip_network(sys.argv[2], strict=False)
sources = [ipaddress.ip_network(value, strict=False) for value in receipt.get("network", {}).get("sourceCidrs", [])]
if cell.version != 4 or not any(
    cell.network_address in source and cell.broadcast_address in source
    for source in sources
):
    raise SystemExit("Cell VPC is outside the Registry endpoint source ranges")
if not str(receipt.get("service", {}).get("uid", "")):
    raise SystemExit("Worker Registry endpoint Service UID is missing")
print(receipt["endpoint"].rstrip("/"))
PY
)
endpoint_digest=sha256:$(sha256sum "$endpoint_receipt" | cut -d' ' -f1)
statefulset=${cell}-runtime-hosts
workers_api=${cell}-workers-api
reporter=${cell}-cell-reporter
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get statefulset "$statefulset" -o json >"$temporary/before.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get deployment "$workers_api" -o json >"$temporary/workers-api-before.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get deployment "$reporter" -o json >"$temporary/reporter-before.json"

"$python" - "$temporary/before.json" "$temporary/patch.json" "$endpoint" "$endpoint_digest" "$cell" <<'PY'
import json, sys

source, output, endpoint, digest, cell = sys.argv[1:]
document = json.load(open(source))
metadata, spec, status = document.get("metadata", {}), document.get("spec", {}), document.get("status", {})
if metadata.get("name") != cell + "-runtime-hosts" or spec.get("replicas") != 3:
    raise SystemExit("runtime StatefulSet identity or replica floor differs")
if status.get("readyReplicas") != 3 or status.get("currentRevision") != status.get("updateRevision"):
    raise SystemExit("runtime StatefulSet is not stable before Registry binding")
containers = spec.get("template", {}).get("spec", {}).get("containers", [])
container_index = next((i for i, item in enumerate(containers) if item.get("name") == "workerd-host"), None)
if container_index is None or "@sha256:" not in str(containers[container_index].get("image", "")):
    raise SystemExit("workerd-host image is missing or mutable")
env = containers[container_index].get("env", [])
env_index = [i for i, item in enumerate(env) if item.get("name") == "RIVET_WORKER_REGISTRY_URL"]
if len(env_index) != 1 or not isinstance(env[env_index[0]].get("value"), str):
    raise SystemExit("workerd-host Registry environment is ambiguous")
current = env[env_index[0]]["value"]
operations = [
    {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
]
if current.rstrip("/") != endpoint:
    path = f"/spec/template/spec/containers/{container_index}/env/{env_index[0]}/value"
    operations.extend([
        {"op": "test", "path": path, "value": current},
        {"op": "replace", "path": path, "value": endpoint},
    ])
annotations = spec.get("template", {}).get("metadata", {}).get("annotations")
if annotations is None:
    operations.append({"op": "add", "path": "/spec/template/metadata/annotations", "value": {"fleet.actor.dev/worker-registry-endpoint-sha256": digest}})
else:
    operations.append({"op": "add", "path": "/spec/template/metadata/annotations/fleet.actor.dev~1worker-registry-endpoint-sha256", "value": digest})
json.dump({"operations": operations, "changed": current.rstrip("/") != endpoint or (annotations or {}).get("fleet.actor.dev/worker-registry-endpoint-sha256") != digest}, open(output, "w"))
PY

"$python" - "$temporary/reporter-before.json" "$temporary/reporter-patch.json" "$endpoint" "$endpoint_digest" "$cell" <<'PY'
import json, sys

source, output, endpoint, digest, cell = sys.argv[1:]
document = json.load(open(source))
metadata, spec, status = document.get("metadata", {}), document.get("spec", {}), document.get("status", {})
if metadata.get("name") != cell + "-cell-reporter" or status.get("readyReplicas") != 1:
    raise SystemExit("Cell Reporter identity or readiness differs")
containers = spec.get("template", {}).get("spec", {}).get("containers", [])
container_index = next((i for i, item in enumerate(containers) if item.get("name") == "reporter"), None)
if container_index is None or "@sha256:" not in str(containers[container_index].get("image", "")):
    raise SystemExit("Cell Reporter image is missing or mutable")
env = containers[container_index].get("env", [])
env_indexes = [i for i, item in enumerate(env) if item.get("name") == "RIVET_WORKER_REGISTRY_URL"]
if len(env_indexes) != 1 or not isinstance(env[env_indexes[0]].get("value"), str):
    raise SystemExit("Cell Reporter Registry environment is ambiguous")
index = env_indexes[0]
current = env[index]["value"]
operations = [
    {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
]
if current.rstrip("/") != endpoint:
    path = f"/spec/template/spec/containers/{container_index}/env/{index}/value"
    operations.extend([
        {"op": "test", "path": path, "value": current},
        {"op": "replace", "path": path, "value": endpoint},
    ])
annotations = spec.get("template", {}).get("metadata", {}).get("annotations")
annotation = "fleet.actor.dev/worker-registry-endpoint-sha256"
if annotations is None:
    operations.append({"op": "add", "path": "/spec/template/metadata/annotations", "value": {annotation: digest}})
else:
    operations.append({"op": "add", "path": "/spec/template/metadata/annotations/fleet.actor.dev~1worker-registry-endpoint-sha256", "value": digest})
json.dump({"operations": operations, "changed": current.rstrip("/") != endpoint or (annotations or {}).get(annotation) != digest}, open(output, "w"))
PY

"$python" - "$temporary/workers-api-before.json" "$temporary/workers-api-patch.json" "$endpoint" "$endpoint_digest" "$cell" <<'PY'
import json, sys

source, output, endpoint, digest, cell = sys.argv[1:]
document = json.load(open(source))
metadata, spec, status = document.get("metadata", {}), document.get("spec", {}), document.get("status", {})
if metadata.get("name") != cell + "-workers-api" or status.get("readyReplicas") != 1:
    raise SystemExit("qualification Workers API identity or readiness differs")
containers = spec.get("template", {}).get("spec", {}).get("containers", [])
container_index = next((i for i, item in enumerate(containers) if item.get("name") == "workers-api"), None)
if container_index is None or "@sha256:" not in str(containers[container_index].get("image", "")):
    raise SystemExit("qualification Workers API image is missing or mutable")
args = containers[container_index].get("args", [])
registry_indexes = [i for i, item in enumerate(args) if item.startswith("--registry-url=")]
if len(registry_indexes) != 1 or ("--qualification-cell=" + cell) not in args:
    raise SystemExit("qualification Workers API Registry or Cell argument is ambiguous")
index = registry_indexes[0]
current = args[index]
desired = "--registry-url=" + endpoint
operations = [
    {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
]
if current.rstrip("/") != desired:
    path = f"/spec/template/spec/containers/{container_index}/args/{index}"
    operations.extend([
        {"op": "test", "path": path, "value": current},
        {"op": "replace", "path": path, "value": desired},
    ])
annotations = spec.get("template", {}).get("metadata", {}).get("annotations")
annotation = "fleet.actor.dev/worker-registry-endpoint-sha256"
if annotations is None:
    operations.append({"op": "add", "path": "/spec/template/metadata/annotations", "value": {annotation: digest}})
else:
    operations.append({"op": "add", "path": "/spec/template/metadata/annotations/fleet.actor.dev~1worker-registry-endpoint-sha256", "value": digest})
json.dump({"operations": operations, "changed": current.rstrip("/") != desired or (annotations or {}).get(annotation) != digest}, open(output, "w"))
PY

if [[ $(jq -r .changed "$temporary/patch.json") == true ]]; then
	jq '.operations' "$temporary/patch.json" >"$temporary/operations.json"
	kubectl --kubeconfig "$kubeconfig" -n "$namespace" patch statefulset "$statefulset" \
		--type=json --patch-file "$temporary/operations.json" >/dev/null
	statefulset_patched=true
	kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status statefulset/"$statefulset" --timeout=15m
fi

if [[ $(jq -r .changed "$temporary/workers-api-patch.json") == true ]]; then
	jq '.operations' "$temporary/workers-api-patch.json" >"$temporary/workers-api-operations.json"
	kubectl --kubeconfig "$kubeconfig" -n "$namespace" patch deployment "$workers_api" \
		--type=json --patch-file "$temporary/workers-api-operations.json" >/dev/null
	workers_api_patched=true
	kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status deployment/"$workers_api" --timeout=10m
fi

if [[ $(jq -r .changed "$temporary/reporter-patch.json") == true ]]; then
	jq '.operations' "$temporary/reporter-patch.json" >"$temporary/reporter-operations.json"
	kubectl --kubeconfig "$kubeconfig" -n "$namespace" patch deployment "$reporter" \
		--type=json --patch-file "$temporary/reporter-operations.json" >/dev/null
	reporter_patched=true
	kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status deployment/"$reporter" --timeout=10m
fi

"$python" "$script_dir/qualify-registry-binding.py" \
	--cell "$cell" --cell-vpc-cidr "$cell_vpc" --kubeconfig "$kubeconfig" \
	--endpoint-receipt "$endpoint_receipt" --output "$binding_receipt"
statefulset_patched=false
workers_api_patched=false
reporter_patched=false
printf 'worker_registry_binding=passed cell=%s endpoint=%s receipt=%s\n' "$cell" "$endpoint" "$binding_receipt"
