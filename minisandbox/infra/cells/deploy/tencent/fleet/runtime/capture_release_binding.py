#!/usr/bin/env python3
"""Build a fail-closed immutable runtime release binding from kubectl JSON."""

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict


PINNED_IMAGE = re.compile(r"^.+@(?P<digest>sha256:[0-9a-f]{64})$")
RESOLVED_IMAGE = re.compile(r"(?:@|//)(?P<digest>sha256:[0-9a-f]{64})$")
MANIFEST_HASH = re.compile(r"^[0-9a-f]{64}$")
DYNAMIC_RUNTIME_MIN_REPLICAS = 3
# Keep the evidence envelope aligned with the production Host HPA/IaC
# contract.  This is an operational Pod-set bound, not Actor durability
# state; a scale-out above the old laboratory limit of 64 must not make an
# otherwise immutable release impossible to audit.
DYNAMIC_RUNTIME_MAX_REPLICAS = 301


def capture(
    deployment: Dict[str, Any],
    statefulset: Dict[str, Any],
    pods: Dict[str, Any],
    *,
    dynamic_runtime_capacity: bool = False,
) -> Dict[str, Any]:
    def workload(
        document: Dict[str, Any],
        kind: str,
        preferred_primary_names,
        expected_replicas: int,
        dynamic_capacity: bool = False,
    ) -> Dict[str, Any]:
        metadata = document.get("metadata", {})
        spec = document.get("spec", {})
        status = document.get("status", {})
        replicas = spec.get("replicas")
        ready_replicas = status.get("readyReplicas", 0)
        if dynamic_capacity:
            if (
                not isinstance(replicas, int)
                or not DYNAMIC_RUNTIME_MIN_REPLICAS
                <= replicas
                <= DYNAMIC_RUNTIME_MAX_REPLICAS
            ):
                raise ValueError(f"{kind} desired replicas are outside the dynamic capacity bound")
            if (
                not isinstance(ready_replicas, int)
                or not DYNAMIC_RUNTIME_MIN_REPLICAS
                <= ready_replicas
                <= DYNAMIC_RUNTIME_MAX_REPLICAS
            ):
                raise ValueError(f"{kind} has fewer than three Ready replicas")
        elif replicas != expected_replicas or ready_replicas != expected_replicas:
            raise ValueError(f"{kind} is not at {expected_replicas} Ready replicas")
        if status.get("observedGeneration") != metadata.get("generation"):
            raise ValueError(f"{kind} has not observed its current generation")
        template = spec.get("template", {})
        containers = template.get("spec", {}).get("containers", [])
        by_name = {container.get("name"): container for container in containers}
        primary_names = [name for name in preferred_primary_names if name in by_name]
        # Unit fixtures and older single-container manifests do not carry the
        # production container names. In that shape, the sole container is the
        # primary process. A production multi-container workload must name its
        # primary containers explicitly, so an unexpected sidecar cannot become
        # part of the release identity by accident.
        if not primary_names:
            if len(containers) != 1:
                raise ValueError(f"{kind} primary container names are missing")
            primary_names = [containers[0].get("name")]
        images = {by_name[name].get("image") for name in primary_names}
        if len(images) != 1:
            raise ValueError(f"{kind} primary containers do not use one immutable runtime image")
        image = next(iter(images), None)
        if not isinstance(image, str) or PINNED_IMAGE.fullmatch(image) is None:
            raise ValueError(f"{kind} image is not pinned by sha256 digest")
        manifest_hash = template.get("metadata", {}).get("annotations", {}).get(
            "fleet.actor.dev/manifest-sha256"
        )
        if not isinstance(manifest_hash, str) or MANIFEST_HASH.fullmatch(manifest_hash) is None:
            raise ValueError(f"{kind} template manifest hash is missing")
        auxiliary_images = {}
        for name, container in by_name.items():
            if name in primary_names:
                continue
            auxiliary = container.get("image")
            if not isinstance(auxiliary, str) or PINNED_IMAGE.fullmatch(auxiliary) is None:
                raise ValueError(f"{kind} auxiliary container {name} is not pinned by sha256 digest")
            auxiliary_images[name] = auxiliary
        return {
            "image": image,
            "manifest_sha256": manifest_hash,
            "primary_container_names": sorted(primary_names),
            "auxiliary_images": auxiliary_images,
            "desired_replicas": replicas,
            "ready_replicas": ready_replicas,
        }

    engine = workload(deployment, "Engine Deployment", ("engine",), 6)
    runtime = workload(
        statefulset,
        "runtime StatefulSet",
        ("workerd", "workerd-host"),
        3,
        dynamic_runtime_capacity,
    )
    if {key: engine[key] for key in ("image", "manifest_sha256")} != {key: runtime[key] for key in ("image", "manifest_sha256")}:
        raise ValueError("Engine and runtime hosts are not bound to the same release")
    digest = PINNED_IMAGE.fullmatch(engine["image"]).group("digest")

    pod_sets = {"engine": [], "workerd-host": []}
    pod_container_expectations = {
        "engine": engine,
        "workerd-host": runtime,
    }
    resolved_by_spec_image = {}
    resolved_by_component = {"engine": {}, "workerd-host": {}}
    for pod in pods.get("items", []):
        metadata = pod.get("metadata", {})
        component = metadata.get("labels", {}).get("fleet.actor.dev/component")
        if component not in pod_sets:
            continue
        dynamic_runtime_pod = dynamic_runtime_capacity and component == "workerd-host"
        if metadata.get("deletionTimestamp") is not None and dynamic_runtime_pod:
            continue
        if metadata.get("deletionTimestamp") is not None:
            raise ValueError(f"{component} Pod is terminating")
        statuses = pod.get("status", {}).get("containerStatuses", [])
        expected = pod_container_expectations[component]
        pod_containers = {
            container.get("name"): container.get("image")
            for container in pod.get("spec", {}).get("containers", [])
        }
        expected_containers = {
            name: expected["image"] for name in expected["primary_container_names"]
        }
        expected_containers.update(expected["auxiliary_images"])
        if pod_containers != expected_containers:
            raise ValueError(f"{component} Pod spec is not bound to the workload template")
        if dynamic_runtime_pod and (not statuses or not all(status.get("ready") is True for status in statuses)):
            for name in expected["primary_container_names"]:
                if pod_containers.get(name) != expected["image"]:
                    raise ValueError(f"{component} pending primary container {name} is not bound to the release")
            for name, image in expected["auxiliary_images"].items():
                if pod_containers.get(name) != image:
                    raise ValueError(f"{component} pending auxiliary container {name} is not bound to the release")
            continue
        if not statuses or not all(status.get("ready") is True for status in statuses):
            raise ValueError(f"{component} Pod is not fully Ready")
        status_by_name = {status.get("name"): status for status in statuses}
        if len(statuses) == 1 and len(expected["primary_container_names"]) == 1:
            status_by_name.setdefault(expected["primary_container_names"][0], statuses[0])
        for name in expected["primary_container_names"]:
            image_id = str(status_by_name.get(name, {}).get("imageID", ""))
            resolved = RESOLVED_IMAGE.search(image_id)
            if resolved is None:
                raise ValueError(f"{component} primary container {name} has no resolved image digest")
            resolved_digest = resolved.group("digest")
            resolved_by_spec_image.setdefault(expected["image"], set()).add(resolved_digest)
            resolved_by_component[component][name] = resolved_digest
        for name, image in expected["auxiliary_images"].items():
            image_id = str(status_by_name.get(name, {}).get("imageID", ""))
            resolved = RESOLVED_IMAGE.search(image_id)
            if resolved is None:
                raise ValueError(f"{component} auxiliary container {name} has no resolved image digest")
            resolved_digest = resolved.group("digest")
            resolved_by_spec_image.setdefault(image, set()).add(resolved_digest)
            resolved_by_component[component][name] = resolved_digest
        uid = metadata.get("uid")
        if not isinstance(uid, str) or not uid:
            raise ValueError(f"{component} Pod UID is missing")
        pod_sets[component].append(uid)
    desired_by_component = {
        "engine": engine["desired_replicas"],
        "workerd-host": runtime["desired_replicas"],
    }
    for component, uids in pod_sets.items():
        minimum = (
            DYNAMIC_RUNTIME_MIN_REPLICAS
            if dynamic_runtime_capacity and component == "workerd-host"
            else desired_by_component[component]
        )
        maximum = (
            DYNAMIC_RUNTIME_MAX_REPLICAS
            if dynamic_runtime_capacity and component == "workerd-host"
            else desired_by_component[component]
        )
        if not minimum <= len(uids) <= maximum or len(set(uids)) != len(uids):
            if maximum == minimum:
                raise ValueError(f"expected exactly {minimum} distinct {component} Pod UIDs")
            raise ValueError(
                f"expected {minimum} through {maximum} distinct Ready {component} Pod UIDs"
            )
        uids.sort()
    for image, resolved_digests in resolved_by_spec_image.items():
        if len(resolved_digests) != 1:
            raise ValueError(f"digest-pinned image resolved inconsistently across Ready Pods: {image}")

    return {
        "contract": "same_immutable_release_and_pod_set_before_after_qualification",
        "runtime_image": engine["image"],
        "runtime_digest": digest,
        "manifest_sha256": engine["manifest_sha256"],
        "engine_primary_container_names": engine["primary_container_names"],
        "runtime_primary_container_names": runtime["primary_container_names"],
        "engine_auxiliary_images": engine["auxiliary_images"],
        "runtime_auxiliary_images": runtime["auxiliary_images"],
        "resolved_container_digests": resolved_by_component,
        "runtime_capacity_dynamic": dynamic_runtime_capacity,
        "engine_desired_replicas": engine["desired_replicas"],
        "runtime_desired_replicas": runtime["desired_replicas"],
        "runtime_ready_replicas": runtime["ready_replicas"],
        "engine_pod_uids": pod_sets["engine"],
        "runtime_host_pod_uids": pod_sets["workerd-host"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--deployment", type=Path, required=True)
    parser.add_argument("--statefulset", type=Path, required=True)
    parser.add_argument("--pods", type=Path, required=True)
    parser.add_argument("--dynamic-runtime-capacity", action="store_true")
    args = parser.parse_args()
    result = capture(
        json.loads(args.deployment.read_text()),
        json.loads(args.statefulset.read_text()),
        json.loads(args.pods.read_text()),
        dynamic_runtime_capacity=args.dynamic_runtime_capacity,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
