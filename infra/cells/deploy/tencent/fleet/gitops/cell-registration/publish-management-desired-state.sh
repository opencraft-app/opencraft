#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 4 ]] || {
	echo "Usage: publish-management-desired-state.sh CELL_TERRAFORM_INVENTORY HANDOFF_RECEIPT DESIRED_ROOT PUBLICATION_RECEIPT" >&2
	exit 2
}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bootstrap_dir=$(CDPATH= cd -- "$script_dir/../../terraform/create-first/bootstrap" && pwd)
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG to management cluster C}"
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY to management Terraform inventory}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?set ACTOR_PULL_CREDENTIAL_RECEIPT}"
: "${ACTOR_MANAGEMENT_PLATFORM_RECEIPT:?set ACTOR_MANAGEMENT_PLATFORM_RECEIPT}"
: "${ACTOR_MANAGEMENT_GIT_RECEIPT:?set ACTOR_MANAGEMENT_GIT_RECEIPT}"
: "${ACTOR_MANAGEMENT_GIT_CREDENTIAL:?set ACTOR_MANAGEMENT_GIT_CREDENTIAL}"
cell_inventory=$1
handoff_receipt=$2
desired_root=$3
publication_receipt=$4
forward_port=${ACTOR_MANAGEMENT_GIT_FORWARD_PORT:-30090}
read_url=http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git

[[ -f $ACTOR_MANAGEMENT_GIT_CREDENTIAL && ! -L $ACTOR_MANAGEMENT_GIT_CREDENTIAL ]] || {
	echo "management Git publisher credential is missing" >&2
	exit 2
}
(( (8#$(stat -c '%a' "$ACTOR_MANAGEMENT_GIT_CREDENTIAL") & 8#077) == 0 )) || {
	echo "management Git publisher credential must not be group/world accessible" >&2
	exit 2
}

temporary=$(mktemp -d /data/tmp/actor-management-publish.XXXXXX)
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

"$bootstrap_dir/check-management-git.sh" >"$temporary/management-git.json"
repository_url=$(jq -er '.repository.url' "$temporary/management-git.json")
[[ $repository_url == "$read_url" ]] || { echo "management Git receipt has an unexpected repository URL" >&2; exit 1; }
"$python" - "$ACTOR_MANAGEMENT_GIT_CREDENTIAL" "$read_url" >"$temporary/credential.json" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
assert value.get("schema") == "actor-management-git-publisher-credential/v1"
assert value.get("repositoryURL") == sys.argv[2]
assert value.get("username") == "release-publisher"
assert isinstance(value.get("password"),str) and len(value["password"]) == 64
json.dump(value,sys.stdout,separators=(",",":"))
PY
publisher_password=$(jq -er '.password' "$temporary/credential.json")
update_args=()
if [[ -n ${ACTOR_MANAGEMENT_EXPECTED_REVISION:-} ]]; then
	[[ $ACTOR_MANAGEMENT_EXPECTED_REVISION =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
		echo "ACTOR_MANAGEMENT_EXPECTED_REVISION is invalid" >&2
		exit 2
	}
	update_args=(--allow-update --expected-revision "$ACTOR_MANAGEMENT_EXPECTED_REVISION")
fi

kubectl --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG" -n actor-git-system \
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
path=sys.argv[1]
descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o700)
with os.fdopen(descriptor,"w") as output:
    output.write("#!/usr/bin/env sh\n")
    output.write('case "$1" in *sername*) printf "%s\\n" release-publisher ;; *) printf "%s\\n" "$ACTOR_GIT_PUBLISH_PASSWORD" ;; esac\n')
PY
export ACTOR_GIT_PUBLISH_PASSWORD=$publisher_password GIT_ASKPASS=$askpass GIT_TERMINAL_PROMPT=0
"$python" "$script_dir/publish-desired-state.py" \
	--inventory "$cell_inventory" --handoff-receipt "$handoff_receipt" \
	--desired-root "$desired_root" \
	--repository-url "http://127.0.0.1:$forward_port/release-publisher/fleet-desired.git" \
	--read-url "$read_url" --branch main --receipt "$publication_receipt" \
	"${update_args[@]}" \
	--allow-local-repository
