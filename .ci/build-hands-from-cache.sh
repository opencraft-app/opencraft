#!/usr/bin/env bash
# Reuse a prepared Chromium checkout whose out/ symlink points into a shared checkout.
set -Eeuo pipefail
if [[ $# != 4 ]]; then
  echo 'Usage: .ci/build-hands-from-cache.sh GCLIENT_ROOT SHARED_ROOT OVERLAY_STATE NEW_ARTIFACT_DIRECTORY' >&2
  exit 2
fi
base=$(realpath -e -- "$1")
shared=$(realpath -e -- "$2")
state=$(realpath -m -- "$3")
output=$(realpath -m -- "$4")
entry=$(realpath -- "$(dirname "$0")/build-hands-electron.sh")
[[ -d "$base/src/electron" && -L "$base/src/out" && -d "$shared/src/out/OpenCraft" &&
   "$(realpath -e -- "$base/src/out")" == "$shared/src/out" ]] || {
  echo 'Expected the prepared checkout to link out/ to SHARED_ROOT/src/out' >&2; exit 1;
}
for parent in "$base" "$shared" "$state"; do
  [[ "$parent" != / && "$output/" != "$parent/"* && "$entry" != "$parent/"* ]] || {
    echo 'Keep the fork checkout and artifact destination outside the cache roots' >&2; exit 1;
  }
  for child in "$base" "$shared" "$state"; do
    [[ "$child" == "$parent" || "$child/" != "$parent/"* ]] || {
      echo 'Cache roots must be separate directories' >&2; exit 1;
    }
  done
done
[[ "$base" != "$shared" && "$state" != "$base" && "$state" != "$shared" ]]
mkdir -p "$state"
exec 8>"$state/build.lock"
flock -n 8 || { echo "Overlay state is in use: $state" >&2; exit 1; }
# Keep the original absolute source and output paths in Ninja's cached commands.
unshare --mount --propagation private bash -seu -- "$base" "$shared" "$state" "$entry" "$output" <<'NAMESPACE'
base=$1 shared=$2 state=$3
mkdir -p "$state"/{lower,upper,overlay-work,source/src,obj-lower,obj-upper,obj-work,obj-merged}
mount --bind "$shared" "$shared"
mount -o remount,bind,ro "$shared"
mount --bind "$base/src" "$state/lower"
mount -o remount,bind,ro "$state/lower"
mount -t overlay overlay -o "lowerdir=$state/lower,upperdir=$state/upper,workdir=$state/overlay-work" "$state/source/src"
cache="$shared/src/out/OpenCraft"
mount --bind "$cache" "$state/obj-lower"
mount -o remount,bind,ro "$state/obj-lower"
mount -t overlay overlay -o "lowerdir=$state/obj-lower,upperdir=$state/obj-upper,workdir=$state/obj-work" "$state/obj-merged"
mount --bind "$state/obj-merged" "$cache"
mount --rbind "$state/source" "$base"
exec "$4" "$base" "$5" --prepared
NAMESPACE
