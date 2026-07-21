package provisioner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

type ProvisionControl interface {
	Control
	ListRequests(context.Context, string, string, string, string, int) ([]gateway.SetProvisionRequest, error)
	Claim(context.Context, gateway.SetProvisionRequest, string, time.Duration) (gateway.SetProvisionRequest, bool, error)
	Release(context.Context, gateway.SetProvisionRequest) error
}

type HTTPControlClient struct {
	baseURL       string
	internalToken string
	httpClient    *http.Client
}

type controlResponse[T any] struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

func NewHTTPControlClient(baseURL, internalToken string, httpClient *http.Client) *HTTPControlClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &HTTPControlClient{baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"), internalToken: strings.TrimSpace(internalToken), httpClient: httpClient}
}

func (c *HTTPControlClient) ListRequests(ctx context.Context, source, namespace, fleet, status string, limit int) ([]gateway.SetProvisionRequest, error) {
	query := url.Values{}
	query.Set("source", source)
	query.Set("namespace", namespace)
	query.Set("fleet", fleet)
	if status != "" {
		query.Set("status", status)
	}
	query.Set("limit", strconv.Itoa(limit))
	var requests []gateway.SetProvisionRequest
	if err := c.do(ctx, http.MethodGet, "/api/internal/velagwset-provisioner/set-provision-requests?"+query.Encode(), nil, &requests); err != nil {
		return nil, err
	}
	return requests, nil
}

func (c *HTTPControlClient) Claim(ctx context.Context, request gateway.SetProvisionRequest, owner string, ttl time.Duration) (gateway.SetProvisionRequest, bool, error) {
	var claimed gateway.SetProvisionRequest
	err := c.do(ctx, http.MethodPost, provisionRequestPath(request.ID, "claim"), map[string]any{
		"writer_epoch": request.WriterEpoch, "lifecycle_revision": request.LifecycleRevision,
		"owner": owner, "lease_seconds": int(ttl.Seconds()),
	}, &claimed)
	if httpErrorStatus(err) == http.StatusConflict {
		return gateway.SetProvisionRequest{}, false, nil
	}
	return claimed, err == nil, err
}

func (c *HTTPControlClient) Release(ctx context.Context, request gateway.SetProvisionRequest) error {
	return c.do(ctx, http.MethodPost, provisionRequestPath(request.ID, "release"), map[string]any{
		"writer_epoch": request.WriterEpoch, "lifecycle_revision": request.LifecycleRevision,
		"expected_version": request.Version, "claim_token": request.ClaimToken,
	}, nil)
}

func (c *HTTPControlClient) Materialized(ctx context.Context, input gateway.SetProvisionFactCommitInput) error {
	return c.do(ctx, http.MethodPost, provisionRequestPath(input.ID, "materialized"), input, nil)
}

func (c *HTTPControlClient) ServingReady(ctx context.Context, input gateway.SetProvisionFactCommitInput) error {
	return c.do(ctx, http.MethodPost, provisionRequestPath(input.ID, "serving-ready"), input, nil)
}

func provisionRequestPath(id, action string) string {
	return "/api/internal/velagwset-provisioner/set-provision-requests/" + url.PathEscape(id) + "/" + action
}

type controlHTTPError struct {
	status int
	body   string
}

func (e *controlHTTPError) Error() string {
	return fmt.Sprintf("control API status=%d body=%s", e.status, e.body)
}

func httpErrorStatus(err error) int {
	if typed, ok := err.(*controlHTTPError); ok {
		return typed.status
	}
	return 0
}

func (c *HTTPControlClient) do(ctx context.Context, method, path string, body, output any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.internalToken)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &controlHTTPError{status: response.StatusCode, body: strings.TrimSpace(string(raw))}
	}
	if output == nil {
		return nil
	}
	var envelope controlResponse[json.RawMessage]
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	if !envelope.Success {
		return fmt.Errorf("control API: %s", envelope.Message)
	}
	return json.Unmarshal(envelope.Data, output)
}
