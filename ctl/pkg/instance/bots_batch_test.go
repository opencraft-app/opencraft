package instance

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"

	"go.uber.org/zap"
)

const testHermesBotCatalog = `{"kind":"lightvela.instance-bots.v1","items":[{"native_id":"default","is_default":true},{"native_id":"profile-sales","display_name":"Sales","gateway_running":false}],"weixin_owners":{"default":{"ok":true,"channel":"weixin","bot_id":"ins-1","profile_id":"default","status":"connected"},"profile-sales":{"ok":true,"channel":"weixin","bot_id":"profile-sales","profile_id":"profile-sales","status":"connected"}},"whatsapp_owner":{"ok":true,"channel":"whatsapp","bot_id":"profile-sales","profile_id":"profile-sales","status":"reserved"}}`

func TestListInstanceBotsUsesOneRegionalTATExecution(t *testing.T) {
	adapter := &commandSandboxAdapterStub{ptyEvents: []psandbox.PtyExecStreamEvent{
		{Type: "started", ExecutionID: "pty:bots"},
		{Type: "output", Chunk: "Hermes progress\n" + testHermesBotCatalog + "\n"},
		{Type: "finished", Status: "SUCCESS", ExitCode: 0},
	}}
	l := &logic{
		instanceDao: &commandInstanceDaoStub{entity: &modelinstance.Entity{
			InstanceId: "ins-1", SandboxId: "sbx-1", DisplayName: "Root Bot", Status: modelinstance.InstanceStatusRunning,
		}},
		sandboxAdapter: adapter, logger: zap.NewNop(),
	}
	response, err := l.ListInstanceBots(pctx.NewContext(nil).WithUserID("user-1").WithRegion("ap-shanghai"), "ins-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(adapter.ptyCalls) != 1 || len(adapter.processCalls) != 0 || len(adapter.calls) != 0 {
		t.Fatalf("expected one TAT execution and no envd/fallback: pty=%d process=%d commands=%d", len(adapter.ptyCalls), len(adapter.processCalls), len(adapter.calls))
	}
	request := adapter.ptyCalls[0]
	// Raw Hermes commands already use the existing 120-second debug budget.
	if request.Username != "agentuser" || request.TimeoutSeconds != 120 || !strings.Contains(request.Command, "lightvela.instance-bots.v1") {
		t.Fatal("batch must retain the original execution user/deadline and use the batch script")
	}
	if len([]byte(request.Command)) >= 64*1024 {
		t.Fatalf("fully wrapped PTY command exceeds TAT limit: %d bytes", len([]byte(request.Command)))
	}
	if len(response.Items) != 2 || response.Items[0].BotID != "ins-1" || response.Items[0].ProfileID != "main" || response.Items[0].Name != "Root Bot" {
		t.Fatalf("default Profile compatibility changed: %+v", response.Items)
	}
	if response.Items[0].GatewayRunning != nil || response.Items[1].GatewayRunning == nil || *response.Items[1].GatewayRunning {
		t.Fatal("unknown and stopped gateway state must remain distinct")
	}
	for _, bot := range response.Items {
		if bot.WeixinOwner == nil || bot.WeixinOwner.BotID != bot.BotID || bot.WeixinOwner.ProfileID != bot.ProfileID || bot.WeixinOwner.BotName != bot.Name ||
			bot.WhatsAppOwner == nil || bot.WhatsAppOwner.BotName != "Sales" || bot.WhatsAppOwner.ProfileID != "profile-sales" {
			t.Fatalf("channel owner/name projection changed: %+v", bot)
		}
	}
}

