package instance

import (
	_ "embed"
	"fmt"
	"strings"
)

const (
	desktopObserverUnit      = "vela-desktop-observer"
	desktopObserverPort      = 5901
	desktopObserverProxyUnit = "opencraft-desktop-observer-proxy"
)

//go:embed desktop_observer_proxy.py
var desktopObserverProxySource string

// Separate from the legacy controllable server on 5900. Authorization belongs
// to the future backend viewer broker; clients must never receive raw TAT
// credentials. No RFB input parser or client-side viewOnly is trusted here.
func desktopObserverArguments(display string, port int) []string {
	return []string{"-norc", "-display", display, "-rfbport", fmt.Sprint(port),
		"-localhost", "-no6", "-nopw", "-viewonly", "-nosel", "-noremote",
		"-nocmds", "-novncconnect", "-forever", "-shared", "-noxdamage", "-wait", "20", "-defer", "20"}
}

func renderDesktopObserverUnit() string {
	return fmt.Sprintf(`[Unit]
Description=vela read-only desktop observer (backend access only)
Requires=vela-xvfb.service
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
		strings.Join(desktopObserverArguments(":1", desktopObserverPort), " "))
}

// This root process is a narrow observation verifier, never an input executor.
// Root is required for peer process /proc/fd checks and a non-agent-readable key.
func renderDesktopObserverProxyUnit() string {
	return `[Unit]
Description=OpenCraft verified desktop observer (backend only)
Requires=vela-desktop-observer.service
After=vela-desktop-observer.service
[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 /usr/local/libexec/opencraft/desktop-observer.py
RuntimeDirectory=opencraft-desktop-observer
RuntimeDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_UNIX AF_INET
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE
MemoryMax=128M
TasksMax=128
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target`
}

// Used only by explicit resource preparation, including preinstalled images.
// Does not enable units at boot or change the legacy controllable endpoint.
func renderDesktopObserverPrepareCommand() string {
	return fmt.Sprintf(`set -eu
test -x /usr/bin/python3
sudo -n install -d -o root -g root -m 0755 /usr/local/libexec/opencraft
observer_proxy_changed=0
observer_unit_changed=0
observer_tmp=$(sudo -n mktemp /usr/local/libexec/opencraft/desktop-observer.XXXXXX)
trap 'sudo -n rm -f -- "$observer_tmp" "$observer_tmp.next"' EXIT
observer_write() {
  sudo -n tee "$observer_tmp" >/dev/null
  if ! sudo -n cmp -s "$observer_tmp" "$1"; then
    case "$1" in
      /etc/systemd/system/vela-desktop-observer.service) observer_unit_changed=1 ;;
      *) observer_proxy_changed=1 ;;
    esac
  fi
  # Replace the inode, not just its mode: an old writable descriptor must not
  # modify the new root-owned source. The staging directory is root-owned.
  sudo -n install -o root -g root -m 0644 "$observer_tmp" "$observer_tmp.next"
  sudo -n mv -f -- "$observer_tmp.next" "$1"
}
observer_write /usr/local/libexec/opencraft/desktop-observer.py <<'OBSERVER_PY'
%s
OBSERVER_PY
observer_write /etc/systemd/system/vela-desktop-observer.service <<'OBSERVER_UNIT'
%s
OBSERVER_UNIT
observer_write /etc/systemd/system/opencraft-desktop-observer-proxy.service <<'PROXY_UNIT'
%s
PROXY_UNIT
sudo -n systemctl daemon-reload
if [ "$observer_unit_changed" = 1 ]; then
  sudo -n systemctl restart vela-desktop-observer.service
fi
if [ "$observer_proxy_changed" = 1 ] || [ "$observer_unit_changed" = 1 ]; then
  sudo -n systemctl restart opencraft-desktop-observer-proxy.service
fi
sudo -n systemctl start vela-desktop-observer.service opencraft-desktop-observer-proxy.service
sudo -n systemctl is-active --quiet vela-desktop-observer.service opencraft-desktop-observer-proxy.service`,
		desktopObserverProxySource, renderDesktopObserverUnit(), renderDesktopObserverProxyUnit())
}
