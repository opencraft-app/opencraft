#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 3 ]] || {
	echo "Usage: publish.sh DESIRED_ROOT RENDER_RECEIPT PUBLICATION_RECEIPT" >&2
	exit 2
}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${HUB_KUBECONFIG:?HUB_KUBECONFIG must name management cluster C kubeconfig}"
: "${ACTOR_MANAGEMENT_GIT_CREDENTIAL:?ACTOR_MANAGEMENT_GIT_CREDENTIAL is required}"
expected_revision=${ACTOR_MANAGEMENT_EXPECTED_REVISION:-auto}
python=${PYTHON:-python3.11}
desired_root=$1
render_receipt=$2
publication_receipt=$3
forward_port=${ACTOR_MANAGEMENT_GIT_FORWARD_PORT:-30090}
read_url=http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git

for command in kubectl curl git stat "$python"; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done
"$python" -c 'import sys; assert sys.version_info >= (3, 11)' || {
	echo "Workers API Git publication requires Python 3.11 or newer" >&2
	exit 2
}
[[ -d $desired_root && ! -L $desired_root && -f $render_receipt && ! -L $render_receipt ]] || {
	echo "desired root and render receipt must be non-symlink inputs" >&2
	exit 2
}
[[ -f $HUB_KUBECONFIG && ! -L $HUB_KUBECONFIG ]] || { echo "management kubeconfig is invalid" >&2; exit 2; }
[[ -f $ACTOR_MANAGEMENT_GIT_CREDENTIAL && ! -L $ACTOR_MANAGEMENT_GIT_CREDENTIAL ]] || {
	echo "management Git publisher credential is invalid" >&2
	exit 2
}
(( (8#$(stat -c '%a' "$ACTOR_MANAGEMENT_GIT_CREDENTIAL") & 8#077) == 0 )) || {
	echo "management Git publisher credential must not be group/world accessible" >&2
	exit 2
}
[[ $expected_revision == auto || $expected_revision =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
	echo "ACTOR_MANAGEMENT_EXPECTED_REVISION is invalid" >&2
	exit 2
}
[[ $publication_receipt == /* && ! -e $publication_receipt && -d $(dirname -- "$publication_receipt") ]] || {
	echo "publication receipt must be a new absolute path with an existing parent" >&2
	exit 2
}

temporary=$(mktemp -d /data/tmp/actor-management-workers-api-publish.XXXXXX)
forward_pid=
cleanup() {
	if [[ -n ${forward_pid:-} ]]; then
		kill "$forward_pid" 2>/dev/null || true
		wait "$forward_pid" 2>/dev/null || true
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

"$python" - "$ACTOR_MANAGEMENT_GIT_CREDENTIAL" "$read_url" >"$temporary/credential.json" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
assert value.get("schema") == "actor-management-git-publisher-credential/v1"
assert value.get("repositoryURL") == sys.argv[2]
assert value.get("username") == "release-publisher"
assert isinstance(value.get("password"),str) and len(value["password"]) == 64
json.dump(value,sys.stdout,separators=(",",":"))
PY
publisher_password=$("$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["password"])' "$temporary/credential.json")

kubectl --kubeconfig "$HUB_KUBECONFIG" -n actor-git-system \
	port-forward service/actor-git "$forward_port:3000" >"$temporary/port-forward.log" 2>&1 &
forward_pid=$!
for _ in $(seq 1 60); do
	if curl --fail --silent "http://127.0.0.1:$forward_port/api/healthz" >/dev/null 2>&1; then break; fi
	sleep 1
done
curl --fail --silent "http://127.0.0.1:$forward_port/api/healthz" >/dev/null

askpass=$temporary/askpass.sh
"$python" - "$askpass" <<'PY'
import os,sys
descriptor=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o700)
with os.fdopen(descriptor,"w") as output:
    output.write("#!/usr/bin/env sh\n")
    output.write('case "$1" in *sername*) printf "%s\\n" release-publisher ;; *) printf "%s\\n" "$ACTOR_GIT_PUBLISH_PASSWORD" ;; esac\n')
PY
export ACTOR_GIT_PUBLISH_PASSWORD=$publisher_password GIT_ASKPASS=$askpass GIT_TERMINAL_PROMPT=0
"$python" "$script_dir/publish-desired-state.py" \
	--desired-root "$desired_root" --render-receipt "$render_receipt" \
	--repository-url "http://127.0.0.1:$forward_port/release-publisher/fleet-desired.git" \
	--read-url "$read_url" --branch main \
	--expected-revision "$expected_revision" \
	--receipt "$publication_receipt" --allow-local-repository
