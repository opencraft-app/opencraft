#!/usr/bin/env bash
set -euo pipefail

repository=${OPENCRAFT_BUILD_REPOSITORY:?Set OPENCRAFT_BUILD_REPOSITORY to the Git checkout}
state_directory=${OPENCRAFT_BUILD_STATE_DIR:-/var/lib/opencraft-github-build}
image=${OPENCRAFT_BUILD_IMAGE:-opencraft}
branch=${OPENCRAFT_BUILD_BRANCH:-main}

[[ $repository = /* && $state_directory = /* ]] || {
  echo 'Repository and build state paths must be absolute' >&2
  exit 2
}
[[ $branch =~ ^[A-Za-z0-9._/-]+$ && $branch != -* && $branch != *..* ]] || {
  echo 'Build branch is invalid' >&2
  exit 2
}
[[ $image =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || {
  echo 'Build image name is invalid' >&2
  exit 2
}

for executable in docker flock git mktemp; do
  command -v "$executable" >/dev/null || { echo "$executable is required" >&2; exit 2; }
done
git -C "$repository" rev-parse --git-dir >/dev/null
remote_url=$(git -C "$repository" remote get-url origin)
[[ $remote_url =~ ^(https://github\.com/|git@github\.com:) ]] || {
  echo 'origin must be a GitHub repository' >&2
  exit 2
}

install -d -m 0700 "$state_directory"
exec 9>"$state_directory/build.lock"
flock -n 9 || { echo 'An OpenCraft GitHub build is already running'; exit 0; }

echo "Fetching origin/$branch"
git -C "$repository" fetch --prune origin \
  "+refs/heads/$branch:refs/remotes/origin/$branch"
revision=$(git -C "$repository" rev-parse --verify "refs/remotes/origin/$branch^{commit}")
short_revision=${revision:0:12}
source_date_epoch=$(git -C "$repository" show -s --format=%ct "$revision")
immutable_tag="$image:git-$revision"
moving_tag="$image:main-local"
success_file="$state_directory/last-successful-revision"

if [[ -f $success_file && $(<"$success_file") == "$revision" ]] \
  && [[ $(docker image inspect "$immutable_tag" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true) == "$revision" ]]; then
  echo "OpenCraft $short_revision is already built"
  exit 0
fi

temporary=$(mktemp -d "$state_directory/build.XXXXXXXX")
checkout=$temporary/source
cleanup() {
  git -C "$repository" worktree remove --force "$checkout" >/dev/null 2>&1 || true
  git -C "$repository" worktree prune >/dev/null 2>&1 || true
  rmdir "$temporary" >/dev/null 2>&1 || true
}
trap cleanup EXIT
git -C "$repository" worktree add --detach "$checkout" "$revision"

echo "Building $immutable_tag from origin/$branch"
docker build --pull --target runtime \
  --build-arg "OPENCRAFT_BUILD_ID=git-$revision" \
  --build-arg "OPENCRAFT_SOURCE_REVISION=$revision" \
  --build-arg "SOURCE_DATE_EPOCH=$source_date_epoch" \
  --tag "$immutable_tag" --tag "$moving_tag" \
  --file "$checkout/docker/Dockerfile" "$checkout"

temporary_success="$state_directory/last-successful-revision.$$.tmp"
printf '%s\n' "$revision" >"$temporary_success"
chmod 0600 "$temporary_success"
mv "$temporary_success" "$success_file"
echo "Built $immutable_tag and advanced $moving_tag"
