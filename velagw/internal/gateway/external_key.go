package gateway

import (
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"strings"
)

const (
	externalKeyVersionV2         = uint8(2)
	externalKeyRouteSlotBytes    = 4
	externalKeyIDBytes           = 32
	externalKeySecretBytes       = 32
	externalKeyRandomBytes       = externalKeyRouteSlotBytes + externalKeyIDBytes + externalKeySecretBytes
	externalKeyPayloadBytes      = 1 + externalKeyRandomBytes
	externalKeyPayloadTextLength = 92
	externalKeyTextLength        = len("sk-") + externalKeyPayloadTextLength
	externalKeyIDTextLength      = 48
)

type externalKeyMaterial struct {
	ExternalKey     string
	ExternalKeyHash string
	ExternalKeyID   string
	SecretHash      string
	Version         uint8
	RouteSlot       uint32
}

func generateExternalKeyV2(reader io.Reader) (externalKeyMaterial, error) {
	if reader == nil {
		reader = rand.Reader
	}
	randomBytes := make([]byte, externalKeyRandomBytes)
	if _, err := io.ReadFull(reader, randomBytes); err != nil {
		return externalKeyMaterial{}, fmt.Errorf("generate external key entropy: %w", err)
	}

	payload := make([]byte, externalKeyPayloadBytes)
	payload[0] = externalKeyVersionV2
	copy(payload[1:], randomBytes)
	externalKey := "sk-" + base64.RawURLEncoding.EncodeToString(payload)
	identity := payload[1 : 1+externalKeyRouteSlotBytes+externalKeyIDBytes]
	secret := payload[1+externalKeyRouteSlotBytes+externalKeyIDBytes:]
	return externalKeyMaterial{
		ExternalKey:     externalKey,
		ExternalKeyHash: hashExternalKey(externalKey),
		ExternalKeyID:   base64.RawURLEncoding.EncodeToString(identity),
		SecretHash:      hashExternalKeySecretBytes(secret),
		Version:         externalKeyVersionV2,
		RouteSlot:       binary.BigEndian.Uint32(randomBytes[:externalKeyRouteSlotBytes]),
	}, nil
}

func prepareAPIKeyReservation(binding APIKeyBinding) (APIKeyBinding, error) {
	binding.Purpose = canonicalAPIKeyPurpose(binding.Purpose)
	if err := validateStoredExternalKey(binding); err != nil {
		return APIKeyBinding{}, fmt.Errorf("external key reservation requires valid v2 material: %w", err)
	}
	binding.UpstreamKey = ""
	binding.UpstreamKeyID = 0
	binding.Status = APIKeyStatusReserved
	binding.LastError = ""
	return binding, nil
}

func validateStoredExternalKey(binding APIKeyBinding) error {
	lookup := parseTrafficRouteLookup(binding.ExternalKey)
	switch {
	case !lookup.Valid:
		return fmt.Errorf("external key is not valid v2 material")
	case lookup.ExternalKeyID != binding.ExternalKeyID:
		return fmt.Errorf("external key id does not match stored metadata")
	case lookup.ExternalKeyHash != binding.ExternalKeyHash:
		return fmt.Errorf("external key hash does not match stored metadata")
	case !equalExternalKeySecretHash(lookup.SecretHash, binding.SecretHash):
		return fmt.Errorf("external key secret hash does not match stored metadata")
	case lookup.Version != binding.KeyVersion:
		return fmt.Errorf("external key version does not match stored metadata")
	case lookup.RouteSlot != binding.RouteSlot:
		return fmt.Errorf("external key route slot does not match stored metadata")
	default:
		return nil
	}
}

func canonicalAPIKeyPurpose(purpose string) string {
	return strings.ToLower(strings.TrimSpace(purpose))
}

func parseTrafficRouteLookup(externalKey string) TrafficRouteLookup {
	externalKey = strings.TrimSpace(externalKey)
	if len(externalKey) != externalKeyTextLength || !strings.HasPrefix(externalKey, "sk-") {
		return TrafficRouteLookup{}
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(externalKey, "sk-"))
	if err != nil || len(payload) != externalKeyPayloadBytes || payload[0] != externalKeyVersionV2 {
		return TrafficRouteLookup{}
	}
	identityEnd := 1 + externalKeyRouteSlotBytes + externalKeyIDBytes
	return TrafficRouteLookup{
		Valid:           true,
		Version:         payload[0],
		RouteSlot:       binary.BigEndian.Uint32(payload[1 : 1+externalKeyRouteSlotBytes]),
		ExternalKeyID:   base64.RawURLEncoding.EncodeToString(payload[1:identityEnd]),
		SecretHash:      hashExternalKeySecretBytes(payload[identityEnd:]),
		ExternalKeyHash: hashExternalKey(externalKey),
	}
}

func hashExternalKeySecretBytes(secret []byte) string {
	return hashExternalKey("llmgateway-key-secret:" + base64.RawURLEncoding.EncodeToString(secret))
}

func equalExternalKeySecretHash(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	return hmac.Equal([]byte(left), []byte(right))
}

func routeSlotTag(routeSlot uint32) string {
	return fmt.Sprintf("kr-%08x", routeSlot)
}
