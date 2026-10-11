package httptransport

import (
	"context"
	"errors"
	"strings"

	"chatserver/internal/api/openapi"
	appdirect "chatserver/internal/app/directconversation"
	"chatserver/internal/apperror"
	directport "chatserver/internal/ports/directconversation"
)

type directConversationService interface {
	Create(context.Context, appdirect.CreateCommand) (directport.CreateResult, error)
	Retry(context.Context, appdirect.RetryCommand) (directport.CreateResult, error)
	List(context.Context, directport.PageRequest) (directport.Page, error)
	Get(context.Context, string, string, string) (directport.Conversation, error)
}

// DirectConversationHandler 实现 Server 内双人私信 authority 接口。
type DirectConversationHandler struct {
	openapi.StrictServerInterface
	service directConversationService
}

func NewDirectConversationHandler(service directConversationService) (*DirectConversationHandler, error) {
	if service == nil {
		return nil, errors.New("Server 内私信应用服务不能为空")
	}
	return &DirectConversationHandler{service: service}, nil
}

func (handler *DirectConversationHandler) ListDirectConversations(
	ctx context.Context,
	request openapi.ListDirectConversationsRequestObject,
) (openapi.ListDirectConversationsResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	limit := 50
	if request.Params.Limit != nil {
		limit = int(*request.Params.Limit)
	}
	cursor := ""
	if request.Params.Cursor != nil {
		cursor = string(*request.Params.Cursor)
	}
	page, err := handler.service.List(ctx, directport.PageRequest{
		AccountID: principal.AccountID(), ServerID: request.ServerId.String(), Limit: limit, Cursor: cursor,
	})
	if err != nil {
		return nil, err
	}
	items := make([]openapi.DirectConversation, 0, len(page.Items))
	for _, value := range page.Items {
		item, mapErr := directConversationDTO(value)
		if mapErr != nil {
			return nil, mapErr
		}
		items = append(items, item)
	}
	return openapi.ListDirectConversations200JSONResponse{
		Items: items, NextCursor: page.NextCursor,
	}, nil
}

func (handler *DirectConversationHandler) CreateDirectConversation(
	ctx context.Context,
	request openapi.CreateDirectConversationRequestObject,
) (openapi.CreateDirectConversationResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	result, err := handler.service.Create(ctx, appdirect.CreateCommand{
		AccountID: principal.AccountID(), ServerID: request.ServerId.String(),
		PeerMemberID: request.Body.PeerMemberId.String(), IdempotencyKey: string(request.Params.IdempotencyKey),
	})
	if err != nil {
		return nil, err
	}
	if !result.Accepted {
		body, mapErr := directConversationDTO(result.Conversation)
		if mapErr != nil {
			return nil, mapErr
		}
		return openapi.CreateDirectConversation200JSONResponse(body), nil
	}
	accepted, err := directAcceptedResource(result)
	if err != nil {
		return nil, err
	}
	return openapi.CreateDirectConversation202JSONResponse(accepted), nil
}

func (handler *DirectConversationHandler) GetDirectConversation(
	ctx context.Context,
	request openapi.GetDirectConversationRequestObject,
) (openapi.GetDirectConversationResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	value, err := handler.service.Get(
		ctx, principal.AccountID(), request.ServerId.String(), request.DirectConversationId.String(),
	)
	if err != nil {
		return nil, err
	}
	body, err := directConversationDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetDirectConversation200JSONResponse(body), nil
}

func (handler *DirectConversationHandler) RetryDirectConversation(
	ctx context.Context,
	request openapi.RetryDirectConversationRequestObject,
) (openapi.RetryDirectConversationResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	result, err := handler.service.Retry(ctx, appdirect.RetryCommand{
		AccountID: principal.AccountID(), ServerID: request.ServerId.String(),
		DirectConversationID: request.DirectConversationId.String(),
		IdempotencyKey:       string(request.Params.IdempotencyKey),
	})
	if err != nil {
		return nil, err
	}
	accepted, err := directAcceptedResource(result)
	if err != nil {
		return nil, err
	}
	return openapi.RetryDirectConversation202JSONResponse(accepted), nil
}

