package computercontrol

import (
	"context"
	"testing"
	"time"

	computercontrolport "chatserver/internal/ports/computercontrol"
)

type fakeObservationRepository struct {
	observation computercontrolport.Observation
	heartbeat   computercontrolport.Heartbeat
	result      computercontrolport.ObservationResult
	err         error
}

func (repository *fakeObservationRepository) PutObservation(
	_ context.Context,
	value computercontrolport.Observation,
) (computercontrolport.ObservationResult, error) {
	repository.observation = value
	return repository.result, repository.err
}

func (repository *fakeObservationRepository) ApplyHeartbeat(
	_ context.Context,
	value computercontrolport.Heartbeat,
) error {
	repository.heartbeat = value
	return repository.err
}

func TestObservationServiceHashesReceiptAndAppliesHeartbeat(t *testing.T) {
	repository := &fakeObservationRepository{result: computercontrolport.ObservationResult{
		Accepted: false, Reason: "stale_launch", CurrentAttempt: 3, CurrentSequence: 8,
	}}
	service, err := NewObservationService(
		repository,
		fixedClock{now: controlNow},
		ObservationConfig{MaximumClockSkew: 5 * time.Minute},
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Put(
		context.Background(),
		controlServerID,
		controlComputerID,
		"01989c24-7540-7f12-a27b-c83243215dd8",
		"01989c24-7540-7f12-a27b-c83243215dd9",
		ObservationRequest{
			AssignmentEpoch: controlEpoch, AssignmentRevision: 7,
			ConfigGeneration: 6, CredentialVersion: 2, Attempt: 3, Sequence: 9,
			LaunchID: "01989c24-7540-7f12-a27b-c83243215dda",
			State:    "running", IMTransportState: "connected",
			ObservedAt: controlNow.Add(-time.Second),
		},
	)
	if err != nil || result.Accepted || result.Reason != "stale_launch" {
		t.Fatalf("Put() = %#v, %v", result, err)
	}
	if repository.observation.ID == "" ||
		repository.observation.ReceivedAt != controlNow ||
		repository.observation.RequestHash == ([32]byte{}) {
		t.Fatalf("observation = %#v", repository.observation)
	}
	err = service.Heartbeat(
		context.Background(),
		controlServerID,
		controlComputerID,
		HeartbeatRequest{
			ID:            "01989c24-7540-7f12-a27b-c83243215ddb",
			DaemonVersion: "1.0.0", DaemonBuildID: "build-test",
			AssignmentEpoch:    controlEpoch,
			AssignmentRevision: 7, TATState: "online",
			ReconcileState: "healthy",
			Agents: []HeartbeatAgent{{
				AgentID:         "01989c24-7540-7f12-a27b-c83243215dd8",
				AssignmentEpoch: controlEpoch, ConfigGeneration: 6,
				CredentialVersion: 2, Attempt: 3,
				LaunchID: "01989c24-7540-7f12-a27b-c83243215dda",
			}},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if repository.heartbeat.ID == "" ||
		repository.heartbeat.ReceivedAt != controlNow ||
		len(repository.heartbeat.Agents) != 1 {
		t.Fatalf("heartbeat = %#v", repository.heartbeat)
	}
}
