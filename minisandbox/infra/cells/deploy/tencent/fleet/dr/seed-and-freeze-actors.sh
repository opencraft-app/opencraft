#!/usr/bin/env bash
set -euo pipefail

namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell=$RIVET_CELL_NAME
kubeconfig=${KUBECONFIG:-/root/.kube/${cell}.kubeconfig}
qualification_worker=${DR_WORKER:-${cell##*-}-dr-physical-restore}
qualifier=${QUALIFIER:?QUALIFIER must point to qualify_workerd_density.py}
receipt=${DR_SEED_RECEIPT:?DR_SEED_RECEIPT is required}
cold_state_timeout_seconds=${DR_COLD_STATE_TIMEOUT_SECONDS:-3600}
[[ $cold_state_timeout_seconds =~ ^[0-9]+$ ]] && \
	((cold_state_timeout_seconds >= 600 && cold_state_timeout_seconds <= 7200)) || {
	echo "DR_COLD_STATE_TIMEOUT_SECONDS must be an integer from 600 through 7200" >&2
	exit 2
}
mkdir -p /data/tmp
temporary=$(mktemp -d "/data/tmp/${cell}-dr-seed.XXXXXX")
forward_pids=()
cleanup() {
	if ((${#forward_pids[@]})); then
		kill "${forward_pids[@]}" 2>/dev/null || true
		wait "${forward_pids[@]}" 2>/dev/null || true
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

kubectl --kubeconfig "$kubeconfig" -n "$namespace" get secret "${cell}-runtime-auth" \
	-o jsonpath='{.data.token}' | base64 --decode >"$temporary/token"
export ACTOR_RUNTIME_TOKEN
ACTOR_RUNTIME_TOKEN=$(<"$temporary/token")

kubectl --kubeconfig "$kubeconfig" -n "$namespace" port-forward \
	service/"${cell}-engine" 16420:6420 16421:6421 >"$temporary/engine.log" 2>&1 &
forward_pids+=("$!")
kubectl --kubeconfig "$kubeconfig" -n "$namespace" port-forward \
	service/"${cell}-workers-api" 16422:8080 >"$temporary/workers-api.log" 2>&1 &
forward_pids+=("$!")
for ordinal in 0 1 2; do
	port=$((28081 + ordinal))
	kubectl --kubeconfig "$kubeconfig" -n "$namespace" port-forward \
		pod/"${cell}-runtime-hosts-${ordinal}" "${port}:18081" \
		>"$temporary/host-${ordinal}.log" 2>&1 &
	forward_pids+=("$!")
done

for attempt in $(seq 1 60); do
	if curl -fsS http://127.0.0.1:16421/health >/dev/null 2>&1 && \
		curl -fsS http://127.0.0.1:16422/readyz >/dev/null 2>&1 && \
		curl -fsS -H "x-rivet-workerd-token: $ACTOR_RUNTIME_TOKEN" \
			http://127.0.0.1:28081/v1/sqlite/stats >/dev/null 2>&1 && \
		curl -fsS -H "x-rivet-workerd-token: $ACTOR_RUNTIME_TOKEN" \
			http://127.0.0.1:28082/v1/sqlite/stats >/dev/null 2>&1 && \
		curl -fsS -H "x-rivet-workerd-token: $ACTOR_RUNTIME_TOKEN" \
			http://127.0.0.1:28083/v1/sqlite/stats >/dev/null 2>&1; then
		break
	fi
	if [[ $attempt -eq 60 ]]; then
		echo "runtime port-forwards did not become ready" >&2
		exit 1
	fi
	sleep 1
done

python3 "$qualifier" \
	--engine-url http://127.0.0.1:16420 \
	--workers-api-url http://127.0.0.1:16422 \
	--public-worker "$qualification_worker" \
	--public-class-name Agent \
	--depot-inspect-url http://127.0.0.1:16421 \
	--runner-name workerd \
	--actors 12 \
	--concurrency 12 \
	--increments-per-actor 3 \
	--request-timeout-seconds 40 \
	--require-cold-before-wake \
	--cold-state-timeout-seconds "$cold_state_timeout_seconds" \
	--cold-state-poll-seconds 1 \
	--bottomless-actor-count 1 \
	--bottomless-bytes-per-actor 12582912 \
	--max-cold-wake-p95-ms 10000 \
	--max-cold-wake-p99-ms 20000 \
	--max-cold-wake-ms 30000 \
	--host-stats 'host-0=http://127.0.0.1:28081/v1/sqlite/stats,ACTOR_RUNTIME_TOKEN' \
	--host-stats 'host-1=http://127.0.0.1:28082/v1/sqlite/stats,ACTOR_RUNTIME_TOKEN' \
	--host-stats 'host-2=http://127.0.0.1:28083/v1/sqlite/stats,ACTOR_RUNTIME_TOKEN' \
	--min-active-hosts 3 \
	--prove-sleep \
	--wake-after-sleep \
	--quiescence-timeout-seconds 120 \
	--keep-actors \
	--output "$receipt" >"$temporary/qualifier.log"

# Leave every retained Actor asleep and cold. The extra checkpoint captures the
# exact checksum/watermark that the isolated restore must reproduce.
python3 - "$receipt" "$cold_state_timeout_seconds" <<'PY'
import json
import os
import sys
import time
import urllib.parse
import urllib.request

path = sys.argv[1]
cold_state_timeout_seconds = int(sys.argv[2])
receipt = json.load(open(path))
bucket = receipt["bottomless"]["namespace_id"]

def request(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=40) as response:
        return json.loads(response.read())

freeze = {}
policy_actors = []
policy_clear_errors = []
try:
    # The generic qualifier correctly removes its temporary policy before it
    # returns.  Install a new, workflow-owned override for this second freeze;
    # otherwise Depot's seven-day default cache retention can never satisfy a
    # one-hour DR qualification deadline.  The production policy is unchanged.
    for record in receipt["actor_records"]:
        actor = record["actor_id"]
        encoded_bucket = urllib.parse.quote(bucket, safe="")
        encoded = urllib.parse.quote(actor, safe="")
        # Register cleanup before PUT: a lost success response must still lead
        # to an idempotent DELETE attempt in the finally block.
        policy_actors.append(actor)
        policy = request(
            "PUT",
            "http://127.0.0.1:16421/depot/qualification/buckets/{}/databases/{}/shard-cache-policy".format(
                encoded_bucket, encoded
            ),
            {"retention_ms": 1},
        )
        if policy.get("retention_ms") != 1:
            raise RuntimeError("final freeze cache policy was not accepted")
        request("POST", "http://127.0.0.1:16420/actors/{}/sleep?namespace=default".format(encoded), {})
        checkpoint = request(
            "POST",
            "http://127.0.0.1:16421/depot/checkpoints/buckets/{}/databases/{}".format(
                encoded_bucket, encoded
            ),
            {"force_reclaim": True},
        )
        freeze[actor] = {"checkpoint": checkpoint}

    deadline = time.time() + cold_state_timeout_seconds
    started = time.time()
    next_progress_write = started
    pending = set(freeze)
    while pending and time.time() < deadline:
        for actor in list(pending):
            state = request(
                "GET",
                "http://127.0.0.1:16421/depot/inspect/buckets/{}/databases/{}/bottomless-state".format(
                    urllib.parse.quote(bucket, safe=""), urllib.parse.quote(actor, safe="")
                ),
            )
            freeze[actor]["bottomless_state"] = state
            if state.get("cold_ready") is True and state.get("row_counts", {}).get("hot_shards", {}).get("count") == 0:
                pending.remove(actor)
        if pending:
            now = time.time()
            if now >= next_progress_write:
                states = [item.get("bottomless_state", {}) for item in freeze.values()]
                receipt["dr_seed_progress"] = {
                    "stage": "waiting_for_final_freeze_cold_state",
                    "actor_count": len(freeze),
                    "pending_actors": len(pending),
                    "cold_ready_actors": sum(state.get("cold_ready") is True for state in states),
                    "hot_shards": sum(int(state.get("row_counts", {}).get("hot_shards", {}).get("count", 0)) for state in states),
                    "cold_shards": sum(int(state.get("row_counts", {}).get("cold_shards", {}).get("count", 0)) for state in states),
                    "elapsed_ms": int((now - started) * 1000),
                }
                temporary = path + ".tmp"
                with open(temporary, "w") as output:
                    json.dump(receipt, output, indent=2, sort_keys=True)
                    output.write("\n")
                os.replace(temporary, path)
                next_progress_write = now + 30
            time.sleep(1)
    if pending:
        raise RuntimeError("retained Agents did not become cold: {}".format(sorted(pending)))
finally:
    for actor in policy_actors:
        try:
            request(
                "DELETE",
                "http://127.0.0.1:16421/depot/qualification/buckets/{}/databases/{}/shard-cache-policy".format(
                    urllib.parse.quote(bucket, safe=""), urllib.parse.quote(actor, safe="")
                ),
            )
        except Exception as error:
            policy_clear_errors.append("{}: {}".format(actor, error))
if policy_clear_errors:
    raise RuntimeError("final freeze cache policy cleanup failed: {}".format(policy_clear_errors))

receipt.pop("dr_seed_progress", None)
receipt["dr_seed"] = {
    "actors_retained_asleep": True,
    "temporary_shard_cache_policy": {"retention_ms": 1, "cleared": True},
    "freeze_finished_at_unix_ms": int(time.time() * 1000),
    "freeze": freeze,
}
temporary = path + ".tmp"
with open(temporary, "w") as output:
    json.dump(receipt, output, indent=2, sort_keys=True)
    output.write("\n")
os.replace(temporary, path)
PY

source_pod=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get pod \
	-l "foundationdb.org/fdb-cluster-name=${cell}" -o jsonpath='{.items[0].metadata.name}')
source_version=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" exec "$source_pod" \
	-c foundationdb -- fdbcli -C /var/fdb/data/fdb.cluster --exec getversion | \
	tr -d '\r' | tail -n 1)
[[ $source_version =~ ^[0-9]+$ ]]
python3 - "$receipt" "$source_version" <<'PY'
import json, os, sys
path, version = sys.argv[1], int(sys.argv[2])
receipt = json.load(open(path))
receipt["dr_seed"]["source_fdb_read_version_after_freeze"] = version
temporary = path + ".tmp"
with open(temporary, "w") as output:
    json.dump(receipt, output, indent=2, sort_keys=True)
    output.write("\n")
os.replace(temporary, path)
print(json.dumps({
    "verdict": receipt.get("verdict"),
    "actors": len(receipt["actor_records"]),
    "actor_manifest_sha256": receipt["actor_manifest_sha256"],
    "source_fdb_read_version_after_freeze": version,
}, sort_keys=True))
PY
