package httptransport

import (
	"context"
	"errors"

	"chatserver/internal/api/openapi"
	appmembermutation "chatserver/internal/app/membermutation"
	"chatserver/internal/apperror"
	membermutationport "chatserver/internal/ports/membermutation"
)

type memberMutationService interface {
	Update(
		context.Context,
		appmembermutation.UpdateCommand,
	) (membermutationport.UpdateResult, error)
	Remove(
		context.Context,
		appmembermutation.RemoveCommand,
	) (membermutationport.RemoveResult, error)
}

type MemberMutationHandler struct {
	openapi.StrictServerInterface
	service memberMutationService
	queries serverQueries
}

var _ openapi.StrictServerInterface = (*MemberMutationHandler)(nil)

func NewMemberMutationHandler(
	service memberMutationService,
	queries serverQueries,
) (*MemberMutationHandler, error) {
	if service == nil || queries == nil {
		return nil, errors.New("成员变更应用服务不能为空")
	}
	return &MemberMutationHandler{service: service, queries: queries}, nil
}

func (handler *MemberMutationHandler) UpdateMember(
	ctx context.Context,
	request openapi.UpdateMemberRequestObject,
) (openapi.UpdateMemberResponseObject, error) {
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
	var role *string
	if request.Body.Role != nil {
		value := string(*request.Body.Role)
		role = &value
	}
	result, err := handler.service.Update(
		ctx,
		appmembermutation.UpdateCommand{
			AccountID: accountID, ServerID: request.ServerId.String(),
			MemberID:         request.MemberId.String(),
			ExpectedRevision: revision,
			IdempotencyKey:   string(request.Params.IdempotencyKey),
			DisplayName:      request.Body.DisplayName, Role: role,
		},
	)
	if err != nil {
		return nil, err
	}
	value, err := handler.queries.GetMember(
		ctx,
		accountID,
		request.ServerId.String(),
		result.MemberID,
	)
	if err != nil {
		return nil, err
	}
	body, err := memberDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMember200JSONResponse{
		Body: body,
		Headers: openapi.UpdateMember200ResponseHeaders{
			XResourceRevision: body.Revision,
		},
	}, nil
}

func (handler *MemberMutationHandler) RemoveMember(
	ctx context.Context,
	request openapi.RemoveMemberRequestObject,
) (openapi.RemoveMemberResponseObject, error) {
	accountID, err := currentHumanAccountID(ctx)
	if err != nil {
		return nil, err
	}
	result, err := handler.service.Remove(
		ctx,
		appmembermutation.RemoveCommand{
			AccountID: accountID, ServerID: request.ServerId.String(),
			MemberID:       request.MemberId.String(),
			IdempotencyKey: string(request.Params.IdempotencyKey),
		},
	)
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
		return nil, invalidDomainData("成员移除结果无效", nil)
	}
	return openapi.RemoveMember202JSONResponse{
		ResourceId: memberID,
		Operations: []openapi.Operation{{
			Id: operationID, Service: openapi.Im,
			Kind: "im.membership.remove", State: openapi.OperationStatePending,
			CreatedAt: result.CreatedAt.UTC(),
		}},
	}, nil
}
