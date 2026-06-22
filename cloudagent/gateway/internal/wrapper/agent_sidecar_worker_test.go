package wrapper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

func TestSidecarStdoutParserHandlesPrefixedWrapperEvents(t *testing.T) {
	var parser sidecarStdoutParser
	raw := `timeline source=hermes_sidecar t=0.000s event=process_start mode="client" addr="http://127.0.0.1:43420/" WRAPPER_EVENT_JSON={"type":"reasoning_delta","delta":"\nThe"}` + "\n" +
		`timeline source=hermes_sidecar t=0.001s event=stream WRAPPER_EVENT_JSON={"type":"output_text_delta","delta":"answer"}` + "\n"
	events := parser.Feed(raw)
	if len(events) != 2 {
		t.Fatalf("events=%v", events)
	}
	if events[0].Type != "reasoning_delta" || events[0].Delta != "\nThe" {
		t.Fatalf("reasoning event=%+v", events[0])
	}
	if events[1].Type != "output_text_delta" || events[1].Delta != "answer" {
		t.Fatalf("output event=%+v", events[1])
	}

	reasoning, reasoningTextDelta := workerEventFromSidecarEvent("job_1", 1, events[0])
	if reasoning.Kind != "reasoning_delta" || reasoningTextDelta {
		t.Fatalf("reasoning worker event=%+v textDelta=%t", reasoning, reasoningTextDelta)
	}
	message, messageTextDelta := workerEventFromSidecarEvent("job_1", 2, events[1])
	if message.Kind != "output_text_delta" || !messageTextDelta {
		t.Fatalf("message worker event=%+v textDelta=%t", message, messageTextDelta)
	}
}

func TestWorkerEventFromSidecarEventDropsMismatchedInputID(t *testing.T) {
	event := sidecarStdoutEvent{
		Type:    "output_text_delta",
		InputID: "job_previous",
		Delta:   "stale answer",
	}
	workerEvent, textDelta := workerEventFromSidecarEvent("job_current", 1, event)
	if textDelta || workerEvent.Kind != "" {
		t.Fatalf("stale input event should be dropped, worker=%+v textDelta=%t", workerEvent, textDelta)
	}
}

func TestWorkerEventFromSidecarEventAcceptsMatchingInputID(t *testing.T) {
	event := sidecarStdoutEvent{
		Type:    "output_text_delta",
		InputID: "job_current",
		Delta:   "current answer",
	}
	workerEvent, textDelta := workerEventFromSidecarEvent("job_current", 1, event)
	if !textDelta || workerEvent.Kind != "output_text_delta" || workerEvent.Delta != "current answer" {
		t.Fatalf("current input event not accepted, worker=%+v textDelta=%t", workerEvent, textDelta)
	}
}

