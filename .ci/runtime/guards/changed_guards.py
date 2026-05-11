"""
Run registered guard scripts for changed files.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Guard:
    name: str
    paths: tuple[str, ...]
    command: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--base-ref", default="origin/master")
    parser.add_argument("--head-ref", default="HEAD")
    parser.add_argument("--guards-file", default=".ci/guards.manifest")
    parser.add_argument(
        "--trusted-ref",
        default="",
        help="Git ref to load guard config and command scripts from. Use target branch for MR checks.",
    )
    parser.add_argument(
        "--changed-files-file",
        type=Path,
        default=None,
        help="Optional newline-delimited changed files list for tests or external callers.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print matched guards without executing them")
    return parser.parse_args()


def run_git(repo_root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )


def git_show(repo_root: Path, ref: str, path: str) -> str:
    result = run_git(repo_root, ["show", f"{ref}:{path}"])
    if result.returncode != 0:
        raise RuntimeError(f"failed to read {path} from {ref}: {result.stderr.strip()}")
    return result.stdout


def normalize_repo_path(path: str) -> str:
    normalized = path.strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def validate_relative_path(path: str, *, field: str) -> str:
    normalized = normalize_repo_path(path)
    candidate = Path(normalized)
    if not normalized or candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError(f"invalid {field}: {path}")
    return normalized


def changed_files(repo_root: Path, base_ref: str, head_ref: str, changed_files_file: Path | None) -> list[str]:
    if changed_files_file is not None:
        print(f"变更文件发现：使用外部文件清单 {changed_files_file}")
        return sorted(
            {
                normalize_repo_path(line)
                for line in changed_files_file.read_text().splitlines()
                if normalize_repo_path(line)
            }
        )

    commands = [
        ["diff", "--name-only", f"{base_ref}...{head_ref}"],
        ["diff", "--name-only", f"{base_ref}..{head_ref}"],
        ["diff", "--name-only", "HEAD~1..HEAD"],
    ]
    last_error = ""
    for command in commands:
        print(f"变更文件发现：尝试 git {' '.join(command)}")
        result = run_git(repo_root, command)
        if result.returncode == 0:
            print(f"变更文件发现：使用 git {' '.join(command)}")
            return sorted({normalize_repo_path(line) for line in result.stdout.splitlines() if normalize_repo_path(line)})
        last_error = result.stderr.strip()
    raise RuntimeError(f"failed to determine changed files: {last_error}")


def load_guards(repo_root: Path, guards_file: str, trusted_ref: str) -> list[Guard]:
    guard_path = validate_relative_path(guards_file, field="guards-file")
    if trusted_ref:
        print(f"Guard 注册表：从可信 ref {trusted_ref} 读取 {guard_path}")
        raw = git_show(repo_root, trusted_ref, guard_path)
    else:
        print(f"Guard 注册表：从当前工作区读取 {guard_path}")
        raw = (repo_root / guard_path).read_text()
    payload = yaml.safe_load(raw) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"{guard_path} must contain a YAML mapping")
    raw_guards = payload.get("guards") or []
    if not isinstance(raw_guards, list):
        raise ValueError(f"{guard_path}: guards must be a list")

    guards: list[Guard] = []
    for index, raw_guard in enumerate(raw_guards):
        if not isinstance(raw_guard, dict):
            raise ValueError(f"{guard_path}: guards[{index}] must be a mapping")
        name = str(raw_guard.get("name") or "").strip()
        command = validate_relative_path(str(raw_guard.get("command") or ""), field=f"guards[{index}].command")
        paths = raw_guard.get("paths") or []
        if not name:
            raise ValueError(f"{guard_path}: guards[{index}].name is required")
        if not isinstance(paths, list) or not paths:
            raise ValueError(f"{guard_path}: guards[{index}].paths must be a non-empty list")
        guards.append(
            Guard(
                name=name,
                command=command,
                paths=tuple(validate_relative_path(str(pattern), field=f"guards[{index}].paths") for pattern in paths),
            )
        )
    return guards


def path_matches(pattern: str, path: str) -> bool:
    if fnmatch.fnmatchcase(path, pattern):
        return True
    if pattern.endswith("/**"):
        prefix = pattern[:-3]
        return path == prefix or path.startswith(prefix + "/")
    return False


def matching_files(guard: Guard, files: list[str]) -> list[str]:
    return [path for path in files if any(path_matches(pattern, path) for pattern in guard.paths)]


def materialize_trusted_command(repo_root: Path, trusted_ref: str, command: str, temp_root: Path) -> Path:
    destination = temp_root / command
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(git_show(repo_root, trusted_ref, command))
    destination.chmod(0o700)
    print(f"Guard 命令：从可信 ref {trusted_ref} materialize {command}")
    return destination


def command_path(repo_root: Path, trusted_ref: str, command: str, temp_root: Path) -> Path:
    if trusted_ref:
        return materialize_trusted_command(repo_root, trusted_ref, command, temp_root)
    path = repo_root / command
    if not path.is_file():
        raise FileNotFoundError(f"guard command not found: {command}")
    return path


def run_guard(repo_root: Path, guard: Guard, matched_files: list[str], args: argparse.Namespace, temp_root: Path) -> int:
    matched_file = temp_root / f"{guard.name}.changed-files.txt"
    matched_file.write_text("".join(f"{path}\n" for path in matched_files))
    script = command_path(repo_root, args.trusted_ref, guard.command, temp_root)
    env = os.environ.copy()
    env.update(
        {
            "GUARD_NAME": guard.name,
            "GUARD_REPO_ROOT": str(repo_root),
            "GUARD_CHANGED_FILES_FILE": str(matched_file),
            "GUARD_BASE_REF": args.base_ref,
            "GUARD_HEAD_REF": args.head_ref,
        }
    )
    print("============================================================")
    print(f"Guard 执行：{guard.name}")
    print(f"命令：{guard.command}")
    print(f"命中变更文件数：{len(matched_files)}")
    print("说明：只执行与本次变更路径匹配的约束检查")
    print("============================================================")
    result = subprocess.run(["bash", str(script)], cwd=repo_root, env=env, check=False)
    if result.returncode != 0:
        print(f"Guard 执行失败：{guard.name} exit_code={result.returncode}", file=sys.stderr)
    else:
        print(f"Guard 执行通过：{guard.name}")
    return result.returncode


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    try:
        files = changed_files(repo_root, args.base_ref, args.head_ref, args.changed_files_file)
        guards = load_guards(repo_root, args.guards_file, args.trusted_ref)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if not files:
        print("变更目录约束：未发现变更文件，直接通过")
        return 0

    matched: list[tuple[Guard, list[str]]] = []
    for guard in guards:
        files_for_guard = matching_files(guard, files)
        if files_for_guard:
            matched.append((guard, files_for_guard))

    print("============================================================")
    print("变更目录约束：开始派发")
    print(f"Repo root：{repo_root}")
    print(f"Base ref：{args.base_ref}")
    print(f"Head ref：{args.head_ref}")
    print(f"Trusted ref：{args.trusted_ref or '<current-worktree>'}")
    print(f"变更文件数：{len(files)}")
    print(f"命中 guard 数：{len(matched)}")
    print("============================================================")
    if not matched:
        print("变更目录约束：没有命中任何 guard，直接通过")
        return 0

    for guard, files_for_guard in matched:
        print(f"Guard 命中：{guard.name}")
        print("命中文件：")
        for path in files_for_guard:
            print(f"  - {path}")

    if args.dry_run:
        print("变更目录约束：dry-run 模式，只展示命中结果，不执行 guard")
        return 0

    with tempfile.TemporaryDirectory() as tempdir:
        temp_root = Path(tempdir)
        for guard, files_for_guard in matched:
            exit_code = run_guard(repo_root, guard, files_for_guard, args, temp_root)
            if exit_code != 0:
                return exit_code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
