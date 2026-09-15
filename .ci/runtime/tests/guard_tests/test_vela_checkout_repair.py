import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class VelaCheckoutRepairTests(unittest.TestCase):
    def repair_script(self):
        workflow = yaml.safe_load((REPO_ROOT / ".ci/vela-computer.yml").read_text())
        steps = workflow["stages"][0]["jobs"]["candidate"]["steps"]
        repair = next((step for step in steps if step.get("name") == "隔离损坏的复用 checkout 元数据"), None)
        self.assertIsNotNone(repair, "missing pre-checkout Git connectivity repair")
        self.assertLess(steps.index(repair), next(index for index, step in enumerate(steps) if "checkout" in step))
        self.assertNotIn("source .ci/", repair["run"])
        return repair["run"]

    def git(self, root, *args, check=True):
        return subprocess.run(["git", "-C", str(root), *args], check=check, capture_output=True, text=True)

    def repository(self, root):
        root.mkdir()
        self.git(root, "init", "-q", "-b", "master")
        self.git(root, "config", "user.name", "fixture")
        self.git(root, "config", "user.email", "fixture@example.invalid")
        self.git(root, "config", "gc.auto", "0")
        for content in ("first", "second"):
            (root / "tracked.txt").write_text(content)
            self.git(root, "add", "tracked.txt")
            self.git(root, "commit", "-qm", content)
        return root

    def repair(self, root):
        return subprocess.run(["bash", "-euo", "pipefail", "-c", self.repair_script()],
                              cwd=root, env=os.environ.copy(), capture_output=True, text=True)

    def test_missing_parent_is_quarantined_and_fresh_shallow_fetch_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = self.repository(root / "remote")
            cached = self.repository(root / "cached")
            parent = self.git(cached, "rev-parse", "HEAD^").stdout.strip()
            missing = cached / ".git/objects" / parent[:2] / parent[2:]
            self.assertTrue(missing.is_file())
            missing.unlink()
            self.assertNotEqual(self.git(cached, "rev-list", "--objects", "--all", check=False).returncode, 0)
            (cached / "business-data").write_text("preserve me")
            result = self.repair(cached)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((cached / ".git").exists())
            quarantines = list(cached.glob(".checkout-quarantine.*"))
            self.assertEqual(len(quarantines), 1)
            self.assertTrue((quarantines[0] / "git/HEAD").is_file())
            self.assertEqual(quarantines[0].stat().st_mode & 0o777, 0o700)
            self.assertEqual((cached / "business-data").read_text(), "preserve me")
            self.git(cached, "init", "-q")
            self.git(cached, "remote", "add", "origin", remote.as_uri())
            self.git(cached, "fetch", "--depth=1", "origin", "master")
            self.git(cached, "checkout", "--detach", "--force", "FETCH_HEAD")
            self.git(cached, "rev-list", "--objects", "--all")
            self.assertEqual((cached / "business-data").read_text(), "preserve me")

    def test_healthy_full_and_valid_shallow_repositories_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            full = self.repository(root / "full")
            shallow = root / "shallow"
            subprocess.run(["git", "clone", "--depth=1", full.as_uri(), str(shallow)],
                           check=True, capture_output=True, text=True)
            self.assertTrue((shallow / ".git/shallow").is_file())
            for repo in (full, shallow):
                with self.subTest(repository=repo.name):
                    result = self.repair(repo)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue((repo / ".git/HEAD").is_file())
                    self.assertEqual(list(repo.glob(".checkout-quarantine.*")), [])

    def test_symlink_gitdir_and_shared_worktree_markers_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            external = self.repository(root / "external")
            for kind in ("symlink", "gitfile", "commondir"):
                repo = root / kind
                repo.mkdir()
                if kind == "symlink":
                    (repo / ".git").symlink_to(external / ".git", target_is_directory=True)
                elif kind == "gitfile":
                    (repo / ".git").write_text(f"gitdir: {external / '.git'}\n")
                else:
                    (repo / ".git").mkdir()
                    (repo / ".git/commondir").write_text(str(external / ".git"))
                with self.subTest(kind=kind):
                    result = self.repair(repo)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertTrue((repo / ".git").exists())
                    self.assertTrue((external / ".git/HEAD").is_file())
                    self.assertEqual(list(repo.glob(".checkout-quarantine.*")), [])
