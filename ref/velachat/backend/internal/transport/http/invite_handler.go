package httptransport

import (
	"context"
	"errors"
	"math"

	"chatserver/internal/api/openapi"
	appinvite "chatserver/internal/app/serverinvite"
	"chatserver/internal/apperror"
	inviteport "chatserver/internal/ports/serverinvite"
)

type inviteService interface {
	Create(
		context.Context,
		appinvite.CreateCommand,
	) (appinvite.CreateResult, error)
	Accept(
		context.Context,
		appinvite.AcceptCommand,
	) (appinvite.AcceptResult, error)
	AcceptJoinLink(
		context.Context,
		appinvite.AcceptCommand,
	) (appinvite.AcceptResult, error)
	List(context.Context, string, string) ([]inviteport.Invite, error)
	Revoke(context.Context, appinvite.RevokeCommand) error
}

func (handler *InviteHandler) AcceptJoinLink(
	ctx context.Context,
	request openapi.AcceptJoinLinkRequestObject,
) (openapi.AcceptJoinLinkResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Token == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	result, err := handler.service.AcceptJoinLink(ctx, appinvite.AcceptCommand{
		AccountID:      accountID,
		IdempotencyKey: string(request.Params.IdempotencyKey),
		Token:          *request.Body.Token,
	})
	if err != nil {
		return nil, err
	}
	serverID, err := parseDomainID(result.ServerID, "Server")
	if err != nil {
		return nil, err
	}
	memberID, err := parseDomainID(result.MemberID, "Member")
	if err != nil {
		return nil, err
	}
	landingChannelID, err := parseDomainID(
		result.LandingChannelID,
		"Channel",
	)
	if err != nil {
		return nil, err
	}
	operations := make([]openapi.Operation, 0, 1)
	if result.OperationID != "" {
		operationID, parseErr := parseDomainID(result.OperationID, "Operation")
		if parseErr != nil {
			return nil, parseErr
		}
		if result.CreatedAt.IsZero() {
			return nil, invalidDomainData("加入链接接受结果无效", nil)
		}
		operations = append(operations, openapi.Operation{
			Id: operationID, Service: openapi.Im,
			Kind:      "im.membership.ensure",
			State:     openapi.OperationStatePending,
			CreatedAt: result.CreatedAt.UTC(),
		})
	}
	if result.ServerSlug == "" {
		return nil, invalidDomainData("加入链接接受结果无效", nil)
	}
	return openapi.AcceptJoinLink200JSONResponse{
		ServerId:         serverID,
		ServerSlug:       result.ServerSlug,
		MemberId:         memberID,
		LandingChannelId: landingChannelID,
		Operations:       operations,
	}, nil
}

func (handler *InviteHandler) AcceptInvite(
	ctx context.Context,
	request openapi.AcceptInviteRequestObject,
) (openapi.AcceptInviteResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	result, err := handler.service.Accept(ctx, appinvite.AcceptCommand{
		AccountID:      accountID,
		IdempotencyKey: string(request.Params.IdempotencyKey),
		Token:          request.Body.Token,
	})
	if err != nil {
		return nil, err
	}
	memberID, err := parseDomainID(result.MemberID, "Member")
	if err != nil {
		return nil, err
	}
	operationID, err := parseDomainID(result.OperationID, "Operation")
	if err != nil {
		return nil, err
	}
	if result.CreatedAt.IsZero() {
		return nil, invalidDomainData("邀请接受结果无效", nil)
	}
	return openapi.AcceptInvite202JSONResponse{
		ResourceId: memberID,
		Operations: []openapi.Operation{{
			Id:        operationID,
			Service:   openapi.Im,
			Kind:      "im.membership.ensure",
			State:     openapi.OperationStatePending,
			CreatedAt: result.CreatedAt.UTC(),
		}},
	}, nil
}

// InviteHandler 实现仅 Owner/Admin 可用的 Server 邀请管理接口。
type InviteHandler struct {
	openapi.StrictServerInterface
	service inviteService
}

