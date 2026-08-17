#!/usr/bin/env python3
"""
Export Tencent Cloud SSM secrets into sops-encrypted Kubernetes resource YAML files.

Manifest shape:

defaults:
  region: ap-hongkong
  version_id: SSM_Current
  age_recipients:
    - age1...
items:
  - id: argocd_sample
    secret_name: /mono/hk-devops/argocd-sample/example-secret
    namespace: argocd-sample
    kubernetes_resource_name: argocd-sample-secret
    kubernetes_resource_kind: Secret
    output_path: ./out/argocd-sample-secret.sops.yaml
    string_key: EXAMPLE_SECRET
    plaintext_keys:
      - NON_SENSITIVE_RUNTIME_POLICY
    optional_plaintext_keys:
      - FUTURE_NON_SENSITIVE_POLICY
    labels:
      app.kubernetes.io/name: argocd-sample
    annotations:
      managed-by: export_ssm_to_sops.py

If SecretString is valid JSON object, its top-level stringifiable keys become
`stringData` (for Secret) or `data` (for ConfigMap). Otherwise the raw secret
string is written under `string_key`.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SOPS_ENCRYPTED_REGEX = "^(data|stringData)$"
SAFE_IDENTIFIER_RE = "^[A-Za-z][A-Za-z0-9-]*$"


def validate_command_args(cmd: list[str], context: str) -> list[str]:
    if not cmd:
        raise ValueError(f"{context} command must not be empty")
    normalized: list[str] = []
    for arg in cmd:
        if not isinstance(arg, str):
            raise TypeError(f"{context} argument must be str")
        if not arg:
            raise ValueError(f"{context} argument must not be empty")
        if "\x00" in arg:
            raise ValueError(f"{context} argument must not contain NUL")
        normalized.append(arg)
    return normalized


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export Tencent Cloud SSM secrets to sops-encrypted Kubernetes resource YAML.",
    )
    parser.add_argument(
        "--manifest",
        required=True,
        help="YAML manifest that maps SSM secrets to Kubernetes resource outputs.",
    )
    parser.add_argument(
        "--output-dir",
        default="",
        help="Optional output directory override. Relative output paths are rebased here.",
    )
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        help="Only process specific manifest item ids. Can be repeated.",
    )
    parser.add_argument(
        "--plaintext",
        action="store_true",
        help="Write plaintext YAML instead of encrypting with sops.",
    )
    parser.add_argument(
        "--recipient",
        action="append",
        default=[],
        help="Additional age recipient. Can be repeated.",
    )
    return parser.parse_args()


def load_manifest(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"manifest not found: {path}")
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise ValueError("manifest root must be a mapping")
    defaults = data.get("defaults") or {}
    items = data.get("items") or []
    if not isinstance(defaults, dict):
        raise ValueError("manifest defaults must be a mapping")
    if not isinstance(items, list) or not items:
        raise ValueError("manifest items must be a non-empty list")
    return {"defaults": defaults, "items": items}


def run_tccli(service: str, action: str, *, region: str, payload: dict[str, Any]) -> dict[str, Any]:
    for label, value in (("service", service), ("action", action), ("region", region)):
        if not re.fullmatch(SAFE_IDENTIFIER_RE, value):
            raise ValueError(f"invalid tccli {label}: {value}")
    last_error: Exception | None = None
    for attempt in range(3):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
            json.dump(payload, tmp)
            tmp.flush()
            tmp_path = tmp.name

        cmd = [
            "tccli",
            service,
            action,
            "--region",
            region,
            "--cli-input-json",
            f"file://{tmp_path}",
        ]
        result = subprocess.run(  # nosemgrep: dangerous-subprocess-use-audit
            validate_command_args(cmd, "tccli"),
            capture_output=True,
            text=True,
        )
        Path(tmp_path).unlink(missing_ok=True)

        if result.returncode == 0:
            try:
                return json.loads(result.stdout)
            except json.JSONDecodeError as exc:
                last_error = RuntimeError(
                    f"tccli {service} {action} returned non-JSON output:\n{result.stdout}"
                )
                last_error.__cause__ = exc
        else:
            last_error = RuntimeError(
                f"tccli {service} {action} failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )
        time.sleep(1.5 * (attempt + 1))

    assert last_error is not None
    raise last_error


def fetch_secret(region: str, secret_name: str, version_id: str) -> str:
    response = run_tccli(
        "ssm",
        "GetSecretValue",
        region=region,
        payload={
            "SecretName": secret_name,
            "VersionId": version_id,
        },
    )
    payload = response.get("Response") or response
    secret_string = payload.get("SecretString")
    if secret_string:
        return secret_string
    secret_binary = payload.get("SecretBinary")
    if secret_binary:
        raise ValueError(f"{secret_name}: SecretBinary is not supported by this exporter")
    raise ValueError(f"{secret_name}: empty secret value")


def resolve_version_id(region: str, secret_name: str, configured_version_id: str) -> str:
    if configured_version_id != "latest":
        return configured_version_id

    response = run_tccli(
        "ssm",
        "ListSecretVersionIds",
        region=region,
        payload={"SecretName": secret_name},
    )
    payload = response.get("Response") or response
    versions = [
        version
        for version in payload.get("Versions") or []
        if isinstance(version, dict) and version.get("VersionId")
    ]
    if not versions:
        raise ValueError(f"{secret_name}: no secret versions found")

    def sort_key(version: dict[str, Any]) -> tuple[int, str]:
        try:
            create_time = int(version.get("CreateTime") or 0)
        except (TypeError, ValueError):
            create_time = 0
        return create_time, str(version["VersionId"])

    return str(max(versions, key=sort_key)["VersionId"])


def normalize_string_data(raw: str, *, string_key: str | None) -> dict[str, str]:
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError:
        decoded = None

    if isinstance(decoded, dict):
        return {str(key): "" if value is None else str(value) for key, value in decoded.items()}

    if not string_key:
        raise ValueError("non-JSON SecretString requires string_key in manifest")
    return {string_key: raw}


def get_resource_name(item: dict[str, Any]) -> str:
    name = item.get("kubernetes_resource_name") or item.get("kubernetes_secret_name")
    if not name:
        raise ValueError("manifest item missing kubernetes_resource_name")
    return str(name)


def get_resource_kind(item: dict[str, Any]) -> str:
    kind = item.get("kubernetes_resource_kind") or item.get("kubernetes_kind") or "Secret"
    return str(kind)


def build_k8s_resource_doc(item: dict[str, Any], string_data: dict[str, str]) -> dict[str, Any]:
    metadata = {
        "name": get_resource_name(item),
        "namespace": item["namespace"],
    }
    labels = item.get("labels") or {}
    annotations = item.get("annotations") or {}
    if labels:
        metadata["labels"] = labels
    if annotations:
        metadata["annotations"] = annotations

    kind = get_resource_kind(item)
    doc: dict[str, Any] = {
        "apiVersion": "v1",
        "kind": kind,
        "metadata": metadata,
    }
    if kind == "Secret":
        doc["type"] = item.get("secret_type", "Opaque")
        doc["stringData"] = string_data
    elif kind == "ConfigMap":
        doc["data"] = string_data
    else:
        raise ValueError(f"unsupported kubernetes_resource_kind: {kind}")
    return doc


def dump_yaml(doc: dict[str, Any]) -> str:
    return yaml.safe_dump(doc, sort_keys=False, allow_unicode=True)


def manifest_key_list(item: dict[str, Any], field: str) -> list[str]:
    keys = item.get(field) or []
    if not isinstance(keys, list) or any(
        not isinstance(key, str) or not key for key in keys
    ):
        raise ValueError(f"{field} must be a list of non-empty strings")
    return keys


def validate_required_keys(item: dict[str, Any], string_data: dict[str, str]) -> None:
    required_keys = manifest_key_list(item, "required_keys")
    missing = sorted(set(required_keys) - set(string_data))
    if missing:
        item_id = item.get("id") or item.get("secret_name") or "manifest item"
        raise ValueError(f"{item_id}: missing required keys: {', '.join(missing)}")


def encryption_regex_for_item(
    item: dict[str, Any],
    string_data: dict[str, str],
    *,
    defaults: dict[str, Any] | None = None,
) -> str:
    defaults = defaults or {}
    required_plaintext_keys = manifest_key_list(item, "plaintext_keys")
    optional_plaintext_keys = [
        *manifest_key_list(defaults, "optional_plaintext_keys"),
        *manifest_key_list(item, "optional_plaintext_keys"),
    ]
    if not required_plaintext_keys and not optional_plaintext_keys:
        return SOPS_ENCRYPTED_REGEX

    unknown = sorted(set(required_plaintext_keys) - set(string_data))
    if unknown:
        raise ValueError(f"unknown plaintext_keys: {', '.join(unknown)}")

    plaintext_keys = set(required_plaintext_keys)
    plaintext_keys.update(set(optional_plaintext_keys) & set(string_data))
    if not plaintext_keys:
        return SOPS_ENCRYPTED_REGEX

    encrypted_keys = sorted(set(string_data) - plaintext_keys)
    if not encrypted_keys:
        raise ValueError("plaintext_keys cannot include every key; use a ConfigMap for fully public data")
    return "^(" + "|".join(re.escape(key) for key in encrypted_keys) + ")$"


def encrypt_yaml(
    plaintext: str,
    recipients: list[str],
    filename_override: str,
    *,
    encrypted_regex: str = SOPS_ENCRYPTED_REGEX,
    mac_only_encrypted: bool = True,
) -> str:
    if not recipients:
        raise ValueError("missing age recipients for sops encryption")
    if shutil.which("sops") is None:
        raise RuntimeError("sops is not installed")

    cmd = [
        "sops",
        "--encrypt",
        "--input-type",
        "yaml",
        "--output-type",
        "yaml",
        "--filename-override",
        filename_override,
        "--encrypted-regex",
        encrypted_regex,
        "--age",
        ",".join(recipients),
        "/dev/stdin",
    ]
    if mac_only_encrypted:
        cmd.insert(-3, "--mac-only-encrypted")
    result = subprocess.run(  # nosemgrep: dangerous-subprocess-use-audit
        validate_command_args(cmd, "sops"),
        input=plaintext,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"sops encrypt failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return result.stdout


def resolve_output_path(manifest_path: Path, output_dir: Path | None, output_path: str) -> Path:
    candidate = Path(output_path)
    if candidate.is_absolute():
        return candidate
    if output_dir is not None:
        return output_dir / candidate.name if not candidate.parts or len(candidate.parts) == 1 else output_dir / candidate
    if output_path.startswith("./") or output_path.startswith("../"):
        return manifest_path.parent / candidate
    return REPO_ROOT / candidate


def main() -> int:
    args = parse_args()
    manifest_path = Path(args.manifest).resolve()
    output_dir = Path(args.output_dir).resolve() if args.output_dir else None

    try:
        manifest = load_manifest(manifest_path)
        defaults = manifest["defaults"]
        recipients = list(dict.fromkeys([*(defaults.get("age_recipients") or []), *args.recipient]))
        only = set(args.only)

        for item in manifest["items"]:
            if not isinstance(item, dict):
                raise ValueError("manifest item must be a mapping")
            item_id = item.get("id")
            if not item_id:
                raise ValueError("manifest item missing id")
            if only and item_id not in only:
                continue

            for required in ("secret_name", "namespace", "output_path"):
                if not item.get(required):
                    raise ValueError(f"manifest item {item_id} missing {required}")
            get_resource_name(item)

            region = item.get("region") or defaults.get("region")
            configured_version_id = item.get("version_id") or defaults.get("version_id") or "SSM_Current"
            if not region:
                raise ValueError(f"manifest item {item_id} missing region/defaults.region")

            version_id = resolve_version_id(region, item["secret_name"], configured_version_id)
            raw_secret = fetch_secret(region, item["secret_name"], version_id)
            string_data = normalize_string_data(raw_secret, string_key=item.get("string_key"))
            validate_required_keys(item, string_data)
            doc = build_k8s_resource_doc(item, string_data)
            plaintext = dump_yaml(doc)
            output_path = resolve_output_path(manifest_path, output_dir, item["output_path"])
            encrypted_regex = encryption_regex_for_item(item, string_data, defaults=defaults)
            rendered = plaintext if args.plaintext else encrypt_yaml(
                plaintext,
                recipients,
                str(output_path),
                encrypted_regex=encrypted_regex,
                # Plaintext policy keys still participate in the SOPS MAC so
                # they remain integrity protected even though they are visible.
                mac_only_encrypted=encrypted_regex == SOPS_ENCRYPTED_REGEX,
            )
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(rendered)
            print(f"wrote {output_path}")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
