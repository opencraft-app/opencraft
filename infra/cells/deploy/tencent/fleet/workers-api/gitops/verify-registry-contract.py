#!/usr/bin/env python3
"""Verify the Registry invalidation contract before enabling stateless serving."""

from __future__ import annotations

import argparse
import json
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request


SCHEMA = "rivet-worker-deployment-cursor/v1"
CURSOR = re.compile(r"^c_[0-9a-f]{32}$")
NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
MAX_RESPONSE_BYTES = 64 << 10


def verify(endpoint: str, namespace: str, timeout: float) -> dict[str, str]:
    parsed = urllib.parse.urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/")
    ):
        raise ValueError("Registry endpoint must be a credential-free HTTP origin")
    if not NAME.fullmatch(namespace):
        raise ValueError("Registry namespace is invalid")
    if not (0 < timeout <= 30):
        raise ValueError("Registry verification timeout must be within 30 seconds")

    # A valid random cursor differs from the authoritative namespace cursor
    # with overwhelming probability, so the FDB watch returns immediately.
    # Old Registries return 404 for this route and are rejected before Argo is
    # allowed to publish a Workers API that depends on cache invalidation.
    after = "c_" + secrets.token_hex(16)
    path = f"/internal/v1/namespaces/{urllib.parse.quote(namespace, safe='')}/deployment-cursor"
    target = urllib.parse.urlunsplit((
        parsed.scheme,
        parsed.netloc,
        path,
        urllib.parse.urlencode({"after": after}),
        "",
    ))
    request = urllib.request.Request(target, method="GET", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            encoded = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
    except urllib.error.HTTPError as error:
        raise ValueError(f"Registry deployment cursor endpoint returned HTTP {error.code}") from error
    except (OSError, TimeoutError, urllib.error.URLError) as error:
        raise ValueError("Registry deployment cursor endpoint is unavailable") from error
    if status != 200:
        raise ValueError(f"Registry deployment cursor endpoint returned HTTP {status}")
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise ValueError("Registry deployment cursor response is oversized")
    try:
        value = json.loads(encoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Registry deployment cursor response is not JSON") from error
    if (
        not isinstance(value, dict)
        or value.get("schema") != SCHEMA
        or value.get("namespace") != namespace
        or not isinstance(value.get("cursor"), str)
        or not CURSOR.fullmatch(value["cursor"])
    ):
        raise ValueError("Registry deployment cursor response violates the serving contract")
    return {"schema": SCHEMA, "namespace": namespace, "cursor": value["cursor"]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()
    try:
        result = verify(args.endpoint, args.namespace, args.timeout)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps({"verdict": "passed", **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
