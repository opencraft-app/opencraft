#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_sha=
output=
usage() {
  echo "usage: build-vela-candidate.sh --source-sha FULL_SHA --out-dir ABSOLUTE_PATH" >&2
  exit 2
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-sha) [ "$#" -ge 2 ] || usage; source_sha=$2; shift 2 ;;
    --out-dir) [ "$#" -ge 2 ] || usage; output=$2; shift 2 ;;
    *) usage ;;
  esac
done
printf '%s\n' "$source_sha" | grep -Eq '^[0-9a-f]{40}$' || {
  echo "invalid source sha" >&2; exit 2;
}
case "$output" in /*) ;; *) usage ;; esac
[ ! -e "$output" ] && [ ! -L "$output" ] || {
  echo "candidate output already exists" >&2; exit 1;
}
for tool in go git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 1; }
done
checkout_sha=$(git -C "$project_dir" rev-parse HEAD)
[ "$source_sha" = "$checkout_sha" ] || {
  echo "source sha does not match checkout" >&2; exit 1;
}
host_os=$(go env GOHOSTOS)
host_arch=$(go env GOHOSTARCH)
platform="$host_os-$host_arch"
case "$platform" in linux-amd64|linux-arm64|darwin-amd64|darwin-arm64) ;; *)
  echo "unsupported native candidate platform" >&2; exit 2 ;;
esac
source_dirty=false
if [ -n "$(git -C "$project_dir" status --porcelain --untracked-files=normal -- .)" ]; then
  source_dirty=true
fi
version="v0.0.0-ci.$source_sha"
parent=$(dirname -- "$output")
mkdir -p "$parent"
stage=$(mktemp -d "$parent/.vela-candidate.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM

# Candidate builds do not inherit native TAT tags, persisted Go flags, signing
# material, or an update channel. This is not a deployment-qualified release.
(
  cd "$project_dir"
  env CGO_ENABLED=0 GOENV=off GOFLAGS= GOWORK=off GOOS="$host_os" GOARCH="$host_arch" \
    go build -trimpath -buildvcs=false -ldflags "-X main.version=$version" \
      -o "$stage/vela-computer" ./cmd/vela-computer
)
VELA_HOME="$stage/state" sh "$project_dir/scripts/build-vela-release.sh" \
  --version "$version" --agent-binary "$stage/vela-computer" --out-dir "$stage/release"
printf '{"schemaVersion":1,"kind":"candidate","version":"%s","sourceSha":"%s","sourceDirty":%s,"platform":"%s","compiledCgo":false,"bakedUpdateChannel":false,"deploymentQualified":false}\n' \
  "$version" "$source_sha" "$source_dirty" "$platform" > "$stage/release/CANDIDATE.json"
if command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1"; }
elif command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1"; }
else
  echo "no SHA-256 tool" >&2; exit 1
fi
(
  cd "$stage/release"
  for file in vela-computer VERSION CANDIDATE.json; do checksum "$file"; done
) > "$stage/release/SHA256SUMS"
mv "$stage/release" "$output"
echo "Built unqualified candidate: $platform $source_sha"
