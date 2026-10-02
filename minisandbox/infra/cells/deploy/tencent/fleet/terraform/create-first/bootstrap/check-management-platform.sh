#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?set ACTOR_PULL_CREDENTIAL_RECEIPT}"
: "${ACTOR_MANAGEMENT_PLATFORM_RECEIPT:?set ACTOR_MANAGEMENT_PLATFORM_RECEIPT}"

temporary=$(mktemp -d /data/tmp/actor-management-platform-check.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
"$python" "$script_dir/validate-management-platform-inputs.py" \
	--inventory "$ACTOR_TERRAFORM_INVENTORY" --images "$ACTOR_IMAGE_INVENTORY" \
	--pull-receipt "$ACTOR_PULL_CREDENTIAL_RECEIPT" >"$temporary/plan.json"
"$python" "$script_dir/verify-management-platform.py" \
	--platform-receipt "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT" --plan "$temporary/plan.json" \
	--receipt-only >"$temporary/platform.json"

kube=(kubectl --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG")
"${kube[@]}" get namespace kube-system -o json >"$temporary/kube-system.json"
"${kube[@]}" get namespace argocd -o json >"$temporary/argocd-namespace.json"
"${kube[@]}" -n argocd get secret actor-fleet-tcr -o json >"$temporary/pull-secret.json"
live_args=()
while IFS=$'\t' read -r kind name; do
	case "$kind" in
		Deployment|StatefulSet)
			output="$temporary/${kind,,}-$name.json"
			"${kube[@]}" -n argocd get "${kind,,}" "$name" -o json >"$output"
			;;
		CustomResourceDefinition)
			output="$temporary/crd-$name.json"
			"${kube[@]}" get crd "$name" -o json >"$output"
			;;
		*) echo "unsupported management platform identity: $kind/$name" >&2; exit 1 ;;
	esac
	live_args+=(--live "$output")
done < <(jq -r '(.workloads[] | [.kind,.name]),
                    (.crds[] | ["CustomResourceDefinition",.name]) | @tsv' \
	"$temporary/platform.json")

"$python" "$script_dir/verify-management-platform.py" \
	--platform-receipt "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT" --plan "$temporary/plan.json" \
	--kube-system "$temporary/kube-system.json" --namespace "$temporary/argocd-namespace.json" \
	--pull-secret "$temporary/pull-secret.json" "${live_args[@]}"
