package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const sessionCookieName = "lc_session"

type authSessionEnvelope struct {
	Session struct {
		User struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"user"`
	} `json:"session"`
}

func userSessionAuth(authServiceURL string, internalServiceToken string) gin.HandlerFunc {
	authServiceURL = strings.TrimRight(strings.TrimSpace(authServiceURL), "/")
	internalServiceToken = strings.TrimSpace(internalServiceToken)
	client := &http.Client{Timeout: 5 * time.Second}

	return func(c *gin.Context) {
		if c.Request.Method == http.MethodOptions {
			c.Next()
			return
		}
		if authServiceURL == "" {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "auth service unavailable"})
			return
		}
		if internalServiceToken != "" && internalServiceIdentity(c.Request, internalServiceToken) {
			userID := strings.TrimSpace(c.Request.Header.Get("X-User-Id"))
			if userID == "" {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
				return
			}
			c.Set("lightclaw_user_id", userID)
			c.Next()
			return
		}

		authHeader, cookieHeader := extractSessionAuth(c.Request)
		if authHeader == "" && cookieHeader == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}

		session, err := introspectSession(c.Request.Context(), client, authServiceURL, authHeader, cookieHeader)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}

		c.Set("lightclaw_user_id", session.Session.User.ID)
		c.Set("lightclaw_user_email", session.Session.User.Email)
		c.Next()
	}
}

func internalServiceIdentity(r *http.Request, expected string) bool {
	if r == nil || expected == "" {
		return false
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return false
	}
	token := strings.TrimSpace(auth[len("Bearer "):])
	return len(token) == len(expected) && subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1
}

func extractSessionAuth(r *http.Request) (string, string) {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		return authHeader, ""
	}

	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		return "", (&http.Cookie{Name: sessionCookieName, Value: cookie.Value}).String()
	}
	return "", ""
}

func introspectSession(ctx context.Context, client *http.Client, authServiceURL, authHeader, cookieHeader string) (*authSessionEnvelope, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, authServiceURL+"/auth/session", nil)
	if err != nil {
		return nil, fmt.Errorf("create auth introspection request: %w", err)
	}
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	if cookieHeader != "" {
		req.Header.Set("Cookie", cookieHeader)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call auth introspection: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("auth introspection status %d", resp.StatusCode)
	}

	var session authSessionEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&session); err != nil {
		return nil, fmt.Errorf("decode auth introspection: %w", err)
	}
	if strings.TrimSpace(session.Session.User.ID) == "" {
		return nil, errors.New("missing user id in auth introspection")
	}

	return &session, nil
}
