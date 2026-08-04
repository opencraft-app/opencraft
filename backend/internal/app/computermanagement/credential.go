package computermanagement

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	computerport "chatserver/internal/ports/computer"
	idport "chatserver/internal/ports/id"
)

type CredentialConfig struct {
	DerivationKey []byte
	CredentialTTL time.Duration
	HandoffTTL    time.Duration
	RotationGrace time.Duration
}

type RuntimeCredential struct {
	ID             string
	Version        uint64
	Secret         string
	ExpiresAt      time.Time
	GraceExpiresAt *time.Time
}

type CredentialService struct {
	repository computerport.CredentialRepository
	ids        idport.Generator
	clock      clockport.Clock
	config     CredentialConfig
}

func NewCredentialService(
	repository computerport.CredentialRepository,
	ids idport.Generator,
	clock clockport.Clock,
	config CredentialConfig,
) (*CredentialService, error) {
	if config.RotationGrace == 0 {
		config.RotationGrace = time.Hour
	}
	if repository == nil || ids == nil || clock == nil ||
		len(config.DerivationKey) < 32 || config.CredentialTTL <= 0 ||
		config.HandoffTTL <= 0 || config.HandoffTTL > 24*time.Hour ||
		config.RotationGrace != time.Hour {
		return nil, errors.New("Computer Runtime Credential 服务配置无效")
	}
	config.DerivationKey = append([]byte(nil), config.DerivationKey...)
	return &CredentialService{repository: repository, ids: ids, clock: clock, config: config}, nil
}

// Rotate issues the next credential version while preserving the authenticated
// version for a fixed 60-minute reconnect grace. A replay with the same
// idempotency key derives the same secret without storing plaintext.
func (service *CredentialService) Rotate(
	ctx context.Context,
	serverID string,
	computerID string,
	currentVersion uint64,
	idempotencyKey string,
) (RuntimeCredential, error) {
	if !validUUIDv7(serverID) || !validUUIDv7(computerID) ||
		currentVersion == 0 || currentVersion > math.MaxInt64 ||
		strings.TrimSpace(idempotencyKey) == "" {
		return RuntimeCredential{}, apperror.New(
			"invalid_request", "Computer Runtime Credential 轮换参数无效", nil,
		)
	}
	credentialID, err := service.ids.New()
	if err != nil || !validUUIDv7(credentialID) {
		return RuntimeCredential{}, apperror.New(
			"internal_error", "暂时无法轮换 Computer credential", err,
		)
	}
	secretPart := service.deriveSecretPart(credentialID)
	digest := sha256.Sum256([]byte(secretPart))
	now := service.clock.Now().UTC()
	requestHash := sha256.Sum256([]byte(
		"rotate:" + strconv.FormatUint(currentVersion, 10),
	))
	stored, err := service.repository.RotateCredential(
		ctx,
		computerport.CredentialRotationCommand{
			ServerID: serverID, ComputerID: computerID,
			CurrentVersion: currentVersion, CredentialID: credentialID,
			SecretHash: digest, IdempotencyKey: idempotencyKey,
			RequestHash:      requestHash,
			ExpiresAt:        now.Add(service.config.CredentialTTL),
			GraceExpiresAt:   now.Add(service.config.RotationGrace),
			HandoffExpiresAt: now.Add(service.config.HandoffTTL),
			CreatedAt:        now,
		},
	)
	switch {
	case errors.Is(err, computerport.ErrCredentialNotCurrent):
		return RuntimeCredential{}, apperror.New(
			"computer_credential_revoked", "Computer credential 已失效", err,
		)
	case err != nil:
		return RuntimeCredential{}, mapRepositoryError(err)
	}
	if !validUUIDv7(stored.ID) || stored.ServerID != serverID ||
		stored.ComputerID != computerID || stored.Version <= currentVersion ||
		!stored.ExpiresAt.After(now) {
		return RuntimeCredential{}, apperror.New(
			"internal_error", "Computer Runtime Credential 数据无效", nil,
		)
	}
	secretPart = service.deriveSecretPart(stored.ID)
	secret := "crc_" + serverID + "." + computerID + "." +
		strconv.FormatUint(stored.Version, 10) + "." + secretPart
	return RuntimeCredential{
		ID: stored.ID, Version: stored.Version, Secret: secret,
		ExpiresAt: stored.ExpiresAt.UTC(), GraceExpiresAt: stored.GraceExpiresAt,
	}, nil
}

// Issue derives 32-byte credential material from a deployment key and a
// UUIDv7 credential ID. The database stores only SHA-256(secretPart); replay
// inside the handoff window re-derives the same secret without storing it.
func (service *CredentialService) Issue(
	ctx context.Context,
	accountID string,
	serverID string,
	computerID string,
	mode string,
	idempotencyKey string,
) (RuntimeCredential, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) ||
		!validUUIDv7(computerID) ||
		(mode != "bootstrap" && mode != "recover") ||
		strings.TrimSpace(idempotencyKey) == "" {
		return RuntimeCredential{}, apperror.New(
			"invalid_request", "Computer Runtime Credential 参数无效", nil,
		)
	}
	credentialID, err := service.ids.New()
	if err != nil || !validUUIDv7(credentialID) {
		return RuntimeCredential{}, apperror.New(
			"internal_error", "暂时无法创建 Computer credential", err,
		)
	}
	secretPart := service.deriveSecretPart(credentialID)
	digest := sha256.Sum256([]byte(secretPart))
	now := service.clock.Now().UTC()
	stored, err := service.repository.IssueCredential(ctx, computerport.CredentialCommand{
		AccountID: accountID, ServerID: serverID, ComputerID: computerID,
		Mode: mode, CredentialID: credentialID, SecretHash: digest,
		IdempotencyKey:   idempotencyKey,
		RequestHash:      sha256.Sum256([]byte(mode)),
		ExpiresAt:        now.Add(service.config.CredentialTTL),
		HandoffExpiresAt: now.Add(service.config.HandoffTTL),
		CreatedAt:        now,
	})
	switch {
	case errors.Is(err, computerport.ErrCredentialExists):
		return RuntimeCredential{}, apperror.New(
			"computer_credential_exists", "Computer Runtime Credential 已存在", err,
		)
	case err != nil:
		return RuntimeCredential{}, mapRepositoryError(err)
	}
	if !validUUIDv7(stored.ID) || stored.ServerID != serverID ||
		stored.ComputerID != computerID || stored.Version == 0 ||
		!stored.ExpiresAt.After(now) {
		return RuntimeCredential{}, apperror.New(
			"internal_error", "Computer Runtime Credential 数据无效", nil,
		)
	}
	secretPart = service.deriveSecretPart(stored.ID)
	secret := "crc_" + serverID + "." + computerID + "." +
		strconv.FormatUint(stored.Version, 10) + "." + secretPart
	return RuntimeCredential{
		ID: stored.ID, Version: stored.Version, Secret: secret,
		ExpiresAt: stored.ExpiresAt.UTC(), GraceExpiresAt: stored.GraceExpiresAt,
	}, nil
}

func (service *CredentialService) deriveSecretPart(credentialID string) string {
	mac := hmac.New(sha256.New, service.config.DerivationKey)
	_, _ = mac.Write([]byte("chatserver-computer-credential-v1\x00"))
	_, _ = mac.Write([]byte(credentialID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
