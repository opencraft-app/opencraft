#!/usr/bin/env python3
"""Verify that an accepted release receipt was produced by one exact Argo Hook."""

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path


RUN_ID = re.compile(r"^[0-9a-f]{32}$")
GIT_REVISION = re.compile(r"^[0-9a-f]{40}$")
SCHEMA = "actor-argocd-release-provenance/v1"


def load(path):
    raw = Path(path).read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def meta(document):
    value = document.get("metadata")
    require(isinstance(value, dict), "Kubernetes object has no metadata")
    return value


def verify(args):
    compact, compact_sha = load(args.compact_receipt)
    application, application_sha = load(args.application)
    job, job_sha = load(args.job)
    pod, pod_sha = load(args.pod)

    require(compact.get("schema") == "actor-approved-release-command-result/v1",
            "compact receipt schema mismatch")
    run_id = compact.get("releaseRunID")
    phase = compact.get("phase")
    require(RUN_ID.fullmatch(str(run_id or "")) is not None, "release run ID is invalid")
    require(phase in ("upgrade", "rollback"), "release phase is invalid")
    require(compact.get("commandExitCode") == 0, "release command did not succeed")
    full = compact.get("fullReceipt", {})
    require(full.get("present") is True and full.get("verdict") == "passed",
            "full release receipt was not accepted")

    provenance = compact.get("orchestration", {})
    require(provenance.get("kind") == "argocd", "compact receipt is not Argo-originated")
    application_meta = meta(application)
    require(application.get("kind") == "Application", "application snapshot is not an Application")
    require(application_meta.get("name") == provenance.get("application"),
            "Application name does not match compact receipt")
    require(application_meta.get("namespace") == provenance.get("applicationNamespace"),
            "Application namespace does not match compact receipt")

    pod_identity = provenance.get("pod", {})
    job_meta = meta(job)
    pod_meta = meta(pod)
    require(job.get("kind") == "Job", "Hook snapshot is not a Job")
    require(job_meta.get("name") == provenance.get("hookJob"), "Hook Job name mismatch")
    require(job_meta.get("namespace") == pod_identity.get("namespace"), "Hook Job namespace mismatch")
    require(pod_meta.get("name") == pod_identity.get("name"), "Hook Pod name mismatch")
    require(pod_meta.get("namespace") == pod_identity.get("namespace"), "Hook Pod namespace mismatch")
    require(pod_meta.get("uid") == pod_identity.get("uid"), "Hook Pod UID mismatch")

    annotations = job_meta.get("annotations", {})
    expected_hook = "Sync" if phase == "upgrade" else "SyncFail"
    require(provenance.get("hookPhase") == expected_hook, "compact Hook phase mismatch")
    require(annotations.get("argocd.argoproj.io/hook") == expected_hook,
            "Job is not the expected Argo Hook phase")
    require(annotations.get("fleet.actor.dev/release-run-id") == run_id,
            "Job run ID does not match compact receipt")
    require(annotations.get("fleet.actor.dev/release-attempt") == provenance.get("releaseAttempt"),
            "Job release attempt mismatch")
    tracking = annotations.get("argocd.argoproj.io/tracking-id")
    instance = job_meta.get("labels", {}).get("argocd.argoproj.io/instance")
    require(
        (isinstance(tracking, str) and tracking.startswith(provenance["application"] + ":"))
        or instance == provenance["application"],
        "Job has no matching Argo Application tracking identity",
    )

    job_uid = job_meta.get("uid")
    owners = pod_meta.get("ownerReferences", [])
    require(any(owner.get("kind") == "Job" and owner.get("name") == job_meta.get("name")
                and owner.get("uid") == job_uid and owner.get("controller") is True
                for owner in owners), "Hook Pod is not owned by the exact Job UID")
    require(job.get("status", {}).get("succeeded", 0) == 1, "Hook Job did not succeed exactly once")
    require(job.get("status", {}).get("failed", 0) in (None, 0), "Hook Job recorded a failure")
    require(pod.get("status", {}).get("phase") == "Succeeded", "Hook Pod did not succeed")

    spec = application.get("spec", {})
    require(spec.get("project") == "actor-runtime-release", "Application project mismatch")
    require(spec.get("destination", {}).get("namespace") == pod_identity.get("namespace"),
            "Application destination does not own the Hook namespace")
    operation = application.get("status", {}).get("operationState", {})
    expected_operation_phases = {"Succeeded"} if phase == "upgrade" else {"Failed", "Error"}
    require(operation.get("phase") in expected_operation_phases,
            "Application operation phase does not match release phase")
    sync_result = operation.get("syncResult", {})
    revision = sync_result.get("revision")
    require(GIT_REVISION.fullmatch(str(revision or "")) is not None,
            "Application operation has no immutable Git revision")
    resources = sync_result.get("resources", [])
    require(any(
        resource.get("kind") == "Job"
        and resource.get("namespace") == job_meta.get("namespace")
        and resource.get("name") == job_meta.get("name")
        and resource.get("hookType") == expected_hook
        and resource.get("hookPhase") == "Succeeded"
        for resource in resources
    ), "Application operation does not contain the successful exact Hook Job")
    history = application.get("status", {}).get("history", [])
    if phase == "upgrade":
        require(any(item.get("revision") == revision for item in history),
                "Application history does not retain the successful operation revision")

    return {
        "schema": SCHEMA,
        "verdict": "passed",
        "cell": compact.get("cell"),
        "releaseRunID": run_id,
        "phase": phase,
        "gitRevision": revision,
        "applicationOperationPhase": operation.get("phase"),
        "application": {
            "namespace": application_meta.get("namespace"),
            "name": application_meta.get("name"),
            "uid": application_meta.get("uid"),
        },
        "hookJob": {
            "namespace": job_meta.get("namespace"),
            "name": job_meta.get("name"),
            "uid": job_uid,
        },
        "hookPod": pod_identity,
        "fullReceipt": full,
        "inputSHA256": {
            "compactReceipt": compact_sha,
            "application": application_sha,
            "job": job_sha,
            "pod": pod_sha,
        },
    }


def write_atomic(path, document):
    output = Path(path)
    require(output.is_absolute() and str(output).startswith("/data/"),
            "output must be an absolute path below /data")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".argocd-provenance.", dir=output.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(document, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
        os.replace(temporary, output)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--compact-receipt", required=True)
    parser.add_argument("--application", required=True)
    parser.add_argument("--job", required=True)
    parser.add_argument("--pod", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args(argv)


def main(argv=None):
    try:
        args = parse_args(argv)
        document = verify(args)
        write_atomic(args.output, document)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print("Argo release provenance: {}".format(error), file=sys.stderr)
        return 1
    print("Argo release provenance passed: {}".format(args.output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
