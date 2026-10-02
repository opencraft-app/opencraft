#!/usr/bin/env python3
"""Qualify stateless-to-Durable routing across bounded Pod replacements."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import time
import urllib.parse


ROOT = pathlib.Path(__file__).resolve().parent
REPO = (
    pathlib.Path(os.environ["MINISANDBOX_REPO"])
    if "MINISANDBOX_REPO" in os.environ
    else ROOT.parents[6]
)


def load_module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load qualification helper {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


smoke = load_module(
    "cloud_stateless_do_smoke",
    REPO / "infra/cells/deploy/tencent/fleet/load/stateless-durable-routing/run.py",
)
runtime = load_module(
    "persistent_runtime_e2e",
    REPO / "infra/cells/deploy/local/mesh/workerd-persistent-code-e2e/run.py",
)


def parse_cell_kubeconfigs(values: list[str]) -> dict[str, pathlib.Path]:
    result: dict[str, pathlib.Path] = {}
    for value in values:
        cell, separator, raw_path = value.partition("=")
        if not separator or not cell or not raw_path:
            raise ValueError("--cell-kubeconfig must be CELL=/absolute/path")
        path = pathlib.Path(raw_path)
        if not path.is_absolute():
            raise ValueError("Cell kubeconfig paths must be absolute")
        if cell in result:
            raise ValueError(f"duplicate Cell kubeconfig: {cell}")
        result[cell] = path
    return result


def listed_pods(kubectl, selector: str) -> list[dict]:
    return [
        pod
        for pod in kubectl.json("get", "pods", "-l", selector).get("items", [])
        if pod.get("metadata", {}).get("deletionTimestamp") is None
    ]


def replace_one_pod(kubectl, selector: str, expected: int, timeout: float) -> dict:
    before = listed_pods(kubectl, selector)
    ready = sorted((pod for pod in before if runtime.ready(pod)), key=lambda pod: pod["metadata"]["name"])
    if len(before) != expected or len(ready) != expected:
        raise RuntimeError(
            f"replacement requires exactly {expected} non-terminating Ready Pods for {selector}; "
            f"observed total={len(before)} ready={len(ready)}"
        )
    old_uids = {pod["metadata"]["uid"] for pod in before}
    victim = ready[0]
    old_name = victim["metadata"]["name"]
    old_uid = victim["metadata"]["uid"]
    kubectl.run("delete", "pod", old_name, "--wait=false")

    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            after = listed_pods(kubectl, selector)
            ready_after = [pod for pod in after if runtime.ready(pod)]
            new_pods = [pod for pod in ready_after if pod["metadata"]["uid"] not in old_uids]
            last = {
                "total": len(after),
                "ready": len(ready_after),
                "new": [pod["metadata"]["name"] for pod in new_pods],
            }
            if len(after) == expected and len(ready_after) == expected and len(new_pods) == 1:
                replacement = new_pods[0]
                return {
                    "selector": selector,
                    "pod": old_name,
                    "oldPodUid": old_uid,
                    "newPod": replacement["metadata"]["name"],
                    "newPodUid": replacement["metadata"]["uid"],
                    "readyReplicas": expected,
                }
        except Exception as error:  # transient API failure remains bounded by timeout
            last = str(error)
        time.sleep(0.5)
    raise TimeoutError(f"Pod replacement did not restore the exact Ready floor: {last}")


def dispatch(api: str, worker: str, name: str | None = None) -> dict:
    original = "https://fault-matrix.example/plain"
    if name is not None:
        original = "https://fault-matrix.example/counter?" + urllib.parse.urlencode({"name": name})
    _, payload = smoke.request(
        "POST" if name is not None else "GET",
        f"{api}/workers/{worker}/dispatch",
        headers={"X-Workers-Original-URL": original},
    )
    return payload


def assert_counter(api: str, worker: str, name: str, expected: int) -> dict:
    payload = dispatch(api, worker, name)
    if payload != {"value": expected}:
        raise RuntimeError(f"Counter {name} returned {payload}, expected value={expected}")
    return payload


def registry_record(registry_url: str, namespace: str, worker: str, object_value: str) -> dict:
    _, record = smoke.request(
        "GET",
        f"{registry_url}/internal/v1/namespaces/{namespace}/workers/{worker}"
        f"/objects/{smoke.CLASS_NAME}/{object_value}",
    )
    return record


def run(args) -> dict:
    cell_kubeconfigs = parse_cell_kubeconfigs(args.cell_kubeconfig)
    if len(cell_kubeconfigs) != 2:
        raise ValueError("fault qualification requires exactly two Cells")
    api = args.endpoint.rstrip("/") + "/v1"
    registry_url = args.registry_endpoint.rstrip("/")
    cells = set(cell_kubeconfigs)
    cell_uids = smoke.ready_cell_uids(args.hub_kubeconfig, cells)
    names = smoke.names_for_cells(args.namespace, args.worker, cell_uids)
    hub = runtime.Kubectl(args.hub_kubeconfig, args.hub_namespace)
    cell_clients = {
        cell: runtime.Kubectl(kubeconfig, args.cell_namespace)
        for cell, kubeconfig in cell_kubeconfigs.items()
    }
    stateless_clients = {
        cell: runtime.Kubectl(kubeconfig, args.stateless_namespace)
        for cell, kubeconfig in cell_kubeconfigs.items()
    }
    engines = {
        cell: runtime.PortForward(client, f"service/{cell}-engine", 6420)
        for cell, client in cell_clients.items()
    }
    object_paths: list[str] = []
    placements: dict[str, dict] = {}
    replacements: dict[str, dict] = {}
    cleanup_errors: list[str] = []
    result = None
    try:
        _, version = smoke.request("POST", f"{api}/workers/{args.worker}/versions", {
            "main_module": "main.js",
            "modules": {"main.js": smoke.WORKER_SOURCE},
            "compatibility_date": args.compatibility_date,
            "durable_objects": {"COUNTER": smoke.CLASS_NAME},
        })
        _, deployment = smoke.request(
            "POST", f"{api}/workers/{args.worker}/deployments", {"version_id": version["id"]}
        )
        plain = dispatch(api, args.worker)
        if plain != {"plane": "stateless", "host": "fault-matrix.example"}:
            raise RuntimeError(f"ordinary stateless dispatch differs: {plain}")

        for cell, (name, object_value) in names.items():
            path = f"{api}/workers/{args.worker}/objects/{smoke.CLASS_NAME}/{object_value}"
            object_paths.append(path)
            assert_counter(api, args.worker, name, 1)
            record = registry_record(registry_url, args.namespace, args.worker, object_value)
            if record.get("placement", {}).get("cell_uid") != cell_uids[cell]:
                raise RuntimeError(f"{cell} authoritative placement differs")
            placements[cell] = {
                "cellUid": cell_uids[cell],
                "name": name,
                "objectId": object_value,
                "actorId": record["actor_id"],
                "values": [1],
            }

        for engine in engines.values():
            engine.start("/health")

        target = sorted(cells)[-1]
        target_actor = placements[target]["actorId"]
        runtime.request_json(
            "POST",
            f"{engines[target].base_url}/actors/{urllib.parse.quote(target_actor, safe='')}"
            f"/sleep?namespace={urllib.parse.quote(args.namespace, safe='')}",
            {},
        )
        sleep_state = runtime.wait_for_sleep(engines[target].base_url, target_actor, args.timeout)

        replacements[f"{target}:workerd-host"] = replace_one_pod(
            cell_clients[target],
            f"fleet.actor.dev/cell-name={target},fleet.actor.dev/component=workerd-host",
            args.host_replicas,
            args.timeout,
        )
        assert_counter(api, args.worker, placements[target]["name"], 2)
        placements[target]["values"].append(2)

        replacements["hub:workers-api"] = replace_one_pod(
            hub, "app.kubernetes.io/name=workers-api", args.workers_api_replicas, args.timeout
        )
        for cell in sorted(cells):
            expected = placements[cell]["values"][-1] + 1
            assert_counter(api, args.worker, placements[cell]["name"], expected)
            placements[cell]["values"].append(expected)

        replacements[f"{target}:engine-gateway"] = replace_one_pod(
            cell_clients[target],
            f"fleet.actor.dev/cell-name={target},fleet.actor.dev/component=engine",
            args.engine_replicas,
            args.timeout,
        )
        expected = placements[target]["values"][-1] + 1
        assert_counter(api, args.worker, placements[target]["name"], expected)
        placements[target]["values"].append(expected)

        stateless_cell = sorted(cells)[0]
        replacements[f"{stateless_cell}:stateless-executor"] = replace_one_pod(
            stateless_clients[stateless_cell],
            f"fleet.actor.dev/cell-name={stateless_cell},fleet.actor.dev/component=stateless-executor",
            args.stateless_replicas,
            args.timeout,
        )
        plain = dispatch(api, args.worker)
        if plain != {"plane": "stateless", "host": "fault-matrix.example"}:
            raise RuntimeError(f"stateless dispatch failed after executor replacement: {plain}")
        expected = placements[stateless_cell]["values"][-1] + 1
        assert_counter(api, args.worker, placements[stateless_cell]["name"], expected)
        placements[stateless_cell]["values"].append(expected)

        for cell, placement in placements.items():
            record = registry_record(registry_url, args.namespace, args.worker, placement["objectId"])
            if record.get("actor_id") != placement["actorId"]:
                raise RuntimeError(f"{cell} Actor identity changed after fault matrix")
            if record.get("placement", {}).get("cell_uid") != placement["cellUid"]:
                raise RuntimeError(f"{cell} placement changed after fault matrix")

        result = {
            "schema": "actor-cloud-stateless-do-fault-matrix/v1",
            "verdict": "passed",
            "worker": args.worker,
            "version": version["id"],
            "deployment": deployment["id"],
            "sleepWake": {
                "cell": target,
                "actorId": target_actor,
                "sleepTs": sleep_state["sleep_ts"],
                "wokeThroughPublicStatelessWorker": True,
            },
            "placements": placements,
            "replacements": replacements,
            "actorIdentityStable": True,
            "cellPlacementStable": True,
        }
    finally:
        for engine in engines.values():
            engine.stop()
        for path in object_paths:
            try:
                smoke.request("DELETE", path, expected=(204, 410))
            except Exception as error:
                cleanup_errors.append(str(error)[:512])
    if cleanup_errors:
        raise RuntimeError(f"fault-matrix cleanup failed: {cleanup_errors}")
    assert result is not None
    result["cleanup"] = {"objectsDeleted": len(object_paths), "workerRetained": True}
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--registry-endpoint", required=True)
    parser.add_argument("--hub-kubeconfig", required=True, type=pathlib.Path)
    parser.add_argument("--cell-kubeconfig", action="append", required=True)
    parser.add_argument("--hub-namespace", default="workers-api-system")
    parser.add_argument("--cell-namespace", default="actor-fdb-cell-system")
    parser.add_argument("--stateless-namespace", default="actor-stateless-system")
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--worker", default="qualification-stateless-do-routing")
    parser.add_argument("--compatibility-date", default="2026-08-14")
    parser.add_argument("--workers-api-replicas", type=int, default=3)
    parser.add_argument("--engine-replicas", type=int, default=6)
    parser.add_argument("--host-replicas", type=int, default=3)
    parser.add_argument("--stateless-replicas", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=720)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    args = parser.parse_args()
    result = run(args)
    smoke.publish(args.receipt, result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
