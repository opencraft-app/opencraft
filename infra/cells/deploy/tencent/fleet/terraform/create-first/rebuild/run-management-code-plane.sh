#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
bootstrap_dir=$script_dir/../bootstrap
code_plane_dir=$fleet_dir/code-plane
gitops_dir=$code_plane_dir/gitops
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}

: "${ACTOR_REBUILD_STATE_DIR:?set ACTOR_REBUILD_STATE_DIR}"
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
management_bootstrap_images=${ACTOR_MANAGEMENT_BOOTSTRAP_IMAGE_INVENTORY:-$ACTOR_IMAGE_INVENTORY}
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_STORAGE_CREDENTIAL_SOURCE:?set ACTOR_STORAGE_CREDENTIAL_SOURCE}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?set ACTOR_PULL_CREDENTIAL_RECEIPT}"
: "${ACTOR_MANAGEMENT_PLATFORM_RECEIPT:?set ACTOR_MANAGEMENT_PLATFORM_RECEIPT}"
: "${ACTOR_MANAGEMENT_GIT_RECEIPT:?set ACTOR_MANAGEMENT_GIT_RECEIPT}"
: "${ACTOR_MANAGEMENT_GIT_CREDENTIAL:?set ACTOR_MANAGEMENT_GIT_CREDENTIAL}"

