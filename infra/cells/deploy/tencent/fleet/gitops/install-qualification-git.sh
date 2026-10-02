#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manifest=$script_dir/qualification-git-service.yaml
control_rbac=$script_dir/argocd-control-rbac.yaml
kubeconfig=${KUBECONFIG:-/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig}
state_dir=${ACTOR_GIT_STATE_DIR:-/data/actor-qualification/git}
credential_file=$state_dir/credentials.json
repo_url=http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git
expected_image=lightclaw-bj82.tencentcloudcr.com/actor-fleet/git-service@sha256:f4b8d351d4b8cf29a2ce2b0dd792eec98b2dde026f3dae354e34256a01999b68

for command in kubectl python3 curl openssl mktemp sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
[[ -s $manifest && -s $control_rbac && $kubeconfig == /* && $state_dir == /data/actor-qualification/* ]]
export KUBECONFIG=$kubeconfig
install -d -m 0700 "$state_dir"

# Bootstrap owns the authorization ceiling outside the child Application.  It
# includes the exact-Application recovery account used to make an interrupted
# FDB qualification return to Git state without granting the Job any Cell,
# Secret, delete, or RBAC authority.
kubectl apply --dry-run=server -f "$control_rbac" >/dev/null
kubectl apply -f "$control_rbac" >/dev/null
kubectl apply -f "$manifest" >/dev/null
kubectl -n actor-git-system rollout status statefulset/actor-git --timeout=10m
actual_image=$(kubectl -n actor-git-system get pod actor-git-0 -o jsonpath='{.status.containerStatuses[?(@.name=="gitea")].imageID}')
[[ $actual_image == docker-pullable://$expected_image || $actual_image == $expected_image ]]
kubectl -n actor-git-system exec actor-git-0 -- wget -qO- http://127.0.0.1:3000/api/healthz \
	| python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "pass"'

if [[ ! -s $credential_file ]]; then
	temporary_credentials=$(mktemp "$state_dir/credentials.XXXXXX")
	python3 - "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$temporary_credentials" <<'PY'
import json,sys
publisher_password,reader_password,path=sys.argv[1:]
document={"schemaVersion":"actor-q01-git-credentials/v1",
          "publisher":{"username":"release-publisher","password":publisher_password,"token":None},
          "reader":{"username":"argocd-reader","password":reader_password,"token":None}}
with open(path,"w") as output:
    json.dump(document,output,sort_keys=True)
    output.write("\n")
PY
	chmod 0600 "$temporary_credentials"
	mv "$temporary_credentials" "$credential_file"
fi
[[ $(stat -c %a "$credential_file") == 600 ]]
publisher_password=$(python3 -c 'import json,sys; value=json.load(open(sys.argv[1]))["publisher"]["password"]; assert len(value) >= 64; print(value)' "$credential_file")
reader_password=$(python3 -c 'import json,sys; value=json.load(open(sys.argv[1]))["reader"]["password"]; assert len(value) >= 64; print(value)' "$credential_file")
user_exists(){
	kubectl -n actor-git-system exec actor-git-0 -- gitea admin user list \
		| awk 'NR > 1 {print $2}' | grep -Fx "$1" >/dev/null
}
if ! user_exists release-publisher; then
	kubectl -n actor-git-system exec actor-git-0 -- gitea admin user create \
		--username release-publisher --password "$publisher_password" \
		--email release-publisher@invalid.local --must-change-password=false >/dev/null
fi
if ! user_exists argocd-reader; then
	kubectl -n actor-git-system exec actor-git-0 -- gitea admin user create \
		--username argocd-reader --password "$reader_password" \
		--email argocd-reader@invalid.local --must-change-password=false >/dev/null
fi

forward_log=$state_dir/port-forward.log
kubectl -n actor-git-system port-forward service/actor-git 30090:3000 >"$forward_log" 2>&1 &
forward_pid=$!
cleanup(){ kill "$forward_pid" 2>/dev/null || true; wait "$forward_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
for _ in $(seq 1 30); do
	curl --fail --silent http://127.0.0.1:30090/api/healthz >/dev/null 2>&1 && break
	sleep 1
done
curl --fail --silent http://127.0.0.1:30090/api/healthz \
	| python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "pass"'

# Token rotation is restart-safe: passwords are persisted before user creation,
# and a rerun first revokes each well-known token name before creating it again.
rotate_token(){
	local username=$1 password=$2 token_name=$3 scopes=$4 output=$5
	curl --silent --show-error --user "$username:$password" -X DELETE \
		"http://127.0.0.1:30090/api/v1/users/$username/tokens/$token_name" >/dev/null || true
	curl --fail --silent --show-error --user "$username:$password" -X POST \
		-H 'Content-Type: application/json' \
		-d "{\"name\":\"$token_name\",\"scopes\":[\"$scopes\"]}" \
		"http://127.0.0.1:30090/api/v1/users/$username/tokens" \
		| python3 -c 'import json,sys; value=json.load(sys.stdin)["sha1"]; assert len(value) > 20; print(value)' >"$output"
	chmod 0600 "$output"
}
publisher_token_file=$(mktemp "$state_dir/publisher-token.XXXXXX")
reader_token_file=$(mktemp "$state_dir/reader-token.XXXXXX")
trap 'rm -f -- "$publisher_token_file" "$reader_token_file"; cleanup' EXIT INT TERM
rotate_token release-publisher "$publisher_password" q01-release-publisher write:repository "$publisher_token_file"
rotate_token argocd-reader "$reader_password" q01-argocd-reader read:repository "$reader_token_file"
publisher_token=$(cat "$publisher_token_file")
reader_token=$(cat "$reader_token_file")
next_credentials=$(mktemp "$state_dir/credentials.XXXXXX")
python3 - "$credential_file" "$publisher_token" "$reader_token" "$next_credentials" <<'PY'
import json,sys
source,publisher_token,reader_token,target=sys.argv[1:]
with open(source) as stream:
    document=json.load(stream)
document["publisher"]["token"]=publisher_token
document["reader"]["token"]=reader_token
with open(target,"w") as output:
    json.dump(document,output,sort_keys=True)
    output.write("\n")
PY
chmod 0600 "$next_credentials"
mv "$next_credentials" "$credential_file"
rm -f -- "$publisher_token_file" "$reader_token_file"
trap cleanup EXIT INT TERM

repo_response=$(mktemp "$state_dir/repository-response.XXXXXX")
repo_status=$(curl --silent --show-error -o "$repo_response" -w '%{http_code}' \
	--user "release-publisher:$publisher_password" \
	http://127.0.0.1:30090/api/v1/repos/release-publisher/fleet-desired)
if [[ $repo_status == 200 ]] && python3 - "$repo_response" <<'PY'
import json,sys
document=json.load(open(sys.argv[1]))
assert document.get("id") and document.get("private") is True
assert document.get("owner",{}).get("login") == "release-publisher"
PY
then
	:
elif [[ $repo_status == 404 ]]; then
	curl --fail --silent --show-error --user "release-publisher:$publisher_password" -X POST \
		-H 'Content-Type: application/json' \
		-d '{"name":"fleet-desired","private":true,"auto_init":false,"default_branch":"main"}' \
		http://127.0.0.1:30090/api/v1/user/repos >/dev/null
else
	echo "existing desired-state repository violates owner/private invariant" >&2
	exit 1
fi
rm -f -- "$repo_response"
curl --fail --silent --show-error --user "release-publisher:$publisher_password" -X PUT \
	-H 'Content-Type: application/json' -d '{"permission":"read"}' \
	http://127.0.0.1:30090/api/v1/repos/release-publisher/fleet-desired/collaborators/argocd-reader >/dev/null

repository_secret=$(mktemp "$state_dir/repository-secret.XXXXXX")
trap 'rm -f -- "$repository_secret"; cleanup' EXIT INT TERM
kubectl -n argocd create secret generic actor-fleet-desired-repository \
	--from-literal=type=git --from-literal=url="$repo_url" \
	--from-literal=username=argocd-reader --from-literal=password="$reader_token" \
	--dry-run=client -o yaml >"$repository_secret"
kubectl -n argocd label --local -f "$repository_secret" \
	argocd.argoproj.io/secret-type=repository -o yaml | kubectl apply -f - >/dev/null
rm -f -- "$repository_secret"
trap cleanup EXIT INT TERM

encoded_url=$(printf %s "$repo_url" | base64 | tr -d '\n')
kubectl -n argocd get secret actor-fleet-desired-repository -o json \
	| python3 -c 'import json,sys; document=json.load(sys.stdin); assert document["metadata"]["labels"]["argocd.argoproj.io/secret-type"] == "repository"; assert document["data"]["url"] == sys.argv[1]' "$encoded_url"
repo_id=$(curl --fail --silent --show-error --user "release-publisher:$publisher_password" \
	http://127.0.0.1:30090/api/v1/repos/release-publisher/fleet-desired \
	| python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
receipt=$state_dir/install-receipt.json
python3 - "$expected_image" "$repo_url" "$repo_id" "$(sha256sum "$manifest" | cut -d' ' -f1)" \
	"$(sha256sum "$control_rbac" | cut -d' ' -f1)" "$receipt" <<'PY'
import json,sys
image,repo_url,repo_id,manifest,control_rbac,receipt=sys.argv[1:]
document={"schemaVersion":"actor-q01-qualification-git-install/v1","verdict":"passed",
          "image":image,"repositoryURL":repo_url,"repositoryID":repo_id,"private":True,
          "argocdAccess":"read-only","publisherAccess":"write-only-desired-repo",
          "manifestSHA256":manifest,"controlRBACSHA256":control_rbac}
with open(receipt,"w") as output:
    json.dump(document,output,indent=2,sort_keys=True)
    output.write("\n")
PY
chmod 0600 "$receipt"
python3 -m json.tool "$receipt"
