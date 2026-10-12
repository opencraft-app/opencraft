package instance

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"
)

const (
	rootProfileID                  = "main"
	defaultHermesProfileID         = "default"
	instanceBotStatusReady         = "ready"
	instanceBotStatusDeleted       = "deleted"
	instanceBotCreatedFromBlank    = "blank"
	instanceBotCreatedFromClone    = "clone"
	uniqueChannelWeixin            = "weixin"
	uniqueChannelWhatsApp          = "whatsapp"
	maxInstanceBotNameRunes        = 60
	maxInstanceBotDescriptionRunes = 256
	maxInstanceBotSoulRunes        = 12000
)

func (l *logic) execHermesProfileCommand(ctx pctx.Context, instanceID, command string) (*transport.ExecDebugCommandResponse, error) {
	// Profile management must follow the instance Pool's regional TAT route; envd is not universal across regions.
	return l.ExecDebugCommandWithBackend(ctx, instanceID, command, "agentuser", debugExecutionBackendTAT)
}

type hermesProfileRecord struct {
	NativeID       string `json:"native_id"`
	DisplayName    string `json:"display_name"`
	Description    string `json:"description"`
	IsDefault      bool   `json:"is_default"`
	GatewayRunning *bool  `json:"gateway_running"`
	ModifiedAt     string `json:"modified_at"`
}

type hermesProfileListPayload struct {
	Items []hermesProfileRecord `json:"items"`
}

type hermesInstanceBotsPayload struct {
	Kind          string                            `json:"kind"`
	Items         *[]hermesProfileRecord            `json:"items"`
	WeixinOwners  map[string]*channelBindingPayload `json:"weixin_owners"`
	WhatsAppOwner *channelBindingPayload            `json:"whatsapp_owner"`
}

type channelBindingPayload struct {
	OK            bool   `json:"ok"`
	Reason        string `json:"reason"`
	Channel       string `json:"channel"`
	BotID         string `json:"bot_id"`
	ProfileID     string `json:"profile_id"`
	Status        string `json:"status"`
	ReservationID string `json:"reservation_id"`
}

const writeInitialSoulScript = `from pathlib import Path
import base64
import os
import sys

path = Path(sys.argv[1])
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(base64.b64decode(sys.argv[2]).decode("utf-8"), encoding="utf-8")
os.chmod(path, 0o600)
`

const checkHermesProfileCapabilityCommand = "hermes profile create --help >/dev/null && hermes profile delete --help >/dev/null"

const alignBlankProfileSkillsScript = `from pathlib import Path
import shutil
import sys

home = Path(sys.argv[1])
target_profile = Path(sys.argv[2])
root_skills = home / "skills"
target_skills = target_profile / "skills"
baseline_manifest = home / ".lightvela" / "base-skills"

def safe_relative_path(raw):
    value = raw.strip()
    if not value:
        return None
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        return None
    return relative

def infer_legacy_baseline():
    bundled_names = set()
    bundled_manifest = root_skills / ".bundled_manifest"
    if bundled_manifest.is_file():
        for line in bundled_manifest.read_text(encoding="utf-8").splitlines():
            name = line.partition(":")[0].strip()
            if name:
                bundled_names.add(name)

    inferred = set()
    if root_skills.is_dir():
        for skill_file in root_skills.rglob("SKILL.md"):
            relative = skill_file.parent.relative_to(root_skills)
            if skill_file.parent.name in bundled_names or relative.as_posix() == "website-builder":
                inferred.add(relative)
    return inferred

baseline = set()
if baseline_manifest.is_file():
    for line in baseline_manifest.read_text(encoding="utf-8").splitlines():
        relative = safe_relative_path(line)
        if relative is not None:
            baseline.add(relative)
else:
    baseline = infer_legacy_baseline()

if not baseline:
    raise RuntimeError("LightVela base skills could not be resolved")

missing_sources = [
    relative.as_posix()
    for relative in baseline
    if not (target_skills / relative / "SKILL.md").is_file()
    and not (root_skills / relative / "SKILL.md").is_file()
]
if missing_sources:
    raise RuntimeError(
        "LightVela base skills are missing: " + ", ".join(sorted(missing_sources))
    )

if target_skills.is_dir():
    target_skill_dirs = sorted(
        {skill_file.parent for skill_file in target_skills.rglob("SKILL.md")},
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for skill_dir in target_skill_dirs:
        relative = skill_dir.relative_to(target_skills)
        if relative not in baseline:
            shutil.rmtree(skill_dir)

target_skills.mkdir(parents=True, exist_ok=True)
for relative in sorted(baseline, key=lambda path: path.as_posix()):
    source = root_skills / relative
    destination = target_skills / relative
    if (destination / "SKILL.md").is_file():
        continue
    if destination.exists():
        if destination.is_dir():
            shutil.rmtree(destination)
        else:
            destination.unlink()
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)

print(f"Aligned {len(baseline)} LightVela base skills")
`

const hermesProfileListFunctions = `import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets

import httpx

async def list_hermes_profiles():
    token = secrets.token_urlsafe(32)
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = token

    from hermes_cli.web_server import app

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1", timeout=15.0) as client:
        response = await client.get(
            "/api/profiles",
            headers={"X-Hermes-Session-Token": token},
        )
    response.raise_for_status()
    profiles = response.json().get("profiles")
    if not isinstance(profiles, list):
        raise RuntimeError("Hermes GET /api/profiles returned an invalid payload")

    items = []
    for profile in profiles:
        raw_path = profile.get("path", "")
        try:
            modified = datetime.fromtimestamp(Path(raw_path).stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z") if raw_path else ""
        except OSError:
            modified = ""
        items.append({
            "native_id": profile.get("name", ""),
            "display_name": profile.get("display_name", ""),
            "description": profile.get("description", ""),
            "is_default": bool(profile.get("is_default", False)),
            "gateway_running": bool(profile["gateway_running"]) if "gateway_running" in profile else None,
            "modified_at": modified,
        })
    return {"items": items}
`

