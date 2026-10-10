#!/usr/bin/env python3
"""UID-fenced normal Pod deletion for qualification fault injection."""

from __future__ import annotations

import json
import pathlib
import re
import tempfile


def replacement_in_snapshot(pods: list[dict], old_uids: set[str], victim_uid: str) -> dict | None:
    if victim_uid not in old_uids:
        raise ValueError("replacement victim must belong to the original Pod snapshot")
    current_uids = {pod["metadata"]["uid"] for pod in pods}
    if len(current_uids) != len(pods):
        raise RuntimeError("Pod snapshot contains duplicate UIDs")
    added = [pod for pod in pods if pod["metadata"]["uid"] not in old_uids]
    if len(pods) != len(old_uids) or len(added) != 1:
        return None
    if victim_uid in current_uids or not (old_uids - {victim_uid}) <= current_uids:
        raise RuntimeError("replacement changed an unselected Pod instead of the exact victim")
    return added[0]


def delete_exact_pod(kubectl, pod: dict) -> None:
    metadata = pod.get("metadata", {})
    namespace = kubectl.namespace
    name = metadata.get("name")
    uid = metadata.get("uid")
    if (
        not isinstance(namespace, str)
        or len(namespace) > 63
        or re.fullmatch(r"[a-z0-9](?:[-a-z0-9]*[a-z0-9])?", namespace) is None
        or metadata.get("namespace") != namespace
        or not isinstance(name, str)
        or len(name) > 253
        or re.fullmatch(r"[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?", name) is None
        or not isinstance(uid, str)
        or len(uid) > 128
        or re.fullmatch(r"[A-Za-z0-9-]+", uid) is None
    ):
        raise ValueError("selected Pod must have an exact namespace, name and UID")

    # The API checks the UID atomically. A second GET would still leave an ABA
    # window before deletion. Omit gracePeriodSeconds to preserve preStop and
    # the Pod's configured termination grace period.
    options = {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": uid}}
    with tempfile.TemporaryDirectory(prefix="qualification-pod-delete-", dir="/data/tmp") as directory:
        path = pathlib.Path(directory) / "delete-options.json"
        path.write_text(json.dumps(options))
        response = kubectl.run(
            "delete", "--raw", f"/api/v1/namespaces/{namespace}/pods/{name}",
            "-f", str(path), "--request-timeout=10s", timeout=15,
        )
    acknowledged = json.loads(response)
    if acknowledged.get("metadata", {}).get("uid") != uid:
        raise RuntimeError("Kubernetes did not acknowledge the exact selected Pod UID")
