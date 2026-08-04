package runtimeauth

import (
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/agentruntimecredential"
	runtimeauthport "chatserver/internal/ports/runtimeauth"
)

const (
	runtimeRepoServerID     = "01989c24-7540-7f12-a27b-c83243215dd3"
	runtimeRepoOtherServer  = "01989c24-7540-7f12-a27b-c83243215dd5"
	runtimeRepoAgentID      = "01989c24-7540-7f12-a27b-c83243215dd4"
	runtimeRepoCredentialID = "01989c24-7540-7f12-a27b-c83243215dd6"
	runtimeRepoOtherAgent   = "01989c24-7540-7f12-a27b-c83243215dd9"
	runtimeRepoComputerID   = "01989c24-7540-7f12-a27b-c83243215dda"
	runtimeRepoEpoch        = "01989c24-7540-7f12-a27b-c83243215ddb"
	runtimeRepoLaunchID     = "01989c24-7540-7f12-a27b-c83243215ddc"
	runtimeRepoNextLaunchID = "01989c24-7540-7f12-a27b-c83243215ddd"
)

var runtimeRepoNow = time.Date(2026, 7, 30, 18, 0, 0, 0, time.UTC)

func TestEntRepositoryFindsOnlyExactCurrentRoute(t *testing.T) {
	repository, handle := openRuntimeRepository(t)
	digest := sha256.Sum256([]byte("test-only-agent-credential"))
	seedRuntimeAgent(t, handle, runtimeRepoServerID, runtimeRepoAgentID, 7, "running")
	seedRuntimeCredential(
		t,
		handle,
		runtimeRepoServerID,
		runtimeRepoAgentID,
		runtimeRepoCredentialID,
		7,
		"active",
		digest,
	)
	otherDigest := sha256.Sum256([]byte("other-shard-secret"))
	seedRuntimeAgent(
		t,
		handle,
		runtimeRepoOtherServer,
		runtimeRepoOtherAgent,
		7,
		"running",
	)
	seedRuntimeCredential(
		t,
		handle,
		runtimeRepoOtherServer,
		runtimeRepoOtherAgent,
		"01989c24-7540-7f12-a27b-c83243215dd7",
		7,
		"active",
		otherDigest,
	)
	route := runtimeauthport.Route{
		ServerID: runtimeRepoServerID,
		AgentID:  runtimeRepoAgentID,
		Version:  7,
	}

	got, err := repository.FindCurrent(context.Background(), route)
	if err != nil {
		t.Fatalf("FindCurrent() error = %v", err)
	}
	if got.Route != route || got.SecretDigest != digest {
		t.Fatalf("FindCurrent() = %#v", got)
	}
	confirmed, err := repository.ConfirmCurrent(context.Background(), route)
	if err != nil || !confirmed {
		t.Fatalf("ConfirmCurrent() = %v, %v", confirmed, err)
	}
}

