package openapi

import (
	"reflect"
	"testing"
)

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
		"/computer-installation-targets": {
			method: "GET", operationID: "GetComputerInstallationTargets",
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

func TestComputerEnrollmentContractSupportsMacOSAndLinuxTargets(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}

	redeem := spec.Paths.Map()["/computer/setup-codes:redeem"].Post
	var targetHeaderFound bool
	for _, parameter := range redeem.Parameters {
		if parameter.Value == nil || parameter.Value.Name != "X-Vela-Computer-Target" {
			continue
		}
		targetHeaderFound = parameter.Value.In == "header" &&
			reflect.DeepEqual(parameter.Value.Schema.Value.Enum, []any{"darwin-arm64", "linux-amd64"})
	}
	if !targetHeaderFound {
		t.Fatal("setup-code redemption lacks required X-Vela-Computer-Target enum")
	}

	artifact := spec.Paths.Map()["/computer-artifacts/{version}/{target}/{file}"]
	var artifactTargets []any
	for _, parameter := range artifact.Parameters {
		if parameter.Value != nil && parameter.Value.Name == "target" {
			artifactTargets = parameter.Value.Schema.Value.Enum
		}
	}
	if !reflect.DeepEqual(artifactTargets, []any{"darwin-arm64", "linux-amd64"}) {
		t.Fatalf("artifact targets = %#v", artifactTargets)
	}

	create := spec.Components.Schemas["CreateComputerRequest"].Value
	if containsString(create.Required, "osType") ||
		!reflect.DeepEqual(create.Properties["osType"].Value.Enum, []any{"macos", "linux"}) ||
		create.Properties["osType"].Value.Default != nil {
		t.Fatalf("CreateComputerRequest osType = required %#v schema %#v", create.Required, create.Properties["osType"])
	}
	claim := spec.Components.Schemas["ComputerEnrollmentClaimRequest"].Value
	if !reflect.DeepEqual(claim.Properties["osType"].Value.Enum, []any{"macos", "linux"}) ||
		!reflect.DeepEqual(claim.Properties["architecture"].Value.Enum, []any{"arm64", "amd64"}) {
		t.Fatalf("claim platform enums = os %#v arch %#v", claim.Properties["osType"].Value.Enum, claim.Properties["architecture"].Value.Enum)
	}
	options := spec.Components.Schemas["ComputerInstallationTargets"].Value
	targets := options.Properties["targets"]
	if targets == nil || targets.Value == nil || targets.Value.Items == nil ||
		targets.Value.Items.Value == nil ||
		!reflect.DeepEqual(targets.Value.Items.Value.Properties["target"].Value.Enum, []any{"darwin-arm64", "linux-amd64"}) {
		t.Fatalf("installation target directory = %#v", targets)
	}

	registry, ok := spec.Extensions["x-error-code-registry"].(map[string]any)
	if !ok {
		t.Fatalf("error registry type = %T", spec.Extensions["x-error-code-registry"])
	}
	for code, status := range map[string]float64{
		"computer_install_target_unsupported": 422,
		"setup_code_target_conflict":          409,
	} {
		entry, ok := registry[code].(map[string]any)
		if !ok || entry["status"] != status {
			t.Errorf("error registry %s = %#v", code, registry[code])
		}
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
