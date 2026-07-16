#!/usr/bin/env python3
"""
LightClaw 镜像全自动构建流水线（主入口）

定位:
  - 这是 `images/` 目录的自动化流水线主入口
  - 默认版本号与构建源统一读取 `images/build-manifest.json`
  - 负责串联重装、构建、验证、制镜、跨地域复制
  - 也提供 `versions` 子命令，用于查询当前 pinned 与远端最新版本
  - 依赖 `deploy-build.sh` 和 `tests/` 下的验证脚本

完整流程:
  1. 重装系统 (ResetInstance)
  2. 等待实例就绪 (SSH 可连接)
  3. 执行 deploy-build.sh 构建镜像内容
  4. 可选: 运行自动化验证脚本
  5. 可选: 验证通过后再次重装，回到干净基础镜像
  6. 执行正式 deploy-build.sh 构建镜像内容
  7. 创建自定义镜像 (CreateImage)
  8. 等待镜像创建完成
  9. 跨地域并发复制到目标地域 (SyncImages) — 基础镜像模式下跳过
  10. 等待复制完成，输出目标地域镜像 ID

构建模式:
  - 全量构建（默认）: 从 Ubuntu 24.04 公网镜像开始完整安装，创建镜像并跨地域复制
  - 基础镜像构建 (--build-base): 仅安装系统底座，创建镜像仅保留首尔
  - 应用层构建 (--base-image-id): 基于基础镜像安装 openclaw 生态，跨地域复制

用法:
  # 查询当前 pinned 与远端最新版本
  python3 images/build-image.py versions
  python3 images/build-image.py versions --format json

  # 全量构建
  python3 images/build-image.py

  # 分层构建：先构建基础镜像（仅首次或底座变更时）
  python3 images/build-image.py --build-base

  # 分层构建：基于基础镜像构建应用层（日常使用）
  python3 images/build-image.py --base-image-id img-id352nof
  python3 images/build-image.py --base-image-id img-id352nof --with-verify

  # 仅验证到实例，不创建镜像
  python3 images/build-image.py --base-image-id img-id352nof --with-verify --skip-create-image --skip-sync-image

  # 常用排障
  python3 images/build-image.py --skip-create-image --skip-sync-image

  # 单次临时覆盖版本
  python3 images/build-image.py --openclaw-version 2026.3.28 --qqbot-version 1.6.6 --weixin-version 2.1.1

耗时预估:
  - 基础镜像构建: ~15 分钟（一次性）
  - 应用层构建: ~8-12 分钟
  - 应用层构建（带验证）: ~25-35 分钟
  - 全量构建: ~25-70 分钟
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
import tempfile
from urllib import error, parse, request
from datetime import datetime, timezone, timedelta

# ============================================================
# 默认配置
# ============================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
MANIFEST_PATH = os.path.join(SCRIPT_DIR, "build-manifest.json")
DEPLOY_BUILD_SCRIPT = os.path.join(SCRIPT_DIR, "deploy-build.sh")
HERMES_BLUEPRINT_RESOLVER_SCRIPT = os.path.join(
    SCRIPT_DIR, "helpers", "resolve-hermes-backend-blueprint-id.py"
)
TEST_ENVD_SCRIPT = os.path.join(SCRIPT_DIR, "tests", "test-envd-agent.sh")
TEST_ONBOARD_SCRIPT = os.path.join(SCRIPT_DIR, "tests", "test-onboard.sh")
TEST_RUNTIME_SCRIPT = os.path.join(SCRIPT_DIR, "tests", "test-runtime.sh")
TEST_HERMES_RUNTIME_SCRIPT = os.path.join(SCRIPT_DIR, "tests", "test-hermes-runtime.sh")
TEST_WEIXIN_LOGIN_PROTOCOL_SCRIPT = os.path.join(
    SCRIPT_DIR, "tests", "test-weixin-login-protocol.sh"
)
LOCAL_IMAGE_METADATA_DIR = os.path.join(SCRIPT_DIR, "out")
LOCAL_IMAGE_METADATA_JSON = os.path.join(
    LOCAL_IMAGE_METADATA_DIR, "latest-image-build.json"
)
LOCAL_IMAGE_VERSION_TXT = os.path.join(
    LOCAL_IMAGE_METADATA_DIR, "latest-image-version.txt"
)
REMOTE_IMAGE_METADATA_DIR = "/etc/lightclaw"
REMOTE_IMAGE_METADATA_JSON = f"{REMOTE_IMAGE_METADATA_DIR}/image-build.json"
REMOTE_IMAGE_VERSION_TXT = f"{REMOTE_IMAGE_METADATA_DIR}/image-version"
IMAGE_INVENTORY_DOC = os.path.join(
    ROOT_DIR, "docs", "developer-guide", "sandbox-image-version-inventory.md"
)
AUTO_LATEST_START = "<!-- AUTO-LATEST-START -->"
AUTO_LATEST_END = "<!-- AUTO-LATEST-END -->"
DEFAULT_REMOTE_BUILD_DIR = "/opt/lightclaw-image"
SAFE_IDENTIFIER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]*$")


def validate_command_args(cmd, context):
    if not isinstance(cmd, list):
        raise TypeError(f"{context} command must be an argv list")
    if not cmd:
        raise ValueError(f"{context} command must not be empty")
    normalized = []
    for arg in cmd:
        if not isinstance(arg, str):
            raise TypeError(f"{context} argument must be str")
        if not arg:
            raise ValueError(f"{context} argument must not be empty")
        if "\x00" in arg:
            raise ValueError(f"{context} argument must not contain NUL")
        normalized.append(arg)
    return normalized


def load_build_manifest():
    if not os.path.exists(MANIFEST_PATH):
        raise FileNotFoundError(f"build manifest not found: {MANIFEST_PATH}")
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        loaded = json.load(f)

    required = {
        "base_image": ("image_id", "source_region", "target_region"),
        "runtime": (
            "node_version",
            "pnpm_version",
            "openclaw_version",
            "qqbot_version",
            "weixin_version",
            "python_venv_path",
            "playwright_version",
            "playwright_browsers_path",
            "gateway_port",
        ),
        "artifacts": ("node_tarball_url", "npm_registry", "skillhub_install_url"),
    }
    for section, keys in required.items():
        values = loaded.get(section)
        if not isinstance(values, dict):
            raise ValueError(f"build manifest section must be an object: {section}")
        for key in keys:
            if key not in values:
                raise ValueError(f"missing build manifest key: {section}.{key}")
    return loaded


BUILD_MANIFEST = load_build_manifest()
DEFAULT_INSTANCE_ID = "ins-mqekt5jt"
DEFAULT_SOURCE_REGION = BUILD_MANIFEST["base_image"]["source_region"]
DEFAULT_TARGET_REGION = BUILD_MANIFEST["base_image"]["target_region"]
DEFAULT_TARGET_REGIONS = BUILD_MANIFEST["base_image"].get("target_regions") or [DEFAULT_TARGET_REGION]
DEFAULT_RUNTIME_USER = os.environ.get("LIGHTCLAW_RUNTIME_USER", "lightclaw")
DEFAULT_SSH_HOST = "ubuntu@119.28.239.108"
DEFAULT_SSH_PORT = "22"
DEFAULT_BASE_IMAGE_ID = BUILD_MANIFEST["base_image"]["image_id"]
DEFAULT_SSH_KEY_ID = "skey-am4j0f3v"
DEFAULT_OPENCLAW_VERSION = BUILD_MANIFEST["runtime"]["openclaw_version"]
DEFAULT_QQBOT_VERSION = BUILD_MANIFEST["runtime"].get("qqbot_version", "1.6.6")
DEFAULT_WEIXIN_VERSION = BUILD_MANIFEST["runtime"].get("weixin_version", "2.1.1")
DEFAULT_HERMES_RUNTIME_USER = BUILD_MANIFEST.get("runtime_hermes", {}).get("runtime_user", "agentuser")
DEFAULT_HERMES_NODE_MAJOR = str(BUILD_MANIFEST.get("runtime_hermes", {}).get("node_major", "22"))
DEFAULT_HERMES_QWEN_CODE_VERSION = BUILD_MANIFEST.get("runtime_hermes", {}).get("qwen_code_version", "latest")
DEFAULT_HERMES_VERSION = BUILD_MANIFEST.get("runtime_hermes", {}).get("version", "")
DEFAULT_HERMES_SRC_VERSION = BUILD_MANIFEST.get("runtime_hermes", {}).get("src_version", "")
DEFAULT_HERMES_GIT_COMMIT = BUILD_MANIFEST.get("runtime_hermes", {}).get("git_commit", "")
RESOLVED_HERMES_BACKEND_BLUEPRINT_ID = None
BOOTSTRAP_SSH_USERS = ("ubuntu",)
VERSION_QUERY_TIMEOUT = 15

# 轮询配置
POLL_INTERVAL_INSTANCE = 15       # 重装后轮询实例状态间隔 (秒)
POLL_TIMEOUT_INSTANCE = 600       # 重装最长等待 (秒)
POLL_INTERVAL_SSH = 10            # SSH 就绪轮询间隔 (秒)
POLL_TIMEOUT_SSH = 300            # SSH 最长等待 (秒)
POLL_TIMEOUT_BOOT_SETTLE = 180    # 重装后等待系统稳定的最长时间 (秒)
POST_RESET_MIN_UPTIME = 60        # 重装后开始构建前要求的最小开机时长 (秒)
POLL_INTERVAL_IMAGE = 15          # 镜像创建/复制轮询间隔 (秒)
POLL_TIMEOUT_IMAGE_CREATE = 1800  # 创建镜像最长等待 (秒)
POLL_TIMEOUT_IMAGE_SYNC = 3600    # 复制镜像最长等待 (秒)
SSH_RETRY_ATTEMPTS = 4
SSH_RETRY_DELAY_SECONDS = 5
TEMP_KEY_NAME_PREFIX = "lcimg"
TCCLI_RETRY_ATTEMPTS = 8
TCCLI_RETRY_DELAY_SECONDS = 5

# 时区
CST = timezone(timedelta(hours=8))


# ============================================================
# 工具函数
# ============================================================
def now_str():
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")


def log(msg):
    print(f"[{now_str()}] {msg}", flush=True)


def log_step(step_num, total, msg):
    print(f"\n{'='*60}", flush=True)
    log(f"Step {step_num}/{total}: {msg}")
    print(f"{'='*60}", flush=True)


def parse_csv_list(value):
    items = []
    if value is None:
        return items
    raw_items = value if isinstance(value, (list, tuple)) else str(value).split(",")
    for item in raw_items:
        text = str(item).strip()
        if text and text not in items:
            items.append(text)
    return items


def format_region_list(regions):
    return ",".join(regions) if regions else "(none)"


def fetch_json(url):
    req = request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "lightclaw-build-image/1.0",
        },
    )
    with request.urlopen(req, timeout=VERSION_QUERY_TIMEOUT) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return json.loads(resp.read().decode(charset))


def fetch_npm_latest_version(package_name, registry_url):
    base = registry_url.rstrip("/")
    encoded_name = parse.quote(package_name, safe="@")
    data = fetch_json(f"{base}/{encoded_name}/latest")
    version = data.get("version")
    if not version:
        raise RuntimeError(f"npm latest version missing for {package_name}")
    return version


def fetch_pypi_latest_version(package_name):
    data = fetch_json(f"https://pypi.org/pypi/{package_name}/json")
    version = data.get("info", {}).get("version")
    if not version:
        raise RuntimeError(f"PyPI latest version missing for {package_name}")
    return version


def fetch_hermes_latest_metadata():
    runtime = BUILD_MANIFEST.get("runtime_hermes") or {}
    cos_base = str(runtime.get("cos_base") or "").rstrip("/")
    if not cos_base:
        raise RuntimeError("runtime_hermes.cos_base is required to resolve Hermes latest metadata")
    data = fetch_json(f"{cos_base}/latest.json")
    version = str(data.get("version") or "").strip()
    src_version = str(data.get("src_version") or "").strip()
    git_commit = str(data.get("git_commit_full") or data.get("git_commit") or "").strip()
    if not version:
        raise RuntimeError("Hermes latest metadata is missing version")
    if not src_version:
        raise RuntimeError("Hermes latest metadata is missing src_version")
    return {
        "version": version,
        "src_version": src_version,
        "git_commit": git_commit,
        "cos_url": str(data.get("cos_url") or "").strip(),
    }


def fetch_node_latest_lts_version():
    releases = fetch_json("https://nodejs.org/dist/index.json")
    for release in releases:
        version = str(release.get("version", ""))
        if release.get("lts") and version.startswith("v"):
            return version[1:]
    raise RuntimeError("node latest LTS version not found")


VERSION_SOURCES = {
    "node": {
        "current": lambda manifest: manifest["runtime"]["node_version"],
        "latest": lambda manifest: fetch_node_latest_lts_version(),
        "channel": "nodejs dist (latest LTS)",
    },
    "pnpm": {
        "current": lambda manifest: manifest["runtime"]["pnpm_version"],
        "latest": lambda manifest: fetch_npm_latest_version("pnpm", manifest["artifacts"]["npm_registry"]),
        "channel": "npm registry",
    },
    "openclaw": {
        "current": lambda manifest: manifest["runtime"]["openclaw_version"],
        "latest": lambda manifest: fetch_npm_latest_version("openclaw", manifest["artifacts"]["npm_registry"]),
        "channel": "npm registry",
    },
    "qqbot": {
        "current": lambda manifest: manifest["runtime"]["qqbot_version"],
        "latest": lambda manifest: fetch_npm_latest_version("@tencent-connect/openclaw-qqbot", manifest["artifacts"]["npm_registry"]),
        "channel": "npm registry",
    },
    "weixin": {
        "current": lambda manifest: manifest["runtime"]["weixin_version"],
        "latest": lambda manifest: fetch_npm_latest_version("@tencent-weixin/openclaw-weixin", manifest["artifacts"]["npm_registry"]),
        "channel": "npm registry",
    },
    "playwright": {
        "current": lambda manifest: manifest["runtime"]["playwright_version"],
        "latest": lambda manifest: fetch_pypi_latest_version("playwright"),
        "channel": "PyPI",
    },
}


def collect_version_status(manifest):
    rows = []
    for component, source in VERSION_SOURCES.items():
        current = str(source["current"](manifest))
        latest = ""
        status = "ok"
        error_msg = ""
        try:
            latest = str(source["latest"](manifest))
        except (RuntimeError, error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            status = "error"
            error_msg = str(exc)
        rows.append(
            {
                "component": component,
                "current": current,
                "latest": latest,
                "up_to_date": bool(latest) and current == latest,
                "status": status,
                "source": source["channel"],
                "error": error_msg,
            }
        )
    return rows


def print_version_report(manifest, output_format):
    rows = collect_version_status(manifest)
    payload = {
        "manifest_path": MANIFEST_PATH,
        "npm_registry": manifest["artifacts"]["npm_registry"],
        "generated_at": iso_timestamp(),
        "versions": rows,
    }
    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    print(f"Manifest: {MANIFEST_PATH}")
    print(f"NPM Registry: {manifest['artifacts']['npm_registry']}")
    print(f"Generated At: {payload['generated_at']}")
    print("")
    print(f"{'Component':<12} {'Pinned':<16} {'Latest':<16} {'Status':<12} Source")
    print("-" * 78)
    for row in rows:
        if row["status"] == "error":
            latest = "-"
            status_label = "error"
        elif row["up_to_date"]:
            latest = row["latest"]
            status_label = "up-to-date"
        else:
            latest = row["latest"]
            status_label = "update"
        print(
            f"{row['component']:<12} {row['current']:<16} {latest:<16} "
            f"{status_label:<12} {row['source']}"
        )
        if row["error"]:
            print(f"  error: {row['error']}")


def is_transient_tccli_failure(stdout_text, stderr_text):
    combined = f"{stdout_text or ''}\n{stderr_text or ''}".lower()
    patterns = (
        "clientnetworkerror",
        "max retries exceeded",
        "failed to resolve",
        "nameresolutionerror",
        "httpsconnection(",
        "httpsconnectionpool(",
        "ssl eof",
        "unexpected_eof_while_reading",
        "eof occurred in violation of protocol",
        "connection reset by peer",
        "temporarily unavailable",
        "i/o timeout",
        "service unavailable",
    )
    return any(pattern in combined for pattern in patterns)


def run_tccli(service, action, region, extra_args=None):
    """调用 tccli 并返回解析后的 JSON。"""
    for label, value in (("service", service), ("action", action), ("region", region)):
        if not SAFE_IDENTIFIER_RE.fullmatch(str(value)):
            raise ValueError(f"invalid tccli {label}: {value}")
    cmd = ["tccli", service, action, "--region", region]
    if extra_args:
        cmd.extend(extra_args)
    cmd = validate_command_args(cmd, "tccli")
    attempt = 1
    while True:
        result = subprocess.run(  # nosemgrep: dangerous-subprocess-use-audit
            cmd,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            break
        if (
            attempt < TCCLI_RETRY_ATTEMPTS
            and is_transient_tccli_failure(result.stdout, result.stderr)
        ):
            log(
                f"tccli {service} {action} transient failure "
                f"(attempt {attempt}/{TCCLI_RETRY_ATTEMPTS}), "
                f"retrying in {TCCLI_RETRY_DELAY_SECONDS}s"
            )
            time.sleep(TCCLI_RETRY_DELAY_SECONDS)
            attempt += 1
            continue
        raise RuntimeError(
            f"tccli {service} {action} failed (exit {result.returncode}):\n"
            f"  stdout: {result.stdout.strip()}\n"
            f"  stderr: {result.stderr.strip()}"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        # 有些命令不返回 JSON body
        return {"raw": result.stdout.strip()}


def run_cmd(cmd, check=True, timeout=None, input_text=None):
    """运行本地命令，打印输出。"""
    cmd = validate_command_args(cmd, "local command")
    log(f"  $ {' '.join(cmd)}")
    result = subprocess.run(  # nosemgrep: dangerous-subprocess-use-audit
        cmd,
        shell=False,
        capture_output=False, text=True,
        timeout=timeout,
        input=input_text,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed (exit {result.returncode}): {cmd}")
    return result


def build_ssh_cmd(ssh_host, ssh_port, remote_cmd, extra_opts=None):
    cmd = [
        "ssh",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "BatchMode=yes",
    ]
    if extra_opts:
        cmd.extend(extra_opts)
    cmd.extend(["-p", str(ssh_port), ssh_host, remote_cmd])
    return cmd


def is_ssh_transport_failure(returncode, stderr_text):
    if returncode == 255:
        return True
    stderr = (stderr_text or "").lower()
    patterns = (
        "connection closed by remote host",
        "connection reset by peer",
        "broken pipe",
        "kex_exchange_identification",
        "operation timed out",
        "connection timed out",
    )
    return any(pattern in stderr for pattern in patterns)


def run_ssh_command(
    ssh_host,
    ssh_port,
    remote_cmd,
    *,
    input_text=None,
    check=True,
    capture_output=False,
    timeout=None,
    extra_opts=None,
    log_stdout=True,
    log_stderr=True,
    retry_policy="never",
):
    identity_file = os.environ.get("LIGHTCLAW_SSH_IDENTITY_FILE", "").strip()
    cmd = build_ssh_cmd(ssh_host, ssh_port, remote_cmd, extra_opts=extra_opts)
    if identity_file:
        cmd[1:1] = ["-i", identity_file]
    attempt = 1
    max_attempts = SSH_RETRY_ATTEMPTS if retry_policy == "transport_safe" else 1
    while True:
        log(f"  $ {' '.join(cmd)}")
        result = subprocess.run(
            cmd,
            capture_output=capture_output,
            text=True,
            timeout=timeout,
            input=input_text,
        )
        if capture_output:
            if log_stdout and result.stdout:
                print(result.stdout, end="", flush=True)
            if log_stderr and result.stderr:
                print(result.stderr, end="", file=sys.stderr, flush=True)
        if not check or result.returncode == 0:
            return result
        if (
            retry_policy == "transport_safe"
            and attempt < max_attempts
            and is_ssh_transport_failure(result.returncode, result.stderr)
        ):
            log(
                f"ssh transport failed (attempt {attempt}/{max_attempts}), "
                f"retrying in {SSH_RETRY_DELAY_SECONDS}s"
            )
            time.sleep(SSH_RETRY_DELAY_SECONDS)
            attempt += 1
            continue
        raise RuntimeError(
            f"ssh command failed (exit {result.returncode}): {remote_cmd}"
        )


def shell_join(args):
    return " ".join(shlex.quote(str(arg)) for arg in args)


def remote_bash_lc(command):
    return f"bash -lc {shlex.quote(command)}"


def read_remote_text_file(ssh_host, ssh_port, remote_path):
    result = run_ssh_command(
        ssh_host,
        ssh_port,
        remote_bash_lc(
            f"if [ -f {shlex.quote(remote_path)} ]; then cat {shlex.quote(remote_path)}; fi"
        ),
        check=False,
        capture_output=True,
        log_stdout=False,
        log_stderr=False,
        retry_policy="transport_safe",
    )
    if result.returncode != 0:
        return ""
    return result.stdout


def read_remote_log_tail(ssh_host, ssh_port, remote_path, lines=80):
    result = run_ssh_command(
        ssh_host,
        ssh_port,
        remote_bash_lc(
            f"if [ -f {shlex.quote(remote_path)} ]; then tail -n {int(lines)} {shlex.quote(remote_path)}; fi"
        ),
        check=False,
        capture_output=True,
        log_stdout=False,
        log_stderr=False,
        retry_policy="transport_safe",
    )
    if result.returncode != 0:
        return ""
    return result.stdout


def inspect_remote_build_launch(ssh_host, ssh_port, status_file, stdout_file, stderr_file, phase_file):
    raw_status = read_remote_text_file(ssh_host, ssh_port, status_file).strip()
    payload = None
    if raw_status:
        try:
            payload = json.loads(raw_status)
        except json.JSONDecodeError:
            payload = None
        if payload and payload.get("state") in ("starting", "running", "succeeded", "failed"):
            return {
                "observed": True,
                "via": "status",
                "payload": payload,
                "raw_status": raw_status,
            }

    probe_cmd = remote_bash_lc(
        "artifact_seen=0; "
        f"[ -f {shlex.quote(status_file)} ] && artifact_seen=1; "
        f"[ -f {shlex.quote(stdout_file)} ] && artifact_seen=1; "
        f"[ -f {shlex.quote(stderr_file)} ] && artifact_seen=1; "
        f"[ -f {shlex.quote(phase_file)} ] && artifact_seen=1; "
        "if [ \"$artifact_seen\" -eq 1 ]; then echo artifacts; fi; "
        "ps -ef | awk -v needle="
        + shlex.quote(status_file)
        + " 'index($0, needle) > 0 && index($0, \"remote-build-runner.sh\") > 0 {found=1} END {if (found) print \"process\"}'"
    )
    result = run_ssh_command(
        ssh_host,
        ssh_port,
        probe_cmd,
        check=False,
        capture_output=True,
        log_stdout=False,
        log_stderr=False,
        retry_policy="transport_safe",
    )
    observed = set(result.stdout.strip().splitlines()) if result.returncode == 0 else set()
    return {
        "observed": bool(observed),
        "via": ",".join(sorted(observed)) if observed else "",
        "payload": None,
        "raw_status": raw_status,
    }


def ensure_remote_build_assets(ssh_host, ssh_port, remote_dir):
    cmd = [
        "bash",
        DEPLOY_BUILD_SCRIPT,
        ssh_host,
        "--port",
        str(ssh_port),
        "--remote-dir",
        remote_dir,
        "--upload-only",
    ]
    log(f"上传远端构建资产: {' '.join(cmd)}")
    run_cmd(cmd, timeout=1800)


def resolve_hermes_backend_blueprint_id():
    global RESOLVED_HERMES_BACKEND_BLUEPRINT_ID
    if RESOLVED_HERMES_BACKEND_BLUEPRINT_ID:
        return RESOLVED_HERMES_BACKEND_BLUEPRINT_ID

    env_id = os.environ.get("HERMES_BACKEND_BLUEPRINT_ID", "").strip()
    if env_id:
        if not re.match(r"^lhbp-[A-Za-z0-9_-]+$", env_id):
            raise RuntimeError(f"invalid HERMES_BACKEND_BLUEPRINT_ID: {env_id}")
        RESOLVED_HERMES_BACKEND_BLUEPRINT_ID = env_id
        log(f"Hermes backend blueprint: using explicit HERMES_BACKEND_BLUEPRINT_ID={env_id}")
        return env_id

    cmd = [sys.executable, HERMES_BLUEPRINT_RESOLVER_SCRIPT]
    log("解析最新非南京 Hermes backend blueprint")
    result = subprocess.run(  # nosemgrep: dangerous-subprocess-use-audit
        validate_command_args(cmd, "Hermes blueprint resolver"),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.stderr.strip():
        for line in result.stderr.strip().splitlines():
            log(line)
    if result.returncode != 0:
        raise RuntimeError(
            "Hermes backend blueprint resolver failed "
            f"(exit {result.returncode}): {result.stderr.strip() or result.stdout.strip()}"
        )
    blueprint_id = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""
    if not re.match(r"^lhbp-[A-Za-z0-9_-]+$", blueprint_id):
        raise RuntimeError(f"invalid Hermes backend blueprint id resolved: {blueprint_id or '<empty>'}")
    RESOLVED_HERMES_BACKEND_BLUEPRINT_ID = blueprint_id
    log(f"Hermes backend blueprint: {blueprint_id}")
    return blueprint_id


def start_remote_build_job(
    ssh_host,
    ssh_port,
    remote_dir,
    run_id,
    build_args,
    runtime_user,
    hermes_backend_blueprint_id=None,
):
    ssh_user, _ = split_ssh_host(ssh_host)
    status_file = f"{remote_dir}/.build-status-{run_id}.json"
    stdout_file = f"{remote_dir}/.build-stdout-{run_id}.log"
    stderr_file = f"{remote_dir}/.build-stderr-{run_id}.log"
    phase_file = f"{remote_dir}/.build-phase-{run_id}.txt"

    runner_cmd = [
        "bash",
        "./remote-build-runner.sh",
        "--workdir",
        remote_dir,
        "--status-file",
        status_file,
        "--stdout-file",
        stdout_file,
        "--stderr-file",
        stderr_file,
        "--phase-file",
        phase_file,
        "--",
        "env",
        f"LIGHTCLAW_RUNTIME_USER={runtime_user}",
    ]
    if hermes_backend_blueprint_id:
        runner_cmd.append(f"HERMES_BACKEND_BLUEPRINT_ID={hermes_backend_blueprint_id}")
    runner_cmd.extend(["bash", "./build.sh", *build_args])
    status_stub = json.dumps(
        {
            "state": "starting",
            "workdir": remote_dir,
            "status_file": status_file,
            "stdout_file": stdout_file,
            "stderr_file": stderr_file,
            "phase_file": phase_file,
            "command": runner_cmd[runner_cmd.index("--") + 1 :],
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "phase": "launching",
        },
        ensure_ascii=False,
    )
    remote_shell = (
        f"cd {shlex.quote(remote_dir)} && "
        "chmod +x build.sh remote-build-runner.sh bin/envd runtime/openclaw-weixin-login-session.sh && "
        f"rm -f {shlex.quote(status_file)} {shlex.quote(stdout_file)} {shlex.quote(stderr_file)} {shlex.quote(phase_file)} {shlex.quote(status_file + '.started_at')} && "
        f"printf '%s\\n' {shlex.quote(status_stub)} > {shlex.quote(status_file)} && "
        f"nohup {shell_join(runner_cmd)} >/dev/null 2>&1 </dev/null & "
        "runner_pid=$! && disown \"$runner_pid\" 2>/dev/null || true && echo \"$runner_pid\""
    )
    remote_cmd = remote_bash_lc(remote_shell)
    if ssh_user and ssh_user != "root":
        remote_cmd = f"sudo {remote_cmd}"
    pid = ""
    for launch_attempt in range(1, 3):
        try:
            result = run_ssh_command(
                ssh_host,
                ssh_port,
                remote_cmd,
                capture_output=True,
                timeout=20,
                retry_policy="transport_safe",
            )
            pid = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""
            break
        except subprocess.TimeoutExpired:
            # Some SSH sessions do not return promptly even though nohup runner
            # has already started. Prefer proving that the remote launch exists
            # over sending a duplicate launch request.
            observation = None
            for _ in range(24):
                observation = inspect_remote_build_launch(
                    ssh_host,
                    ssh_port,
                    status_file,
                    stdout_file,
                    stderr_file,
                    phase_file,
                )
                if observation["observed"]:
                    if observation["via"] == "status":
                        log("启动远端构建 runner 的 SSH 调用超时，已通过状态文件确认任务已启动")
                    else:
                        log(
                            "启动远端构建 runner 的 SSH 调用超时，"
                            f"已观测到远端构建痕迹({observation['via']})，继续等待状态文件"
                        )
                    break
                time.sleep(5)
            else:
                observation = {
                    "observed": False,
                    "via": "",
                    "payload": None,
                    "raw_status": "",
                }
            if observation and observation["observed"]:
                break
            if launch_attempt == 1:
                log("启动远端构建 runner 超时且状态文件仍缺失，重试一次启动")
                continue
            raise RuntimeError(
                f"starting remote build runner timed out and status file is missing: {status_file}"
            )
    return {
        "run_id": run_id,
        "status_file": status_file,
        "stdout_file": stdout_file,
        "stderr_file": stderr_file,
        "phase_file": phase_file,
        "pid": pid,
    }


def wait_for_remote_build_job(ssh_host, ssh_port, job, timeout=3600):
    start = time.time()
    last_state = ""
    last_phase = ""
    while True:
        elapsed = time.time() - start
        if elapsed > timeout:
            raise TimeoutError(
                f"remote build job {job['run_id']} did not finish within {timeout}s"
            )

        raw = read_remote_text_file(ssh_host, ssh_port, job["status_file"]).strip()
        if raw:
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = None
            if payload:
                state = payload.get("state", "")
                phase = payload.get("phase", "")
                if phase and phase != last_phase:
                    log(
                        f"远端构建任务阶段: {phase} "
                        f"(run_id={job['run_id']}, pid={job['pid'] or 'unknown'})"
                    )
                    last_phase = phase
                if state != last_state:
                    log(
                        f"远端构建任务状态: {state or 'unknown'} "
                        f"(run_id={job['run_id']}, pid={job['pid'] or 'unknown'})"
                    )
                    last_state = state
                if state == "succeeded":
                    return payload
                if state == "failed":
                    stdout_tail = read_remote_log_tail(
                        ssh_host, ssh_port, job["stdout_file"], lines=80
                    ).strip()
                    stderr_tail = read_remote_log_tail(
                        ssh_host, ssh_port, job["stderr_file"], lines=80
                    ).strip()
                    write_remote_failure_logs_local(
                        job["run_id"], stdout_tail, stderr_tail
                    )
                    if stdout_tail:
                        print(stdout_tail, flush=True)
                    if stderr_tail:
                        print(stderr_tail, file=sys.stderr, flush=True)
                    raise RuntimeError(
                        f"remote build job failed run_id={job['run_id']} "
                        f"exit_code={payload.get('exit_code', 'unknown')}"
                    )

        log(f"等待远端构建任务完成... ({int(elapsed)}s)")
        time.sleep(POLL_INTERVAL_SSH)


def build_timestamp():
    return datetime.now(CST).strftime("%Y%m%d-%H%M%S")


def iso_timestamp():
    return datetime.now(CST).isoformat(timespec="seconds")


def make_image_version(build_mode, runtime_kind="openclaw"):
    mode_label = {
        "base-only": "base",
        "app-only": "app",
        None: "full",
    }.get(build_mode, str(build_mode))
    runtime_label = "hermes" if runtime_kind == "hermes" else "lightclaw"
    return f"{runtime_label}-{mode_label}-{build_timestamp()}"


def write_local_file(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def write_remote_failure_logs_local(run_id, stdout_tail, stderr_tail):
    base = os.path.join(LOCAL_IMAGE_METADATA_DIR, f"remote-build-failure-{run_id}")
    if stdout_tail:
        write_local_file(f"{base}.stdout.log", stdout_tail if stdout_tail.endswith("\n") else stdout_tail + "\n")
    if stderr_tail:
        write_local_file(f"{base}.stderr.log", stderr_tail if stderr_tail.endswith("\n") else stderr_tail + "\n")


def parse_auto_latest_state(doc_text):
    state = {}
    block_text = doc_text
    if AUTO_LATEST_START in doc_text and AUTO_LATEST_END in doc_text:
        match = re.search(
            rf"{re.escape(AUTO_LATEST_START)}(.*?){re.escape(AUTO_LATEST_END)}",
            doc_text,
            re.DOTALL,
        )
        if match:
            block_text = match.group(1)
    patterns = {
        "latest_base_source_image_id": r"当前稳定 `base`（ap-seoul）：`([^`]+)`",
        "latest_app_source_image_id": r"当前最新已构建 app（ap-seoul）：`([^`]+)`",
        "latest_app_target_image_id": r"当前最新已构建 app（ap-beijing）：`([^`]+)`",
    }
    for key, pattern in patterns.items():
        match = re.search(pattern, block_text)
        if match:
            state[key] = match.group(1)
    return state


def build_auto_latest_block(state):
    lines = [
        AUTO_LATEST_START,
        "## 0. 当前最新镜像 ID",
        "",
        "> 本段由 `images/build-image.py` 在成功制镜后自动维护。",
        "",
        f"- 当前稳定 `base`（ap-seoul）：`{state.get('latest_base_source_image_id', '(待记录)')}`",
        f"- 当前最新已构建 app（ap-seoul）：`{state.get('latest_app_source_image_id', '(待记录)')}`",
        f"- 当前最新已构建 app（ap-beijing）：`{state.get('latest_app_target_image_id', '(待记录)')}`",
        (
            f"- 当前默认构建版本：`openclaw {DEFAULT_OPENCLAW_VERSION}` + "
            f"`qqbot {DEFAULT_QQBOT_VERSION}` + `weixin {DEFAULT_WEIXIN_VERSION}`"
        ),
        "- 当前主力池生效镜像请看本文第 2 节，不由构镜脚本自动改写。",
        f"- 最近自动更新时间：`{iso_timestamp()}`",
        AUTO_LATEST_END,
        "",
    ]
    return "\n".join(lines)


def upsert_auto_latest_block(doc_text, state):
    block = build_auto_latest_block(state)
    if AUTO_LATEST_START in doc_text and AUTO_LATEST_END in doc_text:
        pattern = re.compile(
            rf"{re.escape(AUTO_LATEST_START)}.*?{re.escape(AUTO_LATEST_END)}\n?",
            re.DOTALL,
        )
        return pattern.sub(block, doc_text, count=1)

    marker = "## 1. 已构建镜像"
    if marker in doc_text:
        return doc_text.replace(marker, f"{block}{marker}", 1)
    return f"{doc_text.rstrip()}\n\n{block}"


def prepend_markdown_table_row(doc_text, section_heading, row_line, unique_marker=None):
    if row_line in doc_text:
        return doc_text

    lines = doc_text.splitlines()
    heading_index = None
    for idx, line in enumerate(lines):
        if line.strip() == section_heading:
            heading_index = idx
            break
    if heading_index is None:
        return doc_text

    table_header_index = None
    for idx in range(heading_index + 1, len(lines)):
        if lines[idx].startswith("| 日期 |"):
            table_header_index = idx
            break
        if lines[idx].startswith("## ") or lines[idx].startswith("### "):
            return doc_text
    if table_header_index is None or table_header_index + 1 >= len(lines):
        return doc_text

    if unique_marker:
        for idx in range(table_header_index + 2, len(lines)):
            if lines[idx].startswith("## ") or lines[idx].startswith("### "):
                break
            if unique_marker in lines[idx]:
                return doc_text

    insert_index = table_header_index + 2
    lines.insert(insert_index, row_line)
    return "\n".join(lines) + "\n"


def append_image_inventory_rows(doc_text, metadata, build_mode, source_image_id, target_image_id,
                                source_region, target_region):
    if metadata.get("runtime_kind") != "openclaw":
        return doc_text
    date_label = metadata["generated_at"].split("T", 1)[0]
    image_name = metadata["image_name"]
    openclaw_version = metadata["openclaw_version"]
    qqbot_version = metadata.get("qqbot_version") or DEFAULT_QQBOT_VERSION
    weixin_version = metadata.get("weixin_version") or DEFAULT_WEIXIN_VERSION
    verify_label = ",".join(metadata.get("verify_suites") or []) or "none"

    if build_mode == "base-only" and source_image_id:
        row = (
            f"| {date_label} | {source_region} | `{source_image_id}` | `{image_name}` | "
            f"自动记录：由 `build-image.py` 成功构建；verify={verify_label} |"
        )
        return prepend_markdown_table_row(doc_text, "### 基础镜像", row, unique_marker=f"`{source_image_id}`")

    plugin_label = f"`qqbot@{qqbot_version}`, `weixin@{weixin_version}`"
    if source_image_id:
        source_row = (
            f"| {date_label} | {source_region} | `{source_image_id}` | `{image_name}` | "
            f"`{openclaw_version}` | {plugin_label} | "
            f"自动记录：由 `build-image.py` 成功构建；verify={verify_label} |"
        )
        doc_text = prepend_markdown_table_row(
            doc_text, "### 应用镜像", source_row, unique_marker=f"`{source_image_id}`"
        )
    if target_image_id:
        target_row = (
            f"| {date_label} | {target_region} | `{target_image_id}` | `{image_name}` | "
            f"`{openclaw_version}` | {plugin_label} | "
            f"自动记录：由 `build-image.py` 同步到 {target_region}；source=`{source_image_id}` |"
        )
        doc_text = prepend_markdown_table_row(
            doc_text, "### 应用镜像", target_row, unique_marker=f"`{target_image_id}`"
        )
    return doc_text


def update_image_inventory_doc(metadata, build_mode, source_image_id, target_image_id,
                               source_region, target_region):
    if metadata.get("runtime_kind") != "openclaw":
        log("runtime=hermes，跳过 OpenClaw 镜像台账自动更新")
        return
    if not os.path.exists(IMAGE_INVENTORY_DOC):
        log(f"镜像台账文档不存在，跳过自动更新: {IMAGE_INVENTORY_DOC}")
        return

    with open(IMAGE_INVENTORY_DOC, "r", encoding="utf-8") as f:
        doc_text = f.read()

    state = parse_auto_latest_state(doc_text)
    if build_mode == "base-only" and source_image_id:
        state["latest_base_source_image_id"] = source_image_id
    elif source_image_id:
        state["latest_app_source_image_id"] = source_image_id
        if target_image_id:
            state["latest_app_target_image_id"] = target_image_id

    updated = upsert_auto_latest_block(doc_text, state)
    updated = append_image_inventory_rows(
        updated, metadata, build_mode, source_image_id, target_image_id,
        source_region, target_region,
    )

    if updated != doc_text:
        with open(IMAGE_INVENTORY_DOC, "w", encoding="utf-8") as f:
            f.write(updated)
        log(f"已自动更新镜像台账文档: {IMAGE_INVENTORY_DOC}")


def write_remote_file_via_ssh(ssh_host, ssh_port, remote_path, content):
    remote_dir = os.path.dirname(remote_path)
    ssh_user, _ = split_ssh_host(ssh_host)
    remote_shell = (
        f"umask 022 && mkdir -p {json.dumps(remote_dir)} "
        f"&& cat > {json.dumps(remote_path)}"
    )
    remote_cmd = f"bash -lc {json.dumps(remote_shell)}"
    if ssh_user and ssh_user != "root":
        remote_cmd = f"sudo {remote_cmd}"
    run_ssh_command(
        ssh_host,
        ssh_port,
        remote_cmd,
        input_text=content,
        capture_output=False,
        retry_policy="transport_safe",
    )


def run_remote_shell_via_ssh(ssh_host, ssh_port, remote_shell, check=True):
    """通过 SSH 执行远端 shell，并返回 subprocess 结果。"""
    ssh_user, _ = split_ssh_host(ssh_host)
    remote_cmd = "bash -s --"
    if ssh_user and ssh_user != "root":
        remote_cmd = f"sudo {remote_cmd}"
    return run_ssh_command(
        ssh_host,
        ssh_port,
        remote_cmd,
        input_text=remote_shell,
        check=check,
        capture_output=True,
        retry_policy="never",
    )


def build_image_metadata(args, image_name, image_version, build_mode, verify_suites):
    target_regions = getattr(args, "target_regions", None) or [args.target_region]
    return {
        "image_version": image_version,
        "generated_at": iso_timestamp(),
        "image_name": image_name,
        "build_mode": build_mode or "full",
        "runtime_kind": args.runtime,
        "instance_id": args.instance_id,
        "source_region": args.source_region,
        "target_region": args.target_region,
        "target_regions": target_regions,
        "base_image_id": args.base_image_id,
        "openclaw_version": args.openclaw_version,
        "with_verify": args.with_verify,
        "verify_suites": verify_suites,
        "only_plugins": args.only_plugins,
        "qqbot_version": args.qqbot_version,
        "weixin_version": args.weixin_version,
        "hermes_runtime_user": args.runtime_user if args.runtime == "hermes" else "",
        "hermes_node_major": DEFAULT_HERMES_NODE_MAJOR if args.runtime == "hermes" else "",
        "hermes_version": args.hermes_version if args.runtime == "hermes" else "",
        "hermes_src_version": args.hermes_src_version if args.runtime == "hermes" else "",
        "hermes_git_commit": DEFAULT_HERMES_GIT_COMMIT if args.runtime == "hermes" else "",
        "hermes_qwen_code_version": DEFAULT_HERMES_QWEN_CODE_VERSION if args.runtime == "hermes" else "",
        "skills_mode": args.skills,
        "custom_skills": args.custom_skills,
        "runtime_user": args.runtime_user,
    }


def split_ssh_host(ssh_host):
    if "@" in ssh_host:
        return ssh_host.split("@", 1)
    return "", ssh_host


def candidate_ssh_hosts(preferred_host, include_bootstrap_users=True):
    user, host = split_ssh_host(preferred_host)
    candidates = []
    if user:
        candidates.append(f"{user}@{host}")
    else:
        candidates.append(host)

    if include_bootstrap_users:
        for bootstrap_user in BOOTSTRAP_SSH_USERS:
            candidate = f"{bootstrap_user}@{host}"
            if candidate not in candidates:
                candidates.append(candidate)
    return candidates


def wait_for_ssh_ready(
    preferred_host,
    preferred_port,
    include_bootstrap_users=True,
    timeout=POLL_TIMEOUT_SSH,
):
    candidate_ports = []
    for port in (preferred_port, "22"):
        port = str(port)
        if port not in candidate_ports:
            candidate_ports.append(port)

    candidate_hosts = candidate_ssh_hosts(
        preferred_host, include_bootstrap_users=include_bootstrap_users
    )
    host_part = split_ssh_host(preferred_host)[1]

    log(
        f"等待 SSH 就绪 (候选主机: {', '.join(candidate_hosts)}, "
        f"端口: {', '.join(candidate_ports)}, 超时 {timeout}s)..."
    )
    start = time.time()
    while True:
        elapsed = time.time() - start
        if elapsed > timeout:
            raise TimeoutError(f"SSH 在 {timeout}s 内未就绪")

        for candidate_port in candidate_ports:
            subprocess.run(  # nosemgrep: dangerous-subprocess-use-audit
                validate_command_args(["ssh-keygen", "-R", f"[{host_part}]:{candidate_port}"], "ssh-keygen"),
                capture_output=True, timeout=5,
            )
        subprocess.run(  # nosemgrep: dangerous-subprocess-use-audit
            validate_command_args(["ssh-keygen", "-R", host_part], "ssh-keygen"),
            capture_output=True, timeout=5,
        )

        for candidate_host in candidate_hosts:
            for candidate_port in candidate_ports:
                ret = run_ssh_command(
                    candidate_host,
                    candidate_port,
                    "echo ok",
                    check=False,
                    capture_output=True,
                    timeout=15,
                    extra_opts=["-o", "ConnectTimeout=5"],
                    log_stdout=False,
                    log_stderr=False,
                    retry_policy="transport_safe",
                )
                if ret.returncode == 0 and "ok" in ret.stdout:
                    log(
                        f"SSH 已就绪: {candidate_host}:{candidate_port} "
                        f"({int(elapsed)}s)"
                    )
                    return candidate_host, str(candidate_port)
        log(f"  SSH 未就绪, 重试中... ({int(elapsed)}s)")
        time.sleep(POLL_INTERVAL_SSH)


def step_wait_for_preferred_ssh(ssh_host, ssh_port, dry_run=False):
    if dry_run:
        log("[DRY-RUN] 跳过 SSH 重新探测")
        return ssh_host, str(ssh_port)
    return wait_for_ssh_ready(
        ssh_host,
        ssh_port,
        include_bootstrap_users=True,
        timeout=POLL_TIMEOUT_SSH,
    )


def wait_for_boot_settle(ssh_host, ssh_port, min_uptime=POST_RESET_MIN_UPTIME,
                         timeout=POLL_TIMEOUT_BOOT_SETTLE, dry_run=False):
    """重装后等待系统达到基本稳定状态，避免过早开始大文件上传。"""
    log(
        f"等待实例启动稳定 (最小 uptime {min_uptime}s, 超时 {timeout}s)..."
    )
    if dry_run:
        log("[DRY-RUN] 跳过实例启动稳定等待")
        return

    start = time.time()
    remote_shell = """\
