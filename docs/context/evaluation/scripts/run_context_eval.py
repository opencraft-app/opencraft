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
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


REPO = Path(__file__).resolve().parents[4]
EVAL_DIR = REPO / "docs/context/evaluation"
DATASET = EVAL_DIR / "candidates.jsonl"
RESULTS = EVAL_DIR / "pilot-isolated-results.jsonl"
CONTEXT_ONLY_RESULTS = EVAL_DIR / "context-only-results.jsonl"
SCHEMA = EVAL_DIR / "output-plan.schema.json"
FREEZE = EVAL_DIR / "freeze-manifest.json"
RUNS_DIR = EVAL_DIR / "runs"


def experiment_paths(mode: str, reasoning_effort: str, model: str) -> tuple[Path, str]:
    """Return the result file and audit mode for a model/reasoning experiment."""
    if model == "glm-5.3" and reasoning_effort == "low":
        result_path = RESULTS if mode == "tool-assisted" else CONTEXT_ONLY_RESULTS
        return result_path, mode
    prefix = "reasoning" if mode == "tool-assisted" else "context-only"
    stem = f"{model}-{reasoning_effort}"
    return (
        EVAL_DIR / f"{prefix}-{stem}-results.jsonl",
        f"{mode}-{stem}",
    )

ALLOWED_FILES = [
    "AGENTS.md",
    "docs/context/README.md",
    "docs/context/23-rules-matrix.md",
    "docs/context/context-routing.yaml",
    "docs/context/context-pack.schema.json",
    "docs/context/authority-policy.yaml",
    "docs/context/catalog.jsonl",
    "docs/context/source-map.yaml",
]

ALLOWED_DIRS = [
    "docs/context/project",
    "docs/context/domains",
    "docs/context/standards",
]

ALLOWED_NESTED_FILES = [
    "docs/context/skills/inventory.md",
    "docs/context/tasks/README.md",
    "docs/context/tasks/task-template.md",
    "docs/context/feedback/README.md",
    "docs/context/feedback/feedback-template.md",
]


def allowed_context_files() -> list[Path]:
    paths: list[Path] = []
    for item in ALLOWED_FILES + ALLOWED_DIRS + ALLOWED_NESTED_FILES:
        path = REPO / item
        if path.is_dir():
            paths.extend(sorted(p for p in path.rglob("*") if p.is_file()))
        elif path.is_file():
            paths.append(path)
        else:
            raise FileNotFoundError(path)
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


def assert_no_gold(root: Path) -> None:
    forbidden_names = {
        "candidates.jsonl",
        "contaminated-pilot-results.jsonl",
        "pilot-isolated-results.jsonl",
        "freeze-manifest.json",
    }
    for path in root.rglob("*"):
        if path.is_file() and path.name in forbidden_names:
            raise RuntimeError(f"gold-side file found in arm: {path}")
        if path.is_dir() and path.name == "evaluation" and "docs/context" in path.as_posix():
            raise RuntimeError(f"evaluation directory found in arm: {path}")



def executed_commands(log_text: str) -> list[str]:
    return re.findall(r"^exec\n(.+)$", log_text, re.MULTILINE)


