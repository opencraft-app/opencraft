#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
operations_dir=$(CDPATH= cd -- "$fleet_dir/operations" && pwd)
kubeconfig_args=()
if [[ -n ${KUBECONFIG:-} ]]; then kubeconfig_args=(--kubeconfig "$KUBECONFIG"); fi
image=${ACTOR_FLEET_CONTROLLER_IMAGE:?ACTOR_FLEET_CONTROLLER_IMAGE must be pinned by registry digest}
source_revision=${ACTOR_SOURCE_REVISION:?ACTOR_SOURCE_REVISION is required}
source_manifest=${ACTOR_SOURCE_MANIFEST_SHA256:?ACTOR_SOURCE_MANIFEST_SHA256 is required}
: "${ACTOR_CELL_NAME:?ACTOR_CELL_NAME must name the exact Cell}"
cell=$ACTOR_CELL_NAME
cell_namespace=${ACTOR_CELL_NAMESPACE:-actor-fdb-cell-system}
update_reporter=${ACTOR_UPDATE_CELL_REPORTER:-1}
expected_fdb_mode=${ACTOR_EXPECTED_FDB_AUTOSCALING_MODE:-ObserveOnly}
apply_profile=${ACTOR_APPLY_FDB_PROFILE:-1}

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="controller.release" \
	AUTONOMY_CONTROL_CELL="$cell" \
	AUTONOMY_CONTROL_NAMESPACE="$cell_namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
		"$operations_dir/assert-autonomy-control.sh"
fi

[[ $image =~ @sha256:[0-9a-f]{64}$ && $source_revision =~ ^[0-9a-f]{40}$ && $source_manifest =~ ^[0-9a-f]{64}$ ]] || {
	echo "release identity is not immutable" >&2; exit 2;
}
[[ $update_reporter == 0 || $update_reporter == 1 ]] || { echo "ACTOR_UPDATE_CELL_REPORTER must be 0 or 1" >&2; exit 2; }
[[ $expected_fdb_mode == ObserveOnly || $expected_fdb_mode == Automatic ]] || { echo "ACTOR_EXPECTED_FDB_AUTOSCALING_MODE must be ObserveOnly or Automatic" >&2; exit 2; }
[[ $apply_profile == 0 || $apply_profile == 1 ]] || { echo "ACTOR_APPLY_FDB_PROFILE must be 0 or 1" >&2; exit 2; }

