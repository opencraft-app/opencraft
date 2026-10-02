#!/usr/bin/env bash
set -euo pipefail
umask 077

if (($# != 5)); then
	echo "Usage: install-application.sh APPLICATION_YAML PUBLICATION_RECEIPT DESIRED_RENDER_RECEIPT CELL_REGISTRATION_RECEIPT CONVERGENCE_RECEIPT" >&2
	exit 2
fi

application_yaml=$1
publication_receipt=$2
desired_receipt=$3
registration_receipt=$4
convergence_receipt=$5
hub_kubeconfig=${HUB_KUBECONFIG:-${KUBECONFIG:-}}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

[[ -n $hub_kubeconfig && -f $hub_kubeconfig && ! -L $hub_kubeconfig \
	&& -f $application_yaml && ! -L $application_yaml \
	&& -f $publication_receipt && ! -L $publication_receipt \
	&& -f $desired_receipt && ! -L $desired_receipt \
	&& -f $registration_receipt && ! -L $registration_receipt \
	&& $convergence_receipt == /* && -d $(dirname -- "$convergence_receipt") && ! -e $convergence_receipt ]] || {
	echo "invalid stateless runtime Argo installation inputs" >&2
	exit 2
}
for command in kubectl python3 jq sha256sum; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

temporary=$(mktemp -d /data/tmp/stateless-runtime-argocd.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM

python3 "$script_dir/render-application.py" \
	--publication-receipt "$publication_receipt" \
	--desired-render-receipt "$desired_receipt" \
	--cell-registration-receipt "$registration_receipt" \
	--output "$temporary/expected.yaml"
python3 - "$temporary/expected.yaml" "$application_yaml" <<'PY'
import sys,yaml
expected,actual=(list(yaml.safe_load_all(open(path))) for path in sys.argv[1:])
if expected != actual:
    raise SystemExit("Application manifest differs from the exact evidence-bound rendering")
if len(actual) != 1 or actual[0].get("kind") != "Application":
    raise SystemExit("Application manifest must contain exactly one Application")
PY

cell=$(jq -er '.cell' "$publication_receipt")
application=$(python3 - "$application_yaml" <<'PY'
import sys,yaml
print(yaml.safe_load(open(sys.argv[1]))["metadata"]["name"])
PY
)
secret=$(jq -er '.argoClusterSecret.name' "$registration_receipt")
secret_uid=$(jq -er '.argoClusterSecret.uid' "$registration_receipt")
registered_server=$(jq -er '.server' "$registration_receipt")
revision=$(jq -er '.gitRevision' "$publication_receipt")
[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& $application == "actor-runtime-$cell" \
	&& $secret == "actor-cell-$cell" \
	&& $secret_uid != "" \
	&& $revision =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
	echo "stateless runtime Application identities are invalid" >&2
	exit 2
}

kubectl --kubeconfig "$hub_kubeconfig" -n argocd get secret "$secret" -o json >"$temporary/cluster-secret.json"
python3 - "$temporary/cluster-secret.json" "$secret_uid" "$registered_server" "$cell" <<'PY'
import base64,json,sys
secret=json.load(open(sys.argv[1])); expected_uid,server,cell=sys.argv[2:]
metadata=secret.get("metadata",{})
if metadata.get("uid") != expected_uid:
    raise SystemExit("live Argo cluster Secret UID differs from Cell registration")
labels=metadata.get("labels",{})
if labels.get("argocd.argoproj.io/secret-type") != "cluster" or labels.get("fleet.actor.dev/cell-id") != cell:
    raise SystemExit("live Argo cluster Secret labels differ")
def decode(name):
    raw=secret.get("data",{}).get(name)
    return base64.b64decode(raw,validate=True).decode() if isinstance(raw,str) else ""
if decode("server") != server or decode("name") != cell:
    raise SystemExit("live Argo cluster Secret endpoint differs from Cell registration")
if decode("namespaces") != "actor-fdb-cell-system,actor-stateless-system" or decode("clusterResources") != "true":
    raise SystemExit("live Argo cluster Secret namespace/resource scope differs")
PY

kubectl --kubeconfig "$hub_kubeconfig" -n argocd get appproject actor-cell-runtime >/dev/null
kubectl --kubeconfig "$hub_kubeconfig" apply --server-side \
	--field-manager=actor-stateless-runtime-gitops -f "$application_yaml" >/dev/null

deadline=$((SECONDS + 900))
while ((SECONDS < deadline)); do
	kubectl --kubeconfig "$hub_kubeconfig" -n argocd get application "$application" -o json >"$temporary/application.json"
	if jq -e --arg revision "$revision" '
		.status.sync.status == "Synced" and
		.status.health.status == "Healthy" and
		.status.sync.revision == $revision and
		(.status.conditions // [] | length) == 0
	' "$temporary/application.json" >/dev/null; then
		break
	fi
	sleep 5
done
if ((SECONDS >= deadline)); then
	echo "stateless runtime Argo Application did not become Healthy and Synced" >&2
	exit 1
fi

mkdir -p "$(dirname -- "$convergence_receipt")"
python3 - "$temporary/application.json" "$temporary/cluster-secret.json" \
	"$publication_receipt" "$desired_receipt" "$registration_receipt" \
	"$convergence_receipt" <<'PY'
import hashlib,json,os,sys,tempfile
application_path,secret_path,publication_path,desired_path,registration_path,output=sys.argv[1:]
application=json.load(open(application_path)); secret=json.load(open(secret_path))
publication=json.load(open(publication_path)); desired=json.load(open(desired_path)); registration=json.load(open(registration_path))
cell=publication["cell"]; metadata=application["metadata"]
if application["spec"]["source"]["targetRevision"] != publication["gitRevision"]:
    raise SystemExit("live Application source revision differs")
if application["spec"]["destination"]["server"] != registration["server"]:
    raise SystemExit("live Application destination differs")
def sha(path): return "sha256:"+hashlib.sha256(open(path,"rb").read()).hexdigest()
value={
 "schema":"actor-stateless-runtime-argocd-convergence/v1","verdict":"passed","cell":cell,
 "gitRevision":publication["gitRevision"],
 "application":{"name":metadata["name"],"uid":metadata["uid"],
                "sync":application["status"]["sync"]["status"],"health":application["status"]["health"]["status"]},
 "clusterSecret":{"name":secret["metadata"]["name"],"uid":secret["metadata"]["uid"]},
 "adoptionIdentity":desired["sources"]["adoptionIdentity"],
 "sourceReceipts":{"publication":sha(publication_path),"desiredRender":sha(desired_path),
                   "cellRegistration":sha(registration_path)},
}
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
printf 'stateless_runtime_argocd=passed cell=%s application=%s receipt=%s\n' \
	"$cell" "$application" "$convergence_receipt"
