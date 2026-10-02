#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib-tat.sh
source "$script_dir/lib-tat.sh"

command_name=actor-fleet-command
timeout_seconds=3600
command_file=
detach=false

usage() {
	cat <<'EOF'
Usage: tat-run.sh [--detach] [--name NAME] [--timeout SECONDS] [--file PATH]

Reads a shell program from --file or stdin, runs it through Tencent TAT on the
single instance selected by TAT_INSTANCE_ID, streams the final output, and
returns failure unless TaskStatus is SUCCESS with exit code zero.

With --detach, prints the immutable invocation ID and returns immediately.
Resume the same command with tat-wait.sh; never submit a duplicate merely
because the original client disconnected.
EOF
}

while (($#)); do
	case "$1" in
	--name)
		command_name=$2
		shift 2
		;;
	--timeout)
		timeout_seconds=$2
		shift 2
		;;
	--file)
		command_file=$2
		shift 2
		;;
	--detach)
		detach=true
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

tat_initialize
if [[ -n $command_file ]]; then
	payload=$(<"$command_file")
else
	payload=$(cat)
fi
[[ -n $payload ]] || tat_die "command payload is empty"
if [[ $detach == true ]]; then
	invocation_id=$(tat_start "$command_name" "$timeout_seconds" "$payload")
	echo "tat: invocation=$invocation_id detached=true" >&2
	printf '%s\n' "$invocation_id"
else
	tat_run_and_wait "$command_name" "$timeout_seconds" "$payload"
fi
