// Package externalhuman maps LightVela identity authority into a local
// collaboration actor without creating a second login session.
package externalhuman

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
	idport "git.woa.com/wisp/mono2/collaboration/internal/ports/id"
)

const LightVelaIdentityKind = "lightvela"

type EnsureInput struct {
	Kind              string
	Subject           string
	SubjectHash       string
	ProposedAccountID string
	OccurredAt        time.Time
}

type Repository interface {
	ResolveOrCreate(context.Context, EnsureInput) (string, error)
}

type Service struct {
	repository Repository
	ids        idport.Generator
	clock      clockport.Clock
}

func NewService(
	repository Repository,
	ids idport.Generator,
	clock clockport.Clock,
) (*Service, error) {
	if repository == nil || ids == nil || clock == nil {
		return nil, errors.New("LightVela Human 映射服务配置无效")
	}
	return &Service{repository: repository, ids: ids, clock: clock}, nil
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
