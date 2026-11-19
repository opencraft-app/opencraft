#!/usr/bin/env bash
# Linux x64 Docker runner. Consume the directory handed off by the native runner.
set -Eeuo pipefail
[[ $# == 1 ]] || { echo 'Usage: .ci/build-hands-image.sh ARTIFACT_DIRECTORY' >&2; exit 2; }
artifact=$(realpath -- "$1")
cd "$(git rev-parse --show-toplevel)"
mkdir -p .local/ci
stage=$(mktemp -d "$PWD/.local/ci/browser.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
(
  cd "$artifact"
  read -r digest filename < browser-linux-x64.tar.gz.sha256
  [[ "$digest" =~ ^[0-9a-f]{64}$ && "$filename" == browser-linux-x64.tar.gz ]]
  printf '%s  %s\n' "$digest" "$filename" | sha256sum --check --strict -
)
python3 - "$artifact/browser-linux-x64.tar.gz" "$stage" <<'PY'
import sys
import tarfile
from pathlib import Path, PurePosixPath
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isdir() or member.isfile()):
            raise ValueError(f'Unexpected browser archive entry: {member.name}')
        archive.extract(member, sys.argv[2], set_attrs=False)
        if member.isfile():
            (Path(sys.argv[2]) / path).chmod(member.mode & 0o755)
PY
OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION="$stage" bash scripts/ci/build-image.sh hands
