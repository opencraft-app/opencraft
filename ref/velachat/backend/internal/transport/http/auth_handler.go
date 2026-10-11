package httptransport

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"chatserver/internal/api/openapi"
	appaccountauth "chatserver/internal/app/accountauth"
	"chatserver/internal/apperror"
	accountauthport "chatserver/internal/ports/accountauth"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

type accountAuthService interface {
	Register(
		context.Context,
		appaccountauth.RegisterCommand,
	) (appaccountauth.Result, error)
	Login(
		context.Context,
		appaccountauth.LoginCommand,
	) (appaccountauth.Result, error)
	Refresh(context.Context, string) (appaccountauth.Result, error)
	Logout(context.Context, string, string) error
}

// AuthHandler 实现四个 Human 认证 strict operation。
//
// 嵌入的接口只用于满足生成接口；NewAuthOnlyRoutes 不注册其他 operation，因此不会
// 调用 nil fallback。
type AuthHandler struct {
	openapi.StrictServerInterface
	service accountAuthService
}

var _ openapi.StrictServerInterface = (*AuthHandler)(nil)

// NewAuthHandler 创建 strict 认证 handler。
func NewAuthHandler(service accountAuthService) (*AuthHandler, error) {
	if service == nil {
		return nil, errors.New("账号认证应用服务不能为空")
	}
	return &AuthHandler{service: service}, nil
}

// Register 注册账号并返回首对 access/refresh token。
func (h *AuthHandler) Register(
	ctx context.Context,
	request openapi.RegisterRequestObject,
) (openapi.RegisterResponseObject, error) {
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "注册参数无效", nil)
	}
	result, err := h.service.Register(ctx, appaccountauth.RegisterCommand{
		Email:       string(request.Body.Email),
		Password:    request.Body.Password,
		DisplayName: request.Body.DisplayName,
	})
	if err != nil {
		return nil, err
	}
	body, err := authResultDTO(result)
	if err != nil {
		return nil, err
	}
	return openapi.Register201JSONResponse{
		Body: body,
		Headers: openapi.Register201ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

// Login 使用邮箱密码创建新登录 session。
func (h *AuthHandler) Login(
	ctx context.Context,
	request openapi.LoginRequestObject,
) (openapi.LoginResponseObject, error) {
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "登录参数无效", nil)
	}
	result, err := h.service.Login(ctx, appaccountauth.LoginCommand{
		Email:    string(request.Body.Email),
		Password: request.Body.Password,
	})
	if err != nil {
		return nil, err
	}
	body, err := authResultDTO(result)
	if err != nil {
		return nil, err
	}
	return openapi.Login200JSONResponse{
		Body: body,
		Headers: openapi.Login200ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

// RefreshAuth 单次轮换 refresh token。
func (h *AuthHandler) RefreshAuth(
	ctx context.Context,
	request openapi.RefreshAuthRequestObject,
) (openapi.RefreshAuthResponseObject, error) {
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "刷新参数无效", nil)
	}
	result, err := h.service.Refresh(ctx, request.Body.RefreshToken)
	if err != nil {
		return nil, err
	}
	body, err := authResultDTO(result)
	if err != nil {
		return nil, err
	}
	return openapi.RefreshAuth200JSONResponse{
		Body: body,
		Headers: openapi.RefreshAuth200ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

// Logout 撤销由 OpenAPI HumanBearer hook 确认的当前 session。
func (h *AuthHandler) Logout(
	ctx context.Context,
	_ openapi.LogoutRequestObject,
) (openapi.LogoutResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if err := h.service.Logout(
		ctx,
		principal.AccountID(),
		principal.AuthSessionID(),
	); err != nil {
		return nil, err
	}
	return openapi.Logout204Response{}, nil
}

// NewAuthOnlyRoutes 只注册四个已实现的认证 operation。
func NewAuthOnlyRoutes(
	service accountAuthService,
	encoder *ErrorEncoder,
) (http.Handler, error) {
	if encoder == nil {
		return nil, ErrValidatorEncoderRequired
	}
	handler, err := NewAuthHandler(service)
	if err != nil {
		return nil, err
	}
	strict := openapi.NewStrictHandlerWithOptions(
		handler,
		nil,
		StrictServerOptions(encoder),
	)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/auth/register", strict.Register)
	mux.HandleFunc("POST /v1/auth/login", strict.Login)
	mux.HandleFunc("POST /v1/auth/refresh", strict.RefreshAuth)
	mux.HandleFunc("POST /v1/auth/logout", strict.Logout)
	return mux, nil
}

func authResultDTO(result appaccountauth.Result) (openapi.AuthResult, error) {
	account, err := accountDTO(result.Account)
	if err != nil {
		return openapi.AuthResult{}, err
	}
	accessToken := result.AccessToken
	refreshToken := result.RefreshToken
	return openapi.AuthResult{
		AccessToken:  &accessToken,
		RefreshToken: &refreshToken,
		ExpiresAt:    result.ExpiresAt.UTC(),
		Account:      account,
	}, nil
}

func accountDTO(value accountauthport.Account) (openapi.Account, error) {
	id, err := uuid.Parse(value.ID)
	if err != nil || id == uuid.Nil {
		return openapi.Account{}, apperror.New(
			"internal_error",
			"账号数据无效",
			err,
		)
	}
	if value.Revision > uint64(^uint64(0)>>1) {
		return openapi.Account{}, apperror.New(
			"internal_error",
			"账号版本无效",
			nil,
		)
	}
	result := openapi.Account{
		Id:          id,
		Email:       openapi_types.Email(value.Email),
		DisplayName: value.DisplayName,
		ImState:     openapi.AccountImState(value.IMState),
		Revision:    int64(value.Revision),
	}
	if imUserID := strings.TrimSpace(value.IMUserID); imUserID != "" {
		result.ImUserId = &imUserID
	}
	return result, nil
}
