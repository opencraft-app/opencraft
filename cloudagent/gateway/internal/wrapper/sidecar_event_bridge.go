package wrapper

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type sidecarStdoutEvent struct {
	Type        string          `json:"type"`
	RunSeq      int64           `json:"run_seq"`
	Event       string          `json:"event"`
	Delta       string          `json:"delta"`
	ToolCallID  string          `json:"tool_call_id"`
	Name        string          `json:"name"`
	Status      string          `json:"status"`
	Error       string          `json:"error"`
	Content     string          `json:"content"`
	SessionID   string          `json:"session_id"`
	SandboxID   string          `json:"sandbox_id"`
	Workspace   string          `json:"workspace_root"`
	Template    string          `json:"template"`
	ExitCode    *int            `json:"exit_code"`
	StdoutBytes *int            `json:"stdout_bytes"`
	StderrBytes *int            `json:"stderr_bytes"`
	StdoutTail  string          `json:"stdout_tail"`
	StderrTail  string          `json:"stderr_tail"`
	RawInput    json.RawMessage `json:"raw_input"`
	RawOutput   json.RawMessage `json:"raw_output"`
}

func sidecarRuntimeHostEventFields(event sidecarStdoutEvent) string {
	var fields []string
	if event.ExitCode != nil {
		fields = append(fields, fmt.Sprintf("exit_code=%d", *event.ExitCode))
	}
	if event.StdoutBytes != nil {
		fields = append(fields, fmt.Sprintf("stdout_bytes=%d", *event.StdoutBytes))
	}
	if event.StderrBytes != nil {
		fields = append(fields, fmt.Sprintf("stderr_bytes=%d", *event.StderrBytes))
	}
	if event.StdoutTail != "" {
		fields = append(fields, "stdout_tail="+quoteTimelineField(event.StdoutTail))
	}
	if event.StderrTail != "" {
		fields = append(fields, "stderr_tail="+quoteTimelineField(event.StderrTail))
	}
	if len(fields) == 0 {
		return ""
	}
	return " " + strings.Join(fields, " ")
}

func sidecarToolEventFields(event sidecarStdoutEvent) string {
	var fields []string
	if event.ToolCallID != "" {
		fields = append(fields, "tool_call_id="+quoteTimelineField(event.ToolCallID))
	}
	if event.Name != "" {
		fields = append(fields, "tool_name="+quoteTimelineField(event.Name))
	}
	if event.Status != "" {
		fields = append(fields, "tool_status="+quoteTimelineField(event.Status))
	}
	if event.Error != "" {
		fields = append(fields, "tool_error="+quoteTimelineField(redactCommandOutput(event.Error)))
	}
	if event.Content != "" {
		fields = append(fields, fmt.Sprintf("content_bytes=%d", len(event.Content)))
		fields = append(fields, "content_tail="+quoteTimelineField(timelineTextTail(event.Content, 700)))
	}
	if len(event.RawInput) > 0 && string(event.RawInput) != "null" {
		fields = append(fields, fmt.Sprintf("raw_input_bytes=%d", len(event.RawInput)))
		fields = append(fields, "raw_input_tail="+quoteTimelineField(timelineTextTail(string(event.RawInput), 700)))
	}
	if len(event.RawOutput) > 0 && string(event.RawOutput) != "null" {
		fields = append(fields, fmt.Sprintf("raw_output_bytes=%d", len(event.RawOutput)))
		fields = append(fields, "raw_output_tail="+quoteTimelineField(timelineTextTail(string(event.RawOutput), 900)))
	}
	if len(fields) == 0 {
		return ""
	}
	return " " + strings.Join(fields, " ")
}

func timelineTextTail(value string, limit int) string {
	value = strings.TrimSpace(redactCommandOutput(value))
	if value == "" || limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	return "...[truncated]\n" + value[len(value)-limit:]
}

func workerEventFromSidecarEvent(jobID string, sequence int64, event sidecarStdoutEvent) (workerEvent, bool) {
	ev := workerEvent{
		WorkerContractVersion: WorkerContractVersion,
		EventID:               fmt.Sprintf("evt_%s_%s_%d", jobID, event.Type, sequence),
		JobID:                 jobID,
		Sequence:              sequence,
		Timestamp:             time.Now().UTC().Unix(),
	}
	switch event.Type {
	case "output_text_delta":
		if event.Delta == "" {
			return workerEvent{}, false
		}
		ev.Kind = "output_text_delta"
		ev.Delta = event.Delta
		return ev, true
	case "reasoning_delta":
		if event.Delta == "" {
			return workerEvent{}, false
		}
		ev.Kind = "reasoning_delta"
		ev.Delta = event.Delta
		return ev, false
	case "tool_call", "tool_call_update":
		ev.Kind = event.Type
		ev.ToolCallID = event.ToolCallID
		ev.ToolName = event.Name
		ev.ToolStatus = event.Status
		ev.ToolError = event.Error
		ev.ToolContent = event.Content
		ev.ToolRawInput = cloneRawMessage(event.RawInput)
		ev.ToolRawOutput = cloneRawMessage(event.RawOutput)
		return ev, false
	default:
		return workerEvent{}, false
	}
}

func cloneRawMessage(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	out := make([]byte, len(raw))
	copy(out, raw)
	return out
}

type sidecarStdoutParser struct {
	pending string
}

func (p *sidecarStdoutParser) Feed(text string) []sidecarStdoutEvent {
	if text == "" {
		return nil
	}
	p.pending += text
	return p.drain(false)
}

func (p *sidecarStdoutParser) Finish() []sidecarStdoutEvent {
	return p.drain(true)
}

func (p *sidecarStdoutParser) drain(flush bool) []sidecarStdoutEvent {
	if p.pending == "" {
		return nil
	}
	lines := strings.Split(p.pending, "\n")
	if !flush && !strings.HasSuffix(p.pending, "\n") {
		p.pending = lines[len(lines)-1]
		lines = lines[:len(lines)-1]
	} else {
		p.pending = ""
	}
	return parseSidecarStdoutEvents(lines)
}

func parseSidecarStdoutEvents(lines []string) []sidecarStdoutEvent {
	var events []sidecarStdoutEvent
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "WRAPPER_EVENT_JSON=") {
			continue
		}
		raw := strings.TrimPrefix(line, "WRAPPER_EVENT_JSON=")
		var event sidecarStdoutEvent
		if err := json.Unmarshal([]byte(raw), &event); err == nil {
			events = append(events, event)
		}
	}
	return events
}
