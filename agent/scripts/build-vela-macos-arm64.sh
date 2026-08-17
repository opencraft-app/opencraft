#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=
output="$project_dir/dist/vela-computer"
update_channel_url=
allow_insecure_update_http=false
channel_key_id=
channel_public_key=
release_key_id=
release_public_key=

usage() {
  echo "usage: build-vela-macos-arm64.sh --version vX.Y.Z --update-channel-url URL [--allow-insecure-update-http] --channel-key-id ID --channel-public-key BASE64 --release-key-id ID --release-public-key BASE64 [--output ABSOLUTE_PATH]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
  --version)
    [ "$#" -ge 2 ] || usage
    version=$2
    shift 2
    ;;
  --output)
    [ "$#" -ge 2 ] || usage
    output=$2
    shift 2
    ;;
  --update-channel-url) [ "$#" -ge 2 ] || usage; update_channel_url=$2; shift 2 ;;
  --allow-insecure-update-http) allow_insecure_update_http=true; shift ;;
  --channel-key-id) [ "$#" -ge 2 ] || usage; channel_key_id=$2; shift 2 ;;
  --channel-public-key) [ "$#" -ge 2 ] || usage; channel_public_key=$2; shift 2 ;;
  --release-key-id) [ "$#" -ge 2 ] || usage; release_key_id=$2; shift 2 ;;
  --release-public-key) [ "$#" -ge 2 ] || usage; release_public_key=$2; shift 2 ;;
  *) usage ;;
  esac
done

if ! printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$'; then
  echo "build-vela-macos-arm64: invalid version" >&2
  exit 2
fi
case "$output" in
/*) ;;
*) echo "build-vela-macos-arm64: output must be absolute" >&2; exit 2 ;;
esac

case "$update_channel_url" in
https://[A-Za-z0-9]*) [ "$allow_insecure_update_http" = false ] || usage ;;
http://9.135.236.64) [ "$allow_insecure_update_http" = true ] || usage ;;
*) usage ;;
esac
case "$update_channel_url" in *[!A-Za-z0-9.:/_-]*|*'?'*|*'#'* ) usage ;; esac
for key_id in "$channel_key_id" "$release_key_id"; do
  case "$key_id" in *[!A-Za-z0-9._-]*|'') usage ;; esac
done
for public_key in "$channel_public_key" "$release_public_key"; do
  case "$public_key" in *[!A-Za-z0-9+/=_-]*|'') usage ;; esac
done
update_http_ldflag=
if [ "$allow_insecure_update_http" = true ]; then
  update_http_ldflag='-X main.updateChannelAllowInsecureHTTP=1'
fi

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "该构建入口当前只支持 macOS ARM64" >&2
  exit 1
fi

cargo build \
  --manifest-path "$project_dir/native/tat-agent/Cargo.toml" \
  --release

output_directory=$(dirname -- "$output")
mkdir -p "$output_directory"
temporary=$(mktemp "$output_directory/.vela-computer.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
(
  cd "$project_dir"
  CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 \
    go build \
      -trimpath \
      -tags vela_tat_cgo \
      -ldflags "-X main.version=$version -X main.updateChannelURL=$update_channel_url -X main.updateChannel=stable $update_http_ldflag -X main.updateChannelKeyID=$channel_key_id -X main.updateChannelPublicKey=$channel_public_key -X main.updateReleaseKeyID=$release_key_id -X main.updateReleasePublicKey=$release_public_key" \
      -o "$temporary" \
      ./cmd/vela-computer
)
chmod 0755 "$temporary"
mv "$temporary" "$output"
trap - EXIT HUP INT TERM

echo "$output"
