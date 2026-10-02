#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?set ACTOR_PULL_CREDENTIAL_RECEIPT}"
: "${ACTOR_MANAGEMENT_PLATFORM_RECEIPT:?set ACTOR_MANAGEMENT_PLATFORM_RECEIPT}"
: "${ACTOR_MANAGEMENT_GIT_CREDENTIAL:?set ACTOR_MANAGEMENT_GIT_CREDENTIAL to a protected output path}"
: "${ACTOR_MANAGEMENT_GIT_RECEIPT:?set ACTOR_MANAGEMENT_GIT_RECEIPT to an immutable receipt path}"
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}
update_generation=${ACTOR_MANAGEMENT_GIT_UPDATE_GENERATION:-false}
expected_previous_platform=${ACTOR_MANAGEMENT_GIT_EXPECTED_PLATFORM_RECEIPT_DIGEST:-}
expected_previous_inventory=${ACTOR_MANAGEMENT_GIT_EXPECTED_IMAGE_INVENTORY_DIGEST:-}

repository_url=http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git
forward_port=${ACTOR_MANAGEMENT_GIT_FORWARD_PORT:-30090}
[[ $update_generation == false || $update_generation == true ]] || {
	echo "ACTOR_MANAGEMENT_GIT_UPDATE_GENERATION must be true or false" >&2
	exit 2
}
if [[ $update_generation == true ]]; then
	for digest in "$expected_previous_platform" "$expected_previous_inventory"; do
		[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || {
			echo "management Git generation update requires exact previous digests" >&2
			exit 2
		}
	done
fi
for command in base64 curl jq kubectl openssl "$python" sha256sum stat tr; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_CLUSTER_KUBECONFIG" "$ACTOR_PULL_CREDENTIAL_RECEIPT" \
	"$ACTOR_MANAGEMENT_PLATFORM_RECEIPT"; do
	[[ $path == /* && -f $path && ! -L $path ]] || {
		echo "management Git input must be an absolute regular non-symlink file: $path" >&2
		exit 2
	}
done
for path in "$ACTOR_MANAGEMENT_GIT_CREDENTIAL" "$ACTOR_MANAGEMENT_GIT_RECEIPT"; do
	[[ $path == /* && $path != / && -d $(dirname -- "$path") ]] || {
		echo "management Git outputs must be absolute and have an existing parent" >&2
		exit 2
	}
done
(( (8#$(stat -c '%a' "$ACTOR_CLUSTER_KUBECONFIG") & 8#077) == 0 )) || {
	echo "management kubeconfig must not be group/world accessible" >&2
	exit 2
}
[[ $forward_port =~ ^[0-9]+$ ]] && (( forward_port >= 1024 && forward_port <= 65535 )) || {
	echo "management Git forward port is invalid" >&2
	exit 2
}

temporary=$(mktemp -d "$(dirname -- "$ACTOR_MANAGEMENT_GIT_RECEIPT")/.actor-management-git.XXXXXX")
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

# This read-only gate completes before the first mutation. It joins Terraform,
# image lock, pull bootstrap, live cluster identity and the full Argo HA floor.
ACTOR_CLUSTER_KUBECONFIG="$ACTOR_CLUSTER_KUBECONFIG" \
	"$script_dir/check-management-platform.sh" >"$temporary/platform.json"
"$python" "$script_dir/validate-management-platform-inputs.py" \
	--inventory "$ACTOR_TERRAFORM_INVENTORY" --images "$ACTOR_IMAGE_INVENTORY" \
	--pull-receipt "$ACTOR_PULL_CREDENTIAL_RECEIPT" >"$temporary/plan.json"
management_id=$(jq -er '.managementId' "$temporary/plan.json")
cluster_id=$(jq -er '.clusterId' "$temporary/plan.json")
cluster_uid=$(jq -er '.clusterUid' "$temporary/plan.json")
namespace_uid=$(jq -er '.actorGitNamespaceUid' "$temporary/plan.json")
pull_secret_uid=$(jq -er '.actorGitPullSecretUid' "$temporary/plan.json")
image_inventory_digest=$(jq -er '.imageInventoryDigest' "$temporary/plan.json")
platform_digest=$(jq -er '.platformReceiptDigest' "$temporary/platform.json")

kube=(kubectl --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG")
[[ $("${kube[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}') == "$cluster_uid" ]]
[[ $("${kube[@]}" get namespace actor-git-system -o jsonpath='{.metadata.uid}') == "$namespace_uid" ]]
[[ $("${kube[@]}" -n actor-git-system get secret actor-fleet-tcr -o jsonpath='{.metadata.uid}') == "$pull_secret_uid" ]]

"$python" "$script_dir/render-management-git.py" \
	--images "$ACTOR_IMAGE_INVENTORY" --management-id "$management_id" \
	--platform-receipt-digest "$platform_digest" --cluster-uid "$cluster_uid" \
	--output "$temporary/management-git.yaml" --receipt "$temporary/render-receipt.json" >/dev/null
expected_image=$(jq -er '.image' "$temporary/render-receipt.json")
"${kube[@]}" apply --server-side --force-conflicts \
	--field-manager=actor-create-first-management \
	-f "$temporary/management-git.yaml" >/dev/null
"${kube[@]}" -n actor-git-system rollout status statefulset/actor-git --timeout=10m >/dev/null
"${kube[@]}" -n actor-git-system get statefulset actor-git -o json >"$temporary/statefulset.json"
"${kube[@]}" -n actor-git-system get pvc actor-git-data -o json >"$temporary/pvc.json"
actual_image=$("${kube[@]}" -n actor-git-system get pod actor-git-0 \
	-o jsonpath='{.status.containerStatuses[?(@.name=="gitea")].imageID}')
[[ $actual_image == "$expected_image" || $actual_image == "docker-pullable://$expected_image" ]] || {
	echo "management Git Pod is not running the locked image digest" >&2
	exit 1
}
"${kube[@]}" -n actor-git-system exec actor-git-0 -- wget -qO- http://127.0.0.1:3000/api/healthz \
	| "$python" -c 'import json,sys; assert json.load(sys.stdin)["status"] == "pass"'

publisher_user_file=$temporary/publisher-user
reader_user_file=$temporary/reader-user
publisher_password_file=$temporary/publisher-password
reader_password_file=$temporary/reader-password
printf '%s' release-publisher >"$publisher_user_file"
printf '%s' argocd-reader >"$reader_user_file"
credential_secret=actor-git-bootstrap-credentials
credential_existed=true
if ! "${kube[@]}" -n actor-git-system get secret "$credential_secret" -o json >"$temporary/credential-secret.json" 2>/dev/null; then
	credential_existed=false
	openssl rand -hex 32 | tr -d '\n' >"$publisher_password_file"
	openssl rand -hex 32 | tr -d '\n' >"$reader_password_file"
	"${kube[@]}" -n actor-git-system create secret generic "$credential_secret" \
		--from-file=publisher-username="$publisher_user_file" \
		--from-file=publisher-password="$publisher_password_file" \
		--from-file=reader-username="$reader_user_file" \
		--from-file=reader-password="$reader_password_file" \
		--dry-run=client -o json \
		| jq --arg management "$management_id" --arg cluster "$cluster_uid" \
			--arg platform "$platform_digest" --arg images "$image_inventory_digest" \
			'.immutable=true | .metadata.annotations={
			  "fleet.actor.dev/management-id":$management,
			  "fleet.actor.dev/management-cluster-uid":$cluster,
			  "fleet.actor.dev/management-platform-receipt-digest":$platform,
			  "fleet.actor.dev/image-inventory-digest":$images}' \
		| "${kube[@]}" create -f - >/dev/null
	"${kube[@]}" -n actor-git-system get secret "$credential_secret" -o json >"$temporary/credential-secret.json"
fi
if [[ $credential_existed == true && $update_generation == true ]]; then
	cp "$temporary/credential-secret.json" "$temporary/credential-secret.before.json"
	"$python" - "$temporary/credential-secret.json" "$management_id" "$cluster_uid" \
		"$expected_previous_platform" "$expected_previous_inventory" \
		"$platform_digest" "$image_inventory_digest" <<'PY'
import json,sys
path,management,cluster,old_platform,old_images,new_platform,new_images=sys.argv[1:]
value=json.load(open(path)); annotations=value["metadata"].get("annotations",{})
common={"fleet.actor.dev/management-id":management,"fleet.actor.dev/management-cluster-uid":cluster}
old={**common,"fleet.actor.dev/management-platform-receipt-digest":old_platform,"fleet.actor.dev/image-inventory-digest":old_images}
new={**common,"fleet.actor.dev/management-platform-receipt-digest":new_platform,"fleet.actor.dev/image-inventory-digest":new_images}
if annotations not in (old,new): raise SystemExit("management Git credential Secret generation CAS failed")
print("current" if annotations == new else "promote")
PY
	if [[ $("$python" -c 'import json,sys; a=json.load(open(sys.argv[1]))["metadata"].get("annotations",{}); print(a.get("fleet.actor.dev/management-platform-receipt-digest",""))' "$temporary/credential-secret.json") == "$expected_previous_platform" ]]; then
		"${kube[@]}" -n actor-git-system annotate --overwrite secret "$credential_secret" \
			"fleet.actor.dev/management-platform-receipt-digest=$platform_digest" \
			"fleet.actor.dev/image-inventory-digest=$image_inventory_digest" >/dev/null
		"${kube[@]}" -n actor-git-system get secret "$credential_secret" -o json >"$temporary/credential-secret.json"
	fi
	"$python" - "$temporary/credential-secret.before.json" "$temporary/credential-secret.json" <<'PY'
import json,sys
before,after=(json.load(open(path)) for path in sys.argv[1:])
for field in ("data","immutable","type"):
    assert before.get(field) == after.get(field), "management Git credential material changed during generation promotion"
assert before["metadata"]["uid"] == after["metadata"]["uid"], "management Git credential UID changed during generation promotion"
PY
fi
"$python" - "$temporary/credential-secret.json" "$management_id" "$cluster_uid" \
	"$platform_digest" "$image_inventory_digest" <<'PY'
import base64,json,sys
path,management,cluster,platform,images=sys.argv[1:]
value=json.load(open(path)); metadata=value["metadata"]
assert value.get("immutable") is True
assert metadata.get("annotations") == {
    "fleet.actor.dev/management-id":management,
    "fleet.actor.dev/management-cluster-uid":cluster,
    "fleet.actor.dev/management-platform-receipt-digest":platform,
    "fleet.actor.dev/image-inventory-digest":images,
}
data=value.get("data",{})
assert set(data) == {"publisher-username","publisher-password","reader-username","reader-password"}
assert base64.b64decode(data["publisher-username"],validate=True) == b"release-publisher"
assert base64.b64decode(data["reader-username"],validate=True) == b"argocd-reader"
assert all(len(base64.b64decode(data[name],validate=True)) == 64 for name in ("publisher-password","reader-password"))
PY
jq -er '.data["publisher-password"]' "$temporary/credential-secret.json" | base64 -d >"$publisher_password_file"
jq -er '.data["reader-password"]' "$temporary/credential-secret.json" | base64 -d >"$reader_password_file"
publisher_password=$(<"$publisher_password_file")
reader_password=$(<"$reader_password_file")

user_exists() {
	"${kube[@]}" -n actor-git-system exec actor-git-0 -- gitea admin user list \
		| awk 'NR > 1 {print $2}' | grep -Fx "$1" >/dev/null
}
if ! user_exists release-publisher; then
	"${kube[@]}" -n actor-git-system exec actor-git-0 -- gitea admin user create \
		--username release-publisher --password "$publisher_password" \
		--email release-publisher@invalid.local --must-change-password=false >/dev/null
fi
if ! user_exists argocd-reader; then
	"${kube[@]}" -n actor-git-system exec actor-git-0 -- gitea admin user create \
		--username argocd-reader --password "$reader_password" \
		--email argocd-reader@invalid.local --must-change-password=false >/dev/null
fi

"${kube[@]}" -n actor-git-system port-forward service/actor-git "$forward_port:3000" \
	>"$temporary/port-forward.log" 2>&1 &
forward_pid=$!
for _ in $(seq 1 60); do
	if curl --fail --silent "http://127.0.0.1:$forward_port/api/healthz" >/dev/null 2>&1; then break; fi
	sleep 1
done
curl --fail --silent "http://127.0.0.1:$forward_port/api/healthz" >/dev/null
api="http://127.0.0.1:$forward_port/api/v1"
repo_response=$temporary/repository.json
status=$(curl --silent --show-error -o "$repo_response" -w '%{http_code}' \
	--user "release-publisher:$publisher_password" "$api/repos/release-publisher/fleet-desired")
if [[ $status == 404 ]]; then
	curl --fail --silent --show-error --user "release-publisher:$publisher_password" \
		-X POST -H 'Content-Type: application/json' \
		-d '{"name":"fleet-desired","private":true,"auto_init":true,"default_branch":"main"}' \
		"$api/user/repos" >"$repo_response"
elif [[ $status != 200 ]]; then
	echo "management Git repository lookup failed with HTTP $status" >&2
	exit 1
fi
"$python" - "$repo_response" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
assert value.get("id") and value.get("private") is True
assert value.get("owner",{}).get("login") == "release-publisher"
assert value.get("default_branch") == "main"
PY
curl --fail --silent --show-error --user "release-publisher:$publisher_password" \
	-X PUT -H 'Content-Type: application/json' -d '{"permission":"read"}' \
	"$api/repos/release-publisher/fleet-desired/collaborators/argocd-reader" >/dev/null
curl --fail --silent --show-error --user "argocd-reader:$reader_password" \
	"$api/repos/release-publisher/fleet-desired" \
	| "$python" -c 'import json,sys; value=json.load(sys.stdin); assert value["private"] is True and value["permissions"]["pull"] is True and value["permissions"]["push"] is False'

repository_secret=actor-fleet-desired-repository
repository_existed=true
if ! "${kube[@]}" -n argocd get secret "$repository_secret" -o json >"$temporary/repository-secret.json" 2>/dev/null; then
	repository_existed=false
	printf '%s' git >"$temporary/repository-type"
	printf '%s' "$repository_url" >"$temporary/repository-url"
	"${kube[@]}" -n argocd create secret generic "$repository_secret" \
		--from-file=type="$temporary/repository-type" --from-file=url="$temporary/repository-url" \
		--from-file=username="$reader_user_file" --from-file=password="$reader_password_file" \
		--dry-run=client -o json \
		| jq --arg platform "$platform_digest" --arg cluster "$cluster_uid" \
			'.immutable=true | .metadata.labels={"argocd.argoproj.io/secret-type":"repository"} |
			 .metadata.annotations={
			  "fleet.actor.dev/management-platform-receipt-digest":$platform,
			  "fleet.actor.dev/management-cluster-uid":$cluster}' \
		| "${kube[@]}" create -f - >/dev/null
	"${kube[@]}" -n argocd get secret "$repository_secret" -o json >"$temporary/repository-secret.json"
fi
if [[ $repository_existed == true && $update_generation == true ]]; then
	cp "$temporary/repository-secret.json" "$temporary/repository-secret.before.json"
	"$python" - "$temporary/repository-secret.json" "$cluster_uid" \
		"$expected_previous_platform" "$platform_digest" <<'PY'
import json,sys
path,cluster,old_platform,new_platform=sys.argv[1:]
annotations=json.load(open(path))["metadata"].get("annotations",{})
old={"fleet.actor.dev/management-platform-receipt-digest":old_platform,"fleet.actor.dev/management-cluster-uid":cluster}
new={"fleet.actor.dev/management-platform-receipt-digest":new_platform,"fleet.actor.dev/management-cluster-uid":cluster}
if annotations not in (old,new): raise SystemExit("Argo repository Secret generation CAS failed")
print("current" if annotations == new else "promote")
PY
	if [[ $("$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["metadata"].get("annotations",{}).get("fleet.actor.dev/management-platform-receipt-digest",""))' "$temporary/repository-secret.json") == "$expected_previous_platform" ]]; then
		"${kube[@]}" -n argocd annotate --overwrite secret "$repository_secret" \
			"fleet.actor.dev/management-platform-receipt-digest=$platform_digest" >/dev/null
		"${kube[@]}" -n argocd get secret "$repository_secret" -o json >"$temporary/repository-secret.json"
	fi
	"$python" - "$temporary/repository-secret.before.json" "$temporary/repository-secret.json" <<'PY'
import json,sys
before,after=(json.load(open(path)) for path in sys.argv[1:])
for field in ("data","immutable","type"):
    assert before.get(field) == after.get(field), "Argo repository credential material changed during generation promotion"
assert before["metadata"]["uid"] == after["metadata"]["uid"], "Argo repository Secret UID changed during generation promotion"
PY
fi
"$python" - "$temporary/repository-secret.json" "$repository_url" "$reader_password_file" \
	"$platform_digest" "$cluster_uid" <<'PY'
import base64,json,sys
path,url,password_path,platform,cluster=sys.argv[1:]
value=json.load(open(path)); data=value.get("data",{}); metadata=value["metadata"]
decode=lambda name: base64.b64decode(data[name],validate=True)
assert value.get("immutable") is True
assert metadata.get("labels",{}).get("argocd.argoproj.io/secret-type") == "repository"
assert metadata.get("annotations") == {
    "fleet.actor.dev/management-platform-receipt-digest":platform,
    "fleet.actor.dev/management-cluster-uid":cluster,
}
assert decode("type") == b"git" and decode("url").decode() == url
assert decode("username") == b"argocd-reader"
assert decode("password") == open(password_path,"rb").read()
PY

credential_json=$temporary/publisher-credential.json
jq -cn --arg repository "$repository_url" --arg username release-publisher \
	--rawfile password "$publisher_password_file" \
	'{schema:"actor-management-git-publisher-credential/v1",repositoryURL:$repository,
	  username:$username,password:$password}' >"$credential_json"
if [[ -e $ACTOR_MANAGEMENT_GIT_CREDENTIAL ]]; then
	[[ -f $ACTOR_MANAGEMENT_GIT_CREDENTIAL && ! -L $ACTOR_MANAGEMENT_GIT_CREDENTIAL ]] && \
		cmp -s "$credential_json" "$ACTOR_MANAGEMENT_GIT_CREDENTIAL" || {
		echo "management Git publisher credential already exists with different content" >&2
		exit 1
	}
else
	install -m 0600 "$credential_json" "$ACTOR_MANAGEMENT_GIT_CREDENTIAL"
fi
chmod 0600 "$ACTOR_MANAGEMENT_GIT_CREDENTIAL"

repo_id=$(jq -er '.id' "$repo_response")
receipt=$temporary/install-receipt.json
jq -cn --arg management "$management_id" --arg cluster_id "$cluster_id" --arg cluster_uid "$cluster_uid" \
	--arg platform "$platform_digest" --arg images "$image_inventory_digest" --arg image "$expected_image" \
	--arg namespace_uid "$namespace_uid" --arg pull_uid "$pull_secret_uid" \
	--arg sts_uid "$(jq -er '.metadata.uid' "$temporary/statefulset.json")" \
	--arg pvc_uid "$(jq -er '.metadata.uid' "$temporary/pvc.json")" \
	--arg credential_uid "$(jq -er '.metadata.uid' "$temporary/credential-secret.json")" \
	--arg repository_secret_uid "$(jq -er '.metadata.uid' "$temporary/repository-secret.json")" \
	--arg repository "$repository_url" --arg repo_id "$repo_id" \
	--arg source "$(jq -er '.sourceSha256' "$temporary/render-receipt.json")" \
	--arg manifest "$(jq -er '.manifestSha256' "$temporary/render-receipt.json")" \
	--arg render "$(sha256sum "$temporary/render-receipt.json" | cut -d' ' -f1)" \
	'{schema:"actor-create-first-management-git/v1",verdict:"passed",managementId:$management,
	  cluster:{id:$cluster_id,uid:$cluster_uid},managementPlatformReceiptDigest:$platform,
	  imageInventoryDigest:$images,image:$image,
	  repository:{id:$repo_id,url:$repository,private:true,defaultBranch:"main",
	    publisherAccess:"owner",argocdAccess:"read-only"},
	  resources:{namespace:{name:"actor-git-system",uid:$namespace_uid,pullSecretUid:$pull_uid},
	    statefulSet:{name:"actor-git",uid:$sts_uid},pvc:{name:"actor-git-data",uid:$pvc_uid},
	    credentialSecret:{name:"actor-git-bootstrap-credentials",uid:$credential_uid},
	    argocdRepositorySecret:{name:"actor-fleet-desired-repository",uid:$repository_secret_uid}},
	  render:{sourceSha256:$source,manifestSha256:$manifest,receiptSha256:$render}}' >"$receipt"
if [[ -e $ACTOR_MANAGEMENT_GIT_RECEIPT ]]; then
	[[ -f $ACTOR_MANAGEMENT_GIT_RECEIPT && ! -L $ACTOR_MANAGEMENT_GIT_RECEIPT ]] && \
		cmp -s "$receipt" "$ACTOR_MANAGEMENT_GIT_RECEIPT" || {
		echo "management Git receipt already exists with different content" >&2
		exit 1
	}
elif ! ln "$receipt" "$ACTOR_MANAGEMENT_GIT_RECEIPT" 2>/dev/null; then
	[[ -f $ACTOR_MANAGEMENT_GIT_RECEIPT && ! -L $ACTOR_MANAGEMENT_GIT_RECEIPT ]] && \
		cmp -s "$receipt" "$ACTOR_MANAGEMENT_GIT_RECEIPT" || {
		echo "unable to publish immutable management Git receipt" >&2
		exit 1
	}
fi
chmod 0644 "$ACTOR_MANAGEMENT_GIT_RECEIPT"
printf 'management_git=passed management=%s repository=%s receipt=%s sha256=%s\n' \
	"$management_id" "$repository_url" "$ACTOR_MANAGEMENT_GIT_RECEIPT" \
	"$(sha256sum "$ACTOR_MANAGEMENT_GIT_RECEIPT" | cut -d' ' -f1)"
