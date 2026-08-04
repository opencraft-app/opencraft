package platform

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

var (
	ErrInvalidHumanAccessToken = errors.New("Human access token 无效")
	ErrInvalidManagedComputer  = errors.New("平台返回的 Computer 无效")
	ErrInvalidRegistration     = errors.New("平台返回的 TAT registration 无效")
	ErrInvalidIssuedCredential = errors.New(
		"平台返回的 Computer credential 无效",
	)
)

type HumanAccessToken struct {
	value []byte
}

func NewHumanAccessToken(value []byte) (HumanAccessToken, error) {
	if len(value) < 1 ||
		len(value) > 16*1024 ||
		bytes.IndexAny(value, " \t\r\n") >= 0 {
		return HumanAccessToken{}, ErrInvalidHumanAccessToken
	}
	return HumanAccessToken{value: bytes.Clone(value)}, nil
}

func (token *HumanAccessToken) Clear() {
	if token == nil {
		return
	}
	clear(token.value)
	token.value = nil
}

type CreateManagedComputerRequest struct {
	ServerID       string
	Name           string
	IdempotencyKey string
}

type ManagedComputer struct {
	ID             string     `json:"id"`
	ServerID       string     `json:"serverId"`
	Name           string     `json:"name"`
	Region         string     `json:"tatRegion"`
	TATInstanceID  *string    `json:"tatInstanceId"`
	InstanceKind   string     `json:"tatInstanceKind"`
	OSType         string     `json:"osType"`
	LifecycleState string     `json:"lifecycleState"`
	TATAgentState  string     `json:"tatAgentState"`
	LastObservedAt *time.Time `json:"lastObservedAt"`
	LastErrorCode  *string    `json:"lastErrorCode"`
	Revision       int64      `json:"revision"`
}

type ComputerRegistrationTag struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type ComputerRegistration struct {
	ComputerID        string                    `json:"computerId"`
	Protocol          string                    `json:"protocol"`
	Region            string                    `json:"region"`
	RegisterCodeID    string                    `json:"registerCodeId"`
	RegisterCodeValue string                    `json:"registerCodeValue"`
	Tags              []ComputerRegistrationTag `json:"tags"`
	ExpiresAt         time.Time                 `json:"expiresAt"`
}

type IssuedComputerCredential struct {
	CredentialID   string
	Version        int64
	Credential     ComputerCredential
	ExpiresAt      time.Time
	GraceExpiresAt *time.Time
}

func (c *Client) CreateManagedComputer(
	ctx context.Context,
	token HumanAccessToken,
	input CreateManagedComputerRequest,
) (ManagedComputer, error) {
	if c == nil ||
		ctx == nil ||
		!validHumanToken(token) ||
		!validUUIDv7(input.ServerID) ||
		!validUUIDv7(input.IdempotencyKey) ||
		strings.TrimSpace(input.Name) == "" ||
		len(input.Name) > 100 {
		return ManagedComputer{}, ErrInvalidConfig
	}
	body, err := common.Marshal(map[string]any{
		"name":            input.Name,
		"tatInstanceKind": "managed",
		"osType":          "macos",
	})
	if err != nil {
		return ManagedComputer{}, err
	}
	var computer ManagedComputer
	err = c.doHumanJSON(
		ctx,
		http.MethodPost,
		"/servers/"+url.PathEscape(input.ServerID)+"/computers",
		token,
		input.IdempotencyKey,
		body,
		http.StatusCreated,
		&computer,
	)
	if err != nil {
		return ManagedComputer{}, err
	}
	if !validManagedComputer(computer, input.ServerID) ||
		computer.Name != input.Name {
		return ManagedComputer{}, ErrInvalidManagedComputer
	}
	return computer, nil
}

func (c *Client) GetManagedComputer(
	ctx context.Context,
	token HumanAccessToken,
	serverID string,
	computerID string,
) (ManagedComputer, error) {
	if c == nil ||
		ctx == nil ||
		!validHumanToken(token) ||
		!validUUIDv7(serverID) ||
		!validUUIDv7(computerID) {
		return ManagedComputer{}, ErrInvalidConfig
	}
	var computer ManagedComputer
	err := c.doHumanJSON(
		ctx,
		http.MethodGet,
		"/servers/"+url.PathEscape(serverID)+"/computers/"+
			url.PathEscape(computerID),
		token,
		"",
		nil,
		http.StatusOK,
		&computer,
	)
	if err != nil {
		return ManagedComputer{}, err
	}
	if computer.ID != computerID ||
		!validManagedComputer(computer, serverID) {
		return ManagedComputer{}, ErrInvalidManagedComputer
	}
	return computer, nil
}

