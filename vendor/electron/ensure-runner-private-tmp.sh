#!/usr/bin/env bash
# Run as a maintenance job on a dedicated systemd-hosted GitHub Actions runner.
set -euo pipefail

if [[ ${RUNNER_OS:-} != Linux || ${GITHUB_ACTIONS:-} != true ]]; then
  echo "Run the prepare-linux-runner workflow on the dedicated Linux Actions runner." >&2
  exit 1
fi
unit=$(systemctl whoami)
if [[ ! $unit =~ ^[A-Za-z0-9_.@:-]+\.service$ || ${unit,,} != *runner*.service ]]; then
  echo "The runner must be installed as its own system-level service." >&2
  exit 1
fi
# Confirm the job belongs to a runner worker in this service before editing it.
pid=$PPID
worker=
while (( pid > 1 )); do
  if [[ $(cat "/proc/$pid/comm") == Runner.Worker ]]; then worker=$pid; break; fi
  pid=$(awk '/^PPid:/ {print $2}' "/proc/$pid/status")
done
if [[ -z $worker || $(systemctl whoami "$worker") != "$unit" ]]; then
  echo "Cannot identify the current Actions worker in the runner unit." >&2
  exit 1
fi

setting=$(systemctl show "$unit" --property=PrivateTmp --value)
if [[ $setting == yes || $setting == true || $setting == disconnected ]]; then
  if probe=$(mktemp /tmp/opencraft-runner.XXXXXXXX); then
    rm -- "$probe"
    echo "PrivateTmp is active and /tmp is writable."
    exit 0
  fi
fi
source_conf="$(dirname "$0")/systemd/80-opencraft-private-tmp.conf"
dropin="/etc/systemd/system/$unit.d/80-opencraft-private-tmp.conf"
if ! cmp -s "$source_conf" "$dropin"; then
  sudo -n install -D -m 0644 "$source_conf" "$dropin"
fi
sudo -n systemctl daemon-reload
case "$(systemctl show "$unit" --property=PrivateTmp --value)" in
  yes|true|disconnected) ;;
  *) echo "Another service setting overrides PrivateTmp." >&2; exit 1 ;;
esac

# Run outside the runner cgroup. Wait for job cleanup and defer while any
# Actions worker is active. The transient unit is collected after completion.
sudo -n systemd-run --quiet --collect --property=RuntimeMaxSec=15min \
  /bin/sh -ec '
    while pgrep -x Runner.Worker >/dev/null; do sleep 2; done
    systemctl try-restart "$1"
  ' sh "$unit"
echo "PrivateTmp configured. The idle service will restart after this job exits."
