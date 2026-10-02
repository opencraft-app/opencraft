#!/usr/bin/env python3
"""Bind the installed regional code plane into a credential-free Git tree."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

import yaml


MANIFESTS = ("fdb-cluster.yaml", "fdb-backup.yaml", "worker-registry.yaml", "worker-registry-private.yaml")


def sha(path: Path, prefix: bool = True) -> str:
    value = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{value}" if prefix else value


def load(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain one object")
    return value


def render(source: Path, render_receipt_path: Path, install_receipt_path: Path):
    rendered, installed = load(render_receipt_path), load(install_receipt_path)
    if (rendered.get("schema"), rendered.get("verdict")) != ("actor-regional-code-plane-render/v1", "passed"):
        raise ValueError("code-plane render receipt did not pass")
    if (installed.get("schema"), installed.get("verdict")) != ("actor-regional-code-plane-install/v1", "passed"):
        raise ValueError("code-plane install receipt did not pass")
    if installed.get("inputs", {}).get("renderReceiptSha256") != sha(render_receipt_path, False):
        raise ValueError("installation does not bind the exact rendering")
    if installed.get("managementId") != rendered.get("managementId") or installed.get("cluster", {}).get("id") != rendered.get("clusterId"):
        raise ValueError("render and install management identities differ")
    files = rendered.get("files")
    if not isinstance(files, dict) or set(files) != set(MANIFESTS):
        raise ValueError("rendered manifest inventory differs")
    for name in MANIFESTS:
        path = source / name
        if not path.is_file() or path.is_symlink() or sha(path, False) != files[name]:
            raise ValueError(f"rendered manifest differs from receipt: {name}")
        documents = [item for item in yaml.safe_load_all(path.read_text()) if item]
        if any(item.get("kind") == "Secret" for item in documents):
            raise ValueError("code-plane Git state must not contain Secrets")

    protected = {}
    for name in MANIFESTS:
        documents = [item for item in yaml.safe_load_all((source / name).read_text()) if item]
        for item in documents:
            identity = (item.get("kind"), item.get("metadata", {}).get("name"))
            if identity in {
                ("FoundationDBCluster", rendered["managementId"]),
                ("FoundationDBBackup", f'{rendered["managementId"]}-continuous'),
                ("Service", "worker-registry-private"),
            }:
                item.setdefault("metadata", {}).setdefault("annotations", {})["argocd.argoproj.io/sync-options"] = "Prune=false"
        protected[name] = yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False).encode()
    kustomization = {
        "apiVersion": "kustomize.config.k8s.io/v1beta1", "kind": "Kustomization",
        "resources": list(MANIFESTS),
    }
    evidence = {
        "schema": "actor-regional-code-plane-desired-evidence/v1",
        "managementId": rendered["managementId"],
        "renderReceiptSha256": sha(render_receipt_path),
        "installReceiptSha256": sha(install_receipt_path),
        "adoptionIdentity": {
            "fdbClusterUid": installed["foundationDB"]["uid"],
            "fdbBackupUid": installed["foundationDB"]["backup"]["uid"],
            "registryDeploymentUid": installed["registry"]["deploymentUid"],
            "registryPrivateServiceUid": installed["registry"]["privateServiceUid"],
            "registryEndpoint": installed["registry"]["endpoint"],
        },
        "externalSecretUids": installed["externalSecrets"],
    }
    result = protected
    result["kustomization.yaml"] = yaml.safe_dump(kustomization, sort_keys=False).encode()
    result["evidence.json"] = (json.dumps(evidence, indent=2, sort_keys=True) + "\n").encode()
    receipt = {
        "schema": "actor-regional-code-plane-desired-render/v1", "verdict": "passed",
        "managementId": rendered["managementId"], "files": {name: "sha256:" + hashlib.sha256(value).hexdigest() for name, value in sorted(result.items())},
        "sources": evidence,
    }
    return result, receipt


def publish(path: Path, value: bytes) -> None:
    descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value); stream.flush(); os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        try: os.unlink(staged)
        except FileNotFoundError: pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--render-receipt", type=Path, required=True)
    parser.add_argument("--install-receipt", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        if not args.source.is_dir() or args.source.is_symlink(): raise ValueError("source must be a real directory")
        if args.output_dir.exists() or not args.output_dir.parent.is_dir(): raise ValueError("output-dir must be new")
        if not args.receipt.is_absolute() or args.receipt.exists() or not args.receipt.parent.is_dir(): raise ValueError("receipt must be a new absolute path")
        files, receipt = render(args.source, args.render_receipt, args.install_receipt)
        staged = Path(tempfile.mkdtemp(prefix=f".{args.output_dir.name}.", dir=args.output_dir.parent))
        try:
            for name, value in files.items(): (staged / name).write_bytes(value)
            os.rename(staged, args.output_dir)
        finally:
            if staged.exists(): shutil.rmtree(staged)
        publish(args.receipt, (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=os.sys.stderr); return 2
    print(json.dumps({"verdict": "passed", "desiredState": str(args.output_dir)}, sort_keys=True)); return 0


if __name__ == "__main__": raise SystemExit(main())