const listHermesProfilesScript = hermesProfileListFunctions + `
print(json.dumps(asyncio.run(list_hermes_profiles()), ensure_ascii=False))
`

const writeHermesProfileMetadataScript = `import json
import sys
from hermes_cli.profiles import get_profile_dir, write_profile_meta

profile_id = sys.argv[1]
fields = json.loads(sys.argv[2])
write_profile_meta(get_profile_dir(profile_id), **fields)
print(json.dumps({"ok": True}))
`

const hermesChannelBindingFunctions = weixinAccountBindingFunctions + `import contextlib
import fcntl
import json
import os
from pathlib import Path
import secrets
import sys
from datetime import datetime, timedelta, timezone


def manage_channel_binding(action, channel, bot_id, profile_id, default_bot_id, reservation_id=""):
    # QR waits for at most 180 seconds; a longer lease tolerates delayed TAT completion.
    reservation_ttl = timedelta(minutes=10)
    home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
    root = home / ".lightvela" / "channel-bindings"
    root.mkdir(parents=True, exist_ok=True)
    path = root / (channel + ".json")
    lock_path = root / (channel + ".lock")
    scan_lock_path = root / "whatsapp-qr.lock"
    legacy_marker = root / "whatsapp-legacy-checked-v2"
    profile_id = profile_id or "default"
    bindings = {}

    def scan_busy():
        if channel != "whatsapp":
            return False
        with scan_lock_path.open("a") as scan_lock:
            try:
                fcntl.flock(scan_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            return False

    def read_current():
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                return None
            if channel == "weixin":
                if isinstance(value.get("bindings"), dict):
                    bindings.clear()
                    bindings.update(value["bindings"])
                elif value.get("bot_id"):
                    # Preserve the owner written by the former instance-wide format.
                    bindings[value.get("profile_id") or "default"] = value
                return bindings.get(profile_id)
            return value
        except (OSError, ValueError):
            return None

    def write_current(value):
        if channel == "weixin":
            bindings[profile_id] = value
            value = {"bindings": bindings}
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)

    def clear_current():
        if channel == "weixin":
            bindings.pop(profile_id, None)
            if bindings:
                temporary = path.with_suffix(".tmp")
                temporary.write_text(json.dumps({"bindings": bindings}, ensure_ascii=False), encoding="utf-8")
                os.chmod(temporary, 0o600)
                temporary.replace(path)
                return
        path.unlink(missing_ok=True)

    def whatsapp_credentials_path(native_profile_id):
        # ACLI --agent selects $HERMES_HOME/profiles/<id> for a named profile.
        default_home = home if native_profile_id in ("", "default", "main") else home / "profiles" / native_profile_id
        runtime_home = Path(os.environ.get("ACLI_RUNTIME_HOME", str(default_home)))
        auth_dir = Path(os.environ.get("ACLI_WHATSAPP_AUTH_DIR", str(runtime_home / "whatsapp" / "session")))
        return auth_dir / "creds.json"

    def fresh_legacy_credentials(binding):
        credentials = whatsapp_credentials_path(binding.get("profile_id", "default"))
        try:
            # No-token confirms must not consume a newer same-Bot reservation
            # using credentials that predate that reservation.
            return credentials.stat().st_mtime_ns >= int(datetime.fromisoformat(binding["updated_at"]).timestamp() * 1_000_000_000)
        except (OSError, KeyError, TypeError, ValueError):
            return False

    with contextlib.ExitStack() as locks:
        # A rejected Profile may need slow gateway recovery. Serialize only its
        # mutations while releasing the instance metadata lock around CLI calls.
        if channel == "weixin" and action != "get":
            operation = locks.enter_context((root / ("weixin-" + profile_id + ".lock")).open("a"))
            try:
                fcntl.flock(operation.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"ok": False, "reason": "scan_in_progress"}
        lock = locks.enter_context(lock_path.open("a", encoding="utf-8"))
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        def gateway_command(args, timeout):
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            try:
                subprocess.run(args, check=True, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return True
            except (OSError, subprocess.SubprocessError):
                return False
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                bindings.clear()
                read_current()

        current = read_current()
        if channel == "weixin":
            return manage_weixin_account(action, home, root, profile_id, bot_id, reservation_id, current, bindings, write_current, clear_current, gateway_command)
        if channel == "whatsapp" and not legacy_marker.exists():
            if not current and whatsapp_credentials_path("default").is_file():
                current = {
                    "ok": True,
                    "channel": channel,
                    "bot_id": default_bot_id,
                    "profile_id": "default",
                    "status": "connected",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                write_current(current)
            legacy_marker.touch(mode=0o600)
        if channel == "whatsapp" and current and current.get("status") == "reserved":
            try:
                updated_at = datetime.fromisoformat(current["updated_at"])
                expired = datetime.now(timezone.utc) - updated_at >= reservation_ttl
            except (KeyError, TypeError, ValueError):
                expired = True
            if expired and not scan_busy():
                if whatsapp_credentials_path(current.get("profile_id", "default")).is_file():
                    # The QR process may have connected while its browser disappeared.
                    # Preserve ownership rather than allow a second Bot to scan.
                    current["status"] = "connected"
                    current["updated_at"] = datetime.now(timezone.utc).isoformat()
                    current.pop("reservation_id", None)
                    write_current(current)
                else:
                    path.unlink(missing_ok=True)
                    current = None
        if action == "get":
            result = current or {"ok": True}
        elif action == "claim":
            if (channel == "whatsapp" and scan_busy()) or (current and (current.get("bot_id") != bot_id or (channel == "whatsapp" and current.get("status") == "reserved"))):
                result = {"ok": False, "reason": "occupied", "bot_id": current.get("bot_id", "") if current else ""}
            else:
                result = {
                    "ok": True,
                    "channel": channel,
                    "bot_id": bot_id,
                    "profile_id": profile_id,
                    "status": "reserved" if channel == "whatsapp" else (current.get("status", "reserved") if current else "reserved"),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                if channel == "whatsapp":
                    result["reservation_id"] = secrets.token_urlsafe(24)
                write_current(result)
        elif action == "confirm":
            may_confirm = bool(current and current.get("bot_id") == bot_id)
            if channel == "whatsapp" and may_confirm:
                # Both client generations require the reserved scan's actual credentials.
                # Tokenized clients must also match their scan; old browsers have no token.
                may_confirm = current.get("status") == "reserved" and (
                    current.get("reservation_id") == reservation_id if reservation_id else fresh_legacy_credentials(current)
                ) and whatsapp_credentials_path(current.get("profile_id", "default")).is_file() and not scan_busy()
            if not may_confirm:
                result = {"ok": False, "reason": "owner_mismatch"}
            else:
                current.update({"ok": True, "status": "connected", "updated_at": datetime.now(timezone.utc).isoformat()})
                current.pop("reservation_id", None)
                write_current(current)
                result = current
        elif action in ("release", "release_reserved", "disconnect"):
            may_release = current and current.get("bot_id") == bot_id
            result = {"ok": True}
            if channel == "whatsapp":
                if scan_busy():
                    # A stale browser failure must not drop a live QR command's owner.
                    result = {"ok": False, "reason": "scan_in_progress"}
                    may_release = False
                # A legacy DELETE has no lease or intent: never let it delete a
                # reservation. A connected owner can be cleared only if the actual
                # credentials are gone and no QR/delete request is in flight.
                rollback = action == "release" and reservation_id and may_release and current.get("status") == "reserved" and current.get("reservation_id") == reservation_id
                credentials_present = may_release and whatsapp_credentials_path(current.get("profile_id", "default")).is_file()
                if rollback and credentials_present:
                    # A scan completed but its confirm failed in transit. Preserve ownership.
                    current["status"] = "connected"
                    current["updated_at"] = datetime.now(timezone.utc).isoformat()
                    current.pop("reservation_id", None)
                    write_current(current)
                disconnected = may_release and current.get("status") == "connected" and not credentials_present
                may_release = (rollback and not credentials_present) or (action in ("release", "disconnect") and disconnected)
                if action == "disconnect" and current and current.get("bot_id") == bot_id and not may_release and result["ok"]:
                    result = {"ok": False, "reason": "credentials_present" if credentials_present else "not_connected"}
            elif action == "release_reserved":
                may_release = may_release and current.get("status") == "reserved"
            if may_release:
                clear_current()
        else:
            result = {"ok": False, "reason": "unsupported_action"}
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    return result
`

