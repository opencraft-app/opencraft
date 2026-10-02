#!/usr/bin/env python3
"""Prove C-cluster ApplicationSet convergence and self-heal on a local Cell."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
CREATE_FIRST = ROOT.parents[1] / "terraform" / "create-first"
REPOSITORY_DOCKERFILE = ROOT.parents[3] / "local" / "argocd" / "repository" / "Dockerfile"
SANDBOX_IMAGE_SEEDER = ROOT.parents[3] / "local" / "mesh" / "seed-k3s-sandbox-image.sh"
E2E_PROJECT = "actor-cell-bootstrap-e2e"
E2E_APPLICATION_SET = "actor-cells-e2e"
E2E_REGISTRATION_SCOPE = "applicationset-e2e"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


FIXTURE = load("local_registration_fixture", ROOT / "local-registration-e2e.py")
RENDERER = load("cell_renderer_appset_e2e", CREATE_FIRST / "render-cell-assets.py")
HANDOFF = load("cell_handoff_appset_e2e", ROOT / "verify-handoff.py")
CONVERGENCE = load("cell_convergence_appset_e2e", ROOT / "verify-convergence.py")
PUBLISHER = load("cell_publication_appset_e2e", ROOT / "publish-desired-state.py")


def run(*args: str, env=None, capture=False, input_text=None, check=True) -> str:
    result = subprocess.run(
        args,
        check=check,
        env=env,
        text=True,
        input=input_text,
        capture_output=capture,
    )
    return result.stdout if capture else ""


def kubectl(kubeconfig: Path, *args: str, capture=False, input_text=None, check=True) -> str:
    return run(
        "kubectl",
        "--kubeconfig",
        str(kubeconfig),
        *args,
        capture=capture,
        input_text=input_text,
        check=check,
    )


def kube_exists(kubeconfig: Path, *args: str) -> bool:
    return subprocess.run(
        ("kubectl", "--kubeconfig", str(kubeconfig), *args),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def kube_json(kubeconfig: Path, *args: str) -> dict:
    return json.loads(kubectl(kubeconfig, *args, "-o", "json", capture=True))


def wait_for(description: str, fetch, predicate, timeout: int = 180):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = fetch()
            if predicate(last):
                return last
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            pass
        time.sleep(2)
    raise RuntimeError(f"timed out waiting for {description}; last={last!r}")


def assert_absent(kubeconfig: Path, description: str, *args: str) -> None:
    if kube_exists(kubeconfig, *args):
        raise RuntimeError(f"refusing to replace pre-existing E2E target: {description}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub-kubeconfig", required=True, type=Path)
    parser.add_argument("--cell-kubeconfig", required=True, type=Path)
    parser.add_argument("--internal-server", required=True)
    parser.add_argument("--tls-server-name", required=True)
    parser.add_argument("--hub-cluster", default="rivet-mesh-hub")
    parser.add_argument("--cell-id", default="actor-bj-a01")
    parser.add_argument("--registration-receipt", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    for receipt in (args.registration_receipt, args.receipt):
        if not receipt.is_absolute() or receipt.exists():
            parser.error(f"receipt must be a new absolute path: {receipt}")
        receipt.parent.mkdir(parents=True, exist_ok=True)

    secret_name = "actor-cell-" + args.cell_id
    application_name = "actor-cell-" + args.cell_id
    role_name = "actor-argocd-cell-" + args.cell_id
    repo_name = "actor-cell-e2e-repository"
    machine_set_crd = "machinesets.node.tke.cloud.tencent.com"
    installed_machine_set_crd = False
    old_inclusions = None
    management_installed = False
    repository_installed = False
    registration_started = False
    machine_set_targets_owned = False
    result = None
    permanent_project_present = kube_exists(
        args.hub_kubeconfig, "-n", "argocd", "get", "appproject", "actor-cell-bootstrap"
    )
    permanent_runtime_project_present = kube_exists(
        args.hub_kubeconfig, "-n", "argocd", "get", "appproject", "actor-cell-runtime"
    )
    permanent_appset_present = kube_exists(
        args.hub_kubeconfig, "-n", "argocd", "get", "applicationset", "actor-cells"
    )
    if len({permanent_project_present, permanent_runtime_project_present, permanent_appset_present}) != 1:
        raise RuntimeError("permanent Cell management is only partially installed")

    assert_absent(args.hub_kubeconfig, "ApplicationSet", "-n", "argocd", "get", "applicationset", E2E_APPLICATION_SET)
    assert_absent(args.hub_kubeconfig, "AppProject", "-n", "argocd", "get", "appproject", E2E_PROJECT)
    assert_absent(args.hub_kubeconfig, "cluster Secret", "-n", "argocd", "get", "secret", secret_name)
    assert_absent(args.hub_kubeconfig, "test Git Deployment", "-n", "argocd", "get", "deployment", repo_name)

    argocd_cm = kube_json(args.hub_kubeconfig, "-n", "argocd", "get", "configmap", "argocd-cm")
    old_inclusions = argocd_cm.get("data", {}).get("resource.inclusions")

    with tempfile.TemporaryDirectory(prefix="argocd-applicationset-e2e.", dir="/data/tmp") as temporary_name:
        temporary = Path(temporary_name)
        # The test deliberately replaces the Argo controller and creates a
        # repository Pod.  Seed k3s' exact sandbox image first so the proof is
        # independent of Docker Hub reachability and of containerd image GC.
        run(str(SANDBOX_IMAGE_SEEDER), args.hub_cluster)
        config = yaml.safe_load(args.cell_kubeconfig.read_text())
        current = config["current-context"]
        context = next(item for item in config["contexts"] if item["name"] == current)
        cluster_name = context["context"]["cluster"]
        cluster = next(item for item in config["clusters"] if item["name"] == cluster_name)
        cluster["cluster"]["server"] = args.internal_server
        cluster["cluster"]["tls-server-name"] = args.tls_server_name
        internal_kubeconfig = temporary / "cell.kubeconfig"
        internal_kubeconfig.write_text(yaml.safe_dump(config))
        internal_kubeconfig.chmod(0o600)

        inventory = RENDERER.validate_inventory(FIXTURE.local_inventory(args.cell_id, args.internal_server))
        cell_spec = RENDERER.validate_spec(FIXTURE.local_cell_spec(args.cell_id, inventory), inventory)
        images = FIXTURE.local_image_inventory()
        desired_root = temporary / "desired-cell"
        RENDERER.write_new_tree(
            desired_root,
            RENDERER.render(inventory, cell_spec, images),
        )
        inventory_file = temporary / "inventory.json"
        inventory_file.write_text(json.dumps(inventory, sort_keys=True))
        platform_receipt = temporary / "platform.json"
        FIXTURE.write_platform_fixture(platform_receipt, internal_kubeconfig, inventory, images)

        assert_absent(
            args.cell_kubeconfig,
            args.cell_id,
            "-n",
            "actor-fdb-cell-system",
            "get",
            "rivetcell",
            args.cell_id,
        )

        worktree = temporary / "worktree"
        destination = worktree / "cells" / args.cell_id
        destination.parent.mkdir(parents=True)
        shutil.copytree(desired_root, destination)
        run("git", "-C", str(worktree), "init", "-q", "--initial-branch=main")
        run("git", "-C", str(worktree), "add", "cells")
        git_env = dict(
            os.environ,
            GIT_AUTHOR_NAME="actor-gitops-e2e",
            GIT_AUTHOR_EMAIL="gitops-e2e@actor.invalid",
            GIT_COMMITTER_NAME="actor-gitops-e2e",
            GIT_COMMITTER_EMAIL="gitops-e2e@actor.invalid",
        )
        run("git", "-C", str(worktree), "commit", "-q", "-m", "local Cell desired state", env=git_env)
        revision = run("git", "-C", str(worktree), "rev-parse", "HEAD", capture=True).strip()
        build_context = temporary / "repository"
        run("git", "clone", "-q", "--bare", str(worktree), str(build_context / "repo.git"))
        repo_url = f"git://{repo_name}.argocd.svc.cluster.local:9418/repo.git"
        publication_receipt = temporary / "publication.json"
        publication = PUBLISHER.publish(
            inventory_file,
            desired_root / "handoff-receipt.json",
            desired_root,
            (build_context / "repo.git").as_uri(),
            "main",
            publication_receipt,
            allow_local_repository=True,
            read_url=repo_url,
        )
        if publication["gitRevision"] != revision:
            raise RuntimeError("local desired-state publication changed the Git revision")
        shutil.copy2(REPOSITORY_DOCKERFILE, build_context / "Dockerfile")
        image = "actor/argocd-cell-e2e:" + revision[:12]
        run("docker", "build", "-q", "-t", image, str(build_context))
        run("k3d", "image", "import", image, "--cluster", args.hub_cluster)

        repository_manifest = {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": {"name": repo_name, "namespace": "argocd"},
            "spec": {
                "replicas": 1,
                "selector": {"matchLabels": {"app": repo_name}},
                "template": {
                    "metadata": {"labels": {"app": repo_name}},
                    "spec": {
                        "automountServiceAccountToken": False,
                        "securityContext": {"runAsNonRoot": True, "seccompProfile": {"type": "RuntimeDefault"}},
                        "containers": [{
                            "name": "repository",
                            "image": image,
                            "imagePullPolicy": "Never",
                            "ports": [{"name": "git", "containerPort": 9418}],
                            "readinessProbe": {"tcpSocket": {"port": "git"}},
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]},
                                "readOnlyRootFilesystem": True,
                            },
                        }],
                    },
                },
            },
        }
        repository_service = {
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": {"name": repo_name, "namespace": "argocd"},
            "spec": {"selector": {"app": repo_name}, "ports": [{"name": "git", "port": 9418, "targetPort": "git"}]},
        }
        repository_file = temporary / "repository.yaml"
        repository_file.write_text(yaml.safe_dump_all([repository_manifest, repository_service]))
        try:
            kubectl(args.hub_kubeconfig, "apply", "-f", str(repository_file))
            repository_installed = True
            kubectl(
                args.hub_kubeconfig,
                "-n",
                "argocd",
                "rollout",
                "status",
                "deployment/" + repo_name,
                "--timeout=180s",
            )
        except Exception:
            kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "deployment", repo_name, "--ignore-not-found=true", check=False)
            kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "service", repo_name, "--ignore-not-found=true", check=False)
            raise

        registration_started = True
        env = dict(
            os.environ,
            HUB_KUBECONFIG=str(args.hub_kubeconfig),
            CELL_KUBECONFIG=str(internal_kubeconfig),
            CELL_INVENTORY=str(inventory_file),
            CELL_HANDOFF_RECEIPT=str(desired_root / "handoff-receipt.json"),
            CELL_PUBLICATION_RECEIPT=str(publication_receipt),
            CELL_PLATFORM_RECEIPT=str(platform_receipt),
            CELL_DESIRED_ROOT=str(desired_root),
            CELL_REGISTRATION_RECEIPT=str(args.registration_receipt),
            ACTOR_ARGOCD_REGISTRATION_SCOPE=E2E_REGISTRATION_SCOPE,
            ACTOR_CELL_PLATFORM_TEST_FIXTURE="true",
        )

        try:
            if not kube_exists(args.cell_kubeconfig, "get", "crd", machine_set_crd):
                crd_file = temporary / "local-machineset-crd.yaml"
                crd_file.write_text(
                    """apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: machinesets.node.tke.cloud.tencent.com
