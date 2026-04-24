package gateway

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

func setupModelAuthRouter(plan *model.Plan) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()

	// Inject plan into context before ModelAuth
	r.Use(func(c *gin.Context) {
		if plan != nil {
			c.Set(middleware.ContextKeyPlan, plan)
		}
		c.Next()
	})
	r.Use(middleware.ModelAuth())
	r.POST("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	return r
}

func mustJSON(v interface{}) datatypes.JSON {
	b, _ := json.Marshal(v)
	return datatypes.JSON(b)
}

func TestModelAuth_AllowedModel(t *testing.T) {
	plan := &model.Plan{
		ID:            uuid.New(),
		AllowedModels: mustJSON([]string{"gpt-4", "gpt-3.5-turbo"}),
	}
	r := setupModelAuthRouter(plan)

	body := `{"model": "gpt-4", "messages": []}`
	req := httptest.NewRequest(http.MethodPost, "/test", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestModelAuth_ModelNotAllowed(t *testing.T) {
	plan := &model.Plan{
		ID:            uuid.New(),
		AllowedModels: mustJSON([]string{"gpt-3.5-turbo"}),
	}
	r := setupModelAuthRouter(plan)

	body := `{"model": "gpt-4", "messages": []}`
	req := httptest.NewRequest(http.MethodPost, "/test", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestModelAuth_EmptyBody(t *testing.T) {
	plan := &model.Plan{
		ID:            uuid.New(),
		AllowedModels: mustJSON([]string{"gpt-4"}),
	}
	r := setupModelAuthRouter(plan)

	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestModelAuth_EmptyAllowedModels(t *testing.T) {
	plan := &model.Plan{
		ID:            uuid.New(),
		AllowedModels: mustJSON([]string{}),
	}
	r := setupModelAuthRouter(plan)

	body := `{"model": "anything-goes", "messages": []}`
	req := httptest.NewRequest(http.MethodPost, "/test", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (allow all), got %d", w.Code)
	}
}

func TestModelAuth_MissingModelField(t *testing.T) {
	plan := &model.Plan{
		ID:            uuid.New(),
		AllowedModels: mustJSON([]string{"gpt-4"}),
	}
	r := setupModelAuthRouter(plan)

	body := `{"messages": []}`
	req := httptest.NewRequest(http.MethodPost, "/test", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestModelAuth_NoPlanInContext(t *testing.T) {
	r := setupModelAuthRouter(nil)

	body := `{"model": "gpt-4"}`
	req := httptest.NewRequest(http.MethodPost, "/test", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}
