package instance

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"go.uber.org/zap"
)

func TestDesktopBrowserEnsureCommandUsesSharedOfflineScript(t *testing.T) {
	data, err := os.ReadFile("scripts/ensure-desktop-browser.sh")
	if err != nil {
		t.Fatal(err)
	}
	command := renderDesktopBrowserEnsureCommand()
	if !strings.Contains(command, base64.StdEncoding.EncodeToString(data)) || !strings.Contains(command, "sudo -n bash -s -- --apply agentuser") {
		t.Fatal("command must embed shared script and explicit root apply")
	}
	for _, forbidden := range []string{"--no-sandbox", "apt-get", "dnf install", "curl ", "9222", "systemctl restart", "/opt/ms-playwright/**"} {
		if strings.Contains(desktopBrowserEnsureScript, forbidden) {
			t.Fatalf("unsafe capability: %s", forbidden)
		}
	}
	if out, err := exec.Command("bash", "-n", "scripts/ensure-desktop-browser.sh").CombinedOutput(); err != nil {
		t.Fatalf("shell syntax: %v %s", err, out)
	}
}

func TestDesktopBrowserEnsureStatus(t *testing.T) {
	for _, tc := range []struct{ output, want string }{
		{"noise\nLV_BROWSER_JSON={\"status\":\"CONFIGURED\"}\n", "CONFIGURED"},
		{"LV_BROWSER_JSON=broken", "UNKNOWN"},
		{"no sentinel", "UNKNOWN"},
	} {
		if got := desktopBrowserEnsureStatus(tc.output); got != tc.want {
			t.Fatalf("got %s want %s", got, tc.want)
		}
	}
}

func TestDesktopBrowserEnsureOnCreateIsBestEffort(t *testing.T) {
	for _, failure := range []bool{false, true} {
		adapter := &commandSandboxAdapterStub{ptyEvents: []psandbox.PtyExecStreamEvent{
			{Type: "output", Chunk: "LV_BROWSER_JSON={\"status\":\"CONFIGURED\"}\n"},
			{Type: "finished", Status: "SUCCESS", ExitCode: 0},
		}}
		if failure {
			adapter.ptyErr = errors.New("delivery failed")
		}
		l := &logic{sandboxAdapter: adapter, logger: zap.NewNop()}
		ctx := pctx.NewContext(context.Background())
		l.ensureDesktopBrowserOnCreate(ctx, "sbx-browser-test")
		if len(adapter.ptyCalls) != 1 {
			t.Fatal("expected one bounded delivery")
		}
		l.ensureDesktopBrowserOnCreate(ctx, "")
		if len(adapter.ptyCalls) != 1 {
			t.Fatal("empty target must not dispatch")
		}
	}
}

func TestDesktopBrowserEnsurePreservesExistingConsumers(t *testing.T) {
	for _, invariant := range []string{
		"EXISTING_SYSTEM_BROWSER_PRESERVED", "CUSTOM_BROWSER_PRESERVED", "CUSTOM_MIME_PRESERVED",
		"MANAGED_CONFIG_DRIFT", "HARDLINK_UNSUPPORTED", "POLICY_NOT_LOADED",
		"os.link(b,LIB/'chrome')", "profile {NAME} {LIB}/chrome",
		"'runuser','-u',USER", "before_user=before", "ROLLBACK_CONFLICT",
	} {
		if !strings.Contains(desktopBrowserEnsureScript, invariant) {
			t.Fatalf("missing invariant: %s", invariant)
		}
	}
	if strings.Contains(desktopBrowserEnsureScript, "False and") {
		t.Fatal("test-only preference override must never ship")
	}
}
