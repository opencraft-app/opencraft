package httptransport

import (
	"context"
	"errors"
	"strings"

	"chatserver/internal/api/openapi"
	"chatserver/internal/apperror"
	operationport "chatserver/internal/ports/operation"
)

type operationService interface {
	Get(
		context.Context,
		string,
		string,
		string,
	) (operationport.Operation, error)
}

type OperationHandler struct {
	openapi.StrictServerInterface
	service operationService
}

var _ openapi.StrictServerInterface = (*OperationHandler)(nil)

func NewOperationHandler(service operationService) (*OperationHandler, error) {
	if service == nil {
		return nil, errors.New("Operation 查询服务不能为空")
	}
	return &OperationHandler{service: service}, nil
}

func (handler *OperationHandler) GetOperation(
	ctx context.Context,
	request openapi.GetOperationRequestObject,
) (openapi.GetOperationResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	value, err := handler.service.Get(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
		request.OperationId.String(),
	)
	if err != nil {
		return nil, err
	}
	body, err := queriedOperationDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetOperation200JSONResponse(body), nil
}

func queriedOperationDTO(value operationport.Operation) (openapi.Operation, error) {
	id, err := parseDomainID(value.ID, "Operation")
	if err != nil {
		return openapi.Operation{}, err
	}
	result := openapi.Operation{
		Id: id, Service: openapi.OperationService(value.Service),
		Kind: value.Kind, State: openapi.OperationState(value.State),
		CreatedAt: value.CreatedAt.UTC(),
	}
	if value.CompletedAt != nil {
		completedAt := value.CompletedAt.UTC()
		result.CompletedAt = &completedAt
	}
	if code := strings.TrimSpace(value.LastErrorCode); code != "" {
		result.Error = &struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{
			Code: code, Message: "腾讯云操作尚未收敛",
		}
	}
	if !result.Service.Valid() || !result.State.Valid() ||
		value.CreatedAt.IsZero() {
		return openapi.Operation{},
			invalidDomainData("Operation 数据无效", nil)
	}
	return result, nil
}