func TestParseHermesInstanceBotsRejectsIncompletePayloads(t *testing.T) {
	for name, output := range map[string]string{
		"no-json":                          "loading profiles",
		"legacy-profile-prefix":            `{"items":[]}`,
		"missing-owners":                   `{"kind":"lightvela.instance-bots.v1","items":[]}`,
		"null-owner":                       `{"kind":"lightvela.instance-bots.v1","items":[],"weixin_owners":null,"whatsapp_owner":{"ok":true}}`,
		"null-items":                       `{"kind":"lightvela.instance-bots.v1","items":null,"weixin_owners":{},"whatsapp_owner":{"ok":true}}`,
		"missing-profile-weixin":           strings.Replace(testHermesBotCatalog, `,"profile-sales":{"ok":true,"channel":"weixin","bot_id":"profile-sales","profile_id":"profile-sales","status":"connected"}`, "", 1),
		"wrong-version":                    strings.Replace(testHermesBotCatalog, ".v1", ".v2", 1),
		"wrong-items-type":                 strings.Replace(testHermesBotCatalog, `"items":[`, `"items":"broken", "discarded":[`, 1),
		"progress-before-invalid-envelope": "{\"progress\":true}\n" + strings.Replace(testHermesBotCatalog, `"items":[`, `"items":"broken", "discarded":[`, 1),
		"truncated":                        testHermesBotCatalog[:len(testHermesBotCatalog)-10],
	} {
		t.Run(name, func(t *testing.T) {
			response, err := parseHermesInstanceBots(output, "ins-1", "Root")
			if response != nil || !errors.Is(err, errcode.ErrInstanceBotProfileFailed) {
				t.Fatalf("invalid response must fail closed: response=%+v error=%v", response, err)
			}
		})
	}
}

func TestParseHermesInstanceBotsPreservesEmptyCatalogAndAbsentBindings(t *testing.T) {
	response, err := parseHermesInstanceBots(`{"kind":"lightvela.instance-bots.v1","items":[],"weixin_owners":{},"whatsapp_owner":{"ok":true}}`, "ins-1", "Root")
	if err != nil || response.Items == nil || len(response.Items) != 0 {
		t.Fatalf("official empty catalog must remain a successful empty array: %+v %v", response, err)
	}
	response, err = parseHermesInstanceBots(`{"kind":"lightvela.instance-bots.v1","items":[{"native_id":"default","is_default":true}],"weixin_owners":{"default":{"ok":true}},"whatsapp_owner":{"ok":true}}`, "ins-1", "Root")
	if err != nil || response.Items[0].WeixinOwner != nil || response.Items[0].WhatsAppOwner != nil {
		t.Fatalf("unbound channels must remain nil: %+v %v", response, err)
	}
}

func TestListInstanceBotsFailsWithoutFallbackOrPartialSuccess(t *testing.T) {
	for _, state := range []string{"nonzero", "timeout", "transport", "missing-user", "stopped"} {
		t.Run(state, func(t *testing.T) {
			adapter := &commandSandboxAdapterStub{ptyEvents: []psandbox.PtyExecStreamEvent{
				{Type: "output", Chunk: testHermesBotCatalog + "\n"},
				{Type: "finished", Status: "SUCCESS", ExitCode: 0},
			}}
			entity := &modelinstance.Entity{InstanceId: "ins-1", SandboxId: "sbx-1", Status: modelinstance.InstanceStatusRunning}
			ctx := pctx.NewContext(nil).WithUserID("user-1")
			switch state {
			case "nonzero":
				adapter.ptyEvents[1].Status, adapter.ptyEvents[1].ExitCode = "FAILED", 1
			case "timeout":
				adapter.ptyEvents = []psandbox.PtyExecStreamEvent{{Type: "error", Code: "TIMEOUT"}}
			case "transport":
				adapter.ptyErr = errors.New("connection lost")
			case "missing-user":
				ctx = pctx.NewContext(nil)
			case "stopped":
				entity.Status = modelinstance.InstanceStatusFailed
			}
			l := &logic{instanceDao: &commandInstanceDaoStub{entity: entity}, sandboxAdapter: adapter, logger: zap.NewNop()}
			response, err := l.ListInstanceBots(ctx, "ins-1")
			if response != nil || !errors.Is(err, errcode.ErrInstanceBotProfileFailed) {
				t.Fatalf("failed execution must not publish a catalog: %+v %v", response, err)
			}
			expectedCalls := 1
			if state == "missing-user" || state == "stopped" {
				expectedCalls = 0
			}
			if len(adapter.ptyCalls) != expectedCalls || len(adapter.processCalls) != 0 {
				t.Fatalf("failure may not retry three legacy calls or use envd: pty=%d envd=%d", len(adapter.ptyCalls), len(adapter.processCalls))
			}
		})
	}
}

