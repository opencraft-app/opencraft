package wrapper

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type sidecarStdoutEvent struct {
	Type       string          `json:"type"`
	Event      string          `json:"event"`
	Delta      string          `json:"delta"`
	ToolCallID string          `json:"tool_call_id"`
	Name       string          `json:"name"`
	Status     string          `json:"status"`
	Error      string          `json:"error"`
	Content    string          `json:"content"`
	SessionID  string          `json:"session_id"`
	SandboxID  string          `json:"sandbox_id"`
	Workspace  string          `json:"workspace_root"`
	Template   string          `json:"template"`
	RawInput   json.RawMessage `json:"raw_input"`
	RawOutput  json.RawMessage `json:"raw_output"`
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
