#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
request=$script_dir/bootstrap-node-request.json
tccli=${TCCLI:-tccli}
region=${TENCENT_REGION:-ap-beijing}
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
cluster_id=${QUALIFICATION_CLUSTER_ID:?QUALIFICATION_CLUSTER_ID is required}
instance_name=actor-bj-q01-bootstrap
state=$state_dir/bootstrap-node.json
intent=$state_dir/bootstrap-node-intent.json
[[ $cluster_id =~ ^cls-[a-z0-9]+$ ]]

for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected environment" >&2; exit 2; }
done
for command in "$tccli" jq python3 flock; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
mkdir -p "$state_dir"
chmod 0700 "$state_dir"
exec 9>"$state_dir/bootstrap-node.lock"
flock 9

instance_is_live() {
	local instance_id=$1 response
	response=$("$tccli" cvm DescribeInstances --region "$region" --InstanceIds "[\"$instance_id\"]") || return 1
	jq -e --arg id "$instance_id" --arg name "$instance_name" '
      .TotalCount == 1 and .InstanceSet[0].InstanceId == $id and
      .InstanceSet[0].InstanceName == $name and .InstanceSet[0].InstanceState == "RUNNING"
    ' <<<"$response" >/dev/null
}

instance_is_cluster_member() {
	local instance_id=$1 response
	response=$("$tccli" tke DescribeClusterInstances --region "$region" --ClusterId "$cluster_id" --Limit 100) || return 1
	jq -e --arg id "$instance_id" '
      [.InstanceSet[] | select(.InstanceId == $id and .InstanceState == "running")] | length == 1
    ' <<<"$response" >/dev/null
}

tat_is_online() {
	local instance_id=$1 response
	response=$("$tccli" tat DescribeAutomationAgentStatus --region "$region" --InstanceIds "[\"$instance_id\"]") || return 1
	jq -e --arg id "$instance_id" '
      .TotalCount == 1 and .AutomationAgentSet[0].InstanceId == $id and
      .AutomationAgentSet[0].AgentStatus == "Online" and .AutomationAgentSet[0].Environment == "Linux"
    ' <<<"$response" >/dev/null
}

write_state() {
	local source=$1 temporary_state
	temporary_state=$(mktemp "$state_dir/.bootstrap-node.XXXXXX")
	jq --arg cluster_id "$cluster_id" '. + {ClusterId:$cluster_id}' "$source" >"$temporary_state"
	chmod 0600 "$temporary_state"
	mv -f "$temporary_state" "$state"
}

wait_ready() {
	local instance_id=$1 deadline=$((SECONDS + 1200))
	until instance_is_live "$instance_id" && instance_is_cluster_member "$instance_id" && tat_is_online "$instance_id"; do
		((SECONDS < deadline)) || { echo "q01 bootstrap replacement did not become CVM/TKE/TAT ready" >&2; return 1; }
		sleep 10
	done
}

if [[ -s $state && $(jq -r '.ClusterId // empty' "$state") == "$cluster_id" ]]; then
	instance_id=$(jq -er '.InstanceIdSet | select(length == 1) | .[0] | select(test("^ins-[a-z0-9]+$"))' "$state")
	if instance_is_live "$instance_id" && instance_is_cluster_member "$instance_id" && tat_is_online "$instance_id"; then
		jq '{InstanceIdSet}' "$state"
		exit 0
	fi
	# Preserve the stale identity as evidence instead of overwriting the only
	# record explaining why the trusted operator endpoint was replaced.
	retired="$state_dir/bootstrap-node-retired-$(date -u +%Y%m%dT%H%M%SZ)-${instance_id}.json"
	install -m 0600 "$state" "$retired"
	rm -f "$state"
fi

# Adopt a response-lost creation only when the exact q01 name resolves to one
# unambiguous instance that also belongs to this exact TKE cluster.
existing=$("$tccli" cvm DescribeInstances --region "$region" \
	--Filters "[{\"Name\":\"instance-name\",\"Values\":[\"$instance_name\"]}]" --Limit 100)
mapfile -t candidates < <(jq -r '.InstanceSet[] | select(.InstanceState != "TERMINATED") | .InstanceId' <<<"$existing")
if ((${#candidates[@]} > 1)); then
	echo "multiple live q01 bootstrap candidates exist; refusing ambiguous adoption" >&2
	exit 1
elif ((${#candidates[@]} == 1)); then
	instance_id=${candidates[0]}
	wait_ready "$instance_id"
	temporary_response=$(mktemp "$state_dir/.bootstrap-adopt.XXXXXX")
	printf '{"InstanceIdSet":["%s"]}\n' "$instance_id" >"$temporary_response"
	write_state "$temporary_response"
	rm -f "$temporary_response" "$intent"
	jq '{InstanceIdSet}' "$state"
	exit 0
fi

# Persist the idempotency token before creation. If the API response is lost,
# retry exactly the same Tencent request instead of creating a second instance.
if [[ ! -s $intent || $(jq -r '.ClusterId // empty' "$intent" 2>/dev/null) != "$cluster_id" ]]; then
	client_token=$(python3 -c 'import uuid; print("actor-bj-q01-bootstrap-" + uuid.uuid4().hex)')
	temporary_intent=$(mktemp "$state_dir/.bootstrap-intent.XXXXXX")
	jq -n --arg cluster "$cluster_id" --arg token "$client_token" --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		'{ClusterId:$cluster,ClientToken:$token,CreatedAt:$created}' >"$temporary_intent"
	chmod 0600 "$temporary_intent"
	mv -f "$temporary_intent" "$intent"
fi
client_token=$(jq -er --arg cluster "$cluster_id" '
  select(.ClusterId == $cluster) | .ClientToken |
  select(test("^actor-bj-q01-bootstrap-[0-9a-f]{32}$"))
' "$intent")

request_json=$(jq --arg cluster_id "$cluster_id" --arg client_token "$client_token" '
  .ClusterId = $cluster_id |
  (.RunInstancePara | fromjson) as $instance |
  .RunInstancePara = ($instance | .ClientToken = $client_token | tojson)
' "$request")
temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
printf '%s' "$request_json" >"$temporary/request.json"
response=$("$tccli" tke CreateClusterInstances --region "$region" --cli-input-json "file://$temporary/request.json")
jq -e '.InstanceIdSet | length == 1 and all(.[]; test("^ins-[a-z0-9]+$"))' <<<"$response" >/dev/null
instance_id=$(jq -r '.InstanceIdSet[0]' <<<"$response")
wait_ready "$instance_id"
printf '%s' "$response" >"$temporary/response.json"
write_state "$temporary/response.json"
rm -f "$intent"
jq '{InstanceIdSet}' "$state"
