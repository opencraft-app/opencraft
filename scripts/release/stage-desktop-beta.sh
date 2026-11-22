#!/usr/bin/env bash
set -euo pipefail

tag="$1"
version="$(jq -er .version apps/desktop/package.json)"
[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-beta\.[1-9][0-9]*$ ]]
test "v$version" = "${tag%-beta.*}"
commit="$(git rev-parse HEAD)"
macos=inputs/macos
dmg="OpenCraft-$version-universal.dmg"
zip="OpenCraft-$version-mac-universal.zip"

(cd "$macos" && sha256sum --strict --check SHA256SUMS)
digest="$(sha256sum -- "$macos/$dmg" | cut -d ' ' -f 1)"
jq -e --arg commit "$commit" --arg image "$dmg" --arg digest "$digest" \
  '.passed == true and .hostRoundTrip == true and .sourceRevision == $commit and .image == $image and .sha256 == $digest' \
  "$macos/macos-universal-smoke.json" >/dev/null

mkdir candidate
prefix="OpenCraft-${tag#v}"
mv "$macos/$dmg" "candidate/$prefix-universal.dmg"
mv "$macos/$zip" "candidate/$prefix-mac-universal.zip"
mv "$macos/macos-universal-smoke.json" candidate/
mv "inputs/desktop/desktop-linux-x64/OpenCraft-$version-linux-x86_64.AppImage" \
  "candidate/$prefix-linux-x86_64.AppImage"
mv "inputs/desktop/desktop-windows-x64/OpenCraft-$version-win-x64.zip" \
  "candidate/$prefix-win-x64.zip"
mv "inputs/desktop/desktop-windows-x64/OpenCraft-Setup-$version-x64.exe" \
  "candidate/OpenCraft-Setup-${tag#v}-x64.exe"

(cd candidate && sha256sum -- * > SHA256SUMS.txt)

manifest="candidate/desktop-release-manifest.json"
files=()
for file in candidate/*; do files+=(--artifact "$file"); done
python3 .github/secure-release/v1/secure_release.py manifest-create --desktop-beta \
  --tag "$tag" --version "${tag#v}" "${files[@]}" --output "$manifest"
python3 .github/secure-release/v1/secure_release.py manifest-verify --desktop-beta \
  --tag "$tag" --manifest "$manifest" --directory candidate
