package computerupdate

import (
	"context"
	"testing"
)

func TestComputerUpdateContractIsSeparateAndExplicit(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got, want := len(spec.Paths.Map()), 4; got != want {
		t.Fatalf("paths = %d, want %d", got, want)
	}
	channel := spec.Paths.Find("/computer-releases/{channel}/{target}")
	if channel == nil || channel.Get == nil || channel.Get.OperationID != "GetComputerReleaseChannel" {
		t.Fatalf("Computer channel operation = %#v", channel)
	}
	if channel.Get.Security == nil || len(*channel.Get.Security) != 0 {
		t.Fatalf("Computer channel must be anonymous: %#v", channel.Get.Security)
	}
	response := channel.Get.Responses.Value("200")
	if response == nil || response.Value == nil ||
		response.Value.Headers["Cache-Control"] == nil ||
		response.Value.Content.Get("application/json") == nil ||
		response.Value.Content.Get("application/json").Schema.Ref !=
			"#/components/schemas/ComputerReleaseChannelEnvelope" {
		t.Fatalf("Computer channel response = %#v", response)
	}

	operations := []struct {
		path, method, operationID string
	}{
		{"/ops/computer-updates/channels", "GET", "ListComputerReleaseChannels"},
		{"/ops/computer-updates/channels/{channel}", "PUT", "PromoteComputerReleaseChannel"},
		{"/ops/computer-updates/audit", "GET", "ListComputerReleaseAudit"},
	}
	for _, expected := range operations {
		item := spec.Paths.Find(expected.path)
		if item == nil {
			t.Errorf("missing %s", expected.path)
			continue
		}
		operation := item.Get
		if expected.method == "PUT" {
			operation = item.Put
		}
		if operation == nil || operation.OperationID != expected.operationID {
			t.Errorf("%s %s operation = %#v", expected.method, expected.path, operation)
			continue
		}
		secured := false
		if operation.Security != nil {
			for _, requirement := range *operation.Security {
				if _, ok := requirement["OperatorProxy"]; ok {
					secured = true
				}
			}
		}
		if !secured {
			t.Errorf("%s %s lacks OperatorProxy", expected.method, expected.path)
		}
	}

	for _, name := range []string{
		"ComputerReleaseChannelDescriptor",
		"ComputerReleaseChannelEnvelope",
		"ComputerReleaseDownloads",
		"ComputerReleaseSignature",
		"PromoteComputerReleaseChannelRequest",
		"ComputerReleaseChannelView",
		"ComputerReleaseAuditPage",
		"ErrorEnvelope",
	} {
		if schema := spec.Components.Schemas[name]; schema == nil || schema.Value == nil {
			t.Errorf("schema %s missing", name)
		}
	}
	registry, ok := spec.Extensions["x-error-code-registry"].(map[string]any)
	if !ok {
		t.Fatalf("error registry = %#v", spec.Extensions["x-error-code-registry"])
	}
	for _, code := range []string{
		"invalid_channel", "invalid_target", "release_not_found",
		"release_incomplete", "revision_conflict",
		"channel_signing_unavailable", "update_storage_unavailable",
	} {
		if _, exists := registry[code]; !exists {
			t.Errorf("error registry missing %s", code)
		}
	}
}

