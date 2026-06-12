package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

type internalAPI struct {
	service                    *service.Service
	shadowBindingInternalToken string
	shadowTencentCallbackToken string
}

type internalEnvelope struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
	Data      any    `json:"data,omitempty"`
}

type internalShadowBinding struct {
	UserID         string `json:"user_id"`
	ShadowUserName string `json:"shadow_user_name,omitempty"`
	Uin            int64  `json:"uin"`
	OwnerUin       int64  `json:"owner_uin"`
	AppID          int64  `json:"app_id"`
	InstanceID     string `json:"instance_id,omitempty"`
	CountryCode    string `json:"country_code,omitempty"`
	PhoneNumber    string `json:"phone_number,omitempty"`
	CreatedAt      string `json:"created_at,omitempty"`
}

type tencentCloudCallbackEnvelope struct {
	Version       string `json:"version"`
	Caller        string `json:"caller"`
	ComponentName string `json:"componentName"`
	EventID       any    `json:"eventId"`
	Timestamp     int64  `json:"timestamp"`
	Interface     struct {
		InterfaceName string `json:"interfaceName"`
		Para          struct {
			UserID   string `json:"user_id"`
			AuthCode string `json:"auth_code"`
		} `json:"para"`
	} `json:"interface"`
}

func registerInternalShadowRoutes(router gin.IRoutes, authService *service.Service, config ServerConfig) {
	internal := &internalAPI{
		service:                    authService,
		shadowBindingInternalToken: strings.TrimSpace(config.ShadowBindingInternalToken),
		shadowTencentCallbackToken: strings.TrimSpace(config.ShadowTencentCallbackToken),
	}
	router.GET("/internal/shadow/binding", internal.handleGetShadowBinding)
	router.POST("/internal/tencentcloud/account", internal.handleTencentCloudCallback)
	router.POST("/auth/internal/tencentcloud/account", internal.handleTencentCloudCallback)
}

func (a *internalAPI) handleGetShadowBinding(ctx *gin.Context) {
	if !isAuthorizedInternalToken(ctx, a.shadowBindingInternalToken) {
		ctx.JSON(http.StatusUnauthorized, internalEnvelope{Code: "unauthorized", Message: "unauthorized"})
		return
	}
	userID := strings.TrimSpace(ctx.Query("user_id"))
	externalUserID := strings.TrimSpace(ctx.Query("external_user_id"))
	switch {
	case userID == "" && externalUserID == "":
		ctx.JSON(http.StatusBadRequest, internalEnvelope{Code: "invalid_request", Message: "user_id or external_user_id is required"})
		return
	case userID != "" && externalUserID != "":
		ctx.JSON(http.StatusBadRequest, internalEnvelope{Code: "invalid_request", Message: "user_id and external_user_id are mutually exclusive"})
		return
	case userID == "":
		userID = externalUserID
	}

	binding, err := a.service.InternalShadowBinding(ctx.Request.Context(), userID)
	if err != nil {
		body, status := toErrorBody(err)
		if status == http.StatusNotFound {
			ctx.JSON(http.StatusNotFound, internalEnvelope{Code: body.Code, Message: body.Message})
			return
		}
		ctx.JSON(status, internalEnvelope{Code: body.Code, Message: body.Message})
		return
	}
	ctx.JSON(http.StatusOK, internalEnvelope{Code: "OK", Message: "ok", Data: toInternalShadowBinding(binding)})
}

