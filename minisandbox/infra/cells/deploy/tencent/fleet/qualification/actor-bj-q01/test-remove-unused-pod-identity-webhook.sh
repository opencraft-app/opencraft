#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d "${TMPDIR:-/data/tmp}/q01-identity-cleanup-test.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT INT TERM
mock=$temporary/kubectl
calls=$temporary/calls
state=$temporary/state

cat >"$mock" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$MOCK_CALLS"
args=" $* "
if [[ $args == *" -n actor-fdb-cell-system get deployment actor-bj-q01-runtime-capacity -o json "* ]]; then
  printf '%s\n' '{"status":{"readyReplicas":1},"spec":{"template":{"spec":{"volumes":[{"name":"tke-oidc-token","projected":{"sources":[{"serviceAccountToken":{"audience":"sts.cloud.tencent.com","path":"token"}}]}}],"containers":[{"env":[{"name":"TKE_WEB_IDENTITY_TOKEN_FILE","value":"/var/run/secrets/cloud.tencent.com/serviceaccount/token"}]}]}}}}'
elif [[ $args == *" get deployment pod-identity-webhook -o json "* ]]; then
  [[ ! -e $MOCK_STATE ]] || exit 1
  printf '%s\n' '{"metadata":{"labels":{"app.kubernetes.io/managed-by":"Helm","helm.sh/chart":"pod-identity-webhook-0.2.0"},"annotations":{"meta.helm.sh/release-name":"pod-identity-webhook"}},"spec":{"template":{"spec":{"containers":[{"image":"ccr.ccs.tencentyun.com/tkeimages/pod-identity-webhook:v0.2.0"}]}}}}'
elif [[ $args == *" get mutatingwebhookconfiguration pod-identity-webhook -o json "* ]]; then
  [[ ! -e $MOCK_STATE ]] || exit 1
  printf '%s\n' '{"webhooks":[{"failurePolicy":"Ignore","clientConfig":{"url":"https://pod-identity-webhook:443/mutate--v1-pod"}}]}'
elif [[ $args == *" get secret sh.helm.release.v1.pod-identity-webhook.v1 -o json "* ]]; then
  [[ ! -e $MOCK_STATE ]] || exit 1
  printf '%s\n' '{"metadata":{"labels":{"owner":"helm","name":"pod-identity-webhook","status":"deployed","version":"1"}}}'
elif [[ $args == *" delete secret sh.helm.release.v1.pod-identity-webhook.v1 "* ]]; then
  touch "$MOCK_STATE"
elif [[ $args == *" delete "* || $args == *" rollout status "* ]]; then
  :
else
  echo "unexpected kubectl invocation: $*" >&2
  exit 2
fi
MOCK
chmod +x "$mock"

export KUBECONFIG=$temporary/q01.kubeconfig
export KUBECTL=$mock
export MOCK_CALLS=$calls
export MOCK_STATE=$state
: >"$KUBECONFIG"

"$script_dir/remove-unused-pod-identity-webhook.sh" >"$temporary/first.out"
grep -Fq 'removed unused incomplete TKE pod identity webhook' "$temporary/first.out"
grep -Fq 'delete mutatingwebhookconfiguration pod-identity-webhook --wait=true' "$calls"
grep -Fq 'rollout status deployment/actor-bj-q01-runtime-capacity --timeout=120s' "$calls"

"$script_dir/remove-unused-pod-identity-webhook.sh" >"$temporary/second.out"
grep -Fq 'unused pod identity webhook is already absent' "$temporary/second.out"
