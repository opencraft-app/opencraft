package agentpresence

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/agent"
	agentpresenceport "chatserver/internal/ports/agentpresence"
)

const (
	presenceServerID = "01989c24-7540-7f12-a27b-c83243215e01"
	presenceAgentID  = "01989c24-7540-7f12-a27b-c83243215e02"
	presenceIMUserID = "a_TEST_PRESENCE_ROUTE"
)

var presenceNow = time.Date(2026, 7, 31, 18, 0, 0, 0, time.UTC)

func TestRepository只按全局IM路由应用较新的在线事实(t *testing.T) {
	repository, handle := openPresenceRepository(t)
	seedPresenceAgent(t, handle)
	changed, err := repository.ApplyIMPresence(context.Background(), agentpresenceport.IMObservation{
		IMUserID: presenceIMUserID, Presence: "online", ObservedAt: presenceNow, Reason: "Register",
	})
	if err != nil || !changed {
		t.Fatalf("ApplyIMPresence() = %v, %v", changed, err)
	}
	entity, err := handle.Client().Agent.Query().Where(agent.IDEQ(presenceAgentID)).Only(context.Background())
	if err != nil || entity.ImPresence != "online" || entity.ImPresenceUpdatedAt == nil ||
		!entity.ImPresenceUpdatedAt.Equal(presenceNow) {
		t.Fatalf("Agent presence = %#v, %v", entity, err)
	}
	changed, err = repository.ApplyIMPresence(context.Background(), agentpresenceport.IMObservation{
		IMUserID: presenceIMUserID, Presence: "offline", ObservedAt: presenceNow.Add(-time.Second), Reason: "TimeOut",
	})
	if err != nil || changed {
		t.Fatalf("旧事实不应覆盖新事实 = %v, %v", changed, err)
	}
}

func openPresenceRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	cfg, err := config.NewDatabase(filepath.Join(t.TempDir(), "data", "chatserver.db"))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	if err := migration.Apply(context.Background(), handle.SQLDB()); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func seedPresenceAgent(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Agent.Create().
		SetID(presenceAgentID).SetServerID(presenceServerID).SetImUserID(presenceIMUserID).
		SetRuntimeKind("codex").SetReplyPolicy("mention_and_dm").SetDesiredState("running").
		SetObservedState("running").SetCredentialVersion(7).SetImState("ready").SetImPresence("unknown").
		SetCreatedByMemberID("01989c24-7540-7f12-a27b-c83243215e05").SetRevision(7).
		SetCreatedAt(presenceNow.Add(-time.Hour)).SetUpdatedAt(presenceNow.Add(-time.Hour)).Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AgentIMRoute.Create().
		SetID(presenceAgentID).SetImUserID(presenceIMUserID).SetServerID(presenceServerID).
		SetAgentID(presenceAgentID).SetState("active").SetCreatedAt(presenceNow.Add(-time.Hour)).
		SetUpdatedAt(presenceNow.Add(-time.Hour)).Save(ctx); err != nil {
		t.Fatal(err)
	}
}