func TestSidecarToolEventFieldsSummarizesAndRedactsPayloads(t *testing.T) {
	fields := sidecarToolEventFields(sidecarStdoutEvent{
		Type:       "tool_call_update",
		ToolCallID: "call_1",
		Name:       "terminal",
		Status:     "completed",
		RawInput:   json.RawMessage(`{"command":"echo ok","api_key":"secret"}`),
		RawOutput:  json.RawMessage(`{"stdout":"ok\n","access_token":"secret"}`),
		Content:    "ok\n",
	})
	for _, want := range []string{
		`tool_call_id="call_1"`,
		`tool_name="terminal"`,
		`tool_status="completed"`,
		`raw_input_bytes=40`,
		`raw_output_bytes=41`,
		`content_bytes=3`,
		`\u003credacted\u003e`,
	} {
		if !strings.Contains(fields, want) {
			t.Fatalf("tool event fields missing %q: %s", want, fields)
		}
	}
	if strings.Contains(fields, "secret") {
		t.Fatalf("tool event fields leaked secret: %s", fields)
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

func TestParseAgentRunEnvelopeHandlesPrefixedControlLine(t *testing.T) {
	envelope, ok := parseAgentRunEnvelope(`timeline source=hermes_sidecar t=0.000s event=result WRAPPER_RESULT_JSON={"output_text":"clean","inner_sandbox_id":"inner_1"}`)
	if !ok {
		t.Fatal("expected prefixed wrapper result envelope")
	}
	if envelope.OutputText != "clean" || envelope.InnerSandboxID != "inner_1" {
		t.Fatalf("envelope=%+v", envelope)
	}
}

func TestParseAgentRunEnvelopeIgnoresMismatchedInputID(t *testing.T) {
	_, ok := parseAgentRunEnvelope(`WRAPPER_RESULT_JSON={"input_id":"job_previous","output_text":"stale"}`, "job_current")
	if ok {
		t.Fatal("stale result envelope should be ignored")
	}
	envelope, ok := parseAgentRunEnvelope(`WRAPPER_RESULT_JSON={"input_id":"job_current","output_text":"fresh"}`, "job_current")
	if !ok || envelope.OutputText != "fresh" {
		t.Fatalf("matching result envelope not parsed, ok=%t envelope=%+v", ok, envelope)
	}
}

func TestParseAgentOutputDoesNotFallbackToMismatchedInputID(t *testing.T) {
	raw := `WRAPPER_RESULT_JSON={"input_id":"job_previous","output_text":"stale"}`
	if got := cleanAgentVisibleOutput(parseAgentOutput(raw, "job_current")); got != "" {
		t.Fatalf("stale fallback output leaked: %q", got)
	}
}

func TestParseAgentRunErrorEnvelope(t *testing.T) {
	envelope, ok := parseAgentRunErrorEnvelope(`noise
WRAPPER_ERROR_JSON={"code":"max_iterations_exceeded","message":"Max iterations exceeded: 256"}`)
	if !ok {
		t.Fatal("expected wrapper error envelope")
	}
	if envelope.Code != "max_iterations_exceeded" || envelope.Message != "Max iterations exceeded: 256" {
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

func TestParseAgentRunErrorEnvelopeIgnoresMismatchedInputID(t *testing.T) {
	_, ok := parseAgentRunErrorEnvelope(`WRAPPER_ERROR_JSON={"input_id":"job_previous","message":"stale"}`, "job_current")
	if ok {
		t.Fatal("stale error envelope should be ignored")
	}
	envelope, ok := parseAgentRunErrorEnvelope(`WRAPPER_ERROR_JSON={"input_id":"job_current","message":"fresh"}`, "job_current")
	if !ok || envelope.Message != "fresh" {
		t.Fatalf("matching error envelope not parsed, ok=%t envelope=%+v", ok, envelope)
	}
}

func TestWorkerFailureFromAgentRunErrorMapsMaxIterationsToStop(t *testing.T) {
	err := workerFailureFromAgentRunError(agentRunErrorEnvelope{Code: "max_iterations_exceeded", Message: "Max iterations exceeded: 256"})
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

func TestStripWrapperControlLinesPreventsPrefixedTimelineLeak(t *testing.T) {
	raw := strings.Join([]string{
		"timeline source=hermes_sidecar t=0.000s event=process_start mode=\"client\" WRAPPER_EVENT_JSON={\"type\":\"reasoning_delta\",\"delta\":\"hidden\"}",
		"visible answer",
		"timeline source=hermes_sidecar t=0.001s event=result WRAPPER_RESULT_JSON={\"output_text\":\"visible answer\"}",
		"",
	}, "\n")
	if got := stripWrapperControlLines(raw); got != "visible answer" {
		t.Fatalf("stripWrapperControlLines returned %q", got)
	}
}

func TestCleanAgentVisibleOutputDropsWrapperAndReasoningLeak(t *testing.T) {
	raw := "timeline source=hermes_sidecar t=0.000s event=process_start WRAPPER_EVENT_JSON={\"type\":\"reasoning_delta\",\"delta\":\"\\nThe\"}\nfinal answer\n"
	if got := cleanAgentVisibleOutput(raw); got != "final answer" {
		t.Fatalf("cleanAgentVisibleOutput returned %q", got)
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
		"wisp stop_preflight diag client=",
		"wisp stop_preflight diag statfs /mnt/cloudagent-wisp:",
		"wisp stop_preflight diag findmnt:",
		"wisp stop_delegate_start",
		"wisp stop diagnostics: mount",
		"wisp stop diagnostics: df",
		"wisp stop diagnostics: process",
		"tail_safe_log",
		"tail_juicefs_log",
		"juicefs-assertmount.log",
		"wisp stop_daemon_log:",
		"filesystem_write_committed",
		"restore_checkpoint",
		"runtime.stop_state",
		"runtime.promote_stop_checkpoint",
		"create_checkpoint source_stat",
		"create_checkpoint clone_start",
		"create_checkpoint clone_done",
		"active_fsync_(start|done)",
		"stop_checkpoint_promote",
		"reset_runtime",
		"SUMMARY stop",
		"redact_line",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("stop command missing %q: %s", want, command)
		}
	}
	if !strings.Contains(command, "cloudagent-wisp") || !strings.Contains(command, "juicefs") || !strings.Contains(command, "smount") {
		t.Fatalf("stop command should collect Wisp/JuiceFS diagnostics: %s", command)
	}
	if strings.Contains(command, "writeback-cut-barrier /mnt/cloudagent-wisp") {
		t.Fatalf("stop command must not run host-namespace writeback barrier before wispclient stop: %s", command)
	}
}

func TestWispWorkspaceStopCommandDelegatesPersistenceToRuntimeStop(t *testing.T) {
	command := wispWorkspaceStopCommand(ACPSessionRuntime{
		WispClientPath: "/tmp/cloudagent-workspace-wisp/install/bin/wispclient",
		WispInstallDir: "/tmp/cloudagent-workspace-wisp/install",
		WispName:       "workspace-12345678",
	})
	stopIndex := strings.Index(command, "stop \"$name\"")
	if stopIndex < 0 {
		t.Fatalf("workspace stop command missing wispclient stop: %s", command)
	}
	if strings.Contains(command, "writeback-cut-barrier /mnt/cloudagent-wisp") {
		t.Fatalf("workspace stop command must let runtime stop run barriers in the Wisp namespace: %s", command)
	}
	if !strings.Contains(command, "CLOUDAGENT_WISP_STOPPED") {
		t.Fatalf("workspace stop command missing completion marker: %s", command)
	}
}

func TestWispSessionDaemonHostCommandWritesInnerDaemonPID(t *testing.T) {
	runtime := ACPSessionRuntime{
		RemoteBinary:   "/tmp/gateway/sessions/session_1/hermes-sidecar",
		WispClientPath: "/tmp/cloudagent-wisp/install/bin/wispclient",
		WispName:       "agent-session-1",
	}
	command := wispSessionDaemonHostCommand(runtime, []string{"daemon", "--addr", "127.0.0.1:37001"}, "/workspace", "/workspace/.cloudagent/sessions/session_1/hermes", "/tmp/gateway/sessions/session_1/daemon.log", nil)
	for _, want := range []string{
		"echo $$ >",
		"/tmp/gateway/sessions/session_1/daemon.pid",
		"trap",
		"exec",
		"/tmp/gateway/sessions/session_1/hermes-sidecar",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("wisp daemon command missing %q: %s", want, command)
		}
	}
}

func TestSidecarDaemonTerminateCommandUsesPIDFileWithoutPkillByDefault(t *testing.T) {
	t.Setenv("GATEWAY_ACP_FAULT_INJECTION_PKILL_FALLBACK", "")
	command := sidecarDaemonTerminateCommand("/tmp/gateway/sessions/session_1/daemon.pid", "/tmp/gateway/sessions/session_1/hermes-sidecar daemon")
	for _, want := range []string{
		"cat '/tmp/gateway/sessions/session_1/daemon.pid'",
		"kill -TERM \"$pid\"",
		"CLOUDAGENT_DAEMON_PID_MISSING",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("terminate command missing %q: %s", want, command)
		}
	}
	if strings.Contains(command, "pkill") {
		t.Fatalf("pkill fallback must be opt-in, got: %s", command)
	}
}

func TestKillSessionRuntimeDaemonUsesWispPIDFileInsteadOfProcessName(t *testing.T) {
	t.Setenv("GATEWAY_ACP_FAULT_INJECTION_PKILL_FALLBACK", "")
	host := &recordingRuntimeHost{}
	worker := &AgentSidecarWorker{
		backends: map[string]agentSidecarBackend{
			"": {host: host},
		},
	}
	runtime := ACPSessionRuntime{
		RuntimeID:          "rt_1",
		OuterRuntime:       outerRuntimeWisp,
		OuterSandboxID:     "outer_1",
		OuterSandboxDomain: runtimeHostTypeLocalWisp,
		RemoteBinary:       "/tmp/gateway/sessions/session_1/hermes-sidecar",
		DaemonAddr:         "http://127.0.0.1:37001",
		WispName:           "agent-session-1",
		WispClientPath:     "/tmp/cloudagent-wisp/install/bin/wispclient",
	}

	if err := worker.KillSessionRuntimeDaemon(context.Background(), runtime); err != nil {
		t.Fatalf("KillSessionRuntimeDaemon returned error: %v", err)
	}
	command := strings.Join(host.commands, "\n")
	if !strings.Contains(command, "daemon.pid") || !strings.Contains(command, "kill -TERM") {
		t.Fatalf("daemon fault injection should use pid file: %s", command)
	}
	if strings.Contains(command, "pkill") {
		t.Fatalf("daemon fault injection should not use process-name pkill by default: %s", command)
	}
}

func TestKillSessionRuntimeDaemonUsesRuntimeHostProcessController(t *testing.T) {
	host := &processControlRuntimeHost{}
	worker := &AgentSidecarWorker{
		backends: map[string]agentSidecarBackend{
			"": {host: host},
		},
	}
	runtime := ACPSessionRuntime{
		RuntimeID:            "rt_1",
		OuterSandboxID:       "outer_1",
		OuterEnvdAccessToken: "token",
		RemoteBinary:         "/tmp/gateway/sessions/session_1/hermes-sidecar",
		DaemonAddr:           "http://127.0.0.1:37001",
	}

	if err := worker.KillSessionRuntimeDaemon(context.Background(), runtime); err != nil {
		t.Fatalf("KillSessionRuntimeDaemon returned error: %v", err)
	}
	if len(host.killRequests) != 1 {
		t.Fatalf("expected one process controller request, got %#v", host.killRequests)
	}
	if host.killTargets[0] != "outer_1" {
		t.Fatalf("kill target=%q", host.killTargets[0])
	}
	req := host.killRequests[0]
	if req.PIDFile != "/tmp/gateway/sessions/session_1/daemon.pid" || req.ProcessPattern != "/tmp/gateway/sessions/session_1/hermes-sidecar daemon" {
		t.Fatalf("unexpected kill request: %#v", req)
	}
	if req.AllowProcessNameFallback {
		t.Fatalf("process-name fallback must be disabled by default")
	}
}

func TestStageSidecarBinaryIntoWispIncludesCommandDetailWhenRunCommandFails(t *testing.T) {
	host := &recordingRuntimeHost{
		runCommand: func(_ RuntimeHostTarget, _ string, _ map[string]string, _ func(string) error, onStderr func(string) error) (CommandResult, error) {
			if onStderr != nil {
				if err := onStderr("TIMELINE sidecar_preflight_start\ncloudagent-runtime: missing loader\n"); err != nil {
					return CommandResult{}, err
				}
			}
			return CommandResult{
				ExitCode: 1,
				Exited:   true,
				Status:   "exit status 1",
				Stderr:   "TIMELINE sidecar_preflight_start\ncloudagent-runtime: missing loader\n",
			}, errors.New("exit status 1")
		},
	}
	worker := &AgentSidecarWorker{}
	runtime := ACPSessionRuntime{
		RuntimeID:      "rt_session_stage_detail",
		WispClientPath: "/opt/wisp/bin/wispclient",
		WispName:       "workspace-stage-detail",
		RemoteBinary:   "/tmp/cloudagent-sidecar",
	}

	err := worker.stageSidecarBinaryIntoWisp(context.Background(), host, RuntimeHostTarget{ID: "outer_stage_detail"}, runtime, agentSidecarArtifact{
		URL:    "https://example.invalid/cloudagent-sidecar",
		SHA256: strings.Repeat("a", 64),
	})
	if err == nil {
		t.Fatal("expected stage failure")
	}
	got := err.Error()
	for _, want := range []string{
		"stage sidecar into wisp outer runtime",
		"exit status 1",
		"stderr_tail=",
		"TIMELINE sidecar_preflight_start",
		"cloudagent-runtime: missing loader",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("error missing %q:\n%s", want, got)
		}
	}
}

func TestCloseSessionRuntimeDoesNotDoubleStopWorkspaceAfterSidecarShutdown(t *testing.T) {
	host := &recordingRuntimeHost{
		runCommand: func(target RuntimeHostTarget, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
			if target.ID == "inner_1" {
				return CommandResult{}, fmt.Errorf("inner runtime should not receive command after sidecar shutdown: %s", command)
			}
			if strings.Contains(command, " client --addr ") && strings.Contains(command, " shutdown") {
				if onStdout != nil {
					events := strings.Join([]string{
						`WRAPPER_EVENT_JSON={"type":"runtime_host","event":"workspace_runtime_shutdown_done","sandbox_id":"inner_1"}`,
						`WRAPPER_EVENT_JSON={"type":"runtime_host","event":"inner_shutdown_done","sandbox_id":"inner_1"}`,
						"",
					}, "\n")
					if err := onStdout(events); err != nil {
						return CommandResult{}, err
					}
				}
				return CommandResult{ExitCode: 0, Exited: true, Status: "exited"}, nil
			}
			if strings.Contains(command, "agent-wisp-1") {
				return CommandResult{ExitCode: 0, Exited: true, Status: "exited", Stdout: "CLOUDAGENT_WISP_STOPPED\n"}, nil
			}
			return CommandResult{ExitCode: 0, Exited: true, Status: "exited"}, nil
		},
	}
	worker := &AgentSidecarWorker{
		backends: map[string]agentSidecarBackend{
			"": {host: host},
		},
	}
	runtime := ACPSessionRuntime{
		RuntimeID:           "rt_1",
		OuterRuntime:        outerRuntimeWisp,
		OuterSandboxID:      "outer_1",
		OuterSandboxDomain:  runtimeHostTypeLocalWisp,
		InnerSandboxID:      "inner_1",
		RemoteBinary:        "/tmp/gateway/sessions/session_1/hermes-sidecar",
		DaemonAddr:          "http://127.0.0.1:37001",
		WispName:            "agent-wisp-1",
		WispClientPath:      "/tmp/cloudagent-wisp/install/bin/wispclient",
		WorkspaceWispName:   "workspace-wisp-1",
		WorkspaceWispClient: "/tmp/cloudagent-workspace-wisp/install/bin/wispclient",
	}

	if err := worker.CloseSessionRuntime(context.Background(), runtime); err != nil {
		t.Fatalf("CloseSessionRuntime returned error: %v", err)
	}
	if got := strings.Join(host.deleted, ","); got != "outer_1" {
		t.Fatalf("deleted sandboxes=%q, want only outer_1", got)
	}
}

func TestCloseSessionRuntimeAcceptsMissingInnerAfterSidecarShutdownStarted(t *testing.T) {
	host := &recordingRuntimeHost{
		runCommand: func(target RuntimeHostTarget, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
			if strings.Contains(command, " client --addr ") && strings.Contains(command, " shutdown") {
				if onStdout != nil {
					events := strings.Join([]string{
						`WRAPPER_EVENT_JSON={"type":"runtime_host","event":"inner_shutdown_start","sandbox_id":"inner_1"}`,
						`WRAPPER_EVENT_JSON={"type":"runtime_host","event":"workspace_runtime_shutdown_start","sandbox_id":"inner_1"}`,
						"",
					}, "\n")
					if err := onStdout(events); err != nil {
						return CommandResult{}, err
					}
				}
				return CommandResult{ExitCode: 0, Exited: true, Status: "exited"}, nil
			}
			if target.ID == "inner_1" {
				return CommandResult{}, fmt.Errorf("ags http 404 op=run_command sandbox_id=%s domain=ap-shanghai.tencentags.com envd_port=49983: The requested resource does not exist", target.ID)
			}
			if strings.Contains(command, "agent-wisp-1") {
				return CommandResult{ExitCode: 0, Exited: true, Status: "exited", Stdout: "CLOUDAGENT_WISP_STOPPED\n"}, nil
			}
			return CommandResult{ExitCode: 0, Exited: true, Status: "exited"}, nil
		},
		probeSandbox: func(id string) (RuntimeHostSandboxProbe, error) {
			if id == "inner_1" {
				return RuntimeHostSandboxProbe{SandboxID: id, Exists: false, Status: "not_found"}, nil
			}
			return RuntimeHostSandboxProbe{SandboxID: id, Exists: true, Status: "running"}, nil
		},
	}
	worker := &AgentSidecarWorker{
		backends: map[string]agentSidecarBackend{
			"": {host: host},
		},
	}
	runtime := ACPSessionRuntime{
		RuntimeID:           "rt_1",
		OuterRuntime:        outerRuntimeWisp,
		OuterSandboxID:      "outer_1",
		OuterSandboxDomain:  runtimeHostTypeLocalWisp,
		InnerSandboxID:      "inner_1",
		RemoteBinary:        "/tmp/gateway/sessions/session_1/hermes-sidecar",
		DaemonAddr:          "http://127.0.0.1:37001",
		WispName:            "agent-wisp-1",
		WispClientPath:      "/tmp/cloudagent-wisp/install/bin/wispclient",
		WorkspaceWispName:   "workspace-wisp-1",
		WorkspaceWispClient: "/tmp/cloudagent-workspace-wisp/install/bin/wispclient",
	}

	if err := worker.CloseSessionRuntime(context.Background(), runtime); err != nil {
		t.Fatalf("CloseSessionRuntime should accept missing inner after sidecar shutdown started: %v", err)
	}
	if got := strings.Join(host.deleted, ","); got != "outer_1" {
		t.Fatalf("deleted sandboxes=%q, want only outer_1", got)
	}
}

func TestStopWispWorkspaceRuntimeRetriesTransientRunCommandNotFoundWhenProbeStillRunning(t *testing.T) {
	attempts := 0
	host := &recordingRuntimeHost{
		runCommand: func(target RuntimeHostTarget, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
			attempts++
			if attempts == 1 {
				return CommandResult{}, fmt.Errorf("ags http 404 op=run_command sandbox_id=%s domain=ap-beijing.tencentags.com envd_port=49983: The requested resource does not exist", target.ID)
			}
			return CommandResult{ExitCode: 0, Exited: true, Status: "exited", Stdout: "CLOUDAGENT_WISP_STOPPED\n"}, nil
		},
		probeSandbox: func(id string) (RuntimeHostSandboxProbe, error) {
			return RuntimeHostSandboxProbe{SandboxID: id, Exists: true, Status: "running"}, nil
		},
	}
	worker := &AgentSidecarWorker{}
	runtime := ACPSessionRuntime{
		RuntimeID:           "rt_1",
		OuterRuntime:        outerRuntimeWisp,
		WorkspaceRuntimeID:  "workspace_rt_1",
		WorkspaceWispName:   "workspace-wisp-1",
		WorkspaceWispClient: "/tmp/cloudagent-workspace-wisp/install/bin/wispclient",
	}
	err := worker.stopWispWorkspaceRuntime(context.Background(), host, RuntimeHostTarget{ID: "inner_1"}, runtime)
	if err != nil {
		t.Fatalf("stopWispWorkspaceRuntime returned error: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("run command attempts=%d, want 2", attempts)
	}
}

func TestStopWispWorkspaceRuntimeDoesNotRetryRunCommandNotFoundWhenProbeMissing(t *testing.T) {
	attempts := 0
	host := &recordingRuntimeHost{
		runCommand: func(target RuntimeHostTarget, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
			attempts++
			return CommandResult{}, fmt.Errorf("ags http 404 op=run_command sandbox_id=%s domain=ap-beijing.tencentags.com envd_port=49983: The requested resource does not exist", target.ID)
		},
		probeSandbox: func(id string) (RuntimeHostSandboxProbe, error) {
			return RuntimeHostSandboxProbe{SandboxID: id, Exists: false, Status: "not_found"}, nil
		},
	}
	worker := &AgentSidecarWorker{}
	runtime := ACPSessionRuntime{
		RuntimeID:           "rt_1",
		OuterRuntime:        outerRuntimeWisp,
		WorkspaceRuntimeID:  "workspace_rt_1",
		WorkspaceWispName:   "workspace-wisp-1",
		WorkspaceWispClient: "/tmp/cloudagent-workspace-wisp/install/bin/wispclient",
	}
	err := worker.stopWispWorkspaceRuntime(context.Background(), host, RuntimeHostTarget{ID: "inner_1"}, runtime)
	if err == nil {
		t.Fatal("stopWispWorkspaceRuntime should fail when probe also reports missing sandbox")
	}
	if attempts != 1 {
		t.Fatalf("run command attempts=%d, want 1", attempts)
	}
}

type recordingRuntimeHost struct {
	commands     []string
	targets      []string
	deleted      []string
	runCommand   func(RuntimeHostTarget, string, map[string]string, func(string) error, func(string) error) (CommandResult, error)
	probeSandbox func(string) (RuntimeHostSandboxProbe, error)
}

var _ RuntimeHost = (*recordingRuntimeHost)(nil)
var _ RuntimeHostSandboxProber = (*recordingRuntimeHost)(nil)

func (h *recordingRuntimeHost) CreateSandbox(context.Context, CreateSandboxOptions) (RuntimeHostTarget, error) {
	return RuntimeHostTarget{}, fmt.Errorf("CreateSandbox is not implemented in recordingRuntimeHost")
}

func (h *recordingRuntimeHost) DeleteSandbox(_ context.Context, id string) error {
	h.deleted = append(h.deleted, id)
	return nil
}

func (h *recordingRuntimeHost) RefreshSandboxTimeout(context.Context, string, int) error {
	return nil
}

func (h *recordingRuntimeHost) RunCommand(_ context.Context, target RuntimeHostTarget, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
	h.targets = append(h.targets, target.ID)
	h.commands = append(h.commands, command)
	if h.runCommand != nil {
		return h.runCommand(target, command, env, onStdout, onStderr)
	}
	return CommandResult{ExitCode: 0, Exited: true, Status: "exited"}, nil
}

func (h *recordingRuntimeHost) UploadFile(context.Context, RuntimeHostTarget, string, string, []byte) error {
	return nil
}

func (h *recordingRuntimeHost) DownloadFile(context.Context, RuntimeHostTarget, string) ([]byte, error) {
	return nil, fmt.Errorf("DownloadFile is not implemented in recordingRuntimeHost")
}

func (h *recordingRuntimeHost) RuntimeHostEnv() RuntimeHostEnv {
	return RuntimeHostEnv{}
}

func (h *recordingRuntimeHost) ProbeSandbox(_ context.Context, id string) (RuntimeHostSandboxProbe, error) {
	if h.probeSandbox != nil {
		return h.probeSandbox(id)
	}
	return RuntimeHostSandboxProbe{SandboxID: id, Status: "unsupported"}, nil
}

type processControlRuntimeHost struct {
	recordingRuntimeHost
	killTargets    []string
	killRequests   []RuntimeHostProcessGroupKillRequest
	killRequestErr error
}

var _ RuntimeHostProcessController = (*processControlRuntimeHost)(nil)

func (h *processControlRuntimeHost) KillTargetProcessGroup(_ context.Context, target RuntimeHostTarget, req RuntimeHostProcessGroupKillRequest) error {
	h.killTargets = append(h.killTargets, target.ID)
	h.killRequests = append(h.killRequests, req)
	return h.killRequestErr
}

func TestStaleRuntimeCleanupAuthFailureIsNonBlockingForRecreate(t *testing.T) {
	err := errors.New(`stop wisp outer runtime agent-session_1: wisp stop failed runtime_id=rt_1 outer_sandbox_id=outer_1 wisp_name=agent-session_1: exit=0 exited=false stdout_bytes=0 stderr_bytes=0 error="ags http 401 op=run_command sandbox_id=outer_1 domain=ap-shanghai.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]"`)
	if !isNonBlockingStaleRuntimeCleanupError(err) {
		t.Fatalf("expected stale auth cleanup failure to be non-blocking: %v", err)
	}
}

func TestWispPreMountCleanupAuthFailureBlocksRecreate(t *testing.T) {
	err := errors.New(`stop wisp outer runtime agent-session_1: wisp stop failed runtime_id=rt_1 outer_sandbox_id=outer_1 wisp_name=agent-session_1: exit=0 exited=false stdout_bytes=0 stderr_bytes=0 error="ags http 401 op=run_command sandbox_id=outer_1 domain=ap-shanghai.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]"`)
	if isNonBlockingWispPreMountCleanupError(err) {
		t.Fatalf("wisp pre-mount cleanup must not ignore auth failures because the old writer may still be live: %v", err)
	}
	if isNonBlockingCleanupBeforeRecreate(ACPSessionRuntime{OuterRuntime: outerRuntimeWisp}, err) {
		t.Fatalf("wisp recreate cleanup must not use the generic stale cleanup allowlist: %v", err)
	}
}

func TestWispPreMountCleanupMissingOrStoppedSandboxIsNonBlocking(t *testing.T) {
	for _, err := range []error{
		errors.New(`delete outer sandbox outer_1: ags http 404 op=delete_sandbox sandbox_id=outer_1: requested resource does not exist`),
		errors.New(`stop wisp outer runtime agent-session_1: UnsupportedOperation.SandboxInstance in stopped state`),
	} {
		if !isNonBlockingWispPreMountCleanupError(err) {
			t.Fatalf("missing/stopped old sandbox should not block wisp recreate: %v", err)
		}
	}
}

func TestStaleRuntimeCleanupAuthFailureWithCheckpointSignalBlocksRecreate(t *testing.T) {
	err := errors.New(`stop wisp outer runtime agent-session_1: checkpoint cut failed: input/output error; ags http 401 op=run_command sandbox_id=outer_1 domain=ap-shanghai.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]`)
	if isNonBlockingStaleRuntimeCleanupError(err) {
		t.Fatalf("checkpoint failure must not be hidden by stale auth cleanup matching: %v", err)
	}
	if isStaleRuntimeDataPlaneAuthError(err) {
		t.Fatalf("checkpoint failure must not be treated as pure stale data-plane auth: %v", err)
	}
}

func TestCloseSessionRuntimeIgnoresStaleDataPlaneAuthAfterOuterDelete(t *testing.T) {
	host := &recordingRuntimeHost{
		runCommand: func(RuntimeHostTarget, string, map[string]string, func(string) error, func(string) error) (CommandResult, error) {
			return CommandResult{}, errors.New(`ags http 401 op=run_command sandbox_id=outer_1 domain=ap-shanghai.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]`)
		},
	}
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		RuntimeHost:          host,
		OuterTemplateID:      "tmpl_outer",
		InnerTemplateID:      "tmpl_inner",
		SidecarURL:           "https://example.invalid/agent-sidecar",
		TokenHubAPIKey:       "tokenhub",
		OuterRuntime:         outerRuntimeWisp,
		WorkspaceService:     nil,
		WispSMHLibraryID:     "library",
		WispSMHAccessDomain:  "https://smh.example.invalid",
		WispSMHLibrarySecret: "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	err = worker.CloseSessionRuntime(context.Background(), ACPSessionRuntime{
		RuntimeID:            "rt_1",
		SandboxBackend:       "ags",
		OuterRuntime:         outerRuntimeWisp,
		OuterSandboxID:       "outer_1",
		OuterSandboxDomain:   "ap-shanghai.tencentags.com",
		OuterEnvdAccessToken: "expired_envd_token",
		RemoteBinary:         "/tmp/agent-sidecar",
		DaemonAddr:           "127.0.0.1:9876",
		WispName:             "agent-session_1",
	})
	if err != nil {
		t.Fatalf("CloseSessionRuntime should accept stale data-plane auth after control-plane delete: %v", err)
	}
	if got := len(host.commands); got != 2 {
		t.Fatalf("run command calls=%d, want shutdown and wisp stop", got)
	}
	if got := strings.Join(host.deleted, ","); got != "outer_1" {
		t.Fatalf("deleted sandboxes=%q, want outer_1", got)
	}
}

