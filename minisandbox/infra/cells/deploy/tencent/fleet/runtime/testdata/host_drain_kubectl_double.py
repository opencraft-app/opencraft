#!/usr/bin/env python3
"""Strict local fixture for Host drain shell boundary tests; no network calls."""

import copy
import json
import os
from pathlib import Path
import sys

import yaml


def main():
    args = sys.argv[1:]
    root = Path(os.environ["DRAIN_TEST_ROOT"])
    with (root / "calls.ndjson").open("a") as output:
        output.write(json.dumps(args) + "\n")
    # All identity selectors in these tests are synthetic, not live credentials.
    while args and args[0] in ("--kubeconfig", "-n", "--namespace"):
        args = args[2:]
    state = root / "bundle.json"
    mode = os.environ.get("DRAIN_TEST_LIVE_MODE", "normal")
    if args[0] == "patch":
        assert args[1:3] == ["deployment", "actor-bj-a01-host-drain"]
        assert "--type=json" in args and "--patch-file" in args
        assert "--force-conflicts" not in args
        document = (next(item for item in json.loads(state.read_text())["items"] if item["kind"] == "Deployment")
                    if state.exists() else json.loads((root / "live.json").read_text()))
        if mode == "dry-run-failed" or mode == "patch-failed" and "--dry-run=server" not in args:
            return 1
        if "--dry-run=server" not in args:
            if mode == "patch-rv-conflict":
                document["metadata"]["resourceVersion"] = "43"
            elif mode == "patch-uid-replaced":
                document["metadata"]["uid"] = "replacement"
                document["metadata"]["resourceVersion"] = "43"
        patched = copy.deepcopy(document)
        for item in json.loads(Path(args[args.index("--patch-file") + 1]).read_text()):
            parts = [part.replace("~1", "/").replace("~0", "~") for part in item["path"].split("/")[1:]]
            target = patched
            for part in parts[:-1]:
                target = target[int(part)] if isinstance(target, list) else target[part]
            key = int(parts[-1]) if isinstance(target, list) else parts[-1]
            if item["op"] == "test":
                if target[key] != item["value"]:
                    return 1
            elif item["op"] in ("add", "replace"):
                target[key] = item["value"]
            elif item["op"] == "remove":
                del target[key]
            else:
                raise AssertionError("unexpected JSON patch operation")
        if "--dry-run=server" not in args:
            patched["metadata"]["resourceVersion"] = str(int(patched["metadata"]["resourceVersion"]) + 1)
            state.write_text(json.dumps({"apiVersion": "v1", "kind": "List", "items": [patched]}))
            if mode == "patch-response-lost":
                return 1
        return 0
    if args[0] in ("create", "apply"):
        raw = Path(args[args.index("-f") + 1]).read_text()
        items = [item for item in yaml.safe_load_all(raw) if item]
        if len(items) == 1 and items[0].get("kind") == "List":
            items = items[0]["items"]
        bundle = {"apiVersion": "v1", "kind": "List", "items": items}
        if args[0] == "create":
            assert "--dry-run=client" in args and "--validate=false" in args
            print(json.dumps(bundle))
        else:
            assert "--server-side" in args
            if "--dry-run=server" not in args:
                state.write_text(json.dumps(bundle))
        return 0
    if args[0] == "rollout":
        assert args[1:3] == ["status", "deployment/actor-bj-a01-host-drain"]
        if mode == "rollout-failed":
            return 1
        return 0
    if args[0] == "get":
        kind = args[1]
        if kind == "deployment":
            assert args[2] == "actor-bj-a01-host-drain"
            with (root / "events").open("a") as output:
                output.write("get-deployment\n")
            mode = os.environ.get("DRAIN_TEST_LIVE_MODE", "normal")
            if mode == "get-failed":
                return 1
            if state.exists():
                document = next(item for item in json.loads(state.read_text())["items"] if item["kind"] == "Deployment")
            else:
                document = json.loads((root / "live.json").read_text())
            if args[-1] == "json":
                if mode == "malformed":
                    print("not-json")
                    return 0
                document = copy.deepcopy(document)
                if mode == "timer-drift":
                    for item in document["spec"]["template"]["spec"]["containers"][0]["env"]:
                        if item["name"] == "HOST_DRAIN_TIMEOUT":
                            item["value"] = "1s"
                if state.exists() and mode == "final-uid-replaced":
                    document["metadata"]["uid"] = "replacement"
                if state.exists() and mode == "final-spec-drift":
                    document["spec"]["replicas"] = 2
                print(json.dumps(document))
            elif "runtime-release-hold-protocol" in args[-1]:
                print(document["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/runtime-release-hold-protocol"])
            elif "containers[0].image" in args[-1]:
                print(document["spec"]["template"]["spec"]["containers"][0]["image"])
            else:
                raise AssertionError("unexpected Deployment query")
            return 0
        if kind == "statefulset":
            assert args[2] == "actor-bj-a01-runtime-hosts"
            if "-o" in args:
                print("4 4 4")
            return 0
        if kind == "secret":
            assert args[2] in ("actor-fleet-tcr", "actor-bj-a01-runtime-auth")
            return 0
        if kind == "hpa":
            assert args[2] == "actor-bj-a01-runtime-hosts-actor-capacity"
            return 0
    raise AssertionError("unexpected fixture operation")


if __name__ == "__main__":
    sys.exit(main())
