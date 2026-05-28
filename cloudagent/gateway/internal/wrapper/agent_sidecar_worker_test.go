package wrapper

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestSidecarStdoutParserHandlesChunkedLines(t *testing.T) {
	var parser sidecarStdoutParser
	if events := parser.Feed("WRAPPER_EVENT_JSON={\"type\":\"output_"); len(events) != 0 {
		t.Fatalf("unexpected events=%v", events)
	}
	events := parser.Feed("text_delta\",\"delta\":\"hello\"}\nnoise\n")
	if len(events) != 1 {
		t.Fatalf("events=%v", events)
	}
	if events[0].Type != "output_text_delta" || events[0].Delta != "hello" {
		t.Fatalf("event=%+v", events[0])
	}
}

func TestSidecarStdoutParserFlushesFinalLine(t *testing.T) {
	var parser sidecarStdoutParser
	if events := parser.Feed("WRAPPER_EVENT_JSON={\"type\":\"output_text_delta\",\"delta\":\"tail\"}"); len(events) != 0 {
		t.Fatalf("unexpected events=%v", events)
	}
	events := parser.Finish()
	if len(events) != 1 {
		t.Fatalf("events=%v", events)
	}
	if events[0].Delta != "tail" {
		t.Fatalf("event=%+v", events[0])
	}
}

func TestSidecarStdoutParserHandlesReasoningAndToolEvents(t *testing.T) {
	raw := strings.Join([]string{
		`WRAPPER_EVENT_JSON={"type":"reasoning_delta","delta":"thinking"}`,
		`WRAPPER_EVENT_JSON={"type":"tool_call","tool_call_id":"call_1","name":"terminal","status":"running","raw_input":{"command":"pwd"}}`,
		`WRAPPER_EVENT_JSON={"type":"tool_call_update","tool_call_id":"call_1","name":"terminal","status":"done","raw_output":{"stdout":"/workspace\n"},"content":"ok"}`,
		"",
	}, "\n")
	var parser sidecarStdoutParser
	events := parser.Feed(raw)
	if len(events) != 3 {
		t.Fatalf("events=%v", events)
	}
	if events[0].Type != "reasoning_delta" || events[0].Delta != "thinking" {
		t.Fatalf("reasoning event=%+v", events[0])
	}
	if events[1].Type != "tool_call" || events[1].ToolCallID != "call_1" || events[1].Name != "terminal" || events[1].Status != "running" {
		t.Fatalf("tool start event=%+v", events[1])
	}
	workerEvent, textDelta := workerEventFromSidecarEvent("job_1", 2, events[2])
	if textDelta {
		t.Fatal("tool update should not count as assistant text")
	}
	if workerEvent.Kind != "tool_call_update" || workerEvent.ToolCallID != "call_1" || workerEvent.ToolStatus != "done" {
		t.Fatalf("worker event=%+v", workerEvent)
	}
	if string(workerEvent.ToolRawOutput) != `{"stdout":"/workspace\n"}` || workerEvent.ToolContent != "ok" {
		t.Fatalf("worker detail=%+v raw=%s", workerEvent, string(workerEvent.ToolRawOutput))
	}
}

func TestSidecarStdoutParserHandlesRuntimeHostEvents(t *testing.T) {
	var parser sidecarStdoutParser
	events := parser.Feed(`WRAPPER_EVENT_JSON={"type":"runtime_host","event":"inner_shutdown_done","session_id":"session_1","sandbox_id":"inner_1","workspace_root":"/workspace/session_1"}` + "\n")
	if len(events) != 1 {
		t.Fatalf("events=%v", events)
	}
	if events[0].Type != "runtime_host" || events[0].Event != "inner_shutdown_done" || events[0].SandboxID != "inner_1" {
		t.Fatalf("runtime host event=%+v", events[0])
	}
	workerEvent, textDelta := workerEventFromSidecarEvent("job_1", 3, events[0])
	if textDelta || workerEvent.Kind != "" {
		t.Fatalf("runtime host events should stay timeline-only, worker=%+v textDelta=%t", workerEvent, textDelta)
	}
}

