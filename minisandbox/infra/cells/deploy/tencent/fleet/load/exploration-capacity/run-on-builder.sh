#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && $1 =~ ^[a-f0-9]{32}$ ]] || { echo "usage: exploration-capacity/run-on-builder.sh RUN_ID" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$script_dir/../../operations/with-autonomy-operation-lock.sh" -- bash "$0" "$@"
fi
exec bash "$script_dir/../capacity-cycle/run-on-builder.sh" exploration "$1"
