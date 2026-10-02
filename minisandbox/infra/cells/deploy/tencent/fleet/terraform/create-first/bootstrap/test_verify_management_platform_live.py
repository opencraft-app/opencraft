#!/usr/bin/env python3

import copy
import hashlib
import importlib.util
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFY = load("verify_management_platform_live", ROOT / "verify-management-platform-live.py")
RENDER = load("render_management_platform", ROOT.parents[2] / "gitops" / "render_argocd_ha_install.py")
RENDER_TEST = load("render_management_platform_test", ROOT.parents[2] / "gitops" / "test_render_argocd_ha_install.py")


def fixtures():
    documents = [
        {"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
         "metadata": {"name": name}}
        for name in (
            "applications.argoproj.io", "applicationsets.argoproj.io", "appprojects.argoproj.io",
        )
    ]
    documents.extend([
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole",
         "metadata": {"name": "argocd-test"}},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
         "metadata": {"name": "argocd-test"}},
    ])
    sources = list(RENDER.SOURCE_REPOSITORIES)
    workload_names = (
        "argocd-applicationset-controller", "argocd-dex-server",
        "argocd-notifications-controller", "argocd-redis-ha-haproxy",
        "argocd-repo-server", "argocd-server",
        "argocd-application-controller", "argocd-redis-ha-server",
    )
    for index, name in enumerate(workload_names):
        documents.append({
            "apiVersion": "apps/v1", "kind": "Deployment" if index < 6 else "StatefulSet",
            "metadata": {"name": name},
            "spec": {"replicas": 1, "template": {"metadata": {}, "spec": {
                "containers": [{"name": "main", "image": sources[index % len(sources)]}],
            }}},
        })
    raw = yaml.safe_dump_all(documents).encode()
    old_hash = RENDER.INPUT_SHA256
    RENDER.INPUT_SHA256 = hashlib.sha256(raw).hexdigest()
    try:
        rendered, receipt = RENDER.render(raw, RENDER_TEST.inventory())
    finally:
        RENDER.INPUT_SHA256 = old_hash
    live = []
    for item in copy.deepcopy(rendered):
        if item["kind"] == "CustomResourceDefinition":
            item["metadata"]["uid"] = item["metadata"]["name"] + "-uid"
            item["status"] = {"conditions": [{"type": "Established", "status": "True"}]}
            live.append(item)
        elif item["kind"] in VERIFY.WORKLOAD_KINDS:
            item["metadata"].update({"uid": item["metadata"]["name"] + "-uid", "generation": 1})
            item["status"] = {"observedGeneration": 1, "readyReplicas": 1}
            if item["kind"] == "Deployment":
                item["status"]["updatedReplicas"] = 1
            else:
                item["status"].update({"currentRevision": "r1", "updateRevision": "r1"})
            live.append(item)
    return yaml.safe_dump_all(rendered), receipt, live


class ManagementPlatformLiveTests(unittest.TestCase):
    def test_exact_live_inventory_passes(self):
        result = VERIFY.verify(*fixtures())
        self.assertEqual(len(result["workloads"]), 8)
        self.assertEqual(len(result["crds"]), 3)

    def test_image_mutation_fails(self):
        rendered, receipt, live = fixtures()
        live[3]["spec"]["template"]["spec"]["containers"][0]["image"] = "invalid/image:latest"
        with self.assertRaisesRegex(ValueError, "images differ"):
            VERIFY.verify(rendered, receipt, live)

    def test_unready_statefulset_fails(self):
        rendered, receipt, live = fixtures()
        stateful = next(item for item in live if item["kind"] == "StatefulSet")
        stateful["status"]["readyReplicas"] = 0
        with self.assertRaisesRegex(ValueError, "not fully ready"):
            VERIFY.verify(rendered, receipt, live)


if __name__ == "__main__":
    unittest.main()
