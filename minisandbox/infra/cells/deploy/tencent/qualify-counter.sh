#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
engine_url=${RIVET_ENGINE_URL:-http://127.0.0.1:16420}
health_url=${RIVET_HEALTH_URL:-http://127.0.0.1:16421/health}
actor_id=

cleanup() {
	if [ -n "$actor_id" ] && [ "${KEEP_ACTOR:-0}" != 1 ]; then
		curl --fail --silent --show-error --request DELETE \
			"$engine_url/actors/$actor_id?namespace=default" >/dev/null || true
	fi
}
trap cleanup EXIT INT TERM

counter_field() {
	python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

wait_for_health() {
	for attempt in $(seq 1 90); do
		if curl --fail --silent "$health_url" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done
	echo "engine did not become healthy" >&2
	return 1
}

wait_for_counter() {
	expected_value=$1
	minimum_generation=$2
	for attempt in $(seq 1 120); do
		response=$(curl --silent --show-error --write-out '\n%{http_code}' \
			"$engine_url/gateway/$actor_id/counter" 2>&1 || true)
		http_code=${response##*'
'}
		body=${response%'
'*}
		if [ "$http_code" = 200 ] && printf '%s' "$body" | python3 -c '
import json, sys
data = json.load(sys.stdin)
expected = int(sys.argv[1])
minimum_generation = int(sys.argv[2])
raise SystemExit(0 if data["value"] == expected and data["generation"] >= minimum_generation else 1)
' "$expected_value" "$minimum_generation"; then
			printf '%s\n' "$body"
			return 0
		fi
		sleep 1
	done
	echo "counter did not recover at value=$expected_value generation>=$minimum_generation" >&2
	return 1
}

create_response=$(curl --fail --silent --show-error --request POST \
	--header 'Content-Type: application/json' \
	--data "{\"name\":\"counter\",\"key\":\"qualification-$(date +%s)-$$\",\"runner_name_selector\":\"test-envoy\",\"crash_policy\":\"restart\"}" \
	"$engine_url/actors?namespace=default")
actor_id=$(printf '%s' "$create_response" | python3 -c \
	'import json, sys; print(json.load(sys.stdin)["actor"]["actor_id"])')

initial=$(wait_for_counter 0 1)
initial_generation=$(printf '%s' "$initial" | counter_field generation)

first=$(curl --fail --silent --show-error --request POST \
	"$engine_url/gateway/$actor_id/increment")
second=$(curl --fail --silent --show-error --request POST \
	"$engine_url/gateway/$actor_id/increment")
[ "$(printf '%s' "$first" | counter_field value)" = 1 ]
[ "$(printf '%s' "$second" | counter_field value)" = 2 ]

docker compose -f "$compose_file" restart engine >/dev/null
wait_for_health
after_engine=$(wait_for_counter 2 "$initial_generation")

docker compose -f "$compose_file" restart runner >/dev/null
after_runner=$(wait_for_counter 2 "$((initial_generation + 1))")

third=$(curl --fail --silent --show-error --request POST \
	"$engine_url/gateway/$actor_id/increment")
[ "$(printf '%s' "$third" | counter_field value)" = 3 ]

for worker in $(seq 1 16); do
	curl --fail --silent --show-error --request POST \
		"$engine_url/gateway/$actor_id/increment" >/dev/null &
done
wait
after_concurrency=$(wait_for_counter 19 "$((initial_generation + 1))")

printf 'counter qualification passed\n'
printf '  actor:         %s\n' "$actor_id"
printf '  initial:       %s\n' "$initial"
printf '  engine restart:%s\n' "$after_engine"
printf '  runner restart:%s\n' "$after_runner"
printf '  final:         %s\n' "$third"
printf '  concurrent:    %s\n' "$after_concurrency"