def forbidden_log_hits(log_text: str, commands: list[str], sample_id: str) -> list[str]:
    hits: list[str] = []
    forbidden_log_literals = [
        "docs/context/evaluation/candidates.jsonl",
        "raw_description",
        "verification_evidence",
        "merge_commit",
        str(REPO),
        str(EVAL_DIR),
    ]
    forbidden_command_literals = forbidden_log_literals + [
        "docs/context/evaluation/",
    ]
    for literal in forbidden_log_literals:
        if literal in log_text:
            hits.append(f"log contains {literal!r}")
    for command in commands:
        command_body = command.split(" in ", 1)[0]
        if re.search(r"(?:^|[\s;|&])git(?:\s|$)", command_body):
            hits.append(f"git command: {command}")
        for literal in forbidden_command_literals:
            if literal in command:
                hits.append(f"command contains {literal!r}: {command}")
    return sorted(set(hits))


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
) -> dict:
    codex_home = workdir.parent / f"{arm}-codex-home"
    codex_home.mkdir(parents=True, exist_ok=True)
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
    plan = json.loads(output_file.read_text(encoding="utf-8"))
    forbidden = forbidden_log_hits(log_text, commands, sample_id)

    audit_dir.mkdir(parents=True, exist_ok=True)
    log_gz = audit_dir / f"{arm}.log.gz"
    log_gz.write_bytes(gzip.compress(log_text.encode("utf-8"), compresslevel=9))
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
    }
    (audit_dir / f"{arm}-audit.json").write_text(
        json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if forbidden:
        raise RuntimeError(f"{arm} log audit failed: {forbidden}")

    return {
        "plan": normalize_plan(plan),
        "tokens_used": tokens,
        "tool_calls": tool_calls,
        "wall_time_ms": elapsed_ms,
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
):
    """Run Control and Treatment concurrently while preserving arm isolation."""
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
        )
        treatment_future = executor.submit(
            run_codex_func,
            treatment_dir,
            prompt_file,
            treatment_output,
            treatment_log,
            audit_dir,
            "treatment",
            sample_id,
            model,
            reasoning_effort,
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


def make_prompt(query: str, mode: str) -> str:
    if mode == "context-only":
        restrictions = """- Do not use any tools.
- Do not inspect the repository.
- Use only the automatically loaded repository context and the task query.
- If uncertain, still return the best plan immediately; do not keep searching."""
    else:
        restrictions = """- Bounded exploration: inspect only the most relevant files, then stop. Do not audit the whole repository.
- Hard tool budget: use at most 5 shell commands. After 5 commands, stop searching and return the best plan.
- If uncertain, still return the best plan; do not keep searching.
- Prefer `rg` and targeted file reads over broad scans."""

    return f"""You are evaluating a repository context strategy. Work read-only. Do not modify files.

Hard restrictions:
- Do not run git commands.
- Do not inspect branches, commit history, merge requests, images, or files outside this source snapshot.
- Do not search for evaluation datasets, benchmark answers, or gold files.
- Use only text files in this source snapshot.
{restrictions}

Task query: {query}

Inspect text files in this source snapshot only. Produce an implementation plan with:
1. proposed changed files
2. required tests
3. implementation approach

Return JSON only matching the output schema. Paths must be strings. Do not include prose outside JSON.
"""


def main() -> None:
    parser = argparse.ArgumentParser()
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
        choices=("low", "medium", "high"),
        default="low",
        help="reasoning effort for both arms; always uses glm-5.3",
    )
    args = parser.parse_args()
    results_path, run_mode = experiment_paths(
        args.mode, args.reasoning_effort, args.model
    )

    frozen_hash = context_hash()
    manifest = json.loads(FREEZE.read_text(encoding="utf-8"))
    if frozen_hash != manifest["context_sha256"]:
        raise RuntimeError(
            "treatment context does not match freeze-manifest.json; "
            "freeze a new manifest before running"
        )

    candidates = [json.loads(line) for line in DATASET.read_text(encoding="utf-8").splitlines() if line.strip()]
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
                assert_no_gold(control_dir)
                assert_no_gold(treatment_dir)

                prompt_file = temp_dir / "prompt.txt"
                prompt_file.write_text(
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
                control, treatment = run_paired_arms(
                    control_dir=control_dir,
                    treatment_dir=treatment_dir,
                    prompt_file=prompt_file,
                    control_output=control_output,
                    treatment_output=treatment_output,
                    control_log=control_log,
                    treatment_log=treatment_log,
                    audit_dir=audit_dir,
                    sample_id=sample_id,
                    model=args.model,
                    reasoning_effort=args.reasoning_effort,
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
                    "control_plan": control["plan"],
                    "treatment_plan": treatment["plan"],
                    "mode": args.mode,
                    "model": args.model,
                    "reasoning_effort": args.reasoning_effort,
                    "notes": (
                        f"Fresh Codex CLI session per arm; mode={args.mode}; "
                        f"model={args.model}; "
                        f"reasoning_effort={args.reasoning_effort}; "
                        "git-free archive snapshots; gold and scorer outside arms."
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
