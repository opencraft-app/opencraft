#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_inventory=${SOURCE_IMAGE_INVENTORY:?SOURCE_IMAGE_INVENTORY is required}
auth_file=${REGISTRY_AUTH_FILE:?REGISTRY_AUTH_FILE is required}
oci_layout=${OCI_IMAGE_LAYOUT:?OCI_IMAGE_LAYOUT is required}
export_receipt=${OCI_EXPORT_RECEIPT:?OCI_EXPORT_RECEIPT is required}
python=${PYTHON:-python3}
skopeo=${SKOPEO:-skopeo}

[[ $source_inventory == /* && -f $source_inventory && ! -L $source_inventory ]]
[[ $auth_file == /* && -f $auth_file && ! -L $auth_file && $(stat -c '%a' "$auth_file") == 600 ]]
[[ $oci_layout == /* && ! -e $oci_layout && -d $(dirname -- "$oci_layout") ]]
[[ $export_receipt == /* && ! -e $export_receipt && -d $(dirname -- "$export_receipt") ]]
for command in "$python" "$skopeo" cmp jq sha256sum stat; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
"$python" "$script_dir/image-lock.py" validate-inventory --lock "$source_inventory" >/dev/null
source_registry=$(jq -er '.registry' "$source_inventory")
jq -e --arg source "$source_registry" \
	'((.auths[$source].auth | strings | length) > 0)' "$auth_file" >/dev/null || {
	echo "registry auth file does not cover the exact source host" >&2
	exit 2
}

temporary=$(mktemp -d "$(dirname -- "$oci_layout")/.actor-oci-export.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"
: >"$temporary/images.ndjson"
mkdir -m 0700 -p "$temporary/layout/blobs/sha256"
printf '{"imageLayoutVersion":"1.0.0"}\n' >"$temporary/layout/oci-layout"
: >"$temporary/descriptors.ndjson"

publish_blob() {
	local source=$1 digest=$2 target
	[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]
	target="$temporary/layout/blobs/sha256/${digest#sha256:}"
	if [[ -e $target ]]; then
		cmp -s "$source" "$target" || {
			echo "different bytes claim the same OCI digest: $digest" >&2
			exit 1
		}
		return
	fi
	ln "$source" "$target" 2>/dev/null || cp "$source" "$target"
}

while IFS=$'\t' read -r repository source_ref; do
	digest=${source_ref##*@}
	[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]
	# TencentOS currently packages a containers/image release whose OCI
	# transport rejects Docker-v2 manifests. The dir transport retains the raw
	# manifest and blobs without conversion, so assemble the shared OCI-shaped
	# content store ourselves. copy-inventory.sh deliberately reads this index
	# directly and exposes each entry through a temporary dir transport; it does
	# not ask the old OCI transport to parse these descriptors.
	dir_export="$temporary/dir-$repository"
	mkdir -m 0700 "$dir_export"
	"$skopeo" copy --preserve-digests --src-authfile "$auth_file" \
		"docker://$source_ref" "dir:$dir_export" >/dev/null
	actual=sha256:$(sha256sum "$dir_export/manifest.json" | cut -d' ' -f1)
	[[ $actual == "$digest" ]] || {
		echo "OCI export changed immutable manifest digest for $repository" >&2
		exit 1
	}
	publish_blob "$dir_export/manifest.json" "$digest"
	while IFS= read -r blob; do
		[[ $blob =~ ^sha256:[0-9a-f]{64}$ ]]
		publish_blob "$dir_export/${blob#sha256:}" "$blob"
	done < <(jq -er '[.config.digest] + [.layers[].digest] | unique[]' "$dir_export/manifest.json")
	media_type=$(jq -er '.mediaType | select(type == "string" and length > 0)' "$dir_export/manifest.json")
	manifest_bytes=$(stat -c '%s' "$dir_export/manifest.json")
	jq -cn --arg digest "$digest" --arg mediaType "$media_type" \
		--arg repository "$repository" --argjson size "$manifest_bytes" \
		'{mediaType:$mediaType,digest:$digest,size:$size,annotations:{"org.opencontainers.image.ref.name":$repository}}' \
		>>"$temporary/descriptors.ndjson"
	rm -rf -- "$dir_export"
	jq -cn --arg repository "$repository" --arg source "$source_ref" --arg digest "$digest" \
		'{repository:$repository,source:$source,digest:$digest}' >>"$temporary/images.ndjson"
	printf 'image_exported repository=%s digest=%s\n' "$repository" "$digest"
done < <(jq -r '.images[] | [.repository,.ref] | @tsv' "$source_inventory")

jq -s '{schemaVersion:2,manifests:.}' "$temporary/descriptors.ndjson" >"$temporary/layout/index.json"

"$python" - "$source_inventory" "$temporary/images.ndjson" "$temporary/receipt.json" <<'PY'
import json,sys
source_path,records_path,output=sys.argv[1:]
source=json.load(open(source_path))
with open(records_path) as stream:
    records=sorted((json.loads(line) for line in stream if line.strip()),key=lambda item:item["repository"])
if len(records) != 28:
    raise ValueError("OCI export does not cover all 28 images")
receipt={"schemaVersion":1,"result":"passed","sourceRegistry":source["registry"],
         "sourceInventoryDigest":source["inventoryDigest"],"manifestIdentityPreserved":True,
         "images":records}
with open(output,"w") as stream:
    json.dump(receipt,stream,indent=2,sort_keys=True); stream.write("\n")
PY
mv "$temporary/layout" "$oci_layout"
install -m 0644 "$temporary/receipt.json" "$export_receipt"
printf 'oci_export=passed images=28 inventory_digest=%s layout=%s\n' \
	"$(jq -r .sourceInventoryDigest "$export_receipt")" "$oci_layout"
