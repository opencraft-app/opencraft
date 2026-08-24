package oidc

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

var codeVerifierPattern = regexp.MustCompile(`^[A-Za-z0-9\-\._~]{43,128}$`)

type ProviderConfig struct {
	Issuer              string
	AuthorizationPath   string
	TokenPath           string
	JWKSPath            string
	Registry            *Registry
	CodeStore           CodeStore
	SigningKeyID        string
	SigningKey          ed25519.PrivateKey
	AccessTokenAudience string
	IDTokenTTL          time.Duration
	AccessTokenTTL      time.Duration
	CodeTTL             time.Duration
	Now                 func() time.Time
	Random              io.Reader
}

type Provider struct {
	issuer              string
	authorizationURL    string
	tokenURL            string
	jwksURL             string
	registry            *Registry
	codeStore           CodeStore
	signingKeyID        string
	signingKey          ed25519.PrivateKey
	signingPublicKey    ed25519.PublicKey
	accessTokenAudience string
	idTokenTTL          time.Duration
	accessTokenTTL      time.Duration
	codeTTL             time.Duration
	now                 func() time.Time
	random              io.Reader
}

type AuthorizeRequest struct {
	ClientID            string
	RedirectURI         string
	ResponseType        string
	Scope               string
	State               string
	Nonce               string
	CodeChallenge       string
	CodeChallengeMethod string
}

type AuthorizeContext struct {
	ClientID      string
	ClientName    string
	RedirectURI   string
	Scope         string
	State         string
	Nonce         string
	CodeChallenge string
}

type AuthorizeResult struct {
	Code       string
	RedirectTo string
	ExpiresAt  time.Time
}

type TokenRequest struct {
	GrantType    string
	Code         string
	ClientID     string
	RedirectURI  string
	CodeVerifier string
}

type TokenUser struct {
	ID    string
	Name  string
	Email string
}

type TokenResponse struct {
	AccessToken string
	TokenType   string
	ExpiresIn   int
	Scope       string
	IDToken     string
}

type DiscoveryDocument struct {
	Issuer                           string   `json:"issuer"`
	AuthorizationEndpoint            string   `json:"authorization_endpoint"`
	TokenEndpoint                    string   `json:"token_endpoint"`
	JwksURI                          string   `json:"jwks_uri"`
	ResponseTypesSupported           []string `json:"response_types_supported"`
	SubjectTypesSupported            []string `json:"subject_types_supported"`
	IDTokenSigningAlgValuesSupported []string `json:"id_token_signing_alg_values_supported"`
	ScopesSupported                  []string `json:"scopes_supported"`
	TokenEndpointAuthMethodsSupport  []string `json:"token_endpoint_auth_methods_supported"`
	GrantTypesSupported              []string `json:"grant_types_supported"`
	CodeChallengeMethodsSupported    []string `json:"code_challenge_methods_supported"`
}

type JWKS struct {
	Keys []JWK `json:"keys"`
}

type JWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	X   string `json:"x"`
}

func NewProvider(config ProviderConfig) *Provider {
	now := config.Now
	if now == nil {
		now = time.Now
	}
	random := config.Random
	if random == nil {
		random = rand.Reader
	}
	issuer := strings.TrimRight(strings.TrimSpace(config.Issuer), "/")
	return &Provider{
		issuer:              issuer,
		authorizationURL:    issuer + config.AuthorizationPath,
		tokenURL:            issuer + config.TokenPath,
		jwksURL:             issuer + config.JWKSPath,
		registry:            config.Registry,
		codeStore:           config.CodeStore,
		signingKeyID:        strings.TrimSpace(config.SigningKeyID),
		signingKey:          slices.Clone(config.SigningKey),
		signingPublicKey:    slices.Clone(config.SigningKey.Public().(ed25519.PublicKey)),
		accessTokenAudience: strings.TrimSpace(config.AccessTokenAudience),
		idTokenTTL:          positiveDuration(config.IDTokenTTL, 5*time.Minute),
		accessTokenTTL:      positiveDuration(config.AccessTokenTTL, 5*time.Minute),
		codeTTL:             positiveDuration(config.CodeTTL, 5*time.Second),
		now:                 now,
		random:              random,
	}
}