const manageChannelBindingScript = hermesChannelBindingFunctions + `
print(json.dumps(manage_channel_binding(*sys.argv[1:7]), ensure_ascii=False))
`

// One interpreter and one regional TAT execution; preserve the existing ordered
// Profile read and per-channel locking/reconciliation, never return a partial list.
const listHermesInstanceBotsScript = `import os
instance_environment = dict(os.environ)
` + hermesProfileListFunctions + hermesChannelBindingFunctions + `
try:
    profiles = asyncio.run(list_hermes_profiles())
finally:
    # The official API may load Profile-local dotenv configuration. Previously
    # each binding action was a new process with the instance's original env.
    os.environ.clear()
    os.environ.update(instance_environment)
weixin_owners = {
    item["native_id"]: manage_channel_binding("get", "weixin", "", item["native_id"], sys.argv[1])
    for item in profiles["items"]
}
whatsapp = manage_channel_binding("get", "whatsapp", "", "default", sys.argv[1])
print(json.dumps({
    "kind": "lightvela.instance-bots.v1",
    "items": profiles["items"],
    "weixin_owners": weixin_owners,
    "whatsapp_owner": whatsapp,
}, ensure_ascii=False))
`

const sanitizeClonedProfileEnvScript = `from pathlib import Path
import os
import re
import sys

from hermes_cli.config import OPTIONAL_ENV_VARS

env_path = Path(sys.argv[1])
if not env_path.is_file():
    raise SystemExit(0)
channel_keys = {
    name
    for name, metadata in OPTIONAL_ENV_VARS.items()
    if metadata.get("category") == "messaging"
}
channel_prefixes = (
    "A2A_", "API_SERVER_", "BLUEBUBBLES_", "BUZZ_", "DINGTALK_",
    "DISCORD_", "EMAIL_", "FEISHU_", "GOOGLE_CHAT_", "HASS_", "IRC_",
    "LINE_", "MATRIX_", "MATTERMOST_", "NTFY_", "PHOTON_", "QQ_",
    "QQBOT_", "SIGNAL_", "SIMPLEX_", "SLACK_", "SMS_", "TEAMS_",
    "TELEGRAM_", "TWILIO_", "WECOM_", "WEIXIN_", "WHATSAPP_", "YUANBAO_",
)
assignment = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
kept = []
for line in env_path.read_text(encoding="utf-8").splitlines(keepends=True):
    match = assignment.match(line)
    if match:
        key = match.group(1).upper()
        if key in channel_keys or key.startswith(channel_prefixes):
            continue
    kept.append(line)
temporary = env_path.with_name(".env.lightvela.tmp")
temporary.write_text("".join(kept), encoding="utf-8")
os.chmod(temporary, 0o600)
temporary.replace(env_path)
`