func TestEntRepositoryRejectsNonCurrentCredentialAndAgentStates(t *testing.T) {
	tests := []struct {
		name             string
		credentialState  string
		credentialVer    int64
		agentVersion     int64
		agentDesired     string
		revokeCredential bool
		deleteAgent      bool
	}{
		{
			name:            "staged credential",
			credentialState: "staged",
			credentialVer:   7,
			agentVersion:    7,
			agentDesired:    "running",
		},
		{
			name:             "revoked credential",
			credentialState:  "revoked",
			credentialVer:    7,
			agentVersion:     7,
			agentDesired:     "running",
			revokeCredential: true,
		},
		{
			name:            "old version",
			credentialState: "active",
			credentialVer:   7,
			agentVersion:    8,
			agentDesired:    "running",
		},
		{
			name:            "agent stopped",
			credentialState: "active",
			credentialVer:   7,
			agentVersion:    7,
			agentDesired:    "stopped",
		},
		{
			name:            "agent deleted",
			credentialState: "active",
			credentialVer:   7,
			agentVersion:    7,
			agentDesired:    "running",
			deleteAgent:     true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository, handle := openRuntimeRepository(t)
			if !test.deleteAgent {
				seedRuntimeAgent(
					t,
					handle,
					runtimeRepoServerID,
					runtimeRepoAgentID,
					test.agentVersion,
					test.agentDesired,
				)
			}
			digest := sha256.Sum256([]byte("test-only-secret"))
			seedRuntimeCredential(
				t,
				handle,
				runtimeRepoServerID,
				runtimeRepoAgentID,
				runtimeRepoCredentialID,
				test.credentialVer,
				test.credentialState,
				digest,
			)
			if test.revokeCredential {
				if _, err := handle.Client().AgentRuntimeCredential.Update().
					Where(
						agentruntimecredential.IDEQ(runtimeRepoCredentialID),
					).
					SetRevokedAt(runtimeRepoNow).
					Save(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			route := runtimeauthport.Route{
				ServerID: runtimeRepoServerID,
				AgentID:  runtimeRepoAgentID,
				Version:  7,
			}
			if _, err := repository.FindCurrent(
				context.Background(),
				route,
			); !errors.Is(err, runtimeauthport.ErrCredentialNotCurrent) {
				t.Fatalf("FindCurrent() error = %v", err)
			}
			if current, err := repository.ConfirmCurrent(
				context.Background(),
				route,
			); err != nil || current {
				t.Fatalf("ConfirmCurrent() = %v, %v", current, err)
			}
		})
	}
}

func TestEntRepositoryConfirmationClosesRotationRace(t *testing.T) {
	repository, handle := openRuntimeRepository(t)
	digest := sha256.Sum256([]byte("old-secret"))
	seedRuntimeAgent(t, handle, runtimeRepoServerID, runtimeRepoAgentID, 7, "running")
	seedRuntimeCredential(
		t,
		handle,
		runtimeRepoServerID,
		runtimeRepoAgentID,
		runtimeRepoCredentialID,
		7,
		"active",
		digest,
	)
	route := runtimeauthport.Route{
		ServerID: runtimeRepoServerID,
		AgentID:  runtimeRepoAgentID,
		Version:  7,
	}
	if _, err := repository.FindCurrent(context.Background(), route); err != nil {
		t.Fatal(err)
	}

	if _, err := handle.Client().Agent.Update().
		Where(
			agent.IDEQ(runtimeRepoAgentID),
			agent.ServerIDEQ(runtimeRepoServerID),
		).
		SetCredentialVersion(8).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AgentRuntimeCredential.Update().
		Where(
			agentruntimecredential.ServerIDEQ(runtimeRepoServerID),
			agentruntimecredential.AgentIDEQ(runtimeRepoAgentID),
			agentruntimecredential.VersionEQ(7),
		).
		SetState("revoked").
		SetRevokedAt(runtimeRepoNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}

	current, err := repository.ConfirmCurrent(context.Background(), route)
	if err != nil || current {
		t.Fatalf("ConfirmCurrent(after rotation) = %v, %v", current, err)
	}
}

func TestEntRepositoryConfirmsOnlyExactCurrentLaunch(t *testing.T) {
	repository, handle := openRuntimeRepository(t)
	seedRuntimeLaunch(t, handle, runtimeRepoLaunchID)
	route := runtimeauthport.LaunchRoute{
		ServerID:          runtimeRepoServerID,
		ComputerID:        runtimeRepoComputerID,
		AgentID:           runtimeRepoAgentID,
		LaunchID:          runtimeRepoLaunchID,
		AssignmentEpoch:   runtimeRepoEpoch,
		ConfigGeneration:  3,
		CredentialVersion: 7,
		Attempt:           1,
	}

	current, err := repository.ConfirmCurrentLaunch(context.Background(), route)
	if err != nil || !current {
		t.Fatalf("ConfirmCurrentLaunch(current) = %v, %v", current, err)
	}
	if _, err := handle.Client().Agent.Update().
		Where(
			agent.ServerIDEQ(runtimeRepoServerID),
			agent.IDEQ(runtimeRepoAgentID),
		).
		SetCurrentLaunchID(runtimeRepoNextLaunchID).
		SetCurrentLaunchAttempt(2).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}

	current, err = repository.ConfirmCurrentLaunch(context.Background(), route)
	if err != nil || current {
		t.Fatalf("ConfirmCurrentLaunch(replaced) = %v, %v", current, err)
	}
}

