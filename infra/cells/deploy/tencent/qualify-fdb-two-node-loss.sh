#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QUALIFY_FDB_FAIL_COUNT=2 exec "$script_dir/qualify-fdb-node-loss.sh"
