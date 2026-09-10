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
	maxInstanceBotNameRunes        = 64
	maxInstanceBotDescriptionRunes = 256
	maxInstanceBotSoulRunes        = 12000
)

type hermesProfileRecord struct {
	NativeID       string `json:"native_id"`
	DisplayName    string `json:"display_name"`
	Description    string `json:"description"`
	IsDefault      bool   `json:"is_default"`
	GatewayRunning bool   `json:"gateway_running"`
	ModifiedAt     string `json:"modified_at"`
}

type hermesProfileListPayload struct {
	Items []hermesProfileRecord `json:"items"`
}

type channelBindingPayload struct {
	OK        bool   `json:"ok"`
	Reason    string `json:"reason"`
	Channel   string `json:"channel"`
	BotID     string `json:"bot_id"`
	ProfileID string `json:"profile_id"`
	Status    string `json:"status"`
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

const listHermesProfilesScript = `import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets

import httpx

async def main():
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
            "gateway_running": bool(profile.get("gateway_running", False)),
            "modified_at": modified,
        })
    print(json.dumps({"items": items}, ensure_ascii=False))

asyncio.run(main())
`

const writeHermesProfileMetadataScript = `import json
import sys
from hermes_cli.profiles import get_profile_dir, write_profile_meta

profile_id = sys.argv[1]
fields = json.loads(sys.argv[2])
write_profile_meta(get_profile_dir(profile_id), **fields)
print(json.dumps({"ok": True}))
`

const manageChannelBindingScript = `import fcntl
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

action, bot_id, profile_id = sys.argv[1:4]
home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
root = home / ".lightvela" / "channel-bindings"
root.mkdir(parents=True, exist_ok=True)
path = root / "weixin.json"
lock_path = root / "weixin.lock"

def read_current():
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None

def write_current(value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)

with lock_path.open("a", encoding="utf-8") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    current = read_current()
    if action == "get":
        result = current or {"ok": True}
    elif action == "claim":
        if current and current.get("bot_id") != bot_id:
            result = {**current, "ok": False, "reason": "occupied"}
        else:
            result = {
                "ok": True,
                "channel": "weixin",
                "bot_id": bot_id,
                "profile_id": profile_id,
                "status": current.get("status", "reserved") if current else "reserved",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            write_current(result)
    elif action == "confirm":
        if not current or current.get("bot_id") != bot_id:
            result = {"ok": False, "reason": "owner_mismatch"}
        else:
            current.update({"ok": True, "status": "connected", "updated_at": datetime.now(timezone.utc).isoformat()})
            write_current(current)
            result = current
    elif action in ("release", "release_reserved"):
        may_release = current and current.get("bot_id") == bot_id
        if action == "release_reserved":
            may_release = may_release and current.get("status") == "reserved"
        if may_release:
            path.unlink(missing_ok=True)
        result = {"ok": True}
    else:
        result = {"ok": False, "reason": "unsupported_action"}
    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

print(json.dumps(result, ensure_ascii=False))
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

func (l *logic) ListInstanceBots(ctx pctx.Context, instanceID string) (*transport.ListInstanceBotsResponse, error) {
	instanceEntity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	profiles, err := l.listHermesProfiles(ctx, instanceID, instanceEntity.DisplayName)
	if err != nil {
		return nil, err
	}
	weixinOwner, err := l.getChannelBindingResponse(ctx, instanceID, uniqueChannelWeixin)
	if err != nil {
		return nil, err
	}
	if weixinOwner != nil {
		for _, bot := range profiles {
			if bot.BotID == weixinOwner.BotID {
				weixinOwner.BotName = bot.Name
				break
			}
		}
	}
	for _, bot := range profiles {
		bot.WeixinOwner = weixinOwner
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
	if _, err := l.ExecDebugCommand(ctx, instanceID, checkHermesProfileCapabilityCommand, "agentuser"); err != nil {
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
	if _, err := l.ExecDebugCommand(ctx, instanceID, command, "agentuser"); err != nil {
		_, _ = l.ExecDebugCommand(ctx, instanceID, buildHermesProfileDeleteCommand(profileID), "agentuser")
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
		name := strings.TrimSpace(*req.Name)
		if name == "" || utf8.RuneCountInString(name) > maxInstanceBotNameRunes {
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
	if _, err := l.ExecDebugCommand(ctx, instanceID, command, "agentuser"); err != nil {
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
	weixinOwner, err := l.getChannelBindingResponse(ctx, instanceID, uniqueChannelWeixin)
	if err != nil {
		return nil, err
	}
	if weixinOwner != nil && weixinOwner.BotID == bot.BotID {
		return nil, errcode.Wrap(errcode.ErrChannelOccupied, "disconnect weixin before deleting bot %s", botID)
	}
	if _, err := l.ExecDebugCommand(ctx, instanceID, buildHermesProfileDeleteCommand(bot.ProfileID), "agentuser"); err != nil {
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
	result, err := l.ExecDebugCommand(ctx, instanceID, buildHermesPythonCommand(listHermesProfilesScript), "agentuser")
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
			BotID:       botID,
			InstanceID:  instanceID,
			ProfileID:   profileID,
			Name:        name,
			Description: profile.Description,
			IsDefault:   isDefault,
			Status:      instanceBotStatusReady,
			CreatedFrom: instanceBotCreatedFromBlank,
			CreatedAt:   modifiedAt,
			UpdatedAt:   modifiedAt,
		})
	}
	return items
}

func (l *logic) ClaimInstanceBotChannel(ctx pctx.Context, instanceID, botID, channel string) (*transport.InstanceChannelBindingResponse, error) {
	if strings.TrimSpace(channel) != uniqueChannelWeixin {
		return nil, errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "unsupported unique channel %q", channel)
	}
	bot, err := l.getInstanceBotResponse(ctx, instanceID, botID)
	if err != nil {
		return nil, err
	}
	binding, err := l.runChannelBindingAction(ctx, instanceID, "claim", bot.BotID, bot.ProfileID)
	if err != nil {
		return nil, err
	}
	if !binding.OK {
		if binding.Reason == "occupied" {
			return nil, errcode.Wrap(errcode.ErrChannelOccupied, "weixin is already connected to bot %s", binding.BotID)
		}
		return nil, errcode.Wrap(errcode.ErrInstanceBotConflict, "claim channel: %s", binding.Reason)
	}
	return &transport.InstanceChannelBindingResponse{
		Channel: binding.Channel, BotID: binding.BotID, ProfileID: binding.ProfileID,
		BotName: bot.Name, Status: binding.Status,
	}, nil
}

func (l *logic) ReleaseInstanceBotChannel(ctx pctx.Context, instanceID, botID, channel string) error {
	if strings.TrimSpace(channel) != uniqueChannelWeixin {
		return errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "unsupported unique channel %q", channel)
	}
	if _, err := l.getInstanceBotResponse(ctx, instanceID, botID); err != nil {
		return err
	}
	_, err := l.runChannelBindingAction(ctx, instanceID, "release", botID, "")
	return err
}

func (l *logic) releaseReservedInstanceBotChannel(ctx pctx.Context, instanceID, botID string) error {
	_, err := l.runChannelBindingAction(ctx, instanceID, "release_reserved", botID, "")
	return err
}

func (l *logic) ConfirmInstanceBotChannel(ctx pctx.Context, instanceID, botID, channel string) error {
	if strings.TrimSpace(channel) != uniqueChannelWeixin {
		return errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "unsupported unique channel %q", channel)
	}
	if _, err := l.getInstanceBotResponse(ctx, instanceID, botID); err != nil {
		return err
	}
	binding, err := l.runChannelBindingAction(ctx, instanceID, "confirm", botID, "")
	if err != nil {
		return err
	}
	if !binding.OK {
		return errcode.Wrap(errcode.ErrInstanceBotConflict, "confirm channel: %s", binding.Reason)
	}
	return nil
}

func (l *logic) getChannelBindingResponse(ctx pctx.Context, instanceID, channel string) (*transport.InstanceChannelBindingResponse, error) {
	if strings.TrimSpace(channel) != uniqueChannelWeixin {
		return nil, errcode.Wrap(errcode.ErrInstanceBotInvalidParam, "unsupported unique channel %q", channel)
	}
	binding, err := l.runChannelBindingAction(ctx, instanceID, "get", "", "")
	if err != nil || binding.BotID == "" {
		return nil, err
	}
	return &transport.InstanceChannelBindingResponse{
		Channel: binding.Channel, BotID: binding.BotID, ProfileID: binding.ProfileID, Status: binding.Status,
	}, nil
}

func (l *logic) runChannelBindingAction(ctx pctx.Context, instanceID, action, botID, profileID string) (*channelBindingPayload, error) {
	command := buildHermesPythonCommand(manageChannelBindingScript, action, botID, hermesNativeProfileID(profileID))
	result, err := l.ExecDebugCommand(ctx, instanceID, command, "agentuser")
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
	name := strings.TrimSpace(rawName)
	description := strings.TrimSpace(rawDescription)
	if name == "" || utf8.RuneCountInString(name) > maxInstanceBotNameRunes {
		return "", "", errcode.ErrInstanceBotInvalidParam
	}
	if utf8.RuneCountInString(description) > maxInstanceBotDescriptionRunes {
		return "", "", errcode.ErrInstanceBotInvalidParam
	}
	return name, description, nil
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
			fmt.Sprintf("hermes -p %s config unset platforms >/dev/null", shellQuote(profileID)),
			fmt.Sprintf("hermes -p %s config unset gateway.platforms >/dev/null", shellQuote(profileID)),
			fmt.Sprintf(
				"hermes_home=${HERMES_HOME:-$HOME/.hermes}; %s %s %s",
				`"$hermes_home/hermes-agent/venv/bin/python"`,
				shellQuote("-c"),
				shellQuote(sanitizeClonedProfileEnvScript)+" \"$hermes_home/profiles/"+profileID+"/.env\"",
			),
		)
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
