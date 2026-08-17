package openapi

import (
	"context"
	"strings"
	"testing"
)

func TestRuntimeDirectoryContractIsGenerated(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatalf("validate embedded OpenAPI: %v", err)
	}

	path := spec.Paths.Value("/runtime/directory")
	if path == nil || path.Get == nil {
		t.Fatal("GET /runtime/directory is missing")
	}
	if got, want := path.Get.OperationID, "GetRuntimeDirectory"; got != want {
		t.Fatalf("operationId = %q, want %q", got, want)
	}
	response := path.Get.Responses.Value("200")
	if response == nil || response.Value == nil ||
		response.Value.Content.Get("application/json") == nil {
		t.Fatal("GET /runtime/directory has no JSON 200 response")
	}

	for _, name := range []string{
		"RuntimeDirectory",
		"RuntimeDirectoryV2",
		"RuntimeDirectoryServer",
		"RuntimeDirectorySelf",
		"RuntimeDirectoryChannel",
		"RuntimeDirectoryDirectConversation",
		"RuntimeDirectoryMember",
	} {
		if schema := spec.Components.Schemas[name]; schema == nil || schema.Value == nil {
			t.Errorf("schema %s is missing", name)
		}
	}

	directory := spec.Components.Schemas["RuntimeDirectory"]
	if direct := directory.Value.Properties["directConversations"]; direct != nil {
		t.Fatalf("legacy RuntimeDirectory gained directConversations: %#v", direct)
	}
	v2Path := spec.Paths.Value("/runtime/directory-v2")
	if v2Path == nil || v2Path.Get == nil ||
		v2Path.Get.OperationID != "GetRuntimeDirectoryV2" {
		t.Fatalf("GET /runtime/directory-v2 = %#v", v2Path)
	}
	v2Response := v2Path.Get.Responses.Value("200")
	if v2Response == nil || v2Response.Value == nil ||
		v2Response.Value.Content.Get("application/json") == nil ||
		v2Response.Value.Content.Get("application/json").Schema.Ref !=
			"#/components/schemas/RuntimeDirectoryV2" {
		t.Fatalf("GET /runtime/directory-v2 200 = %#v", v2Response)
	}
	v2 := spec.Components.Schemas["RuntimeDirectoryV2"]
	directs := v2.Value.Properties["directConversations"]
	if directs == nil || directs.Value == nil || directs.Value.Items == nil ||
		directs.Value.Items.Ref !=
			"#/components/schemas/RuntimeDirectoryDirectConversation" {
		t.Fatalf("RuntimeDirectory.directConversations = %#v", directs)
	}
	requiredDirects := false
	for _, required := range v2.Value.Required {
		if required == "directConversations" {
			requiredDirects = true
		}
	}
	if !requiredDirects {
		t.Fatal("RuntimeDirectoryV2.directConversations must be required")
	}
	direct := spec.Components.Schemas["RuntimeDirectoryDirectConversation"]
	imState := direct.Value.Properties["imState"]
	if imState == nil || imState.Ref !=
		"#/components/schemas/DirectConversationIMState" {
		t.Fatalf("RuntimeDirectoryDirectConversation.imState = %#v", imState)
	}
}

func TestRuntimeChannelMembersAndThreadContractsAreGenerated(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatalf("validate embedded OpenAPI: %v", err)
	}

	operations := []struct {
		path        string
		method      string
		operationID string
		status      string
	}{
		{
			path: "/runtime/channels/{channelId}/members", method: "GET",
			operationID: "GetRuntimeChannelMembers", status: "200",
		},
		{
			path: "/runtime/threads:resolve", method: "POST",
			operationID: "ResolveRuntimeThread", status: "200",
		},
		{
			path: "/runtime/threads/{threadId}/replies", method: "POST",
			operationID: "RegisterRuntimeThreadReply", status: "201",
		},
	}
	for _, expected := range operations {
		path := spec.Paths.Value(expected.path)
		if path == nil {
			t.Errorf("%s %s is missing", expected.method, expected.path)
			continue
		}
		operation := path.Get
		if expected.method == "POST" {
			operation = path.Post
		}
		if operation == nil {
			t.Errorf("%s %s is missing", expected.method, expected.path)
			continue
		}
		if operation.OperationID != expected.operationID {
			t.Errorf("%s %s operationId = %q, want %q",
				expected.method, expected.path, operation.OperationID, expected.operationID)
		}
		response := operation.Responses.Value(expected.status)
		if response == nil || response.Value == nil ||
			response.Value.Content.Get("application/json") == nil {
			t.Errorf("%s %s has no JSON %s response",
				expected.method, expected.path, expected.status)
		}
	}

	for _, name := range []string{
		"RuntimeChannelMembers",
		"ResolveRuntimeThreadRequest",
		"RegisterRuntimeThreadReplyRequest",
	} {
		if schema := spec.Components.Schemas[name]; schema == nil || schema.Value == nil {
			t.Errorf("schema %s is missing", name)
		}
	}
}

func TestRuntimeChannelMemberContractKeepsVisibilitySeparateFromMembership(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	path := spec.Paths.Value("/runtime/channels/{channelId}/members")
	if path == nil || path.Get == nil {
		t.Fatal("GET /runtime/channels/{channelId}/members is missing")
	}
	description := path.Get.Description
	for _, required := range []string{
		"#全员返回 Server 全体 active Member",
		"普通 public/private Channel 都只返回显式 active 成员",
		"public 只影响发现与自助加入",
	} {
		if !strings.Contains(description, required) {
			t.Errorf("Runtime Channel member description missing %q: %q", required, description)
		}
	}
}

func TestRuntimeReminderCRUDAndAnchorContractsAreGenerated(t *testing.T) {
	t.Parallel()
	spec, err := GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	operations := []struct {
		path, method, operationID, status string
	}{
		{"/runtime/reminders", "GET", "ListRuntimeReminders", "200"},
		{"/runtime/reminders", "POST", "CreateRuntimeReminder", "201"},
		{"/runtime/reminders/{reminderId}", "PATCH", "UpdateRuntimeReminder", "200"},
		{"/runtime/reminders/{reminderId}", "DELETE", "CancelRuntimeReminder", "204"},
		{"/runtime/reminders/{reminderId}/snooze", "POST", "SnoozeRuntimeReminder", "200"},
		{"/runtime/reminders/{reminderId}/log", "GET", "ListRuntimeReminderLog", "200"},
	}
	for _, expected := range operations {
		item := spec.Paths.Value(expected.path)
		if item == nil {
			t.Errorf("%s %s is missing", expected.method, expected.path)
			continue
		}
		operation := item.Get
		switch expected.method {
		case "POST":
			operation = item.Post
		case "PATCH":
			operation = item.Patch
		case "DELETE":
			operation = item.Delete
		}
		if operation == nil || operation.OperationID != expected.operationID {
			t.Errorf("%s %s operation = %#v", expected.method, expected.path, operation)
			continue
		}
		if operation.Responses.Value(expected.status) == nil {
			t.Errorf("%s %s response %s is missing", expected.method, expected.path, expected.status)
		}
	}
	for _, name := range []string{
		"RuntimeReminder", "RuntimeReminderAnchor", "CreateRuntimeReminderRequest",
		"UpdateRuntimeReminderRequest", "SnoozeRuntimeReminderRequest",
	} {
		if schema := spec.Components.Schemas[name]; schema == nil || schema.Value == nil {
			t.Errorf("schema %s is missing", name)
		}
	}
}
