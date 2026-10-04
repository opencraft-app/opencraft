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
SPEC = importlib.util.spec_from_file_location("platform_cls_gitops", ROOT / "render-gitops.py")
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


class CLSGitPreparationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp", prefix="cls-git-test.")
        self.addCleanup(self.temporary.cleanup)
        self.repository = Path(self.temporary.name) / "desired"
        self.repository.mkdir()
        self.git("init", "--quiet", "--initial-branch=main")
        self.git("remote", "add", "origin", MODULE.REPOSITORY)
        self.rule = MODULE.RENDER.render(binding(), "cls-test1234")
        self.leaf = self.repository / "management/cls/actor-bj-c01/logconfig.json"
        self.leaf.parent.mkdir(parents=True)
        self.leaf.write_text(json.dumps(self.rule))
        self.revision = self.commit()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.repository), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
             "-c", "commit.gpgsign=false", *args],
            check=True, capture_output=True, text=True, timeout=10,
        ).stdout.strip()

    def commit(self) -> str:
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "fixture")
        return self.git("rev-parse", "HEAD")

    def prepare(self, revision: str | None = None) -> list[dict]:
        return MODULE.prepare(self.repository, revision or self.revision, binding(), "cls-test1234")

    def test_exact_pinned_project_and_inactive_application(self) -> None:
        (self.leaf.parent / "extra-secret.json").write_text('{"kind":"Secret"}')
        revision = self.commit()
        project, application = self.prepare(revision)
        self.assertEqual(project["spec"]["sourceRepos"], [MODULE.REPOSITORY])
        self.assertEqual(project["spec"]["clusterResourceWhitelist"], [
            {"group": "cls.cloud.tencent.com", "kind": "LogConfig", "name": "actor-bj-c01-workers-api-errors"},
        ])
        self.assertEqual(project["spec"]["namespaceResourceBlacklist"], [{"group": "*", "kind": "*"}])
        self.assertEqual(project["spec"]["namespaceResourceWhitelist"], [])
        source = application["spec"]["source"]
        self.assertEqual(source["targetRevision"], revision)
        self.assertEqual(source["directory"], {"recurse": False, "include": "logconfig.json"})
        self.assertEqual(source["path"], "management/cls/actor-bj-c01")
        self.assertEqual(application["spec"]["syncPolicy"]["automated"],
                         {"enabled": False, "prune": False, "selfHeal": False})
        self.assertEqual(application["metadata"]["annotations"]["fleet.actor.dev/collection-admission"], "unqualified")
        self.assertNotIn("finalizers", application["metadata"])
        self.assertNotIn("ignoreDifferences", application["spec"])

    def test_exact_commit_ignores_dirty_tree_and_later_head(self) -> None:
        expected = self.prepare()
        modified = copy.deepcopy(self.rule)
        modified["spec"]["inputDetail"]["containerStdout"]["allContainers"] = True
        self.leaf.write_text(json.dumps(modified))
        self.assertEqual(self.prepare(), expected)
        later = self.commit()
        self.assertEqual(self.prepare(), expected)
        with self.assertRaises(ValueError):
            self.prepare(later)
        # Even a local Git replacement must not rewrite the reviewed tree.
        self.git("replace", self.revision, later)
        self.assertEqual(self.prepare(), expected)

    def test_wrong_repository_mutable_revision_and_cluster_rejected(self) -> None:
        for revision in ("main", "HEAD", "-help", "a" * 8):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                self.prepare(revision)
        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare("f" * 40)
        with self.assertRaises(ValueError):
            MODULE.prepare(self.repository, self.revision, binding(), "cls-other1234")
        self.git("remote", "set-url", "origin", "https://private-message.invalid/not-central")
        with self.assertRaises(ValueError):
            self.prepare()

    def test_symlink_and_executable_rule_rejected(self) -> None:
        self.leaf.chmod(0o755)
        executable = self.commit()
        with self.assertRaises(ValueError):
            self.prepare(executable)
        self.leaf.unlink()
        self.leaf.symlink_to("private-message")
        linked = self.commit()
        with self.assertRaises(ValueError):
            self.prepare(linked)

    def test_semantic_scope_and_type_drift_rejected(self) -> None:
        for change in ("topic", "namespace", "metadata", "numeric-bool"):
            modified = copy.deepcopy(self.rule)
            if change == "topic":
                modified["spec"]["clsDetail"]["topicId"] = "33333333-3333-3333-3333-333333333333"
            elif change == "namespace":
                modified["metadata"]["namespace"] = "default"
            elif change == "metadata":
                modified["spec"]["inputDetail"]["containerStdout"]["metadataLabels"] = ["*"]
            else:
                modified["spec"]["inputDetail"]["containerStdout"]["allContainers"] = 0
            self.leaf.write_text(json.dumps(modified))
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.prepare(self.commit())

    def test_actual_cli_accepts_only_valid_tree_and_sanitizes_rejection(self) -> None:
        binding_path = Path(self.temporary.name) / "binding.json"
        binding_path.write_text(json.dumps(binding()))
        command = [sys.executable, str(ROOT / "render-gitops.py"), "--repository-dir", str(self.repository),
                   "--binding", str(binding_path), "--expected-cluster-id", "cls-test1234", "--revision"]
        result = subprocess.run(command + [self.revision], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(yaml.safe_load_all(result.stdout)), self.prepare())
        for invalid in (
            '{"authorization":"private-message" invalid-json}',
            json.dumps(self.rule)[:-1] + ',"kind":"private-message"}',
            "private-message" * 10_000,
            '[' * 2_000 + '"private-message"' + ']' * 2_000,
        ):
            self.leaf.write_text(invalid)
            revision = self.commit()
            result = subprocess.run(command + [revision], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertNotIn("private-message", result.stderr)
            self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
