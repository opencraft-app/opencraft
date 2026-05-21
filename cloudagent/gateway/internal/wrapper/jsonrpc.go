package wrapper

import (
	"encoding/json"
	"fmt"
)

type jsonRPCMessage struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func parseJSONRPC(data []byte) (jsonRPCMessage, error) {
	var msg jsonRPCMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return msg, err
	}
	if msg.JSONRPC != "2.0" {
		return msg, fmt.Errorf("not a JSON-RPC 2.0 message")
	}
	hasID := len(msg.ID) > 0
	hasResult := len(msg.Result) > 0
	hasError := msg.Error != nil
	if msg.Method != "" {
		if hasResult || hasError {
			return msg, fmt.Errorf("JSON-RPC request must not include result or error")
		}
		return msg, nil
	}
	if !hasID {
		return msg, fmt.Errorf("not a JSON-RPC request, notification, or response")
	}
	if hasResult == hasError {
		return msg, fmt.Errorf("JSON-RPC response must include exactly one of result or error")
	}
	return msg, nil
}

func idKey(id json.RawMessage) string {
	if len(id) == 0 || string(id) == "null" {
		return ""
	}
	return string(id)
}
