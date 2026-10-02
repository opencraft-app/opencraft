#!/usr/bin/env python3
"""Build and audit the immutable, static part of a Cell runtime release.

The ledger intentionally excludes replica counts and all Node/Machine/FDB
state.  Those fields have independent reconcilers.  It records only the
release-owned workload specifications, non-secret ConfigMaps, immutable image
digests, source identity, and preflight contract.
"""

import argparse
import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Tuple


SCHEMA = "actor-fleet-static-release-ledger/v1"
PINNED_IMAGE = re.compile(r"^.+@(?P<digest>sha256:[0-9a-f]{64})$")
RESOLVED_IMAGE = re.compile(r"(?:@|//)(?P<digest>sha256:[0-9a-f]{64})$")
SHA256 = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
SOURCE_REVISION = re.compile(r"^[0-9a-f]{40}$")
DYNAMIC_REPORTER_ENV = {
    "CAPACITY_RISK",
    "QUALIFICATION_READY",
    "QUALIFICATION_RECEIPT",
    "QUALIFICATION_DIGEST",
    "QUALIFICATION_RELEASE_DIGEST",
}


def strip_sha256_prefix(value: str) -> str:
    return value[7:] if value.startswith("sha256:") else value


def canonical_bytes(value: Any) -> bytes:
    # Go's encoding/json emits UTF-8 but, unless explicitly disabled, escapes
    # HTML metacharacters. The reporter disables that HTML-only behavior; keep
    # this canonical representation byte-identical across both languages.
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(value)).hexdigest()


def _require_pinned_image(image: Any, where: str) -> str:
    if not isinstance(image, str) or PINNED_IMAGE.fullmatch(image) is None:
        raise ValueError(f"{where} is not pinned by registry sha256 digest")
    return image


def _named_images(template_spec: Mapping[str, Any], field: str, where: str) -> Dict[str, str]:
    result: Dict[str, str] = {}
    for container in template_spec.get(field, []) or []:
        name = container.get("name")
        if not isinstance(name, str) or not name or name in result:
            raise ValueError(f"{where} has an invalid or duplicate {field} name")
        result[name] = _require_pinned_image(container.get("image"), f"{where} {field}/{name}")
    return result


