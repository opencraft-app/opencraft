#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 3 ]] || { echo "Usage: publish.sh DESIRED_ROOT RENDER_RECEIPT PUBLICATION_RECEIPT" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${HUB_KUBECONFIG:?set HUB_KUBECONFIG}"
: "${ACTOR_MANAGEMENT_GIT_CREDENTIAL:?set ACTOR_MANAGEMENT_GIT_CREDENTIAL}"
expected_revision=${ACTOR_MANAGEMENT_EXPECTED_REVISION:-auto}
python=${PYTHON:-python3.11}; port=${ACTOR_MANAGEMENT_GIT_FORWARD_PORT:-30092}
read_url=http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git
temporary=$(mktemp -d /data/tmp/actor-observability-publish.XXXXXX); forward_pid=
cleanup(){ [[ -z ${forward_pid:-} ]] || { kill "$forward_pid" 2>/dev/null || true; wait "$forward_pid" 2>/dev/null || true; }; rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
for path in "$HUB_KUBECONFIG" "$ACTOR_MANAGEMENT_GIT_CREDENTIAL" "$2"; do
  [[ -f $path && ! -L $path ]] || { echo "invalid publication input" >&2; exit 2; }
done
publisher_password=$(jq -er '.password | select(type=="string" and length==64)' "$ACTOR_MANAGEMENT_GIT_CREDENTIAL")
kubectl --kubeconfig "$HUB_KUBECONFIG" -n actor-git-system port-forward service/actor-git "$port:3000" >"$temporary/forward.log" 2>&1 & forward_pid=$!
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$port/api/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$port/api/healthz" >/dev/null
askpass=$temporary/askpass.sh
printf '#!/bin/sh\ncase "$1" in *sername*) printf "%%s\\n" release-publisher ;; *) printf "%%s\\n" "$ACTOR_GIT_PUBLISH_PASSWORD" ;; esac\n' >"$askpass"; chmod 0700 "$askpass"
export ACTOR_GIT_PUBLISH_PASSWORD=$publisher_password GIT_ASKPASS=$askpass GIT_TERMINAL_PROMPT=0
if [[ $expected_revision == auto ]]; then
  expected_revision=$(git ls-remote --refs "http://127.0.0.1:$port/release-publisher/fleet-desired.git" refs/heads/main | awk 'NR==1 {print $1}')
fi
"$python" "$script_dir/publish-desired-state.py" --desired-root "$1" --render-receipt "$2" \
  --repository-url "http://127.0.0.1:$port/release-publisher/fleet-desired.git" --read-url "$read_url" \
  --expected-revision "$expected_revision" --receipt "$3" --allow-local-repository
