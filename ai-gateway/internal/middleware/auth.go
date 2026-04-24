package middleware

import (
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// ApiKeyValidator is the interface for API key validation.
// *service.ApiKeyService implements this interface.
type ApiKeyValidator interface {
	Validate(plainKey string) (*model.ApiKey, *model.User, *model.Subscription, *model.Plan, error)
}

type ApiKeyValidatorAllowMissingSubscription interface {
	ValidateAllowMissingSubscription(plainKey string) (*model.ApiKey, *model.User, *model.Subscription, *model.Plan, error)
}

// Auth validates the API key and injects user/subscription/plan into context.
// 支持三种认证方式：
//  1. Authorization: Bearer <key>  (OpenAI 格式)
//  2. x-api-key: <key>             (Anthropic 格式)
//  3. ?key=<key>                   (Gemini 格式)
func Auth(validator ApiKeyValidator) gin.HandlerFunc {
	return func(c *gin.Context) {
		plainKey := extractPlainKey(c)

		if plainKey == "" {
			response.ErrInvalidAPIKey(c)
			return
		}

		apiKey, user, sub, plan, err := validator.Validate(plainKey)
		if err != nil {
			response.ErrInvalidAPIKey(c)
			return
		}

		_ = apiKey // could use for last_used_at update
		SetUserContext(c, user, sub, plan)
		c.Next()
	}
}

// AuthAllowMissingSubscription authenticates the API key and injects user
// context even when no active subscription exists.
func AuthAllowMissingSubscription(validator ApiKeyValidatorAllowMissingSubscription) gin.HandlerFunc {
	return func(c *gin.Context) {
		plainKey := extractPlainKey(c)
		if plainKey == "" {
			response.ErrInvalidAPIKey(c)
			return
		}

		apiKey, user, sub, plan, err := validator.ValidateAllowMissingSubscription(plainKey)
		if err != nil {
			response.ErrInvalidAPIKey(c)
			return
		}

		_ = apiKey
		SetUserContext(c, user, sub, plan)
		c.Next()
	}
}

func extractPlainKey(c *gin.Context) string {
	var plainKey string

	// 1. 标准 Bearer token (OpenAI)
	if authHeader := strings.TrimSpace(c.GetHeader("Authorization")); authHeader != "" {
		parts := strings.Fields(authHeader)
		if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
			plainKey = parts[1]
		}
	}

	// 2. x-api-key header (Anthropic / Claude Code)
	if plainKey == "" {
		plainKey = c.GetHeader("x-api-key")
	}

	// 3. ?key= query parameter (Gemini CLI)
	if plainKey == "" {
		plainKey = c.Query("key")
	}

	return plainKey
}
