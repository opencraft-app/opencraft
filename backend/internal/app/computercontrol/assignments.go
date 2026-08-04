package computercontrol

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"chatserver/internal/apperror"
	computercontrolport "chatserver/internal/ports/computercontrol"
)

const (
	assignmentSchemaVersion = 1
	maximumRunningAgents    = 5
)

type AssignmentQuery struct {
	SinceEpoch    string
	SinceRevision int64
	WaitSeconds   int
	ForceFull     bool
}

type AssignmentSnapshot struct {
	SchemaVersion int
	ComputerID    string
	Epoch         string
	Revision      int64
	SnapshotHash  string
	Agents        []computercontrolport.Assignment
}

type AssignmentResult struct {
	Snapshot *AssignmentSnapshot
	NoChange bool
	Revision int64
}

type AssignmentService struct {
	repository   computercontrolport.AssignmentRepository
	pollInterval time.Duration
}

func NewAssignmentService(
	repository computercontrolport.AssignmentRepository,
) (*AssignmentService, error) {
	if repository == nil {
		return nil, errors.New("Computer Assignment Repository 不能为空")
	}
	return &AssignmentService{
		repository:   repository,
		pollInterval: time.Second,
	}, nil
}

// Get returns a full authoritative snapshot or an explicit no-change result.
// A changed epoch always forces a full snapshot, regardless of revision.
func (service *AssignmentService) Get(
	ctx context.Context,
	serverID string,
	computerID string,
	query AssignmentQuery,
) (AssignmentResult, error) {
	if !validV7(serverID) || !validV7(computerID) ||
		query.SinceRevision < 0 || query.WaitSeconds < 0 ||
		query.WaitSeconds > 25 ||
		(query.SinceEpoch == "" &&
			(query.SinceRevision != 0 || !query.ForceFull)) ||
		(query.SinceEpoch != "" && !validV7(query.SinceEpoch)) {
		return AssignmentResult{}, apperror.New(
			"assignment_query_invalid",
			"Assignment 查询无效",
			nil,
		)
	}
	if query.WaitSeconds == 0 || query.ForceFull {
		return service.getOnce(ctx, serverID, computerID, query)
	}
	timeout := time.NewTimer(time.Duration(query.WaitSeconds) * time.Second)
	defer timeout.Stop()
	ticker := time.NewTicker(service.pollInterval)
	defer ticker.Stop()
	for {
		result, err := service.getOnce(ctx, serverID, computerID, query)
		if err != nil || !result.NoChange {
			return result, err
		}
		select {
		case <-ctx.Done():
			return AssignmentResult{}, ctx.Err()
		case <-timeout.C:
			return result, nil
		case <-ticker.C:
		}
	}
}

func (service *AssignmentService) getOnce(
	ctx context.Context,
	serverID string,
	computerID string,
	query AssignmentQuery,
) (AssignmentResult, error) {
	value, err := service.repository.GetAssignmentSnapshot(ctx, serverID, computerID)
	switch {
	case errors.Is(err, computercontrolport.ErrComputerNotCurrent):
		return AssignmentResult{}, apperror.New(
			"computer_credential_revoked",
			"Computer 已失效",
			err,
		)
	case err != nil:
		return AssignmentResult{}, apperror.New(
			"internal_error",
			"暂时无法读取 Computer Assignment",
			err,
		)
	}
	if err := validateAssignmentSnapshot(value, serverID, computerID); err != nil {
		return AssignmentResult{}, apperror.New(
			"internal_error",
			"Computer Assignment 数据无效",
			err,
		)
	}
	if !query.ForceFull && query.SinceEpoch == value.Epoch {
		if query.SinceRevision > value.Revision {
			return AssignmentResult{}, apperror.New(
				"assignment_revision_regressed",
				"Assignment revision 已回退",
				nil,
			)
		}
		if query.SinceRevision == value.Revision {
			return AssignmentResult{NoChange: true, Revision: value.Revision}, nil
		}
	}
	agents := append([]computercontrolport.Assignment(nil), value.Agents...)
	sort.Slice(agents, func(left, right int) bool {
		return agents[left].AgentID < agents[right].AgentID
	})
	snapshot := AssignmentSnapshot{
		SchemaVersion: assignmentSchemaVersion,
		ComputerID:    value.ComputerID,
		Epoch:         value.Epoch,
		Revision:      value.Revision,
		Agents:        agents,
	}
	canonical, err := canonicalAssignmentSnapshot(snapshot)
	if err != nil {
		return AssignmentResult{}, apperror.New(
			"internal_error",
			"Computer Assignment 数据无效",
			err,
		)
	}
	digest := sha256.Sum256(canonical)
	snapshot.SnapshotHash = base64.RawURLEncoding.EncodeToString(digest[:])
	return AssignmentResult{Snapshot: &snapshot, Revision: snapshot.Revision}, nil
}

