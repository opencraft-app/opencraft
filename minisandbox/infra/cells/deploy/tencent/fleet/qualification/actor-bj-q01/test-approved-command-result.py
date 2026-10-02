#!/usr/bin/env python3

import hashlib
import json
import pathlib
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parent
TOOL = ROOT / "approved-command-result.py"
RUN = "a" * 32


def invoke(*args, check=True):
    return subprocess.run([str(TOOL), *args], check=check,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True)


def unlink_if_present(path):
    try:
        path.unlink()
    except FileNotFoundError:
        pass


with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary_name:
    temporary = pathlib.Path(temporary_name)
    remote = pathlib.Path(
        "/data/actor-qualification/receipts/"
        "actor-bj-q01-user-transparent-upgrade-{}.json".format(RUN)
    )
    remote.parent.mkdir(parents=True, exist_ok=True)
    prior = remote.read_bytes() if remote.exists() else None
    try:
        receipt = {
            "schema": "actor-bj-q01-user-transparent-upgrade/v3",
            "verdict": "failed",
        }
        remote.write_text(json.dumps(receipt) + "\n")
        emitted = invoke(
            "emit", "--phase", "upgrade", "--run-id", RUN,
            "--receipt", str(remote), "--exit-code", "1",
        ).stdout
        log = temporary / "command.log"
        log.write_text("untrusted output\n" + emitted)
        compact = pathlib.Path("/data/tmp/approved-command-result-{}.json".format(RUN))
        unlink_if_present(compact)
        invoke(
            "extract", "--phase", "upgrade", "--run-id", RUN,
            "--receipt", str(remote), "--tat-status", "1",
            "--input", str(log), "--output", str(compact),
            "--orchestrator", "argocd",
            "--application", "actor-runtime-release-q01",
            "--application-namespace", "argocd",
            "--hook-job", "actor-runtime-release",
            "--hook-phase", "Sync",
            "--release-attempt", "initial",
            "--pod-namespace", "actor-release-system",
            "--pod-name", "actor-runtime-release-abcde",
            "--pod-uid", "12345678-1234-1234-1234-123456789abc",
        )
        document = json.loads(compact.read_text())
        assert document["fullReceipt"]["sha256"] == hashlib.sha256(remote.read_bytes()).hexdigest()
        assert document["fullReceipt"]["verdict"] == "failed"
        assert document["orchestration"] == {
            "kind": "argocd",
            "application": "actor-runtime-release-q01",
            "applicationNamespace": "argocd",
            "hookJob": "actor-runtime-release",
            "hookPhase": "Sync",
            "releaseAttempt": "initial",
            "pod": {
                "namespace": "actor-release-system",
                "name": "actor-runtime-release-abcde",
                "uid": "12345678-1234-1234-1234-123456789abc",
            },
        }
        compact.unlink()

        stat = remote.stat()
        stale_identity = "{}:{}".format(stat.st_dev, stat.st_ino)
        stale = invoke(
            "emit", "--phase", "upgrade", "--run-id", RUN,
            "--receipt", str(remote), "--exit-code", "1",
            "--previous-file-identity", stale_identity,
        ).stdout
        log.write_text(stale)
        failed = invoke(
            "extract", "--phase", "upgrade", "--run-id", RUN,
            "--receipt", str(remote), "--tat-status", "1",
            "--input", str(log), "--output", str(compact), check=False,
        )
        assert failed.returncode != 0
        assert not compact.exists()
    finally:
        if prior is None:
            unlink_if_present(remote)
        else:
            remote.write_bytes(prior)

print("approved command compact result tests passed")
