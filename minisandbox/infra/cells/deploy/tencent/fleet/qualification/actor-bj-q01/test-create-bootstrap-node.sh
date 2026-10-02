#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d /data/tmp/q01-bootstrap-test.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
mkdir -p "$temporary/bin" "$temporary/state"
cat >"$temporary/bin/tccli" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
service=$1 action=$2; shift 2
case "$service/$action" in
cvm/DescribeInstances)
  if [[ " $* " == *" --InstanceIds "* ]]; then
    if [[ " $* " == *ins-newnode* && -f $MOCK_ROOT/created ]]; then
      echo '{"TotalCount":1,"InstanceSet":[{"InstanceId":"ins-newnode","InstanceName":"actor-bj-q01-bootstrap","InstanceState":"RUNNING"}]}'
    else
      echo '{"TotalCount":0,"InstanceSet":[]}'
    fi
  else
    echo '{"TotalCount":0,"InstanceSet":[]}'
  fi
  ;;
tke/DescribeClusterInstances)
  if [[ -f $MOCK_ROOT/created ]]; then
    echo '{"TotalCount":1,"InstanceSet":[{"InstanceId":"ins-newnode","InstanceState":"running"}]}'
  else
    echo '{"TotalCount":0,"InstanceSet":[]}'
  fi
  ;;
tat/DescribeAutomationAgentStatus)
  echo '{"TotalCount":1,"AutomationAgentSet":[{"InstanceId":"ins-newnode","AgentStatus":"Online","Environment":"Linux"}]}'
  ;;
tke/CreateClusterInstances)
  input=
  while (($#)); do
    if [[ $1 == --cli-input-json ]]; then input=${2#file://}; break; fi
    shift
  done
  jq -er '.RunInstancePara | fromjson | .ClientToken' "$input" >>"$MOCK_ROOT/create-tokens"
  touch "$MOCK_ROOT/created"
  echo '{"InstanceIdSet":["ins-newnode"],"RequestId":"mock"}'
  ;;
*) echo "unexpected mock tccli call: $service/$action" >&2; exit 2 ;;
esac
MOCK
chmod 0755 "$temporary/bin/tccli"
printf '{"InstanceIdSet":["ins-deadnode"],"ClusterId":"cls-mock"}\n' >"$temporary/state/bootstrap-node.json"

export MOCK_ROOT=$temporary
export PATH="$temporary/bin:$PATH"
export TENCENTCLOUD_SECRET_ID=redacted-test-id
export TENCENTCLOUD_SECRET_KEY=redacted-test-key
QUALIFICATION_CLUSTER_ID=cls-mock QUALIFICATION_STATE_DIR="$temporary/state" TCCLI=tccli \
  "$script_dir/create-bootstrap-node.sh" >/dev/null

[[ $(jq -r '.InstanceIdSet[0]' "$temporary/state/bootstrap-node.json") == ins-newnode ]]
[[ $(find "$temporary/state" -maxdepth 1 -name 'bootstrap-node-retired-*-ins-deadnode.json' | wc -l) == 1 ]]
[[ ! -e $temporary/state/bootstrap-node-intent.json ]]
[[ $(wc -l <"$temporary/create-tokens") == 1 ]]
token=$(<"$temporary/create-tokens")
[[ $token =~ ^actor-bj-q01-bootstrap-[0-9a-f]{32}$ ]]

# A converged rerun must use live CVM/TKE/TAT evidence and never issue another
# paid creation request.
QUALIFICATION_CLUSTER_ID=cls-mock QUALIFICATION_STATE_DIR="$temporary/state" TCCLI=tccli \
  "$script_dir/create-bootstrap-node.sh" >/dev/null
[[ $(wc -l <"$temporary/create-tokens") == 1 ]]
echo 'q01 bootstrap replacement convergence: pass'
