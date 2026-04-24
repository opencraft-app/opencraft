package instance

import (
	"strings"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/model/channelloginsession"
)

func TestOpenclawWeixinProtocolCommandUsesStructuredEntryPoint(t *testing.T) {
	cmd := openclawWeixinProtocolCommand(
		"start",
		"--session-id",
		"wxlogin_123",
		"--timeout-seconds",
		"300",
	)

	if !strings.Contains(cmd, `PATH=/usr/bin:/bin`) {
		t.Fatalf("expected minimal PATH in protocol command, got %q", cmd)
	}
	if !strings.Contains(cmd, `runtime_user="${LIGHTCLAW_RUNTIME_USER:-lightclaw}"`) {
		t.Fatalf("expected runtime user bootstrap in protocol command, got %q", cmd)
	}
	if !strings.Contains(cmd, `openclaw-weixin-login-session`) || !strings.Contains(cmd, `'start'`) {
		t.Fatalf("expected protocol entrypoint, got %q", cmd)
	}
	if !strings.Contains(cmd, `'--session-id'`) || !strings.Contains(cmd, `'wxlogin_123'`) {
		t.Fatalf("expected session args in protocol command, got %q", cmd)
	}
}

func TestNormalizeWeixinProtocolStatus(t *testing.T) {
	cases := []struct {
		name   string
		status string
		ok     bool
		want   string
	}{
		{name: "starting", status: "starting", ok: true, want: channelloginsession.StatusStarting},
		{name: "waiting_qr", status: "waiting_qr", ok: true, want: channelloginsession.StatusWaitingQR},
		{name: "cancelled", status: "cancelled", ok: true, want: channelloginsession.StatusCancelled},
		{name: "expired", status: "expired", ok: false, want: channelloginsession.StatusExpired},
		{name: "failed", status: "failed", ok: false, want: channelloginsession.StatusFailed},
		{name: "empty not ok", status: "", ok: false, want: channelloginsession.StatusFailed},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeWeixinProtocolStatus(tc.status, tc.ok); got != tc.want {
				t.Fatalf("normalizeWeixinProtocolStatus(%q, %v) = %q, want %q", tc.status, tc.ok, got, tc.want)
			}
		})
	}
}

func TestExecWeixinProtocolCommandAcceptsStructuredPayloadWhenStreamMissesExitEvent(t *testing.T) {
	logic := &logic{
		sandboxAdapter: &commandSandboxAdapterStub{
			processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: `{"ok":true,"session_id":"wxs-1","status":"cancelled"}`},
			},
		},
	}

	resp, err := logic.execWeixinProtocolCommand(
		pctx.NewContext(nil),
		"sbx-1",
		"cancel",
		"wxs-1",
		20,
	)
	if err != nil {
		t.Fatalf("execWeixinProtocolCommand returned error: %v", err)
	}
	if resp.SessionID != "wxs-1" {
		t.Fatalf("unexpected session id: %+v", resp)
	}
	if resp.Status != channelloginsession.StatusCancelled {
		t.Fatalf("unexpected status: %+v", resp)
	}
}

func TestParseWeixinProtocolResultAcceptsStringPID(t *testing.T) {
	resp, err := parseWeixinProtocolResult(&psandbox.ExecCommandResult{
		Status:   "SUCCESS",
		ExitCode: 0,
		Output:   `{"ok":true,"session_id":"wxs-1","status":"cancelled","pid":"2503"}`,
	})
	if err != nil {
		t.Fatalf("parseWeixinProtocolResult returned error: %v", err)
	}
	if int64(resp.PID) != 2503 {
		t.Fatalf("unexpected pid: %+v", resp)
	}
}

func TestExecWeixinProtocolCommandFallsBackToStateFileForCancel(t *testing.T) {
	logic := &logic{
		sandboxAdapter: &commandSandboxAdapterStub{
			processBatches: [][]psandbox.ProcessStreamEvent{
				{},
				{{Stdout: `{"ok":true,"session_id":"wxs-1","status":"cancelled"}`, Ended: true, ExitCode: 0, Status: "SUCCESS"}},
			},
		},
	}

	resp, err := logic.execWeixinProtocolCommand(
		pctx.NewContext(nil),
		"sbx-1",
		"cancel",
		"wxs-1",
		20,
	)
	if err != nil {
		t.Fatalf("execWeixinProtocolCommand returned error: %v", err)
	}
	if resp.Status != channelloginsession.StatusCancelled {
		t.Fatalf("unexpected status: %+v", resp)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.processCalls) != 2 {
		t.Fatalf("expected primary command and fallback state read, got %d calls", len(adapter.processCalls))
	}
	if !strings.Contains(adapter.processCalls[1].Args[2], "/tmp/lightclaw-weixin-login/wxs-1/state.json") {
		t.Fatalf("expected fallback state read command, got %q", adapter.processCalls[1].Args[2])
	}
}

func TestExecWeixinProtocolCommandFallsBackToStateFileForStatus(t *testing.T) {
	logic := &logic{
		sandboxAdapter: &commandSandboxAdapterStub{
			processBatches: [][]psandbox.ProcessStreamEvent{
				{},
				{{Stdout: `{"ok":true,"session_id":"wxs-1","status":"waiting_qr"}`, Ended: true, ExitCode: 0, Status: "SUCCESS"}},
			},
		},
	}

	resp, err := logic.execWeixinProtocolCommand(
		pctx.NewContext(nil),
		"sbx-1",
		"status",
		"wxs-1",
		20,
	)
	if err != nil {
		t.Fatalf("execWeixinProtocolCommand returned error: %v", err)
	}
	if resp.Status != channelloginsession.StatusWaitingQR {
		t.Fatalf("unexpected status: %+v", resp)
	}
}

func TestExecWeixinProtocolCommandWaitsForTerminalCancelState(t *testing.T) {
	logic := &logic{
		sandboxAdapter: &commandSandboxAdapterStub{
			processBatches: [][]psandbox.ProcessStreamEvent{
				{},
				{{Stdout: `{"ok":true,"session_id":"wxs-1","status":"waiting_qr"}`, Ended: true, ExitCode: 0, Status: "SUCCESS"}},
				{{Stdout: `{"ok":true,"session_id":"wxs-1","status":"cancelled"}`, Ended: true, ExitCode: 0, Status: "SUCCESS"}},
			},
		},
	}

	resp, err := logic.execWeixinProtocolCommand(
		pctx.NewContext(nil),
		"sbx-1",
		"cancel",
		"wxs-1",
		20,
	)
	if err != nil {
		t.Fatalf("execWeixinProtocolCommand returned error: %v", err)
	}
	if resp.Status != channelloginsession.StatusCancelled {
		t.Fatalf("unexpected status: %+v", resp)
	}

	adapter := logic.sandboxAdapter.(*commandSandboxAdapterStub)
	if len(adapter.processCalls) != 3 {
		t.Fatalf("expected primary command plus two fallback reads, got %d calls", len(adapter.processCalls))
	}
}
