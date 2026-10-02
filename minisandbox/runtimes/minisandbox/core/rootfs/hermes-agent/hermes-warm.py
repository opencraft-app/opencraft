"""Publish and serve a credential-free, live-interpreter Hermes template."""

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import fcntl
import importlib.metadata
import io
import json
import os
from pathlib import Path
import pwd
import socket
import struct
import threading
import time


CHECKPOINT_IOCTL = 0xB701
BENCHMARK_POINT_IOCTL = 0xB702
SOCKET_PATH = Path("/run/minisandbox-hermes/agent.sock")
PROFILE_ROOT = Path("/opt/data")
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_PROMPT_BYTES = 16 * 1024
MAX_CREDENTIAL_BYTES = 16 * 1024
MAX_GATEWAY_ENVIRONMENT = 128
MAX_GATEWAY_ENVIRONMENT_VALUE_BYTES = 16 * 1024
SOCKET_TIMEOUT_SECONDS = 5
PROVIDER_CREDENTIALS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "openai-api": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "together": "TOGETHER_API_KEY",
    "xai": "XAI_API_KEY",
}
FORBIDDEN_GATEWAY_ENVIRONMENT = {
    "HOME",
    "HERMES_HOME",
    "HERMES_WRITE_SAFE_ROOT",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PATH",
    "PYTHONHOME",
    "PYTHONPATH",
}


def marker(text: str) -> None:
    payload = f"{text}\n".encode()
    if os.write(1, payload) != len(payload):
        raise RuntimeError("short Hermes warm marker write")


def drop_to_hermes() -> tuple[int, int]:
    identity = pwd.getpwnam("hermes")
    if identity.pw_uid != 10000 or identity.pw_gid != 10000:
        raise RuntimeError("Hermes runtime identity changed")
    os.setgroups([])
    os.setgid(identity.pw_gid)
    os.setuid(identity.pw_uid)
    if os.getuid() != identity.pw_uid or os.getgid() != identity.pw_gid:
        raise RuntimeError("failed to drop Hermes warm daemon credentials")
    return identity.pw_uid, identity.pw_gid


def create_listener(uid: int, gid: int) -> socket.socket:
    SOCKET_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(SOCKET_PATH.parent, uid, gid)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(SOCKET_PATH))
    os.chown(SOCKET_PATH, uid, gid)
    os.chmod(SOCKET_PATH, 0o600)
    listener.listen(8)
    return listener


def assert_checkpoint_boundary(control: int, listener: socket.socket) -> None:
    threads = threading.enumerate()
    if len(threads) != 1 or threads[0] is not threading.main_thread():
        raise RuntimeError(f"Hermes checkpoint has live threads: {threads!r}")
    allowed_files = {
        ".bash_logout",
        ".bashrc",
        ".profile",
        "SOUL.md",
        "cache/tool_discovery_cache.json",
        "state.db",
    }
    allowed_directories = {
        "audio_cache",
        "cache",
        "cron",
        "hooks",
        "image_cache",
        "logs",
        "logs/curator",
        "memories",
        "pairing",
        "sessions",
        "skills",
    }
    for path in PROFILE_ROOT.rglob("*"):
        relative = path.relative_to(PROFILE_ROOT).as_posix()
        if path.is_symlink():
            raise RuntimeError(f"Hermes checkpoint profile has a symlink: {relative}")
        if path.is_dir():
            if relative not in allowed_directories:
                raise RuntimeError(f"Hermes checkpoint profile has a directory: {relative}")
        elif path.is_file():
            if relative not in allowed_files:
                raise RuntimeError(f"Hermes checkpoint profile has a file: {relative}")
        else:
            raise RuntimeError(f"Hermes checkpoint profile has a special inode: {relative}")
    for forbidden in (".env", "auth.json", "config.yaml"):
        if (PROFILE_ROOT / forbidden).exists():
            raise RuntimeError(f"Hermes checkpoint profile contains {forbidden}")
    soul = PROFILE_ROOT / "SOUL.md"
    if not soul.is_file() or soul.stat().st_size > 4096:
        raise RuntimeError("Hermes checkpoint has an invalid default SOUL.md")
    import sqlite3

    database = sqlite3.connect(f"file:{PROFILE_ROOT / 'state.db'}?mode=ro", uri=True)
    try:
        tables = database.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        ).fetchall()
        rows = database.execute("SELECT COUNT(*) FROM async_delegations").fetchone()
    finally:
        database.close()
    if tables != [("async_delegations",)] or rows != (0,):
        raise RuntimeError("Hermes checkpoint state database is not empty")
    discovery_cache = json.loads(
        (PROFILE_ROOT / "cache/tool_discovery_cache.json").read_text(encoding="utf-8")
    )
    if (
        not isinstance(discovery_cache, dict)
        or len(discovery_cache) > 4096
        or any(
            not isinstance(path, str)
            or not path.startswith("/opt/hermes/")
            or not isinstance(metadata, list)
            or len(metadata) != 3
            or not isinstance(metadata[0], int)
            or not isinstance(metadata[1], int)
            or not isinstance(metadata[2], bool)
            for path, metadata in discovery_cache.items()
        )
    ):
        raise RuntimeError("Hermes checkpoint tool cache is not image-local")
    allowed = {0, 1, 2, control, listener.fileno()}
    unexpected = []
    for name in os.listdir("/proc/self/fd"):
        descriptor = int(name)
        if descriptor in allowed:
            continue
        try:
            target = os.readlink(f"/proc/self/fd/{descriptor}")
        except FileNotFoundError:
            continue
        unexpected.append((descriptor, target))
    if unexpected:
        raise RuntimeError(f"Hermes checkpoint has unexpected descriptors: {unexpected!r}")


