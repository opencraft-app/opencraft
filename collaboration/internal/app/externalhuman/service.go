// Package externalhuman maps LightVela identity authority into a local
// collaboration actor without creating a second login session.
package externalhuman

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"

	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
	idport "git.woa.com/wisp/mono2/collaboration/internal/ports/id"
)

const LightVelaIdentityKind = "lightvela"

var provisioningEpochPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

type EnsureInput struct {
	Kind              string
	Subject           string
	SubjectHash       string
	ProposedAccountID string
	ProvisioningEpoch string
	OccurredAt        time.Time
}

type Config struct {
	ProvisioningEpoch string
}

type Repository interface {
	ResolveOrCreate(context.Context, EnsureInput) (string, error)
}

type Service struct {
	repository Repository
	ids        idport.Generator
	clock      clockport.Clock
	config     Config
}

func NewService(
	repository Repository,
	ids idport.Generator,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || ids == nil || clock == nil ||
		!provisioningEpochPattern.MatchString(config.ProvisioningEpoch) {
		return nil, errors.New("LightVela Human 映射服务配置无效")
	}
	return &Service{repository: repository, ids: ids, clock: clock, config: config}, nil
}

func (service *Service) ResolveOrCreate(
	ctx context.Context,
	subject string,
) (string, error) {
	subject = strings.TrimSpace(subject)
	if !validSubject(subject) {
		return "", errors.New("LightVela subject 无效")
	}
	accountID, err := service.ids.New()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(LightVelaIdentityKind + "\x00" + subject))
	return service.repository.ResolveOrCreate(ctx, EnsureInput{
		Kind:              LightVelaIdentityKind,
		Subject:           subject,
		SubjectHash:       hex.EncodeToString(digest[:]),
		ProposedAccountID: accountID,
		ProvisioningEpoch: service.config.ProvisioningEpoch,
		OccurredAt:        service.clock.Now().UTC(),
	})
}

func validSubject(value string) bool {
	if !strings.HasPrefix(value, "usr_") || len(value) <= len("usr_") || len(value) > 64 {
		return false
	}
	for _, character := range value[len("usr_"):] {
		if (character < 'a' || character > 'z') &&
			(character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' && character != '_' {
			return false
		}
	}
	return true
}
