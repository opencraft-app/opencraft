// Package daemon implements the Vela Computer desired-state reconciler.
package daemon

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	AssignmentSchemaVersionV1 = 1
	AssignmentSchemaVersionV2 = 2
	AssignmentSchemaVersionV3 = 3
	AssignmentSchemaVersion   = AssignmentSchemaVersionV3
	DefaultMaximumAgents      = 5

	DesiredRunning = "running"
	DesiredStopped = "stopped"
)

var (
	ErrInvalidSnapshot     = errors.New("assignment_snapshot_invalid")
	ErrCapacityExceeded    = errors.New("computer_capacity_exceeded")
	ErrRevisionRegressed   = errors.New("assignment_revision_regressed")
	ErrRevisionCollision   = errors.New("assignment_revision_collision")
	ErrGenerationRegressed = errors.New("agent_generation_regressed")
	ErrGenerationCollision = errors.New("agent_generation_collision")
)

type Snapshot struct {
	SchemaVersion int               `json:"schemaVersion"`
	ComputerID    string            `json:"computerId"`
	Epoch         string            `json:"epoch"`
	Revision      int64             `json:"revision"`
	SnapshotHash  string            `json:"snapshotHash"`
	Agents        []AgentAssignment `json:"agents"`
}

type AgentAssignment struct {
	AgentID                  string                    `json:"agentId"`
	ServerID                 string                    `json:"serverId"`
	DesiredState             string                    `json:"desiredState"`
	ConfigGeneration         int64                     `json:"configGeneration"`
	CredentialVersion        int64                     `json:"credentialVersion"`
	CurrentLaunch            *AssignmentLaunchFence    `json:"currentLaunch"`
	Runtime                  RuntimeConfig             `json:"runtime"`
	ReplyPolicy              string                    `json:"replyPolicy"`
	ProfileCapabilityRefresh *ProfileCapabilityRefresh `json:"profileCapabilityRefresh"`
}

type ProfileCapabilityRefresh struct {
	SchemaVersion         int       `json:"schemaVersion"`
	RefreshID             string    `json:"refreshId"`
	ContextGeneration     int64     `json:"contextGeneration"`
	AuthorityContextKey   string    `json:"authorityContextKey"`
	RuntimeKind           string    `json:"runtimeKind"`
	InvalidationWatermark int64     `json:"invalidationWatermark"`
	ForceReload           bool      `json:"forceReload"`
	RequestedAt           time.Time `json:"requestedAt"`
}

type AssignmentLaunchFence struct {
	LaunchID          string `json:"launchId"`
	AssignmentEpoch   string `json:"assignmentEpoch"`
	ConfigGeneration  int64  `json:"configGeneration"`
	CredentialVersion int64  `json:"credentialVersion"`
	Attempt           int64  `json:"attempt"`
}

type RuntimeConfig struct {
	Kind  string  `json:"kind"`
	Model *string `json:"model"`
}

