package instance

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

// Reserve 4 KiB for adapter prefixes below Sandbox's 64 KiB bash-field limit.
// Neither output limits nor individual shell line lengths constrain the input.
func TestDesktopInstallCommandStaysWithinTATLimit(t *testing.T) {
	command := renderDesktopInstallCommand()
	if size := len(command); size >= 60<<10 {
		t.Fatalf("complete installer is %d bytes; must be below 60 KiB before adapter prefixes", size)
	}
	if strings.Contains(command, base64.StdEncoding.EncodeToString(desktopWallpaperPNG)[:256]) {
		t.Fatal("installer must not carry the wallpaper payload")
	}
}

func TestDesktopWallpaperWireCommandIncludesPrefixWithinLimit(t *testing.T) {
	bodies := make(chan string, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var request struct {
				Bash string `json:"bash"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			if r.Header.Get("Authorization") != "Bearer wire-test" || r.Header.Get("Cookie") != "lc_session=wire-test" {
				t.Error("wire authentication lost")
			}
			bodies <- request.Bash
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(psandbox.TATCommandResponse{InvocationID: "inv-wallpaper", Status: "PENDING"})
		} else {
			_ = json.NewEncoder(w).Encode(psandbox.TATCommandResult{TATCommandResponse: psandbox.TATCommandResponse{InvocationID: "inv-wallpaper", Status: "SUCCESS"}})
		}
	}))
	defer server.Close()
	adapter := psandbox.NewSandboxAdapter(&config.SandboxConfig{BaseURL: server.URL, APIKey: "test", Timeout: 2}, zap.NewNop())
	ctx := pctx.NewContext(context.Background()).WithSessionAuth("Bearer wire-test", "lc_session=wire-test")
	for _, command := range []string{renderDesktopInstallCommand(), renderDesktopWallpaperChunkCommand("/tmp/vela-wallpaper.A123456789", 0, desktopWallpaperPNG[:desktopWallpaperChunkBytes]), renderDesktopInstallWallpaperCommand()} {
		if _, err := adapter.ExecCommand(ctx, "sbx-test", command, 3); err != nil {
			t.Fatal(err)
		}
		wire := <-bodies
		if len(wire) <= len(command) || !strings.HasSuffix(wire, command) || len(wire) >= 64<<10 {
			t.Fatalf("invalid full wire size: script=%d wire=%d", len(command), len(wire))
		}
		t.Logf("script=%d bytes; complete wire bash=%d bytes", len(command), len(wire))
	}
}

func TestDesktopInstallPhaseResponseLifecycle(t *testing.T) {
	resetDesktopSessionsForTest()
	fastDesktopInstallPoll(t)
	sb := &desktopSandboxStub{}
	l, _, ctx := desktopResourceFixture(sb)
	session, err := l.desktopSessionForEntity(ctx, desktopTestEntity())
	if err != nil {
		t.Fatal(err)
	}
	read := func() map[string]any {
		t.Helper()
		response, err := l.desktopSessionResponse(session)
		if err != nil {
			t.Fatal(err)
		}
		body, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]any
		if err := json.Unmarshal(body, &fields); err != nil {
			t.Fatal(err)
		}
		return fields
	}
	session.tryBeginInstall("legacy Chinese message")
	if got := read()["install_phase"]; got != "installing_desktop" {
		t.Fatalf("initial install_phase=%v", got)
	}
	sawWallpaper := false
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		output := desktopInstallDoneMarker
		if strings.Contains(command, desktopWallpaperDirMarker) {
			fields := read()
			if fields["install_phase"] != "configuring_wallpaper" || fields["install_progress"] != float64(95) || fields["status"] != "Installing" {
				t.Fatalf("wallpaper response=%v", fields)
			}
			sawWallpaper = true
			output = desktopWallpaperDirMarker + "/tmp/vela-wallpaper.A123456789"
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", Output: output}, nil
	}
	l.runDesktopInstall(ctx, desktopTestEntity().SandboxId, session)
	if !sawWallpaper {
		t.Fatal("wallpaper phase not observed")
	}
	if fields := read(); fields["status"] != "Provisioning" || fields["install_phase"] != nil || fields["message"] != nil {
		t.Fatalf("stale phase after install: %v", fields)
	}
	session.tryBeginInstall("retry")
	if got := read()["install_phase"]; got != "installing_desktop" {
		t.Fatalf("retry phase=%v", got)
	}
	session.endInstall(transport.DesktopSessionStatusFailed, "internal diagnostic")
	if got := read()["install_phase"]; got != nil {
		t.Fatalf("failed phase=%v", got)
	}
}

func TestDesktopInstallDispatchesWallpaperSeparately(t *testing.T) {
	resetDesktopSessionsForTest()
	fastDesktopInstallPoll(t)
	sb := &desktopSandboxStub{}
	l, _, ctx := desktopResourceFixture(sb)
	ctx = ctx.WithSessionAuth("Bearer wallpaper-test", "lc_session=wallpaper-test")
	session, err := l.desktopSessionForEntity(ctx, desktopTestEntity())
	if err != nil {
		t.Fatal(err)
	}
	session.tryBeginInstall("")
	chunks, finalized, oversized := 0, false, 0
	sb.execFunc = func(command string) (*psandbox.ExecCommandResult, error) {
		if len(command) >= 60<<10 {
			oversized++
			return nil, fmt.Errorf("bash is too large: %d", len(command))
		}
		out := ""
		switch {
		case strings.Contains(command, "DESKTOP_WALLPAPER_DIR="):
			out = "DESKTOP_WALLPAPER_DIR=/tmp/vela-wallpaper.A123456789"
		case strings.Contains(command, "base64 -d"):
			chunks++
		case strings.Contains(command, "sha256sum -c"):
			finalized = true
		case strings.Contains(command, "vela-desktop-install.sh"):
			out = desktopInstallStartedMark
		default:
			out = desktopInstallDoneMarker
		}
		return &psandbox.ExecCommandResult{Status: "SUCCESS", Output: out}, nil
	}
	l.runDesktopInstall(ctx, desktopTestEntity().SandboxId, session)
	if oversized != 0 || chunks < 2 || !finalized {
		t.Fatalf("separate transfer missing: oversized=%d chunks=%d finalized=%v", oversized, chunks, finalized)
	}
	if _, _, status, reason, _ := session.snapshot(); status != transport.DesktopSessionStatusProvisioning {
		t.Fatalf("status=%s reason=%s", status, reason)
	}
	for _, auth := range sb.execAuthsSnapshot() {
		if auth != "Bearer wallpaper-test" {
			t.Fatal("session auth lost during transfer")
		}
	}
}

type wallpaperExecAdapter struct {
	psandbox.Adapter
	execute func(context.Context, string) (*psandbox.ExecCommandResult, error)
}

func (a *wallpaperExecAdapter) ExecCommand(ctx context.Context, _ string, command string, _ int) (*psandbox.ExecCommandResult, error) {
	return a.execute(ctx, command)
}

func TestDesktopWallpaperTransferFailureAndCleanup(t *testing.T) {
	for _, failure := range []string{"none", "create", "chunk", "verify", "config", "cancel", "target"} {
		t.Run(failure, func(t *testing.T) {
			resetDesktopSessionsForTest()
			base, cancel := context.WithCancel(context.Background())
			defer cancel()
			a := &wallpaperExecAdapter{}
			l, dao, ctx := desktopResourceFixture(a)
			ctx = ctx.WithContext(base).WithRegion("cn").WithSessionAuth("Bearer test", "lc_session=test")
			session, err := l.desktopSessionForEntity(ctx, desktopTestEntity())
			if err != nil {
				t.Fatal(err)
			}
			var received []byte
			cleaned, finalized, configured, canceledCleanup := false, false, false, false
			a.execute = func(callCtx context.Context, command string) (*psandbox.ExecCommandResult, error) {
				metadata := callCtx.(pctx.Context)
				if metadata.GetSessionCookie() != "lc_session=test" || metadata.GetSessionAuthorization() != "Bearer test" || metadata.GetRegion() != "cn" || metadata.GetUserID() != ctx.GetUserID() {
					t.Fatal("request metadata lost")
				}
				if len(command) >= 60<<10 {
					t.Fatalf("oversize request %d", len(command))
				}
				out := ""
				switch {
				case strings.Contains(command, desktopWallpaperDirMarker):
					if failure == "create" {
						return nil, errors.New("create failure")
					}
					out = desktopWallpaperDirMarker + "/tmp/vela-wallpaper.A123456789"
				case strings.Contains(command, "base64 -d"):
					if failure == "cancel" {
						cancel()
						return nil, context.Canceled
					}
					if failure == "chunk" {
						return &psandbox.ExecCommandResult{Status: "FAILED", ExitCode: 1}, nil
					}
					if failure == "target" {
						dao.mu.Lock()
						dao.entity.SandboxId = "replacement"
						dao.mu.Unlock()
					}
					_, payload, ok := strings.Cut(command, "printf '%s' '")
					if !ok {
						t.Fatal("chunk payload missing")
					}
					payload, _, _ = strings.Cut(payload, "'")
					chunk, err := base64.StdEncoding.DecodeString(payload)
					if err != nil {
						t.Fatal(err)
					}
					received = append(received, chunk...)
					if strings.Contains(command, ">>") {
						t.Fatal("retries would append duplicate chunks")
					}
				case strings.Contains(command, "sha256sum -c"):
					if failure == "verify" {
						return nil, errors.New("hash mismatch")
					}
					if !bytes.Equal(received, desktopWallpaperPNG) {
						t.Fatal("transferred image differs")
					}
					finalized = true
				case strings.Contains(command, "WALLPAPER_CONFIG"):
					if failure == "config" {
						return nil, errors.New("configuration failure")
					}
					configured = true
				default:
					cleaned = true
					canceledCleanup = callCtx.Err() != nil
				}
				return &psandbox.ExecCommandResult{Status: "SUCCESS", Output: out}, nil
			}
			err = l.installDesktopWallpaper(ctx, session, desktopTestEntity().SandboxId)
			if (err == nil) != (failure == "none") {
				t.Fatalf("failure=%s err=%v", failure, err)
			}
			if failure == "none" && (!finalized || !configured) {
				t.Fatal("image/config not finalized")
			}
			if failure != "none" && configured {
				t.Fatal("configuration ran after transfer failure")
			}
			wantCleanup := failure != "create" && failure != "target"
			if cleaned != wantCleanup || canceledCleanup {
				t.Fatalf("cleanup=%v canceled=%v", cleaned, canceledCleanup)
			}
		})
	}
}

func TestDesktopWallpaperPrivateDirectoryAndSyntax(t *testing.T) {
	for _, output := range []string{"", "DESKTOP_WALLPAPER_DIR=/", "DESKTOP_WALLPAPER_DIR=/tmp/vela-wallpaper.;rm -rf", "DESKTOP_WALLPAPER_DIR=/tmp/vela-wallpaper.abcdefghij/../"} {
		if _, err := desktopWallpaperDirectory(output); err == nil {
			t.Fatalf("accepted untrusted directory %q", output)
		}
	}
	init := renderDesktopWallpaperInitCommand()
	if !strings.Contains(init, "mktemp -d") || !strings.Contains(init, "umask 077") || !strings.Contains(init, "trap ") || !strings.Contains(init, "sleep 900") {
		t.Fatal("missing private directory or cleanup safeguards")
	}
	dir := "/tmp/vela-wallpaper.A123456789"
	for _, command := range []string{init, renderDesktopWallpaperChunkCommand(dir, 0, desktopWallpaperPNG[:32<<10]), renderDesktopWallpaperFinalizeCommand(dir), renderDesktopWallpaperCleanupCommand(dir), renderDesktopInstallWallpaperCommand()} {
		cmd := exec.Command("bash", "-n")
		cmd.Stdin = strings.NewReader(command)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("shell syntax: %v %s", err, out)
		}
		if len(command) >= 60<<10 {
			t.Fatal("whole command exceeds budget")
		}
	}
}

func TestDesktopWallpaperSkipsWhenInstallBudgetAlmostExhausted(t *testing.T) {
	resetDesktopSessionsForTest()
	job, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sb := &desktopSandboxStub{}
	l, _, ctx := desktopResourceFixture(sb)
	ctx = ctx.WithContext(job)
	session, err := l.desktopSessionForEntity(ctx, desktopTestEntity())
	if err != nil {
		t.Fatal(err)
	}
	if err := l.installDesktopWallpaper(ctx, session, desktopTestEntity().SandboxId); err == nil {
		t.Fatal("expected optional wallpaper to be skipped")
	}
	if sb.execCmdCount() != 0 {
		t.Fatal("optional upload must not consume exhausted installation budget")
	}
}

func TestDesktopWallpaperUpdatesRunningSession(t *testing.T) {
	dir := t.TempDir()
	proc := filepath.Join(dir, "proc", "123")
	bin := filepath.Join(dir, "bin")
	for _, folder := range []string{proc, bin} {
		if err := os.MkdirAll(folder, 0700); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, data string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(path, []byte(data), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(proc, "comm"), "xfce4-session\n", 0600)
	write(filepath.Join(proc, "environ"), "DISPLAY=:1\x00DBUS_SESSION_BUS_ADDRESS=unix:path=/test/bus\x00", 0600)
	image := filepath.Join(dir, "image.png")
	write(image, string(desktopWallpaperPNG), 0600)
	calls := filepath.Join(dir, "calls")
	for _, tool := range []string{"xfconf-query", "xfdesktop"} {
		write(filepath.Join(bin, tool), "#!/bin/sh\nprintf '%s %s\\n' \"$DBUS_SESSION_BUS_ADDRESS\" \"$*\" >> \"$CALLS\"\n", 0700)
	}
	script := strings.NewReplacer(desktopWallpaperPath, image, `"/proc"`, fmt.Sprintf("%q", filepath.Dir(proc))).Replace(renderDesktopInstallWallpaperCommand())
	cmd := exec.Command("bash")
	cmd.Stdin = strings.NewReader(`sudo(){ [ "$1" = -n ] && shift; if [ "$1" = -u ]; then shift 2; fi; "$@"; }
` + script)
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "CALLS="+calls, "DESKTOP_HOME="+filepath.Join(dir, "home"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	out, err := os.ReadFile(calls)
	if err != nil || !strings.Contains(string(out), "unix:path=/test/bus") || !strings.Contains(string(out), "workspace3/last-image") {
		t.Fatalf("live session not updated: %v %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(dir, "home/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml")); !os.IsNotExist(err) {
		t.Fatal("must not race live xfconfd with offline XML writes")
	}
}

func TestDesktopWallpaperRepairsConfigWithExistingImage(t *testing.T) {
	for _, initial := range []string{"", "<broken", `<channel name="xfce4-desktop" version="1.0"><property name="custom" type="string" value="keep-me"/></channel>`} {
		t.Run(fmt.Sprintf("initial_%d", len(initial)), func(t *testing.T) {
			dir := t.TempDir()
			home := filepath.Join(dir, "home")
			config := filepath.Join(home, ".config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml")
			if err := os.MkdirAll(filepath.Dir(config), 0700); err != nil {
				t.Fatal(err)
			}
			if initial != "" {
				if err := os.WriteFile(config, []byte(initial), 0600); err != nil {
					t.Fatal(err)
				}
			}
			image := filepath.Join(dir, "wallpaper.png")
			if err := os.WriteFile(image, desktopWallpaperPNG, 0644); err != nil {
				t.Fatal(err)
			}
			script := strings.NewReplacer(desktopWallpaperPath, image,
				`"/proc"`, fmt.Sprintf("%q", filepath.Join(dir, "empty-proc"))).Replace(renderDesktopInstallWallpaperCommand())
			// Scope this test to offline configuration; never use real sudo or a live bus.
			prefix := `sudo(){ [ "$1" = -n ] && shift; if [ "$1" = -u ]; then shift 2; fi; "$@"; }
`
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "bash")
			cmd.Stdin = strings.NewReader(prefix + script)
			cmd.Env = append(os.Environ(), "DESKTOP_USER=test-user", "DESKTOP_HOME="+home, "LOG="+filepath.Join(dir, "log"))
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("config command: %v %s", err, out)
			}
			xml, err := os.ReadFile(config)
			if err != nil || !strings.Contains(string(xml), image) {
				t.Fatalf("existing image must not skip config repair: %v %s", err, xml)
			}
			if strings.Contains(initial, "keep-me") && !strings.Contains(string(xml), "keep-me") {
				t.Fatal("unrelated settings lost")
			}
		})
	}
}

func TestDesktopWallpaperEmbeddedAssetIsPNG(t *testing.T) {
	if !bytes.HasPrefix(desktopWallpaperPNG, []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}) {
		t.Fatal("embedded wallpaper asset is not a PNG")
	}
}

func TestDesktopWallpaperMatchesImageAsset(t *testing.T) {
	const imageAsset = "../../../images/runtime/desktop/vela-wallpaper.png"
	onDisk, err := os.ReadFile(imageAsset)
	if err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256(onDisk) != sha256.Sum256(desktopWallpaperPNG) {
		t.Fatalf("embedded wallpaper differs from %s; update both assets", imageAsset)
	}
}