func TestEntRepositoryRejectsInvalidOrUnrepresentableRoute(t *testing.T) {
	repository, _ := openRuntimeRepository(t)
	for _, route := range []runtimeauthport.Route{
		{},
		{
			ServerID: runtimeRepoServerID,
			AgentID:  runtimeRepoAgentID,
			Version:  0,
		},
		{
			ServerID: runtimeRepoServerID,
			AgentID:  runtimeRepoAgentID,
			Version:  math.MaxUint64,
		},
	} {
		if _, err := repository.FindCurrent(
			context.Background(),
			route,
		); !errors.Is(err, runtimeauthport.ErrInvalidRoute) {
			t.Fatalf("FindCurrent(%#v) error = %v", route, err)
		}
	}
}

func openRuntimeRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "data", "chatserver.db")
	cfg, err := config.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := handle.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	if err := migration.Apply(context.Background(), handle.SQLDB()); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func seedRuntimeAgent(
	t *testing.T,
	handle *database.Handle,
	serverID string,
	agentID string,
	version int64,
	desired string,
) {
	t.Helper()
	_, err := handle.Client().Agent.Create().
		SetID(agentID).
		SetServerID(serverID).
		SetImUserID("a_test_runtime_agent").
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState(desired).
		SetObservedState("starting").
		SetCredentialVersion(version).
		SetImState("ready").
		SetCreatedByMemberID("01989c24-7540-7f12-a27b-c83243215dd8").
		SetRevision(1).
		SetCreatedAt(runtimeRepoNow).
		SetUpdatedAt(runtimeRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}

func seedRuntimeCredential(
	t *testing.T,
	handle *database.Handle,
	serverID string,
	agentID string,
	credentialID string,
	version int64,
	state string,
	digest [32]byte,
) {
	t.Helper()
	_, err := handle.Client().AgentRuntimeCredential.Create().
		SetID(credentialID).
		SetServerID(serverID).
		SetAgentID(agentID).
		SetVersion(version).
		SetSecretHash(digest[:]).
		SetState(state).
		SetCreatedAt(runtimeRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}

func seedRuntimeLaunch(t *testing.T, handle *database.Handle, launchID string) {
	t.Helper()
	_, err := handle.Client().Computer.Create().
		SetID(runtimeRepoComputerID).
		SetServerID(runtimeRepoServerID).
		SetName("Runtime 鉴权执行机").
		SetTatRegion("ap-beijing").
		SetTatInstanceID("ins-runtime-auth").
		SetTatInstanceKind("cvm").
		SetOsType("linux").
		SetLifecycleState("active").
		SetTatAgentState("online").
		SetAssignmentEpoch(runtimeRepoEpoch).
		SetRevision(1).
		SetCreatedAt(runtimeRepoNow).
		SetUpdatedAt(runtimeRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	seedRuntimeAgent(t, handle, runtimeRepoServerID, runtimeRepoAgentID, 7, "running")
	if _, err := handle.Client().Agent.Update().
		Where(
			agent.ServerIDEQ(runtimeRepoServerID),
			agent.IDEQ(runtimeRepoAgentID),
		).
		SetComputerID(runtimeRepoComputerID).
		SetRevision(3).
		SetCurrentLaunchID(launchID).
		SetCurrentLaunchAssignmentEpoch(runtimeRepoEpoch).
		SetCurrentLaunchGeneration(3).
		SetCurrentLaunchCredentialVersion(7).
		SetCurrentLaunchAttempt(1).
		SetCurrentLaunchUpdatedAt(runtimeRepoNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("test-only-launch-secret"))
	seedRuntimeCredential(
		t,
		handle,
		runtimeRepoServerID,
		runtimeRepoAgentID,
		runtimeRepoCredentialID,
		7,
		"active",
		digest,
	)
}
