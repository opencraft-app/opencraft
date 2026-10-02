import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("verify-expanded-fdb-recovery.py")
SPEC = importlib.util.spec_from_file_location("verify_expanded_fdb_recovery", MODULE_PATH)
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


def snapshot(processes, mode, minimum):
    return {
        "fdb": {"storageProcesses": processes, "generation": 2, "reconciledGeneration": 2,
                "available": True, "healthy": True, "fullReplication": True},
        "machineSet": {"specReplicas": processes, "readyReplicas": processes,
                       "availableReplicas": processes,
                       "scaling": {"createPolicy": "ZoneEquality", "minReplicas": minimum, "maxReplicas": 30}},
        "cellAutoscaling": {"mode": mode, "desiredProcessCount": processes, "observedProcessCount": processes},
        "capacity": {"evidenceReady": True, "dataMovementBytes": 0},
        "activeActors": 0,
    }


def operation(name, uid, source, target):
    return {
        "name": name, "uid": uid,
        "spec": {"fromProcessCount": source, "toProcessCount": target,
                 "nodeCapacityRef": {"provider": "TKENativeMachineSet", "machineSetName": "np-fdbpool0", "processesPerNode": 1}},
        "status": {"phase": "Succeeded", "receiptDigest": "sha256:" + "a" * 64},
    }


def valid():
    source = operation("up", "up-uid", 9, 12)
    down = operation("down", "down-uid", 12, 9)
    return {
        "schemaVersion": "actor-fdb-expanded-recovery-v2", "verdict": "passed",
        "profileRestored": True, "restoredProfileDigest": "sha256:" + "b" * 64,
        "sourceRevision": "c" * 40, "sourceManifestSHA256": "d" * 64,
        "sourceOperation": "up", "sourceOperationUID": "up-uid", "sourceOperationResource": source,
        "downOperation": "down", "downOperationUID": "down-uid", "downOperationResource": down,
        "initial": snapshot(12, "ObserveOnly", 12), "final": snapshot(9, "ObserveOnly", 9),
        "backup": {"uid": "backup", "readyAgentPodUIDs": ["a"]},
        "backupAfter": {"uid": "backup", "readyAgentPodUIDs": ["b"]},
        "retirements": [{"spec": {"scaleOperationRef": {"uid": "down-uid"}, "quarantineSeconds": 2592000, "gcMode": "ObserveOnly"},
                         "status": {"phase": "Quarantined", "cloudState": "Unattached"}} for _ in range(3)],
        "timeline": [{"capturedAt": "now"}],
    }


class RecoveryReceiptTests(unittest.TestCase):
    def test_exact_recovery_passes(self):
        self.assertEqual(verifier.verify(valid())["retirements"], 3)

    def test_wrong_operation_owner_fails(self):
        value = valid()
        value["downOperationResource"]["spec"]["nodeCapacityRef"]["machineSetName"] = "other"
        with self.assertRaises(AssertionError):
            verifier.verify(value)

    def test_missing_replication_or_backup_identity_fails(self):
        value = valid()
        value["final"]["fdb"]["fullReplication"] = False
        with self.assertRaises(AssertionError):
            verifier.verify(value)
        value = valid()
        value["backupAfter"]["uid"] = "replacement"
        with self.assertRaises(AssertionError):
            verifier.verify(value)


if __name__ == "__main__":
    unittest.main()
