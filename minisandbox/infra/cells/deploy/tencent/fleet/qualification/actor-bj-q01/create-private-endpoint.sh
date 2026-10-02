#!/usr/bin/env bash
set -euo pipefail

tccli=${TCCLI:-tccli}
region=${TENCENT_REGION:-ap-beijing}
cluster_id=${QUALIFICATION_CLUSTER_ID:?QUALIFICATION_CLUSTER_ID is required}
subnet_id=${QUALIFICATION_API_SUBNET_ID:-subnet-qljvksy9}
security_group=${QUALIFICATION_API_SECURITY_GROUP:-sg-jfy27iab}
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
bootstrap_state=$state_dir/bootstrap-node.json

for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY; do
	[[ -n ${!variable:-} ]] || {
		echo "$variable must be supplied through the protected environment" >&2
		exit 2
	}
done
[[ $cluster_id =~ ^cls-[a-z0-9]+$ ]]
mkdir -p "$state_dir"
chmod 0700 "$state_dir"

wait_for_bootstrap_node() {
	[[ -s $bootstrap_state ]] || {
		echo "bootstrap node state is required before creating the private endpoint" >&2
		exit 1
	}
	[[ $(jq -r '.ClusterId // empty' "$bootstrap_state") == "$cluster_id" ]] || {
		echo "bootstrap node belongs to a different cluster" >&2
		exit 1
	}
	instance_id=$(jq -er '.InstanceIdSet | select(length == 1) | .[0]' "$bootstrap_state")
	[[ $instance_id =~ ^ins-[a-z0-9]+$ ]]
	deadline=$((SECONDS + 900))
	while ((SECONDS < deadline)); do
		instance=$(
			"$tccli" cvm DescribeInstances --region "$region" \
				--InstanceIds "[\"$instance_id\"]"
		)
		case $(jq -r '.InstanceSet[0].InstanceState // "MISSING"' <<<"$instance") in
		RUNNING) return ;;
		PENDING | LAUNCH_FAILED) sleep 5 ;;
		*)
			jq '{InstanceSet: [.InstanceSet[]? | {InstanceId,InstanceState}]}' <<<"$instance" >&2
			exit 1
			;;
		esac
	done
	echo "bootstrap node did not become RUNNING before endpoint timeout" >&2
	exit 1
}

cluster=$(
	"$tccli" tke DescribeClusters --region "$region" --ClusterIds "[\"$cluster_id\"]"
)
[[ $(jq -r '.Clusters[0].ClusterName' <<<"$cluster") == actor-serverless-qual-bj ]]
[[ $(jq -r '.Clusters[0].ClusterStatus' <<<"$cluster") == Running ]]

status=$(
	"$tccli" tke DescribeClusterEndpointStatus --region "$region" \
		--ClusterId "$cluster_id" --IsExtranet false
)
case $(jq -r '.Status' <<<"$status") in
NotFound)
	wait_for_bootstrap_node
	"$tccli" tke CreateClusterEndpoint --region "$region" \
		--ClusterId "$cluster_id" --SubnetId "$subnet_id" \
		--IsExtranet false --SecurityGroup "$security_group" >/dev/null
	;;
CreateFailed | TimeOut)
	# An empty managed cluster cannot run TKE's enilb-controller. Permit only
	# that known bootstrap failure to be retried after a bootstrap node joins.
	error_message=$(jq -r '.ErrorMsg' <<<"$status")
	[[ $error_message == *enilb-controller* || $error_message == *"timeout"* ]] || {
		jq '{Status,ErrorMsg}' <<<"$status" >&2
		exit 1
	}
	wait_for_bootstrap_node
	"$tccli" tke CreateClusterEndpoint --region "$region" \
		--ClusterId "$cluster_id" --SubnetId "$subnet_id" \
		--IsExtranet false --SecurityGroup "$security_group" >/dev/null
	;;
Created | Creating) ;;
*)
	jq '{Status,ErrorMsg}' <<<"$status" >&2
	exit 1
	;;
esac

deadline=$((SECONDS + 900))
while ((SECONDS < deadline)); do
	status=$(
		"$tccli" tke DescribeClusterEndpointStatus --region "$region" \
			--ClusterId "$cluster_id" --IsExtranet false
	)
	case $(jq -r '.Status' <<<"$status") in
	Created) break ;;
	Creating) sleep 5 ;;
	*)
		jq '{Status,ErrorMsg}' <<<"$status" >&2
		exit 1
		;;
	esac
done
[[ $(jq -r '.Status' <<<"$status") == Created ]]

"$tccli" tke DescribeClusterEndpoints --region "$region" --ClusterId "$cluster_id" \
	>"$state_dir/endpoints.json"
chmod 0600 "$state_dir/endpoints.json"
jq -e '{ClusterIntranetEndpoint,ClusterIntranetDomain,ClusterIntranetSubnetId,IntranetSecurityGroup}
  | select(.ClusterIntranetEndpoint != "" and .ClusterIntranetSubnetId != "")' \
	"$state_dir/endpoints.json"
