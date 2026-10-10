#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || { echo "usage: run-on-builder.sh RUN_ID" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bash "$script_dir/../capacity-cycle/run-on-builder.sh" production "$1"
