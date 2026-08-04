// Package servermember 实现 Server、Owner Member 和 Community 创建用例。
package servermember

import (
	"context"
	"crypto/sha256"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	servermemberport "chatserver/internal/ports/servermember"
)

type serverRepository interface {
	Create(
		context.Context,
		servermemberport.CreateCommand,
	) (servermemberport.CreateResult, error)
	Update(
		context.Context,
		servermemberport.UpdateCommand,
	) (servermemberport.Server, error)
}

type resourceDeriver interface {
	CommunityGroupID(string) (string, error)
	Topic(string, string, string) (string, string, error)
}

// CreationObserver 等待已提交的 Community operation 在有界窗口内收敛。
type CreationObserver interface {
	Await(
		context.Context,
		string,
		string,
		string,
		time.Duration,
	) (CreationObservation, error)
}

// Operation 是创建响应需要公开的副作用状态。
type Operation struct {
	ID            string
	Service       string
	Kind          string
	State         string
	CreatedAt     time.Time
	CompletedAt   *time.Time
	LastErrorCode string
}

// CreationObservation 是 Server 与 Community operation 的同一时刻快照。
type CreationObservation struct {
	Server    servermemberport.Server
	Operation Operation
}

// Config 配置同步体验的最长等待窗口。
type Config struct {
	CreationWait time.Duration
}

// CreateCommand 是当前 Human 的 Server 创建命令。
type CreateCommand struct {
	AccountID      string
	IdempotencyKey string
	Slug           string
	Name           string
	Description    *string
}

// CreateResult 同时表达 ready 201 和 accepted 202。
type CreateResult struct {
	Ready     bool
	Server    servermemberport.Server
	Operation Operation
}

// UpdateCommand 是 Human 修改 Server 展示元数据的输入。
type UpdateCommand struct {
	AccountID      string
	ServerID       string
	Revision       int64
	IdempotencyKey string
	Name           *string
	DescriptionSet bool
	Description    *string
}

// Service 编排稳定 ID、本地事务和有界 Community 等待。
type Service struct {
	repository serverRepository
	observer   CreationObserver
	resources  resourceDeriver
	ids        idport.Generator
	clock      clockport.Clock
	config     Config
}

// NewService 创建 Server/Member 应用服务。
func NewService(
	repository serverRepository,
	observer CreationObserver,
	resources resourceDeriver,
	ids idport.Generator,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || observer == nil || resources == nil ||
		ids == nil || clock == nil || config.CreationWait <= 0 {
		return nil, errors.New("Server 服务配置无效")
	}
	return &Service{
		repository: repository,
		observer:   observer,
		resources:  resources,
		ids:        ids,
		clock:      clock,
		config:     config,
	}, nil
}

// Update 修改平台内的 Server 展示元数据，不改变稳定 slug 或腾讯 IM 路由。
func (service *Service) Update(
	ctx context.Context,
	command UpdateCommand,
) (servermemberport.Server, error) {
	if err := validateUpdate(command); err != nil {
		return servermemberport.Server{}, err
	}
	name := ""
	nameSet := command.Name != nil
	if nameSet {
		name = strings.TrimSpace(*command.Name)
	}
	description := command.Description
	if command.DescriptionSet {
		description = normalizedDescription(command.Description)
	}
	value, err := service.repository.Update(ctx, servermemberport.UpdateCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		Revision:       command.Revision,
		IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		RequestHash:    updateRequestHash(command),
		NameSet:        nameSet,
		Name:           name,
		DescriptionSet: command.DescriptionSet,
		Description:    description,
		UpdatedAt:      service.clock.Now().UTC(),
	})
	if err != nil {
		return servermemberport.Server{}, mapUpdateError(err)
	}
	return value, nil
}

func validateUpdate(command UpdateCommand) error {
	if !isUUIDv7(command.AccountID) || !isUUIDv7(command.ServerID) ||
		command.Revision < 1 || strings.TrimSpace(command.IdempotencyKey) == "" ||
		(command.Name == nil && !command.DescriptionSet) {
		return apperror.New("invalid_request", "Server 修改参数无效", nil)
	}
	if command.Name != nil {
		name := strings.TrimSpace(*command.Name)
		if name == "" || len(name) > 100 || !utf8.ValidString(name) {
			return apperror.New("invalid_request", "Server 名称无效", nil)
		}
	}
	if command.DescriptionSet && command.Description != nil &&
		(!utf8.ValidString(*command.Description) ||
			len(strings.TrimSpace(*command.Description)) > 1000) {
		return apperror.New("invalid_request", "Server 描述无效", nil)
	}
	return nil
}

func normalizedDescription(value *string) *string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	return &normalized
}

func updateRequestHash(command UpdateCommand) [32]byte {
	nameMarker, name := "0", ""
	if command.Name != nil {
		nameMarker, name = "1", strings.TrimSpace(*command.Name)
	}
	descriptionMarker, description := "0", ""
	if command.DescriptionSet {
		descriptionMarker = "1"
		if command.Description != nil {
			description = strings.TrimSpace(*command.Description)
		}
	}
	return sha256.Sum256([]byte(strings.Join([]string{
		strconv.FormatInt(command.Revision, 10),
		nameMarker,
		name,
		descriptionMarker,
		description,
	}, "\x00")))
}

