// Package agentmanagement 实现 Agent 身份与 Vela Assignment 生命周期管理面。
package agentmanagement

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"

	"chatserver/internal/apperror"
	agentport "chatserver/internal/ports/agent"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"

	"github.com/google/uuid"
)

var agentHandlePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,31}$`)

type identityDeriver interface {
	AgentUserID(string) (string, error)
}

type CreateCommand struct {
	AccountID      string
	ServerID       string
	IdempotencyKey string
	DisplayName    string
	Handle         string
	Description    *string
	ComputerID     *string
	Runtime        agentport.Runtime
	ReplyPolicy    string
}

type LifecycleCommand struct {
	AccountID      string
	ServerID       string
	AgentID        string
	Kind           string
	IdempotencyKey string
}

type UpdateCommand struct {
	AccountID      string
	ServerID       string
	AgentID        string
	Revision       int64
	IdempotencyKey string
	DisplayName    *string
	DescriptionSet bool
	Description    *string
	ComputerIDSet  bool
	ComputerID     *string
	Runtime        *agentport.Runtime
	ReplyPolicy    *string
}

type CredentialCommand struct {
	AccountID      string
	ServerID       string
	AgentID        string
	IdempotencyKey string
}

type DeleteCommand struct {
	AccountID      string
	ServerID       string
	AgentID        string
	IdempotencyKey string
}

type Service struct {
	repository agentport.Repository
	identities identityDeriver
	ids        idport.Generator
	clock      clockport.Clock
	random     io.Reader
}

func NewService(
	repository agentport.Repository,
	identities identityDeriver,
	ids idport.Generator,
	clock clockport.Clock,
	random io.Reader,
) (*Service, error) {
	if repository == nil || identities == nil || ids == nil ||
		clock == nil || random == nil {
		return nil, errors.New("Agent 服务配置无效")
	}
	return &Service{
		repository: repository,
		identities: identities,
		ids:        ids,
		clock:      clock,
		random:     random,
	}, nil
}

func (service *Service) Create(
	ctx context.Context,
	command CreateCommand,
) (agentport.CreateResult, error) {
	if err := validateCreate(command); err != nil {
		return agentport.CreateResult{}, err
	}
	serverContext, err := service.repository.GetServerContext(
		ctx,
		command.AccountID,
		command.ServerID,
	)
	if err != nil {
		return agentport.CreateResult{}, mapRepositoryError(err)
	}
	if serverContext.IMState != "ready" {
		return agentport.CreateResult{},
			apperror.New("server_not_ready", "Server IM 尚未就绪", nil)
	}
	if !canManage(serverContext.Role) {
		return agentport.CreateResult{},
			apperror.New("permission_denied", "没有管理 Agent 的权限", nil)
	}
	agentID, err := service.ids.New()
	if err != nil {
		return agentport.CreateResult{},
			apperror.New("internal_error", "暂时无法创建 Agent", err)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return agentport.CreateResult{},
			apperror.New("internal_error", "暂时无法创建 Agent", err)
	}
	imUserID, err := service.identities.AgentUserID(agentID)
	if err != nil {
		return agentport.CreateResult{},
			apperror.New("internal_error", "无法生成 Agent IM 身份", err)
	}
	replyPolicy := strings.TrimSpace(command.ReplyPolicy)
	if replyPolicy == "" {
		replyPolicy = "mention_and_dm"
	}
	result, err := service.repository.Create(ctx, agentport.CreateCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		RequestHash:    createHash(command, replyPolicy),
		Agent: agentport.Draft{
			ID:              agentID,
			DisplayName:     strings.TrimSpace(command.DisplayName),
			Handle:          strings.TrimSpace(command.Handle),
			Description:     normalizedText(command.Description),
			IMUserID:        imUserID,
			ComputerID:      normalizedID(command.ComputerID),
			Runtime:         normalizedRuntime(command.Runtime),
			ReplyPolicy:     replyPolicy,
			CreatorMemberID: serverContext.CreatorMemberID,
		},
		OperationID: operationID,
		CreatedAt:   service.clock.Now().UTC(),
	})
	if err != nil {
		return agentport.CreateResult{}, mapRepositoryError(err)
	}
	result.Agent = service.projectAgentAvailability(result.Agent)
	return result, nil
}

func (service *Service) List(
	ctx context.Context,
	accountID string,
	serverID string,
) ([]agentport.Agent, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) {
		return nil, apperror.New("invalid_request", "Agent 列表参数无效", nil)
	}
	values, err := service.repository.List(ctx, accountID, serverID)
	if err != nil {
		return nil, mapRepositoryError(err)
	}
	for index := range values {
		values[index] = service.projectAgentAvailability(values[index])
	}
	return values, nil
}

func (service *Service) Get(
	ctx context.Context,
	accountID string,
	serverID string,
	agentID string,
) (agentport.Agent, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) ||
		!validUUIDv7(agentID) {
		return agentport.Agent{},
			apperror.New("invalid_request", "Agent 查询参数无效", nil)
	}
	value, err := service.repository.Get(ctx, accountID, serverID, agentID)
	if err != nil {
		return agentport.Agent{}, mapRepositoryError(err)
	}
	return service.projectAgentAvailability(value), nil
}

func (service *Service) Update(
	ctx context.Context,
	command UpdateCommand,
) (agentport.Agent, error) {
	if err := validateUpdate(command); err != nil {
		return agentport.Agent{}, err
	}
	patch := agentport.UpdatePatch{
		DescriptionSet: command.DescriptionSet,
		Description:    normalizedText(command.Description),
		ComputerIDSet:  command.ComputerIDSet,
		ComputerID:     normalizedID(command.ComputerID),
	}
	if command.DisplayName != nil {
		value := strings.TrimSpace(*command.DisplayName)
		patch.DisplayName = &value
	}
	if command.Runtime != nil {
		value := normalizedRuntime(*command.Runtime)
		patch.Runtime = &value
	}
	if command.ReplyPolicy != nil {
		value := strings.TrimSpace(*command.ReplyPolicy)
		patch.ReplyPolicy = &value
	}
	value, err := service.repository.Update(ctx, agentport.UpdateCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		AgentID:        command.AgentID,
		Revision:       command.Revision,
		IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		RequestHash:    updateHash(command),
		Patch:          patch,
		UpdatedAt:      service.clock.Now().UTC(),
	})
	if err != nil {
		return agentport.Agent{}, mapRepositoryError(err)
	}
	return service.projectAgentAvailability(value), nil
}

// Delete 立即删除平台侧 Agent 能力，并把腾讯 IM 账号删除交给可靠 Worker。
// 它不会也不能停止 Computer 级 TAT；目标 Agent 由 Assignment 集合差异退出。
func (service *Service) Delete(
	ctx context.Context,
	command DeleteCommand,
) (agentport.Operation, error) {
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.AgentID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" {
		return agentport.Operation{},
			apperror.New("invalid_request", "Agent 删除参数无效", nil)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return agentport.Operation{},
			apperror.New("internal_error", "暂时无法删除 Agent", err)
	}
	operation, err := service.repository.Delete(ctx, agentport.DeleteCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		AgentID:        command.AgentID,
		IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		RequestHash:    sha256.Sum256([]byte("agent.delete")),
		OperationID:    operationID,
		DeletedAt:      service.clock.Now().UTC(),
	})
	if err != nil {
		return agentport.Operation{}, mapRepositoryError(err)
	}
	return operation, nil
}

func (service *Service) Lifecycle(
	ctx context.Context,
	command LifecycleCommand,
) (agentport.Operation, error) {
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.AgentID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" {
		return agentport.Operation{},
			apperror.New("invalid_request", "Agent 生命周期参数无效", nil)
	}
	kind, ok := lifecycleKind(command.Kind)
	if !ok {
		return agentport.Operation{},
			apperror.New("invalid_request", "Agent 生命周期类型无效", nil)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return agentport.Operation{},
			apperror.New("internal_error", "暂时无法提交 Agent 操作", err)
	}
	repositoryCommand := agentport.LifecycleCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		AgentID:        command.AgentID,
		Kind:           kind,
		IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		RequestHash:    sha256.Sum256([]byte(kind)),
		OperationID:    operationID,
		CreatedAt:      service.clock.Now().UTC(),
	}
	operation, err := service.repository.ApplyLifecycle(ctx, repositoryCommand)
	if errors.Is(err, agentport.ErrCredentialMissing) &&
		(kind == "agent.start" || kind == "agent.restart") {
		if _, rotateErr := service.RotateCredential(ctx, CredentialCommand{
			AccountID:      command.AccountID,
			ServerID:       command.ServerID,
			AgentID:        command.AgentID,
			IdempotencyKey: command.IdempotencyKey,
		}); rotateErr != nil {
			return agentport.Operation{}, rotateErr
		}
		operation, err = service.repository.ApplyLifecycle(ctx, repositoryCommand)
	}
	if err != nil {
		return agentport.Operation{}, mapRepositoryError(err)
	}
	return operation, nil
}

func (service *Service) RotateCredential(
	ctx context.Context,
	command CredentialCommand,
) (agentport.Operation, error) {
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.AgentID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" {
		return agentport.Operation{},
			apperror.New("invalid_request", "Agent credential 参数无效", nil)
	}
	current, err := service.repository.Get(
		ctx,
		command.AccountID,
		command.ServerID,
		command.AgentID,
	)
	if err != nil {
		return agentport.Operation{}, mapRepositoryError(err)
	}
	if current.CredentialVersion < 0 ||
		current.CredentialVersion == math.MaxInt64 {
		return agentport.Operation{},
			apperror.New("revision_conflict", "Agent credential 版本无效", nil)
	}
	version := current.CredentialVersion + 1
	credentialID, err := service.ids.New()
	if err != nil {
		return agentport.Operation{},
			apperror.New("internal_error", "暂时无法轮换 credential", err)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return agentport.Operation{},
			apperror.New("internal_error", "暂时无法轮换 credential", err)
	}
	secret := make([]byte, 32)
	if _, err := io.ReadFull(service.random, secret); err != nil {
		return agentport.Operation{},
			apperror.New("internal_error", "暂时无法轮换 credential", err)
	}
	digest := sha256.Sum256(secret)
	clear(secret)
	now := service.clock.Now().UTC()
	result, err := service.repository.RotateCredential(
		ctx,
		agentport.CredentialCommand{
			AccountID:      command.AccountID,
			ServerID:       command.ServerID,
			AgentID:        command.AgentID,
			Version:        version,
			CredentialID:   credentialID,
			SecretHash:     digest,
			IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
			RequestHash: sha256.Sum256(
				[]byte("agent.credential.rotate"),
			),
			OperationID: operationID,
			CreatedAt:   now,
		},
	)
	if err != nil {
		return agentport.Operation{}, mapRepositoryError(err)
	}
	return result.Operation, nil
}

func validateCreate(command CreateCommand) error {
	name := strings.TrimSpace(command.DisplayName)
	handle := strings.TrimSpace(command.Handle)
	replyPolicy := strings.TrimSpace(command.ReplyPolicy)
	if replyPolicy == "" {
		replyPolicy = "mention_and_dm"
	}
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" ||
		name == "" || len(name) > 100 || !utf8.ValidString(name) ||
		!agentHandlePattern.MatchString(handle) ||
		command.ComputerID == nil || !validUUIDv7(*command.ComputerID) ||
		!validRuntime(command.Runtime) ||
		!validReplyPolicy(replyPolicy) {
		return apperror.New("invalid_request", "Agent 创建参数无效", nil)
	}
	if command.Description != nil &&
		(!utf8.ValidString(*command.Description) ||
			len(strings.TrimSpace(*command.Description)) > 1000) {
		return apperror.New("invalid_request", "Agent 描述无效", nil)
	}
	return nil
}

func validateUpdate(command UpdateCommand) error {
	hasPatch := command.DisplayName != nil ||
		command.DescriptionSet ||
		command.ComputerIDSet ||
		command.Runtime != nil ||
		command.ReplyPolicy != nil
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.AgentID) ||
		command.Revision < 1 ||
		strings.TrimSpace(command.IdempotencyKey) == "" ||
		!hasPatch {
		return apperror.New("invalid_request", "Agent 更新参数无效", nil)
	}
	if command.DisplayName != nil {
		name := strings.TrimSpace(*command.DisplayName)
		if name == "" || len(name) > 100 || !utf8.ValidString(name) {
			return apperror.New("invalid_request", "Agent 显示名称无效", nil)
		}
	}
	if command.DescriptionSet && command.Description != nil &&
		(!utf8.ValidString(*command.Description) ||
			len(strings.TrimSpace(*command.Description)) > 1000) {
		return apperror.New("invalid_request", "Agent 描述无效", nil)
	}
	if command.ComputerIDSet &&
		(command.ComputerID == nil || !validUUIDv7(*command.ComputerID)) {
		return apperror.New("invalid_request", "Computer ID 无效", nil)
	}
	if command.Runtime != nil && !validRuntime(*command.Runtime) {
		return apperror.New("invalid_request", "Agent Runtime 无效", nil)
	}
	if command.ReplyPolicy != nil &&
		!validReplyPolicy(strings.TrimSpace(*command.ReplyPolicy)) {
		return apperror.New("invalid_request", "Agent 回复策略无效", nil)
	}
	return nil
}

func validRuntime(value agentport.Runtime) bool {
	switch value.Kind {
	case "codex", "hermes-acp", "hermes-gateway":
	default:
		return false
	}
	return value.Model == nil ||
		(utf8.ValidString(*value.Model) &&
			len(strings.TrimSpace(*value.Model)) <= 100)
}

func validReplyPolicy(value string) bool {
	return value == "mention_and_dm" ||
		value == "all_channel_messages" ||
		value == "dm_only"
}

func lifecycleKind(value string) (string, bool) {
	switch strings.TrimSpace(value) {
	case "deploy", "start", "stop", "restart":
		return "agent." + strings.TrimSpace(value), true
	default:
		return "", false
	}
}

func canManage(role string) bool {
	return role == "owner" || role == "admin"
}

func createHash(command CreateCommand, replyPolicy string) [32]byte {
	description := ""
	if command.Description != nil {
		description = strings.TrimSpace(*command.Description)
	}
	computerID := ""
	if command.ComputerID != nil {
		computerID = strings.TrimSpace(*command.ComputerID)
	}
	model := ""
	if command.Runtime.Model != nil {
		model = strings.TrimSpace(*command.Runtime.Model)
	}
	return sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(command.DisplayName),
		strings.TrimSpace(command.Handle),
		description,
		computerID,
		command.Runtime.Kind,
		model,
		replyPolicy,
	}, "\x00")))
}

func updateHash(command UpdateCommand) [32]byte {
	value := func(item *string) string {
		if item == nil {
			return "<absent>"
		}
		return strings.TrimSpace(*item)
	}
	runtimeKind, runtimeModel := "<absent>", "<absent>"
	if command.Runtime != nil {
		runtimeKind = strings.TrimSpace(command.Runtime.Kind)
		runtimeModel = value(command.Runtime.Model)
	}
	return sha256.Sum256([]byte(strings.Join([]string{
		fmt.Sprint(command.Revision),
		value(command.DisplayName),
		fmt.Sprint(command.DescriptionSet),
		value(command.Description),
		fmt.Sprint(command.ComputerIDSet),
		value(command.ComputerID),
		runtimeKind,
		runtimeModel,
		value(command.ReplyPolicy),
	}, "\x00")))
}

func normalizedText(value *string) *string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	return &normalized
}

func normalizedID(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	return &normalized
}

func normalizedRuntime(value agentport.Runtime) agentport.Runtime {
	value.Kind = strings.TrimSpace(value.Kind)
	value.Model = normalizedText(value.Model)
	return value
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func mapRepositoryError(err error) error {
	switch {
	case errors.Is(err, agentport.ErrServerNotFound):
		return apperror.New("server_not_found", "Server 不存在", err)
	case errors.Is(err, agentport.ErrAgentNotFound):
		return apperror.New("agent_not_found", "Agent 不存在", err)
	case errors.Is(err, agentport.ErrAgentNotReady):
		return apperror.New("agent_not_ready", "Agent IM 尚未就绪", err)
	case errors.Is(err, agentport.ErrComputerNotReady):
		return apperror.New("computer_not_ready", "Computer 尚未就绪", err)
	case errors.Is(err, agentport.ErrPermissionDenied):
		return apperror.New("permission_denied", "没有管理 Agent 的权限", err)
	case errors.Is(err, agentport.ErrHandleConflict):
		return apperror.New("revision_conflict", "Agent handle 已存在", err)
	case errors.Is(err, agentport.ErrRevisionConflict):
		return apperror.New("revision_conflict", "Agent 已被其他请求修改", err)
	case errors.Is(err, agentport.ErrAgentMustBeStopped):
		return apperror.New(
			"revision_conflict",
			"请先停止 Agent，再修改 Runtime 或 Computer",
			err,
		)
	case errors.Is(err, agentport.ErrIdempotencyConflict):
		return apperror.New(
			"idempotency_conflict",
			"幂等键与原请求不一致",
			err,
		)
	case errors.Is(err, agentport.ErrCredentialPending):
		return apperror.New(
			"revision_conflict",
			"Agent credential 正在安装",
			err,
		)
	case errors.Is(err, agentport.ErrCredentialMissing):
		return apperror.New(
			"agent_not_ready",
			"Agent credential 尚未安装",
			err,
		)
	default:
		return apperror.New("internal_error", "暂时无法处理 Agent", err)
	}
}