func TestCloseSessionRuntimeBlocksStaleAuthWhenInnerWorkspaceStopUnconfirmed(t *testing.T) {
	host := &recordingRuntimeHost{
		runCommand: func(target RuntimeHostTarget, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
			return CommandResult{}, fmt.Errorf(`ags http 401 op=run_command sandbox_id=%s domain=ap-shanghai.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]`, target.ID)
		},
	}
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		RuntimeHost:          host,
		OuterTemplateID:      "tmpl_outer",
		InnerTemplateID:      "tmpl_inner",
		SidecarURL:           "https://example.invalid/agent-sidecar",
		TokenHubAPIKey:       "tokenhub",
		OuterRuntime:         outerRuntimeWisp,
		WorkspaceService:     nil,
		WispSMHLibraryID:     "library",
		WispSMHAccessDomain:  "https://smh.example.invalid",
		WispSMHLibrarySecret: "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	err = worker.CloseSessionRuntime(context.Background(), ACPSessionRuntime{
		RuntimeID:            "rt_1",
		SandboxBackend:       "ags",
		OuterRuntime:         outerRuntimeWisp,
		OuterSandboxID:       "outer_1",
		OuterSandboxDomain:   "ap-shanghai.tencentags.com",
		OuterEnvdAccessToken: "expired_envd_token",
		InnerSandboxID:       "inner_1",
		InnerSandboxDomain:   "ap-shanghai.tencentags.com",
		InnerEnvdAccessToken: "expired_inner_envd_token",
		RemoteBinary:         "/tmp/agent-sidecar",
		DaemonAddr:           "127.0.0.1:9876",
		WispName:             "agent-session_1",
		WispClientPath:       "/tmp/cloudagent-wisp/bin/wispclient",
		WorkspaceWispName:    "workspace-wisp-1",
		WorkspaceWispClient:  "/tmp/cloudagent-workspace-wisp/bin/wispclient",
	})
	if err == nil {
		t.Fatal("CloseSessionRuntime must block recreate when inner workspace stop is unconfirmed")
	}
	if isNonBlockingStaleRuntimeCleanupError(err) {
		t.Fatalf("unconfirmed inner workspace stop must not be treated as non-blocking stale cleanup: %v", err)
	}
	if !strings.Contains(err.Error(), "shutdown inner workspace runtime") ||
		!strings.Contains(err.Error(), "stop workspace wisp runtime workspace-wisp-1") {
		t.Fatalf("expected inner workspace stop failures to be preserved: %v", err)
	}
	if got := strings.Join(host.deleted, ","); got != "outer_1" {
		t.Fatalf("deleted sandboxes=%q, want only outer_1; inner must not be deleted without workspace stop confirmation", got)
	}
}

