#!/usr/bin/env python3

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT.parent
CREATE_FIRST = ROOT.parents[1] / "terraform" / "create-first"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RENDER = load_module("stateless_runtime_gitops_render", ROOT / "render-desired-state.py")
PUBLISH = load_module("stateless_runtime_gitops_publish", ROOT / "publish-desired-state.py")
APPLICATION = load_module("stateless_runtime_gitops_application", ROOT / "render-application.py")
INSTALLER = (ROOT / "install-application.sh").read_text()
FIXTURE = load_module("stateless_runtime_gitops_fixture", CREATE_FIRST / "test-render-cell-assets.py")


def write(path: Path, value: dict) -> Path:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    return path


class Fixtures:
    def __init__(self, root: Path):
        self.root = root
        self.cell = "actor-bj-k02"
        self.inventory = write(root / "inventory.json", FIXTURE.inventory(self.cell))
        self.images_value = FIXTURE.image_inventory()
        self.images = write(root / "images.json", self.images_value)
        refs = {item["repository"]: item["ref"] for item in self.images_value["images"]}
        self.runtime_image = refs["rivet-runtime"]
        self.controller_image = refs["actor-fleet-controller"]
        self.registry_url = "http://10.160.0.11:8080"
        self.router_address = "10.160.0.12:19085"
        self.admission = write(root / "admission.json", {
            "schema": "actor-stateless-node-admission/v1",
            "verdict": "passed",
            "cell": self.cell,
            "machineSet": {"name": "np-test0001", "uid": "machine-set-uid"},
            "runtimeImage": self.runtime_image,
            "controllerImage": self.controller_image,
            "manifestSha256": "sha256:" + "1" * 64,
            "deployment": {"name": f"{self.cell}-stateless-admission", "uid": "admission-uid"},
        })
        self.auth = write(root / "auth.json", {
            "schema": "actor-stateless-auth/v1", "verdict": "passed",
            "cell": {"name": self.cell, "uid": "cell-uid"},
            "credential": {
                "namespace": "actor-stateless-system",
                "name": f"{self.cell}-stateless-auth", "uid": "credential-uid",
                "resourceVersion": "9", "immutable": True,
                "capabilities": ["executor-token", "object-router-token", "workerd-token"],
                "fingerprints": {},
            },
        })
        executor = RENDER.render_executor(
            RUNTIME / "stateless-executor.yaml", self.cell, self.runtime_image,
            self.runtime_image.rsplit("@", 1)[1], "np-test0001",
            self.registry_url, self.router_address,
        )
        self.install = write(root / "install.json", {
            "schema": "actor-stateless-executor-installation/v1",
            "verdict": "passed",
            "cell": self.cell,
            "runtimeImage": self.runtime_image,
            "registryUrl": self.registry_url,
            "objectRouterAddress": self.router_address,
            "machineSet": "np-test0001",
            "nodeAdmissionReceiptSha256": RENDER.sha(self.admission),
            "credentialReceiptSha256": RENDER.sha(self.auth),
            "manifestSha256": "sha256:" + hashlib.sha256(executor).hexdigest(),
            "deployment": {"name": f"{self.cell}-stateless-executor", "uid": "deployment-uid", "generation": 1},
            "service": {"name": f"{self.cell}-stateless-executor", "uid": "service-uid"},
            "credential": {
                "name": f"{self.cell}-stateless-auth", "uid": "credential-uid",
                "capabilities": ["executor-token", "object-router-token", "workerd-token"],
            },
        })
        self.endpoint = write(root / "endpoint.json", {
            "schema": "actor-stateless-private-endpoint/v1",
            "verdict": "passed",
            "cell": {"name": self.cell, "uid": "cell-uid"},
            "datacenter": "default",
            "endpoint": "http://10.3.1.20:19084",
            "network": {
                "subnetId": "subnet-test0001", "hubSourceCidrs": ["10.160.0.0/16"],
                "securityGroupId": "sg-test0003", "loadBalancerId": "lb-test0001",
            },
            "service": {
                "namespace": "actor-stateless-system",
                "name": f"{self.cell}-stateless-executor-private",
                "uid": "private-service-uid", "resourceVersion": "20",
                "readyEndpointCount": 3, "listenerPort": 19084,
                "targetPort": "executor", "externalTrafficPolicy": "Local",
                "scheduler": "LEAST_CONN",
            },
            "serviceConfig": {
                "name": f"{self.cell}-stateless-executor-private-config",
                "uid": "private-service-config-uid", "resourceVersion": "21",
            },
            "deployment": {"uid": "deployment-uid", "generation": 1, "readyReplicas": 3},
            "probe": {"path": "/healthz", "status": 204},
        })
        self.registry = write(root / "registry.json", {
            "schema": "actor-worker-registry-private-endpoint/v1", "verdict": "installed",
            "endpoint": self.registry_url, "service": {"uid": "registry-service-uid"},
        })
        self.router = write(root / "router.json", {
            "schema": "actor-object-router-private-endpoint/v1", "verdict": "passed",
            "endpoint": self.router_address,
            "network": {"subnetId": "subnet-hub", "sourceCidrs": ["10.0.0.0/12"], "securityGroupId": "sg-router", "loadBalancerId": "lb-router"},
            "service": {"uid": "router-service-uid", "listenerPort": 19085, "targetPort": "object-router"},
            "deployment": {"uid": "workers-api-uid"},
        })

    def render(self):
        return RENDER.render(
            RUNTIME / "stateless-executor.yaml", self.inventory, self.images,
            self.admission, self.auth, self.install, self.endpoint, self.registry, self.router,
        )