def _static_workload_spec(document: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the release-owned workload spec.

    Replica count is owned by HPA/Host drain. The Cell reporter's five
    admission inputs are owned by the qualification publisher and are backed
    by a separate immutable receipt. Everything else remains release-owned.
    """

    spec = copy.deepcopy(document.get("spec", {}))
    spec.pop("replicas", None)
    # Kubernetes' unstructured JSON response materializes the zero-valued
    # PodTemplate ObjectMeta timestamp as null. The typed Go client used by the
    # continuous reporter omits that field. It is API serialization noise, not
    # release-owned state, so both ledger creation and audit remove it.
    template_metadata = spec.get("template", {}).get("metadata", {})
    if isinstance(template_metadata, dict):
        template_metadata.pop("creationTimestamp", None)
    metadata = document.get("metadata", {})
    if (
        document.get("kind") == "Deployment"
        and str(metadata.get("name", "")).endswith("-cell-reporter")
    ):
        containers = (
            spec.get("template", {}).get("spec", {}).get("containers", []) or []
        )
        for container in containers:
            if container.get("name") != "reporter":
                continue
            if "env" not in container:
                continue
            filtered = [
                item
                for item in container.get("env", []) or []
                if item.get("name") not in DYNAMIC_REPORTER_ENV
            ]
            if filtered:
                container["env"] = filtered
            else:
                container.pop("env", None)
    return spec


def workload_entry(
    document: Mapping[str, Any],
    *,
    expected_kind: str,
    expected_name: str,
    expected_namespace: str,
    containers: Mapping[str, str],
    init_containers: Optional[Mapping[str, str]] = None,
) -> Dict[str, Any]:
    metadata = document.get("metadata", {})
    if document.get("kind") != expected_kind:
        raise ValueError(f"{expected_name} kind is not {expected_kind}")
    if metadata.get("name") != expected_name or metadata.get("namespace") != expected_namespace:
        raise ValueError(f"{expected_kind}/{expected_name} identity mismatch")
    spec = document.get("spec", {})
    template = spec.get("template", {})
    template_spec = template.get("spec", {})
    observed_containers = _named_images(template_spec, "containers", expected_name)
    observed_init = _named_images(template_spec, "initContainers", expected_name)
    expected_init = dict(init_containers or {})
    if observed_containers != dict(containers):
        raise ValueError(
            f"{expected_kind}/{expected_name} container set differs: "
            f"observed={observed_containers!r} expected={dict(containers)!r}"
        )
    if observed_init != expected_init:
        raise ValueError(
            f"{expected_kind}/{expected_name} init container set differs: "
            f"observed={observed_init!r} expected={expected_init!r}"
        )
    selector = spec.get("selector", {}).get("matchLabels", {})
    if not isinstance(selector, dict) or not selector:
        raise ValueError(f"{expected_kind}/{expected_name} has no exact matchLabels selector")
    return {
        "kind": expected_kind,
        "name": expected_name,
        "namespace": expected_namespace,
        "selector": dict(sorted(selector.items())),
        "containers": dict(sorted(observed_containers.items())),
        "initContainers": dict(sorted(observed_init.items())),
        "staticSpecDigest": digest(_static_workload_spec(document)),
    }


def configmap_entry(document: Mapping[str, Any], *, name: str, namespace: str) -> Dict[str, Any]:
    metadata = document.get("metadata", {})
    if document.get("kind") != "ConfigMap" or metadata.get("name") != name or metadata.get("namespace") != namespace:
        raise ValueError(f"ConfigMap/{name} identity mismatch")
    content = {
        "data": document.get("data", {}) or {},
        "binaryData": document.get("binaryData", {}) or {},
        "immutable": document.get("immutable", False),
    }
    return {"name": name, "namespace": namespace, "contentDigest": digest(content)}


def _release_identity(ledger: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "schemaVersion": ledger.get("schemaVersion"),
        "cell": ledger.get("cell"),
        "namespace": ledger.get("namespace"),
        "source": ledger.get("source"),
        "workloads": ledger.get("workloads"),
        "configMaps": ledger.get("configMaps"),
        "preflight": ledger.get("preflight"),
    }


def build_runtime_ledger(
    *,
    cell: str,
    namespace: str,
    released_at: str,
    source_revision: str,
    source_manifest_sha256: str,
    reporter_source_revision: str,
    reporter_source_manifest_sha256: str,
    runtime_image: str,
    reporter_image: str,
    nats_image: str,
    workerd_metrics_image: str,
    engine: Mapping[str, Any],
    runtime_hosts: Mapping[str, Any],
    runtime_capacity: Mapping[str, Any],
    nats: Mapping[str, Any],
    runtime_config: Mapping[str, Any],
    nats_config: Mapping[str, Any],
    reporter: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    for source_name, revision, manifest in (
        ("runtime", source_revision, source_manifest_sha256),
        ("control", reporter_source_revision, reporter_source_manifest_sha256),
    ):
        if SOURCE_REVISION.fullmatch(revision) is None:
            raise ValueError(f"{source_name} source revision must be a full 40-character commit ID")
        if SHA256.fullmatch(manifest) is None:
            raise ValueError(f"{source_name} source manifest sha256 is invalid")
    runtime_image = _require_pinned_image(runtime_image, "runtime image")
    reporter_image = _require_pinned_image(reporter_image, "reporter image")
    nats_image = _require_pinned_image(nats_image, "NATS image")
    workerd_metrics_image = _require_pinned_image(workerd_metrics_image, "workerd metrics image")

    workloads = [
        workload_entry(
            engine,
            expected_kind="Deployment",
            expected_name=f"{cell}-engine",
            expected_namespace=namespace,
            containers={"engine": runtime_image},
        ),
        workload_entry(
            runtime_hosts,
            expected_kind="StatefulSet",
            expected_name=f"{cell}-runtime-hosts",
            expected_namespace=namespace,
            containers={
                "workerd": runtime_image,
                "workerd-host": runtime_image,
                "workerd-metrics": workerd_metrics_image,
            },
            init_containers={"prepare-workerd-config": runtime_image},
        ),
        workload_entry(
            runtime_capacity,
            expected_kind="Deployment",
            expected_name=f"{cell}-runtime-capacity",
            expected_namespace=namespace,
            containers={"controller": reporter_image},
        ),
        workload_entry(
            nats,
            expected_kind="StatefulSet",
            expected_name=f"{cell}-nats",
            expected_namespace=namespace,
            containers={"nats": nats_image},
        ),
    ]
    if reporter is not None:
        workloads.append(
            workload_entry(
                reporter,
                expected_kind="Deployment",
                expected_name=f"{cell}-cell-reporter",
                expected_namespace=namespace,
                containers={"reporter": reporter_image},
            )
        )
    workloads.sort(key=lambda item: (item["kind"], item["name"]))
    configmaps = [
        configmap_entry(runtime_config, name=f"{cell}-runtime-config", namespace=namespace),
        configmap_entry(nats_config, name=f"{cell}-nats-config", namespace=namespace),
    ]
    configmaps.sort(key=lambda item: item["name"])
    ledger: Dict[str, Any] = {
        "schemaVersion": SCHEMA,
        "cell": cell,
        "namespace": namespace,
        "releasedAt": released_at,
        "source": {
            "runtime": {
                "revision": source_revision,
                "manifestSha256": strip_sha256_prefix(source_manifest_sha256),
            },
            "control": {
                "revision": reporter_source_revision,
                "manifestSha256": strip_sha256_prefix(reporter_source_manifest_sha256),
            },
        },
        "workloads": workloads,
        "configMaps": configmaps,
        "preflight": [
            {"image": reporter_image, "command": ["/usr/local/bin/workerd-runtime-capacity-controller", "--help"], "expectedExitCode": 0},
            {"image": reporter_image, "command": ["/usr/local/bin/rivet-cell-reporter", "--help"], "expectedExitCode": 1},
            {"image": runtime_image, "contract": "validate-runtime-image.sh"},
        ],
    }
    ledger["releaseId"] = digest(_release_identity(ledger))
    return ledger


def validate_ledger(ledger: Mapping[str, Any], *, cell: str, namespace: str) -> None:
    if ledger.get("schemaVersion") != SCHEMA:
        raise ValueError("release ledger schema mismatch")
    if ledger.get("cell") != cell or ledger.get("namespace") != namespace:
        raise ValueError("release ledger Cell identity mismatch")
    if ledger.get("releaseId") != digest(_release_identity(ledger)):
        raise ValueError("release ledger identity digest mismatch")
    source = ledger.get("source", {})
    if set(source) != {"runtime", "control"}:
        raise ValueError("release ledger source inventory is incomplete")
    for source_name in ("runtime", "control"):
        identity = source.get(source_name, {})
        if SOURCE_REVISION.fullmatch(str(identity.get("revision", ""))) is None:
            raise ValueError(f"release ledger {source_name} source revision is invalid")
        if SHA256.fullmatch(str(identity.get("manifestSha256", ""))) is None:
            raise ValueError(f"release ledger {source_name} source manifest digest is invalid")
    seen: Set[Tuple[str, str]] = set()
    for item in ledger.get("workloads", []) or []:
        key = (str(item.get("kind", "")), str(item.get("name", "")))
        if key in seen or key[0] not in {"Deployment", "StatefulSet"} or not key[1]:
            raise ValueError("release ledger has an invalid or duplicate workload")
        seen.add(key)
        if item.get("namespace") != namespace or not SHA256.fullmatch(str(item.get("staticSpecDigest", ""))):
            raise ValueError(f"release ledger workload {key} is invalid")
        for image in list((item.get("containers") or {}).values()) + list((item.get("initContainers") or {}).values()):
            _require_pinned_image(image, f"release ledger workload {key}")
    required_workloads = {
        ("Deployment", f"{cell}-engine"),
        ("StatefulSet", f"{cell}-runtime-hosts"),
        ("Deployment", f"{cell}-runtime-capacity"),
        ("StatefulSet", f"{cell}-nats"),
    }
    optional_workloads = {("Deployment", f"{cell}-cell-reporter")}
    if not required_workloads.issubset(seen) or not seen.issubset(required_workloads | optional_workloads):
        raise ValueError("release ledger workload inventory is incomplete or contains an unowned object")
    configmap_names = [item.get("name") for item in ledger.get("configMaps", []) or []]
    if sorted(configmap_names) != sorted((f"{cell}-runtime-config", f"{cell}-nats-config")):
        raise ValueError("release ledger ConfigMap inventory is incomplete or contains an unowned object")
    for item in ledger.get("configMaps", []) or []:
        if item.get("namespace") != namespace or not SHA256.fullmatch(str(item.get("contentDigest", ""))):
            raise ValueError("release ledger ConfigMap entry is invalid")


def release_qualification_scope(ledger: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the Cell-neutral immutable artifact set qualified by a canary.

    Per-Cell rendered configuration remains owned by that Cell's static release
    ledger and data-path receipts.  Upgrade/rollback behavior is reusable only
    across Cells running this exact role-to-image and source set.
    """

    cell = str(ledger.get("cell", ""))
    namespace = str(ledger.get("namespace", ""))
    validate_ledger(ledger, cell=cell, namespace=namespace)
    suffix_roles = {
        f"{cell}-engine": "engine",
        f"{cell}-runtime-hosts": "runtime",
        f"{cell}-runtime-capacity": "capacity",
        f"{cell}-nats": "nats",
        f"{cell}-cell-reporter": "reporter",
    }
    target_images: Dict[str, Dict[str, str]] = {}
    for workload in ledger.get("workloads", []):
        role = suffix_roles.get(workload.get("name"))
        if role is None or role in target_images:
            raise ValueError("release qualification workload role is invalid or duplicated")
        images = {
            **{
                f"container/{name}": image
                for name, image in (workload.get("containers") or {}).items()
            },
            **{
                f"init/{name}": image
                for name, image in (workload.get("initContainers") or {}).items()
            },
        }
        target_images[role] = dict(sorted(images.items()))
    if set(target_images) != set(suffix_roles.values()):
        raise ValueError("release qualification image-role inventory is incomplete")
    identity = {
        "schema": "actor-runtime-release-artifact/v1",
        "source": ledger["source"],
        "targetImages": dict(sorted(target_images.items())),
    }
    return {**identity, "artifactDigest": digest(identity)}


def _labels_match(labels: Mapping[str, str], selector: Mapping[str, str]) -> bool:
    return all(labels.get(key) == value for key, value in selector.items())


def _pod_ready(pod: Mapping[str, Any]) -> bool:
    metadata = pod.get("metadata", {})
    if metadata.get("deletionTimestamp") or pod.get("status", {}).get("phase") != "Running":
        return False
    conditions = {item.get("type"): item.get("status") for item in pod.get("status", {}).get("conditions", [])}
    return conditions.get("Ready") == "True"


def audit_ledger(
    ledger: Mapping[str, Any],
    *,
    cell: str,
    namespace: str,
    workloads: Mapping[Tuple[str, str], Mapping[str, Any]],
    configmaps: Mapping[str, Mapping[str, Any]],
    pods: Iterable[Mapping[str, Any]],
) -> Dict[str, Any]:
    drifts: List[Dict[str, Any]] = []
    try:
        validate_ledger(ledger, cell=cell, namespace=namespace)
    except (TypeError, ValueError) as exc:
        return {
            "ready": False,
            "releaseId": ledger.get("releaseId") if isinstance(ledger, Mapping) else None,
            "driftCount": 1,
            "drifts": [{"component": "ledger", "reason": str(exc)}],
        }

    pod_list = list(pods)
    for expected in ledger.get("workloads", []):
        key = (expected["kind"], expected["name"])
        observed = workloads.get(key)
        component = f"{key[0]}/{key[1]}"
        if observed is None:
            drifts.append({"component": component, "reason": "workload_missing"})
            continue
        actual_static_digest = digest(_static_workload_spec(observed))
        if actual_static_digest != expected["staticSpecDigest"]:
            drifts.append({
                "component": component,
                "reason": "static_spec_digest_mismatch",
                "expected": expected["staticSpecDigest"],
                "observed": actual_static_digest,
            })
        template_spec = observed.get("spec", {}).get("template", {}).get("spec", {})
        try:
            actual_containers = _named_images(template_spec, "containers", component)
            actual_init = _named_images(template_spec, "initContainers", component)
            if actual_containers != expected.get("containers", {}):
                drifts.append({"component": component, "reason": "container_images_mismatch"})
            if actual_init != expected.get("initContainers", {}):
                drifts.append({"component": component, "reason": "init_container_images_mismatch"})
        except ValueError as exc:
            drifts.append({"component": component, "reason": str(exc)})

        matching_ready = [
            pod for pod in pod_list
            if _pod_ready(pod)
            and _labels_match(pod.get("metadata", {}).get("labels", {}), expected.get("selector", {}))
        ]
        if not matching_ready:
            drifts.append({"component": component, "reason": "no_ready_pod_for_release"})
            continue
        expected_images = {**expected.get("containers", {}), **expected.get("initContainers", {})}
        resolved_images = {name: set() for name in expected_images}
        for pod in matching_ready:
            pod_spec = pod.get("spec", {})
            try:
                pod_images = {
                    **_named_images(pod_spec, "containers", component + " Pod"),
                    **_named_images(pod_spec, "initContainers", component + " Pod"),
                }
            except ValueError as exc:
                drifts.append({
                    "component": component,
                    "pod": pod.get("metadata", {}).get("name"),
                    "reason": str(exc),
                })
                continue
            if pod_images != expected_images:
                drifts.append({
                    "component": component,
                    "pod": pod.get("metadata", {}).get("name"),
                    "reason": "pod_spec_image_mismatch",
                })
                continue
            status_items = (
                list(pod.get("status", {}).get("containerStatuses", []) or [])
                + list(pod.get("status", {}).get("initContainerStatuses", []) or [])
            )
            status_by_name = {item.get("name"): item for item in status_items}
            for container_name in expected_images:
                image_id = str(status_by_name.get(container_name, {}).get("imageID", ""))
                resolved = RESOLVED_IMAGE.search(image_id)
                if resolved is None:
                    drifts.append({
                        "component": component,
                        "pod": pod.get("metadata", {}).get("name"),
                        "container": container_name,
                        "reason": "pod_image_id_mismatch",
                    })
                else:
                    resolved_images[container_name].add(resolved.group("digest"))
        for container_name, digests in resolved_images.items():
            if len(digests) > 1:
                drifts.append({
                    "component": component,
                    "container": container_name,
                    "reason": "pod_resolved_image_inconsistent",
                })

    for expected in ledger.get("configMaps", []):
        name = expected.get("name")
        observed = configmaps.get(name)
        component = f"ConfigMap/{name}"
        if observed is None:
            drifts.append({"component": component, "reason": "configmap_missing"})
            continue
        try:
            actual = configmap_entry(observed, name=name, namespace=namespace)["contentDigest"]
        except ValueError as exc:
            drifts.append({"component": component, "reason": str(exc)})
            continue
        if actual != expected.get("contentDigest"):
            drifts.append({
                "component": component,
                "reason": "configmap_content_digest_mismatch",
                "expected": expected.get("contentDigest"),
                "observed": actual,
            })
    return {
        "ready": not drifts,
        "releaseId": ledger.get("releaseId"),
        "driftCount": len(drifts),
        "drifts": drifts,
    }


def _load(path: str) -> Dict[str, Any]:
    return json.loads(Path(path).read_text())


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the static runtime release ledger.")
    parser.add_argument("--cell", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--released-at", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-manifest-sha256", required=True)
    parser.add_argument("--reporter-source-revision", required=True)
    parser.add_argument("--reporter-source-manifest-sha256", required=True)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--reporter-image", required=True)
    parser.add_argument("--nats-image", required=True)
    parser.add_argument("--workerd-metrics-image", required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--runtime-hosts", required=True)
    parser.add_argument("--runtime-capacity", required=True)
    parser.add_argument("--nats", required=True)
    parser.add_argument("--runtime-config", required=True)
    parser.add_argument("--nats-config", required=True)
    parser.add_argument("--reporter")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    ledger = build_runtime_ledger(
        cell=args.cell,
        namespace=args.namespace,
        released_at=args.released_at,
        source_revision=args.source_revision,
        source_manifest_sha256=args.source_manifest_sha256,
        reporter_source_revision=args.reporter_source_revision,
        reporter_source_manifest_sha256=args.reporter_source_manifest_sha256,
        runtime_image=args.runtime_image,
        reporter_image=args.reporter_image,
        nats_image=args.nats_image,
        workerd_metrics_image=args.workerd_metrics_image,
        engine=_load(args.engine),
        runtime_hosts=_load(args.runtime_hosts),
        runtime_capacity=_load(args.runtime_capacity),
        nats=_load(args.nats),
        runtime_config=_load(args.runtime_config),
        nats_config=_load(args.nats_config),
        reporter=_load(args.reporter) if args.reporter else None,
    )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(ledger, indent=2, sort_keys=True) + "\n")
    print(f"release_id={ledger['releaseId']}")


if __name__ == "__main__":
    main()
