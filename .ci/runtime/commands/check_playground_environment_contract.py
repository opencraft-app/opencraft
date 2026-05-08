#!/usr/bin/env python3
"""Command wrapper for checking playground environment contracts."""

from __future__ import annotations

import sys
from pathlib import Path

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.playground_environment import check_playground_contract_main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(check_playground_contract_main())
