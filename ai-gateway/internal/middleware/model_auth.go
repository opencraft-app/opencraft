package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// ModelAuth checks that the requested model is in the plan's allowed_models list.
// Body is buffered and restored for downstream handlers. Missing model is allowed
// and will be resolved later by proxyRequest using runtime config defaults.
func ModelAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		plan := GetPlanFromContext(c)
		if plan == nil {
			response.ErrInternal(c)
			return
		}

		// Read and buffer body
		body, err := io.ReadAll(c.Request.Body)
		if err != nil || len(body) == 0 {
			response.ErrBadRequest(c, "Request body is required")
			return
		}
		// Restore body for downstream
		c.Request.Body = io.NopCloser(bytes.NewReader(body))

		// Extract model field
		var req struct {
			Model string `json:"model"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			response.ErrBadRequest(c, "Missing or invalid 'model' field")
			return
		}

		// Store model name and body in context for downstream use
		c.Set("request_model", req.Model)
		c.Set("request_body", body)

		if strings.TrimSpace(req.Model) == "" {
			c.Next()
			return
		}

		// Check against allowed models (case-insensitive match)
		requestedModel := strings.ToLower(req.Model)
		var allowedModels []string
		if err := json.Unmarshal(plan.AllowedModels, &allowedModels); err != nil {
			// If allowed_models is empty/invalid, allow all
			c.Next()
			return
		}

		if len(allowedModels) == 0 {
			// Empty list = allow all
			c.Next()
			return
		}

		for _, m := range allowedModels {
			if strings.ToLower(m) == requestedModel {
				c.Next()
				return
			}
		}

		response.ErrModelNotAllowed(c)
	}
}
