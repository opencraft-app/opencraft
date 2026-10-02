#!/usr/bin/env bash
set -euo pipefail

# Bootstrap only the static-release observer of a pre-ledger qualification
# Cell.  New Cells receive this Deployment and ServiceMonitor during their
# normal declarative install; this guarded path exists solely to bring an old
# qualification Cell to the point where the first-ledger autonomy gate can
# observe, and therefore authorize, the initial transactional release.

required=(
	CELL KUBECONFIG_PATH SOURCE_ROOT TARGET_REPORTER_IMAGE
	EXPECTED_OLD_REPORTER_IMAGE EXPECTED_REPORTER_DEPLOYMENT_UID
	REPORTER_SOURCE_REVISION REPORTER_SOURCE_MANIFEST_SHA256
	IMAGE_INVENTORY_DIGEST OBSERVER_RECEIPT
)
for name in "${required[@]}"; do
	[[ -n ${!name:-} ]] || { echo "required environment variable is empty: $name" >&2; exit 2; }
done

namespace=${CELL_NAMESPACE:-actor-fdb-cell-system}
lock_path=${AUTONOMY_CONTROL_LOCK_PATH:-/data/tmp/actor-autonomy-operations.lock}
metrics_manifest=$SOURCE_ROOT/infra/cells/deploy/tencent/fleet/observability/engine-metrics.yaml
cache_script=$SOURCE_ROOT/infra/cells/deploy/tencent/fleet/operations/cache-qualification-receipt.sh
reporter=${CELL}-cell-reporter

