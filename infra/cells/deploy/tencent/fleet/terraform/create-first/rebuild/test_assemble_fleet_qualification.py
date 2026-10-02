#!/usr/bin/env python3

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fleet_qualification", ROOT / "assemble-fleet-qualification.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FleetQualificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
        return path

    def fixtures(self):
        pool = {"name": "pool", "uid": "pool-uid"}
        code_plane = self.write("code-plane.json", {
            "schema": "actor-create-first-management-code-plane-chain/v1", "verdict": "passed",
            "managementId": "management", "cluster": {"uid": "management-uid"},
            "identity": {
                "registryDeploymentUid": "registry-uid",
                "registryPrivateServiceUid": "registry-service",
            },
            "gates": {"synced": True, "selfHeal": True},
        })
        qualifications, routes, serving = [], [], []
        route_values = {}
        serving_values = {}
        for suffix in ("a", "b"):
            cell = "cell-" + suffix
            qualification = self.write(f"{cell}-qualification.json", {
                "schema": "actor-cell-qualification-chain/v1", "verdict": "passed",
                "cell": {"id": cell, "spoke_uid": cell + "-uid"}, "pool": pool,
                "construction": {"management_cluster_uid": "management-uid"},
                "placement_opened": False, "operator_activation_required": True,
            })
            qualifications.append(qualification)
            route = {
                "schema": "actor-cell-route-publication/v2", "verdict": "passed",
                "qualificationChainReceiptDigest": MODULE.digest(qualification),
                "cell": {"name": cell, "uid": cell + "-uid"}, "pool": pool, "datacenter": "default",
                "routeConfigMap": {"name": "actor-cell-route-" + cell, "uid": "route-" + suffix},
            }
            route_path = self.write(f"{cell}-route.json", route)
            routes.append(route_path); route_values[cell] = (route, route_path)
            snapshot = {
                "schema": "actor-cell-serving-route/v1", "cell_name": cell, "cell_uid": cell + "-uid",
                "pool_name": "pool", "pool_uid": "pool-uid", "datacenter": "default", "revision": 1,
            }
            snapshot["manifest_sha256"] = MODULE.canonical_serving_manifest(snapshot)
            publication = {
                "schema": "actor-cell-serving-route-publication/v1", "verdict": "passed",
                "route": snapshot, "evidence": {"identityRouteReceiptDigest": MODULE.digest(route_path)},
                "configMap": {"name": "actor-cell-serving-route-" + cell, "uid": "serving-" + suffix, "resourceVersion": "1"},
            }
            serving_path = self.write(f"{cell}-serving.json", publication)
            serving.append(serving_path); serving_values[cell] = (publication, serving_path)

        public = self.write("public.json", {
            "schema": "actor-public-admission-chain/v1", "verdict": "passed",
            "sourceReceipts": {"codePlane": MODULE.digest(code_plane)},
            "codePlane": {"managementId": "management", "registryServiceUid": "registry-service", "boundCells": ["cell-a", "cell-b"]},
            "live": {
                "pool": {"uid": "pool-uid"}, "privateEndpoint": "http://10.0.0.1:6688",
                "workersApi": {"deploymentUid": "workers-uid"},
                "cells": [{"cell": cell, "spokeUid": cell + "-uid"} for cell in ("cell-a", "cell-b")],
            },
            "ha": {"failures": 0, "successfulDuringReplacement": 1},
        })
        render_cells = []
        for cell in ("cell-a", "cell-b"):
            route, route_path = route_values[cell]; publication, serving_path = serving_values[cell]
            render_cells.append({
                "cell": cell, "cellUid": route["cell"]["uid"], "routeDigest": MODULE.digest(route_path),
                "routeConfigMapUid": route["routeConfigMap"]["uid"], "servingRouteDigest": MODULE.digest(serving_path),
                "servingRouteRevision": 1, "servingRouteManifestSha256": publication["route"]["manifest_sha256"],
                "servingRouteConfigMapUid": publication["configMap"]["uid"],
            })
        image = "registry.invalid/workers-api@sha256:" + "a" * 64
        workers_render = self.write("workers-render.json", {
            "schema": "actor-workers-api-render/v1", "verdict": "passed", "phase": "serving",
            "workersApiImage": image, "routingConfigDigest": "sha256:" + "b" * 64, "cells": render_cells,
        })
        desired_root = self.root / "desired"
        desired_root.mkdir()
        (desired_root / "workers-api-render.json").write_bytes(workers_render.read_bytes())
        (desired_root / "workers-api.yaml").write_text("workers\n")
        desired = self.write("desired.json", {
            "schema": "actor-management-workers-api-desired-render/v1", "verdict": "passed",
            "files": MODULE.inventory(desired_root),
            "sources": {"workersApiRenderReceiptSha256": MODULE.digest(workers_render), "workersApiImage": image},
        })
        publication = self.write("publication.json", {
            "schema": "actor-management-workers-api-desired-publication/v1", "verdict": "passed",
            "renderReceiptSha256": MODULE.digest(desired), "files": MODULE.inventory(desired_root),
            "gitRevision": "a" * 40, "repository": {"path": "management/workers-api"},
        })
        convergence = self.write("convergence.json", {
            "schema": "actor-management-workers-api-argocd-convergence/v1", "verdict": "passed",
            "sourceReceipts": {"desiredRender": MODULE.digest(desired), "publication": MODULE.digest(publication)},
            "gitRevision": "a" * 40, "phase": "serving", "endpoint": "http://10.0.0.1:6688",
            "adoptedResources": {"deploymentUid": "workers-uid"},
            "gates": {name: True for name in MODULE.EXPECTED_WORKERS_GATES},
        })
        observability = self.write("observability.json", {
            "schema": "actor-mesh-observability-argocd-convergence/v1", "verdict": "passed",
            "gitRevision": "c" * 40, "gates": {"synced": True, "healthy": True},
        })
        metrics_desired = self.write("metrics-desired.json", {
            "schema": "actor-management-workers-api-desired-render/v1", "verdict": "passed",
            "files": {"workers-api.yaml": MODULE.digest(desired_root / "workers-api.yaml")},
        })
        metrics_workers = self.write("metrics-workers.json", {
            "schema": "actor-management-workers-api-argocd-convergence/v1", "verdict": "passed",
            "gitRevision": "d" * 40, "sourceReceipts": {"desiredRender": MODULE.digest(metrics_desired)},
            "gates": {"synced": True, "healthy": True},
        })
        metrics = self.write("metrics.json", {
            "schema": "actor-router-metrics-recovery-qualification/v1", "verdict": "passed",
            "workersRevision": "d" * 40, "observabilityRevision": "c" * 40,
            "gates": {"targets": True, "hpa": True},
        })
        stateless = self.write("stateless.json", {
            "schema": "actor-stateless-autoscaling-qualification/v1", "verdict": "passed",
            "checks": {"up": True, "down": True},
            "expected": {"cells": ["cell-a", "cell-b"], "floorPerCell": 3},
        })
        dependent = [
            {"phase": phase, "cells": {cell: {"nodes": 3, "pods": 3} for cell in ("cell-a", "cell-b")}}
            for phase in ("initial", "final")
        ]
        router = self.write("router.json", {
            "schema": "actor-workers-api-cloud-autoscaling-qualification/v1", "verdict": "passed",
            "gates": {"up": True, "down": True}, "replicas": {"floor": 3, "final": 3, "peakReady": 4},
            "dependentStatelessCapacity": dependent,
        })
        cursor = self.write("cursor.json", {
            "schema": "actor-worker-deployment-cursor-qualification/v1", "verdict": "passed",
            "workerDeleted": True, "sampleCount": 3, "latencySeconds": {"p99": 0.1}, "bounds": {"p99Seconds": 1.0},
        })
        fdb_outage = self.write("fdb-outage.json", {
            "schema": "actor-worker-registry-fdb-network-outage-qualification/v1",
            "verdict": "passed",
            "production": {"deploymentUid": "registry-uid"},
            "infrastructure": {"networkPolicyController": {"ready": 3}},
            "fault": {
                "processHealthStatus": 200,
                "storageReadinessStatus": 503,
                "freshConnectionForcedByCanaryReplacement": True,
            },
            "recovery": {"storageReadinessStatus": 200, "samePodUid": True},
            "gates": {name: True for name in MODULE.EXPECTED_FDB_OUTAGE_GATES},
        })
        return SimpleNamespace(
            code_plane=code_plane, qualification=qualifications, route=routes, serving_route=serving,
            public_admission=public, workers_render=workers_render, workers_desired_root=desired_root,
            workers_desired_render=desired, workers_publication=publication, workers_convergence=convergence,
            observability_convergence=observability, router_metrics_workers_desired_render=metrics_desired,
            router_metrics_workers_convergence=metrics_workers, router_metrics_qualification=metrics,
            stateless_autoscaling=stateless, router_autoscaling=router, deployment_cursor=cursor,
            fdb_network_outage=fdb_outage,
        )

    def test_joins_self_contained_two_cell_fleet(self):
        plan, sources = MODULE.assemble(self.fixtures())
        self.assertEqual(plan["cells"], ["cell-a", "cell-b"])
        self.assertEqual(sources["workersRender"], MODULE.digest(self.root / "workers-render.json"))

    def test_rejects_missing_archived_render(self):
        args = self.fixtures()
        (args.workers_desired_root / "workers-api-render.json").write_text("{}\n")
        with self.assertRaisesRegex(ValueError, "self-contained"):
            MODULE.assemble(args)

    def test_rejects_route_from_another_qualification(self):
        args = self.fixtures()
        route = json.loads(args.route[0].read_text())
        route["qualificationChainReceiptDigest"] = "sha256:" + "f" * 64
        args.route[0].write_text(json.dumps(route) + "\n")
        with self.assertRaisesRegex(ValueError, "qualification chain"):
            MODULE.assemble(args)

    def test_cell_kubeconfig_bindings_are_exact_and_unique(self):
        first = self.write("a.kubeconfig", {"test": True})
        second = self.write("b.kubeconfig", {"test": True})
        result = MODULE.parse_cell_kubeconfigs([
            f"actor-bj-a01={first}", f"actor-bj-b01={second}",
        ])
        self.assertEqual(result, {"actor-bj-a01": first, "actor-bj-b01": second})
        with self.assertRaisesRegex(ValueError, "unique"):
            MODULE.parse_cell_kubeconfigs([
                f"actor-bj-a01={first}", f"actor-bj-a01={second}",
            ])


if __name__ == "__main__":
    unittest.main()
