package helper

import (
	"net/http"
	"strings"
	"testing"
	"time"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
)

func TestStreamTimelineRecordsPostHeaderCancellation(t *testing.T) {
	start := time.Unix(100, 0)
	info := &relaycommon.RelayInfo{
		StartTime:             start,
		IsStream:              true,
		ChannelMeta:           &relaycommon.ChannelMeta{ChannelId: 4},
		ReceivedResponseCount: 0,
		StreamStatus:          relaycommon.NewStreamStatus(),
	}
	info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonClientGone, nil)
	line, ok := formatStreamTimeline(info, "abcdefghijklmnop", &http.Response{StatusCode: 200}, start.Add(60*time.Second))
	if !ok || !strings.Contains(line, "channel_id=4 elapsed_ms=60000 upstream_status=200 first_event_ms=-1 received_events=0 end_reason=client_gone") {
		t.Fatalf("unexpected stream timeline: %q", line)
	}
}

func TestStreamTimelineSkipsFastNormalCompletion(t *testing.T) {
	start := time.Unix(100, 0)
	info := &relaycommon.RelayInfo{StartTime: start, StreamStatus: relaycommon.NewStreamStatus()}
	info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonDone, nil)
	line, ok := formatStreamTimeline(info, "abcdefghijklmnop", nil, start.Add(time.Second))
	if ok || line != "" {
		t.Fatalf("fast normal stream unexpectedly logged: %q", line)
	}
}

func TestStreamTimelineRecordsFirstEventWithoutContent(t *testing.T) {
	start := time.Unix(100, 0)
	info := &relaycommon.RelayInfo{
		StartTime:             start,
		FirstResponseTime:     start.Add(4 * time.Second),
		ReceivedResponseCount: 3,
		StreamStatus:          relaycommon.NewStreamStatus(),
	}
	info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonDone, nil)
	line, ok := formatStreamTimeline(info, "abcdefghijklmnop", nil, start.Add(31*time.Second))
	if !ok || !strings.Contains(line, "first_event_ms=4000 received_events=3 end_reason=done") {
		t.Fatalf("unexpected first-event timeline: %q", line)
	}
	if line, ok := formatStreamTimeline(info, "bad\nsecret", nil, start.Add(31*time.Second)); ok || line != "" {
		t.Fatalf("unsafe trace unexpectedly logged: %q", line)
	}
}
