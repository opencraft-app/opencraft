#!/usr/bin/env bash
set -euo pipefail
image=ghcr.io/opencraft-app/opencraft
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
unset GH_TOKEN
# The architectures the workflow built and distributed, e.g. "amd64 arm64".
read -r -a architectures <<<"${ARCHITECTURES:?ARCHITECTURES required}"
(( ${#architectures[@]} ))
for arch in "${architectures[@]}"; do [[ "$arch" =~ ^(amd64|arm64)$ ]]; done
expected_platforms="$(printf 'linux/%s\n' "${architectures[@]}" | sort | paste -sd, -)"
sources=()
for arch in "${architectures[@]}"; do
  candidate="$image:run-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${arch}"
  digest=$(docker buildx imagetools inspect "$candidate" --format '{{.Manifest.Digest}}')
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
  sources+=("$image@$digest")
done
# Per-run index is assembled exclusively from verified architecture digests.
index="$image:run-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
docker buildx imagetools create --tag "$index" "${sources[@]}"
docker buildx imagetools inspect "$index" --raw > /tmp/container-index.json
EXPECTED_PLATFORMS="$expected_platforms" node --input-type=module -e '
import fs from "node:fs";
const m=JSON.parse(fs.readFileSync("/tmp/container-index.json"));
const p=m.manifests.map(x=>x.platform.os+"/"+x.platform.architecture).sort().join(",");
if(p!==process.env.EXPECTED_PLATFORMS)throw Error("Invalid platform index");'
digest=$(docker buildx imagetools inspect "$index" --format '{{.Manifest.Digest}}')
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
# Fail closed on registry errors other than an explicitly absent SHA tag.
sha_tag="$image:sha-$GITHUB_SHA"
if existing=$(docker buildx imagetools inspect "$sha_tag" --format '{{.Manifest.Digest}}' 2>/tmp/container-inspect-error); then
  if [[ "$existing" != "$digest" ]]; then
    echo '::error::This source SHA already has a different image. Refusing to overwrite; use a new commit.'
    exit 1
  fi
else
  grep -Eqi 'manifest unknown|not found' /tmp/container-inspect-error || { cat /tmp/container-inspect-error >&2; exit 1; }
  docker buildx imagetools create --tag "$sha_tag" "$image@$digest"
fi
# Promotion is serialized. An older run may publish its SHA but never move edge backwards.
head=$(git ls-remote origin refs/heads/main | cut -f1)
if [[ "$head" == "$GITHUB_SHA" ]]; then
  docker buildx imagetools create --tag "$image:edge" "$image@$digest"
else
  echo 'Main has advanced; leaving edge unchanged.'
fi
printf '### Container distribution\nSource: `%s`\nPinned image: `%s@%s`\n\n```sh\ndocker pull %s@%s\n```\n' "$GITHUB_SHA" "$image" "$digest" "$image" "$digest" >> "$GITHUB_STEP_SUMMARY"
