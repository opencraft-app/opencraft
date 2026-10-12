"""Per-Agent IM runtime: each Hermes profile's identity gets exactly one Node worker in this process."""
import os
import threading
from contextvars import ContextVar
from pathlib import Path

from .vela_im import AgentWorker, VelaClient, token_stamp

outbound_lineage = ContextVar("vela_outbound_lineage", default=None)
current_delivery = ContextVar("vela_current_delivery", default=None)

_workers = {}
_guard = threading.Lock()


def setting(name, default=""):
    """Profile-scoped secret under gateway.multiplex_profiles; plain environment elsewhere."""
    try:
        from gateway.platforms._shared import get_scoped_secret
        return get_scoped_secret(name, default)
    except ImportError:
        return os.getenv(name, default)


def hermes_home():
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except ImportError:
        return Path(os.getenv("HERMES_HOME", str(Path.home() / ".hermes")))


def worker_for(url=None, token=None):
    """The worker for the current profile's identity. Starting it is deferred to first use."""
    url = url or setting("VELA_API_URL")
    token = token or setting("VELA_IDENTITY_TOKEN")
    if not token:
        raise ValueError("VELA_IDENTITY_TOKEN is not configured for this Hermes profile")
    key = token_stamp(token)
    with _guard:
        worker = _workers.get(key)
        if worker is None:
            worker = _workers[key] = AgentWorker(url, token, hermes_home() / "plugin-data" / "vela-im" / key)
        return worker


def client_for(url=None, token=None):
    """A client bound to this profile's worker; launches the worker if the Agent has none yet."""
    worker = worker_for(url, token)
    return VelaClient(worker.start(), worker=worker)
