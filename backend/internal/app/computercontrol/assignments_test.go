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
