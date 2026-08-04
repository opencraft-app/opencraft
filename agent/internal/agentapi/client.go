package agentapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"velachat/agent/internal/common"
)

const (
	maximumJSONResponseBytes   = 16 * 1024 * 1024
	maximumBinaryResponseBytes = 50 * 1024 * 1024
)

var ErrResponseTooLarge = errors.New("Agent API response exceeds the size limit")

type ClientOptions struct {
	BaseURL    string
	TokenFile  string
	HTTPClient *http.Client
}

type Client struct {
	baseURL *url.URL
	token   string
	http    *http.Client
}

type Request struct {
	Path    map[string]string
	Query   url.Values
	Body    any
	RawBody io.Reader
	Headers http.Header
}

type HTTPError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("Agent API HTTP %d (%s): %s", e.StatusCode, e.Code, e.Message)
	}
	return fmt.Sprintf("Agent API HTTP %d: %s", e.StatusCode, e.Message)
}

func New(options ClientOptions) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimRight(options.BaseURL, "/") + "/")
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		return nil, errors.New("Agent API base URL is invalid")
	}
	if baseURL.Scheme != "http" || !isLoopbackHost(baseURL.Hostname()) {
		return nil, errors.New("Agent API base URL must use loopback HTTP")
	}
	info, err := os.Stat(options.TokenFile)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("Agent API token file must be a mode-0600 regular file")
	}
	tokenBytes, err := os.ReadFile(options.TokenFile)
	if err != nil {
		return nil, err
	}
	token := strings.TrimSpace(string(tokenBytes))
	if !strings.HasPrefix(token, "sap_") {
		return nil, errors.New("Agent API token is invalid")
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 30 * time.Second,
		}
	}
	httpClientCopy := *httpClient
	httpClientCopy.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{baseURL: baseURL, token: token, http: &httpClientCopy}, nil
}

func (c *Client) Call(ctx context.Context, operation Operation, input Request, destination any) error {
	route, ok := Lookup(operation)
	if !ok {
		return fmt.Errorf("unknown Agent API operation %q", operation)
	}
	path := route.Path
	for key, value := range input.Path {
		path = strings.ReplaceAll(path, ":"+key, url.PathEscape(value))
	}
	if strings.Contains(path, ":") {
		return errors.New("Agent API route is missing a path parameter")
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: BasePath + path})
	endpoint.RawQuery = input.Query.Encode()

	if input.Body != nil && input.RawBody != nil {
		return errors.New("Agent API request cannot use JSON and raw bodies together")
	}
	var body io.Reader
	if input.Body != nil {
		data, err := common.Marshal(input.Body)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	} else if input.RawBody != nil {
		body = input.RawBody
	}
	request, err := http.NewRequestWithContext(ctx, route.Method, endpoint.String(), body)
	if err != nil {
		return err
	}
	for key, values := range input.Headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	if input.Body != nil && request.Header.Get("Content-Type") == "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseLimit := int64(maximumJSONResponseBytes)
	if route.Binary {
		responseLimit = maximumBinaryResponseBytes
	}
	if response.ContentLength > responseLimit {
		return ErrResponseTooLarge
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, readErr := readLimitedResponse(response.Body)
		if readErr != nil {
			return readErr
		}
		var failure struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Error   string `json:"error"`
		}
		if decodeErr := common.Unmarshal(data, &failure); decodeErr != nil {
			return &HTTPError{StatusCode: response.StatusCode, Message: http.StatusText(response.StatusCode)}
		}
		message := failure.Message
		if message == "" {
			message = failure.Error
		}
		return &HTTPError{StatusCode: response.StatusCode, Code: failure.Code, Message: message}
	}
	if route.Binary {
		var writer io.Writer = io.Discard
		if destination != nil {
			var ok bool
			writer, ok = destination.(io.Writer)
			if !ok {
				return errors.New("binary Agent API destination must implement io.Writer")
			}
		}
		written, err := io.Copy(writer, io.LimitReader(response.Body, maximumBinaryResponseBytes+1))
		if err != nil {
			return err
		}
		if written > maximumBinaryResponseBytes {
			return ErrResponseTooLarge
		}
		return nil
	}
	data, err := readLimitedResponse(response.Body)
	if err != nil {
		return err
	}
	if err := validateObservedResponse(operation, data); err != nil {
		return err
	}
	if destination == nil {
		return nil
	}
	return common.Unmarshal(data, destination)
}

func readLimitedResponse(reader io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maximumJSONResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maximumJSONResponseBytes {
		return nil, ErrResponseTooLarge
	}
	return data, nil
}

func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}
