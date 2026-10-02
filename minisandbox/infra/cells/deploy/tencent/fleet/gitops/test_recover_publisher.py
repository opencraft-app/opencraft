#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("recover_publisher", Path(__file__).with_name("recover-publisher.py"))
RECOVERY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECOVERY)


class PrivateJournalTests(unittest.TestCase):
    def test_missing_lock_fails_before_kubernetes_or_credentials(self):
        env = dict(os.environ)
        env.pop("AUTONOMY_OPERATION_LOCK_HELD", None)
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("recover-publisher.py"))],
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires the shared operation lock wrapper", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_real_wrapper_retains_lock_for_recovery_process(self):
        wrapper = Path(__file__).resolve().parents[1] / "operations/with-autonomy-operation-lock.sh"
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, AUTONOMY_CONTROL_LOCK_PATH=str(Path(directory) / "lock"))
            code = ('import importlib.util; s=importlib.util.spec_from_file_location("r", ' +
                    repr(str(Path(__file__).with_name("recover-publisher.py"))) +
                    '); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.require_operation_lock()')
            result = subprocess.run(["bash", str(wrapper), "--", sys.executable, "-c", code],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_atomic_private_replacement_preserves_reader(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credentials.json"
            old = {"reader": {"token": "existing-reader"}, "publisher": {"token": "old"}}
            RECOVERY.save_private(path, old)
            next_document = json.loads(path.read_text())
            next_document["publisher"] = {"token": "new"}
            RECOVERY.save_private(path, next_document)
            self.assertEqual(json.loads(path.read_text())["reader"], old["reader"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_serialization_failure_retains_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "journal.json"
            RECOVERY.save_private(path, {"password": "persisted"})
            with self.assertRaises(TypeError):
                RECOVERY.save_private(path, {"password": object()})
            self.assertEqual(json.loads(path.read_text()), {"password": "persisted"})
            self.assertEqual(list(Path(directory).iterdir()), [path])


if __name__ == "__main__":
    unittest.main()
