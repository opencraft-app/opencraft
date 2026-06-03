"""Split Hermes pool VM JSONL rows into per-region files."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Split Hermes VM JSONL rows by Tencent Cloud region.")
    parser.add_argument("input_jsonl", type=Path)
    parser.add_argument("output_dir", type=Path)
    return parser.parse_args()


def load_rows(input_path: Path) -> dict[str, list[dict[str, Any]]]:
    by_region: dict[str, list[dict[str, Any]]] = {}
    with input_path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise RuntimeError(f"VM row is not an object: {line}")
            region = row.get("region")
            if not region:
                raise RuntimeError(f"VM row missing region: {line}")
            by_region.setdefault(str(region), []).append(row)
    return by_region


def split_by_region(input_path: Path, output_dir: Path) -> list[tuple[str, Path, int]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[tuple[str, Path, int]] = []
    for region, rows in sorted(load_rows(input_path).items()):
        region_path = output_dir / f"vms-{region}.jsonl"
        with region_path.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        manifest.append((region, region_path, len(rows)))
    return manifest


def main() -> int:
    args = parse_args()
    for region, region_path, count in split_by_region(args.input_jsonl, args.output_dir):
        print(f"{region}\t{region_path}\t{count}")
    return 0
