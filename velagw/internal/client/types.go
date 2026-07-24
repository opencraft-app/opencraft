package client

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type AuthLane string

const (
	AuthInternal AuthLane = "internal"
	AuthAdmin    AuthLane = "admin"
	AuthTraffic  AuthLane = "traffic"
	AuthPublic   AuthLane = "public"
)

type Plane string

const (
	PlaneControl Plane = "control"
	PlaneTraffic Plane = "traffic"
)

type Config struct {
	ControlURL    string
	TrafficURL    string
	InternalToken string
	AdminToken    string
	APIKey        string
	Timeout       time.Duration
	DryRun        bool
	HTTPClient    *http.Client
	Trace         func(Trace)
}

type Trace struct {
	Lane       AuthLane
	Method     string
	Path       string
	StatusCode int
	Duration   time.Duration
	DryRun     bool
	Err        error
}

type RequestSummary struct {
	Lane   AuthLane `json:"lane"`
	Method string   `json:"method"`
	Path   string   `json:"path"`
}

type Result struct {
	StatusCode int             `json:"status_code"`
	Data       json.RawMessage `json:"data,omitempty"`
	DryRun     bool            `json:"dry_run,omitempty"`
	Request    RequestSummary  `json:"request"`
}

func (r Result) Decode(target any) error {
	if target == nil || len(r.Data) == 0 || string(r.Data) == "null" {
		return nil
	}
	if err := json.Unmarshal(r.Data, target); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

type APIError struct {
	StatusCode int
	Method     string
	Path       string
	Message    string
	Code       string
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s %s returned %d: %s (%s)", e.Method, e.Path, e.StatusCode, e.Message, e.Code)
	}
	return fmt.Sprintf("%s %s returned %d: %s", e.Method, e.Path, e.StatusCode, e.Message)
}

type EnsureUserInput struct {
	UserID   string `json:"user_id"`
	Nickname string `json:"nickname,omitempty"`
}

type AssignmentInput struct {
	Backend string `json:"backend"`
	SetID   string `json:"set_id,omitempty"`
}

type ApplySubscriptionInput struct {
	IdempotencyKey string `json:"idempotency_key,omitempty"`
	UserID         string `json:"user_id"`
	PlanID         string `json:"plan_id"`
	Nickname       string `json:"nickname,omitempty"`
	Phone          string `json:"phone,omitempty"`
	PeriodValue    int    `json:"period_value,omitempty"`
	PeriodUnit     string `json:"period_unit,omitempty"`
}

type CancelSubscriptionInput struct {
	UserID string `json:"user_id"`
}

type BYOKSettingsInput struct {
	Routing   BYOKRoutingInput    `json:"routing"`
	Providers []BYOKProviderInput `json:"providers"`
}

type BYOKRoutingInput struct {
	Mode string `json:"mode"`
}

type BYOKProviderInput struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Protocol      string            `json:"protocol"`
	BaseURL       string            `json:"base_url"`
	APIKey        string            `json:"api_key"`
	ModelMappings map[string]string `json:"model_mappings"`
	Enabled       bool              `json:"enabled"`
}

type ChatInput struct {
	Model  string
	Prompt string
	System string
	Stream bool
}

type APIKey struct {
	APIKey string `json:"api_key"`
	KeyID  string `json:"key_id,omitempty"`
	Name   string `json:"name,omitempty"`
}
