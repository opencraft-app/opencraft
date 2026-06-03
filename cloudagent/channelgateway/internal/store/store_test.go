package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStoreMigrationAccountLeaseAndOutbox(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account := ChannelAccount{
		ChannelAccountID: "wecom-a",
		ChannelType:      "wecom",
		TenantID:         "tenant",
		ProjectID:        "project",
		AgentID:          "main",
		ConfigJSON:       "{}",
		Status:           "active",
	}
	if err := st.UpsertChannelAccount(ctx, account); err != nil {
		t.Fatalf("upsert account: %v", err)
	}
	loaded, ok, err := st.LoadChannelAccount(ctx, "wecom-a")
	if err != nil || !ok {
		t.Fatalf("load account ok=%v err=%v", ok, err)
	}
	if loaded.AgentID != "main" || loaded.ChannelType != "wecom" {
		t.Fatalf("unexpected account: %#v", loaded)
	}
	lease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	if _, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-b", time.Minute); !errors.As(err, &LeaseHeldError{}) {
		t.Fatalf("expected held lease error, got %v", err)
	}
	renewed, err := st.RenewChannelLease(ctx, lease, time.Minute)
	if err != nil {
		t.Fatalf("renew lease: %v", err)
	}
	if !renewed.ExpiresAt.After(lease.ExpiresAt) {
		t.Fatalf("renew should extend lease: old=%s new=%s", lease.ExpiresAt, renewed.ExpiresAt)
	}
	if err := st.ReleaseChannelLease(ctx, renewed); err != nil {
		t.Fatalf("release lease: %v", err)
	}
	leaseB, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-b", time.Minute)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	rec, err := st.EnqueueOutbox(ctx, OutboxRecord{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		PayloadJSON:            `{"text":"hello"}`,
	})
	if err != nil {
		t.Fatalf("enqueue outbox: %v", err)
	}
	claimed, err := st.ClaimPendingOutbox(ctx, leaseB, 10)
	if err != nil {
		t.Fatalf("claim outbox: %v", err)
	}
	if len(claimed) != 1 || claimed[0].OutboxID != rec.OutboxID {
		t.Fatalf("unexpected claimed outbox: %#v", claimed)
	}
	if err := st.MarkOutboxSent(ctx, leaseB, rec.OutboxID); err != nil {
		t.Fatalf("mark sent: %v", err)
	}
	claimed, err = st.ClaimPendingOutbox(ctx, leaseB, 10)
	if err != nil {
		t.Fatalf("claim after sent: %v", err)
	}
	if len(claimed) != 0 {
		t.Fatalf("sent outbox should not be claimed: %#v", claimed)
	}
}

func TestStoreOutboxClaimIsFencedAcrossSharedDBConnections(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/channelgateway.db"
	first, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open first store: %v", err)
	}
	defer first.Close()
	second, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open second store: %v", err)
	}
	defer second.Close()
	leaseA, err := first.AcquireChannelLease(ctx, "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire owner-a lease: %v", err)
	}
	if _, err := first.EnqueueOutbox(ctx, OutboxRecord{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		PayloadJSON:            `{"text":"hello"}`,
	}); err != nil {
		t.Fatalf("enqueue outbox: %v", err)
	}
	claimedA, err := first.ClaimPendingOutbox(ctx, leaseA, 10)
	if err != nil {
		t.Fatalf("owner-a claim: %v", err)
	}
	if len(claimedA) != 1 {
		t.Fatalf("owner-a should claim one outbox, got %#v", claimedA)
	}
	if err := first.ReleaseChannelLease(ctx, leaseA); err != nil {
		t.Fatalf("release owner-a lease: %v", err)
	}
	leaseB, err := second.AcquireChannelLease(ctx, "wecom-a", "owner-b", time.Minute)
	if err != nil {
		t.Fatalf("acquire owner-b lease: %v", err)
	}
	if err := second.MarkOutboxSent(ctx, leaseB, claimedA[0].OutboxID); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("new owner must not mark old claim sent, got %v", err)
	}
	if err := first.MarkOutboxFailed(ctx, leaseA, claimedA[0].OutboxID, "retry", time.Now().UTC()); err != nil {
		t.Fatalf("original owner should release claim to retry: %v", err)
	}
	claimedB, err := second.ClaimPendingOutbox(ctx, leaseB, 10)
	if err != nil {
		t.Fatalf("owner-b claim after retry: %v", err)
	}
	if len(claimedB) != 1 || claimedB[0].ClaimOwnerID != leaseB.OwnerID || claimedB[0].ClaimFencingToken != leaseB.FencingToken {
		t.Fatalf("owner-b should claim retry with its fence, got %#v", claimedB)
	}
}

func TestStoreConversationAndMessageDedup(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	conv, err := st.GetOrCreateConversation(ctx, Conversation{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalConversationID: "chat-a",
		ExternalUserID:         "user-a",
		ChatType:               "group",
		ThreadID:               "thread-a",
		AgentID:                "main",
		SessionKey:             "agent:main:wecom:group:chat-a:user-a",
	})
	if err != nil {
		t.Fatalf("get/create conversation: %v", err)
	}
	if err := st.BindACPSession(ctx, conv.ChannelAccountID, conv.SessionKey, "session-a"); err != nil {
		t.Fatalf("bind session: %v", err)
	}
	conv, err = st.GetOrCreateConversation(ctx, conv)
	if err != nil {
		t.Fatalf("reload conversation: %v", err)
	}
	if conv.ACPSessionID != "session-a" || conv.ChatType != "group" || conv.ThreadID != "thread-a" {
		t.Fatalf("unexpected conversation: %#v", conv)
	}
	inserted, err := st.InsertInboundMessage(ctx, MessageRecord{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalMessageID:      "msg-a",
		ExternalConversationID: "chat-a",
		Direction:              "inbound",
		PayloadJSON:            "{}",
	})
	if err != nil || !inserted {
		t.Fatalf("first insert inserted=%v err=%v", inserted, err)
	}
	inserted, err = st.InsertInboundMessage(ctx, MessageRecord{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalMessageID:      "msg-a",
		ExternalConversationID: "chat-a",
		Direction:              "inbound",
		PayloadJSON:            "{}",
	})
	if err != nil || inserted {
		t.Fatalf("duplicate insert inserted=%v err=%v", inserted, err)
	}
}
