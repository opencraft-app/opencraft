"""Offline tests for the rootfs conversion boundary."""

from __future__ import annotations

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).with_name("build.py")
SPEC = importlib.util.spec_from_file_location("minisandbox_rootfs_build", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
build = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = build
SPEC.loader.exec_module(build)


class RootfsBuildTests(unittest.TestCase):
    def test_actor_volume_defaults_to_the_two_gib_system_capacity(self) -> None:
        with mock.patch.object(sys, "argv", ["build.py", "actor-volume-template"]):
            arguments = build.parse_arguments()
        self.assertEqual(arguments.size_mib, 2048)
        self.assertEqual(arguments.output.name, "actor-volume-template-2g.ext4")
        self.assertEqual(build.DEFAULT_ACTOR_VOLUME_SIZE, build.DEFAULT_UPPER_SIZE)

    def test_ext4_journal_scales_but_is_bounded(self) -> None:
        self.assertEqual(build.ext4_journal_size_mib(64), 4)
        self.assertEqual(build.ext4_journal_size_mib(1024), 16)
        self.assertEqual(build.ext4_journal_size_mib(2048), 32)
        self.assertEqual(build.ext4_journal_size_mib(16384), 32)

    def test_tar_overlay_replaces_files_and_preserves_requested_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "rootfs.tar"
            with tarfile.open(archive, "w:") as output:
                directory_entry = tarfile.TarInfo("etc/")
                directory_entry.type = tarfile.DIRTYPE
                directory_entry.mode = 0o755
                output.addfile(directory_entry)
                old = b"old\n"
                old_entry = tarfile.TarInfo("etc/resolv.conf")
                old_entry.size = len(old)
                old_entry.mode = 0o644
                output.addfile(old_entry, io.BytesIO(old))

            build.replace_tar_files(
                archive,
                {
                    "etc/resolv.conf": b"nameserver 192.0.2.53\n",
                    "opt/minisandbox/runner": build.TarFile(b"elf", 0o755),
                },
            )

            with tarfile.open(archive, "r:") as source:
                names = source.getnames()
                self.assertEqual(names.count("etc/resolv.conf"), 1)
                self.assertIn("opt", names)
                self.assertIn("opt/minisandbox", names)
                resolver = source.getmember("etc/resolv.conf")
                self.assertEqual(resolver.mode, 0o644)
                self.assertEqual(source.extractfile(resolver).read(), b"nameserver 192.0.2.53\n")
                runner = source.getmember("opt/minisandbox/runner")
                self.assertEqual(runner.mode, 0o755)
                self.assertEqual(source.extractfile(runner).read(), b"elf")

    def test_tar_overlay_rejects_host_or_parent_paths(self) -> None:
        for name in ["/absolute", "../escape", "safe/../../escape", ""]:
            with self.subTest(name=name):
                with self.assertRaises(build.BuildError):
                    build.normalized_tar_name(name)

    def test_tar_overlay_rejects_a_non_directory_parent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "rootfs.tar"
            with tarfile.open(archive, "w:") as output:
                symlink = tarfile.TarInfo("sbin")
                symlink.type = tarfile.SYMTYPE
                symlink.linkname = "usr/sbin"
                output.addfile(symlink)
            with self.assertRaisesRegex(build.BuildError, "parent is not a directory"):
                build.replace_tar_files(archive, {"sbin/minisandbox-init": b"elf"})

    def test_hermes_lock_matches_builder_pin(self) -> None:
        lock = json.loads(
            (Path(__file__).with_name("hermes-agent") / "hermes.lock.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(lock["revision"], build.HERMES_PROFILE)
        self.assertEqual(lock["platform"], "linux/amd64")

    def test_docker_probe_rejects_format_mode_false_success(self) -> None:
        result = build.subprocess.CompletedProcess(
            ["docker", "info"],
            0,
            stdout="\n",
            stderr="Cannot connect to the Docker daemon\n",
        )
        with mock.patch.object(build.subprocess, "run", return_value=result):
            with self.assertRaises(build.BuildError):
                build.ensure_docker()

    def test_hermes_dockerfile_rewrites_are_exact_and_ordered(self) -> None:
        source = (
            b"FROM debian:13.4\n"
            b"COPY --link --chmod=a+rX,go-w . .\n"
            b'RUN uv pip install --no-cache-dir --no-deps -e "."\n'
        )
        patched = build.patch_hermes_dockerfile(source)
        self.assertEqual(patched.count(b"AS minisandbox_hermes_runtime"), 1)
        self.assertNotIn(b"dmsetup", patched)
        self.assertNotIn(b"thin-provisioning-tools", patched)
        self.assertEqual(patched.count(b"AS minisandbox_hermes_base"), 1)
        self.assertEqual(patched.count(b"AS minisandbox_hermes_app"), 1)
        self.assertEqual(patched.count(b"COPY --link . ."), 1)
        self.assertEqual(patched.count(b"RUN chmod -R a+rX,go-w ."), 1)
        self.assertEqual(patched.count(build.HERMES_BYTECODE_BUILD_STEP.rstrip()), 1)
        self.assertLess(
            patched.index(b'RUN uv pip install --no-cache-dir --no-deps -e "."'),
            patched.index(build.HERMES_BYTECODE_BUILD_STEP.rstrip()),
        )
        with self.assertRaises(build.BuildError):
            build.patch_hermes_dockerfile(b"FROM scratch\n")

    def test_hermes_bytecode_anchor_fails_closed(self) -> None:
        source = b"FROM debian:13.4\nCOPY --link --chmod=a+rX,go-w . .\n"
        with self.assertRaisesRegex(build.BuildError, "editable install"):
            build.patch_hermes_dockerfile(source)

    def test_checked_hash_compileall_works_when_runtime_writes_are_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sample.py"
            source.write_text("VALUE = 42\n", encoding="utf-8")
            environment = dict(os.environ)
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            command = [
                sys.executable,
                "-m",
                "compileall",
                "--invalidation-mode",
                "checked-hash",
                "-o",
                "0",
                "-f",
                "-q",
                source,
            ]
            subprocess.run(command, check=True, env=environment)
            bytecode_path = Path(importlib.util.cache_from_source(str(source)))
            bytecode = bytecode_path.read_bytes()
            self.assertEqual(int.from_bytes(bytecode[4:8], "little"), 0b11)
            os.utime(source, (1_000_000_000, 1_000_000_000))
            subprocess.run(command, check=True, env=environment)
            self.assertEqual(bytecode_path.read_bytes(), bytecode)

    def test_application_layer_is_additive_and_rejects_whiteouts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "app"
            (source / "opt" / "hermes").mkdir(parents=True)
            (source / "opt" / "hermes" / "version").write_text("v2", encoding="utf-8")
            self.assertEqual(build.validate_app_layer(source, "directory"), 3)
            (source / "opt" / "hermes" / ".wh.old-version").touch()
            with self.assertRaisesRegex(build.BuildError, "unsupported OCI whiteout"):
                build.validate_app_layer(source, "directory")

    def test_application_tar_paths_are_validated_before_build(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "app.tar"
            with tarfile.open(archive, "w:") as output:
                entry = tarfile.TarInfo("opt/application")
                payload = b"version-1"
                entry.size = len(payload)
                output.addfile(entry, io.BytesIO(payload))
            self.assertEqual(build.validate_app_layer(archive, "merged-rootfs-tar"), 1)

    def test_application_delta_omits_base_bytes_and_materializes_hardlinks(self) -> None:
        def add_directory(archive: tarfile.TarFile, name: str) -> None:
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.DIRTYPE
            entry.mode = 0o755
            archive.addfile(entry)

        def add_file(archive: tarfile.TarFile, name: str, payload: bytes, mtime: int) -> None:
            entry = tarfile.TarInfo(name)
            entry.size = len(payload)
            entry.mode = 0o644
            entry.mtime = mtime
            archive.addfile(entry, io.BytesIO(payload))

        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "base.tar"
            final = Path(directory) / "final.tar"
            app = Path(directory) / "app.tar"
            with tarfile.open(base, "w:") as archive:
                add_directory(archive, "opt")
                add_directory(archive, "opt/hermes")
                add_file(archive, "opt/hermes/same", b"shared", 1)
                add_file(archive, "opt/hermes/version", b"v1", 1)
                add_file(archive, "opt/hermes/base-only", b"retained", 1)
            with tarfile.open(final, "w:") as archive:
                add_directory(archive, "opt")
                add_directory(archive, "opt/hermes")
                add_file(archive, "opt/hermes/same", b"shared", 999)
                add_file(archive, "opt/hermes/version", b"v2", 999)
                add_file(archive, "opt/hermes/new", b"new", 999)
                hardlink = tarfile.TarInfo("opt/hermes/version-link")
                hardlink.type = tarfile.LNKTYPE
                hardlink.linkname = "opt/hermes/version"
                hardlink.mode = 0o644
                archive.addfile(hardlink)

            stats = build.build_app_delta_tar(base, final, app)
            self.assertEqual(stats["base_only_entries_retained"], 1)
            with tarfile.open(app, "r:") as archive:
                names = set(archive.getnames())
                self.assertIn("opt/hermes/version", names)
                self.assertIn("opt/hermes/new", names)
                self.assertNotIn("opt/hermes/same", names)
                self.assertNotIn("opt/hermes/base-only", names)
                link = archive.getmember("opt/hermes/version-link")
                self.assertTrue(link.isfile())
                self.assertEqual(archive.extractfile(link).read(), b"v2")


if __name__ == "__main__":
    unittest.main()
