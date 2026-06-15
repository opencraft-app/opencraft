package acp

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCloudAgentClientLiveHTTPRunProtocol(t *testing.T) {
	baseURL := strings.TrimSpace(os.Getenv("CHANNELGATEWAY_LIVE_CLOUDAGENT_URL"))
	if baseURL == "" {
		t.Skip("set CHANNELGATEWAY_LIVE_CLOUDAGENT_URL to run live CloudAgent HTTP run protocol e2e")
	}
	headers := liveCloudAgentHeaders(t)
	ctx, cancel := context.WithTimeout(context.Background(), liveCloudAgentTimeout())
	defer cancel()

	client := NewCloudAgentClient(baseURL, headers)
	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize live cloudagent client: %v", err)
	}
	sessionID, err := client.NewSession(ctx, "/workspace", "")
	if err != nil {
		t.Fatalf("create live cloudagent session: %v", err)
	}
	if err := client.LoadSession(ctx, sessionID, "/workspace"); err != nil {
		t.Fatalf("load live cloudagent session %s: %v", sessionID, err)
	}

	marker := fmt.Sprintf("CLOUDAGENT_LIVE_RUN_%d", time.Now().UnixNano())
	runID := "job_live_" + marker
	result, err := client.PromptWithRunID(ctx, sessionID, "请只回复 "+marker, runID)
	if err != nil {
		t.Fatalf("live cloudagent run %s failed: %v", runID, err)
	}
	if result.Text == "" {
		t.Fatalf("live cloudagent run %s returned empty output", runID)
	}
	if !strings.Contains(result.Text, marker) {
		t.Fatalf("live cloudagent run %s output did not contain marker %q: %q", runID, marker, result.Text)
	}

	fullReplay, err := client.fetchEvents(ctx, runID, 0)
	if err != nil {
		t.Fatalf("live cloudagent events replay run=%s: %v", runID, err)
	}
	if fullReplay.Run.RunID != runID || !cloudAgentTerminal(fullReplay.Run.Status) {
		t.Fatalf("live cloudagent replay should include terminal run state, got %#v", fullReplay.Run)
	}
	if len(fullReplay.Events) == 0 {
		t.Fatalf("live cloudagent replay should include durable events for run %s", runID)
	}
	lastSeq := fullReplay.Events[len(fullReplay.Events)-1].Seq
	tailReplay, err := client.fetchEvents(ctx, runID, lastSeq)
	if err != nil {
		t.Fatalf("live cloudagent after_seq tail replay run=%s seq=%d: %v", runID, lastSeq, err)
	}
	if len(tailReplay.Events) != 0 {
		t.Fatalf("live cloudagent after_seq=%d should not replay old events: %#v", lastSeq, tailReplay.Events)
	}
	streamReplay, err := client.fetchEventsStream(ctx, runID, 0)
	if err != nil {
		t.Fatalf("live cloudagent stream replay run=%s: %v", runID, err)
	}
	if len(streamReplay.Events) == 0 && !cloudAgentTerminal(streamReplay.Run.Status) {
		t.Fatalf("live cloudagent stream replay should return events or terminal run state, got run=%#v events=%#v", streamReplay.Run, streamReplay.Events)
	}
}

func liveCloudAgentHeaders(t *testing.T) http.Header {
	t.Helper()
	headers := http.Header{}
	if auth := strings.TrimSpace(firstEnvValue("CHANNELGATEWAY_LIVE_CLOUDAGENT_AUTHORIZATION", "CHANNELGATEWAY_ACP_AUTHORIZATION")); auth != "" {
		headers.Set("Authorization", auth)
	}
	if tenantID := strings.TrimSpace(firstEnvValue("CHANNELGATEWAY_LIVE_CLOUDAGENT_TENANT_ID", "CHANNELGATEWAY_TENANT_ID")); tenantID != "" {
		headers.Set("X-Tenant-ID", tenantID)
	}
	if projectID := strings.TrimSpace(firstEnvValue("CHANNELGATEWAY_LIVE_CLOUDAGENT_PROJECT_ID", "CHANNELGATEWAY_PROJECT_ID")); projectID != "" {
		headers.Set("X-Project-ID", projectID)
	}
	if headers.Get("Authorization") == "" && (headers.Get("X-Tenant-ID") == "" || headers.Get("X-Project-ID") == "") {
		t.Skip("set CHANNELGATEWAY_LIVE_CLOUDAGENT_AUTHORIZATION or CHANNELGATEWAY_LIVE_CLOUDAGENT_TENANT_ID/PROJECT_ID")
	}
	return headers
}

func liveCloudAgentTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv("CHANNELGATEWAY_LIVE_CLOUDAGENT_TIMEOUT"))
	if raw == "" {
		return 10 * time.Minute
	}
	if parsed, err := time.ParseDuration(raw); err == nil && parsed > 0 {
		return parsed
	}
	return 10 * time.Minute
}

func firstEnvValue(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}
