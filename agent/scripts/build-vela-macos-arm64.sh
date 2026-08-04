#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=
output="$project_dir/dist/vela-computer"

usage() {
  echo "usage: build-vela-macos-arm64.sh --version vX.Y.Z [--output ABSOLUTE_PATH]" >&2
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
      -ldflags "-X main.version=$version" \
      -o "$temporary" \
      ./cmd/vela-computer
)
chmod 0755 "$temporary"
mv "$temporary" "$output"
trap - EXIT HUP INT TERM

echo "$output"
