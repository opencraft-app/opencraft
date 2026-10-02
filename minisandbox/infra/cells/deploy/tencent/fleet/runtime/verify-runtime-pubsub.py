#!/usr/bin/env python3
"""Fail closed when a rendered NATS config silently selects a local driver."""

import argparse
import json
import re
from pathlib import Path


def verify(config: str, resolved: str) -> None:
    document = json.loads(config)
    if not isinstance(document, dict) or "nats" not in document or "memory" in document:
        raise ValueError("production runtime config must select NATS exclusively")
    # `config show` emits the pretty Debug representation of Root. Match only
    # its top-level field, never an untrusted string or a one-line log message.
    roots = re.findall(r"(?m)^Root \{\n", resolved)
    fields = re.findall(r"(?m)^    pubsub:\s*Some\s*\(\s*Nats\s*\(", resolved)
    if len(roots) != 1 or len(fields) != 1:
        raise ValueError("Engine did not resolve the configured NATS PubSub driver")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path)
    parser.add_argument("resolved", type=Path)
    args = parser.parse_args()
    try:
        verify(args.config.read_text(), args.resolved.read_text())
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
