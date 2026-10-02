#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("qualify_registry_binding", ROOT / "qualify-registry-binding.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class RegistryBindingTests(unittest.TestCase):
    def evidence(self):
        cell = "actor-bj-a01"
        endpoint = {
            "schema": "actor-worker-registry-private-endpoint/v1", "verdict": "installed",
            "endpoint": "http://10.160.0.11:8080", "network": {"sourceCidrs": ["10.160.0.0/12"]},
            "service": {"uid": "registry-service"},
        }
        image = "registry/host@sha256:" + "a" * 64
        pod = lambda index: {
            "metadata": {
                "name": f"{cell}-runtime-hosts-{index}", "uid": f"pod-{index}",
                "labels": {"controller-revision-hash": "revision"},
                "ownerReferences": [{"kind": "StatefulSet", "uid": "statefulset", "controller": True}],
            },
            "spec": {"containers": [{"name": "workerd-host", "image": image}]},
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        }
        statefulset = {
            "metadata": {"name": f"{cell}-runtime-hosts", "uid": "statefulset"},
            "spec": {"replicas": 3, "template": {"spec": {"containers": [{"name": "workerd-host", "image": image, "env": [{"name": "RIVET_WORKER_REGISTRY_URL", "value": endpoint["endpoint"]}]}]}}},
            "status": {"readyReplicas": 3, "currentRevision": "revision", "updateRevision": "revision"},
        }
        workers_api = {
            "metadata": {"name": f"{cell}-workers-api", "uid": "workers-api"},
            "spec": {"template": {"spec": {"containers": [{
                "name": "workers-api", "image": "registry/api@sha256:" + "b" * 64,
                "args": [f"--registry-url={endpoint['endpoint']}", f"--qualification-cell={cell}"],
            }]}}},
            "status": {"readyReplicas": 1, "updatedReplicas": 1},
        }
        reporter = {
            "metadata": {"name": f"{cell}-cell-reporter", "uid": "reporter"},
            "spec": {"template": {"spec": {"containers": [{
                "name": "reporter", "image": "registry/reporter@sha256:" + "c" * 64,
                "env": [{"name": "RIVET_WORKER_REGISTRY_URL", "value": endpoint["endpoint"]}],
            }]}}},
            "status": {"readyReplicas": 1, "updatedReplicas": 1},
        }
        return endpoint, cell, "10.161.0.0/16", statefulset, workers_api, reporter, {"items": [pod(i) for i in range(3)]}

    def test_accepts_exact_live_binding(self):
        result = MODULE.qualify(*self.evidence())
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["statefulSet"]["readyReplicas"], 3)

    def test_rejects_cell_local_registry(self):
        values = list(self.evidence())
        values[3]["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = "http://cell-registry:8080/"
        with self.assertRaisesRegex(ValueError, "exact Registry"):
            MODULE.qualify(*values)

    def test_accepts_equivalent_trailing_slash(self):
        values = list(self.evidence())
        values[3]["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] += "/"
        self.assertEqual(MODULE.qualify(*values)["verdict"], "passed")

    def test_rejects_qualification_api_on_cell_local_registry(self):
        values = list(self.evidence())
        values[4]["spec"]["template"]["spec"]["containers"][0]["args"][0] = (
            "--registry-url=http://cell-registry:8080"
        )
        with self.assertRaisesRegex(ValueError, "qualification Workers API"):
            MODULE.qualify(*values)

    def test_rejects_pod_from_another_statefulset(self):
        values = list(self.evidence())
        values[6]["items"][0]["metadata"]["ownerReferences"][0]["uid"] = "replacement"
        with self.assertRaisesRegex(ValueError, "Pod identity"):
            MODULE.qualify(*values)

    def test_rejects_stale_pod_revision(self):
        values = list(self.evidence())
        values[6]["items"][0]["metadata"]["labels"]["controller-revision-hash"] = "stale"
        with self.assertRaisesRegex(ValueError, "Pod identity"):
            MODULE.qualify(*values)


if __name__ == "__main__":
    unittest.main()
