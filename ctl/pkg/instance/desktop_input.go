package instance

import (
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

const (
	desktopInputUnit      = "vela-desktop-input"
	desktopInputPort      = 5903
	desktopInputProxyUnit = "opencraft-desktop-input-gateway"
	desktopInputProxyPort = 5904

	desktopInputProxyPath = "/usr/local/libexec/opencraft/desktop-input.py"
	// Root-only: the gateway reads it, the browser never sees it.
	desktopInputGrantDir  = "/run/opencraft-desktop-input"
	desktopInputGrantPath = "/run/opencraft-desktop-input/grant"
)

//go:embed desktop_input_proxy.py
var desktopInputProxySource string

// A dedicated interactive endpoint plus an input gateway.
//
// Why a third x11vnc instead of reusing one that already exists:
//   - 5900 (vela-x11vnc) is the legacy controllable endpoint behind
//     websockify/ingressproxy. Its only credential is the 8-char RFB password,
//     and stripping that password would leave a public port wide open. It must
//     keep working unchanged for regions that still have ingressproxy.
//   - 5901 (vela-desktop-observer) is compiled read-only: -viewonly is enforced
//     inside x11vnc, so no client or ctl flag can turn it into an input
//     endpoint. Turning it writable in place is explicitly forbidden.
//
// The endpoint itself stays loopback-only, so its access model matches the
// observer's: unreachable from any network, reachable only through the
// instance-scoped, product-authenticated TAT tunnel. Because it is never
// published, no RFB password has to be handed to the browser either.
//
// Keyboard and mouse are NOT granted by merely reaching the port. The viewer
// talks to the gateway on 5904, which relays to 5903 and drops every RFB input
// message unless a bounded grant is present. That is what makes "who may
// control", "revoke now" and "release held keys" answerable server-side instead
// of relying on a client-side view-only flag.
func desktopInputArguments(display string, port int) []string {
	return []string{"-norc", "-display", display, "-rfbport", fmt.Sprint(port),
		// -localhost: bind loopback only; the endpoint is never on a network.
		// -nopw: the tunnel is the credential, so no password is published.
		// -nevershared: defence in depth behind the gateway's own single-holder
		//   rule; a second connection cannot silently share the cursor.
		// -dontdisconnect: do not evict the pre-existing 5900/5901 servers.
		"-localhost", "-no6", "-nopw", "-nevershared", "-dontdisconnect",
		// Keep x11vnc's own remote control surfaces off; only RFB I/O remains.
		"-noremote", "-nocmds", "-novncconnect",
		// -wait/-defer 与国内站在跑的 5900(-wait 5 -defer 5) 对齐：这是 x11vnc 的
		// 屏幕轮询间隔与更新合并延迟，20ms×2 会让键鼠操作有可感知的滞后感。
		// 输入端点对延迟最敏感，故不沿用 observer 的省 CPU 取值。
		"-forever", "-noxdamage", "-wait", "5", "-defer", "5"}
}

func renderDesktopInputUnit() string {
	return fmt.Sprintf(`[Unit]
Description=vela interactive desktop endpoint (backend access only)
Requires=vela-xvfb.service
PartOf=vela-xvfb.service
After=vela-xvfb.service vela-desktop-wm.service
[Service]
Type=simple
User=%s
Environment=DISPLAY=:1
Environment=HOME=/home/%s
ExecStart=/usr/bin/x11vnc %s
NoNewPrivileges=true
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target`, desktopRuntimeUser, desktopRuntimeUser,
		strings.Join(desktopInputArguments(":1", desktopInputPort), " "))
}

// The gateway is root because it owns the grant file and must be the only thing
// able to decide whether input is forwarded.
func renderDesktopInputProxyUnit() string {
	return fmt.Sprintf(`[Unit]
Description=OpenCraft desktop input gateway (backend only)
Requires=%s.service
After=%s.service
[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 %s
RuntimeDirectory=opencraft-desktop-input
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_UNIX AF_INET
MemoryMax=128M
TasksMax=128
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target`, desktopInputUnit, desktopInputUnit, desktopInputProxyPath)
}

// Used only by explicit resource preparation. Never enables the units at boot
// and never touches the legacy controllable endpoint or the read-only observer.
func renderDesktopInputPrepareCommand() string {
	return fmt.Sprintf(`set -eu
sudo -n install -d -o root -g root -m 0755 /usr/local/libexec/opencraft
stage=$(sudo -n mktemp -d /etc/systemd/system/.desktop-input.XXXXXX)
trap 'sudo -n rm -rf -- "$stage"' EXIT
sudo -n tee "$stage/input" >/dev/null <<'INPUT_UNIT'
%s
INPUT_UNIT
sudo -n tee "$stage/gateway" >/dev/null <<'GATEWAY_UNIT'
%s
GATEWAY_UNIT
sudo -n tee "$stage/proxy" >/dev/null <<'INPUT_PROXY'
%s
INPUT_PROXY
changed=0
for pair in "input:/etc/systemd/system/vela-desktop-input.service" "gateway:/etc/systemd/system/opencraft-desktop-input-gateway.service" "proxy:%s"; do
  name=${pair%%%%:*}
  target=${pair#*:}
  if ! sudo -n cmp -s "$stage/$name" "$target"; then
    changed=1
  fi
  mode=0644
  if [ "$name" = proxy ]; then mode=0700; fi
  sudo -n install -o root -g root -m "$mode" "$stage/$name" "$stage/$name.next"
  sudo -n mv -f -- "$stage/$name.next" "$target"
done
sudo -n systemctl daemon-reload
if [ "$changed" = 1 ]; then
  sudo -n systemctl restart vela-desktop-input.service %s.service
fi
sudo -n systemctl start vela-desktop-input.service %s.service
sudo -n systemctl is-active --quiet vela-desktop-input.service %s.service`,
		renderDesktopInputUnit(), renderDesktopInputProxyUnit(), desktopInputProxySource,
		desktopInputProxyPath, desktopInputProxyUnit, desktopInputProxyUnit, desktopInputProxyUnit)
}

// Grant and revoke share the gateway's lock and conditional update protocol.
func renderDesktopInputGrantCommand(attachmentID string, expiresAtMs int64, ticketDigest, generation, incarnation string) string {
	if !desktopInputValidUUID(attachmentID) || !desktopInputValidUUID(generation) ||
		!desktopInputValidDigest(ticketDigest) || !desktopInputValidDigest(incarnation) || expiresAtMs <= 0 {
		return "exit 1"
	}
	return fmt.Sprintf("sudo -n /usr/bin/python3 %s --grant %s %d %s %s %s",
		desktopInputProxyPath, attachmentID, expiresAtMs, ticketDigest, generation, incarnation)
}

func desktopInputValidUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value
}

