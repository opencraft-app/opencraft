package httpapi

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// uuidPattern 匹配标准 UUID 格式（含无连字符的紧凑形式）。
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

const (
	maxSubjectLen = 200
	maxBodyLen    = 10000 // MEDIUMTEXT 上限远高于此，业务层截断
)

// validateUUID 检查路径参数是否符合 UUID 格式；不符合则立即返回 400。
func validateUUID(c *gin.Context, param string) bool {
	id := c.Param(param)
	if id == "" || !uuidPattern.MatchString(id) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_id"})
		return false
	}
	return true
}

// requireNonEmpty 检查字符串字段非空且去除首尾空白后仍有效；
// 为空则写 400 并返回 false。
func requireNonEmpty(c *gin.Context, value, field string) bool {
	if strings.TrimSpace(value) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing_" + field})
		return false
	}
	return true
}

// requireMaxLength 检查字符串字段不超过上限。
func requireMaxLength(c *gin.Context, value string, max int, field string) bool {
	if len(value) > max {
		c.JSON(http.StatusBadRequest, gin.H{"error": field + "_too_long"})
		return false
	}
	return true
}

// bindAndValidateJSON 绑定请求体并执行基础校验（非空 + 长度），
// 将单次解析失败隔离在当前请求内，不影响其他接口或后续处理流程。
func bindAndValidateJSON(c *gin.Context, req interface{}) bool {
	if err := c.ShouldBindJSON(req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_body"})
		return false
	}
	return true
}
