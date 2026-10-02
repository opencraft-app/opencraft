#!/usr/bin/env python3
"""Fail closed unless a Cell is settled at its production Runtime HPA floor."""

from __future__ import annotations

import argparse
import json
import subprocess
from typing import Any


MIN_PRODUCTION_HOSTS = 4
EXPECTED_ENGINE_REPLICAS = 6


def _ready_condition(document: dict[str, Any], name: str) -> bool:
    return any(
        condition.get("type") == name and condition.get("status") == "True"
        for condition in document.get("status", {}).get("conditions", [])
    )


def validate_documents(
    cell: str,
    engine: dict[str, Any],
    runtime: dict[str, Any],
    hpa: dict[str, Any],
) -> dict[str, int]:
    engine_spec = engine.get("spec", {}).get("replicas")
    engine_status = engine.get("status", {})
    if engine_spec != EXPECTED_ENGINE_REPLICAS or any(
        engine_status.get(field) != EXPECTED_ENGINE_REPLICAS
        for field in ("readyReplicas", "availableReplicas", "updatedReplicas")
    ):
        raise ValueError("Engine is not exactly 6/6 Ready, available, and updated")
    if engine_status.get("observedGeneration") != engine.get("metadata", {}).get("generation"):
        raise ValueError("Engine generation is not reconciled")

    hpa_spec = hpa.get("spec", {})
    target = hpa_spec.get("scaleTargetRef", {})
    expected_runtime = f"{cell}-runtime-hosts"
    if target != {"apiVersion": "apps/v1", "kind": "StatefulSet", "name": expected_runtime}:
        raise ValueError("Runtime HPA does not target the exact Cell StatefulSet")
    floor = hpa_spec.get("minReplicas")
    ceiling = hpa_spec.get("maxReplicas")
    if not isinstance(floor, int) or floor < MIN_PRODUCTION_HOSTS:
        raise ValueError("Runtime HPA floor is below the production minimum of 4")
    if not isinstance(ceiling, int) or ceiling < floor:
        raise ValueError("Runtime HPA ceiling is invalid")
    if not _ready_condition(hpa, "AbleToScale") or not _ready_condition(hpa, "ScalingActive"):
        raise ValueError("Runtime HPA is not able to scale with an active metric")

    runtime_metadata = runtime.get("metadata", {})
    runtime_spec = runtime.get("spec", {}).get("replicas")
    runtime_status = runtime.get("status", {})
    if runtime_metadata.get("name") != expected_runtime:
        raise ValueError("Runtime StatefulSet identity does not match the Cell")
    if runtime_status.get("observedGeneration") != runtime_metadata.get("generation"):
        raise ValueError("Runtime StatefulSet generation is not reconciled")
    if runtime_spec != floor or any(
        runtime_status.get(field) != floor
        for field in ("readyReplicas", "currentReplicas", "updatedReplicas")
    ):
        raise ValueError("Runtime is not fully converged at the authoritative HPA floor")
    if not runtime_status.get("currentRevision") or (
        runtime_status.get("currentRevision") != runtime_status.get("updateRevision")
    ):
        raise ValueError("Runtime StatefulSet revision is not converged")

    annotations = runtime_metadata.get("annotations", {}) or {}
    if annotations.get("fleet.actor.dev/runtime-release-hold"):
        raise ValueError("Runtime release hold is active")
    raw_drain = annotations.get("fleet.actor.dev/workerd-host-drain-state")
    try:
        drain = json.loads(raw_drain) if raw_drain else None
    except (TypeError, ValueError) as error:
        raise ValueError("Runtime drain state is malformed") from error
    if not isinstance(drain, dict) or drain.get("phase") != "Idle":
        raise ValueError("Runtime drain state is not Idle")

    return {"engine_replicas": EXPECTED_ENGINE_REPLICAS, "runtime_floor": floor}


def kubectl_json(kubeconfig: str | None, *args: str) -> dict[str, Any]:
    command = ["kubectl"]
    if kubeconfig:
        command += ["--kubeconfig", kubeconfig]
    command += [*args, "-o", "json"]
    return json.loads(subprocess.check_output(command, text=True, timeout=120))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cell", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--kubeconfig")
    args = parser.parse_args()
    engine = kubectl_json(
        args.kubeconfig,
        "-n", args.namespace, "get", "deployment", f"{args.cell}-engine",
    )
    runtime = kubectl_json(
        args.kubeconfig,
        "-n", args.namespace, "get", "statefulset", f"{args.cell}-runtime-hosts",
    )
    hpa = kubectl_json(
        args.kubeconfig,
        "-n", args.namespace, "get", "hpa", f"{args.cell}-runtime-hosts-actor-capacity",
    )
    result = validate_documents(args.cell, engine, runtime, hpa)
    print(
        "loadgen_runtime_floor=passed "
        f"engine={result['engine_replicas']} runtime={result['runtime_floor']}"
    )


if __name__ == "__main__":
    main()
