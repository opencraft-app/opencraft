#!/usr/bin/env python3
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("stage_reuse_inputs", ROOT / "verify-stage-reuse-inputs.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
STAGE_ROOTS = (
    "infra/cells/deploy/tencent/fleet/runtime/toolchains.lock.json",
    "infra/cells/deploy/tencent/init-workerd-pool.sh",
    "infra/cells/deploy/tencent/fleet/runtime/runtime-stage.lock.json",
    "runtimes/workerd/workerd-fdb.bundle",
    "runtimes/workerd/workerd-fdb.lock",
    "runtimes/workerd/host/workerd/config-depot.capnp",
)


class StageReuseContractTest(unittest.TestCase):
    """Source-materialization contracts run before Rust toolchain installation."""

    def test_shell_proves_closure_before_reading_base_container(self):
        script = (ROOT / "reuse-stage-from-runtime.sh").read_text()
        proof = script.index('python3 "$script_dir/verify-stage-reuse-inputs.py"')
        self.assertIn('"$base_source_dir" "$source_dir" "${stage_inputs[@]}"', script)
        self.assertLess(proof, script.index("container=$(buildah from"))
        self.assertIn('[[ $stage_inputs_digest =~ ^[0-9a-f]{64}$ ]]', script)

    def test_materialization_gate_checks_shell_and_helper_separately(self):
        script = (ROOT.parent / "verify-manifests.sh").read_text()
        self.assertIn('test_stage_reuse_inputs.py" StageReuseContractTest', script)
        shell_checks = script.split("for stage_reuse_guard in (", 1)[1].split(
            "for stage_closure_guard in (", 1
        )[0]
        self.assertIn('verify-stage-reuse-inputs.py', shell_checks)
        self.assertNotIn('base Runtime stage inputs differ', shell_checks)
        helper_checks = script.split("for stage_closure_guard in (", 1)[1].split(
            "for stage_reuse_entry_guard in (", 1
        )[0]
        self.assertIn('base Runtime stage inputs differ', helper_checks)
        self.assertIn('runtime_stage_reuse_inputs', helper_checks)
        self.assertIn('"--locked", "--offline"', helper_checks)


class StageReuseInputsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = self.root / "base"
        self.base.mkdir()
        names = ("rivet-depot-client", "rivet-envoy-protocol", "client-types", "build-helper", "depot")
        (self.base / "Cargo.toml").write_text(
            '[workspace]\nresolver="2"\nmembers=' + repr(list(names)).replace("'", '"') + "\n"
        )
        for name in names:
            package = self.base / name
            (package / "src").mkdir(parents=True)
            (package / "src/lib.rs").write_text("pub fn value() -> u8 { 1 }\n")
            manifest = '[package]\nname="{}"\nversion="0.1.0"\nedition="2021"\n'.format(name)
            if name == "rivet-depot-client":
                manifest += '[dependencies]\nclient-types={path="../client-types"}\n'
                manifest += '[dev-dependencies]\ndepot={path="../depot"}\n'
            if name == "rivet-envoy-protocol":
                manifest += '[build-dependencies]\nbuild-helper={path="../build-helper"}\n'
            (package / "Cargo.toml").write_text(manifest)
        for relative in STAGE_ROOTS:
            path = self.base / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("stage fixture\n")
        (self.base / "runtimes/workerd/workerd-fdb.lock").write_text(
            'fork_tree = "{}"\n'.format(MODULE.FFI_FORK_TREE)
        )
        subprocess.run(["cargo", "generate-lockfile", "--offline"], cwd=self.base,
                       check=True, capture_output=True)
        self.release = self.root / "release"
        shutil.copytree(self.base, self.release)

    def compare(self):
        return MODULE.compare(str(self.base), str(self.release), STAGE_ROOTS)

    def test_identical_production_closure_has_stable_digest(self):
        first = self.compare()
        self.assertEqual(len(first), 64)
        self.assertEqual(first, self.compare())

    def test_changed_client_protocol_normal_and_build_dependency_are_rejected(self):
        for package in ("rivet-depot-client", "rivet-envoy-protocol", "client-types", "build-helper"):
            with self.subTest(package=package):
                path = self.release / package / "src/lib.rs"
                original = path.read_text()
                path.write_text("pub fn value() -> u8 { 2 }\n")
                # Source timestamps do not establish compiled-artifact identity.
                os.utime(path, ns=(0, 0))
                with self.assertRaisesRegex(ValueError, "stage inputs differ"):
                    self.compare()
                path.write_text(original)

    def test_engine_only_or_dev_only_source_change_still_allows_reuse(self):
        first = self.compare()
        (self.release / "depot/src/lib.rs").write_text("pub fn value() -> u8 { 2 }\n")
        (self.release / "engine-only.rs").write_text("changed server\n")
        self.assertEqual(first, self.compare())

    def test_executable_mode_and_shared_workspace_contract_are_inputs(self):
        path = self.release / "client-types/src/lib.rs"
        path.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "stage inputs differ"):
            self.compare()
        path.chmod(0o644)
        with (self.release / "Cargo.toml").open("a") as handle:
            handle.write("\n[workspace.package]\nversion=\"0.2.0\"\n")
        with self.assertRaisesRegex(ValueError, "stage inputs differ"):
            self.compare()

    def test_missing_root_or_missing_source_is_rejected(self):
        (self.release / "rivet-depot-client/Cargo.toml").unlink()
        with self.assertRaisesRegex(ValueError, "cannot prove offline"):
            self.compare()

    def test_cargo_configuration_is_part_of_the_stage_proof(self):
        for source in (self.base, self.release):
            (source / ".cargo").mkdir()
            (source / ".cargo/config.toml").write_text("[build]\njobs=1\n")
        self.compare()
        (self.release / ".cargo/config.toml").write_text("[build]\njobs=2\n")
        with self.assertRaisesRegex(ValueError, "stage inputs differ"):
            self.compare()

    def test_future_fork_cannot_inherit_an_unaudited_direct_root_contract(self):
        for source in (self.base, self.release):
            (source / "runtimes/workerd/workerd-fdb.lock").write_text('fork_tree = "' + "f" * 40 + '"\n')
        with self.assertRaisesRegex(ValueError, "direct dependency contract is not audited"):
            self.compare()

    def test_local_dependency_outside_reviewed_source_is_rejected(self):
        outside = self.root / "outside-library"
        (outside / "src").mkdir(parents=True)
        (outside / "Cargo.toml").write_text(
            '[package]\nname="outside-library"\nversion="0.1.0"\nedition="2021"\n[workspace]\n'
        )
        (outside / "src/lib.rs").write_text("pub fn value() -> u8 { 1 }\n")
        manifest = self.release / "rivet-depot-client/Cargo.toml"
        manifest.write_text(manifest.read_text().replace(
            "[dependencies]\n", '[dependencies]\noutside-library={path="../../outside-library"}\n'
        ))
        subprocess.run(["cargo", "generate-lockfile", "--offline"], cwd=self.release,
                       check=True, capture_output=True)
        with self.assertRaisesRegex(ValueError, "dependency escaped reviewed source"):
            self.compare()

    def test_symbolic_input_cannot_hide_changed_content(self):
        path = self.release / "client-types/src/lib.rs"
        path.unlink()
        path.symlink_to(self.base / "client-types/src/lib.rs")
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            self.compare()

    def test_internal_file_link_binds_target_content_and_mode(self):
        for source in (self.base, self.release):
            (source / "shared-note").write_text("same content\n")
            (source / "client-types/AGENTS.md").symlink_to("../shared-note")
        self.compare()
        (self.release / "shared-note").write_text("changed content\n")
        with self.assertRaisesRegex(ValueError, "stage inputs differ"):
            self.compare()
        (self.release / "shared-note").write_text("same content\n")
        (self.release / "shared-note").chmod(0o755)
        with self.assertRaisesRegex(ValueError, "stage inputs differ"):
            self.compare()

    def test_directory_link_is_not_an_unproven_recursive_input(self):
        (self.release / "client-types/some-directory").symlink_to("src", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            self.compare()

    def test_changed_client_is_rejected_before_any_container_or_receipt(self):
        (self.release / "rivet-depot-client/src/lib.rs").write_text("pub fn value() -> u8 { 2 }\n")
        for source in (self.base, self.release):
            identity = source / ".actor-source"
            identity.mkdir()
            (identity / "SOURCE_REVISION").write_text("1" * 40 + "\n")
            lines = []
            for path in sorted(source.rglob("*")):
                if path.is_file() and identity not in path.parents:
                    lines.append(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + str(path.relative_to(source)))
            (identity / "RELEASE_SHA256SUMS").write_text("\n".join(lines) + "\n")
        tools = self.root / "tools"
        tools.mkdir()
        marker = self.root / "container-attempted"
        buildah = tools / "buildah"
        buildah.write_text('#!/bin/sh\ntouch "{}"\nexit 75\n'.format(marker))
        buildah.chmod(0o755)
        stage = self.root / "stage"
        stage.mkdir()
        receipt = self.root / "receipt.json"
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"],
                   RIVET_SOURCE_DIR=str(self.release), RIVET_BASE_SOURCE_DIR=str(self.base),
                   RIVET_STAGE_DIR=str(stage), RIVET_STAGE_RECEIPT=str(receipt),
                   RIVET_BASE_RUNTIME_IMAGE="registry.invalid/runtime@sha256:" + "2" * 64)
        script = os.environ.get("STAGE_REUSE_TEST_SCRIPT", str(ROOT / "reuse-stage-from-runtime.sh"))
        result = subprocess.run(["bash", script], env=env,
                                text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists(), "changed compiled client reached container reuse")
        self.assertIn("stage inputs differ", result.stderr)
        self.assertFalse(receipt.exists())
        self.assertEqual(list(stage.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
