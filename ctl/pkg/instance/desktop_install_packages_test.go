package instance

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Execute only the generated inner installer with all mutable paths redirected
// into t.TempDir and privilege/package/service commands replaced by fixtures.
// Never execute its nohup launcher or any real sudo/package/service command.
func TestDesktopInstallScript(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("installer requires bash")
	}
	for _, tc := range []struct {
		name, osRelease, failCommand, missingFile, runtimeUID, runtimeHome string
		wantCalls, forbidCalls                                             []string
		wantFailure                                                        string
	}{
		{
			name: "ubuntu", osRelease: "ID=ubuntu\nVERSION_ID=24.04\n",
			wantCalls:   []string{"apt-get update -y", "DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb x11vnc novnc websockify xfce4 xfce4-terminal dbus-x11 fonts-wqy-zenhei fonts-noto-cjk curl", "systemctl daemon-reload"},
			forbidCalls: []string{"dnf "},
		},
		{
			name: "debian", osRelease: "ID=debian\nVERSION_ID=12\n",
			wantCalls: []string{"apt-get update -y", "apt-get install -y"}, forbidCalls: []string{"dnf "},
		},
		{
			name: "tencentos44", osRelease: "ID=tencentos\nVERSION_ID=\"4.4\"\nID_LIKE=tencentos\n",
			wantCalls:   []string{"dnf install -y xorg-x11-server-Xvfb x11vnc novnc python3-websockify xfce4-session xfce4-panel xfce4-settings xfce4-terminal xfdesktop xfwm4 xfce4-appfinder xfce4-notifyd dbus-daemon dbus-x11 google-noto-sans-cjk-sc-fonts curl", "systemctl daemon-reload"},
			forbidCalls: []string{"apt-get ", "epel-release", "config-manager", "setenforce", "firewall-cmd", "dnf upgrade", "dnf update"},
		},
		{name: "other_tencentos", osRelease: "ID=tencentos\nVERSION_ID=3.1\n", wantFailure: "unsupported TencentOS version", forbidCalls: []string{"dnf ", "apt-get ", "tee "}},
		{name: "unknown_distribution", osRelease: "ID=rocky\nVERSION_ID=9\nID_LIKE=tencentos\n", wantFailure: "unsupported desktop operating system", forbidCalls: []string{"dnf ", "apt-get ", "tee "}},
		{name: "missing_os_release", wantFailure: "cannot read /etc/os-release", forbidCalls: []string{"dnf ", "apt-get ", "tee "}},
		{name: "dnf_failed", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", failCommand: "dnf", wantFailure: "check TencentOS BaseOS/AppStream/EPOL repositories", forbidCalls: []string{"apt-get ", "tee ", "systemctl "}},
		{name: "apt_failed", osRelease: "ID=ubuntu\n", failCommand: "apt-get", wantFailure: "apt update", forbidCalls: []string{"dnf ", "tee ", "systemctl "}},
		{name: "apt_install_failed", osRelease: "ID=ubuntu\n", failCommand: "apt-install", wantFailure: "apt install", wantCalls: []string{"apt-get update -y"}, forbidCalls: []string{"dnf ", "tee ", "systemctl "}},
		{name: "sudo_failed", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", failCommand: "sudo", wantFailure: "non-interactive sudo required", forbidCalls: []string{"dnf ", "tee ", "systemctl "}},
		{name: "user_missing", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", failCommand: "id", wantFailure: "desktop runtime user missing", forbidCalls: []string{"dnf ", "tee "}},
		{name: "user_is_root", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", runtimeUID: "0", wantFailure: "desktop runtime user must not be root", forbidCalls: []string{"dnf ", "tee "}},
		{name: "home_mismatch", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", runtimeHome: "/var/lib/other", wantFailure: "desktop runtime home mismatch", forbidCalls: []string{"dnf ", "tee "}},
		{name: "systemd_missing", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", missingFile: "systemd", wantFailure: "systemd is not running", forbidCalls: []string{"dnf ", "tee "}},
		{name: "binary_missing", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", missingFile: "websockify", wantFailure: "desktop executable missing", forbidCalls: []string{"tee ", "systemctl "}},
		{name: "assets_missing", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", missingFile: "vnc.html", wantFailure: "noVNC assets missing", forbidCalls: []string{"tee ", "systemctl "}},
		{name: "unit_write_failed", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", failCommand: "tee", wantFailure: "write vela-xvfb unit", forbidCalls: []string{"systemctl "}},
		{name: "wm_unit_write_failed", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", failCommand: "vela-desktop-wm.service", wantFailure: "write vela-desktop-wm unit", forbidCalls: []string{"systemctl "}},
		{name: "vnc_unit_write_failed", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", failCommand: "vela-x11vnc.service", wantFailure: "write vela-x11vnc unit", forbidCalls: []string{"systemctl "}},
		{name: "novnc_unit_write_failed", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", failCommand: "vela-novnc.service", wantFailure: "write vela-novnc unit", forbidCalls: []string{"systemctl "}},
		{name: "observer_unit_write_failed", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", failCommand: "vela-desktop-observer.service", wantFailure: "write vela-desktop-observer unit", forbidCalls: []string{"systemctl "}},
		{name: "reload_failed", osRelease: "ID=tencentos\nVERSION_ID=4.4\n", failCommand: "systemctl", wantFailure: "daemon-reload"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			bin := filepath.Join(dir, "bin")
			units := filepath.Join(dir, "units")
			systemd := filepath.Join(dir, "systemd")
			for _, path := range []string{bin, units, systemd} {
				if err := os.Mkdir(path, 0755); err != nil {
					t.Fatal(err)
				}
			}
			write := func(path, content string, mode os.FileMode) {
				t.Helper()
				if err := os.WriteFile(path, []byte(content), mode); err != nil {
					t.Fatal(err)
				}
			}
			osRelease := filepath.Join(dir, "os-release")
			if tc.osRelease != "" {
				write(osRelease, tc.osRelease, 0644)
			}
			assets := filepath.Join(dir, "vnc.html")
			write(assets, "test noVNC assets", 0644)
			for _, name := range []string{"Xvfb", "x11vnc", "websockify", "dbus-run-session", "startxfce4"} {
				write(filepath.Join(bin, name), "#!/bin/bash\nexit 0\n", 0755)
			}
			for _, name := range []string{"sudo", "apt-get", "dnf", "systemctl", "tee", "id", "getent"} {
				write(filepath.Join(bin, name), `#!/bin/bash
name=${0##*/}
[ "$MOCK_FAIL" != "$name" ] || exit 17
case "$name" in
  sudo)
    [ "$1" = "-n" ] || exit 18
    shift
    printf '%s\n' "$*" >> "$MOCK_CALLS"
    exec env "$@"
    ;;
  tee)
    [ "$MOCK_FAIL" != "${1##*/}" ] || exit 17
    exec /usr/bin/tee "$@"
    ;;
  apt-get)
    [ "$MOCK_FAIL" != apt-install ] || [ "$1" != install ] || exit 17
    ;;
  id) echo "$MOCK_UID" ;;
  getent) echo "agentuser:x:1000:1000::${MOCK_HOME}:/bin/bash" ;;
  *) exit 0 ;;
esac
`, 0755)
			}
			if tc.missingFile != "" {
				path := filepath.Join(bin, tc.missingFile)
				if tc.missingFile == "vnc.html" {
					path = assets
				} else if tc.missingFile == "systemd" {
					path = systemd
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			}
			_, inner, ok := strings.Cut(renderDesktopInstallCommand(), "<<'INSTALL' || exit 1\n")
			if !ok {
				t.Fatal("installer heredoc missing")
			}
			inner, _, ok = strings.Cut(inner, "\nINSTALL\n")
			if !ok {
				t.Fatal("installer heredoc end missing")
			}
			progress := filepath.Join(dir, "progress")
			log := filepath.Join(dir, "log")
			calls := filepath.Join(dir, "calls")
			inner = strings.NewReplacer(
				desktopInstallProgressFile, progress,
				"/tmp/vela-desktop-install.log", log,
				"/etc/os-release", osRelease,
				"/run/systemd/system", systemd,
				"/etc/systemd/system/", units+"/",
				"/usr/bin/", bin+"/",
				"/usr/share/novnc/vnc.html", assets,
			).Replace(inner)
			for _, unsafe := range []string{"/etc/systemd/", "/run/systemd/", "/tmp/vela-desktop", "/usr/bin/"} {
				if strings.Contains(inner, unsafe) {
					t.Fatalf("unredirected system path: %s", unsafe)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "bash", "-c", inner)
			cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "MOCK_CALLS="+calls, "MOCK_FAIL="+tc.failCommand)
			uid, home := tc.runtimeUID, tc.runtimeHome
			if uid == "" {
				uid = "1000"
			}
			if home == "" {
				home = "/home/agentuser"
			}
			cmd.Env = append(cmd.Env, "MOCK_UID="+uid, "MOCK_HOME="+home)
			out, err := cmd.CombinedOutput()
			pf, readErr := os.ReadFile(progress)
			if readErr != nil {
				t.Fatalf("progress not written: %v (run=%v, output=%s)", readErr, err, out)
			}
			installLog, _ := os.ReadFile(log)
			if tc.wantFailure != "" {
				if err == nil || !strings.Contains(string(pf), desktopInstallFailMarker) || strings.Contains(string(pf), desktopInstallDoneMarker) {
					t.Fatalf("failure not propagated: err=%v progress=%s output=%s", err, pf, out)
				}
				// Paths in log diagnostics were redirected with the executable script.
				want := strings.ReplaceAll(tc.wantFailure, "/etc/os-release", osRelease)
				if !strings.Contains(string(installLog), want) {
					t.Fatalf("log missing %q: %s", want, installLog)
				}
			} else {
				if err != nil || !strings.Contains(string(pf), desktopInstallDoneMarker) || strings.Contains(string(pf), desktopInstallFailMarker) {
					t.Fatalf("install did not finish: err=%v progress=%s log=%s output=%s", err, pf, installLog, out)
				}
				for _, unit := range strings.Fields(desktopSystemdUnits) {
					content, err := os.ReadFile(filepath.Join(units, unit+".service"))
					if err != nil || !strings.Contains(string(content), "User=agentuser\n") {
						t.Fatalf("unit identity missing: %s: %v (%s)", unit, err, content)
					}
				}
				observer, err := os.ReadFile(filepath.Join(units, desktopObserverUnit+".service"))
				if err != nil || strings.TrimSpace(string(observer)) != strings.TrimSpace(strings.ReplaceAll(renderDesktopObserverUnit(), "/usr/bin/", bin+"/")) {
					t.Fatalf("observer unit not installed verbatim: %v", err)
				}
			}
			invocations, _ := os.ReadFile(calls)
			for _, want := range tc.wantCalls {
				if !strings.Contains(string(invocations), want) {
					t.Errorf("command %q missing: %s", want, invocations)
				}
			}
			for _, forbidden := range tc.forbidCalls {
				if strings.Contains(string(invocations), forbidden) {
					t.Errorf("unexpected command %q: %s", forbidden, invocations)
				}
			}
		})
	}
}

func TestDesktopInstallScriptBashSyntax(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("installer requires bash")
	}
	outer := renderDesktopInstallCommand()
	_, inner, ok := strings.Cut(outer, "<<'INSTALL' || exit 1\n")
	if !ok {
		t.Fatal("installer heredoc missing")
	}
	inner, _, ok = strings.Cut(inner, "\nINSTALL\n")
	if !ok {
		t.Fatal("installer heredoc end missing")
	}
	for name, script := range map[string]string{"launcher": outer, "installer": inner} {
		t.Run(name, func(t *testing.T) {
			cmd := exec.Command("bash", "-n")
			cmd.Stdin = strings.NewReader(script)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("Bash syntax: %v\n%s", err, out)
			}
		})
	}
}
