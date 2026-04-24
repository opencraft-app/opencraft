package handler

import (
	"strconv"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type createUserRequest struct {
	Phone    string `json:"phone" binding:"required"`
	UserID   string `json:"user_id" binding:"required"`
	Nickname string `json:"nickname"`
}

type updateUserRequest struct {
	Phone    string `json:"phone"`
	UserID   string `json:"user_id"`
	Nickname string `json:"nickname"`
	Status   string `json:"status"`
}

// CreateUser handles POST /api/admin/users
// @Summary Create user
// @Description Create a new user with phone, user_id and optional nickname
// @Tags Admin - Users
// @Accept json
// @Produce json
// @Param request body createUserRequest true "Create user request"
// @Success 200 {object} SwaggerUser "Created user"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing required fields or duplicate user"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/users [post]
func (h *AdminHandler) CreateUser(c *gin.Context) {
	var req createUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Missing required fields: phone, user_id")
		return
	}

	user := &model.User{
		UserID:   req.UserID,
		Nickname: req.Nickname,
		Status:   model.UserStatusActive,
	}

	if err := h.userSvc.SetPhoneFields(user, req.Phone); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	if err := h.userSvc.Create(user); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, user)
}

// ListUsers handles GET /api/admin/users
// @Summary List users
// @Description List users with pagination. Each user includes current plan name and token balance.
// @Tags Admin - Users
// @Produce json
// @Param page query int false "Page number" default(1)
// @Param page_size query int false "Page size (max 100)" default(20)
// @Param search query string false "Search by phone or nickname"
// @Param status query string false "User status filter: active, suspended, deleted"
// @Success 200 {object} SwaggerUserListResponse "Paginated user list with plan info"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/users [get]
func (h *AdminHandler) ListUsers(c *gin.Context) {
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
	if status != "" && status != model.UserStatusActive && status != model.UserStatusSuspended && status != model.UserStatusDeleted {
		response.ErrBadRequest(c, "Invalid status filter")
		return
	}

	rows, total, err := h.userSvc.ListWithActiveSubscription(offset, pageSize, search, status)
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	type userWithPlan struct {
		model.User
		CurrentPlan    string `json:"current_plan,omitempty"`
		TokenBalance   *int64 `json:"token_balance,omitempty"`
		IsUnlimited    bool   `json:"is_unlimited"`
		SubscriptionID string `json:"subscription_id,omitempty"`
	}
	enriched := make([]userWithPlan, len(rows))
	for i, row := range rows {
		enriched[i] = userWithPlan{User: row.User}
		if row.SubID != uuid.Nil {
			balance := row.SubTokenBalance
			enriched[i].TokenBalance = &balance
			enriched[i].CurrentPlan = row.PlanName
			enriched[i].IsUnlimited = row.PlanMonthlyTokens != nil && *row.PlanMonthlyTokens == 0
			enriched[i].SubscriptionID = row.SubID.String()
		}
	}

	response.SuccessResponse(c, gin.H{
		"items":     enriched,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}

// GetUser handles GET /api/admin/users/:user_id
// @Summary Get user
// @Description Get user details by business user_id, including active subscription and plan information
// @Tags Admin - Users
// @Produce json
// @Param user_id path string true "Business user ID"
// @Success 200 {object} SwaggerUserDetailResponse "User details with subscription and plan"
// @Failure 400 {object} SwaggerErrorResponse "Invalid user ID"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "User not found"
// @Router /api/admin/users/{user_id} [get]
func (h *AdminHandler) GetUser(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	// 返回用户详情，附带活跃订阅和套餐信息
	result := gin.H{
		"id":         user.ID,
		"user_id":    user.UserID,
		"phone":      user.PhoneMasked,
		"nickname":   user.Nickname,
		"status":     user.Status,
		"created_at": user.CreatedAt,
		"updated_at": user.UpdatedAt,
	}

	if sub, err := h.subSvc.GetActiveByUserID(user.ID); err == nil {
		result["subscription"] = sub
		if plan, err := h.planSvc.GetByID(sub.PlanID); err == nil {
			result["plan"] = plan
		}
	}

	response.SuccessResponse(c, result)
}

// UpdateUser handles PUT /api/admin/users/:user_id
// @Summary Update user
// @Description Update an existing user identified by business user_id (partial update, only non-empty fields are updated)
// @Tags Admin - Users
// @Accept json
// @Produce json
// @Param user_id path string true "Business user ID"
// @Param request body updateUserRequest true "Update user request"
// @Success 200 {object} SwaggerUser "Updated user"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - invalid request body"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "User not found"
// @Router /api/admin/users/{user_id} [put]
func (h *AdminHandler) UpdateUser(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	var req updateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Invalid request body")
		return
	}

	if req.Phone != "" {
		if err := h.userSvc.SetPhoneFields(user, req.Phone); err != nil {
			response.ErrBadRequest(c, err.Error())
			return
		}
	}
	if req.UserID != "" {
		user.UserID = req.UserID
	}
	if req.Nickname != "" {
		user.Nickname = req.Nickname
	}
	if req.Status != "" {
		user.Status = req.Status
	}

	if err := h.userSvc.Update(user); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, user)
}

// DeleteUser handles DELETE /api/admin/users/:user_id (soft delete)
// @Summary Delete user
// @Description Soft delete a user by business user_id (sets status to 'deleted')
// @Tags Admin - Users
// @Produce json
// @Param user_id path string true "Business user ID"
// @Success 200 {object} SwaggerMessageResponse "User deleted successfully"
// @Failure 400 {object} SwaggerErrorResponse "Invalid user ID"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "User not found"
// @Router /api/admin/users/{user_id} [delete]
func (h *AdminHandler) DeleteUser(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	if err := h.userSvc.SoftDelete(user.ID); err != nil {
		response.ErrNotFound(c, "User not found")
		return
	}

	response.SuccessResponse(c, gin.H{"message": "User deleted"})
}
