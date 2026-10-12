package instance

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
)

// VelaIMBot 是 collaboration 开通 IM 身份时需要的 Bot 事实。
type VelaIMBot struct {
	BotID     string
	ProfileID string
	Name      string
}

// VelaIMDelivery 是交付到 Bot Hermes Profile 的 IM 配置；Credential 只写入 Profile 内 0600 文件。
type VelaIMDelivery struct {
	InstanceID string
	BotID      string
	BotAgentID string
	IMUserID   string
	// OwnerIMUserID 是主人的人类 IM 身份，写成该 Bot 的 home channel；可为空。
	OwnerIMUserID string
	SDKAppID      int
	APIBaseURL    string
	Credential    string
}

var (
	velaIMCredentialPattern = regexp.MustCompile(`^vbc_[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9]{1,18}\.[A-Za-z0-9_-]{43}$`)
	velaIMUserIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
)

// VerifyVelaIMBot 只在 ctx 用户拥有该实例且实例上存在该 Bot 时返回成功。
func (l *logic) VerifyVelaIMBot(ctx pctx.Context, instanceID, botID string) (*VelaIMBot, error) {
	bots, err := l.ListInstanceBots(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	for _, bot := range bots.Items {
		if bot != nil && bot.BotID == botID {
			if bot.Status != instanceBotStatusReady {
				return nil, errcode.Wrap(errcode.ErrInstanceBotConflict, "bot status is %s", bot.Status)
			}
			return &VelaIMBot{BotID: bot.BotID, ProfileID: bot.ProfileID, Name: bot.Name}, nil
		}
	}
	return nil, errcode.ErrInstanceBotNotFound
}

// DeliverVelaIMBot 把 Bot 凭据与访问地址写入 Profile、启用 vela-im 插件并重启该 Bot 的 gateway。
func (l *logic) DeliverVelaIMBot(ctx pctx.Context, delivery VelaIMDelivery) error {
	if !velaIMCredentialPattern.MatchString(delivery.Credential) ||
		!velaIMUserIDPattern.MatchString(delivery.IMUserID) ||
		delivery.OwnerIMUserID != "" && !velaIMUserIDPattern.MatchString(delivery.OwnerIMUserID) ||
		delivery.SDKAppID <= 0 || !strings.HasPrefix(delivery.APIBaseURL, "http") {
		return errcode.ErrInstanceInvalidParam
	}
	bot, err := l.VerifyVelaIMBot(ctx, delivery.InstanceID, delivery.BotID)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{
		"credential": delivery.Credential,
		"owner":      delivery.OwnerIMUserID,
		"config": map[string]any{
			"apiBaseUrl": delivery.APIBaseURL,
			"botAgentId": delivery.BotAgentID,
			"imUserId":   delivery.IMUserID,
			"sdkAppId":   delivery.SDKAppID,
		},
	})
	if err != nil {
		return err
	}
	// TAT 命令记录中只出现 base64 参数；与 qqbot 渠道密钥的交付方式一致。
	result, err := l.execHermesProfileCommand(ctx, delivery.InstanceID, buildHermesPythonCommand(
		deliverVelaIMScript, hermesNativeProfileID(bot.ProfileID), base64.StdEncoding.EncodeToString(payload),
	))
	if err != nil {
		return errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "deliver vela-im: %v", err)
	}
	if result == nil || result.ExitCode != 0 {
		return errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "deliver vela-im failed")
	}
	return l.restartVelaIMGateway(ctx, delivery.InstanceID, bot.ProfileID)
}

// RevokeVelaIMBot 删除 Profile 内的 Bot 凭据并重启 gateway；凭据在平台侧已经失效。
func (l *logic) RevokeVelaIMBot(ctx pctx.Context, instanceID, botID string) error {
	bot, err := l.VerifyVelaIMBot(ctx, instanceID, botID)
	if err != nil {
		return err
	}
	result, err := l.execHermesProfileCommand(ctx, instanceID, buildHermesPythonCommand(
		revokeVelaIMScript, hermesNativeProfileID(bot.ProfileID),
	))
	if err != nil {
		return errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "revoke vela-im: %v", err)
	}
	if result == nil || result.ExitCode != 0 {
		return errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "revoke vela-im failed")
	}
	return l.restartVelaIMGateway(ctx, instanceID, bot.ProfileID)
}

func (l *logic) restartVelaIMGateway(ctx pctx.Context, instanceID, profileID string) error {
	result, err := l.execHermesProfileCommand(
		ctx, instanceID, fmt.Sprintf("acli gateway restart --agent %s", shellQuoteArg(profileID)),
	)
	if err != nil {
		return errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "restart profile gateway: %v", err)
	}
	if result == nil || result.ExitCode != 0 {
		return errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "restart profile gateway failed")
	}
	return nil
}

// velaIMProfileDirFunction 与 Hermes Profile 布局一致：default 是 HERMES_HOME 根目录。
const velaIMProfileDirFunction = `import os
from pathlib import Path

def profile_dir(native_id):
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    if native_id == "default":
        return home, home
    if not native_id or "/" in native_id or native_id.startswith("."):
        raise SystemExit("invalid profile id")
    return home, home / "profiles" / native_id
`

const deliverVelaIMScript = velaIMProfileDirFunction + `
import base64
import json
import sys

import yaml

home, profile = profile_dir(sys.argv[1])
if not profile.is_dir():
    raise SystemExit("profile not found")
if not (profile / "plugins" / "vela-im").is_dir() and not (home / "plugins" / "vela-im").is_dir():
    raise SystemExit("vela-im plugin is not installed on this instance")
payload = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))

data = profile / "plugin-data" / "vela-im"
data.mkdir(parents=True, exist_ok=True, mode=0o700)
credential = data / "credential"
tmp = credential.with_suffix(".tmp")
tmp.write_text(payload["credential"] + "\n", encoding="utf-8")
os.chmod(tmp, 0o600)
tmp.replace(credential)
(data / "config.json").write_text(json.dumps(payload["config"]), encoding="utf-8")

config_path = profile / "config.yaml"
config = (yaml.safe_load(config_path.read_text(encoding="utf-8")) if config_path.exists() else None) or {}
plugins = config.setdefault("plugins", {})
enabled = list(plugins.get("enabled") or [])
if "vela-im" not in enabled:
    enabled.append("vela-im")
plugins["enabled"] = enabled
config.setdefault("platforms", {})["vela_im"] = {"enabled": True}
config.setdefault("platform_toolsets", {})["vela_im"] = ["all"]
display = config.setdefault("display", {}).setdefault("platforms", {})
display["vela_im"] = {"show_reasoning": False}
config_path.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
os.chmod(config_path, 0o600)

# Hermes drops every sender of a plugin platform without an allowlist; the platform decides who reaches the Bot.
env_path = profile / ".env"
lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
lines = [line for line in lines if not line.startswith(("VELA_ALLOW_ALL_USERS=", "VELA_HOME_CHANNEL="))]
lines.append("VELA_ALLOW_ALL_USERS=true")
if payload.get("owner"):
    # Cron results and cross-platform notices go to the owner's direct chat.
    lines.append("VELA_HOME_CHANNEL=C2C" + payload["owner"])
env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
os.chmod(env_path, 0o600)
print("vela-im delivered")
`

const revokeVelaIMScript = velaIMProfileDirFunction + `
import sys

home, profile = profile_dir(sys.argv[1])
credential = profile / "plugin-data" / "vela-im" / "credential"
if credential.exists():
    credential.unlink()
print("vela-im revoked")
`
