package siteauth

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var (
	ErrInvalidIDToken       = errors.New("invalid id token")
	ErrOIDCProviderNotReady = errors.New("oidc provider unavailable")
)

type IDTokenVerifierConfig struct {
	Issuer     string
	ClientID   string
	JWKSURL    string
	HTTPClient *http.Client
	Clock      func() time.Time
}

type IDTokenVerifier struct {
	issuer     string
	clientID   string
	jwksURL    string
	httpClient *http.Client
	clock      func() time.Time
}

type Identity struct {
	Subject string
	Name    string
	Email   string
}

type idTokenClaims struct {
	Nonce string `json:"nonce"`
	Name  string `json:"name"`
	Email string `json:"email"`
	jwt.RegisteredClaims
}

func NewIDTokenVerifier(cfg IDTokenVerifierConfig) (*IDTokenVerifier, error) {
	if strings.TrimSpace(cfg.Issuer) == "" || strings.TrimSpace(cfg.ClientID) == "" || strings.TrimSpace(cfg.JWKSURL) == "" {
		return nil, ErrOIDCProviderNotReady
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	clock := cfg.Clock
	if clock == nil {
		clock = time.Now
	}
	return &IDTokenVerifier{
		issuer:     strings.TrimSpace(cfg.Issuer),
		clientID:   strings.TrimSpace(cfg.ClientID),
		jwksURL:    strings.TrimSpace(cfg.JWKSURL),
		httpClient: client,
		clock:      clock,
	}, nil
}

func (v *IDTokenVerifier) Verify(ctx context.Context, rawIDToken string, expectedNonce string) (*Identity, error) {
	if v == nil || strings.TrimSpace(rawIDToken) == "" || strings.TrimSpace(expectedNonce) == "" {
		return nil, ErrInvalidIDToken
	}
	keys, err := v.fetchJWKS(ctx)
	if err != nil {
		return nil, err
	}
	claims := &idTokenClaims{}
	token, err := jwt.ParseWithClaims(
		rawIDToken,
		claims,
		func(token *jwt.Token) (any, error) {
			if token.Method != jwt.SigningMethodEdDSA {
				return nil, ErrInvalidIDToken
			}
			kid, _ := token.Header["kid"].(string)
			if strings.TrimSpace(kid) == "" {
				return nil, ErrInvalidIDToken
			}
			key, ok := keys[kid]
			if !ok {
				return nil, ErrInvalidIDToken
			}
			return key, nil
		},
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.clientID),
		jwt.WithTimeFunc(v.clock),
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithIssuedAt(),
	)
	if err != nil || token == nil || !token.Valid {
		return nil, ErrInvalidIDToken
	}
	if claims.Subject == "" || claims.Nonce == "" || claims.Nonce != expectedNonce {
		return nil, ErrInvalidIDToken
	}
	return &Identity{
		Subject: claims.Subject,
		Name:    claims.Name,
		Email:   claims.Email,
	}, nil
}

func (v *IDTokenVerifier) fetchJWKS(ctx context.Context) (map[string]ed25519.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrOIDCProviderNotReady, err)
	}
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrOIDCProviderNotReady, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: jwks status %d", ErrOIDCProviderNotReady, resp.StatusCode)
	}
	var jwks struct {
		Keys []struct {
			KeyType string `json:"kty"`
			Curve   string `json:"crv"`
			Use     string `json:"use"`
			Alg     string `json:"alg"`
			KeyID   string `json:"kid"`
			X       string `json:"x"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return nil, fmt.Errorf("%w: decode jwks: %v", ErrOIDCProviderNotReady, err)
	}
	keys := make(map[string]ed25519.PublicKey, len(jwks.Keys))
	for _, key := range jwks.Keys {
		if key.KeyType != "OKP" || key.Curve != "Ed25519" || (key.Alg != "" && key.Alg != "EdDSA") || strings.TrimSpace(key.KeyID) == "" {
			continue
		}
		decoded, err := base64.RawURLEncoding.DecodeString(key.X)
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("%w: invalid jwk key %q", ErrOIDCProviderNotReady, key.KeyID)
		}
		keys[key.KeyID] = ed25519.PublicKey(decoded)
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("%w: no usable jwks keys", ErrOIDCProviderNotReady)
	}
	return keys, nil
}
