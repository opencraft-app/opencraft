#!/usr/bin/env bash
set -euo pipefail

origin="${1:-}"
mode="${2:-}"
if [[ ! "$origin" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]]; then
  echo "Usage: $0 https://<quick-tunnel>.trycloudflare.com [--full]" >&2
  exit 2
fi
if [[ -n "$mode" && "$mode" != "--full" ]]; then
  echo "Unknown option: $mode" >&2
  exit 2
fi

manifest_file="$(mktemp)"
trap 'rm -f "$manifest_file" "${bundle_file:-}"' EXIT

curl --fail --silent --show-error --max-time 30 \
  -H 'Accept: application/expo+json' \
  -H 'expo-platform: ios' \
  "$origin/?platform=ios" -o "$manifest_file"

bundle_url="$(python3 - "$origin" "$manifest_file" <<'PY'
import json
import sys
from urllib.parse import urlparse

origin, manifest_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as stream:
    manifest = json.load(stream)
bundle_url = manifest["launchAsset"]["url"]
if bundle_url.startswith(origin + "/") and urlparse(bundle_url).scheme == "https":
    print(bundle_url)
else:
    raise SystemExit(f"Unexpected bundle origin: {bundle_url}")
PY
)"

if [[ "$mode" == "--full" ]]; then
  bundle_file="$(mktemp)"
  curl --fail --silent --show-error --location --compressed --max-time 120 \
    "$bundle_url" -o "$bundle_file"
  test -s "$bundle_file"
  printf 'iOS manifest and bundle OK (%s bytes)\n' "$(wc -c < "$bundle_file")"
else
  printf 'iOS manifest and bundle origin OK (bundle not downloaded)\n'
fi
printf 'Open in iOS Safari: exps://%s\n' "${origin#https://}"