func (a *internalAPI) handleTencentCloudCallback(ctx *gin.Context) {
	if !isAuthorizedCallbackToken(ctx, a.shadowTencentCallbackToken) {
		ctx.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}
	var req tencentCloudCallbackEnvelope
	if err := json.NewDecoder(ctx.Request.Body).Decode(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	logger := requestLogger(ctx, nil)
	logger.Info("tencentcloud account callback received",
		"interface", req.Interface.InterfaceName,
		"caller", req.Caller,
		"component", req.ComponentName,
		"has_user_id", strings.TrimSpace(req.Interface.Para.UserID) != "",
		"has_auth_code", strings.TrimSpace(req.Interface.Para.AuthCode) != "",
	)

	switch req.Interface.InterfaceName {
	case "qcloud.saas.checkSaaSAccountExist":
		exist, err := a.service.CheckSaaSAccountExist(ctx.Request.Context(), req.Interface.Para.UserID)
		if err != nil {
			logger.Warn("tencentcloud account callback check account failed",
				"interface", req.Interface.InterfaceName,
				"user_id", req.Interface.Para.UserID,
				"err", err,
			)
			writeTencentCloudCallbackError(ctx, err)
			return
		}
		logger.Info("tencentcloud account callback check account succeeded",
			"interface", req.Interface.InterfaceName,
			"user_id", req.Interface.Para.UserID,
			"exist", exist,
		)
		ctx.JSON(http.StatusOK, gin.H{"returnCode": 0, "returnMessage": "ok", "data": gin.H{"exist": exist}})
	case "qcloud.saas.checkSaaSAuthCode":
		userID, err := a.service.CheckSaaSAuthCode(ctx.Request.Context(), req.Interface.Para.AuthCode)
		if err != nil {
			logger.Warn("tencentcloud account callback check auth code failed",
				"interface", req.Interface.InterfaceName,
				"err", err,
			)
			writeTencentCloudCallbackError(ctx, err)
			return
		}
		logger.Info("tencentcloud account callback check auth code succeeded",
			"interface", req.Interface.InterfaceName,
			"returned_user_id", userID,
			"found", strings.TrimSpace(userID) != "",
		)
		ctx.JSON(http.StatusOK, gin.H{"returnCode": 0, "returnMessage": "ok", "data": gin.H{"user_id": userID}})
	default:
		slog.Warn("tencentcloud account callback unsupported interface", "interface", req.Interface.InterfaceName)
		ctx.JSON(http.StatusOK, gin.H{"returnCode": 1, "returnMessage": "unsupported interfaceName"})
	}
}

func toInternalShadowBinding(binding service.ShadowBindingResult) internalShadowBinding {
	out := internalShadowBinding{
		UserID:         binding.UserID,
		ShadowUserName: binding.ShadowUserName,
		Uin:            binding.Uin,
		OwnerUin:       binding.OwnerUin,
		AppID:          binding.AppID,
	}
	if !binding.CreatedAt.IsZero() {
		out.CreatedAt = binding.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00")
	}
	return out
}

func isAuthorizedInternalToken(ctx *gin.Context, expected string) bool {
	if strings.TrimSpace(expected) == "" {
		return false
	}
	return bearerToken(ctx) == expected
}

func isAuthorizedCallbackToken(ctx *gin.Context, expected string) bool {
	if strings.TrimSpace(expected) == "" {
		return false
	}
	if strings.TrimSpace(ctx.Query("token")) == expected {
		return true
	}
	if strings.TrimSpace(ctx.GetHeader("X-Shadow-Callback-Token")) == expected {
		return true
	}
	return bearerToken(ctx) == expected
}

func bearerToken(ctx *gin.Context) string {
	authHeader := strings.TrimSpace(ctx.GetHeader("Authorization"))
	if len(authHeader) < len("Bearer ") || !strings.EqualFold(authHeader[:len("Bearer ")], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(authHeader[len("Bearer "):])
}

func writeTencentCloudCallbackError(ctx *gin.Context, err error) {
	status := http.StatusInternalServerError
	message := "internal error"
	var authErr *service.Error
	if errors.As(err, &authErr) {
		status = authErr.Status
		message = authErr.Message
	} else if err != nil {
		message = err.Error()
	}
	ctx.JSON(status, gin.H{"returnCode": 1, "returnMessage": message})
}