func TestMissingFinalDeltaReturnsUnstreamedSuffix(t *testing.T) {
	if got := missingFinalDelta("OK_DONE full sentence complete.", "OK_DONE f"); got != "ull sentence complete." {
		t.Fatalf("missingFinalDelta returned %q", got)
	}
}

func TestMissingFinalDeltaIgnoresMismatchedStream(t *testing.T) {
	if got := missingFinalDelta("final answer", "different"); got != "" {
		t.Fatalf("missingFinalDelta returned %q", got)
	}
}

func TestParseAgentRunEnvelopeReportsEmptyResultPresence(t *testing.T) {
	envelope, ok := parseAgentRunEnvelope(`WRAPPER_RESULT_JSON={"inner_sandbox_id":null,"output_text":""}`)
	if !ok {
		t.Fatal("expected wrapper result envelope")
	}
	if envelope.OutputText != "" || envelope.InnerSandboxID != "" {
		t.Fatalf("envelope=%+v", envelope)
	}
}

func TestParseAgentRunErrorEnvelope(t *testing.T) {
	envelope, ok := parseAgentRunErrorEnvelope(`noise
WRAPPER_ERROR_JSON={"code":"max_iterations_exceeded","message":"Max iterations exceeded: 12"}`)
	if !ok {
		t.Fatal("expected wrapper error envelope")
	}
	if envelope.Code != "max_iterations_exceeded" || envelope.Message != "Max iterations exceeded: 12" {
		t.Fatalf("envelope=%+v", envelope)
	}
}

func TestParseAgentRunErrorEnvelopeDefaultsCode(t *testing.T) {
	envelope, ok := parseAgentRunErrorEnvelope(`WRAPPER_ERROR_JSON={"message":"boom"}`)
	if !ok {
		t.Fatal("expected wrapper error envelope")
	}
	if envelope.Code != "agent_runtime_error" {
		t.Fatalf("code=%q", envelope.Code)
	}
}

func TestWorkerFailureFromAgentRunErrorMapsMaxIterationsToStop(t *testing.T) {
	err := workerFailureFromAgentRunError(agentRunErrorEnvelope{Code: "max_iterations_exceeded", Message: "Max iterations exceeded: 12"})
	if got := workerStopReason(err); got != "max_turn_requests" {
		t.Fatalf("stop reason=%q err=%v", got, err)
	}
}

func TestStripWrapperControlLinesPreventsResultLeak(t *testing.T) {
	raw := "noise\nWRAPPER_EVENT_JSON={\"type\":\"output_text_delta\",\"delta\":\"x\"}\nWRAPPER_RESULT_JSON={\"output_text\":\"\"}\nWRAPPER_ERROR_JSON={\"message\":\"boom\"}\n"
	if got := stripWrapperControlLines(raw); got != "noise" {
		t.Fatalf("stripWrapperControlLines returned %q", got)
	}
}

func TestCommandFailureDetailIncludesRedactedOutput(t *testing.T) {
	got := commandFailureDetail(errors.New("exit status 1"), CommandResult{
		Stderr: `daemon /ensure-inner failed: HTTP 500: {"error":"boom","envd_access_token":"secret"}`,
		Stdout: `{"api_key":"secret","ok":false}`,
	})
	if !strings.Contains(got, "exit status 1") || !strings.Contains(got, "stderr=") || !strings.Contains(got, "stdout=") {
		t.Fatalf("missing failure detail: %s", got)
	}
	if strings.Contains(got, "secret") {
		t.Fatalf("failure detail leaked secret: %s", got)
	}
	if !strings.Contains(got, "<redacted>") {
		t.Fatalf("failure detail did not redact: %s", got)
	}
}

