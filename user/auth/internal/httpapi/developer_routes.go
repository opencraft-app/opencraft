package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/devroute"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

type DeveloperRouteClient interface {
	Register(context.Context, devroute.RegisterInput) (devroute.Registration, error)
	Get(context.Context, int64) (devroute.Registration, error)
	Disable(context.Context, int64) (devroute.Registration, error)
}

type developerRouteRequest struct {
	Port       int `json:"port"`
	TTLSeconds int `json:"ttlSeconds"`
}

func registerDeveloperRouteRoutes(router gin.IRoutes, handler *Handler) {
	router.POST("/auth/dev-environments/registration", handler.registerPersonalDevEnvironment)
	router.GET("/auth/dev-environments/registration", handler.getPersonalDevEnvironment)
	router.DELETE("/auth/dev-environments/registration", handler.unregisterPersonalDevEnvironment)
}

func (h *Handler) registerPersonalDevEnvironment(ctx *gin.Context) {
	setDeveloperRouteNoStore(ctx)
	var request developerRouteRequest
	if err := ctx.ShouldBindJSON(&request); err != nil || request.Port <= 0 || request.Port > 65535 || request.TTLSeconds < 60 || request.TTLSeconds > 86400 {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_request", Message: "port or ttlSeconds is invalid"})
		return
	}
	uin, targetIP, body, status := h.personalDeveloperRouteIdentity(ctx, true, true)
	if body != nil {
		ctx.JSON(status, body)
		return
	}
	registration, err := h.developerRoutes.Register(ctx, devroute.RegisterInput{
		Uin: uin, TargetIP: targetIP, Port: request.Port, TTLSeconds: request.TTLSeconds,
	})
	if err != nil {
		errorBody, errorStatus := developerRouteError(err)
		ctx.JSON(errorStatus, errorBody)
		return
	}
	if !validDeveloperRouteRegistration(registration) {
		ctx.JSON(http.StatusBadGateway, api.ErrorResponse{Code: "personal_dev_environment_invalid_response", Message: "personal DevCloud registration returned invalid data"})
		return
	}
	ctx.JSON(http.StatusOK, registration)
}

func (h *Handler) getPersonalDevEnvironment(ctx *gin.Context) {
	setDeveloperRouteNoStore(ctx)
	uin, _, body, status := h.personalDeveloperRouteIdentity(ctx, false, false)
	if body != nil {
		ctx.JSON(status, body)
		return
	}
	registration, err := h.developerRoutes.Get(ctx, uin)
	if err != nil {
		errorBody, errorStatus := developerRouteError(err)
		ctx.JSON(errorStatus, errorBody)
		return
	}
	registration.TunnelToken = ""
	if !validDeveloperRouteRegistration(registration) {
		ctx.JSON(http.StatusBadGateway, api.ErrorResponse{Code: "personal_dev_environment_invalid_response", Message: "personal DevCloud registration returned invalid data"})
		return
	}
	ctx.JSON(http.StatusOK, registration)
}

func (h *Handler) unregisterPersonalDevEnvironment(ctx *gin.Context) {
	setDeveloperRouteNoStore(ctx)
	uin, _, body, status := h.personalDeveloperRouteIdentity(ctx, false, false)
	if body != nil {
		ctx.JSON(status, body)
		return
	}
	registration, err := h.developerRoutes.Disable(ctx, uin)
	if err != nil {
		errorBody, errorStatus := developerRouteError(err)
		ctx.JSON(errorStatus, errorBody)
		return
	}
	registration.TunnelToken = ""
	if !validDeveloperRouteRegistration(registration) {
		ctx.JSON(http.StatusBadGateway, api.ErrorResponse{Code: "personal_dev_environment_invalid_response", Message: "personal DevCloud registration returned invalid data"})
		return
	}
	ctx.JSON(http.StatusOK, registration)
}

func (h *Handler) personalDeveloperRouteIdentity(ctx *gin.Context, requireActive bool, requireTargetIP bool) (int64, string, *api.ErrorResponse, int) {
	if h == nil || h.service == nil || h.developerRoutes == nil {
		return 0, "", &api.ErrorResponse{Code: "personal_dev_environment_disabled", Message: "personal DevCloud registration is unavailable in this environment"}, http.StatusServiceUnavailable
	}
	binding, err := h.service.CurrentShadowBinding(ctx, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		return 0, "", &body, status
	}
	if binding.Uin <= 0 || (requireActive && binding.Status != shadowbinding.StatusActive) {
		return 0, "", &api.ErrorResponse{Code: "shadow_binding_not_ready", Message: "shadow binding must be active before registering a personal DevCloud route"}, http.StatusConflict
	}
	if !requireTargetIP {
		return binding.Uin, "", nil, 0
	}
	targetIP := strings.TrimSpace(ctx.ClientIP())
	if net.ParseIP(targetIP) == nil {
		return 0, "", &api.ErrorResponse{Code: "invalid_source_ip", Message: "request source IP is unavailable"}, http.StatusBadRequest
	}
	return binding.Uin, targetIP, nil, 0
}

func validDeveloperRouteRegistration(registration devroute.Registration) bool {
	if registration.Uin <= 0 {
		return false
	}
	switch strings.TrimSpace(registration.Status) {
	case "active", "expired", "disabled":
		return true
	default:
		return false
	}
}

func developerRouteError(err error) (api.ErrorResponse, int) {
	var upstream *devroute.Error
	if errors.As(err, &upstream) {
		status := upstream.Status
		switch status {
		case http.StatusBadRequest, http.StatusUnauthorized, http.StatusNotFound, http.StatusConflict,
			http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		default:
			status = http.StatusBadGateway
		}
		code := strings.TrimSpace(upstream.Code)
		if code == "" {
			code = "personal_dev_environment_upstream_error"
		}
		return api.ErrorResponse{Code: code, Message: upstream.Message}, status
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return api.ErrorResponse{Code: "personal_dev_environment_timeout", Message: "personal DevCloud registration timed out"}, http.StatusGatewayTimeout
	}
	return api.ErrorResponse{Code: "personal_dev_environment_unavailable", Message: "personal DevCloud registration is unavailable"}, http.StatusBadGateway
}

func setDeveloperRouteNoStore(ctx *gin.Context) {
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Pragma", "no-cache")
}
