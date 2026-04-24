package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/config"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"git.woa.com/wisp/mono/ai-gateway/internal/router"
	"git.woa.com/wisp/mono/ai-gateway/internal/serverstate"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"

	"github.com/DATA-DOG/go-sqlmock"
)

func setupTestRouter(t *testing.T) *http.Handler {
	t.Helper()

	// Mock DB
	sqlDB, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	db, err := gorm.Open(mysql.New(mysql.Config{
		Conn:                      sqlDB,
		SkipInitializeWithVersion: true,
	}), &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open gorm: %v", err)
	}

	// Mock Redis
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	redisClient := redisclient.NewClientFromRedis(rdb)

	cfg := &config.Config{
		Server: config.ServerConfig{
			Port:               8080,
			AdminToken:         "test-admin-token",
			AdminIPWhitelist:   []string{},
			MaxRequestBodySize: 10 * 1024 * 1024,
		},
		Database: config.DatabaseConfig{DSN: "mock"},
		Redis:    config.RedisConfig{Addr: mr.Addr()},
		Portkey:  config.PortkeyConfig{BaseURL: "http://localhost:8787"},
		Billing: config.BillingConfig{
			DefaultReservationTokens: 4096,
		},
		EncryptionKey: "01234567890123456789012345678901",
		CircuitBreaker: config.CircuitBreakerConfig{
			FailureThreshold:  5,
			CooldownDurationS: 30,
		},
	}

	tracker := serverstate.NewConnTracker()
	drainState := serverstate.DefaultDrainState()
	result := router.Setup(cfg, db, redisClient, tracker, drainState)
	var h http.Handler = result.Engine
	return &h
}

func TestRouter_HealthEndpoint(t *testing.T) {
	h := setupTestRouter(t)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/health", nil)
	(*h).ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("GET /health expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestRouter_UnauthenticatedV1Returns401(t *testing.T) {
	h := setupTestRouter(t)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/models", nil)
	(*h).ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("GET /v1/models without auth expected 401, got %d", w.Code)
	}
}

func TestRouter_AdminWithoutTokenReturns200(t *testing.T) {
	h := setupTestRouter(t)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/admin/users", nil)
	(*h).ServeHTTP(w, req)

	// Admin API 有 AdminAuth 中间件，无 token 返回 401
	if w.Code == http.StatusUnauthorized {
		return
	}
	t.Errorf("GET /api/admin/users expected 401, got %d", w.Code)
}

func TestRouter_AdminWithWrongTokenReturns200(t *testing.T) {
	h := setupTestRouter(t)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/admin/users", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	(*h).ServeHTTP(w, req)

	// Admin API 有 AdminAuth 中间件，错误 token 返回 401
	if w.Code == http.StatusUnauthorized {
		return
	}
	t.Errorf("GET /api/admin/users with wrong token expected 401, got %d", w.Code)
}

func TestRouter_NotFoundReturns404(t *testing.T) {
	h := setupTestRouter(t)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/nonexistent", nil)
	(*h).ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("GET /nonexistent expected 404, got %d", w.Code)
	}
}
