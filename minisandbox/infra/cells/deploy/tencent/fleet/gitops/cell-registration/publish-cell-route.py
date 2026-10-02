#!/usr/bin/env python3
"""Publish one immutable Cell identity route and release-bound route receipt."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
DNS_LABEL = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
ROUTE_LABEL = "fleet.actor.dev/cell-route"


def load(path: Path, name: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def nested(value: dict[str, Any], *path: str) -> Any:
    current: Any = value
    for name in path:
        if not isinstance(current, dict) or name not in current:
            raise ValueError("missing field: " + ".".join(path))
        current = current[name]
    return current


def text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def build_route(
    convergence: dict[str, Any], convergence_digest: str,
    qualification_chain: dict[str, Any], qualification_chain_digest: str,
    activation: dict[str, Any], activation_digest: str,
    adoption: dict[str, Any], adoption_digest: str,
    pool: dict[str, Any], claim: dict[str, Any], cell: dict[str, Any], namespace: str,
) -> dict[str, Any]:
    if convergence.get("schema") != "actor-cell-argo-convergence/v1" or convergence.get("verdict") != "passed":
        raise ValueError("Argo convergence receipt did not pass")
    if nested(convergence, "argo", "project") != "actor-cell-bootstrap" or nested(
        convergence, "argo", "registrationScope"
    ) != "production":
        raise ValueError("Argo convergence did not come from production Cell registration")
    if not DIGEST.fullmatch(convergence_digest):
        raise ValueError("Argo convergence receipt digest is invalid")
    binding = nested(convergence, "fleetBinding")
    if not isinstance(binding, dict):
        raise ValueError("fleetBinding must be an object")
    pool_name = text(binding.get("poolName"), "fleetBinding.poolName")
    pool_uid = text(binding.get("poolUid"), "fleetBinding.poolUid")
    claim_name = text(binding.get("claimName"), "fleetBinding.claimName")
    claim_uid = text(binding.get("claimUid"), "fleetBinding.claimUid")
    datacenter = text(binding.get("datacenterName"), "fleetBinding.datacenterName")
    if not DNS_LABEL.fullmatch(datacenter):
        raise ValueError("fleetBinding.datacenterName is invalid")

    if (
        qualification_chain.get("schema") != "actor-cell-qualification-chain/v1"
        or qualification_chain.get("verdict") != "passed"
        or qualification_chain.get("placement_opened") is not False
        or qualification_chain.get("operator_activation_required") is not True
    ):
        raise ValueError("pre-activation qualification chain is invalid")
    if not all(DIGEST.fullmatch(value) for value in (
        qualification_chain_digest, activation_digest, adoption_digest,
    )):
        raise ValueError("route evidence digest is invalid")
    if (
        nested(qualification_chain, "cell", "id") != nested(convergence, "cell", "id")
        or nested(qualification_chain, "cell", "spoke_uid") != nested(convergence, "cell", "uid")
        or nested(qualification_chain, "pool", "name") != pool_name
        or nested(qualification_chain, "pool", "uid") != pool_uid
        or nested(qualification_chain, "construction", "argo_convergence_receipt_digest") != convergence_digest
    ):
        raise ValueError("pre-activation qualification chain differs from convergence")
    if (
        activation.get("schema") != "actor-cell-qualification-activation/v1"
        or activation.get("verdict") != "passed"
        or activation.get("cell") != nested(convergence, "cell", "id")
        or nested(activation, "cell_identity", "uid") != nested(convergence, "cell", "uid")
        or activation.get("desired_state") != "Ready"
        or activation.get("ready_for_placement") is not True
        or nested(activation, "qualification", "release_digest")
        != nested(qualification_chain, "qualification", "release_digest")
        or "sha256:" + text(activation.get("control_receipt_sha256"), "activation control digest")
        != nested(qualification_chain, "qualification", "control_receipt_digest")
    ):
        raise ValueError("qualification activation differs from the reviewed qualification chain")
    if (
        adoption.get("schema") != "actor-cell-claim-adoption/v2"
        or adoption.get("verdict") != "passed"
        or nested(adoption, "cell", "name") != nested(convergence, "cell", "id")
        or nested(adoption, "cell", "uid") != nested(convergence, "cell", "uid")
        or nested(adoption, "pool", "name") != pool_name
        or nested(adoption, "pool", "uid") != pool_uid
        or nested(adoption, "claim", "name") != claim_name
        or nested(adoption, "claim", "uid") != claim_uid
        or nested(adoption, "evidence", "convergence") != convergence_digest
        or nested(adoption, "evidence", "qualification") != qualification_chain_digest
        or nested(adoption, "evidence", "activation") != activation_digest
    ):
        raise ValueError("central Claim adoption differs from reviewed activation")

    if nested(pool, "metadata", "name") != pool_name or nested(pool, "metadata", "uid") != pool_uid:
        raise ValueError("live ShardPool identity differs from the Terraform binding")
    if nested(claim, "metadata", "name") != claim_name or nested(claim, "metadata", "uid") != claim_uid:
        raise ValueError("live RivetCellClaim identity differs from the Terraform binding")
    if nested(claim, "status", "phase") != "Bound":
        raise ValueError("live RivetCellClaim is not Bound")
    if nested(claim, "spec", "poolRef", "name") != pool_name or nested(claim, "spec", "poolRef", "uid") != pool_uid:
        raise ValueError("live RivetCellClaim belongs to another Pool")
    logical_name = text(nested(claim, "status", "placementDecision", "logicalCellName"), "logical Cell name")
    logical_uid = text(nested(claim, "status", "cellRef", "uid"), "logical Cell UID")
    spoke_uid = text(nested(claim, "status", "spokeCellRef", "uid"), "spoke Cell UID")
    receipt_cell_uid = text(nested(convergence, "cell", "uid"), "convergence Cell UID")
    if spoke_uid != receipt_cell_uid:
        raise ValueError("Claim spoke Cell UID differs from Argo convergence")
    if nested(cell, "metadata", "name") != logical_name or nested(cell, "metadata", "uid") != logical_uid:
        raise ValueError("live logical RivetCell identity differs from the Claim")
    if nested(cell, "metadata", "labels", "fleet.actor.dev/pool") != pool_name:
        raise ValueError("live logical RivetCell belongs to another Pool")
    if nested(cell, "status", "spokeCellRef", "uid") != spoke_uid:
        raise ValueError("live logical RivetCell has not observed the converged spoke Cell")

    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": "actor-cell-route-" + logical_name,
            "namespace": namespace,
            "labels": {ROUTE_LABEL: "true"},
        },
        "immutable": True,
        "data": {
            "pool-name": pool_name,
            "pool-uid": pool_uid,
            "cell-name": logical_name,
            "cell-uid": spoke_uid,
            "datacenter": datacenter,
        },
    }


def verify_existing(expected: dict[str, Any], actual: dict[str, Any]) -> None:
    for name in ("apiVersion", "kind", "immutable", "data"):
        if actual.get(name) != expected.get(name):
            raise ValueError(f"existing Cell route differs: {name}")
    expected_meta = expected["metadata"]
    actual_meta = nested(actual, "metadata")
    for name in ("name", "namespace", "labels"):
        if actual_meta.get(name) != expected_meta.get(name):
            raise ValueError(f"existing Cell route differs: metadata.{name}")


def kubectl_json(kubeconfig: Path, *args: str, stdin: dict[str, Any] | None = None, check: bool = True) -> dict[str, Any] | None:
    result = subprocess.run(
        ("kubectl", "--kubeconfig", str(kubeconfig), *args, "-o", "json"),
        input=None if stdin is None else json.dumps(stdin), text=True, capture_output=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "kubectl failed")
    if result.returncode != 0:
        return None
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("kubectl did not return a JSON object")
    return value


def publish_new(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def publish_or_verify(path: Path, value: dict[str, Any]) -> str:
    if path.is_symlink():
        raise ValueError("route receipt must not be a symlink")
    if not path.exists():
        try:
            publish_new(path, value)
            return "published"
        except FileExistsError:
            # A concurrent identical publisher may win the no-overwrite link.
            # Verify the winner instead of replacing it.
            pass
    if path.is_symlink():
        raise ValueError("route receipt must not be a symlink")
    if not path.is_file():
        raise ValueError("existing route receipt is not a regular file")
    if load(path, "existing route receipt") != value:
        raise ValueError("existing route receipt differs from exact live route")
    return "verified"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub-kubeconfig", required=True, type=Path)
    parser.add_argument("--convergence-receipt", required=True, type=Path)
    parser.add_argument("--qualification-chain", required=True, type=Path)
    parser.add_argument("--activation-receipt", required=True, type=Path)
    parser.add_argument("--adoption-receipt", required=True, type=Path)
    parser.add_argument("--namespace", default="workers-api-system")
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    if not args.hub_kubeconfig.is_file() or any(not path.is_file() for path in (
        args.convergence_receipt, args.qualification_chain,
        args.activation_receipt, args.adoption_receipt,
    )):
        parser.error("kubeconfig and route evidence must be regular files")
    if not args.receipt.is_absolute():
        parser.error("--receipt must be an absolute path")
    if not DNS_LABEL.fullmatch(args.namespace):
        parser.error("--namespace must be a DNS label")

    convergence = load(args.convergence_receipt, "convergence receipt")
    qualification_chain = load(args.qualification_chain, "qualification chain")
    activation = load(args.activation_receipt, "activation receipt")
    adoption = load(args.adoption_receipt, "adoption receipt")
    binding = nested(convergence, "fleetBinding")
    pool_name = text(binding.get("poolName"), "fleetBinding.poolName")
    claim_name = text(binding.get("claimName"), "fleetBinding.claimName")
    pool = kubectl_json(args.hub_kubeconfig, "-n", "actor-fleet-system", "get", "shardpool", pool_name)
    claim = kubectl_json(args.hub_kubeconfig, "-n", "actor-fleet-system", "get", "rivetcellclaim", claim_name)
    assert pool is not None and claim is not None
    logical_name = text(nested(claim, "status", "placementDecision", "logicalCellName"), "logical Cell name")
    cell = kubectl_json(args.hub_kubeconfig, "-n", "actor-fleet-system", "get", "rivetcell", logical_name)
    assert cell is not None
    expected = build_route(
        convergence, digest(args.convergence_receipt),
        qualification_chain, digest(args.qualification_chain),
        activation, digest(args.activation_receipt),
        adoption, digest(args.adoption_receipt),
        pool, claim, cell, args.namespace,
    )
    route_name = expected["metadata"]["name"]
    actual = kubectl_json(args.hub_kubeconfig, "-n", args.namespace, "get", "configmap", route_name, check=False)
    if actual is None:
        actual = kubectl_json(args.hub_kubeconfig, "create", "-f", "-", stdin=expected, check=False)
        if actual is None:
            actual = kubectl_json(args.hub_kubeconfig, "-n", args.namespace, "get", "configmap", route_name)
    assert actual is not None
    verify_existing(expected, actual)
    receipt = {
        "schema": "actor-cell-route-publication/v2",
        "verdict": "passed",
        "convergenceReceiptDigest": digest(args.convergence_receipt),
        "qualificationChainReceiptDigest": digest(args.qualification_chain),
        "activationReceiptDigest": digest(args.activation_receipt),
        "adoptionReceiptDigest": digest(args.adoption_receipt),
        "pool": {"name": expected["data"]["pool-name"], "uid": expected["data"]["pool-uid"]},
        "cell": {"name": expected["data"]["cell-name"], "uid": expected["data"]["cell-uid"]},
        "datacenter": expected["data"]["datacenter"],
        "routeConfigMap": {
            "name": route_name,
            "uid": text(nested(actual, "metadata", "uid"), "route ConfigMap UID"),
            "resourceVersion": text(nested(actual, "metadata", "resourceVersion"), "route ConfigMap resourceVersion"),
        },
    }
    outcome = publish_or_verify(args.receipt, receipt)
    print(json.dumps({"cellRoute": outcome, "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
