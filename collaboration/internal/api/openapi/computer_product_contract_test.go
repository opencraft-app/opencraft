package openapi

import "testing"

func TestHumanComputerContractDoesNotExposeProviderVocabulary(t *testing.T) {
	spec, err := GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	if spec.Paths.Map()["/servers/{serverId}/computers/{computerId}/registration"] != nil {
		t.Fatal("Human API still exposes provider registration")
	}
	computer := spec.Components.Schemas["Computer"]
	if computer == nil || computer.Value == nil {
		t.Fatal("Computer schema is missing")
	}
	for _, name := range []string{"tatRegion", "tatInstanceId", "tatInstanceKind", "tatAgentState"} {
		if computer.Value.Properties[name] != nil {
			t.Errorf("Computer exposes provider field %q", name)
		}
	}
	create := spec.Components.Schemas["CreateComputerRequest"]
	if create == nil || create.Value == nil || create.Value.Properties["name"] == nil ||
		len(create.Value.OneOf) != 0 {
		t.Fatalf("CreateComputerRequest = %#v", create)
	}
}
