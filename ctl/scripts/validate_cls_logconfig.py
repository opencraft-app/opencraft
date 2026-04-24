#!/usr/bin/env python3
"""
Definition:
  Validate that ctl runtime deployments declared in ctl/k8s/base/manifests.yaml are
  fully covered by ctl/k8s/base/cls-logconfig.yaml, so deployment changes do not
  silently miss CLS collection updates.

Parameters:
  --manifests <path>   Optional. K8s workload manifest path.
                       Default: ctl/k8s/base/manifests.yaml
  --logconfig <path>   Optional. CLS LogConfig path.
                       Default: ctl/k8s/base/cls-logconfig.yaml

Outputs:
  - Prints a concise validation summary to stdout/stderr.
  - Exit code 0: validation passed.
  - Exit code 1: validation failed due to config mismatch or invalid content.
  - Exit code 2: invalid script arguments or file read failure.

Examples:
  python3 ctl/scripts/validate_cls_logconfig.py
  python3 ctl/scripts/validate_cls_logconfig.py \
    --manifests ctl/k8s/base/manifests.yaml \
    --logconfig ctl/k8s/base/cls-logconfig.yaml
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate that ctl deployment containers are fully covered by the "
            "CLS LogConfig workloads."
        ),
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            "Outputs:\n"
            "  exit 0  validation passed\n"
            "  exit 1  validation failed\n"
            "  exit 2  invalid arguments or unreadable files\n\n"
            "Examples:\n"
            "  python3 ctl/scripts/validate_cls_logconfig.py\n"
            "  python3 ctl/scripts/validate_cls_logconfig.py "
            "--manifests ctl/k8s/base/manifests.yaml "
            "--logconfig ctl/k8s/base/cls-logconfig.yaml"
        ),
    )
    parser.add_argument(
        "--manifests",
        default="ctl/k8s/base/manifests.yaml",
        help="Path to the ctl workload manifest file.",
    )
    parser.add_argument(
        "--logconfig",
        default="ctl/k8s/base/cls-logconfig.yaml",
        help="Path to the ctl CLS LogConfig file.",
    )
    return parser


def load_yaml_documents(path: Path) -> list[dict]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            docs = [doc for doc in yaml.safe_load_all(handle) if doc]
    except FileNotFoundError:
        raise ValueError(f"file not found: {path}")
    except OSError as exc:
        raise ValueError(f"cannot read {path}: {exc}")
    except yaml.YAMLError as exc:
        raise ValueError(f"invalid yaml in {path}: {exc}")

    if not docs:
        raise ValueError(f"yaml file has no documents: {path}")
    return docs


def deployment_workloads(docs: list[dict]) -> set[tuple[str, str, str, str]]:
    workloads: set[tuple[str, str, str, str]] = set()
    for doc in docs:
        if doc.get("kind") != "Deployment":
            continue
        metadata = doc.get("metadata") or {}
        namespace = metadata.get("namespace")
        name = metadata.get("name")
        if namespace != "ctl" or not name:
            continue

        containers = (
            doc.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
        if not containers:
            raise ValueError(f"deployment has no containers: {namespace}/{name}")
        for container in containers:
            container_name = container.get("name")
            if not container_name:
                raise ValueError(
                    f"deployment container missing name: {namespace}/{name}"
                )
            workloads.add((namespace, name, "deployment", container_name))
    if not workloads:
        raise ValueError("no ctl deployments found in manifests")
    return workloads


def logconfig_workloads(docs: list[dict]) -> tuple[str, set[tuple[str, str, str, str]]]:
    logconfig_docs = [doc for doc in docs if doc.get("kind") == "LogConfig"]
    if len(logconfig_docs) != 1:
        raise ValueError(
            f"expected exactly 1 LogConfig document, found {len(logconfig_docs)}"
        )

    logconfig = logconfig_docs[0]
    logconfig_name = (logconfig.get("metadata") or {}).get("name", "<unknown>")
    topic_id = (
        logconfig.get("spec", {})
        .get("clsDetail", {})
        .get("topicId", "")
        .strip()
    )
    if not topic_id or "REPLACE_ME" in topic_id:
        raise ValueError("cls topicId is empty or still contains a placeholder")

    workloads = (
        logconfig.get("spec", {})
        .get("inputDetail", {})
        .get("containerStdout", {})
        .get("workloads", [])
    )
    if not workloads:
        raise ValueError("LogConfig has no containerStdout workloads")

    parsed: set[tuple[str, str, str, str]] = set()
    for workload in workloads:
        namespace = workload.get("namespace")
        name = workload.get("name")
        kind = workload.get("kind")
        container = workload.get("container")
        if not all([namespace, name, kind, container]):
            raise ValueError(
                f"incomplete LogConfig workload entry in {logconfig_name}: {workload}"
            )
        parsed.add((namespace, name, kind, container))
    return logconfig_name, parsed


def format_workloads(items: set[tuple[str, str, str, str]]) -> str:
    return "\n".join(
        f"  - namespace={ns} name={name} kind={kind} container={container}"
        for ns, name, kind, container in sorted(items)
    )


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    manifests_path = Path(args.manifests)
    logconfig_path = Path(args.logconfig)

    try:
        manifest_docs = load_yaml_documents(manifests_path)
        logconfig_docs = load_yaml_documents(logconfig_path)
        expected = deployment_workloads(manifest_docs)
        logconfig_name, actual = logconfig_workloads(logconfig_docs)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    missing = expected - actual
    stale = actual - expected

    if missing or stale:
        print("ERROR: ctl CLS LogConfig is out of sync with ctl deployments.", file=sys.stderr)
        print(f"  manifests: {manifests_path}", file=sys.stderr)
        print(f"  logconfig: {logconfig_path} ({logconfig_name})", file=sys.stderr)
        if missing:
            print("missing workload entries:", file=sys.stderr)
            print(format_workloads(missing), file=sys.stderr)
        if stale:
            print("stale workload entries:", file=sys.stderr)
            print(format_workloads(stale), file=sys.stderr)
        return 1

    print(
        "OK: ctl CLS LogConfig covers all ctl deployment containers "
        f"({len(expected)} workload entries)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
