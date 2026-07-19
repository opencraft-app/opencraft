package clients

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

type PacerFaultPolicy struct {
	Enabled    bool   `json:"enabled"`
	Model      string `json:"model,omitempty"`
	StatusCode int    `json:"status_code,omitempty"`
	Message    string `json:"message,omitempty"`
}

type PacerFaultClient struct {
	http      *http.Client
	sanitizer *framework.Sanitizer
}

func NewPacerFaultClient(client *http.Client, sanitizer *framework.Sanitizer) *PacerFaultClient {
	if client == nil {
		client = http.DefaultClient
	}
	if sanitizer == nil {
		sanitizer = framework.NewSanitizer()
	}
	return &PacerFaultClient{http: client, sanitizer: sanitizer}
}

func (c *PacerFaultClient) Apply(ctx context.Context, podURLs []string, token framework.Secret, policy PacerFaultPolicy) error {
	if len(podURLs) == 0 {
		return fmt.Errorf("no regression pacer Pods are available")
	}
	raw, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	var result error
	for _, baseURL := range podURLs {
		path := strings.TrimRight(baseURL, "/") + "/__regression/fault"
		req, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, path, bytes.NewReader(raw))
		if requestErr != nil {
			result = errors.Join(result, requestErr)
			continue
		}
		req.Header.Set("Authorization", "Bearer "+token.Reveal())
		req.Header.Set("Content-Type", "application/json")
		resp, requestErr := c.http.Do(req)
		if requestErr != nil {
			result = errors.Join(result, c.sanitizer.Error(requestErr))
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			result = errors.Join(result, fmt.Errorf("pacer fault update returned %d", resp.StatusCode))
		}
	}
	return result
}
