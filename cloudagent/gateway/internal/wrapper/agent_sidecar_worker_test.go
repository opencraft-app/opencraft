package wrapper

import (
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