func TestCloseSessionRuntimeTreatsMissingInnerAndOuterAsNotWritable(t *testing.T) {
	host := &recordingRuntimeHost{
		runCommand: func(target RuntimeHostTarget, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
			return CommandResult{}, fmt.Errorf(`ags http 401 op=run_command sandbox_id=%s domain=ap-shanghai.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]`, target.ID)
		},
		probeSandbox: func(id string) (RuntimeHostSandboxProbe, error) {
			return RuntimeHostSandboxProbe{SandboxID: id, Exists: false, Status: "not_found", Domain: "ap-shanghai.tencentags.com"}, nil
		},
	}
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		RuntimeHost:          host,
		OuterTemplateID:      "tmpl_outer",
		InnerTemplateID:      "tmpl_inner",
		SidecarURL:           "https://example.invalid/agent-sidecar",
		TokenHubAPIKey:       "tokenhub",
		OuterRuntime:         outerRuntimeWisp,
		WorkspaceService:     nil,
		WispSMHLibraryID:     "library",
		WispSMHAccessDomain:  "https://smh.example.invalid",
		WispSMHLibrarySecret: "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	err = worker.CloseSessionRuntime(context.Background(), ACPSessionRuntime{
		RuntimeID:            "rt_1",
		SandboxBackend:       "ags",
		OuterRuntime:         outerRuntimeWisp,
		OuterSandboxID:       "outer_1",
		OuterSandboxDomain:   "ap-shanghai.tencentags.com",
		OuterEnvdAccessToken: "expired_envd_token",
		InnerSandboxID:       "inner_1",
		InnerSandboxDomain:   "ap-shanghai.tencentags.com",
		InnerEnvdAccessToken: "expired_inner_envd_token",
		WorkspaceRuntimeID:   "workspace_rt_1",
		RemoteBinary:         "/tmp/agent-sidecar",
		DaemonAddr:           "127.0.0.1:9876",
		WispName:             "agent-session_1",
		WispClientPath:       "/tmp/cloudagent-wisp/bin/wispclient",
		WorkspaceWispName:    "workspace-wisp-1",
		WorkspaceWispClient:  "/tmp/cloudagent-workspace-wisp/bin/wispclient",
	})
	if err != nil {
		t.Fatalf("CloseSessionRuntime should accept missing stale sandboxes as not writable: %v", err)
	}
	if got := len(host.commands); got != 0 {
		t.Fatalf("missing sandboxes must not receive data-plane commands, got %d", got)
	}
	if got := strings.Join(host.deleted, ","); got != "outer_1" {
		t.Fatalf("deleted sandboxes=%q, want only outer cleanup", got)
	}
}

