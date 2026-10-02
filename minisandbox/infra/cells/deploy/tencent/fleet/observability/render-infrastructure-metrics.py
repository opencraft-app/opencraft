#!/usr/bin/env python3
"""Render the concrete FDB/COS collector for one production Cell."""

import argparse
import re
import sys
from pathlib import Path

import yaml


DNS_LABEL = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
DIGEST_IMAGE = re.compile(r"^[^\s]+@sha256:[0-9a-f]{64}$")
SOURCE_CELL = "actor-bj-k01"
SOURCE_CELL_SLUG = "bj-k01"
SOURCE_BUCKET = "actor-fdb-backup-prod-bj-k01-nv1-1388575217"
SOURCE_MONITOR = "foundationdb/fdb-kubernetes-monitor:7.3.79@sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c"
SOURCE_METRICS = "lightclaw-bj82.tencentcloudcr.com/actor-fleet/observability-busybox@sha256:92b1d1cae5f235812184415e63d9b24464116c58d3ba3c460b1eb0247f0f46e3"


def replace(value, substitutions):
    if isinstance(value, dict):
        return {key: replace(item, substitutions) for key, item in value.items()}
    if isinstance(value, list):
        return [replace(item, substitutions) for item in value]
    if isinstance(value, str):
        for source, target in substitutions:
            value = value.replace(source, target)
    return value


def cell_slug(cell):
    return cell[6:] if cell.startswith("actor-") else cell


def render(raw, cell, region, backup_bucket, monitor_image, metrics_image):
    if not DNS_LABEL.fullmatch(cell) or not DNS_LABEL.fullmatch(region):
        raise ValueError("cell and region must be DNS labels")
    if not BUCKET.fullmatch(backup_bucket):
        raise ValueError("backup bucket is invalid")
    for image in (monitor_image, metrics_image):
        if not DIGEST_IMAGE.fullmatch(image):
            raise ValueError("collector images must be pinned registry digests")
    documents = [document for document in yaml.safe_load_all(raw) if document]
    substitutions = (
        (SOURCE_BUCKET, backup_bucket),
        (SOURCE_CELL, cell),
        (SOURCE_CELL_SLUG, cell_slug(cell)),
        ("ap-beijing", region),
        (SOURCE_MONITOR, monitor_image),
        (SOURCE_METRICS, metrics_image),
    )
    result = replace(documents, substitutions)
    encoded = yaml.safe_dump_all(result, explicit_start=True)
    for stale in (SOURCE_BUCKET, SOURCE_CELL, SOURCE_CELL_SLUG, SOURCE_MONITOR, SOURCE_METRICS):
        if stale in encoded:
            raise ValueError("rendered collector retained a fixture identity")
    return encoded


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cell", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--backup-bucket", required=True)
    parser.add_argument("--fdb-monitor-image", required=True)
    parser.add_argument("--metrics-image", required=True)
    args = parser.parse_args()
    try:
        args.output.write_text(render(
            args.input.read_text(), args.cell, args.region, args.backup_bucket,
            args.fdb_monitor_image, args.metrics_image,
        ))
    except (OSError, ValueError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
