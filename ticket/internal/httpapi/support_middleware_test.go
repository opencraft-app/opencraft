package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func newSupportUserMiddlewareTestEngine() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(supportUserMiddleware())
	r.POST("/support/feedback/presign", func(c *gin.Context) {
		uid, _ := c.Get("user_id")
		c.JSON(http.StatusOK, gin.H{"user_id": uid})
	})
	return r
}

func TestSupportUserMiddlewareAcceptsXUserId(t *testing.T) {
	r := newSupportUserMiddlewareTestEngine()

	req := httptest.NewRequest(http.MethodPost, "/support/feedback/presign", nil)
	req.Header.Set("X-User-Id", "usr_gateway")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with X-User-Id, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSupportUserMiddlewareFallsBackToLightclawUserID(t *testing.T) {
	r := newSupportUserMiddlewareTestEngine()

	req := httptest.NewRequest(http.MethodPost, "/support/feedback/presign", nil)
	req.Header.Set("X-Lightclaw-User-ID", "usr_gateway_lc")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 fallback via X-Lightclaw-User-ID, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSupportUserMiddlewareDoesNotRequireXRealm(t *testing.T) {
	// 关键回归：service-gateway.injectIdentityHeaders 只注入 X-User-Id 与
	// X-Lightclaw-User-ID，不注入 X-Realm。若中间件仍强制要求 X-Realm，
	// /support/feedback/presign 会对所有真实登录请求恒判 401。
	r := newSupportUserMiddlewareTestEngine()

	req := httptest.NewRequest(http.MethodPost, "/support/feedback/presign", nil)
	req.Header.Set("X-User-Id", "usr_gateway")
	// 故意不设置 X-Realm。
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code == http.StatusUnauthorized {
		t.Fatalf("support presign must not require X-Realm; got 401 body=%s", rec.Body.String())
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 without X-Realm, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSupportUserMiddlewareRejectsMissingIdentity(t *testing.T) {
	r := newSupportUserMiddlewareTestEngine()

	req := httptest.NewRequest(http.MethodPost, "/support/feedback/presign", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 when no identity headers present, got %d body=%s", rec.Code, rec.Body.String())
	}
}
