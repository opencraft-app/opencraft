#!/usr/bin/env bash
set -euo pipefail
umask 077

hub=${HUB_KUBECONFIG:?HUB_KUBECONFIG is required}
cell_a_kubeconfig=${ACTOR_WORKERS_API_CELL_A_KUBECONFIG:?ACTOR_WORKERS_API_CELL_A_KUBECONFIG is required}
cell_b_kubeconfig=${ACTOR_WORKERS_API_CELL_B_KUBECONFIG:?ACTOR_WORKERS_API_CELL_B_KUBECONFIG is required}
route_a=${ACTOR_WORKERS_API_CELL_A_ROUTE_RECEIPT:?ACTOR_WORKERS_API_CELL_A_ROUTE_RECEIPT is required}
route_b=${ACTOR_WORKERS_API_CELL_B_ROUTE_RECEIPT:?ACTOR_WORKERS_API_CELL_B_ROUTE_RECEIPT is required}
auth_a=${ACTOR_WORKERS_API_CELL_A_STATELESS_AUTH_RECEIPT:?ACTOR_WORKERS_API_CELL_A_STATELESS_AUTH_RECEIPT is required}
auth_b=${ACTOR_WORKERS_API_CELL_B_STATELESS_AUTH_RECEIPT:?ACTOR_WORKERS_API_CELL_B_STATELESS_AUTH_RECEIPT is required}
receipt=${ACTOR_WORKERS_API_CREDENTIAL_RECEIPT:?ACTOR_WORKERS_API_CREDENTIAL_RECEIPT is required}
allow_bootstrap_replacement=${ACTOR_WORKERS_API_ALLOW_BOOTSTRAP_CREDENTIAL_REPLACEMENT:-false}
recovery_receipt=${ACTOR_WORKERS_API_RECOVERY_CREDENTIAL_RECEIPT:-}
namespace=workers-api-system
legacy_secret_name=workers-api-internal-token

