#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

bash -n "$script_dir/install-private-endpoint.sh"

rendered=$(mktemp)
kubectl kustomize "$script_dir" >"$rendered"

python3 - "$rendered" <<'PY'
import sys
import yaml

documents = [document for document in yaml.safe_load_all(open(sys.argv[1])) if document]
deployment = next(document for document in documents if document["kind"] == "Deployment")
pdb = next(document for document in documents if document["kind"] == "PodDisruptionBudget")
service = next(document for document in documents if document["kind"] == "Service")
spec = deployment["spec"]
pod = spec["template"]["spec"]
container = pod["containers"][0]

assert spec["replicas"] == 3
assert spec["strategy"]["rollingUpdate"]["maxUnavailable"] == 1
assert pdb["spec"]["minAvailable"] == 2
assert service["spec"]["type"] == "ClusterIP"
assert "volumes" in pod and not any("persistentVolumeClaim" in volume for volume in pod["volumes"])
assert any(volume.get("secret", {}).get("secretName") == "worker-registry-fdb-tls" for volume in pod["volumes"])
assert {env["name"] for env in container["env"]} >= {
    "FDB_TLS_CERTIFICATE_FILE", "FDB_TLS_CA_FILE", "FDB_TLS_KEY_FILE",
}
assert "--backend=fdb-cos" in container["args"]
assert "--cos-object-prefix=worker-registry/v5" in container["args"]
assert "--version-retention=5" in container["args"]
assert any(arg.startswith("--max-compatibility-date=") for arg in container["args"])
assert container["securityContext"]["readOnlyRootFilesystem"] is True
assert container["securityContext"]["capabilities"]["drop"] == ["ALL"]
assert pod["affinity"]["podAntiAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"]
print("worker-registry production manifest: PASS")
PY
