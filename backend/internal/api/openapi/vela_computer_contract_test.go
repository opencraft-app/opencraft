package openapi

import (
	"testing"
)

func TestGeneratedVelaComputerContract(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	paths := spec.Paths.Map()
	operations := map[string]struct {
		method      string
		operationID string
	}{
		"/servers/{serverId}/computers/{computerId}/runtime-credentials": {
			method:      "POST",
			operationID: "CreateComputerRuntimeCredential",
		},
		"/computer/session": {
			method:      "POST",
			operationID: "CreateComputerSession",
		},
		"/computer/credential:rotate": {
			method:      "POST",
			operationID: "RotateComputerCredential",
		},
		"/computer/assignments": {
			method:      "GET",
			operationID: "GetComputerAssignments",
		},
		"/computer/agents/{agentId}/observations/{observationId}": {
			method:      "PUT",
			operationID: "PutComputerAgentObservation",
		},
		"/computer/heartbeat": {
			method:      "POST",
			operationID: "SendComputerHeartbeat",
		},
	}
	for path, expected := range operations {
		item := paths[path]
		if item == nil {
			t.Errorf("embedded OpenAPI is missing %q", path)
			continue
		}
		operation := item.GetOperation(expected.method)
		if operation == nil {
			t.Errorf("%s %s is missing", expected.method, path)
			continue
		}
		if operation.OperationID != expected.operationID {
			t.Errorf(
				"%s %s operationId = %q, want %q",
				expected.method,
				path,
				operation.OperationID,
				expected.operationID,
			)
		}
	}

	for _, name := range []string{
		"ComputerRuntimeCredentialRequest",
		"ComputerRuntimeCredential",
		"ComputerSession",
		"ComputerAssignmentSnapshot",
		"ComputerAgentObservation",
		"ComputerHeartbeat",
	} {
		reference := spec.Components.Schemas[name]
		if reference == nil || reference.Value == nil {
			t.Errorf("embedded OpenAPI is missing schema %q", name)
		}
	}
}

func TestGeneratedContractDoesNotExposeUnfencedRuntimeSessionIssuers(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	for _, path := range []string{
		"/runtime/session",
		"/computer/agents/{agentId}/session",
	} {
		if spec.Paths.Map()[path] != nil {
			t.Errorf("embedded OpenAPI still exposes unfenced issuer %q", path)
		}
	}
}

func TestGeneratedVelaComputerContractCarriesServerIssuedLaunchFence(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	paths := spec.Paths.Map()
	for path, operationID := range map[string]string{
		"/computer/agents/{agentId}/launches":                    "CreateComputerAgentLaunch",
		"/computer/agents/{agentId}/launches/{launchId}/session": "RefreshComputerAgentSession",
	} {
		item := paths[path]
		if item == nil || item.Post == nil {
			t.Errorf("embedded OpenAPI is missing POST %s", path)
			continue
		}
		if item.Post.OperationID != operationID {
			t.Errorf("POST %s operationId = %q, want %q", path, item.Post.OperationID, operationID)
		}
	}
	for _, name := range []string{
		"ComputerAgentLaunchRequest",
		"ComputerAgentLaunch",
		"ComputerAgentSessionRefreshRequest",
		"ComputerObservationResult",
	} {
		reference := spec.Components.Schemas[name]
		if reference == nil || reference.Value == nil {
			t.Errorf("embedded OpenAPI is missing schema %q", name)
		}
	}
}

func TestGeneratedObservationContractUsesUnifiedLaunchFencedResult(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	operation := spec.Paths.Map()["/computer/agents/{agentId}/observations/{observationId}"].Put
	if operation.Responses.Value("200") == nil || operation.Responses.Value("202") != nil ||
		operation.Responses.Value("204") != nil {
		t.Fatalf("observation responses = %#v", operation.Responses.Map())
	}
	schema := spec.Components.Schemas["ComputerAgentObservation"].Value
	required := make(map[string]bool, len(schema.Required))
	for _, name := range schema.Required {
		required[name] = true
	}
	for _, name := range []string{"credentialVersion", "imTransportState"} {
		if !required[name] || schema.Properties[name] == nil {
			t.Errorf("ComputerAgentObservation missing required %q", name)
		}
	}
}

func TestGeneratedHeartbeatCarriesBuildAndCurrentLaunchFence(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	for schemaName, names := range map[string][]string{
		"ComputerHeartbeat":      {"daemonBuildId"},
		"ComputerHeartbeatAgent": {"assignmentEpoch", "credentialVersion"},
	} {
		schema := spec.Components.Schemas[schemaName].Value
		required := make(map[string]bool, len(schema.Required))
		for _, name := range schema.Required {
			required[name] = true
		}
		for _, name := range names {
			if !required[name] || schema.Properties[name] == nil {
				t.Errorf("%s missing required %q", schemaName, name)
			}
		}
	}
}

func TestGeneratedAgentExposesTransportStateSeparatelyFromPresence(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	schema := spec.Components.Schemas["Agent"].Value
	required := make(map[string]bool, len(schema.Required))
	for _, name := range schema.Required {
		required[name] = true
	}
	if !required["imTransportState"] || schema.Properties["imTransportState"] == nil ||
		schema.Properties["imTransportUpdatedAt"] == nil {
		t.Fatalf("Agent transport projection is incomplete: required=%v", schema.Required)
	}
}

func TestGeneratedAssignmentExposesCurrentLaunchFence(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	schema := spec.Components.Schemas["ComputerAssignment"].Value
	if schema.Properties["currentLaunch"] == nil ||
		spec.Components.Schemas["ComputerAssignmentLaunchFence"] == nil {
		t.Fatal("Computer Assignment currentLaunch fence is missing")
	}
}

func TestGeneratedAgentProfileCapabilityContract(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	for path, expected := range map[string]struct {
		method      string
		operationID string
	}{
		"/servers/{serverId}/agents/{agentId}/profile-capabilities": {
			method: "GET", operationID: "GetAgentProfileCapabilities",
		},
		"/servers/{serverId}/agents/{agentId}/profile-capabilities/refresh": {
			method: "POST", operationID: "RefreshAgentProfileCapabilities",
		},
		"/computer/agents/{agentId}/profile-capability-results/{operationId}": {
			method: "PUT", operationID: "PutComputerAgentProfileCapabilityResult",
		},
		"/computer/agents/{agentId}/profile-capability-invalidations/{eventId}": {
			method: "PUT", operationID: "PutComputerAgentProfileCapabilityInvalidation",
		},
	} {
		item := spec.Paths.Map()[path]
		if item == nil {
			t.Errorf("embedded OpenAPI is missing %q", path)
			continue
		}
		operation := item.GetOperation(expected.method)
		if operation == nil || operation.OperationID != expected.operationID {
			t.Errorf(
				"%s %s operation = %#v, want %q",
				expected.method,
				path,
				operation,
				expected.operationID,
			)
		}
	}
	for _, name := range []string{
		"AgentProfileCapabilities",
		"ComputerAgentProfileCapabilityResult",
		"ComputerAgentProfileCapabilityInvalidation",
		"ComputerAssignmentSnapshotV2",
		"ComputerProfileCapabilityRefresh",
	} {
		reference := spec.Components.Schemas[name]
		if reference == nil || reference.Value == nil {
			t.Errorf("embedded OpenAPI is missing schema %q", name)
		}
	}
}
