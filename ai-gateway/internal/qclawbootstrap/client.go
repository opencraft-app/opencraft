package qclawbootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	baseURL    string
	adminToken string
	httpClient *http.Client
}

type providerRecord struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type providerListResponse struct {
	Items []providerRecord `json:"items"`
}

type mappingRecord struct {
	ID           string `json:"id"`
	ModelPattern string `json:"model_pattern"`
	ProviderID   string `json:"provider_id"`
}

type mappingListResponse struct {
	Items []mappingRecord `json:"items"`
}

func NewClient(baseURL, adminToken string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		adminToken: adminToken,
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *Client) UpsertProvider(ctx context.Context, payload providerPayload) (string, error) {
	var providers providerListResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/admin/providers?page=1&page_size=100", nil, &providers); err != nil {
		return "", err
	}

	for _, provider := range providers.Items {
		if provider.Name != payload.Name {
			continue
		}
		if err := c.doJSON(ctx, http.MethodPut, "/api/admin/providers/"+provider.ID, payload, nil); err != nil {
			return "", err
		}
		return provider.ID, nil
	}

	var created providerRecord
	if err := c.doJSON(ctx, http.MethodPost, "/api/admin/providers", payload, &created); err != nil {
		return "", err
	}
	if created.ID == "" {
		return "", fmt.Errorf("provider create succeeded without id")
	}
	return created.ID, nil
}

func (c *Client) UpsertModelMapping(ctx context.Context, payload mappingPayload) error {
	var mappings mappingListResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/admin/model-mappings", nil, &mappings); err != nil {
		return err
	}

	for _, mapping := range mappings.Items {
		if mapping.ModelPattern != payload.ModelPattern {
			continue
		}
		update := mappingUpdatePayload{
			ModelPattern: &payload.ModelPattern,
			ProviderID:   &payload.ProviderID,
			Priority:     intPtr(payload.Priority),
			Weight:       intPtr(payload.Weight),
			IsActive:     boolPtr(payload.IsActive),
		}
		return c.doJSON(ctx, http.MethodPut, "/api/admin/model-mappings/"+mapping.ID, update, nil)
	}

	return c.doJSON(ctx, http.MethodPost, "/api/admin/model-mappings", payload, nil)
}

func (c *Client) doJSON(ctx context.Context, method, path string, body any, out any) error {
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request for %s %s: %w", method, path, err)
		}
		payload = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, payload)
	if err != nil {
		return fmt.Errorf("create request for %s %s: %w", method, path, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.adminToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read response for %s %s: %w", method, path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s failed: status=%d body=%s", method, path, resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	if out == nil || len(respBody) == 0 {
		return nil
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("decode response for %s %s: %w", method, path, err)
	}
	return nil
}

func intPtr(v int) *int {
	return &v
}

func boolPtr(v bool) *bool {
	return &v
}
