#!/usr/bin/env python3
"""Verify NATS connectivity against Ready Engine Pod identities, not names."""

import argparse
import ipaddress
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


RFC3339 = re.compile(
    r"^(?P<whole>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})"
    r"(?:\.(?P<fraction>\d{1,9}))?"
    r"(?P<zone>Z|[+-]\d{2}:\d{2})$"
)


def parse_timestamp(value):
    """Parse the RFC3339 subset emitted by Kubernetes and NATS on Python 3.6+."""

    match = RFC3339.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError("timestamp is not RFC3339")
    fraction = (match.group("fraction") or "")[:6].ljust(6, "0")
    zone = match.group("zone")
    if zone == "Z":
        tz = timezone.utc
    else:
        hours, minutes = (int(part) for part in zone[1:].split(":"))
        if hours > 23 or minutes > 59:
            raise ValueError("timestamp timezone offset is invalid")
        offset = timedelta(hours=hours, minutes=minutes)
        tz = timezone(offset if zone[0] == "+" else -offset)
    return datetime.strptime(match.group("whole"), "%Y-%m-%dT%H:%M:%S").replace(
        microsecond=int(fraction), tzinfo=tz
    )


def verify(expected, cell, pods, servers):
    required = {}
    for pod in pods.get("items", []):
        metadata, status = pod.get("metadata", {}), pod.get("status", {})
        labels = metadata.get("labels", {})
        if metadata.get("deletionTimestamp"):
            continue
        if (
            not metadata.get("uid")
            or labels.get("fleet.actor.dev/cell-name") != cell
            or labels.get("fleet.actor.dev/component") != "engine"
            or status.get("phase") != "Running"
            or not any(item.get("type") == "Ready" and item.get("status") == "True"
                       for item in status.get("conditions", []))
        ):
            raise ValueError("Engine Pod identity or readiness is incomplete")
        address = str(ipaddress.ip_address(status.get("podIP", "")))
        if address in required:
            raise ValueError("Engine Pod IP is duplicated")
        started = parse_timestamp(status.get("startTime", ""))
        required[address] = started
    if len(required) != expected or expected < 1 or len(servers) != 3:
        raise ValueError("Ready Engine Pod count or NATS server count differs")
    connected = set()
    for server in servers:
        connections = server.get("connections")
        if not isinstance(connections, list):
            raise ValueError("NATS connection inventory is malformed")
        for client in connections:
            if not isinstance(client, dict):
                raise ValueError("NATS client inventory is malformed")
            if client.get("ip"):
                address = str(ipaddress.ip_address(client["ip"]))
                if address not in required:
                    continue
                started = parse_timestamp(client.get("start", ""))
                # A stale connection from an earlier Pod must not count after
                # CNI reuses its IP for a replacement Pod UID.
                if started >= required[address]:
                    connected.add(address)
    if not set(required).issubset(connected):
        raise ValueError("not every Ready Engine Pod has a live NATS connection")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("expected", type=int)
    parser.add_argument("cell")
    parser.add_argument("pods", type=Path)
    parser.add_argument("servers", nargs=3, type=Path)
    args = parser.parse_args()
    try:
        verify(args.expected, args.cell, json.loads(args.pods.read_text()),
               [json.loads(path.read_text()) for path in args.servers])
    except (ValueError, OSError, AttributeError, TypeError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
