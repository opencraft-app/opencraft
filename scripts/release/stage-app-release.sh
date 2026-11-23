#!/usr/bin/env bash
set -euo pipefail

# Stages one release candidate: vX.Y.Z-beta.N (pre-release) or vX.Y.Z (stable).
# The platform jobs built the product version the tag names, so their files
# carry that version; a missing file stops staging before anything moves.
tag="$1"
[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-beta\.[1-9][0-9]*)?$ ]]
version="${BASH_REMATCH[1]}"
release_kind=()
if [[ -n "${BASH_REMATCH[2]}" ]]; then release_kind=(--prerelease); fi
commit="$(git rev-parse HEAD)"
macos=inputs/macos
dmg="OpenCraft-$version-universal.dmg"
zip="OpenCraft-$version-mac-universal.zip"

(cd "$macos" && sha256sum --strict --check SHA256SUMS)
digest="$(sha256sum -- "$macos/$dmg" | cut -d ' ' -f 1)"
jq -e --arg commit "$commit" --arg image "$dmg" --arg digest "$digest" \
  '.passed == true and .hostRoundTrip == true and .sourceRevision == $commit and .image == $image and .sha256 == $digest' \
  "$macos/macos-universal-smoke.json" >/dev/null

# The Android job verified the package ID, version and production signature;
# bind the staged bytes to the digest it recorded beside them.
shopt -s nullglob
apks=(inputs/android/OpenCraft-*-android-release.apk)
shopt -u nullglob
test "${#apks[@]}" -eq 1
apk_digest="$(sha256sum -- "${apks[0]}" | cut -d ' ' -f 1)"
test "$(cut -d ' ' -f 1 "${apks[0]}.sha256")" = "$apk_digest"
# Likewise for the unsigned IPA that the iOS job checked for no signature.
ipa=inputs/ios/OpenCraft-ios-unsigned.ipa
test "$(cut -d ' ' -f 1 "$ipa.sha256")" = "$(sha256sum -- "$ipa" | cut -d ' ' -f 1)"
# And for the headless server archive the server release smoke-tested.
server="inputs/server/OpenCraft-server-$version-linux-amd64.tar.gz"
test "$(cut -d ' ' -f 1 "$server.sha256")" = "$(sha256sum -- "$server" | cut -d ' ' -f 1)"

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
mv "${apks[0]}" "candidate/$prefix-android-arm64.apk"
mv "$ipa" "candidate/$prefix-ios-unsigned.ipa"
mv "$server" "candidate/OpenCraft-server-${tag#v}-linux-amd64.tar.gz"

(cd candidate && sha256sum -- * > SHA256SUMS.txt)

manifest="candidate/release-manifest.json"
files=()
for file in candidate/*; do files+=(--artifact "$file"); done
python3 .github/secure-release/v1/secure_release.py manifest-create "${release_kind[@]}" \
  --tag "$tag" --version "${tag#v}" "${files[@]}" --output "$manifest"
python3 .github/secure-release/v1/secure_release.py manifest-verify "${release_kind[@]}" \
  --tag "$tag" --manifest "$manifest" --directory candidate
