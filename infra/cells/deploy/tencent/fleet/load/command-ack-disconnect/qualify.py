#!/usr/bin/env python3
"""Qualify ACK-of-ACK recovery on the real Host/Engine/FDB path."""

from __future__ import annotations

import argparse
import datetime
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.parse
import uuid


ROOT = pathlib.Path(__file__).resolve().parent
REPO = pathlib.Path(os.environ.get("MINISANDBOX_REPO", ROOT.parents[6]))
PLAN_PATH = "/tmp/rivet-command-ack-disconnect-plan.json"
PLAN_SCHEMA = "rivet-command-ack-disconnect-plan/v1"
FIRED_SCHEMA = "rivet-command-ack-disconnect-fired/v1"
BOUNDARY = "after_commit_before_barrier"
ACTOR_NAMESPACE = "default"
ENGINE_SELECTOR = "fleet.actor.dev/component=engine"
HOST_SELECTOR = "fleet.actor.dev/component=workerd-host"


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


def ready(pod: dict) -> bool:
    conditions = {
        condition.get("type"): condition.get("status")
        for condition in pod.get("status", {}).get("conditions", [])
    }
    statuses = pod.get("status", {}).get("containerStatuses", [])
    return (
        pod.get("metadata", {}).get("deletionTimestamp") is None
        and pod.get("status", {}).get("phase") == "Running"
        and conditions.get("Ready") == "True"
        and statuses
        and all(status.get("ready") for status in statuses)
    )


def listed_ready_pods(kube: runtime.Kubectl, selector: str) -> list[dict]:
    return [
        pod
        for pod in kube.json("get", "pods", "-l", selector).get("items", [])
        if ready(pod)
    ]


def container_identity(pod: dict, name: str) -> dict:
    containers = {
        container.get("name"): container
        for container in pod.get("spec", {}).get("containers", [])
    }
    statuses = {
        status.get("name"): status
        for status in pod.get("status", {}).get("containerStatuses", [])
    }
    container = containers.get(name)
    status = statuses.get(name)
    if not isinstance(container, dict) or not isinstance(status, dict):
        raise RuntimeError(f"Pod lacks the required {name} container identity")
    image = container.get("image")
    image_id = status.get("imageID")
    if not isinstance(image, str) or not image or not isinstance(image_id, str) or not image_id:
        raise RuntimeError(f"Pod exposes an incomplete {name} container identity")
    return {"image": image, "imageId": image_id}


