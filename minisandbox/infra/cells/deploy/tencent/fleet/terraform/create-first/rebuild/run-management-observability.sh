#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
observability_dir=$fleet_dir/observability/federation
gitops_dir=$observability_dir/gitops
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}

: "${ACTOR_REBUILD_STATE_DIR:?set ACTOR_REBUILD_STATE_DIR}"
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_FEDERATION_TARGETS:?set ACTOR_FEDERATION_TARGETS}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_MANAGEMENT_GIT_CREDENTIAL:?set ACTOR_MANAGEMENT_GIT_CREDENTIAL}"
: "${ACTOR_OBSERVABILITY_CHART_ARCHIVE:?set ACTOR_OBSERVABILITY_CHART_ARCHIVE}"
: "${ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE:?set ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE}"
: "${ACTOR_OBSERVABILITY_IMAGE_REGISTRY:?set ACTOR_OBSERVABILITY_IMAGE_REGISTRY}"

for command in "$python" flock helm jq kubectl git curl cmp diff install sha256sum stat; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
[[ $ACTOR_REBUILD_STATE_DIR == /* && $ACTOR_REBUILD_STATE_DIR != / && \
	-d $ACTOR_REBUILD_STATE_DIR && ! -L $ACTOR_REBUILD_STATE_DIR ]] || {
	echo "ACTOR_REBUILD_STATE_DIR must be an existing absolute real directory" >&2; exit 2;
}
(( (8#$(stat -c '%a' "$ACTOR_REBUILD_STATE_DIR") & 8#077) == 0 )) || {
	echo "ACTOR_REBUILD_STATE_DIR must not be group/world accessible" >&2; exit 2;
}
for path in "$ACTOR_CLUSTER_KUBECONFIG" "$ACTOR_FEDERATION_TARGETS" \
	"$ACTOR_IMAGE_INVENTORY" "$ACTOR_MANAGEMENT_GIT_CREDENTIAL" \
	"$ACTOR_OBSERVABILITY_CHART_ARCHIVE" "$ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE"; do
	[[ $path == /* && -f $path && ! -L $path ]] || {
		echo "observability rebuild input must be an absolute regular non-symlink file: $path" >&2; exit 2;
	}
done
[[ $ACTOR_OBSERVABILITY_IMAGE_REGISTRY =~ ^[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || {
	echo "ACTOR_OBSERVABILITY_IMAGE_REGISTRY must be a hostname with an optional port" >&2; exit 2;
}

exec 9>"$ACTOR_REBUILD_STATE_DIR/.management-observability.lock"
flock -n 9 || { echo "another management observability phase owns this rebuild state" >&2; exit 1; }

desired_parent=$ACTOR_REBUILD_STATE_DIR/desired/observability
desired=$desired_parent/git
receipts=$ACTOR_REBUILD_STATE_DIR/receipts/observability
render_receipt=$receipts/render.json
publication_receipt=$receipts/git-publication.json
application=$desired_parent/application.yaml
convergence_receipt=$receipts/argocd-convergence.json
install -d -m 0755 "$ACTOR_REBUILD_STATE_DIR/desired" "$desired_parent" \
	"$ACTOR_REBUILD_STATE_DIR/receipts" "$receipts"

temporary=$(mktemp -d /data/tmp/actor-management-observability-phase.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

require_regular() {
	[[ -f $1 && ! -L $1 ]] || { echo "partial observability state is not a regular file: $1" >&2; exit 2; }
}

if [[ ! -e $desired && ! -e $render_receipt ]]; then
	echo 'management_observability_phase=installing_pinned_bootstrap'
	KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG \
	ACTOR_FEDERATION_TARGETS=$ACTOR_FEDERATION_TARGETS \
	ACTOR_IMAGE_INVENTORY=$ACTOR_IMAGE_INVENTORY \
	ACTOR_OBSERVABILITY_IMAGE_REGISTRY=$ACTOR_OBSERVABILITY_IMAGE_REGISTRY \
	ACTOR_OBSERVABILITY_IMAGE_NAMESPACE=${ACTOR_OBSERVABILITY_IMAGE_NAMESPACE:-actor-fleet} \
	ACTOR_OBSERVABILITY_CHART_ARCHIVE=$ACTOR_OBSERVABILITY_CHART_ARCHIVE \
	ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE=$ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE \
		"$observability_dir/install-hub.sh"
elif [[ ! -e $desired || ! -e $render_receipt ]]; then
	echo "observability desired state is partial" >&2
	exit 2
fi

helm --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG" -n mesh-observability \
	get manifest actor-mesh-observability >"$temporary/release.yaml"
helm --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG" -n mesh-observability \
	get manifest actor-mesh-prometheus-adapter >>"$temporary/release.yaml"
render=(
	"$python" "$gitops_dir/render-desired-state.py"
	--manifest "$temporary/release.yaml"
	--manifest "$observability_dir/hub-storage.yaml"
	--manifest "$observability_dir/hub-rules.yaml"
	--manifest "$observability_dir/hub-dashboard.yaml"
	--manifest "$observability_dir/hub-compute-dashboard.yaml"
	--manifest "$observability_dir/hub-storage-dashboard.yaml"
	--manifest "$observability_dir/hub-cold-tier-dashboard.yaml"
	--manifest "$observability_dir/hub-workers-api.yaml"
	--manifest "$observability_dir/hub-workers-dashboard.yaml"
	--output "$temporary/git"
	--receipt "$temporary/render.json"
)
"${render[@]}" >/dev/null
if [[ -e $desired || -e $render_receipt ]]; then
	[[ -d $desired && ! -L $desired ]] || { echo "observability desired state is partial" >&2; exit 2; }
	require_regular "$render_receipt"
	diff -qr --no-dereference "$desired" "$temporary/git" >/dev/null || {
		echo "resumed observability desired state differs from the installed pinned release" >&2; exit 1;
	}
	cmp -s "$render_receipt" "$temporary/render.json" || {
		echo "resumed observability render receipt differs from the installed pinned release" >&2; exit 1;
	}
else
	echo 'management_observability_phase=recording_git_desired_state'
	mv -- "$temporary/git" "$desired"
	mv -- "$temporary/render.json" "$render_receipt"
	chmod 0644 "$render_receipt"
fi

if [[ -e $publication_receipt ]]; then
	require_regular "$publication_receipt"
else
	echo 'management_observability_phase=publishing_git_desired_state'
	HUB_KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG \
	ACTOR_MANAGEMENT_GIT_CREDENTIAL=$ACTOR_MANAGEMENT_GIT_CREDENTIAL \
	ACTOR_MANAGEMENT_EXPECTED_REVISION=${ACTOR_MANAGEMENT_EXPECTED_REVISION:-auto} \
		"$gitops_dir/publish.sh" "$desired" "$render_receipt" "$publication_receipt"
fi

repository=$(jq -er '.repository.url' "$publication_receipt")
revision=$(jq -er '.gitRevision' "$publication_receipt")
"$python" "$gitops_dir/render-application.py" --repository "$repository" \
	--revision "$revision" --output "$temporary/application.yaml" >/dev/null
if [[ -e $application ]]; then
	require_regular "$application"
	cmp -s "$application" "$temporary/application.yaml" || {
		echo "resumed observability Application differs from publication evidence" >&2; exit 1;
	}
else
	mv -- "$temporary/application.yaml" "$application"
	chmod 0644 "$application"
fi

echo 'management_observability_phase=adopting_and_verifying'
HUB_KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG \
	"$gitops_dir/install-application.sh" "$application" "$publication_receipt" \
	"$render_receipt" "$temporary/convergence.json"
if [[ -e $convergence_receipt ]]; then
	require_regular "$convergence_receipt"
	cmp -s "$convergence_receipt" "$temporary/convergence.json" || {
		echo "live Argo convergence differs from immutable observability evidence" >&2; exit 1;
	}
else
	mv -- "$temporary/convergence.json" "$convergence_receipt"
	chmod 0644 "$convergence_receipt"
fi
KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG ACTOR_FEDERATION_TARGETS=$ACTOR_FEDERATION_TARGETS \
	"$observability_dir/verify-hub.sh"

printf 'management_observability_phase=passed receipt=%s sha256=%s\n' \
	"$convergence_receipt" "$(sha256sum "$convergence_receipt" | cut -d' ' -f1)"
