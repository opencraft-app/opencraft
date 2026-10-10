from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_render import binding


ROOT = Path(__file__).resolve().parent
UID = "33333333-3333-3333-3333-333333333333"

# A real CLI process models the Kubernetes wire protocol, not a collector.
KUBECTL = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
state = pathlib.Path(os.environ["CLS_TEST_STATE"])
calls = json.loads(state.read_text()) if state.exists() else []
calls.append(args)
state.write_text(json.dumps(calls))
scenario = os.environ.get("CLS_TEST_SCENARIO", "valid")
if scenario == "request-failure":
    print("private-message private-credential", file=sys.stderr)
    sys.exit(1)
if "namespace" in args:
    uid = "33333333-3333-3333-3333-333333333333"
    if scenario == "wrong-cluster" or (scenario == "replaced-cluster" and len(calls) == 5):
        uid = "44444444-4444-4444-4444-444444444444"
    result = {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "kube-system", "uid": uid}}
elif "customresourcedefinition" in args:
    result = {"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
        "metadata": {"name": "logconfigs.cls.cloud.tencent.com", "uid": "55555555-5555-5555-5555-555555555555"},
        "spec": {"group": "cls.cloud.tencent.com", "scope": "Cluster", "names": {"kind": "LogConfig", "plural": "logconfigs"},
                 "versions": [{"name": "v1", "served": True, "storage": True}]},
        "status": {"conditions": [{"type": "Established", "status": "True"}, {"type": "NamesAccepted", "status": "True"}]}}
    if scenario == "unready-crd": result["status"]["conditions"] = []
    if scenario == "wrong-scope": result["spec"]["scope"] = "Namespaced"
    if scenario == "unserved-version": result["spec"]["versions"][0]["served"] = False
    if scenario == "replaced-crd" and len(calls) == 4:
        result["metadata"]["uid"] = "66666666-6666-6666-6666-666666666666"
    if scenario == "changed-crd" and len(calls) == 4:
        result["spec"]["versions"][0]["schema"] = {"openAPIV3Schema": {"type": "object"}}
    if scenario == "terminating-crd" and len(calls) == 4:
        result["metadata"]["deletionTimestamp"] = "2026-10-04T00:00:00Z"
elif "create" in args:
    assert "--dry-run=server" in args and "--validate=strict" in args
    result = json.loads(pathlib.Path(args[args.index("-f") + 1]).read_text())
    extract = result["spec"]["clsDetail"]["extractRule"]
    selection = result["spec"]["inputDetail"]["containerStdout"]
    if scenario == "pruned-filter": extract.pop("filterKeys")
    if scenario == "changed-backtracking": extract["backtracking"] = "-1"
    if scenario == "upload-unmatched": extract["unMatchUpload"] = "true"
    if scenario == "pruned-metadata": selection.pop("metadataLabels")
    if scenario == "broadened-container": selection["workloads"][0]["container"] = "*"
    if scenario == "changed-topic": result["spec"]["clsDetail"]["topicId"] = "66666666-6666-6666-6666-666666666666"
    if scenario == "extra-spec": result["spec"]["kafkaDetail"] = {"topic": "private-message"}
    if scenario == "extra-annotation": result["metadata"]["annotations"]["private-key"] = "private-message"
    if scenario == "extra-label": result["metadata"]["labels"] = {"private-key": "private-message"}
    if scenario == "finalizer": result["metadata"]["finalizers"] = ["private-message"]
    if scenario == "changed-identity": result["metadata"]["name"] = "other-rule"
    if scenario == "namespace": result["metadata"]["namespace"] = "default"
    result["metadata"]["creationTimestamp"] = None
else:
    raise RuntimeError("unexpected command")
print(json.dumps(result))
'''


class RulePreflightTests(unittest.TestCase):
    def run_cli(self, scenario: str = "valid", modify=None):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            kubectl = base / "kubectl"
            kubectl.write_text(KUBECTL)
            kubectl.chmod(0o700)
            value = binding()
            if modify:
                modify(value)
            (base / "binding.json").write_text(json.dumps(value))
            (base / "config").write_text("protocol double, not a kubeconfig")
            state = base / "calls.json"
            result = subprocess.run([
                sys.executable, str(ROOT / "preflight-rule.py"), "--binding", str(base / "binding.json"),
                "--expected-cluster-id", "cls-test1234", "--expected-kube-system-uid", UID,
                "--kubeconfig", str(base / "config"), "--kubectl", str(kubectl),
            ], capture_output=True, text=True,
                env={**os.environ, "CLS_TEST_STATE": str(state), "CLS_TEST_SCENARIO": scenario})
            return result, json.loads(state.read_text()) if state.exists() else []

    def test_real_cli_roundtrip_is_narrow_and_never_authorizes_collection(self):
        result, calls = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["claim"], "server-side-logconfig-roundtrip-only")
        self.assertEqual(receipt["collectionAdmission"], "unqualified")
        self.assertIs(receipt["canaryAuthorized"], False)
        self.assertEqual(receipt["kubeSystemNamespaceUid"], UID)
        self.assertEqual(len(calls), 5)
        self.assertIn("namespace", calls[0])
        self.assertIn("customresourcedefinition", calls[1])
        self.assertIn("--dry-run=server", calls[2])
        self.assertIn("--validate=strict", calls[2])
        self.assertIn("customresourcedefinition", calls[3])
        self.assertIn("namespace", calls[4])
        for call in calls:
            self.assertFalse(set(call) & {"apply", "patch", "delete", "replace", "logs", "exec"})

    def test_pruning_mutation_and_broadened_rule_fail_closed(self):
        for scenario in ("pruned-filter", "changed-backtracking", "upload-unmatched", "pruned-metadata",
                         "broadened-container", "changed-topic", "extra-spec", "extra-annotation", "extra-label",
                         "finalizer", "changed-identity", "namespace"):
            with self.subTest(scenario=scenario):
                result, calls = self.run_cli(scenario)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("private-message", result.stderr)
                self.assertEqual(len(calls), 3)

    def test_cluster_replacement_and_crd_gates(self):
        for scenario, count in (("wrong-cluster", 1), ("replaced-cluster", 5), ("unready-crd", 2),
                                ("wrong-scope", 2), ("unserved-version", 2), ("replaced-crd", 4),
                                ("changed-crd", 4), ("terminating-crd", 4)):
            with self.subTest(scenario=scenario):
                result, calls = self.run_cli(scenario)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertEqual(len(calls), count)

    def test_request_failure_does_not_echo_kubernetes_output(self):
        result, calls = self.run_cli("request-failure")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("kubernetes_request_failed", result.stderr)
        self.assertNotIn("private-", result.stderr)
        self.assertEqual(len(calls), 1)

    def test_bad_binding_stops_before_any_kubernetes_request(self):
        result, calls = self.run_cli(modify=lambda value: value.update(container="*"))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
