#!/usr/bin/env bash
# Linux x64 native runner. The work directory persists across CI jobs.
set -Eeuo pipefail
if [[ $# != 2 && $# != 3 ]] || [[ $# == 3 && $3 != --prepared ]]; then
  echo 'Usage: .ci/build-hands-electron.sh WORK_DIRECTORY NEW_ARTIFACT_DIRECTORY [--prepared]' >&2
  exit 2
fi
work=$(realpath -m -- "$1")
output=$(realpath -m -- "$2")
[[ ! -e "$output" ]] || { echo "Artifact directory already exists: $output" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
[[ -z "$(git status --porcelain)" ]] || { echo 'A clean fork checkout is required' >&2; exit 1; }
source_dir="$PWD"
node scripts/ci/source-identity.mjs >/dev/null
tools="$source_dir/vendor/electron"
mkdir -p "$work" "$(dirname "$output")"
exec 9>"$work/.join-hands-build.lock"
flock -n 9 || { echo "Another build owns $work" >&2; exit 1; }
python3 "$tools/ci.py" platform --target linux-x64
fork=$(sha256sum "$tools/fork.json" | cut -d' ' -f1)
if [[ ${3:-} != --prepared && "$(cat "$work/.join-synced-fork" 2>/dev/null || true)" != "$fork" ]]; then
  python3 "$tools/ci.py" preflight --target linux-x64 --root "$work"
  python3 "$tools/manage.py" checkout --root "$work"
  python3 "$tools/manage.py" sync --root "$work"
  printf '%s\n' "$fork" > "$work/.join-synced-fork"
fi
stage=$(mktemp -d -- "${output}.tmp.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
node scripts/ci/source-identity.mjs > "$stage/fork-source.json"
python3 "$tools/manage.py" verify --root "$work" > "$stage/source-verification.json"

# Chromium ships its own protobuf. Keep the runner's Python packages out of code generation.
unset PYTHONPATH PYTHONHOME
python3 -m venv --without-pip "$work/.join-python"
export JOIN_HANDS_GN_ROOT="$work/src"
mkdir -p "$work/.join-tools"
cat > "$work/.join-tools/gn" <<'GN'
#!/bin/sh
exec "$JOIN_HANDS_GN_ROOT/buildtools/linux64/gn" "--root=$JOIN_HANDS_GN_ROOT" "$@"
GN
chmod +x "$work/.join-tools/gn"
export PATH="$work/.join-tools:$work/.join-python/bin:$work/src/third_party/ninja:$PATH"
# Node's nested GN call must use the same source root even when out/ is a symlink.
mkdir -p "$work/src/out/OpenCraft"
(
  cd -P "$work/src/out/OpenCraft"
  gn gen . "--args=$(cat "$tools/args.gn")"
  ninja -j "${JOIN_ELECTRON_JOBS:-$(nproc)}" electron electron:electron_dist_zip
)
python3 - "$tools" "$work/src/out/OpenCraft/dist.zip" "$stage/browser" <<'PY'
from pathlib import Path
import runpy
import sys
tools, archive, destination = map(Path, sys.argv[1:])
runpy.run_path(str(tools / 'prepare-desktop-artifact.py'))['extract_archive'](archive, destination)
PY
python3 "$tools/prepare-artifact.py" --strip-unneeded --source-root "$work" \
  --distribution "$stage/browser" --evidence "$stage/evidence"
node "$source_dir/scripts/remote-browser-artifact.mjs" "$stage/browser" "$tools/fork.json"
(
  cd "$stage"
  tar -C browser -czf browser-linux-x64.tar.gz .
  sha256sum browser-linux-x64.tar.gz > browser-linux-x64.tar.gz.sha256
  rm -rf browser
)
node scripts/ci/source-identity.mjs --check "$stage/fork-source.json"
# Both the archive and its checksum become visible together.
mv -T --no-clobber "$stage" "$output"
[[ ! -e "$stage" ]] || { echo "Artifact directory already published: $output" >&2; exit 1; }
echo "Hands Electron artifact: $output"
