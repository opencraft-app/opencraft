#!/usr/bin/env bash
set -euo pipefail

# Builds the OpenCraft server image for one architecture as opencraft:local,
# identified by this commit. Both the main-branch container workflow and the
# server release build through here, so a release ships the image CI tests.
# Requires OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION (the owned-electron action).
arch="$1"
[[ "$arch" =~ ^(amd64|arm64)$ ]]
test -d "${OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION:?owned Electron browser distribution required}"
revision="$(git rev-parse HEAD)"
source_date_epoch="$(git show -s --format=%ct HEAD)"
docker buildx build -f deploy/docker/Dockerfile.owned-electron \
  --build-context "owned-electron=$OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION" \
  --platform "linux/$arch" \
  --build-arg "OPENCRAFT_BUILD_ID=github-$revision" \
  --build-arg "OPENCRAFT_SOURCE_REVISION=$revision" \
  --build-arg "SOURCE_DATE_EPOCH=$source_date_epoch" \
  --target runtime --tag opencraft:local --load .
