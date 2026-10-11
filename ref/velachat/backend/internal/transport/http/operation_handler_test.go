package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	operationport "chatserver/internal/ports/operation"

	"github.com/google/uuid"
)

type fakeOperationService struct {
	value operationport.Operation
}

func (service *fakeOperationService) Get(
	context.Context,
	string,
	string,
	string,
) (operationport.Operation, error) {
	return service.value, nil
}

func TestOperationHandlerReturnsOperation(t *testing.T) {
	service := &fakeOperationService{value: operationport.Operation{
		ID: handlerOperationID, ServerID: handlerServerID,
		Service: "platform", Kind: "agent.start", State: "succeeded",
		CreatedAt: time.Date(2026, 7, 31, 1, 10, 0, 0, time.UTC),
	}}
	handler, err := NewOperationHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.GetOperation(
		currentHumanContext(t),
		openapi.GetOperationRequestObject{
			ServerId:    uuid.MustParse(handlerServerID),
			OperationId: uuid.MustParse(handlerOperationID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := response.(openapi.GetOperation200JSONResponse)
	if !ok || got.Id.String() != handlerOperationID ||
		got.Kind != "agent.start" {
		t.Fatalf("GetOperation() = %#v", response)
	}
}
