import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import render
import yaml


def write(path: Path, value: dict) -> Path:
    path.write_text(json.dumps(value))
    return path


def endpoint(cell: str, uid: str, dc: str, address: str) -> dict:
    return {
        "schema": "actor-engine-private-endpoint/v1", "verdict": "passed",
        "cell": {"name": cell, "uid": uid}, "datacenter": dc,
        "endpoint": f"http://{address}:6420",
        "network": {"subnetId": "subnet-test", "hubSourceCidrs": ["10.160.0.0/16"]},
        "service": {"namespace": "actor-fdb-cell-system", "name": cell + "-engine-private", "uid": "service-" + uid, "resourceVersion": "1"},
    }


def stateless_endpoint(
    cell: str, uid: str, dc: str, address: str, ready_endpoint_count: int = 3,
) -> dict:
    return {
        "schema": "actor-stateless-private-endpoint/v1", "verdict": "passed",
        "cell": {"name": cell, "uid": uid}, "datacenter": dc,
        "endpoint": f"http://{address}:19084",
        "network": {"subnetId": "subnet-test", "hubSourceCidrs": ["10.160.0.0/16"]},
        "service": {
            "namespace": "actor-stateless-system",
            "name": cell + "-stateless-executor-private",
            "uid": "stateless-service-" + uid,
            "resourceVersion": "1",
            "readyEndpointCount": ready_endpoint_count,
            "listenerPort": 19084,
            "targetPort": "executor",
            "externalTrafficPolicy": "Cluster",
        },
    }


def route(cell: str, uid: str, dc: str) -> dict:
    return {
        "schema": "actor-cell-route-publication/v2", "verdict": "passed",
        "convergenceReceiptDigest": "sha256:" + "1" * 64,
        "qualificationChainReceiptDigest": "sha256:" + "2" * 64,
        "activationReceiptDigest": "sha256:" + "3" * 64,
        "adoptionReceiptDigest": "sha256:" + "4" * 64,
        "pool": {"name": "actor-beijing-kubernetes", "uid": "pool-uid"},
        "cell": {"name": cell, "uid": uid}, "datacenter": dc,
        "routeConfigMap": {"name": "actor-cell-route-" + cell, "uid": "route-" + uid, "resourceVersion": "1"},
    }


def credential() -> dict:
    keys = [
        "engine-a-token", "engine-b-token", "object-router-a-token",
        "object-router-b-token", "registry-token", "stateless-a-token",
        "stateless-b-token",
    ]
    return {
        "schema": "actor-workers-api-credential-sync/v1", "verdict": "passed",
        "cells": [
            {"name": "actor-bj-a01", "uid": "uid-a"},
            {"name": "actor-bj-b01", "uid": "uid-b"},
        ],
        "credential": {
            "namespace": "workers-api-system", "name": "workers-api-internal-token-0123456789ab",
            "uid": "credential-uid", "resourceVersion": "7", "immutable": True,
            "keys": keys, "fingerprints": {key: "sha256:" + "7" * 64 for key in keys},
        },
    }


def serving_route(path: Path, identity_path: Path, endpoint_path: Path, stateless_path: Path) -> Path:
    identity = json.loads(identity_path.read_text())
    endpoint_value = json.loads(endpoint_path.read_text())
    stateless_value = json.loads(stateless_path.read_text())
    cell, pool = identity["cell"], identity["pool"]
    unsigned = {
        "schema": "actor-cell-serving-route/v1", "region": "ap-beijing",
        "pool_name": pool["name"], "pool_uid": pool["uid"],
        "cell_name": cell["name"], "cell_uid": cell["uid"],
        "datacenter": identity["datacenter"],
        "actor_gateway_authority": endpoint_value["endpoint"],
        "actor_gateway_service_uid": endpoint_value["service"]["uid"],
        "stateless_executor_authority": stateless_value["endpoint"],
        "stateless_executor_service_uid": stateless_value["service"]["uid"],
        "service_identity": "actor-cell/" + cell["uid"],
        "revision": 1, "published_at": "2026-09-23T10:00:00Z",
    }
    canonical = (json.dumps(unsigned, sort_keys=True, separators=(",", ":")) + "\n").encode()
    snapshot = {**unsigned, "manifest_sha256": "sha256:" + hashlib.sha256(canonical).hexdigest()}
    def digest(source: Path) -> str:
        return "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest()
    return write(path, {
        "schema": "actor-cell-serving-route-publication/v1", "verdict": "passed",
        "route": snapshot,
        "evidence": {
            "identityRouteReceiptDigest": digest(identity_path),
            "engineEndpointReceiptDigest": digest(endpoint_path),
            "statelessEndpointReceiptDigest": digest(stateless_path),
        },
        "configMap": {
            "name": "actor-cell-serving-route-" + cell["name"],
            "uid": "serving-route-" + cell["uid"], "resourceVersion": "1",
        },
    })


class RenderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.validate = mock.patch.object(render.CONTRACT, "validate_inventory", side_effect=lambda value: value)
        self.resolve = mock.patch.object(
            render.CONTRACT,
            "resolve",
            return_value={"ref": "registry.invalid/workers-api@sha256:" + "2" * 64},
        )
        self.product_patch = mock.patch.object(render.PRODUCT, "validate_receipt", side_effect=lambda value: value)
        self.validate.start()
        self.resolve.start()
        self.product_patch.start()
        self.addCleanup(self.validate.stop)
        self.addCleanup(self.resolve.stop)
        self.addCleanup(self.product_patch.stop)

    @staticmethod
    def product_receipt() -> dict:
        return {
            "repository": "workers-api",
            "ref": "registry.invalid/workers-api@sha256:" + "2" * 64,
            "dependencies": [
                {"repository": "base-distroless", "ref": "registry.invalid/workers-api@sha256:" + "2" * 64},
                {"repository": "base-golang", "ref": "registry.invalid/workers-api@sha256:" + "2" * 64},
            ],
        }

    def test_stateless_endpoint_accepts_hpa_scaled_backend_count(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = write(
                Path(raw) / "stateless.json",
                stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14", 7),
            )
            self.assertEqual(render.validate_stateless_endpoint(path)["cell"], "actor-bj-a01")

    def test_stateless_endpoint_rejects_backend_count_below_ha_floor(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = write(
                Path(raw) / "stateless.json",
                stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14", 2),
            )
            with self.assertRaisesRegex(ValueError, "Service identity differs"):
                render.validate_stateless_endpoint(path)

    def test_render_binds_two_exact_cell_routes(self) -> None:
        inventory = {"inventoryDigest": "sha256:" + "1" * 64}
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path = write(root / "inventory.json", inventory)
            product_path = write(root / "product.json", self.product_receipt())
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
            ]
            stateless_endpoints = [
                write(root / "stateless-b.json", stateless_endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.14")),
                write(root / "stateless-a.json", stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14")),
            ]
            routes = [
                write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")),
                write(root / "route-b.json", route("actor-bj-b01", "uid-b", "actor-bj-b01")),
            ]
            serving_routes = [
                serving_route(root / "serving-a.json", routes[0], endpoints[1], stateless_endpoints[1]),
                serving_route(root / "serving-b.json", routes[1], endpoints[0], stateless_endpoints[0]),
            ]
            encoded, evidence = render.render(
                inventory_path, product_path, credential_path, endpoints, stateless_endpoints, routes,
                serving_routes,
                "actor-beijing-kubernetes",
            )
        self.assertNotIn(b"http://10.161.0.12:6420", encoded)
        self.assertNotIn(b"http://10.162.0.12:6420", encoded)
        self.assertNotIn(b"http://10.161.0.14:19084", encoded)
        self.assertNotIn(b"http://10.162.0.14:19084", encoded)
        self.assertIn(b"engine-cell-uid-a: uid-a", encoded)
        self.assertIn(b"engine-cell-uid-b: uid-b", encoded)
        self.assertIn(b"placement-pool-uid: pool-uid", encoded)
        self.assertNotIn(b"__", encoded)
        self.assertEqual([item["cell"] for item in evidence["cells"]], ["actor-bj-a01", "actor-bj-b01"])
        documents = [item for item in yaml.safe_load_all(encoded) if item]
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        hpa = next(item for item in documents if item["kind"] == "HorizontalPodAutoscaler")
        args = deployment["spec"]["template"]["spec"]["containers"][0]["args"]
        secret_refs = {
            item["valueFrom"]["secretKeyRef"]["name"]
            for item in deployment["spec"]["template"]["spec"]["containers"][0]["env"]
            if "secretKeyRef" in item.get("valueFrom", {})
        }
        self.assertEqual(secret_refs, {"workers-api-internal-token-0123456789ab"})
        self.assertEqual(evidence["credentialReceipt"]["name"], "workers-api-internal-token-0123456789ab")
        self.assertFalse(any(item.startswith("--engine-url=") for item in args))
        self.assertFalse(any(item.startswith("--stateless-executor-url=") for item in args))
        self.assertIn("--serving-route-refresh-interval=1s", args)
        self.assertEqual(
            {
                "prometheus.io/scrape": "true",
                "prometheus.io/port": "8080",
                "prometheus.io/path": "/metrics",
            },
            {
                key: deployment["spec"]["template"]["metadata"]["annotations"][key]
                for key in ("prometheus.io/scrape", "prometheus.io/port", "prometheus.io/path")
            },
        )
        self.assertEqual(
            deployment["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/routing-config-digest"],
            evidence["routingConfigDigest"],
        )
        self.assertEqual(hpa["spec"]["minReplicas"], 3)
        self.assertEqual(hpa["spec"]["maxReplicas"], 30)
        self.assertEqual(
            {item["pods"]["metric"]["name"] for item in hpa["spec"]["metrics"] if item["type"] == "Pods"},
            {"workers_api_routing_requests_per_second", "workers_api_routing_requests_in_flight"},
        )

    def test_object_router_bootstrap_is_explicit_and_has_no_stateless_dispatch_capability(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path = write(root / "inventory.json", {"inventoryDigest": "sha256:" + "1" * 64})
            product_path = write(root / "product.json", self.product_receipt())
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
            ]
            routes = [
                write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")),
                write(root / "route-b.json", route("actor-bj-b01", "uid-b", "actor-bj-b01")),
            ]
            encoded, evidence = render.render(
                inventory_path, product_path, credential_path, endpoints, [], routes, [],
                "actor-beijing-kubernetes", "object-router-bootstrap",
            )
        documents = [item for item in yaml.safe_load_all(encoded) if item]
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(evidence["phase"], "object-router-bootstrap")
        self.assertEqual(
            deployment["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/release-phase"],
            "object-router-bootstrap",
        )
        self.assertIn("--internal-listen-address=:8081", container["args"])
        self.assertEqual(
            sum(item.startswith("--object-router-token=") for item in container["args"]), 2,
        )
        self.assertFalse(any(item.startswith("--stateless-executor-token=") for item in container["args"]))
        self.assertNotIn("STATELESS_A_TOKEN", {item["name"] for item in container["env"]})
        self.assertNotIn("STATELESS_B_TOKEN", {item["name"] for item in container["env"]})
        self.assertEqual(
            {
                item["valueFrom"]["secretKeyRef"]["name"]
                for item in container["env"] if "secretKeyRef" in item.get("valueFrom", {})
            },
            {"workers-api-internal-token-0123456789ab"},
        )
        self.assertFalse(any("statelessEndpoint" in item for item in evidence["cells"]))

    def test_bootstrap_rejects_stateless_route_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path = write(root / "inventory.json", {"inventoryDigest": "sha256:" + "1" * 64})
            product_path = write(root / "product.json", self.product_receipt())
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
            ]
            routes = [
                write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")),
                write(root / "route-b.json", route("actor-bj-b01", "uid-b", "actor-bj-b01")),
            ]
            stateless = [write(root / "stateless.json", stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14"))]
            with self.assertRaisesRegex(ValueError, "must not consume"):
                render.render(
                    inventory_path, product_path, credential_path, endpoints, stateless, routes, [],
                    "actor-beijing-kubernetes", "object-router-bootstrap",
                )

    def test_render_rejects_endpoint_route_uid_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path = write(root / "inventory.json", {"inventoryDigest": "sha256:" + "1" * 64})
            product_path = write(root / "product.json", self.product_receipt())
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
            ]
            stateless_endpoints = [
                write(root / "stateless-a.json", stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14")),
                write(root / "stateless-b.json", stateless_endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.14")),
            ]
            bad = route("actor-bj-b01", "another-uid", "actor-bj-b01")
            routes = [write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")), write(root / "route-b.json", bad)]
            serving_routes = [
                serving_route(root / "serving-a.json", routes[0], endpoints[0], stateless_endpoints[0]),
                serving_route(root / "serving-b.json", routes[1], endpoints[1], stateless_endpoints[1]),
            ]
            with self.assertRaisesRegex(ValueError, "differs"):
                render.render(
                    inventory_path, product_path, credential_path, endpoints, stateless_endpoints, routes,
                    serving_routes,
                    "actor-beijing-kubernetes",
                )

    def test_render_rejects_stateless_endpoint_identity_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path = write(root / "inventory.json", {"inventoryDigest": "sha256:" + "1" * 64})
            product_path = write(root / "product.json", self.product_receipt())
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
            ]
            stateless_endpoints = [
                write(root / "stateless-a.json", stateless_endpoint("actor-bj-a01", "wrong-uid", "actor-bj-a01", "10.161.0.14")),
                write(root / "stateless-b.json", stateless_endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.14")),
            ]
            routes = [
                write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")),
                write(root / "route-b.json", route("actor-bj-b01", "uid-b", "actor-bj-b01")),
            ]
            serving_routes = [
                serving_route(root / "serving-a.json", routes[0], endpoints[0], stateless_endpoints[0]),
                serving_route(root / "serving-b.json", routes[1], endpoints[1], stateless_endpoints[1]),
            ]
            with self.assertRaisesRegex(ValueError, "differs"):
                render.render(
                    inventory_path, product_path, credential_path, endpoints, stateless_endpoints, routes,
                    serving_routes,
                    "actor-beijing-kubernetes",
                )


if __name__ == "__main__":
    unittest.main()