def kubectl_input(kube: runtime.Kubectl, data: str, *args: str, timeout: float = 30) -> str:
    result = subprocess.run(
        kube.command(*args),
        input=data,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if result.returncode:
        raise RuntimeError(
            f"{' '.join(kube.command(*args))} failed: {result.stderr.strip()}"
        )
    return result.stdout


def registry_record(registry: str, worker: str, object_id: str) -> dict:
    _, record = smoke.request(
        "GET",
        f"{registry.rstrip('/')}/internal/v1/namespaces/{ACTOR_NAMESPACE}"
        f"/workers/{worker}/objects/{smoke.CLASS_NAME}/{object_id}",
    )
    return record


def dispatch_counter(api: str, worker: str, name: str) -> int:
    _, payload = smoke.request(
        "POST",
        f"{api}/workers/{worker}/dispatch",
        headers={
            "X-Workers-Original-URL": "https://command-ack.example/counter?"
            + urllib.parse.urlencode({"name": name})
        },
    )
    value = payload.get("value") if isinstance(payload, dict) else None
    if not isinstance(value, int):
        raise RuntimeError(f"Counter returned an invalid response: {payload}")
    return value


def exec_registry_resolve(kube: runtime.Kubectl, pod: str, actor_id: str) -> dict:
    body = json.dumps({"actor_ids": [actor_id]}, separators=(",", ":"))
    output = kube.run(
        "exec",
        pod,
        "-c",
        "workerd-host",
        "--",
        "bash",
        "-ec",
        'curl --fail --silent --show-error -H "content-type: application/json" '
        '-H "x-rivet-workerd-token: $RIVET_WORKERD_TOKEN" '
        "--data \"$1\" http://127.0.0.1:18081/v1/sqlite/registry-resolve",
        "_",
        body,
    )
    return json.loads(output)


def parse_timestamped_line(line: str) -> tuple[datetime.datetime | None, str]:
    prefix, separator, body = line.partition(" ")
    if not separator:
        return None, line
    try:
        return datetime.datetime.fromisoformat(prefix.replace("Z", "+00:00")), body
    except ValueError:
        return None, line


def structured_fields(line: str) -> dict:
    _, body = parse_timestamped_line(line)
    try:
        value = json.loads(body)
    except json.JSONDecodeError:
        return {}
    if not isinstance(value, dict):
        return {}
    fields = value.get("fields")
    if isinstance(fields, dict):
        return fields
    return value


def line_has_event(
    line: str,
    message: str,
    actor_id: str,
    generation: int,
    index: int,
    command_kind: str | None = None,
) -> bool:
    fields = structured_fields(line)
    if fields:
        if fields.get("message") != message:
            return False
        if str(fields.get("actor_id")) != actor_id:
            return False
        if int(fields.get("generation", -1)) != generation:
            return False
        if int(fields.get("index", -1)) != index:
            return False
        return command_kind is None or fields.get("command_kind") == command_kind
    if message not in line or actor_id not in line:
        return False
    required = [f"generation={generation}", f"index={index}"]
    if command_kind is not None:
        if not re.search(
            rf"command_kind=(?:\"|')?{re.escape(command_kind)}(?:\"|')?",
            line,
        ):
            return False
    return all(value in line for value in required)


def extract_envoy_key(
    lines: str, message: str, expected_key: str | None = None
) -> tuple[datetime.datetime, str] | None:
    matches = []
    patterns = (
        re.compile(r'"envoy_key"\s*:\s*"([A-Za-z0-9_-]{3,128})"'),
        re.compile(r"envoy_key=([A-Za-z0-9_-]{3,128})"),
        re.compile(r"envoy_key\s*=\s*([A-Za-z0-9_-]{3,128})"),
    )
    for line in lines.splitlines():
        if message not in line:
            continue
        timestamp, _ = parse_timestamped_line(line)
        if timestamp is None:
            continue
        fields = structured_fields(line)
        key = fields.get("envoy_key") if fields else None
        if not isinstance(key, str):
            key = next((match.group(1) for pattern in patterns if (match := pattern.search(line))), None)
        if isinstance(key, str) and (expected_key is None or key == expected_key):
            matches.append((timestamp, key))
    return max(matches) if matches else None


def resolve_host(kube: runtime.Kubectl, cell: str, actor_id: str) -> dict:
    pods = listed_ready_pods(
        kube, f"fleet.actor.dev/cell-name={cell},{HOST_SELECTOR}"
    )
    matches = []
    for pod in pods:
        name = pod["metadata"]["name"]
        payload = exec_registry_resolve(kube, name, actor_id)
        entries = payload.get("actors", [])
        if len(entries) != 1:
            raise RuntimeError(f"Host {name} returned an invalid registry resolve payload")
        entry = entries[0]
        host_generation = entry.get("host_generation")
        bridge_generation = entry.get("bridge_generation")
        if host_generation is not None or bridge_generation is not None:
            if not isinstance(host_generation, int) or host_generation != bridge_generation:
                raise RuntimeError(f"Host {name} exposed a split actor/storage generation")
            logs = kube.run(
                "logs", name, "-c", "workerd-host", "--timestamps=true", timeout=60
            )
            connected = extract_envoy_key(logs, "workerd envoy host connected")
            if connected is None:
                raise RuntimeError(f"Host {name} has no parseable Envoy identity log")
            matches.append(
                {
                    "pod": name,
                    "podUid": pod["metadata"]["uid"],
                    **container_identity(pod, "workerd-host"),
                    "generation": host_generation,
                    "envoyKey": connected[1],
                    "envoyStartedAt": connected[0].isoformat(),
                }
            )
    if len(matches) != 1:
        raise RuntimeError(f"Actor must be active on exactly one Host, observed {matches}")
    return matches[0]


def resolve_engine(kube: runtime.Kubectl, cell: str, envoy_key: str) -> dict:
    matches = []
    pods = listed_ready_pods(
        kube, f"fleet.actor.dev/cell-name={cell},{ENGINE_SELECTOR}"
    )
    for pod in pods:
        name = pod["metadata"]["name"]
        logs = kube.run("logs", name, "-c", "engine", "--timestamps=true", timeout=60)
        connected = extract_envoy_key(
            logs, "envoy websocket connection ready", expected_key=envoy_key
        )
        if connected is not None:
            matches.append((connected[0], pod))
    if not matches:
        raise RuntimeError(f"no Engine Pod owns the current Envoy connection {envoy_key}")
    connected_at, pod = max(matches, key=lambda item: item[0])
    return {
        "pod": pod["metadata"]["name"],
        "podUid": pod["metadata"]["uid"],
        **container_identity(pod, "engine"),
        "connectedAt": connected_at.isoformat(),
    }


def arm_plan(
    kube: runtime.Kubectl,
    pod: str,
    nonce: str,
    envoy_key: str,
    actor_id: str,
    generation: int,
) -> tuple[str, str, str]:
    receipt_path = f"/tmp/rivet-command-ack-disconnect-{nonce}.fired.json"
    claimed_path = f"/tmp/rivet-command-ack-disconnect-{nonce}.claimed.json"
    temporary_path = f"/tmp/rivet-command-ack-disconnect-{nonce}.fired.tmp"
    plan = json.dumps(
        {
            "schema": PLAN_SCHEMA,
            "nonce": nonce,
            "envoy_key": envoy_key,
            "actor_id": actor_id,
            "generation": generation,
            "index": None,
            "boundary": BOUNDARY,
        },
        separators=(",", ":"),
    )
    kubectl_input(
        kube,
        plan,
        "exec",
        "-i",
        pod,
        "-c",
        "engine",
        "--",
        "bash",
        "-ec",
        f"umask 077; test ! -e {PLAN_PATH}; test ! -e {receipt_path}; "
        f"test ! -e {claimed_path}; test ! -e {temporary_path}; cat > {PLAN_PATH}",
    )
    return receipt_path, claimed_path, temporary_path


def remove_remote(kube: runtime.Kubectl, pod: str, path: str) -> None:
    if not re.fullmatch(
        r"/tmp/rivet-command-ack-disconnect[-a-z0-9.]*(?:\.json|\.tmp)", path
    ):
        raise ValueError("refusing to remove an unexpected remote path")
    kube.run("exec", pod, "-c", "engine", "--", "rm", "-f", "--", path)


def read_when_present(
    kube: runtime.Kubectl, pod: str, path: str, timeout: float
) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = subprocess.run(
            kube.command("exec", pod, "-c", "engine", "--", "cat", path),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
        time.sleep(0.1)
    raise TimeoutError(f"fault receipt did not appear on Engine Pod {pod}")


def wait_for_host_evidence(
    kube: runtime.Kubectl,
    host: dict,
    actor_id: str,
    fired: dict,
    since_time: str,
    timeout: float,
) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        logs = kube.run(
            "logs",
            host["pod"],
            "-c",
            "workerd-host",
            f"--since-time={since_time}",
            "--timestamps=true",
            timeout=60,
        )
        generation = int(fired["generation"])
        index = int(fired["index"])
        processed = [
            line
            for line in logs.splitlines()
            if line_has_event(
                line,
                "processed durable command",
                actor_id,
                generation,
                index,
                "stop",
            )
        ]
        replayed = [
            line
            for line in logs.splitlines()
            if line_has_event(
                line,
                "replayed unconfirmed command ACK on replacement websocket session",
                actor_id,
                generation,
                index,
            )
        ]
        confirmed = [
            line
            for line in logs.splitlines()
            if line_has_event(
                line,
                "command ACK commit barrier confirmed",
                actor_id,
                generation,
                index,
            )
        ]
        skipped = [
            line
            for line in logs.splitlines()
            if line_has_event(
                line,
                "skipping replayed command",
                actor_id,
                generation,
                index,
                "stop",
            )
        ]
        last = {
            "processedSideEffects": len(processed),
            "ackReplays": len(replayed),
            "commitBarriers": len(confirmed),
            "commandsDeduplicated": len(skipped),
        }
        if len(processed) == 1 and replayed and confirmed:
            return last
        if len(processed) > 1:
            raise RuntimeError(f"Stop command produced duplicate side effects: {last}")
        time.sleep(0.25)
    raise TimeoutError(f"Host did not prove ACK replay and commit barrier: {last}")


def reconciliation_footprint(engine_url: str, envoy_key: str) -> dict:
    query = urllib.parse.urlencode(
        {
            "scope": "reconciliation",
            "namespace": ACTOR_NAMESPACE,
            "envoy_key": envoy_key,
            "limit": 1000,
        }
    )
    value = runtime.request_json(
        "GET", f"{engine_url}/depot/inspect/footprint?{query}", timeout=30
    )
    if value.get("scope") != f"reconciliation:{envoy_key}":
        raise RuntimeError("Engine returned the wrong reconciliation footprint scope")
    if value.get("next_cursor") is not None:
        raise RuntimeError("command backlog unexpectedly exceeded one bounded footprint page")
    return value


def wait_for_backlog_zero(engine_url: str, envoy_key: str, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = reconciliation_footprint(engine_url, envoy_key)
        if last.get("row_count") == 0:
            return last
        time.sleep(0.25)
    raise TimeoutError(f"durable command backlog did not drain: {last}")


def run(args) -> dict:
    api = args.endpoint.rstrip("/") + "/v1"
    registry = args.registry_endpoint.rstrip("/")
    kube = runtime.Kubectl(args.cell_kubeconfig, args.cell_namespace)
    engine = runtime.PortForward(kube, f"service/{args.cell}-engine", 6420)
    cell_uids = smoke.ready_cell_uids(args.hub_kubeconfig, set(args.all_cell))
    if args.cell not in cell_uids:
        raise RuntimeError("target Cell is not placement-ready")
    selected = smoke.names_for_cells(ACTOR_NAMESPACE, args.worker, cell_uids)
    name, object_id = selected[args.cell]
    object_path = f"{api}/workers/{args.worker}/objects/{smoke.CLASS_NAME}/{object_id}"
    armed: list[tuple[str, str]] = []
    cleanup_errors: list[str] = []
    result = None
    counter = 0
    try:
        _, version = smoke.request(
            "POST",
            f"{api}/workers/{args.worker}/versions",
            {
                "main_module": "main.js",
                "modules": {"main.js": smoke.WORKER_SOURCE},
                "compatibility_date": args.compatibility_date,
                "durable_objects": {"COUNTER": smoke.CLASS_NAME},
            },
        )
        _, deployment = smoke.request(
            "POST",
            f"{api}/workers/{args.worker}/deployments",
            {"version_id": version["id"]},
        )
        counter = dispatch_counter(api, args.worker, name)
        if counter != 1:
            raise RuntimeError(f"initial Counter value differs: {counter}")
        record = registry_record(registry, args.worker, object_id)
        actor_id = record.get("actor_id")
        if (
            not isinstance(actor_id, str)
            or record.get("placement", {}).get("cell_uid") != cell_uids[args.cell]
        ):
            raise RuntimeError("Registry did not bind the qualification Object to the target Cell")

        engine.start("/health")
        host = resolve_host(kube, args.cell, actor_id)
        engine_owner = resolve_engine(kube, args.cell, host["envoyKey"])
        nonce = f"{args.run_id}-{uuid.uuid4().hex[:8]}"
        since_time = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        receipt_path, claimed_path, temporary_path = arm_plan(
            kube,
            engine_owner["pod"],
            nonce,
            host["envoyKey"],
            actor_id,
            host["generation"],
        )
        armed.append((engine_owner["pod"], PLAN_PATH))
        armed.append((engine_owner["pod"], receipt_path))
        armed.append((engine_owner["pod"], claimed_path))
        armed.append((engine_owner["pod"], temporary_path))

        runtime.request_json(
            "POST",
            f"{engine.base_url}/actors/{urllib.parse.quote(actor_id, safe='')}"
            f"/sleep?namespace={ACTOR_NAMESPACE}",
            {},
            timeout=30,
        )
        fired = read_when_present(
            kube, engine_owner["pod"], receipt_path, args.timeout
        )
        expected_fired = {
            "schema": FIRED_SCHEMA,
            "nonce": nonce,
            "envoyKey": host["envoyKey"],
            "actorId": actor_id,
            "generation": host["generation"],
            "boundary": BOUNDARY,
        }
        for key, expected in expected_fired.items():
            if fired.get(key) != expected:
                raise RuntimeError(f"fault receipt field {key} differs: {fired}")
        if not isinstance(fired.get("index"), int):
            raise RuntimeError("fault receipt lacks the exact command checkpoint index")

        sleep_state = runtime.wait_for_sleep(engine.base_url, actor_id, args.timeout)
        host_evidence = wait_for_host_evidence(
            kube, host, actor_id, fired, since_time, args.timeout
        )
        backlog = wait_for_backlog_zero(
            engine.base_url, host["envoyKey"], args.timeout
        )

        counter = dispatch_counter(api, args.worker, name)
        if counter != 2:
            raise RuntimeError(f"Counter did not recover after ACK disconnect: {counter}")
        recovered_record = registry_record(registry, args.worker, object_id)
        if (
            recovered_record.get("actor_id") != actor_id
            or recovered_record.get("placement", {}).get("cell_uid") != cell_uids[args.cell]
        ):
            raise RuntimeError("Actor identity or immutable Cell placement changed after recovery")

        result = {
            "schema": "actor-command-ack-disconnect-qualification/v1",
            "verdict": "passed",
            "runId": args.run_id,
            "worker": args.worker,
            "version": version["id"],
            "deployment": deployment["id"],
            "cell": args.cell,
            "cellUid": cell_uids[args.cell],
            "actorId": actor_id,
            "objectId": object_id,
            "host": host,
            "engine": engine_owner,
            "fault": fired,
            "hostEvidence": host_evidence,
            "sleepTs": sleep_state.get("sleep_ts"),
            "reconciliationBacklog": {
                "rows": backlog["row_count"],
                "pageSha256": backlog["page_sha256"],
            },
            "counterValues": [1, 2],
            "actorIdentityStable": True,
            "cellPlacementStable": True,
        }
    finally:
        engine.stop()
        for pod, path in armed:
            try:
                remove_remote(kube, pod, path)
            except Exception as exc:
                cleanup_errors.append(f"failed to remove {path} from {pod}: {exc}")
        try:
            smoke.request("DELETE", object_path, expected=(204, 410))
        except Exception as exc:
            cleanup_errors.append(f"failed to delete qualification Object: {exc}")
    if result is None:
        raise RuntimeError("ACK disconnect qualification produced no result")
    if cleanup_errors:
        raise RuntimeError("; ".join(cleanup_errors))
    result["cleanup"] = {"objectDeleted": True, "faultFilesRemoved": True, "workerRetained": True}
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--registry-endpoint", required=True)
    parser.add_argument("--hub-kubeconfig", required=True, type=pathlib.Path)
    parser.add_argument("--cell-kubeconfig", required=True, type=pathlib.Path)
    parser.add_argument("--cell", required=True)
    parser.add_argument("--all-cell", action="append", required=True)
    parser.add_argument("--cell-namespace", default="actor-fdb-cell-system")
    parser.add_argument("--worker", required=True)
    parser.add_argument("--compatibility-date", default="2026-08-14")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{32}", args.run_id):
        parser.error("--run-id must be 32 lowercase hexadecimal characters")
    if len(set(args.all_cell)) < 2 or args.cell not in set(args.all_cell):
        parser.error("--all-cell must contain the target and at least one peer Cell")
    result = run(args)
    smoke.publish(args.receipt, result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
