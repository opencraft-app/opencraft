#!/usr/bin/env python3
"""
Create Tencent Cloud CAM subusers for EdgeOne preview operations.

Behavior:
- Ensures each user exists (creates if missing)
- Ensures required policies are attached
- Creates one new AccessKey per user so credentials can be handed off
- Writes results to a local JSON file with chmod 600

Secrets:
- Read root/admin SecretId/SecretKey from env vars:
  TENCENTCLOUD_SECRET_ID
  TENCENTCLOUD_SECRET_KEY
- Does not print generated passwords or subuser AccessKeys to stdout
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_POLICY_IDS = [271353894, 271354084]
DEFAULT_REMARK = "EO Pages preview-only operator for lightvela-preview"
DEFAULT_KEY_DESC = "EO-preview-Beijing-readonly-key"


class TCError(RuntimeError):
    def __init__(self, code: str, message: str, raw: str = "") -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.raw = raw


@dataclass
class UserResult:
    username: str
    created: bool
    uin: int
    uid: int
    password: str | None
    access_key_id: str
    secret_access_key: str
    attached_policy_ids: list[int]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create / provision EdgeOne preview CAM subusers.")
    parser.add_argument("usernames", nargs="+", help="Subuser names to create/provision.")
    parser.add_argument(
        "--policy-id",
        dest="policy_ids",
        action="append",
        type=int,
        help=f"Policy ID to attach. Can be repeated. Default: {DEFAULT_POLICY_IDS}",
    )
    parser.add_argument(
        "--remark",
        default=DEFAULT_REMARK,
        help=f"Subuser remark. Default: {DEFAULT_REMARK!r}",
    )
    parser.add_argument(
        "--key-description",
        default=DEFAULT_KEY_DESC,
        help=f"Description for newly created access keys. Default: {DEFAULT_KEY_DESC!r}",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Path to write JSON results. Defaults to ~/.codex/tmp/edgeone-preview-subusers-<rand>.json",
    )
    return parser.parse_args()


def env_or_die(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"missing required environment variable: {name}")
    return value


def run_tccli(secret_id: str, secret_key: str, args: list[str]) -> dict[str, Any]:
    cmd = [
        "tccli",
        *args,
        "--secretId",
        secret_id,
        "--secretKey",
        secret_key,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()
    if proc.returncode != 0:
        raw = stdout or stderr
        if "TencentCloudSDKException" in raw:
            code = "TencentCloudSDKException"
            message = raw
            for piece in raw.split():
                if piece.startswith("code:"):
                    code = piece.removeprefix("code:")
                if piece.startswith("message:"):
                    message = raw.split("message:", 1)[1].split(" requestId:", 1)[0]
                    break
            raise TCError(code, message, raw)
        raise TCError("CommandFailed", raw or "tccli failed", raw)

    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise TCError("InvalidJSON", f"failed to parse tccli output: {exc}", stdout) from exc

    # tccli generally wraps in Response; some commands may not, but we still accept raw payload.
    response = payload.get("Response")
    if isinstance(response, dict) and "Error" in response:
        err = response["Error"]
        raise TCError(err.get("Code", "Unknown"), err.get("Message", "Unknown"), stdout)
    return payload


def unwrap_response(payload: dict[str, Any]) -> dict[str, Any]:
    response = payload.get("Response")
    if isinstance(response, dict):
        return response
    return payload


def unique_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in values:
        item = raw.strip()
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def get_user(secret_id: str, secret_key: str, username: str) -> dict[str, Any] | None:
    try:
        payload = run_tccli(secret_id, secret_key, ["cam", "GetUser", "--Name", username])
        return payload
    except TCError as exc:
        if exc.code == "ResourceNotFound.UserNotExist":
            return None
        raise


def add_user(secret_id: str, secret_key: str, username: str, remark: str) -> dict[str, Any]:
    payload = run_tccli(
        secret_id,
        secret_key,
        [
            "cam",
            "AddUser",
            "--Name",
            username,
            "--Remark",
            remark,
            "--ConsoleLogin",
            "1",
            "--UseApi",
            "0",
            "--NeedResetPassword",
            "1",
        ],
    )
    return unwrap_response(payload)


def list_attached_policy_ids(secret_id: str, secret_key: str, target_uin: int) -> set[int]:
    payload = run_tccli(
        secret_id,
        secret_key,
        [
            "cam",
            "ListAttachedUserAllPolicies",
            "--TargetUin",
            str(target_uin),
            "--AttachType",
            "1",
            "--Page",
            "1",
            "--Rp",
            "200",
        ],
    )
    raw = unwrap_response(payload)
    policy_list = raw.get("PolicyList", [])
    ids: set[int] = set()
    for item in policy_list:
        try:
            ids.add(int(item["PolicyId"]))
        except Exception:
            continue
    return ids


def attach_policy(secret_id: str, secret_key: str, target_uin: int, policy_id: int) -> None:
    run_tccli(
        secret_id,
        secret_key,
        [
            "cam",
            "AttachUserPolicy",
            "--PolicyId",
            str(policy_id),
            "--AttachUin",
            str(target_uin),
        ],
    )


def list_access_keys(secret_id: str, secret_key: str, target_uin: int) -> list[dict[str, Any]]:
    payload = run_tccli(
        secret_id,
        secret_key,
        [
            "cam",
            "ListAccessKeys",
            "--TargetUin",
            str(target_uin),
        ],
    )
    raw = unwrap_response(payload)
    return raw.get("AccessKeys", [])


def create_access_key(secret_id: str, secret_key: str, target_uin: int, description: str) -> dict[str, Any]:
    payload = run_tccli(
        secret_id,
        secret_key,
        [
            "cam",
            "CreateAccessKey",
            "--TargetUin",
            str(target_uin),
            "--Description",
            description,
        ],
    )
    response = unwrap_response(payload)
    access_key = response.get("AccessKey")
    if not access_key:
        raise TCError("MissingAccessKey", "CreateAccessKey returned no AccessKey", json.dumps(payload))
    return access_key


def ensure_output_path(raw: str) -> Path:
    if raw:
        path = Path(raw).expanduser().resolve()
    else:
        base = Path.home() / ".codex" / "tmp"
        base.mkdir(parents=True, exist_ok=True)
        path = base / f"edgeone-preview-subusers-{secrets.token_hex(6)}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def write_secure_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def main() -> int:
    args = parse_args()
    secret_id = env_or_die("TENCENTCLOUD_SECRET_ID")
    secret_key = env_or_die("TENCENTCLOUD_SECRET_KEY")
    policy_ids = args.policy_ids or DEFAULT_POLICY_IDS
    usernames = unique_preserve_order(args.usernames)
    results: list[UserResult] = []

    for username in usernames:
        existing = get_user(secret_id, secret_key, username)
        created = existing is None
        password: str | None = None

        if created:
            response = add_user(secret_id, secret_key, username, args.remark)
            uin = int(response["Uin"])
            uid = int(response["Uid"])
            password = response.get("Password") or None
        else:
            uin = int(existing["Uin"])
            uid = int(existing["Uid"])

        attached = list_attached_policy_ids(secret_id, secret_key, uin)
        for policy_id in policy_ids:
            if policy_id not in attached:
                attach_policy(secret_id, secret_key, uin, policy_id)
                attached.add(policy_id)

        keys = list_access_keys(secret_id, secret_key, uin)
        if len(keys) >= 2:
            raise SystemExit(
                f"user {username} (uin={uin}) already has {len(keys)} access keys; "
                "refusing to create another because the secret for existing keys cannot be recovered"
            )

        access_key = create_access_key(secret_id, secret_key, uin, args.key_description)
        results.append(
            UserResult(
                username=username,
                created=created,
                uin=uin,
                uid=uid,
                password=password,
                access_key_id=access_key["AccessKeyId"],
                secret_access_key=access_key["SecretAccessKey"],
                attached_policy_ids=sorted(attached),
            )
        )

    output_path = ensure_output_path(args.output)
    write_secure_json(
        output_path,
        {
            "generated_at": os.popen("date -u '+%Y-%m-%dT%H:%M:%SZ'").read().strip(),
            "policy_ids": policy_ids,
            "results": [r.__dict__ for r in results],
        },
    )

    print(f"created/provisioned {len(results)} user(s)")
    print(f"credentials written to: {output_path}")
    print("secret material was not printed to stdout")
    return 0


if __name__ == "__main__":
    sys.exit(main())
