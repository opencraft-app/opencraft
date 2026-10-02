#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=storage-profile.sh
source "${MESH_DIR}/storage-profile.sh"

[[ $# == 2 ]] || die "usage: reconcile-storage-profile.sh CELL KUBECONFIG"
cell=$1
kubeconfig=$2
namespace=actor-fdb-cell-system
pod=$(kubectl_for "${kubeconfig}" -n "${namespace}" get pod \
	-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=engine" \
	-o jsonpath='{.items[0].metadata.name}')
[[ -n ${pod} ]] || die "${cell} has no Engine Pod for StorageProfile reconciliation"

engine=(kubectl_for "${kubeconfig}" -n "${namespace}" exec "${pod}" -- \
	/opt/actor/bin/rivet-engine --config /etc/actor/runtime/config.jsonc depot)
engine_json() {
	local output json
	output=$("${engine[@]}" "$@")
	# Rivet startup diagnostics currently share stdout with the command result. The JSON result is
	# the final top-level object; never let a log line become policy input.
	json=$(sed -n '/^[[:space:]]*{/,$p' <<<"${output}")
	jq -ce . <<<"${json}" || die "Engine command did not return one trailing JSON object"
}
current=$(engine_json cold-gc-policy-show)
desired=$(jq -cn \
	--argjson enabled "${RIVET_LOCAL_COLD_GC_ENABLED}" \
	--argjson grace "${RIVET_LOCAL_COLD_GC_GRACE_PERIOD_MS}" \
	--argjson concurrency "${RIVET_LOCAL_COLD_GC_MAX_DELETE_CONCURRENCY}" \
	--argjson batch "${RIVET_LOCAL_COLD_GC_MAX_OBJECTS_PER_BATCH}" \
	--argjson attempts "${RIVET_LOCAL_COLD_GC_RETRY_MAX_ATTEMPTS}" \
	--argjson initial "${RIVET_LOCAL_COLD_GC_RETRY_INITIAL_BACKOFF_MS}" \
	--argjson maximum "${RIVET_LOCAL_COLD_GC_RETRY_MAX_BACKOFF_MS}" \
	--argjson dryRun "${RIVET_LOCAL_COLD_GC_DRY_RUN}" \
	'{deletion_enabled:$enabled,grace_period_ms:$grace,max_delete_concurrency:$concurrency,max_objects_per_batch:$batch,retry_max_attempts:$attempts,retry_initial_backoff_ms:$initial,retry_max_backoff_ms:$maximum,dry_run:$dryRun}')
if jq -e --argjson desired "${desired}" '.revision > 0 and .spec == $desired' <<<"${current}" >/dev/null; then
	log "${cell} ColdGcPolicy already matches StorageProfile ${RIVET_LOCAL_STORAGE_PROFILE_ID}"
	exit 0
fi

revision=$(jq -er '.revision' <<<"${current}")
state=disabled
[[ ${RIVET_LOCAL_COLD_GC_ENABLED} == true ]] && state=enabled
command=(cold-gc-policy-set
	--expected-revision "${revision}"
	--state "${state}"
	--grace-period-ms "${RIVET_LOCAL_COLD_GC_GRACE_PERIOD_MS}"
	--max-delete-concurrency "${RIVET_LOCAL_COLD_GC_MAX_DELETE_CONCURRENCY}"
	--max-objects-per-batch "${RIVET_LOCAL_COLD_GC_MAX_OBJECTS_PER_BATCH}"
	--retry-max-attempts "${RIVET_LOCAL_COLD_GC_RETRY_MAX_ATTEMPTS}"
	--retry-initial-backoff-ms "${RIVET_LOCAL_COLD_GC_RETRY_INITIAL_BACKOFF_MS}"
	--retry-max-backoff-ms "${RIVET_LOCAL_COLD_GC_RETRY_MAX_BACKOFF_MS}")
[[ ${RIVET_LOCAL_COLD_GC_DRY_RUN} == true ]] && command+=(--dry-run)
if [[ ${RIVET_LOCAL_COLD_GC_ENABLED} == true ]]; then
	command+=(--confirm-irreversible-exact-key-deletion)
fi
updated=$(engine_json "${command[@]}")
jq -e --argjson desired "${desired}" '.spec == $desired' <<<"${updated}" >/dev/null || \
	die "${cell} ColdGcPolicy did not converge to StorageProfile"
log "${cell} ColdGcPolicy reconciled to StorageProfile ${RIVET_LOCAL_STORAGE_PROFILE_ID}"
