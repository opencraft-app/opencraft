package httpapi

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

const timeRFC3339Milli = "2006-01-02T15:04:05.000Z07:00"

type adminHandler struct {
	service     *service.Service
	avatarStore AvatarStore
}

type adminListResponse[T any] struct {
	Items []T `json:"items"`
	Total int `json:"total"`
}

type adminUserResponse struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Email          string   `json:"email"`
	Phone          string   `json:"phone"`
	AuthMethods    []string `json:"authMethods"`
	QQOpenID       string   `json:"qqOpenId"`
	WeChatSubject  string   `json:"wechatSubject"`
	InviteRequired bool     `json:"inviteRequired"`
	CreatedAt      string   `json:"createdAt"`
	UpdatedAt      string   `json:"updatedAt"`
}

type adminSMSChallengeResponse struct {
	Phone            string `json:"phone"`
	Code             string `json:"code"`
	ExpiresAt        string `json:"expiresAt"`
	CooldownUntil    string `json:"cooldownUntil"`
	RemainingRetries int    `json:"remainingRetries"`
	CreatedAt        string `json:"createdAt"`
	UpdatedAt        string `json:"updatedAt"`
}

type adminInviteResponse struct {
	Code         string  `json:"code"`
	State        string  `json:"state"`
	Message      string  `json:"message"`
	UsedByUserID string  `json:"usedByUserId"`
	UsedVia      string  `json:"usedVia"`
	UsedAt       *string `json:"usedAt,omitempty"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

type createInviteRequest struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type createImpersonationSessionRequest struct {
	ReturnTo string `json:"returnTo"`
	Reason   string `json:"reason"`
}

type adminImpersonationSessionResponse struct {
	LoginURL     string `json:"loginUrl"`
	ExpiresAt    string `json:"expiresAt"`
	UserID       string `json:"userId"`
	Impersonated bool   `json:"impersonated"`
}

func registerAdminRoutes(group *gin.RouterGroup, authService *service.Service, avatarStore AvatarStore) {
	handler := &adminHandler{service: authService, avatarStore: avatarStore}
	group.GET("/users", handler.listUsers)
	group.DELETE("/users/:id", handler.deleteUser)
	group.POST("/users/:id/impersonation-sessions", handler.createImpersonationSession)
	group.GET("/sms-challenges", handler.listSMSChallenges)
	group.DELETE("/sms-challenges/:phone", handler.deleteSMSChallenge)
	group.GET("/invites", handler.listInvites)
	group.POST("/invites", handler.createInvite)
	group.POST("/invites/:code/disable", handler.disableInvite)
}

func (h *adminHandler) listUsers(ctx *gin.Context) {
	items, err := h.service.ListAdminUsers(ctx.Request.Context(), ctx.Query("search"), queryLimit(ctx))
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "list_users_failed"})
		return
	}

	resp := make([]adminUserResponse, 0, len(items))
	for _, item := range items {
		resp = append(resp, adminUserResponse{
			ID:             item.ID,
			Name:           item.Name,
			Email:          item.Email,
			Phone:          item.Phone,
			AuthMethods:    item.AuthMethods,
			QQOpenID:       item.QQOpenID,
			WeChatSubject:  item.WeChatSubject,
			InviteRequired: item.InviteRequired,
			CreatedAt:      item.CreatedAt.UTC().Format(timeRFC3339Milli),
			UpdatedAt:      item.UpdatedAt.UTC().Format(timeRFC3339Milli),
		})
	}
	ctx.JSON(http.StatusOK, adminListResponse[adminUserResponse]{Items: resp, Total: len(resp)})
}

func (h *adminHandler) deleteUser(ctx *gin.Context) {
	user, err := h.service.FindUserByID(ctx.Request.Context(), ctx.Param("id"))
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}

	if h.avatarStore != nil && strings.TrimSpace(user.AvatarObjectKey) != "" {
		if err := h.avatarStore.DeleteAvatar(ctx.Request.Context(), user.AvatarObjectKey); err != nil {
			requestLogger(ctx, nil).Error("admin user avatar delete failed", "user_id", user.ID, "object_key", user.AvatarObjectKey, "err", err)
			ctx.JSON(http.StatusInternalServerError, api.ErrorResponse{Code: "avatar_delete_failed", Message: "头像删除失败。"})
			return
		}
	}

	if err := h.service.DeleteAdminUser(ctx.Request.Context(), user.ID); err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}

	ctx.Status(http.StatusNoContent)
}

func (h *adminHandler) createImpersonationSession(ctx *gin.Context) {
	var req createImpersonationSessionRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_request", Message: "请求格式不正确。"})
		return
	}

	if _, err := parseImpersonationReturnTo(req.ReturnTo); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_return_to", Message: "returnTo 必须是包含 scheme 和 host 的绝对 URL。"})
		return
	}

	session, err := h.service.CreateImpersonationSession(ctx.Request.Context(), ctx.Param("id"), req.Reason)
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	loginURL, err := buildImpersonationLoginURL(req.ReturnTo, session.Token)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_return_to", Message: "returnTo 必须是包含 scheme 和 host 的绝对 URL。"})
		return
	}

	ctx.JSON(http.StatusOK, adminImpersonationSessionResponse{
		LoginURL:     loginURL,
		ExpiresAt:    session.ExpiresAt.UTC().Format(timeRFC3339Milli),
		UserID:       session.User.ID,
		Impersonated: true,
	})
}

func buildImpersonationLoginURL(rawReturnTo string, sessionToken string) (string, error) {
	parsed, err := parseImpersonationReturnTo(rawReturnTo)
	if err != nil {
		return "", err
	}

	parsed.Fragment = withSessionTokenFragment(parsed.Fragment, sessionToken)
	return parsed.String(), nil
}

func parseImpersonationReturnTo(rawReturnTo string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawReturnTo))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errInvalidReturnTo
	}
	return parsed, nil
}

func withSessionTokenFragment(rawFragment string, sessionToken string) string {
	parts := make([]string, 0)
	for _, part := range strings.Split(rawFragment, "&") {
		if part == "" {
			continue
		}
		key := part
		if before, _, ok := strings.Cut(part, "="); ok {
			key = before
		}
		if decodedKey, err := url.QueryUnescape(key); err == nil && decodedKey == "session_token" {
			continue
		}
		parts = append(parts, part)
	}
	parts = append(parts, "session_token="+url.QueryEscape(strings.TrimSpace(sessionToken)))
	return strings.Join(parts, "&")
}

var errInvalidReturnTo = &service.Error{Code: "invalid_return_to", Message: "returnTo 必须是包含 scheme 和 host 的绝对 URL。", Status: http.StatusBadRequest}

func (h *adminHandler) listSMSChallenges(ctx *gin.Context) {
	items, err := h.service.ListAdminSMSChallenges(ctx.Request.Context(), ctx.Query("search"), queryLimit(ctx))
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "list_sms_challenges_failed"})
		return
	}

	resp := make([]adminSMSChallengeResponse, 0, len(items))
	for _, item := range items {
		resp = append(resp, adminSMSChallengeResponse{
			Phone:            item.Phone,
			Code:             item.Code,
			ExpiresAt:        item.ExpiresAt.UTC().Format(timeRFC3339Milli),
			CooldownUntil:    item.CooldownUntil.UTC().Format(timeRFC3339Milli),
			RemainingRetries: item.RemainingRetries,
			CreatedAt:        item.CreatedAt.UTC().Format(timeRFC3339Milli),
			UpdatedAt:        item.UpdatedAt.UTC().Format(timeRFC3339Milli),
		})
	}
	ctx.JSON(http.StatusOK, adminListResponse[adminSMSChallengeResponse]{Items: resp, Total: len(resp)})
}

func (h *adminHandler) deleteSMSChallenge(ctx *gin.Context) {
	if err := h.service.DeleteAdminSMSChallenge(ctx.Request.Context(), ctx.Param("phone")); err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	ctx.Status(http.StatusNoContent)
}

func (h *adminHandler) listInvites(ctx *gin.Context) {
	items, err := h.service.ListAdminInvites(ctx.Request.Context(), ctx.Query("search"), ctx.Query("state"), queryLimit(ctx))
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "list_invites_failed"})
		return
	}

	resp := make([]adminInviteResponse, 0, len(items))
	for _, item := range items {
		var usedAt *string
		if item.UsedAt != nil {
			value := item.UsedAt.UTC().Format(timeRFC3339Milli)
			usedAt = &value
		}
		resp = append(resp, adminInviteResponse{
			Code:         item.Code,
			State:        item.State,
			Message:      item.Message,
			UsedByUserID: item.UsedByUserID,
			UsedVia:      item.UsedVia,
			UsedAt:       usedAt,
			CreatedAt:    item.CreatedAt.UTC().Format(timeRFC3339Milli),
			UpdatedAt:    item.UpdatedAt.UTC().Format(timeRFC3339Milli),
		})
	}
	ctx.JSON(http.StatusOK, adminListResponse[adminInviteResponse]{Items: resp, Total: len(resp)})
}

func (h *adminHandler) createInvite(ctx *gin.Context) {
	var req createInviteRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}

	item, err := h.service.CreateAdminInvite(ctx.Request.Context(), req.Code, req.Message)
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}

	ctx.JSON(http.StatusCreated, adminInviteResponse{
		Code:         item.Code,
		State:        item.State,
		Message:      item.Message,
		UsedByUserID: item.UsedByUserID,
		UsedVia:      item.UsedVia,
		CreatedAt:    item.CreatedAt.UTC().Format(timeRFC3339Milli),
		UpdatedAt:    item.UpdatedAt.UTC().Format(timeRFC3339Milli),
	})
}

func (h *adminHandler) disableInvite(ctx *gin.Context) {
	if err := h.service.DisableAdminInvite(ctx.Request.Context(), ctx.Param("code")); err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	ctx.Status(http.StatusNoContent)
}

func queryLimit(ctx *gin.Context) int {
	raw := strings.TrimSpace(ctx.Query("limit"))
	if raw == "" {
		return 50
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 50
	}
	return value
}