class StatelessRuntimeDesiredStateTests(unittest.TestCase):
    def test_render_is_credential_free_and_adopts_exact_live_identity(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(Path(temporary))
            files, receipt = fixture.render()
            self.assertEqual(set(files), {
                "stateless-executor.yaml", "stateless-private-endpoint.yaml",
                "kustomization.yaml", "evidence.json",
            })
            self.assertEqual(receipt["verdict"], "passed")
            joined = b"".join(files.values()).decode()
            self.assertNotIn("credential-uid", files["stateless-executor.yaml"].decode())
            self.assertNotIn("kubeconfig", joined.lower())
            self.assertNotIn("executor-token\":", joined)
            documents = [item for item in yaml.safe_load_all(files["stateless-executor.yaml"]) if item]
            self.assertFalse(any(item["kind"] == "Secret" for item in documents))
            deployment = next(item for item in documents if item["kind"] == "Deployment")
            self.assertEqual(
                deployment["spec"]["template"]["spec"]["containers"][1]["image"],
                fixture.runtime_image,
            )
            endpoint_documents = list(yaml.safe_load_all(files["stateless-private-endpoint.yaml"]))
            self.assertEqual([item["kind"] for item in endpoint_documents], ["TkeServiceConfig", "Service"])
            config, endpoint = endpoint_documents
            self.assertEqual(
                config["spec"]["loadBalancer"]["l4Listeners"],
                [{"protocol": "TCP", "port": 19084, "scheduler": "LEAST_CONN", "deregisterTargetRst": True}],
            )
            self.assertEqual(endpoint["spec"]["externalTrafficPolicy"], "Local")
            self.assertEqual(endpoint["spec"]["loadBalancerSourceRanges"], ["10.160.0.0/16"])
            self.assertEqual(
                endpoint["metadata"]["annotations"]["service.cloud.tencent.com/loadbalance-retain"],
                "true",
            )
            evidence = json.loads(files["evidence.json"])
            self.assertEqual(evidence["adoptionIdentity"]["deploymentUid"], "deployment-uid")
            self.assertEqual(evidence["adoptionIdentity"]["credentialUid"], "credential-uid")
            self.assertEqual(evidence["adoptionIdentity"]["privateServiceConfigUid"], "private-service-config-uid")

    def test_rejects_registry_substitution(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(Path(temporary))
            value = json.loads(fixture.registry.read_text())
            value["endpoint"] = "http://10.160.0.99:8080"
            write(fixture.registry, value)
            with self.assertRaisesRegex(ValueError, "qualified Registry endpoint"):
                fixture.render()

    def test_rejects_stale_private_endpoint_deployment(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(Path(temporary))
            value = json.loads(fixture.endpoint.read_text())
            value["deployment"]["uid"] = "replacement-deployment"
            write(fixture.endpoint, value)
            with self.assertRaisesRegex(ValueError, "installed Deployment"):
                fixture.render()

    def test_rejects_manifest_or_image_drift(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            fixture = Fixtures(Path(temporary))
            value = json.loads(fixture.install.read_text())
            value["manifestSha256"] = "sha256:" + "0" * 64
            write(fixture.install, value)
            with self.assertRaisesRegex(ValueError, "manifest differs"):
                fixture.render()

    def test_rejects_secret_in_source(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            fixture = Fixtures(root)
            source = root / "bad.yaml"
            source.write_text((RUNTIME / "stateless-executor.yaml").read_text() + "\n---\napiVersion: v1\nkind: Secret\nmetadata: {name: bad}\n")
            with self.assertRaisesRegex(ValueError, "must not contain Secrets"):
                RENDER.render_executor(
                    source, fixture.cell, fixture.runtime_image,
                    fixture.runtime_image.rsplit("@", 1)[1], "np-test0001",
                    fixture.registry_url, fixture.router_address,
                )


class StatelessRuntimePublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.root = Path(self.temporary.name)
        fixture = Fixtures(self.root)
        files, receipt = fixture.render()
        self.desired = self.root / "desired"
        self.desired.mkdir()
        for name, value in files.items():
            (self.desired / name).write_bytes(value)
        self.render_receipt = write(self.root / "render.json", receipt)
        seed = self.root / "seed"
        self.remote = self.root / "remote.git"
        subprocess.run(("git", "init", "--quiet", "--initial-branch=main", str(seed)), check=True)
        (seed / "README.md").write_text("# desired state\n")
        subprocess.run(("git", "-C", str(seed), "add", "README.md"), check=True)
        environment = dict(
            os.environ,
            GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@invalid",
            GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@invalid",
        )
        subprocess.run(("git", "-C", str(seed), "commit", "--quiet", "-m", "seed"), env=environment, check=True)
        subprocess.run(("git", "clone", "--quiet", "--bare", str(seed), str(self.remote)), check=True)
        self.base = subprocess.check_output(("git", "-C", str(seed), "rev-parse", "HEAD"), text=True).strip()

    def tearDown(self):
        self.temporary.cleanup()

    def publish(self, name: str, expected: str):
        return PUBLISH.publish(
            self.desired, self.render_receipt, self.remote.as_uri(), self.remote.as_uri(),
            expected, self.root / name, allow_local=True,
        )

    def test_publish_is_cas_bound_and_restart_safe(self):
        first = self.publish("first.json", self.base)
        self.assertNotEqual(first["gitRevision"], self.base)
        resumed = self.publish("resumed.json", self.base)
        self.assertTrue(resumed["resumedAfterPublication"])
        self.assertEqual(resumed["gitRevision"], first["gitRevision"])
        clone = self.root / "clone"
        subprocess.run(("git", "clone", "--quiet", self.remote.as_uri(), str(clone)), check=True)
        self.assertEqual(
            PUBLISH.inventory(clone / "runtime-cells" / "actor-bj-k02"),
            first["files"],
        )

    def test_publish_rejects_unrelated_revision_advance(self):
        first = self.publish("first.json", self.base)
        clone = self.root / "other"
        subprocess.run(("git", "clone", "--quiet", self.remote.as_uri(), str(clone)), check=True)
        (clone / "unrelated.txt").write_text("changed\n")
        subprocess.run(("git", "-C", str(clone), "add", "unrelated.txt"), check=True)
        environment = dict(
            os.environ,
            GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@invalid",
            GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@invalid",
        )
        subprocess.run(("git", "-C", str(clone), "commit", "--quiet", "-m", "other"), env=environment, check=True)
        subprocess.run(("git", "-C", str(clone), "push", "--quiet", "origin", "HEAD:main"), check=True)
        # The target still matches, so replaying the already published bytes is
        # safe even when an unrelated Cell advanced the shared repository.
        resumed = self.publish("resumed.json", first["gitRevision"])
        self.assertTrue(resumed["resumedAfterPublication"])

        changed = json.loads(self.render_receipt.read_text())
        changed["files"]["evidence.json"] = "sha256:" + "0" * 64
        write(self.root / "bad-render.json", changed)
        with self.assertRaisesRegex(ValueError, "differs"):
            PUBLISH.publish(
                self.desired, self.root / "bad-render.json", self.remote.as_uri(), self.remote.as_uri(),
                first["gitRevision"], self.root / "bad.json", allow_local=True,
            )


class StatelessRuntimeApplicationTests(unittest.TestCase):
    def test_application_binds_registration_publication_and_hpa_ownership(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            fixture = Fixtures(root)
            _, desired = fixture.render()
            desired_path = write(root / "desired.json", desired)
            revision = "a" * 40
            repository = "http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git"
            publication_path = write(root / "publication.json", {
                "schema": "actor-stateless-runtime-desired-publication/v1", "verdict": "passed",
                "cell": fixture.cell,
                "repository": {"url": repository, "branch": "main", "path": f"runtime-cells/{fixture.cell}"},
                "baseRevision": "b" * 40, "observedRevision": "b" * 40,
                "gitRevision": revision, "resumedAfterPublication": False,
                "renderReceiptSha256": APPLICATION.sha(desired_path), "files": desired["files"],
            })
            registration_path = write(root / "registration.json", {
                "schemaVersion": 3, "cellId": fixture.cell, "clusterId": "cls-test0001",
                "server": "https://10.3.0.10", "registrationScope": "production",
                "publicationRepository": {"url": repository, "branch": "main", "path": f"cells/{fixture.cell}"},
                "argoClusterSecret": {
                    "name": f"actor-cell-{fixture.cell}", "uid": "cluster-secret-uid", "resourceVersion": "10",
                },
                "permissions": {
                    "machineSetDelete": False, "rivetCellDelete": False, "secretRead": False,
                    "fdbWorkloadCreate": False, "statelessSecretRead": False,
                    "statelessWorkloadDelete": False,
                },
            })
            application = APPLICATION.render(publication_path, desired_path, registration_path)
            self.assertEqual(application["spec"]["project"], "actor-cell-runtime")
            self.assertEqual(application["spec"]["destination"]["server"], "https://10.3.0.10")
            self.assertEqual(application["spec"]["destination"]["namespace"], "actor-stateless-system")
            self.assertEqual(application["spec"]["source"]["path"], f"runtime-cells/{fixture.cell}")
            self.assertFalse(application["spec"]["syncPolicy"]["automated"]["prune"])
            self.assertIn({
                "group": "apps", "kind": "Deployment",
                "name": f"{fixture.cell}-stateless-executor",
                "jsonPointers": ["/spec/replicas"],
            }, application["spec"]["ignoreDifferences"])
            self.assertEqual(
                application["metadata"]["annotations"]["fleet.actor.dev/argo-cluster-secret-uid"],
                "cluster-secret-uid",
            )

    def test_application_rejects_cross_cell_registration(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            fixture = Fixtures(root)
            _, desired = fixture.render()
            desired_path = write(root / "desired.json", desired)
            repository = "http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git"
            publication_path = write(root / "publication.json", {
                "schema": "actor-stateless-runtime-desired-publication/v1", "verdict": "passed",
                "cell": fixture.cell,
                "repository": {"url": repository, "branch": "main", "path": f"runtime-cells/{fixture.cell}"},
                "gitRevision": "a" * 40,
                "renderReceiptSha256": APPLICATION.sha(desired_path), "files": desired["files"],
            })
            registration_path = write(root / "registration.json", {
                "schemaVersion": 3, "cellId": "actor-bj-k03", "server": "https://10.3.0.10",
                "registrationScope": "production",
                "publicationRepository": {"url": repository, "branch": "main", "path": "cells/actor-bj-k03"},
                "argoClusterSecret": {"name": "actor-cell-actor-bj-k03", "uid": "uid"},
                "permissions": {
                    "machineSetDelete": False, "rivetCellDelete": False, "secretRead": False,
                    "fdbWorkloadCreate": False, "statelessSecretRead": False,
                    "statelessWorkloadDelete": False,
                },
            })
            with self.assertRaisesRegex(ValueError, "Cell identities differ"):
                APPLICATION.render(publication_path, desired_path, registration_path)

    def test_installer_checks_live_cluster_identity_and_waits_for_health(self):
        self.assertIn('metadata.get("uid") != expected_uid', INSTALLER)
        self.assertIn('decode("server") != server', INSTALLER)
        self.assertIn('decode("namespaces") != "actor-fdb-cell-system,actor-stateless-system"', INSTALLER)
        self.assertIn('.status.sync.status == "Synced"', INSTALLER)
        self.assertIn('.status.health.status == "Healthy"', INSTALLER)
        self.assertIn('(.status.conditions // [] | length) == 0', INSTALLER)
        self.assertIn('"schema":"actor-stateless-runtime-argocd-convergence/v1"', INSTALLER)
        self.assertNotIn("kubectl delete", INSTALLER)


if __name__ == "__main__":
    unittest.main()
