#!/usr/bin/env bash
set -euo pipefail

# Complete the post-human half of Cell admission without copying identities
# between receipts. The qualification activation receipt is the explicit human
# boundary; this script cannot create it or open a Cell.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${PYTHON:-python3}
: "${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY must name the complete image inventory}"
: "${ACTOR_MANAGEMENT_IMAGE_INVENTORY:?ACTOR_MANAGEMENT_IMAGE_INVENTORY must name the management image inventory}"
: "${ACTOR_TERRAFORM_INVENTORY:?ACTOR_TERRAFORM_INVENTORY is required}"
: "${ACTOR_MANAGEMENT_PLATFORM_RECEIPT:?ACTOR_MANAGEMENT_PLATFORM_RECEIPT is required}"
: "${ACTOR_MANAGEMENT_GIT_RECEIPT:?ACTOR_MANAGEMENT_GIT_RECEIPT is required}"
: "${ACTOR_MANAGEMENT_DESIRED_RECEIPT:?ACTOR_MANAGEMENT_DESIRED_RECEIPT is required}"
: "${ACTOR_HANDOFF_RECEIPT:?ACTOR_HANDOFF_RECEIPT is required}"
: "${ACTOR_PUBLICATION_RECEIPT:?ACTOR_PUBLICATION_RECEIPT is required}"
: "${ACTOR_CELL_PLATFORM_RECEIPT:?ACTOR_CELL_PLATFORM_RECEIPT is required}"
: "${ACTOR_REGISTRATION_RECEIPT:?ACTOR_REGISTRATION_RECEIPT is required}"
: "${ACTOR_FDB_TLS_RECEIPT:?ACTOR_FDB_TLS_RECEIPT must name the Cell TLS bootstrap receipt}"
: "${ACTOR_QUALIFICATION_AUDIT_RECEIPT:?ACTOR_QUALIFICATION_AUDIT_RECEIPT is required}"
: "${ACTOR_QUALIFICATION_CONTROL_RECEIPT:?ACTOR_QUALIFICATION_CONTROL_RECEIPT is required}"
: "${ACTOR_INITIAL_QUALIFICATION_RECEIPT:?ACTOR_INITIAL_QUALIFICATION_RECEIPT is required}"
: "${ACTOR_ARGO_CONVERGENCE_RECEIPT:?ACTOR_ARGO_CONVERGENCE_RECEIPT is required}"
: "${ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT:?ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT is required}"
: "${ACTOR_CELL_ADOPTION_RECEIPT:?ACTOR_CELL_ADOPTION_RECEIPT is required}"
: "${ACTOR_CELL_ROUTE_RECEIPT:?ACTOR_CELL_ROUTE_RECEIPT is required}"
: "${ACTOR_QUALIFICATION_ACTIVATION_RECEIPT:?ACTOR_QUALIFICATION_ACTIVATION_RECEIPT is required}"
: "${ACTOR_WORKERS_API_IMAGE_INVENTORY:?ACTOR_WORKERS_API_IMAGE_INVENTORY is required}"
: "${ACTOR_WORKERS_API_PRODUCT_RECEIPT:?ACTOR_WORKERS_API_PRODUCT_RECEIPT is required}"
: "${ACTOR_WORKERS_API_RENDER_RECEIPT:?ACTOR_WORKERS_API_RENDER_RECEIPT is required}"
: "${ACTOR_WORKERS_API_INSTALL_RECEIPT:?ACTOR_WORKERS_API_INSTALL_RECEIPT is required}"
: "${ACTOR_WORKERS_API_ENDPOINT:?ACTOR_WORKERS_API_ENDPOINT is required}"
: "${HUB_KUBECONFIG:?HUB_KUBECONFIG is required}"
: "${CELL_KUBECONFIG:?CELL_KUBECONFIG is required}"
: "${ACTOR_FIRST_PLACEMENT_RECEIPT:?ACTOR_FIRST_PLACEMENT_RECEIPT is required}"
: "${ACTOR_ADMISSION_CHAIN_RECEIPT:?ACTOR_ADMISSION_CHAIN_RECEIPT is required}"
: "${ACTOR_ADMISSION_RUN_ID:?ACTOR_ADMISSION_RUN_ID is required}"
command -v "$python" >/dev/null || { echo "PYTHON interpreter is unavailable: $python" >&2; exit 2; }
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
	echo "PYTHON must select Python 3.10 or newer" >&2
	exit 2
}
[[ $ACTOR_ADMISSION_RUN_ID =~ ^[0-9a-f]{32}$ ]] || {
	echo "ACTOR_ADMISSION_RUN_ID must be 32 lowercase hex characters" >&2
	exit 2
}
for path in \
	"$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_MANAGEMENT_IMAGE_INVENTORY" \
	"$ACTOR_TERRAFORM_INVENTORY" \
	"$ACTOR_MANAGEMENT_PLATFORM_RECEIPT" \
	"$ACTOR_MANAGEMENT_GIT_RECEIPT" \
	"$ACTOR_MANAGEMENT_DESIRED_RECEIPT" \
	"$ACTOR_HANDOFF_RECEIPT" \
	"$ACTOR_PUBLICATION_RECEIPT" \
	"$ACTOR_CELL_PLATFORM_RECEIPT" \
	"$ACTOR_REGISTRATION_RECEIPT" \
	"$ACTOR_FDB_TLS_RECEIPT" \
	"$ACTOR_QUALIFICATION_AUDIT_RECEIPT" \
	"$ACTOR_QUALIFICATION_CONTROL_RECEIPT" \
	"$ACTOR_INITIAL_QUALIFICATION_RECEIPT" \
	"$ACTOR_ARGO_CONVERGENCE_RECEIPT" \
	"$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT" \
	"$ACTOR_CELL_ADOPTION_RECEIPT" \
	"$ACTOR_CELL_ROUTE_RECEIPT" \
	"$ACTOR_QUALIFICATION_ACTIVATION_RECEIPT" \
	"$ACTOR_WORKERS_API_IMAGE_INVENTORY" \
	"$ACTOR_WORKERS_API_PRODUCT_RECEIPT" \
	"$ACTOR_WORKERS_API_RENDER_RECEIPT" \
	"$ACTOR_WORKERS_API_INSTALL_RECEIPT" \
	"$HUB_KUBECONFIG" \
	"$CELL_KUBECONFIG"; do
	[[ $path == /* && -f $path ]] || {
		echo "admission input must be an absolute regular-file path: $path" >&2
		exit 2
	}
done
for output in "$ACTOR_FIRST_PLACEMENT_RECEIPT" "$ACTOR_ADMISSION_CHAIN_RECEIPT"; do
	[[ $output == /* && -d $(dirname -- "$output") ]] || {
		echo "admission output must be absolute with an existing parent: $output" >&2
		exit 2
	}
done
[[ ! -e $ACTOR_ADMISSION_CHAIN_RECEIPT ]] || {
	echo "final admission-chain receipt already exists" >&2
	exit 2
}

preflight_dir=$(mktemp -d /data/tmp/actor-cell-admission-preflight.XXXXXX)
trap 'rm -rf -- "$preflight_dir"' EXIT INT TERM
preflight_receipt=$preflight_dir/receipt.json
assembly_args=(
	--management-images "$ACTOR_MANAGEMENT_IMAGE_INVENTORY"
	--images "$ACTOR_IMAGE_INVENTORY"
	--terraform-inventory "$ACTOR_TERRAFORM_INVENTORY"
	--management-platform "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT"
	--management-git "$ACTOR_MANAGEMENT_GIT_RECEIPT"
	--management-desired "$ACTOR_MANAGEMENT_DESIRED_RECEIPT"
	--handoff "$ACTOR_HANDOFF_RECEIPT"
	--publication "$ACTOR_PUBLICATION_RECEIPT"
	--platform "$ACTOR_CELL_PLATFORM_RECEIPT"
	--registration "$ACTOR_REGISTRATION_RECEIPT"
	--tls "$ACTOR_FDB_TLS_RECEIPT"
	--qualification-audit "$ACTOR_QUALIFICATION_AUDIT_RECEIPT"
	--qualification-control "$ACTOR_QUALIFICATION_CONTROL_RECEIPT"
	--initial-qualification "$ACTOR_INITIAL_QUALIFICATION_RECEIPT"
	--argo "$ACTOR_ARGO_CONVERGENCE_RECEIPT"
	--qualification-chain "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT"
	--adoption "$ACTOR_CELL_ADOPTION_RECEIPT"
	--route "$ACTOR_CELL_ROUTE_RECEIPT"
	--activation "$ACTOR_QUALIFICATION_ACTIVATION_RECEIPT"
	--workers-api-images "$ACTOR_WORKERS_API_IMAGE_INVENTORY"
	--workers-api-product "$ACTOR_WORKERS_API_PRODUCT_RECEIPT"
	--workers-api-render "$ACTOR_WORKERS_API_RENDER_RECEIPT"
	--workers-api-install "$ACTOR_WORKERS_API_INSTALL_RECEIPT"
)

# Validate the complete construction and human-activation chain before the
# first public API mutation. A stale or forged activation receipt must never
# create an Agent and merely fail during the final evidence join.
"$python" "$script_dir/assemble-admission-receipt.py" \
	"${assembly_args[@]}" --preflight-only --output "$preflight_receipt"
jq -e '.schema == "actor-cell-admission-preflight/v1" and .verdict == "passed"' \
	"$preflight_receipt" >/dev/null

if [[ ! -e $ACTOR_FIRST_PLACEMENT_RECEIPT ]]; then
	placement_args=(
		--endpoint "$ACTOR_WORKERS_API_ENDPOINT"
		--hub-kubeconfig "$HUB_KUBECONFIG"
		--cell-kubeconfig "$CELL_KUBECONFIG"
		--route-receipt "$ACTOR_CELL_ROUTE_RECEIPT"
		--receipt "$ACTOR_FIRST_PLACEMENT_RECEIPT"
		--operation-id "$ACTOR_ADMISSION_RUN_ID"
	)
	if [[ -n ${ACTOR_ENGINE_SERVICE:-} ]]; then
		placement_args+=(--engine-service "$ACTOR_ENGINE_SERVICE")
	fi
	"$python" "$script_dir/qualify-first-placement.py" "${placement_args[@]}"
fi
[[ -f $ACTOR_FIRST_PLACEMENT_RECEIPT ]] || {
	echo "first-placement receipt is unavailable" >&2
	exit 1
}
jq -e --arg operation_id "$ACTOR_ADMISSION_RUN_ID" \
	'.schema == "actor-first-placement/v1" and .verdict == "passed" and .operation_id == $operation_id' \
	"$ACTOR_FIRST_PLACEMENT_RECEIPT" >/dev/null || {
	echo "first-placement receipt is not bound to ACTOR_ADMISSION_RUN_ID" >&2
	exit 1
}

"$python" "$script_dir/assemble-admission-receipt.py" \
	"${assembly_args[@]}" \
	--placement "$ACTOR_FIRST_PLACEMENT_RECEIPT" \
	--output "$ACTOR_ADMISSION_CHAIN_RECEIPT"

printf 'cell_admission=passed receipt=%s sha256=%s\n' \
	"$ACTOR_ADMISSION_CHAIN_RECEIPT" \
	"$(sha256sum "$ACTOR_ADMISSION_CHAIN_RECEIPT" | cut -d' ' -f1)"
