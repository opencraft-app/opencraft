#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=
output=
metadata=
update_channel_url=
allow_insecure_update_http=false
channel_key_id=
channel_public_key=
release_key_id=
release_public_key=

usage() {
  echo "usage: build-vela-linux-amd64-buildx.sh --version vX.Y.Z --output ABSOLUTE_PATH --update-channel-url URL [--allow-insecure-update-http] --channel-key-id ID --channel-public-key BASE64 --release-key-id ID --release-public-key BASE64 [--metadata ABSOLUTE_PATH]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || usage; version=$2; shift 2 ;;
    --output) [ "$#" -ge 2 ] || usage; output=$2; shift 2 ;;
    --metadata) [ "$#" -ge 2 ] || usage; metadata=$2; shift 2 ;;
    --update-channel-url) [ "$#" -ge 2 ] || usage; update_channel_url=$2; shift 2 ;;
    --allow-insecure-update-http) allow_insecure_update_http=true; shift ;;
    --channel-key-id) [ "$#" -ge 2 ] || usage; channel_key_id=$2; shift 2 ;;
    --channel-public-key) [ "$#" -ge 2 ] || usage; channel_public_key=$2; shift 2 ;;
    --release-key-id) [ "$#" -ge 2 ] || usage; release_key_id=$2; shift 2 ;;
    --release-public-key) [ "$#" -ge 2 ] || usage; release_public_key=$2; shift 2 ;;
    *) usage ;;
  esac
done

printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$' || usage
case "$output" in /*) ;; *) usage ;; esac
if [ -n "$metadata" ]; then case "$metadata" in /*) ;; *) usage ;; esac; fi
[ ! -e "$output" ] || { echo "Linux build output already exists" >&2; exit 1; }
case "$update_channel_url" in
https://[A-Za-z0-9]*) [ "$allow_insecure_update_http" = false ] || usage ;;
http://[A-Za-z0-9]*) [ "$allow_insecure_update_http" = true ] || usage ;;
*) usage ;;
esac
case "$update_channel_url" in *[!A-Za-z0-9.:/_-]*|*'?'*|*'#'* ) usage ;; esac
for key_id in "$channel_key_id" "$release_key_id"; do
  case "$key_id" in *[!A-Za-z0-9._-]*|'') usage ;; esac
done
for public_key in "$channel_public_key" "$release_public_key"; do
  case "$public_key" in *[!A-Za-z0-9+/=_-]*|'') usage ;; esac
done
allow_insecure_update_http_value=0
if [ "$allow_insecure_update_http" = true ]; then
  allow_insecure_update_http_value=1
fi

for command_name in docker file go; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "missing command: $command_name" >&2; exit 1; }
done

builder_name=${VELA_BUILDX_BUILDER:-vela-computer-release}
case "$builder_name" in *[!A-Za-z0-9_.-]*|'') echo "invalid Buildx builder name" >&2; exit 2 ;; esac
buildkit_image='moby/buildkit@sha256:9194b5ec1be368f41c516df7f93f7f540630ea06136056b2ffebb62226ed4ad6'
if ! docker buildx inspect "$builder_name" >/dev/null 2>&1; then
  docker buildx create \
    --name "$builder_name" \
    --driver docker-container \
    --driver-opt "image=$buildkit_image" >/dev/null
fi
docker buildx inspect "$builder_name" --bootstrap >/dev/null

output_parent=$(dirname -- "$output")
mkdir -p "$output_parent"
stage=$(mktemp -d "$output_parent/.vela-linux-build.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
metadata_arg=
if [ -n "$metadata" ]; then
  metadata_arg="--metadata-file=$stage/metadata.json"
fi

# shellcheck disable=SC2086
docker buildx build \
  --builder "$builder_name" \
  --platform linux/amd64 \
  --file "$project_dir/deploy/linux-amd64.Dockerfile" \
  --build-arg "VELA_VERSION=$version" \
  --build-arg "VELA_UPDATE_CHANNEL_URL=$update_channel_url" \
  --build-arg "VELA_ALLOW_INSECURE_UPDATE_HTTP=$allow_insecure_update_http_value" \
  --build-arg "VELA_CHANNEL_KEY_ID=$channel_key_id" \
  --build-arg "VELA_CHANNEL_PUBLIC_KEY=$channel_public_key" \
  --build-arg "VELA_RELEASE_KEY_ID=$release_key_id" \
  --build-arg "VELA_RELEASE_PUBLIC_KEY=$release_public_key" \
  --provenance=mode=max \
  $metadata_arg \
  --output "type=local,dest=$stage/output" \
  "$project_dir"

built="$stage/output/vela-computer"
[ -f "$built" ] && [ ! -L "$built" ] || { echo "Buildx did not export vela-computer" >&2; exit 1; }
file "$built" | grep -Eq 'ELF 64-bit.*x86-64' || { echo "Buildx output is not Linux AMD64 ELF" >&2; exit 1; }
[ "$("$built" version --json)" = "{\"mode\":\"vela\",\"name\":\"vela-computer\",\"version\":\"$version\"}" ] || {
  echo "Buildx output version mismatch" >&2
  exit 1
}
go tool nm "$built" >"$stage/nm.txt"
grep -q 'vela_tat_register' "$stage/nm.txt" || { echo "Buildx output lacks native TAT bridge" >&2; exit 1; }
chmod 0755 "$built"
mv "$built" "$output"
if [ -n "$metadata" ]; then
  [ -f "$stage/metadata.json" ] || { echo "Buildx metadata missing" >&2; exit 1; }
  mv "$stage/metadata.json" "$metadata"
fi
trap - EXIT HUP INT TERM
rm -rf "$stage"
echo "$output"
