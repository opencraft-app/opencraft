#!/usr/bin/env bash
set -euo pipefail

: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_TCR_BOOTSTRAP_AUTH:?set ACTOR_TCR_BOOTSTRAP_AUTH to a short-lived Docker auth file}"
: "${ACTOR_TCCLI_TOOL_RECEIPT:?set ACTOR_TCCLI_TOOL_RECEIPT}"

root=${ACTOR_TCCLI_TOOL_ROOT:-/var/lib/actor-bootstrap/tccli-tool}
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" "$ACTOR_TCR_BOOTSTRAP_AUTH"; do
	[[ $path == /* && -f $path && ! -L $path ]] || { echo "tccli bootstrap input must be an absolute regular file: $path" >&2; exit 2; }
done
[[ $root == /* && $root != / && $ACTOR_TCCLI_TOOL_RECEIPT == /* ]] || {
	echo "tccli tool output paths must be absolute and non-root" >&2
	exit 2
}
(( (8#$(stat -c '%a' "$ACTOR_TCR_BOOTSTRAP_AUTH") & 8#077) == 0 )) || {
	echo "short-lived TCR bootstrap auth must not be group/world accessible" >&2
	exit 2
}
for command in buildah getent jq sha256sum stat; do
	command -v "$command" >/dev/null || { echo "missing tccli bootstrap tool: $command" >&2; exit 2; }
done

image=$(jq -er '[.images[] | select(.repository == "base-tencentcloud-cli") | .ref] |
  select(length == 1) | .[0] | select(test("/actor-fleet/base-tencentcloud-cli@sha256:[0-9a-f]{64}$"))' \
	"$ACTOR_IMAGE_INVENTORY")
inventory_digest=$(jq -er '.inventoryDigest | select(test("^sha256:[0-9a-f]{64}$"))' "$ACTOR_IMAGE_INVENTORY")
registry_host=$(jq -er '.registry.host' "$ACTOR_TERRAFORM_INVENTORY")
registry_ip=$(jq -er '.registry.accessIp' "$ACTOR_TERRAFORM_INVENTORY")
[[ $image == "$registry_host"/* ]] || { echo "tccli image registry differs from Terraform inventory" >&2; exit 1; }
getent ahostsv4 "$registry_host" | awk '{print $1}' | grep -Fx "$registry_ip" >/dev/null || {
	echo "tccli image registry does not resolve to the Cell private endpoint" >&2
	exit 1
}
jq -e --arg host "$registry_host" '.auths[$host].auth | type == "string" and length > 0' \
	"$ACTOR_TCR_BOOTSTRAP_AUTH" >/dev/null

install -d -m 0700 "$root" "$root/storage" "$root/runroot" "$(dirname -- "$ACTOR_TCCLI_TOOL_RECEIPT")"
container_file=$root/container-id
identity_file=$root/identity.json
if [[ -f $container_file && ! -L $container_file && -f $identity_file && ! -L $identity_file ]] &&
	jq -e --arg image "$image" --arg digest "$inventory_digest" \
		'.image == $image and .imageInventoryDigest == $digest' "$identity_file" >/dev/null; then
	container=$(<"$container_file")
	buildah --root "$root/storage" --runroot "$root/runroot" --storage-driver vfs \
		inspect --type container "$container" >/dev/null
else
	[[ ! -e $container_file && ! -e $identity_file ]] || {
		echo "tccli tool has ambiguous partial or divergent state" >&2
		exit 1
	}
	buildah --root "$root/storage" --runroot "$root/runroot" --storage-driver vfs \
		pull --authfile "$ACTOR_TCR_BOOTSTRAP_AUTH" "$image" >/dev/null
	container=$(buildah --root "$root/storage" --runroot "$root/runroot" --storage-driver vfs from "$image")
	[[ $container =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]
	printf '%s\n' "$container" >"$root/.container-id.new"
	jq -cn --arg image "$image" --arg digest "$inventory_digest" \
		'{image:$image,imageInventoryDigest:$digest}' >"$root/.identity.json.new"
	chmod 0600 "$root/.container-id.new" "$root/.identity.json.new"
	mv "$root/.container-id.new" "$container_file"
	mv "$root/.identity.json.new" "$identity_file"
fi

buildah --root "$root/storage" --runroot "$root/runroot" --storage-driver vfs run --network none \
	"$container" -- tccli --version >/dev/null
receipt=$(mktemp "$(dirname -- "$ACTOR_TCCLI_TOOL_RECEIPT")/.tccli-tool-receipt.XXXXXX")
trap 'rm -f -- "$receipt"' EXIT
jq -cn --arg image "$image" --arg digest "$inventory_digest" \
	--arg identity_sha "$(sha256sum "$identity_file" | cut -d' ' -f1)" \
	'{schema:"actor-create-first-tccli-tool/v1",verdict:"passed",image:$image,
      imageInventoryDigest:$digest,identitySha256:$identity_sha}' >"$receipt"
if [[ -e $ACTOR_TCCLI_TOOL_RECEIPT ]]; then
	cmp -s "$receipt" "$ACTOR_TCCLI_TOOL_RECEIPT" || { echo "tccli tool receipt differs" >&2; exit 1; }
else
	ln "$receipt" "$ACTOR_TCCLI_TOOL_RECEIPT"
fi
chmod 0644 "$ACTOR_TCCLI_TOOL_RECEIPT"
printf 'tccli_tool=ready image=%s receipt=%s sha256=%s\n' "$image" "$ACTOR_TCCLI_TOOL_RECEIPT" \
	"$(sha256sum "$ACTOR_TCCLI_TOOL_RECEIPT" | cut -d' ' -f1)"
