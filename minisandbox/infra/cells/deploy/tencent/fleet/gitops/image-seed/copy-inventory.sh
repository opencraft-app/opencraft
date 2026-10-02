#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_inventory=${SOURCE_IMAGE_INVENTORY:?SOURCE_IMAGE_INVENTORY is required}
destination_registry=${DESTINATION_REGISTRY:?DESTINATION_REGISTRY is required}
auth_file=${REGISTRY_AUTH_FILE:?REGISTRY_AUTH_FILE is required}
destination_inventory=${DESTINATION_IMAGE_INVENTORY:?DESTINATION_IMAGE_INVENTORY is required}
copy_receipt=${IMAGE_COPY_RECEIPT:?IMAGE_COPY_RECEIPT is required}
python=${PYTHON:-python3}
buildah=${BUILDAH:-buildah}
storage_root=${IMAGE_COPY_STORAGE_ROOT:-/data/actor-image-copy}
source_oci_layout=${SOURCE_OCI_LAYOUT:-}

[[ $source_inventory == /* && -f $source_inventory && ! -L $source_inventory ]]
[[ $auth_file == /* && -f $auth_file && ! -L $auth_file && $(stat -c '%a' "$auth_file") == 600 ]]
[[ $destination_registry =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.tencentcloudcr\.com$ ]]
for output in "$destination_inventory" "$copy_receipt"; do
	[[ $output == /* && ! -e $output && -d $(dirname -- "$output") ]] || {
		echo "image copy output must be a new absolute path with an existing parent: $output" >&2
		exit 2
	}
done
[[ $storage_root == /* && $storage_root != / ]]
for command in "$python" "$buildah" jq sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
if [[ -n $source_oci_layout ]]; then
	[[ $source_oci_layout == /* && -d $source_oci_layout && ! -L $source_oci_layout ]] || {
		echo "SOURCE_OCI_LAYOUT must be an absolute non-symlink directory" >&2
		exit 2
	}
	command -v skopeo >/dev/null || { echo "missing command: skopeo" >&2; exit 1; }
fi
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 7) else 1)' || {
	echo "image copy requires Python 3.7 or newer" >&2
	exit 1
}
"$python" "$script_dir/image-lock.py" validate-inventory --lock "$source_inventory" >/dev/null

source_registry=$(jq -er '.registry' "$source_inventory")
[[ $source_registry != "$destination_registry" ]] || {
	echo "source and destination registries must differ" >&2
	exit 2
}
jq -e --arg source "$source_registry" --arg destination "$destination_registry" --argjson need_source "$([[ -z $source_oci_layout ]] && echo true || echo false)" \
	'((.auths[$destination].auth | strings | length) > 0) and (($need_source | not) or ((.auths[$source].auth | strings | length) > 0))' \
	"$auth_file" >/dev/null || {
	echo "registry auth file must cover the exact source and destination hosts" >&2
	exit 2
}

temporary=$(mktemp -d "${storage_root}.run.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"
storage=("$buildah" --root "$temporary/storage" --runroot "$temporary/runroot" --storage-driver overlay)
jq -r '.images[] | [.repository,.ref] | @tsv' "$source_inventory" >"$temporary/images.tsv"
: >"$temporary/images.ndjson"

# containers/image releases before 1.15 reject Docker-v2 manifests stored in
# an OCI layout even though the exact same bytes are valid in its dir
# transport. Materialize a zero-conversion dir view so bootstrap nodes can
# preserve old immutable digests without requiring a newer host package.
materialize_oci_dir() {
	local repository=$1 descriptor manifest source blob destination target blob_list
	destination="$temporary/dir-$repository"
	mkdir -m 0700 "$destination"
	descriptor=$(jq -er --arg repository "$repository" \
		'.manifests[] | select(.annotations["org.opencontainers.image.ref.name"] == $repository) | .digest' \
		"$source_oci_layout/index.json")
	[[ $descriptor =~ ^sha256:[0-9a-f]{64}$ ]]
	manifest="$source_oci_layout/blobs/sha256/${descriptor#sha256:}"
	[[ -f $manifest && ! -L $manifest ]]
	ln "$manifest" "$destination/manifest.json" 2>/dev/null || cp "$manifest" "$destination/manifest.json"
	printf 'Directory Transport Version: 1.1\n' >"$destination/version"
	blob_list="$destination/.blobs"
	jq -er '[.config.digest] + [.layers[].digest] | unique[]' "$manifest" >"$blob_list"
	while IFS= read -r blob; do
		[[ $blob =~ ^sha256:[0-9a-f]{64}$ ]]
		source="$source_oci_layout/blobs/sha256/${blob#sha256:}"
		[[ -f $source && ! -L $source ]]
		target="$destination/${blob#sha256:}"
		ln "$source" "$target" 2>/dev/null || cp "$source" "$target"
	done <"$blob_list"
	rm -f -- "$blob_list"
	printf '%s\n' "$destination"
}

while IFS=$'\t' read -r repository source_ref; do
	digest=${source_ref##*@}
	[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]
	destination_tag="$destination_registry/actor-fleet/$repository:copy-${digest#sha256:}"
	if [[ -n $source_oci_layout ]]; then
		dir_source=$(materialize_oci_dir "$repository")
		skopeo copy --preserve-digests --dest-authfile "$auth_file" \
			"dir:$dir_source" "docker://$destination_tag" >/dev/null
		destination_digest=sha256:$(skopeo inspect --raw --authfile "$auth_file" \
			"docker://$destination_tag" | sha256sum | cut -d' ' -f1)
		rm -rf -- "$dir_source"
	else
		digest_file="$temporary/$repository.digest"
		image_id=$("${storage[@]}" pull --quiet --authfile "$auth_file" "docker://$source_ref")
		[[ -n $image_id ]]
		"${storage[@]}" tag "$image_id" "$destination_tag"
		"${storage[@]}" push --quiet --authfile "$auth_file" --digestfile "$digest_file" \
			"$destination_tag" "docker://$destination_tag"
		destination_digest=$(tr -d '[:space:]' <"$digest_file")
	fi
	[[ $destination_digest == "$digest" ]] || {
		echo "registry copy changed immutable manifest digest for $repository" >&2
		exit 1
	}

	# A separate empty VFS graph proves the destination can serve every image;
	# shared copy-layer cache is not accepted as cold-pull evidence.
	verification_root="$temporary/verify-$repository"
	verification=("$buildah" --root "$verification_root/storage" --runroot "$verification_root/runroot" --storage-driver vfs)
	verified_id=$("${verification[@]}" pull --quiet --authfile "$auth_file" \
		"docker://$destination_registry/actor-fleet/$repository@$destination_digest")
	[[ -n $verified_id ]]
	rm -rf -- "$verification_root"
	jq -cn --arg repository "$repository" --arg source "$source_ref" \
		--arg destination "$destination_registry/actor-fleet/$repository@$destination_digest" \
		--arg digest "$destination_digest" \
		'{repository:$repository,source:$source,destination:$destination,digest:$digest,coldPullVerified:true}' \
		>>"$temporary/images.ndjson"
	printf 'image_copied repository=%s digest=%s\n' "$repository" "$destination_digest"
done <"$temporary/images.tsv"

"$python" - "$script_dir" "$source_inventory" "$destination_registry" \
	"$temporary/images.ndjson" "$temporary/inventory.json" "$temporary/receipt.json" <<'PY'
import importlib.util,json,sys
from pathlib import Path

root,source_path,destination,records_path,inventory_path,receipt_path=sys.argv[1:]
spec=importlib.util.spec_from_file_location("copy_image_contract",Path(root)/"image_contract.py")
contract=importlib.util.module_from_spec(spec); spec.loader.exec_module(contract)
source=contract.validate_inventory(contract.load(Path(source_path)))
with open(records_path) as stream:
    records=[json.loads(line) for line in stream if line.strip()]
if len(records) != 28 or any(item["digest"] != item["source"].rsplit("@",1)[1] for item in records):
    raise ValueError("copy receipt does not preserve all 28 source manifests")
result=dict(source)
result["registry"]=destination
for item in result["images"]:
    item["ref"]=f'{destination}/actor-fleet/{item["repository"]}@{item["ref"].rsplit("@",1)[1]}'
result.pop("inventoryDigest",None)
result["inventoryDigest"]=contract.digest(result)
contract.validate_inventory(result)
with open(inventory_path,"w") as stream:
    json.dump(result,stream,indent=2,sort_keys=True); stream.write("\n")
receipt={
    "schemaVersion":1,"result":"passed","sourceRegistry":source["registry"],
    "destinationRegistry":destination,"sourceInventoryDigest":source["inventoryDigest"],
    "destinationInventoryDigest":result["inventoryDigest"],"manifestIdentityPreserved":True,
    "images":sorted(records,key=lambda item:item["repository"]),
}
with open(receipt_path,"w") as stream:
    json.dump(receipt,stream,indent=2,sort_keys=True); stream.write("\n")
PY

install -m 0644 "$temporary/inventory.json" "$destination_inventory"
install -m 0644 "$temporary/receipt.json" "$copy_receipt"
printf 'image_copy=passed images=28 inventory_digest=%s receipt=%s\n' \
	"$(jq -r .inventoryDigest "$destination_inventory")" "$copy_receipt"
