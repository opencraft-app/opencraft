#!/usr/bin/env bash
set -euo pipefail

workers_url=${WORKERS_URL:-http://actor-bj-k01-workers-api:8080}
run_id=${RUN_ID:-manual}
request_count=${REQUEST_COUNT:-1500}
request_concurrency=${REQUEST_CONCURRENCY:-10}
request_interval_seconds=${REQUEST_INTERVAL_SECONDS:-0.02}
request_timeout_seconds=${REQUEST_TIMEOUT_SECONDS:-3}
temporary=${TMPDIR:-/data/tmp}/engine-ha-probe-$$
class_name=Agent
worker_name=${WORKER_NAME:-q01-engine-ha-gate}
object_id=
object_ids=()
version_id=
deployment_id=

mkdir -p "$temporary"
object_path() {
	printf '%s/v1/workers/%s/objects/%s/%s' \
		"$workers_url" "$worker_name" "$class_name" "$1"
}
delete_object() {
	local object=$1 attempt code
	for attempt in $(seq 1 5); do
		code=$(curl --silent --show-error --max-time 30 -o /dev/null -w '%{http_code}' \
			-X DELETE "$(object_path "$object")" || true)
		if [[ $code == 204 || $code == 404 ]]; then
			return 0
		fi
		sleep "$attempt"
	done
	return 1
}
delete_objects() {
	local index pid status failures=0
	local -a delete_pids=()
	for index in "${!object_ids[@]}"; do
		(
			if delete_object "${object_ids[index]}"; then printf '0\n'; else printf '1\n'; fi
		) >"$temporary/delete-$index.status" &
		delete_pids+=("$!")
	done
	for pid in "${delete_pids[@]}"; do wait "$pid" || true; done
	for index in "${!object_ids[@]}"; do
		status=$(<"$temporary/delete-$index.status")
		failures=$((failures + status))
	done
	if ((failures == 0)); then
		object_ids=()
		object_id=
		return 0
	fi
	return 1
}
cleanup() {
	delete_objects >/dev/null 2>&1 || true
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

if ((request_concurrency < 1 || request_concurrency > request_count)); then
	echo "REQUEST_CONCURRENCY must be between 1 and REQUEST_COUNT" >&2
	exit 1
fi

cat >"$temporary/version.json" <<'JSON'
{
  "main_module": "main.js",
  "modules": {
    "main.js": "import { DurableObject } from \"cloudflare:workers\";\nexport class Agent extends DurableObject {\n  async fetch(request) {\n    const url = new URL(request.url);\n    const count = (await this.ctx.storage.get(\"count\")) ?? 0;\n    if (url.pathname === \"/increment\") {\n      const next = count + 1;\n      await this.ctx.storage.put(\"count\", next);\n      return Response.json({ready: true, count: next});\n    }\n    return Response.json({ready: true, count});\n  }\n}\nexport default { fetch() { return new Response(\"ready\"); } };"
  },
  "compatibility_date": "2026-08-14",
  "durable_objects": {"AGENT": "Agent"}
}
JSON
curl --fail --silent --show-error --max-time 60 \
	-H 'content-type: application/json' --data @"$temporary/version.json" \
	"$workers_url/v1/workers/$worker_name/versions" >"$temporary/version-response.json"
version_id=$(grep -o '"id"[[:space:]]*:[[:space:]]*"[^\"]*"' \
	"$temporary/version-response.json" | head -1 | cut -d '"' -f4)
[[ -n $version_id ]] || { echo "public /v1 Version upload returned no id" >&2; exit 1; }
printf '{"version_id":"%s"}\n' "$version_id" >"$temporary/deployment.json"
curl --fail --silent --show-error --max-time 60 \
	-H 'content-type: application/json' --data @"$temporary/deployment.json" \
	"$workers_url/v1/workers/$worker_name/deployments" >"$temporary/deployment-response.json"
deployment_id=$(grep -o '"id"[[:space:]]*:[[:space:]]*"[^\"]*"' \
	"$temporary/deployment-response.json" | head -1 | cut -d '"' -f4)
[[ -n $deployment_id ]] || { echo "public /v1 Deployment returned no id" >&2; exit 1; }

for worker in $(seq 1 "$request_concurrency"); do
	created_object_id=$(printf '%s:%s' "$run_id" "$worker" | sha256sum | cut -d' ' -f1)
	created=false
	for attempt in $(seq 1 5); do
		if curl --fail --silent --show-error --max-time 15 -X PUT \
			"$(object_path "$created_object_id")" >"$temporary/create-$worker.json"; then
			created=true
			break
		fi
		sleep "$attempt"
	done
	[[ $created == true ]] || { echo "public /v1 ObjectRef create failed for client $worker" >&2; exit 1; }
	object_ids+=("$created_object_id")
done
object_id=${object_ids[0]}

fetch_object() {
	local object=$1 route=$2 output=$3
	curl --fail --silent --show-error --max-time "$request_timeout_seconds" -X POST \
		-H "X-Workers-Original-URL: https://agent.invalid/$route" \
		"$(object_path "$object")/fetch" >"$output"
}

for worker in $(seq 1 "$request_concurrency"); do
	worker_object_id=${object_ids[worker - 1]}
	ready=false
	for _ in $(seq 1 120); do
		if fetch_object "$worker_object_id" heartbeat "$temporary/heartbeat-$worker.json" 2>/dev/null && \
			grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' "$temporary/heartbeat-$worker.json" && \
			grep -Eq '"count"[[:space:]]*:[[:space:]]*0([,}])' "$temporary/heartbeat-$worker.json"; then
			ready=true
			break
		fi
		sleep 0.25
	done
	[[ $ready == true ]] || { echo "public Agent Object did not become ready for client $worker" >&2; exit 1; }
done

printf 'probe_ready object_id=%s objects=%s requests=%s public_api=/v1\n' \
	"$object_id" "${#object_ids[@]}" "$request_count"

traffic_started_at_ms=$(date +%s%3N)

probe_worker() {
	local worker=$1 worker_requests=$2 worker_object_id=$3 worker_failures=0 response
	response="$temporary/heartbeat-$worker.json"
	for _ in $(seq 1 "$worker_requests"); do
		if ! fetch_object "$worker_object_id" heartbeat "$response" 2>/dev/null; then
			worker_failures=$((worker_failures + 1))
		elif ! grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' "$response" || \
			! grep -Eq '"count"[[:space:]]*:[[:space:]]*0([,}])' "$response"; then
			worker_failures=$((worker_failures + 1))
		fi
		sleep "$request_interval_seconds"
	done
	printf '%s\n' "$worker_failures" >"$temporary/failures-$worker"
}