set -euo pipefail
uptime_s="$(cut -d. -f1 /proc/uptime)"
state="$(systemctl is-system-running 2>/dev/null || true)"
printf '%s\t%s\n' "${uptime_s}" "${state}"
"""
    while True:
        elapsed = time.time() - start
        if elapsed > timeout:
            raise TimeoutError(
                f"实例在 {timeout}s 内未达到稳定状态 (要求 uptime >= {min_uptime}s)"
            )
        result = run_remote_shell_via_ssh(
            ssh_host, ssh_port, remote_shell, check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            parts = result.stdout.strip().split("\t", 1)
            uptime_s = int(parts[0]) if parts and parts[0].isdigit() else 0
            system_state = parts[1].strip() if len(parts) > 1 else ""
            log(
                f"  实例 uptime: {uptime_s}s, "
                f"systemd: {system_state or 'unknown'} ({int(elapsed)}s)"
            )
            if uptime_s >= min_uptime and system_state in ("running", "degraded"):
                log("实例已通过启动稳定检查")
                return
        else:
            log(
                f"  启动稳定检查失败, 将重试... "
                f"({int(elapsed)}s)"
            )
        time.sleep(POLL_INTERVAL_SSH)


# ============================================================
# 步骤实现
# ============================================================

def step_reset_instance(instance_id, region, base_image_id, ssh_host, ssh_port,
                        ssh_key_id=None, dry_run=False):
    """Step 1: 重装系统并等待实例就绪。返回可用 SSH 目标和端口。"""

    # 1a. 调用 ResetInstance
    log(f"重装实例 {instance_id} (镜像 {base_image_id})...")
    if dry_run:
        log(f"[DRY-RUN] 跳过 ResetInstance 调用 (密钥: {ssh_key_id or '无'})")
    else:
        reset_args = [
            "--InstanceId", instance_id,
            "--ImageId", base_image_id,
        ]
        if ssh_key_id:
            reset_args.extend([
                "--LoginSettings", json.dumps({"KeyIds": [ssh_key_id]}),
            ])
            log(f"绑定 SSH 密钥: {ssh_key_id}")
        resp = run_tccli("cvm", "ResetInstance", region, reset_args)
        log(f"ResetInstance 请求已发送: RequestId={resp.get('RequestId', 'N/A')}")

    # 1b. 等待实例状态变为 RUNNING
    log(f"等待实例恢复 RUNNING 状态 (超时 {POLL_TIMEOUT_INSTANCE}s)...")
    if dry_run:
        log("[DRY-RUN] 跳过实例状态轮询")
        return ssh_host, str(ssh_port)

    start = time.time()
    while True:
        elapsed = time.time() - start
        if elapsed > POLL_TIMEOUT_INSTANCE:
            raise TimeoutError(
                f"实例 {instance_id} 在 {POLL_TIMEOUT_INSTANCE}s 内未恢复 RUNNING"
            )
        try:
            resp = run_tccli("cvm", "DescribeInstances", region, [
                "--InstanceIds", json.dumps([instance_id]),
            ])
            if resp["TotalCount"] > 0:
                state = resp["InstanceSet"][0]["InstanceState"]
                op_state = resp["InstanceSet"][0].get("LatestOperationState", "")
                log(f"  实例状态: {state}, 操作状态: {op_state} ({int(elapsed)}s)")
                if state == "RUNNING" and op_state == "SUCCESS":
                    log("实例已恢复 RUNNING")
                    break
        except Exception as e:
            log(f"  查询异常 (将重试): {e}")
        time.sleep(POLL_INTERVAL_INSTANCE)

    ready_ssh_host, ready_ssh_port = wait_for_ssh_ready(
        ssh_host,
        ssh_port,
        include_bootstrap_users=True,
        timeout=POLL_TIMEOUT_SSH,
    )
    wait_for_boot_settle(
        ready_ssh_host,
        ready_ssh_port,
        dry_run=dry_run,
    )
    return ready_ssh_host, ready_ssh_port


def describe_single_instance(region, instance_id):
    resp = run_tccli("cvm", "DescribeInstances", region, [
        "--InstanceIds", json.dumps([instance_id]),
    ])
    if resp.get("TotalCount", 0) < 1 or not resp.get("InstanceSet"):
        raise RuntimeError(f"实例不存在: {instance_id}")
    return resp["InstanceSet"][0]


def create_temp_ssh_keypair_local(dry_run=False):
    key_name = f"{TEMP_KEY_NAME_PREFIX}{datetime.now(CST).strftime('%m%d%H%M%S')}"
    if dry_run:
        return {
            "key_name": key_name,
            "private_key_path": "/tmp/lightclaw-build-image-dry-run",
            "public_key_text": "ssh-rsa DRY_RUN",
        }

    key_dir = tempfile.mkdtemp(prefix="lightclaw-build-image-key-")
    private_key_path = os.path.join(key_dir, "id_rsa")
    run_cmd([
        "ssh-keygen",
        "-q",
        "-t",
        "rsa",
        "-b",
        "2048",
        "-N",
        "",
        "-f",
        private_key_path,
    ])
    with open(f"{private_key_path}.pub", "r", encoding="utf-8") as f:
        public_key_text = f.read().strip()
    return {
        "key_name": key_name,
        "private_key_path": private_key_path,
        "public_key_text": public_key_text,
    }


def import_temp_keypair(region, key_name, public_key_text, dry_run=False):
    log(f"导入临时密钥对: {key_name}")
    if dry_run:
        return f"skey-dry-run-{key_name}"
    resp = run_tccli("cvm", "ImportKeyPair", region, [
        "--KeyName", key_name,
        "--ProjectId", "0",
        "--PublicKey", public_key_text,
    ])
    key_id = resp.get("KeyId")
    if not key_id:
        raise RuntimeError(f"ImportKeyPair 未返回 KeyId: {resp}")
    return key_id


def delete_keypair(region, key_id, dry_run=False):
    if not key_id:
        return
    log(f"删除临时密钥对: {key_id}")
    if dry_run:
        return
    start = time.time()
    while True:
        try:
            resp = run_tccli("cvm", "DescribeKeyPairs", region, [
                "--KeyIds", json.dumps([key_id]),
            ])
        except RuntimeError:
            resp = {}

        keypairs = resp.get("KeyPairSet") or []
        if not keypairs:
            return

        associated = keypairs[0].get("AssociatedInstanceIds") or []
        if not associated:
            break

        elapsed = time.time() - start
        if elapsed > POLL_TIMEOUT_INSTANCE:
            raise TimeoutError(
                f"临时密钥对 {key_id} 在 {POLL_TIMEOUT_INSTANCE}s 内仍被实例引用: {associated}"
            )
        log(f"  密钥对仍被实例引用，等待实例解绑后重试删除: {associated} ({int(elapsed)}s)")
        time.sleep(POLL_INTERVAL_INSTANCE)

    run_tccli("cvm", "DeleteKeyPairs", region, [
        "--KeyIds", json.dumps([key_id]),
    ])


def step_create_build_instance(template_instance_id, region, base_image_id, ssh_key_id, dry_run=False):
    template = describe_single_instance(region, template_instance_id)
    zone = template.get("Placement", {}).get("Zone")
    vpc = template.get("VirtualPrivateCloud", {}).get("VpcId")
    subnet = template.get("VirtualPrivateCloud", {}).get("SubnetId")
    instance_type = template.get("InstanceType")
    security_groups = template.get("SecurityGroupIds") or []
    internet = template.get("InternetAccessible") or {}
    bandwidth = internet.get("InternetMaxBandwidthOut") or 10
    internet_charge_type = internet.get("InternetChargeType") or "TRAFFIC_POSTPAID_BY_HOUR"
    image_name = f"lightclaw-image-build-{build_timestamp()}"

    if not zone or not vpc or not subnet or not instance_type:
        raise RuntimeError(f"模板实例缺少必要网络或规格信息: {template_instance_id}")

    log(f"创建临时构建机 (模板={template_instance_id}, 镜像={base_image_id}, 类型={instance_type}, zone={zone})...")
    if dry_run:
        return f"ins-dry-run-{build_timestamp()}", "ubuntu@119.28.239.108", "22"

    args = [
        "--InstanceChargeType", "POSTPAID_BY_HOUR",
        "--InstanceCount", "1",
        "--Placement", json.dumps({"Zone": zone}),
        "--InstanceType", instance_type,
        "--ImageId", base_image_id,
        "--VirtualPrivateCloud", json.dumps({"VpcId": vpc, "SubnetId": subnet}),
        "--InternetAccessible", json.dumps({
            "PublicIpAssigned": True,
            "InternetChargeType": internet_charge_type,
            "InternetMaxBandwidthOut": int(bandwidth),
        }),
        "--LoginSettings", json.dumps({"KeyIds": [ssh_key_id]}),
        "--InstanceName", image_name,
    ]
    if security_groups:
        args.extend(["--SecurityGroupIds", json.dumps(security_groups)])

    resp = run_tccli("cvm", "RunInstances", region, args)
    instance_ids = resp.get("InstanceIdSet") or resp.get("Response", {}).get("InstanceIdSet") or []
    if not instance_ids:
        raise RuntimeError(f"RunInstances 未返回 InstanceIdSet: {resp}")
    instance_id = instance_ids[0]
    log(f"临时构建机创建中: {instance_id}")

    start = time.time()
    while True:
        elapsed = time.time() - start
        if elapsed > POLL_TIMEOUT_INSTANCE:
            raise TimeoutError(f"临时构建机 {instance_id} 在 {POLL_TIMEOUT_INSTANCE}s 内未恢复 RUNNING")
        detail = describe_single_instance(region, instance_id)
        state = detail.get("InstanceState", "")
        op_state = str(detail.get("LatestOperationState", "") or "")
        log(f"  临时构建机状态: {state}, 操作状态: {op_state} ({int(elapsed)}s)")
        if state == "RUNNING" and op_state in ("", "SUCCESS", "None", "NONE"):
            public_ips = detail.get("PublicIpAddresses") or []
            if not public_ips:
                raise RuntimeError(f"临时构建机 {instance_id} 未分配公网 IP")
            return instance_id, f"ubuntu@{public_ips[0]}", "22"
        time.sleep(POLL_INTERVAL_INSTANCE)


def terminate_instance(instance_id, region, dry_run=False):
    if not instance_id:
        return
    log(f"销毁临时构建机: {instance_id}")
    if dry_run:
        return
    run_tccli("cvm", "TerminateInstances", region, [
        "--InstanceIds", json.dumps([instance_id]),
        "--ReleaseAddress", "true",
    ])


def step_deploy_build(ssh_host, ssh_port, openclaw_version=None, build_mode=None,
                      runtime_kind="openclaw",
                      hermes_version=None, hermes_src_version=None,
                      only_plugins=None, qqbot_version=None, weixin_version=None,
                      skills_mode="essential", custom_skills=None,
                      runtime_user=DEFAULT_RUNTIME_USER,
                      remote_dir=DEFAULT_REMOTE_BUILD_DIR,
                      dry_run=False):
    """Step 2: 上传构建资产并在远端启动后台 build runner。

    build_mode: None=全量, 'base-only'=仅基础层, 'app-only'=仅应用层
    only_plugins: 仅安装指定插件（逗号分隔字符串）
    qqbot_version: 指定 qqbot 插件版本
    weixin_version: 指定 weixin 插件版本
    skills_mode: essential | all | custom
    custom_skills: 自定义 skill 列表（逗号分隔字符串）
    """
    build_args = []
    if runtime_kind and runtime_kind != "openclaw":
        build_args.extend(["--runtime", runtime_kind])
    if runtime_kind == "hermes" and hermes_version:
        build_args.extend(["--hermes-version", hermes_version])
    if runtime_kind == "hermes" and hermes_src_version:
        build_args.extend(["--hermes-src-version", hermes_src_version])
    if runtime_kind == "openclaw" and openclaw_version:
        build_args.append(openclaw_version)
    if build_mode == "base-only":
        build_args.append("--base-only")
    elif build_mode == "app-only":
        build_args.append("--app-only")
    if runtime_kind == "openclaw":
        if only_plugins:
            build_args.extend(["--only-plugins", only_plugins])
        if qqbot_version:
            build_args.extend(["--qqbot-version", qqbot_version])
        if weixin_version:
            build_args.extend(["--weixin-version", weixin_version])
        if skills_mode and skills_mode != "essential":
            build_args.extend(["--skills", skills_mode])
        if custom_skills:
            build_args.extend(["--custom-skills", custom_skills])
    hermes_backend_blueprint_id = None
    if runtime_kind == "hermes":
        hermes_backend_blueprint_id = resolve_hermes_backend_blueprint_id()

    run_id = f"{build_timestamp()}-{build_mode or 'full'}"
    log(
        f"准备远端构建任务: run_id={run_id} remote_dir={remote_dir} "
        f"args={shell_join(build_args) if build_args else '(default)'}"
    )
    if dry_run:
        log("[DRY-RUN] 跳过 deploy-build.sh 执行")
        return

    ensure_remote_build_assets(ssh_host, ssh_port, remote_dir)
    job = start_remote_build_job(
        ssh_host,
        ssh_port,
        remote_dir,
        run_id,
        build_args,
        runtime_user,
        hermes_backend_blueprint_id,
    )
    wait_for_remote_build_job(ssh_host, ssh_port, job, timeout=3600)
    log("远端构建任务执行完成")


def step_run_verification(ssh_host, ssh_port, verify_suites, dry_run=False):
    """运行远端自动化验证脚本。

    默认门禁应使用 runtime。
    其中 runtime 专门覆盖非交互 shell 下的 OpenClaw 运行时、配置文件、
    qqbot / weixin 插件安装状态和 gateway user service 可用性。
    envd 当前保留为显式可选套件，用于独立 follow-up 排查，不作为默认制镜 blocker。
    """
    if not verify_suites:
        log("未配置验证套件，跳过验证")
        return

    for suite in verify_suites:
        if suite == "envd":
            cmd = ["bash", TEST_ENVD_SCRIPT, ssh_host, "--port", ssh_port]
        elif suite == "runtime":
            cmd = ["bash", TEST_RUNTIME_SCRIPT, ssh_host, "--port", ssh_port]
        elif suite == "runtime-hermes":
            cmd = ["bash", TEST_HERMES_RUNTIME_SCRIPT, ssh_host, "--port", ssh_port]
        elif suite == "weixin-login":
            cmd = ["bash", TEST_WEIXIN_LOGIN_PROTOCOL_SCRIPT, ssh_host, "--port", ssh_port]
        elif suite == "onboard":
            cmd = ["bash", TEST_ONBOARD_SCRIPT, ssh_host, "--port", ssh_port]
        else:
            raise ValueError(f"未知验证套件: {suite}")

        log(f"执行验证套件 {suite}: {' '.join(cmd)}")
        if dry_run:
            log(f"[DRY-RUN] 跳过验证套件 {suite}")
            continue

        run_cmd(cmd, timeout=3600)
        log(f"验证套件 {suite} 通过")


def step_write_image_version(ssh_host, ssh_port, metadata, dry_run=False):
    """在远端镜像磁盘和本地输出目录写入镜像版本元数据。"""
    image_version = metadata["image_version"]
    metadata_json = json.dumps(metadata, ensure_ascii=False, indent=2) + "\n"

    log(f"写入镜像版本元数据: {image_version}")
    log(f"  远端 JSON: {REMOTE_IMAGE_METADATA_JSON}")
    log(f"  远端版本: {REMOTE_IMAGE_VERSION_TXT}")
    log(f"  本地 JSON: {LOCAL_IMAGE_METADATA_JSON}")
    log(f"  本地版本: {LOCAL_IMAGE_VERSION_TXT}")
    if dry_run:
        log("[DRY-RUN] 跳过镜像版本元数据写入")
        return

    write_remote_file_via_ssh(
        ssh_host, ssh_port, REMOTE_IMAGE_METADATA_JSON, metadata_json,
    )
    write_remote_file_via_ssh(
        ssh_host, ssh_port, REMOTE_IMAGE_VERSION_TXT, f"{image_version}\n",
    )
    write_local_file(LOCAL_IMAGE_METADATA_JSON, metadata_json)
    write_local_file(LOCAL_IMAGE_VERSION_TXT, f"{image_version}\n")
    log("镜像版本元数据写入完成")


def step_prepare_capture(ssh_host, ssh_port, build_mode, gateway_port,
                         runtime_user=DEFAULT_RUNTIME_USER,
                         remote_build_dir=DEFAULT_REMOTE_BUILD_DIR, dry_run=False):
    """制镜前刷新关键文件到磁盘，并确保 app 镜像的 gateway unit 没有损坏。"""
    log("制镜前预检: 校验 gateway unit 并执行刷盘")
    if dry_run:
        log("[DRY-RUN] 跳过制镜前预检")
        return

    build_mode_label = build_mode or "full"
    remote_shell = f"""\
