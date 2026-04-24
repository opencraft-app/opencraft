package handler

import (
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// RegistryHandler 处理服务注册中心 API。
type RegistryHandler struct {
	registrySvc *service.RegistryService
}

// NewRegistryHandler 创建 RegistryHandler。
func NewRegistryHandler(registrySvc *service.RegistryService) *RegistryHandler {
	return &RegistryHandler{registrySvc: registrySvc}
}

// Register 处理 POST /api/registry/register
// @Summary 注册 AI 服务实例
// @Description 新的 AI 服务实例自注册到网关，自动创建 provider 和模型映射。按 base_url 去重，已存在则更新。
// @Tags Registry
// @Accept json
// @Produce json
// @Param request body SwaggerRegisterRequest true "Register request"
// @Security RegistryAuth
// @Success 200 {object} SwaggerRegisterResponse "Registration result with provider_id and heartbeat interval"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing required fields"
// @Router /api/registry/register [post]
func (h *RegistryHandler) Register(c *gin.Context) {
	var req service.RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "缺少必填字段: name, provider_type, base_url, api_key")
		return
	}

	result, err := h.registrySvc.Register(&req)
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, result)
}

type heartbeatRequest struct {
	ProviderID uuid.UUID `json:"provider_id" binding:"required"`
}

// Heartbeat 处理 POST /api/registry/heartbeat
// @Summary 发送心跳
// @Description AI 服务实例定期发送心跳，保持 active 状态。如果 provider 处于 unhealthy 状态，心跳会将其恢复为 active。
// @Tags Registry
// @Accept json
// @Produce json
// @Param request body heartbeatRequest true "Heartbeat request"
// @Security RegistryAuth
// @Success 200 {object} SwaggerRegistryStatusResponse "Heartbeat received successfully"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing provider_id or provider not found"
// @Router /api/registry/heartbeat [post]
func (h *RegistryHandler) Heartbeat(c *gin.Context) {
	var req heartbeatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "缺少 provider_id")
		return
	}

	if err := h.registrySvc.Heartbeat(req.ProviderID); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, gin.H{"status": "ok"})
}

type deregisterRequest struct {
	ProviderID uuid.UUID `json:"provider_id" binding:"required"`
}

// Deregister 处理 DELETE /api/registry/deregister
// @Summary 注销 AI 服务实例
// @Description AI 服务实例注销，删除 provider 和所有关联的模型映射
// @Tags Registry
// @Accept json
// @Produce json
// @Param request body deregisterRequest true "Deregister request"
// @Security RegistryAuth
// @Success 200 {object} SwaggerMessageResponse "Service deregistered successfully"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing provider_id or provider not found"
// @Router /api/registry/deregister [delete]
func (h *RegistryHandler) Deregister(c *gin.Context) {
	var req deregisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "缺少 provider_id")
		return
	}

	if err := h.registrySvc.Deregister(req.ProviderID); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, gin.H{"message": "服务已注销"})
}
