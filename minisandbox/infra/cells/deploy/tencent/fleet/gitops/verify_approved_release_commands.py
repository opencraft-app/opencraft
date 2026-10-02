#!/usr/bin/env python3
"""Verify that an Argo Hook may invoke one exact approved TAT command."""

import argparse
import json
import re
from pathlib import Path


SHA = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
IMAGE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
COMMAND = re.compile(r"^cmd-[a-z0-9]{8}$")
RUN_ID = re.compile(r"^[0-9a-f]{32}$")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")


def _release(image, revision, manifest):
    return {
        "image": image,
        "sourceRevision": revision,
        "sourceManifestSHA256": manifest,
    }


def verify(payload, *, phase, command_id, run_id, runtime, reporter):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    require(payload.get("schema") == "actor-approved-release-commands/v2", "schema mismatch")
    require(payload.get("verdict") == "passed", "approval verdict is not passed")
    require(payload.get("cell") == "actor-bj-q01", "approval belongs to another Cell")
    require(payload.get("runID") == run_id and RUN_ID.fullmatch(run_id), "run ID mismatch")
    require(payload.get("parameterized") is False, "approved command is parameterized")
    require(payload.get("approvalTag") == "actor-release-approved=true", "approval tag mismatch")
    require(SHA.fullmatch(str(payload.get("imageInventorySHA256", ""))), "inventory digest is invalid")
    require(BUCKET.fullmatch(str(payload.get("coldBucket", ""))), "cold bucket is invalid")

    control = payload.get("control", {})
    require(REVISION.fullmatch(str(control.get("sourceRevision", ""))), "control revision is invalid")
    require(SHA.fullmatch(str(control.get("sourceManifestSHA256", ""))), "control manifest is invalid")

    for name in ("upgrade", "rollback"):
        command = payload.get(name, {})
        require(COMMAND.fullmatch(str(command.get("commandID", ""))), f"{name} command ID is invalid")
        require(SHA.fullmatch(str(command.get("contentSHA256", ""))), f"{name} command digest is invalid")

    for name in ("candidate", "previous"):
        release = payload.get(name, {})
        for component in ("runtime", "reporter"):
            identity = release.get(component, {})
            require(IMAGE.fullmatch(str(identity.get("image", ""))), f"{name} {component} image is invalid")
            require(REVISION.fullmatch(str(identity.get("sourceRevision", ""))), f"{name} {component} revision is invalid")
            require(SHA.fullmatch(str(identity.get("sourceManifestSHA256", ""))), f"{name} {component} manifest is invalid")

    command = payload.get(phase, {})
    require(phase in ("upgrade", "rollback"), "phase is invalid")
    require(command.get("commandID") == command_id, "command ID does not match approved phase")
    release_name = "candidate" if phase == "upgrade" else "previous"
    release = payload.get(release_name, {})
    require(release.get("runtime") == runtime, f"{phase} runtime identity mismatch")
    require(release.get("reporter") == reporter, f"{phase} reporter identity mismatch")

    qualification = payload.get("qualificationCandidate")
    if qualification is not None:
        require(isinstance(qualification, dict), "qualification candidate is malformed")
        if isinstance(qualification, dict):
            require(
                re.fullmatch(
                    r"/data/actor-qualification/receipts/actor-bj-q01-semantic-failure-candidate-[A-Za-z0-9._-]+\.json",
                    str(qualification.get("path", "")),
                ),
                "qualification candidate path is invalid",
            )
            require(SHA.fullmatch(str(qualification.get("sha256", ""))), "qualification candidate digest is invalid")

    if errors:
        raise ValueError("; ".join(errors))
    return {
        "cell": payload["cell"],
        "runID": run_id,
        "phase": phase,
        "commandID": command_id,
        "contentSHA256": command["contentSHA256"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--phase", required=True, choices=("upgrade", "rollback"))
    parser.add_argument("--command-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--runtime-revision", required=True)
    parser.add_argument("--runtime-manifest", required=True)
    parser.add_argument("--reporter-image", required=True)
    parser.add_argument("--reporter-revision", required=True)
    parser.add_argument("--reporter-manifest", required=True)
    args = parser.parse_args()
    result = verify(
        json.loads(args.receipt.read_text()),
        phase=args.phase,
        command_id=args.command_id,
        run_id=args.run_id,
        runtime=_release(args.runtime_image, args.runtime_revision, args.runtime_manifest),
        reporter=_release(args.reporter_image, args.reporter_revision, args.reporter_manifest),
    )
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
