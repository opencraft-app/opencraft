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
        repair = next((step for step in steps if step.get("name") == "准备全量干净 checkout"), None)
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

    def select_source(self, root, source_sha):
        workflow = yaml.safe_load((REPO_ROOT / ".ci/vela-computer.yml").read_text())
        steps = workflow["stages"][0]["jobs"]["candidate"]["steps"]
        step = next(step for step in steps if step.get("name") == "确认候选 checkout 提交")
        self.assertLess(steps.index(step), next(i for i, item in enumerate(steps)
                                              if item.get("name") == "校验源码"))
        script = step["run"].replace("${{ ci.sha }}", source_sha)
        return subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                              cwd=root, capture_output=True, text=True)

    def diverged_repository(self, root):
        repo = self.repository(root)
        self.git(repo, "checkout", "-qb", "feature")
        (repo / "feature.txt").write_text("candidate source")
        self.git(repo, "add", "feature.txt")
        self.git(repo, "commit", "-qm", "feature")
        source_sha = self.git(repo, "rev-parse", "HEAD").stdout.strip()
        self.git(repo, "checkout", "-q", "master")
        (repo / "master-only.txt").write_text("integration only")
        self.git(repo, "add", "master-only.txt")
        self.git(repo, "commit", "-qm", "master advance")
        return repo, source_sha

    def test_mr_merge_snapshot_selects_exact_source_before_candidate_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, source_sha = self.diverged_repository(Path(tmp) / "repo")
            self.git(repo, "merge", "--no-ff", "-qm", "MR snapshot", source_sha)
            merge_sha = self.git(repo, "rev-parse", "HEAD").stdout.strip()
            self.assertNotEqual(merge_sha, source_sha)
            result = self.select_source(repo, source_sha)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git(repo, "rev-parse", "HEAD").stdout.strip(), source_sha)
            self.assertEqual((repo / "feature.txt").read_text(), "candidate source")
            self.assertFalse((repo / "master-only.txt").exists())
            self.assertNotEqual(self.git(repo, "symbolic-ref", "-q", "HEAD", check=False).returncode, 0)

    def test_source_checkout_is_also_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = self.repository(Path(tmp) / "repo")
            source_sha = self.git(repo, "rev-parse", "HEAD").stdout.strip()
            result = self.select_source(repo, source_sha)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git(repo, "rev-parse", "HEAD").stdout.strip(), source_sha)

    def test_invalid_missing_or_unrelated_source_is_rejected_without_switching_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, unrelated_sha = self.diverged_repository(Path(tmp) / "repo")
            original_sha = self.git(repo, "rev-parse", "HEAD").stdout.strip()
            for source_sha in ("not-a-sha", "f" * 40, unrelated_sha):
                with self.subTest(source_sha=source_sha):
                    result = self.select_source(repo, source_sha)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(self.git(repo, "rev-parse", "HEAD").stdout.strip(), original_sha)
                    self.assertTrue((repo / "master-only.txt").exists())

    def test_missing_parent_is_quarantined_and_fresh_full_fetch_succeeds(self):
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
            self.assertEqual((quarantines[0] / "worktree/business-data").read_text(), "preserve me")
            self.git(cached, "init", "-q")
            self.git(cached, "remote", "add", "origin", remote.as_uri())
            self.git(cached, "fetch", "origin", "master")
            self.git(cached, "checkout", "--detach", "FETCH_HEAD")
            self.git(cached, "rev-list", "--objects", "--all")
            self.assertEqual(self.git(cached, "rev-parse", "--is-shallow-repository").stdout.strip(), "false")
            self.git(cached, "rev-parse", "HEAD^")
            self.assertEqual((quarantines[0] / "worktree/business-data").read_text(), "preserve me")

    def test_sdk_baseline_checkout_then_merge_does_not_collide_with_old_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = self.repository(root / "remote")
            baseline = self.git(remote, "rev-parse", "HEAD").stdout.strip()
            (remote / "new-source.txt").write_text("target source")
            self.git(remote, "add", "new-source.txt")
            self.git(remote, "commit", "-qm", "feature")
            target = self.git(remote, "rev-parse", "HEAD").stdout.strip()
            cached = root / "cached"
            subprocess.run(["git", "clone", remote.as_uri(), str(cached)],
                           check=True, capture_output=True, text=True)
            (cached / ".hidden-business-data").write_text("private marker")
            result = self.repair(cached)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.git(cached, "init", "-q")
            self.git(cached, "remote", "add", "origin", remote.as_uri())
            self.git(cached, "fetch", "origin", "master")
            # SDK can replace baseline files, but pull/merge still rejects
            # leftover files introduced only by the target commit.
            self.git(cached, "checkout", "--detach", "--force", baseline)
            merged = self.git(cached, "merge", "--ff-only", target, check=False)
            self.assertEqual(merged.returncode, 0, merged.stderr)
            self.assertEqual(self.git(cached, "rev-parse", "HEAD").stdout.strip(), target)
            self.assertEqual((cached / "new-source.txt").read_text(), "target source")
            quarantine = next(cached.glob(".checkout-quarantine.*"))
            self.assertEqual((quarantine / "worktree/new-source.txt").read_text(), "target source")
            self.assertEqual((quarantine / "worktree/.hidden-business-data").read_text(), "private marker")

    def test_healthy_full_and_valid_shallow_metadata_is_also_isolated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            full = self.repository(root / "full")
            shallow = root / "shallow"
            subprocess.run(["git", "clone", "--depth=1", full.as_uri(), str(shallow)],
                           check=True, capture_output=True, text=True)
            self.assertTrue((shallow / ".git/shallow").is_file())
            for repo in (full, shallow):
                with self.subTest(repository=repo.name):
                    self.git(repo, "rev-list", "--objects", "--all")
                    (repo / "business-data").write_text("preserve me")
                    result = self.repair(repo)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertFalse((repo / ".git").exists())
                    quarantines = list(repo.glob(".checkout-quarantine.*"))
                    self.assertEqual(len(quarantines), 1)
                    self.assertTrue((quarantines[0] / "git/HEAD").is_file())
                    self.assertEqual((quarantines[0] / "worktree/business-data").read_text(), "preserve me")

    def test_pipeline_disables_shallow_checkout(self):
        workflow = yaml.safe_load((REPO_ROOT / ".ci/vela-computer.yml").read_text())
        steps = workflow["stages"][0]["jobs"]["candidate"]["steps"]
        checkout = next(step for step in steps if "checkout" in step)
        self.assertEqual(checkout["with"]["fetchDepth"], 0)

    def test_checkout_without_metadata_also_isolates_leftover_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "business-data").write_text("preserve me")
            result = self.repair(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            quarantine = next(root.glob(".checkout-quarantine.*"))
            self.assertEqual((quarantine / "worktree/business-data").read_text(), "preserve me")
            self.assertFalse((root / "business-data").exists())

    def test_completely_empty_checkout_needs_no_quarantine(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(self.repair(root).returncode, 0)
            self.assertEqual(list(root.iterdir()), [])

    def test_old_quarantine_and_external_symlink_payload_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cached = self.repository(root / "cached")
            external = root / "external-data"
            external.write_text("do not change")
            (cached / "external-link").symlink_to(external)
            old = cached / ".checkout-quarantine.old"
            old.mkdir(mode=0o700)
            (old / "marker").write_text("old payload")
            result = self.repair(cached)
            self.assertEqual(result.returncode, 0, result.stderr)
            quarantine = next(path for path in cached.glob(".checkout-quarantine.*") if path != old)
            self.assertTrue((quarantine / "worktree/external-link").is_symlink())
            self.assertEqual(external.read_text(), "do not change")
            self.assertEqual((old / "marker").read_text(), "old payload")

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
