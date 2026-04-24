package gateway

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type mockValidator struct {
	apiKey *model.ApiKey
	user   *model.User
	sub    *model.Subscription
	plan   *model.Plan
	err    error
}

func (m *mockValidator) Validate(plainKey string) (*model.ApiKey, *model.User, *model.Subscription, *model.Plan, error) {
	return m.apiKey, m.user, m.sub, m.plan, m.err
}

func setupAuthRouter(validator middleware.ApiKeyValidator) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(middleware.Auth(validator))
	r.GET("/test", func(c *gin.Context) {
		user := middleware.GetUserFromContext(c)
		if user != nil {
			c.JSON(http.StatusOK, gin.H{"user_id": user.ID.String()})
		} else {
			c.JSON(http.StatusOK, gin.H{"user_id": ""})
		}
	})
	return r
}

func TestAuth_ValidKey(t *testing.T) {
	userID := uuid.New()
	v := &mockValidator{
		apiKey: &model.ApiKey{ID: uuid.New(), UserID: userID},
		user:   &model.User{ID: userID, Status: "active"},
		sub:    &model.Subscription{ID: uuid.New(), UserID: userID},
		plan:   &model.Plan{ID: uuid.New(), Name: "pro"},
	}

	r := setupAuthRouter(v)
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer sk-validkey123")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestAuth_BearerSchemeIsCaseInsensitive(t *testing.T) {
	userID := uuid.New()
	v := &mockValidator{
		apiKey: &model.ApiKey{ID: uuid.New(), UserID: userID},
		user:   &model.User{ID: userID, Status: "active"},
		sub:    &model.Subscription{ID: uuid.New(), UserID: userID},
		plan:   &model.Plan{ID: uuid.New(), Name: "pro"},
	}

	r := setupAuthRouter(v)
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "bearer sk-validkey123")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestAuth_MissingHeader(t *testing.T) {
	v := &mockValidator{}
	r := setupAuthRouter(v)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestAuth_NoBearerPrefix(t *testing.T) {
	v := &mockValidator{}
	r := setupAuthRouter(v)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Basic sometoken")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestAuth_InvalidKey(t *testing.T) {
	v := &mockValidator{err: errors.New("invalid key")}
	r := setupAuthRouter(v)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer sk-invalid")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}
