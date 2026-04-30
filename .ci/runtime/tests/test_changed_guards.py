import os
import subprocess
import tempfile
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
import sys

RUNTIME_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from guards.changed_guards import load_guards, main as guards_main  # noqa: E402


class ChangedGuardsTests(unittest.TestCase):
    def test_repo_guard_registry_commands_exist(self) -> None:
        guards = load_guards(REPO_ROOT, ".ci/guards.yaml", "")

        self.assertTrue(guards)
        for guard in guards:
            with self.subTest(guard=guard.name):
                self.assertTrue((REPO_ROOT / guard.command).is_file(), f"missing guard command: {guard.command}")

    def test_dispatches_only_matching_guards_from_changed_file_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / ".ci/checks").mkdir(parents=True)
            (repo / "service-gateway/checks").mkdir(parents=True)
            (repo / ".ci/guards.yaml").write_text(
                textwrap.dedent(
                    """\
                    guards:
                      - name: ci-runtime
                        paths: [.ci/**]
                        command: .ci/checks/guard.sh
                      - name: service-gateway
                        paths: [service-gateway/**]
                        command: service-gateway/checks/guard.sh
                    """
                )
            )
            output = repo / "ran.txt"
            (repo / ".ci/checks/guard.sh").write_text(f"#!/usr/bin/env bash\necho ci >> {output}\n")
            (repo / "service-gateway/checks/guard.sh").write_text(f"#!/usr/bin/env bash\necho service >> {output}\n")
            changed = repo / "changed.txt"
            changed.write_text("service-gateway/internal/server.go\n")

            exit_code = self.run_main(
                [
                    "run_changed_guards.py",
                    "--repo-root",
                    str(repo),
                    "--changed-files-file",
                    str(changed),
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(output.read_text().splitlines(), ["service"])

    def test_trusted_ref_loads_guard_config_and_command_from_target_ref(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.git(repo, "init", "-b", "master")
            self.git(repo, "config", "user.email", "ci@example.com")
            self.git(repo, "config", "user.name", "CI")
            (repo / "service-gateway/checks").mkdir(parents=True)
            (repo / ".ci").mkdir()
            (repo / ".ci/guards.yaml").write_text(
                textwrap.dedent(
                    """\
                    guards:
                      - name: service-gateway
                        paths: [service-gateway/**]
                        command: service-gateway/checks/guard.sh
                    """
                )
            )
            (repo / "service-gateway/checks/guard.sh").write_text("#!/usr/bin/env bash\necho trusted >> guard-output.txt\n")
            (repo / "service-gateway/file.go").write_text("base\n")
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-m", "base")
            self.git(repo, "checkout", "-b", "feature")
            (repo / "service-gateway/checks/guard.sh").write_text("#!/usr/bin/env bash\necho untrusted >> guard-output.txt\n")
            (repo / "service-gateway/file.go").write_text("change\n")
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-m", "change")

            exit_code = self.run_main(
                [
                    "run_changed_guards.py",
                    "--repo-root",
                    str(repo),
                    "--base-ref",
                    "master",
                    "--head-ref",
                    "HEAD",
                    "--trusted-ref",
                    "master",
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual((repo / "guard-output.txt").read_text().splitlines(), ["trusted"])

    def test_dry_run_reports_matches_without_running(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / ".ci/checks").mkdir(parents=True)
            (repo / ".ci/guards.yaml").write_text(
                textwrap.dedent(
                    """\
                    guards:
                      - name: ci-runtime
                        paths: [.ci/**]
                        command: .ci/checks/guard.sh
                    """
                )
            )
            (repo / ".ci/checks/guard.sh").write_text("#!/usr/bin/env bash\nexit 42\n")
            changed = repo / "changed.txt"
            changed.write_text(".ci/mr-placeholder.yml\n")

            exit_code = self.run_main(
                [
                    "run_changed_guards.py",
                    "--repo-root",
                    str(repo),
                    "--changed-files-file",
                    str(changed),
                    "--dry-run",
                ]
            )

            self.assertEqual(exit_code, 0)

    def git(self, repo: Path, *args: str) -> None:
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)

    def run_main(self, argv: list[str]) -> int:
        old_argv = os.sys.argv
        try:
            os.sys.argv = argv
            with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                return guards_main()
        finally:
            os.sys.argv = old_argv


if __name__ == "__main__":
    unittest.main()
