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
umask 077
tmp_root=${TMPDIR:-/tmp}
tmp_root=${tmp_root%/}
[ -n "$tmp_root" ] || tmp_root=/tmp
d=$(/usr/bin/mktemp -d "$tmp_root/an-bootstrap.XXXXXX") || exit 1
trap '/bin/rm -rf "$d"' EXIT HUP INT TERM
printf '%s' "$code" |
  /usr/bin/curl -q --fail --silent --show-error \
    --proto '=` + protocol + `' --proto-redir '=https' --max-redirs 0 \
    --request POST --header 'Content-Type: text/plain' --data-binary @- \
    --output "$d/setup.sh" ` + shellSingleQuote(handler.redeemURL) + `
/bin/sh "$d/setup.sh"
`
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
