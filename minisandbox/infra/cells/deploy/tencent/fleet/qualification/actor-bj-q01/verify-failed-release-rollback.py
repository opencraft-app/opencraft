#!/usr/bin/env python3
"""Authorize only the exact rollback recorded by a failed public release gate."""

import argparse
import json
import re
from pathlib import Path


RUNTIME_IMAGE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]*(?:/[A-Za-z0-9._-]+)+/rivet-runtime@sha256:[0-9a-f]{64}$"
)
SCHEMA = "actor-bj-q01-user-transparent-upgrade/v2"
SCHEMAS = {
    SCHEMA,
    "actor-bj-q01-user-transparent-upgrade/v3",
    "actor-bj-q01-user-transparent-upgrade/v4",
}


def require_pod_image(pods, expected, component):
    if not pods:
        raise ValueError(f"rollback receipt has no {component} Pods")
    for pod in pods:
        images = [image for image in pod.get("image_ids", []) if RUNTIME_IMAGE.fullmatch(image)]
        if not images or any(image != expected for image in images):
            raise ValueError(f"{component} Pod does not bind exactly {expected}")


def verify(document, rollback_image, live_engine, live_runtime):
    if document.get("schema") not in SCHEMAS:
        raise ValueError("rollback receipt schema is invalid")
    if document.get("verdict") != "failed" or document.get("release_exit_code") != 0:
        raise ValueError("rollback receipt does not prove a completed failed release")
    if not document.get("public_probe", {}).get("failures"):
        raise ValueError("rollback receipt has no public failure evidence")
    if document.get("public_api_only") is not True:
        raise ValueError("rollback receipt is not a public /v1 qualification")
    if document.get("cleanup_errors"):
        raise ValueError("rollback receipt has incomplete public resource cleanup")
    if document.get("rollback_objects_retained") is not True:
        raise ValueError("failed receipt did not retain its exact rollback Objects")
    object_refs = document.get("rollback_object_refs")
    if not isinstance(object_refs, list) or len(object_refs) < 32 or object_refs != document.get("object_refs"):
        raise ValueError("failed receipt rollback ObjectRefs are incomplete")
    if not RUNTIME_IMAGE.fullmatch(rollback_image):
        raise ValueError("rollback image is outside the q01 runtime repository")
    targets = document.get("target_images", {})
    if targets.get("engine", {}).get("container/engine") != live_engine:
        raise ValueError("failed receipt target Engine does not match the live candidate")
    if (targets.get("runtime", {}).get("container/workerd") != live_runtime
            or targets.get("runtime", {}).get("container/workerd-host") != live_runtime
            or targets.get("runtime", {}).get("init/prepare-workerd-config") != live_runtime):
        raise ValueError("failed receipt target Host does not match the live candidate")
    transitions = {item.get("component"): item for item in document.get("component_transitions", [])}
    for component in ("engine", "runtime"):
        transition = transitions.get(component, {})
        if transition.get("template_changed") is not True or transition.get("outcome") != "changed_complete_rollout":
            raise ValueError("failed candidate did not complete the {} rollout".format(component))
    release_log = document.get("release_log", {})
    if not isinstance(release_log.get("bytes"), int) or release_log.get("bytes") <= 0 or not re.fullmatch(r"[0-9a-f]{64}", str(release_log.get("sha256", ""))):
        raise ValueError("failed receipt has no immutable release log evidence")
    if document.get("public_worker_before") != document.get("public_worker_after"):
        raise ValueError("platform candidate changed the user Worker deployment identity")
    before = document.get("before") or {}
    require_pod_image(before.get("engine_pods"), rollback_image, "prior Engine")
    require_pod_image(before.get("runtime_pods"), rollback_image, "prior Host")
    # The timeline is deliberately stopped before the bounded post-release
    # capacity convergence check. Its final sample may therefore contain new
    # HPA ordinals that have not reported image IDs yet. `after` is the
    # authoritative post-convergence snapshot used by the release gate and is
    # the only observation that may authorize rollback of a completed rollout.
    after = document.get("after") or {}
    require_pod_image(after.get("engine_pods"), live_engine, "live Engine")
    require_pod_image(after.get("runtime_pods"), live_runtime, "live Host")
    if live_engine != live_runtime or live_engine == rollback_image:
        raise ValueError("live runtime is not the distinct failed candidate")
    return {
        "failed_release_run_id": document.get("run_id"),
        "live_image": live_engine,
        "rollback_image": rollback_image,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("rollback_image")
    parser.add_argument("live_engine")
    parser.add_argument("live_runtime")
    args = parser.parse_args()
    with args.receipt.open() as source:
        document = json.load(source)
    print(json.dumps(verify(
        document, args.rollback_image, args.live_engine, args.live_runtime
    ), sort_keys=True))


if __name__ == "__main__":
    main()
