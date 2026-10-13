package instance

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
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
	velaIMCredentialPattern   = regexp.MustCompile(`^vbc_[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9]{1,18}\.[A-Za-z0-9_-]{43}$`)
	velaIMUserIDPattern       = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	velaIMPluginSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// vela-im 插件安装结果，取自安装命令的最后一行输出。
const (
	VelaIMPluginInstalled = "installed"
	VelaIMPluginUpToDate  = "up_to_date"
	// VelaIMPluginNoHermes 表示实例不是 Hermes 实例，无需安装。
	VelaIMPluginNoHermes = "no_hermes"
)

// velaIMPluginBackfillMaxBatch 限制一次补装的实例数：每台实例一次 TAT 调用，批次过大会拖长单个请求。
const velaIMPluginBackfillMaxBatch = 20

type velaIMPluginPackage struct {
	URL    string
	SHA256 string
}

// VelaIMPluginResult 是一台实例的补装结果；Error 只在失败时有值。
type VelaIMPluginResult struct {
	InstanceID string `json:"instanceId"`
	Status     string `json:"status,omitempty"`
	Error      string `json:"error,omitempty"`
}

// VelaIMPluginBackfill 是一批存量实例的补装结果；Done 为 false 时用 NextAfterID 继续下一批。
type VelaIMPluginBackfill struct {
	Results     []VelaIMPluginResult `json:"results"`
	NextAfterID int64                `json:"nextAfterId"`
	Done        bool                 `json:"done"`
}

type runningInstanceLister interface {
	ListRunningAfter(afterID int64, limit int) ([]*modelinstance.Entity, error)
}

func configuredVelaIMPlugin() (velaIMPluginPackage, bool) {
	conf := currentInstanceAPIConfig()
	if conf == nil {
		return velaIMPluginPackage{}, false
	}
	pkg := velaIMPluginPackage{
		URL:    strings.TrimSpace(conf.VelaIMPluginURL),
		SHA256: strings.ToLower(strings.TrimSpace(conf.VelaIMPluginSHA256)),
	}
	if !strings.HasPrefix(pkg.URL, "https://") || !velaIMPluginSHA256Pattern.MatchString(pkg.SHA256) {
		return velaIMPluginPackage{}, false
	}
	return pkg, true
}

// renderVelaIMPluginInstallCommand 把插件安装到 $HERMES_HOME/plugins/vela-im；其他 Profile 开通时软链接到这里。
// 同一个包已安装时什么也不做；下载或校验失败不动现有插件，上一版本保留为 vela-im.previous。
// 每条成功路径都自然结束、不调用 exit：CTL 用 bash -lc 执行，登录 shell 执行 exit 时会先跑 ~/.bash_logout，
// 实例上它的最后一条命令返回非零，会把退出码改成失败。
func renderVelaIMPluginInstallCommand(pkg velaIMPluginPackage) string {
	return strings.Join([]string{
		`set -eu`,
		`home="${HERMES_HOME:-$HOME/.hermes}"`,
		`target="$home/plugins/vela-im"`,
		`want=` + shellQuoteArg(pkg.SHA256),
		`if [ ! -x "$home/hermes-agent/venv/bin/python" ]; then`,
		`  echo ` + VelaIMPluginNoHermes,
		`elif [ "$(cat "$target/.package-sha256" 2>/dev/null)" = "$want" ]; then`,
		`  echo ` + VelaIMPluginUpToDate,
		`else`,
		`  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)' 2>/dev/null; then`,
		`    echo "Node.js >= 22.16 is required for the Vela IM worker" >&2`,
		`    false`,
		`  fi`,
		`  mkdir -p "$home/plugins"`,
		`  work=$(mktemp -d "$home/plugins/.vela-im-install.XXXXXX")`,
		`  trap 'rm -rf "$work"' EXIT`,
		`  curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 -o "$work/plugin.tgz" ` + shellQuoteArg(pkg.URL),
		`  echo "$want  $work/plugin.tgz" | sha256sum -c --status -`,
		`  mkdir "$work/plugin"`,
		`  tar -xzf "$work/plugin.tgz" -C "$work/plugin" --no-same-owner`,
		`  test -f "$work/plugin/plugin.yaml" -a -f "$work/plugin/adapter.py" -a -f "$work/plugin/vela_im/_worker/vela-im-worker.mjs"`,
		`  printf '%s\n' "$want" > "$work/plugin/.package-sha256"`,
		`  rm -rf "$target.previous"`,
		`  if [ -d "$target" ]; then mv "$target" "$target.previous"; fi`,
		`  mv "$work/plugin" "$target"`,
		`  echo ` + VelaIMPluginInstalled,
		`fi`,
	}, "\n")
}

// velaIMPluginLinked 是交付脚本在 Profile 第一次链接到实例插件时输出的一行。
const velaIMPluginLinked = "vela-im linked"