var _ openapi.StrictServerInterface = (*InviteHandler)(nil)

// NewInviteHandler 创建邀请 strict handler。
func NewInviteHandler(service inviteService) (*InviteHandler, error) {
	if service == nil {
		return nil, errors.New("Server 邀请应用服务不能为空")
	}
	return &InviteHandler{service: service}, nil
}

func (handler *InviteHandler) ListInvites(
	ctx context.Context,
	request openapi.ListInvitesRequestObject,
) (openapi.ListInvitesResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	values, err := handler.service.List(
		ctx,
		accountID,
		request.ServerId.String(),
	)
	if err != nil {
		return nil, err
	}
	response := make(openapi.ListInvites200JSONResponse, 0, len(values))
	for _, value := range values {
		item, err := inviteDTO(value)
		if err != nil {
			return nil, err
		}
		response = append(response, item)
	}
	return response, nil
}

func (handler *InviteHandler) CreateInvite(
	ctx context.Context,
	request openapi.CreateInviteRequestObject,
) (openapi.CreateInviteResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	var landingChannelID *string
	if request.Body.LandingChannelId != nil {
		value := request.Body.LandingChannelId.String()
		landingChannelID = &value
	}
	result, err := handler.service.Create(ctx, appinvite.CreateCommand{
		AccountID:        accountID,
		ServerID:         request.ServerId.String(),
		Role:             string(request.Body.Role),
		MaxUses:          int64(request.Body.MaxUses),
		LandingChannelID: landingChannelID,
		ExpiresAt:        request.Body.ExpiresAt,
	})
	if err != nil {
		return nil, err
	}
	invite, err := inviteDTO(result.Invite)
	if err != nil {
		return nil, err
	}
	token := result.Token.Reveal()
	return openapi.CreateInvite201JSONResponse{
		Body: openapi.InviteSecret{
			Invite: invite,
			Token:  &token,
		},
		Headers: openapi.CreateInvite201ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

func (handler *InviteHandler) RevokeInvite(
	ctx context.Context,
	request openapi.RevokeInviteRequestObject,
) (openapi.RevokeInviteResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	err = handler.service.Revoke(ctx, appinvite.RevokeCommand{
		AccountID: accountID,
		ServerID:  request.ServerId.String(),
		InviteID:  request.InviteId.String(),
	})
	if err != nil {
		return nil, err
	}
	return openapi.RevokeInvite204Response{}, nil
}

func inviteDTO(value inviteport.Invite) (openapi.Invite, error) {
	id, err := parseDomainID(value.ID, "Invite")
	if err != nil {
		return openapi.Invite{}, err
	}
	serverID, err := parseDomainID(value.ServerID, "Server")
	if err != nil {
		return openapi.Invite{}, err
	}
	if value.MaxUses < 0 || value.MaxUses > math.MaxInt ||
		value.UsedCount < 0 || value.UsedCount > math.MaxInt ||
		value.Revision > math.MaxInt64 ||
		value.ExpiresAt.IsZero() {
		return openapi.Invite{},
			invalidDomainData("Invite 数据无效", nil)
	}
	role := openapi.InviteRole(value.Role)
	if !role.Valid() {
		return openapi.Invite{},
			invalidDomainData("Invite 角色无效", nil)
	}
	result := openapi.Invite{
		Id:        id,
		ServerId:  serverID,
		Role:      role,
		MaxUses:   int(value.MaxUses),
		UsedCount: int(value.UsedCount),
		ExpiresAt: value.ExpiresAt.UTC(),
		Revision:  int64(value.Revision),
	}
	if value.LandingChannelID != nil {
		landingChannelID, err := parseDomainID(
			*value.LandingChannelID,
			"Channel",
		)
		if err != nil {
			return openapi.Invite{}, err
		}
		result.LandingChannelId = &landingChannelID
	}
	return result, nil
}
