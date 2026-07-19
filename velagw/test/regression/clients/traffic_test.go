package clients

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestTrafficClientCompletesChatAndStrictSSEWithoutReconnect(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer sk-regression" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			flusher := w.(http.Flusher)
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"regression-marker\"}}]}\n\n")
			flusher.Flush()
			time.Sleep(20 * time.Millisecond)
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			flusher.Flush()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"regression-marker"}}]}`))
	}))
	defer server.Close()
	sanitizer := framework.NewSanitizer()
	client := NewTrafficClient(server.Client(), sanitizer)
	key := sanitizer.Secret("sk-regression")

	chat, err := client.Chat(t.Context(), server.URL, key, "llmgw-regression-chat", "regression-marker")
	if err != nil || !chat.MarkerFound {
		t.Fatalf("chat=%+v err=%v", chat, err)
	}
	var callbackEvents, doneEvents int
	stream, err := client.Stream(t.Context(), server.URL, key, "llmgw-regression-chat", "regression-marker", func(event StreamEvent) {
		callbackEvents++
		if event.Done {
			doneEvents++
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if !stream.MarkerFound || !stream.Done || stream.RequestCount != 1 || stream.EventCount != 1 {
		t.Fatalf("stream = %+v", stream)
	}
	if callbackEvents != 2 || doneEvents != 1 {
		t.Fatalf("callback events=%d done=%d", callbackEvents, doneEvents)
	}
	if requests.Load() != 2 {
		t.Fatalf("requests = %d", requests.Load())
	}
}

func TestTrafficClientRejectsMalformedOrTrailingSSE(t *testing.T) {
	for name, body := range map[string]string{
		"malformed": "data: not-json\n\ndata: [DONE]\n\n",
		"trailing":  "data: {\"choices\":[]}\n\ndata: [DONE]\n\ndata: {\"late\":true}\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, body)
			}))
			defer server.Close()
			sanitizer := framework.NewSanitizer()
			_, err := NewTrafficClient(server.Client(), sanitizer).Stream(t.Context(), server.URL, sanitizer.Secret("sk"), "model", "marker", nil)
			if err == nil {
				t.Fatal("Stream() error = nil")
			}
		})
	}
}
