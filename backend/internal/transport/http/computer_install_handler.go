package httptransport

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// ComputerInstallHandler 返回不含任何凭证的稳定 POSIX Bootstrap。
type ComputerInstallHandler struct {
	redeemURL string
	protocol  string
	commands  computerInstallCommands
}

type computerInstallCommands struct {
	Uname                   string
	ID                      string
	Systemctl               string
	SystemdRuntimeDirectory string
}

type ComputerInstallHandlerConfig struct {
	BaseURL           string
	AllowInsecureHTTP bool
}

func NewComputerInstallHandler(config ComputerInstallHandlerConfig) (*ComputerInstallHandler, error) {
	base := strings.TrimSpace(config.BaseURL)
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" || parsed.Opaque != "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		parsed.ForceQuery || (parsed.Path != "" && parsed.Path != "/") ||
		(parsed.RawPath != "" && parsed.RawPath != "/") ||
		strings.ContainsAny(base, "'\"$ \t\r\n\x00") {
		return nil, errors.New("Computer 安装入口地址无效")
	}
	if parsed.Scheme != "https" &&
		(parsed.Scheme != "http" || !config.AllowInsecureHTTP) {
		return nil, errors.New("Computer 安装入口地址无效")
	}
	if parsed.Scheme == "https" && config.AllowInsecureHTTP {
		return nil, errors.New("Computer 安装入口地址无效")
	}
	parsed.Path = ""
	parsed.RawPath = ""
	return &ComputerInstallHandler{
		redeemURL: parsed.String() + "/v1/computer/setup-codes:redeem",
		protocol:  parsed.Scheme,
		commands: computerInstallCommands{
			Uname: "/usr/bin/uname", ID: "/usr/bin/id",
			Systemctl: "/usr/bin/systemctl", SystemdRuntimeDirectory: "/run/systemd/system",
		},
	}, nil
}

func (handler *ComputerInstallHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", http.MethodGet)
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writer.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = writer.Write([]byte(handler.script()))
}

func (handler *ComputerInstallHandler) script() string {
	protocol := "https"
	if handler != nil && handler.protocol == "http" {
		protocol = "http"
	}
	return `#!/bin/sh
set -eu
code=${1-}
if [ -z "$code" ]; then
  /usr/bin/printf '%s\n' 'Missing the 16-character Computer setup code.' >&2
  exit 2
fi
kernel=$(` + shellSingleQuote(handler.commands.Uname) + ` -s 2>/dev/null || true)
machine=$(` + shellSingleQuote(handler.commands.Uname) + ` -m 2>/dev/null || true)
case "$kernel/$machine" in
  Darwin/arm64) target=darwin-arm64 ;;
  Linux/x86_64|Linux/amd64)
    target=linux-amd64
    if [ "$(` + shellSingleQuote(handler.commands.ID) + ` -u 2>/dev/null || true)" != 0 ]; then
      /usr/bin/printf '%s\n' 'Linux installation requires root. Re-run this command as root.' >&2
      exit 1
    fi
    if [ ! -x ` + shellSingleQuote(handler.commands.Systemctl) + ` ] ||
       [ ! -d ` + shellSingleQuote(handler.commands.SystemdRuntimeDirectory) + ` ]; then
      /usr/bin/printf '%s\n' 'This Linux environment is not running systemd and is not supported yet.' >&2
      exit 1
    fi
    ;;
  *)
    /usr/bin/printf '%s\n' 'Unsupported platform. Vela Computer supports macOS ARM64 and Linux AMD64 with systemd.' >&2
    exit 1
    ;;
esac
umask 077
tmp_root=${TMPDIR:-/tmp}
tmp_root=${tmp_root%/}
[ -n "$tmp_root" ] || tmp_root=/tmp
d=$(/usr/bin/mktemp -d "$tmp_root/an-bootstrap.XXXXXX") || exit 1
trap '/bin/rm -rf "$d"' 0 HUP INT TERM
if ! status=$(printf '%s' "$code" |
  /usr/bin/curl -q --silent \
    --proto '=` + protocol + `' --proto-redir '=https' --max-redirs 0 \
    --request POST --header 'Content-Type: text/plain' \
    --header "X-Vela-Computer-Target: $target" --data-binary @- \
    --output "$d/setup.sh" --write-out '%{http_code}' ` + shellSingleQuote(handler.redeemURL) + `); then
  /usr/bin/printf '%s\n' 'Unable to contact the Computer setup service. Check your network and try again.' >&2
  exit 1
fi
case "$status" in
  200) ;;
  401|403|404|410)
    /usr/bin/printf '%s\n' 'Computer setup code is invalid, expired, or already used. Generate a new setup code and try again.' >&2
    exit 1
    ;;
  409)
    /usr/bin/printf '%s\n' 'This Computer setup code is already bound to another platform. Generate a new setup code and try again.' >&2
    exit 1
    ;;
  422)
    /usr/bin/printf '%s\n' 'This platform is not supported by the current Vela Computer release.' >&2
    exit 1
    ;;
  *)
    /usr/bin/printf '%s\n' 'Computer setup service returned an unexpected response. Try again later.' >&2
    exit 1
    ;;
esac
/bin/sh "$d/setup.sh"
`
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
