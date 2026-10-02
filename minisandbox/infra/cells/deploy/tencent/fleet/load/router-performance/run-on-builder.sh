#!/usr/bin/env bash
set -euo pipefail
umask 077

capacity_run_id=${1:?usage: run-on-builder.sh CAPACITY_RUN_ID PERFORMANCE_RUN_ID}
performance_run_id=${2:?usage: run-on-builder.sh CAPACITY_RUN_ID PERFORMANCE_RUN_ID}
[[ $capacity_run_id =~ ^[a-f0-9]{32}$ && $performance_run_id =~ ^[a-f0-9]{32}$ ]] || {
	echo "run IDs must each be 32 lowercase hexadecimal characters" >&2
	exit 2
}

source_root=$(readlink -e "${ACTOR_REVIEWED_SOURCE:?ACTOR_REVIEWED_SOURCE must name the immutable reviewed source}")
[[ $source_root =~ ^/var/lib/actor-build/deploy/q01-src-[a-f0-9]{40}-[a-f0-9]{64}$ ]] || {
	echo "ACTOR_REVIEWED_SOURCE must resolve to an immutable q01 source tree" >&2
	exit 2
}
base=${ACTOR_BOOTSTRAP_ROOT:-/data/actor-bootstrap/beijing-rebuild-20260915}
runner=$source_root/infra/cells/deploy/tencent/fleet/load/router-performance/run.py
collector=$source_root/infra/cells/deploy/tencent/fleet/load/router-performance/capture.py
capacity_receipt=$base/load-tests/ten-thousand-active-$capacity_run_id/receipt.json
endpoint_receipt=$base/receipts/workers-api/endpoint-installation.json
kubeconfig=$base/input/management.kubeconfig
out=$base/load-tests/router-performance-$performance_run_id
lock=$base/load-tests/router-performance.lock

for input in "$runner" "$collector" "$capacity_receipt" "$endpoint_receipt" "$kubeconfig"; do
	test -f "$input"
done
test ! -e "$out"
exec 9>"$lock"
flock -n 9 || { echo "another Router performance qualification is running" >&2; exit 75; }

# Reject a stale, partial, or failed capacity result before publishing temporary
# Worker/Object resources. capture.py repeats this validation when it binds the
# final receipt, so a file replacement between the two checks still fails closed.
python3.11 - "$capacity_receipt" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
if (value.get("schema") != "actor-ten-thousand-active-qualification/v1"
        or value.get("verdict") != "passed"
        or value.get("expected", {}).get("active", 0) < 10_000
        or not value.get("checks")
        or not all(value["checks"].values())):
    raise SystemExit("capacity receipt does not prove the complete 10k active cycle")
PY

endpoint=$(jq -er '.endpoint' "$endpoint_receipt")/v1
[[ $endpoint == http://*/v1 || $endpoint == https://*/v1 ]]
registry_endpoint=$(kubectl --kubeconfig "$kubeconfig" -n workers-api-system \
	get configmap workers-api -o jsonpath='{.data.registry-url}')
[[ $registry_endpoint == http://* || $registry_endpoint == https://* ]]
install -d -m 0700 "$out"

python3.11 "$runner" \
	--endpoint "$endpoint" --registry-endpoint "$registry_endpoint" \
	--hub-kubeconfig "$kubeconfig" \
	--cell actor-bj-a01 --cell actor-bj-b01 \
	--worker "router-perf-${performance_run_id:0:16}" \
	--duration-seconds 300 --rate 40 --objects 256 --concurrency 64 \
	--run-id "$performance_run_id" --receipt "$out/load-receipt.json" \
	>"$out/load.log" 2>&1

python3.11 "$collector" \
	--load-receipt "$out/load-receipt.json" \
	--qualification-receipt "$capacity_receipt" \
	--kubeconfig "$kubeconfig" --output-directory "$out/evidence" \
	>"$out/capture.log" 2>&1

test -s "$out/evidence/receipt.json"
sha256=$(sha256sum "$out/evidence/receipt.json" | cut -d' ' -f1)
printf 'router_performance=passed capacity_run_id=%s performance_run_id=%s receipt=%s sha256=%s\n' \
	"$capacity_run_id" "$performance_run_id" "$out/evidence/receipt.json" "$sha256"
