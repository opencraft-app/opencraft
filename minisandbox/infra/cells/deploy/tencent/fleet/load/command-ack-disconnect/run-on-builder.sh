#!/usr/bin/env bash
set -euo pipefail
umask 077

run_id=${1:?usage: run-on-builder.sh RUN_ID}
[[ $run_id =~ ^[a-f0-9]{32}$ ]] || {
	echo "run ID must be 32 lowercase hexadecimal characters" >&2
	exit 2
}

source_root=$(readlink -e "${ACTOR_REVIEWED_SOURCE:?ACTOR_REVIEWED_SOURCE must name the immutable reviewed source}")
[[ $source_root =~ ^/var/lib/actor-build/deploy/q01-src-[a-f0-9]{40}-[a-f0-9]{64}$ ]] || {
	echo "ACTOR_REVIEWED_SOURCE must resolve to an immutable q01 source tree" >&2
	exit 2
}
base=${ACTOR_BOOTSTRAP_ROOT:-/data/actor-bootstrap/beijing-rebuild-20260915}
runner=$source_root/infra/cells/deploy/tencent/fleet/load/command-ack-disconnect/qualify.py
endpoint_receipt=$base/receipts/workers-api/endpoint-installation.json
hub_kubeconfig=$base/input/management.kubeconfig
cell_kubeconfig=$base/cells/actor-bj-b01/cell.kubeconfig
out=$base/load-tests/command-ack-disconnect-$run_id
lock=$base/load-tests/command-ack-disconnect.lock

for input in "$runner" "$endpoint_receipt" "$hub_kubeconfig" "$cell_kubeconfig"; do
	test -f "$input"
done
test ! -e "$out"
exec 9>"$lock"
flock -n 9 || { echo "another command ACK disconnect qualification is running" >&2; exit 75; }

endpoint=$(jq -er '.endpoint' "$endpoint_receipt")
[[ $endpoint == http://* || $endpoint == https://* ]]
install -d -m 0700 "$out"

MINISANDBOX_REPO=$source_root python3.11 "$runner" \
	--endpoint "$endpoint" --registry-service worker-registry \
	--hub-kubeconfig "$hub_kubeconfig" --cell-kubeconfig "$cell_kubeconfig" \
	--cell actor-bj-b01 --all-cell actor-bj-a01 --all-cell actor-bj-b01 \
	--worker command-ack-disconnect-qualification --run-id "$run_id" \
	--receipt "$out/receipt.json" >"$out/run.log" 2>&1

test -s "$out/receipt.json"
sha256=$(sha256sum "$out/receipt.json" | cut -d' ' -f1)
printf 'command_ack_disconnect=passed run_id=%s receipt=%s sha256=%s\n' \
	"$run_id" "$out/receipt.json" "$sha256"
