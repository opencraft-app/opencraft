// Package channelmanagement 实现 Channel 与腾讯 IM Topic 的最小管理面。
package channelmanagement

import (
	"context"
	"crypto/sha256"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"chatserver/internal/apperror"
	channelport "chatserver/internal/ports/channel"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"

	"github.com/google/uuid"
)

// CreateCommand 是 Human 创建普通 Channel 的输入。
type CreateCommand struct {
	AccountID      string
	ServerID       string
	IdempotencyKey string
	Name           string
	Description    *string
	Visibility     string
}

// UpdateCommand 是 Human 修改 Channel 元数据的输入。
type UpdateCommand struct {
	AccountID      string
	ServerID       string
	ChannelID      string
	Revision       int64
	IdempotencyKey string
	Name           *string
	DescriptionSet bool
	Description    *string
}

type topicDeriver interface {
	Topic(string, string, string) (string, string, error)
}

// Service 只保存 Channel 元数据并提交固定 Topic ensure 操作。
type Service struct {
	repository channelport.Repository
	resources  topicDeriver
	ids        idport.Generator
	clock      clockport.Clock
}

// NewService 创建 Channel 应用服务。
func NewService(
	repository channelport.Repository,
	resources topicDeriver,
	ids idport.Generator,
	clock clockport.Clock,
) (*Service, error) {
	if repository == nil || resources == nil || ids == nil || clock == nil {
		return nil, errors.New("Channel 服务配置无效")
	}
	return &Service{
		repository: repository,
		resources:  resources,
		ids:        ids,
		clock:      clock,
	}, nil
}

// Create 创建 provisioning Channel，并可靠建立腾讯 Topic。
func (service *Service) Create(
	ctx context.Context,
	command CreateCommand,
) (channelport.CreateResult, error) {
	if err := validateCreate(command); err != nil {
		return channelport.CreateResult{}, err
	}
	serverContext, err := service.repository.GetServerContext(
		ctx,
		command.AccountID,
		command.ServerID,
	)
	if err != nil {
		return channelport.CreateResult{}, mapRepositoryError(err)
	}
	if serverContext.IMState != "ready" {
		return channelport.CreateResult{},
			apperror.New("server_not_ready", "Server IM 尚未就绪", nil)
	}
	if serverContext.Role != "owner" && serverContext.Role != "admin" {
		return channelport.CreateResult{},
			apperror.New("permission_denied", "没有管理 Channel 的权限", nil)
	}
	channelID, err := service.ids.New()
	if err != nil {
		return channelport.CreateResult{},
			apperror.New("internal_error", "暂时无法创建 Channel", err)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return channelport.CreateResult{},
			apperror.New("internal_error", "暂时无法创建 Channel", err)
	}
	initialChannelMemberID, err := service.ids.New()
	if err != nil {
		return channelport.CreateResult{},
			apperror.New("internal_error", "暂时无法创建 Channel", err)
	}
	initialMembershipOperationID, err := service.ids.New()
	if err != nil {
		return channelport.CreateResult{},
			apperror.New("internal_error", "暂时无法创建 Channel", err)
	}
	topicID, topicName, err := service.resources.Topic(
		command.ServerID,
		channelID,
		serverContext.IMGroupID,
	)
	if err != nil {
		return channelport.CreateResult{},
			apperror.New("internal_error", "无法生成 IM Topic 标识", err)
	}
	result, err := service.repository.Create(ctx, channelport.CreateCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		RequestHash:    createHash(command),
		Channel: channelport.Draft{
			ID:          channelID,
			Name:        strings.TrimSpace(command.Name),
			Description: normalizedDescription(command.Description),
			Visibility:  command.Visibility,
			IMGroupID:   serverContext.IMGroupID,
			IMTopicID:   topicID,
			IMTopicName: topicName,
		},
		OperationID:                  operationID,
		InitialChannelMemberID:       initialChannelMemberID,
		InitialMembershipOperationID: initialMembershipOperationID,
		CreatedAt:                    service.clock.Now().UTC(),
	})
	if err != nil {
		return channelport.CreateResult{}, mapRepositoryError(err)
	}
	return result, nil
}

// List 列出当前账号可见的 Server Channel。
func (service *Service) List(
	ctx context.Context,
	accountID string,
	serverID string,
) ([]channelport.Channel, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) {
		return nil, apperror.New("invalid_request", "Channel 列表参数无效", nil)
	}
	values, err := service.repository.List(ctx, accountID, serverID)
	if err != nil {
		return nil, mapRepositoryError(err)
	}
	return values, nil
}

