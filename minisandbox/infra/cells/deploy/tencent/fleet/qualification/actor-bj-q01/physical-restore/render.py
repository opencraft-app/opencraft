#!/usr/bin/env python3
"""Render one q01 isolated physical-restore target from reviewed fleet bases."""

import argparse
import json
import pathlib
import re
import shlex


DIGEST_IMAGE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
SAFE_NAME = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
ACTOR_ID = re.compile(r"^[a-z0-9]+$")
KUBERNETES_QUANTITY = re.compile(r"^[0-9]+(?:m|Ki|Mi|Gi|Ti)?$")


def source_storage_resources(spec):
    general = spec.get("processes", {}).get("general", {})
    pod_spec = general.get("podTemplate", {}).get("spec", {})
    containers = pod_spec.get("containers", [])
    foundationdb = next(
        (container for container in containers if container.get("name") == "foundationdb"),
        None,
    )
    if foundationdb is None:
        raise ValueError("live FoundationDB storage resources are unavailable")
    resources = foundationdb.get("resources", {})
    requests = resources.get("requests", {})
    limits = resources.get("limits", {})
    storage = (
        general.get("volumeClaimTemplate", {})
        .get("spec", {})
        .get("resources", {})
        .get("requests", {})
        .get("storage")
    )
    values = {
        "request_cpu": requests.get("cpu"),
        "request_memory": requests.get("memory"),
        "limit_cpu": limits.get("cpu"),
        "limit_memory": limits.get("memory"),
        "storage": storage,
    }
    for name, value in values.items():
        if not isinstance(value, str) or KUBERNETES_QUANTITY.fullmatch(value) is None:
            raise ValueError(f"live FoundationDB {name} is missing or unsafe")
    return values


def render_bases(fleet_root, cell, target, source_cluster):
    dr_root = fleet_root / "dr"
    old_target = "actor-bj-k01-dr-20260818"
    old_cell = "actor-bj-k01"
    old_base = "foundationdb/fdb-kubernetes-monitor"
    old_tag = "7.3.79@sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c"

    spec = source_cluster["spec"]
    image_config = spec["mainContainer"]["imageConfigs"][0]
    version = spec["version"]
    base_image = image_config["baseImage"]
    tag = image_config["tag"]
    full_image = f"{base_image}:{tag}"
    if "@sha256:" not in full_image:
        raise ValueError("live FoundationDB monitor image is not digest pinned")
    storage_resources = source_storage_resources(spec)

    rendered = {}
    for name in ("isolated-fdb-cluster.yaml", "restore-agents.yaml"):
        content = (dr_root / name).read_text()
        content = content.replace(old_target, target)
        content = content.replace(old_cell, cell)
        content = content.replace("version: 7.3.79", f"version: {version}")
        content = content.replace(f"baseImage: {old_base}", f"baseImage: {base_image}")
        content = content.replace(f"tag: {old_tag}", f"tag: {tag}")
        content = content.replace(f"{old_base}:{old_tag}", full_image)
        if name == "isolated-fdb-cluster.yaml":
            old_resources = """                requests:
                  cpu: 500m
                  memory: 2Gi
                limits:
                  cpu: "1"
                  memory: 4Gi"""
            new_resources = """                requests:
                  cpu: {request_cpu}
                  memory: {request_memory}
                limits:
                  cpu: {limit_cpu}
                  memory: {limit_memory}""".format(**storage_resources)
            if content.count(old_resources) != 1 or content.count("storage: 40Gi") != 1:
                raise ValueError("isolated FDB resource template changed unexpectedly")
            content = content.replace(old_resources, new_resources)
            content = content.replace("storage: 40Gi", f"storage: {storage_resources['storage']}")
        if old_target in content or old_cell in content:
            raise ValueError(f"{name} retained an old DR identity")
        if name == "isolated-fdb-cluster.yaml":
            if f"baseImage: {base_image}" not in content or f"tag: {tag}" not in content:
                raise ValueError("isolated FDB target did not inherit the exact live monitor image")
        elif f"image: {full_image}" not in content:
            raise ValueError("restore agent did not inherit the exact live monitor image")
        rendered[name] = content
    return rendered


