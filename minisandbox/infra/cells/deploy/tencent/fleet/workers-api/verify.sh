#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
rendered=$(mktemp)
trap 'rm -f "${rendered}"' EXIT
kubectl kustomize "${script_dir}" >"${rendered}"

python3 - "${rendered}" <<'PY'
import sys
import yaml

documents = [document for document in yaml.safe_load_all(open(sys.argv[1])) if document]
deployment = next(document for document in documents if document["kind"] == "Deployment")
pdb = next(document for document in documents if document["kind"] == "PodDisruptionBudget")
hpa = next(document for document in documents if document["kind"] == "HorizontalPodAutoscaler")
services = {
    document["metadata"]["name"]: document
    for document in documents if document["kind"] == "Service"
}
service = services["workers-api"]
object_router = services["workers-object-router"]
config = next(document for document in documents if document["kind"] == "ConfigMap")
cluster_role = next(document for document in documents if document["kind"] == "ClusterRole")
route_role = next(document for document in documents if document["kind"] == "Role")
spec = deployment["spec"]
pod = spec["template"]["spec"]
container = pod["containers"][0]

assert spec["replicas"] == 3
assert spec["strategy"]["rollingUpdate"] == {"maxUnavailable": 1, "maxSurge": 0}
assert pdb["spec"]["maxUnavailable"] == 1
assert hpa["spec"]["scaleTargetRef"] == {"apiVersion": "apps/v1", "kind": "Deployment", "name": "workers-api"}
assert hpa["spec"]["minReplicas"] == 3 and hpa["spec"]["maxReplicas"] == 30
assert hpa["spec"]["behavior"]["scaleDown"]["stabilizationWindowSeconds"] == 300
pod_metrics = {item["pods"]["metric"]["name"] for item in hpa["spec"]["metrics"] if item["type"] == "Pods"}
assert pod_metrics == {"workers_api_routing_requests_per_second", "workers_api_routing_requests_in_flight"}
resource_metrics = {item["resource"]["name"] for item in hpa["spec"]["metrics"] if item["type"] == "Resource"}
assert resource_metrics == {"cpu", "memory"}
assert service["spec"]["type"] == "ClusterIP"
assert object_router["spec"]["type"] == "ClusterIP"
assert object_router["spec"]["ports"] == [{
    "name": "object-router", "port": 8081, "targetPort": "object-router"
}]
assert "engine-a-url" not in config["data"]
assert "engine-b-url" not in config["data"]
assert "stateless-a-url" not in config["data"]
assert "stateless-b-url" not in config["data"]
assert config["data"]["engine-cell-a"] == "__ENGINE_CELL_A__"
assert config["data"]["engine-cell-b"] == "__ENGINE_CELL_B__"
assert config["data"]["engine-cell-uid-a"] == "__ENGINE_CELL_UID_A__"
assert config["data"]["engine-cell-uid-b"] == "__ENGINE_CELL_UID_B__"
assert config["data"]["placement-pool-uid"] == "__PLACEMENT_POOL_UID__"
assert config["data"]["placement-pool"] == "__PLACEMENT_POOL__"
assert "--registry-url=$(REGISTRY_URL)" in container["args"]
assert "--engine-cell=$(ENGINE_CELL_A)" in container["args"]
assert "--engine-cell=$(ENGINE_CELL_B)" in container["args"]
assert "--engine-cell-uid=$(ENGINE_CELL_UID_A)" in container["args"]
assert "--engine-cell-uid=$(ENGINE_CELL_UID_B)" in container["args"]
assert container["args"].count("--engine-pool-uid=$(PLACEMENT_POOL_UID)") == 2
assert "--engine-token=$(ENGINE_A_TOKEN)" in container["args"]
assert "--engine-token=$(ENGINE_B_TOKEN)" in container["args"]
assert "--internal-token=$(REGISTRY_TOKEN)" in container["args"]
assert "--internal-listen-address=:8081" in container["args"]
assert "--object-router-token=$(OBJECT_ROUTER_A_TOKEN)" in container["args"]
assert "--object-router-token=$(OBJECT_ROUTER_B_TOKEN)" in container["args"]
assert not any(item.startswith("--engine-url=") for item in container["args"])
assert not any(item.startswith("--stateless-executor-url=") for item in container["args"])
assert "--serving-route-refresh-interval=1s" in container["args"]
assert "--stateless-executor-token=$(STATELESS_A_TOKEN)" in container["args"]
assert "--stateless-executor-token=$(STATELESS_B_TOKEN)" in container["args"]
assert "--object-miss-capacity=4096" in container["args"]
assert "--placement-pool=$(PLACEMENT_POOL)" in container["args"]
assert "--actor-cache-capacity=32768" in container["args"]
assert "--actor-cache-idle-ttl=10m" in container["args"]
assert pod["automountServiceAccountToken"] is True
assert pod["terminationGracePeriodSeconds"] == 50
assert container["lifecycle"]["preStop"]["sleep"]["seconds"] == 30
assert cluster_role["rules"] == [{"apiGroups": ["fleet.actor.dev"], "resources": ["shardpools", "rivetcells"], "verbs": ["get"]}]
assert route_role["rules"][0]["verbs"] == ["get", "list"]
assert "resourceNames" not in route_role["rules"][0]
assert container["image"] == "__WORKERS_API_IMAGE_DIGEST__"
assert container["securityContext"]["readOnlyRootFilesystem"] is True
assert container["securityContext"]["capabilities"]["drop"] == ["ALL"]
assert pod["affinity"]["podAntiAffinity"]["preferredDuringSchedulingIgnoredDuringExecution"]
assert pod["topologySpreadConstraints"][0]["whenUnsatisfiable"] == "DoNotSchedule"
assert deployment["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/topology-policy"] == "zone-drain-first-v1"
assert pod["affinity"]["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"]
secret_keys = {
    item["name"]: item["valueFrom"]["secretKeyRef"]["key"]
    for item in container["env"] if "valueFrom" in item and "secretKeyRef" in item["valueFrom"]
}
assert secret_keys["REGISTRY_TOKEN"] == "registry-token"
assert secret_keys["ENGINE_A_TOKEN"] == "engine-a-token"
assert secret_keys["ENGINE_B_TOKEN"] == "engine-b-token"
assert secret_keys["STATELESS_A_TOKEN"] == "stateless-a-token"
assert secret_keys["STATELESS_B_TOKEN"] == "stateless-b-token"
assert secret_keys["OBJECT_ROUTER_A_TOKEN"] == "object-router-a-token"
assert secret_keys["OBJECT_ROUTER_B_TOKEN"] == "object-router-b-token"
print("workers-api production manifest: PASS")
PY
python3 "$script_dir/qualify-public-admission.py" --help >/dev/null
(
	cd "$script_dir"
	PYTHONPATH="$script_dir" python3 -m unittest \
		test_render test_qualify_public_admission test_credentials_contract test_sync_credentials test_build_via_tat
)
python3 "$script_dir/test_install.py"
bash -n "$script_dir/sync-credentials.sh" "$script_dir/gitops/publish.sh" \
	"$script_dir/gitops/install-application.sh" "$script_dir/gitops/recertify-live-convergence.sh" \
	"$script_dir/gitops/rollback-failed-bootstrap.sh"
(
	cd "$script_dir/gitops"
	PYTHONPATH="$script_dir/gitops" python3 -m unittest test_gitops test_serving_recertification
)
