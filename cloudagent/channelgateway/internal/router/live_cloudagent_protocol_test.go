package router

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/store"
)

func TestProtocolE2ELiveCloudAgentHTTPDispatcher(t *testing.T) {
	baseURL := strings.TrimSpace(os.Getenv("CHANNELGATEWAY_LIVE_CLOUDAGENT_URL"))
	if baseURL == "" {
		t.Skip("set CHANNELGATEWAY_LIVE_CLOUDAGENT_URL to run live dispatcher + CloudAgent HTTP protocol e2e")
	}
	headers := liveCloudAgentHeaders(t)
	ctx, cancel := context.WithTimeout(context.Background(), liveCloudAgentTimeout())
	defer cancel()

	st := openLiveDispatcherStore(t, ctx)
	defer st.Close()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	accountID := "wecom-live-" + suffix
	account := store.ChannelAccount{
		ChannelAccountID: accountID,
		ChannelType:      string(channel.TypeWeCom),
		TenantID:         firstLiveEnvValue("CHANNELGATEWAY_LIVE_CLOUDAGENT_TENANT_ID", "CHANNELGATEWAY_TENANT_ID"),
		ProjectID:        firstLiveEnvValue("CHANNELGATEWAY_LIVE_CLOUDAGENT_PROJECT_ID", "CHANNELGATEWAY_PROJECT_ID"),
		AgentID:          "agent-live",
		ConfigJSON:       "{}",
		Status:           "active",
	}
	if account.TenantID == "" {
		account.TenantID = "tenant-live"
	}
	if account.ProjectID == "" {
		account.ProjectID = "project-live"
	}
	if err := st.UpsertChannelAccount(ctx, account); err != nil {
		t.Fatalf("upsert live account: %v", err)
	}
	lease, err := st.AcquireChannelLease(ctx, accountID, "owner-live", liveCloudAgentTimeout())
	if err != nil {
		t.Fatalf("acquire live account lease: %v", err)
	}

	client := acp.NewCloudAgentClient(baseURL, headers)
	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize live cloudagent client: %v", err)
	}
	dispatcher := NewDispatcherWithOptions(st, account, client, "/workspace", DispatcherOptions{RequestTimeout: liveCloudAgentTimeout()})
	firstMarker := "CHANNEL_DISPATCHER_LIVE_FIRST_" + suffix
	firstMsg := liveDispatcherMessage(accountID, suffix, "msg-live-first-"+suffix, "请只回复 "+firstMarker)
	if err := dispatcher.HandleInbound(ctx, firstMsg); err != nil {
		t.Fatalf("first live dispatcher message failed: %v", err)
	}
	if err := dispatcher.HandleInbound(ctx, firstMsg); err != nil {
		t.Fatalf("duplicate live dispatcher message failed: %v", err)
	}
	firstReply := claimOneLiveReply(t, ctx, st, lease)
	if !strings.Contains(firstReply.Text, firstMarker) {
		t.Fatalf("first live dispatcher reply did not contain marker %q: %q", firstMarker, firstReply.Text)
	}
	if err := st.MarkOutboxSent(ctx, lease, "out_reply_"+stableHex(strings.Join([]string{
		accountID,
		string(channel.TypeWeCom),
		firstMsg.ExternalMessageID,
		"reply",
	}, ":"), 32)); err != nil {
		t.Fatalf("mark first live outbox sent: %v", err)
	}

	sessionKey := channel.BuildSessionKey(account.AgentID, firstMsg, true, false)
	conversationAfterFirst, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       accountID,
		ChannelType:            string(channel.TypeWeCom),
		ExternalConversationID: firstMsg.ExternalConversationID,
		ExternalUserID:         firstMsg.ExternalUserID,
		ChatType:               string(firstMsg.ChatType),
		AgentID:                account.AgentID,
		SessionKey:             sessionKey,
	})
	if err != nil {
		t.Fatalf("load conversation after first live message: %v", err)
	}
	if conversationAfterFirst.ACPSessionID == "" {
		t.Fatalf("live dispatcher should bind a CloudAgent session after first message: %#v", conversationAfterFirst)
	}

	secondMarker := "CHANNEL_DISPATCHER_LIVE_SECOND_" + suffix
	secondMsg := liveDispatcherMessage(accountID, suffix, "msg-live-second-"+suffix, "请只回复 "+secondMarker)
	if err := dispatcher.HandleInbound(ctx, secondMsg); err != nil {
		t.Fatalf("second live dispatcher message failed: %v", err)
	}
	secondReply := claimOneLiveReply(t, ctx, st, lease)
	if !strings.Contains(secondReply.Text, secondMarker) {
		t.Fatalf("second live dispatcher reply did not contain marker %q: %q", secondMarker, secondReply.Text)
	}
	conversationAfterSecond, err := st.GetOrCreateConversation(ctx, store.Conversation{
		ChannelAccountID:       accountID,
		ChannelType:            string(channel.TypeWeCom),
		ExternalConversationID: secondMsg.ExternalConversationID,
		ExternalUserID:         secondMsg.ExternalUserID,
		ChatType:               string(secondMsg.ChatType),
		AgentID:                account.AgentID,
		SessionKey:             sessionKey,
	})
	if err != nil {
		t.Fatalf("load conversation after second live message: %v", err)
	}
	if conversationAfterSecond.ACPSessionID != conversationAfterFirst.ACPSessionID {
		t.Fatalf("live dispatcher must preserve CloudAgent session binding, first=%s second=%s", conversationAfterFirst.ACPSessionID, conversationAfterSecond.ACPSessionID)
	}
}

