#!/usr/bin/env python3
"""Shared CTL test-environment runtime helpers.

脚本定义:
  为 ctl/scripts/tests 下的测试环境自动化脚本提供公共运行时能力，
  包括 test.env / platform.env 读取、默认 ai-gateway URL 推导、
  ctl-api port-forward 启停与陈旧隧道清理、以及 CREATE operation 辅助解析。

参数定义:
  本模块不直接作为 CLI 入口；由调用脚本决定具体参数并复用这里的公共解析函数。

输出结果定义:
  - 供调用方复用的 dataclass / helper / port-forward manager
  - 不直接返回 exit code
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = os.environ.get("CTL_TEST_BASE_URL", "http://127.0.0.1:19590")
DEFAULT_PORT_FORWARD_PORT = int(os.environ.get("CTL_TEST_PORT_FORWARD_PORT", "19590"))
DEFAULT_CTL_TEST_ENV_FILE = Path(".secret/ctl/test.env")
DEFAULT_CTL_TEST_SERVER_CONF = Path("ctl/conf/test/common/server_conf.toml")
DEFAULT_TEST_USER_ID = os.environ.get("CTL_TEST_USER_ID", "")
DEFAULT_AIGATEWAY_ADMIN_BASE_URL = os.environ.get("CTL_TEST_AIGATEWAY_ADMIN_BASE_URL", "")
DEFAULT_AIGATEWAY_ADMIN_TOKEN = os.environ.get("CTL_TEST_AIGATEWAY_ADMIN_TOKEN", "")
DEFAULT_PORT_FORWARD_NAMESPACE = "ctl"
DEFAULT_PORT_FORWARD_SERVICE = "ctl-api"
DEFAULT_PORT_FORWARD_REMOTE_PORT = 80
DEFAULT_PORT_SEARCH_WINDOW = 20
VALID_TEST_USER_ID_RE = re.compile(r"^usr_[a-z0-9_]+$")
SHELL_VAR_RE = re.compile(r"\$(?:\{(?P<braced>[A-Za-z_][A-Za-z0-9_]*)\}|(?P<plain>[A-Za-z_][A-Za-z0-9_]*))")
ACTIVE_INSTANCE_STATUSES = {
    "CREATING",
    "RUNNING",
    "PAUSED",
    "PAUSING",
    "RESUMING",
    "ISOLATING",
    "DELETING",
}


@dataclass
class TestEnvConnection:
    base_url: str
    env_name: str
    kubeconfig: str
    port_forward_port: int
    requested_port_forward_port: int


@dataclass
class HTTPJSONResponse:
    status_code: int
    body_text: str
    data: dict[str, Any]
    headers: dict[str, str]


@dataclass
class ResolvedAIGatewayEndpoints:
    admin_base_url: str
    expected_base_url: str


@dataclass
class TestUserResolution:
    user_id: str
    source: str


class PortForwardManager:
    def __init__(
        self,
        *,
        base_url: str,
        env_name: str,
        kubeconfig: str,
        port_forward_port: int,
        requested_port_forward_port: int,
        namespace: str = DEFAULT_PORT_FORWARD_NAMESPACE,
        service: str = DEFAULT_PORT_FORWARD_SERVICE,
        remote_port: int = DEFAULT_PORT_FORWARD_REMOTE_PORT,
    ) -> None:
        self.base_url = base_url
        self.env_name = env_name
        self.kubeconfig = kubeconfig
        self.port_forward_port = port_forward_port
        self.requested_port_forward_port = requested_port_forward_port
        self.namespace = namespace
        self.service = service
        self.remote_port = remote_port
        self.proc: subprocess.Popen[str] | None = None

    def start(self) -> None:
        if not self.env_name:
            return
        if not self.base_url.startswith(f"http://127.0.0.1:{self.port_forward_port}"):
            return
        if self.port_forward_port != self.requested_port_forward_port:
            print(
                "INFO: requested port "
                f"{self.requested_port_forward_port} is busy, auto-switching to {self.port_forward_port}",
                flush=True,
            )
        env = os.environ.copy()
        if self.kubeconfig:
            env["KUBECONFIG"] = self.kubeconfig
        self.proc = subprocess.Popen(
            [
                "kubectl",
                "-n",
                self.namespace,
                "port-forward",
                f"svc/{self.service}",
                f"{self.port_forward_port}:{self.remote_port}",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"port-forward exited early: {self.read_output()}")
            if port_is_ready("127.0.0.1", self.port_forward_port):
                return
            time.sleep(0.5)
        self.stop()
        raise RuntimeError("port-forward did not become ready within 20 seconds")

    def stop(self) -> None:
        if self.proc is None:
            return
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.proc = None

    def read_output(self) -> str:
        if self.proc is None or self.proc.stdout is None:
            return ""
        return self.proc.stdout.read().strip()


def port_is_ready(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def load_env_file(env_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not env_path.exists():
        return values
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def resolve_platform_env(env_name: str) -> dict[str, str]:
    if not env_name:
        return {}
    return load_env_file(Path("deploy") / "envs" / env_name / "platform.env")


def infer_default_aigateway_urls(
    server_conf_path: Path = DEFAULT_CTL_TEST_SERVER_CONF,
) -> tuple[str, str]:
    if not server_conf_path.exists():
        return "", ""
    text = server_conf_path.read_text(encoding="utf-8")
    default_base_url_match = re.search(
        r'^default_base_url\s*=\s*"([^"]+)"\s*$',
        text,
        re.MULTILINE,
    )
    expected_base_url = default_base_url_match.group(1).strip() if default_base_url_match else ""
    admin_base_url = (
        expected_base_url.removesuffix("/v1")
        if expected_base_url.endswith("/v1")
        else expected_base_url
    )
    return admin_base_url, expected_base_url


def has_unresolved_shell_var(value: str) -> bool:
    return bool(SHELL_VAR_RE.search(value))


def expand_shell_style_vars(value: str, env_sources: list[dict[str, str]]) -> str:
    def replace(match: re.Match[str]) -> str:
        var_name = match.group("braced") or match.group("plain") or ""
        for env_values in env_sources:
            candidate = env_values.get(var_name, "")
            if candidate:
                return candidate
        return match.group(0)

    previous = value
    for _ in range(5):
        expanded = SHELL_VAR_RE.sub(replace, previous)
        if expanded == previous:
            break
        previous = expanded
    return previous


def normalize_aigateway_base_url(value: str) -> str:
    candidate = value.strip()
    if not candidate or has_unresolved_shell_var(candidate):
        return ""
    return candidate.rstrip("/")


def derive_admin_base_url(default_base_url: str) -> str:
    candidate = normalize_aigateway_base_url(default_base_url)
    if candidate.endswith("/v1"):
        return candidate.removesuffix("/v1")
    return candidate


def derive_admin_base_url_from_domain_admin(domain_admin: str) -> str:
    candidate = normalize_aigateway_base_url(domain_admin)
    if not candidate:
        return ""
    return f"{candidate}/api/admin"


def resolve_aigateway_endpoints(
    *,
    env_file_values: dict[str, str] | None = None,
    platform_env_values: dict[str, str] | None = None,
    server_conf_path: Path = DEFAULT_CTL_TEST_SERVER_CONF,
) -> ResolvedAIGatewayEndpoints:
    env_file_values = env_file_values or {}
    platform_env_values = platform_env_values or {}
    env_sources = [os.environ, env_file_values, platform_env_values]

    inferred_admin_base_url, inferred_expected_base_url = infer_default_aigateway_urls(server_conf_path)
    inferred_admin_base_url = normalize_aigateway_base_url(
        expand_shell_style_vars(inferred_admin_base_url, env_sources)
    )
    inferred_expected_base_url = normalize_aigateway_base_url(
        expand_shell_style_vars(inferred_expected_base_url, env_sources)
    )

    env_admin_base_url = normalize_aigateway_base_url(
        expand_shell_style_vars(env_file_values.get("CTL_TEST_AIGATEWAY_ADMIN_BASE_URL", ""), env_sources)
    )
    env_default_base_url = normalize_aigateway_base_url(
        expand_shell_style_vars(env_file_values.get("CTL_TEST_AIGATEWAY_DEFAULT_BASE_URL", ""), env_sources)
    )
    default_base_url = normalize_aigateway_base_url(
        expand_shell_style_vars(DEFAULT_AIGATEWAY_ADMIN_BASE_URL, env_sources)
    )

    platform_internal_base_url = normalize_aigateway_base_url(
        expand_shell_style_vars(platform_env_values.get("AI_GATEWAY_MODEL_INTERNAL_BASE_URL", ""), env_sources)
    )
    platform_public_api = normalize_aigateway_base_url(
        expand_shell_style_vars(platform_env_values.get("DOMAIN_PUBLIC_API", ""), env_sources)
    )
    platform_domain_admin = normalize_aigateway_base_url(
        expand_shell_style_vars(platform_env_values.get("DOMAIN_ADMIN", ""), env_sources)
    )

    resolved_expected_base_url = (
        normalize_aigateway_base_url(os.environ.get("CTL_TEST_AIGATEWAY_DEFAULT_BASE_URL", ""))
        or env_default_base_url
        or platform_internal_base_url
        or (f"{platform_public_api}/v1" if platform_public_api else "")
        or inferred_expected_base_url
    )
    resolved_admin_base_url = (
        default_base_url
        or env_admin_base_url
        or derive_admin_base_url_from_domain_admin(platform_domain_admin)
        or derive_admin_base_url(resolved_expected_base_url)
        or inferred_admin_base_url
    )

    return ResolvedAIGatewayEndpoints(
        admin_base_url=resolved_admin_base_url,
        expected_base_url=resolved_expected_base_url,
    )


def sanitize_test_user_label(label: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", label.strip().lower())
    normalized = normalized.strip("_")
    return normalized or "smoke"


def generate_test_user_id(label: str = "smoke") -> str:
    safe_label = sanitize_test_user_label(label)
    return f"usr_{safe_label}_{int(time.time())}{random.randint(1000, 9999)}"


def validate_test_user_id(user_id: str) -> bool:
    return bool(VALID_TEST_USER_ID_RE.fullmatch(user_id.strip()))


def resolve_test_user_id(
    parser: argparse.ArgumentParser,
    raw_user_id: str,
    *,
    label: str,
    required: bool,
) -> str:
    user_id = raw_user_id.strip()
    if not user_id and not required:
        user_id = generate_test_user_id(label)
    if not user_id:
        parser.error("--user-id is required; pass a real usr_* user id or set CTL_TEST_USER_ID")
    if not validate_test_user_id(user_id):
        parser.error("--user-id must look like usr_* and contain only lowercase letters, digits, and underscores")
    return user_id


def normalize_optional_test_user_id(
    parser: argparse.ArgumentParser,
    raw_user_id: str,
) -> str:
    user_id = raw_user_id.strip()
    if user_id and not validate_test_user_id(user_id):
        parser.error("--user-id must look like usr_* and contain only lowercase letters, digits, and underscores")
    return user_id


def request_json(
    method: str,
    url: str,
    *,
    timeout: int = 30,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
) -> HTTPJSONResponse:
    req_headers = dict(headers or {})
    data = None
    if body is not None:
        req_headers.setdefault("Content-Type", "application/json")
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url=url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status_code = resp.getcode()
            body_text = resp.read().decode("utf-8")
            response_headers = dict(resp.headers.items())
    except urllib.error.HTTPError as err:
        status_code = err.code
        body_text = err.read().decode("utf-8")
        response_headers = dict(err.headers.items())
    except urllib.error.URLError as err:
        raise RuntimeError(f"http request failed: {method} {url}: {err}") from err
    try:
        data_obj = json.loads(body_text) if body_text else {}
    except json.JSONDecodeError as err:
        raise RuntimeError(f"invalid json response: {method} {url}: {body_text}") from err
    return HTTPJSONResponse(
        status_code=status_code,
        body_text=body_text,
        data=data_obj,
        headers={key.lower(): value for key, value in response_headers.items()},
    )


def ensure_aigateway_test_user(
    *,
    admin_base_url: str,
    admin_token: str,  # pragma: allowlist secret
    user_id: str,
    nickname: str,
    request_id_prefix: str,
    timeout: int = 30,
) -> None:
    admin_base_url = admin_base_url.rstrip("/")
    if not admin_base_url:
        raise RuntimeError("ai-gateway admin base url is required")
    if not admin_token.strip():
        raise RuntimeError("ai-gateway admin token is required")

    headers = {
        "Authorization": f"Bearer {admin_token}",
        "X-User-Id": user_id,
    }
    plans_resp = request_json(
        "GET",
        f"{admin_base_url}/plans?active=true&page=1&page_size=20",
        timeout=timeout,
        headers={**headers, "X-Request-Id": f"{request_id_prefix}-plans-{int(time.time())}"},
    )
    if plans_resp.status_code != 200:
        raise RuntimeError(f"list active plans failed: {plans_resp.body_text}")
    plans_root = plans_resp.data if isinstance(plans_resp.data, dict) else {}
    plans_data = plans_root.get("data") if isinstance(plans_root.get("data"), dict) else plans_root
    items = plans_data.get("items") if isinstance(plans_data, dict) else None
    if not isinstance(items, list) or not items:
        raise RuntimeError(f"list active plans returned no items: {plans_resp.body_text}")
    first_plan = items[0] if isinstance(items[0], dict) else None
    plan_id = str(first_plan.get("id", "")).strip() if first_plan else ""
    if not plan_id:
        raise RuntimeError(f"list active plans returned empty plan id: {plans_resp.body_text}")

    phone_suffix = f"{int(time.time() * 1000) % 1000000000:09d}"
    provision_resp = request_json(
        "POST",
        f"{admin_base_url}/provision",
        timeout=timeout,
        headers={**headers, "X-Request-Id": f"{request_id_prefix}-provision-{int(time.time())}"},
        body={
            "user_id": user_id,
            "phone": f"13{phone_suffix}",
            "nickname": nickname,
            "plan_id": plan_id,
            "assign_api_key": False,
        },
    )
    if provision_resp.status_code != 200:
        raise RuntimeError(f"provision user failed: {provision_resp.body_text}")
    if not isinstance(provision_resp.data, dict) or provision_resp.data.get("code") != "OK":
        raise RuntimeError(f"provision user returned non-OK envelope: {provision_resp.body_text}")


def extract_success_data(response: HTTPJSONResponse, *, label: str) -> dict[str, Any]:
    if response.status_code != 200:
        raise RuntimeError(f"{label} failed: http={response.status_code} body={response.body_text}")
    if not isinstance(response.data, dict):
        raise RuntimeError(f"{label} returned non-object json: {response.body_text}")
    if response.data.get("code") != "OK":
        raise RuntimeError(f"{label} returned non-OK envelope: {response.body_text}")
    data = response.data.get("data")
    if not isinstance(data, dict):
        raise RuntimeError(f"{label} returned invalid data envelope: {response.body_text}")
    return data


def list_aigateway_users(
    *,
    admin_base_url: str,
    admin_token: str,  # pragma: allowlist secret
    request_id_prefix: str,
    timeout: int = 30,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    admin_base_url = admin_base_url.rstrip("/")
    if not admin_base_url:
        raise RuntimeError("ai-gateway admin base url is required")
    if not admin_token.strip():
        raise RuntimeError("ai-gateway admin token is required")

    response = request_json(
        "GET",
        f"{admin_base_url}/users?page=1&page_size={page_size}",
        timeout=timeout,
        headers={
            "Authorization": f"Bearer {admin_token}",
            "X-Request-Id": f"{request_id_prefix}-users-{int(time.time())}",
        },
    )
    if isinstance(response.data, dict) and "code" not in response.data and "items" in response.data:
        data = response.data
    else:
        data = extract_success_data(response, label="list ai-gateway users")
    items = data.get("items")
    if not isinstance(items, list):
        raise RuntimeError(f"list ai-gateway users returned invalid items: {response.body_text}")
    return [item for item in items if isinstance(item, dict)]


def pick_aigateway_existing_user(users: list[dict[str, Any]]) -> str:
    prioritized: list[str] = []
    fallback: list[str] = []
    for item in users:
        user_id = str(item.get("user_id", "")).strip()
        if not validate_test_user_id(user_id):
            continue
        status = str(item.get("status", "")).strip().lower()
        if status and status != "active":
            continue
        if item.get("subscription_id") or item.get("token_balance") is not None:
            prioritized.append(user_id)
        else:
            fallback.append(user_id)
    for candidate in prioritized + fallback:
        return candidate
    return ""


def find_ctl_user_with_existing_instance(
    *,
    base_url: str,
    candidate_user_ids: list[str],
    request_id_prefix: str,
    timeout: int = 30,
) -> str:
    base_url = base_url.rstrip("/")
    if not base_url:
        return ""
    for user_id in candidate_user_ids:
        response = request_json(
            "GET",
            f"{base_url}/v1/instances?page=1&page_size=5",
            timeout=timeout,
            headers={
                "X-User-Id": user_id,
                "X-Request-Id": f"{request_id_prefix}-ctl-list-{int(time.time())}",
            },
        )
        if response.status_code != 200 or not isinstance(response.data, dict):
            continue
        data = response.data.get("data")
        if not isinstance(data, dict):
            continue
        items = data.get("items")
        if not isinstance(items, list) or not items:
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            status = str(item.get("status", "")).upper()
            if status in ACTIVE_INSTANCE_STATUSES:
                return user_id
        if int(data.get("total", 0) or 0) > 0:
            return user_id
    return ""


def resolve_test_user_for_smoke(
    *,
    preferred_user_id: str,
    skip_provision_user: bool,
    admin_base_url: str,
    admin_token: str,  # pragma: allowlist secret
    ctl_base_url: str,
    generated_user_label: str,
    provision_nickname: str,
    request_id_prefix: str,
    timeout: int = 30,
) -> TestUserResolution:
    preferred_user_id = preferred_user_id.strip()
    list_users_kwargs = {
        "admin_base_url": admin_base_url,
        "admin_token": admin_token,  # pragma: allowlist secret
        "request_id_prefix": request_id_prefix,
        "timeout": timeout,
    }
    provision_kwargs = {
        "admin_base_url": admin_base_url,
        "admin_token": admin_token,  # pragma: allowlist secret
        "nickname": provision_nickname,
        "request_id_prefix": request_id_prefix,
        "timeout": timeout,
    }
    if preferred_user_id:
        return TestUserResolution(
            user_id=preferred_user_id,
            source="explicit",
        )

    users = list_aigateway_users(**list_users_kwargs)
    candidate_user_ids = [
        str(item.get("user_id", "")).strip()
        for item in users
        if validate_test_user_id(str(item.get("user_id", "")).strip())
    ]

    ctl_existing_user_id = find_ctl_user_with_existing_instance(
        base_url=ctl_base_url,
        candidate_user_ids=candidate_user_ids,
        request_id_prefix=request_id_prefix,
        timeout=timeout,
    )
    if ctl_existing_user_id:
        return TestUserResolution(
            user_id=ctl_existing_user_id,
            source="ctl-existing-instance",
        )

    aigateway_existing_user_id = pick_aigateway_existing_user(users)
    if aigateway_existing_user_id:
        return TestUserResolution(
            user_id=aigateway_existing_user_id,
            source="aigateway-existing-user",
        )

    if skip_provision_user:
        raise RuntimeError(
            "skip-provision-user enabled but no reusable usr_* user was found in ai-gateway or ctl"
        )

    user_id = generate_test_user_id(generated_user_label)
    ensure_aigateway_test_user(user_id=user_id, **provision_kwargs)
    return TestUserResolution(
        user_id=user_id,
        source="provisioned",
    )


def list_listening_pids(port: int) -> list[int]:
    try:
        output = subprocess.check_output(
            ["lsof", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        return []
    pids: list[int] = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pids.append(int(line))
        except ValueError:
            continue
    return pids


def pid_command(pid: int) -> str:
    try:
        return subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "args="],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except subprocess.CalledProcessError:
        return ""


def is_port_forward_command(cmd: str, *, namespace: str, service: str) -> bool:
    normalized = " ".join(cmd.split())
    if "kubectl" not in normalized or "port-forward" not in normalized:
        return False
    if f"svc/{service}" not in normalized and f"service/{service}" not in normalized:
        return False
    return (
        f" -n {namespace} " in f" {normalized} "
        or f" --namespace {namespace} " in f" {normalized} "
    )


def cleanup_stale_port_forward(
    port: int,
    *,
    namespace: str = DEFAULT_PORT_FORWARD_NAMESPACE,
    service: str = DEFAULT_PORT_FORWARD_SERVICE,
) -> bool:
    cleaned = False
    for pid in list_listening_pids(port):
        cmd = pid_command(pid)
        if not is_port_forward_command(cmd, namespace=namespace, service=service):
            continue
        print(
            f"INFO: cleaning stale {namespace}/{service} port-forward on port {port} (pid={pid})",
            flush=True,
        )
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            cleaned = True
            continue
        deadline = time.time() + 5
        while time.time() < deadline:
            if pid not in list_listening_pids(port):
                cleaned = True
                break
            time.sleep(0.2)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            time.sleep(0.2)
            if pid not in list_listening_pids(port):
                cleaned = True
    return cleaned


def choose_port_forward_port(
    requested_port: int,
    *,
    namespace: str = DEFAULT_PORT_FORWARD_NAMESPACE,
    service: str = DEFAULT_PORT_FORWARD_SERVICE,
    search_window: int = DEFAULT_PORT_SEARCH_WINDOW,
) -> int:
    if cleanup_stale_port_forward(requested_port, namespace=namespace, service=service):
        time.sleep(0.2)
        if not port_is_ready("127.0.0.1", requested_port):
            return requested_port
    for port in range(requested_port, requested_port + search_window):
        if not port_is_ready("127.0.0.1", port):
            return port
    raise ValueError(
        f"unable to find a free local port in range {requested_port}-{requested_port + search_window - 1}"
    )


def add_testenv_connection_args(
    parser: argparse.ArgumentParser,
    *,
    default_base_url: str = DEFAULT_BASE_URL,
    default_port_forward_port: int = DEFAULT_PORT_FORWARD_PORT,
) -> None:
    parser.add_argument("--base-url", default=default_base_url, help=f"default: {default_base_url}")
    parser.add_argument("--env", default="", help="auto port-forward env, e.g. beijing-sandbox")
    parser.add_argument("--kubeconfig", default="", help="optional kubeconfig path for auto port-forward")
    parser.add_argument(
        "--port-forward-port",
        type=int,
        default=default_port_forward_port,
        help=f"default: {default_port_forward_port}",
    )


def resolve_testenv_connection(
    parser: argparse.ArgumentParser,
    args: argparse.Namespace,
    *,
    namespace: str = DEFAULT_PORT_FORWARD_NAMESPACE,
    service: str = DEFAULT_PORT_FORWARD_SERVICE,
) -> TestEnvConnection:
    platform_env_values = resolve_platform_env(args.env.strip())
    requested_port_forward_port = int(args.port_forward_port)
    selected_port_forward_port = requested_port_forward_port
    kubeconfig = args.kubeconfig.strip() or platform_env_values.get("DEPLOY_KUBECONFIG", "").strip()
    base_url = args.base_url.strip()
    if args.env.strip():
        if not kubeconfig:
            parser.error("--env requires deploy/envs/<env>/platform.env with DEPLOY_KUBECONFIG, or pass --kubeconfig")
        try:
            selected_port_forward_port = choose_port_forward_port(
                requested_port_forward_port,
                namespace=namespace,
                service=service,
            )
        except ValueError as err:
            parser.error(str(err))
        base_url = f"http://127.0.0.1:{selected_port_forward_port}"
    return TestEnvConnection(
        base_url=base_url,
        env_name=args.env.strip(),
        kubeconfig=kubeconfig,
        port_forward_port=selected_port_forward_port,
        requested_port_forward_port=requested_port_forward_port,
    )


def latest_create_operation(operations: list[dict[str, Any]]) -> dict[str, Any] | None:
    create_ops = [
        item for item in operations if str(item.get("operation_type", "")).upper() == "CREATE"
    ]
    if not create_ops:
        return None
    create_ops.sort(
        key=lambda item: (
            str(item.get("created_at", "")),
            str(item.get("updated_at", "")),
            str(item.get("operation_id", "")),
        ),
        reverse=True,
    )
    return create_ops[0]


def create_operation_error(op: dict[str, Any]) -> str:
    error_message = str(op.get("error_message", "")).strip()
    if error_message:
        return error_message
    return "missing error_message"