const copyHermesPrimaryModelScript = `from copy import deepcopy
import os
from pathlib import Path
import re
import sys

from dotenv import dotenv_values, set_key
import yaml

source_home = Path(sys.argv[1])
target_home = Path(sys.argv[2])
source_config_path = source_home / "config.yaml"
target_config_path = target_home / "config.yaml"

def read_yaml(path):
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        value = yaml.safe_load(handle) or {}
    return value if isinstance(value, dict) else {}

def text(value):
    return str(value or "").strip()

def model_id(model):
    if isinstance(model, str):
        return model.strip()
    if isinstance(model, dict):
        return text(model.get("default") or model.get("model") or model.get("name"))
    return ""

def trim_provider_models(provider, primary_model):
    provider = deepcopy(provider)
    candidates = {primary_model}
    if "/" in primary_model:
        candidates.add(primary_model.split("/", 1)[1])
    models = provider.get("models")
    if isinstance(models, dict):
        provider["models"] = {
            key: deepcopy(value)
            for key, value in models.items()
            if text(key) in candidates
        }
        if not provider["models"]:
            provider.pop("models", None)
    elif isinstance(models, list):
        kept = []
        for value in models:
            item_id = text(value.get("id") or value.get("name")) if isinstance(value, dict) else text(value)
            if item_id in candidates:
                kept.append(deepcopy(value))
        if kept:
            provider["models"] = kept
        else:
            provider.pop("models", None)
    provider.pop("fallback", None)
    provider.pop("fallback_models", None)
    return provider

source_config = read_yaml(source_config_path)
source_model = source_config.get("model")
primary_model = model_id(source_model)

target_config = read_yaml(target_config_path)
target_config.pop("fallback_model", None)
target_config.pop("fallback_providers", None)
target_config.pop("providers", None)
target_config.pop("custom_providers", None)

selected_model = None
provider_key = ""
if isinstance(source_model, str):
    selected_model = source_model.strip()
elif isinstance(source_model, dict):
    model_keys = (
        "default", "model", "name", "provider", "base_url", "api_mode", "transport",
        "key_env", "api_key_env",
    )
    selected_model = {
        key: deepcopy(source_model[key])
        for key in model_keys
        if key in source_model
    }
    provider_key = text(source_model.get("provider"))

if not provider_key and "/" in primary_model:
    provider_key = primary_model.split("/", 1)[0].strip()

selected_provider = None
source_providers = source_config.get("providers")
if provider_key and isinstance(source_providers, dict):
    for stored_key, value in source_providers.items():
        if text(stored_key).casefold() == provider_key.casefold() and isinstance(value, dict):
            provider_key = text(stored_key)
            selected_provider = trim_provider_models(value, primary_model)
            break

selected_legacy_provider = None
legacy_providers = source_config.get("custom_providers")
if selected_provider is None and isinstance(legacy_providers, list):
    source_base_url = text(source_model.get("base_url")) if isinstance(source_model, dict) else ""
    matches = []
    for value in legacy_providers:
        if not isinstance(value, dict):
            continue
        identity = text(value.get("provider_key") or value.get("provider") or value.get("name"))
        base_url = text(value.get("base_url") or value.get("url") or value.get("api"))
        if provider_key and identity.casefold() == provider_key.casefold():
            matches.append(value)
        elif source_base_url and base_url.rstrip("/") == source_base_url.rstrip("/"):
            matches.append(value)
    if len(matches) == 1:
        selected_legacy_provider = trim_provider_models(matches[0], primary_model)

if selected_model:
    target_config["model"] = selected_model
else:
    target_config.pop("model", None)
if selected_provider is not None:
    target_config["providers"] = {provider_key: selected_provider}
elif selected_legacy_provider is not None:
    target_config["custom_providers"] = [selected_legacy_provider]

target_config_path.parent.mkdir(parents=True, exist_ok=True)
temporary_config = target_config_path.with_name("config.yaml.lightvela.tmp")
temporary_config.write_text(yaml.safe_dump(target_config, sort_keys=False), encoding="utf-8")
os.chmod(temporary_config, 0o600)
temporary_config.replace(target_config_path)

provider_config = selected_provider or selected_legacy_provider or {}
credential_env = []
for value in (
    provider_config.get("key_env"), provider_config.get("api_key_env"),
    source_model.get("key_env") if isinstance(source_model, dict) else None,
    source_model.get("api_key_env") if isinstance(source_model, dict) else None,
):
    name = text(value)
    if name and name not in credential_env:
        credential_env.append(name)

dependency_env = []
if provider_key:
    try:
        from hermes_cli.provider_catalog import provider_catalog_by_slug
        descriptor = provider_catalog_by_slug().get(provider_key)
        if descriptor:
            if not credential_env:
                for name in descriptor.api_key_env_vars:
                    if text(name) and text(name) not in credential_env:
                        credential_env.append(text(name))
            base_url_env = text(descriptor.base_url_env_var)
            if base_url_env:
                dependency_env.append(base_url_env)
    except Exception:
        pass

env_reference = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?")
def collect_env_references(value):
    if isinstance(value, str):
        for name in env_reference.findall(value):
            if name not in dependency_env:
                dependency_env.append(name)
    elif isinstance(value, dict):
        for nested in value.values():
            collect_env_references(nested)
    elif isinstance(value, list):
        for nested in value:
            collect_env_references(nested)

collect_env_references(selected_model)
collect_env_references(provider_config)

source_env = dotenv_values(source_home / ".env", interpolate=False)
target_env_path = target_home / ".env"
target_env_path.write_text(
    "# Per-profile secrets copied for the inherited primary model.\n"
    "# Other profile credentials are intentionally not inherited.\n",
    encoding="utf-8",
)
os.chmod(target_env_path, 0o600)
for name in credential_env:
    value = text(source_env.get(name) or os.environ.get(name))
    if value:
        set_key(str(target_env_path), name, value, quote_mode="always")
        break
for name in dependency_env:
    if name in credential_env:
        continue
    value = text(source_env.get(name) or os.environ.get(name))
    if value:
        set_key(str(target_env_path), name, value, quote_mode="always")
os.chmod(target_env_path, 0o600)
`