func ValidateSnapshot(snapshot Snapshot, expectedComputerID string) error {
	if (snapshot.SchemaVersion != AssignmentSchemaVersionV1 &&
		snapshot.SchemaVersion != AssignmentSchemaVersionV2 &&
		snapshot.SchemaVersion != AssignmentSchemaVersionV3) ||
		!isUUIDv7(snapshot.ComputerID) ||
		snapshot.ComputerID != expectedComputerID ||
		!isUUIDv7(snapshot.Epoch) ||
		snapshot.Revision < 1 {
		return ErrInvalidSnapshot
	}
	seen := make(map[string]struct{}, len(snapshot.Agents))
	running := 0
	for _, assignment := range snapshot.Agents {
		if !isUUIDv7(assignment.AgentID) ||
			!isUUIDv7(assignment.ServerID) ||
			assignment.ConfigGeneration < 1 ||
			!validDesiredState(assignment.DesiredState) ||
			!validRuntime(assignment.Runtime) ||
			(snapshot.SchemaVersion < AssignmentSchemaVersionV3 &&
				!legacyRuntimeKind(assignment.Runtime.Kind)) ||
			!validReplyPolicy(assignment.ReplyPolicy) {
			return ErrInvalidSnapshot
		}
		if _, exists := seen[assignment.AgentID]; exists {
			return ErrInvalidSnapshot
		}
		if assignment.CurrentLaunch != nil &&
			(!isUUIDv7(assignment.CurrentLaunch.LaunchID) ||
				!isUUIDv7(assignment.CurrentLaunch.AssignmentEpoch) ||
				assignment.CurrentLaunch.ConfigGeneration < 1 ||
				assignment.CurrentLaunch.CredentialVersion < 1 ||
				assignment.CurrentLaunch.Attempt < 1) {
			return ErrInvalidSnapshot
		}
		if snapshot.SchemaVersion >= AssignmentSchemaVersionV2 {
			refresh := assignment.ProfileCapabilityRefresh
			if refresh != nil &&
				(refresh.SchemaVersion != 1 || !isUUIDv7(refresh.RefreshID) ||
					refresh.ContextGeneration < 1 || len(refresh.AuthorityContextKey) != 43 ||
					refresh.RuntimeKind != assignment.Runtime.Kind ||
					refresh.InvalidationWatermark < 0 || refresh.RequestedAt.IsZero()) {
				return ErrInvalidSnapshot
			}
		} else if assignment.ProfileCapabilityRefresh != nil {
			return ErrInvalidSnapshot
		}
		seen[assignment.AgentID] = struct{}{}
		if assignment.DesiredState == DesiredRunning {
			running++
			if assignment.CredentialVersion < 1 {
				return ErrInvalidSnapshot
			}
		}
	}
	if running > DefaultMaximumAgents {
		return ErrCapacityExceeded
	}
	canonical, digest, err := CanonicalSnapshot(snapshot)
	if err != nil || len(canonical) == 0 {
		return ErrInvalidSnapshot
	}
	claimed, err := base64.RawURLEncoding.DecodeString(snapshot.SnapshotHash)
	if err != nil ||
		len(claimed) != sha256.Size ||
		subtle.ConstantTimeCompare(claimed, digest[:]) != 1 {
		return ErrInvalidSnapshot
	}
	return nil
}

func CanonicalSnapshot(snapshot Snapshot) ([]byte, [sha256.Size]byte, error) {
	agents := append([]AgentAssignment(nil), snapshot.Agents...)
	sort.Slice(agents, func(left, right int) bool {
		return agents[left].AgentID < agents[right].AgentID
	})
	var output bytes.Buffer
	output.WriteString(`{"agents":[`)
	for index, assignment := range agents {
		if index > 0 {
			output.WriteByte(',')
		}
		if err := appendCanonicalAgent(&output, assignment, snapshot.SchemaVersion); err != nil {
			return nil, [sha256.Size]byte{}, err
		}
	}
	output.WriteString(`],"computerId":`)
	if err := appendJSONString(&output, snapshot.ComputerID); err != nil {
		return nil, [sha256.Size]byte{}, err
	}
	output.WriteString(`,"epoch":`)
	if err := appendJSONString(&output, snapshot.Epoch); err != nil {
		return nil, [sha256.Size]byte{}, err
	}
	output.WriteString(`,"revision":`)
	output.WriteString(strconv.FormatInt(snapshot.Revision, 10))
	output.WriteString(`,"schemaVersion":`)
	output.WriteString(strconv.Itoa(snapshot.SchemaVersion))
	output.WriteByte('}')
	canonical := output.Bytes()
	return canonical, sha256.Sum256(canonical), nil
}

