from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("cls_render", ROOT / "render.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def binding() -> dict:
    return {
        "schema": "actor-platform-cls-binding/v1", "managementId": "actor-bj-c01",
        "clusterId": "cls-test1234", "region": "ap-beijing",
        "logsetId": "11111111-1111-1111-1111-111111111111",
        "topicId": "22222222-2222-2222-2222-222222222222", "retentionDays": 7,
        "workload": "workers-api", "namespace": "workers-api-system", "container": "workers-api",
        "logSchema": "workers-api-platform-json/v1", "collectionMode": "incremental-warn-error",
    }


class CLSRenderTests(unittest.TestCase):
    def test_exact_container_and_metadata_allowlist(self) -> None:
        document = MODULE.render(binding(), "cls-test1234")
        source = document["spec"]["inputDetail"]
        self.assertEqual(source["type"], "container_stdout")
        selection = source["containerStdout"]
        self.assertIs(selection["allContainers"], False)
        self.assertEqual(selection["workloads"], [{"kind": "deployment", "name": "workers-api",
                                                  "namespace": "workers-api-system", "container": "workers-api"}])
        self.assertEqual(selection["metadataLabels"], ["app.kubernetes.io/name"])
        self.assertEqual(selection["metadataContainer"], ["namespace", "pod_name", "pod_uid", "container_name", "cluster_id"])
        self.assertNotIn("containerFile", source)
        self.assertNotIn("hostFile", source)
        self.assertNotIn("includeLabels", selection)

    def test_topic_identity_no_creation_or_index_double_writer(self) -> None:
        destination = MODULE.render(binding(), "cls-test1234")["spec"]["clsDetail"]
        self.assertEqual(set(destination), {"topicId", "logsetId", "region", "logType", "logFormat", "extractRule"})
        self.assertEqual(destination["topicId"], binding()["topicId"])
        self.assertEqual(destination["logType"], "json_log")
        self.assertEqual(destination["extractRule"], {
            "jsonStandard": "true", "unMatchUpload": "false", "backtracking": "0", "isGBK": "false",
            "filterKeys": ["level"], "filterRegex": ["^(WARN|ERROR)$"],
        })

    def test_wrong_cluster_and_broadened_scope_rejected(self) -> None:
        for key, value in {
            "schema": "unknown", "managementId": "actor-bj-a01", "clusterId": "cls-other1234",
            "topicId": "topic-name", "logsetId": "name", "workload": "*", "container": "*",
            "namespace": "default", "region": "private-message", "logSchema": "unknown", "collectionMode": "all",
        }.items():
            with self.subTest(key=key):
                modified = binding()
                modified[key] = value
                with self.assertRaises(ValueError):
                    MODULE.render(modified, "cls-test1234")
        with self.assertRaises(ValueError):
            MODULE.render({**binding(), "authorization": "private-message"}, "cls-test1234")
        with self.assertRaises(ValueError):
            MODULE.render(None, "cls-test1234")

    def test_retention_bounds_rejected(self) -> None:
        for value in (0, 31, 3640, 1.1, True, "7", float("nan"), float("inf")):
            with self.subTest(value=value):
                modified = copy.deepcopy(binding())
                modified["retentionDays"] = value
                with self.assertRaises(ValueError):
                    MODULE.render(modified, "cls-test1234")

    def test_real_cli_outputs_only_valid_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "binding.json"
            source.write_text(json.dumps(binding()))
            command = [sys.executable, str(ROOT / "render.py"), "--binding", str(source),
                       "--expected-cluster-id", "cls-test1234"]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(yaml.safe_load(result.stdout), MODULE.render(binding(), "cls-test1234"))
            json_result = subprocess.run(command + ["--format", "json"], capture_output=True, text=True)
            self.assertEqual(json_result.returncode, 0, json_result.stderr)
            self.assertEqual(json.loads(json_result.stdout), MODULE.render(binding(), "cls-test1234"))
            for invalid in (
                '{"authorization":"private-message" invalid-json}',
                json.dumps(binding())[:-1] + ',"topicId":"33333333-3333-3333-3333-333333333333"}',
                "private-message" * 10_000,
                '[' * 2_000 + '"private-message"' + ']' * 2_000,
            ):
                source.write_text(invalid)
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("private-message", result.stderr)


if __name__ == "__main__":
    unittest.main()
