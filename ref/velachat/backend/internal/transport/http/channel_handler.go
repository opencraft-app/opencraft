package httptransport

import (
	"context"
	"errors"
	"strings"

	"chatserver/internal/api/openapi"
	appchannel "chatserver/internal/app/channelmanagement"
	"chatserver/internal/apperror"
	channelport "chatserver/internal/ports/channel"
	servermemberport "chatserver/internal/ports/servermember"
)

type channelService interface {
	Create(
		context.Context,
		appchannel.CreateCommand,
	) (channelport.CreateResult, error)
	List(context.Context, string, string) ([]channelport.Channel, error)
	Get(context.Context, string, string, string) (channelport.Channel, error)
	Update(
		context.Context,
		appchannel.UpdateCommand,
	) (channelport.Channel, error)
}

type channelMemberQuery interface {
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
}

// ChannelHandler 实现普通 Channel 与腾讯 IM Topic 映射的管理接口。
type ChannelHandler struct {
	openapi.StrictServerInterface
	service       channelService
	memberQueries channelMemberQuery
}

var _ openapi.StrictServerInterface = (*ChannelHandler)(nil)

// NewChannelHandler 创建 Channel HTTP Handler。
func NewChannelHandler(
	service channelService,
	memberQueries channelMemberQuery,
) (*ChannelHandler, error) {
	if service == nil || memberQueries == nil {
		return nil, errors.New("Channel 应用服务不能为空")
	}
	return &ChannelHandler{
		service:       service,
		memberQueries: memberQueries,
	}, nil
}

