#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("prepare-cargo-cache.sh")


class CargoCacheTest(unittest.TestCase):
    def test_reuses_only_identical_transitive_inputs(self):
        with tempfile.TemporaryDirectory(dir="/data/build-cache") as temporary:
            root = Path(temporary)
            source = root / "source"
            target = root / "target"
            state_root = Path("/var/lib/actor-build/runtime-workspace")
            state_root.mkdir(parents=True, exist_ok=True)
            state = state_root / ("test-" + root.name + ".sha256")
            self.addCleanup(state.unlink, missing_ok=True)
            for package in ("rivet-engine", "rivet-workerd-host"):
                package_root = source / package
                (package_root / "src").mkdir(parents=True)
                (package_root / "Cargo.toml").write_text(
                    f'[package]\nname="{package}"\nversion="0.1.0"\nedition="2021"\n'
                )
                (package_root / "src/lib.rs").write_text("pub fn value() -> u8 { 1 }\n")
            (source / "Cargo.toml").write_text(
                '[workspace]\nresolver="2"\nmembers=["rivet-engine","rivet-workerd-host"]\n'
            )
            subprocess.run(
                ["cargo", "generate-lockfile", "--offline"], cwd=source, check=True,
                stdout=subprocess.DEVNULL,
            )
            env = dict(
                os.environ,
                RIVET_IMMUTABLE_SOURCE_DIR=str(source),
                RIVET_CARGO_TARGET_DIR=str(target),
                RIVET_CARGO_CACHE_STATE=str(state),
                ACTOR_BUILD_PYTHON=sys.executable,
            )

            first = subprocess.run([str(SCRIPT)], env=env, text=True, capture_output=True, check=True)
            self.assertIn("cargo_cache=reset", first.stdout)
            self.assertEqual(first.stderr, "")
            marker = target / "marker"
            marker.write_text("cache")
            second = subprocess.run([str(SCRIPT)], env=env, text=True, capture_output=True, check=True)
            self.assertIn("cargo_cache=reused", second.stdout)
            self.assertTrue(marker.exists())
            (source / "rivet-engine/src/lib.rs").write_text("pub fn value() -> u8 { 2 }\n")
            third = subprocess.run([str(SCRIPT)], env=env, text=True, capture_output=True, check=True)
            self.assertIn("cargo_cache=reset", third.stdout)
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
