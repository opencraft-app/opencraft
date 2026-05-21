package wrapper

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

var allowedCreateResponseFields = map[string]bool{
	"model":                  true,
	"input":                  true,
	"instructions":           true,
	"stream":                 true,
	"previous_response_id":   true,
	"temperature":            true,
	"top_p":                  true,
	"user":                   true,
	"service_tier":           true,
	"truncation":             true,
	"include":                true,
	"tools":                  true,
	"tool_choice":            true,
	"text":                   true,
	"parallel_tool_calls":    true,
	"max_output_tokens":      true,
	"prompt_cache_key":       true,
	"prompt_cache_retention": true,
	"reasoning":              true,
	"store":                  true,
	"metadata":               true,
}

func decodeCreateResponseRequest(body io.Reader, out *createResponseRequest) error {
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(body)
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return err
	}
	if len(raw) == 0 {
		return fmt.Errorf("request body is required")
	}
	for key := range raw {
		if !allowedCreateResponseFields[key] {
			return fmt.Errorf("unsupported field %q", key)
		}
	}
	if value, ok := raw["model"]; ok {
		if err := json.Unmarshal(value, &out.Model); err != nil {
			return fmt.Errorf("model must be a string")
		}
	}
	if value, ok := raw["input"]; ok {
		decoded, err := decodeAny(value)
		if err != nil {
			return fmt.Errorf("input is invalid: %w", err)
		}
		out.Input = decoded
	}
	if value, ok := raw["instructions"]; ok {
		if err := json.Unmarshal(value, &out.Instructions); err != nil {
			return fmt.Errorf("instructions must be a string")
		}
	}
	if value, ok := raw["stream"]; ok {
		if err := json.Unmarshal(value, &out.Stream); err != nil {
			return fmt.Errorf("stream must be a boolean")
		}
	}
	if value, ok := raw["previous_response_id"]; ok && !isJSONNull(value) {
		if err := json.Unmarshal(value, &out.PreviousResponseID); err != nil {
			return fmt.Errorf("previous_response_id must be a string")
		}
	}
	return nil
}

func decodeAny(raw json.RawMessage) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func isJSONNull(raw json.RawMessage) bool {
	return strings.EqualFold(strings.TrimSpace(string(raw)), "null")
}

func configuredModels() []modelRecord {
	raw := os.Getenv("GATEWAY_MODELS")
	if raw == "" {
		raw = "agent-sidecar-chat,agent-sidecar-tool,agent-sidecar-e2e,agent-sidecar-e2e-file"
		if firstEnv("GATEWAY_TALOS_API_KEY", "TALOS_API_KEY") != "" {
			raw += ",agent-sidecar-talos,agent-sidecar-talos-tool,agent-sidecar-talos-e2e-file"
		}
	}
	seen := map[string]bool{}
	var models []modelRecord
	for _, part := range strings.Split(raw, ",") {
		id := strings.TrimSpace(part)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, modelRecord{
			ID:      id,
			Object:  "model",
			Created: 0,
			OwnedBy: "cloudagent",
		})
	}
	return models
}
