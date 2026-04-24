package handler

import (
	"strconv"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type createApiKeyRequest struct {
	Name string `json:"name"`
}

// CreateApiKey handles POST /api/admin/users/:user_id/api-keys
// @Summary Create API key
// @Description Generate a new API key for a user identified by business user_id. The plain-text key is only returned once in the response.
// @Tags Admin - API Keys
// @Accept json
// @Produce json
// @Param user_id path string true "Business user ID"
// @Param request body createApiKeyRequest false "Create API key request (name is optional, defaults to 'default')"
// @Success 200 {object} SwaggerCreateApiKeyResponse "Created API key (plain-text key shown only once)"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - invalid user_id or key generation failed"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "User not found"
// @Router /api/admin/users/{user_id}/api-keys [post]
func (h *AdminHandler) CreateApiKey(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	var req createApiKeyRequest
	_ = c.ShouldBindJSON(&req)

	name := req.Name
	if name == "" {
		name = "default"
	}

	plainKey, apiKey, err := h.keySvc.Generate(user.ID, name)
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, gin.H{
		"api_key":    plainKey,
		"key_id":     apiKey.ID,
		"key_prefix": apiKey.KeyPrefix,
		"name":       apiKey.Name,
		"created_at": apiKey.CreatedAt,
	})
}

// ListApiKeys handles GET /api/admin/users/:user_id/api-keys
// @Summary List user API keys
// @Description List API keys belonging to a user identified by business user_id, optionally filtered by status
// @Tags Admin - API Keys
// @Produce json
// @Param user_id path string true "Business user ID"
// @Param status query string false "API key status filter: active or revoked"
// @Success 200 {object} SwaggerApiKeyListResponse "User's API key list"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - invalid user_id"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "User not found"
// @Router /api/admin/users/{user_id}/api-keys [get]
func (h *AdminHandler) ListApiKeys(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	status := c.Query("status")
	if status != "" && status != "active" && status != "revoked" {
		response.ErrBadRequest(c, "Invalid status filter")
		return
	}

	keys, err := h.keySvc.ListByUserID(user.ID)
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	type apiKeyItem struct {
		ID         uuid.UUID  `json:"id"`
		UserID     string     `json:"user_id"`
		KeyPrefix  string     `json:"key_prefix"`
		Name       string     `json:"name"`
		IsActive   bool       `json:"is_active"`
		LastUsedAt *time.Time `json:"last_used_at"`
		CreatedAt  string     `json:"created_at"`
	}

	items := make([]apiKeyItem, 0, len(keys))
	for _, key := range keys {
		if status == "active" && !key.IsActive {
			continue
		}
		if status == "revoked" && key.IsActive {
			continue
		}
		items = append(items, apiKeyItem{
			ID:         key.ID,
			UserID:     user.UserID,
			KeyPrefix:  key.KeyPrefix,
			Name:       key.Name,
			IsActive:   key.IsActive,
			LastUsedAt: key.LastUsedAt,
			CreatedAt:  key.CreatedAt.Format("2006-01-02T15:04:05Z"),
		})
	}

	response.SuccessResponse(c, gin.H{"api_keys": items})
}

// ListAllApiKeys handles GET /api/admin/api-keys (跨用户 API Key 列表)
// @Summary List all API keys
// @Description List all API keys across all users with pagination. Includes user phone and status mapping.
// @Tags Admin - API Keys
// @Produce json
// @Param page query int false "Page number" default(1)
// @Param page_size query int false "Page size (max 100)" default(20)
// @Param search query string false "Search by key prefix or name"
// @Param status query string false "API key status filter: active or revoked"
// @Success 200 {object} SwaggerAllApiKeyListResponse "Paginated API key list across all users"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/api-keys [get]
func (h *AdminHandler) ListAllApiKeys(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	search := c.Query("search")
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize
	status := c.Query("status")
	if status != "" && status != "active" && status != "revoked" {
		response.ErrBadRequest(c, "Invalid status filter")
		return
	}

	keys, total, err := h.keySvc.ListAllWithUsers(offset, pageSize, search, status)
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	activeCount, _ := h.keySvc.CountActive()

	type apiKeyItem struct {
		ID            uuid.UUID `json:"id"`
		KeyPrefix     string    `json:"key_prefix"`
		Name          string    `json:"name"`
		UserID        string    `json:"user_id"`
		GatewayUserID uuid.UUID `json:"gateway_user_id"`
		UserPhone     string    `json:"user_phone"`
		UserNickname  string    `json:"user_nickname"`
		Status        string    `json:"status"`
		IsActive      bool      `json:"is_active"`
		CreatedAt     string    `json:"created_at"`
	}

	items := make([]apiKeyItem, 0, len(keys))
	for _, k := range keys {
		status := "revoked"
		if k.IsActive {
			status = "active"
		}
		items = append(items, apiKeyItem{
			ID:            k.ID,
			KeyPrefix:     k.KeyPrefix,
			Name:          k.Name,
			UserID:        k.UserUserID,
			GatewayUserID: k.UserID,
			UserPhone:     k.UserPhone,
			UserNickname:  k.UserNickname,
			Status:        status,
			IsActive:      k.IsActive,
			CreatedAt:     k.CreatedAt.Format("2006-01-02T15:04:05Z"),
		})
	}

	response.SuccessResponse(c, gin.H{
		"items":        items,
		"total":        total,
		"active_count": activeCount,
		"page":         page,
		"page_size":    pageSize,
	})
}

// RevokeApiKey handles DELETE /api/admin/api-keys/:id
// @Summary Revoke API key
// @Description Revoke (deactivate) an API key by its ID. The key will no longer be usable for authentication.
// @Tags Admin - API Keys
// @Produce json
// @Param id path string true "API Key ID (UUID)"
// @Success 200 {object} SwaggerMessageResponse "API key revoked successfully"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - invalid key ID or revocation failed"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/api-keys/{id} [delete]
func (h *AdminHandler) RevokeApiKey(c *gin.Context) {
	keyID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "Invalid API key ID")
		return
	}

	if err := h.keySvc.Revoke(keyID, ""); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, gin.H{"message": "API key revoked"})
}
