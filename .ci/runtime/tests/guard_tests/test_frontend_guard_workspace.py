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
    def test_legacy_frontend_entrypoint_delegates_and_preserves_exit_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            guard = root / ".ci/checks/frontend_guard.sh"
            guard.parent.mkdir(parents=True)
            guard.write_text('printf "%s\\n" "$GUARD_CHANGED_FILES_FILE" "$@"\nexit 23\n')
            result = subprocess.run(
                ["bash", str(REPO_ROOT / "frontend/checks/guard.sh"), "first", "second"],
                cwd=root,
                env={**os.environ, "GUARD_REPO_ROOT": str(root), "GUARD_CHANGED_FILES_FILE": "fixture.changed-files"},
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 23)
            self.assertEqual(result.stdout.splitlines(), ["fixture.changed-files", "first", "second"])

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
        # pnpm resolves file: dependencies of local packages too. Build the
        # real closure so a newly added nested dependency cannot evade this guard.
        packages = {REPO_ROOT / "frontend": package_json}
        pending = [REPO_ROOT / "frontend"]
        while pending:
            package = pending.pop()
            manifest = packages[package]
            for section in ("dependencies", "devDependencies", "optionalDependencies"):
                for spec in manifest.get(section, {}).values():
                    if not spec.startswith("file:"):
                        continue
                    dependency = (package / spec.removeprefix("file:")).resolve()
                    dependency.relative_to(REPO_ROOT)
                    if dependency not in packages:
                        packages[dependency] = json.loads((dependency / "package.json").read_text())
                        pending.append(dependency)
        dependencies = {
            os.path.relpath(package, REPO_ROOT / "frontend"): manifest
            for package, manifest in packages.items()
            if package != REPO_ROOT / "frontend"
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
            for relative_path, manifest in dependencies.items():
                package = (source / "frontend" / relative_path).resolve()
                package.mkdir(parents=True, exist_ok=True)
                (package / "package.json").write_text(json.dumps(manifest))
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
