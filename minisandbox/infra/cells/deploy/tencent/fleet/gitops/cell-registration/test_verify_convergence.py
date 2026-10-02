#!/usr/bin/env python3

import base64
import copy
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("verify_cell_convergence", ROOT / "verify-convergence.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


CELL = "actor-bj-k02"
REVISION = "a" * 40
DIGEST = "sha256:" + "b" * 64
PROFILE = "sha256:" + "c" * 64
IMAGE_INVENTORY = "sha256:" + "f" * 64
PUBLICATION = "sha256:" + "9" * 64
PLATFORM = "sha256:" + "8" * 64
CLUSTER_UID = "cluster-uid"
SERVER = "https://10.3.0.10"


def fixtures():
    handoff = {
        "cellId": CELL,
        "clusterId": "cls-test0001",
        "statelessNodePoolId": "np-test0001",
        "machineSets": list(MODULE.LOCAL_E2E_MACHINE_SETS),
        "terraformInventoryDigest": DIGEST,
        "handoffReceiptDigest": "sha256:" + "d" * 64,
        "imageInventoryDigest": IMAGE_INVENTORY,
        "profileDigest": PROFILE,
        "fleetBinding": {
            "poolName": "pool-a", "poolUid": "pool-uid", "claimName": "claim-a",
            "claimUid": "claim-uid", "className": "class-a", "scaleOutEpoch": 1,
            "datacenterName": "default",
            "profileDigest": PROFILE,
        },
    }
    registration = {
        "schemaVersion": 3, "registrationScope": "production", "cellId": CELL, "clusterId": "cls-test0001", "server": SERVER,
        "terraformInventoryDigest": DIGEST, "handoffReceiptDigest": handoff["handoffReceiptDigest"],
        "publicationReceiptDigest": PUBLICATION,
        "imageInventoryDigest": IMAGE_INVENTORY,
        "platformReceiptDigest": PLATFORM, "platformClusterUid": CLUSTER_UID,
        "gitRevision": REVISION,
        "publicationRepository": {"url": "ssh://git@example.invalid/fleet.git", "branch": "main", "path": "cells/" + CELL},
        "argoClusterSecret": {"name": "actor-cell-" + CELL, "uid": "secret-uid", "resourceVersion": "7"},
        "permissions": {
            "machineSetDelete": False, "rivetCellDelete": False, "secretRead": False,
            "fdbWorkloadCreate": False, "statelessSecretRead": False,
            "statelessWorkloadDelete": False,
        },
    }
    secret = {
        "type": "Opaque",
        "metadata": {
            "name": "actor-cell-" + CELL, "uid": "secret-uid",
            "labels": {
                "argocd.argoproj.io/secret-type": "cluster",
                "fleet.actor.dev/managed-cell": "true",
                "fleet.actor.dev/desired-state": "published",
                "fleet.actor.dev/registration-scope": "production",
                "fleet.actor.dev/cell-id": CELL,
            },
            "annotations": {
                "fleet.actor.dev/cluster-id": "cls-test0001",
                "fleet.actor.dev/git-revision": REVISION,
                "fleet.actor.dev/inventory-digest": DIGEST,
                "fleet.actor.dev/handoff-receipt-digest": handoff["handoffReceiptDigest"],
                "fleet.actor.dev/publication-receipt-digest": PUBLICATION,
                "fleet.actor.dev/image-inventory-digest": IMAGE_INVENTORY,
                "fleet.actor.dev/platform-receipt-digest": PLATFORM,
                "fleet.actor.dev/cluster-uid": CLUSTER_UID,
            },
        },
        "data": {
            "server": base64.b64encode(SERVER.encode()).decode(),
            "namespaces": base64.b64encode(b"actor-fdb-cell-system,actor-stateless-system").decode(),
            "clusterResources": base64.b64encode(b"true").decode(),
        },
    }
    application = {
        "metadata": {
            "name": "actor-cell-" + CELL, "uid": "app-uid",
            "ownerReferences": [{
                "apiVersion": "argoproj.io/v1alpha1", "kind": "ApplicationSet",
                "name": "actor-cells", "uid": "appset-uid", "controller": True,
                "blockOwnerDeletion": True,
            }],
            "annotations": {
                "fleet.actor.dev/inventory-digest": DIGEST,
                "fleet.actor.dev/handoff-receipt-digest": handoff["handoffReceiptDigest"],
                "fleet.actor.dev/publication-receipt-digest": PUBLICATION,
                "fleet.actor.dev/image-inventory-digest": IMAGE_INVENTORY,
                "fleet.actor.dev/platform-receipt-digest": PLATFORM,
                "fleet.actor.dev/cluster-uid": CLUSTER_UID,
            },
        },
        "spec": {
            "project": "actor-cell-bootstrap",
            "source": {"repoURL": "ssh://git@example.invalid/fleet.git", "targetRevision": REVISION, "path": "cells/" + CELL},
            "destination": {"server": SERVER},
        },
        "status": {"sync": {"status": "Synced", "revision": REVISION}, "health": {"status": "Healthy"}},
    }
    cell = {
        "metadata": {"name": CELL, "uid": "cell-uid", "generation": 1,
                     "annotations": {
                         "fleet.actor.dev/profile-digest": PROFILE,
                         "fleet.actor.dev/image-inventory-digest": IMAGE_INVENTORY,
                         "fleet.actor.dev/stateless-node-pool-id": "np-test0001",
                     }},
        "spec": {"cellId": CELL},
    }
    machines = [{
        "metadata": {"name": name, "uid": name + "-uid"},
        "spec": {"template": {"spec": {"metadata": {"labels": {"fleet.actor.dev/cell": CELL}}}}},
    } for name in (*MODULE.LOCAL_E2E_MACHINE_SETS, handoff["statelessNodePoolId"])]
    application_set = {
        "metadata": {"name": "actor-cells", "namespace": "argocd", "uid": "appset-uid"},
        "spec": {
            "generators": [{"clusters": {"selector": {"matchLabels": {
                "fleet.actor.dev/managed-cell": "true",
                "fleet.actor.dev/desired-state": "published",
                "fleet.actor.dev/registration-scope": "production",
            }}}}],
            "template": {"spec": {
                "project": "actor-cell-bootstrap",
                "source": {
                    "repoURL": "ssh://git@example.invalid/fleet.git",
                    "targetRevision": '{{index .metadata.annotations "fleet.actor.dev/git-revision"}}',
                    "path": 'cells/{{index .metadata.labels "fleet.actor.dev/cell-id"}}',
                },
            }},
        },
    }
    return registration, handoff, secret, application, cell, machines, application_set


class ConvergenceTests(unittest.TestCase):
    def test_stateless_capacity_is_part_of_the_cell_identity_chain(self):
        self.assertEqual(
            MODULE.LOCAL_E2E_MACHINE_SETS,
            ("np-control0", "np-fdbpool0", "np-runtime0"),
        )

    def test_exact_live_identity_passes(self):
        result = MODULE.verify(*fixtures()[:1], "sha256:" + "e" * 64, *fixtures()[1:])
        self.assertEqual(result["cell"]["uid"], "cell-uid")
        self.assertEqual(result["fleetBinding"]["claimUid"], "claim-uid")
        self.assertEqual(
            set(result["machineSets"]),
            set(MODULE.LOCAL_E2E_MACHINE_SETS) | {"np-test0001"},
        )

    def test_replaced_cluster_secret_is_rejected(self):
        values = list(fixtures())
        values[2] = copy.deepcopy(values[2])
        values[2]["metadata"]["uid"] = "replacement-uid"
        with self.assertRaisesRegex(ValueError, "Secret identity"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_wrong_registration_scope_is_rejected(self):
        values = list(fixtures())
        values[0] = copy.deepcopy(values[0])
        values[0]["registrationScope"] = "applicationset-e2e"
        with self.assertRaisesRegex(ValueError, "registration scope"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_secret_scope_mismatch_is_rejected(self):
        values = list(fixtures())
        values[2] = copy.deepcopy(values[2])
        values[2]["metadata"]["labels"]["fleet.actor.dev/registration-scope"] = "registration-e2e"
        with self.assertRaisesRegex(ValueError, "not an admitted"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_manual_application_without_appset_owner_is_rejected(self):
        values = list(fixtures())
        values[3] = copy.deepcopy(values[3])
        values[3]["metadata"]["ownerReferences"] = []
        with self.assertRaisesRegex(ValueError, "not owned"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_replaced_appset_uid_is_rejected(self):
        values = list(fixtures())
        values[6] = copy.deepcopy(values[6])
        values[6]["metadata"]["uid"] = "replacement-appset-uid"
        with self.assertRaisesRegex(ValueError, "not owned"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_wrong_sync_revision_is_rejected(self):
        values = list(fixtures())
        values[3] = copy.deepcopy(values[3])
        values[3]["status"]["sync"]["revision"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "exact immutable revision"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_application_cannot_drop_platform_binding(self):
        values = list(fixtures())
        values[3] = copy.deepcopy(values[3])
        del values[3]["metadata"]["annotations"]["fleet.actor.dev/platform-receipt-digest"]
        with self.assertRaisesRegex(ValueError, "platform receipt digest"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_another_repository_is_rejected(self):
        values = list(fixtures())
        values[3] = copy.deepcopy(values[3])
        values[3]["spec"]["source"]["repoURL"] = "ssh://git@other.invalid/fleet.git"
        with self.assertRaisesRegex(ValueError, "repository differs"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_machine_set_from_another_cell_is_rejected(self):
        values = list(fixtures())
        values[5] = copy.deepcopy(values[5])
        values[5][0]["spec"]["template"]["spec"]["metadata"]["labels"]["fleet.actor.dev/cell"] = "actor-bj-k03"
        with self.assertRaisesRegex(ValueError, "not owned"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_unreviewed_extra_machine_set_is_rejected(self):
        values = list(fixtures())
        values[5] = copy.deepcopy(values[5])
        values[5].append({
            "metadata": {"name": "np-leftover", "uid": "leftover-uid"},
            "spec": {"template": {"spec": {"metadata": {"labels": {"fleet.actor.dev/cell": CELL}}}}},
        })
        with self.assertRaisesRegex(ValueError, "unknown or duplicated"):
            MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])

    def test_replaced_cell_uid_is_observable(self):
        values = list(fixtures())
        values[4] = copy.deepcopy(values[4])
        values[4]["metadata"]["uid"] = "replacement-cell-uid"
        result = MODULE.verify(values[0], "sha256:" + "e" * 64, *values[1:])
        self.assertEqual(result["cell"]["uid"], "replacement-cell-uid")


if __name__ == "__main__":
    unittest.main()