func (l *logic) ListInstanceBots(ctx pctx.Context, instanceID string) (*transport.ListInstanceBotsResponse, error) {
	instanceEntity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	result, err := l.execHermesProfileCommand(ctx, instanceID, buildHermesPythonCommand(listHermesInstanceBotsScript, instanceID))
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "list Hermes bots: %v", err)
	}
	if result == nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "invalid Hermes bot list response")
	}
	return parseHermesInstanceBots(result.Output, instanceID, instanceEntity.DisplayName)
}

func parseHermesInstanceBots(output, instanceID, defaultName string) (*transport.ListInstanceBotsResponse, error) {
	var envelope json.RawMessage
	var payload hermesInstanceBotsPayload
	// Select the JSON line before decoding its schema. Retrying json.Unmarshal
	// into the same struct can retain fields from a preceding failed decode.
	if parseLastJSONLine(output, &envelope) != nil || json.Unmarshal(envelope, &payload) != nil || payload.Kind != "lightvela.instance-bots.v1" ||
		payload.Items == nil || payload.WeixinOwners == nil || payload.WhatsAppOwner == nil {
		// Logs, truncated output and a successful prefix must not masquerade as
		// a completed empty catalog or silently discard either channel's owner.
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "invalid Hermes bot list response")
	}
	profiles := projectHermesProfiles(*payload.Items, instanceID, defaultName)
	whatsAppOwner := projectChannelBinding(payload.WhatsAppOwner)
	for _, owner := range []*transport.InstanceChannelBindingResponse{whatsAppOwner} {
		if owner == nil {
			continue
		}
		for _, bot := range profiles {
			if bot.BotID == owner.BotID {
				owner.BotName = bot.Name
				break
			}
		}
	}
	for _, bot := range profiles {
		weixinBinding, ok := payload.WeixinOwners[hermesNativeProfileID(bot.ProfileID)]
		if !ok || weixinBinding == nil || !weixinBinding.OK {
			return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "incomplete Weixin binding catalog")
		}
		weixinOwner := projectChannelBinding(weixinBinding)
		if weixinOwner != nil && weixinOwner.BotID == bot.BotID {
			weixinOwner.BotName = bot.Name
			bot.WeixinOwner = weixinOwner
		}
		bot.WhatsAppOwner = whatsAppOwner
	}
	return &transport.ListInstanceBotsResponse{Items: profiles}, nil
}

func (l *logic) CreateInstanceBot(ctx pctx.Context, instanceID string, req *transport.CreateInstanceBotRequest) (*transport.InstanceBotResponse, error) {
	if req == nil {
		return nil, errcode.ErrInstanceBotInvalidParam
	}
	instanceEntity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if instanceEntity.Status != modelinstance.InstanceStatusRunning {
		return nil, errcode.Wrap(errcode.ErrInstanceStatusInvalid, "instance status is %s", instanceEntity.Status)
	}
	name, description, err := validateInstanceBotText(req.Name, req.Description)
	if err != nil {
		return nil, err
	}
	mode := strings.TrimSpace(req.CreateMode)
	if mode == "" {
		mode = instanceBotCreatedFromBlank
	}
	if mode != instanceBotCreatedFromBlank && mode != instanceBotCreatedFromClone {
		return nil, errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "unsupported create_mode %q", mode)
	}
	if _, err := l.execHermesProfileCommand(ctx, instanceID, checkHermesProfileCapabilityCommand); err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotUnsupported, "profile capability check failed: %v", err)
	}

	initialSoul := strings.TrimSpace(req.InitialSoul)
	if utf8.RuneCountInString(initialSoul) > maxInstanceBotSoulRunes {
		return nil, errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "initial_soul is too long")
	}
	if mode == instanceBotCreatedFromBlank && initialSoul == "" {
		initialSoul = defaultInstanceBotSoul(name, description)
	}

	sourceProfileID := ""
	if mode == instanceBotCreatedFromClone {
		if strings.TrimSpace(req.SourceBotID) == "" {
			return nil, errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "source_bot_id is required for clone")
		}
		source, err := l.getInstanceBotResponse(ctx, instanceID, strings.TrimSpace(req.SourceBotID))
		if err != nil {
			return nil, err
		}
		sourceProfileID = source.ProfileID
	}

	profileID := l.objectIdLogic.GenerateProfileId()
	command := buildHermesProfileCreateCommand(profileID, sourceProfileID, initialSoul, name, description)
	if _, err := l.execHermesProfileCommand(ctx, instanceID, command); err != nil {
		_, _ = l.execHermesProfileCommand(ctx, instanceID, buildHermesProfileDeleteCommand(profileID))
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "create Hermes profile %s: %v", profileID, err)
	}
	return l.getInstanceBotResponse(ctx, instanceID, profileID)
}

