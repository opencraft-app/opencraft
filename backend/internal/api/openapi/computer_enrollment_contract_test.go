package openapi

import "testing"

func TestGeneratedComputerEnrollmentContract(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	operations := map[string]struct {
		method      string
		operationID string
	}{
		"/computer-installation-options": {
			method: "GET", operationID: "GetComputerInstallationOptions",
		},
		"/servers/{serverId}/computers/{computerId}/setup-commands": {
			method: "POST", operationID: "CreateComputerSetupCommand",
		},
		"/computer/enrollments:claim": {
			method: "POST", operationID: "ClaimComputerEnrollment",
		},
		"/computer/preflight": {
			method: "POST", operationID: "PreflightComputer",
		},
		"/computer/setup-codes:redeem": {
			method: "POST", operationID: "RedeemComputerSetupCode",
		},
		"/computer-artifacts/{version}/{target}/{file}": {
			method: "GET", operationID: "GetComputerArtifact",
		},
	}
	redeem := spec.Paths.Map()["/computer/setup-codes:redeem"].Post
	if redeem.Security == nil || len(*redeem.Security) != 0 {
		t.Fatal("短码兑换必须显式公开且不继承 HumanBearer")
	}
	for path, expected := range operations {
		item := spec.Paths.Map()[path]
		if item == nil {
			t.Errorf("embedded OpenAPI is missing %q", path)
			continue
		}
		operation := item.GetOperation(expected.method)
		if operation == nil || operation.OperationID != expected.operationID {
			t.Errorf("%s %s operation = %#v", expected.method, path, operation)
		}
	}
	for _, name := range []string{
		"ComputerInstallationOptions",
		"ComputerSetupCommand",
		"ComputerEnrollmentClaimRequest",
		"ComputerEnrollmentClaim",
		"ComputerPreflightRequest",
		"ComputerPreflightRemoved",
	} {
		if reference := spec.Components.Schemas[name]; reference == nil || reference.Value == nil {
			t.Errorf("embedded OpenAPI is missing schema %q", name)
		}
	}
	preflight := spec.Paths.Map()["/computer/preflight"]
	if preflight != nil && preflight.Post != nil {
		var computerCredential bool
		for _, requirement := range *preflight.Post.Security {
			if _, ok := requirement["ComputerCredentialAuth"]; ok {
				computerCredential = true
			}
		}
		if !computerCredential {
			t.Error("Computer preflight does not require ComputerCredentialAuth")
		}
	}
	if spec.Components.SecuritySchemes["EnrollmentAuth"] == nil {
		t.Fatal("EnrollmentAuth security scheme is missing")
	}
	claimRequest := spec.Components.Schemas["ComputerEnrollmentClaimRequest"]
	if claimRequest == nil || claimRequest.Value == nil ||
		claimRequest.Value.Properties["replacementGrant"] == nil {
		t.Fatal("ComputerEnrollmentClaimRequest replacementGrant is missing")
	}
	for _, path := range []string{
		"/computer/enrollments:claim",
		"/computer-artifacts/{version}/{target}/{file}",
	} {
		operation := spec.Paths.Map()[path]
		if operation == nil {
			continue
		}
		var securityFound bool
		for _, requirement := range *operation.GetOperation(map[string]string{
			"/computer/enrollments:claim":                   "POST",
			"/computer-artifacts/{version}/{target}/{file}": "GET",
		}[path]).Security {
			if _, ok := requirement["EnrollmentAuth"]; ok {
				securityFound = true
			}
		}
		if !securityFound {
			t.Errorf("%s does not require EnrollmentAuth", path)
		}
	}
}
