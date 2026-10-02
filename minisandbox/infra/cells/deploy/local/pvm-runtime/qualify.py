#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import json
from pathlib import Path
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def request(
    base_url: str,
    host: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> tuple[int, Any]:
    body = None if payload is None else json.dumps(payload).encode()
    request_headers = {"Host": host, **(headers or {})}
    if body is not None:
        request_headers["content-type"] = "application/json"
    req = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=body,
        headers=request_headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = raw.decode(errors="replace")
        return error.code, parsed
    except (TimeoutError, urllib.error.URLError) as error:
        # A gateway connection can span the actor's cold-start window. Treat a
        # transport timeout as a retryable probe result instead of aborting the
        # qualification before its explicit deadline.
        return 599, {"transport_error": str(error)}


def wait_health(base_url: str, host: str, actor_id: str, deadline: float) -> dict[str, Any]:
    path = f"/gateway/{urllib.parse.quote(actor_id, safe='')}/health"
    last: Any = None
    while time.monotonic() < deadline:
        status, payload = request(base_url, host, "GET", path, timeout=10)
        last = {"status": status, "payload": payload}
        if (
            status == 200
            and isinstance(payload, dict)
            and payload.get("status") == "ok"
            and payload.get("platform") == "hermes-agent"
        ):
            return payload
        time.sleep(0.5)
    raise RuntimeError(f"Actor {actor_id} did not become healthy: {last!r}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Qualify PVM-backed Hermes Rivet Actors")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--api-key-file", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.concurrency < 2 or args.concurrency > 16:
        raise ValueError("--concurrency must be between 2 and 16")
    api_key = args.api_key_file.read_text().strip()
    if not api_key:
        raise ValueError("Hermes API key file is empty")

    actors: list[dict[str, str]] = []
    actors_lock = threading.Lock()
    started = time.monotonic()

    def create(index: int) -> dict[str, str]:
        cell = "local-runtime-a" if index % 2 == 0 else "local-runtime-b"
        host = "runtime-a.local" if cell.endswith("a") else "runtime-b.local"
        status, payload = request(
            args.base_url,
            host,
            "POST",
            "/actors?namespace=default",
            {
                "name": "hermes",
                "key": f"pvm-qualification-{time.time_ns()}-{index}",
                "runner_name_selector": "minisandbox-hermes-v1",
                "crash_policy": "restart",
                "datacenter": cell,
            },
            {"x-rivet-target": "api-public"},
        )
        if status not in (200, 201):
            raise RuntimeError(f"create in {cell} failed: HTTP {status}: {payload!r}")
        actor_id = payload.get("actor", {}).get("actor_id")
        if not isinstance(actor_id, str) or not actor_id:
            raise RuntimeError(f"create in {cell} returned no actor_id: {payload!r}")
        actor = {"actor_id": actor_id, "cell": cell, "create_host": host}
        # Record each successful creation before returning so a concurrent sibling
        # failure cannot bypass cleanup of actors already accepted by the API.
        with actors_lock:
            actors.append(actor)
        return actor

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            list(executor.map(create, range(args.concurrency)))

        def open_actor(actor: dict[str, str]) -> dict[str, Any]:
            opposite_host = (
                "runtime-b.local" if actor["create_host"] == "runtime-a.local" else "runtime-a.local"
            )
            before = time.monotonic()
            health = wait_health(args.base_url, opposite_host, actor["actor_id"], before + 240)
            models_status, models = request(
                args.base_url,
                opposite_host,
                "GET",
                f"/gateway/{urllib.parse.quote(actor['actor_id'], safe='')}/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=30,
            )
            if models_status != 200 or not isinstance(models, dict) or models.get("object") != "list":
                raise RuntimeError(
                    f"authenticated model probe failed for {actor['actor_id']}: "
                    f"HTTP {models_status}: {models!r}"
                )
            return {
                **actor,
                "route_host": opposite_host,
                "initial_open_ms": round((time.monotonic() - before) * 1000, 3),
                "health": health,
            }

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            records = list(executor.map(open_actor, actors))

        def sleep_actor(record: dict[str, Any]) -> None:
            status, payload = request(
                args.base_url,
                record["create_host"],
                "POST",
                f"/actors/{urllib.parse.quote(record['actor_id'], safe='')}/sleep?namespace=default",
                {},
                {"x-rivet-target": "api-public"},
            )
            if status not in (200, 202, 204):
                raise RuntimeError(
                    f"sleep failed for {record['actor_id']}: HTTP {status}: {payload!r}"
                )

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            list(executor.map(sleep_actor, records))

        def wake_actor(record: dict[str, Any]) -> dict[str, Any]:
            before = time.monotonic()
            wait_health(args.base_url, record["route_host"], record["actor_id"], before + 240)
            return {**record, "wake_ms": round((time.monotonic() - before) * 1000, 3)}

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            records = list(executor.map(wake_actor, records))

        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(
                {
                    "status": "passed",
                    "runner_name": "minisandbox-hermes-v1",
                    "actors": records,
                    "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
    finally:
        def destroy(actor: dict[str, str]) -> None:
            status, payload = request(
                args.base_url,
                actor["create_host"],
                "DELETE",
                f"/actors/{urllib.parse.quote(actor['actor_id'], safe='')}?namespace=default",
                headers={"x-rivet-target": "api-public"},
                timeout=30,
            )
            if status not in (200, 202, 204, 404):
                raise RuntimeError(
                    f"destroy failed for {actor['actor_id']}: HTTP {status}: {payload!r}"
                )
            gateway_path = (
                f"/gateway/{urllib.parse.quote(actor['actor_id'], safe='')}/health"
            )
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                gateway_status, _ = request(
                    args.base_url,
                    actor["create_host"],
                    "GET",
                    gateway_path,
                    timeout=10,
                )
                if gateway_status not in range(200, 300):
                    return
                time.sleep(0.25)
            raise RuntimeError(f"destroyed Actor {actor['actor_id']} remained reachable")

        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(actors))) as executor:
            list(executor.map(destroy, actors))


if __name__ == "__main__":
    main()