func (l *logic) UpdateInstanceBot(ctx pctx.Context, instanceID, botID string, req *transport.UpdateInstanceBotRequest) (*transport.InstanceBotResponse, error) {
	if req == nil || (req.Name == nil && req.Description == nil) {
		return nil, errcode.ErrInstanceBotInvalidParam
	}
	bot, err := l.getInstanceBotResponse(ctx, instanceID, botID)
	if err != nil {
		return nil, err
	}
	fields := make(map[string]string, 2)
	if req.Name != nil {
		name, err := validateInstanceBotName(*req.Name)
		if err != nil {
			return nil, errcode.ErrInstanceBotInvalidParam
		}
		fields["display_name"] = name
	}
	if req.Description != nil {
		description := strings.TrimSpace(*req.Description)
		if utf8.RuneCountInString(description) > maxInstanceBotDescriptionRunes {
			return nil, errcode.ErrInstanceBotInvalidParam
		}
		fields["description"] = description
	}
	command, err := buildHermesProfileMetadataCommand(bot.ProfileID, fields)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "encode profile metadata: %v", err)
	}
	if _, err := l.execHermesProfileCommand(ctx, instanceID, command); err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "update Hermes profile %s: %v", bot.ProfileID, err)
	}
	return l.getInstanceBotResponse(ctx, instanceID, botID)
}

func (l *logic) DeleteInstanceBot(ctx pctx.Context, instanceID, botID string) (*transport.InstanceBotResponse, error) {
	bot, err := l.getInstanceBotResponse(ctx, instanceID, botID)
	if err != nil {
		return nil, err
	}
	if bot.IsDefault || bot.ProfileID == rootProfileID {
		return nil, errcode.ErrInstanceBotDefaultDelete
	}
	weixinOwner, err := l.getChannelBindingResponse(ctx, instanceID, uniqueChannelWeixin, bot.ProfileID)
	if err != nil {
		return nil, err
	}
	if weixinOwner != nil && weixinOwner.BotID == bot.BotID {
		return nil, &BotChannelOccupiedError{Channel: uniqueChannelWeixin}
	}
	whatsAppOwner, err := l.getChannelBindingResponse(ctx, instanceID, uniqueChannelWhatsApp, "")
	if err != nil {
		return nil, err
	}
	if whatsAppOwner != nil && whatsAppOwner.BotID == bot.BotID {
		return nil, &BotChannelOccupiedError{Channel: uniqueChannelWhatsApp}
	}
	if _, err := l.execHermesProfileCommand(ctx, instanceID, buildHermesProfileDeleteCommand(bot.ProfileID)); err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "delete Hermes profile %s: %v", bot.ProfileID, err)
	}
	bot.Status = instanceBotStatusDeleted
	bot.UpdatedAt = time.Now().UTC()
	return bot, nil
}

func (l *logic) RetryInstanceBot(ctx pctx.Context, instanceID, botID string) (*transport.InstanceBotResponse, error) {
	return l.getInstanceBotResponse(ctx, instanceID, botID)
}

func (l *logic) getInstanceBotResponse(ctx pctx.Context, instanceID, botID string) (*transport.InstanceBotResponse, error) {
	instanceEntity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	bots, err := l.listHermesProfiles(ctx, instanceID, instanceEntity.DisplayName)
	if err != nil {
		return nil, err
	}
	for _, bot := range bots {
		if bot.BotID == strings.TrimSpace(botID) {
			return bot, nil
		}
	}
	return nil, errcode.ErrInstanceBotNotFound
}

func (l *logic) getInstanceBotByProfileID(ctx pctx.Context, instanceID, profileID string) (*transport.InstanceBotResponse, error) {
	instanceEntity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	bots, err := l.listHermesProfiles(ctx, instanceID, instanceEntity.DisplayName)
	if err != nil {
		return nil, err
	}
	for _, bot := range bots {
		if bot.ProfileID == strings.TrimSpace(profileID) {
			return bot, nil
		}
	}
	return nil, errcode.ErrInstanceBotNotFound
}

func (l *logic) listHermesProfiles(ctx pctx.Context, instanceID, defaultName string) ([]*transport.InstanceBotResponse, error) {
	result, err := l.execHermesProfileCommand(ctx, instanceID, buildHermesPythonCommand(listHermesProfilesScript))
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "list Hermes profiles: %v", err)
	}
	var payload hermesProfileListPayload
	if result == nil || parseLastJSONLine(result.Output, &payload) != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "invalid Hermes profile list response")
	}
	return projectHermesProfiles(payload.Items, instanceID, defaultName), nil
}

