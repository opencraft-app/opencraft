#!/usr/bin/env python3
"""Emit and persist the bounded result of an immutable release command."""

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path


PREFIX = "actor_release_command_result="
SCHEMA = "actor-approved-release-command-result/v1"
RUN_ID = re.compile(r"^[0-9a-f]{32}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
DNS = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
ATTEMPT = re.compile(r"^[a-z0-9](?:[-a-z0-9.]{0,61}[a-z0-9])?$")
KUBERNETES_UID = re.compile(r"^[0-9a-f](?:[0-9a-f-]{14,126}[0-9a-f])$")
REMOTE_RECEIPT = re.compile(
    r"^/data/actor-qualification/receipts/actor-bj-q01-user-transparent-"
    r"(upgrade|rollback)-([0-9a-f]{32})\.json$"
)
RECEIPT_SCHEMAS = {
    "upgrade": {
        "actor-bj-q01-user-transparent-upgrade/v2",
        "actor-bj-q01-user-transparent-upgrade/v3",
        "actor-bj-q01-user-transparent-upgrade/v4",
    },
    "rollback": {
        "actor-bj-q01-user-transparent-rollback/v1",
        "actor-bj-q01-user-transparent-rollback/v2",
        "actor-bj-q01-user-transparent-rollback/v3",
    },
}


def validate_identity(phase, run_id, receipt):
    if phase not in ("upgrade", "rollback"):
        raise ValueError("invalid release phase")
    if RUN_ID.fullmatch(run_id) is None:
        raise ValueError("invalid release run ID")
    match = REMOTE_RECEIPT.fullmatch(receipt)
    if match is None or match.groups() != (phase, run_id):
        raise ValueError("remote receipt does not match release identity")


def emit(args):
    validate_identity(args.phase, args.run_id, args.receipt)
    path = Path(args.receipt)
    current_identity = None
    if path.is_file():
        stat = path.stat()
        current_identity = "{}:{}".format(stat.st_dev, stat.st_ino)
    fresh = current_identity is not None and current_identity != args.previous_file_identity
    result = {
        "schema": SCHEMA,
        "cell": "actor-bj-q01",
        "releaseRunID": args.run_id,
        "phase": args.phase,
        "commandExitCode": args.exit_code,
        "fullReceipt": {
            "location": "protected-builder",
            "path": args.receipt,
            "present": fresh,
        },
    }
    if fresh:
        raw = path.read_bytes()
        document = json.loads(raw)
        result["fullReceipt"].update({
            "sha256": hashlib.sha256(raw).hexdigest(),
            "sizeBytes": len(raw),
            "schema": document.get("schema"),
            "verdict": document.get("verdict"),
        })
    print(PREFIX + json.dumps(result, sort_keys=True, separators=(",", ":")))


def extract(args):
    validate_identity(args.phase, args.run_id, args.receipt)
    lines = Path(args.input).read_text(errors="replace").splitlines()
    candidates = [line[len(PREFIX):] for line in lines if line.startswith(PREFIX)]
    if len(candidates) != 1:
        raise ValueError("approved command emitted no unique compact result")
    result = json.loads(candidates[0])
    expected = {
        "schema": SCHEMA,
        "cell": "actor-bj-q01",
        "releaseRunID": args.run_id,
        "phase": args.phase,
    }
    for key, value in expected.items():
        if result.get(key) != value:
            raise ValueError("compact result identity mismatch: " + key)
    full = result.get("fullReceipt")
    if not isinstance(full, dict) or full.get("path") != args.receipt:
        raise ValueError("compact result receipt path mismatch")
    if full.get("location") != "protected-builder" or full.get("present") is not True:
        raise ValueError("protected builder did not persist the full receipt")
    if SHA256.fullmatch(str(full.get("sha256", ""))) is None:
        raise ValueError("compact result receipt digest is invalid")
    if not isinstance(full.get("sizeBytes"), int) or full["sizeBytes"] <= 0:
        raise ValueError("compact result receipt size is invalid")
    if full.get("schema") not in RECEIPT_SCHEMAS[args.phase]:
        raise ValueError("compact result full receipt schema mismatch")
    if full.get("verdict") not in ("passed", "failed"):
        raise ValueError("compact result full receipt verdict is not terminal")
    exit_code = result.get("commandExitCode")
    if not isinstance(exit_code, int) or exit_code < 0 or exit_code > 255:
        raise ValueError("compact result command exit code is invalid")
    if (args.tat_status == 0) != (exit_code == 0):
        raise ValueError("TAT status and remote command exit code disagree")

    provenance = [
        args.orchestrator, args.application, args.application_namespace,
        args.hook_job, args.hook_phase,
        args.release_attempt, args.pod_namespace, args.pod_name, args.pod_uid,
    ]
    if any(value is not None for value in provenance):
        if not all(value is not None for value in provenance):
            raise ValueError("orchestration provenance must be complete")
        if args.orchestrator != "argocd":
            raise ValueError("unsupported release orchestrator")
        for value in (
            args.application, args.application_namespace, args.hook_job,
            args.pod_namespace, args.pod_name,
        ):
            if DNS.fullmatch(value) is None:
                raise ValueError("invalid Kubernetes provenance identity")
        if ATTEMPT.fullmatch(args.release_attempt) is None:
            raise ValueError("invalid release-attempt provenance")
        expected_hook_phase = "Sync" if args.phase == "upgrade" else "SyncFail"
        if args.hook_phase != expected_hook_phase:
            raise ValueError("Hook phase does not match release phase")
        if KUBERNETES_UID.fullmatch(args.pod_uid) is None:
            raise ValueError("invalid Hook Pod UID")
        result["orchestration"] = {
            "kind": args.orchestrator,
            "application": args.application,
            "applicationNamespace": args.application_namespace,
            "hookJob": args.hook_job,
            "hookPhase": args.hook_phase,
            "releaseAttempt": args.release_attempt,
            "pod": {
                "namespace": args.pod_namespace,
                "name": args.pod_name,
                "uid": args.pod_uid,
            },
        }

    output = Path(args.output)
    if not output.is_absolute() or not str(output).startswith("/data/"):
        raise ValueError("compact result output must be below /data")
    output.parent.mkdir(parents=False, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".approved-command-result.", dir=output.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(result, stream, sort_keys=True, separators=(",", ":"))
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
    subparsers = parser.add_subparsers(dest="command")
    emit_parser = subparsers.add_parser("emit")
    emit_parser.add_argument("--phase", required=True)
    emit_parser.add_argument("--run-id", required=True)
    emit_parser.add_argument("--receipt", required=True)
    emit_parser.add_argument("--exit-code", required=True, type=int)
    emit_parser.add_argument("--previous-file-identity", default="")
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--phase", required=True)
    extract_parser.add_argument("--run-id", required=True)
    extract_parser.add_argument("--receipt", required=True)
    extract_parser.add_argument("--tat-status", required=True, type=int)
    extract_parser.add_argument("--input", required=True)
    extract_parser.add_argument("--output", required=True)
    extract_parser.add_argument("--orchestrator")
    extract_parser.add_argument("--application")
    extract_parser.add_argument("--application-namespace")
    extract_parser.add_argument("--hook-job")
    extract_parser.add_argument("--hook-phase")
    extract_parser.add_argument("--release-attempt")
    extract_parser.add_argument("--pod-namespace")
    extract_parser.add_argument("--pod-name")
    extract_parser.add_argument("--pod-uid")
    args = parser.parse_args(argv)
    if args.command is None:
        parser.error("a command is required")
    return args


def main(argv=None):
    args = parse_args(argv)
    try:
        if args.command == "emit":
            emit(args)
        else:
            extract(args)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print("approved command result: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
