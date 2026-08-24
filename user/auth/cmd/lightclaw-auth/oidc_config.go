package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/httpapi"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/oidc"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

type oidcClientEnvironment struct {
	ID           string   `json:"id"`
	DisplayName  string   `json:"display_name"`
	RedirectURIs []string `json:"redirect_uris"`
}

func buildOIDCConfig(logger *slog.Logger, authStore service.Store) *httpapi.OIDCConfig {
	if !boolEnvOrDefault("LIGHTCLAW_OIDC_ENABLED", false) {
		return nil
	}
	mysqlStore, ok := authStore.(*service.MySQLStore)
	if !ok || mysqlStore.DB() == nil {
		logger.Warn("oidc disabled because persistent mysql code storage is unavailable")
		return nil
	}
	return buildOIDCConfigWithCodeStore(logger, oidc.NewMySQLCodeStore(mysqlStore.DB()))
}

func buildOIDCConfigWithCodeStore(logger *slog.Logger, codeStore oidc.CodeStore) *httpapi.OIDCConfig {
	if !boolEnvOrDefault("LIGHTCLAW_OIDC_ENABLED", false) {
		return nil
	}
	if codeStore == nil {
		logger.Warn("oidc disabled because authorization code storage is unavailable")
		return nil
	}
	issuer := strings.TrimSpace(os.Getenv("LIGHTCLAW_OIDC_ISSUER"))
	signingKeyID := strings.TrimSpace(os.Getenv("LIGHTCLAW_OIDC_SIGNING_KEY_ID"))
	if issuer == "" || signingKeyID == "" {
		logger.Warn("oidc disabled due to incomplete issuer or signing key id")
		return nil
	}
	normalizedIssuer, err := validateOIDCIssuer(issuer)
	if err != nil {
		logger.Warn("oidc disabled due to invalid issuer", "err", err)
		return nil
	}
	signingKeys, err := decodeOIDCSigningKeys(os.Getenv("LIGHTCLAW_OIDC_SIGNING_KEYS_JSON"))
	if err != nil {
		logger.Warn("oidc disabled due to invalid signing keyring", "err", err)
		return nil
	}
	signingKey, ok := signingKeys[signingKeyID]
	if !ok {
		logger.Warn("oidc disabled due to missing active signing key", "kid", signingKeyID)
		return nil
	}
	clients, err := decodeOIDCClients(os.Getenv("LIGHTCLAW_OIDC_CLIENTS_JSON"))
	if err != nil {
		logger.Warn("oidc disabled due to invalid client registry", "err", err)
		return nil
	}
	if err := validateSiteGatewayOIDCClients(clients); err != nil {
		logger.Warn("oidc disabled due to invalid site-gateway registry", "err", err)
		return nil
	}
	registry, err := oidc.NewRegistry(clients)
	if err != nil {
		logger.Warn("oidc disabled due to invalid client registry", "err", err)
		return nil
	}
	codeTTLSeconds := envInt64OrDefault("LIGHTCLAW_OIDC_AUTHORIZATION_CODE_TTL_SECONDS", 5)
	if codeTTLSeconds != 5 {
		logger.Warn("oidc disabled due to invalid authorization code ttl", "seconds", codeTTLSeconds)
		return nil
	}
	logger.Info("oidc enabled", "issuer", normalizedIssuer, "signing_key_id", signingKeyID, "client_count", len(clients))
	return &httpapi.OIDCConfig{
		Provider: oidc.NewProvider(oidc.ProviderConfig{
			Issuer:              normalizedIssuer,
			AuthorizationPath:   "/oauth2/authorize",
			TokenPath:           "/oauth2/token",
			JWKSPath:            "/.well-known/jwks.json",
			Registry:            registry,
			CodeStore:           codeStore,
			SigningKeyID:        signingKeyID,
			SigningKey:          signingKey,
			AccessTokenAudience: strings.TrimSpace(os.Getenv("LIGHTCLAW_OIDC_ACCESS_TOKEN_AUDIENCE")),
			IDTokenTTL:          time.Duration(envInt64OrDefault("LIGHTCLAW_OIDC_ID_TOKEN_TTL_SECONDS", 300)) * time.Second,
			AccessTokenTTL:      time.Duration(envInt64OrDefault("LIGHTCLAW_OIDC_ACCESS_TOKEN_TTL_SECONDS", 300)) * time.Second,
			CodeTTL:             5 * time.Second,
		}),
	}
}

func decodeOIDCSigningKeys(raw string) (map[string]ed25519.PrivateKey, error) {
	encoded := map[string]string{}
	if strings.TrimSpace(raw) == "" || json.Unmarshal([]byte(raw), &encoded) != nil || len(encoded) == 0 {
		return nil, fmt.Errorf("signing keyring must be a non-empty JSON object")
	}
	keys := make(map[string]ed25519.PrivateKey, len(encoded))
	for keyID, value := range encoded {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("decode signing key %q: %w", keyID, err)
		}
		switch len(decoded) {
		case ed25519.SeedSize:
			keys[keyID] = ed25519.NewKeyFromSeed(decoded)
		case ed25519.PrivateKeySize:
			keys[keyID] = ed25519.PrivateKey(decoded)
		default:
			return nil, fmt.Errorf("signing key %q must be %d-byte seed or %d-byte private key", keyID, ed25519.SeedSize, ed25519.PrivateKeySize)
		}
	}
	return keys, nil
}

func decodeOIDCClients(raw string) ([]oidc.Client, error) {
	var encoded []oidcClientEnvironment
	if strings.TrimSpace(raw) == "" || json.Unmarshal([]byte(raw), &encoded) != nil || len(encoded) == 0 {
		return nil, fmt.Errorf("clients must be a non-empty JSON array")
	}
	clients := make([]oidc.Client, 0, len(encoded))
	for _, item := range encoded {
		clients = append(clients, oidc.Client{
			ID:           item.ID,
			DisplayName:  item.DisplayName,
			RedirectURIs: item.RedirectURIs,
		})
	}
	return clients, nil
}

func validateSiteGatewayOIDCClients(clients []oidc.Client) error {
	expectedRedirects := []string{
		"https://sites-auth.lightvela.site/auth/lightvela/callback",
		"https://sites-auth.lightvela.tech/auth/lightvela/callback",
	}
	if len(clients) != 1 {
		return fmt.Errorf("expected exactly one oidc client, got %d", len(clients))
	}
	client := clients[0]
	if strings.TrimSpace(client.ID) != "site-gateway" {
		return fmt.Errorf("expected oidc client id site-gateway, got %q", client.ID)
	}
	if len(client.RedirectURIs) != 2 {
		return fmt.Errorf("expected exactly two redirect uris, got %d", len(client.RedirectURIs))
	}
	got := append([]string(nil), client.RedirectURIs...)
	slices.Sort(got)
	slices.Sort(expectedRedirects)
	for i := range expectedRedirects {
		if got[i] != expectedRedirects[i] {
			return fmt.Errorf("unexpected redirect uri %q", got[i])
		}
	}
	return nil
}

func validateOIDCIssuer(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("parse issuer: %w", err)
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" {
		return "", fmt.Errorf("issuer must be an absolute https URL without userinfo/query/fragment")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}
