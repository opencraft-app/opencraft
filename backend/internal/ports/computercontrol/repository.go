// Package computercontrol defines persistence boundaries for the Vela daemon control plane.
package computercontrol

import (
	"context"
	"errors"
	"time"

	computerauthport "chatserver/internal/ports/computerauth"
)

var (
	ErrCredentialNotCurrent        = errors.New("Computer credential 已失效")
	ErrComputerNotCurrent          = errors.New("Computer 已失效")
	ErrComputerCredentialNotActive = errors.New("Computer credential 不是 active 版本")
	ErrAssignmentStale             = errors.New("Agent Assignment 已变化")
	ErrLaunchConflict              = errors.New("Agent Launch 已冲突")
	ErrLaunchPredecessorMismatch   = errors.New("Agent Launch 前序已变化")
	ErrObservationConflict         = errors.New("Observation 幂等冲突")
	ErrObservationSequenceConflict = errors.New("Observation sequence 冲突")
)

const (
	ObservationAccepted      = "accepted"
	ObservationStaleLaunch   = "stale_launch"
	ObservationOlderSequence = "older_sequence"
)

type SessionIdentity struct {
	ServerID           string
	ComputerID         string
	CredentialVersion  uint64
	AssignmentEpoch    string
	AssignmentRevision int64
}

type Repository interface {
	UseCurrentCredential(
		context.Context,
		computerauthport.Route,
		time.Time,
	) (SessionIdentity, error)
	RefreshSessionLease(
		context.Context,
		computerauthport.Route,
		time.Time,
	) error
}

type Assignment struct {
	AgentID                  string
	ServerID                 string
	DesiredState             string
	ConfigGeneration         int64
	CredentialVersion        int64
	RuntimeKind              string
	RuntimeModel             *string
	ReplyPolicy              string
	CurrentLaunch            *AssignmentLaunchFence
	ProfileCapabilityRefresh *ProfileCapabilityRefresh
}

type ProfileCapabilityRefresh struct {
	RefreshID             string
	ContextGeneration     int64
	AuthorityContextKey   string
	RuntimeKind           string
	InvalidationWatermark int64
	ForceReload           bool
	RequestedAt           time.Time
}

type AssignmentLaunchFence struct {
	LaunchID          string
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion uint64
	Attempt           int64
}

type AssignmentSnapshot struct {
	ComputerID string
	Epoch      string
	Revision   int64
	Agents     []Assignment
}

// AssignmentRepository reads one authoritative full snapshot. Long polling
// and no-change decisions remain application concerns.
type AssignmentRepository interface {
	GetAssignmentSnapshot(
		context.Context,
		string,
		string,
	) (AssignmentSnapshot, error)
}

type AgentLaunchRequest struct {
	ServerID                  string
	ComputerID                string
	ComputerCredentialVersion uint64
	AgentID                   string
	LaunchID                  string
	PredecessorLaunchID       *string
	AssignmentEpoch           string
	AssignmentRevision        int64
	ConfigGeneration          int64
	CredentialVersion         uint64
	RequestedAt               time.Time
}

type AgentLaunchFence struct {
	LaunchID          string
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion uint64
	Attempt           int64
	IssuedAt          time.Time
}

type AgentLaunchAllocation struct {
	Fence   AgentLaunchFence
	Created bool
}

type AgentLaunchSessionRequest struct {
	ServerID          string
	ComputerID        string
	AgentID           string
	LaunchID          string
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion uint64
	Attempt           int64
}

type AgentLaunchRepository interface {
	AllocateAgentLaunch(
		context.Context,
		AgentLaunchRequest,
	) (AgentLaunchAllocation, error)
	ValidateAgentLaunch(
		context.Context,
		AgentLaunchSessionRequest,
	) (AgentLaunchFence, error)
}

type Observation struct {
	ID                 string
	ServerID           string
	ComputerID         string
	AgentID            string
	AssignmentEpoch    string
	AssignmentRevision int64
	ConfigGeneration   int64
	CredentialVersion  uint64
	Attempt            int64
	Sequence           int64
	LaunchID           string
	State              string
	IMTransportState   string
	ErrorCode          *string
	RequestHash        [32]byte
	ObservedAt         time.Time
	ReceivedAt         time.Time
}

type ObservationResult struct {
	Accepted        bool
	Reason          string
	CurrentLaunchID *string
	CurrentAttempt  int64
	CurrentSequence int64
}

type HeartbeatAgent struct {
	AgentID           string
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion uint64
	Attempt           int64
	LaunchID          string
}

type Heartbeat struct {
	ID                 string
	ServerID           string
	ComputerID         string
	AssignmentEpoch    string
	AssignmentRevision int64
	DaemonVersion      string
	DaemonBuildID      string
	TATState           string
	ReconcileState     string
	ReconcileErrorCode *string
	Agents             []HeartbeatAgent
	ReceivedAt         time.Time
}

type ObservationRepository interface {
	PutObservation(context.Context, Observation) (ObservationResult, error)
	ApplyHeartbeat(context.Context, Heartbeat) error
}
