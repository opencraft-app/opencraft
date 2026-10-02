"""Check that runtime releases reject floating OS base inputs before building."""
import os
from pathlib import Path
import subprocess
import unittest


class RuntimeBaseContractTest(unittest.TestCase):
    def test_missing_or_floating_base_is_rejected_before_source_access(self):
        script = Path(__file__).with_name("build-image.sh")
        for base in (None, "rockylinux:8-minimal", "registry/base@sha256:abc"):
            env = dict(os.environ, RIVET_SOURCE_DIR="/nonexistent-reviewed-source",
                       RIVET_STAGE_DIR="/nonexistent-stage", RIVET_RUNTIME_IMAGE_TAG="registry/runtime:test",
                       RIVET_RUNTIME_CONFIG_FILE="/nonexistent-config")
            env.pop("RIVET_RUNTIME_BASE_IMAGE", None)
            if base is not None:
                env["RIVET_RUNTIME_BASE_IMAGE"] = base
            result = subprocess.run(["bash", str(script)], env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    universal_newlines=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("base", result.stderr.lower())
            self.assertNotIn("nonexistent-reviewed-source", result.stderr)

    def test_release_dockerfile_never_installs_os_packages(self):
        dockerfile = Path(__file__).with_name("Dockerfile").read_text()
        self.assertIn("FROM ${RUNTIME_BASE_IMAGE}", dockerfile)
        for manager in ("microdnf", "apt-get", "yum install", "dnf install"):
            self.assertNotIn(manager, dockerfile)

    def test_builder_glibc_must_match_runtime_base_before_cargo(self):
        script = Path(__file__).with_name("build-image.sh").read_text()
        abi_gate = script.index('builder_glibc=$(getconf GNU_LIBC_VERSION)')
        runtime_gate = script.index('runtime_glibc=$(buildah run')
        cargo_build = script.index("cargo build --locked --release")
        self.assertLess(abi_gate, cargo_build)
        self.assertLess(runtime_gate, cargo_build)
        self.assertIn('[[ $builder_glibc == "$runtime_glibc" ]]', script)

    def test_compiler_side_effects_stay_outside_reviewed_source(self):
        script = Path(__file__).with_name("build-image.sh").read_text()
        output_dir = script.index(
            'export RIVET_ERROR_OUTPUT_DIR="$cargo_target_dir/rivet-error-docs"'
        )
        cargo_build = script.index("cargo build --locked --release")
        self.assertLess(output_dir, cargo_build)
        self.assertIn('install -d -m 0755 "$RIVET_ERROR_OUTPUT_DIR"', script)


if __name__ == "__main__":
    unittest.main()
