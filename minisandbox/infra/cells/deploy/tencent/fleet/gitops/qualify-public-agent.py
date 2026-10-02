#!/usr/bin/env python3
"""Qualify the user-facing Agent path through only the public Workers /v1 API."""

import argparse
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


WORKER = "public-agent-e2e"
CLASS_NAME = "Agent"
COMPATIBILITY_DATE = "2026-08-14"
SOURCE = r'''
import { DurableObject } from "cloudflare:workers";

export class Agent extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const sequence = (await this.ctx.storage.get("sequence")) ?? 0;
    const messages = (await this.ctx.storage.get("messages")) ?? [];
    if (url.pathname === "/memory") {
      return Response.json({ sequence, messages });
    }
    if (url.pathname !== "/message") {
      return new Response("not found", { status: 404 });
    }
    const input = await request.json();
    if (typeof input.id !== "string" || typeof input.text !== "string") {
      return Response.json({ error: "invalid message" }, { status: 400 });
    }
    const prior = await this.ctx.storage.get("request:" + input.id);
    if (prior !== undefined) {
      return Response.json({ sequence: prior, messages, duplicate: true });
    }
    const next = sequence + 1;
    const nextMessages = [...messages, input.text].slice(-16);
    await this.ctx.storage.put("sequence", next);
    await this.ctx.storage.put("messages", nextMessages);
    await this.ctx.storage.put("request:" + input.id, next);
    return Response.json({ sequence: next, messages: nextMessages, duplicate: false });
  }
}

export default { fetch() { return new Response("ready"); } };
'''.strip()


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class PortForward:
    def __init__(self, kubeconfig):
        self.port = free_port()
        self.endpoint = f"http://127.0.0.1:{self.port}"
        self.process = subprocess.Popen(
            (
                "kubectl", "--kubeconfig", str(kubeconfig), "-n", "workers-api-system",
                "port-forward", "service/workers-api", f"{self.port}:8080",
            ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )

    def wait(self, timeout=30):
        deadline = time.monotonic() + timeout
        last = "not reachable"
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                detail = self.process.stderr.read().strip() if self.process.stderr else ""
                raise RuntimeError(f"port-forward exited: {detail}")
            try:
                with urllib.request.urlopen(self.endpoint + "/readyz", timeout=1) as response:
                    if response.status == 200:
                        return
            except Exception as error:  # bounded readiness polling
                last = str(error)
            time.sleep(0.1)
        raise TimeoutError(f"Workers API port-forward did not become ready: {last}")

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


def request(method, url, body=None, expected=(200, 201), original_url=None):
    encoded = None if body is None else json.dumps(body).encode()
    headers = {}
    if encoded is not None:
        headers["content-type"] = "application/json"
    if original_url is not None:
        headers["X-Workers-Original-URL"] = original_url
    req = urllib.request.Request(url, data=encoded, method=method, headers=headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            payload = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        payload = error.read()
        status = error.code
    elapsed = time.monotonic() - started
    if status not in expected:
        raise RuntimeError(
            f"{method} {url} returned HTTP {status}: {payload.decode(errors='replace')}"
        )
    value = None if not payload else json.loads(payload)
    if value is not None and not isinstance(value, dict):
        raise ValueError(f"{method} {url} did not return a JSON object")
    return status, value, elapsed


def publish_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def assert_message(value, sequence, messages, duplicate):
    if value != {"sequence": sequence, "messages": messages, "duplicate": duplicate}:
        raise ValueError(f"unexpected Agent response: {value!r}")


def run(endpoint, operation_id):
    object_id = hashlib.sha256(f"{WORKER}\0{operation_id}".encode()).hexdigest()
    base = f"{endpoint.rstrip('/')}/v1/workers/{WORKER}"
    timings = {}
    _, version, timings["version_seconds"] = request(
        "POST", base + "/versions",
        {
            "main_module": "main.js",
            "modules": {"main.js": SOURCE},
            "compatibility_date": COMPATIBILITY_DATE,
            "durable_objects": {"AGENT": CLASS_NAME},
        },
    )
    if version is None or not isinstance(version.get("id"), str):
        raise ValueError("Workers API returned no stable Version identity")
    _, deployment, timings["deployment_seconds"] = request(
        "POST", base + "/deployments", {"version_id": version["id"]}
    )
    if deployment is None or not isinstance(deployment.get("id"), str):
        raise ValueError("Workers API returned no stable Deployment identity")
    object_path = f"{base}/objects/{CLASS_NAME}/{object_id}"
    _, object_ref, timings["create_seconds"] = request("PUT", object_path)
    if object_ref is None or object_ref.get("id") != object_id:
        raise ValueError("Workers API returned the wrong ObjectRef")

    _, first, timings["first_message_seconds"] = request(
        "POST", object_path + "/fetch", {"id": "request-1", "text": "alpha"},
        expected=(200,), original_url="https://agent.example/message",
    )
    assert_message(first, 1, ["alpha"], False)
    _, duplicate, timings["idempotent_retry_seconds"] = request(
        "POST", object_path + "/fetch", {"id": "request-1", "text": "ignored"},
        expected=(200,), original_url="https://agent.example/message",
    )
    assert_message(duplicate, 1, ["alpha"], True)
    _, second, timings["second_message_seconds"] = request(
        "POST", object_path + "/fetch", {"id": "request-2", "text": "beta"},
        expected=(200,), original_url="https://agent.example/message",
    )
    assert_message(second, 2, ["alpha", "beta"], False)
    _, third, timings["third_message_seconds"] = request(
        "POST", object_path + "/fetch", {"id": "request-3", "text": "gamma"},
        expected=(200,), original_url="https://agent.example/message",
    )
    assert_message(third, 3, ["alpha", "beta", "gamma"], False)
    _, memory, timings["memory_read_seconds"] = request(
        "POST", object_path + "/fetch", expected=(200,),
        original_url="https://agent.example/memory",
    )
    if memory != {"sequence": 3, "messages": ["alpha", "beta", "gamma"]}:
        raise ValueError(f"persistent Agent memory differs: {memory!r}")

    status, _, timings["delete_seconds"] = request(
        "DELETE", object_path, expected=(204,)
    )
    retry_status, _, timings["delete_retry_seconds"] = request(
        "DELETE", object_path, expected=(204,)
    )
    gone_status, _, timings["deleted_fetch_seconds"] = request(
        "POST", object_path + "/fetch", expected=(410,),
        original_url="https://agent.example/memory",
    )
    return {
        "schema": "actor-public-agent-e2e/v1",
        "verdict": "passed",
        "completed_at": utc_now(),
        "operation_id": operation_id,
        "worker": WORKER,
        "version_id": version["id"],
        "deployment_id": deployment["id"],
        "object_id": object_id,
        "conversation": {
            "sequence": 3,
            "memory_sha256": "sha256:" + hashlib.sha256(b'["alpha","beta","gamma"]').hexdigest(),
            "idempotent_retry": True,
        },
        "cleanup": {
            "delete_status": status,
            "idempotent_delete_status": retry_status,
            "fetch_after_delete_status": gone_status,
        },
        "timings": timings,
    }


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--endpoint")
    source.add_argument("--kubeconfig", type=pathlib.Path)
    parser.add_argument("--operation-id", required=True)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if (
        len(args.operation_id) != 32
        or any(character not in "0123456789abcdef" for character in args.operation_id)
    ):
        parser.error("--operation-id must be 32 lowercase hexadecimal characters")
    if not args.receipt.is_absolute() or args.receipt.exists():
        parser.error("--receipt must be a new absolute path")
    if args.kubeconfig is not None and not args.kubeconfig.is_file():
        parser.error("--kubeconfig must be a regular file")

    forward = None
    endpoint = args.endpoint
    try:
        if args.kubeconfig is not None:
            forward = PortForward(args.kubeconfig)
            forward.wait()
            endpoint = forward.endpoint
        assert endpoint is not None
        receipt = run(endpoint, args.operation_id)
        publish_new(args.receipt, receipt)
        print(json.dumps({"publicAgentE2E": "passed", "receipt": str(args.receipt)}, sort_keys=True))
    finally:
        if forward is not None:
            forward.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
