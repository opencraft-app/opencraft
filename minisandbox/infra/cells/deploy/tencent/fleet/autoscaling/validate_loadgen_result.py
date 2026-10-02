#!/usr/bin/env python3
"""Validate one public /v1 autoscaling load-generator result."""

import argparse
import json
import sys


def validate(document, args):
    if document.get("verdict") != "passed":
        raise ValueError("loadgen verdict is not passed")
    if document.get("api_mode") != "workers-v1" or document.get("public_api_only") is not True:
        raise ValueError("loadgen did not use only the public /v1 API")
    release = document.get("worker_release", {})
    version_ids = release.get("version_ids", []) if isinstance(release, dict) else []
    if (
        not isinstance(release, dict)
        or release.get("version_pool_size") != 1
        or not isinstance(version_ids, list)
        or len(version_ids) != 1
        or not isinstance(version_ids[0], str)
        or not version_ids[0]
        or not release.get("deployment_id")
        or not release.get("worker")
    ):
        raise ValueError("loadgen must bind every Agent to one immutable Worker Version")
    if document.get("mode") != args.mode or document.get("run_id") != args.run_id:
        raise ValueError("loadgen mode or run identity mismatch")
    if document.get("cell_id") != args.cell or document.get("target_actors") != args.target:
        raise ValueError("loadgen Cell or target cardinality mismatch")
    if document.get("batch_size") != args.batch_size:
        raise ValueError("loadgen batch size mismatch")
    if float(document.get("batch_settle_seconds", -1)) != args.batch_settle_seconds:
        raise ValueError("loadgen settle interval mismatch")
    if float(document.get("operation_rate", -1)) != args.operation_rate:
        raise ValueError("loadgen operation rate mismatch")
    if document.get("max_idempotent_retries") != args.max_idempotent_retries:
        raise ValueError("loadgen retry limit mismatch")
    states = document.get("actor_states", {})
    probe_states = document.get("probe_states", {})
    if args.mode == "populate":
        expected = states == {"dormant": args.target}
    elif args.mode == "probe":
        expected = states == {"dormant": args.target} and probe_states == {"deleted": args.probes}
    elif args.mode == "cleanup":
        expected = states == {"deleted": args.target} and not probe_states.get("dormant", 0)
    else:
        raise ValueError("unexpected production loadgen mode")
    if not expected:
        raise ValueError("loadgen Actor state inventory mismatch")
    result = dict(document)
    result["qualification_evidence"] = {
        "jobName": args.job_name,
        "podName": args.pod_name,
        "podUID": args.pod_uid,
    }
    return result


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("populate", "probe", "cleanup"))
    parser.add_argument("run_id")
    parser.add_argument("cell")
    parser.add_argument("target", type=int)
    parser.add_argument("probes", type=int)
    parser.add_argument("batch_size", type=int)
    parser.add_argument("batch_settle_seconds", type=float)
    parser.add_argument("operation_rate", type=float)
    parser.add_argument("max_idempotent_retries", type=int)
    parser.add_argument("job_name")
    parser.add_argument("pod_name")
    parser.add_argument("pod_uid")
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        document = json.load(sys.stdin)
        result = validate(document, args)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        print("invalid loadgen result: {}".format(error), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