set -euo pipefail
runtime_user={json.dumps(runtime_user)}
runtime_home="$(getent passwd "${{runtime_user}}" | cut -d: -f6)"
if [ -z "${{runtime_home}}" ]; then
  echo "failed to resolve runtime home for user: ${{runtime_user}}" >&2
  exit 1
fi
runtime_uid="$(id -u "${{runtime_user}}")"
unit="${{runtime_home}}/.config/systemd/user/openclaw-gateway.service"
remote_build_dir={json.dumps(remote_build_dir)}

if [ {json.dumps(build_mode_label)} != "base-only" ] && [ -e "${{unit}}" ]; then
  if [ ! -s "${{unit}}" ]; then
    echo "gateway unit is empty; reinstalling before snapshot"
    sudo -u "${{runtime_user}}" -H env -i HOME="${{runtime_home}}" USER="${{runtime_user}}" \
      XDG_RUNTIME_DIR="/run/user/${{runtime_uid}}" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${{runtime_uid}}/bus" \
      PATH=/usr/bin:/bin openclaw gateway install --force --port {json.dumps(str(gateway_port))}
  fi
  if [ ! -s "${{unit}}" ]; then
    echo "gateway unit remains empty after reinstall: ${{unit}}" >&2
    exit 1
  fi
  stat -c 'gateway_unit_size=%s %n' "${{unit}}"