func validateAssignmentSnapshot(
	value computercontrolport.AssignmentSnapshot,
	serverID string,
	computerID string,
) error {
	if value.ComputerID != computerID || !validV7(value.ComputerID) ||
		!validV7(value.Epoch) || value.Revision < 1 || len(value.Agents) > 100 {
		return errors.New("Assignment snapshot fence 无效")
	}
	seen := make(map[string]struct{}, len(value.Agents))
	running := 0
	for _, item := range value.Agents {
		if !validV7(item.AgentID) || item.ServerID != serverID ||
			!validV7(item.ServerID) || item.ConfigGeneration < 1 ||
			item.CredentialVersion < 0 ||
			(item.DesiredState != "running" && item.DesiredState != "stopped") ||
			!validAssignmentRuntime(item.RuntimeKind) ||
			(item.RuntimeModel != nil && strings.TrimSpace(*item.RuntimeModel) != *item.RuntimeModel) ||
			(item.ReplyPolicy != "dm_only" && item.ReplyPolicy != "mention_and_dm" &&
				item.ReplyPolicy != "all_channel_messages") {
			return errors.New("Agent Assignment 无效")
		}
		if item.CurrentLaunch != nil &&
			(!validV7(item.CurrentLaunch.LaunchID) ||
				!validV7(item.CurrentLaunch.AssignmentEpoch) ||
				item.CurrentLaunch.ConfigGeneration < 1 ||
				item.CurrentLaunch.CredentialVersion == 0 ||
				item.CurrentLaunch.Attempt < 1) {
			return errors.New("Agent Assignment current Launch 无效")
		}
		if _, ok := seen[item.AgentID]; ok {
			return errors.New("Agent Assignment 重复")
		}
		seen[item.AgentID] = struct{}{}
		if item.DesiredState == "running" {
			running++
			if item.CredentialVersion < 1 {
				return errors.New("运行中的 Agent 缺少 credential")
			}
		}
	}
	if running > maximumRunningAgents {
		return errors.New("Computer 并发 Agent 超过上限")
	}
	return nil
}

func validAssignmentRuntime(value string) bool {
	switch value {
	case "codex", "hermes-acp", "hermes-gateway":
		return true
	default:
		return false
	}
}

func canonicalAssignmentSnapshot(snapshot AssignmentSnapshot) ([]byte, error) {
	var output bytes.Buffer
	output.WriteString(`{"agents":[`)
	for index, item := range snapshot.Agents {
		if index > 0 {
			output.WriteByte(',')
		}
		output.WriteString(`{"agentId":`)
		if err := appendAssignmentJSONString(&output, item.AgentID); err != nil {
			return nil, err
		}
		output.WriteString(`,"configGeneration":`)
		output.WriteString(strconv.FormatInt(item.ConfigGeneration, 10))
		output.WriteString(`,"credentialVersion":`)
		output.WriteString(strconv.FormatInt(item.CredentialVersion, 10))
		output.WriteString(`,"currentLaunch":`)
		if item.CurrentLaunch == nil {
			output.WriteString("null")
		} else {
			output.WriteString(`{"assignmentEpoch":`)
			if err := appendAssignmentJSONString(&output, item.CurrentLaunch.AssignmentEpoch); err != nil {
				return nil, err
			}
			output.WriteString(`,"attempt":`)
			output.WriteString(strconv.FormatInt(item.CurrentLaunch.Attempt, 10))
			output.WriteString(`,"configGeneration":`)
			output.WriteString(strconv.FormatInt(item.CurrentLaunch.ConfigGeneration, 10))
			output.WriteString(`,"credentialVersion":`)
			output.WriteString(strconv.FormatUint(item.CurrentLaunch.CredentialVersion, 10))
			output.WriteString(`,"launchId":`)
			if err := appendAssignmentJSONString(&output, item.CurrentLaunch.LaunchID); err != nil {
				return nil, err
			}
			output.WriteByte('}')
		}
		output.WriteString(`,"desiredState":`)
		if err := appendAssignmentJSONString(&output, item.DesiredState); err != nil {
			return nil, err
		}
		output.WriteString(`,"replyPolicy":`)
		if err := appendAssignmentJSONString(&output, item.ReplyPolicy); err != nil {
			return nil, err
		}
		output.WriteString(`,"runtime":{"kind":`)
		if err := appendAssignmentJSONString(&output, item.RuntimeKind); err != nil {
			return nil, err
		}
		output.WriteString(`,"model":`)
		if item.RuntimeModel == nil {
			output.WriteString("null")
		} else if err := appendAssignmentJSONString(&output, *item.RuntimeModel); err != nil {
			return nil, err
		}
		output.WriteString(`},"serverId":`)
		if err := appendAssignmentJSONString(&output, item.ServerID); err != nil {
			return nil, err
		}
		output.WriteByte('}')
	}
	output.WriteString(`],"computerId":`)
	if err := appendAssignmentJSONString(&output, snapshot.ComputerID); err != nil {
		return nil, err
	}
	output.WriteString(`,"epoch":`)
	if err := appendAssignmentJSONString(&output, snapshot.Epoch); err != nil {
		return nil, err
	}
	output.WriteString(`,"revision":`)
	output.WriteString(strconv.FormatInt(snapshot.Revision, 10))
	output.WriteString(`,"schemaVersion":1}`)
	return output.Bytes(), nil
}

func appendAssignmentJSONString(output *bytes.Buffer, value string) error {
	if !utf8.ValidString(value) {
		return errors.New("Assignment 字符串不是 UTF-8")
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
