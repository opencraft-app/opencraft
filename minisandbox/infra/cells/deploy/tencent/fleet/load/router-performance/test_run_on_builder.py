import fcntl
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = (pathlib.Path(__file__).parent / "run-on-builder.sh").read_text()
ROOT = pathlib.Path(__file__).resolve().parent


class RouterPerformanceBuilderEntrypointTest(unittest.TestCase):
    def test_binds_capacity_receipt_before_load(self):
        capacity = 'collector["validate_qualification"](json.load(stream))'
        load = 'python3.11 "$runner"'
        self.assertIn(capacity, SCRIPT)
        self.assertLess(SCRIPT.index(capacity), SCRIPT.index(load))
        self.assertIn('runpy.run_path(sys.argv[1])', SCRIPT)
        self.assertIn('python3.11 - "$collector" "$capacity_receipt"', SCRIPT)

    def test_resolves_live_endpoints_without_hard_coded_addresses(self):
        self.assertIn('endpoint-installation.json', SCRIPT)
        self.assertIn("--registry-service worker-registry", SCRIPT)
        self.assertIn("--registry-namespace worker-registry-system", SCRIPT)
        self.assertNotIn("registry-url", SCRIPT)
        self.assertNotIn("10.160.", SCRIPT)

    def test_load_is_cross_cell_bounded_and_captured(self):
        for invariant in (
            "--cell actor-bj-a01 --cell actor-bj-b01",
            "--duration-seconds 300 --rate 40 --objects 256 --concurrency 64",
            '--qualification-receipt "$capacity_receipt"',
            '--output-directory "$out/evidence"',
        ):
            self.assertIn(invariant, SCRIPT)
        self.assertLess(SCRIPT.index('python3.11 "$runner"'),
                        SCRIPT.index('python3.11 "$collector"'))

    def test_refuses_mutable_or_reused_output(self):
        self.assertIn("ACTOR_REVIEWED_SOURCE", SCRIPT)
        self.assertIn("q01-src-[a-f0-9]{40}-[a-f0-9]{64}", SCRIPT)
        self.assertIn('test ! -e "$out"', SCRIPT)
        self.assertIn("flock -n 9", SCRIPT)
        self.assertIn("sha256sum", SCRIPT)

    def test_does_not_leave_an_empty_run_before_preflight_passes(self):
        self.assertLess(SCRIPT.index('collector["validate_qualification"]'),
                        SCRIPT.index('install -d -m 0700 "$out"'))


class RouterPerformanceSerializationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp", prefix="router-lock-test.")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.entry = self.root / "fleet/load/router-performance/run-on-builder.sh"
        self.entry.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / "run-on-builder.sh", self.entry)
        wrapper = self.root / "fleet/operations/with-autonomy-operation-lock.sh"
        wrapper.parent.mkdir()
        shutil.copyfile(ROOT.parent.parent / "operations/with-autonomy-operation-lock.sh", wrapper)
        wrapper.chmod(0o700)
        self.base = self.root / "bootstrap"
        (self.base / "load-tests").mkdir(parents=True)
        self.fleet_lock = self.root / "autonomy.lock"
        self.environment = os.environ.copy()
        self.environment.update({
            "AUTONOMY_CONTROL_LOCK_PATH": str(self.fleet_lock),
            "AUTONOMY_OPERATION_LOCK_WAIT_SECONDS": "0",
            "ACTOR_BOOTSTRAP_ROOT": str(self.base),
        })
        self.environment.pop("AUTONOMY_OPERATION_LOCK_HELD", None)
        self.environment.pop("ACTOR_REVIEWED_SOURCE", None)
        self.arguments = ["bash", str(self.entry), "a" * 32, "b" * 32]

    def hold(self, path):
        stream = path.open("w")
        self.addCleanup(stream.close)
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return stream

    def run_entry(self):
        return subprocess.run(self.arguments, env=self.environment, capture_output=True,
                              text=True, timeout=5)

    def test_fleet_contention_rejects_before_source_or_output(self):
        self.hold(self.fleet_lock)
        result = self.run_entry()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("another risky Cell operation", result.stderr)
        self.assertNotIn("ACTOR_REVIEWED_SOURCE", result.stderr)
        self.assertEqual(list((self.base / "load-tests").iterdir()), [])

    def test_capacity_contention_rejects_even_inside_existing_operation(self):
        self.environment["AUTONOMY_OPERATION_LOCK_HELD"] = "1"
        self.hold(self.base / "load-tests/ten-thousand-active.lock")
        result = self.run_entry()
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn("capacity qualification", result.stderr)
        self.assertNotIn("ACTOR_REVIEWED_SOURCE", result.stderr)
        self.assertFalse((self.base / ("load-tests/router-performance-" + "b" * 32)).exists())

    def test_performance_contention_rejects_before_source(self):
        self.environment["AUTONOMY_OPERATION_LOCK_HELD"] = "1"
        self.hold(self.base / "load-tests/router-performance.lock")
        result = self.run_entry()
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn("Router performance qualification", result.stderr)
        self.assertNotIn("ACTOR_REVIEWED_SOURCE", result.stderr)

    def test_locks_cover_child_and_release_after_preflight_failure(self):
        commands = self.root / "commands"
        commands.mkdir()
        gate = self.root / "readlink-gate"
        os.mkfifo(gate, 0o600)
        # A command-level process fixture pauses the real entry at source
        # selection, without accessing a reviewed source or cloud endpoint.
        readlink = commands / "readlink"
        readlink.write_text('#!/usr/bin/env bash\nIFS= read -r selected < "$LOCK_TEST_GATE"\nprintf "%s\\n" "$selected"\n')
        readlink.chmod(0o700)
        self.environment.update({"PATH": str(commands) + os.pathsep + self.environment["PATH"],
                                 "ACTOR_REVIEWED_SOURCE": "/fixture",
                                 "LOCK_TEST_GATE": str(gate)})
        process = subprocess.Popen(self.arguments, env=self.environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            # Opening the FIFO writer synchronizes with the actual child at
            # readlink. The timeout terminates only this local fixture.
            writer = subprocess.Popen(["timeout", "5", "bash", "-c",
                                       'exec 3>"$LOCK_TEST_GATE"; printf ready; read -r line; printf "%s\\n" "$line" >&3'],
                                      env=self.environment, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(writer.stdout.read(5), "ready")
                for path in (self.fleet_lock,
                             self.base / "load-tests/ten-thousand-active.lock",
                             self.base / "load-tests/router-performance.lock"):
                    result = subprocess.run(["flock", "-n", str(path), "true"], timeout=3)
                    self.assertEqual(result.returncode, 1, str(path))
                writer.communicate("/invalid-reviewed-source\n", timeout=5)
            finally:
                if writer.poll() is None:
                    writer.kill()
                writer.communicate(timeout=5)
            _, errors = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 2, errors)
            for path in (self.fleet_lock,
                         self.base / "load-tests/ten-thousand-active.lock",
                         self.base / "load-tests/router-performance.lock"):
                self.assertEqual(subprocess.run(["flock", "-n", str(path), "true"],
                                                timeout=3).returncode, 0, str(path))
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
