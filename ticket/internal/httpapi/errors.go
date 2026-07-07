package httpapi

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/ticket/internal/service"
)

// writeErr 将 service 层的领域错误映射为标准 HTTP 状态码。
//
// 该 helper 位于 httpapi 包内，可被 user.go / admin.go 等同包文件直接调用。
// 若未来跨包复用，可考虑迁移到 pkg/apierr。
func writeErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrInvalidInput):
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_input"})
	case errors.Is(err, service.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
	case errors.Is(err, service.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "not_found"})
	default:
		// 保留原始错误在服务端日志（此处不暴露给客户端，避免信息泄露）。
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal"})
	}
}
