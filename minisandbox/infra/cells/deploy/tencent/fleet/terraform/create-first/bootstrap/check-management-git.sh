#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?set ACTOR_PULL_CREDENTIAL_RECEIPT}"
: "${ACTOR_MANAGEMENT_PLATFORM_RECEIPT:?set ACTOR_MANAGEMENT_PLATFORM_RECEIPT}"
: "${ACTOR_MANAGEMENT_GIT_RECEIPT:?set ACTOR_MANAGEMENT_GIT_RECEIPT}"
forward_port=${ACTOR_MANAGEMENT_GIT_FORWARD_PORT:-30090}
for command in base64 curl jq kubectl "$python"; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
[[ $forward_port =~ ^[0-9]+$ ]] && (( forward_port >= 1024 && forward_port <= 65535 )) || {
	echo "management Git forward port is invalid" >&2
	exit 2
}

temporary=$(mktemp -d /data/tmp/actor-management-git-check.XXXXXX)
forward_pid=
cleanup() {
	if [[ -n ${forward_pid:-} ]]; then
		kill "$forward_pid" 2>/dev/null || true
		wait "$forward_pid" 2>/dev/null || true
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

ACTOR_CLUSTER_KUBECONFIG="$ACTOR_CLUSTER_KUBECONFIG" \
	"$script_dir/check-management-platform.sh" >"$temporary/platform.json"
"$python" "$script_dir/validate-management-platform-inputs.py" \
	--inventory "$ACTOR_TERRAFORM_INVENTORY" --images "$ACTOR_IMAGE_INVENTORY" \
	--pull-receipt "$ACTOR_PULL_CREDENTIAL_RECEIPT" >"$temporary/plan.json"
"$python" "$script_dir/verify-management-git.py" \
	--receipt "$ACTOR_MANAGEMENT_GIT_RECEIPT" --platform "$temporary/platform.json" \
	--plan "$temporary/plan.json" --images "$ACTOR_IMAGE_INVENTORY" --receipt-only \
	>"$temporary/verified.json"

kube=(kubectl --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG")
"${kube[@]}" get namespace actor-git-system -o json >"$temporary/namespace.json"
"${kube[@]}" -n actor-git-system get secret actor-fleet-tcr -o json >"$temporary/pull-secret.json"
"${kube[@]}" -n actor-git-system get statefulset actor-git -o json >"$temporary/statefulset.json"
"${kube[@]}" -n actor-git-system get pvc actor-git-data -o json >"$temporary/pvc.json"
"${kube[@]}" -n actor-git-system get secret actor-git-bootstrap-credentials -o json \
	>"$temporary/credential-secret.json"
"${kube[@]}" -n argocd get secret actor-fleet-desired-repository -o json \
	>"$temporary/repository-secret.json"

reader_password=$(jq -er '.data["reader-password"]' "$temporary/credential-secret.json" | base64 -d)
"${kube[@]}" -n actor-git-system port-forward service/actor-git "$forward_port:3000" \
	>"$temporary/port-forward.log" 2>&1 &
forward_pid=$!
for _ in $(seq 1 60); do
	if curl --fail --silent "http://127.0.0.1:$forward_port/api/healthz" >/dev/null 2>&1; then break; fi
	sleep 1
done
curl --fail --silent --show-error --user "argocd-reader:$reader_password" \
	"http://127.0.0.1:$forward_port/api/v1/repos/release-publisher/fleet-desired" \
	>"$temporary/repository.json"

"$python" "$script_dir/verify-management-git.py" \
	--receipt "$ACTOR_MANAGEMENT_GIT_RECEIPT" --platform "$temporary/platform.json" \
	--plan "$temporary/plan.json" --images "$ACTOR_IMAGE_INVENTORY" \
	--namespace "$temporary/namespace.json" --pull-secret "$temporary/pull-secret.json" \
	--statefulset "$temporary/statefulset.json" --pvc "$temporary/pvc.json" \
	--credential-secret "$temporary/credential-secret.json" \
	--repository-secret "$temporary/repository-secret.json" \
	--repository "$temporary/repository.json"
