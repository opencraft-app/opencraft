package computerv2

import (
	"context"
	"errors"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	computerv2port "git.woa.com/wisp/mono2/collaboration/internal/ports/computerv2"
)

type fakeRepository struct {
	attached computerv2port.AttachCommand
	result   computerv2port.Computer
	page     computerv2port.Page
	err      error
}

func (repository *fakeRepository) Attach(
	_ context.Context,
	command computerv2port.AttachCommand,
) (computerv2port.Computer, error) {
	repository.attached = command
	return repository.result, repository.err
}

func (repository *fakeRepository) List(
	_ context.Context,
	_ string,
	_ string,
	_ computerv2port.ListOptions,
) (computerv2port.Page, error) {
	return repository.page, repository.err
}

type fakeDirectory struct {
	instances []computerv2port.Instance
	err       error
}

func (directory fakeDirectory) ListOwned(
	context.Context,
	string,
) ([]computerv2port.Instance, error) {
	return directory.instances, directory.err
}

type fixedIDs struct{ id string }

func (generator fixedIDs) New() (string, error) { return generator.id, nil }

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func TestAttachSelectsAnExistingOwnedLightVelaInstance(t *testing.T) {
	now := time.Date(2026, 9, 14, 14, 0, 0, 0, time.UTC)
	repository := &fakeRepository{result: computerv2port.Computer{
		ID:             "0199f95e-1900-7000-8000-000000000004",
		ServerID:       "0199f95e-1900-7000-8000-000000000002",
		Kind:           "lightvela_instance",
		InstanceID:     "instance-1",
		Name:           "Build Mac",
		LifecycleState: "active",
		Revision:       1,
		CreatedAt:      now,
	}}
	service, err := NewService(
		repository,
		fakeDirectory{instances: []computerv2port.Instance{{
			ID: "instance-1", Name: "Build Mac", Status: "paused",
		}}},
		fixedIDs{id: "0199f95e-1900-7000-8000-000000000004"},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}

	computer, err := service.Attach(context.Background(), AttachCommand{
		AccountID:       "0199f95e-1900-7000-8000-000000000001",
		ExternalSubject: "usr_0123456789abcdef01234567",
		ServerID:        "0199f95e-1900-7000-8000-000000000002",
		InstanceID:      "instance-1",
		IdempotencyKey:  "computer-v2-attach-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if computer.ObservedState != "paused" || computer.Name != "Build Mac" {
		t.Fatalf("computer = %#v", computer)
	}
	if repository.attached.Computer.Kind != "lightvela_instance" ||
		repository.attached.Computer.InstanceID != "instance-1" ||
		repository.attached.Computer.Name != "Build Mac" ||
		repository.attached.Computer.LifecycleState != "active" {
		t.Fatalf("attach command = %#v", repository.attached)
	}
}

func TestAttachRejectsAnInstanceOutsideTheCurrentLightVelaAccount(t *testing.T) {
	service, err := NewService(
		&fakeRepository{},
		fakeDirectory{instances: nil},
		fixedIDs{id: "0199f95e-1900-7000-8000-000000000004"},
		fixedClock{now: time.Now()},
	)
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.Attach(context.Background(), AttachCommand{
		AccountID:       "0199f95e-1900-7000-8000-000000000001",
		ExternalSubject: "usr_0123456789abcdef01234567",
		ServerID:        "0199f95e-1900-7000-8000-000000000002",
		InstanceID:      "instance-other",
		IdempotencyKey:  "computer-v2-attach-2",
	})
	var applicationError *apperror.Error
	if !errors.As(err, &applicationError) || applicationError.Code() != "computer_instance_not_owned" {
		t.Fatalf("Attach() error = %#v", err)
	}
}

func TestListBindsCursorToAccountServerAndKind(t *testing.T) {
	repository := &fakeRepository{page: computerv2port.Page{
		Items:      []computerv2port.Computer{{ID: "0199f95e-1900-7000-8000-000000000004"}},
		NextCursor: "0199f95e-1900-7000-8000-000000000004",
	}}
	service, err := NewService(repository, fakeDirectory{}, fixedIDs{}, fixedClock{})
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.List(context.Background(),
		"0199f95e-1900-7000-8000-000000000001",
		"0199f95e-1900-7000-8000-000000000002",
		ListOptions{Limit: 1},
	)
	if err != nil || first.NextCursor == "" {
		t.Fatalf("List() = (%#v, %v)", first, err)
	}
	_, err = service.List(context.Background(),
		"0199f95e-1900-7000-8000-000000000001",
		"0199f95e-1900-7000-8000-000000000003",
		ListOptions{Limit: 1, Cursor: first.NextCursor},
	)
	var applicationError *apperror.Error
	if !errors.As(err, &applicationError) || applicationError.Code() != "invalid_cursor" {
		t.Fatalf("List(cursor rebound) error = %#v", err)
	}
}
