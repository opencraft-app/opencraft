package httptransport

import (
	"context"
	"errors"
	"math"
	"strings"

	"chatserver/internal/api/openapi"
	appservermember "chatserver/internal/app/servermember"
	"chatserver/internal/apperror"
	servermemberport "chatserver/internal/ports/servermember"

	"github.com/google/uuid"
)

type serverCreator interface {
	Create(
		context.Context,
		appservermember.CreateCommand,
	) (appservermember.CreateResult, error)
	Update(
		context.Context,
		appservermember.UpdateCommand,
	) (servermemberport.Server, error)
}

// UpdateServer 修改平台内 Server 的展示名称和描述。
func (handler *ServerMemberHandler) UpdateServer(
	ctx context.Context,
	request openapi.UpdateServerRequestObject,
) (openapi.UpdateServerResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	revision, err := workRevision(request.Params.XResourceRevision)
	if err != nil {
		return nil, err
	}
	value, err := handler.creator.Update(ctx, appservermember.UpdateCommand{
		AccountID:      accountID,
		ServerID:       request.ServerId.String(),
		Revision:       revision,
		IdempotencyKey: string(request.Params.IdempotencyKey),
		Name:           request.Body.Name,
		DescriptionSet: request.Body.Description != nil,
		Description:    request.Body.Description,
	})
	if err != nil {
		return nil, err
	}
	body, err := serverDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateServer200JSONResponse{
		Body: body,
		Headers: openapi.UpdateServer200ResponseHeaders{
			XResourceRevision: body.Revision,
		},
	}, nil
}

type serverQueries interface {
	ListServers(
		context.Context,
		string,
		servermemberport.ListOptions,
	) (servermemberport.ServerPage, error)
	GetServer(
		context.Context,
		string,
		string,
	) (servermemberport.Server, error)
	ListMembers(
		context.Context,
		string,
		string,
		servermemberport.ListOptions,
	) (servermemberport.MemberPage, error)
	ListChannelMembers(
		context.Context,
		string,
		string,
		string,
		servermemberport.ListOptions,
	) ([]servermemberport.Member, error)
	GetMember(
		context.Context,
		string,
		string,
		string,
	) (servermemberport.Member, error)
}

// ServerMemberHandler 实现 v1 Server 与 Member 的精简 strict surface。
type ServerMemberHandler struct {
	openapi.StrictServerInterface
	creator serverCreator
	queries serverQueries
}

var _ openapi.StrictServerInterface = (*ServerMemberHandler)(nil)

// NewServerMemberHandler 创建 Server/Member strict handler。
func NewServerMemberHandler(
	creator serverCreator,
	queries serverQueries,
) (*ServerMemberHandler, error) {
	if creator == nil || queries == nil {
		return nil, errors.New("Server/Member 应用服务不能为空")
	}
	return &ServerMemberHandler{creator: creator, queries: queries}, nil
}

// CreateServer 先持久化本地事实，再按观察结果返回 201 或 202。
func (handler *ServerMemberHandler) CreateServer(
	ctx context.Context,
	request openapi.CreateServerRequestObject,
) (openapi.CreateServerResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	result, err := handler.creator.Create(
		ctx,
		appservermember.CreateCommand{
			AccountID:      accountID,
			IdempotencyKey: string(request.Params.IdempotencyKey),
			Slug:           request.Body.Slug,
			Name:           request.Body.Name,
			Description:    request.Body.Description,
		},
	)
	if err != nil {
		return nil, err
	}
	if result.Ready {
		body, err := serverDTO(result.Server)
		if err != nil {
			return nil, err
		}
		return openapi.CreateServer201JSONResponse(body), nil
	}
	resourceID, err := parseDomainID(result.Server.ID, "Server")
	if err != nil {
		return nil, err
	}
	operation, err := operationDTO(result.Operation)
	if err != nil {
		return nil, err
	}
	return openapi.CreateServer202JSONResponse{
		ResourceId: resourceID,
		Operations: []openapi.Operation{operation},
	}, nil
}

