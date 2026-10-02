#!/usr/bin/env python3
"""Render native Argo CD Hooks for one immutable q01 runtime release."""

import argparse
import hashlib
import json
import pathlib
import re
import sys

import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from verify_approved_release_commands import verify as verify_approved_commands


IMAGE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
DNS = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
ATTEMPT = re.compile(r"^[a-z0-9](?:[-a-z0-9.]{0,61}[a-z0-9])?$")
ROLE_ARN = re.compile(r"^qcs::cam::uin/[0-9]+:roleName/[A-Za-z0-9._-]+$")


def release_run_id(args):
    identity = {
        "cell": args.cell,
        "releaseAttempt": args.release_attempt,
        "runtimeImage": args.runtime_image,
        "sourceRevision": args.source_revision,
        "sourceManifestSHA256": args.source_manifest_sha256,
        "reporterImage": args.reporter_image,
        "reporterSourceRevision": args.reporter_source_revision,
        "reporterSourceManifestSHA256": args.reporter_source_manifest_sha256,
        "previousRuntimeImage": args.previous_runtime_image,
        "previousSourceRevision": args.previous_source_revision,
        "previousSourceManifestSHA256": args.previous_source_manifest_sha256,
        "previousReporterImage": args.previous_reporter_image,
        "previousReporterSourceRevision": args.previous_reporter_source_revision,
        "previousReporterSourceManifestSHA256": args.previous_reporter_source_manifest_sha256,
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:32]