func velaIMOutputHas(output, line string) bool {
	for _, current := range strings.Split(output, "\n") {
		if strings.TrimSpace(current) == line {
			return true
		}
	}
	return false
}

// InstallVelaIMPlugin 按配置的插件包在实例上安装 vela-im 插件，返回 installed / up_to_date / no_hermes。
func (l *logic) InstallVelaIMPlugin(ctx pctx.Context, instanceID string) (string, error) {
	pkg, ok := configuredVelaIMPlugin()
	if !ok {
		return "", errcode.Wrap(errcode.ErrInstanceInvalidParam, "vela-im plugin package is not configured")
	}
	result, err := l.execHermesProfileCommand(ctx, instanceID, renderVelaIMPluginInstallCommand(pkg))
	if err != nil {
		return "", errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "install vela-im plugin: %v", err)
	}
	if result == nil || result.ExitCode != 0 {
		return "", errcode.Wrap(errcode.ErrInstanceBotProfileFailed, "install vela-im plugin failed")
	}
	lines := strings.Split(strings.TrimSpace(result.Stdout+"\n"+result.Output), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		switch status := strings.TrimSpace(lines[index]); status {
		case VelaIMPluginInstalled, VelaIMPluginUpToDate, VelaIMPluginNoHermes:
			return status, nil
		}
	}
	return VelaIMPluginInstalled, nil
}

// BackfillVelaIMPlugin 给存量运行中实例补装插件：按 id 顺序取一批，以各自主人的身份执行安装命令。
// 单台失败（如主人无有效套餐、实例缺 Node）只记录在结果里，不中断整批。
func (l *logic) BackfillVelaIMPlugin(parent pctx.Context, afterID int64, limit int) (*VelaIMPluginBackfill, error) {
	if _, ok := configuredVelaIMPlugin(); !ok {
		return nil, errcode.Wrap(errcode.ErrInstanceInvalidParam, "vela-im plugin package is not configured")
	}
	lister, ok := l.instanceDao.(runningInstanceLister)
	if !ok {
		return nil, errcode.Wrap(errcode.ErrInstanceInvalidParam, "instance listing is not available")
	}
	if limit <= 0 || limit > velaIMPluginBackfillMaxBatch {
		limit = velaIMPluginBackfillMaxBatch
	}
	entities, err := lister.ListRunningAfter(afterID, limit)
	if err != nil {
		return nil, err
	}
	batch := &VelaIMPluginBackfill{Results: make([]VelaIMPluginResult, 0, len(entities)), NextAfterID: afterID, Done: len(entities) < limit}
	for _, entity := range entities {
		batch.NextAfterID = entity.Id
		ctx := pctx.NewContext(parent).WithUserID(entity.UserId)
		status, err := l.InstallVelaIMPlugin(ctx, entity.InstanceId)
		result := VelaIMPluginResult{InstanceID: entity.InstanceId, Status: status}
		if err != nil {
			result.Error = err.Error()
		}
		batch.Results = append(batch.Results, result)
	}
	return batch, nil
}

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

// DeliverVelaIMBot 把 Bot 凭据与访问地址写入 Profile、启用 vela-im 插件并重启 gateway。
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
	// 新实例在第一个 Agent 加入 IM 时装上插件；已装同一版本时只是一次检查。
	if _, configured := configuredVelaIMPlugin(); configured {
		if _, err := l.InstallVelaIMPlugin(ctx, delivery.InstanceID); err != nil {
			return err
		}
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
	if velaIMOutputHas(result.Stdout+"\n"+result.Output, velaIMPluginLinked) {
		// 一个主机 gateway 服务所有 Profile，只在启动时加载各 Profile 的插件；重启单个 Profile 不会加载新链接的插件。
		return l.restartVelaIMGateway(ctx, delivery.InstanceID, "")
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

// restartVelaIMGateway 重启 profileID 的 gateway；profileID 为空时重启主机 gateway（default Profile）。
func (l *logic) restartVelaIMGateway(ctx pctx.Context, instanceID, profileID string) error {
	command := "acli gateway restart"
	if profileID != "" {
		command += " --agent " + shellQuoteArg(profileID)
	}
	result, err := l.execHermesProfileCommand(ctx, instanceID, command)
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
shared = home / "plugins" / "vela-im"
own = profile / "plugins" / "vela-im"
if not own.is_dir() and not shared.is_dir():
    raise SystemExit("vela-im plugin is not installed on this instance")
# Hermes loads a profile's plugins only from that profile's own plugins directory.
linked = False
if not own.is_dir():
    if own.is_symlink():
        own.unlink()
    own.parent.mkdir(parents=True, exist_ok=True)
    own.symlink_to(shared, target_is_directory=True)
    linked = True
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
if linked:
    print("vela-im linked")
`

const revokeVelaIMScript = velaIMProfileDirFunction + `
import sys

home, profile = profile_dir(sys.argv[1])
credential = profile / "plugin-data" / "vela-im" / "credential"
if credential.exists():
    credential.unlink()
print("vela-im revoked")
`
