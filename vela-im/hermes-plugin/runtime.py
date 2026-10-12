"""Per-Agent IM runtime: each Hermes profile's Bot gets exactly one Node worker in this process.

The platform delivers two files into the profile: plugin-data/vela-im/credential (0600) and config.json (backend URL
and IM identity). The worker reads the credential itself; neither the model nor its terminal commands ever see it.
"""
import os
import shlex
import stat
import sys
import threading
from contextvars import ContextVar
from pathlib import Path

from .vela_im import AgentWorker, delivered_config, state_dir_for

outbound_lineage = ContextVar("vela_outbound_lineage", default=None)

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


def state_dir():
    return state_dir_for(hermes_home())


def credential_file():
    return Path(setting("VELA_BOT_CREDENTIAL_FILE") or state_dir() / "credential")


def api_url():
    return setting("VELA_API_URL") or delivered_config(state_dir()).get("apiBaseUrl", "")


def configured():
    """True once the platform has delivered this profile's Bot credential and backend URL."""
    return credential_file().is_file() and bool(api_url())


def worker_for():
    """The worker for the current profile's Bot. Starting it is deferred to first use."""
    directory = state_dir()
    with _guard:
        worker = _workers.get(str(directory))
        if worker is None:
            worker = _workers[str(directory)] = AgentWorker(
                api_url(), credential_file(), directory, setting("VELA_FILE_ROOT") or None,
            )
        return worker


def install_cli():
    """Put a `vela_im` launcher next to Hermes' Python, which Hermes keeps on PATH for every terminal command.

    The launcher carries no identity: the CLI resolves the Agent from HERMES_HOME at run time.
    """
    package_root = Path(__file__).resolve().parent
    target = Path(sys.executable).parent / "vela_im"
    script = (
        "#!/bin/sh\n"
        f"exec {shlex.quote(sys.executable)} -c "
        f"{shlex.quote(f'import sys; sys.path.insert(0, {str(package_root)!r}); from vela_im.cli import main; sys.exit(main())')}"
        ' "$@"\n'
    )
    try:
        if target.exists() and target.read_text() == script:
            return target
        temp = target.with_suffix(".tmp")
        temp.write_text(script)
        temp.chmod(temp.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        temp.replace(target)
        return target
    except OSError:
        return None
