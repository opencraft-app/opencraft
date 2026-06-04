package store

import (
	"context"
	"errors"
	"strings"
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

func TestNormalizeDriverAndDSNSupportsMySQL(t *testing.T) {
	driver, dsn, err := normalizeDriverAndDSN("", "root:pass@tcp(9.135.107.6:3306)/channelgateway")
	if err != nil {
		t.Fatalf("normalize tcp dsn: %v", err)
	}
	if driver != dialectMySQL || !strings.Contains(dsn, "parseTime=true") {
		t.Fatalf("unexpected normalized mysql dsn: driver=%s dsn=%s", driver, dsn)
	}
	driver, dsn, err = normalizeDriverAndDSN("mysql", "mysql://root:pass@9.135.107.6:3306/channelgateway?charset=utf8mb4")
	if err != nil {
		t.Fatalf("normalize mysql url: %v", err)
	}
	if driver != dialectMySQL || !strings.HasPrefix(dsn, "root:pass@tcp(9.135.107.6:3306)/channelgateway?") || !strings.Contains(dsn, "charset=utf8mb4") || !strings.Contains(dsn, "parseTime=true") {
		t.Fatalf("unexpected normalized mysql url: driver=%s dsn=%s", driver, dsn)
	}
}

func TestSplitSQLStatementsForMySQLMigrations(t *testing.T) {
	statements := splitSQLStatements("CREATE TABLE a (id INT); \n CREATE TABLE b (id INT);")
	if len(statements) != 2 || !strings.HasPrefix(statements[0], "CREATE TABLE a") || !strings.HasPrefix(statements[1], "CREATE TABLE b") {
		t.Fatalf("unexpected statements: %#v", statements)
	}
}

func TestListActiveChannelAccountsFiltersByTypeAndStatus(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	for _, account := range []ChannelAccount{
		{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "agent-a", ConfigJSON: "{}", Status: "active"},
		{ChannelAccountID: "wecom-b", ChannelType: "wecom", AgentID: "agent-b", ConfigJSON: "{}", Status: "disabled"},
		{ChannelAccountID: "other-a", ChannelType: "other", AgentID: "agent-c", ConfigJSON: "{}", Status: "active"},
	} {
		if err := st.UpsertChannelAccount(ctx, account); err != nil {
			t.Fatalf("upsert account %s: %v", account.ChannelAccountID, err)
		}
	}
	accounts, err := st.ListActiveChannelAccounts(ctx, "wecom")
	if err != nil {
		t.Fatalf("list active accounts: %v", err)
	}
	if len(accounts) != 1 || accounts[0].ChannelAccountID != "wecom-a" {
		t.Fatalf("unexpected accounts: %#v", accounts)
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

func TestStoreInboundClaimIsFencedAcrossSharedDBConnections(t *testing.T) {
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
	if _, err := first.InsertInboundMessage(ctx, MessageRecord{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalMessageID:      "msg-a",
		ExternalConversationID: "chat-a",
		Direction:              "inbound",
		PayloadJSON:            `{"Text":"hello"}`,
	}); err != nil {
		t.Fatalf("insert inbound: %v", err)
	}
	claimedA, ok, err := first.ClaimInboundMessage(ctx, leaseA, "msg-a", time.Minute)
	if err != nil || !ok {
		t.Fatalf("owner-a claim ok=%v err=%v", ok, err)
	}
	if _, err := first.db.ExecContext(ctx, `UPDATE channel_messages SET claimed_at = ? WHERE message_id = ?`, time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), claimedA.MessageID); err != nil {
		t.Fatalf("age inbound claim: %v", err)
	}
	if err := first.ReleaseChannelLease(ctx, leaseA); err != nil {
		t.Fatalf("release owner-a lease: %v", err)
	}
	leaseB, err := second.AcquireChannelLease(ctx, "wecom-a", "owner-b", time.Minute)
	if err != nil {
		t.Fatalf("acquire owner-b lease: %v", err)
	}
	claimedB, ok, err := second.ClaimInboundMessage(ctx, leaseB, "msg-a", time.Nanosecond)
	if err != nil || !ok {
		t.Fatalf("owner-b reclaim ok=%v err=%v", ok, err)
	}
	if claimedB.MessageID != claimedA.MessageID {
		t.Fatalf("unexpected reclaimed message: %#v", claimedB)
	}
	if err := first.MarkInboundMessageDone(ctx, leaseA, claimedA.MessageID, "session-old"); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("old owner must not finish reclaimed inbound, got %v", err)
	}
	if err := second.MarkInboundMessageDone(ctx, leaseB, claimedB.MessageID, "session-new"); err != nil {
		t.Fatalf("new owner should finish reclaimed inbound: %v", err)
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
	bySession, ok, err := st.FindConversationByACPSession(ctx, "wecom-a", "session-a")
	if err != nil || !ok {
		t.Fatalf("find conversation by acp session ok=%v err=%v", ok, err)
	}
	if bySession.ConversationID != conv.ConversationID || bySession.ExternalConversationID != "chat-a" {
		t.Fatalf("unexpected conversation by acp session: %#v", bySession)
	}
	if _, ok, err := st.FindConversationByACPSession(ctx, "wecom-a", "session-missing"); err != nil || ok {
		t.Fatalf("missing acp session should not resolve ok=%v err=%v", ok, err)
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
