package instance

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

func TestWhatsAppBrowserCommandGuardAppliesToBothDebugBackends(t *testing.T) {
	adapter := &commandSandboxAdapterStub{
		processEvents: []psandbox.ProcessStreamEvent{{Ended: true, ExitCode: 0, Status: "SUCCESS"}},
		ptyEvents:     []psandbox.PtyExecStreamEvent{{Type: "finished", Status: "SUCCESS", ExitCode: 0}},
	}
	l := &logic{
		instanceDao: &commandInstanceDaoStub{entity: &modelinstance.Entity{
			InstanceId: "ins-1", SandboxId: "sbx-1", Status: modelinstance.InstanceStatusRunning,
		}},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")
	oldBrowserScan := "acli gateway qr-url --platform whatsapp --wait true --agent 'main'"
	if _, err := l.ExecDebugCommand(ctx, "ins-1", oldBrowserScan, "agentuser"); err != nil {
		t.Fatal(err)
	}
	if len(adapter.processCalls) != 1 || !strings.Contains(adapter.processCalls[0].Args[2], "whatsapp-qr.lock") {
		t.Fatalf("envd debug scanner bypassed guard: %+v", adapter.processCalls)
	}
	if err := l.StreamDebugCommandWithBackend(ctx, "ins-1", oldBrowserScan, "agentuser", "tat", func(transport.ExecDebugCommandStreamEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(adapter.ptyCalls) != 1 || !strings.Contains(adapter.ptyCalls[0].Command, "whatsapp-qr.lock") {
		t.Fatalf("TAT stream scanner bypassed guard: %+v", adapter.ptyCalls)
	}
}

func TestWhatsAppDebugGuardRecognizesOldAndNewBrowserCommands(t *testing.T) {
	for _, command := range []string{
		"acli gateway qr-url --platform whatsapp --wait true --agent 'main'",
		"acli gateway qr-url --platform whatsapp --wait true --agent 'sales-123'",
		"acli channel delete --platform 'whatsapp' --agent 'main'",
	} {
		if guarded := guardWhatsAppDebugCommand(command, "ins-1"); guarded == command || !strings.Contains(guarded, "whatsapp-qr.lock") {
			t.Fatalf("WhatsApp mutation bypassed instance-side request lock: %s", command)
		}
	}
	for _, command := range []string{"acli gateway qr-url --platform weixin --wait true --agent 'main'", "echo hello"} {
		if guarded := guardWhatsAppDebugCommand(command, "ins-1"); guarded != command {
			t.Fatalf("unrelated debug command modified: %s", command)
		}
	}
}

func TestWhatsAppRequestLockSurvivesLauncherExecAndGuardsBinding(t *testing.T) {
	home := t.TempDir()
	claim := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	command := exec.Command("python3", "-c", guardWhatsAppCommandScript, "printf R; exec sleep 1", "ins-1")
	command.Env = append(os.Environ(), "HERMES_HOME="+home)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	ready := make([]byte, 1)
	if _, err := io.ReadFull(stdout, ready); err != nil || string(ready) != "R" {
		t.Fatalf("scanner did not acquire lock: %q, %v", ready, err)
	}
	other := exec.Command("python3", "-c", guardWhatsAppCommandScript, "echo should-not-run", "ins-1")
	other.Env = append(os.Environ(), "HERMES_HOME="+home)
	if output, err := other.CombinedOutput(); err == nil || !strings.Contains(string(output), "already in progress") {
		t.Fatalf("overlapping QR request was not rejected: %q, %v", output, err)
	}
	if duplicate := runWhatsAppBindingForTest(t, home, "claim", "bot-1", ""); duplicate.OK {
		t.Fatalf("claim bypassed in-flight QR lock: %+v", duplicate)
	}
	if rollback := runWhatsAppBindingForTest(t, home, "release", "bot-1", claim.ReservationID); rollback.OK {
		t.Fatalf("QR rollback removed an in-flight binding: %+v", rollback)
	}
	path := filepath.Join(home, ".lightvela", "channel-bindings", "whatsapp.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var binding map[string]any
	if err := json.Unmarshal(contents, &binding); err != nil {
		t.Fatal(err)
	}
	binding["updated_at"] = "2000-01-01T00:00:00+00:00"
	contents, _ = json.Marshal(binding)
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	if current := runWhatsAppBindingForTest(t, home, "get", "", ""); current.ReservationID != claim.ReservationID {
		t.Fatalf("in-flight QR lease expired despite request lock: %+v", current)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	if rollback := runWhatsAppBindingForTest(t, home, "release", "bot-1", claim.ReservationID); !rollback.OK {
		t.Fatalf("completed scan lock did not release: %+v", rollback)
	}
	if next := runWhatsAppBindingForTest(t, home, "claim", "bot-2", ""); !next.OK || next.ReservationID == "" {
		t.Fatalf("expired scanner was not reclaimed after process ended: %+v", next)
	}
}

func TestWhatsAppGuardFailsClosedIfOriginalClaimWasReleased(t *testing.T) {
	home := t.TempDir()
	claim := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	path := filepath.Join(home, ".lightvela", "channel-bindings", "whatsapp.json")
	binding := map[string]any{"bot_id": "bot-2", "profile_id": "profile-2", "status": "reserved"}
	contents, _ := json.Marshal(binding)
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("python3", "-c", guardWhatsAppCommandScript,
		"acli gateway qr-url --platform whatsapp --wait true --agent 'profile-1'", "ins-1")
	command.Env = append(os.Environ(), "HERMES_HOME="+home)
	if output, err := command.CombinedOutput(); err == nil || !strings.Contains(string(output), "not owned") {
		t.Fatalf("stale QR request ran after lease changed (%s): %q, %v", claim.ReservationID, output, err)
	}
}

func TestWhatsAppLegacyDisconnectWaitsForInFlightRescan(t *testing.T) {
	home := t.TempDir()
	claim := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	credentials := writeWhatsAppCredentialsForTest(t, home)
	if result := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", claim.ReservationID); !result.OK {
		t.Fatalf("missing initial owner: %+v", result)
	}
	command := exec.Command("python3", "-c", guardWhatsAppCommandScript, "printf R; exec sleep 1", "ins-1")
	command.Env = append(os.Environ(), "HERMES_HOME="+home)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	ready := make([]byte, 1)
	if _, err := io.ReadFull(stdout, ready); err != nil || string(ready) != "R" {
		t.Fatalf("QR request did not acquire lock: %q, %v", ready, err)
	}
	if err := os.Remove(credentials); err != nil {
		t.Fatal(err)
	}
	if release := runWhatsAppBindingForTest(t, home, "release", "bot-1", ""); release.OK {
		t.Fatalf("old-browser release cleared owner during scan: %+v", release)
	}
	if current := runWhatsAppBindingForTest(t, home, "get", "", ""); current.BotID != "bot-1" || current.Status != "connected" {
		t.Fatalf("owner disappeared while credential file was temporarily absent: %+v", current)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	if release := runWhatsAppBindingForTest(t, home, "release", "bot-1", ""); !release.OK {
		t.Fatalf("completed disconnect could not clean absent credentials: %+v", release)
	}
	if next := runWhatsAppBindingForTest(t, home, "claim", "bot-2", ""); !next.OK {
		t.Fatalf("old-browser disconnect kept a stale owner: %+v", next)
	}
}
