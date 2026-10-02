#!/usr/bin/env bash
set -euo pipefail

# Run the reviewed Tencent CLI foundation image without installing hundreds of
# megabytes of mutable Python packages on a bootstrap node. The image and
# working container are prepared from the immutable image inventory first.
root=${ACTOR_TCCLI_TOOL_ROOT:-/var/lib/actor-bootstrap/tccli-tool}
container_file=$root/container-id
api_root=${TENCENT_API_ROOT_DOMAIN:-internal.tencentcloudapi.com}

[[ $root == /* && $root != / && -f $container_file && ! -L $container_file ]] || {
	echo "tccli tool container is not prepared" >&2
	exit 2
}
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY; do
	[[ -n ${!variable:-} ]] || { echo "missing protected environment: $variable" >&2; exit 2; }
done
[[ $api_root == internal.tencentcloudapi.com ]] || {
	echo "bootstrap tccli must use Tencent's private API root" >&2
	exit 2
}
container=$(<"$container_file")
[[ $container =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]

environment=(
	--env TENCENTCLOUD_SECRET_ID
	--env TENCENTCLOUD_SECRET_KEY
)
for variable in TENCENTCLOUD_TOKEN TENCENTCLOUD_REGION; do
	[[ -z ${!variable:-} ]] || environment+=(--env "$variable")
done

exec buildah --root "$root/storage" --runroot "$root/runroot" \
	--storage-driver vfs run --network host "${environment[@]}" \
	"$container" -- sh -ceu \
	'tccli configure set-root-domain "$1" >/dev/null; shift; exec tccli "$@"' \
	actor-tccli "$api_root" "$@"
