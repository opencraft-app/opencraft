"""Runtime secret resolution helpers for CI-only jobs.

Secrets resolved here are intentionally short-lived process values. Callers
should inject them through temporary Kubernetes Secrets instead of inline Job
environment values.
"""

from __future__ import annotations

import hashlib
import subprocess
import tomllib
from pathlib import Path
from typing import Any, Mapping

import yaml


def resolve_contract_secret_values(repo_root: Path, env: str, contract: Mapping[str, Any]) -> dict[str, str]:
    raw_resolvers = contract.get("secret_resolvers") or {}
    if not isinstance(raw_resolvers, Mapping):
        raise TypeError("db_contract.secret_resolvers must be a mapping")

    resolved: dict[str, str] = {}
    for name, raw_config in raw_resolvers.items():
        if not isinstance(raw_config, Mapping):
            raise TypeError(f"secret resolver {name} must be a mapping")
        resolved[str(name)] = resolve_secret_value(repo_root, env, raw_config)
    return resolved


def resolve_secret_value(repo_root: Path, env: str, config: Mapping[str, Any]) -> str:
    resolver_type = str(config.get("type") or "").strip()
    if resolver_type != "sops_toml":
        raise ValueError(f"unsupported secret resolver type: {resolver_type or '<empty>'}")

    relative_file = str(config.get("file") or "").strip()
    data_key = str(config.get("data_key") or "").strip()
    toml_path = str(config.get("toml_path") or "").strip()
    if not relative_file or not data_key or not toml_path:
        raise ValueError("sops_toml resolver requires file, data_key, and toml_path")

    decrypted = decrypt_sops_yaml(repo_root / relative_file.format(env=env))
    raw_toml = str((decrypted.get("data") or {}).get(data_key) or "")
    if not raw_toml:
        raise ValueError(f"missing {data_key} in decrypted {relative_file}")

    value = value_at_path(tomllib.loads(raw_toml), toml_path)
    return transform_secret(str(value), str(config.get("transform") or "").strip())


def decrypt_sops_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"missing SOPS file: {path}")
    result = subprocess.run(["sops", "-d", str(path)], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"sops decrypt failed for {path}: {result.stderr.strip()}")
    data = yaml.safe_load(result.stdout) or {}
    if not isinstance(data, dict):
        raise ValueError(f"decrypted SOPS file is not a YAML mapping: {path}")
    return data


def value_at_path(data: Mapping[str, Any], dotted_path: str) -> Any:
    current: Any = data
    for part in dotted_path.split("."):
        if not isinstance(current, Mapping) or part not in current:
            raise KeyError(f"missing TOML path: {dotted_path}")
        current = current[part]
    return current


def transform_secret(value: str, transform: str) -> str:
    if not transform:
        return value
    if transform == "ctl_legacy_aes_decrypt":
        return ctl_legacy_aes_decrypt(value)
    raise ValueError(f"unsupported secret transform: {transform}")


def ctl_legacy_aes_decrypt(value: str) -> str:
    key_hex = hashlib.md5(b"lighthouse").hexdigest().encode().hex()
    iv_hex = hashlib.md5(b"lightglobal").hexdigest()[:16].encode().hex()
    result = subprocess.run(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-base64", "-A", "-K", key_hex, "-iv", iv_hex],
        input=value,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("ctl legacy AES decrypt failed")
    return result.stdout.rstrip("\n")


def build_secret_manifest(
    namespace: str,
    name: str,
    string_data: Mapping[str, str],
    *,
    labels: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    if not string_data:
        raise ValueError("temporary secret requires at least one key")
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": dict(labels or {}),
        },
        "type": "Opaque",
        "stringData": dict(string_data),
    }


def secret_env_ref(name: str, key: str) -> dict[str, Any]:
    return {"secretKeyRef": {"name": name, "key": key}}


def redact(text: str, secret_values: Mapping[str, str]) -> str:
    redacted = text
    for key, value in secret_values.items():
        if value:
            redacted = redacted.replace(value, f"<redacted:{key}>")
    return redacted
