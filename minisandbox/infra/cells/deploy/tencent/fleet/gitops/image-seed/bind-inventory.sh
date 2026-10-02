#!/usr/bin/env bash
# Source this file from production installers. It turns the complete image
# inventory into the only image/provenance authority while still permitting a
# caller to repeat an identical value for readability.

actor_image_inventory_require() {
	: "${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY must name the complete 28-image inventory}"
	[[ $ACTOR_IMAGE_INVENTORY == /* && -f $ACTOR_IMAGE_INVENTORY ]] || {
		echo "ACTOR_IMAGE_INVENTORY must be an absolute regular-file path" >&2
		return 2
	}
	: "${ACTOR_IMAGE_LOCK_TOOL:?ACTOR_IMAGE_LOCK_TOOL must name image-lock.py}"
	[[ -x $ACTOR_IMAGE_LOCK_TOOL ]] || {
		echo "image inventory resolver is not executable: $ACTOR_IMAGE_LOCK_TOOL" >&2
		return 2
	}
	python3 "$ACTOR_IMAGE_LOCK_TOOL" validate-inventory --lock "$ACTOR_IMAGE_INVENTORY" >/dev/null
	export ACTOR_IMAGE_INVENTORY
}

actor_image_inventory_value() {
	local repository=$1 field=${2:-ref}
	python3 "$ACTOR_IMAGE_LOCK_TOOL" resolve \
		--lock "$ACTOR_IMAGE_INVENTORY" --repository "$repository" --field "$field"
}

actor_image_inventory_bind() {
	local variable=$1 repository=$2 resolved current
	resolved=$(actor_image_inventory_value "$repository")
	current=${!variable-}
	if [[ -n $current && $current != "$resolved" ]]; then
		echo "$variable differs from complete image inventory repository $repository" >&2
		return 2
	fi
	printf -v "$variable" '%s' "$resolved"
	export "$variable"
}

actor_image_inventory_bind_build_identity() {
	local revision_variable=$1 manifest_variable=$2 repository=$3
	local revision manifest current
	revision=$(actor_image_inventory_value "$repository" source-revision)
	manifest=$(actor_image_inventory_value "$repository" source-manifest-digest)
	manifest=${manifest#sha256:}
	current=${!revision_variable-}
	if [[ -n $current && $current != "$revision" ]]; then
		echo "$revision_variable differs from complete image inventory repository $repository" >&2
		return 2
	fi
	current=${!manifest_variable-}
	if [[ -n $current && $current != "$manifest" ]]; then
		echo "$manifest_variable differs from complete image inventory repository $repository" >&2
		return 2
	fi
	printf -v "$revision_variable" '%s' "$revision"
	printf -v "$manifest_variable" '%s' "$manifest"
	export "$revision_variable" "$manifest_variable"
}

# A semantic-failure qualification deliberately releases one non-production
# Runtime while the complete inventory must continue to name the last
# qualified Runtime used for rollback. Permit that single mismatch only when
# a non-symlink receipt binds the qualified base, the exact candidate image,
# and both source identities. Ordinary production installs and rollbacks keep
# using the strict inventory-only path.
actor_image_inventory_bind_runtime_release() {
	local image_variable=$1 revision_variable=$2 manifest_variable=$3 repository=$4
	local receipt=${AUTONOMY_CONTROL_QUALIFICATION_CANDIDATE_RECEIPT:-}
	local receipt_root=${AUTONOMY_CONTROL_QUALIFICATION_RECEIPT_ROOT:-/data/actor-qualification/receipts}
	local qualified_image qualified_revision qualified_manifest
	local candidate_image candidate_revision candidate_manifest
	if [[ -z $receipt ]]; then
		actor_image_inventory_bind "$image_variable" "$repository"
		actor_image_inventory_bind_build_identity \
			"$revision_variable" "$manifest_variable" "$repository"
		return
	fi

	if [[ $receipt_root != /data/actor-qualification/receipts ]]; then
		[[ ${AUTONOMY_CONTROL_TEST_MODE:-0} == 1 && $receipt_root == /data/tmp/* && -d $receipt_root ]] || {
			echo "alternate semantic candidate receipt root is test-only under /data/tmp" >&2
			return 2
		}
	fi
	[[ $receipt == "$receipt_root"/actor-bj-q01-semantic-failure-candidate-*.json \
		&& -f $receipt && ! -L $receipt ]] || {
		echo "semantic candidate inventory override requires an exact regular receipt" >&2
		return 2
	}
	command -v jq >/dev/null || {
		echo "jq is required to validate the semantic candidate receipt" >&2
		return 2
	}
	qualified_image=$(actor_image_inventory_value "$repository")
	qualified_revision=$(actor_image_inventory_value "$repository" source-revision)
	qualified_manifest=$(actor_image_inventory_value "$repository" source-manifest-digest)
	qualified_manifest=${qualified_manifest#sha256:}
	candidate_image=${!image_variable-}
	candidate_revision=${!revision_variable-}
	candidate_manifest=${!manifest_variable-}
	[[ -n $candidate_image && -n $candidate_revision && -n $candidate_manifest ]] || {
		echo "semantic candidate image and source identity must be explicit" >&2
		return 2
	}
	[[ $candidate_image != "$qualified_image" \
		&& $candidate_revision == "$qualified_revision" \
		&& $candidate_manifest != "$qualified_manifest" ]] || {
		echo "semantic candidate is not a distinct patch of the qualified Runtime" >&2
		return 2
	}
	[[ ${candidate_image%@sha256:*} == "${qualified_image%@sha256:*}" ]] || {
		echo "semantic candidate repository differs from the qualified Runtime" >&2
		return 2
	}
	jq -e \
		--arg qualified_image "$qualified_image" \
		--arg qualified_revision "$qualified_revision" \
		--arg qualified_manifest "$qualified_manifest" \
		--arg candidate_image "$candidate_image" \
		--arg candidate_revision "$candidate_revision" \
		--arg candidate_manifest "$candidate_manifest" '
      .schema == "actor-bj-q01-semantic-failure-candidate/v1" and
      .verdict == "passed" and .intentionallyNotProduction == true and
      .baseRuntimeImage == $qualified_image and
      .sourceRevision == $qualified_revision and
      .sourceRevision == $candidate_revision and
      .baseSourceManifestSHA256 == $qualified_manifest and
      .candidateRuntimeImage == $candidate_image and
      .candidateSourceManifestSHA256 == $candidate_manifest and
      (.faultPatchSHA256 | type == "string" and test("^[0-9a-f]{64}$"))
    ' "$receipt" >/dev/null || {
		echo "semantic candidate receipt does not bind the qualified inventory and exact candidate" >&2
		return 2
	}
	export "$image_variable" "$revision_variable" "$manifest_variable"
}
