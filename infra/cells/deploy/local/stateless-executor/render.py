#!/usr/bin/env python3
"""Render the production stateless executor into the deterministic k3d topology."""

import argparse
import re
from pathlib import Path

import yaml


def replace_tree(value, replacements):
    if isinstance(value, str):
        for old, new in replacements.items():
            value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [replace_tree(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: replace_tree(item, replacements) for key, item in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cell", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--runtime-digest", required=True)
    parser.add_argument("--registry-url", required=True)
    parser.add_argument("--object-router-address", required=True)
    parser.add_argument("--node-port", type=int, default=30484)
    args = parser.parse_args()

    replacements = {
        "__CELL_NAME__": args.cell,
        "__RUNTIME_IMAGE__": args.image,
        "__RUNTIME_DIGEST__": args.runtime_digest,
        "__STATELESS_MACHINE_SET__": "local-compute",
        "__WORKER_REGISTRY_URL__": args.registry_url,
        "__OBJECT_ROUTER_ADDRESS__": args.object_router_address,
    }
    documents = []
    for raw in yaml.safe_load_all(args.manifest.read_text()):
        if not raw or raw["kind"] == "HorizontalPodAutoscaler":
            continue
        document = replace_tree(raw, replacements)
        kind = document["kind"]
        if kind == "ServiceAccount":
            document.pop("imagePullSecrets", None)
        elif kind == "Service":
            document["spec"]["type"] = "NodePort"
            document["spec"]["ports"][0]["nodePort"] = args.node_port
        elif kind == "PodDisruptionBudget":
            document["spec"]["minAvailable"] = 1
        elif kind == "Deployment":
            document["spec"]["replicas"] = 1
            pod = document["spec"]["template"]["spec"]
            pod.pop("imagePullSecrets", None)
            pod.pop("topologySpreadConstraints", None)
            terms = pod["affinity"]["nodeAffinity"][
                "requiredDuringSchedulingIgnoredDuringExecution"
            ]["nodeSelectorTerms"]
            for term in terms:
                term["matchExpressions"] = [
                    expression for expression in term["matchExpressions"]
                    if expression["key"] != "node.tke.cloud.tencent.com/machineset"
                ]
            for container in pod["containers"]:
                if container["name"] == "workerd":
                    container["resources"]["requests"] = {
                        "cpu": "250m", "memory": "256Mi",
                    }
                elif container["name"] == "executor":
                    container["resources"]["requests"] = {
                        "cpu": "50m", "memory": "64Mi",
                    }
        documents.append(document)

    documents.append({
        "apiVersion": "monitoring.coreos.com/v1",
        "kind": "ServiceMonitor",
        "metadata": {
            "name": f"{args.cell}-stateless-executor",
            "namespace": "observability",
            "labels": {
                "release": "actor-observability",
                "app.kubernetes.io/part-of": "actor-fleet",
            },
        },
        "spec": {
            "namespaceSelector": {"matchNames": ["actor-stateless-system"]},
            "selector": {"matchLabels": {
                "fleet.actor.dev/cell-name": args.cell,
                "fleet.actor.dev/component": "stateless-executor",
            }},
            "sampleLimit": 1000,
            "targetLimit": 100,
            "labelLimit": 30,
            "bodySizeLimit": "256KB",
            "endpoints": [{
                "port": "http",
                "path": "/metrics",
                "scheme": "http",
                "interval": "15s",
                "scrapeTimeout": "5s",
                "honorLabels": False,
                "filterRunning": True,
                "relabelings": [
                    {
                        "sourceLabels": ["__meta_kubernetes_pod_label_fleet_actor_dev_cell_name"],
                        "targetLabel": "cell",
                    },
                    {
                        "sourceLabels": ["__meta_kubernetes_pod_name"],
                        "targetLabel": "pod",
                    },
                    {
                        "sourceLabels": ["__meta_kubernetes_pod_node_name"],
                        "targetLabel": "node",
                    },
                ],
            }],
        },
    })

    encoded = yaml.safe_dump_all(documents, sort_keys=False)
    if re.search(r"__[A-Z0-9_]+__", encoded):
        raise SystemExit("unresolved stateless executor token")
    args.output.write_text(encoded)


if __name__ == "__main__":
    main()
