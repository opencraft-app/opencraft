"""Run the real lock/source/receipt wrapper with an offline Go boundary double."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_receipt import intent, receipt


ROOT = Path(__file__).parent


class WrapperTests(unittest.TestCase):
    def run_wrapper(self, mode="passed", extra_source=False, held_lock=False,
                    preexisting_receipt=False):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            base = Path(temporary)
            source = base / "source"
            fleet = source / "infra/cells/deploy/tencent/fleet"
            gate = fleet / "qualification/host-eviction-api"
            gate.mkdir(parents=True)
            for name in ("run.sh", "verify_receipt.py"):
                shutil.copyfile(ROOT / name, gate / name)
            operations = fleet / "operations"
            operations.mkdir()
            shutil.copyfile(ROOT.parents[1] / "operations/with-autonomy-operation-lock.sh",
                            operations / "with-autonomy-operation-lock.sh")
            (operations / "with-autonomy-operation-lock.sh").chmod(0o700)
            metadata = source / ".actor-source"
            metadata.mkdir()
            revision = "b" * 40
            (metadata / "SOURCE_REVISION").write_text(revision + "\n")
            entries = [f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(source)}\n"
                       for path in sorted((source / "infra").rglob("*")) if path.is_file()]
            manifest = metadata / "RELEASE_SHA256SUMS"
            manifest.write_text("".join(entries))
            digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
            if extra_source:
                (source / "infra/extra.go").write_text("unreviewed build input\n")
            expected = base / "intent.json"
            expected.write_text(json.dumps(intent()))
            kubeconfig = base / "kubeconfig"
            kubeconfig.write_text("offline fixture, not credentials\n")
            value = receipt()
            value["intentSha256"] = hashlib.sha256(expected.read_bytes()).hexdigest()
            prepared = base / "synthetic-receipt.json"
            prepared.write_text(json.dumps(value))
            output = base / "receipt.json"
            if preexisting_receipt:
                output.write_text("preserve this file\n")
            fake_go = base / "go-double"
            fake_go.write_text(f"#!{sys.executable}\n" + """
import os, pathlib, shutil, sys
pathlib.Path(os.environ['TEST_CALLED']).touch()
assert sys.argv[1:] == ['test', '-mod=readonly', '-tags', 'integration', '-run',
    '^TestTKEKubernetesFencedEviction$', '-count=1', '-timeout=8m', '-v', './internal/hostdrain']
assert os.environ['AUTONOMY_OPERATION_LOCK_HELD'] == '1'
assert os.environ['GOWORK'] == 'off' and os.environ['GOTOOLCHAIN'] == 'local'
assert 'HOST_DRAIN_EVICTION_E2E_KUBECONFIG' not in os.environ
mode = os.environ['TEST_MODE']
if mode != 'skip':
    shutil.copyfile(os.environ['TEST_PREPARED'], os.environ['HOST_DRAIN_TKE_EVICTION_RECEIPT'])
raise SystemExit(1 if mode == 'failed_with_passed_json' else 0)
""")
            fake_go.chmod(0o700)
            lock = base / "operation.lock"
            env = dict(os.environ, ACTOR_GO_BINARY=str(fake_go), TEST_MODE=mode,
                       TEST_PREPARED=str(prepared), TEST_CALLED=str(base / "go-called"),
                       AUTONOMY_CONTROL_LOCK_PATH=str(lock), AUTONOMY_OPERATION_LOCK_WAIT_SECONDS="0")
            env.pop("AUTONOMY_OPERATION_LOCK_HELD", None)
            with lock.open("w") as owner:
                if held_lock:
                    fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = subprocess.run(["bash", str(gate / "run.sh"), str(source), revision,
                                         digest, str(expected), str(kubeconfig), str(output)],
                                        env=env, capture_output=True, text=True, timeout=10)
            called = (base / "go-called").exists()
            if preexisting_receipt:
                self.assertEqual(output.read_text(), "preserve this file\n")
            return result, called

    def test_completed_identity_bound_receipt_passes(self):
        result, called = self.run_wrapper()
        self.assertTrue(called, result.stderr)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("claim_eligible=false", result.stdout)

    def test_skipped_test_and_nonzero_go_exit_cannot_pass(self):
        for mode in ("skip", "failed_with_passed_json"):
            result, called = self.run_wrapper(mode=mode)
            self.assertTrue(called, result.stderr)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("tke_eviction_api_primitives=passed", result.stdout)

    def test_whole_operation_owner_source_extras_and_existing_receipt_are_rejected(self):
        for kwargs in ({"held_lock": True}, {"extra_source": True}, {"preexisting_receipt": True}):
            with self.subTest(kwargs=kwargs):
                result, called = self.run_wrapper(**kwargs)
                self.assertFalse(called, result.stderr)
                self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
