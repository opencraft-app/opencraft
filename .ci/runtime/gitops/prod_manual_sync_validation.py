"""Validate that production Argo applications do not enable automated sync."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Iterable

import yaml


PROD_PATH_TOKEN = "prod"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument(
        "--search-root",
        type=Path,
        default=Path("argocd"),
        help="Directory under repo root to scan for production YAML files.",
    )
    return parser.parse_args()


def iter_yaml_files(root: Path) -> Iterable[Path]:
    if not root.exists():
        return []
    return sorted(
        path
        for pattern in ("*.yaml", "*.yml")
        for path in root.rglob(pattern)
        if PROD_PATH_TOKEN in path.relative_to(root).as_posix().lower()
    )


def load_yaml_documents(path: Path) -> list[Any]:
    try:
        return list(yaml.safe_load_all(path.read_text()))
    except yaml.YAMLError as exc:
        raise ValueError(f"failed to parse YAML: {exc}") from exc


def automated_sync_value(document: dict[str, Any]) -> Any:
    if document.get("kind") == "Application":
        return ((document.get("spec") or {}).get("syncPolicy") or {}).get("automated")
    if document.get("kind") == "ApplicationSet":
        template_spec = (((document.get("spec") or {}).get("template") or {}).get("spec") or {})
        return (template_spec.get("syncPolicy") or {}).get("automated")
    return None


def validate(repo_root: Path, search_root: Path) -> list[str]:
    root = (repo_root / search_root).resolve()
    errors: list[str] = []
    for yaml_file in iter_yaml_files(root):
        rel_file = yaml_file.relative_to(repo_root.resolve()).as_posix()
        try:
            documents = load_yaml_documents(yaml_file)
        except ValueError as exc:
            errors.append(f"{rel_file}: {exc}")
            continue

        for index, document in enumerate(documents, start=1):
            if not isinstance(document, dict):
                continue
            automated = automated_sync_value(document)
            if automated not in (None, False):
                kind = document.get("kind") or "YAML document"
                name = ((document.get("metadata") or {}).get("name") or f"doc#{index}")
                errors.append(
                    f"{rel_file}: {kind} {name} must not enable syncPolicy.automated in production paths"
                )
    return errors


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    errors = validate(repo_root, args.search_root)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"prod manual sync validation passed: search_root={(repo_root / args.search_root).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
