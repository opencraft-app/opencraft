#!/usr/bin/env bash
set -euo pipefail

# Publishes the staged candidate: vX.Y.Z-beta.N as a GitHub pre-release, or
# vX.Y.Z as the latest stable release opening with its CHANGELOG section.
tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-beta\.[1-9][0-9]*)?$ ]]
if [[ -n "${BASH_REMATCH[1]}" ]]; then
  prerelease=true release_kind=(--prerelease) visibility=(--prerelease)
else
  prerelease=false release_kind=() visibility=(--latest)
fi
commit="$(git rev-parse HEAD)"
manifest=release-manifest.json
kit=.github/secure-release/v1/secure_release.py
python3 "$kit" manifest-verify "${release_kind[@]}" --tag "$tag" --manifest "candidate/$manifest" --directory candidate

# The release uploaded this commit to TestFlight; link the public beta when
# the repository has configured one.
[[ "${TESTFLIGHT_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "${TESTFLIGHT_NUMBER:-}" =~ ^[1-9][0-9]{0,3}$ ]]
testflight="TestFlight build $TESTFLIGHT_VERSION ($TESTFLIGHT_NUMBER)"
# The release pushed its tested server image before publishing (publish-container-release.sh).
[[ "${SERVER_IMAGE:-}" =~ ^ghcr\.io/opencraft-app/opencraft-server@sha256:[a-f0-9]{64}$ ]]
image_name="${SERVER_IMAGE%@*}"
if [[ -n "${TESTFLIGHT_PUBLIC_LINK:-}" ]]; then
  [[ "$TESTFLIGHT_PUBLIC_LINK" =~ ^https://testflight\.apple\.com/join/[A-Za-z0-9]+$ ]]
  testflight="[$testflight]($TESTFLIGHT_PUBLIC_LINK)"
fi

notes="$(mktemp)"
metadata="$(mktemp)"
remote="$(mktemp -d)"
trap 'rm -f "$notes" "$metadata"; rm -rf "$remote"' EXIT
if [[ "$prerelease" == false ]]; then
  python3 "$kit" changelog --tag "$tag" --changelog CHANGELOG.md --notes "$notes"
  echo >>"$notes"
fi
cat >>"$notes" <<EOF
OpenCraft $tag from commit $commit ([build and verification]($RUN_URL)).

- macOS Universal DMG and ZIP support Apple Silicon and Intel. Both contain the Developer ID-signed, notarized app.
- Linux x64 AppImage uses the repository-owned Electron build.
- Windows x64 installer and ZIP are unsigned.
- Android arm64 APK is signed with the OpenCraft production key.
- iOS: $testflight; it appears once Apple finishes processing and beta review.
- iOS unsigned IPA is for signing with your own Apple ID (AltStore, SideStore).
- Server: the headless Linux x64 archive, and the container image \`$image_name:${tag#v}\` (linux/amd64), pinned as \`$SERVER_IMAGE\`.

The release manifest identifies the source and every published asset.
EOF

check_tag() {
  local refs
  refs="$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}")"
  if [[ -z "$refs" ]]; then
    test "$1" = optional
  else
    test "$(awk 'END { print $1 }' <<<"$refs")" = "$commit"
  fi
}

read_release() {
  gh release view "$tag" --json isDraft,isPrerelease,targetCommitish,body,assets >"$metadata"
}

verify_download() {
  gh release download "$tag" --pattern '*' --dir "$remote"
  cmp "candidate/$manifest" "$remote/$manifest"
  python3 "$kit" manifest-verify "${release_kind[@]}" --tag "$tag" --manifest "$remote/$manifest" --directory "$remote"
}

check_tag optional
if ! read_release; then
  gh release create "$tag" --target "$commit" --draft "${visibility[@]}" --title "$tag" --notes-file "$notes"
  read_release
fi
jq -e --arg commit "$commit" --argjson prerelease "$prerelease" --rawfile notes "$notes" \
  '.isPrerelease == $prerelease and .targetCommitish == $commit and (.body | rtrimstr("\n")) == ($notes | rtrimstr("\n"))' \
  "$metadata" >/dev/null

if jq -e .isDraft "$metadata" >/dev/null; then
  while IFS= read -r name; do
    test -f "candidate/$name" && test "$name" = "$(basename "$name")"
    gh release download "$tag" --pattern "$name" --dir "$remote"
    cmp "candidate/$name" "$remote/$name"
  done < <(jq -r '.assets[].name' "$metadata")

  missing=()
  for asset in candidate/*; do
    if [[ ! -e "$remote/$(basename "$asset")" ]]; then missing+=("$asset"); fi
  done
  if (( ${#missing[@]} )); then gh release upload "$tag" "${missing[@]}"; fi
  rm -r "$remote"
  mkdir "$remote"
  verify_download
  check_tag optional
  gh release edit "$tag" --draft=false "${visibility[@]}"
fi

check_tag required
read_release
jq -e --argjson prerelease "$prerelease" '.isDraft == false and .isPrerelease == $prerelease' "$metadata" >/dev/null
rm -r "$remote"
mkdir "$remote"
verify_download
gh release view "$tag" --json url --jq .url
