"""Prepared-stage acceptance against real files, ELF and shell subprocesses."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("build-runtime-via-tat.sh")
ARTIFACTS = ("workerd", "init-workerd-pool", "config-depot.capnp", "libfdb_c.so")


class PreparedStageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.stage = self.root / "stage"
        self.stage.mkdir()
        fork = self.source / "runtimes/workerd/workerd-fdb.lock"
        fork.parent.mkdir(parents=True)
        fork.write_text('fork_commit = "' + 'c' * 40 + '"\n')
        lock = self.source / "infra/cells/deploy/tencent/fleet/runtime/runtime-stage.lock.json"
        lock.parent.mkdir(parents=True)
        lock.write_text(json.dumps({"foundationdbClient": {"sha256": "d" * 64}}))
        # A real minimal static ELF, without running compiler-dependent V8 tests.
        subprocess.run(["cc", "-x", "c", "-nostdlib", "-static", "-Wl,-e,_start", "-o",
                        str(self.stage / "workerd"), "-"],
                       input="void _start(void) {}\n", text=True, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for name in ARTIFACTS[1:]:
            (self.stage / name).write_bytes(name.encode())
        self.manifest = self.stage / "STAGE_SHA256SUMS"
        self.manifest.write_text("".join(
            hashlib.sha256((self.stage / name).read_bytes()).hexdigest() + "  " + name + "\n"
            for name in ARTIFACTS))
        self.receipt = self.root / "receipt.json"
        self.value = dict(schema="actor-runtime-stage/v1", verdict="passed", sourceRevision="a" * 40,
                          sourceManifestDigest="sha256:" + "b" * 64, workerdCommit="c" * 40,
                          foundationdbClientDigest="sha256:" + "d" * 64,
                          toolchainReceiptDigest="sha256:" + "e" * 64, buildJobs=2,
                          artifactsDigest="sha256:" + hashlib.sha256(self.manifest.read_bytes()).hexdigest())
        script = SCRIPT.read_text()
        self.function = script[script.index("verify_prepared_stage() {"):script.index("\n[[ $cell_name")]

    def run_gate(self, stage=None):
        self.receipt.write_text(json.dumps(self.value))
        return subprocess.run(["bash", "-eu", "-c", self.function + '\nverify_prepared_stage "$@"',
                               "test", str(self.source), str(stage or self.stage), str(self.receipt),
                               "a" * 40, "b" * 64], capture_output=True, text=True)

    def test_accepts_exact_fresh_stage(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_wrong_receipt_fields_and_historical_reuse(self):
        for field, replacement in (("sourceRevision", "f" * 40),
                                   ("sourceManifestDigest", "sha256:" + "f" * 64),
                                   ("workerdCommit", "f" * 40),
                                   ("foundationdbClientDigest", "sha256:" + "f" * 64),
                                   ("toolchainReceiptDigest", None),
                                   ("artifactsDigest", "sha256:" + "f" * 64),
                                   ("buildJobs", 0), ("buildJobs", 1.5),
                                   ("mode", "verified-base-runtime-reuse")):
            with self.subTest(field=field, replacement=replacement):
                original = dict(self.value)
                self.value[field] = replacement
                self.assertNotEqual(self.run_gate().returncode, 0)
                self.value = original

    def test_rejects_corrupt_artifact(self):
        (self.stage / "config-depot.capnp").write_bytes(b"corrupt")
        self.assertNotEqual(self.run_gate().returncode, 0)

    def test_rejects_manifest_extra_path_even_with_updated_receipt_hash(self):
        self.manifest.write_text(self.manifest.read_text() + "f" * 64 + "  ../outside\n")
        self.value["artifactsDigest"] = "sha256:" + hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.assertNotEqual(self.run_gate().returncode, 0)

    def test_rejects_stage_alias_and_artifact_symlink(self):
        alias = self.root / "alias"
        alias.symlink_to(self.stage, target_is_directory=True)
        self.assertNotEqual(self.run_gate(alias).returncode, 0)
        artifact = self.stage / "config-depot.capnp"
        target = self.root / "target"
        target.write_bytes(artifact.read_bytes())
        artifact.unlink()
        artifact.symlink_to(target)
        self.assertNotEqual(self.run_gate().returncode, 0)

    def test_rejects_non_elf(self):
        (self.stage / "workerd").write_bytes(b"not ELF")
        self.manifest.write_text("".join(
            hashlib.sha256((self.stage / name).read_bytes()).hexdigest() + "  " + name + "\n"
            for name in ARTIFACTS))
        self.value["artifactsDigest"] = "sha256:" + hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.assertNotEqual(self.run_gate().returncode, 0)

    def test_real_copy_preserves_original_receipt_and_all_artifacts(self):
        self.receipt.write_text(json.dumps(self.value))
        destination = self.root / "copied"
        destination.mkdir()
        script = SCRIPT.read_text()
        start = script.index('if [[ -n $prepared_stage ]]; then', script.index('REMOTE_BUILD\''))
        block = script[start:script.index('\nelse\nbuildah pull', start)] + '\nfi\n'
        env = dict(os.environ, source=str(self.source), prepared_stage=str(self.stage),
                   prepared_receipt=str(self.receipt), source_revision="a" * 40,
                   source_manifest="b" * 64, stage=str(destination))
        result = subprocess.run(["bash", "-eu", "-c", self.function + "\n" + block],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((destination / "prepared-stage-receipt.json").read_bytes(), self.receipt.read_bytes())
        for name in ARTIFACTS + ("STAGE_SHA256SUMS",):
            self.assertEqual((destination / name).read_bytes(), (self.stage / name).read_bytes())

class PreparedStageContractTest(unittest.TestCase):
    def test_rejects_missing_pair_and_outside_paths_before_remote_work(self):
        for directory, receipt in (("/data/actor-build/stage", ""), ("", "/data/actor-build/receipt"),
                                   ("/tmp/stage", "/data/actor-build/receipt"),
                                   ("/data/actor-build/../other", "/data/actor-build/receipt")):
            result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True,
                                    env=dict(os.environ, QUALIFICATION_PREPARED_STAGE_DIR=directory,
                                             QUALIFICATION_PREPARED_STAGE_RECEIPT=receipt))
            self.assertEqual(result.returncode, 2)
            self.assertIn("prepared stage and receipt must both", result.stderr)
            self.assertEqual(result.stdout, "")

    def test_preflight_and_copy_are_verified_without_relabeling_receipt(self):
        script = SCRIPT.read_text()
        self.assertEqual(script.count("declare -f verify_prepared_stage"), 2)
        self.assertLess(script.index('verify_prepared_stage "$source"'), script.index("CreateInstanceToken"))
        copy = script.index('stage_receipt=$stage/prepared-stage-receipt.json')
        self.assertIn('install -m 0644 "$prepared_receipt" "$stage_receipt"', script[copy:])
        self.assertIn('verify_prepared_stage "$source" "$stage" "$stage_receipt"', script[copy:])


if __name__ == "__main__":
    unittest.main()
