#!/usr/bin/env bash
set -euo pipefail

# Publishes the server image an App release built and smoke-tested
# (server-release.yml) as ghcr.io/opencraft-app/opencraft-server:<version>; a
# stable vX.Y.Z also moves `latest`. This package only ever receives release
# images, so it can be public without exposing CI candidates, which stay in the
# private ghcr.io/opencraft-app/opencraft package.
#
# A published version never names a different image: a rerun that finds the tag
# pushes nothing and accepts it only when the pulled image is the tested one.
# Writes `image=<name>@<digest>` to $GITHUB_OUTPUT.
tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-beta\.[1-9][0-9]*)?$ ]]
stable=true
if [[ -n "${BASH_REMATCH[1]}" ]]; then stable=false; fi
version="${tag#v}"
image="${OPENCRAFT_SERVER_IMAGE:-ghcr.io/opencraft-app/opencraft-server}"
archive="${IMAGE_ARCHIVE:?IMAGE_ARCHIVE required}"
commit="$(git rev-parse HEAD)"

export DOCKER_CONFIG
DOCKER_CONFIG="$(mktemp -d)"
inspect_error="$(mktemp)"
trap 'rm -rf "$DOCKER_CONFIG" "$inspect_error"' EXIT
printf '%s' "${GH_TOKEN:?GH_TOKEN required}" | docker login ghcr.io -u "${GITHUB_ACTOR:?}" --password-stdin
unset GH_TOKEN

docker load -i "$archive"
expected="$(docker image inspect opencraft:local --format '{{.Id}}')"
[[ "$expected" =~ ^sha256:[a-f0-9]{64}$ ]]
test "$(docker image inspect opencraft:local --format '{{.Architecture}}')" = amd64
test "$(docker image inspect opencraft:local --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$commit"

ref="$image:$version"
if docker buildx imagetools inspect "$ref" >/dev/null 2>"$inspect_error"; then
  echo "$ref is already published; verifying it holds this image."
else
  # Fail closed on registry errors other than an absent tag.
  grep -Eqi 'manifest unknown|not found' "$inspect_error" || { cat "$inspect_error" >&2; exit 1; }
  docker tag opencraft:local "$ref"
  docker push "$ref"
fi

# Verify what the registry serves, never a local copy.
docker image rm --force "$expected" >/dev/null
docker pull "$ref"
if [[ "$(docker image inspect "$ref" --format '{{.Id}}')" != "$expected" ]]; then
  echo "::error::$ref names a different image. A published version never moves; release a new version."
  exit 1
fi
pinned="$(docker image inspect "$ref" --format '{{index .RepoDigests 0}}')"
[[ "$pinned" =~ ^${image//./\\.}@sha256:[a-f0-9]{64}$ ]]

if [[ "$stable" == true ]]; then
  docker buildx imagetools create --tag "$image:latest" "$pinned"
fi

echo "image=$pinned" >> "${GITHUB_OUTPUT:-/dev/null}"
# shellcheck disable=SC2016 # Markdown backticks, not shell expansion.
printf '### Server image\n`%s` (`%s`)\n' "$ref" "$pinned" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
