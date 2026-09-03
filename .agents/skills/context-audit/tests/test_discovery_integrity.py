from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[4]
AUDIT = REPO_ROOT / ".agents/skills/context-audit/scripts/audit_context.py"


def load_audit_module():
    spec = importlib.util.spec_from_file_location("context_audit_discovery_test", AUDIT)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load audit module: {AUDIT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AUDIT_MODULE = load_audit_module()


def write(repo: Path, relative: str, content: str = "fixture\n") -> Path:
    path = repo / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def run_audit(repo: Path, audit: Path = AUDIT) -> dict:
    output_path = repo.parent / f"{repo.name}-audit-result.json"
    result = subprocess.run(
        [
            "python3", str(audit), "--repo", str(repo),
            "--format", "json", "--output", str(output_path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not output_path.is_file():
        raise AssertionError(
            f"audit failed with exit {result.returncode}:\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
    return json.loads(output_path.read_text(encoding="utf-8"))


class DiscoveryIntegrityTests(unittest.TestCase):
    def test_default_output_is_bounded_markdown_and_json_requires_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            write(repo, "README.md", "# Fixture\n")

            default = subprocess.run(
                ["python3", str(AUDIT), "--repo", str(repo)],
                check=False,
                capture_output=True,
                text=True,
            )
            json_without_output = subprocess.run(
                ["python3", str(AUDIT), "--repo", str(repo), "--format", "json"],
                check=False,
                capture_output=True,
                text=True,
            )
            output = repo.parent / "assessment.json"
            json_with_output = subprocess.run(
                [
                    "python3", str(AUDIT), "--repo", str(repo),
                    "--format", "json", "--output", str(output),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            output_payload = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(default.returncode, 0, default.stderr)
        self.assertTrue(default.stdout.startswith("# 仓库上下文审计"))
        self.assertLessEqual(len(default.stdout.splitlines()), 80)
        self.assertNotEqual(json_without_output.returncode, 0)
        self.assertIn("--format json requires --output", json_without_output.stderr)
        self.assertEqual(json_with_output.returncode, 0, json_with_output.stderr)
        self.assertEqual(output_payload["schema_version"], 3)

    def test_running_audit_skill_is_excluded_from_target_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            tool_root = repo / ".agents/skills/context-audit"
            installed_audit = tool_root / "scripts/audit_context.py"
            installed_audit.parent.mkdir(parents=True)
            shutil.copy2(AUDIT, installed_audit)
            write(repo, ".agents/skills/context-audit/SKILL.md", "# Audit tool\n")
            write(repo, ".agents/skills/context-audit/references/rubric.md")
            write(repo, ".agents/skills/context-audit/tests/test_audit.py")

            payload = run_audit(repo, installed_audit)

        discovery = payload["discovery"]
        self.assertEqual(discovery["repository"]["files_scanned"], 0)
        self.assertIn(
            ".agents/skills/context-audit",
            discovery["repository"]["excluded_tool_roots"],
        )
        self.assertEqual(discovery["inventory"]["documents"], [])
        self.assertEqual(discovery["inventory"]["instructions"], [])
        self.assertEqual(discovery["inventory"]["skills"], [])
        self.assertEqual(discovery["inventory"]["validator_candidates"], [])

    def test_root_manifest_and_sources_form_one_root_component(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            write(repo, "package.json", '{"name":"root-app"}\n')
            write(repo, "index.js", "export const ready = true;\n")

            payload = run_audit(repo)

        services = payload["discovery"]["inventory"]["services"]
        self.assertEqual([item["path"] for item in services], ["."])
        self.assertEqual(services[0]["manifests"], ["package.json"])
        self.assertEqual(services[0]["source_files"], 1)

    def test_common_monorepo_containers_discover_child_components(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            write(repo, "services/api/main.go", "package api\n")
            write(repo, "services/billing/main.go", "package billing\n")
            write(repo, "apps/web/package.json", '{"name":"web"}\n')
            write(repo, "packages/sdk/pyproject.toml", "[project]\nname='sdk'\n")

            payload = run_audit(repo)

        services = payload["discovery"]["inventory"]["services"]
        self.assertEqual(
            {item["path"] for item in services},
            {"apps/web", "packages/sdk", "services/api", "services/billing"},
        )
        self.assertNotIn("apps", {item["path"] for item in services})
        self.assertNotIn("packages", {item["path"] for item in services})
        self.assertNotIn("services", {item["path"] for item in services})

    def test_markdown_link_scan_declares_its_limited_scope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            write(repo, "docs/present.md", "# Present\n")
            write(
                repo,
                "docs/start.md",
                "# Start\n\n"
                "[missing inline](missing.md)\n"
                "![missing image](missing.png)\n"
                "[missing reference][ref]\n"
                "[ref]: missing-reference.md\n"
                "[unchecked anchor](present.md#missing-anchor)\n",
            )

            payload = run_audit(repo)

        links = payload["discovery"]["links"]
        self.assertEqual(links["broken_count"], 4)
        self.assertEqual(
            links["scope"],
            "inline_links_images_reference_definitions_and_markdown_heading_anchors",
        )
        self.assertTrue(links["limitations"])

    def test_file_scan_reports_limit_and_truncation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            for index in range(5):
                write(repo, f"docs/note-{index}.md", f"# Note {index}\n")

            with mock.patch.object(AUDIT_MODULE, "MAX_FILES", 3, create=True):
                discovery = AUDIT_MODULE.discover(repo)

        repository = discovery["repository"]
        self.assertEqual(repository["files_scanned"], 3)
        self.assertEqual(repository["scan_limit"], 3)
        self.assertTrue(repository["scan_truncated"])


if __name__ == "__main__":
    unittest.main()
