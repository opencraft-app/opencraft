package servermember

import (
	"context"
	"errors"
	"fmt"
	"time"

	"chatserver/internal/apperror"
	"chatserver/internal/pagination"
	servermemberport "chatserver/internal/ports/servermember"
)

// QueryService 提供经过 membership 授权的 Server/Member 查询。
type QueryService struct{ repository servermemberport.Repository }

func NewQueryService(repository servermemberport.Repository) (*QueryService, error) {
	if repository == nil {
		return nil, errors.New("Server 查询 Repository 不能为空")
	}
	return &QueryService{repository: repository}, nil
}

func (service *QueryService) ListServers(
	ctx context.Context,
	accountID string,
	options servermemberport.ListOptions,
) (servermemberport.ServerPage, error) {
	if !isUUIDv7(accountID) || options.Limit < 0 {
		return servermemberport.ServerPage{},
			apperror.New("invalid_request", "Server 列表参数无效", nil)
	}
	if options.Cursor != "" {
		sort, err := pagination.Decode(options.Cursor, "listServers", "account="+accountID, 1)
		if err != nil || !isUUIDv7(sort[0]) {
			return servermemberport.ServerPage{}, apperror.New("invalid_cursor", "Server 分页游标无效", err)
		}
		options.AfterID = sort[0]
	}
	page, err := service.repository.ListServers(ctx, accountID, options)
	if err != nil {
		return servermemberport.ServerPage{},
			apperror.New("internal_error", "暂时无法读取 Server", err)
	}
	if page.NextCursor != "" {
		page.NextCursor, err = pagination.Encode("listServers", "account="+accountID, page.NextCursor)
		if err != nil {
			return servermemberport.ServerPage{}, apperror.New("internal_error", "暂时无法生成 Server 分页游标", err)
		}
	}
	return page, nil
}

func (service *QueryService) GetServer(
	ctx context.Context,
	accountID string,
	serverID string,
) (servermemberport.Server, error) {
	if !isUUIDv7(accountID) || !isUUIDv7(serverID) {
		return servermemberport.Server{},
			apperror.New("invalid_request", "Server 查询参数无效", nil)
	}
	value, err := service.repository.GetServer(ctx, accountID, serverID)
	if err != nil {
		return servermemberport.Server{}, mapQueryError(err)
	}
	return value, nil
}

func (service *QueryService) ListMembers(
	ctx context.Context,
	accountID string,
	serverID string,
	options servermemberport.ListOptions,
) (servermemberport.MemberPage, error) {
	if !isUUIDv7(accountID) || !isUUIDv7(serverID) ||
		options.Limit < 0 {
		return servermemberport.MemberPage{}, apperror.New("invalid_request", "成员列表参数无效", nil)
	}
	filter := fmt.Sprintf("account=%s&server=%s", accountID, serverID)
	if options.Cursor != "" {
		sort, err := pagination.Decode(options.Cursor, "listMembers", filter, 2)
		if err != nil || !isUUIDv7(sort[1]) {
			return servermemberport.MemberPage{}, apperror.New("invalid_cursor", "成员分页游标无效", err)
		}
		createdAt, parseErr := time.Parse(time.RFC3339Nano, sort[0])
		if parseErr != nil {
			return servermemberport.MemberPage{}, apperror.New("invalid_cursor", "成员分页游标无效", parseErr)
		}
		options.AfterCreatedAt = &createdAt
		options.AfterID = sort[1]
	}
	page, err := service.repository.ListMembers(
		ctx,
		accountID,
		serverID,
		options,
	)
	if err != nil {
		return servermemberport.MemberPage{}, mapQueryError(err)
	}
	if page.NextCreatedAt != nil && page.NextID != "" {
		page.NextCursor, err = pagination.Encode(
			"listMembers", filter, page.NextCreatedAt.UTC().Format(time.RFC3339Nano), page.NextID,
		)
		if err != nil {
			return servermemberport.MemberPage{}, apperror.New("internal_error", "暂时无法生成成员分页游标", err)
		}
	}
	return page, nil
}

// ListChannelMembers 返回普通 Channel 的显式 active Member。
func (service *QueryService) ListChannelMembers(
	ctx context.Context,
	accountID string,
	serverID string,
	channelID string,
	options servermemberport.ListOptions,
) ([]servermemberport.Member, error) {
	if !isUUIDv7(accountID) || !isUUIDv7(serverID) ||
		!isUUIDv7(channelID) || options.Limit < 0 ||
		(options.Cursor != "" && !isUUIDv7(options.Cursor)) {
		return nil,
			apperror.New("invalid_request", "Channel 成员列表参数无效", nil)
	}
	values, err := service.repository.ListChannelMembers(
		ctx,
		accountID,
		serverID,
		channelID,
		options,
	)
	if err != nil {
		return nil, mapQueryError(err)
	}
	return values, nil
}

func (service *QueryService) GetMember(
	ctx context.Context,
	accountID string,
	serverID string,
	memberID string,
) (servermemberport.Member, error) {
	if !isUUIDv7(accountID) || !isUUIDv7(serverID) || !isUUIDv7(memberID) {
		return servermemberport.Member{},
			apperror.New("invalid_request", "成员查询参数无效", nil)
	}
	value, err := service.repository.GetMember(
		ctx,
		accountID,
		serverID,
		memberID,
	)
	if err != nil {
		return servermemberport.Member{}, mapQueryError(err)
	}
	return value, nil
}

func mapQueryError(err error) error {
	switch {
	case errors.Is(err, servermemberport.ErrServerNotFound):
		return apperror.New("server_not_found", "Server 不存在", err)
	case errors.Is(err, servermemberport.ErrMemberNotFound):
		return apperror.New("member_not_found", "成员不存在", err)
	case errors.Is(err, servermemberport.ErrPermissionDenied):
		return apperror.New(
			"permission_denied",
			"没有读取该 Channel 成员的权限",
			err,
		)
	default:
		return apperror.New("internal_error", "暂时无法读取 Server", err)
	}
}
