#!/usr/bin/env bash
set -euo pipefail
image=ghcr.io/opencraft-app/opencraft
candidate="$image:run-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${ARCH}"
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
unset GH_TOKEN
docker load -i /tmp/container/image.tar.gz
expected=$(docker image inspect opencraft:local --format '{{.Id}}')
test "$(docker image inspect opencraft:local --format '{{.Architecture}}')" = "$ARCH"
test "$(docker image inspect opencraft:local --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$GITHUB_SHA"
docker tag opencraft:local "$candidate"
docker push "$candidate"
# The package is a private internal registry. Drop every local copy so the
# image verified and smoke-tested below can only have come from the registry.
docker image rm "$candidate" opencraft:local
docker pull "$candidate" || { echo '::error::Pulling the pushed image back from GHCR failed.'; exit 1; }
test "$(docker image inspect "$candidate" --format '{{.Id}}')" = "$expected"
digest=$(docker image inspect "$candidate" --format '{{index .RepoDigests 0}}')
OPENCRAFT_IMAGE="$digest" node scripts/smoke/server/smoke-container.mjs
printf '### %s verified\nSource: `%s`\nImage: `%s`\n' "$ARCH" "$GITHUB_SHA" "$digest" >> "$GITHUB_STEP_SUMMARY"