temporary=$(mktemp -d)
rollback_required=false
controller_name=
controller_namespace=
old_controller_image=
old_reporter_image=
old_controller_annotations='{}'
old_reporter_annotations='{}'
cleanup() { rm -rf -- "$temporary"; }
rollback() {
	local status=$1
	if [[ $status -ne 0 && $rollback_required == true ]]; then
		echo "controller release failed; restoring exact prior images" >&2
		if [[ -n $old_controller_image ]]; then
			kubectl "${kubeconfig_args[@]}" -n "$controller_namespace" set image "deployment/$controller_name" "manager=$old_controller_image" >/dev/null || true
			kubectl "${kubeconfig_args[@]}" -n "$controller_namespace" patch "deployment/$controller_name" --type=json \
				-p "[{\"op\":\"replace\",\"path\":\"/spec/template/metadata/annotations\",\"value\":$old_controller_annotations}]" >/dev/null || true
		fi
		if [[ -n $old_reporter_image ]]; then
			kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" set image "deployment/${cell}-cell-reporter" "reporter=$old_reporter_image" >/dev/null || true
			kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" patch "deployment/${cell}-cell-reporter" --type=json \
				-p "[{\"op\":\"replace\",\"path\":\"/spec/template/metadata/annotations\",\"value\":$old_reporter_annotations}]" >/dev/null || true
		fi
		kubectl "${kubeconfig_args[@]}" -n "$controller_namespace" rollout status "deployment/$controller_name" --timeout=5m >/dev/null 2>&1 || true
		kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" rollout status "deployment/${cell}-cell-reporter" --timeout=5m >/dev/null 2>&1 || true
	fi
	cleanup
	exit "$status"
}
trap 'rollback $?' EXIT
trap 'rollback 130' INT
trap 'rollback 143' TERM

backup_exact_restorable() {
	local backup_url backup_pod description
	backup_url=$(kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" get foundationdbbackup "${cell}-continuous" \
		-o jsonpath='{.status.backupDetails.url}')
	[[ $backup_url == blobstore://* ]] || return 1
	backup_pod=$(kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" get pods \
		-l "foundationdb.org/deployment-name=${cell}-continuous-backup-agents" \
		-o jsonpath='{.items[0].metadata.name}')
	[[ -n $backup_pod ]] || return 1
	description=$(kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" exec "$backup_pod" \
		-c foundationdb -- timeout 45 fdbbackup describe -d "$backup_url")
	grep -q '^Restorable: true$' <<<"$description"
}

backup_exact_restorable
python3 - "${kubeconfig_args[@]}" "$cell_namespace" "$cell" "$expected_fdb_mode" <<'PY'
import json,subprocess,sys
args=sys.argv[1:-3]; namespace,cell,expected_mode=sys.argv[-3:]
def get(*parts): return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
jobs=get("get","jobs","-A").get("items",[])
active=[f'{x["metadata"]["namespace"]}/{x["metadata"]["name"]}' for x in jobs if x.get("status",{}).get("active",0)]
if active: raise SystemExit(f"active Jobs block controller release: {active}")
fdb=get("-n",namespace,"get","foundationdbcluster",cell); h=fdb.get("status",{}).get("health",{})
if not (h.get("available") and h.get("healthy") and h.get("fullReplication") and fdb.get("status",{}).get("generations",{}).get("reconciled")==fdb["metadata"]["generation"]):
    raise SystemExit("FDB preflight failed")
if fdb.get("spec",{}).get("processCounts",{}).get("storage") != 9: raise SystemExit("controller release expects the qualified 9-process baseline")
cell_obj=get("-n",namespace,"get","rivetcell",cell)
autoscale=cell_obj.get("status",{}).get("foundationDBAutoscaling",{})
if autoscale.get("mode") != expected_mode or autoscale.get("desiredProcessCount") != 9:
    raise SystemExit("FDB autoscaling mode or target does not match the explicit controller release contract")
backup=get("-n",namespace,"get","foundationdbbackup",cell+"-continuous").get("status",{}).get("backupDetails",{})
if not backup.get("running"): raise SystemExit("backup preflight failed")
for kind,name in (("deployment",cell+"-engine"),("statefulset",cell+"-runtime-hosts")):
    obj=get("-n",namespace,"get",kind,name)
    if obj.get("status",{}).get("readyReplicas") != 3: raise SystemExit(f"{kind}/{name} is not 3/3 Ready")
PY

controller_json=$(kubectl "${kubeconfig_args[@]}" get deployment -A -l app.kubernetes.io/name=actor-fleet-controller -o json)
controller_namespace=$(printf '%s' "$controller_json" | python3 -c 'import json,sys;o=json.load(sys.stdin);assert len(o["items"])==1;print(o["items"][0]["metadata"]["namespace"])')
controller_name=$(printf '%s' "$controller_json" | python3 -c 'import json,sys;o=json.load(sys.stdin);print(o["items"][0]["metadata"]["name"])')
old_controller_image=$(printf '%s' "$controller_json" | python3 -c 'import json,sys;o=json.load(sys.stdin);print(o["items"][0]["spec"]["template"]["spec"]["containers"][0]["image"])')
old_controller_annotations=$(printf '%s' "$controller_json" | python3 -c 'import json,sys;o=json.load(sys.stdin);print(json.dumps(o["items"][0]["spec"]["template"].get("metadata",{}).get("annotations",{}),separators=(",",":")))')
controller_pull_secret=$(printf '%s' "$controller_json" | python3 -c 'import json,sys;o=json.load(sys.stdin);s=o["items"][0]["spec"]["template"]["spec"].get("imagePullSecrets",[]);assert len(s)==1;print(s[0]["name"])')
if [[ $update_reporter == 1 ]]; then
	reporter_json=$(kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" get "deployment/${cell}-cell-reporter" -o json)
	old_reporter_image=$(printf '%s' "$reporter_json" | python3 -c 'import json,sys;o=json.load(sys.stdin);print(o["spec"]["template"]["spec"]["containers"][0]["image"])')
	old_reporter_annotations=$(printf '%s' "$reporter_json" | python3 -c 'import json,sys;o=json.load(sys.stdin);print(json.dumps(o["spec"]["template"].get("metadata",{}).get("annotations",{}),separators=(",",":")))')
	reporter_pull_secret=$(printf '%s' "$reporter_json" | python3 -c 'import json,sys;o=json.load(sys.stdin);s=o["spec"]["template"]["spec"].get("imagePullSecrets",[]);assert len(s)==1;print(s[0]["name"])')
fi

# Validate the registry credential and executable on every target node before
# changing either live Deployment. The reporter may use a separate namespace
# and therefore receives its own credential probe even though the digest is the
# same.
ACTOR_IMAGE_PREFLIGHT_NAMESPACE="$controller_namespace" \
	ACTOR_IMAGE_PREFLIGHT_NAME=controller-release \
	ACTOR_IMAGE_PREFLIGHT_IMAGE="$image" \
	ACTOR_IMAGE_PREFLIGHT_PULL_SECRET="$controller_pull_secret" \
	ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR=fleet.actor.dev/control-pool=true \
	"$operations_dir/preflight-image-pull.sh" /usr/local/bin/actor-fleet-controller --help
if [[ $update_reporter == 1 ]]; then
	ACTOR_IMAGE_PREFLIGHT_NAMESPACE="$cell_namespace" \
		ACTOR_IMAGE_PREFLIGHT_NAME=reporter-release \
		ACTOR_IMAGE_PREFLIGHT_IMAGE="$image" \
		ACTOR_IMAGE_PREFLIGHT_PULL_SECRET="$reporter_pull_secret" \
		ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR=fleet.actor.dev/control-pool=true \
		"$operations_dir/preflight-image-pull.sh" /usr/local/bin/rivet-cell-reporter --help
fi

kubectl "${kubeconfig_args[@]}" apply --dry-run=server -f "$fleet_dir/crds.yaml" >/dev/null
kubectl "${kubeconfig_args[@]}" apply -f "$fleet_dir/crds.yaml" >/dev/null
if [[ $apply_profile == 1 ]]; then
	kubectl "${kubeconfig_args[@]}" apply --dry-run=server -f "$fleet_dir/beijing-kubernetes-profile.yaml" >/dev/null
	kubectl "${kubeconfig_args[@]}" apply -f "$fleet_dir/beijing-kubernetes-profile.yaml" >/dev/null
fi

kubectl "${kubeconfig_args[@]}" kustomize "$fleet_dir/controller-fdb-operator" >"$temporary/controller-unpinned.yaml"
python3 - "$temporary/controller-unpinned.yaml" "$temporary/controller.yaml" "$image" "$source_revision" "$source_manifest" <<'PY'
import sys
from pathlib import Path

import yaml

source, output, image, revision, manifest = sys.argv[1:]
documents = [document for document in yaml.safe_load_all(Path(source).read_text()) if document]
deployments = [
    document for document in documents
    if document.get("kind") == "Deployment"
    and document.get("metadata", {}).get("name") == "fdb-operator-actor-fleet-controller"
]
if len(deployments) != 1:
    raise SystemExit("rendered release must contain exactly one Fleet controller Deployment")
template = deployments[0]["spec"]["template"]
containers = template["spec"].get("containers", [])
if len(containers) != 1 or containers[0].get("name") != "manager":
    raise SystemExit("Fleet controller Deployment lost its single manager container")
containers[0]["image"] = image
annotations = template.setdefault("metadata", {}).setdefault("annotations", {})
annotations["fleet.actor.dev/source-commit"] = revision
annotations["fleet.actor.dev/source-manifest-sha256"] = manifest
# The qualification builder intentionally uses the distribution PyYAML on
# Python 3.6; that release predates the optional sort_keys keyword.
Path(output).write_text(yaml.safe_dump_all(documents))
PY
kubectl "${kubeconfig_args[@]}" apply --dry-run=server -f "$temporary/controller.yaml" >/dev/null
rollback_required=true
kubectl "${kubeconfig_args[@]}" apply -f "$temporary/controller.yaml" >/dev/null
kubectl "${kubeconfig_args[@]}" -n "$controller_namespace" rollout status "deployment/$controller_name" --timeout=10m

if [[ $update_reporter == 1 ]]; then
	kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" set image "deployment/${cell}-cell-reporter" "reporter=$image" >/dev/null
	kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" patch "deployment/${cell}-cell-reporter" --type merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"fleet.actor.dev/reporter-source-commit\":\"$source_revision\",\"fleet.actor.dev/reporter-source-manifest-sha256\":\"$source_manifest\"}}}}}" >/dev/null
	kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" rollout status "deployment/${cell}-cell-reporter" --timeout=5m
fi

deadline=$((SECONDS + 300))
control_plane_converged=false
while ((SECONDS < deadline)); do
	if kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" get rivetcellreport "$cell" -o json >"$temporary/report.json" && \
		kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" get rivetcell "$cell" -o json >"$temporary/cell.json" && \
		kubectl "${kubeconfig_args[@]}" get pv -l "fleet.actor.dev/cell-name=$cell,fleet.actor.dev/managed-fdb-volume=true" -o json >"$temporary/pvs.json" && \
		python3 - "$temporary/report.json" "$temporary/cell.json" "$temporary/pvs.json" "$expected_fdb_mode" <<'PY'
import json,sys
report,cell,pvs=(json.load(open(path)) for path in sys.argv[1:4])
expected_mode=sys.argv[4]
capacity=report.get("spec",{}).get("capacity",{})
autoscale=cell.get("status",{}).get("foundationDBAutoscaling",{})
inventory=[pv for pv in pvs.get("items",[]) if pv.get("metadata",{}).get("annotations",{}).get("fleet.actor.dev/cell-uid")==cell["metadata"]["uid"]]
ready=(capacity.get("fdbCapacityEvidenceReady") is True and autoscale.get("mode")==expected_mode and
       autoscale.get("desiredProcessCount")==9 and autoscale.get("volumeRetentionSeconds")==2592000 and
       autoscale.get("volumeGCMode")=="ObserveOnly" and len(inventory)==9)
raise SystemExit(0 if ready else 1)
PY
	then control_plane_converged=true; break; fi
	sleep 10
done
if [[ $control_plane_converged != true ]]; then
	echo "controller/reporter capacity status and FDB volume inventory did not converge" >&2
	kubectl "${kubeconfig_args[@]}" -n "$cell_namespace" get rivetcell "$cell" -o jsonpath='{.status.foundationDBAutoscaling}' >&2 || true
	echo >&2
	exit 1
fi

python3 - "${kubeconfig_args[@]}" "$cell_namespace" "$cell" "$image" "$source_revision" "$source_manifest" "$update_reporter" "$expected_fdb_mode" <<'PY'
import json,subprocess,sys
args=sys.argv[1:-7]; namespace,cell,image,revision,manifest,update_reporter,expected_mode=sys.argv[-7:]
def get(*parts): return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
controllers=get("get","deployment","-A","-l","app.kubernetes.io/name=actor-fleet-controller").get("items",[])
assert len(controllers)==1 and controllers[0]["spec"]["template"]["spec"]["containers"][0]["image"]==image
assert controllers[0]["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/source-commit"]==revision
assert controllers[0]["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/source-manifest-sha256"]==manifest
if update_reporter == "1":
    reporter=get("-n",namespace,"get","deployment",cell+"-cell-reporter")
    if reporter["spec"]["template"]["spec"]["containers"][0]["image"] != image: raise AssertionError("reporter image mismatch")
    annotations=reporter["spec"]["template"]["metadata"]["annotations"]
    assert annotations["fleet.actor.dev/reporter-source-commit"]==revision
    assert annotations["fleet.actor.dev/reporter-source-manifest-sha256"]==manifest
cell_obj=get("-n",namespace,"get","rivetcell",cell)
autoscale=cell_obj.get("status",{}).get("foundationDBAutoscaling",{})
assert autoscale.get("mode")==expected_mode and autoscale.get("desiredProcessCount")==9 and autoscale.get("volumeRetentionSeconds")==2592000 and autoscale.get("volumeGCMode")=="ObserveOnly"
report=get("-n",namespace,"get","rivetcellreport",cell)
assert report.get("spec",{}).get("capacity",{}).get("fdbCapacityEvidenceReady") is True
fdb=get("-n",namespace,"get","foundationdbcluster",cell); h=fdb.get("status",{}).get("health",{})
assert fdb.get("spec",{}).get("processCounts",{}).get("storage")==9 and h.get("available") and h.get("healthy") and h.get("fullReplication")
operations=get("-n",namespace,"get","fdbscaleoperations").get("items",[])
assert not [x for x in operations if x.get("status",{}).get("phase") not in ("Succeeded","Failed","RolledBack")]
pvs=[x for x in get("get","pv","-l",f"fleet.actor.dev/cell-name={cell},fleet.actor.dev/managed-fdb-volume=true").get("items",[]) if x.get("metadata",{}).get("annotations",{}).get("fleet.actor.dev/cell-uid")==cell_obj["metadata"]["uid"]]
assert len(pvs)==9
print(json.dumps({"verdict":"passed","mode":autoscale.get("mode"),"fdb_processes":9,"inventory_pvs":len(pvs),"capacity_evidence":True,"source_revision":revision,"image":image},sort_keys=True))
PY

rollback_required=false
