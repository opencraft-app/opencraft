#!/usr/bin/env python3
"""
Definition:
  Validate that Kubernetes workloads declared in one or more manifest files are
  fully covered by a CLS LogConfig. This is used as a deployment guardrail so
  changes to Deployment/StatefulSet manifests do not silently omit CLS updates.

Parameters:
  --name <value>              Optional label used in output messages.
  --manifest <path>           Optional, repeatable. Explicit manifest file path.
  --manifests-glob <pattern>  Optional, repeatable. Glob pattern for manifest files.
  --logconfig <path>          Required. CLS LogConfig file path.
  --namespace <value>         Optional. Restrict validation to a namespace.
  --kind <value>              Optional, repeatable. Supported workload kinds to validate.
                              Default: Deployment StatefulSet

Outputs:
  - Prints validation summary to stdout/stderr.
  - Exit code 0: validation passed or no matching workloads exist yet.
  - Exit code 1: validation failed because workloads and LogConfig are out of sync.
  - Exit code 2: invalid arguments, unreadable files, or malformed YAML.

Examples:
  python3 scripts/validate_cls_workloads.py \
    --name sandbox \
    --namespace sandbox \
    --manifest sandbox/k8s/base/manifests.yaml \
    --manifest sandbox/k8s/base/ingressproxy-manifests.yaml \
    --logconfig sandbox/k8s/base/cls-logconfig.yaml

  python3 scripts/validate_cls_workloads.py \
    --name ai-gateway \
    --namespace ai-gateway \
    --manifests-glob 'ai-gateway/k8s/*.yaml' \
    --logconfig ai-gateway/k8s/cls-logconfig.yaml
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate that workload manifests are fully covered by a CLS LogConfig.",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument("--name", default="service", help="Friendly service name for output.")
    parser.add_argument(
        "--manifest",
        action="append",
        default=[],
        help="Explicit manifest file path. Can be repeated.",
    )
    parser.add_argument(
        "--manifests-glob",
        action="append",
        default=[],
        help="Glob pattern used to discover manifest files. Can be repeated.",
    )
    parser.add_argument("--logconfig", required=True, help="CLS LogConfig file path.")
    parser.add_argument("--namespace", help="Expected namespace filter.")
    parser.add_argument(
        "--kind",
        action="append",
        default=[],
        help="Workload kind to validate. Can be repeated. Defaults to Deployment and StatefulSet.",
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


def discover_manifest_paths(explicit: list[str], globs: list[str]) -> list[Path]:
    paths: set[Path] = {Path(item) for item in explicit}
    for pattern in globs:
        paths.update(sorted(Path(".").glob(pattern)))
    return sorted(paths)


def collect_workloads(
    manifest_paths: list[Path], namespace: str | None, allowed_kinds: set[str]
) -> set[tuple[str, str, str, str]]:
    workloads: set[tuple[str, str, str, str]] = set()
    for path in manifest_paths:
        for doc in load_yaml_documents(path):
            kind = doc.get("kind")
            if kind not in allowed_kinds:
                continue

            metadata = doc.get("metadata") or {}
            item_namespace = metadata.get("namespace")
            name = metadata.get("name")
            if namespace and item_namespace != namespace:
                continue
            if not item_namespace or not name:
                raise ValueError(f"workload missing namespace or name in {path}")

            containers = (
                doc.get("spec", {})
                .get("template", {})
                .get("spec", {})
                .get("containers", [])
            )
            if not containers:
                raise ValueError(f"workload has no containers: {path} {item_namespace}/{name}")

            for container in containers:
                container_name = container.get("name")
                if not container_name:
                    raise ValueError(
                        f"workload container missing name: {path} {item_namespace}/{name}"
                    )
                workloads.add((item_namespace, name, kind.lower(), container_name))
    return workloads


def collect_logconfig_workloads(path: Path) -> tuple[str, set[tuple[str, str, str, str]]]:
    docs = load_yaml_documents(path)
    logconfig_docs = [doc for doc in docs if doc.get("kind") == "LogConfig"]
    if len(logconfig_docs) != 1:
        raise ValueError(f"expected exactly 1 LogConfig document in {path}, found {len(logconfig_docs)}")

    logconfig = logconfig_docs[0]
    logconfig_name = (logconfig.get("metadata") or {}).get("name", "<unknown>")
    topic_id = (
        logconfig.get("spec", {})
        .get("clsDetail", {})
        .get("topicId", "")
        .strip()
    )
    if not topic_id or "REPLACE_ME" in topic_id:
        raise ValueError(f"{path} has empty or placeholder cls topicId")

    workloads = (
        logconfig.get("spec", {})
        .get("inputDetail", {})
        .get("containerStdout", {})
        .get("workloads", [])
    )
    if not workloads:
        raise ValueError(f"{path} has no containerStdout workloads")

    parsed: set[tuple[str, str, str, str]] = set()
    for workload in workloads:
        namespace = workload.get("namespace")
        name = workload.get("name")
        kind = workload.get("kind")
        container = workload.get("container")
        if not all([namespace, name, kind, container]):
            raise ValueError(f"incomplete LogConfig workload entry in {path}: {workload}")
        parsed.add((namespace, name, str(kind).lower(), container))
    return logconfig_name, parsed


def format_workloads(items: set[tuple[str, str, str, str]]) -> str:
    return "\n".join(
        f"  - namespace={ns} name={name} kind={kind} container={container}"
        for ns, name, kind, container in sorted(items)
    )


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    allowed_kinds = set(args.kind or ["Deployment", "StatefulSet"])
    manifest_paths = discover_manifest_paths(args.manifest, args.manifests_glob)

    try:
        expected = collect_workloads(manifest_paths, args.namespace, allowed_kinds)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    # No workload manifests yet: this keeps future hooks for ai-gateway safe until
    # the first repo-managed k8s manifest appears.
    if not expected:
        print(f"OK: no matching workloads found for {args.name}; CLS validation skipped.")
        return 0

    try:
        logconfig_name, actual = collect_logconfig_workloads(Path(args.logconfig))
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    missing = expected - actual
    stale = actual - expected
    if missing or stale:
        print(f"ERROR: {args.name} CLS LogConfig is out of sync with workload manifests.", file=sys.stderr)
        print(f"  logconfig: {args.logconfig} ({logconfig_name})", file=sys.stderr)
        if missing:
            print("missing workload entries:", file=sys.stderr)
            print(format_workloads(missing), file=sys.stderr)
        if stale:
            print("stale workload entries:", file=sys.stderr)
            print(format_workloads(stale), file=sys.stderr)
        return 1

    print(
        f"OK: {args.name} CLS LogConfig covers all workload containers "
        f"({len(expected)} workload entries)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