func projectHermesProfiles(profiles []hermesProfileRecord, instanceID, defaultName string) []*transport.InstanceBotResponse {
	items := make([]*transport.InstanceBotResponse, 0, len(profiles))
	for _, profile := range profiles {
		profileID := profile.NativeID
		botID := profile.NativeID
		name := strings.TrimSpace(profile.DisplayName)
		isDefault := profile.IsDefault || profile.NativeID == defaultHermesProfileID
		if isDefault {
			profileID = rootProfileID
			botID = instanceID
			if name == "" {
				name = strings.TrimSpace(defaultName)
			}
		}
		if name == "" && !isDefault {
			name = profile.NativeID
		}
		modifiedAt, _ := time.Parse(time.RFC3339Nano, profile.ModifiedAt)
		items = append(items, &transport.InstanceBotResponse{
			BotID:          botID,
			InstanceID:     instanceID,
			ProfileID:      profileID,
			Name:           name,
			Description:    profile.Description,
			IsDefault:      isDefault,
			Status:         instanceBotStatusReady,
			GatewayRunning: profile.GatewayRunning,
			CreatedFrom:    instanceBotCreatedFromBlank,
			CreatedAt:      modifiedAt,
			UpdatedAt:      modifiedAt,
		})
	}
	return items
}

func isUniqueChannel(channel string) bool {
	return channel == uniqueChannelWeixin || channel == uniqueChannelWhatsApp
}

func (l *logic) ClaimInstanceBotChannel(ctx pctx.Context, instanceID, botID, channel string) (*transport.InstanceChannelBindingResponse, error) {
	channel = strings.TrimSpace(channel)
	if !isUniqueChannel(channel) {
		return nil, errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "unsupported unique channel %q", channel)
	}
	bot, err := l.getInstanceBotResponse(ctx, instanceID, botID)
	if err != nil {
		return nil, err
	}
	binding, err := l.runChannelBindingAction(ctx, instanceID, channel, "claim", bot.BotID, bot.ProfileID)
	if err != nil {
		return nil, err
	}
	if !binding.OK {
		if binding.Reason == "occupied" {
			return nil, errcode.Wrap(errcode.ErrChannelOccupied, "%s is already connected to bot %s", channel, binding.BotID)
		}
		return nil, l.channelBindingFailure(ctx, instanceID, binding)
	}
	return &transport.InstanceChannelBindingResponse{
		Channel: binding.Channel, BotID: binding.BotID, ProfileID: binding.ProfileID,
		BotName: bot.Name, Status: binding.Status, ReservationID: binding.ReservationID,
	}, nil
}

func (l *logic) ReleaseInstanceBotChannel(ctx pctx.Context, instanceID, botID, channel, reservationID string, disconnect bool) error {
	channel = strings.TrimSpace(channel)
	if !isUniqueChannel(channel) {
		return errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "unsupported unique channel %q", channel)
	}
	bot, err := l.getInstanceBotResponse(ctx, instanceID, botID)
	if err != nil {
		return err
	}
	if channel == uniqueChannelWhatsApp && disconnect && reservationID != "" {
		return errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "whatsapp disconnect cannot include a reservation")
	}
	action := "release"
	if disconnect {
		action = "disconnect"
	}
	binding, err := l.runChannelBindingAction(ctx, instanceID, channel, action, botID, bot.ProfileID, reservationID)
	if err != nil {
		return err
	}
	if !binding.OK {
		return l.channelBindingFailure(ctx, instanceID, binding)
	}
	return nil
}

func (l *logic) releaseReservedInstanceBotChannel(ctx pctx.Context, instanceID, botID, profileID string) error {
	_, err := l.runChannelBindingAction(ctx, instanceID, uniqueChannelWeixin, "release_reserved", botID, profileID)
	return err
}

func (l *logic) ConfirmInstanceBotChannel(ctx pctx.Context, instanceID, botID, channel, reservationID string) error {
	channel = strings.TrimSpace(channel)
	if !isUniqueChannel(channel) {
		return errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "unsupported unique channel %q", channel)
	}
	bot, err := l.getInstanceBotResponse(ctx, instanceID, botID)
	if err != nil {
		return err
	}
	binding, err := l.runChannelBindingAction(ctx, instanceID, channel, "confirm", botID, bot.ProfileID, reservationID)
	if err != nil {
		return err
	}
	if !binding.OK {
		return l.channelBindingFailure(ctx, instanceID, binding)
	}
	return nil
}

func (l *logic) getChannelBindingResponse(ctx pctx.Context, instanceID, channel, profileID string) (*transport.InstanceChannelBindingResponse, error) {
	channel = strings.TrimSpace(channel)
	if !isUniqueChannel(channel) {
		return nil, errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "unsupported unique channel %q", channel)
	}
	binding, err := l.runChannelBindingAction(ctx, instanceID, channel, "get", "", profileID)
	if err != nil {
		return nil, err
	}
	return projectChannelBinding(binding), nil
}

func projectChannelBinding(binding *channelBindingPayload) *transport.InstanceChannelBindingResponse {
	if binding == nil || binding.BotID == "" {
		return nil
	}
	profileID := binding.ProfileID
	if profileID == defaultHermesProfileID {
		profileID = rootProfileID
	}
	return &transport.InstanceChannelBindingResponse{
		Channel: binding.Channel, BotID: binding.BotID, ProfileID: profileID, Status: binding.Status,
	}
}

func (l *logic) runChannelBindingAction(ctx pctx.Context, instanceID, channel, action, botID, profileID string, reservationID ...string) (*channelBindingPayload, error) {
	if len(reservationID) == 0 {
		reservationID = []string{""}
	}
	command := buildHermesPythonCommand(manageChannelBindingScript, action, channel, botID, hermesNativeProfileID(profileID), instanceID, reservationID[0])
	result, err := l.execHermesProfileCommand(ctx, instanceID, command)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "manage channel binding: %v", err)
	}
	var payload channelBindingPayload
	if result == nil || parseLastJSONLine(result.Output, &payload) != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "invalid channel binding response")
	}
	if payload.ProfileID == defaultHermesProfileID {
		payload.ProfileID = rootProfileID
	}
	return &payload, nil
}