func TestWispCommandFailureDetailIncludesDiagnosticTail(t *testing.T) {
	got := wispCommandFailureDetail(errors.New(`process exited with code 1: SMH_ACCESS_TOKEN=secret`), CommandResult{
		Stderr:   strings.Repeat("noise\n", 700) + "TIMELINE 2026-05-26T00:00:00Z wisp_start_start\nDAEMON_TRACE label=start ensure_active_image failed library_secret=secret\n",
		Stdout:   "starting\n",
		ExitCode: 1,
		Exited:   true,
		Status:   "exited",
	})
	for _, want := range []string{"exit=1", "exited=true", "stdout_bytes=", "stderr_bytes=", "stderr_tail=", "stdout_tail=", "ensure_active_image failed"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in detail: %s", want, got)
		}
	}
	if strings.Contains(got, "SMH_ACCESS_TOKEN=secret") || strings.Contains(got, "library_secret=secret") {
		t.Fatalf("wisp failure detail leaked secret: %s", got)
	}
	if !strings.Contains(got, "<redacted>") {
		t.Fatalf("wisp failure detail did not redact: %s", got)
	}
	if strings.HasPrefix(got, strings.Repeat("noise\n", 10)) {
		t.Fatalf("wisp failure detail did not tail large output: %s", got)
	}
}

func TestWispCommandFailureDetailKeepsPrimaryStopError(t *testing.T) {
	got := wispCommandFailureDetail(nil, CommandResult{
		Stderr: strings.Join([]string{
			`wispclient stop failed exit=1`,
			`wispclient stop stderr:`,
			`wispclient: http 500: {"error":"juicefs-smount meta-barrier /mnt/cloudagent-wisp: checkpoint cut failed: input/output error","access_token":"secret"}`,
			strings.Repeat("diagnostic tail\n", 400),
		}, "\n"),
		ExitCode: 1,
		Exited:   true,
	})
	if !strings.Contains(got, "stderr_head=") || !strings.Contains(got, "checkpoint cut failed") || !strings.Contains(got, "meta-barrier") {
		t.Fatalf("failure detail lost primary stop error: %s", got)
	}
	if strings.Contains(got, "secret") {
		t.Fatalf("failure detail leaked secret: %s", got)
	}
}

func TestWispOuterStopCommandCollectsHostDiagnosticsOnFailure(t *testing.T) {
	command := wispOuterStopCommand(ACPSessionRuntime{
		RemoteBinary:   "/tmp/cloudagent/hermes-sidecar",
		WispClientPath: "/tmp/cloudagent-wisp/install/bin/wispclient",
		WispInstallDir: "/tmp/cloudagent-wisp/install",
		WispName:       "agent-session-1",
	})
	for _, want := range []string{
		"writeback-cut-barrier",
		"wisp stop diagnostics: mount",
		"wisp stop diagnostics: df",
		"wisp stop diagnostics: process",
		"tail_safe_log",
		"tail_juicefs_log",
		"juicefs-assertmount.log",
		"redact_line",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("stop command missing %q: %s", want, command)
		}
	}
	if !strings.Contains(command, "cloudagent-wisp") || !strings.Contains(command, "juicefs") || !strings.Contains(command, "smount") {
		t.Fatalf("stop command should collect Wisp/JuiceFS diagnostics: %s", command)
	}
}

func TestWispWorkspaceStopCommandRunsBarrierBeforeStop(t *testing.T) {
	command := wispWorkspaceStopCommand(ACPSessionRuntime{
		WispClientPath: "/tmp/cloudagent-workspace-wisp/install/bin/wispclient",
		WispInstallDir: "/tmp/cloudagent-workspace-wisp/install",
		WispName:       "workspace-12345678",
	})
	barrierIndex := strings.Index(command, "writeback-cut-barrier")
	stopIndex := strings.Index(command, "stop \"$name\"")
	if barrierIndex < 0 || stopIndex < 0 {
		t.Fatalf("workspace stop command missing barrier or stop: %s", command)
	}
	if barrierIndex > stopIndex {
		t.Fatalf("workspace stop command must run writeback barrier before stop: %s", command)
	}
	if !strings.Contains(command, "CLOUDAGENT_WISP_STOPPED") {
		t.Fatalf("workspace stop command missing completion marker: %s", command)
	}
}

