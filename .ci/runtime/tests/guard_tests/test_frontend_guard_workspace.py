import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
GUARD_PATH = REPO_ROOT / ".ci/checks/frontend_guard.sh"


class FrontendGuardWorkspaceTests(unittest.TestCase):
    def test_frontend_registry_uses_the_trusted_ci_entrypoint(self) -> None:
        manifest = yaml.safe_load((REPO_ROOT / ".ci/guards.manifest").read_text())
        frontend = next(guard for guard in manifest["guards"] if guard["name"] == "frontend")
        self.assertEqual(frontend["command"], ".ci/checks/frontend_guard.sh")
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()
        self.assertIn("--trusted-ref origin/master", workflow)

    def test_trusted_frontend_guard_copies_all_local_dependencies(self) -> None:
        self.assertTrue(GUARD_PATH.is_file(), "missing trusted CI frontend guard")
        subprocess.run(["bash", "-n", str(GUARD_PATH)], check=True, capture_output=True)
        package_json = json.loads((REPO_ROOT / "frontend/package.json").read_text())
        dependencies = {
            spec.removeprefix("file:")
            for section in ("dependencies", "devDependencies", "optionalDependencies")
            for spec in package_json.get(section, {}).values()
            if spec.startswith("file:")
        }
        self.assertTrue(dependencies)
        guard_text = GUARD_PATH.read_text()
        command = guard_text.split("\ntar \\\n", 1)[1].split('\n\ncd "$FRONTEND_GUARD_DIR"', 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source"
            destination = Path(tmp) / "destination"
            (source / "frontend").mkdir(parents=True)
            destination.mkdir()
            (source / "frontend/package.json").write_text(json.dumps(package_json))
            for relative_path in dependencies:
                package = (source / "frontend" / relative_path).resolve()
                package.mkdir(parents=True, exist_ok=True)
                (package / "package.json").write_text('{"name":"fixture","version":"0.0.0"}')
                (package / "src").mkdir()
                (package / "src/index.ts").write_text("export {};\n")
                (package / "node_modules").mkdir()
                (package / "node_modules/not-source").write_text("excluded")
            subprocess.run(
                ["bash", "-euo", "pipefail", "-c", "tar \\\n" + command],
                env={**os.environ, "REPO_ROOT": str(source), "FRONTEND_GUARD_ROOT": str(destination)},
                check=True,
                capture_output=True,
                text=True,
            )
            for relative_path in dependencies:
                package = destination / "frontend" / relative_path
                with self.subTest(dependency=relative_path):
                    self.assertTrue((package / "package.json").is_file(), f"missing local dependency: {relative_path}")
                    self.assertTrue((package / "src/index.ts").is_file())
                    self.assertFalse((package / "node_modules").exists())
