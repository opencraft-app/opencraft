import pathlib
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parent


class QualificationGitTest(unittest.TestCase):
    def setUp(self):
        self.documents = [
            document
            for document in yaml.safe_load_all(
                (ROOT / "qualification-git-service.yaml").read_text()
            )
            if document
        ]

    def one(self, kind, name):
        matches = [
            document
            for document in self.documents
            if document["kind"] == kind and document["metadata"]["name"] == name
        ]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_private_persistent_digest_pinned_service(self):
        stateful_set = self.one("StatefulSet", "actor-git")
        pod = stateful_set["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        image = pod["containers"][0]["image"]
        self.assertRegex(image, r"^lightclaw-bj82\.tencentcloudcr\.com/.+@sha256:[0-9a-f]{64}$")
        self.assertEqual(pod["securityContext"]["runAsUser"], 1000)
        pvc = self.one("PersistentVolumeClaim", "actor-git-data")
        self.assertEqual(pvc["spec"]["storageClassName"], "actor-git-cbs-wffc-retain")
        storage_class = self.one("StorageClass", "actor-git-cbs-wffc-retain")
        self.assertEqual(storage_class["reclaimPolicy"], "Retain")

    def test_only_git_and_argocd_namespaces_can_reach_http(self):
        policy = self.one("NetworkPolicy", "actor-git-ingress")
        ingress = policy["spec"]["ingress"]
        self.assertEqual(len(ingress), 1)
        sources = ingress[0]["from"]
        self.assertEqual(
            sources[0]["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"],
            "actor-git-system",
        )
        self.assertEqual(
            sources[1]["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"],
            "argocd",
        )
        self.assertEqual(
            sources[1]["podSelector"]["matchLabels"]["app.kubernetes.io/name"],
            "argocd-repo-server",
        )
        self.assertEqual(ingress[0]["ports"], [{"protocol": "TCP", "port": 3000}])

    def test_bootstrap_separates_reader_and_publisher(self):
        installer = (ROOT / "install-qualification-git.sh").read_text()
        publisher = (ROOT / "publish-desired-state.sh").read_text()
        for guard in (
            "write:repository",
            "read:repository",
            "argocd.argoproj.io/secret-type=repository",
            "actor-q01-qualification-git-install/v1",
            "chmod 0600",
        ):
            self.assertIn(guard, installer)
        self.assertNotIn("write:user", installer)
        self.assertIn('control_rbac=$script_dir/argocd-control-rbac.yaml', installer)
        self.assertIn('kubectl apply --dry-run=server -f "$control_rbac"', installer)
        self.assertIn('"controlRBACSHA256":control_rbac', installer)
        self.assertNotIn("password:", (ROOT / "qualification-git-service.yaml").read_text())
        self.assertIn("GIT_ASKPASS", publisher)
        self.assertNotIn("http://release-publisher:", publisher)
        self.assertIn("git clone --quiet", publisher)
        self.assertNotIn("git init", publisher)
        self.assertNotIn("if ! git clone", publisher)

    def test_control_application_cannot_expand_its_own_authority(self):
        project = yaml.safe_load((ROOT / "control-project-q01.yaml").read_text())
        application = yaml.safe_load((ROOT / "control-application-q01.yaml").read_text())
        self.assertEqual(application["spec"]["project"], "actor-cell-control")
        self.assertEqual(application["spec"]["source"]["path"], "platform/actor-bj-q01/current")
        self.assertTrue(application["spec"]["syncPolicy"]["automated"]["selfHeal"])
        self.assertFalse(application["spec"]["syncPolicy"]["automated"]["prune"])
        self.assertIn(
            "RespectIgnoreDifferences=true",
            application["spec"]["syncPolicy"]["syncOptions"],
        )
        self.assertEqual(
            application["spec"]["ignoreDifferences"],
            [
                {
                    "group": "fleet.actor.dev",
                    "kind": "RivetCell",
                    "name": "actor-bj-q01",
                    "namespace": "actor-fdb-cell-system",
                    "jsonPointers": ["/spec/desiredState"],
                }
            ],
        )
        self.assertFalse(project["spec"]["orphanedResources"]["warn"])
        cluster_kinds = {(item["group"], item["kind"]) for item in project["spec"]["clusterResourceWhitelist"]}
        self.assertNotIn(("argoproj.io", "Application"), cluster_kinds)
        self.assertNotIn(("argoproj.io", "AppProject"), cluster_kinds)
        self.assertNotIn(("apiextensions.k8s.io", "CustomResourceDefinition"), cluster_kinds)
        self.assertNotIn(("rbac.authorization.k8s.io", "ClusterRole"), cluster_kinds)
        namespace_kinds = {(item["group"], item["kind"]) for item in project["spec"]["namespaceResourceWhitelist"]}
        self.assertNotIn(("", "Secret"), namespace_kinds)

    def test_control_publisher_has_one_bounded_target(self):
        wrapper = (ROOT / "publish-control-desired-state.sh").read_text()
        publisher = (ROOT / "publish-desired-state.sh").read_text()
        self.assertIn("ACTOR_GIT_TARGET_PATH=platform/actor-bj-q01/current", wrapper)
        self.assertIn("platform/actor-bj-q01/current", publisher)
        self.assertIn("outside the reviewed q01 desired-state roots", publisher)

    def test_control_cache_has_no_secret_or_delete_authority(self):
        documents = [
            item for item in yaml.safe_load_all((ROOT / "argocd-control-rbac.yaml").read_text())
            if item
        ]
        for role in (item for item in documents if item["kind"] in {"Role", "ClusterRole"}):
            for rule in role["rules"]:
                self.assertNotIn("secrets", rule["resources"])
                self.assertNotIn("delete", rule["verbs"])

    def test_fdb_qualification_recovery_can_only_reenable_exact_application(self):
        documents = [
            item for item in yaml.safe_load_all((ROOT / "argocd-control-rbac.yaml").read_text())
            if item
        ]
        account = next(
            item for item in documents
            if item["kind"] == "ServiceAccount"
            and item["metadata"]["name"] == "actor-fdb-autoscaling-recovery"
        )
        self.assertEqual(account["metadata"]["namespace"], "argocd")
        self.assertEqual(account["imagePullSecrets"], [{"name": "actor-fleet-tcr"}])
        role = next(
            item for item in documents
            if item["kind"] == "Role"
            and item["metadata"]["name"] == "actor-fdb-autoscaling-recovery"
        )
        self.assertEqual(
            role["rules"],
            [{
                "apiGroups": ["argoproj.io"],
                "resources": ["applications"],
                "resourceNames": ["actor-cell-control-q01"],
                "verbs": ["get", "patch"],
            }],
        )

    def test_fdb_qualification_never_fights_argo_self_heal(self):
        qualification = (ROOT.parent / "autoscaling" / "qualify.sh").read_text()
        wrapper = (
            ROOT.parent / "qualification" / "actor-bj-q01"
            / "run-fdb-autoscaling-via-tat.sh"
        ).read_text()
        scale_up = "start_argo_recovery_guard up 900\nset_profile up\nwait_cell_desired 12\nrestore_profile"
        scale_down = "start_argo_recovery_guard down 5100\nset_profile down\nwait_cell_desired 9 4500\nrestore_profile"
        self.assertIn(scale_up, qualification)
        self.assertIn(scale_down, qualification)
        self.assertIn('"op":"test","path":"/metadata/uid"', qualification)
        self.assertIn('"op":"test","path":"/spec/syncPolicy/automated/selfHeal"', qualification)
        self.assertIn('"op":"replace","path":"/spec/syncPolicy/automated/selfHeal"', qualification)
        self.assertIn('"op":"add","path":"/metadata/annotations/argocd.argoproj.io~1refresh"', qualification)
        self.assertIn('"backoffLimit":0', qualification)
        self.assertIn('"activeDeadlineSeconds":int(delay)+300', qualification)
        self.assertIn("observability-kubectl", wrapper)
        self.assertIn("observability-busybox", wrapper)
        self.assertIn("ACTOR_QUALIFICATION_RUN_ID is not a valid resumable qualification identity", wrapper)
        self.assertIn("-resume-\\$(date -u +%s).json", wrapper)

    def test_release_service_account_owns_private_registry_pull_auth(self):
        documents = [
            document
            for document in yaml.safe_load_all((ROOT / "bootstrap.example.yaml").read_text())
            if document
        ]
        account = next(document for document in documents if document["kind"] == "ServiceAccount")
        self.assertEqual(account["metadata"]["name"], "actor-release-hook")
        self.assertEqual(account["imagePullSecrets"], [{"name": "actor-fleet-tcr"}])

    def test_release_receipts_use_explicit_retain_cbs(self):
        claim = yaml.safe_load((ROOT / "release-receipts-pvc.yaml").read_text())
        storage_class = yaml.safe_load((ROOT / "release-storageclass.yaml").read_text())
        self.assertEqual(claim["spec"]["storageClassName"], storage_class["metadata"]["name"])
        self.assertEqual(claim["spec"]["resources"]["requests"]["storage"], "10Gi")
        self.assertEqual(claim["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"], "0")
        self.assertNotIn(
            "argocd.argoproj.io/tracking-id", claim["metadata"]["annotations"]
        )
        self.assertEqual(storage_class["reclaimPolicy"], "Retain")
        self.assertEqual(storage_class["volumeBindingMode"], "WaitForFirstConsumer")

    def test_argocd_cache_and_cluster_are_release_scoped(self):
        documents = [
            document
            for document in yaml.safe_load_all((ROOT / "argocd-release-scope.yaml").read_text())
            if document
        ]
        config = next(document for document in documents if document["kind"] == "ConfigMap")
        target = next(document for document in documents if document["kind"] == "Secret")
        inclusions = yaml.safe_load(config["data"]["resource.inclusions"])
        kinds = {kind for item in inclusions for kind in item["kinds"]}
        self.assertEqual(kinds, {"ConfigMap", "PersistentVolumeClaim", "Job", "Deployment", "Service", "RivetCell", "RivetCellProfile", "ShardClass"})
        self.assertEqual(config["data"]["resource.respectRBAC"], "strict")
        self.assertEqual(target["stringData"]["namespaces"], "actor-release-system,actor-fdb-cell-system,fdb-operator-actor-fleet-controller-system")
        self.assertEqual(target["stringData"]["clusterResources"], "true")
        self.assertNotIn("project", target["stringData"])
        self.assertNotIn("bearerToken", target["stringData"]["config"])


if __name__ == "__main__":
    unittest.main()
