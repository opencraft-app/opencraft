package hermes

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

func (session *session) handleSessionUpdate(raw json.RawMessage) {
	var notification struct {
		SessionID string          `json:"sessionId"`
		Update    json.RawMessage `json:"update"`
	}
	if common.Unmarshal(raw, &notification) != nil {
		return
	}
	session.mu.Lock()
	sessionID := session.sessionID
	suppressUpdates := session.suppressUpdates
	session.mu.Unlock()
	if suppressUpdates {
		return
	}
	if sessionID != "" && notification.SessionID != sessionID {
		return
	}
	var header struct {
		SessionUpdate string `json:"sessionUpdate"`
	}
	if common.Unmarshal(notification.Update, &header) != nil {
		return
	}
	switch header.SessionUpdate {
	case "agent_message_chunk":
		if text := updateContentText(notification.Update); text != "" {
			session.emit(runtimeapi.Event{
				Kind:      runtimeapi.EventAssistantText,
				Text:      text,
				SessionID: notification.SessionID,
				LaunchID:  session.launchID,
				Raw:       append(json.RawMessage(nil), notification.Update...),
			})
		}
	case "agent_thought_chunk":
		if text := updateContentText(notification.Update); text != "" {
			session.emit(runtimeapi.Event{
				Kind:      runtimeapi.EventThinking,
				Text:      text,
				SessionID: notification.SessionID,
				LaunchID:  session.launchID,
				Raw:       append(json.RawMessage(nil), notification.Update...),
			})
		}
	case "tool_call":
		session.handleToolCall(notification.SessionID, notification.Update)
	case "tool_call_update":
		session.handleToolCallUpdate(notification.SessionID, notification.Update)
	case "usage_update":
		var update struct {
			Used int64 `json:"used"`
			Size int64 `json:"size"`
		}
		_ = common.Unmarshal(notification.Update, &update)
		session.emit(runtimeapi.Event{
			Kind:      runtimeapi.EventUsage,
			Detail:    fmt.Sprintf("context %d/%d tokens", update.Used, update.Size),
			SessionID: notification.SessionID,
			LaunchID:  session.launchID,
			Raw:       append(json.RawMessage(nil), notification.Update...),
		})
	case "available_commands_update":
		session.handleAvailableCommands(notification.SessionID, notification.Update)
	case "plan":
		session.emit(runtimeapi.Event{
			Kind:         runtimeapi.EventActivity,
			ActivityKind: "tool",
			Text:         "Hermes updated its plan",
			SessionID:    notification.SessionID,
			LaunchID:     session.launchID,
			Raw:          append(json.RawMessage(nil), notification.Update...),
		})
	}
}

func updateContentText(raw json.RawMessage) string {
	var update struct {
		Content struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if common.Unmarshal(raw, &update) != nil || update.Content.Type != "text" {
		return ""
	}
	return update.Content.Text
}

func (session *session) handleToolCall(
	sessionID string,
	raw json.RawMessage,
) {
	var update struct {
		ToolCallID string          `json:"toolCallId"`
		Title      string          `json:"title"`
		Status     string          `json:"status"`
		RawInput   json.RawMessage `json:"rawInput"`
		RawOutput  json.RawMessage `json:"rawOutput"`
	}
	if common.Unmarshal(raw, &update) != nil ||
		strings.TrimSpace(update.ToolCallID) == "" {
		return
	}
	session.mu.Lock()
	session.toolNames[update.ToolCallID] = update.Title
	session.mu.Unlock()
	session.emit(runtimeapi.Event{
		Kind:      runtimeapi.EventToolCall,
		Name:      firstNonEmpty(update.Title, update.ToolCallID),
		Detail:    renderRaw(update.RawInput),
		SessionID: sessionID,
		LaunchID:  session.launchID,
		Raw:       append(json.RawMessage(nil), raw...),
	})
	if terminalToolStatus(update.Status) {
		session.emit(runtimeapi.Event{
			Kind:      runtimeapi.EventToolOutput,
			Name:      firstNonEmpty(update.Title, update.ToolCallID),
			Detail:    renderRaw(update.RawOutput),
			SessionID: sessionID,
			LaunchID:  session.launchID,
			Raw:       append(json.RawMessage(nil), raw...),
		})
	}
}

func (session *session) handleToolCallUpdate(
	sessionID string,
	raw json.RawMessage,
) {
	var update struct {
		ToolCallID string          `json:"toolCallId"`
		Title      string          `json:"title"`
		Status     string          `json:"status"`
		RawOutput  json.RawMessage `json:"rawOutput"`
	}
	if common.Unmarshal(raw, &update) != nil ||
		!terminalToolStatus(update.Status) {
		return
	}
	session.mu.Lock()
	name := session.toolNames[update.ToolCallID]
	if update.Title != "" {
		name = update.Title
	}
	delete(session.toolNames, update.ToolCallID)
	session.mu.Unlock()
	session.emit(runtimeapi.Event{
		Kind:      runtimeapi.EventToolOutput,
		Name:      firstNonEmpty(name, update.ToolCallID),
		Detail:    renderRaw(update.RawOutput),
		SessionID: sessionID,
		LaunchID:  session.launchID,
		Raw:       append(json.RawMessage(nil), raw...),
	})
}

func (session *session) handleAvailableCommands(
	sessionID string,
	raw json.RawMessage,
) {
	var update struct {
		AvailableCommands []struct {
			Name string `json:"name"`
		} `json:"availableCommands"`
	}
	if common.Unmarshal(raw, &update) != nil {
		return
	}
	names := make([]string, 0, len(update.AvailableCommands))
	commands := make(map[string]struct{}, len(update.AvailableCommands))
	for _, command := range update.AvailableCommands {
		name := strings.TrimSpace(command.Name)
		if name == "" {
			continue
		}
		commands[name] = struct{}{}
		names = append(names, name)
	}
	sort.Strings(names)
	session.mu.Lock()
	session.availableCommands = commands
	session.mu.Unlock()
	if len(names) == 0 {
		return
	}
	session.emit(runtimeapi.Event{
		Kind:      runtimeapi.EventDiagnostic,
		Text:      "Hermes ACP commands: " + strings.Join(names, ", "),
		SessionID: sessionID,
		LaunchID:  session.launchID,
	})
}

func terminalToolStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func renderRaw(raw json.RawMessage) string {
	if len(raw) == 0 || rawJSONNull(raw) {
		return ""
	}
	var text string
	if common.Unmarshal(raw, &text) == nil {
		return text
	}
	return strings.TrimSpace(string(raw))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