func mapUpdateError(err error) error {
	switch {
	case errors.Is(err, servermemberport.ErrServerNotFound):
		return apperror.New("server_not_found", "Server 不存在", err)
	case errors.Is(err, servermemberport.ErrPermissionDenied):
		return apperror.New("permission_denied", "没有管理 Server 的权限", err)
	case errors.Is(err, servermemberport.ErrRevisionConflict):
		return apperror.New(
			"revision_conflict",
			"Server 已被其他操作修改，请刷新后重试",
			err,
		)
	case errors.Is(err, servermemberport.ErrIdempotencyConflict):
		return apperror.New("idempotency_conflict", "幂等键与原请求不一致", err)
	default:
		return apperror.New("internal_error", "暂时无法修改 Server", err)
	}
}

// Create 先提交本地事实，再最多等待 Community 在窗口内 ready。
func (service *Service) Create(
	ctx context.Context,
	command CreateCommand,
) (CreateResult, error) {
	if !isUUIDv7(command.AccountID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" ||
		strings.TrimSpace(command.Slug) == "" ||
		strings.TrimSpace(command.Name) == "" {
		return CreateResult{}, apperror.New(
			"invalid_request",
			"Server 创建参数无效",
			nil,
		)
	}
	serverID, memberID, channelID, operationID, rootTopicOperationID, err := service.newIDs()
	if err != nil {
		return CreateResult{}, apperror.New(
			"internal_error",
			"暂时无法创建 Server",
			err,
		)
	}
	groupID, err := service.resources.CommunityGroupID(serverID)
	if err != nil {
		return CreateResult{}, apperror.New(
			"internal_error",
			"暂时无法创建 Server",
			err,
		)
	}
	rootTopicID, _, err := service.resources.Topic(serverID, channelID, groupID)
	if err != nil {
		return CreateResult{}, apperror.New(
			"internal_error",
			"暂时无法创建全员频道",
			err,
		)
	}
	handle, err := DeriveHumanHandle(command.AccountID, memberID)
	if err != nil {
		return CreateResult{}, apperror.New(
			"internal_error",
			"暂时无法创建 Server",
			err,
		)
	}
	created, err := service.repository.Create(
		ctx,
		servermemberport.CreateCommand{
			AccountID:      command.AccountID,
			IdempotencyKey: command.IdempotencyKey,
			RequestHash:    createRequestHash(command),
			CreatedAt:      service.clock.Now().UTC(),
			Server: servermemberport.ServerDraft{
				ID:            serverID,
				Slug:          command.Slug,
				Name:          command.Name,
				Description:   command.Description,
				IMGroupID:     groupID,
				OwnerMemberID: memberID,
			},
			Owner: servermemberport.OwnerDraft{
				ID:     memberID,
				Handle: handle,
			},
			RootChannelID:        channelID,
			RootChannelTopicID:   rootTopicID,
			OperationID:          operationID,
			RootTopicOperationID: rootTopicOperationID,
		},
	)
	if err != nil {
		return CreateResult{}, mapCreateError(err)
	}
	observation, err := service.observer.Await(
		ctx,
		command.AccountID,
		created.ServerID,
		created.OperationID,
		service.config.CreationWait,
	)
	if err != nil {
		return CreateResult{}, err
	}
	switch observation.Operation.State {
	case "succeeded":
		return CreateResult{
			Ready:     true,
			Server:    observation.Server,
			Operation: observation.Operation,
		}, nil
	case "failed":
		return CreateResult{}, apperror.New(
			"tencent_unavailable",
			"腾讯云 IM Community 创建失败",
			nil,
		)
	default:
		return CreateResult{
			Server:    observation.Server,
			Operation: observation.Operation,
		}, nil
	}
}

func (service *Service) newIDs() (
	serverID string,
	memberID string,
	channelID string,
	operationID string,
	rootTopicOperationID string,
	err error,
) {
	values := []*string{
		&serverID,
		&memberID,
		&channelID,
		&operationID,
		&rootTopicOperationID,
	}
	for _, value := range values {
		*value, err = service.ids.New()
		if err != nil {
			return "", "", "", "", "", err
		}
	}
	return serverID, memberID, channelID, operationID, rootTopicOperationID, nil
}

func createRequestHash(command CreateCommand) [32]byte {
	input := appendLP(nil, command.Slug)
	input = appendLP(input, command.Name)
	if command.Description == nil {
		input = append(input, 0)
	} else {
		input = append(input, 1)
		input = appendLP(input, *command.Description)
	}
	return sha256.Sum256(input)
}

func mapCreateError(err error) error {
	switch {
	case errors.Is(err, servermemberport.ErrAccountIMNotReady):
		return apperror.New(
			"im_identity_not_ready",
			"账号 IM 身份尚未就绪",
			err,
		)
	case errors.Is(err, servermemberport.ErrServerSlugConflict):
		return apperror.New(
			"revision_conflict",
			"Server slug 已被使用",
			err,
		)
	case errors.Is(err, servermemberport.ErrIdempotencyConflict):
		return apperror.New(
			"idempotency_conflict",
			"幂等键与原请求不一致",
			err,
		)
	case errors.Is(err, servermemberport.ErrAccountNotFound):
		return apperror.New("session_revoked", "登录会话已失效", err)
	default:
		return apperror.New("internal_error", "暂时无法创建 Server", err)
	}
}
