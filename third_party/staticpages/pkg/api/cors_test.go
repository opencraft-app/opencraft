package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestCORSPreflightAllowsConfiguredWildcardOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	api := NewRestApi(config.StaticPagesConfig{
		CORS: config.CORS{
			AllowedOrigins: []string{"*"},
		},
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodOptions, "/api/upload", nil)
	request.Header.Set("Origin", "https://preview.sandbox.lightclaw.tech")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	request.Header.Set("Access-Control-Request-Headers", "authorization,content-type,x-staticpages-repository")

	api.router.ServeHTTP(recorder, request)

	assert.Equal(t, http.StatusNoContent, recorder.Code)
	assert.Equal(t, "*", recorder.Header().Get("Access-Control-Allow-Origin"))
	assert.Contains(t, recorder.Header().Get("Access-Control-Allow-Methods"), "POST")
	assert.Contains(t, recorder.Header().Get("Access-Control-Allow-Headers"), "Authorization")
	assert.Contains(t, recorder.Header().Get("Access-Control-Allow-Headers"), staticPagesRepositoryHeader)
}

func TestCORSHeadersAreNotSetWhenDisabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	api := NewRestApi(config.StaticPagesConfig{})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodOptions, "/api/upload", nil)
	request.Header.Set("Origin", "https://preview.sandbox.lightclaw.tech")

	api.router.ServeHTTP(recorder, request)

	assert.Equal(t, http.StatusNoContent, recorder.Code)
	assert.Empty(t, recorder.Header().Get("Access-Control-Allow-Origin"))
}

func TestCORSHeadersAreAppliedToUploadResponses(t *testing.T) {
	gin.SetMode(gin.TestMode)
	api := NewRestApi(config.StaticPagesConfig{
		CORS: config.CORS{
			AllowedOrigins: []string{"*"},
		},
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/upload", nil)
	request.Header.Set("Origin", "https://preview.sandbox.lightclaw.tech")

	api.router.ServeHTTP(recorder, request)

	assert.Equal(t, http.StatusForbidden, recorder.Code)
	assert.Equal(t, "*", recorder.Header().Get("Access-Control-Allow-Origin"))
}
