package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func setupAdminRouter(adminToken string, ipWhitelist []string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(AdminAuth(adminToken, ipWhitelist))
	r.GET("/admin", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	return r
}

func TestAdminAuth_ValidToken(t *testing.T) {
	r := setupAdminRouter("super-secret", nil)

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.Header.Set("Authorization", "Bearer super-secret")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestAdminAuth_InvalidToken(t *testing.T) {
	r := setupAdminRouter("super-secret", nil)

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestAdminAuth_MissingHeader(t *testing.T) {
	r := setupAdminRouter("super-secret", nil)

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestAdminAuth_IPWhitelist_Allowed(t *testing.T) {
	r := setupAdminRouter("secret", []string{"192.168.1.0/24"})

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("X-Forwarded-For", "192.168.1.100")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestAdminAuth_IPWhitelist_Denied(t *testing.T) {
	r := setupAdminRouter("secret", []string{"10.0.0.0/8"})

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("X-Forwarded-For", "192.168.1.100")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestAdminAuth_IPWhitelist_ExactIP(t *testing.T) {
	r := setupAdminRouter("secret", []string{"127.0.0.1"})

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.Header.Set("Authorization", "Bearer secret")
	// httptest default RemoteAddr is typically 192.0.2.1:1234, but X-Forwarded-For overrides
	req.Header.Set("X-Forwarded-For", "127.0.0.1")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}
