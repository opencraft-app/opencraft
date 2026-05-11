"""Shared result model for release gate execution."""

from __future__ import annotations

import json
import shlex
from dataclasses import dataclass


APPROVED_GATE_KEYS = (
    "GATE_IMAGE_STATUS",
    "GATE_IMAGE_PIN_PAYLOAD",
    "GATE_IMAGE_DIGESTS_JSON",
    "GATE_CONFIG_STATUS",
    "GATE_DB_STATUS",
    "GATE_REQUIRES_DB_READINESS",
    "GATE_AUTO_MERGE_ALLOWED",
    "GATE_AUTO_SYNC_ALLOWED",
    "GATE_ARGO_SYNC",
    "GATE_RELEASE_DEPENDENCY_CHANGED",
    "GATE_MANUAL_ACTIONS",
)


@dataclass(frozen=True)
class ReleaseGateResult:
    image_status: str
    image_pin_payload: str
    image_digests_json: str
    config_status: str
    db_status: str
    requires_db_readiness: bool
    auto_merge_allowed: bool
    auto_sync_allowed: bool
    argo_sync: str
    release_dependency_changed: bool
    manual_actions: list[str]

    def to_env(self) -> dict[str, str]:
        return {
            "GATE_IMAGE_STATUS": self.image_status,
            "GATE_IMAGE_PIN_PAYLOAD": self.image_pin_payload,
            "GATE_IMAGE_DIGESTS_JSON": self.image_digests_json,
            "GATE_CONFIG_STATUS": self.config_status,
            "GATE_DB_STATUS": self.db_status,
            "GATE_REQUIRES_DB_READINESS": _bool(self.requires_db_readiness),
            "GATE_AUTO_MERGE_ALLOWED": _bool(self.auto_merge_allowed),
            "GATE_AUTO_SYNC_ALLOWED": _bool(self.auto_sync_allowed),
            "GATE_ARGO_SYNC": self.argo_sync,
            "GATE_RELEASE_DEPENDENCY_CHANGED": _bool(self.release_dependency_changed),
            "GATE_MANUAL_ACTIONS": json.dumps(self.manual_actions, ensure_ascii=False),
        }

    def to_dotenv(self) -> str:
        env = self.to_env()
        return "\n".join(f"{key}={shlex.quote(env[key])}" for key in APPROVED_GATE_KEYS)


def _bool(value: bool) -> str:
    return "true" if value else "false"