// ListServers 列出当前 Human active membership 指向的 Server。
func (handler *ServerMemberHandler) ListServers(
	ctx context.Context,
	request openapi.ListServersRequestObject,
) (openapi.ListServersResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	page, err := handler.queries.ListServers(
		ctx,
		accountID,
		listOptions(request.Params.Limit, request.Params.Cursor),
	)
	if err != nil {
		return nil, mapServerMemberQueryError(err)
	}
	items := make([]openapi.Server, 0, len(page.Items))
	for _, value := range page.Items {
		item, err := serverDTO(value)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	response := openapi.ListServers200JSONResponse{Items: items}
	if page.NextCursor != "" {
		cursor := openapi.NullableCursor(page.NextCursor)
		response.NextCursor = &cursor
	}
	return response, nil
}

// GetServer 返回当前 Human 可见的 Server。
func (handler *ServerMemberHandler) GetServer(
	ctx context.Context,
	request openapi.GetServerRequestObject,
) (openapi.GetServerResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	value, err := handler.queries.GetServer(
		ctx,
		accountID,
		request.ServerId.String(),
	)
	if err != nil {
		return nil, mapServerMemberQueryError(err)
	}
	body, err := serverDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetServer200JSONResponse(body), nil
}

// ListMembers 列出当前 Human 可见 Server 内的 active Member。
func (handler *ServerMemberHandler) ListMembers(
	ctx context.Context,
	request openapi.ListMembersRequestObject,
) (openapi.ListMembersResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	page, err := handler.queries.ListMembers(
		ctx,
		accountID,
		request.ServerId.String(),
		listOptions(request.Params.Limit, request.Params.Cursor),
	)
	if err != nil {
		return nil, mapServerMemberQueryError(err)
	}
	items := make([]openapi.Member, 0, len(page.Items))
	for _, value := range page.Items {
		item, err := memberDTO(value)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	var next *openapi.NullableCursor
	if page.NextCursor != "" {
		value := openapi.NullableCursor(page.NextCursor)
		next = &value
	}
	return openapi.ListMembers200JSONResponse{Items: items, NextCursor: next}, nil
}

// GetMember 返回当前 Human 可见 Server 内的单个 Member。
func (handler *ServerMemberHandler) GetMember(
	ctx context.Context,
	request openapi.GetMemberRequestObject,
) (openapi.GetMemberResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	value, err := handler.queries.GetMember(
		ctx,
		accountID,
		request.ServerId.String(),
		request.MemberId.String(),
	)
	if err != nil {
		return nil, mapServerMemberQueryError(err)
	}
	body, err := memberDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetMember200JSONResponse(body), nil
}

func currentHumanAccountID(ctx context.Context) (string, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return "", apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	return principal.AccountID(), nil
}

func listOptions(limit *openapi.Limit, cursor *openapi.Cursor) servermemberport.ListOptions {
	result := servermemberport.ListOptions{}
	if limit != nil {
		result.Limit = *limit
	}
	if cursor != nil {
		result.Cursor = string(*cursor)
	}
	return result
}

func serverDTO(value servermemberport.Server) (openapi.Server, error) {
	id, err := parseDomainID(value.ID, "Server")
	if err != nil {
		return openapi.Server{}, err
	}
	ownerID, err := parseDomainID(value.OwnerMemberID, "Owner Member")
	if err != nil {
		return openapi.Server{}, err
	}
	if value.Revision > math.MaxInt64 {
		return openapi.Server{}, invalidDomainData("Server 版本无效", nil)
	}
	imState := openapi.ServerImState(value.IMState)
	if !imState.Valid() {
		return openapi.Server{}, invalidDomainData("Server IM 状态无效", nil)
	}
	return openapi.Server{
		Id:            id,
		Slug:          value.Slug,
		Name:          value.Name,
		Description:   value.Description,
		OwnerMemberId: ownerID,
		ImState:       imState,
		Revision:      int64(value.Revision),
	}, nil
}

func memberDTO(value servermemberport.Member) (openapi.Member, error) {
	id, err := parseDomainID(value.ID, "Member")
	if err != nil {
		return openapi.Member{}, err
	}
	serverID, err := parseDomainID(value.ServerID, "Server")
	if err != nil {
		return openapi.Member{}, err
	}
	if value.Revision > math.MaxInt64 {
		return openapi.Member{}, invalidDomainData("Member 版本无效", nil)
	}
	result := openapi.Member{
		Id:          id,
		ServerId:    serverID,
		Kind:        openapi.MemberKind(value.Kind),
		Role:        openapi.MemberRole(value.Role),
		DisplayName: value.DisplayName,
		Handle:      value.Handle,
		Status:      openapi.MemberStatus(value.Status),
		ImState:     openapi.MemberImState(value.IMState),
		Revision:    int64(value.Revision),
	}
	if !result.Kind.Valid() || !result.Role.Valid() ||
		!result.Status.Valid() || !result.ImState.Valid() {
		return openapi.Member{}, invalidDomainData("Member 状态无效", nil)
	}
	if value.AccountID != nil {
		accountID, err := parseDomainID(*value.AccountID, "Account")
		if err != nil {
			return openapi.Member{}, err
		}
		result.AccountId = &accountID
	}
	if imUserID := strings.TrimSpace(value.IMUserID); imUserID != "" {
		result.ImUserId = &imUserID
	}
	return result, nil
}

func operationDTO(value appservermember.Operation) (openapi.Operation, error) {
	id, err := parseDomainID(value.ID, "Operation")
	if err != nil {
		return openapi.Operation{}, err
	}
	service := openapi.OperationService(value.Service)
	state := openapi.OperationState(value.State)
	if !service.Valid() || !state.Valid() || value.CreatedAt.IsZero() {
		return openapi.Operation{}, invalidDomainData("Operation 数据无效", nil)
	}
	result := openapi.Operation{
		Id:        id,
		Service:   service,
		Kind:      value.Kind,
		State:     state,
		CreatedAt: value.CreatedAt.UTC(),
	}
	if value.CompletedAt != nil {
		completedAt := value.CompletedAt.UTC()
		result.CompletedAt = &completedAt
	}
	if value.LastErrorCode != "" {
		detail := struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{
			Code:    value.LastErrorCode,
			Message: "腾讯云 IM 操作尚未收敛",
		}
		result.Error = &detail
	}
	return result, nil
}

func parseDomainID(value string, label string) (uuid.UUID, error) {
	id, err := uuid.Parse(value)
	if err != nil || id == uuid.Nil {
		return uuid.Nil, invalidDomainData(label+" ID 无效", err)
	}
	return id, nil
}

func invalidDomainData(message string, cause error) error {
	return apperror.New("internal_error", message, cause)
}

func mapServerMemberQueryError(err error) error {
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
		return apperror.New("internal_error", "无法读取 Server 数据", err)
	}
}
