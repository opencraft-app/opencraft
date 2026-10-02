#!/usr/bin/env python3
"""Verify real offline Cargo inputs and real Git identity at the warm boundary."""

from pathlib import Path
import os
import subprocess
import unittest

from test_stage_reuse_inputs import StageReuseFixture


ROOT = Path(__file__).resolve().parent


class WarmStageCacheTest(StageReuseFixture):
    def setUp(self):
        super().setUp()
        self.cache = self.base / "third-party"
        self.fork = self.cache / "workerd-fdb"
        self.fork.mkdir(parents=True)
        (self.fork / "README").write_text("locked fork fixture\n")
        for args in (["init", "--quiet"], ["add", "README"],
                     ["-c", "user.name=stage-test", "-c", "user.email=stage-test@example.invalid",
                      "commit", "--quiet", "-m", "fixture"]):
            subprocess.run(["git", "-C", str(self.fork), *args], check=True, capture_output=True)
        self.commit = subprocess.check_output(["git", "-C", str(self.fork), "rev-parse", "HEAD"], text=True).strip()
        self.tree = subprocess.check_output(["git", "-C", str(self.fork), "rev-parse", "HEAD^{tree}"], text=True).strip()
        self.link = self.cache / "rivet-history"
        self.link.symlink_to("..")

    def verify(self, *, commit=None, tree=None, cache=None):
        return subprocess.run([
            "bash", str(ROOT / "verify-warm-stage-cache.sh"), str(self.release),
            str(cache or self.cache), commit or self.commit, tree or self.tree,
        ], text=True, capture_output=True)

    def test_equal_inputs_preserve_the_existing_source_link(self):
        before = self.link.readlink()
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), self.compare())
        self.assertEqual(self.link.readlink(), before)

    def test_changed_bridge_input_is_rejected(self):
        (self.base / "rivet-depot-client/src/lib.rs").write_text("pub fn value() -> u8 { 2 }\n")
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stage inputs differ", result.stderr)
        self.assertEqual(self.link.readlink(), Path(".."))

    def test_changed_engine_only_source_is_not_a_compiler_input(self):
        (self.base / "depot/src/lib.rs").write_text("pub fn value() -> u8 { 2 }\n")
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dirty_fork_wrong_commit_and_wrong_tree_fail_closed(self):
        for kwargs in ({"commit": "1" * 40}, {"tree": "2" * 40}):
            with self.subTest(kwargs=kwargs):
                self.assertIn("locked fork", self.verify(**kwargs).stderr)
        (self.fork / "README").write_text("dirty fork\n")
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dirty", result.stderr)

    def test_missing_link_and_workspace_alias_are_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.cache, target_is_directory=True)
        self.assertNotEqual(self.verify(cache=alias).returncode, 0)
        self.link.unlink()
        self.assertNotEqual(self.verify().returncode, 0)

    def test_prior_setup_accepts_dirty_pinned_fork_but_warm_gate_rejects_it(self):
        # Use the genuine offline fork bundle and setup entrypoint, not a
        # mocked module or a forged dirty-check response.
        project = ROOT.parents[5]
        actual_cache = self.root / "actual-cache"
        actual_cache.mkdir()
        actual_fork = actual_cache / "workerd-fdb"
        env = dict(os.environ, RIVET_WORKERD_SOURCE=str(actual_fork))
        setup = project / "runtimes/workerd/setup-fork.sh"
        subprocess.run(["bash", str(setup)], env=env, check=True, capture_output=True)
        path = actual_fork / "tools/build-rivet-workerd-musl.sh"
        path.write_text(path.read_text() + "\n# dirty checkout regression fixture\n")
        prior = subprocess.run(["bash", str(setup)], env=env, text=True, capture_output=True)
        self.assertEqual(prior.returncode, 0, prior.stderr)
        (actual_cache / "rivet-history").symlink_to(self.base)
        commit = subprocess.check_output(["git", "-C", str(actual_fork), "rev-parse", "HEAD"], text=True).strip()
        tree = subprocess.check_output(["git", "-C", str(actual_fork), "rev-parse", "HEAD^{tree}"], text=True).strip()
        guarded = self.verify(cache=actual_cache, commit=commit, tree=tree)
        self.assertNotEqual(guarded.returncode, 0)
        self.assertIn("dirty", guarded.stderr)


class WarmStageContractTest(unittest.TestCase):
    def test_materialization_contract_does_not_run_cargo(self):
        gate = (ROOT.parent / "verify-manifests.sh").read_text()
        self.assertIn('test_warm_stage_cache.py" WarmStageContractTest', gate)
        stage = (ROOT / "prepare-stage.sh").read_text()
        self.assertEqual(stage.count('bash "$script_dir/verify-warm-stage-cache.sh"'), 2)
        self.assertIn('[[ $verified_after == "$warm_input_digest" ]]', stage)
        self.assertIn('warmCacheInputDigest', stage)
        verifier = (ROOT / "verify-warm-stage-cache.sh").read_text()
        self.assertIn('status --porcelain', verifier)
        self.assertIn('verify-stage-reuse-inputs.py', verifier)


if __name__ == "__main__":
    unittest.main()
