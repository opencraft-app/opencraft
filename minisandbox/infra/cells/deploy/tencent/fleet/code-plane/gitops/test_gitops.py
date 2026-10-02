import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent


def sha(path, prefix=True):
    value = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{value}" if prefix else value


class CodePlaneGitOpsTest(unittest.TestCase):
    def command(self, *args, cwd=None):
        return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)

    def test_clean_room_resource_inclusions_cover_every_code_plane_kind(self):
        config = yaml.safe_load((ROOT / "resource-inclusions.yaml").read_text())
        inclusions = yaml.safe_load(config["data"]["resource.inclusions"])
        discovered = {
            (group, kind)
            for entry in inclusions
            for group in entry["apiGroups"]
            for kind in entry["kinds"]
        }
        required = {
            ("", "Namespace"),
            ("", "ServiceAccount"),
            ("", "Service"),
            ("apps", "Deployment"),
            ("policy", "PodDisruptionBudget"),
            ("apps.foundationdb.org", "FoundationDBCluster"),
            ("apps.foundationdb.org", "FoundationDBBackup"),
        }
        self.assertTrue(required.issubset(discovered))
        for entry in inclusions:
            self.assertEqual(
                entry["clusters"],
                ["https://kubernetes.default.svc", "__MANAGEMENT_CLUSTER_URL__"],
            )
        self.assertNotIn(("", "Secret"), discovered)

    def test_render_publish_and_application_are_prune_safe(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary); source = root / "source"; source.mkdir()
            manifests = {
                "fdb-cluster.yaml": {"apiVersion": "apps.foundationdb.org/v1beta2", "kind": "FoundationDBCluster", "metadata": {"name": "actor-bj-c01", "namespace": "actor-fdb-cell-system"}},
                "fdb-backup.yaml": {"apiVersion": "apps.foundationdb.org/v1beta2", "kind": "FoundationDBBackup", "metadata": {"name": "actor-bj-c01-continuous", "namespace": "actor-fdb-cell-system"}},
                "worker-registry.yaml": {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "worker-registry", "namespace": "worker-registry-system"}},
                "worker-registry-private.yaml": {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "worker-registry-private", "namespace": "worker-registry-system"}},
            }
            for name, value in manifests.items(): (source / name).write_text(yaml.safe_dump(value))
            rendered = {"schema": "actor-regional-code-plane-render/v1", "verdict": "passed", "managementId": "actor-bj-c01", "clusterId": "cls-test0001", "files": {name: sha(source / name, False) for name in manifests}}
            render_receipt = root / "render.json"; render_receipt.write_text(json.dumps(rendered))
            installed = {"schema": "actor-regional-code-plane-install/v1", "verdict": "passed", "managementId": "actor-bj-c01", "cluster": {"id": "cls-test0001"}, "inputs": {"renderReceiptSha256": sha(render_receipt, False)}, "foundationDB": {"uid": "fdb-uid", "backup": {"uid": "backup-uid"}}, "registry": {"deploymentUid": "registry-uid", "privateServiceUid": "service-uid", "endpoint": "http://10.1.2.3:8080"}, "externalSecrets": {"registryCosUid": "secret-uid"}}
            install_receipt = root / "install.json"; install_receipt.write_text(json.dumps(installed))
            desired, desired_receipt = root / "desired", root / "desired.json"
            self.command(sys.executable, str(ROOT / "render-desired-state.py"), "--source", str(source), "--render-receipt", str(render_receipt), "--install-receipt", str(install_receipt), "--output-dir", str(desired), "--receipt", str(desired_receipt))
            kustomization = yaml.safe_load((desired / "kustomization.yaml").read_text())
            self.assertNotIn("patches", kustomization)
            protected = []
            for path in desired.glob("*.yaml"):
                protected.extend(item for item in yaml.safe_load_all(path.read_text()) if item and item.get("metadata", {}).get("annotations", {}).get("argocd.argoproj.io/sync-options") == "Prune=false")
            self.assertEqual({item["kind"] for item in protected}, {"FoundationDBCluster", "FoundationDBBackup", "Service"})
            documents = []
            for path in desired.glob("*.yaml"):
                documents.extend(item for item in yaml.safe_load_all(path.read_text()) if item)
            self.assertFalse(any(item.get("kind") == "Secret" for item in documents))

            bare=root / "remote.git"; seed=root / "seed"
            self.command("git", "init", "--bare", "--initial-branch=main", str(bare)); self.command("git", "clone", str(bare), str(seed))
            (seed / "README").write_text("seed\n"); self.command("git", "add", "README", cwd=seed)
            env = {**__import__("os").environ, "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "test@example.invalid"}
            subprocess.run(("git", "commit", "-m", "seed"), cwd=seed, env=env, check=True, capture_output=True); self.command("git", "push", "origin", "main", cwd=seed)
            revision=self.command("git", "rev-parse", "HEAD", cwd=seed).stdout.strip(); publication=root / "publication.json"
            self.command(sys.executable, str(ROOT / "publish-desired-state.py"), "--desired-root", str(desired), "--render-receipt", str(desired_receipt), "--repository-url", bare.as_uri(), "--read-url", "http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git", "--expected-revision", revision, "--receipt", str(publication), "--allow-local-repository")
            application=root / "application.yaml"
            self.command(sys.executable, str(ROOT / "render-application.py"), "--publication-receipt", str(publication), "--desired-render-receipt", str(desired_receipt), "--output", str(application))
            documents=list(yaml.safe_load_all(application.read_text())); app=next(item for item in documents if item["kind"]=="Application")
            self.assertFalse(app["spec"]["syncPolicy"]["automated"]["prune"]); self.assertTrue(app["spec"]["syncPolicy"]["automated"]["selfHeal"])


if __name__ == "__main__": unittest.main()