spec:
  group: node.tke.cloud.tencent.com
  names:
    kind: MachineSet
    listKind: MachineSetList
    plural: machinesets
    singular: machineset
  scope: Cluster
  versions:
  - name: v1beta1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        x-kubernetes-preserve-unknown-fields: true
"""
                )
                kubectl(args.cell_kubeconfig, "apply", "-f", str(crd_file))
                installed_machine_set_crd = True
            machine_set_names = (*CONVERGENCE.LOCAL_E2E_MACHINE_SETS, "np-local001")
            for machine_set in machine_set_names:
                assert_absent(args.cell_kubeconfig, machine_set, "get", "machineset", machine_set)
            terraform_stateless = temporary / "terraform-stateless-machineset.yaml"
            terraform_stateless.write_text(
                """apiVersion: node.tke.cloud.tencent.com/v1beta1
kind: MachineSet
metadata:
  name: np-local001
spec:
  template:
    spec:
      metadata:
        labels:
          fleet.actor.dev/cell: %s
""" % args.cell_id
            )
            kubectl(args.cell_kubeconfig, "apply", "-f", str(terraform_stateless))
            machine_set_targets_owned = True
            run(str(ROOT / "register-cell.sh"), env=env)
            management_file = temporary / "management.yaml"
            run(
                str(ROOT / "render-management.py"),
                "--repo-url",
                repo_url,
                "--platform-receipt-digest",
                "sha256:" + hashlib.sha256(platform_receipt.read_bytes()).hexdigest(),
                "--management-git-receipt-digest",
                "sha256:" + "2" * 64,
                "--cluster-uid",
                json.loads(platform_receipt.read_text())["cluster"]["uid"],
                "--output",
                str(management_file),
            )
            management_documents = list(yaml.safe_load_all(management_file.read_text()))
            bootstrap_project = next(
                item for item in management_documents
                if item.get("kind") == "AppProject"
                and item.get("metadata", {}).get("name") == "actor-cell-bootstrap"
            )
            application_set = next(item for item in management_documents if item.get("kind") == "ApplicationSet")
            management_documents = [bootstrap_project, application_set]
            bootstrap_project["metadata"]["name"] = E2E_PROJECT
            application_set["metadata"]["name"] = E2E_APPLICATION_SET
            application_set["spec"]["template"]["spec"]["project"] = E2E_PROJECT
            application_set["spec"]["generators"][0]["clusters"]["selector"]["matchLabels"][
                "fleet.actor.dev/registration-scope"
            ] = E2E_REGISTRATION_SCOPE
            management_file.write_text(
                yaml.safe_dump_all(management_documents, explicit_start=True, sort_keys=True)
            )
            existing_inclusions = yaml.safe_load(old_inclusions) if old_inclusions else []
            required_config = yaml.safe_load((ROOT / "resource-inclusions.yaml").read_text())
            required_inclusions = yaml.safe_load(required_config["data"]["resource.inclusions"])
            merged_config = {
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": {"name": "argocd-cm", "namespace": "argocd"},
                "data": {
                    "resource.inclusions": yaml.safe_dump(
                        existing_inclusions + required_inclusions,
                        sort_keys=False,
                    )
                },
            }
            merged_inclusions_file = temporary / "resource-inclusions.yaml"
            merged_inclusions_file.write_text(yaml.safe_dump(merged_config, sort_keys=False))
            kubectl(
                args.hub_kubeconfig,
                "apply",
                "--server-side",
                "--force-conflicts",
                "--field-manager=actor-cell-e2e",
                "-f",
                str(merged_inclusions_file),
            )
            # Set before apply because kubectl may create the first document and
            # then reject a later one. Cleanup must own partial application too.
            management_installed = True
            kubectl(args.hub_kubeconfig, "apply", "-f", str(management_file))
            # The cluster Secret already exists in this E2E, unlike the normal
            # production order. Nudge the isolated ApplicationSet after the
            # project create event has reached the controller cache.
            time.sleep(1)
            kubectl(
                args.hub_kubeconfig,
                "-n",
                "argocd",
                "annotate",
                "applicationset",
                E2E_APPLICATION_SET,
                "fleet.actor.dev/e2e-refresh=" + str(time.time_ns()),
                "--overwrite",
            )

            application = wait_for(
                "ApplicationSet-generated Application",
                lambda: kube_json(args.hub_kubeconfig, "-n", "argocd", "get", "application", application_name),
                lambda item: item.get("status", {}).get("sync", {}).get("status") == "Synced"
                and item.get("status", {}).get("health", {}).get("status") == "Healthy",
                timeout=300,
            )
            cell = kube_json(
                args.cell_kubeconfig,
                "-n",
                "actor-fdb-cell-system",
                "get",
                "rivetcell",
                args.cell_id,
            )
            runtime_machine = kube_json(args.cell_kubeconfig, "get", "machineset", "np-runtime0")

            kubectl(
                args.cell_kubeconfig,
                "-n",
                "actor-fdb-cell-system",
                "patch",
                "rivetcell",
                args.cell_id,
                "--type=merge",
                "-p",
                json.dumps({"metadata": {"labels": {"fleet.actor.dev/pool": "drifted"}}}),
            )
            kubectl(
                args.hub_kubeconfig,
                "-n",
                "argocd",
                "annotate",
                "application",
                application_name,
                "argocd.argoproj.io/refresh=hard",
                "--overwrite",
            )
            wait_for(
                "RivetCell label self-heal",
                lambda: kube_json(
                    args.cell_kubeconfig,
                    "-n",
                    "actor-fdb-cell-system",
                    "get",
                    "rivetcell",
                    args.cell_id,
                ),
                lambda item: item.get("metadata", {}).get("labels", {}).get("fleet.actor.dev/pool") == "local-runtime",
            )

            kubectl(
                args.cell_kubeconfig,
                "patch",
                "machineset",
                "np-runtime0",
                "--type=merge",
                "-p",
                json.dumps({"spec": {"replicas": 4}}),
            )
            kubectl(
                args.hub_kubeconfig,
                "-n",
                "argocd",
                "annotate",
                "application",
                application_name,
                "argocd.argoproj.io/refresh=hard",
                "--overwrite",
            )
            time.sleep(8)
            replica_after_refresh = kube_json(args.cell_kubeconfig, "get", "machineset", "np-runtime0")["spec"]["replicas"]
            if replica_after_refresh != 4:
                raise RuntimeError("Argo overwrote the capacity-controller-owned MachineSet replicas")

            controller = kube_json(
                args.hub_kubeconfig,
                "-n",
                "argocd",
                "get",
                "pod",
                "-l",
                "app.kubernetes.io/name=argocd-application-controller",
            )["items"][0]
            controller_name = controller["metadata"]["name"]
            controller_uid_before = controller["metadata"]["uid"]
            kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "pod", controller_name, "--wait=true")
            controller_after = wait_for(
                "replacement Argo application controller",
                lambda: kube_json(
                    args.hub_kubeconfig,
                    "-n",
                    "argocd",
                    "get",
                    "pod",
                    controller_name,
                ),
                lambda item: item["metadata"]["uid"] != controller_uid_before
                and any(condition.get("type") == "Ready" and condition.get("status") == "True"
                        for condition in item.get("status", {}).get("conditions", [])),
            )

            kubectl(
                args.cell_kubeconfig,
                "patch",
                "machineset",
                "np-control0",
                "--type=merge",
                "-p",
                json.dumps({"spec": {"displayName": "drifted"}}),
            )
            kubectl(
                args.hub_kubeconfig,
                "-n",
                "argocd",
                "annotate",
                "application",
                application_name,
                "argocd.argoproj.io/refresh=hard",
                "--overwrite",
            )
            wait_for(
                "MachineSet self-heal after controller replacement",
                lambda: kube_json(args.cell_kubeconfig, "get", "machineset", "np-control0"),
                lambda item: item.get("spec", {}).get("displayName") == args.cell_id + "-control-native",
            )
            final_application = kube_json(
                args.hub_kubeconfig,
                "-n",
                "argocd",
                "get",
                "application",
                application_name,
            )
            final_application_set = kube_json(
                args.hub_kubeconfig,
                "-n",
                "argocd",
                "get",
                "applicationset",
                E2E_APPLICATION_SET,
            )
            final_secret = kube_json(
                args.hub_kubeconfig, "-n", "argocd", "get", "secret", secret_name
            )
            final_cell = kube_json(
                args.cell_kubeconfig, "-n", "actor-fdb-cell-system", "get", "rivetcell", args.cell_id
            )
            final_machine_sets = [
                kube_json(args.cell_kubeconfig, "get", "machineset", name)
                for name in machine_set_names
            ]
            production_convergence = CONVERGENCE.verify(
                json.loads(args.registration_receipt.read_text()),
                CONVERGENCE.file_digest(args.registration_receipt),
                HANDOFF.verify(inventory_file, desired_root / "handoff-receipt.json", desired_root),
                final_secret,
                final_application,
                final_cell,
                final_machine_sets,
                final_application_set,
                expected_project=E2E_PROJECT,
                expected_application_set=E2E_APPLICATION_SET,
                expected_registration_scope=E2E_REGISTRATION_SCOPE,
            )
            result = {
                "schemaVersion": 1,
                "result": "passed",
                "cellId": args.cell_id,
                "gitRevision": revision,
                "application": {
                    "name": application_name,
                    "uid": application["metadata"]["uid"],
                    "syncRevision": final_application["status"]["sync"]["revision"],
                    "sync": final_application["status"]["sync"]["status"],
                    "health": final_application["status"]["health"]["status"],
                },
                "resources": {
                    "rivetCellUid": cell["metadata"]["uid"],
                    "runtimeMachineSetUid": runtime_machine["metadata"]["uid"],
                },
                "proofs": {
                    "rivetCellDriftSelfHealed": True,
                    "machineSetDriftSelfHealedAfterControllerReplacement": True,
                    "machineSetReplicasRemainControllerOwned": replica_after_refresh == 4,
                    "applicationControllerUidBefore": controller_uid_before,
                    "applicationControllerUidAfter": controller_after["metadata"]["uid"],
                },
                "productionConvergence": production_convergence,
            }
        finally:
            if management_installed:
                kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "applicationset", E2E_APPLICATION_SET, "--ignore-not-found=true", "--wait=false")
                kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "application", application_name, "--ignore-not-found=true", "--wait=false")
                kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "appproject", E2E_PROJECT, "--ignore-not-found=true")
            if machine_set_targets_owned:
                for machine_set in machine_set_names:
                    kubectl(args.cell_kubeconfig, "delete", "machineset", machine_set, "--ignore-not-found=true", check=False)
            kubectl(
                args.cell_kubeconfig,
                "-n",
                "actor-fdb-cell-system",
                "delete",
                "rivetcell",
                args.cell_id,
                "--ignore-not-found=true",
                check=False,
            )
            if registration_started:
                kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "secret", secret_name, "--ignore-not-found=true", check=False)
                kubectl(args.cell_kubeconfig, "delete", "clusterrolebinding", role_name, "--ignore-not-found=true", check=False)
                kubectl(args.cell_kubeconfig, "delete", "clusterrole", role_name, "--ignore-not-found=true", check=False)
                for kind in ("rolebinding", "role", "secret", "serviceaccount"):
                    name = "actor-argocd-cell-token" if kind == "secret" else "actor-argocd-cell"
                    kubectl(
                        args.cell_kubeconfig,
                        "-n",
                        "actor-fdb-cell-system",
                        "delete",
                        kind,
                        name,
                        "--ignore-not-found=true",
                        check=False,
                    )
                for kind in ("rolebinding", "role"):
                    kubectl(
                        args.cell_kubeconfig,
                        "-n",
                        "actor-stateless-system",
                        "delete",
                        kind,
                        "actor-argocd-stateless-runtime",
                        "--ignore-not-found=true",
                        check=False,
                    )
            if repository_installed:
                kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "deployment", repo_name, "--ignore-not-found=true", check=False)
                kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "service", repo_name, "--ignore-not-found=true", check=False)
            if old_inclusions is None:
                kubectl(
                    args.hub_kubeconfig,
                    "-n",
                    "argocd",
                    "patch",
                    "configmap",
                    "argocd-cm",
                    "--type=json",
                    "-p",
                    '[{"op":"remove","path":"/data/resource.inclusions"}]',
                    check=False,
                )
            else:
                kubectl(
                    args.hub_kubeconfig,
                    "-n",
                    "argocd",
                    "patch",
                    "configmap",
                    "argocd-cm",
                    "--type=merge",
                    "-p",
                    json.dumps({"data": {"resource.inclusions": old_inclusions}}),
                    check=False,
                )
            if installed_machine_set_crd:
                kubectl(args.cell_kubeconfig, "delete", "crd", machine_set_crd, "--ignore-not-found=true", check=False)

    if result is None:
        raise RuntimeError("ApplicationSet E2E completed without a result")
    if permanent_appset_present:
        if not kube_exists(args.hub_kubeconfig, "-n", "argocd", "get", "applicationset", "actor-cells"):
            raise RuntimeError("E2E removed the permanent Cell ApplicationSet")
        if not kube_exists(args.hub_kubeconfig, "-n", "argocd", "get", "appproject", "actor-cell-bootstrap"):
            raise RuntimeError("E2E removed the permanent Cell AppProject")
        if not kube_exists(args.hub_kubeconfig, "-n", "argocd", "get", "appproject", "actor-cell-runtime"):
            raise RuntimeError("E2E removed the permanent Cell runtime AppProject")
    result["proofs"]["permanentManagementPreserved"] = permanent_appset_present
    result["cleanup"] = {"testResourcesRemoved": True, "argocdResourceInclusionsRestored": True}
    args.receipt.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"applicationSetE2E": "passed", "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
