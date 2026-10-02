#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib-tat.sh
source "$script_dir/lib-tat.sh"

detach=false
if [[ ${1:-} == --detach ]]; then
	detach=true
	shift
fi
[[ $# -eq 1 ]] || {
	echo "Usage: tat-invoke.sh [--detach] COMMAND_ID" >&2
	exit 2
}
command_id=$1
tat_initialize
invocation_id=$(tat_start_command "$command_id")
echo "tat: invocation=$invocation_id command=$command_id" >&2
if [[ $detach == true ]]; then
	printf '%s\n' "$invocation_id"
else
	tat_wait "$invocation_id"
fi