def verifier_script(records):
    lines = [
        "engine=/opt/actor/bin/rivet-engine",
        "config=/etc/actor/runtime/config.jsonc",
        "checked=0",
        "assert_rows() {",
        "  actor=$1",
        "  query=$2",
        "  expected=$3",
        "  output=$($engine --config \"$config\" depot execute --actor-id \"$actor\" --query \"$query\")",
        "  compact=$(printf '%s' \"$output\" | tr -d '[:space:]')",
        "  case \"$compact\" in *\"\\\"rows\\\":[[$expected]]\"*) ;; *) printf '%s\\n' \"$output\" >&2; exit 1 ;; esac",
        "}",
    ]
    for record in records:
        actor = record["actor_id"]
        expected_count = int(record["expected_count"])
        expected_bytes = int(record.get("expected_bottomless_bytes", 0))
        if not ACTOR_ID.fullmatch(actor):
            raise ValueError(f"unsafe Actor ID in seed receipt: {actor!r}")
        checks = (
            ("PRAGMA integrity_check", '"ok"'),
            (
                "SELECT CASE WHEN COALESCE((SELECT value FROM counters WHERE name = 'main'), -1) = {} THEN 1 ELSE 0 END".format(expected_count),
                "1",
            ),
            (
                "SELECT CASE WHEN COALESCE(SUM(length(payload)), 0) = {} THEN 1 ELSE 0 END FROM bottomless_qualification_payloads".format(expected_bytes),
                "1",
            ),
        )
        for query, expected in checks:
            lines.append(
                "assert_rows {} {} {}".format(
                    shlex.quote(actor), shlex.quote(query), shlex.quote(expected)
                )
            )
        lines.append("checked=$((checked + 1))")
    lines.append('printf \'restored_actor_verification=passed actors=%s\\n\' "$checked"')
    return "\n".join(lines) + "\n"