def hook_job(name, phase, image, run_id, args, local_receipt, command_id):
    environment = [
        {"name": "TAT_INSTANCE_ID", "value": args.tat_instance_id},
        {"name": "TENCENT_REGION", "value": "ap-beijing"},
        {"name": "RIVET_UPGRADE_RUN_ID", "value": run_id},
        {"name": "RIVET_UPGRADE_LOCAL_RECEIPT", "value": local_receipt},
        {"name": "RIVET_RELEASE_ORCHESTRATOR", "value": "argocd"},
        {"name": "RIVET_RELEASE_APPLICATION", "value": args.application},
        {"name": "RIVET_RELEASE_APPLICATION_NAMESPACE", "value": args.application_namespace},
        {"name": "RIVET_RELEASE_HOOK_JOB", "value": name},
        {"name": "RIVET_RELEASE_HOOK_PHASE", "value": phase},
        {"name": "RIVET_RELEASE_ATTEMPT", "value": args.release_attempt},
        {"name": "RIVET_RELEASE_POD_NAMESPACE", "valueFrom": {"fieldRef": {"fieldPath": "metadata.namespace"}}},
        {"name": "RIVET_RELEASE_POD_NAME", "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}}},
        {"name": "RIVET_RELEASE_POD_UID", "valueFrom": {"fieldRef": {"fieldPath": "metadata.uid"}}},
    ]
    if command_id:
        environment.append({"name": "TAT_COMMAND_ID", "value": command_id})
    volumes = [
        {"name": "receipts", "persistentVolumeClaim": {"claimName": "actor-release-receipts"}},
        {"name": "home", "emptyDir": {}},
    ]
    volume_mounts = [
        {"name": "receipts", "mountPath": "/data/receipts"},
        {"name": "home", "mountPath": "/data/home"},
    ]
    if args.approved_commands_receipt:
        environment.append({
            "name": "RIVET_APPROVED_COMMANDS_RECEIPT",
            "value": "/etc/actor-release/approved-release-commands.json",
        })
        volumes.append({
            "name": "approved-release-commands",
            "configMap": {
                "name": "actor-runtime-release-approval",
                "items": [{
                    "key": "approved-release-commands.json",
                    "path": "approved-release-commands.json",
                }],
            },
        })
        volume_mounts.append({
            "name": "approved-release-commands",
            "mountPath": "/etc/actor-release",
            "readOnly": True,
        })
    if args.auth_mode == "oidc":
        environment.extend([
            {"name": "TKE_REGION", "value": "ap-beijing"},
            {"name": "TENCENT_API_ROOT_DOMAIN", "value": "internal.tencentcloudapi.com"},
            {"name": "TKE_PROVIDER_ID", "value": args.tke_provider_id},
            {"name": "TKE_ROLE_ARN", "value": args.tke_role_arn},
            {"name": "TKE_WEB_IDENTITY_TOKEN_FILE", "value": "/var/run/secrets/cloud.tencent.com/serviceaccount/token"},
        ])
        volumes.append({
            "name": "tke-oidc-token",
            "projected": {"sources": [{"serviceAccountToken": {
                "audience": "sts.cloud.tencent.com", "expirationSeconds": 3600, "path": "token",
            }}]},
        })
        volume_mounts.append({
            "name": "tke-oidc-token",
            "mountPath": "/var/run/secrets/cloud.tencent.com/serviceaccount",
            "readOnly": True,
        })
    else:
        environment.extend([
            {"name": "TENCENTCLOUD_SECRET_ID", "valueFrom": {"secretKeyRef": {"name": args.credential_secret, "key": "secret-id"}}},
            {"name": "TENCENTCLOUD_SECRET_KEY", "valueFrom": {"secretKeyRef": {"name": args.credential_secret, "key": "secret-key"}}},
        ])
    job = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "namespace": args.namespace,
            "annotations": {
                "argocd.argoproj.io/hook": phase,
                "argocd.argoproj.io/hook-delete-policy": "BeforeHookCreation",
                "argocd.argoproj.io/sync-wave": "0" if phase == "Sync" else "1",
                "fleet.actor.dev/release-run-id": run_id,
            },
            "labels": {"app.kubernetes.io/name": "actor-runtime-release-hook"},
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": 10800,
            "template": {
                "metadata": {"labels": {"app.kubernetes.io/name": "actor-runtime-release-hook"}},
                "spec": {
                    "automountServiceAccountToken": False,
                    "serviceAccountName": args.service_account,
                    "restartPolicy": "Never",
                    "securityContext": {
                        "runAsNonRoot": True, "runAsUser": 65532, "runAsGroup": 65532,
                        "fsGroup": 65532, "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "containers": [{
                        "name": "release",
                        "image": image,
                        "imagePullPolicy": "Always",
                        "args": [],
                        "env": environment,
                        "volumeMounts": volume_mounts,
                        "securityContext": {
                            "allowPrivilegeEscalation": False,
                            "capabilities": {"drop": ["ALL"]},
                            "readOnlyRootFilesystem": True,
                        },
                        "resources": {
                            "requests": {"cpu": "50m", "memory": "128Mi"},
                            "limits": {"memory": "512Mi"},
                        },
                    }],
                    "volumes": volumes,
                },
            },
        },
    }
    if args.image_pull_secret:
        job["spec"]["template"]["spec"]["imagePullSecrets"] = [
            {"name": args.image_pull_secret}
        ]
    return job


