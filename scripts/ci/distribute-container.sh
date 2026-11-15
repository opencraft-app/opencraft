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
# A genuinely anonymous registry request; never reuse the CI credential config.
docker logout ghcr.io
rm -rf "$DOCKER_CONFIG"
DOCKER_CONFIG=$(mktemp -d)
docker pull "$candidate" || { echo '::error::Anonymous pull failed. Check GHCR package visibility (public) and retry this run.'; exit 1; }
test "$(docker image inspect "$candidate" --format '{{.Id}}')" = "$expected"
digest=$(docker image inspect "$candidate" --format '{{index .RepoDigests 0}}')
OPENCRAFT_IMAGE="$digest" node scripts/smoke/server/smoke-container.mjs
printf '### %s verified\nSource: `%s`\nImage: `%s`\n' "$ARCH" "$GITHUB_SHA" "$digest" >> "$GITHUB_STEP_SUMMARY"
