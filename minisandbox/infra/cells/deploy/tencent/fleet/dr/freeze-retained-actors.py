#!/usr/bin/env python3
"""Freeze retained qualification Actors after a non-data qualification failure."""

import argparse
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request


def request(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=40) as response:
        return json.loads(response.read())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inflight", required=True)
    parser.add_argument("--qualification-result", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--engine-url", default="http://127.0.0.1:16420")
    parser.add_argument("--depot-url", default="http://127.0.0.1:16421")
    parser.add_argument("--timeout-seconds", type=int, default=600)
    args = parser.parse_args()

    inflight = json.load(open(args.inflight))
    qualification = json.load(open(args.qualification_result))
    records = inflight.get("actor_records") or []
    if not records:
        raise SystemExit("inflight receipt has no retained Actors")
    checkpoints = inflight.get("final_checkpoints") or {}
    first = next(iter(checkpoints.values()), None)
    if not first or not first.get("bucket_id"):
        raise SystemExit("inflight receipt has no checkpoint bucket")
    bucket = first["bucket_id"]
    freeze = {}

    for record in records:
        actor = record["actor_id"]
        encoded = urllib.parse.quote(actor, safe="")
        pre_freeze = request(
            "GET", "{}/gateway/{}/counter".format(args.engine_url, encoded)
        )
        if pre_freeze.get("actorId") != actor:
            raise SystemExit("wrong Actor identity returned for {}".format(actor))
        if pre_freeze.get("count") != record["expected_count"]:
            raise SystemExit("counter mismatch for {}".format(actor))
        if int(pre_freeze.get("bottomlessBytes", 0)) != int(
            record.get("expected_bottomless_bytes", 0)
        ):
            raise SystemExit("bottomless byte mismatch for {}".format(actor))
        request(
            "PUT",
            "{}/depot/qualification/buckets/{}/databases/{}/shard-cache-policy".format(
                args.depot_url, urllib.parse.quote(bucket, safe=""), encoded
            ),
            {"retention_ms": 1},
        )
        request(
            "POST",
            "{}/actors/{}/sleep?namespace={}".format(
                args.engine_url,
                encoded,
                urllib.parse.quote(inflight.get("namespace", "default"), safe=""),
            ),
            {},
        )
        checkpoint = request(
            "POST",
            "{}/depot/checkpoints/buckets/{}/databases/{}".format(
                args.depot_url, urllib.parse.quote(bucket, safe=""), encoded
            ),
            {"force_reclaim": True},
        )
        freeze[actor] = {
            "pre_freeze_read": pre_freeze,
            "checkpoint": checkpoint,
        }

    deadline = time.time() + args.timeout_seconds
    pending = set(freeze)
    while pending and time.time() < deadline:
        for actor in list(pending):
            state = request(
                "GET",
                "{}/depot/inspect/buckets/{}/databases/{}/bottomless-state".format(
                    args.depot_url,
                    urllib.parse.quote(bucket, safe=""),
                    urllib.parse.quote(actor, safe=""),
                ),
            )
            freeze[actor]["bottomless_state"] = state
            hot = state.get("row_counts", {}).get("hot_shards", {}).get("count")
            if state.get("cold_ready") is True and hot == 0:
                pending.remove(actor)
        if pending:
            time.sleep(1)
    if pending:
        raise SystemExit("retained Actors did not become cold: {}".format(sorted(pending)))

    for actor in freeze:
        request(
            "DELETE",
            "{}/depot/qualification/buckets/{}/databases/{}/shard-cache-policy".format(
                args.depot_url,
                urllib.parse.quote(bucket, safe=""),
                urllib.parse.quote(actor, safe=""),
            ),
        )

    canonical = json.dumps(
        sorted(records, key=lambda record: (record.get("key", ""), record["actor_id"])),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    result = {
        "version": 1,
        "purpose": "production-disaster-recovery-seed",
        "seed_data_verdict": "passed",
        "qualification_verdict": qualification.get("verdict"),
        "qualification_error": qualification.get("error"),
        "qualification_stage": inflight.get("stage"),
        "namespace": inflight.get("namespace"),
        "bucket_id": bucket,
        "actor_records": records,
        "actor_manifest_sha256": hashlib.sha256(canonical).hexdigest(),
        "final_checkpoints": checkpoints,
        "post_sleep_reclaims": inflight.get("post_sleep_reclaims"),
        "actors_retained_asleep": True,
        "freeze_finished_at_unix_ms": int(time.time() * 1000),
        "freeze": freeze,
    }
    temporary = args.output + ".tmp"
    with open(temporary, "w") as output:
        json.dump(result, output, indent=2, sort_keys=True)
        output.write("\n")
    os.replace(temporary, args.output)
    print(
        json.dumps(
            {
                "seed_data_verdict": result["seed_data_verdict"],
                "qualification_verdict": result["qualification_verdict"],
                "actors": len(records),
                "actor_manifest_sha256": result["actor_manifest_sha256"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