func desktopInputValidDigest(value string) bool {
	digest, err := hex.DecodeString(value)
	return err == nil && len(digest) == 32 && hex.EncodeToString(digest) == value
}

func parseDesktopInputEpoch(output string) (string, bool) {
	var payload struct {
		Generation *string `json:"generation"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &payload); err != nil || payload.Generation == nil {
		return "", false
	}
	generation := *payload.Generation
	return generation, generation == "" || desktopInputValidUUID(generation)
}

func renderDesktopInputEpochCommand() string {
	return fmt.Sprintf("sudo -n /usr/bin/python3 %s --epoch", desktopInputProxyPath)
}

func renderDesktopInputActivateCommand(generation, expectedGeneration, incarnation string) string {
	if !desktopInputValidUUID(generation) || !desktopInputValidDigest(incarnation) ||
		(expectedGeneration != "" && !desktopInputValidUUID(expectedGeneration)) {
		return "exit 1"
	}
	if expectedGeneration == "" {
		expectedGeneration = "-"
	}
	return fmt.Sprintf("sudo -n /usr/bin/python3 %s --activate %s %s %s",
		desktopInputProxyPath, generation, expectedGeneration, incarnation)
}

func renderDesktopInputRevokeCommand(attachmentID string, expiresAtMs int64) string {
	id, err := uuid.Parse(attachmentID)
	if err != nil || id.String() != attachmentID || expiresAtMs <= 0 {
		return "exit 1"
	}
	return fmt.Sprintf("sudo -n /usr/bin/python3 %s --revoke %s %d",
		desktopInputProxyPath, attachmentID, expiresAtMs)
}
