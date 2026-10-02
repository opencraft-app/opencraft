#!/usr/bin/env python3
import json
import sys
from pathlib import Path

import yaml


FDB_TOOLS_IMAGE = (
    "foundationdb/foundationdb@sha256:"
    "d3530c3066f94abffb61facac527c9c3517f6553ee0e75efa69d54296290156a"
)
BACKUP_MOUNT = "/var/lib/actor-runtime/fdbbackup"


def backup_agent_container():
    return {
        "name": "fdb-backup-agent",
        "image": FDB_TOOLS_IMAGE,
        "imagePullPolicy": "IfNotPresent",
        "command": ["/usr/bin/backup_agent"],
        "args": [
            "-C",
            "/etc/actor/runtime/fdb.cluster",
            "-m",
            "256MiB",
            "--logdir",
            "/var/log/foundationdb",
        ],
        "resources": {
            "requests": {"cpu": "25m", "memory": "64Mi"},
            "limits": {"cpu": "1", "memory": "512Mi"},
        },
        "securityContext": {
            "allowPrivilegeEscalation": False,
            "capabilities": {"drop": ["ALL"]},
            "readOnlyRootFilesystem": True,
        },
        "volumeMounts": [
            {
                "name": "fdb-config",
                "mountPath": "/etc/actor/runtime/fdb.cluster",
                "subPath": "cluster-file",
                "readOnly": True,
            },
            {"name": "fdbbackup", "mountPath": BACKUP_MOUNT},
            {"name": "fdbbackup-logs", "mountPath": "/var/log/foundationdb"},
            {"name": "fdbbackup-tmp", "mountPath": "/tmp"},
        ],
    }


def configure_engine(documents, cell, pvc_name, backup_base_url):
    observed = sorted((item["kind"], item["metadata"]["name"]) for item in documents)
    expected = sorted(
        [
            ("ServiceAccount", f"{cell}-runtime"),
            ("ConfigMap", f"{cell}-runtime-config"),
            ("Service", f"{cell}-engine"),
            ("Deployment", f"{cell}-engine"),
        ]
    )
    if observed != expected:
        raise ValueError(f"backup qualification received {observed}, expected {expected}")

    for document in documents:
        if document["kind"] == "ConfigMap":
            config = json.loads(document["data"]["config.jsonc"])
            config["sqlite"]["backup_recovery_fence_controller"] = {
                "backup_base_urls": [backup_base_url],
                "retention_days": 1,
                "fdbbackup_binary": "/opt/actor/bin/fdbbackup",
                "required_fdbbackup_version": "7.3.79",
                "poll_interval_ms": 10_000,
                "lease_validity_ms": 90_000,
                "command_timeout_ms": 30_000,
                "leadership_lease_ms": 30_000,
                "max_backup_generations": 1,
            }
            document["data"]["config.jsonc"] = json.dumps(config, indent=2) + "\n"
        elif document["kind"] == "Deployment":
            pod = document["spec"]["template"]["spec"]
            engine = next(item for item in pod["containers"] if item["name"] == "engine")
            engine["volumeMounts"].append(
                {"name": "fdbbackup", "mountPath": BACKUP_MOUNT}
            )
            pod["containers"].append(backup_agent_container())
            pod["volumes"].extend(
                [
                    {
                        "name": "fdbbackup",
                        "persistentVolumeClaim": {"claimName": pvc_name},
                    },
                    {"name": "fdbbackup-logs", "emptyDir": {}},
                    {"name": "fdbbackup-tmp", "emptyDir": {}},
                ]
            )

    documents.append(
        {
            "apiVersion": "v1",
            "kind": "PersistentVolumeClaim",
            "metadata": {
                "name": pvc_name,
                "namespace": "actor-fdb-cell-system",
                "labels": {"local.rivet.dev/qualification": "backup-restore-physical"},
            },
            "spec": {
                "accessModes": ["ReadWriteOnce"],
                "storageClassName": "local-path",
                "resources": {"requests": {"storage": "1Gi"}},
            },
        }
    )
    return documents


def restore_tools(cell, fdb_cluster, pvc_name):
    return [
        {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": f"{cell}-restore-tools",
                "namespace": "actor-fdb-cell-system",
                "labels": {"local.rivet.dev/qualification": "backup-restore-physical"},
            },
            "spec": {
                "restartPolicy": "Never",
                "automountServiceAccountToken": False,
                "nodeSelector": {"rivet.dev/control": "true"},
                "securityContext": {
                    "runAsNonRoot": True,
                    "runAsUser": 4059,
                    "runAsGroup": 4059,
                    "fsGroup": 4059,
                    "seccompProfile": {"type": "RuntimeDefault"},
                },
                "containers": [backup_agent_container()],
                "volumes": [
                    {
                        "name": "fdb-config",
                        "configMap": {"name": f"{fdb_cluster}-config"},
                    },
                    {
                        "name": "fdbbackup",
                        "persistentVolumeClaim": {"claimName": pvc_name},
                    },
                    {"name": "fdbbackup-logs", "emptyDir": {}},
                    {"name": "fdbbackup-tmp", "emptyDir": {}},
                ],
            },
        }
    ]


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: render.py engine|restore-tools ...")
    mode = sys.argv[1]
    if mode == "engine" and len(sys.argv) == 7:
        source, cell, pvc_name, backup_base_url, output = sys.argv[2:]
        documents = [item for item in yaml.safe_load_all(Path(source).read_text()) if item]
        documents = configure_engine(documents, cell, pvc_name, backup_base_url)
    elif mode == "restore-tools" and len(sys.argv) == 6:
        cell, fdb_cluster, pvc_name, output = sys.argv[2:]
        documents = restore_tools(cell, fdb_cluster, pvc_name)
    else:
        raise SystemExit(
            "usage: render.py engine INPUT CELL PVC BACKUP_BASE_URL OUTPUT | "
            "restore-tools CELL FDB_CLUSTER PVC OUTPUT"
        )
    Path(output).write_text(yaml.safe_dump_all(documents, sort_keys=False))


if __name__ == "__main__":
    main()
