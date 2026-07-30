package client

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

func (c *Client) EnsureUser(ctx context.Context, input EnsureUserInput) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodPost, "/api/internal/users/ensure", input)
}

func (c *Client) GetAssignment(ctx context.Context, userID string) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodGet, userPath(userID, "/assignment"), nil)
}

func (c *Client) SetAssignment(ctx context.Context, userID string, input AssignmentInput) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodPost, userPath(userID, "/assignment"), input)
}

func (c *Client) ApplySubscription(ctx context.Context, input ApplySubscriptionInput) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodPost, "/api/internal/subscriptions/apply", input)
}

func (c *Client) CancelSubscription(ctx context.Context, userID string) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodPost, "/api/internal/subscriptions/cancel", CancelSubscriptionInput{UserID: userID})
}

func (c *Client) GetSubscription(ctx context.Context, userID string) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodGet, userPath(userID, "/subscriptions"), nil)
}

func (c *Client) GetCredit(ctx context.Context, userID string) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodGet, userPath(userID, "/credit"), nil)
}

func (c *Client) GetBYOK(ctx context.Context, userID string) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodGet, userPath(userID, "/llm-settings"), nil)
}

func (c *Client) SetBYOK(ctx context.Context, userID string, input BYOKSettingsInput) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodPut, userPath(userID, "/llm-settings"), input)
}

func (c *Client) SyncBYOK(ctx context.Context, userID string) (Result, error) {
	return c.doJSON(ctx, AuthInternal, http.MethodPost, userPath(userID, "/llm-settings/sync"), nil)
}

func (c *Client) ShowTenant(ctx context.Context, userID string) (Result, error) {
	path := "/api/admin/users/" + url.PathEscape(strings.TrimSpace(userID)) + "/state"
	return c.doJSON(ctx, AuthAdmin, http.MethodGet, path, nil)
}

func (c *Client) CreateAPIKey(ctx context.Context, userID string, name string) (Result, error) {
	path := "/api/admin/users/" + url.PathEscape(strings.TrimSpace(userID)) + "/api-keys"
	return c.doJSON(ctx, AuthAdmin, http.MethodPost, path, map[string]string{"name": name})
}

func (c *Client) Models(ctx context.Context) (Result, error) {
	return c.doJSON(ctx, AuthTraffic, http.MethodGet, "/v1/models", nil)
}

func (c *Client) Chat(ctx context.Context, input ChatInput) (Result, error) {
	messages := make([]map[string]string, 0, 2)
	if strings.TrimSpace(input.System) != "" {
		messages = append(messages, map[string]string{"role": "system", "content": input.System})
	}
	messages = append(messages, map[string]string{"role": "user", "content": input.Prompt})
	payload := map[string]any{"model": input.Model, "messages": messages, "stream": input.Stream}
	return c.doJSON(ctx, AuthTraffic, http.MethodPost, "/v1/chat/completions", payload)
}

func userPath(userID string, suffix string) string {
	return "/api/internal/users/" + url.PathEscape(strings.TrimSpace(userID)) + suffix
}
