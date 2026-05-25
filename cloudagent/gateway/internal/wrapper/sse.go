package wrapper

import (
	"encoding/json"
	"fmt"
	"net/http"
)

type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func newSSEWriter(w http.ResponseWriter) (*sseWriter, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	return &sseWriter{w: w, flusher: flusher}, true
}

func (s *sseWriter) Send(eventType string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", eventType, data); err != nil {
		return err
	}
	s.flusher.Flush()
	return nil
}

func (s *sseWriter) SendData(payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "data: %s\n\n", data); err != nil {
		return err
	}
	s.flusher.Flush()
	return nil
}

func (s *sseWriter) SendRawData(data string) error {
	if _, err := fmt.Fprintf(s.w, "data: %s\n\n", data); err != nil {
		return err
	}
	s.flusher.Flush()
	return nil
}

func responseEvent(eventType string, responseID string, extra map[string]any) map[string]any {
	payload := map[string]any{
		"type":        eventType,
		"response_id": responseID,
	}
	for k, v := range extra {
		payload[k] = v
	}
	return payload
}

func responseCreatedEvent(rec ResponseRecord) map[string]any {
	return map[string]any{
		"type":        "response.created",
		"response_id": rec.ID,
		"response": map[string]any{
			"id":         rec.ID,
			"object":     rec.Object,
			"created_at": rec.CreatedAt,
			"status":     "in_progress",
			"model":      rec.Model,
			"output":     []any{},
		},
	}
}

func responseCompletedEvent(rec ResponseRecord) map[string]any {
	return map[string]any{
		"type":              "response.completed",
		"response_id":       rec.ID,
		"status":            rec.Status,
		"artifact_file_ids": rec.ArtifactFileIDs,
		"response": map[string]any{
			"id":                rec.ID,
			"object":            rec.Object,
			"created_at":        rec.CreatedAt,
			"status":            rec.Status,
			"model":             rec.Model,
			"output_text":       rec.OutputText,
			"output":            rec.Output,
			"artifact_file_ids": rec.ArtifactFileIDs,
		},
	}
}