func positiveDuration(value time.Duration, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}

func (p *Provider) DiscoveryDocument() DiscoveryDocument {
	return DiscoveryDocument{
		Issuer:                           p.issuer,
		AuthorizationEndpoint:            p.authorizationURL,
		TokenEndpoint:                    p.tokenURL,
		JwksURI:                          p.jwksURL,
		ResponseTypesSupported:           []string{"code"},
		SubjectTypesSupported:            []string{"public"},
		IDTokenSigningAlgValuesSupported: []string{"EdDSA"},
		ScopesSupported:                  []string{"openid", "profile", "email"},
		TokenEndpointAuthMethodsSupport:  []string{"none"},
		GrantTypesSupported:              []string{"authorization_code"},
		CodeChallengeMethodsSupported:    []string{"S256"},
	}
}

func (p *Provider) JWKS() JWKS {
	return JWKS{
		Keys: []JWK{{
			Kty: "OKP",
			Crv: "Ed25519",
			Use: "sig",
			Alg: "EdDSA",
			Kid: p.signingKeyID,
			X:   base64.RawURLEncoding.EncodeToString(p.signingPublicKey),
		}},
	}
}

func (p *Provider) ValidateAuthorizeRequest(req AuthorizeRequest) (AuthorizeContext, error) {
	if p == nil || p.registry == nil {
		return AuthorizeContext{}, ErrInvalidRequest
	}
	client, ok := p.registry.Client(req.ClientID)
	if !ok {
		return AuthorizeContext{}, ErrInvalidClient
	}
	redirectURI, err := p.registry.ValidateRedirectURI(req.ClientID, req.RedirectURI)
	if err != nil {
		return AuthorizeContext{}, ErrInvalidClient
	}
	if strings.TrimSpace(req.ResponseType) != "code" {
		return AuthorizeContext{}, ErrInvalidRequest
	}
	scope, err := normalizeScope(req.Scope)
	if err != nil {
		return AuthorizeContext{}, ErrInvalidRequest
	}
	if strings.TrimSpace(req.State) == "" || len(req.State) > 2048 {
		return AuthorizeContext{}, ErrInvalidRequest
	}
	if len(req.Nonce) == 0 || len(req.Nonce) > 255 {
		return AuthorizeContext{}, ErrInvalidRequest
	}
	if req.CodeChallengeMethod != "S256" {
		return AuthorizeContext{}, ErrInvalidRequest
	}
	if err := validateS256CodeChallenge(req.CodeChallenge); err != nil {
		return AuthorizeContext{}, ErrInvalidRequest
	}
	return AuthorizeContext{
		ClientID:      client.ID,
		ClientName:    client.DisplayName,
		RedirectURI:   redirectURI,
		Scope:         scope,
		State:         strings.TrimSpace(req.State),
		Nonce:         req.Nonce,
		CodeChallenge: req.CodeChallenge,
	}, nil
}

func normalizeScope(raw string) (string, error) {
	parts := strings.Fields(strings.TrimSpace(raw))
	if len(parts) == 0 {
		return "", ErrInvalidRequest
	}
	seen := map[string]bool{}
	normalized := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "openid" && part != "profile" && part != "email" {
			return "", ErrInvalidRequest
		}
		if !seen[part] {
			normalized = append(normalized, part)
			seen[part] = true
		}
	}
	if !seen["openid"] {
		return "", ErrInvalidRequest
	}
	return strings.Join(normalized, " "), nil
}

