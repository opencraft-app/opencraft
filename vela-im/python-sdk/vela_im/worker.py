"""Launch and supervise the Node worker that holds one Bot's Tencent IM login.

The worker is bound to the process that starts it: it receives this process's PID and exits when the process is gone.
It serves the Agent over a Unix socket whose permissions (0600) are the access boundary; worker.json in the Bot's
state directory records where the socket is.
"""
import http.client
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

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
    socket: str
    pid: int
    user_id: str | None


class UnixHTTPConnection(http.client.HTTPConnection):
    """HTTP/1.1 over a Unix domain socket."""

    def __init__(self, socket_path, timeout=65):
        super().__init__("worker.local", timeout=timeout)
        self.socket_path = socket_path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.socket_path)
        self.sock = sock


def socket_request(socket_path, method, path, body=None, timeout=65):
    """Returns (status, decoded JSON) for one request to the worker."""
    connection = UnixHTTPConnection(socket_path, timeout)
    try:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        headers = {"Content-Type": "application/json"} if data is not None else {}
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        return response.status, (json.loads(raw) if raw else None)
    finally:
        connection.close()


def read_endpoint(state_dir):
    """The endpoint of a healthy worker for this Bot, whoever started it; None when no worker is serving."""
    try:
        info = json.loads((Path(state_dir) / "worker.json").read_text())
    except (OSError, ValueError):
        return None
    pid = int(info.get("pid", 0))
    if not info.get("ready") or not info.get("socket") or not _alive(pid):
        return None
    endpoint = WorkerEndpoint(info["socket"], pid, info.get("userID"))
    try:
        status, health = socket_request(endpoint.socket, "GET", "/health", timeout=5)
    except (OSError, ValueError, http.client.HTTPException):
        return None
    return endpoint if status == 200 and health.get("ready") and health.get("pid") == pid else None


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
    """One Bot credential file -> one state directory -> at most one running worker."""

    _locks = {}
    _locks_guard = threading.Lock()

    def __init__(self, api_url, credential_file, state_dir, file_root=None, node=None, script=None):
        if not api_url or not str(api_url).startswith(("http://", "https://")):
            raise ValueError("Vela API URL must be an http(s) URL")
        self.api_url = str(api_url).rstrip("/")
        self.credential_file = Path(credential_file)
        self.state_dir = Path(state_dir)
        self.file_root = str(file_root) if file_root else None
        self.node = node
        self.script = Path(script) if script else WORKER_SCRIPT
        self.process = None
        with AgentWorker._locks_guard:
            self._lock = AgentWorker._locks.setdefault(str(self.state_dir.resolve()), threading.Lock())

    @property
    def log_path(self):
        return self.state_dir / "worker.log"

    def running(self):
        return read_endpoint(self.state_dir)

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
        if not self.credential_file.is_file():
            raise WorkerError(f"Bot credential missing: {self.credential_file}")
        node = node_binary(self.node)
        if self.log_path.exists() and self.log_path.stat().st_size > 5 * 1024 * 1024:
            self.log_path.unlink()
        (self.state_dir / "worker.json").unlink(missing_ok=True)
        env = {**os.environ, "VELA_API_URL": self.api_url, "VELA_BOT_CREDENTIAL_FILE": str(self.credential_file),
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
