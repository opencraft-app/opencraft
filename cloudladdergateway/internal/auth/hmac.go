package auth

import (
	"crypto/hmac"
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

var (
	ErrMissingCredentials = errors.New("missing authentication credentials")
	ErrUnknownCaller      = errors.New("unknown caller")
	ErrRouteDenied        = errors.New("caller is not allowed to invoke route")
	ErrInvalidTimestamp   = errors.New("invalid authentication timestamp")
	ErrInvalidSignature   = errors.New("invalid authentication signature")
)

type Authenticator struct {
	mode                 string
	timestampSkew        time.Duration
	allowUnauthenticated map[string]struct{}
	callers              map[string]Caller
	routeCallers         map[string][]string
}

type Caller struct {
	ID     string
	Secret string
	Routes []string
}

type Request struct {
	Caller    string
	RouteID   string
	Method    string
	Path      string
	Query     string
	Body      []byte
	Timestamp string
	Signature string
}

func New(cfg config.Config) (*Authenticator, error) {
	mode := cfg.Auth.EffectiveMode()
	if mode != config.AuthModeDisabled && mode != config.AuthModeOptional && mode != config.AuthModeRequired {
		return nil, fmt.Errorf("unsupported auth mode %q", cfg.Auth.Mode)
	}
	skew, err := config.ParseDuration(cfg.Auth.TimestampSkew, 5*time.Minute)
	if err != nil {
		return nil, err
	}
	authenticator := &Authenticator{
		mode:                 mode,
		timestampSkew:        skew,
		allowUnauthenticated: map[string]struct{}{},
		callers:              map[string]Caller{},
		routeCallers:         map[string][]string{},
	}
	for _, route := range cfg.Routes {
		authenticator.routeCallers[route.ID] = append([]string(nil), route.Callers...)
	}
	for _, routeID := range cfg.Auth.AllowUnauthenticated {
		authenticator.allowUnauthenticated[routeID] = struct{}{}
	}
	for _, callerCfg := range cfg.Auth.Callers {
		secret := strings.TrimSpace(os.Getenv(callerCfg.SecretEnv))
		if mode == config.AuthModeRequired && secret == "" {
			return nil, fmt.Errorf("auth caller %q secret env %s is empty", callerCfg.ID, callerCfg.SecretEnv)
		}
		if mode == config.AuthModeOptional && secret == "" {
			continue
		}
		authenticator.callers[callerCfg.ID] = Caller{
			ID:     callerCfg.ID,
			Secret: secret,
			Routes: append([]string(nil), callerCfg.Routes...),
		}
	}
	return authenticator, nil
}

func (a *Authenticator) Verify(req Request) error {
	if a == nil || a.mode == config.AuthModeDisabled {
		return nil
	}
	credentialsEmpty := strings.TrimSpace(req.Caller) == "" &&
		strings.TrimSpace(req.Timestamp) == "" &&
		strings.TrimSpace(req.Signature) == ""
	if a.mode == config.AuthModeOptional && credentialsEmpty {
		return nil
	}
	if a.mode == config.AuthModeRequired {
		if _, ok := a.allowUnauthenticated[req.RouteID]; ok {
			return nil
		}
	}
	if credentialsEmpty {
		return ErrMissingCredentials
	}
	if strings.TrimSpace(req.Caller) == "" || strings.TrimSpace(req.Timestamp) == "" || strings.TrimSpace(req.Signature) == "" {
		return ErrMissingCredentials
	}
	caller, ok := a.callers[req.Caller]
	if !ok {
		return ErrUnknownCaller
	}
	routeCallers := a.routeCallers[req.RouteID]
	callerAllowsRoute := len(caller.Routes) > 0 && slices.Contains(caller.Routes, req.RouteID)
	routeAllowsCaller := len(routeCallers) > 0 && slices.Contains(routeCallers, req.Caller)
	if !callerAllowsRoute && !routeAllowsCaller {
		return ErrRouteDenied
	}
	timestamp, err := time.Parse(time.RFC3339, req.Timestamp)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidTimestamp, err)
	}
	if drift := time.Since(timestamp); drift > a.timestampSkew || drift < -a.timestampSkew {
		return ErrInvalidTimestamp
	}
	expected := Sign(caller.Secret, req)
	if !hmac.Equal([]byte(expected), []byte(req.Signature)) {
		return ErrInvalidSignature
	}
	return nil
}

func Sign(secret string, req Request) string {
	return cloudladdertransport.Sign(secret, cloudladdertransport.Request{
		Caller:    req.Caller,
		RouteID:   req.RouteID,
		Method:    req.Method,
		Path:      req.Path,
		Query:     req.Query,
		Body:      req.Body,
		Timestamp: req.Timestamp,
	})
}

func canonicalString(req Request) string {
	return cloudladdertransport.CanonicalString(cloudladdertransport.Request{
		Caller:    req.Caller,
		RouteID:   req.RouteID,
		Method:    req.Method,
		Path:      req.Path,
		Query:     req.Query,
		Body:      req.Body,
		Timestamp: req.Timestamp,
	})
}

func RequestFromHTTP(r *http.Request, routeID string, proxyPath string, body []byte) Request {
	return Request{
		Caller:    firstHeader(r.Header, "X-CloudLadder-Caller", "X-Caller", "X-Service-Name"),
		RouteID:   routeID,
		Method:    r.Method,
		Path:      proxyPath,
		Query:     r.URL.RawQuery,
		Body:      body,
		Timestamp: r.Header.Get("X-CloudLadder-Timestamp"),
		Signature: r.Header.Get("X-CloudLadder-Signature"),
	}
}

func firstHeader(headers http.Header, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(headers.Get(name)); value != "" {
			return value
		}
	}
	return ""
}
