package runtimesession

import (
	"context"
	"crypto/sha256"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/agentruntimecredential"
	runtimesessionport "chatserver/internal/ports/runtimesession"
)

const (
	sessionRepoServerID     = "01989c24-7540-7f12-a27b-c83243215dd3"
	sessionRepoAgentID      = "01989c24-7540-7f12-a27b-c83243215dd4"
	sessionRepoComputerID   = "01989c24-7540-7f12-a27b-c83243215dda"
	sessionRepoCredentialID = "01989c24-7540-7f12-a27b-c83243215ddb"
)

var sessionRepoNow = time.Date(2026, 7, 30, 21, 0, 0, 0, time.UTC)

func TestEntRepositoryReturnsAgentAndBoundComputerFacts(t *testing.T) {
	repository, handle := openSessionRepository(t)
	seedSessionFacts(t, handle, "active", 7, "running", "stopped", true)

	got, err := repository.FindCurrentAgent(
		context.Background(),
		sessionRepoServerID,
		sessionRepoAgentID,
		7,
	)
	if err != nil {
		t.Fatalf("FindCurrentAgent() error = %v", err)
	}
	if got.ID != sessionRepoAgentID ||
		got.ServerID != sessionRepoServerID ||
		got.IMUserID != "a_OPAQUE" ||
		got.IMState != "ready" ||
		got.ComputerID != sessionRepoComputerID ||
		!got.ComputerReady ||
		got.RuntimeKind != "codex" ||
		got.RuntimeModel != "default" ||
		got.ReplyPolicy != "mention_and_dm" ||
		got.DesiredState != "running" ||
		got.ObservedState != "stopped" ||
		got.CredentialVersion != 7 {
		t.Fatalf("FindCurrentAgent() = %#v", got)
	}

	usedAt := sessionRepoNow.Add(time.Minute)
	current, err := repository.MarkCredentialUsed(
		context.Background(),
		sessionRepoServerID,
		sessionRepoAgentID,
		7,
		usedAt,
	)
	if err != nil || !current {
		t.Fatalf("MarkCredentialUsed() = %v, %v", current, err)
	}
	credential, err := handle.Client().AgentRuntimeCredential.Query().
		Where(
			agentruntimecredential.IDEQ(sessionRepoCredentialID),
		).
		Only(context.Background())
	if err != nil || credential.LastUsedAt == nil ||
		!credential.LastUsedAt.Equal(usedAt) {
		t.Fatalf("credential lastUsedAt = %#v, %v", credential, err)
	}
	agentEntity, err := handle.Client().Agent.Query().
		Where(agent.IDEQ(sessionRepoAgentID)).
		Only(context.Background())
	if err != nil || agentEntity.HostLastSeenAt != nil {
		t.Fatalf("Agent hostLastSeenAt = %#v, %v", agentEntity, err)
	}
}

func TestEntRepositoryRejectsMissingRevokedOrOldCredential(t *testing.T) {
	tests := []struct {
		name            string
		credentialState string
		agentVersion    int64
		queryVersion    uint64
	}{
		{
			name:            "revoked",
			credentialState: "revoked",
			agentVersion:    7,
			queryVersion:    7,
		},
		{
			name:            "old version",
			credentialState: "active",
			agentVersion:    8,
			queryVersion:    7,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository, handle := openSessionRepository(t)
			seedSessionFacts(
				t,
				handle,
				test.credentialState,
				test.agentVersion,
				"running",
				"starting",
				true,
			)
			if _, err := repository.FindCurrentAgent(
				context.Background(),
				sessionRepoServerID,
				sessionRepoAgentID,
				test.queryVersion,
			); !errors.Is(err, runtimesessionport.ErrNotCurrent) {
				t.Fatalf("FindCurrentAgent() error = %v", err)
			}
		})
	}
}

func TestEntRepositoryFinalMarkRejectsLifecycleChange(t *testing.T) {
	repository, handle := openSessionRepository(t)
	seedSessionFacts(t, handle, "active", 7, "running", "starting", true)
	if _, err := repository.FindCurrentAgent(
		context.Background(),
		sessionRepoServerID,
		sessionRepoAgentID,
		7,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Update().
		Where(
			agent.IDEQ(sessionRepoAgentID),
			agent.ServerIDEQ(sessionRepoServerID),
		).
		SetDesiredState("stopped").
		SetObservedState("stopping").
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}

	current, err := repository.MarkCredentialUsed(
		context.Background(),
		sessionRepoServerID,
		sessionRepoAgentID,
		7,
		sessionRepoNow.Add(time.Minute),
	)
	if err != nil || current {
		t.Fatalf("MarkCredentialUsed(after stop) = %v, %v", current, err)
	}
}

func TestEntRepositoryReportsUnboundComputerWithoutHidingAgent(t *testing.T) {
	repository, handle := openSessionRepository(t)
	seedSessionFacts(t, handle, "active", 7, "running", "starting", false)

	got, err := repository.FindCurrentAgent(
		context.Background(),
		sessionRepoServerID,
		sessionRepoAgentID,
		7,
	)
	if err != nil {
		t.Fatal(err)
	}
	if got.ComputerReady {
		t.Fatalf("ComputerReady = true for unbound Computer: %#v", got)
	}
}

func openSessionRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	cfg, err := config.NewDatabase(
		filepath.Join(t.TempDir(), "data", "chatserver.db"),
	)
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

func seedSessionFacts(
	t *testing.T,
	handle *database.Handle,
	credentialState string,
	agentVersion int64,
	desiredState string,
	observedState string,
	boundComputer bool,
) {
	t.Helper()
	computerID := sessionRepoComputerID
	if !boundComputer {
		computerID = ""
	} else {
		_, err := handle.Client().Computer.Create().
			SetID(sessionRepoComputerID).
			SetServerID(sessionRepoServerID).
			SetName("测试执行机").
			SetTatRegion("ap-beijing").
			SetTatInstanceID("ins-test-only").
			SetTatInstanceKind("cvm").
			SetOsType("linux").
			SetLifecycleState("active").
			SetTatAgentState("online").
			SetRevision(1).
			SetCreatedAt(sessionRepoNow).
			SetUpdatedAt(sessionRepoNow).
			Save(context.Background())
		if err != nil {
			t.Fatal(err)
		}
	}
	builder := handle.Client().Agent.Create().
		SetID(sessionRepoAgentID).
		SetServerID(sessionRepoServerID).
		SetImUserID("a_OPAQUE").
		SetRuntimeKind("codex").
		SetRuntimeModel("default").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState(desiredState).
		SetObservedState(observedState).
		SetCredentialVersion(agentVersion).
		SetImState("ready").
		SetCreatedByMemberID("01989c24-7540-7f12-a27b-c83243215dd8").
		SetRevision(1).
		SetCreatedAt(sessionRepoNow).
		SetUpdatedAt(sessionRepoNow)
	if computerID != "" {
		builder.SetComputerID(computerID)
	}
	if _, err := builder.Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("test-only-credential"))
	credential := handle.Client().AgentRuntimeCredential.Create().
		SetID(sessionRepoCredentialID).
		SetServerID(sessionRepoServerID).
		SetAgentID(sessionRepoAgentID).
		SetVersion(7).
		SetSecretHash(digest[:]).
		SetState(credentialState).
		SetCreatedAt(sessionRepoNow)
	if credentialState == "revoked" {
		credential.SetRevokedAt(sessionRepoNow)
	}
	if _, err := credential.Save(context.Background()); err != nil {
		t.Fatal(err)
	}
}
