package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestUserSessionAuthAcceptsNarrowInternalServiceIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(userSessionAuth("http://auth.invalid", "internal-token"))
	router.POST("/sandboxes/:sandboxID/tat/session", func(c *gin.Context) {
		userID, _ := c.Get("lightclaw_user_id")
		c.JSON(http.StatusOK, gin.H{"user_id": userID})
	})

	unauthorized := httptest.NewRequest(http.MethodPost, "/sandboxes/sbx-1/tat/session", nil)
	unauthorized.Header.Set("Authorization", "Bearer wrong-token")
	unauthorized.Header.Set("X-User-Id", "user-1")
	unauthorizedRecorder := httptest.NewRecorder()
	router.ServeHTTP(unauthorizedRecorder, unauthorized)
	if unauthorizedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token status = %d", unauthorizedRecorder.Code)
	}

	missingUserID := httptest.NewRequest(http.MethodPost, "/sandboxes/sbx-1/tat/session", nil)
	missingUserID.Header.Set("Authorization", "Bearer internal-token")
	missingUserIDRecorder := httptest.NewRecorder()
	router.ServeHTTP(missingUserIDRecorder, missingUserID)
	if missingUserIDRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing user id status = %d", missingUserIDRecorder.Code)
	}

	authorized := httptest.NewRequest(http.MethodPost, "/sandboxes/sbx-1/tat/session", nil)
	authorized.Header.Set("Authorization", "Bearer internal-token")
	authorized.Header.Set("X-User-Id", "user-1")
	authorizedRecorder := httptest.NewRecorder()
	router.ServeHTTP(authorizedRecorder, authorized)
	if authorizedRecorder.Code != http.StatusOK || authorizedRecorder.Body.String() != `{"user_id":"user-1"}` {
		t.Fatalf("internal auth response = %d %s", authorizedRecorder.Code, authorizedRecorder.Body.String())
	}
}
