#!/usr/bin/env python3
"""Command wrapper for playground DNS provisioning."""

from pathlib import Path
import sys

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from support.playground_dns import main

if __name__ == "__main__":
    raise SystemExit(main())