for path in "$hub" "$cell_a_kubeconfig" "$cell_b_kubeconfig" "$route_a" "$route_b" "$auth_a" "$auth_b"; do
	[[ $path == /* && -f $path && ! -L $path ]] || { echo "credential input must be an absolute regular file: $path" >&2; exit 2; }
done
[[ -z $recovery_receipt || ($recovery_receipt == /* && -f $recovery_receipt && ! -L $recovery_receipt) ]] || {
	echo "recovery credential receipt must be an absolute regular file" >&2; exit 2;
}
[[ $receipt == /* && ! -e $receipt && -d $(dirname -- "$receipt") \
	&& $allow_bootstrap_replacement =~ ^(true|false)$ ]] || {
	echo "invalid Workers API credential synchronization inputs" >&2
	exit 2
}
for command in kubectl python3; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

temporary=$(mktemp -d /data/tmp/workers-api-credentials.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

for item in a b; do
	if [[ $item == a ]]; then
		cell_kubeconfig=$cell_a_kubeconfig; route=$route_a; auth=$auth_a
	else
		cell_kubeconfig=$cell_b_kubeconfig; route=$route_b; auth=$auth_b
	fi
	python3 - "$route" "$auth" >"$temporary/expected-$item.json" <<'PY'
import hashlib,json,sys
route_path,auth_path=sys.argv[1:]
route,auth=json.load(open(route_path)),json.load(open(auth_path))
if (route.get("schema"),route.get("verdict")) != ("actor-cell-route-publication/v2","passed"):
    raise SystemExit("Cell route receipt did not pass")
if (auth.get("schema"),auth.get("verdict")) != ("actor-stateless-auth/v1","passed"):
    raise SystemExit("stateless auth receipt did not pass")
if route.get("cell") != auth.get("cell"):
    raise SystemExit("Cell route and stateless auth identities differ")
print(json.dumps({
    "cell":route["cell"],
    "routeReceiptSha256":"sha256:"+hashlib.sha256(open(route_path,"rb").read()).hexdigest(),
    "authReceiptSha256":"sha256:"+hashlib.sha256(open(auth_path,"rb").read()).hexdigest(),
    "credential":auth["credential"],
},sort_keys=True))
PY
	cell=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cell"]["name"])' "$temporary/expected-$item.json")
	uid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cell"]["uid"])' "$temporary/expected-$item.json")
	kubectl --kubeconfig "$cell_kubeconfig" -n actor-fdb-cell-system get rivetcell "$cell" -o json >"$temporary/cell-$item.json"
	kubectl --kubeconfig "$cell_kubeconfig" -n actor-fdb-cell-system get secret "${cell}-runtime-auth" -o json >"$temporary/runtime-$item.json"
	kubectl --kubeconfig "$cell_kubeconfig" -n actor-stateless-system get secret "${cell}-stateless-auth" -o json >"$temporary/stateless-$item.json"
	python3 - "$temporary/expected-$item.json" "$temporary/cell-$item.json" \
		"$temporary/runtime-$item.json" "$temporary/stateless-$item.json" "$uid" >"$temporary/data-$item.json" <<'PY'
import base64,hashlib,json,sys
expected,cell,runtime,stateless=(json.load(open(path)) for path in sys.argv[1:5])
expected_uid=sys.argv[5]; name=expected["cell"]["name"]
if cell.get("metadata",{}).get("name") != name or cell.get("metadata",{}).get("uid") != expected_uid:
    raise SystemExit("live RivetCell differs from its immutable route")
if runtime.get("metadata",{}).get("labels",{}).get("fleet.actor.dev/cell-name") != name:
    raise SystemExit("runtime credential belongs to another Cell")
credential=expected["credential"]; metadata=stateless.get("metadata",{})
if (
    metadata.get("name") != credential.get("name") or metadata.get("uid") != credential.get("uid")
    or metadata.get("resourceVersion") != credential.get("resourceVersion")
    or stateless.get("immutable") is not True
):
    raise SystemExit("live stateless credential differs from its receipt")
capabilities=("executor-token","object-router-token","workerd-token")
if credential.get("capabilities") != list(capabilities) or set(stateless.get("data",{})) != set(capabilities):
    raise SystemExit("stateless capability inventory differs")
for capability in capabilities:
    value=base64.b64decode(stateless["data"][capability],validate=True)
    if credential.get("fingerprints",{}).get(capability) != "sha256:"+hashlib.sha256(value).hexdigest():
        raise SystemExit("stateless capability fingerprint differs")
engine=runtime.get("data",{}).get("token")
if not isinstance(engine,str) or len(base64.b64decode(engine,validate=True)) < 32:
    raise SystemExit("runtime capability is absent or too short")
print(json.dumps({
    "cell":expected["cell"],"engine":engine,
    "executor":stateless["data"]["executor-token"],
    "objectRouter":stateless["data"]["object-router-token"],
    "workerd":stateless["data"]["workerd-token"],
    "routeReceiptSha256":expected["routeReceiptSha256"],
    "authReceiptSha256":expected["authReceiptSha256"],
    "credentialUid":metadata["uid"],
},sort_keys=True))
PY
done

hub_kube=(kubectl --kubeconfig "$hub")
"${hub_kube[@]}" create namespace "$namespace" --dry-run=client -o yaml | \
	"${hub_kube[@]}" apply --server-side --field-manager=workers-api-credential-bootstrap -f - >/dev/null
existing=false
if "${hub_kube[@]}" -n "$namespace" get secret "$legacy_secret_name" -o json >"$temporary/existing.json" 2>/dev/null; then
	existing=true
else
	printf '{"data":{"registry-token":""}}\n' >"$temporary/existing.json"
fi
if [[ -n $recovery_receipt ]]; then
	cp -- "$recovery_receipt" "$temporary/recovery.json"
else
	printf '{}\n' >"$temporary/recovery.json"
fi

python3 - "$temporary/data-a.json" "$temporary/data-b.json" "$temporary/existing.json" \
	"$temporary/recovery.json" "$allow_bootstrap_replacement" "$existing" >"$temporary/plan.json" <<'PY'
import base64,hashlib,json,sys
a,b,existing,recovery=(json.load(open(path)) for path in sys.argv[1:5])
allow=sys.argv[5]=="true"; existed=sys.argv[6]=="true"
cells=sorted((a,b),key=lambda item:item["cell"]["name"])
if len({item["cell"]["name"] for item in cells}) != 2 or len({item["cell"]["uid"] for item in cells}) != 2:
    raise SystemExit("Workers API credential input must describe two unique Cells")
data={
    "registry-token":existing.get("data",{}).get("registry-token",""),
    "engine-a-token":cells[0]["engine"],"engine-b-token":cells[1]["engine"],
    "stateless-a-token":cells[0]["executor"],"stateless-b-token":cells[1]["executor"],
    "object-router-a-token":cells[0]["objectRouter"],"object-router-b-token":cells[1]["objectRouter"],
}
decoded=[]
for key,value in data.items():
    try: raw=base64.b64decode(value,validate=True)
    except Exception as error: raise SystemExit(f"invalid Hub capability {key}") from error
    if key != "registry-token":
        if len(raw)<32: raise SystemExit(f"Hub capability {key} is too short")
        decoded.append(raw)
if len(set(decoded)) != len(decoded):
    raise SystemExit("Hub capabilities must be unique across Cells and roles")
actual=existing.get("data",{}) if existed else {}
legacy={"registry-token","engine-a-token","engine-b-token"}
if existed and actual!=data:
    if not allow:
        raise SystemExit("publishing the first versioned Hub credential requires explicit bootstrap authorization")
    if set(actual)!=legacy or any(actual.get(key)!=data[key] for key in legacy):
        raise SystemExit("legacy Hub credential may differ only by absent new role capabilities")
if existed and actual==data:
    recovery_source_uid=(
        recovery.get("bootstrapReplacement",{}).get("sourceCredentialUid")
        or recovery.get("credential",{}).get("uid")
    )
    if (
        not allow
        or (recovery.get("schema"),recovery.get("verdict")) != ("actor-workers-api-credential-sync/v1","passed")
        or recovery_source_uid != existing.get("metadata",{}).get("uid")
    ):
        raise SystemExit("same-name immutable credential recovery requires its exact prior sync receipt")
if not existed:
    raise SystemExit("legacy Hub credential with the Registry capability is absent")
prior_uid=(recovery.get("bootstrapReplacement",{}).get("priorUid") if recovery else None) or existing.get("metadata",{}).get("uid")
content=hashlib.sha256(json.dumps(data,sort_keys=True,separators=(",",":")).encode()).hexdigest()
secret_name="workers-api-internal-token-"+content[:12]
secret={
    "apiVersion":"v1","kind":"Secret","metadata":{
        "name":secret_name,"namespace":"workers-api-system",
        "labels":{"fleet.actor.dev/credential-owner":"external","fleet.actor.dev/component":"workers-api"},
    },"type":"Opaque","immutable":True,"data":data,
}
print(json.dumps({
    "secret":secret,"cells":cells,"priorUid":prior_uid,
    "legacyUid":existing.get("metadata",{}).get("uid"),"recoveredSameName":existed and actual==data,
},separators=(",",":")))
PY

python3 - "$temporary/plan.json" >"$temporary/desired-secret.json" <<'PY'
import json,sys
print(json.dumps(json.load(open(sys.argv[1]))["secret"],separators=(",",":")))
PY
secret_name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["secret"]["metadata"]["name"])' "$temporary/plan.json")
if ! "${hub_kube[@]}" -n "$namespace" get secret "$secret_name" -o json >"$temporary/live.json" 2>/dev/null; then
	"${hub_kube[@]}" -n "$namespace" create -f "$temporary/desired-secret.json" >/dev/null
fi
"${hub_kube[@]}" -n "$namespace" get secret "$secret_name" -o json >"$temporary/live.json"

python3 - "$temporary/plan.json" "$temporary/live.json" "$temporary/existing.json" "$receipt" <<'PY'
import base64,hashlib,json,os,sys,tempfile
plan,live,prior=json.load(open(sys.argv[1])),json.load(open(sys.argv[2])),json.load(open(sys.argv[3]))
output=sys.argv[4]
if live.get("data") != plan["secret"]["data"] or live.get("immutable") is not True:
    raise SystemExit("live Hub credential differs from the reviewed bootstrap plan")
metadata=live["metadata"]
fingerprints={}
for key,value in live["data"].items():
    fingerprints[key]="sha256:"+hashlib.sha256(base64.b64decode(value,validate=True)).hexdigest()
value={
    "schema":"actor-workers-api-credential-sync/v1","verdict":"passed",
    "cells":[{
        "name":item["cell"]["name"],"uid":item["cell"]["uid"],
        "routeReceiptSha256":item["routeReceiptSha256"],
        "statelessAuthReceiptSha256":item["authReceiptSha256"],
        "statelessCredentialUid":item["credentialUid"],
    } for item in plan["cells"]],
    "credential":{
        "namespace":"workers-api-system","name":metadata["name"],
        "uid":metadata["uid"],"resourceVersion":metadata["resourceVersion"],
        "immutable":True,"keys":sorted(live["data"]),"fingerprints":fingerprints,
    },
    "bootstrapReplacement":{
        "performed":bool(plan.get("priorUid")) and plan.get("priorUid") != metadata["uid"],
        "priorUid":plan.get("priorUid"),"sourceCredentialUid":plan.get("legacyUid"),
        "existingCapabilitiesPreserved":True,"replacedInPlace":False,
        "recoveredFromSameNameReplacement":bool(plan.get("recoveredSameName")),
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
printf 'workers_api_credentials=passed receipt=%s\n' "$receipt"
