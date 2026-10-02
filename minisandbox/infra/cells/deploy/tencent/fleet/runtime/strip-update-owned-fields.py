#!/usr/bin/env python3
"""Remove controller-owned fields from an existing Cell update manifest."""

import argparse
import re
from pathlib import Path


def strip_runtime_replicas(source: str, cell: str) -> str:
    documents = source.split("\n---\n")
    matched = 0
    for index, document in enumerate(documents):
        framed = f"\n{document}\n"
        if "\nkind: StatefulSet\n" not in framed or f"\n  name: {cell}-runtime-hosts\n" not in framed:
            continue
        documents[index], replacements = re.subn(
            r"(?m)^  replicas: [1-9][0-9]*\n", "", document, count=1
        )
        if replacements != 1:
            raise ValueError(
                "runtime StatefulSet must contain one bootstrap replicas field"
            )
        matched += 1
    if matched != 1:
        raise ValueError(
            "expected exactly one runtime StatefulSet while removing update-time replicas"
        )
    return "\n---\n".join(documents)


def strip_runtime_update_strategy(source: str, cell: str) -> str:
    documents = source.split("\n---\n")
    matched = 0
    for index, document in enumerate(documents):
        framed = f"\n{document}\n"
        if "\nkind: StatefulSet\n" not in framed or f"\n  name: {cell}-runtime-hosts\n" not in framed:
            continue
        documents[index], replacements = re.subn(
            r"(?m)^  updateStrategy:\n(?:    [^\n]*\n)+", "", document, count=1
        )
        if replacements != 1:
            raise ValueError(
                "runtime StatefulSet must contain one bootstrap updateStrategy field"
            )
        matched += 1
    if matched != 1:
        raise ValueError(
            "expected exactly one runtime StatefulSet while removing update-time strategy"
        )
    return "\n---\n".join(documents)


def strip_runtime_update_owned_fields(source: str, cell: str) -> str:
    return strip_runtime_update_strategy(strip_runtime_replicas(source, cell), cell)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--cell", required=True)
    args = parser.parse_args()
    args.manifest.write_text(
        strip_runtime_update_owned_fields(args.manifest.read_text(), args.cell)
    )


if __name__ == "__main__":
    main()
