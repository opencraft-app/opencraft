package handler

import (
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// requireUserByParam 统一按业务 user_id 查用户，避免 admin 接口混用内部 UUID。
func (h *AdminHandler) requireUserByParam(c *gin.Context) (*model.User, bool) {
	userID := strings.TrimSpace(c.Param("user_id"))
	if userID == "" {
		response.ErrBadRequest(c, "Invalid user ID")
		return nil, false
	}

	user, err := h.userSvc.GetByUserID(userID)
	if err != nil {
		response.ErrNotFound(c, "User not found")
		return nil, false
	}
	return user, true
}
