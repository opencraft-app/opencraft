#!/usr/bin/env python3
"""Run leakage-safe control/treatment context evaluation."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from ccswitch_glm_provider import (  # noqa: E402
    EXPECTED_PROVIDER_ID,
    load_provider as load_ccswitch_provider,
    prepare_isolated_codex_home,
)


REPO = Path(__file__).resolve().parents[4]
EVAL_DIR = REPO / "docs/context/evaluation"
DATASET = EVAL_DIR / "candidates.jsonl"
RESULTS = EVAL_DIR / "pilot-isolated-results.jsonl"
CONTEXT_ONLY_RESULTS = EVAL_DIR / "context-only-results.jsonl"
SCHEMA = EVAL_DIR / "output-plan.schema.json"
FREEZE = EVAL_DIR / "freeze-manifest.json"
RUNS_DIR = EVAL_DIR / "runs"
DEFAULT_CCSWITCH_DATABASE = Path.home() / ".cc-switch/cc-switch.db"
V4_DATASET_NAMES = frozenset({
    "candidates-v4-holdout.jsonl",
    "candidates-v4-final.jsonl",
})


def validate_experiment_provider_selection(
    model: str,
    reasoning_effort: str,
    provider_id: str | None,
) -> str | None:
    """Require an explicit pinned provider for every new GLM5.3 experiment."""
    if model != "glm-5.3":
        if provider_id:
            raise ValueError("--ccswitch-provider is only valid for glm-5.3")
        return None
    if not provider_id:
        raise ValueError("--ccswitch-provider is required for glm-5.3 experiments")
    if provider_id != EXPECTED_PROVIDER_ID:
        raise ValueError(f"glm-5.3 experiments require pinned CC Switch provider {EXPECTED_PROVIDER_ID}")
    if reasoning_effort != "high":
        raise ValueError("the pinned GLM5.3 contract requires reasoning effort high")
    return provider_id


def resolve_freeze_manifest(file_name: str | None = None) -> Path:
    """Resolve an explicitly selected freeze manifest inside the evaluation directory."""
    candidate = Path(file_name or FREEZE.name)
    if candidate.is_absolute() or candidate.name != str(candidate):
        raise ValueError("freeze manifest must be a file name inside docs/context/evaluation")
    return EVAL_DIR / candidate


def resolve_dataset(file_name: str) -> Path:
    """Resolve an explicitly selected V4 dataset without allowing traversal."""
    candidate = Path(file_name)
    if (
        candidate.is_absolute()
        or candidate.name != file_name
        or file_name not in V4_DATASET_NAMES
    ):
        raise ValueError(
            "V4 dataset must be an approved JSONL file in docs/context/evaluation"
        )
    return EVAL_DIR / candidate


def load_candidates(dataset_path: Path) -> list[dict]:
    """Load the evaluation-only records before either arm snapshot exists."""
    candidates: list[dict] = []
    required_fields = ("id", "base_commit", "requirement_query", "changed_files")
    for line_number, line in enumerate(
        dataset_path.read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        row = json.loads(line)
        missing = [field for field in required_fields if not row.get(field)]
        if missing:
            raise ValueError(
                f"{dataset_path.name}:{line_number} missing required fields: {', '.join(missing)}"
            )
        if not isinstance(row["changed_files"], list):
            raise ValueError(f"{dataset_path.name}:{line_number} changed_files must be a list")
        candidates.append(row)
    if not candidates:
        raise ValueError(f"{dataset_path.name} has no candidates")
    return candidates


def load_matching_freeze_manifest(manifest_path: Path, current_hash: str) -> dict:
    """Load a freeze manifest and require it to describe the current context bytes."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if current_hash != manifest["context_sha256"]:
        raise RuntimeError(
            f"treatment context does not match {manifest_path.name}; "
            "freeze a new manifest before running"
        )
    return manifest


