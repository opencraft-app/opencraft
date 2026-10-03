#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cloud_stateless_do_fault_matrix", ROOT / "fault_matrix.py")
assert spec and spec.loader
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)


def pod(name, uid, ready=True, deleting=False):
    value = {
        "metadata": {"name": name, "uid": uid, "namespace": "test"},
        "status": {"conditions": [{"type": "Ready", "status": "True" if ready else "False"}]},
    }
    if deleting:
        value["metadata"]["deletionTimestamp"] = "2026-09-24T00:00:00Z"
    return value


class FakeKubectl:
    def __init__(self, responses):
        self.namespace = "test"
        self.responses = iter(responses)
        self.deleted = []
        self.delete_options = []

    def json(self, *args):
        return {"items": next(self.responses)}

    def run(self, *args, **kwargs):
        self.deleted.append(args)
        options = json.loads(pathlib.Path(args[args.index("-f") + 1]).read_text())
        self.delete_options.append(options)
        return json.dumps({"metadata": {"uid": options["preconditions"]["uid"]}})


class FaultMatrixUnitTests(unittest.TestCase):
    def test_parse_cell_kubeconfigs_rejects_duplicates_and_relative_paths(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            MODULE.parse_cell_kubeconfigs(["a=/tmp/a", "a=/tmp/b"])
        with self.assertRaisesRegex(ValueError, "absolute"):
            MODULE.parse_cell_kubeconfigs(["a=relative"])

    def test_listed_pods_excludes_terminating_pods(self):
        client = FakeKubectl([[pod("ready", "u1"), pod("old", "u0", deleting=True)]])
        self.assertEqual([item["metadata"]["name"] for item in MODULE.listed_pods(client, "x=y")], ["ready"])

    @mock.patch.object(MODULE.time, "sleep", return_value=None)
    def test_replace_one_pod_requires_exact_floor_and_new_uid(self, _sleep):
        client = FakeKubectl([
            [pod("api-a", "u1"), pod("api-b", "u2")],
            [pod("api-a", "u1", deleting=True), pod("api-b", "u2")],
            [pod("api-b", "u2"), pod("api-c", "u3")],
        ])
        result = MODULE.replace_one_pod(client, "app=api", 2, 5)
        self.assertEqual(result["oldPodUid"], "u1")
        self.assertEqual(result["newPodUid"], "u3")
        self.assertEqual(client.deleted[0][:3], ("delete", "--raw", "/api/v1/namespaces/test/pods/api-a"))
        self.assertEqual(client.delete_options, [{
            "apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": "u1"},
        }])

    def test_replace_one_pod_fails_closed_on_degraded_start(self):
        client = FakeKubectl([[pod("api-a", "u1"), pod("api-b", "u2", ready=False)]])
        with self.assertRaisesRegex(RuntimeError, "exactly 2"):
            MODULE.replace_one_pod(client, "app=api", 2, 1)
        self.assertEqual(client.deleted, [])

    def test_replace_one_pod_rejects_unselected_peer_replacement(self):
        client = FakeKubectl([
            [pod("api-a", "u1"), pod("api-b", "u2")],
            [pod("api-a", "u1"), pod("api-c", "u3")],
        ])
        with self.assertRaisesRegex(RuntimeError, "unselected Pod"):
            MODULE.replace_one_pod(client, "app=api", 2, 5)
        self.assertEqual(len(client.deleted), 1)


if __name__ == "__main__":
    unittest.main()
