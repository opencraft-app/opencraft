"""Monitor orchestration tests; no cloud mutation or credentials required."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for path in ("runtime", "tat", "qualification/actor-bj-q01"):
            (self.root / path).mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name("monitor-bottomless-qualification.sh"),
                        self.root / "runtime/monitor.sh")
        self.script("tat/tat-wait.sh", 'exit "${WAIT_EXIT:-0}"')
        self.script("tat/lib-tat.sh", '''
tat_initialize() { :; }
tat_tccli() { printf '%s' "$OBSERVATION"; }
''')
        self.script("tat/tat-download.sh", 'echo tat >>"$TRACE"; printf "{}" >"$2"')
        self.script("qualification/actor-bj-q01/persist-receipt-from-builder.sh",
                    'echo cos >>"$TRACE"; test "${COS_FAIL:-0}" = 0; printf "{}" >"$2"')
        (self.root / "runtime/verify_bottomless_receipt.py").write_text(
            'import os\nwith open(os.environ["TRACE"], "a") as f: f.write("verify\\n")\n')

    def script(self, path, body):
        target = self.root / path
        target.write_text("#!/usr/bin/env bash\nset -eu\n" + body + "\n")
        target.chmod(0o755)

    def run_monitor(self, cell="actor-bj-q01", status="SUCCESS", **extra):
        trace = self.root / "trace"
        env = dict(os.environ, TRACE=str(trace), TAT_INSTANCE_ID="ins-test",
                   TENCENT_REGION="ap-beijing", OBSERVATION=json.dumps({
                       "InvocationTaskSet": [{"InstanceId": "ins-test", "TaskStatus": status}]
                   }), **extra)
        result = subprocess.run([
            "bash", str(self.root / "runtime/monitor.sh"), "inv-test",
            f"/data/actor-qualification/receipts/{cell}-test.json",
            str(self.root / f"{cell}-test.json"), "production-cell",
        ], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        return result, trace.read_text().splitlines() if trace.exists() else []

    def test_q01_uses_cos_then_verifies(self):
        result, trace = self.run_monitor()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace, ["cos", "verify"])

    def test_failure_is_archived_without_success_verification(self):
        result, trace = self.run_monitor(status="FAILED", WAIT_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(trace, ["cos"])

    def test_observation_failure_does_not_fetch_or_restart(self):
        result, trace = self.run_monitor(status="RUNNING", WAIT_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(trace, [])

    def test_cos_failure_does_not_fallback_or_verify(self):
        result, trace = self.run_monitor(COS_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(trace, ["cos"])

    def test_other_cell_keeps_existing_transport(self):
        result, trace = self.run_monitor(cell="actor-bj-other")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace, ["tat", "verify"])


if __name__ == "__main__":
    unittest.main()
