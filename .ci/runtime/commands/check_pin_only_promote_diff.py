#!/usr/bin/env python3
"""Command wrapper for semantic runtime module gitops.pin_only_promote_diff."""

from __future__ import annotations

import sys
from pathlib import Path

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.pin_only_promote_diff import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
