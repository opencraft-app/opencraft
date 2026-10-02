#!/usr/bin/env python3
"""Prove one public Durable Object survives sleep and Host replacement."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[5]
BASE_RUNNER = REPO / "infra/cells/deploy/local/mesh/workerd-persistent-code-e2e/run.py"
NAMESPACE = "actor-fdb-cell-system"


def load_helpers():
    spec = importlib.util.spec_from_file_location("persistent_e2e", BASE_RUNNER)
    if spec is None or spec.loader is None:
        raise RuntimeError("persistent E2E helpers are unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = load_helpers()

SOURCE = r'''
import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async fetch(request) {
    const value = ((await this.ctx.storage.get("value")) ?? 0) + 1;
    await this.ctx.storage.put("value", value);
    return Response.json({value, origin: new URL(request.url).origin});
  }
}
export default { fetch() { return new Response("ready"); } };
'''.strip()


def digest(*parts):
    value = hashlib.sha256()
    for part in parts:
        value.update(part.encode())
        value.update(b"\0")
    return value.hexdigest()


def request(method, url, body=None, expected=(200, 201, 204)):
    encoded = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=encoded, method=method)
    if encoded is not None:
        req.add_header("content-type", "application/json")
    req.add_header("x-workers-original-url", "https://counter.example/increment")
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            status, payload = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, payload = error.code, error.read()
    if status not in expected:
        raise RuntimeError("{} {} returned HTTP {}: {}".format(
            method, url, status, payload.decode(errors="replace")
        ))
    return status, json.loads(payload) if payload else None


def publish(path, value):
    if not path.is_absolute() or path.exists():
        raise ValueError("receipt must be a new absolute path")
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(".{}.{}.tmp".format(path.name, os.getpid()))
    staged.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    with staged.open("rb") as stream:
        os.fsync(stream.fileno())
    os.link(str(staged), str(path))
    staged.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True, type=Path)
    parser.add_argument("--cell", required=True)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--timeout", type=float, default=420)
    args = parser.parse_args()
    runtime = base.Kubectl(args.kubeconfig, NAMESPACE)
    api = base.PortForward(runtime, "service/{}-workers-api".format(args.cell), 8080)
    engine = base.PortForward(runtime, "service/{}-engine".format(args.cell), 6420)
    object_id = digest(args.worker, "counter-host-replacement", str(time.time()))
    actor_id = None
    deleted = False
    try:
        api.start("/readyz")
        engine.start("/health")
        endpoint = api.base_url + "/v1/workers/" + urllib.parse.quote(args.worker, safe="")
        _, version = request("POST", endpoint + "/versions", {
            "main_module": "main.js",
            "modules": {"main.js": SOURCE},
            "compatibility_date": "2026-08-14",
            "durable_objects": {"COUNTER": "Counter"},
        })
        _, deployment = request("POST", endpoint + "/deployments", {"version_id": version["id"]})
        object_path = endpoint + "/objects/Counter/" + object_id
        request("PUT", object_path)
        _, first = request("POST", object_path + "/fetch")
        if first != {"value": 1, "origin": "https://counter.example"}:
            raise RuntimeError("first Counter response differs: {}".format(first))
        actor_name = "mf-" + digest(args.worker, "Counter")[:24]
        query = urllib.parse.urlencode({"namespace": "default", "name": actor_name, "key": object_id})
        actors = base.request_json("GET", engine.base_url + "/actors?" + query)["actors"]
        if len(actors) != 1:
            raise RuntimeError("expected one logical Counter Actor: {}".format(actors))
        actor_id = actors[0]["actor_id"]
        base.request_json("POST", engine.base_url + "/actors/{}/sleep?namespace=default".format(
            urllib.parse.quote(actor_id, safe="")
        ), {})
        sleep = base.wait_for_sleep(engine.base_url, actor_id, args.timeout)
        pods = runtime.json("get", "pods", "-l", "fleet.actor.dev/cell-name={},fleet.actor.dev/component=workerd-host".format(args.cell)).get("items", [])
        ready = sorted((pod for pod in pods if base.ready(pod)), key=lambda pod: pod["metadata"]["name"])
        if len(ready) != 3:
            raise RuntimeError("qualification requires exactly three Ready Hosts")
        victim = ready[0]
        pod_name, old_uid = victim["metadata"]["name"], victim["metadata"]["uid"]
        runtime.run("delete", "pod", pod_name, "--wait=false")
        new_uid = base.wait_for_host_replacement(runtime, pod_name, old_uid, args.timeout)
        _, second = request("POST", object_path + "/fetch")
        _, third = request("POST", object_path + "/fetch")
        if [second.get("value"), third.get("value")] != [2, 3]:
            raise RuntimeError("Counter state did not survive replacement: {} {}".format(second, third))
        after = base.request_json("GET", engine.base_url + "/actors?" + query)["actors"]
        if len(after) != 1 or after[0]["actor_id"] != actor_id:
            raise RuntimeError("logical Actor identity changed after Host replacement")
        request("DELETE", object_path, expected=(204,))
        request("DELETE", object_path, expected=(204,))
        deleted = True
        result = {
            "schema": "actor-counter-host-replacement/v1",
            "verdict": "passed",
            "cell": args.cell,
            "worker": args.worker,
            "versionId": version["id"],
            "deploymentId": deployment["id"],
            "objectId": object_id,
            "actorId": actor_id,
            "counterValues": [1, 2, 3],
            "sleepTs": sleep["sleep_ts"],
            "hostPod": pod_name,
            "oldPodUid": old_uid,
            "newPodUid": new_uid,
            "actorIdentityStable": True,
            "objectDeleteIdempotent": True,
        }
        publish(args.receipt, result)
        print(json.dumps(result, sort_keys=True))
    finally:
        if actor_id and not deleted and engine.process is not None:
            try:
                base.request_json("DELETE", engine.base_url + "/actors/{}?namespace=default".format(
                    urllib.parse.quote(actor_id, safe="")
                ))
            except Exception:
                pass
        engine.stop()
        api.stop()


if __name__ == "__main__":
    main()
