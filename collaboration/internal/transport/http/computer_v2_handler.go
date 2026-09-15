package httptransport

import (
	"context"
	"errors"
	"strings"

	"git.woa.com/wisp/mono2/collaboration/internal/api/openapi"
	appcomputerv2 "git.woa.com/wisp/mono2/collaboration/internal/app/computerv2"
	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	computerv2port "git.woa.com/wisp/mono2/collaboration/internal/ports/computerv2"
)

type computerV2Service interface {
	Attach(context.Context, appcomputerv2.AttachCommand) (computerv2port.Computer, error)
	List(context.Context, string, string, appcomputerv2.ListOptions) (computerv2port.Page, error)
}

type ComputerV2Handler struct {
	openapi.StrictServerInterface
	service computerV2Service
}

var _ openapi.StrictServerInterface = (*ComputerV2Handler)(nil)

func NewComputerV2Handler(service computerV2Service) (*ComputerV2Handler, error) {
	if service == nil {
		return nil, errors.New("ComputerV2 应用服务不能为空")
	}
	return &ComputerV2Handler{service: service}, nil
}

func (handler *ComputerV2Handler) ListComputersV2(
	ctx context.Context,
	request openapi.ListComputersV2RequestObject,
) (openapi.ListComputersV2ResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	options := appcomputerv2.ListOptions{}
	if request.Params.Limit != nil {
		options.Limit = int(*request.Params.Limit)
	}
	if request.Params.Cursor != nil {
		options.Cursor = string(*request.Params.Cursor)
	}
	page, err := handler.service.List(ctx, principal.AccountID(), request.ServerId.String(), options)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.ComputerV2, 0, len(page.Items))
	for _, value := range page.Items {
		item, err := computerV2DTO(value)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	var nextCursor *string
	if page.NextCursor != "" {
		nextCursor = &page.NextCursor
	}
	return openapi.ListComputersV2200JSONResponse{
		Items: items, NextCursor: nextCursor,
	}, nil
}

func (handler *ComputerV2Handler) CreateComputerV2(
	ctx context.Context,
	request openapi.CreateComputerV2RequestObject,
) (openapi.CreateComputerV2ResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	name := ""
	if request.Body.Name != nil {
		name = *request.Body.Name
	}
	value, err := handler.service.Attach(ctx, appcomputerv2.AttachCommand{
		AccountID:       principal.AccountID(),
		ExternalSubject: principal.ExternalSubject(),
		ServerID:        request.ServerId.String(),
		InstanceID:      request.Body.InstanceId,
		Name:            name,
		IdempotencyKey:  request.Params.IdempotencyKey,
	})
	if err != nil {
		return nil, err
	}
	body, err := computerV2DTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.CreateComputerV2201JSONResponse{
		Body: body,
		Headers: openapi.CreateComputerV2201ResponseHeaders{
			XResourceRevision: value.Revision,
		},
	}, nil
}

func computerV2DTO(value computerv2port.Computer) (openapi.ComputerV2, error) {
	id, err := parseDomainID(value.ID, "ComputerV2")
	if err != nil {
		return openapi.ComputerV2{}, err
	}
	serverID, err := parseDomainID(value.ServerID, "Server")
	if err != nil {
		return openapi.ComputerV2{}, err
	}
	result := openapi.ComputerV2{
		Id: id, ServerId: serverID, Kind: openapi.ComputerV2Kind(value.Kind),
		InstanceId: value.InstanceID, Name: value.Name,
		LifecycleState: openapi.ComputerV2LifecycleState(value.LifecycleState),
		ObservedState:  openapi.ComputerV2ObservedState(value.ObservedState),
		Revision:       value.Revision, CreatedAt: value.CreatedAt.UTC(),
	}
	if !result.Kind.Valid() || !result.LifecycleState.Valid() || !result.ObservedState.Valid() ||
		strings.TrimSpace(result.InstanceId) == "" || strings.TrimSpace(result.Name) == "" ||
		result.Revision < 1 || value.CreatedAt.IsZero() {
		return openapi.ComputerV2{}, invalidDomainData("ComputerV2 数据无效", nil)
	}
	if value.LastObservedAt != nil {
		observedAt := value.LastObservedAt.UTC()
		result.LastObservedAt = &observedAt
	}
	if code := strings.TrimSpace(value.LastErrorCode); code != "" {
		result.LastErrorCode = &code
	}
	return result, nil
}
