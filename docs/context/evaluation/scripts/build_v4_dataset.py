#!/usr/bin/env python3
"""Freeze an independent V4 holdout/final dataset from normalized MR records."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
from collections import defaultdict
from pathlib import Path


REPO = Path(__file__).resolve().parents[4]
EVAL_DIR = REPO / "docs/context/evaluation"
REQUIRED_FIELDS = (
    "id",
    "base_commit",
    "merge_commit",
    "requirement_query",
    "changed_files",
    "service",
    "risk",
)


def derive_service(paths: list[str]) -> str:
    """Assign a stable repository service label from the first changed path."""
    first_path = paths[0]
    if first_path.startswith("user/auth/"):
        return "user/auth"
    return first_path.split("/", 1)[0]


def derive_risk(paths: list[str]) -> str:
    """Use a transparent path-only release-risk slice; never inspect diff content."""
    high_risk_prefixes = (
        ".ci/",
        "argocd/",
        "infra_pulumi/",
        "payment/",
        "subscription/",
        "trade/",
        "user/auth/",
    )
    return "high" if any(path.startswith(high_risk_prefixes) for path in paths) else "low"


def normalize_changed_paths(paths: list[str]) -> list[str]:
    """Keep only repository-relative paths from a local first-parent diff."""
    normalized = sorted({path for path in paths if path and path != "/dev/null"})
    if not normalized:
        raise ValueError("merge commit has no repository-relative changed paths")
    return normalized


def normalize_merged_mr(
    merge_request: dict,
    merge_commit: dict,
    changed_files: list[str],
) -> dict:
    """Build a V4 record from Gongfeng MR metadata plus local Git diff paths."""
    parent_ids = merge_commit.get("parent_ids")
    merge_sha = merge_request.get("merge_commit_sha")
    iid = merge_request.get("iid")
    title = merge_request.get("title")
    if not isinstance(parent_ids, list) or not parent_ids or not all(
        isinstance(value, str) and value for value in parent_ids[:1]
    ):
        raise ValueError(f"MR {iid} has no first-parent base commit")
    if not isinstance(merge_sha, str) or not merge_sha:
        raise ValueError(f"MR {iid} has no merge commit")
    if not isinstance(iid, int) or not isinstance(title, str) or not title.strip():
        raise ValueError("MR record lacks IID or title")
    changed_files = normalize_changed_paths(changed_files)
    return {
        "id": f"mono2-mr-{iid}",
        "base_commit": parent_ids[0],
        "merge_commit": merge_sha,
        "requirement_query": title.strip(),
        "changed_files": changed_files,
        "service": derive_service(changed_files),
        "risk": derive_risk(changed_files),
    }


def local_first_parent_changed_files(
    base_commit: str,
    merge_commit: str,
    git_runner=None,
) -> list[str]:
    """Compute Gold from local Git history, the authority for a merge's file delta."""
    if git_runner is not None:
        return normalize_changed_paths(git_runner(base_commit, merge_commit))
    completed = subprocess.run(
        ["git", "-C", str(REPO), "diff", "--name-only", base_commit, merge_commit],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("local Git cannot resolve V4 merge diff")
    return normalize_changed_paths(completed.stdout.splitlines())


def run_gongfeng_json(command: list[str]) -> object:
    """Run a read-only Gongfeng CLI request without echoing its raw payload."""
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Gongfeng command failed: {' '.join(command[:3])}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Gongfeng returned invalid JSON") from exc
    if not payload.get("ok"):
        raise RuntimeError(f"Gongfeng request failed: {' '.join(command[:3])}")
    return payload["result"]


def fetch_merged_records(
    project: str,
    max_merged_mrs: int,
    query_runner=run_gongfeng_json,
    created_after: str | None = None,
    git_runner=None,
) -> list[dict]:
    """Use Gongfeng for merged-MR candidates and local Git for authoritative Gold."""
    list_command = [
        "gongfengcli",
        "mr",
        "list",
        project,
        "--state",
        "merged",
        "--target-branch",
        "master",
        "--order-by",
        "updated_at",
        "--sort",
        "desc",
        "--per-page",
        str(max_merged_mrs),
    ]
    if created_after:
        list_command.extend(["--created-after", created_after])
    merge_requests = query_runner(list_command)
    if not isinstance(merge_requests, list):
        raise ValueError("Gongfeng merged-MR list must be an array")

    records: list[dict] = []
    for merge_request in merge_requests[:max_merged_mrs]:
        if not isinstance(merge_request, dict):
            continue
        mr_id = merge_request.get("id")
        merge_sha = merge_request.get("merge_commit_sha")
        if not isinstance(mr_id, int) or not isinstance(merge_sha, str) or not merge_sha:
            continue
        merge_commit = query_runner(
            ["gongfengcli", "commits", "get", project, merge_sha]
        )
        if not isinstance(merge_commit, dict):
            continue
        parent_ids = merge_commit.get("parent_ids")
        if not isinstance(parent_ids, list) or not parent_ids:
            continue
        changed_files = local_first_parent_changed_files(
            parent_ids[0],
            merge_sha,
            git_runner=git_runner,
        )
        records.append(normalize_merged_mr(merge_request, merge_commit, changed_files))
    return records


def validate_record(record: dict, seen_ids: set[str]) -> None:
    missing = [field for field in REQUIRED_FIELDS if not record.get(field)]
    if missing:
        raise ValueError(f"record missing required fields: {', '.join(missing)}")
    if not isinstance(record["changed_files"], list):
        raise ValueError(f"record {record['id']} changed_files must be a list")
    if record["id"] in seen_ids:
        raise ValueError(f"duplicate record id: {record['id']}")
    seen_ids.add(record["id"])


def select_v4_samples(
    records: list[dict],
    excluded_ids: set[str],
    seed: int,
) -> tuple[list[dict], list[dict]]:
    """Select five holdout and fifty final records by service/risk round-robin."""
    seen_ids: set[str] = set()
    eligible: list[dict] = []
    for record in records:
        validate_record(record, seen_ids)
        if record["id"] not in excluded_ids:
            eligible.append(record)
    if len(eligible) < 55:
        raise ValueError("at least 55 eligible records are required for V4")

    buckets: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for record in eligible:
        buckets[(record["service"], record["risk"])].append(record)

    randomizer = random.Random(seed)
    keys = sorted(buckets)
    for key in keys:
        buckets[key].sort(key=lambda item: item["id"])
        randomizer.shuffle(buckets[key])
    randomizer.shuffle(keys)

    selected: list[dict] = []
    while len(selected) < 55:
        made_progress = False
        for key in keys:
            if buckets[key]:
                selected.append(buckets[key].pop())
                made_progress = True
                if len(selected) == 55:
                    break
        if not made_progress:
            raise ValueError("eligible-record selection ended before 55 samples")
    return selected[:5], selected[5:]


def load_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def load_excluded_ids(paths: list[Path]) -> set[str]:
    excluded: set[str] = set()
    for path in paths:
        for row in load_jsonl(path):
            identifier = row.get("sample_id", row.get("id"))
            if isinstance(identifier, str):
                excluded.add(identifier.split("#run", 1)[0])
    return excluded


def legacy_exclusion_paths(directory: Path = EVAL_DIR) -> list[Path]:
    """Return every pre-V4 candidate/result record that must not be resampled."""
    paths = [directory / "candidates.jsonl"]
    paths.extend(
        path
        for path in directory.glob("*-results.jsonl")
        if not path.name.startswith("v4-")
    )
    return sorted(path for path in paths if path.is_file())


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--source", type=Path, help="normalized merged-MR JSONL")
    source_group.add_argument(
        "--fetch-project",
        help="Gongfeng project path for read-only merged-MR discovery",
    )
    parser.add_argument(
        "--max-merged-mrs",
        type=int,
        default=120,
        help="maximum recent merged master MRs to inspect through Gongfeng",
    )
    parser.add_argument(
        "--created-after",
        help="optional ISO-8601 lower boundary for Gongfeng MR discovery",
    )
    parser.add_argument(
        "--exclude-jsonl",
        type=Path,
        action="append",
        default=[],
        help="additional candidate/result JSONL excluded from V4 selection",
    )
    parser.add_argument("--seed", type=int, default=20260827)
    parser.add_argument(
        "--holdout-output",
        type=Path,
        default=EVAL_DIR / "candidates-v4-holdout.jsonl",
    )
    parser.add_argument(
        "--final-output",
        type=Path,
        default=EVAL_DIR / "candidates-v4-final.jsonl",
    )
    parser.add_argument(
        "--provenance-output",
        type=Path,
        default=EVAL_DIR / "v4-dataset-provenance.json",
    )
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    records = (
        load_jsonl(args.source)
        if args.source is not None
        else fetch_merged_records(
            args.fetch_project,
            args.max_merged_mrs,
            created_after=args.created_after,
        )
    )
    exclusion_paths = sorted(set(legacy_exclusion_paths() + args.exclude_jsonl))
    excluded_ids = load_excluded_ids(exclusion_paths)
    holdout, final = select_v4_samples(records, excluded_ids, args.seed)

    selected = holdout + final
    provenance = {
        "selection_algorithm": "service-risk-round-robin-v1",
        "seed": args.seed,
        "source": (
            {"kind": "jsonl", "sha256": sha256_file(args.source)}
            if args.source is not None
            else {
                "kind": "gongfeng-merged-master-mrs",
                "project": args.fetch_project,
                "created_after": args.created_after,
                "max_merged_mrs": args.max_merged_mrs,
                "normalized_sha256": hashlib.sha256(
                    json.dumps(records, ensure_ascii=False, sort_keys=True).encode("utf-8")
                ).hexdigest(),
            }
        ),
        "exclusion_sha256": {path.name: sha256_file(path) for path in exclusion_paths},
        "holdout_count": len(holdout),
        "final_count": len(final),
        "strata": {
            f"{service}:{risk}": sum(
                row["service"] == service and row["risk"] == risk
                for row in selected
            )
            for service, risk in sorted({(row["service"], row["risk"]) for row in selected})
        },
        "selected_id_sha256": hashlib.sha256(
            "\n".join(row["id"] for row in selected).encode("utf-8")
        ).hexdigest(),
    }
    write_jsonl(args.holdout_output, holdout)
    write_jsonl(args.final_output, final)
    args.provenance_output.write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        f"wrote {len(holdout)} holdout and {len(final)} final V4 candidates",
        flush=True,
    )


if __name__ == "__main__":
    main()