// Get 返回一个经过 membership 授权的 Channel。
func (service *Service) Get(
	ctx context.Context,
	accountID string,
	serverID string,
	channelID string,
) (channelport.Channel, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) ||
		!validUUIDv7(channelID) {
		return channelport.Channel{},
			apperror.New("invalid_request", "Channel 查询参数无效", nil)
	}
	value, err := service.repository.Get(ctx, accountID, serverID, channelID)
	if err != nil {
		return channelport.Channel{}, mapRepositoryError(err)
	}
	return value, nil
}

// Update 修改平台 Channel 元数据；IM Topic 使用稳定技术名称，不随展示名变化。
func (service *Service) Update(
	ctx context.Context,
	command UpdateCommand,
) (channelport.Channel, error) {
	if err := validateUpdate(command); err != nil {
		return channelport.Channel{}, err
	}
	current, err := service.repository.Get(
		ctx,
		command.AccountID,
		command.ServerID,
		command.ChannelID,
	)
	if err != nil {
		return channelport.Channel{}, mapRepositoryError(err)
	}
	if current.SystemKey != nil {
		return channelport.Channel{}, apperror.New(
			"system_channel_immutable",
			"系统 #全员的元数据由 Server 管理",
			nil,
		)
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
	value, err := service.repository.Update(ctx, channelport.UpdateCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		ChannelID:      command.ChannelID,
		Revision:       command.Revision,
		IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		RequestHash:    updateHash(command),
		NameSet:        nameSet,
		Name:           name,
		DescriptionSet: command.DescriptionSet,
		Description:    description,
		UpdatedAt:      service.clock.Now().UTC(),
	})
	if err != nil {
		return channelport.Channel{}, mapRepositoryError(err)
	}
	return value, nil
}

func validateCreate(command CreateCommand) error {
	name := strings.TrimSpace(command.Name)
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" ||
		name == "" || len(name) > 100 || !utf8.ValidString(name) ||
		(command.Visibility != "public" &&
			command.Visibility != "private") {
		return apperror.New("invalid_request", "Channel 创建参数无效", nil)
	}
	if command.Description != nil &&
		(!utf8.ValidString(*command.Description) ||
			len(strings.TrimSpace(*command.Description)) > 1000) {
		return apperror.New("invalid_request", "Channel 描述无效", nil)
	}
	return nil
}

func validateUpdate(command UpdateCommand) error {
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.ChannelID) ||
		command.Revision < 1 ||
		strings.TrimSpace(command.IdempotencyKey) == "" ||
		(command.Name == nil && !command.DescriptionSet) {
		return apperror.New("invalid_request", "Channel 修改参数无效", nil)
	}
	if command.Name != nil {
		name := strings.TrimSpace(*command.Name)
		if name == "" || len(name) > 100 || !utf8.ValidString(name) {
			return apperror.New("invalid_request", "Channel 名称无效", nil)
		}
	}
	if command.DescriptionSet && command.Description != nil &&
		(!utf8.ValidString(*command.Description) ||
			len(strings.TrimSpace(*command.Description)) > 1000) {
		return apperror.New("invalid_request", "Channel 描述无效", nil)
	}
	return nil
}

func createHash(command CreateCommand) [32]byte {
	description := ""
	if command.Description != nil {
		description = strings.TrimSpace(*command.Description)
	}
	return sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(command.Name),
		description,
		command.Visibility,
	}, "\x00")))
}

func updateHash(command UpdateCommand) [32]byte {
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

func normalizedDescription(value *string) *string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	return &normalized
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func mapRepositoryError(err error) error {
	switch {
	case errors.Is(err, channelport.ErrServerNotFound):
		return apperror.New("server_not_found", "Server 不存在", err)
	case errors.Is(err, channelport.ErrServerNotReady):
		return apperror.New("server_not_ready", "Server IM 尚未就绪", err)
	case errors.Is(err, channelport.ErrPermissionDenied):
		return apperror.New("permission_denied", "没有管理 Channel 的权限", err)
	case errors.Is(err, channelport.ErrChannelNotFound):
		return apperror.New("channel_not_found", "Channel 不存在", err)
	case errors.Is(err, channelport.ErrChannelNameConflict):
		return apperror.New("revision_conflict", "Channel 名称已存在", err)
	case errors.Is(err, channelport.ErrRevisionConflict):
		return apperror.New(
			"revision_conflict",
			"Channel 已被其他操作修改，请刷新后重试",
			err,
		)
	case errors.Is(err, channelport.ErrIdempotencyConflict):
		return apperror.New(
			"idempotency_conflict",
			"幂等键与原请求不一致",
			err,
		)
	default:
		return apperror.New("internal_error", "暂时无法处理 Channel", err)
	}
}
