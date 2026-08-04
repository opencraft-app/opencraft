package agentcli

import (
	"fmt"
	"strings"
)

type messageSendResponse struct {
	OK        bool   `json:"ok,omitempty"`
	State     string `json:"state"`
	MessageID string `json:"messageId,omitempty"`
}

func formatSentMessage(target string, response messageSendResponse) string {
	statusLine := fmt.Sprintf(
		"Message sent to %s. Message ID: %s",
		target,
		response.MessageID,
	)
	if response.MessageID != "" {
		replyTarget := target
		if !strings.Contains(target, ":") {
			replyTarget += ":" + shortID(response.MessageID)
		}
		statusLine += fmt.Sprintf(
			" (to reply in this message's thread, use target %q)",
			replyTarget,
		)
	}
	return statusLine + "\n"
}
