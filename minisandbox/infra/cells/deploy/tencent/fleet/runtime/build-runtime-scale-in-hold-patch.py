#!/usr/bin/env python3
"""Build the UID/resourceVersion-fenced patch for a runtime scale-in hold."""

import argparse
import json
import sys
from pathlib import Path


HOLD_ANNOTATION = "fleet.actor.dev/runtime-release-hold"
STATE_ANNOTATION = "fleet.actor.dev/workerd-host-drain-state"


class HoldWait(RuntimeError):
    """The workload is healthy but an active drain must finish first."""


def _annotation_path(name: str) -> str:
    return "/metadata/annotations/" + name.replace("~", "~0").replace("/", "~1")


def _passive_state(raw: str, acquired_at: str):
    if not raw:
        return None
    try:
        state = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("Host drain state is malformed") from error
    if not isinstance(state, dict):
        raise ValueError("Host drain state is not an object")
    allowed_fields = {
        "phase",
        "epoch",
        "targetName",
        "targetUID",
        "fromReplicas",
        "startedAt",
        "transitionAt",
    }
    unknown_fields = sorted(set(state) - allowed_fields)
    if unknown_fields:
        raise ValueError("Host drain state has unknown fields: " + ",".join(unknown_fields))
    phase = state.get("phase")
    if phase not in ("Idle", "Observing"):
        raise HoldWait(f"Host drain state is {phase}; waiting for a passive phase")
    if state.get("targetName") not in (None, "") or state.get("targetUID") not in (None, ""):
        raise ValueError(f"passive Host drain state {phase} retains a target")
    if state.get("fromReplicas") not in (None, 0):
        raise ValueError(f"passive Host drain state {phase} retains a source replica count")
    epoch = state.get("epoch", 0)
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
        raise ValueError("passive Host drain state has an invalid epoch")
    if phase == "Observing":
        if not isinstance(state.get("startedAt"), str) or not state["startedAt"]:
            raise ValueError("observing Host drain state has no start time")
        # Observing has no selected Host, fence, or external side effect.  End
        # only this low-load timer in the same CAS that installs the hold, so a
        # continuously contracting Cell cannot starve a release/qualification.
        return json.dumps(
            {
                "phase": "Idle",
                "epoch": epoch,
                "startedAt": "0001-01-01T00:00:00Z",
                "transitionAt": acquired_at,
            },
            separators=(",", ":"),
        )
    return None


def build(document, hold_id: str, acquired_at: str):
    if not isinstance(document, dict):
        raise ValueError("runtime StatefulSet document is not an object")
    metadata = document.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("runtime StatefulSet metadata is missing")
    if metadata.get("deletionTimestamp"):
        raise ValueError("runtime StatefulSet is terminating")
    uid = metadata.get("uid")
    resource_version = metadata.get("resourceVersion")
    if not isinstance(uid, str) or not uid or not isinstance(resource_version, str) or not resource_version:
        raise ValueError("runtime StatefulSet identity is incomplete")
    annotations = metadata.get("annotations")
    if annotations is not None and not isinstance(annotations, dict):
        raise ValueError("runtime StatefulSet annotations are malformed")
    annotations = annotations or {}
    if annotations.get(HOLD_ANNOTATION):
        raise HoldWait("another runtime scale-in hold already exists")
    raw_state = annotations.get(STATE_ANNOTATION, "")
    if not isinstance(raw_state, str):
        raise ValueError("Host drain state annotation is not a string")
    idle_state = _passive_state(raw_state, acquired_at)

    identity = {
        "acquired_at": acquired_at,
        "id": hold_id,
        "workload_uid": uid,
    }
    encoded_hold = json.dumps(identity, separators=(",", ":"), sort_keys=True)
    operations = [
        {"op": "test", "path": "/metadata/uid", "value": uid},
        {"op": "test", "path": "/metadata/resourceVersion", "value": resource_version},
    ]
    if metadata.get("annotations") is None:
        operations.append(
            {"op": "add", "path": "/metadata/annotations", "value": {HOLD_ANNOTATION: encoded_hold}}
        )
    else:
        if idle_state is not None:
            state_path = _annotation_path(STATE_ANNOTATION)
            operations.extend(
                [
                    {"op": "test", "path": state_path, "value": raw_state},
                    {"op": "replace", "path": state_path, "value": idle_state},
                ]
            )
        operations.append(
            {"op": "add", "path": _annotation_path(HOLD_ANNOTATION), "value": encoded_hold}
        )
    return operations, identity


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--statefulset", type=Path, required=True)
    parser.add_argument("--patch", type=Path, required=True)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--hold-id", required=True)
    parser.add_argument("--acquired-at", required=True)
    args = parser.parse_args()
    try:
        document = json.loads(args.statefulset.read_text())
        operations, identity = build(document, args.hold_id, args.acquired_at)
    except HoldWait as error:
        print(error, file=sys.stderr)
        return 75
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1
    args.patch.write_text(json.dumps(operations))
    args.identity.write_text(json.dumps(identity, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
