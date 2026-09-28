package devroute

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

const developerCapabilityPrefix = "lvdt1"

var ErrInvalidCapability = errors.New("invalid or expired personal DevCloud capability")

// CapabilityVerifier validates the one-time-returned capability against the
// durable testing registration. Only the digest is stored, so disabling,
// expiring, or renewing the registration revokes the previous capability.
type CapabilityVerifier struct {
	Registry Registry
	Now      func() time.Time
}

func (v CapabilityVerifier) Verify(ctx context.Context, token string) (StoredRegistration, error) {
	if v.Registry == nil {
		return StoredRegistration{}, ErrInvalidCapability
	}
	uin, ok := capabilityUIN(token)
	if !ok {
		return StoredRegistration{}, ErrInvalidCapability
	}
	registration, err := v.Registry.Get(ctx, uin)
	if err != nil {
		return StoredRegistration{}, ErrInvalidCapability
	}
	now := time.Now().UTC()
	if v.Now != nil {
		now = v.Now().UTC()
	}
	if registration.DisabledAt != nil || registration.TTLSeconds <= 0 || registration.RenewedAt.IsZero() ||
		!now.Before(registration.RenewedAt.UTC().Add(time.Duration(registration.TTLSeconds)*time.Second)) ||
		strings.TrimSpace(registration.DeliveryMode) != "devtunnel" ||
		!capabilityMatchesDigest(token, registration.TunnelTokenHash) {
		return StoredRegistration{}, ErrInvalidCapability
	}
	return registration, nil
}

func capabilityUIN(token string) (string, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != developerCapabilityPrefix {
		return "", false
	}
	value, err := strconv.ParseUint(parts[1], 10, 64)
	if err != nil || value == 0 || strconv.FormatUint(value, 10) != parts[1] {
		return "", false
	}
	random, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(random) != 32 {
		return "", false
	}
	return parts[1], true
}

func capabilityMatchesDigest(token, expected string) bool {
	expectedBytes, err := hex.DecodeString(strings.TrimSpace(expected))
	if err != nil || len(expectedBytes) != sha256.Size {
		return false
	}
	actual := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return subtle.ConstantTimeCompare(actual[:], expectedBytes) == 1
}
