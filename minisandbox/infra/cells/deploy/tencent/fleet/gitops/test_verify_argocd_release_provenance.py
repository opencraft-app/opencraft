#!/usr/bin/env python3

import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest


PATH = pathlib.Path(__file__).with_name("verify_argocd_release_provenance.py")
SPEC = importlib.util.spec_from_file_location("verify_argocd_release_provenance", str(PATH))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
RUN = "a" * 32
REVISION = "b" * 40
JOB_UID = "12345678-1234-1234-1234-123456789abc"
POD_UID = "abcdef12-1234-1234-1234-123456789abc"


def fixture():
    compact = {
        "schema": "actor-approved-release-command-result/v1",
        "cell": "actor-bj-q01",
        "releaseRunID": RUN,
        "phase": "upgrade",
        "commandExitCode": 0,
        "fullReceipt": {
            "location": "protected-builder", "path": "/data/receipt.json",
            "present": True, "sha256": "c" * 64, "sizeBytes": 10,
            "schema": "actor-bj-q01-user-transparent-upgrade/v2", "verdict": "passed",
        },
        "orchestration": {
            "kind": "argocd", "application": "actor-runtime-release-q01",
            "applicationNamespace": "argocd", "hookJob": "actor-runtime-release",
            "hookPhase": "Sync", "releaseAttempt": "initial",
            "pod": {
                "namespace": "actor-release-system", "name": "actor-runtime-release-abcde",
                "uid": POD_UID,
            },
        },
    }
    resource = {
        "kind": "Job", "namespace": "actor-release-system",
        "name": "actor-runtime-release", "hookType": "Sync", "hookPhase": "Succeeded",
    }
    application = {
        "apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
        "metadata": {"namespace": "argocd", "name": "actor-runtime-release-q01", "uid": "app-uid"},
        "spec": {
            "project": "actor-runtime-release",
            "destination": {"namespace": "actor-release-system"},
        },
        "status": {
            "operationState": {"phase": "Succeeded", "syncResult": {
                "revision": REVISION, "resources": [resource],
            }},
            "history": [{"revision": REVISION}],
        },
    }
    job = {
        "apiVersion": "batch/v1", "kind": "Job",
        "metadata": {
            "namespace": "actor-release-system", "name": "actor-runtime-release", "uid": JOB_UID,
            "annotations": {
                "argocd.argoproj.io/hook": "Sync",
                "argocd.argoproj.io/tracking-id": "actor-runtime-release-q01:batch/Job:actor-release-system/actor-runtime-release",
                "fleet.actor.dev/release-run-id": RUN,
                "fleet.actor.dev/release-attempt": "initial",
            },
        },
        "status": {"succeeded": 1},
    }
    pod = {
        "apiVersion": "v1", "kind": "Pod",
        "metadata": {
            "namespace": "actor-release-system", "name": "actor-runtime-release-abcde",
            "uid": POD_UID,
            "ownerReferences": [{
                "kind": "Job", "name": "actor-runtime-release", "uid": JOB_UID,
                "controller": True,
            }],
        },
        "status": {"phase": "Succeeded"},
    }
    return compact, application, job, pod


class ProvenanceTests(unittest.TestCase):
    def run_verify(self, documents):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            paths = []
            for index, document in enumerate(documents):
                path = pathlib.Path(temporary) / "{}.json".format(index)
                path.write_text(json.dumps(document))
                paths.append(str(path))
            args = MODULE.parse_args([
                "--compact-receipt", paths[0], "--application", paths[1],
                "--job", paths[2], "--pod", paths[3],
                "--output", str(pathlib.Path(temporary) / "result.json"),
            ])
            return MODULE.verify(args)

    def test_exact_chain_passes(self):
        result = self.run_verify(fixture())
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["gitRevision"], REVISION)
        self.assertEqual(result["hookPod"]["uid"], POD_UID)

    def test_replaced_pod_cannot_inherit_receipt(self):
        documents = list(fixture())
        documents[3] = copy.deepcopy(documents[3])
        documents[3]["metadata"]["uid"] = "dddddddd-1234-1234-1234-123456789abc"
        with self.assertRaisesRegex(ValueError, "Pod UID mismatch"):
            self.run_verify(documents)

    def test_manual_job_without_argo_tracking_fails(self):
        documents = list(fixture())
        documents[2] = copy.deepcopy(documents[2])
        del documents[2]["metadata"]["annotations"]["argocd.argoproj.io/tracking-id"]
        with self.assertRaisesRegex(ValueError, "tracking identity"):
            self.run_verify(documents)

    def test_application_without_exact_hook_result_fails(self):
        documents = list(fixture())
        documents[1] = copy.deepcopy(documents[1])
        documents[1]["status"]["operationState"]["syncResult"]["resources"][0]["name"] = "other"
        with self.assertRaisesRegex(ValueError, "successful exact Hook Job"):
            self.run_verify(documents)

    def test_syncfail_rollback_is_bound_to_failed_candidate_operation(self):
        compact, application, job, pod = fixture()
        compact["phase"] = "rollback"
        compact["fullReceipt"]["schema"] = "actor-bj-q01-user-transparent-rollback/v1"
        compact["orchestration"]["hookJob"] = "actor-runtime-release-rollback"
        compact["orchestration"]["hookPhase"] = "SyncFail"
        application["status"]["operationState"]["phase"] = "Failed"
        application["status"]["history"] = []
        resource = application["status"]["operationState"]["syncResult"]["resources"][0]
        resource.update({"name": "actor-runtime-release-rollback", "hookType": "SyncFail"})
        job["metadata"]["name"] = "actor-runtime-release-rollback"
        job["metadata"]["annotations"]["argocd.argoproj.io/hook"] = "SyncFail"
        job["metadata"]["annotations"]["argocd.argoproj.io/tracking-id"] = (
            "actor-runtime-release-q01:batch/Job:actor-release-system/actor-runtime-release-rollback"
        )
        pod["metadata"]["ownerReferences"][0]["name"] = "actor-runtime-release-rollback"
        result = self.run_verify((compact, application, job, pod))
        self.assertEqual(result["phase"], "rollback")
        self.assertEqual(result["applicationOperationPhase"], "Failed")


if __name__ == "__main__":
    unittest.main()
