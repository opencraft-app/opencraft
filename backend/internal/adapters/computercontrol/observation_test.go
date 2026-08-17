package computercontrol

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/computeragentobservation"
	computercontrolport "chatserver/internal/ports/computercontrol"
)

const (
	controlObservationOldLaunch = "01989c24-7540-7f12-a27b-c83243215ddb"
	controlObservationNewLaunch = "01989c24-7540-7f12-a27b-c83243215ddc"
	controlObservationID        = "01989c24-7540-7f12-a27b-c83243215ddd"
	controlHeartbeatID          = "01989c24-7540-7f12-a27b-c83243215dde"
)

func TestEntRepositoryAppliesMonotonicObservationAndHeartbeat(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	_, err := handle.Client().Agent.Create().
		SetID(controlRepoAgentID).
		SetServerID(controlRepoServerID).
		SetImUserID("a_control").
		SetComputerID(controlRepoComputerID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("running").
		SetObservedState("starting").
		SetCredentialVersion(2).
		SetImState("ready").
		SetObservedAssignmentEpoch(controlRepoEpoch).
		SetObservedGeneration(6).
		SetObservedAttempt(2).
		SetObservedSequence(3).
		SetObservedLaunchID(controlObservationOldLaunch).
		SetCurrentLaunchID(controlObservationOldLaunch).
		SetCurrentLaunchAssignmentEpoch(controlRepoEpoch).
		SetCurrentLaunchGeneration(6).
		SetCurrentLaunchCredentialVersion(2).
		SetCurrentLaunchAttempt(2).
		SetCurrentLaunchUpdatedAt(controlRepoNow).
		SetCreatedByMemberID(controlRepoMemberID).
		SetRevision(6).
		SetCreatedAt(controlRepoNow).
		SetUpdatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	staleHash := sha256.Sum256([]byte("stale"))
	stale, err := repository.PutObservation(
		context.Background(),
		computercontrolport.Observation{
			ID: controlObservationID, ServerID: controlRepoServerID,
			ComputerID: controlRepoComputerID, AgentID: controlRepoAgentID,
			AssignmentEpoch: controlRepoEpoch, AssignmentRevision: 4,
			ConfigGeneration: 6, CredentialVersion: 2, Attempt: 1, Sequence: 9,
			LaunchID: controlObservationNewLaunch, State: "running",
			IMTransportState: "connected",
			RequestHash:      staleHash, ObservedAt: controlRepoNow,
			ReceivedAt: controlRepoNow,
		},
	)
	if err != nil || stale.Accepted || stale.Reason != "stale_launch" ||
		stale.CurrentAttempt != 2 || stale.CurrentSequence != 3 ||
		stale.CurrentLaunchID == nil || *stale.CurrentLaunchID != controlObservationOldLaunch {
		t.Fatalf("stale observation = %#v, %v", stale, err)
	}
	acceptedID := "01989c24-7540-7f12-a27b-c83243215ddf"
	acceptedHash := sha256.Sum256([]byte("accepted"))
	accepted, err := repository.PutObservation(
		context.Background(),
		computercontrolport.Observation{
			ID: acceptedID, ServerID: controlRepoServerID,
			ComputerID: controlRepoComputerID, AgentID: controlRepoAgentID,
			AssignmentEpoch: controlRepoEpoch, AssignmentRevision: 4,
			ConfigGeneration: 6, CredentialVersion: 2, Attempt: 2, Sequence: 4,
			LaunchID: controlObservationOldLaunch, State: "running",
			IMTransportState: "connected",
			RequestHash:      acceptedHash, ObservedAt: controlRepoNow.Add(1),
			ReceivedAt: controlRepoNow.Add(1),
		},
	)
	if err != nil || !accepted.Accepted || accepted.Reason != "accepted" {
		t.Fatalf("accepted observation = %#v, %v", accepted, err)
	}
	entity, err := handle.Client().Agent.Query().Where(agent.IDEQ(controlRepoAgentID)).Only(context.Background())
	if err != nil || entity.ObservedAttempt != 2 || entity.ObservedSequence != 4 ||
		entity.ObservedLaunchID == nil || *entity.ObservedLaunchID != controlObservationOldLaunch ||
		entity.ObservedState != "running" || entity.LastObservedAt == nil {
		t.Fatalf("observed Agent = %#v, %v", entity, err)
	}
	count, err := handle.Client().ComputerAgentObservation.Query().Where(
		computeragentobservation.ServerIDEQ(controlRepoServerID),
	).Count(context.Background())
	if err != nil || count != 2 {
		t.Fatalf("observation count = %d, %v", count, err)
	}
	if err := repository.ApplyHeartbeat(context.Background(), computercontrolport.Heartbeat{
		ID: controlHeartbeatID, ServerID: controlRepoServerID,
		ComputerID: controlRepoComputerID, AssignmentEpoch: controlRepoEpoch,
		AssignmentRevision: 4, DaemonVersion: "1.0.0", DaemonBuildID: "build-test",
		AssignmentVersion: 2, ProfileCapabilityVersions: []int{1},
		TATState:       "online",
		ReconcileState: "healthy", Agents: []computercontrolport.HeartbeatAgent{{
			AgentID: controlRepoAgentID, AssignmentEpoch: controlRepoEpoch,
			ConfigGeneration: 6, CredentialVersion: 2,
			Attempt: 2, LaunchID: controlObservationOldLaunch,
		}}, ReceivedAt: controlRepoNow.Add(2),
	}); err != nil {
		t.Fatal(err)
	}
	entity, err = handle.Client().Agent.Get(context.Background(), controlRepoAgentID)
	if err != nil || entity.HostLastSeenAt == nil || !entity.HostLastSeenAt.Equal(controlRepoNow.Add(2)) {
		t.Fatalf("heartbeat Agent = %#v, %v", entity, err)
	}
	machine, err := handle.Client().Computer.Get(context.Background(), controlRepoComputerID)
	if err != nil || machine.HostLastSeenAt == nil ||
		machine.DaemonVersion == nil || *machine.DaemonVersion != "1.0.0" ||
		machine.AssignmentProtocolVersion != 2 ||
		machine.ProfileCapabilityVersion == nil || *machine.ProfileCapabilityVersion != 1 ||
		machine.TatAgentState != "online" {
		t.Fatalf("heartbeat Computer = %#v, %v", machine, err)
	}
}

func TestEntRepositoryRejectsObservationIdempotencyConflict(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	first := sha256.Sum256([]byte("one"))
	_, err := handle.Client().ComputerAgentObservation.Create().
		SetID(controlObservationID).
		SetServerID(controlRepoServerID).
		SetComputerID(controlRepoComputerID).
		SetAgentID(controlRepoAgentID).
		SetAssignmentEpoch(controlRepoEpoch).
		SetAssignmentRevision(4).
		SetConfigGeneration(1).
		SetCredentialVersion(1).
		SetAttempt(1).
		SetSequence(1).
		SetLaunchID(controlObservationOldLaunch).
		SetState("starting").
		SetImTransportState("unknown").
		SetRequestHash(first[:]).
		SetObservedAt(controlRepoNow).
		SetCreatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second := sha256.Sum256([]byte("two"))
	_, err = repository.PutObservation(context.Background(), computercontrolport.Observation{
		ID: controlObservationID, ServerID: controlRepoServerID,
		ComputerID: controlRepoComputerID, AgentID: controlRepoAgentID,
		AssignmentEpoch: controlRepoEpoch, AssignmentRevision: 4,
		ConfigGeneration: 1, CredentialVersion: 1, Attempt: 1, Sequence: 1,
		LaunchID: controlObservationOldLaunch, State: "starting",
		IMTransportState: "unknown",
		RequestHash:      second, ObservedAt: controlRepoNow, ReceivedAt: controlRepoNow,
	})
	if !errors.Is(err, computercontrolport.ErrObservationConflict) {
		t.Fatalf("PutObservation() error = %v", err)
	}
}

func TestEntRepositoryRejectsUnallocatedHigherAttemptObservation(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	_, err := handle.Client().Agent.Create().
		SetID(controlRepoAgentID).
		SetServerID(controlRepoServerID).
		SetImUserID("a_control_fenced").
		SetComputerID(controlRepoComputerID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("running").
		SetObservedState("running").
		SetCredentialVersion(2).
		SetImState("ready").
		SetObservedAssignmentEpoch(controlRepoEpoch).
		SetObservedGeneration(6).
		SetObservedAttempt(2).
		SetObservedSequence(3).
		SetObservedLaunchID(controlObservationOldLaunch).
		SetCurrentLaunchID(controlObservationOldLaunch).
		SetCurrentLaunchAssignmentEpoch(controlRepoEpoch).
		SetCurrentLaunchGeneration(6).
		SetCurrentLaunchCredentialVersion(2).
		SetCurrentLaunchAttempt(2).
		SetCurrentLaunchUpdatedAt(controlRepoNow).
		SetCreatedByMemberID(controlRepoMemberID).
		SetRevision(6).
		SetCreatedAt(controlRepoNow).
		SetUpdatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("unallocated-higher-attempt"))
	result, err := repository.PutObservation(
		context.Background(),
		computercontrolport.Observation{
			ID: controlObservationID, ServerID: controlRepoServerID,
			ComputerID: controlRepoComputerID, AgentID: controlRepoAgentID,
			AssignmentEpoch: controlRepoEpoch, AssignmentRevision: 4,
			ConfigGeneration: 6, CredentialVersion: 2, Attempt: 3, Sequence: 1,
			LaunchID: controlObservationNewLaunch, State: "running",
			IMTransportState: "connected",
			RequestHash:      hash, ObservedAt: controlRepoNow.Add(time.Second),
			ReceivedAt: controlRepoNow.Add(time.Second),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Accepted || result.Reason != "stale_launch" {
		t.Fatalf("unallocated observation accepted = %#v", result)
	}
	entity, err := handle.Client().Agent.Get(context.Background(), controlRepoAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if entity.ObservedAttempt != 2 || entity.ObservedSequence != 3 ||
		entity.ObservedLaunchID == nil || *entity.ObservedLaunchID != controlObservationOldLaunch {
		t.Fatalf("Agent projection changed = %#v", entity)
	}
}

func TestEntRepositoryAppliesExactCurrentLaunchAndTransportObservation(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	seedControlRunningAgent(t, handle)
	launchID := controlObservationNewLaunch
	issuedAt := controlRepoNow.Add(time.Minute)
	allocation, err := repository.AllocateAgentLaunch(
		context.Background(),
		computercontrolport.AgentLaunchRequest{
			ServerID: controlRepoServerID, ComputerID: controlRepoComputerID,
			ComputerCredentialVersion: 1,
			AgentID:                   controlRepoAgentID, LaunchID: launchID,
			AssignmentEpoch: controlRepoEpoch, AssignmentRevision: 4,
			ConfigGeneration: 6, CredentialVersion: 2, RequestedAt: issuedAt,
		},
	)
	if err != nil || !allocation.Created {
		t.Fatalf("AllocateAgentLaunch() = %#v, %v", allocation, err)
	}
	hash := sha256.Sum256([]byte("current-connected"))
	result, err := repository.PutObservation(
		context.Background(),
		computercontrolport.Observation{
			ID: controlObservationID, ServerID: controlRepoServerID,
			ComputerID: controlRepoComputerID, AgentID: controlRepoAgentID,
			AssignmentEpoch: controlRepoEpoch, ConfigGeneration: 6,
			CredentialVersion: 2, Attempt: allocation.Fence.Attempt, Sequence: 1,
			LaunchID: launchID, State: "running", IMTransportState: "connected",
			RequestHash: hash, ObservedAt: issuedAt.Add(time.Second),
			ReceivedAt: issuedAt.Add(time.Second),
		},
	)
	if err != nil || !result.Accepted || result.Reason != "accepted" {
		t.Fatalf("PutObservation() = %#v, %v", result, err)
	}
	entity, err := handle.Client().Agent.Get(context.Background(), controlRepoAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if entity.ObservedState != "running" || entity.ImTransportState != "connected" ||
		entity.ImTransportUpdatedAt == nil || !entity.ImTransportUpdatedAt.Equal(issuedAt.Add(time.Second)) {
		t.Fatalf("Agent projection = %#v", entity)
	}
}

func TestHeartbeatRenewsOnlyExactCurrentLaunchBeforeFirstObservation(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	seedControlRunningAgent(t, handle)
	launchID := controlObservationNewLaunch
	allocation, err := repository.AllocateAgentLaunch(
		context.Background(),
		computercontrolport.AgentLaunchRequest{
			ServerID: controlRepoServerID, ComputerID: controlRepoComputerID,
			ComputerCredentialVersion: 1,
			AgentID:                   controlRepoAgentID, LaunchID: launchID,
			AssignmentEpoch: controlRepoEpoch, AssignmentRevision: 4,
			ConfigGeneration: 6, CredentialVersion: 2,
			RequestedAt: controlRepoNow.Add(time.Minute),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	heartbeatAt := controlRepoNow.Add(2 * time.Minute)
	err = repository.ApplyHeartbeat(context.Background(), computercontrolport.Heartbeat{
		ID: controlHeartbeatID, ServerID: controlRepoServerID,
		ComputerID: controlRepoComputerID, AssignmentEpoch: controlRepoEpoch,
		AssignmentRevision: 4, DaemonVersion: "1.0.0",
		DaemonBuildID: "vela-computer/1.0.0+git.test;platform-v1-launch-fence-1",
		TATState:      "online", ReconcileState: "healthy",
		Agents: []computercontrolport.HeartbeatAgent{{
			AgentID: controlRepoAgentID, AssignmentEpoch: controlRepoEpoch,
			ConfigGeneration: 6, CredentialVersion: 2,
			Attempt: allocation.Fence.Attempt, LaunchID: launchID,
		}},
		ReceivedAt: heartbeatAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	entity, err := handle.Client().Agent.Get(context.Background(), controlRepoAgentID)
	if err != nil || entity.HostLastSeenAt == nil || !entity.HostLastSeenAt.Equal(heartbeatAt) {
		t.Fatalf("Agent host lease = %#v, %v", entity, err)
	}
	machine, err := handle.Client().Computer.Get(context.Background(), controlRepoComputerID)
	if err != nil || machine.DaemonBuildID == nil ||
		*machine.DaemonBuildID != "vela-computer/1.0.0+git.test;platform-v1-launch-fence-1" {
		t.Fatalf("Computer build projection = %#v, %v", machine, err)
	}
}

func TestHeartbeatCompletesStoppedAgentProjectionForCurrentAssignment(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	_, err := handle.Client().Agent.Create().
		SetID(controlRepoAgentID).
		SetServerID(controlRepoServerID).
		SetImUserID("a_control_stopping").
		SetComputerID(controlRepoComputerID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("stopped").
		SetObservedState("stopping").
		SetCredentialVersion(2).
		SetImState("ready").
		SetObservedAssignmentEpoch(controlRepoEpoch).
		SetObservedGeneration(5).
		SetObservedAttempt(1).
		SetObservedSequence(2).
		SetObservedLaunchID(controlObservationOldLaunch).
		SetCreatedByMemberID(controlRepoMemberID).
		SetRevision(6).
		SetCreatedAt(controlRepoNow).
		SetUpdatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	heartbeatAt := controlRepoNow.Add(time.Minute)
	if err := repository.ApplyHeartbeat(
		context.Background(),
		computercontrolport.Heartbeat{
			ID: controlHeartbeatID, ServerID: controlRepoServerID,
			ComputerID:      controlRepoComputerID,
			AssignmentEpoch: controlRepoEpoch, AssignmentRevision: 4,
			DaemonVersion: "1.0.0", DaemonBuildID: "build-test", TATState: "online",
			ReconcileState: "healthy", ReceivedAt: heartbeatAt,
		},
	); err != nil {
		t.Fatal(err)
	}
	entity, err := handle.Client().Agent.Get(
		context.Background(), controlRepoAgentID,
	)
	if err != nil || entity.ObservedState != "stopped" ||
		entity.LastObservedAt == nil ||
		!entity.LastObservedAt.Equal(heartbeatAt) ||
		entity.HostLastSeenAt == nil ||
		!entity.HostLastSeenAt.Equal(heartbeatAt) {
		t.Fatalf("stopped Agent projection = %#v, %v", entity, err)
	}
}

func TestHeartbeatDoesNotCompleteStoppedProjectionWhenAssignmentIsStale(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	_, err := handle.Client().Agent.Create().
		SetID(controlRepoAgentID).
		SetServerID(controlRepoServerID).
		SetImUserID("a_control_stale_stopping").
		SetComputerID(controlRepoComputerID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("stopped").
		SetObservedState("stopping").
		SetCredentialVersion(2).
		SetImState("ready").
		SetObservedAssignmentEpoch(controlRepoEpoch).
		SetObservedGeneration(5).
		SetObservedAttempt(1).
		SetObservedSequence(2).
		SetObservedLaunchID(controlObservationOldLaunch).
		SetCreatedByMemberID(controlRepoMemberID).
		SetRevision(6).
		SetCreatedAt(controlRepoNow).
		SetUpdatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.ApplyHeartbeat(
		context.Background(),
		computercontrolport.Heartbeat{
			ID: controlHeartbeatID, ServerID: controlRepoServerID,
			ComputerID:      controlRepoComputerID,
			AssignmentEpoch: controlRepoEpoch, AssignmentRevision: 3,
			DaemonVersion: "1.0.0", DaemonBuildID: "build-test", TATState: "online",
			ReconcileState: "healthy", ReceivedAt: controlRepoNow.Add(time.Minute),
		},
	); err != nil {
		t.Fatal(err)
	}
	entity, err := handle.Client().Agent.Get(context.Background(), controlRepoAgentID)
	if err != nil || entity.ObservedState != "stopping" {
		t.Fatalf("stale heartbeat changed Agent projection = %#v, %v", entity, err)
	}
}

func TestHeartbeatKeepsReportedStoppingAgentInStopping(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	_, err := handle.Client().Agent.Create().
		SetID(controlRepoAgentID).
		SetServerID(controlRepoServerID).
		SetImUserID("a_control_reported_stopping").
		SetComputerID(controlRepoComputerID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("stopped").
		SetObservedState("stopping").
		SetCredentialVersion(2).
		SetImState("ready").
		SetObservedAssignmentEpoch(controlRepoEpoch).
		SetObservedGeneration(5).
		SetObservedAttempt(1).
		SetObservedSequence(2).
		SetObservedLaunchID(controlObservationOldLaunch).
		SetCurrentLaunchID(controlObservationOldLaunch).
		SetCurrentLaunchAssignmentEpoch(controlRepoEpoch).
		SetCurrentLaunchGeneration(5).
		SetCurrentLaunchCredentialVersion(2).
		SetCurrentLaunchAttempt(1).
		SetCurrentLaunchUpdatedAt(controlRepoNow).
		SetCreatedByMemberID(controlRepoMemberID).
		SetRevision(5).
		SetCreatedAt(controlRepoNow).
		SetUpdatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.ApplyHeartbeat(
		context.Background(),
		computercontrolport.Heartbeat{
			ID: controlHeartbeatID, ServerID: controlRepoServerID,
			ComputerID:      controlRepoComputerID,
			AssignmentEpoch: controlRepoEpoch, AssignmentRevision: 4,
			DaemonVersion: "1.0.0", DaemonBuildID: "build-test", TATState: "online",
			ReconcileState: "healthy", ReceivedAt: controlRepoNow.Add(time.Minute),
			Agents: []computercontrolport.HeartbeatAgent{{
				AgentID: controlRepoAgentID, AssignmentEpoch: controlRepoEpoch,
				ConfigGeneration: 5, CredentialVersion: 2, Attempt: 1,
				LaunchID: controlObservationOldLaunch,
			}},
		},
	); err != nil {
		t.Fatal(err)
	}
	entity, err := handle.Client().Agent.Get(context.Background(), controlRepoAgentID)
	if err != nil || entity.ObservedState != "stopping" || entity.HostLastSeenAt == nil {
		t.Fatalf("reported Agent projection = %#v, %v", entity, err)
	}
}
