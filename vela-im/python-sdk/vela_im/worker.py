"""Launch and supervise the Node worker that holds one identity's Tencent IM login.

The worker is bound to the process that starts it: it receives this process's PID and exits when the
process is gone. Several Python objects (an adapter and tool calls) reuse one running worker per identity.
"""
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

try:
    import fcntl
except ImportError:  # Windows: the in-process lock still prevents duplicate launches from one runtime.
    fcntl = None

WORKER_SCRIPT = Path(__file__).resolve().parent / "_worker" / "vela-im-worker.mjs"
MIN_NODE = (22, 16)


class WorkerError(RuntimeError):
    pass


@dataclass(frozen=True)
class WorkerEndpoint:
    url: str
    secret: str
    pid: int
    user_id: str | None


def token_stamp(token):
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def default_state_dir(token):
    return Path.home() / ".vela-im" / token_stamp(token)


def validate_api_url(url):
    parsed = urlsplit(url or "")
    if parsed.scheme not in ("https", "http") or not parsed.netloc:
        raise ValueError("VELA_API_URL must be an http(s) URL")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Use HTTPS for a remote identity service, or an SSH loopback tunnel")
    return url.rstrip("/")


def node_binary(explicit=None):
    node = explicit or os.getenv("VELA_NODE_BIN") or shutil.which("node")
    if not node:
        raise WorkerError("Node.js >= 22.16 is required for the Vela IM worker (set VELA_NODE_BIN)")
    version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout.strip().lstrip("v")
    if tuple(int(part) for part in version.split(".")[:2]) < MIN_NODE:
        raise WorkerError(f"Node.js {version} found; the Vela IM worker needs >= 22.16")
    return node


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


class AgentWorker:
    """One identity token -> one state directory -> at most one running worker."""

    _locks = {}
    _locks_guard = threading.Lock()

    def __init__(self, api_url, token, state_dir=None, file_root=None, node=None, script=None):
        if not token:
            raise ValueError("VELA_IDENTITY_TOKEN is not configured")
        self.api_url = validate_api_url(api_url)
        self.token = token
        self.state_dir = Path(state_dir) if state_dir else default_state_dir(token)
        self.file_root = str(file_root) if file_root else None
        self.node = node
        self.script = Path(script) if script else WORKER_SCRIPT
        self.process = None
        with AgentWorker._locks_guard:
            self._lock = AgentWorker._locks.setdefault(str(self.state_dir.resolve()), threading.Lock())

    @property
    def runtime_path(self):
        return self.state_dir / "worker.json"

    @property
    def log_path(self):
        return self.state_dir / "worker.log"

    def running(self):
        """The endpoint of a healthy worker for this identity, whoever started it."""
        try:
            info = json.loads(self.runtime_path.read_text())
        except (OSError, ValueError):
            return None
        if not info.get("ready") or not _alive(int(info.get("pid", 0))):
            return None
        endpoint = WorkerEndpoint(f"http://127.0.0.1:{int(info['port'])}", info["secret"], int(info["pid"]), info.get("userID"))
        try:
            request = Request(endpoint.url + "/health", headers={"Authorization": "Bearer " + endpoint.secret})
            with urlopen(request, timeout=5) as response:
                health = json.load(response)
        except (OSError, URLError, ValueError):
            return None
        return endpoint if health.get("ready") and health.get("pid") == endpoint.pid else None

    def start(self, timeout=90):
        with self._lock:
            self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            with open(self.state_dir / "worker.lock", "a+") as lock:
                if fcntl:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                endpoint = self.running()
                if endpoint:
                    return endpoint
                return self._spawn(timeout)

    def _spawn(self, timeout):
        if not self.script.is_file():
            raise WorkerError(f"Worker bundle missing: {self.script}")
        node = node_binary(self.node)
        if self.log_path.exists() and self.log_path.stat().st_size > 5 * 1024 * 1024:
            self.log_path.unlink()
        self.runtime_path.unlink(missing_ok=True)
        env = {**os.environ, "VELA_API_URL": self.api_url, "VELA_IDENTITY_TOKEN": self.token,
               "VELA_WORKER_DIR": str(self.state_dir), "VELA_WORKER_PARENT_PID": str(os.getpid())}
        if self.file_root:
            env["VELA_FILE_ROOT"] = self.file_root
        log = open(self.log_path, "ab")
        try:
            self.process = subprocess.Popen([node, "--disable-warning=ExperimentalWarning", str(self.script)],
                                            stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, cwd=str(self.state_dir))
        finally:
            log.close()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise WorkerError(f"Vela IM worker exited with code {self.process.returncode}: {self._log_tail()}")
            endpoint = self.running()
            if endpoint and endpoint.pid == self.process.pid:
                return endpoint
            time.sleep(0.2)
        self.stop()
        raise WorkerError(f"Vela IM worker did not come online within {timeout}s: {self._log_tail()}")

    def _log_tail(self, lines=8):
        try:
            return " | ".join(self.log_path.read_text(errors="replace").strip().splitlines()[-lines:])
        except OSError:
            return ""

    def stop(self, timeout=10):
        """Stop the worker if this object started it. A worker owned by another process is left alone."""
        process, self.process = self.process, None
        if not process or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(5)
