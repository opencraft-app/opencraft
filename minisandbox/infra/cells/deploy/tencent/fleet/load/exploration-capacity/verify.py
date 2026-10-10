#!/usr/bin/env python3
"""Use the common capacity predicates, emitting development-only evidence."""

import importlib.util
from pathlib import Path


CORE = Path(__file__).resolve().parents[1] / "ten-thousand-active" / "verify.py"
SPEC = importlib.util.spec_from_file_location("capacity_cycle_verifier", CORE)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


if __name__ == "__main__":
    raise SystemExit(VERIFY.main(evidence_mode="exploration"))