func (c *Client) CreateComputerRegistration(
	ctx context.Context,
	token HumanAccessToken,
	serverID string,
	computerID string,
) (ComputerRegistration, error) {
	if c == nil ||
		ctx == nil ||
		!validHumanToken(token) ||
		!validUUIDv7(serverID) ||
		!validUUIDv7(computerID) {
		return ComputerRegistration{}, ErrInvalidConfig
	}
	var registration ComputerRegistration
	err := c.doHumanJSON(
		ctx,
		http.MethodPost,
		"/servers/"+url.PathEscape(serverID)+"/computers/"+
			url.PathEscape(computerID)+"/registration",
		token,
		"",
		nil,
		http.StatusCreated,
		&registration,
	)
	if err != nil {
		return ComputerRegistration{}, err
	}
	if registration.ComputerID != computerID ||
		registration.Protocol != "tencent-tat-register-v1" ||
		strings.TrimSpace(registration.Region) == "" ||
		strings.TrimSpace(registration.RegisterCodeID) == "" ||
		strings.TrimSpace(registration.RegisterCodeValue) == "" ||
		len(registration.Tags) < 1 ||
		len(registration.Tags) > 10 ||
		!registration.ExpiresAt.After(c.now().UTC()) {
		return ComputerRegistration{}, ErrInvalidRegistration
	}
	for _, tag := range registration.Tags {
		if strings.TrimSpace(tag.Key) == "" ||
			strings.TrimSpace(tag.Value) == "" {
			return ComputerRegistration{}, ErrInvalidRegistration
		}
	}
	return registration, nil
}

func (c *Client) CreateComputerRuntimeCredential(
	ctx context.Context,
	token HumanAccessToken,
	serverID string,
	computerID string,
	mode string,
	idempotencyKey string,
) (IssuedComputerCredential, error) {
	if c == nil ||
		ctx == nil ||
		!validHumanToken(token) ||
		!validUUIDv7(serverID) ||
		!validUUIDv7(computerID) ||
		!validUUIDv7(idempotencyKey) ||
		mode != "bootstrap" && mode != "recover" {
		return IssuedComputerCredential{}, ErrInvalidConfig
	}
	body, err := common.Marshal(map[string]string{"mode": mode})
	if err != nil {
		return IssuedComputerCredential{}, err
	}
	var payload struct {
		CredentialID   string     `json:"credentialId"`
		Version        int64      `json:"version"`
		Secret         string     `json:"secret"`
		ExpiresAt      time.Time  `json:"expiresAt"`
		GraceExpiresAt *time.Time `json:"graceExpiresAt"`
	}
	err = c.doHumanJSON(
		ctx,
		http.MethodPost,
		"/servers/"+url.PathEscape(serverID)+"/computers/"+
			url.PathEscape(computerID)+"/runtime-credentials",
		token,
		idempotencyKey,
		body,
		http.StatusCreated,
		&payload,
	)
	if err != nil {
		return IssuedComputerCredential{}, err
	}
	credential, err := NewComputerCredential(payload.Secret)
	if err != nil ||
		credential.ServerID() != serverID ||
		credential.ComputerID() != computerID ||
		credential.Version() != payload.Version ||
		!validUUIDv7(payload.CredentialID) ||
		!payload.ExpiresAt.After(c.now().UTC()) {
		return IssuedComputerCredential{}, ErrInvalidIssuedCredential
	}
	return IssuedComputerCredential{
		CredentialID:   payload.CredentialID,
		Version:        payload.Version,
		Credential:     credential,
		ExpiresAt:      payload.ExpiresAt.UTC(),
		GraceExpiresAt: payload.GraceExpiresAt,
	}, nil
}

func (c *Client) doHumanJSON(
	ctx context.Context,
	method string,
	path string,
	token HumanAccessToken,
	idempotencyKey string,
	body []byte,
	expectedStatus int,
	output any,
) error {
	request, err := http.NewRequestWithContext(
		ctx,
		method,
		c.baseURL+path,
		bytes.NewReader(body),
	)
	if err != nil {
		return ErrInvalidConfig
	}
	request.Header.Set("Authorization", "Bearer "+string(token.value))
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return newRequestError(true, 0)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden {
		return ErrCredentialRejected
	}
	if response.StatusCode != expectedStatus {
		return newRequestError(
			response.StatusCode == http.StatusTooManyRequests ||
				response.StatusCode >= http.StatusInternalServerError,
			parseRetryAfter(
				response.Header.Get("Retry-After"),
				c.now().UTC(),
			),
		)
	}
	if err := decodeLimited(response.Body, output); err != nil {
		return ErrInvalidManagedComputer
	}
	return nil
}

func validHumanToken(token HumanAccessToken) bool {
	return len(token.value) > 0
}

func validManagedComputer(value ManagedComputer, serverID string) bool {
	if !validUUIDv7(value.ID) ||
		value.ServerID != serverID ||
		strings.TrimSpace(value.Name) == "" ||
		strings.TrimSpace(value.Region) == "" ||
		value.InstanceKind != "managed" ||
		value.OSType != "macos" ||
		value.Revision < 1 {
		return false
	}
	switch value.LifecycleState {
	case "provisioning", "active", "removed":
	default:
		return false
	}
	switch value.TATAgentState {
	case "unknown", "online", "offline", "error":
		return true
	default:
		return false
	}
}