func TestListInstanceBotsHonorsInstanceStorageFailure(t *testing.T) {
	adapter := &commandSandboxAdapterStub{}
	l := &logic{instanceDao: &commandInstanceDaoStub{err: errcode.ErrInstanceNotFound}, sandboxAdapter: adapter, logger: zap.NewNop()}
	response, err := l.ListInstanceBots(pctx.NewContext(nil).WithUserID("not-the-owner"), "ins-1")
	if response != nil || !errors.Is(err, errcode.ErrInstanceNotFound) || len(adapter.ptyCalls) != 0 {
		t.Fatal("batch may not bypass instance storage/ownership failures")
	}
}

// The external official Profile API is the only substitute. Python, the complete
// production batch script, actual flock/files and channel reconciliation are real.
func hermesBatchEnvironment(t *testing.T, home string) []string {
	t.Helper()
	modules := t.TempDir()
	write := func(name, contents string) {
		t.Helper()
		path := filepath.Join(modules, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("hermes_cli/__init__.py", "")
	write("hermes_cli/web_server.py", "app = object()\n")
	write("httpx.py", `import json
import os
class ASGITransport:
    def __init__(self, app): pass
class Response:
    def raise_for_status(self):
        if os.environ.get("TEST_PROFILE_ERROR"): raise RuntimeError("synthetic API failure")
    def json(self):
        return {"profiles": json.loads(os.environ.get("TEST_PROFILES", '[{"name":"default","is_default":true},{"name":"profile-sales","display_name":"Sales","gateway_running":false}]'))}
class AsyncClient:
    def __init__(self, transport, base_url, timeout): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def get(self, path, headers):
        assert path == "/api/profiles"
        assert headers["X-Hermes-Session-Token"] == os.environ["HERMES_DASHBOARD_SESSION_TOKEN"]
        if os.environ.get("TEST_PROFILE_MUTATES_HOME"):
            os.environ["HERMES_HOME"] = os.environ["TEST_PROFILE_MUTATES_HOME"]
            os.environ["ACLI_WHATSAPP_AUTH_DIR"] = os.environ["TEST_PROFILE_MUTATES_HOME"] + "/session"
        return Response()
`)
	return append(os.Environ(), "PYTHONPATH="+modules, "HERMES_HOME="+home)
}

func runHermesBatchPython(t *testing.T, env []string) hermesInstanceBotsPayload {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "python3", "-c", listHermesInstanceBotsScript, "ins-1")
	command.Env = env
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("batch script failed: %v %s", err, output)
	}
	var payload hermesInstanceBotsPayload
	if err := json.Unmarshal(output, &payload); err != nil {
		t.Fatalf("invalid batch output: %v", err)
	}
	return payload
}

