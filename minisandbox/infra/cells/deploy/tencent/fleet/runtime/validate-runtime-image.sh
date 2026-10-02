#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell_name=$RIVET_CELL_NAME
runtime_image=${RIVET_RUNTIME_IMAGE:?RIVET_RUNTIME_IMAGE must be pinned by registry digest}
runtime_config=${RIVET_RUNTIME_CONFIG_FILE:?RIVET_RUNTIME_CONFIG_FILE must name the rendered production config}
source_revision=${RIVET_SOURCE_REVISION:?RIVET_SOURCE_REVISION must identify the expected complete source revision}
source_manifest_sha=${RIVET_SOURCE_MANIFEST_SHA256:?RIVET_SOURCE_MANIFEST_SHA256 must bind the reviewed source manifest}
[[ $source_manifest_sha =~ ^[0-9a-f]{64}$ ]] || {
	echo "RIVET_SOURCE_MANIFEST_SHA256 must be a lowercase SHA-256" >&2
	exit 2
}
[[ $runtime_image =~ @sha256:[0-9a-f]{64}$ ]] || {
	echo "RIVET_RUNTIME_IMAGE must be pinned by registry digest" >&2
	exit 2
}
[[ -s $runtime_config ]] || {
	echo "rendered runtime config is missing or empty: $runtime_config" >&2
	exit 2
}

kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
suffix=${runtime_image##*@sha256:}
name="${cell_name}-release-check-${suffix:0:12}"
temporary=$(mktemp -d)
cleanup() {
	kubectl "${kubeconfig_args[@]}" -n "$namespace" delete job "$name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
	kubectl "${kubeconfig_args[@]}" -n "$namespace" delete configmap "$name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
	rm -rf -- "$temporary"
}
trap cleanup EXIT

kubectl "${kubeconfig_args[@]}" -n "$namespace" delete job "$name" --ignore-not-found --wait=true >/dev/null
kubectl "${kubeconfig_args[@]}" -n "$namespace" create configmap "$name" \
	--from-file=config.jsonc="$runtime_config" --dry-run=client -o yaml | \
	kubectl "${kubeconfig_args[@]}" apply -f - >/dev/null
cat >"$temporary/job.yaml" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $name
  namespace: $namespace
  labels:
    fleet.actor.dev/cell-name: $cell_name
    fleet.actor.dev/component: release-compatibility-check
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 180
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        fleet.actor.dev/cell-name: $cell_name
        fleet.actor.dev/component: release-compatibility-check
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 4059
        runAsGroup: 4059
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: validate
          image: $runtime_image
          imagePullPolicy: IfNotPresent
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          command: ["/bin/sh", "-eu", "-c"]
          args:
            - test "\$(cat /opt/actor/share/source-revision)" = "\$EXPECTED_SOURCE_REVISION";
              test "\$(cat /opt/actor/share/source-manifest-sha256)" = "\$EXPECTED_SOURCE_MANIFEST_SHA256";
              exec /opt/actor/bin/rivet-engine --config /release/config.jsonc config show
          env:
            - name: EXPECTED_SOURCE_REVISION
              value: "$source_revision"
            - name: EXPECTED_SOURCE_MANIFEST_SHA256
              value: "$source_manifest_sha"
          volumeMounts:
            - name: config
              mountPath: /release
              readOnly: true
      imagePullSecrets:
        - name: actor-fleet-tcr
      volumes:
        - name: config
          configMap:
            name: $name
EOF
kubectl "${kubeconfig_args[@]}" apply -f "$temporary/job.yaml" >/dev/null
if ! kubectl "${kubeconfig_args[@]}" -n "$namespace" wait --for=condition=complete "job/$name" --timeout=4m >/dev/null; then
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get job "$name" -o wide >&2 || true
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods -l "job-name=$name" -o wide >&2 || true
	kubectl "${kubeconfig_args[@]}" -n "$namespace" describe job "$name" >&2 || true
	for pod in $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "job-name=$name" -o name 2>/dev/null); do
		kubectl "${kubeconfig_args[@]}" -n "$namespace" describe "$pod" >&2 || true
	done
	kubectl "${kubeconfig_args[@]}" -n "$namespace" logs "job/$name" --all-containers >&2 || true
	exit 1
fi

# Some older serde-flatten Engine binaries accept an unsupported NATS option
# but silently select the default in-process driver. Exit status alone cannot
# establish cross-replica PubSub. Attest the resolved driver, not just raw JSON.
kubectl "${kubeconfig_args[@]}" -n "$namespace" logs "job/$name" >"$temporary/resolved-config.txt"
python3 "$script_dir/verify-runtime-pubsub.py" "$runtime_config" "$temporary/resolved-config.txt"

# Release preparation and Node admission deliberately have different owners.
# This preflight warms and executes the candidate digest on every compute Node,
# but it never changes a Node's durable admission evidence or scheduling fence.
ACTOR_IMAGE_PREFLIGHT_NAMESPACE="$namespace" \
ACTOR_IMAGE_PREFLIGHT_NAME="${cell_name}-runtime" \
ACTOR_IMAGE_PREFLIGHT_IMAGE="$runtime_image" \
ACTOR_IMAGE_PREFLIGHT_PULL_SECRET=actor-fleet-tcr \
ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR="fleet.actor.dev/cell-name=${cell_name},rivet.dev/compute=true" \
ACTOR_IMAGE_PREFLIGHT_TIMEOUT_SECONDS=600 \
	"$script_dir/../operations/preflight-image-pull.sh" /opt/actor/bin/workerd --version

echo "runtime image accepted the rendered production config and every compute Node: $runtime_image"