func (p *Provider) CreateAuthorizationCode(ctx context.Context, userID string, req AuthorizeRequest) (*AuthorizeResult, error) {
	context, err := p.ValidateAuthorizeRequest(req)
	if err != nil {
		return nil, err
	}
	code, err := p.newCode()
	if err != nil {
		return nil, fmt.Errorf("generate oidc code: %w", err)
	}
	now := p.now().UTC()
	expiresAt := now.Add(p.codeTTL)
	if err := p.codeStore.CreateAuthorizationCode(ctx, CreateAuthorizationCodeInput{
		Code:          code,
		ClientID:      context.ClientID,
		UserID:        strings.TrimSpace(userID),
		RedirectURI:   context.RedirectURI,
		Scope:         context.Scope,
		CodeChallenge: context.CodeChallenge,
		Nonce:         context.Nonce,
		ExpiresAt:     expiresAt,
		CreatedAt:     now,
	}); err != nil {
		return nil, err
	}
	redirected, _ := url.Parse(context.RedirectURI)
	query := redirected.Query()
	query.Set("code", code)
	query.Set("state", context.State)
	redirected.RawQuery = query.Encode()
	return &AuthorizeResult{
		Code:       code,
		RedirectTo: redirected.String(),
		ExpiresAt:  expiresAt,
	}, nil
}

func (p *Provider) ConsumeAuthorizationCode(ctx context.Context, req TokenRequest) (*AuthorizationCodeRecord, error) {
	if strings.TrimSpace(req.GrantType) != "authorization_code" || strings.TrimSpace(req.Code) == "" || strings.TrimSpace(req.ClientID) == "" || strings.TrimSpace(req.RedirectURI) == "" {
		return nil, ErrInvalidRequest
	}
	if !codeVerifierPattern.MatchString(req.CodeVerifier) {
		return nil, ErrInvalidRequest
	}
	return p.codeStore.ConsumeAuthorizationCode(ctx, ConsumeAuthorizationCodeInput{
		Code:        req.Code,
		ClientID:    req.ClientID,
		RedirectURI: req.RedirectURI,
		Verifier:    req.CodeVerifier,
		Now:         p.now().UTC(),
	})
}

func (p *Provider) BuildTokenResponse(record *AuthorizationCodeRecord, user TokenUser) (*TokenResponse, error) {
	if record == nil || strings.TrimSpace(user.ID) == "" {
		return nil, ErrInvalidGrant
	}
	now := p.now().UTC()
	idToken, err := p.signJWT(map[string]any{
		"iss":   p.issuer,
		"sub":   user.ID,
		"aud":   record.ClientID,
		"iat":   now.Unix(),
		"exp":   now.Add(p.idTokenTTL).Unix(),
		"nonce": record.Nonce,
		"name":  user.Name,
	}, user.Email)
	if err != nil {
		return nil, err
	}
	accessAudience := p.accessTokenAudience
	if accessAudience == "" {
		accessAudience = record.ClientID
	}
	accessToken, err := p.signJWT(map[string]any{
		"iss":   p.issuer,
		"sub":   user.ID,
		"aud":   accessAudience,
		"iat":   now.Unix(),
		"exp":   now.Add(p.accessTokenTTL).Unix(),
		"scope": record.Scope,
	}, "")
	if err != nil {
		return nil, err
	}
	return &TokenResponse{
		AccessToken: accessToken,
		TokenType:   "Bearer",
		ExpiresIn:   int(p.accessTokenTTL.Seconds()),
		Scope:       record.Scope,
		IDToken:     idToken,
	}, nil
}

func (p *Provider) signJWT(claims map[string]any, email string) (string, error) {
	headerJSON, err := json.Marshal(map[string]string{
		"alg": "EdDSA",
		"kid": p.signingKeyID,
		"typ": "JWT",
	})
	if err != nil {
		return "", fmt.Errorf("marshal jwt header: %w", err)
	}
	if email != "" {
		claims["email"] = email
	}
	payloadJSON, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("marshal jwt payload: %w", err)
	}
	headerPart := base64.RawURLEncoding.EncodeToString(headerJSON)
	payloadPart := base64.RawURLEncoding.EncodeToString(payloadJSON)
	signingInput := headerPart + "." + payloadPart
	signature := ed25519.Sign(p.signingKey, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (p *Provider) newCode() (string, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(p.random, raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