def experiment_paths(
    mode: str,
    reasoning_effort: str,
    model: str,
    run_label: str | None = None,
) -> tuple[Path, str]:
    """Return the result file and audit mode for a model/reasoning experiment."""
    if run_label:
        stem = f"{run_label}-{model}-{reasoning_effort}"
        return EVAL_DIR / f"{stem}-results.jsonl", stem
    if model == "glm-5.3" and reasoning_effort == "low" and not run_label:
        result_path = RESULTS if mode == "tool-assisted" else CONTEXT_ONLY_RESULTS
        return result_path, mode
    prefix = "reasoning" if mode == "tool-assisted" else "context-only"
    stem = f"{model}-{reasoning_effort}"
    return (
        EVAL_DIR / f"{prefix}-{stem}-results.jsonl",
        f"{mode}-{stem}",
    )

ALLOWED_FILES = [
    "docs/context/INDEX.md",
    "docs/context/23-rules-matrix.md",
    "docs/context/.context/catalog.jsonl",
    "docs/context/.context/source-map.yaml",
]

ALLOWED_DIRS = [
    ".agents/context",
    ".agents/skills/context-audit",
    ".agents/skills/product-skills/lv-docs",
    "docs/engineering",
    "docs/context/project",
    "docs/context/domains",
    "docs/context/runbooks",
    "docs/context/flows",
    "docs/context/feedback",
    "docs/context/tasks",
    "docs/context/decisions",
]

SERVICE_ROOTS = (
    ".ci",
    "admin-gateway",
    "ai-gateway",
    "cloudagent",
    "cloudladdergateway",
    "codesign",
    "ctl",
    "frontend",
    "gateway-dashboard",
    "infra_pulumi",
    "new-api",
    "nextgen-dashboard",
    "payment",
    "sandbox",
    "service-gateway",
    "shadow",
    "subscription",
    "ticket",
    "trade",
    "user/auth",
    "velagw",
    "velalink",
    "workers",
)


def is_context_asset(path: Path) -> bool:
    return path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"

def allowed_context_files() -> list[Path]:
    paths: list[Path] = []
    for item in ALLOWED_FILES + ALLOWED_DIRS:
        path = REPO / item
        if path.is_dir():
            paths.extend(sorted(p for p in path.rglob("*") if is_context_asset(p)))
        elif path.is_file():
            paths.append(path)
        else:
            raise FileNotFoundError(path)
    for service_root in SERVICE_ROOTS:
        for relative in ("README.md", "catalog-info.yaml", "docs/README.md"):
            path = REPO / service_root / relative
            if not path.is_file():
                raise FileNotFoundError(path)
            paths.append(path)
    for path in REPO.rglob("AGENTS.md"):
        if "node_modules" not in path.parts:
            paths.append(path)
    return sorted(set(paths))


