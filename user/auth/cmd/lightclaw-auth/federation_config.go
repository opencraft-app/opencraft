package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/federation"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/httpapi"
)

type federationClientEnvironment struct {
	ID                string                    `json:"id"`
	DisplayName       string                    `json:"display_name"`
	CallbackPath      string                    `json:"callback_path"`
	CallbackHosts     []federation.CallbackHost `json:"callback_hosts"`
	ExactCallbackURLs []string                  `json:"exact_callback_urls"`
	HMACKeys          map[string]string         `json:"hmac_keys"`
}

func buildFederationConfig(logger *slog.Logger) *httpapi.FederationConfig {
	if !boolEnvOrDefault("LIGHTCLAW_FEDERATION_ENABLED", false) {
		return nil
	}
	environment := strings.TrimSpace(os.Getenv("LIGHTCLAW_FEDERATION_ENVIRONMENT"))
	activeKeyID := strings.TrimSpace(os.Getenv("LIGHTCLAW_FEDERATION_ACTIVE_AEAD_KEY_ID"))
	aeadKeys, err := decodeFederationKeyMap(os.Getenv("LIGHTCLAW_FEDERATION_AEAD_KEYS_JSON"))
	if err != nil {
		logger.Warn("federation disabled due to invalid AEAD keyring", "err", err)
		return nil
	}
	nonceKey, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("LIGHTCLAW_FEDERATION_NONCE_KEY")))
	if err != nil || len(nonceKey) < 32 {
		logger.Warn("federation disabled due to invalid nonce derivation key")
		return nil
	}
	codec, err := federation.NewCodec(federation.CodecConfig{
		Environment: environment,
		ActiveKeyID: activeKeyID,
		Keys:        aeadKeys,
		NonceKey:    nonceKey,
	})
	if err != nil {
		logger.Warn("federation disabled due to invalid token codec", "err", err)
		return nil
	}
	clients, err := decodeFederationClients(os.Getenv("LIGHTCLAW_FEDERATION_CLIENTS_JSON"))
	if err != nil {
		logger.Warn("federation disabled due to invalid client registry", "err", err)
		return nil
	}
	registry, err := federation.NewRegistry(clients)
	if err != nil {
		logger.Warn("federation disabled due to invalid client registry", "err", err)
		return nil
	}
	tatTimeout := time.Duration(envInt64OrDefault("LIGHTCLAW_FEDERATION_TAT_TIMEOUT_SECONDS", 5)) * time.Second
	if tatTimeout <= 0 || tatTimeout > 5*time.Second {
		logger.Warn("federation disabled due to invalid TAT timeout")
		return nil
	}
	tatClient, err := federation.NewTATClient(federation.TATClientConfig{
		BaseURL:       strings.TrimSpace(os.Getenv("LIGHTCLAW_FEDERATION_CTL_BASE_URL")),
		InternalToken: strings.TrimSpace(os.Getenv("LIGHTCLAW_FEDERATION_CTL_INTERNAL_TOKEN")),
		Timeout:       tatTimeout,
	})
	if err != nil {
		logger.Warn("federation disabled due to invalid service-gateway configuration", "err", err)
		return nil
	}
	delegatedTTL := time.Duration(envInt64OrDefault("LIGHTCLAW_FEDERATION_DELEGATED_SESSION_TTL_SECONDS", 8*60*60)) * time.Second
	if delegatedTTL <= 0 {
		logger.Warn("federation disabled due to invalid delegated session lifetime")
		return nil
	}
	logger.Info("federation enabled", "environment", environment, "active_key_id", activeKeyID, "client_count", len(clients))
	return &httpapi.FederationConfig{
		Registry:            registry,
		Codec:               codec,
		Verifier:            federation.NewVerifier(registry, 5*time.Second),
		TATClient:           tatClient,
		HandoffTTL:          5 * time.Second,
		DelegatedSessionTTL: delegatedTTL,
	}
}

func decodeFederationKeyMap(raw string) (map[string][]byte, error) {
	encoded := map[string]string{}
	if strings.TrimSpace(raw) == "" || json.Unmarshal([]byte(raw), &encoded) != nil || len(encoded) == 0 {
		return nil, fmt.Errorf("keyring must be a non-empty JSON object")
	}
	keys := make(map[string][]byte, len(encoded))
	for keyID, value := range encoded {
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("decode key %q", keyID)
		}
		keys[keyID] = key
	}
	return keys, nil
}

func decodeFederationClients(raw string) ([]federation.Client, error) {
	var encoded []federationClientEnvironment
	if strings.TrimSpace(raw) == "" || json.Unmarshal([]byte(raw), &encoded) != nil || len(encoded) == 0 {
		return nil, fmt.Errorf("clients must be a non-empty JSON array")
	}
	clients := make([]federation.Client, 0, len(encoded))
	for _, item := range encoded {
		keys := make(map[string][]byte, len(item.HMACKeys))
		for keyID, value := range item.HMACKeys {
			key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
			if err != nil {
				return nil, fmt.Errorf("decode HMAC key %q for client %q", keyID, item.ID)
			}
			keys[keyID] = key
		}
		clients = append(clients, federation.Client{
			ID:                item.ID,
			DisplayName:       item.DisplayName,
			CallbackPath:      item.CallbackPath,
			CallbackHosts:     item.CallbackHosts,
			ExactCallbackURLs: item.ExactCallbackURLs,
			HMACKeys:          keys,
		})
	}
	return clients, nil
}