func TestHermesBatchScriptMatchesSeparateBindingReads(t *testing.T) {
	for _, scenario := range []string{"unbound", "connected", "legacy-named-weixin", "two-weixin", "legacy", "expired-no-credentials", "expired-with-credentials"} {
		t.Run(scenario, func(t *testing.T) {
			home := t.TempDir()
			root := filepath.Join(home, ".lightvela", "channel-bindings")
			if err := os.MkdirAll(root, 0o700); err != nil {
				t.Fatal(err)
			}
			write := func(path string, value any) {
				t.Helper()
				data, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "connected" {
				write(filepath.Join(root, "weixin.json"), map[string]any{"ok": true, "channel": "weixin", "bot_id": "ins-1", "profile_id": "default", "status": "connected"})
				write(filepath.Join(root, "whatsapp.json"), map[string]any{"ok": true, "channel": "whatsapp", "bot_id": "profile-sales", "profile_id": "profile-sales", "status": "connected"})
			}
			if scenario == "legacy-named-weixin" {
				write(filepath.Join(root, "weixin.json"), map[string]any{"ok": true, "channel": "weixin", "bot_id": "profile-sales", "profile_id": "profile-sales", "status": "connected"})
			}
			if scenario == "two-weixin" {
				write(filepath.Join(root, "weixin.json"), map[string]any{"bindings": map[string]any{
					"default":       map[string]any{"ok": true, "channel": "weixin", "bot_id": "ins-1", "profile_id": "default", "status": "connected"},
					"profile-sales": map[string]any{"ok": true, "channel": "weixin", "bot_id": "profile-sales", "profile_id": "profile-sales", "status": "connected"},
				}})
			}
			if scenario == "legacy" {
				write(filepath.Join(home, "whatsapp", "session", "creds.json"), map[string]any{})
			}
			if strings.HasPrefix(scenario, "expired-") {
				write(filepath.Join(root, "whatsapp.json"), map[string]any{"ok": true, "channel": "whatsapp", "bot_id": "profile-sales", "profile_id": "profile-sales", "status": "reserved", "reservation_id": "expired-test-reservation", "updated_at": time.Now().Add(-15 * time.Minute).UTC().Format(time.RFC3339Nano)})
			}
			if scenario == "expired-with-credentials" {
				write(filepath.Join(home, "profiles", "profile-sales", "whatsapp", "session", "creds.json"), map[string]any{})
			}
			payload := runHermesBatchPython(t, hermesBatchEnvironment(t, home))
			if payload.Kind != "lightvela.instance-bots.v1" || payload.Items == nil || len(*payload.Items) != 2 {
				t.Fatalf("batch must read the official profile catalog: %+v", payload)
			}
			for channel, got := range map[string]*channelBindingPayload{"weixin": payload.WeixinOwners["default"], "whatsapp": payload.WhatsAppOwner} {
				command := exec.Command("python3", "-c", manageChannelBindingScript, "get", channel, "", "default", "ins-1")
				command.Env = append(os.Environ(), "HERMES_HOME="+home)
				output, err := command.Output()
				if err != nil {
					t.Fatal(err)
				}
				var separate channelBindingPayload
				if err := json.Unmarshal(output, &separate); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(got, &separate) {
					t.Fatalf("%s batch owner differs from standalone: %+v vs %+v", channel, got, separate)
				}
			}
			if scenario == "two-weixin" && payload.WeixinOwners["profile-sales"].BotID != "profile-sales" {
				t.Fatal("named Profile Weixin binding was not listed")
			}
			if scenario == "legacy-named-weixin" && (payload.WeixinOwners["default"].BotID != "" || payload.WeixinOwners["profile-sales"].BotID != "profile-sales") {
				t.Fatal("legacy named Weixin owner must remain on its Profile")
			}
			switch scenario {
			case "legacy":
				if payload.WhatsAppOwner.BotID != "ins-1" || payload.WhatsAppOwner.Status != "connected" {
					t.Fatal("legacy session not adopted")
				}
			case "expired-no-credentials":
				if payload.WhatsAppOwner.BotID != "" {
					t.Fatal("expired reservation not released")
				}
			case "expired-with-credentials":
				if payload.WhatsAppOwner.BotID != "profile-sales" || payload.WhatsAppOwner.Status != "connected" || payload.WhatsAppOwner.ReservationID != "" {
					t.Fatal("completed scan ownership not preserved")
				}
			}
		})
	}
}

func TestHermesBatchScriptStopsBeforeLaterPhasesOnFailure(t *testing.T) {
	for _, phase := range []string{"profiles", "weixin", "whatsapp"} {
		t.Run(phase, func(t *testing.T) {
			home := t.TempDir()
			env := hermesBatchEnvironment(t, home)
			root := filepath.Join(home, ".lightvela", "channel-bindings")
			if phase == "profiles" {
				env = append(env, "TEST_PROFILE_ERROR=1")
			} else if err := os.MkdirAll(filepath.Join(root, phase+".lock"), 0o700); err != nil {
				t.Fatal(err)
			}
			command := exec.Command("python3", "-c", listHermesInstanceBotsScript, "ins-1")
			command.Env = env
			output, err := command.CombinedOutput()
			if err == nil || strings.Contains(string(output), `"kind": "lightvela.instance-bots.v1"`) {
				t.Fatal("failed phase must not publish partial success")
			}
			if _, err := os.Stat(filepath.Join(root, "whatsapp-legacy-checked-v2")); !os.IsNotExist(err) {
				t.Fatal("failure must not run later WhatsApp reconciliation")
			}
			if phase == "profiles" {
				if _, err := os.Stat(root); !os.IsNotExist(err) {
					t.Fatal("Profile API failure must not touch channel files")
				}
			}
		})
	}
}

func TestHermesBatchScriptIsolatesProfileEnvironmentFromBindingReads(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".lightvela", "channel-bindings")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "weixin.json"), []byte(`{"ok":true,"channel":"weixin","bot_id":"ins-1","profile_id":"default","status":"connected"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	alternate := t.TempDir()
	env := append(hermesBatchEnvironment(t, home), "TEST_PROFILE_MUTATES_HOME="+alternate)
	payload := runHermesBatchPython(t, env)
	if payload.WeixinOwners["default"].BotID != "ins-1" {
		t.Fatal("Profile API process environment must not redirect instance channel reads")
	}
	if _, err := os.Stat(filepath.Join(alternate, ".lightvela")); !os.IsNotExist(err) {
		t.Fatal("binding reads must not create state in Profile-mutated HOME")
	}
}

func holdHermesFileLockForTest(t *testing.T, path string) func() {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	holder := exec.CommandContext(ctx, "python3", "-c", `import fcntl, sys
with open(sys.argv[1], "a") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    print("locked", flush=True)
    sys.stdin.read(1)
`, path)
	input, err := holder.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := holder.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	release := func() { once.Do(func() { _ = input.Close(); _ = holder.Wait(); cancel() }) }
	t.Cleanup(release)
	if line, err := bufio.NewReader(output).ReadString('\n'); err != nil || strings.TrimSpace(line) != "locked" {
		t.Fatalf("lock holder did not start: %v", err)
	}
	return release
}

func TestHermesBatchScriptRespectsChannelLock(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".lightvela", "channel-bindings")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	release := holdHermesFileLockForTest(t, filepath.Join(root, "weixin.lock"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "python3", "-c", listHermesInstanceBotsScript, "ins-1")
	command.Env = hermesBatchEnvironment(t, home)
	done := make(chan error, 1)
	go func() { _, err := command.Output(); done <- err }()
	select {
	case err := <-done:
		t.Fatalf("batch bypassed the held channel lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	release()
	if err := <-done; err != nil {
		t.Fatalf("batch failed after lock release: %v", err)
	}
}

func TestHermesBatchScriptPreservesExpiredReservationWhileScanIsBusy(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".lightvela", "channel-bindings")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	binding, err := json.Marshal(map[string]any{"ok": true, "channel": "whatsapp", "bot_id": "profile-1", "profile_id": "profile-1", "status": "reserved", "reservation_id": "live-scan-reservation", "updated_at": time.Now().Add(-15 * time.Minute).UTC().Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "whatsapp.json"), binding, 0o600); err != nil {
		t.Fatal(err)
	}
	writeWhatsAppCredentialsForTest(t, home)
	release := holdHermesFileLockForTest(t, filepath.Join(root, "whatsapp-qr.lock"))
	env := hermesBatchEnvironment(t, home)
	busy := runHermesBatchPython(t, env)
	if busy.WhatsAppOwner.BotID != "profile-1" || busy.WhatsAppOwner.Status != "reserved" || busy.WhatsAppOwner.ReservationID != "live-scan-reservation" {
		t.Fatal("batch must not reconcile away a live scan's reservation")
	}
	release()
	settled := runHermesBatchPython(t, env)
	if settled.WhatsAppOwner.BotID != "profile-1" || settled.WhatsAppOwner.Status != "connected" || settled.WhatsAppOwner.ReservationID != "" {
		t.Fatal("batch must preserve completed credentials and settle ownership after scan ends")
	}
}