def context_hash() -> str:
    digest = hashlib.sha256()
    for path in allowed_context_files():
        relative = path.relative_to(REPO).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def export_commit(commit: str, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    archive = subprocess.Popen(
        ["git", "-C", str(REPO), "archive", commit],
        stdout=subprocess.PIPE,
    )
    untar = subprocess.Popen(
        ["tar", "-x", "-C", str(destination)],
        stdin=archive.stdout,
    )
    assert archive.stdout is not None
    archive.stdout.close()
    if untar.wait() != 0 or archive.wait() != 0:
        raise RuntimeError(f"failed to export commit {commit}")


def install_treatment_context(destination: Path) -> None:
    for path in allowed_context_files():
        relative = path.relative_to(REPO)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def assert_no_evaluation_assets(root: Path) -> None:
    """Reject the complete evaluation tree, not just known historical filenames."""
    evaluation_dir = root / "docs/context/evaluation"
    if evaluation_dir.exists():
        raise RuntimeError(f"evaluation directory found in arm: {evaluation_dir}")


def assert_no_gold(root: Path) -> None:
    """Backward-compatible alias for callers from pre-V4 experiments."""
    assert_no_evaluation_assets(root)



def executed_commands(log_text: str) -> list[str]:
    return re.findall(r"^exec\n(.+)$", log_text, re.MULTILINE)


def forbidden_log_hits(log_text: str, commands: list[str], sample_id: str) -> list[str]:
    hits: list[str] = []
    forbidden_log_literals = [
        "docs/context/evaluation/candidates.jsonl",
        str(REPO),
        str(EVAL_DIR),
    ]
    forbidden_command_literals = forbidden_log_literals + [
        "docs/context/evaluation/",
    ]
    negated_evaluation_glob = re.compile(
        r"['\"]?!docs/context/evaluation/[^'\"\s]*['\"]?"
    )
    auditable_log_text = negated_evaluation_glob.sub("", log_text)
    for literal in forbidden_log_literals:
        if literal in auditable_log_text:
            hits.append(f"log contains {literal!r}")
    for command in commands:
        command_body = negated_evaluation_glob.sub(
            "", command.split(" in ", 1)[0]
        )
        if re.search(r"(?:^|[\s;|&])git(?:\s|$)", command_body):
            hits.append(f"git command: {command}")
        for literal in forbidden_command_literals:
            if literal in command_body:
                hits.append(f"command contains {literal!r}: {command}")
    return sorted(set(hits))


def validate_treatment_protocol(route: dict, commands: list[str]) -> dict:
    """Check that the Treatment consumed route, exact search, and an adjacency card."""
    must_read = list(route.get("must_read", []))
    missing = [
        path for path in must_read if not any(path in command for command in commands)
    ]
    if not any(
        "validate_context.py" in command and "--route" in command
        for command in commands
    ):
        missing.append("route command")
    exact_searches = [
        command
        for command in commands
        if re.search(r"(?:^|\s)rg(?:\s|$)", command)
        and "--max-count" in command
    ]
    if not exact_searches:
        missing.append("bounded exact search")
    adjacency_commands = [
        command
        for command in commands
        if "docs/context/project/adjacency/" in command
    ]
    if not adjacency_commands:
        missing.append("adjacency card")
    neighbor_markers = (
        "argocd/",
        ".ci/",
        "cloudladdergateway/",
        "frontend/",
        ".agents/skills/",
        "AGENTS.md",
        "catalog-info.yaml",
        "test",
    )
    if not any(
        marker in command
        for command in commands
        for marker in neighbor_markers
        if "docs/context/project/adjacency/" not in command
    ):
        missing.append("non-Context neighbor")
    return {
        "compliant": not missing,
        "missing": missing,
        "must_read": must_read,
        "exact_search_commands": exact_searches,
        "adjacency_commands": adjacency_commands,
    }


def write_failure_audit(
    audit_dir: Path,
    arm: str,
    failure_class: str,
    raw_output: str,
    log_text: str,
) -> None:
    """Persist reproducible but content-redacted evidence for output-contract failures."""
    audit_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "arm": arm,
        "failure_class": failure_class,
        "output_bytes": len(raw_output.encode("utf-8")),
        "output_sha256": hashlib.sha256(raw_output.encode("utf-8")).hexdigest(),
        "log_bytes": len(log_text.encode("utf-8")),
        "log_sha256": hashlib.sha256(log_text.encode("utf-8")).hexdigest(),
        "redacted_log_tail": (
            "[redacted; inspect compressed audit log; "
            f"tail_sha256={hashlib.sha256(log_text[-4096:].encode('utf-8')).hexdigest()}]"
        ),
    }
    (audit_dir / f"{arm}-failure.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def capture_treatment_route(workdir: Path, query: str, audit_dir: Path) -> dict:
    """Run the deterministic router before the Treatment model consumes Context."""
    validator = workdir / ".agents/context/scripts/validate_context.py"
    if not validator.is_file():
        raise RuntimeError(f"treatment route validator missing: {validator}")
    completed = subprocess.run(
        [sys.executable, str(validator), "--repo", str(workdir), "--route", query],
        cwd=workdir,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "treatment route failed with exit "
            f"{completed.returncode}: {completed.stderr[-1000:]}"
        )
    try:
        payload = json.loads(completed.stdout)
        route = payload["route"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise RuntimeError("treatment route returned invalid JSON") from exc
    if not isinstance(route.get("must_read"), list):
        raise RuntimeError("treatment route has invalid must_read")
    audit_dir.mkdir(parents=True, exist_ok=True)
    (audit_dir / "route.json").write_text(
        json.dumps(route, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return route


def codex_command(
    workdir: Path,
    output_file: Path,
    model: str,
    reasoning_effort: str,
) -> list[str]:
    return [
        "codex", "exec",
        "--skip-git-repo-check",
        "--cd", str(workdir),
        "--sandbox", "read-only",
        "-m", model,
        "-c", f"model_reasoning_effort={reasoning_effort}",
        "--output-schema", str(SCHEMA),
        "-o", str(output_file),
        "-",
    ]


def run_codex(
    workdir: Path,
    prompt_file: Path,
    output_file: Path,
    log_file: Path,
    audit_dir: Path,
    arm: str,
    sample_id: str,
    model: str = "deepseek-v4-flash-0731",
    reasoning_effort: str = "low",
    provider_spec=None,
    treatment_route: dict | None = None,
) -> dict:
    codex_home = workdir.parent / f"{arm}-codex-home"
    codex_home.mkdir(parents=True, exist_ok=True)
    if provider_spec is not None:
        environment = prepare_isolated_codex_home(
            provider_spec,
            codex_home,
            base_environment=os.environ.copy(),
        )
    else:
        for config_name in ("config.toml", "auth.json", "cc-switch-model-catalog.json"):
            source = Path.home() / ".codex" / config_name
            target = codex_home / config_name
            if source.exists() and not target.exists():
                target.symlink_to(source)
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(codex_home)

    command = codex_command(workdir, output_file, model, reasoning_effort)
    started = time.monotonic()
    max_attempts = 3
    process = None
    for attempt in range(1, max_attempts + 1):
        try:
            with log_file.open("wb") as log:
                process = subprocess.run(
                    command,
                    stdin=prompt_file.open("rb"),
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    env=environment,
                    timeout=300,
                )
        except subprocess.TimeoutExpired:
            failure_log = Path("/tmp") / f"context-eval-timeout-{workdir.name}-{log_file.name}"
            if log_file.exists():
                shutil.copy2(log_file, failure_log)
            tail = log_file.read_text(encoding="utf-8", errors="replace")[-4000:] if log_file.exists() else ""
            raise RuntimeError(
                f"codex timed out after 300 seconds; log saved to {failure_log}; tail:\n{tail}"
            ) from None

        if process.returncode == 0:
            break

        failure_log = Path("/tmp") / f"context-eval-failure-{workdir.name}-{log_file.name}-{attempt}"
        shutil.copy2(log_file, failure_log)
        tail = log_file.read_text(encoding="utf-8", errors="replace")[-4000:]
        if "429 Too Many Requests" in tail and attempt < max_attempts:
            time.sleep(30 * attempt)
            continue
        raise RuntimeError(
            f"codex failed with exit code {process.returncode}; "
            f"log saved to {failure_log}; tail:\n{tail}"
        )

    elapsed_ms = int((time.monotonic() - started) * 1000)

    log_text = log_file.read_text(encoding="utf-8", errors="replace")
    commands = executed_commands(log_text)
    token_match = re.search(r"tokens used\s*\n\s*([\d,]+)", log_text)
    tokens = int(token_match.group(1).replace(",", "")) if token_match else None
    tool_calls = len(re.findall(r"^exec$", log_text, re.MULTILINE))
    audit_dir.mkdir(parents=True, exist_ok=True)
    log_gz = audit_dir / f"{arm}.log.gz"
    log_gz.write_bytes(gzip.compress(log_text.encode("utf-8"), compresslevel=9))
    raw_output = (
        output_file.read_text(encoding="utf-8").strip()
        if output_file.exists()
        else ""
    )
    try:
        if not raw_output:
            raise ValueError("empty-output")
        json_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw_output)
        if json_match:
            raw_output = json_match.group(1).strip()
        plan = normalize_plan(json.loads(raw_output))
    except (json.JSONDecodeError, ValueError) as exc:
        failure_class = "empty-output" if str(exc) == "empty-output" else "output-contract"
        write_failure_audit(audit_dir, arm, failure_class, raw_output, log_text)
        raise RuntimeError(f"{arm} returned {failure_class}") from exc

    forbidden = forbidden_log_hits(log_text, commands, sample_id)
    protocol = (
        validate_treatment_protocol(treatment_route, commands)
        if treatment_route is not None
        else None
    )
    audit = {
        "arm": arm,
        "sample_id": sample_id,
        "model": model,
        "reasoning_effort": reasoning_effort,
        "workdir": str(workdir),
        "tokens_used": tokens,
        "tool_calls": tool_calls,
        "wall_time_ms": elapsed_ms,
        "executed_commands": commands,
        "forbidden_hits": forbidden,
        "log_sha256": hashlib.sha256(log_text.encode("utf-8")).hexdigest(),
        "log_gzip": log_gz.name,
        "protocol": protocol,
    }
    (audit_dir / f"{arm}-audit.json").write_text(
        json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if forbidden:
        raise RuntimeError(f"{arm} log audit failed: {forbidden}")

    return {
        "plan": plan,
        "tokens_used": tokens,
        "tool_calls": tool_calls,
        "wall_time_ms": elapsed_ms,
        "protocol": protocol,
    }


def run_paired_arms(
    control_dir: Path,
    treatment_dir: Path,
    prompt_file: Path,
    control_output: Path,
    treatment_output: Path,
    control_log: Path,
    treatment_log: Path,
    audit_dir: Path,
    sample_id: str,
    model: str = "deepseek-v4-flash-0731",
    reasoning_effort: str = "low",
    run_codex_func=run_codex,
    provider_spec=None,
    treatment_prompt_file: Path | None = None,
    treatment_route: dict | None = None,
):
    """Run Control and Treatment concurrently while preserving arm isolation."""
    provider_args = (provider_spec,) if provider_spec is not None else ()
    treatment_args = (
        (provider_spec, treatment_route)
        if treatment_route is not None
        else provider_args
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        control_future = executor.submit(
            run_codex_func,
            control_dir,
            prompt_file,
            control_output,
            control_log,
            audit_dir,
            "control",
            sample_id,
            model,
            reasoning_effort,
            *provider_args,
        )
        treatment_future = executor.submit(
            run_codex_func,
            treatment_dir,
            treatment_prompt_file or prompt_file,
            treatment_output,
            treatment_log,
            audit_dir,
            "treatment",
            sample_id,
            model,
            reasoning_effort,
            *treatment_args,
        )
        return control_future.result(), treatment_future.result()


def normalize_plan(plan: dict) -> dict:
    files: list[str] = []
    raw_files = plan.get(
        "proposed_changed_files",
        plan.get("proposedChangedFiles", plan.get("changedFiles", [])),
    )
    for item in raw_files:
        if isinstance(item, dict):
            if "path" in item:
                files.append(str(item["path"]))
            files.extend(str(path) for path in item.get("paths", []))
        else:
            files.append(str(item))

    tests: list[str] = []
    raw_tests = plan.get("required_tests", plan.get("requiredTests", []))
    for item in raw_tests:
        if isinstance(item, dict):
            tests.append(str(item.get("command", item)))
        else:
            tests.append(str(item))

    approach = plan.get(
        "implementation_approach",
        plan.get("implementationApproach", ""),
    )
    if isinstance(approach, list):
        approach = "\n".join(approach)

    if not files:
        raise ValueError("proposed_changed_files must not be empty")

    return {
        "proposed_changed_files": files,
        "required_tests": tests,
        "implementation_approach": str(approach),
    }


def score(plan: dict, gold: set[str]) -> dict:
    top_five = plan["proposed_changed_files"][:5]
    hits = [path for path in top_five if path in gold]
    mrr = 0.0
    for index, path in enumerate(top_five, 1):
        if path in gold:
            mrr = 1 / index
            break
    full_hits = sum(path in gold for path in plan["proposed_changed_files"])
    return {
        "hit_at_5": int(bool(hits)),
        "recall_at_5": round(len(hits) / len(gold), 4) if gold else 0.0,
        "mrr": round(mrr, 4),
        "top5_hits": hits,
        "full_recall": round(full_hits / len(gold), 4) if gold else 0.0,
        "proposed_count": len(plan["proposed_changed_files"]),
    }


def make_prompt(
    query: str,
    mode: str,
    treatment_route: dict | None = None,
) -> str:
    if mode == "context-only":
        restrictions = """- Do not use any tools.
- Do not inspect the repository.
- Use only the automatically loaded repository context and the task query.
- If uncertain, still return the best plan immediately; do not keep searching."""
    else:
        restrictions = """- Bounded exploration: inspect only the most relevant files, then stop. Do not audit the whole repository.
- Hard tool budget: use at most 5 shell commands. After 5 commands, stop searching and return the best plan.
- If uncertain, still return the best plan; do not keep searching.
- Prefer `rg` and targeted file reads over broad scans.
- Read at most 120 lines per file. Use `rg --max-count 50` before reading.
- Never print an entire package manifest, stylesheet, lockfile, or generated file."""

    treatment_protocol = ""
    if treatment_route is not None:
        must_read = "\n".join(
            f"- `{path}`" for path in treatment_route.get("must_read", [])
        ) or "- (the route selected no must_read files)"
        treatment_protocol = f"""
Treatment protocol (mandatory, counted in the tool budget):
- First run `python3 .agents/context/scripts/validate_context.py --route <the task query>`.
- Read every route-selected must-read file below with targeted commands:
{must_read}
- Then run at least one bounded exact `rg --max-count 50` search in the route-relevant source directories.
- Locate and read one relevant card below `docs/context/project/adjacency/`, then inspect one non-Context neighbor named by that card (test, generated artifact, config, or deployment manifest).
- Do not produce the final JSON until those four steps are complete.
"""

    return f"""You are evaluating a repository context strategy. Work read-only. Do not modify files.

Hard restrictions:
- Do not run git commands.
- Do not inspect branches, commit history, merge requests, images, or files outside this source snapshot.
- Do not search for evaluation datasets, benchmark answers, or gold files.
- Use only text files in this source snapshot.
{restrictions}
{treatment_protocol}

Task query: {query}

Inspect text files in this source snapshot only. Produce an implementation plan with:
1. proposed changed files
2. required tests
3. implementation approach

Output contract:
- `proposed_changed_files` must contain at least one file.
- Return the three to five highest-confidence changed files, ordered most relevant first.
- If uncertain, still return the best available candidates; never return an empty list.

Return JSON only matching the output schema. Paths must be strings. Do not include prose outside JSON.
"""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        required=True,
        help="approved V4 JSONL filename under docs/context/evaluation",
    )
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument(
        "--mode",
        choices=("tool-assisted", "context-only"),
        default="tool-assisted",
    )
    parser.add_argument("--sample-id", help="Run one dataset sample by id")
    parser.add_argument(
        "--model",
        default="deepseek-v4-flash-0731",
        help="model to use for both arms",
    )
    parser.add_argument(
        "--reasoning-effort",
        choices=("low", "medium", "high", "xhigh"),
        default="low",
        help="reasoning effort for both arms",
    )
    parser.add_argument(
        "--ccswitch-provider",
        help="required pinned CC Switch provider id for new glm-5.3 experiments",
    )
    parser.add_argument(
        "--ccswitch-db",
        type=Path,
        default=DEFAULT_CCSWITCH_DATABASE,
        help="read-only CC Switch SQLite database path",
    )
    parser.add_argument(
        "--run-label",
        help="isolated result prefix for a repeat experiment, e.g. second-round-2",
    )
    parser.add_argument(
        "--freeze-manifest",
        default=FREEZE.name,
        help="freeze manifest file name under docs/context/evaluation",
    )
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    selected_provider_id = validate_experiment_provider_selection(
        args.model,
        args.reasoning_effort,
        args.ccswitch_provider,
    )
    provider_spec = (
        load_ccswitch_provider(args.ccswitch_db, selected_provider_id)
        if selected_provider_id
        else None
    )
    results_path, run_mode = experiment_paths(
        args.mode,
        args.reasoning_effort,
        args.model,
        args.run_label,
    )

    frozen_hash = context_hash()
    manifest_path = resolve_freeze_manifest(args.freeze_manifest)
    load_matching_freeze_manifest(manifest_path, frozen_hash)

    dataset_path = resolve_dataset(args.dataset)
    candidates = load_candidates(dataset_path)
    existing: set[str] = set()
    if results_path.exists():
        existing = {
            json.loads(line)["id"]
            for line in results_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        }

    remaining = [row for row in candidates if f"{row['id']}#run1" not in existing]
    if args.sample_id:
        remaining = [row for row in remaining if row["id"] == args.sample_id]
        if not remaining:
            raise RuntimeError(f"sample not found or already complete: {args.sample_id}")
    batch = remaining[:args.limit]
    if not batch:
        print("no remaining samples")
        return

    for row in batch:
        sample_id = row["id"]
        for run_number in range(1, args.repeat + 1):
            result_id = f"{sample_id}#run{run_number}"
            if result_id in existing:
                continue

            with tempfile.TemporaryDirectory(prefix="context-eval-") as temp:
                temp_dir = Path(temp)
                control_dir = temp_dir / "control"
                treatment_dir = temp_dir / "treatment"
                export_commit(row["base_commit"], control_dir)
                export_commit(row["base_commit"], treatment_dir)
                install_treatment_context(treatment_dir)
                assert_no_evaluation_assets(control_dir)
                assert_no_evaluation_assets(treatment_dir)

                control_prompt_file = temp_dir / "control-prompt.txt"
                control_prompt_file.write_text(
                    make_prompt(row["requirement_query"], args.mode),
                    encoding="utf-8",
                )
                control_output = temp_dir / "control.json"
                treatment_output = temp_dir / "treatment.json"
                control_log = temp_dir / "control.log"
                treatment_log = temp_dir / "treatment.log"

                audit_dir = RUNS_DIR / frozen_hash / run_mode / result_id
                if audit_dir.exists():
                    raise RuntimeError(f"audit directory already exists: {audit_dir}")
                treatment_route = capture_treatment_route(
                    treatment_dir,
                    row["requirement_query"],
                    audit_dir,
                )
                treatment_prompt_file = temp_dir / "treatment-prompt.txt"
                treatment_prompt_file.write_text(
                    make_prompt(
                        row["requirement_query"],
                        args.mode,
                        treatment_route,
                    ),
                    encoding="utf-8",
                )
                control, treatment = run_paired_arms(
                    control_dir=control_dir,
                    treatment_dir=treatment_dir,
                    prompt_file=control_prompt_file,
                    control_output=control_output,
                    treatment_output=treatment_output,
                    control_log=control_log,
                    treatment_log=treatment_log,
                    audit_dir=audit_dir,
                    sample_id=sample_id,
                    model=args.model,
                    reasoning_effort=args.reasoning_effort,
                    provider_spec=provider_spec,
                    treatment_prompt_file=treatment_prompt_file,
                    treatment_route=treatment_route,
                )
                protocol = treatment.get("protocol")
                if not protocol or not protocol["compliant"]:
                    missing = protocol["missing"] if protocol else ["missing protocol audit"]
                    raise RuntimeError(
                        f"treatment protocol noncompliant: {', '.join(missing)}"
                    )

                gold = set(row["changed_files"])
                result = {
                    "id": result_id,
                    "sample_id": sample_id,
                    "run": run_number,
                    "base_commit": row["base_commit"],
                    "gold_count": len(gold),
                    "context_sha256": frozen_hash,
                    "audit_dir": str(audit_dir.relative_to(REPO)),
                    "dataset": dataset_path.name,
                    "control": score(control["plan"], gold),
                    "treatment": score(treatment["plan"], gold),
                    "control_metrics": {
                        "tokens_used": control["tokens_used"],
                        "tool_calls": control["tool_calls"],
                        "wall_time_ms": control["wall_time_ms"],
                    },
                    "treatment_metrics": {
                        "tokens_used": treatment["tokens_used"],
                        "tool_calls": treatment["tool_calls"],
                        "wall_time_ms": treatment["wall_time_ms"],
                    },
                    "treatment_protocol": protocol,
                    "control_plan": control["plan"],
                    "treatment_plan": treatment["plan"],
                    "mode": args.mode,
                    "model": args.model,
                    "reasoning_effort": args.reasoning_effort,
                    "ccswitch_provider_id": selected_provider_id,
                    "notes": (
                        f"Fresh Codex CLI session per arm; mode={args.mode}; "
                        f"model={args.model}; "
                        f"reasoning_effort={args.reasoning_effort}; "
                        f"ccswitch_provider_id={selected_provider_id or 'not-selected'}; "
                        "git-free archive snapshots; gold and scorer outside arms; "
                        "Treatment route/search/adjacency protocol required."
                    ),
                }
                with results_path.open("a", encoding="utf-8") as output:
                    output.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
                existing.add(result_id)

                print(
                    f"{result_id}: control={result['control']['recall_at_5']:.3f} "
                    f"treatment={result['treatment']['recall_at_5']:.3f}",
                    flush=True,
                )


if __name__ == "__main__":
    main()
