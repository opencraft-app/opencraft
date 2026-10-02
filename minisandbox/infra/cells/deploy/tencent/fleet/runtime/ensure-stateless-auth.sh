#!/usr/bin/env bash
set -euo pipefail
umask 077

cell=${RIVET_CELL_NAME:?RIVET_CELL_NAME is required}
kubeconfig=${KUBECONFIG_PATH:-${KUBECONFIG:-}}
receipt=${RIVET_STATELESS_AUTH_RECEIPT:?RIVET_STATELESS_AUTH_RECEIPT is required}
namespace=actor-stateless-system

[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& -n $kubeconfig && -f $kubeconfig && ! -L $kubeconfig \
	&& $receipt == /* && ! -e $receipt && -d $(dirname -- "$receipt") ]] || {
	echo "invalid stateless credential bootstrap inputs" >&2
	exit 2
}
for command in kubectl python3 openssl; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

temporary=$(mktemp -d /data/tmp/${cell}-stateless-auth.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

kube=(kubectl --kubeconfig "$kubeconfig")
"${kube[@]}" -n actor-fdb-cell-system get rivetcell "$cell" -o json >"$temporary/cell.json"
cell_uid=$(python3 - "$temporary/cell.json" "$cell" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
if value.get("metadata",{}).get("name") != sys.argv[2]:
    raise SystemExit("live RivetCell identity differs")
uid=value.get("metadata",{}).get("uid")
if not isinstance(uid,str) or not uid:
    raise SystemExit("live RivetCell UID is absent")
print(uid)
PY
)

"${kube[@]}" create namespace "$namespace" --dry-run=client -o yaml | \
	"${kube[@]}" apply --server-side --field-manager=rivet-stateless-auth -f - >/dev/null
secret=${cell}-stateless-auth
if ! "${kube[@]}" -n "$namespace" get secret "$secret" -o json >"$temporary/secret.json" 2>/dev/null; then
	for name in executor-token object-router-token workerd-token; do
		openssl rand -hex 32 | tr -d '\n' >"$temporary/$name"
	done
	"${kube[@]}" -n "$namespace" create secret generic "$secret" \
		--from-file="executor-token=$temporary/executor-token" \
		--from-file="object-router-token=$temporary/object-router-token" \
		--from-file="workerd-token=$temporary/workerd-token" \
		--dry-run=client -o json >"$temporary/new-secret.json"
	python3 - "$temporary/new-secret.json" "$cell" <<'PY'
import json,sys
path,cell=sys.argv[1:]
value=json.load(open(path))
value["immutable"]=True
value.setdefault("metadata",{}).setdefault("labels",{}).update({
    "fleet.actor.dev/cell-name":cell,
    "fleet.actor.dev/component":"stateless-executor",
    "fleet.actor.dev/credential-owner":"cell",
})
open(path,"w").write(json.dumps(value,separators=(",",":"))+"\n")
PY
	"${kube[@]}" -n "$namespace" create -f "$temporary/new-secret.json" >/dev/null
	"${kube[@]}" -n "$namespace" get secret "$secret" -o json >"$temporary/secret.json"
fi

python3 - "$temporary/secret.json" "$temporary/cell.json" "$receipt" "$cell_uid" <<'PY'
import base64,hashlib,json,os,sys,tempfile
secret_path,cell_path,output,expected_uid=sys.argv[1:]
secret=json.load(open(secret_path)); cell=json.load(open(cell_path))
expected_name=cell["metadata"]["name"]
metadata=secret.get("metadata",{})
labels=metadata.get("labels",{})
if metadata.get("name") != expected_name+"-stateless-auth" or metadata.get("namespace") != "actor-stateless-system":
    raise SystemExit("stateless credential identity differs")
if secret.get("immutable") is not True:
    raise SystemExit("stateless credential must be immutable")
if labels != {
    "fleet.actor.dev/cell-name":expected_name,
    "fleet.actor.dev/component":"stateless-executor",
    "fleet.actor.dev/credential-owner":"cell",
}:
    raise SystemExit("stateless credential ownership labels differ")
capabilities=("executor-token","object-router-token","workerd-token")
decoded=[]; fingerprints={}
if set(secret.get("data",{})) != set(capabilities):
    raise SystemExit("stateless credential capability inventory differs")
for name in capabilities:
    try: value=base64.b64decode(secret["data"][name],validate=True).decode("ascii")
    except Exception as error: raise SystemExit(f"invalid {name}") from error
    if len(value)!=64 or any(char not in "0123456789abcdef" for char in value):
        raise SystemExit(f"invalid {name}")
    decoded.append(value)
    fingerprints[name]="sha256:"+hashlib.sha256(value.encode()).hexdigest()
if len(set(decoded)) != len(decoded):
    raise SystemExit("stateless credential capabilities are not role-separated")
if cell.get("metadata",{}).get("uid") != expected_uid:
    raise SystemExit("RivetCell UID changed during credential bootstrap")
value={
    "schema":"actor-stateless-auth/v1","verdict":"passed",
    "cell":{"name":expected_name,"uid":expected_uid},
    "credential":{
        "namespace":"actor-stateless-system","name":metadata["name"],
        "uid":metadata["uid"],"resourceVersion":metadata["resourceVersion"],
        "immutable":True,"capabilities":list(capabilities),"fingerprints":fingerprints,
    },
}
descriptor,staged=tempfile.mkstemp(prefix="."+os.path.basename(output)+".",dir=os.path.dirname(output))
try:
    os.fchmod(descriptor,0o600)
    with os.fdopen(descriptor,"w") as stream:
        json.dump(value,stream,indent=2,sort_keys=True); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
    os.link(staged,output)
finally:
    try: os.unlink(staged)
    except FileNotFoundError: pass
PY
printf 'stateless_auth=passed cell=%s receipt=%s\n' "$cell" "$receipt"
