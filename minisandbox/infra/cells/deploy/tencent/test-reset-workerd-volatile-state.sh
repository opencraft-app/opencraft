#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture_root=$(mktemp -d)
trap 'rm -rf -- "$fixture_root"' EXIT INT TERM

mock="$fixture_root/systemctl"
log="$fixture_root/systemctl.log"
cat >"$mock" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
if [[ $1 == show ]]; then
	case "$2" in
		actor-workerd.service) printf '%s\n' "${MOCK_WORKERD_RUNTIME:-actor-workerd}" ;;
		actor-rivet-workerd-host.service) printf '%s\n' "${MOCK_HOST_RUNTIME:-actor-rivet-workerd-host}" ;;
		*) exit 2 ;;
	esac
fi
MOCK
chmod 0755 "$mock"

mkdir -p "$fixture_root/run/actor-workerd" "$fixture_root/run/actor-rivet-workerd-host"
printf 'volatile\n' >"$fixture_root/run/actor-workerd/sqlite.sock"
printf 'volatile\n' >"$fixture_root/run/actor-rivet-workerd-host/owner.json"

ALLOW_NON_ROOT_FOR_TESTS=1 SYSTEMCTL_BIN="$mock" SYSTEMCTL_LOG="$log" \
	RUN_ROOT="$fixture_root/run" "$script_dir/reset-workerd-volatile-state.sh"
test -z "$(find "$fixture_root/run/actor-workerd" -mindepth 1 -print -quit)"
test -z "$(find "$fixture_root/run/actor-rivet-workerd-host" -mindepth 1 -print -quit)"

# systemd normally removes these roots itself. Absence must remain successful.
rm -rf "$fixture_root/run/actor-workerd" "$fixture_root/run/actor-rivet-workerd-host"
ALLOW_NON_ROOT_FOR_TESTS=1 SYSTEMCTL_BIN="$mock" SYSTEMCTL_LOG="$log" \
	RUN_ROOT="$fixture_root/run" "$script_dir/reset-workerd-volatile-state.sh"

if ALLOW_NON_ROOT_FOR_TESTS=1 SYSTEMCTL_BIN="$mock" SYSTEMCTL_LOG="$log" \
	MOCK_WORKERD_RUNTIME=../../unsafe RUN_ROOT="$fixture_root/run" \
	"$script_dir/reset-workerd-volatile-state.sh" >/dev/null 2>&1; then
	echo "volatile-state reset accepted an unsafe RuntimeDirectory" >&2
	exit 1
fi

grep -q '^stop actor-rivet-workerd-host.service actor-workerd.service$' "$log"
grep -q '^start actor-workerd.service$' "$log"
grep -q '^start actor-rivet-workerd-host.service$' "$log"
echo "volatile-state reset tests passed"
