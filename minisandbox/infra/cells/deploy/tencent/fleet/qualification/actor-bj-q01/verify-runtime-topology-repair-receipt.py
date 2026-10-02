#!/usr/bin/env python3
import argparse
import hashlib
import json
import pathlib
import re
import sys


SHA256 = re.compile(r"^[0-9a-f]{64}$")


def verify(payload, cluster_uid=None, machine_set_uid=None):
    if payload.get("schema") != "rivet-runtime-topology-repair/v1" or payload.get("verdict") != "passed":
        raise ValueError("topology repair did not pass with the expected schema")
    if payload.get("cell") != "actor-bj-q01" or payload.get("machine_set") != "np-runtime0":
        raise ValueError("receipt is not bound to q01 runtime capacity")
    for key, expected in (("cluster_uid", cluster_uid), ("machine_set_uid", machine_set_uid)):
        value = payload.get(key)
        if not isinstance(value, str) or not value or (expected is not None and value != expected):
            raise ValueError(f"{key} is missing or mismatched")
    policy = payload.get("policy", {})
    expected_policy = {
        "required_zones": 3,
        "max_repair_surge": 1,
        "create_policy": "ZoneEquality",
        "delete_policy": "Newest",
    }
    if policy != expected_policy:
        raise ValueError("bounded topology repair policy is not exact")
    baseline = payload.get("baseline_zones")
    final = payload.get("final_zones")
    if (not isinstance(baseline, list) or len(baseline) != 3 or
            sorted(baseline.count(zone) for zone in set(baseline)) != [1, 2]):
        raise ValueError("baseline is not exact 2/1/0 topology")
    if (not isinstance(final, list) or len(final) != 3 or len(set(final)) != 3 or
            any(not isinstance(zone, str) or not zone for zone in final)):
        raise ValueError("final topology is not exact three-zone capacity")
    target, replacement = payload.get("target"), payload.get("replacement")
    for label, identity in (("target", target), ("replacement", replacement)):
        keys = ("name", "uid", "node", "node_uid", "zone")
        if not isinstance(identity, dict) or not all(isinstance(identity.get(key), str) and identity[key] for key in keys):
            raise ValueError(f"{label} identity is incomplete")
    overrepresented = next(zone for zone in set(baseline) if baseline.count(zone) == 2)
    if (target["zone"] != overrepresented or replacement["zone"] in set(baseline) or
            replacement["zone"] not in set(final)):
        raise ValueError("target/replacement zones do not prove missing-zone repair")
    if target["uid"] == replacement["uid"] or target["node_uid"] == replacement["node_uid"]:
        raise ValueError("replacement reused the retired identity")
    if payload.get("exact_target_removed") is not True or payload.get("ready_admitted_capacity_restored") is not True:
        raise ValueError("exact deletion or Ready capacity restoration is unproven")
    claimed = payload.get("evidence_sha256")
    if not isinstance(claimed, str) or SHA256.fullmatch(claimed) is None:
        raise ValueError("evidence digest is invalid")
    canonical = dict(payload)
    canonical.pop("evidence_sha256", None)
    actual = hashlib.sha256(json.dumps(canonical, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    if claimed != actual:
        raise ValueError("evidence digest mismatch")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster-uid")
    parser.add_argument("--machine-set-uid")
    parser.add_argument("receipt", type=pathlib.Path)
    args = parser.parse_args()
    try:
        verify(json.loads(args.receipt.read_text()), args.cluster_uid, args.machine_set_uid)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"invalid runtime topology repair receipt: {error}", file=sys.stderr)
        return 1
    print("runtime topology repair receipt: pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
