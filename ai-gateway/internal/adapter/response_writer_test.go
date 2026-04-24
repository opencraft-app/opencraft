package adapter

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func newAdaptedTestWriter(t *testing.T, format APIFormat) (*AdaptedResponseWriter, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	return NewAdaptedResponseWriter(ctx.Writer, format, nil, true), recorder
}

func TestAdaptedResponseWriter_GeminiStreamHandlesSplitWrites(t *testing.T) {
	writer, recorder := newAdaptedTestWriter(t, FormatGemini)

	first := "data: {\"choices\":[{\"delta\":{\"content\":\"brace { text\"}}"
	second := "],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n\ndata: [DONE]\n"

	if _, err := writer.Write([]byte(first)); err != nil {
		t.Fatalf("first write failed: %v", err)
	}
	if _, err := writer.Write([]byte(second)); err != nil {
		t.Fatalf("second write failed: %v", err)
	}
	writer.Flush()

	body := recorder.Body.String()
	if !strings.HasPrefix(body, "[\n") {
		t.Fatalf("expected gemini stream array header, got %q", body)
	}
	if !strings.Contains(body, "brace { text") {
		t.Fatalf("expected merged content in output, got %q", body)
	}
	if !strings.Contains(body, "\"totalTokenCount\":3") {
		t.Fatalf("expected usage metadata in output, got %q", body)
	}
	if !strings.HasSuffix(strings.TrimSpace(body), "]") {
		t.Fatalf("expected gemini stream array to close, got %q", body)
	}
}

func TestAdaptedResponseWriter_AnthropicStreamHandlesSplitWrites(t *testing.T) {
	writer, recorder := newAdaptedTestWriter(t, FormatAnthropic)

	first := "data: {\"id\":\"chatcmpl-1\",\"model\":\"claude-test\",\"choices\":[{\"delta\":{\"content\":\"hello\"}}"
	second := "],\"usage\":{\"prompt_tokens\":4}}\n\ndata: {\"choices\":[{\"finish_reason\":\"stop\"}],\"usage\":{\"completion_tokens\":2}}\n\ndata: [DONE]\n"

	if _, err := writer.Write([]byte(first)); err != nil {
		t.Fatalf("first write failed: %v", err)
	}
	if _, err := writer.Write([]byte(second)); err != nil {
		t.Fatalf("second write failed: %v", err)
	}
	writer.Flush()

	body := recorder.Body.String()
	if !strings.Contains(body, "event: message_start") {
		t.Fatalf("expected message_start event, got %q", body)
	}
	if !strings.Contains(body, "\"text\":\"hello\"") {
		t.Fatalf("expected text delta in output, got %q", body)
	}
	if !strings.Contains(body, "\"input_tokens\":4") {
		t.Fatalf("expected prompt token usage in output, got %q", body)
	}
	if !strings.Contains(body, "event: message_stop") {
		t.Fatalf("expected message_stop event, got %q", body)
	}
}
