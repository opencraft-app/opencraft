// Package backend invokes immutable site revisions over an authenticated internal
// transport. No URL or privileged identity is taken from a browser request.
package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const MaxBodyBytes = 1 << 20
const MaxResponseBytes = 4 << 20

var identifier = regexp.MustCompile(`^[a-z][a-z0-9-]{1,95}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Invocation struct {
	SHA256  string            `json:"sha256"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}
type Result struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}
type Client struct {
	base, token string
	http        *http.Client
}

func New(base, token string) (*Client, error) {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || strings.TrimSpace(token) == "" {
		return nil, fmt.Errorf("invalid runtime endpoint or credential")
	}
	return &Client{base: strings.TrimRight(base, "/"), token: token, http: &http.Client{Timeout: 7 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Client) Invoke(ctx context.Context, site, release string, in Invocation) (Result, error) {
	var result Result
	if !identifier.MatchString(site) || !identifier.MatchString(release) || !digest.MatchString(in.SHA256) || len(in.Body) > MaxBodyBytes {
		return result, fmt.Errorf("invalid runtime target")
	}
	data, err := json.Marshal(in)
	if err != nil {
		return result, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.base+"/v1/sites/"+site+"/releases/"+release+"/invoke", bytes.NewReader(data))
	if err != nil {
		return result, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return result, fmt.Errorf("runtime unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return Result{Status: 429}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return result, fmt.Errorf("runtime rejected request: %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 6<<20+1))
	if err != nil || len(body) > 6<<20 {
		return result, fmt.Errorf("runtime response too large")
	}
	if err = json.Unmarshal(body, &result); err != nil {
		return result, fmt.Errorf("invalid runtime response")
	}
	if result.Status < 200 || result.Status > 599 || (result.Status >= 300 && result.Status < 400) || len(result.Body) > MaxResponseBytes {
		return Result{}, fmt.Errorf("unsupported runtime response")
	}
	return result, nil
}