func appendCanonicalAgent(
	output *bytes.Buffer,
	assignment AgentAssignment,
	schemaVersion int,
) error {
	output.WriteString(`{"agentId":`)
	if err := appendJSONString(output, assignment.AgentID); err != nil {
		return err
	}
	output.WriteString(`,"configGeneration":`)
	output.WriteString(strconv.FormatInt(assignment.ConfigGeneration, 10))
	output.WriteString(`,"credentialVersion":`)
	output.WriteString(strconv.FormatInt(assignment.CredentialVersion, 10))
	output.WriteString(`,"currentLaunch":`)
	if assignment.CurrentLaunch == nil {
		output.WriteString("null")
	} else {
		output.WriteString(`{"assignmentEpoch":`)
		if err := appendJSONString(output, assignment.CurrentLaunch.AssignmentEpoch); err != nil {
			return err
		}
		output.WriteString(`,"attempt":`)
		output.WriteString(strconv.FormatInt(assignment.CurrentLaunch.Attempt, 10))
		output.WriteString(`,"configGeneration":`)
		output.WriteString(strconv.FormatInt(assignment.CurrentLaunch.ConfigGeneration, 10))
		output.WriteString(`,"credentialVersion":`)
		output.WriteString(strconv.FormatInt(assignment.CurrentLaunch.CredentialVersion, 10))
		output.WriteString(`,"launchId":`)
		if err := appendJSONString(output, assignment.CurrentLaunch.LaunchID); err != nil {
			return err
		}
		output.WriteByte('}')
	}
	output.WriteString(`,"desiredState":`)
	if err := appendJSONString(output, assignment.DesiredState); err != nil {
		return err
	}
	if schemaVersion >= AssignmentSchemaVersionV2 {
		output.WriteString(`,"profileCapabilityRefresh":`)
		if assignment.ProfileCapabilityRefresh == nil {
			output.WriteString("null")
		} else {
			refresh := assignment.ProfileCapabilityRefresh
			output.WriteString(`{"authorityContextKey":`)
			if err := appendJSONString(output, refresh.AuthorityContextKey); err != nil {
				return err
			}
			output.WriteString(`,"contextGeneration":`)
			output.WriteString(strconv.FormatInt(refresh.ContextGeneration, 10))
			output.WriteString(`,"forceReload":`)
			output.WriteString(strconv.FormatBool(refresh.ForceReload))
			output.WriteString(`,"invalidationWatermark":`)
			output.WriteString(strconv.FormatInt(refresh.InvalidationWatermark, 10))
			output.WriteString(`,"refreshId":`)
			if err := appendJSONString(output, refresh.RefreshID); err != nil {
				return err
			}
			output.WriteString(`,"requestedAt":`)
			if err := appendJSONString(
				output,
				refresh.RequestedAt.UTC().Format(time.RFC3339Nano),
			); err != nil {
				return err
			}
			output.WriteString(`,"runtimeKind":`)
			if err := appendJSONString(output, refresh.RuntimeKind); err != nil {
				return err
			}
			output.WriteString(`,"schemaVersion":1}`)
		}
	}
	output.WriteString(`,"replyPolicy":`)
	if err := appendJSONString(output, assignment.ReplyPolicy); err != nil {
		return err
	}
	output.WriteString(`,"runtime":{"kind":`)
	if err := appendJSONString(output, assignment.Runtime.Kind); err != nil {
		return err
	}
	output.WriteString(`,"model":`)
	if assignment.Runtime.Model == nil {
		output.WriteString("null")
	} else if err := appendJSONString(output, *assignment.Runtime.Model); err != nil {
		return err
	}
	output.WriteString(`},"serverId":`)
	if err := appendJSONString(output, assignment.ServerID); err != nil {
		return err
	}
	output.WriteByte('}')
	return nil
}

func appendJSONString(output *bytes.Buffer, value string) error {
	if !utf8.ValidString(value) {
		return ErrInvalidSnapshot
	}
	const hex = "0123456789abcdef"
	output.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"', '\\':
			output.WriteByte('\\')
			output.WriteRune(character)
		case '\b':
			output.WriteString(`\b`)
		case '\t':
			output.WriteString(`\t`)
		case '\n':
			output.WriteString(`\n`)
		case '\f':
			output.WriteString(`\f`)
		case '\r':
			output.WriteString(`\r`)
		default:
			if character < 0x20 {
				output.WriteString(`\u00`)
				output.WriteByte(hex[byte(character)>>4])
				output.WriteByte(hex[byte(character)&0x0f])
				continue
			}
			output.WriteRune(character)
		}
	}
	output.WriteByte('"')
	return nil
}

func validDesiredState(value string) bool {
	return value == DesiredRunning || value == DesiredStopped
}

func validRuntime(value RuntimeConfig) bool {
	if len(value.Kind) < 1 || len(value.Kind) > 64 ||
		value.Kind[0] < 'a' || value.Kind[0] > 'z' {
		return false
	}
	for _, character := range value.Kind[1:] {
		if character != '-' && (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') {
			return false
		}
	}
	return value.Model == nil ||
		strings.TrimSpace(*value.Model) == *value.Model
}

func legacyRuntimeKind(value string) bool {
	return value == "codex" || value == "hermes-acp" || value == "hermes-gateway"
}

func validReplyPolicy(value string) bool {
	return value == "dm_only" || value == "mention_and_dm" ||
		value == "all_channel_messages"
}

func isUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7
}
