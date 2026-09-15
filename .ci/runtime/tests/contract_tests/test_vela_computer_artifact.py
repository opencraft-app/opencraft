import unittest
from pathlib import Path

import yaml


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class VelaComputerArtifactContractTests(unittest.TestCase):
    def test_pipeline_builds_only_candidates_and_archives_the_exact_revision(self) -> None:
        path = REPO_ROOT / ".ci/vela-computer.yml"
        self.assertTrue(path.is_file(), "missing vela-computer candidate artifact pipeline")
        workflow = yaml.safe_load(path.read_text())
        self.assertEqual(workflow["concurrency"]["group"], "mono2-vela-computer-candidate")
        self.assertEqual(workflow["on"]["push"]["branches"], ["master"])
        self.assertEqual(workflow["on"]["push"]["paths"], ["vela-computer/**"])
        jobs = workflow["stages"][0]["jobs"]
        steps = jobs["candidate"]["steps"]
        build = next(step for step in steps if step.get("name") == "构建候选制品")
        self.assertIn('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"', build["run"])
        self.assertIn("build-vela-candidate.sh", build["run"])
        archive = next(step for step in steps if "uses" in step)
        self.assertEqual(archive["with"]["repoName"], "pipeline")
        self.assertEqual(archive["with"]["filePath"], "vela-computer/.artifacts/candidates/${{ ci.sha }}/linux-amd64.tar.gz")
        self.assertNotIn("settings.", path.read_text())
        for forbidden in ("cloudagent/", "buildx", "kubectl", "signupload", "promote", "SSM"):
            self.assertNotIn(forbidden, path.read_text())

    def test_merged_source_registers_a_dedicated_computer_guard(self) -> None:
        manifest = yaml.safe_load((REPO_ROOT / ".ci/guards.manifest").read_text())
        guard = next((guard for guard in manifest["guards"] if guard["name"] == "vela-computer"), None)
        self.assertIsNotNone(guard, "missing vela-computer source guard")
        self.assertIn("vela-computer/**", guard["paths"])
        self.assertEqual(guard["command"], ".ci/checks/vela_computer_guard.sh")
        self.assertTrue((REPO_ROOT / guard["command"]).is_file())
