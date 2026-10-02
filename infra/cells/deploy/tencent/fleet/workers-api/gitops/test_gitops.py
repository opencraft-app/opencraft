#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parent
WORKERS = ROOT.parent


def module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


RENDER = module("workers_api_gitops_render", ROOT / "render-desired-state.py")
PUBLISH = module("workers_api_gitops_publish", ROOT / "publish-desired-state.py")
APPLICATION = module("workers_api_gitops_application", ROOT / "render-application.py")
INCLUSIONS = module("workers_api_gitops_inclusions", ROOT / "merge-resource-inclusions.py")
RECERTIFY = (ROOT / "recertify-live-convergence.sh").read_text()
ROLLBACK = (ROOT / "rollback-failed-bootstrap.sh").read_text()
INSTALL = (ROOT / "install-application.sh").read_text()


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def write(path: pathlib.Path, value: bytes | dict) -> pathlib.Path:
    path.write_bytes(value if isinstance(value, bytes) else (json.dumps(value, sort_keys=True) + "\n").encode())
    return path


class Fixtures:
    def __init__(self, root: pathlib.Path):
        self.root = root
        self.credential_name = "workers-api-internal-token-0123456789ab"
        documents = [item for item in yaml.safe_load_all((WORKERS / "api.yaml").read_text()) if item]
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        deployment["spec"]["template"].setdefault("metadata", {}).setdefault("annotations", {})[
            "fleet.actor.dev/routing-config-digest"
        ] = "sha256:" + "2" * 64
        deployment["spec"]["template"]["metadata"]["annotations"][
            "fleet.actor.dev/release-phase"
        ] = "serving"
        deployment["spec"]["template"]["spec"]["containers"][0]["image"] = "registry.invalid/workers@sha256:" + "1" * 64
        for item in deployment["spec"]["template"]["spec"]["containers"][0]["env"]:
            reference = item.get("valueFrom", {}).get("secretKeyRef")
            if reference is not None:
                reference["name"] = self.credential_name
        config = next(item for item in documents if item["kind"] == "ConfigMap")
        for key, value in list(config["data"].items()):
            if value.startswith("__"):
                if key == "engine-cell-a":
                    config["data"][key] = "actor-test-a"
                elif key == "engine-cell-b":
                    config["data"][key] = "actor-test-b"
                else:
                    config["data"][key] = "actor-test" if "url" not in key else "http://10.1.0.2:6420"
        self.manifest = write(root / "workers.yaml", yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False).encode())
        self.credential = write(root / "credential.json", {
            "schema": "actor-workers-api-credential-sync/v1", "verdict": "passed",
            "cells": [
                {"name": "actor-test-a", "uid": "cell-a-uid"},
                {"name": "actor-test-b", "uid": "cell-b-uid"},
            ],
            "credential": {
                "namespace": "workers-api-system", "name": self.credential_name,
                "uid": "secret-uid", "resourceVersion": "11", "immutable": True,
            },
            "bootstrapReplacement": {
                "performed": False, "priorUid": None, "existingCapabilitiesPreserved": True,
                "replacedInPlace": False,
            },
        })
        self.render = write(root / "render.json", {
            "schema": "actor-workers-api-render/v1", "verdict": "passed",
            "phase": "serving",
            "manifestSha256": digest(self.manifest.read_bytes()),
            "workersApiImage": "registry.invalid/workers@sha256:" + "1" * 64,
            "credentialReceipt": {
                "sha256": digest(self.credential.read_bytes()), "name": self.credential_name,
                "uid": "secret-uid", "resourceVersion": "11",
            },
            "cells": [
                {"cell": "actor-test-a", "cellUid": "cell-a-uid"},
                {"cell": "actor-test-b", "cellUid": "cell-b-uid"},
            ],
        })
        self.endpoint = write(root / "endpoint.json", {
            "schema": "actor-workers-api-private-endpoint-installation/v3", "verdict": "installed",
            "endpoint": "http://10.77.4.9:6688",
            "network": {
                "subnetId": "subnet-test1", "securityGroupId": "sg-test1",
                "loadBalancerId": "lb-test1", "sourceCidrs": ["10.77.0.0/16"],
            },
            "service": {
                "uid": "service-uid", "listenerPort": 6688, "externalTrafficPolicy": "Cluster",
            },
        })
        self.object_router_endpoint = write(root / "object-router-endpoint.json", {
            "schema": "actor-object-router-private-endpoint/v1", "verdict": "passed",
            "endpoint": "10.77.4.10:19085",
            "network": {
                "subnetId": "subnet-test1", "securityGroupId": "sg-test2",
                "loadBalancerId": "lb-test2", "sourceCidrs": ["10.81.0.0/16", "10.82.0.0/16"],
            },
            "service": {
                "uid": "router-service-uid", "listenerPort": 19085,
                "targetPort": "object-router",
            },
            "deployment": {"uid": "deployment-uid"},
        })
        self.admission = write(root / "admission.json", {
            "schema": "actor-public-admission-chain/v1", "verdict": "passed",
            "sourceReceipts": {"render": digest(self.render.read_bytes()), "endpoint_install": digest(self.endpoint.read_bytes())},
            "live": {
                "privateEndpoint": "http://10.77.4.9:6688",
                "workersApi": {"deploymentUid": "deployment-uid"},
            },
        })
        self.convergence = write(root / "convergence.json", {
            "schema": "actor-management-workers-api-argocd-convergence/v1", "verdict": "passed",
            "gitRevision": "a" * 40,
            "endpoint": "http://10.77.4.9:6688",
            "adoptedResources": {
                "deploymentUid": "deployment-uid",
                "privateServiceUid": "service-uid",
                "objectRouterServiceUid": "router-service-uid",
                "externalSecretName": self.credential_name,
                "externalSecretUid": "secret-uid",
            },
            "objectRouterEndpoint": "10.77.4.10:19085",
        })


