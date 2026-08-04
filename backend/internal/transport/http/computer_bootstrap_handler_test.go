package httptransport

import (
	"context"
	"testing"
	"time"

	bootstrapapi "chatserver/internal/api/computerbootstrap"
	appbootstrap "chatserver/internal/app/computerbootstrap"
	computerauthport "chatserver/internal/ports/computerauth"
)

type fakeProviderBootstrapService struct {
	result appbootstrap.Result
	err    error
	route  computerauthport.Route
}

func (service *fakeProviderBootstrapService) GetOrCreate(
	_ context.Context,
	route computerauthport.Route,
) (appbootstrap.Result, error) {
	service.route = route
	return service.result, service.err
}

func TestComputerBootstrapHandlerReturnsReadyRegistration(t *testing.T) {
	expiresAt := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	service := &fakeProviderBootstrapService{result: appbootstrap.Result{
		Ready: true, OperationID: hookTestAgentID, State: "ready",
		Registration: appbootstrap.Registration{
			Protocol: "tencent-tat-register-v1", Region: "ap-beijing",
			CodeID: "code-id", CodeValue: "code-secret",
			Tags:      []appbootstrap.Tag{{Key: "agent-network-computer-id", Value: hookTestComputerID}},
			ExpiresAt: expiresAt,
		},
	}}
	handler, err := NewComputerBootstrapHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.GetOrCreateProviderRegistration(
		currentComputerContext(t, 4),
		bootstrapapi.GetOrCreateProviderRegistrationRequestObject{},
	)
	if err != nil {
		t.Fatal(err)
	}
	ready, ok := response.(bootstrapapi.GetOrCreateProviderRegistration200JSONResponse)
	if !ok || ready.Body.RegisterCodeValue != "code-secret" ||
		ready.Body.Region != "ap-beijing" || !ready.Body.ExpiresAt.Equal(expiresAt) ||
		ready.Headers.CacheControl != "no-store" || ready.Headers.Pragma != "no-cache" {
		t.Fatalf("response = %#v", response)
	}
	if service.route.ServerID != hookTestServerID || service.route.ComputerID != hookTestComputerID ||
		service.route.Version != 4 {
		t.Fatalf("route = %#v", service.route)
	}
}

func TestComputerBootstrapHandlerReturnsPendingWithRetryAfter(t *testing.T) {
	service := &fakeProviderBootstrapService{result: appbootstrap.Result{
		OperationID: hookTestAgentID, State: "retry_wait", RetryAfterSeconds: 3,
	}}
	handler, err := NewComputerBootstrapHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.GetOrCreateProviderRegistration(
		currentComputerContext(t, 2),
		bootstrapapi.GetOrCreateProviderRegistrationRequestObject{},
	)
	if err != nil {
		t.Fatal(err)
	}
	pending, ok := response.(bootstrapapi.GetOrCreateProviderRegistration202JSONResponse)
	if !ok || pending.Headers.RetryAfter != 3 || pending.Body.RetryAfterSeconds != 3 ||
		pending.Body.State != bootstrapapi.RetryWait {
		t.Fatalf("response = %#v", response)
	}
}
