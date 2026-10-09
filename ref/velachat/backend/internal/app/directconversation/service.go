// Package directconversation 管理 Server 内双成员私信的 authority 映射。
package directconversation

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"chatserver/internal/apperror"
	"chatserver/internal/pagination"
	clockport "chatserver/internal/ports/clock"
	directport "chatserver/internal/ports/directconversation"
	idport "chatserver/internal/ports/id"

	"github.com/google/uuid"
)

type CreateCommand struct {
	AccountID      string
	ServerID       string
	PeerMemberID   string
	IdempotencyKey string
}

type RetryCommand struct {
	AccountID            string
	ServerID             string
	DirectConversationID string
	IdempotencyKey       string
}

type directGroupDeriver interface {
	DirectGroupID(string, string) (string, error)
}

type Service struct {
	repository directport.Repository
	resources  directGroupDeriver
	ids        idport.Generator
	clock      clockport.Clock
}

func NewService(
	repository directport.Repository,
	resources directGroupDeriver,
	ids idport.Generator,
	clock clockport.Clock,
) (*Service, error) {
	if repository == nil || resources == nil || ids == nil || clock == nil {
		return nil, errors.New("Server 内私信服务配置无效")
	}
	return &Service{repository: repository, resources: resources, ids: ids, clock: clock}, nil
}

func (service *Service) Create(
	ctx context.Context,
	command CreateCommand,
) (directport.CreateResult, error) {
	if !validUUIDv7(command.AccountID) || !validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.PeerMemberID) || strings.TrimSpace(command.IdempotencyKey) == "" {
		return directport.CreateResult{}, apperror.New("invalid_request", "私信创建参数无效", nil)
	}
	participants, err := service.repository.ResolveParticipants(
		ctx, command.AccountID, command.ServerID, command.PeerMemberID,
	)
	if err != nil {
		return directport.CreateResult{}, mapRepositoryError(err)
	}
	if participants.Self.ID == participants.Peer.ID ||
		participants.Self.ServerID != command.ServerID || participants.Peer.ServerID != command.ServerID ||
		participants.Self.Status != "active" || participants.Peer.Status != "active" ||
		participants.Self.IMState != "ready" || participants.Peer.IMState != "ready" ||
		strings.TrimSpace(participants.Self.IMUserID) == "" || strings.TrimSpace(participants.Peer.IMUserID) == "" {
		return directport.CreateResult{}, apperror.New("invalid_request", "私信参与者无效或尚未就绪", nil)
	}
	directID, err := service.ids.New()
	if err != nil {
		return directport.CreateResult{}, apperror.New("internal_error", "暂时无法创建私信", err)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return directport.CreateResult{}, apperror.New("internal_error", "暂时无法创建私信", err)
	}
	groupID, err := service.resources.DirectGroupID(command.ServerID, directID)
	if err != nil {
		return directport.CreateResult{}, apperror.New("internal_error", "无法生成私信 IM 标识", err)
	}
	memberAID, memberBID := participants.Self.ID, participants.Peer.ID
	if memberAID > memberBID {
		memberAID, memberBID = memberBID, memberAID
	}
	result, err := service.repository.Create(ctx, directport.CreateCommand{
		AccountID: command.AccountID, ServerID: command.ServerID,
		PeerMemberID: command.PeerMemberID, MemberAID: memberAID, MemberBID: memberBID,
		DirectConversationID: directID, IMGroupID: groupID, OperationID: operationID,
		IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		RequestHash:    sha256.Sum256([]byte(command.PeerMemberID)),
		CreatedAt:      service.clock.Now().UTC(),
	})
	if err != nil {
		return directport.CreateResult{}, mapRepositoryError(err)
	}
	return result, nil
}