def read_exact(connection: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = connection.recv(length - len(chunks))
        if not chunk:
            raise ValueError("short Hermes request")
        chunks.extend(chunk)
    return bytes(chunks)


def read_frame(connection: socket.socket) -> dict[str, object]:
    (length,) = struct.unpack("!I", read_exact(connection, 4))
    if not 1 <= length <= MAX_REQUEST_BYTES:
        raise ValueError("invalid Hermes request length")
    value = json.loads(read_exact(connection, length))
    if not isinstance(value, dict):
        raise ValueError("Hermes request must be an object")
    return value


def write_frame(connection: socket.socket, value: dict[str, object]) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    if len(payload) > MAX_RESPONSE_BYTES:
        payload = json.dumps(
            {"exit_code": 1, "stdout": "", "stderr": "Hermes response exceeded limit\n"},
            separators=(",", ":"),
        ).encode()
    connection.sendall(struct.pack("!I", len(payload)) + payload)


def bounded_text(
    request: dict[str, object], name: str, maximum: int, *, allow_empty: bool = False
) -> str:
    value = request.get(name)
    if not isinstance(value, str):
        raise ValueError(f"Hermes {name} must be text")
    encoded = value.encode()
    if len(encoded) > maximum or (not allow_empty and not encoded):
        raise ValueError(f"Hermes {name} length is invalid")
    return value


def validate_request(request: dict[str, object]) -> tuple[str, str, str, str, str, str]:
    expected = {"prompt", "provider", "model", "credential_env", "credential", "base_url"}
    if set(request) != expected:
        raise ValueError("Hermes request fields are not canonical")
    prompt = bounded_text(request, "prompt", MAX_PROMPT_BYTES)
    provider = bounded_text(request, "provider", 64)
    model = bounded_text(request, "model", 256)
    credential_env = bounded_text(request, "credential_env", 64)
    credential = bounded_text(request, "credential", MAX_CREDENTIAL_BYTES)
    base_url = bounded_text(request, "base_url", 2048, allow_empty=True)
    if not provider.replace("-", "").isalnum():
        raise ValueError("Hermes provider is invalid")
    if not all(character.isalnum() or character in "._:/-" for character in model):
        raise ValueError("Hermes model is invalid")
    if PROVIDER_CREDENTIALS.get(provider) != credential_env:
        raise ValueError("Hermes provider credential is not allowlisted")
    if base_url and provider != "openrouter":
        raise ValueError("Hermes base URL override is not allowed for this provider")
    return prompt, provider, model, credential_env, credential, base_url


def validate_gateway_request(request: dict[str, object]) -> dict[str, str]:
    if set(request) != {"operation", "environment"}:
        raise ValueError("Hermes gateway request fields are not canonical")
    if request["operation"] != "gateway":
        raise ValueError("Hermes gateway operation is invalid")
    environment = request["environment"]
    if not isinstance(environment, dict) or len(environment) > MAX_GATEWAY_ENVIRONMENT:
        raise ValueError("Hermes gateway environment is invalid")
    validated: dict[str, str] = {}
    for name, value in environment.items():
        if (
            not isinstance(name, str)
            or not 1 <= len(name) <= 128
            or not name.isascii()
            or not (name[0].isalpha() or name[0] == "_")
            or not all(character.isalnum() or character == "_" for character in name)
            or name in FORBIDDEN_GATEWAY_ENVIRONMENT
            or name.startswith("MINISANDBOX_")
        ):
            raise ValueError("Hermes gateway environment name is invalid")
        if (
            not isinstance(value, str)
            or "\x00" in value
            or len(value.encode()) > MAX_GATEWAY_ENVIRONMENT_VALUE_BYTES
        ):
            raise ValueError(f"Hermes gateway environment value for {name} is invalid")
        validated[name] = value
    return validated


def run_request(request: dict[str, object]) -> dict[str, object]:
    prompt, provider, model, credential_env, credential, base_url = validate_request(request)
    from hermes_cli.oneshot import run_oneshot

    environment = {
        credential_env: credential,
        "HERMES_IGNORE_RULES": "1",
        "HERMES_IGNORE_USER_CONFIG": "1",
    }
    if base_url:
        environment["OPENROUTER_BASE_URL"] = base_url
    previous = {name: os.environ.get(name) for name in environment}
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        os.environ.update(environment)
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = run_oneshot(prompt, model=model, provider=provider, toolsets=[])
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    return {"exit_code": exit_code, "stdout": stdout.getvalue(), "stderr": stderr.getvalue()}


def launch_gateway(environment: dict[str, str]) -> None:
    # This state is clone-private: the credential-free template was already
    # sealed, and the listener accepts exactly one gateway handoff before it is
    # closed. Keep the canonical upstream lifecycle instead of implementing a
    # second agent/server inside the PVM bootstrap.
    os.environ.update(environment)
    marker("MINISANDBOX_HERMES_GATEWAY_LAUNCHING")
    from hermes_cli.gateway import run_gateway

    run_gateway(force=True)


def serve(listener: socket.socket) -> None:
    one_shot_attempted = False
    while True:
        connection, _ = listener.accept()
        gateway_environment: dict[str, str] | None = None
        with connection:
            connection.settimeout(SOCKET_TIMEOUT_SECONDS)
            try:
                request = read_frame(connection)
                connection.settimeout(None)
                if request.get("operation") == "gateway":
                    if one_shot_attempted:
                        raise ValueError(
                            "Hermes gateway handoff requires a pristine restored clone"
                        )
                    environment = validate_gateway_request(request)
                    write_frame(connection, {"accepted": True, "pid": os.getpid()})
                    gateway_environment = environment
                else:
                    one_shot_attempted = True
                    response = run_request(request)
            except Exception as error:
                response = {"exit_code": 1, "stdout": "", "stderr": f"{error}\n"}
            if gateway_environment is None:
                try:
                    write_frame(connection, response)
                except (BrokenPipeError, ConnectionError, OSError):
                    pass
        if gateway_environment is not None:
            listener.close()
            try:
                SOCKET_PATH.unlink()
            except FileNotFoundError:
                pass
            launch_gateway(gateway_environment)
            return


def main() -> None:
    if os.getuid() != 0 or os.getgid() != 0:
        raise RuntimeError("warm publisher must start with guest supervisor credentials")
    if not Path("/sbin/minisandbox-init").is_file():
        raise RuntimeError("minisandbox init is missing")
    if not PROFILE_ROOT.is_dir():
        raise RuntimeError("Hermes profile root is missing")

    control = os.open("/dev/minisandbox", os.O_RDWR | os.O_CLOEXEC)
    identity = pwd.getpwnam("hermes")
    listener = create_listener(identity.pw_uid, identity.pw_gid)
    os.chdir(PROFILE_ROOT)
    drop_to_hermes()

    preload_started = time.monotonic()
    import hermes_cli.oneshot  # noqa: F401
    import hermes_cli.gateway  # noqa: F401
    import run_agent  # noqa: F401
    from agent.process_bootstrap import _load_openai_cls
    from tools import env_probe

    # These caches depend only on the pinned image. Hermes publishes the probe
    # result just before its worker exits, so explicitly join that worker before
    # applying the thread/FD checkpoint audit below.
    _load_openai_cls()
    env_probe.get_environment_probe_line()
    probe_worker = getattr(env_probe, "_PROBE_THREAD", None)
    if probe_worker is not None:
        probe_worker.join(timeout=5)
        if probe_worker.is_alive():
            raise RuntimeError("Hermes environment probe did not quiesce")

    version = importlib.metadata.version("hermes-agent")
    revision_path = Path("/opt/hermes/.hermes_build_sha")
    revision = revision_path.read_text(encoding="utf-8").strip()
    if len(revision) != 40:
        raise RuntimeError("missing pinned Hermes build revision")
    preload_ms = (time.monotonic() - preload_started) * 1000
    assert_checkpoint_boundary(control, listener)
    # `/opt/data` may be covered by a clone-specific ActorVolume after restore.
    # Do not retain the template directory as cwd across that mount boundary.
    os.chdir("/")
    marker(
        f"MINISANDBOX_HERMES_WARM_READY version={version} revision={revision} "
        f"preload_ms={preload_ms:.3f}"
    )
    fcntl.ioctl(control, CHECKPOINT_IOCTL, 0)
    fcntl.ioctl(control, BENCHMARK_POINT_IOCTL, 0)
    os.close(control)
    marker("MINISANDBOX_HERMES_RESUMED")
    serve(listener)


if __name__ == "__main__":
    main()
