package computercontrol

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"

	computercontrolport "chatserver/internal/ports/computercontrol"
)

type fakeAssignmentRepository struct {
	snapshot  computercontrolport.AssignmentSnapshot
	snapshots []computercontrolport.AssignmentSnapshot
	err       error
	args      []string
	calls     int
}

func (repository *fakeAssignmentRepository) GetAssignmentSnapshot(
	_ context.Context,
	serverID string,
	computerID string,
) (computercontrolport.AssignmentSnapshot, error) {
	repository.args = []string{serverID, computerID}
	repository.calls++
	if len(repository.snapshots) > 0 {
		index := repository.calls - 1
		if index >= len(repository.snapshots) {
			index = len(repository.snapshots) - 1
		}
		return repository.snapshots[index], repository.err
	}
	return repository.snapshot, repository.err
}

func TestAssignmentServiceReturnsCanonicalFullSnapshotAndNoChange(t *testing.T) {
	repository := &fakeAssignmentRepository{snapshot: computercontrolport.AssignmentSnapshot{
		ComputerID: "01989c24-7540-7f12-a27b-c83243215dd5",
		Epoch:      "01989c24-7540-7f12-a27b-c83243215dd7",
		Revision:   4,
		Agents: []computercontrolport.Assignment{{
			AgentID:           "01989c24-7540-7f12-a27b-c83243215dd8",
			ServerID:          "01989c24-7540-7f12-a27b-c83243215dd3",
			DesiredState:      "running",
			ConfigGeneration:  6,
			CredentialVersion: 2,
			RuntimeKind:       "codex",
			ReplyPolicy:       "mention_and_dm",
		}},
	}}
	service, err := NewAssignmentService(repository)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Get(
		context.Background(),
		"01989c24-7540-7f12-a27b-c83243215dd3",
		"01989c24-7540-7f12-a27b-c83243215dd5",
		AssignmentQuery{ForceFull: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.NoChange || result.Snapshot == nil || result.Revision != 4 {
		t.Fatalf("full result = %#v", result)
	}
	canonical := `{"agents":[{"agentId":"01989c24-7540-7f12-a27b-c83243215dd8","configGeneration":6,"credentialVersion":2,"currentLaunch":null,"desiredState":"running","replyPolicy":"mention_and_dm","runtime":{"kind":"codex","model":null},"serverId":"01989c24-7540-7f12-a27b-c83243215dd3"}],"computerId":"01989c24-7540-7f12-a27b-c83243215dd5","epoch":"01989c24-7540-7f12-a27b-c83243215dd7","revision":4,"schemaVersion":1}`
	digest := sha256.Sum256([]byte(canonical))
	wantHash := base64.RawURLEncoding.EncodeToString(digest[:])
	if result.Snapshot.SnapshotHash != wantHash {
		t.Fatalf("snapshot hash = %q, want %q", result.Snapshot.SnapshotHash, wantHash)
	}
	result, err = service.Get(
		context.Background(),
		"01989c24-7540-7f12-a27b-c83243215dd3",
		"01989c24-7540-7f12-a27b-c83243215dd5",
		AssignmentQuery{
			SinceEpoch:    repository.snapshot.Epoch,
			SinceRevision: 4,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.NoChange || result.Snapshot != nil || result.Revision != 4 {
		t.Fatalf("no-change result = %#v", result)
	}
}

func TestAssignmentServiceReturnsCanonicalV2CapabilityCommand(t *testing.T) {
	requestedAt := time.Date(2026, 8, 17, 20, 0, 0, 0, time.UTC)
	repository := &fakeAssignmentRepository{snapshot: computercontrolport.AssignmentSnapshot{
		ComputerID: "01989c24-7540-7f12-a27b-c83243215dd5",
		Epoch:      "01989c24-7540-7f12-a27b-c83243215dd7",
		Revision:   5,
		Agents: []computercontrolport.Assignment{{
			AgentID:           "01989c24-7540-7f12-a27b-c83243215dd8",
			ServerID:          "01989c24-7540-7f12-a27b-c83243215dd3",
			DesiredState:      "stopped",
			ConfigGeneration:  7,
			CredentialVersion: 2,
			RuntimeKind:       "codex",
			ReplyPolicy:       "mention_and_dm",
			ProfileCapabilityRefresh: &computercontrolport.ProfileCapabilityRefresh{
				RefreshID:             "01989c24-7540-7f12-a27b-c83243215dd9",
				ContextGeneration:     7,
				AuthorityContextKey:   "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				RuntimeKind:           "codex",
				InvalidationWatermark: 3,
				ForceReload:           true,
				RequestedAt:           requestedAt,
			},
		}},
	}}
	service, err := NewAssignmentService(repository)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Get(
		context.Background(),
		"01989c24-7540-7f12-a27b-c83243215dd3",
		repository.snapshot.ComputerID,
		AssignmentQuery{SchemaVersion: 2, ForceFull: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	canonical := `{"agents":[{"agentId":"01989c24-7540-7f12-a27b-c83243215dd8","configGeneration":7,"credentialVersion":2,"currentLaunch":null,"desiredState":"stopped","profileCapabilityRefresh":{"authorityContextKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","contextGeneration":7,"forceReload":true,"invalidationWatermark":3,"refreshId":"01989c24-7540-7f12-a27b-c83243215dd9","requestedAt":"2026-08-17T20:00:00Z","runtimeKind":"codex","schemaVersion":1},"replyPolicy":"mention_and_dm","runtime":{"kind":"codex","model":null},"serverId":"01989c24-7540-7f12-a27b-c83243215dd3"}],"computerId":"01989c24-7540-7f12-a27b-c83243215dd5","epoch":"01989c24-7540-7f12-a27b-c83243215dd7","revision":5,"schemaVersion":2}`
	digest := sha256.Sum256([]byte(canonical))
	wantHash := base64.RawURLEncoding.EncodeToString(digest[:])
	if result.Snapshot == nil || result.Snapshot.SchemaVersion != 2 ||
		result.Snapshot.SnapshotHash != wantHash {
		t.Fatalf("v2 snapshot = %#v, want hash %q", result.Snapshot, wantHash)
	}
}

func TestAssignmentServiceLongPollReturnsChangedSnapshot(t *testing.T) {
	first := computercontrolport.AssignmentSnapshot{
		ComputerID: "01989c24-7540-7f12-a27b-c83243215dd5",
		Epoch:      "01989c24-7540-7f12-a27b-c83243215dd7",
		Revision:   4,
	}
	second := first
	second.Revision = 5
	repository := &fakeAssignmentRepository{
		snapshots: []computercontrolport.AssignmentSnapshot{first, second},
	}
	service, err := NewAssignmentService(repository)
	if err != nil {
		t.Fatal(err)
	}
	service.pollInterval = time.Millisecond
	result, err := service.Get(
		context.Background(),
		"01989c24-7540-7f12-a27b-c83243215dd3",
		first.ComputerID,
		AssignmentQuery{
			SinceEpoch: first.Epoch, SinceRevision: 4, WaitSeconds: 1,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.NoChange || result.Snapshot == nil || result.Revision != 5 ||
		repository.calls != 2 {
		t.Fatalf("long poll result=%#v calls=%d", result, repository.calls)
	}
}
