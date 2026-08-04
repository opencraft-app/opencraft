package httptransport

import (
	"context"
	"errors"

	"chatserver/internal/api/openapi"
	appchannelmembership "chatserver/internal/app/channelmembership"
	channelmembershipport "chatserver/internal/ports/channelmembership"
)

type channelMembershipService interface {
	Change(
		context.Context,
		appchannelmembership.Command,
	) (channelmembershipport.Result, error)
}

type ChannelMembershipHandler struct {
	openapi.StrictServerInterface
	service channelMembershipService
}

var _ openapi.StrictServerInterface = (*ChannelMembershipHandler)(nil)

func NewChannelMembershipHandler(
	service channelMembershipService,
) (*ChannelMembershipHandler, error) {
	if service == nil {
		return nil, errors.New("Channel membership 应用服务不能为空")
	}
	return &ChannelMembershipHandler{service: service}, nil
}

func (handler *ChannelMembershipHandler) AddChannelMember(
	ctx context.Context,
	request openapi.AddChannelMemberRequestObject,
) (openapi.AddChannelMemberResponseObject, error) {
	result, err := handler.change(
		ctx,
		request.ServerId.String(),
		request.ChannelId.String(),
		request.MemberId.String(),
		string(request.Params.IdempotencyKey),
		"ensure",
	)
	if err != nil {
		return nil, err
	}
	response, err := channelMembershipAccepted(result, "ensure")
	if err != nil {
		return nil, err
	}
	return openapi.AddChannelMember202JSONResponse(response), nil
}

func (handler *ChannelMembershipHandler) RemoveChannelMember(
	ctx context.Context,
	request openapi.RemoveChannelMemberRequestObject,
) (openapi.RemoveChannelMemberResponseObject, error) {
	result, err := handler.change(
		ctx,
		request.ServerId.String(),
		request.ChannelId.String(),
		request.MemberId.String(),
		string(request.Params.IdempotencyKey),
		"remove",
	)
	if err != nil {
		return nil, err
	}
	response, err := channelMembershipAccepted(result, "remove")
	if err != nil {
		return nil, err
	}
	return openapi.RemoveChannelMember202JSONResponse(response), nil
}

func (handler *ChannelMembershipHandler) change(
	ctx context.Context,
	serverID, channelID, memberID, idempotencyKey, action string,
) (channelmembershipport.Result, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return channelmembershipport.Result{}, err
	}
	return handler.service.Change(ctx, appchannelmembership.Command{
		AccountID: accountID, ServerID: serverID,
		ChannelID: channelID, MemberID: memberID,
		IdempotencyKey: idempotencyKey, Action: action,
	})
}

func channelMembershipAccepted(
	result channelmembershipport.Result,
	action string,
) (openapi.AcceptedResource, error) {
	resourceID, err := parseDomainID(
		result.ChannelMemberID,
		"Channel Member",
	)
	if err != nil {
		return openapi.AcceptedResource{}, err
	}
	operationID, err := parseDomainID(result.OperationID, "Operation")
	if err != nil {
		return openapi.AcceptedResource{}, err
	}
	if result.CreatedAt.IsZero() {
		return openapi.AcceptedResource{},
			invalidDomainData("Channel membership 结果无效", nil)
	}
	return openapi.AcceptedResource{
		ResourceId: resourceID,
		Operations: []openapi.Operation{{
			Id: operationID, Service: openapi.Im,
			Kind:  "im.membership." + action,
			State: openapi.OperationStatePending, CreatedAt: result.CreatedAt.UTC(),
		}},
	}, nil
}