def render(args):
    identities = [
        args.cell, args.namespace, args.service_account, args.application,
        args.application_namespace,
    ]
    if args.auth_mode == "secret":
        identities.append(args.credential_secret)
    for name in identities:
        if DNS.fullmatch(name) is None:
            raise ValueError("invalid Kubernetes identity: {}".format(name))
    if args.auth_mode == "oidc":
        if not args.tke_provider_id or not args.tke_provider_id.startswith("cls-"):
            raise ValueError("TKE provider ID is invalid")
        if ROLE_ARN.fullmatch(args.tke_role_arn or "") is None:
            raise ValueError("TKE release role ARN is invalid")
        for command_id in (args.upgrade_command_id, args.rollback_command_id):
            if re.fullmatch(r"cmd-[a-z0-9]{8}", command_id or "") is None:
                raise ValueError("production release requires exact approved TAT commands")
        if not args.approved_commands_receipt:
            raise ValueError("production release requires an approved-command receipt")
    elif not args.credential_secret:
        raise ValueError("secret auth requires --credential-secret")
    if args.image_pull_secret and DNS.fullmatch(args.image_pull_secret) is None:
        raise ValueError("invalid image pull Secret: {}".format(args.image_pull_secret))
    for image in (args.hook_image, args.runtime_image, args.reporter_image,
                  args.previous_runtime_image, args.previous_reporter_image):
        if IMAGE.fullmatch(image) is None:
            raise ValueError("release image is not pinned by digest")
    for revision in (
        args.source_revision, args.reporter_source_revision,
        args.previous_source_revision, args.previous_reporter_source_revision,
    ):
        if REVISION.fullmatch(revision) is None:
            raise ValueError("source revision is not immutable")
    for manifest in (
        args.source_manifest_sha256, args.reporter_source_manifest_sha256,
        args.previous_source_manifest_sha256,
        args.previous_reporter_source_manifest_sha256,
    ):
        if SHA.fullmatch(manifest) is None:
            raise ValueError("source manifest is not immutable")
    if not args.tat_instance_id.startswith("ins-"):
        raise ValueError("TAT instance is invalid")
    if ATTEMPT.fullmatch(args.release_attempt) is None:
        raise ValueError("release attempt is invalid")
    run_id = release_run_id(args)
    approval = None
    if args.approved_commands_receipt:
        approval_path = pathlib.Path(args.approved_commands_receipt)
        if not approval_path.is_file() or approval_path.is_symlink():
            raise ValueError("approved-command receipt must be a regular non-symlink file")
        try:
            approval_payload = json.loads(approval_path.read_text())
        except (OSError, ValueError) as error:
            raise ValueError("approved-command receipt is not valid JSON") from error
        candidate = {
            "runtime": {
                "image": args.runtime_image,
                "sourceRevision": args.source_revision,
                "sourceManifestSHA256": args.source_manifest_sha256,
            },
            "reporter": {
                "image": args.reporter_image,
                "sourceRevision": args.reporter_source_revision,
                "sourceManifestSHA256": args.reporter_source_manifest_sha256,
            },
        }
        previous = {
            "runtime": {
                "image": args.previous_runtime_image,
                "sourceRevision": args.previous_source_revision,
                "sourceManifestSHA256": args.previous_source_manifest_sha256,
            },
            "reporter": {
                "image": args.previous_reporter_image,
                "sourceRevision": args.previous_reporter_source_revision,
                "sourceManifestSHA256": args.previous_reporter_source_manifest_sha256,
            },
        }
        try:
            verify_approved_commands(
                approval_payload, phase="upgrade",
                command_id=args.upgrade_command_id, run_id=run_id,
                runtime=candidate["runtime"], reporter=candidate["reporter"],
            )
            verify_approved_commands(
                approval_payload, phase="rollback",
                command_id=args.rollback_command_id, run_id=run_id,
                runtime=previous["runtime"], reporter=previous["reporter"],
            )
        except ValueError as error:
            raise ValueError(
                "approved-command receipt does not bind desired release: {}".format(error)
            ) from error
        approval = {
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": {
                "name": "actor-runtime-release-approval", "namespace": args.namespace,
                "annotations": {
                    "argocd.argoproj.io/sync-wave": "-1",
                    "fleet.actor.dev/release-run-id": run_id,
                },
                "labels": {"app.kubernetes.io/managed-by": "argocd"},
            },
            "immutable": False,
            "data": {
                "approved-release-commands.json": json.dumps(
                    approval_payload, sort_keys=True, separators=(",", ":")
                ) + "\n",
            },
        }
    intent = {
        "apiVersion": "v1", "kind": "ConfigMap",
        "metadata": {
            "name": "actor-runtime-release-intent", "namespace": args.namespace,
            "annotations": {
                "argocd.argoproj.io/sync-wave": "-1",
                "fleet.actor.dev/release-attempt": args.release_attempt,
            },
            "labels": {"app.kubernetes.io/managed-by": "argocd"},
        },
        "immutable": False,
        "data": {
            "schemaVersion": "actor-runtime-release-intent/v1", "cell": args.cell,
            "runID": run_id, "hookImage": args.hook_image,
            "application": args.application,
            "releaseAttempt": args.release_attempt,
            "runtimeImage": args.runtime_image,
            "sourceRevision": args.source_revision,
            "sourceManifestSHA256": args.source_manifest_sha256,
            "reporterImage": args.reporter_image,
            "reporterSourceRevision": args.reporter_source_revision,
            "reporterSourceManifestSHA256": args.reporter_source_manifest_sha256,
            "previousRuntimeImage": args.previous_runtime_image,
            "previousReporterImage": args.previous_reporter_image,
            "previousReporterSourceRevision": args.previous_reporter_source_revision,
            "previousReporterSourceManifestSHA256": args.previous_reporter_source_manifest_sha256,
            "upgradeCommandID": args.upgrade_command_id or "qualification-run-command",
            "rollbackCommandID": args.rollback_command_id or "qualification-run-command",
        },
    }
    upgrade = hook_job(
        "actor-runtime-release", "Sync", args.hook_image, run_id, args,
        "/data/receipts/upgrade-{}.json".format(run_id),
        args.upgrade_command_id,
    )
    upgrade["metadata"]["annotations"]["fleet.actor.dev/release-attempt"] = args.release_attempt
    upgrade["spec"]["template"]["spec"]["containers"][0]["args"] = [
        args.runtime_image, args.source_revision, args.source_manifest_sha256, args.reporter_image,
        args.reporter_source_revision, args.reporter_source_manifest_sha256,
    ]
    rollback = hook_job(
        "actor-runtime-release-rollback", "SyncFail", args.hook_image, run_id, args,
        "/data/receipts/rollback-{}.json".format(run_id),
        args.rollback_command_id,
    )
    rollback["metadata"]["annotations"]["fleet.actor.dev/release-attempt"] = args.release_attempt
    failed_receipt = "/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-{}.json".format(run_id)
    rollback["spec"]["template"]["spec"]["containers"][0]["args"] = [
        args.previous_runtime_image, args.previous_source_revision,
        args.previous_source_manifest_sha256, args.previous_reporter_image,
        args.previous_reporter_source_revision,
        args.previous_reporter_source_manifest_sha256,
        failed_receipt,
    ]
    documents = [intent, upgrade, rollback]
    if approval is not None:
        documents.insert(0, approval)
    return documents


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--cell", default="actor-bj-q01")
    parser.add_argument("--namespace", default="actor-release-system")
    parser.add_argument("--hook-image", required=True)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-manifest-sha256", required=True)
    parser.add_argument("--reporter-image", required=True)
    parser.add_argument("--reporter-source-revision", required=True)
    parser.add_argument("--reporter-source-manifest-sha256", required=True)
    parser.add_argument("--previous-runtime-image", required=True)
    parser.add_argument("--previous-source-revision", required=True)
    parser.add_argument("--previous-source-manifest-sha256", required=True)
    parser.add_argument("--previous-reporter-image", required=True)
    parser.add_argument("--previous-reporter-source-revision", required=True)
    parser.add_argument("--previous-reporter-source-manifest-sha256", required=True)
    parser.add_argument("--tat-instance-id", required=True)
    parser.add_argument("--auth-mode", choices=("oidc", "secret"), default="oidc")
    parser.add_argument("--service-account", default="actor-release-hook")
    parser.add_argument("--application", default="actor-runtime-release-q01")
    parser.add_argument("--application-namespace", default="argocd")
    parser.add_argument("--tke-provider-id")
    parser.add_argument("--tke-role-arn")
    parser.add_argument("--credential-secret")
    parser.add_argument("--upgrade-command-id")
    parser.add_argument("--rollback-command-id")
    parser.add_argument("--approved-commands-receipt")
    parser.add_argument("--image-pull-secret")
    parser.add_argument("--release-attempt", default="initial")
    return parser.parse_args(argv)


def main():
    try:
        documents = render(parse_args())
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    # Qualification builders still carry an older PyYAML without sort_keys.
    yaml.safe_dump_all(documents, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
