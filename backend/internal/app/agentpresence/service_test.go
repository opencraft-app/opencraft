package agentpresence

import (
	"context"
	"testing"
	"time"

	agentpresenceport "chatserver/internal/ports/agentpresence"
)

type presenceRepository struct {
	observation agentpresenceport.IMObservation
}

func (repository *presenceRepository) ApplyIMPresence(_ context.Context, value agentpresenceport.IMObservation) (bool, error) {
	repository.observation = value
	return true, nil
}

func TestService投影腾讯IM在线回调(t *testing.T) {
	repository := &presenceRepository{}
	service, err := NewService(repository)
	if err != nil {
		t.Fatal(err)
	}
	observedAt := time.Date(2026, 7, 31, 19, 0, 0, 0, time.UTC)
	if err := service.ObserveIMPresence(context.Background(), IMObservation{
		IMUserID: " a_TEST ", Presence: "online", ObservedAt: observedAt, Reason: " Register ",
	}); err != nil {
		t.Fatal(err)
	}
	if repository.observation.IMUserID != "a_TEST" || repository.observation.Reason != "Register" ||
		!repository.observation.ObservedAt.Equal(observedAt) {
		t.Fatalf("observation = %#v", repository.observation)
	}
}

func TestService拒绝非法在线事实(t *testing.T) {
	service, err := NewService(&presenceRepository{})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ObserveIMPresence(context.Background(), IMObservation{
		IMUserID: "a_TEST", Presence: "busy",
	}); err == nil {
		t.Fatal("ObserveIMPresence() 接受了未知 Presence")
	}
}

var _ agentpresenceport.Repository = (*presenceRepository)(nil)
