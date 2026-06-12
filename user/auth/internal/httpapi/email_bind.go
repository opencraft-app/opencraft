package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func (h *Handler) RequestEmailBind(ctx context.Context, request api.RequestEmailBindRequestObject) (api.RequestEmailBindResponseObject, error) {
	if request.Body == nil {
		return api.RequestEmailBind400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "invalid_request",
			Message: "请求格式不正确。",
		})}, nil
	}

	cooldown, err := h.service.RequestEmailBind(ctx, tokenFromContext(ctx), string(request.Body.Email))
	if err != nil {
		body, status := toErrorBody(err)
		switch status {
		case http.StatusUnauthorized:
			return api.RequestEmailBind401JSONResponse(body), nil
		case http.StatusConflict:
			return api.RequestEmailBind409JSONResponse(body), nil
		case http.StatusTooManyRequests:
			return api.RequestEmailBind429JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.RequestEmailBind502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.RequestEmailBind503JSONResponse(body), nil
		default:
			if status >= http.StatusInternalServerError {
				return nil, err
			}
			return api.RequestEmailBind400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		}
	}

	seconds := int(cooldown.Round(time.Second) / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	return api.RequestEmailBind200JSONResponse(api.EmailBindRequestResponse{CooldownSeconds: seconds}), nil
}

func (h *Handler) HandleConfirmEmailBind(ctx *gin.Context) {
	token := strings.TrimSpace(ctx.Query("token"))
	user, err := h.service.ConfirmEmailBind(ctx.Request.Context(), token)
	if err != nil {
		code := "failed"
		if authErr, ok := err.(*service.Error); ok {
			switch authErr.Code {
			case "email_bind_expired":
				code = "expired"
			case "email_in_use":
				code = "in_use"
			case "email_bind_disabled":
				code = "unavailable"
			case "invalid_email_bind_token":
				code = "invalid"
			}
		}
		ctx.Redirect(http.StatusFound, h.emailBindRedirectURL("email_bind_error="+code))
		return
	}
	_ = user
	ctx.Redirect(http.StatusFound, h.emailBindRedirectURL("email_bound=1"))
}

func (h *Handler) emailBindRedirectURL(query string) string {
	base := strings.TrimRight(strings.TrimSpace(h.frontendBaseURL), "/")
	if base == "" {
		base = strings.TrimRight(strings.TrimSpace(h.publicBaseURL), "/")
	}
	if base == "" {
		return "/account?" + query
	}
	return service.BuildEmailBindRedirectURL(base, query)
}
