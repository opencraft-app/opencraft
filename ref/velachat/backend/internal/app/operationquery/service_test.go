package operationquery

import (
	"context"
	"testing"
	"time"

	operationport "chatserver/internal/ports/operation"
)

type fakeRepository struct {
	value operationport.Operation
}

func (repository *fakeRepository) Get(
	context.Context,
	string,
	string,
	string,
) (operationport.Operation, error) {
	return repository.value, nil
}

func TestServiceGetsAuthorizedOperation(t *testing.T) {
	value := operationport.Operation{
		ID:       "0198f4c2-7a37-7e45-913c-6baf30401a83",
		ServerID: "0198f4c2-7a31-7c91-a6d2-7d76f9188c38",
		Service:  "platform", Kind: "agent.start", State: "succeeded",
		CreatedAt: time.Date(2026, 7, 31, 1, 0, 0, 0, time.UTC),
	}
	service, err := NewService(&fakeRepository{value: value})
	if err != nil {
		t.Fatal(err)
	}
	got, err := service.Get(
		context.Background(),
		"0198f4c2-7a30-7c91-a6d2-7d76f9188c37",
		value.ServerID,
		value.ID,
	)
	if err != nil || got != value {
		t.Fatalf("Get() = (%#v, %v)", got, err)
	}
}
