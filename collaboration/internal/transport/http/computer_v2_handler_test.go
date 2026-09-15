package httptransport

import (
	"context"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/api/openapi"
	appcomputerv2 "git.woa.com/wisp/mono2/collaboration/internal/app/computerv2"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
	computerv2port "git.woa.com/wisp/mono2/collaboration/internal/ports/computerv2"
	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

type fakeComputerV2Service struct {
	attach appcomputerv2.AttachCommand
	list   appcomputerv2.ListOptions
	page   computerv2port.Page
	result computerv2port.Computer
}

func (service *fakeComputerV2Service) Attach(_ context.Context, command appcomputerv2.AttachCommand) (computerv2port.Computer, error) {
	service.attach = command
	return service.result, nil
}

func (service *fakeComputerV2Service) List(_ context.Context, _, _ string, options appcomputerv2.ListOptions) (computerv2port.Page, error) {
	service.list = options
	return service.page, nil
}

func TestComputerV2HandlerUsesGatewaySubjectAndMapsPage(t *testing.T) {
	now := time.Date(2026, 9, 14, 14, 0, 0, 0, time.UTC)
	value := computerv2port.Computer{
		ID: "0199f95e-1900-7000-8000-000000000004", ServerID: "0199f95e-1900-7000-8000-000000000002",
		Kind: "lightvela_instance", InstanceID: "instance-1", Name: "Build Mac",
		LifecycleState: "active", ObservedState: "paused", Revision: 1, CreatedAt: now,
	}
	service := &fakeComputerV2Service{result: value, page: computerv2port.Page{Items: []computerv2port.Computer{value}, NextCursor: "next"}}
	handler, err := NewComputerV2Handler(service)
	if err != nil {
		t.Fatal(err)
	}
	ctx := currentGatewayHumanContext(t)
	serverID := openapi_types.UUID(uuid.MustParse(value.ServerID))
	name := "Renamed"
	created, err := handler.CreateComputerV2(ctx, openapi.CreateComputerV2RequestObject{
		ServerId: serverID,
		Params:   openapi.CreateComputerV2Params{IdempotencyKey: "attach-one"},
		Body:     &openapi.CreateComputerV2Request{Kind: "lightvela_instance", InstanceId: "instance-1", Name: &name},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := created.(openapi.CreateComputerV2201JSONResponse)
	if response.Body.InstanceId != "instance-1" || response.Headers.XResourceRevision != 1 ||
		service.attach.ExternalSubject != "usr_0123456789abcdef01234567" || service.attach.Name != name {
		t.Fatalf("CreateComputerV2 = (%#v, %#v)", response, service.attach)
	}
	limit := openapi.Limit(20)
	listed, err := handler.ListComputersV2(ctx, openapi.ListComputersV2RequestObject{
		ServerId: serverID, Params: openapi.ListComputersV2Params{Limit: &limit},
	})
	if err != nil {
		t.Fatal(err)
	}
	page := listed.(openapi.ListComputersV2200JSONResponse)
	if len(page.Items) != 1 || page.NextCursor == nil || *page.NextCursor != "next" || service.list.Limit != 20 {
		t.Fatalf("ListComputersV2 = (%#v, %#v)", page, service.list)
	}
}

func currentGatewayHumanContext(t *testing.T) context.Context {
	t.Helper()
	principal, err := authnport.NewCurrentGatewayHumanPrincipal(
		"0199f95e-1900-7000-8000-000000000001",
		"usr_0123456789abcdef01234567",
	)
	if err != nil {
		t.Fatal(err)
	}
	state := &AuthState{}
	if err := state.setPrincipal(principal); err != nil {
		t.Fatal(err)
	}
	return context.WithValue(context.Background(), authStateContextKey{}, state)
}
