#!/usr/bin/env python3

import importlib.util
import json
import pathlib
import tempfile
import unittest

import yaml


PATH = pathlib.Path(__file__).with_name("render_release_hooks.py")
SPEC = importlib.util.spec_from_file_location("render_release_hooks", str(PATH))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def digest(name):
    return "registry.invalid/{0}@sha256:{1}".format(name, "a" * 64)


def arguments():
    return MODULE.parse_args([
        "--hook-image", digest("hook"), "--runtime-image", digest("runtime-new"),
        "--source-revision", "1" * 40, "--source-manifest-sha256", "2" * 64,
        "--reporter-image", digest("reporter-new"),
        "--reporter-source-revision", "5" * 40,
        "--reporter-source-manifest-sha256", "6" * 64,
        "--previous-runtime-image", digest("runtime-old"),
        "--previous-source-revision", "3" * 40,
        "--previous-source-manifest-sha256", "4" * 64,
        "--previous-reporter-image", digest("reporter-old"),
        "--previous-reporter-source-revision", "7" * 40,
        "--previous-reporter-source-manifest-sha256", "8" * 64,
        "--tat-instance-id", "ins-test",
        "--auth-mode", "secret", "--credential-secret", "actor-release-credentials",
        "--image-pull-secret", "actor-tcr-pull",
    ])


def release_identity(image, revision, manifest):
    return {
        "image": image,
        "sourceRevision": revision,
        "sourceManifestSHA256": manifest,
    }


def approval(args):
    return {
        "schema": "actor-approved-release-commands/v2",
        "cell": "actor-bj-q01",
        "runID": MODULE.release_run_id(args),
        "control": {"sourceRevision": "9" * 40, "sourceManifestSHA256": "a" * 64},
        "upgrade": {"commandID": args.upgrade_command_id, "contentSHA256": "b" * 64},
        "rollback": {"commandID": args.rollback_command_id, "contentSHA256": "c" * 64},
        "candidate": {
            "runtime": release_identity(args.runtime_image, args.source_revision, args.source_manifest_sha256),
            "reporter": release_identity(args.reporter_image, args.reporter_source_revision, args.reporter_source_manifest_sha256),
        },
        "previous": {
            "runtime": release_identity(args.previous_runtime_image, args.previous_source_revision, args.previous_source_manifest_sha256),
            "reporter": release_identity(args.previous_reporter_image, args.previous_reporter_source_revision, args.previous_reporter_source_manifest_sha256),
        },
        "imageInventorySHA256": "d" * 64,
        "coldBucket": "actor-depot-cold-prod-bj-q01-nv1-1234567890",
        "qualificationCandidate": None,
        "approvalTag": "actor-release-approved=true",
        "parameterized": False,
        "verdict": "passed",
    }


class ReleaseHookTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temporary.cleanup()

    def bind_approval(self, args):
        path = pathlib.Path(self.temporary.name) / "approved.json"
        path.write_text(json.dumps(approval(args)))
        args.approved_commands_receipt = str(path)
        return args

    def test_renders_native_sync_and_syncfail_hooks(self):
        intent, upgrade, rollback = MODULE.render(arguments())
        run_id = intent["data"]["runID"]
        self.assertEqual(len(run_id), 32)
        self.assertEqual(upgrade["metadata"]["annotations"]["argocd.argoproj.io/hook"], "Sync")
        self.assertEqual(rollback["metadata"]["annotations"]["argocd.argoproj.io/hook"], "SyncFail")
        self.assertEqual(upgrade["spec"]["backoffLimit"], 0)
        self.assertEqual(rollback["spec"]["backoffLimit"], 0)
        self.assertEqual(upgrade["metadata"]["annotations"]["fleet.actor.dev/release-run-id"], run_id)
        env = {
            entry["name"]: entry
            for entry in upgrade["spec"]["template"]["spec"]["containers"][0]["env"]
        }
        self.assertEqual(env["RIVET_RELEASE_ORCHESTRATOR"]["value"], "argocd")
        self.assertEqual(env["RIVET_RELEASE_APPLICATION"]["value"], "actor-runtime-release-q01")
        self.assertEqual(env["RIVET_RELEASE_APPLICATION_NAMESPACE"]["value"], "argocd")
        self.assertEqual(env["RIVET_RELEASE_HOOK_PHASE"]["value"], "Sync")
        self.assertEqual(env["RIVET_RELEASE_POD_UID"]["valueFrom"]["fieldRef"]["fieldPath"], "metadata.uid")
        rollback_args = rollback["spec"]["template"]["spec"]["containers"][0]["args"]
        self.assertIn("user-transparent-upgrade-{}.json".format(run_id), rollback_args[-1])
        self.assertEqual(rollback_args[4:6], ["7" * 40, "8" * 64])
        self.assertFalse(upgrade["spec"]["template"]["spec"]["automountServiceAccountToken"])
        self.assertEqual(
            upgrade["spec"]["template"]["spec"]["imagePullSecrets"],
            [{"name": "actor-tcr-pull"}],
        )

    def test_run_identity_is_deterministic_and_changes_with_candidate(self):
        first = MODULE.release_run_id(arguments())
        self.assertEqual(first, MODULE.release_run_id(arguments()))
        changed = arguments()
        changed.source_revision = "5" * 40
        self.assertNotEqual(first, MODULE.release_run_id(changed))

    def test_hook_identity_changes_desired_state_without_changing_release_run(self):
        first_args = arguments()
        first_intent = MODULE.render(first_args)[0]
        changed_args = arguments()
        changed_args.hook_image = digest("hook-fixed")
        changed_intent = MODULE.render(changed_args)[0]

        self.assertEqual(first_intent["data"]["runID"], changed_intent["data"]["runID"])
        self.assertNotEqual(
            first_intent["data"]["hookImage"], changed_intent["data"]["hookImage"]
        )

    def test_release_attempt_creates_a_distinct_transaction_identity(self):
        first_args = arguments()
        first_args.release_attempt = "initial"
        retry_args = arguments()
        retry_args.release_attempt = "pull-authority-v1"
        first = MODULE.render(first_args)
        retry = MODULE.render(retry_args)

        self.assertNotEqual(first[0]["data"]["runID"], retry[0]["data"]["runID"])
        self.assertNotEqual(first[0]["data"]["releaseAttempt"], retry[0]["data"]["releaseAttempt"])
        for document in retry:
            self.assertEqual(
                document["metadata"]["annotations"]["fleet.actor.dev/release-attempt"],
                "pull-authority-v1",
            )

    def test_oidc_is_default_and_contains_no_static_cloud_secret(self):
        args = arguments()
        args.auth_mode = "oidc"
        args.credential_secret = None
        args.tke_provider_id = "cls-test"
        args.tke_role_arn = "qcs::cam::uin/100000000001:roleName/actor-release-hook"
        args.upgrade_command_id = "cmd-upgr4de1"
        args.rollback_command_id = "cmd-r0llback"
        self.bind_approval(args)
        approval_config, intent, upgrade, rollback = MODULE.render(args)
        self.assertEqual(approval_config["kind"], "ConfigMap")
        self.assertEqual(
            approval_config["metadata"]["annotations"]["fleet.actor.dev/release-run-id"],
            intent["data"]["runID"],
        )
        pod = upgrade["spec"]["template"]["spec"]
        env = {entry["name"]: entry for entry in pod["containers"][0]["env"]}
        self.assertIn("TKE_WEB_IDENTITY_TOKEN_FILE", env)
        self.assertEqual(
            env["TENCENT_API_ROOT_DOMAIN"]["value"], "internal.tencentcloudapi.com"
        )
        self.assertEqual(env["TAT_COMMAND_ID"]["value"], "cmd-upgr4de1")
        self.assertEqual(
            env["RIVET_APPROVED_COMMANDS_RECEIPT"]["value"],
            "/etc/actor-release/approved-release-commands.json",
        )
        self.assertNotIn("TENCENTCLOUD_SECRET_ID", env)
        rollback_env = {
            entry["name"]: entry
            for entry in rollback["spec"]["template"]["spec"]["containers"][0]["env"]
        }
        self.assertEqual(rollback_env["TAT_COMMAND_ID"]["value"], "cmd-r0llback")
        self.assertEqual(intent["data"]["upgradeCommandID"], "cmd-upgr4de1")
        token = next(volume for volume in pod["volumes"] if volume["name"] == "tke-oidc-token")
        self.assertEqual(
            token["projected"]["sources"][0]["serviceAccountToken"]["audience"],
            "sts.cloud.tencent.com",
        )

    def test_rejects_approval_for_another_candidate_before_render(self):
        args = arguments()
        args.auth_mode = "oidc"
        args.credential_secret = None
        args.tke_provider_id = "cls-test"
        args.tke_role_arn = "qcs::cam::uin/100000000001:roleName/actor-release-hook"
        args.upgrade_command_id = "cmd-upgr4de1"
        args.rollback_command_id = "cmd-r0llback"
        payload = approval(args)
        payload["candidate"]["runtime"]["image"] = digest("other")
        path = pathlib.Path(self.temporary.name) / "wrong-approved.json"
        path.write_text(json.dumps(payload))
        args.approved_commands_receipt = str(path)
        with self.assertRaisesRegex(ValueError, "runtime identity mismatch"):
            MODULE.render(args)

    def test_oidc_requires_provider_and_role(self):
        args = arguments()
        args.auth_mode = "oidc"
        args.credential_secret = None
        with self.assertRaisesRegex(ValueError, "provider ID"):
            MODULE.render(args)
        args.tke_provider_id = "cls-test"
        with self.assertRaisesRegex(ValueError, "role ARN"):
            MODULE.render(args)
        args.tke_role_arn = "qcs::cam::uin/100000000001:roleName/actor-release-hook"
        with self.assertRaisesRegex(ValueError, "approved TAT commands"):
            MODULE.render(args)

    def test_rejects_mutable_image(self):
        args = arguments()
        args.hook_image = "registry.invalid/hook:latest"
        with self.assertRaisesRegex(ValueError, "not pinned"):
            MODULE.render(args)

    def test_argocd_release_project_has_narrow_ownership(self):
        root = PATH.parent
        project = yaml.safe_load((root / "argocd-project.example.yaml").read_text())
        application = yaml.safe_load((root / "application.example.yaml").read_text())
        allowed = {
            (entry["group"], entry["kind"])
            for entry in project["spec"]["namespaceResourceWhitelist"]
        }
        self.assertEqual(
            allowed,
            {("", "ConfigMap"), ("", "PersistentVolumeClaim"), ("batch", "Job")},
        )
        self.assertEqual(project["spec"]["clusterResourceWhitelist"], [])
        self.assertFalse(application["spec"]["syncPolicy"]["automated"]["prune"])
        self.assertFalse(application["spec"]["syncPolicy"]["automated"]["selfHeal"])
        self.assertEqual(application["spec"]["syncPolicy"]["retry"]["limit"], 0)

    def test_runtime_hook_build_has_no_public_network_dependency(self):
        root = PATH.parent
        dockerfile = (root / "Dockerfile.release-hook").read_text()
        dependency = (root / "Dockerfile.release-hook-base").read_text()
        foundation_lock = json.loads((root / "image-seed" / "foundation-images.lock.json").read_text())
        foundation = next(
            item for item in foundation_lock["images"]
            if item["repository"] == "base-tencentcloud-cli"
        )
        self.assertIn("ARG RELEASE_HOOK_BASE", dockerfile)
        self.assertNotIn("tencentcloudcr.com", dockerfile)
        self.assertNotIn("apt-get", dockerfile)
        self.assertIn("ARG SOURCE_IMAGE", dependency)
        self.assertIn("verify_approved_release_commands.py", dockerfile)
        self.assertEqual(
            foundation["source"],
            "tencentcom/tencentcloud-cli@sha256:6d13c0559c17a61cf43769b58430c3b914e48d246e298fa85e19095cb20a36c6",
        )
        self.assertIn("apt-get install -y --no-install-recommends jq", dependency)


if __name__ == "__main__":
    unittest.main()
