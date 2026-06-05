#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$root_dir/../.." && pwd)"
wisp_dir="${CLOUDAGENT_WISP_DIR:-$repo_root/cloudagent/wisp}"
goos="${GOOS:-linux}"
goarch="${GOARCH:-amd64}"
stamp="${CLOUDAGENT_SINGLE_HOST_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
dist_dir="$root_dir/dist"
stage_name="cloudagent-single-host-${goos}-${goarch}-${stamp}"
stage="$dist_dir/$stage_name"
out="$dist_dir/$stage_name.tar.gz"

if [[ "$goos" != "linux" ]]; then
  echo "single-host package only supports GOOS=linux" >&2
  exit 2
fi

mkdir -p "$dist_dir"
rm -rf "$stage" "$out"
mkdir -p "$stage/bin" "$stage/config" "$stage/scripts" "$stage/packages" "$stage/logs"

echo "[single-host-package] build gateway server GOOS=$goos GOARCH=$goarch" >&2
(
  cd "$root_dir"
  GOWORK=off GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags '-s -w -buildid=' -o "$stage/bin/cloudagent-gateway" ./cmd/server
)

echo "[single-host-package] build Wisp package" >&2
(
  cd "$wisp_dir"
  LINUX_GOARCH="$goarch" make linux-single-tar.gz
)
wisp_pkg="$(find "$wisp_dir/dist-release" -maxdepth 1 -type f -name "wisp-linux-${goarch}-*.tar.gz" | sort | tail -n 1)"
if [[ -z "$wisp_pkg" || ! -f "$wisp_pkg" ]]; then
  echo "Wisp package was not produced" >&2
  exit 1
fi
cp "$wisp_pkg" "$stage/packages/"

cp "$root_dir/packaging/single-host/env.example" "$stage/config/env.example"
cp "$root_dir/packaging/single-host/README.md" "$stage/README.md"
cp "$root_dir/packaging/single-host/start-acp-gateway.sh" "$stage/scripts/start-acp-gateway.sh"
chmod +x "$stage/bin/cloudagent-gateway" "$stage/scripts/start-acp-gateway.sh"

tar -C "$dist_dir" -czf "$out" "$stage_name"
echo "$out"
