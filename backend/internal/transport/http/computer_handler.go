package httptransport

import (
	"context"
	"errors"
	"math"
	"strings"

	"chatserver/internal/api/openapi"
	appcomputer "chatserver/internal/app/computermanagement"
	"chatserver/internal/apperror"
	computerport "chatserver/internal/ports/computer"
	tencenttatport "chatserver/internal/ports/tencenttat"
)

type computerService interface {
	Create(context.Context, appcomputer.CreateCommand) (computerport.Computer, error)
	Release(context.Context, appcomputer.ReleaseCommand) error
	List(context.Context, string, string) ([]computerport.Computer, error)
	Get(context.Context, string, string, string) (computerport.Computer, error)
	Refresh(
		context.Context,
		appcomputer.RefreshCommand,
	) (computerport.Operation, error)
	CreateTerminalSession(
		context.Context,
		string,
		string,
		string,
	) (tencenttatport.TerminalSession, error)
}

type computerCredentialService interface {
	Issue(
		context.Context,
		string,
		string,
		string,
		string,
		string,
	) (appcomputer.RuntimeCredential, error)
}

// ComputerHandler 实现最小 Computer 管理 strict operation。
type ComputerHandler struct {
	openapi.StrictServerInterface
	service     computerService
	credentials computerCredentialService
}

var _ openapi.StrictServerInterface = (*ComputerHandler)(nil)

// NewComputerHandler 创建 Computer HTTP Handler。
func NewComputerHandler(
	service computerService,
	credentials computerCredentialService,
) (*ComputerHandler, error) {
	if service == nil || credentials == nil {
		return nil, errors.New("Computer 应用服务与凭证服务不能为空")
	}
	return &ComputerHandler{service: service, credentials: credentials}, nil
}

// RemoveComputer 解除平台映射，不销毁真实实例。
func (handler *ComputerHandler) RemoveComputer(
	ctx context.Context,
	request openapi.RemoveComputerRequestObject,
) (openapi.RemoveComputerResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	err := handler.service.Release(ctx, appcomputer.ReleaseCommand{
		AccountID:      principal.AccountID(),
		ServerID:       request.ServerId.String(),
		ComputerID:     request.ComputerId.String(),
		IdempotencyKey: request.Params.IdempotencyKey,
	})
	if err != nil {
		return nil, err
	}
	return openapi.RemoveComputer204Response{}, nil
}

func (handler *ComputerHandler) CreateComputer(
	ctx context.Context,
	request openapi.CreateComputerRequestObject,
) (openapi.CreateComputerResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	command, err := computerCreateCommand(*request.Body)
	if err != nil {
		return nil, err
	}
	command.AccountID = principal.AccountID()
	command.ServerID = request.ServerId.String()
	command.IdempotencyKey = request.Params.IdempotencyKey
	value, err := handler.service.Create(ctx, command)
	if err != nil {
		return nil, err
	}
	body, err := computerDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.CreateComputer201JSONResponse(body), nil
}

func (handler *ComputerHandler) ListComputers(
	ctx context.Context,
	request openapi.ListComputersRequestObject,
) (openapi.ListComputersResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	values, err := handler.service.List(
		ctx, principal.AccountID(), request.ServerId.String(),
	)
	if err != nil {
		return nil, err
	}
	body := make(openapi.ListComputers200JSONResponse, 0, len(values))
	for _, value := range values {
		item, err := computerDTO(value)
		if err != nil {
			return nil, err
		}
		body = append(body, item)
	}
	return body, nil
}

func (handler *ComputerHandler) ListComputerRuntimeCapabilities(
	ctx context.Context,
	request openapi.ListComputerRuntimeCapabilitiesRequestObject,
) (openapi.ListComputerRuntimeCapabilitiesResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	values, err := handler.service.List(
		ctx, principal.AccountID(), request.ServerId.String(),
	)
	if err != nil {
		return nil, err
	}
	body := make(openapi.ListComputerRuntimeCapabilities200JSONResponse, 0, len(values))
	for _, value := range values {
		computerID, err := parseDomainID(value.ID, "Computer")
		if err != nil {
			return nil, err
		}
		version := value.AssignmentVersion
		if version < 1 {
			version = 1
		}
		body = append(body, openapi.ComputerRuntimeCapability{
			ComputerId: computerID, AssignmentVersion: version,
		})
	}
	return body, nil
}

func (handler *ComputerHandler) GetComputer(
	ctx context.Context,
	request openapi.GetComputerRequestObject,
) (openapi.GetComputerResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	value, err := handler.service.Get(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
		request.ComputerId.String(),
	)
	if err != nil {
		return nil, err
	}
	body, err := computerDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetComputer200JSONResponse(body), nil
}

