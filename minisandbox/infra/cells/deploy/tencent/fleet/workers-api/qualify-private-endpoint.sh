#!/usr/bin/env bash
set -euo pipefail
umask 077

installation=${ACTOR_WORKERS_API_ENDPOINT_INSTALLATION_RECEIPT:?ACTOR_WORKERS_API_ENDPOINT_INSTALLATION_RECEIPT is required}
receipt=${ACTOR_WORKERS_API_ENDPOINT_QUALIFICATION_RECEIPT:?ACTOR_WORKERS_API_ENDPOINT_QUALIFICATION_RECEIPT is required}
allowed_instance=${ACTOR_WORKERS_API_ALLOWED_TAT_INSTANCE:?ACTOR_WORKERS_API_ALLOWED_TAT_INSTANCE is required}
denied_instances=${ACTOR_WORKERS_API_DENIED_TAT_INSTANCES:?ACTOR_WORKERS_API_DENIED_TAT_INSTANCES is required}
tat_run=${ACTOR_TAT_RUN:?ACTOR_TAT_RUN is required}
python=${PYTHON:-python3}
tccli=${TCCLI:-tccli}
region=${TENCENTCLOUD_REGION:-ap-beijing}

[[ -f $installation && ! -L $installation ]] || { echo "installation receipt must be a non-symlink regular file" >&2; exit 2; }
[[ $receipt == /* && -d $(dirname -- "$receipt") && ! -e $receipt ]] || {
	echo "qualification receipt must be a new absolute path with an existing parent" >&2
	exit 2
}
[[ $allowed_instance =~ ^ins-[A-Za-z0-9]+$ ]] || { echo "invalid allowed TAT instance" >&2; exit 2; }
[[ -x $tat_run ]] || { echo "ACTOR_TAT_RUN must be an executable file" >&2; exit 2; }
[[ $region =~ ^[a-z]+-[a-z]+$ ]] || { echo "invalid Tencent region" >&2; exit 2; }
for command in "$python" "$tccli" jq; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
	echo "PYTHON must select Python 3.10 or newer" >&2
	exit 2
}

IFS=, read -r -a denied_array <<<"$denied_instances"
[[ ${#denied_array[@]} -ge 2 ]] || { echo "at least two denied Cell probes are required" >&2; exit 2; }
declare -A seen=()
instance_ids=("$allowed_instance")
for index in "${!denied_array[@]}"; do
	value=${denied_array[$index]//[[:space:]]/}
	[[ $value =~ ^ins-[A-Za-z0-9]+$ && $value != "$allowed_instance" && -z ${seen[$value]:-} ]] || {
		echo "invalid or duplicate denied TAT instance" >&2
		exit 2
	}
	seen[$value]=1
	denied_array[$index]=$value
	instance_ids+=("$value")
done

readarray -t identity < <("$python" - "$installation" <<'PY'
import ipaddress
import json
import sys

value = json.load(open(sys.argv[1]))
if value.get("schema") != "actor-workers-api-private-endpoint-installation/v3" or value.get("verdict") != "installed":
    raise SystemExit("invalid private endpoint installation receipt")
endpoint = value.get("endpoint", "")
network = value.get("network", {})
if not endpoint.startswith("http://") or not endpoint.endswith(":6688"):
    raise SystemExit("invalid private endpoint URL")
address = endpoint.removeprefix("http://").removesuffix(":6688")
if not ipaddress.ip_address(address).is_private:
    raise SystemExit("endpoint is not private")
load_balancer = network.get("loadBalancerId", "")
security_group = network.get("securityGroupId", "")
if not load_balancer.startswith("lb-") or not security_group.startswith("sg-"):
    raise SystemExit("installation receipt lacks cloud identities")
print(endpoint)
print(address)
print(load_balancer)
print(security_group)
PY
)
[[ ${#identity[@]} -eq 4 ]] || { echo "failed to extract endpoint identity" >&2; exit 1; }
endpoint=${identity[0]}
endpoint_ip=${identity[1]}
load_balancer_id=${identity[2]}
security_group=${identity[3]}

temporary=$(mktemp -d /data/tmp/workers-api-endpoint-qualification.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

run_allowed_probe() {
	local output=$1
	export TAT_INSTANCE_ID=$allowed_instance
	printf '%s\n' \
		'set -euo pipefail' \
		"body=\$(curl --silent --show-error --connect-timeout 3 --max-time 10 '$endpoint/readyz')" \
		'test "$(printf "%s" "$body" | jq -r .status)" = ready' \
		'echo allowed_probe=passed' \
		| "$tat_run" --timeout 60 >"$output"
}

run_allowed_probe "$temporary/allow-before.log"

for index in "${!denied_array[@]}"; do
	export TAT_INSTANCE_ID=${denied_array[$index]}
	printf '%s\n' \
		'set -euo pipefail' \
		"if curl --silent --show-error --connect-timeout 3 --max-time 8 --output /dev/null '$endpoint/readyz'; then echo unexpected_http_response >&2; exit 1; fi" \
		'echo denied_probe=passed' \
		| "$tat_run" --timeout 60 >"$temporary/deny-$index.log"
done
run_allowed_probe "$temporary/allow-after.log"

"$tccli" clb DescribeLoadBalancers --region "$region" \
	--LoadBalancerIds "[\"$load_balancer_id\"]" >"$temporary/clb.json"
"$tccli" clb DescribeListeners --region "$region" \
	--LoadBalancerId "$load_balancer_id" >"$temporary/listeners.json"
instance_json=$(printf '%s\n' "${instance_ids[@]}" | "$python" -c 'import json,sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))')
"$tccli" cvm DescribeInstances --region "$region" \
	--InstanceIds "$instance_json" >"$temporary/instances.json"

"$python" - "$installation" "$temporary/clb.json" "$temporary/listeners.json" "$temporary/instances.json" \
	"$temporary" "$receipt" "$endpoint_ip" "$load_balancer_id" "$security_group" \
	"$allowed_instance" "${denied_array[@]}" <<'PY'
import datetime
import hashlib
import ipaddress
import json
import os
import sys
import tempfile

installation_path, clb_path, listeners_path, instances_path, logs, output, endpoint_ip, load_balancer_id, security_group, allowed, *denied = sys.argv[1:]
installation_bytes = open(installation_path, "rb").read()
installation = json.loads(installation_bytes)
clb_items = json.load(open(clb_path)).get("LoadBalancerSet", [])
if len(clb_items) != 1:
    raise SystemExit("Tencent CLB query did not return exactly one instance")
clb = clb_items[0]
if clb.get("LoadBalancerId") != load_balancer_id:
    raise SystemExit("Tencent CLB identity differs")
if clb.get("LoadBalancerVips") != [endpoint_ip]:
    raise SystemExit("Tencent CLB VIP differs")
if clb.get("SecureGroups") != [security_group]:
    raise SystemExit("Tencent CLB does not have the exact qualified security group")
if clb.get("LoadBalancerType") != "INTERNAL":
    raise SystemExit("Workers API CLB is not internal")
listeners = json.load(open(listeners_path)).get("Listeners", [])
if len(listeners) != 1:
    raise SystemExit("Workers API CLB must have exactly one listener")
listener = listeners[0]
health = listener.get("HealthCheck", {})
if (
    listener.get("Protocol") != "TCP"
    or listener.get("Port") != 6688
    or listener.get("TargetType") != "NODE"
    or health.get("HealthSwitch") != 1
    or not isinstance(health.get("IntervalTime"), int)
    or not isinstance(health.get("UnHealthNum"), int)
):
    raise SystemExit("Workers API CLB listener differs from the qualified TCP/6688 contract")

instances = json.load(open(instances_path)).get("InstanceSet", [])
by_id = {item.get("InstanceId"): item for item in instances}
if set(by_id) != {allowed, *denied}:
    raise SystemExit("CVM probe identity set differs")
clb_vpc = clb.get("VpcId")
if by_id[allowed].get("VirtualPrivateCloud", {}).get("VpcId") != clb_vpc:
    raise SystemExit("allowed probe is not in the CLB VPC")
for instance_id in denied:
    if by_id[instance_id].get("VirtualPrivateCloud", {}).get("VpcId") == clb_vpc:
        raise SystemExit("denied probe unexpectedly belongs to the CLB VPC")

def log_evidence(name):
    raw = open(os.path.join(logs, name), "rb").read()
    if b"_probe=passed" not in raw:
        raise SystemExit(f"probe log did not pass: {name}")
    return {"bytes": len(raw), "sha256": "sha256:" + hashlib.sha256(raw).hexdigest()}

value = {
    "schema": "actor-workers-api-private-endpoint-qualification/v3",
    "verdict": "passed",
    "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "installationReceipt": {
        "sha256": "sha256:" + hashlib.sha256(installation_bytes).hexdigest(),
        "serviceUid": installation["service"]["uid"],
    },
    "cloud": {
        "region": clb.get("TargetRegionInfo", {}).get("Region", "") or "ap-beijing",
        "loadBalancerId": load_balancer_id,
        "loadBalancerType": clb["LoadBalancerType"],
        "vpcId": clb_vpc,
        "vip": endpoint_ip,
        "securityGroups": clb["SecureGroups"],
        "listener": {
            "id": listener["ListenerId"], "protocol": listener["Protocol"],
            "port": listener["Port"], "targetType": listener["TargetType"],
            "healthIntervalSeconds": health["IntervalTime"],
            "unhealthyThreshold": health["UnHealthNum"],
        },
    },
    "probes": {
        "allowed": {
            "instanceId": allowed,
            "vpcId": by_id[allowed]["VirtualPrivateCloud"]["VpcId"],
            "result": "ready-before-and-after-denials",
            "before": log_evidence("allow-before.log"),
            "after": log_evidence("allow-after.log"),
        },
        "denied": [
            {
                "instanceId": instance_id,
                "vpcId": by_id[instance_id]["VirtualPrivateCloud"]["VpcId"],
                "result": "no-http-response",
                **log_evidence(f"deny-{index}.log"),
            }
            for index, instance_id in enumerate(denied)
        ],
    },
}
descriptor, staged = tempfile.mkstemp(prefix="." + os.path.basename(output) + ".", dir=os.path.dirname(output))
try:
    os.fchmod(descriptor, 0o644)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.link(staged, output)
finally:
    try:
        os.unlink(staged)
    except FileNotFoundError:
        pass
PY

printf 'workers_api_private_endpoint_qualification=passed receipt=%s\n' "$receipt"
