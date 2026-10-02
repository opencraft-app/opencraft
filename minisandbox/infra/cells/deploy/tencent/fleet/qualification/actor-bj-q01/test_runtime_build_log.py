"""Exercise bounded TAT output with a real noisy child process."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class RuntimeBuildLogTest(unittest.TestCase):
    def test_full_log_and_child_exit_survive_output_bounding(self):
        source = Path(__file__).with_name("build-runtime-via-tat.sh").read_text()
        start = source.index('build_log=$(mktemp "/data/actor-qualification/builds/')
        block = source[start:source.index("\nREMOTE_BUILD", start)]
        for status in (0, 7):
            with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
                root = Path(directory)
                executable = root / "infra/cells/deploy/tencent/fleet/runtime/build-image.sh"
                executable.parent.mkdir(parents=True)
                executable.write_text("#!/bin/sh\nprintf '%50000s' x\nprintf '\\nterminal-result\\n'\nexit " + str(status) + "\n")
                executable.chmod(0o755)
                runner = root / "bin/systemd-run"
                runner.parent.mkdir()
                runner.write_text("#!/bin/bash\nset -eu\ntest \"$1\" = --scope; shift\ntest \"$1\" = --quiet; shift\n[[ \"$1\" == --unit=actor-bj-a01-runtime-build-* ]]; shift\nfor property in MemoryMax=6G CPUQuota=200% TasksMax=512; do\n  test \"$1\" = -p; test \"$2\" = \"$property\"; shift 2\ndone\nexec \"$@\"\n")
                runner.chmod(0o755)
                logs = root / "logs"
                logs.mkdir()
                env = dict(os.environ, source=str(root), source_revision="a"*40,
                           cell_name="actor-bj-a01",
                           stage_dir=str(root), stage=str(root), runtime_config="unused",
                           stage_receipt=str(root / "stage-receipt.json"),
                           image_tag="unused", auth="unused", PATH=str(runner.parent)+":"+os.environ["PATH"])
                result = subprocess.run(
                    ["bash", "-eu", "-c", block.replace("/data/actor-qualification/builds", str(logs))],
                    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.assertEqual(result.returncode, status, result.stderr)
                paths = list(logs.glob("*.log"))
                self.assertEqual(len(paths), 1)
                payload = paths[0].read_bytes()
                self.assertGreater(len(payload), 50000)
                self.assertLess(len(result.stdout), 13000)
                self.assertIn(hashlib.sha256(payload).hexdigest().encode(), result.stdout)
                self.assertIn(b"terminal-result", result.stdout)


if __name__ == "__main__":
    unittest.main()