func (handler *ComputerHandler) RefreshComputer(
	ctx context.Context,
	request openapi.RefreshComputerRequestObject,
) (openapi.RefreshComputerResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	value, err := handler.service.Refresh(
		ctx,
		appcomputer.RefreshCommand{
			AccountID:      principal.AccountID(),
			ServerID:       request.ServerId.String(),
			ComputerID:     request.ComputerId.String(),
			IdempotencyKey: request.Params.IdempotencyKey,
		},
	)
	if err != nil {
		return nil, err
	}
	body, err := computerOperationDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.RefreshComputer202JSONResponse(body), nil
}

func (handler *ComputerHandler) CreateComputerRuntimeCredential(
	ctx context.Context,
	request openapi.CreateComputerRuntimeCredentialRequestObject,
) (openapi.CreateComputerRuntimeCredentialResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if request.Body == nil || !request.Body.Mode.Valid() {
		return nil, apperror.New("invalid_request", "请求体无效", nil)
	}
	value, err := handler.credentials.Issue(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
		request.ComputerId.String(),
		string(request.Body.Mode),
		request.Params.IdempotencyKey,
	)
	if err != nil {
		return nil, err
	}
	body, err := computerRuntimeCredentialDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.CreateComputerRuntimeCredential201JSONResponse{
		Body: body,
		Headers: openapi.CreateComputerRuntimeCredential201ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

func (handler *ComputerHandler) CreateTerminalSession(
	ctx context.Context,
	request openapi.CreateTerminalSessionRequestObject,
) (openapi.CreateTerminalSessionResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	value, err := handler.service.CreateTerminalSession(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
		request.ComputerId.String(),
	)
	if err != nil {
		return nil, err
	}
	webSocketURL := value.WebSocketURL
	return openapi.CreateTerminalSession201JSONResponse{
		Body: openapi.TerminalSession{
			Protocol:     openapi.TencentTatPtyV1,
			SessionId:    value.SessionID,
			WebSocketUrl: &webSocketURL,
			ExpiresAt:    value.ExpiresAt.UTC(),
			Authentication: openapi.TerminalSessionAuthentication{
				Uin:        value.OwnerUIN,
				AppId:      value.AppID,
				InstanceId: value.InstanceID,
			},
			Terminal: openapi.TerminalGeometry{
				Cols:           value.Cols,
				Rows:           value.Rows,
				MaxIdleSeconds: value.MaxIdleSeconds,
			},
		},
		Headers: openapi.CreateTerminalSession201ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

func computerCreateCommand(
	body openapi.CreateComputerJSONRequestBody,
) (appcomputer.CreateCommand, error) {
	osType := "macos"
	if body.OsType != nil {
		if !body.OsType.Valid() {
			return appcomputer.CreateCommand{}, apperror.New(
				"invalid_request", "Computer 平台无效", nil,
			)
		}
		osType = string(*body.OsType)
	}
	return appcomputer.CreateCommand{
		Name: body.Name, TATInstanceKind: "managed", OSType: osType,
	}, nil
}

func computerDTO(value computerport.Computer) (openapi.Computer, error) {
	id, err := parseDomainID(value.ID, "Computer")
	if err != nil {
		return openapi.Computer{}, err
	}
	serverID, err := parseDomainID(value.ServerID, "Server")
	if err != nil {
		return openapi.Computer{}, err
	}
	result := openapi.Computer{
		Id: id, ServerId: serverID, Name: value.Name,
		OsType:          openapi.ComputerOsType(value.OSType),
		LifecycleState:  openapi.ComputerLifecycleState(value.LifecycleState),
		ConnectionState: openapi.ComputerConnectionState(value.TATAgentState),
		Revision:        value.Revision,
	}
	if !result.OsType.Valid() || !result.LifecycleState.Valid() || !result.ConnectionState.Valid() ||
		result.Revision < 1 {
		return openapi.Computer{}, invalidDomainData("Computer 数据无效", nil)
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

func computerRuntimeCredentialDTO(
	value appcomputer.RuntimeCredential,
) (openapi.ComputerRuntimeCredential, error) {
	id, err := parseDomainID(value.ID, "Computer Runtime Credential")
	if err != nil {
		return openapi.ComputerRuntimeCredential{}, err
	}
	if value.Version == 0 || value.Version > math.MaxInt64 ||
		strings.TrimSpace(value.Secret) == "" || value.ExpiresAt.IsZero() {
		return openapi.ComputerRuntimeCredential{}, invalidDomainData(
			"Computer Runtime Credential 数据无效", nil,
		)
	}
	secret := value.Secret
	result := openapi.ComputerRuntimeCredential{
		CredentialId: id,
		Version:      int64(value.Version),
		Secret:       &secret,
		ExpiresAt:    value.ExpiresAt.UTC(),
	}
	if value.GraceExpiresAt != nil {
		graceExpiresAt := value.GraceExpiresAt.UTC()
		result.GraceExpiresAt = &graceExpiresAt
	}
	return result, nil
}

func computerOperationDTO(
	value computerport.Operation,
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
		return openapi.Operation{}, invalidDomainData("Operation 数据无效", nil)
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
			Code:    code,
			Message: "腾讯云 TAT 操作尚未收敛",
		}
	}
	return result, nil
}
