package instance

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"time"

	pctx "ctl/pkg/context"
	"go.uber.org/zap"
)

// Keep this asset identical to images/runtime/desktop/vela-wallpaper.png.
// Payload chunks travel in separate ExecCommand requests, never in the installer.
//
//go:embed vela-wallpaper.png
var desktopWallpaperPNG []byte

const (
	desktopWallpaperPath       = "/usr/share/backgrounds/vela/vela-wallpaper.png"
	desktopWallpaperChunkBytes = 32 << 10 // Raw bytes; base64 expands each request to about 44 KiB.
	desktopInstallCommandLimit = 60 << 10 // Reserve 4 KiB below the Sandbox bash-field limit for prefixes.
	desktopWallpaperDirMarker  = "DESKTOP_WALLPAPER_DIR="
)

var desktopWallpaperDirPattern = regexp.MustCompile(`^/tmp/vela-wallpaper\.[A-Za-z0-9]{10}$`)

func wallpaperRootCommand(body string) string {
	return "sudo -n bash <<'VELA_WALLPAPER'\nset -eu\numask 077\n" + body + "\nVELA_WALLPAPER"
}

func renderDesktopWallpaperInitCommand() string {
	return wallpaperRootCommand(`dir=$(mktemp -d /tmp/vela-wallpaper.XXXXXXXXXX)
trap 'rm -rf -- "$dir"' EXIT
# Remove abandoned uploads even if CTL exits or the init response is lost.
nohup bash -c 'trap '\''rm -rf -- "$1"'\'' EXIT; sleep 900' -- "$dir" </dev/null >/dev/null 2>&1 &
printf 'DESKTOP_WALLPAPER_DIR=%s\n' "$dir"
trap - EXIT`)
}

func desktopWallpaperDirectory(output string) (string, error) {
	for _, line := range strings.Split(output, "\n") {
		if dir, ok := strings.CutPrefix(strings.TrimSpace(line), desktopWallpaperDirMarker); ok {
			if desktopWallpaperDirPattern.MatchString(dir) {
				return dir, nil
			}
		}
	}
	return "", fmt.Errorf("wallpaper upload directory missing or invalid")
}

// A fixed numbered file makes resubmission idempotent; append would duplicate data
// when the HTTP adapter retries a request whose response was lost.
func renderDesktopWallpaperChunkCommand(dir string, index int, chunk []byte) string {
	return wallpaperRootCommand(fmt.Sprintf(`dir=%q
[ -d "$dir" ] && [ ! -L "$dir" ]
[ "$(stat -c '%%u:%%a' "$dir")" = '0:700' ]
printf '%%s' '%s' | base64 -d > "$dir/chunk-%06d"`, dir, base64.StdEncoding.EncodeToString(chunk), index))
}

func renderDesktopWallpaperFinalizeCommand(dir string) string {
	return wallpaperRootCommand(fmt.Sprintf(`dir=%q
[ -d "$dir" ] && [ ! -L "$dir" ]
[ "$(stat -c '%%u:%%a' "$dir")" = '0:700' ]
image_tmp=''
trap 'rm -rf -- "$dir"; if [ -n "$image_tmp" ]; then rm -f -- "$image_tmp"; fi' EXIT
cat "$dir"/chunk-* > "$dir/wallpaper.png"
printf '%%s  %%s\n' '%x' "$dir/wallpaper.png" | sha256sum -c -
sys_img=%q
if ! cmp -s "$dir/wallpaper.png" "$sys_img"; then
  install -d -m 0755 /usr/share/backgrounds/vela
  image_tmp=$(mktemp /usr/share/backgrounds/vela/.wallpaper.XXXXXXXXXX)
  install -m 0644 "$dir/wallpaper.png" "$image_tmp"
  mv -fT -- "$image_tmp" "$sys_img"
  image_tmp=''
fi`, dir, sha256.Sum256(desktopWallpaperPNG), desktopWallpaperPath))
}

func renderDesktopWallpaperCleanupCommand(dir string) string {
	return wallpaperRootCommand(fmt.Sprintf("rm -rf -- %q", dir))
}

// Runs inside the existing detached installation job, after packages are ready.
// Each request is fenced against the current instance binding and retains session auth.
func (l *logic) installDesktopWallpaper(parent pctx.Context, session *desktopSession, sandboxID string) error {
	budget := 90 * time.Second
	if deadline, ok := parent.Deadline(); ok {
		// Keep cleanup and the final binding check inside the installation budget.
		budget = min(budget, time.Until(deadline)-25*time.Second)
		if budget <= 0 {
			return fmt.Errorf("insufficient remaining time for optional wallpaper")
		}
	}
	job, cancel := context.WithTimeout(parent, budget)
	defer cancel()
	ctx := parent.WithContext(job)
	execute := func(c pctx.Context, command string) (string, error) {
		if err := c.Err(); err != nil {
			return "", err
		}
		result, err := l.execDesktopInstallCommand(c, session, sandboxID, command)
		if err != nil {
			return "", err
		}
		if !sandboxCommandSucceeded(result) {
			return "", fmt.Errorf("wallpaper command failed: %s", sandboxCommandFailureDetail(result))
		}
		return desktopCommandOutput(result), nil
	}
	output, err := execute(ctx, renderDesktopWallpaperInitCommand())
	if err != nil {
		return fmt.Errorf("create wallpaper upload: %w", err)
	}
	dir, err := desktopWallpaperDirectory(output)
	if err != nil {
		return err
	}
	defer func() {
		// Cancellation must not prevent cleanup. Do not bypass binding/ownership checks.
		cleanup, stop := context.WithTimeout(context.WithoutCancel(parent), 20*time.Second)
		defer stop()
		if _, err := execute(parent.WithContext(cleanup), renderDesktopWallpaperCleanupCommand(dir)); err != nil {
			l.logger.Warn("desktop wallpaper cleanup deferred to remote expiry", zap.Error(err))
		}
	}()
	for offset, index := 0, 0; offset < len(desktopWallpaperPNG); index++ {
		end := min(offset+desktopWallpaperChunkBytes, len(desktopWallpaperPNG))
		if _, err := execute(ctx, renderDesktopWallpaperChunkCommand(dir, index, desktopWallpaperPNG[offset:end])); err != nil {
			return fmt.Errorf("upload wallpaper chunk %d: %w", index, err)
		}
		offset = end
	}
	if _, err := execute(ctx, renderDesktopWallpaperFinalizeCommand(dir)); err != nil {
		return fmt.Errorf("verify/install wallpaper: %w", err)
	}
	// Always repair settings, even when image contents were already identical.
	if _, err := execute(ctx, renderDesktopInstallWallpaperCommand()); err != nil {
		return fmt.Errorf("configure wallpaper: %w", err)
	}
	return nil
}

