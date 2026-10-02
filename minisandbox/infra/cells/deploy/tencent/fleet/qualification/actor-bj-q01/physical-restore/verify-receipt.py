#!/usr/bin/env python3
"""Compatibility entrypoint for the generic physical-restore verifier."""

import importlib.util
from pathlib import Path


VERIFIER = Path(__file__).resolve().parents[3] / "operations" / "verify-physical-restore-receipt.py"
SPEC = importlib.util.spec_from_file_location("actor_physical_restore_verifier", VERIFIER)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load generic physical-restore verifier")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
verify = MODULE.verify
main = MODULE.main


if __name__ == "__main__":
    main()
