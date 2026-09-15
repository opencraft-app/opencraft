import unittest
from pathlib import Path

import yaml


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


def stream_workflow(source: str) -> dict:
    # Stream V2 ScriptYmlUtils.formatYamlCustom recognizes only a literal
    # top-level on: line before mapping it to the internal triggerOn field.
    # Parsing the original with PyYAML alone would accept the broken "on":
    # spelling (and treats unquoted on as a YAML 1.1 boolean).
    normalized = "\n".join(
        "triggerOn:" if line.rstrip().startswith("on:") else line.rstrip()
        for line in source.splitlines()
    )
    return yaml.safe_load(normalized)


class VelaComputerArtifactContractTests(unittest.TestCase):
    def test_trigger_configuration_survives_stream_preprocessing(self) -> None:
        source = (REPO_ROOT / ".ci/vela-computer.yml").read_text()
        workflow = stream_workflow(source)
        self.assertIn("triggerOn", workflow, "Stream ignores quoted on and enables default wildcard triggers")
        trigger = workflow["triggerOn"]
        self.assertEqual(set(trigger), {"push", "manual"})
        self.assertEqual(trigger["manual"], "enabled")
        self.assertEqual(trigger["push"]["branches"], ["master"])
        self.assertEqual(trigger["push"]["paths"], ["vela-computer/**"])
        self.assertEqual(trigger["push"]["paths-ignore"], ["OWNERS", "**/OWNERS"])
        # Guard the regression fixture: ordinary YAML parsing does not catch it.
        quoted = source.replace("\non:", '\n"on":', 1)
        self.assertIn("on", yaml.safe_load(quoted))
        self.assertNotIn("triggerOn", stream_workflow(quoted))

    def test_pipeline_builds_only_candidates_and_archives_the_exact_revision(self) -> None:
        path = REPO_ROOT / ".ci/vela-computer.yml"
        self.assertTrue(path.is_file(), "missing vela-computer candidate artifact pipeline")
        workflow = stream_workflow(path.read_text())
        self.assertEqual(workflow["concurrency"]["group"], "mono2-vela-computer-candidate")
        self.assertEqual(workflow["triggerOn"]["push"]["branches"], ["master"])
        self.assertEqual(workflow["triggerOn"]["push"]["paths"], ["vela-computer/**"])
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
