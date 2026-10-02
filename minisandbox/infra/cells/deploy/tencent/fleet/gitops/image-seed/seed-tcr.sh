#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock=${IMAGE_SOURCE_LOCK:-$script_dir/upstream-images.lock.json}
registry=${IMAGE_SEED_REGISTRY:?IMAGE_SEED_REGISTRY must be the destination TCR hostname}
namespace=${IMAGE_SEED_NAMESPACE:-actor-fleet}
platform=${IMAGE_SEED_PLATFORM:-linux/amd64}
auth_file=${REGISTRY_AUTH_FILE:?REGISTRY_AUTH_FILE must name the protected TCR auth file}
receipt=${IMAGE_SEED_RECEIPT:?IMAGE_SEED_RECEIPT must be a new absolute receipt path}
buildah=${BUILDAH:-buildah}
python=${PYTHON:-python3}
registries_conf=${IMAGE_SEED_REGISTRIES_CONF:-}

[[ $registry =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.tencentcloudcr\.com$ ]]
[[ $namespace == actor-fleet && $platform == linux/amd64 ]]
[[ -s $lock && -f $auth_file && $(stat -c '%a' "$auth_file") == 600 ]]
if [[ -n $registries_conf ]]; then
	[[ $registries_conf == /* && -f $registries_conf && ! -L $registries_conf ]] || {
		echo "IMAGE_SEED_REGISTRIES_CONF must name an absolute regular file" >&2
		exit 2
	}
	export REGISTRIES_CONFIG_PATH=$registries_conf
fi
[[ $receipt == /* && ! -e $receipt ]] || { echo "IMAGE_SEED_RECEIPT must be a new absolute path" >&2; exit 2; }
for command in jq "$python" sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
command -v "$buildah" >/dev/null || { echo "missing buildah: $buildah" >&2; exit 1; }
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 7) else 1)' || {
	echo "image seed requires Python 3.7 or newer" >&2
	exit 1
}

summary=$("$python" "$script_dir/image-lock.py" validate-upstream --lock "$lock")
[[ $(jq -r '.platform' <<<"$summary") == "$platform" ]]
lock_digest=$(jq -r '.lockDigest' <<<"$summary")

temporary=$(mktemp -d /data/tmp/actor-image-seed.XXXXXX)
receipt_stage=
cleanup() {
	[[ -z ${receipt_stage:-} ]] || rm -f -- "$receipt_stage"
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"
storage=("$buildah" --root "$temporary/storage" --runroot "$temporary/runroot" --storage-driver vfs)

"$python" "$script_dir/image-lock.py" validate-upstream --lock "$lock" --emit-tsv >"$temporary/images.tsv"
: >"$temporary/images.ndjson"
while IFS=$'\t' read -r component repository source; do
	requested_digest=${source##*@}
	# Buildah 1.33, which is the supported TencentOS builder package, rejects
	# Docker's otherwise valid tag@digest spelling.  Keep the reviewed source
	# in the receipt, but pull the identical immutable manifest as repo@digest.
	source_with_tag=${source%@*}
	[[ $source_with_tag == */*:* ]] || {
		echo "upstream source must carry the reviewed tag and digest" >&2
		exit 1
	}
	source_pull="${source_with_tag%:*}@$requested_digest"
	tag="seed-${requested_digest#sha256:}"
	destination_tag="$registry/$namespace/$repository:$tag"
	digest_file="$temporary/$repository.digest"
	image_id=$("${storage[@]}" pull --quiet --platform "$platform" "docker://$source_pull")
	[[ -n $image_id ]]
	"${storage[@]}" tag "$image_id" "$destination_tag"
	"${storage[@]}" push --quiet --authfile "$auth_file" --digestfile "$digest_file" \
		"$destination_tag" "docker://$destination_tag"
	destination_digest=$(tr -d '[:space:]' <"$digest_file")
	[[ $destination_digest =~ ^sha256:[0-9a-f]{64}$ ]]
	# Pull the pushed manifest back through a fresh storage graph. Reusing
	# `storage` here would only prove that Buildah can find its local source
	# layers, not that an empty runtime node can retrieve the TCR object. Give
	# every repository its own graph so cross-image shared layers cannot turn
	# this qualification into a warm-cache test either.
	verification_directory=$temporary/verify-$repository
	verification_storage=("$buildah" --root "$verification_directory/storage" \
		--runroot "$verification_directory/runroot" --storage-driver vfs)
	verified_image_id=$("${verification_storage[@]}" pull --quiet --authfile "$auth_file" \
		"docker://$registry/$namespace/$repository@$destination_digest")
	[[ -n $verified_image_id ]]
	rm -rf -- "$verification_directory"
	jq -cn --arg repository "$repository" --arg source "$source" \
		--arg destination "$registry/$namespace/$repository@$destination_digest" \
		--arg digest "$destination_digest" \
		'{repository:$repository,source:$source,destination:$destination,destinationDigest:$digest}' \
		>>"$temporary/images.ndjson"
	printf 'image_seeded component=%s repository=%s destination_digest=%s\n' \
		"$component" "$repository" "$destination_digest"
done <"$temporary/images.tsv"

"$python" - "$registry" "$namespace" "$platform" "$lock_digest" \
	"$temporary/images.ndjson" "$temporary/receipt.json" <<'PY'
import json,sys
registry,namespace,platform,lock_digest,items_path,output=sys.argv[1:]
with open(items_path) as stream:
    images=[json.loads(line) for line in stream if line.strip()]
receipt={
    "schemaVersion":1,
    "result":"passed",
    "registry":registry,
    "namespace":namespace,
    "platform":platform,
    "sourceLockDigest":lock_digest,
    "images":sorted(images,key=lambda item:item["repository"]),
}
with open(output,"w") as stream:
    json.dump(receipt,stream,indent=2,sort_keys=True)
    stream.write("\n")
PY
"$python" - "$script_dir" "$lock" "$temporary/receipt.json" <<'PY'
import importlib.util,json,sys
from pathlib import Path
root=Path(sys.argv[1])
spec=importlib.util.spec_from_file_location("image_contract_seed",root/"image_contract.py")
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
upstream=module.validate_upstream(module.load(Path(sys.argv[2])))
module.validate_seed(module.load(Path(sys.argv[3])),upstream)
PY
mkdir -p "$(dirname -- "$receipt")"
receipt_stage=$(mktemp "$(dirname -- "$receipt")/.image-seed-receipt.XXXXXX")
install -m 0644 "$temporary/receipt.json" "$receipt_stage"
ln "$receipt_stage" "$receipt"
rm -f -- "$receipt_stage"
receipt_stage=
printf 'image_seed=passed images=%s lock_digest=%s receipt=%s\n' \
	"$(jq '.images | length' "$receipt")" "$lock_digest" "$receipt"
