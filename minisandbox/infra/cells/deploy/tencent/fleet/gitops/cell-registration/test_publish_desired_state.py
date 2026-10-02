#!/usr/bin/env python3

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


PUBLISHER_SOURCE = (Path(__file__).parent / "publish-desired-state.py").read_text()


ROOT = Path(__file__).resolve().parent
CREATE_FIRST = ROOT.parents[1] / "terraform" / "create-first"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PUBLISH = load("publish_desired_state", ROOT / "publish-desired-state.py")
VERIFY = load("verify_desired_state_publication", ROOT / "verify-publication.py")
RENDER = load("render_cell_for_publication", CREATE_FIRST / "render-cell-assets.py")
FIXTURE = load("publication_fixture", ROOT / "local-registration-e2e.py")


class PublishDesiredStateTests(unittest.TestCase):
    def test_publisher_remains_python37_compatible(self):
        self.assertNotIn("unlink(missing_ok=", PUBLISHER_SOURCE)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.root = Path(self.temporary.name)
        inventory = RENDER.validate_inventory(
            FIXTURE.local_inventory("actor-bj-a01", "https://172.18.0.7:6443")
        )
        spec = RENDER.validate_spec(FIXTURE.local_cell_spec("actor-bj-a01", inventory), inventory)
        self.desired = self.root / "desired"
        RENDER.write_new_tree(
            self.desired,
            RENDER.render(inventory, spec, FIXTURE.local_image_inventory()),
        )
        self.inventory = self.root / "inventory.json"
        self.inventory.write_text(json.dumps(inventory, sort_keys=True) + "\n")
        self.remote = self.root / "remote.git"
        seed = self.root / "seed"
        subprocess.run(("git", "init", "--quiet", "--initial-branch=main", str(seed)), check=True)
        (seed / "README.md").write_text("# desired state\n")
        subprocess.run(("git", "-C", str(seed), "add", "README.md"), check=True)
        env = dict(os.environ, GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@invalid", GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@invalid")
        subprocess.run(("git", "-C", str(seed), "commit", "--quiet", "-m", "seed"), env=env, check=True)
        subprocess.run(("git", "clone", "--quiet", "--bare", str(seed), str(self.remote)), check=True)

    def tearDown(self):
        self.temporary.cleanup()

    def publish(self, receipt_name, **kwargs):
        return PUBLISH.publish(
            self.inventory,
            self.desired / "handoff-receipt.json",
            self.desired,
            self.remote.as_uri(),
            "main",
            self.root / receipt_name,
            allow_local_repository=True,
            **kwargs,
        )

    def test_publishes_exact_tree_and_is_restart_safe(self):
        first = self.publish("first.json")
        second = self.publish("second.json")
        self.assertEqual(first["gitRevision"], second["gitRevision"])
        self.assertEqual(first["handoffReceiptDigest"], second["handoffReceiptDigest"])
        clone = self.root / "readback"
        subprocess.run(("git", "clone", "--quiet", self.remote.as_uri(), str(clone)), check=True)
        self.assertEqual(PUBLISH.file_inventory(clone / "cells" / "actor-bj-a01"), first["files"])
        verified = VERIFY.verify(
            self.inventory,
            self.desired / "handoff-receipt.json",
            self.desired,
            self.root / "first.json",
            first["gitRevision"],
        )
        self.assertEqual(verified["publicationReceiptDigest"], PUBLISH.digest((self.root / "first.json").read_bytes()))

    def test_rejects_existing_cell_drift(self):
        self.publish("first.json")
        (self.desired / "cell.json").write_text("{}\n")
        with self.assertRaisesRegex(ValueError, "missing or changed"):
            self.publish("second.json")

    def test_updates_only_profile_binding_with_revision_cas(self):
        first = self.publish("first.json")
        inventory = json.loads(self.inventory.read_text())
        inventory["fleet"]["profileDigest"] = "sha256:" + "9" * 64
        spec = RENDER.validate_spec(FIXTURE.local_cell_spec("actor-bj-a01", inventory), inventory)
        updated = self.root / "updated"
        RENDER.write_new_tree(
            updated,
            RENDER.render(inventory, spec, FIXTURE.local_image_inventory()),
        )
        updated_inventory = self.root / "updated-inventory.json"
        updated_inventory.write_text(json.dumps(inventory, sort_keys=True) + "\n")
        result = PUBLISH.publish(
            updated_inventory,
            updated / "handoff-receipt.json",
            updated,
            self.remote.as_uri(),
            "main",
            self.root / "updated-receipt.json",
            allow_local_repository=True,
            allow_update=True,
            expected_revision=first["gitRevision"],
        )
        self.assertNotEqual(result["gitRevision"], first["gitRevision"])
        with self.assertRaisesRegex(ValueError, "moved since"):
            PUBLISH.publish(
                updated_inventory,
                updated / "handoff-receipt.json",
                updated,
                self.remote.as_uri(),
                "main",
                self.root / "stale-receipt.json",
                allow_local_repository=True,
                allow_update=True,
                expected_revision=first["gitRevision"],
            )

    def test_stateless_capacity_can_be_replaced_but_cluster_identity_cannot(self):
        original = json.loads(self.inventory.read_text())
        replacement = json.loads(self.inventory.read_text())
        replacement["kubernetes"]["statelessNodePoolId"] = "np-repair01"
        self.assertEqual(
            PUBLISH.stable_cell_identity(original),
            PUBLISH.stable_cell_identity(replacement),
        )
        replacement["kubernetes"]["clusterId"] = "cls-replaced"
        self.assertNotEqual(
            PUBLISH.stable_cell_identity(original),
            PUBLISH.stable_cell_identity(replacement),
        )

    def test_repairs_legacy_engine_local_datacenter_with_revision_cas(self):
        first = self.publish("first.json")
        clone = self.root / "legacy-clone"
        subprocess.run(("git", "clone", "--quiet", self.remote.as_uri(), str(clone)), check=True)
        legacy_inventory_path = clone / "cells" / "actor-bj-a01" / "inventory.json"
        legacy_inventory = json.loads(legacy_inventory_path.read_text())
        legacy_inventory["fleet"]["datacenterName"] = "actor-bj-a01"
        legacy_inventory_path.write_text(json.dumps(legacy_inventory, indent=2, sort_keys=True) + "\n")
        subprocess.run(("git", "-C", str(clone), "add", "."), check=True)
        env = dict(os.environ, GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@invalid", GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@invalid")
        subprocess.run(("git", "-C", str(clone), "commit", "--quiet", "-m", "seed legacy routing drift"), env=env, check=True)
        subprocess.run(("git", "-C", str(clone), "push", "--quiet", "origin", "HEAD:main"), check=True)
        legacy_revision = subprocess.check_output(("git", "-C", str(clone), "rev-parse", "HEAD"), text=True).strip()

        result = self.publish(
            "repaired.json", allow_update=True, expected_revision=legacy_revision,
        )
        self.assertNotEqual(result["gitRevision"], legacy_revision)
        self.assertEqual(json.loads(self.inventory.read_text())["fleet"]["datacenterName"], "default")

    def test_rejects_embedded_credentials(self):
        self.assertEqual(
            PUBLISH.validate_repository_url("ssh://git@example.invalid/fleet.git"),
            "ssh://git@example.invalid/fleet.git",
        )
        with self.assertRaisesRegex(ValueError, "embed credentials"):
            PUBLISH.validate_repository_url("https://user:secret@example.invalid/fleet.git")

    def test_accepts_only_reviewed_plain_http_boundaries(self):
        internal = "http://actor-git.actor-git-system.svc.cluster.local:3000/owner/repo.git"
        self.assertEqual(PUBLISH.validate_repository_url(internal), internal)
        loopback = "http://127.0.0.1:30090/owner/repo.git"
        self.assertEqual(PUBLISH.validate_repository_url(loopback, allow_local=True), loopback)
        with self.assertRaisesRegex(ValueError, "credential-free"):
            PUBLISH.validate_repository_url(loopback)
        with self.assertRaisesRegex(ValueError, "credential-free"):
            PUBLISH.validate_repository_url("http://git.example.invalid/owner/repo.git", allow_local=True)

    def test_rejects_unverified_extra_file(self):
        (self.desired / "manual.yaml").write_text("manual: true\n")
        with self.assertRaisesRegex(ValueError, "outside the verified handoff"):
            self.publish("receipt.json")

    def test_verifier_rejects_revision_substitution(self):
        self.publish("receipt.json")
        with self.assertRaisesRegex(ValueError, "differs from registration"):
            VERIFY.verify(
                self.inventory,
                self.desired / "handoff-receipt.json",
                self.desired,
                self.root / "receipt.json",
                "f" * 40,
            )


if __name__ == "__main__":
    unittest.main()
