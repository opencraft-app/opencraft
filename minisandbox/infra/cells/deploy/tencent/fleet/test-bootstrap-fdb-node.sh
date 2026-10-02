#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=bootstrap-fdb-node.sh
source "$script_dir/bootstrap-fdb-node.sh"

assert_eq() {
	[[ $1 == "$2" ]] || {
		echo "expected [$2], got [$1]" >&2
		exit 1
	}
}

single=$'vda|disk|53687091200|\nvdb|disk|214748364800|'
assert_eq "$(select_data_device_from_inventory "$single")" /dev/vdb

mounted=$'vda|disk|53687091200|/\nvdb|disk|214748364800|/data'
if select_data_device_from_inventory "$mounted" >/dev/null 2>&1; then
	echo "mounted candidate must be rejected" >&2
	exit 1
fi

ambiguous=$'vdb|disk|214748364800|\nvdc|disk|214748364800|'
if select_data_device_from_inventory "$ambiguous" >/dev/null 2>&1; then
	echo "ambiguous candidates must be rejected" >&2
	exit 1
fi

wrong_size=$'vdb|disk|107374182400|'
if select_data_device_from_inventory "$wrong_size" >/dev/null 2>&1; then
	echo "wrong-sized candidate must be rejected" >&2
	exit 1
fi

printf 'bootstrap selector tests passed\n'