[[ $CELL =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || { echo "invalid Cell name" >&2; exit 2; }
[[ -f $KUBECONFIG_PATH && ! -L $KUBECONFIG_PATH ]] || { echo "exact Cell kubeconfig is required" >&2; exit 2; }
[[ -d $SOURCE_ROOT && ! -L $SOURCE_ROOT && -f $metrics_manifest && -x $cache_script ]] || {
	echo "immutable reviewed source tree is incomplete" >&2
	exit 2
}
[[ $TARGET_REPORTER_IMAGE == *@sha256:* && $EXPECTED_OLD_REPORTER_IMAGE == *@sha256:* ]] || {
	echo "reporter images must be registry digest references" >&2
	exit 2
}
[[ $REPORTER_SOURCE_REVISION =~ ^[0-9a-f]{40}$ ]] || { echo "invalid reporter source revision" >&2; exit 2; }
[[ $REPORTER_SOURCE_MANIFEST_SHA256 =~ ^[0-9a-f]{64}$ ]] || { echo "invalid reporter source manifest" >&2; exit 2; }
[[ $IMAGE_INVENTORY_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid image inventory digest" >&2; exit 2; }
receipt_root=$(readlink -e /data/actor-qualification/receipts)
[[ $OBSERVER_RECEIPT == "$receipt_root"/${CELL}-*.json && ! -L $OBSERVER_RECEIPT ]] || {
	echo "observer receipt must be a new exact-Cell file in the qualification receipt root" >&2
	exit 2
}
for command in kubectl jq sha256sum curl flock mktemp; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done

export KUBECONFIG=$KUBECONFIG_PATH
exec 9>"$lock_path"
flock -n 9 || { echo "another risky Cell operation is active" >&2; exit 75; }

if [[ -e $OBSERVER_RECEIPT ]]; then
	jq -e --arg cell "$CELL" --arg image "$TARGET_REPORTER_IMAGE" '
      .schema == "actor-static-release-observer-bootstrap/v1" and
      .cell == $cell and .verdict == "passed" and
      .target.reporterImage == $image
    ' "$OBSERVER_RECEIPT" >/dev/null || {
		echo "existing observer receipt has a conflicting identity" >&2
		exit 2
	}
	CELL=$CELL CELL_NAMESPACE=$namespace KUBECONFIG_PATH=$KUBECONFIG_PATH \
		"$cache_script" "$OBSERVER_RECEIPT"
	echo "release_observer_bootstrap=already-passed receipt=$OBSERVER_RECEIPT"
	exit 0
fi

[[ -z $(kubectl -n "$namespace" get configmap "${CELL}-release-ledger" --ignore-not-found -o name) ]] || {
	echo "observer bootstrap is forbidden after the first release ledger exists" >&2
	exit 2
}

secret_registries=$(kubectl -n "$namespace" get secret actor-fleet-tcr -o json |
	jq -r '.data[".dockerconfigjson"]|@base64d|fromjson|.auths|keys[]')
target_registry=${TARGET_REPORTER_IMAGE%%/*}
grep -Fxq "$target_registry" <<<"$secret_registries" || {
	echo "actor-fleet-tcr cannot pull the target reporter registry" >&2
	exit 2
}

before=$(kubectl -n "$namespace" get deployment "$reporter" -o json)
deployment_uid=$(jq -er '.metadata.uid' <<<"$before")
current_image=$(jq -er '.spec.template.spec.containers[]|select(.name=="reporter")|.image' <<<"$before")
[[ $deployment_uid == "$EXPECTED_REPORTER_DEPLOYMENT_UID" ]] || {
	echo "reporter Deployment UID changed; refusing a stale bootstrap" >&2
	exit 2
}
case "$current_image" in
	"$EXPECTED_OLD_REPORTER_IMAGE" | "$TARGET_REPORTER_IMAGE") ;;
	*) echo "unexpected reporter image: $current_image" >&2; exit 2 ;;
esac

before_pod_uid=$(kubectl -n "$namespace" get pod \
	-l "fleet.actor.dev/cell-name=$CELL,fleet.actor.dev/component=cell-reporter" -o json |
	jq -er '.items|select(length==1)|.[0].metadata.uid')
engine_uid=$(kubectl -n "$namespace" get deployment "${CELL}-engine" -o jsonpath='{.metadata.uid}')
engine_image=$(kubectl -n "$namespace" get deployment "${CELL}-engine" -o jsonpath='{.spec.template.spec.containers[?(@.name=="engine")].image}')
runtime_uid=$(kubectl -n "$namespace" get statefulset "${CELL}-runtime-hosts" -o jsonpath='{.metadata.uid}')
runtime_image=$(kubectl -n "$namespace" get statefulset "${CELL}-runtime-hosts" -o jsonpath='{.spec.template.spec.containers[?(@.name=="workerd-host")].image}')
nats_uid=$(kubectl -n "$namespace" get statefulset "${CELL}-nats" -o jsonpath='{.metadata.uid}')
nats_image=$(kubectl -n "$namespace" get statefulset "${CELL}-nats" -o jsonpath='{.spec.template.spec.containers[?(@.name=="nats")].image}')

temporary=$(mktemp -d /data/tmp/release-observer-bootstrap.XXXXXX)
pf_reporter=
pf_prometheus=
mutation_started=false
committed=false
cleanup() {
	local status=$?
	[[ -z $pf_reporter ]] || kill "$pf_reporter" 2>/dev/null || true
	[[ -z $pf_prometheus ]] || kill "$pf_prometheus" 2>/dev/null || true
	[[ -z $pf_reporter ]] || wait "$pf_reporter" 2>/dev/null || true
	[[ -z $pf_prometheus ]] || wait "$pf_prometheus" 2>/dev/null || true
	if [[ $status -ne 0 && $mutation_started == true && $committed == false && $current_image != "$TARGET_REPORTER_IMAGE" ]]; then
		echo "observer bootstrap failed; rolling the Reporter back" >&2
		kubectl -n "$namespace" rollout undo deployment/"$reporter" >/dev/null 2>&1 || true
		kubectl -n "$namespace" rollout status deployment/"$reporter" --timeout=5m >/dev/null 2>&1 || true
	fi
	rm -rf -- "$temporary"
	exit "$status"
}
trap cleanup EXIT INT TERM

# This manifest contains only shared metrics Services and ServiceMonitors.  It
# is declarative and idempotent; no Runtime, Engine, NATS or FDB workload is
# mutated by the apply.
kubectl apply -f "$metrics_manifest" >/dev/null
patch=$(jq -cn \
	--arg image "$TARGET_REPORTER_IMAGE" \
	--arg revision "$REPORTER_SOURCE_REVISION" \
	--arg manifest "$REPORTER_SOURCE_MANIFEST_SHA256" \
	--arg inventory "$IMAGE_INVENTORY_DIGEST" '{
  spec:{template:{
    metadata:{annotations:{
      "fleet.actor.dev/reporter-source-commit":$revision,
      "fleet.actor.dev/reporter-source-manifest-sha256":$manifest,
      "fleet.actor.dev/image-inventory-digest":$inventory
    }},
    spec:{
      imagePullSecrets:[{name:"actor-fleet-tcr"}],
      containers:[{name:"reporter",image:$image}]
    }
  }}
}')
mutation_started=true
kubectl -n "$namespace" patch deployment "$reporter" --type=strategic \
	--field-manager=actor-release-observer-bootstrap -p "$patch" >/dev/null
kubectl -n "$namespace" rollout status deployment/"$reporter" --timeout=5m

after=$(kubectl -n "$namespace" get deployment "$reporter" -o json)
[[ $(jq -er '.metadata.uid' <<<"$after") == "$deployment_uid" ]]
[[ $(jq -er '.spec.template.spec.containers[]|select(.name=="reporter")|.image' <<<"$after") == "$TARGET_REPORTER_IMAGE" ]]
[[ $(jq -er '.spec.template.spec.imagePullSecrets[]|select(.name=="actor-fleet-tcr")|.name' <<<"$after") == actor-fleet-tcr ]]
new_pod=$(kubectl -n "$namespace" get pod \
	-l "fleet.actor.dev/cell-name=$CELL,fleet.actor.dev/component=cell-reporter" -o json |
	jq -er '.items|select(length==1)|.[0]')
new_pod_uid=$(jq -er '.metadata.uid' <<<"$new_pod")
new_image_id=$(jq -er '.status.containerStatuses[]|select(.name=="reporter")|.imageID' <<<"$new_pod")
target_digest=${TARGET_REPORTER_IMAGE##*@}
grep -Fq "$target_digest" <<<"$new_image_id"
if [[ $current_image != "$TARGET_REPORTER_IMAGE" ]]; then
	[[ $new_pod_uid != "$before_pod_uid" ]] || { echo "reporter Pod was not replaced" >&2; exit 1; }
fi

[[ $(kubectl -n "$namespace" get deployment "${CELL}-engine" -o jsonpath='{.metadata.uid}') == "$engine_uid" ]]
[[ $(kubectl -n "$namespace" get deployment "${CELL}-engine" -o jsonpath='{.spec.template.spec.containers[?(@.name=="engine")].image}') == "$engine_image" ]]
[[ $(kubectl -n "$namespace" get statefulset "${CELL}-runtime-hosts" -o jsonpath='{.metadata.uid}') == "$runtime_uid" ]]
[[ $(kubectl -n "$namespace" get statefulset "${CELL}-runtime-hosts" -o jsonpath='{.spec.template.spec.containers[?(@.name=="workerd-host")].image}') == "$runtime_image" ]]
[[ $(kubectl -n "$namespace" get statefulset "${CELL}-nats" -o jsonpath='{.metadata.uid}') == "$nats_uid" ]]
[[ $(kubectl -n "$namespace" get statefulset "${CELL}-nats" -o jsonpath='{.spec.template.spec.containers[?(@.name=="nats")].image}') == "$nats_image" ]]

kubectl -n "$namespace" port-forward service/"$reporter" 18081:8081 \
	>"$temporary/reporter-port-forward.log" 2>&1 &
pf_reporter=$!
metrics=
for _ in $(seq 1 30); do
	metrics=$(curl -fsS http://127.0.0.1:18081/metrics 2>/dev/null || true)
	grep -Fq "actor_static_release_converged{cell=\"$CELL\"} 0" <<<"$metrics" && break
	sleep 2
done
grep -Fq "actor_static_release_collection_success{cell=\"$CELL\"} 1" <<<"$metrics"
grep -Fq "actor_static_release_converged{cell=\"$CELL\"} 0" <<<"$metrics"
grep -Eq "actor_static_release_drift_findings\\{cell=\"$CELL\"\\} [1-9][0-9]*" <<<"$metrics"

kubectl -n observability port-forward service/actor-observability-prometheus 19090:9090 \
	>"$temporary/prometheus-port-forward.log" 2>&1 &
pf_prometheus=$!
prom_converged=
prom_drift=
for _ in $(seq 1 75); do
	prom_converged=$(curl -fsSG --data-urlencode "query=actor_static_release_converged{cell=\"$CELL\"}" \
		http://127.0.0.1:19090/api/v1/query 2>/dev/null || true)
	prom_drift=$(curl -fsSG --data-urlencode "query=actor_static_release_drift_findings{cell=\"$CELL\"}" \
		http://127.0.0.1:19090/api/v1/query 2>/dev/null || true)
	if jq -e '.status=="success" and (.data.result|length)==1 and .data.result[0].value[1]=="0"' \
		<<<"$prom_converged" >/dev/null 2>&1 &&
		jq -e '.status=="success" and (.data.result|length)==1 and (.data.result[0].value[1]|tonumber)>=1' \
		<<<"$prom_drift" >/dev/null 2>&1; then
		break
	fi
	sleep 2
done
jq -e '.status=="success" and (.data.result|length)==1 and .data.result[0].value[1]=="0"' \
	<<<"$prom_converged" >/dev/null
jq -e '.status=="success" and (.data.result|length)==1 and (.data.result[0].value[1]|tonumber)>=1' \
	<<<"$prom_drift" >/dev/null

service_monitor_uid=$(kubectl -n observability get servicemonitor actor-static-release -o jsonpath='{.metadata.uid}')
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
receipt_temporary=$(mktemp "$receipt_root/.release-observer-bootstrap.XXXXXX")
jq -n \
	--arg timestamp "$timestamp" --arg cell "$CELL" --arg namespace "$namespace" \
	--arg deployment_uid "$deployment_uid" --arg before_pod_uid "$before_pod_uid" \
	--arg after_pod_uid "$new_pod_uid" --arg old_image "$current_image" \
	--arg target_image "$TARGET_REPORTER_IMAGE" --arg image_id "$new_image_id" \
	--arg source_revision "$REPORTER_SOURCE_REVISION" \
	--arg source_manifest "$REPORTER_SOURCE_MANIFEST_SHA256" \
	--arg inventory_digest "$IMAGE_INVENTORY_DIGEST" \
	--arg service_monitor_uid "$service_monitor_uid" \
	--arg engine_uid "$engine_uid" --arg engine_image "$engine_image" \
	--arg runtime_uid "$runtime_uid" --arg runtime_image "$runtime_image" \
	--arg nats_uid "$nats_uid" --arg nats_image "$nats_image" '{
  schema:"actor-static-release-observer-bootstrap/v1",
  timestamp:$timestamp,
  cell:$cell,
  namespace:$namespace,
  verdict:"passed",
  preconditions:{
    releaseLedgerAbsent:true,
    deploymentUid:$deployment_uid,
    podUid:$before_pod_uid,
    reporterImage:$old_image
  },
  target:{
    reporterImage:$target_image,
    sourceRevision:$source_revision,
    sourceManifestSha256:$source_manifest,
    imageInventoryDigest:$inventory_digest
  },
  result:{
    deploymentUidPreserved:true,
    podUid:$after_pod_uid,
    imageId:$image_id,
    serviceMonitorUid:$service_monitor_uid,
    directMetrics:{collectionSuccess:1,converged:0,driftFindingsAtLeast:1},
    prometheusMetrics:{converged:0,driftFindingsAtLeast:1}
  },
  untouched:{
    engine:{uid:$engine_uid,image:$engine_image},
    runtime:{uid:$runtime_uid,image:$runtime_image},
    nats:{uid:$nats_uid,image:$nats_image}
  }
}' >"$receipt_temporary"
chmod 0400 "$receipt_temporary"
mv "$receipt_temporary" "$OBSERVER_RECEIPT"
CELL=$CELL CELL_NAMESPACE=$namespace KUBECONFIG_PATH=$KUBECONFIG_PATH \
	"$cache_script" "$OBSERVER_RECEIPT"
committed=true
sha256sum "$OBSERVER_RECEIPT"
echo "release_observer_bootstrap=passed receipt=$OBSERVER_RECEIPT"
