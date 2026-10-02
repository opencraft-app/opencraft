#!/usr/bin/env bash
set -euo pipefail

INGRESS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${INGRESS_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

for command in curl jq; do require_command "${command}"; done

BINDING_FILE=${MESH_STATE_DIR}/local-ingress/binding.json
[[ -f ${BINDING_FILE} ]] || die "local ingress binding is missing; run ${INGRESS_DIR}/up.sh first"
bind_address=$(jq -er '.address' "${BINDING_FILE}")
http_port=$(jq -er '.httpPort' "${BINDING_FILE}")
base_url="http://${bind_address}:${http_port}"
actor_id=

cleanup() {
	if [[ -n ${actor_id} ]]; then
		curl -sS --max-time 10 --request DELETE \
			--header 'Host: runtime-b.local' \
			--header 'x-rivet-target: api-public' \
			"${base_url}/actors/${actor_id}?namespace=default" >/dev/null || true
	fi
}
trap cleanup EXIT

create_body=$(jq -nc --arg key "fleet-cross-cell-$(date +%s%N)" \
	'{name:"workerd-counter",key:$key,runner_name_selector:"workerd",crash_policy:"restart",datacenter:"local-runtime-b"}')
created=$(curl -fsS --max-time 30 --request POST \
	--header 'Host: runtime-b.local' \
	--header 'x-rivet-target: api-public' \
	--header 'content-type: application/json' \
	--data "${create_body}" \
	"${base_url}/actors?namespace=default")
actor_id=$(jq -er '.actor.actor_id' <<<"${created}")

deadline=$((SECONDS + 180))
while true; do
	if response=$(curl -fsS --max-time 10 --header 'Host: runtime-a.local' \
		"${base_url}/gateway/${actor_id}/counter" 2>/dev/null) &&
		jq -e --arg actor_id "${actor_id}" \
			'.actorId == $actor_id and (.generation | type == "number" and . > 0)' \
			<<<"${response}" >/dev/null; then
		break
	fi
	(( SECONDS < deadline )) || die "A Guard did not route the Cell B actor within 180 seconds"
	sleep 1
done

log "cross-Cell route passed: Caddy -> A Guard -> B Guard -> ${actor_id}"