func (service *Service) Retry(
	ctx context.Context,
	command RetryCommand,
) (directport.CreateResult, error) {
	if !validUUIDv7(command.AccountID) || !validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.DirectConversationID) || strings.TrimSpace(command.IdempotencyKey) == "" {
		return directport.CreateResult{}, apperror.New("invalid_request", "私信恢复参数无效", nil)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return directport.CreateResult{}, apperror.New("internal_error", "暂时无法恢复私信", err)
	}
	result, err := service.repository.Retry(ctx, directport.RetryCommand{
		AccountID: command.AccountID, ServerID: command.ServerID,
		DirectConversationID: command.DirectConversationID,
		OperationID:          operationID, IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
		RequestHash: sha256.Sum256([]byte(command.DirectConversationID)),
		RequestedAt: service.clock.Now().UTC(),
	})
	if err != nil {
		return directport.CreateResult{}, mapRepositoryError(err)
	}
	return result, nil
}

func (service *Service) List(
	ctx context.Context,
	request directport.PageRequest,
) (directport.Page, error) {
	if !validUUIDv7(request.AccountID) || !validUUIDv7(request.ServerID) || request.Limit < 1 || request.Limit > 100 {
		return directport.Page{}, apperror.New("invalid_request", "私信列表参数无效", nil)
	}
	filter := fmt.Sprintf("account=%s&server=%s", request.AccountID, request.ServerID)
	if request.Cursor != "" {
		values, err := pagination.Decode(request.Cursor, "listDirectConversations", filter, 2)
		if err != nil || !validUUIDv7(values[1]) {
			return directport.Page{}, apperror.New("invalid_cursor", "私信分页游标无效", err)
		}
		updatedAt, parseErr := time.Parse(time.RFC3339Nano, values[0])
		if parseErr != nil {
			return directport.Page{}, apperror.New("invalid_cursor", "私信分页游标无效", parseErr)
		}
		request.AfterUpdatedAt, request.AfterID = &updatedAt, values[1]
	}
	page, err := service.repository.List(ctx, request)
	if err != nil {
		return directport.Page{}, mapRepositoryError(err)
	}
	if page.NextUpdatedAt != nil && page.NextID != "" {
		next, encodeErr := pagination.Encode(
			"listDirectConversations", filter,
			page.NextUpdatedAt.UTC().Format(time.RFC3339Nano), page.NextID,
		)
		if encodeErr != nil {
			return directport.Page{}, apperror.New("internal_error", "暂时无法生成私信游标", encodeErr)
		}
		page.NextCursor = &next
	}
	return page, nil
}

func (service *Service) Get(
	ctx context.Context,
	accountID, serverID, directConversationID string,
) (directport.Conversation, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) || !validUUIDv7(directConversationID) {
		return directport.Conversation{}, apperror.New("invalid_request", "私信查询参数无效", nil)
	}
	value, err := service.repository.Get(ctx, accountID, serverID, directConversationID)
	if err != nil {
		return directport.Conversation{}, mapRepositoryError(err)
	}
	return value, nil
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func mapRepositoryError(err error) error {
	switch {
	case errors.Is(err, directport.ErrServerNotFound):
		return apperror.New("server_not_found", "Server 不存在", err)
	case errors.Is(err, directport.ErrMemberNotFound):
		return apperror.New("member_not_found", "私信成员不存在", err)
	case errors.Is(err, directport.ErrMemberRemoved):
		return apperror.New("member_removed", "私信成员已被移除", err)
	case errors.Is(err, directport.ErrIMIdentityNotReady):
		return apperror.New("im_identity_not_ready", "私信成员 IM 身份尚未就绪", err)
	case errors.Is(err, directport.ErrConversationNotFound):
		return apperror.New("resource_not_found", "私信不存在", err)
	case errors.Is(err, directport.ErrConversationClosing):
		return apperror.New("direct_conversation_closing", "私信正在关闭", err)
	case errors.Is(err, directport.ErrRetryNotAllowed):
		return apperror.New("invalid_request", "当前私信不需要恢复", err)
	case errors.Is(err, directport.ErrIdempotencyConflict):
		return apperror.New("idempotency_conflict", "幂等键与原请求不一致", err)
	default:
		return apperror.New("internal_error", "暂时无法处理私信", err)
	}
}
