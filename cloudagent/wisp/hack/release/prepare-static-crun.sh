#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

version="${CRUN_VERSION:-1.17}"
goarch="${GOARCH:-$(go env GOARCH 2>/dev/null || uname -m)}"
case "$goarch" in
  x86_64) goarch="amd64" ;;
  aarch64) goarch="arm64" ;;
esac

default_url="https://github.com/containers/crun/releases/download/${version}/crun-${version}-linux-${goarch}"
url="${CRUN_URL:-$default_url}"
out="${CRUN_OUT:-$repo_root/assets/bin/crun/crun-${goarch}}"
tmp="$(mktemp "${TMPDIR:-/tmp}/crun-static.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

mkdir -p "$(dirname "$out")"
curl -fL --retry 3 --retry-delay 1 -o "$tmp" "$url"
chmod 0755 "$tmp"

actual_sha="$(sha256sum "$tmp" 2>/dev/null | awk '{print $1}')"
if [[ -z "$actual_sha" ]]; then
  actual_sha="$(shasum -a 256 "$tmp" | awk '{print $1}')"
fi

expected_sha="${CRUN_EXPECTED_SHA256:-}"
if [[ -z "$expected_sha" && "$version" == "1.17" && "$goarch" == "amd64" ]]; then
  expected_sha="e9512a3e034e781b2396d068fd24eafcd5788e410403da886df9dc8871d504a5"
fi
if [[ -n "$expected_sha" && "$actual_sha" != "$expected_sha" ]]; then
  echo "crun sha256 mismatch: expected $expected_sha got $actual_sha" >&2
  exit 1
fi

if command -v file >/dev/null 2>&1; then
  file "$tmp"
  if ! file "$tmp" | grep -qi 'statically linked'; then
    echo "downloaded crun is not statically linked" >&2
    exit 1
  fi
fi

if command -v ldd >/dev/null 2>&1; then
  ldd_out="$(ldd "$tmp" 2>&1 || true)"
  echo "$ldd_out"
  if ! grep -qi 'not a dynamic executable' <<<"$ldd_out"; then
    echo "downloaded crun has dynamic dependencies" >&2
    exit 1
  fi
fi

mv "$tmp" "$out"
trap - EXIT

echo "CRUN=$out"
echo "SHA256=$actual_sha"
