#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 && ${ALLOW_NON_ROOT_FOR_TESTS:-0} != 1 ]]; then
	echo "reset-workerd-volatile-state.sh must run as root" >&2
	exit 1
fi

systemctl_bin=${SYSTEMCTL_BIN:-systemctl}
run_root=${RUN_ROOT:-/run}
workerd_unit=actor-workerd.service
host_unit=actor-rivet-workerd-host.service

runtime_directory() {
	"$systemctl_bin" show "$1" -p RuntimeDirectory --value
}

workerd_runtime=$(runtime_directory "$workerd_unit")
host_runtime=$(runtime_directory "$host_unit")
[[ $workerd_runtime == actor-workerd ]] || {
	echo "refusing unexpected RuntimeDirectory for $workerd_unit: $workerd_runtime" >&2
	exit 1
}
[[ $host_runtime == actor-rivet-workerd-host ]] || {
	echo "refusing unexpected RuntimeDirectory for $host_unit: $host_runtime" >&2
	exit 1
}

"$systemctl_bin" stop "$host_unit" "$workerd_unit"

for name in "$host_runtime" "$workerd_runtime"; do
	path="$run_root/$name"
	if [[ -d $path ]]; then
		find "$path" -xdev -mindepth 1 -delete
	elif [[ -e $path ]]; then
		echo "refusing non-directory volatile-state path: $path" >&2
		exit 1
	fi
	# A missing path is expected when systemd removed RuntimeDirectory on stop.
done

"$systemctl_bin" start "$workerd_unit"
"$systemctl_bin" start "$host_unit"
"$systemctl_bin" is-active --quiet "$workerd_unit" "$host_unit"
