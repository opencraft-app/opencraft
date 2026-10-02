#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib-tat.sh
source "$script_dir/lib-tat.sh"

usage() {
	cat <<'EOF'
Usage: tat-wait.sh INVOCATION_ID

Resumes polling an existing Tencent TAT invocation. Completion is determined
from terminal TaskStatus and the command exit code, never ExitCode alone.
EOF
}

if [[ $# -eq 1 && ($1 == -h || $1 == --help) ]]; then
	usage
	exit 0
fi
[[ $# -eq 1 ]] || {
	usage >&2
	exit 2
}
invocation_id=$1
[[ $invocation_id =~ ^inv-[A-Za-z0-9-]+$ ]] || tat_die "invalid TAT invocation id"

tat_initialize
tat_wait "$invocation_id"
