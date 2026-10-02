#!/usr/bin/env python3
"""Build a fail-closed Cell admission plan from an autonomy control receipt."""

import argparse
import hashlib
import importlib.util
import json
import re
from pathlib import Path


SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _load_capture():
    path = Path(__file__).resolve().parent.parent / "runtime" / "capture_release_binding.py"
    spec = importlib.util.spec_from_file_location("actor_release_binding", path)
    if spec is None or spec.loader is None:
        raise ValueError("runtime release binding verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.capture


def _same_release(left, right):
    fields = ("runtime_image", "runtime_digest", "manifest_sha256")
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    return all(left.get(field) == right.get(field) for field in fields)


def plan(control_path, deployment, statefulset, pods):
    control_path = Path(control_path).resolve()
    control_bytes = control_path.read_bytes()
    control_sha = hashlib.sha256(control_bytes).hexdigest()
    control = json.loads(control_bytes)
    if control.get("schemaVersion") != "actor-fdb-autonomy-control-v1":
        raise ValueError("control receipt schema mismatch")
    if control.get("control") != "allow" or control.get("verdict") != "passed":
        raise ValueError("only a passing autonomy allow receipt may open placement")
    if control.get("failures") != [] or control.get("warnings") != []:
        raise ValueError("allow receipt contains failures or warnings")
    cell = control.get("cell")
    namespace = control.get("namespace")
    if not isinstance(cell, str) or not cell or not isinstance(namespace, str) or not namespace:
        raise ValueError("control receipt Cell identity is incomplete")

    source_path = control.get("source_receipt")
    source_sha = control.get("source_receipt_sha256")
    if not isinstance(source_path, str) or not Path(source_path).is_absolute():
        raise ValueError("control source receipt path is invalid")
    if not isinstance(source_sha, str) or SHA256.fullmatch(source_sha) is None:
        raise ValueError("control source receipt digest is invalid")
    source_bytes = Path(source_path).read_bytes()
    if hashlib.sha256(source_bytes).hexdigest() != source_sha:
        raise ValueError("control source receipt digest mismatch")
    audit = json.loads(source_bytes)
    if audit.get("schemaVersion") != "actor-fdb-autonomy-audit-v1" or audit.get("verdict") != "passed":
        raise ValueError("source audit is not a passing autonomy audit")
    if audit.get("cell") != cell or audit.get("namespace") != namespace:
        raise ValueError("source audit Cell identity mismatch")
    if audit.get("failures") != [] or audit.get("warnings") != []:
        raise ValueError("source audit contains failures or warnings")
    if audit.get("sourceIdentity") != control.get("sourceIdentity"):
        raise ValueError("control receipt changed the reviewed source identity")

    capture = _load_capture()
    live = capture(deployment, statefulset, pods, dynamic_runtime_capacity=True)
    if live.get("runtime_desired_replicas") != live.get("runtime_ready_replicas"):
        raise ValueError("runtime capacity is changing during qualification activation")
    audited = audit.get("evidence", {}).get("current_release_binding")
    if not _same_release(audited, live):
        raise ValueError("live runtime release no longer matches the audited release")
    runtime_digest = live.get("runtime_digest")
    if not isinstance(runtime_digest, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", runtime_digest) is None:
        raise ValueError("audited runtime digest is invalid")

    cache_name = "actor-evidence-{}-{}".format(cell, control_sha[:20])
    return {
        "schema": "actor-cell-qualification-activation-plan/v1",
        "cell": cell,
        "namespace": namespace,
        "control_receipt_sha256": control_sha,
        "source_receipt_sha256": source_sha,
        "release_binding": live,
        "qualification": {
            "ready": True,
            "receipt_ref": "kubernetes://{}/configmaps/{}?sha256={}".format(
                namespace, cache_name, control_sha
            ),
            "receipt_digest": "sha256:" + control_sha,
            "release_digest": runtime_digest,
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--control", required=True)
    parser.add_argument("--deployment", type=Path, required=True)
    parser.add_argument("--statefulset", type=Path, required=True)
    parser.add_argument("--pods", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = plan(
        args.control,
        json.loads(args.deployment.read_text()),
        json.loads(args.statefulset.read_text()),
        json.loads(args.pods.read_text()),
    )
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
