#!/usr/bin/env python3
"""Command wrapper for harness_ci.gitops_merge_request_note."""

from __future__ import annotations

import sys
from pathlib import Path

RUNTIME_DIR = Path(__file__).resolve().parents[2]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from harness_ci.gitops_merge_request_note import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
