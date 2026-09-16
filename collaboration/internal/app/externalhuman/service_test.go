package externalhuman

import (
	"context"
	"testing"
	"time"
)

const externalHumanAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"

type fakeRepository struct {
	input EnsureInput
}

func (repository *fakeRepository) ResolveOrCreate(
	_ context.Context,
	input EnsureInput,
) (string, error) {
	repository.input = input
	return input.ProposedAccountID, nil
}

type fixedID struct{}

func (fixedID) New() (string, error) { return externalHumanAccountID, nil }

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func TestServiceResolvesLightVelaSubjectThroughStableRegistryHash(t *testing.T) {
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	repository := &fakeRepository{}
	service, err := NewService(repository, fixedID{}, fixedClock{now: now})
	if err != nil {
		t.Fatal(err)
	}

	accountID, err := service.ResolveOrCreate(
		context.Background(),
		"  usr_0123456789abcdef01234567  ",
	)
	if err != nil {
		t.Fatal(err)
	}

	if accountID != externalHumanAccountID {
		t.Fatalf("accountID = %q", accountID)
	}
	if repository.input.Subject != "usr_0123456789abcdef01234567" ||
		repository.input.Kind != "lightvela" ||
		repository.input.ProposedAccountID != externalHumanAccountID ||
		repository.input.OccurredAt != now ||
		len(repository.input.SubjectHash) != 64 {
		t.Fatalf("ensure input = %#v", repository.input)
	}
}
