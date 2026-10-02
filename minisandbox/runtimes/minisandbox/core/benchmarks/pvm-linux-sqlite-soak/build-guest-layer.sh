#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly OUTPUT="${1:-${REPOSITORY}/target/pvm-linux/pvm-sqlite-soak-guest-stress.erofs}"
readonly LAYER_SOURCE="$(mktemp -d)"
trap 'rm -rf -- "${LAYER_SOURCE}"' EXIT

install -D -m 0644 \
    "${REPOSITORY}/guest/pvm-linux/python-warm.py" \
    "${LAYER_SOURCE}/opt/minisandbox/python-warm.py"
install -D -m 0644 \
    "${REPOSITORY}/guest/pvm-linux/block_stress.py" \
    "${LAYER_SOURCE}/opt/minisandbox/block_stress.py"
mkdir -p "$(dirname "${OUTPUT}")"
python3 "${REPOSITORY}/rootfs/build.py" app --all-root "${LAYER_SOURCE}" "${OUTPUT}"
