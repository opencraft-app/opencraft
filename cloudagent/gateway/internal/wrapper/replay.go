package wrapper

import (
	"encoding/json"
	"strings"
)

func acpReplayUpdate(event acpSessionEvent) (map[string]any, bool) {
	var payload map[string]any
	if len(event.Payload) == 0 || json.Unmarshal(event.Payload, &payload) != nil {
		return nil, false
	}
	if isLegacyPrivateLifecycleReplay(payload) {
		return nil, false
	}
	payload["replay"] = true
	attachACPEventIdentity(payload, event.TurnID, event.MessageID, event.BlockID, event.Seq)
	return map[string]any{
		"sessionId": event.SessionID,
		"update":    payload,
	}, true
}

func isLegacyPrivateLifecycleReplay(payload map[string]any) bool {
	switch payload["sessionUpdate"] {
	case "error", "lifecycle", "replay_done", "replay_gap", "turn_complete":
		return true
	default:
		return false
	}
}

func attachACPEventIdentity(payload map[string]any, turnID, messageID, blockID string, eventSeq int64) {
	if payload == nil {
		return
	}
	if eventSeq > 0 {
		payload["eventSeq"] = eventSeq
	}
	if blockID != "" {
		payload["eventId"] = blockID
		if _, ok := payload["blockId"]; !ok {
			payload["blockId"] = blockID
		}
	}
	if turnID != "" {
		payload["turnId"] = turnID
	}
	if messageID != "" {
		if _, ok := payload["messageId"]; !ok {
			payload["messageId"] = messageID
		}
	}
}
func mapRoleToReplayUpdate(role string) string {
	if role == "user" {
		return "user_message_chunk"
	}
	return "agent_message_chunk"
}

func (g *ACPGateway) replaySession(ws *WSConn, appEnvelope bool, session *acpSession) error {
	var lastEventSeq int64
	for _, event := range session.Events {
		update, ok := acpReplayUpdate(event)
		if !ok {
			continue
		}
		if event.Seq > lastEventSeq {
			lastEventSeq = event.Seq
		}
		if err := g.writeNotification(ws, appEnvelope, "session/update", update); err != nil {
			return err
		}
	}
	if len(session.Events) == 0 {
		for _, item := range session.History {
			if strings.TrimSpace(item.Text) == "" {
				continue
			}
			update := map[string]any{
				"sessionId": session.SessionID,
				"update": map[string]any{
					"sessionUpdate": mapRoleToReplayUpdate(item.Role),
					"content":       map[string]any{"text": item.Text},
				},
			}
			if err := g.writeNotification(ws, appEnvelope, "session/update", update); err != nil {
				return err
			}
		}
	}
	return g.writeNotification(ws, appEnvelope, cloudAgentReplayDoneMethod, cloudAgentReplayDoneParams(session.SessionID, lastEventSeq))
}
