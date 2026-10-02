#!/usr/bin/env python3
"""Render one Cell's continuous FDB backup from immutable rebuild evidence."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parent
FLEET = ROOT.parent
CREATE_FIRST = FLEET / "terraform" / "create-first"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"required renderer is unavailable: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_json(path: Path, name: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def sha256(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def publish_exact(path: Path, raw: bytes, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if not path.is_file() or path.is_symlink() or path.read_bytes() != raw:
            raise ValueError(f"existing output differs: {path}")
        return
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def render(
    inventory_raw: dict[str, Any], images_raw: dict[str, Any], convergence: dict[str, Any]
) -> tuple[bytes, dict[str, Any]]:
    cell_renderer = load_module("cell_backup_inventory", CREATE_FIRST / "render-cell-assets.py")
    image_contract = load_module(
        "cell_backup_images", FLEET / "gitops" / "image-seed" / "image_contract.py"
    )
    inventory = cell_renderer.validate_inventory(inventory_raw)
    images = image_contract.validate_inventory(images_raw)
    if convergence.get("schema") != "actor-cell-argo-convergence/v1" or convergence.get("verdict") != "passed":
        raise ValueError("Argo convergence receipt is not passed production evidence")
    cell = convergence.get("cell")
    if not isinstance(cell, dict) or cell.get("id") != inventory["cellId"]:
        raise ValueError("Argo convergence Cell differs from Terraform inventory")
    if convergence.get("terraformInventoryDigest") != cell_renderer.digest(inventory):
        raise ValueError("Argo convergence inventory digest differs")
    if convergence.get("imageInventoryDigest") != images["inventoryDigest"]:
        raise ValueError("Argo convergence image inventory differs")
    if cell.get("profileDigest") != inventory["fleet"]["profileDigest"]:
        raise ValueError("Argo convergence profile differs")
    if convergence.get("fleetBinding") != inventory["fleet"]:
        raise ValueError("Argo convergence Fleet binding differs")
    if images["registry"] != inventory["registry"]["host"] or images["namespace"] != inventory["registry"]["namespace"]:
        raise ValueError("image inventory registry differs from Terraform inventory")

    monitors = [item for item in images["images"] if item["repository"] == "fdb-kubernetes-monitor"]
    if len(monitors) != 1:
        raise ValueError("image inventory must contain one FDB monitor")
    monitor_base, monitor_digest = monitors[0]["ref"].split("@", 1)
    cell_id = inventory["cellId"]
    region = inventory["region"]
    bucket = inventory["storage"]["backup"]
    suffix = cell_id.removeprefix("actor-")

    source = yaml.safe_load((ROOT / "production" / "actor-bj-k01-continuous-backup.yaml").read_text())
    source["metadata"].update(
        name=f"{cell_id}-continuous",
        namespace="actor-fdb-cell-system",
        labels={
            "fleet.actor.dev/cell-name": cell_id,
            "fleet.actor.dev/purpose": "continuous-backup",
        },
    )
    spec = source["spec"]
    spec.update(clusterName=cell_id, dataCenter=region, tag=f"{cell_id}-continuous")
    # A qualification-single-zone Cell intentionally has one control node.
    # Requesting the production three-agent anti-affinity topology there leaves
    # two permanently Pending Pods even though the running agent can produce a
    # restorable backup. Production multi-zone Cells retain three agents.
    agent_count = 1 if inventory["availabilityMode"] == "qualification-single-zone" else 3
    spec["agentCount"] = agent_count
    spec["blobStoreConfiguration"] = {
        "accountName": f"@{bucket}.cos.{region}.myqcloud.com",
        "bucket": bucket,
        "backupName": f"actor/production/{region}/{suffix}/foundationdb/continuous",
        "urlParameters": [f"region={region}"],
    }
    spec["mainContainer"]["imageConfigs"] = [
        {"baseImage": monitor_base, "tag": f"7.3.79@{monitor_digest}"}
    ]
    pod_template = spec["podTemplateSpec"]
    pod_template["metadata"]["labels"] = {
        "fleet.actor.dev/cell-name": cell_id,
        "fleet.actor.dev/purpose": "continuous-backup",
    }
    pod = pod_template["spec"]
    pod["nodeSelector"] = {"fleet.actor.dev/control-pool": "true"}
    deployment_name = f"{cell_id}-continuous-backup-agents"
    pod["affinity"]["podAntiAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"][0][
        "labelSelector"
    ]["matchLabels"]["foundationdb.org/deployment-name"] = deployment_name
    pod["topologySpreadConstraints"][0]["labelSelector"]["matchLabels"][
        "foundationdb.org/deployment-name"
    ] = deployment_name
    pod["volumes"][0]["secret"]["secretName"] = f"{cell_id}-backup-credentials"
    pod["volumes"][1]["secret"]["secretName"] = f"{cell_id}-backup-tls"

    manifest = yaml.safe_dump(source, sort_keys=False).encode()
    receipt = {
        "schema": "actor-cell-continuous-backup-render/v1",
        "verdict": "passed",
        "cellId": cell_id,
        "clusterId": inventory["kubernetes"]["clusterId"],
        "platformClusterUid": convergence["platformClusterUid"],
        "cellUid": cell["uid"],
        "imageInventoryDigest": images["inventoryDigest"],
        "monitorImage": monitors[0]["ref"],
        "backup": {
            "name": f"{cell_id}-continuous",
            "bucket": bucket,
            "tag": f"{cell_id}-continuous",
            "agentCount": agent_count,
            "manifestSha256": sha256(manifest),
        },
    }
    return manifest, receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--images", required=True, type=Path)
    parser.add_argument("--convergence", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        manifest, receipt = render(
            load_json(args.inventory, "Terraform inventory"),
            load_json(args.images, "image inventory"),
            load_json(args.convergence, "Argo convergence receipt"),
        )
        receipt_raw = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()
        publish_exact(args.output, manifest)
        publish_exact(args.receipt, receipt_raw)
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=os.sys.stderr)
        return 2
    print(json.dumps({"cellBackupRender": "passed", "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
