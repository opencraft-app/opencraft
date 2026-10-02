#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || { echo "Usage: publish-desired-state.sh RELEASE_DIRECTORY COMMIT_MESSAGE" >&2; exit 2; }
release_dir=$(readlink -e "$1")
commit_message=$2
[[ -d $release_dir && $commit_message != *$'\n'* && -n $commit_message ]]
state_dir=${ACTOR_GIT_STATE_DIR:-/data/actor-qualification/git}
credential_file=$state_dir/credentials.json
target_relative=${ACTOR_GIT_TARGET_PATH:-releases/actor-bj-q01/current}
case "$target_relative" in
	releases/actor-bj-q01/current|platform/actor-bj-q01/current) ;;
	*) echo "ACTOR_GIT_TARGET_PATH is outside the reviewed q01 desired-state roots" >&2; exit 2 ;;
esac
export KUBECONFIG=${KUBECONFIG:-/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig}
[[ -s $credential_file && $(stat -c %a "$credential_file") == 600 ]]
publisher_token=$(python3 -c 'import json,sys; value=json.load(open(sys.argv[1]))["publisher"]["token"]; assert len(value) > 20; print(value)' "$credential_file")

temporary=$(mktemp -d /data/tmp/q01-desired-state.XXXXXX)
forward_log=$temporary/port-forward.log
cleanup(){
	if [[ -n ${forward_pid:-} ]]; then
		kill "$forward_pid" 2>/dev/null || true
		wait "$forward_pid" 2>/dev/null || true
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM
kubectl -n actor-git-system port-forward service/actor-git 30090:3000 >"$forward_log" 2>&1 &
forward_pid=$!
for _ in $(seq 1 30); do
	curl --fail --silent http://127.0.0.1:30090/api/healthz >/dev/null 2>&1 && break
	sleep 1
done

askpass=$temporary/askpass.sh
cat >"$askpass" <<'ASKPASS'
#!/usr/bin/env sh
case "$1" in
	*sername*) printf '%s\n' release-publisher ;;
	*) printf '%s\n' "$ACTOR_GIT_PUBLISH_TOKEN" ;;
esac
ASKPASS
chmod 0700 "$askpass"
export ACTOR_GIT_PUBLISH_TOKEN=$publisher_token GIT_ASKPASS=$askpass GIT_TERMINAL_PROMPT=0
repo=$temporary/repo
git clone --quiet http://127.0.0.1:30090/release-publisher/fleet-desired.git "$repo"
target=$repo/$target_relative
mkdir -p "$target"
rsync -a --delete "$release_dir/" "$target/"
git -C "$repo" add "$target_relative"
if git -C "$repo" diff --cached --quiet; then
	commit=$(git -C "$repo" rev-parse HEAD)
	changed=false
else
	git -C "$repo" -c user.name='Actor Release Publisher' \
		-c user.email='release-publisher@invalid.local' commit --quiet -m "$commit_message"
	commit=$(git -C "$repo" rev-parse HEAD)
	git -C "$repo" push --quiet origin HEAD:refs/heads/main
	changed=true
fi
printf 'desired_state=published commit=%s changed=%s path=%s\n' "$commit" "$changed" "$target_relative"