class DesiredStateTests(unittest.TestCase):
    def test_object_router_bootstrap_uses_prior_convergence_without_private_router_endpoint(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(pathlib.Path(temporary))
            documents = [item for item in yaml.safe_load_all(fixture.manifest.read_text()) if item]
            deployment = next(item for item in documents if item["kind"] == "Deployment")
            deployment["spec"]["template"]["metadata"]["annotations"][
                "fleet.actor.dev/release-phase"
            ] = "object-router-bootstrap"
            container = deployment["spec"]["template"]["spec"]["containers"][0]
            container["args"] = [item for item in container["args"] if not item.startswith("--stateless-executor-token=")]
            container["env"] = [item for item in container["env"] if not item["name"].startswith("STATELESS_")]
            fixture.manifest.write_text(yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False))
            rendered = json.loads(fixture.render.read_text())
            rendered["phase"] = "object-router-bootstrap"
            rendered["manifestSha256"] = digest(fixture.manifest.read_bytes())
            write(fixture.render, rendered)
            files, receipt = RENDER.render(
                fixture.manifest, fixture.render, fixture.credential, fixture.endpoint, None,
                prior_convergence_path=fixture.convergence,
            )
            self.assertEqual(set(files), {
                "workers-api.yaml", "workers-api-render.json", "private-endpoint.yaml",
                "kustomization.yaml", "evidence.json",
            })
            self.assertEqual(receipt["sources"]["phase"], "object-router-bootstrap")
            self.assertEqual(receipt["sources"]["objectRouterEndpointReceiptSha256"], None)
            self.assertEqual(receipt["sources"]["externalRouteConfigMaps"], [
                "actor-cell-route-actor-test-a", "actor-cell-route-actor-test-b",
            ])

    def test_object_router_bootstrap_allows_only_versioned_non_aba_credential_transition(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(pathlib.Path(temporary))
            documents = [item for item in yaml.safe_load_all(fixture.manifest.read_text()) if item]
            deployment = next(item for item in documents if item["kind"] == "Deployment")
            deployment["spec"]["template"]["metadata"]["annotations"][
                "fleet.actor.dev/release-phase"
            ] = "object-router-bootstrap"
            container = deployment["spec"]["template"]["spec"]["containers"][0]
            container["args"] = [item for item in container["args"] if not item.startswith("--stateless-executor-token=")]
            container["env"] = [item for item in container["env"] if not item["name"].startswith("STATELESS_")]
            fixture.manifest.write_text(yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False))
            rendered = json.loads(fixture.render.read_text())
            rendered["phase"] = "object-router-bootstrap"
            rendered["manifestSha256"] = digest(fixture.manifest.read_bytes())
            write(fixture.render, rendered)
            prior = json.loads(fixture.convergence.read_text())
            prior["adoptedResources"]["externalSecretName"] = "workers-api-internal-token"
            prior["adoptedResources"]["externalSecretUid"] = "legacy-secret-uid"
            write(fixture.convergence, prior)
            credential = json.loads(fixture.credential.read_text())
            credential["bootstrapReplacement"] = {
                "performed": True,
                "priorUid": "legacy-secret-uid",
                "sourceCredentialUid": "legacy-secret-uid",
                "existingCapabilitiesPreserved": True,
                "replacedInPlace": False,
            }
            write(fixture.credential, credential)
            rendered["credentialReceipt"]["sha256"] = digest(fixture.credential.read_bytes())
            write(fixture.render, rendered)
            files, _ = RENDER.render(
                fixture.manifest, fixture.render, fixture.credential, fixture.endpoint, None,
                prior_convergence_path=fixture.convergence,
            )
            self.assertIn("workers-api.yaml", files)

            credential["bootstrapReplacement"]["replacedInPlace"] = True
            write(fixture.credential, credential)
            rendered["credentialReceipt"]["sha256"] = digest(fixture.credential.read_bytes())
            write(fixture.render, rendered)
            with self.assertRaisesRegex(ValueError, "changed outside bootstrap fencing"):
                RENDER.render(
                    fixture.manifest, fixture.render, fixture.credential, fixture.endpoint, None,
                    prior_convergence_path=fixture.convergence,
                )

    def test_render_is_credential_free_and_reusable(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(pathlib.Path(temporary))
            files, receipt = RENDER.render(
                fixture.manifest, fixture.render, fixture.credential, fixture.endpoint,
                fixture.object_router_endpoint, fixture.admission,
            )
            self.assertEqual(set(files), {
                "workers-api.yaml", "private-endpoint.yaml", "private-object-router-endpoint.yaml",
                "workers-api-render.json", "kustomization.yaml", "evidence.json",
            })
            self.assertEqual(files["workers-api-render.json"], fixture.render.read_bytes())
            self.assertEqual(receipt["verdict"], "passed")
            service = yaml.safe_load(files["private-endpoint.yaml"])
            self.assertEqual(service["spec"]["ports"][0]["port"], 6688)
            self.assertEqual(service["spec"]["externalTrafficPolicy"], "Cluster")
            router = yaml.safe_load(files["private-object-router-endpoint.yaml"])
            self.assertEqual(router["spec"]["ports"][0]["port"], 19085)
            self.assertEqual(router["spec"]["ports"][0]["targetPort"], "object-router")
            self.assertNotIn("10.160.0.17", files["private-endpoint.yaml"].decode())
            self.assertFalse(any(doc.get("kind") == "Secret" for doc in yaml.safe_load_all(files["workers-api.yaml"])))

    def test_render_rejects_unbound_admission(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(pathlib.Path(temporary))
            value = json.loads(fixture.admission.read_text())
            value["sourceReceipts"]["endpoint_install"] = "sha256:" + "0" * 64
            write(fixture.admission, value)
            with self.assertRaisesRegex(ValueError, "exact desired-state inputs"):
                RENDER.render(
                    fixture.manifest, fixture.render, fixture.credential, fixture.endpoint,
                    fixture.object_router_endpoint, fixture.admission,
                )

    def test_render_rejects_surge_topology_policy(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(pathlib.Path(temporary))
            documents = [item for item in yaml.safe_load_all(fixture.manifest.read_text()) if item]
            deployment = next(item for item in documents if item["kind"] == "Deployment")
            deployment["spec"]["strategy"]["rollingUpdate"]["maxSurge"] = 1
            fixture.manifest.write_text(yaml.safe_dump_all(documents, explicit_start=True, sort_keys=False))
            rendered = json.loads(fixture.render.read_text())
            rendered["manifestSha256"] = digest(fixture.manifest.read_bytes())
            write(fixture.render, rendered)
            with self.assertRaisesRegex(ValueError, "topology or drain contract"):
                RENDER.render(
                    fixture.manifest, fixture.render, fixture.credential, fixture.endpoint,
                    fixture.object_router_endpoint, prior_convergence_path=fixture.convergence,
                )

    def test_argocd_update_is_authorized_by_exact_prior_convergence(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(pathlib.Path(temporary))
            files, receipt = RENDER.render(
                fixture.manifest,
                fixture.render,
                fixture.credential,
                fixture.endpoint,
                fixture.object_router_endpoint,
                prior_convergence_path=fixture.convergence,
            )
            self.assertEqual(receipt["sources"]["releaseMode"], "argocd-update")
            self.assertEqual(receipt["sources"]["priorArgoRevision"], "a" * 40)
            self.assertEqual(receipt["sources"]["deploymentUidAtAdoption"], "deployment-uid")
            self.assertIn("workers-api.yaml", files)

    def test_argocd_update_rejects_stale_service_identity(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(pathlib.Path(temporary))
            value = json.loads(fixture.convergence.read_text())
            value["adoptedResources"]["privateServiceUid"] = "replaced-service"
            write(fixture.convergence, value)
            with self.assertRaisesRegex(ValueError, "convergence identity differs"):
                RENDER.render(
                    fixture.manifest,
                    fixture.render,
                    fixture.credential,
                    fixture.endpoint,
                    fixture.object_router_endpoint,
                    prior_convergence_path=fixture.convergence,
                )


class PublicationTests(unittest.TestCase):
    def git(self, *args: str, cwd: pathlib.Path | None = None) -> str:
        return subprocess.run(("git", *args), cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

    def test_publish_is_revision_cas(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary)
            bare, seed, desired = root / "remote.git", root / "seed", root / "desired"
            self.git("init", "--bare", str(bare))
            self.git("init", "-b", "main", str(seed))
            self.git("config", "user.name", "test", cwd=seed)
            self.git("config", "user.email", "test@invalid", cwd=seed)
            write(seed / "README", b"seed\n")
            self.git("add", "README", cwd=seed); self.git("commit", "-m", "seed", cwd=seed)
            self.git("remote", "add", "origin", str(bare), cwd=seed); self.git("push", "origin", "main", cwd=seed)
            base = self.git("rev-parse", "HEAD", cwd=seed)
            desired.mkdir()
            final_files = {
                "evidence.json", "kustomization.yaml", "private-endpoint.yaml",
                "private-object-router-endpoint.yaml", "workers-api-render.json", "workers-api.yaml",
            }
            for name in final_files:
                write(desired / name, (name + "\n").encode())
            render_receipt = write(root / "render.json", {
                "schema": "actor-management-workers-api-desired-render/v1", "verdict": "passed",
                "files": PUBLISH.inventory(desired),
            })
            receipt = root / "publication.json"
            result = PUBLISH.publish(
                desired, render_receipt, bare.as_uri(), bare.as_uri(), "main", base, receipt, True,
            )
            self.assertNotEqual(result["gitRevision"], base)
            self.assertEqual(result["repository"]["path"], "management/workers-api")
            second = root / "second.json"
            resumed = PUBLISH.publish(desired, render_receipt, bare.as_uri(), bare.as_uri(), "main", base, second, True)
            self.assertTrue(resumed["resumedAfterPublication"])
            self.assertEqual(resumed["gitRevision"], result["gitRevision"])

            changed = root / "changed"
            changed.mkdir()
            for name in final_files:
                write(changed / name, (("different-" if name == "evidence.json" else "") + name + "\n").encode())
            changed_receipt = write(root / "changed-render.json", {
                "schema": "actor-management-workers-api-desired-render/v1", "verdict": "passed",
                "files": PUBLISH.inventory(changed),
            })
            with self.assertRaisesRegex(ValueError, "reviewed CAS base"):
                PUBLISH.publish(changed, changed_receipt, bare.as_uri(), bare.as_uri(), "main", base, root / "third.json", True)

            automatic = PUBLISH.publish(
                changed, changed_receipt, bare.as_uri(), bare.as_uri(), "main", "auto", root / "automatic.json", True,
            )
            self.assertEqual(automatic["baseSelection"], "observed-head")
            self.assertEqual(automatic["baseRevision"], result["gitRevision"])
            self.assertNotEqual(automatic["gitRevision"], result["gitRevision"])


class ApplicationTests(unittest.TestCase):
    def test_install_resource_counts_include_private_services(self):
        self.assertEqual(len(RENDER.EXPECTED_RESOURCES), 12)
        self.assertIn("expected_resource_count=13", INSTALL)
        self.assertIn("expected_resource_count=14", INSTALL)

    def test_install_can_resume_only_from_healthy_exact_target(self):
        self.assertIn("resumed_after_apply=false", INSTALL)
        self.assertIn("resumed_after_apply=true", INSTALL)
        self.assertIn('.status.health.status == "Healthy"', INSTALL)
        self.assertIn('((.status.conditions // []) | length == 0)', INSTALL)
        self.assertIn("resumedAfterApply:$resumed_after_apply", INSTALL)

    def test_serving_verifies_registry_cursor_contract_before_mutation(self):
        probe = INSTALL.index('verify-registry-contract.py')
        first_mutation = INSTALL.index('apply --server-side')
        self.assertLess(probe, first_mutation)
        self.assertIn('if [[ $release_phase == serving ]]', INSTALL)
        self.assertIn('port-forward', INSTALL)
        self.assertIn('service/${registry_service[0]}', INSTALL)
        self.assertIn('--endpoint "$registry_probe_endpoint"', INSTALL)
        self.assertIn('kill "$registry_forward_pid"', INSTALL)
        self.assertIn('registryDeploymentCursorContract:($phase == "serving")', INSTALL)

    def test_failed_bootstrap_rollback_is_exact_and_identity_preserving(self):
        self.assertIn('"actor-management-workers-api-bootstrap-rollback/v1"', ROLLBACK)
        self.assertIn('failure_class=immutable-secret-same-name-cache-aba', ROLLBACK)
        self.assertIn('failureClass:$failure_class', ROLLBACK)
        self.assertIn('failure_class=workers-routing-metrics-and-topology-incomplete', ROLLBACK)
        self.assertIn('workers_api_routing_requests_per_second', ROLLBACK)
        self.assertIn('len(ready_zones) >= 3', ROLLBACK)
        self.assertIn('.status.health.status == "Degraded"', ROLLBACK)
        self.assertIn('CreateContainerConfigError', ROLLBACK)
        self.assertIn('couldn.t find key .* in Secret workers-api-system/workers-api-internal-token', ROLLBACK)
        self.assertIn('targetRevision:$revision', ROLLBACK)
        self.assertIn('identityPreserved:true', ROLLBACK)
        self.assertNotIn('delete secret', ROLLBACK)
        self.assertNotIn('delete deployment', ROLLBACK)

    def test_live_recertification_is_read_only_and_binds_pinned_git(self):
        self.assertIn('"releaseMode":"live-recertification"', RECERTIFY)
        self.assertIn("pinnedGitTreeVerified", RECERTIFY)
        self.assertIn("git -C \"$temporary/repository\" archive \"$revision\"", RECERTIFY)
        self.assertIn("Workers API Argo state is not exactly pinned, synced and healthy", RECERTIFY)
        self.assertIn("live Workers API private endpoint differs from its receipts", RECERTIFY)
        for mutation in ("kubectl apply", "kubectl patch", "kubectl delete", "kubectl create"):
            self.assertNotIn(mutation, RECERTIFY)
        self.assertNotIn("secret.get(\"data\")", RECERTIFY)

    def test_application_is_pinned_and_project_cannot_manage_secrets(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary)
            rendered = write(root / "render.json", {
                "schema": "actor-management-workers-api-desired-render/v1", "verdict": "passed",
                "files": {"workers-api.yaml": "sha256:" + "1" * 64},
                "sources": {"phase": "serving", "externalRouteConfigMaps": [
                    "actor-cell-route-actor-a", "actor-cell-route-actor-b",
                    "actor-cell-serving-route-actor-a", "actor-cell-serving-route-actor-b",
                ], "externalCredentialName": "workers-api-internal-token-0123456789ab"},
            })
            publication = write(root / "publication.json", {
                "schema": "actor-management-workers-api-desired-publication/v1", "verdict": "passed",
                "repository": {
                    "url": "http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git",
                    "branch": "main", "path": "management/workers-api",
                },
                "gitRevision": "a" * 40,
                "renderReceiptSha256": digest(rendered.read_bytes()),
                "files": {"workers-api.yaml": "sha256:" + "1" * 64},
            })
            project, application = APPLICATION.render(publication, rendered)
            self.assertEqual(application["spec"]["source"]["targetRevision"], "a" * 40)
            self.assertTrue(application["spec"]["syncPolicy"]["automated"]["selfHeal"])
            self.assertNotIn("finalizers", application["metadata"])
            allowed = project["spec"]["namespaceResourceWhitelist"]
            self.assertNotIn({"group": "", "kind": "Secret"}, allowed)
            self.assertIn({"group": "autoscaling", "kind": "HorizontalPodAutoscaler"}, allowed)
            deployment_ignore = next(
                item for item in application["spec"]["ignoreDifferences"]
                if item.get("kind") == "Deployment" and item.get("name") == "workers-api"
            )
            self.assertEqual(deployment_ignore["jsonPointers"], ["/spec/replicas"])
            self.assertEqual(
                {item["name"] for item in project["spec"]["orphanedResources"]["ignore"]},
                {
                    "actor-fleet-tcr", "workers-api-internal-token",
                    "workers-api-internal-token-0123456789ab",
                    "actor-cell-route-actor-a", "actor-cell-route-actor-b",
                    "actor-cell-serving-route-actor-a", "actor-cell-serving-route-actor-b",
                },
            )
            private = next(item for item in application["spec"]["ignoreDifferences"] if item["name"] == "workers-api-private")
            encoded = json.dumps(private)
            for controlled in ("loadBalancerSourceRanges", "externalTrafficPolicy", "security-groups", "internal-subnetid"):
                self.assertNotIn(controlled, encoded)
            router_private = next(
                item for item in application["spec"]["ignoreDifferences"]
                if item["name"] == "workers-object-router-private"
            )
            self.assertIn('service.kubernetes.io/loadbalance-id', json.dumps(router_private))

    def test_resource_inclusions_merge_without_secret_or_cell_loss(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary)
            existing = write(root / "existing.json", {
                "apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "argocd-cm"},
                "data": {"resource.inclusions": yaml.safe_dump([
                    {"apiGroups": ["fleet.actor.dev"], "kinds": ["RivetCell"], "clusters": ["*"]},
                    *INCLUSIONS.LEGACY_GLOBAL,
                ])},
            })
            merged = INCLUSIONS.render(existing, ROOT / "resource-inclusions.yaml", "https://172.20.0.1:443")
            policy = yaml.safe_load(merged["data"]["resource.inclusions"])
            encoded = json.dumps(policy)
            self.assertIn("RivetCell", encoded)
            self.assertIn("Deployment", encoded)
            self.assertIn("Service", encoded)
            self.assertNotIn("Secret", encoded)
            workers = [item for item in policy if "Deployment" in item["kinds"]]
            self.assertEqual(
                workers[0]["clusters"],
                ["https://kubernetes.default.svc", "https://172.20.0.1:443"],
            )
            self.assertNotIn(INCLUSIONS.LEGACY_GLOBAL[1], policy)


if __name__ == "__main__":
    unittest.main()