func validateInstanceBotText(rawName, rawDescription string) (string, string, error) {
	name, err := validateInstanceBotName(rawName)
	if err != nil {
		return "", "", err
	}
	description := strings.TrimSpace(rawDescription)
	if utf8.RuneCountInString(description) > maxInstanceBotDescriptionRunes {
		return "", "", errcode.ErrInstanceBotInvalidParam
	}
	return name, description, nil
}

func validateInstanceBotName(rawName string) (string, error) {
	name := strings.TrimSpace(rawName)
	if name == "" || utf8.RuneCountInString(name) > maxInstanceBotNameRunes {
		return "", errcode.ErrInstanceBotInvalidParam
	}
	return name, nil
}

func defaultInstanceBotSoul(name, description string) string {
	soul := fmt.Sprintf("# %s\n\n你是 %s。", name, name)
	if description != "" {
		soul += "\n\n职责：" + description
	}
	return soul
}

func buildHermesProfileCreateCommand(profileID, sourceProfileID, initialSoul, name, description string) string {
	parts := []string{"hermes profile create", shellQuote(profileID)}
	if sourceProfileID != "" {
		parts = append(parts, "--clone-from", shellQuote(hermesNativeProfileID(sourceProfileID)))
	}
	commands := []string{"set -eu", strings.Join(parts, " ")}
	if sourceProfileID != "" {
		commands = append(commands,
			buildHermesProfileConfigUnsetCommand(profileID, "platforms"),
			buildHermesProfileConfigUnsetCommand(profileID, "gateway.platforms"),
			fmt.Sprintf(
				"hermes_home=${HERMES_HOME:-$HOME/.hermes}; %s %s %s",
				`"$hermes_home/hermes-agent/venv/bin/python"`,
				shellQuote("-c"),
				shellQuote(sanitizeClonedProfileEnvScript)+" \"$hermes_home/profiles/"+profileID+"/.env\"",
			),
		)
	} else {
		commands = append(commands, fmt.Sprintf(
			"hermes_home=${HERMES_HOME:-$HOME/.hermes}; %s %s %s %s %s",
			`"$hermes_home/hermes-agent/venv/bin/python"`,
			shellQuote("-c"),
			shellQuote(alignBlankProfileSkillsScript),
			`"$hermes_home"`,
			`"$hermes_home/profiles/`+profileID+`"`,
		))
		commands = append(commands, fmt.Sprintf(
			"hermes_home=${HERMES_HOME:-$HOME/.hermes}; %s %s %s %s %s",
			`"$hermes_home/hermes-agent/venv/bin/python"`,
			shellQuote("-c"),
			shellQuote(copyHermesPrimaryModelScript),
			`"$hermes_home"`,
			`"$hermes_home/profiles/`+profileID+`"`,
		))
	}
	if initialSoul != "" {
		commands = append(commands, fmt.Sprintf(
			"hermes_home=${HERMES_HOME:-$HOME/.hermes}; %s %s %s %s %s",
			`"$hermes_home/hermes-agent/venv/bin/python"`,
			shellQuote("-c"),
			shellQuote(writeInitialSoulScript),
			`"$hermes_home/profiles/`+profileID+`/SOUL.md"`,
			shellQuote(base64.StdEncoding.EncodeToString([]byte(initialSoul))),
		))
	}
	metadataCommand, _ := buildHermesProfileMetadataCommand(profileID, map[string]string{
		"display_name": name,
		"description":  description,
	})
	commands = append(commands, metadataCommand)
	return strings.Join(commands, "\n")
}

func buildHermesProfileConfigUnsetCommand(profileID, key string) string {
	missingMessage := shellQuote("Config key not set: " + key)
	return fmt.Sprintf(`unset_output=$(hermes -p %s config unset %s 2>&1) || {
  case "$unset_output" in
    *%s*) ;;
    *) printf '%%s\n' "$unset_output" >&2; exit 1 ;;
  esac
}`, shellQuote(profileID), shellQuote(key), missingMessage)
}

func buildHermesProfileMetadataCommand(profileID string, fields map[string]string) (string, error) {
	payload, err := json.Marshal(fields)
	if err != nil {
		return "", err
	}
	return buildHermesPythonCommand(writeHermesProfileMetadataScript, hermesNativeProfileID(profileID), string(payload)), nil
}

func buildHermesProfileDeleteCommand(profileID string) string {
	return fmt.Sprintf("hermes profile delete %s --yes", shellQuote(hermesNativeProfileID(profileID)))
}

func buildHermesPythonCommand(script string, args ...string) string {
	parts := []string{
		`hermes_home=${HERMES_HOME:-$HOME/.hermes};`,
		`"$hermes_home/hermes-agent/venv/bin/python"`,
		shellQuote("-c"),
		shellQuote(script),
	}
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func hermesNativeProfileID(profileID string) string {
	if profileID == "" || profileID == rootProfileID {
		return defaultHermesProfileID
	}
	return profileID
}

func parseLastJSONLine(output string, target interface{}) error {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if line == "" {
			continue
		}
		if err := json.Unmarshal([]byte(line), target); err == nil {
			return nil
		}
	}
	return fmt.Errorf("no JSON payload found")
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
