#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def healthy(snapshot, processes, nodes):
    fdb = snapshot["fdb"]
    machine = snapshot["machineSet"]
    assert fdb["storageProcesses"] == processes
    assert fdb["generation"] == fdb["reconciledGeneration"]
    assert fdb["available"] and fdb["healthy"] and fdb["fullReplication"]
    assert machine["specReplicas"] == machine["readyReplicas"] == machine["availableReplicas"] == nodes


def verify(document):
    assert document["schemaVersion"] == "actor-fdb-expanded-recovery-v2"
    assert document["verdict"] == "passed" and document["profileRestored"] is True
    assert re.fullmatch(r"[0-9a-f]{40}", document["sourceRevision"])
    assert re.fullmatch(r"[0-9a-f]{64}", document["sourceManifestSHA256"])
    assert DIGEST.fullmatch(document["restoredProfileDigest"])
    source = document["sourceOperationResource"]
    down = document["downOperationResource"]
    assert source["name"] == document["sourceOperation"] and source["uid"] == document["sourceOperationUID"]
    assert down["name"] == document["downOperation"] and down["uid"] == document["downOperationUID"]
    assert source["status"]["phase"] == down["status"]["phase"] == "Succeeded"
    assert (source["spec"]["fromProcessCount"], source["spec"]["toProcessCount"]) == (9, 12)
    assert (down["spec"]["fromProcessCount"], down["spec"]["toProcessCount"]) == (12, 9)
    for item in (source, down):
        assert item["spec"]["nodeCapacityRef"] == {
            "provider": "TKENativeMachineSet", "machineSetName": "np-fdbpool0", "processesPerNode": 1,
        }
        assert DIGEST.fullmatch(item["status"]["receiptDigest"])
    healthy(document["initial"], 12, 12)
    assert document["initial"]["activeActors"] == 0
    assert document["initial"]["capacity"] == {"evidenceReady": True, "dataMovementBytes": 0}
    assert document["initial"]["machineSet"]["scaling"] == {
        "createPolicy": "ZoneEquality", "minReplicas": 12, "maxReplicas": 30,
    }
    healthy(document["final"], 9, 9)
    assert document["final"]["machineSet"]["scaling"] == {
        "createPolicy": "ZoneEquality", "minReplicas": 9, "maxReplicas": 30,
    }
    assert document["final"]["cellAutoscaling"]["mode"] == "ObserveOnly"
    assert document["final"]["cellAutoscaling"]["desiredProcessCount"] == 9
    assert document["final"]["cellAutoscaling"]["observedProcessCount"] == 9
    assert document["final"]["capacity"] == {"evidenceReady": True, "dataMovementBytes": 0}
    assert document["backup"]["uid"] == document["backupAfter"]["uid"]
    assert document["backup"]["readyAgentPodUIDs"] and document["backupAfter"]["readyAgentPodUIDs"]
    retirements = document["retirements"]
    assert len(retirements) == 3
    for retirement in retirements:
        assert retirement["spec"]["scaleOperationRef"]["uid"] == down["uid"]
        assert retirement["spec"]["quarantineSeconds"] == 2592000
        assert retirement["spec"]["gcMode"] == "ObserveOnly"
        assert retirement["status"]["phase"] == "Quarantined"
        assert retirement["status"]["cloudState"] == "Unattached"
    assert document["timeline"]
    return {"sourceOperation": source["name"], "downOperation": down["name"], "retirements": 3}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    result = verify(json.loads(args.receipt.read_text()))
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