func openLiveDispatcherStore(t *testing.T, ctx context.Context) *store.Store {
	t.Helper()
	if dsn := strings.TrimSpace(os.Getenv("CHANNELGATEWAY_LIVE_MYSQL_DSN")); dsn != "" {
		st, err := store.OpenWithDriver(ctx, "mysql", dsn)
		if err != nil {
			t.Fatalf("open live MySQL store: %v", err)
		}
		return st
	}
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open live sqlite store: %v", err)
	}
	return st
}

func liveDispatcherMessage(accountID, suffix, messageID, text string) channel.Message {
	return channel.Message{
		ChannelAccountID:       accountID,
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      messageID,
		ExternalConversationID: "chat-live-" + suffix,
		ExternalUserID:         "user-live-" + suffix,
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   text,
		Raw:                    json.RawMessage(`{"live":true}`),
		ReceivedAt:             time.Now().UTC(),
	}
}

func claimOneLiveReply(t *testing.T, ctx context.Context, st *store.Store, lease store.ChannelLease) channel.Reply {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		claimed, err := st.ClaimPendingOutbox(ctx, lease, 10)
		if err != nil {
			t.Fatalf("claim live outbox: %v", err)
		}
		if len(claimed) == 1 {
			var reply channel.Reply
			if err := json.Unmarshal([]byte(claimed[0].PayloadJSON), &reply); err != nil {
				t.Fatalf("decode live outbox reply: %v payload=%s", err, claimed[0].PayloadJSON)
			}
			return reply
		}
		if len(claimed) > 1 {
			t.Fatalf("expected one live outbox reply, got %#v", claimed)
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for live outbox reply")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func liveCloudAgentHeaders(t *testing.T) http.Header {
	t.Helper()
	headers := http.Header{}
	if auth := strings.TrimSpace(firstLiveEnvValue("CHANNELGATEWAY_LIVE_CLOUDAGENT_AUTHORIZATION", "CHANNELGATEWAY_ACP_AUTHORIZATION")); auth != "" {
		headers.Set("Authorization", auth)
	}
	if tenantID := strings.TrimSpace(firstLiveEnvValue("CHANNELGATEWAY_LIVE_CLOUDAGENT_TENANT_ID", "CHANNELGATEWAY_TENANT_ID")); tenantID != "" {
		headers.Set("X-Tenant-ID", tenantID)
	}
	if projectID := strings.TrimSpace(firstLiveEnvValue("CHANNELGATEWAY_LIVE_CLOUDAGENT_PROJECT_ID", "CHANNELGATEWAY_PROJECT_ID")); projectID != "" {
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
		return 15 * time.Minute
	}
	if parsed, err := time.ParseDuration(raw); err == nil && parsed > 0 {
		return parsed
	}
	return 15 * time.Minute
}

func firstLiveEnvValue(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func stableHex(value string, length int) string {
	sum := sha256.Sum256([]byte(value))
	encoded := hex.EncodeToString(sum[:])
	if length > 0 && length < len(encoded) {
		return encoded[:length]
	}
	return encoded
}