def verifier_job(cell, target, runtime_image, records):
    if not DIGEST_IMAGE.fullmatch(runtime_image):
        raise ValueError("runtime image must be digest pinned")
    job_name = target + "-verify"
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": "actor-fdb-cell-system",
            "labels": {
                "fleet.actor.dev/cell-name": cell,
                "fleet.actor.dev/purpose": "disaster-recovery-qualification",
                "fleet.actor.dev/dr-target": target,
            },
        },
        "spec": {
            "backoffLimit": 0,
            "ttlSecondsAfterFinished": 86400,
            "template": {
                "metadata": {"labels": {"fleet.actor.dev/dr-target": target}},
                "spec": {
                    "restartPolicy": "Never",
                    "serviceAccountName": cell + "-runtime",
                    "automountServiceAccountToken": False,
                    "imagePullSecrets": [{"name": "actor-fleet-tcr"}],
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 4059,
                        "runAsGroup": 4059,
                        "fsGroup": 4059,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "affinity": {
                        "nodeAffinity": {
                            "requiredDuringSchedulingIgnoredDuringExecution": {
                                "nodeSelectorTerms": [
                                    {
                                        "matchExpressions": [
                                            {
                                                "key": "fleet.actor.dev/fdb-dedicated",
                                                "operator": "DoesNotExist",
                                            }
                                        ]
                                    }
                                ]
                            }
                        }
                    },
                    "containers": [
                        {
                            "name": "verifier",
                            "image": runtime_image,
                            "command": ["/bin/bash", "-euo", "pipefail", "-c"],
                            "args": [verifier_script(records)],
                            "env": [
                                {
                                    "name": "AWS_ACCESS_KEY_ID",
                                    "valueFrom": {
                                        "secretKeyRef": {
                                            "name": cell + "-runtime-cos",
                                            "key": "AWS_ACCESS_KEY_ID",
                                        }
                                    },
                                },
                                {
                                    "name": "AWS_SECRET_ACCESS_KEY",
                                    "valueFrom": {
                                        "secretKeyRef": {
                                            "name": cell + "-runtime-cos",
                                            "key": "AWS_SECRET_ACCESS_KEY",
                                        }
                                    },
                                },
                                {"name": "AWS_EC2_METADATA_DISABLED", "value": "true"},
                                {"name": "FDB_TLS_CERTIFICATE_FILE", "value": "/var/fdb-tls/cert.pem"},
                                {"name": "FDB_TLS_CA_FILE", "value": "/var/fdb-tls/ca.pem"},
                                {"name": "FDB_TLS_KEY_FILE", "value": "/var/fdb-tls/key.pem"},
                            ],
                            "resources": {
                                "requests": {"cpu": "500m", "memory": "512Mi"},
                                "limits": {"cpu": "2", "memory": "2Gi"},
                            },
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "readOnlyRootFilesystem": True,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "volumeMounts": [
                                {
                                    "name": "runtime-config",
                                    "mountPath": "/etc/actor/runtime/config.jsonc",
                                    "subPath": "config.jsonc",
                                    "readOnly": True,
                                },
                                {
                                    "name": "fdb-config",
                                    "mountPath": "/etc/actor/runtime/fdb.cluster",
                                    "subPath": "cluster-file",
                                    "readOnly": True,
                                },
                                {"name": "fdb-tls", "mountPath": "/var/fdb-tls", "readOnly": True},
                                {"name": "state", "mountPath": "/var/lib/actor-runtime"},
                                {"name": "tmp", "mountPath": "/tmp"},
                            ],
                        }
                    ],
                    "volumes": [
                        {"name": "runtime-config", "configMap": {"name": cell + "-runtime-config"}},
                        {"name": "fdb-config", "configMap": {"name": target + "-config"}},
                        {
                            "name": "fdb-tls",
                            "secret": {"secretName": cell + "-backup-tls", "defaultMode": 288},
                        },
                        {"name": "state", "emptyDir": {}},
                        {"name": "tmp", "emptyDir": {}},
                    ],
                },
            },
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fleet-root", type=pathlib.Path, required=True)
    parser.add_argument("--cell", default="actor-bj-q01")
    parser.add_argument("--target", required=True)
    parser.add_argument("--source-cluster", type=pathlib.Path, required=True)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--seed", type=pathlib.Path, required=True)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if not SAFE_NAME.fullmatch(args.cell) or not SAFE_NAME.fullmatch(args.target):
        raise SystemExit("Cell and target must be DNS-safe names")

    source_cluster = json.loads(args.source_cluster.read_text())
    seed = json.loads(args.seed.read_text())
    records = seed.get("actor_records") or []
    if seed.get("verdict") != "passed" or len(records) != 12:
        raise SystemExit("DR seed must be a passed 12-Actor qualification")
    if seed.get("actors_retained") is not True or seed.get("dr_seed", {}).get("actors_retained_asleep") is not True:
        raise SystemExit("DR seed Actors are not retained asleep")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, content in render_bases(args.fleet_root, args.cell, args.target, source_cluster).items():
        (args.output_dir / name).write_text(content)
    job = verifier_job(args.cell, args.target, args.runtime_image, records)
    (args.output_dir / "verify-job.json").write_text(json.dumps(job, indent=2, sort_keys=True) + "\n")
    metadata = {
        "cell": args.cell,
        "target": args.target,
        "verifier_job": job["metadata"]["name"],
        "runtime_image": args.runtime_image,
        "actor_manifest_sha256": seed.get("actor_manifest_sha256"),
        "actors": len(records),
    }
    (args.output_dir / "render.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
