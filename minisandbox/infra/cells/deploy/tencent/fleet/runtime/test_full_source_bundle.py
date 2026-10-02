#!/usr/bin/env python3

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("verify_full_source", ROOT / "verify-full-source-bundle.py")
VERIFY = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(VERIFY)


class FullSourceBundleTests(unittest.TestCase):
    def make_repository(self, root: Path, nested: bool = False) -> tuple[Path, Path, str]:
        repository = root / "repository"
        repository.mkdir()
        subprocess.run(["git", "init", "-q", repository], check=True)
        subprocess.run(["git", "-C", repository, "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", repository, "config", "user.name", "test"], check=True)
        project = repository / "minisandbox" if nested else repository
        project.mkdir(exist_ok=True)
        (project / "payload.txt").write_text("reviewed\n", encoding="utf-8")
        if nested:
            (repository / "sibling.txt").write_text("must not be bundled\n", encoding="utf-8")
        subprocess.run(["git", "-C", repository, "add", "."], check=True)
        subprocess.run(["git", "-C", repository, "commit", "-qm", "reviewed"], check=True)
        revision = subprocess.check_output(["git", "-C", repository, "rev-parse", "HEAD"], text=True).strip()
        return repository, project, revision

    def run_bundle(self, repository: Path, revision: str, bundle: Path, receipt: Path):
        environment = os.environ.copy()
        environment.update(
            RIVET_SOURCE_DIR=str(repository),
            RIVET_SOURCE_REVISION=revision,
            RIVET_SOURCE_BUNDLE=str(bundle),
            RIVET_SOURCE_RECEIPT=str(receipt),
        )
        return subprocess.run(
            [ROOT / "bundle-full-reviewed-source.sh"],
            env=environment,
            check=False,
            text=True,
            capture_output=True,
        )

    def test_bundle_is_deterministic_restart_safe_and_verified(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            repository, project, revision = self.make_repository(root)
            bundle, receipt = root / "source.tar.gz", root / "source.receipt.json"
            first = self.run_bundle(project, revision, bundle, receipt)
            self.assertEqual(first.returncode, 0, first.stderr)
            first_bytes = bundle.read_bytes()
            first_receipt = receipt.read_bytes()
            second = self.run_bundle(project, revision, bundle, receipt)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(bundle.read_bytes(), first_bytes)
            self.assertEqual(receipt.read_bytes(), first_receipt)
            value = VERIFY.verify(bundle, receipt, revision)
            self.assertEqual(value["schema"], "actor-reviewed-source-bundle/v2")
            self.assertEqual(value["source"]["projectPath"], ".")
            self.assertEqual(value["bundle"]["name"], bundle.name)

    def test_nested_project_is_archive_root_and_siblings_are_excluded(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            repository, project, revision = self.make_repository(root, nested=True)
            bundle, receipt = root / "source.tar.gz", root / "source.receipt.json"
            result = self.run_bundle(project, revision, bundle, receipt)
            self.assertEqual(result.returncode, 0, result.stderr)
            unpacked = root / "unpacked"
            unpacked.mkdir()
            subprocess.run(["tar", "-xzf", bundle, "-C", unpacked], check=True)
            self.assertEqual((unpacked / "payload.txt").read_text(), "reviewed\n")
            self.assertFalse((unpacked / "minisandbox").exists())
            self.assertFalse((unpacked / "sibling.txt").exists())
            value = VERIFY.verify(bundle, receipt, revision)
            self.assertEqual(value["source"]["projectPath"], "minisandbox")
            project_tree = subprocess.check_output(
                ["git", "-C", repository, "rev-parse", f"{revision}:minisandbox"], text=True
            ).strip()
            self.assertEqual(value["source"]["projectTree"], project_tree)

    def test_existing_bundle_without_receipt_is_recovered_only_if_exact(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            repository, project, revision = self.make_repository(root)
            bundle, receipt = root / "source.tar.gz", root / "source.receipt.json"
            self.assertEqual(self.run_bundle(project, revision, bundle, receipt).returncode, 0)
            receipt.unlink()
            recovered = self.run_bundle(project, revision, bundle, receipt)
            self.assertEqual(recovered.returncode, 0, recovered.stderr)
            VERIFY.verify(bundle, receipt, revision)
            receipt.unlink()
            bundle.write_bytes(b"different")
            rejected = self.run_bundle(project, revision, bundle, receipt)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(receipt.exists())

    def test_tampered_receipt_or_bundle_is_rejected(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            repository, project, revision = self.make_repository(root)
            bundle, receipt = root / "source.tar.gz", root / "source.receipt.json"
            self.assertEqual(self.run_bundle(project, revision, bundle, receipt).returncode, 0)
            value = json.loads(receipt.read_text())
            value["bundle"]["bytes"] += 1
            receipt.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "bytes do not match"):
                VERIFY.verify(bundle, receipt, revision)

    def test_unsafe_or_ambiguous_project_path_is_rejected(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            repository, project, revision = self.make_repository(root, nested=True)
            bundle, receipt = root / "source.tar.gz", root / "source.receipt.json"
            self.assertEqual(self.run_bundle(project, revision, bundle, receipt).returncode, 0)
            value = json.loads(receipt.read_text())
            for project_path in ("../minisandbox", "/minisandbox", "minisandbox/./runtime"):
                with self.subTest(project_path=project_path):
                    value["source"]["projectPath"] = project_path
                    receipt.write_text(json.dumps(value), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "project path"):
                        VERIFY.verify(bundle, receipt, revision)


if __name__ == "__main__":
    unittest.main()
