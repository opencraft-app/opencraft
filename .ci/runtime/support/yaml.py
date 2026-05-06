"""Shared YAML loading helpers for CI runtime scripts."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


def load_mapping(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text()) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    return payload