for command in "$python" flock jq kubectl git curl awk cmp diff find install sha256sum stat; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
[[ $ACTOR_REBUILD_STATE_DIR == /* && $ACTOR_REBUILD_STATE_DIR != / && -d $ACTOR_REBUILD_STATE_DIR && ! -L $ACTOR_REBUILD_STATE_DIR ]] || {
	echo "ACTOR_REBUILD_STATE_DIR must be an existing absolute real directory" >&2; exit 2;
}
(( (8#$(stat -c '%a' "$ACTOR_REBUILD_STATE_DIR") & 8#077) == 0 )) || {
	echo "ACTOR_REBUILD_STATE_DIR must not be group/world accessible" >&2; exit 2;
}
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_CLUSTER_KUBECONFIG" "$ACTOR_STORAGE_CREDENTIAL_SOURCE" \
	"$management_bootstrap_images" \
	"$ACTOR_PULL_CREDENTIAL_RECEIPT" "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT" \
	"$ACTOR_MANAGEMENT_GIT_RECEIPT" "$ACTOR_MANAGEMENT_GIT_CREDENTIAL"; do
	[[ $path == /* && -f $path && ! -L $path ]] || {
		echo "rebuild input must be an absolute regular non-symlink file: $path" >&2; exit 2;
	}
done

exec 9>"$ACTOR_REBUILD_STATE_DIR/.management-code-plane.lock"
flock -n 9 || { echo "another management Code Plane phase owns this rebuild state" >&2; exit 1; }

private=$ACTOR_REBUILD_STATE_DIR/private/code-plane
desired_parent=$ACTOR_REBUILD_STATE_DIR/desired/code-plane
bootstrap_desired=$desired_parent/bootstrap
git_desired=$desired_parent/git
receipts=$ACTOR_REBUILD_STATE_DIR/receipts/code-plane
render_receipt=$receipts/render.json
install_receipt=$receipts/install.json
desired_render_receipt=$receipts/git-render.json
publication_receipt=$receipts/git-publication.json
application=$desired_parent/application.yaml
convergence_receipt=$receipts/argocd-convergence.json
chain_receipt=$receipts/rebuild-chain.json

install -d -m 0700 "$ACTOR_REBUILD_STATE_DIR/private" "$private"
install -d -m 0755 "$ACTOR_REBUILD_STATE_DIR/desired" "$desired_parent" "$bootstrap_desired" \
	"$ACTOR_REBUILD_STATE_DIR/receipts" "$receipts"

temporary=$(mktemp -d /data/tmp/actor-management-code-plane-phase.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

require_regular() {
	[[ -f $1 && ! -L $1 ]] || { echo "partial rebuild state is not a regular file: $1" >&2; exit 2; }
}

echo 'management_code_plane_phase=checking_management_git'
ACTOR_CLUSTER_KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG \
ACTOR_TERRAFORM_INVENTORY=$ACTOR_TERRAFORM_INVENTORY \
ACTOR_IMAGE_INVENTORY=$management_bootstrap_images \
ACTOR_PULL_CREDENTIAL_RECEIPT=$ACTOR_PULL_CREDENTIAL_RECEIPT \
ACTOR_MANAGEMENT_PLATFORM_RECEIPT=$ACTOR_MANAGEMENT_PLATFORM_RECEIPT \
ACTOR_MANAGEMENT_GIT_RECEIPT=$ACTOR_MANAGEMENT_GIT_RECEIPT \
	"$bootstrap_dir/check-management-git.sh" >"$temporary/management-git-check.json"

if [[ -e $install_receipt ]]; then
	require_regular "$install_receipt"
	require_regular "$render_receipt"
else
	echo 'management_code_plane_phase=installing_bootstrap'
	ACTOR_TERRAFORM_INVENTORY=$ACTOR_TERRAFORM_INVENTORY \
	ACTOR_IMAGE_INVENTORY=$ACTOR_IMAGE_INVENTORY \
	ACTOR_CLUSTER_KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG \
	ACTOR_STORAGE_CREDENTIAL_SOURCE=$ACTOR_STORAGE_CREDENTIAL_SOURCE \
	ACTOR_FLEET_SOURCE_DIR=$fleet_dir \
	ACTOR_CODE_PLANE_PRIVATE_DIR=$private \
	ACTOR_CODE_PLANE_DESIRED_DIR=$bootstrap_desired \
	ACTOR_CODE_PLANE_RENDER_RECEIPT=$render_receipt \
	ACTOR_CODE_PLANE_INSTALL_RECEIPT=$install_receipt \
	ACTOR_CODE_PLANE_RESUME=true \
		"$code_plane_dir/install.sh"
fi

if [[ -e $desired_render_receipt || -e $git_desired ]]; then
	require_regular "$desired_render_receipt"
	[[ -d $git_desired && ! -L $git_desired ]] || { echo "Git desired state is partial" >&2; exit 2; }
	"$python" "$gitops_dir/render-desired-state.py" --source "$bootstrap_desired" \
		--render-receipt "$render_receipt" --install-receipt "$install_receipt" \
		--output-dir "$temporary/git-desired" --receipt "$temporary/git-render.json" >/dev/null
	cmp -s "$desired_render_receipt" "$temporary/git-render.json" || {
		echo "resumed Git render receipt differs from bootstrap evidence" >&2; exit 1;
	}
	diff -qr --no-dereference "$git_desired" "$temporary/git-desired" >/dev/null || {
		echo "resumed Git desired state differs from bootstrap evidence" >&2; exit 1;
	}
else
	echo 'management_code_plane_phase=rendering_git_desired_state'
	"$python" "$gitops_dir/render-desired-state.py" --source "$bootstrap_desired" \
		--render-receipt "$render_receipt" --install-receipt "$install_receipt" \
		--output-dir "$git_desired" --receipt "$desired_render_receipt" >/dev/null
fi

if [[ -e $publication_receipt ]]; then
	require_regular "$publication_receipt"
else
	echo 'management_code_plane_phase=publishing_git_desired_state'
	HUB_KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG \
	ACTOR_MANAGEMENT_GIT_CREDENTIAL=$ACTOR_MANAGEMENT_GIT_CREDENTIAL \
	ACTOR_MANAGEMENT_EXPECTED_REVISION=${ACTOR_MANAGEMENT_EXPECTED_REVISION:-auto} \
		"$gitops_dir/publish.sh" "$git_desired" "$desired_render_receipt" "$publication_receipt"
fi

if [[ -e $application ]]; then
	require_regular "$application"
	"$python" "$gitops_dir/render-application.py" --publication-receipt "$publication_receipt" \
		--desired-render-receipt "$desired_render_receipt" --output "$temporary/application.yaml"
	cmp -s "$application" "$temporary/application.yaml" || {
		echo "resumed Argo Application differs from publication evidence" >&2; exit 1;
	}
else
	echo 'management_code_plane_phase=rendering_argocd_application'
	"$python" "$gitops_dir/render-application.py" --publication-receipt "$publication_receipt" \
		--desired-render-receipt "$desired_render_receipt" --output "$application"
fi

if [[ -e $convergence_receipt ]]; then
	require_regular "$convergence_receipt"
	echo 'management_code_plane_phase=revalidating_argocd_convergence'
	HUB_KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG ACTOR_FLEET_SOURCE_DIR=$fleet_dir \
		"$gitops_dir/install-application.sh" "$application" "$publication_receipt" \
		"$desired_render_receipt" "$install_receipt" "$temporary/convergence.json"
	cmp -s "$convergence_receipt" "$temporary/convergence.json" || {
		echo "live Argo convergence differs from the immutable rebuild evidence" >&2; exit 1;
	}
else
	echo 'management_code_plane_phase=adopting_with_argocd'
	HUB_KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG ACTOR_FLEET_SOURCE_DIR=$fleet_dir \
		"$gitops_dir/install-application.sh" "$application" "$publication_receipt" \
		"$desired_render_receipt" "$install_receipt" "$convergence_receipt"
fi

assemble=(
	"$python" "$script_dir/assemble-management-code-plane.py"
	--inventory "$ACTOR_TERRAFORM_INVENTORY"
	--images "$ACTOR_IMAGE_INVENTORY"
	--management-bootstrap-images "$management_bootstrap_images"
	--management-git-receipt "$ACTOR_MANAGEMENT_GIT_RECEIPT"
	--bootstrap-desired "$bootstrap_desired"
	--render-receipt "$render_receipt"
	--install-receipt "$install_receipt"
	--git-desired "$git_desired"
	--desired-render-receipt "$desired_render_receipt"
	--publication-receipt "$publication_receipt"
	--application "$application"
	--convergence-receipt "$convergence_receipt"
)
if [[ -e $chain_receipt ]]; then
	require_regular "$chain_receipt"
	"${assemble[@]}" --verify-receipt "$chain_receipt"
else
	echo 'management_code_plane_phase=assembling_receipt_chain'
	"${assemble[@]}" --output "$chain_receipt"
fi

printf 'management_code_plane_phase=passed receipt=%s sha256=%s\n' \
	"$chain_receipt" "$(sha256sum "$chain_receipt" | cut -d' ' -f1)"
