#!/usr/bin/env python3
"""Accept only explicit completed TKE primitives, never Actor/release admission."""

import argparse
import hashlib
import json
from pathlib import Path


SCOPE = "tke-real-api-primitives-with-sleep-and-management-double-not-actor-or-cloud-admission"
CHECKS = {
    "real_pdb_429_preserves_pod", "namespace_scoped_webhook_tls_verified",
    "late_eviction_after_cancellation_returns_409", "post_condition_stale_delete_rv_rejected",
    "cancelled_eviction_retains_pdb_reservation", "pdb_capacity_recovers_without_status_mutation",
    "fresh_eviction_creates_new_uid", "successor_rejects_old_eviction_uid",
    "successor_rejects_old_cancellation", "own_namespace_removed", "own_webhook_removed",
    "fixture_node_identity_stable",
}


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate document key")
        result[key] = value
    return result


def document(path, maximum):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise ValueError("bounded regular document required")
    payload = path.read_bytes()
    value = json.loads(payload, object_pairs_hook=unique_pairs)
    if not isinstance(value, dict):
        raise ValueError("document must be an object")
    return payload, value


def validate(receipt, intent, intent_sha):
    checks = receipt.get("checks")
    if (receipt.get("schema") != "minisandbox-host-eviction-api/v1"
            or receipt.get("verdict") != "passed" or receipt.get("scope") != SCOPE
            or receipt.get("claimEligible") is not False
            or receipt.get("intraServerConditionDeleteWindowObserved") is not False
            or not isinstance(checks, dict) or not CHECKS.issubset(checks)
            or any(value is not True for value in checks.values())):
        raise ValueError("TKE primitive gate incomplete or broader claim attempted")
    for output, expected in (("intentSha256", intent_sha),
                             ("clusterNamespaceUid", intent.get("clusterNamespaceUid")),
                             ("controlNodeUid", intent.get("nodeUid")),
                             ("serverVersion", intent.get("serverVersion")),
                             ("image", intent.get("fixtureImage")),
                             ("adapterHashes", intent.get("adapterHashes"))):
        if expected in (None, "", {}) or receipt.get(output) != expected:
            raise ValueError("TKE receipt identity does not match reviewed intent")
    for field in ("namespace", "namespaceUid", "workloadUid", "webhookUid", "originalPodUid",
                  "originalRv", "cancellationRv", "conditionRv", "afterConditionCancellationRv",
                  "replacementPodUid"):
        if not isinstance(receipt.get(field), str) or not receipt[field]:
            raise ValueError("TKE fixture identity evidence missing")
    if (receipt["originalPodUid"] == receipt["replacementPodUid"]
            or receipt["originalRv"] == receipt["cancellationRv"]
            or receipt["conditionRv"] == receipt["afterConditionCancellationRv"]):
        raise ValueError("TKE fixture did not observe required identity transitions")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--intent", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        payload, intent = document(args.intent, 16 * 1024)
        _, receipt = document(args.receipt, 1024 * 1024)
        validate(receipt, intent, hashlib.sha256(payload).hexdigest())
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, f"tke_eviction_api_primitives=failed: {error}\n")
    print("tke_eviction_api_primitives=passed claim_eligible=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
