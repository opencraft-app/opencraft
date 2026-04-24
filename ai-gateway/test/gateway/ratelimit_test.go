package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"gorm.io/datatypes"
)

func setupRateLimitTest(t *testing.T) (*gin.Engine, *miniredis.Miniredis) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	rc := redisclient.NewClientFromRedis(rdb)

	user := &model.User{ID: uuid.New(), PhoneMasked: "138****8000", PhoneHash: "testhash", Status: "active"}
	plan := &model.Plan{RateLimits: datatypes.JSON([]byte(`[{"window":"1m","max_requests":2,"label":"每分钟"}]`))}

	r := gin.New()
	// Simulate auth middleware setting context
	r.Use(func(c *gin.Context) {
		middleware.SetUserContext(c, user, &model.Subscription{}, plan)
		c.Next()
	})
	r.Use(middleware.RateLimiter(rc))
	r.POST("/v1/chat/completions", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	return r, mr
}

func TestRateLimiter_AllowsWithinLimit(t *testing.T) {
	r, _ := setupRateLimitTest(t)

	// First 2 requests should pass (RPM limit = 2)
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("request %d: expected 200, got %d", i+1, w.Code)
		}
	}
}

func TestRateLimiter_BlocksOverLimit(t *testing.T) {
	r, _ := setupRateLimitTest(t)

	// Exhaust RPM limit
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
		r.ServeHTTP(w, req)
	}

	// Third request should be rate limited
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", w.Code)
	}
}

func TestRateLimiter_HasRetryAfterHeader(t *testing.T) {
	r, _ := setupRateLimitTest(t)

	// Exhaust RPM limit
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
		r.ServeHTTP(w, req)
	}

	// Check 429 response has Retry-After header
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	r.ServeHTTP(w, req)
	retryAfter := w.Header().Get("Retry-After")
	// 剩余时间可能不是精确的60秒（取决于测试执行时机），检查是否为正数即可
	if retryAfter == "" || retryAfter == "0" {
		t.Errorf("expected non-zero Retry-After, got %q", retryAfter)
	}
}

func TestRateLimiter_ResetsAfterTTL(t *testing.T) {
	r, mr := setupRateLimitTest(t)

	// Exhaust RPM limit
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
		r.ServeHTTP(w, req)
	}

	// Fast-forward time in miniredis
	mr.FastForward(61 * time.Second)

	// After TTL reset, request should pass again
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 after TTL reset, got %d", w.Code)
	}
}

func TestRateLimiter_AllowsWhenRedisClientIsNil(t *testing.T) {
	gin.SetMode(gin.TestMode)

	user := &model.User{ID: uuid.New(), PhoneMasked: "138****8000", PhoneHash: "testhash", Status: "active"}
	plan := &model.Plan{RateLimits: datatypes.JSON([]byte(`[{"window":"1m","max_requests":1,"label":"每分钟"}]`))}

	r := gin.New()
	r.Use(func(c *gin.Context) {
		middleware.SetUserContext(c, user, &model.Subscription{}, plan)
		c.Next()
	})
	r.Use(middleware.RateLimiter(nil))
	r.POST("/v1/chat/completions", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d", i+1, w.Code)
		}
	}
}
