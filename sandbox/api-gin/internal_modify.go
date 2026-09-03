package main

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/service"
)

// 同 SP 升配的 ctl 侧入口。POST 只冻结目标规格并落账本就返回 202：停机、改规格、
// 扩盘、开机加起来可达十几分钟，远超任何合理的 HTTP 超时，所以云侧步骤交给 worker
// 单向续跑，ctl 子 task 轮询 GET 拿终态。
const (
	internalModifyRoutePath          = "/sandboxes/:sandboxID/modify"
	internalModifyOperationRoutePath = "/sandbox-modify-operations/:operationID"
)

// 请求只接收目标归属。源 Pool、源 SKU、实例 ID 都由 sandbox_id 自行派生，
// 不信任调用方传入的 source spec。
type internalModifyRequest struct {
	// IdempotencyKey 由 ctl 单实例 child task ID 提供：同一 child task 的多次重投
	// 复用同一份账本，不会重复执行磁盘扩容这类不可逆步骤。
	IdempotencyKey string `json:"idempotency_key"`
	TargetPoolID   string `json:"target_pool_id"`
	TargetSKUID    string `json:"target_sku_id"`
}

type internalModifyOperationResponse struct {
	OperationID          string `json:"operation_id"`
	SandboxID            string `json:"sandbox_id"`
	InstanceID           string `json:"instance_id"`
	SourcePoolID         string `json:"source_pool_id"`
	TargetPoolID         string `json:"target_pool_id"`
	TargetInstanceType   string `json:"target_instance_type"`
	TargetSystemDiskSize int    `json:"target_system_disk_size"`
	Status               string `json:"status"`
	CurrentStep          string `json:"current_step,omitempty"`
	LastError            string `json:"last_error,omitempty"`
}

func registerInternalModifyRoutes(r gin.IRouter, h *handler) {
	r.POST(internalModifyRoutePath, h.postInternalModify)
	r.GET(internalModifyOperationRoutePath, h.getInternalModifyOperation)
}

func toInternalModifyOperationResponse(op core.ModifyOperation) internalModifyOperationResponse {
	return internalModifyOperationResponse{
		OperationID:          op.ID,
		SandboxID:            op.SandboxID,
		InstanceID:           op.InstanceID,
		SourcePoolID:         op.SourcePoolID,
		TargetPoolID:         op.TargetPoolID,
		TargetInstanceType:   op.TargetInstanceType,
		TargetSystemDiskSize: op.TargetSystemDiskSize,
		Status:               string(op.Status),
		CurrentStep:          op.CurrentStep,
		LastError:            op.LastError,
	}
}

func (h *handler) postInternalModify(c *gin.Context) {
	var body internalModifyRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body: " + err.Error()})
		return
	}
	if strings.TrimSpace(body.IdempotencyKey) == "" || strings.TrimSpace(body.TargetPoolID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "idempotency_key and target_pool_id are required"})
		return
	}

	op, err := h.svc.BeginModifyOperation(c.Request.Context(), service.BeginModifyInput{
		IdempotencyKey: body.IdempotencyKey,
		SandboxID:      strings.TrimSpace(c.Param("sandboxID")),
		TargetPoolID:   body.TargetPoolID,
		TargetSKUID:    body.TargetSKUID,
	})
	if err != nil {
		writeModifyError(c, err)
		return
	}
	c.JSON(http.StatusAccepted, toInternalModifyOperationResponse(op))
}

func (h *handler) getInternalModifyOperation(c *gin.Context) {
	op, err := h.svc.GetModifyOperation(c.Request.Context(), c.Param("operationID"))
	if err != nil {
		writeModifyError(c, err)
		return
	}
	c.JSON(http.StatusOK, toInternalModifyOperationResponse(op))
}

func writeModifyError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, core.ErrSandboxNotFound),
		errors.Is(err, core.ErrInstanceNotFound),
		errors.Is(err, core.ErrPoolNotFound),
		errors.Is(err, core.ErrModifyOperationNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
	case errors.Is(err, core.ErrModifyOperationConflict):
		c.JSON(http.StatusConflict, gin.H{"code": "MODIFY_OPERATION_CONFLICT", "error": err.Error()})
	case errors.Is(err, core.ErrInvalidTransition):
		c.JSON(http.StatusConflict, gin.H{"error": "instance is not in a modifiable state"})
	case errors.Is(err, core.ErrModifyTargetAlreadyApplied):
		// 独立 code：调用方据此按"已收敛"收尾，而不是把它当成需要重试的错误。
		c.JSON(http.StatusConflict, gin.H{"code": "MODIFY_TARGET_ALREADY_APPLIED", "error": err.Error()})
	case errors.Is(err, core.ErrModifyTargetNotUpgrade):
		c.JSON(http.StatusUnprocessableEntity, gin.H{"code": "MODIFY_TARGET_NOT_UPGRADE", "error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}
