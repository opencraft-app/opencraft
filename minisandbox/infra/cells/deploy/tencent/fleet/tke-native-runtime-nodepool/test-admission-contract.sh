#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root"
temporary=$(mktemp -d "$temporary_root/runtime-admission-test.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

kubectl kustomize "$script_dir/overlays/actor-bj-q01" >"$temporary/q01-machineset.yaml"
kubectl kustomize "$script_dir/overlays/actor-bj-k01" >"$temporary/k01-machineset.yaml"
python3 - "$temporary/q01-machineset.yaml" "$temporary/k01-machineset.yaml" "$fleet_dir/qualification/actor-bj-q01/workerd-autoscaling.yaml" "$fleet_dir/runtime/runtime.yaml" "$fleet_dir/runtime/admission-controller.yaml" <<'PY'
import sys
from pathlib import Path
import yaml

pending = {"key": "fleet.actor.dev/runtime-admission", "value": "pending", "effect": "NoSchedule"}
for manifest in sys.argv[1:3]:
    machine_set = yaml.safe_load(Path(manifest).read_text())
    assert machine_set["spec"].get("deletePolicy") == "Newest", manifest
    taints = machine_set["spec"]["template"]["spec"].get("taints", [])
    assert pending in taints, (manifest, taints)

documents = list(yaml.safe_load_all(Path(sys.argv[3]).read_text()))
assert not any(item and item.get("metadata", {}).get("name") == "actor-bj-q01-runtime-capacity" for item in documents)

runtime_documents = list(yaml.safe_load_all(Path(sys.argv[4]).read_text()))
runtime = next(item for item in runtime_documents if item and item.get("kind") == "StatefulSet" and item["metadata"]["name"] == "actor-bj-k01-runtime-hosts")
pod_spec = runtime["spec"]["template"]["spec"]
terms = pod_spec["affinity"]["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"]["nodeSelectorTerms"]
expressions = [expression for term in terms for expression in term.get("matchExpressions", [])]
assert {"key": "fleet.actor.dev/runtime-admitted", "operator": "In", "values": ["true"]} in expressions
assert all(item.get("key") != "fleet.actor.dev/runtime-admission" for item in pod_spec.get("tolerations", []))

generic_documents = list(yaml.safe_load_all(Path(sys.argv[5]).read_text()))
generic_service_account = next(item for item in generic_documents if item.get("kind") == "ServiceAccount")
assert "annotations" not in generic_service_account["metadata"]
template = Path(sys.argv[5]).read_text()
for marker in ("__TKE_OIDC_VOLUMES__", "__TKE_OIDC_ENV__", "__TKE_OIDC_VOLUME_MOUNTS__"):
    assert marker in template
generic_role = next(item for item in generic_documents if item.get("kind") == "Role")
generic_pod_rule = next(rule for rule in generic_role["rules"] if rule.get("apiGroups") == [""] and rule.get("resources") == ["pods"])
assert set(generic_pod_rule["verbs"]) == {"get", "create", "delete"}
generic_cluster_role = next(item for item in generic_documents if item.get("kind") == "ClusterRole")
machine_rule = next(rule for rule in generic_cluster_role["rules"] if rule.get("resources") == ["machines"])
assert machine_rule["verbs"] == ["__MACHINE_VERBS__"], machine_rule
generic_deployment = next(item for item in generic_documents if item.get("kind") == "Deployment")
generic_container = generic_deployment["spec"]["template"]["spec"]["containers"][0]
generic_environment = {item["name"]: item.get("value") for item in generic_container["env"] if "name" in item}
assert generic_environment["RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED"] == "__TARGETED_REPAIR_ENABLED__"
assert generic_environment["RUNTIME_EXACT_SCALE_DOWN_ENABLED"] == "__EXACT_SCALE_DOWN_ENABLED__"
assert generic_environment["RUNTIME_TKE_CLUSTER_ID"] == "__TKE_CLUSTER_ID__"
assert generic_environment["TKE_REGION"] == "__TENCENT_REGION__"
assert generic_environment["RUNTIME_CAPACITY_MAX_REPAIR_SURGE"] == "__MAX_REPAIR_SURGE__"
assert generic_environment["RUNTIME_ADMISSION_BOOTSTRAP_IMAGE"] == "__RUNTIME_IMAGE__"
assert not any(item.get("name") in {"TKE_ROLE_ARN", "TKE_PROVIDER_ID", "TKE_WEB_IDENTITY_TOKEN_FILE"} for item in generic_container["env"])
runtime_token = next(item for item in generic_container["env"] if item.get("name") == "RUNTIME_AUTH_TOKEN")
assert runtime_token["valueFrom"]["secretKeyRef"] == {"name": "__CELL_NAME__-runtime-auth", "key": "token"}
assert not any(item.get("name") in {"TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "TENCENTCLOUD_TOKEN"} for item in generic_container["env"])
eviction_rule = next(rule for rule in generic_role["rules"] if rule.get("resources") == ["pods/eviction"])
assert eviction_rule == {"apiGroups": [""], "resources": ["pods/eviction"], "verbs": ["create"]}
PY

bash -n \
	"$script_dir/install.sh" \
	"$fleet_dir/qualification/actor-bj-q01/install-workerd-autoscaling.sh" \
	"$fleet_dir/qualification/actor-bj-q01/qualify-runtime-automatic-replacement.sh" \
	"$fleet_dir/runtime/install-admission-controller.sh" \
	"$fleet_dir/runtime/validate-runtime-image.sh"

grep -q 'default_runtime_admission_field_manager=rivet-runtime-admission-installer' \
	"$fleet_dir/runtime/install.sh"
grep -q 'RUNTIME_ADMISSION_FIELD_MANAGER=rivet-runtime-admission-installer' \
	"$fleet_dir/qualification/actor-bj-q01/configure-runtime-machine-repair.sh"
grep -q 'admission_field_manager=rivet-runtime-admission-installer' \
	"$fleet_dir/qualification/actor-bj-q01/install-workerd-autoscaling.sh"
if grep -Eq '(^|[[:space:]])jq([[:space:]]|$)' \
	"$fleet_dir/qualification/actor-bj-q01/qualify-runtime-automatic-replacement.sh"; then
	echo "automatic replacement qualifier must not depend on jq on the q01 builder" >&2
	exit 1
fi
python3 - "$fleet_dir/qualification/actor-bj-q01/qualify-runtime-automatic-replacement.sh" <<'PY'
import ast
import re
import sys

source = open(sys.argv[1]).read()
blocks = re.findall(r"<<'PY'\n(.*?)\nPY(?:\n|$)", source, flags=re.DOTALL)
assert blocks, "automatic replacement qualifier has no embedded Python blocks"
for index, block in enumerate(blocks, 1):
    try:
        ast.parse(block, filename=f"embedded-python-{index}", feature_version=(3, 6))
    except SyntaxError as error:
        raise AssertionError(f"embedded Python block {index} is not Python 3.6 compatible: {error}")
PY

echo "runtime Node admission manifest contract: pass"
