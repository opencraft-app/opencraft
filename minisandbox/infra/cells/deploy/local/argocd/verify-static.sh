#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash -n "$script_dir/install.sh" "$script_dir/qualify.sh"
python3 - "$script_dir" <<'PY'
import pathlib, sys, yaml

root = pathlib.Path(sys.argv[1])
apps = [d for d in yaml.safe_load_all((root / "applications.yaml").read_text()) if d]
assert len(apps) == 2
for app in apps:
    assert app["kind"] == "Application"
    policy = app["spec"]["syncPolicy"]
    assert policy["automated"] == {"enabled": True, "prune": False, "selfHeal": True}
    assert "RespectIgnoreDifferences=true" in policy["syncOptions"]
    assert "FailOnSharedResource=true" in policy["syncOptions"]
    ignored = {(x["group"], x["kind"]): x["jsonPointers"] for x in app["spec"]["ignoreDifferences"]}
    assert ignored[("apps", "Deployment")] == ["/spec/replicas"]
    assert ignored[("apps", "StatefulSet")] == ["/spec/replicas"]
project = yaml.safe_load((root / "project.yaml").read_text())
assert project["spec"]["clusterResourceWhitelist"] == []
assert project["spec"]["namespaceResourceWhitelist"] == [{"group": "", "kind": "ConfigMap"}]
rbac = [d for d in yaml.safe_load_all((root / "spoke-rbac.yaml").read_text()) if d]
role = next(d for d in rbac if d["kind"] == "Role")
assert role["rules"] == [
    {"apiGroups": [""], "resources": ["configmaps"], "verbs": ["get", "list", "watch", "create", "update", "patch"]},
    {"apiGroups": ["fleet.actor.dev"], "resources": ["rivetcells"], "verbs": ["get", "list", "watch"]},
]
cluster_role = next(d for d in rbac if d["kind"] == "ClusterRole")
assert cluster_role["rules"] == [{
    "apiGroups": ["node.tke.cloud.tencent.com"], "resources": ["machinesets"], "verbs": ["get", "list", "watch"]
}]
assert all("delete" not in rule["verbs"] for rule in role["rules"] + cluster_role["rules"])
inclusions = yaml.safe_load((root / "resource-inclusions.yaml").read_text())["data"]["resource.inclusions"]
parsed_inclusions = yaml.safe_load(inclusions)
assert parsed_inclusions == [{
    "apiGroups": [""], "kinds": ["ConfigMap"],
    "clusters": [
        "https://k3d-rivet-runtime-a-serverlb:6443",
        "https://k3d-rivet-runtime-b-serverlb:6443",
    ],
}]
parameters = yaml.safe_load((root / "controller-parameters.yaml").read_text())["data"]
assert parameters == {
    "controller.self.heal.timeout.seconds": "2",
    "controller.self.heal.backoff.timeout.seconds": "2",
    "controller.self.heal.backoff.factor": "2",
    "controller.self.heal.backoff.cap.seconds": "15",
}
install = (root / "install.sh").read_text()
assert "cell-registration/install-management.sh" in install
assert "ACTOR_DESIRED_REPO_URL=git://actor-gitops-repository.argocd.svc.cluster.local:9418/repo.git" in install
qualify = (root / "qualify.sh").read_text()
assert "applicationset actor-cells" in qualify
assert "accidentally enrolled as managed Cells" in qualify
print("argocd static ownership gates: pass")
PY
