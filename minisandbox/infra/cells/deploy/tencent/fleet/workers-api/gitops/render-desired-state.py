#!/usr/bin/env python3
"""Render credential-free Hub Workers API desired state from admitted evidence."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import shutil
import tempfile
import urllib.parse
from typing import Any

import yaml


EXPECTED_RESOURCES = {
    ("Namespace", "", "workers-api-system"),
    ("ServiceAccount", "workers-api-system", "workers-api"),
    ("ClusterRole", "", "workers-api-placement-reader"),
    ("ClusterRoleBinding", "", "workers-api-placement-reader"),
    ("Role", "workers-api-system", "workers-api-route-reader"),
    ("RoleBinding", "workers-api-system", "workers-api-route-reader"),
    ("ConfigMap", "workers-api-system", "workers-api"),
    ("PodDisruptionBudget", "workers-api-system", "workers-api"),
    ("Deployment", "workers-api-system", "workers-api"),
    ("HorizontalPodAutoscaler", "workers-api-system", "workers-api"),
    ("Service", "workers-api-system", "workers-api"),
    ("Service", "workers-api-system", "workers-object-router"),
}
TENCENT_ID = re.compile(r"^(?:subnet|sg|lb)-[A-Za-z0-9]+$")
DNS_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
GIT_REVISION = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
CREDENTIAL_NAME = re.compile(r"^workers-api-internal-token-[0-9a-f]{12}$")


def load(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain one JSON object")
    return value


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def digest(path: pathlib.Path) -> str:
    return digest_bytes(path.read_bytes())


def identity(document: dict[str, Any]) -> tuple[str, str, str]:
    metadata = document.get("metadata", {})
    return document.get("kind", ""), metadata.get("namespace", ""), metadata.get("name", "")


def render(
    manifest_path: pathlib.Path,
    render_receipt_path: pathlib.Path,
    credential_receipt_path: pathlib.Path,
    endpoint_path: pathlib.Path,
    object_router_endpoint_path: pathlib.Path | None,
    admission_path: pathlib.Path | None = None,
    prior_convergence_path: pathlib.Path | None = None,
) -> tuple[dict[str, bytes], dict[str, Any]]:
    manifest_bytes = manifest_path.read_bytes()
    if (admission_path is None) == (prior_convergence_path is None):
        raise ValueError("choose exactly one Workers API release authorization")
    render_receipt, credential_receipt, endpoint = map(
        load, (render_receipt_path, credential_receipt_path, endpoint_path)
    )
    phase = render_receipt.get("phase")
    if phase not in {"object-router-bootstrap", "serving"}:
        raise ValueError("Workers API render phase is invalid")
    object_router_endpoint = load(object_router_endpoint_path) if object_router_endpoint_path else None
    if (render_receipt.get("schema"), render_receipt.get("verdict")) != ("actor-workers-api-render/v1", "passed"):
        raise ValueError("Workers API render receipt did not pass")
    if render_receipt.get("manifestSha256") != digest_bytes(manifest_bytes):
        raise ValueError("Workers API manifest differs from its render receipt")
    if (credential_receipt.get("schema"), credential_receipt.get("verdict")) != (
        "actor-workers-api-credential-sync/v1", "passed",
    ):
        raise ValueError("Workers API credential synchronization did not pass")
    rendered_credential = render_receipt.get("credentialReceipt", {})
    live_credential = credential_receipt.get("credential", {})
    if (
        rendered_credential.get("sha256") != digest(credential_receipt_path)
        or rendered_credential.get("name") != live_credential.get("name")
        or rendered_credential.get("uid") != live_credential.get("uid")
        or rendered_credential.get("resourceVersion") != live_credential.get("resourceVersion")
        or not CREDENTIAL_NAME.fullmatch(live_credential.get("name", ""))
        or live_credential.get("namespace") != "workers-api-system"
        or live_credential.get("immutable") is not True
    ):
        raise ValueError("Workers API render does not bind the synchronized credential")
    if (endpoint.get("schema"), endpoint.get("verdict")) != (
        "actor-workers-api-private-endpoint-installation/v3", "installed",
    ):
        raise ValueError("private endpoint installation receipt did not pass")
    if phase == "serving":
        if object_router_endpoint is None or (
            object_router_endpoint.get("schema"), object_router_endpoint.get("verdict")
        ) != ("actor-object-router-private-endpoint/v1", "passed"):
            raise ValueError("Object Router endpoint installation receipt did not pass")
    elif object_router_endpoint is not None:
        raise ValueError("Object Router bootstrap must precede private endpoint installation")
    service = endpoint.get("service", {})
    router_service = object_router_endpoint.get("service", {}) if object_router_endpoint else {}
    if admission_path is not None:
        if phase != "serving":
            raise ValueError("Object Router bootstrap cannot use final public admission")
        admission = load(admission_path)
        if (admission.get("schema"), admission.get("verdict")) != ("actor-public-admission-chain/v1", "passed"):
            raise ValueError("public admission chain did not pass")
        admission_sources = admission.get("sourceReceipts", {})
        if (
            admission_sources.get("render") != digest(render_receipt_path)
            or admission_sources.get("endpoint_install") != digest(endpoint_path)
        ):
            raise ValueError("public admission does not bind the exact desired-state inputs")
        if admission.get("live", {}).get("privateEndpoint") != endpoint.get("endpoint"):
            raise ValueError("public admission and endpoint installation differ")
        deployment_uid = admission.get("live", {}).get("workersApi", {}).get("deploymentUid")
        assert object_router_endpoint is not None
        if object_router_endpoint.get("deployment", {}).get("uid") != deployment_uid:
            raise ValueError("Object Router endpoint is not bound to the admitted Workers API Deployment")
        authorization = {
            "releaseMode": "bootstrap-adoption",
            "publicAdmissionReceiptSha256": digest(admission_path),
        }
    else:
        assert prior_convergence_path is not None
        prior = load(prior_convergence_path)
        if (prior.get("schema"), prior.get("verdict")) != (
            "actor-management-workers-api-argocd-convergence/v1", "passed",
        ):
            raise ValueError("prior Workers API Argo convergence did not pass")
        prior_revision = prior.get("gitRevision", "")
        adopted = prior.get("adoptedResources", {})
        deployment_uid = adopted.get("deploymentUid")
        if (
            not GIT_REVISION.fullmatch(prior_revision)
            or prior.get("endpoint") != endpoint.get("endpoint")
            or adopted.get("privateServiceUid") != service.get("uid")
            or not isinstance(deployment_uid, str)
            or not deployment_uid
            or not isinstance(adopted.get("externalSecretUid"), str)
            or not adopted["externalSecretUid"]
        ):
            raise ValueError("prior Workers API convergence identity differs")
        prior_secret_uid = adopted["externalSecretUid"]
        current_secret_uid = live_credential.get("uid")
        if prior_secret_uid != current_secret_uid:
            replacement = credential_receipt.get("bootstrapReplacement", {})
            if (
                phase != "object-router-bootstrap" or replacement.get("performed") is not True
                or replacement.get("priorUid") != prior_secret_uid
                or replacement.get("existingCapabilitiesPreserved") is not True
                or replacement.get("replacedInPlace") is not False
            ):
                raise ValueError("Workers API external credential changed outside bootstrap fencing")
        if phase == "serving":
            assert object_router_endpoint is not None
            if (
                prior.get("objectRouterEndpoint") not in (None, object_router_endpoint.get("endpoint"))
                or object_router_endpoint.get("deployment", {}).get("uid") != deployment_uid
            ):
                raise ValueError("Object Router endpoint is not bound to the prior Deployment")
        authorization = {
            "releaseMode": "argocd-update",
            "priorConvergenceReceiptSha256": digest(prior_convergence_path),
            "priorArgoRevision": prior_revision,
            "priorExternalSecretUid": prior_secret_uid,
            "externalSecretUid": current_secret_uid,
        }

    documents = [item for item in yaml.safe_load_all(manifest_bytes) if item]
    if {identity(item) for item in documents} != EXPECTED_RESOURCES or len(documents) != len(EXPECTED_RESOURCES):
        raise ValueError("Workers API manifest resource inventory differs")
    if any(item.get("kind") == "Secret" for item in documents):
        raise ValueError("Workers API desired state must remain credential-free")
    deployment = next(item for item in documents if identity(item) == ("Deployment", "workers-api-system", "workers-api"))
    hpa = next(item for item in documents if identity(item) == ("HorizontalPodAutoscaler", "workers-api-system", "workers-api"))
    workers_config = next(item for item in documents if identity(item) == ("ConfigMap", "workers-api-system", "workers-api"))
    pod = deployment["spec"]["template"]["spec"]
    container = pod["containers"][0]
    secret_refs = [
        item.get("valueFrom", {}).get("secretKeyRef")
        for workload_container in pod.get("initContainers", []) + pod.get("containers", [])
        for item in workload_container.get("env", [])
        if item.get("valueFrom", {}).get("secretKeyRef") is not None
    ]
    expected_secret_keys = {
        "registry-token", "engine-a-token", "engine-b-token",
        "object-router-a-token", "object-router-b-token",
    }
    if phase == "serving":
        expected_secret_keys |= {"stateless-a-token", "stateless-b-token"}
    if (
        len(secret_refs) != len(expected_secret_keys)
        or {item.get("key") for item in secret_refs} != expected_secret_keys
        or {item.get("name") for item in secret_refs} != {live_credential["name"]}
    ):
        raise ValueError("Workers API manifest does not bind the exact versioned credential")
    release_annotation = deployment.get("spec", {}).get("template", {}).get("metadata", {}).get("annotations", {}).get(
        "fleet.actor.dev/release-phase"
    )
    topology_annotation = deployment.get("spec", {}).get("template", {}).get("metadata", {}).get("annotations", {}).get(
        "fleet.actor.dev/topology-policy"
    )
    stateless_args = [item for item in container.get("args", []) if item.startswith("--stateless-executor-token=")]
    stateless_env = {item.get("name") for item in container.get("env", [])} & {"STATELESS_A_TOKEN", "STATELESS_B_TOKEN"}
    if (
        pod.get("terminationGracePeriodSeconds") != 50
        or container.get("lifecycle", {}).get("preStop", {}).get("sleep", {}).get("seconds") != 30
        or container.get("image") != render_receipt.get("workersApiImage")
        or release_annotation != phase
        or topology_annotation != "zone-drain-first-v1"
        or deployment.get("spec", {}).get("strategy", {}).get("rollingUpdate") != {
            "maxUnavailable": 1, "maxSurge": 0,
        }
    ):
        raise ValueError("Workers API manifest lacks its admitted image, topology or drain contract")
    if phase == "object-router-bootstrap" and (stateless_args or stateless_env):
        raise ValueError("Object Router bootstrap manifest exposes stateless dispatch capabilities")
    if phase == "serving" and (len(stateless_args) != 2 or stateless_env != {"STATELESS_A_TOKEN", "STATELESS_B_TOKEN"}):
        raise ValueError("serving manifest lacks its stateless dispatch capabilities")
    hpa_spec = hpa.get("spec", {})
    pod_metrics = {
        item.get("pods", {}).get("metric", {}).get("name")
        for item in hpa_spec.get("metrics", []) if item.get("type") == "Pods"
    }
    if (
        hpa_spec.get("scaleTargetRef") != {"apiVersion": "apps/v1", "kind": "Deployment", "name": "workers-api"}
        or hpa_spec.get("minReplicas") != 3 or hpa_spec.get("maxReplicas") != 30
        or pod_metrics != {"workers_api_routing_requests_per_second", "workers_api_routing_requests_in_flight"}
        or hpa_spec.get("behavior", {}).get("scaleDown", {}).get("stabilizationWindowSeconds") != 300
    ):
        raise ValueError("Workers API manifest lacks its bounded routing-capacity contract")
    cell_names = sorted(item.get("cell", "") for item in render_receipt.get("cells", []))
    configured_cells = sorted(workers_config.get("data", {}).get(key, "") for key in ("engine-cell-a", "engine-cell-b"))
    if len(cell_names) != 2 or len(set(cell_names)) != 2 or cell_names != configured_cells or not all(
        DNS_NAME.fullmatch(name) for name in cell_names
    ):
        raise ValueError("Workers API Cell route inventory is invalid")
    route_configmaps = [f"actor-cell-route-{name}" for name in cell_names]
    if phase == "serving":
        route_configmaps += [f"actor-cell-serving-route-{name}" for name in cell_names]
    route_configmaps.sort()
    network = endpoint.get("network", {})
    parsed_endpoint = urllib.parse.urlsplit(endpoint.get("endpoint", ""))
    try:
        endpoint_address = ipaddress.ip_address(parsed_endpoint.hostname or "")
    except ValueError as error:
        raise ValueError("private endpoint must use an IP address") from error
    if (
        parsed_endpoint.scheme != "http"
        or parsed_endpoint.port != 6688
        or parsed_endpoint.path not in ("", "/")
        or parsed_endpoint.query
        or parsed_endpoint.fragment
        or not endpoint_address.is_private
        or service.get("listenerPort") != 6688
        or service.get("externalTrafficPolicy") != "Cluster"
    ):
        raise ValueError("private endpoint does not implement the production listener contract")
    if not all(TENCENT_ID.fullmatch(network.get(key, "")) for key in ("subnetId", "securityGroupId", "loadBalancerId")):
        raise ValueError("private endpoint cloud identities are invalid")
    source_cidrs = network.get("sourceCidrs", [])
    if not isinstance(source_cidrs, list) or not 1 <= len(source_cidrs) <= 16:
        raise ValueError("private endpoint source ranges are invalid")
    normalized_cidrs = []
    for value in source_cidrs:
        cidr = ipaddress.ip_network(value, strict=False)
        if cidr.version != 4 or cidr.prefixlen < 12 or cidr.is_unspecified or cidr.is_multicast or cidr.is_loopback:
            raise ValueError("private endpoint source range is unsafe")
        normalized_cidrs.append(str(cidr))
    if normalized_cidrs != sorted(set(normalized_cidrs)):
        raise ValueError("private endpoint source ranges are not canonical and unique")
    private_service = {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {
            "name": "workers-api-private",
            "namespace": "workers-api-system",
            "labels": {
                "app.kubernetes.io/name": "workers-api",
                "app.kubernetes.io/part-of": "rivet-workers-api",
                "app.kubernetes.io/managed-by": "argocd",
                "service.cloud.tencent.com/loadbalance-type": "INTERNAL",
            },
            "annotations": {
                "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid": network["subnetId"],
                "service.cloud.tencent.com/security-groups": network["securityGroupId"],
                "service.cloud.tencent.com/pass-to-target": "true",
            },
        },
        "spec": {
            "type": "LoadBalancer",
            "externalTrafficPolicy": "Cluster",
            "loadBalancerSourceRanges": normalized_cidrs,
            "selector": {"app.kubernetes.io/name": "workers-api"},
            "ports": [{"name": "http", "port": 6688, "protocol": "TCP", "targetPort": "http"}],
        },
    }
    private_bytes = yaml.safe_dump(private_service, sort_keys=True).encode()

    router_endpoint = ""
    object_router_private_bytes: bytes | None = None
    if object_router_endpoint is not None:
        router_network = object_router_endpoint.get("network", {})
        router_endpoint = str(object_router_endpoint.get("endpoint", ""))
        router_host, separator, router_port = router_endpoint.rpartition(":")
        try:
            router_address = ipaddress.ip_address(router_host)
        except ValueError as error:
            raise ValueError("Object Router endpoint must use an IP address") from error
        if (
            not separator or router_port != "19085" or not router_address.is_private
            or router_service.get("listenerPort") != 19085
            or router_service.get("targetPort") != "object-router"
            or not all(TENCENT_ID.fullmatch(router_network.get(key, "")) for key in ("subnetId", "securityGroupId", "loadBalancerId"))
        ):
            raise ValueError("Object Router endpoint does not implement the private listener contract")
        router_source_cidrs = []
        for value in router_network.get("sourceCidrs", []):
            cidr = ipaddress.ip_network(value, strict=False)
            if cidr.version != 4 or cidr.prefixlen < 12 or cidr.is_unspecified or cidr.is_multicast or cidr.is_loopback:
                raise ValueError("Object Router endpoint source range is unsafe")
            router_source_cidrs.append(str(cidr))
        if not 1 <= len(router_source_cidrs) <= 16 or router_source_cidrs != sorted(set(router_source_cidrs)):
            raise ValueError("Object Router endpoint source ranges are invalid")
        object_router_private_service = {
            "apiVersion": "v1", "kind": "Service",
            "metadata": {
                "name": "workers-object-router-private", "namespace": "workers-api-system",
                "labels": {
                    "app.kubernetes.io/name": "workers-object-router",
                    "app.kubernetes.io/part-of": "rivet-workers-api",
                    "app.kubernetes.io/managed-by": "argocd",
                    "service.cloud.tencent.com/loadbalance-type": "INTERNAL",
                },
                "annotations": {
                    "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid": router_network["subnetId"],
                    "service.cloud.tencent.com/security-groups": router_network["securityGroupId"],
                    "service.cloud.tencent.com/pass-to-target": "true",
                },
            },
            "spec": {
                "type": "LoadBalancer", "externalTrafficPolicy": "Cluster",
                "loadBalancerSourceRanges": router_source_cidrs,
                "selector": {"app.kubernetes.io/name": "workers-api"},
                "ports": [{"name": "object-router", "port": 19085, "protocol": "TCP", "targetPort": "object-router"}],
            },
        }
        object_router_private_bytes = yaml.safe_dump(object_router_private_service, sort_keys=True).encode()
    resources = ["workers-api.yaml", "private-endpoint.yaml"]
    if object_router_private_bytes is not None:
        resources.append("private-object-router-endpoint.yaml")
    kustomization = yaml.safe_dump(
        {
            "apiVersion": "kustomize.config.k8s.io/v1beta1",
            "kind": "Kustomization",
            "resources": resources,
        },
        sort_keys=False,
    ).encode()
    evidence = {
        "schema": "actor-management-workers-api-desired-evidence/v1",
        "phase": phase,
        "workersApiRenderReceiptSha256": digest(render_receipt_path),
        "credentialReceiptSha256": digest(credential_receipt_path),
        "endpointInstallationReceiptSha256": digest(endpoint_path),
        "objectRouterEndpointReceiptSha256": digest(object_router_endpoint_path) if object_router_endpoint_path else None,
        "workersApiImage": render_receipt["workersApiImage"],
        "endpointServiceUidAtAdoption": service["uid"],
        "objectRouterServiceUidAtAdoption": router_service.get("uid"),
        "objectRouterEndpoint": router_endpoint,
        "deploymentUidAtAdoption": deployment_uid,
        "externalCredentialName": live_credential["name"],
        "externalRouteConfigMaps": route_configmaps,
        **authorization,
    }
    evidence_bytes = (json.dumps(evidence, indent=2, sort_keys=True) + "\n").encode()
    files = {
        "workers-api.yaml": manifest_bytes,
        # Keep the immutable product render input beside the desired state.
        # A digest in evidence.json is insufficient if the referenced receipt
        # is later lost from an operator scratch directory.
        "workers-api-render.json": render_receipt_path.read_bytes(),
        "private-endpoint.yaml": private_bytes,
        "kustomization.yaml": kustomization,
        "evidence.json": evidence_bytes,
    }
    if object_router_private_bytes is not None:
        files["private-object-router-endpoint.yaml"] = object_router_private_bytes
    receipt = {
        "schema": "actor-management-workers-api-desired-render/v1",
        "verdict": "passed",
        "files": {name: digest_bytes(content) for name, content in sorted(files.items())},
        "sources": evidence,
    }
    return files, receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=pathlib.Path)
    parser.add_argument("--render-receipt", required=True, type=pathlib.Path)
    parser.add_argument("--credential-receipt", required=True, type=pathlib.Path)
    parser.add_argument("--endpoint-installation", required=True, type=pathlib.Path)
    parser.add_argument("--object-router-endpoint-installation", type=pathlib.Path)
    authorization = parser.add_mutually_exclusive_group(required=True)
    authorization.add_argument("--public-admission", type=pathlib.Path)
    authorization.add_argument("--prior-convergence", type=pathlib.Path)
    parser.add_argument("--output-dir", required=True, type=pathlib.Path)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    args = parser.parse_args()
    authorization_path = args.public_admission or args.prior_convergence
    inputs = (
        args.manifest, args.render_receipt, args.credential_receipt, args.endpoint_installation,
        authorization_path,
    )
    if args.object_router_endpoint_installation is not None:
        inputs += (args.object_router_endpoint_installation,)
    if any(not item.is_file() or item.is_symlink() for item in inputs):
        parser.error("all desired-state inputs must be regular non-symlink files")
    if args.output_dir.exists() or not args.output_dir.parent.is_dir():
        parser.error("output directory must be new with an existing parent")
    if not args.receipt.is_absolute() or args.receipt.exists() or not args.receipt.parent.is_dir():
        parser.error("receipt must be a new absolute path with an existing parent")
    files, receipt = render(
        args.manifest,
        args.render_receipt,
        args.credential_receipt,
        args.endpoint_installation,
        args.object_router_endpoint_installation,
        admission_path=args.public_admission,
        prior_convergence_path=args.prior_convergence,
    )
    staged: pathlib.Path | None = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{args.output_dir.name}.", dir=args.output_dir.parent)
    )
    try:
        for name, content in files.items():
            assert staged is not None
            (staged / name).write_bytes(content)
            os.chmod(staged / name, 0o644)
        assert staged is not None
        os.rename(staged, args.output_dir)
        staged = None
        descriptor, temporary = tempfile.mkstemp(prefix=f".{args.receipt.name}.", dir=args.receipt.parent)
        try:
            os.fchmod(descriptor, 0o644)
            with os.fdopen(descriptor, "w") as stream:
                json.dump(receipt, stream, indent=2, sort_keys=True)
                stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
            os.link(temporary, args.receipt)
        finally:
            try: os.unlink(temporary)
            except FileNotFoundError: pass
    finally:
        if staged is not None and staged.exists():
            shutil.rmtree(staged)
    print(json.dumps({"desiredState": str(args.output_dir), "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
