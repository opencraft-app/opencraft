package httpapi

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/tat"
)

type tatDeviceBindRequest struct {
	CallbackURL string `json:"callback_url"`
	DeviceName  string `json:"device_name"`
}

type tatDeviceBindResponse struct {
	Status           string                    `json:"status"`
	Ticket           string                    `json:"ticket"`
	CallbackURL      string                    `json:"callback_url"`
	RedirectURL      string                    `json:"redirect_url"`
	ExpiresAt        time.Time                 `json:"expires_at"`
	RegistrationCode string                    `json:"registration_code"`
	Registration     tatDeviceBindRegistration `json:"registration"`
}

type tatDeviceBindRegistration struct {
	Region            string `json:"region"`
	RegisterCodeID    string `json:"register_code_id"`
	RegisterCodeValue string `json:"register_code_value"`
	RequestID         string `json:"request_id"`
}

func (h *Handler) CreateTATDeviceBind(ctx *gin.Context) {
	session, err := h.tatDeviceBindSession(ctx)
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}

	var request tatDeviceBindRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{
			Code:    "invalid_request",
			Message: "请求格式不正确。",
		})
		return
	}

	callbackURL, err := validateLocalTATCallbackURL(request.CallbackURL)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{
			Code:    "invalid_callback_url",
			Message: err.Error(),
		})
		return
	}

	if h.tatRegisterIssuer == nil {
		ctx.JSON(http.StatusServiceUnavailable, api.ErrorResponse{
			Code:    "tat_register_unavailable",
			Message: "TAT 注册码服务未配置，请稍后重试。",
		})
		return
	}

	registration, err := h.tatRegisterIssuer.CreateRegisterCode(ctx.Request.Context(), tat.CreateRegisterCodeInput{
		Description:        tatRegisterDescription(session.User.ID, request.DeviceName),
		InstanceNamePrefix: "lightvela-mac",
		RegisterLimit:      1,
	})
	if err != nil {
		requestLogger(ctx, nil).Error("create tat register code failed",
			"user_id", session.User.ID,
			"err", err,
		)
		ctx.JSON(http.StatusBadGateway, api.ErrorResponse{
			Code:    "tat_register_failed",
			Message: "TAT 注册码生成失败，请稍后重试。",
		})
		return
	}

	redirectURL := appendDeviceBindRegistration(callbackURL, registration)
	requestLogger(ctx, nil).Info("tat register code issued",
		"user_id", session.User.ID,
		"device_name", strings.TrimSpace(request.DeviceName),
		"tat_region", registration.Region,
		"tat_request_id", registration.RequestID,
	)

	expiresAt := time.Now().UTC().Add(time.Duration(registration.EffectiveTimeHours) * time.Hour)
	ctx.JSON(http.StatusOK, tatDeviceBindResponse{
		Status:           "register_code_issued",
		Ticket:           registration.RegisterCodeID,
		CallbackURL:      callbackURL,
		RedirectURL:      redirectURL,
		ExpiresAt:        expiresAt,
		RegistrationCode: registration.RegisterCodeValue,
		Registration: tatDeviceBindRegistration{
			Region:            registration.Region,
			RegisterCodeID:    registration.RegisterCodeID,
			RegisterCodeValue: registration.RegisterCodeValue,
			RequestID:         registration.RequestID,
		},
	})
}

func (h *Handler) tatDeviceBindSession(ctx *gin.Context) (*service.AuthSession, error) {
	token := tokenFromContext(ctx)
	session, err := h.service.CurrentSession(ctx.Request.Context(), token)
	if err == nil {
		return session, nil
	}
	if h.deviceBindTokens == nil || !strings.HasPrefix(strings.TrimSpace(token), deviceBindTokenPrefix) {
		return nil, err
	}
	claims, tokenErr := h.deviceBindTokens.Verify(token)
	if tokenErr != nil {
		return nil, &service.Error{
			Code:    "device_bind_unauthorized",
			Message: "设备绑定授权已失效，请重新登录 LightVela。",
			Status:  http.StatusUnauthorized,
		}
	}
	return &service.AuthSession{
		Token: token,
		User:  service.User{ID: claims.UserID},
	}, nil
}

func validateLocalTATCallbackURL(rawURL string) (string, error) {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return "", &apiErrorMessage{"回跳地址不能为空。"}
	}

	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" {
		return "", &apiErrorMessage{"回跳地址必须是本机 HTTP 地址。"}
	}
	if parsed.User != nil || parsed.Opaque != "" {
		return "", &apiErrorMessage{"回跳地址格式不正确。"}
	}
	if !isLoopbackHost(parsed.Hostname()) {
		return "", &apiErrorMessage{"回跳地址只允许 localhost、127.0.0.1 或 ::1。"}
	}
	if parsed.Path != "/lightvela/callback" {
		return "", &apiErrorMessage{"回跳路径必须是 /lightvela/callback。"}
	}
	return parsed.String(), nil
}

func appendDeviceBindRegistration(callbackURL string, registration tat.RegisterCode) string {
	parsed, err := url.Parse(callbackURL)
	if err != nil {
		return callbackURL
	}
	query := parsed.Query()
	query.Set("ticket", registration.RegisterCodeID)
	query.Set("region", registration.Region)
	query.Set("register_code_id", registration.RegisterCodeID)
	query.Set("register_code_value", registration.RegisterCodeValue)
	query.Set("registration_code", registration.RegisterCodeValue)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func tatRegisterDescription(userID string, deviceName string) string {
	deviceName = strings.TrimSpace(deviceName)
	if deviceName == "" {
		deviceName = "Mac"
	}
	return fmt.Sprintf("LightVela TAT Mac Guide: %s (%s)", deviceName, userID)
}

type apiErrorMessage struct {
	message string
}

func (e *apiErrorMessage) Error() string {
	return e.message
}
