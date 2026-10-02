#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly SOURCE="${1:-${REPOSITORY}/target/pvm-linux/debian-trixie-20260713-x86_64.erofs}"
readonly OUTPUT="${2:-${REPOSITORY}/target/pvm-linux/debian-layered-init-x86_64.erofs}"
readonly FSCK_EROFS="${REPOSITORY}/target/pvm-linux/erofs-utils-build/fsck/fsck.erofs"
readonly STAGE="$(mktemp -d -p "${REPOSITORY}/target/pvm-linux" .layered-base.XXXXXXXX)"
trap 'rm -rf -- "${STAGE}"' EXIT

[[ -f "${SOURCE}" ]] || {
    echo "missing base EROFS: ${SOURCE}" >&2
    exit 1
}
python3 -c \
    'import runpy, sys; runpy.run_path(sys.argv[1])["ensure_erofs_tools"]()' \
    "${REPOSITORY}/rootfs/build.py"
[[ -x "${FSCK_EROFS}" ]] || {
    echo "missing fsck.erofs: ${FSCK_EROFS}" >&2
    exit 1
}

cd "${REPOSITORY}"
cargo build --locked --release \
    --target x86_64-unknown-linux-musl \
    --package minisandbox-init \
    --bin minisandbox-init
readonly INIT="${REPOSITORY}/target/x86_64-unknown-linux-musl/release/minisandbox-init"

"${FSCK_EROFS}" --xattrs --extract="${STAGE}" "${SOURCE}"
install -m 0755 "${INIT}" "${STAGE}/sbin/minisandbox-init"
mkdir -p "$(dirname "${OUTPUT}")"
python3 "${REPOSITORY}/rootfs/build.py" dir "${STAGE}" "${OUTPUT}"
