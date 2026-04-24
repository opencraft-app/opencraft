#!/usr/bin/env python3
"""
脚本定义:
  扫描仓库中的文本文件，发现疑似误提交的密钥、密码、Basic Auth URL 等高风险模式。
  目标是为 pre-commit 提供低噪声、可操作的门禁，而不是通用语义扫描。

参数定义:
  filenames...
    可选，pre-commit 传入的文件列表；为空时只打印帮助并退出。
  -h, --help
    显示帮助。

输出结果定义:
  stdout 打印命中的文件、行号和规则名。
  退出码 0 表示未发现问题，1 表示发现疑似密钥，2 表示参数错误。

调用示例:
  python3 scripts/scan_secrets.py infra_pulumi/README.md sandbox/docker-compose.yml
  pre-commit run scan-secrets --all-files
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

EXCLUDED_PATH_PATTERNS = [
    re.compile(r"(^|/)\.secret/"),
    re.compile(r"(^|/)_bmad/"),
    re.compile(r"(^|/)_bmad-output/"),
    re.compile(r"(^|/)docs/superpowers/"),
    re.compile(r"(^|/).+\.sops\.ya?ml$"),
    re.compile(r"(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.sum)$"),
    re.compile(r"(^|/).*\.patch$"),
    re.compile(r"(^|/).*/?(server\.gen|api\.gen)\.go$"),
    re.compile(r"(^|/).+_test\.go$"),
    re.compile(r"(^|/).+\.(test|spec)\.[jt]sx?$"),
]

AKID_PATTERN = re.compile(r"AKID[0-9A-Za-z]{16,}")
BASIC_AUTH_URL_PATTERN = re.compile(r"://([^/\s:@]+):([^/\s:@]+)@")
CONFIG_ASSIGNMENT_PATTERN = re.compile(
    r"""(?ix)
    (?P<key>[A-Z0-9_]+|[a-z0-9_]+)
    \s*
    (?:=|:)
    \s*
    (?P<quote>["'])?
    (?P<value>[^"'\s#,]+)
    (?P=quote)?
    """
)
GETENV_DEFAULT_PATTERN = re.compile(
    r"""(?x)
    getenv\(
      \s*"(?P<env>[A-Z0-9_]+)"\s*,\s*"(?P<value>[^"]+)"
    \)
    """
)
GO_FIELD_PATTERN = re.compile(
    r"""(?x)
    \b(?P<field>Password|SecretId|SecretKey|AdminToken|AccessToken)\s*:\s*
    (?:common\.StringPtr\()?"(?P<value>[^"]+)"
    """
)
SENSITIVE_CONFIG_KEYS = {
    "password",
    "passwd",
    "redis_password",
    "mysql_root_password",
    "db_password",
    "secret_id",
    "secret_key",
    "admin_token",
    "access_token",
    "api_key",
    "tencentcloud_secret_id",
    "tencentcloud_secret_key",
    "tf_var_node_password",
    "tf_var_db_password",
}
TEXT_FILE_SUFFIXES = {
    ".md",
    ".yaml",
    ".yml",
    ".toml",
    ".env",
    ".tfvars",
    ".sh",
    ".py",
    ".json",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Scan text files for likely committed secrets with low-noise repo-specific rules.",
    )
    parser.add_argument("filenames", nargs="*")
    return parser


def should_skip_path(path: Path) -> bool:
    text = path.as_posix()
    return any(pattern.search(text) for pattern in EXCLUDED_PATH_PATTERNS)


def looks_like_placeholder(value: str) -> bool:
    lowered = value.strip().lower()
    if not lowered:
        return True
    placeholder_markers = (
        "${",
        "$(",
        "<",
        "...",
        "your-",
        "your_",
        "replace",
        "example",
        "changeme",
        "dummy",
        "placeholder",
        "secret",
        "xxx",
        "token-here",
        "password-here",
        "pass@localhost",
        "user:pass@",
        "redis-password",
    )
    if any(marker in lowered for marker in placeholder_markers):
        return True
    if lowered in {"pass", "password", "token", "secret", "null", "none", "no", "yes", "true", "false", "root", "cvm"}:
        return True
    if lowered.startswith("test-") or lowered.startswith("test_"):
        return True
    return False


def scan_file(path: Path) -> list[tuple[int, str, str]]:
    try:
        content = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []

    findings: list[tuple[int, str, str]] = []
    is_text_config = path.suffix.lower() in TEXT_FILE_SUFFIXES or path.name.endswith(".env.example") or path.name.endswith(".tfvars.example")
    for lineno, line in enumerate(content.splitlines(), start=1):
        if "pragma: allowlist secret" in line:
            continue
        lowered_line = line.lower()
        if "access denied for user" in lowered_line and "using password:" in lowered_line:
            continue

        if AKID_PATTERN.search(line):
            findings.append((lineno, "AKID", line.strip()))

        match = BASIC_AUTH_URL_PATTERN.search(line)
        if match and not looks_like_placeholder(match.group(2)):
            findings.append((lineno, "basic-auth-url", line.strip()))

        if is_text_config:
            for assignment in CONFIG_ASSIGNMENT_PATTERN.finditer(line):
                key = assignment.group("key").lower()
                value = assignment.group("value")
                if key not in SENSITIVE_CONFIG_KEYS:
                    continue
                if looks_like_placeholder(value):
                    continue
                findings.append((lineno, "hardcoded-secret", line.strip()))

        if path.suffix.lower() == ".go":
            match = GETENV_DEFAULT_PATTERN.search(line)
            if match:
                env_name = match.group("env").lower()
                value = match.group("value")
                if any(token in env_name for token in ("password", "secret_key", "secret_id", "admin_token", "access_token")) and not looks_like_placeholder(value):
                    findings.append((lineno, "hardcoded-secret", line.strip()))

            match = GO_FIELD_PATTERN.search(line)
            if match and not looks_like_placeholder(match.group("value")):
                findings.append((lineno, "hardcoded-secret", line.strip()))

    return findings


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if not args.filenames:
        parser.print_help(sys.stderr)
        return 2

    has_findings = False
    for raw_path in args.filenames:
        path = Path(raw_path)
        if not path.is_file() or should_skip_path(path):
            continue
        for lineno, rule, line in scan_file(path):
            has_findings = True
            print(f"{path}:{lineno}: {rule}: {line}")

    return 1 if has_findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