fi

if [ -n "${remote_build_dir}" ] && [ "${remote_build_dir}" != "/" ] && [ -e "${remote_build_dir}" ]; then
  rm -rf "${remote_build_dir}"
fi
if [ -n "${remote_build_dir}" ] && [ "${remote_build_dir}" != "/" ] && [ -e "${remote_build_dir}" ]; then
  echo "remote build dir still exists after cleanup: ${remote_build_dir}" >&2
  exit 1
fi

sync
sleep 3
sync
"""
    run_remote_shell_via_ssh(ssh_host, ssh_port, remote_shell, check=True)


def step_create_image(instance_id, region, image_name, dry_run=False):
    """Step 3: 创建自定义镜像并等待完成。返回镜像 ID。"""

    # 3a. 创建镜像
    log(f"从实例 {instance_id} 创建自定义镜像: {image_name}")
    if dry_run:
        log("[DRY-RUN] 跳过 CreateImage 调用")
        return "img-dry-run-source"

    resp = run_tccli("cvm", "CreateImage", region, [
        "--InstanceId", instance_id,
        "--ImageName", image_name,
    ])
    image_id = resp.get("ImageId")
    if not image_id:
        raise RuntimeError(f"CreateImage 未返回 ImageId: {resp}")
    log(f"镜像创建中: {image_id} (RequestId={resp.get('RequestId', 'N/A')})")

    # 3b. 轮询等待镜像 NORMAL
    log(f"等待镜像就绪 (超时 {POLL_TIMEOUT_IMAGE_CREATE}s)...")
    start = time.time()
    while True:
        elapsed = time.time() - start
        if elapsed > POLL_TIMEOUT_IMAGE_CREATE:
            raise TimeoutError(
                f"镜像 {image_id} 在 {POLL_TIMEOUT_IMAGE_CREATE}s 内未就绪"
            )
        try:
            resp = run_tccli("cvm", "DescribeImages", region, [
                "--ImageIds", json.dumps([image_id]),
            ])
            if resp.get("TotalCount", 0) > 0:
                img = resp["ImageSet"][0]
                state = img.get("ImageState", "UNKNOWN")
                log(f"  镜像状态: {state} ({int(elapsed)}s)")
                if state == "NORMAL":
                    log(f"镜像已就绪: {image_id}")
                    return image_id
                if state in ("CREATE_FAILED", "DELETED"):
                    raise RuntimeError(f"镜像创建失败, 状态: {state}")
        except (TimeoutError, RuntimeError):
            raise
        except Exception as e:
            log(f"  查询异常 (将重试): {e}")
        time.sleep(POLL_INTERVAL_IMAGE)


def step_sync_image(image_id, source_region, target_region, image_name, dry_run=False):
    """Step 4: 跨地域复制镜像并等待完成。返回目标地域镜像 ID。"""

    # 4a. 发起复制
    log(f"复制镜像 {image_id}: {source_region} → {target_region}")
    if dry_run:
        log("[DRY-RUN] 跳过 SyncImages 调用")
        return f"img-dry-run-{target_region}"

    resp = run_tccli("cvm", "SyncImages", source_region, [
        "--ImageIds", json.dumps([image_id]),
        "--DestinationRegions", json.dumps([target_region]),
        "--ImageName", image_name,
        "--ImageSetRequired", "True",
    ])
    request_id = resp.get("RequestId", "N/A")

    # SyncImages 可能返回 ImageSet 包含目标镜像 ID
    image_set = resp.get("ImageSet", [])
    target_image_id = None
    if image_set:
        for img in image_set:
            if img.get("Region") == target_region or img.get("ImageId", "").startswith("img-"):
                target_image_id = img.get("ImageId")
                break
        if not target_image_id and image_set:
            target_image_id = image_set[0].get("ImageId")

    log(f"SyncImages 请求已发送: RequestId={request_id}")
    if target_image_id:
        log(f"目标镜像 ID: {target_image_id}")

    # 4b. 轮询等待目标地域镜像就绪
    #     如果没拿到目标 ID，按名称查询
    log(f"等待目标地域镜像就绪 (超时 {POLL_TIMEOUT_IMAGE_SYNC}s)...")
    start = time.time()
    while True:
        elapsed = time.time() - start
        if elapsed > POLL_TIMEOUT_IMAGE_SYNC:
            raise TimeoutError(
                f"镜像复制在 {POLL_TIMEOUT_IMAGE_SYNC}s 内未完成"
            )

        try:
            if target_image_id:
                # 按 ID 查询目标地域
                resp = run_tccli("cvm", "DescribeImages", target_region, [
                    "--ImageIds", json.dumps([target_image_id]),
                ])
            else:
                # 按名称查询目标地域
                resp = run_tccli("cvm", "DescribeImages", target_region, [
                    "--Filters", json.dumps([{
                        "Name": "image-name",
                        "Values": [image_name],
                    }]),
                ])

            if resp.get("TotalCount", 0) > 0:
                img = resp["ImageSet"][0]
                state = img.get("ImageState", "UNKNOWN")
                target_image_id = img["ImageId"]
                log(f"  目标镜像 {target_image_id} 状态: {state} ({int(elapsed)}s)")
                if state == "NORMAL":
                    log(f"目标镜像已就绪: {target_image_id}")
                    return target_image_id
                if state in ("CREATE_FAILED", "DELETED"):
                    raise RuntimeError(f"镜像复制失败, 状态: {state}")
            else:
                log(f"  目标镜像尚未出现 ({int(elapsed)}s)")
        except (TimeoutError, RuntimeError):
            raise
        except Exception as e:
            log(f"  查询异常 (将重试): {e}")
        time.sleep(POLL_INTERVAL_IMAGE)


def wait_for_source_image_sync_ready(image_id, source_region, dry_run=False):
    """Wait until the source image can accept another SyncImages request."""
    if dry_run:
        return

    start = time.time()
    while True:
        elapsed = time.time() - start
        if elapsed > POLL_TIMEOUT_IMAGE_SYNC:
            raise TimeoutError(
                f"源镜像 {image_id} 在 {POLL_TIMEOUT_IMAGE_SYNC}s 内未恢复可同步状态"
            )
        resp = run_tccli("cvm", "DescribeImages", source_region, [
            "--ImageIds", json.dumps([image_id]),
        ])
        if resp.get("TotalCount", 0) < 1 or not resp.get("ImageSet"):
            raise RuntimeError(f"源镜像不存在: {image_id}")
        state = resp["ImageSet"][0].get("ImageState", "UNKNOWN")
        if state == "NORMAL":
            return
        if state in ("CREATE_FAILED", "DELETED"):
            raise RuntimeError(f"源镜像状态异常: {state}")
        log(f"  源镜像 {image_id} 状态: {state}, 等待下一次同步 ({int(elapsed)}s)")
        time.sleep(POLL_INTERVAL_IMAGE)


def step_sync_images(image_id, source_region, target_regions, image_name, dry_run=False):
    """复制镜像到多个目标地域，返回 {region: image_id}。"""
    regions = parse_csv_list(target_regions)
    if not regions:
        log("未配置目标地域，跳过跨地域复制")
        return {}

    log(f"顺序同步镜像到目标地域: {format_region_list(regions)}")
    results = {}
    failures = {}
    for region in regions:
        try:
            wait_for_source_image_sync_ready(
                image_id,
                source_region,
                dry_run=dry_run,
            )
            target_image_id = step_sync_image(
                image_id,
                source_region,
                region,
                image_name,
                dry_run,
            )
        except Exception as exc:
            failures[region] = exc
            log(f"目标地域同步失败: {region}: {exc}")
            continue
        results[region] = target_image_id
        log(f"目标地域同步完成: {region}: {target_image_id}")

    if failures:
        detail = "; ".join(f"{region}: {exc}" for region, exc in failures.items())
        raise RuntimeError(f"镜像跨地域同步失败: {detail}")
    return {region: results[region] for region in regions if region in results}


# ============================================================
# 主流程
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="LightClaw 镜像全自动构建流水线",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 查询当前 pinned 与远端最新版本
  python3 images/build-image.py versions
  python3 images/build-image.py versions --format json

  # 全量构建
  python3 images/build-image.py

  # 分层构建：先构建基础镜像
  python3 images/build-image.py --build-base

  # 分层构建：基于当前基础镜像构建应用层
  python3 images/build-image.py --base-image-id img-id352nof
  python3 images/build-image.py --base-image-id img-id352nof --with-verify
  python3 images/build-image.py --base-image-id img-id352nof --with-verify --skip-create-image --skip-sync-image

  # 常用排障
  python3 images/build-image.py --skip-create-image --skip-sync-image
        """,
    )
    parser.add_argument(
        "command",
        nargs="?",
        choices=["build", "versions"],
        default="build",
        help="执行命令：build=构镜流水线（默认），versions=查询当前 pinned 与最新版本",
    )
    parser.add_argument(
        "--instance-id", default=DEFAULT_INSTANCE_ID,
        help=f"制作镜像的 CVM 实例 ID (default: {DEFAULT_INSTANCE_ID})",
    )
    parser.add_argument(
        "--source-region", default=DEFAULT_SOURCE_REGION,
        help=f"源地域 (default: {DEFAULT_SOURCE_REGION})",
    )
    parser.add_argument(
        "--target-region", default=DEFAULT_TARGET_REGION,
        help=f"目标地域 (default: {DEFAULT_TARGET_REGION})",
    )
    parser.add_argument(
        "--target-regions", default=None,
        help="目标地域列表，逗号分隔；设置后覆盖 --target-region，例如 ap-beijing,ap-shanghai,ap-singapore",
    )
    parser.add_argument(
        "--ssh-host", default=DEFAULT_SSH_HOST,
        help=f"SSH 目标 (default: {DEFAULT_SSH_HOST})",
    )
    parser.add_argument(
        "--ssh-port", default=DEFAULT_SSH_PORT,
        help=f"SSH 端口 (default: {DEFAULT_SSH_PORT})",
    )
    parser.add_argument(
        "--runtime-user", default=DEFAULT_RUNTIME_USER,
        help=f"镜像运行态用户 (default: {DEFAULT_RUNTIME_USER})",
    )
    parser.add_argument(
        "--runtime", default="openclaw", choices=["openclaw", "hermes"],
        help="应用层运行时：openclaw | hermes (default: openclaw)",
    )
    parser.add_argument(
        "--hermes-version", default=DEFAULT_HERMES_VERSION,
        help=f"Hermes COS 版本，例如 hermes-agent-v20260520 (default: {DEFAULT_HERMES_VERSION or 'latest.json'})",
    )
    parser.add_argument(
        "--hermes-src-version", default=DEFAULT_HERMES_SRC_VERSION,
        help=f"Hermes source version resolved from latest.json (default: {DEFAULT_HERMES_SRC_VERSION or 'latest.json'})",
    )
    parser.add_argument(
        "--remote-build-dir", default=DEFAULT_REMOTE_BUILD_DIR,
        help=f"远端构建工作目录；制镜前会清理 (default: {DEFAULT_REMOTE_BUILD_DIR})",
    )
    parser.add_argument(
        "--base-image-id", default=DEFAULT_BASE_IMAGE_ID,
        help=f"重装用的基础镜像 ID (default: {DEFAULT_BASE_IMAGE_ID})",
    )
    parser.add_argument(
        "--ssh-key-id", default=DEFAULT_SSH_KEY_ID,
        help=f"重装时绑定的 SSH 密钥 ID (default: {DEFAULT_SSH_KEY_ID})",
    )
    parser.add_argument(
        "--openclaw-version", default=DEFAULT_OPENCLAW_VERSION,
        help=f"传给 deploy-build.sh 的 openclaw 版本号 (default: {DEFAULT_OPENCLAW_VERSION})",
    )
    parser.add_argument(
        "--image-name", default=None,
        help="自定义镜像名称 (default: lightclaw-YYYYMMDD-HHMMSS)",
    )
    parser.add_argument(
        "--skip-reset", action="store_true",
        help="跳过重装系统，直接从 deploy-build 开始",
    )
    parser.add_argument(
        "--skip-build", action="store_true",
        help="跳过重装和构建，直接从创建镜像开始",
    )
    parser.add_argument(
        "--skip-create-image", action="store_true",
        help="跳过创建自定义镜像，仅执行到构建和版本元数据写入为止",
    )
    parser.add_argument(
        "--skip-sync-image", action="store_true",
        help="跳过跨地域复制镜像",
    )
    parser.add_argument(
        "--keep-build-instance", action="store_true",
        help="保留临时构建机和临时云侧密钥，便于排障",
    )
    parser.add_argument(
        "--with-verify", action="store_true",
        help="先做一轮验证构建 + 自动化测试，通过后再次重装并做正式构建",
    )
    parser.add_argument(
        "--build-base", action="store_true",
        help="构建基础镜像模式：仅安装系统底座（node, python, chromium 等），不跨地域复制",
    )
    parser.add_argument(
        "--verify-suites", default=None,
        help="验证套件列表，逗号分隔，可选 envd,runtime,runtime-hermes,weixin-login,onboard；仅在 --with-verify 时生效。默认会随 --runtime 自动选择",
    )
    parser.add_argument(
        "--only-plugins", default=None,
        help="仅安装指定插件（逗号分隔），默认镜像安装 qqbot,weixin。可选: qqbot,weixin,feishu,ddingtalk,wecom,adp,yuanbao",
    )
    parser.add_argument(
        "--qqbot-version", default=DEFAULT_QQBOT_VERSION,
        help=f"指定 qqbot 插件版本；仅在安装 qqbot 时生效 (default: {DEFAULT_QQBOT_VERSION})",
    )
    parser.add_argument(
        "--weixin-version", default=DEFAULT_WEIXIN_VERSION,
        help=f"指定 weixin 插件版本；仅在安装 weixin 时生效 (default: {DEFAULT_WEIXIN_VERSION})",
    )
    parser.add_argument(
        "--skills", default="essential",
        choices=["essential", "all", "custom"],
        help="Skill 安装模式 (default: essential)。essential=仅 find-skills-skill; all=全量; custom=自定义",
    )
    parser.add_argument(
        "--custom-skills", default=None,
        help="自定义 skill 列表（逗号分隔），自动启用 --skills custom",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="仅打印将要执行的操作，不实际执行",
    )
    parser.add_argument(
        "--format", default="text", choices=["text", "json"],
        help="仅对 command=versions 生效，输出格式 (default: text)",
    )

    args = parser.parse_args()

    if args.command == "versions":
        print_version_report(BUILD_MANIFEST, args.format)
        return

    args.target_regions = (
        parse_csv_list(args.target_regions)
        if args.target_regions is not None
        else [args.target_region]
    )
    if not args.target_regions:
        raise ValueError("至少需要一个目标地域")
    args.target_region = args.target_regions[0]

    if args.runtime == "hermes" and args.runtime_user == DEFAULT_RUNTIME_USER:
        args.runtime_user = DEFAULT_HERMES_RUNTIME_USER

    if args.runtime == "hermes" and (not args.hermes_version or not args.hermes_src_version):
        hermes_latest = fetch_hermes_latest_metadata()
        if not args.hermes_version:
            args.hermes_version = hermes_latest["version"]
        if not args.hermes_src_version:
            args.hermes_src_version = hermes_latest["src_version"]
        log(
            "Resolved Hermes latest metadata in CI worker: "
            f"version={args.hermes_version} src_version={args.hermes_src_version} "
            f"git_commit={hermes_latest.get('git_commit') or 'unknown'}"
        )

    # --custom-skills 自动启用 custom 模式
    if args.custom_skills:
        args.skills = "custom"

    if args.skip_build and args.with_verify:
        raise ValueError("--skip-build 与 --with-verify 不能同时使用")

    if args.build_base and args.with_verify:
        raise ValueError("--build-base 与 --with-verify 不能同时使用")

    if args.build_base and args.skip_build:
        raise ValueError("--build-base 与 --skip-build 不能同时使用")

    if args.skip_create_image:
        args.skip_sync_image = True

    verify_suite_default = "runtime-hermes" if args.runtime == "hermes" else "runtime"
    raw_verify_value = args.verify_suites if args.verify_suites is not None else verify_suite_default
    raw_verify_suites = [item.strip() for item in raw_verify_value.split(",") if item.strip()]
    verify_suites = []
    for suite in raw_verify_suites:
        if suite not in ("envd", "runtime", "runtime-hermes", "weixin-login", "onboard"):
            raise ValueError(f"不支持的验证套件: {suite}")
        if suite not in verify_suites:
            verify_suites.append(suite)

    if not args.with_verify:
        verify_suites = []

    # 生成镜像名称
    if args.image_name:
        image_name = args.image_name
    elif args.build_base:
        ts = datetime.now(CST).strftime("%Y%m%d-%H%M%S")
        image_prefix = "hermes-base" if args.runtime == "hermes" else "lightclaw-base"
        image_name = f"{image_prefix}-{ts}"
    else:
        ts = datetime.now(CST).strftime("%Y%m%d-%H%M%S")
        if args.runtime == "hermes":
            image_name = f"hermes-agent-{ts}"
        else:
            ver_suffix = f"-{args.openclaw_version}" if args.openclaw_version else ""
            image_name = f"lightclaw{ver_suffix}-{ts}"

    # 判断构建模式
    # - build_base: 构建基础镜像（仅首尔，不跨地域）
    # - 应用层: base_image_id 非默认公网基础镜像且非 build_base → 自动传 --app-only
    # - 全量: 使用默认公网基础镜像且无 build_base
    is_app_layer = (
        not args.build_base
        and args.base_image_id != DEFAULT_BASE_IMAGE_ID
    )

    # 应用层模式下，前置验证 base 镜像是否存在
    if is_app_layer and not args.dry_run:
        log(f"验证基础镜像 {args.base_image_id} 是否存在...")
        try:
            resp = run_tccli("cvm", "DescribeImages", args.source_region, [
                "--ImageIds", json.dumps([args.base_image_id]),
            ])
            if resp.get("TotalCount", 0) == 0:
                raise RuntimeError(
                    f"基础镜像 {args.base_image_id} 不存在！\n"
                    f"请先执行 `python3 images/build-image.py --build-base` 构建基础镜像，"
                    f"然后用输出的镜像 ID 作为 --base-image-id 参数。"
                )
            img_state = resp["ImageSet"][0].get("ImageState", "UNKNOWN")
            if img_state != "NORMAL":
                raise RuntimeError(
                    f"基础镜像 {args.base_image_id} 状态异常: {img_state}，请等待就绪或重新构建。"
                )
            log(f"基础镜像 {args.base_image_id} 验证通过 (状态: {img_state})")
        except RuntimeError:
            raise
        except Exception as e:
            log(f"WARNING: 无法验证基础镜像（将继续执行）: {e}")

    if args.build_base:
        build_mode = "base-only"
        total_steps = 4  # 重装 → deploy-build --base-only → 写版本 → 创建镜像
    elif is_app_layer:
        build_mode = "app-only"
        total_steps = 5
        if args.with_verify:
            total_steps = 9
    else:
        build_mode = None  # 全量
        total_steps = 5
        if args.with_verify:
            total_steps = 9

    image_version = make_image_version(build_mode, runtime_kind=args.runtime)
    image_metadata = build_image_metadata(
        args, image_name, image_version, build_mode, verify_suites,
    )

    log("=" * 60)
    log("LightClaw 镜像全自动构建流水线")
    log("=" * 60)
    log(f"  实例 ID:      {args.instance_id}")
    log(f"  源地域:       {args.source_region}")
    log(f"  目标地域:     {format_region_list(args.target_regions)}")
    log(f"  SSH:          {args.ssh_host}:{args.ssh_port}")
    log(f"  远端目录:     {args.remote_build_dir}")
    log(f"  基础镜像:     {args.base_image_id}")
    log(f"  SSH 密钥:     {args.ssh_key_id}")
    log(f"  Runtime:      {args.runtime}")
    if args.runtime == "hermes":
        log(f"  Hermes 用户:  {args.runtime_user}")
        log(f"  Hermes Node:  {DEFAULT_HERMES_NODE_MAJOR}")
        log(f"  Hermes 版本:  {args.hermes_version or 'latest.json'}")
        log(f"  Hermes 源版本: {args.hermes_src_version or '未知'}")
        log(f"  Qwen Code:    {DEFAULT_HERMES_QWEN_CODE_VERSION}")
    else:
        log(f"  OpenClaw:     {args.openclaw_version or '默认'}")
    log(f"  运行用户:     {args.runtime_user}")
    log(f"  镜像名称:     {image_name}")
    log(f"  镜像版本:     {image_version}")
    log(f"  构建模式:     {build_mode or '全量'}")
    log(f"  验证模式:     {args.with_verify}")
    log(f"  验证套件:     {','.join(verify_suites) if verify_suites else '无'}")
    log(f"  插件模式:     {args.only_plugins or '默认 (qqbot + weixin)'}")
    if args.runtime == "openclaw":
        log(f"  QQBot 版本:   {args.qqbot_version or DEFAULT_QQBOT_VERSION}")
        log(f"  Weixin 版本:  {args.weixin_version or DEFAULT_WEIXIN_VERSION}")
        log(f"  Skill 模式:   {args.skills}")
        if args.custom_skills:
            log(f"  自定义 skills: {args.custom_skills}")
    log(f"  Skip reset:   {args.skip_reset}")
    log(f"  Skip build:   {args.skip_build}")
    log(f"  Skip create:  {args.skip_create_image}")
    log(f"  Skip sync:    {args.skip_sync_image}")
    log(f"  Dry-run:      {args.dry_run}")

    pipeline_start = time.time()

    current_step = 1
    current_ssh_host = args.ssh_host
    current_ssh_port = str(args.ssh_port)
    current_build_instance_id = args.instance_id
    temporary_instance_ids = []
    temporary_key_local = None
    temporary_key_id = None
    source_image_id = None
    target_image_id = None
    target_image_ids = {}

    def prepare_temp_instance(step_title, image_id):
        nonlocal current_build_instance_id, current_ssh_host, current_ssh_port
        log_step(current_step, total_steps, step_title)
        current_build_instance_id, current_ssh_host, current_ssh_port = step_create_build_instance(
            args.instance_id, args.source_region, image_id, temporary_key_id, dry_run=args.dry_run,
        )
        temporary_instance_ids.append(current_build_instance_id)
        if args.dry_run:
            return
        current_ssh_host, current_ssh_port = wait_for_ssh_ready(
            current_ssh_host,
            current_ssh_port,
            include_bootstrap_users=True,
            timeout=POLL_TIMEOUT_SSH,
        )
        wait_for_boot_settle(current_ssh_host, current_ssh_port, dry_run=args.dry_run)

    try:
        if not args.skip_reset:
            temporary_key_local = create_temp_ssh_keypair_local(dry_run=args.dry_run)
            temporary_key_id = import_temp_keypair(
                args.source_region,
                temporary_key_local["key_name"],
                temporary_key_local["public_key_text"],
                dry_run=args.dry_run,
            )
            if not args.dry_run and temporary_key_local.get("private_key_path"):
                os.environ["LIGHTCLAW_SSH_IDENTITY_FILE"] = temporary_key_local["private_key_path"]

        if args.build_base:
            if not args.skip_reset:
                prepare_temp_instance("创建临时构建机（Ubuntu 24.04 基础镜像）", DEFAULT_BASE_IMAGE_ID)
            else:
                log(f"\n跳过 Step {current_step} (创建临时构建机)")
            current_step += 1

            log_step(current_step, total_steps, "执行 deploy-build.sh --base-only")
            step_deploy_build(
                current_ssh_host, current_ssh_port,
                openclaw_version=args.openclaw_version,
                build_mode="base-only",
                runtime_kind=args.runtime,
                hermes_version=args.hermes_version,
                hermes_src_version=args.hermes_src_version,
                runtime_user=args.runtime_user,
                remote_dir=args.remote_build_dir,
                dry_run=args.dry_run,
            )
            current_ssh_host, current_ssh_port = step_wait_for_preferred_ssh(
                current_ssh_host, current_ssh_port, dry_run=args.dry_run,
            )
            current_step += 1

            log_step(current_step, total_steps, "写入镜像版本元数据")
            step_write_image_version(current_ssh_host, current_ssh_port, metadata=image_metadata, dry_run=args.dry_run)
            current_step += 1

            if not args.skip_create_image:
                log_step(current_step, total_steps, "创建基础镜像（仅首尔）")
                step_prepare_capture(
                    current_ssh_host,
                    current_ssh_port,
                    build_mode="base-only",
                    gateway_port=BUILD_MANIFEST["runtime"].get("gateway_port", 0) if args.runtime == "openclaw" else 0,
                    runtime_user=args.runtime_user,
                    remote_build_dir=args.remote_build_dir,
                    dry_run=args.dry_run,
                )
                source_image_id = step_create_image(current_build_instance_id, args.source_region, image_name, dry_run=args.dry_run)
            else:
                log(f"\n跳过 Step {current_step} (创建基础镜像)")
        elif not args.with_verify:
            if not args.skip_reset and not args.skip_build:
                prepare_temp_instance("创建临时构建机", args.base_image_id)
            else:
                log(f"\n跳过 Step {current_step} (创建临时构建机)")
            current_step += 1

            if not args.skip_build:
                mode_label = f" --{build_mode}" if build_mode else ""
                log_step(current_step, total_steps, f"执行 deploy-build.sh{mode_label}")
                step_deploy_build(
                    current_ssh_host, current_ssh_port,
                    openclaw_version=args.openclaw_version,
                    build_mode=build_mode,
                    runtime_kind=args.runtime,
                    hermes_version=args.hermes_version,
                    hermes_src_version=args.hermes_src_version,
                    only_plugins=args.only_plugins,
                    qqbot_version=args.qqbot_version,
                    weixin_version=args.weixin_version,
                    skills_mode=args.skills,
                    custom_skills=args.custom_skills,
                    runtime_user=args.runtime_user,
                    remote_dir=args.remote_build_dir,
                    dry_run=args.dry_run,
                )
                current_ssh_host, current_ssh_port = step_wait_for_preferred_ssh(
                    current_ssh_host, current_ssh_port, dry_run=args.dry_run,
                )
            else:
                log(f"\n跳过 Step {current_step} (deploy-build.sh)")
            current_step += 1

            log_step(current_step, total_steps, "写入镜像版本元数据")
            step_write_image_version(current_ssh_host, current_ssh_port, metadata=image_metadata, dry_run=args.dry_run)
            current_step += 1

            if not args.skip_create_image:
                log_step(current_step, total_steps, "创建自定义镜像")
                step_prepare_capture(
                    current_ssh_host,
                    current_ssh_port,
                    build_mode=build_mode,
                    gateway_port=BUILD_MANIFEST["runtime"].get("gateway_port", 0) if args.runtime == "openclaw" else 0,
                    runtime_user=args.runtime_user,
                    remote_build_dir=args.remote_build_dir,
                    dry_run=args.dry_run,
                )
                source_image_id = step_create_image(current_build_instance_id, args.source_region, image_name, dry_run=args.dry_run)
            else:
                log(f"\n跳过 Step {current_step} (创建自定义镜像)")
            current_step += 1

            if not args.skip_sync_image:
                log_step(current_step, total_steps, f"跨地域并发复制到 {format_region_list(args.target_regions)}")
                target_image_ids = step_sync_images(source_image_id, args.source_region, args.target_regions, image_name, dry_run=args.dry_run)
                target_image_id = next(iter(target_image_ids.values()), None)
            else:
                log(f"\n跳过 Step {current_step} (跨地域复制到 {format_region_list(args.target_regions)})")
        else:
            if not args.skip_reset:
                prepare_temp_instance("验证阶段: 创建临时构建机", args.base_image_id)
            else:
                log(f"\n跳过 Step {current_step} (验证阶段创建临时构建机)")
            current_step += 1

            mode_label = f" --{build_mode}" if build_mode else ""
            log_step(current_step, total_steps, f"验证阶段: 执行 deploy-build.sh{mode_label}")
            step_deploy_build(
                current_ssh_host, current_ssh_port,
                openclaw_version=args.openclaw_version,
                build_mode=build_mode,
                runtime_kind=args.runtime,
                hermes_version=args.hermes_version,
                hermes_src_version=args.hermes_src_version,
                only_plugins=args.only_plugins,
                qqbot_version=args.qqbot_version,
                weixin_version=args.weixin_version,
                skills_mode=args.skills,
                custom_skills=args.custom_skills,
                runtime_user=args.runtime_user,
                remote_dir=args.remote_build_dir,
                dry_run=args.dry_run,
            )
            current_ssh_host, current_ssh_port = step_wait_for_preferred_ssh(
                current_ssh_host, current_ssh_port, dry_run=args.dry_run,
            )
            current_step += 1

            log_step(current_step, total_steps, "验证阶段: 运行自动化测试")
            step_run_verification(current_ssh_host, current_ssh_port, verify_suites=verify_suites, dry_run=args.dry_run)
            current_step += 1

            if not args.skip_reset:
                log_step(current_step, total_steps, "正式构镜前: 销毁验证构建机")
                terminate_instance(current_build_instance_id, args.source_region, dry_run=args.dry_run)
                current_step += 1
                prepare_temp_instance("正式构镜前: 创建新的临时构建机", args.base_image_id)
            else:
                log(f"\n跳过 Step {current_step} (正式构镜前创建新实例)")
            current_step += 1

            log_step(current_step, total_steps, f"正式构镜: 执行 deploy-build.sh{mode_label}")
            step_deploy_build(
                current_ssh_host, current_ssh_port,
                openclaw_version=args.openclaw_version,
                build_mode=build_mode,
                runtime_kind=args.runtime,
                hermes_version=args.hermes_version,
                hermes_src_version=args.hermes_src_version,
                only_plugins=args.only_plugins,
                qqbot_version=args.qqbot_version,
                weixin_version=args.weixin_version,
                skills_mode=args.skills,
                custom_skills=args.custom_skills,
                runtime_user=args.runtime_user,
                remote_dir=args.remote_build_dir,
                dry_run=args.dry_run,
            )
            current_ssh_host, current_ssh_port = step_wait_for_preferred_ssh(
                current_ssh_host, current_ssh_port, dry_run=args.dry_run,
            )
            current_step += 1

            log_step(current_step, total_steps, "正式构镜: 写入镜像版本元数据")
            step_write_image_version(current_ssh_host, current_ssh_port, metadata=image_metadata, dry_run=args.dry_run)
            current_step += 1

            if not args.skip_create_image:
                log_step(current_step, total_steps, "创建自定义镜像")
                step_prepare_capture(
                    current_ssh_host,
                    current_ssh_port,
                    build_mode=build_mode,
                    gateway_port=BUILD_MANIFEST["runtime"].get("gateway_port", 0) if args.runtime == "openclaw" else 0,
                    runtime_user=args.runtime_user,
                    remote_build_dir=args.remote_build_dir,
                    dry_run=args.dry_run,
                )
                source_image_id = step_create_image(current_build_instance_id, args.source_region, image_name, dry_run=args.dry_run)
            else:
                log(f"\n跳过 Step {current_step} (创建自定义镜像)")
            current_step += 1

            if not args.skip_sync_image:
                log_step(current_step, total_steps, f"跨地域并发复制到 {format_region_list(args.target_regions)}")
                target_image_ids = step_sync_images(source_image_id, args.source_region, args.target_regions, image_name, dry_run=args.dry_run)
                target_image_id = next(iter(target_image_ids.values()), None)
            else:
                log(f"\n跳过 Step {current_step} (跨地域复制到 {format_region_list(args.target_regions)})")

        pipeline_elapsed = time.time() - pipeline_start
        minutes = int(pipeline_elapsed // 60)
        seconds = int(pipeline_elapsed % 60)

        print(f"\n{'='*60}", flush=True)
        log("✅ 流水线完成!")
        print(f"{'='*60}", flush=True)
        log(f"  镜像名称:       {image_name}")
        log(f"  镜像版本:       {image_version}")
        if source_image_id:
            log(f"  源镜像 ID:      {source_image_id} ({args.source_region})")
        else:
            log("  源镜像 ID:      (本次已跳过创建)")
        if target_image_ids:
            for region in args.target_regions:
                if region in target_image_ids:
                    log(f"  目标镜像 ID:    {target_image_ids[region]} ({region})")
        elif target_image_id:
            log(f"  目标镜像 ID:    {target_image_id} ({args.target_region})")
        elif args.build_base:
            log("  目标镜像 ID:    (基础镜像模式不跨地域复制)")
        else:
            log("  目标镜像 ID:    (本次已跳过复制)")
        log(f"  总耗时:         {minutes}m {seconds}s")
        print(f"{'='*60}", flush=True)
    finally:
        os.environ.pop("LIGHTCLAW_SSH_IDENTITY_FILE", None)
        if not args.keep_build_instance:
            for temp_instance_id in reversed(temporary_instance_ids):
                try:
                    terminate_instance(temp_instance_id, args.source_region, dry_run=args.dry_run)
                except Exception as exc:
                    log(f"WARNING: 销毁临时构建机失败 {temp_instance_id}: {exc}")
            if temporary_key_id:
                try:
                    delete_keypair(args.source_region, temporary_key_id, dry_run=args.dry_run)
                except Exception as exc:
                    log(f"WARNING: 删除临时密钥对失败 {temporary_key_id}: {exc}")
        if temporary_key_local and not args.dry_run:
            private_key_path = temporary_key_local.get("private_key_path")
            for path in (private_key_path, f"{private_key_path}.pub" if private_key_path else ""):
                if path and os.path.exists(path):
                    try:
                        os.remove(path)
                    except OSError:
                        pass
    log(f"  镜像名称:       {image_name}")
    log(f"  镜像版本:       {image_version}")
    if source_image_id:
        log(f"  源镜像 ID:      {source_image_id} ({args.source_region})")
    else:
        log("  源镜像 ID:      (本次已跳过创建)")
    if target_image_ids:
        for region in args.target_regions:
            if region in target_image_ids:
                log(f"  目标镜像 ID:    {target_image_ids[region]} ({region})")
    elif target_image_id:
        log(f"  目标镜像 ID:    {target_image_id} ({args.target_region})")
    elif args.build_base:
        log(f"  (基础镜像模式，未跨地域复制)")
    elif args.skip_sync_image:
        log(f"  目标镜像 ID:    (本次已跳过复制)")
    log(f"  总耗时:         {minutes}m {seconds}s")
    print(f"{'='*60}", flush=True)

    # 输出方便复制的镜像 ID
    output_id = target_image_id or source_image_id
    if not args.dry_run and (source_image_id or target_image_id):
        update_image_inventory_doc(
            image_metadata,
            build_mode or "full",
            source_image_id,
            target_image_id,
            args.source_region,
            args.target_region,
        )
    if target_image_ids:
        print(
            "\n" + json.dumps(
                {
                    "source_region": args.source_region,
                    "source_image_id": source_image_id,
                    "target_image_ids": target_image_ids,
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
            flush=True,
        )
    elif output_id:
        print(f"\n{output_id}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("用户中断")
        sys.exit(130)
    except Exception as e:
        log(f"❌ 流水线失败: {e}")
        sys.exit(1)
