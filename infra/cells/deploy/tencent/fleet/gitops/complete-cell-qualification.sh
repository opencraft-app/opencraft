#!/usr/bin/env bash
set -euo pipefail
umask 077

# Assemble the complete machine-verifiable pre-activation Cell qualification
# chain. This entry point cannot publish qualification, change desiredState,
# create a route, or place an Object.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${PYTHON:-python3}

: "${ACTOR_MANAGEMENT_IMAGE_INVENTORY:?ACTOR_MANAGEMENT_IMAGE_INVENTORY is required}"
: "${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY is required}"
: "${ACTOR_TERRAFORM_INVENTORY:?ACTOR_TERRAFORM_INVENTORY is required}"
: "${ACTOR_MANAGEMENT_PLATFORM_RECEIPT:?ACTOR_MANAGEMENT_PLATFORM_RECEIPT is required}"
: "${ACTOR_MANAGEMENT_GIT_RECEIPT:?ACTOR_MANAGEMENT_GIT_RECEIPT is required}"
: "${ACTOR_MANAGEMENT_DESIRED_RECEIPT:?ACTOR_MANAGEMENT_DESIRED_RECEIPT is required}"
: "${ACTOR_HANDOFF_RECEIPT:?ACTOR_HANDOFF_RECEIPT is required}"
: "${ACTOR_PUBLICATION_RECEIPT:?ACTOR_PUBLICATION_RECEIPT is required}"
: "${ACTOR_CELL_PLATFORM_RECEIPT:?ACTOR_CELL_PLATFORM_RECEIPT is required}"
: "${ACTOR_REGISTRATION_RECEIPT:?ACTOR_REGISTRATION_RECEIPT is required}"
: "${ACTOR_FDB_TLS_RECEIPT:?ACTOR_FDB_TLS_RECEIPT is required}"
: "${ACTOR_QUALIFICATION_AUDIT_RECEIPT:?ACTOR_QUALIFICATION_AUDIT_RECEIPT is required}"
: "${ACTOR_QUALIFICATION_CONTROL_RECEIPT:?ACTOR_QUALIFICATION_CONTROL_RECEIPT is required}"
: "${ACTOR_INITIAL_QUALIFICATION_RECEIPT:?ACTOR_INITIAL_QUALIFICATION_RECEIPT is required}"
: "${ACTOR_ARGO_CONVERGENCE_RECEIPT:?ACTOR_ARGO_CONVERGENCE_RECEIPT is required}"
: "${ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT:?ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT is required}"

command -v "$python" >/dev/null || { echo "PYTHON interpreter is unavailable: $python" >&2; exit 2; }
command -v cmp >/dev/null || { echo "cmp is unavailable" >&2; exit 2; }
command -v sha256sum >/dev/null || { echo "sha256sum is unavailable" >&2; exit 2; }

inputs=(
	"$ACTOR_MANAGEMENT_IMAGE_INVENTORY"
	"$ACTOR_IMAGE_INVENTORY"
	"$ACTOR_TERRAFORM_INVENTORY"
	"$ACTOR_MANAGEMENT_PLATFORM_RECEIPT"
	"$ACTOR_MANAGEMENT_GIT_RECEIPT"
	"$ACTOR_MANAGEMENT_DESIRED_RECEIPT"
	"$ACTOR_HANDOFF_RECEIPT"
	"$ACTOR_PUBLICATION_RECEIPT"
	"$ACTOR_CELL_PLATFORM_RECEIPT"
	"$ACTOR_REGISTRATION_RECEIPT"
	"$ACTOR_FDB_TLS_RECEIPT"
	"$ACTOR_QUALIFICATION_AUDIT_RECEIPT"
	"$ACTOR_QUALIFICATION_CONTROL_RECEIPT"
	"$ACTOR_INITIAL_QUALIFICATION_RECEIPT"
	"$ACTOR_ARGO_CONVERGENCE_RECEIPT"
)
for path in "${inputs[@]}"; do
	[[ $path == /* && -f $path && ! -L $path ]] || {
		echo "qualification input must be an absolute regular non-symlink file: $path" >&2
		exit 2
	}
done
[[ $ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT == /* && \
	-d $(dirname -- "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT") ]] || {
	echo "qualification output must be absolute with an existing parent" >&2
	exit 2
}
[[ ! -L $ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT ]] || {
	echo "qualification output must not be a symlink" >&2
	exit 2
}

arguments=(
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
	--qualification-only
)

if [[ -e $ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT ]]; then
	[[ -f $ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT ]] || {
		echo "existing qualification output is not a regular file" >&2
		exit 2
	}
	temporary_dir=$(mktemp -d /data/tmp/actor-cell-qualification-chain.XXXXXX)
	temporary=$temporary_dir/receipt.json
	trap 'rm -rf -- "$temporary_dir"' EXIT INT TERM
	"$python" "$script_dir/assemble-admission-receipt.py" \
		"${arguments[@]}" --output "$temporary" >/dev/null
	cmp -s "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT" "$temporary" || {
		echo "existing qualification chain differs from current exact inputs" >&2
		exit 1
	}
else
	"$python" "$script_dir/assemble-admission-receipt.py" \
		"${arguments[@]}" --output "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT" >/dev/null
fi

printf 'cell_qualification=passed placement_opened=false operator_activation_required=true receipt=%s sha256=%s\n' \
	"$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT" \
	"$(sha256sum "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT" | cut -d' ' -f1)"
