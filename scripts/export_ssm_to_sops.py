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
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent


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
        result = subprocess.run(cmd, capture_output=True, text=True)
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


def encrypt_yaml(plaintext: str, recipients: list[str], filename_override: str) -> str:
    if not recipients:
        raise ValueError("missing age recipients for sops encryption")
    if subprocess.run(["command", "-v", "sops"], shell=True, capture_output=True, text=True).returncode != 0:
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
        "--age",
        ",".join(recipients),
        "/dev/stdin",
    ]
    result = subprocess.run(cmd, input=plaintext, capture_output=True, text=True)
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
            version_id = item.get("version_id") or defaults.get("version_id") or "SSM_Current"
            if not region:
                raise ValueError(f"manifest item {item_id} missing region/defaults.region")

            raw_secret = fetch_secret(region, item["secret_name"], version_id)
            string_data = normalize_string_data(raw_secret, string_key=item.get("string_key"))
            doc = build_k8s_resource_doc(item, string_data)
            plaintext = dump_yaml(doc)
            output_path = resolve_output_path(manifest_path, output_dir, item["output_path"])
            rendered = plaintext if args.plaintext else encrypt_yaml(plaintext, recipients, str(output_path))
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(rendered)
            print(f"wrote {output_path}")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
