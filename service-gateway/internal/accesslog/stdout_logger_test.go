package accesslog

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestStdoutLoggerWritesSingleJSONLine(t *testing.T) {
	var buf bytes.Buffer
	logger := NewStdoutLogger(&buf)

	ts := time.Date(2026, 3, 22, 15, 4, 5, 0, time.UTC)
	logger.Log(Entry{
		Timestamp:  ts,
		Method:     "GET",
		Path:       "/healthz",
		Status:     200,
		DurationMS: 3,
		RouteName:  "health",
	})

	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n"))
	if len(lines) != 1 {
		t.Fatalf("expected 1 log line, got %d", len(lines))
	}

	var entry Entry
	if err := json.Unmarshal(lines[0], &entry); err != nil {
		t.Fatalf("unmarshal log line: %v", err)
	}

	if !entry.Timestamp.Equal(ts) {
		t.Fatalf("expected timestamp %s, got %s", ts, entry.Timestamp)
	}
	if entry.Path != "/healthz" || entry.Status != 200 {
		t.Fatalf("unexpected entry: %+v", entry)
	}
}
