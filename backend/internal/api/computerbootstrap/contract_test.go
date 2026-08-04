package computerbootstrap

import (
	"context"
	"testing"
)

func TestBootstrapContractIsASeparateSinglePurposeSurface(t *testing.T) {
	spec, err := GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(spec.Paths.Map()) != 1 {
		t.Fatalf("bootstrap paths = %d", len(spec.Paths.Map()))
	}
	if source, ok := spec.Extensions["x-error-code-registry-source"].(string); !ok ||
		source != "./openapi.yaml#/x-error-code-registry" {
		t.Fatalf("bootstrap error registry source = %#v", spec.Extensions["x-error-code-registry-source"])
	}
	operation := spec.Paths.Find("/bootstrap/provider-registration")
	if operation == nil || operation.Post == nil || operation.Get != nil ||
		operation.Post.OperationID != "GetOrCreateProviderRegistration" {
		t.Fatalf("provider registration operation id = %q", operation.Post.OperationID)
	}
	secured := false
	if operation.Post.Security != nil {
		for _, requirement := range *operation.Post.Security {
			if _, ok := requirement["ComputerBootstrapAuth"]; ok {
				secured = true
			}
		}
	}
	if !secured {
		t.Fatalf("bootstrap security = %#v", operation.Post.Security)
	}
	defaultResponse := operation.Post.Responses.Default()
	if defaultResponse == nil || defaultResponse.Value == nil ||
		defaultResponse.Value.Headers["Cache-Control"] == nil ||
		defaultResponse.Value.Headers["Pragma"] == nil {
		t.Fatal("bootstrap default error response must be no-store")
	}
	errorSchema := defaultResponse.Value.Content.Get("application/json").Schema
	if errorSchema == nil || errorSchema.Ref != "#/components/schemas/ErrorEnvelope" {
		t.Fatalf("bootstrap error schema = %#v", errorSchema)
	}
}