// Settings are modified as the desktop user, not root. Atomic XML replacement
// preserves unrelated properties and repairs missing or malformed configuration.
func renderDesktopInstallWallpaperCommand() string {
	return fmt.Sprintf(`DESKTOP_USER=${DESKTOP_USER:-%q}
DESKTOP_HOME=${DESKTOP_HOME:-%q}
sudo -n -u "$DESKTOP_USER" env HOME="$DESKTOP_HOME" DISPLAY=:1 python3 - %q <<'WALLPAPER_CONFIG'
import os
import pathlib
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import sys

image = sys.argv[1]
if not os.path.isfile(image):
    raise RuntimeError("wallpaper image is missing")
# A running xfconfd owns its channel. Use its session bus instead of racing its
# in-memory settings with an offline XML replacement.
active = False
for process in sorted(pathlib.Path("/proc").glob("[0-9]*")):
    try:
        if process.stat().st_uid != os.getuid():
            continue
        name = (process / "comm").read_text().strip()
        if name not in ("xfconfd", "xfdesktop", "xfce4-session"):
            continue
        raw = (process / "environ").read_bytes().split(b"\0")
        env = dict(item.decode().split("=", 1) for item in raw if b"=" in item)
        if env.get("DISPLAY", "").split(".")[0] != ":1":
            continue
        active = True
        bus = env.get("DBUS_SESSION_BUS_ADDRESS")
        if not bus:
            continue
    except (OSError, UnicodeError, ValueError):
        continue
    live_env = dict(os.environ, DBUS_SESSION_BUS_ADDRESS=bus)
    def query(args):
        return subprocess.run(["xfconf-query", "-c", "xfce4-desktop"] + args,
                              env=live_env, check=True, capture_output=True, text=True, timeout=2)
    properties = query(["-l"]).stdout.splitlines()
    targets = {"/backdrop/screen0/" + m + "/workspace" + str(w)
               for m in ("monitorscreen", "monitor0") for w in range(4)}
    targets.update(p.rsplit("/", 1)[0] for p in properties if p.startswith("/backdrop/")
                   and p.endswith("/last-image"))
    for target in sorted(targets):
        for key, kind, value in (("last-image", "string", image), ("image-style", "int", "5")):
            prop = target + "/" + key
            args = ["-p", prop, "-s", value]
            if prop not in properties:
                args += ["--create", "-t", kind]
            query(args)
    subprocess.run(["xfdesktop", "--reload"], env=live_env, check=True, timeout=2)
    sys.exit(0)
if active:
    raise RuntimeError("active desktop session bus is unavailable")
folder = os.path.join(os.environ["HOME"], ".config/xfce4/xfconf/xfce-perchannel-xml")
os.makedirs(folder, mode=0o700, exist_ok=True)
path = os.path.join(folder, "xfce4-desktop.xml")
try:
    root = ET.parse(path).getroot()
    if root.tag != "channel" or root.get("name") != "xfce4-desktop":
        raise ValueError("invalid channel")
except (FileNotFoundError, ET.ParseError, ValueError):
    root = ET.Element("channel", name="xfce4-desktop", version="1.0")

def prop(parent, name, kind="empty", value=None):
    child = next((c for c in parent if c.tag == "property" and c.get("name") == name), None)
    if child is None:
        child = ET.SubElement(parent, "property", name=name)
    child.set("type", kind)
    if value is not None:
        child.set("value", value)
    return child

screen = prop(prop(root, "backdrop"), "screen0")
monitors = {"monitorscreen", "monitor0"}
monitors.update(c.get("name") for c in screen if c.get("name", "").startswith("monitor"))
for monitor in sorted(monitors):
    node = prop(screen, monitor)
    workspaces = {"workspace" + str(n) for n in range(4)}
    workspaces.update(c.get("name") for c in node if c.get("name", "").startswith("workspace"))
    for workspace in sorted(workspaces):
        target = prop(node, workspace)
        prop(target, "last-image", "string", image)
        prop(target, "image-style", "int", "5")
fd, tmp = tempfile.mkstemp(prefix=".vela-wallpaper-", dir=folder)
try:
    with os.fdopen(fd, "wb") as stream:
        ET.ElementTree(root).write(stream, encoding="UTF-8", xml_declaration=True)
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
WALLPAPER_CONFIG
`, desktopRuntimeUser, "/home/"+desktopRuntimeUser, desktopWallpaperPath)
}
