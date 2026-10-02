#!/usr/bin/env python3
"""Adopt one qualified Terraform/Argo Cell into an exact central Claim."""

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
CELL = re.compile(r"^actor-[a-z0-9]+-[a-z][0-9]{2}$")
NAMESPACE = "actor-fdb-cell-system"
HUB_NAMESPACE = "actor-fleet-system"
CONTROLLER_NAMESPACE = "actor-fleet-controller-system"


def load(path: Path, name: str) -> Dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def nested(value: Dict[str, Any], *path: str) -> Any:
    current: Any = value
    for name in path:
        if not isinstance(current, dict) or name not in current:
            raise ValueError("missing field: " + ".".join(path))
        current = current[name]
    return current


def text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be non-empty text")
    return value


def kubectl(kubeconfig: Path, *args: str, stdin: Optional[Dict[str, Any]] = None, check: bool = True) -> Optional[Dict[str, Any]]:
    command = ["kubectl", "--kubeconfig", str(kubeconfig), *args, "-o", "json"]
    result = subprocess.run(command, input=None if stdin is None else json.dumps(stdin), universal_newlines=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        if check:
            raise RuntimeError(result.stderr.strip() or "kubectl failed")
        return None
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("kubectl output is not an object")
    return value


def create_or_get(kubeconfig: Path, namespace: str, kind: str, name: str, manifest: Dict[str, Any]) -> Dict[str, Any]:
    command = ["kubectl", "--kubeconfig", str(kubeconfig), "create", "-f", "-", "-o", "json"]
    result = subprocess.run(command, input=json.dumps(manifest), universal_newlines=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode == 0:
        value = json.loads(result.stdout)
        if not isinstance(value, dict):
            raise ValueError("kubectl create output is not an object")
        return value
    if "AlreadyExists" not in result.stderr:
        raise RuntimeError(result.stderr.strip() or f"create {kind}/{name} failed")
    existing = kubectl(kubeconfig, "-n", namespace, "get", kind, name)
    assert existing is not None
    return existing


REGISTRATION_IDENTITY_FIELDS = (
    "provider", "claimRef", "poolRef", "spokeClusterRef", "spokeCellRef",
    "credentialSecretRef", "datacenterName",
)


def registration_identity(spec: Dict[str, Any]) -> Dict[str, Any]:
    return {field: spec.get(field) for field in REGISTRATION_IDENTITY_FIELDS}


def create_or_rotate_registration(
    kubeconfig: Path, desired: Dict[str, Any]
) -> Dict[str, Any]:
    """Create a Cell identity or CAS-rotate only its release evidence."""
    metadata = desired["metadata"]
    name = text(metadata.get("name"), "registration name")
    namespace = text(metadata.get("namespace"), "registration namespace")
    actual = create_or_get(
        kubeconfig, namespace, "rivetcellregistration", name, desired,
    )
    actual_spec = nested(actual, "spec")
    desired_spec = nested(desired, "spec")
    if actual_spec == desired_spec:
        return actual
    if registration_identity(actual_spec) != registration_identity(desired_spec):
        raise ValueError("existing Cell registration identity differs")
    desired_labels = metadata.get("labels", {})
    actual_labels = nested(actual, "metadata").get("labels", {})
    for key, value in desired_labels.items():
        if actual_labels.get(key) != value:
            raise ValueError("existing Cell registration labels differ")
    uid = text(nested(actual, "metadata", "uid"), "registration UID")
    resource_version = text(
        nested(actual, "metadata", "resourceVersion"), "registration resourceVersion"
    )
    patch = [
        {"op": "test", "path": "/metadata/uid", "value": uid},
        {"op": "test", "path": "/metadata/resourceVersion", "value": resource_version},
        {"op": "test", "path": "/spec", "value": actual_spec},
        {"op": "replace", "path": "/spec/evidence", "value": desired_spec["evidence"]},
        {"op": "replace", "path": "/spec/registeredAt", "value": desired_spec["registeredAt"]},
    ]
    rotated = kubectl(
        kubeconfig, "-n", namespace, "patch", "rivetcellregistration", name,
        "--type=json", "-p", json.dumps(patch, separators=(",", ":")),
    )
    assert rotated is not None
    if nested(rotated, "metadata", "uid") != uid or nested(rotated, "spec") != desired_spec:
        raise ValueError("Cell registration evidence rotation did not converge exactly")
    return rotated


def validate_evidence(
    convergence: Dict[str, Any], qualification: Dict[str, Any], activation: Dict[str, Any],
    convergence_digest: str, qualification_digest: str,
) -> Dict[str, str]:
    if (convergence.get("schema"), convergence.get("verdict")) != ("actor-cell-argo-convergence/v1", "passed"):
        raise ValueError("Argo convergence receipt did not pass")
    if (activation.get("schema"), activation.get("verdict")) != ("actor-cell-qualification-activation/v1", "passed"):
        raise ValueError("qualification activation receipt did not pass")
    if (
        (qualification.get("schema"), qualification.get("verdict"))
        != ("actor-cell-qualification-chain/v1", "passed")
        or qualification.get("placement_opened") is not False
        or qualification.get("operator_activation_required") is not True
    ):
        raise ValueError("pre-activation qualification chain did not pass")
    if not DIGEST.fullmatch(convergence_digest) or not DIGEST.fullmatch(qualification_digest):
        raise ValueError("qualification evidence digest is invalid")
    binding = nested(convergence, "fleetBinding")
    cell = text(nested(convergence, "cell", "id"), "convergence Cell")
    if not CELL.fullmatch(cell) or activation.get("cell") != cell:
        raise ValueError("activation and convergence Cell identities differ")
    cell_uid = text(nested(convergence, "cell", "uid"), "convergence Cell UID")
    if nested(activation, "cell_identity", "uid") != cell_uid:
        raise ValueError("activation and convergence Cell UIDs differ")
    if (
        nested(qualification, "cell", "id") != cell
        or nested(qualification, "cell", "spoke_uid") != cell_uid
        or nested(qualification, "pool", "name") != binding.get("poolName")
        or nested(qualification, "pool", "uid") != binding.get("poolUid")
        or nested(qualification, "construction", "argo_convergence_receipt_digest") != convergence_digest
    ):
        raise ValueError("qualification chain and convergence identities differ")
    profile = text(nested(convergence, "cell", "profileDigest"), "profile digest")
    release = text(nested(activation, "qualification", "release_digest"), "release digest")
    if nested(activation, "cell_identity", "profile_digest") != profile or binding.get("profileDigest") != profile:
        raise ValueError("qualified profile identities differ")
    if not DIGEST.fullmatch(profile) or not DIGEST.fullmatch(release):
        raise ValueError("qualified evidence has an invalid digest")
    control_sha = text(activation.get("control_receipt_sha256"), "activation control receipt digest")
    if (
        nested(qualification, "qualification", "release_digest") != release
        or nested(qualification, "qualification", "control_receipt_digest") != "sha256:" + control_sha
    ):
        raise ValueError("activation differs from the reviewed qualification chain")
    datacenter = text(binding.get("datacenterName"), "datacenter name")
    if not re.fullmatch(r"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$", datacenter):
        raise ValueError("datacenter name must be a DNS label")
    if activation.get("desired_state") != "Ready" or activation.get("ready_for_placement") is not True:
        raise ValueError("activation did not finish Ready for placement")
    finished = text(activation.get("finished_at"), "activation finished_at")
    datetime.strptime(finished, "%Y-%m-%dT%H:%M:%SZ")
    return {
        "cell": cell,
        "cell_uid": cell_uid,
        "pool": text(binding.get("poolName"), "pool name"),
        "pool_uid": text(binding.get("poolUid"), "pool UID"),
        "claim": text(binding.get("claimName"), "claim name"),
        "claim_uid": text(binding.get("claimUid"), "claim UID"),
        "class": text(binding.get("className"), "class name"),
        "datacenter": datacenter,
        "profile": profile,
        "release": release,
        "registered_at": finished,
        "platform_cluster_uid": text(convergence.get("platformClusterUid"), "platform cluster UID"),
    }


def build_registration(
    identity: Dict[str, str], credential_name: str, credential_uid: str,
    convergence_digest: str, qualification_digest: str, activation_digest: str,
) -> Dict[str, Any]:
    return {
        "apiVersion": "fleet.actor.dev/v1alpha1", "kind": "RivetCellRegistration",
        "metadata": {
            "name": identity["cell"], "namespace": HUB_NAMESPACE,
            "labels": {
                "fleet.actor.dev/claim-uid": identity["claim_uid"],
                "fleet.actor.dev/pool": identity["pool"],
                "app.kubernetes.io/managed-by": "actor-cell-adoption",
            },
        },
        "spec": {
            "provider": "TerraformArgo",
            "claimRef": {"name": identity["claim"], "uid": identity["claim_uid"]},
            "poolRef": {"name": identity["pool"], "uid": identity["pool_uid"]},
            "spokeClusterRef": {"name": identity["cell"], "uid": identity["platform_cluster_uid"]},
            "spokeCellRef": {"name": identity["cell"], "namespace": NAMESPACE, "uid": identity["cell_uid"]},
            "credentialSecretRef": {"namespace": CONTROLLER_NAMESPACE, "name": credential_name, "uid": credential_uid, "key": "kubeconfig"},
            "evidence": {
                "profileDigest": identity["profile"], "releaseDigest": identity["release"],
                "convergenceReceiptDigest": convergence_digest,
                "qualificationChainReceiptDigest": qualification_digest,
                "activationReceiptDigest": activation_digest,
            },
            "datacenterName": identity["datacenter"], "registeredAt": identity["registered_at"],
        },
    }


def verify_live(identity: Dict[str, str], hub: Path, spoke: Path) -> Tuple[Dict[str, Any], str, str, str]:
    pool = kubectl(hub, "-n", HUB_NAMESPACE, "get", "shardpool", identity["pool"])
    claim = kubectl(hub, "-n", HUB_NAMESPACE, "get", "rivetcellclaim", identity["claim"])
    cell = kubectl(spoke, "-n", NAMESPACE, "get", "rivetcell", identity["cell"])
    cluster_ns = kubectl(spoke, "get", "namespace", "kube-system")
    assert pool and claim and cell and cluster_ns
    if nested(pool, "metadata", "uid") != identity["pool_uid"]:
        raise ValueError("live Pool UID differs from convergence evidence")
    if nested(claim, "metadata", "uid") != identity["claim_uid"] or nested(claim, "spec", "poolRef", "uid") != identity["pool_uid"]:
        raise ValueError("live Claim identity differs from convergence evidence")
    if nested(claim, "spec", "className") != identity["class"]:
        raise ValueError("live Claim class differs")
    if nested(cell, "metadata", "uid") != identity["cell_uid"] or nested(cell, "status", "profileDigest") != identity["profile"]:
        raise ValueError("live spoke Cell identity differs from qualified evidence")
    if nested(cell, "status", "phase") != "Ready" or nested(cell, "status", "readyForPlacement") is not True:
        raise ValueError("live spoke Cell is not ready")
    if nested(cluster_ns, "metadata", "uid") != identity["platform_cluster_uid"]:
        raise ValueError("live spoke Kubernetes UID differs")

    config = kubectl(spoke, "config", "view", "--raw")
    assert config
    context_name = text(config.get("current-context"), "kubeconfig context")
    context = next(item["context"] for item in config["contexts"] if item["name"] == context_name)
    cluster = next(item["cluster"] for item in config["clusters"] if item["name"] == context["cluster"])
    return cell, text(cluster.get("server"), "spoke API server"), text(cluster.get("certificate-authority-data"), "spoke CA"), str(cluster.get("tls-server-name", ""))


def apply_rbac(spoke: Path, cell: str, template: Path) -> None:
    rendered = template.read_text().replace("__CELL_ID__", cell)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", dir="/data/tmp", delete=False) as stream:
        stream.write(rendered)
        path = Path(stream.name)
    try:
        result = subprocess.run(["kubectl", "--kubeconfig", str(spoke), "apply", "-f", str(path)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "apply adoption RBAC failed")
    finally:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def publish_new(path: Path, value: Dict[str, Any]) -> None:
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
            Path(temporary).unlink()
        except FileNotFoundError:
            pass


def publish_or_verify(path: Path, value: Dict[str, Any]) -> str:
    if path.is_symlink():
        raise ValueError("adoption receipt must not be a symlink")
    if not path.exists():
        try:
            publish_new(path, value)
            return "published"
        except FileExistsError:
            # A concurrent identical adoption may win the no-overwrite link.
            # It must pass the same stable comparison below.
            pass
    if path.is_symlink():
        raise ValueError("adoption receipt must not be a symlink")
    if not path.is_file():
        raise ValueError("existing adoption receipt is not a regular file")
    existing = load(path, "existing adoption receipt")
    issued = text(existing.get("issuedAt"), "existing adoption issuedAt")
    issued_at = datetime.fromisoformat(issued.replace("Z", "+00:00"))
    if not issued.endswith("Z") or issued_at.utcoffset() != timezone.utc.utcoffset(issued_at):
        raise ValueError("existing adoption issuedAt is not UTC")
    expected_stable = {key: item for key, item in value.items() if key != "issuedAt"}
    existing_stable = {key: item for key, item in existing.items() if key != "issuedAt"}
    if existing_stable != expected_stable:
        raise ValueError("existing adoption receipt differs from exact live adoption")
    return "verified"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub-kubeconfig", required=True, type=Path)
    parser.add_argument("--cell-kubeconfig", required=True, type=Path)
    parser.add_argument("--convergence-receipt", required=True, type=Path)
    parser.add_argument("--qualification-chain", required=True, type=Path)
    parser.add_argument("--activation-receipt", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    for path in (
        args.hub_kubeconfig, args.cell_kubeconfig, args.convergence_receipt,
        args.qualification_chain, args.activation_receipt,
    ):
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            parser.error("adoption inputs must be absolute regular non-symlink files")
    if not args.receipt.is_absolute():
        parser.error("--receipt must be an absolute path")
    convergence = load(args.convergence_receipt, "convergence receipt")
    qualification = load(args.qualification_chain, "qualification chain")
    activation = load(args.activation_receipt, "activation receipt")
    convergence_digest = sha256(args.convergence_receipt)
    qualification_digest = sha256(args.qualification_chain)
    activation_digest = sha256(args.activation_receipt)
    identity = validate_evidence(
        convergence, qualification, activation, convergence_digest, qualification_digest,
    )
    _, server, ca_data, tls_name = verify_live(identity, args.hub_kubeconfig, args.cell_kubeconfig)
    apply_rbac(args.cell_kubeconfig, identity["cell"], Path(__file__).with_name("adoption-spoke-rbac.yaml"))

    token_secret = None
    for _ in range(60):
        token_secret = kubectl(args.cell_kubeconfig, "-n", NAMESPACE, "get", "secret", "actor-fleet-adopter-token", check=False)
        if token_secret and isinstance(token_secret.get("data"), dict) and token_secret["data"].get("token"):
            break
        import time
        time.sleep(1)
    assert token_secret
    token = base64.b64decode(text(nested(token_secret, "data", "token"), "adopter token")).decode()
    remote_config = {
        "apiVersion": "v1", "kind": "Config", "current-context": "cell",
        "clusters": [{"name": "cell", "cluster": {"server": server, "certificate-authority-data": ca_data}}],
        "contexts": [{"name": "cell", "context": {"cluster": "cell", "user": "adopter", "namespace": NAMESPACE}}],
        "users": [{"name": "adopter", "user": {"token": token}}],
    }
    if tls_name:
        remote_config["clusters"][0]["cluster"]["tls-server-name"] = tls_name
    credential_name = "actor-cell-provider-" + identity["cell"]
    immutable = {
        "apiVersion": "v1", "kind": "Secret", "metadata": {
            "name": credential_name, "namespace": CONTROLLER_NAMESPACE,
            "labels": {"fleet.actor.dev/external-cell-credential": "true", "fleet.actor.dev/cell": identity["cell"]},
        }, "type": "Opaque", "immutable": True,
        "stringData": {"kubeconfig": json.dumps(remote_config, separators=(",", ":"))},
    }
    credential = create_or_get(
        args.hub_kubeconfig, CONTROLLER_NAMESPACE, "secret", credential_name, immutable,
    )
    if credential.get("immutable") is not True or nested(credential, "metadata", "labels", "fleet.actor.dev/cell") != identity["cell"]:
        raise ValueError("existing provider credential differs")
    encoded_config = nested(credential, "data").get("kubeconfig")
    if not isinstance(encoded_config, str) or base64.b64decode(encoded_config) != immutable["stringData"]["kubeconfig"].encode():
        raise ValueError("existing provider credential payload differs")
    credential_uid = text(nested(credential, "metadata", "uid"), "provider credential UID")

    registration = build_registration(
        identity, credential_name, credential_uid,
        convergence_digest, qualification_digest, activation_digest,
    )
    actual = create_or_rotate_registration(args.hub_kubeconfig, registration)
    if actual.get("spec") != registration["spec"]:
        raise ValueError("Cell registration differs after evidence rotation")
    receipt = {
        "schema": "actor-cell-claim-adoption/v2", "verdict": "passed",
        "cell": {"name": identity["cell"], "uid": identity["cell_uid"]},
        "cluster": {"name": identity["cell"], "uid": identity["platform_cluster_uid"]},
        "pool": {"name": identity["pool"], "uid": identity["pool_uid"]},
        "claim": {"name": identity["claim"], "uid": identity["claim_uid"]},
        "evidence": {
            "convergence": convergence_digest,
            "qualification": qualification_digest,
            "activation": activation_digest,
        },
        "credentialSecret": {"name": credential_name, "uid": credential_uid},
        "registration": {"name": identity["cell"], "uid": text(nested(actual, "metadata", "uid"), "Registration UID")},
        "issuedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    outcome = publish_or_verify(args.receipt, receipt)
    print(json.dumps({"cellAdoption": outcome, "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
