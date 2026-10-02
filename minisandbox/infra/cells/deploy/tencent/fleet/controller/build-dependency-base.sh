#!/usr/bin/env bash
set -euo pipefail

export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}
[[ $TMPDIR == /* ]] || { echo "TMPDIR must be absolute" >&2; exit 2; }
if [[ ! -e $TMPDIR ]]; then install -d -m 1777 "$TMPDIR"; fi
[[ -d $TMPDIR && -w $TMPDIR ]] || { echo "TMPDIR is not writable: $TMPDIR" >&2; exit 2; }

source_dir=${ACTOR_SOURCE_DIR:?ACTOR_SOURCE_DIR must name the reviewed source tree}
image_tag=${ACTOR_FLEET_BUILD_BASE_IMAGE_TAG:?ACTOR_FLEET_BUILD_BASE_IMAGE_TAG must be an immutable release tag}
auth_file=${REGISTRY_AUTH_FILE:?REGISTRY_AUTH_FILE must name a protected registry auth file}
bootstrap_base=${ACTOR_FLEET_BOOTSTRAP_BASE:?ACTOR_FLEET_BOOTSTRAP_BASE must pin the regional base-golang bootstrap image}
source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
cells_dir=$source_dir/infra/cells
dockerfile=$cells_dir/Dockerfile.actor-fleet-controller-build-base

[[ $image_tag != *@* && $image_tag == *:* ]] || {
	echo "ACTOR_FLEET_BUILD_BASE_IMAGE_TAG must be a tagged image, not a digest" >&2
	exit 2
}
[[ $bootstrap_base =~ /actor-fleet/base-golang@sha256:[0-9a-f]{64}$ ]] || {
	echo "ACTOR_FLEET_BOOTSTRAP_BASE must pin base-golang by registry digest" >&2
	exit 2
}
for command in buildah python3 sha256sum; do
	command -v "$command" >/dev/null 2>&1 || { echo "required command not found: $command" >&2; exit 1; }
done
[[ -f $dockerfile && -f $cells_dir/go.mod && -f $cells_dir/go.sum ]] || {
	echo "controller dependency-base inputs are incomplete" >&2
	exit 1
}
[[ -f $auth_file ]] || { echo "registry auth file is missing" >&2; exit 1; }

if [[ -s $source_dir/.actor-source/RELEASE_SHA256SUMS ]]; then
	(cd "$source_dir" && sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null)
fi
go_mod_sha=$(sha256sum "$cells_dir/go.mod" | cut -d' ' -f1)
go_sum_sha=$(sha256sum "$cells_dir/go.sum" | cut -d' ' -f1)

buildah bud \
	--authfile "$auth_file" \
	--build-arg "ACTOR_FLEET_BOOTSTRAP_IMAGE=$bootstrap_base" \
	--build-arg "GO_MOD_SHA256=$go_mod_sha" \
	--build-arg "GO_SUM_SHA256=$go_sum_sha" \
	-t "$image_tag" -f "$dockerfile" "$cells_dir"

buildah inspect "$image_tag" | python3 -c '
import json,sys
labels=json.load(sys.stdin).get("Docker",{}).get("config",{}).get("Labels",{})
expected={
    "fleet.actor.dev/go-mod-sha256":sys.argv[1],
    "fleet.actor.dev/go-sum-sha256":sys.argv[2],
    "fleet.actor.dev/bootstrap-base":sys.argv[3],
}
for key,value in expected.items():
    if labels.get(key) != value:
        raise SystemExit(f"dependency-base label mismatch: {key}")
' "$go_mod_sha" "$go_sum_sha" "$bootstrap_base"

digest_file=$(mktemp)
cleanup() { rm -f -- "$digest_file"; }
trap cleanup EXIT INT TERM
buildah push --authfile "$auth_file" --digestfile "$digest_file" \
	"$image_tag" "docker://$image_tag"
digest=$(tr -d '[:space:]' <"$digest_file")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "registry returned an invalid digest" >&2; exit 1; }
printf '%s@%s\n' "${image_tag%:*}" "$digest"
printf 'go_mod_sha256=%s go_sum_sha256=%s\n' "$go_mod_sha" "$go_sum_sha"