worker_pids=()
for worker in $(seq 1 "$request_concurrency"); do
	worker_requests=$((request_count / request_concurrency))
	if ((worker <= request_count % request_concurrency)); then worker_requests=$((worker_requests + 1)); fi
	probe_worker "$worker" "$worker_requests" "${object_ids[worker - 1]}" &
	worker_pids+=("$!")
done
for worker_pid in "${worker_pids[@]}"; do wait "$worker_pid"; done
traffic_finished_at_ms=$(date +%s%3N)

failures=0
for worker in $(seq 1 "$request_concurrency"); do
	worker_failures=$(<"$temporary/failures-$worker")
	failures=$((failures + worker_failures))
done
if ((failures != 0)); then
	printf '{"verdict":"failed","public_api":"/v1","worker":"%s","object_id":"%s","object_count":%s,"requests":%s,"concurrency":%s,"failures":%s}\n' \
		"$worker_name" "$object_id" "${#object_ids[@]}" "$request_count" "$request_concurrency" "$failures"
	exit 1
fi

fetch_object "$object_id" increment "$temporary/increment.json"
fetch_object "$object_id" heartbeat "$temporary/final.json"
grep -Eq '"count"[[:space:]]*:[[:space:]]*1([,}])' "$temporary/increment.json"
grep -Eq '"count"[[:space:]]*:[[:space:]]*1([,}])' "$temporary/final.json"

probe_object_id=$object_id
probe_object_count=${#object_ids[@]}
if ! delete_objects; then
	printf '{"verdict":"failed","public_api":"/v1","worker":"%s","object_id":"%s","object_count":%s,"requests":%s,"concurrency":%s,"failures":0,"cleanup":"failed","worker_fixture_retained":true}\n' \
		"$worker_name" "$probe_object_id" "$probe_object_count" "$request_count" "$request_concurrency"
	exit 1
fi
printf '{"verdict":"passed","public_api":"/v1","worker":"%s","version_id":"%s","deployment_id":"%s","object_id":"%s","object_count":%s,"requests":%s,"concurrency":%s,"failures":0,"traffic_started_at_ms":%s,"traffic_finished_at_ms":%s,"post_failure_write_count":1,"cleanup":"passed","worker_fixture_retained":true}\n' \
	"$worker_name" "$version_id" "$deployment_id" "$probe_object_id" "$probe_object_count" "$request_count" "$request_concurrency" "$traffic_started_at_ms" "$traffic_finished_at_ms"
