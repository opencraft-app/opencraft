#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock=${ACTOR_FOUNDATION_IMAGE_LOCK:-$script_dir/foundation-images.lock.json}
source_dir=${ACTOR_SOURCE_DIR:?ACTOR_SOURCE_DIR must name the reviewed source tree}
registry=${ACTOR_PRODUCT_REGISTRY:?ACTOR_PRODUCT_REGISTRY must name the regional TCR host}
run_id=${ACTOR_PRODUCT_BUILD_RUN_ID:?ACTOR_PRODUCT_BUILD_RUN_ID is required}
receipt_dir=${ACTOR_PRODUCT_RECEIPT_DIR:?ACTOR_PRODUCT_RECEIPT_DIR is required}
auth_file=${REGISTRY_AUTH_FILE:?REGISTRY_AUTH_FILE must name protected TCR credentials}
export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}

[[ $registry =~ ^[a-z0-9][a-z0-9.-]*\.tencentcloudcr\.com$ ]] || { echo "product registry must be a Tencent TCR host" >&2; exit 2; }
[[ $run_id =~ ^[0-9a-f]{32}$ ]] || { echo "product build run ID must be 32 lowercase hex characters" >&2; exit 2; }
[[ $receipt_dir == /* && $TMPDIR == /* && -f $auth_file && -f $lock ]] || { echo "foundation build paths are incomplete" >&2; exit 2; }
[[ -d $TMPDIR ]] || install -d -m 1777 "$TMPDIR"
install -d -m 0755 "$receipt_dir"
source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
source_revision=${ACTOR_SOURCE_REVISION:-}
source_manifest=${ACTOR_SOURCE_MANIFEST_FILE:-}
[[ -n $source_revision || ! -s $source_dir/.actor-source/SOURCE_REVISION ]] || source_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
[[ -n $source_manifest || ! -s $source_dir/.actor-source/RELEASE_SHA256SUMS ]] || source_manifest="$source_dir/.actor-source/RELEASE_SHA256SUMS"
[[ $source_revision =~ ^[0-9a-f]{40}$ && -s $source_manifest ]] || { echo "reviewed source identity is incomplete" >&2; exit 2; }
for command in buildah jq python3 sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

cd "$source_dir"
sha256sum --check "$source_manifest" >/dev/null
manifest_sha=$(sha256sum "$source_manifest" | cut -d' ' -f1)
plan_args=()
if [[ ${ACTOR_FOUNDATION_REPOSITORIES+x} ]]; then
	plan_args=(--repositories "$ACTOR_FOUNDATION_REPOSITORIES")
fi
plan=$(python3 "$script_dir/foundation-plan.py" --lock "$lock" "${plan_args[@]}")
mapfile -t repositories <<<"$plan"
[[ ${#repositories[@]} -ge 1 && ${#repositories[@]} -le 5 ]] || { echo "foundation plan did not resolve a bounded repository set" >&2; exit 1; }

for repository in "${repositories[@]}"; do
	receipt="$receipt_dir/product-${repository}-${run_id}.json"
	if [[ -e $receipt ]]; then
		python3 "$script_dir/product-lock.py" validate --receipt "$receipt" >/dev/null
		jq -e --arg repository "$repository" --arg revision "$source_revision" --arg manifest "sha256:$manifest_sha" \
			--arg prefix "$registry/actor-fleet/$repository@sha256:" \
			'.repository == $repository and .sourceRevision == $revision and .sourceManifestDigest == $manifest and (.ref | startswith($prefix))' \
			"$receipt" >/dev/null || { echo "existing foundation receipt belongs to another build: $receipt" >&2; exit 1; }
		continue
	fi
	source_image=$(python3 "$script_dir/foundation-plan.py" --lock "$lock" --repository "$repository" --field source)
	dockerfile=$(python3 "$script_dir/foundation-plan.py" --lock "$lock" --repository "$repository" --field dockerfile)
	build_arg=$(python3 "$script_dir/foundation-plan.py" --lock "$lock" --repository "$repository" --field buildArg)
	[[ -f $source_dir/$dockerfile ]] || { echo "foundation Dockerfile is missing: $dockerfile" >&2; exit 1; }
	image_tag="$registry/actor-fleet/$repository:$run_id"
	module_labels=()
	if [[ $repository == base-golang ]]; then
		# Product builders compare these labels with their reviewed module graph.
		# Hash only after the complete source manifest has been verified above.
		go_mod_sha=$(sha256sum "$source_dir/infra/cells/go.mod" | cut -d' ' -f1)
		go_sum_sha=$(sha256sum "$source_dir/infra/cells/go.sum" | cut -d' ' -f1)
		module_labels=(
			--label "fleet.actor.dev/go-mod-sha256=$go_mod_sha"
			--label "fleet.actor.dev/go-sum-sha256=$go_sum_sha"
		)
	fi
	buildah bud --authfile "$auth_file" --platform linux/amd64 \
		--build-arg "$build_arg=$source_image" \
		"${module_labels[@]}" \
		--label "org.opencontainers.image.revision=$source_revision" \
		--label "fleet.actor.dev/source-manifest-sha256=$manifest_sha" \
		--label "fleet.actor.dev/upstream-source=$source_image" \
		-t "$image_tag" -f "$dockerfile" .
	digest_file=$(mktemp "$TMPDIR/${repository}-digest.XXXXXX")
	if ! buildah push --authfile "$auth_file" --digestfile "$digest_file" "$image_tag" "docker://$image_tag"; then
		rm -f -- "$digest_file"
		exit 1
	fi
	destination_digest=$(tr -d '[:space:]' <"$digest_file")
	rm -f -- "$digest_file"
	[[ $destination_digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "registry returned an invalid digest for $repository" >&2; exit 1; }
	registry_ref="${image_tag%:*}@$destination_digest"
	python3 "$script_dir/record-product-image.py" \
		--repository "$repository" \
		--ref "$registry_ref" \
		--source-revision "$source_revision" \
		--source-manifest-digest "sha256:$manifest_sha" \
		--registry-auth-file "$auth_file" \
		--output "$receipt"
done

printf 'foundation_build=passed run_id=%s receipts=%s\n' "$run_id" "$receipt_dir"
