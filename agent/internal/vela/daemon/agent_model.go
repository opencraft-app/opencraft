package daemon

import (
	"context"
	"sync"
	"time"
)

type Fence struct {
	Epoch            string
	ConfigGeneration int64
	Attempt          int64
	LaunchID         string
}

// AgentInstance represents one asynchronous Host attempt. Revoke removes its
// local capability before Cell cancels Lifetime; Close waits for Done and then
// finalizes resources.
type AgentInstance interface {
	Ready() <-chan struct{}
	Done() <-chan struct{}
	Err() error
	Revoke(context.Context) error
	Close(context.Context) error
}

// AgentHealth is an optional live projection for an AgentInstance that can
// reconnect its data plane without replacing the whole Host or Runtime.
type AgentHealth struct {
	Ready     bool
	ErrorCode string
}

type AgentHealthSource interface {
	Health() <-chan AgentHealth
}

// AgentFenceSource exposes a launch fence allocated by the platform. The
// server-owned attempt replaces the process-local provisional attempt before
// Cell publishes running state or the heartbeat snapshot.
type AgentFenceSource interface {
	Fence() Fence
}

type AgentFactory interface {
	Start(context.Context, AgentStartRequest) (AgentInstance, error)
}

type AgentState string

const (
	AgentStateAbsent    AgentState = "absent"
	AgentStateStarting  AgentState = "starting"
	AgentStateRunning   AgentState = "running"
	AgentStateRetryWait AgentState = "retry_wait"
	AgentStateBlocked   AgentState = "blocked"
	AgentStateStopping  AgentState = "stopping"
	AgentStateStopped   AgentState = "stopped"
)

type AgentPhase string

const (
	AgentPhaseAbsent   AgentPhase = "absent"
	AgentPhaseStarting AgentPhase = "starting"
	AgentPhaseRunning  AgentPhase = "running"
	AgentPhaseStopping AgentPhase = "stopping"
	AgentPhaseStopped  AgentPhase = "stopped"
)

type AgentHealthState string

const (
	AgentHealthUnknown      AgentHealthState = "unknown"
	AgentHealthReady        AgentHealthState = "ready"
	AgentHealthReconnecting AgentHealthState = "reconnecting"
	AgentHealthDegraded     AgentHealthState = "degraded"
	AgentHealthBlocked      AgentHealthState = "blocked"
)

type CellSnapshot struct {
	AgentID            string           `json:"agentId"`
	ServerID           string           `json:"serverId,omitempty"`
	AssignmentEpoch    string           `json:"assignmentEpoch,omitempty"`
	CredentialVersion  int64            `json:"credentialVersion,omitempty"`
	AssignmentRevision int64            `json:"assignmentRevision"`
	ConfigGeneration   int64            `json:"configGeneration"`
	Attempt            int64            `json:"attempt"`
	LaunchID           string           `json:"launchId,omitempty"`
	Phase              AgentPhase       `json:"phase"`
	Health             AgentHealthState `json:"health"`
	// State is the v1 compatibility projection. New local consumers should
	// reason about Phase and Health independently.
	State            AgentState `json:"state"`
	ErrorCode        string     `json:"errorCode,omitempty"`
	LastTransitionAt time.Time  `json:"lastTransitionAt"`
	NextRetryAt      *time.Time `json:"nextRetryAt,omitempty"`
}

// AgentStatus keeps the v1 local management API source-compatible while new
// code names the richer phase/health projection CellSnapshot.
type AgentStatus = CellSnapshot

// AssignmentLeaseSnapshot is the mutable, non-launching portion of an
// Assignment. A revision-only platform snapshot advances this value without
// replacing the running Host.
type AssignmentLeaseSnapshot struct {
	Epoch      string
	Revision   int64
	Assignment AgentAssignment
}

// AssignmentLeaseReader lets a running Host obtain the latest accepted
// assignment revision when it renews its short-lived platform session.
type AssignmentLeaseReader interface {
	Current() (AssignmentLeaseSnapshot, bool)
}

// AssignmentLease belongs to exactly one launch-affecting desired value.
// Generation, credential, runtime, policy, server, or epoch changes create a
// new lease so an older Host can never observe a replacement launch's data.
type AssignmentLease struct {
	mu      sync.RWMutex
	current AssignmentLeaseSnapshot
	valid   bool
}

func NewAssignmentLease(
	epoch string,
	revision int64,
	assignment AgentAssignment,
) *AssignmentLease {
	return &AssignmentLease{
		current: AssignmentLeaseSnapshot{
			Epoch:      epoch,
			Revision:   revision,
			Assignment: assignment,
		},
		valid: true,
	}
}

// Advance accepts only a monotonic revision for the same launch-affecting
// assignment. Callers must allocate a new lease for every other change.
func (l *AssignmentLease) Advance(
	epoch string,
	revision int64,
	assignment AgentAssignment,
) bool {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.valid ||
		epoch != l.current.Epoch ||
		revision < l.current.Revision ||
		!assignmentsEqual(l.current.Assignment, assignment) {
		return false
	}
	l.current = AssignmentLeaseSnapshot{
		Epoch:      epoch,
		Revision:   revision,
		Assignment: assignment,
	}
	return true
}

func (l *AssignmentLease) Current() (AssignmentLeaseSnapshot, bool) {
	if l == nil {
		return AssignmentLeaseSnapshot{}, false
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	if !l.valid {
		return AssignmentLeaseSnapshot{}, false
	}
	return l.current, true
}

func (l *AssignmentLease) revoke() {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.valid = false
	l.mu.Unlock()
}

// LaunchSpec is immutable for one Host attempt. AssignmentLease carries only
// revision/currentness updates that do not require a new launch.
type LaunchSpec struct {
	Assignment AgentAssignment
	Fence      Fence
}

// AgentStartRequest separates the construction deadline passed to Start from
// the lifetime owned and canceled by AgentCell.
type AgentStartRequest struct {
	Lifetime context.Context
	Launch   LaunchSpec
	Lease    AssignmentLeaseReader
}
