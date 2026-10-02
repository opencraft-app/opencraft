#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("assemble_management_code_plane", ROOT / "assemble-management-code-plane.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def sha(path: Path, prefix: bool = True) -> str:
    value = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{value}" if prefix else value


def write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


class ManagementCodePlaneChainTests(unittest.TestCase):
    def fixture(self, root: Path) -> argparse.Namespace:
        inventory = root / "management-inventory.json"
        images = root / "images.json"
        management_images = root / "management-images.json"
        management_git = root / "management-git.json"
        render_receipt = root / "render.json"
        install_receipt = root / "install.json"
        desired_receipt = root / "git-render.json"
        publication = root / "publication.json"
        application = root / "application.yaml"
        convergence = root / "convergence.json"
        bootstrap = root / "bootstrap"
        git_desired = root / "git"
        bootstrap.mkdir()
        git_desired.mkdir()

        image_digest = "sha256:" + "1" * 64
        management_image_digest = "sha256:" + "2" * 64
        write(inventory, {"schema": "management-inventory/v1"})
        write(images, {"inventoryDigest": image_digest})
        write(management_images, {"inventoryDigest": management_image_digest})
        repository = "http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git"
        write(management_git, {
            "schema": "actor-create-first-management-git/v1", "verdict": "passed",
            "managementId": "actor-bj-c01", "cluster": {"id": "cls-management1", "uid": "cluster-uid"},
            "imageInventoryDigest": management_image_digest, "repository": {"url": repository},
        })
        for name in MODULE.BOOTSTRAP_MANIFESTS:
            (bootstrap / name).write_text(f"kind: ConfigMap\nmetadata:\n  name: {name}\n")
        write(render_receipt, {
            "schema": "actor-regional-code-plane-render/v1", "verdict": "passed",
            "managementId": "actor-bj-c01", "clusterId": "cls-management1",
            "imageInventoryDigest": image_digest,
            "files": {name: sha(bootstrap / name, False) for name in MODULE.BOOTSTRAP_MANIFESTS},
        })
        external = {
            "fdbPullUid": "fdb-pull", "registryPullUid": "registry-pull",
            "backupCredentialsUid": "backup-secret", "registryFdbUid": "registry-fdb",
            "registryTlsUid": "registry-tls", "registryCosUid": "registry-cos",
        }
        write(install_receipt, {
            "schema": "actor-regional-code-plane-install/v1", "verdict": "passed",
            "managementId": "actor-bj-c01", "cluster": {"id": "cls-management1", "uid": "cluster-uid"},
            "imageInventoryDigest": image_digest,
            "inputs": {
                "terraformInventorySha256": sha(inventory, False),
                "imageInventorySha256": sha(images, False),
                "renderReceiptSha256": sha(render_receipt, False),
            },
            "foundationDB": {"uid": "fdb-uid", "backup": {"uid": "backup-uid", "restorable": True}},
            "registry": {
                "deploymentUid": "registry-uid", "privateServiceUid": "service-uid",
                "endpoint": "http://10.1.2.3:8080",
            },
            "externalSecrets": external,
        })
        for name in MODULE.GIT_MANIFESTS:
            (git_desired / name).write_text(f"artifact={name}\n")
        git_files = {name: sha(git_desired / name) for name in MODULE.GIT_MANIFESTS}
        write(desired_receipt, {
            "schema": "actor-regional-code-plane-desired-render/v1", "verdict": "passed",
            "managementId": "actor-bj-c01", "files": git_files,
            "sources": {
                "renderReceiptSha256": sha(render_receipt),
                "installReceiptSha256": sha(install_receipt),
            },
        })
        revision = "a" * 40
        write(publication, {
            "schema": "actor-regional-code-plane-desired-publication/v1", "verdict": "passed",
            "repository": {"url": repository, "branch": "main", "path": "management/code-plane"},
            "gitRevision": revision, "renderReceiptSha256": sha(desired_receipt), "files": git_files,
        })
        documents = MODULE.application_renderer().render(publication, desired_receipt)
        application.write_text(yaml.safe_dump_all(documents, explicit_start=True, sort_keys=True))
        write(convergence, {
            "schema": "actor-regional-code-plane-argocd-convergence/v1", "verdict": "passed",
            "gitRevision": revision,
            "sourceReceipts": {
                "publicationSha256": sha(publication, False),
                "desiredRenderSha256": sha(desired_receipt, False),
            },
            "applicationUid": "application-uid",
            "adoptedIdentity": {
                "fdbClusterUid": "fdb-uid", "fdbBackupUid": "backup-uid",
                "registryDeploymentUid": "registry-uid", "registryPrivateServiceUid": "service-uid",
                "endpointIp": "10.1.2.3", "secrets": external,
            },
            "gates": {
                "synced": True, "identityPreserved": True, "secretsExternallyOwned": True,
                "pruneDisabled": True, "selfHeal": True,
            },
        })
        return argparse.Namespace(
            inventory=inventory, images=images, management_bootstrap_images=management_images,
            management_git_receipt=management_git,
            bootstrap_desired=bootstrap, render_receipt=render_receipt, install_receipt=install_receipt,
            git_desired=git_desired, desired_render_receipt=desired_receipt,
            publication_receipt=publication, application=application, convergence_receipt=convergence,
        )

    def test_assembles_complete_bound_chain(self) -> None:
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            args = self.fixture(Path(temporary))
            value = MODULE.assemble(args)
            self.assertEqual(value["verdict"], "passed")
            self.assertEqual(value["identity"]["registryEndpoint"], "http://10.1.2.3:8080")
            self.assertNotEqual(value["imageInventoryDigest"], value["managementBootstrapImageInventoryDigest"])
            self.assertTrue(value["gates"]["physicallyRestorableBackup"])

    def test_rejects_changed_authoritative_inventory(self) -> None:
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            args = self.fixture(Path(temporary))
            args.inventory.write_text("{}\n")
            with self.assertRaisesRegex(ValueError, "exact rebuild inputs"):
                MODULE.assemble(args)

    def test_rejects_substituted_management_bootstrap_inventory(self) -> None:
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            args = self.fixture(Path(temporary))
            write(args.management_bootstrap_images, {"inventoryDigest": "sha256:" + "f" * 64})
            with self.assertRaisesRegex(ValueError, "management Git differs"):
                MODULE.assemble(args)

    def test_rejects_adoption_identity_change(self) -> None:
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            args = self.fixture(Path(temporary))
            value = json.loads(args.convergence_receipt.read_text())
            value["adoptedIdentity"]["fdbClusterUid"] = "replacement-fdb"
            write(args.convergence_receipt, value)
            with self.assertRaisesRegex(ValueError, "changed Code Plane identity"):
                MODULE.assemble(args)

    def test_rejects_application_drift(self) -> None:
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            args = self.fixture(Path(temporary))
            documents = list(yaml.safe_load_all(args.application.read_text()))
            documents[1]["spec"]["syncPolicy"]["automated"]["prune"] = True
            args.application.write_text(yaml.safe_dump_all(documents, explicit_start=True, sort_keys=True))
            with self.assertRaisesRegex(ValueError, "Application differs"):
                MODULE.assemble(args)


class ManagementCodePlaneRunnerContractTests(unittest.TestCase):
    def test_runner_has_resume_lock_and_fail_closed_chain(self) -> None:
        script = (ROOT / "run-management-code-plane.sh").read_text()
        self.assertIn("flock -n 9", script)
        self.assertIn("ACTOR_CODE_PLANE_RESUME=true", script)
        self.assertIn("check-management-git.sh", script)
        self.assertIn("--verify-receipt", script)
        self.assertLess(script.index("check-management-git.sh"), script.index("code_plane_dir/install.sh"))

    def test_bootstrap_installer_reconstructs_before_resume(self) -> None:
        installer = (ROOT.parents[2] / "code-plane/install.sh").read_text()
        self.assertIn("ACTOR_CODE_PLANE_RESUME", installer)
        self.assertIn("resumed render receipt differs from current authorities", installer)
        self.assertLess(installer.index("reconstructed-render.json"), installer.index("management_id=$(jq"))


if __name__ == "__main__":
    unittest.main()
