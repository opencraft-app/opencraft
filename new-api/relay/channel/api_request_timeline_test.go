package channel

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
)

func TestRelayUpstreamTimelineSkipsFastSuccess(t *testing.T) {
	line, ok := formatRelayUpstreamTimeline(&relaycommon.RelayInfo{IsStream: true}, "abcdefghijklmnop", time.Second, &http.Response{StatusCode: 200}, nil, nil)
	if ok || line != "" {
		t.Fatalf("fast success unexpectedly logged: %q", line)
	}
}

func TestRelayUpstreamTimelineRecordsSlowStreamingHeaders(t *testing.T) {
	info := &relaycommon.RelayInfo{IsStream: true, ChannelMeta: &relaycommon.ChannelMeta{ChannelId: 4}, UpstreamRequestBodySize: 120000}
	line, ok := formatRelayUpstreamTimeline(info, "abcdefghijklmnop", 60*time.Second, &http.Response{StatusCode: 200}, nil, nil)
	if !ok || !strings.Contains(line, "trace_id=abcdefghijklmnop request_streaming=true channel_id=4 elapsed_ms=60000 upstream_status=200 result=response_headers upstream_body_bytes=120000") {
		t.Fatalf("unexpected timeline: %q", line)
	}
}

func TestRelayUpstreamTimelineClassifiesCancellationWithoutLeakingInput(t *testing.T) {
	secret := "private-key-and-prompt"
	line, ok := formatRelayUpstreamTimeline(
		&relaycommon.RelayInfo{IsStream: false},
		"abcdefghijklmnop",
		59*time.Second,
		nil,
		errors.New(secret),
		context.Canceled,
	)
	if !ok || !strings.Contains(line, "trace_id=abcdefghijklmnop request_streaming=false") || !strings.Contains(line, "result=context_canceled") || strings.Contains(line, secret) {
		t.Fatalf("unsafe cancellation timeline: %q", line)
	}
}

func TestRelayUpstreamTimelineSkipsUncorrelatedRequest(t *testing.T) {
	line, ok := formatRelayUpstreamTimeline(&relaycommon.RelayInfo{}, "invalid\nsecret", time.Minute, nil, errors.New("secret"), context.Canceled)
	if ok || line != "" {
		t.Fatalf("uncorrelated request unexpectedly logged: %q", line)
	}
}

func TestRelayUpstreamTimelineDistinguishesNoResponse(t *testing.T) {
	line, ok := formatRelayUpstreamTimeline(&relaycommon.RelayInfo{}, "abcdefghijklmnop", 30*time.Second, nil, nil, nil)
	if !ok || !strings.Contains(line, "upstream_status=0 result=no_response") {
		t.Fatalf("unexpected no-response timeline: %q", line)
	}
}