func (handler *ChannelHandler) CreateChannel(
	ctx context.Context,
	request openapi.CreateChannelRequestObject,
) (openapi.CreateChannelResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	result, err := handler.service.Create(ctx, appchannel.CreateCommand{
		AccountID:      principal.AccountID(),
		ServerID:       request.ServerId.String(),
		IdempotencyKey: request.Params.IdempotencyKey,
		Name:           request.Body.Name,
		Description:    request.Body.Description,
		Visibility:     string(request.Body.Visibility),
	})
	if err != nil {
		return nil, err
	}
	resourceID, err := parseDomainID(result.Channel.ID, "Channel")
	if err != nil {
		return nil, err
	}
	operations := make([]openapi.Operation, 0, len(result.Operations))
	for _, value := range result.Operations {
		operation, err := channelOperationDTO(value)
		if err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	return openapi.CreateChannel202JSONResponse{
		ResourceId: resourceID,
		Operations: operations,
	}, nil
}

func (handler *ChannelHandler) ListChannels(
	ctx context.Context,
	request openapi.ListChannelsRequestObject,
) (openapi.ListChannelsResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	values, err := handler.service.List(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
	)
	if err != nil {
		return nil, err
	}
	body := make(openapi.ListChannels200JSONResponse, 0, len(values))
	for _, value := range values {
		item, err := channelDTO(value)
		if err != nil {
			return nil, err
		}
		body = append(body, item)
	}
	return body, nil
}

func (handler *ChannelHandler) GetChannel(
	ctx context.Context,
	request openapi.GetChannelRequestObject,
) (openapi.GetChannelResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	value, err := handler.service.Get(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
		request.ChannelId.String(),
	)
	if err != nil {
		return nil, err
	}
	body, err := channelDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetChannel200JSONResponse(body), nil
}

func (handler *ChannelHandler) UpdateChannel(
	ctx context.Context,
	request openapi.UpdateChannelRequestObject,
) (openapi.UpdateChannelResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	revision, err := workRevision(request.Params.XResourceRevision)
	if err != nil {
		return nil, err
	}
	value, err := handler.service.Update(ctx, appchannel.UpdateCommand{
		AccountID:      principal.AccountID(),
		ServerID:       request.ServerId.String(),
		ChannelID:      request.ChannelId.String(),
		Revision:       revision,
		IdempotencyKey: string(request.Params.IdempotencyKey),
		Name:           request.Body.Name,
		DescriptionSet: request.Body.Description != nil,
		Description:    request.Body.Description,
	})
	if err != nil {
		return nil, err
	}
	body, err := channelDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateChannel200JSONResponse{
		Body: body,
		Headers: openapi.UpdateChannel200ResponseHeaders{
			XResourceRevision: body.Revision,
		},
	}, nil
}

// ListChannelMembers 对系统 #全员返回共享 Community 的 active Member，
// 对普通 Channel 返回显式 active Member。
func (handler *ChannelHandler) ListChannelMembers(
	ctx context.Context,
	request openapi.ListChannelMembersRequestObject,
) (openapi.ListChannelMembersResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	channel, err := handler.service.Get(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
		request.ChannelId.String(),
	)
	if err != nil {
		return nil, err
	}
	var values []servermemberport.Member
	if channel.SystemKey != nil && strings.TrimSpace(*channel.SystemKey) == "all" {
		page, listErr := handler.memberQueries.ListMembers(
			ctx,
			principal.AccountID(),
			request.ServerId.String(),
			servermemberport.ListOptions{Limit: 100},
		)
		values, err = page.Items, listErr
	} else {
		values, err = handler.memberQueries.ListChannelMembers(
			ctx,
			principal.AccountID(),
			request.ServerId.String(),
			request.ChannelId.String(),
			servermemberport.ListOptions{Limit: 100},
		)
	}
	if err != nil {
		return nil, mapServerMemberQueryError(err)
	}
	body := make(openapi.ListChannelMembers200JSONResponse, 0, len(values))
	for _, value := range values {
		item, err := memberDTO(value)
		if err != nil {
			return nil, err
		}
		body = append(body, item)
	}
	return body, nil
}

func channelDTO(value channelport.Channel) (openapi.Channel, error) {
	id, err := parseDomainID(value.ID, "Channel")
	if err != nil {
		return openapi.Channel{}, err
	}
	serverID, err := parseDomainID(value.ServerID, "Server")
	if err != nil {
		return openapi.Channel{}, err
	}
	result := openapi.Channel{
		Id:          id,
		ServerId:    serverID,
		Name:        value.Name,
		Description: value.Description,
		Visibility:  openapi.ChannelVisibility(value.Visibility),
		Joined:      value.Joined,
		ImState:     openapi.ChannelImState(value.IMState),
		Revision:    value.Revision,
	}
	if groupID := strings.TrimSpace(value.IMGroupID); groupID != "" {
		result.ImGroupId = &groupID
	}
	if value.IMTopicID != nil &&
		strings.TrimSpace(*value.IMTopicID) != "" {
		topicID := strings.TrimSpace(*value.IMTopicID)
		result.ImTopicId = &topicID
	}
	if value.SystemKey != nil &&
		strings.TrimSpace(*value.SystemKey) != "" {
		systemKey := openapi.ChannelSystemKey(
			strings.TrimSpace(*value.SystemKey),
		)
		result.SystemKey = &systemKey
	}
	if !result.Visibility.Valid() || !result.ImState.Valid() ||
		result.Revision < 1 ||
		(result.SystemKey != nil && !result.SystemKey.Valid()) {
		return openapi.Channel{},
			invalidDomainData("Channel 数据无效", nil)
	}
	return result, nil
}

func channelOperationDTO(
	value channelport.Operation,
) (openapi.Operation, error) {
	id, err := parseDomainID(value.ID, "Operation")
	if err != nil {
		return openapi.Operation{}, err
	}
	result := openapi.Operation{
		Id:        id,
		Service:   openapi.OperationService(value.Service),
		Kind:      value.Kind,
		State:     openapi.OperationState(value.State),
		CreatedAt: value.CreatedAt.UTC(),
	}
	if !result.Service.Valid() || !result.State.Valid() ||
		value.CreatedAt.IsZero() {
		return openapi.Operation{},
			invalidDomainData("Operation 数据无效", nil)
	}
	return result, nil
}