func directAcceptedResource(result directport.CreateResult) (openapi.AcceptedResource, error) {
	resourceID, err := parseDomainID(result.Conversation.ID, "DirectConversation")
	if err != nil {
		return openapi.AcceptedResource{}, err
	}
	operations := make([]openapi.Operation, 0, len(result.Operations))
	for _, value := range result.Operations {
		operation, mapErr := directOperationDTO(value)
		if mapErr != nil {
			return openapi.AcceptedResource{}, mapErr
		}
		operations = append(operations, operation)
	}
	return openapi.AcceptedResource{ResourceId: resourceID, Operations: operations}, nil
}

func directOperationDTO(value directport.Operation) (openapi.Operation, error) {
	id, err := parseDomainID(value.ID, "Operation")
	if err != nil {
		return openapi.Operation{}, err
	}
	result := openapi.Operation{
		Id: id, Service: openapi.OperationService(value.Service), Kind: value.Kind,
		State: openapi.OperationState(value.State), CreatedAt: value.CreatedAt.UTC(), CompletedAt: value.CompletedAt,
	}
	if value.LastErrorCode != nil {
		result.Error = &struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{Code: *value.LastErrorCode, Message: "腾讯云 IM 操作未完成"}
	}
	if !result.Service.Valid() || !result.State.Valid() || value.CreatedAt.IsZero() {
		return openapi.Operation{}, invalidDomainData("私信 Operation 数据无效", nil)
	}
	return result, nil
}

func directConversationDTO(value directport.Conversation) (openapi.DirectConversation, error) {
	id, err := parseDomainID(value.ID, "DirectConversation")
	if err != nil {
		return openapi.DirectConversation{}, err
	}
	serverID, err := parseDomainID(value.ServerID, "Server")
	if err != nil {
		return openapi.DirectConversation{}, err
	}
	memberA, err := directMemberDTO(value.MemberA)
	if err != nil {
		return openapi.DirectConversation{}, err
	}
	memberB, err := directMemberDTO(value.MemberB)
	if err != nil {
		return openapi.DirectConversation{}, err
	}
	result := openapi.DirectConversation{
		Id: id, ServerId: serverID, MemberA: memberA, MemberB: memberB,
		Status: openapi.DirectConversationStatus(value.Status), ImGroupId: strings.TrimSpace(value.IMGroupID),
		ImState: openapi.DirectConversationIMState(value.IMState), Revision: value.Revision,
	}
	if !result.Status.Valid() || !result.ImState.Valid() || result.ImGroupId == "" || result.Revision < 1 {
		return openapi.DirectConversation{}, invalidDomainData("Server 内私信数据无效", nil)
	}
	return result, nil
}

func directMemberDTO(value directport.Member) (openapi.Member, error) {
	id, err := parseDomainID(value.ID, "Member")
	if err != nil {
		return openapi.Member{}, err
	}
	serverID, err := parseDomainID(value.ServerID, "Server")
	if err != nil {
		return openapi.Member{}, err
	}
	result := openapi.Member{
		Id: id, ServerId: serverID, Kind: openapi.MemberKind(value.Kind), Role: openapi.MemberRole(value.Role),
		DisplayName: value.DisplayName, Handle: value.Handle, Status: openapi.MemberStatus(value.Status),
		ImState: openapi.MemberImState(value.IMState), Revision: value.Revision,
	}
	if value.AccountID != nil {
		accountID, parseErr := parseDomainID(*value.AccountID, "Account")
		if parseErr != nil {
			return openapi.Member{}, parseErr
		}
		result.AccountId = &accountID
	}
	if imUserID := strings.TrimSpace(value.IMUserID); imUserID != "" {
		result.ImUserId = &imUserID
	}
	if !result.Kind.Valid() || !result.Role.Valid() || !result.Status.Valid() || !result.ImState.Valid() || result.Revision < 1 {
		return openapi.Member{}, invalidDomainData("私信成员数据无效", nil)
	}
	return result, nil
}

var _ openapi.StrictServerInterface = (*DirectConversationHandler)(nil)
