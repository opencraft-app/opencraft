#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 ]] || { echo "Usage: install-coscli-via-relay.sh LOCAL_COSCLI" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
local_binary=$(readlink -e "$1")
expected_sha=a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915
[[ -f $local_binary && ! -L $local_binary ]] || { echo "local COSCLI is not a regular file" >&2; exit 2; }
printf '%s  %s\n' "$expected_sha" "$local_binary" | sha256sum -c - >/dev/null
[[ $($local_binary --version) == "coscli version v1.0.9" ]] || { echo "local COSCLI version differs" >&2; exit 2; }

remote=/data/actor-build/incoming/coscli-v1.0.9-${expected_sha:0:16}
"$script_dir/relay-upload-to-builder.sh" "$local_binary" "$remote"

printf -v quoted_remote '%q' "$remote"
"$script_dir/../../tat/tat-run.sh" --name q01-install-coscli-relay --timeout 300 <<REMOTE
set -euo pipefail
source_root=\$(readlink -e /var/lib/actor-build/deploy/actor-bj-q01-current)
COSCLI_SOURCE=$quoted_remote COSCLI_INSTALL_ROOT=/data/build-cache/coscli \
  "\$source_root/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/install-coscli.sh"
REMOTE
