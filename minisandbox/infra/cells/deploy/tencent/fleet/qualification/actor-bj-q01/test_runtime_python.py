"""The qualified runtime Python must reach every child, not just receipts."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("build-runtime-via-tat.sh")


class RuntimePythonTest(unittest.TestCase):
    def selection(self):
        source = SCRIPT.read_text()
        start = source.index('ln -s "$(command -v python3.11)" "$python_shim/python3"')
        return source[start:source.index("\nlock_sha=", start)]

    def test_real_child_uses_qualified_python_despite_old_host_default(self):
        qualified = shutil.which("python3.11")
        if not qualified:
            self.skipTest("real qualified Python 3.11 is not installed")
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            root = Path(directory)
            tools = root / "bin"
            tools.mkdir()
            old = tools / "python3"
            old.write_text("#!/bin/sh\necho old-host-python >&2\nexit 86\n")
            old.chmod(0o755)
            (tools / "python3.11").symlink_to(qualified)
            shim = root / "python-shim"
            shim.mkdir()
            environment = dict(os.environ, PATH=str(tools) + ":" + os.environ["PATH"],
                               python_shim=str(shim))
            child = self.selection() + "\n" + '''python3 - <<'PY'
import subprocess
import sys
assert sys.version_info[:2] == (3, 11)
# This exact API failed on the TencentOS default Python 3.6.
assert subprocess.run(["/bin/true"], text=True, capture_output=True).returncode == 0
print("qualified-child-passed")
PY
'''
            result = subprocess.run(["bash", "-eu", "-c", child], env=environment,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "qualified-child-passed")
            # Selection is process-local, not an alteration of host defaults.
            original = subprocess.run(["python3", "-V"], env=environment,
                                      capture_output=True, text=True)
            self.assertEqual(original.returncode, 86)

    def test_failed_interpreter_check_stops_before_child_work(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            root = Path(directory)
            tools = root / "bin"
            tools.mkdir()
            invalid = tools / "python3.11"
            invalid.write_text("#!/bin/sh\nexit 73\n")
            invalid.chmod(0o755)
            shim = root / "python-shim"
            shim.mkdir()
            marker = root / "must-not-run"
            result = subprocess.run(
                ["bash", "-eu", "-c", self.selection() + '\ntouch "$marker"'],
                env=dict(os.environ, PATH=str(tools) + ":" + os.environ["PATH"],
                         python_shim=str(shim), marker=str(marker)),
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 73)
            self.assertFalse(marker.exists())

    def test_preflight_precedes_push_authority_and_remote_shim_is_cleaned(self):
        source = SCRIPT.read_text()
        check = "python3.11 -c 'import sys; assert sys.version_info[:2] == (3, 11)'"
        self.assertLess(source.index(check), source.index("CreateInstanceToken"))
        self.assertIn('rm -rf -- "$python_shim"', source)
        selection = source.index('ln -s "$(command -v python3.11)" "$python_shim/python3"')
        self.assertLess(source.index("trap cleanup_remote EXIT INT TERM"), selection)
        self.assertLess(selection, source.index('"$source/infra/cells/deploy/tencent/fleet/runtime/prepare-cargo-cache.sh"'))
        self.assertLess(selection, source.index('"$source/infra/cells/deploy/tencent/fleet/runtime/reuse-stage-from-runtime.sh"'))


if __name__ == "__main__":
    unittest.main()
