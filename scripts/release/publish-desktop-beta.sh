#!/usr/bin/env bash
set -euo pipefail

tag="$1"
commit="$(git rev-parse HEAD)"
manifest=desktop-release-manifest.json
kit=.github/secure-release/v1/secure_release.py
python3 "$kit" manifest-verify --desktop-beta --tag "$tag" --manifest "candidate/$manifest" --directory candidate

notes="$(mktemp)"
metadata="$(mktemp)"
remote="$(mktemp -d)"
trap 'rm -f "$notes" "$metadata"; rm -rf "$remote"' EXIT
cat >"$notes" <<EOF
OpenCraft $tag from commit $commit ([build and verification]($RUN_URL)).

- macOS Universal DMG and ZIP support Apple Silicon and Intel. Both contain the Developer ID-signed, notarized app.
- Linux x64 AppImage uses the repository-owned Electron build.
- Windows x64 installer and ZIP are unsigned.
- Android arm64 APK is signed with the OpenCraft production key.

The desktop release manifest identifies the source and every published asset.
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
  python3 "$kit" manifest-verify --desktop-beta --tag "$tag" --manifest "$remote/$manifest" --directory "$remote"
}

check_tag optional
if ! read_release; then
  gh release create "$tag" --target "$commit" --draft --prerelease --title "$tag" --notes-file "$notes"
  read_release
fi
jq -e --arg commit "$commit" --rawfile notes "$notes" \
  '.isPrerelease and .targetCommitish == $commit and (.body | rtrimstr("\n")) == ($notes | rtrimstr("\n"))' \
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
  gh release edit "$tag" --draft=false
fi

check_tag required
read_release
jq -e '.isDraft == false and .isPrerelease == true' "$metadata" >/dev/null
rm -r "$remote"
mkdir "$remote"
verify_download
gh release view "$tag" --json url --jq .url