func TestStaleRuntimeCleanupCheckpointFailureStillBlocksRecreate(t *testing.T) {
	err := errors.New(`stop wisp outer runtime agent-session_1: wispclient: http 500: {"error":"juicefs-smount meta-barrier /mnt/cloudagent-wisp: checkpoint cut failed: input/output error"}`)
	if isNonBlockingStaleRuntimeCleanupError(err) {
		t.Fatalf("checkpoint failure must not be ignored: %v", err)
	}
}

func TestWispRestorePrefersCurrentPackageURL(t *testing.T) {
	current := "https://example.com/wisp-new.erofs"
	recorded := "https://example.com/wisp-old.erofs"
	if got := wispPackageURLForRestore(current, recorded); got != current {
		t.Fatalf("restore package url=%q, want current %q", got, current)
	}
	if got := wispPackageURLForRestore("", recorded); got != recorded {
		t.Fatalf("restore package url fallback=%q, want recorded %q", got, recorded)
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

func TestWispOuterPrepareScriptUsesFlattenedEROFSRootfs(t *testing.T) {
	if !strings.HasSuffix(defaultWispPackageURL, ".erofs") {
		t.Fatalf("default Wisp package must be the flattened EROFS artifact, got %q", defaultWispPackageURL)
	}
	script := wispOuterPrepareScript()
	for _, want := range []string{
		`*.erofs) pkg_format="${pkg_format:-erofs}"`,
		`sudo -n mount -t erofs -o loop,ro,exec "$pkg" "$install"`,
		`LOWER_SYSTEM_BASE: projectRoot + "/assets/rootfs/rootfs"`,
		`BASE_ROOTFS_DIR: projectRoot + "/assets/rootfs/rootfs"`,
		`BASE_ROOTFS_IMG: ""`,
		`BLANK_ROOT_UPPER_SPARSE: "$blank_root_upper_sparse"`,
		`export BASE_ROOTFS_DIR="$install/assets/rootfs/rootfs"`,
		`export BASE_ROOTFS_IMG=""`,
		`export BLANK_ROOT_UPPER_SPARSE="$blank_root_upper_sparse"`,
		`export PATH="$install/assets/bin/e2fsprogs/bin:$PATH"`,
		`WISP_USE_HOST_CRUN=1`,
		`packaged crun missing diagnostics begin`,
		`expected_package_sha256=`,
		`find "$install" -maxdepth 4`,
		`packaged crun is not executable`,
		`check permissions or noexec mount options`,
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("flattened EROFS prepare script missing %q: %s", want, script)
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
