#!/usr/bin/env bash
set -euo pipefail
umask 077

# Complete the post-human central adoption boundary for one qualified Cell.
# This entry point cannot create the activation receipt or place an Actor.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${PYTHON:-python3}

: "${HUB_KUBECONFIG:?HUB_KUBECONFIG is required}"
: "${CELL_KUBECONFIG:?CELL_KUBECONFIG is required}"
: "${ACTOR_ARGO_CONVERGENCE_RECEIPT:?ACTOR_ARGO_CONVERGENCE_RECEIPT is required}"
: "${ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT:?ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT is required}"
: "${ACTOR_QUALIFICATION_ACTIVATION_RECEIPT:?ACTOR_QUALIFICATION_ACTIVATION_RECEIPT is required}"
: "${ACTOR_CELL_ADOPTION_RECEIPT:?ACTOR_CELL_ADOPTION_RECEIPT is required}"
: "${ACTOR_CELL_ROUTE_RECEIPT:?ACTOR_CELL_ROUTE_RECEIPT is required}"

namespace=${ACTOR_WORKERS_API_NAMESPACE:-workers-api-system}
timeout=${ACTOR_CELL_BIND_TIMEOUT_SECONDS:-300}
poll=${ACTOR_CELL_BIND_POLL_SECONDS:-2}
[[ $namespace =~ ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || {
	echo "ACTOR_WORKERS_API_NAMESPACE must be a DNS label" >&2
	exit 2
}
[[ $timeout =~ ^[0-9]+$ && $timeout -ge 1 && $timeout -le 3600 ]] || {
	echo "ACTOR_CELL_BIND_TIMEOUT_SECONDS must be between 1 and 3600" >&2
	exit 2
}
[[ $poll =~ ^[0-9]+$ && $poll -ge 1 && $poll -le 30 ]] || {
	echo "ACTOR_CELL_BIND_POLL_SECONDS must be between 1 and 30" >&2
	exit 2
}

for command in "$python" jq kubectl flock sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
for path in \
	"$HUB_KUBECONFIG" \
	"$CELL_KUBECONFIG" \
	"$ACTOR_ARGO_CONVERGENCE_RECEIPT" \
	"$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT" \
	"$ACTOR_QUALIFICATION_ACTIVATION_RECEIPT"; do
	[[ $path == /* && -f $path && ! -L $path ]] || {
		echo "Cell adoption input must be an absolute regular non-symlink file: $path" >&2
		exit 2
	}
done
for output in "$ACTOR_CELL_ADOPTION_RECEIPT" "$ACTOR_CELL_ROUTE_RECEIPT"; do
	[[ $output == /* && -d $(dirname -- "$output") && ! -L $output ]] || {
		echo "Cell adoption output must be absolute, non-symlink, and have an existing parent: $output" >&2
		exit 2
	}
done

cell=$(jq -er '.cell.id' "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT")
[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ ]] || {
	echo "qualification chain Cell identity is invalid" >&2
	exit 1
}
lock=$(dirname -- "$ACTOR_CELL_ADOPTION_RECEIPT")/.cell-adoption-$cell.lock
exec 9>"$lock"
flock -n 9 || { echo "another Cell adoption operation owns this receipt directory" >&2; exit 1; }

echo 'cell_adoption_phase=publishing_registration'
"$python" "$script_dir/adopt-cell.py" \
	--hub-kubeconfig "$HUB_KUBECONFIG" \
	--cell-kubeconfig "$CELL_KUBECONFIG" \
	--convergence-receipt "$ACTOR_ARGO_CONVERGENCE_RECEIPT" \
	--qualification-chain "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT" \
	--activation-receipt "$ACTOR_QUALIFICATION_ACTIVATION_RECEIPT" \
	--receipt "$ACTOR_CELL_ADOPTION_RECEIPT"

claim=$(jq -er '.claim.name' "$ACTOR_CELL_ADOPTION_RECEIPT")
claim_uid=$(jq -er '.claim.uid' "$ACTOR_CELL_ADOPTION_RECEIPT")
pool_uid=$(jq -er '.pool.uid' "$ACTOR_CELL_ADOPTION_RECEIPT")
spoke_uid=$(jq -er '.cell.uid' "$ACTOR_CELL_ADOPTION_RECEIPT")
[[ $claim =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && -n $claim_uid && -n $pool_uid && -n $spoke_uid ]] || {
	echo "adoption receipt identity is invalid" >&2
	exit 1
}

echo 'cell_adoption_phase=waiting_for_bound_claim'
deadline=$((SECONDS + timeout))
while true; do
	if live=$(kubectl --kubeconfig "$HUB_KUBECONFIG" -n actor-fleet-system \
		get rivetcellclaim "$claim" -o json 2>/dev/null); then
		live_uid=$(jq -er '.metadata.uid' <<<"$live")
		live_pool_uid=$(jq -er '.spec.poolRef.uid' <<<"$live")
		[[ $live_uid == "$claim_uid" && $live_pool_uid == "$pool_uid" ]] || {
			echo "live Claim identity changed while waiting for adoption" >&2
			exit 1
		}
		phase=$(jq -r '.status.phase // ""' <<<"$live")
		if [[ $phase == Bound ]]; then
			observed_spoke_uid=$(jq -er '.status.spokeCellRef.uid' <<<"$live")
			[[ $observed_spoke_uid == "$spoke_uid" ]] || {
				echo "Bound Claim observed another spoke Cell UID" >&2
				exit 1
			}
			break
		fi
		[[ $phase != Failed ]] || {
			echo "central Claim entered Failed while adopting the Cell" >&2
			exit 1
		}
	fi
	(( SECONDS < deadline )) || {
		echo "timed out waiting for the exact central Claim to become Bound" >&2
		exit 1
	}
	sleep "$poll"
done

echo 'cell_adoption_phase=publishing_route'
"$python" "$script_dir/publish-cell-route.py" \
	--hub-kubeconfig "$HUB_KUBECONFIG" \
	--convergence-receipt "$ACTOR_ARGO_CONVERGENCE_RECEIPT" \
	--qualification-chain "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT" \
	--activation-receipt "$ACTOR_QUALIFICATION_ACTIVATION_RECEIPT" \
	--adoption-receipt "$ACTOR_CELL_ADOPTION_RECEIPT" \
	--namespace "$namespace" \
	--receipt "$ACTOR_CELL_ROUTE_RECEIPT"

printf 'cell_adoption_phase=passed adoption_sha256=%s route_sha256=%s\n' \
	"$(sha256sum "$ACTOR_CELL_ADOPTION_RECEIPT" | cut -d' ' -f1)" \
	"$(sha256sum "$ACTOR_CELL_ROUTE_RECEIPT" | cut -d' ' -f1)"
