#!/usr/bin/env bash
set -euo pipefail

health_url=${RIVET_HEALTH_URL:-http://127.0.0.1:6421/health}
api_url=${RIVET_API_URL:-http://127.0.0.1:6420}
namespace=${RIVET_NAMESPACE:-default}
runner_name=${RIVET_RUNNER_NAME:-workerd}
auth_token=${RIVET_AUTH_TOKEN:-dev}
max_attempts=${RIVET_HEALTH_ATTEMPTS:-120}

healthy=false
for ((attempt = 1; attempt <= max_attempts; attempt++)); do
	if curl --fail --silent "$health_url" >/dev/null; then
		healthy=true
		break
	fi
	sleep 1
done

if [[ $healthy != true ]]; then
	echo "Rivet did not become healthy after $max_attempts attempts" >&2
	exit 1
fi

payload='{"datacenters":{"default":{"normal":{}}}}'
curl --fail --silent --show-error \
	--request PUT \
	--header "Authorization: Bearer $auth_token" \
	--header 'Content-Type: application/json' \
	--data "$payload" \
	"$api_url/runner-configs/$runner_name?namespace=$namespace"
