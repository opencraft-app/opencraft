#!/usr/bin/env python3

import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("qualify_public_admission", ROOT / "qualify-public-admission.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class PublicAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value, sort_keys=True) + "\n")
        return path

    def evidence(self):
        routes, serving_routes, convergences = [], [], []
        route_values = {}
        serving_values = {}
        for cell in ("actor-bj-a01", "actor-bj-b01"):
            convergence = {
                "schema": "actor-cell-argo-convergence/v1", "verdict": "passed",
                "cell": {"id": cell, "uid": "uid-" + cell},
                "fleetBinding": {
                    "poolName": "pool", "poolUid": "pool-uid", "claimName": "claim-" + cell,
                    "claimUid": "claim-uid-" + cell, "datacenterName": "default",
                },
            }
            convergence_path = self.write(cell + "-convergence.json", convergence)
            convergences.append(convergence_path)
            route = {
                "schema": "actor-cell-route-publication/v2", "verdict": "passed",
                "convergenceReceiptDigest": MODULE.digest(convergence_path),
                "qualificationChainReceiptDigest": "sha256:" + "b" * 64,
                "activationReceiptDigest": "sha256:" + "c" * 64,
                "adoptionReceiptDigest": "sha256:" + "d" * 64,
                "pool": {"name": "pool", "uid": "pool-uid"},
                "cell": {"name": cell, "uid": "uid-" + cell}, "datacenter": "default",
                "routeConfigMap": {"name": "route-" + cell, "uid": "route-uid-" + cell},
            }
            route_path = self.write(cell + "-route.json", route)
            routes.append(route_path)
            route_values[cell] = (route, route_path)
            unsigned = {
                "schema": "actor-cell-serving-route/v1", "region": "ap-beijing",
                "pool_name": "pool", "pool_uid": "pool-uid",
                "cell_name": cell, "cell_uid": "uid-" + cell, "datacenter": "default",
                "actor_gateway_authority": "http://10.161.0.12:6420",
                "actor_gateway_service_uid": "engine-service-" + cell,
                "stateless_executor_authority": "http://10.161.0.14:19084",
                "stateless_executor_service_uid": "executor-service-" + cell,
                "service_identity": "actor-cell/uid-" + cell,
                "revision": 1, "published_at": "2026-09-23T10:00:00Z",
            }
            canonical = (json.dumps(unsigned, sort_keys=True, separators=(",", ":")) + "\n").encode()
            snapshot = {**unsigned, "manifest_sha256": "sha256:" + hashlib.sha256(canonical).hexdigest()}
            serving = {
                "schema": "actor-cell-serving-route-publication/v1", "verdict": "passed",
                "route": snapshot,
                "evidence": {"identityRouteReceiptDigest": MODULE.digest(route_path)},
                "configMap": {
                    "name": "actor-cell-serving-route-" + cell,
                    "uid": "serving-route-uid-" + cell, "resourceVersion": "1",
                },
            }
            serving_path = self.write(cell + "-serving-route.json", serving)
            serving_routes.append(serving_path)
            serving_values[cell] = (serving, serving_path)
        image = "registry.invalid/workers-api@sha256:" + "a" * 64
        render = {
            "schema": "actor-workers-api-render/v1", "verdict": "passed", "workersApiImage": image,
            "routingConfigDigest": "sha256:" + "b" * 64, "pool": {"name": "pool", "uid": "pool-uid"},
            "cells": [
                {
                    "cell": cell, "cellUid": route["cell"]["uid"], "datacenter": "default",
                    "routeDigest": MODULE.digest(path), "routeConfigMapUid": route["routeConfigMap"]["uid"],
                    "servingRouteDigest": MODULE.digest(serving_values[cell][1]),
                    "servingRouteRevision": serving_values[cell][0]["route"]["revision"],
                    "servingRouteManifestSha256": serving_values[cell][0]["route"]["manifest_sha256"],
                    "servingRouteConfigMapUid": serving_values[cell][0]["configMap"]["uid"],
                }
                for cell, (route, path) in sorted(route_values.items())
            ],
        }
        render_path = self.write("render.json", render)
        install = {
            "schema": "actor-workers-api-installation/v1", "verdict": "passed",
            "renderReceipt": {"sha256": MODULE.digest(render_path)},
            "topology": {"workersApiImage": image}, "deployment": {"deploymentUid": "deployment-uid"},
        }
        endpoint_install = {
            "schema": "actor-workers-api-private-endpoint-installation/v3", "verdict": "installed",
            "endpoint": "http://10.160.0.17:6688",
            "service": {"uid": "service-uid", "listenerPort": 6688, "externalTrafficPolicy": "Cluster"},
        }
        endpoint_install_path = self.write("endpoint-install.json", endpoint_install)
        endpoint_qualification = {
            "schema": "actor-workers-api-private-endpoint-qualification/v3", "verdict": "passed",
            "installationReceipt": {"sha256": MODULE.digest(endpoint_install_path), "serviceUid": "service-uid"},
        }
        endpoint_ha = {
            "schema": "actor-workers-api-private-endpoint-ha/v2", "verdict": "passed",
            "endpoint": endpoint_install["endpoint"], "deployment": {"uid": "deployment-uid", "image": image},
            "traffic": {"failures": 0, "successfulDuringReplacement": 10},
        }
        placement = {
            "schema": "actor-first-placement/v1", "verdict": "passed", "operation_id": "0" * 32,
            "first_placement": {
                "functional_probe": {"status": 200}, "object_ref": {"worker": "worker", "id": "object"},
                "registry_record": {"actor_id": "actor", "placement": {
                    "cell_name": "actor-bj-b01", "cell_uid": "uid-actor-bj-b01", "datacenter": "default",
                    "pool_name": "pool", "pool_uid": "pool-uid",
                }},
            },
        }
        registry_endpoint = {
            "schema": "actor-worker-registry-private-endpoint/v1", "verdict": "installed",
            "endpoint": "http://10.160.0.11:8080", "service": {"uid": "registry-service"},
        }
        registry_endpoint_path = self.write("registry-endpoint.json", registry_endpoint)
        registry_bindings = [
            self.write(cell + "-registry.json", {
                "schema": "actor-cell-worker-registry-binding/v1", "verdict": "passed", "cell": cell,
                "registryEndpoint": registry_endpoint["endpoint"], "registryEndpointServiceUid": "registry-service",
                "statefulSet": {"uid": "statefulset-" + cell, "readyReplicas": 3},
            }) for cell in ("actor-bj-a01", "actor-bj-b01")
        ]
        code_plane = {
            "schema": "actor-create-first-management-code-plane-chain/v1", "verdict": "passed",
            "managementId": "actor-bj-c01",
            "repository": {"gitRevision": "c" * 40},
            "identity": {
                "registryEndpoint": registry_endpoint["endpoint"],
                "registryPrivateServiceUid": "registry-service",
            },
            "gates": {"physicallyRestorableBackup": True, "selfHeal": True},
        }
        paths = {
            "render": render_path, "install": self.write("install.json", install),
            "endpoint_install": endpoint_install_path,
            "endpoint_qualification": self.write("endpoint-qualification.json", endpoint_qualification),
            "endpoint_ha": self.write("endpoint-ha.json", endpoint_ha),
            "placement": self.write("placement.json", placement),
        }
        return (
            paths, routes, serving_routes, convergences, registry_endpoint_path,
            registry_bindings, self.write("code-plane.json", code_plane),
        )

    def test_joins_two_routes_and_public_evidence(self):
        plan = MODULE.receipt_plan(*self.evidence())
        self.assertEqual(set(plan["routes"]), {"actor-bj-a01", "actor-bj-b01"})
        self.assertEqual(plan["placement_cell"], "actor-bj-b01")

    def test_rejects_route_convergence_substitution(self):
        paths, routes, serving_routes, convergences, registry_endpoint, registry_bindings, code_plane = self.evidence()
        route = json.loads(routes[0].read_text())
        route["convergenceReceiptDigest"] = "sha256:" + "f" * 64
        routes[0].write_text(json.dumps(route) + "\n")
        with self.assertRaisesRegex(ValueError, "exact convergence"):
            MODULE.receipt_plan(paths, routes, serving_routes, convergences, registry_endpoint, registry_bindings, code_plane)

    def test_rejects_cell_local_registry_binding(self):
        paths, routes, serving_routes, convergences, registry_endpoint, registry_bindings, code_plane = self.evidence()
        binding = json.loads(registry_bindings[0].read_text())
        binding["registryEndpoint"] = "http://cell-registry:8080"
        registry_bindings[0].write_text(json.dumps(binding) + "\n")
        with self.assertRaisesRegex(ValueError, "regional Worker Registry"):
            MODULE.receipt_plan(paths, routes, serving_routes, convergences, registry_endpoint, registry_bindings, code_plane)

    def test_rejects_registry_outside_code_plane_chain(self):
        paths, routes, serving_routes, convergences, registry_endpoint, registry_bindings, code_plane = self.evidence()
        value = json.loads(code_plane.read_text())
        value["identity"]["registryPrivateServiceUid"] = "replacement-service"
        code_plane.write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "qualified Code Plane chain"):
            MODULE.receipt_plan(paths, routes, serving_routes, convergences, registry_endpoint, registry_bindings, code_plane)

    def test_qualifier_source_has_stable_digest(self):
        self.assertRegex(MODULE.digest(ROOT / "qualify-public-admission.py"), r"^sha256:[0-9a-f]{64}$")

    def test_live_route_payload_excludes_release_evidence(self):
        _, routes, _, _, _, _, _ = self.evidence()
        route = json.loads(routes[0].read_text())
        payload = MODULE.stable_route_data(route)
        self.assertEqual(
            payload,
            {
                "pool-name": "pool", "pool-uid": "pool-uid",
                "cell-name": "actor-bj-a01", "cell-uid": "uid-actor-bj-a01",
                "datacenter": "default",
            },
        )
        self.assertNotIn("qualification-chain-receipt-digest", payload)
        self.assertNotIn("activation-receipt-digest", payload)
        self.assertTrue(MODULE.route_data_matches(route, payload))
        legacy = {
            **payload,
            "convergence-receipt-digest": route["convergenceReceiptDigest"],
            "qualification-chain-receipt-digest": route["qualificationChainReceiptDigest"],
            "activation-receipt-digest": route["activationReceiptDigest"],
            "adoption-receipt-digest": route["adoptionReceiptDigest"],
        }
        self.assertTrue(MODULE.route_data_matches(route, legacy))
        self.assertFalse(MODULE.route_data_matches(route, {**payload, "unexpected": "field"}))


if __name__ == "__main__":
    unittest.main()
