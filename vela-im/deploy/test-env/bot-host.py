"""Dev-machine Bot host for collaboration's `--bot-host-command`: one local Hermes runs every Bot as a profile.

Same JSON contract as CTL's /internal/vela-im/bots:{verify,deliver,revoke}: request on stdin, result on stdout.
The credential arrives only on stdin and is written into the profile with mode 0600; it is never printed.

LightVela instances live in the cloud, so on this machine an (instanceId, botId) pair maps to a local profile
`vb-<hash>`. There is no CTL to prove instance ownership; set VELA_DEV_ALLOWED_ACCOUNTS (comma-separated usr_ IDs)
to limit who may provision Bots here.
"""
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import yaml

HOME = Path(os.environ["HERMES_HOME"])
HERMES_BIN = os.environ.get("VELA_HERMES_BIN") or str(HOME / "hermes-agent" / "venv" / "bin" / "hermes")
PLUGIN_DIR = Path(os.environ["VELA_PLUGIN_DIR"])
RESTART_COMMAND = os.environ.get("VELA_HERMES_RESTART_COMMAND", "")
ALLOWED_ACCOUNTS = {item.strip() for item in os.environ.get("VELA_DEV_ALLOWED_ACCOUNTS", "").split(",") if item.strip()}
RESTART_MARKER = HOME / "vela-im-restart.requested"
RESTART_DELAY_SECONDS = 3


def profile_name(instance_id, bot_id):
    return "vb-" + hashlib.sha256(f"{instance_id}/{bot_id}".encode()).hexdigest()[:20]


def load_yaml(path):
    return (yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else None) or {}


def dump_yaml(path, data):
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    os.chmod(path, 0o600)


def create_profile(name, display_name):
    profile = HOME / "profiles" / name
    if profile.is_dir():
        return profile
    env = {**os.environ, "HERMES_HOME": str(HOME)}
    env.pop("HERMES_PROFILE", None)
    subprocess.run(
        [HERMES_BIN, "profile", "create", name, "--clone", "--clone-from", "default", "--no-alias"],
        env=env, check=True, timeout=180, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
    )
    if not profile.is_dir():
        raise RuntimeError(f"Hermes did not create profile {name}")
    (profile / "SOUL.md").write_text(
        f"你是 {display_name}，LightVela 上的一个 Agent。你在 Vela IM 里有自己的身份，可以和人以及其他 Agent 单聊或在群里交流。"
        "当前消息正常回复即可，回答会自动发回当前会话；需要主动发消息、查看会话或管理群时使用 vela_im 命令行。"
        "不要汇报内部 ID 或工具状态。\n",
        encoding="utf-8",
    )
    return profile


def install_plugin(profile):
    target = profile / "plugins" / "vela-im"
    shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(PLUGIN_DIR, target, ignore=shutil.ignore_patterns("__pycache__", "tests"))


def enable_plugin(profile):
    path = profile / "config.yaml"
    config = load_yaml(path)
    plugins = config.setdefault("plugins", {})
    enabled = list(plugins.get("enabled") or [])
    if "vela-im" not in enabled:
        enabled.append("vela-im")
    plugins["enabled"] = enabled
    config.setdefault("platforms", {})["vela_im"] = {"enabled": True}
    config.setdefault("platform_toolsets", {})["vela_im"] = ["all"]
    config.setdefault("display", {}).setdefault("platforms", {})["vela_im"] = {"show_reasoning": False}
    dump_yaml(path, config)


def write_profile_env(profile, owner):
    """Hermes drops every sender of a plugin platform without an allowlist; who may reach the Bot is decided by the
    platform (group membership, reply rules, command policy), so the profile opens the Hermes gate. Cron results and
    cross-platform notices go to the owner's direct chat."""
    path = profile / ".env"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    lines = [line for line in lines if not line.startswith(("VELA_ALLOW_ALL_USERS=", "VELA_HOME_CHANNEL="))]
    lines.append("VELA_ALLOW_ALL_USERS=true")
    if owner:
        lines.append("VELA_HOME_CHANNEL=C2C" + owner)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def ensure_multiplex():
    """Secondary profiles only run inside the default profile's gateway when multiplexing is on."""
    path = HOME / "config.yaml"
    config = load_yaml(path)
    if (config.get("gateway") or {}).get("multiplex_profiles") is True:
        return
    config.setdefault("gateway", {})["multiplex_profiles"] = True
    dump_yaml(path, config)


def write_delivery(profile, request):
    data = profile / "plugin-data" / "vela-im"
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    credential = data / "credential"
    temp = credential.with_suffix(".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(request["credential"] + "\n")
    temp.replace(credential)
    config = {
        "apiBaseUrl": request["apiBaseUrl"],
        "botAgentId": request["botAgentId"],
        "imUserId": request["imUserId"],
        "sdkAppId": request["sdkAppId"],
    }
    (data / "config.json").write_text(json.dumps(config), encoding="utf-8")


def schedule_restart():
    """Restart the shared gateway shortly after the last change; deliveries close together share one restart."""
    if not RESTART_COMMAND:
        return
    RESTART_MARKER.write_text(str(time.time()), encoding="utf-8")
    subprocess.Popen(
        [sys.executable, __file__, "--restart"], start_new_session=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def restart_when_quiet():
    requested = RESTART_MARKER.stat().st_mtime
    time.sleep(RESTART_DELAY_SECONDS)
    if RESTART_MARKER.stat().st_mtime > requested:
        return
    with open(HOME / "vela-im-restart.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if RESTART_MARKER.stat().st_mtime > requested:
            return
        subprocess.run(["sh", "-c", RESTART_COMMAND], timeout=180, check=False)


def handle(request):
    action = request.get("action")
    instance_id, bot_id = request.get("instanceId") or "", request.get("botId") or ""
    if not instance_id or not bot_id:
        return {"error": "instanceId and botId are required"}
    if action == "verify":
        owned = not ALLOWED_ACCOUNTS or request.get("accountSubject") in ALLOWED_ACCOUNTS
        return {"owned": owned, "displayName": request.get("displayName") or bot_id}
    name = profile_name(instance_id, bot_id)
    if action == "deliver":
        profile = create_profile(name, request.get("displayName") or bot_id)
        install_plugin(profile)
        write_delivery(profile, request)
        enable_plugin(profile)
        write_profile_env(profile, request.get("ownerImUserId") or "")
        ensure_multiplex()
        schedule_restart()
        return {}
    if action == "revoke":
        credential = HOME / "profiles" / name / "plugin-data" / "vela-im" / "credential"
        if credential.exists():
            credential.unlink()
            schedule_restart()
        return {}
    return {"error": f"unknown action {action!r}"}


def main():
    if sys.argv[1:] == ["--restart"]:
        restart_when_quiet()
        return 0
    try:
        result = handle(json.load(sys.stdin))
    except Exception as error:  # noqa: BLE001 - the caller only needs a one-line reason
        result = {"error": f"{type(error).__name__}: {error}"}
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