func TestStaleRuntimeCleanupAuthFailureIsNonBlockingForRecreate(t *testing.T) {
	err := errors.New(`stop wisp outer runtime agent-session_1: wisp stop failed runtime_id=rt_1 outer_sandbox_id=outer_1 wisp_name=agent-session_1: exit=0 exited=false stdout_bytes=0 stderr_bytes=0 error="ags http 401 op=run_command sandbox_id=outer_1 domain=ap-shanghai.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]"`)
	if !isNonBlockingStaleRuntimeCleanupError(err) {
		t.Fatalf("expected stale auth cleanup failure to be non-blocking: %v", err)
	}
}

func TestStaleRuntimeCleanupCheckpointFailureStillBlocksRecreate(t *testing.T) {
	err := errors.New(`stop wisp outer runtime agent-session_1: wispclient: http 500: {"error":"juicefs-smount meta-barrier /mnt/cloudagent-wisp: checkpoint cut failed: input/output error"}`)
	if isNonBlockingStaleRuntimeCleanupError(err) {
		t.Fatalf("checkpoint failure must not be ignored: %v", err)
	}
}

func TestWispOuterPrepareScriptPropagatesLitestreamTrace(t *testing.T) {
	script := wispOuterPrepareScript()
	for _, want := range []string{
		`export JFS_LITESTREAM_TRACE="${JFS_LITESTREAM_TRACE:-}"`,
		`JFS_LITESTREAM_TRACE="$JFS_LITESTREAM_TRACE"`,
		"litestream checkpoint",
		"checkpoint_manifest_durable",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("prepare script missing %q: %s", want, script)
		}
	}
}

func TestRuntimeClockEnvUsesShanghaiDate(t *testing.T) {
	env := runtimeClockEnv(time.Unix(1779062400, 0))
	if env["HERMES_CURRENT_UNIX_SECONDS"] != "1779062400" {
		t.Fatalf("unix seconds=%q", env["HERMES_CURRENT_UNIX_SECONDS"])
	}
	if !strings.Contains(env["HERMES_CURRENT_TIME_NOTE"], "Asia/Shanghai") ||
		!strings.Contains(env["HERMES_CURRENT_TIME_NOTE"], "2026-05-18") {
		t.Fatalf("time note=%q", env["HERMES_CURRENT_TIME_NOTE"])
	}
}

func TestAddWebSearchEnvPassesTencentWSAConfig(t *testing.T) {
	t.Setenv("CLOUDAGENT_WEB_SEARCH_PROVIDER", "tencent_wsa")
	t.Setenv("TENCENTCLOUD_WSA_ENDPOINT", "https://api.wsa.cloud.tencent.com/SearchPro")
	t.Setenv("TENCENTCLOUD_WSA_APIKEY", "test-wsa-key")
	env := map[string]string{}

	addWebSearchEnv(env)

	if env["CLOUDAGENT_WEB_SEARCH_PROVIDER"] != "tencent_wsa" {
		t.Fatalf("provider=%q", env["CLOUDAGENT_WEB_SEARCH_PROVIDER"])
	}
	if env["TENCENTCLOUD_WSA_ENDPOINT"] != "https://api.wsa.cloud.tencent.com/SearchPro" {
		t.Fatalf("endpoint=%q", env["TENCENTCLOUD_WSA_ENDPOINT"])
	}
	if env["TENCENTCLOUD_WSA_APIKEY"] != "test-wsa-key" {
		t.Fatalf("api key not passed")
	}
}
